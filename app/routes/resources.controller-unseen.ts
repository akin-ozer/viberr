import type { Route } from "./+types/resources.controller-unseen";
import { requireAuth } from "~/server/auth/require-user.server";
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
 * Ruling 454 (CTL-2): one of the viewer's own conversations with a turn
 * working right now, and what it is doing (ruling 250's phase and step). The
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

/** Ruling 454: the dock loads this itself; a page revalidation never reloads
 *  it (see `dockResourceShouldRevalidate`). */
export const shouldRevalidate = dockResourceShouldRevalidate;

/**
 * The dock's status on every page: O39-d's replies the viewer has not seen,
 * and (ruling 454) the viewer's turns working right now.
 *
 * O39-d: a turn runs one to five minutes, and its answer reached only the
 * surfaces still open on it: a person who had moved on learned nothing until
 * they went back to look. Replies stay out of the bell by design
 * (controller-and-goals §8), so this is its own signal. Only threads whose
 * project the viewer can still open are listed, so every link leads somewhere.
 */
export async function loader({ request }: Route.LoaderArgs): Promise<DockStatus> {
  const auth = await requireAuth(request);
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
  return { unseen, working };
}
