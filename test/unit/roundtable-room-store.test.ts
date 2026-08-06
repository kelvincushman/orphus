import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES } from "../../packages/roundtable/broker/framing.ts";
import { RoomStore } from "../../packages/roundtable/broker/room-store.ts";
import { MAX_ROOM_MESSAGE_CHARS } from "../../packages/roundtable/types.ts";

const alice = { sessionId: "s-alice", name: "alice" };
const bob = { sessionId: "s-bob", name: "bob" };

describe("roundtable room store", () => {
	it("creates a room on first join and tracks members", () => {
		const store = new RoomStore();
		const { room, cursor } = store.join("design", alice, "topic");
		expect(room.name).toBe("design");
		expect(room.topic).toBe("topic");
		expect(room.members).toHaveLength(1);
		expect(cursor).toBe(0);
	});

	it("assigns monotonic per-room sequence numbers", () => {
		const store = new RoomStore();
		store.join("design", alice);
		store.join("design", bob);
		const first = store.post("design", alice, "one");
		const second = store.post("design", bob, "two");
		expect(first.seq).toBe(1);
		expect(second.seq).toBe(2);
	});

	it("rejects oversized posts before committing them", () => {
		const store = new RoomStore();
		store.join("design", alice);
		expect(() => store.post("design", alice, "x".repeat(MAX_ROOM_MESSAGE_CHARS + 1))).toThrow(/cannot exceed/);
		expect(store.fetch("design", 0)).toEqual({ messages: [], lastSeq: 0 });
	});

	it("keeps a maximum fetch response within the transport frame bound", () => {
		const store = new RoomStore();
		store.join("design", alice);
		for (let index = 0; index < 200; index++) {
			store.post("design", alice, "x".repeat(MAX_ROOM_MESSAGE_CHARS));
		}
		const response = { type: "messages", requestId: "request", room: "design", ...store.fetch("design", 0) };
		expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThan(MAX_MESSAGE_BYTES);
	});

	it("rejects posts from non-members", () => {
		const store = new RoomStore();
		store.join("design", alice);
		expect(() => store.post("design", bob, "hi")).toThrow(/join it first/);
	});

	it("fetch returns only messages after the given seq", () => {
		const store = new RoomStore();
		store.join("design", alice);
		store.post("design", alice, "one");
		store.post("design", alice, "two");
		store.post("design", alice, "three");
		const { messages, lastSeq } = store.fetch("design", 1);
		expect(messages.map((m) => m.text)).toEqual(["two", "three"]);
		expect(lastSeq).toBe(3);
	});

	it("honors a zero fetch limit and rejects invalid limits", () => {
		const store = new RoomStore();
		store.join("design", alice);
		store.post("design", alice, "one");
		expect(store.fetch("design", 0, 0).messages).toEqual([]);
		expect(() => store.fetch("design", 0, -1)).toThrow(/non-negative safe integer/);
		expect(() => store.fetch("design", 0, 1.5)).toThrow(/non-negative safe integer/);
	});

	it("keeps cursors per member name and marks own posts read", () => {
		const store = new RoomStore();
		store.join("design", alice);
		store.join("design", bob);
		store.post("design", alice, "from alice");
		expect(store.getCursor("design", "alice")).toBe(1);
		expect(store.getCursor("design", "bob")).toBe(0);
		store.setCursor("design", "bob", 1);
		expect(store.getCursor("design", "bob")).toBe(1);
	});

	it("cursor survives reconnect because it is keyed by name", () => {
		const store = new RoomStore();
		store.join("design", alice);
		store.post("design", alice, "one");
		store.evictSession(alice.sessionId);
		const rejoined = store.join("design", { sessionId: "s-alice-2", name: "alice" });
		expect(rejoined.cursor).toBe(1);
	});

	it("cursor cannot exceed lastSeq or move backwards", () => {
		const store = new RoomStore();
		store.join("design", alice);
		store.post("design", alice, "one");
		expect(store.setCursor("design", "alice", 99)).toBe(1);
		expect(store.setCursor("design", "alice", 0)).toBe(1);
	});

	it("drops oldest messages beyond capacity ring-buffer style", () => {
		const store = new RoomStore(3);
		store.join("design", alice);
		for (let i = 1; i <= 5; i++) store.post("design", alice, `msg ${i}`);
		const { messages } = store.fetch("design", 0);
		expect(messages.map((m) => m.text)).toEqual(["msg 3", "msg 4", "msg 5"]);
	});

	it("evicts a session from all rooms on disconnect", () => {
		const store = new RoomStore();
		store.join("design", alice);
		store.join("infra", alice);
		store.post("design", alice, "keep room alive");
		const left = store.evictSession(alice.sessionId);
		expect(left.sort()).toEqual(["design", "infra"]);
		expect(store.getRoom("design")?.members).toEqual([]);
		expect(store.getRoom("infra")).toBeUndefined();
	});
});
