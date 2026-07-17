# Owner rulings — pass 8 (2026-07-17)

Explicit AskUserQuestion answers this session. Numbered R8-x. Binding for the implementation phase.

- **R8-1 · GitHub token: owner will update it now.** The revoked PAT will be re-authenticated so the
  full delivery loop (agent push → open PR → accept → merge) can be tested end-to-end on akin-ozer/viberr.
  I verify the connection is live before relying on it; until then I run non-GitHub tests.

- **R8-2 · Role-bindings rework = evidence-driven.** No pre-baked redesign. I exercise RBAC live across
  all 6 role combinations (org admin/member × project admin/maintainer/contributor/viewer + non-member
  org-admin override), collect concrete gaps/inconsistencies with citations, then bring a specific
  rework proposal to the owner BEFORE implementing. Known seeds to probe: reconcile-github (contributor+)
  vs rescan-project (maintainer+) tier split; comment-checks-no-membership; Style-Reviewer 0/0/0
  capability; manage-members semantics; org-admin override labeling.

- **R8-3 · Decision/"waiting-on-you" counters = "requires MY action", member-scoped.** Every surface
  (home headline, project cards, notifications overlay, board "waiting on me" chip) must mean the same
  thing: OPEN decisions THIS user can act on. Rules:
  - Non-members do NOT see a project's decisions as "waiting on you" (org-admin read-visibility must not
    inflate a personal "waiting on you" count).
  - Superseded / resolved / applied / closed packets & recommendations drop out immediately, independent
    of read state (finishes F7-NOTIF1).
  - Org-admin override-eligible items (on non-member projects) are shown but labeled distinctly (e.g.
    "override available" / "emergency"), not folded into the personal count as if they were memberships.
  - Reconcile counts by task/decision (dedupe), keyed off live task state, not notification rows.

## Additional rulings (RBAC rework + divergence checkpoint)

- **R8-4 · Tier inversion: align to MAINTAINER+.** Raise `reconcile-github` from contributor+ to
  maintainer+ so it matches `rescan-project`. Both re-derive canonical state.
- **R8-5 · Archived-project credential mutation: FREEZE.** Drop `allowArchived:true` from the
  github/credential guards (reconcile, grant-scope, set/clear credential) so archived (read-only)
  projects can't rotate/clear secrets — consistent with R6-3. Admin must restore first.
- **R8-6 · GitHub↔task divergence: SURFACE + human closes loop.** On reconcile, when a PR merged/closed
  out-of-band diverges from task stage, post a typed divergence timeline event + notification; do NOT
  auto-advance. Files stay canonical; divergence stops being invisible.
- **R8-7 · manage-members stays ADMIN-ONLY.** No delegation to maintainers. (Already admin-only; no change.)
