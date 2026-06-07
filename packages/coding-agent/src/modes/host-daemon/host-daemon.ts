import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

type HostDaemonRequestId = string | number | null | undefined;

interface HostDaemonRequest {
	id?: HostDaemonRequestId;
	method: string;
	params?: unknown;
}

interface HostDaemonWorkspace {
	id: string;
	name: string;
	path: string;
}

interface HostDaemonOptions {
	listen: {
		host: string;
		port: number;
	};
	appServerArgs: string[];
	token: string;
	workspaces: HostDaemonWorkspace[];
}

interface HostDaemonContext {
	options: HostDaemonOptions;
	server: Server;
	workspaces: WorkspaceRuntimeManager;
}

interface WorkspaceOpenParams {
	workspaceId?: string;
	path?: string;
}

interface WorkspaceRequestParams extends WorkspaceOpenParams {
	request?: unknown;
}

interface WorkspaceEventsParams extends WorkspaceOpenParams {
	afterSequence?: number;
	limit?: number;
}

interface WorkspaceFileParams extends WorkspaceOpenParams {
	path?: string;
}

interface WorkspaceGitPathParams extends WorkspaceOpenParams {
	path?: string;
}

interface WorkspaceGitCommitParams extends WorkspaceOpenParams {
	message?: string;
}

interface WorkspaceGitWorktreeCreateParams extends WorkspaceOpenParams {
	branchName?: string;
}

interface GitStatusEntry {
	status: string;
	path: string;
	staged: boolean;
	unstaged: boolean;
	untracked: boolean;
}

interface GitDiffResult {
	path: string;
	diff: string;
}

interface WorktreeEntry {
	path: string;
	head?: string;
	branch?: string;
	detached: boolean;
	current: boolean;
}

interface AppServerRequest {
	id?: string | number | null;
	method: string;
	params?: unknown;
}

interface PendingRequest {
	reject: (error: Error) => void;
	resolve: (value: unknown) => void;
	timeout: NodeJS.Timeout;
}

interface WorkspaceEvent {
	sequence: number;
	timestamp: string;
	event: unknown;
}

interface WorkspaceProcessSnapshot {
	pid?: number;
	running: boolean;
	startedAt?: string;
	stoppedAt?: string;
	stderrTail: string;
	eventSequence: number;
}

const DEFAULT_LISTEN = "127.0.0.1:4732";
const ignoredDirectories = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"dist",
	"dist-electron",
	"build",
	"coverage",
	".next",
	".turbo",
	".vite",
]);
const maxFileEntries = 500;
const maxFileDepth = 5;
const maxReadBytes = 1024 * 1024;
const maxGitDiffBuffer = 8 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function parseListen(value: string): { host: string; port: number } {
	const lastColon = value.lastIndexOf(":");
	if (lastColon <= 0 || lastColon === value.length - 1) {
		throw new Error(`Invalid --listen value "${value}". Expected host:port`);
	}
	const host = value.slice(0, lastColon);
	const rawPort = value.slice(lastColon + 1);
	const port = Number(rawPort);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`Invalid --listen port "${rawPort}"`);
	}
	return { host, port };
}

function isLoopbackHost(host: string): boolean {
	const normalized = host.toLowerCase();
	return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function workspaceId(path: string): string {
	return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

function resolveWorkspace(path: string, cwd: string): HostDaemonWorkspace {
	const resolved = resolve(cwd, path);
	if (!existsSync(resolved)) {
		throw new Error(`Workspace does not exist: ${path}`);
	}
	const realPath = realpathSync(resolved);
	return {
		id: workspaceId(realPath),
		name: basename(realPath) || realPath,
		path: realPath,
	};
}

function parseHostDaemonOptions(args: string[], cwd = process.cwd()): HostDaemonOptions {
	let listen = parseListen(DEFAULT_LISTEN);
	let token = process.env.PI_HOST_TOKEN ?? "";
	const workspaces: HostDaemonWorkspace[] = [];
	let allowNonLocalhost = false;
	const appServerArgs: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") {
			appServerArgs.push(...args.slice(i + 1));
			break;
		}
		if (arg === "--offline") {
			appServerArgs.push("--offline");
			continue;
		}
		if (arg === "--app-server-arg" && i + 1 < args.length) {
			appServerArgs.push(args[++i]);
			continue;
		}
		if (arg === "--listen" && i + 1 < args.length) {
			listen = parseListen(args[++i]);
			continue;
		}
		if (arg === "--token" && i + 1 < args.length) {
			token = args[++i];
			continue;
		}
		if (arg === "--workspace" && i + 1 < args.length) {
			workspaces.push(resolveWorkspace(args[++i], cwd));
			continue;
		}
		if (arg === "--allow-non-localhost") {
			allowNonLocalhost = true;
			continue;
		}
		throw new Error(`Unknown host-daemon option: ${arg}`);
	}

	if (!token) {
		throw new Error("host-daemon requires --token or PI_HOST_TOKEN");
	}
	if (!allowNonLocalhost && !isLoopbackHost(listen.host)) {
		throw new Error("host-daemon only listens on localhost by default; use --allow-non-localhost explicitly");
	}

	return { appServerArgs, listen, token, workspaces };
}

