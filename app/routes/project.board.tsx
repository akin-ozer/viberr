import { data, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/project.board";
import { assertProjectActive } from "~/server/projects/project-lifecycle.server";
import type { loader as projectLoader } from "./project";
import { requireAuth } from "~/server/auth/require-user.server";
import { assertCsrf } from "~/server/auth/csrf.server";
import { getDb } from "~/server/db/sqlite.server";
import { isAppError } from "~/server/errors/app-error.server";
import { rescanProjections } from "~/server/projections/rescan.server";
import {
  createTask,
  reorderTask,
  requireProjectRoleAuthority,
} from "~/server/tasks/task-actions.server";
import { withProjectAuditAuthority } from "~/server/audit/audit-recorder.server";
import { BoardPage } from "~/features/board/board-page";

/**
 * Board view (board spec). Data comes from the workspace layout loader
 * (routes/project) — one query feeds the rail counts AND the columns, and
 * every action here revalidates both. Actions: create-task (phase-3
 * createTask, RBAC inside), rescan (reconcile file store ↔ projections).
 * No optimistic UI for governed state — revalidation shows the new card.
 */

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
        operatorTrigger: result.operatorTrigger,
      };
    }
    if (intent === "reorder") {
      // Drag-and-drop reorder / move (admin|maintainer; server re-checks).
      // `beforeKey` is the card to land before (empty → end of column). A stage
      // change writes the **Transition:** comment; a same-stage reorder is quiet.
      const beforeRaw = String(formData.get("beforeKey") ?? "");
      const requestedStage = String(formData.get("to") ?? "");
      const result = await reorderTask(
        db,
        {
          projectSlug: params.slug,
          taskKey: String(formData.get("taskKey") ?? ""),
          toStageId: requestedStage,
          beforeKey: beforeRaw || null,
        },
        actor,
      );
      return {
        ok: true as const,
        key: result.task.key,
        stage: result.task.stage,
        // Honest copy (C4): dragging into Done is an ACCEPTANCE (merge attempt +
        // completion), not a bare move.
        toast:
          result.task.pr?.state === "accepted" &&
          result.task.stage !== requestedStage
            ? `Completion accepted for ${result.task.key} · stays in Review until its PR is merged`
            : result.acceptedIntoDone
          ? `Accepted ${result.task.key} — moved to ${result.toName}`
          : result.movedStage
            ? `Moved ${result.task.key} to ${result.toName}`
            : `Reordered ${result.task.key}`,
      };
    }
    if (intent === "rescan") {
      // Re-scan rebuilds projections instance-wide — a maintenance action, not a
      // read. Gate it to this project's admins|maintainers (matrix "Run agents &
      // reorder the board" tier) so a viewer or non-member can't trigger a full
      // rebuild.
      const authority = requireProjectRoleAuthority(
        params.slug,
        actor,
        ["admin", "maintainer"],
        "re-scan the project",
      );
      const summary = rescanProjections(db, {
        actor: withProjectAuditAuthority(actor, authority.authoritySource),
        projectSlug: params.slug,
      });
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
  const archived = layout.board.project.archived;
  const canCreate =
    !archived && layout.myRole !== null && layout.myRole !== "viewer";
  const canTransition =
    !archived &&
    (layout.myRole === "admin" || layout.myRole === "maintainer");
  return (
    <BoardPage
      columns={layout.board.columns}
      orphanTasks={layout.board.orphanTasks}
      canCreate={canCreate}
      canTransition={canTransition}
      readOnly={archived}
      viewer={{
        userId: layout.user.id,
        projectRole: layout.projectRole,
      }}
    />
  );
}
