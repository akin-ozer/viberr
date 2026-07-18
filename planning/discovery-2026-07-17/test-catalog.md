# Live test catalog — pass 8 (2026-07-17)

Token is LIVE (connection connected, ····Wi8q). Full delivery loop testable on akin-ozer/viberr (PRIVATE).
Playground (repo=null) = no-GitHub sandbox. Keep merged files tiny. Status: ⬜ todo / 🟡 running / ✅ pass / ❌ fail / ⚠️ finding.

## A. Full delivery + GitHub (viberr project, real PRs)
- T1 ⬜ Happy path, Codex dev: new tiny doc task → operator scopes → Developer(codex) implements → push branch → PR → Reviewer(claude) approves → accept → real merge. Tests codex live + full loop.
- T2 ⬜ Happy path, Claude dev: same shape, Claude specialist. Codex-vs-Claude parity from viberr's eye (turns/tokens panel, tool policy, skill load).
- T3 ⬜ Reject → rework (R7-4): reviewer requests changes → operator backward transition Review→In Progress → re-drive dev → re-review → accept.
- T4 ⬜ Out-of-band merge/reject via gh (D3): reject a PR via `gh pr close`, merge another via `gh`, then Reconcile → observe task-state divergence handling.
- T5 ⬜ Draft-PR acceptance (F7-GH5): agent opens draft PR → accept → server un-drafts → merge.

## B. Operator behavior & agent selection
- T6 ⬜ Multi-eligible specialists at a stage: task where Review stage has Reviewer + Style Reviewer eligible → does operator pick correctly / per intent?
- T7 ⬜ Operator single-flight (F7-OP1): trigger two operator turns fast → no duplicate primary runs.
- T8 ⬜ Operator refuses to close/merge itself (never crosses human boundary unless full-autonomy direct).
- T9 ⬜ Triage underspecified task: operator flags instead of auto-advancing.

## C. Skills & MCP
- T10 ⬜ Skill loading correctness: docs-writer run loads docs-style ONLY (not reviewer-expertise/developer-expertise). Verify via run log system-init / skill list.
- T11 ⬜ Codex skill/MCP isolation: does a codex run leak host ~/.codex personal skills/MCPs, or only viberr-bound ones? (B3)
- T12 ⬜ Live MCP tool call: stand up a fresh stdio MCP fixture, attach to a profile, verify specialist calls its tool in a run.
- T13 ⬜ MCP credential injection (F7-MCP1): MCP needing a secret:// header/env → verify sealed injection at spawn.

## D. RBAC (evidence for R8-2 proposal) — log every allow/deny with citation
- T14 ⬜ Viewer (Selin, viberr): read ok; create-task DENY; transition DENY; accept DENY; comment ALLOW.
- T15 ⬜ Contributor (Deniz/Murat, viberr): create ok; own task ok; approve-transition DENY; accept own task ALLOW (owner exception).
- T16 ⬜ Maintainer (Elif, viberr): approve/accept/edit-goal ALLOW; manage-members DENY; release-any-owner DENY.
- T17 ⬜ Org-admin override (Arda on PLAYGROUND, non-member): mutate a playground task → allowed + audited as org-admin override; UI pill.
- T18 ⬜ Known inconsistencies: reconcile-github (contributor+) vs rescan-project (maintainer+); comment w/o membership.

## E. Governance mechanics
- T19 ⬜ Comments: human comment, @agent mention triggers operator, comment on Done task (R7-6 hint).
- T20 ⬜ Packets: resolve VIB-4 / VIB-5 blocked packets via options → operator re-engages; F7-PKT1 (choice≠done).
- T21 ⬜ Secondary/second reviewer: add a 2nd reviewer; two verdicts; all-approve semantics.
- T22 ⬜ Capability enforcement + 3-mode picker (R7-5): specialist cap Human-only → withheld in run; Allowed → acts.
- T23 ⬜ No-simulation honest error (R7-2): force backend-unavailable → typed error + blocked packet, no fake run.
- T24 ⬜ Stage transitions across boundary types (auto/approval/human).

