import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

/**
 * The ORPHUS wordmark, as orphus.dev renders it in `src/components/AsciiLogo.astro`.
 *
 * The site is a separate repository, so nothing mechanical can compare the two.
 * What can be held is that every copy *here* is the same mark: the terminal
 * banner, the README's plain-text fallback, and the README's SVG once carried
 * three different things — the site kept this art while the repo moved to a
 * `####` mark, and the site's own comment still claimed they matched. Pinning
 * the rows means the next change to one of them is a visible diff on all three.
 */
const WORDMARK_ROWS = [
	" ██████╗ ██████╗ ██████╗ ██╗  ██╗██╗   ██╗███████╗",
	"██╔═══██╗██╔══██╗██╔══██╗██║  ██║██║   ██║██╔════╝",
	"██║   ██║██████╔╝██████╔╝███████║██║   ██║███████╗",
	"██║   ██║██╔══██╗██╔═══╝ ██╔══██║██║   ██║╚════██║",
	"╚██████╔╝██║  ██║██║     ██║  ██║╚██████╔╝███████║",
	" ╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚══════╝",
] as const;

const ROOT = join(import.meta.dirname, "../..");

function read(relativePath: string): string {
	return readFileSync(join(ROOT, relativePath), "utf8");
}

test("every copy of the wordmark in this repository is the same mark", () => {
	const sources: Record<string, string> = {
		"the terminal banner": read("packages/coding-agent/src/modes/interactive/components/atomic-banner.ts"),
		"the README plain-text fallback": read("README.md"),
		"the README wordmark SVG": read("docs/assets/orphus-wordmark.svg"),
	};
	for (const [name, source] of Object.entries(sources)) {
		for (const row of WORDMARK_ROWS) {
			assert.ok(source.includes(row), `${name} is missing the wordmark row: ${row}`);
		}
		assert.ok(!source.includes("####"), `${name} still carries the retired #### mark`);
	}
});

test("the wordmark is a uniform 50-column block, which the banner width must match", () => {
	for (const row of WORDMARK_ROWS) {
		assert.equal([...row].length, 50, `wordmark row is not 50 columns: ${row}`);
	}
	const banner = read("packages/coding-agent/src/modes/interactive/components/atomic-banner.ts");
	assert.match(
		banner,
		/const BANNER_WIDTH = 50;/u,
		"BANNER_WIDTH must equal the mark's column count, or the assembly animation clips it further",
	);
});
