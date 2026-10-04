import type { DatabaseSync } from "node:sqlite";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import { z } from "zod";
import type { AgentDeployment, CapabilityMode } from "~/schemas/project-file.schema";
import {
  ALWAYS_HUMAN_CAPABILITY_IDS,
  coerceSpecialistCapabilityMode,
  conservativeGrantsFor,
  applyGrantCouplings,
  repairBrowserEgressGrants,
  repairDeliveryGrants,
  type GrantCouplingNotice,
} from "~/shared/capabilities";
import { deliveryWithheld } from "~/server/tasks/specialist-tool-policy";
import { slugify } from "~/shared/ids/slugify";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { sha256Hex } from "~/server/files/content-hash.server";
import { AppError } from "~/server/errors/app-error.server";
import { assertProjectAction } from "~/server/auth/project-authority.server";
import {
  agentProfileFilePath,
  agentProfilesDir,
  resolveStoreSegment,
} from "~/server/files/file-store-root.server";
import { updateProjectFile } from "~/server/files/project-writer.server";
import { listAgentDeployments } from "~/server/projections/agent-deployments.server";
import { reprojectProject } from "~/server/projections/rebuilder.server";
import {
  defaultEffortFor,
  defaultModelFor,
  effortsFor,
  foreignModelBackend,
  modelDisplayName,
  assertEffortForBackend,
  assertModelForBackend,
} from "~/server/runtimes/model-catalog.server";
import { displayNameRefusal, normalizeDisplayName } from "~/shared/names";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import { existsSync, readFileSync } from "node:fs";
import {
  parseAgentProfileContent,
  type ParsedAgentProfile,
} from "~/server/files/agent-profile-file.server";
import {
  effectiveProfileView,
  VIEW_WITHOUT_POLICY,
  type AgentDeploymentDefinition,
} from "./agents-query.server";
import {
  CAP_MODAL_DEFAULTS,
  MODAL_CAP_IDS,
  OPERATOR_CAP_DEFAULTS,
  OPERATOR_CAP_IDS,
  type CapMode,
} from "./capability-catalog";

/**
 * Agent-profile CRUD against project.md agent policy (phase-3 writers —
 * agents spec §5). All three mutations follow the canonical order:
 * file write → incremental reproject (SSE rides the rebuild) → audit.
 *
 * RBAC: profile CRUD is project-policy work — "Edit workflow & policy"
 * (contracts §3.2) → project admins only, enforced here server-side.
 *
 * Two-layer semantics (agents spec §8.1 resolution): create/edit/delete act
 * on the PROJECT deployment entry only — org template files under
 * agents/profiles/ are never touched ("The global base definition is
 * unaffected."). Edits store a full `definition` override on the deployment;
 * capability grants outside the modal's curated catalog (operator
 * coordination actions) and display-only extras are preserved verbatim.
 */

export interface ProfileActor {
  userId: string;
  label: string;
}

/** What a profile save produced. `notices` is non-empty only when the saved
 * grants needed a coupling decision (the delivery headline, or web egress
 * under the browser) — materialized (`repaired`) or refused (`withheld`, an
 * explicit withholding that leaves the profile unable to deliver). Callers
 * surface each `message` next to the success toast. */
export interface ProfileSaveResult {
  profileId: string;
  name: string;
  notices?: GrantCouplingNotice[];
  /** F20-20: a governance-significant change the save just made — today, raising
   *  an operator to FULL autonomy and/or granting it "Accept completion into
   *  Done". Surfaced next to the success toast (the generic "updated" tick alone
   *  hid that the operator can now close tasks without a human) and recorded as
   *  its own audit event, not folded into the generic profile-updated row. */
  governanceNotice?: { message: string };
  /** Ruling 139: what the write actually stored for the run's backend, model
   *  and effort, so a reply has a source instead of restating the request. */
  applied?: { backend: RealBackend; model: string; modelLabel: string; effort: string };
  /**
   * Ruling 264 (pass 37, F37-94): whether the DEPLOYED grants let this profile
   * write the repo, read back through the same predicate the runtime gates on
   * (`isWithheld` over the delivery headline). Set by the library deploy,
   * whose every reply used to promise "delivery starts withheld" — true only
   * of a template with no grants of its own, since ruling 156 made the deploy
   * COPY the template's grants.
   */
  delivery?: "granted" | "withheld";
}

export interface ProfileMutationContext {
  dataRoot?: string;
}

/** What one grant-deciding pass produced: the grants to persist, plus every
 * coupling decision it had to make (empty when there was none). */
interface GrantDecision {
  grants: { capabilityId: string; mode: CapabilityMode }[];
  notices: GrantCouplingNotice[];
}

/** A holder, not a `let`: the notices are decided inside the file-writer
 * callback, and narrowing would otherwise type the result as `[]` here. */
interface DeliveryNoticeHolder {
  notices: GrantCouplingNotice[];
}

/** F20-20: the operator governance transition one save makes — read before the
 * write, filled after it, so the audit + toast can name what changed. */
interface OperatorGovernanceTransition {
  isOperator: boolean;
  priorAutonomy: "supervised" | "full";
  newAutonomy: "supervised" | "full";
  priorDirectAccept: boolean;
  newDirectAccept: boolean;
}

/** Audit `details` for the three profile-save rows. The coupling keys are
 * ABSENT unless the save actually decided one (B-AG1) — the presence of the
 * key IS the disclosure, so they are set, never defaulted. */
type CouplingAuditKeys = {
  deliveryGrants?: GrantCouplingNotice["kind"];
  deliveryNote?: string;
  browserEgress?: GrantCouplingNotice["kind"];
  browserEgressNote?: string;
};

