import { data } from "react-router";
import type { Route } from "./+types/task-dependency-candidates";
import { authenticate } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { listDependencyCandidates } from "~/server/projections/dependencies.server";
import type { DependencyCandidate } from "~/shared/dependency-candidates";
import { requireVisibleProject } from "./project-visibility.server";

/**
 * GET /projects/:slug/tasks/:key/dependency-candidates — the Blocked by
 * picker's read (ruling 59): the project's other tasks, each with the refusal
 * the writer would give it as a new entry.
 *
 * Membership, the task page's own gate (`requireVisibleProject`: a non-member
 * gets the unknown-slug 404). The picker loads this itself when its editor
 * opens, so the task page's loader and its revalidations never carry the
 * project's task list.
 */

export type DependencyCandidatesView =
  | { ok: true; tasks: DependencyCandidate[] }
  | { ok: false; reason: string };

/** The picker loads this itself: a page revalidation never reloads it. */
export function shouldRevalidate(): boolean {
  return false;
}

export async function loader({
  request,
  params,
}: Route.LoaderArgs): Promise<DependencyCandidatesView> {
  // A 401, not `requireUser`'s login redirect: a fetcher follows a redirect as
  // a navigation (the bell's lesson, ruling 11).
  const ctx = await authenticate(request);
  if (!ctx || ctx.pwresetRequired) {
    throw data("Sign in to read what this task can wait on.", { status: 401 });
  }
  const db = getDb();
  requireVisibleProject(
    db,
    params.slug,
    { userId: ctx.user.id, label: ctx.user.email },
    "read what this task can wait on",
  );
  const tasks = listDependencyCandidates(db, params.slug, params.key);
  if (!tasks) {
    throw data(`No task ${params.key} in projects/${params.slug}.`, { status: 404 });
  }
  return { ok: true, tasks };
}

/**
 * A failed load is the picker's, never the page's: React Router sends a
 * fetcher's failure to the error boundary of the route that owns the fetcher,
 * which would replace the whole task page. Any failure answers the picker's
 * own failure shape; a key typed in full still goes to the writer, which
 * checks it.
 */
export async function clientLoader({
  serverLoader,
}: Route.ClientLoaderArgs): Promise<DependencyCandidatesView> {
  try {
    return await serverLoader();
  } catch {
    return { ok: false, reason: "The project's tasks could not be loaded." };
  }
}
