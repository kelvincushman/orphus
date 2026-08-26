import type { Static } from "typebox";
import { Value } from "typebox/value";
import { goalExecutionPlanSchema } from "./goal-schemas.js";

export type GoalExecutionPlanInput = Static<typeof goalExecutionPlanSchema>;
export type GoalExecutionTier = GoalExecutionPlanInput["leaves"][number]["tier"];
export type GoalExecutionCheck = Readonly<GoalExecutionPlanInput["leaves"][number]["checks"][number]>;
export type GoalExecutionLeaf = Readonly<
  Omit<GoalExecutionPlanInput["leaves"][number], "checks" | "needs" | "owns"> & {
    readonly owns: readonly string[];
    readonly needs: readonly string[];
    readonly checks: readonly GoalExecutionCheck[];
  }
>;
export type GoalExecutionPlan = Readonly<{
  version: 1;
  leaves: readonly GoalExecutionLeaf[];
}>;

export type GoalExecutionPlanBounds = {
  readonly minLeaves?: number;
  readonly maxLeaves?: number;
};

export class GoalExecutionPlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalExecutionPlanValidationError";
  }
}

const LEAF_ID_PATTERN = /^[1-9]\d*(?:\.[1-9]\d*)*$/;
const GLOB_CHARS = /[*?[\]{}]/;

export function normalizeGoalExecutionPlan(input: unknown, bounds: GoalExecutionPlanBounds = {}): GoalExecutionPlan {
  if (!Value.Check(goalExecutionPlanSchema, input)) {
    throw new GoalExecutionPlanValidationError("Goal execution plan must match the v1 schema.");
  }

  const minLeaves = bounds.minLeaves ?? 1;
  const maxLeaves = bounds.maxLeaves ?? Number.POSITIVE_INFINITY;
  if (!Number.isInteger(minLeaves) || minLeaves < 0) {
    throw new GoalExecutionPlanValidationError("Minimum leaf bound must be a non-negative integer.");
  }
  if ((maxLeaves !== Number.POSITIVE_INFINITY && !Number.isInteger(maxLeaves)) || maxLeaves < minLeaves) {
    throw new GoalExecutionPlanValidationError(
      "Maximum leaf bound must be an integer greater than or equal to minLeaves.",
    );
  }
  if (input.leaves.length < minLeaves || input.leaves.length > maxLeaves) {
    throw new GoalExecutionPlanValidationError(
      `Goal execution plan leaf count must be between ${minLeaves} and ${maxLeaves}.`,
    );
  }

  const ids = new Set<string>();
  for (const leaf of input.leaves) {
    if (!LEAF_ID_PATTERN.test(leaf.id)) {
      throw new GoalExecutionPlanValidationError(`Invalid leaf id: ${leaf.id}`);
    }
    if (ids.has(leaf.id)) {
      throw new GoalExecutionPlanValidationError(`Duplicate leaf id: ${leaf.id}`);
    }
    ids.add(leaf.id);
  }

  const normalizedLeaves = input.leaves
    .map((leaf) => ({
      id: leaf.id,
      title: requireNonEmpty(leaf.title, `Leaf ${leaf.id} title`),
      task: requireNonEmpty(leaf.task, `Leaf ${leaf.id} task`),
      owns: normalizeOwns(leaf.id, leaf.owns),
      needs: [...leaf.needs].sort(compareLeafIds),
      tier: leaf.tier,
      checks: normalizeChecks(leaf.id, leaf.checks),
    }))
    .sort((left, right) => compareLeafIds(left.id, right.id));

  for (const leaf of normalizedLeaves) {
    for (const need of leaf.needs) {
      if (need === leaf.id) {
        throw new GoalExecutionPlanValidationError(`Leaf ${leaf.id} cannot depend on itself.`);
      }
      if (!ids.has(need)) {
        throw new GoalExecutionPlanValidationError(`Leaf ${leaf.id} depends on unknown leaf ${need}.`);
      }
    }
  }

  rejectOwnershipOverlaps(normalizedLeaves);
  rejectCycles(normalizedLeaves);

  return deepFreeze({
    version: 1,
    leaves: normalizedLeaves,
  });
}

export function initialReadyLeaves(plan: GoalExecutionPlan): readonly GoalExecutionLeaf[] {
  return plan.leaves.filter((leaf) => leaf.needs.length === 0);
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new GoalExecutionPlanValidationError(`${label} must not be empty.`);
  }
  return trimmed;
}

