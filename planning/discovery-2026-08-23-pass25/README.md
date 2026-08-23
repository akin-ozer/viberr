# Pass 25 discovery — index (2026-08-23)

Full product pass on post-pass-24 Viberr (`main` 7cf113a → merged as `6cff122`). Branch `fix/pass25-discovery`.
This folder is the durable discovery + implementation record; the docs below are meant to be read by
implementation-phase agents with no other context.

## How the app works (current state)
- **[APP-STATE-REFERENCE.md](APP-STATE-REFERENCE.md)** — architecture "how it actually works" map, 11 subsystems
  with `file:line` pointers + load-bearing invariants (stack, file-native store + projections, task lifecycle,
  operator, specialist runs + P8 isolation, capability/RBAC, backends, GitHub delivery, resources, auth/org/
  notifications/audit, test/build/lint/container). Includes a "Corrections to working assumptions" appendix.
- **[UI-WALKTHROUGH.md](UI-WALKTHROUGH.md)** — page-by-page current-state UI documentation (home, board,
  task-detail, policy, agents, capability matrix, review queue, activity, GitHub, instance settings ×4 tabs,
  notifications, search, profile, login), screenshotted live this pass.

## What was tested (use cases)
- **[USE-CASES-LIVE.md](USE-CASES-LIVE.md)** — 22+ verified live use cases. Highlights: full lifecycle →
  **real PR #203 merged**; reject via `gh` → **PR #204 rejected** → reconcile → recovery packet; operator
  agent-selection; Codex quota-fail → graceful recovery; RBAC; browser cap; skills scoping; KB authoring;
  MCP honest disclosure; search; notifications; Strict-vs-Balanced autonomy.

## What was fixed (bugs — all merged in PR #205, commit 6cff122)
- **[FINDINGS.md](FINDINGS.md)** — my own findings + verification verdicts (F25-1/2/3, F-P1..P11 verified).
- **[PARITY-CAPABILITY-AUDIT.md](PARITY-CAPABILITY-AUDIT.md)** — the deep Codex/Claude parity + capability-
  display audit (11 findings, all verified).
- **[BACKLOG-RECONCILE.md](BACKLOG-RECONCILE.md)** — pass-23 backlog reconciled against current code (fixed/open).
- **[FRESH-HONESTY-AUDIT.md](FRESH-HONESTY-AUDIT.md)** — the honesty/silent-drop audit of pass-24's own diff.
- **[IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)** — the prioritized fix plan + the END-OF-PASS STATUS
  (what was implemented+tested, what was already-fixed-on-main, what's recorded-not-implemented with rationale)
  + the ADVERSARIAL REVIEW findings (2 more P8 regressions fixed, 1 documented).

## What to build next (product gaps — need owner direction)
- **[AREAS-TO-IMPROVE.md](AREAS-TO-IMPROVE.md)** — product/feature/UX gaps (4 HIGH, 9 MEDIUM, 6 LOW),
  deliberate-vs-genuine distinguished, + **7 owner questions** (analytics slice, audit export, run-concurrency
  cap, test/validation depth, task metadata, per-profile cost telemetry, ops alerting). HIGH gaps: no analytics/
  throughput/cost surface (data exists), no audit-export (vs 90-day retention), no run-concurrency cap, no agent
  success-rate signal. These are Phase-2/3-scoped — the questions ask which to pull forward.

## Outcome
Bugs: ~17 fixes incl. 2 HIGH (P8 per-engagement workspace isolation, P9 shared MCP health row) → **PR #205
merged**, container rebuilt from merged main + live-validated (F25-1/F-P1/F-P2/F-P4 confirmed on real data).
Suite 4303 green, tsc clean, oxlint 0-new. Owner rulings: P8 = full isolation; B2 = leave. Product gaps →
7 owner questions above.
