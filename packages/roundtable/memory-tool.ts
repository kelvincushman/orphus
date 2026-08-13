import type { ExtensionAPI } from "@orphus/coding-agent";
import { Type } from "typebox";
import { buildDossierArgs, gateAction, isMemoryAction, type MemoryConfig } from "./memory/dossier.ts";
import { runDossier } from "./memory/run.ts";

interface MemoryToolDeps {
  readonly config: MemoryConfig;
  /** Read lazily each call: a session's role name may be set after registration. */
  readonly currentRole: () => string | undefined;
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

export function registerMemoryTool(pi: ExtensionAPI, deps: MemoryToolDeps): void {
  pi.registerTool({
    name: "memory",
    label: "Memory",
    description: `Long-term memory: a wiki-backed knowledge base compiled from past work (HMLR-Wiki / Dossier).
Durable across sessions, and separate from roundtable rooms (which are ephemeral). Content enters your context ONLY when you call this — it is never pushed.

Usage:
  memory({ action: "query", question: "…" })   → Ask the knowledge base; returns a grounded answer
  memory({ action: "doctor" })                  → Check the backend is configured and reachable
  memory({ action: "ingest", source: "path" })  → Compile a source into the wiki (librarian role only)
  memory({ action: "gardener" })                → Consolidate the wiki (librarian role only)

Query before re-deriving what a past session already worked out.`,
    promptSnippet:
      "Durable wiki-backed memory of past work. Query it before re-deriving prior conclusions; it stays out of context until you ask.",
    parameters: Type.Object({
      action: Type.String({ description: "Action: 'query', 'doctor', 'ingest', or 'gardener'" }),
      question: Type.Optional(Type.String({ description: "Question to ask (for 'query')" })),
      source: Type.Optional(Type.String({ description: "Path to the source to compile (for 'ingest')" })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const { action } = params;
      if (!isMemoryAction(action)) return errorResult(`Unknown memory action: ${action}`);

      const gate = gateAction(action, deps.currentRole(), deps.config.writerRole);
      if (!gate.allowed) return errorResult(gate.reason ?? "Not permitted.");

      let argv: string[];
      try {
        argv = buildDossierArgs({ action, question: params.question, source: params.source });
      } catch (error) {
        return errorResult(getErrorMessage(error));
      }

      let result: Awaited<ReturnType<typeof runDossier>>;
      try {
        result = await runDossier(deps.config, argv, signal);
      } catch (error) {
        return errorResult(
          `Memory backend not reachable (${getErrorMessage(error)}). Configure it with ORPHUS_MEMORY_COMMAND / ORPHUS_MEMORY_DIR — see docs/memory.md.`,
        );
      }

      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exited ${result.code}`;
        return errorResult(`memory ${action} failed: ${detail}`);
      }

      return okResult(result.stdout.trim() || `memory ${action} completed.`, { action });
    },
  });
}
