/**
 * Client-safe render shapes for the Agents surface (shared with Policy).
 * Server assembly lives in agents-query.server.ts /
 * app/server/projections/agent-deployments.server.ts.
 */

/** Deployment status vocabulary — display strings are the contract
 * (contracts §2.4): derived server-side from real engagement + waiting
 * state, rendered verbatim. */
export type DeploymentStatus =
  | "coordinating"
  | "packet open"
  | "working"
  | "waiting on human"
  | "on call"
  | "anchored · on call";

export type Engagement = "operator" | "primary" | "reviewer";

/** One live engagement instance (projection over task assignments joined
 * with agent_runs — profile-id keyed, never role-string matched). */
export interface AgentDeploymentView {
  profileId: string;
  /** Display role — "Operator" or the assignment's role snapshot. */
  role: string;
  /** null for operator engagements (rendered "orchestration"). */
  backend: "codex" | "claude" | null;
  engagement: Engagement;
  taskKey: string;
  taskTitle: string;
  status: DeploymentStatus;
  /** True when an agent_runs row for this engagement is state='running'. */
  running: boolean;
}

/** Effective agent profile as the roster renders it: org template merged
 * with the project.md deployment (definition override wins per-field). */
export interface AgentProfileView {
  id: string;
  kind: "operator" | "specialist";
  name: string;
  role: string;
  icon: string;
  backends: ("codex" | "claude")[];
  /** The RAW stored model value (may be a legacy display label) — seeds the edit
   *  picker and is what the operator org-view shows verbatim. */
  model: string;
  /** Friendly display name of the model that would actually RUN — the stored
   *  model when it is a valid catalog id, else the backend default. */
  modelLabel: string;
  /** False when the stored `model` is not a real catalog id for the primary
   *  backend (a legacy placeholder like "codex-large · claude-sonnet") — the run
   *  substitutes the default and the UI flags it. */
  modelKnown: boolean;
  /** Reasoning/effort level ("" when unset) — the picker's stored effort. */
  effort: string;
  scope: string;
  desc: string;
  /** The profile's LONG persona/instructions (template body, D6) — what an
   * agent run receives as its system-prompt persona when no shipped
   * agents/definitions/<id>.md overrides it. Empty when the profile has none. */
  definition: string;
  stages: string[];
  spanAll: boolean;
  /** Operator only: default autonomy (supervised | full); undefined for specialists. */
  autonomy?: "supervised" | "full";
  /** Display-label buckets (catalog labels + extras) — what CapColumns,
   * pcap counts and the matrix modal render. */
  actions: { direct: string[]; recommend: string[]; forbidden: string[] };
  /** Id-based policy (edit-modal seeding; ruling 7). */
  capabilities: { capabilityId: string; mode: "direct" | "recommend" | "human" | "off" }[];
  /** Bespoke labels with no catalog id — display-only, preserved on save. */
  extras: { label: string; mode: "direct" | "recommend" | "human" | "off" }[];
  resources: { skills: string[]; mcps: string[]; kb: string[] };
  /** "template" = org base deployed here · "project" = created in-project. */
  source: "template" | "project";
}

/** Minimal profile shape the CapabilityMatrixModal needs (Policy passes
 * the same roster). */
export type MatrixProfile = Pick<
  AgentProfileView,
  "id" | "kind" | "name" | "icon" | "actions"
>;

/** Mock statusKind (agents.jsx): status string → pill kind. */
export function deploymentStatusKind(
  status: string,
): "agent" | "input" | "info" | "neutral" {
  if (status === "working" || status === "coordinating") return "agent";
  if (status === "packet open") return "input";
  if (status === "waiting on human") return "info";
  return "neutral";
}

/** Pulsing pill dot: actively-working statuses, plus any engagement with a
 * live run (the agent_runs join — honest enrichment, noted in the phase
 * report). */
export function deploymentDot(d: Pick<AgentDeploymentView, "status" | "running">): boolean {
  return d.status === "working" || d.status === "coordinating" || d.running;
}
