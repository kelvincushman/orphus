# Browser operation

Orphus can drive a real browser: navigate, read a page back as text, click,
type, screenshot, and — behind a second switch — fill a login form from a
credential in your OS keychain.

It is **off by default** and registers nothing until you turn it on.

```sh
ORPHUS_ENABLE_BROWSER=1 orphus
```

With the switch off the `browser` tool does not exist: not in the tool list, not
in the system prompt, not in the context window.

## It is not your browser

Every session launches its own Chrome with a throwaway `--user-data-dir` and
tears it down afterwards. Orphus never attaches to a running Chrome and never
opens your profile, so the browser it drives has none of your cookies, none of
your logged-in sessions, and nothing it does can touch them. That is the point:
an agent operating your live browser is an agent operating your bank tab.

Chrome is found at the usual per-platform paths; set `ORPHUS_BROWSER_EXECUTABLE`
if yours lives elsewhere. It runs headless unless `ORPHUS_BROWSER_HEADLESS=0`.

## The `browser` tool

One tool, dispatched by `action`, because the actions are not independent —
they operate on one browser, in sequence.

| Action | What it does |
| --- | --- |
| `open` | Start the browser. Idempotent. |
| `navigate` | Go to `url`. |
| `snapshot` | The page as text, plus its interactive elements and their selectors. |
| `status` | Current URL and title. |
| `screenshot` | A PNG of the viewport. |
| `click` | Click the element matching `selector`. |
| `type` | Enter `text` into the element matching `selector`. |
| `login` | Fill a login form from a stored credential. See below. |
| `close` | Shut the browser down and report what was released. |

### Retries, and where they stop

`snapshot`, `screenshot`, and `status` ask the page a question. Repeating one
changes nothing, so a transient failure gets a bounded retry.

`navigate`, `click`, `type`, and `login` change the page. When one of those
fails, its effect is often unknown — the click may have submitted before the
connection dropped. Orphus does **not** retry them. It says so:

> The `click` action failed and its effect on the page is unknown: … It was not
> retried, because repeating it could apply it twice. Use `snapshot` to see the
> page's current state before deciding what to do.

## Login

Credential injection needs a second switch on top of the first:

```sh
ORPHUS_ENABLE_BROWSER=1 \
ORPHUS_ENABLE_BROWSER_LOGIN=1 \
ORPHUS_BROWSER_LOGIN_ORIGINS="https://app.example.com" \
orphus
```

Four conditions, all required, before a secret reaches a page:

1. Both switches are on.
2. The page's origin is in `ORPHUS_BROWSER_LOGIN_ORIGINS`. Entries must be full
   origins (`https://app.example.com`), not bare hosts — a scheme-less entry
   authorizes nothing.
3. The credential is itself scoped to that origin. A credential registered for
   one allowlisted site cannot be used on another.
4. A human approved this credential for this origin. You are asked once per
   session per credential-and-origin pair. **A session with no one to ask —
   print mode, a subagent, a scheduled run — is denied.**

### Where credentials live

The secret lives in your OS keychain and is read only at the moment it is handed
to the browser:

- **macOS** — `security`, service `orphus-browser`, account = the label.
- **Linux** — `secret-tool` (libsecret), same service and account.
- **Windows** — unsupported; login fails closed until a native binding exists.

The non-secret part — which labels exist, which origin each is scoped to, an
optional username — lives in `<agent dir>/browser-credentials.json`:

```json
[{ "label": "example-login", "origin": "https://app.example.com", "username": "ada" }]
```

That split is deliberate: Orphus can answer "which credentials could apply to
this page" without a single keychain read, and the origin binding stays under
Orphus's control rather than parsed out of a keychain comment.

Register one on macOS:

```sh
security add-generic-password -s orphus-browser -a example-login -w
```

or on Linux:

```sh
secret-tool store --label="Orphus example-login" service orphus-browser account example-login
```

### What the model can see

Only the **label**. The secret is written into the page through the DevTools
connection and never appears in a tool result, a session record, a log line, or
the approval prompt. A refusal names the label and the reason and nothing else.

## Cleanup

On `close`, on cancellation, and on session shutdown, every registered resource
— the Chrome process, the DevTools connection, the throwaway profile directory —
has its teardown attempted and awaited, and the registry is emptied.

Orphus reports what that pass did rather than promising a result it cannot
guarantee:

```
Browser closed. 3 resource(s) released, none failed.
```

and when something did not go:

```
Browser cleanup attempted 3 resource(s); 1 failed:
  - chrome profile directory: EBUSY: directory in use
```

A kill can fail and a directory can be locked. "We tried everything and one of
them failed" is something you can act on; "no orphans" would not have been true.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ORPHUS_ENABLE_BROWSER` | Master switch. Nothing is registered without it. |
| `ORPHUS_ENABLE_BROWSER_LOGIN` | Allow credential injection. Requires the switch above. |
| `ORPHUS_BROWSER_LOGIN_ORIGINS` | Space- or comma-separated origins credentials may be used on. |
| `ORPHUS_BROWSER_EXECUTABLE` | Explicit Chrome/Chromium path. |
| `ORPHUS_BROWSER_HEADLESS` | `0` for a visible window. |
| `ORPHUS_BROWSER_NO_SANDBOX` | Pass `--no-sandbox`. Disables Chrome's own sandbox — only for a container that runs as root, where Chrome otherwise refuses to start. |