type ProfileCreatedAuditDetails = CouplingAuditKeys & {
  name: string;
  role: string;
  backend: "codex" | "claude";
  projectName: string;
};

type ProfileDeployedAuditDetails = CouplingAuditKeys & {
  name: string;
  source: "library";
  projectName: string;
  /** Ruling 139: the model and effort the deployment was written with. */
  model?: string;
  effort?: string;
};

/** `project.agent_profile.deleted`; `reason` when the caller gave one
 *  (ruling 464: the controller's removal always does). */
type ProfileDeletedAuditDetails = {
  name: string;
  reason?: string;
};

/** Ruling 467: the persona an update wrote, when it changed the stored one;
 *  filled inside the file writer's callback. */
interface PersonaEditHolder {
  after: string | null;
}

type ProfileUpdatedAuditDetails = CouplingAuditKeys & {
  name: string;
  /** Absent on the operator, which has no role (ruling 518). */
  role?: string;
  backend: "codex" | "claude";
  /** Ruling 139 parity with `deployed` (U36-3): the model and effort the
   *  update wrote — the row used to carry neither. */
  model?: string;
  effort?: string;
  operatorAutonomy?: "supervised" | "full";
  acceptCompletionIntoDone?: "direct" | "off";
  acceptCompletionActsDirectly?: boolean;
  /** Ruling 467: the save rewrote the deployment's persona (the run's system
   *  prompt), with its new length. Every door that edits a persona writes
   *  these two keys: the Agents page, `update_agent_deployment` and a
   *  template propagation (which adds `source: "org-template"`). */
  personaChanged?: boolean;
  personaChars?: number;
};

/** Stamp every coupling decision onto the audit row and the save result — a
 * decision the save made (or refused to make) is never silent (B-AG1). */
function carryCouplingNotices(
  details: CouplingAuditKeys,
  result: ProfileSaveResult,
  notices: GrantCouplingNotice[],
): void {
  for (const n of notices) {
    if (n.rule === "delivery-headline") {
      details.deliveryGrants = n.kind;
      details.deliveryNote = n.message;
    } else {
      details.browserEgress = n.kind;
      details.browserEgressNote = n.message;
    }
  }
  if (notices.length > 0) result.notices = notices;
}

const modeSchema = z.enum(["direct", "recommend", "human", "off"]);

/**
 * B5 (pass 34, U34-3): the identity of the deployment record the editor read,
 * over exactly the fields a profile save may overwrite — the governed grants
 * (order-independent), the display-only extras and the definition. NOT the
 * whole project file: an unrelated project edit (a member, a stage, another
 * agent) must never refuse this save.
 *
 * `updateAgentProfile` rebuilds the whole governed grant set from the SUBMITTED
 * form, and the modal seeds that form once, at open time. The file mutex makes
 * the write atomic; it does not make it aware. A modal opened before a
 * concurrent write and saved after it therefore reverted every governed grant
 * that write changed, reported success and audited it.
 */
export function deploymentFingerprint(deployment: AgentDeployment): string {
  const canonical = JSON.stringify({
    capabilities: [...deployment.capabilities]
      .map((g) => ({ capabilityId: g.capabilityId, mode: g.mode }))
      .sort((a, b) => a.capabilityId.localeCompare(b.capabilityId)),
    extras: deployment.extras,
    definition: deployment.definition ?? null,
  });
  return sha256Hex(canonical).slice(0, 32);
}

const profileFormSchema = z.object({
  // U35-1 (pass 35): the name as the person meant it, entities decoded once
  // and markup refused; the id is derived from the normalized text. Ruling
  // 518: the operator's form carries no name or role, so both may be absent
  // here and an agent profile's save requires them (`requireIdentity`).
  name: z
    .string()
    .default("")
    .transform(normalizeDisplayName)
    .superRefine((name, issue) => {
      const refusal = name ? displayNameRefusal(name) : null;
      if (refusal) issue.addIssue({ code: "custom", message: refusal });
    }),
  role: z.string().trim().default(""),
  backend: z.enum(["codex", "claude"]),
  stages: z.array(z.string().min(1)).min(1, "At least one stage is required."),
  definition: z.string().default(""),
  /** The long persona/instructions (D6) — system-prompt material; "" = keep. */
  persona: z.string().default(""),
  /** Picked model id/alias (from the model catalog) + reasoning effort.
   * Defaulted so older clients that omit them still parse; the actions apply
   * a per-backend fallback when the string is empty. */
  model: z.string().default(""),
  effort: z.string().default(""),
  /** B5: the `deploymentFingerprint` of the record the editor read. Required
   *  on an update (see `updateAgentProfile`); a create has no prior record. */
  fingerprint: z.string().default(""),
  caps: z.record(z.string(), modeSchema).default({}),
  /** Operator only: default autonomy the run uses (supervised | full). */
  autonomy: z.enum(["supervised", "full"]).optional(),
  resources: z
    .object({
      skills: z.array(z.string()).default([]),
      mcps: z.array(z.string()).default([]),
      kb: z.array(z.string()).default([]),
    })
    .default({ skills: [], mcps: [], kb: [] }),
});

export type ProfileFormInput = z.infer<typeof profileFormSchema>;

/** The submitted profile form as the transport delivered it: any value
 *  `JSON.parse` can hand back. The route decodes the transport, `parseForm`
 *  judges the content — so the type that travels between them is "decoded
 *  JSON", not "anything at all". */
export type SubmittedProfileForm =
  | string
  | number
  | boolean
  | null
  | SubmittedProfileForm[]
  | { [key: string]: SubmittedProfileForm };

