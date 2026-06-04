import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, test } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";
import { AppServerProtocol } from "../src/modes/app-server/app-server-protocol.ts";
import type { AppServerNotification } from "../src/modes/app-server/app-server-types.ts";
import { createHarness, type Harness } from "./test-harness.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const tempDirs: string[] = [];

function createRuntime(
	harness: Harness,
): Pick<AgentSessionRuntime, "cwd" | "session" | "newSession" | "switchSession"> {
	return {
		cwd: harness.tempDir,
		session: harness.session,
		newSession: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
	};
}

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-app-server-v2-"));
	tempDirs.push(dir);
	return dir;
}

interface AppServerCliDirs {
	agentDir: string;
	projectDir: string;
	tempRoot: string;
}

async function runAppServerCli(
	input: string | ((dirs: AppServerCliDirs) => string),
	options: { args?: string[]; setup?: (dirs: AppServerCliDirs) => void } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	const tempRoot = createTempDir();
	const agentDir = join(tempRoot, "agent");
	const projectDir = join(tempRoot, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	const dirs = { agentDir, projectDir, tempRoot };
	options.setup?.(dirs);
	const resolvedInput = typeof input === "function" ? input(dirs) : input;

	return await new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [tsxPath, cliPath, "app-server", "--offline", ...(options.args ?? [])], {
			cwd: projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
		}, 10_000);
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			resolvePromise({ stdout, stderr, code });
		});

		child.stdin.end(resolvedInput);
	});
}

