/** Maximum text accepted for one room message, keeping replay pages bounded. */
export const MAX_ROOM_MESSAGE_CHARS = 4000;
export const MAX_MEMBER_NAME_CHARS = 128;
export const MAX_ROOM_NAME_CHARS = 128;
export const MAX_ROOM_TOPIC_CHARS = 1000;
export const MAX_REPLY_TO_CHARS = 128;

/** A single message posted to a roundtable room. */
export interface RoomMessage {
  /** Broker-assigned unique id. */
  id: string;
  /** Broker-assigned per-room monotonic sequence number, starting at 1. */
  seq: number;
  timestamp: number;
  room: string;
  from: {
    sessionId: string;
    /** Stable member name (survives reconnects); cursors are keyed by this. */
    name: string;
  };
  text: string;
  /** Message id this replies to, for threading. */
  replyTo?: string;
}

export interface RoomMember {
  sessionId: string;
  name: string;
  joinedAt: number;
}

export interface RoomInfo {
  name: string;
  topic?: string;
  members: RoomMember[];
  messageCount: number;
  /** Highest sequence number in the room; 0 when empty. */
  lastSeq: number;
  lastActivity: number;
}

/** Client → broker protocol. */
export type RoundtableClientMessage =
  | { type: "register"; name: string; pid: number; cwd: string }
  | { type: "rooms"; requestId: string }
  | { type: "join"; requestId: string; room: string; topic?: string }
  | { type: "leave"; requestId: string; room: string }
  | { type: "post"; requestId: string; room: string; text: string; replyTo?: string }
  | { type: "fetch"; requestId: string; room: string; afterSeq: number; limit?: number }
  | { type: "set_cursor"; requestId: string; room: string; seq: number };

/** Broker → client protocol. */
export type RoundtableBrokerMessage =
  | { type: "registered"; sessionId: string }
  | { type: "rooms"; requestId: string; rooms: RoomInfo[] }
  | { type: "joined"; requestId: string; room: RoomInfo; cursor: number }
  | { type: "left"; requestId: string; room: string }
  | { type: "posted"; requestId: string; message: RoomMessage }
  | { type: "messages"; requestId: string; room: string; messages: RoomMessage[]; lastSeq: number; cursor: number }
  | { type: "cursor_set"; requestId: string; room: string; seq: number }
  /** Push notification: something happened in a room you belong to. Intentionally tiny. */
  | { type: "activity"; room: string; from: string; seq: number }
  | { type: "error"; requestId?: string; error: string };