function safeTokenEquals(expected: string, actual: string): boolean {
	const expectedBytes = Buffer.from(expected);
	const actualBytes = Buffer.from(actual);
	return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function parseRequest(value: unknown): HostDaemonRequest {
	if (typeof value !== "object" || value === null || !("method" in value)) {
		throw new Error("Expected a JSON-RPC request object with a method");
	}
	const request = value as { id?: unknown; method: unknown; params?: unknown };
	if (typeof request.method !== "string") {
		throw new Error("Expected request.method to be a string");
	}
	if (
		request.id !== undefined &&
		request.id !== null &&
		typeof request.id !== "string" &&
		typeof request.id !== "number"
	) {
		throw new Error("Expected request.id to be a string, number, null, or omitted");
	}
	return { id: request.id, method: request.method, params: request.params };
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	response.end(`${JSON.stringify(body)}\n`);
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
			if (body.length > 1024 * 1024) {
				reject(new Error("Request body too large"));
				request.destroy();
			}
		});
		request.on("end", () => resolvePromise(body));
		request.on("error", reject);
	});
}

function parseWorkspaceParams(params: unknown): WorkspaceOpenParams {
	if (typeof params !== "object" || params === null) {
		throw new Error("Expected params to include workspaceId or path");
	}
	const value = params as { path?: unknown; workspaceId?: unknown };
	if (value.workspaceId !== undefined && typeof value.workspaceId !== "string") {
		throw new Error("Expected params.workspaceId to be a string");
	}
	if (value.path !== undefined && typeof value.path !== "string") {
		throw new Error("Expected params.path to be a string");
	}
	return { path: value.path, workspaceId: value.workspaceId };
}

function parseWorkspaceRequestParams(params: unknown): WorkspaceRequestParams {
	const workspace = parseWorkspaceParams(params);
	const value = params as { request?: unknown };
	return { ...workspace, request: value.request };
}

function parseWorkspaceEventsParams(params: unknown): WorkspaceEventsParams {
	const workspace = parseWorkspaceParams(params);
	const value = params as { afterSequence?: unknown; limit?: unknown };
	const afterSequence = value.afterSequence;
	const limit = value.limit;
	if (afterSequence !== undefined && (typeof afterSequence !== "number" || !Number.isInteger(afterSequence))) {
		throw new Error("Expected params.afterSequence to be an integer");
	}
	if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000)) {
		throw new Error("Expected params.limit to be an integer from 1 to 1000");
	}
	return { ...workspace, afterSequence, limit };
}

function parseWorkspaceFileParams(params: unknown): WorkspaceFileParams {
	const workspace = parseWorkspaceParams(params);
	const value = params as { path?: unknown };
	if (value.path !== undefined && typeof value.path !== "string") {
		throw new Error("Expected params.path to be a string");
	}
	return { ...workspace, path: value.path };
}

function parseWorkspaceGitPathParams(params: unknown): WorkspaceGitPathParams {
	const workspace = parseWorkspaceParams(params);
	const value = params as { path?: unknown };
	if (value.path !== undefined && typeof value.path !== "string") {
		throw new Error("Expected params.path to be a string");
	}
	return { ...workspace, path: value.path };
}

