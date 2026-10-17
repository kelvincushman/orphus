import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelRegistry, ResourceLoader } from "@orphus/coding-agent";

/**
 * The model registry of the session whose `subagent` call is running, carried
 * through the async call chain down to the in-process runner.
 *
 * An extension loaded a second time in the same process may defer its provider
 * registration to `session_start` (claude-bridge does, so that it never
 * overwrites the parent's stream function), and in-process children never emit
 * `session_start`. Without the parent's providers the child cannot resolve a
 * `claude-bridge/*` pin or default, so the child inherits them.
 */
const parentModelRegistry = new AsyncLocalStorage<ModelRegistry>();

export function withParentModelRegistry<T>(registry: ModelRegistry | undefined, run: () => T): T {
	return registry ? parentModelRegistry.run(registry, run) : run();
}

/**
 * Queue the parent's extension-registered providers into a child's resource
 * loader, for createAgentSession to register before it resolves the child's
 * model. A provider the child's own extensions registered while loading wins.
 */
export function inheritParentProviders(
	resourceLoader: Pick<ResourceLoader, "getExtensions">,
	registry: ModelRegistry | undefined = parentModelRegistry.getStore(),
): void {
	if (typeof registry?.getRegisteredProviderIds !== "function") return;
	const pending = resourceLoader.getExtensions().runtime.pendingProviderRegistrations;
	const ownIds = new Set(pending.map((entry) => ("provider" in entry ? entry.provider.id : entry.name)));
	for (const id of registry.getRegisteredProviderIds()) {
		if (ownIds.has(id)) continue;
		const provider = registry.getRegisteredNativeProvider(id);
		if (provider) {
			pending.push({ provider, extensionPath: "<parent session>" });
			continue;
		}
		const config = registry.getRegisteredProviderConfig(id);
		if (config) pending.push({ name: id, config, extensionPath: "<parent session>" });
	}
}
