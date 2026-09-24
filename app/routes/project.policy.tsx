import { revalidateWhen } from "~/features/live-updates/revalidation-policy";
import { data, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/project.policy";
import { pageTitle } from "~/shared/page-title";
import { requireVisibleProject } from "./project-visibility.server";
import type { loader as projectLoader } from "./project";
import {
  appErrorResponse,
  requireFormAction,
} from "~/server/auth/form-action.server";
import { requireProjectMember } from "~/server/auth/require-project.server";
import { getDb } from "~/server/db/sqlite.server";
import {
  setMemberRole,
  setTransitionBoundary,
  setGuardrail,
} from "~/features/policy/policy-actions.server";
import { getPolicyViewData } from "~/features/policy/policy-query.server";
import { PolicyPage } from "~/features/policy/policy-page";

/**
 * /projects/:slug/policy — the governance surface (policy spec), replacing
 * the phase-4 placeholder. Loader: members + roles (canonical membership
 * store), workflow transitions, the assembled agent-profile roster (shared
 * with Agents) and the audit-derived last-change chip. Actions (POST +
 * CSRF): `set-role` (last-admin guard server-side) and `set-boundary`
 * (review→done hard-locked human). Both admin-gated inside the action
 * functions; toast copy is computed server-side (phase-5 pattern).
 */

/** D32-3: "<Page> · <project> · Viberr" — this view used to inherit the bare
 *  project title from the workspace layout. */
export function meta({ params }: Route.MetaArgs) {
  return [{ title: pageTitle("Policy", params.slug) }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  // R15-4 on THIS loader, not only the layout's (F19-28): single-fetch honors a
  // client-supplied `?_routes=` filter, so
  // `GET /projects/<slug>/policy.data?_routes=routes/project.policy` runs this
  // loader ALONE and the layout's membership refusal never executes. The guard
  // answers a non-member with the byte-identical unknown-slug 404 — a 403 here
  // would confirm the project exists (WI-13).
  await requireProjectMember(request, params.slug, "view this project's policy");
  const db = getDb();
  const view = getPolicyViewData(db, params.slug);
  if (!view) {
    throw data(`No project at projects/${params.slug}.`, { status: 404 });
  }
  return { view };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { refused, db, formData, actor, intent } = await requireFormAction(request);
  if (refused) return refused;
  // R15-4: this action runs WITHOUT the layout loader's membership gate
  // (React Router does not run parent loaders for a child action), so refuse a
  // non-member here with the same unknown-slug 404 the loader gives.
  requireVisibleProject(db, params.slug, actor, "change this project's policy");

  try {
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
    if (intent === "set-guardrail") {
      // E32-6: the Guardrails card's one write (toggle / value / remove).
      const result = await setGuardrail(
        db,
        {
          projectSlug: params.slug,
          id: String(formData.get("id") ?? ""),
          op: String(formData.get("op") ?? ""),
          value: String(formData.get("value") ?? ""),
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
    return appErrorResponse(error);
  }
}

export default function PolicyView({ loaderData }: Route.ComponentProps) {
  const layout = useRouteLoaderData<typeof projectLoader>("routes/project");
  return (
    <PolicyPage
      data={loaderData.view}
      projectSlug={layout?.project.slug ?? ""}
      myRole={layout?.myRole ?? null}
    />
  );
}

/** Ruling 457: when this loader re-runs (`revalidation-policy.ts`). */
export const shouldRevalidate = revalidateWhen("routes/project.policy");
