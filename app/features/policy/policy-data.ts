import { ALWAYS_HUMAN_CAPABILITY_IDS, capabilityById } from "~/shared/capabilities";
import {
  PROJECT_ROLES,
  RBAC_DEFINITIONS,
  type ProjectRole,
} from "~/shared/rbac";
export { ROLE_LABEL } from "~/shared/rbac";

/**
 * Client-safe policy constants for the Policy/Profile UI. The role list, labels,
 * and the RBAC permission table all come from the ONE canonical source
 * (app/shared/rbac.ts) that the server guards also consult — display can't drift
 * from enforcement. `policy-rbac.server.test.ts` drives each guard per role to
 * keep them bound.
 */

export const ROLE_IDS = PROJECT_ROLES;

export interface RbacRow {
  action: string;
  grant: Record<ProjectRole, 0 | 1>;
  /** App-wide (any signed-in user, member or not) — the role columns are
   * informational; the UI renders these as app-wide, not role-gated. */
  appWide?: boolean;
}

export const RBAC_ROWS: readonly RbacRow[] = RBAC_DEFINITIONS.map((cap) => ({
  action: cap.label,
  grant: Object.fromEntries(
    ROLE_IDS.map((r) => [
      r,
      (cap.roles as readonly ProjectRole[]).includes(r) ? 1 : 0,
    ]),
  ) as Record<ProjectRole, 0 | 1>,
  ...("appWide" in cap ? { appWide: cap.appWide } : {}),
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
 * (ruling 2), never hard-coded UI strings.
 *
 * P13-D-PRD-3: the rows used to be bare labels under an unqualified
 * "all profiles" pill. Every capability in the list is scoped to `agent`
 * profiles, and one of them — Transition a task to Done — has a real,
 * deliberate operator exception (full autonomy + an explicit
 * `completion-for-acceptance: direct` grant). The page disclosed that
 * exception 150 lines lower while flatly contradicting it here. */
export const ALWAYS_HUMAN_ROWS: readonly {
  id: string;
  label: string;
  /** Set when a non-agent profile can reach this action under a named policy. */
  exception: string | null;
}[] = ALWAYS_HUMAN_CAPABILITY_IDS.map((id) => ({
  id,
  label: capabilityById(id)?.label ?? id,
  exception:
    id === "transition-to-done"
      ? "except an operator at full autonomy with an explicit Accept completion into Done grant — see below"
      : null,
}));
