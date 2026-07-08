import { data, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/project.github";
import type { loader as projectLoader } from "./project";
import { assertCsrf } from "~/server/auth/csrf.server";
import { requireAuth, requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { isAppError } from "~/server/errors/app-error.server";
import { listProjectMembers } from "~/server/projections/board-query.server";
import {
  runGrantScope,
  runReconcile,
} from "~/features/github/github-actions.server";
import { getGithubViewData } from "~/features/github/github-query.server";
import { GithubViewPage } from "~/features/github/github-view";

/**
 * /projects/:slug/github — the GitHub surface (github-view spec), replacing
 * the phase-4 placeholder. Loader: repository panel facts (checkRepoAccess +
 * getProjectCredentialHealth) + PR/branch rows from task_projections.
 * Actions (POST + CSRF, toast copy computed server-side per phase-5
 * pattern): `reconcile` → reconcileProject, `grant-scope` →
 * revalidateProjectCredential. Every degraded GitHub state is a typed value
 * rendered as honest copy — never a crash.
 */

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const db = getDb();
  const view = await getGithubViewData(db, params.slug);
  if (!view) {
    throw data(`No project at projects/${params.slug}.`, { status: 404 });
  }
  return { view };
}

export async function action({ request, params }: Route.ActionArgs) {
  const ctx = await requireAuth(request);
  const db = getDb();
  const formData = await request.formData();
  await assertCsrf(request, ctx.sessionId, formData);
  const actor = { userId: ctx.user.id, label: ctx.user.email };
  const intent = String(formData.get("intent") ?? "");

  // RBAC (the phase-7-core services carry no role checks of their own):
  // reconcile = any non-viewer member; grant-scope = credential/policy
  // change, admin|maintainer only (conventions + contracts §3.2).
  const myRole =
    listProjectMembers(db, params.slug).find((m) => m.userId === ctx.user.id)
      ?.role ?? null;

  try {
    if (intent === "reconcile") {
      if (!myRole || myRole === "viewer") {
        return data(
          {
            ok: false as const,
            error: "Only project members can reconcile with GitHub.",
          },
          { status: 403 },
        );
      }
      return await runReconcile(db, params.slug, actor);
    }
    if (intent === "grant-scope") {
      if (myRole !== "admin" && myRole !== "maintainer") {
        return data(
          {
            ok: false as const,
            error:
              "Only project admins and maintainers can re-check the credential.",
          },
          { status: 403 },
        );
      }
      return await runGrantScope(db, params.slug, actor);
    }
    return data(
      { ok: false as const, error: "Unknown action." },
      { status: 400 },
    );
  } catch (error) {
    if (isAppError(error)) {
      return data(
        { ok: false as const, error: error.userMessage },
        { status: error.status },
      );
    }
    throw error;
  }
}

export default function GithubView({ loaderData }: Route.ComponentProps) {
  const layout = useRouteLoaderData<typeof projectLoader>("routes/project");
  return (
    <GithubViewPage data={loaderData.view} myRole={layout?.myRole ?? null} />
  );
}
