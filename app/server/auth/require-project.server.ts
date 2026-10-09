import { data } from "react-router";
import { getDb } from "~/server/db/sqlite.server";
import { isAppError } from "~/server/errors/app-error.server";
import { assertProjectAction } from "./project-authority.server";
import { requireAuth, type AuthContext } from "./require-user.server";

/**
 * Loader guard for project-scoped surfaces reached OUTSIDE the layout's read
 * chokepoint: the six config views (activity, review, policy, agents, settings,
 * github) and the two run-artifact resource routes.
 *
 * R15-4 (ruling 27) makes projects MEMBERS-ONLY, so this guard has exactly ONE
 * refusal: the 404 an unknown slug produces. A signed-in non-member and a slug
 * that does not exist must be indistinguishable — same status, same bytes.
 *
 * F19-28: this used to throw `assertProjectAction`'s own 403 ("Only project
 * members can view this project's policy."), which was a project-existence
 * ORACLE. The layout loader (routes/project) is the chokepoint for READS, but
 * single-fetch honors a client-supplied `?_routes=` filter, so
 * `GET /projects/<slug>/policy.data?_routes=routes/project.policy` runs the
 * child loader ALONE and the layout's 404 never executes — the exact hole
 * project.task.tsx documents ("the gate has to live on every loader that serves
 * project content"). Its six config siblings were missed. The old docblock
 * justified the 403 with the PRE-R15-4 reading of FR4 ("the board and task
 * detail stay readable app-wide, only the configuration surfaces are member
 * scoped"); that reading is dead — nothing about a project is readable to a
 * non-member, and the board/task loaders now gate too.
 *
 * ORG admins still pass as the audited D2 emergency override
 * (project-authority.server), so they can open any project's config surfaces —
 * the shell shows the override pill.
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
    // Both failure modes collapse into the same answer: the guard's 403 (not a
    // member) AND assertProjectAction's own 404 ("Project <slug> not found.",
    // thrown when project.md is missing) leave as ONE response. `what` survives
    // only as the audit row's copy — it never reaches the client, because two
    // different refusal strings are themselves an oracle.
    if (isAppError(error)) throw projectNotFound(request, projectSlug);
    throw error;
  }
  return ctx;
}

/**
 * The single refusal, byte-identical to the layout loader's unknown-slug 404
 * and to `requireVisibleProject`'s (routes/project-visibility.server.ts) —
 * `No project at projects/<slug>.`
 *
 * The body echoes the slug ONLY when the request already named it, i.e. the
 * path is `/projects/<slug>/…` (single-fetch appends `.data` to the LAST
 * segment, so the slug segment itself is untouched). The two run-addressed
 * resource routes (`/resources/run-log?runId=…`,
 * `/resources/session-export?run=…`) resolve the slug from the RUN row, so
 * echoing it there would hand a non-member the name of a project they never
 * asked about — a fresh leak in the middle of closing one. They get the bare
 * 404 instead, which still matches those routes' own missing-run status.
 *
 * The check is positional, not a bare `includes`: a project whose slug happens
 * to be `resources` would otherwise see its name echoed back on
 * `/resources/run-log`.
 */
function projectNotFound(request: Request, projectSlug: string) {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const named =
    segments[0] === "projects" &&
    (segments[1] === projectSlug || segments[1] === `${projectSlug}.data`);
  return data(named ? `No project at projects/${projectSlug}.` : "Not found.", {
    status: 404,
  });
}