function parseWorkspaceGitCommitParams(params: unknown): WorkspaceGitCommitParams {
	const workspace = parseWorkspaceParams(params);
	const value = params as { message?: unknown };
	if (value.message !== undefined && typeof value.message !== "string") {
		throw new Error("Expected params.message to be a string");
	}
	return { ...workspace, message: value.message };
}

function parseWorkspaceGitWorktreeCreateParams(params: unknown): WorkspaceGitWorktreeCreateParams {
	const workspace = parseWorkspaceParams(params);
	const value = params as { branchName?: unknown };
	if (value.branchName !== undefined && typeof value.branchName !== "string") {
		throw new Error("Expected params.branchName to be a string");
	}
	return { ...workspace, branchName: value.branchName };
}

function parseAppServerRequest(value: unknown): AppServerRequest {
	if (typeof value !== "object" || value === null || !("method" in value)) {
		throw new Error("Expected params.request to be a JSON-RPC request object with a method");
	}
	const request = value as { id?: unknown; method: unknown; params?: unknown };
	if (typeof request.method !== "string") {
		throw new Error("Expected params.request.method to be a string");
	}
	if (
		request.id !== undefined &&
		request.id !== null &&
		typeof request.id !== "string" &&
		typeof request.id !== "number"
	) {
		throw new Error("Expected params.request.id to be a string, number, null, or omitted");
	}
	return { id: request.id, method: request.method, params: request.params };
}

function getCliSpawnArgs(): string[] {
	const args = process.argv.slice(1);
	const hostDaemonIndex = args.indexOf("host-daemon");
	const cliArgs = hostDaemonIndex > 0 ? args.slice(0, hostDaemonIndex) : args.slice(0, 1);
	const [entrypoint] = cliArgs;
	if (cliArgs.length === 1 && entrypoint?.endsWith(".ts")) {
		const moduleDir = dirname(fileURLToPath(import.meta.url));
		const tsxCli = resolve(moduleDir, "../../../../../node_modules/tsx/dist/cli.mjs");
		if (existsSync(tsxCli)) {
			return [tsxCli, entrypoint];
		}
	}
	return cliArgs;
}

function tailText(value: string, maxLength = 4000): string {
	return value.length <= maxLength ? value : value.slice(value.length - maxLength);
}

function resolveWorkspacePath(root: string, path: string): string {
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(resolvedRoot, path);
	const relativePath = relative(resolvedRoot, resolvedPath);
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new Error("Path is outside the active workspace");
	}
	return resolvedPath;
}

async function walkWorkspaceFiles(
	root: string,
	current: string,
	depth: number,
	entries: Array<{ depth: number; name: string; path: string; type: "directory" | "file" }>,
): Promise<void> {
	if (entries.length >= maxFileEntries || depth > maxFileDepth) {
		return;
	}
	const children = await readdir(current, { withFileTypes: true });
	children.sort((a, b) => {
		if (a.isDirectory() !== b.isDirectory()) {
			return a.isDirectory() ? -1 : 1;
		}
		return a.name.localeCompare(b.name);
	});

	for (const child of children) {
		if (entries.length >= maxFileEntries) {
			return;
		}
		if (child.name.startsWith(".") && child.name !== ".github") {
			continue;
		}
		if (child.isDirectory() && ignoredDirectories.has(child.name)) {
			continue;
		}

		const absolutePath = resolve(current, child.name);
		entries.push({
			depth,
			name: child.name,
			path: relative(root, absolutePath),
			type: child.isDirectory() ? "directory" : "file",
		});

		if (child.isDirectory()) {
			await walkWorkspaceFiles(root, absolutePath, depth + 1, entries);
		}
	}
}

function parseGitStatusLine(line: string): GitStatusEntry | undefined {
	if (line.length < 4) {
		return undefined;
	}
	const status = line.slice(0, 2);
	const rawPath = line.slice(3).trim();
	const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)?.trim() : rawPath;
	if (!path) {
		return undefined;
	}
	const untracked = status === "??";
	return {
		path,
		staged: !untracked && status[0] !== " " && status[0] !== "?",
		status,
		unstaged: untracked || status[1] !== " ",
		untracked,
	};
}

