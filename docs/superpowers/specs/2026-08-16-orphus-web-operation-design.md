# Orphus web perception & actuation — design

**Date:** 2026-08-16
**Status:** proposed
**Companion:** [web-automation-methodology.md](../web-automation-methodology.md) — the "why" (the CLI-not-MCP thesis, the meatbag ladder, the empirical findings this borrows from).

## Problem

An Orphus agent can *read* the web but cannot *operate* it. `@orphus/web-access`
fetches URLs, extracts PDFs and video, searches through Exa/Perplexity/Gemini, and
renders a **human**-facing curation page (`curator-server.ts` serves a local page the
*person* clicks). None of that drives a live page: there is no navigate, no click, no
type, no wait-for-element, and therefore no login. An agent that hits a page behind a
form — a dashboard, an internal tool, a site whose data is only reachable after
sign-in — has nowhere to go.

The gap is specifically **interactive** control of a real browser, plus a way to log
in without the password ever entering an agent's context window.

## What already works, and is not this

- **Fetch / extract / search.** `web_search`, `fetch_content`, `get_search_content`
  in `index.ts` cover read-only retrieval. This design adds no retrieval; an agent
  that only needs page *text* should still use `fetch_content`, which is cheaper than
  a driven browser.
- **Reading the user's existing Chrome cookies.** `chrome-cookies.ts` decrypts the
  Chrome cookie store (macOS Keychain / Linux `secret-tool`) so Gemini Web can reuse a
  Google login. That is *borrowing an existing session's cookies for one API*, gated
  behind `allowBrowserCookies` (`gemini-web-config.ts`). It is not a browser the agent
  drives, and it is not a credential store the agent can log in *with*.
- **Provider credentials.** `coding-agent/src/core/runtime-credentials.ts` and
  `oauth-login.ts` store *model-provider* API keys. Those are keys Orphus spends on
  your behalf, not site logins an agent performs. The storage conventions are worth
  reusing; the purpose is different.

## Approach

Implement Corey Gallon's CDP methodology as first-class Orphus code inside
`@orphus/web-access`: a **minimal native CDP client**, a **session-scoped browser
manager**, one **`browser` tool**, a **credential vault** whose secrets never reach the
model, and a **`browser-operation` skill** carrying the operating discipline.

The methodology already matches this codebase — the roundtable README argues CLI-over-MCP
on the same economics Corey measured, and "climb only as high as the page forces you" is
the meatbag ladder restating this repo's minimal-change rule. See the companion doc.

Rejected alternatives:

- **Wrap Corey's `chrome-agent` CLI as a subprocess.** Fastest to working and maximally
  on-thesis (it *is* a CLI, not an MCP). Rejected because it is a `uv`/Python tool: it
  bypasses the `.npmrc` `min-release-age` supply-chain gate that AGENTS.md treats as
  load-bearing, adds a second package manager and runtime to install, and is alpha
  (v0.5.7). The *method* is what we want, not the dependency.
- **Playwright / puppeteer-core.** Batteries-included waits, selectors, iframe piercing.
  Rejected because it is the abstraction Corey's talk and this repo's KISS ethos both
  argue against, a heavy dependency tree behind the release-age gate, and it puts a layer
  between the agent and the trusted-input path that the ladder's upper rungs need.
