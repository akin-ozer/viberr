# Viberr full-product pass — documentation index (2026-07-10 → 2026-07-11)

The docs from a full discovery → critical-questions → 20+ task testing → implementation → verification
pass. Everything is **implemented, tested (1029 green), and current** unless a doc's own banner says
"historical". Read in this order.

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

## Outcome
All findings + decisions implemented; nothing deferred except **codex tool confinement (S3)**, which
the owner scoped to the upcoming role-bindings phase. Git: PRs #1/#2 merged to `main`; PR #3 open with
the remainder. 1029 tests pass, typecheck clean, seed pristine.
