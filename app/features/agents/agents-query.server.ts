import { existsSync, readdirSync } from "node:fs";
import { deploymentFingerprint } from "./agent-profile-actions.server";
import type { DatabaseSync } from "node:sqlite";
import type {
  AgentDeployment,
  AgentDeploymentDefinition,
  CapabilityMode,
} from "~/schemas/project-file.schema";
import {
  deploymentName,
  deploymentResources,
  deploymentRuntimeIdentity,
  OPERATOR_FIXED_FIELDS,
  OPERATOR_SCOPE,
  primaryRunBackend,
  readTemplate,
  type TemplateProfile,
} from "~/server/agents/deployment-view.server";
import { agentProfilesDir } from "~/server/files/file-store-root.server";
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
  ALWAYS_HUMAN_CAPABILITY_IDS,
  applyVerdictOutcomeGate,
  capabilityById,
  coerceSpecialistCapabilityMode,
  GRANT_REQUIRED_CAPABILITY_IDS,
  UNIFIED_CAP_CATALOG,
  type CapabilityKind,
} from "~/shared/capabilities";
import { humanGatesPreWorkAdvance } from "~/shared/workflow/stage-roles";
import { specialistGrantModes } from "~/server/tasks/specialist-tool-policy";
import { DEFAULT_SPECIALIST_ROLE_LABEL } from "./agent-types";
import type {
  AgentProfileView,
  LibraryProfileView,
  TemplateDrift,
} from "./agent-types";
import { resourceDrift } from "~/server/org/template-propagation.server";

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


/** The one capability whose "acts directly" is ceilinged by operator autonomy —
 * `completion-for-acceptance` (label "Accept completion into Done"). */
const ACCEPT_COMPLETION_CAP_ID = "completion-for-acceptance";

/** One id-based capability grant as the DISPLAY layer reads it: the catalog id
 * plus the mode this surface renders. Deliberately narrower than the stored
 * `CapabilityGrant` — nothing here may depend on a field the runtime owns. */
export interface CapabilityGrantView {
  capabilityId: string;
  mode: CapabilityMode;
}

/** The display-label buckets every capability surface renders (profile detail,
 * capability matrix, policy counts). `forbidden` = reserved for a human;
 * `off` = withheld from this agent (NEW-3 — semantically different). */
export interface CapabilityActionLabels {
  direct: string[];
  recommend: string[];
  forbidden: string[];
  off: string[];
}

/**
 * F20-9 / R20-7: the AUTONOMY CEILING, the display twin of the runtime gate in
 * `operatorAcceptCompletion` (operator-moves.server.ts)
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
function applyAutonomyCeiling(
  grants: readonly CapabilityGrantView[],
  autonomy: "supervised" | "full" | undefined,
): CapabilityGrantView[] {
  return grants.map((g) => {
    // The DOWNGRADE (F20-9 / R20-7, unchanged): acceptance acts directly only
    // at full autonomy, so a `direct` grant on a supervised operator renders as
    // "Recommends only".
    if (
      g.capabilityId === ACCEPT_COMPLETION_CAP_ID &&
      g.mode === "direct" &&
      autonomy !== "full"
    ) {
      return { ...g, mode: "recommend" };
    }
    // F37-65: the PROMOTION, which this twin never mirrored. `gate()` reads
    // `authority.autonomy === "full" ? "direct" : "recommend"` for every
    // `recommend` grant EXCEPT acceptance, so a full-autonomy operator acts
    // directly on grants this display was calling "Recommends only" — the
    // label whose legend says it proposes a card a human applies. Ruling 82's
    // claim is that the display MIRRORS the runtime gate; it mirrored one half.
    //
    // `autonomy` is undefined for a specialist, so this stays a no-op there,
    // which is correct: this is the OPERATOR's gate.
    if (
      g.mode === "recommend" &&
      autonomy === "full" &&
      g.capabilityId !== ACCEPT_COMPLETION_CAP_ID
    ) {
      return { ...g, mode: "direct" };
    }
    return { ...g };
  });
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
  capabilities: CapabilityGrantView[],
  extras: { label: string; mode: CapabilityMode }[],
  autonomy?: "supervised" | "full",
): CapabilityActionLabels {
  const buckets: CapabilityActionLabels = {
    direct: [],
    recommend: [],
    forbidden: [],
    off: [],
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
    bucketOf(grant.mode).push(def ? def.label : grant.capabilityId);
  }
  for (const extra of extras) {
    bucketOf(extra.mode).push(extra.label);
  }
  return buckets;
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
 * Does this deployment's snapshot actually override the template's IDENTITY —
 * i.e. does the project's copy differ from the global base in something the
 * base defines about the profile itself?
 *
 * OBS-7 residual. `autonomy` and `resources` are excluded by design: both are
 * written by controls that say nothing about who the profile is (project
 * creation's `auto` preset writes autonomy alone onto an otherwise untouched
 * operator; the org resource-rename rewriter edits `definition.resources` in
 * place). A snapshot carrying only those still tracks the template for every
 * field the card renders, so "customized for <project>" would be a claim about
 * a divergence that does not exist.
 *
 * `scope` is deliberately not compared either — the caller already rejects a
 * snapshot whose scope differs from the template's (those profiles name their
 * own project in the sentence), so it could never contribute a difference here.
 */
