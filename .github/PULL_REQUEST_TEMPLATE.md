<!--
Orphus pull request. One work package per PR — see the work-package programme in
PLAN.md. Delete any section that genuinely does not apply; do not delete all of them.
-->

## What and why

<!-- One paragraph: the problem this solves, and the shape of the fix. -->

## Findings addressed

<!--
List the audit findings or issues this closes, one per line, with the file:line
each refers to. If a reported finding was investigated and refuted rather than
patched, say so here with the evidence — refuting a non-issue is a valid outcome
under the minimal-change principle in AGENTS.md.
-->

- [ ]

## Verification run

<!--
Paste what you actually ran, not what you intended to run.
Baseline for every PR:
    npm run check
    npx vitest --run --project unit test/unit/roundtable-
    npm run demo
Add the work-package-specific commands below.
-->

```
```

## Review gates

- [ ] CodeRabbit review complete, findings addressed or refuted with evidence
- [ ] Final review gate passed

## Scope check

- [ ] Smallest correct change — no speculative hardening, no rewrites (AGENTS.md, "Minimal-change principle")
- [ ] Reused existing helpers where they exist; checked the GitNexus graph before adding new code
- [ ] Every behavioural fix has a regression test proven to fail without it
- [ ] Changelog: user-facing package changes recorded in `packages/*/CHANGELOG.md`; CI, tooling, and docs-only changes deliberately not recorded there
