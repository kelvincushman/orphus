/**
 * Choosing an adapter by name.
 *
 * An unknown or unavailable name throws rather than falling back to `null`.
 * A silent fallback would leave a run slower than the user asked for with
 * nothing to show why, and a typo in a config file would be indistinguishable
 * from a deliberate choice.
 */

import { type CompleteStructured, createLlmWrapperSystemOne } from "./adapters/llm-wrapper.ts";
import { nullSystemOne } from "./adapters/null.ts";
import type { SystemOne } from "./port.ts";

export const ADAPTER_NAMES = ["null", "llm-wrapper", "local", "typesafe"] as const;
export type AdapterName = (typeof ADAPTER_NAMES)[number];

export class SystemOneAdapterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SystemOneAdapterError";
	}
}

export interface CreateSystemOneOptions {
	readonly adapter: string;
	/** Required by `llm-wrapper`: the host's way of running one constrained completion. */
	readonly complete?: CompleteStructured;
}

export function createSystemOne(options: CreateSystemOneOptions): SystemOne {
	switch (options.adapter) {
		case "null":
			return nullSystemOne;
		case "llm-wrapper":
			if (options.complete === undefined) {
				throw new SystemOneAdapterError(
					"The llm-wrapper adapter needs a host that can run a constrained completion; this one supplied none.",
				);
			}
			return createLlmWrapperSystemOne({ complete: options.complete });
		default:
			throw new SystemOneAdapterError(
				`Unknown System One adapter "${options.adapter}"; expected one of ${ADAPTER_NAMES.join(", ")}.`,
			);
	}
}
