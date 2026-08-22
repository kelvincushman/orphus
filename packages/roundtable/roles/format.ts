import type { LaunchPlan, RoleLaunch } from "./types.ts";

/**
 * Renderers for a launch plan.
 *
 * Every emitted command is quoted for POSIX `sh`. Role footers are multi-line
 * prose containing quotes and `#`, so unquoted interpolation would truncate a
 * role's instructions at the first space and silently change its behaviour.
 */

export type PlanFormat = "plan" | "json" | "sh" | "tmux" | "orca";

export const PLAN_FORMATS: readonly PlanFormat[] = ["plan", "json", "sh", "tmux", "orca"];

export function isPlanFormat(value: string): value is PlanFormat {
  return (PLAN_FORMATS as readonly string[]).includes(value);
}

/** Wrap in single quotes, escaping embedded single quotes the POSIX way. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function commandLine(launch: RoleLaunch): string {
  return [launch.command, ...launch.args].map(shellQuote).join(" ");
}

/** `cd <cwd> && orphus …` — the full invocation for one role. */
export function shellCommand(launch: RoleLaunch): string {
  return `cd ${shellQuote(launch.cwd)} && ${commandLine(launch)}`;
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function renderHuman(plan: LaunchPlan): string {
  const lines: string[] = [
    `task: ${plan.task}`,
    `room: #${plan.room}`,
    `budgets: digest ${plan.budgets.digest} chars, per-message ${plan.budgets.perMessage}`,
    `roles: ${plan.launches.length}`,
    "",
  ];
  for (const launch of plan.launches) {
    lines.push(`${"─".repeat(72)}`);
    lines.push(`${launch.role}  →  #${launch.room}`);
    lines.push(`  model:    ${launch.provider}/${launch.model}`);
    lines.push(`  cwd:      ${launch.cwd}`);
    if (launch.briefPath !== undefined) lines.push(`  brief:    ${launch.briefPath}`);
    lines.push(`  footer:`);
    lines.push(indent(launch.footer, "    │ "));
    lines.push(`  command:`);
    lines.push(`    ${shellCommand(launch)}`);
  }
  lines.push("─".repeat(72));
  return lines.join("\n");
}

function renderSh(plan: LaunchPlan): string {
  const lines = [
    "#!/bin/sh",
    `# Orphus roundtable — task "${plan.task}", room #${plan.room}`,
    "# Each role is an interactive session: run one line per terminal.",
    "",
  ];
  for (const launch of plan.launches) {
    lines.push(`# ${launch.role} → #${launch.room}`);
    lines.push(shellCommand(launch));
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * A runnable tmux script: one window per role in a single session.
 * `tmux new-session -d` then `new-window` keeps every role visible and killable
 * as a unit — the closest thing to "one command fans this out" on a laptop.
 */
function renderTmux(plan: LaunchPlan, sessionName: string): string {
  const lines = [
    "#!/bin/sh",
    "set -e",
    `# Orphus roundtable — task "${plan.task}", room #${plan.room}`,
    // sessionName is unvalidated operator input (--session-name), so it is never
    // interpolated raw: a quote or newline would break or inject the piped-to-sh
    // script. The attach command is printed by the quoted echo on the last line.
    "# Run it, then attach with the command printed on the last line.",
    "",
  ];
  plan.launches.forEach((launch, index) => {
    const command = shellCommand(launch);
    const target = shellQuote(sessionName);
    if (index === 0) {
      lines.push(
        `tmux new-session -d -s ${target} -n ${shellQuote(launch.role)} -c ${shellQuote(launch.cwd)} ${shellQuote(command)}`,
      );
    } else {
      lines.push(
        `tmux new-window -t ${target} -n ${shellQuote(launch.role)} -c ${shellQuote(launch.cwd)} ${shellQuote(command)}`,
      );
    }
  });
  lines.push("", `echo ${shellQuote(`roundtable up — tmux attach -t ${sessionName}`)}`);
  return lines.join("\n");
}

/**
 * Orca fan-out: one terminal per role, in whichever worktree the role selects.
 * Roles default to the `active` worktree; give a role `worktree: name:planner`
 * in the manifest to put it in its own checkout.
 */
function renderOrca(plan: LaunchPlan): string {
  const lines = [
    "#!/bin/sh",
    "set -e",
    `# Orphus roundtable — task "${plan.task}", room #${plan.room}`,
    "# Worktrees must already exist; create them with `orca worktree create --name <role>`.",
    "",
  ];
  for (const launch of plan.launches) {
    // A defaulted cwd (the manifest dir) stays out of the command: the whole
    // point of --worktree is that orca decides where the terminal opens. An
    // EXPLICIT cwd is the author overriding that, and sh/tmux already honor
    // it — dropping it only here made the three formats disagree silently.
    const explicit = launch.cwd !== plan.manifestDir;
    lines.push(
      [
        "orca terminal create",
        `--worktree ${shellQuote(launch.worktree)}`,
        `--title ${shellQuote(launch.role)}`,
        `--command ${shellQuote(explicit ? shellCommand(launch) : commandLine(launch))}`,
      ].join(" "),
    );
  }
  return lines.join("\n");
}

export interface FormatOptions {
  /** tmux session name. Default: `orphus-<task>`. */
  readonly sessionName?: string;
}

export function formatPlan(plan: LaunchPlan, format: PlanFormat, options: FormatOptions = {}): string {
  const sessionName = options.sessionName ?? `orphus-${plan.task}`;
  switch (format) {
    case "json":
      return JSON.stringify(plan, null, 2);
    case "sh":
      return renderSh(plan);
    case "tmux":
      return renderTmux(plan, sessionName);
    case "orca":
      return renderOrca(plan);
    case "plan":
      return renderHuman(plan);
  }
}
