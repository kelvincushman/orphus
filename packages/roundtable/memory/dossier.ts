import { join } from "path";
import { getAgentDir } from "../broker/paths.ts";

/**
 * Long-term memory via HMLR-Wiki / Dossier — the pure boundary.
 *
 * Everything here is deterministic and model-free: environment → config,
 * params → argv, and the role gate. The subprocess itself lives in ./run.ts so
 * this module stays unit-testable with no Python and no wiki on disk.
 *
 * Contract (docs/memory.md): memory content enters an agent's context ONLY
 * through an explicit tool call (never a ping or a digest), and writes are
 * restricted to a single `librarian` role so shared memory has one accountable
 * author and no write contention.
 */

/** Actions an agent may take. Reads are open; writes are librarian-only. */
export type MemoryAction = "query" | "doctor" | "ingest" | "gardener";

export const MEMORY_ACTIONS: readonly MemoryAction[] = ["query", "doctor", "ingest", "gardener"];

/** Write actions mutate the wiki and are restricted to the writer role. */
export const MEMORY_WRITE_ACTIONS: readonly MemoryAction[] = ["ingest", "gardener"];

export interface MemoryConfig {
  /** Base command, already split into argv (e.g. ["python", "-m", "dossier"]). */
  readonly command: readonly string[];
  /** Working directory for the Dossier project (where raw/ and wiki/ live). */
  readonly cwd?: string;
  /** The one role allowed to write. Every other role is read-only. */
  readonly writerRole: string;
}

export interface ResolvedMemoryConfig extends MemoryConfig {
  readonly cwd: string;
}

const DEFAULT_COMMAND = "python -m dossier";
const DEFAULT_WRITER_ROLE = "librarian";

export function isMemoryAction(value: string): value is MemoryAction {
  return (MEMORY_ACTIONS as readonly string[]).includes(value);
}

function isWriteAction(action: MemoryAction): boolean {
  return (MEMORY_WRITE_ACTIONS as readonly string[]).includes(action);
}

/**
 * Split a command string into argv on whitespace. The command is operator-set
 * (an env var), never agent-supplied, so there are no quoting rules to honor.
 */
export function parseCommand(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
}

/**
 * Resolve config from the environment.
 *   ORPHUS_MEMORY_COMMAND      base command (default "python -m dossier")
 *   ORPHUS_MEMORY_DIR          Dossier project directory (optional)
 *   ORPHUS_MEMORY_WRITER_ROLE  role allowed to write (default "librarian")
 */
export function resolveMemoryConfig(env: NodeJS.ProcessEnv = process.env): ResolvedMemoryConfig {
  const command = parseCommand(env.ORPHUS_MEMORY_COMMAND ?? DEFAULT_COMMAND);
  const writerRole = (env.ORPHUS_MEMORY_WRITER_ROLE ?? "").trim() || DEFAULT_WRITER_ROLE;
  // Anchored under the agent dir, like the broker socket, so every Orca worktree
  // resolves the SAME wiki. Defaulting to the process cwd would silently give each
  // worktree its own empty memory, and an empty answer reads as success.
  const cwd = env.ORPHUS_MEMORY_DIR?.trim() || join(getAgentDir(env), "memory");
  return { command, writerRole, cwd };
}

export interface MemoryParams {
  readonly action: MemoryAction;
  readonly question?: string;
  readonly source?: string;
}

export interface GateResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

/**
 * Decide whether `role` may perform `action`. Reads are open to every role;
 * writes require the exact writer role. A session with no role name can never
 * write — the fallback session-<pid> identity is not the librarian.
 */
export function gateAction(action: MemoryAction, role: string | undefined, writerRole: string): GateResult {
  if (!isWriteAction(action)) return { allowed: true };
  if (role === writerRole) return { allowed: true };
  const named = role !== undefined && role.trim() !== "";
  return {
    allowed: false,
    reason: named
      ? `Only the "${writerRole}" role may ${action} into memory; this session is "${role}". Ask the ${writerRole} to write.`
      : `Only the "${writerRole}" role may ${action} into memory; this session has no role name (launch it with --name ${writerRole}).`,
  };
}

/** Build the argv that follows the base command. Throws when a required param is missing. */
export function buildDossierArgs(params: MemoryParams): string[] {
  switch (params.action) {
    case "query": {
      const question = params.question?.trim();
      if (!question) throw new Error("memory query requires a 'question'");
      return ["query", question];
    }
    case "ingest": {
      const source = params.source?.trim();
      if (!source) throw new Error("memory ingest requires a 'source' path");
      return ["ingest", source];
    }
    case "gardener":
      return ["gardener"];
    case "doctor":
      return ["doctor"];
  }
}
