import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
});
