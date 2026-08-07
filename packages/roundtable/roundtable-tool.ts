import type { ExtensionAPI } from "@bastani/atomic";
import { Type } from "typebox";
import { buildDigest, normalizeDigestBudget, type DigestOptions } from "./digest.ts";
import type { RoundtableClient } from "./broker/client.ts";
import { MAX_ROOM_MESSAGE_CHARS, type RoomMessage } from "./types.ts";

interface RoundtableToolDeps {
  ensureConnected(): Promise<RoundtableClient>;
}

/** Hard context bound for one explicit replay result. */
export const MAX_REPLAY_CHARS = 8000;
const REPLAY_HEADER_RESERVE = 384;
const DIGEST_ROOM_LABEL_CHARS = 40;

interface DigestHeaderStats {
  total: number | string;
  verbatim: number | string;
  headlines: number | string;
  collapsed: number | string;
  chars: number | string;
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

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function replayLine(message: RoomMessage): string {
  const reply = message.replyTo ? ` (reply to ${clip(message.replyTo, 80)})` : "";
  const text = clip(message.text, MAX_ROOM_MESSAGE_CHARS);
  return `[${new Date(message.timestamp).toISOString()}] ${clip(message.from.name, 80)}#${message.seq}${reply}: ${text}`;
}

function renderDigestHeader(room: string, stats: DigestHeaderStats, peek: boolean): string {
  const suffix = peek ? " · peek (cursor unchanged)" : "";
  return `#${room} · ${stats.total} unread · showing ${stats.verbatim} verbatim, ${stats.headlines} headline(s), ${stats.collapsed} collapsed · ${stats.chars} chars${suffix}`;
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
  roundtable({ action: "replay", room: "design", afterSeq: 0 }) → Explicit raw sequence-range fetch; cursor unchanged
  roundtable({ action: "leave", room: "design" })               → Leave the room

Prefer digest over repeated peeks. Use replay only when you explicitly need messages a bounded digest collapsed.`,
    promptSnippet:
      "Group discussion rooms with other local agent sessions. Post findings, then pull bounded digests to catch up — the full transcript stays out of your context window.",
    parameters: Type.Object({
      action: Type.String({
        description: "Action: 'rooms', 'join', 'leave', 'post', 'digest', 'peek', or 'replay'",
      }),
      room: Type.Optional(Type.String({ description: "Room name (required for all actions except 'rooms')" })),
      message: Type.Optional(Type.String({ description: "Message to post (for 'post')" })),
      replyTo: Type.Optional(Type.String({ description: "Message id to reply to (for 'post')" })),
      topic: Type.Optional(Type.String({ description: "Room topic when creating via 'join'" })),
      budget: Type.Optional(Type.Number({ description: "Digest character budget (default 2000)" })),
      afterSeq: Type.Optional(Type.Number({ description: "First sequence boundary for replay (returns seq > afterSeq)" })),
      limit: Type.Optional(Type.Number({ description: "Replay message limit (default 20, maximum 100)" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      let client: RoundtableClient;
      try {
        client = await deps.ensureConnected();
      } catch (error) {
        return errorResult(`Roundtable not connected: ${getErrorMessage(error)}`);
      }

      const { action, room, message, replyTo, topic, budget, afterSeq, limit } = params;

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
            const totalBudget = normalizeDigestBudget(budget);
            const countPlaceholder = "9".repeat(Math.max(String(messages.length).length, 1));
            const charsPlaceholder = "9".repeat(String(totalBudget).length);
            const isPeek = action === "peek";
            const displayRoom = clip(room, DIGEST_ROOM_LABEL_CHARS);
            const headerReserve =
              renderDigestHeader(
                displayRoom,
                {
                  total: countPlaceholder,
                  verbatim: countPlaceholder,
                  headlines: countPlaceholder,
                  collapsed: countPlaceholder,
                  chars: charsPlaceholder,
                },
                isPeek,
              ).length + 1;
            const options: DigestOptions = { budget: totalBudget, reservedChars: headerReserve };
            const digest = buildDigest(messages, options);
            if (action === "digest" && digest.consumedSeq > 0) {
              await client.setCursor(room, digest.consumedSeq);
            }
            const header = renderDigestHeader(displayRoom, digest, isPeek);
            const response = digest.text ? `${header}\n${digest.text}` : header;
            return okResult(response, {
              room,
              lastSeq,
              cursorBefore: cursor,
              consumedSeq: digest.consumedSeq,
              chars: digest.chars,
            });
          }
          case "replay": {
            if (!room) return errorResult("Missing 'room' parameter");
            const replayAfter = afterSeq ?? 0;
            const replayLimit = limit ?? 20;
            if (!Number.isSafeInteger(replayAfter) || replayAfter < 0) {
              return errorResult("'afterSeq' must be a non-negative safe integer");
            }
            if (!Number.isSafeInteger(replayLimit) || replayLimit < 0 || replayLimit > 100) {
              return errorResult("'limit' must be a non-negative safe integer no greater than 100");
            }
            const replay = await client.fetch(room, replayAfter, replayLimit);
            if (replay.messages.length === 0) {
              const hasMore = replay.lastSeq > replayAfter;
              return okResult(
                `#${clip(room, 120)} · replay window contains 0 messages after seq ${replayAfter} · cursor unchanged${hasMore ? ` · more remain after seq ${replayAfter}` : ""}`,
                {
                  room,
                  afterSeq: replayAfter,
                  lastSeq: replay.lastSeq,
                  lastReturnedSeq: replayAfter,
                  hasMore,
                  messages: 0,
                },
              );
            }
            const lines: string[] = [];
            let bodyChars = 0;
            for (const item of replay.messages) {
              const line = replayLine(item);
              const additional = line.length + (lines.length > 0 ? 1 : 0);
              if (bodyChars + additional > MAX_REPLAY_CHARS - REPLAY_HEADER_RESERVE) break;
              lines.push(line);
              bodyChars += additional;
            }
            const lastReturnedSeq = replay.messages[lines.length - 1]?.seq ?? replayAfter;
            const hasMore = lines.length < replay.messages.length || lastReturnedSeq < replay.lastSeq;
            const header = `#${clip(room, 120)} · replaying ${lines.length} message(s) after seq ${replayAfter} · cursor unchanged${hasMore ? ` · continue after seq ${lastReturnedSeq}` : ""}`;
            return okResult(`${header}\n${lines.join("\n")}`, {
              room,
              afterSeq: replayAfter,
              lastSeq: replay.lastSeq,
              lastReturnedSeq,
              hasMore,
              messages: lines.length,
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
  const probe = await client.fetch(room, Number.MAX_SAFE_INTEGER, 0);
  return probe.cursor;
}
