import assert from "node:assert/strict";
import { test } from "vitest";
import { clickWithEscalation } from "../../packages/web-access/browser-actions.js";

function recordingCdp(centerReturns: { x: number; y: number }) {
	const calls: { method: string; params: Record<string, unknown> }[] = [];
	const send = async (method: string, params: Record<string, unknown> = {}) => {
		calls.push({ method, params });
		if (method === "Runtime.evaluate" && String(params.expression).includes("getBoundingClientRect")) {
			return { result: { value: centerReturns } };
		}
		return {};
	};
	return { cdp: { send }, calls };
}

test("escalates to a trusted click exactly once when synthetic no-ops", async () => {
	const r = recordingCdp({ x: 40, y: 30 });
	let changed = false; // synthetic does nothing; trusted flips it
	const rung = await clickWithEscalation(r.cdp, "#buy", async () => {
		const wasChanged = changed;
		if (r.calls.some((c) => c.method === "Input.dispatchMouseEvent")) changed = true;
		return wasChanged;
	});
	assert.equal(rung, "trusted");
	const trusted = r.calls.filter((c) => c.method === "Input.dispatchMouseEvent");
	assert.equal(trusted.length, 2); // press + release, one escalation
});

test("stops at synthetic when the page already responded", async () => {
	const r = recordingCdp({ x: 10, y: 10 });
	const rung = await clickWithEscalation(r.cdp, "#ok", async () => true);
	assert.equal(rung, "synthetic");
	assert.equal(r.calls.filter((c) => c.method === "Input.dispatchMouseEvent").length, 0);
});
