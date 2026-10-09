import { data } from "react-router";
import type { Route } from "./+types/resources.controller-unseen";
import { authenticate } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { assertProjectAction } from "~/server/auth/project-authority.server";
import {
  getConversation,
  listUnseenReplies,
} from "~/server/controller/controller-conversations.server";
import {
  conversationTurnState,
  liveTurnConversationIds,
} from "~/server/controller/controller-run.server";
import { dockResourceShouldRevalidate } from "~/features/controller/controller-dock-context";

/** O39-d: one conversation holding a reply its owner has not seen, and the
 *  page that opens it. */
export interface UnseenReplyView {
  id: string;
  title: string;
  projectSlug: string | null;
  taskKey: string | null;
  href: string;
}

/**
 * Ruling 11 (CTL-2): one of the viewer's own conversations with a turn
 * working right now, and what it is doing (ruling 257's phase and step). The
 * dock's working dot and its step line read this, polled every 5 s while a
 * turn works, instead of reloading the whole transcript to move one line.
 */
export interface LiveTurnView {
  id: string;
  projectSlug: string | null;
  taskKey: string | null;
  phase: string | null;
  step: string | null;
}

export interface DockStatus {
  unseen: UnseenReplyView[];
  working: LiveTurnView[];
}

/** Ruling 11: the dock loads this itself; a page revalidation never reloads
 *  it (see `dockResourceShouldRevalidate`). */
export const shouldRevalidate = dockResourceShouldRevalidate;

/**
 * The dock's status on every page: O39-d's replies the viewer has not seen,
 * and (ruling 11) the viewer's turns working right now.
 *
 * O39-d: a turn runs one to five minutes, and its answer reached only the
 * surfaces still open on it: a person who had moved on learned nothing until
 * they went back to look. Replies stay out of the bell by design
 * (controller-and-epics §8), so this is its own signal. Only threads whose
 * project the viewer can still open are listed, so every link leads somewhere.
 */
export async function loader({ request }: Route.LoaderArgs) {
  // Ruling 11 (test audit L14-29): a 401, never `requireAuth`'s login
  // redirect, which named THIS route as the returnTo. The dock loads it on
  // every page, on each `controller.updated` and every 5 s while a turn works,
  // all through a root-owned fetcher, and a fetcher follows a redirect as a
  // navigation: a stale tab went to /login and, once signed in, to a page of
  // raw JSON. It answers an empty status, so the button shows nothing and the
  // working poll stops. The page's next real navigation asks for the sign-in.
  const auth = await authenticate(request);
  if (!auth || auth.pwresetRequired) {
    return data<DockStatus>({ unseen: [], working: [] }, { status: 401 });
  }
  const db = getDb();
  const actor = { userId: auth.user.id, label: auth.user.email };
  // Once per project: six unseen threads on one board read its project file
  // six times for the same answer.
  const reachableBySlug = new Map<string, boolean>();
  const reachable = (projectSlug: string | null): boolean => {
    if (!projectSlug) return true;
    const known = reachableBySlug.get(projectSlug);
    if (known !== undefined) return known;
    let ok = true;
    try {
      assertProjectAction(db, "any-member", projectSlug, actor, "read a controller reply", {
        allowArchived: true,
      });
    } catch {
      ok = false;
    }
    reachableBySlug.set(projectSlug, ok);
    return ok;
  };
  const unseen: UnseenReplyView[] = listUnseenReplies(db, auth.user.id)
    .filter((r) => reachable(r.projectSlug))
    .map((r) => ({
      ...r,
      href: r.projectSlug
        ? `/projects/${encodeURIComponent(r.projectSlug)}/controller?c=${encodeURIComponent(r.id)}`
        : `/controller?c=${encodeURIComponent(r.id)}`,
    }));
  const working: LiveTurnView[] = [];
  for (const id of liveTurnConversationIds()) {
    const conversation = getConversation(db, id);
    if (!conversation || conversation.userId !== auth.user.id) continue;
    const turn = conversationTurnState(db, id);
    if (!turn.working) continue;
    working.push({
      id,
      projectSlug: conversation.projectSlug,
      taskKey: conversation.taskKey,
      phase: turn.phase,
      step: turn.step,
    });
  }
  return { unseen, working } satisfies DockStatus;
}

/**
 * Ruling 11: a failed load is the dock's, never the page's. React Router
 * sends a fetcher's failure to the error boundary of the route that owns the
 * fetcher, and root owns the dock's, so a restart, a 5xx or a dead network
 * under a `controller.updated` or the working poll replaced the whole page
 * with root's error page. Any failure answers null, which the dock reads as it
 * reads the time before its first answer: no reply waiting and no turn
 * working, so the working poll stops. The next status that answers puts them
 * back: a panel open or close, or the next `controller.updated` (the stream
 * hands the dock one when it resyncs after a restart).
 */
export async function clientLoader({ serverLoader }: Route.ClientLoaderArgs) {
  try {
    return await serverLoader();
  } catch {
    return null;
  }
}
