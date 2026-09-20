#!/usr/bin/env bun
/**
 * One branded HTML report over whatever the test suites left in `.ci-diagnostics`.
 *
 * `run-flaky-test-suite.ts` already asks vitest for its JSON reporter and keeps
 * every attempt, so the data exists on every run, green and red alike — what it
 * lacks is a way to read it without downloading an artifact and squinting at
 * JSON. This turns those reports into one page: the verdict, a row per suite,
 * every failure with its message, and the slowest tests.
 *
 * The palette is read from the shipped dark theme rather than restated here.
 * Orphus green, dim green, off-white and grey already exist in exactly one
 * place per surface — the theme for the terminal, `global.css` for the site —
 * and a third hand-typed copy is how the wordmark ended up in three versions.
 *
 * Usage:
 *   bun run scripts/ci-test-report.ts [--diagnostics-dir <dir>] [--out <file>]
 *
 * Exit code is 0 whenever a report was written. This reports results; it does
 * not gate them. The suites' own exit codes and the duration gate do that, and
 * a reporting step that can fail a green build is a step people delete.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

interface AssertionResult {
	readonly title?: string;
	readonly fullName?: string;
	readonly status?: string;
	readonly duration?: number;
	readonly failureMessages?: readonly string[];
}

interface FileResult {
	readonly name?: string;
	readonly assertionResults?: readonly AssertionResult[];
}

interface VitestReport {
	readonly numTotalTests?: number;
	readonly numPassedTests?: number;
	readonly numFailedTests?: number;
	readonly numPendingTests?: number;
	readonly testResults?: readonly FileResult[];
}

interface TestRow {
	readonly suite: string;
	readonly file: string;
	readonly name: string;
	readonly status: string;
	readonly durationMs: number;
	readonly messages: readonly string[];
}

interface SuiteSummary {
	readonly suite: string;
	readonly attempt: string;
	readonly total: number;
	readonly passed: number;
	readonly failed: number;
	readonly skipped: number;
	readonly durationMs: number;
}

interface Palette {
	readonly black: string;
	readonly surface: string;
	readonly green: string;
	readonly greenDim: string;
	readonly white: string;
	readonly grey: string;
	readonly red: string;
	readonly yellow: string;
}

const THEME = "packages/coding-agent/src/modes/interactive/theme/dark.json";

/**
 * The brand palette, from the theme the terminal actually renders.
 *
 * Falling back would silently produce an off-brand report, which is the one
 * outcome this file exists to prevent — so a missing or malformed theme is an
 * error naming the file rather than a default nobody notices.
 */
function readPalette(root: string): Palette {
	const path = resolve(root, THEME);
	if (!existsSync(path)) throw new Error(`brand palette not found at ${THEME}`);
	const vars = (JSON.parse(readFileSync(path, "utf8")) as { vars?: Record<string, string> }).vars ?? {};
	const need = (key: string): string => {
		const value = vars[key];
		if (typeof value !== "string") throw new Error(`${THEME} has no \`vars.${key}\`, which the report needs`);
		return value;
	};
	return {
		black: "#000000",
		surface: "#0a0f0a",
		green: need("green"),
		greenDim: need("greenDim"),
		white: need("offWhite"),
		grey: need("gray"),
		red: need("red"),
		yellow: need("yellow"),
	};
}

/** The attempt that decided each suite's outcome: its highest-numbered report. */
function newestAttempts(dir: string): { suite: string; attempt: string; path: string }[] {
	const best = new Map<string, { attempt: number; path: string }>();
	for (const name of readdirSync(dir)) {
		const match = /^(.*)-attempt-(\d+)\.json$/u.exec(name);
		if (!match) continue;
		const suite = match[1] ?? "";
		const attempt = Number(match[2]);
		const current = best.get(suite);
		if (current === undefined || attempt > current.attempt) best.set(suite, { attempt, path: resolve(dir, name) });
	}
	return [...best.entries()]
		.map(([suite, { attempt, path }]) => ({ suite, attempt: `attempt ${attempt}`, path }))
		.sort((a, b) => a.suite.localeCompare(b.suite));
}

function readReport(path: string): VitestReport | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as VitestReport;
	} catch {
		// An unreadable report measures exactly as much as one never written.
		return undefined;
	}
}

function collect(dir: string): { suites: SuiteSummary[]; tests: TestRow[] } {
	const suites: SuiteSummary[] = [];
	const tests: TestRow[] = [];
	for (const { suite, attempt, path } of newestAttempts(dir)) {
		const report = readReport(path);
		if (report === undefined) continue;
		let durationMs = 0;
		for (const file of report.testResults ?? []) {
			const shortFile = (file.name ?? "").replaceAll("\\", "/").split("/").slice(-2).join("/");
			for (const assertion of file.assertionResults ?? []) {
				const ms =
					typeof assertion.duration === "number" && Number.isFinite(assertion.duration) ? assertion.duration : 0;
				durationMs += ms;
				tests.push({
					suite,
					file: shortFile,
					name: assertion.fullName ?? assertion.title ?? "(unnamed)",
					status: assertion.status ?? "unknown",
					durationMs: ms,
					messages: assertion.failureMessages ?? [],
				});
			}
		}
		suites.push({
			suite,
			attempt,
			total: report.numTotalTests ?? 0,
			passed: report.numPassedTests ?? 0,
			failed: report.numFailedTests ?? 0,
			skipped: report.numPendingTests ?? 0,
			durationMs,
		});
	}
	return { suites, tests };
}

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function title(slug: string): string {
	return slug.replaceAll("-", " ").replace(/^./u, (char) => char.toUpperCase());
}

