# Atomic integration

These files make Orphus rooms available as a first-class extension inside an
[Atomic](https://github.com/bastani-inc/atomic) fork: `index.ts` is the
extension entry (lazy broker connect, coalesced activity notifications) and
`roundtable-tool.ts` registers the `roundtable` tool the model calls.

They import `@bastani/atomic` and `typebox` from the Atomic workspace, so they
compile inside an Atomic checkout — not standalone. The supported way to
install them is the patch series:

```bash
cd your-atomic-fork
git am path/to/orphus/patches/atomic/*.patch
bun install && bun run typecheck
./node_modules/.bin/vitest --run --project unit test/unit/roundtable
```

The patch adds the complete `packages/roundtable` package (this repo's core +
these integration files + the skill), the repo-root test suite, and tsconfig
wiring. Base commit: atomic `d84fc43`; rebase normally if your fork has moved.
