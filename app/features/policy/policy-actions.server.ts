import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ProjectRole } from "~/schemas/project-file.schema";
import { PROJECT_ROLES, BOUNDARY_VALUES } from "~/schemas/project-file.schema";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { assertProjectAction } from "~/server/auth/project-authority.server";
import { projectFilePath } from "~/server/files/file-store-root.server";
import { updateProjectFile } from "~/server/files/project-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import {
  countLiveAdmins,
  removedAccountLabel,
} from "~/features/project-settings/membership.server";
import { defaultTransitionBy } from "~/shared/workflow/transitions";
import { ROLE_LABEL, BOUNDARIES } from "./policy-data";

/**
 * Policy mutations (policy spec §5): member role assignment + workflow
 * boundary changes, both writing project.md through the phase-3 writers,
 * then reproject → audit (SSE `project.updated` rides the rebuild).
 *
 * Policy flips the boundary ON an existing rule; it does not author the rule
 * set. The transition chain itself is maintained by the stage editor
 * (settings-actions.server.ts → app/shared/workflow/transitions.ts), which
 * splices a new stage in and re-joins a removed stage's neighbours — P13-D-1,
 * owner ruling 2026-07-25 (auto-wire, no transitions editor). That is why
 * `setTransitionBoundary` below can still legitimately report
 * "No transition rule from X to Y." — it means the caller named a hop the chain
 * does not have, not that the admin must create one here.
 *
 * Server-side guards (mirrored client-side as UX sugar only):
 *   - actor must hold "Manage members & roles" / "Edit workflow & policy"
 *     → project admin (contracts §3.2)
 *   - last-admin guard: never demote the only admin
 *   - review→done (any `locked` boundary, and any boundary INTO the final
 *     stage) is hard-locked `human` — V1 invariant.
 *
 * Toast copy is computed HERE (phase-5 pattern) so every caller shows the
 * spec-verbatim strings.
 */

export interface PolicyActor {
  userId: string;
  label: string;
}

export interface PolicyMutationContext {
  dataRoot?: string;
}

function requirePolicyAction(
  db: DatabaseSync,
  ctx: PolicyMutationContext,
  action: "manage-members" | "edit-policy",
  projectSlug: string,
  actor: PolicyActor,
  what: string,
): { projectName: string } {
  // Delegates to the single canonical guard, consulting the SPECIFIC action id
  // so editing the matrix row for one (e.g. manage-members) would change its
  // enforcement independently of the other (pass-4 XS-9). Both are admin-only
  // today, but this closes the single-source bypass.
  return assertProjectAction(db, action, projectSlug, actor, what, {
    dataRoot: ctx.dataRoot,
  });
}

function reprojectProject(
  db: DatabaseSync,
  ctx: PolicyMutationContext,
  projectSlug: string,
): void {
  rebuildPath(db, projectFilePath(projectSlug, ctx.dataRoot), {
    dataRoot: ctx.dataRoot,
  });
}

/** The one column `userName` selects. A deleted account leaves no row at all,
 *  which is the same answer to the caller as a row it cannot read. */
const userNameRow = z.object({ name: z.string() });

function userName(db: DatabaseSync, userId: string): string {
  const row = userNameRow.safeParse(
    db.prepare(`SELECT name FROM users WHERE id = ?`).get(userId),
  );
  // LV-04: never echo the raw `u_…` id as if it were a display name.
  return row.success ? row.data.name : removedAccountLabel(userId);
}

// ---------------------------------------------------------------- set role

/**
 * updateMemberRole (policy spec §5.1). Live-role reads: permission checks
 * always parse project.md, so the change is "enforced on the next action"
 * with no session-cached role anywhere.
 */