function render(input: {
	readonly suites: readonly SuiteSummary[];
	readonly tests: readonly TestRow[];
	readonly palette: Palette;
	readonly meta: Readonly<Record<string, string>>;
}): string {
	const { palette } = input;
	const failures = input.tests.filter((test) => test.status === "failed");
	const totals = input.suites.reduce(
		(sum, suite) => ({
			total: sum.total + suite.total,
			passed: sum.passed + suite.passed,
			failed: sum.failed + suite.failed,
			skipped: sum.skipped + suite.skipped,
			durationMs: sum.durationMs + suite.durationMs,
		}),
		{ total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 },
	);
	const green = totals.failed === 0 && input.suites.length > 0;
	const slowest = [...input.tests].sort((a, b) => b.durationMs - a.durationMs).slice(0, 15);
	const accent = green ? "var(--green)" : "var(--red)";

	const suiteRows = input.suites
		.map(
			(suite) => `<tr>
<th scope="row">${escapeHtml(title(suite.suite))}<span class="sub">${escapeHtml(suite.attempt)}</span></th>
<td class="num">${suite.total}</td>
<td class="num">${suite.passed}</td>
<td class="num ${suite.failed > 0 ? "bad" : "zero"}">${suite.failed}</td>
<td class="num ${suite.skipped > 0 ? "warn" : "zero"}">${suite.skipped}</td>
<td class="num">${escapeHtml(seconds(suite.durationMs))}</td>
</tr>`,
		)
		.join("\n");

	const failureBlocks =
		failures.length === 0
			? `<p class="none">No failures. Every test the suites reported passed or was skipped.</p>`
			: failures
					.map(
						(test) => `<article class="failure">
<h3>${escapeHtml(test.name)}</h3>
<p class="where">${escapeHtml(title(test.suite))} · ${escapeHtml(test.file)} · ${escapeHtml(seconds(test.durationMs))}</p>
<pre>${escapeHtml(test.messages.join("\n\n").trim() || "(no message reported)")}</pre>
</article>`,
					)
					.join("\n");

	const slowRows = slowest
		.map(
			(test) => `<tr>
<td class="num">${escapeHtml(seconds(test.durationMs))}</td>
<td>${escapeHtml(test.name)}</td>
<td class="muted">${escapeHtml(test.file)}</td>
</tr>`,
		)
		.join("\n");

	const metaRows = Object.entries(input.meta)
		.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`)
		.join("\n");

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orphus — test results</title>
<style>
:root {
  --black: ${palette.black};
  --surface: ${palette.surface};
  --green: ${palette.green};
  --green-dim: ${palette.greenDim};
  --white: ${palette.white};
  --grey: ${palette.grey};
  --red: ${palette.red};
  --yellow: ${palette.yellow};
  --line: #1a231c;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--black);
  color: var(--white);
  font: 15px/1.6 var(--mono);
  padding: 32px 16px 64px;
}
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 20px; letter-spacing: .18em; text-transform: uppercase; color: var(--green); margin: 0 0 4px; }
h2 { font-size: 13px; letter-spacing: .16em; text-transform: uppercase; color: var(--grey); margin: 40px 0 12px; }
h3 { font-size: 15px; margin: 0 0 4px; color: var(--white); font-weight: 600; }
a { color: var(--green); }
.tagline { color: var(--grey); margin: 0 0 28px; }
.verdict {
  border: 1px solid var(--line);
  border-left: 3px solid ${accent};
  background: var(--surface);
  padding: 18px 20px;
  margin-bottom: 8px;
}
.verdict .state { font-size: 22px; letter-spacing: .12em; text-transform: uppercase; }
.verdict .counts { color: var(--grey); margin-top: 6px; }
.verdict .counts b { color: var(--white); font-weight: 600; }
table { width: 100%; border-collapse: collapse; margin-top: 4px; }
caption { text-align: left; color: var(--grey); padding-bottom: 8px; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
thead th { color: var(--grey); font-weight: 500; font-size: 12px; letter-spacing: .1em; text-transform: uppercase; background: #0e150f; }
tbody th { font-weight: 600; }
.sub { display: block; color: var(--grey); font-weight: 400; font-size: 12px; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.zero { color: var(--grey); }
.bad { color: var(--red); font-weight: 600; }
.warn { color: var(--yellow); }
.muted { color: var(--grey); }
.none { color: var(--grey); border: 1px dashed var(--line); padding: 16px; }
.failure { border: 1px solid var(--line); border-left: 3px solid var(--red); background: var(--surface); padding: 16px 18px; margin-bottom: 12px; }
.failure .where { color: var(--grey); margin: 0 0 10px; font-size: 13px; }
pre { margin: 0; padding: 12px; background: var(--black); border: 1px solid var(--line); overflow-x: auto; white-space: pre-wrap; word-break: break-word; color: var(--white); font-size: 13px; }
dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px 24px; margin: 0; }
dt { color: var(--grey); font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
dd { margin: 2px 0 0; overflow-wrap: anywhere; }
footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--grey); font-size: 13px; }
</style>
</head>
<body>
<main>
<h1>Orphus</h1>
<p class="tagline">Test results, from the reports the suites wrote.</p>

<section class="verdict">
<div class="state">${green ? "Passing" : "Failing"}</div>
<div class="counts">
<b>${totals.total}</b> tests across <b>${input.suites.length}</b> ${input.suites.length === 1 ? "suite" : "suites"} ·
<b>${totals.passed}</b> passed · <b>${totals.failed}</b> failed · <b>${totals.skipped}</b> skipped ·
<b>${escapeHtml(seconds(totals.durationMs))}</b> of test time
</div>
</section>

<h2>Suites</h2>
<table>
<caption>The attempt that decided each suite. A retried suite shows attempt 2.</caption>
<thead><tr><th scope="col">Suite</th><th scope="col" class="num">Tests</th><th scope="col" class="num">Passed</th><th scope="col" class="num">Failed</th><th scope="col" class="num">Skipped</th><th scope="col" class="num">Time</th></tr></thead>
<tbody>
${suiteRows || '<tr><td colspan="6" class="muted">No readable reports were found.</td></tr>'}
</tbody>
</table>

<h2>Failures</h2>
${failureBlocks}

<h2>Slowest tests</h2>
<table>
<caption>Where the wall clock went. The duration gate scores these against each test's own budget.</caption>
<thead><tr><th scope="col" class="num">Time</th><th scope="col">Test</th><th scope="col">File</th></tr></thead>
<tbody>
${slowRows || '<tr><td colspan="3" class="muted">No durations were reported.</td></tr>'}
</tbody>
</table>

<h2>Run</h2>
<dl>
${metaRows}
</dl>

<footer>Generated by <code>scripts/ci-test-report.ts</code> from the vitest JSON reports in <code>.ci-diagnostics/</code>. Colours come from the shipped <code>${escapeHtml(THEME)}</code>.</footer>
</main>
</body>
</html>
`;
}

