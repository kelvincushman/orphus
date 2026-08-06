import net from "net";
import { mkdirSync, unlinkSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { dirname } from "path";
import { createMessageReader, writeMessage } from "./framing.ts";
import { getBrokerPidPath, getBrokerSocketPath, getRoundtableDirPath } from "./paths.ts";
import { RoomStore } from "./room-store.ts";
import { MAX_MEMBER_NAME_CHARS, type RoundtableBrokerMessage, type RoundtableClientMessage } from "../types.ts";

interface ConnectedSession {
  id: string;
  name: string;
  pid: number;
  cwd: string;
  socket: net.Socket;
}

const SHUTDOWN_GRACE_MS = 5000;
const PROBE_TIMEOUT_MS = 1000;

type SocketProbe = "live" | "missing" | "stale";

function probeSocket(socketPath: string): Promise<SocketProbe> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (result: SocketProbe | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(() => finish("live"), PROBE_TIMEOUT_MS);
    socket.once("connect", () => {
      finish("live");
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        finish("missing");
      } else if (error.code === "ECONNREFUSED") {
        finish("stale");
      } else {
        finish(error);
      }
    });
  });
}

/**
 * The roundtable broker: a small room server over a local socket.
 * One per machine (per agent dir), auto-spawned on first use, exits when idle.
 */
export class RoundtableBroker {
  private sessions = new Map<string, ConnectedSession>();
  private store = new RoomStore();
  private server: net.Server;
  private shutdownTimer: NodeJS.Timeout | null = null;
  private ownsSocket = false;
  private shuttingDown = false;
  private readonly handleSignal = () => this.shutdown();
  private readonly handleServerError = (error: Error) => {
    if (!this.shuttingDown) console.error(`Roundtable broker server error: ${error.message}`);
  };

  constructor(
    private socketPath: string = getBrokerSocketPath(),
    private pidPath: string = getBrokerPidPath(),
    private dirPath: string = getRoundtableDirPath(),
  ) {
    mkdirSync(this.dirPath, { recursive: true });
    if (process.platform !== "win32") mkdirSync(dirname(this.socketPath), { recursive: true });
    this.server = net.createServer(this.handleConnection.bind(this));
  }

  async start(onListening?: () => void): Promise<void> {
    if (process.platform !== "win32") {
      const state = await probeSocket(this.socketPath);
      if (state === "live") throw new Error(`Roundtable broker is already listening on ${this.socketPath}`);
      if (state === "stale") {
        try {
          unlinkSync(this.socketPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error) => {
        this.server.off("listening", handleListening);
        reject(new Error(`Roundtable broker failed to listen on ${this.socketPath}: ${error.message}`, { cause: error }));
      };
      const handleListening = () => {
        this.server.off("error", handleError);
        this.server.on("error", this.handleServerError);
        try {
          this.ownsSocket = true;
          writeFileSync(this.pidPath, String(process.pid));
          onListening?.();
          resolve();
        } catch (error) {
          this.shutdown();
          reject(error);
        }
      };
      this.server.once("error", handleError);
      this.server.once("listening", handleListening);
      this.server.listen(this.socketPath);
    });
    process.once("SIGTERM", this.handleSignal);
    process.once("SIGINT", this.handleSignal);
  }

  shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const ownedEndpoint = this.ownsSocket;
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
    }
    process.off("SIGTERM", this.handleSignal);
    process.off("SIGINT", this.handleSignal);
    this.server.off("error", this.handleServerError);
    for (const session of this.sessions.values()) session.socket.destroy();
    this.sessions.clear();
    if (this.server.listening) this.server.close();
    if (ownedEndpoint && process.platform !== "win32") {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Already removed.
      }
    }
    this.ownsSocket = false;
    if (ownedEndpoint) {
      try {
        unlinkSync(this.pidPath);
      } catch {
        // Already removed.
      }
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
    this.shutdownTimer.unref();
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
      if (this.shuttingDown) return;
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
      if (sessionId) {
        this.send(socket, { type: "error", error: "Session already registered on this connection" });
        return sessionId;
      }
      if (typeof msg.name !== "string" || msg.name.length === 0 || msg.name.length > MAX_MEMBER_NAME_CHARS) {
        this.send(socket, { type: "error", error: `Member names must contain 1-${MAX_MEMBER_NAME_CHARS} characters` });
        return sessionId;
      }
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
