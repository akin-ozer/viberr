import type { Route } from "./+types/resources.search";
import { requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { searchWorkspace } from "~/features/shell/command-search.server";

/**
 * GET /resources/search?q=… — the ⌘K palette's query (R15-5).
 *
 * Fetcher-only (no UI). Scoping is the query's own job: `searchWorkspace`
 * resolves the viewer's visible projects with the SAME membership rule the
 * home grid and the R15-4 workspace gate use, so this route needs no project
 * guard of its own — there is no slug in the request to guard.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const hits = searchWorkspace(
    getDb(),
    { id: user.id, role: user.role },
    // A long query costs the same as a short one here, but there is no reason
    // to run an unbounded LIKE term through the scan.
    q.slice(0, 120),
  );
  return Response.json({ data: { q, hits } });
}
