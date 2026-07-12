# Live test plan v2 (2026-07-11 session 2) — 24 cases on a fresh viberr-on-viberr project

Target: NEW project "Viberr Selftest" (slug auto), repo **akin-ozer/viberr** (the app itself).
PRs opened by agents land on the real repo — keep them tiny (test-support files, docs) per owner
instruction; merge some + reject some via `gh` so viberr reflects both outcomes. Other seeded
projects may be used for non-PR cases. Cases marked ✎ probe a specific fresh finding (expected to
fail until Phase 3 fixes; failing = confirmation, then retest after fix).

Result columns filled during the run: PASS / FAIL(→finding) / BLOCKED.

## Setup
- T0: create project via New-project modal, preset **balanced**, repo akin-ozer/viberr, PAT check.
  Verify GOVERNED_TEMPLATE workflow (triage→ready auto per D2), guardrails present, 3 agents deployed.

## A. Creation → operator auto-flow (D2 pipeline)
- T1: well-scoped task → operator auto-advances triage→ready→impl, assigns Developer, run starts.
  Verify ONE timeline entry per operator turn (decision E), waiting=agent while running (✎A2).
- T2: vague task ("make it better") → operator opens an INPUT packet instead of advancing (packet
  quality: observations + 2-4 options, one recommended).
- T3: concurrent double-trigger (create + immediate @operator comment) → single-flight coalesce,
  exactly one operator run (✎A6 scripted/codex; here real-claude expected safe).

## B. Specialist delivery (real repo)
- T4: Claude Developer task → branch named by task key, commits `[KEY]`-prefixed, PR opened with
  task back-link, task.md pr/branch cache correct (✎B4 conventions actually followed?).
- T5: Codex Developer task → same expectations; compare behavior parity with T4 (system-prompt
  handling F1, MCP absence F2, conventions).
- T6: PR merged EXTERNALLY via gh → reconcile → task pr.state="merged"; commit cache preserved
  (✎B2 wipe).
- T7: PR closed-unmerged externally via gh → reconcile → pr.state="closed" + how UI presents it.
- T8: accept a completion while PAT lacks merge rights (or PR conflicted) → pr.state="accepted"
  merge-pending pill + Complete merge button; then complete the merge for real (S2 path).
- T9: after an "accepted" state, run another real agent on the task → does workspace delivery
  clobber accepted→review? (✎B1)

## C. Review & verdict loop
- T10: reviewer run via operator prompt → verdict classified, validation flips, quality event +
  notification to owner/admins.
- T11: reviewer run via UI "Run reviewer" button → same verdict pipeline (H2 retest).
- T12: reviewer engaged via @mention comment → verdict + reconcile expected DROPPED today (✎A1);
  document precisely.
- T13: reviewer REJECTS (request_changes) → validation=failing; developer reworks; re-review
  approves → validation should recover (✎A3 permanence).
- T14: two reviewers, one approves one rejects → rejection sticks (H3 semantics), no spurious
  stall packet (✎A9 on simulated; here real backends).

## D. Governance & RBAC (role bindings)
- T15: contributor (selin) takes ownership; packet addressed to her; can she resolve it? (✎C3 —
  expect 403 via UI controls that shouldn't render, M2).
- T16: contributor @mentions an agent → comment posts + runtimeDenied toast (seam 1).
- T17: viewer (add deniz as viewer) sees Dismiss/packet controls? (✎D3 M1/M2 render-vs-403).
- T18: strict-preset project (second project, no repo) → pre-work boundaries approval — operator
  must NOT auto-advance triage→ready; recommendation cards instead (S1 real effect).
- T19: full-autonomy operator run on a healthy in-review task with completion-for-acceptance:
  recommend → does it auto-accept to Done? (✎A7 contract; document actual).
- T20: manual drag into Done on the board → acceptance contract runs; toast copy honesty (✎C4);
  verify recommendations stripped (✎C1 via packet-accept variant on another task).

## E. Agent quality / resources
- T21: skills loading — agent context contains ONLY its profile's declared skills (no host leak,
  no other org skills). Check via run log system-init + asking the agent to list its skills.
- T22: MCP — profile with the seeded fictional `mcp.internal` server: does the Claude run degrade
  gracefully or hang/error? (walkthrough ⚠️); then a real MCP (everything-server) round-trip.
- T23: KB injection — org KB dir attached to profile appears in system prompt (24k cap) and the
  agent can quote it.
- T24: interrupt a running agent → run state=interrupted, timeline note, operator does NOT react
  to a dead run; resume via @mention continues the session (adapter resume).

## F. Notifications & cross-cutting
- T25: notification routing prefs — disable "quality" for arda → reviewer verdict no longer
  notifies arda but still notifies elif (admin).
- T26: bell deep-links navigate to task packets; mark-all-read; cross-tab badge (✎E12 staleness
  acceptable, note).

Minimum bar: ≥20 distinct executed cases (T1-T26 minus any BLOCKED), each with evidence
(screenshot or API/db check) recorded in test-results-v2.md.
