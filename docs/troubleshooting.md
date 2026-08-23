# Troubleshooting

Ordered by how likely you are to hit it. The first three fail **silently** —
they produce a healthy-looking result that is wrong — so they are worth reading
before you need them.

## Agents cannot see each other

**Symptom.** Two sessions join the same room name. Each thinks it is alone, or
posts and nobody's unread count moves. No error anywhere.

**Cause.** They resolved different agent directories, so each spawned its own
broker. The socket lives under the agent dir, so a different dir means a
different broker — and each session is talking to a perfectly functional one.

**Check.**

```bash
echo "$ORPHUS_CODING_AGENT_DIR"          # in each session's environment
ls ~/.orphus/agent/roundtable/           # broker.sock should be here
```

**Fix.** Export the same `ORPHUS_CODING_AGENT_DIR` for every session, or unset it
everywhere and let all of them use the default `~/.orphus/agent`.

Note `.atomic` is only a *legacy fallback* for pre-existing installs. Pointing
some sessions at `~/.atomic/agent` and others at the default is the most common
way to cause this.

## Memory queries return nothing, and look fine doing it

**Symptom.** `memory({ action: "query" })` returns an empty or unhelpful answer.
Exit status is success.

**Cause.** Usually the store is empty — nothing was ingested, or each worktree
addressed its own store. An empty answer is a valid answer, so nothing errors.

**Check.**

```typescript
memory({ action: "doctor" })   // is the backend configured and reachable?
```

```bash
echo "$ORPHUS_MEMORY_COMMAND"   # e.g. "uv run dossier" — no default
echo "$ORPHUS_MEMORY_DIR"       # defaults under the agent home
```

**Fix.** Set `ORPHUS_MEMORY_COMMAND` — there is no default, and without it every
call returns a configuration error. Confirm something was ingested: the flow is
`roundtable export` → `memory ingest` → `memory query`, and skipping the middle
step is easy to do.

## A digest is missing something you know was said

**Not a bug.** Budget is spent newest-first, so an older message may have been
compressed to a headline or counted as collapsed. The digest header tells you:

```
#design · 9 unread · showing 3 verbatim, 1 headline(s), 5 collapsed · 767 chars
```

**Fix.** Fetch the range rather than re-running with a bigger budget — cheaper,
and it does not re-pay for everything newer that you have already read.

```typescript
roundtable({ action: "fetch", room: "design", afterSeq: 0, limit: 6 })
```

If digests routinely collapse too much, lower `perMessage` rather than raising
`budget`: it fits more messages into the same space by truncating each harder.

## `Not a member of room "…"; join it first`

**Cause.** The broker exited and took the room with it. It shuts down five
seconds after its last session disconnects, and rooms are in-memory.

**Fix.** Rejoin. The room is genuinely gone — this error is correct rather than
spurious, and automatic rejoining would restore the *appearance* of continuity
over a transcript that no longer exists.

If it must survive the task, export it to memory before the fleet winds down.

## Read position resets on every restart

**Cause.** Cursors key on **role name**. Without `--name`, a session falls back
to `session-<pid>`, which is new every time.

**Fix.** Give every session a stable name — `--name planner`. The role manifest
does this for you.

Related: two concurrent sessions sharing one role name also share one cursor and
will read past each other. One name per running session.

## `Roundtable broker did not start in time`

The spawn waited and nothing answered. When the cause is a stale startup lock —
a previous broker died without cleaning up — the error now says so itself: it
names the lock file, the dead owner pid it probed, and the removal command, so
start with what the message tells you. The manual checks below cover the other
causes (an unwritable agent directory, a socket held by something unexpected):

```bash
ls -la ~/.orphus/agent/roundtable/
rm -f ~/.orphus/agent/roundtable/broker.sock   # safe: a live broker re-creates it
```

A broker started by hand prints its own errors, which is the fastest way to see
the real cause:

```bash
bun packages/roundtable/broker/main.ts
```

## `npm ci` fails, or the lockfile keeps changing

Use `npm ci --ignore-scripts`. Not `yarn`, `pnpm`, or `bun install` — each writes
a competing lockfile that `npm ci` neither reads nor verifies, and bypasses the
release-age gate in the committed `.npmrc`.

If you added a dependency and installs now fail with a cooldown error, that gate
is working: it refuses versions published in the last two days. It binds on
npm ≥ 11.6, where npm implements it.

## Tests pass locally and fail in CI, or vice versa

**The quarantine list is empty.** Every file that ever passed through
`QUARANTINED_TESTS` in `vitest.config.ts` left by fixing the cause (the last
one: provider credentials leaking from the developer's environment into test
fixtures — see [docs/ci.md](ci.md#quarantined-tests)). If a test only fails on
your machine, suspect your environment before the test: ambient provider
credentials (a configured AWS CLI makes amazon-bedrock genuinely authenticated
inside model fixtures) and load sensitivity are the two known classes, and both
are documented in [`AGENTS.md`](../AGENTS.md).

**The changelog test needs upstream tags.** It compares released sections against
the tag that released them, and this fork has no tags of its own. CI fetches the
inherited ones; locally you may need to as well:

```bash
git fetch --no-tags https://github.com/bastani-inc/atomic.git 'refs/tags/*:refs/tags/*'
```

**The full suite needs native bindings.** Without them the bundled subagent
extension fails at import and takes the whole run down, which looks like dozens
of unrelated failures:

```bash
npm run build --workspace=@orphus/natives
npm run build --workspace=@orphus/coding-agent
npm run test:unit
```

**Tests are load-sensitive by design.** vitest runs files in parallel and this
repository sets no worker limits. A test that only passes on an idle machine is
a bug in that test — give the real work headroom and derive assertions from a
named constant. Do not serialize the suite or shard it.

## The demo fails with a percentage

```
FAIL: a late joiner paid 44% of the raw transcript (1062/2413 chars), above the 40% ceiling.
```

Working as intended. That ratio is PLAN.md's phase-1 exit criterion and the
project's headline claim, so the demo exits non-zero above it rather than
printing a worse number and passing. Something changed the digest's cost. The
demo also fails if the digest kept nothing verbatim, since an empty digest would
score 0% and pass a ratio check alone.

## Still stuck

- [`architecture.md`](architecture.md) — what runs where, and which guarantees
  are real versus conventional.
- [`../packages/roundtable/DESIGN.md`](../packages/roundtable/DESIGN.md) — why
  each design decision went the way it did.
- [Open an issue](https://github.com/kelvincushman/orphus/issues). If the
  problem is in the vendored harness rather than in rooms, memory, roles, or
  digests, [Atomic](https://github.com/bastani-inc/atomic) is often the better
  place — Orphus inherits that code rather than maintaining it.
