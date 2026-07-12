# Pass 4 — discovery → live testing → implementation (2026-07-12, second run of the day)

Fourth full-product pass, started fresh from `main` (bdcce97) on branch `full-pass-2026-07-12`.
Base state: pass 3 (PR #14) merged + TS 7.0.2 / RR 8.2 / Vite 8.1 / Node 26 upgrade + F8 ctx fix.

Scope per owner goal:
- Discover current app state (code + docs + live UI with screenshots); be critical — deliberate
  changes are usually intended (see prior owner rulings) but not always; ask when unsure.
- No security focus. Role bindings WILL be touched this pass.
- Build reference docs good enough for implementation subagents from other contexts.
- Live sweep: new project for github.com/akin-ozer/viberr, 20+ task test cases (assignments, stage
  transitions, reviewers, secondary assignments, comments, RBAC, operator behavior, agent behavior,
  MCP, skill isolation, Codex-vs-Claude parity), real PR open/merge/close via gh.
- Then implement EVERYTHING found, end to end, validated by code + UI screenshots + browser usage.
  No deferrals, no migrations/backcompat needed, tests may be reworked.

## Docs in this folder
- `prior-canon.md` — condensed canon from passes 1–3 (intent, invariants, rulings, shipped state).
- `app-map.md` — verified-current architecture map (routes, server, operator, RBAC as coded).
- `code-gaps.md` — mocks / unwired / dead / poorly-implemented sweep with file:line evidence.
- `notes.md` — my running discovery notes (UI walkthrough, findings, questions for owner).
- `findings-v4.md` — numbered findings once discovery settles.
- `test-plan-v4.md` / `test-results-v4.md` — the live sweep.
- `implementation-ledger.md` — finding → fix → validation map for the implementation phase.
