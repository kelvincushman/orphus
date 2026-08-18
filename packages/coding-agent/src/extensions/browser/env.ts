/** Master switch. Without it the `browser` tool is not registered at all. */
export const ENV_ENABLE_BROWSER = "ORPHUS_ENABLE_BROWSER";
/** Additional switch for credential injection. Requires {@link ENV_ENABLE_BROWSER} too. */
export const ENV_ENABLE_BROWSER_LOGIN = "ORPHUS_ENABLE_BROWSER_LOGIN";
/** Space- or comma-separated origins credentials may be used on, e.g. `https://example.com`. */
export const ENV_BROWSER_LOGIN_ORIGINS = "ORPHUS_BROWSER_LOGIN_ORIGINS";
/** Explicit Chrome/Chromium path, when the per-platform candidates miss it. */
export const ENV_BROWSER_EXECUTABLE = "ORPHUS_BROWSER_EXECUTABLE";
/** Set to `0` to run Chrome with a visible window instead of headless. */
export const ENV_BROWSER_HEADLESS = "ORPHUS_BROWSER_HEADLESS";
/**
 * Pass `--no-sandbox` to Chrome. Off by default and deliberately not inferred:
 * it disables Chrome's own process sandbox, which is the last line between a
 * hostile page and the machine. The one legitimate use is a container that runs
 * as root, where Chrome refuses to start at all without it.
 */
export const ENV_BROWSER_NO_SANDBOX = "ORPHUS_BROWSER_NO_SANDBOX";

function isTruthy(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return (
		normalized !== undefined &&
		normalized !== "" &&
		normalized !== "0" &&
		normalized !== "false" &&
		normalized !== "off"
	);
}

/**
 * A security-relevant switch takes only an explicit affirmative. The loose
 * parser above is fine where the loose direction keeps the safe default;
 * `--no-sandbox` removes a boundary, so "no" and "disabled" must not enable it.
 */
function isExplicitlyEnabled(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

export interface BrowserFlags {
	enabled: boolean;
	loginEnabled: boolean;
	loginOrigins: string | undefined;
	executablePath: string | undefined;
	headless: boolean;
	noSandbox: boolean;
}

/**
 * Read the browser switches.
 *
 * Both are off unless explicitly set, and login is off unless browser operation
 * is on: enabling credential injection without enabling the browser must not
 * half-enable anything.
 */
export function readBrowserFlags(env: Record<string, string | undefined> = process.env): BrowserFlags {
	const enabled = isTruthy(env[ENV_ENABLE_BROWSER]);
	return {
		enabled,
		loginEnabled: enabled && isTruthy(env[ENV_ENABLE_BROWSER_LOGIN]),
		loginOrigins: env[ENV_BROWSER_LOGIN_ORIGINS],
		executablePath: env[ENV_BROWSER_EXECUTABLE]?.trim() || undefined,
		headless: env[ENV_BROWSER_HEADLESS] === undefined ? true : isTruthy(env[ENV_BROWSER_HEADLESS]),
		noSandbox: isExplicitlyEnabled(env[ENV_BROWSER_NO_SANDBOX]),
	};
}
