import { ALWAYS_HUMAN_CAPABILITY_IDS, capabilityById } from "~/shared/capabilities";

/**
 * Client-safe policy constants: the 4 project roles, the 9-row RBAC grant
 * table (contracts §3.2 VERBATIM — canonical permission catalog,
 * display-only in the UI), and the workflow-boundary vocabulary
 * (contracts §2.5).
 */

export const ROLE_IDS = ["admin", "maintainer", "reviewer", "viewer"] as const;
export type RoleId = (typeof ROLE_IDS)[number];

export const ROLE_LABEL: Record<RoleId, string> = {
  admin: "Admin",
  maintainer: "Maintainer",
  reviewer: "Reviewer",
  viewer: "Viewer",
};

export interface RbacRow {
  action: string;
  grant: Record<RoleId, 0 | 1>;
}

/** The 9-row RBAC grant table — contracts §3.2, verbatim. Display-only. */
export const RBAC_ROWS: readonly RbacRow[] = [
  { action: "View board, tasks & timelines", grant: { admin: 1, maintainer: 1, reviewer: 1, viewer: 1 } },
  { action: "Comment on tasks (app-wide)", grant: { admin: 1, maintainer: 1, reviewer: 1, viewer: 1 } },
  { action: "Take / release task ownership", grant: { admin: 1, maintainer: 1, reviewer: 1, viewer: 1 } },
  { action: "Release any task owner", grant: { admin: 1, maintainer: 0, reviewer: 0, viewer: 0 } },
  { action: "Approve stage transitions", grant: { admin: 1, maintainer: 1, reviewer: 0, viewer: 0 } },
  { action: "Accept completion → Done", grant: { admin: 1, maintainer: 1, reviewer: 0, viewer: 0 } },
  { action: "Open agent runtime sessions", grant: { admin: 1, maintainer: 1, reviewer: 0, viewer: 0 } },
  { action: "Manage members & roles", grant: { admin: 1, maintainer: 0, reviewer: 0, viewer: 0 } },
  { action: "Edit workflow & policy", grant: { admin: 1, maintainer: 0, reviewer: 0, viewer: 0 } },
];

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
