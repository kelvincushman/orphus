import type { Api, Model } from "@earendil-works/pi-ai/compat";

/** Orphus compatibility alias accepted alongside pi-ai's canonical grammar capability. */
export interface GrammarToolCapabilityAlias {
	supportsGrammarTools?: boolean;
}

/** Pi provider compatibility metadata plus Orphus's public constrained-sampling fields. */
export type AtomicProviderCompat = NonNullable<Model<Api>["compat"]> &
	GrammarToolCapabilityAlias & {
		supportsStrictTools?: boolean;
		supportsStrictMode?: boolean;
		supportsOpenAIGrammarTools?: boolean;
	};

type GrammarCompatible = NonNullable<Model<Api>["compat"]> &
	GrammarToolCapabilityAlias & {
		supportsOpenAIGrammarTools?: boolean;
	};

/**
 * Keep Orphus's documented capability alias synchronized with pi-ai's canonical
 * field. The canonical field wins when both are supplied, so Orphus never
 * advertises grammar enforcement that the provider runtime has disabled.
 */
export function normalizeGrammarToolCapability(
	compat: AtomicProviderCompat | Model<Api>["compat"] | undefined,
): AtomicProviderCompat | undefined {
	if (!compat) return undefined;
	const grammarCompat = compat as GrammarCompatible;
	const supported = grammarCompat.supportsOpenAIGrammarTools ?? grammarCompat.supportsGrammarTools;
	if (supported === undefined) return compat as AtomicProviderCompat;
	if (grammarCompat.supportsOpenAIGrammarTools === supported && grammarCompat.supportsGrammarTools === supported) {
		return compat as AtomicProviderCompat;
	}
	return {
		...grammarCompat,
		supportsOpenAIGrammarTools: supported,
		supportsGrammarTools: supported,
	} as AtomicProviderCompat;
}