function requireProjectAction(
  db: DatabaseSync,
  ctx: ProfileMutationContext,
  projectSlug: string,
  actor: ProfileActor,
): { projectName: string } {
  // Single canonical guard: agent profile CRUD is admin-only (`manage-agents`).
  return assertProjectAction(
    db,
    "manage-agents",
    projectSlug,
    actor,
    "change agent capability policy",
    { dataRoot: ctx.dataRoot },
  );
}

/** An agent profile is saved with a name and a role. The operator has
 *  neither: it is one agent, called Operator (ruling 518). */
function requireIdentity(form: ProfileFormInput): void {
  if (!form.name) throw AppError.validation("Name is required.");
  if (!form.role) throw AppError.validation("Role is required.");
}

function parseForm(raw: SubmittedProfileForm): ProfileFormInput {
  const parsed = profileFormSchema.safeParse(raw);
  if (!parsed.success) {
    throw AppError.validation(
      parsed.error.issues[0]?.message ??
        "Name, role, one execution backend, and at least one stage are required.",
    );
  }
  // F21-13: the backend and the model must agree. Live repro: editing a Codex
  // profile, clicking "Claude", and saving WHILE the model select still
  // read "loading available models…" persisted `backends: [claude]` next to
  // `model: gpt-5.6-terra`. Nothing rejected it, and the run then silently ran
  // on Claude's default — the agents page named one model, the provider ran
  // another, and no surface said so. Same validator the runtime uses
  // (`isKnownModel`, via `foreignModelBackend`), so save-time and run-time can
  // never disagree about what a backend can run.
  const foreign = foreignModelBackend(parsed.data.backend, parsed.data.model);
  if (foreign) {
    throw AppError.validation(
      `${modelDisplayName(foreign, parsed.data.model)} is a ${BACKEND_LABEL[foreign]} model. ` +
        `${BACKEND_LABEL[parsed.data.backend]} cannot run it. Pick a model from the ` +
        `${BACKEND_LABEL[parsed.data.backend]} list.`,
    );
  }
  return parsed.data;
}

const ALWAYS_HUMAN = new Set<string>(ALWAYS_HUMAN_CAPABILITY_IDS);

/** Caps record → id-based grants (off = not granted) against a defaults map
 * (the specialist modal catalog OR the operator catalog).
 *
 * Server-side invariant: a capability in ALWAYS_HUMAN_CAPABILITY_IDS (merge PR,
 * transition-to-done, change project policy) can NEVER be stored in an
 * actionable mode — whatever the submitted form says, it is coerced to
 * `human`. This is the enforcement point the catalog comment refers to; no
 * write path can persist an always-human grant an agent could act on.
 *
 * R20-6/F20-21: for a SPECIALIST profile (`specialist: true`), a submitted
 * `recommend` normalizes DOWN to `off` (withheld) via
 * `coerceSpecialistCapabilityMode` — the specialist picker never offers
 * `recommend`, and widening a stray one to `direct` (the old R7-5 behavior) made
 * a stored `recommend` render/count/enforce as `direct`. Normalizing to the SAFE
 * direction keeps file = enforcement = display. The operator (`specialist:
 * false`) keeps its real `recommend` modes. */
function grantsFor(
  caps: Record<string, CapMode>,
  defaults: Readonly<Record<string, CapMode>>,
  { specialist }: { specialist: boolean },
): GrantDecision {
  const grants: { capabilityId: string; mode: CapabilityMode }[] = [];
  for (const [capabilityId, def] of Object.entries(defaults)) {
    let mode = caps[capabilityId] ?? def;
    if (capabilityId === "report-validation-verdict") {
      // F10-07/F10-14: verdict authority is EXPLICIT-ONLY and must never be
      // widened by a round-trip. Persist `direct` iff the toggle is direct;
      // every other value (including a legacy `recommend`) persists `off`. Do
      // NOT run the specialist recommend→direct coercion on this id.
      mode = mode === "direct" ? "direct" : "off";
    } else if (specialist) {
      mode = coerceSpecialistCapabilityMode(mode);
    }
    // Always-human caps are coerced to `human` whatever the form says.
    if (ALWAYS_HUMAN.has(capabilityId)) mode = "human";
    // Persist EVERY grant, including `off` (withheld). Dropping `off` here made
    // it a silent no-op: the specialist tool policy denies a repo-mutating tool
    // only when it SEES an explicit `off`/`human` grant, so a dropped `off` read
    // back as "unspecified" and left the tool available. Storing it makes the
    // withholding real (the operator gate already treats stored-off = deny).
    grants.push({ capabilityId, mode });
  }
  // F14: never persist a deliverer whose headline `execute-code-or-write-repo`
  // is merely ABSENT while its scoped delivery grants are actionable (the edit
  // path used to materialize that absence as `off` and silently veto delivery).
  // B-AG1: an EXPLICIT delivery withholding is reported, never overturned. The
  // browser→egress coupling runs in the same pass (owner ruling 2026-08-20:
  // a granted browser carries web egress with it).
  return applyGrantCouplings(grants);
}

/** CREATE-path grants: persist the modal caps the form submitted, with the
 * ALWAYS_HUMAN coercion — and an EXPLICIT `off` for every governed capability
 * the form left out.
 *
 * Unlike `grantsFor` (the edit path), this deliberately does NOT seed the
 * unspecified caps from the permissive catalog defaults. Merging defaults on
 * create was a safe-by-default violation: a form that submitted 2 caps
 * persisted ~12, silently granting repo-mutating power (create-task-branch,
 * commit-push-branch, open-review-pr) the creator never chose. A capability the
 * form omits is NOT granted.
 *
 * P13-AP-06: "not granted" is now WRITTEN DOWN rather than left absent. The
 * runtime polarity is "deny only on an explicit `human`/`off`", so an omitted
 * id read back as *unspecified* — i.e. allowed. A form that submitted nothing
 * produced `capabilities: []` and therefore an agent with full repo-write
 * power, the exact opposite of what omitting the toggles means. Every governed
 * id is now materialized; only ids outside the curated set are ignored.
 *
 * Create is ALWAYS a specialist profile, so a submitted `recommend` normalizes
 * to `off` (withheld) per R20-6/F20-21 — never up to `direct`; always-human ids
 * stay `human`. */
