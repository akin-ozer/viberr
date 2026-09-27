---
name: test-audit
description: "Use whenever writing, changing, reviewing or sweeping Viberr tests: vitest suites under app/, test-support harnesses, e2e specs, perf budgets, doc pins. The authoring gate every new or changed test meets (docs/development/testing.md §0, ruling 512), plus the audit workflow for low-value, implementation-coupled or duplicated tests and the test-only production seams they keep alive."
---

# Test audit

One value bar, three modes. **Authoring** gates every new or changed test at write time.
**Audit** sweeps existing tests for ones that restate their source, duplicate stronger
proof, couple to implementation, or keep a test-only production seam alive. **Campaign**
prunes one production owner's whole test surface in one change.

The bar itself — the four authoring questions, the junk patterns and the retention bar —
lives in one place: `docs/development/testing.md` §0 (ruling 512). Read it before adding,
changing or deleting a test. This skill is the workflow around it. Adapted from OpenClaw's
`test-audit` skill (MIT; `THIRD_PARTY_NOTICES.md`).

## Authoring mode

1. Answer testing.md §0's four questions in the test's own comment where they are not
   obvious: the contract, the edit that breaks it (a `CANARY:` line), why nothing already
   catches it, and that it needs no seam only a test calls.
2. Put it at the owner boundary §0 names, as a row of an existing table when one fits.
3. A bug's regression test fails on the pre-fix code for the intended reason. Prove it:
   revert the fix, watch the test go red, restore the fix. Once, at the owner.

## Audit mode

**Discovery is read-only.** Read `AGENTS.md`, testing.md and the ruling a test cites
before judging it. For a broad sweep, split the tests into lanes along production owner
boundaries (not file prefixes) and give each lane its own read-only reader; a cheap first
pass is a census of production exports that only tests import, and of tests that
`readFileSync` a `.ts`/`.tsx`/`.css` file. Prefer a few high-confidence candidates to a
large speculative inventory. Judge a test by its assertions, not its name.

**Candidate evidence.** Record, before editing:

- the test's exact name and `file:line`;
- the failure it can actually detect;
- the non-test callers of the seam it covers;
- the stronger owner-boundary proof that remains (`file:line`), or why none is needed;
- its history (`git log -S`, the ruling it cites) and why it exists;
- the production or test-support code the deletion unlocks;
- the risk and the focused command that validates the edit.

A candidate missing a field is not ready. A retained test that fails on the baseline is a
product bug until shown otherwise: reproduce it and repair the owner.

**Marks.** `D` delete (name the proof that stays), `C` consolidate (name the keeper that
absorbs it), `F` keep the contract but fix the assertion, `S` remove a test-only seam (name
where the test moves), `B` possible product bug. Record a product discrepancy the sweep
finds as a follow-up rather than fixing it inside the audit.

## Campaign mode

For one owner's whole surface: record a baseline (every file's pass/fail at a pinned
commit), mark every declaration, then do a second read-only pass for the redundant
**layer** — the same contract proven in the server suite, the route suite and the
component suite — and name the keeper per contract. Edit lane by lane; serialize changes
to shared harnesses through one owner. Before claiming completion, have someone compare
the deleted coverage against the keepers, and for each restored contract make one
deliberate mutation of the production owner and confirm the keeper goes red.

## Edit shape

One coherent owner-boundary batch per commit. Delete obsolete `*ForTests` hooks, exported
internals and dead production paths instead of keeping aliases. Move a retained regression
to its owner's suite. Fold duplicated setup into one helper in the same change. Prefer
net-negative production LOC; never add a replacement test that restates the
implementation you removed, and never convert an uncertain candidate into a deletion.

## Validation

Never edit source or tests while Vitest runs in the checkout, and never touch
`node_modules` while it runs.

1. The owner and its siblings: `npx vitest run <paths>`. Under load a whole file can fail
   on a hook timeout; rerun just those files with `--no-file-parallelism` before
   concluding anything.
2. For a removed source or doc pin, run what owns the real contract: the route, the seed,
   `npm run build && node scripts/measure-routes.mjs --check`, or `npm run e2e`.
3. `npm run lint && npm run typecheck && npm test`, then `git diff --check`.
4. `git diff --numstat`: report production and tooling lines apart from test and
   test-support lines.
5. Review the finished diff (`/code-review`) before it lands.

## Handoff

Report the removed low-value categories, the production seams deleted, the false
positives kept and why, the proof actually run, production versus test LOC, and the
follow-ups named but not done.
