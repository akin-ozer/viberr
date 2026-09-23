import type { Route } from "./+types/resources.controller-unseen";
import { requireAuth } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { assertProjectAction } from "~/server/auth/project-authority.server";
import { listUnseenReplies } from "~/server/controller/controller-conversations.server";

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
 * O39-d: the viewer's controller conversations holding a reply they have not
 * seen, for the dock's button on every page. A turn runs one to five minutes,
 * and its answer reached only the surfaces still open on it: a person who had
 * moved on learned nothing until they went back to look. Replies stay out of
 * the bell by design (controller-and-goals §8), so this is its own signal.
 *
 * Only threads whose project the viewer can still open are listed, so every
 * link leads somewhere.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const auth = await requireAuth(request);
  const db = getDb();
  const actor = { userId: auth.user.id, label: auth.user.email };
  const reachable = (projectSlug: string | null): boolean => {
    if (!projectSlug) return true;
    try {
      assertProjectAction(db, "any-member", projectSlug, actor, "read a controller reply", {
        allowArchived: true,
      });
      return true;
    } catch {
      return false;
    }
  };
  const unseen: UnseenReplyView[] = listUnseenReplies(db, auth.user.id)
    .filter((r) => reachable(r.projectSlug))
    .map((r) => ({
      ...r,
      href: r.projectSlug
        ? `/projects/${encodeURIComponent(r.projectSlug)}/controller?c=${encodeURIComponent(r.id)}`
        : `/controller?c=${encodeURIComponent(r.id)}`,
    }));
  return { unseen };
}
