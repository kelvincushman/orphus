# Intermittent 400 "You're out of extra usage"

```
API Error: 400 You're out of extra usage. Add more at claude.ai/settings/usage and keep going.
```

Server-issued with a real `request_id`, typed `invalid_request_error`, and marked `x-should-retry: false`, so Claude Code treats it as a fatal client error. The response carries `anthropic-ratelimit-unified-overage-disabled-reason: out_of_credits` but no normal rate-limit view, indicating that the request is rejected before model execution. `diag/attrib.py` finds and classifies occurrences in the bridge log; it documents the log shapes to match.

## Reproduction

Capture a failure through the real SDK path, then replay the body with the captured headers:

```
node diag/capture-proxy.mjs --port 8795 --out /tmp/cc-cap
ANTHROPIC_BASE_URL=http://127.0.0.1:8795 pi --model claude-bridge/claude-opus-5
# an episode writes err-NNNN.json beside req-NNNN.json
curl -X POST 'https://api.anthropic.com/v1/messages?beta=true' \
     -H "authorization: Bearer $TOKEN" <headers from err-NNNN.json> \
     --data-binary @req-NNNN.json
```

`req_011CdnAUvhxnrxVzANbdJD7N` replays 400 every time while four sibling captures from the same account replay 200 in the same minute, interleaved, so account state does not drift under the test.

A fresh natural Pi `Agent` invocation reproduced the failure as `/tmp/cc-billing-control-20260807T042717Z/req-0009.json`: first request, genuine Agent SDK `cc_entrypoint=sdk-ts`, Opus 5, HTTP 400. Exact replay remains 400 while a known-good parent request remains 200 interleaved. Current Agent SDK 0.3.224 / bundled Claude Code 2.1.224 behaves the same.

## What decides it

The placement and content of Pi's generated harness in `system[]`. `req-0071` is a failing agent turn; `req-0073` is the `continue` the user typed straight afterwards, which passed. Swapping their system prompts while keeping messages fixed proved that the system prompt controls the result:

| system prompt | messages | result |
| --- | --- | --- |
| agent turn (27,584 chars, carries `<sub_agent_context>`) | 0071's | **400** |
| parent (20,150 chars) | 0073's | 200 |
| parent (20,150 chars) | 0071's | 200 |
| agent turn (27,584 chars) | 0073's | **400** |

The explicit sub-agent markers are innocent. Removing or renaming `<sub_agent_context>` and `<active_agent>` does not help, and appending them to a passing request does not hurt. The decisive block is the inherited Pi harness beginning `You are an expert coding assistant operating inside pi...`; removing that block flips 400→200 and adding it to a known-good parent flips 200→400.

Bisection narrowed the discriminator in this captured context to Pi's canonical documentation-routing line, specifically the exact lowercase phrase `pi packages` within it. Neutral capitalization or wording passes, but bare `pi` elsewhere passes, so this is a recognizable prompt fingerprint rather than a keyword ban. Moving the exact 19,387-character Pi prompt from `system[]` into the first user message also returns 200 with the same genuine SDK attribution.

Raw size, token count, beta flags, tools, messages, explicit agent markers, SDK version, Claude identity, and billing entrypoint do not explain the result. The server is applying a content-and-placement-dependent plan-eligibility decision before model execution; the backend classifier's purpose and implementation remain unknown.

## Ruled out

Each by direct experiment, most after being asserted here and withdrawn:

| hypothesis | killed by |
| --- | --- |
| client authenticity / non-official SDK path | the fresh failure came from the real Claude Code binary via the Agent SDK; natural CLI, `claude -p`, and direct SDK controls were also captured |
| a retry, in any form | identical body fails 100%; unmoved by fresh session/device id, whitespace, `max_tokens`, or an appended `continue` turn |
| a generic banned keyword | a passing capture contains `kimi-k3` 4×; bare `pi` and many other Pi references pass; the discriminator is contextual |
| prefix-position cache key | prepending 49 chars changed nothing |
| token count or a size band | filler sweeps 11K→181K tokens without one failure |
| model, tools, thinking, effort, `max_tokens`, `cache_control` | removed or varied individually; failure persists |
| concurrency / simultaneity | 28 concurrent pairs, 0 failures |
| subagent lifecycle | 18 agent-lifecycle turns passed while the state was live; explicit sub-agent markers are non-causal |
| `cch` as a content hash | 49 captures carry 49 distinct `cch`; four system prompts each map to more than one `cch`, so it is a per-request nonce |
| billing entrypoint deciding the 400 | passing and failing natural requests both use genuine `cc_entrypoint=sdk-ts` |
| old SDK/CLI behavior | the current Agent SDK and bundled Claude Code reproduce the same content-dependent result |

## The bridge integration bugs

