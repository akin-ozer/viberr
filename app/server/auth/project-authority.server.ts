import type Database from "better-sqlite3";
import type { ProjectRole } from "~/schemas/project-file.schema";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { readProjectFile } from "~/server/files/project-writer.server";
import { type RbacAction, ROLE_LABEL, rolesForAction } from "~/shared/rbac";
import { resolveOrgRole } from "./identity.server";

/**
 * THE single project-authority resolution path (pass-7 R7-1 consolidation).
 *
 * Every server guard — task mutations (`requireAction`), config surfaces
 * (`assertProjectAction`), runtime triggers, and the route membership gate —
 * resolves "what may this actor do on this project" through
 * `resolveProjectAuthority` below. It owns two rules:
 *
 * 1. MEMBERSHIP ROLE: the actor's live role from project.md members[] is
 *    checked against the single-source `ACTION_ROLES` map (app/shared/rbac.ts —
 *    the same object the Policy page renders).
 *
 * 2. ORG-ADMIN EMERGENCY OVERRIDE (owner ruling D2, implemented per R7-1): an
 *    ORG admin whose membership role would be denied (non-member, or a member
 *    below the required tier) is granted project-admin-equivalent authority —
 *    and EVERY such grant writes a `project.org_admin.override` audit row
 *    naming the action and project, so the override is visible, never silent.
 *    An org admin whose own membership suffices is NOT an override (no row).
 *
 * The archived read-only gate (R6-3) also lives here (`requireProjectMutable`)
 * so there is exactly one implementation and one message string.
 */

export interface AuthorityActor {
  userId: string;
  /** Human-readable audit label, e.g. the email. */
  label: string;
}

/** The minimal project shape authority resolution needs. Callers with a loaded
 *  project context pass it directly; slug-only callers use
 *  `assertProjectAction`, which reads project.md fresh. */
export interface AuthorityProject {
  slug: string;
  memberRoles: Map<string, ProjectRole>;
}

export interface ProjectAuthority {
  /** The EFFECTIVE role the grant was made under ("admin" for an override). */
  role: ProjectRole;
  /** True when the grant came from the D2 org-admin emergency override. */
  isOrgAdminOverride: boolean;
}

export type AuthorityDecision =
  | ({ allowed: true } & ProjectAuthority)
  | { allowed: false; memberRole: ProjectRole | null };

function forbidden(userMessage: string): AppError {
  return new AppError({
    code: ERROR_CODES.FORBIDDEN,
    status: 403,
    userMessage,
    kind: "user",
  });
}

/**
 * Archived projects are read-only (owner ruling R6-3): a project moved to the
 * Home "Archived" section refuses every governed mutation (tasks, comments,
 * agent runs, policy, settings) until an admin restores it — timelines and
 * audit stay readable. Throws a 409 with actionable copy. The ONE exemption is
 * the restore action itself (setProjectArchived passes `allowArchived`), so an
 * archived project can be brought back. Reads never call this. This is the
 * SINGLE implementation — `requireAction` (task-actions), `assertProjectAction`
 * (config surfaces) and the explicit comment-path call all share it.
 */
export function requireProjectMutable(
  project: { archived: boolean },
  what: string,
): void {
  if (project.archived) {
    throw new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      userMessage: `This project is archived (read-only) — restore it before you ${what}.`,
      kind: "user",
    });
  }
}

/** Whether this user holds the ORG admin role (better-auth membership is
 *  authoritative; `users.role` is the derived-cache fallback — identity.server).
 *  Disabled users never qualify. */
export function isOrgAdmin(db: Database.Database, userId: string): boolean {
  const row = db
    .prepare(`SELECT role FROM users WHERE id = ? AND disabled = 0`)
    .get(userId) as { role: string } | undefined;
  if (!row) return false;
  const fallback = row.role === "admin" ? "admin" : "member";
  return resolveOrgRole(db, userId, fallback) === "admin";
}

/**
 * THE membership + role resolution every guard consults (non-throwing).
 *
 * - A member whose role satisfies `allowed` (or any member for "any-member")
 *   is granted under their OWN role — never marked as an override.
 * - Otherwise an ORG admin is granted project-admin authority as the D2
 *   emergency override, and the grant is audited (`project.org_admin.override`
 *   with details {action, what, projectSlug}) — EVERY use leaves a row.
 * - Everyone else is denied; the caller formats its own 403 copy from
 *   `memberRole` (null = not a member).
 */
