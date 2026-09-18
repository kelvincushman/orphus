/**
 * Choosing an adapter by name.
 *
 * An unknown or unavailable name throws rather than falling back to `null`.
 * A silent fallback would leave a run slower than the user asked for with
 * nothing to show why, and a typo in a config file would be indistinguishable
 * from a deliberate choice.
 */

import { type CompleteStructured, createLlmWrapperSystemOne } from "./adapters/llm-wrapper.ts";
import { createLocalSystemOne, type LocalSystemOneOptions } from "./adapters/local.ts";
import { nullSystemOne } from "./adapters/null.ts";
import { createTypesafeSystemOne, type TypesafeSystemOneOptions } from "./adapters/typesafe.ts";
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
	/** Required by `local`: where the user's own model server is listening. */
	readonly local?: Partial<LocalSystemOneOptions>;
	/** Required by `typesafe`: `apiKey` comes from the environment, never a config file. */
	readonly typesafe?: Partial<TypesafeSystemOneOptions>;
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
		case "local": {
			const model = options.local?.model?.trim();
			const baseUrl = options.local?.baseUrl?.trim();
			if (!model || !baseUrl) {
				throw new SystemOneAdapterError(
					"The local adapter needs systemOne.local.baseUrl and systemOne.local.model — the model server is yours to run.",
				);
			}
			return createLocalSystemOne({ ...options.local, baseUrl, model });
		}
		case "typesafe": {
			const apiKey = options.typesafe?.apiKey?.trim();
			if (!apiKey) {
				throw new SystemOneAdapterError(
					"The typesafe adapter needs TYPESAFE_API_KEY in the environment; it is never read from a config file.",
				);
			}
			return createTypesafeSystemOne({ ...options.typesafe, apiKey });
		}
		default:
			throw new SystemOneAdapterError(
				`Unknown System One adapter "${options.adapter}"; expected one of ${ADAPTER_NAMES.join(", ")}.`,
			);
	}
}
