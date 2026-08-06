import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("SettingsManager BOM-prefixed settings", () => {
	const testDir = join(process.cwd(), "test-settings-bom-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("parses enabledModels identically to a BOM-less settings.json", () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, `\uFEFF${JSON.stringify({ enabledModels: ["claude-*"], theme: "dark" })}`);

		const manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getEnabledModels()).toEqual(["claude-*"]);
		expect(manager.getTheme()).toBe("dark");
		expect(manager.drainErrors()).toEqual([]);
	});
});
