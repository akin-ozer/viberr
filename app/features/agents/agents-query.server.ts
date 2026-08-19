import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type {
  AgentDeployment,
  AgentDeploymentDefinition,
  CapabilityMode,
} from "~/schemas/project-file.schema";
import { parseAgentProfileContent } from "~/server/files/agent-profile-file.server";
import {
  agentProfileFilePath,
  agentProfilesDir,
} from "~/server/files/file-store-root.server";
import { getProject } from "~/server/projections/board-query.server";
import {
  isKnownModel,
  modelDisplayName,
  resolveRunModel,
} from "~/server/runtimes/model-catalog.server";
import { unavailableModels } from "~/server/runtimes/model-availability.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import {
  absentDeliverReviewPrMode,
  applyVerdictOutcomeGate,
  capabilityById,
  coerceSpecialistCapabilityMode,
} from "~/shared/capabilities";
import { humanGatesPreWorkAdvance } from "~/shared/workflow/stage-roles";
import type { AgentProfileView, LibraryProfileView } from "./agent-types";

/**
 * Roster assembly for the Agents/Policy surfaces (two-layer agent model,
 * contracts §3.4):
 *
 *   layer 1 — org template files  ${dataRoot}/agents/profiles/<id>.md
 *   layer 2 — project.md `agents:` deployments ({profileId, capabilities,
 *             extras} + an optional loose `definition` override object)
 *
 * The effective profile = template fields overridden per-field by the
 * deployment's `definition` (project-created profiles carry their FULL
 * definition there and have no template). Capability policy ALWAYS comes
 * from the deployment (id-based + extras — ruling 7); display labels are
 * rendered from the shared CAP_CATALOG.
 */

/** Loose `definition` override carried on a project.md deployment entry.
 * Single source of truth is the zod schema in project-file.schema; re-exported
 * here for the roster/CRUD callers that assemble it. */
export type { AgentDeploymentDefinition };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out;
}

/** Tolerant read of the loose `definition` field — junk fields ignored. */
export function parseDeploymentDefinition(
  raw: unknown,
): AgentDeploymentDefinition | null {
  if (!isRecord(raw)) return null;
  const def: AgentDeploymentDefinition = {};
  if (raw.kind === "operator" || raw.kind === "specialist") def.kind = raw.kind;
  if (typeof raw.name === "string" && raw.name) def.name = raw.name;
  if (typeof raw.role === "string" && raw.role) def.role = raw.role;
  if (typeof raw.icon === "string" && raw.icon) def.icon = raw.icon;
  const backends = stringArray(raw.backends)?.filter(
    (b): b is "codex" | "claude" => b === "codex" || b === "claude",
  );
  if (backends) def.backends = backends;
  if (typeof raw.model === "string") def.model = raw.model;
  if (typeof raw.effort === "string" && raw.effort) def.effort = raw.effort;
  if (typeof raw.scope === "string") def.scope = raw.scope;
  if (typeof raw.desc === "string") def.desc = raw.desc;
  if (typeof raw.persona === "string") def.persona = raw.persona;
  const stages = stringArray(raw.stages);
  if (stages) def.stages = stages;
  if (typeof raw.spanAll === "boolean") def.spanAll = raw.spanAll;
  if (raw.autonomy === "supervised" || raw.autonomy === "full") def.autonomy = raw.autonomy;
  if (isRecord(raw.resources)) {
    def.resources = {
      skills: stringArray(raw.resources.skills) ?? [],
      mcps: stringArray(raw.resources.mcps) ?? [],
      kb: stringArray(raw.resources.kb) ?? [],
    };
  }
  return def;
}

/** The one capability whose "acts directly" is ceilinged by operator autonomy —
 * `completion-for-acceptance` (label "Accept completion into Done"). */
const ACCEPT_COMPLETION_CAP_ID = "completion-for-acceptance";

/**
 * F20-9 / R20-7: the AUTONOMY CEILING, the display twin of the runtime gate at
 * `operator-actions.server.ts:2580`
 * (`authority.autonomy !== "full" || gate(...) !== "direct"`). `completion-for-
 * acceptance` only ACTS DIRECTLY when the operator runs at FULL autonomy; under a
 * supervised project the runtime posts a recommendation card a human applies, so
 * a `direct` grant must render as `recommend` (RECOMMENDS ONLY), never ACTS
 * DIRECTLY. This is `applyVerdictOutcomeGate` one axis over — the exact F15-06
 * class D1/F20-9 was filed for. `operatorAutonomyState` (policy-data.ts) derives
 * the same live-or-not condition for the Policy page, so both surfaces agree.
 *
 * A specialist never holds this capability (operator-only), and `autonomy` is
 * `undefined` for a specialist, so the ceiling is a no-op there.
 */
