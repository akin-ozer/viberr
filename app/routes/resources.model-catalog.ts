import type { Route } from "./+types/resources.model-catalog";
import { authenticate } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { getModelCatalog } from "~/server/runtimes/model-catalog.server";
import {
  runCredentialFor,
  type RunCredential,
} from "~/server/runtimes/backend-credentials.server";
import { AppError } from "~/server/errors/app-error.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";

/**
 * GET /resources/model-catalog?backend=claude|codex — the model + effort
 * (reasoning) catalog for a backend, fetched by the agent create/edit modal
 * (useFetcher) on open and whenever the backend toggles. Claude enhances the
 * curated fallback with the LIVE `supportedModels()` list of the VIEWER's OWN
 * Claude account when they have connected one (ruling 127: there is no
 * instance account to enumerate, and one person's subscription must not decide
 * another's picker); codex is curated-only. Any signed-in user may read (V1
 * read RBAC: all app users see all projects; profile CRUD is the gated action,
 * not reading the catalog).
 *
 * Returns `{ data: { models, efforts, defaultModel, defaultEffort } }`. An
 * unknown/missing backend defaults to claude so the modal always renders.
 *
 * R20-3 / F20-4: the db is threaded so `getModelCatalog` stamps each model
 * `unavailable` from the `model_availability` marks — the picker then disables
 * and explains a model a real run proved this account cannot use, instead of
 * silently offering one that 400s at the SDK.
 */
export async function loader({ request }: Route.LoaderArgs) {
  // Ruling 457 (test audit L14-29): a 401, never `requireUser`'s login
  // redirect, which named THIS route as the returnTo. The editors load it
  // through a fetcher when they open and when the backend changes, and a
  // fetcher follows a redirect as a navigation: opening one in a stale tab
  // went to /login and, once signed in, to a page of raw JSON. The editor
  // reads the refusal as a failed load and offers its retry (D5); the page's
  // next real navigation asks for the sign-in.
  const ctx = await authenticate(request);
  if (!ctx || ctx.pwresetRequired) {
    return Response.json(
      {
        error: {
          code: ERROR_CODES.UNAUTHORIZED,
          message: "Sign in to read the model catalog.",
        },
      },
      { status: 401 },
    );
  }
  const { user } = ctx;
  const db = getDb();
  const url = new URL(request.url);
  const raw = url.searchParams.get("backend");
  const backend: RealBackend = raw === "codex" ? "codex" : "claude";
  // Pass 40 review (R-launcher-1): the viewer is also who the live probe runs
  // as (ruling 460), since it runs the CLI against their own sign-in.
  const deps: Parameters<typeof getModelCatalog>[1] = { db, userId: user.id };
  const credential = viewerClaudeCredential(db, backend, user.id);
  if (credential) deps.credential = credential;
  const catalog = await getModelCatalog(backend, deps);
  return Response.json({ data: catalog });
}

/**
 * The viewer's own Claude credential, or null when they have not connected
 * Claude. Null is not a failure — it is the ordinary state of someone who has
 * not connected the backend yet, and the curated catalog is a complete answer
 * for them. A refusal here must never 500 a picker.
 */
function viewerClaudeCredential(
  db: ReturnType<typeof getDb>,
  backend: RealBackend,
  userId: string,
): RunCredential | null {
  if (backend !== "claude") return null;
  try {
    return runCredentialFor(db, userId, "claude");
  } catch (error) {
    if (error instanceof AppError) return null;
    throw error;
  }
}