function parseWorktreeList(stdout: string, cwd: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: Partial<WorktreeEntry> | undefined;
	for (const line of stdout.split("\n")) {
		if (!line.trim()) {
			if (current?.path) {
				entries.push(normalizeWorktree(current, cwd));
			}
			current = undefined;
			continue;
		}
		current ??= {};
		const [key, ...rest] = line.split(" ");
		const value = rest.join(" ");
		if (key === "worktree") {
			current.path = value;
		} else if (key === "HEAD") {
			current.head = value;
		} else if (key === "branch") {
			current.branch = value.replace(/^refs\/heads\//, "");
		} else if (key === "detached") {
			current.detached = true;
		}
	}
	if (current?.path) {
		entries.push(normalizeWorktree(current, cwd));
	}
	return entries;
}

function normalizeWorktree(entry: Partial<WorktreeEntry>, cwd: string): WorktreeEntry {
	return {
		branch: entry.branch,
		current: entry.path === cwd,
		detached: entry.detached ?? false,
		head: entry.head,
		path: entry.path ?? "",
	};
}

function makeWorktreePath(cwd: string, branchName: string): string {
	const baseName = basename(cwd);
	const slug =
		branchName
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64) || "worktree";
	let targetPath = resolve(dirname(cwd), `${baseName}-${slug}`);
	if (!existsSync(targetPath)) {
		return targetPath;
	}
	targetPath = resolve(dirname(cwd), `${baseName}-${slug}-${Date.now().toString(36)}`);
	return targetPath;
}

class WorkspaceRuntime {
	private buffer = "";
	private eventSequence = 0;
	private readonly events: WorkspaceEvent[] = [];
	private readonly pending = new Map<string, PendingRequest>();
	private readonly closeWaiters = new Set<() => void>();
	private requestSequence = 0;
	private stderrTail = "";
	private stoppedAt: string | undefined;
	private readonly appServerArgs: string[];

	child: ChildProcessWithoutNullStreams;
	readonly startedAt = new Date().toISOString();
	readonly workspace: HostDaemonWorkspace;

	constructor(workspace: HostDaemonWorkspace, appServerArgs: string[]) {
		this.appServerArgs = appServerArgs;
		this.workspace = workspace;
		const cliArgs = getCliSpawnArgs();
		this.child = spawn(process.execPath, [...cliArgs, "app-server", ...this.appServerArgs], {
			cwd: workspace.path,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stdout.setEncoding("utf8");
		this.child.stderr.setEncoding("utf8");
		this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
		this.child.stderr.on("data", (chunk) => {
			this.stderrTail = tailText(`${this.stderrTail}${chunk}`);
		});
		this.child.once("close", () => this.markStopped());
		this.child.once("error", (error) => this.markStopped(error));
	}

	get running(): boolean {
		return this.child.exitCode === null && this.child.signalCode === null && !this.stoppedAt;
	}

	snapshot(): WorkspaceProcessSnapshot {
		return {
			eventSequence: this.eventSequence,
			pid: this.child.pid,
			running: this.running,
			startedAt: this.startedAt,
			stderrTail: this.stderrTail,
			stoppedAt: this.stoppedAt,
		};
	}

	getEvents(afterSequence = 0, limit = 100): WorkspaceEvent[] {
		return this.events.filter((event) => event.sequence > afterSequence).slice(0, limit);
	}

	async request(request: AppServerRequest, timeoutMs = 30_000): Promise<unknown> {
		if (!this.running) {
			throw new Error("Workspace app-server is not running");
		}
		const id = request.id ?? `host-${++this.requestSequence}`;
		const forwarded = { ...request, id };
		const key = String(id);
		if (this.pending.has(key)) {
			throw new Error(`Duplicate app-server request id: ${key}`);
		}

		return await new Promise((resolvePromise, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(key);
				reject(new Error(`Timed out waiting for app-server response: ${key}`));
			}, timeoutMs);
			this.pending.set(key, { reject, resolve: resolvePromise, timeout });
			this.child.stdin.write(`${JSON.stringify(forwarded)}\n`, (error) => {
				if (!error) return;
				clearTimeout(timeout);
				this.pending.delete(key);
				reject(error);
			});
		});
	}