function applyAutonomyCeiling<G extends { capabilityId: string; mode: string }>(
  grants: readonly G[],
  autonomy: "supervised" | "full" | undefined,
): G[] {
  if (autonomy === "full") return grants.map((g) => ({ ...g }));
  return grants.map((g) =>
    g.capabilityId === ACCEPT_COMPLETION_CAP_ID && g.mode === "direct"
      ? ({ ...g, mode: "recommend" } as G)
      : { ...g },
  );
}

/** Id-based capability policy → the mock's display-label buckets.
 * Catalog labels first (stored order), then extras — order deviation from
 * the mock (extras were interleaved there) noted in the phase report.
 *
 * F15-06: the grants are read through `applyVerdictOutcomeGate` first, so the
 * ONE derivation every surface renders (profile detail, capability matrix,
 * policy counts) can never show a profile approving reviews it holds no verdict
 * authority for.
 *
 * F20-9/R20-7: `autonomy` (the operator's configured autonomy; undefined for a
 * specialist) applies the acceptance ceiling on top, so a supervised operator's
 * "Accept completion into Done" renders under RECOMMENDS ONLY — mirroring the
 * runtime gate — instead of ACTS DIRECTLY, authority the server refuses. */
export function capabilitiesToActionLabels(
  capabilities: { capabilityId: string; mode: CapabilityMode }[],
  extras: { label: string; mode: CapabilityMode }[],
  autonomy?: "supervised" | "full",
): { direct: string[]; recommend: string[]; forbidden: string[]; off: string[] } {
  const buckets = {
    direct: [] as string[],
    recommend: [] as string[],
    forbidden: [] as string[],
    off: [] as string[],
  };
  // `human` = RESERVED for a human (a structural always-human lock) → `forbidden`.
  // `off` = simply WITHHELD from this agent (not granted) → its own `off` bucket.
  // These are semantically different (NEW-3): conflating them made an explicitly
  // withheld capability render as "Reserved for humans" in the matrix / profile
  // detail / policy "N human" count. The runtime already distinguished them.
  const bucketOf = (mode: CapabilityMode) =>
    mode === "human"
      ? buckets.forbidden
      : mode === "off"
        ? buckets.off
        : buckets[mode];
  for (const grant of applyAutonomyCeiling(
    applyVerdictOutcomeGate(capabilities),
    autonomy,
  )) {
    const def = capabilityById(grant.capabilityId);
    bucketOf(grant.mode as CapabilityMode).push(def ? def.label : grant.capabilityId);
  }
  for (const extra of extras) {
    bucketOf(extra.mode).push(extra.label);
  }
  return buckets;
}

interface TemplateProfile {
  kind: "operator" | "specialist";
  name: string;
  role: string;
  icon: string;
  backends: ("codex" | "claude")[];
  model: string;
  scope: string;
  stages: string[];
  spanAll: boolean;
  resources: { skills: string[]; mcps: string[]; kb: string[] };
  /** Short scannable frontmatter `desc` (empty on older templates). */
  desc: string;
  description: string;
}

function readTemplate(
  profileId: string,
  dataRoot?: string,
): TemplateProfile | null {
  const absPath = agentProfileFilePath(profileId, dataRoot);
  if (!existsSync(absPath)) return null;
  const { parsed } = parseAgentProfileContent(readFileSync(absPath, "utf8"), {
    fallbackId: profileId,
  });
  if (!parsed) return null;
  const fm = parsed.frontmatter;
  return {
    kind: fm.kind,
    name: fm.name,
    role: fm.role,
    icon: fm.icon,
    backends: fm.backends,
    model: fm.model,
    scope: fm.scope,
    stages: fm.stages,
    spanAll: fm.spanAll,
    resources: {
      skills: fm.resources.skills,
      mcps: fm.resources.mcps,
      kb: fm.resources.kb,
    },
    /** Short scannable frontmatter desc (may be empty on older templates). */
    desc: fm.desc,
    description: parsed.description,
  };
}

/** Scannable one-liner for the library picker: the first paragraph, clamped.
 * A template with no `desc` would otherwise dump its whole ~2,500-char persona
 * body into a list row (the same defect as the org card subtitle, AP-09). */
function scannable(text: string, max = 240): string {
  const para = text.trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  return para.length > max ? para.slice(0, max - 1).trimEnd() + "…" : para;
}

