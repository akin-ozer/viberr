import { PROJECT_ROLES, type ProjectRole } from "~/schemas/project-file.schema";

/**
 * THE single source of truth for project-role authorization.
 *
 * Every governed project action names a canonical `RbacAction`; this module maps
 * each action to the exact set of roles that hold it. The server guards
 * (`requireAction` in task-action-core.server.ts and its callers) consult this map,
 * and the Policy page's permission table renders the SAME object — so display and
 * enforcement can never drift. `policy-rbac.server.test.ts` drives each guard per
 * role to keep the two bound.
 *
 * Roles form a strict tier: viewer ⊂ contributor ⊂ maintainer ⊂ admin. Every
 * action here is monotonic (if a role holds it, every higher role does too), so
 * `ROLE_RANK` + a floor would suffice — but the explicit role list keeps the map
 * readable and lets the display table render role columns directly.
 *
 * MEMBERSHIP is the outer gate on every action here (R15-4): a project is
 * visible only to its members (plus org admins, as the audited D2 override), and
 * a non-member is refused with the unknown-slug 404 — by the layout loader
 * (routes/project.tsx) on reads and by `requireVisibleProject` on every
 * project-scoped action. `view` and `comment` are the two actions no role tier
 * narrows: every role holds them, so their entire enforcement IS that membership
 * gate (they never call `requireAction`). That is NOT the pre-R15-4 "any
 * authenticated user, member or not" — the claim this file and the Policy page
 * both carried until E1, while enforcement had already been 404ing non-members.
 */

export { PROJECT_ROLES, type ProjectRole };

export const ROLE_RANK = {
  viewer: 0,
  contributor: 1,
  maintainer: 2,
  admin: 3,
} satisfies Record<ProjectRole, number>;

export const ROLE_LABEL = {
  admin: "Admin",
  maintainer: "Maintainer",
  contributor: "Contributor",
  viewer: "Viewer",
} satisfies Record<ProjectRole, string>;

const A = "admin" as const;
const M = "maintainer" as const;
const C = "contributor" as const;
const V = "viewer" as const;

/**
 * One source for enforcement and the Policy/Profile permission tables.
 *
 * The first two rows are held by all four roles — nothing about them is
 * role-gated — so they render as ordinary four-check rows. They used to carry an
 * `appWide` flag that made the Policy page draw one merged "Any signed-in user ·
 * membership not required" cell; post-R15-4 that sentence was simply false (a
 * signed-in non-member gets a 404 on every page of this project, comments
 * included), and the flag existed only to render it. Membership scope is stated
 * once, under the table, where it applies to every row.
 */
