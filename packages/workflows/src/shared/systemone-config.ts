/**
 * How a user turns the System One layer on, and how tightly they trust it.
 *
 * These live in the workflow extension config rather than a new file of their
 * own because that is where every other knob a workflow honours already lives,
 * and because the layer only has call sites inside workflows today.
 *
 * ```json
 * {
 *   "systemOne": {
 *     "adapter": "null",
 *     "thresholds": { "tier": 0.8, "review": 0.9, "verify": 0.9 },
 *     "local": { "baseUrl": "http://127.0.0.1:8080/v1", "model": "qwen3-4b" }
 *   }
 * }
 * ```
 */

import { getEnvValue } from "@orphus/coding-agent";

/** Selects the adapter. `ORPHUS_SYSTEMONE` overrides the config file. */
export const ENV_SYSTEM_ONE_ADAPTER = "ORPHUS_SYSTEMONE";

export const SYSTEM_ONE_ADAPTERS = ["null", "llm-wrapper", "local", "typesafe"] as const;
export type SystemOneAdapterName = (typeof SYSTEM_ONE_ADAPTERS)[number];

export function isSystemOneAdapterName(value: unknown): value is SystemOneAdapterName {
	return typeof value === "string" && (SYSTEM_ONE_ADAPTERS as readonly string[]).includes(value);
}

/**
 * The confidence each surface demands before it acts on a decision.
 *
 * Per-surface rather than one global number because the surfaces do not carry
 * the same risk. Choosing a tier wrong costs money and a retry; withholding a
 * reviewer's vote or failing a leaf early costs a turn and could mask real
 * progress, so those sit higher. All three are deliberately conservative while
 * no adapter is calibrated — raise them to disable a surface in practice, or
 * set one to 0 to act on every answer (only sensible against a calibrated
 * adapter, and the docs say so).
 */
export interface SystemOneThresholds {
	readonly tier?: number;
	readonly review?: number;
	readonly verify?: number;
}

/** A model server that answers by scoring option tokens. Anything OpenAI-compatible. */
export interface SystemOneLocalSettings {
	/** Base URL including the version segment, e.g. `http://127.0.0.1:8080/v1`. */
	readonly baseUrl?: string;
	readonly model?: string;
	/**
	 * `completions` by default: a chat template can inject reasoning tokens
	 * before the answer, which puts the option letter out of reach of a
	 * single-token read.
	 */
	readonly api?: "completions" | "chat";
	/** Path to a fitted temperature file. Absent means the answers are uncalibrated. */
	readonly calibration?: string;
	readonly timeoutMs?: number;
}

/** TypeSafe's hosted System One model. Opt-in, and the key only ever comes from the environment. */
export interface SystemOneTypesafeSettings {
	readonly baseUrl?: string;
	readonly model?: string;
	readonly timeoutMs?: number;
}

export interface SystemOneSettings {
	readonly adapter?: SystemOneAdapterName;
	readonly thresholds?: SystemOneThresholds;
	readonly local?: SystemOneLocalSettings;
	readonly typesafe?: SystemOneTypesafeSettings;
}

export const SYSTEM_ONE_DEFAULTS = {
	adapter: "null" as SystemOneAdapterName,
	thresholds: { tier: 0.8, review: 0.9, verify: 0.9 },
	local: {
		baseUrl: "http://127.0.0.1:8080/v1",
		model: "",
		api: "completions" as const,
		timeoutMs: 20_000,
	},
	typesafe: {
		baseUrl: "https://api.typesafe.ai",
		model: "jev-latest",
		timeoutMs: 10_000,
	},
} as const;

export interface EffectiveSystemOneConfig {
	readonly adapter: SystemOneAdapterName;
	readonly thresholds: Required<SystemOneThresholds>;
	readonly local: Required<Omit<SystemOneLocalSettings, "calibration">> & { readonly calibration?: string };
	readonly typesafe: Required<SystemOneTypesafeSettings>;
}

/**
 * Fill every absent field, then let the environment override the adapter.
 *
 * The env override is last so a single run can be flipped to a different
 * adapter without editing committed config — which is how the before/after
 * comparison on one Goal run is meant to be taken.
 */
export function withSystemOneDefaults(
	settings: SystemOneSettings = {},
	env: (name: string) => string | undefined = getEnvValue,
): EffectiveSystemOneConfig {
	const requested = env(ENV_SYSTEM_ONE_ADAPTER)?.trim();
	const adapter = isSystemOneAdapterName(requested) ? requested : (settings.adapter ?? SYSTEM_ONE_DEFAULTS.adapter);
	return {
		adapter,
		thresholds: {
			tier: settings.thresholds?.tier ?? SYSTEM_ONE_DEFAULTS.thresholds.tier,
			review: settings.thresholds?.review ?? SYSTEM_ONE_DEFAULTS.thresholds.review,
			verify: settings.thresholds?.verify ?? SYSTEM_ONE_DEFAULTS.thresholds.verify,
		},
		local: {
			baseUrl: settings.local?.baseUrl ?? SYSTEM_ONE_DEFAULTS.local.baseUrl,
			model: settings.local?.model ?? SYSTEM_ONE_DEFAULTS.local.model,
			api: settings.local?.api ?? SYSTEM_ONE_DEFAULTS.local.api,
			timeoutMs: settings.local?.timeoutMs ?? SYSTEM_ONE_DEFAULTS.local.timeoutMs,
			...(settings.local?.calibration === undefined ? {} : { calibration: settings.local.calibration }),
		},
		typesafe: {
			baseUrl: settings.typesafe?.baseUrl ?? SYSTEM_ONE_DEFAULTS.typesafe.baseUrl,
			model: settings.typesafe?.model ?? SYSTEM_ONE_DEFAULTS.typesafe.model,
			timeoutMs: settings.typesafe?.timeoutMs ?? SYSTEM_ONE_DEFAULTS.typesafe.timeoutMs,
		},
	};
}

