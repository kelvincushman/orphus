import { existsSync } from "node:fs";
import { platform } from "node:os";

const CANDIDATES: Record<string, string[]> = {
	darwin: [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
	],
	linux: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"],
};

export function findChrome(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | null {
	const override = env.ORPHUS_CHROME_PATH;
	if (override && exists(override)) return override;
	for (const candidate of CANDIDATES[platform()] ?? []) if (exists(candidate)) return candidate;
	return null;
}
