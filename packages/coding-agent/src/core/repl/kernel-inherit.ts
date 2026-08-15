/**
 * Granting a child access to its parent's kernel.
 *
 * The use case is narrow and real: load a dataset once, then spawn three
 * reviewers over it. Without this the only way to share is a file, and the
 * loading cost is paid three times.
 *
 * What this is **not** is cross-agent sharing. A value in agent A's kernel is
 * not addressable by agent B. The only crossing is *downward*, from a parent to
 * a child it explicitly names, because that is a boundary the parent already
 * controls — it chose to spawn the child and chose what to grant. Widening this
 * to peers needs a concrete use case and an update to
 * `docs/rlm-security-posture.md` first, which is what that document says.
 *
 * **Read-only by default.** A child that can rebind a parent's variables can
 * change what the parent believes, which is a far stranger failure than a child
 * that simply cannot write. Writing requires asking for it by name.
 */

import type { KernelRegistry } from "./kernel-registry.js";

export type InheritMode = "read-only" | "read-write";

export interface InheritGrant {
	/** The parent kernel being shared. */
	kernel: string;
	mode: InheritMode;
}

export class InheritRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InheritRefused";
	}
}

/**
 * Parse the `repl` field of a subagent call into a grant.
 *
 * `"inherit"` is the common form and means read-only — the safe reading of an
 * ambiguous word, chosen deliberately so a caller who did not think about it
 * gets the narrower grant.
 */
export function parseInheritRequest(value: unknown, parentKernel: string | undefined): InheritGrant | undefined {
	if (value === undefined || value === false) return undefined;

	if (value === "inherit" || value === true) {
		if (!parentKernel) throw new InheritRefused("repl: inherit was requested but the parent has no open kernel");
		return { kernel: parentKernel, mode: "read-only" };
	}
	if (typeof value === "object" && value !== null && "inherit" in value) {
		const request = value as { inherit: unknown; mode?: unknown };
		const kernel = typeof request.inherit === "string" ? request.inherit : parentKernel;
		if (!kernel)
			throw new InheritRefused("repl: inherit was requested but no kernel was named and the parent has none");
		const mode = request.mode;
		if (mode !== undefined && mode !== "read-only" && mode !== "read-write") {
			throw new InheritRefused(
				`repl: unknown inherit mode ${JSON.stringify(mode)} — expected read-only or read-write`,
			);
		}
		return { kernel, mode: (mode as InheritMode | undefined) ?? "read-only" };
	}
	throw new InheritRefused(`repl: expected "inherit" or {inherit, mode}, received ${JSON.stringify(value)}`);
}

/**
 * Resolve a grant against the parent's registry.
 *
 * Refuses rather than silently downgrading: a child told it inherited a kernel
 * that does not exist would run its code somewhere unexpected, or nowhere.
 */
export function resolveInherit(
	grant: InheritGrant,
	parentRegistry: KernelRegistry,
): { kernel: string; readOnly: boolean } {
	if (!parentRegistry.get(grant.kernel)) {
		throw new InheritRefused(
			`repl: cannot inherit '${grant.kernel}' — the parent has no such kernel open (open: ${parentRegistry.names().join(", ") || "none"})`,
		);
	}
	return { kernel: grant.kernel, readOnly: grant.mode === "read-only" };
}

/**
 * Code a read-only child is refused.
 *
 * Deliberately a *syntactic* check on assignment and mutation, and deliberately
 * described as what it is: a guardrail, not a sandbox. Python has a dozen ways
 * to mutate state that this cannot see, so the honest claim is that it catches
 * the obvious cases and makes the intent explicit — the same claim the jail
 * makes. A child that needs to write should be granted `read-write` rather than
 * find a way around this.
 */
const MUTATION_PATTERNS: readonly RegExp[] = [
	/^\s*[A-Za-z_]\w*(\s*\[[^\]]*\])?\s*=[^=]/m,
	/^\s*(del|global|nonlocal)\s+/m,
	/^\s*\w+\s*\.\s*\w+\s*=[^=]/m,
	/\b(append|extend|insert|pop|remove|clear|update|setdefault)\s*\(/,
];

export function refuseIfMutating(code: string, readOnly: boolean): string | undefined {
	if (!readOnly) return undefined;
	for (const pattern of MUTATION_PATTERNS) {
		if (pattern.test(code)) {
			return (
				"This kernel was inherited read-only, and the code looks like it assigns or mutates. " +
				"Read-only is a guardrail rather than a sandbox — it catches the obvious cases only. " +
				'Ask the parent for {inherit: "<kernel>", mode: "read-write"} if the child genuinely needs to write.'
			);
		}
	}
	return undefined;
}
