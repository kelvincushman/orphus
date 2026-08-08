/**
 * Roundtable demo: three scripted "agents" hold a design discussion in a room
 * over the real broker socket, then each pulls a bounded digest.
 *
 * Run from repo root:
 *   ORPHUS_CODING_AGENT_DIR=/tmp/roundtable-demo bun packages/roundtable/demo/run-demo.ts
 *
 * No model is involved — this proves the transport and the context-window
 * bound. Point real Atomic sessions at the same broker for the live version.
 */
import { RoundtableBroker } from "../broker/broker.ts";
import { RoundtableClient } from "../broker/client.ts";
import { buildDigest } from "../digest.ts";
import { getBrokerSocketPath } from "../broker/paths.ts";

const ROOM = "design";
const TOPIC = "Rate limiter design for the public API";

/**
 * The phase-1 exit criterion from PLAN.md: a late joiner catches up for under
 * 40% of the raw transcript. The demo currently measures 33%, so this is a
 * regression ceiling rather than a target to tune against — if a change to the
 * digest pushes the number up, that is the news, and CI should say so.
 */
const LATE_JOINER_BUDGET_RATIO = 0.4;

const SCRIPT: Array<{ agent: "planner" | "researcher" | "critic"; text: string }> = [
  { agent: "planner", text: "Kicking off: we need a rate limiter for the public API. Constraints: 10k req/s aggregate, per-key fairness, p99 added latency < 1ms. Proposals welcome." },
  { agent: "researcher", text: "Survey of options:\n1. Token bucket — O(1) memory per key, burst-friendly, easy to reason about. Redis or in-process.\n2. Sliding window log — exact but O(n) memory per key at high rates; rules it out at 10k req/s.\n3. Sliding window counter — approximation of the log with two buckets; good accuracy, O(1).\n4. GCRA (leaky bucket as meter) — single timestamp per key, elegant, precise, slightly harder to explain to ops.\nAt our rate, token bucket or GCRA are the serious candidates. Redis round-trip will eat the 1ms budget unless we use local buckets with async sync." },
  { agent: "critic", text: "Pushback on Redis-per-request: a network hop per decision blows the p99 budget on its own. If we go distributed state we need local decisions with eventual reconciliation, which reintroduces burst overshoot. Quantify the overshoot before choosing." },
  { agent: "planner", text: "Agreed. Working assumption: local token buckets per node, async usage broadcast every 100ms, global cap enforced by adjusting local refill rates. Researcher, can you bound the worst-case overshoot?" },
  { agent: "researcher", text: "Overshoot bound: with N nodes, sync interval T, per-key limit L req/s — worst case transient overshoot is L * (N-1)/N * T extra tokens before rates adjust. For N=8, T=100ms, L=100/s that's ~8.75 extra requests per key per adjustment window. Acceptable for API keys; not acceptable for auth-sensitive endpoints, which should use the strict path." },
  { agent: "critic", text: "That bound assumes uniform traffic spread. Adversarial clients hitting one node concentrate the overshoot. Recommend a per-node hard ceiling of 2x fair share as a backstop. Also: what happens on Redis partition? Fail-open or fail-closed must be explicit per endpoint class." },
  { agent: "planner", text: "Adopted: 2x fair-share node ceiling, fail-open for public reads, fail-closed for writes and auth. Decision: GCRA locally (single float per key beats bucket bookkeeping), async rate reconciliation at 100ms, strict Redis path only for auth endpoints. Researcher, write up the spec; critic, draft the failure-mode test plan." },
  { agent: "researcher", text: "Spec started at specs/rate-limiter.md — GCRA math, reconciliation protocol, and the overshoot proof included." },
  { agent: "critic", text: "Test plan: partition drills, thundering-herd on rate reset, adversarial single-node concentration, clock skew between nodes. Will fail the build if p99 added latency exceeds 1ms at 10k req/s in the harness." },
];