function createModalGrants(caps: Record<string, CapMode>): GrantDecision {
  // The delivery headline is decided from what the form SUBMITTED, before the
  // omitted ids are materialized as `off` below — otherwise the editor artifact
  // (scoped delivery submitted, headline key absent: the shape that produced
  // VIB-1) becomes indistinguishable from an admin's explicit withholding, and
  // B-AG1's respect-the-`off` rule would veto the delivery the creator just
  // chose. An explicit `off` here IS the admin's, and stands.
  const submittedDelivery = repairDeliveryGrants(
    Object.entries(caps).map(([capabilityId, mode]) => ({ capabilityId, mode })),
  );
  const headlineRepaired = submittedDelivery.notice?.kind === "repaired";
  const grants: { capabilityId: string; mode: CapabilityMode }[] = [];
  for (const capabilityId of MODAL_CAP_IDS) {
    const submitted = caps[capabilityId];
    const mode = ALWAYS_HUMAN.has(capabilityId)
      ? "human"
      : submitted === undefined
        ? // Omitted by the form → withheld, and stored as such (except the
          //   delivery headline a submitted scoped grant just repaired).
          headlineRepaired && capabilityId === "execute-code-or-write-repo"
          ? "direct"
          : "off"
        : capabilityId === "report-validation-verdict"
          ? // F10-07/F10-14: verdict is explicit-only — direct or nothing.
            submitted === "direct"
            ? "direct"
            : "off"
          : coerceSpecialistCapabilityMode(submitted);
    grants.push({ capabilityId, mode });
  }
  // F14: a deliverer must hold the headline repo-write capability (master gate).
  // The delivery decision is authoritative on the SUBMITTED view above (the
  // materialized `off` for an omitted headline is a loop artifact, not admin
  // intent); the browser→egress coupling runs over the MATERIALIZED grants,
  // because an omitted egress row becomes an explicit `off` in the loop and
  // must still follow a submitted browser grant.
  const browser = repairBrowserEgressGrants(grants);
  return {
    grants: browser.grants,
    notices: [submittedDelivery.notice, browser.notice].filter(
      (n): n is GrantCouplingNotice => n !== null,
    ),
  };
}

// ------------------------------------------------------------------ create

export async function createAgentProfile(
  db: DatabaseSync,
  input: { projectSlug: string; form: SubmittedProfileForm },
  actor: ProfileActor,
  ctx: ProfileMutationContext = {},
): Promise<ProfileSaveResult> {
  const { projectName } = requireProjectAction(db, ctx, input.projectSlug, actor);
  const form = parseForm(input.form);
  requireIdentity(form);

  const ref = {
    projectSlug: input.projectSlug,
    dataRoot: ctx.dataRoot,
  };

  let profileId = "";
  const delivery: DeliveryNoticeHolder = { notices: [] };
  // Ruling 139: a new profile has no stored tier, so an explicit effort is
  // always a change and is judged by name.
  if (form.effort.trim()) assertEffortForBackend(form.backend, form.effort);
  await updateProjectFile(ref, (parsed) => {
    const taken = new Set(parsed.frontmatter.agents.map((a) => a.profileId));
    // Server-generated slug id with a uniqueness check (agents spec §4.5) —
    // also avoid shadowing an undeployed org template file.
    const base = slugify(form.name) || "specialist";
    let candidate = base;
    let n = 2;
    while (
      taken.has(candidate) ||
      existsSync(agentProfileFilePath(candidate, ctx.dataRoot))
    ) {
      candidate = `${base}-${n}`;
      n += 1;
    }
    profileId = candidate;

    const definition: AgentDeploymentDefinition = {
      kind: "specialist",
      name: form.name,
      role: form.role,
      icon: "agents",
      backends: [form.backend],
      // Store the picked model + effort (from the catalog picker). No more
      // hardcoded invalid "claude-sonnet" — fall back per-backend only when
      // the form omits a pick.
      model: form.model.trim() || defaultModelFor(form.backend),
      effort: form.effort.trim() || defaultEffortFor(form.backend),
      scope: `Created in ${parsed.frontmatter.name}`,
      desc:
        form.definition.trim() ||
        `${form.name}, a ${form.role.toLowerCase()} specialist.`,
    };
    // The long persona (D6) — the run's system-prompt material. Written only
    // when the form carries one, in its catalog position, so an empty box
    // leaves the key absent rather than storing "".
    const persona = form.persona.trim();
    if (persona) definition.persona = persona;
    definition.stages = form.stages;
    definition.resources = form.resources;

    const created = createModalGrants(form.caps);
    delivery.notices = created.notices;
    const deployment: AgentDeployment = {
      profileId,
      capabilities: created.grants,
      extras: [],
      definition,
    };
    parsed.frontmatter.agents.push(deployment);
  });

  reprojectProject(db, ctx, input.projectSlug);
  const details: ProfileCreatedAuditDetails = {
    name: form.name,
    role: form.role,
    backend: form.backend,
    projectName,
  };
  const result: ProfileSaveResult = { profileId, name: form.name };
  // B-AG1: a coupling decision the save made (or refused to make) is never
  // silent — the audit row carries it and the caller shows it.
  carryCouplingNotices(details, result, delivery.notices);
  recordAudit(db, {
    action: "project.agent_profile.created",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "agent_profile",
    subjectId: profileId,
    projectSlug: input.projectSlug,
    details,
  });
  return result;
}

