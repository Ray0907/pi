import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, resolve } from "node:path";

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
	token: string;
	workspaces: HostDaemonWorkspace[];
}

const DEFAULT_LISTEN = "127.0.0.1:4732";

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

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--offline") {
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

	return { listen, token, workspaces };
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

function handleRpc(request: HostDaemonRequest, options: HostDaemonOptions, server: Server): unknown {
	switch (request.method) {
		case "host/status":
			return {
				id: request.id,
				result: {
					daemon: "pi-host-daemon",
					protocolVersion: 1,
					listen: options.listen,
					workspaceCount: options.workspaces.length,
				},
			};
		case "workspace/list":
			return {
				id: request.id,
				result: {
					workspaces: options.workspaces,
				},
			};
		case "server/shutdown":
			setTimeout(() => server.close(() => process.exit(0)), 0);
			return { id: request.id, result: { shuttingDown: true } };
		default:
			return { id: request.id, error: { code: -32601, message: `Unknown method: ${request.method}` } };
	}
}

export async function runHostDaemon(args: string[], cwd = process.cwd()): Promise<never> {
	const options = parseHostDaemonOptions(args, cwd);
	let server: Server;

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
			writeJson(response, 200, handleRpc(parsed, options, server));
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

	const shutdown = () => server.close(() => process.exit(0));
	process.once("SIGTERM", shutdown);
	if (process.platform !== "win32") {
		process.once("SIGHUP", shutdown);
	}

	return new Promise(() => {});
}
