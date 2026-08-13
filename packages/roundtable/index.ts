import type { ExtensionAPI } from "@orphus/coding-agent";
import { RoundtableClient } from "./broker/client.ts";
import { ensureBrokerRunning } from "./broker/spawn.ts";
import { resolveMemoryConfig } from "./memory/dossier.ts";
import { registerMemoryTool } from "./memory-tool.ts";
import { registerRoundtableTool } from "./roundtable-tool.ts";

const NOTIFY_COALESCE_MS = 1500;

/**
 * Roundtable extension: group chat rooms between local agent sessions.
 *
 * Context-window contract:
 *  - Room transcripts live in the broker, never in the session transcript.
 *  - Incoming activity surfaces as ONE coalesced one-liner per quiet period.
 *  - Content only enters context when the agent pulls a bounded digest.
 */
export default function roundtableExtension(pi: ExtensionAPI): void {
  let client: RoundtableClient | null = null;
  let connecting: Promise<RoundtableClient> | null = null;
  let pendingActivity = new Map<string, { count: number; from: Set<string> }>();
  let notifyTimer: NodeJS.Timeout | null = null;
  // Once quiesced an instance is dead for good: the flag blocks new connects,
  // drops in-flight ones on completion, and mutes activity callbacks — clearing
  // live state alone would let a connect that was in flight during quiesce()
  // restore an active client afterwards.
  let quiesced = false;

  const quiesce = () => {
    quiesced = true;
    if (notifyTimer) clearTimeout(notifyTimer);
    notifyTimer = null;
    pendingActivity = new Map();
    client?.disconnect();
    client = null;
  };

  const flushActivity = () => {
    notifyTimer = null;
    if (pendingActivity.size === 0) return;
    const parts: string[] = [];
    for (const [room, info] of pendingActivity) {
      parts.push(`#${room}: ${info.count} new (${[...info.from].join(", ")})`);
    }
    pendingActivity = new Map();
    try {
      pi.sendMessage(
        {
          customType: "roundtable_activity",
          content: `Roundtable activity — ${parts.join(" · ")}. Use roundtable({ action: "digest", room: "…" }) to catch up when relevant.`,
          display: true,
        },
        { deliverAs: "followUp" },
      );
    } catch {
      // The host refused delivery. The known case is a stale extension ctx
      // after session replacement: AgentSession.dispose() invalidates every
      // captured ctx without emitting session_shutdown, so this instance's
      // broker client survives as an orphan and the next ping throws — from a
      // timer callback, where an uncaught error kills the process (a /fleet
      // run pinning the orchestrator model dies before its first turn).
      // Pings are best-effort by contract — the digest tier recovers anything
      // a lost ping would have said — so quiesce this orphaned instance and
      // let the replacement session's own instance serve the rooms.
      quiesce();
    }
  };

  // Serialize concurrent first-connect calls (the harness runs tools in parallel):
  // without this, two roundtable calls in one turn spawn two clients, one orphaned
  // and still firing activity into pendingActivity. Mirrors intercom's reconnect guard.
  const ensureConnected = (): Promise<RoundtableClient> => {
    if (quiesced) return Promise.reject(new Error("This roundtable instance has been quiesced (session ended or replaced)."));
    if (client?.connected) return Promise.resolve(client);
    if (connecting) return connecting;
    connecting = (async () => {
      try {
        await ensureBrokerRunning();
        const name = pi.getSessionName() ?? `session-${process.pid}`;
        const fresh = new RoundtableClient(
          typeof name === "string" && name.trim() ? name.trim() : `session-${process.pid}`,
        );
        await fresh.connect();
        if (quiesced) {
          // quiesce() ran while this connect was in flight — completing it
          // would resurrect the instance quiesce just killed.
          fresh.disconnect();
          throw new Error("This roundtable instance has been quiesced (session ended or replaced).");
        }
        fresh.onActivity((event) => {
          if (quiesced) return;
          if (event.seq === 0) return; // membership churn, not content
          const entry = pendingActivity.get(event.room) ?? { count: 0, from: new Set<string>() };
          entry.count += 1;
          entry.from.add(event.from);
          pendingActivity.set(event.room, entry);
          if (!notifyTimer) notifyTimer = setTimeout(flushActivity, NOTIFY_COALESCE_MS);
        });
        client = fresh;
        return fresh;
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  };

  // Durable memory (HMLR-Wiki / Dossier) is a sibling of rooms: rooms are the
  // ephemeral working set, memory is the compiled long-term store. Config is
  // read once from the environment; the role is read lazily per call because a
  // session's name can be set after the extension registers. See docs/memory.md.
  const memoryConfig = resolveMemoryConfig();
  const currentRole = () => {
    const name = pi.getSessionName();
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  };
  registerRoundtableTool(pi, {
    ensureConnected,
    exportRoot: memoryConfig.cwd,
    currentRole,
    writerRole: memoryConfig.writerRole,
  });
  registerMemoryTool(pi, {
    config: memoryConfig,
    currentRole,
  });

  pi.on("session_shutdown", quiesce);
}
