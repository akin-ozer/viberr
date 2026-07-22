import { existsSync, rmSync } from "node:fs";
import type Database from "better-sqlite3";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { createUser } from "~/server/auth/user-admin.server";
import { findUserByEmail } from "~/server/auth/user-store.server";
import { AppError } from "~/server/errors/app-error.server";
import { assertProjectAction } from "~/server/auth/project-authority.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import type { RbacAction } from "~/shared/rbac";
import {
  projectDir,
  projectFilePath,
} from "~/server/files/file-store-root.server";
import { updateProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll, rebuildPath } from "~/server/projections/rebuilder.server";
import { newId } from "~/shared/ids/new-id.server";

/**
 * Project-settings mutations (project-settings spec §5): identity, the
 * workflow-stages editor, membership CRUD, the repo-override policy flag,
 * and the danger-zone delete. Every mutation follows the canonical order
 * file write → incremental reproject → audit (SSE `project.updated` rides
 * the rebuild — open Boards re-render columns via the shell's project
 * scope).
 *
 * RBAC (contracts §3.2, enforced HERE): identity/stages/override/delete =
 * `edit-policy` ("Edit workflow & policy") → admin; membership CRUD =
 * `manage-members` ("Manage members & roles") → admin — each mutation names
 * its honest action id (pass-7 seam 4). (Grant-scope stays admin|maintainer
 * in the route, matching the GitHub view.) Guards the mock did client-side
 * (locked stages, non-empty stages, self-removal, last-admin) are re-checked
 * server-side with the spec-verbatim toast copy as the error message.
 */

export interface SettingsActor {
  userId: string;
  label: string;
}

export interface SettingsMutationContext {
  dataRoot?: string;
}

/**
 * The entry (first) and terminal (last) stages are structural and cannot be
 * removed — regardless of their ids (a Lightweight board is `todo … done`, a
 * custom board is anything). Returns a lock reason if `stageId` is one of them,
 * else null. Replaces the old literal-id `STAGE_LOCK` map keyed on
 * "triage"/"done", which silently failed to protect non-default boards.
 */
export function stageLockReason(
  stageId: string,
  stages: readonly { id: string }[],
): string | null {
  if (stages.length === 0) return null;
  if (stageId === stages[0]!.id) return "it's the entry point";
  if (stageId === stages[stages.length - 1]!.id)
    return "human acceptance stays terminal";
  return null;
}

export const NEW_STAGE_COLORS = [
  "var(--blue)",
  "var(--yellow-dark)",
  "var(--agent)",
  "var(--teal-dark)",
] as const;

function conflict(userMessage: string): AppError {
  return new AppError({
    code: ERROR_CODES.CONFLICT,
    status: 409,
    userMessage,
  });
}

function requireProjectAction(
  db: Database.Database,
  ctx: SettingsMutationContext,
  action: RbacAction,
  projectSlug: string,
  actor: SettingsActor,
  what: string,
  opts: { allowArchived?: boolean } = {},
): { projectName: string } {
  // Single canonical guard (project-authority.server): settings mutations name
  // their honest action id — `edit-policy` for identity/stages/repo/archive/
  // delete, `manage-members` for membership CRUD (both admin tier today).
  return assertProjectAction(db, action, projectSlug, actor, what, {
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    ...(opts.allowArchived ? { allowArchived: true } : {}),
  });
}

function projectRef(ctx: SettingsMutationContext, projectSlug: string) {
  return {
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  };
}

