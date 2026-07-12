import { data } from "react-router";
import type { ProjectRole } from "~/schemas/project-file.schema";
import { isAppError } from "~/server/errors/app-error.server";
import { requireProjectRole } from "~/server/tasks/task-actions.server";
import { requireAuth, type AuthContext } from "./require-user.server";

/**
 * Loader/action guard for project-scoped CONFIG surfaces (policy, agents,
 * settings, github) and instance-wide maintenance reached from a project.
 *
 * FR4 keeps the board, task detail, and timelines readable app-wide (anyone may
 * comment on any task), but the configuration surfaces — RBAC policy, agent
 * capability matrix, workflow settings, and GitHub connection health — are for
 * project members only. This wraps the canonical `requireProjectRole` guard and
 * converts its AppError into a proper thrown Response so a non-member sees a
 * clean 403 page instead of a generic crash.
 */
export async function requireProjectMember(
  request: Request,
  projectSlug: string,
  what: string,
  allowed: ProjectRole[] | "any-member" = "any-member",
): Promise<AuthContext> {
  const ctx = await requireAuth(request);
  try {
    requireProjectRole(
      projectSlug,
      {
        userId: ctx.user.id,
        label: ctx.user.email,
        orgRole: ctx.user.role,
      },
      allowed,
      what,
    );
  } catch (error) {
    if (isAppError(error)) {
      throw data(error.userMessage, { status: error.status });
    }
    throw error;
  }
  return ctx;
}
