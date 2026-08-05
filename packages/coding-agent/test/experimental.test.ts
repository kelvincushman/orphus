import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalAtomicExperimental = process.env.ORPHUS_EXPERIMENTAL;
	const originalPiExperimental = process.env.PI_EXPERIMENTAL;

	afterEach(() => {
		if (originalAtomicExperimental === undefined) {
			delete process.env.ORPHUS_EXPERIMENTAL;
		} else {
			process.env.ORPHUS_EXPERIMENTAL = originalAtomicExperimental;
		}
		if (originalPiExperimental === undefined) {
			delete process.env.PI_EXPERIMENTAL;
		} else {
			process.env.PI_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when the experimental flags are unset", () => {
		delete process.env.ORPHUS_EXPERIMENTAL;
		delete process.env.PI_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when ORPHUS_EXPERIMENTAL is empty", () => {
		delete process.env.PI_EXPERIMENTAL;
		process.env.ORPHUS_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when ORPHUS_EXPERIMENTAL is set to 1", () => {
		delete process.env.PI_EXPERIMENTAL;
		process.env.ORPHUS_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns true when the legacy PI_EXPERIMENTAL is set to 1", () => {
		delete process.env.ORPHUS_EXPERIMENTAL;
		process.env.PI_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when ORPHUS_EXPERIMENTAL is set to 0", () => {
		delete process.env.PI_EXPERIMENTAL;
		process.env.ORPHUS_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when ORPHUS_EXPERIMENTAL is set to a non-1 value", () => {
		delete process.env.PI_EXPERIMENTAL;
		process.env.ORPHUS_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
