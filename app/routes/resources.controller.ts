import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/resources.controller";
import { authenticate } from "~/server/auth/require-user.server";
import { appErrorResponse } from "~/server/auth/form-action.server";
import { csrfError } from "~/features/shell/csrf-result.server";
import { getDb } from "~/server/db/sqlite.server";
import {
  createConversation,
  requireConversation,
} from "~/server/controller/controller-conversations.server";
import {
  controllerNotConnectedSentence,
  runControllerTurn,
} from "~/server/controller/controller-run.server";
import { userBackendHealth } from "~/server/runtimes/backend-credentials.server";
import { NEW_CONVERSATION_PARAM } from "~/features/controller/conversation-param";
import {
  conversationMatchesScope,
  dockTaskExists,
  getControllerDock,
  signedOutDockView,
  unavailableDockView,
} from "~/features/controller/controller-dock-query.server";
import { assertProjectAction } from "~/server/auth/project-authority.server";
import { dockResourceShouldRevalidate } from "~/features/controller/controller-dock-context";

/** Ruling 457: the dock loads its view itself; a page revalidation never
 *  reloads it (see `dockResourceShouldRevalidate`). */
export const shouldRevalidate = dockResourceShouldRevalidate;

/**
 * /resources/controller — the controller DOCK's data route (ruling 121), a
 * fetcher target with no UI (the `notifications/read` family).
 *
 *   GET  ?project=&task=&c=   → { view } for the scope the person is standing in
 *   POST intent=send          → records the message, runs the turn, answers
 *                               { ok, conversationId }; a refused turn (no
 *                               Claude connected for the asker, ruling 127)
 *                               answers 409 { ok:false, error } and creates no
 *                               thread for a new conversation (U35-4)
 *
 * The scope is authorized HERE, in the route, through the same chokepoint the
 * page routes use (`assertProjectAction` "any-member", so the org-admin
 * override and the denial audit row apply), and a task scope additionally
 * requires the task to exist.
 *
 * NOTHING IN EITHER HANDLER THROWS (review finding 2). The dock is a
 * root-owned fetcher, so a thrown response — a 404 as much as the 403 UI-32
 * already caught — replaces the whole page with the root error page. A GET for
 * a scope the person cannot reach answers the benign `unavailable` view (one
 * shape for "no such project" and "not yours", so it is no more of an oracle
 * than the 404 was), and a POST answers `{ ok:false, error }`. The full pages
 * keep their own 404s; this route serves a panel, not a page.
 *
 * NOR DOES EITHER REDIRECT (ruling 457, test audit L14-29). A caller who is
 * not signed in (no session, or a forced password reset pending) gets a 401:
 * the signed-out view for a GET, `{ ok:false, error }` for a POST.
 * `requireAuth`'s login redirect named this route and the scope's query as
 * the returnTo, and a fetcher follows a redirect as a navigation, so a stale
 * tab's open or send went to /login and, once signed in, to a page of raw
 * JSON. The page's next real navigation asks for the sign-in, with its own
 * path.
 */

interface DockScopeParams {
  projectSlug: string | null;
  taskKey: string | null;
}

/** A text field at the request boundary: a string, trimmed; anything else
 *  (absent, a File part) reads as empty. */
const textField = z.string().catch("");

function scopeParams(params: URLSearchParams | FormData): DockScopeParams {
  const read = (key: string) => textField.parse(params.get(key)).trim() || null;
  const projectSlug = read("project");
  // A task without a project is not a scope; ignore the stray key.
  const taskKey = projectSlug ? read("task") : null;
  return { projectSlug, taskKey };
}

/** Can this person talk to the controller about this scope, right now?
 *  Instance scope is open to every signed-in user; a project scope is the
 *  members-only gate; a task scope additionally has to exist. */
