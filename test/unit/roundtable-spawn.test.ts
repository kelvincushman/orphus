import { describe, expect, it } from "vitest";
import { ensureBrokerRunning } from "../../packages/roundtable/broker/spawn.ts";

describe("roundtable broker spawning", () => {
	it.skipIf(process.platform === "win32")(
		"reports an early broker exit instead of waiting for the startup timeout",
		async () => {
			// /dev/null is a file on Unix, so it cannot become a socket's parent
			// directory. This forces the child to exit before it can listen.
			const invalidSocketPath = "/dev/null/orphus-roundtable.sock";
			await expect(ensureBrokerRunning(invalidSocketPath)).rejects.toThrow(
				/exited before becoming reachable.*code 1/,
			);
		},
	);
});
