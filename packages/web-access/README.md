<p>
  <img src="banner.png" alt="pi-web-access" width="1100">
</p>

# Pi Web Access

**Web search, content extraction, and video understanding for Pi agent. Zero-config Exa search, optional browser-cookie Gemini Web, or bring your own API keys.**

[![npm version](https://img.shields.io/npm/v/pi-web-access?style=for-the-badge)](https://www.npmjs.com/package/pi-web-access)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows*-blue?style=for-the-badge)]()

https://github.com/user-attachments/assets/cac6a17a-1eeb-4dde-9818-cdf85d8ea98f

## Why Pi Web Access

**Zero Config** — Works out of the box with Exa MCP (no API key needed). Add API keys for Exa, Perplexity, or Gemini API for more control, or opt into browser-cookie access for Gemini Web.

**Video Understanding** — Point it at a YouTube video or local screen recording and ask questions about what's on screen. Full transcripts, visual descriptions, and frame extraction at exact timestamps.

**Smart Fallbacks** — Every capability has a fallback chain. Search tries Exa, then Perplexity, then Gemini API, then Gemini Web when browser cookies are enabled. YouTube tries Gemini Web when enabled, then API, then Perplexity. Blocked pages retry through Jina Reader and Gemini extraction. Something always works.

**GitHub Cloning** — GitHub URLs are cloned locally instead of scraped. The agent gets real file contents and a local path to explore, not rendered HTML.

## Install

```bash
pi install npm:pi-web-access
```

Works immediately with no API keys — Exa MCP provides zero-config search. For more providers or direct API access, add keys to `~/.pi/web-search.json`:

```json
{
  "exaApiKey": "exa-...",
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza..."
}
```

In `auto` mode (default), `web_search` tries Exa first (direct API if keyed, MCP if not), then Perplexity, then Gemini API, then Gemini Web when browser-cookie access is enabled.

Optional dependencies for video frame extraction:

```bash
brew install ffmpeg   # frame extraction, video thumbnails, local video duration
brew install yt-dlp   # YouTube stream URLs for frame extraction
```

Without these, video content analysis (transcripts, visual descriptions via Gemini) still works. The binaries are only needed for extracting individual frames as images.

Requires Pi v0.37.3+.

## Quick Start

```typescript
// Search the web
web_search({ query: "TypeScript best practices 2025" })

// Fetch a page
fetch_content({ url: "https://docs.example.com/guide" })

// Clone a GitHub repo
fetch_content({ url: "https://github.com/owner/repo" })

// Understand a YouTube video
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "What libraries are shown?" })

// Analyze a screen recording
fetch_content({ url: "/path/to/recording.mp4", prompt: "What error appears on screen?" })
```

## Tools

The public tools register immediately and share one lazy initialization attempt on first use. Calls wait for initialization and active-session replay before provider work begins; a rejected initializer or replay can be retried by a later call. Initialization and replay are leased to the active session: shutdown retires the lease and cleans its candidate, so calls spanning shutdown reject and a restarted session creates a fresh provider wrapper. An abort that arrives during the shared wait cancels only that invocation. Host cancellation after provider or curator work rejects with the exact host abort reason, while an explicit user action in the curator remains a successful `{ cancelled: true, cancelReason: "user" }` result. Resetting the application-owned attempt does not guarantee re-evaluation of an ESM module whose evaluation itself failed.

For batch search/fetch calls, partial success remains usable and retains item-level errors. A non-empty batch where every provider request or URL fetch fails is reported through Atomic's tool-error channel with aggregate stage metadata while the per-item diagnostics remain stored in the result.

### web_search

Search the web via Exa, Perplexity AI, or Gemini. Returns a synthesized answer with source citations.

```typescript
web_search({ query: "rust async programming" })
web_search({ queries: ["query 1", "query 2"] })
web_search({ query: "latest news", numResults: 10, recencyFilter: "week" })
web_search({ query: "...", domainFilter: ["github.com"] })
web_search({ query: "...", provider: "exa" })
web_search({ query: "...", includeContent: true })
web_search({ queries: ["query 1", "query 2"], workflow: "none" })
web_search({ queries: ["query 1", "query 2"], workflow: "summary-review" })
```

| Parameter | Description |
|-----------|-------------|
| `query` / `queries` | Single query or batch of queries |
| `numResults` | Results per query (default: 5, max: 20) |
| `recencyFilter` | `day`, `week`, `month`, or `year` |
| `domainFilter` | Limit to domains (prefix with `-` to exclude) |
| `provider` | `auto` (default), `exa`, `perplexity`, or `gemini` |
| `includeContent` | Fetch full page content from sources in background |
| `workflow` | `none` (skip curator) or `summary-review` (auto-generate summary draft after search completion, default) |

### code_search

Search for code examples, documentation, and API references via Exa MCP. No API key required. Uses Exa's code-context MCP tool when available and falls back to code-focused web search when that tool is unavailable.

```typescript
code_search({ query: "React useEffect cleanup pattern" })
code_search({ query: "Express middleware error handling", maxTokens: 10000 })
```

| Parameter | Description |
|-----------|-------------|
| `query` | Programming question, API, library, or debugging topic |
| `maxTokens` | Maximum tokens of context to return (default: 5000, max: 50000) |

### fetch_content

Fetch URL(s) and extract readable content as markdown. Automatically detects and handles GitHub repos, YouTube videos, PDFs, local video files, and regular web pages.

```typescript
fetch_content({ url: "https://example.com/article" })
fetch_content({ urls: ["url1", "url2", "url3"] })
fetch_content({ url: "https://github.com/owner/repo" })
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "What libraries are shown?" })
fetch_content({ url: "/path/to/recording.mp4", prompt: "What error appears on screen?" })
fetch_content({ url: "https://youtube.com/watch?v=abc", timestamp: "23:41-25:00", frames: 4 })
```

| Parameter | Description |
|-----------|-------------|
| `url` / `urls` | Single URL/path or multiple URLs |
| `prompt` | Question to ask about a YouTube video or local video file |
| `timestamp` | Extract frame(s) — single (`"23:41"`), range (`"23:41-25:00"`), or seconds (`"85"`) |
| `frames` | Number of frames to extract (max 12) |
| `forceClone` | Clone GitHub repos that exceed the 350MB size threshold |

### get_search_content

Retrieve stored content from previous searches or fetches. Content over 30,000 chars is truncated in tool responses but stored in full for retrieval here.

```typescript
get_search_content({ responseId: "abc123", urlIndex: 0 })
get_search_content({ responseId: "abc123", url: "https://..." })
get_search_content({ responseId: "abc123", query: "original query" })
```

## Capabilities

### GitHub repos

GitHub URLs are cloned locally instead of scraped. The agent gets real file contents and a local path to explore with `read` and `bash`. Root URLs return the repo tree + README, `/tree/` paths return directory listings, `/blob/` paths return file contents.

Repos over 350MB get a lightweight API-based view instead of a full clone (override with `forceClone: true`). Commit SHA URLs are handled via the API. Clones are cached for the session and wiped on session change. Private repos require the `gh` CLI.

### YouTube videos

YouTube URLs are processed via Gemini for full video understanding — visual descriptions, transcripts with timestamps, and chapter markers. Pass a `prompt` to ask specific questions about the video. Results include the video thumbnail so the agent gets visual context alongside the transcript.

Fallback: Gemini Web when browser cookies are enabled → Gemini API → Perplexity (text summary only). Handles all URL formats: `/watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/`, `/v/`.

### Local video files

Pass a file path (`/`, `./`, `../`, or `file://` prefix) to analyze video content via Gemini. Supports MP4, MOV, WebM, AVI, and other common formats up to 50MB. Pass a `prompt` to ask about specific content. If ffmpeg is installed, a thumbnail frame is included alongside the analysis.

Fallback: Gemini API (Files API upload) → Gemini Web when browser cookies are enabled.

### Video frame extraction

Use `timestamp` and/or `frames` on any YouTube URL or local video file to extract visual frames as images.

```typescript
fetch_content({ url: "...", timestamp: "23:41" })                       // single frame
fetch_content({ url: "...", timestamp: "23:41-25:00" })                 // range, 6 frames
fetch_content({ url: "...", timestamp: "23:41-25:00", frames: 3 })      // range, custom count
fetch_content({ url: "...", timestamp: "23:41", frames: 5 })            // 5 frames at 5s intervals
fetch_content({ url: "...", frames: 6 })                                // sample whole video
```

Requires `ffmpeg` (and `yt-dlp` for YouTube). Timestamps accept `H:MM:SS`, `MM:SS`, or bare seconds.

### PDFs

PDF URLs are extracted as text and saved to `~/Downloads/` as markdown. The agent can then `read` specific sections without loading the full document into context. Text-based extraction only — no OCR.

### Blocked pages

When Readability fails or returns only a cookie notice, the extension retries via Jina Reader (handles JS rendering server-side, no API key needed), then Gemini URL Context API, then Gemini Web extraction when browser cookies are enabled. Handles SPAs, JS-heavy pages, and anti-bot protections transparently. Also parses Next.js RSC flight data when present.

## How It Works

```
web_search(query)
  → Exa (direct API with key, MCP without) → Perplexity → Gemini API → Gemini Web (if browser cookies enabled)

fetch_content(url)
  → Video file?  Gemini API (Files API) → Gemini Web (if browser cookies enabled)
  → GitHub URL?  Clone repo, return file contents + local path
  → YouTube URL? Gemini Web (if browser cookies enabled) → Gemini API → Perplexity
  → HTTP fetch → PDF? Extract text, save to ~/Downloads/
               → HTML? Readability → RSC parser → Jina Reader → Gemini fallback
               → Text/JSON/Markdown? Return directly
```

## Commands

### /websearch

Open the search curator directly. Runs searches and lets you review, add, select results, and approve a summary before it is sent back to the agent — no LLM round-trip needed.

```
/websearch                                               # empty page, type your own searches
/websearch react hooks, next.js caching                  # pre-fill with comma-separated queries
```

Results get injected into the conversation when you approve the summary or click "Send selected results without summary". On timeout, the curator auto-submits and falls back to a deterministic summary if no approved draft is present.

### /curator

Toggle or configure the curator workflow at runtime.

```
/curator                    # toggle on/off
/curator on                 # enable curator (summary-review)
/curator off                # disable curator (raw results only)
/curator summary-review     # explicit workflow
```

Persists to `~/.pi/web-search.json` and takes effect on the next `web_search` call. When disabled, `web_search` returns raw results without opening the curator window.

### /search

Browse stored search results interactively. Lists all results from the current session with their response IDs for easy retrieval.

### /google-account

Show the active Google account currently authenticated for Gemini Web. Useful when multiple Chromium profiles exist or `chromeProfile` is set in config.

## Interactive browsing and the credential vault

Everything above is **read-only** retrieval. The `browser` tool drives a real, live Chrome —
navigate, read, click, type, wait, and (gated) log in — for pages `fetch_content` can't reach
because they sit behind a form. It is off by default and stays off until you opt in.

```sh
ORPHUS_ENABLE_BROWSER=1        # required for any browser action; default off
ORPHUS_ENABLE_BROWSER_LOGIN=1  # required (in addition) for the login action; default off
ORPHUS_CHROME_PATH=...         # override the Chrome/Chromium binary Orphus launches
ORPHUS_VAULT_SECRET=...        # exported just before /credential add, unset right after
```

The tool is always registered — it is not hidden from the model — but every action refuses
with a typed error unless `ORPHUS_ENABLE_BROWSER=1` is set.

### The `browser` tool

One action-dispatched tool. Each call operates a session-scoped, disposable Chrome instance
(headless, isolated profile, resolved via `ORPHUS_CHROME_PATH` or a short list of common
install paths) launched through the Chrome DevTools Protocol — not your everyday logged-in
browser. Up to 4 instances run concurrently (a typed `CapacityExhausted` refusal past that),
and every instance launched by a session is killed when that session shuts down; nothing is
left running.

| action | what it does |
|---|---|
| `open` | Navigate to `url` in a named handle (default `"default"`), creating the Chrome instance if needed |
| `read` | Sense the page as `text` (default), `dom`, `accessibility`, or `screenshot` (base64 PNG) |
| `click` | Click `selector` — see the meatbag ladder below |
| `type` | Insert `text` at the current focus |
| `wait_for` | Poll for `selector` to appear (or `document.readyState === "complete"` with no selector), up to 10s |
| `close` | Stop the named Chrome instance |
| `login` | Fill a login form from a vault credential — see below; needs `ORPHUS_ENABLE_BROWSER_LOGIN=1` |

```typescript
browser({ action: "open", url: "https://example.com/login" })
browser({ action: "read", as: "text" })
browser({ action: "click", selector: "#accept-cookies" })
browser({ action: "type", text: "hello world" })
browser({ action: "wait_for", selector: "#results" })
browser({ action: "close" })
```

Sense → act → verify: after every act, `read` (or `wait_for`) through a different channel than
the one you acted on — the tool doesn't tell you whether a click "worked," only whether the
page changed.

**The meatbag ladder is coded, not just advised.** `click` tries a cheap synthetic click
(`element.click()` via `Runtime.evaluate`) first. If a caller-supplied check reports no
observable change, it automatically escalates to a trusted `Input.dispatchMouseEvent`
press+release at the element's computed center — the same event path a physical mouse
produces, which some pages require before they'll respond. The tool result names which rung
landed: `synthetic`, `trusted`, or `failed`. There is no third rung: no CAPTCHA-solving, no
human-like mouse jitter, no vision-based tile solving. A page that needs that stops here.

### Credential vault

Site logins are keyed by `{domain, label}`. The secret lives **only** in the OS keychain —
macOS `security` (`add-generic-password` / `find-generic-password` / `delete-generic-password`)
or Linux `secret-tool` (`store` / `lookup` / `clear`) — under the service name
`orphus-web-vault`. A non-secret index (domain, label, username), a domain allowlist, and an
append-only audit log of every set/remove/inject live as plain JSON/text files under your
Orphus config directory (`~/.orphus/` by default) — never the secret itself.

The agent has no way to write to the vault. Storing, listing, and removing credentials is a
`/credential` command a **person** types at the prompt:

```
/credential add <domain> <label> <username>   # adds domain to the allowlist too
/credential list                               # domain / label / username — never the secret
/credential remove <domain> <label>
/credential confirm <domain>                   # required once per session before login
```

There's no masked-input field in the TUI, so `add` never takes the secret as a command
argument (a 4th token is rejected as a parse error, not silently accepted). Instead, set it in
the shell just before running the command, then unset it:

```sh
export ORPHUS_VAULT_SECRET='the password'
# in Orphus:  /credential add example.com work alice@example.com
unset ORPHUS_VAULT_SECRET
```

The value is never echoed, logged, or written to any file outside the OS keychain.

### Logging in

`browser({ action: "login", domain, label, usernameSelector, passwordSelector })` fills a
login form without the password ever reaching the model. Three gates are enforced, in order,
each its own typed refusal:

1. `ORPHUS_ENABLE_BROWSER_LOGIN=1` is set (default off, independent of `ORPHUS_ENABLE_BROWSER`).
2. `domain` is on the vault's allowlist (added automatically by `/credential add`).
3. `domain` has been confirmed this session via `/credential confirm <domain>` — confirmation
   is in-memory only, so it does not carry over to the next session.

The username is non-secret and gets typed into `usernameSelector` directly. The password is
read from the keychain and streamed straight into `passwordSelector` via `Input.insertText`
inside the vault's own callback — it is never assigned anywhere the tool code could return,
log, or otherwise leak it. The tool's result reports only `domain` and `username`; the model
never sees the secret.

### Security — what is NOT protected

Say this plainly rather than implying more containment than exists:

- **A driven browser holding real login cookies acts as you.** Anything reachable from a
  logged-in session — this tool's session included — is reachable by whatever calls the
  `browser` tool while that session is authenticated. The vault protects the *password*; it
  does not sandbox what a logged-in page can do.
- **No CAPTCHA or anti-bot capability is shipped.** The ladder stops at a trusted synthetic
  click; there is no vision-based challenge solving and no human-input simulation. A page that
  gates on either of those is not defeated by this tool — the skill instructs stopping and
  reporting rather than improvising a workaround.
- **Anti-detection is deliberately minimal.** There is no patch to `navigator.webdriver` or
  `window.chrome`. This is intentional, not an oversight: patching those to look "more human"
  is the empirically *worse* choice — it flips headless-detection tests from pass to fail
  rather than the other way around. A plain, unpatched CDP-attached Chrome is left alone.
- **The secret never enters model context, a log line, or a persisted file** — only the OS
  keychain holds it. On macOS, though, the write path itself passes the secret as a `security
  ... -w <secret>` command-line argument. That is a real, documented caveat: for the brief
  window the command runs, the argument is visible to anything on the same machine that can
  inspect process argv (e.g. another process running as you, or `ps` on a shared multi-user
  box). This is a property of macOS's `security` CLI, not something hidden.
- **The trust boundary is local-machine, same-user.** This is not a remote or multi-tenant
  credential store, and nothing about it changes that.
- **The Linux `secret-tool` backend is implemented but not exercised on the machine this was
  built on.** The secret is piped over stdin rather than argv (avoiding the macOS caveat
  above), but it has not been run for real against a Linux keyring daemon — treat it as
  implemented, not yet verified.

## Activity Monitor

Toggle with **CTRL+SHIFT+W** to see live request/response activity:

```
─── Web Search Activity ────────────────────────────────────
  API  "typescript best practices"     200    2.1s ✓
  GET  docs.example.com/article        200    0.8s ✓
  GET  blog.example.com/post           404    0.3s ✗
────────────────────────────────────────────────────────────
```

## Configuration

All config lives in `~/.pi/web-search.json`. Every field is optional.

```json
{
  "exaApiKey": "exa-...",
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza...",
  "provider": "exa",
  "chromeProfile": "Profile 2",
  "allowBrowserCookies": false,
  "searchModel": "gemini-2.5-flash",
  "summaryModel": "anthropic/claude-haiku-4-5",
  "workflow": "summary-review",
  "curatorTimeoutSeconds": 20,
  "githubClone": {
    "enabled": true,
    "maxRepoSizeMB": 350,
    "cloneTimeoutSeconds": 30,
    "clonePath": "/tmp/atomic-github-repos"
  },
  "youtube": {
    "enabled": true,
    "preferredModel": "gemini-3-flash-preview"
  },
  "video": {
    "enabled": true,
    "preferredModel": "gemini-3-flash-preview",
    "maxSizeMB": 50
  },
  "shortcuts": {
    "curate": "ctrl+shift+s",
    "activity": "ctrl+shift+w"
  }
}
```

`EXA_API_KEY`, `GEMINI_API_KEY`, and `PERPLEXITY_API_KEY` env vars take precedence over config file values. `provider` sets the default search provider: `"exa"`, `"perplexity"`, or `"gemini"`. This is also updated automatically when you change the provider in the curator UI. `workflow` sets the default curator mode: `"summary-review"` (default, opens curator with auto-generated summary draft) or `"none"` (raw results, no curator). Overridden per-call via the `workflow` parameter on `web_search`, or toggled at runtime with `/curator`. `chromeProfile` overrides the Chromium profile directory used for Gemini Web cookie lookup. `allowBrowserCookies` enables Chromium cookie extraction for Gemini Web; it defaults to `false` to avoid surprise macOS Keychain prompts. You can also set `PI_ALLOW_BROWSER_COOKIES=1`. `searchModel` overrides the Gemini API model used by `web_search` without changing URL, YouTube, or video extraction defaults. `summaryModel` sets the default model used for generating summary drafts in the curator UI (e.g. `"anthropic/claude-haiku-4-5"` or `"openai-codex/gpt-5.3-codex-spark"`). Only models available in your model registry are eligible; if the configured model is unavailable, the default falls back to the built-in preference list. `curatorTimeoutSeconds` controls the initial curator idle timeout (default `20`, max `600`); users can still adjust the timer in the curator UI.

### Shortcuts

Both shortcuts are configurable via `~/.pi/web-search.json`:

```json
{
  "shortcuts": {
    "curate": "ctrl+shift+s",
    "activity": "ctrl+shift+w"
  }
}
```

Values use the same format as pi keybindings (e.g. `ctrl+s`, `ctrl+shift+s`, `alt+r`). Changes take effect on next pi restart.

Set `"enabled": false` under any feature to disable it. Config changes require a Pi restart.

Rate limits: Perplexity is capped at 10 requests/minute (client-side). Content fetches run 3 concurrent with a 30s timeout per URL.

## Limitations

- Chromium cookie extraction for Gemini Web is opt-in via `allowBrowserCookies: true` or `PI_ALLOW_BROWSER_COOKIES=1`. On macOS, enabling it may trigger a Keychain dialog; Linux uses `secret-tool` when available and falls back to Chromium's default password otherwise.
- YouTube private/age-restricted videos may fail on all extraction paths.
- Gemini can process videos up to ~1 hour; longer videos may be truncated.
- PDFs are text-extracted only (no OCR for scanned documents).
- GitHub branch names with slashes may misresolve file paths; the clone still works and the agent can navigate manually.
- Non-code GitHub URLs (issues, PRs, wiki) fall through to normal web extraction.

<details>
<summary>Files</summary>

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry, tool definitions, commands, widget |
| `curator-page.ts` | HTML/CSS/JS generation for the curator UI with markdown rendering |
| `curator-server.ts` | Ephemeral HTTP server with SSE streaming and state machine |
| `summary-review.ts` | Summary prompt construction, model-based draft generation, and deterministic fallback summary |
| `exa.ts` | Exa.ai search provider — direct API and MCP proxy, budget tracking |
| `code-search.ts` | Code/docs search via Exa MCP |
| `extract.ts` | URL/file path routing, HTTP extraction, fallback orchestration |
| `gemini-search.ts` | Search routing across Exa, Perplexity, Gemini API, Gemini Web |
| `gemini-url-context.ts` | Gemini URL Context + Web extraction fallbacks |
| `gemini-web.ts` | Gemini Web client (cookie auth, StreamGenerate) |
| `gemini-web-config.ts` | Gemini Web profile and browser-cookie opt-in config |
| `gemini-api.ts` | Gemini REST API client (generateContent) |
| `chrome-cookies.ts` | macOS/Linux Chromium-based cookie extraction (Keychain/secret-tool + SQLite) |
| `cdp/connection.ts` | Minimal native CDP client — `send`/`subscribe` over a raw WebSocket, no typed schema |
| `browser-manager.ts` | Launches/tracks isolated Chrome instances, caps concurrency, kills all on session shutdown |
| `find-chrome.ts` | Resolves the Chrome/Chromium binary (`ORPHUS_CHROME_PATH` or common install paths) |
| `browser-actions.ts` | Sense/act primitives: read (text/dom/accessibility/screenshot), the click escalation ladder, type |
| `browser-tool.ts` | The `browser` tool: action dispatch, `ORPHUS_ENABLE_BROWSER` gate, session-shutdown cleanup |
| `browser-login.ts` | The `login` action's no-leak fill: vault → CDP, gated by flag + allowlist + confirmation |
| `credential-vault.ts` | In-memory vault: allowlist checks, non-secret index, audit hook, secret only via `injectInto` |
| `credential-command.ts` | The human-only `/credential add|list|remove|confirm` command |
| `vault/keychain.ts` | OS secret backends — macOS `security`, Linux `secret-tool` |
| `vault/vault-store.ts` | Wires the vault to a real backend and persists the non-secret index/allowlist/audit log to disk |
| `skills/browser-operation/` | Bundled skill teaching the sense→act→verify loop and the ladder |
| `youtube-extract.ts` | YouTube detection, three-tier extraction, frame extraction |
| `video-extract.ts` | Local video detection, Files API upload, Gemini analysis |
| `github-extract.ts` | GitHub URL parsing, clone cache, content generation |
| `github-api.ts` | GitHub API fallback for large repos and commit SHAs |
| `perplexity.ts` | Perplexity API client with rate limiting |
| `pdf-extract.ts` | PDF text extraction, saves to markdown |
| `rsc-extract.ts` | RSC flight data parser for Next.js pages |
| `utils.ts` | Shared formatting and error helpers |
| `storage.ts` | Session-aware result storage |
| `activity.ts` | Activity tracking for the observability widget |
| `skills/librarian/` | Bundled skill for library research |

</details>
