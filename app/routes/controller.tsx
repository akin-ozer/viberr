import { data } from "react-router";
import type { Route } from "./+types/controller";
import {
  appErrorResponse,
  requireFormAction,
} from "~/server/auth/form-action.server";
import { requireUser } from "~/server/auth/require-user.server";
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
  return [{ title: "Controller · Viberr" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
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
  const { auth, db, formData, intent } = await requireFormAction(request);
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
