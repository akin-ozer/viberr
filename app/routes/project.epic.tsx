import { revalidateWhen } from "~/features/live-updates/revalidation-policy";
import { data, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/project.epic";
import type { loader as projectLoader } from "./project";
import { pageTitle } from "~/shared/page-title";
import { requireUser } from "~/server/auth/require-user.server";
import { appErrorResponse, requireFormAction } from "~/server/auth/form-action.server";
import { getDb } from "~/server/db/sqlite.server";
import { setTasksEpic, updateEpic } from "~/server/tasks/epic-actions.server";
import { createTask } from "~/server/tasks/task-actions.server";
import { roleCan } from "~/shared/rbac";
import { EpicPage } from "~/features/epics/epic-page";
import { getEpicPage } from "~/features/epics/epics-query.server";
import { epicFormFields } from "~/features/epics/epic-form.server";
import { requireVisibleProject } from "./project-visibility.server";
import { readWorkspace } from "./project-workspace.server";

/**
 * /projects/:slug/epics/:epicId — one epic (ruling 503): what it is for, its
 * tasks and where each stands, its progress and its history. Actions (all
 * CSRF-checked, the grant checked inside each writer):
 *   update-epic (`manage-epics`) · add-tasks · remove-task (`edit-task-meta`)
 *   · create-task (`create-task`, in this epic from its first line)
 */

export function meta({ params, loaderData }: Route.MetaArgs) {
  return [{ title: pageTitle(loaderData?.epic.title ?? params.epicId, params.slug) }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const db = getDb();
  // R15-4: the layout's refusal first, from the read it already made.
  const workspace = readWorkspace(request, db, params.slug, user);
  return getEpicPage(db, params.slug, params.epicId, { workspace, viewer: user });
}

export async function action({ request, params }: Route.ActionArgs) {
  const { refused, db, formData, actor, intent } = await requireFormAction(request);
  if (refused) return refused;
  requireVisibleProject(db, params.slug, actor, "act on this project");
  try {
    switch (intent) {
      case "update-epic": {
        const result = await updateEpic(
          db,
          { ...epicFormFields(formData), projectSlug: params.slug, epicId: params.epicId },
          actor,
        );
        return { ok: true as const, toast: result.message };
      }
      case "add-tasks": {
        const taskKeys = String(formData.get("taskKeys") ?? "")
          .split(/[,\s]+/)
          .filter(Boolean);
        const result = await setTasksEpic(
          db,
          { projectSlug: params.slug, taskKeys, epicId: params.epicId },
          actor,
        );
        return { ok: true as const, toast: result.message };
      }
      case "remove-task": {
        const taskKey = String(formData.get("taskKey") ?? "");
        const result = await setTasksEpic(
          db,
          { projectSlug: params.slug, taskKeys: [taskKey], epicId: null, fromEpicId: params.epicId },
          actor,
        );
        return { ok: true as const, toast: result.message };
      }
      case "create-task": {
        const result = await createTask(
          db,
          {
            projectSlug: params.slug,
            title: String(formData.get("title") ?? ""),
            goal: String(formData.get("goal") ?? ""),
            epic: params.epicId,
          },
          actor,
        );
        return {
          ok: true as const,
          toast: `${result.key} created in ${result.stageName}, in ${params.epicId}.`,
        };
      }
      default:
        return data({ ok: false as const, error: "Unknown action." }, { status: 400 });
    }
  } catch (error) {
    return appErrorResponse(error);
  }
}

export default function Epic({ loaderData, params }: Route.ComponentProps) {
  const layout = useRouteLoaderData<typeof projectLoader>("routes/project");
  if (!layout) return null;
  // A read-only (archived) project offers no controls; the server refuses the
  // writes too.
  const open = !layout.project.archived;
  return (
    <EpicPage
      // Keyed by epic: moving between epics starts the dialogs and the
      // history's "Show all" over.
      key={loaderData.epic.id}
      view={loaderData}
      projectSlug={params.slug}
      canManage={open && roleCan(layout.myRole, "manage-epics")}
      canEditTasks={open && roleCan(layout.myRole, "edit-task-meta")}
      canCreateTask={open && roleCan(layout.myRole, "create-task")}
    />
  );
}

/** Ruling 457: when this loader re-runs (`revalidation-policy.ts`). */
export const shouldRevalidate = revalidateWhen("routes/project.epic");
