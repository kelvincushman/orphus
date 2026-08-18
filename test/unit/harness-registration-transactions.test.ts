import assert from "node:assert/strict";
import { test } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { createExtensionAPI } from "../../packages/coding-agent/src/core/extensions/loader-api.js";
import {
	createExtensionRuntime,
	runResourceRegistrationBatch,
} from "../../packages/coding-agent/src/core/extensions/loader-runtime.js";
import type { Extension } from "../../packages/coding-agent/src/core/extensions/types.js";

function extension(path: string, origin: "atomic" | "bundled" | "inherited-pi"): Extension {
	return {
		path,
		resolvedPath: path,
		sourceInfo: { path, source: "test", scope: "user", origin: "top-level", configurationOrigin: origin },
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

function stubRuntimeReaders(runtime: ReturnType<typeof createExtensionRuntime>, extensions: Extension[]) {
	let activeTools: string[] = [];
	let refreshes = 0;
	runtime.getAllTools = () =>
		extensions.flatMap((candidate) =>
			[...candidate.tools.values()].map(({ definition, sourceInfo }) => ({ ...definition, sourceInfo })),
		);
	runtime.getCommands = () =>
		extensions.flatMap((candidate) =>
			[...candidate.commands.values()].map((command) => ({ ...command, source: "extension" as const })),
		);
	runtime.getActiveTools = () => [...activeTools];
	const registeredNames = () => new Set(extensions.flatMap((candidate) => [...candidate.tools.keys()]));
	runtime.setActiveTools = (names) => {
		// Mirrors `setActiveToolsByName`: a name with no tool behind it is dropped.
		activeTools = names.filter((name) => registeredNames().has(name));
	};
	runtime.refreshTools = () => {
		refreshes += 1;
		runtime.setActiveTools([...new Set([...activeTools, ...registeredNames()])]);
	};
	return {
		get activeTools() {
			return activeTools;
		},
		get refreshes() {
			return refreshes;
		},
	};
}

const noopTool = (name: string) => ({
	name,
	label: name,
	description: name,
	parameters: {} as never,
	execute: async () => ({ content: [], details: undefined }),
});

for (const origin of ["inherited-pi", "bundled"] as const) {
	test(`rolls back every ${origin} registration when the batch throws`, async () => {
		const runtime = createExtensionRuntime();
		const candidate = extension(origin, origin);
		const readers = stubRuntimeReaders(runtime, [candidate]);
		const pi = createExtensionAPI(candidate, runtime, "/tmp", createEventBus());

		await assert.rejects(
			() =>
				runResourceRegistrationBatch(runtime, async () => {
					pi.registerTool(noopTool("half-installed"));
					pi.registerCommand("half-installed", { handler: async () => {} });
					pi.registerFlag("half-installed", { type: "string", default: "leaked" });
					pi.registerShortcut("ctrl+k" as never, { handler: async () => {} });
					throw new Error("handler exploded");
				}),
			/handler exploded/,
		);

		assert.equal(candidate.tools.has("half-installed"), false, "tool must not survive a failed batch");
		assert.equal(candidate.commands.has("half-installed"), false, "command must not survive a failed batch");
		assert.equal(candidate.flags.has("half-installed"), false, "flag must not survive a failed batch");
		assert.equal(candidate.shortcuts.has("ctrl+k" as never), false, "shortcut must not survive a failed batch");
		assert.equal(runtime.flagValues.has("half-installed"), false, "flag default must not survive a failed batch");
		assert.equal(runtime.flagOwners?.has("half-installed"), false, "flag ownership must not survive a failed batch");
		assert.deepEqual(readers.activeTools, [], "a rolled-back batch activates nothing");
	});
}

test("commits the whole batch when it succeeds", async () => {
	const runtime = createExtensionRuntime();
	const candidate = extension("inherited", "inherited-pi");
	const readers = stubRuntimeReaders(runtime, [candidate]);
	const pi = createExtensionAPI(candidate, runtime, "/tmp", createEventBus());

	await runResourceRegistrationBatch(runtime, async () => {
		pi.registerTool(noopTool("committed"));
		pi.registerFlag("committed", { type: "string", default: "ready" });
	});

	assert.equal(candidate.tools.has("committed"), true);
	assert.equal(runtime.flagValues.get("committed"), "ready");
	assert.deepEqual(readers.activeTools, ["committed"]);
});

test("an inner failure rolls back only when it propagates; an inner commit publishes nothing on its own", async () => {
	const runtime = createExtensionRuntime();
	const candidate = extension("inherited", "inherited-pi");
	stubRuntimeReaders(runtime, [candidate]);
	const pi = createExtensionAPI(candidate, runtime, "/tmp", createEventBus());
	let visibleDuringOuter: boolean | undefined;

	await runResourceRegistrationBatch(runtime, async () => {
		await runResourceRegistrationBatch(runtime, async () => {
			pi.registerTool(noopTool("inner"));
		});
		// The inner commit merged into the outer transaction; nothing is public yet.
		visibleDuringOuter = candidate.tools.has("inner");
		pi.registerTool(noopTool("outer"));
	});

	assert.equal(visibleDuringOuter, false, "an inner commit must not publish through the open outer transaction");
	assert.deepEqual([...candidate.tools.keys()].sort(), ["inner", "outer"]);
});

test("an outer rollback also unwinds a committed inner transaction", async () => {
	const runtime = createExtensionRuntime();
	const candidate = extension("inherited", "inherited-pi");
	stubRuntimeReaders(runtime, [candidate]);
	const pi = createExtensionAPI(candidate, runtime, "/tmp", createEventBus());

	await assert.rejects(
		() =>
			runResourceRegistrationBatch(runtime, async () => {
				await runResourceRegistrationBatch(runtime, async () => {
					pi.registerTool(noopTool("inner"));
					pi.registerCommand("inner", { handler: async () => {} });
				});
				throw new Error("outer exploded");
			}),
		/outer exploded/,
	);

	assert.deepEqual([...candidate.tools.keys()], []);
	assert.deepEqual([...candidate.commands.keys()], []);
});

test("a rolled-back provider registration leaves nothing queued", async () => {
	const runtime = createExtensionRuntime();
	runtime.pendingProviderRegistrations.push({ name: "pre-existing", config: {}, extensionPath: "/before" });

	await assert.rejects(
		() =>
			runResourceRegistrationBatch(runtime, async () => {
				runtime.registerProvider("scratch", {}, "/during");
				throw new Error("nope");
			}),
		/nope/,
	);

	assert.deepEqual(
		runtime.pendingProviderRegistrations.map((registration) =>
			"provider" in registration ? registration.provider.id : registration.name,
		),
		["pre-existing"],
	);
});

test("a rollback does not fire the batch's own tool refresh", async () => {
	const runtime = createExtensionRuntime();
	const candidate = extension("inherited", "inherited-pi");
	const readers = stubRuntimeReaders(runtime, [candidate]);
	const pi = createExtensionAPI(candidate, runtime, "/tmp", createEventBus());

	await assert.rejects(
		() =>
			runResourceRegistrationBatch(runtime, async () => {
				pi.registerTool(noopTool("staged"));
				throw new Error("no");
			}),
		/no/,
	);

	// Staged registrations never reached the live registry, so nothing needs resyncing.
	assert.equal(readers.refreshes, 0);
});
