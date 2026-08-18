# Terminal backend (termDOM pilot)

Orphus's terminal UI is pi's. One pilot runs a second renderer —
[termDOM](https://github.com/bikeshaving/termdom), which lays out real HTML and
CSS in a terminal — on **startup selection and the session picker only**.

It is opt-in for this release. The default is `pi`, and pi remains the immediate
fallback.

## Choosing a backend

Precedence, highest first:

1. `ORPHUS_TUI_BACKEND=pi|termdom`
2. the `tui.backend` setting
3. the release default, `pi`

```sh
ORPHUS_TUI_BACKEND=termdom orphus --resume
```

```json
{ "tui": { "backend": "termdom" } }
```

An unrecognized value is reported and ignored rather than failing startup — a
typo in a setting should not stop you opening a session picker.

## What the pilot covers

Only the surfaces named above. **The main chat shell is always pi**, and every
public `Component`, custom editor, renderer, and extension API is unchanged.
Migrating the chat shell is a separate question for after the pilot, not part of
it.

Within the picker, both backends drive the same
[`SessionSelectorModel`](../src/core/terminal/session-selector-model.ts):
filtering, threaded/recent/relevance sorting, the named filter, scope toggling,
regex (`re:…`) and quoted search, tree construction, path visibility, rename,
delete confirmation, loading state, and the safeguard that refuses to delete the
session you are sitting in. Those behaviours are shared code, not two
implementations kept in step by hand, and they are tested without a terminal.

Keyboard handling is shared the same way: termDOM decodes stdin into DOM
`KeyboardEvent`s, and the backend re-encodes each one into the raw key data that
the ordinary keybinding configuration matches. A rebound key rebinds both
renderers.

## Layout

The termDOM picker is responsive:

- **90 columns or wider** — search and list on the left, a detail panel for the
  selected session on the right.
- **Narrower** — a single column. The detail panel disappears rather than being
  squeezed; a 60-column terminal showing both shows neither.

Mouse row selection works because every row carries its index, so a click is a
selection rather than a coordinate calculation.

## Handing the terminal back

A backend owns terminal attachment, input, rendering, resize, and teardown for
the duration of one selection. `dispose()` is **awaited** before anything else
attaches: raw mode, the cursor, mouse reporting, and bracketed paste are all
restored first, whether the picker exited normally, was cancelled, or threw. Two
renderers holding stdin at once is exactly what this abstraction exists to
prevent, so termDOM is fully disposed before the pi chat UI attaches.

## Testing it

termDOM takes its whole notion of a terminal — size, color depth, input,
resizes, lifecycle — from an injected `TerminalTransport`. That makes the
renderer testable headlessly: real layout and real ANSI, no TTY and no timing.
`test/unit/terminal-fake-transport.ts` is the deterministic transport;
`test/unit/terminal-termdom-render.test.ts` asserts frames at both widths, with
CJK, RTL, and emoji names, and against a 500-session list.

## Becoming the default

Not in this release. After one stable opt-in release, termDOM becomes the
default **for the migrated startup and session-picker surfaces only**, and only
if the performance, teardown, and compatibility gates pass with no unresolved
terminal regressions. `pi` stays available as an immediate fallback either way.
