# Test catalog — pass 6 live testing (2026-07-16)

Project under test: **Viberr Test Lab** (`viberr-test-lab`, repo akin-ozer/viberr, VTL-###,
Standard 5-stage, Balanced preset). PRs happen ONLY here. Other projects may be used for
non-PR cases. Owner rulings R6-1..R6-5 (owner-rulings.md) define expected behavior; where
main is known to differ, the case is marked **expected-fail** and feeds the implementation list.

Status: PASS / FAIL / EXPECTED-FAIL(confirmed) / BLOCKED / PENDING. Every case gets evidence
(screenshot in-session, gh output, or DB/file inspection).

## A. Operator & task lifecycle

- **T1 · Vague-goal task → operator flags underspecified.** Create VTL task with filler goal.
  Expect: operator run (create-trigger), decision packet "goal unscoped", task stays Triage,
  input-required badge, notification. — PENDING
- **T2 · Scoped task → auto-advance Triage→Ready.** Well-scoped goal. Expect operator scopes,
  advances to Ready (auto boundary), assigns nothing yet. — PENDING
- **T3 · Packet resolution.** Resolve T1's packet (pick an option). Expect operator reacts,
  task proceeds; packet closes; timeline + audit entries. — PENDING
- **T4 · Primary specialist assignment → Ready→In Progress.** After T2, operator (or human
  run-agents) assigns Developer; expect branch `vtl-N-…` created, stage auto-advances,
  timeline "assigned … as primary specialist". — PENDING
- **T5 · Operator packet quality.** T1/T3 packets contain observations + 2–4 options with an
  operator pick (canon packet shape). — PENDING

## B. Agent runs — Claude/Codex parity

- **T6 · Claude Developer run delivers a tiny real change.** Goal: add a small test marker file
  (e.g. `planning/test-artifacts/pass6/T6.md`). Expect: real SDK run, live log stream, commits
  on task branch, reply comment, transition request In Progress→Review with evidence. — PENDING
- **T7 · Codex Developer run, same shape as T6.** Expect identical lifecycle from viberr's view
  (assign → run → reply → evidence) with honest advisory-cap labels. If codex quota is still
  exhausted: expect the blocked-decision recovery packet (that behavior is then the pass). — PENDING
- **T8 · Reviewer flow.** Summon Reviewer (opposite backend from T6's developer) on the T6 task.
  Expect reviewer verdict recorded, operator reacts (react-loop), review-queue reflects state. — PENDING
- **T9 · Interrupt a live run.** Start a run, hit Interrupt. Expect run finalized as interrupted,
  audit row ("recorded per audit policy"), operator/waiting state sane, no zombie "running". — PENDING
- **T10 · Run logs & export.** For T6: raw JSONL toggle, follow mode, `/resources/session-export`
  returns the session; `/resources/run-log` streams. — PENDING

## C. GitHub delivery (all on viberr-test-lab)

- **T11 · PR opens from the app.** After T6 reaches Review with evidence: expect PR on
  akin-ozer/viberr (verify `gh pr view`), PR chip + execution-branches row in GitHub page. — PENDING
- **T12 · Accept completion → merge → Done.** Accept T6's completion as maintainer+. Expect PR
  actually merges (gh confirms), task → Done with `pr.state=merged`, audit + timeline. — PENDING
- **T13 · Send back for one fix.** On T7 (or a second task), use "send back" instead of accept.
  Expect task returns to In Progress, PR stays open, operator re-engages specialist. — PENDING
- **T14 · External reject: `gh pr close` a task PR.** Then Reconcile. Expect app reflects the
  declined/closed PR honestly (pr.state vocabulary), board/GitHub page consistent. — PENDING
- **T15 · Merge-pending fallback.** Temporarily clear the project credential, accept a completion.
  Expect `accepted (merge pending)` state, no crash; re-attach credential + reconcile → merge
  completes or stays honestly pending. — PENDING
- **T16 · Re-scan / reconcile surfaces.** GitHub page Reconcile + board Re-scan buttons do real
  work (reconciler run, toast with counts, no fake toasts). — PENDING

## D. RBAC & role bindings

- **T17 · Member management.** Add Murat (maintainer), Selin (contributor), Deniz (viewer) to
  viberr-test-lab via Settings/Policy. Expect Policy matrix counts update; audit rows. — PENDING
- **T18 · Contributor powers.** As Selin: can create task + take ownership; CANNOT approve
  transitions / run agents / edit goal (server-side deny, honest UI). — PENDING
- **T19 · Viewer powers.** As Deniz(viewer): read + comment only; create-task denied server-side. — PENDING
- **T20 · Owner-exception accept (R6-2).** Selin (contributor) owns a task at Review; tries to
  accept completion. Main today: DENIED (maintainer+). **expected-fail** → implementation item
  F-RBAC1; verify the deny is at least honest/audited today. — PENDING
- **T21 · ALWAYS_HUMAN invariant.** Edit a profile granting `merge-pr`/`transition-to-done` as
  direct. Expect persist-time coercion to human (grantsFor), UI shows reserved-for-humans. — PENDING
- **T22 · Org-role boundary.** As org member (non-admin): /org/settings users/connections tabs
  denied; project creation still self-serve (pass-3 decision B). — PENDING

## E. Board & stages

- **T23 · Human drag transitions.** Drag across each boundary: Ready→In Progress (allowed for
  maintainer+), In Progress→Review (approval boundary honored), Review→Done drag = acceptance
  path (R6-4 confirms H4). Also within-column reorder persists (rank). — PENDING
- **T24 · File-native truth + watcher.** Edit a task.md stage on disk; expect watcher reprojects
  and board updates live (SSE); Re-scan converges after offline edits. — PENDING

## F. Comments, mentions, notifications

- **T25 · @operator mention** in a comment triggers an operator run (mailbox trigger); reply
  lands on the timeline. — PENDING
- **T26 · Cross-user notifications.** Second user comments/@mentions on a task Arda owns →
  Arda notification; cross-project navigation from the notifications panel works. — PENDING

## G. Agent resources

- **T27 · Custom specialist profile with restricted eligible stages.** Create "Docs Writer"
  eligible only in In Progress; verify operator cannot assign it elsewhere (assign AND run
  enforcement), and it appears in the capability matrix. — PENDING
- **T28 · Skills: relevant-only loading.** Attach a project skill; run T6-style task; verify run
  log loads the relevant skill and does NOT load unrelated org skills. — PENDING
- **T29 · MCP end-to-end.** Add a real reachable MCP server at org level; verify agent run can
  actually use it (tool call visible in log); the seeded fake `docs-search` row stays honest
  (unreachable). — PENDING
- **T30 · KB re-scan.** Org KB re-scan updates doc count / re-scanned timestamp from real files. — PENDING

## Recording rules

Evidence per case goes in `test-results.md` as it happens; failures get F-ids in findings.md.
Merged PRs must only add tiny files under `planning/test-artifacts/pass6/` (no product bloat);
reject/close at least one PR via gh so the declined path renders in-app.