function reprojectProject(
  db: Database.Database,
  ctx: SettingsMutationContext,
  projectSlug: string,
): void {
  rebuildPath(db, projectFilePath(projectSlug, ctx.dataRoot), {
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
}

// ----------------------------------------------------------------- identity

export async function updateProjectIdentity(
  db: Database.Database,
  input: { projectSlug: string; name: string; prefix: string; description: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string; changed: boolean }> {
  requireProjectAction(db, ctx, "edit-policy", input.projectSlug, actor, "change project settings");

  const name = input.name.trim();
  const prefix = input.prefix.trim().toUpperCase().slice(0, 4);
  if (!name) throw AppError.validation("Project name is required.");
  if (!/^[A-Z]{1,4}$/.test(prefix)) {
    throw AppError.validation("Task prefix must be 1–4 letters.");
  }
  const description = input.description.trim();

  const changedFields: string[] = [];
  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    if (parsed.frontmatter.name !== name) {
      parsed.frontmatter.name = name;
      changedFields.push("name");
    }
    // Prefix changes affect FUTURE keys only — existing task keys/dirs are
    // immutable (spec §5.1).
    if (parsed.frontmatter.taskPrefix !== prefix) {
      parsed.frontmatter.taskPrefix = prefix;
      changedFields.push("prefix");
    }
    if (parsed.description !== description) {
      parsed.description = description;
      changedFields.push("description");
    }
  });

  if (changedFields.length === 0) {
    return { toast: "Project settings saved", changed: false };
  }
  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.settings.updated",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "project",
    subjectId: input.projectSlug,
    projectSlug: input.projectSlug,
    details: { fields: changedFields },
  });
  return { toast: "Project settings saved", changed: true };
}

// ------------------------------------------------------------------- stages

export async function renameStage(
  db: Database.Database,
  input: { projectSlug: string; stageId: string; name: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string; changed: boolean }> {
  requireProjectAction(db, ctx, "edit-policy", input.projectSlug, actor, "edit workflow stages");
  const name = input.name.trim();
  if (!name) throw AppError.validation("Stage name is required.");

  let changed = false;
  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    const stage = parsed.frontmatter.stages.find((s) => s.id === input.stageId);
    if (!stage) throw AppError.notFound(`No stage ${input.stageId}.`);
    if (stage.name === name) return;
    stage.name = name;
    changed = true;
  });

  const toast = `Stage renamed to "${name}" — board and policy follow`;
  if (!changed) return { toast, changed: false };
  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.stage.renamed",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "stage",
    subjectId: input.stageId,
    projectSlug: input.projectSlug,
    details: { name },
  });
  return { toast, changed: true };
}

export async function addStage(
  db: Database.Database,
  input: { projectSlug: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string; stageId: string }> {
  requireProjectAction(db, ctx, "edit-policy", input.projectSlug, actor, "edit workflow stages");

  // Server-generated id (spec §5.2 — never the mock's Date.now scheme).
  const stageId = newId("stage").toLowerCase().replace(/_/g, "-");
  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    const stages = parsed.frontmatter.stages;
    const stage = {
      id: stageId,
      name: "New stage",
      color: NEW_STAGE_COLORS[stages.length % NEW_STAGE_COLORS.length]!,
    };
    // Inserted immediately before the terminal (last) stage so Done stays last,
    // whatever its id.
    const insertIdx = stages.length > 0 ? stages.length - 1 : 0;
    stages.splice(insertIdx, 0, stage);
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.stage.added",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "stage",
    subjectId: stageId,
    projectSlug: input.projectSlug,
    details: {},
  });
  return { toast: "Stage added — it appears on the board immediately", stageId };
}

export async function removeStage(
  db: Database.Database,
  input: { projectSlug: string; stageId: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string }> {
  requireProjectAction(db, ctx, "edit-policy", input.projectSlug, actor, "edit workflow stages");

  // Non-empty guard re-checked at ACTION time from projections (spec §5.2 —
  // client counts can be stale).
  const count = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM task_projections
          WHERE project_slug = ? AND stage = ?`,
      )
      .get(input.projectSlug, input.stageId) as { n: number }
  ).n;

  let stageName = input.stageId;
  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    const stage = parsed.frontmatter.stages.find((s) => s.id === input.stageId);
    if (!stage) throw AppError.notFound(`No stage ${input.stageId}.`);
    stageName = stage.name;
    const locked = stageLockReason(input.stageId, parsed.frontmatter.stages);
    if (locked) {
      throw conflict(`${stage.name} can't be removed — ${locked}`);
    }
    if (count > 0) {
      throw conflict(
        `Move ${count} ${count === 1 ? "task" : "tasks"} out of ${stage.name} first`,
      );
    }
    parsed.frontmatter.stages = parsed.frontmatter.stages.filter(
      (s) => s.id !== input.stageId,
    );
    // Transition rules referencing a removed stage are dropped with it
    // (spec §7.4 decision — documented in the phase report).
    parsed.frontmatter.workflow = parsed.frontmatter.workflow.filter(
      (w) => w.from !== input.stageId && w.to !== input.stageId,
    );
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.stage.removed",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "stage",
    subjectId: input.stageId,
    projectSlug: input.projectSlug,
    details: { name: stageName },
  });
  return { toast: `Stage "${stageName}" removed` };
}

