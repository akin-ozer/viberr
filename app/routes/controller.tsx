import { data } from "react-router";
import { pageTitle } from "~/shared/page-title";
import type { Route } from "./+types/controller";
import { appErrorResponse } from "~/server/auth/form-action.server";
import { requireAuth } from "~/server/auth/require-user.server";
import { csrfError } from "~/features/shell/csrf-result.server";
import { getDb } from "~/server/db/sqlite.server";
import {
  createConversation,
  listConversations,
} from "~/server/controller/controller-conversations.server";
import {
  interruptControllerTurn,
  runControllerTurn,
} from "~/server/controller/controller-run.server";
import {
  ControllerPage,
  NEW_CONVERSATION_PARAM,
} from "~/features/controller/controller-page";
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

/**
 * U33-8: which thread this visit opens.
 *
 * The dock's continuity rule (ruling 121) is "the newest thread of the scope
 * you are standing in"; this page answered a blank composer instead, so one
 * person on one scope got two different answers from the two entry points.
 * Same rule here: no `?c=` opens this scope's newest thread, `?c=new` is the
 * blank composer the New link asks for, and an explicit id still wins —
 * `getControllerSurface` is what judges whether that id is theirs and in
 * scope, and still 404s when it is not.
 *
 * The default is drawn from the viewer's OWN threads, exactly as the dock's
 * is: an org admin reading everyone's (`?all=1`) lands on a thread they can
 * actually talk in rather than on someone else's read-only transcript.
 */
function selectedConversationId(
  db: ReturnType<typeof getDb>,
  url: URL,
  userId: string,
): string | null {
  const requested = url.searchParams.get("c");
  if (requested === NEW_CONVERSATION_PARAM) return null;
  if (requested !== null) return requested;
  const newest = listConversations(db, {
    userId,
    projectSlug: null,
    limit: 1,
  })[0];
  return newest?.id ?? null;
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
      conversationId: selectedConversationId(db, url, user.id),
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
        // U35-4 (pass 35): the refusal is recorded IN the conversation (a
        // reload still shows it), and the door says so too: 409, never a 200
        // for a message nothing will answer.
        return data(
          { ok: false as const, error: result.reason, conversationId },
          { status: 409 },
        );
      }
      return { ok: true as const, conversationId };
    }
    if (intent === "interrupt") {
      // The Live-run strip's Interrupt, confirmed on the page. The engine
      // decides who may stop a controller turn (its owner or an org admin) and
      // settles the turn so the transcript records that it was stopped.
      const result = await interruptControllerTurn(
        db,
        {
          conversationId: String(formData.get("conversationId") ?? ""),
          runId: String(formData.get("runId") ?? ""),
        },
        { userId: auth.user.id, label: auth.user.email },
      );
      return {
        ok: true as const,
        toast:
          result.outcome === "interrupted"
            ? "Turn interrupted. The transcript records that it was stopped."
            : "That turn had already ended.",
      };
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
