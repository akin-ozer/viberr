# Owner decisions and open questions

## Resolutions — signed and implemented 2026-07-19

The owner ruled on the four highest-leverage forks; the remaining decisions were
implemented on documented defaults (owner may still override). All findings were
first validated (36 REAL, 1 PARTIAL — F10-27's geometry claim; the concern
stands). Implementation is complete: typecheck + production build clean; full
unit/integration suite green (1,430 passing, incl. the previously-failing
watcher tests, now fixed by F10-08).

- **Security scope → in-app mitigations only** (NO container/sandbox/credential-
  broker infra). Implemented: `claudeSpawnEnv()` secret filter mirroring Codex
  (F10-02); server-owned delivery that refuses to stage/commit a profile whose
  `execute-code-or-write-repo` grant is withheld (F10-03); supporting/reviewing
  agents are physically read-only — Codex read-only sandbox + Claude write/git/gh
  denylist (F10-12); typed delivery contract outranks the operator directive on
  both branches + directive framed untrusted + directive-requests-delivery
  recorded in run evidence (F10-31); run-log/session-export require project
  membership (F10-06/33); skill/KB path containment (F10-18). Capability matrix
  states honestly where enforcement actually happens (F10-01/03).
- **Q10-01 full-autonomy acceptance → KEEP exception, fix copy.** The autonomous
  preset's operator `completion-for-acceptance: direct` stays; New-Project copy
  now discloses it (F10-24).
- **Q10-02 verdict authority → EXPLICIT-ONLY** (no implicit `direct` default;
  `effectiveCollabMode`), and the profile editor is lossless (opening/saving
  never widens verdict authority — F10-07/14).
- **Q10-03 / F10-15 multi-review → FULL revision-bound model.** Per-engagement
  verdicts keyed to an immutable commit SHA+tree (`workRevision` + `verdicts`);
  a new commit (different tree) invalidates prior verdicts; acceptance
  (`acceptanceBlockedReason`) requires every currently-required reviewer to
  approve the current revision, none requesting changes. Replaces the scalar
  `validation` (now a derived cache) and the comment/stage-bounce "rework"
  heuristic (F10-32).
- **Q10-05 supporting-run mutation → READ-ONLY by default** (implemented as above
  under security scope).
- **Q10-04 privacy (default applied):** app-wide task summary/comment view stays
  V1; raw run logs + provider-session export now require project membership.
- **Q10-06 operator routing (default applied):** a deterministic, server-computed
  routing trace (`task.operator.agent_selected` — considered candidates,
  eligibility, chosen, reason) is persisted on every engage/prompt (F10-35).
- **Q10-07 branch retention (default applied):** no auto-delete; GitHub freshness
  (last-reconciled + stale flag) is surfaced (F10-28). Revisit if it accrues.



## Q10-01 — may full autonomy accept completion?

Status: awaiting owner answer.

Background:

- The original PRD and current New Project modal say completion stays human-authorized for every autonomy preset.
- Later rulings and current code introduce a narrow exception: full autonomy plus explicit direct completion capability allows the operator to accept and move to Done.
- Policy copy discloses the exception, so the product currently tells two different stories.

Question: keep the narrow full-autonomy acceptance exception, or restore literal human-only completion?

Implementation consequence:

- Keep exception: update project-creation and product copy, add an explicit high-risk confirmation/audit contract, and test the exact gate.
- Human-only: remove the operator acceptance promotion and make every preset recommend/await a human.

## Q10-02 — verdict capability migration

Status: awaiting owner answer; implementation prerequisite.

Background: the generic-agent principle says verdict power is capability-granted. Current runtime treats absent verdict as direct for a supporting engagement, legacy `recommend` as off for a deliverer, while the editor coerces legacy values to allowed and can persist them on unrelated save.

Question: should verdict authority be explicit-only after a one-time migration, or should every non-delivering engagement implicitly be allowed to issue a gating verdict?

