import { data, type ShouldRevalidateFunctionArgs } from "react-router";
import type { Route } from "./+types/task-decision";
import { authenticate } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import {
  readTaskDecision,
  type TaskDecision,
} from "~/server/projections/task-decision.server";
import { requireVisibleProject } from "./project-visibility.server";

/**
 * GET /projects/:slug/tasks/:key/decision — the Review queue's decision
 * dialog (ruling 304): the task's open decision, the completion it offers and
 * the facts the acceptance ceremony names, read the way the task page reads
 * them (`readTaskDecision`). The dialog posts its answer to the task page's
 * own action, so every refusal, audit row and toast is that action's.
 *
 * Membership, the task page's own gate (`requireVisibleProject`: a non-member
 * gets the unknown-slug 404). The dialog loads this itself when it opens, so
 * the queue's loader never carries a decision's evidence.
 */

/** The read, or that it failed: the dialog then says so beside its link to
 *  the task, in its own words. */
export type TaskDecisionView = ({ ok: true } & TaskDecision) | { ok: false };

/**
 * The dialog reloads when the queue behind it does (an answer, or a live event
 * on the board), so the decision it shows is the one the server would answer:
 * a packet replaced while it stood open is redrawn, never confirmed blind.
 */
export function shouldRevalidate({ defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  return defaultShouldRevalidate;
}

export async function loader({ request, params }: Route.LoaderArgs): Promise<TaskDecisionView> {
  // A 401, not `requireUser`'s login redirect: a fetcher follows a redirect as
  // a navigation (the bell's lesson, ruling 11).
  const ctx = await authenticate(request);
  if (!ctx || ctx.pwresetRequired) {
    throw data("Sign in to read this decision.", { status: 401 });
  }
  const db = getDb();
  requireVisibleProject(
    db,
    params.slug,
    { userId: ctx.user.id, label: ctx.user.email },
    "read this decision",
  );
  const decision = readTaskDecision(db, {
    projectSlug: params.slug,
    taskKey: params.key,
    viewerUserId: ctx.user.id,
    orgAdmin: ctx.user.role === "admin",
  });
  if (!decision) {
    throw data(`No task ${params.key} in projects/${params.slug}.`, { status: 404 });
  }
  return { ok: true, ...decision };
}

/**
 * A failed load is the dialog's, never the queue's: React Router sends a
 * fetcher's failure to the error boundary of the route that owns the fetcher,
 * which would replace the whole Review queue. Any failure answers the dialog's
 * own failure shape, beside its link to the task.
 */
export async function clientLoader({
  serverLoader,
}: Route.ClientLoaderArgs): Promise<TaskDecisionView> {
  try {
    return await serverLoader();
  } catch {
    return { ok: false };
  }
}
