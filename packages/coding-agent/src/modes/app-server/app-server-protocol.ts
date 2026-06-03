import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../../core/extensions/index.ts";
import { type SessionInfo, SessionManager } from "../../core/session-manager.ts";
import type {
	AppServerInitializeResult,
	AppServerNotification,
	AppServerRequest,
	AppServerResponse,
	AppServerThread,
	AppServerThreadSummary,
} from "./app-server-types.ts";

type AppServerRuntime = Pick<AgentSessionRuntime, "cwd" | "session" | "newSession" | "switchSession">;

type NotificationSink = (notification: AppServerNotification) => void;

type PendingApproval = {
	resolve: (response: Record<string, unknown>) => void;
};

function success(id: AppServerRequest["id"], result: unknown): AppServerResponse {
	return { id, result };
}

function error(id: AppServerRequest["id"], code: number, message: string): AppServerResponse {
	return { id, error: { code, message } };
}

function getRecordParams(params: unknown): Record<string, unknown> {
	return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
}

function getStringParam(params: unknown, name: string): string | undefined {
	const record = getRecordParams(params);
	const value = record[name];
	return typeof value === "string" ? value : undefined;
}

function getBooleanParam(params: unknown, name: string): boolean | undefined {
	const record = getRecordParams(params);
	const value = record[name];
	return typeof value === "boolean" ? value : undefined;
}