/**
 * Validate the `systemOne` block of a config file, returning a message or null.
 *
 * Shaped to match the sibling validators in `config-file-loader.ts`: a bad
 * value must name itself rather than being silently replaced by a default,
 * because a threshold that quietly reverted to 0.9 would look identical to one
 * the user meant to set.
 */
export function validateSystemOneSettings(value: unknown): string | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return `"systemOne" must be a JSON object, got ${JSON.stringify(typeof value)}`;
	}
	const settings = value as Record<string, unknown>;

	if ("adapter" in settings && !isSystemOneAdapterName(settings.adapter)) {
		return `"systemOne.adapter" must be one of ${SYSTEM_ONE_ADAPTERS.join(", ")}, got ${JSON.stringify(settings.adapter)}`;
	}

	if ("thresholds" in settings) {
		const thresholds = settings.thresholds;
		if (thresholds === null || typeof thresholds !== "object" || Array.isArray(thresholds)) {
			return `"systemOne.thresholds" must be a JSON object, got ${JSON.stringify(typeof thresholds)}`;
		}
		for (const [name, threshold] of Object.entries(thresholds as Record<string, unknown>)) {
			if (!["tier", "review", "verify"].includes(name)) {
				return `"systemOne.thresholds.${name}" is not a known surface; expected tier, review, or verify`;
			}
			if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
				return `"systemOne.thresholds.${name}" must be a number between 0 and 1, got ${JSON.stringify(threshold)}`;
			}
		}
	}

	if ("local" in settings) {
		const local = settings.local;
		if (local === null || typeof local !== "object" || Array.isArray(local)) {
			return `"systemOne.local" must be a JSON object, got ${JSON.stringify(typeof local)}`;
		}
		const fields = local as Record<string, unknown>;
		for (const name of ["baseUrl", "model", "calibration"]) {
			if (name in fields && (typeof fields[name] !== "string" || (fields[name] as string).trim().length === 0)) {
				return `"systemOne.local.${name}" must be a non-empty string, got ${JSON.stringify(fields[name])}`;
			}
		}
		if ("api" in fields && fields.api !== "completions" && fields.api !== "chat") {
			return `"systemOne.local.api" must be "completions" or "chat", got ${JSON.stringify(fields.api)}`;
		}
		if ("timeoutMs" in fields && (typeof fields.timeoutMs !== "number" || (fields.timeoutMs as number) <= 0)) {
			return `"systemOne.local.timeoutMs" must be a positive number, got ${JSON.stringify(fields.timeoutMs)}`;
		}
	}

	if ("typesafe" in settings) {
		const typesafe = settings.typesafe;
		if (typesafe === null || typeof typesafe !== "object" || Array.isArray(typesafe)) {
			return `"systemOne.typesafe" must be a JSON object, got ${JSON.stringify(typeof typesafe)}`;
		}
		const fields = typesafe as Record<string, unknown>;
		for (const name of ["baseUrl", "model"]) {
			if (name in fields && (typeof fields[name] !== "string" || (fields[name] as string).trim().length === 0)) {
				return `"systemOne.typesafe.${name}" must be a non-empty string, got ${JSON.stringify(fields[name])}`;
			}
		}
		if ("timeoutMs" in fields && (typeof fields.timeoutMs !== "number" || (fields.timeoutMs as number) <= 0)) {
			return `"systemOne.typesafe.timeoutMs" must be a positive number, got ${JSON.stringify(fields.timeoutMs)}`;
		}
	}

	return null;
}

/**
 * The live config, published by the extension when it loads or reloads config
 * and read by the Goal builtin when it starts a run.
 *
 * A module singleton because the extension is one per process and the builtin
 * has no handle on the extension's state — the same reason the durable backend
 * and the graph store are singletons here.
 *
 * Unset, it resolves from defaults on each call rather than being computed at
 * import time: a builtin invoked without the extension having loaded (a unit
 * test, an embedding host) then still honours `ORPHUS_SYSTEMONE`, and gets the
 * null adapter rather than a crash when nothing is set.
 */
let current: EffectiveSystemOneConfig | undefined;

export function setSystemOneConfig(config: EffectiveSystemOneConfig): void {
	current = config;
}

export function resolveSystemOneConfig(): EffectiveSystemOneConfig {
	return current ?? withSystemOneDefaults();
}
