import assert from "node:assert/strict";
import { test } from "vitest";
import { macosKeychain } from "../../packages/web-access/vault/keychain.js";

function fakeRun() {
	const store = new Map<string, string>();
	const calls: string[] = [];
	const run = async (cmd: string, args: string[], stdin?: string) => {
		calls.push([cmd, ...args].join(" "));
		const acct = args[args.indexOf("-a") + 1];
		if (args.includes("add-generic-password")) {
			store.set(acct, stdin ?? args[args.indexOf("-w") + 1]);
			return { stdout: "", code: 0 };
		}
		if (args.includes("find-generic-password")) {
			const v = store.get(acct);
			return v ? { stdout: v, code: 0 } : { stdout: "", code: 44 };
		}
		if (args.includes("delete-generic-password")) {
			store.delete(acct);
			return { stdout: "", code: 0 };
		}
		return { stdout: "", code: 1 };
	};
	return { run, store, calls };
}

test("store then lookup round-trips with correct secret transmission", async () => {
	const f = fakeRun();
	const kc = macosKeychain(f.run);
	await kc.store("example.com", "hunter2");
	assert.equal(await kc.lookup("example.com"), "hunter2");
	assert.ok(
		f.calls.some((c) => c.includes("add-generic-password") && c.includes("hunter2")),
		"macOS store must transmit the secret via -w",
	);
	assert.ok(
		!f.calls.some((c) => c.includes("find-generic-password") && c.includes("hunter2")),
		"secret must not appear in lookup argv",
	);
});

test("lookup returns null when absent", async () => {
	const kc = macosKeychain(fakeRun().run);
	assert.equal(await kc.lookup("nope"), null);
});