	async close(): Promise<WorkspaceProcessSnapshot> {
		if (!this.running) {
			return this.snapshot();
		}
		try {
			await this.request({ id: `host-shutdown-${++this.requestSequence}`, method: "server/shutdown" }, 2_000);
			await this.waitForExit(2_000);
		} catch {
			this.child.kill("SIGTERM");
			await this.waitForExit(2_000);
		}
		if (this.running) {
			this.child.kill("SIGKILL");
			await this.waitForExit(1_000);
		}
		return this.snapshot();
	}

	private handleStdout(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) break;
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			this.handleJsonLine(line);
		}
	}

	private handleJsonLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.recordEvent({ method: "workspace/stdout", params: { line } });
			return;
		}

		if (typeof parsed === "object" && parsed !== null && "id" in parsed) {
			const id = (parsed as { id?: unknown }).id;
			const pending = this.pending.get(String(id));
			if (pending) {
				clearTimeout(pending.timeout);
				this.pending.delete(String(id));
				pending.resolve(parsed);
				return;
			}
		}
		this.recordEvent(parsed);
	}

	private recordEvent(event: unknown): void {
		this.events.push({ event, sequence: ++this.eventSequence, timestamp: new Date().toISOString() });
		while (this.events.length > 1000) {
			this.events.shift();
		}
	}

	private markStopped(error?: Error): void {
		this.stoppedAt = new Date().toISOString();
		if (error) {
			this.stderrTail = tailText(`${this.stderrTail}${error.message}`);
		}
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timeout);
			pending.reject(new Error(`Workspace app-server exited before response: ${id}`));
		}
		this.pending.clear();
		for (const waiter of this.closeWaiters) {
			waiter();
		}
		this.closeWaiters.clear();
	}

	private async waitForExit(timeoutMs: number): Promise<void> {
		if (!this.running) return;
		await new Promise<void>((resolvePromise) => {
			let timeout: NodeJS.Timeout;
			const waiter = () => {
				clearTimeout(timeout);
				resolvePromise();
			};
			timeout = setTimeout(() => {
				this.closeWaiters.delete(waiter);
				resolvePromise();
			}, timeoutMs);
			this.closeWaiters.add(waiter);
		});
	}
}

class WorkspaceRuntimeManager {
	private readonly options: HostDaemonOptions;
	private readonly runtimes = new Map<string, WorkspaceRuntime>();

	constructor(options: HostDaemonOptions) {
		this.options = options;
	}

	list(): Array<HostDaemonWorkspace & { process?: WorkspaceProcessSnapshot }> {
		return this.options.workspaces.map((workspace) => ({
			...workspace,
			process: this.runtimes.get(workspace.id)?.snapshot(),
		}));
	}

	resolve(params: WorkspaceOpenParams): HostDaemonWorkspace {
		if (params.workspaceId) {
			const workspace = this.options.workspaces.find((candidate) => candidate.id === params.workspaceId);
			if (!workspace) {
				throw new Error(`Workspace is not allowlisted: ${params.workspaceId}`);
			}
			return workspace;
		}
		if (params.path) {
			const realPath = realpathSync(resolve(params.path));
			const workspace = this.options.workspaces.find((candidate) => candidate.path === realPath);
			if (!workspace) {
				throw new Error(`Workspace is not allowlisted: ${params.path}`);
			}
			return workspace;
		}
		throw new Error("Expected params.workspaceId or params.path");
	}

	open(params: WorkspaceOpenParams): { process: WorkspaceProcessSnapshot; workspace: HostDaemonWorkspace } {
		const workspace = this.resolve(params);
		let runtime = this.runtimes.get(workspace.id);
		if (!runtime || !runtime.running) {
			runtime = new WorkspaceRuntime(workspace, this.options.appServerArgs);
			this.runtimes.set(workspace.id, runtime);
		}
		return { process: runtime.snapshot(), workspace };
	}

	status(params: WorkspaceOpenParams): { process?: WorkspaceProcessSnapshot; workspace: HostDaemonWorkspace } {
		const workspace = this.resolve(params);
		return { process: this.runtimes.get(workspace.id)?.snapshot(), workspace };
	}

