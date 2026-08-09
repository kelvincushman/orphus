import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Blueprint discovery: project `.orphus/fleets/` (with `.atomic`/`.pi` lineage
 * fallbacks) plus the user agent dir's `fleets/`. Project shadows user, and the
 * first project config dir that carries a name wins within project scope.
 *
 * The agent-dir/lineage resolution mirrors packages/roundtable/broker/paths.ts,
 * the same contract the broker socket uses — kept local because neither package
 * exports it and a cross-package deep import would bypass their exports maps.
 */

const FLEET_SUFFIX = ".fleet.yaml";
/** Fork lineage, matching CONFIG_DIR_NAMES in the coding agent. */
const CONFIG_DIR_NAMES = [".orphus", ".atomic", ".pi"] as const;

function getHomeDir(): string {
  if (process.platform === "win32") {
    if (process.env.USERPROFILE) return process.env.USERPROFILE;
    if (process.env.HOMEDRIVE && process.env.HOMEPATH) return `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`;
    if (process.env.HOME) return process.env.HOME;
    return homedir();
  }
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

function expandTildePath(path: string): string {
  if (path === "~") return getHomeDir();
  if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
    return join(getHomeDir(), path.slice(2));
  }
  return path;
}

function getAgentDir(env: NodeJS.ProcessEnv): string {
  if (env.ORPHUS_CODING_AGENT_DIR) return expandTildePath(env.ORPHUS_CODING_AGENT_DIR);
  if (env.ATOMIC_CODING_AGENT_DIR) return expandTildePath(env.ATOMIC_CODING_AGENT_DIR);
  if (env.PI_CODING_AGENT_DIR) return expandTildePath(env.PI_CODING_AGENT_DIR);
  return join(getHomeDir(), ".orphus", "agent");
}

export interface FleetRoots {
  /** Project fleet dirs in precedence order (.orphus, .atomic, .pi). */
  readonly projectDirs: readonly string[];
  readonly userDir: string;
}

export interface FleetSource {
  /** Blueprint name derived from the filename (`<name>.fleet.yaml`). */
  readonly name: string;
  readonly path: string;
  readonly scope: "project" | "user";
  /** True when a higher-precedence source carries the same name. */
  readonly shadowed: boolean;
}

export function fleetRoots(cwd: string, env: NodeJS.ProcessEnv = process.env): FleetRoots {
  return {
    projectDirs: CONFIG_DIR_NAMES.map((dirName) => join(cwd, dirName, "fleets")),
    userDir: join(getAgentDir(env), "fleets"),
  };
}

function fleetsIn(dir: string, scope: "project" | "user"): Omit<FleetSource, "shadowed">[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(FLEET_SUFFIX))
    .map((entry) => ({
      name: entry.name.slice(0, -FLEET_SUFFIX.length),
      path: join(dir, entry.name),
      scope,
    }));
}

/** Enumerate blueprints, sorted by name, marking shadowed lower-precedence entries. */
export function discoverFleets(roots: FleetRoots): FleetSource[] {
  const seen = new Set<string>();
  const results: FleetSource[] = [];
  const scopes: Array<{ dirs: readonly string[]; scope: "project" | "user" }> = [
    { dirs: roots.projectDirs, scope: "project" },
    { dirs: [roots.userDir], scope: "user" },
  ];
  for (const { dirs, scope } of scopes) {
    const scopeSeen = new Set<string>();
    for (const dir of dirs) {
      for (const entry of fleetsIn(dir, scope)) {
        // Within a scope the first lineage dir wins outright; across scopes a
        // lower-precedence duplicate is listed but marked shadowed, so tooling
        // can show the user both rather than silently hiding one.
        if (scopeSeen.has(entry.name)) continue;
        scopeSeen.add(entry.name);
        const shadowed = seen.has(entry.name);
        seen.add(entry.name);
        results.push({ ...entry, shadowed });
      }
    }
  }
  return results.sort((a, b) => (a.name === b.name ? (a.scope === "project" ? -1 : 1) : a.name < b.name ? -1 : 1));
}
