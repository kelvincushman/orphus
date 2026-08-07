import { mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import type { ExtensionAPI } from "@bastani/atomic";
import { Type } from "typebox";
import { buildDigest, type DigestOptions } from "./digest.ts";
import type { RoundtableClient } from "./broker/client.ts";
import { DEFAULT_ROOM_CAPACITY } from "./broker/room-store.ts";

interface RoundtableToolDeps {
  ensureConnected(): Promise<RoundtableClient>;
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true, details: { error: true } };
}

function okResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], isError: false, details };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerRoundtableTool(pi: ExtensionAPI, deps: RoundtableToolDeps): void {
  pi.registerTool({
    name: "roundtable",
    label: "Roundtable",
    description: `Group chat rooms shared with other local agent sessions.
Rooms hold the full discussion OUTSIDE your context window; you pull bounded digests when you need to catch up.

Usage:
  roundtable({ action: "rooms" })                               → List rooms and activity
  roundtable({ action: "join", room: "design" })                → Join (creates if missing; optional topic)
  roundtable({ action: "post", room: "design", message: "…" })  → Post to the room
  roundtable({ action: "digest", room: "design" })              → Pull unread as a bounded digest and mark read
  roundtable({ action: "digest", room: "design", budget: 4000 })→ Same with a larger character budget
  roundtable({ action: "peek", room: "design" })                → Digest WITHOUT marking read
  roundtable({ action: "leave", room: "design" })               → Leave the room
  roundtable({ action: "export", room: "design", path: "…" })   → Write the FULL transcript to a file (for memory ingest)

Prefer digest over repeated peeks; keep budgets small and raise them only when you truly need history.
'export' writes to disk and returns only a path and counts — the transcript never enters your context, so it is safe on a long room.`,
    promptSnippet:
      "Group discussion rooms with other local agent sessions. Post findings, then pull bounded digests to catch up — the full transcript stays out of your context window.",
    parameters: Type.Object({
      action: Type.String({
        description: "Action: 'rooms', 'join', 'leave', 'post', 'digest', 'peek', or 'export'",
      }),
      path: Type.Optional(Type.String({ description: "File to write the transcript to (for 'export')" })),
      room: Type.Optional(Type.String({ description: "Room name (required for all actions except 'rooms')" })),
      message: Type.Optional(Type.String({ description: "Message to post (for 'post')" })),
      replyTo: Type.Optional(Type.String({ description: "Message id to reply to (for 'post')" })),
      topic: Type.Optional(Type.String({ description: "Room topic when creating via 'join'" })),
      budget: Type.Optional(Type.Number({ description: "Digest character budget (default 2000)" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      let client: RoundtableClient;
      try {
        client = await deps.ensureConnected();
      } catch (error) {
        return errorResult(`Roundtable not connected: ${getErrorMessage(error)}`);
      }

      const { action, room, message, replyTo, topic, budget, path } = params;

      try {
        switch (action) {
          case "rooms": {
            const rooms = await client.listRooms();
            if (rooms.length === 0) return okResult("No active rooms. Use join to create one.");
            const lines = rooms.map((r) => {
              const members = r.members.map((m) => m.name).join(", ") || "none";
              return `#${r.name}${r.topic ? ` — ${r.topic}` : ""} · ${r.messageCount} msgs · members: ${members}`;
            });
            return okResult(lines.join("\n"), { rooms: rooms.length });
          }
          case "join": {
            if (!room) return errorResult("Missing 'room' parameter");
            const joined = await client.join(room, topic);
            const unread = joined.room.lastSeq - joined.cursor;
            return okResult(
              `Joined #${room}${joined.room.topic ? ` — ${joined.room.topic}` : ""}. ${joined.room.members.length} member(s), ${unread} unread message(s).${unread > 0 ? " Use digest to catch up." : ""}`,
              { room, unread },
            );
          }
          case "leave": {
            if (!room) return errorResult("Missing 'room' parameter");
            await client.leave(room);
            return okResult(`Left #${room}.`);
          }
          case "post": {
            if (!room || !message) return errorResult("Missing 'room' or 'message' parameter");
            const posted = await client.post(room, message, replyTo);
            return okResult(`Posted to #${room} as ${posted.from.name}#${posted.seq}.`, { room, seq: posted.seq, id: posted.id });
          }
          case "digest":
          case "peek": {
            if (!room) return errorResult("Missing 'room' parameter");
            const { messages, lastSeq, cursor } = await client.fetch(room, await cursorFor(client, room));
            const options: DigestOptions = budget !== undefined ? { budget } : {};
            const digest = buildDigest(messages, options);
            if (action === "digest" && digest.consumedSeq > 0) {
              await client.setCursor(room, digest.consumedSeq);
            }
            const header = `#${room} · ${digest.total} unread · showing ${digest.verbatim} verbatim, ${digest.headlines} headline(s), ${digest.collapsed} collapsed · ${digest.chars} chars${action === "peek" ? " · peek (cursor unchanged)" : ""}`;
            return okResult(`${header}\n${digest.text}`, {
              room,
              lastSeq,
              cursorBefore: cursor,
              consumedSeq: digest.consumedSeq,
              chars: digest.chars,
            });
          }
          case "export": {
            if (!room || !path) return errorResult("Missing 'room' or 'path' parameter");
            // Straight from the broker to disk, bypassing the digest entirely: a
            // digest collapses older messages, so a digest-derived file would be a
            // lossy source for memory. Cursors are untouched, so exporting never
            // consumes anyone's unread state.
            const { messages } = await client.fetch(room, 0, DEFAULT_ROOM_CAPACITY);
            const transcript = messages
              .map((m) => `[${new Date(m.timestamp).toISOString()}] ${m.from.name}#${m.seq}: ${m.text}`)
              .join("\n");
            const target = resolve(path);
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, transcript ? `${transcript}\n` : "", "utf8");
            // Return metadata only — the transcript stays out of the context window.
            return okResult(`Exported ${messages.length} message(s) from #${room} to ${target} (${transcript.length} chars).`, {
              room,
              path: target,
              messages: messages.length,
              chars: transcript.length,
            });
          }
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (error) {
        return errorResult(`Roundtable ${action} failed: ${getErrorMessage(error)}`);
      }
    },
  });
}

async function cursorFor(client: RoundtableClient, room: string): Promise<number> {
  // fetch(afterSeq=cursor) needs the member cursor; a zero-window fetch returns it.
  const probe = await client.fetch(room, Number.MAX_SAFE_INTEGER, 1);
  return probe.cursor;
}
