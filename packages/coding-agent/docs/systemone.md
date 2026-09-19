# System One

A decision layer that runs **before** the model, not instead of it.

Off by default. Nothing below happens until you change a setting.

## The idea

Daniel Kahneman's *Thinking, Fast and Slow* describes two modes of thinking.
System 1 is fast, automatic and effortless. System 2 is slow, deliberate and
expensive. The useful part for us is that practice moves work from the second
into the first: learning to drive takes your whole attention, and then one day
it does not.

Orphus has only ever had System 2. A Goal run is a chain of full model turns:
a planner, workers, verifiers, reviewers. Several of the decisions inside that
chain are not really System 2 work. "Is this leaf mechanical or architectural?"
does not need a model that can write an essay about it.

This layer is the missing System 1. It answers fixed questions, fast, and when
it is not sure it says so and the full model runs exactly as it would have.

TypeSafe's **Jev**, released 15 September 2026, is the first hosted model built
for this and the reason the shapes below look as they do. It is not a language
model: it generates no text, it scores the answers you supply, and it returns a
probability for each. Orphus's port mirrors its wire format so a question
written here stays portable, and so the two can answer identical state and be
compared.

## What it can and cannot do

The layer is allowed to make Orphus faster or stricter. It is not allowed to
make it less careful, and the shape of each call site enforces that:

| Surface | Runs before | A confident answer | It can never |
|---|---|---|---|
| Leaf tier | the first worker dispatch | picks the model pool for that leaf | pick a pool nothing declared |
| Reviewer vote | the completion quorum | withholds a reviewer's "done" vote | supply a vote, or veto a quorum others reached |
| Leaf pre-screen | the verifier turn | fails a leaf whose receipt does not evidence its checks | mark a leaf verified, or skip verification by agreeing |

Three rules hold everywhere:

- **It runs before the step it could save, never after.** Re-judging a finished
  model step would make this an override layer. It is a triage layer.
- **It may deny, never approve.** Nothing here can conclude that work is done.
- **Unsure means unchanged.** Below the threshold, the caller takes exactly the
  path it took before this layer existed.

## Turning it on

Settings live in the workflow extension config, next to every other workflow
knob:

- Project: `.orphus/extensions/workflow/config.json`
- Global: `~/.orphus/agent/extensions/workflow/config.json`

```json
{
  "systemOne": {
    "adapter": "local",
    "thresholds": { "tier": 0.8, "review": 0.9, "verify": 0.9 },
    "local": { "baseUrl": "http://127.0.0.1:8080/v1", "model": "qwen3-4b" }
  }
}
```

| Setting | Default | Meaning |
|---|---|---|
| `systemOne.adapter` | `null` | Which one answers: `null`, `llm-wrapper`, `local`, `typesafe` |
| `systemOne.thresholds.tier` | `0.8` | Confidence needed before a leaf's tier is overridden |
| `systemOne.thresholds.review` | `0.9` | Confidence needed before a reviewer's vote is withheld |
| `systemOne.thresholds.verify` | `0.9` | Confidence needed before a leaf fails without verification |
| `systemOne.local.baseUrl` | `http://127.0.0.1:8080/v1` | Your model server, including the version segment |
| `systemOne.local.model` | — | The model name that server answers to |
| `systemOne.local.api` | `completions` | `completions` or `chat`; see the note under `local` below |
| `systemOne.local.timeoutMs` | `20000` | After this, the decision abstains |
| `systemOne.typesafe.baseUrl` | `https://api.typesafe.ai` | TypeSafe's API |
| `systemOne.typesafe.model` | `jev-latest` | Which of their models answers |
| `systemOne.typesafe.timeoutMs` | `10000` | After this, the decision abstains |

`ORPHUS_SYSTEMONE` overrides the adapter for one run without editing config,
which is how a before-and-after comparison is meant to be taken:

```sh
ORPHUS_SYSTEMONE=local orphus
```

An invalid setting is reported, never silently replaced by its default. A
threshold that quietly reverted to `0.9` would look identical to one you meant
to set.

### Thresholds, in practice

A threshold is how sure the layer must be before its answer is acted on.

- **Raise one to 1** and that surface effectively stops acting: only certainty
  qualifies. This is how you disable a single surface while keeping the rest.
- **Lower one** and the layer acts more often, including when it is wrong.
- **Do not lower them below the defaults yet.** No adapter is calibrated (see
  below), so a reported 0.85 does not yet mean "right 85% of the time".

The defaults are deliberately uneven. Choosing a tier wrong costs a retry.
Withholding a reviewer's vote or failing a leaf early costs a turn and could
mask real progress, so those two sit higher.

## The adapters

### `null` — the default

Answers every question with maximum uncertainty, so every decision abstains and
nothing changes. It exists so the wiring can be proven: if any behaviour
differs under `null`, that is a bug in the wiring, not a model.

### `local` — a real System One on your own machine

Asks a small model to answer with one letter, and then never lets it write one.
One token is requested, the probabilities of that token are read, and the option
letters are picked out. No text is generated, so the cost is a single prefill.

Orphus ships no model and no inference runtime for this: the server is yours.
Anything OpenAI-compatible that returns logprobs works.

