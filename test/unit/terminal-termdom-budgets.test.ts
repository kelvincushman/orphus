import assert from "node:assert/strict";
import { TermDOM } from "@b9g/termdom";
import { test } from "vitest";
import type { SessionInfo } from "../../packages/coding-agent/src/core/session-manager.js";
import { SessionSelectorModel } from "../../packages/coding-agent/src/core/terminal/session-selector-model.js";
import { renderSelectorHtml } from "../../packages/coding-agent/src/core/terminal/termdom-view.js";
import { createFakeTerminalTransport } from "./terminal-fake-transport.js";

/**
 * The termDOM pilot's budgets.
 *
 * These are the numbers the program commits the pilot to before the default can
 * flip, measured the only way that is reproducible in CI: against the injected
 * transport, with real layout and real ANSI, no TTY and no window manager.
 *
 * They are deliberately generous, and they are **not** the release gate. A
 * shared CI runner is not the pinned runner, so what these catch is a
 * regression that matters — layout going quadratic in row count, a repaint on
 * every idle tick — which moves them by an order of magnitude.
 *
 * The release gate is stricter and is not automated here: warm first frame p95
 * ≤150 ms, and 500-session input-to-render median ≤20 ms and p95 ≤50 ms, on the
 * pinned runner. It must be measured there before termDOM becomes the default
 * for any surface. Passing the budgets below is necessary and not sufficient.
 */
const FIRST_FRAME_BUDGET_MS = 1_500;
const INPUT_TO_RENDER_MEDIAN_BUDGET_MS = 200;
const INPUT_TO_RENDER_P95_BUDGET_MS = 500;

/** A full termDOM boot is process-shaped work, not a slow assertion. */
const TERMDOM_BUDGET_TIMEOUT_MS = 120_000;

function session(index: number): SessionInfo {
	return {
		id: `session-${index}`,
		path: `/s/session-${index}.jsonl`,
		cwd: "/work/project",
		modified: new Date(2026, 0, 1, 0, 0, index % 60),
		allMessagesText: `conversation ${index} about releases and refactors`,
		name: `Session ${index}`,
	} as SessionInfo;
}

const FIVE_HUNDRED = Array.from({ length: 500 }, (_, index) => session(index));

function percentile(samples: number[], fraction: number): number {
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

test(
	"the first frame of a 500-session list renders inside the warm budget",
	async () => {
		const model = new SessionSelectorModel();
		model.setSessions("current", FIVE_HUNDRED);
		const transport = createFakeTerminalTransport({ cols: 120, rows: 40 });
		const dom = new TermDOM({ transport });
		try {
			// Warm the engine the way a real session does — a stylesheet parse and a
			// first layout are startup cost, not per-frame cost.
			dom.renderANSI(renderSelectorHtml(model.getState(), { columns: 120, rows: 40 }));

			const started = performance.now();
			dom.renderANSI(renderSelectorHtml(model.getState(), { columns: 120, rows: 40 }));
			const elapsed = performance.now() - started;

			assert.ok(elapsed <= FIRST_FRAME_BUDGET_MS, `warm first frame took ${elapsed.toFixed(1)}ms`);
		} finally {
			await dom.dispose();
		}
	},
	TERMDOM_BUDGET_TIMEOUT_MS,
);

test(
	"input-to-render over a 500-session list stays inside the median and p95 budgets",
	async () => {
		const model = new SessionSelectorModel();
		model.setSessions("current", FIVE_HUNDRED);
		const transport = createFakeTerminalTransport({ cols: 120, rows: 40 });
		const dom = new TermDOM({ transport });
		try {
			dom.renderANSI(renderSelectorHtml(model.getState(), { columns: 120, rows: 40 }));

			const samples: number[] = [];
			for (const character of "release prep session") {
				const started = performance.now();
				model.setQuery(model.getState().query + character);
				dom.renderANSI(renderSelectorHtml(model.getState(), { columns: 120, rows: 40 }));
				samples.push(performance.now() - started);
			}

			const median = percentile(samples, 0.5);
			const p95 = percentile(samples, 0.95);
			assert.ok(median <= INPUT_TO_RENDER_MEDIAN_BUDGET_MS, `median ${median.toFixed(1)}ms`);
			assert.ok(p95 <= INPUT_TO_RENDER_P95_BUDGET_MS, `p95 ${p95.toFixed(1)}ms`);
		} finally {
			await dom.dispose();
		}
	},
	TERMDOM_BUDGET_TIMEOUT_MS,
);

test(
	"an idle picker writes nothing and schedules nothing",
	async () => {
		const model = new SessionSelectorModel();
		model.setSessions("current", FIVE_HUNDRED.slice(0, 20));
		const transport = createFakeTerminalTransport({ cols: 100, rows: 30 });
		const dom = new TermDOM({ transport });
		try {
			await dom.attach();
			dom.document.body.innerHTML = renderSelectorHtml(model.getState(), { columns: 100, rows: 30 });
			// Let the mutation-driven render settle.
			await new Promise((resolve) => setTimeout(resolve, 100));

			const afterFirstPaint = transport.frames.length;
			assert.ok(afterFirstPaint > 0, "the picker painted at least once");

			// Nothing touches the model; nothing should touch the terminal either.
			await new Promise((resolve) => setTimeout(resolve, 300));

			assert.equal(transport.frames.length, afterFirstPaint, "an idle picker must not repaint on a timer");
		} finally {
			await dom.dispose();
		}
	},
	TERMDOM_BUDGET_TIMEOUT_MS,
);
