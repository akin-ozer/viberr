import { data, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/project.board";
import type { loader as projectLoader } from "./project";
import { requireAuth } from "~/server/auth/require-user.server";
import { assertCsrf } from "~/server/auth/csrf.server";
import { getDb } from "~/server/db/sqlite.server";
import { isAppError } from "~/server/errors/app-error.server";
import { rescanProjections } from "~/server/projections/rescan.server";
import { getProject } from "~/server/projections/board-query.server";
import { createTask, transitionStage } from "~/server/tasks/task-actions.server";
import { BoardPage } from "~/features/board/board-page";

/**
 * Board view (board spec). Data comes from the workspace layout loader
 * (routes/project) — one query feeds the rail counts AND the columns, and
 * every action here revalidates both. Actions: create-task (phase-3
 * createTask, RBAC inside), rescan (reconcile file store ↔ projections).
 * No optimistic UI for governed state — revalidation shows the new card.
 */

export async function action({ request, params }: Route.ActionArgs) {
  const ctx = requireAuth(request);
  const db = getDb();
  const formData = await request.formData();
  await assertCsrf(request, ctx.sessionId, formData);
  const actor = { userId: ctx.user.id, label: ctx.user.email };
  const intent = String(formData.get("intent") ?? "");

  try {
    if (intent === "create-task") {
      const result = await createTask(
        db,
        {
          projectSlug: params.slug,
          title: String(formData.get("title") ?? ""),
          goal: String(formData.get("goal") ?? ""),
          stageId: String(formData.get("stage") ?? "") || undefined,
        },
        actor,
      );
      return {
        ok: true as const,
        key: result.key,
        stageName: result.stageName,
      };
    }
    if (intent === "transition") {
      // Manual stage move from a board card's stage dropdown (admin|maintainer;
      // server re-checks). `manual` allows moving to any stage; the governed
      // **Transition:** timeline comment + operator hand-off still fire.
      const task = await transitionStage(
        db,
        {
          projectSlug: params.slug,
          taskKey: String(formData.get("taskKey") ?? ""),
          toStageId: String(formData.get("to") ?? ""),
          manual: true,
        },
        actor,
      );
      const proj = getProject(db, params.slug);
      const toName =
        proj?.stages.find((s) => s.id === task.stage)?.name ?? task.stage;
      return {
        ok: true as const,
        key: task.key,
        stage: task.stage,
        toast: `Moved ${task.key} to ${toName}`,
      };
    }
    if (intent === "rescan") {
      const summary = rescanProjections(db, { actor });
      return { ok: true as const, ...summary };
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

export default function Board() {
  const layout = useRouteLoaderData<typeof projectLoader>("routes/project");
  if (!layout) return null;
  const canCreate = layout.myRole !== null && layout.myRole !== "viewer";
  const canTransition =
    layout.myRole === "admin" || layout.myRole === "maintainer";
  return (
    <BoardPage
      columns={layout.board.columns}
      orphanTasks={layout.board.orphanTasks}
      canCreate={canCreate}
      canTransition={canTransition}
    />
  );
}
