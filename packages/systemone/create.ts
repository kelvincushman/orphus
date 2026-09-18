/**
 * Choosing an adapter by name.
 *
 * An unknown or unavailable name throws rather than falling back to `null`.
 * A silent fallback would leave a run slower than the user asked for with
 * nothing to show why, and a typo in a config file would be indistinguishable
 * from a deliberate choice.
 */

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
}

export function createSystemOne(options: CreateSystemOneOptions): SystemOne {
	switch (options.adapter) {
		case "null":
			return nullSystemOne;
		default:
			throw new SystemOneAdapterError(
				`Unknown System One adapter "${options.adapter}"; expected one of ${ADAPTER_NAMES.join(", ")}.`,
			);
	}
}