The first bug was capture ownership. Two module globals held the prompt capture from `before_agent_start`; a sub-agent overwrote the parent's capture and nothing restored it, so later parent turns carried `<sub_agent_context>` and lost their own context files. Captures are now keyed by the assembled system prompt, so each query resolves its own agent's resources. Live logs show `ctxFiles` dipping only on child turns and immediately returning to the parent's value.

The remaining child failure came from provenance loss. Top-level bridge requests deliberately do not forward Pi's generated base prompt because it describes Pi's harness and tools while Claude Code supplies its own preset. Instead, the bridge forwards Pi's structured context files, skills, and user custom/append instructions. `pi-subagents`, correctly for ordinary Pi providers, creates an append-mode child by placing the parent's fully rendered prompt verbatim at the start of `systemPromptOverride` and adding the child role, environment, specialization, memory, and preloaded skills. Pi exposes that override as `systemPromptOptions.customPrompt`, indistinguishable from a direct user `--system-prompt`, so the bridge appended the whole inherited Pi harness to Claude Code.

The fix treats prompt captures as an inheritance graph. When a new custom prompt contains an exact previously assembled prompt, the bridge records that byte range as an edge to the parent capture. Projection recursively substitutes the parent's portable context, skills, and genuine user instructions while preserving every byte of child-specific text around it. Direct custom prompts and replace-mode agents with no known parent remain unchanged. This uses exact runtime prompt identity, not Pi prose, `pi packages`, or sub-agent marker matching. Direct parent references survive lookup-key eviction; reachable ancestors remain available for relinking changed descendants. Skills are captured from `systemPromptOptions.skills`, formatted with Pi's own formatter, and deduplicated ancestor-first instead of scraping the first inherited XML block.

## Billing routing and policy

Anthropic's current Help Center article, [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), says the announced separate Agent SDK billing pool was paused: Agent SDK, `claude -p`, and third-party apps built with the SDK continue to draw from subscription limits. No spoofed entrypoint is needed or appropriate.

Natural same-account controls while Extra Usage was exhausted all passed:

| route | natural billing marker | result |
| --- | --- | --- |
| interactive Claude Code TUI | `cc_entrypoint=cli` | 200 |
| `claude -p` | `cc_entrypoint=sdk-cli` | 200 |
| direct TypeScript Agent SDK | `cc_entrypoint=sdk-ts` | 200, `status=allowed`, overage rejected as `out_of_credits`, `isUsingOverage=false` |
| bridge parent request | `cc_entrypoint=sdk-ts` | 200 |
| bridge child with inherited Pi harness | `cc_entrypoint=sdk-ts` | **400 Extra Usage** |

The entrypoint correctly declares SDK use but does not determine eligibility within SDK traffic. Do not set `CLAUDE_CODE_ENTRYPOINT=cli`; that would be a false declaration and billing circumvention.

These controls establish routing behavior, not occurrence-level dollar attribution. The reported $5 drain was not accompanied by a request ledger or a before/after balance capture, and Extra Usage is now empty, so no individual request can be tied to a dollar amount from the available evidence.

## Fix validation

After recursive projection, a fresh natural Pi → `Agent(general-purpose)` → `claude-bridge/claude-haiku-4-5` run produced `/tmp/cc-billing-control-20260807T042717Z/req-0020.json` and `req-0022.json`. Both returned 200 while Extra Usage remained exhausted. Both retained `<sub_agent_context>`, `<active_agent>`, environment instructions, and exactly one skills catalogue. Neither contained `operating inside pi, a coding agent harness` nor `pi packages (docs/packages.md)`. Billing attribution remained genuine `cc_entrypoint=sdk-ts`.

The implementation is covered by unit tests for one- and two-level inheritance, direct and replace-mode custom prompts, longest exact matching, repeated occurrences, parent mutation, LRU eviction and relinking, child policy preservation, skill deduplication, and disabled-skill override. Type checking, all 172 unit tests, and `git diff --check` pass. Qwen 3.8 Max reviewed the design before implementation; Kimi K3 reviewed the implementation and the eviction follow-up and reported no blocker.

## Upstream

Two upstream improvements remain appropriate and independent:

1. Pi could expose custom-prompt provenance or an `inheritedSystemPrompt` field, allowing the bridge to replace the exact inheritance edge without reconstructing it from prior capture identity.
2. Anthropic should clarify or fix why a documented genuine Agent SDK `systemPrompt.append` request changes plan eligibility based only on appended prompt content. The saved A/B can be reduced to a synthetic report without sharing conversation captures.

No public report has been posted. Captured bodies contain sensitive conversations and must not be shared. Relevant symptom reports include [#80750](https://github.com/anthropics/claude-code/issues/80750), [#45020](https://github.com/anthropics/claude-code/issues/45020), [#63761](https://github.com/anthropics/claude-code/issues/63761), [#65514](https://github.com/anthropics/claude-code/issues/65514), and [#84141](https://github.com/anthropics/claude-code/issues/84141).
