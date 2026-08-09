/**
 * Fleet blueprint types.
 *
 * A blueprint is a single shareable YAML file describing an orchestration: named
 * teams of members (references to agent definitions), the delegation mode each
 * team uses, and which skills its members wield. It deliberately does NOT
 * duplicate AgentConfig — members point at agent definitions by runtime name,
 * and the agent file keeps ownership of tools, model ladders, and prompts.
 */

export type TeamMode = "dispatch" | "deliberate" | "deliberate-then-dispatch";

export interface MemberSpec {
  /** Agent definition runtime name (dots allowed for package.name namespacing). */
  readonly agent: string;
  /** Inline role brief, appended to the member's task. Mutually exclusive with briefPath. */
  readonly brief?: string;
  /** Absolute path to a brief file (validated: exists, regular, readable). */
  readonly briefPath?: string;
  /** Skills for this member; unioned with the team's skills at render time. */
  readonly skills: readonly string[];
  /** Optional model override, `provider/model` or bare id — the agent's own model otherwise. */
  readonly model?: string;
  /** Dispatch replication factor; members are named uniquely when count > 1. */
  readonly count: number;
}

export interface TeamSpec {
  readonly name: string;
  readonly mode: TeamMode;
  /** Roundtable room for deliberation. Defaults to fleet-<fleet>-<team>. */
  readonly room: string;
  readonly topic?: string;
  /** Digest/reply rounds each deliberating member runs before posting FINAL. */
  readonly rounds: number;
  /** Team-level skills, unioned into every member's skills at render time. */
  readonly skills: readonly string[];
  /** Intercom group for dispatch sets: a name, or true for one shared auto group. */
  readonly group?: string | true;
  /** Per-team concurrency override for dispatch fan-out. */
  readonly concurrency?: number;
  readonly members: readonly MemberSpec[];
}

export interface FleetBudgets {
  readonly digest: number;
  readonly perMessage: number;
}

export interface FleetDefaults {
  readonly concurrency: number;
  readonly budgets: FleetBudgets;
}

export interface FleetBlueprint {
  readonly name: string;
  readonly description: string;
  /** Blueprint format version; only 1 exists. */
  readonly version: number;
  /** User-chosen `provider/model` for the orchestrating session, when pinned. */
  readonly orchestratorModel?: string;
  readonly defaults: FleetDefaults;
  readonly teams: readonly TeamSpec[];
  /** Suggested team order; defaults to declaration order. */
  readonly pipeline: readonly string[];
  /** Non-fatal validation findings, in file order. */
  readonly warnings: readonly string[];
  /** Directory the blueprint was loaded from (brief paths resolve against it). */
  readonly dir: string;
  readonly path: string;
}

export class FleetBlueprintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FleetBlueprintError";
  }
}
