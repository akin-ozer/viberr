# Discovery pass 2 — 2026-07-11/12 (session 2) — COMPLETE

Fresh full-product pass on top of the merged 2026-07-10 pass (see ../discovery-2026-07-10/ for
architecture reference `app-reference.md` + product intent `product-intent.md` — still current).
**Status: everything found in this pass is implemented and validated.** PR #7
(`viberr-selftest-implementation`, 21 commits) is green/mergeable; **1130 tests**, typecheck clean.

## Docs in this folder (read order)
- **FINAL-REPORT.md** — the one self-contained record of all three phases (discovery → 22-case live
  testing → implementation) with evidence pointers. Start here.
- **findings-v2.md** — THE consolidated backlog: ~55 deduped findings (A runtime state machine,
  B GitHub, C lifecycle, D role bindings, E store, F adapters, G UI/copy, X live) + 8 owner rulings
  (Q1–Q8). All implemented except the owner-scoped role-bindings deferrals (see below).
- **implementation-ledger.md** — finding → landing map, incl. the three post-PR hardening waves
  (16 adversarial fixes, 2 CI fixes, 19 fresh current-state findings).
- **current-state-findings.md** — the post-implementation 6-reader sweep: 19 net-new findings
  (1 HIGH KB-injection, 7 MED seed-fabrication/dead-end, 11 LOW honesty) — **all closed**.
- **role-bindings-map.md** — the two-system authorization map + rework plan. Feeds the dedicated
  role-bindings phase (**in progress as of 2026-07-12 in a separate session**). Read its
  "Updates since this map" addendum first — several rows changed post-map.
- **ui-walkthrough-notes.md** — page-by-page live walkthrough notes (this pass).
- **test-plan-v2.md** / **test-results-v2.md** — the 25-case campaign on the first selftest project
  (real PRs #4 merged, #5/#6 closed).
- **live-revalidation.md** — the 21-case in-window re-validation on selftest-2 (PR #8 merged,
  #9 closed) validating the implemented fixes against real backends.

## Method
7 parallel very-thorough code audits (subsystem each) + full UI walkthrough with screenshots +
cross-verification by direct file reads; then live campaigns with real Claude + Codex backends and a
real PR lifecycle on akin-ozer/viberr (merged: #4/#8/#10 · closed: #5/#6/#9); then an adversarial
multi-agent review of the diff; then a fresh 6-reader sweep of the post-implementation tree.
Security explicitly deprioritized by owner (S3 codex confinement stays documented-only).

## Owner decisions made this pass
Q1 acceptance requires explicit `direct` · Q2 owner-or-maintainer packet resolve · Q3 real guardrails ·
Q4 prune+wire capabilities · Q6 membership-scoped Home · Q7 full workspace isolation · Q8 codex idle
timeout · **honest empty slate** (seed ships no fabricated credentials/MCP health) · LOW-nit cleanup.
Open: **Q5** contributor-vs-viewer split → the role-bindings phase.
