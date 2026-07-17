# Live discovery notes — pass 8 (2026-07-17)

Working base: main @ 8041134 (PR #34 agent-loop-hardening merged today). Data root hand-created
by owner: projects `viberr` (akin-ozer/viberr, VIB-1..5) + `playground` (PLG-1..6). Both backends
report **real** (claude OAuth token; codex via personal ~/.codex auth.json — may hit quota).

## User / role topology (for RBAC tests)
| user | email | org | viberr proj | playground proj |
|---|---|---|---|---|
| Arda Kaya | arda@viberr.dev | admin | admin | (none) |
| Elif Demir | elif@viberr.dev | member | maintainer | (none) |
| Murat Can | murat@viberr.dev | member | contributor | admin |
| Selin Ak | selin@viberr.dev | member | viewer | (none) |
| Deniz Yel | deniz@viberr.dev | member | contributor | (none) |
Password (all): `viberr-dev-2828`. Arda = D2 override test (org-admin, non-member of playground).

## Environment note (parity concern)
- CODEX_HOME=/Users/akinozer/.codex — the owner's REAL personal codex home. README warns a dedicated
  codex-home should be used to avoid importing personal config.toml / MCP servers / skills into runs.
  Locally this means codex runs may load personal skills/MCPs → test whether viberr isolates codex
  skill/MCP loading or leaks the host setup. (Deliberate local-dev choice; note, don't "fix" blindly.)

---

## Surface walkthrough (screenshots + observations)

### Home / FleetView (Arda, admin)
- "0 runs active across 0 projects, **5 decisions waiting on you**." Cards: Playground "2 waiting on you",
  viberr "3 waiting on you". ⇒ VERIFY these are genuinely open, not stale (F7-NOTIF1 was marked fixed pass7).
- Settings cards: GitHub connections (1: akin-ozer), Users & Access (5 users, 1 admin/4 members),
  Agent Resources (3 global agents · 1 KB · 1 MCP · 1 skills). Re-scan + Rebuild projections at bottom.
- Design polish evident (rounded cards, avatars, progress bars per project).

## Findings log (this pass) — will triage into findings.md
(none yet)
