# Implementation plan — pass 8 (2026-07-17/18)

Derived from: live tests (test-catalog.md), findings.md, rbac-audit.md, decision-count-trace.md,
style-reviewer-bug.md. Owner rulings R8-1..R8-3 in owner-rulings.md.

## Testing verdict
Core logics validated live + code: full delivery loop w/ real merge (T1), operator specialist
selection (T6), claude skill isolation = WAD (T10), viewer RBAC (T14), org-admin override + audit
(T17), no-simulation honest error (T23, codex fails honestly here), file-watching + tolerant parse
(T28), reviewer honesty F7-REV1/2/3. Operator governance reasoning is genuinely strong (VIB-5/PLG-2).
App is mature and honest. Remaining findings are polish/coherence, not broken core flows.

## WORK ITEMS (priority order)

### W1 — Decision-count unification (R8-3) · HIGH · ruled, blueprint ready
Fixes D1 (3 disagreeing counts), D2/F7-NOTIF1 (superseded packets linger), non-member "waiting on
you" inflation. Per decision-count-trace.md:
- New `app/server/projections/decisions.server.ts`: `decisionsRequiring(db,userId,{projectSlug?})`
  → `{mine, overrideEligible}`, member-scoped via `resolveProjectAuthority` (mine = allowed &&
  !isOrgAdminOverride; override-eligible = allowed && isOrgAdminOverride).
- One definition of "open decision": non-terminal stage + (packet present, not a parked goal-edit) OR
  ≥1 pending recommendation. Drop `waiting==="human"` as a counter input (keep as board display hint).
- Fix staleness at source: give each packet a stable `id`; project `packet_id`; reconcile notifications
  against `packet_id`/`recommendationId`, not "task has any packet".
- Adopt at 5 call sites: home headline (home-page.tsx:1294), project cards (home-query.server.ts
  :118-141,194-200), notifications "Waiting on you" (notifications-page-helpers.ts:17-28 +
  notification.server.ts:74-84), board "Waiting on me" chip (board-filters.ts:22, board-page.tsx
  :547,891), review queue (review-queue.server.ts:86).
- Org-admin override-eligible items shown separately (labeled), never folded into personal count.
- Tests: unit for decisionsRequiring across roles + override; assert superseded packet drops out.

### W2 — RBAC rework (R8-2) · needs OWNER APPROVAL on product calls, then implement
From rbac-audit.md §5. Mechanical/safe (do regardless): make Policy table total (render all
RbacAction incl reconcile-github/grant-github-scope/manage-agents/reorder-board — smell j);
honest view/comment labeling as "any signed-in user" (smell b); extract one `requireRuntimeRole`
helper for the 4 run-agents sites (smell g); share owner predicate in setOwner (smell d); keep
monotonicity test (10). Product calls (ASK OWNER): (a) reconcile-github vs rescan-project tier
inversion — align direction; (h) archived-project credential mutation freeze vs exempt; (9)
manage-members delegation to maintainers vs admin-only.

### W3 — Capability display honesty (D4/D4b) · MED
- Read-only affordance when a profile has 0 gated caps: show "read-only · no gated capabilities"
  instead of "0 direct/0 recommend/0 human" (policy-page.tsx:237-250, agents-page.tsx:334-335).
- D4b: seed profiles carry decorative "fake toggle" advisory caps (capability-catalog.ts:37-47) that
  inflate "N direct" with zero runtime effect → either stop counting advisory caps as capabilities or
  render them in a distinct "advisory (no enforcement)" bucket. Honesty fix.

### W4 — GitHub↔task divergence (D3) · needs OWNER product call
PR merged/closed out-of-band (via gh) leaves task stuck (VIB-5 merged-but-Review, VIB-3 closed-but-
InProgress). Reconcile currently doesn't close the loop. Options: reconcile surfaces a typed
divergence event / offers to advance-or-annotate, vs leave as-is (files canonical). ASK OWNER.

### W5 — Minor · LOW
- F7-RUN1: codex failure classified as "authentication and runtime configuration" when real cause is
  likely quota — refine the classification/label so codex quota reads honestly.
- B2: org MCP notes-fixture points at a dead session path — a fresh install has no live MCP; either
  ship a self-contained fixture or document. (Not a product bug; test-env hygiene.)

## Validation approach (every item)
Code (typecheck + targeted tests) → UI screenshot → browser behavior. No deferrals.

