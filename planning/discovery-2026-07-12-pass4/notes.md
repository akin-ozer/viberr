# Pass 4 — running discovery notes

Branch: `full-pass-2026-07-12` from main@bdcce97.

## Environment facts
- TS 7.0.2 (native), RR 8.2, Vite 8.1 (Rolldown), Vitest 4.1.10, Node >=26, better-auth 1.6.23.
- Dev server: `npm run dev` on :5173 (launch.json `viberr-dev`).

## UI walkthrough notes (2026-07-12, dev server :5173, logged in as Arda/admin)

Pages visited + screenshots taken: home, viberr-core board, VIB-151 task detail (full scroll),
review queue, agents (profiles), policy, github, activity, settings, org settings (users,
resources), notifications panel, new-task modal, selftest-4 board, profile.

Working well (verified live):
- Home dashboard: pinned/other projects, run counts, decisions-waiting rollup, grid/list toggle.
- Board: 5 stages, filters (waiting on me / agent working / needs attention), agent chips,
  branch + PR badges, per-card waiting markers. Re-scan button present.
- Task detail: live run panel with SSE elapsed ticking (verified live), execution profile
  (operator + primary specialist + reviewers + human owner), permissions rail (role-aware,
  matches ACTION_ROLES), agent logs console (stream-json transcript view with follow),
  timeline with All/Important/Comments filters, @-mention comment box.
- Review queue: acceptance section vs "still with agents", human-only boundary copy.
- Agents page: Profiles/Live/Capability-matrix tabs, stat tiles, eligible-stage chips,
  capability tri-state summary (direct/recommend/human).
- Policy: two-surface layout (human RBAC pills per member + 13-row action matrix rendered
  from shared source; agent capability panel + ALWAYS_HUMAN list).
- GitHub page: repo, credential health ("no credential" on seed project), PR list linked to
  tasks, execution branches table, reconcile.
- Activity: stream (32 events) + audit log rail, All/Humans/Agents/System filters.
- Settings: name/prefix/description, stage list with locked Triage/Done + drag reorder,
  members, repo & credentials (task-level override toggle).
- Org settings: users & access (domain allowlist + 5 local accounts, org role pills),
  agent resources (3 KBs with store:// URIs + rescan dates, skills, global profiles).
- Notifications: 38 unread, packet/run-failure items deep-linking into tasks; mark-all-read.
- Profile: memberships w/ roles, "Your access" checklist (13 rows, admin = all), notification
  routing toggles.
- New-task modal: title required (inline error), stage picker Triage/Ready/In Progress/Review
  (no Done — correct), goal hint about triage quality gate.

Observations / candidate findings:
- N1: Seeded Viberr Core has 3 eternal "running" runs (VIB-151 elapsed 1:15+ but 0 turns /
  0 tokens; runtime label claude-sonnet-4-5). Home says "3 runs active" forever. Deliberate
  demo staging per prior passes, but as a product surface it reads as stale/false state.
  → Q for owner: keep eternal seeded runs, or seed them as completed with history?
- N2: No MCP servers configured at org level ("No MCP servers yet"). MCP test cases will need
  one added — good exercise of the Add flow.
- N3: Codex quota exhausted (VSF-27/28 notifications from pass 3) — Codex live runs will fail
  at the SDK; parity testing must focus on viberr-side handling (assignment, capability
  labels, failure packets), which actually exercises the failure path well.
- N4: Selftest 4 board: 29 tasks, all "waiting on you" — pass-3 leftovers. Will create a fresh
  selftest-5 project for pass-4 testing (owner said new project).
- N5: /projects (bare) 404s — only / lists projects. Error page is themed (F3 fix visible).
  Minor: should /projects redirect to /?
- N6: Scrolling task detail needs inner-container scroll (div.detail) — mouse-wheel scroll on
  page body does nothing on task page. Check if this is intentional layout or a UX bug (wheel
  over the header/rail area feels dead). LOW.
- N7: VIB-151 live-run panel shows "2 agents running" chip while execution profile shows
  Developer running + Reviewer running (Codex). Consistent. OK.
- N8: Home greeting rollup counts only projects with active runs ("across 1 project") while
  decisions span projects — copy is fine.

- N9: New-project modal: name+prefix, GitHub owner/repo binding (optional → repo-less), workflow
  template (Standard 5 / Lightweight 3), agent policy preset (Strict human-gate / Balanced /
  Autonomous within policy). "No GitHub connections yet" warning — org connection list empty.
- N10: Selftest 4 GitHub page: "No credential configured" BUT 5 real PRs linked (#11-#16, #12
  merged). Pass-3 delivery = agent-side ambient gh auth; accept → "merge pending" without PAT.
  Pass-4 live sweep will use the same pattern; I merge/close via host gh.
- N11: Agents page "Live" tab not URL-addressable (?view=live ignored) — tab state is
  client-only. LOW/polish.

## Questions for owner
(populated as they come up)

## Improvement notes
(populated as they come up)