export async function reorderStages(
  db: Database.Database,
  input: { projectSlug: string; orderedIds: string[] },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string }> {
  requireProjectAction(db, ctx, "edit-policy", input.projectSlug, actor, "edit workflow stages");

  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    const stages = parsed.frontmatter.stages;
    const byId = new Map(stages.map((s) => [s.id, s]));
    if (
      input.orderedIds.length !== stages.length ||
      input.orderedIds.some((id) => !byId.has(id))
    ) {
      throw AppError.validation("Stage order is out of date — try again.");
    }
    const next = input.orderedIds.map((id) => byId.get(id)!);
    // Server re-applies the normalization — never trust client order
    // (spec §5.2): the entry stage stays first and the terminal stage stays
    // last, pinned by their CURRENT identity (not the literal ids
    // "triage"/"done") so custom/lightweight boards are protected too.
    const entryId = stages[0]!.id;
    const terminalId = stages[stages.length - 1]!.id;
    const middle = next.filter(
      (s) => s.id !== entryId && s.id !== terminalId,
    );
    parsed.frontmatter.stages = [
      byId.get(entryId)!,
      ...middle,
      byId.get(terminalId)!,
    ];
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.stage.reordered",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "project",
    subjectId: input.projectSlug,
    projectSlug: input.projectSlug,
    details: { order: input.orderedIds },
  });
  return { toast: "Stage order updated — board columns follow" };
}

// ------------------------------------------------------------------ members

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Invite (spec §5.3): registered email → membership entry (role viewer,
 * status invited). Unregistered email → a passwordless whitelist user row
 * is created first (phase-2 model: the user row IS the whitelist entry;
 * they sign in via OAuth — no mailer in V1, ruling 13), then the entry.
 */
export async function inviteMember(
  db: Database.Database,
  input: { projectSlug: string; name: string; email: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string; userId: string }> {
  // Honest action id (pass-7 seam 4): inviting IS member management, not a
  // policy edit — `manage-members`, same admin tier as before.
  requireProjectAction(db, ctx, "manage-members", input.projectSlug, actor, "manage members & roles");

  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name || !EMAIL_RE.test(email)) {
    throw AppError.validation("Enter a name and a valid email");
  }

  const auditActor = { userId: actor.userId, label: actor.label };
  let user = findUserByEmail(db, email);
  if (!user) {
    user = await createUser(
      db,
      { email, name, role: "member", tempPassword: null },
      auditActor,
    );
  }
  const userId = user.id;

  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    if (parsed.frontmatter.members.some((m) => m.userId === userId)) {
      throw conflict(`${email} is already a member`);
    }
    // An invite IS the membership (X15): viberr uses a whitelist auth model with
    // no separate accept-invite step, so the member gets access immediately and
    // we no longer stamp a decorative `status: invited` that never gated
    // anything. The member joins as a viewer, editable in Policy afterwards.
    parsed.frontmatter.members.push({ userId, role: "viewer" as const });
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.member.invited",
    actor: auditActor,
    subjectKind: "user",
    subjectId: userId,
    projectSlug: input.projectSlug,
    details: { email, role: "viewer" },
  });
  return { toast: `Invite sent to ${email} · joins as Viewer`, userId };
}

export async function removeMember(
  db: Database.Database,
  input: { projectSlug: string; targetUserId: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string }> {
  // Honest action id (pass-7 seam 4): removal IS member management —
  // `manage-members`, same admin tier as before.
  const { projectName } = requireProjectAction(
    db,
    ctx,
    "manage-members",
    input.projectSlug,
    actor,
    "manage members & roles",
  );

  if (input.targetUserId === actor.userId) {
    throw conflict(`You can't remove yourself from ${projectName}`);
  }

  const userRow = db
    .prepare(`SELECT name, email FROM users WHERE id = ?`)
    .get(input.targetUserId) as { name: string; email: string } | undefined;
  const displayName = userRow?.name ?? input.targetUserId;

  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    const member = parsed.frontmatter.members.find(
      (m) => m.userId === input.targetUserId,
    );
    if (!member) {
      throw AppError.notFound("That user is not a member of this project.");
    }
    if (member.role === "admin") {
      const admins = parsed.frontmatter.members.filter(
        (m) => m.role === "admin",
      ).length;
      if (admins <= 1) {
        throw conflict(
          `${displayName} is the only admin — assign another admin in Policy first`,
        );
      }
    }
    parsed.frontmatter.members = parsed.frontmatter.members.filter(
      (m) => m.userId !== input.targetUserId,
    );
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.member.removed",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "user",
    subjectId: input.targetUserId,
    projectSlug: input.projectSlug,
    details: {},
  });
  return {
    toast: `${displayName} removed from ${projectName}`,
  };
}

