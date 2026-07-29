# Pass 15 — phase evidence index

Every phase of this pass, with artifacts you can open and verify.

## 1. Discovery — code inspection + documentation
- **10 code maps + a completeness critic**, written by parallel subagents in their own contexts so
  they are usable as implementation references: `docs/workflow-core.md`, `docs/operator.md`,
  `docs/agents-runtimes.md`, `docs/github-credentials.md`, `docs/foundation.md`, `docs/ui-routes.md`,
  `docs/product-intent.md`, then a gap-fill round after the critic named what nobody had covered:
  `docs/interpretation-decisions.md`, `docs/run-pipeline.md`, `docs/guardrails-audit.md`,
  `docs/CRITIC.md`. **1,442 lines**, every claim carrying `path:line`.
- **Product intent reconstructed** from `planning/planning-artifacts/` (PRD + architecture + UX spec),
  `design/`, and passes 13–14 — including which changes were deliberate rulings vs drift.
- **UI walkthrough**: every page and dialog, **111 screenshots** in `shots/`.

## 2. Live use — 34 use cases on a real instance
`USECASES.md` (table + chronological ledger). Built on a fresh compose instance:
3 projects, 13 tasks, 4 users, a knowledge base authored in-app, a real stdio MCP server
(2 tools, discovered by handshake) plus a deliberately dead HTTP one, 2 new agent profiles,
2 skills. GitHub exercised for real: **PRs #109–#118**, merged in-app and out-of-band via `gh`,
closed/rejected, a branch-name collision staged on purpose.

## 3. Findings + rulings
`NOTES.md` (raw observations) → `FINDINGS.md` (**23 live findings**: F15-01..19 from the live phase,
F15-21 ledgered late from UC-19, and F15-20/22/23 found while live-proving my own fixes — plus ~35
promoted code-map items and 5 doc items, each with a status and the commit that closed it).
**8 owner rulings** R15-1..8 answered in two question rounds, recorded in FINDINGS §D,
`docs/architecture/decisions.md` 20–27, and PRD FR4/FR27/FR31/FR37.

## 4. Implementation
`PLAN.md` (workstreams + the binding W1 design). Three waves: the delivery re-architecture,
five feature streams, four gap-repair streams — each stream followed by an adversarial verifier
that had to revert fixes and report the failure output. **20 commits**, PR #119.

## 5. Validation
Gates green at every step (final: typecheck clean · **2,421 unit tests / 206 files** · build ·
**25 e2e** incl. WCAG in both themes). Container rebuilt and every original repro re-run live —
see the two verification sections at the end of `USECASES.md`.

The ledger was audited **in both directions**, which is the part worth copying:
- **ledger → diff** (during the pass): every row id grepped against `git diff main..HEAD`, every
  zero hand-checked. Proves no row lies about being fixed. Six showed zero; all six resolved.
- **diff → ledger** (`FINDINGS.md` §F, run last, after the branch was already "done"): every
  changed non-test file checked for *any* row citing a commit that touched it, plus every cited
  hash validated as a real commit on this branch. Proves the ledger is **complete**, which the
  first direction is structurally blind to. It found six drifts in the evidence trail and zero in
  the product — two wrong commit citations, a missing hash, and three real fixes that had shipped
  with no row at all.