/**
 * The org-level specialist TEMPLATES this project has NOT deployed — what the
 * project Agents page offers under "Add from library".
 *
 * P13-AP-05 (owner ruling 1, 2026-07-24): before this, NOTHING ever copied an
 * org template into a project's `agents:` list. A profile created in org
 * settings could never be deployed, run, or selected — `used` stayed 0 forever
 * and the create toast pointed at a project-policy control that did not exist.
 * The org layer is a real template LIBRARY now: an admin explicitly picks a
 * template and it is copied into the project (deployAgentProfileFromLibrary).
 */
export function listLibraryProfiles(
  db: DatabaseSync,
  projectSlug: string,
  ctx: { dataRoot?: string } = {},
): LibraryProfileView[] {
  const project = getProject(db, projectSlug);
  if (!project) return [];
  const deployed = new Set(project.agentPolicy.map((d) => d.profileId));
  const dir = agentProfilesDir(ctx.dataRoot);
  if (!existsSync(dir)) return [];
  const out: LibraryProfileView[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".md")) continue;
    const id = entry.slice(0, -3);
    if (deployed.has(id)) continue;
    const template = readTemplate(id, ctx.dataRoot);
    // The operator is a system profile — one per project, never library-added.
    if (!template || template.kind !== "specialist") continue;
    out.push({
      id,
      name: template.name,
      role: template.role,
      desc: scannable(template.desc || template.description),
      backends: template.backends,
      stages: template.stages,
      spanAll: template.spanAll,
      resources: template.resources,
    });
  }
  return out;
}

/**
 * Pass this as `absentDeliverMode` when the caller reads only kind / backend /
 * model / resources and never touches `capabilities`. Named rather than a bare
 * "direct" so the audit is one grep: every use of this constant must be a call
 * site that provably ignores the returned grants.
 */
export const VIEW_WITHOUT_POLICY: CapabilityMode = "direct";

/**
 * R20-3 / F20-4: per-backend "the provider refused this model for this account"
 * marks (from the `model_availability` table), keyed by model id. Absent ⇒ the
 * view claims nothing about availability (a mark is earned only from a real run
 * failure — ruling 19). Optional so the actions/test callers that read only
 * kind/backend/model can skip the DB read entirely.
 */
export type ModelMarks = Partial<
  Record<RealBackend, ReadonlyMap<string, { reason: string; markedAt: string }>>
>;

/**
 * Effective profile for ONE deployment entry (exported for actions/tests).
 *
 * `absentDeliverMode` (R15-9) is the mode the RUNTIME applies when the
 * deployment persisted no `deliver-review-pr` grant — see `deliverGate`. It has
 * no default on purpose: a silent default here is exactly what made F15-20
 * possible, where this view asserted a mode the runtime did not use. Surfaces
 * that RENDER or EDIT policy must derive it from the project
 * (`humanGatesPreWorkAdvance`); callers that only read `kind`/`backend`/model
 * pass "direct" and never touch `capabilities`.
 */
