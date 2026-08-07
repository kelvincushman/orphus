import net from "net";
import { randomUUID } from "crypto";
import { createMessageReader, writeMessage } from "./framing.ts";
import { getBrokerSocketPath } from "./paths.ts";
import type {
  RoomInfo,
  RoomMessage,
  RoundtableBrokerMessage,
  RoundtableClientMessage,
} from "../types.ts";

export interface ActivityEvent {
  room: string;
  from: string;
  seq: number;
}

type PendingResolver = {
  resolve: (msg: RoundtableBrokerMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const REQUEST_TIMEOUT_MS = 10_000;

/** Promise-based roundtable broker client with a tiny activity event stream. */
export class RoundtableClient {
  private socket: net.Socket | null = null;
  private pending = new Map<string, PendingResolver>();
  private activityListeners = new Set<(event: ActivityEvent) => void>();
  sessionId: string | null = null;

  constructor(
    readonly name: string,
    private socketPath: string = getBrokerSocketPath(),
  ) {}

  onActivity(listener: (event: ActivityEvent) => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  async connect(): Promise<void> {
    if (this.socket) return;
    const socket = net.createConnection(this.socketPath);
    this.socket = socket;

    const registered = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Roundtable registration timed out")), REQUEST_TIMEOUT_MS);
      const reader = createMessageReader(
        (raw) => {
          const msg = raw as RoundtableBrokerMessage;
          if (msg.type === "registered" && !this.sessionId) {
            this.sessionId = msg.sessionId;
            clearTimeout(timer);
            resolve();
            return;
          }
          this.dispatch(msg);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
          socket.destroy();
        },
      );
      socket.on("data", reader);
      socket.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
        this.failAllPending(error);
      });
      socket.on("close", () => {
        this.socket = null;
        this.sessionId = null;
        this.failAllPending(new Error("Roundtable broker connection closed"));
      });
    });
    // If the connect below fails we unwind before awaiting `registered`, leaving it
    // rejected with no handler — an unhandled rejection that exits the process under
    // Node. A no-op catch keeps it handled; the real error still surfaces at line 86.
    void registered.catch(() => {});

    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    this.write({ type: "register", name: this.name, pid: process.pid, cwd: process.cwd() });
    await registered;
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
    this.sessionId = null;
  }

  get connected(): boolean {
    return this.socket !== null && this.sessionId !== null;
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private dispatch(msg: RoundtableBrokerMessage): void {
    if (msg.type === "activity") {
      for (const listener of this.activityListeners) listener(msg);
      return;
    }
    const requestId = "requestId" in msg ? msg.requestId : undefined;
    if (!requestId) return;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (msg.type === "error") {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(msg);
    }
  }

  private write(msg: RoundtableClientMessage): void {
    if (!this.socket) throw new Error("Not connected to roundtable broker");
    writeMessage(this.socket, msg);
  }

  private request<T extends RoundtableBrokerMessage["type"]>(
    build: (requestId: string) => RoundtableClientMessage,
    expected: T,
  ): Promise<Extract<RoundtableBrokerMessage, { type: T }>> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Roundtable request timed out"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, {
        resolve: (msg) => {
          if (msg.type === expected) {
            resolve(msg as Extract<RoundtableBrokerMessage, { type: T }>);
          } else {
            reject(new Error(`Unexpected broker response: ${msg.type}`));
          }
        },
        reject,
        timer,
      });
      try {
        this.write(build(requestId));
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async listRooms(): Promise<RoomInfo[]> {
    const response = await this.request((requestId) => ({ type: "rooms", requestId }), "rooms");
    return response.rooms;
  }

  async join(room: string, topic?: string): Promise<{ room: RoomInfo; cursor: number }> {
    const response = await this.request(
      (requestId) => ({ type: "join", requestId, room, ...(topic !== undefined ? { topic } : {}) }),
      "joined",
    );
    return { room: response.room, cursor: response.cursor };
  }

  async leave(room: string): Promise<void> {
    await this.request((requestId) => ({ type: "leave", requestId, room }), "left");
  }

  async post(room: string, text: string, replyTo?: string): Promise<RoomMessage> {
    const response = await this.request(
      (requestId) => ({ type: "post", requestId, room, text, ...(replyTo !== undefined ? { replyTo } : {}) }),
      "posted",
    );
    return response.message;
  }

  async fetch(room: string, afterSeq: number, limit?: number): Promise<{ messages: RoomMessage[]; lastSeq: number; cursor: number }> {
    const response = await this.request(
      (requestId) => ({ type: "fetch", requestId, room, afterSeq, ...(limit !== undefined ? { limit } : {}) }),
      "messages",
    );
    return { messages: response.messages, lastSeq: response.lastSeq, cursor: response.cursor };
  }

  async setCursor(room: string, seq: number): Promise<number> {
    const response = await this.request((requestId) => ({ type: "set_cursor", requestId, room, seq }), "cursor_set");
    return response.seq;
  }
}
