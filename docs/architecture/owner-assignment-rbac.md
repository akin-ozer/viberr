> Scope: how task owner assignment works, and the RBAC rules that govern who
> may assign, hand off, release, or act through a task owner.

# Task ownership and RBAC

This is the canonical reference for task ownership (the single human
reviewer/acceptance seat on a task) and the project-role RBAC that governs it.
It is grounded directly in the enforcement code, not the UI copy alone, so it
should never drift from server behavior:

- Role catalog and action grants: `app/shared/rbac.ts`
- Ownership mutations (`setOwner`, `releaseOwner`) and the owner exception:
  `app/server/tasks/task-actions.server.ts`
- Membership + org-admin-override resolution:
  `app/server/auth/project-authority.server.ts`
- Stored field: `ownerUserId` in `task.md` frontmatter — see
  [`file-formats.md`](file-formats.md#2-projectsslugtaskskeytaskmd)

## 1. What "owner" means

A task has at most **one human owner**, stored as `ownerUserId` in the task's
frontmatter (`null` when unowned). The owner is that task's designated human
reviewer and acceptance authority — scoped to that task only, independent of
their project-wide role. Ownership is orthogonal to specialists/consultants
(agents doing the work) and to the operator (which schedules execution); it
answers "who reviews and accepts this task," not "who implements it."

## 2. The project role tiers

Roles are strictly ordered (`app/shared/rbac.ts`, `ROLE_RANK`): a higher tier
holds every grant of the tiers below it.

| Role | Rank | Summary |
|---|---|---|
| Viewer | 0 | Read board/tasks/timelines + comment only. Cannot own a task. |
| Contributor | 1 | Full task work: create tasks, take/release ownership, reconcile GitHub. |
| Maintainer | 2 | Everything Contributor has, plus approvals, packet resolution, accepting completions, running agents, reordering the board, editing the goal, granting GitHub scope, re-scanning the project. |
| Admin | 3 | Everything Maintainer has, plus releasing *any* member's ownership, managing members/roles, managing agent profiles, editing workflow/policy. |

`view` and `comment` are app-wide grants (any authenticated user, member or
not) — they are listed in the grant table for display but are **not**
enforced by the project-role guard (`requireAction`); they use a separate
"authenticated user" check.

## 3. Who can take, hand off, and release ownership

Enforcement lives in `setOwner` / `releaseOwner`
(`app/server/tasks/task-actions.server.ts`), gated by the `own-task` and
`release-any-ownership` RBAC actions.

### Take ownership (including taking over from someone else)

- Requires the `own-task` grant: **Contributor, Maintainer, or Admin.**
  Viewers cannot hold the owner seat.
- Any member holding `own-task` may take an **unowned** task, or take over
  from the current owner (self-assignment always allowed for anyone who
  qualifies to own).
- Taking ownership is idempotent: assigning yourself when you already own
  the task is a no-op (no duplicate timeline event).

### Hand off ownership to someone else

- Requires the `own-task` grant to act at all, **and** one of:
  - you are the **current owner**, or
  - you hold `release-any-ownership` (**Admin only**).
- The **target** must be a project member who themselves holds `own-task`
  (Contributor+). You cannot hand ownership to a Viewer or a non-member.

### Release ownership

- Releasing **your own** seat requires `own-task` (Contributor+).
- Releasing **someone else's** seat requires `release-any-ownership`
  (**Admin only**) — recorded as an explicit admin action in both the
  timeline event copy and the audit trail (`task.ownership.admin_released`).
- Releasing an already-unowned task is a no-op, but still requires live
  project membership (`requireAnyMember`) — a non-member cannot probe task
  state through this path.

### Summary table

| Action | Who |
|---|---|
| Take an unowned task | Any member with `own-task` (Contributor+) |
| Take over from another owner | Any member with `own-task` (Contributor+) |
| Hand off to another member | Current owner, or Admin (`release-any-ownership`) — target must hold `own-task` |
| Release your own ownership | Owner themself (`own-task`) |
| Release another member's ownership | Admin only (`release-any-ownership`) |

## 4. The owner exception: acting as owner beyond `own-task`

Two governed actions carry a special **owner exception** (`ownerException()`
in `task-actions.server.ts`, owner rulings Q2 and R6-2): the task's owner may
perform them regardless of their project-role tier, as long as they *still*
hold live `own-task` membership.

- **Resolve a decision packet** (`resolve-packet`, normally Maintainer+): the
  packet is addressed to the owner, so a Contributor who owns the task may
  resolve it without a 403 — except the `accept_completion` option, which is
  always gated by the next rule.
- **Accept a completion into Done** (`accept-completion`, normally
  Maintainer+): the owner may accept their own task's completion even as a
  Contributor, mirroring "the owner reviews & accepts."

The exception is **not** a blanket bypass:

- It requires the actor's **current** live project role to still satisfy
  `own-task` (Contributor+). A member who owned the task, was then demoted to
  Viewer or removed from the project, no longer qualifies — even though
  `ownerUserId` still names them until someone releases or reassigns the
  seat.
- It never applies to the operator (`ctx.operatorAuthorized` short-circuits
  it) — the operator is gated by its own capability policy, not by the
  human-ownership exception.
- Moving a task's stage to Done remains the human-only boundary regardless of
  role or ownership by construction (`transitionStage`'s `human` boundary
  type); the owner exception only widens *who* may exercise that human
  authority, it does not let an agent exercise it.

## 5. Cross-cutting rules that apply to every ownership action

- **Archived projects are read-only** (`requireProjectMutable`, ruling R6-3):
  every ownership mutation is refused with a 409 until the project is
  restored. Reads (viewing the current owner) are unaffected.
- **Org-admin emergency override** (`resolveProjectAuthority`, ruling D2): an
  org-level admin whose *project* membership would otherwise be denied (or
  who isn't a project member at all) is still granted admin-equivalent
  authority for that one action. Every such override writes a
  `project.org_admin.override` audit row naming the action and project — it
  is never silent. An org admin whose own project membership already
  qualifies is not treated as an override (no extra row).
- **Every ownership change is dual-recorded**: a typed `assign` timeline
  event on the task (visible copy differs for take / take-over / hand-off /
  release / admin-release) and a structured audit row
  (`task.ownership.taken`, `task.ownership.handed_off`,
  `task.ownership.released`, or `task.ownership.admin_released`) carrying the
  previous and new owner IDs.
- **A task gaining its first owner can trigger operator scheduling**: if a
  quality-gated task was waiting only on a human owner, assigning that owner
  flips `readiness`/`waiting` and lets the operator take over scheduling
  (`operatorSchedulesOnOwner` in `task-actions.server.ts`). This is a
  side effect of taking ownership on an *unowned* task only — handing off an
  already-owned task never re-triggers it.

## 6. Edge cases

| Scenario | Behavior |
|---|---|
| Take ownership of a task you already own | No-op; no timeline/audit event written. |
| Hand off to a Viewer or non-member | Rejected — target must hold `own-task` (Contributor+). |
| Release ownership of an unowned task | No-op, but still requires live project membership. |
| Owner is demoted to Viewer (or removed from the project) | `ownerUserId` still names them, but they lose the owner exception (packet resolution / completion acceptance) and lose `own-task` (cannot re-take or hand off). An Admin (or org-admin override) must release/reassign the seat. |
| Owner tries to accept completion on their own task as a Contributor | Allowed — the owner exception grants `accept-completion` for that task only, not project-wide. |
| Non-owner Contributor tries to resolve a packet or accept a completion | Denied — falls through to the normal `resolve-packet` / `accept-completion` grant (Maintainer+). |
| Project is archived | Every ownership mutation (take/hand-off/release) is refused with a 409 until restored. |
| Org admin acts on a project they're not a member of | Granted admin-equivalent authority via the D2 override; the override is audited. |

## 7. Where this is displayed

The Policy page (`app/features/policy/policy-page.tsx`) renders the same
`ACTION_ROLES` map from `app/shared/rbac.ts` as a human-access grant table
("Take / release own task ownership", "Release any task owner", etc.), so
the UI and the server guard can never drift from each other by
construction. `docs/build/specs/policy.md` and
`docs/build/specs/task-detail.md` describe the pre-implementation UI/UX
design for the Policy screen and the task-detail ownership control
(`OwnerControl`, `ReleaseConfirm`) in more presentation detail; note those
spec documents predate the `reviewer` → `contributor` role rename and still
use the old role name in places — this document and the current code are the
source of truth for role names and enforcement.

Last reviewed: 2026-07-18
