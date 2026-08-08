import assert from "node:assert/strict";
import type { Socket } from "net";
import { describe, expect, it, vi } from "vitest";
import { createMessageReader, writeMessage } from "../../packages/roundtable/broker/framing.js";

/**
 * The wire framing: a 4-byte big-endian length followed by a JSON payload.
 *
 * Nothing imported this module in a test before. It was exercised incidentally
 * by the socket suites, which only ever send well-formed whole messages over
 * loopback — so the two behaviours that matter, reassembling a message split
 * across TCP reads and refusing a malformed one, were never actually checked.
 * The malformed path is load-bearing: the broker's onError destroys the socket,
 * so getting it wrong either drops a live session or leaves a wedged one.
 */

/** Capture what writeMessage puts on the wire, without opening a socket. */
function fakeSocket(): { socket: Socket; written: () => Buffer } {
	const chunks: Buffer[] = [];
	const socket = {
		write: (chunk: Buffer) => {
			chunks.push(chunk);
			return true;
		},
	} as unknown as Socket;
	return { socket, written: () => Buffer.concat(chunks) };
}

function frame(value: unknown): Buffer {
	const { socket, written } = fakeSocket();
	writeMessage(socket, value);
	return written();
}

describe("roundtable framing", () => {
	it("round-trips a message through its own encoder", () => {
		const messages: unknown[] = [];
		const read = createMessageReader(
			(msg) => messages.push(msg),
			() => assert.fail("unexpected error"),
		);

		read(frame({ type: "post", room: "design", text: "hello" }));

		assert.deepEqual(messages, [{ type: "post", room: "design", text: "hello" }]);
	});

	it("reassembles a message split across reads, one byte at a time", () => {
		const messages: unknown[] = [];
		const read = createMessageReader(
			(msg) => messages.push(msg),
			() => assert.fail("unexpected error"),
		);

		// The pathological split: the length header itself arrives in pieces, so a
		// reader that assumed the first chunk contained a whole header would throw
		// or mis-read the length. Loopback almost never produces this; a busy
		// socket or a large payload does.
		const message = { type: "post", room: "design", text: "x".repeat(500) };
		const encoded = frame(message);
		for (const byte of encoded) read(Buffer.from([byte]));

		assert.deepEqual(messages, [message]);
	});

	it("delivers several messages arriving in a single read, in order", () => {
		const messages: unknown[] = [];
		const read = createMessageReader(
			(msg) => messages.push(msg),
			() => assert.fail("unexpected error"),
		);

		read(Buffer.concat([frame({ seq: 1 }), frame({ seq: 2 }), frame({ seq: 3 })]));

		assert.deepEqual(messages, [{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
	});

	it("holds a partial trailing message until the rest of it arrives", () => {
		const messages: unknown[] = [];
		const read = createMessageReader(
			(msg) => messages.push(msg),
			() => assert.fail("unexpected error"),
		);

		const whole = frame({ seq: 1 });
		const trailing = frame({ seq: 2 });
		read(Buffer.concat([whole, trailing.subarray(0, 6)]));
		assert.deepEqual(messages, [{ seq: 1 }], "the complete message must not wait for its neighbour");

		read(trailing.subarray(6));
		assert.deepEqual(messages, [{ seq: 1 }, { seq: 2 }]);
	});

	// The broker's onError destroys the socket, so this path decides whether a
	// peer that sends garbage is disconnected or silently ignored.
	it("reports a malformed payload as an error and stops reading the batch", () => {
		const messages: unknown[] = [];
		const errors: Error[] = [];
		const read = createMessageReader(
			(msg) => messages.push(msg),
			(error) => errors.push(error),
		);

		const bad = Buffer.from("{not json", "utf-8");
		const header = Buffer.alloc(4);
		header.writeUInt32BE(bad.length, 0);
		// A well-formed message follows the bad one: nothing after a parse failure
		// may be delivered, because the stream's framing is no longer trustworthy.
		read(Buffer.concat([header, bad, frame({ seq: 99 })]));

		assert.equal(messages.length, 0);
		assert.equal(errors.length, 1);
		expect(errors[0]?.message).toMatch(/Failed to parse roundtable message/u);
	});

	it("reports a throwing handler as an error rather than letting it escape", () => {
		const errors: Error[] = [];
		const onMessage = vi.fn(() => {
			throw new Error("handler blew up");
		});
		const read = createMessageReader(onMessage, (error) => errors.push(error));

		// Must not throw out of the socket's data handler, where nothing catches it.
		read(Buffer.concat([frame({ seq: 1 }), frame({ seq: 2 })]));

		assert.equal(onMessage.mock.calls.length, 1, "reading stops at the first failing handler");
		assert.equal(errors.length, 1);
		expect(errors[0]?.message).toMatch(/Failed to handle roundtable message/u);
	});

	it("carries a payload larger than a single socket read", () => {
		const messages: unknown[] = [];
		const read = createMessageReader(
			(msg) => messages.push(msg),
			() => assert.fail("unexpected error"),
		);

		// Comfortably past the 64 KB a socket typically hands over at once, so the
		// reader has to buffer across several reads to see one message.
		const text = "y".repeat(200_000);
		const encoded = frame({ type: "post", text });
		for (let offset = 0; offset < encoded.length; offset += 65_536) {
			read(encoded.subarray(offset, offset + 65_536));
		}

		assert.equal(messages.length, 1);
		assert.equal((messages[0] as { text: string }).text.length, text.length);
	});
});
