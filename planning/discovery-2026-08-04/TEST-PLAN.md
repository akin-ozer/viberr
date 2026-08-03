# Live test plan — pass 16 (2026-08-04)

Use cases executed against the running app. PR-producing cases run ONLY on the Viberr project
(akin-ozer/viberr); merges limited to tiny test files under qa/smoke/. Non-PR cases may use a second
scratch project. Each case records: steps, expected, observed, verdict (PASS/FAIL/finding-ref).

## Executed

- UC-1 ✅ PASS — Full governed loop: create task (Triage) → operator triage check → auto Triage→Ready→In Progress
  → operator deploys Developer (Codex) → blocked packet (Codex credential) → human resolves (retry same backend)
  → Codex commits, no push (workspace contract) → branch-collision blocked packet (stale vib-1 + merged PR #109)
  → human picks "delete stale branch, then deliver" → operator deletes remote branch, pushes, opens PR #123
  → engage Reviewer (Claude) → approve verdict bound to revision+headSha → operator recommends Review transition
  → human applies → operator recommends acceptance → human applies → PR #123 merged, branch deleted, task Done·merged.
  Findings: D1 (dev CODEX_HOME), PR-body relative task link, "merged" badge while packet disowns adopted PR (display),
  H3 resolved (diff/branch came from adopted stale PR then replaced by real delivery).

## Queue — governance & RBAC

- UC-2 Second user + roles: create local users (Maintainer, Contributor, Viewer) via org settings; verify board
  affordances per role match the Policy matrix (create task, approve transition, run agents, accept completion,
  manage members). Check RBAC-honesty (disabled vs hidden) and the E1/E2/E3 findings live.
- UC-3 Task ownership: contributor takes ownership; verify owner-acceptance authority on their own task
  (accept from queue) while non-owner contributor cannot; admin releases any owner.
- UC-4 Viewer limits: viewer can read board/task + comment only; verify no run/transition/accept affordances,
  and server denial on direct POST.
- UC-5 Non-member access: second project marked members-only; non-member registered user gets 404 on task/policy
  routes (and note the 403-vs-404 asymmetry E2 live).
- UC-6 Stage transition boundaries: flip Ready→In Progress rule to "Human approval"; verify operator now
  RECOMMENDS instead of auto-advancing, and a maintainer can apply while a contributor cannot (approve-transition).
- UC-7 Force-accept override: on a task with no verdict, verify admin-only Force accept works, is audited,
  and respects the PR-head gate (A2 check — attempt with stale head).
- UC-8 Workflow editing: add a stage (e.g. "QA") mid-flow, rename it, drag-reorder; verify transition-chain rewiring
  copy matches behavior and agent stage-eligibility strikethroughs update.

## Queue — operator behavior

- UC-9 Underspecified goal: create task with vague goal ("make it better"); operator should flag at triage
  (input_required) instead of advancing; then edit goal and verify it proceeds.
- UC-10 @operator comment: human comments "@operator <question/instruction>"; verify queued trigger drains,
  operator answers via comment AND @tags the human (NEW-4), notification lands (bell + notifications page).
- UC-11 Ask-human packet from agent: prompt a specialist whose instructions force a question; verify ask_human
  packet pauses (Claude mid-run), resume-on-answer (R15-14 askedBy), and the packet UX.
- UC-12 Scheduled re-run: schedule operator re-run (5 min, Codex backend, Supervised); verify it fires, backend
  override respected, and the schedule row lifecycle.
- UC-13 Full autonomy: set operator autonomy Full on a task; with explicit accept grant absent, verify it still
  stops at acceptance (recommend), per policy copy; then examine the "operator at full autonomy + explicit grant"
  path config surface (G5 owner question context).
- UC-14 Interrupt: interrupt a live run; verify run state, timeline event, and recovery (re-run resumes cleanly).
- UC-15 Merged-PR-reuse guard again (regression of UC-1's collision): create another task whose old branch exists
  remotely WITHOUT a merged PR (e.g. vib-2 stale branch, PR closed-unmerged or none) → expect divergence/collision
  packet variant; exercise "assign different branch name" option this time. (Also covers G2 refusal-precedence.)

## Queue — agents, resources, parity

- UC-16 KB grant: grant "Viberr conventions" KB to Developer (project deployment level); run a task asking the
  agent to cite its KB; verify KB content reached the prompt (echo in log) and doc-count/freshness UI.
- UC-17 MCP grant + parity: grant "everything" MCP to Developer (Codex) and Reviewer (Claude); task instructs agent
  to call a known tool (e.g. echo/add) — verify Claude tool id `mcp__everything__*` vs Codex underscore renaming,
  tool actually invoked in logs, and creds-not-sent-to-Codex behavior.
- UC-18 Skills isolation: instruct Developer to list its loaded skills; verify ONLY granted skill (developer-expertise)
  + no host-leaked skills on both backends (C7). Also verify skill file edit propagates (store watcher, "updated" stamp).
- UC-19 Claude-vs-Codex same task shape: run two sibling doc-only tasks, one Developer=Codex, one Developer-Claude
  clone; compare: envelope/report posting, mid-run comments (Claude only), branch/commit/PR flow identical server-side.
- UC-20 New specialist profile: create a third profile (e.g. "Docs writer", Claude, stages Ready+In Progress,
  no delivery grant); verify capability matrix reflects it, operator can deploy it as supporting (non-delivering,
  read-only), and its runs cannot deliver (server gate).
- UC-21 Add from library: open the template library, add a profile from it, inspect what it seeds.
- UC-22 Conversational agent: @tag a specialist in comments with a question (no run); verify conversational reply
  path and that the reply @tags the human + notifies.

## Queue — collaboration & UX surfaces

- UC-23 Mentions composer: type @ in comment box; verify mention menu (people + agents + operator), plain-text
  persistence, chips render for known names only (F20 check on typed events), ⌘↵ send.
- UC-24 Notifications: verify bell badge counts, notifications page (grouping, mark-read), and that packet-waiting
  notifications deep-link correctly.
- UC-25 ⌘K palette: search tasks/projects/actions; keyboard nav; check the touch/AT findings (F5, G3) live.
- UC-26 Board interactions: drag card between stages (server-authoritative move + DropPreview), StageMenu keyboard
  path, filters (Waiting on me / Agent working / Needs attention), free-text filter, List view parity.
- UC-27 Home dashboard: verify greeting status line reflects live runs/decisions; project card counters; star/favorite;
  Archived section after archiving scratch project.
- UC-28 Task archive + restore: archive a task mid-flow; verify board/queue removal, timeline preservation, restore.
- UC-29 GitHub page live state: branches table with live task branch, PR list linking, Update status re-sync,
  divergence surfacing after an external push to the task branch (gh push a commit) — pr-diverged trigger + packet.
- UC-30 Reject path: on a delivered PR, reviewer verdict request-changes → verify acceptance stays blocked, operator
  routes rework to Developer, new revision re-mints, THEN close the PR unmerged via gh → verify UI reflects
  closed-unmerged honestly (G2) and operator recovery packet appears.

## Cross-cutting checks (fold into cases above)

- Audit log completeness for every human/agent action; actor attribution.
- Copy/plural/timestamp issues (F12, F19-class) wherever seen.
- Toasts for every mutation; SSE revalidation freshness (no manual reload needed).
- Cost lines per run; token counts sane.
- data-root hygiene: no writes outside docker-data; single-writer respected.
