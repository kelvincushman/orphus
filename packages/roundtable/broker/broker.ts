import net from "net";
import { mkdirSync, unlinkSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { createMessageReader, writeMessage } from "./framing.ts";
import { getBrokerPidPath, getBrokerSocketPath, getRoundtableDirPath } from "./paths.ts";
import { RoomStore } from "./room-store.ts";
import type { RoundtableBrokerMessage, RoundtableClientMessage } from "../types.ts";

interface ConnectedSession {
  id: string;
  name: string;
  pid: number;
  cwd: string;
  socket: net.Socket;
}

const SHUTDOWN_GRACE_MS = 5000;

/**
 * The roundtable broker: a small room server over a local socket.
 * One per machine (per agent dir), auto-spawned on first use, exits when idle.
 */
export class RoundtableBroker {
  private sessions = new Map<string, ConnectedSession>();
  private store = new RoomStore();
  private server: net.Server;
  private shutdownTimer: NodeJS.Timeout | null = null;

  constructor(
    private socketPath: string = getBrokerSocketPath(),
    private pidPath: string = getBrokerPidPath(),
    private dirPath: string = getRoundtableDirPath(),
  ) {
    mkdirSync(this.dirPath, { recursive: true });
    if (process.platform !== "win32") {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // A clean startup has no stale socket to remove.
      }
    }
    this.server = net.createServer(this.handleConnection.bind(this));
  }

  start(onListening?: () => void): void {
    this.server.listen(this.socketPath, () => {
      writeFileSync(this.pidPath, String(process.pid));
      onListening?.();
    });
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  shutdown(): void {
    for (const session of this.sessions.values()) session.socket.destroy();
    this.sessions.clear();
    this.server.close();
    if (process.platform !== "win32") {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Already removed.
      }
    }
    try {
      unlinkSync(this.pidPath);
    } catch {
      // Already removed.
    }
  }

  private scheduleShutdownCheck(): void {
    if (this.shutdownTimer) return;
    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null;
      if (this.sessions.size === 0) {
        this.shutdown();
        process.exit(0);
      }
    }, SHUTDOWN_GRACE_MS);
  }

  private handleConnection(socket: net.Socket): void {
    let sessionId: string | null = null;

    const reader = createMessageReader(
      (msg) => {
        sessionId = this.handleMessage(socket, msg as RoundtableClientMessage, sessionId);
      },
      (error) => {
        socket.destroy(error);
      },
    );

    socket.on("data", reader);
    socket.on("close", () => {
      if (!sessionId) return;
      this.sessions.delete(sessionId);
      const left = this.store.evictSession(sessionId);
      for (const room of left) {
        this.notifyRoom(room, { type: "activity", room, from: "(left)", seq: 0 }, sessionId);
      }
      this.scheduleShutdownCheck();
    });
    socket.on("error", () => {
      // close handler does the cleanup.
    });
  }

  private send(socket: net.Socket, msg: RoundtableBrokerMessage): void {
    writeMessage(socket, msg);
  }

  private notifyRoom(room: string, msg: RoundtableBrokerMessage, exceptSessionId?: string): void {
    for (const memberId of this.store.memberSessionIds(room)) {
      if (memberId === exceptSessionId) continue;
      const member = this.sessions.get(memberId);
      if (member) this.send(member.socket, msg);
    }
  }

  private handleMessage(
    socket: net.Socket,
    msg: RoundtableClientMessage,
    sessionId: string | null,
  ): string | null {
    if (msg.type === "register") {
      const id = randomUUID();
      this.sessions.set(id, { id, name: msg.name, pid: msg.pid, cwd: msg.cwd, socket });
      this.send(socket, { type: "registered", sessionId: id });
      return id;
    }

    if (!sessionId) {
      this.send(socket, { type: "error", error: "Register before sending requests" });
      return sessionId;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.send(socket, { type: "error", error: "Unknown session" });
      return sessionId;
    }

    try {
      switch (msg.type) {
        case "rooms": {
          this.send(socket, { type: "rooms", requestId: msg.requestId, rooms: this.store.listRooms() });
          break;
        }
        case "join": {
          const { room, cursor } = this.store.join(msg.room, { sessionId, name: session.name }, msg.topic);
          this.send(socket, { type: "joined", requestId: msg.requestId, room, cursor });
          this.notifyRoom(msg.room, { type: "activity", room: msg.room, from: session.name, seq: room.lastSeq }, sessionId);
          break;
        }
        case "leave": {
          this.store.leave(msg.room, sessionId);
          this.send(socket, { type: "left", requestId: msg.requestId, room: msg.room });
          break;
        }
        case "post": {
          const message = this.store.post(msg.room, { sessionId, name: session.name }, msg.text, msg.replyTo);
          this.send(socket, { type: "posted", requestId: msg.requestId, message });
          this.notifyRoom(msg.room, { type: "activity", room: msg.room, from: session.name, seq: message.seq }, sessionId);
          break;
        }
        case "fetch": {
          const { messages, lastSeq } = this.store.fetch(msg.room, msg.afterSeq, msg.limit);
          const cursor = this.store.getCursor(msg.room, session.name);
          this.send(socket, { type: "messages", requestId: msg.requestId, room: msg.room, messages, lastSeq, cursor });
          break;
        }
        case "set_cursor": {
          const seq = this.store.setCursor(msg.room, session.name, msg.seq);
          this.send(socket, { type: "cursor_set", requestId: msg.requestId, room: msg.room, seq });
          break;
        }
        default: {
          this.send(socket, { type: "error", error: `Unknown message type: ${(msg as { type?: string }).type ?? "?"}` });
        }
      }
    } catch (error) {
      const requestId = "requestId" in msg ? msg.requestId : undefined;
      this.send(socket, {
        type: "error",
        ...(requestId !== undefined ? { requestId } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return sessionId;
  }
}
