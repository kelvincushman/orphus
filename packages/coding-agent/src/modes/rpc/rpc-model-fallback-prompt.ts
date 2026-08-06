import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { createRpcErrorResponse, type RpcOutput } from "./rpc-responses.ts";

export function rejectUnsupportedProviderPrompt(
	runtimeHost: AgentSessionRuntime,
	output: RpcOutput,
	id: string | undefined,
): boolean {
	if (runtimeHost.modelFallbackReason !== "configured-provider-unsupported") return false;
	const message = runtimeHost.modelFallbackMessage;
	if (!message) throw new Error("Unsupported configured provider is missing its diagnostic message");
	output(createRpcErrorResponse(id, "prompt", message));
	return true;
}
