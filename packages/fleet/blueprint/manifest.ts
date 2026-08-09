import { accessSync, constants, existsSync, readFileSync, statSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";
import { parse as parseYaml } from "yaml";
import {
  FleetBlueprintError,
  type FleetBlueprint,
  type FleetBudgets,
  type FleetDefaults,
  type MemberSpec,
  type TeamMode,
  type TeamSpec,
} from "./types.ts";

/**
 * Parse and validate a `*.fleet.yaml` blueprint.
 *
 * Validation mirrors the roles manifest loader: strict and fail-fast, because a
 * blueprint is orchestration configuration — a silently-wrong one dispatches a
 * fleet that looks right and works on the wrong thing. Every error names the
 * file and the exact key path. Non-fatal findings collect into `warnings`.
 */

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_DIGEST_BUDGET = 2000;
const DEFAULT_PER_MESSAGE_CAP = 600;
const DEFAULT_ROUNDS = 2;
const MAX_ROUNDS = 10;
/** Mirrors MAX_PARALLEL_TASKS in @bastani/subagents — the dispatch ceiling. */
const MAX_TEAM_MEMBERS = 50;
const BLUEPRINT_VERSION = 1;

const TEAM_MODES: readonly TeamMode[] = ["dispatch", "deliberate", "deliberate-then-dispatch"];

/** Fleet/team/room names key broker cursors and session names — boring and stable. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
/** Agent references additionally allow dots: namespaced runtime names are package.name. */
const AGENT_REF_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, keyPath: string, problem: string): never {
  throw new FleetBlueprintError(`${path}: ${keyPath} — ${problem}`);
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (isRecord(value)) return "a map";
  return `${typeof value} (${JSON.stringify(value)})`;
}

function rejectUnknownKeys(raw: Record<string, unknown>, allowed: readonly string[], path: string, prefix: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      fail(path, prefix ? `${prefix}.${key}` : key, `unknown key; allowed here: ${allowed.join(", ")}`);
    }
  }
}

function requireString(value: unknown, path: string, keyPath: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(path, keyPath, `expected a non-empty string, got ${describe(value)}`);
  }
  return value.trim();
}

function requireName(value: unknown, path: string, keyPath: string, because: string): string {
  const text = requireString(value, path, keyPath);
  if (!NAME_PATTERN.test(text)) fail(path, keyPath, `"${text}" must be alphanumeric with - or _ (${because})`);
  return text;
}

const KEYS_CURSORS = "it keys broker-side cursors and session identity";

function parsePositiveInt(value: unknown, path: string, keyPath: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(path, keyPath, `expected a positive integer, got ${describe(value)}`);
  }
  return value;
}

function parseSkills(value: unknown, path: string, keyPath: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(path, keyPath, `expected a list of skill names, got ${describe(value)}`);
  return value.map((entry, index) => requireString(entry, path, `${keyPath}[${index}]`));
}

function resolveFrom(dir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(dir, path);
}

function checkBriefFile(briefPath: string, path: string, keyPath: string): void {
  // Same bug class as the roles manifest: downstream consumers treat an
  // unreadable path as literal prompt text, so a typo silently becomes the
  // member's brief. existsSync alone passes for directories.
  if (!existsSync(briefPath)) fail(path, keyPath, `file not found: ${briefPath}`);
  if (!statSync(briefPath).isFile()) fail(path, keyPath, `not a regular file: ${briefPath}`);
  try {
    accessSync(briefPath, constants.R_OK);
  } catch {
    fail(path, keyPath, `not readable: ${briefPath}`);
  }
}

function parseMember(raw: unknown, path: string, dir: string, keyPath: string): MemberSpec {
  if (!isRecord(raw)) fail(path, keyPath, `expected a member map, got ${describe(raw)}`);
  rejectUnknownKeys(raw, ["agent", "brief", "briefPath", "skills", "model", "count"], path, keyPath);

  const agent = requireString(raw.agent, path, `${keyPath}.agent`);
  if (!AGENT_REF_PATTERN.test(agent)) {
    fail(path, `${keyPath}.agent`, `"${agent}" must be an agent runtime name (alphanumeric with . - _)`);
  }

  if (raw.brief !== undefined && raw.briefPath !== undefined) {
    fail(path, keyPath, "brief and briefPath are mutually exclusive — use one");
  }

  const member: MemberSpec = {
    agent,
    skills: parseSkills(raw.skills, path, `${keyPath}.skills`),
    count: parsePositiveInt(raw.count, path, `${keyPath}.count`, 1),
    ...(raw.model !== undefined ? { model: requireString(raw.model, path, `${keyPath}.model`) } : {}),
    ...(raw.brief !== undefined ? { brief: requireString(raw.brief, path, `${keyPath}.brief`) } : {}),
  };

  if (raw.briefPath === undefined) return member;
  const briefPath = resolveFrom(dir, requireString(raw.briefPath, path, `${keyPath}.briefPath`));
  checkBriefFile(briefPath, path, `${keyPath}.briefPath`);
  return { ...member, briefPath };
}

