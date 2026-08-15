/**
 * Registering `repl` as an ordinary tool — behind a flag that is off.
 *
 * The plan asks for the kernel to ship with an opt-in flag as one of three
 * release kill switches. That means *wired but dark*: the tool exists, is
 * constructed the same way every other tool is, and is invisible to any session
 * that has not asked for it. Leaving it unwired would push the integration onto
 * whoever flips the switch; leaving it on would hand every session a way to run
 * model-written code with the user's permissions.
 *
 * `ORPHUS_ENABLE_REPL=1` is the switch. It is read once, here, so there is
 * exactly one place to look.
 *
 * **Not a security sandbox.** See `docs/repl.md`.
 */

import type { JailPlatform } from "./kernel-jail.js";
import { createPtyKernel, type PtySessionLike } from "./kernel-pty.js";
import { KernelRegistry } from "./kernel-registry.js";
import { handleRepl, REPL_TOOL_DESCRIPTION, REPL_TOOL_SCHEMA, type ReplInput } from "./repl-tool.js";

/** The one place the switch is read. */
export function replEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.ORPHUS_ENABLE_REPL;
	return value === "1" || value === "true";
}

/** Whether the jail is requested. Separate switch: a user may want kernels without one, or with. */
export function replJailRequested(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.ORPHUS_REPL_JAIL;
	return value === "1" || value === "true";
}

export function currentJailPlatform(platform: string = process.platform): JailPlatform {
	if (platform === "darwin") return "darwin";
	if (platform === "linux") return "linux";
	return "unsupported";
}

export interface ReplToolOptions {
	env?: NodeJS.ProcessEnv;
	platform?: string;
	/** Constructs a native PTY session. Injected so the definition is testable without the binding. */
	createPtySession?: () => PtySessionLike;
	/** Persist full output; the bounded view points at whatever this returns. */
	spill?: (name: string, text: string) => string | undefined;
}

/**
 * One registry per session, and one place that kills them.
 *
 * Returned rather than hidden so the session teardown can call `killAll`. A
 * registry nobody can reach is a registry nobody can empty, which is how a PTY
 * outlives the session that opened it.
 */
export interface ReplToolHandle {
	tool: {
		name: "repl";
		label: string;
		description: string;
		parameters: typeof REPL_TOOL_SCHEMA;
		execute: (toolCallId: string, input: ReplInput) => Promise<{ content: { type: "text"; text: string }[] }>;
	};
	registry: KernelRegistry;
	/** Call on agent-session end. Returns the kernels it attempted to kill. */
	shutdown: () => string[];
}

export function createReplTool(cwd: string, options: ReplToolOptions = {}): ReplToolHandle {
	const env = options.env ?? process.env;
	const registry = new KernelRegistry();
	const jail = replJailRequested(env);
	const platform = currentJailPlatform(options.platform);
	let execCounter = 0;

	const tool = {
		name: "repl" as const,
		label: "repl",
		description: REPL_TOOL_DESCRIPTION,
		parameters: REPL_TOOL_SCHEMA,
		execute: async (_toolCallId: string, input: ReplInput) => {
			const text = await handleRepl(input, {
				registry,
				nextToken: () => {
					execCounter += 1;
					return `${Date.now().toString(36)}${execCounter}`;
				},
				...(options.spill ? { spill: options.spill } : {}),
				spawn: ({ language, onData }) => {
					const createSession = options.createPtySession;
					if (!createSession) throw new Error("repl requires the native PTY binding, which is not available here");
					return createPtyKernel({
						language,
						cwd,
						jail,
						platform,
						onData,
						createSession,
						// A kernel whose process died must stop occupying a slot; the name
						// is freed so the next open does not hit a capacity that is fiction.
						onExit: () => {},
					});
				},
			});
			return { content: [{ type: "text" as const, text }] };
		},
	};

	return { tool, registry, shutdown: () => registry.killAll() };
}
