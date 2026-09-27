import type { Waiting } from "~/schemas/task-file.schema";

/**
 * Client-safe render shapes for the Agents surface (shared with Policy).
 * Server assembly lives in agents-query.server.ts /
 * app/server/projections/agent-deployments.server.ts.
 */

/** Deployment status vocabulary — display strings are the contract
 * (contracts §2.4), rendered verbatim. Derived server-side from the
 * engagement's own `agent_runs` row first (F34-5): "coordinating" and
 * "working" name a RUNNING row, "queued" a run admitted but not yet given a
 * slot, and the other three are the idle wording read from the task's
 * `waiting` flag. The mock's "anchored · on call" reviewer literal is gone:
 * a supporting engagement reads by the same rule as a delivering one. */
export type DeploymentStatus =
  | "coordinating"
  | "packet open"
  | "working"
  | "queued"
  | "waiting on human"
  | "on call";

export type Engagement = "operator" | "primary" | "reviewer";

/** One live engagement instance (projection over task assignments joined
 * with agent_runs — profile-id keyed, never role-string matched). */
export interface AgentDeploymentView {
  profileId: string;
  /** Display role — "Operator" or the assignment's role snapshot. */
  role: string;
  /** null for operator engagements: the Live roster names the operator
   *  profile's own run backend for them (ruling 479(e)). */
  backend: "codex" | "claude" | null;
  engagement: Engagement;
  taskKey: string;
  taskTitle: string;
  status: DeploymentStatus;
  /** True when an agent_runs row for this engagement is state='running' —
   *  the only proof a run is in flight, and what `status` "working" /
   *  "coordinating" now mean (F34-5). */
  running: boolean;
  /** The TASK's `waiting` flag, carried so the page's "waiting on a human"
   *  stat keeps counting task-level waiting after `status` stopped being
   *  derived from it: an engagement whose run is in flight on a human-waiting
   *  task says "working" and would otherwise silently leave that count. */
  taskWaiting: Waiting;
}

/** The three grant lists a profile carries, by resource kind. The keys are
 *  the STORE keys the runtime mounts by (file-formats §4). */
export interface ResourceLists {
  skills: string[];
  mcps: string[];
  kb: string[];
}

/** Ruling 156: what a deployment's copy lacks (`missing`: on the template,
 *  not on the copy) and holds beyond the template (`extra`). Order-insensitive:
 *  a copy naming the same keys in another order does not drift. */
export interface ResourceDrift {
  missing: ResourceLists;
  extra: ResourceLists;
}

/**
 * Every grant in one set of lists, rendered as the replies and the card spell
 * it (`MCP server context7`), skills first, then MCP servers, then knowledge
 * bases. The propagation's `added`/`removed`, the controller's drift lines and
 * (ruling 479(d)) the Agents page's confirm all read this one wording.
 */
export function describeDriftLists(lists: ResourceLists): string[] {
  const out: string[] = [];
  for (const name of lists.skills) out.push(`skill ${name}`);
  for (const name of lists.mcps) out.push(`MCP server ${name}`);
  for (const name of lists.kb) out.push(`knowledge base ${name}`);
  return out;
}

/** The drift plus the template's own lists, so a card can say exactly what
 *  "the template's grants" would be before anyone presses the button. */
export interface TemplateDrift extends ResourceDrift {
  templateResources: ResourceLists;
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
  /** R20-3 / F20-4: set when the model a run would resolve to was refused by the
   *  provider for this account (learned from a real run's failure — ruling 19).
   *  The card disables/flags it with the provider's own redacted sentence;
   *  absent = unknown-but-offered, never "proven available". */
  modelUnavailable?: { reason: string; markedAt: string };
  /** Reasoning/effort level ("" when unset) — the picker's stored effort. */
  effort: string;
  scope: string;
  /**
   * OBS-7 — this deployment carries its OWN definition snapshot while still
   * showing the global template's `scope` sentence: the project forked the
   * global base (AP-07: "keeps its own copy and stops tracking the global") and
   * the label went on saying "Global base", as if edits here still followed the
   * org profile. The raw `scope` stays raw on purpose — the edit writer persists
   * `current.scope` back onto the deployment, so decorating it in this view
   * would compound the sentence on every save. The card composes the two.
   */
  customized: boolean;
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
  actions: { direct: string[]; recommend: string[]; forbidden: string[]; off?: string[] };
  /** Id-based policy (edit-modal seeding; ruling 7). */
  capabilities: { capabilityId: string; mode: "direct" | "recommend" | "human" | "off" }[];
  /** Bespoke labels with no catalog id — display-only, preserved on save. */
  extras: { label: string; mode: "direct" | "recommend" | "human" | "off" }[];
  resources: { skills: string[]; mcps: string[]; kb: string[] };
  /**
   * Ruling 156 (pass 35, F35-7): how this deployment's COPY of the grants
   * differs from its template's, or null when there is no template, the
   * deployment carries no copy (it resolves the template live), or the two
   * agree. `customized` stays an identity signal (OBS-7) and never widens to
   * grants; this is the grants signal beside it, with the exact difference.
   */
  templateDrift: TemplateDrift | null;
  /** "template" = org base deployed here · "project" = created in-project. */
  source: "template" | "project";
  /**
   * Ruling 479(g): some field this profile renders still resolves from the org
   * template LIVE, because the deployment's definition leaves it unset (the
   * seeded rows carry no definition at all). A save writes a full snapshot, so
   * only then does saving stop this project following the template, and only
   * then does the editor say it forks. False for a project-created profile and
   * for a copy that already carries its own snapshot (a library deploy, any
   * earlier save), which a template edit no longer reaches.
   */
  tracksTemplate: boolean;
  /** B5 (pass 34, U34-3): the identity of the deployment record this view was
   *  built from. The editor submits it back, and a save composed against a
   *  different record is refused rather than reverting what it never saw.
   *  Empty for a LIBRARY template, which has no deployment record yet. */
  fingerprint: string;
}

