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
 * Two actions (`view`, `comment`) are app-wide by FR4: any *authenticated* user,
 * member or not, may read boards/tasks and comment. They appear here (granted to
 * all four roles) so the Policy table can show them, but their server enforcement
 * is "authenticated", not "member of this project" — the guards for those do NOT
 * call requireAction.
 */

export { PROJECT_ROLES, type ProjectRole };

export const ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 0,
  contributor: 1,
  maintainer: 2,
  admin: 3,
};

export const ROLE_LABEL: Record<ProjectRole, string> = {
  admin: "Admin",
  maintainer: "Maintainer",
  contributor: "Contributor",
  viewer: "Viewer",
};

/** Every governed project action. Server guards pass one of these to `requireAction`. */
export type RbacAction =
  // app-wide (any authenticated user — NOT gated by requireAction; here for display)
  | "view"
  | "comment"
  // contributor+ (Q5 clean tiering: viewer is strictly read + comment)
  | "create-task"
  | "own-task" // take / release one's OWN task ownership
  // maintainer+
  | "approve-transition"
  | "resolve-packet" // non-completion; the task owner (contributor+) is additionally allowed at the call site
  | "accept-completion"
  | "run-agents" // assign/run specialist+reviewer, @mention trigger, run operator, interrupt a run
  | "reorder-board"
  | "update-goal"
  | "grant-github-scope"
  | "reconcile-github" // re-derives canonical state from GitHub — maintainer+ (R8-4: aligned with rescan-project)
  | "rescan-project" // board re-scan: rebuild projections from the file store
  // admin only
  | "release-any-ownership"
  | "manage-members"
  | "manage-agents" // agent profile CRUD
  | "edit-policy"; // workflow boundaries, role assignment
// note: "edit-settings" (identity/stages/repo/archive/delete) is admin and shares
// the "edit-policy" tier; project settings actions use requireProjectAdmin → edit-policy.

const A = "admin" as const;
const M = "maintainer" as const;
const C = "contributor" as const;
const V = "viewer" as const;

/**
 * The canonical action → allowed-roles map. This is the object the Policy page
 * renders AND the object every server guard consults.
 */
export const ACTION_ROLES: Record<RbacAction, readonly ProjectRole[]> = {
  view: [A, M, C, V],
  comment: [A, M, C, V],

  "create-task": [A, M, C],
  "own-task": [A, M, C],

  "approve-transition": [A, M],
  "resolve-packet": [A, M],
  "accept-completion": [A, M],
  "run-agents": [A, M],
  "reorder-board": [A, M],
  "update-goal": [A, M],
  "grant-github-scope": [A, M],
  "reconcile-github": [A, M],
  "rescan-project": [A, M],

  "release-any-ownership": [A],
  "manage-members": [A],
  "manage-agents": [A],
  "edit-policy": [A],
};

/** Does this project role hold this action? A null role (non-member) never does. */
export function roleCan(role: ProjectRole | null | undefined, action: RbacAction): boolean {
  if (!role) return false;
  return ACTION_ROLES[action].includes(role);
}

/** The roles that hold an action (for rendering + for building guard allow-lists). */
export function rolesForAction(action: RbacAction): readonly ProjectRole[] {
  return ACTION_ROLES[action];
}

/**
 * The Policy-page permission table: human-readable rows, each derived from the
 * canonical map above so the UI shows exactly what the server enforces. Order:
 * broadest grant → narrowest. Every enforced `RbacAction` appears here (nothing
 * silently omitted). `appWide` rows are granted to any *authenticated* user
 * regardless of project membership — the role columns are informational only,
 * and the UI must render them as app-wide rather than role-gated.
 */
export const RBAC_TABLE: readonly {
  action: string;
  roles: readonly ProjectRole[];
  /** True for `view`/`comment`: any signed-in user, member or not (FR4). */
  appWide?: boolean;
}[] = [
  { action: "View board, tasks & timelines", roles: ACTION_ROLES.view, appWide: true },
  { action: "Comment on tasks", roles: ACTION_ROLES.comment, appWide: true },
  { action: "Create tasks", roles: ACTION_ROLES["create-task"] },
  { action: "Take / release own task ownership", roles: ACTION_ROLES["own-task"] },
  { action: "Approve stage transitions", roles: ACTION_ROLES["approve-transition"] },
  { action: "Resolve decision packets", roles: ACTION_ROLES["resolve-packet"] },
  { action: "Accept completion → Done", roles: ACTION_ROLES["accept-completion"] },
  { action: "Edit the task goal", roles: ACTION_ROLES["update-goal"] },
  { action: "Run agents", roles: ACTION_ROLES["run-agents"] },
  { action: "Reorder the board", roles: ACTION_ROLES["reorder-board"] },
  { action: "Reconcile GitHub state", roles: ACTION_ROLES["reconcile-github"] },
  { action: "Grant GitHub scope", roles: ACTION_ROLES["grant-github-scope"] },
  { action: "Re-scan project files & projections", roles: ACTION_ROLES["rescan-project"] },
  { action: "Release any task owner", roles: ACTION_ROLES["release-any-ownership"] },
  { action: "Manage members & roles", roles: ACTION_ROLES["manage-members"] },
  { action: "Manage agent profiles", roles: ACTION_ROLES["manage-agents"] },
  { action: "Edit workflow & policy", roles: ACTION_ROLES["edit-policy"] },
];
