import { randomUUID } from "crypto";
import type { RoomInfo, RoomMember, RoomMessage } from "../types.ts";

/** Per-room message cap; older messages are dropped ring-buffer style. */
export const DEFAULT_ROOM_CAPACITY = 500;

interface RoomState {
  name: string;
  topic?: string;
  members: Map<string, RoomMember>; // keyed by sessionId
  messages: RoomMessage[];
  nextSeq: number;
  lastActivity: number;
  /** Read cursors keyed by member NAME so they survive reconnects. */
  cursors: Map<string, number>;
}

/**
 * Pure in-memory room state: join/leave/post/fetch and read cursors.
 * No sockets — the broker wires this to the wire protocol, tests hit it directly.
 */
export class RoomStore {
  private rooms = new Map<string, RoomState>();

  constructor(private capacity: number = DEFAULT_ROOM_CAPACITY) {}

  private roomInfo(state: RoomState): RoomInfo {
    return {
      name: state.name,
      ...(state.topic !== undefined ? { topic: state.topic } : {}),
      members: [...state.members.values()],
      messageCount: state.messages.length,
      lastSeq: state.nextSeq - 1,
      lastActivity: state.lastActivity,
    };
  }

  listRooms(): RoomInfo[] {
    return [...this.rooms.values()].map((state) => this.roomInfo(state));
  }

  getRoom(room: string): RoomInfo | undefined {
    const state = this.rooms.get(room);
    return state ? this.roomInfo(state) : undefined;
  }

  /** Sessions (by id) that should be notified about activity in a room. */
  memberSessionIds(room: string): string[] {
    const state = this.rooms.get(room);
    return state ? [...state.members.keys()] : [];
  }

  join(room: string, member: { sessionId: string; name: string }, topic?: string): { room: RoomInfo; cursor: number } {
    let state = this.rooms.get(room);
    if (!state) {
      state = {
        name: room,
        ...(topic !== undefined ? { topic } : {}),
        members: new Map(),
        messages: [],
        nextSeq: 1,
        lastActivity: Date.now(),
        cursors: new Map(),
      };
      this.rooms.set(room, state);
    } else if (topic !== undefined && state.topic === undefined) {
      state.topic = topic;
    }
    if (!state.members.has(member.sessionId)) {
      state.members.set(member.sessionId, { ...member, joinedAt: Date.now() });
    }
    const cursor = state.cursors.get(member.name) ?? 0;
    return { room: this.roomInfo(state), cursor };
  }

  leave(room: string, sessionId: string): boolean {
    const state = this.rooms.get(room);
    if (!state) return false;
    const removed = state.members.delete(sessionId);
    if (state.members.size === 0 && state.messages.length === 0) {
      this.rooms.delete(room);
    }
    return removed;
  }

  /** Remove a disconnecting session from every room. Returns rooms it left. */
  evictSession(sessionId: string): string[] {
    const left: string[] = [];
    for (const [name, state] of this.rooms) {
      if (state.members.delete(sessionId)) left.push(name);
    }
    return left;
  }

  post(
    room: string,
    from: { sessionId: string; name: string },
    text: string,
    replyTo?: string,
  ): RoomMessage {
    const state = this.rooms.get(room);
    if (!state) throw new Error(`Room "${room}" does not exist; join it first`);
    if (!state.members.has(from.sessionId)) throw new Error(`Not a member of room "${room}"; join it first`);
    const message: RoomMessage = {
      id: randomUUID(),
      seq: state.nextSeq++,
      timestamp: Date.now(),
      room,
      from: { ...from },
      text,
      ...(replyTo !== undefined ? { replyTo } : {}),
    };
    state.messages.push(message);
    if (state.messages.length > this.capacity) {
      state.messages.splice(0, state.messages.length - this.capacity);
    }
    state.lastActivity = message.timestamp;
    // The author has read their own message.
    const authorCursor = state.cursors.get(from.name) ?? 0;
    if (message.seq > authorCursor) state.cursors.set(from.name, message.seq);
    return message;
  }

  /** Messages with seq > afterSeq, ascending, capped at limit. */
  fetch(room: string, afterSeq: number, limit = 200): { messages: RoomMessage[]; lastSeq: number } {
    const state = this.rooms.get(room);
    if (!state) throw new Error(`Room "${room}" does not exist`);
    const messages = state.messages.filter((m) => m.seq > afterSeq).slice(0, Math.max(1, limit));
    return { messages, lastSeq: state.nextSeq - 1 };
  }

  getCursor(room: string, memberName: string): number {
    return this.rooms.get(room)?.cursors.get(memberName) ?? 0;
  }

  setCursor(room: string, memberName: string, seq: number): number {
    const state = this.rooms.get(room);
    if (!state) throw new Error(`Room "${room}" does not exist`);
    const current = state.cursors.get(memberName) ?? 0;
    const next = Math.max(current, Math.min(seq, state.nextSeq - 1));
    state.cursors.set(memberName, next);
    return next;
  }
}
