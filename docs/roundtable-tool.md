# The `roundtable` tool — full reference

Every Orphus session registers two tools: `roundtable` for rooms, and `memory`
for the durable layer ([`memory.md`](memory.md)). This is the complete
`roundtable` surface, with the defaults and the reasoning behind them.

- [The three delivery tiers](#the-three-delivery-tiers)
- [Actions](#actions)
- [Parameters](#parameters)
- [How the digest spends its budget](#how-the-digest-spends-its-budget)
- [Read cursors](#read-cursors)
- [Activity pings](#activity-pings)
- [Limits and defaults](#limits-and-defaults)
- [Etiquette that actually matters](#etiquette-that-actually-matters)

## The three delivery tiers

Content reaches an agent three ways, and choosing the right one is most of using
this tool well.

| Tier | Action | Bound | Use it when |
| --- | --- | --- | --- |
| Ping | *(automatic)* | one line per quiet period | never — it arrives on its own |
| Digest | `digest`, `peek` | a character budget you set | catching up, which is nearly always |
| Fetch | `fetch` | the number of messages you ask for | you need something a digest collapsed |

Reach for `digest` by default. Reach for `fetch` when a digest has told you it
collapsed something and you need to know what it was — that is cheaper than
re-running the digest with a larger budget, which also re-pays for everything
newer that you have already read.

## Actions

### `rooms` — what exists, and where your attention is wanted

```typescript
roundtable({ action: "rooms" })
```

```
#design — rate limiter · 4 unread · 12 msgs · members: planner, critic
#infra · 0 unread · 3 msgs · members: planner
```

The unread count is **yours specifically**, resolved from your role's cursor.
That is the field to scan: it answers "does anything need me" without spending a
digest on each room to find out.

### `join` — enter a room, creating it if needed

```typescript
roundtable({ action: "join", room: "design", topic: "rate limiter design" })
```

`topic` is only used when the room is created. Joining reports how many messages
you have not read, so a late joiner immediately knows whether to digest.

Joining is announced to members as *membership*, not as content — peers are told
someone arrived, and it does not register as a new message.

### `post` — say something

```typescript
roundtable({ action: "post", room: "design", message: "Adopted GCRA locally." })
roundtable({ action: "post", room: "design", message: "Agreed.", replyTo: "<message-id>" })
```

Posting marks the message as read **for you** — you do not catch up on your own
words. Peers get one coalesced ping, not the text.

### `digest` — catch up, and mark it read

```typescript
roundtable({ action: "digest", room: "design" })
roundtable({ action: "digest", room: "design", budget: 4000 })
roundtable({ action: "digest", room: "design", budget: 2000, perMessage: 200 })
```

Renders everything you have not read, within budget, and advances your cursor to
the newest message included.

`perMessage` is the lever people miss. Lowering it fits *more messages* into the
same budget by truncating each one harder — better when you want the shape of a
discussion, worse when you need exact wording.

### `peek` — the same, without marking it read

```typescript
roundtable({ action: "peek", room: "design" })
```

Identical output, cursor untouched. Use it to look before deciding whether to
engage. Repeated peeking is a smell: if you have read it, digest it, or your
unread count stays permanently wrong.

### `fetch` — raw messages, by number

```typescript
roundtable({ action: "fetch", room: "design" })                       // from your cursor
roundtable({ action: "fetch", room: "design", afterSeq: 12 })         // explicit range
roundtable({ action: "fetch", room: "design", afterSeq: 0, limit: 5 }) // from the start
```

Full bodies, **not truncated** — this tier is you deciding to spend context, so
silently shortening a message would defeat the reason to use it. `limit` is the
control instead, defaulting to 20.

Does not move your cursor. Every message carries a sequence number (`planner#7`),
and that is what `afterSeq` refers to.

### `leave` — exit a room

```typescript
roundtable({ action: "leave", room: "design" })
```

Announced to remaining members, the same way a dropped session is.

### `export` — write a transcript for memory

```typescript
roundtable({ action: "export", room: "design", path: "raw/design.md" })
```

Restricted to the `librarian` role. Reads from the broker rather than from a
digest, so it is lossless where a digest collapses. Returns **only a path and
counts** — the transcript never enters the caller's context — and leaves every
member's cursor alone.

Writes are confined to the memory `raw/` directory. Absolute paths, `..`
escapes, and symlinks pointing outside are all rejected. If the room has
exceeded its retention and older messages have already rotated away, the result
says so rather than presenting a truncated file as complete.

## Parameters

| Parameter | Type | Applies to | Notes |
| --- | --- | --- | --- |
| `action` | literal | all | One of the eight above |
| `room` | string | all but `rooms` | Required |
| `message` | string | `post` | Required |
| `replyTo` | string | `post` | A message id |
| `topic` | string | `join` | Only used when creating |
| `budget` | number | `digest`, `peek` | Default 2000, floored at 200 |
| `perMessage` | number | `digest`, `peek` | Default 600, floored at 80 |
| `afterSeq` | number | `fetch` | Defaults to your cursor |
| `limit` | number | `fetch` | Default 20 |
| `path` | string | `export` | Relative, under `raw/` |

Budgets are floored rather than honoured exactly: asking for 50 gets you 200,
because a digest smaller than that cannot carry a message plus its marker line
and would report emptiness that is not real.

## How the digest spends its budget

The algorithm is deterministic and involves no model. That is what makes the
bound provable rather than probable — the same messages and budget always
produce the same digest, and no peer can influence yours by writing differently.

1. Sort unread newest-first.
2. Spend budget on **full bodies**, each capped at `perMessage`.
3. When the next body will not fit, drop to **one-line headlines**.
4. When the next headline will not fit, stop: everything older becomes a count.
5. Render the result **oldest-first**, so it reads chronologically.

Steps 2 and 5 together are the design: budget is spent on what is newest, but you
read in order. Conclusions survive verbatim; early exploration compresses.

Step 4 matters more than it looks. It stops at the *first* headline that does not
fit rather than continuing to look for a shorter one — otherwise an older message
could render above newer ones counted as collapsed, and the "N older messages
collapsed" marker would sit above lines newer than some of what it counts.

The output is guaranteed to be at most `budget` characters plus one marker line.

## Read cursors

Cursors live in the broker, keyed by **role name** — not by process, session id,
or connection.

The consequence is useful: a session that dies and comes back as `planner` is
still the same `planner` as far as the room is concerned, and picks up where it
left off. It is also a constraint: two concurrent sessions using the same role
name share one cursor and will read past each other's position.

Give every session a distinct, stable `--name`. Without one it falls back to
`session-<pid>`, which changes on every restart and loses the cursor.

## Activity pings

When peers post, your session receives a single line per quiet period:

```
Roundtable activity — #design: 3 new (planner, critic). Use roundtable({ action: "digest", … }) to catch up when relevant.
```

Properties worth relying on:

- **Coalesced.** Ten messages in one window produce one line, not ten.
- **Grouped across rooms.** Two active rooms is still one line.
- **Authors are a set.** A peer posting five times is named once.
- **No bodies, ever.** A ping tells you something happened, never what.
- **Membership is filtered out.** Joins and departures do not count as content.

A ping is a notification, not an interrupt: it lands in your transcript rather
than forcing a turn. Deciding whether to act on it is yours.

## Limits and defaults

| Thing | Value | Consequence |
| --- | --- | --- |
| Room retention | 500 messages | Older messages rotate away; `export` reports if any did |
| Digest budget | 2000 chars (floor 200) | Per call |
| Per-message cap | 600 chars (floor 80) | Verbatim bodies only |
| Headline cap | 100 chars (floor 40) | Not exposed on the tool |
| Fetch page | 20 messages | Raise with `limit` |
| Ping window | 1.5 s | Quiet period before a ping is sent |
| Broker idle exit | 5 s | After the last session disconnects |

Rooms are in-memory only. When the broker exits, rooms and membership go with
it, and a later `post` fails with `Not a member of room "…"; join it first`.
That error is the correct outcome — the room really is gone — and the remedy is
to rejoin. Use `export` plus memory for anything that must outlive the task.

## Etiquette that actually matters

Discussion etiquette also ships as an agent skill in
`packages/roundtable/skills/`, so a session gets it without being told.

- **Post conclusions, not transcripts.** The room is for what you decided and
  why, not your reasoning in full. Peers pay for length.
- **Digest before deciding.** Acting on a stale view is the failure this whole
  mechanism exists to prevent.
- **One room per concern.** `#design` and `#infra` beat one `#general` that
  everyone must filter mentally.
- **Address people by role.** `critic: does this hold under partition?` is
  actionable; a general musing is not.
- **Raise the budget deliberately.** If a digest collapsed something you need,
  `fetch` that range — it is cheaper and more precise than a bigger digest.
