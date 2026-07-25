import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AgentDeployment, CapabilityMode } from "~/schemas/project-file.schema";
import {
  ALWAYS_HUMAN_CAPABILITY_IDS,
  coerceSpecialistCapabilityMode,
  conservativeGrantsFor,
  normalizeDeliveryGrants,
} from "~/shared/capabilities";
import { slugify } from "~/shared/ids/slugify";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { assertProjectAction } from "~/server/auth/project-authority.server";
import {
  agentProfileFilePath,
  agentProfilesDir,
  projectFilePath,
  resolveStoreSegment,
} from "~/server/files/file-store-root.server";
import { updateProjectFile } from "~/server/files/project-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import {
  defaultEffortFor,
  defaultModelFor,
} from "~/server/runtimes/model-catalog.server";
import { existsSync, readFileSync } from "node:fs";
import { parseAgentProfileContent } from "~/server/files/agent-profile-file.server";
import {
  effectiveProfileView,
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

export interface ProfileMutationContext {
  dataRoot?: string;
}

const modeSchema = z.enum(["direct", "recommend", "human", "off"]);

// Per-backend fallbacks when the form omits a picked model/effort (older
// client, or a create before the catalog loads) come from the model catalog —
// the FIRST available model + the default effort — so we never hardcode a
// specific id that could drift out of the list.

const profileFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required."),
  role: z.string().trim().min(1, "Role is required."),
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

function reprojectProject(
  db: DatabaseSync,
  ctx: ProfileMutationContext,
  projectSlug: string,
): void {
  rebuildPath(db, projectFilePath(projectSlug, ctx.dataRoot), {
    dataRoot: ctx.dataRoot,
  });
}

function parseForm(raw: unknown): ProfileFormInput {
  const parsed = profileFormSchema.safeParse(raw);
  if (!parsed.success) {
    throw AppError.validation(
      parsed.error.issues[0]?.message ??
        "Name, role, one execution backend, and at least one stage are required.",
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
 * R7-5: for a SPECIALIST profile (`specialist: true`), a submitted `recommend`
 * is coerced to `direct` ('Allowed') — the specialist picker never offers
 * `recommend`, so this keeps a hostile/legacy form honest. The operator
 * (`specialist: false`) keeps its real `recommend` modes. */
function grantsFor(
  caps: Record<string, CapMode>,
  defaults: Readonly<Record<string, CapMode>>,
  { specialist }: { specialist: boolean },
): { capabilityId: string; mode: CapabilityMode }[] {
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
    grants.push({ capabilityId, mode: mode as CapabilityMode });
  }
  // F14: never persist a contradictory deliverer (scoped delivery actionable but
  // the headline `execute-code-or-write-repo` withheld). The edit path used to
  // materialize the absent headline to `off` from the defaults map, silently
  // vetoing all delivery — this repairs it.
  return normalizeDeliveryGrants(grants);
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
 * Create is ALWAYS a specialist profile, so a submitted `recommend` coerces to
 * `direct` ('Allowed') per R7-5; always-human ids stay `human`. */
function createModalGrants(
  caps: Record<string, CapMode>,
): { capabilityId: string; mode: CapabilityMode }[] {
  const grants: { capabilityId: string; mode: CapabilityMode }[] = [];
  for (const capabilityId of MODAL_CAP_IDS) {
    const submitted = caps[capabilityId];
    const mode = ALWAYS_HUMAN.has(capabilityId)
      ? "human"
      : submitted === undefined
        ? // Omitted by the form → withheld, and stored as such.
          "off"
        : capabilityId === "report-validation-verdict"
          ? // F10-07/F10-14: verdict is explicit-only — direct or nothing.
            submitted === "direct"
            ? "direct"
            : "off"
          : coerceSpecialistCapabilityMode(submitted);
    grants.push({ capabilityId, mode: mode as CapabilityMode });
  }
  // F14: a deliverer must hold the headline repo-write capability (master gate).
  return normalizeDeliveryGrants(grants);
}

// ------------------------------------------------------------------ create

export async function createAgentProfile(
  db: DatabaseSync,
  input: { projectSlug: string; form: unknown },
  actor: ProfileActor,
  ctx: ProfileMutationContext = {},
): Promise<{ profileId: string; name: string }> {
  const { projectName } = requireProjectAction(db, ctx, input.projectSlug, actor);
  const form = parseForm(input.form);

  const ref = {
    projectSlug: input.projectSlug,
    dataRoot: ctx.dataRoot,
  };

  let profileId = "";
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
        `${form.name} — a ${form.role.toLowerCase()} specialist.`,
      // The long persona (D6) — the run's system-prompt material.
      ...(form.persona.trim() ? { persona: form.persona.trim() } : {}),
      stages: form.stages,
      resources: form.resources,
    };
    const deployment: AgentDeployment = {
      profileId,
      capabilities: createModalGrants(form.caps),
      extras: [],
    };
    (deployment as Record<string, unknown>).definition = definition;
    parsed.frontmatter.agents.push(deployment);
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.agent_profile.created",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "agent_profile",
    subjectId: profileId,
    projectSlug: input.projectSlug,
    details: { name: form.name, role: form.role, backend: form.backend, projectName },
  });
  return { profileId, name: form.name };
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
export async function deployAgentProfileFromLibrary(
  db: DatabaseSync,
  input: { projectSlug: string; profileId: string },
  actor: ProfileActor,
  ctx: ProfileMutationContext = {},
): Promise<{ profileId: string; name: string }> {
  const { projectName } = requireProjectAction(db, ctx, input.projectSlug, actor);
  const profileId = input.profileId.trim();
  if (!profileId) throw AppError.validation("Pick a profile to add.");
  // P13-AP-11 (sibling): `agentProfileFilePath` path.joins its argument
  // straight into the store — unlike skills/KB, which got an explicit
  // containment guard (F10-18). `profileId` here comes from a form field, so
  // this new path validates the segment itself rather than inheriting the gap.
  try {
    resolveStoreSegment(agentProfilesDir(ctx.dataRoot), profileId);
  } catch {
    throw AppError.validation(`\`${profileId}\` is not a valid profile id.`);
  }

  const absPath = agentProfileFilePath(profileId, ctx.dataRoot);
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
  const fm = parsed.frontmatter;

  await updateProjectFile(
    { projectSlug: input.projectSlug, dataRoot: ctx.dataRoot },
    (project) => {
      if (project.frontmatter.agents.some((a) => a.profileId === profileId)) {
        throw AppError.conflict(
          `${fm.name} is already deployed in this project.`,
        );
      }
      const backend = fm.backends[0] === "codex" ? "codex" : "claude";
      const definition: AgentDeploymentDefinition = {
        kind: "specialist",
        name: fm.name,
        role: fm.role || fm.name,
        icon: fm.icon,
        backends: fm.backends.length ? fm.backends : [backend],
        model: fm.model.trim() || defaultModelFor(backend),
        effort: defaultEffortFor(backend),
        scope: `Added from the global library to ${project.frontmatter.name}`,
        desc: fm.desc || parsed.description,
        ...(parsed.description ? { persona: parsed.description } : {}),
        stages: fm.stages,
        spanAll: fm.spanAll,
        resources: {
          skills: fm.resources.skills,
          mcps: fm.resources.mcps,
          kb: fm.resources.kb,
        },
      };
      const deployment: AgentDeployment = {
        profileId,
        // AP-06 / P14-LV-01: explicit grants, never an empty list — the
        // template's own grants when it has them, else the CONSERVATIVE set
        // (delivery withheld), the same list org-level create persists.
        capabilities: normalizeDeliveryGrants(
          (fm.capabilities.length
            ? fm.capabilities
            : conservativeGrantsFor("agent")
          ).map((g) => ({
            capabilityId: g.capabilityId,
            mode: (ALWAYS_HUMAN.has(g.capabilityId)
              ? "human"
              : coerceSpecialistCapabilityMode(g.mode)) as CapabilityMode,
          })),
        ),
        extras: fm.extras.map((e) => ({ label: e.label, mode: e.mode })),
      };
      (deployment as Record<string, unknown>).definition = definition;
      project.frontmatter.agents.push(deployment);
    },
  );

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.agent_profile.deployed",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "agent_profile",
    subjectId: profileId,
    projectSlug: input.projectSlug,
    details: { name: fm.name, source: "library", projectName },
  });
  return { profileId, name: fm.name };
}

