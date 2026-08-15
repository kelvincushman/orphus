import assert from "node:assert/strict";
import { test } from "vitest";
import {
	formatKernelView,
	formatQuietResult,
	KERNEL_BUFFER_CHARS,
	KERNEL_VIEW_CHARS,
	KernelBuffer,
} from "../../packages/coding-agent/src/core/repl/kernel-output.js";

test("a view of any output stays within the cap, whatever the code printed", () => {
	// The property the phase's acceptance criteria name: bounded output holds
	// regardless of what runs. Exercised across sizes rather than one sample.
	for (const size of [0, 1, KERNEL_VIEW_CHARS - 1, KERNEL_VIEW_CHARS, KERNEL_VIEW_CHARS + 1, 1_000_000]) {
		const buffer = new KernelBuffer();
		buffer.append("x".repeat(size));

		const view = buffer.view();
		assert.ok(view.text.length <= KERNEL_VIEW_CHARS, `size ${size} produced a ${view.text.length}-char view`);
	}
});

test("the buffer keeps the tail, because the last thing said is the interesting one", () => {
	const buffer = new KernelBuffer(10);
	buffer.append("0123456789ABCDE");

	assert.equal(buffer.full(), "56789ABCDE");
	assert.equal(buffer.droppedChars, 5);
});

test("an elision is counted, never silent", () => {
	// A view that dropped characters silently is indistinguishable from a short
	// output, and the agent would reason about a truncated result believing it
	// complete.
	const buffer = new KernelBuffer();
	buffer.append("y".repeat(KERNEL_VIEW_CHARS + 500));

	const view = buffer.view();
	assert.equal(view.elidedChars, 500);
	assert.match(formatKernelView(view), /500 earlier character\(s\) not shown/);
});

test("output that scrolled out of the buffer is reported as unrecoverable", () => {
	// Different from an elision: an elided character is still in the buffer and
	// can be shown. A dropped one is gone, and saying so is the difference
	// between a bound and a loss.
	const buffer = new KernelBuffer(100);
	buffer.append("z".repeat(250));

	const rendered = formatKernelView(buffer.view());
	assert.match(rendered, /150 character\(s\) scrolled out of the kernel's buffer and are unrecoverable/);
});

test("a pointer to the full output turns a bound into something a reader can act on", () => {
	const buffer = new KernelBuffer();
	buffer.append("q".repeat(KERNEL_VIEW_CHARS + 1));

	const rendered = formatKernelView(buffer.view(), { fullOutputPath: "/tmp/session/out.txt" });
	assert.match(rendered, /full output: \/tmp\/session\/out\.txt/);
});

test("output that fits is returned verbatim, with no note appended", () => {
	// A bound that annotates everything trains the reader to ignore the notes.
	const buffer = new KernelBuffer();
	buffer.append("small output\n");

	const view = buffer.view();
	assert.deepEqual(view, { text: "small output\n", elidedChars: 0, droppedFromBuffer: 0 });
	assert.equal(formatKernelView(view), "small output\n");
});

test("appending repeatedly cannot grow the buffer past its capacity", () => {
	// The memory bound. A REPL printing in a loop must not be able to exhaust
	// the host through a thousand small writes.
	const buffer = new KernelBuffer(1_000);
	for (let index = 0; index < 1_000; index += 1) buffer.append("chunk".repeat(20));

	assert.equal(buffer.full().length, 1_000);
	assert.equal(buffer.droppedChars, 1_000 * 100 - 1_000);
});

test("clear empties the buffer without forgetting what was already lost", () => {
	const buffer = new KernelBuffer(10);
	buffer.append("0123456789ABCDE");
	buffer.clear();

	assert.equal(buffer.full(), "");
	// The 5 dropped characters are still unrecoverable; clearing the view does
	// not make them recoverable, and the count must not imply otherwise.
	assert.equal(buffer.droppedChars, 5);
});

test("the quiet result is the one-line acknowledgement the kernel exists for", () => {
	// `docs = open('big.json').read()` should cost the agent this, not the file.
	const line = formatQuietResult("work", 42);

	assert.equal(line, "ok (work, 42ms, no output)");
	assert.ok(line.length < 60);
});

test("the buffer capacity is stated, not implied", () => {
	assert.equal(KERNEL_BUFFER_CHARS, 200_000);
	assert.equal(KERNEL_VIEW_CHARS, 4_000);
});
