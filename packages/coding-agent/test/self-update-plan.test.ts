import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, VERSION } from "../src/config.ts";
import { buildSelfUpdatePlan } from "../src/self-update-plan.ts";

// End-to-end, releases resolved from GitHub never carry packageName (see
// src/utils/version-check.ts), so the rename branch is unreachable through the
// CLI. The machinery is kept for upstream parity; these tests pin it directly.
describe("buildSelfUpdatePlan", () => {
	function newerPatchVersion(): string {
		const [major = "0", minor = "0", patch = "0"] = VERSION.split(".");
		return `${major}.${minor}.${Number.parseInt(patch, 10) + 1}`;
	}

	it("targets the current package when the release names none", () => {
		const targetVersion = newerPatchVersion();
		const plan = buildSelfUpdatePlan({ version: targetVersion });
		expect(plan.packageName).toBe(PACKAGE_NAME);
		expect(plan.installSpec).toBe(`${PACKAGE_NAME}@${targetVersion}`);
		expect(plan.shouldRun).toBe(true);
	});

	it("skips the current version unless forced", () => {
		expect(buildSelfUpdatePlan({ version: VERSION }).shouldRun).toBe(false);
		expect(buildSelfUpdatePlan({ version: VERSION }, true).shouldRun).toBe(true);
	});

	it("honors a renamed package even at the same version", () => {
		const plan = buildSelfUpdatePlan({ version: VERSION, packageName: "@new-scope/pi" });
		expect(plan.packageName).toBe("@new-scope/pi");
		expect(plan.installSpec).toBe(`@new-scope/pi@${VERSION}`);
		expect(plan.shouldRun).toBe(true);
	});
});
