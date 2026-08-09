import type { ExtensionAPI } from "@bastani/atomic";
import { discoverFleets, fleetRoots } from "../blueprint/discovery.ts";
import { loadFleetBlueprint } from "../blueprint/manifest.ts";
import { renderFleetRunPrompt } from "../blueprint/render.ts";
import { FleetBlueprintError } from "../blueprint/types.ts";
import { type FleetToolDeps, listFleets, validateFleet } from "../fleet-tool.ts";

/**
 * `/fleet` — run a blueprint. The handler wires context and hands off: it
 * loads and validates, optionally pins the orchestrator model, names the lead
 * session, and sends ONE user message carrying the rendered run prompt. The
 * orchestration itself is the model's job from there.
 *
 *   /fleet                      list blueprints
 *   /fleet validate <name>      validate without running
 *   /fleet <name> <task…>       run
 */

export interface FleetCommandDeps {
  env?: NodeJS.ProcessEnv;
}

/** Minimal surface of ExtensionCommandContext the handler touches (stub-friendly). */
interface CommandContextLike {
  cwd: string;
  modelRegistry: {
    find(provider: string, modelId: string): unknown;
    getProviderAuthStatus(provider: string): { configured: boolean };
  };
}

function notify(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({ customType: "fleet", content, display: true });
}

export function createFleetCommandHandler(pi: ExtensionAPI, deps: FleetCommandDeps = {}) {
  return async (args: string, ctx: CommandContextLike): Promise<void> => {
    const env = deps.env ?? process.env;
    const toolDeps: FleetToolDeps = { cwd: () => ctx.cwd, env };
    const trimmed = args.trim();

    if (trimmed === "" || trimmed === "list") {
      notify(pi, listFleets(toolDeps).content[0]?.text ?? "");
      return;
    }

    const [first, ...rest] = trimmed.split(/\s+/u);
    if (first === "validate") {
      const name = rest[0];
      if (!name) {
        notify(pi, "usage: /fleet validate <name>");
        return;
      }
      notify(pi, validateFleet(toolDeps, { name }).content[0]?.text ?? "");
      return;
    }

    const name = first as string;
    const task = rest.join(" ").trim();
    const all = discoverFleets(fleetRoots(ctx.cwd, env));
    const source = all.find((entry) => entry.name === name && !entry.shadowed);
    if (!source) {
      const names = all.filter((entry) => !entry.shadowed).map((entry) => entry.name);
      notify(
        pi,
        `No blueprint named "${name}".${names.length ? ` Available: ${names.join(", ")}` : " /fleetsetup creates one."}`,
      );
      return;
    }
    if (!task) {
      notify(pi, `usage: /fleet ${name} <task>`);
      return;
    }

    let blueprint;
    try {
      blueprint = loadFleetBlueprint(source.path);
    } catch (error) {
      if (error instanceof FleetBlueprintError) {
        notify(pi, `Blueprint failed validation — fix it (or run /fleetsetup) first:\n${error.message}`);
        return;
      }
      throw error;
    }

    // Pin the orchestrator model the user chose at setup. A model that is not
    // configured aborts BEFORE any turn: silently orchestrating on the wrong
    // model is exactly the surprise the blueprint field exists to prevent.
    if (blueprint.orchestratorModel) {
      const [provider, ...idParts] = blueprint.orchestratorModel.split("/");
      const modelId = idParts.join("/");
      const model = provider && modelId ? ctx.modelRegistry.find(provider, modelId) : undefined;
      if (!model) {
        notify(
          pi,
          `Orchestrator model "${blueprint.orchestratorModel}" is not in the model registry. Pick one with /model, or fix orchestrator.model in ${source.path}.`,
        );
        return;
      }
      const switched = await pi.setModel(model as Parameters<ExtensionAPI["setModel"]>[0]);
      if (!switched) {
        notify(
          pi,
          `Orchestrator model "${blueprint.orchestratorModel}" has no configured credentials. Run /login ${provider} first.`,
        );
        return;
      }
    }

    if (!pi.getSessionName()) pi.setSessionName(`fleet-${blueprint.name}-lead`);
    for (const warning of blueprint.warnings) notify(pi, `warning: ${warning}`);
    pi.sendUserMessage(renderFleetRunPrompt(blueprint, task), { deliverAs: "followUp" });
  };
}

export function registerFleetCommand(pi: ExtensionAPI, deps: FleetCommandDeps = {}): void {
  pi.registerCommand("fleet", {
    description: "Run a fleet blueprint: /fleet <name> <task> — or list (bare) / validate <name>",
    handler: createFleetCommandHandler(pi, deps) as never,
  });
}
