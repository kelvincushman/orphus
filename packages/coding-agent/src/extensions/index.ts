import type { InlineExtension } from "../core/extensions/types.ts";
import browserExtension from "./browser/index.js";
import llamaExtension from "./llama/index.js";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true, bundled: true },
	// Registered by default; ORPHUS_ENABLE_BROWSER=0 removes it entirely.
	{ name: "browser", factory: browserExtension, hidden: true, bundled: true },
];
