import { revalidateWhen } from "~/features/live-updates/revalidation-policy";
import { data, replace } from "react-router";
import { pageTitle } from "~/shared/page-title";
import type { Route } from "./+types/controller";
import { appErrorResponse } from "~/server/auth/form-action.server";
import { requireAuth } from "~/server/auth/require-user.server";
import { csrfError } from "~/features/shell/csrf-result.server";
import { getDb } from "~/server/db/sqlite.server";
import { createConversation } from "~/server/controller/controller-conversations.server";
import { deleteControllerConversation } from "~/server/controller/controller-deletion.server";
import {
  checkMessageFiles,
  interruptControllerTurn,
  runControllerTurn,
} from "~/server/controller/controller-run.server";
import { formFiles } from "~/server/files/form-files.server";
import { ControllerPage } from "~/features/controller/controller-page";
import {
  sendModeOf,
  waitingMessageAction,
} from "~/features/controller/waiting-actions.server";
import {
  getControllerSurface,
  selectedConversationId,
} from "~/features/controller/controller-query.server";
import { isDocumentNavigation } from "~/server/http/single-fetch.server";

/**
 * /controller — the instance controller surface (ruling 99). Every signed-in
 * user converses; what the controller answers and applies is gated per tool
 * call on THAT user's own authority. Conversations belong to their owner
 * (org admins may read everyone's with ?all=1), who may delete them, as may
 * an org admin (ruling 525).
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
      conversationId: selectedConversationId(db, url, {
        userId: user.id,
        projectSlug: null,
      }),
      all: url.searchParams.get("all") === "1",
      // Ruling 457 (owner decision 2): console lines on a document load only.
      console: isDocumentNavigation(request) ? "shown" : "none",
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
      // Ruling 573: the files it carries, checked before a thread is made for
      // it, so a refused file leaves no empty conversation behind.
      const files = checkMessageFiles(await formFiles(formData));
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
        files,
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
        // U39-24: the reader's zone; normalized by the engine.
        timeZone: String(formData.get("timeZone") ?? "") || null,
        // Ruling 527: steer the working turn (the default) or queue behind it.
        mode: sendModeOf(formData),
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
    // Ruling 527: Send now and Retract on a message still waiting.
    const waiting = waitingMessageAction(db, intent, formData, {
      id: auth.user.id,
      email: auth.user.email,
      name: auth.user.name,
      orgRole: auth.user.role,
    });
    if (waiting) return waiting;
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
    if (intent === "delete-conversation") {
      // Ruling 525: the rail's Delete, confirmed on the page. The engine
      // decides who may (here, its starter or an org admin), stops a running
      // turn and purges what the turns logged.
      const conversationId = String(formData.get("conversationId") ?? "");
      deleteControllerConversation(
        db,
        { conversationId, projectSlug: null },
        { userId: auth.user.id, label: auth.user.email },
      );
      // The thread on screen is gone, and its URL would now answer 404: land
      // where a bare visit does (U33-8), in place of the entry that named it.
      if (String(formData.get("open") ?? "") === conversationId) {
        return replace(formData.get("all") === "1" ? "/controller?all=1" : "/controller");
      }
      return { ok: true as const, toast: "Conversation deleted." };
    }
    return data({ ok: false as const, error: "Unknown action." }, { status: 400 });
  } catch (cause) {
    return appErrorResponse(cause);
  }
}

export default function ControllerRoute({ loaderData }: Route.ComponentProps) {
  return (
    <ControllerPage view={loaderData.view} projectSlug={null} />
  );
}

/** Ruling 457: when this loader re-runs (`revalidation-policy.ts`). */
export const shouldRevalidate = revalidateWhen("routes/controller");
