import type { ExtensionAPI, ToolDefinition } from "@orphus/coding-agent";
import { type Static, Type } from "typebox";
import { discoverFleets, fleetRoots, type FleetSource } from "./blueprint/discovery.ts";
import { loadFleetBlueprint } from "./blueprint/manifest.ts";
import { FleetBlueprintError, type FleetBlueprint } from "./blueprint/types.ts";

/**
 * The `fleet` tool: blueprint introspection for the model. `list` and `get`
 * let an orchestrator (or the /fleetsetup interview) see what exists; `validate`
 * is the authoring loop's gate — the interview iterates it until clean. It
 * executes nothing: running a fleet is /fleet's job, and the orchestration
 * itself belongs to the model via the subagent and roundtable tools.
 */

const FleetParameters = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("get"), Type.Literal("validate")], {
    description: "Action to perform",
  }),
  name: Type.Optional(Type.String({ description: "Blueprint name (for 'get' and 'validate')" })),
  path: Type.Optional(Type.String({ description: "Explicit blueprint path (for 'validate' before it is discoverable)" })),
});

export type FleetToolParams = Static<typeof FleetParameters>;

export interface FleetToolDetails {
  error?: boolean;
  fleets?: number;
  path?: string;
  warnings?: number;
}

export interface FleetToolResult {
  isError: boolean;
  content: Array<{ type: "text"; text: string }>;
  details: FleetToolDetails;
}

export interface FleetToolDeps {
  cwd(): string;
  env?: NodeJS.ProcessEnv;
  /** Test override for the shipped-examples dir; defaults to the package's. */
  bundledDir?: string;
}

export interface FleetModelRegistry {
  getAll(): ReadonlyArray<{ provider: string; id: string }>;
  getAvailable(): ReadonlyArray<{ provider: string; id: string }>;
}

interface FleetModelContext {
  readonly modelRegistry: FleetModelRegistry;
  readonly model?: { provider: string; id: string };
}

const THINKING_SUFFIXES = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** The `:level` a model reference carries, when it is one the runtime accepts. */
export function thinkingSuffix(reference: string): string | undefined {
  const colon = reference.lastIndexOf(":");
  const suffix = colon >= 0 ? reference.slice(colon + 1) : "";
  return THINKING_SUFFIXES.has(suffix) ? suffix : undefined;
}

export function baseModelReference(reference: string): string {
  const colon = reference.lastIndexOf(":");
  return colon >= 0 && THINKING_SUFFIXES.has(reference.slice(colon + 1)) ? reference.slice(0, colon) : reference;
}

function matchingModels(reference: string, models: ReadonlyArray<{ provider: string; id: string }>) {
  const base = baseModelReference(reference);
  const slash = base.indexOf("/");
  if (slash > 0) {
    const provider = base.slice(0, slash);
    const id = base.slice(slash + 1);
    return models.filter((model) => model.provider === provider && model.id === id);
  }
  return models.filter((model) => model.id === base);
}

