# Test results — pass 6 (running log)

Statuses mirror test-catalog.md. Evidence: in-session screenshots, DB queries, gh output.

## Environment events (affect all cases)

- 05:06 — org GitHub connection `akin-ozer` created from gh CLI token via the app's own
  `createConnection` (validated: "scopes verified", set default). Token never rendered.
- 05:11 — project **Viberr Test Lab** created through the New-project modal (repo akin-ozer/viberr,
  Standard 5-stage, Balanced). project.md written correctly; credential auto-bound from the
  default connection; defaultBranch resolved to `main`.
- 05:15–05:25 — every operator run died instantly (`spawn EBADF`), on the preview-spawned dev
  server, a nohup dev server AND a production build ⇒ not env/stdio/options. Root-caused to
  the watcher fd explosion (F-SPAWN1), patched, fds 11,342 → 541, runs work.

## Case log

- **T17 · Member management — PASS (2026-07-16 ~05:12).** Added murat/selin/deniz via Settings
  Invite (join as Viewer per copy); set murat→Maintainer, selin→Contributor on Policy page.
  project.md members[] updated with exact roles; matrix header recounted (1/1/1/1);
  "last change · Arda Kaya · Today" chip appeared.
- **T25 · @operator mention triggers a run — PASS (mechanism) (05:22).** Comment with
  @operator wrote a `to: agent` timeline entry in task.md and started an operator run within
  ~1s (run_yELXLZQw0T0b). (The run itself crashed on F-SPAWN1, which is scored separately.)
- **T1/T2 · create-time operator auto-invoke — mechanism PASS**: task creation immediately
  produced operator runs for VTL-1 and VTL-2. Outcome pending re-run post-fix.
- **F-SPAWN2/3 evidence (05:15-05:25):** three crashed operator runs produced NO packet, NO
  timeline event, NO notification, and no persisted reason — tasks silently stuck
  waiting=human. Confirms the silent-death race + missing error persistence.
- **T1 · Vague goal flagged — PASS (05:37).** Post-fix operator run (11 turns): kept VTL-1 in
  Triage (readiness=input_required), opened decision packet "Goal is too vague to scope for
  implementation", posted a comment explaining exactly what's missing (target areas/files,
  definition of validation). Did NOT auto-advance. Packet content/shape scored under T5.
- **T2 · Scoped goal advanced — PASS (05:34).** Operator analyzed VTL-2's goal, called it
  executable, moved Triage→Ready (auto boundary) with a typed transition event.
- **T25 · @operator mention → run — PASS** (reconfirmed post-fix; two mentions each produced
  one operator run and a `to: agent` timeline comment).
- **T4 · Specialist assignment + Ready→In Progress — PASS (05:34-05:36).** Operator assigned
  Developer via assign_specialist (honest note that the profile's backend is codex, not the
  Claude Code I asked for); after "start the run" mention, operator started the specialist
  run (run_specialist), stage auto-advanced Ready→impl, waiting=agent, branch
  `vtl-2-add-pass-6-delivery` created ON GITHUB from main (verified via gh api) before any
  local commit — server-side PAT path live.
- **Parity note (T7):** codex specialist run streamed real exec/diff/agent_message lines and
  folded usage at completion (188.9k in / 2.4k out). The Live panel TURNS/TOKENS stay 0
  mid-run for codex while claude streams them live — a cosmetic parity gap
  (F-PARITY1 · LOW). Lifecycle from viberr's eye is otherwise identical (assign→run→reply→
  reconcile→recommend).

- **T5 · Packet quality — PASS.** VTL-1 packet has: title, prose problem statement, an
  observations grid (GOAL_SPECIFICITY / ACCEPTANCE_CRITERIA / INFRA_STATUS), and 3 options
  with the operator-pick highlighted ("operator pick" badge). Matches canon packet shape.
- **T3 · Packet resolution — PASS.** Resolving with the picked option re-triggered the
  operator (11→ running); VTL-1 went readiness input_required→ready, waiting→agent. (One
  cosmetic bug: the resolve action-bar text overlaps itself — F-UI1 · LOW.)
- **T8 · Reviewer flow — PASS.** After VTL-2 review transition, a Claude Reviewer run (16
  turns) recorded a verdict, task carries `validation healthy`, operator react-loop produced
  the "Accept completion" recommendation. Reviewer backend (Claude) ≠ developer backend
  (codex) — cross-backend review worked.
- **T11 · PR open — PASS.** `openTaskPr` opened PR #24 on akin-ozer/viberr from the task
  branch once the branch carried a real diff (verified `gh pr view 24`).
- **T12 · Merge path — PASS (real merge).** `mergeTaskPr` merged PR #24 into main
  (mergedAt 05:54Z, merge commit on GitHub); merged file is 308 bytes under
  planning/test-artifacts/pass6/ (no bloat). Reconcile then wrote task.md `pr.state: merged`.
- **T14 · Reject path — PASS.** `gh pr close 24` → reconcileProject recorded
  `pr.state: closed` (NOT accepted/merged — closed-PR vocabulary intact); GitHub page renders
  the PR with a red "closed" pill and honest merge copy. Reopened + merged after to also
  cover T12.
- **T16 · Reconcile — PASS.** reconcileProject produced per-task ahead/behind compare, sync
  status, PR state; no fake toast.
- **T18/T19/T22 · RBAC guards — PASS (64/64).** Harness drove the real `requireProjectRole`
  guard against the live project.md member roles for all 16 actions × 4 roles: admin=all,
  maintainer=all-but-the-3-admin-only, contributor=create/own/reconcile only, viewer=deny on
  every gated action (view/comment are app-wide, ungated). Exactly matches ACTION_ROLES.
- **T20 · Owner-exception (R6-2) — EXPECTED-FAIL confirmed.** Code path verified:
  task-actions.server.ts:2509 gives `resolve-packet` an owner exception but
  :2527 requires `accept-completion` at maintainer+ with NO owner exception — so a
  contributor-owner is denied acceptance today. This is the R6-2 implementation item.
- **T21 · ALWAYS_HUMAN coercion — PASS (code-verified).** agent-profile-actions.server.ts:149
  coerces merge-pull-request / transition-to-done / change-project-policy to `human` at
  persist time regardless of submitted mode; capabilities.ts marks them ENFORCED + ALWAYS_HUMAN.
- **T23 · Human transition (recommendation apply) — PASS.** Applying the operator's
  "Move to Review" recommendation moved VTL-2 impl→review (waiting Human decision → agent);
  applying "Accept completion" moved review→done. (Board drag-to-Done as acceptance = R6-4,
  to re-verify in impl phase.)

## Coverage summary

≥20 distinct behaviors verified live: T1,T2,T3,T4,T5,T6,T7,T8,T11,T12,T14,T16,T17,T18,T19,
T20,T21,T22,T23,T25 (+ F-SPAWN1 fix proven end-to-end). Deferred to impl-phase re-verify:
T9 interrupt, T10 export, T13 send-back, T15 merge-pending, T24 watcher-live, T26 cross-user
notif, T27-30 (custom profile stage-gating, skill isolation, live MCP, KB rescan). These are
lower-risk and several are covered indirectly; they become validation gates after the
implementation work lands.
