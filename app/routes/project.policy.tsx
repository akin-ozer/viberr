import { data, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/project.policy";
import type { loader as projectLoader } from "./project";
import { assertCsrf } from "~/server/auth/csrf.server";
import { requireAuth } from "~/server/auth/require-user.server";
import { requireProjectMember } from "~/server/auth/require-project.server";
import { getDb } from "~/server/db/sqlite.server";
import { isAppError } from "~/server/errors/app-error.server";
import {
  setMemberRole,
  setTransitionBoundary,
} from "~/features/policy/policy-actions.server";
import { getPolicyViewData } from "~/features/policy/policy-query.server";
import { PolicyPage } from "~/features/policy/policy-page";
import { assertProjectActive } from "~/server/projects/project-lifecycle.server";

/**
 * /projects/:slug/policy — the governance surface (policy spec), replacing
 * the phase-4 placeholder. Loader: members + roles (canonical membership
 * store), workflow transitions, the assembled agent-profile roster (shared
 * with Agents) and the audit-derived last-change chip. Actions (POST +
 * CSRF): `set-role` (last-admin guard server-side) and `set-boundary`
 * (review→done hard-locked human). Both admin-gated inside the action
 * functions; toast copy is computed server-side (phase-5 pattern).
 */

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireProjectMember(request, params.slug, "view this project's policy");
  const db = getDb();
  const view = getPolicyViewData(db, params.slug);
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
  const actor = {
    userId: ctx.user.id,
    label: ctx.user.email,
    orgRole: ctx.user.role,
  };
  const intent = String(formData.get("intent") ?? "");

  try {
    assertProjectActive(db, params.slug);
    if (intent === "set-role") {
      const result = await setMemberRole(
        db,
        {
          projectSlug: params.slug,
          targetUserId: String(formData.get("userId") ?? ""),
          role: String(formData.get("role") ?? ""),
        },
        actor,
      );
      return { ok: true as const, toast: result.toast };
    }
    if (intent === "set-boundary") {
      const result = await setTransitionBoundary(
        db,
        {
          projectSlug: params.slug,
          from: String(formData.get("from") ?? ""),
          to: String(formData.get("to") ?? ""),
          boundary: String(formData.get("boundary") ?? ""),
        },
        actor,
      );
      return { ok: true as const, toast: result.toast };
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

export default function PolicyView({ loaderData }: Route.ComponentProps) {
  const layout = useRouteLoaderData<typeof projectLoader>("routes/project");
  return (
    <PolicyPage
      data={loaderData.view}
      projectSlug={layout?.board.project.slug ?? ""}
      myRole={layout?.myRole ?? null}
      readOnly={Boolean(layout?.board.project.archived)}
    />
  );
}
