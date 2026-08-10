import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getSelfUpdateCommandForRuntime,
	getSelfUpdateUnavailableInstructionForRuntime,
	getUpdateInstructionForRuntime,
	ORPHUS_INSTALLER_ONE_LINER,
	type SelfUpdateRuntime,
} from "../src/config-self-update.ts";

function binaryRuntime(executablePath?: string): SelfUpdateRuntime {
	return {
		isBunBinary: true,
		isBunRuntime: true,
		moduleDir: "/opt/orphus",
		getPackageDir: () => "/opt/orphus",
		...(executablePath ? { getExecutablePath: () => executablePath } : {}),
	};
}

const unixOnly = process.platform === "win32" ? describe.skip : describe;

describe("standalone Orphus update guidance", () => {
	it("directs unmanaged bun binaries to the Orphus releases and the installer", () => {
		const instruction = getSelfUpdateUnavailableInstructionForRuntime(binaryRuntime(), "@bastani/atomic");
		expect(instruction).toContain("https://github.com/kelvincushman/orphus/releases/latest");
		expect(instruction).toContain(ORPHUS_INSTALLER_ONE_LINER);
		expect(instruction).not.toContain("bastani-inc");
		expect(instruction).not.toContain("pi-mono");
		expect(getUpdateInstructionForRuntime(binaryRuntime(), "@bastani/atomic")).toBe(instruction);
	});
});

unixOnly("archive-install self-update", () => {
	let root: string;
	let executable: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "orphus-archive-install-"));
		const versionDir = join(root, "versions", "v0.1.0-alpha.5");
		mkdirSync(versionDir, { recursive: true });
		executable = join(versionDir, "orphus");
		writeFileSync(executable, "#!/bin/sh\n");
		symlinkSync(join("versions", "v0.1.0-alpha.5"), join(root, "current"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("re-runs the canonical installer for install.sh layouts", () => {
		const command = getSelfUpdateCommandForRuntime(binaryRuntime(executable), "@bastani/atomic");
		expect(command).toBeDefined();
		expect(command?.command).toBe("sh");
		expect(command?.args).toEqual(["-c", ORPHUS_INSTALLER_ONE_LINER]);
	});

	it("tells install.sh layouts that self-update runs the installer", () => {
		const instruction = getUpdateInstructionForRuntime(binaryRuntime(executable), "@bastani/atomic");
		expect(instruction).toContain(ORPHUS_INSTALLER_ONE_LINER);
		expect(instruction).not.toContain("releases/latest");
	});

	it("does not treat a bare binary outside the layout as an archive install", () => {
		const bare = join(root, "orphus-standalone");
		writeFileSync(bare, "#!/bin/sh\n");
		expect(getSelfUpdateCommandForRuntime(binaryRuntime(bare), "@bastani/atomic")).toBeUndefined();
	});

	it("requires the current pointer, not just a versions directory", () => {
		rmSync(join(root, "current"));
		expect(getSelfUpdateCommandForRuntime(binaryRuntime(executable), "@bastani/atomic")).toBeUndefined();
	});
});
