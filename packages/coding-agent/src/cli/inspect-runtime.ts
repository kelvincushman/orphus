import { getAgentDir, VERSION } from "../config.ts";
import type { InlineExtension } from "../core/extensions/index.ts";
import { resolveProjectTrusted } from "../core/project-trust.ts";
import { DefaultResourceLoader } from "../core/resource-loader.ts";
import { buildRuntimeInspection, formatRuntimeInspection, type RuntimeInspection } from "../core/runtime-inspection.ts";
import { createAgentSession } from "../core/sdk.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { ProjectTrustStore } from "../core/trust-manager.ts";
import { createProjectTrustContext } from "./project-trust.ts";

const USAGE = `Usage: orphus inspect runtime [--json] [--include-content]

Print the resolved runtime as deterministic JSON: provider/model, capability
implementations, tool schema hashes, extensions and hook order, flag and
settings provenance, and system-prompt section hashes.

  --json              Emit JSON (the only supported format; accepted for clarity).
  --include-content   Also emit the resolved system-prompt content.

Secrets are redacted in both modes.`;

export interface InspectRuntimeOptions {
	extensionFactories?: InlineExtension[];
	cwd?: string;
	agentDir?: string;
}

/** Assemble the real runtime and report it. Read-only: nothing is dispatched. */
export async function inspectRuntime(
	options: InspectRuntimeOptions & { includeContent?: boolean },
): Promise<RuntimeInspection> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	// Project trust gates whether project-local extensions and workflows load —
	// loading them *executes* them. Inspection honours the same remembered
	// decisions as a real session, and with no UI to ask, an undecided project
	// resolves untrusted rather than being trusted because a report wanted it.
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const projectTrusted = await resolveProjectTrusted({
		cwd,
		trustStore: new ProjectTrustStore(agentDir),
		defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
		projectTrustContext: createProjectTrustContext({ cwd, mode: "print", settingsManager, hasUI: false }),
	});
	settingsManager.setProjectTrusted(projectTrusted);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: options.extensionFactories,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader });
	try {
		const extensionsResult = session.resourceLoader.getExtensions();
		const runtime = extensionsResult.runtime;
		const activeToolNames = new Set(session.getActiveToolNames());
		const model = session.model;
		return buildRuntimeInspection({
			appVersion: VERSION,
			model: model
				? {
						provider: model.provider,
						id: model.id,
						api: model.api,
						...(model.name ? { name: model.name } : {}),
						thinkingLevel: session.thinkingLevel,
					}
				: undefined,
			capabilities: session.capabilities,
			tools: session.getAllTools().map((tool) => ({
				name: tool.name,
				parameters: tool.parameters,
				source: tool.sourceInfo.source,
				active: activeToolNames.has(tool.name),
			})),
			extensions: extensionsResult.extensions.map((extension) => ({
				path: extension.path,
				source: extension.sourceInfo.source,
				handlers: extension.handlers,
			})),
			flags: [...new Set([...runtime.flagValues.keys(), ...(runtime.flagOwners?.keys() ?? [])])].map((name) => ({
				name,
				owner: runtime.flagOwners?.get(name),
				origin: runtime.flagOwnerOrigins?.get(name),
				value: runtime.flagValues.get(name),
				explicit: runtime.explicitFlagNames?.has(name) === true,
			})),
			globalSettings: settingsManager.getGlobalSettings() as unknown as Record<string, unknown>,
			projectSettings: settingsManager.getProjectSettings() as unknown as Record<string, unknown>,
			systemPrompt: session.systemPrompt,
			includeContent: options.includeContent,
		});
	} finally {
		session.dispose();
	}
}

/**
 * `orphus inspect …`. Returns true when it owned the argv, having already set
 * `process.exitCode`.
 */
export async function handleInspectCommand(args: string[], options?: InspectRuntimeOptions): Promise<boolean> {
	if (args[0] !== "inspect") return false;
	const rest = args.slice(1);
	if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
		console.log(USAGE);
		return true;
	}
	if (rest[0] !== "runtime") {
		console.error(`Error: unknown inspect subcommand "${rest[0]}"\n\n${USAGE}`);
		process.exitCode = 1;
		return true;
	}
	const flags = rest.slice(1);
	const unknown = flags.filter((flag) => flag !== "--json" && flag !== "--include-content");
	if (unknown.length > 0) {
		console.error(`Error: unknown option(s) ${unknown.join(", ")}\n\n${USAGE}`);
		process.exitCode = 1;
		return true;
	}
	try {
		const report = await inspectRuntime({ ...options, includeContent: flags.includes("--include-content") });
		process.stdout.write(formatRuntimeInspection(report));
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
	return true;
}
