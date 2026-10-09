import { ALWAYS_HUMAN_CAPABILITY_IDS, capabilityById } from "~/shared/capabilities";
import { RBAC_DEFINITIONS, type ProjectRole } from "~/shared/rbac";
import type { AgentProfileView } from "~/features/agents/agent-types";

/**
 * Client-safe policy constants for the Policy/Profile UI. The RBAC permission
 * table is built from the ONE canonical source (app/shared/rbac.ts) that the
 * server guards also consult, and the UI reads the role list and labels
 * (`PROJECT_ROLES`, `ROLE_LABEL`) straight from there — display can't drift
 * from enforcement. `policy-rbac.server.test.ts` drives each guard per role to
 * keep them bound.
 *
 * Every row is a grant WITHIN a project the reader is a member of — the two
 * surfaces state that in their own copy (E1). A row is never a claim about who
 * can reach the project: that is membership, and a non-member never gets far
 * enough to be refused by role.
 */

export interface RbacRow {
  action: string;
  /** What the action also gates, when the grant name cannot carry it. */
  covers?: string;
  grant: Record<ProjectRole, 0 | 1>;
}

/** Every role is named, so a new entry in `PROJECT_ROLES` fails to compile here
 *  until the permission table accounts for its column. */
function grantByRole(roles: readonly ProjectRole[]) {
  return {
    admin: roles.includes("admin") ? 1 : 0,
    maintainer: roles.includes("maintainer") ? 1 : 0,
    contributor: roles.includes("contributor") ? 1 : 0,
    viewer: roles.includes("viewer") ? 1 : 0,
  } satisfies Record<ProjectRole, 0 | 1>;
}

export const RBAC_ROWS: readonly RbacRow[] = RBAC_DEFINITIONS.map((cap) => {
  const row: RbacRow = { action: cap.label, grant: grantByRole(cap.roles) };
  // Ruling 26(b): the grant name stays short (sentences read it inline); the
  // table is where a person comes to learn the scope, so the table carries it.
  if ("covers" in cap) row.covers = cap.covers;
  return row;
});

export type BoundaryId = "auto" | "approval" | "human";

export const BOUNDARIES: readonly { id: BoundaryId; label: string }[] = [
  { id: "auto", label: "Auto-advance" },
  { id: "approval", label: "Human approval" },
  { id: "human", label: "Human only" },
];

/** Boundary → cap-seg CSS class (deliberate color-language reuse —
 * contracts §2.5: auto→teal `direct`, approval→blue `recommend`,
 * human→coral `human`. Do NOT "fix" to semantic names). */
export const BCLS = {
  auto: "direct",
  approval: "recommend",
  human: "human",
} satisfies Record<BoundaryId, string>;

/**
 * F20-9 (co-owned with C-AGENTS): the single canonical statement of the one
 * operator exception to the always-human "Transition a task to Done" invariant.
 * The Agents capability card borrows THIS constant (via `ALWAYS_HUMAN_ROWS`)
 * rather than restating the sentence, so the two surfaces cannot drift. Do not
 * inline the phrasing anywhere else — import it.
 */
export const TRANSITION_TO_DONE_EXCEPTION =
  "except an operator at full autonomy with an explicit Accept completion into Done grant (see below)";

/** The capability whose id is scoped to the operator exception above. */
export const TRANSITION_TO_DONE_CAPABILITY_ID = "transition-to-done";

/** "Always reserved for humans" — rendered from the server invariant list
 * (ruling 26(a)), never hard-coded UI strings.
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
    id === TRANSITION_TO_DONE_CAPABILITY_ID ? TRANSITION_TO_DONE_EXCEPTION : null,
}));

// ----------------------------------------------- F20-19: operator autonomy

/** The capability whose `direct` grant, together with full autonomy, is the one
 *  policy that lets an operator accept completion into Done itself — the exact
 *  runtime combination checked in operator-moves.server.ts. Exported with no
 *  importer on purpose: exported, the build inlines it at its one use;
 *  module-local, it ships as a variable, 4 B more on the budgeted profile
 *  closure (ruling 11's ratchet; measured for ruling 11). */
export const DIRECT_ACCEPT_CAPABILITY_ID = "completion-for-acceptance";

export interface OperatorAutonomyState {
  /** An operator profile is deployed on this project. */
  present: boolean;
  /** The deployed operator's configured default autonomy (null = none deployed). */
  autonomy: "supervised" | "full" | null;
  /** The human-only-Done exception is actually LIVE here: an operator at full
   *  autonomy that ALSO holds `completion-for-acceptance: direct`. Anything
   *  short of that combination leaves the exception configured-off. */
  directDoneLive: boolean;
}

type RosterProfile = Pick<AgentProfileView, "kind" | "autonomy" | "capabilities">;

/**
 * F20-19: derive the project's configured operator autonomy from the shared
 * agent roster so the Policy page can state whether the always-human-Done
 * exception is live — a value that previously appeared only on the operator's
 * Agents profile card, leaving the Policy page byte-identical whether the
 * exception was active or not. Prefers whichever operator makes the exception
 * live, so a board that has configured the grant reads as live.
 */
export function operatorAutonomyState(
  profiles: readonly RosterProfile[],
): OperatorAutonomyState {
  const operators = profiles.filter((p) => p.kind === "operator");
  if (operators.length === 0) {
    return { present: false, autonomy: null, directDoneLive: false };
  }
  const live = operators.find(
    (p) =>
      p.autonomy === "full" &&
      p.capabilities.some(
        (c) =>
          c.capabilityId === DIRECT_ACCEPT_CAPABILITY_ID && c.mode === "direct",
      ),
  );
  const chosen = live ?? operators[0]!;
  return {
    present: true,
    autonomy: chosen.autonomy ?? "supervised",
    directDoneLive: Boolean(live),
  };
}
