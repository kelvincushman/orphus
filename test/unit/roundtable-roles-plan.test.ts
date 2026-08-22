import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliArgs, runCli } from "../../packages/roundtable/roles/cli.ts";
import { formatPlan, shellQuote } from "../../packages/roundtable/roles/format.ts";
import { parseRoleManifest } from "../../packages/roundtable/roles/manifest.ts";
import { buildLaunchPlan } from "../../packages/roundtable/roles/plan.ts";
import type { LaunchPlan } from "../../packages/roundtable/roles/types.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "orphus-plan-"));
	writeFileSync(join(dir, "planner.md"), "You are the planner.\n");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const SOURCE = `
task: demo
room: design
roles:
  planner:  { provider: anthropic, model: claude-opus, brief: planner.md }
  critic:   { provider: xai,       model: grok }
budgets:
  digest: 1200
  perMessage: 300
`;

function plan(): LaunchPlan {
	return buildLaunchPlan(parseRoleManifest(SOURCE, join(dir, "orphus.roles.yaml")));
}

describe("launch plan", () => {
	it("--format orca honors an explicit cwd and leaves the defaulted one to the worktree", () => {
		// sh and tmux always cd; orca dropped cwd entirely, so the three formats
		// disagreed silently. The default (manifest dir) must STAY out of the orca
		// command — the worktree decides where that terminal opens — but an
		// explicit cwd is the author overriding the worktree, and must survive.
		const explicit = buildLaunchPlan(
			parseRoleManifest(
				SOURCE.replace("model: grok }", "model: grok, cwd: sub/dir }"),
				join(dir, "orphus.roles.yaml"),
			),
		);
		const script = formatPlan(explicit, "orca");
		// The path arrives shell-quoted inside the --command string, so match
		// through the quoting rather than asserting the bare concatenation.
		expect(script).toMatch(/cd .*sub\/dir/);

		const defaulted = formatPlan(plan(), "orca");
		expect(defaulted).not.toContain("cd ");
	});

	it("emits one launch per role, in manifest order", () => {
		expect(plan().launches.map((launch) => launch.role)).toEqual(["planner", "critic"]);
	});

	// Without --name the extension falls back to session-<pid> and the role
	// loses the broker-side cursor that survives restarts.
	it("always names the session after the role", () => {
		for (const launch of plan().launches) {
			expect(launch.args[launch.args.indexOf("--name") + 1]).toBe(launch.role);
		}
	});

	it("passes provider and model through", () => {
		const [planner] = plan().launches;
		expect(planner?.args[planner.args.indexOf("--provider") + 1]).toBe("anthropic");
		expect(planner?.args[planner.args.indexOf("--model") + 1]).toBe("claude-opus");
	});

	it("passes the brief as an absolute path so it resolves from any worktree", () => {
		const [planner] = plan().launches;
		expect(planner?.briefPath).toBe(join(dir, "planner.md"));
		expect(planner?.args).toContain(join(dir, "planner.md"));
	});

	// Brief first, footer last: the room rules are the last word in the prompt.
	it("appends the brief before the footer, and the footer for every role", () => {
		const [planner, critic] = plan().launches;
		const plannerAppends = planner!.args.filter((_, i) => planner!.args[i - 1] === "--append-system-prompt");
		expect(plannerAppends).toEqual([join(dir, "planner.md"), planner!.footer]);

		const criticAppends = critic!.args.filter((_, i) => critic!.args[i - 1] === "--append-system-prompt");
		expect(criticAppends).toEqual([critic!.footer]);
	});

	it("builds a footer carrying role, room, task, and budgets", () => {
		const [planner] = plan().launches;
		expect(planner?.footer).toContain('"planner"');
		expect(planner?.footer).toContain("#design");
		expect(planner?.footer).toContain('"demo"');
		expect(planner?.footer).toContain("1200");
		expect(planner?.footer).toContain("300");
	});

	it("is pure: same manifest in, same plan out", () => {
		expect(plan()).toEqual(plan());
	});

	it("honors a binary override", () => {
		const built = buildLaunchPlan(parseRoleManifest(SOURCE, join(dir, "orphus.roles.yaml")), { binary: "atomic" });
		expect(built.launches.every((launch) => launch.command === "atomic")).toBe(true);
	});
});

describe("shell quoting", () => {
	it("quotes plain text", () => {
		expect(shellQuote("planner")).toBe("'planner'");
	});

	it("escapes embedded single quotes", () => {
		expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
	});

	// Footers are multi-line prose with quotes and #; unquoted they would be
	// truncated at the first space and silently change the role's instructions.
	it("keeps a multi-line footer inside one argument", () => {
		const quoted = shellQuote('line one\nline "two" # not a comment');
		expect(quoted.startsWith("'")).toBe(true);
		expect(quoted.endsWith("'")).toBe(true);
		expect(quoted).toContain("\n");
	});
});

