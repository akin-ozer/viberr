import { useEffect, useRef, useState } from "react";
import {
  data,
  Outlet,
  useLocation,
  useMatches,
  useRouteLoaderData,
} from "react-router";
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
import { taskWaitsOnUser } from "~/shared/rbac";
import { sseScopes } from "~/features/live-updates/event-types";
import { useLiveUpdates } from "~/features/live-updates/use-live-updates";
import { Rail } from "~/features/shell/rail";
import { Topbar } from "~/features/shell/topbar";
import { useMediaQuery } from "~/features/shell/use-media-query";
import { ArchivedProjectBanner } from "~/ui/archived-badge";

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
  const board = getBoard(db, params.slug);
  if (!board) {
    throw data(`No project at projects/${params.slug}.`, { status: 404 });
  }
  const tasks = [...board.columns.flatMap((c) => c.tasks), ...board.orphanTasks];
  const projectRole =
    board.members.find((m) => m.userId === user.id)?.role ?? null;
  const orgAdminOverride = user.role === "admin" && projectRole !== "admin";
  const myRole = orgAdminOverride ? ("admin" as const) : projectRole;
  return {
    user,
    board,
    myRole,
    projectRole,
    orgAdminOverride,
    taskCount: tasks.length,
    reviewCount: (() => {
      const reviewId = resolveStageRoles(
        board.project.stages,
        board.project.workflow,
      ).reviewId;
      return reviewId
        ? tasks.filter(
            (t) =>
              t.stage === reviewId &&
              taskWaitsOnUser({
                waiting: t.waiting,
                viewerUserId: user.id,
                projectRole,
                ownerUserId:
                  t.owner?.kind === "human" ? t.owner.userId : null,
              }),
          ).length
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
  const location = useLocation();
  const mobile = useMediaQuery("(max-width: 760px)");
  const [railOpen, setRailOpen] = useState(false);
  const railToggleRef = useRef<HTMLButtonElement>(null);
  const canViewProtected =
    loaderData.projectRole !== null || loaderData.user.role === "admin";
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
  const liveStatus = useLiveUpdates(
    openTask
      ? [sseScopes.project(slug), sseScopes.task(slug, openTask.key), sseScopes.user()]
      : [sseScopes.project(slug), sseScopes.user()],
  );

  useEffect(() => {
    setRailOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!mobile) setRailOpen(false);
  }, [mobile]);

  const closeRail = () => {
    setRailOpen(false);
    railToggleRef.current?.focus();
  };

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
        orgAdminOverride={loaderData.orgAdminOverride}
        canViewProtected={canViewProtected}
        mobile={mobile}
        open={railOpen}
        onClose={closeRail}
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
          liveStatus={liveStatus}
          showRailToggle={mobile}
          railOpen={railOpen}
          onToggleRail={() => setRailOpen((value) => !value)}
          railToggleRef={railToggleRef}
        />
        {board.project.archived && (
          <ArchivedProjectBanner
            projectSlug={board.project.slug}
            canOpenSettings={canViewProtected}
          />
        )}
        <Outlet />
      </div>
    </div>
  );
}
