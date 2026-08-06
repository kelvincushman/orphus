import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureBrokerRunning } from "../../packages/roundtable/broker/spawn.ts";

describe("roundtable broker spawning", () => {
	it.skipIf(process.platform === "win32")(
		"reports an early broker exit instead of waiting for the startup timeout",
		async () => {
			const invalidSocketPath = join(tmpdir(), `orphus-${"x".repeat(200)}.sock`);
			await expect(ensureBrokerRunning(invalidSocketPath)).rejects.toThrow(
				/exited before becoming reachable.*code 1/,
			);
		},
	);
});
