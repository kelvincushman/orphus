---
name: browser-operation
description: Operate a live web page with the browser tool — sense→act→verify, climb the meatbag ladder only as far as the page forces, log in via the vault (never paste a password).
---

# Operating a live page

You have a `browser` tool (`ORPHUS_ENABLE_BROWSER=1`) that drives a real Chrome. Actions:
`open`, `read`, `click`, `type`, `wait_for`, `close`, `login`. `read` takes `as`: `"text"`,
`"dom"`, `"accessibility"`, or `"screenshot"`.

## The loop: sense, act, verify

1. `open` the URL, then `read` (`as:"text"` for content, `as:"screenshot"` for layout).
2. Act once (`click`/`type`), then **read again through a different channel** than the one
   you acted on — the next read is the verification, never the act's own return value.
3. If nothing changed, the page is fighting back — climb one rung, don't debug selectors.

## The meatbag ladder (climb only as forced)

- **Rung 1 — synthetic.** The default `click`. A normal DOM click. Free.
- **Rung 2 — trusted.** The tool escalates automatically when a synthetic click silently
  no-ops (the page gates on `event.isTrusted`). You do not request this; it happens for you.
- **Rung 3 — human input.** Not shipped. This tool does no CAPTCHA or anti-bot work by design.
  If a page needs it, stop and say so — don't improvise a workaround.

## Logging in

- Never ask the user to paste a password into chat, and never put one in a tool call or
  command. You are not able to see it regardless — see below.
- The human stores logins once, from their own prompt: `/credential add <domain> <label>
  <username>`. The agent has no path to this command; you cannot write to the vault.
- First login to a domain also needs the human's `/credential confirm <domain>`.
- You call `browser action:"login" domain:… label:… usernameSelector:… passwordSelector:…`.
  The password is streamed straight into the field; the result you get back carries only
  `domain` and `username`, never the secret.
- Login is off unless `ORPHUS_ENABLE_BROWSER_LOGIN=1`, and only an allowlisted, confirmed
  domain will proceed — everything else errors before touching the page.

## Enforced walls (do not try to route around them)

The secret never reaching you, the two env-flag gates, the domain allowlist, and the browser
dying with the session are enforced in code, not by convention. Work within them: an error
from one of these means the request is refused, not that you found an edge case to route
around.
