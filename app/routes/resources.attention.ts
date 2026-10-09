import { data } from "react-router";
import type { Route } from "./+types/resources.attention";
import { authenticate } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { attentionSnapshot } from "~/server/projections/notifications.server";

/**
 * GET /resources/attention — ruling 74 (F40-51). What the root-mounted
 * `AttentionWatcher` reads to put the count of unread decisions in the tab's
 * title and, when the person opted in, to show a desktop notification for a
 * new one: `{ waiting, items }` (`attentionSnapshot`), the viewer's own rows
 * only.
 *
 * The watcher reads it with a plain `fetch`, never through a fetcher, so no
 * route data depends on it: when a tab opens, when a `notification.*` event
 * reaches its live stream, when it gains or loses the person's attention, and
 * about once a minute while it has not got it. A hidden tab holds no live
 * stream (ruling 25), and this short read is how it still hears.
 */

/** No page revalidation ever reloads it. */
export function shouldRevalidate(): boolean {
  return false;
}

export async function loader({ request }: Route.LoaderArgs) {
  // A 401, never `requireUser`'s login redirect: the watcher reads this from a
  // tab nobody may be looking at, and a signed-out one just stops counting.
  const ctx = await authenticate(request);
  if (!ctx || ctx.pwresetRequired) {
    throw data("Sign in to see your notifications.", { status: 401 });
  }
  return Response.json(attentionSnapshot(getDb(), ctx.user.id), {
    headers: { "Cache-Control": "no-store" },
  });
}
