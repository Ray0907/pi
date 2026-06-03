import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { flushRawStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../rpc/jsonl.ts";
import { AppServerProtocol } from "./app-server-protocol.ts";
import type { AppServerRequest, AppServerResponse } from "./app-server-types.ts";

function parseRequest(value: unknown): AppServerRequest {
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

function parseErrorResponse(message: string): AppServerResponse {
	return { id: undefined, error: { code: -32700, message } };
}

export async function runAppServerMode(runtime: AgentSessionRuntime): Promise<never> {
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];
	const output = (obj: AppServerResponse | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};
	const protocol = new AppServerProtocol(runtime, output);

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	let detachInput = () => {};

	async function shutdown(exitCode = 0, signal?: NodeJS.Signals): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		protocol.dispose();
		await runtime.dispose();
		detachInput();
		process.stdin.pause();
		if (signal !== "SIGTERM") {
			await flushRawStdout();
		}
		process.exit(exitCode);
	}

	let inputTail = Promise.resolve();

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
			const request = parseRequest(parsed);
			output(await protocol.handleRequest(request));
		} catch (inputError: unknown) {
			output(parseErrorResponse(inputError instanceof Error ? inputError.message : String(inputError)));
		}
		await waitForRawStdoutBackpressure();
	};

	const onInputEnd = () => {
		void inputTail.then(() => shutdown());
	};
	process.stdin.on("end", onInputEnd);

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			inputTail = inputTail.then(() => handleInputLine(line));
			void inputTail.catch(() => {});
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();
	registerSignalHandlers();

	return new Promise(() => {});
}
