import net from "net";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { createMessageReader, writeMessage } from "./framing.ts";
import { getBrokerPidPath, getBrokerSocketPath, getRoundtableDirPath } from "./paths.ts";
import { RoomStore } from "./room-store.ts";
import { canConnect } from "./socket-probe.ts";
import type { RoundtableBrokerMessage, RoundtableClientMessage } from "../types.ts";

interface ConnectedSession {
  id: string;
  name: string;
  pid: number;
  cwd: string;
  socket: net.Socket;
}

export interface BrokerOptions {
  /**
   * Exit the process once the broker has been idle for the grace period.
   *
   * Only the broker that owns its process (broker/main.ts) may do this. A broker
   * embedded in a test or in the demo shares the process with its host, so
   * exiting would take the host down with it.
   */
  exitWhenIdle?: boolean;
  /**
   * How long the last session may stay away before the broker gives up on it.
   *
   * The default suits a real fleet, where a session reconnecting between tool
   * calls is routine. Lifecycle tests set it low so they assert on the timer
   * actually firing rather than on a five-second wait.
   */
  idleGraceMs?: number;
}

const SHUTDOWN_GRACE_MS = 5000;
const STARTUP_LOCK_RETRY_MS = 25;
const STARTUP_LOCK_TIMEOUT_MS = 5000;

export class BrokerAlreadyRunningError extends Error {
  constructor(socketPath: string) {
    super(`Another roundtable broker is already listening on ${socketPath}`);
    this.name = "BrokerAlreadyRunningError";
  }
}

type ReleaseStartupLock = () => void;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireStartupLock(lockPath: string): Promise<ReleaseStartupLock> {
  const token = randomUUID();
  const deadline = Date.now() + STARTUP_LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: string };
          if (owner.token === token) unlinkSync(lockPath);
        } catch {
          // The lock was already reclaimed or removed.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let ownerPid: number | undefined;
    try {
      ownerPid = (JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number }).pid;
    } catch {
      // A process may still be between the exclusive create and metadata write.
    }
    if (typeof ownerPid === "number" && !processIsAlive(ownerPid)) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Another contender reclaimed it first.
      }
      continue;
    }
    await sleep(STARTUP_LOCK_RETRY_MS);
  }

  throw new Error(`Timed out acquiring roundtable broker startup lock ${lockPath}`);
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
  private signalHandlersRegistered = false;
  private readonly handleSignal = () => this.shutdown();

  constructor(
    private socketPath: string = getBrokerSocketPath(),
    private pidPath: string = getBrokerPidPath(),
    private dirPath: string = getRoundtableDirPath(),
    private options: BrokerOptions = {},
  ) {
    mkdirSync(this.dirPath, { recursive: true });
    this.server = net.createServer(this.handleConnection.bind(this));
  }

  /**
   * Bind the socket.
   *
   * `onLost` is called instead of `onListening` when another broker already owns
   * the path. That is a normal outcome, not a failure: `orphus-roles --format
   * tmux | sh` starts several sessions at once and each one calls
   * `ensureBrokerRunning`, so losing the race is the common case for all but the
   * first. The loser must leave the winner's socket alone — unlinking it is what
   * used to split the fleet across two brokers with disjoint room state, each
   * invisible to the other.
   */
  start(onListening?: () => void, onLost?: (reason: Error) => void): void {
    void this.listenWhenPathIsFree(onListening, onLost);
    if (this.options.exitWhenIdle && !this.signalHandlersRegistered) {
      process.on("SIGTERM", this.handleSignal);
      process.on("SIGINT", this.handleSignal);
      this.signalHandlersRegistered = true;
    }
  }

  private async listenWhenPathIsFree(onListening?: () => void, onLost?: (reason: Error) => void): Promise<void> {
    let releaseLock: ReleaseStartupLock;
    try {
      releaseLock = await acquireStartupLock(`${this.pidPath}.startup.lock`);
      // Windows named pipes are not filesystem entries and leave nothing stale.
      if (process.platform !== "win32" && existsSync(this.socketPath)) {
        if (await canConnect(this.socketPath)) {
          releaseLock();
          onLost?.(new BrokerAlreadyRunningError(this.socketPath));
          return;
        }
        try {
          unlinkSync(this.socketPath);
        } catch {
          // A stale path may disappear between the probe and cleanup.
        }
      }
    } catch (error) {
      onLost?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const onError = (error: NodeJS.ErrnoException) => {
      releaseLock();
      onLost?.(error.code === "EADDRINUSE" ? new BrokerAlreadyRunningError(this.socketPath) : error);
    };
    this.server.once("error", onError);
    this.server.listen(this.socketPath, () => {
      this.server.off("error", onError);
      this.ownsSocket = true;
      // Diagnostic only — `ps` against a broker whose socket looks wedged. It is
      // deliberately not a lock: pids are reused, and a lock file cannot say
      // whether the holder is still serving. The socket answers that directly,
      // so the socket is the lock.
      try {
        writeFileSync(this.pidPath, String(process.pid));
      } catch {
        // Serving the socket is authoritative; the pid file is diagnostic only.
      }
      releaseLock();
      onListening?.();
    });
  }

  shutdown(): void {
    if (this.signalHandlersRegistered) {
      process.off("SIGTERM", this.handleSignal);
      process.off("SIGINT", this.handleSignal);
      this.signalHandlersRegistered = false;
    }
    // An idle check armed by the last disconnect outlives shutdown() otherwise,
    // and fires into a broker that is already closed — with sessions cleared
    // below, its emptiness test passes and it exits the process. In a vitest
    // worker that is a silent exit code 0 five seconds after the suite moved on.
    if (this.shutdownTimer) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
    }
    for (const session of this.sessions.values()) session.socket.destroy();
    this.sessions.clear();
    if (this.server.listening) this.server.close();
    if (this.ownsSocket && process.platform !== "win32") {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Already removed.
      }
    }
    if (this.ownsSocket) {
      try {
        unlinkSync(this.pidPath);
      } catch {
        // Already removed.
      }
      this.ownsSocket = false;
    }
  }

  private scheduleShutdownCheck(): void {
    if (this.shutdownTimer) return;
    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null;
      if (this.sessions.size > 0) return;
      this.shutdown();
      // Only a broker that owns its process may exit it. Embedded in a test or
      // in the demo, the host owns the process and shutdown() alone is correct.
      if (this.options.exitWhenIdle) process.exit(0);
    }, this.options.idleGraceMs ?? SHUTDOWN_GRACE_MS);
    // The listening server already holds the event loop open, so the timer does
    // not need to; unref'd, it cannot keep a host process alive on its own.
    this.shutdownTimer.unref?.();
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
          // seq 0 marks membership churn: the extension filters those out rather
          // than counting them as content (index.ts). Sending room.lastSeq here
          // announced a join as a new message, so joining a room with history
          // pinged every peer about a message that does not exist — and a late
          // joiner, the case the digest exists for, always has history.
          this.notifyRoom(msg.room, { type: "activity", room: msg.room, from: session.name, seq: 0 }, sessionId);
          break;
        }
        case "leave": {
          this.store.leave(msg.room, sessionId);
          this.send(socket, { type: "left", requestId: msg.requestId, room: msg.room });
          // Matches the disconnect path, which already announces departures.
          // Without this, peers saw a role leave only when its session died.
          this.notifyRoom(msg.room, { type: "activity", room: msg.room, from: "(left)", seq: 0 }, sessionId);
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
