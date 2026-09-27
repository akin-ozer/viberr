import type { Route } from "./+types/resources.search";
import { authenticate } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
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
  // Ruling 457 (test audit L14-29): a 401, never `requireUser`'s login
  // redirect, which named THIS route and the query as the returnTo. The
  // palette loads it through a fetcher as the person types, and a fetcher
  // follows a redirect as a navigation: typing in a stale tab went to /login
  // and, once signed in, to a page of raw JSON. The palette finds no hits in
  // the refusal and says nothing matches; the page's next real navigation
  // asks for the sign-in.
  const ctx = await authenticate(request);
  if (!ctx || ctx.pwresetRequired) {
    return Response.json(
      { error: { code: ERROR_CODES.UNAUTHORIZED, message: "Sign in to search." } },
      { status: 401 },
    );
  }
  const { user } = ctx;
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