export const RBAC_DEFINITIONS = [
  { id: "view", label: "View board, tasks & timelines", roles: [A, M, C, V] },
  { id: "comment", label: "Comment on tasks", roles: [A, M, C, V] },
  { id: "create-task", label: "Create tasks", roles: [A, M, C] },
  { id: "own-task", label: "Take / release own task ownership", roles: [A, M, C] },
  // Lightweight planning attributes (priority, labels, due date) — a contributor
  // who can create and own a task also grooms its metadata. Distinct from
  // `update-goal` ([A,M]): the goal is the reviewable acceptance contract, and
  // three of the four things here are scheduling metadata that changes no gate.
  // Ruling 309(a): the label named three of the four things this gates, and the
  // fourth is not like the others — `setTaskDependencies` runs on this action
  // too (dependencies.server.ts), and clearing what a task waits on RELEASES a
  // held task onto the board. A table saying "priority, labels & due date" tells
  // a contributor they may tidy, when they may also unblock. The label stays
  // short because eight sentences on two pages read it inline as "the X grant";
  // `covers` is where the rest of the truth goes.
  {
    id: "edit-task-meta",
    label: "Edit task priority, labels & due date",
    // Ruling 503: and which epic the task is in, which is planning metadata
    // exactly like a label.
    covers: "the epic a task is in, and what it waits on, which releases it when cleared",
    roles: [A, M, C],
  },
  // F39-6 (pass 39): attaching a file to a task. Same tier as the metadata a
  // contributor already grooms, and for the same reason: it adds evidence to a
  // task and changes no gate. Its own row rather than a rider on
  // `edit-task-meta`, because a table that gates attachments under a label
  // reading "priority, labels & due date" answers "who can attach the
  // fixture?" nowhere — which is the mistake ruling 309(a) corrected for
  // dependencies.
  { id: "attach-file", label: "Attach a file to a task", roles: [A, M, C] },
  // Ruling 503: an epic is planning, held by every role that can create the
  // tasks it groups. Putting a task in one or taking it out is the task's own
  // metadata (`edit-task-meta` above), so this row is the epic itself: its
  // name, description, status, colour, lead and dates. There is no delete.
  {
    id: "manage-epics",
    label: "Create & edit epics",
    covers: "their status, lead and dates",
    roles: [A, M, C],
  },
  { id: "approve-transition", label: "Approve stage transitions", roles: [A, M] },
  { id: "resolve-packet", label: "Resolve decision packets", roles: [A, M] },
  { id: "accept-completion", label: "Accept completion → Done", roles: [A, M] },
  { id: "update-goal", label: "Edit the task goal", roles: [A, M] },
  { id: "run-agents", label: "Run agents", roles: [A, M] },
  { id: "reorder-board", label: "Reorder the board", roles: [A, M] },
  { id: "reconcile-github", label: "Reconcile GitHub state", roles: [A, M] },
  // Interface review 2026-09-24 (writ-6): the label was "Grant GitHub scope",
  // which Viberr cannot do — this gates re-checking the credential's scopes and
  // setting or clearing it. The id stays: guards and routes name it.
  { id: "grant-github-scope", label: "Manage the GitHub credential", roles: [A, M] },
  { id: "rescan-project", label: "Re-scan project files & projections", roles: [A, M] },
  { id: "release-any-ownership", label: "Release any task owner", roles: [A] },
  { id: "manage-members", label: "Manage members & roles", roles: [A] },
  { id: "manage-agents", label: "Manage agent profiles", roles: [A] },
  // Ruling 525: deleting a controller conversation somebody else started,
  // when it is about this project (bound to its board or anchored to one of
  // its tasks). The person who started one may always delete it and an org
  // admin may delete any, so neither needs this row, and a conversation about
  // no project has no project role to hold it.
  {
    id: "delete-controller-conversations",
    label: "Delete anyone's controller conversations",
    covers: "the ones about this project's board and tasks; everyone may delete their own",
    roles: [A],
  },
  // Ruling 309(a): also the gate on archiving and restoring a project
  // (`setProjectArchived`), which the label named nowhere — so "who can
  // unarchive this?" had no answer on the page that exists to answer it.
  {
    id: "edit-policy",
    label: "Edit workflow & policy",
    covers: "and archiving or restoring the project itself",
    roles: [A],
  },
  // Ruling 582: taking a file off a task's record: a secret, or a benchmark's
  // answer key, where agents and people read it. Ruling 584 gave a comment's
  // words to the operator instead.
  { id: "remove-from-record", label: "Remove a file from a task", roles: [A] },
  // Admin-only override of the required-reviewer / blocked-packet acceptance gate
  // (DG-2). A stuck task — e.g. a required reviewer that can no longer record a
  // verdict — is otherwise permanently un-acceptable; this is the audited escape
  // hatch, stricter than plain accept-completion. Narrowest grant → table tail.
  { id: "force-accept-completion", label: "Force-accept past the review gate", roles: [A] },
] as const satisfies readonly {
  id: string;
  label: string;
  /** What this action ALSO gates, when the grant name does not carry it.
   *  Ruling 309(a): the name is used inline ("the X grant") and has to stay
   *  short; the scope still has to be somewhere a person and a model can read. */
  covers?: string;
  roles: readonly ProjectRole[];
}[];

export type RbacAction = (typeof RBAC_DEFINITIONS)[number]["id"];

export const ACTION_ROLES = new Map<RbacAction, readonly ProjectRole[]>(
  RBAC_DEFINITIONS.map(
    ({ id, roles }): [RbacAction, readonly ProjectRole[]] => [id, roles],
  ),
);

/** Does this project role hold this action? A null role (non-member) never does. */
export function roleCan(role: ProjectRole | null | undefined, action: RbacAction): boolean {
  if (!role) return false;
  return rolesForAction(action).includes(role);
}

/** The roles that hold an action (for rendering + for building guard allow-lists). */
export function rolesForAction(action: RbacAction): readonly ProjectRole[] {
  const roles = ACTION_ROLES.get(action);
  // Every `RbacAction` is an id of RBAC_DEFINITIONS, which is what the map is
  // built from — a miss means an action string reached here past the type.
  if (!roles) throw new Error(`unknown RBAC action: ${action}`);
  return roles;
}
