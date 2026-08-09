import type { ExtensionAPI, ToolDefinition } from "@bastani/atomic";
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
}

function errorResult(text: string): FleetToolResult {
  return { content: [{ type: "text", text }], isError: true, details: { error: true } };
}

function okResult(text: string, details: FleetToolDetails = {}): FleetToolResult {
  return { content: [{ type: "text", text }], isError: false, details };
}

function sources(deps: FleetToolDeps): FleetSource[] {
  return discoverFleets(fleetRoots(deps.cwd(), deps.env ?? process.env));
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
export function validateFleet(deps: FleetToolDeps, target: { name?: string; path?: string }): FleetToolResult {
  try {
    let blueprint: FleetBlueprint;
    if (target.path) {
      blueprint = loadFleetBlueprint(target.path);
    } else {
      const loaded = loadNamed(deps, target.name ?? "");
      if ("isError" in loaded) return loaded;
      blueprint = loaded.blueprint;
    }
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

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<FleetToolResult> {
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
          return validateFleet(deps, { ...(name ? { name } : {}), ...(path ? { path } : {}) });
        default:
          return errorResult(`Unknown action: ${action satisfies never}`);
      }
    },
  } satisfies ToolDefinition<typeof FleetParameters, FleetToolDetails>;
}

export function registerFleetTool(pi: ExtensionAPI, deps: FleetToolDeps): void {
  pi.registerTool(createFleetTool(deps));
}
