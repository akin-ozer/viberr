import { data } from "react-router";
import type { Route } from "./+types/task-changes";
import { authenticate } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import {
  readTaskChanges,
  type TaskChangesView,
} from "~/server/github/task-changes.server";
import { requireVisibleProject } from "./project-visibility.server";

/**
 * GET /projects/:slug/tasks/:key/changes — the Changes panel's read (ruling
 * 484): the delivered revision's files and patches from its pull request,
 * `?path=` for one file the panel's read left out for size.
 *
 * Membership, the task page's own gate (`requireVisibleProject`: a non-member
 * gets the unknown-slug 404). The panel loads this itself when a person opens
 * it, so a page revalidation never re-reads GitHub, and the task page's own
 * loader never pays for it.
 */

/** The panel loads this itself: a page revalidation never reloads it. */
export function shouldRevalidate(): boolean {
  return false;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  // A 401, not `requireUser`'s login redirect: a fetcher follows a redirect as
  // a navigation (the bell's lesson, ruling 457).
  const ctx = await authenticate(request);
  if (!ctx || ctx.pwresetRequired) {
    throw data("Sign in to read this task's changes.", { status: 401 });
  }
  const db = getDb();
  requireVisibleProject(
    db,
    params.slug,
    { userId: ctx.user.id, label: ctx.user.email },
    "read this task's changes",
  );
  const path = new URL(request.url).searchParams.get("path")?.trim() || null;
  const view = await readTaskChanges(db, {
    projectSlug: params.slug,
    taskKey: params.key,
    path,
  });
  if (!view) {
    throw data(`No task ${params.key} in projects/${params.slug}.`, { status: 404 });
  }
  return view;
}

/**
 * A failed load is the panel's, never the page's: React Router sends a
 * fetcher's failure to the error boundary of the route that owns the fetcher,
 * which would replace the whole task page. Any failure answers the panel's
 * own failure shape, and its Try again reloads.
 */
export async function clientLoader({
  serverLoader,
}: Route.ClientLoaderArgs): Promise<TaskChangesView> {
  try {
    return await serverLoader();
  } catch {
    return { ok: false, reason: "The changes could not be loaded. Try again." };
  }
}
