# Fresh discovery pass — UI walkthrough notes (2026-07-11, session 2)

Live server: dev on :61547 (stale 5173 instance killed — NOTE: nothing prevents two dev servers
sharing one data root; the operator lease atomicity assumes single process. Candidate finding:
boot-time "another instance?" guard or PID lockfile.)

Seed state at start: 3 projects (DEP 1 task, VIB 10 tasks, BIL 1 task), both backends real.

## Home `/`
- ✅ Renders per design: greeting, pinned grid, everything-else, New project.
- 🐛 Copy: "3 runs active across **1 projects**" — no pluralization ("1 projects").
- ✅ "3 runs active" = the 4 seeded simulated `run_seed_*` rows (VIB-151 ×2, VIB-145, VIB-153)
  → intentional demo state, not stale.

## Board `…/board`
- ✅ 5 stages, cards (key/badges/branch/PR/agent chip), Re-scan, New task.
- ✅ Filter chips REALLY filter (Agent working → 3 tasks, column counts update).
- Sidebar counts (Board 10, Review queue 2, Settings 1) all correct.

## Task workspace `…/tasks/VIB-142`
- ✅ Packet dominates (Completion report, observations, 3 options, Accept completion / Ask operator).
- ✅ Execution profile (operator backend+autonomy+run, primary+Run, reviewers+Run/remove, owner).
- ✅ Agent logs panel (session header, typed rows, "thread alive"), Timeline filters, composer.
- 🐛 UX: page scroll lives on `div.detail` (body overflow:hidden) — PageDown/space/keyboard
  scrolling does nothing anywhere on the page. Same pattern class as the fixed org-settings bug.
- ❓ Product: a **Done** task (VIB-139) still renders active "Run operator" + "Assign specialist"
  controls. Should terminal tasks offer runtime actions?

## Review queue
- ✅ Two-section split, honest human-only footnote, task rows with pills.

## Agents page
- ✅ 3 profiles (D1 roster), stat tiles, Live table (14 rows, engagement/status pills), matrix modal.
- ❓ Stat tile "6 operators running · one per active task" counts ACTIVE TASKS, not running operator
  runs (0 at the time). "Specialists working right now: 3" counts tasks-with-running-agents. Tiles
  read as live run counts but are attachment counts — dishonest-ish copy.
- 🐛 Capability matrix modal: "Read the task & repository" + "Comment on the task" render "not
  granted" (grey) for Operator AND Developer — at runtime both read and comment ungated. The matrix
  displays grants that don't drive behavior (see role-bindings map — 21/32 dead capability ids).

## Policy page
- ✅ Human RBAC (4 members, role segments, action matrix) + Agent capability rail + ALWAYS-HUMAN
  list + Capability matrix / Manage profiles buttons.

## GitHub page
- ✅ Repo card, PAT card w/ scope chips + missing-scope warning wired to VIB-142, PRs (4) w/ pills,
  human-merge footnote.
- ❓ Contradiction: Connection pill says "**no credential**" while a PAT card with scopes renders
  directly beneath it. (Seed's honest-placeholder state #18 — but the two surfaces disagree.)

## Activity page
- ✅ Stream day-grouped + All/Humans/Agents/System filters; audit rail.
- ❓ Audit rows reference VIB-169 (task no longer exists — audit is app-owned, survives seed reset).
  Links to dead tasks → 404s. Decide: keep (honest history) or annotate "task deleted".

## Settings page
- ✅ Identity, stages editor (lock icons on Triage/Done), members, repo & credentials, danger zone.

## Org settings (resources tab)
- ✅ KBs w/ doc counts, MCP registry, disk-truth skills, global profiles.
- ⚠️ Seeded MCP rows point at fictional `mcp.internal` hosts with fake "checked Xm ago · N tools"
  metadata. If a profile references one, real Claude runs get a dead MCP endpoint injected.
  TEST IN PHASE 2.

## Notifications overlay
- ✅ 6 unread, typed icons, cross-project items (DEP-31), Mark all read, See all.

## Tooling note (not app bug)
- Browser-pane wheel/PageDown scrolling can't reach `div.detail`; JS scroll works. Click coords:
  ref-based clicks use viewport space (1280×720) while screenshots are 800×450 — use refs.
