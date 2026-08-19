import { validateToolArguments } from "@earendil-works/pi-ai";
import { redactCredentialFields } from "./provider-audit.ts";

/** Custom session entry type for what a tool call actually ran with. */
export const TOOL_AUDIT_ENTRY = "orphus.tool.audit.v1";

/**
 * The stages a tool call passes through. The audit record names the stage the
 * call reached, so a blocked call is distinguishable from one that never
 * validated and from one that ran.
 */
export type ToolAuditOutcome = "executed" | "blocked" | "invalid_arguments";

export interface ToolAuditRecord {
	toolCallId: string;
	toolName: string;
	outcome: ToolAuditOutcome;
	/** The arguments as they stood after every mutable hook ran. Credential-shaped values redacted. */
	arguments: unknown;
	/** Property paths a hook changed, added, or removed. Empty when hooks left the call alone. */
	mutatedPaths: string[];
	/** Why the call was blocked or rejected. Absent when it executed. */
	reason?: string;
	timestamp: number;
}

/** Enumerate the property paths at which two values differ. */
export function diffPaths(before: unknown, after: unknown, path = ""): string[] {
	if (Object.is(before, after)) return [];
	const bothPlainObjects =
		typeof before === "object" &&
		before !== null &&
		!Array.isArray(before) &&
		typeof after === "object" &&
		after !== null &&
		!Array.isArray(after);
	if (bothPlainObjects) {
		const keys = new Set([
			...Object.keys(before as Record<string, unknown>),
			...Object.keys(after as Record<string, unknown>),
		]);
		const paths: string[] = [];
		for (const key of keys) {
			const childPath = path ? `${path}.${key}` : key;
			paths.push(
				...diffPaths((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], childPath),
			);
		}
		return paths;
	}
	if (Array.isArray(before) && Array.isArray(after)) {
		if (before.length !== after.length) return [path || "root"];
		const paths: string[] = [];
		for (let index = 0; index < before.length; index++) {
			paths.push(...diffPaths(before[index], after[index], `${path}[${index}]`));
		}
		return paths;
	}
	if (before === after) return [];
	return [path || "root"];
}

export interface RevalidationSuccess {
	ok: true;
	/** The validated (and possibly coerced) arguments to execute with. */
	args: unknown;
}

export interface RevalidationFailure {
	ok: false;
	reason: string;
}

export type RevalidationResult = RevalidationSuccess | RevalidationFailure;

/**
 * Re-check tool arguments against the tool's own schema after mutable hooks
 * have had them.
 *
 * `beforeToolCall` hands extensions a live reference to the validated argument
 * object and invites in-place mutation. Nothing downstream re-checked the
 * result, so a hook could hand the tool a shape its schema forbids — and, worse,
 * an approval prompt could show the model's original command while the tool ran
 * a rewritten one. Revalidating here closes both: a failure becomes a durable
 * tool error before policy or execution, and everything after this point sees
 * the same arguments the tool will receive.
 */
export function revalidateToolArguments(
	tool: { name: string; parameters: unknown } | undefined,
	args: unknown,
): RevalidationResult {
	if (!tool) return { ok: true, args };
	try {
		const validated = validateToolArguments(
			{ name: tool.name, parameters: tool.parameters } as never,
			{
				name: tool.name,
				arguments: args,
			} as never,
		);
		return { ok: true, args: validated };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: `Tool arguments failed revalidation after hooks:\n${message}` };
	}
}

/**
 * Replace the contents of `target` with `source` in place.
 *
 * The agent loop holds the same object reference it passed to the hooks and
 * executes with it, and `beforeToolCall` has no way to return replacement
 * arguments. Writing the revalidated (coerced) values back through the same
 * reference is what makes "the tool runs what was validated" true rather than
 * merely intended.
 */
export function applyValidatedArguments(target: unknown, source: unknown): void {
	// Clearing the target first would empty the source too if they are the same
	// object. `validateToolArguments` clones, so this only guards a caller that
	// passes its input straight back.
	if (target === source) return;
	if (typeof target !== "object" || target === null || Array.isArray(target)) return;
	if (typeof source !== "object" || source === null || Array.isArray(source)) return;
	const record = target as Record<string, unknown>;
	for (const key of Object.keys(record)) delete record[key];
	Object.assign(record, source as Record<string, unknown>);
}

export function buildToolAuditRecord(input: {
	toolCallId: string;
	toolName: string;
	outcome: ToolAuditOutcome;
	argumentsBefore: unknown;
	argumentsAfter: unknown;
	reason?: string;
	timestamp: number;
}): ToolAuditRecord {
	const { value: redacted } = redactCredentialFields(input.argumentsAfter);
	return {
		toolCallId: input.toolCallId,
		toolName: input.toolName,
		outcome: input.outcome,
		arguments: redacted,
		mutatedPaths: diffPaths(input.argumentsBefore, input.argumentsAfter),
		...(input.reason === undefined ? {} : { reason: input.reason }),
		timestamp: input.timestamp,
	};
}
