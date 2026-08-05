import { describe, expect, it } from "vitest";
import roundtableExtension from "../../packages/roundtable/index.ts";
import { registerRoundtableTool } from "../../packages/roundtable/roundtable-tool.ts";

describe("roundtable extension surface", () => {
	it("exports an extension entry point and tool registrar", () => {
		expect(typeof roundtableExtension).toBe("function");
		expect(typeof registerRoundtableTool).toBe("function");
	});
});
