import { data } from "react-router";
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
  checkMessageFiles,
  controllerNotConnectedSentence,
  runControllerTurn,
} from "~/server/controller/controller-run.server";
import { formFiles } from "~/server/files/form-files.server";
import { userBackendHealth } from "~/server/runtimes/backend-credentials.server";
import { NEW_CONVERSATION_PARAM } from "~/features/controller/conversation-param";
import {
  sendModeOf,
  textField,
  waitingMessageAction,
} from "~/features/controller/waiting-actions.server";
import {
  conversationMatchesScope,
  getControllerDock,
  signedOutDockView,
  unavailableDockView,
} from "~/features/controller/controller-dock-query.server";
import { assertProjectAction } from "~/server/auth/project-authority.server";
import { taskExists } from "~/server/projections/task-query.server";
import { dockResourceShouldRevalidate } from "~/features/controller/controller-dock-context";

/** Ruling 11: the dock loads its view itself; a page revalidation never
 *  reloads it (see `dockResourceShouldRevalidate`). */
export const shouldRevalidate = dockResourceShouldRevalidate;

/**
 * /resources/controller — the controller DOCK's data route (ruling 256), a
 * fetcher target with no UI (the `notifications/read` family).
 *
 *   GET  ?project=&task=&c=   → { view } for the scope the person is standing in
 *   POST intent=send          → records the message, runs the turn, answers
 *                               { ok, conversationId }; a refused turn (no
 *                               Claude connected for the asker, ruling 137)
 *                               answers 409 { ok:false, error } and creates no
 *                               thread for a new conversation (U35-4)
 *   POST intent=send-now|retract → ruling 251's moves on a message still
 *                               waiting in the person's own conversation
 *
 * The scope is authorized HERE, in the route, through the same chokepoint the
 * page routes use (`assertProjectAction` "any-member", so the org-admin
 * override and the denial audit row apply), and a task scope additionally
 * requires the task to exist.
 *
 * NOTHING IN EITHER HANDLER THROWS (review finding 2). The dock is a
 * root-owned fetcher, so a thrown response — a 404 as much as the 403 UI-32
 * already caught — replaced the whole page with the root error page. The
 * `clientLoader` and `clientAction` below now keep the page from any failure
 * (ruling 11), but a failure reaches the dock only as a view not loaded or
 * the send's generic toast, which say nothing about why. So a GET for a scope
 * the person cannot reach answers the benign `unavailable` view (one shape
 * for "no such project" and "not yours", so it is no more of an oracle than
 * the 404 was), and a POST answers `{ ok:false, error }`. The full pages keep
 * their own 404s; this route serves a panel, not a page.
 *
 * NOR DOES EITHER REDIRECT (ruling 11, test audit L14-29). A caller who is
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
  return scope.taskKey ? taskExists(db, scope.projectSlug, scope.taskKey) : true;
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
    { id: auth.user.id },
    // O39-d: only an OPEN panel reads the transcript it loads.
    { ...scope, conversationId: c, markSeen: url.searchParams.get("seen") === "1" },
  );
  return { view };
}

export async function action({ request }: Route.ActionArgs) {
  const auth = await authenticate(request);
  if (!auth || auth.pwresetRequired) {
    // The message is still in the dock's composer (ruling 319), and a reload
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
  // Ruling 251: the conversation's owner is the whole authority for these
  // (the engine checks it); they create nothing in the scope the dock is on.
  try {
    const waiting = waitingMessageAction(db, intent, formData, {
      id: auth.user.id,
      email: auth.user.email,
      name: auth.user.name,
      orgRole: auth.user.role,
    });
    if (waiting) return waiting;
  } catch (cause) {
    return appErrorResponse(cause);
  }
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
    // Ruling 258: the files it carries, checked before any thread is made for
    // it (U35-4's rule for a refusal).
    const files = checkMessageFiles(await formFiles(formData));
    let conversationId = textField.parse(formData.get("conversationId")).trim();
    if (!conversationId || conversationId === NEW_CONVERSATION_PARAM) {
      // U35-4 (pass 35): the dock disables its composer for a person with no
      // Claude connected (ruling 137), and this door used to answer 200 anyway,
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
      files,
      user: {
        id: auth.user.id,
        email: auth.user.email,
        name: auth.user.name,
        orgRole: auth.user.role,
      },
      surface,
      timeZone,
      // Ruling 251: steer the working turn (the default) or queue behind it.
      mode: sendModeOf(formData),
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

/**
 * Ruling 11: a failed load is the dock's, never the page's. React Router
 * sends a fetcher's failure to the error boundary of the route that owns the
 * fetcher, and root owns the dock's, so a restart, a 5xx or a dead network
 * under an open, a thread pick or a `controller.updated` replaced the whole
 * page with root's error page. Any failure answers null, which the open panel
 * reads as a view not loaded yet: its loading lines, the composer held, what
 * was typed kept. The next load that answers puts the view back: the next
 * `controller.updated` (the stream hands the dock one when it resyncs after a
 * restart), a thread pick, or opening the panel again.
 */
export async function clientLoader({ serverLoader }: Route.ClientLoaderArgs) {
  try {
    return await serverLoader();
  } catch {
    return null;
  }
}

/**
 * Ruling 11: a send that gets no answer (a restart, a 5xx, a dead network)
 * is the dock's to report, never the page's to lose. It answers as a refused
 * send does, so the dock toasts "The controller could not take that. Try
 * again." and the message stays in the composer (ruling 319).
 */
export async function clientAction({ serverAction }: Route.ClientActionArgs) {
  try {
    return await serverAction();
  } catch {
    return { ok: false as const };
  }
}