export async function setMemberRole(
  db: DatabaseSync,
  input: { projectSlug: string; targetUserId: string; role: string },
  actor: PolicyActor,
  ctx: PolicyMutationContext = {},
): Promise<{ toast: string; changed: boolean }> {
  const { projectName } = requirePolicyAction(
    db,
    ctx,
    "manage-members",
    input.projectSlug,
    actor,
    "manage members & roles",
  );
  const parsedRole = z.enum(PROJECT_ROLES).safeParse(input.role);
  if (!parsedRole.success) {
    throw AppError.validation("Unknown project role.");
  }
  const role = parsedRole.data;

  const ref = {
    projectSlug: input.projectSlug,
    dataRoot: ctx.dataRoot,
  };

  let previousRole: ProjectRole | null = null;
  let changed = false;
  await updateProjectFile(ref, (parsed) => {
    const member = parsed.frontmatter.members.find(
      (m) => m.userId === input.targetUserId,
    );
    if (!member) {
      throw AppError.notFound("That user is not a member of this project.");
    }
    previousRole = member.role;
    if (member.role === role) return; // no-op, no event
    if (member.role === "admin" && role !== "admin") {
      // UI-29: count admins with a LIVE, enabled account. Counting project.md
      // entries let one ghost admin (an org-deleted user project.md still
      // listed) satisfy the guard, so the only real admin could demote
      // themselves into a project nobody could govern.
      const admins = countLiveAdmins(db, parsed.frontmatter.members);
      if (admins <= 1) {
        // Last-admin guard — exact mock copy, project name parameterized.
        throw AppError.conflict(
          `${projectName} needs at least one admin — promote someone else first`,
        );
      }
    }
    member.role = role;
    changed = true;
  });

  const targetName = userName(db, input.targetUserId);
  if (!changed) {
    return {
      toast: `${targetName.split(" ")[0]} is now ${ROLE_LABEL[role]} · enforced on the next action`,
      changed: false,
    };
  }

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.member.role_changed",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "user",
    subjectId: input.targetUserId,
    projectSlug: input.projectSlug,
    details: { from: previousRole, to: role, targetUserId: input.targetUserId },
  });

  return {
    toast: `${targetName.split(" ")[0]} is now ${ROLE_LABEL[role]} · enforced on the next action`,
    changed: true,
  };
}

// ------------------------------------------------------------ set boundary

const LOCKED_BOUNDARY_MESSAGE =
  "Completion is human-authorized in V1 — this boundary can't be delegated";

/**
 * updateTransitionBoundary (policy spec §5.2): validates the rule exists,
 * hard-rejects locked rows (review→done) AND any non-human boundary into
 * the project's final stage, persists to project.md, reprojects, audits.
 * "Applies to future transitions" — in-flight requests are untouched.
 */
export async function setTransitionBoundary(
  db: DatabaseSync,
  input: { projectSlug: string; from: string; to: string; boundary: string },
  actor: PolicyActor,
  ctx: PolicyMutationContext = {},
): Promise<{ toast: string; changed: boolean }> {
  requirePolicyAction(db, ctx, "edit-policy", input.projectSlug, actor, "edit workflow & policy");
  const parsedBoundary = z.enum(BOUNDARY_VALUES).safeParse(input.boundary);
  if (!parsedBoundary.success) {
    throw AppError.validation("Unknown boundary.");
  }
  const boundary = parsedBoundary.data;

  const ref = {
    projectSlug: input.projectSlug,
    dataRoot: ctx.dataRoot,
  };

  let changed = false;
  let fromName = input.from;
  let toName = input.to;
  await updateProjectFile(ref, (parsed) => {
    const rule = parsed.frontmatter.workflow.find(
      (w) => w.from === input.from && w.to === input.to,
    );
    if (!rule) {
      throw AppError.validation(
        `No transition rule from ${input.from} to ${input.to}.`,
      );
    }
    const stages = parsed.frontmatter.stages;
    const lastStageId = stages[stages.length - 1]?.id;
    if (rule.locked || (input.to === lastStageId && boundary !== "human")) {
      throw AppError.forbidden(LOCKED_BOUNDARY_MESSAGE);
    }
    fromName = stages.find((s) => s.id === input.from)?.name ?? input.from;
    toName = stages.find((s) => s.id === input.to)?.name ?? input.to;
    if (rule.boundary === boundary) return; // no-op
    rule.boundary = boundary;
    // F20-26: the human-readable `by` prose describes the boundary. Mutating
    // only `boundary` left the row self-contradicting (e.g. "Human decision"
    // beside an Auto-advance selection). Recompute it from the same source the
    // chain editor uses (transitions.ts) so file = projection = rendered row.
    rule.by = defaultTransitionBy(boundary);
    changed = true;
  });

  const label =
    BOUNDARIES.find((b) => b.id === boundary)?.label.toLowerCase() ?? boundary;
  const toast = `${fromName} → ${toName}: ${label} · applies to future transitions`;
  if (!changed) return { toast, changed: false };

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.policy.boundary_changed",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "workflow_boundary",
    // The stage-id pair stays the stable subject key; the human-readable detail
    // carries NAMES (N20-9) — the renderer prints `d.from`/`d.to` verbatim, so
    // storing ids made the audit row read "ready → impl" while the toast and the
    // rest of the app say "Ready → In Progress".
    subjectId: `${input.from}>${input.to}`,
    projectSlug: input.projectSlug,
    details: { from: fromName, to: toName, boundary },
  });
  return { toast, changed: true };
}
