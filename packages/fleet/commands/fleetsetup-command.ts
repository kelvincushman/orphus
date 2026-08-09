import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { ExtensionAPI } from "@bastani/atomic";
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
    `5. Write the blueprint to ${inputs.targetDir}/<name>.fleet.yaml and iterate fleet({ action: "validate", name: "<name>" }) until it reports valid; show the user warnings and ask before ignoring any.`,
    `6. Finish by telling the user to run: /fleet <name> <task>`,
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