function identityOverride(
  def: AgentDeploymentDefinition,
  template: TemplateProfile,
): boolean {
  const list = (v: readonly string[] | undefined) =>
    v === undefined ? undefined : JSON.stringify(v);
  const fields: [unknown, unknown][] = [
    [def.kind, template.kind],
    [def.name, template.name],
    [def.role, template.role],
    [def.icon, template.icon],
    [list(def.backends), list(template.backends)],
    [def.model, template.model],
    // Ruling 153 (pass 35): a template may declare `effort` now, and the
    // library deploy copies it, so a stored tier equal to the template's is not
    // an override; one the template never named still is.
    [def.effort, template.effort],
    [def.desc, template.desc],
    // A template's persona is its markdown BODY (F10-30) — the same value the
    // view's `definition` field falls back to.
    [def.persona, template.description],
    [list(def.stages), list(template.stages)],
    [def.spanAll, template.spanAll],
  ];
  return fields.some(([mine, base]) => mine !== undefined && mine !== base);
}


/**
 * Ruling 479(g): the definition fields a profile save always writes
 * (`updateAgentProfile`) and a template also supplies. While the deployment
 * leaves one unset the view resolves it from the template live, so the save is
 * what ends that. `effort` and `persona` are not listed: a save writes each
 * only when it has a value, so an absent one keeps resolving live after it.
 * `kind` is not listed either: no template edit changes it.
 */
const SAVE_SNAPSHOT_FIELDS = [
  "name",
  "role",
  "icon",
  "backends",
  "model",
  "scope",
  "desc",
  "stages",
  "spanAll",
  "resources",
] as const satisfies readonly (keyof AgentDeploymentDefinition)[];

/**
 * Ruling 479(g): does a save on the Agents page still cut this copy loose from
 * its template? The editor said "Saving forks this profile" for every
 * template-sourced profile, but a library deploy and every earlier save already
 * hold a full snapshot, which a template edit never reaches (ruling 156,
 * P13-AP-07): on akinozer.com all seven deployments did, and the sentence told
 * the owner that editing would end an inheritance that had already ended.
 *
 * Ruling 518: the operator's name and scope always resolve from its template
 * and no save writes them, so they never count as a field still to fork.
 */
function tracksTemplateLive(
  kind: "operator" | "specialist",
  def: AgentDeploymentDefinition | null,
  template: TemplateProfile | null,
): boolean {
  if (!template) return false;
  if (!def) return true;
  const fixed: readonly string[] = kind === "operator" ? OPERATOR_FIXED_FIELDS : [];
  return SAVE_SNAPSHOT_FIELDS.some(
    (field) => !fixed.includes(field) && def[field] === undefined,
  );
}

/**
 * Ruling 156 (pass 35, F35-7): how a deployment's COPY of the grants differs
 * from its template's. Null when there is no template (a project-created
 * profile), no copy (a definition-less deployment resolves the template live)
 * or no difference. The card renders the exact difference and, for an org
 * admin, the button that takes the template's grants.
 */