function normalizeOwns(leafId: string, owns: readonly string[]): readonly string[] {
  if (owns.length === 0) {
    throw new GoalExecutionPlanValidationError(`Leaf ${leafId} must own at least one path.`);
  }
  return [...new Set(owns.map((path) => normalizeOwnedPath(leafId, path)))].sort();
}

function normalizeChecks(leafId: string, checks: readonly GoalExecutionCheck[]): readonly GoalExecutionCheck[] {
  if (checks.length === 0) {
    throw new GoalExecutionPlanValidationError(`Leaf ${leafId} must declare at least one check.`);
  }
  return checks.map((check) => {
    const command = requireNonEmpty(check.command, `Leaf ${leafId} check command`);
    const expect = requireNonEmpty(check.expect, `Leaf ${leafId} check expect`);
    return Object.freeze({ command, expect });
  });
}

function normalizeOwnedPath(leafId: string, rawPath: string): string {
  const path = rawPath.trim();
  if (path.length === 0) {
    throw new GoalExecutionPlanValidationError(`Leaf ${leafId} owns an empty path.`);
  }
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new GoalExecutionPlanValidationError(`Leaf ${leafId} owns absolute path ${path}.`);
  }
  if (path.includes("\\") || path.includes("//") || path.startsWith("./")) {
    throw new GoalExecutionPlanValidationError(`Leaf ${leafId} owns malformed path ${path}.`);
  }

  const isDirectoryScope = path.endsWith("/**");
  const basePath = isDirectoryScope ? path.slice(0, -3) : path;
  if (
    basePath.length === 0 ||
    basePath.endsWith("/") ||
    basePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new GoalExecutionPlanValidationError(`Leaf ${leafId} owns traversal or malformed path ${path}.`);
  }
  if (isDirectoryScope) {
    if (GLOB_CHARS.test(basePath)) {
      throw new GoalExecutionPlanValidationError(`Leaf ${leafId} owns ambiguous glob scope ${path}.`);
    }
    return `${basePath}/**`;
  }
  if (GLOB_CHARS.test(path)) {
    throw new GoalExecutionPlanValidationError(`Leaf ${leafId} owns ambiguous glob path ${path}.`);
  }
  return path;
}

function rejectOwnershipOverlaps(leaves: readonly GoalExecutionLeaf[]): void {
  for (let leftIndex = 0; leftIndex < leaves.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < leaves.length; rightIndex += 1) {
      for (const leftPath of leaves[leftIndex].owns) {
        for (const rightPath of leaves[rightIndex].owns) {
          if (ownedPathsOverlap(leftPath, rightPath)) {
            throw new GoalExecutionPlanValidationError(
              `Ownership overlap between ${leaves[leftIndex].id}:${leftPath} and ${leaves[rightIndex].id}:${rightPath}.`,
            );
          }
        }
      }
    }
  }
}

function ownedPathsOverlap(leftPath: string, rightPath: string): boolean {
  if (leftPath === rightPath) {
    return true;
  }
  const leftDirectory = directoryScopeBase(leftPath);
  const rightDirectory = directoryScopeBase(rightPath);
  if (leftDirectory !== undefined && pathIsWithin(rightPath, leftDirectory)) {
    return true;
  }
  return rightDirectory !== undefined && pathIsWithin(leftPath, rightDirectory);
}

function directoryScopeBase(path: string): string | undefined {
  return path.endsWith("/**") ? path.slice(0, -3) : undefined;
}

function pathIsWithin(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

function rejectCycles(leaves: readonly GoalExecutionLeaf[]): void {
  const byId = new Map(leaves.map((leaf) => [leaf.id, leaf]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (leaf: GoalExecutionLeaf) => {
    if (visited.has(leaf.id)) {
      return;
    }
    if (visiting.has(leaf.id)) {
      throw new GoalExecutionPlanValidationError(`Dependency cycle includes leaf ${leaf.id}.`);
    }
    visiting.add(leaf.id);
    for (const need of leaf.needs) {
      const dependency = byId.get(need);
      if (dependency !== undefined) {
        visit(dependency);
      }
    }
    visiting.delete(leaf.id);
    visited.add(leaf.id);
  };

  for (const leaf of leaves) {
    visit(leaf);
  }
}

function compareLeafIds(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const max = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < max; index += 1) {
    const leftPart = leftParts[index] ?? -1;
    const rightPart = rightParts[index] ?? -1;
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }
  return left.localeCompare(right);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}
