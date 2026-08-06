import { accessSync, constants, existsSync, readFileSync, statSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";
import { parse as parseYaml } from "yaml";
import { RoleManifestError, type RoleBudgets, type RoleManifest, type RoleSpec } from "./types.ts";

/**
 * Parse and validate an `orphus.roles.yaml`.
 *
 * Validation is strict and fails fast: a manifest is launch configuration, and
 * a silently-wrong one produces sessions that look right and deliberate wrong.
 * Every message names the file and the exact key path.
 */

const DEFAULT_DIGEST_BUDGET = 2000;
const DEFAULT_PER_MESSAGE_CAP = 600;
/** Orca's selector for "the worktree I am already in". */
const DEFAULT_WORKTREE = "active";

/** Room and role names key cursors broker-side, so keep them boring and stable. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reject any key not in `allowed`. A misspelled OPTIONAL key (worktree, cwd,
 * brief, a per-role room, a budget) would otherwise be silently dropped and its
 * default substituted, emitting a launch command that quietly ignores intent.
 */
function rejectUnknownKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  manifestPath: string,
  prefix: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      fail(manifestPath, prefix ? `${prefix}.${key}` : key, `unknown key; allowed here: ${allowed.join(", ")}`);
    }
  }
}

function fail(manifestPath: string, keyPath: string, problem: string): never {
  throw new RoleManifestError(`${manifestPath}: ${keyPath} — ${problem}`);
}

function requireString(value: unknown, manifestPath: string, keyPath: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(manifestPath, keyPath, `expected a non-empty string, got ${describe(value)}`);
  }
  return value.trim();
}

function requireName(value: unknown, manifestPath: string, keyPath: string): string {
  const text = requireString(value, manifestPath, keyPath);
  if (!NAME_PATTERN.test(text)) {
    fail(manifestPath, keyPath, `"${text}" must be alphanumeric with - or _ (it keys broker-side cursors)`);
  }
  return text;
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (isRecord(value)) return "a map";
  return `${typeof value} (${JSON.stringify(value)})`;
}

function parsePositiveInt(value: unknown, manifestPath: string, keyPath: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(manifestPath, keyPath, `expected a positive integer, got ${describe(value)}`);
  }
  return value;
}

function parseBudgets(raw: unknown, manifestPath: string): RoleBudgets {
  if (raw === undefined) return { digest: DEFAULT_DIGEST_BUDGET, perMessage: DEFAULT_PER_MESSAGE_CAP };
  if (!isRecord(raw)) fail(manifestPath, "budgets", `expected a map, got ${describe(raw)}`);
  rejectUnknownKeys(raw, ["digest", "perMessage"], manifestPath, "budgets");
  return {
    digest: parsePositiveInt(raw.digest, manifestPath, "budgets.digest", DEFAULT_DIGEST_BUDGET),
    perMessage: parsePositiveInt(raw.perMessage, manifestPath, "budgets.perMessage", DEFAULT_PER_MESSAGE_CAP),
  };
}

function resolveFrom(dir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(dir, path);
}

function parseRole(name: string, raw: unknown, manifestPath: string, dir: string, defaultRoom: string): RoleSpec {
  const keyPath = `roles.${name}`;
  if (!isRecord(raw)) fail(manifestPath, keyPath, `expected a map of role settings, got ${describe(raw)}`);
  rejectUnknownKeys(raw, ["provider", "model", "room", "cwd", "worktree", "brief"], manifestPath, keyPath);

  const spec: RoleSpec = {
    name: requireName(name, manifestPath, `${keyPath} (role name)`),
    provider: requireString(raw.provider, manifestPath, `${keyPath}.provider`),
    model: requireString(raw.model, manifestPath, `${keyPath}.model`),
    room: raw.room === undefined ? defaultRoom : requireName(raw.room, manifestPath, `${keyPath}.room`),
    cwd: raw.cwd === undefined ? dir : resolveFrom(dir, requireString(raw.cwd, manifestPath, `${keyPath}.cwd`)),
    worktree:
      raw.worktree === undefined ? DEFAULT_WORKTREE : requireString(raw.worktree, manifestPath, `${keyPath}.worktree`),
  };

  if (raw.brief === undefined) return spec;

  const briefPath = resolveFrom(dir, requireString(raw.brief, manifestPath, `${keyPath}.brief`));
  // A bad brief path is not a soft failure downstream: --append-system-prompt
  // treats an unreadable path as literal prompt text, so a typo (or a directory,
  // or an unreadable file) would quietly become the role's system prompt instead
  // of erroring. existsSync alone is not enough — it is true for a directory.
  if (!existsSync(briefPath)) fail(manifestPath, `${keyPath}.brief`, `file not found: ${briefPath}`);
  if (!statSync(briefPath).isFile()) fail(manifestPath, `${keyPath}.brief`, `not a regular file: ${briefPath}`);
  try {
    accessSync(briefPath, constants.R_OK);
  } catch {
    fail(manifestPath, `${keyPath}.brief`, `not readable: ${briefPath}`);
  }
  return { ...spec, briefPath };
}

/** Parse manifest text. `manifestPath` is used for path resolution and errors. */
export function parseRoleManifest(text: string, manifestPath: string): RoleManifest {
  const path = resolve(manifestPath);
  const dir = dirname(path);

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new RoleManifestError(`${path}: invalid YAML — ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(raw)) fail(path, "(document)", `expected a map at the top level, got ${describe(raw)}`);
  rejectUnknownKeys(raw, ["task", "room", "roles", "budgets"], path, "");

  const task = requireName(raw.task, path, "task");
  const room = requireName(raw.room, path, "room");
  const budgets = parseBudgets(raw.budgets, path);

  if (!isRecord(raw.roles)) fail(path, "roles", `expected a map of role name to settings, got ${describe(raw.roles)}`);
  const entries = Object.entries(raw.roles);
  if (entries.length === 0) fail(path, "roles", "at least one role is required");

  const roles = entries.map(([name, value]) => parseRole(name, value, path, dir, room));

  return { task, room, roles, budgets, dir, path };
}

/** Read and parse a manifest from disk. */
export function loadRoleManifest(manifestPath: string): RoleManifest {
  const path = resolve(manifestPath);
  if (!existsSync(path)) throw new RoleManifestError(`manifest not found: ${path}`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new RoleManifestError(
      `${path}: unable to read manifest — ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return parseRoleManifest(text, path);
}
