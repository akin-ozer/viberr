import type { DatabaseSync } from "node:sqlite";
import { data } from "react-router";
import { requireFormAction } from "~/server/auth/form-action.server";
import {
  assertProjectAction,
  type AuthorityActor,
} from "~/server/auth/project-authority.server";
import { isAppError } from "~/server/errors/app-error.server";

/**
 * R15-4 on the ACTION side of every project-scoped route.
 *
 * The layout loader (routes/project) is the chokepoint for READS, but React
 * Router runs a child route's ACTION without its parent's loader — so a POST to
 * `/projects/<slug>/tasks/<key>` reached the mutation for any authenticated
 * user. A non-member could write a comment into (and @mention an agent inside)
 * a project whose existence WI-13 says must stay secret; the inner RBAC guards
 * refused the governed mutations but commenting is deliberately role-free.
 *
 * This is that loader's gate, in the shape an action needs: it resolves through
 * the SAME canonical path (`assertProjectAction` "any-member", so org admins
 * pass as the audited D2 override and every refusal writes the P13-D-8 denial
 * row) and then throws the loader's byte-identical 404 — never the guard's own
 * 403 copy, which would confirm the project exists.
 *
 * Archived projects stay reachable here (`allowArchived`): the read-only gate
 * (R6-3) belongs to each mutation and keeps its own 409 copy.
 */
export function requireVisibleProject(
  db: DatabaseSync,
  projectSlug: string,
  actor: AuthorityActor,
  what: string,
): void {
  try {
    assertProjectAction(db, "any-member", projectSlug, actor, what, {
      allowArchived: true,
    });
  } catch (error) {
    if (isAppError(error)) {
      throw data(`No project at projects/${projectSlug}.`, { status: 404 });
    }
    throw error;
  }
}

/**
 * A project route's action preamble: `requireFormAction`, then the gate above.
 * React Router runs a child action WITHOUT the layout's loader, so every
 * project action repeats the members-only refusal first, outside its own
 * `try`, so a non-member gets the thrown unknown-slug 404 rather than an inner
 * guard's 403 (WI-13). A refused CSRF check skips the gate: the caller returns
 * `refused` before it touches the project.
 */
export async function requireProjectFormAction(
  request: Request,
  projectSlug: string,
  what = "act on this project",
) {
  const action = await requireFormAction(request);
  if (!action.refused) requireVisibleProject(action.db, projectSlug, action.actor, what);
  return action;
}