## F. Config surfaces
- T25 ⬜ Create a NEW project via UI (with/without repo).
- T26 ⬜ Create a NEW agent profile via UI (custom specialist, 3-mode caps, resources).
- T27 ⬜ Style Reviewer 0/0/0 capability (D4): investigate config + route a task to it.
- T28 ⬜ File-watching: edit a task.md on disk → UI reflects; malformed edit → tolerant diagnostic, no crash.
- T29 ⬜ Decision-count coherence (D1/D2/R8-3): observe home/cards/overlay/board chip after resolving packets.

## Results
- **T6 ✅ Operator specialist selection correct.** VIB-6 (docs-only): operator auto-advanced Ready→In Progress
  (auto boundary), read task+policy via mcp__viberr__get_task, assigned **Docs Writer (claude)** NOT the codex
  Developer — right call. Policy honored: assign-specialist=direct, stage-transitions=recommend (it RECOMMENDED
  "Move to Review", didn't self-transition), execute-code/transition-to-done=human.
- **T1 ✅ COMPLETE + GitHub-verified.** Full loop: create(Ready)→operator auto-advance In Progress→assign Docs
  Writer(claude)→create file+push branch `vib-6`+PR #35→operator recommends Review→Arda applies→operator summons
  **Style Reviewer**→PASS (full report to timeline)→operator recommends Accept→Arda accepts→PR #35 MERGED
  (commit 23b9aaeb, 20:52:38Z)+Done. File docs/testing/pass8-smoke.md (171b, house style correct) on main.
  F7-REV1 ✅ reviewer full report reached timeline; F7-REV3 ✅ "validation healthy + approved" consistent (no
  contradiction); skill load proven by `DOCS-STYLE-MARKER-P7` + applied house-style conventions.
  **D4 UPDATE**: Style Reviewer functioned (produced healthy verdict) despite Policy showing 0/0/0 → 0/0/0 is a
  DISPLAY bug, not a functional gap.
- **T1 (superseded note) delivery works.** Docs-writer created docs/testing/pass8-smoke.md, pushed branch `vib-6`
  (bare task key), opened PR #35 (OPEN, non-draft, +8/-0, exactly the one file). Token live. Continuing to
  reviewer→accept→merge.
- **T17 ✅ Org-admin override (D2) FULLY CONFIRMED.** Arda (org-admin, NON-member of playground) took ownership of
  PLG-2. UI: "org-admin override" pill in topbar + Permissions "Your role: Admin". Audit: dedicated event
  `project.org_admin.override` {"action":"own-task","what":"take or assign task ownership","memberRole":null}
  immediately preceding `task.ownership.taken`. End-to-end: authority granted, mutation allowed, audited distinctly.
- **T23 ✅ No-simulation honest error CONFIRMED (codex actually fails here).** PLG-2 blocked packet: "Work stalled —
  pick a recovery path. The Implementation specialist run failed — Codex run failed: Codex execution failed. Review
  its authentication and runtime configuration." NO fake run produced; honest error + recovery packet (Redirect /
  Send back / Hold options). ⇒ Codex is backend-unavailable at EXECUTION in this env (auth.json present so health
  says real, but runs fail — quota, per memory). Impacts codex-parity tests: I can exercise codex's FAILURE path
  (honest) but not a successful codex delivery. F7-RUN1: failure classified as "authentication and runtime
  configuration" — honest that codex failed, though real cause is likely quota (mildly misleading label).
- **T10 ✅ Claude skill isolation = WORKING AS DESIGNED (verified code + run).** claude-runtime.server.ts:316-318
  sets settingSources:[], skills:[], plugins:[] to block host skill/plugin leak; org skill (docs-style) injected
  as system-prompt text. The run's system-init DID show host skills (deep-research/dataviz/code-review/doctor…)
  — but that's the DOCUMENTED dev-only case (comment :310-315): the server was launched from inside MY Claude
  Code session, so the spawned `claude` subprocess inherits the parent session's toolset at the PROCESS level,
  above any SDK option. Those leaked skills are mine, not viberr's. A standalone deployment has no parent → no
  leak. NOT a product bug. (Codex isolation is separate — CODEX_HOME=personal ~/.codex — verify with a codex run.)
