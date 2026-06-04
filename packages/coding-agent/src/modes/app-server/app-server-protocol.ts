import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../../core/extensions/index.ts";
import { type SessionInfo, SessionManager } from "../../core/session-manager.ts";
import type {
	AppServerCommand,
	AppServerInitializeResult,
	AppServerNotification,
	AppServerRecordedEvent,
	AppServerRequest,
	AppServerResponse,
	AppServerStatus,
	AppServerThread,
	AppServerThreadSummary,
} from "./app-server-types.ts";

type AppServerRuntime = Pick<AgentSessionRuntime, "cwd" | "session" | "newSession" | "switchSession">;

type NotificationSink = (notification: AppServerNotification) => void;

type PendingApproval = {
	resolve: (response: Record<string, unknown>) => void;
};

const MAX_RECORDED_EVENTS = 500;

const SUPPORTED_METHODS = [
	"initialize",
	"server/capabilities",
	"session/events",
	"workspace/status",
	"thread/list",
	"thread/start",
	"thread/resume",
	"thread/read",
	"thread/status",
	"thread/name/set",
	"thread/archive",
	"thread/pin",
	"thread/search",
	"turn/status",
	"turn/start",
	"turn/interrupt",
	"approval/respond",
	"command/list",
	"model/list",
	"model/current",
	"model/set",
] as const;

const SUPPORTED_NOTIFICATIONS = [
	"turn/started",
	"turn/error",
	"turn/completed",
	"item/started",
	"item/agentMessage/delta",
	"item/completed",
	"item/toolCall/started",
	"item/toolCall/updated",
	"item/toolCall/completed",
	"item/diff/available",
	"approval/requested",
	"thread/archived",
	"thread/pinned",
	"notification/show",
	"status/set",
	"working/message/set",
	"working/visible/set",
	"working/indicator/set",
	"thinking/hiddenLabel/set",
	"widget/set",
	"theme/set",
	"tools/expanded/set",
	"window/title/set",
	"editor/paste",
	"editor/text/set",
] as const;

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