- **A typed CDP binding snapshot** (like `chrome-agent`'s 54 generated domain classes).
  Rejected per Corey's own finding: forward the raw `Domain.method` string to Chrome and
  track the running browser; a bundled schema only falls behind. The client validates
  nothing against a local schema.

## Components

All new code lands in `packages/web-access`, registered through the existing lazy-heavy
split: light tool shells in `index.ts`, real implementations in `index-heavy.ts`, so a
session that never opens a browser pays nothing.

### CDP client — `web-access/cdp/connection.ts`, `cdp/session.ts`

A WebSocket to Chrome's `--remote-debugging-port`: `send(method, params) → result` and
`subscribe(event) → AsyncIterable`. Uses the runtime's **built-in `WebSocket`** — Node
≥ 22.19 (a hard requirement already) ships it as a stable global, and Bun has it natively
— so this adds **no dependency**. No typed bindings, no local schema. ~200 lines.

### Browser manager — `web-access/browser-manager.ts`

Launches Chrome (`find-chrome.ts` resolves the binary from common paths or
`ORPHUS_CHROME_PATH`) with an **isolated, disposable profile** under the agent dir, or
attaches to an already-running instance by port. A per-session registry maps a handle name
to `{port, pid, profile}`.

Lifecycle is bound to the existing lease (`lifecycle-lease.ts`): the `session_shutdown`
handler in `index-heavy.ts` **kills every spawned Chrome**, giving the same zero-orphan
guarantee kernels have (rlm-security-posture Rule 4). Concurrent instances are capped in
the spirit of `EXECUTION_CAPACITY`; over the cap is a typed refusal, not a hang. Spawning
reuses `subprocess.ts`.

**Which Chrome (default).** A dedicated isolated profile, created fresh and torn down with
the session. It never touches the user's real browser session; logins come from the vault.
Attaching to the user's *existing* logged-in Chrome is opt-in behind the same
`allowBrowserCookies` consent gate `chrome-cookies.ts` already honours — the risky case is
explicitly the exception, not the default.

### The agent tool — `browser` (action-dispatched)

One tool, registered like `web_search`, behind **`ORPHUS_ENABLE_BROWSER` (default off)**
— the env-flag gate `docs/repl.md` established for `ORPHUS_ENABLE_REPL`. A single tool
with an `action` discriminator (not eight tools) because the actions share one browser
handle and the set is small; the `typebox` schema documents each action's arguments.

Actions map to the digital senses and the sense→act→verify loop:

| action | senses / acts | CDP surface |
| --- | --- | --- |
| `open` / `navigate` | act | `Page.navigate`, wait on `Page.loadEventFired` |
| `read` (`as: dom \| accessibility \| text \| screenshot`) | **sense** | `DOM.*`, `Accessibility.*`, `Runtime.evaluate`, `Page.captureScreenshot` |
| `click` | act (trusted) | `Input.dispatchMouseEvent` press+release |
| `type` / `press` | act (trusted) | `Input.insertText`, `Input.dispatchKeyEvent` |
| `wait_for` | sense | poll `Runtime.evaluate` / subscribe to an event |
| `login` | act (see vault) | vault → `Input.insertText` |
| `close` | lifecycle | `Target.closeTarget` / stop instance |

**The meatbag ladder is coded, not just documented.** `click`/`type` try the cheap path
first (a synthetic `Runtime.evaluate` dispatch) and **escalate to trusted `Input.*` only on
a detected silent no-op** — the escalation rule from the skill, made mechanical so an agent
gets it without reasoning about event trust. Verification is structural: after an act, the
tool re-senses through a *different* channel (a `read`, a URL change, a network event) and
returns that, never the act's own "success".

### Credential vault — `web-access/credential-vault.ts`

Site logins, keyed by `{domain, label}`, in the **OS keychain** — the exact backends
`chrome-cookies.ts` already speaks (macOS `security`, Linux `secret-tool`) — with an
encrypted-file fallback where no keychain exists. Storage conventions follow
`runtime-credentials.ts`.

Three properties are **enforced** (runtime, not prompt — rlm-security-posture's central
distinction):

1. **The secret value never enters model context.** `browser({action:"login", domain,
   label})` has the vault read the secret and stream it straight into the focused field via
   `Input.insertText`. The tool result reports *that a field was filled*, never the value;
   the model only ever names a `label`. This is the enforced form of the credential-request
   pattern — not an instruction the model could optimize around (the Factorio failure mode
   this repo names explicitly).
2. **Storing a credential is a human act.** A `/credential` command *a person types*
   (`add` / `list` / `remove`), or an import from an existing keychain entry. The agent
   cannot write to the vault, so no page's content can talk it into saving an attacker's
   value — the same shape as `/refine apply` being a typed human step rather than a config
   default.
3. **Using a credential is gated.** The domain must be on an **allowlist**; the **first
   login per domain requires a structural human confirm**; the whole path is behind
   **`ORPHUS_ENABLE_BROWSER_LOGIN` (default off)**; every access is **audit-logged** to the
   agent dir.

Everything else the skill teaches (etiquette, ladder discipline) is **instructed** and
labelled as such, so the boundary between wall and suggestion is never blurred.

### The skill — `web-access/skills/browser-operation/`

Written by the writing-for-agents method (`packages/coding-agent/docs/skills.md`):
context-pointer description, front-loaded trigger, deletion over explanation. It teaches the
digital senses, sense→act→verify (*verify through a different channel than you acted on*),
the ladder (climb only as forced), and the login flow — reference a `label`, **never ask the
user to paste a password into chat**, respect the gates. It states which properties are
*enforced* so the agent knows the walls are real and does not waste turns trying to route
around them.

## Security posture

Mapped to `docs/rlm-security-posture.md`, keeping its enforced/instructed line sharp.

- **Enforced:** secret value path is vault→CDP only, never model context; `browser` and
  `login` behind default-off env flags; Chrome killed with the session (zero-orphan);
  domain allowlist checked in code; instance count capped with typed refusal; irreversible
  actions (submit / purchase / send) require a human confirm; **no CAPTCHA-solving or
  anti-bot surface is shipped**.
- **Instructed:** ladder discipline, etiquette, when to escalate a rung.
- **Said plainly (not protected):** a driven browser holding real login cookies acts as
  the user; anti-detection is deliberately minimal — following Corey's audited finding we
  **do not** patch `navigator.webdriver` / `window.chrome`, because patching makes a browser
  *more* detectable, not less; we respect site ToS and robots and build no evasion; the
  trust boundary stays local-machine, same-user.

## Error handling

- **Chrome not found** — typed error naming `ORPHUS_CHROME_PATH`, not a stack trace.
- **CDP disconnect mid-action** — surface it; do not silently retry an act that may have
  landed. A navigation destroys the JS context (`Runtime.evaluate` throws "context
  destroyed"); the tool retries the *sense*, never the act.
- **Locator returns nothing** — return the failure plus a screenshot handle, so the agent
  re-senses rather than guessing selectors.
- **Vault miss / locked keychain** — typed error naming the `{domain, label}`; never fall
  back to prompting the model for the value.
- **Over the instance cap** — typed refusal (`capacityExhausted`-style), matching the
  admission-door vocabulary.

## Testing

Vitest + `node:assert/strict`, in `test/unit/web-access-browser-*.test.ts` and
`web-access-vault-*.test.ts`:

- **CDP client** against a headless Chrome fixture: `send` returns a result, `subscribe`
  yields an event, a bad frame surfaces as an error.
- **Vault enforced property (the load-bearing test):** a login fills the field and the
  secret value appears in **no** tool result, log line, or error — a regression test on the
  one property that must never weaken.
- **Zero-orphan:** `session_shutdown` kills a spawned Chrome; assert no live PID remains.
- **Ladder escalation:** a synthetic click that no-ops triggers exactly one trusted-input
  retry.
- **Gates:** `login` refuses when the flag is off, when the domain is off-allowlist, and on
  an un-confirmed first use — each a distinct typed refusal.

The no-model demos stay the proof of the roundtable contract; this adds no model calls to
CI.

## Out of scope

- **CAPTCHA solving and fingerprint spoofing.** Corey's headline demos. Deliberately not
  built: dual-use, ToS-hostile, and not needed for the legitimate-login goal. The clean
  default (no `navigator.webdriver` patch) is the whole anti-detection story.
- **A published `orphus-browser` CLI.** The tool is the surface; revisit only if an external
  harness needs it, as with the roundtable MCP bridge.
- **Attaching to the user's real Chrome by default.** Opt-in behind the existing cookie
  consent gate; the default is an isolated profile.
- **Remote / multi-user browsers.** The trust boundary is same-user, same-machine.
- **Retrieval features.** `fetch_content` already covers page text; this is for interaction.

## Definition of done

Per AGENTS.md: `packages/web-access/README.md` documents the tool, the vault commands, and
the two env flags; `docs/README.md` indexes the new capability and the companion
methodology doc; the root README's "what's in the box" notes interactive browsing;
`packages/coding-agent/CHANGELOG.md` gets an `Added` entry under `[Unreleased]` (web-access
has no changelog of its own; user-visible entries live in the shipping package). GitNexus
re-indexed at the milestone boundary.