/** Ensure every pinned member model resolves without the subagent runtime falling back silently. */
export function validateFleetModelPins(blueprint: FleetBlueprint, ctx: FleetModelContext): string | undefined {
  const all = ctx.modelRegistry.getAll();
  const available = ctx.modelRegistry.getAvailable();
  let preferredProvider = ctx.model?.provider;
  if (blueprint.orchestratorModel) {
    const keyPath = "orchestrator.model";
    const base = baseModelReference(blueprint.orchestratorModel);
    const slash = base.indexOf("/");
    if (slash <= 0 || slash === base.length - 1) {
      return `${blueprint.path}: ${keyPath} — expected provider/model, got "${blueprint.orchestratorModel}"`;
    }
    preferredProvider = base.slice(0, slash);
    if (matchingModels(blueprint.orchestratorModel, available).length === 0) {
      if (matchingModels(blueprint.orchestratorModel, all).length === 0) {
        return `${blueprint.path}: ${keyPath} — "${blueprint.orchestratorModel}" is not in the model registry`;
      }
      return `${blueprint.path}: ${keyPath} — "${blueprint.orchestratorModel}" has no configured credentials; run /login ${preferredProvider} first`;
    }
  }
  for (const team of blueprint.teams) {
    for (const [index, member] of team.members.entries()) {
      if (!member.model) continue;
      const keyPath = `teams.${team.name}.members[${index}].model`;
      const availableMatches = matchingModels(member.model, available);
      if (!member.model.includes("/") && availableMatches.length > 1) {
        const preferred = availableMatches.find((model) => model.provider === preferredProvider);
        if (!preferred) {
          return `${blueprint.path}: ${keyPath} — "${member.model}" is ambiguous across configured providers (${availableMatches
            .map((model) => model.provider)
            .join(", ")}); use provider/model`;
        }
      }
      if (availableMatches.length > 0) continue;

      const knownMatches = matchingModels(member.model, all);
      if (knownMatches.length === 0) {
        return `${blueprint.path}: ${keyPath} — "${member.model}" is not in the model registry`;
      }
      const providers = [...new Set(knownMatches.map((model) => model.provider))];
      return `${blueprint.path}: ${keyPath} — "${member.model}" has no configured credentials; run ${providers
        .map((provider) => `/login ${provider}`)
        .join(" or ")} first`;
    }
  }
  // The gate model fails at the most expensive possible moment — after the
  // whole pipeline has run — so it preflights with everything else. Its most
  // likely author is /fleetsetup asking a model to name it, which is exactly
  // how an unregistered id gets written.
  if (blueprint.gate?.model) {
    const keyPath = "gate.model";
    const base = baseModelReference(blueprint.gate.model);
    const slash = base.indexOf("/");
    if (slash <= 0 || slash === base.length - 1) {
      return `${blueprint.path}: ${keyPath} — expected provider/model, got "${blueprint.gate.model}"`;
    }
    if (matchingModels(blueprint.gate.model, available).length === 0) {
      if (matchingModels(blueprint.gate.model, all).length === 0) {
        return `${blueprint.path}: ${keyPath} — "${blueprint.gate.model}" is not in the model registry`;
      }
      return `${blueprint.path}: ${keyPath} — "${blueprint.gate.model}" has no configured credentials; run /login ${base.slice(0, slash)} first`;
    }
  }
  return undefined;
}

function errorResult(text: string): FleetToolResult {
  return { content: [{ type: "text", text }], isError: true, details: { error: true } };
}

function okResult(text: string, details: FleetToolDetails = {}): FleetToolResult {
  return { content: [{ type: "text", text }], isError: false, details };
}

function sources(deps: FleetToolDeps): FleetSource[] {
  const roots = fleetRoots(deps.cwd(), deps.env ?? process.env);
  return discoverFleets(deps.bundledDir ? { ...roots, bundledDir: deps.bundledDir } : roots);
}

/** Resolve a name to its winning (unshadowed) source. */
export function resolveFleetSource(name: string, all: FleetSource[]): FleetSource | undefined {
  return all.find((source) => source.name === name && !source.shadowed);
}

function availableNames(all: FleetSource[]): string {
  const names = all.filter((source) => !source.shadowed).map((source) => source.name);
  return names.length ? `Available: ${names.join(", ")}` : "No fleet blueprints exist yet — /fleetsetup creates one.";
}

