import { type Dirent, existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { FleetBlueprintError } from "./types.js";

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
  /** The package's shipped examples — always discoverable, lowest precedence. */
  readonly bundledDir: string;
}

export interface FleetSource {
  /** Blueprint name derived from the filename (`<name>.fleet.yaml`). */
  readonly name: string;
  readonly path: string;
  readonly scope: "project" | "user" | "bundled";
  /** True when a higher-precedence source carries the same name. */
  readonly shadowed: boolean;
}

export function fleetRoots(cwd: string, env: NodeJS.ProcessEnv = process.env): FleetRoots {
  return {
    projectDirs: CONFIG_DIR_NAMES.map((dirName) => join(cwd, dirName, "fleets")),
    userDir: join(getAgentDir(env), "fleets"),
    // The shipped starting points. Copy one into a project or user fleets dir
    // (or reference it by name) and edit from there — /fleetsetup does this.
    bundledDir: join(dirname(fileURLToPath(import.meta.url)), "..", "examples"),
  };
}

function fleetsIn(dir: string, scope: FleetSource["scope"]): Omit<FleetSource, "shadowed">[] {
  if (!existsSync(dir)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    // existsSync passes for a regular file squatting where a fleets directory
    // is expected (ENOTDIR) and for a directory this user cannot read (EACCES);
    // a raw fs error here escapes every FleetBlueprintError-only catch upstream.
    throw new FleetBlueprintError(
      `${dir}: cannot list fleets — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return entries
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
  const scopes: Array<{ dirs: readonly string[]; scope: FleetSource["scope"] }> = [
    { dirs: roots.projectDirs, scope: "project" },
    { dirs: [roots.userDir], scope: "user" },
    { dirs: [roots.bundledDir], scope: "bundled" },
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
  const rank = { project: 0, user: 1, bundled: 2 } as const;
  return results.sort((a, b) => (a.name === b.name ? rank[a.scope] - rank[b.scope] : a.name < b.name ? -1 : 1));
}
