# Pass-8 diff adversarial review (2026-07-18)

A workflow reviewed the whole pass-8 branch diff (vs `main`, ~30 source files) across
5 change-clusters — decision-counts, github-divergence, rbac/run-agents, policy/archived,
reviewer-verdict — with each finding refute-verified by two independent skeptics (kept only
when BOTH confirmed). 3 clusters (github-divergence, rbac/run-agents, policy/archived) came
back CLEAN. 4 survivors, all in the W1 decision-count / review-queue code. Each was then
re-verified by hand against the real authority code before fixing.

Fix commit: **7375cf1**. Full suite green (131 files / 1313 tests), typecheck clean, 13 e2e
green, dev boot + review queue browser-verified (schema-reconcile healed the new column cleanly).

## A — decision-count owner allowance over-counted · FIXED
`decisions.server.ts` folded a contributor-OWNER into `mine` for EVERY open decision on their
task. But the owner exception (Q2/R6-2, shared by `requireAcceptCompletion` + `resolvePacket`)
only covers **packets + accept_completion**. A `transition`/`assign_*`/`run_*` recommendation
needs approve-transition/run-agents to APPLY and resolve-packet to DISMISS — neither with an
owner exception — so a contributor-owner could act on NEITHER, yet was told "1 waiting on you"
and 403'd on both apply and dismiss (surfaced on Home, board chip/card, notifications, review).
- Fix: project the recommendation KINDS. New `task_projections.recommendation_kinds` column
  (`db/migrations/0001_baseline.sql`), populated by the rebuilder as
  `JSON.stringify(fm.recommendations.map(r => r.kind))`. schema-reconcile self-heals the column
  on existing DBs and `sqlite.server.ts` blanks content_hash → forces a full reproject.
- `decisionsRequiring`: an owned decision is `mine` only when `has_packet` OR the kinds include
  `accept_completion` (`hasAcceptCompletionRec`, tolerant JSON parse). Maintainer+ still holds
  every open decision (they can act on any).

## B — org-admin below-tier member dropped from overrideEligible · FIXED
`overrideEligible` fired only for `!role && orgAdmin` (non-members). But `resolveProjectAuthority`
grants the audited D2 override to an org admin whose OWN project role is insufficient — including
a below-tier MEMBER (e.g. an org admin added to a project as a viewer). Those decisions vanished
from both `mine` and `overrideEligible`.
- Fix: `else if (orgAdmin)` (covers non-member AND below-tier member). A maintainer+ org-admin
  still lands in `mine` via `canGovern` (own role suffices — not an override).

## C — review-queue `ready` mis-scoped + mislabeled a human-waiting task · FIXED
`getReviewQueue`'s `ready` ("Waiting on your acceptance") was keyed on the packet/rec-based
`mineTaskKeys`. A genuinely `waiting=human` review task with NO packet/rec (the operator couldn't
open a completion packet → `clearWaitingToHuman`) dropped out of `ready` for the maintainers/owners
who must accept it, AND landed in "Still in review" rendered "agent working" — false, no agent runs.
- Fix: scope `ready` by ACCEPTANCE AUTHORITY (maintainer+ OR owner), computed per review-stage
  task inside `getReviewQueue` from `viewerUserId` (was `mineTaskKeys`). Unscoped (no viewer) keeps
  the state-based split for tests/back-compat.
- `review-page.tsx`: a non-ready human-waiting row now reads "waiting on a human", never
  "agent working".

## D — stale doc comments · FIXED
`review-queue.server.ts` + `review-page.tsx` comments claiming a "project-wide, purely on waiting"
split were rewritten to the member-scoped (acceptance-authority) behavior.

## Live cross-role verification (2026-07-18, dev app)
Created a throwaway fixture VIB-900 on the `viberr` project: owned by Murat (a **contributor**),
one open decision = a `transition` recommendation, no packet. Projected correctly with
`recommendation_kinds = ["transition"]`. Then walked it across roles in the browser:
- **Murat (contributor-owner):** Home "1 waiting on you" on viberr (= VIB-4, a packet he CAN
  resolve); board "Waiting on me · 1"; VIB-900 card reads **"waiting on a human"** — excluded.
- **Elif (maintainer):** board "Waiting on me · 15"; VIB-900 card reads **"waiting on you"**
  (confirmed via DOM: `…Murat · owner…waiting on you`) — she can apply the transition rec.
The SAME task is attributed to the maintainer, never inflated onto the contributor-owner. Before
the fix Murat's count would have been 2 and VIB-900 would have read "waiting on you" for him.
Fixture removed afterward (data/ is gitignored; watcher dropped it from the projection).

## Live cross-role verification — Finding C (2026-07-18, dev app)
Throwaway fixture VIB-901 on `viberr`: a review-stage task at waiting=human with NO packet/rec
(the degenerate stall). Walked across roles:
- **Elif (maintainer):** review queue → VIB-901 under "**Waiting on your acceptance**" / "your
  acceptance". A maintainer can accept it.
- **Selin (viewer):** review queue → "Waiting on your acceptance" = **0 of 3** ("Nothing waits on
  you"); VIB-901 + the two real review tasks sit under "**Still in review**" labeled "**waiting on
  a human**" — NOT the pre-fix "agent working".
Also fixed a matching subline mislabel found during this walk: `reviewRowSub`'s no-packet/no-event
fallback said "Agent working — the packet arrives at the boundary" even on a human-waiting row; it
now reads "Waiting at the review boundary — needs a human decision" when waiting=human (verified
live on VIB-901; +4 unit tests in review-helpers.test.ts). Fixture removed afterward.

## Tests added (+9 → +13)
- decisions: contributor-owner does NOT hold a transition rec; DOES hold accept_completion;
  org-admin below-tier member → overrideEligible.
- review-queue: maintainer sees bare human-waiting in ready; viewer sees it in working still
  flagged human-waiting; contributor-owner sees theirs in ready; non-owner doesn't; unscoped
  stays state-based.
- review-page: a human-waiting working row labels "waiting on a human", never "agent working".
