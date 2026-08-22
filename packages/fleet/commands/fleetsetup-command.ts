import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { ExtensionAPI } from "@orphus/coding-agent";
import { discoverFleets, fleetRoots } from "../blueprint/discovery.ts";

/**
 * `/fleetsetup` — author a blueprint by interview. The command does not run a
 * wizard of its own beyond gathering the facts: it sends ONE briefing that has
 * the session model interview the user, write the YAML, and iterate
 * fleet({ action: "validate" }) until clean. Fleets are community artifacts
 * created like skills are created — conversationally, into a shareable file.
 *
 * Provider enumeration is subscription-aware via the registry's own
 * getProviderAuthStatus — the same source the /login provider screen reads —
 * and the briefing lists ONLY configured providers, so seats are only ever
 * assigned to models the user can actually run.
 */

export interface FleetSetupDeps {
  env?: NodeJS.ProcessEnv;
  /** Test override for the shipped-examples dir. */
  bundledDir?: string;
}

interface CommandContextLike {
  cwd: string;
  modelRegistry: {
    getAll(): Array<{ provider: string; id: string }>;
    getProviderAuthStatus(provider: string): { configured: boolean };
  };
}

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * First remote URL from .git/config, if the cwd is a git repo. No exec: a
 * config read suffices for a proposal hint.
 *
 * Credentials embedded in the URL are stripped before it can reach the
 * briefing: the briefing is sent as a user message, so anything in it lands in
 * model context and the session transcript, and `https://user:token@host/…` is
 * a real shape CI writes into .git/config. `git@host:path` keeps its plain
 * user — scp form carries no password, and `git@` is the address, not a secret.
 */
function readGitRemote(cwd: string): string | undefined {
  try {
    const config = readFileSync(join(cwd, ".git", "config"), "utf8");
    const url = /\n\s*url\s*=\s*(\S+)/.exec(config)?.[1];
    return url
      ?.replace(/^([a-z][\w+.-]*:\/\/)[^@/]+@/iu, "$1")
      .replace(/^[^@/:]+:[^@/]+@/u, "");
  } catch {
    return undefined;
  }
}

function schemaReference(): string {
  const schemaPath = join(PACKAGE_DIR, "..", "SCHEMA.md");
  if (existsSync(schemaPath)) return readFileSync(schemaPath, "utf8");
  return "(SCHEMA.md missing from the fleet package — describe fields from fleet({action:'get'}) output of an example.)";
}

export interface SetupBriefingInputs {
  readonly schema: string;
  readonly configuredProviders: readonly string[];
  readonly fleets: readonly { name: string; scope: string }[];
  readonly targetDir: string;
  /** Whether docs/agents/issue-tracker.md already exists in this repo. */
  readonly hasIssueTrackerConfig?: boolean;
  /** The repo's git remote URL, when one exists — the tracker proposal hint. */
  readonly gitRemote?: string;
}

/** Pure briefing builder, unit-tested apart from the handler. */
export function buildSetupBriefing(inputs: SetupBriefingInputs): string {
  const fleetList = inputs.fleets.length
    ? inputs.fleets.map((fleet) => `  - ${fleet.name} (${fleet.scope})`).join("\n")
    : "  (none yet)";
  return [
    `# Fleet setup interview`,
    ``,
    `Interview the user and author a fleet blueprint. One question at a time; short questions; concrete options. Steps:`,
    ``,
    `1. Outcome: what should this fleet produce? (code, research, a blog pipeline, media — any scenario)`,
    `2. Teams: which stages does the outcome need? For each: does it need debate (deliberate), parallel bounded work (dispatch), or decide-then-do (deliberate-then-dispatch)?`,
    `3. Members: map each team seat to an existing agent — run subagent({ action: "list" }) to see them — or create missing agents with subagent({ action: "create", config: { … } }). Pre-assign skills per member; team-level skills apply to every member.`,
    `4. Models: assign the orchestrator's model and any per-member models FROM THE CONFIGURED PROVIDERS ONLY (listed below). If the user wants an unconfigured provider, have them run /login <provider> first, then continue.`,
    `5. The final gate: ask which automated GitHub reviewers run on their PRs (e.g. coderabbit, greptile — or none), and which configured-provider model renders the final verdict once those reviewers COMPLETE. Record the answers as the blueprint's gate block ({ reviewers, model }); a fleet whose work lands as PRs should not merge on green checks alone.`,
    ...(inputs.hasIssueTrackerConfig
      ? [
          `6. Repo agent config: docs/agents/issue-tracker.md already exists — fleets and skills will read it; do not rewrite it here.`,
        ]
      : [
          `6. Repo agent config: docs/agents/issue-tracker.md does not exist yet. Ask ONE question — where do issues and PRs for this repo live? ${
            inputs.gitRemote
              ? `Propose the tracker matching the git remote (${inputs.gitRemote}); `
              : ``
          }offer github (gh CLI), gitlab (glab CLI), local markdown, or a prose description of anything else (Jira, Linear, …). Write the answer to docs/agents/issue-tracker.md as short committed markdown: the tracker type and the exact commands or workflow agents should use. Fleet runs and community skill packs (e.g. mattpocock/skills) read this same file, so one answer configures both.`,
        ]),
    `7. Write the blueprint to ${inputs.targetDir}/<name>.fleet.yaml and iterate fleet({ action: "validate", name: "<name>" }) until it reports valid; show the user warnings and ask before ignoring any.`,
    `8. Finish by telling the user to run: /fleet <name> <task>`,
    ``,
    `Configured providers (the only valid model sources right now):`,
    ...inputs.configuredProviders.map((provider) => `  - ${provider}`),
    ``,
    `Existing fleets (do not overwrite without asking):`,
    fleetList,
    ``,
    `## Blueprint schema reference`,
    ``,
    inputs.schema,
  ].join("\n");
}

export function createFleetSetupHandler(pi: ExtensionAPI, deps: FleetSetupDeps = {}) {
  return async (_args: string, ctx: CommandContextLike): Promise<void> => {
    const env = deps.env ?? process.env;
    const baseRoots = fleetRoots(ctx.cwd, env);
    const roots = deps.bundledDir ? { ...baseRoots, bundledDir: deps.bundledDir } : baseRoots;
    const providers = [...new Set(ctx.modelRegistry.getAll().map((model) => model.provider))];
    const configuredProviders = providers.filter(
      (provider) => ctx.modelRegistry.getProviderAuthStatus(provider).configured,
    );
    const fleets = discoverFleets(roots)
      .filter((source) => !source.shadowed)
      .map((source) => ({ name: source.name, scope: source.scope }));

    pi.sendUserMessage(
      buildSetupBriefing({
        schema: schemaReference(),
        configuredProviders,
        fleets,
        targetDir: roots.projectDirs[0] ?? join(ctx.cwd, ".orphus", "fleets"),
        hasIssueTrackerConfig: existsSync(join(ctx.cwd, "docs", "agents", "issue-tracker.md")),
        gitRemote: readGitRemote(ctx.cwd),
      }),
      { deliverAs: "followUp" },
    );
  };
}

export function registerFleetSetupCommand(pi: ExtensionAPI, deps: FleetSetupDeps = {}): void {
  pi.registerCommand("fleetsetup", {
    description: "Create or edit a fleet blueprint through an interview",
    handler: createFleetSetupHandler(pi, deps) as never,
  });
}