function writeSessionFile(path: string, cwd: string, id: string, label: string): void {
	const now = new Date().toISOString();
	const userEntry = {
		type: "message",
		id: `${id}-user`,
		parentId: null,
		timestamp: now,
		message: { role: "user", content: label, timestamp: Date.now() },
	};
	const assistantEntry = {
		type: "message",
		id: `${id}-assistant`,
		parentId: userEntry.id,
		timestamp: now,
		message: {
			role: "assistant",
			content: [{ type: "text", text: `reply to ${label}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
	};
	writeFileSync(
		path,
		[
			JSON.stringify({ type: "session", version: 3, id, timestamp: now, cwd }),
			JSON.stringify(userEntry),
			JSON.stringify(assistantEntry),
			"",
		].join("\n"),
	);
}

function writeFauxProviderExtension(path: string): void {
	writeFileSync(
		path,
		`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function activate(pi) {
	pi.registerProvider("desktop-faux", {
		name: "Desktop Faux",
		baseUrl: "http://localhost:0",
		apiKey: "faux-key",
		api: "faux",
		models: [{
			id: "desktop-faux-1",
			name: "Desktop Faux 1",
			api: "faux",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 1024,
		}],
		streamSimple(model) {
			const stream = createAssistantMessageEventStream();
			const message = {
				role: "assistant",
				content: [{ type: "text", text: "desktop ready" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: { ...message, content: [] } });
				stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [{ type: "text", text: "" }] } });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "desktop ready", partial: message });
				stream.push({ type: "text_end", contentIndex: 0, content: "desktop ready", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		},
	});
}
`,
	);
}

function parseJsonLines(stdout: string): unknown[] {
	return stdout
		.trim()
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as unknown);
}

describe("app-server v2 protocol", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("initializes with v2 protocol capabilities", async () => {
		harness = createHarness();
		const notifications: AppServerNotification[] = [];
		const protocol = new AppServerProtocol(createRuntime(harness), (notification) =>
			notifications.push(notification),
		);

		const response = await protocol.handleRequest({
			id: 1,
			method: "initialize",
			params: { clientInfo: { name: "test-client", version: "0.0.0" } },
		});

		expect(response).toEqual({
			id: 1,
			result: {
				protocolVersion: 2,
				serverInfo: { name: "pi-app-server", version: 2 },
				capabilities: {
					threads: true,
					turns: true,
					models: true,
					tools: true,
					diffs: true,
					approvals: true,
					methods: expect.arrayContaining([
						"initialize",
						"server/capabilities",
						"thread/list",
						"turn/start",
						"approval/respond",
					]),
					notifications: expect.arrayContaining([
						"turn/started",
						"item/agentMessage/delta",
						"item/toolCall/started",
						"item/diff/available",
						"approval/requested",
					]),
				},
			},
		});
		expect(notifications).toEqual([]);
	});

	test("exposes server capabilities without reinitializing", async () => {
		harness = createHarness();
		const protocol = new AppServerProtocol(createRuntime(harness), () => {});

		const response = await protocol.handleRequest({ id: "caps", method: "server/capabilities" });

		expect(response).toEqual({
			id: "caps",
			result: {
				protocolVersion: 2,
				serverInfo: { name: "pi-app-server", version: 2 },
				capabilities: expect.objectContaining({
					threads: true,
					turns: true,
					models: true,
					tools: true,
					diffs: true,
					approvals: true,
					methods: expect.arrayContaining(["server/capabilities", "model/set", "turn/interrupt"]),
					notifications: expect.arrayContaining(["turn/completed", "thread/archived"]),
				}),
			},
		});
	});

	test("reports workspace and turn status", async () => {
		harness = createHarness();
		const protocol = new AppServerProtocol(createRuntime(harness), () => {});

		const workspaceStatus = await protocol.handleRequest({ id: "workspace-status", method: "workspace/status" });
		const turnStatus = await protocol.handleRequest({ id: "turn-status", method: "turn/status" });

		const expectedStatus = {
			cwd: harness.tempDir,
			threadId: harness.session.sessionId,
			sessionPath: harness.session.sessionFile,
			running: false,
			pendingApprovalCount: 0,
		};
		expect(workspaceStatus).toEqual({ id: "workspace-status", result: expectedStatus });
		expect(turnStatus).toEqual({ id: "turn-status", result: expectedStatus });
	});

	test("reports pending approval count in status", async () => {
		harness = createHarness();
		const notifications: AppServerNotification[] = [];
		const protocol = new AppServerProtocol(createRuntime(harness), (notification) =>
			notifications.push(notification),
		);
		await protocol.bindExtensions();

		const confirmPromise = harness.session.extensionRunner.getUIContext().confirm("Run command", "Allow bash?");
		await new Promise((resolve) => setTimeout(resolve, 0));

		const status = await protocol.handleRequest({ id: "turn-status", method: "turn/status" });

		expect(status).toEqual({
			id: "turn-status",
			result: expect.objectContaining({
				running: false,
				pendingApprovalCount: 1,
			}),
		});

		const approval = notifications.find((notification) => notification.method === "approval/requested");
		await protocol.handleRequest({
			id: "approval",
			method: "approval/respond",
			params: { approvalId: approval?.params.approvalId, confirmed: false },
		});
		await expect(confirmPromise).resolves.toBe(false);
	});

	test("pins and unpins sessions server-side", async () => {
		harness = createHarness();
		const protocol = new AppServerProtocol(createRuntime(harness), () => {});

		const pinned = await protocol.handleRequest({
			id: "pin",
			method: "thread/pin",
			params: { sessionPath: harness.session.sessionFile, pinned: true },
		});
		const listPinned = await protocol.handleRequest({
			id: "list-pinned",
			method: "thread/list",
			params: { pinnedOnly: true },
		});
		const unpinned = await protocol.handleRequest({
			id: "unpin",
			method: "thread/pin",
			params: { sessionPath: harness.session.sessionFile, pinned: false },
		});
		const listAfterUnpin = await protocol.handleRequest({
			id: "list-after-unpin",
			method: "thread/list",
			params: { pinnedOnly: true },
		});

		expect(pinned).toEqual({
			id: "pin",
			result: {
				pinned: true,
				sessionPath: harness.session.sessionFile,
				thread: expect.objectContaining({ id: harness.session.sessionId, pinned: true }),
			},
		});
		expect(listPinned).toEqual({
			id: "list-pinned",
			result: {
				threads: expect.arrayContaining([expect.objectContaining({ id: harness.session.sessionId, pinned: true })]),
			},
		});
		expect(unpinned).toEqual({
			id: "unpin",
			result: {
				pinned: false,
				sessionPath: harness.session.sessionFile,
				thread: expect.objectContaining({ id: harness.session.sessionId, pinned: false }),
			},
		});
		expect(listAfterUnpin).toEqual({ id: "list-after-unpin", result: { threads: [] } });
	});

	test("searches threads by message text and metadata", async () => {
		harness = createHarness();
		const protocol = new AppServerProtocol(createRuntime(harness), () => {});
		harness.session.sessionManager.appendSessionInfo("Roadmap Review");
		await harness.session.prompt("desktop app-server searchable needle", { source: "rpc" });

		const byMessage = await protocol.handleRequest({
			id: "search-message",
			method: "thread/search",
			params: { query: "searchable needle" },
		});
		const byName = await protocol.handleRequest({
			id: "search-name",
			method: "thread/search",
			params: { query: "roadmap" },
		});

		expect(byMessage).toEqual({
			id: "search-message",
			result: {
				threads: expect.arrayContaining([expect.objectContaining({ id: harness.session.sessionId })]),
			},
		});
		expect(byName).toEqual({
			id: "search-name",
			result: {
				threads: expect.arrayContaining([expect.objectContaining({ id: harness.session.sessionId })]),
			},
		});
	});

	test("starts a turn and emits structured item notifications", async () => {
		harness = createHarness({ responses: ["hello from app server"] });
		const notifications: AppServerNotification[] = [];
		const protocol = new AppServerProtocol(createRuntime(harness), (notification) =>
			notifications.push(notification),
		);

		const response = await protocol.handleRequest({
			id: "turn-1",
			method: "turn/start",
			params: { message: "Say hello" },
		});

		expect(response).toEqual({
			id: "turn-1",
			result: {
				accepted: true,
				threadId: harness.session.sessionId,
			},
		});
		expect(notifications.map((notification) => notification.method)).toContain("turn/started");
		expect(notifications.map((notification) => notification.method)).toContain("item/agentMessage/delta");
		expect(notifications.map((notification) => notification.method)).toContain("item/completed");
		expect(notifications.map((notification) => notification.method)).toContain("turn/completed");

		const textDeltas = notifications
			.filter((notification) => notification.method === "item/agentMessage/delta")
			.map((notification) => notification.params.delta)
			.join("");
		expect(textDeltas).toBe("hello from app server");
	});

	test("emits structured tool call notifications", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params, _signal, onUpdate) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				onUpdate?.({
					content: [{ type: "text", text: `partial:${text}` }],
					details: { phase: "running", text },
				});
				return {
					content: [{ type: "text", text: `echo:${text}` }],
					details: { text },
				};
			},
		};
		harness = createHarness({
			responses: [{ toolCalls: [{ id: "tool-1", name: "echo", args: { text: "hi" } }] }, "done"],
			tools: [echoTool],
			baseToolsOverride: { echo: echoTool },
		});
		const notifications: AppServerNotification[] = [];
		const protocol = new AppServerProtocol(createRuntime(harness), (notification) =>
			notifications.push(notification),
		);

		await protocol.handleRequest({
			id: "turn-tool",
			method: "turn/start",
			params: { message: "Use echo" },
		});

		const toolStarted = notifications.find((notification) => notification.method === "item/toolCall/started");
		const toolUpdated = notifications.find((notification) => notification.method === "item/toolCall/updated");
		const toolCompleted = notifications.find((notification) => notification.method === "item/toolCall/completed");

		expect(toolStarted?.params).toMatchObject({
			threadId: harness.session.sessionId,
			itemId: "tool-1",
			toolCallId: "tool-1",
			toolName: "echo",
			args: { text: "hi" },
		});
		expect(toolUpdated?.params).toMatchObject({
			threadId: harness.session.sessionId,
			itemId: "tool-1",
			toolCallId: "tool-1",
			toolName: "echo",
			partialResult: { details: { phase: "running", text: "hi" } },
		});
		expect(toolCompleted?.params).toMatchObject({
			threadId: harness.session.sessionId,
			itemId: "tool-1",
			toolCallId: "tool-1",
			toolName: "echo",
			result: { details: { text: "hi" } },
			isError: false,
		});
	});

	test("emits structured diff notifications from tool result details", async () => {
		const editTool: AgentTool = {
			name: "edit",
			label: "Edit",
			description: "Edit a file",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => ({
				content: [{ type: "text", text: "edited" }],
				details: {
					diff: "- old\n+ new",
					patch: "@@ -1 +1 @@\n-old\n+new",
					firstChangedLine: 1,
				},
			}),
		};
		harness = createHarness({
			responses: [{ toolCalls: [{ id: "edit-1", name: "edit", args: { path: "file.txt" } }] }, "done"],
			tools: [editTool],
			baseToolsOverride: { edit: editTool },
		});
		const notifications: AppServerNotification[] = [];
		const protocol = new AppServerProtocol(createRuntime(harness), (notification) =>
			notifications.push(notification),
		);

		await protocol.handleRequest({
			id: "turn-diff",
			method: "turn/start",
			params: { message: "Edit file" },
		});

		const diffAvailable = notifications.find((notification) => notification.method === "item/diff/available");
		expect(diffAvailable?.params).toMatchObject({
			threadId: harness.session.sessionId,
			itemId: "edit-1",
			toolCallId: "edit-1",
			toolName: "edit",
			diff: "- old\n+ new",
			patch: "@@ -1 +1 @@\n-old\n+new",
			firstChangedLine: 1,
		});
	});

	test("routes extension UI confirmation through approval requests", async () => {
		harness = createHarness();
		const notifications: AppServerNotification[] = [];
		const protocol = new AppServerProtocol(createRuntime(harness), (notification) =>
			notifications.push(notification),
		);
		await protocol.bindExtensions();

		const confirmPromise = harness.session.extensionRunner.getUIContext().confirm("Run command", "Allow bash?");
		await new Promise((resolve) => setTimeout(resolve, 0));

		const approval = notifications.find((notification) => notification.method === "approval/requested");
		expect(approval?.params).toMatchObject({
			kind: "confirm",
			title: "Run command",
			message: "Allow bash?",
		});
		expect(typeof approval?.params.approvalId).toBe("string");

		const response = await protocol.handleRequest({
			id: "approval",
			method: "approval/respond",
			params: { approvalId: approval?.params.approvalId, confirmed: true },
		});

		expect(response).toEqual({
			id: "approval",
			result: { accepted: true },
		});
		await expect(confirmPromise).resolves.toBe(true);
	});

	test("gets and sets the active model", async () => {
		harness = createHarness();
		const protocol = new AppServerProtocol(createRuntime(harness), () => {});

		const current = await protocol.handleRequest({ id: "current", method: "model/current" });
		expect(current).toEqual({
			id: "current",
			result: {
				model: expect.objectContaining({
					id: "faux-1",
					provider: "faux",
				}),
			},
		});

		const response = await protocol.handleRequest({
			id: "set-model",
			method: "model/set",
			params: { provider: "faux", modelId: "faux-1" },
		});

		expect(response).toEqual({
			id: "set-model",
			result: {
				model: expect.objectContaining({
					id: "faux-1",
					provider: "faux",
				}),
			},
		});
	});

	test("pi app-server responds to initialize over stdio before a model is selected", async () => {
		const result = await runAppServerCli(
			`${JSON.stringify({ id: "init", method: "initialize", params: { clientInfo: { name: "smoke" } } })}\n`,
		);

		expect(result.code).toBe(0);
		expect(result.stderr).not.toContain("No models available");

		const response = JSON.parse(result.stdout.trim()) as { id: string; result: { protocolVersion: number } };
		expect(response.id).toBe("init");
		expect(response.result.protocolVersion).toBe(2);
	});

	test("pi app-server returns a structured turn/start error when no model is selected", async () => {
		const result = await runAppServerCli(
			`${JSON.stringify({ id: "turn", method: "turn/start", params: { message: "hi" } })}\n`,
		);

		expect(result.code).toBe(0);
		const response = JSON.parse(result.stdout.trim()) as { id: string; error: { code: number; message: string } };
		expect(response.id).toBe("turn");
		expect(response.error.code).toBe(-32000);
		expect(response.error.message).toContain("model");
	});

	test("pi app-server exposes thread/list and thread/read over stdio", async () => {
		const result = await runAppServerCli(
			[
				JSON.stringify({ id: "list", method: "thread/list" }),
				JSON.stringify({ id: "read", method: "thread/read" }),
				"",
			].join("\n"),
		);

		expect(result.code).toBe(0);
		const responses = parseJsonLines(result.stdout) as Array<{
			id: string;
			result: {
				threads?: Array<{ id: string; cwd: string }>;
				thread?: { id: string; cwd: string; messages: unknown[] };
			};
		}>;

		const listResponse = responses.find((response) => response.id === "list");
		expect(listResponse?.result.threads?.length).toBeGreaterThanOrEqual(1);
		expect(listResponse?.result.threads?.[0].id).toEqual(expect.any(String));

		const readResponse = responses.find((response) => response.id === "read");
		expect(readResponse?.result.thread?.id).toEqual(expect.any(String));
		expect(readResponse?.result.thread?.cwd).toEqual(expect.any(String));
		expect(readResponse?.result.thread?.messages).toEqual([]);
	});

	test("pi app-server archives a session over stdio", async () => {
		let archivedSessionPath = "";
		const result = await runAppServerCli(({ agentDir, projectDir }) => {
			const sessionDir = getDefaultSessionDir(projectDir, agentDir);
			const archivePath = join(sessionDir, "2026-01-02T00-00-00-000Z_archive-thread.jsonl");
			archivedSessionPath = archivePath;
			writeSessionFile(archivePath, projectDir, "archive-thread", "archive me");
			return [
				JSON.stringify({ id: "archive", method: "thread/archive", params: { sessionPath: archivePath } }),
				"",
			].join("\n");
		});

		expect(result.code).toBe(0);
		const responses = parseJsonLines(result.stdout) as Array<{
			id?: string;
			method?: string;
			result?: {
				archived?: boolean;
			};
		}>;

		const archive = responses.find((response) => response.id === "archive");
		expect(archive?.result?.archived).toBe(true);
		expect(responses.some((response) => response.method === "thread/archived")).toBe(true);
		expect(SessionManager.open(archivedSessionPath).getSessionArchived()).toBe(true);
	});

	test("pi app-server streams a turn/start response through a desktop-registered provider", async () => {
		const result = await runAppServerCli(
			`${JSON.stringify({ id: "turn", method: "turn/start", params: { message: "hi" } })}\n`,
			{
				args: ["--extension", "./desktop-faux-provider.mjs", "--model", "desktop-faux/desktop-faux-1"],
				setup: ({ projectDir }) => {
					writeFauxProviderExtension(join(projectDir, "desktop-faux-provider.mjs"));
				},
			},
		);

		expect(result.code).toBe(0);
		const messages = parseJsonLines(result.stdout) as Array<{
			id?: string;
			method?: string;
			params?: { delta?: string };
			result?: { accepted?: boolean; threadId?: string };
		}>;

		expect(messages.find((message) => message.method === "turn/started")).toBeDefined();
		expect(messages.find((message) => message.method === "item/agentMessage/delta")?.params?.delta).toBe(
			"desktop ready",
		);
		expect(messages.find((message) => message.method === "turn/completed")).toBeDefined();

		const response = messages.find((message) => message.id === "turn");
		expect(response?.result?.accepted).toBe(true);
		expect(response?.result?.threadId).toEqual(expect.any(String));
	});
});
