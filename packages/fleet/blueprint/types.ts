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
  /**
   * Tool allowlist for this member — REPLACES the agent definition's own list
   * (mirroring per-call skill semantics). Deliberate members whose agents have
   * restrictive allowlists must include "roundtable" here to join rooms.
   */
  readonly tools?: readonly string[];
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
  /**
   * Hold the orchestrator's turn open until the deliberation completes.
   *
   * Defaults to false. A deliberation is minutes of members talking to each
   * other in a room the orchestrator is not reading, so waiting inside the call
   * costs a turn and buys nothing the completion notification does not.
   *
   * `true` restores **synchronous completion**, and that is a compatibility
   * guarantee rather than a test convenience: a blueprint written against the
   * previous flow may assume the step after a deliberation sees its outcome
   * directly — an orchestrator prompt reading the digest inline, or a pipeline
   * whose next team depends on the decision having landed. Those keep working
   * unchanged. The cost is a held-open turn for the whole deliberation.
   *
   * Dispatch teams ignore this — they return their results, so there is nothing
   * to wait on separately.
   */
  readonly blocking?: boolean;
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

export interface FleetGate {
  /** Automated GitHub reviewers that must COMPLETE on a PR before the gate model runs. */
  readonly reviewers: readonly string[];
  /** The final-gate reviewer model (`provider/model`), dispatched after the reviewers finish. */
  readonly model?: string;
}

export interface FleetBlueprint {
  readonly name: string;
  readonly description: string;
  /** Blueprint format version; only 1 exists. */
  readonly version: number;
  /** User-chosen `provider/model` for the orchestrating session, when pinned. */
  readonly orchestratorModel?: string;
  /** The final gate: PR reviewers to await, then the gate model's verdict. */
  readonly gate?: FleetGate;
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
