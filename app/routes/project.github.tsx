import { data, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/project.github";
import type { loader as projectLoader } from "./project";
import {
  appErrorResponse,
  requireFormAction,
} from "~/server/auth/form-action.server";
import { requireProjectMember } from "~/server/auth/require-project.server";
import { assertProjectAction } from "~/server/auth/project-authority.server";
import { getDb } from "~/server/db/sqlite.server";
import {
  runClearCredential,
  runGrantScope,
  runReconcile,
  runSetCredential,
} from "~/features/github/github-actions.server";
import { getGithubViewData } from "~/features/github/github-query.server";
import { GithubViewPage } from "~/features/github/github-view";
import type { RbacAction } from "~/shared/rbac";

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
  await requireProjectMember(request, params.slug, "view this project's GitHub surface");
  const db = getDb();
  const view = await getGithubViewData(db, params.slug);
  if (!view) {
    throw data(`No project at projects/${params.slug}.`, { status: 404 });
  }
  return { view };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { db, actor, intent } = await requireFormAction(request);

  // RBAC — the single guard path (project-authority.server) consulting the
  // ACTION_ROLES source (rbac.ts), never a hardcoded role string, so the
  // Policy page and this guard can never drift (pass-4 XS-10); org admins pass
  // as the audited D2 override. reconcile = `reconcile-github` (maintainer+,
  // R8-4); credential changes = `grant-github-scope` (maintainer+). The archived
  // read-only gate IS enforced (R8-5): a frozen project can't reconcile or
  // rotate/clear its credential — restore it first.
  const requireGithubAction = (action: RbacAction, what: string) =>
    assertProjectAction(db, action, params.slug, actor, what);

  try {
    if (intent === "reconcile") {
      requireGithubAction("reconcile-github", "reconcile with GitHub");
      return await runReconcile(db, params.slug, actor);
    }
    if (intent === "grant-scope") {
      requireGithubAction("grant-github-scope", "re-check the credential");
      return await runGrantScope(db, params.slug, actor);
    }
    // Attach/rotate + remove the project credential — same credential-change
    // RBAC as grant-scope (`grant-github-scope`, maintainer+).
    if (intent === "set-credential" || intent === "clear-credential") {
      requireGithubAction("grant-github-scope", "change the credential");
      return intent === "set-credential"
        ? await runSetCredential(db, params.slug, actor)
        : runClearCredential(db, params.slug, actor);
    }
    return data(
      { ok: false as const, error: "Unknown action." },
      { status: 400 },
    );
  } catch (error) {
    return appErrorResponse(error);
  }
}

export default function GithubView({ loaderData }: Route.ComponentProps) {
  const layout = useRouteLoaderData<typeof projectLoader>("routes/project");
  return (
    <GithubViewPage data={loaderData.view} myRole={layout?.myRole ?? null} />
  );
}
