import { data, Outlet, useMatches, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/project";
import type { loader as rootLoader } from "../root";
import { requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { getBoard } from "~/server/projections/board-query.server";
import { decisionsRequiring } from "~/server/projections/decisions.server";
import {
  countUnreadNotifications,
  listNotifications,
} from "~/server/projections/notifications.server";
import { countOpenPolicyViolations } from "~/server/projections/policy-violations.server";
import { getReviewQueue } from "~/server/projections/review-queue.server";
import type { TaskSummary } from "~/shared/mapping/task.server";
import { resolveStageRoles } from "~/shared/workflow/stage-roles";
import { sseScopes } from "~/features/live-updates/event-types";
import { Icon } from "~/ui/icon";
import { SkipLink } from "~/ui/skip-link";
import { useLiveUpdates } from "~/features/live-updates/use-live-updates";
import { Rail } from "~/features/shell/rail";
import { Topbar } from "~/features/shell/topbar";

/**
 * Workspace shell layout for /projects/:slug (shell spec): rail with live
 * counts + topbar + child view Outlet. Children read this loader's data via
 * useRouteLoaderData("routes/project").
 *
 * Rail counts: board = ALL tasks incl. Done (ruling 16), review = tasks in
 * the literal "review" stage, settings = open policy violations (Phase-4
 * derivation — see policy-violations.server.ts).
 */

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    { title: loaderData ? `${loaderData.board.project.name} · Viberr` : "Viberr" },
  ];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const db = getDb();
  const raw = getBoard(db, params.slug);
  if (!raw) {
    throw data(`No project at projects/${params.slug}.`, { status: 404 });
  }
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
  const myDecisions = new Set([
    ...decisionsRequiring(db, user.id, { projectSlug: params.slug }).mine.map(
      (d) => d.taskKey,
    ),
    ...getReviewQueue(db, params.slug, { viewerUserId: user.id }).ready.map(
      (r) => r.key,
    ),
  ]);
  const annotate = (t: TaskSummary): TaskSummary => ({
    ...t,
    waitingOnMe: myDecisions.has(t.key),
  });
  const board = {
    ...raw,
    columns: raw.columns.map((c) => ({ ...c, tasks: c.tasks.map(annotate) })),
    orphanTasks: raw.orphanTasks.map(annotate),
  };
  const tasks = [...board.columns.flatMap((c) => c.tasks), ...board.orphanTasks];
  const memberRole =
    board.members.find((m) => m.userId === user.id)?.role ?? null;
  // D2 (R7-1): an ORG admin holds audited emergency project-admin authority on
  // every project. When they view a project they're NOT a member of, the UI
  // unlocks the admin affordances the server would grant anyway (each use is
  // audited server-side as `project.org_admin.override`) and the topbar shows
  // an honest "org-admin override" pill instead of silently pretending
  // membership. `user.role` is the session's resolved org role.
  const orgAdminOverride = memberRole === null && user.role === "admin";
  const myRole = memberRole ?? (orgAdminOverride ? ("admin" as const) : null);
  return {
    user,
    board,
    myRole,
    orgAdminOverride,
    taskCount: tasks.length,
    reviewCount: (() => {
      const reviewId = resolveStageRoles(
        board.project.stages,
        board.project.workflow,
      ).reviewId;
      return reviewId
        ? tasks.filter((t) => t.stage === reviewId).length
        : 0;
    })(),
    violations: countOpenPolicyViolations(db, params.slug),
    notifications: listNotifications(db, user.id, { limit: 100 }),
    unread: countUnreadNotifications(db, user.id),
  };
}

export default function ProjectLayout({ loaderData }: Route.ComponentProps) {
  const { user, board } = loaderData;
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const matches = useMatches();
  const taskMatch = matches.find((m) => m.id === "routes/project.task");
  const openTask = taskMatch?.loaderData
    ? (taskMatch.loaderData as { task: { key: string; title: string } }).task
    : null;

  // Live updates (Phase 6): ONE stream per tab for the whole workspace
  // shell. `project:` covers board columns + rail counts + violations,
  // `user` covers the bell (notification.created is user-targeted; the
  // badge updates silently — shell spec defines no incoming-notification
  // toast), and the open task adds its own `task:` scope (task-detail
  // brief) — any matching event revalidates layout + child loaders.
  const slug = board.project.slug;
  useLiveUpdates(
    openTask
      ? [sseScopes.project(slug), sseScopes.task(slug, openTask.key), sseScopes.user()]
      : [sseScopes.project(slug), sseScopes.user()],
  );

  return (
    <div className="app">
      {/* UI-12: bypass block — the rail + topbar sit ahead of the content on
          every workspace navigation and there was no way past them. */}
      <SkipLink />
      <Rail
        projectSlug={board.project.slug}
        projectName={board.project.name}
        projectRepo={board.project.repo}
        membersCount={board.members.length}
        boardCount={loaderData.taskCount}
        reviewCount={loaderData.reviewCount}
        violations={loaderData.violations}
      />
      {/* UI-12: a real `main` landmark. The eight workspace routes rendered
          this as a bare <div>, so screen-reader users had no landmark to jump
          to (Home and org settings already used <main>). */}
      <main className="main" id="main-content" tabIndex={-1}>
        <Topbar
          projectSlug={board.project.slug}
          projectName={board.project.name}
          orgAdminOverride={loaderData.orgAdminOverride}
          openTask={openTask}
          user={{
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            avatarTone: user.avatarTone,
          }}
          theme={rootData?.theme ?? "system"}
          notifications={loaderData.notifications}
          unread={loaderData.unread}
        />
        {board.project.archived ? (
          <div className="archived-banner" role="status">
            <Icon name="lock" />
            <span>
              This project is <strong>archived</strong> — it’s read-only.
              Timelines and audit stay visible; restore it from{" "}
              <strong>Settings → Danger zone</strong> to make changes.
            </span>
          </div>
        ) : null}
        <Outlet />
      </main>
    </div>
  );
}
