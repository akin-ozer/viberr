import { data } from "react-router";
import { pageTitle } from "~/shared/page-title";
import type { Route } from "./+types/controller";
import { appErrorResponse } from "~/server/auth/form-action.server";
import { requireAuth } from "~/server/auth/require-user.server";
import { csrfError } from "~/features/shell/csrf-result.server";
import { getDb } from "~/server/db/sqlite.server";
import { createConversation } from "~/server/controller/controller-conversations.server";
import { runControllerTurn } from "~/server/controller/controller-run.server";
import { ControllerPage } from "~/features/controller/controller-page";
import { getControllerSurface } from "~/features/controller/controller-query.server";

/**
 * /controller — the instance controller surface (ruling 99). Every signed-in
 * user converses; what the controller answers and applies is gated per tool
 * call on THAT user's own authority. Conversations belong to their owner
 * (org admins may read everyone's with ?all=1).
 */

export function meta() {
  return [{ title: pageTitle("Controller") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { user } = await requireAuth(request);
  const url = new URL(request.url);
  const db = getDb();
  const view = getControllerSurface(
    db,
    { id: user.id, email: user.email },
    {
      projectSlug: null,
      conversationId: url.searchParams.get("c"),
      all: url.searchParams.get("all") === "1",
    },
  );
  return { view };
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await requireAuth(request);
  const db = getDb();
  const formData = await request.formData();
  // UI-32 (ruling 121 brought it here): a stale token answers a toast-shaped
  // result, not a thrown 403 that replaces the page with the root boundary.
  const csrfFailure = await csrfError(request, auth.sessionId, formData);
  if (csrfFailure) return csrfFailure;
  const intent = String(formData.get("intent") ?? "");
  try {
    if (intent === "send") {
      const text = String(formData.get("text") ?? "");
      let conversationId = String(formData.get("conversationId") ?? "");
      if (!conversationId) {
        conversationId = createConversation(db, {
          userId: auth.user.id,
          userLabel: auth.user.email,
          projectSlug: null,
        }).id;
      }
      const result = await runControllerTurn(db, {
        conversationId,
        text,
        user: {
          id: auth.user.id,
          email: auth.user.email,
          name: auth.user.name,
          orgRole: auth.user.role,
        },
        // Ruling 121(d) records the page every USER message was sent from, and
        // that includes the ones sent from here (review finding 23). The store
        // normalizes it; a form without the field records null, as before.
        surface: String(formData.get("surface") ?? "") || null,
      });
      if (result.state === "refused") {
        // The refusal is already recorded IN the conversation; the transcript
        // shows it, so the action itself still succeeds.
        return { ok: true as const, conversationId };
      }
      return { ok: true as const, conversationId };
    }
    return data({ ok: false as const, error: "Unknown action." }, { status: 400 });
  } catch (cause) {
    return appErrorResponse(cause);
  }
}

export default function ControllerRoute({ loaderData }: Route.ComponentProps) {
  return (
    <ControllerPage
      view={loaderData.view}
      projectSlug={null}
      canRedirectGoals={false}
    />
  );
}
