import { revalidateWhen } from "~/features/live-updates/revalidation-policy";
import { data } from "react-router";
import type { Route } from "./+types/project.controller";
import { pageTitle } from "~/shared/page-title";
import { appErrorResponse } from "~/server/auth/form-action.server";
import { requireAuth } from "~/server/auth/require-user.server";
import { csrfError } from "~/features/shell/csrf-result.server";
import { requireProjectMember } from "~/server/auth/require-project.server";
import { requireVisibleProject } from "./project-visibility.server";
import { getDb } from "~/server/db/sqlite.server";
import { ControllerPage } from "~/features/controller/controller-page";
import { controllerPageAction } from "~/features/controller/waiting-actions.server";
import { controllerPageView } from "~/features/controller/controller-query.server";
import { isOrgAdmin } from "~/server/auth/project-authority.server";
import { undoKbCorrectionOnTask } from "~/server/tasks/kb-correction-actions.server";

/**
 * /projects/:slug/controller — the controller addressed INSIDE one project
 * (ruling 249): the same conversation machinery bound to this board, plus the
 * knowledge-base panel. The board's planned work is its epics (ruling 273),
 * on the Epics page.
 */

/** D32-3: "<Page> · <project> · Viberr" — this view used to inherit the bare
 *  project title from the workspace layout. */
export function meta({ params }: Route.MetaArgs) {
  return [{ title: pageTitle("Controller", params.slug) }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  // R15-4 on THIS loader, not only the layout's (the F19-28 single-fetch
  // `?_routes=` hole): a non-member gets the unknown-slug 404.
  const ctx = await requireProjectMember(
    request,
    params.slug,
    "talk to the controller about this project",
  );
  return { view: controllerPageView(getDb(), request, ctx.user, params.slug) };
}

export async function action({ request, params }: Route.ActionArgs) {
  const auth = await requireAuth(request);
  const db = getDb();
  const formData = await request.formData();
  // UI-32 (ruling 256 brought it here): a stale token answers a toast-shaped
  // result, not a thrown 403 that replaces the page with the root boundary.
  const csrfFailure = await csrfError(request, auth.sessionId, formData);
  if (csrfFailure) return csrfFailure;
  const intent = String(formData.get("intent") ?? "");
  requireVisibleProject(db, params.slug, {
    userId: auth.user.id,
    label: auth.user.email,
  }, "talk to the controller about this project");
  try {
    if (intent === "kb-correction-undo") {
      // Ruling 321: the Knowledge base panel's Undo, confirmed on the page.
      // Direct, not through the controller: an undo is the recorded edit in
      // reverse, with nothing to compose. Org admins, because it edits an org
      // knowledge base.
      if (!isOrgAdmin(db, auth.user.id)) {
        return data(
          {
            ok: false as const,
            error: "Only an org admin can undo a knowledge-base correction: it edits an org knowledge base.",
          },
          { status: 403 },
        );
      }
      const reason = String(formData.get("reason") ?? "").trim();
      const result = await undoKbCorrectionOnTask(
        db,
        {},
        {
          id: String(formData.get("id") ?? ""),
          projectSlug: params.slug,
          reason: reason || null,
          person: { userId: auth.user.id, label: auth.user.email, name: auth.user.name },
        },
      );
      return { ok: result.outcome === "done", toast: result.message };
    }
    return await controllerPageAction(db, intent, formData, auth.user, params.slug);
  } catch (cause) {
    return appErrorResponse(cause);
  }
}

export default function ProjectControllerRoute({
  loaderData,
  params,
}: Route.ComponentProps) {
  return (
    <ControllerPage view={loaderData.view} projectSlug={params.slug} />
  );
}

/** Ruling 11: when this loader re-runs (`revalidation-policy.ts`). */
export const shouldRevalidate = revalidateWhen("routes/project.controller");