function scopeIsReachable(
  db: ReturnType<typeof getDb>,
  scope: DockScopeParams,
  actor: { userId: string; label: string },
): boolean {
  if (!scope.projectSlug) return true;
  try {
    assertProjectAction(
      db,
      "any-member",
      scope.projectSlug,
      actor,
      "talk to the controller about this project",
      { allowArchived: true },
    );
  } catch {
    return false;
  }
  return scope.taskKey ? dockTaskExists(db, scope.projectSlug, scope.taskKey) : true;
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const scope = scopeParams(url.searchParams);
  const auth = await authenticate(request);
  if (!auth || auth.pwresetRequired) {
    return data({ view: signedOutDockView(scope) }, { status: 401 });
  }
  const db = getDb();
  const actor = { userId: auth.user.id, label: auth.user.email };
  if (!scopeIsReachable(db, scope, actor)) {
    return { view: unavailableDockView(db, { id: auth.user.id }, scope) };
  }
  const c = url.searchParams.get("c")?.trim() || null;
  const view = getControllerDock(
    db,
    { id: auth.user.id, email: auth.user.email },
    // O39-d: only an OPEN panel reads the transcript it loads.
    { ...scope, conversationId: c, markSeen: url.searchParams.get("seen") === "1" },
  );
  return { view };
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticate(request);
  if (!auth || auth.pwresetRequired) {
    // The message is still in the dock's composer (ruling 259), and a reload
    // empties it.
    return data(
      {
        ok: false as const,
        error:
          "You're signed out, so this wasn't sent. Copy it, then reload the page to sign in again.",
      },
      { status: 401 },
    );
  }
  const db = getDb();
  const formData = await request.formData();
  const csrfFailure = await csrfError(request, auth.sessionId, formData);
  if (csrfFailure) return csrfFailure;
  const intent = String(formData.get("intent") ?? "");
  if (intent !== "send") {
    return data({ ok: false as const, error: "Unknown action." }, { status: 400 });
  }
  const scope = scopeParams(formData);
  if (!scopeIsReachable(db, scope, { userId: auth.user.id, label: auth.user.email })) {
    return data(
      { ok: false as const, error: "That project or task is not open to you." },
      { status: 404 },
    );
  }
  try {
    const text = textField.parse(formData.get("text"));
    const surface = textField.parse(formData.get("surface")) || null;
    // U39-24: the reader's zone; normalized by the engine.
    const timeZone = textField.parse(formData.get("timeZone")) || null;
    let conversationId = textField.parse(formData.get("conversationId")).trim();
    if (!conversationId || conversationId === NEW_CONVERSATION_PARAM) {
      // U35-4 (pass 35): the dock disables its composer for a person with no
      // Claude connected (ruling 127), and this door used to answer 200 anyway,
      // creating a thread whose only reply was the refusal. Refuse here, with
      // the same sentence, before any thread exists.
      //
      // Pass-35 review: "unavailable" is two different states — no credential
      // row at all, and a `login` row whose sign-in file is gone from this
      // server. Refusing before `createConversation` means there is no
      // transcript to read the accurate sentence in, so this door reads the
      // health and answers the SAME sentence the engine would, from the one
      // home that makes that choice.
      const health = userBackendHealth(db, auth.user.id, "claude");
      if (!health.available) {
        return data(
          { ok: false as const, error: controllerNotConnectedSentence(health) },
          { status: 409 },
        );
      }
      conversationId = createConversation(db, {
        userId: auth.user.id,
        userLabel: auth.user.email,
        projectSlug: scope.projectSlug,
        taskKey: scope.taskKey,
      }).id;
    } else {
      // A thread from another scope is not this dock's to speak in — the
      // same not-found shape a foreign conversation gets.
      const existing = requireConversation(db, conversationId, {
        userId: auth.user.id,
        orgRole: auth.user.role,
      });
      if (!conversationMatchesScope(existing, scope)) {
        return data({ ok: false as const, error: "Conversation not found." }, { status: 404 });
      }
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
      surface,
      timeZone,
    });
    if (result.state === "refused") {
      // The refusal note is in the transcript (a reload still shows it); the
      // door itself no longer says yes to a message nothing will answer.
      return data(
        { ok: false as const, error: result.reason, conversationId },
        { status: 409 },
      );
    }
    return { ok: true as const, conversationId };
  } catch (cause) {
    return appErrorResponse(cause);
  }
}
