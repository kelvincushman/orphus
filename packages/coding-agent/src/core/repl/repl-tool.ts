/**
 * The `repl` tool: open a kernel, run code in it, look at it, close it.
 *
 * **Off by default.** Registration is gated on an explicit opt-in, because a
 * tool that executes model-written code with the user's permissions is not
 * something to switch on for somebody who did not ask. The plan names this flag
 * as one of the release's kill switches.
 *
 * The handler is deliberately thin and fully injectable — registry, clock, spill
 * — so the behaviour is tested without spawning a process. What it owns is the
 * mapping from four actions onto the tested pieces, and the shape of what comes
 * back: **a name from `open`, never output**, and a bounded view from `exec`
 * with a pointer to the whole thing.
 *
 * @see ../../../../../docs/repl.md
 */

import { formatKernelView, formatQuietResult } from "./kernel-output.js";
import { type KernelProcess, KernelRefused, type KernelRegistry } from "./kernel-registry.js";
import { KernelBusy, KernelExecTimeout, type KernelLanguage, KernelSession } from "./kernel-session.js";

export type ReplAction = "open" | "exec" | "peek" | "close" | "list";

export interface ReplInput {
	action: ReplAction;
	session?: string;
	code?: string;
	language?: KernelLanguage;
	timeoutMs?: number;
}

export interface ReplDeps {
	registry: KernelRegistry;
	/**
	 * Builds the process for a kernel.
	 *
	 * `onData` is how output gets back in: the PTY adapter hands it to
	 * `PtySession`'s data callback. Without it a spawned process would have no
	 * route to its own `KernelSession`, and every `exec` would wait for a
	 * sentinel that could never arrive.
	 */
	spawn: (options: { name: string; language: KernelLanguage; onData: (chunk: string) => void }) => {
		process: KernelProcess;
		jailNote: string;
	};
	/** Persist full output and return a path, so a bounded view always has somewhere to point. */
	spill?: (name: string, text: string) => string | undefined;
	/** Distinct per exec — a shared sentinel lets one call resolve on another's completion. */
	nextToken: () => string;
}

/** Kernels the tool is driving, keyed by the registry's name. */
const sessions = new WeakMap<KernelRegistry, Map<string, KernelSession>>();

function sessionsFor(registry: KernelRegistry): Map<string, KernelSession> {
	let map = sessions.get(registry);
	if (!map) {
		map = new Map();
		sessions.set(registry, map);
	}
	return map;
}

function requireName(input: ReplInput): string {
	const name = input.session?.trim();
	if (!name) throw new Error(`repl ${input.action} requires a session name`);
	return name;
}

export async function handleRepl(input: ReplInput, deps: ReplDeps): Promise<string> {
	const { registry } = deps;
	const live = sessionsFor(registry);

	switch (input.action) {
		case "list": {
			const names = registry.names();
			return names.length === 0 ? "No kernels open." : `Open kernels: ${names.join(", ")}`;
		}

		case "open": {
			const name = requireName(input);
			const language = input.language ?? "python";
			try {
				let jailNote = "";
				registry.open(name, () => {
					// The session must exist before the process can deliver into it, and
					// the process must exist before the session can be constructed. Broken
					// by giving spawn a callback that resolves the session lazily.
					let session: KernelSession | undefined;
					const spawned = deps.spawn({ name, language, onData: (chunk) => session?.receive(chunk) });
					jailNote = spawned.jailNote;
					session = new KernelSession({ name, language, process: spawned.process });
					live.set(name, session);
					return spawned.process;
				});
				// A name, not output. The whole point of a kernel is that what it
				// holds stays out of the context window until asked for.
				return `${name} (${language}, ${jailNote})`;
			} catch (error) {
				if (error instanceof KernelRefused) return `Refused (${error.kind}): ${error.message}`;
				throw error;
			}
		}

		case "exec": {
			const name = requireName(input);
			const session = live.get(name);
			if (!session) return `No kernel named '${name}'. Open one first.`;
			if (!input.code?.trim()) return "repl exec requires code to run.";

			registry.touch(name);
			try {
				const result = await session.exec(input.code, {
					token: deps.nextToken(),
					...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
				});
				if (result.view.text.trim().length === 0) return formatQuietResult(name, result.elapsedMs);
				const fullOutputPath = result.view.elidedChars > 0 ? deps.spill?.(name, result.raw) : undefined;
				return formatKernelView(result.view, fullOutputPath ? { fullOutputPath } : {});
			} catch (error) {
				if (error instanceof KernelBusy) return error.message;
				if (error instanceof KernelExecTimeout) {
					// The kernel is left alive on purpose; say so, because the obvious
					// assumption is that a timeout killed it and the values are gone.
					const partial = error.partial.trim();
					return [
						`${error.message}. The kernel is still open and its values are intact — close it if the code is stuck.`,
						partial.length > 0 ? `Partial output:\n${partial}` : "It printed nothing before the timeout.",
					].join("\n");
				}
				throw error;
			}
		}

		case "peek": {
			const name = requireName(input);
			const session = live.get(name);
			if (!session) return `No kernel named '${name}'. Open one first.`;
			registry.touch(name);
			const view = session.peek();
			return view.text.trim().length === 0 ? `${name} has printed nothing yet.` : formatKernelView(view);
		}

		case "close": {
			const name = requireName(input);
			live.delete(name);
			return registry.close(name) ? `Closed ${name}.` : `No kernel named '${name}'.`;
		}
	}
}

export const REPL_TOOL_DESCRIPTION =
	"Run code in a long-lived REPL kernel so values persist between calls. " +
	"`open` returns a name, not output. `exec` returns a bounded view with a pointer to the full output. " +
	"Load big inputs inside the kernel (docs = open('big.json').read()) so the parent context pays one line, not the file. " +
	"NOT a security sandbox: code runs with the user's permissions, exactly like bash.";

/** Parameter schema, kept beside the description so the two cannot drift. */
export const REPL_TOOL_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["action"],
	properties: {
		action: { type: "string", enum: ["open", "exec", "peek", "close", "list"] },
		session: { type: "string", description: "Kernel name. Required for every action except list." },
		code: { type: "string", description: "Code to run. Required for exec." },
		language: { type: "string", enum: ["python", "node"], description: "Defaults to python. Only used by open." },
		timeoutMs: { type: "number", description: "Per-exec timeout. Defaults to 120000." },
	},
} as const;
