import { data, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/project.github";
import type { loader as projectLoader } from "./project";
import { assertCsrf } from "~/server/auth/csrf.server";
import { requireAuth } from "~/server/auth/require-user.server";
import { requireProjectMember } from "~/server/auth/require-project.server";
import { getDb } from "~/server/db/sqlite.server";
import { isAppError } from "~/server/errors/app-error.server";
import { listProjectMembers } from "~/server/projections/board-query.server";
import {
  runClearCredential,
  runGrantScope,
  runReconcile,
  runSetCredential,
} from "~/features/github/github-actions.server";
import { getGithubViewData } from "~/features/github/github-query.server";
import { GithubViewPage } from "~/features/github/github-view";
import { type RbacAction, roleCan } from "~/shared/rbac";

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
  const ctx = await requireAuth(request);
  const db = getDb();
  const formData = await request.formData();
  await assertCsrf(request, ctx.sessionId, formData);
  const actor = { userId: ctx.user.id, label: ctx.user.email };
  const intent = String(formData.get("intent") ?? "");

  // RBAC — consult the single ACTION_ROLES source (rbac.ts), never a hardcoded
  // role string, so the Policy page and this guard can never drift (pass-4
  // XS-10). reconcile = `reconcile-github` (contributor+); credential changes =
  // `grant-github-scope` (maintainer+).
  const myRole =
    listProjectMembers(db, params.slug).find((m) => m.userId === ctx.user.id)
      ?.role ?? null;
  const deny = (action: RbacAction, what: string) =>
    data(
      { ok: false as const, error: `Your role can't ${what}.` },
      { status: 403 },
    );

  try {
    if (intent === "reconcile") {
      if (!roleCan(myRole, "reconcile-github")) {
        return deny("reconcile-github", "reconcile with GitHub");
      }
      return await runReconcile(db, params.slug, actor);
    }
    if (intent === "grant-scope") {
      if (!roleCan(myRole, "grant-github-scope")) {
        return deny("grant-github-scope", "re-check the credential");
      }
      return await runGrantScope(db, params.slug, actor);
    }
    // Attach/rotate + remove the project credential — same credential-change
    // RBAC as grant-scope (`grant-github-scope`, maintainer+).
    if (intent === "set-credential" || intent === "clear-credential") {
      if (!roleCan(myRole, "grant-github-scope")) {
        return deny("grant-github-scope", "change the credential");
      }
      return intent === "set-credential"
        ? runSetCredential(db, params.slug, actor)
        : runClearCredential(db, params.slug, actor);
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
