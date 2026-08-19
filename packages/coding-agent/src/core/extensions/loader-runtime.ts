import type {
	Extension,
	ExtensionFlag,
	ExtensionRuntime,
	ExtensionShortcut,
	RegisteredCommand,
	RegisteredTool,
} from "./types.ts";

/**
 * Run `run` inside a resource-registration transaction.
 *
 * A throw rolls the whole transaction back rather than committing it. The
 * previous `finally { end() }` published whatever a failed handler had already
 * registered — a half-installed tool set from a hook that died partway through
 * was indistinguishable from a successful one.
 */
export async function runResourceRegistrationBatch<T>(runtime: ExtensionRuntime, run: () => Promise<T>): Promise<T> {
	const commit = runtime.commitResourceRegistrationBatch ?? runtime.endResourceRegistrationBatch;
	if (!runtime.beginResourceRegistrationBatch || !commit) return run();
	runtime.beginResourceRegistrationBatch();
	let result: T;
	try {
		result = await run();
	} catch (error) {
		if (runtime.rollbackResourceRegistrationBatch) runtime.rollbackResourceRegistrationBatch();
		else commit();
		throw error;
	}
	commit();
	return result;
}

function registrationKey(extension: Extension, name: string): string {
	return `${extension.path}\0${name}`;
}

