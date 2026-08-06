import type { ExtensionAPI } from "@bastani/atomic";
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
 *  - Content only enters context through a bounded digest or replay page.
 */
export default function roundtableExtension(pi: ExtensionAPI): void {
  let client: RoundtableClient | null = null;
  let connecting: Promise<RoundtableClient> | null = null;
  let connectingClient: RoundtableClient | null = null;
  let shuttingDown = false;
  let pendingActivity = new Map<string, { count: number; from: Set<string> }>();
  let notifyTimer: NodeJS.Timeout | null = null;

  const flushActivity = () => {
    notifyTimer = null;
    if (pendingActivity.size === 0) return;
    const parts: string[] = [];
    for (const [room, info] of pendingActivity) {
      parts.push(`#${room}: ${info.count} new (${[...info.from].join(", ")})`);
    }
    pendingActivity = new Map();
    pi.sendMessage(
      {
        customType: "roundtable_activity",
        content: `Roundtable activity — ${parts.join(" · ")}. Use roundtable({ action: "digest", room: "…" }) to catch up when relevant.`,
        display: true,
      },
      { deliverAs: "followUp" },
    );
  };

  const ensureConnected = (): Promise<RoundtableClient> => {
    if (shuttingDown) return Promise.reject(new Error("Roundtable session is shutting down"));
    if (client?.connected) return Promise.resolve(client);
    if (connecting) return connecting;
    const current = (async () => {
      await ensureBrokerRunning();
      if (shuttingDown) throw new Error("Roundtable session is shutting down");
      const name = pi.getSessionName() ?? `session-${process.pid}`;
      const fresh = new RoundtableClient(typeof name === "string" && name.trim() ? name.trim() : `session-${process.pid}`);
      connectingClient = fresh;
      try {
        await fresh.connect();
        if (shuttingDown) {
          fresh.disconnect();
          throw new Error("Roundtable session is shutting down");
        }
        fresh.onActivity((event) => {
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
        if (connectingClient === fresh) connectingClient = null;
      }
    })();
    connecting = current;
    void current.then(
      () => {
        if (connecting === current) connecting = null;
      },
      () => {
        if (connecting === current) connecting = null;
      },
    );
    return current;
  };

  registerRoundtableTool(pi, { ensureConnected });

  // Durable memory (HMLR-Wiki / Dossier) is a sibling of rooms: rooms are the
  // ephemeral working set, memory is the compiled long-term store. Config is
  // read once from the environment; the role is read lazily per call because a
  // session's name can be set after the extension registers. See docs/memory.md.
  registerMemoryTool(pi, {
    config: resolveMemoryConfig(),
    currentRole: () => {
      const name = pi.getSessionName();
      return typeof name === "string" && name.trim() ? name.trim() : undefined;
    },
  });

  pi.on("session_shutdown", () => {
    shuttingDown = true;
    if (notifyTimer) clearTimeout(notifyTimer);
    connectingClient?.disconnect();
    connectingClient = null;
    client?.disconnect();
    client = null;
  });
}
