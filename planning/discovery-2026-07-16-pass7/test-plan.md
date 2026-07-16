# Phase-2 live test plan — pass 7

Ground rules: PR-shaped cases run on the existing `viberr` project (akin-ozer/viberr, PAT
connected). Non-PR cases may use a fresh `playground` project. `gh` may merge/close PRs
(exercise both). Merged files stay tiny (docs/test markers only). Users fixture: arda (org
admin) + create elif (maintainer), murat (contributor), selin (viewer), deniz (org member,
non-member of project). Results land in test-catalog.md with per-case verdicts.

## Catalog (≥20; adjust as discoveries dictate)

**RBAC / role bindings**
- TC-1 Project creation self-serve by non-admin org member (murat) → creator seeded admin.
- TC-2 Org user provisioning + project membership CRUD; invite-by-email creates whitelist row;
  joins as viewer; last-admin guard on demote/remove.
- TC-3 Per-role probe matrix (API + UI): create-task viewer deny; update-goal contributor deny;
  transition contributor deny; reorder maintainer allow; release-any admin only; etc.
- TC-4 Owner-exception accept (R6-2): contributor OWNER accepts own completion; non-owner
  contributor denied; viewer owner denied.
- TC-5 Packet owner-resolve (Q2): contributor owner resolves non-completion packet; accept
  option follows R6-2.
- TC-6 Non-member comment (app-wide FR4) — labeled visibly; @mention by non-runtime role →
  comment recorded, run skipped (runtimeDenied).
- TC-7 Org-admin asymmetry probe: arda… need 2nd org admin? (org-admin non-member of
  playground): sees card on home, 403 on policy/settings — document current vs D2 intent.

**Stage transitions / workflow**
- TC-8 auto boundary: operator advances triage→ready on well-scoped task; vague task → input
  packet instead.
- TC-9 approval boundary In Progress→Review via operator request + human approve.
- TC-10 Review→Done human-only; drag-to-Done = acceptance (R6-4) incl. merge attempt.
- TC-11 Manual non-boundary move (maintainer) + boundary change in Policy (edit-policy gate,
  review→done locked).

**Reviewers / quality**
- TC-12 Reviewer approve path → validation healthy → accept.
- TC-13 Reviewer request-changes → validation failing → accept refused (409) → rework →
  re-review clears.
- TC-14 Secondary reviewer: add 2nd reviewer, both verdicts required? (observe multi-reviewer
  semantics; D15 was branch-only — document main behavior).
- TC-15 Remove reviewer mid-review; verdict of removed reviewer no longer gates.

**Operator correctness**
- TC-16 Operator routing (D3): 2+ eligible specialists w/ different skills/backends — operator
  picks sensibly, states why; stage-ineligible agent hard-filtered.
- TC-17 React loop: specialist completion → operator reacts once (no dup); depth cap / no-progress
  → stuck-loop packet.
- TC-18 Decision packet lifecycle: open → options → owner resolves → operator proceeds;
  confirm packet copy + notification fan-out.
- TC-19 Operator full-autonomy (auto preset) on a playground task: crosses boundaries itself;
  acceptance only with explicit completion-for-acceptance: direct (Q1).

**GitHub delivery**
- TC-20 Full loop on viberr repo: task → operator/dev → workspace commits → server push →
  PR opens at review → reviewer → accept → REAL merge (tiny file). Traceability chain intact.
- TC-21 Reject path: gh pr close → app reflects closed; task rework path honest.
- TC-22 External merge via gh (bypass app) → Reconcile adopts merged state idempotently.
- TC-23 Merge-pending: accept with credential removed → `accepted` + "Complete merge" later.
- TC-24 Empty-diff at review boundary → surfaced timeline event + notification (pass-6 F-GH4 fix).

**Agents / resources**
- TC-25 Real MCP server (spin a local stdio/HTTP one) → org add → probe green → attach to
  profile → Claude run actually reaches it (tool call in log). Also verifies F7-MCP1 gap.
- TC-26 KB: create kb/ folder w/ docs → attach → prompt injection visible in run log →
  re-scan re-indexes after file change (F-RES2).
- TC-27 Skills isolation: agent loads ONLY declared skills (prompt shows declared body, not
  others); host ~/.claude skills never leak (spot-check run log).
- TC-28 Capability enforcement (C): claude dev with commit-push=human — push denied at tool
  level mid-run; codex same grant — advisory (labels honest).
- TC-29 Codex/claude parity: same task run on each backend; lifecycle, usage stats, failure
  honesty compared. Codex quota status verified (F-RUN2).
- TC-30 Interrupt + resume: interrupt mid-run (state honest), @mention resume re-anchors with
  confinement re-applied.

**Platform**
- TC-31 Archive read-only (R6-3) on playground: mutations 409, reads open, restore unfreezes.
- TC-32 SSE liveness: second tab sees comment/stage/run updates live; notifications bell.
- TC-33 Board reorder persistence + on-disk task.md edit → watcher reprojects (files-are-truth).
- TC-34 Error escalation + D4: force failing run (bad model id) → typed blocked packet w/
  reason → one-click retry on other backend.
- TC-35 Delete project purge (playground-2): files + projections + notifications gone.