function describeBlueprint(blueprint: FleetBlueprint): string {
  const teams = blueprint.teams.map((team) => {
    const members = team.members
      .map((member) => (member.count > 1 ? `${member.agent}×${member.count}` : member.agent))
      .join(", ");
    return `  ${team.name} — ${team.mode} — room #${team.room} — members: ${members}`;
  });
  return [
    `${blueprint.name}: ${blueprint.description}`,
    blueprint.orchestratorModel ? `orchestrator model: ${blueprint.orchestratorModel}` : undefined,
    `pipeline: ${blueprint.pipeline.join(" → ")}`,
    ...teams,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/** Shared by the fleet tool and the /fleet command. */
export function listFleets(deps: FleetToolDeps): FleetToolResult {
  const all = sources(deps);
  if (all.length === 0) return okResult("No fleet blueprints found. /fleetsetup creates one.", { fleets: 0 });
  const lines = all.map((source) => {
    let summary: string;
    try {
      summary = loadFleetBlueprint(source.path).description;
    } catch (error) {
      summary = `INVALID — ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`;
    }
    const shadow = source.shadowed ? ", shadowed" : "";
    return `${source.name} (${source.scope}${shadow}) — ${summary}`;
  });
  return okResult(lines.join("\n"), { fleets: all.length });
}

/** Shared by the fleet tool and the /fleet command. */
export function validateFleet(
  deps: FleetToolDeps,
  target: { name?: string; path?: string },
  modelContext?: FleetModelContext,
): FleetToolResult {
  try {
    let blueprint: FleetBlueprint;
    if (target.path) {
      blueprint = loadFleetBlueprint(target.path);
    } else {
      const loaded = loadNamed(deps, target.name ?? "");
      if ("isError" in loaded) return loaded;
      blueprint = loaded.blueprint;
    }
    const modelError = modelContext ? validateFleetModelPins(blueprint, modelContext) : undefined;
    if (modelError) return errorResult(modelError);
    const warningLines = blueprint.warnings.length
      ? `\nWarnings:\n${blueprint.warnings.map((warning) => `  - ${warning}`).join("\n")}`
      : "";
    return okResult(`Blueprint "${blueprint.name}" is valid.${warningLines}`, {
      path: blueprint.path,
      warnings: blueprint.warnings.length,
    });
  } catch (error) {
    if (error instanceof FleetBlueprintError) return errorResult(error.message);
    throw error;
  }
}

function loadNamed(deps: FleetToolDeps, name: string): { blueprint: FleetBlueprint; source: FleetSource } | FleetToolResult {
  const all = sources(deps);
  const source = resolveFleetSource(name, all);
  if (!source) return errorResult(`No blueprint named "${name}". ${availableNames(all)}`);
  try {
    return { blueprint: loadFleetBlueprint(source.path), source };
  } catch (error) {
    if (error instanceof FleetBlueprintError) return errorResult(error.message);
    throw error;
  }
}

export function createFleetTool(deps: FleetToolDeps) {
  return {
    name: "fleet",
    label: "Fleet",
    description: `Fleet blueprint introspection. Blueprints live in .orphus/fleets/*.fleet.yaml (project) and <agentDir>/fleets/ (user).
  fleet({ action: "list" })                      → discovered blueprints with scope
  fleet({ action: "get", name: "coding-team" })  → teams, modes, rooms, members
  fleet({ action: "validate", name: "…" })       → strict validation with warnings; also accepts { path } for a file not yet discoverable
Run a fleet with the /fleet command; author one with /fleetsetup.`,
    parameters: FleetParameters,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<FleetToolResult> {
      const { action, name, path } = params;
      switch (action) {
        case "list":
          return listFleets(deps);
        case "get": {
          if (!name) return errorResult("Missing 'name' parameter");
          const loaded = loadNamed(deps, name);
          if ("isError" in loaded) return loaded;
          return okResult(describeBlueprint(loaded.blueprint), { path: loaded.source.path });
        }
        case "validate":
          if (!name && !path) return errorResult("Provide 'name' or 'path'");
          return validateFleet(
            deps,
            { ...(name ? { name } : {}), ...(path ? { path } : {}) },
            { modelRegistry: ctx.modelRegistry, ...(ctx.model ? { model: ctx.model } : {}) },
          );
        default:
          return errorResult(`Unknown action: ${action satisfies never}`);
      }
    },
  } satisfies ToolDefinition<typeof FleetParameters, FleetToolDetails>;
}

export function registerFleetTool(pi: ExtensionAPI, deps: FleetToolDeps): void {
  pi.registerTool(createFleetTool(deps));
}
