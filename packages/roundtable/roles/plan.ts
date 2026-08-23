import type { LaunchPlan, RoleLaunch, RoleManifest, RoleSpec } from "./types.ts";

/**
 * Turn a manifest into concrete session commands.
 *
 * Pure: same manifest in, same plan out. That is what makes a deliberation
 * reproducible and what lets the whole launcher be tested without a model.
 */

export interface PlanOptions {
  /** Binary to invoke. Default "orphus". */
  readonly binary?: string;
}

const DEFAULT_BINARY = "orphus";

/**
 * The coordination footer every role receives.
 *
 * Passed as its own `--append-system-prompt` value rather than concatenated
 * into the brief file: the brief stays a file the human edits, the footer stays
 * generated, and neither has to be rewritten to change the other.
 */
export function buildFooter(role: RoleSpec, manifest: RoleManifest): string {
  return [
    `You are the "${role.name}" role in an Orphus roundtable for task "${manifest.task}".`,
    `Join roundtable room #${role.room} and use exactly the role name "${role.name}" — room cursors and attribution are keyed by it.`,
    "Post conclusions, not transcripts. Pull a digest before major decisions.",
    `Default digest budget ${manifest.budgets.digest} characters, per-message cap ${manifest.budgets.perMessage}; raise it only when you genuinely need older history.`,
  ].join("\n");
}

function buildArgs(role: RoleSpec, footer: string): string[] {
  // --name is what the roundtable extension reads for room identity; without it
  // a session falls back to session-<pid> and loses its cursor across restarts.
  const args = [
    "--name",
    role.name,
    "--provider",
    role.provider,
    "--model",
    role.model,
  ];
  // Brief first, footer second: the footer's room rules are the last word.
  if (role.briefPath !== undefined) args.push("--append-system-prompt", role.briefPath);
  args.push("--append-system-prompt", footer);
  return args;
}

export function buildLaunchPlan(manifest: RoleManifest, options: PlanOptions = {}): LaunchPlan {
  const command = options.binary ?? DEFAULT_BINARY;
  const launches: RoleLaunch[] = manifest.roles.map((role): RoleLaunch => {
    const footer = buildFooter(role, manifest);
    return {
      role: role.name,
      room: role.room,
      provider: role.provider,
      model: role.model,
      ...(role.briefPath !== undefined ? { briefPath: role.briefPath } : {}),
      cwd: role.cwd,
      cwdExplicit: role.cwdExplicit,
      worktree: role.worktree,
      command,
      args: buildArgs(role, footer),
      footer,
    };
  });
  return { task: manifest.task, room: manifest.room, budgets: manifest.budgets, launches };
}
