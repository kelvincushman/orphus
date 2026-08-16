# Web automation as an agent capability — a working methodology

A study note behind [the web-operation design](specs/2026-08-16-orphus-web-operation-design.md).
It reframes Corey Gallon's *"The Dark Arts of Web Automation"* (AI Engineer World's Fair
2026) and his [`chrome-agent`](https://github.com/captivus/chrome-agent) tool through the
lens of how Orphus is built — the CLI-over-MCP contract, the minimal-change rule, and the
enforced/instructed security line. The talk is the source; the opinions about what it means
*here* are ours.

## The one idea

> A CDP browser is a meatbag with a mouse — as far as Google, Cloudflare, and the rest can
> tell.

Drive a real Chrome through the Chrome DevTools Protocol and your agent's clicks and
keystrokes travel the **same internal path** as a human's. Chrome stamps every event
`isTrusted`; input dispatched through CDP's `Input` domain is stamped exactly as a physical
mouse is. The page cannot tell them apart. Everything else is engineering discipline around
that fact.

This is not a novelty for Orphus — it is the same bet the roundtable makes. The README's
argument for a local broker over "pipe every agent into every prompt" and the argument for a
CLI over an MCP server are the same argument: **keep the model out of the inner loop and let
deterministic code carry the mechanics.**

## Three ingredients

### 1. A CLI, not an MCP — and the numbers

Capability is a wash: an Arize eval found a CLI and an MCP hit the same task ~83% of the
time. The difference is everything *around* capability:

| | CLI | MCP |
| --- | --- | --- |
| **Reuse** | write the sequence once, replay 1000× with no model in the loop | model on every turn |
| **Speed** | 7 calls, < 1 min (same task) | 71 round-trips, 8 min |
| **Token cost** | ~2K | ~17K (Anthropic reports CLIs can be ~75× cheaper) |

Orphus already internalizes this. The roundtable digest is "deterministic and model-free"
for the same reason: a model in a hot path is a cost and a variance you pay on every
iteration. A browser tool should hold the line — code drives; the model is asked only for
the one judgement code cannot make (see *the solver/operator split* below).

### 2. CDP as digital senses

Chrome 150 exposes 57 domains / ~668 methods / ~237 events. You need a small subset, best
remembered as **senses**:

- **See** what the page *says* — `DOM`, `Accessibility`, `CSS`, `DOMSnapshot`. Structured
  reads are high-fidelity; a **screenshot** is the last resort for *content* (pixels are
  lossy) but the right tool for *layout*.
- **Hear** what the page *reports* — `Network`, `Runtime` (console, exceptions), `Log`.
- **Operate** — `Input` (trusted events), `Page` (navigate), `Runtime` (`evaluate`).

Corey's own tool refuses to bundle a typed schema of these: it forwards the raw
`Domain.method` to Chrome and reads `help` live from the running browser, "because any
bundled subset only falls behind." That is the minimal-change rule applied to a protocol —
track the real thing, don't maintain a parallel model of it.

### 3. A loop on a ladder

The loop: **sense → act → verify**, repeat until the page gives in. Two rules make it work:

- **Verify through a *different* channel than you acted on.** After a click, don't ask the
  click if it worked — check the DOM, the URL, or a network event. An act that "succeeded"
  with no error can have done nothing; only an observed effect proves it. (`chrome-agent`'s
  own AGENTS.md sharpens this: *there is no separate verify step; the next sense is the
  verification.*)
- **Climb only as high as the page forces you** — the meatbag ladder:

  | rung | what | when |
  | --- | --- | --- |
  | **1 · Fake** | synthetic JS click / page API — free, instant | the default; most pages |
  | **2 · Real** | trusted `Input.dispatchMouseEvent` through Chrome's native pipeline | when a synthetic click *silently no-ops* |
  | **3 · Human** | real mouse paths (dwell, jitter), vision | the narrow frontier where pages hunt for bots |

The escalation trigger is precise and worth coding rather than reasoning about: **a synthetic
click that produces no error and no effect** means the page gates on event trust — jump to
rung 2, don't debug selectors. This is the same shape as the repo's own advice to escalate
from a one-line fix to a subsystem only when the one-liner is proven insufficient.

## The solver / operator split

Corey's hardest demo (reCAPTCHA v2) is the pattern worth stealing for *any* agent, CAPTCHA
or not. He splits the machine in two:

- **The solver** — pure deterministic code. Trusted clicks, iframe traversal, screenshot the
  grid each round, re-arm on expiry. Fast, free, no model.
- **The operator** — an agent skill at *low* effort whose entire job is one look: "which
  tiles are buses?" One answer, no deliberation, handed back to the solver.

Why the split matters: the challenge is on a clock, and "an agent that round-trips a model on
every click burns that clock and loses." The model is invoked once per round, for the *only*
step code cannot do — vision and judgement.

**This is the design rule for the Orphus browser tool.** Code owns navigation, waiting,
locating, trusted input, and retry/expiry. The model is spent only on the irreducible
judgement: *what does this page mean, and what is the next single act?* The tool should make
the cheap deterministic path the default and reserve the model for the look — exactly how the
digest reserves the model for nothing and the fleet orchestrator "routes rather than works."

## What Orphus should copy, and what it should not

Copy the **method** and the **empirical honesty**, not the tool.

- **Native, not wrapped.** `chrome-agent` is a `uv`/Python alpha; bolting it on would bypass
  the `.npmrc` supply-chain gate AGENTS.md treats as load-bearing. A ~200-line native CDP
  client fits the stack and *is* the study. (Rationale in the design's rejected-alternatives.)
- **Evidence over assertion — the detection audit.** Corey's most useful engineering result
  is counterintuitive and measured, not asserted: patching `navigator.webdriver` /
  `window.chrome` to look "more human" makes Chrome **more** detectable — it flips
  bot.sannysoft's WebDriver test from pass to fail and raises CreepJS's headless score
  0→33%. A plain CDP-attached Chrome is already clean. So the right anti-detection posture is
  *do nothing* — leave the JS environment untouched. Orphus adopts this directly, and it is a
  good example of the repo's own rule: verify before "fixing"; a review flagging something is
  a hypothesis, not a fact.
- **Do not copy the CAPTCHA-defeat surface.** It is the talk's showpiece and the wrong thing
  for a shared tool: dual-use, ToS-hostile, and unnecessary for the legitimate goal (logging
  into your own accounts). The design ships **zero** CAPTCHA/anti-bot capability by
  construction, and says so as an *enforced* boundary, not a promise.

## Honest caveats (read the demos carefully)

The talk's framing — "beat every CAPTCHA, no human in the loop" — is true about the
*interaction mechanics* and softer about the *scores*. The slides quietly show the hardest
targets ran against **test keys** (Cloudflare Turnstile's always-interactive test key, which
always passes — it proves the trusted click reached the checkbox, not that a production risk
score was beaten), a **vendor account** (Lemin), and **his own infrastructure** (with a
lawyer's "own-accounts-only" disclaimer, after OpenAI threatened his account). What is
robustly demonstrated is the *methodology*; "turnkey production-CAPTCHA defeat" is not, and
he is upfront about why. For Orphus this is a feature, not a loss: the legitimate capability
(see a page, operate it, log in with a credential you own) is exactly the part that
generalizes.

## The credential problem, framed by our own rules

Corey's talk barely touches credentials — his demos run on accounts he owns. For an
autonomous multi-agent harness, storing a login and letting an agent use it is the sharp
edge, and Orphus's security posture already tells us how to hold it:

- The posture's named threat is **an agent optimizing around an instruction** (the Factorio
  incident). So "don't leak the password" cannot be a skill sentence — it must be
  *enforced*. The value flows vault→CDP into the field; the model only ever names a label
  and never sees the secret. A wall, not a suggestion.
- Human approval is **structural**, "a step someone has to take," not a config default —
  `/refine apply` is the precedent, so storing a credential and confirming a first login are
  human-typed acts.
- Risky subsystems ship **behind a default-off env flag** (`ORPHUS_ENABLE_REPL`) — so does
  the browser (`ORPHUS_ENABLE_BROWSER`) and login (`ORPHUS_ENABLE_BROWSER_LOGIN`).
- **Say plainly what is not protected.** A driven browser with real cookies acts as you;
  the trust boundary stays local-machine, same-user. The design states this rather than
  implying containment it does not have.

## References

- Corey Gallon, *The Dark Arts of Web Automation*, AI Engineer World's Fair 2026 (Track 7,
  Computer Use) — [talk](https://www.youtube.com/watch?v=26RtyAm9y_Q).
- [`captivus/chrome-agent`](https://github.com/captivus/chrome-agent) — MIT. Especially its
  `AGENTS.md` (sense⇄act discipline), `planning/learnings/04-token-cost-analysis.md`, and
  `planning/03-specs/BRW-03-learnings/01-detection-audit.md` (the empirical basis above).
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/).
- Orphus: [rlm-security-posture.md](../rlm-security-posture.md), the roundtable README's
  CLI-over-MCP argument, and AGENTS.md's minimal-change rule.
