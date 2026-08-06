/**
 * `orphus-roles` — turn a role manifest into launch commands.
 *
 * This emits; it does not spawn. Each role is an interactive model session with
 * real cost, so the fan-out stays an explicit act: pipe the output to `sh`, or
 * read it first. That also keeps the whole launcher deterministic and testable.
 */
import { loadRoleManifest } from "./manifest.ts";
import { buildLaunchPlan } from "./plan.ts";
import { formatPlan, isPlanFormat, PLAN_FORMATS, type PlanFormat } from "./format.ts";
import { RoleManifestError } from "./types.ts";

const DEFAULT_MANIFEST = "orphus.roles.yaml";

export interface CliOptions {
  readonly manifestPath: string;
  readonly format: PlanFormat;
  readonly binary?: string;
  readonly sessionName?: string;
}

const USAGE = `orphus-roles — fan a role manifest out into launch commands

Usage:
  orphus-roles [manifest] [options]

Arguments:
  manifest              Path to the role manifest (default: ${DEFAULT_MANIFEST})

Options:
  --format <f>          ${PLAN_FORMATS.join(" | ")} (default: plan)
  --binary <name>       Agent binary to invoke (default: orphus)
  --session-name <name> tmux session name (default: orphus-<task>)
  -h, --help            Show this help

Examples:
  orphus-roles                                  # review the plan
  orphus-roles --format tmux | sh               # fan out locally, one window per role
  orphus-roles --format orca | sh               # fan out across Orca worktrees
  orphus-roles --format json | jq '.launches[].model'
`;

/** Parse argv (without node/script prefix). Throws RoleManifestError on bad input. */
export function parseCliArgs(argv: readonly string[]): CliOptions | "help" {
  let manifestPath: string | undefined;
  let format: PlanFormat = "plan";
  let binary: string | undefined;
  let sessionName: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") return "help";
    if (arg === "--format" || arg === "--binary" || arg === "--session-name") {
      const value = argv[i + 1];
      if (value === undefined) throw new RoleManifestError(`${arg} requires a value`);
      i++;
      if (arg === "--format") {
        if (!isPlanFormat(value)) {
          throw new RoleManifestError(`unknown format "${value}" — expected one of: ${PLAN_FORMATS.join(", ")}`);
        }
        format = value;
      } else if (arg === "--binary") {
        binary = value;
      } else {
        sessionName = value;
      }
      continue;
    }
    if (arg.startsWith("-")) throw new RoleManifestError(`unknown option "${arg}"`);
    if (manifestPath !== undefined) throw new RoleManifestError(`unexpected extra argument "${arg}"`);
    manifestPath = arg;
  }

  return {
    manifestPath: manifestPath ?? DEFAULT_MANIFEST,
    format,
    ...(binary !== undefined ? { binary } : {}),
    ...(sessionName !== undefined ? { sessionName } : {}),
  };
}

/** Render the plan for the given argv. Pure apart from reading the manifest. */
export function runCli(argv: readonly string[]): string {
  const options = parseCliArgs(argv);
  if (options === "help") return USAGE;
  const manifest = loadRoleManifest(options.manifestPath);
  const plan = buildLaunchPlan(manifest, options.binary !== undefined ? { binary: options.binary } : {});
  return formatPlan(plan, options.format, options.sessionName !== undefined ? { sessionName: options.sessionName } : {});
}

export function main(argv: readonly string[]): number {
  try {
    console.log(runCli(argv));
    return 0;
  } catch (error) {
    if (error instanceof RoleManifestError) {
      console.error(`orphus-roles: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
