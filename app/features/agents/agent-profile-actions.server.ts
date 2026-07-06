import type Database from "better-sqlite3";
import { z } from "zod";
import type { AgentDeployment, CapabilityMode } from "~/schemas/project-file.schema";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { agentProfileFilePath, projectFilePath } from "~/server/files/file-store-root.server";
import {
  readProjectFile,
  updateProjectFile,
} from "~/server/files/project-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import {
  defaultEffortFor,
  defaultModelFor,
} from "~/server/runtimes/model-catalog.server";
import { existsSync } from "node:fs";
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

export const profileFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required."),
  role: z.string().trim().min(1, "Role is required."),
  backend: z.enum(["codex", "claude"]),
  stages: z.array(z.string().min(1)).min(1, "At least one stage is required."),
  definition: z.string().default(""),
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

function forbidden(userMessage: string): AppError {
  return new AppError({
    code: ERROR_CODES.FORBIDDEN,
    status: 403,
    userMessage,
    kind: "user",
  });
}

function requireProjectAdmin(
  ctx: ProfileMutationContext,
  projectSlug: string,
  actor: ProfileActor,
): { projectName: string } {
  const file = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (!file) throw AppError.notFound(`Project ${projectSlug} not found.`);
  const role = file.parsed.frontmatter.members.find(
    (m) => m.userId === actor.userId,
  )?.role;
  if (role !== "admin") {
    throw forbidden("Only project admins can change agent capability policy.");
  }
  return { projectName: file.parsed.frontmatter.name };
}

function reprojectProject(
  db: Database.Database,
  ctx: ProfileMutationContext,
  projectSlug: string,
): void {
  rebuildPath(db, projectFilePath(projectSlug, ctx.dataRoot), {
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
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

/** Caps record → id-based grants (off = not granted) against a defaults map
 * (the specialist modal catalog OR the operator catalog). */
function grantsFor(
  caps: Record<string, CapMode>,
  defaults: Readonly<Record<string, CapMode>>,
): { capabilityId: string; mode: CapabilityMode }[] {
  const grants: { capabilityId: string; mode: CapabilityMode }[] = [];
  for (const [capabilityId, def] of Object.entries(defaults)) {
    const mode = caps[capabilityId] ?? def;
    if (mode === "off") continue;
    grants.push({ capabilityId, mode: mode as CapabilityMode });
  }
  return grants;
}

/** Specialist modal caps → grants. */
function modalGrants(
  caps: Record<string, CapMode>,
): { capabilityId: string; mode: CapabilityMode }[] {
  return grantsFor(caps, CAP_MODAL_DEFAULTS);
}

function slugifyProfileId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// ------------------------------------------------------------------ create

export async function createAgentProfile(
  db: Database.Database,
  input: { projectSlug: string; form: unknown },
  actor: ProfileActor,
  ctx: ProfileMutationContext = {},
): Promise<{ profileId: string; name: string }> {
  const { projectName } = requireProjectAdmin(ctx, input.projectSlug, actor);
  const form = parseForm(input.form);

  const ref = {
    projectSlug: input.projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  };

  let profileId = "";
  await updateProjectFile(ref, (parsed) => {
    const taken = new Set(parsed.frontmatter.agents.map((a) => a.profileId));
    // Server-generated slug id with a uniqueness check (agents spec §4.5) —
    // also avoid shadowing an undeployed org template file.
    const base = slugifyProfileId(form.name) || "specialist";
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
      stages: form.stages,
      resources: form.resources,
    };
    const deployment: AgentDeployment = {
      profileId,
      capabilities: modalGrants(form.caps),
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

// ------------------------------------------------------------------ update

export async function updateAgentProfile(
  db: Database.Database,
  input: { projectSlug: string; profileId: string; form: unknown },
  actor: ProfileActor,
  ctx: ProfileMutationContext = {},
): Promise<{ profileId: string; name: string }> {
  requireProjectAdmin(ctx, input.projectSlug, actor);
  const form = parseForm(input.form);

  const ref = {
    projectSlug: input.projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
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
    deployment.capabilities = [...grantsFor(form.caps, governedDefaults), ...preserved];

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
      desc:
        form.definition.trim() ||
        (isOperator ? current.desc : `${form.name} — a ${form.role.toLowerCase()} specialist.`),
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
  db: Database.Database,
  input: { projectSlug: string; profileId: string },
  actor: ProfileActor,
  ctx: ProfileMutationContext = {},
): Promise<{ profileId: string; name: string }> {
  requireProjectAdmin(ctx, input.projectSlug, actor);

  const ref = {
    projectSlug: input.projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
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
      throw forbidden("The Operator is a system profile and can't be deleted.");
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
