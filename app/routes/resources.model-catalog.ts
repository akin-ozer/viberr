import type { Route } from "./+types/resources.model-catalog";
import { requireUser } from "~/server/auth/require-user.server";
import { getModelCatalog } from "~/server/runtimes/model-catalog.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";

/**
 * GET /resources/model-catalog?backend=claude|codex — the model + effort
 * (reasoning) catalog for a backend, fetched by the agent create/edit modal
 * (useFetcher) on open and whenever the backend toggles. Claude enhances the
 * curated fallback with the account's LIVE `supportedModels()` list when a
 * credential is present; codex is curated-only. Any signed-in user may read
 * (V1 read RBAC: all app users see all projects; profile CRUD is the gated
 * action, not reading the catalog).
 *
 * Returns `{ data: { models, efforts, defaultModel, defaultEffort } }`. An
 * unknown/missing backend defaults to claude so the modal always renders.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const url = new URL(request.url);
  const raw = url.searchParams.get("backend");
  const backend: RealBackend = raw === "codex" ? "codex" : "claude";
  const catalog = await getModelCatalog(backend);
  return Response.json({ data: catalog });
}