// --------------------------------------------------- deploy from library

/**
 * Copy an org-level TEMPLATE into this project's `agents:` deployment list —
 * the project side of "Global agent profiles are a real template library"
 * (owner ruling 1, P13-AP-05).
 *
 * Before this, no code path anywhere added a template to a project, so a
 * profile created in org settings was permanently unreachable: never deployed,
 * never run, never offered to the operator. The org editor promised a
 * lifecycle it could not complete.
 *
 * What is copied:
 *  - a FULL definition snapshot of the template (the same shape the project
 *    editor writes), so the deployment is self-contained and editable here;
 *  - EXPLICIT capability grants — the template's own grants when it has any,
 *    else the CONSERVATIVE defaults (delivery withheld), matching what the org
 *    editor persists for a template it has no capability UI for.
 *
 * P14-LV-01: this fallback used to be `defaultGrantsFor("agent")`, which grants
 * all four delivery capabilities at `direct`. Deploying `org-docs-writer` — a
 * template whose own description reads "never touches app code" and whose file
 * carries `capabilities: []` — therefore produced a project agent holding
 * repo-write, branch, push, open-PR and both verdict capabilities. Observed
 * live through this exact button. The project editor (which DOES have a
 * capability matrix) is where power gets opened up.
 */
/** A global specialist template, read and checked for a deploy. */
export interface LibraryTemplate {
  profileId: string;
  parsed: ParsedAgentProfile;
}

/**
 * Read the global template `profileId` names, refusing BY NAME an id that is
 * not a store segment, a template that does not exist, and one that is not a
 * specialist (the operator and the controller are never deployable this way).
 * Reads only: the library deploy and a controller-built project's roster
 * (ruling 464) both call it before anything is written.
 */
export function readLibraryTemplate(
  rawProfileId: string,
  dataRoot?: string,
): LibraryTemplate {
  const profileId = rawProfileId.trim();
  if (!profileId) throw AppError.validation("Pick a profile to add.");
  // P13-AP-11 (sibling): `agentProfileFilePath` path.joins its argument
  // straight into the store — unlike skills/KB, which got an explicit
  // containment guard (F10-18). `profileId` here comes from a form field, so
  // this new path validates the segment itself rather than inheriting the gap.
  try {
    resolveStoreSegment(agentProfilesDir(dataRoot), profileId);
  } catch {
    throw AppError.validation(`\`${profileId}\` is not a valid profile id.`);
  }

  const absPath = agentProfileFilePath(profileId, dataRoot);
  if (!existsSync(absPath)) {
    throw AppError.notFound(`No global agent profile \`${profileId}\`.`);
  }
  const { parsed } = parseAgentProfileContent(readFileSync(absPath, "utf8"), {
    fallbackId: profileId,
  });
  if (!parsed || parsed.frontmatter.kind !== "specialist") {
    throw AppError.validation(
      `\`${profileId}\` is not a specialist template and can't be added to a project.`,
    );
  }
  return { profileId, parsed };
}

/** Ruling 139: a deploy's explicit model and effort, each optional. */
export interface DeployOverrides {
  model?: string;
  effort?: string;
}

/** What a library deploy writes and reports, built before any write. */
export interface LibraryDeploymentBuild {
  deployment: AgentDeployment;
  applied: NonNullable<ProfileSaveResult["applied"]>;
  /** Ruling 264: read off the grants the deployment carries. */
  delivery: "granted" | "withheld";
  notices: GrantCouplingNotice[];
}

/**
 * The deployment a library deploy writes for `template` into the project
 * called `projectName`, with ruling 139's explicit `model` / `effort`
 * overrides judged by name against the backend it will run on — a pure
 * build that throws before anything is written. Ruling 464: the Agents page's
 * deploy and a controller-built project's `agents` roster share it, so a
 * roster entry is exactly what deploying that template afterwards would have
 * written.
 */
