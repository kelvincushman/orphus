/**
 * Long-lived execution kernels: values that outlive a tool call.
 *
 * The structural gap Phase 4 closes is that a value has nowhere to live except
 * a context window or a file. A kernel is the third option — a REPL process
 * that stays alive between calls, so `docs = open('big.json').read()` costs the
 * agent one line of context instead of 4 MB of it.
 *
 * **This is not a security sandbox.** A kernel runs code with the user's
 * permissions, exactly like the `bash` tool — it is, honestly, bash with
 * memory. See `docs/repl.md` and Rule 5 of `docs/rlm-security-posture.md`.
 *
 * What this module *is* responsible for is the discipline Rule 4 requires:
 * kernels are admitted against a cap, refused with a typed reason rather than
 * silently, killed when the session ends, and reaped when idle. The zero-orphan
 * guarantee is the point — a PTY that outlives its session is a process nobody
 * owns.
 *
 * @see ../../../../../docs/rlm-security-posture.md
 */

/**
 * Concurrent kernel cap, matching `EXECUTION_CAPACITY` in
 * `crates/atomic-natives/src/subagent_control.rs`.
 *
 * Deliberately the same number as subagent admission rather than a new budget:
 * opening a kernel and admitting a child both spend the same scarce thing,
 * which is processes this machine is willing to have running.
 */
export const MAX_CONCURRENT_KERNELS = 4;

/** How long a kernel may sit untouched before it is reaped. */
export const DEFAULT_KERNEL_IDLE_MS = 30 * 60 * 1000;

/**
 * Why an open was refused. Typed rather than a bare boolean so the caller can
 * say something useful — Rule 4 asks that refusal be typed, not silent.
 */
export type KernelRefusalKind = "capacityExhausted" | "nameInUse" | "invalidName";

export class KernelRefused extends Error {
	readonly kind: KernelRefusalKind;
	constructor(kind: KernelRefusalKind, message: string) {
		super(message);
		this.name = "KernelRefused";
		this.kind = kind;
	}
}

/** The process-shaped thing a kernel wraps. Injectable so the registry is testable without spawning. */
export interface KernelProcess {
	write(data: string): void;
	kill(): void;
}

export interface Kernel {
	name: string;
	process: KernelProcess;
	createdAt: number;
	lastUsedAt: number;
}

export interface KernelRegistryOptions {
	maxKernels?: number;
	idleMs?: number;
	now?: () => number;
	/** Called when a kernel is reaped for idleness, so the caller can tell the agent. */
	onIdleReap?: (name: string) => void;
}

const NAME_PATTERN = /^[\w.-]{1,64}$/;

/**
 * Owns every live kernel for one agent session.
 *
 * One registry per session, and `killAll` on session end. A registry shared
 * across sessions would make "kill mine" ambiguous, which is how orphans
 * happen.
 */
export class KernelRegistry {
	private readonly kernels = new Map<string, Kernel>();
	private readonly maxKernels: number;
	private readonly idleMs: number;
	private readonly now: () => number;
	private readonly onIdleReap: ((name: string) => void) | undefined;

	constructor(options: KernelRegistryOptions = {}) {
		this.maxKernels = options.maxKernels ?? MAX_CONCURRENT_KERNELS;
		this.idleMs = options.idleMs ?? DEFAULT_KERNEL_IDLE_MS;
		this.now = options.now ?? Date.now;
		this.onIdleReap = options.onIdleReap;
	}

	get size(): number {
		return this.kernels.size;
	}

	names(): string[] {
		return [...this.kernels.keys()];
	}

	/**
	 * Admit a kernel, or refuse with a reason.
	 *
	 * Reaps idle kernels *before* checking capacity, so a session that left four
	 * kernels idle overnight is not permanently unable to open a fifth. The
	 * factory runs only after admission succeeds — refusing after spawning would
	 * leak the very process the cap exists to prevent.
	 */
	open(name: string, spawn: () => KernelProcess): Kernel {
		if (!NAME_PATTERN.test(name)) {
			throw new KernelRefused(
				"invalidName",
				`kernel name ${JSON.stringify(name)} must be 1-64 characters of letters, digits, underscore, dot, or hyphen`,
			);
		}
		this.reapIdle();
		if (this.kernels.has(name)) {
			throw new KernelRefused("nameInUse", `a kernel named '${name}' is already open`);
		}
		if (this.kernels.size >= this.maxKernels) {
			throw new KernelRefused(
				"capacityExhausted",
				`at most ${this.maxKernels} kernels may be open at once; close one first (open: ${this.names().join(", ")})`,
			);
		}

		const timestamp = this.now();
		const kernel: Kernel = { name, process: spawn(), createdAt: timestamp, lastUsedAt: timestamp };
		this.kernels.set(name, kernel);
		return kernel;
	}

	get(name: string): Kernel | undefined {
		return this.kernels.get(name);
	}

	/** Mark a kernel used. Idle reaping is measured from this, not from open. */
	touch(name: string): void {
		const kernel = this.kernels.get(name);
		if (kernel) kernel.lastUsedAt = this.now();
	}

	close(name: string): boolean {
		const kernel = this.kernels.get(name);
		if (!kernel) return false;
		this.kernels.delete(name);
		// Removed from the map before kill, so a throwing kill cannot leave an
		// entry pointing at a dead process.
		safeKill(kernel);
		return true;
	}

	/**
	 * Reap kernels idle beyond the timeout.
	 *
	 * Returns the names reaped so the caller can mention them; a kernel that
	 * vanishes silently is indistinguishable from one that was never opened.
	 */
	reapIdle(): string[] {
		const cutoff = this.now() - this.idleMs;
		const reaped: string[] = [];
		for (const [name, kernel] of [...this.kernels]) {
			if (kernel.lastUsedAt > cutoff) continue;
			this.kernels.delete(name);
			safeKill(kernel);
			reaped.push(name);
			this.onIdleReap?.(name);
		}
		return reaped;
	}

	/**
	 * Kill every kernel. Called on agent-session end.
	 *
	 * Every kill is attempted even if one throws: the zero-orphan guarantee is
	 * about *all* of them, and abandoning the loop on the first failure would
	 * leave the rest running.
	 */
	killAll(): string[] {
		const killed = [...this.kernels.keys()];
		for (const kernel of this.kernels.values()) safeKill(kernel);
		this.kernels.clear();
		return killed;
	}
}

function safeKill(kernel: Kernel): void {
	try {
		kernel.process.kill();
	} catch {
		// A kernel whose process already exited throws here. There is nothing to
		// recover and nothing to tell the user — the desired state is reached.
	}
}
