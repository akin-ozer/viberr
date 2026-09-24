import { revalidateWhen } from "~/features/live-updates/revalidation-policy";
import { data, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/project.board";
import { pageTitle } from "~/shared/page-title";
import type { loader as projectLoader } from "./project";
import { requireVisibleProject } from "./project-visibility.server";
import { readWorkspace } from "./project-workspace.server";
import { requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { readRepoHealth } from "~/server/github/repo-health.server";
import { decisionsRequiring } from "~/server/projections/decisions.server";
import { liveRunStateByTask } from "~/server/runtimes/run-store.server";
import { withLiveRun } from "~/shared/mapping/task.server";
import type { TaskActivitySummary } from "~/server/projections/board-query.server";
import { toBoardCard } from "~/features/board/board-card";
import {
  appErrorResponse,
  requireFormAction,
} from "~/server/auth/form-action.server";
import { rescanProject } from "~/server/projections/rescan.server";
import { assertProjectAction } from "~/server/auth/project-authority.server";
import {
  createTask,
  reorderTask,
  type CreateTaskInput,
} from "~/server/tasks/task-actions.server";
import { coercePriority } from "~/schemas/task-file.schema";
import { parseAcceptanceDisclosure } from "~/shared/acceptance-disclosure";
import { roleCan } from "~/shared/rbac";
import { BoardPage } from "~/features/board/board-page";

/**
 * Board view (board spec). The columns are this route's own loader (ruling
 * 454, BOARD-6: they used to ride the workspace layout, so every project page
 * shipped them); the rail counts stay in the layout, and both read the project
 * through `readWorkspace`, so one query per request still feeds the rail counts
 * AND the columns, and every action here revalidates both. Actions:
 * create-task (phase-3 createTask, RBAC inside), rescan (reconcile file store
 * ↔ projections). No optimistic UI for governed state — revalidation shows the
 * new card.
 */

/**
 * Ruling 88 (F21-2) — the acceptance disclosure a board POST carries, or `null`
 * when it carries none.
 *
 * `null` reaches the server rather than being swallowed here: it is the
 * difference between "an HTTP caller sent no acknowledgment" (refused — the
 * bare POST F21-2 found accepting silently) and "an in-process caller carries
 * its own contract" (omitted). The parsing itself — the field names, and the
 * strictness that reads a half-filled echo as no echo — is the ONE shared
 * definition in `~/shared/acceptance-disclosure`, which the ceremony writes
 * with; only the FormData read is local (as in routes/project.task).
 */
function acceptanceAck(formData: FormData) {
  return parseAcceptanceDisclosure((field) => String(formData.get(field) ?? ""));
}

/** D32-3: "<Page> · <project> · Viberr" — this view used to inherit the bare
 *  project title from the workspace layout. */
export function meta({ params }: Route.MetaArgs) {
  return [{ title: pageTitle("Board", params.slug) }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const db = getDb();
  // R15-4 on THIS loader too (F19-28): single fetch honors a client-supplied
  // `?_routes=` filter, so this loader can run without the layout's. The
  // refusal is the layout's own (`readWorkspace`), byte-identical 404, before
  // any viewer-scoped read below.
  const { board, reviewQueue } = readWorkspace(request, db, params.slug, user);
  // R8-3: annotate each task with whether an open decision here needs THIS
  // viewer's action (the single member-scoped source), so the board's
  // "Waiting on me" chip + per-card badge stop reading the project-wide
  // `waiting === "human"` enum. `waitingOnMe` is viewer-specific, so derive
  // fresh task objects instead of mutating the ones getBoard returned — a
  // future read-model cache in board-query.server must never let one viewer's
  // annotation leak into another's board (RU #11).
  // UI-48: the board's "waiting on me" and the review queue's "Waiting on your
  // acceptance" answered the same question differently — `decisionsRequiring`
  // only scans tasks that carry a packet or a recommendation, while the review
  // queue deliberately does NOT require a decision object (a review-stage task
  // waiting on a human can have no packet). A maintainer therefore saw VIB-142
  // under "Waiting on your acceptance" while the board's chip excluded it.
  // Union the two predicates here so both surfaces read one answer; the review
  // queue's `ready` list is already viewer-scoped by acceptance authority.
  // U35-5: the queue is read ONCE per request, with the layout's rail badge.
  const myDecisions = new Set([
    ...decisionsRequiring(db, user.id, { projectSlug: params.slug }).mine.map(
      (d) => d.taskKey,
    ),
    ...reviewQueue.ready.map((r) => r.key),
  ]);
  // Ruling 349: a card says "agent queued" for a run the cap parked; the fact
  // is on the run row, read once for the project.
  const liveRuns = liveRunStateByTask(db, params.slug);
  // Ruling 454 (BOARD-3): each card ships the fields the board reads
  // (`toBoardCard`), not the whole summary. Gap-10's `quiet` rides along.
  const card = (t: TaskActivitySummary) =>
    toBoardCard(
      withLiveRun({ ...t, waitingOnMe: myDecisions.has(t.key) }, liveRuns.get(t.key) ?? null),
    );
  return {
    columns: board.columns.map((c) => ({ stage: c.stage, tasks: c.tasks.map(card) })),
    orphanTasks: board.orphanTasks.map(card),
    // D3: the merge target the shared acceptance ceremony names when a board
    // move into the terminal stage is confirmed.
    defaultBranch: board.project.defaultBranch,
    // U33-2: the LAST recorded repository probe, never a fresh one — the board
    // is the surface people live on and it must not call GitHub to render. The
    // row is written where the answer was already known (project creation and
    // the GitHub page's cached probe); null means nothing has ever looked.
    repoAccess: readRepoHealth(db, params.slug)?.result ?? null,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const { refused, db, formData, actor, intent } = await requireFormAction(request);
  if (refused) return refused;
  // R15-4 / E2: React Router runs this action WITHOUT the layout loader, so the
  // membership gate has to be repeated here. Without it `create-task` answered a
  // signed-in non-member with the inner guard's 403 ("Only project members can
  // create tasks") while every other route and intent in the app answered 404 —
  // one reply that confirmed the project exists (WI-13). Outside the try so the
  // refusal stays a thrown 404 Response, byte-identical to the unknown-slug one.
  requireVisibleProject(db, params.slug, actor, "act on this project");

  try {
    if (intent === "create-task") {
      // Optional at creation; the board modal only sends it when non-default.
      // An unrecognized value from a hand-crafted POST coerces to undefined and
      // falls back to the "normal" default rather than failing the create.
      const createInput: CreateTaskInput = {
        projectSlug: params.slug,
        title: String(formData.get("title") ?? ""),
        goal: String(formData.get("goal") ?? ""),
        stageId: String(formData.get("stage") ?? "") || undefined,
      };
      const priority = coercePriority(String(formData.get("priority") ?? "").trim());
      if (priority) createInput.priority = priority;
      // Labels arrive comma/newline-separated; `createTask` normalizes them.
      const labelsRaw = String(formData.get("labels") ?? "");
      if (labelsRaw.trim()) {
        createInput.labels = labelsRaw
          .split(/[,\n]/)
          .map((l) => l.trim())
          .filter(Boolean);
      }
      // Due date is validated in `createTask` (blank ⇒ no due date).
      const dueDate = String(formData.get("dueDate") ?? "").trim();
      if (dueDate) createInput.dueDate = dueDate;
      const result = await createTask(db, createInput, actor);
      return {
        ok: true as const,
        key: result.key,
        stageName: result.stageName,
      };
    }
    if (intent === "reorder") {
      // Drag-and-drop reorder / move (admin|maintainer; server re-checks).
      // `beforeKey` is the card to land before (empty → end of column). A stage
      // change writes the **Transition:** comment; a same-stage reorder is quiet.
      const beforeRaw = String(formData.get("beforeKey") ?? "");
      const result = await reorderTask(
        db,
        {
          projectSlug: params.slug,
          taskKey: String(formData.get("taskKey") ?? ""),
          toStageId: String(formData.get("to") ?? ""),
          beforeKey: beforeRaw || null,
          // Ruling 88 (F21-2): a drop on the FINAL column is an acceptance —
          // the board's ceremony (ruling 53 / R18-7, the shared `AcceptConfirm`)
          // has said so on screen for three passes while this POST carried
          // nothing. The key rides on every reorder; `reorderTask` forwards it
          // to `transitionStage`, which consults it on the terminal branch
          // alone, so a rank write or an ordinary column move stays ack-free.
          // Absent fields ⇒ `null` ⇒ a drop on Done that skipped the dialog is
          // refused.
          ack: acceptanceAck(formData),
          // Ruling 381: why the card went BACK. The server requires it for a
          // backward manual move, whichever door the move came through.
          reason: String(formData.get("reason") ?? ""),
        },
        actor,
      );
      return {
        ok: true as const,
        key: result.task.key,
        stage: result.task.stage,
        // Honest copy (C4): dragging into Done is an ACCEPTANCE (merge attempt +
        // completion), not a bare move.
        toast: result.acceptedIntoDone
          ? `Accepted ${result.task.key}, moved to ${result.toName}`
          : result.movedStage
            ? `Moved ${result.task.key} to ${result.toName}`
            : `Reordered ${result.task.key}`,
      };
    }
    if (intent === "rescan") {
      // Re-scan reconciles THIS project's files with its projections — a
      // maintenance action, not a read. Gated by the canonical `rescan-project`
      // action (maintainer+, single-sourced in ACTION_ROLES + rendered on the
      // Policy table) so a viewer or non-member can't trigger it. The effect is
      // scoped to `params.slug` to match that project-scoped gate (F20): a
      // maintainer of one project can't rebuild every other project.
      assertProjectAction(db, "rescan-project", params.slug, actor, "re-scan the project");
      const summary = rescanProject(db, params.slug, { actor });
      return { ok: true as const, ...summary };
    }
    return data(
      { ok: false as const, error: "Unknown action." },
      { status: 400 },
    );
  } catch (error) {
    return appErrorResponse(error);
  }
}

export default function Board({ loaderData }: Route.ComponentProps) {
  const layout = useRouteLoaderData<typeof projectLoader>("routes/project");
  if (!layout) return null;
  // UI-58 again (E3): this was the one control left gated on a role LITERAL
  // (`!== "viewer"`) rather than the action id the server enforces — the exact
  // drift hazard the comment below names, three lines from the comment.
  const canCreate = roleCan(layout.myRole, "create-task");
  // UI-58: drag/move visibility must consult the SAME action id the server
  // enforces (`reorder-board`), not the `admin|maintainer` literal it happened
  // to equal — this file already uses `roleCan` for `rescan-project` for exactly
  // that reason, and the literal was a standing drift hazard.
  const canTransition = roleCan(layout.myRole, "reorder-board");
  // Re-scan visibility must track the server's `rescan-project` gate — not the
  // approve-transition gate — so display and enforcement can't drift (P11-45).
  const canRescan = roleCan(layout.myRole, "rescan-project");
  return (
    <BoardPage
      columns={loaderData.columns}
      orphanTasks={loaderData.orphanTasks}
      canCreate={canCreate}
      canTransition={canTransition}
      canRescan={canRescan}
      // D3: the merge target the shared acceptance ceremony names when a board
      // move into the terminal stage is confirmed (task-detail already reads the
      // same fact from the project record).
      defaultBranch={loaderData.defaultBranch}
      // U33-2: the remembered repository probe, so a project pointed at a
      // repository GitHub will not serve says so where the work happens instead
      // of only on its GitHub page.
      repoAccess={loaderData.repoAccess ?? undefined}
    />
  );
}

/** Ruling 454: when this loader re-runs (`revalidation-policy.ts`). */
export const shouldRevalidate = revalidateWhen("routes/project.board");
