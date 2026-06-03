import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
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
		messages: session.messages,
	};
}

export class AppServerProtocol {
	private readonly runtime: AppServerRuntime;
	private readonly notify: NotificationSink;
	private unsubscribe?: () => void;
	private nextItemId = 0;
	private activeAssistantItemId?: string;

	constructor(runtime: AppServerRuntime, notify: NotificationSink) {
		this.runtime = runtime;
		this.notify = notify;
		this.bindSession(runtime.session);
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
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
					capabilities: { threads: true, turns: true, models: true, tools: true, diffs: true },
				} satisfies AppServerInitializeResult);

			case "thread/list": {
				const sessions = await SessionManager.list(
					this.runtime.cwd,
					this.runtime.session.sessionManager.getSessionDir(),
				);
				const threads = sessions.map(toThreadSummary);
				if (!threads.some((thread) => thread.id === this.runtime.session.sessionId)) {
					threads.unshift(toCurrentThreadSummary(this.runtime.session));
				}
				return success(request.id, { threads });
			}

			case "thread/start": {
				const result = await this.runtime.newSession();
				if (!result.cancelled) {
					this.bindSession(this.runtime.session);
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
					this.bindSession(this.runtime.session);
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

			case "model/list": {
				const models = await this.runtime.session.modelRegistry.getAvailable();
				return success(request.id, { models });
			}

			default:
				return error(request.id, -32601, `Unknown method: ${request.method}`);
		}
	}
}