function searchMatches(thread: AppServerThreadSummary, query: string): boolean {
	const normalized = query.trim().toLowerCase();
	if (!normalized) {
		return true;
	}
	return [thread.name, thread.firstMessage, thread.id, thread.cwd]
		.filter((value): value is string => typeof value === "string")
		.some((value) => value.toLowerCase().includes(normalized));
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

function toModelInfo(model: Model<any> | undefined): Record<string, unknown> | undefined {
	if (!model) {
		return undefined;
	}
	return {
		id: model.id,
		name: model.name,
		provider: model.provider,
		reasoning: model.reasoning,
	};
}

function modelsMatch(model: Model<any> | undefined, provider: string, modelId: string): model is Model<any> {
	return model !== undefined && model.provider === provider && model.id === modelId;
}

function getCapabilities(): AppServerInitializeResult {
	return {
		protocolVersion: 2,
		serverInfo: { name: "pi-app-server", version: 2 },
		capabilities: {
			threads: true,
			turns: true,
			models: true,
			tools: true,
			diffs: true,
			approvals: true,
			methods: [...SUPPORTED_METHODS],
			notifications: [...SUPPORTED_NOTIFICATIONS],
		},
	};
}

function getStatus(runtime: AppServerRuntime, pendingApprovalCount: number, eventSequence: number): AppServerStatus {
	return {
		cwd: runtime.cwd,
		threadId: runtime.session.sessionId,
		sessionPath: runtime.session.sessionFile,
		running: runtime.session.isStreaming,
		pendingApprovalCount,
		eventSequence,
	};
}

function listCommands(session: AgentSession): AppServerCommand[] {
	const commands: AppServerCommand[] = [];

	for (const command of session.extensionRunner.getRegisteredCommands()) {
		commands.push({
			name: command.invocationName,
			description: command.description,
			source: "extension",
			sourceInfo: command.sourceInfo,
		});
	}

	for (const template of session.promptTemplates) {
		commands.push({
			name: template.name,
			description: template.description,
			source: "prompt",
			sourceInfo: template.sourceInfo,
		});
	}

	for (const skill of session.resourceLoader.getSkills().skills) {
		commands.push({
			name: `skill:${skill.name}`,
			description: skill.description,
			source: "skill",
			sourceInfo: skill.sourceInfo,
		});
	}

	return commands;
}

function toThreadSummary(info: SessionInfo): AppServerThreadSummary {
	return {
		id: info.id,
		path: info.path,
		cwd: info.cwd,
		name: info.name,
		archived: info.archived,
		pinned: info.pinned,
		created: info.created.toISOString(),
		modified: info.modified.toISOString(),
		messageCount: info.messageCount,
		firstMessage: info.firstMessage,
	};
}

function toCurrentThreadSummary(session: AgentSession, cwd = session.sessionManager.getCwd()): AppServerThreadSummary {
	const header = session.sessionManager.getHeader();
	const timestamp = header?.timestamp ?? new Date().toISOString();
	const firstUserMessage = session.messages.find((message) => message.role === "user");
	return {
		id: session.sessionId,
		path: session.sessionFile,
		cwd,
		name: session.sessionName ?? session.sessionManager.getSessionName(),
		archived: session.sessionManager.getSessionArchived(),
		pinned: session.sessionManager.getSessionPinned(),
		created: timestamp,
		modified: timestamp,
		messageCount: session.messages.length,
		firstMessage: firstUserMessage ? getMessageText(firstUserMessage) : "",
	};
}

function toCurrentThread(session: AgentSession, cwd = session.sessionManager.getCwd()): AppServerThread {
	return {
		id: session.sessionId,
		path: session.sessionFile,
		cwd,
		name: session.sessionName ?? session.sessionManager.getSessionName(),
		archived: session.sessionManager.getSessionArchived(),
		pinned: session.sessionManager.getSessionPinned(),
		messages: session.messages,
	};
}

function toThreadFromSessionManager(sessionManager: SessionManager): AppServerThread {
	return {
		id: sessionManager.getSessionId(),
		path: sessionManager.getSessionFile(),
		cwd: sessionManager.getCwd(),
		name: sessionManager.getSessionName(),
		archived: sessionManager.getSessionArchived(),
		pinned: sessionManager.getSessionPinned(),
		messages: [],
	};
}

export class AppServerProtocol {
	private readonly runtime: AppServerRuntime;
	private readonly notify: NotificationSink;
	private unsubscribe?: () => void;
	private nextItemId = 0;
	private nextEventSequence = 0;
	private activeAssistantItemId?: string;
	private readonly pendingApprovals = new Map<string, PendingApproval>();
	private readonly recordedEvents: AppServerRecordedEvent[] = [];
	private readonly activeTurns = new Set<Promise<void>>();

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

	async waitForIdle(): Promise<void> {
		await Promise.allSettled([...this.activeTurns]);
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
		const notification = { method, params };
		this.nextEventSequence++;
		this.recordedEvents.push({
			sequence: this.nextEventSequence,
			timestamp: new Date().toISOString(),
			...notification,
		});
		if (this.recordedEvents.length > MAX_RECORDED_EVENTS) {
			this.recordedEvents.splice(0, this.recordedEvents.length - MAX_RECORDED_EVENTS);
		}
		this.notify(notification);
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
			case "server/capabilities":
				return success(request.id, getCapabilities());

			case "session/events": {
				const rawSince = getRecordParams(request.params).since;
				const since = typeof rawSince === "number" && Number.isFinite(rawSince) ? rawSince : 0;
				return success(request.id, {
					events: this.recordedEvents.filter((event) => event.sequence > since),
					nextSequence: this.nextEventSequence,
				});
			}

			case "workspace/status":
			case "turn/status":
				return success(request.id, getStatus(this.runtime, this.pendingApprovals.size, this.nextEventSequence));

			case "thread/list": {
				const includeArchived = getBooleanParam(request.params, "includeArchived") === true;
				const pinnedOnly = getBooleanParam(request.params, "pinnedOnly") === true;
				const sessions = await SessionManager.list(
					this.runtime.cwd,
					this.runtime.session.sessionManager.getSessionDir(),
					undefined,
					{ includeArchived },
				);
				let threads = sessions.map(toThreadSummary);
				const current = toCurrentThreadSummary(this.runtime.session, this.runtime.cwd);
				if ((includeArchived || current.archived !== true) && !threads.some((thread) => thread.id === current.id)) {
					threads.unshift(current);
				}
				if (pinnedOnly) {
					threads = threads.filter((thread) => thread.pinned === true);
				}
				return success(request.id, { threads });
			}

			case "thread/search": {
				const query = getStringParam(request.params, "query");
				if (query === undefined) {
					return error(request.id, -32602, "thread/search requires params.query");
				}
				const includeArchived = getBooleanParam(request.params, "includeArchived") === true;
				const pinnedOnly = getBooleanParam(request.params, "pinnedOnly") === true;
				const sessions = await SessionManager.list(
					this.runtime.cwd,
					this.runtime.session.sessionManager.getSessionDir(),
					undefined,
					{ includeArchived },
				);
				let threads = sessions.map(toThreadSummary);
				const current = toCurrentThreadSummary(this.runtime.session, this.runtime.cwd);
				if ((includeArchived || current.archived !== true) && !threads.some((thread) => thread.id === current.id)) {
					threads.unshift(current);
				}
				threads = threads.filter((thread) => searchMatches(thread, query));
				if (pinnedOnly) {
					threads = threads.filter((thread) => thread.pinned === true);
				}
				return success(request.id, { threads });
			}

			case "thread/start": {
				const result = await this.runtime.newSession();
				if (!result.cancelled) {
					await this.bindExtensions();
				}
				return success(request.id, {
					cancelled: result.cancelled,
					thread: toCurrentThread(this.runtime.session, this.runtime.cwd),
				});
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
				return success(request.id, {
					cancelled: result.cancelled,
					thread: toCurrentThread(this.runtime.session, this.runtime.cwd),
				});
			}

			case "thread/read":
				return success(request.id, { thread: toCurrentThread(this.runtime.session, this.runtime.cwd) });

			case "thread/status":
				return success(request.id, {
					status: getStatus(this.runtime, this.pendingApprovals.size, this.nextEventSequence),
					thread: toCurrentThreadSummary(this.runtime.session, this.runtime.cwd),
				});

			case "thread/name/set": {
				const name = getStringParam(request.params, "name");
				if (!name?.trim()) {
					return error(request.id, -32602, "thread/name/set requires a non-empty params.name");
				}
				this.runtime.session.setSessionName(name.trim());
				return success(request.id, { thread: toCurrentThread(this.runtime.session, this.runtime.cwd) });
			}

			case "thread/archive": {
				const sessionPath = getStringParam(request.params, "sessionPath");
				if (!sessionPath) {
					return error(request.id, -32602, "thread/archive requires params.sessionPath");
				}
				const archived = getBooleanParam(request.params, "archived") ?? true;

				const isActiveSession = sessionPath === this.runtime.session.sessionFile;
				const target = isActiveSession
					? this.runtime.session.sessionManager
					: SessionManager.open(sessionPath, this.runtime.session.sessionManager.getSessionDir());
				target.appendSessionInfo(undefined, { archived });
				const thread = isActiveSession
					? toCurrentThread(this.runtime.session, this.runtime.cwd)
					: toThreadFromSessionManager(target);
				this.emit("thread/archived", { sessionPath, threadId: target.getSessionId(), archived });

				if (archived && isActiveSession) {
					const result = await this.runtime.newSession();
					if (!result.cancelled) {
						await this.bindExtensions();
					}
				}

				return success(request.id, {
					archived,
					sessionPath,
					thread,
				});
			}

			case "thread/pin": {
				const sessionPath = getStringParam(request.params, "sessionPath");
				const pinned = getBooleanParam(request.params, "pinned");
				if (pinned === undefined) {
					return error(request.id, -32602, "thread/pin requires boolean params.pinned");
				}

				if (!sessionPath || sessionPath === this.runtime.session.sessionFile) {
					this.runtime.session.sessionManager.appendSessionInfo(undefined, { pinned });
					this.emit("thread/pinned", {
						sessionPath: this.runtime.session.sessionFile,
						threadId: this.runtime.session.sessionId,
						pinned,
					});
					return success(request.id, {
						pinned,
						sessionPath: this.runtime.session.sessionFile,
						thread: toCurrentThread(this.runtime.session, this.runtime.cwd),
					});
				}

				const target = SessionManager.open(sessionPath, this.runtime.session.sessionManager.getSessionDir());
				target.appendSessionInfo(undefined, { pinned });
				this.emit("thread/pinned", { sessionPath, threadId: target.getSessionId(), pinned });

				return success(request.id, {
					pinned,
					sessionPath,
					thread: {
						id: target.getSessionId(),
						path: target.getSessionFile(),
						cwd: target.getCwd(),
						name: target.getSessionName(),
						archived: target.getSessionArchived(),
						pinned: target.getSessionPinned(),
						messages: [],
					},
				});
			}

			case "turn/start": {
				const message = getStringParam(request.params, "message");
				if (!message) {
					return error(request.id, -32602, "turn/start requires params.message");
				}
				let preflightSettled = false;
				let preflightAccepted = false;
				let resolveAccepted!: () => void;
				let rejectAccepted!: (error: unknown) => void;
				const accepted = new Promise<void>((resolve, reject) => {
					resolveAccepted = resolve;
					rejectAccepted = reject;
				});
				const threadId = this.runtime.session.sessionId;
				const prompt = this.runtime.session.prompt(message, {
					source: "rpc",
					preflightResult: (success) => {
						preflightSettled = true;
						preflightAccepted = success;
						if (success) {
							resolveAccepted();
						}
					},
				});
				const trackedTurn = prompt.catch((turnError: unknown) => {
					if (!preflightSettled || !preflightAccepted) {
						rejectAccepted(turnError);
						return;
					}
					this.emit("turn/error", {
						threadId,
						message: turnError instanceof Error ? turnError.message : String(turnError),
					});
				});
				this.activeTurns.add(trackedTurn);
				void trackedTurn.finally(() => {
					this.activeTurns.delete(trackedTurn);
				});
				await accepted;
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

			case "command/list":
				return success(request.id, { commands: listCommands(this.runtime.session) });

			case "model/list": {
				const models = await this.runtime.session.modelRegistry.getAvailable();
				const currentModel = this.runtime.session.model;
				if (
					currentModel &&
					!models.some((model) => model.provider === currentModel.provider && model.id === currentModel.id)
				) {
					models.unshift(currentModel);
				}
				return success(request.id, { models });
			}

			case "model/current":
				return success(request.id, { model: toModelInfo(this.runtime.session.model) });

			case "model/set": {
				const provider = getStringParam(request.params, "provider");
				const modelId = getStringParam(request.params, "modelId");
				if (!provider || !modelId) {
					return error(request.id, -32602, "model/set requires params.provider and params.modelId");
				}

				const models = await this.runtime.session.modelRegistry.getAvailable();
				const model =
					models.find((candidate) => candidate.provider === provider && candidate.id === modelId) ??
					(modelsMatch(this.runtime.session.model, provider, modelId) ? this.runtime.session.model : undefined);
				if (!model) {
					return error(request.id, -32002, `Model not found: ${provider}/${modelId}`);
				}

				await this.runtime.session.setModel(model);
				return success(request.id, { model: toModelInfo(this.runtime.session.model) });
			}

			default:
				return error(request.id, -32601, `Unknown method: ${request.method}`);
		}
	}
}
