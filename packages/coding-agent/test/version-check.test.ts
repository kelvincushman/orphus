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

	it("stable runners resolve the stable channel first", async () => {
		// GitHub's /releases/latest IS the stable channel: it excludes
		// prereleases. A stable install must not be dragged onto a newer beta.
		const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
			String(url).endsWith("/releases/latest")
				? Response.json({ tag_name: "v1.2.4" })
				: Response.json([{ tag_name: "v1.3.0-beta.1" }]),
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as never);

		await expect(getLatestPiVersion({ currentVersion: "1.2.3" })).resolves.toBe("1.2.4");
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
			"https://api.github.com/repos/kelvincushman/orphus/releases/latest",
		);
	});

	it("a rate-limited stable check reports nothing rather than offering a prerelease", async () => {
		// Only 404 means "no stable release exists yet". A 403 or 5xx says
		// nothing about what the newest stable IS — falling through to the
		// any-kind list offered a stable install the newest beta, as a spurious
		// upgrade it would not even receive.
		const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
			String(url).includes("/releases/latest")
				? new Response("rate limited", { status: 403 })
				: Response.json([{ tag_name: "v1.3.0-beta.2" }]),
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as never);
		expect(await getLatestPiVersion({ currentVersion: "1.2.0" })).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("each request gets its own timeout budget", async () => {
		// AbortSignal.timeout starts at construction: one shared init gave the
		// fallback request only whatever the stable probe left of the budget —
		// aborting the exact path the fallthrough exists to serve.
		const signals: Array<AbortSignal | undefined> = [];
		const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			signals.push(init?.signal ?? undefined);
			return String(url).includes("/releases/latest")
				? new Response("nope", { status: 404 })
				: Response.json([{ tag_name: "v1.2.4-beta.1" }]);
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as never);
		await getLatestPiVersion({ currentVersion: "1.2.0" });
		expect(signals).toHaveLength(2);
		expect(signals[0]).toBeDefined();
		expect(signals[1]).toBeDefined();
		expect(signals[0]).not.toBe(signals[1]);
	});

	it("falls back to the release list while only prereleases exist", async () => {
		const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
			String(url).endsWith("/releases/latest")
				? new Response("not found", { status: 404 })
				: Response.json([{ tag_name: "v1.2.4" }]),
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as never);

		await expect(getLatestPiVersion({ currentVersion: "1.2.3" })).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("prerelease runners track the newest release, prerelease or not", async () => {
		// Beta testers opted onto the bleeding edge; keep them there.
		const fetchMock = vi.fn(async () => Response.json([{ tag_name: "v1.3.0-beta.2" }]));
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as never);

		await expect(getLatestPiVersion({ currentVersion: "1.3.0-beta.1" })).resolves.toBe("1.3.0-beta.2");
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
			"https://api.github.com/repos/kelvincushman/orphus/releases?per_page=1",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
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

			await expect(getLatestPiVersion({ currentVersion: "1.2.3-beta.1" })).resolves.toBe("1.2.4");
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
