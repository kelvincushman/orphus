import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentDir } from "../../packages/roundtable/broker/paths.ts";
import {
	buildDossierArgs,
	gateAction,
	isMemoryAction,
	type MemoryConfig,
	parseCommand,
	resolveMemoryConfig,
} from "../../packages/roundtable/memory/dossier.ts";
import { runDossier } from "../../packages/roundtable/memory/run.ts";
import { registerMemoryTool } from "../../packages/roundtable/memory-tool.ts";

let dir: string;
let stub: string;

// A stub that stands in for `python -m dossier`. Running the whole memory path
// against it proves argv, cwd, and exit handling end to end without Python or a
// wiki on disk. Special first args exercise the failure modes the review found:
//   boom     — exit 3 with stderr
//   selfkill — die by signal (close fires with code=null)
//   split    — write one UTF-8 char as two separate byte writes across chunks
const STUB = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "boom") {
	process.stderr.write("stub failure");
	process.exit(3);
} else if (args[0] === "selfkill") {
	process.kill(process.pid, "SIGKILL");
} else if (args[0] === "split") {
	// "日" is E6 97 A5; writing byte 1 then bytes 2-3 separately (with a gap to
	// force two 'data' events) splits the sequence across chunk boundaries.
	process.stdout.write(Buffer.from([0xe6]));
	setTimeout(() => process.stdout.write(Buffer.from([0x97, 0xa5])), 15);
} else {
	process.stdout.write(JSON.stringify({ args, cwd: process.cwd() }));
}
`;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "orphus-memory-"));
	stub = join(dir, "stub.mjs");
	writeFileSync(stub, STUB);
	chmodSync(stub, 0o755);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function stubConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
	return { command: [process.execPath, stub], writerRole: "librarian", ...overrides };
}

describe("memory config", () => {
	it("splits the command on whitespace", () => {
		expect(parseCommand("  python  -m   dossier ")).toEqual(["python", "-m", "dossier"]);
	});

	it("defaults command, writer role, and anchors cwd under the agent dir", () => {
		const config = resolveMemoryConfig({});
		assert.deepEqual(config.command, ["python", "-m", "dossier"]);
		assert.equal(config.writerRole, "librarian");
		// Anchored, not cwd-relative: this is what makes Orca worktrees share one wiki.
		const expected = join(getAgentDir({}), "memory");
		assert.equal(config.cwd, expected);
		assert.equal(resolveMemoryConfig({ ORPHUS_MEMORY_DIR: "   " }).cwd, expected);
	});

	// Each Orca role runs in its own worktree. If the wiki were cwd-relative, every
	// role would silently get its own empty memory and queries would "succeed" empty.
	it("resolves the same memory dir regardless of process cwd", () => {
		const original = process.cwd();
		const a = resolveMemoryConfig({}).cwd;
		process.chdir(tmpdir());
		try {
			assert.equal(resolveMemoryConfig({}).cwd, a);
		} finally {
			process.chdir(original);
		}
	});

	it("honors environment overrides", () => {
		const config = resolveMemoryConfig({
			ORPHUS_MEMORY_COMMAND: "uv run dossier",
			ORPHUS_MEMORY_DIR: "/tmp/wiki",
			ORPHUS_MEMORY_WRITER_ROLE: "archivist",
		});
		expect(config.command).toEqual(["uv", "run", "dossier"]);
		expect(config.cwd).toBe("/tmp/wiki");
		expect(config.writerRole).toBe("archivist");
	});
});

describe("action gate", () => {
	it("allows reads for any role, including an unnamed session", () => {
		for (const role of ["planner", "librarian", undefined]) {
			expect(gateAction("query", role, "librarian").allowed).toBe(true);
			expect(gateAction("doctor", role, "librarian").allowed).toBe(true);
		}
	});

	it("allows writes only for the writer role", () => {
		expect(gateAction("ingest", "librarian", "librarian").allowed).toBe(true);
		expect(gateAction("gardener", "librarian", "librarian").allowed).toBe(true);
	});

	it("denies writes from other roles and names the offender", () => {
		const denied = gateAction("ingest", "planner", "librarian");
		expect(denied.allowed).toBe(false);
		expect(denied.reason).toContain('"planner"');
		expect(denied.reason).toContain("librarian");
	});

	it("denies writes from an unnamed session and points at --name", () => {
		const denied = gateAction("gardener", undefined, "librarian");
		expect(denied.allowed).toBe(false);
		expect(denied.reason).toContain("--name librarian");
	});
});

describe("argument building", () => {
	it("passes query and ingest values through", () => {
		expect(buildDossierArgs({ action: "query", question: "what did we decide?" })).toEqual([
			"query",
			"what did we decide?",
		]);
		expect(buildDossierArgs({ action: "ingest", source: "raw/notes.md" })).toEqual(["ingest", "raw/notes.md"]);
	});

	it("needs no params for gardener and doctor", () => {
		expect(buildDossierArgs({ action: "gardener" })).toEqual(["gardener"]);
		expect(buildDossierArgs({ action: "doctor" })).toEqual(["doctor"]);
	});

	it("requires a question for query and a source for ingest", () => {
		expect(() => buildDossierArgs({ action: "query" })).toThrow(/requires a 'question'/);
		expect(() => buildDossierArgs({ action: "ingest", source: "  " })).toThrow(/requires a 'source'/);
	});

	it("recognizes only the four known actions", () => {
		for (const action of ["query", "doctor", "ingest", "gardener"]) expect(isMemoryAction(action)).toBe(true);
		expect(isMemoryAction("delete")).toBe(false);
	});
});

describe("runDossier against a stub backend", () => {
	it("creates a missing configured memory directory before spawning", async () => {
		const cwd = join(dir, "new", "memory");
		const result = await runDossier(stubConfig({ cwd }), ["doctor"]);
		assert.equal(result.code, 0);
		const parsed = JSON.parse(result.stdout) as { cwd: string };
		assert.equal(realpathSync(parsed.cwd), realpathSync(cwd));
	});

	it("passes argv through and runs in the configured cwd", async () => {
		const result = await runDossier(stubConfig({ cwd: dir }), ["query", "hi"]);
		expect(result.code).toBe(0);
		const parsed = JSON.parse(result.stdout) as { args: string[]; cwd: string };
		expect(parsed.args).toEqual(["query", "hi"]);
		expect(realpathSync(parsed.cwd)).toBe(realpathSync(dir));
	});

	it("surfaces a non-zero exit with its stderr", async () => {
		const result = await runDossier(stubConfig(), ["boom"]);
		expect(result.code).toBe(3);
		expect(result.stderr).toContain("stub failure");
	});

	// A signal-killed backend (OOM, SIGSEGV) fires close with code=null. Collapsing
	// that to 0 would read as a successful empty answer; it must be a failure.
	it("reports a signal-terminated backend as a non-zero failure", async () => {
		const result = await runDossier(stubConfig(), ["selfkill"]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toMatch(/signal/i);
	});

	// A multi-byte character split across two chunks must not decode to U+FFFD.
	it("decodes multi-byte UTF-8 that straddles a chunk boundary", async () => {
		const result = await runDossier(stubConfig(), ["split"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("日");
		expect(result.stdout).not.toContain("�");
	});

	it("rejects when the backend command is missing", async () => {
		await expect(runDossier({ command: [], writerRole: "librarian" }, ["doctor"])).rejects.toThrow();
		await expect(
			runDossier({ command: [join(dir, "does-not-exist")], writerRole: "librarian" }, ["doctor"]),
		).rejects.toThrow();
	});
});

// A minimal ExtensionAPI stand-in: capture the single tool the extension
// registers, then invoke its execute() to cover gate + run + formatting.
function captureMemoryTool(config: MemoryConfig, role: string | undefined) {
	let tool:
		| { execute: (...args: unknown[]) => Promise<{ isError: boolean; content: { text: string }[] }> }
		| undefined;
	const pi = {
		registerTool: (def: typeof tool) => {
			tool = def;
		},
	} as unknown as Parameters<typeof registerMemoryTool>[0];
	registerMemoryTool(pi, { config, currentRole: () => role });
	if (!tool) throw new Error("memory tool was not registered");
	const run = (params: Record<string, unknown>) => tool!.execute("call-1", params, undefined, undefined, undefined);
	return { run };
}

describe("memory tool", () => {
	it("returns a query answer from the backend", async () => {
		const { run } = captureMemoryTool(stubConfig({ cwd: dir }), "planner");
		const result = await run({ action: "query", question: "status?" });
		expect(result.isError).toBe(false);
		expect(result.content[0]?.text).toContain("query");
	});

	it("blocks a non-librarian from ingesting, before spawning anything", async () => {
		const { run } = captureMemoryTool(stubConfig(), "planner");
		const result = await run({ action: "ingest", source: "raw/x.md" });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("librarian");
	});

	it("lets the librarian ingest", async () => {
		const { run } = captureMemoryTool(stubConfig({ cwd: dir }), "librarian");
		const result = await run({ action: "ingest", source: "raw/x.md" });
		expect(result.isError).toBe(false);
		const parsed = JSON.parse(result.content[0]!.text) as { args: string[] };
		expect(parsed.args).toEqual(["ingest", "raw/x.md"]);
	});

	it("rejects an unknown action and a query with no question", async () => {
		const { run } = captureMemoryTool(stubConfig(), "planner");
		expect((await run({ action: "delete" })).isError).toBe(true);
		expect((await run({ action: "query" })).isError).toBe(true);
	});

	it("reports a clear notice when the backend is not installed", async () => {
		const { run } = captureMemoryTool({ command: [join(dir, "nope")], writerRole: "librarian" }, "planner");
		const result = await run({ action: "doctor" });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("Memory backend not reachable");
	});
});
