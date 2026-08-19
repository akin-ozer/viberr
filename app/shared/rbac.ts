import { PROJECT_ROLES, type ProjectRole } from "~/schemas/project-file.schema";

/**
 * THE single source of truth for project-role authorization.
 *
 * Every governed project action names a canonical `RbacAction`; this module maps
 * each action to the exact set of roles that hold it. The server guards
 * (`requireAction` in task-actions.server.ts and its callers) consult this map,
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
  { id: "approve-transition", label: "Approve stage transitions", roles: [A, M] },
  { id: "resolve-packet", label: "Resolve decision packets", roles: [A, M] },
  { id: "accept-completion", label: "Accept completion → Done", roles: [A, M] },
  { id: "update-goal", label: "Edit the task goal", roles: [A, M] },
  { id: "run-agents", label: "Run agents", roles: [A, M] },
  { id: "reorder-board", label: "Reorder the board", roles: [A, M] },
  { id: "reconcile-github", label: "Reconcile GitHub state", roles: [A, M] },
  { id: "grant-github-scope", label: "Grant GitHub scope", roles: [A, M] },
  { id: "rescan-project", label: "Re-scan project files & projections", roles: [A, M] },
  { id: "release-any-ownership", label: "Release any task owner", roles: [A] },
  { id: "manage-members", label: "Manage members & roles", roles: [A] },
  { id: "manage-agents", label: "Manage agent profiles", roles: [A] },
  { id: "edit-policy", label: "Edit workflow & policy", roles: [A] },
  // Admin-only override of the required-reviewer / blocked-packet acceptance gate
  // (DG-2). A stuck task — e.g. a required reviewer that can no longer record a
  // verdict — is otherwise permanently un-acceptable; this is the audited escape
  // hatch, stricter than plain accept-completion. Narrowest grant → table tail.
  { id: "force-accept-completion", label: "Force-accept past the review gate", roles: [A] },
] as const satisfies readonly {
  id: string;
  label: string;
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