export function resolveProjectAuthority(
  db: Database.Database,
  project: AuthorityProject,
  actor: AuthorityActor,
  allowed: readonly ProjectRole[] | "any-member",
  audit: { action: RbacAction | "any-member"; what: string },
): AuthorityDecision {
  const memberRole = project.memberRoles.get(actor.userId) ?? null;
  if (
    memberRole &&
    (allowed === "any-member" || allowed.includes(memberRole))
  ) {
    return { allowed: true, role: memberRole, isOrgAdminOverride: false };
  }
  if (isOrgAdmin(db, actor.userId)) {
    recordAudit(db, {
      action: "project.org_admin.override",
      actor: { userId: actor.userId, label: actor.label },
      subjectKind: "project",
      subjectId: project.slug,
      projectSlug: project.slug,
      details: {
        action: audit.action,
        what: audit.what,
        projectSlug: project.slug,
        memberRole,
      },
    });
    return { allowed: true, role: "admin", isOrgAdminOverride: true };
  }
  return { allowed: false, memberRole };
}

/**
 * Throwing wrapper over {@link resolveProjectAuthority} with the canonical
 * task-guard 403 copy ("Only project members can …" / "Your project role (x)
 * cannot …"). Used by the task-actions guards and every inline runtime check.
 */
export function requireProjectAuthority(
  db: Database.Database,
  project: AuthorityProject,
  actor: AuthorityActor,
  allowed: readonly ProjectRole[] | "any-member",
  audit: { action: RbacAction | "any-member"; what: string },
): ProjectAuthority {
  const decision = resolveProjectAuthority(db, project, actor, allowed, audit);
  if (decision.allowed) {
    return { role: decision.role, isOrgAdminOverride: decision.isOrgAdminOverride };
  }
  if (!decision.memberRole) {
    throw forbidden(`Only project members can ${audit.what}.`);
  }
  throw forbidden(`Your project role (${decision.memberRole}) cannot ${audit.what}.`);
}

/**
 * The server-side guard for callers that have only a project SLUG (config
 * surfaces, route gates): reads the canonical project.md fresh, applies the
 * archived read-only gate (unless `allowArchived`), and resolves authority
 * against `ACTION_ROLES` — org-admin override included. `"any-member"` is the
 * route membership gate (view surfaces, kept for FR4 read-scoping).
 * 403 copy keeps the config-surface shape ("Only project admins can …").
 */
export function assertProjectAction(
  db: Database.Database,
  action: RbacAction | "any-member",
  projectSlug: string,
  actor: AuthorityActor,
  what: string,
  opts: { dataRoot?: string; allowArchived?: boolean } = {},
): { projectName: string; role: ProjectRole; isOrgAdminOverride: boolean } {
  const file = readProjectFile({
    projectSlug,
    ...(opts.dataRoot !== undefined ? { dataRoot: opts.dataRoot } : {}),
  });
  if (!file) {
    throw new AppError({
      code: ERROR_CODES.NOT_FOUND,
      status: 404,
      userMessage: `Project ${projectSlug} not found.`,
      kind: "user",
    });
  }
  // Archived projects are read-only (R6-3): refuse config-surface mutations
  // until restored. Restore/delete and route READ gates pass allowArchived.
  if (!opts.allowArchived) {
    requireProjectMutable(
      { archived: file.parsed.frontmatter.archived === true },
      what,
    );
  }
  const project: AuthorityProject = {
    slug: projectSlug,
    memberRoles: new Map(
      file.parsed.frontmatter.members.map((m) => [m.userId, m.role]),
    ),
  };
  const allowed = action === "any-member" ? "any-member" : rolesForAction(action);
  const decision = resolveProjectAuthority(db, project, actor, allowed, {
    action,
    what,
  });
  if (decision.allowed) {
    return {
      projectName: file.parsed.frontmatter.name,
      role: decision.role,
      isOrgAdminOverride: decision.isOrgAdminOverride,
    };
  }
  const label =
    allowed === "any-member"
      ? "members"
      : allowed.length === 1
        ? `${ROLE_LABEL[allowed[0]!].toLowerCase()}s`
        : "members with the right role";
  throw forbidden(`Only project ${label} can ${what}.`);
}
