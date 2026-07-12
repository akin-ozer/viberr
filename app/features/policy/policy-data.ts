import { ALWAYS_HUMAN_CAPABILITY_IDS, capabilityById } from "~/shared/capabilities";
import {
  PROJECT_ROLES,
  RBAC_TABLE,
  ROLE_LABEL as RBAC_ROLE_LABEL,
  type ProjectRole,
} from "~/shared/rbac";

/**
 * Client-safe policy constants for the Policy/Profile UI. The role list, labels,
 * and the RBAC permission table all come from the ONE canonical source
 * (app/shared/rbac.ts) that the server guards also consult — display can't drift
 * from enforcement. `policy-rbac.server.test.ts` drives each guard per role to
 * keep them bound.
 */

export const ROLE_IDS = PROJECT_ROLES;
/** @deprecated use `ProjectRole` from ~/shared/rbac */
export type RoleId = ProjectRole;

export const ROLE_LABEL: Record<RoleId, string> = RBAC_ROLE_LABEL;

export interface RbacRow {
  action: string;
  grant: Record<RoleId, 0 | 1>;
}

/**
 * PROJECT_CAP_MATRIX — the display projection of the canonical `RBAC_TABLE`
 * (app/shared/rbac.ts). Kept as a named export for the Policy + Profile pages;
 * the authoritative role sets live in `ACTION_ROLES`.
 */
export const PROJECT_CAP_MATRIX: readonly {
  action: string;
  roles: readonly RoleId[];
}[] = RBAC_TABLE;

/** RBAC grant table — derived from the canonical table (never hand-maintained). */
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
