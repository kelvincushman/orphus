import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRoleManifest, parseRoleManifest } from "../../packages/roundtable/roles/manifest.ts";
import { RoleManifestError } from "../../packages/roundtable/roles/types.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "orphus-roles-"));
	writeFileSync(join(dir, "planner.md"), "You are the planner.\n");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function manifestPath(): string {
	return join(dir, "orphus.roles.yaml");
}

const MINIMAL = `
task: demo
room: design
roles:
  planner: { provider: anthropic, model: claude-opus, brief: planner.md }
`;

describe("role manifest parsing", () => {
	it("parses the documented manifest shape", () => {
		const manifest = parseRoleManifest(
			`
task: rate-limiter-design
room: design
roles:
  planner:    { provider: anthropic, model: claude-opus, brief: planner.md }
  researcher: { provider: openai,    model: gpt-fast }
budgets:
  digest: 1500
  perMessage: 400
`,
			manifestPath(),
		);

		expect(manifest.task).toBe("rate-limiter-design");
		expect(manifest.room).toBe("design");
		expect(manifest.budgets).toEqual({ digest: 1500, perMessage: 400 });
		expect(manifest.roles.map((role) => role.name)).toEqual(["planner", "researcher"]);
		expect(manifest.roles[0]?.briefPath).toBe(join(dir, "planner.md"));
		expect(manifest.roles[1]?.briefPath).toBeUndefined();
	});

	it("applies default budgets and inherits the manifest room", () => {
		const manifest = parseRoleManifest(MINIMAL, manifestPath());
		expect(manifest.budgets).toEqual({ digest: 2000, perMessage: 600 });
		expect(manifest.roles[0]?.room).toBe("design");
		expect(manifest.roles[0]?.cwd).toBe(dir);
		expect(manifest.roles[0]?.worktree).toBe("active");
	});

	it("honors per-role room, cwd, and worktree overrides", () => {
		const manifest = parseRoleManifest(
			`
task: demo
room: design
roles:
  critic:
    provider: xai
    model: grok
    room: review
    cwd: sub/dir
    worktree: name:critic
`,
			manifestPath(),
		);
		const critic = manifest.roles[0];
		expect(critic?.room).toBe("review");
		expect(critic?.cwd).toBe(join(dir, "sub", "dir"));
		expect(critic?.worktree).toBe("name:critic");
	});

	it("resolves relative brief paths against the manifest directory", () => {
		const manifest = parseRoleManifest(MINIMAL, manifestPath());
		expect(manifest.roles[0]?.briefPath).toBe(join(dir, "planner.md"));
	});

	// --append-system-prompt treats an unreadable path as literal prompt text,
	// so a typo would silently become the role's system prompt.
	it("rejects a brief path that does not exist", () => {
		expect(() =>
			parseRoleManifest(
				`
task: demo
room: design
roles:
  planner: { provider: anthropic, model: claude-opus, brief: missing.md }
`,
				manifestPath(),
			),
		).toThrow(/roles\.planner\.brief — file not found/);
	});

	it("names the offending key path on a missing field", () => {
		expect(() =>
			parseRoleManifest(
				`
task: demo
room: design
roles:
  critic: { provider: xai }
`,
				manifestPath(),
			),
		).toThrow(/roles\.critic\.model — expected a non-empty string, got nothing/);
	});

	it("rejects role names that cannot key a broker cursor", () => {
		expect(() =>
			parseRoleManifest(
				`
task: demo
room: design
roles:
  "the planner": { provider: anthropic, model: claude-opus }
`,
				manifestPath(),
			),
		).toThrow(/must be alphanumeric/);
	});

	it("rejects non-positive or fractional budgets", () => {
		for (const budget of ["0", "-5", "1.5"]) {
			expect(() =>
				parseRoleManifest(`${MINIMAL}\nbudgets:\n  digest: ${budget}\n`, manifestPath()),
			).toThrow(/budgets\.digest — expected a positive integer/);
		}
	});

	it("rejects an empty or missing roles map", () => {
		expect(() => parseRoleManifest("task: demo\nroom: design\nroles: {}\n", manifestPath())).toThrow(
			/roles — at least one role is required/,
		);
		expect(() => parseRoleManifest("task: demo\nroom: design\n", manifestPath())).toThrow(
			/roles — expected a map/,
		);
	});

	it("reports invalid YAML against the manifest path", () => {
		expect(() => parseRoleManifest("task: [unclosed\n", manifestPath())).toThrow(RoleManifestError);
		expect(() => parseRoleManifest("task: [unclosed\n", manifestPath())).toThrow(/invalid YAML/);
	});

	it("loads from disk and reports a missing manifest clearly", () => {
		writeFileSync(manifestPath(), MINIMAL);
		expect(loadRoleManifest(manifestPath()).task).toBe("demo");
		expect(() => loadRoleManifest(join(dir, "nope.yaml"))).toThrow(/manifest not found/);
	});
});
