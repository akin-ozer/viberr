import { data, Outlet, useMatches, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/project";
import type { loader as rootLoader } from "../root";
import { requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { getBoard } from "~/server/projections/board-query.server";
import {
  countUnreadNotifications,
  listNotifications,
} from "~/server/projections/notifications.server";
import { countOpenPolicyViolations } from "~/server/projections/policy-violations.server";
import { resolveStageRoles } from "~/shared/workflow/stage-roles";
import { sseScopes } from "~/features/live-updates/event-types";
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

export function meta({ data }: Route.MetaArgs) {
  return [{ title: data ? `${data.board.project.name} · Viberr` : "Viberr" }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const db = getDb();
  const board = getBoard(db, params.slug);
  if (!board) {
    throw data(`No project at projects/${params.slug}.`, { status: 404 });
  }
  const tasks = [...board.columns.flatMap((c) => c.tasks), ...board.orphanTasks];
  const myRole =
    board.members.find((m) => m.userId === user.id)?.role ?? null;
  return {
    user,
    board,
    myRole,
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
  const openTask = taskMatch?.data
    ? (taskMatch.data as { task: { key: string; title: string } }).task
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
      <Rail
        projectSlug={board.project.slug}
        projectName={board.project.name}
        projectRepo={board.project.repo}
        membersCount={board.members.length}
        boardCount={loaderData.taskCount}
        reviewCount={loaderData.reviewCount}
        violations={loaderData.violations}
      />
      <div className="main">
        <Topbar
          projectSlug={board.project.slug}
          projectName={board.project.name}
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
        <Outlet />
      </div>
    </div>
  );
}
