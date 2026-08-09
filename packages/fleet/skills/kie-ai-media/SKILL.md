---
name: kie-ai-media
description: Generate images, video, and audio through the Kie.ai unified API — async createTask/poll pattern, model selection from the market, and result handling for media-team fleet members.
---

# Kie.ai media generation

Kie.ai is a unified, credit-based gateway to media models (Flux image
generation, Veo/Kling/Seedance video, music and speech models, and more). One
API key, one request pattern, every model.

## Setup — the key is never in a file

The API key comes from the `KIE_AI_API_KEY` environment variable, set in the
user's shell profile. Get one at https://kie.ai/api-key.

- If `KIE_AI_API_KEY` is unset, STOP and tell the user to export it. Do not ask
  them to paste the key into chat, and never write it into a file, a blueprint,
  or a commit.
- Never echo the key. Use `"Authorization: Bearer $KIE_AI_API_KEY"` unexpanded
  inside the curl command so it stays out of logs.

## The request pattern — always async

Every generation is a task: create it, then poll until terminal. A `200` on
create means the task was **accepted**, not finished.

Create:

```sh
curl -sS --location 'https://api.kie.ai/api/v1/jobs/createTask' \
  --header "Authorization: Bearer $KIE_AI_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "flux-2/pro-text-to-image",
    "input": {
      "prompt": "a lighthouse in fog, muted palette, editorial illustration",
      "aspect_ratio": "16:9"
    }
  }'
```

The response carries a `taskId`. Poll it:

```sh
curl -sS --location "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=$TASK_ID" \
  --header "Authorization: Bearer $KIE_AI_API_KEY"
```

`data.state` walks `waiting → queuing → generating → success | fail`. Poll
every 5–15 seconds (image models finish in seconds, video in minutes); on
`fail`, report `failCode`/`failMsg` verbatim rather than retrying blindly. On
`success`, the media URLs are in `data.resultJson` — a JSON **string**; parse
it, then read `resultUrls` (media) or `resultObject` (text-shaped results).

## Handle results immediately

Generated files are retained for **14 days**, then deleted. Download every
result you intend to keep as soon as the task succeeds, into the project
(e.g. `assets/generated/`), and reference the local path in your output — not
the kie.ai URL.

## Choosing a model

The supported model list lives at https://kie.ai/market — each model page
documents its `model` string and `input` schema, with a playground. Model ids
follow `family/variant` (e.g. `flux-2/pro-text-to-image`,
`flux-2/pro-image-to-image`). When a task needs a capability you have not used
before, check the market page for the exact input fields instead of guessing.

## Limits and cost

- Rate limit: ~20 new requests per 10 seconds per key; excess returns HTTP 429
  and is **rejected, not queued** — space out fan-outs.
- Each task consumes credits (`creditsConsumed` in the record); usage is
  visible at https://kie.ai/logs. State cost expectations before generating
  large batches, exactly as with model sessions.
- HTTP 401 means the key is missing or wrong — re-check `KIE_AI_API_KEY`
  before anything else.
