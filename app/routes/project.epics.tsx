import { revalidateWhen } from "~/features/live-updates/revalidation-policy";
import { data, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/project.epics";
import type { loader as projectLoader } from "./project";
import { pageTitle } from "~/shared/page-title";
import { requireUser } from "~/server/auth/require-user.server";
import { appErrorResponse } from "~/server/auth/form-action.server";
import { getDb } from "~/server/db/sqlite.server";
import { createEpic } from "~/server/tasks/epic-actions.server";
import { archiveEpicTasks } from "~/server/tasks/epic-archive.server";
import { roleCan } from "~/shared/rbac";
import { EpicsPage } from "~/features/epics/epics-page";
import { getEpicsPage } from "~/features/epics/epics-query.server";
import { epicFormFields } from "~/features/epics/epic-form.server";
import { requireProjectFormAction } from "./project-visibility.server";
import { readWorkspace } from "./project-workspace.server";

/**
 * /projects/:slug/epics — the project's epics (ruling 325): each with its
 * status, progress, lead and target date, and New epic. Actions:
 * create-epic (`createEpic`, `manage-epics` inside) · archive-epic-tasks
 * (`archiveEpicTasks`, ruling 274: a Done epic's tasks, `approve-transition`
 * inside).
 */

export function meta({ params }: Route.MetaArgs) {
  return [{ title: pageTitle("Epics", params.slug) }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const db = getDb();
  // R15-4 on THIS loader too (F19-28): the layout's byte-identical refusal,
  // before any read below, and the same workspace read it made.
  const workspace = readWorkspace(request, db, params.slug, user);
  return getEpicsPage(db, params.slug, workspace);
}

export async function action({ request, params }: Route.ActionArgs) {
  const { refused, db, formData, actor, intent } = await requireProjectFormAction(request, params.slug);
  if (refused) return refused;
  try {
    if (intent === "create-epic") {
      const fields = epicFormFields(formData);
      const result = await createEpic(
        db,
        { ...fields, projectSlug: params.slug, title: fields.title ?? "" },
        actor,
      );
      return { ok: true as const, epicId: result.epic.id, toast: result.message };
    }
    if (intent === "archive-epic-tasks") {
      const result = await archiveEpicTasks(
        db,
        { projectSlug: params.slug, epicId: String(formData.get("epicId") ?? "") },
        actor,
      );
      return { ok: true as const, toast: result.message };
    }
    return data({ ok: false as const, error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return appErrorResponse(error);
  }
}

export default function Epics({ loaderData, params }: Route.ComponentProps) {
  const layout = useRouteLoaderData<typeof projectLoader>("routes/project");
  if (!layout) return null;
  return (
    <EpicsPage
      projectSlug={params.slug}
      epics={loaderData.epics}
      stages={loaderData.stages}
      members={loaderData.members}
      canManage={roleCan(layout.myRole, "manage-epics") && !layout.project.archived}
      canArchive={roleCan(layout.myRole, "approve-transition") && !layout.project.archived}
    />
  );
}

/** Ruling 11: when this loader re-runs (`revalidation-policy.ts`). */
export const shouldRevalidate = revalidateWhen("routes/project.epics");
