import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	archiveInstallerCommand,
	getSelfUpdateCommandForRuntime,
	getSelfUpdateUnavailableInstructionForRuntime,
	getUpdateInstructionForRuntime,
	ORPHUS_INSTALLER_ONE_LINER,
	type SelfUpdateRuntime,
	versionFromInstallSpec,
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
		const instruction = getSelfUpdateUnavailableInstructionForRuntime(binaryRuntime(), "@orphus/coding-agent");
		expect(instruction).toContain("https://github.com/kelvincushman/orphus/releases/latest");
		expect(instruction).toContain(ORPHUS_INSTALLER_ONE_LINER);
		expect(instruction).not.toContain("bastani-inc");
		expect(instruction).not.toContain("pi-mono");
		expect(getUpdateInstructionForRuntime(binaryRuntime(), "@orphus/coding-agent")).toBe(instruction);
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

	it("re-runs the canonical installer pinned to this install's root", () => {
		// The bare one-liner updated the DEFAULT location: a custom-root install
		// got a full second copy at the default paths, a success message, and its
		// real install untouched — so the version nag repeated forever.
		const command = getSelfUpdateCommandForRuntime(binaryRuntime(executable), "@orphus/coding-agent");
		expect(command).toBeDefined();
		expect(command?.command).toBe("sh");
		expect(command?.args[1]).toContain(`ORPHUS_INSTALL_DIR='${root}'`);
		expect(command?.args[1]).toContain("| ORPHUS_INSTALL_DIR=");
	});

	it("pins the resolved release: version env and the tag's own install.sh", () => {
		// Without ORPHUS_VERSION the installer resolves /releases/latest, which
		// GitHub redirects to the newest NON-prerelease — a silent downgrade for
		// every beta runner. And the script itself comes from the resolved tag,
		// not main HEAD, so the installer that runs is the one that release
		// shipped.
		const command = getSelfUpdateCommandForRuntime(binaryRuntime(executable), "@orphus/coding-agent", undefined, {
			packageName: "@orphus/coding-agent",
			installSpec: "@orphus/coding-agent@0.2.0",
		});
		expect(command?.args[1]).toContain("ORPHUS_VERSION='v0.2.0'");
		expect(command?.args[1]).toContain("/v0.2.0/install.sh");
		expect(command?.args[1]).not.toContain("/main/install.sh");
	});

	it("tells install.sh layouts to run the installer against their own root", () => {
		const instruction = getUpdateInstructionForRuntime(binaryRuntime(executable), "@orphus/coding-agent");
		expect(instruction).toContain(`ORPHUS_INSTALL_DIR='${root}'`);
		expect(instruction).not.toContain("releases/latest");
	});

	it("reads a version only from a spec that pins one", () => {
		expect(versionFromInstallSpec("@orphus/coding-agent@0.2.0")).toBe("0.2.0");
		expect(versionFromInstallSpec("@orphus/coding-agent@0.2.0-alpha.1")).toBe("0.2.0-alpha.1");
		expect(versionFromInstallSpec("@orphus/coding-agent")).toBeUndefined();
		expect(versionFromInstallSpec("@orphus/coding-agent@next")).toBeUndefined();
	});

	it("quotes a hostile root rather than letting it into the shell", () => {
		const command = archiveInstallerCommand("/tmp/it's here", "0.2.0");
		expect(command).toContain(`ORPHUS_INSTALL_DIR='/tmp/it'\\''s here'`);
	});

	it("does not treat a bare binary outside the layout as an archive install", () => {
		const bare = join(root, "orphus-standalone");
		writeFileSync(bare, "#!/bin/sh\n");
		expect(getSelfUpdateCommandForRuntime(binaryRuntime(bare), "@orphus/coding-agent")).toBeUndefined();
	});

	it("requires the current pointer, not just a versions directory", () => {
		rmSync(join(root, "current"));
		expect(getSelfUpdateCommandForRuntime(binaryRuntime(executable), "@orphus/coding-agent")).toBeUndefined();
	});
});
