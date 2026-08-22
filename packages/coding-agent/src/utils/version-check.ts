import { compare, prerelease, valid } from "semver";
import { ENV_OFFLINE, ENV_SKIP_VERSION_CHECK, getEnvValue, VERSION } from "../config.ts";

// The fork is not published to npm: @orphus/coding-agent on the registry is the
// UPSTREAM package, whose version has nothing to do with Orphus releases. The
// authority for "latest" is this repository's GitHub releases — the same
// source install.sh resolves against. Two channels fall out of GitHub's own
// endpoints: /releases/latest excludes prereleases (the stable channel), and
// the release list's first entry is the newest release of any kind.
const RELEASES_API = "https://api.github.com/repos/kelvincushman/orphus/releases";
const STABLE_CHANNEL_URL = `${RELEASES_API}/latest`;
const NEWEST_RELEASE_URL = `${RELEASES_API}?per_page=1`;
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

function isPrereleaseVersion(version: string): boolean {
	const normalized = valid(version.trim());
	return normalized !== null && prerelease(normalized) !== null;
}

/**
 * The versionless placeholder stamped on `main` and read from source-tree dev
 * runs (`bun packages/coding-agent/src/cli.ts`). Real releases never carry it —
 * `scripts/cut-release.ts` materializes the actual version on the tag commit —
 * so encountering it means this is a dev build that should not be compared
 * against the published registry version.
 */
const DEV_VERSION_PLACEHOLDER = "0.0.0";

export function isDevVersion(version: string): boolean {
	return version.trim() === DEV_VERSION_PLACEHOLDER;
}

export interface LatestPiRelease {
	version: string;
	packageName?: string;
	note?: string;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

function versionFromTag(tag: unknown): string | undefined {
	if (typeof tag !== "string") return undefined;
	// Release tags are v-prefixed (release.yml triggers on v*); the version
	// under the prefix is what VERSION carries and semver compares.
	const version = tag.trim().replace(/^v/, "");
	return version || undefined;
}

export async function getLatestPiRelease(
	options: { timeoutMs?: number; currentVersion?: string } = {},
): Promise<LatestPiRelease | undefined> {
	if (getEnvValue(ENV_OFFLINE)) return undefined;
	// One signal per request: AbortSignal.timeout starts at construction, so a
	// shared signal gave the fallback fetch only whatever the first one left —
	// aborting the exact path the fallthrough exists to serve.
	const requestInit = () => ({
		headers: {
			accept: "application/vnd.github+json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});

	// Stable runners track the stable channel: a stable install must not be
	// dragged onto a newer beta. Prerelease runners opted onto the bleeding
	// edge and track the newest release of any kind. While ONLY prereleases
	// exist, the stable endpoint 404s and everyone falls through to the list.
	const currentVersion = options.currentVersion ?? VERSION;
	if (!isPrereleaseVersion(currentVersion)) {
		const stable = await fetch(STABLE_CHANNEL_URL, requestInit());
		if (stable.ok) {
			const data = (await stable.json()) as { tag_name?: unknown };
			const version = versionFromTag(data.tag_name);
			if (version) return { version };
		} else if (stable.status !== 404) {
			// 404 is the one documented fallthrough: no stable release exists yet.
			// Any other failure (403 rate limit, 5xx) says nothing about what the
			// newest stable IS — falling through offered a stable install the
			// newest prerelease instead. "Could not check" is the honest answer.
			return undefined;
		}
	}

	const response = await fetch(NEWEST_RELEASE_URL, requestInit());
	if (!response.ok) return undefined;
	const data = (await response.json()) as unknown;
	if (!Array.isArray(data) || data.length === 0) return undefined;
	const version = versionFromTag((data[0] as { tag_name?: unknown }).tag_name);
	return version ? { version } : undefined;
}

export async function getLatestPiVersion(
	options: { timeoutMs?: number; currentVersion?: string } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(options))?.version;
}

export async function checkForNewPiVersion(currentVersion: string): Promise<string | undefined> {
	if (getEnvValue(ENV_SKIP_VERSION_CHECK)) return undefined;
	// Dev builds always read the versionless `0.0.0` placeholder, which is older
	// than any published release, so the registry check would always nag. Skip it
	// (and the network call) for source-tree/dev runs.
	if (isDevVersion(currentVersion)) {
		return undefined;
	}
	try {
		const latestVersion = await getLatestPiVersion();
		if (latestVersion && isNewerPackageVersion(latestVersion, currentVersion)) {
			return latestVersion;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
