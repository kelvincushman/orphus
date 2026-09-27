# Orphus compatibility port notes

## Source

- Upstream: `https://github.com/elidickinson/pi-claude-bridge`
- Upstream baseline before branching: `227f5eb4450a070dfbc083a7fe75b8b35366b941`
- Local branch: `orphus-compat`
- Target host: installed Orphus 2.3.1
- Provider ID from `src/convert.ts`: `claude-bridge`

The managed Orphus release was read but not modified. This branch was not pushed, published, or submitted as a PR.

## Red-to-green regression evidence

The compatibility test was committed first as `da3a485` while the checkout still had upstream imports and lifecycle hooks.

```bash
node --import tsx --import ./tests/lib/setup.mjs --test tests/unit-orphus-compat.mjs
```

Pre-port result: exit 1, with all three Orphus contract checks failing:

1. source still imported `@earendil-works/pi-coding-agent`;
2. the manifest lacked the `@orphus/coding-agent` host peer and retained the old peer;
3. activation still registered `session_before_compact` and called Pi's unavailable `compact` export with the obsolete `{ compaction }` return shape.

Post-port result: 3 tests pass. The lifecycle test now emits a simulated `session_compact`, calls the next session sync, opens the rebuilt Claude Code JSONL, and verifies the compacted boundary and retained assistant turn appear exactly once instead of resuming stale history.

## Port choices

- All coding-agent imports now use runtime exports available from `@orphus/coding-agent`.
- `@orphus/coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and `typebox` are optional `"*"` peers supplied by Orphus. `@earendil-works/pi-coding-agent` is absent from both peer and development dependencies.
- Unit tests use a small loader-only `@orphus/coding-agent` fixture. It does not ship as a runtime dependency.
- The two pi-ai transcript replay helpers missing from Orphus's bundled pi-ai 0.83 are implemented locally in `src/transcript.ts`. Orphus-shaped contexts without system transcript messages remain an object-identity no-op.
- The obsolete compaction takeover was removed. Orphus performs native verbatim line compaction through the selected provider. Its one-off request has `cacheRetention: "none"`, so the bridge runs it in a separate non-persisted Claude Code query. The observe-only `session_compact` handler marks the shared Claude session for rebuild from Orphus's persisted boundary.
- The obsolete branch-summary takeover was removed. Orphus native branch summarization reaches the same isolated one-off provider path. `session_tree` still marks the Claude session for rebuild after navigation.
- Tool execution remains host-owned. Tool names and schemas pass through the MCP bridge; existing schema, parallel-result, tool-pairing, and abort queue tests remain green.
- Abort handling still interrupts and closes the Agent SDK query, fails the prompt stream, and releases pending tool handlers. The bounded live shutdown tests remain in `tests/int-shutdown-kills-cc.mjs`; this leaf did not spend a live request to rerun them.
- The host-harness subscription guard now recognizes Orphus's current preamble instead of Pi's old preamble.
- Config and debug paths now resolve through Orphus's active agent directory. AskClaude remains opt-in and no config file was created.

## Verification run in this leaf

```text
npm run test:compat  -> 3 passed, 0 failed
npm run test:unit    -> 238 passed, 0 failed
npx tsc --noEmit     -> exit 0
npm ls @earendil-works/pi-coding-agent --all -> (empty)
```

The full `npm test` command includes many live upstream integration requests, so it was not run here under the goal's three-attempt live budget. README documents both the offline commands and this distinction. Actual Orphus loading and bounded live text/tool validation belong to the next goal leaf.

## Runtime install shape

For a runtime-only dependency tree before local installation:

```bash
npm install --omit=dev --legacy-peer-deps --ignore-scripts
```

This installs the Claude Agent SDK and bridge libraries but not a standalone Pi/coding-agent host. Local installation then uses:

```bash
orphus install /home/kelvinlee/projects/orphus-claude-bridge
```

Removal is:

```bash
orphus remove /home/kelvinlee/projects/orphus-claude-bridge
```

No install or settings write was performed in this leaf.

## Contract amendments received

Inherited mid-run steering (verbatim): "User asks for progress again. The durable clone /home/kelvinlee/projects/orphus-claude-bridge still does not exist. Prioritize producing the owned contract artifact and durable clone if assigned, then handing off to implementation. Reuse prior compatibility evidence instead of broad repeat research. Bound further probing to unresolved contracts that directly affect a code change; do not weaken session/compaction correctness or required validation. Record exact remaining blockers and concrete next steps."

Disposition: the durable clone now exists at the required path, the prior contract map guided the minimal port, and no broad compatibility re-review was repeated.
