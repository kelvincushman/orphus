const codingAgentShim = new URL("../fixtures/orphus-coding-agent/index.js", import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
	if (specifier === "@orphus/coding-agent") {
		return { url: codingAgentShim, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
