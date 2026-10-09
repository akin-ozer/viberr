import { revalidateWhen } from "~/features/live-updates/revalidation-policy";
import { pageTitle } from "~/shared/page-title";
import type { Route } from "./+types/controller";
import { appErrorResponse } from "~/server/auth/form-action.server";
import { requireAuth } from "~/server/auth/require-user.server";
import { csrfError } from "~/features/shell/csrf-result.server";
import { getDb } from "~/server/db/sqlite.server";
import { ControllerPage } from "~/features/controller/controller-page";
import { controllerPageAction } from "~/features/controller/waiting-actions.server";
import { controllerPageView } from "~/features/controller/controller-query.server";

/**
 * /controller — the instance controller surface (ruling 247). Every signed-in
 * user converses; what the controller answers and applies is gated per tool
 * call on THAT user's own authority. Conversations belong to their owner
 * (org admins may read everyone's with ?all=1), who may delete them, as may
 * an org admin (ruling 26).
 */

export function meta() {
  return [{ title: pageTitle("Controller") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { user } = await requireAuth(request);
  return { view: controllerPageView(getDb(), request, user, null) };
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await requireAuth(request);
  const db = getDb();
  const formData = await request.formData();
  // UI-32 (ruling 256 brought it here): a stale token answers a toast-shaped
  // result, not a thrown 403 that replaces the page with the root boundary.
  const csrfFailure = await csrfError(request, auth.sessionId, formData);
  if (csrfFailure) return csrfFailure;
  const intent = String(formData.get("intent") ?? "");
  try {
    return await controllerPageAction(db, intent, formData, auth.user, null);
  } catch (cause) {
    return appErrorResponse(cause);
  }
}

export default function ControllerRoute({ loaderData }: Route.ComponentProps) {
  return (
    <ControllerPage view={loaderData.view} projectSlug={null} />
  );
}

/** Ruling 11: when this loader re-runs (`revalidation-policy.ts`). */
export const shouldRevalidate = revalidateWhen("routes/controller");
