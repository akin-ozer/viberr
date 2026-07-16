# Discovery pass 6 — 2026-07-16

Working base: **main @ 81dafe3** (owner ruling 2026-07-16: the unmerged
`codex/e2e-product-hardening-2026-07-13` branch is reference-only). Dev DB restored from
`data/state/projection.pre-baseline-20260715-2320.sqlite`; the codex-branch baselined DB is
preserved at `data/state/projection.baselined-codex-20260716.sqlite.bak`.

Read order for implementation subagents:

| Doc | What it is | Trust level |
| --- | --- | --- |
| `canon.md` | Product canon distilled from all prior passes: rulings ledger, RBAC as ruled, deferred backlog, per-pass fix history, contradictions | High (sourced from owner-rulings docs) |
| `original-intent.md` | PRD + mock intent, feature/screen inventory, aspirational-only areas | High for intent; canon overrides it |
| `architecture.md` | Code-derived map: routes, server modules, DB schema, agent lifecycle, docker/compose, suspicious/unwired list | High (code-cited); spot-checked |
| `ui-walkthrough.md` | What every page actually renders on main today (screenshotted in-session) | High (observed) |
| `findings.md` | THE ledger for this pass — every defect/question with ID, severity, status | Living doc — keep statuses current |
| `test-catalog.md` | Phase-2 live test cases (≥20) with per-case results | Living doc (written during phase 2) |

House rules for this pass (from the owner's goal statement):
- No security deep-dives; role bindings WILL be reworked.
- Live testing: create a NEW project bound to https://github.com/akin-ozer/viberr; PRs only
  against that project; `gh` may merge/reject PRs to exercise both paths; merged test files
  must stay tiny (no bloat).
- Implementation phase: no deferrals, no migrations/backwards-compat requirements (breaking
  allowed & encouraged, tests may be rewritten), every findings/ledger item closed or
  explicitly ruled, validation by code + UI screenshots + browser usage.