function getMessageText(message: AgentMessage): string {
	if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") {
		return "";
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

function getDiffDetails(result: unknown): Record<string, unknown> | undefined {
	if (typeof result !== "object" || result === null || !("details" in result)) {
		return undefined;
	}
	const details = (result as { details?: unknown }).details;
	if (typeof details !== "object" || details === null) {
		return undefined;
	}
	const record = details as Record<string, unknown>;
	return typeof record.diff === "string" ? record : undefined;
}

function toThreadSummary(info: SessionInfo): AppServerThreadSummary {
	return {
		id: info.id,
		path: info.path,
		cwd: info.cwd,
		name: info.name,
		archived: info.archived,
		created: info.created.toISOString(),
		modified: info.modified.toISOString(),
		messageCount: info.messageCount,
		firstMessage: info.firstMessage,
	};
}

function toCurrentThreadSummary(session: AgentSession): AppServerThreadSummary {
	const header = session.sessionManager.getHeader();
	const timestamp = header?.timestamp ?? new Date().toISOString();
	return {
		id: session.sessionId,
		path: session.sessionFile,
		cwd: session.sessionManager.getCwd(),
		name: session.sessionName,
		archived: session.sessionManager.getSessionArchived(),
		created: timestamp,
		modified: timestamp,
		messageCount: session.messages.length,
		firstMessage: "",
	};
}

function toCurrentThread(session: AgentSession): AppServerThread {
	return {
		id: session.sessionId,
		path: session.sessionFile,
		cwd: session.sessionManager.getCwd(),
		name: session.sessionName,
		archived: session.sessionManager.getSessionArchived(),
		messages: session.messages,
	};
}

export class AppServerProtocol {
	private readonly runtime: AppServerRuntime;
	private readonly notify: NotificationSink;
	private unsubscribe?: () => void;
	private nextItemId = 0;
	private activeAssistantItemId?: string;
	private readonly pendingApprovals = new Map<string, PendingApproval>();

	constructor(runtime: AppServerRuntime, notify: NotificationSink) {
		this.runtime = runtime;
		this.notify = notify;
		this.bindSession(runtime.session);
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		for (const approval of this.pendingApprovals.values()) {
			approval.resolve({ cancelled: true });
		}
		this.pendingApprovals.clear();
	}

	async bindExtensions(): Promise<void> {
		this.bindSession(this.runtime.session);
		await this.runtime.session.bindExtensions({
			uiContext: this.createExtensionUIContext(),
			mode: "rpc",
		});
	}

	private bindSession(session: AgentSession): void {
		this.unsubscribe?.();
		this.activeAssistantItemId = undefined;
		this.unsubscribe = session.subscribe((event) => {
			this.handleSessionEvent(event);
		});
	}

	private emit(method: string, params: Record<string, unknown>): void {
		this.notify({ method, params });
	}

	private createItemId(): string {
		this.nextItemId++;
		return `item-${this.nextItemId}`;
	}

	private createApprovalPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: Record<string, unknown>) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) {
			return Promise.resolve(defaultValue);
		}

		const approvalId = randomUUID();
		return new Promise((resolve) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) {
					clearTimeout(timeoutId);
				}
				opts?.signal?.removeEventListener("abort", onAbort);
				this.pendingApprovals.delete(approvalId);
			};

			const finish = (response: Record<string, unknown>) => {
				cleanup();
				resolve(parseResponse(response));
			};

			const onAbort = () => finish({ cancelled: true });
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => finish({ cancelled: true }), opts.timeout);
			}

			this.pendingApprovals.set(approvalId, { resolve: finish });
			this.emit("approval/requested", {
				approvalId,
				timeout: opts?.timeout,
				...request,
			});
		});
	}

	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) =>
				this.createApprovalPromise(opts, undefined, { kind: "select", title, options }, (response) =>
					response.cancelled ? undefined : typeof response.value === "string" ? response.value : undefined,
				),
			confirm: (title, message, opts) =>
				this.createApprovalPromise(opts, false, { kind: "confirm", title, message }, (response) =>
					response.cancelled ? false : response.confirmed === true,
				),
			input: (title, placeholder, opts) =>
				this.createApprovalPromise(opts, undefined, { kind: "input", title, placeholder }, (response) =>
					response.cancelled ? undefined : typeof response.value === "string" ? response.value : undefined,
				),
			notify: (message, type) => this.emit("notification/show", { message, type }),
			onTerminalInput: () => () => {},
			setStatus: (key, text) => this.emit("status/set", { key, text }),
			setWorkingMessage: (message) => this.emit("working/message/set", { message }),
			setWorkingVisible: (visible) => this.emit("working/visible/set", { visible }),
			setWorkingIndicator: (options) => this.emit("working/indicator/set", { options }),
			setHiddenThinkingLabel: (label) => this.emit("thinking/hiddenLabel/set", { label }),
			setWidget: (key, lines, options) => this.emit("widget/set", { key, lines, options }),
			setFooter: () => {},
			setHeader: () => {},
			setTitle: (title) => this.emit("window/title/set", { title }),
			custom: async () => undefined as never,
			pasteToEditor: (text) => this.emit("editor/paste", { text }),
			setEditorText: (text) => this.emit("editor/text/set", { text }),
			getEditorText: () => "",
			editor: (title, prefill) =>
				this.createApprovalPromise(undefined, undefined, { kind: "editor", title, prefill }, (response) =>
					response.cancelled ? undefined : typeof response.value === "string" ? response.value : undefined,
				),
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			get theme() {
				return undefined as never;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: (name) => {
				this.emit("theme/set", { name });
				return { success: true };
			},
			getToolsExpanded: () => false,
			setToolsExpanded: (expanded) => this.emit("tools/expanded/set", { expanded }),
		};
	}

	private handleSessionEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.emit("turn/started", { threadId: this.runtime.session.sessionId });
				break;

			case "message_start": {
				const itemId = this.createItemId();
				if (event.message.role === "assistant") {
					this.activeAssistantItemId = itemId;
				}
				this.emit("item/started", {
					threadId: this.runtime.session.sessionId,
					itemId,
					role: event.message.role,
				});
				break;
			}

			case "message_update":
				if (
					this.activeAssistantItemId &&
					event.assistantMessageEvent.type === "text_delta" &&
					event.assistantMessageEvent.delta.length > 0
				) {
					this.emit("item/agentMessage/delta", {
						threadId: this.runtime.session.sessionId,
						itemId: this.activeAssistantItemId,
						delta: event.assistantMessageEvent.delta,
					});
				}
				break;

			case "message_end": {
				const itemId =
					event.message.role === "assistant" && this.activeAssistantItemId
						? this.activeAssistantItemId
						: this.createItemId();
				this.emit("item/completed", {
					threadId: this.runtime.session.sessionId,
					itemId,
					role: event.message.role,
					text: getMessageText(event.message),
				});
				if (event.message.role === "assistant") {
					this.activeAssistantItemId = undefined;
				}
				break;
			}

			case "tool_execution_start":
				this.emit("item/toolCall/started", {
					threadId: this.runtime.session.sessionId,
					itemId: event.toolCallId,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
				});
				break;

			case "tool_execution_update":
				this.emit("item/toolCall/updated", {
					threadId: this.runtime.session.sessionId,
					itemId: event.toolCallId,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					partialResult: event.partialResult,
				});
				break;

			case "tool_execution_end":
				this.emit("item/toolCall/completed", {
					threadId: this.runtime.session.sessionId,
					itemId: event.toolCallId,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					result: event.result,
					isError: event.isError,
				});
				{
					const diffDetails = getDiffDetails(event.result);
					if (diffDetails) {
						this.emit("item/diff/available", {
							threadId: this.runtime.session.sessionId,
							itemId: event.toolCallId,
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							diff: diffDetails.diff,
							patch: diffDetails.patch,
							firstChangedLine: diffDetails.firstChangedLine,
						});
					}
				}
				break;

			case "turn_end":
				this.emit("turn/completed", {
					threadId: this.runtime.session.sessionId,
					message: event.message,
					toolResults: event.toolResults,
				});
				break;
		}
	}

	async handleRequest(request: AppServerRequest): Promise<AppServerResponse> {
		try {
			return await this.handleKnownRequest(request);
		} catch (requestError: unknown) {
			return error(request.id, -32000, requestError instanceof Error ? requestError.message : String(requestError));
		}
	}

	private async handleKnownRequest(request: AppServerRequest): Promise<AppServerResponse> {
		switch (request.method) {
			case "initialize":
				return success(request.id, {
					protocolVersion: 2,
					serverInfo: { name: "pi-app-server", version: 2 },
					capabilities: { threads: true, turns: true, models: true, tools: true, diffs: true, approvals: true },
				} satisfies AppServerInitializeResult);

			case "thread/list": {
				const includeArchived = getBooleanParam(request.params, "includeArchived") === true;
				const sessions = await SessionManager.list(
					this.runtime.cwd,
					this.runtime.session.sessionManager.getSessionDir(),
					undefined,
					{ includeArchived },
				);
				const threads = sessions.map(toThreadSummary);
				const current = toCurrentThreadSummary(this.runtime.session);
				if ((includeArchived || current.archived !== true) && !threads.some((thread) => thread.id === current.id)) {
					threads.unshift(current);
				}
				return success(request.id, { threads });
			}

			case "thread/start": {
				const result = await this.runtime.newSession();
				if (!result.cancelled) {
					await this.bindExtensions();
				}
				return success(request.id, { cancelled: result.cancelled, thread: toCurrentThread(this.runtime.session) });
			}

			case "thread/resume": {
				const sessionPath = getStringParam(request.params, "sessionPath");
				if (!sessionPath) {
					return error(request.id, -32602, "thread/resume requires params.sessionPath");
				}
				const result = await this.runtime.switchSession(sessionPath);
				if (!result.cancelled) {
					await this.bindExtensions();
				}
				return success(request.id, { cancelled: result.cancelled, thread: toCurrentThread(this.runtime.session) });
			}

			case "thread/read":
				return success(request.id, { thread: toCurrentThread(this.runtime.session) });

			case "thread/name/set": {
				const name = getStringParam(request.params, "name");
				if (!name?.trim()) {
					return error(request.id, -32602, "thread/name/set requires a non-empty params.name");
				}
				this.runtime.session.setSessionName(name.trim());
				return success(request.id, { thread: toCurrentThread(this.runtime.session) });
			}

			case "thread/archive": {
				const sessionPath = getStringParam(request.params, "sessionPath");
				if (!sessionPath) {
					return error(request.id, -32602, "thread/archive requires params.sessionPath");
				}

				const target = SessionManager.open(sessionPath, this.runtime.session.sessionManager.getSessionDir());
				target.appendSessionInfo(undefined, { archived: true });
				this.emit("thread/archived", { sessionPath, threadId: target.getSessionId() });

				if (this.runtime.session.sessionFile === target.getSessionFile()) {
					const result = await this.runtime.newSession();
					if (!result.cancelled) {
						await this.bindExtensions();
					}
				}

				return success(request.id, {
					archived: true,
					sessionPath,
					thread: toCurrentThread(this.runtime.session),
				});
			}

			case "turn/start": {
				const message = getStringParam(request.params, "message");
				if (!message) {
					return error(request.id, -32602, "turn/start requires params.message");
				}
				await this.runtime.session.prompt(message, { source: "rpc" });
				return success(request.id, { accepted: true, threadId: this.runtime.session.sessionId });
			}

			case "turn/interrupt":
				await this.runtime.session.abort();
				return success(request.id, { interrupted: true, threadId: this.runtime.session.sessionId });

			case "approval/respond": {
				const approvalId = getStringParam(request.params, "approvalId");
				if (!approvalId) {
					return error(request.id, -32602, "approval/respond requires params.approvalId");
				}
				const pending = this.pendingApprovals.get(approvalId);
				if (!pending) {
					return error(request.id, -32001, `Unknown approvalId: ${approvalId}`);
				}
				pending.resolve(getRecordParams(request.params));
				return success(request.id, { accepted: true });
			}

			case "model/list": {
				const models = await this.runtime.session.modelRegistry.getAvailable();
				return success(request.id, { models });
			}

			default:
				return error(request.id, -32601, `Unknown method: ${request.method}`);
		}
	}
}
