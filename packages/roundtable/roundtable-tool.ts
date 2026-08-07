import { mkdir, writeFile } from "fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "path";
import type { ExtensionAPI, ToolDefinition } from "@bastani/atomic";
import { type Static, Type } from "typebox";
import { buildDigest, type DigestOptions } from "./digest.ts";
import type { RoundtableClient } from "./broker/client.ts";
import { DEFAULT_ROOM_CAPACITY } from "./broker/room-store.ts";

export interface RoundtableToolDeps {
  ensureConnected(): Promise<RoundtableClient>;
  /** Shared Dossier project root. Exports are restricted to its raw/ directory. */
  exportRoot: string;
  /** Session role used to enforce the single-writer memory contract. */
  currentRole(): string | undefined;
  /** The only role allowed to stage transcripts for memory ingest. */
  writerRole: string;
}

const RoundtableParameters = Type.Object({
  action: Type.String({
    description: "Action: 'rooms', 'join', 'leave', 'post', 'digest', 'peek', or 'export'",
  }),
  path: Type.Optional(Type.String({ description: "Relative file under the memory raw/ directory (for 'export')" })),
  room: Type.Optional(Type.String({ description: "Room name (required for all actions except 'rooms')" })),
  message: Type.Optional(Type.String({ description: "Message to post (for 'post')" })),
  replyTo: Type.Optional(Type.String({ description: "Message id to reply to (for 'post')" })),
  topic: Type.Optional(Type.String({ description: "Room topic when creating via 'join'" })),
  budget: Type.Optional(Type.Number({ description: "Digest character budget (default 2000)" })),
});

export type RoundtableToolParams = Static<typeof RoundtableParameters>;

export interface RoundtableToolDetails {
  error?: boolean;
  rooms?: number;
  room?: string;
  unread?: number;
  seq?: number;
  id?: string;
  lastSeq?: number;
  cursorBefore?: number;
  consumedSeq?: number;
  path?: string;
  messages?: number;
  chars?: number;
  firstSeq?: number;
  droppedBefore?: number;
  truncated?: boolean;
}

export interface RoundtableToolResult {
  isError: boolean;
  content: Array<{ type: "text"; text: string }>;
  details: RoundtableToolDetails;
}

function errorResult(text: string): RoundtableToolResult {
  return { content: [{ type: "text" as const, text }], isError: true, details: { error: true } };
}

function okResult(text: string, details: RoundtableToolDetails = {}): RoundtableToolResult {
  return { content: [{ type: "text" as const, text }], isError: false, details };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveExportTarget(exportRoot: string, requestedPath: string): string {
  if (isAbsolute(requestedPath)) throw new Error("Export path must be relative to the memory directory");
  const rawRoot = resolve(exportRoot, "raw");
  const target = resolve(exportRoot, requestedPath);
  const relativeTarget = relative(rawRoot, target);
  if (
    relativeTarget === "" ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error("Export path must name a file under the memory raw/ directory");
  }
  return target;
}

export function createRoundtableTool(deps: RoundtableToolDeps) {
  return {
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
  roundtable({ action: "export", room: "design", path: "raw/design.md" }) → Write retained messages for memory ingest

Prefer digest over repeated peeks; keep budgets small and raise them only when you truly need history.
'export' is restricted to the "${deps.writerRole}" role, writes only under the shared memory raw/ directory, and returns a path plus counts. Room retention is 500 messages; export reports if older messages already rotated out.`,
    promptSnippet:
      "Group discussion rooms with other local agent sessions. Post findings, then pull bounded digests to catch up — the full transcript stays out of your context window.",
    parameters: RoundtableParameters,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { action, room, message, replyTo, topic, budget, path } = params;
      if (action === "export") {
        const role = deps.currentRole();
        if (role !== deps.writerRole) {
          const named = role !== undefined && role.trim() !== "";
          return errorResult(
            named
              ? `Only the "${deps.writerRole}" role may export rooms for memory; this session is "${role}". Ask the ${deps.writerRole} to export.`
              : `Only the "${deps.writerRole}" role may export rooms for memory; this session has no role name (launch it with --name ${deps.writerRole}).`,
          );
        }
      }

      let client: RoundtableClient;
      try {
        client = await deps.ensureConnected();
      } catch (error) {
        return errorResult(`Roundtable not connected: ${getErrorMessage(error)}`);
      }

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
            const requestedPath = path?.trim();
            if (!room || !requestedPath) return errorResult("Missing 'room' or 'path' parameter");
            // Straight from the broker to disk, bypassing the digest entirely: a
            // digest collapses older messages, so a digest-derived file would be a
            // lossy source for memory. Cursors are untouched, so exporting never
            // consumes anyone's unread state.
            const { messages, lastSeq } = await client.fetch(room, 0, DEFAULT_ROOM_CAPACITY);
            const transcript = messages
              .map((m) => `[${new Date(m.timestamp).toISOString()}] ${m.from.name}#${m.seq}: ${m.text}`)
              .join("\n");
            const target = resolveExportTarget(deps.exportRoot, requestedPath);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, transcript ? `${transcript}\n` : "", "utf8");
            const firstSeq = messages[0]?.seq ?? 0;
            const droppedBefore = Math.max(0, firstSeq - 1);
            const truncationNote = droppedBefore > 0 ? ` ${droppedBefore} older message(s) were no longer retained.` : "";
            // Return metadata only — the transcript stays out of the context window.
            return okResult(
              `Exported ${messages.length} retained message(s) from #${room} to ${target} (${transcript.length} chars).${truncationNote}`,
              {
                room,
                path: target,
                messages: messages.length,
                chars: transcript.length,
                firstSeq,
                lastSeq,
                droppedBefore,
                truncated: droppedBefore > 0,
              },
            );
          }
          default:
            return errorResult(`Unknown action: ${action}`);
        }
      } catch (error) {
        return errorResult(`Roundtable ${action} failed: ${getErrorMessage(error)}`);
      }
    },
  } satisfies ToolDefinition<typeof RoundtableParameters, RoundtableToolDetails>;
}

export function registerRoundtableTool(pi: ExtensionAPI, deps: RoundtableToolDeps): void {
  pi.registerTool(createRoundtableTool(deps));
}

async function cursorFor(client: RoundtableClient, room: string): Promise<number> {
  // fetch(afterSeq=cursor) needs the member cursor; a zero-window fetch returns it.
  const probe = await client.fetch(room, Number.MAX_SAFE_INTEGER, 1);
  return probe.cursor;
}