Recommendation: explicit-only. Migrate existing intended reviewer profiles once, preserve unknown legacy values losslessly until migration, and make the engagement picker disclose whether an agent can gate acceptance.

## Q10-03 — multiple reviewing-agent aggregation

Status: awaiting owner answer; implementation prerequisite.

Background: earlier intent says all current reviewers approve; current storage is one scalar validation state with sticky failure. Required rules include aggregation, stale approval invalidation, disengagement, and rework semantics.

Pass-10 adds a correctness defect: current code considers any newer stage transition or delivering-agent comment to be “rework,” so an unchanged commit can clear a prior rejection after a later approval.

Question: should acceptance require approval from every currently required verdict-capable reviewing engagement against the same immutable commit/diff subject?

Recommendation: yes. Store per-engagement verdicts keyed by review-subject identity; a changed subject invalidates approvals, a rejection remains blocking for that subject, and disengagement requires an audited human decision rather than silently erasing a veto.

## Q10-04 — app-wide read versus project privacy

Status: awaiting owner answer; privacy implementation prerequisite.

Background: current RBAC prose allows every authenticated user to view boards/tasks and comment. Direct routes follow that, Home/review/config/SSE hide non-member projects, and raw run logs/full provider transcript export are available to any authenticated user who knows a run ID.

This needs separate rulings for task visibility, live-event discoverability, raw logs, and provider transcript export; the latter should not inherit a broad comment/view policy by accident.

Live evidence: a non-member could not discover the lab project and received 403 from Settings, but a direct PXL-1 URL exposed its full timeline and session-export affordance, and the same user could post a comment labeled “not in project.”

Question: which of task summary, comments, full timeline, live run logs, provider transcript export, SSE topics, and review queue should be app-wide versus project-member-only?

Recommendation: task visibility may remain an explicit organization policy, but raw logs and provider transcripts should require project membership plus a dedicated sensitive-run permission. Navigation, direct routes, APIs, and SSE must enforce the same policy.

## Q10-05 — may supporting agents modify repository state?

Status: awaiting owner answer.

Background: the vocabulary presents supporting/reviewing engagements as research, review, testing, documentation, or advice. Current runtimes and shared workspace permit mutation, and the existing VIB-30 fixture records a supporting reviewer claiming it wrote, pushed, and opened a PR without task delivery linkage.

Question: should supporting engagements be physically read-only by default, with a separate explicitly delivering collaboration mode for agents that contribute changes?

Recommendation: yes. A support role should receive an immutable checkout/diff unless an explicit mutation grant also creates auditable delivery ownership and an isolated workspace.

## Q10-06 — operator routing contract

Status: awaiting owner answer; can be specified independently of Q10-01.

Background: PXL-1 routing correctly chose the exact docs and style profiles. PXL-2 used generic Developer/Reviewer for an exact deletion. No candidate scores, exclusions, workload, cost, or fallback rationale are persisted. More seriously, the operator twice contradicted the typed server-owned delivery contract and told the specialist to push/open a PR.

Question: which routing inputs are mandatory, and should the operator be technically forbidden from generating instructions that conflict with server-owned delivery authority?

Recommendation: use semantic fit, required capabilities/resources, stage eligibility, backend health, active workload, then project-configured cost/latency preference, with a stable tie-break. Persist a concise trace. Build delivery instructions from typed policy and reject contradictory free-form actions.

## Q10-07 — merged task-branch retention

Status: awaiting owner answer; lower urgency.

Background: the pass-10 lifecycle left `pxl-1` and `pxl-2` remote branches after PR merge. This aids audit/recovery but accumulates branches and exposes no lifecycle policy.

Question: automatically delete merged task branches, retain them, or make this a project policy with a retention window?

Recommendation: project policy defaulting to GitHub's delete-after-merge behavior, with the branch/commit retained in Viberr audit metadata.
