import { runBunSubprocess } from "../subprocess.js";

export interface SecretBackend {
	store(id: string, secret: string): Promise<void>;
	lookup(id: string): Promise<string | null>;
	remove(id: string): Promise<void>;
}
export type RunFn = (cmd: string, args: string[], stdin?: string) => Promise<{ stdout: string; code: number }>;
export const SERVICE = "orphus-web-vault";

const defaultRun: RunFn = async (cmd, args, stdin) => {
	const r = await runBunSubprocess(cmd, args, { timeoutMs: 5000, maxStdoutBytes: 64 * 1024 }).catch((e: unknown) => {
		const code = Number((e as { code?: string }).code);
		return { exitCode: Number.isFinite(code) ? code : 1, stdout: Buffer.from(""), stderr: "" };
	});
	void stdin;
	return { stdout: r.stdout.toString("utf8").replace(/\n$/, ""), code: r.exitCode };
};

export function macosKeychain(run: RunFn = defaultRun): SecretBackend {
	return {
		async store(id, secret) {
			await run("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", id, "-w", secret]);
		},
		async lookup(id) {
			const r = await run("security", ["find-generic-password", "-s", SERVICE, "-a", id, "-w"]);
			return r.code === 0 ? r.stdout : null;
		},
		async remove(id) { await run("security", ["delete-generic-password", "-s", SERVICE, "-a", id]); },
	};
}

export function linuxSecretTool(run: RunFn = defaultRun): SecretBackend {
	const attrs = (id: string) => ["service", SERVICE, "account", id];
	return {
		async store(id, secret) { await run("secret-tool", ["store", "--label", SERVICE, ...attrs(id)], secret); },
		async lookup(id) { const r = await run("secret-tool", ["lookup", ...attrs(id)]); return r.code === 0 && r.stdout ? r.stdout : null; },
		async remove(id) { await run("secret-tool", ["clear", ...attrs(id)]); },
	};
}