export function effectiveProfileView(
  deployment: AgentDeployment,
  dataRoot: string | undefined,
  absentDeliverMode: CapabilityMode,
  modelMarks?: ModelMarks,
): AgentProfileView {
  const template = readTemplate(deployment.profileId, dataRoot);
  const def = parseDeploymentDefinition(
    (deployment as Record<string, unknown>).definition,
  );
  const kind = def?.kind ?? template?.kind ?? "specialist";
  // R7-5: on a specialist profile, a stored `recommend` grant is runtime-
  // identical to `direct` and the picker no longer offers it — coerce it to
  // `direct` ('Allowed') on read so the roster, matrix, policy counts and the
  // edit-modal seed all show the honest mode. Seed/legacy files keep `recommend`
  // on disk (no migration); this normalizes only the view. The operator keeps
  // its real `recommend` modes. Runtime tool policy reads `deployment.capabilities`
  // directly (not this view), so no runtime behavior changes.
  const isSpecialist = kind !== "operator";
  // R15-2 / live find: `deliver-review-pr` postdates every operator deployment
  // created before this pass, and its runtime gate reads an ABSENT grant as
  // `direct` (deliverGate) so delivery kept working on those projects. The
  // panel, however, renders only the grants the deployment PERSISTED — so a
  // capability that genuinely governs behavior was invisible here and could
  // not be edited: an operator was pushing branches and opening PRs with no
  // row saying so. Materialize it at the mode the runtime actually applies —
  // which since R15-9 depends on the project's governance, not on a constant.
  const operatorGrants =
    deployment.capabilities.some((c) => c.capabilityId === "deliver-review-pr")
      ? deployment.capabilities
      : [
          ...deployment.capabilities,
          { capabilityId: "deliver-review-pr", mode: absentDeliverMode },
        ];
  const effectiveGrants = isSpecialist
    ? deployment.capabilities.map((c) => ({
        capabilityId: c.capabilityId,
        mode: coerceSpecialistCapabilityMode(c.mode),
      }))
    : operatorGrants;
  const capabilities = effectiveGrants.map((c) => ({
    capabilityId: c.capabilityId,
    mode: c.mode,
  }));
  const extras = deployment.extras.map((e) => ({ label: e.label, mode: e.mode }));
  const backends = def?.backends ?? template?.backends ?? [];
  const model = def?.model ?? template?.model ?? "";
  // The model that would actually RUN: the primary (first) backend's, resolved
  // to a valid catalog id. `modelKnown` is false for a legacy display-label
  // placeholder — the UI then flags the substitution instead of showing a value
  // that would fail at the SDK.
  const primaryBackend: RealBackend =
    backends.find((b) => b === "codex" || b === "claude") === "codex"
      ? "codex"
      : "claude";
  const runModel = resolveRunModel(primaryBackend, model);
  const modelKnown = isKnownModel(primaryBackend, model);
  const modelLabel = modelDisplayName(primaryBackend, runModel);
  // R20-3 / F20-4: the model a run would actually resolve to is flagged when a
  // REAL run against it was refused by the provider for this account
  // (model_availability). The badge names the provider's own redacted sentence;
  // an absent mark claims nothing (unknown-but-offered, ruling 19).
  const modelUnavailable = modelMarks?.[primaryBackend]?.get(runModel);
  // Operator only: default autonomy (supervised unless the deployment sets it) —
  // the ceiling `capabilitiesToActionLabels` applies to "Accept completion into
  // Done" (F20-9), the same value the runtime gate reads.
  const operatorAutonomy =
    kind === "operator" ? (def?.autonomy ?? "supervised") : undefined;
  return {
    id: deployment.profileId,
    kind,
    name: def?.name ?? template?.name ?? deployment.profileId,
    role: def?.role ?? template?.role ?? "Specialist",
    icon: def?.icon ?? template?.icon ?? "agents",
    backends,
    model,
    modelLabel,
    modelKnown,
    ...(modelUnavailable ? { modelUnavailable } : {}),
    effort: def?.effort ?? "",
    scope: def?.scope ?? template?.scope ?? "",
    // Short scannable copy (operator selection + cards): deployment override,
    // else the template's dedicated `desc` field, else the body (legacy
    // templates whose body IS the short description).
    desc: def?.desc ?? (template?.desc || template?.description) ?? "",
    // The profile's long persona/instructions (D6): deployment override
    // first (project-created/edited profiles), else the template BODY —
    // startAgentRun feeds THIS to the run as the profile's only persona source
    // (F10-30 removed the parallel `agents/definitions/<id>.md` override).
    definition: def?.persona ?? template?.description ?? "",
    stages: def?.stages ?? template?.stages ?? [],
    spanAll: def?.spanAll ?? template?.spanAll ?? false,
    autonomy: operatorAutonomy,
    actions: capabilitiesToActionLabels(
      effectiveGrants,
      deployment.extras,
      operatorAutonomy,
    ),
    capabilities,
    extras,
    resources: {
      skills: def?.resources?.skills ?? template?.resources.skills ?? [],
      mcps: def?.resources?.mcps ?? template?.resources.mcps ?? [],
      kb: def?.resources?.kb ?? template?.resources.kb ?? [],
    },
    source: template ? "template" : "project",
  };
}

/**
 * The project's approved-profile roster: one view per project.md deployment,
 * operator first (mock list order), remaining entries in file order.
 */
export function assembleAgentRoster(
  db: DatabaseSync,
  projectSlug: string,
  ctx: { dataRoot?: string } = {},
): AgentProfileView[] {
  const project = getProject(db, projectSlug);
  if (!project) return [];
  // R15-9: the roster RENDERS policy, so it must materialize an absent
  // `deliver-review-pr` at the mode this project's runtime actually applies.
  const deliverDefault = absentDeliverReviewPrMode(
    humanGatesPreWorkAdvance(project.stages, project.workflow),
  );
  // R20-3 / F20-4: read the account's model-availability marks once per backend
  // so a profile pinned to (or falling back to) a model a real run proved
  // unusable renders the badge instead of a value that would 400 at the SDK.
  const modelMarks: ModelMarks = {
    codex: unavailableModels(db, "codex"),
    claude: unavailableModels(db, "claude"),
  };
  const views = project.agentPolicy.map((dep) =>
    effectiveProfileView(dep, ctx.dataRoot, deliverDefault, modelMarks),
  );
  const operators = views.filter((v) => v.kind === "operator");
  const specialists = views.filter((v) => v.kind !== "operator");
  return [...operators, ...specialists];
}
