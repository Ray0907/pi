import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const tempDirs: string[] = [];

interface HostDaemonDirs {
	agentDir: string;
	projectDir: string;
	tempRoot: string;
}

function createDirs(): HostDaemonDirs {
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-host-daemon-"));
	tempDirs.push(tempRoot);
	const agentDir = join(tempRoot, "agent");
	const projectDir = join(tempRoot, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	return { agentDir, projectDir, tempRoot };
}

function runHostDaemonCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
	const dirs = createDirs();
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [tsxPath, cliPath, "host-daemon", "--offline", ...args], {
			cwd: dirs.projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: dirs.agentDir,
				PI_HOST_TOKEN: undefined,
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			resolvePromise({ stdout, stderr, code });
		});
	});
}

async function startHostDaemon(args: string[]): Promise<{
	child: ReturnType<typeof spawn>;
	dirs: HostDaemonDirs;
	port: number;
	host: string;
	stdout: () => string;
	stderr: () => string;
	stop: () => Promise<void>;
}> {
	const dirs = createDirs();
	const child = spawn(process.execPath, [tsxPath, cliPath, "host-daemon", "--offline", ...args], {
		cwd: dirs.projectDir,
		env: {
			...process.env,
			[ENV_AGENT_DIR]: dirs.agentDir,
			PI_HOST_TOKEN: undefined,
			TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	const ready = await waitFor(async () => {
		const line = stdout
			.split("\n")
			.find((candidate) => candidate.trim().startsWith("{") && candidate.includes("host/ready"));
		if (!line) return undefined;
		return JSON.parse(line) as { type: "host/ready"; listen: { host: string; port: number } };
	}, 5_000);

	return {
		child,
		dirs,
		host: ready.listen.host,
		port: ready.listen.port,
		stdout: () => stdout,
		stderr: () => stderr,
		stop: async () => {
			child.kill("SIGTERM");
			await new Promise<void>((resolvePromise) => {
				child.once("close", () => resolvePromise());
				setTimeout(resolvePromise, 1_000);
			});
		},
	};
}

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs: number): Promise<T> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const value = await fn();
		if (value !== undefined) {
			return value;
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
	}
	throw new Error("Timed out waiting for host daemon");
}

async function rpc(
	baseUrl: string,
	body: Record<string, unknown>,
	token?: string,
): Promise<{ status: number; json: unknown }> {
	const response = await fetch(`${baseUrl}/rpc`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
	return { status: response.status, json: await response.json() };
}

describe("host daemon", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("refuses to start without an explicit token", async () => {
		const result = await runHostDaemonCli(["--listen", "127.0.0.1:0"]);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("token");
	});

	test("refuses non-localhost listens by default", async () => {
		const result = await runHostDaemonCli(["--token", "secret-token", "--listen", "0.0.0.0:0"]);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("localhost");
	});

	test("requires bearer token auth and exposes only allowlisted workspaces", async () => {
		const dirs = createDirs();
		const workspace = realpathSync(dirs.projectDir);
		const daemon = await startHostDaemon([
			"--token",
			"secret-token",
			"--listen",
			"127.0.0.1:0",
			"--workspace",
			workspace,
		]);

		try {
			const baseUrl = `http://${daemon.host}:${daemon.port}`;
			const unauthorized = await rpc(baseUrl, { id: "status", method: "host/status" });
			expect(unauthorized.status).toBe(401);

			const status = await rpc(baseUrl, { id: "status", method: "host/status" }, "secret-token");
			expect(status.status).toBe(200);
			expect(status.json).toEqual({
				id: "status",
				result: expect.objectContaining({
					daemon: "pi-host-daemon",
					listen: { host: "127.0.0.1", port: daemon.port },
					workspaceCount: 1,
				}),
			});

			const workspaces = await rpc(baseUrl, { id: "workspaces", method: "workspace/list" }, "secret-token");
			expect(workspaces.status).toBe(200);
			expect(workspaces.json).toEqual({
				id: "workspaces",
				result: {
					workspaces: [
						expect.objectContaining({
							id: expect.any(String),
							path: workspace,
							name: "project",
						}),
					],
				},
			});
		} finally {
			await daemon.stop();
		}
	});

	test("refuses to open workspaces outside the allowlist", async () => {
		const daemon = await startHostDaemon(["--token", "secret-token", "--listen", "127.0.0.1:0"]);

		try {
			const response = await rpc(
				`http://${daemon.host}:${daemon.port}`,
				{
					id: "open",
					method: "workspace/open",
					params: { path: daemon.dirs.projectDir },
				},
				"secret-token",
			);

			expect(response.status).toBe(400);
			expect(response.json).toEqual({
				error: expect.objectContaining({
					message: expect.stringContaining("allowlisted"),
				}),
			});
		} finally {
			await daemon.stop();
		}
	});

	test("opens an allowlisted workspace app-server and proxies JSON-RPC requests", async () => {
		const dirs = createDirs();
		const workspace = realpathSync(dirs.projectDir);
		const daemon = await startHostDaemon([
			"--token",
			"secret-token",
			"--listen",
			"127.0.0.1:0",
			"--workspace",
			workspace,
		]);

		try {
			const baseUrl = `http://${daemon.host}:${daemon.port}`;
			const listed = await rpc(baseUrl, { id: "workspaces", method: "workspace/list" }, "secret-token");
			const workspaceId = (
				listed.json as { result: { workspaces: Array<{ id: string; path: string }> } }
			).result.workspaces.find((candidate) => candidate.path === workspace)?.id;
			expect(workspaceId).toEqual(expect.any(String));

			const opened = await rpc(
				baseUrl,
				{ id: "open", method: "workspace/open", params: { workspaceId } },
				"secret-token",
			);
			expect(opened.status).toBe(200);
			expect(opened.json).toEqual({
				id: "open",
				result: {
					process: expect.objectContaining({ pid: expect.any(Number), running: true }),
					workspace: expect.objectContaining({ id: workspaceId, path: workspace }),
				},
			});

			const initialized = await rpc(
				baseUrl,
				{
					id: "initialize",
					method: "workspace/request",
					params: {
						workspaceId,
						request: {
							id: "app-init",
							method: "initialize",
							params: { clientInfo: { name: "host-daemon-test" } },
						},
					},
				},
				"secret-token",
			);

			expect(initialized.status).toBe(200);
			expect(initialized.json).toEqual({
				id: "initialize",
				result: {
					process: expect.objectContaining({ running: true }),
					response: {
						id: "app-init",
						result: expect.objectContaining({
							protocolVersion: 2,
							serverInfo: { name: "pi-app-server", version: 2 },
						}),
					},
					workspace: expect.objectContaining({ id: workspaceId, path: workspace }),
				},
			});

			const status = await rpc(baseUrl, { id: "status", method: "host/status" }, "secret-token");
			expect(status.json).toEqual({
				id: "status",
				result: expect.objectContaining({
					runningWorkspaceCount: 1,
					workspaceCount: 1,
				}),
			});
		} finally {
			await daemon.stop();
		}
	});

	test("lists and reads files inside an allowlisted workspace", async () => {
		const dirs = createDirs();
		const workspace = realpathSync(dirs.projectDir);
		mkdirSync(join(workspace, "src"), { recursive: true });
		writeFileSync(join(workspace, "src", "agent.ts"), "export const answer = 42;\n");
		writeFileSync(join(workspace, ".hidden"), "hidden\n");
		const daemon = await startHostDaemon([
			"--token",
			"secret-token",
			"--listen",
			"127.0.0.1:0",
			"--workspace",
			workspace,
		]);

		try {
			const baseUrl = `http://${daemon.host}:${daemon.port}`;
			const listed = await rpc(baseUrl, { id: "workspaces", method: "workspace/list" }, "secret-token");
			const workspaceId = (
				listed.json as { result: { workspaces: Array<{ id: string; path: string }> } }
			).result.workspaces.find((candidate) => candidate.path === workspace)?.id;

			const files = await rpc(
				baseUrl,
				{ id: "files", method: "workspace/file/list", params: { workspaceId } },
				"secret-token",
			);
			expect(files.status).toBe(200);
			expect(files.json).toEqual({
				id: "files",
				result: {
					files: [
						expect.objectContaining({ depth: 0, name: "src", path: "src", type: "directory" }),
						expect.objectContaining({ depth: 1, name: "agent.ts", path: "src/agent.ts", type: "file" }),
					],
					workspace: expect.objectContaining({ id: workspaceId, path: workspace }),
				},
			});
			expect(JSON.stringify(files.json)).not.toContain(".hidden");

			const read = await rpc(
				baseUrl,
				{ id: "read", method: "workspace/file/read", params: { workspaceId, path: "src/agent.ts" } },
				"secret-token",
			);
			expect(read.status).toBe(200);
			expect(read.json).toEqual({
				id: "read",
				result: {
					file: { content: "export const answer = 42;\n", path: "src/agent.ts", truncated: false },
					workspace: expect.objectContaining({ id: workspaceId, path: workspace }),
				},
			});

			const outside = await rpc(
				baseUrl,
				{ id: "outside", method: "workspace/file/read", params: { workspaceId, path: "../outside.txt" } },
				"secret-token",
			);
			expect(outside.status).toBe(400);
			expect(outside.json).toEqual({
				error: expect.objectContaining({ message: expect.stringContaining("outside") }),
			});
		} finally {
			await daemon.stop();
		}
	});

	test("returns git status and diffs inside an allowlisted workspace", async () => {
		const dirs = createDirs();
		const workspace = realpathSync(dirs.projectDir);
		execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "host-daemon@example.test"], { cwd: workspace });
		execFileSync("git", ["config", "user.name", "Host Daemon Test"], { cwd: workspace });
		writeFileSync(join(workspace, "tracked.txt"), "before\n");
		execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
		execFileSync("git", ["commit", "-m", "init"], { cwd: workspace, stdio: "ignore" });
		writeFileSync(join(workspace, "tracked.txt"), "before\nafter\n");
		writeFileSync(join(workspace, "new.txt"), "new file content\n");
		const daemon = await startHostDaemon([
			"--token",
			"secret-token",
			"--listen",
			"127.0.0.1:0",
			"--workspace",
			workspace,
		]);

		try {
			const baseUrl = `http://${daemon.host}:${daemon.port}`;
			const listed = await rpc(baseUrl, { id: "workspaces", method: "workspace/list" }, "secret-token");
			const workspaceId = (
				listed.json as { result: { workspaces: Array<{ id: string; path: string }> } }
			).result.workspaces.find((candidate) => candidate.path === workspace)?.id;

			const status = await rpc(
				baseUrl,
				{ id: "git-status", method: "workspace/git/status", params: { workspaceId } },
				"secret-token",
			);
			expect(status.status).toBe(200);
			expect(status.json).toEqual({
				id: "git-status",
				result: {
					status: expect.arrayContaining([
						expect.objectContaining({
							path: "tracked.txt",
							staged: false,
							status: " M",
							unstaged: true,
							untracked: false,
						}),
						expect.objectContaining({
							path: "new.txt",
							staged: false,
							status: "??",
							unstaged: true,
							untracked: true,
						}),
					]),
					workspace: expect.objectContaining({ id: workspaceId, path: workspace }),
				},
			});

			const trackedDiff = await rpc(
				baseUrl,
				{ id: "tracked-diff", method: "workspace/git/diff", params: { workspaceId, path: "tracked.txt" } },
				"secret-token",
			);
			expect(trackedDiff.status).toBe(200);
			expect(trackedDiff.json).toEqual({
				id: "tracked-diff",
				result: {
					diff: { diff: expect.stringContaining("+after"), path: "tracked.txt" },
					workspace: expect.objectContaining({ id: workspaceId, path: workspace }),
				},
			});

			const untrackedDiff = await rpc(
				baseUrl,
				{ id: "untracked-diff", method: "workspace/git/diff", params: { workspaceId, path: "new.txt" } },
				"secret-token",
			);
			expect(untrackedDiff.status).toBe(200);
			expect(untrackedDiff.json).toEqual({
				id: "untracked-diff",
				result: {
					diff: { diff: expect.stringContaining("+new file content"), path: "new.txt" },
					workspace: expect.objectContaining({ id: workspaceId, path: workspace }),
				},
			});

			const outside = await rpc(
				baseUrl,
				{ id: "outside", method: "workspace/git/diff", params: { workspaceId, path: "../outside.txt" } },
				"secret-token",
			);
			expect(outside.status).toBe(400);
			expect(outside.json).toEqual({
				error: expect.objectContaining({ message: expect.stringContaining("outside") }),
			});
		} finally {
			await daemon.stop();
		}
	});

	test("stages, unstages, and commits git changes inside an allowlisted workspace", async () => {
		const dirs = createDirs();
		const workspace = realpathSync(dirs.projectDir);
		execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "host-daemon@example.test"], { cwd: workspace });
		execFileSync("git", ["config", "user.name", "Host Daemon Test"], { cwd: workspace });
		writeFileSync(join(workspace, "tracked.txt"), "before\n");
		execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
		execFileSync("git", ["commit", "-m", "init"], { cwd: workspace, stdio: "ignore" });
		writeFileSync(join(workspace, "tracked.txt"), "before\nafter\n");
		const daemon = await startHostDaemon([
			"--token",
			"secret-token",
			"--listen",
			"127.0.0.1:0",
			"--workspace",
			workspace,
		]);

		try {
			const baseUrl = `http://${daemon.host}:${daemon.port}`;
			const listed = await rpc(baseUrl, { id: "workspaces", method: "workspace/list" }, "secret-token");
			const workspaceId = (
				listed.json as { result: { workspaces: Array<{ id: string; path: string }> } }
			).result.workspaces.find((candidate) => candidate.path === workspace)?.id;

			const staged = await rpc(
				baseUrl,
				{ id: "stage", method: "workspace/git/stage", params: { workspaceId, path: "tracked.txt" } },
				"secret-token",
			);
			expect(staged.status).toBe(200);
			expect(staged.json).toEqual({
				id: "stage",
				result: {
					status: [expect.objectContaining({ path: "tracked.txt", staged: true, status: "M ", unstaged: false })],
					workspace: expect.objectContaining({ id: workspaceId, path: workspace }),
				},
			});

			const unstaged = await rpc(
				baseUrl,
				{ id: "unstage", method: "workspace/git/unstage", params: { workspaceId, path: "tracked.txt" } },
				"secret-token",
			);
			expect(unstaged.status).toBe(200);
			expect(unstaged.json).toEqual({
				id: "unstage",
				result: {
					status: [expect.objectContaining({ path: "tracked.txt", staged: false, status: " M", unstaged: true })],
					workspace: expect.objectContaining({ id: workspaceId, path: workspace }),
				},
			});

			const emptyCommit = await rpc(
				baseUrl,
				{ id: "empty-commit", method: "workspace/git/commit", params: { workspaceId, message: "   " } },
				"secret-token",
			);
			expect(emptyCommit.status).toBe(400);
			expect(emptyCommit.json).toEqual({
				error: expect.objectContaining({ message: expect.stringContaining("Commit message") }),
			});

			await rpc(
				baseUrl,
				{ id: "stage-again", method: "workspace/git/stage", params: { workspaceId, path: "tracked.txt" } },
				"secret-token",
			);
			const committed = await rpc(
				baseUrl,
				{ id: "commit", method: "workspace/git/commit", params: { workspaceId, message: "remote commit" } },
				"secret-token",
			);
			expect(committed.status).toBe(200);
			expect(committed.json).toEqual({
				id: "commit",
				result: {
					output: expect.stringContaining("remote commit"),
					status: [],
					workspace: expect.objectContaining({ id: workspaceId, path: workspace }),
				},
			});
		} finally {
			await daemon.stop();
		}
	});

	test("passes trailing app-server args to opened workspace app-servers", async () => {
		const dirs = createDirs();
		const workspace = realpathSync(dirs.projectDir);
		const extensionPath = join(workspace, "host-daemon-faux-provider.mjs");
		writeFileSync(
			extensionPath,
			`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function activate(pi) {
  pi.registerProvider("host-daemon-faux", {
    name: "Host Daemon Faux",
    baseUrl: "http://localhost:0",
    apiKey: "faux-key",
    api: "faux",
    models: [{
      id: "host-daemon-faux-1",
      name: "Host Daemon Faux 1",
      api: "faux",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 1024
    }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "host daemon passthrough ready" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "stop",
        timestamp: Date.now()
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [{ type: "text", text: "" }] } });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "host daemon passthrough ready", partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: "host daemon passthrough ready", partial: message });
        stream.push({ type: "done", reason: "stop", message });
      });
      return stream;
    }
  });
}
`,
		);
		const daemon = await startHostDaemon([
			"--token",
			"secret-token",
			"--listen",
			"127.0.0.1:0",
			"--workspace",
			workspace,
			"--",
			"--extension",
			extensionPath,
			"--model",
			"host-daemon-faux/host-daemon-faux-1",
		]);

		try {
			const baseUrl = `http://${daemon.host}:${daemon.port}`;
			const listed = await rpc(baseUrl, { id: "workspaces", method: "workspace/list" }, "secret-token");
			const workspaceId = (
				listed.json as { result: { workspaces: Array<{ id: string; path: string }> } }
			).result.workspaces.find((candidate) => candidate.path === workspace)?.id;

			const turn = await rpc(
				baseUrl,
				{
					id: "turn",
					method: "workspace/request",
					params: {
						workspaceId,
						request: { id: "app-turn", method: "turn/start", params: { message: "Run passthrough check" } },
					},
				},
				"secret-token",
			);
			expect(turn.status).toBe(200);
			expect(turn.json).toEqual({
				id: "turn",
				result: expect.objectContaining({
					response: {
						id: "app-turn",
						result: expect.objectContaining({
							accepted: true,
							threadId: expect.any(String),
							turnId: expect.any(String),
						}),
					},
				}),
			});

			const completed = await waitFor(async () => {
				const response = await rpc(
					baseUrl,
					{ id: "events", method: "workspace/events", params: { workspaceId, afterSequence: 0 } },
					"secret-token",
				);
				const events = (
					response.json as { result?: { events?: Array<{ event: { method?: string; params?: unknown } }> } }
				).result?.events;
				return events?.find((event) => event.event.method === "turn/completed");
			}, 5_000);

			expect(completed.event.params).toEqual(
				expect.objectContaining({
					message: expect.objectContaining({
						content: expect.arrayContaining([expect.objectContaining({ text: "host daemon passthrough ready" })]),
					}),
				}),
			);
		} finally {
			await daemon.stop();
		}
	}, 15_000);

	test("closes an opened workspace app-server", async () => {
		const dirs = createDirs();
		const workspace = realpathSync(dirs.projectDir);
		const daemon = await startHostDaemon([
			"--token",
			"secret-token",
			"--listen",
			"127.0.0.1:0",
			"--workspace",
			workspace,
		]);

		try {
			const baseUrl = `http://${daemon.host}:${daemon.port}`;
			const listed = await rpc(baseUrl, { id: "workspaces", method: "workspace/list" }, "secret-token");
			const workspaceId = (
				listed.json as { result: { workspaces: Array<{ id: string; path: string }> } }
			).result.workspaces.find((candidate) => candidate.path === workspace)?.id;

			await rpc(baseUrl, { id: "open", method: "workspace/open", params: { workspaceId } }, "secret-token");
			const closed = await rpc(
				baseUrl,
				{ id: "close", method: "workspace/close", params: { workspaceId } },
				"secret-token",
			);
			expect(closed.status).toBe(200);
			expect(closed.json).toEqual({
				id: "close",
				result: {
					process: expect.objectContaining({ running: false, stoppedAt: expect.any(String) }),
					workspace: expect.objectContaining({ id: workspaceId, path: workspace }),
				},
			});

			const hostStatus = await rpc(baseUrl, { id: "status", method: "host/status" }, "secret-token");
			expect(hostStatus.json).toEqual({
				id: "status",
				result: expect.objectContaining({ runningWorkspaceCount: 0 }),
			});
		} finally {
			await daemon.stop();
		}
	});
});
