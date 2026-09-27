// Test extension: drives session-tree navigation with summarization, which is
// otherwise only reachable through the interactive UI.
//
// `ctx.navigateTree(id, { summarize: true })` makes Orphus summarize the
// abandoned branch through the selected provider's isolated one-off path.
import type { ExtensionAPI } from "@orphus/coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("rewind-summarize", {
		description: "Rewind to the first user entry, summarizing the branch left behind",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getBranch();
			const target = entries.find((e: any) => e.type === "message" && e.message?.role === "user");
			if (!target) throw new Error("rewind-summarize: no user entry to rewind to");
			const result = await ctx.navigateTree((target as any).id, { summarize: true });
			ctx.ui?.notify?.(`rewind-summarize: cancelled=${result.cancelled}`, "info");
		},
	});
}
