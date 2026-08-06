import { describe, expect, it } from "vitest";
import { createMessageReader, MAX_MESSAGE_BYTES, writeMessage } from "../../packages/roundtable/broker/framing.ts";

describe("roundtable framing", () => {
	it("rejects an oversized declared inbound frame before buffering its payload", () => {
		const errors: Error[] = [];
		const header = Buffer.alloc(4);
		header.writeUInt32BE(MAX_MESSAGE_BYTES + 1);
		const read = createMessageReader(
			() => {
				throw new Error("oversized frame must not be delivered");
			},
			(error) => errors.push(error),
		);

		read(header);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toMatch(/message too large/);
	});

	it("rejects oversized outbound frames", () => {
		const socket = { write: () => true } as unknown as Parameters<typeof writeMessage>[0];
		expect(() => writeMessage(socket, { text: "x".repeat(MAX_MESSAGE_BYTES) })).toThrow(/message too large/);
	});
});