describe("plan formats", () => {
	it("renders every format without throwing", () => {
		for (const format of ["plan", "json", "sh", "tmux", "orca"] as const) {
			expect(formatPlan(plan(), format).length).toBeGreaterThan(0);
		}
	});

	it("emits valid JSON matching the plan", () => {
		expect(JSON.parse(formatPlan(plan(), "json"))).toEqual(JSON.parse(JSON.stringify(plan())));
	});

	it("gives tmux one window per role in a single session", () => {
		const script = formatPlan(plan(), "tmux", { sessionName: "rt" });
		expect(script.match(/tmux new-session/g)).toHaveLength(1);
		expect(script.match(/tmux new-window/g)).toHaveLength(1);
		expect(script).toContain("'rt'");
	});

	it("gives orca one terminal per role with its worktree selector", () => {
		const script = formatPlan(plan(), "orca");
		expect(script.match(/orca terminal create/g)).toHaveLength(2);
		expect(script).toContain("--worktree 'active'");
		expect(script).toContain("--title 'planner'");
	});

	it("quotes the footer in every shell format", () => {
		for (const format of ["sh", "tmux", "orca"] as const) {
			const script = formatPlan(plan(), format);
			// The bare footer text must never appear outside single quotes.
			expect(script).not.toMatch(/--append-system-prompt You are the/);
		}
	});
});

// The tmux script is piped straight to `sh` (`orphus-roles --format tmux | sh`),
// and --session-name is unvalidated operator input, so a crafted name must not
// be able to inject a command. These run the real generated script with a stub
// `tmux` on PATH (so `set -e` does not abort before the trailing echo) and assert
// no injected side effect fires.
describe("tmux script injection safety", () => {
	function withStubTmux(): string {
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		const tmux = join(binDir, "tmux");
		writeFileSync(tmux, "#!/bin/sh\nexit 0\n");
		chmodSync(tmux, 0o755);
		return binDir;
	}

	function runScript(script: string, binDir: string) {
		const scriptPath = join(dir, "launch.sh");
		writeFileSync(scriptPath, script);
		return spawnSync("sh", [scriptPath], {
			cwd: dir,
			env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
			encoding: "utf8",
		});
	}

	it("blocks command injection through the echo line's session name", () => {
		const binDir = withStubTmux();
		const marker = join(dir, "PWNED");
		const script = formatPlan(plan(), "tmux", { sessionName: `x'; touch ${marker}; echo '` });
		const result = runScript(script, binDir);
		expect(result.status).toBe(0);
		expect(existsSync(marker)).toBe(false);
	});

	it("blocks command injection through a newline in the session name", () => {
		const binDir = withStubTmux();
		const marker = join(dir, "PWNED2");
		const script = formatPlan(plan(), "tmux", { sessionName: `a\ntouch ${marker}` });
		const result = runScript(script, binDir);
		expect(result.status).toBe(0);
		expect(existsSync(marker)).toBe(false);
	});

	it("produces a syntactically valid script for a name with an apostrophe", () => {
		const script = formatPlan(plan(), "tmux", { sessionName: "O'Brien" });
		const check = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
		expect(check.status).toBe(0);
	});
});

describe("cli", () => {
	it("defaults to the plan format and the conventional manifest name", () => {
		expect(parseCliArgs([])).toEqual({ manifestPath: "orphus.roles.yaml", format: "plan" });
	});

	it("parses a manifest path and options", () => {
		expect(parseCliArgs(["m.yaml", "--format", "json", "--binary", "atomic"])).toEqual({
			manifestPath: "m.yaml",
			format: "json",
			binary: "atomic",
		});
	});

	it("returns help for -h", () => {
		expect(parseCliArgs(["--help"])).toBe("help");
	});

	it("rejects unknown formats and options", () => {
		expect(() => parseCliArgs(["--format", "yaml"])).toThrow(/unknown format "yaml"/);
		expect(() => parseCliArgs(["--nope"])).toThrow(/unknown option "--nope"/);
		expect(() => parseCliArgs(["--format"])).toThrow(/--format requires a value/);
	});

	it("renders a manifest end to end", () => {
		const path = join(dir, "orphus.roles.yaml");
		writeFileSync(path, SOURCE);
		const output = runCli([path, "--format", "json"]);
		expect(JSON.parse(output).launches).toHaveLength(2);
	});
});
