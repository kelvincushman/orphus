/**
 * The full loop, end to end, with NO model and NO API key:
 *   deliberate in a room → bounded digest → librarian exports losslessly
 *   → gated memory ingest → a LATER session queries the decision back.
 *
 * Run from the repo root:
 *   npm run demo:loop
 *
 * Everything is the real code. The only stand-in is the Dossier backend itself
 * (a tiny stub with the same CLI shape), because Dossier is a separate Python
 * install — see docs/memory.md. The demo is hermetic: it builds its own broker
 * and wiki under a temp dir and never touches your real ~/.orphus.
 *
 * It asserts the properties it demonstrates, so it fails loudly if the loop breaks.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RoundtableBroker } from "../broker/broker.ts";
import { RoundtableClient } from "../broker/client.ts";
import { getBrokerPidPath, getBrokerSocketPath, getRoundtableDirPath } from "../broker/paths.ts";
import { buildDigest } from "../digest.ts";
import { runDossier } from "../memory/run.ts";
import { createRoundtableTool } from "../roundtable-tool.ts";

const DIGEST_BUDGET = 700;
const rule = (title: string) => console.log(`\n${title}\n${"─".repeat(74)}`);

function check(label: string, condition: boolean): void {
  if (!condition) throw new Error(`loop demo failed: ${label}`);
}

/** Stands in for `python -m dossier`: ingest appends to the wiki, query greps it. */
const DOSSIER_STUB = `#!/usr/bin/env node
const { appendFileSync, readFileSync, existsSync } = require("fs");
const [action, arg] = process.argv.slice(2);
const wiki = process.cwd() + "/wiki.md";
if (action === "ingest") {
  appendFileSync(wiki, readFileSync(arg, "utf8"));
  process.stdout.write("ingested " + arg);
} else if (action === "query") {
  const text = existsSync(wiki) ? readFileSync(wiki, "utf8") : "";
  const hits = text.split("\\n").filter((line) => line.toLowerCase().includes("decision"));
  process.stdout.write(hits.length ? hits.join("\\n") : "(nothing in memory)");
} else process.stdout.write("ok");
`;

const SCRIPT: ReadonlyArray<readonly [string, string]> = [
  ["planner", "We need a rate limiter for the public API. 10k req/s, per-key fairness, p99 < 1ms. Proposals?"],
  ["researcher", "Options: token bucket (O(1), burst-friendly), sliding-window log (exact but O(n) memory — ruled out at our rate), GCRA (single timestamp per key, precise)."],
  ["critic", "Pushback on Redis-per-request: a network hop per decision blows the p99 budget on its own."],
  ["planner", "Agreed. Working assumption: local buckets, async usage broadcast every 100ms."],
  ["researcher", "Overshoot bound: L*(N-1)/N*T extra tokens. For N=8, T=100ms, L=100/s that is ~8.75 extra per key per window."],
  ["critic", "That bound assumes uniform traffic. Adversarial clients concentrate on one node — need a 2x fair-share ceiling."],
  ["planner", "Decision: GCRA locally, async reconciliation at 100ms, 2x per-node ceiling, fail-closed for auth endpoints."],
];

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "orphus-loop-"));
  const memoryRoot = join(root, "memory");
  const wiki = join(memoryRoot, "wiki");
  mkdirSync(wiki, { recursive: true });
  const stub = join(root, "dossier-stub.mjs");
  writeFileSync(stub, DOSSIER_STUB);
  chmodSync(stub, 0o755);

  const socketPath = getBrokerSocketPath(process.platform, root);
  const broker = new RoundtableBroker(socketPath, getBrokerPidPath(root), getRoundtableDirPath(root));
  await new Promise<void>((resolve) => broker.start(resolve));
  const clients = new Map<string, RoundtableClient>();

  try {
    rule("1. Roles deliberate in a room — the transcript lives in the broker");
    for (const name of ["planner", "researcher", "critic", "librarian"]) {
      const client = new RoundtableClient(name, socketPath);
      await client.connect();
      await client.join("design", "Rate limiter design");
      clients.set(name, client);
    }
    for (const [who, text] of SCRIPT) await clients.get(who)?.post("design", text);
    const transcriptChars = SCRIPT.reduce((sum, [, text]) => sum + text.length, 0);
    console.log(`  ${SCRIPT.length} messages, ${transcriptChars} chars — none of it in any agent's context.`);

    rule("2. A reviewer joins LATE and catches up under a hard character budget");
    const reviewer = new RoundtableClient("reviewer", socketPath);
    await reviewer.connect();
    clients.set("reviewer", reviewer);
    const joined = await reviewer.join("design");
    const backlog = await reviewer.fetch("design", joined.cursor);
    const digest = buildDigest(backlog.messages, { budget: DIGEST_BUDGET });
    console.log(`  unread ${digest.total} · digest ${digest.chars} chars (budget ${DIGEST_BUDGET})`);
    console.log(`  verbatim ${digest.verbatim} · headlines ${digest.headlines} · collapsed ${digest.collapsed}`);
    check("the digest must collapse something for this demo to be meaningful", digest.collapsed > 0);

    // Driven through the REAL roundtable tool, not a hand-rolled fetch, so this
    // demo fails if the shipped export path breaks.
    const exportTool = (role: string) =>
      createRoundtableTool({
        ensureConnected: async () => clients.get(role)!,
        exportRoot: memoryRoot,
        currentRole: () => role,
        writerRole: "librarian",
      });
    const runExport = (role: string, path: string) =>
      exportTool(role).execute("demo", { action: "export", room: "design", path }, undefined, undefined, undefined as never);

    rule("3. Export is gated to the librarian — a peer cannot stage memory");
    const denied = await runExport("planner", "raw/design.md");
    check("a non-writer role must be denied", denied.isError === true);
    console.log(`  planner   export → DENIED   ${String(denied.content[0]?.text).slice(0, 58)}…`);

    rule("4. The librarian EXPORTS the room — lossless, bypassing the digest");
    const exported = await runExport("librarian", "raw/design.md");
    check("the librarian export must succeed", exported.isError === false);
    const sourceFile = String(exported.details.path);
    console.log(`  librarian export → ${exported.details.messages} message(s) → ${sourceFile}`);
    check("export must be lossless", exported.details.messages === SCRIPT.length);
    // The point: the export recovers what the bounded digest threw away.
    check("the collapsed opening message must survive export", readFileSync(sourceFile, "utf8").includes(SCRIPT[0]![1]));
    console.log("  the message the digest collapsed survived: yes");
    console.log("  (only a path and counts were returned — the transcript never entered context)");

    rule("5. Ingest the exported transcript into long-term memory");
    console.log("  (Dossier backend stubbed — the real one is a separate install, see docs/memory.md)");
    const config = { command: [process.execPath, stub], writerRole: "librarian", cwd: wiki };
    const ingested = await runDossier(config, ["ingest", sourceFile]);
    check("ingest must succeed", ingested.code === 0);
    console.log(`  exit ${ingested.code}`);

    rule("6. A FRESH session — no room, no transcript — queries memory");
    const answer = await runDossier(config, ["query", "what was decided?"]);
    check("the decision must come back out of memory", answer.stdout.includes("Decision: GCRA locally"));
    for (const line of answer.stdout.split("\n")) console.log(`    ${line}`);

    console.log(`\n${"─".repeat(74)}`);
    console.log("Loop closed: the deliberation stayed out of every context window, the");
    console.log("decision persisted, and a later session recovered it without the transcript.");
  } finally {
    for (const client of clients.values()) client.disconnect();
    broker.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
