# Cross-role UI walkthrough (2026-07-18, dev app, live)

Requested follow-up: live-verify the remaining decision-count finding (B) and do a role-by-role
governance-control walkthrough with screenshots. Done on the seeded `viberr` project (members:
arda=admin, elif=maintainer, murat/deniz=contributor, selin=viewer). Throwaway fixtures + one
temporary org-role flip, all reverted; `data/` is gitignored so nothing touched the repo.

## Finding B — org-admin below-tier member → overrideEligible (LIVE-VERIFIED)
Temporarily promoted selin (a viberr **viewer**) to **org admin** (member table role='admin'),
making her a below-tier-member org-admin — the exact Finding B case. Result on her Home:
- Headline "**0 decisions waiting on you**" (a viewer has no personal inbox here) — correct.
- viberr card "**14 override-available**" (all 14 real open decisions, reachable only via the
  audited D2 override) — surfaced, not silently dropped.
Before the fix these 14 would have been dropped from BOTH lists (card shows nothing). Reverted
selin to org member afterward; as a plain viewer she then correctly shows no override chip and 0
decisions. (14 = the live open-decision count after the VIB-900 fixture was removed; 15→14.)

## RBAC governance-control gating (task detail VIB-4, viewer vs maintainer) — CLEAN
Same task, compared as selin (viewer, non-owner) vs elif (maintainer):
| Control | Viewer | Maintainer | Tier |
| --- | --- | --- | --- |
| Stage transition (Current-state "Stage" chip) | static text | clickable "In Progress ›" | approve-transition (M+) |
| Goal **Edit** button | absent | present | update-goal (M+) |
| Packet **Confirm decision** (resolve) | absent | present | resolve-packet (M+) |
| Packet option radios (preview) | present (selectable) | present | presentational — not the action |
| **Ask operator** | present | present | any member |
| Comment box | present | present | comment (app-wide) |

Findings:
- Every governed MUTATION control is HIDDEN for lower roles (`decision-packet.tsx:155`
  `if (!canResolve) return null` for the Confirm button; Stage/Edit affordances likewise gated),
  matching the documented "the UI hides the control from lower roles" intent — NOT a
  show-then-403 trap. The option radios a viewer can click are pure selection (role="radio"),
  with no resolve submit rendered.
- The task-detail **Permissions panel** ("V1 rules") transparently shows each viewer their own
  role + per-capability access ("Your role: Viewer", "Comments: Every registered user", "Task
  ownership: View only — contributor+ to own"). Good honesty affordance.
- accept_completion within a packet is additionally gated (`canResolveCompletion`): an owner-only
  contributor gets `canResolve` but the button is disabled with title "Accepting completion is
  reserved for maintainers" rather than a 403 — correct.

No mock/broken/ungated governance affordance found on the task-detail surface. RBAC UI gating is
consistent with the server enforcement (`ACTION_ROLES`).