interface TeamParseResult {
  readonly team: TeamSpec;
  readonly explicitRoom: boolean;
}

function parseTeam(
  fleetName: string,
  name: string,
  raw: unknown,
  path: string,
  dir: string,
  warnings: string[],
): TeamParseResult {
  const keyPath = `teams.${name}`;
  if (!isRecord(raw)) fail(path, keyPath, `expected a map of team settings, got ${describe(raw)}`);
  rejectUnknownKeys(
    raw,
    ["mode", "room", "topic", "rounds", "skills", "group", "concurrency", "members"],
    path,
    keyPath,
  );

  const teamName = requireName(name, path, `${keyPath} (team name)`, KEYS_CURSORS);

  const mode = requireString(raw.mode, path, `${keyPath}.mode`);
  if (!TEAM_MODES.includes(mode as TeamMode)) {
    fail(path, `${keyPath}.mode`, `"${mode}" is not a mode; allowed: ${TEAM_MODES.join(", ")}`);
  }

  if (!Array.isArray(raw.members)) {
    fail(path, `${keyPath}.members`, `expected a list of members, got ${describe(raw.members)}`);
  }
  if (raw.members.length === 0) fail(path, `${keyPath}.members`, "at least one member is required");
  const members = raw.members.map((entry, index) => parseMember(entry, path, dir, `${keyPath}.members[${index}]`));

  const expanded = members.reduce((sum, member) => sum + member.count, 0);
  if (expanded > MAX_TEAM_MEMBERS) {
    fail(
      path,
      `${keyPath}.members`,
      `expands to ${expanded} members; the dispatch ceiling is ${MAX_TEAM_MEMBERS} (MAX_PARALLEL_TASKS)`,
    );
  }

  const explicitRoom = raw.room !== undefined;
  const room = explicitRoom
    ? requireName(raw.room, path, `${keyPath}.room`, KEYS_CURSORS)
    : `fleet-${fleetName}-${teamName}`;

  const rounds = parsePositiveInt(raw.rounds, path, `${keyPath}.rounds`, DEFAULT_ROUNDS);
  if (rounds > MAX_ROUNDS) fail(path, `${keyPath}.rounds`, `${rounds} exceeds the sane ceiling of ${MAX_ROUNDS}`);
  if (raw.rounds !== undefined && mode === "dispatch") {
    warnings.push(`${keyPath}.rounds has no effect: dispatch teams do not deliberate`);
  }

  const concurrency =
    raw.concurrency === undefined ? undefined : parsePositiveInt(raw.concurrency, path, `${keyPath}.concurrency`, 0);
  if (concurrency !== undefined) {
    if (concurrency > MAX_TEAM_MEMBERS) {
      fail(path, `${keyPath}.concurrency`, `${concurrency} exceeds the parallel-task ceiling of ${MAX_TEAM_MEMBERS}`);
    }
    if (concurrency > DEFAULT_CONCURRENCY) {
      warnings.push(
        `${keyPath}.concurrency ${concurrency} is above the default ${DEFAULT_CONCURRENCY} — every slot is a live model session`,
      );
    }
  }

  let group: string | true | undefined;
  if (raw.group === true) group = true;
  else if (raw.group !== undefined) group = requireString(raw.group, path, `${keyPath}.group`);

  const team: TeamSpec = {
    name: teamName,
    mode: mode as TeamMode,
    room,
    rounds,
    skills: parseSkills(raw.skills, path, `${keyPath}.skills`),
    members,
    ...(raw.topic !== undefined ? { topic: requireString(raw.topic, path, `${keyPath}.topic`) } : {}),
    ...(group !== undefined ? { group } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
  };
  return { team, explicitRoom };
}

function parseDefaults(raw: unknown, path: string): FleetDefaults {
  const fallbackBudgets: FleetBudgets = { digest: DEFAULT_DIGEST_BUDGET, perMessage: DEFAULT_PER_MESSAGE_CAP };
  if (raw === undefined) return { concurrency: DEFAULT_CONCURRENCY, budgets: fallbackBudgets };
  if (!isRecord(raw)) fail(path, "defaults", `expected a map, got ${describe(raw)}`);
  rejectUnknownKeys(raw, ["concurrency", "budgets"], path, "defaults");

  let budgets = fallbackBudgets;
  if (raw.budgets !== undefined) {
    if (!isRecord(raw.budgets)) fail(path, "defaults.budgets", `expected a map, got ${describe(raw.budgets)}`);
    rejectUnknownKeys(raw.budgets, ["digest", "perMessage"], path, "defaults.budgets");
    budgets = {
      digest: parsePositiveInt(raw.budgets.digest, path, "defaults.budgets.digest", DEFAULT_DIGEST_BUDGET),
      perMessage: parsePositiveInt(
        raw.budgets.perMessage,
        path,
        "defaults.budgets.perMessage",
        DEFAULT_PER_MESSAGE_CAP,
      ),
    };
  }
  return {
    concurrency: parsePositiveInt(raw.concurrency, path, "defaults.concurrency", DEFAULT_CONCURRENCY),
    budgets,
  };
}

/** Parse blueprint text. `blueprintPath` is used for path resolution and errors. */
export function parseFleetBlueprint(text: string, blueprintPath: string): FleetBlueprint {
  const path = resolve(blueprintPath);
  const dir = dirname(path);

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new FleetBlueprintError(`${path}: invalid YAML — ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(raw)) fail(path, "(document)", `expected a map at the top level, got ${describe(raw)}`);
  rejectUnknownKeys(raw, ["name", "description", "version", "orchestrator", "defaults", "teams", "pipeline"], path, "");

  const name = requireName(raw.name, path, "name", "it names default rooms and the lead session");
  const description = requireString(raw.description, path, "description");

  const version = raw.version === undefined ? BLUEPRINT_VERSION : raw.version;
  if (version !== BLUEPRINT_VERSION) {
    fail(path, "version", `this loader understands version ${BLUEPRINT_VERSION}, got ${describe(raw.version)}`);
  }

  let orchestratorModel: string | undefined;
  if (raw.orchestrator !== undefined) {
    if (!isRecord(raw.orchestrator)) fail(path, "orchestrator", `expected a map, got ${describe(raw.orchestrator)}`);
    rejectUnknownKeys(raw.orchestrator, ["model"], path, "orchestrator");
    if (raw.orchestrator.model !== undefined) {
      orchestratorModel = requireString(raw.orchestrator.model, path, "orchestrator.model");
    }
  }

  const defaults = parseDefaults(raw.defaults, path);

  if (!isRecord(raw.teams)) fail(path, "teams", `expected a map of team name to settings, got ${describe(raw.teams)}`);
  const teamEntries = Object.entries(raw.teams);
  if (teamEntries.length === 0) fail(path, "teams", "at least one team is required");

  const warnings: string[] = [];
  const parsed = teamEntries.map(([teamName, value]) => parseTeam(name, teamName, value, path, dir, warnings));
  const teams = parsed.map((entry) => entry.team);

  // Two teams sharing an EXPLICIT room merge their deliberations broker-side.
  // That can be intent (a joint room), so it warns rather than fails; default
  // rooms embed the team name and cannot collide.
  const explicitRooms = new Map<string, string>();
  for (const entry of parsed) {
    if (!entry.explicitRoom) continue;
    const previous = explicitRooms.get(entry.team.room);
    if (previous !== undefined) {
      warnings.push(
        `teams ${previous} and ${entry.team.name} share room "${entry.team.room}" — their deliberations will merge`,
      );
    } else {
      explicitRooms.set(entry.team.room, entry.team.name);
    }
  }

  let pipeline: readonly string[];
  if (raw.pipeline === undefined) {
    pipeline = teams.map((team) => team.name);
  } else {
    if (!Array.isArray(raw.pipeline)) fail(path, "pipeline", `expected a list of team names, got ${describe(raw.pipeline)}`);
    const known = new Set(teams.map((team) => team.name));
    pipeline = raw.pipeline.map((entry, index) => {
      const teamName = requireString(entry, path, `pipeline[${index}]`);
      if (!known.has(teamName)) fail(path, `pipeline[${index}]`, `"${teamName}" is not a declared team`);
      return teamName;
    });
  }

  return {
    name,
    description,
    version,
    defaults,
    teams,
    pipeline,
    warnings,
    dir,
    path,
    ...(orchestratorModel !== undefined ? { orchestratorModel } : {}),
  };
}

/** Read and parse a blueprint from disk. */
export function loadFleetBlueprint(blueprintPath: string): FleetBlueprint {
  const path = resolve(blueprintPath);
  if (!existsSync(path)) throw new FleetBlueprintError(`blueprint not found: ${path}`);
  return parseFleetBlueprint(readFileSync(path, "utf8"), path);
}
