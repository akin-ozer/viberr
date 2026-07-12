# Viberr full-product pass — documentation index (2026-07-10 → 2026-07-11)

The docs from a full discovery → critical-questions → 20+ task testing → implementation → verification
pass. Everything is **implemented, tested, and current** unless a doc's own banner says "historical".
Read in this order. **A second full pass (2026-07-11/12) builds on this one — see
`../discovery-2026-07-11/` (start at its FINAL-REPORT.md); the suite is now 1130 green on PR #7.**

## Current / authoritative
- **`app-reference.md`** — the live architecture, data model, routes, agent runtime. Current as of
  2026-07-11 post-implementation (roster = operator/developer/reviewer, `pr.state` incl. "accepted",
  runtime isolation, delivery reconciliation, all lifecycle behaviors).
- **`product-intent.md`** — PRD distillate + banned-copy rules + the resolved product decisions.
- **`completeness-ledger.md`** — THE finding→fix map: every one of the 37 backlog findings + 9
  decisions + S1/S2/S3 + H1–H4 + the verdict bug, mapped to where it landed and how it was verified.
- **`test-catalog.md`** — THE test→finding map: 30 designed test cases across every dimension, each
  with rationale / method / expected / observed / the improvement it surfaced (→ fix).
- **`test-sweep-committed-2026-07-11.md`** — raw live-run evidence on the committed build.
- **`shipped-build-ui-walkthrough.md`** — page-by-page UI QA + the S1/S2/S3 critical findings.
- **`sweep-design-decisions.md`** — the D1–D4 decisions and their implementation/verification.
- **`findings.md`** — the ranked 37-finding backlog (status cells are discovery-time; see the top
  banner — all resolved, ledger is authoritative).

## Historical (superseded; banners inside)
- **`notes.md`** — raw first-pass scratch notes.
- **`test-plan.md`** — the original 42-case plan (pre-implementation).
- **`test-results.md`** — phase-3 results, PRE-D1–D4 (some rows no longer match the build).
- **`test-sweep-results.md`** — the Test Harbor 22-task sweep, PRE-D1–D4 (partially superseded).
- **`phase4-progress.md`** — the phase-4 implementation log (work continued past it).

## Outcome (updated 2026-07-12)
All findings + decisions from THIS pass implemented; nothing deferred except **codex tool confinement
(S3)**, scoped to the role-bindings phase. Git: PRs #1/#2/#3 merged to `main`.

**Since then (pass 2, `../discovery-2026-07-11/`):** a second full discovery→testing→implementation
cycle landed on PR #7 (`viberr-selftest-implementation`, 21 commits, CI green, mergeable) — ~55 more
findings + 8 owner rulings + 16 adversarial-review fixes + 2 CI fixes + 19 current-state findings
(incl. the **honest-empty-slate** seed ruling: 0 fabricated MCP/connections/PATs; and the KB
recursive-injection HIGH fix). **1130 tests pass.**

**Pass 3 (`../discovery-2026-07-12/`) — ✅ COMPLETE (2026-07-12, PR #14, 1156 tests):** the dedicated
**role-bindings rework** shipped — D2/D5 matrix-as-source (`app/shared/rbac.ts`), guard consolidation,
capability prune (30→26), full D9 SSE membership, review/activity gating, **Q5 → clean tiering**, S3
honest labeling — plus all 13 fresh findings resolved (incl. **F11 HIGH**, the `edit-other-task-branch`
deny that had blocked ALL Claude delivery) and two adversarial review rounds (manual + a 25-agent
verified Workflow) that caught 9 more defects the tests missed. Start at
`../discovery-2026-07-12/implementation-ledger.md`; the `app-reference.md` + `product-intent.md` in
THIS folder carry pass-3 update banners.
