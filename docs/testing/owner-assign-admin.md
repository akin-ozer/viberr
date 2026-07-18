> Scope: pass-9 QA test-case note — T02 owner-assign by admin

# T02 — owner-assign by admin

This file was added by a Viberr agent during the 2026-07-18 pass-9 QA run,
task VIB-24. It records the exercised behavior for the "owner-assign by
admin" test case (T02): an admin hands task ownership to another project
member, or releases the current owner's seat, without being the owner
themselves.

## What was verified

- `setOwner` (`app/server/tasks/task-actions.server.ts`) allows a hand-off
  when the actor is either the current owner or holds the `release-any-
  ownership` grant (admin only, per `app/shared/rbac.ts`). The target must
  be a project member who can hold ownership (contributor or above).
- `releaseOwner` lets an admin clear another member's owner seat even when
  the admin never held it themselves; the event copy and audit action
  (`task.ownership.admin_released`) distinguish this from a self-release.
- The task-detail "Manage" menu (`app/features/task-detail/execution-
  profile.tsx`) and the release-confirm dialog
  (`app/features/task-detail/release-confirm.tsx`) surface the hand-off/
  release controls to an admin who is not the current owner, labeling the
  action "admin release" in the UI.
- Both mutations write a typed `assign` timeline event and a `recordAudit`
  entry, matching the project's governed-action convention.

## Where the behavior lives

| Concern | File |
| --- | --- |
| RBAC grant (`release-any-ownership`, `own-task`) | `app/shared/rbac.ts` |
| Take/hand-off/release server actions | `app/server/tasks/task-actions.server.ts` |
| Owner control UI + hand-off menu | `app/features/task-detail/execution-profile.tsx` |
| Release confirm dialog | `app/features/task-detail/release-confirm.tsx` |

Last reviewed: 2026-07-18
