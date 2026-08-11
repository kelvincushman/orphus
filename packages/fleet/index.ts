import type { ExtensionAPI } from "@orphus/coding-agent";
import { registerFleetCommand } from "./commands/fleet-command.ts";
import { registerFleetSetupCommand } from "./commands/fleetsetup-command.ts";
import { registerFleetTool } from "./fleet-tool.ts";

/**
 * Fleet extension: community-shareable orchestration blueprints.
 *
 * A blueprint (`.orphus/fleets/<name>.fleet.yaml`) binds teams of agent
 * definitions — with pre-assigned skills — to deliberation rooms and dispatch
 * fan-out. `/fleet <name> <task>` runs one; `/fleetsetup` authors one by
 * interview; the `fleet` tool gives the model list/get/validate introspection.
 *
 * The extension executes nothing itself: members are spawned by the model via
 * the existing `subagent` tool (whose per-task `name` keeps broker identities
 * distinct), deliberation happens in roundtable rooms, and the protocol lives
 * in the fleet-orchestration skill.
 */
export default function fleetExtension(pi: ExtensionAPI): void {
  registerFleetTool(pi, { cwd: () => process.cwd() });
  registerFleetCommand(pi);
  registerFleetSetupCommand(pi);
}
