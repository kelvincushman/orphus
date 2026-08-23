import { describe, expect, test } from "vitest";
import { type ChangelogEntry, normalizeChangelogLinks } from "../src/utils/changelog.ts";

const entry: ChangelogEntry = {
	major: 0,
	minor: 79,
	patch: 0,
	prerelease: null,
	version: "0.79.0",
	content: "",
};

describe("normalizeChangelogLinks", () => {
	test("rewrites package-relative changelog links to tag-pinned GitHub source links", () => {
		const markdown = [
			"[Project Trust](README.md#project-trust)",
			"[Extensions](docs/extensions.md#project_trust)",
			"[Examples](examples/extensions/)",
			"[Root README](../../README.md#supply-chain-hardening)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, entry)).toBe(
			[
				"[Project Trust](https://github.com/kelvincushman/orphus/blob/0.79.0/packages/coding-agent/README.md#project-trust)",
				"[Extensions](https://github.com/kelvincushman/orphus/blob/0.79.0/packages/coding-agent/docs/extensions.md#project_trust)",
				"[Examples](https://github.com/kelvincushman/orphus/tree/0.79.0/packages/coding-agent/examples/extensions/)",
				"[Root README](https://github.com/kelvincushman/orphus/blob/0.79.0/README.md#supply-chain-hardening)",
			].join("\n"),
		);
	});

	test("leaves foreign repository URLs and external links unchanged", () => {
		// Upstream attribution links (pi-mono, atomic) must survive verbatim:
		// their issue/PR numbers do not exist in this repository, and inherited
		// entries reference tags this repository never cut.
		const markdown = [
			"[#5167](https://github.com/earendil-works/pi-mono/pull/5167)",
			"[#4163](https://github.com/badlogic/pi-mono/issues/4163)",
			"[Agent README](https://github.com/badlogic/pi-mono/blob/main/packages/agent/README.md)",
			"[#12](https://github.com/bastani-inc/atomic/pull/12)",
			"[External](https://example.com/docs)",
			"[Local anchor](#settings)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, "0.79.0")).toBe(markdown);
	});
});
