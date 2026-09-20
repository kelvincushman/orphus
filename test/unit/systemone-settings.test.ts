import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import { loadConfigFile } from "../../packages/workflows/src/extension/config-file-loader.js";
import { loadWorkflowConfig, withWorkflowDefaults } from "../../packages/workflows/src/extension/config-loader.js";
import {
	ENV_SYSTEM_ONE_ADAPTER,
	resolveSystemOneConfig,
	SYSTEM_ONE_DEFAULTS,
	setSystemOneConfig,
	validateSystemOneSettings,
	withSystemOneDefaults,
} from "../../packages/workflows/src/shared/systemone-config.js";

const noEnv = () => undefined;

describe("System One settings", () => {
	test("default to the null adapter and conservative thresholds", () => {
		const config = withSystemOneDefaults({}, noEnv);
		assert.equal(config.adapter, "null");
		assert.deepEqual(config.thresholds, { tier: 0.8, review: 0.9, verify: 0.9 });
		assert.equal(config.local.api, "completions");
		assert.equal(config.typesafe.model, "jev-latest");
	});

	test("a partially specified block keeps the defaults it did not mention", () => {
		const config = withSystemOneDefaults({ thresholds: { tier: 0.6 } }, noEnv);
		assert.equal(config.thresholds.tier, 0.6);
		assert.equal(config.thresholds.review, SYSTEM_ONE_DEFAULTS.thresholds.review);
	});

	test("the environment overrides the configured adapter, so one run can be flipped", () => {
		const env = (name: string) => (name === ENV_SYSTEM_ONE_ADAPTER ? "llm-wrapper" : undefined);
		assert.equal(withSystemOneDefaults({ adapter: "null" }, env).adapter, "llm-wrapper");
	});

	test("an unrecognised environment value falls back to the config rather than failing a run", () => {
		const env = (name: string) => (name === ENV_SYSTEM_ONE_ADAPTER ? "jev" : undefined);
		assert.equal(withSystemOneDefaults({ adapter: "local" }, env).adapter, "local");
	});

	test("workflow defaults expose the effective System One config", () => {
		assert.equal(withWorkflowDefaults({}).systemOne.adapter, "null");
		assert.equal(withWorkflowDefaults({ systemOne: { adapter: "local" } }).systemOne.adapter, "local");
	});
});

describe("System One settings merging", () => {
	/** A global and a project config on disk, merged by the real loader. */
	async function loadMerged(globalConfig: unknown, projectConfig: unknown) {
		const homeDir = await mkdtemp(join(tmpdir(), "orphus-systemone-home-"));
		const projectRoot = await mkdtemp(join(tmpdir(), "orphus-systemone-proj-"));
		try {
			const globalDir = join(homeDir, ".atomic", "agent", "extensions", "workflow");
			const projectDir = join(projectRoot, ".atomic", "extensions", "workflow");
			await mkdir(globalDir, { recursive: true });
			await mkdir(projectDir, { recursive: true });
			await writeFile(join(globalDir, "config.json"), JSON.stringify(globalConfig), "utf8");
			await writeFile(join(projectDir, "config.json"), JSON.stringify(projectConfig), "utf8");
			const result = await loadWorkflowConfig({ homeDir, projectRoot });
			assert.deepEqual(result.diagnostics, []);
			return result.config;
		} finally {
			await rm(homeDir, { recursive: true, force: true });
			await rm(projectRoot, { recursive: true, force: true });
		}
	}

	test("a project raising one threshold does not drop the ones it left alone", async () => {
		// The nested groups merge key-by-key; a shallow spread would replace the
		// whole thresholds object and silently reset the other two surfaces.
		const merged = await loadMerged(
			{ systemOne: { adapter: "local", thresholds: { tier: 0.5, review: 0.95, verify: 0.95 } } },
			{ systemOne: { thresholds: { tier: 0.7 } } },
		);
		assert.deepEqual(merged?.systemOne?.thresholds, { tier: 0.7, review: 0.95, verify: 0.95 });
		assert.equal(merged?.systemOne?.adapter, "local");
	});

	test("project settings win over global ones", async () => {
		const merged = await loadMerged(
			{ systemOne: { adapter: "null", local: { model: "global-model", baseUrl: "http://global/v1" } } },
			{ systemOne: { adapter: "local", local: { model: "project-model" } } },
		);
		assert.equal(merged?.systemOne?.adapter, "local");
		assert.equal(merged?.systemOne?.local?.model, "project-model");
		assert.equal(merged?.systemOne?.local?.baseUrl, "http://global/v1");
	});

	test("a config with no System One block stays absent rather than materializing one", async () => {
		const merged = await loadMerged({ maxDepth: 2 }, { defaultConcurrency: 8 });
		assert.equal(merged?.systemOne, undefined);
	});
});