	async request(params: WorkspaceRequestParams): Promise<{
		response: unknown;
		workspace: HostDaemonWorkspace;
		process: WorkspaceProcessSnapshot;
	}> {
		const opened = this.open(params);
		const runtime = this.runtimes.get(opened.workspace.id);
		if (!runtime) {
			throw new Error("Workspace app-server failed to start");
		}
		const response = await runtime.request(parseAppServerRequest(params.request));
		return { process: runtime.snapshot(), response, workspace: opened.workspace };
	}

	events(params: WorkspaceEventsParams): {
		events: WorkspaceEvent[];
		process?: WorkspaceProcessSnapshot;
		workspace: HostDaemonWorkspace;
	} {
		const workspace = this.resolve(params);
		const runtime = this.runtimes.get(workspace.id);
		return {
			events: runtime?.getEvents(params.afterSequence, params.limit ?? 100) ?? [],
			process: runtime?.snapshot(),
			workspace,
		};
	}

	async listFiles(params: WorkspaceOpenParams): Promise<{
		files: Array<{ depth: number; name: string; path: string; type: "directory" | "file" }>;
		workspace: HostDaemonWorkspace;
	}> {
		const workspace = this.resolve(params);
		const files: Array<{ depth: number; name: string; path: string; type: "directory" | "file" }> = [];
		await walkWorkspaceFiles(workspace.path, workspace.path, 0, files);
		return { files, workspace };
	}

	async readFile(params: WorkspaceFileParams): Promise<{
		file: { content: string; path: string; truncated: boolean };
		workspace: HostDaemonWorkspace;
	}> {
		const workspace = this.resolve(params);
		if (!params.path) {
			throw new Error("Expected params.path");
		}
		const absolutePath = resolveWorkspacePath(workspace.path, params.path);
		const fileStat = await stat(absolutePath);
		if (!fileStat.isFile()) {
			throw new Error(`${basename(params.path)} is not a file`);
		}
		const buffer = await readFile(absolutePath);
		const truncated = buffer.length > maxReadBytes;
		const contentBuffer = truncated ? buffer.subarray(0, maxReadBytes) : buffer;
		return { file: { content: contentBuffer.toString("utf8"), path: params.path, truncated }, workspace };
	}

	async gitStatus(params: WorkspaceOpenParams): Promise<{
		status: GitStatusEntry[];
		workspace: HostDaemonWorkspace;
	}> {
		const workspace = this.resolve(params);
		try {
			const { stdout } = await execFileAsync("git", ["status", "--short"], { cwd: workspace.path });
			const status = stdout
				.split("\n")
				.map((line) => parseGitStatusLine(line))
				.filter((entry): entry is GitStatusEntry => entry !== undefined);
			return { status, workspace };
		} catch {
			return { status: [], workspace };
		}
	}

	async gitDiff(params: WorkspaceGitPathParams): Promise<{
		diff: GitDiffResult;
		workspace: HostDaemonWorkspace;
	}> {
		const workspace = this.resolve(params);
		if (!params.path) {
			throw new Error("Expected params.path");
		}
		resolveWorkspacePath(workspace.path, params.path);
		const headDiff = await execFileAsync("git", ["diff", "HEAD", "--", params.path], {
			cwd: workspace.path,
			maxBuffer: maxGitDiffBuffer,
		});
		if (headDiff.stdout) {
			return { diff: { diff: headDiff.stdout, path: params.path }, workspace };
		}

		try {
			const untrackedDiff = await execFileAsync("git", ["diff", "--no-index", "--", "/dev/null", params.path], {
				cwd: workspace.path,
				maxBuffer: maxGitDiffBuffer,
			});
			return { diff: { diff: untrackedDiff.stdout, path: params.path }, workspace };
		} catch (error) {
			const maybeDiff = error as { stdout?: string };
			return { diff: { diff: maybeDiff.stdout ?? "", path: params.path }, workspace };
		}
	}

	async gitStage(params: WorkspaceGitPathParams): Promise<{
		status: GitStatusEntry[];
		workspace: HostDaemonWorkspace;
	}> {
		const workspace = this.resolve(params);
		if (!params.path) {
			throw new Error("Expected params.path");
		}
		resolveWorkspacePath(workspace.path, params.path);
		await execFileAsync("git", ["add", "--", params.path], { cwd: workspace.path });
		return await this.gitStatus({ workspaceId: workspace.id });
	}

