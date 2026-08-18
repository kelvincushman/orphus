import type { CdpConnection } from "./cdp/connection.js";

export type CdpLike = Pick<CdpConnection, "send">;

export async function locateCenter(cdp: CdpLike, selector: string): Promise<{ x: number; y: number } | null> {
	const expr = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`;
	const res = (await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true })) as {
		result?: { value?: { x: number; y: number } | null };
	};
	return res.result?.value ?? null;
}

async function syntheticClick(cdp: CdpLike, selector: string): Promise<void> {
	await cdp.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})?.click()` });
}

async function trustedClick(cdp: CdpLike, point: { x: number; y: number }): Promise<void> {
	for (const type of ["mousePressed", "mouseReleased"] as const) {
		await cdp.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
	}
}

export async function clickWithEscalation(
	cdp: CdpLike,
	selector: string,
	senseChanged: () => Promise<boolean>,
): Promise<"synthetic" | "trusted" | "failed"> {
	await syntheticClick(cdp, selector);
	if (await senseChanged()) return "synthetic";
	const point = await locateCenter(cdp, selector);
	if (!point) return "failed";
	await trustedClick(cdp, point);
	// One settle re-check: a sense implementation may observe page state one
	// tick behind the mutation it reports, so a single retry here keeps an
	// already-registered change from reading as "failed".
	if (await senseChanged()) return "trusted";
	return (await senseChanged()) ? "trusted" : "failed";
}

export async function typeText(cdp: CdpLike, text: string): Promise<void> {
	await cdp.send("Input.insertText", { text });
}

export async function readPage(cdp: CdpLike, as: "text" | "dom" | "accessibility" | "screenshot"): Promise<string> {
	if (as === "screenshot") {
		const r = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data?: string };
		return r.data ?? "";
	}
	if (as === "accessibility") {
		const r = (await cdp.send("Accessibility.getFullAXTree")) as Record<string, unknown>;
		return JSON.stringify(r);
	}
	const expr = as === "dom" ? "document.documentElement.outerHTML" : "document.body.innerText";
	const r = (await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true })) as {
		result?: { value?: string };
	};
	return r.result?.value ?? "";
}
