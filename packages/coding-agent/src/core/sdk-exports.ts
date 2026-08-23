export * from "./agent-session-runtime.ts";
export type {
	BrowserCapability,
	ClockCapability,
	CredentialCapability,
	CredentialRecord,
	FileSystemCapability,
	HarnessCapabilities,
	HarnessCapabilityOverrides,
	ProcessCapability,
	ProcessHandle,
	TerminalTransportCapability,
	TranscriptionCapability,
} from "./capabilities/index.ts";
// The harness capability boundary, its fakes, and the assembled-runtime replay
// harness. See docs/harness.md.
export {
	createDefaultCapabilities,
	createFakeCapabilities,
	createFakeClock,
	createFakeCredentials,
	createFakeFileSystem,
	createFakeProcesses,
	createFakeTerminalTransport,
	createStdioTerminalTransport,
} from "./capabilities/index.ts";
export type {
	AgentSettledEvent,
	BeforeProviderHeadersEvent,
	EntryRenderer,
	EntryRenderOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { ProviderRequestRecord, ProviderResponseRecord } from "./provider-audit.ts";
export {
	ENV_PROVIDER_AUDIT,
	MAX_INLINE_BODY_BYTES,
	PROVIDER_REQUEST_ENTRY,
	PROVIDER_REQUEST_SPILL_DIR,
	PROVIDER_RESPONSE_ENTRY,
	ProviderAuditRecorder,
} from "./provider-audit.ts";
export type { ReplayRuntime, ReplayRuntimeOptions, ScriptedTurn } from "./replay/index.ts";
export { createReplayRuntime, createScriptedProvider } from "./replay/index.ts";
export type { RuntimeInspection } from "./runtime-inspection.ts";
export {
	buildRuntimeInspection,
	formatRuntimeInspection,
	RUNTIME_INSPECTION_VERSION,
} from "./runtime-inspection.ts";
export type { Skill } from "./skills.ts";
export type { ToolAuditOutcome, ToolAuditRecord } from "./tool-audit.ts";
export { TOOL_AUDIT_ENTRY } from "./tool-audit.ts";
export type {
	JsonObject,
	JsonPrimitive,
	JsonValue,
	StructuredOutputCapture,
	StructuredOutputFileCapture,
	StructuredOutputToolOptions,
	Tool,
} from "./tools/index.ts";

export {
	createBashTool,
	// Tool factories (for custom cwd)
	createCodingTools,
	createEditTool,
	createFindTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createSearchTool,
	createStructuredOutputCapture,
	createStructuredOutputTool,
	createWriteTool,
	STRUCTURED_OUTPUT_TOOL_NAME,
	withFileMutationQueue,
} from "./tools/index.ts";