```sh
# llama.cpp, for example
llama-server -m qwen3-4b-instruct-q4_k_m.gguf --port 8080

# then, in .orphus/extensions/workflow/config.json
#   "systemOne": { "adapter": "local",
#                  "local": { "baseUrl": "http://127.0.0.1:8080/v1", "model": "qwen3-4b" } }
```

Use `"api": "completions"` (the default) where you can. A chat template can put
reasoning tokens in front of the answer, which moves the letter out of reach of
a single-token read. `"api": "chat"` is there for servers that expose nothing
else.

### `llm-wrapper` — a language model imitating a classifier

Asks one of your configured models to return the probabilities directly, as
structured output, on the cheapest tier Goal uses. Slower and pricier than
`local`, and it needs no extra software at all. Useful to try the layer without
setting up a model server, and to produce the first labelled decisions.

### `typesafe` — the yardstick

Sends the same state and questions to TypeSafe's hosted Jev, so the gap between
it and a local model is a number rather than an opinion. Requires
`TYPESAFE_API_KEY` in the environment; it is never read from a config file, and
no other adapter contacts a third party.

**The key goes wherever `systemOne.typesafe.baseUrl` points.** It is sent as a
bearer token to `<baseUrl>/v1/systemone`, along with the state being judged —
which for Goal is leaf contracts, worker receipts and reviewer evidence. The
default is TypeSafe's own API; anything else you set there, a gateway or a proxy
or a recording server, has to be an origin you trust with that credential and
with what it is asked about. The setting is read from the same project and
global config as every other workflow knob, so on a shared checkout it is worth
knowing who can change it.

## Receipts

Every decision is recorded, including every abstention, in the run's own
artifact directory beside the evidence it influenced:

```
~/.orphus/workflows/runs/<run-id>/turn-1-systemone-receipts.jsonl
```

One JSON object per line:

```json
{
  "surface": "goal.tier",
  "question_key": "reasoning_required",
  "kind": "score",
  "value": 0.24,
  "p": 0.81,
  "confidence": 0.78,
  "threshold": 0.8,
  "abstain": true,
  "adapter_id": "local:qwen3-4b",
  "calibrated": false,
  "state_hash": "9f2c…",
  "question_hash": "41ab…",
  "ts": "2026-09-18T21:40:00.000Z",
  "context": { "leaf_id": "1.2", "planner_tier": "judgment" }
}
```

Worth knowing:

- **Abstentions are recorded too.** A log of only the decisions that were acted
  on would hide how often the layer was unsure, which is the number to watch.
- **`calibrated` is `false` everywhere today.** Nothing has been fitted on real
  outcomes yet, so the probabilities are the model's own opinion of itself.
- **`question_hash` identifies the wording.** When a question's criteria are
  revised, its old answers stay attributable to the version that produced them.
- **`context` says what was judged**, so a receipt joins back to its leaf or
  reviewer.

To see how often the layer actually acted:

```sh
jq -r 'select(.abstain==false) | "\(.surface) \(.value) p=\(.p)"' \
  ~/.orphus/workflows/runs/*/turn-*-systemone-receipts.jsonl
```

## Measuring whether it helps

The one number to watch first is **model attempts per Goal run**. Leaf records
now carry `model_attempts`, so an under-tiered leaf — one that walked the ladder
before succeeding — is visible:

```sh
jq '[.records[].model_attempts // [] | length] | add' \
  ~/.orphus/workflows/runs/<run-id>/turn-*-goal-execution-report.json
```

Run the same objective twice, once with `ORPHUS_SYSTEMONE=null` and once with
your chosen adapter, and compare. Also worth comparing: how many verify turns
were spent, and whether any reviewer vote was withheld (the reducer names them
in its reason).

## Harvesting labels

Goal runs are labelled data: the tier a leaf ran at and whether its first model
attempt worked, what a reviewer claimed and whether the run completed, what a
check expected and what the verifier found.

```sh
bun run scripts/systemone-labels.ts --out labels.jsonl
```

It reads every run under the workflow artifact directory, including runs from
before this layer existed, and joins the System One receipts where a run has
them. That dataset is what a calibration is later fitted on.

## What this is not, yet

Being straight about the gap:

- **Not calibrated.** Jev is trained for calibrated confidence. Nothing here is.
  Fitting a temperature on harvested outcomes is the next step, and until then
  the thresholds stay conservative and every receipt says `calibrated: false`.
- **Not as fast as Jev.** A local 4B model answers in a few hundred milliseconds
  to a second or two, against Jev's sub-200ms. For Goal, where a leaf takes
  minutes, that is fine.
- **Not automatically improving.** Two loops make it better, and both are
  deliberate acts: refitting calibration on harvested labels, and having a
  System 2 model read the receipts and rewrite the question criteria. The
  receipts carry what both need; neither is built yet.
- **Not everywhere.** Three surfaces inside Goal. Room convergence, post
  etiquette, and skill selection are all candidates and none are wired.

## Further reading

- TypeSafe's launch post: <https://typesafe.ai/blog/introducing-system-one-models-and-jev>
- Their System One concept page: <https://docs.typesafe.ai/concepts/system-one>
- Their open-source LLM adapter, which the `llm-wrapper` design follows:
  <https://github.com/typesafe-ai/system-one-adapter-python>
- Daniel Kahneman, *Thinking, Fast and Slow* (2011), for the two systems
  themselves.
- The package's own design notes: `packages/systemone/README.md`