function templateDriftOf(
  def: AgentDeploymentDefinition | null,
  template: TemplateProfile | null,
): TemplateDrift | null {
  if (!template || !def?.resources) return null;
  const drift = resourceDrift(def.resources, template.resources);
  if (!drift) return null;
  return {
    missing: drift.missing,
    extra: drift.extra,
    templateResources: {
      skills: template.resources.skills,
      mcps: template.resources.mcps,
      kb: template.resources.kb,
    },
  };
}

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
/** The ids whose ABSENT mode is the project's delivery policy, materialised by
 *  the roster from the workflow (ruling 28 / R15-9), never by this rule. */
export const POLICY_DEPENDENT_CAPABILITY_IDS: readonly string[] = [
  "deliver-review-pr",
  "update-task-branch",
];

/**
 * The mode a grant resolves to when it is ABSENT from project.md, per kind —
 * the ONE home of the rule (ruling 139: `list_capabilities` publishes it as
 * `whenUngranted`, and the roster materialises absent grants with it):
 *  · always-human ids are `human`;
 *  · operator: `gate()` resolves an absent grant through `absentPolarityGate`
 *    (F31-C2) — `off` for most coordination capabilities, with the per-capability
 *    exceptions this mirrors: `dispatch-agents` mirrors `dispatchGate`'s
 *    absent-means-catalog-default polarity (dispatch-rework hunt, 2026-08-29:
 *    pre-rework deployments store only the retired assign/summon ids and the
 *    runtime keeps dispatching, so the surface must not render "off" over a
 *    live authority, F15-20's drift class), and web egress keeps its own
 *    catalog default; the two policy-dependent grants are materialised by the
 *    roster at the delivery-gate mode and never reach this rule;
 *  · specialist: the grant-required family is `off`, everything else its
 *    catalog default.
 */
export function absentGrantMode(
  kind: CapabilityKind,
  c: (typeof UNIFIED_CAP_CATALOG)[number],
): CapabilityMode {
  if (ALWAYS_HUMAN_CAPABILITY_IDS.includes(c.id)) return "human";
  if (kind === "operator") {
    return c.id === "use-web-search-fetch" || c.id === "dispatch-agents"
      ? c.defaultMode
      : "off";
  }
  return GRANT_REQUIRED_CAPABILITY_IDS.has(c.id) ? "off" : c.defaultMode;
}