	async gitUnstage(params: WorkspaceGitPathParams): Promise<{
		status: GitStatusEntry[];
		workspace: HostDaemonWorkspace;
	}> {
		const workspace = this.resolve(params);
		if (!params.path) {
			throw new Error("Expected params.path");
		}
		resolveWorkspacePath(workspace.path, params.path);
		await execFileAsync("git", ["restore", "--staged", "--", params.path], { cwd: workspace.path });
		return await this.gitStatus({ workspaceId: workspace.id });
	}

	async gitCommit(params: WorkspaceGitCommitParams): Promise<{
		output: string;
		status: GitStatusEntry[];
		workspace: HostDaemonWorkspace;
	}> {
		const workspace = this.resolve(params);
		const message = params.message?.trim();
		if (!message) {
			throw new Error("Commit message is required");
		}
		const { stderr, stdout } = await execFileAsync("git", ["commit", "-m", message], {
			cwd: workspace.path,
			maxBuffer: maxGitDiffBuffer,
		});
		const status = await this.gitStatus({ workspaceId: workspace.id });
		return { output: [stdout, stderr].filter(Boolean).join("\n"), status: status.status, workspace };
	}

	async listGitWorktrees(params: WorkspaceOpenParams): Promise<{
		worktrees: WorktreeEntry[];
		workspace: HostDaemonWorkspace;
	}> {
		const workspace = this.resolve(params);
		try {
			const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
				cwd: workspace.path,
				maxBuffer: maxGitDiffBuffer,
			});
			return { worktrees: parseWorktreeList(stdout, workspace.path), workspace };
		} catch {
			return { worktrees: [], workspace };
		}
	}

	async createGitWorktree(params: WorkspaceGitWorktreeCreateParams): Promise<{
		output: string;
		workspace: HostDaemonWorkspace;
		worktree: WorktreeEntry;
		workspaces: Array<HostDaemonWorkspace & { process?: WorkspaceProcessSnapshot }>;
	}> {
		const workspace = this.resolve(params);
		const branch = params.branchName?.trim();
		if (!branch) {
			throw new Error("Branch name is required");
		}
		if (branch.startsWith("-") || /\s/.test(branch)) {
			throw new Error("Branch name cannot start with '-' or contain whitespace");
		}
		await execFileAsync("git", ["check-ref-format", "--branch", branch], { cwd: workspace.path });
		const targetPath = makeWorktreePath(workspace.path, branch);
		const { stderr, stdout } = await execFileAsync("git", ["worktree", "add", "-b", branch, targetPath, "HEAD"], {
			cwd: workspace.path,
			maxBuffer: maxGitDiffBuffer,
		});
		const newWorkspace = resolveWorkspace(targetPath, workspace.path);
		if (!this.options.workspaces.some((candidate) => candidate.id === newWorkspace.id)) {
			this.options.workspaces.push(newWorkspace);
		}
		const worktrees = await this.listGitWorktrees({ workspaceId: workspace.id });
		const worktree = worktrees.worktrees.find((candidate) => candidate.path === newWorkspace.path) ?? {
			current: false,
			detached: false,
			path: newWorkspace.path,
		};
		return {
			output: [stdout, stderr].filter(Boolean).join("\n"),
			workspace: newWorkspace,
			workspaces: this.list(),
			worktree,
		};
	}

	async close(
		params: WorkspaceOpenParams,
	): Promise<{ process?: WorkspaceProcessSnapshot; workspace: HostDaemonWorkspace }> {
		const workspace = this.resolve(params);
		const runtime = this.runtimes.get(workspace.id);
		return { process: await runtime?.close(), workspace };
	}

	async closeAll(): Promise<void> {
		await Promise.all([...this.runtimes.values()].map((runtime) => runtime.close()));
	}
}