/** Create a runtime with throwing stubs for action methods. */
export function createExtensionRuntime(): ExtensionRuntime {
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};
	const state: { staleMessage?: string } = {};
	const pendingTools = new Map<string, { extension: Extension; name: string; registration: RegisteredTool }>();
	const pendingCommands = new Map<string, { extension: Extension; name: string; registration: RegisteredCommand }>();
	const pendingFlags = new Map<
		string,
		{ extension: Extension; name: string; registration: ExtensionFlag; defaultValue?: boolean | string }
	>();
	const pendingShortcuts = new Map<string, { extension: Extension; name: string; registration: ExtensionShortcut }>();

	/**
	 * One open transaction. `undo` is replayed in reverse to restore every write
	 * the transaction made — both the staged registrations held in the pending
	 * maps and the direct writes `loader-api` performs for non-inherited
	 * extensions, which reach `extension.tools`/`commands`/`flags`/`shortcuts`
	 * immediately.
	 */
	interface TransactionFrame {
		undo: (() => void)[];
		previousActiveToolNames: string[] | undefined;
		providerSnapshot: ExtensionRuntime["pendingProviderRegistrations"];
		/** Set when a direct tool registration inside this frame already refreshed the live registry. */
		touchedLiveTools: boolean;
	}
	const frames: TransactionFrame[] = [];
	const inTransaction = () => frames.length > 0;
	const recordUndo = (undo: () => void) => {
		frames[frames.length - 1]?.undo.push(undo);
	};
	const recordMapUndo = <K, V>(map: Map<K, V>, key: K) => {
		if (!inTransaction()) return;
		const had = map.has(key);
		const previous = map.get(key);
		recordUndo(() => {
			if (had) map.set(key, previous as V);
			else map.delete(key);
		});
	};
	const shouldStage = (extension: Extension) =>
		inTransaction() && extension.sourceInfo.configurationOrigin === "inherited-pi";
	let pendingActiveToolNames: string[] | undefined;
	const assertActive = () => {
		if (state.staleMessage) throw new Error(state.staleMessage);
	};

	const runtime: ExtensionRuntime = {
		sendMessage: notInitialized,
		sendMessages: notInitialized,
		sendUserMessage: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		setActiveTools: notInitialized,
		refreshTools: () => {},
		getCommands: notInitialized,
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		flagValues: new Map(),
		explicitFlagNames: new Set(),
		flagOwners: new Map(),
		flagOwnerOrigins: new Map(),
		pendingProviderRegistrations: [],
		canRegisterResource: () => true,
		beginResourceRegistrationBatch: () => {
			frames.push({
				undo: [],
				previousActiveToolNames: pendingActiveToolNames ? [...pendingActiveToolNames] : undefined,
				providerSnapshot: [...runtime.pendingProviderRegistrations],
				touchedLiveTools: false,
			});
		},
		rollbackResourceRegistrationBatch: () => {
			const frame = frames.pop();
			if (!frame) return;
			for (let index = frame.undo.length - 1; index >= 0; index--) frame.undo[index]();
			pendingActiveToolNames = frame.previousActiveToolNames;
			runtime.pendingProviderRegistrations = frame.providerSnapshot;
			// The batch's own refresh and activation are deliberately not applied —
			// nothing it registered may become visible. A direct (non-staged)
			// registration is the exception: it already reached the live registry
			// during the batch, so the registry is resynced against the maps this
			// rollback has just restored.
			if (frame.touchedLiveTools) runtime.refreshTools();
		},
		endResourceRegistrationBatch: () => {
			runtime.commitResourceRegistrationBatch?.();
		},
		commitResourceRegistrationBatch: () => {
			const frame = frames.pop();
			if (!frame) return;
			if (frames.length > 0) {
				// An inner commit publishes nothing. Its undo log is adopted by the
				// parent so an outer rollback still unwinds this frame's writes.
				const parent = frames[frames.length - 1];
				parent.undo.push(...frame.undo);
				parent.touchedLiveTools ||= frame.touchedLiveTools;
				return;
			}
			const refreshTools = pendingTools.size > 0;
			for (const pending of pendingTools.values()) pending.extension.tools.set(pending.name, pending.registration);
			for (const pending of pendingCommands.values())
				pending.extension.commands.set(pending.name, pending.registration);
			for (const pending of pendingFlags.values()) {
				pending.extension.flags.set(pending.name, pending.registration);
				const ownerOrigin = runtime.flagOwnerOrigins?.get(pending.name);
				if (
					ownerOrigin === pending.extension.sourceInfo.configurationOrigin &&
					pending.defaultValue !== undefined &&
					!runtime.flagValues.has(pending.name)
				) {
					runtime.flagValues.set(pending.name, pending.defaultValue);
				}
			}
			for (const pending of pendingShortcuts.values())
				pending.extension.shortcuts.set(pending.name as never, pending.registration);
			pendingTools.clear();
			pendingCommands.clear();
			pendingFlags.clear();
			pendingShortcuts.clear();
			if (refreshTools) runtime.refreshTools();
			if (pendingActiveToolNames) runtime.setActiveTools(pendingActiveToolNames);
			pendingActiveToolNames = undefined;
		},
		stageToolRegistration: (extension, name, registration) => {
			if (!shouldStage(extension)) {
				// Not staged: `loader-api` is about to write straight through to the
				// live maps. Capture the pre-write state so a rollback can undo it.
				recordMapUndo(extension.tools, name);
				const frame = frames[frames.length - 1];
				if (frame) frame.touchedLiveTools = true;
				return false;
			}
			recordMapUndo(pendingTools, registrationKey(extension, name));
			// `shouldStage` above implies an open transaction.
			const previousActive = pendingActiveToolNames ? [...pendingActiveToolNames] : undefined;
			recordUndo(() => {
				pendingActiveToolNames = previousActive;
			});
			pendingTools.set(registrationKey(extension, name), { extension, name, registration });
			if (pendingActiveToolNames && !pendingActiveToolNames.includes(name)) pendingActiveToolNames.push(name);
			return true;
		},
		stageCommandRegistration: (extension, name, registration) => {
			if (!shouldStage(extension)) {
				recordMapUndo(extension.commands, name);
				return false;
			}
			recordMapUndo(pendingCommands, registrationKey(extension, name));
			pendingCommands.set(registrationKey(extension, name), { extension, name, registration });
			return true;
		},
		stageFlagRegistration: (extension, name, registration, defaultValue) => {
			// Flag ownership is claimed on the first registration regardless of which
			// path takes it, so both paths record its undo before claiming.
			runtime.flagOwners ??= new Map();
			const owners = runtime.flagOwners;
			runtime.flagOwnerOrigins ??= new Map();
			const ownerOrigins = runtime.flagOwnerOrigins;
			if (!owners.has(name)) {
				recordMapUndo(owners, name);
				recordMapUndo(ownerOrigins, name);
			}
			if (!shouldStage(extension)) {
				recordMapUndo(extension.flags, name);
				return false;
			}
			const key = registrationKey(extension, name);
			recordMapUndo(pendingFlags, key);
			const firstDefault = pendingFlags.get(key)?.defaultValue;
			pendingFlags.set(key, { extension, name, registration, defaultValue: firstDefault ?? defaultValue });
			if (!owners.has(name)) {
				owners.set(name, extension.path);
				ownerOrigins.set(name, extension.sourceInfo.configurationOrigin);
			}
			return true;
		},
		stageShortcutRegistration: (extension, name, registration) => {
			if (!shouldStage(extension)) {
				recordMapUndo(extension.shortcuts, name);
				return false;
			}
			recordMapUndo(pendingShortcuts, registrationKey(extension, name));
			pendingShortcuts.set(registrationKey(extension, name), { extension, name, registration });
			return true;
		},
		hasPendingResourceRegistration: (extension, resourceType, name) => {
			const key = registrationKey(extension, name);
			if (resourceType === "tool") return pendingTools.has(key);
			if (resourceType === "command") return pendingCommands.has(key);
			if (resourceType === "flag") return pendingFlags.has(key);
			if (resourceType === "shortcut") return pendingShortcuts.has(key);
			return false;
		},
		deletePendingResourceRegistration: (extension, resourceType, name) => {
			const key = registrationKey(extension, name);
			if (resourceType === "tool") pendingTools.delete(key);
			else if (resourceType === "command") pendingCommands.delete(key);
			else if (resourceType === "flag") pendingFlags.delete(key);
			else if (resourceType === "shortcut") pendingShortcuts.delete(key);
		},
		getPendingFlagDefault: (ownerPath, name) => {
			if (!pendingFlags.has(`${ownerPath}\0${name}`)) return undefined;
			return [...pendingFlags.values()].find(
				(pending) => pending.name === name && pending.defaultValue !== undefined,
			)?.defaultValue;
		},
		getAllToolsAfterRegistration: (extension) => {
			const tools = runtime.getAllTools();
			if (extension.sourceInfo.configurationOrigin !== "inherited-pi") return tools;
			const names = new Set(tools.map((tool) => tool.name));
			for (const pending of pendingTools.values()) {
				if (names.has(pending.name)) continue;
				const { definition, sourceInfo } = pending.registration;
				tools.push({
					name: definition.name,
					description: definition.description,
					parameters: definition.parameters,
					...(Object.hasOwn(definition, "constrainedSampling")
						? { constrainedSampling: definition.constrainedSampling }
						: {}),
					promptGuidelines: definition.promptGuidelines,
					sourceInfo,
				});
				names.add(pending.name);
			}
			return tools;
		},
		getCommandsAfterRegistration: (extension) => {
			if (extension.sourceInfo.configurationOrigin !== "inherited-pi") return runtime.getCommands();
			const active = [...pendingCommands.values()].map((pending) => ({
				...pending,
				previous: pending.extension.commands.get(pending.name),
			}));
			for (const pending of active) pending.extension.commands.set(pending.name, pending.registration);
			try {
				return runtime.getCommands();
			} finally {
				for (const pending of active) {
					if (pending.previous) pending.extension.commands.set(pending.name, pending.previous);
					else pending.extension.commands.delete(pending.name);
				}
			}
		},
		refreshToolsAfterRegistration: () => {
			runtime.refreshTools();
			if (inTransaction() && pendingActiveToolNames) pendingActiveToolNames = runtime.getActiveTools();
		},
		applyFlagDefaultAfterRegistration: (name, _ownerPath, value, configurationOrigin) => {
			if (runtime.flagOwnerOrigins?.get(name) === configurationOrigin && !runtime.flagValues.has(name)) {
				recordMapUndo(runtime.flagValues, name);
				runtime.flagValues.set(name, value);
			}
		},
		getActiveToolsAfterRegistration: (extension) => {
			const active = runtime.getActiveTools();
			if (extension.sourceInfo.configurationOrigin !== "inherited-pi") return active;
			if (pendingActiveToolNames) return [...pendingActiveToolNames];
			const names = new Set(active);
			for (const pending of pendingTools.values()) names.add(pending.name);
			return [...names];
		},
		setActiveToolsAfterRegistration: (extension, toolNames) => {
			if (!inTransaction()) return false;
			const previousActive = pendingActiveToolNames ? [...pendingActiveToolNames] : undefined;
			recordUndo(() => {
				pendingActiveToolNames = previousActive;
			});
			pendingActiveToolNames = [...toolNames];
			if (extension.sourceInfo.configurationOrigin !== "inherited-pi") return false;
			const liveNames = new Set(runtime.getAllTools().map((tool) => tool.name));
			runtime.setActiveTools(toolNames.filter((name) => liveNames.has(name)));
			return true;
		},
		assertActive,
		invalidate: (message) => {
			state.staleMessage ??=
				message ??
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
		},
		registerProvider: (nameOrProvider, configOrPath, extensionPath = "<unknown>") => {
			if (typeof nameOrProvider === "string") {
				runtime.pendingProviderRegistrations.push({
					name: nameOrProvider,
					config: configOrPath as import("./types.ts").ProviderConfig,
					extensionPath: extensionPath as string,
				});
			} else {
				runtime.pendingProviderRegistrations.push({
					provider: nameOrProvider,
					extensionPath: typeof configOrPath === "string" ? configOrPath : (extensionPath as string),
				});
			}
		},
		unregisterProvider: (name) => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((registration) =>
				"provider" in registration ? registration.provider.id !== name : registration.name !== name,
			);
		},
	};
	return runtime;
}