async function main(): Promise<void> {
  const socketPath = getBrokerSocketPath();
  const broker = new RoundtableBroker();
  await new Promise<void>((resolve) => broker.start(resolve));
  console.log(`Broker listening at ${socketPath}\n`);

  const agents = {
    planner: new RoundtableClient("planner"),
    researcher: new RoundtableClient("researcher"),
    critic: new RoundtableClient("critic"),
  } as const;

  const activitySeen: Record<string, number> = { planner: 0, researcher: 0, critic: 0 };
  for (const [name, client] of Object.entries(agents)) {
    await client.connect();
    client.onActivity(() => {
      activitySeen[name] = (activitySeen[name] ?? 0) + 1;
    });
    await client.join(ROOM, TOPIC);
  }
  console.log(`planner, researcher, critic joined #${ROOM} — ${TOPIC}\n`);

  for (const step of SCRIPT) {
    const posted = await agents[step.agent].post(ROOM, step.text);
    console.log(`  ${step.agent}#${posted.seq} posted (${step.text.length} chars)`);
  }

  const transcriptChars = SCRIPT.reduce((sum, step) => sum + step.text.length, 0);
  console.log(`\nFull room transcript: ${SCRIPT.length} messages, ${transcriptChars} chars`);
  console.log("=".repeat(72));

  // Each agent catches up with a bounded digest instead of the full transcript.
  for (const [name, client] of Object.entries(agents)) {
    const { messages, cursor } = await client.fetch(ROOM, 0);
    const unread = messages.filter((m) => m.seq > cursor);
    const digest = buildDigest(unread, { budget: 1200 });
    if (digest.consumedSeq > 0) await client.setCursor(ROOM, digest.consumedSeq);

    console.log(`\n${name} catches up — unread: ${digest.total}, digest: ${digest.chars} chars (budget 1200)`);
    console.log(`  verbatim ${digest.verbatim} · headlines ${digest.headlines} · collapsed ${digest.collapsed}`);
    const saved = unread.reduce((sum, m) => sum + m.text.length, 0);
    if (saved > 0) {
      console.log(`  context cost: ${digest.chars}/${saved} chars = ${Math.round((digest.chars / saved) * 100)}% of raw unread`);
    }
    console.log("-".repeat(72));
    console.log(digest.text.split("\n").map((line) => `  ${line}`).join("\n"));
  }

  // The money shot: a reviewer joins LATE with the entire discussion unread.
  const reviewer = new RoundtableClient("reviewer");
  await reviewer.connect();
  const joined = await reviewer.join(ROOM);
  const backlog = await reviewer.fetch(ROOM, joined.cursor);
  const reviewerDigest = buildDigest(backlog.messages, { budget: 800 });
  await reviewer.setCursor(ROOM, reviewerDigest.consumedSeq);
  console.log(`\nreviewer joins late — unread: ${reviewerDigest.total} (entire discussion, ${transcriptChars} chars)`);
  console.log(`  digest: ${reviewerDigest.chars} chars (budget 800) = ${Math.round((reviewerDigest.chars / transcriptChars) * 100)}% of the raw transcript`);
  console.log(`  verbatim ${reviewerDigest.verbatim} · headlines ${reviewerDigest.headlines} · collapsed ${reviewerDigest.collapsed}`);
  console.log("-".repeat(72));
  console.log(reviewerDigest.text.split("\n").map((line) => `  ${line}`).join("\n"));
  reviewer.disconnect();

  console.log(`\n${"=".repeat(72)}`);
  console.log("Push notifications received while 'working' (tiny activity events, not bodies):");
  for (const [name, count] of Object.entries(activitySeen)) {
    console.log(`  ${name}: ${count} activity pings`);
  }

  for (const client of Object.values(agents)) client.disconnect();
  broker.shutdown();

  // The late-joiner ratio is the project's headline claim and PLAN.md's phase-1
  // exit criterion. CI ran this demo as a smoke test — it passed on exit code
  // alone, so the number could have regressed to any value without failing
  // anything. Assert it here, where the measurement already exists.
  const ratio = reviewerDigest.chars / transcriptChars;
  if (ratio > LATE_JOINER_BUDGET_RATIO) {
    console.error(
      `\nFAIL: a late joiner paid ${(ratio * 100).toFixed(2)}% of the raw transcript ` +
        `(${reviewerDigest.chars}/${transcriptChars} chars), above the ${Math.round(LATE_JOINER_BUDGET_RATIO * 100)}% ceiling.`,
    );
    process.exit(1);
  }
  // The bound is worth nothing if the digest achieves it by dropping the
  // decisions: an empty digest scores 0%. Newest-first spending is what keeps
  // the conclusions verbatim, so require that at least one survived intact.
  if (reviewerDigest.verbatim < 1) {
    console.error("\nFAIL: the late joiner's digest kept no message verbatim; the bound was met by discarding content.");
    process.exit(1);
  }

  console.log("\nDemo complete: full discussion lived in the broker; each agent paid only its digest.");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