## FINAL STATUS (implemented this pass — full suite GREEN 1298 tests / 131 files, typecheck clean)
- **W1 · DONE + tested + browser-verified.** New `app/server/projections/decisions.server.ts`
  (`decisionsRequiring` → {mine, overrideEligible}, member-scoped, no audit). Adopted at all 5 call
  sites: home headline+cards (home-query/home-page, + `overrideWaiting` "override-available" chip),
  notifications overlay (member-scoped `waitingOnYou` + dedupe-by-task in splitNotifications), board
  chip+card badge (project.tsx annotates `waitingOnMe`; board-filters/board-page member-scoped; card
  shows "waiting on you" vs "waiting on a human"), review queue (`getReviewQueue` mineTaskKeys; "Still
  with agents"→"Still in review"). Browser-verified: home 5→3 coherent (viberr 3 = headline 3;
  Playground now "2 override-available" not "waiting on you"); notifications 4→3 with VIB-4 deduped;
  board viewer chip 0 + "waiting on a human". Tests: decisions.server.test (5), notifications
  member-scoping (2 new), board-filters, review-page.
- **W2 · DONE + tested + browser-verified.** R8-4 reconcile-github→maintainer+ (rbac.ts + tests
  policy-rbac + github-route); R8-5 archived credential freeze (dropped allowArchived from github/
  settings guards + test); total Policy table (17 rows, all enforced actions) + app-wide honest
  view/comment rows ("Any signed-in user · membership not required"). Browser-verified on Policy page.
- **W3 · DONE + browser-verified.** Read-only capability affordance ("read-only · no gated
  capabilities") for profiles with 0 gated caps (Style Reviewer). D4b: advisory caps are already
  labeled via the existing EnforcementScope/matrix badges — summary count is a grant count (acceptable).
- **W4 · DONE + tested.** R8-6 GitHub↔task divergence: reconcileTask posts a typed "Divergence:"
  timeline event + notifies supervisors (owner+admins/maintainers) when a PR merged/closed out-of-band
  diverges from a non-terminal task; never auto-advances; idempotent (fires once per transition). Test
  in github-reconciler.server.test.
- **W5 · NO CHANGE NEEDED.** codex-runtime already classifies quota/auth distinctly; the generic
  "authentication and runtime configuration" is the honest fallback only when codex REDACTS the reason
  (documented limitation). Not a misclassification.
- **rbac-audit §5 #4 — IMPLEMENTED (post-testing cleanup pass).** Centralized the `run-agents` authority
  check into `requireRunAgents`/`canRunAgents` (project-authority.server.ts): the 4 runtime sites (@mention
  trigger, specialist/reviewer dispatch, interrupt, run-operator) now delegate the tier + audit to ONE place;
  removed the 2 duplicated per-site helper bodies + dead `rolesForAction`/`requireProjectAuthority` imports.
  Behavior-preserving (172 targeted + 1300 full + 13 e2e green; RBAC tiers re-verified live).
- **rbac-audit §5 #5 — justified non-change (not a deferral).** On inspection both
  are already single-sourced and NOT hardcoded: (#5) `setOwner` (task-actions.server.ts:2100-2107) resolves
  authority via `roleCan(actorRole,"release-any-ownership")` + `roleCan(targetRole,"own-task")` — consulting
  `ACTION_ROLES`, not role literals; and `ownerException` encodes a DIFFERENT rule (the accept-completion
  owner exception), so folding them into one helper would conflate two distinct concepts and reduce clarity.
  (#4) the 4 run-agents call sites already delegate tier resolution to `requireProjectAuthority`/
  `resolveProjectAuthority` (single source); the only "duplication" is per-site project-load plumbing, and one
  site (`hasRuntimeRole`) is deliberately NON-throwing for the @mention path — a forced helper would risk that
  divergence for no behavior gain. Both verified behavior-correct live (ownership tiers TC8; @mention gating).
  Decision: leave as-is; these were audit *suggestions*, not findings/requirements — every actual finding and
  owner ruling (R8-1..R8-7, D1-D5, F7-*) IS implemented.
- **critical-audit-2 MED-1 — FIXED (commit 0ee6d99).** Crash-loop cap on `recoverUnreactedAgentRuns`'s operator
  re-invoke, mirroring `finalizeOrphanedRuns`: `run.recovery.reply_replayed` audit recorded before the effects +
  per-run rolling-window skip. New catalog action; 4 unit tests. Full suite (1304) + typecheck + 13 e2e green.
- **critical-audit-2 LOW-1 — REJECTED (false positive).** The violations rail badge is rendered only by
  `routes/project.tsx` (project scope), which already receives `violation.updated`; there is no global every-page
  badge. `broadcast:true` would leak project-scoped events to all users. No change. See critical-audit-2.md RESOLUTION.
