import { data } from "react-router";
import { getDb } from "~/server/db/sqlite.server";
import { isAppError } from "~/server/errors/app-error.server";
import { assertProjectAction } from "./project-authority.server";
import { requireAuth, type AuthContext } from "./require-user.server";

/**
 * Loader/action guard for project-scoped CONFIG surfaces (policy, agents,
 * settings, github) and instance-wide maintenance reached from a project.
 *
 * FR4 keeps the board, task detail, and timelines readable app-wide (anyone may
 * comment on any task), but the configuration surfaces — RBAC policy, agent
 * capability matrix, workflow settings, and GitHub connection health — are for
 * project members only. This wraps the canonical `assertProjectAction` guard
 * ("any-member") and converts its AppError into a proper thrown Response so a
 * non-member sees a clean 403 page instead of a generic crash. ORG admins pass
 * as the audited D2 emergency override (project-authority.server), so they can
 * open any project's config surfaces — the shell shows the override pill.
 */
export async function requireProjectMember(
  request: Request,
  projectSlug: string,
  what: string,
): Promise<AuthContext> {
  const ctx = await requireAuth(request);
  try {
    // Route-level READ authorization ("view this surface"): archived projects
    // stay fully readable (R6-3 freezes mutations, not reads), so exempt this
    // membership check from the archived gate.
    assertProjectAction(
      getDb(),
      "any-member",
      projectSlug,
      { userId: ctx.user.id, label: ctx.user.email },
      what,
      { allowArchived: true },
    );
  } catch (error) {
    if (isAppError(error)) {
      throw data(error.userMessage, { status: error.status });
    }
    throw error;
  }
  return ctx;
}