export function buildLibraryDeployment(
  template: LibraryTemplate,
  overrides: DeployOverrides,
  projectName: string,
): LibraryDeploymentBuild {
  const { profileId, parsed } = template;
  const fm = parsed.frontmatter;

  // AP-06 / P14-LV-01: explicit grants, never an empty list — the template's own
  // grants when it has them, else the CONSERVATIVE set (delivery withheld), the
  // same list org-level create persists. B-AG1: the delivery-headline decision
  // is REPORTED here too. `normalizeDeliveryGrants` drops the notice, which is
  // the no-audit shape B-AG1 was filed against: a template whose scoped delivery
  // is on with the headline explicitly off deploys as a profile that cannot
  // deliver, and nothing said so.
  const deployDelivery = applyGrantCouplings(
    (fm.capabilities.length
      ? fm.capabilities
      : conservativeGrantsFor("agent")
    ).map((g) => ({
      capabilityId: g.capabilityId,
      mode: ALWAYS_HUMAN.has(g.capabilityId)
        ? "human"
        : coerceSpecialistCapabilityMode(g.mode),
    })),
  );

  const backend = fm.backends[0] === "codex" ? "codex" : "claude";
  // F21-13: a LIBRARY template is not a form — refusing the deployment over
  // a stale template's model would strand the human with nothing to fix on
  // this screen. Fall back to the backend's default instead, which is what
  // the run would have used anyway; the difference is that project.md now
  // records it, so the agents page and the run agree.
  const templateModel = fm.model.trim();
  const templateEffort = fm.effort?.trim() ?? "";
  // Ruling 139: an EXPLICIT override is judged by name against the backend
  // the deployment will run on; the template's own values are taken as
  // they are (the F21-13 rule above stays true).
  const modelOverride = overrides.model?.trim() ?? "";
  const effortOverride = overrides.effort?.trim() ?? "";
  if (modelOverride) assertModelForBackend(backend, modelOverride);
  if (effortOverride) assertEffortForBackend(backend, effortOverride);
  const definition: AgentDeploymentDefinition = {
    kind: "specialist",
    name: fm.name,
    role: fm.role || fm.name,
    icon: fm.icon,
    backends: fm.backends.length ? fm.backends : [backend],
    model:
      modelOverride ||
      (templateModel && !foreignModelBackend(backend, templateModel)
        ? templateModel
        : defaultModelFor(backend)),
    // Ruling 153 (pass 35, G35-2): the template's own default effort is
    // taken when it is a tier this backend offers; an override still wins,
    // and an absent or foreign tier falls back to the backend default.
    effort:
      effortOverride ||
      (templateEffort && effortsFor(backend).includes(templateEffort)
        ? templateEffort
        : defaultEffortFor(backend)),
    scope: `Added from the global library to ${projectName}`,
    desc: fm.desc || parsed.description,
  };
  // The template's markdown body becomes the deployment's persona — absent
  // when the template has none, so the key stays off the record entirely.
  if (parsed.description) definition.persona = parsed.description;
  definition.stages = fm.stages;
  definition.spanAll = fm.spanAll;
  definition.resources = {
    skills: fm.resources.skills,
    mcps: fm.resources.mcps,
    kb: fm.resources.kb,
  };

  const model = definition.model ?? "";
  return {
    deployment: {
      profileId,
      capabilities: deployDelivery.grants,
      extras: fm.extras.map((e) => ({ label: e.label, mode: e.mode })),
      definition,
    },
    applied: {
      backend,
      model,
      modelLabel: modelDisplayName(backend, model),
      effort: definition.effort ?? "",
    },
    // Ruling 264: read the answer off the grants that are actually written,
    // through the predicate the RUN gates on, so the reply cannot drift from it.
    delivery: deliveryWithheld(deployDelivery.grants) ? "withheld" : "granted",
    notices: deployDelivery.notices,
  };
}

export async function deployAgentProfileFromLibrary(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    profileId: string;
    /** Ruling 139: EXPLICIT overrides of the template's model and effort,
     *  judged by name against the deployment's primary backend before the
     *  write. A library template's OWN model is still not refused (F21-13). */
    model?: string;
    effort?: string;
  },
  actor: ProfileActor,
  ctx: ProfileMutationContext = {},
): Promise<ProfileSaveResult> {
  const { projectName } = requireProjectAction(db, ctx, input.projectSlug, actor);
  const template = readLibraryTemplate(input.profileId, ctx.dataRoot);
  const { profileId } = template;
  const fm = template.parsed.frontmatter;
  const overrides: DeployOverrides = {};
  if (input.model !== undefined) overrides.model = input.model;
  if (input.effort !== undefined) overrides.effort = input.effort;

  let built: LibraryDeploymentBuild | undefined;
  await updateProjectFile(
    { projectSlug: input.projectSlug, dataRoot: ctx.dataRoot },
    (project) => {
      if (project.frontmatter.agents.some((a) => a.profileId === profileId)) {
        throw AppError.conflict(
          `${fm.name} is already deployed in this project.`,
        );
      }
      built = buildLibraryDeployment(template, overrides, project.frontmatter.name);
      project.frontmatter.agents.push(built.deployment);
    },
  );

  reprojectProject(db, ctx, input.projectSlug);
  const details: ProfileDeployedAuditDetails = {
    name: fm.name,
    source: "library",
    projectName,
  };
  const result: ProfileSaveResult = { profileId, name: fm.name };
  if (built) {
    details.model = built.applied.model;
    details.effort = built.applied.effort;
    result.applied = built.applied;
    result.delivery = built.delivery;
    carryCouplingNotices(details, result, built.notices);
  }
  recordAudit(db, {
    action: "project.agent_profile.deployed",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "agent_profile",
    subjectId: profileId,
    projectSlug: input.projectSlug,
    details,
  });
  return result;
}

// ------------------------------------------------------------------ update

