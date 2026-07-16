import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { readProjectFile } from "~/server/files/project-writer.server";
import type { ProjectRole } from "~/schemas/project-file.schema";
import { type RbacAction, ROLE_LABEL, rolesForAction } from "~/shared/rbac";

/**
 * The ONE server-side project-role guard for the config-surface action modules
 * (policy / project-settings / agent-profile). It reads the canonical project.md
 * fresh and checks the actor's role against the single-source `ACTION_ROLES` map
 * (app/shared/rbac.ts) — the same object the Policy page renders. This replaces
 * the three copy-pasted `requireProjectAdmin` helpers that each hard-coded
 * `role !== "admin"`; the required role now lives in exactly one place.
 */
export function assertProjectAction(
  action: RbacAction,
  projectSlug: string,
  actorUserId: string,
  what: string,
  opts: { dataRoot?: string; allowArchived?: boolean } = {},
): { projectName: string; role: ProjectRole } {
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
  // until restored. Restore itself passes allowArchived.
  if (file.parsed.frontmatter.archived === true && !opts.allowArchived) {
    throw new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      userMessage: `This project is archived (read-only) — restore it before you ${what}.`,
      kind: "user",
    });
  }
  const role = file.parsed.frontmatter.members.find(
    (m) => m.userId === actorUserId,
  )?.role;
  const allowed = rolesForAction(action);
  if (!role || !allowed.includes(role)) {
    const label =
      allowed.length === 1
        ? `${ROLE_LABEL[allowed[0]].toLowerCase()}s`
        : "members with the right role";
    throw new AppError({
      code: ERROR_CODES.FORBIDDEN,
      status: 403,
      userMessage: `Only project ${label} can ${what}.`,
      kind: "user",
    });
  }
  return { projectName: file.parsed.frontmatter.name, role };
}
