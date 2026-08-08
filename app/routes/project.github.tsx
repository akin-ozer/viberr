import { data, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/project.github";
import type { loader as projectLoader } from "./project";
import {
  appErrorResponse,
  requireFormAction,
} from "~/server/auth/form-action.server";
import { requireProjectMember } from "~/server/auth/require-project.server";
import { assertProjectAction } from "~/server/auth/project-authority.server";
import { requireVisibleProject } from "./project-visibility.server";
import { getDb } from "~/server/db/sqlite.server";
import {
  runClearCredential,
  runGrantScope,
  runReconcile,
  runSetCredential,
} from "~/features/github/github-actions.server";
import { getGithubViewData } from "~/features/github/github-query.server";
import {
  GithubViewPage,
  type ReconcileCheckView,
} from "~/features/github/github-view";
import { latestProjectReconcileCheckAt } from "~/server/audit/audit-query.server";
import { isReconcileStale } from "~/server/interpretation/freshness-policy.server";
import { formatRelative } from "~/shared/dates/format";
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
  // R15-4 on THIS loader, not only the layout's (F19-28): single-fetch honors a
  // client-supplied `?_routes=` filter, so
  // `GET /projects/<slug>/github.data?_routes=routes/project.github` runs this
  // loader ALONE and the layout's membership refusal never executes. The guard
  // answers a non-member with the byte-identical unknown-slug 404 — a 403 here
  // would confirm the project exists (WI-13).
  await requireProjectMember(request, params.slug, "view this project's GitHub surface");
  const db = getDb();
  const view = await getGithubViewData(db, params.slug);
  if (!view) {
    throw data(`No project at projects/${params.slug}.`, { status: 404 });
  }
  return { view, reconcileCheck: reconcileCheckView(db, params.slug) };
}

/**
 * F19-22 — the freshness chip's second fact.
 *
 * `view.reconcile` is `MAX(observed_at)` over `github.reconcile` PROVENANCE,
 * and DG-3 (github-reconciler.server.ts) deliberately skips that row when a
 * poller tick finds nothing new, so it is the last pass that CHANGED something.
 * Rendered as "Updated 3m ago" it claimed to be the last pass that RAN, and on
 * a quiet repository it drifted to hours while the poller was healthy.
 *
 * The last CHECK comes off the per-tick `github.reconcile.task` audit row
 * instead (unioned with the human sweep's `github.reconcile.project`, since a
 * poller tick writes only the former and a sweep over an all-terminal board
 * only the latter). It arrives BESIDE `view.reconcile` rather than inside it
 * because `getGithubViewData` builds the projection view and this is an audit
 * read — the same composition `routes/project.task.tsx` already does with
 * `githubReconciledAt`.
 *
 * Label and staleness are computed HERE, server-side, for the reason the
 * `view.reconcile` label is: both halves of the chip must render from one
 * loader payload, or SSR and hydration straddle a minute boundary and disagree.
 */
function reconcileCheckView(
  db: ReturnType<typeof getDb>,
  projectSlug: string,
): ReconcileCheckView {
  const at = latestProjectReconcileCheckAt(db, projectSlug);
  return {
    at,
    label: at && Number.isFinite(Date.parse(at)) ? formatRelative(at) : null,
    // Only meaningful when `at` is set — the view treats a null `at` as "no
    // check on record" and falls back to the change-based cue, which is the
    // only evidence of a pass it has left.
    stale: isReconcileStale(at),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { db, actor, intent } = await requireFormAction(request);

  // E2 (pass 16): the layout loader does not run for an action, so the
  // members-only gate is repeated here — otherwise a signed-in non-member got a
  // 403 that confirms the project exists while every other surface answered 404.
  requireVisibleProject(db, params.slug, actor, "act on this project");

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
    <GithubViewPage
      data={loaderData.view}
      reconcileCheck={loaderData.reconcileCheck}
      myRole={layout?.myRole ?? null}
    />
  );
}