export function effectiveProfileView(
  deployment: AgentDeployment,
  dataRoot: string | undefined,
  absentDeliverMode: CapabilityMode,
  modelMarks?: ModelMarks,
): AgentProfileView {
  // The template ⊕ override resolution and the effective kind/backends come
  // from the shared server resolver, so the value this view DISPLAYS and the
  // value `deployedSpecialistBackends` overlays are one computation (never drift).
  const { template, def, kind, backends } = deploymentRuntimeIdentity(
    deployment,
    dataRoot,
  );
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
  // Operator governance-dependent caps (deliver-review-pr, update-task-branch)
  // resolve an ABSENT grant through the delivery gate, not a flat catalog
  // default. `updateBranchGate` falls back to `deliverGate`, so BOTH share the
  // operator's EFFECTIVE deliver mode: its explicit `deliver-review-pr` grant, or
  // `absentDeliverMode` when that too is absent. Pass-24 A-1: `update-task-branch`
  // used to be excluded from materialization entirely (invisible on the matrix /
  // detail / policy) while the editor seeded it at a flat catalog `direct` — an
  // unrelated save then silently WIDENED it recommend→direct on a strict project.
  // Materializing it here at the runtime mode makes all surfaces AND the editor
  // seed agree (seedCaps reads this view).
  const operatorGrants = (() => {
    if (isSpecialist) return deployment.capabilities;
    const has = new Set(deployment.capabilities.map((c) => c.capabilityId));
    const deliverMode =
      deployment.capabilities.find((c) => c.capabilityId === "deliver-review-pr")
        ?.mode ?? absentDeliverMode;
    const added: { capabilityId: string; mode: CapabilityMode }[] = [];
    if (!has.has("deliver-review-pr")) {
      added.push({ capabilityId: "deliver-review-pr", mode: absentDeliverMode });
    }
    if (!has.has("update-task-branch")) {
      added.push({ capabilityId: "update-task-branch", mode: deliverMode });
    }
    return [...deployment.capabilities, ...added];
  })();
  // F27-L2: route the DISPLAY through the SAME grant inference the RUNTIME uses
  // (`specialistGrantModes`) so a scoped-only delivery grant (create/commit/open-PR
  // granted, headline `execute-code-or-write-repo` absent — reachable on a
  // hand-edited or non-standard-save profile) materializes that headline as
  // `direct` on the matrix, exactly as the run resolves it — instead of the matrix
  // showing "Not granted" for repo-write the agent actually holds. It repairs only
  // the ABSENT headline and respects an EXPLICIT `off` (unlike
  // `normalizeDeliveryGrants`), so an admin's withholding still reads as off.
  const effectiveGrants = isSpecialist
    ? [...specialistGrantModes(deployment.capabilities)].map(
        ([capabilityId, mode]) => ({
          capabilityId,
          // SAFETY: specialistGrantModes' map values are this profile's stored
          // grant modes plus the one inferred `direct` headline — each already a
          // valid CapabilityMode. coerce then narrows any `recommend` down to `off`.
          mode: coerceSpecialistCapabilityMode(mode as CapabilityMode),
        }),
      )
    : operatorGrants;
  // A1 (BUG-1 follow-on): the capability MATRIX, the read-only profile DETAIL and
  // the POLICY counts render ONLY persisted grants, so an ABSENT permissive-
  // default capability (`use-web-search-fetch`, `attach-evidence-references`, …)
  // showed as "Not granted"/omitted while the runtime kept it ON — the exact
  // display≠runtime gap PR #194 fixed in the EDITOR, still live on the READ
  // surfaces an admin audits. Materialize every catalog capability of this
  // profile's kind that is absent from the stored grants at the mode the runtime
  // uses for a missing grant (the `isWithheld`/`effectiveCollabMode` polarity):
  // grant-required or always-human → withheld (`off`/`human`), everything else →
  // its catalog default. `deliver-review-pr` is already materialized above at its
  // governance-dependent `absentDeliverMode`, so `present` skips it. One writer —
  // matrix, detail and policy now agree with the editor and the runtime.
  const grantKind = isSpecialist ? "agent" : "operator";
  const present = new Set(effectiveGrants.map((c) => c.capabilityId));
  // The mode the RUNTIME applies to an ABSENT grant, per profile kind — this must
  // match the gate the runtime consults, or the display (and the editor seed that
  // reads it) over/under-states authority (F15-20 / BUG-1 / pass-24 A-1,A-2):
  //  · specialist: the `isWithheld` polarity — grant-required → `off`, else the
  //    catalog default.
  //  · operator: `gate()` resolves an absent grant through `absentPolarityGate`
  //    (F31-C2) — `off` for most coordination capabilities, with per-capability
  //    exceptions this table mirrors: `dispatch-agents` and `use-web-search-fetch`
  //    keep their catalog default, and the two governance-dependent grants
  //    (`deliver-review-pr`, `update-task-branch`) are already materialized
  //    above at the delivery-gate mode, so they never reach this fallback.
  //    Materializing any other coordination cap at its catalog `direct`/
  //    `recommend` would show — and let a save arm — authority the gate denies.
  const absentMode = (c: (typeof UNIFIED_CAP_CATALOG)[number]): CapabilityMode =>
    absentGrantMode(grantKind, c);
  const absentMaterialized = UNIFIED_CAP_CATALOG.filter(
    (c) => c.kinds.includes(grantKind) && c.group !== null && !present.has(c.id),
  ).map((c) => ({ capabilityId: c.id, mode: absentMode(c) }));
  const capabilities = [
    ...effectiveGrants.map((c) => ({
      capabilityId: c.capabilityId,
      mode: c.mode,
    })),
    ...absentMaterialized,
  ];
  const extras = deployment.extras.map((e) => ({ label: e.label, mode: e.mode }));
  const model = def?.model ?? template?.model ?? "";
  // The model that would actually RUN: the primary (first) backend's, resolved
  // to a valid catalog id. `modelKnown` is false for a legacy display-label
  // placeholder — the UI then flags the substitution instead of showing a value
  // that would fail at the SDK.
  const primaryBackend: RealBackend = primaryRunBackend(backends);
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
  const view: AgentProfileView = {
    id: deployment.profileId,
    kind,
    // Ruling 518: the operator is called Operator, whatever its template or an
    // older save says, and has no role.
    name: deploymentName(deployment, { def, template, kind }),
    // U12 residual: a specialist's default was "Specialist", retired
    // vocabulary, and the one value the card cannot improve on, since
    // `profileRoleLabel` only rewrites a role that is empty or repeats the
    // name. Shared literal.
    role:
      kind === "operator"
        ? ""
        : (def?.role ?? template?.role ?? DEFAULT_SPECIALIST_ROLE_LABEL),
    icon: def?.icon ?? template?.icon ?? "agents",
    backends,
    model,
    modelLabel,
    modelKnown,
    // Ruling 153: a definition-less deployment (the seeded rows) resolves the
    // template live, its default effort included.
    effort: def?.effort ?? template?.effort ?? "",
    // Ruling 518: the operator's scope line is fixed like its name.
    scope: kind === "operator" ? OPERATOR_SCOPE : (def?.scope ?? template?.scope ?? ""),
    // OBS-7: a deployment holds a `definition` only once this project WROTE one
    // — the seeded roster carries none (agent-catalog.server.ts deploys
    // profileId + capabilities), so the snapshot is the fork itself. The
    // scope-sentence test is what keeps the flag honest for the paths that
    // already name themselves: create writes "Created in <project>" and the
    // library deploy "Added from the global library to <project>", and neither
    // needs (or gets) a second sentence saying it is project-local. What is left
    // is precisely the case OBS-7 found: a fork still wearing the global base's
    // own scope line.
    //
    // OBS-7 residual: "a snapshot exists" was too weak a signal for the
    // sentence the card composes ("customized for <project>"). Project creation
    // writes `definition: { ...a.definition, autonomy: "full" }` onto the
    // operator for the `auto` preset (project-create.server.ts) — on a base
    // deployment that is an autonomy-ONLY snapshot, so every auto-preset project
    // claimed a customized operator from birth without a single identity field
    // being touched. `identityOverride` is the honest half.
    customized:
      def !== null &&
      template !== null &&
      (def.scope === undefined || def.scope === template.scope) &&
      identityOverride(def, template),
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
      capabilities,
      deployment.extras,
      operatorAutonomy,
    ),
    capabilities,
    extras,
    resources: deploymentResources({ def, template }),
    // Ruling 156 (F35-7): the grants signal beside the identity one. A copy
    // exists only when the deployment wrote `definition.resources`; a
    // definition-less row resolves the template live and cannot drift.
    templateDrift: templateDriftOf(def, template),
    source: template ? "template" : "project",
    tracksTemplate: tracksTemplateLive(kind, def, template),
    // B5: the record this view was built from, for the editor to submit back.
    fingerprint: deploymentFingerprint(deployment),
  };
  // The key is set ONLY when a real run earned the mark: an absent
  // `modelUnavailable` claims nothing about availability (ruling 19), so it must
  // stay off the view rather than ride along as an explicit `undefined`.
  if (modelUnavailable) view.modelUnavailable = modelUnavailable;
  return view;
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
  const modelMarks = {
    codex: unavailableModels(db, "codex"),
    claude: unavailableModels(db, "claude"),
  } satisfies ModelMarks;
  const views = project.agentPolicy.map((dep) =>
    effectiveProfileView(dep, ctx.dataRoot, deliverDefault, modelMarks),
  );
  const operators = views.filter((v) => v.kind === "operator");
  const specialists = views.filter((v) => v.kind !== "operator");
  return [...operators, ...specialists];
}
