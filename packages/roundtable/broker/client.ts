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
  private connecting: Promise<void> | null = null;
  private cancelConnect: (() => void) | null = null;
  private pending = new Map<string, PendingResolver>();
  private activityListeners = new Set<(event: ActivityEvent) => void>();
  sessionId: string | null = null;

  constructor(
    readonly name: string,
    private socketPath: string = getBrokerSocketPath(),
    private requestTimeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {}

  onActivity(listener: (event: ActivityEvent) => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const attempt = this.doConnect();
    this.connecting = attempt;
    attempt.then(
      () => {
        if (this.connecting === attempt) this.connecting = null;
      },
      () => {
        if (this.connecting === attempt) this.connecting = null;
      },
    );
    return attempt;
  }

  private async doConnect(): Promise<void> {
    const socket = net.createConnection(this.socketPath);
    this.socket = socket;
    let cancelAttempt!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancelAttempt = () => reject(new Error("Roundtable connection cancelled"));
      this.cancelConnect = cancelAttempt;
    });

    const registered = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Roundtable registration timed out")), this.requestTimeoutMs);
      const reader = createMessageReader(
        (raw) => {
          const msg = raw as RoundtableBrokerMessage;
          if (msg.type === "registered" && !this.sessionId) {
            this.sessionId = msg.sessionId;
            clearTimeout(timer);
            resolve();
            return;
          }
          if (msg.type === "error" && !this.sessionId) {
            clearTimeout(timer);
            reject(new Error(msg.error));
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
        if (this.socket === socket) this.failAllPending(error);
      });
      socket.on("close", () => {
        clearTimeout(timer);
        reject(new Error("Roundtable broker connection closed"));
        if (this.socket !== socket) return;
        this.socket = null;
        this.sessionId = null;
        this.failAllPending(new Error("Roundtable broker connection closed"));
      });
    });
    // The transport connection can fail before the registration await below.
    // Mark this branch handled immediately so its parallel rejection cannot
    // become an unhandled rejection while connect() reports the socket error.
    registered.catch(() => {});

    try {
      const connected = new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          socket.off("connect", onConnect);
          socket.off("error", onError);
          socket.off("close", onClose);
        };
        const onConnect = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onClose = () => {
          cleanup();
          reject(new Error("Roundtable broker connection closed before registration"));
        };
        socket.once("connect", onConnect);
        socket.once("error", onError);
        socket.once("close", onClose);
      });
      connected.catch(() => {});
      await Promise.race([connected, cancelled]);

      this.write({ type: "register", name: this.name, pid: process.pid, cwd: process.cwd() });
      await Promise.race([registered, cancelled]);
    } catch (error) {
      socket.destroy();
      if (this.socket === socket) {
        this.socket = null;
        this.sessionId = null;
      }
      throw error;
    } finally {
      if (this.cancelConnect === cancelAttempt) this.cancelConnect = null;
    }
  }

  disconnect(): void {
    this.cancelConnect?.();
    this.cancelConnect = null;
    this.connecting = null;
    this.failAllPending(new Error("Roundtable broker connection closed"));
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
      }, this.requestTimeoutMs);
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