/** A compact version for the Actions run page, so results are readable without a download. */
function stepSummary(suites: readonly SuiteSummary[], tests: readonly TestRow[]): string {
	const failures = tests.filter((test) => test.status === "failed");
	const rows = suites
		.map(
			(s) =>
				`| ${title(s.suite)} | ${s.total} | ${s.passed} | ${s.failed} | ${s.skipped} | ${seconds(s.durationMs)} |`,
		)
		.join("\n");
	const failed = failures
		.slice(0, 20)
		.map((test) => `- \`${test.file}\` — ${test.name}`)
		.join("\n");
	return [
		"## Test results",
		"",
		"| Suite | Tests | Passed | Failed | Skipped | Time |",
		"| --- | ---: | ---: | ---: | ---: | ---: |",
		rows || "| _no readable reports_ | | | | | |",
		"",
		failures.length === 0
			? "No failures."
			: `### ${failures.length} failing\n\n${failed}${failures.length > 20 ? "\n- …" : ""}`,
		"",
		"The full branded report is the `test-diagnostics` artifact — open `index.html`.",
	].join("\n");
}

function parseArgs(argv: readonly string[]): { diagnosticsDir: string; out: string } {
	let diagnosticsDir = ".ci-diagnostics";
	let out: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--diagnostics-dir") diagnosticsDir = argv[++index] ?? diagnosticsDir;
		else if (argv[index] === "--out") out = argv[++index];
	}
	return { diagnosticsDir: resolve(diagnosticsDir), out: resolve(out ?? resolve(diagnosticsDir, "index.html")) };
}

const options = parseArgs(process.argv.slice(2));
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");

if (!existsSync(options.diagnosticsDir)) {
	console.log(`no ${basename(options.diagnosticsDir)} directory; nothing to report`);
	process.exit(0);
}

const { suites, tests } = collect(options.diagnosticsDir);
const html = render({
	suites,
	tests,
	palette: readPalette(root),
	meta: {
		repository: process.env.GITHUB_REPOSITORY ?? "local",
		ref: process.env.GITHUB_REF_NAME ?? "local",
		commit: (process.env.GITHUB_SHA ?? "").slice(0, 12) || "local",
		run: process.env.GITHUB_RUN_NUMBER ? `#${process.env.GITHUB_RUN_NUMBER}` : "local",
		generated: new Date().toISOString(),
	},
});

mkdirSync(dirname(options.out), { recursive: true });
writeFileSync(options.out, html);
console.log(`wrote ${options.out} (${suites.length} suite(s), ${tests.length} test(s))`);

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) appendFileSync(summaryPath, `${stepSummary(suites, tests)}\n`);