// ------------------------------------------------------------------ update

export async function updateAgentProfile(
  db: DatabaseSync,
  input: { projectSlug: string; profileId: string; form: unknown },
  actor: ProfileActor,
  ctx: ProfileMutationContext = {},
): Promise<{ profileId: string; name: string }> {
  requireProjectAction(db, ctx, input.projectSlug, actor);
  const form = parseForm(input.form);

  const ref = {
    projectSlug: input.projectSlug,
    dataRoot: ctx.dataRoot,
  };

  await updateProjectFile(ref, (parsed) => {
    const deployment = parsed.frontmatter.agents.find(
      (a) => a.profileId === input.profileId,
    );
    if (!deployment) {
      throw AppError.notFound(`No agent profile ${input.profileId} in this project.`);
    }
    const current = effectiveProfileView(deployment, ctx.dataRoot);
    const isOperator = current.kind === "operator";

    // Grants come from the form for the GOVERNED capability set of this kind
    // (operator coordination caps vs specialist modal caps); everything outside
    // that set is preserved untouched, as are display-only extras.
    const governedIds = isOperator ? OPERATOR_CAP_IDS : MODAL_CAP_IDS;
    const governedDefaults = isOperator ? OPERATOR_CAP_DEFAULTS : CAP_MODAL_DEFAULTS;
    const preserved = deployment.capabilities.filter(
      (c) => !governedIds.has(c.capabilityId),
    );
    deployment.capabilities = [
      ...grantsFor(form.caps, governedDefaults, { specialist: !isOperator }),
      ...preserved,
    ];

    // Full-definition override. Both kinds now store the picked backend + model
    // + effort (the operator no longer keeps the "orchestration runtime"
    // placeholder — it runs on a real backend/model). The operator additionally
    // stores its default autonomy.
    const definition: AgentDeploymentDefinition = {
      kind: current.kind,
      name: form.name,
      role: form.role,
      icon: current.icon,
      backends: [form.backend],
      model: form.model.trim() || defaultModelFor(form.backend),
      ...(form.effort.trim()
        ? { effort: form.effort.trim() }
        : isOperator
          ? {}
          : { effort: defaultEffortFor(form.backend) }),
      scope: current.scope,
      // Empty definition → keep the existing/template prose (current.desc);
      // never persist a generated placeholder that would permanently shadow the
      // org template's real description (and its ungrammatical "a implementation
      // specialist" wording). Same for operator and specialist.
      desc: form.definition.trim() || current.desc,
      // Empty persona → keep the existing persona (deployment override or the
      // template body), mirroring the desc rule above.
      ...(form.persona.trim()
        ? { persona: form.persona.trim() }
        : current.definition
          ? { persona: current.definition }
          : {}),
      stages: form.stages,
      spanAll: current.spanAll,
      ...(isOperator ? { autonomy: form.autonomy ?? current.autonomy ?? "supervised" } : {}),
      resources: form.resources,
    };
    (deployment as Record<string, unknown>).definition = definition;
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.agent_profile.updated",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "agent_profile",
    subjectId: input.profileId,
    projectSlug: input.projectSlug,
    details: { name: form.name, role: form.role, backend: form.backend },
  });
  return { profileId: input.profileId, name: form.name };
}

// ------------------------------------------------------------------ delete

export async function deleteAgentProfile(
  db: DatabaseSync,
  input: { projectSlug: string; profileId: string },
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
    const current = effectiveProfileView(deployment, ctx.dataRoot);
    if (current.kind === "operator") {
      // The operator is a system profile — never deletable (agents §4.3),
      // enforced server-side, not just by hiding the button.
      throw AppError.forbidden(
        "The Operator is a system profile and can't be deleted.",
      );
    }
    name = current.name;
    parsed.frontmatter.agents = parsed.frontmatter.agents.filter(
      (a) => a.profileId !== input.profileId,
    );
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.agent_profile.deleted",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "agent_profile",
    subjectId: input.profileId,
    projectSlug: input.projectSlug,
    details: { name },
  });
  return { profileId: input.profileId, name };
}