// ----------------------------------------------------------------- override

export async function setRepoOverride(
  db: Database.Database,
  input: { projectSlug: string; enabled: boolean },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string }> {
  requireProjectAction(db, ctx, "edit-policy", input.projectSlug, actor, "change project settings");

  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    parsed.unknownFrontmatter.taskRepoOverride = input.enabled;
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: "project.repo_override.changed",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "project",
    subjectId: input.projectSlug,
    projectSlug: input.projectSlug,
    details: { enabled: input.enabled },
  });
  return {
    toast: input.enabled
      ? "Task-level repo override enabled"
      : "Task-level repo override disabled",
  };
}

// -------------------------------------------------------------- danger zone

/**
 * Archive / restore a project (admin-only). Archiving flips the `archived`
 * frontmatter flag; the project is then hidden from the active workspace and
 * moved to the home "Archived" section, restorable anytime. Canonical truth is
 * the file, so the change persists via reproject like every other setting.
 */
export async function setProjectArchived(
  db: Database.Database,
  input: { projectSlug: string; archived: boolean },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string; archived: boolean }> {
  const { projectName } = requireProjectAction(
    db,
    ctx,
    "edit-policy",
    input.projectSlug,
    actor,
    input.archived ? "archive this project" : "restore this project",
    // Restore must run ON an archived project — exempt it from the read-only gate.
    { allowArchived: !input.archived },
  );

  await updateProjectFile(projectRef(ctx, input.projectSlug), (parsed) => {
    parsed.frontmatter.archived = input.archived;
  });

  reprojectProject(db, ctx, input.projectSlug);
  recordAudit(db, {
    action: input.archived ? "project.archived" : "project.unarchived",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "project",
    subjectId: input.projectSlug,
    projectSlug: input.projectSlug,
    details: { name: projectName },
  });
  return {
    toast: input.archived
      ? `Project "${projectName}" archived — find it under Archived on Home`
      : `Project "${projectName}" restored`,
    archived: input.archived,
  };
}

/**
 * Delete project (spec §5.6): destructive, typed-name confirmation
 * required, admin-only. Removes the project directory (project.md + every
 * task file), then a full rescan prunes all derived rows. Audit logs keep
 * the trail (audit_events are app-owned, not store-derived).
 */
export async function deleteProject(
  db: Database.Database,
  input: { projectSlug: string; confirmName: string },
  actor: SettingsActor,
  ctx: SettingsMutationContext = {},
): Promise<{ toast: string }> {
  const { projectName } = requireProjectAction(
    db,
    ctx,
    "edit-policy",
    input.projectSlug,
    actor,
    "delete this project",
    // Deleting an archived project is a valid terminal action — don't block it.
    { allowArchived: true },
  );
  if (input.confirmName.trim() !== projectName) {
    throw AppError.validation("Type the project name to confirm deletion.");
  }

  const dir = projectDir(input.projectSlug, ctx.dataRoot);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  rebuildAll(db, {
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  // Notifications are app-owned (no FK cascade to projects), so a deleted
  // project used to leave orphaned "waiting on you" rows that dead-ended on a
  // 404 when opened (F2). Clean them up with the project.
  db.prepare(`DELETE FROM notifications WHERE project_slug = ?`).run(
    input.projectSlug,
  );

  recordAudit(db, {
    action: "project.deleted",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "project",
    subjectId: input.projectSlug,
    projectSlug: input.projectSlug,
    details: { name: projectName },
  });
  return { toast: `Project "${projectName}" deleted` };
}