describe("System One config validation", () => {
	const invalid = (systemOne: unknown) => validateSystemOneSettings(systemOne);

	test("accepts a full, valid block", () => {
		assert.equal(
			validateSystemOneSettings({
				adapter: "local",
				thresholds: { tier: 0.8, review: 0.9, verify: 1 },
				local: { baseUrl: "http://127.0.0.1:8080/v1", model: "qwen3-4b", api: "chat", timeoutMs: 5000 },
				typesafe: { baseUrl: "https://api.typesafe.ai", model: "jev-latest" },
			}),
			null,
		);
	});

	test("names an unknown adapter rather than silently using the default", () => {
		// A typo that quietly reverted to `null` would look exactly like a
		// deliberate choice, and the run would be slower for no stated reason.
		assert.match(invalid({ adapter: "jev" })!, /must be one of null, llm-wrapper, local, typesafe/u);
	});

	test("rejects a threshold outside 0..1 and an unknown surface", () => {
		assert.match(invalid({ thresholds: { tier: 1.5 } })!, /between 0 and 1/u);
		assert.match(invalid({ thresholds: { tier: "high" } })!, /between 0 and 1/u);
		assert.match(invalid({ thresholds: { plan: 0.5 } })!, /not a known surface/u);
	});

	test("rejects malformed adapter settings", () => {
		assert.match(invalid({ local: { api: "responses" } })!, /"completions" or "chat"/u);
		assert.match(invalid({ local: { baseUrl: "" } })!, /non-empty string/u);
		assert.match(invalid({ local: { timeoutMs: 0 } })!, /positive finite number/u);
		assert.match(invalid({ typesafe: { timeoutMs: -1 } })!, /positive finite number/u);
		assert.match(invalid({ typesafe: { model: 7 } })!, /non-empty string/u);
		assert.match(invalid([])!, /must be a JSON object/u);
	});

	test("rejects a timeout that is a number but not a usable one", () => {
		// `1e400` is how a JSON config file spells Infinity. It passes both a
		// typeof and a `> 0` test while being no timeout at all: Node clamps it
		// and fires almost at once, so every decision would abort and abstain
		// while the setting reported itself valid.
		const parsed = JSON.parse('{"timeoutMs": 1e400}') as { readonly timeoutMs: number };
		assert.equal(parsed.timeoutMs, Number.POSITIVE_INFINITY);
		assert.match(invalid({ local: parsed })!, /positive finite number/u);
		assert.match(invalid({ typesafe: parsed })!, /positive finite number/u);
	});

	test("a bad block fails the real config file load rather than being ignored", async () => {
		// Proves the validator is actually reached by the loader: a rule that
		// exists but is never called is the failure mode this guards.
		const dir = await mkdtemp(join(tmpdir(), "orphus-systemone-config-"));
		try {
			const path = join(dir, "config.json");
			await writeFile(path, JSON.stringify({ systemOne: { adapter: "jev" } }), "utf8");
			const outcome = await loadConfigFile(path);
			assert.equal(outcome.kind, "error");
			if (outcome.kind !== "error") return;
			assert.equal(outcome.diagnostic.code, "CONFIG_INVALID");
			assert.match(outcome.diagnostic.message, /systemOne\.adapter/u);

			await writeFile(path, JSON.stringify({ systemOne: { adapter: "local" } }), "utf8");
			const accepted = await loadConfigFile(path);
			assert.equal(accepted.kind, "ok");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("the published System One config", () => {
	test("resolves to defaults before the extension has published anything", () => {
		assert.equal(resolveSystemOneConfig().adapter, "null");
	});

	test("resolves to what the extension published", () => {
		const published = withSystemOneDefaults({ adapter: "llm-wrapper", thresholds: { tier: 0.55 } }, noEnv);
		setSystemOneConfig(published);
		try {
			assert.equal(resolveSystemOneConfig().adapter, "llm-wrapper");
			assert.equal(resolveSystemOneConfig().thresholds.tier, 0.55);
		} finally {
			setSystemOneConfig(withSystemOneDefaults({}, noEnv));
		}
	});
});
