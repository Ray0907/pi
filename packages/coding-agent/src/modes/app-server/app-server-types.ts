import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type AppServerRequestId = string | number | null;

export interface AppServerRequest {
	id?: AppServerRequestId;
	method: string;
	params?: unknown;
}

export type AppServerResponse =
	| { id: AppServerRequestId | undefined; result: unknown }
	| { id: AppServerRequestId | undefined; error: { code: number; message: string } };

export interface AppServerNotification {
	method: string;
	params: Record<string, unknown>;
}

export interface AppServerRecordedEvent extends AppServerNotification {
	sequence: number;
	timestamp: string;
}

export interface AppServerInitializeResult {
	protocolVersion: 2;
	serverInfo: {
		name: "pi-app-server";
		version: 2;
	};
	capabilities: {
		threads: true;
		turns: true;
		models: true;
		tools: true;
		diffs: true;
		approvals: true;
		methods: string[];
		notifications: string[];
	};
}

export interface AppServerThreadSummary {
	id: string;
	path?: string;
	cwd: string;
	name?: string;
	archived?: boolean;
	pinned?: boolean;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
}

export interface AppServerThread {
	id: string;
	path?: string;
	cwd: string;
	name?: string;
	archived?: boolean;
	pinned?: boolean;
	messages: AgentMessage[];
}

export interface AppServerStatus {
	cwd: string;
	threadId: string;
	sessionPath?: string;
	running: boolean;
	activeTurnId?: string;
	activeTurnStartedAt?: string;
	lastActivityAt?: string;
	pendingApprovalCount: number;
	eventSequence: number;
}

export interface AppServerCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	sourceInfo?: unknown;
}
