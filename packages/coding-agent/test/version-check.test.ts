import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	getLatestPiRelease,
	getLatestPiVersion,
	isDevVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";

const originalSkipVersionCheck = process.env.ORPHUS_SKIP_VERSION_CHECK;
const originalOffline = process.env.ORPHUS_OFFLINE;

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.ORPHUS_SKIP_VERSION_CHECK;
	} else {
		process.env.ORPHUS_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
	if (originalOffline === undefined) {
		delete process.env.ORPHUS_OFFLINE;
	} else {
		process.env.ORPHUS_OFFLINE = originalOffline;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json([{ tag_name: "v1.2.3" }]));
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toBe("1.2.3");
	});

	it("queries the Orphus GitHub releases for the latest version", async () => {
		// The fork is not published to npm: @bastani/atomic on the registry is the
		// UPSTREAM package, whose version has nothing to do with Orphus releases.
		const fetchMock = vi.fn(async () => Response.json([{ tag_name: "v1.2.4" }]));
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		await expect(getLatestPiVersion()).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/kelvincushman/orphus/releases?per_page=1",
			expect.objectContaining({
				headers: expect.objectContaining({
					accept: "application/vnd.github+json",
				}),
			}),
		);
	});

	it("strips the v prefix and reports no npm package name", async () => {
		const fetchMock = vi.fn(async () => Response.json([{ tag_name: "v0.1.0-alpha.6" }]));
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		await expect(getLatestPiRelease()).resolves.toEqual({ version: "0.1.0-alpha.6" });
	});

	it("returns undefined for an empty release list or malformed tag", async () => {
		const empty = vi.fn(async () => Response.json([]));
		vi.spyOn(globalThis, "fetch").mockImplementation(empty);
		await expect(getLatestPiRelease()).resolves.toBeUndefined();
		vi.restoreAllMocks();
		const malformed = vi.fn(async () => Response.json([{ tag_name: 7 }]));
		vi.spyOn(globalThis, "fetch").mockImplementation(malformed);
		await expect(getLatestPiRelease()).resolves.toBeUndefined();
	});

	it.each(["ORPHUS_SKIP_VERSION_CHECK", "PI_SKIP_VERSION_CHECK"])(
		"skips automatic api calls when %s is set",
		async (name) => {
			vi.stubEnv(name, "1");
			const fetchMock = vi.fn(async () => Response.json([{ tag_name: "v1.2.4" }]));
			vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

			await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each(["ORPHUS_SKIP_VERSION_CHECK", "PI_SKIP_VERSION_CHECK"])(
		"allows explicit release checks when %s disables startup checks",
		async (name) => {
			vi.stubEnv(name, "1");
			const fetchMock = vi.fn(async () => Response.json([{ tag_name: "v1.2.4" }]));
			vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

			await expect(getLatestPiVersion()).resolves.toBe("1.2.4");
			expect(fetchMock).toHaveBeenCalledOnce();
		},
	);

	it("treats the versionless placeholder as a dev build", () => {
		expect(isDevVersion("0.0.0")).toBe(true);
		expect(isDevVersion(" 0.0.0 ")).toBe(true);
		expect(isDevVersion("1.2.3")).toBe(false);
		expect(isDevVersion("0.0.1")).toBe(false);
	});

	it("does not nag dev builds (0.0.0) for updates", async () => {
		const fetchMock = vi.fn(async () => Response.json([{ tag_name: "v1.2.3" }]));
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		await expect(checkForNewPiVersion("0.0.0")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
