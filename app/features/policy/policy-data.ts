import { ALWAYS_HUMAN_CAPABILITY_IDS, capabilityById } from "~/shared/capabilities";

/**
 * Client-safe policy constants: the 4 project roles, the 9-row RBAC grant
 * table (contracts §3.2 VERBATIM — canonical permission catalog,
 * display-only in the UI), and the workflow-boundary vocabulary
 * (contracts §2.5).
 */

export const ROLE_IDS = ["admin", "maintainer", "contributor", "viewer"] as const;
export type RoleId = (typeof ROLE_IDS)[number];

export const ROLE_LABEL: Record<RoleId, string> = {
  admin: "Admin",
  maintainer: "Maintainer",
  contributor: "Contributor",
  viewer: "Viewer",
};

export interface RbacRow {
  action: string;
  grant: Record<RoleId, 0 | 1>;
}

/**
 * PROJECT_CAP_MATRIX — the single source of truth for what each project role
 * may do. Each row lists the roles that hold the capability; every entry maps
 * to a real server gate (`requireMemberRole` / `requireRuntimeRole` /
 * `requireProjectAdmin`). The displayed RBAC table below is derived from this,
 * and `policy-rbac.server.test.ts` drives each guard per role to prove the
 * table can't drift from enforcement. Order: broadest grant → narrowest.
 *
 * The one distinction the old table hid: `contributor` may create tasks,
 * `viewer` may not (task-actions.server.ts createTask viewer gate).
 */
export const PROJECT_CAP_MATRIX: readonly {
  action: string;
  roles: readonly RoleId[];
}[] = [
  { action: "View board, tasks & timelines", roles: ["admin", "maintainer", "contributor", "viewer"] },
  { action: "Comment on tasks (app-wide)", roles: ["admin", "maintainer", "contributor", "viewer"] },
  { action: "Take / release own task ownership", roles: ["admin", "maintainer", "contributor", "viewer"] },
  { action: "Create tasks", roles: ["admin", "maintainer", "contributor"] },
  { action: "Approve stage transitions", roles: ["admin", "maintainer"] },
  { action: "Resolve decision packets", roles: ["admin", "maintainer"] },
  { action: "Accept completion → Done", roles: ["admin", "maintainer"] },
  { action: "Run agents & reorder the board", roles: ["admin", "maintainer"] },
  { action: "Release any task owner", roles: ["admin"] },
  { action: "Manage members & roles", roles: ["admin"] },
  { action: "Edit workflow & policy", roles: ["admin"] },
];

/** RBAC grant table — derived from PROJECT_CAP_MATRIX (never hand-maintained). */
export const RBAC_ROWS: readonly RbacRow[] = PROJECT_CAP_MATRIX.map((cap) => ({
  action: cap.action,
  grant: Object.fromEntries(
    ROLE_IDS.map((r) => [r, cap.roles.includes(r) ? 1 : 0]),
  ) as Record<RoleId, 0 | 1>,
}));

export type BoundaryId = "auto" | "approval" | "human";

export const BOUNDARIES: readonly { id: BoundaryId; label: string }[] = [
  { id: "auto", label: "Auto-advance" },
  { id: "approval", label: "Human approval" },
  { id: "human", label: "Human only" },
];

/** Boundary → cap-seg CSS class (deliberate color-language reuse —
 * contracts §2.5: auto→teal `direct`, approval→blue `recommend`,
 * human→coral `human`. Do NOT "fix" to semantic names). */
export const BCLS: Record<BoundaryId, string> = {
  auto: "direct",
  approval: "recommend",
  human: "human",
};

/** "Always reserved for humans" — rendered from the server invariant list
 * (ruling 2), never hard-coded UI strings. */
export const ALWAYS_HUMAN_LABELS: readonly string[] =
  ALWAYS_HUMAN_CAPABILITY_IDS.map((id) => capabilityById(id)?.label ?? id);
