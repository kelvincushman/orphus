import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { moduleDir } from "../helpers/runtime.js";

test("browser-operation skill has a single-line front-loaded description", () => {
	const p = join(moduleDir(import.meta.url), "../../packages/web-access/skills/browser-operation/SKILL.md");
	const text = readFileSync(p, "utf8");
	const m = text.match(/^description:\s*(.+)$/m);
	assert.ok(m, "has a description");
	assert.ok((m[1] as string).length < 220, "description stays a one-liner");
	assert.match(text, /sense.*act.*verify/i);
});
