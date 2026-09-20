import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "ci-test-report.ts");
const theme = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"packages/coding-agent/src/modes/interactive/theme/dark.json",
);

function report(dir, { env = {} } = {}) {
	const run = spawnSync("bun", ["run", script, "--diagnostics-dir", dir], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	assert.equal(run.status, 0, `exit ${run.status}\n${run.stdout}\n${run.stderr}`);
	return { stdout: run.stdout, html: readFileSync(join(dir, "index.html"), "utf8") };
}

function writeAttempt(dir, name, payload) {
	writeFileSync(join(dir, name), JSON.stringify(payload));
}

function passing(total = 2) {
	return {
		numTotalTests: total,
		numPassedTests: total,
		numFailedTests: 0,
		numPendingTests: 0,
		testResults: [
			{
				name: "/repo/test/unit/widget.test.ts",
				assertionResults: Array.from({ length: total }, (_value, index) => ({
					title: `case ${index}`,
					fullName: `widget > case ${index}`,
					status: "passed",
					duration: 10 + index,
				})),
			},
		],
	};
}

test("renders a passing verdict with every suite's counts", () => {
	const dir = mkdtempSync(join(tmpdir(), "orphus-report-"));
	try {
		writeAttempt(dir, "unit-tests-attempt-1.json", passing(2));
		writeAttempt(dir, "integration-tests-attempt-1.json", passing(3));

		const { html, stdout } = report(dir);
		assert.match(stdout, /2 suite\(s\), 5 test\(s\)/);
		assert.match(html, /<div class="state">Passing<\/div>/);
		assert.match(html, /<b>5<\/b> tests/);
		assert.match(html, /Unit tests/);
		assert.match(html, /Integration tests/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reads the brand palette from the shipped theme rather than a copy", () => {
	// A second hand-typed copy of the palette is how the wordmark ended up in
	// three versions. This asserts the values come from the one file the
	// terminal renders, so a theme change reaches the report without an edit.
	const dir = mkdtempSync(join(tmpdir(), "orphus-report-"));
	try {
		writeAttempt(dir, "unit-tests-attempt-1.json", passing());
		const { vars } = JSON.parse(readFileSync(theme, "utf8"));
		const { html } = report(dir);
		assert.match(html, new RegExp(`--green: ${vars.green}`));
		assert.match(html, new RegExp(`--green-dim: ${vars.greenDim}`));
		assert.match(html, new RegExp(`--white: ${vars.offWhite}`));
		assert.match(html, new RegExp(`--grey: ${vars.gray}`));
		assert.match(html, /--black: #000000/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reports a failure with its message, and escapes what the message contains", () => {
	// Failure messages carry arbitrary source text. An unescaped `<` would break
	// the page open at exactly the moment someone needs to read it.
	const dir = mkdtempSync(join(tmpdir(), "orphus-report-"));
	try {
		writeAttempt(dir, "unit-tests-attempt-1.json", {
			numTotalTests: 1,
			numPassedTests: 0,
			numFailedTests: 1,
			numPendingTests: 0,
			testResults: [
				{
					name: "/repo/test/unit/widget.test.ts",
					assertionResults: [
						{
							title: "breaks",
							fullName: "widget > breaks",
							status: "failed",
							duration: 5,
							failureMessages: ['expected <b>"a" & "b"</b>'],
						},
					],
				},
			],
		});

		const { html } = report(dir);
		assert.match(html, /<div class="state">Failing<\/div>/);
		assert.match(html, /border-left: 3px solid var\(--red\)/);
		assert.match(html, /expected &lt;b&gt;&quot;a&quot; &amp; &quot;b&quot;&lt;\/b&gt;/);
		assert.doesNotMatch(html, /expected <b>/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reports the attempt that decided the suite, not the one that failed first", () => {
	// A retried suite writes two reports. Summing them would double every count
	// and show the failure the retry cleared as if it still stood.
	const dir = mkdtempSync(join(tmpdir(), "orphus-report-"));
	try {
		writeAttempt(dir, "unit-tests-attempt-1.json", {
			numTotalTests: 1,
			numPassedTests: 0,
			numFailedTests: 1,
			numPendingTests: 0,
			testResults: [
				{
					name: "/repo/test/unit/flaky.test.ts",
					assertionResults: [
						{ fullName: "flaky > sometimes", status: "failed", duration: 9, failureMessages: ["first attempt"] },
					],
				},
			],
		});
		writeAttempt(dir, "unit-tests-attempt-2.json", passing(1));

		const { stdout, html } = report(dir);
		assert.match(stdout, /1 suite\(s\), 1 test\(s\)/);
		assert.match(html, /<div class="state">Passing<\/div>/);
		assert.match(html, /attempt 2/);
		assert.doesNotMatch(html, /first attempt/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writes the step summary only when Actions asked for one", () => {
	const dir = mkdtempSync(join(tmpdir(), "orphus-report-"));
	try {
		writeAttempt(dir, "unit-tests-attempt-1.json", passing(2));
		const summary = join(dir, "summary.md");
		writeFileSync(summary, "");
		report(dir, { env: { GITHUB_STEP_SUMMARY: summary } });
		const written = readFileSync(summary, "utf8");
		assert.match(written, /## Test results/);
		assert.match(written, /\| Unit tests \| 2 \| 2 \| 0 \| 0 \|/);
		assert.match(written, /No failures\./);

		// Without the variable there is nowhere to write, and the run must not
		// invent a file: a local run should leave nothing behind but the report.
		const bare = mkdtempSync(join(tmpdir(), "orphus-report-"));
		writeAttempt(bare, "unit-tests-attempt-1.json", passing(2));
		const before = new Set(spawnSync("ls", [bare], { encoding: "utf8" }).stdout.split("\n"));
		report(bare);
		const after = spawnSync("ls", [bare], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
		assert.deepEqual(
			after.filter((name) => !before.has(name)),
			["index.html"],
		);
		rmSync(bare, { recursive: true, force: true });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("survives an unreadable report instead of failing the step", () => {
	// This step reports results; it must never be the reason a green build goes
	// red. The duration gate already fails loudly on a blind report.
	const dir = mkdtempSync(join(tmpdir(), "orphus-report-"));
	try {
		writeFileSync(join(dir, "unit-tests-attempt-1.json"), "{ truncated");
		writeAttempt(dir, "integration-tests-attempt-1.json", passing(2));
		const { stdout, html } = report(dir);
		assert.match(stdout, /1 suite\(s\), 2 test\(s\)/);
		assert.match(html, /Integration tests/);
		assert.doesNotMatch(html, /Unit tests/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("says so plainly when there is no diagnostics directory at all", () => {
	const missing = join(tmpdir(), `orphus-report-absent-${process.pid}`);
	const run = spawnSync("bun", ["run", script, "--diagnostics-dir", missing], { encoding: "utf8" });
	assert.equal(run.status, 0);
	assert.match(run.stdout, /nothing to report/);
});