export async function updateAgentProfile(
  db: DatabaseSync,
  input: { projectSlug: string; profileId: string; form: SubmittedProfileForm },
  actor: ProfileActor,
  ctx: ProfileMutationContext = {},
): Promise<ProfileSaveResult> {
  requireProjectAction(db, ctx, input.projectSlug, actor);
  const form = parseForm(input.form);
  const delivery: DeliveryNoticeHolder = { notices: [] };
  // F20-20: capture the operator governance transition this save makes, so the
  // audit + toast can name it instead of the generic "profile updated". Filled
  // inside the writer callback where the prior view and the saved grants exist.
  const gov: OperatorGovernanceTransition = {
    isOperator: false,
    priorAutonomy: "supervised",
    newAutonomy: "supervised",
    priorDirectAccept: false,
    newDirectAccept: false,
  };

  const ref = {
    projectSlug: input.projectSlug,
    dataRoot: ctx.dataRoot,
  };

  let appliedUpdate: ProfileSaveResult["applied"] | undefined;
  // The name the saved profile goes by: the form's, or the operator's own,
  // which no save changes (ruling 518). Filled inside the writer callback.
  let savedName = form.name;
  // Ruling 467: the persona this save wrote when it differs from the one it
  // replaced, for the audit row (a holder: the writer callback fills it).
  const personaEdit: PersonaEditHolder = { after: null };
  await updateProjectFile(ref, (parsed) => {
    const deployment = parsed.frontmatter.agents.find(
      (a) => a.profileId === input.profileId,
    );
    if (!deployment) {
      throw AppError.notFound(`No agent profile ${input.profileId} in this project.`);
    }
    // B5 (pass 34, U34-3): the ONE place the current record and the submission
    // are both in hand. A save that was composed against a different record
    // writes nothing: it would silently revert every governed grant the write
    // it never saw had changed. A validation refusal, so nothing is audited.
    const seen = deploymentFingerprint(deployment);
    if (form.fingerprint !== seen) {
      throw AppError.conflict(
        "This profile changed while the editor was open. Reopen it to see the current grants, then save again.",
      );
    }
    const current = effectiveProfileView(deployment, ctx.dataRoot, VIEW_WITHOUT_POLICY);
    const isOperator = current.kind === "operator";
    if (isOperator) savedName = current.name;
    else requireIdentity(form);
    // Ruling 139: a CHANGED effort is judged by name against the backend it
    // will run on. An unchanged value is never re-judged, so a deployment
    // that legitimately stores a preserved tier (Codex `minimal`, accepted
    // but not offered) stays editable on every other field.
    const submittedEffort = form.effort.trim();
    if (submittedEffort && submittedEffort !== (current.effort ?? "")) {
      assertEffortForBackend(form.backend, submittedEffort);
    }

    // Grants come from the form for the GOVERNED capability set of this kind
    // (operator coordination caps vs specialist modal caps); everything outside
    // that set is preserved untouched, as are display-only extras.
    const governedIds = isOperator ? OPERATOR_CAP_IDS : MODAL_CAP_IDS;
    const governedDefaults = isOperator ? OPERATOR_CAP_DEFAULTS : CAP_MODAL_DEFAULTS;
    const preserved = deployment.capabilities.filter(
      (c) => !governedIds.has(c.capabilityId),
    );
    const saved = grantsFor(form.caps, governedDefaults, {
      specialist: !isOperator,
    });
    delivery.notices = saved.notices;
    deployment.capabilities = [...saved.grants, ...preserved];

    // F20-20: record the operator's autonomy + direct-accept transition. The
    // stored autonomy is the definition value written below (`form.autonomy ??
    // current.autonomy ?? "supervised"`), so read it the same way.
    if (isOperator) {
      const directAcceptOf = (
        grants: { capabilityId: string; mode: string }[],
      ) =>
        grants.some(
          (c) =>
            c.capabilityId === "completion-for-acceptance" && c.mode === "direct",
        );
      gov.isOperator = true;
      gov.priorAutonomy = current.autonomy ?? "supervised";
      gov.newAutonomy = form.autonomy ?? current.autonomy ?? "supervised";
      gov.priorDirectAccept = directAcceptOf(current.capabilities);
      gov.newDirectAccept = directAcceptOf(saved.grants);
    }

    // Full-definition override. Both kinds now store the picked backend + model
    // + effort (the operator no longer keeps the "orchestration runtime"
    // placeholder — it runs on a real backend/model). The operator additionally
    // stores its default autonomy, and never a name, a role or a scope: those
    // are its template's (ruling 518, `OPERATOR_FIXED_FIELDS`). Written field
    // by field in the file's order.
    const definition: AgentDeploymentDefinition = { kind: current.kind };
    if (!isOperator) {
      definition.name = form.name;
      definition.role = form.role;
    }
    definition.icon = current.icon;
    definition.backends = [form.backend];
    definition.model = form.model.trim() || defaultModelFor(form.backend);
    if (form.effort.trim()) definition.effort = form.effort.trim();
    else if (!isOperator) definition.effort = defaultEffortFor(form.backend);
    if (!isOperator) definition.scope = current.scope;
    // Empty definition → keep the existing/template prose (current.desc);
    // never persist a generated placeholder that would permanently shadow the
    // org template's real description (and its ungrammatical "a implementation
    // specialist" wording). Same for operator and specialist.
    definition.desc = form.definition.trim() || current.desc;
    // Empty persona → keep the existing persona (deployment override or the
    // template body), mirroring the desc rule above.
    const persona = form.persona.trim() || current.definition;
    if (persona) definition.persona = persona;
    definition.stages = form.stages;
    definition.spanAll = current.spanAll;
    // Operator only: a specialist definition carries no `autonomy` key at all.
    if (isOperator) {
      definition.autonomy = form.autonomy ?? current.autonomy ?? "supervised";
    }
    definition.resources = form.resources;
    deployment.definition = definition;
    const personaAfter = definition.persona ?? current.definition;
    if (personaAfter !== current.definition) personaEdit.after = personaAfter;
    appliedUpdate = {
      backend: form.backend,
      model: definition.model ?? "",
      modelLabel: modelDisplayName(form.backend, definition.model ?? ""),
      effort: definition.effort ?? "",
    };
  });

  reprojectProject(db, ctx, input.projectSlug);

  // F20-20: raising an operator to FULL autonomy (or newly granting it "Accept
  // completion into Done") lets it close tasks with no human — a governance
  // decision that must be discoverable, not buried under a generic profile
  // update. Stamp the transition on the update row's details AND write a
  // dedicated audit event whenever it actually changes.
  const autonomyElevatedToFull =
    gov.isOperator && gov.newAutonomy === "full" && gov.priorAutonomy !== "full";
  const directAcceptNewlyGranted =
    gov.isOperator && gov.newDirectAccept && !gov.priorDirectAccept;
  // The human-only-Done exception is LIVE after this save iff both hold (the
  // exact combination `operatorAcceptCompletion` in operator-actions.server.ts
  // checks).
  const directDoneLive =
    gov.isOperator && gov.newAutonomy === "full" && gov.newDirectAccept;

  const details: ProfileUpdatedAuditDetails = {
    name: savedName,
    backend: form.backend,
  };
  if (!gov.isOperator) details.role = form.role;
  if (appliedUpdate) {
    details.model = appliedUpdate.model;
    details.effort = appliedUpdate.effort;
  }
  if (personaEdit.after !== null) {
    details.personaChanged = true;
    details.personaChars = personaEdit.after.length;
  }
  if (gov.isOperator) {
    details.operatorAutonomy = gov.newAutonomy;
    details.acceptCompletionIntoDone = gov.newDirectAccept ? "direct" : "off";
    details.acceptCompletionActsDirectly = directDoneLive;
  }
  const result: ProfileSaveResult = {
    profileId: input.profileId,
    name: savedName,
  };
  if (appliedUpdate) result.applied = appliedUpdate;
  carryCouplingNotices(details, result, delivery.notices);
  recordAudit(db, {
    action: "project.agent_profile.updated",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "agent_profile",
    subjectId: input.profileId,
    projectSlug: input.projectSlug,
    details,
  });

  let governanceNotice: { message: string } | undefined;
  if (autonomyElevatedToFull || directAcceptNewlyGranted) {
    const message = directDoneLive
      ? `${savedName} now runs at full autonomy with “Accept completion into Done” granted. It can move tasks to Done without a human.`
      : autonomyElevatedToFull
        ? `${savedName} autonomy raised to full. It crosses auto boundaries and dispatches agents without asking; approval and human boundaries still wait for a person, and “Accept completion into Done” still needs its direct grant to close tasks.`
        : `“Accept completion into Done” granted to ${savedName}. It takes effect only at full autonomy (currently ${gov.newAutonomy}).`;
    governanceNotice = { message };
    recordAudit(db, {
      action: "project.operator.autonomy_changed",
      actor: { userId: actor.userId, label: actor.label },
      subjectKind: "agent_profile",
      subjectId: input.profileId,
      projectSlug: input.projectSlug,
      details: {
        name: savedName,
        from: gov.priorAutonomy,
        to: gov.newAutonomy,
        acceptCompletionIntoDone: gov.newDirectAccept ? "direct" : "off",
        directDoneLive,
        message,
      },
    });
  }


  if (governanceNotice) result.governanceNotice = governanceNotice;
  return result;
}