async function handleRpc(request: HostDaemonRequest, context: HostDaemonContext): Promise<unknown> {
	const { options, server, workspaces } = context;
	switch (request.method) {
		case "host/status":
			return {
				id: request.id,
				result: {
					daemon: "pi-host-daemon",
					protocolVersion: 1,
					listen: options.listen,
					runningWorkspaceCount: workspaces.list().filter((workspace) => workspace.process?.running).length,
					workspaceCount: options.workspaces.length,
				},
			};
		case "workspace/list":
			return {
				id: request.id,
				result: {
					workspaces: workspaces.list(),
				},
			};
		case "workspace/open":
			return { id: request.id, result: workspaces.open(parseWorkspaceParams(request.params)) };
		case "workspace/status":
			return { id: request.id, result: workspaces.status(parseWorkspaceParams(request.params)) };
		case "workspace/request":
			return { id: request.id, result: await workspaces.request(parseWorkspaceRequestParams(request.params)) };
		case "workspace/events":
			return { id: request.id, result: workspaces.events(parseWorkspaceEventsParams(request.params)) };
		case "workspace/file/list":
			return { id: request.id, result: await workspaces.listFiles(parseWorkspaceParams(request.params)) };
		case "workspace/file/read":
			return { id: request.id, result: await workspaces.readFile(parseWorkspaceFileParams(request.params)) };
		case "workspace/git/status":
			return { id: request.id, result: await workspaces.gitStatus(parseWorkspaceParams(request.params)) };
		case "workspace/git/diff":
			return { id: request.id, result: await workspaces.gitDiff(parseWorkspaceGitPathParams(request.params)) };
		case "workspace/git/stage":
			return { id: request.id, result: await workspaces.gitStage(parseWorkspaceGitPathParams(request.params)) };
		case "workspace/git/unstage":
			return { id: request.id, result: await workspaces.gitUnstage(parseWorkspaceGitPathParams(request.params)) };
		case "workspace/git/commit":
			return { id: request.id, result: await workspaces.gitCommit(parseWorkspaceGitCommitParams(request.params)) };
		case "workspace/git/worktree/list":
			return { id: request.id, result: await workspaces.listGitWorktrees(parseWorkspaceParams(request.params)) };
		case "workspace/git/worktree/create":
			return {
				id: request.id,
				result: await workspaces.createGitWorktree(parseWorkspaceGitWorktreeCreateParams(request.params)),
			};
		case "workspace/close":
			return { id: request.id, result: await workspaces.close(parseWorkspaceParams(request.params)) };
		case "server/shutdown":
			setTimeout(() => {
				void workspaces.closeAll().finally(() => server.close(() => process.exit(0)));
			}, 0);
			return { id: request.id, result: { shuttingDown: true } };
		default:
			return { id: request.id, error: { code: -32601, message: `Unknown method: ${request.method}` } };
	}
}

export async function runHostDaemon(args: string[], cwd = process.cwd()): Promise<never> {
	const options = parseHostDaemonOptions(args, cwd);
	let server: Server;
	const workspaces = new WorkspaceRuntimeManager(options);

	server = createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/rpc") {
			writeJson(response, 404, { error: { code: -32004, message: "Not found" } });
			return;
		}

		const auth = request.headers.authorization;
		const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
		if (!safeTokenEquals(options.token, token)) {
			writeJson(response, 401, { error: { code: -32010, message: "Unauthorized" } });
			return;
		}

		try {
			const body = await readBody(request);
			const parsed = parseRequest(JSON.parse(body));
			writeJson(response, 200, await handleRpc(parsed, { options, server, workspaces }));
		} catch (error) {
			writeJson(response, 400, {
				error: { code: -32700, message: error instanceof Error ? error.message : String(error) },
			});
		}
	});

	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(options.listen.port, options.listen.host, () => {
			server.off("error", reject);
			const address = server.address();
			if (typeof address === "object" && address !== null) {
				options.listen.port = address.port;
			}
			console.log(JSON.stringify({ type: "host/ready", listen: options.listen }));
			resolvePromise();
		});
	});

	const shutdown = () => {
		void workspaces.closeAll().finally(() => server.close(() => process.exit(0)));
	};
	process.once("SIGTERM", shutdown);
	if (process.platform !== "win32") {
		process.once("SIGHUP", shutdown);
	}

	return new Promise(() => {});
}
