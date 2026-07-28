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
`NOTES.md` (raw observations) → `FINDINGS.md` (19 live findings F15-01..19 + ~35 promoted
code-map items + 5 doc items, each with a status and the commit that closed it).
**8 owner rulings** R15-1..8 answered in two question rounds, recorded in FINDINGS §D,
`docs/architecture/decisions.md` 20–27, and PRD FR4/FR27/FR31/FR37.

## 4. Implementation
`PLAN.md` (workstreams + the binding W1 design). Three waves: the delivery re-architecture,
five feature streams, four gap-repair streams — each stream followed by an adversarial verifier
that had to revert fixes and report the failure output. 17 commits, PR #119.

## 5. Validation
Gates green at every step (final: typecheck · **2,419 unit tests** · build · **25 e2e** incl. WCAG
in both themes). Every ledger id audited against the diff individually. Container rebuilt and
every original repro re-run live — see the two verification sections at the end of `USECASES.md`.