// ------------------------------------------------------------------ delete

/**
 * Ruling 464: the refusal the controller's `remove_agent_deployment` adds to
 * the Agents page's Delete — a profile that is the delivering or an engaged
 * agent on an open task stays, and the sentence names those tasks. "Open" is
 * the population the Agents page lists under the profile's active
 * deployments (`listAgentDeployments`: not archived, not in the final stage).
 */
function openEngagementRefusal(
  db: DatabaseSync,
  projectSlug: string,
  profileId: string,
  name: string,
  dataRoot: string | undefined,
): string | null {
  const engaged = listAgentDeployments(db, projectSlug, { dataRoot }).filter(
    (e) => e.profileId === profileId,
  );
  if (engaged.length === 0) return null;
  const keys = (engagement: "primary" | "reviewer") => [
    ...new Set(engaged.filter((e) => e.engagement === engagement).map((e) => e.taskKey)),
  ];
  const delivering = keys("primary");
  const supporting = keys("reviewer").filter((k) => !delivering.includes(k));
  const where = [
    delivering.length ? `the delivering agent on ${delivering.join(", ")}` : "",
    supporting.length ? `engaged on ${supporting.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" and ");
  const count = delivering.length + supporting.length;
  return (
    `${name} is ${where}, ${count === 1 ? "an open task" : "open tasks"}. Nothing was removed: ` +
    `taking it off the project now would leave ${count === 1 ? "that task" : "those tasks"} with an agent that can no longer deliver or comment. ` +
    `Finish, archive or re-engage that work first.`
  );
}

export async function deleteAgentProfile(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    profileId: string;
    /** Ruling 464: why, recorded in the audit details (the controller's
     *  `remove_agent_deployment` always gives one). */
    reason?: string;
    /** Ruling 464: refuse a profile engaged on an open task, naming the
     *  tasks. The controller's door sets it; the Agents page's Delete keeps
     *  its own confirm and does not. */
    refuseOpenEngagements?: boolean;
  },
  actor: ProfileActor,
  ctx: ProfileMutationContext = {},
): Promise<{ profileId: string; name: string }> {
  requireProjectAction(db, ctx, input.projectSlug, actor);

  const ref = {
    projectSlug: input.projectSlug,
    dataRoot: ctx.dataRoot,
  };

  let name = input.profileId;
  await updateProjectFile(ref, (parsed) => {
    const deployment = parsed.frontmatter.agents.find(
      (a) => a.profileId === input.profileId,
    );
    if (!deployment) {
      throw AppError.notFound(`No agent profile ${input.profileId} in this project.`);
    }
    const current = effectiveProfileView(deployment, ctx.dataRoot, VIEW_WITHOUT_POLICY);
    if (current.kind === "operator") {
      // The operator is a system profile — never deletable (agents §4.3),
      // enforced server-side, not just by hiding the button.
      throw AppError.forbidden(
        "The Operator is a system profile and can't be deleted.",
      );
    }
    if (input.refuseOpenEngagements) {
      const refusal = openEngagementRefusal(
        db,
        input.projectSlug,
        input.profileId,
        current.name,
        ctx.dataRoot,
      );
      if (refusal) throw AppError.conflict(refusal);
    }
    name = current.name;
    parsed.frontmatter.agents = parsed.frontmatter.agents.filter(
      (a) => a.profileId !== input.profileId,
    );
  });

  reprojectProject(db, ctx, input.projectSlug);
  const details: ProfileDeletedAuditDetails = { name };
  if (input.reason) details.reason = input.reason;
  recordAudit(db, {
    action: "project.agent_profile.deleted",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "agent_profile",
    subjectId: input.profileId,
    projectSlug: input.projectSlug,
    details,
  });
  return { profileId: input.profileId, name };
}
