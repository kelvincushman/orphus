import type { ExtensionAPI } from "@bastani/atomic";
import { RoundtableClient } from "../../src/broker/client.ts";
import { ensureBrokerRunning } from "../../src/broker/spawn.ts";
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

  const ensureConnected = async (): Promise<RoundtableClient> => {
    if (client?.connected) return client;
    await ensureBrokerRunning();
    const name = pi.getSessionName() ?? `session-${process.pid}`;
    const fresh = new RoundtableClient(typeof name === "string" && name.trim() ? name.trim() : `session-${process.pid}`);
    await fresh.connect();
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
  };

  registerRoundtableTool(pi, { ensureConnected });

  pi.on("session_shutdown", () => {
    if (notifyTimer) clearTimeout(notifyTimer);
    client?.disconnect();
    client = null;
  });
}