/**
 * One org-level TEMPLATE offered by the project's "Add from library" picker —
 * a global profile this project has not deployed yet (owner ruling 1 /
 * P13-AP-05). Assembled by `listLibraryProfiles` (agents-query.server).
 */
export interface LibraryProfileView {
  id: string;
  name: string;
  role: string;
  /** Short scannable copy — the frontmatter `desc`, else the body's opening. */
  desc: string;
  backends: ("codex" | "claude")[];
  stages: string[];
  spanAll: boolean;
  resources: { skills: string[]; mcps: string[]; kb: string[] };
}

/**
 * What an agent profile IS on this board, for the two places a stored role
 * says nothing: the render fallback below, and the roster's own `role` default
 * when neither the deployment nor the template declares one
 * (`effectiveProfileView`). ONE literal, shared, so the label a card shows and
 * the label the server assembles cannot drift apart.
 *
 * U12 residual: it read "Specialist" — the retired third name for the object
 * the Agents page has called an agent PROFILE since C11 (engaged per task as
 * the delivering agent, or as a supporting one). It leaked onto every
 * role-less card's hero pill, roster row and glyph tooltip, i.e. exactly the
 * profiles whose stored role is empty and can least afford a name the rest of
 * the page does not use.
 */
export const DEFAULT_SPECIALIST_ROLE_LABEL = "Agent profile";

/**
 * The role line a profile renders under (or beside) its name, or null for the
 * operator: it is one agent, called Operator, with no role (ruling 517), so
 * its row, pill and glyph show the name alone.
 *
 * P14-WL-05: the library deploy writes `role: fm.role || fm.name`, so a
 * template whose frontmatter carries no `role` deploys with its NAME in the
 * role field — live, the deployed "Org Docs Writer" rendered
 * "Org Docs Writer · Org Docs Writer" on its roster row, its hero pill and the
 * glyph tooltip. A role that only repeats the name carries no information, so
 * fall back to what the profile IS on this board. Purely a render decision: the
 * stored role stays whatever the deploy wrote.
 */
export function profileRoleLabel(
  name: string,
  role: string,
  kind: "operator" | "specialist",
): string | null {
  if (kind === "operator") return null;
  const trimmed = role.trim();
  if (!trimmed || trimmed.toLowerCase() === name.trim().toLowerCase()) {
    return DEFAULT_SPECIALIST_ROLE_LABEL;
  }
  return trimmed;
}

/** Minimal profile shape the CapabilityMatrixModal needs (Policy passes
 * the same roster).
 *
 * F-P2 (pass 25): also carries `backends` — the Policy page's per-profile
 * direct/recommend/human counts had no way to flag that a Codex-primary
 * profile's counted grants only bind advisorily (capabilityEnforcement is
 * `claude-only` for several), so two identically-configured Claude and Codex
 * profiles rendered identical counts. Purely additive: existing consumers
 * (the matrix modal) only read the fields they already destructured. */
export type MatrixProfile = Pick<
  AgentProfileView,
  "id" | "kind" | "name" | "icon" | "actions" | "backends" | "capabilities"
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

/** Pulsing pill dot: exactly the engagements with a live run. This used to OR
 * the "working"/"coordinating" statuses in, back when the projection derived
 * them from the task's `waiting` flag — so a delivering engagement whose run
 * had finished pulsed for as long as the task stayed agent-waiting (F34-5).
 * The statuses are now derived from the run rows themselves, and the row is
 * the one fact worth pulsing for. */
export function deploymentDot(d: Pick<AgentDeploymentView, "running">): boolean {
  return d.running;
}
