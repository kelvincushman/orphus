import type { InlineExtension } from "../core/extensions/types.ts";
import browserExtension from "./browser/index.js";
import llamaExtension from "./llama/index.js";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true, bundled: true },
	// Registers nothing unless ORPHUS_ENABLE_BROWSER is set.
	{ name: "browser", factory: browserExtension, hidden: true, bundled: true },
];
