# Harness

The harness is what sits between a model and the world: the clock it reads, the
files it writes, the processes it starts, the credentials it may use, and the
record of every request it sent and every tool it ran.

Three things make it inspectable rather than merely present:

- a **capability boundary**, so world access is injected rather than reached for;
- **session records** of the exact provider request, the response, and each tool
  call's post-hook arguments;
- **`orphus inspect runtime`**, a deterministic dump of the assembled runtime.

## Capabilities

Everything the harness does outside its own process state goes through one of
seven small interfaces: `clock`, `fs`, `process`, `credentials`, `browser`,
`transcription`, `terminal`. Production wires the real implementations; tests and
the replay harness wire deterministic fakes and get the *same* assembled runtime
rather than a parallel one built for testing.

```ts
import { createAgentSession } from "@orphus/coding-agent";
import { createFakeCapabilities } from "@orphus/coding-agent";

const { session } = await createAgentSession({
   capabilities: createFakeCapabilities({ /* replace any subset */ }),
});
```

Each capability names its implementation through a `kind` field, which is what
`orphus inspect runtime` reports. The default credential capability is `empty`:
a build with no OS keychain binding denies credential injection rather than
silently falling back to some other source.

## Session records

Three versioned custom entries are written into the session transcript. All
three are `custom` entries, so **none of them enters reconstructed model
context** — they are for you, not the model.

### `orphus.provider.request.v1`

One per dispatched request, written at the last point before the request leaves
the process: after every `before_provider_request` hook and after payload
sanitization. It carries the request id, the retry attempt, the turn, the
session-tree leaf it was issued on, provider/model/API, the SHA-256 and byte
length of the exact body, and the body itself.

Bodies up to 1 MiB are stored inline. Larger ones spill to
`<session dir>/provider-requests/<request id>.json` — mode `0600` in a `0700`
directory — and the record carries `bodyPath`, a path relative to the session
directory, instead of `body`.

**If the record cannot be written, the attempt fails before dispatch.** A
request nothing recorded is a request nothing can replay, so the harness would
rather fail the turn than send it.

Authentication headers and provider credentials are never recorded: they travel
in headers, which this path does not see. As a second line, credential-shaped
*payload* fields (`apiKey`, `authorization`, `token`, `secret`, `password`, …)
are replaced with `[redacted]` and listed in `redactedPaths`. `sha256` and
`byteLength` always describe the exact body that was sent, so a stored artifact
stays verifiable.

### `orphus.provider.response.v1`

One per request, joined by `requestId`. Carries the HTTP status, the provider's
finish reason, usage, the duration from dispatch to settlement, and — when the
turn failed — a normalized error (`auth`, `rate_limit`, `overloaded`,
`context_overflow`, `network`, `aborted`, `provider`, `unknown`).

Turn and attempt identity is derived from these records alone: a request that
follows a completed response opens a new turn at attempt 0; a request that
follows an errored or abandoned one is the next attempt of the same turn.

### `orphus.tool.audit.v1`

One per tool call, recording the arguments the tool *actually ran with* — that
is, after mutable `tool_call` hooks. Also records `mutatedPaths` (what a hook
changed), the outcome (`executed`, `blocked`, `invalid_arguments`), and the
reason a call was stopped. Credential-shaped argument values are redacted.

Unlike the provider request record, a failed audit write does not fail the tool:
observation must not take down the operation it observes.

### Turning provider bodies off

Recording is on by default. Provider bodies are as sensitive as the session
transcript itself and live in the same place. To stop recording them:

```sh
ORPHUS_PROVIDER_AUDIT=0 orphus
```

## The tool-call pipeline

A tool call passes through these stages, in order:

```
resolve → initial schema validation → mutable hooks → snapshot
       → schema revalidation → policy/approval → execute
       → result hooks → finalize → observe
```

The stages that changed: `tool_call` hooks receive a live reference to the
validated arguments and may mutate them in place — that contract is unchanged —
but the result is now **re-validated against the tool's schema** before anything
else sees it. A hook that leaves arguments the schema rejects turns the call
into a durable tool error and the tool never runs. Everything downstream —
policy, approval prompts, and the tool itself — sees the post-hook arguments and
no earlier version, so an approval can no longer show one command while another
one runs.

## Resource registration is transactional

Extension resource registration during an event — tools, commands, shortcuts,
flags, providers, and flag defaults — runs inside a transaction. Transactions
nest; only the outermost commit publishes. If a handler throws, the whole batch
rolls back and nothing it registered becomes visible. Previously a handler that
died partway through published whatever it had already registered, and a
half-installed tool set was indistinguishable from a successful one.

## `orphus inspect runtime`

```sh
orphus inspect runtime --json
orphus inspect runtime --json --include-content
```

Boots the real runtime — real loader, real session composition — dispatches
nothing, and prints a deterministic, versioned JSON report:

| Field | What it holds |
| --- | --- |
| `version`, `appVersion` | Report schema version and the Orphus version that produced it |
| `model` | Resolved provider, model id, API, and thinking level |
| `capabilities` | The implementation `kind` wired for each of the seven capabilities |
| `tools` | Every tool, whether it is active, its source, and the SHA-256 of its parameter schema |
| `extensions` | Each extension with the events it handles and how many handlers it registered |
| `hookOrder` | Per event, the extension paths in the order their handlers run |
| `flags` | Flag values with their owning extension, origin, and whether the value was set explicitly |
| `settings` | Effective settings with the scope (`project` or `global`) that supplied each |
| `systemPrompt` | Overall hash and byte length, plus a hash per top-level `#` section |

Everything is sorted, so two runs of the same configuration produce
byte-identical output and any diff is a real difference. Tool schema hashes are
taken over a canonical (key-sorted) serialization, so reordering a schema's keys
does not move its hash.

`--include-content` adds `systemPrompt.content` and nothing else. **Secrets are
redacted in both modes** — the flag widens what is reported about the prompt,
never what is reported about credentials.

## The replay harness

`createReplayRuntime` boots the production composition against fake capabilities
and a scripted provider, and hands back the audit records:

```ts
import { createReplayRuntime } from "@orphus/coding-agent";

const runtime = await createReplayRuntime({
   script: [{ toolCalls: [{ id: "c1", name: "echo", arguments: { message: "hi" } }] }, { text: "done" }],
   customTools: [echoTool],
   tools: ["echo"],
});
await runtime.session.prompt("use the tool");

runtime.providerRequests();  // orphus.provider.request.v1 records
runtime.providerResponses(); // orphus.provider.response.v1 records
runtime.toolAudits();        // orphus.tool.audit.v1 records
runtime.dispose();
```

The scripted provider calls `onPayload` and `onResponse` exactly where a real
provider does, so a replay exercises the real recording path rather than a
stand-in for it. A test that passes here passes against the same wiring a user
runs.
