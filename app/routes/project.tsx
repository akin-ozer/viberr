import { useEffect, useState } from "react";
import { pageTitle } from "~/shared/page-title";
import {
  data,
  Outlet,
  useLocation,
  useRouteLoaderData,
} from "react-router";
import type { Route } from "./+types/project";
import type { loader as taskLoader } from "./project.task";
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
import { roleCan } from "~/shared/rbac";
import { resolveStageRoles } from "~/shared/workflow/stage-roles";
import { isArchived } from "~/features/board/board-filters";
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
 * Rail counts: board = ALL LIVE tasks incl. Done (ruling 16), review = LIVE
 * tasks in the STRUCTURAL review stage (`resolveStageRoles`, not the stage
 * literally named "review"), settings = open policy violations (Phase-4
 * derivation — see policy-violations.server.ts).
 *
 * F19-9 (pass 19): "live" is the load-bearing word. `getBoard` loads with
 * `includeArchived: true` (the board's Archived filter is the only way back to
 * an archived task), and both badges used to count that raw list — while the
 * two surfaces they link to exclude archived work: the board header counts
 * `liveTasks` (board-page.tsx) and `getReviewQueue` goes through
 * `listProjectTasks`, which appends `AND archived = 0`. So the rail said
 * "Review 1" over a queue reading "0 tasks at the review boundary", and a
 * supervisor chasing the badge found nothing. R14-3 is explicit that archived
 * tasks "leave the board's default view and the review queue", and
 * review-queue.server.ts asserts the badge/queue parity as a contract, so the
 * archived predicate belongs here too — ONE predicate (`isArchived`), one count.
 * Done tasks stay counted: that half is ruling 16 and deliberate.
 *
 * R15-4 (owner ruling, 2026-07-28): projects are MEMBERS-ONLY. This loader is
 * the single chokepoint for every project surface — board, task detail and the
 * six config views are all its children — so the membership refusal lives here
 * and nowhere else. WI-13 secrecy wins over FR4's app-wide read: a non-member
 * gets the SAME 404 as a slug that does not exist, so the response can never
 * confirm a project's existence. Org admins keep access through the audited D2
 * override (the topbar shows the honest pill).
 */

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    { title: pageTitle(loaderData?.board.project.name) },
  ];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const db = getDb();
  const raw = getBoard(db, params.slug);
  if (!raw) {
    throw data(`No project at projects/${params.slug}.`, { status: 404 });
  }
  // R15-4: refuse BEFORE any viewer-scoped projection work — the decision and
  // review-queue scans below are per-viewer reads a non-member must never
  // trigger, and the message must stay byte-identical to the unknown-slug one.
  const memberRole =
    raw.members.find((m) => m.userId === user.id)?.role ?? null;
  // D2 (R7-1): an ORG admin holds audited emergency project-admin authority on
  // every project. When they view a project they're NOT a member of, the UI
  // unlocks the admin affordances the server would grant anyway (each use is
  // audited server-side as `project.org_admin.override`) and the topbar shows
  // an honest "org-admin override" pill instead of silently pretending
  // membership. `user.role` is the session's resolved org role.
  const orgAdminOverride = memberRole === null && user.role === "admin";
  if (memberRole === null && !orgAdminOverride) {
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
  // Gap 10: generic, so the columns keep the fields the activity projection
  // adds (`lastActivityAt`, `quiet`). Re-typing through `TaskSummary` erased
  // them from the type while the spread carried them at runtime — the feature
  // worked, but nothing downstream could see it in the type system.
  const annotate = <T extends TaskSummary>(t: T): T => ({
    ...t,
    waitingOnMe: myDecisions.has(t.key),
  });
  const board = {
    ...raw,
    columns: raw.columns.map((c) => ({ ...c, tasks: c.tasks.map(annotate) })),
    orphanTasks: raw.orphanTasks.map(annotate),
  };
  const tasks = [...board.columns.flatMap((c) => c.tasks), ...board.orphanTasks];
  // F19-9: the SAME predicate the board header and the review queue use — an
  // archived task is a terminal disposition, not work waiting at a boundary.
  const liveTasks = tasks.filter((t) => !isArchived(t));
  const myRole = memberRole ?? (orgAdminOverride ? ("admin" as const) : null);
  return {
    user,
    board,
    myRole,
    orgAdminOverride,
    taskCount: liveTasks.length,
    reviewCount: (() => {
      // F25-2 (pass 25): an ARCHIVED project has no review boundary — the server
      // refuses acceptance and `getReviewQueue` returns total 0 for it (D-1). The
      // rail badge must agree, or it shows "Review N" one click from a queue that
      // says "0 tasks · no review work in flight" (the F19-9 badge/queue-parity
      // class, recurring). Zero it for an archived project, same predicate.
      if (board.project.archived) return 0;
      const reviewId = resolveStageRoles(
        board.project.stages,
        board.project.workflow,
      ).reviewId;
      return reviewId
        ? liveTasks.filter((t) => t.stage === reviewId).length
        : 0;
    })(),
    violations: countOpenPolicyViolations(db, params.slug),
    notifications: listNotifications(db, user.id, { limit: 100 }),
    unread: countUnreadNotifications(db, user.id),
  };
}

/**
 * Pass-19 UX coherence audit, finding #15 — the archived banner used to tell
 * EVERY reader to "restore it from Settings → Danger zone". Q-V1 (pass-18 owner
 * ruling, project-settings/settings-page.tsx:1596) renders that panel only when
 * the reader holds `edit-policy`, so a maintainer, contributor or viewer
 * followed an exact named path to a panel that is not on their Settings page —
 * and nothing anywhere told them who CAN restore it (the in-panel deny note is
 * unreachable, since the gate and the note test the same grant). Name the route
 * only to the reader who has it; everyone else gets the authority instead,
 * which is the same shape the four Settings lock notes already use.
 */
export function ArchivedBanner({ canRestore }: { canRestore: boolean }) {
  return (
    <div className="archived-banner" role="status">
      <Icon name="lock" />
      <span>
        This project is <strong>archived</strong>. It’s read-only. Timelines
        and audit stay visible;{" "}
        {canRestore ? (
          <>
            restore it from <strong>Settings → Danger zone</strong> to make
            changes.
          </>
        ) : (
          <>
            a <strong>project admin</strong> can restore it to make changes.
          </>
        )}
      </span>
    </div>
  );
}

export default function ProjectLayout({ loaderData }: Route.ComponentProps) {
  const { user, board } = loaderData;
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const taskData = useRouteLoaderData<typeof taskLoader>("routes/project.task");
  const openTask = taskData ? taskData.task : null;

  // Live updates (Phase 6): ONE stream per tab for the whole workspace
  // shell. `project:` covers board columns + rail counts + violations,
  // `user` covers the bell (notification.created is user-targeted; the
  // badge updates silently — shell spec defines no incoming-notification
  // toast), and the open task adds its own `task:` scope (task-detail
  // brief) — any matching event revalidates layout + child loaders.
  const slug = board.project.slug;
  // UI-03: `paused` is true once the stream has failed (an expired session 401s
  // and an EventSource never retries a failed connection) — the topbar says so.
  const live = useLiveUpdates(
    openTask
      ? [sseScopes.project(slug), sseScopes.task(slug, openTask.key), sseScopes.user()]
      : [sseScopes.project(slug), sseScopes.user()],
  );

  // F15-18: under the mobile breakpoint the 232px rail is an overlay behind a
  // topbar toggle, not a permanent column (at 375px it left the content ~140px
  // wide). Above the breakpoint CSS ignores this flag entirely — the rail is
  // always on screen, so there is nothing to open or close.
  const [railOpen, setRailOpen] = useState(false);
  const location = useLocation();
  // Following a rail link IS the reason the overlay was opened; leaving it up
  // over the view it just navigated to would hide the answer.
  useEffect(() => setRailOpen(false), [location.pathname]);

  return (
    <div className="app" data-rail-open={railOpen ? "true" : "false"}>
      {/* UI-12: bypass block — the rail + topbar sit ahead of the content on
          every workspace navigation and there was no way past them. */}
      <SkipLink />
      <Rail
        projectSlug={board.project.slug}
        projectName={board.project.name}
        projectRepo={board.project.repo}
        membersCount={board.members.filter((m) => !m.missing).length}
        boardCount={loaderData.taskCount}
        reviewCount={loaderData.reviewCount}
        violations={loaderData.violations}
      />
      {/* F15-18: dismiss layer for the mobile rail overlay. CSS keeps it out of
          the layout above the breakpoint AND while the rail is closed, so it can
          never swallow a click on the desktop shell.

          UI-C (inventory rough edge #15): this was a `<button aria-hidden="true"
          tabIndex={-1}>` — an interactive element hidden from assistive tech,
          which passes axe today only because the two attributes agree, and turns
          into an `aria-hidden-focus` violation the moment someone touches the
          tabIndex. A scrim is a POINTER affordance and nothing else, so it is a
          decorative div now: no role, no name, nothing to focus. The keyboard
          path is the one that was always the real one — the topbar toggle
          (`aria-expanded`) plus Escape, which `topbar.tsx` handles by closing
          the rail and returning focus to that toggle. */}
      <div
        className="rail-scrim"
        aria-hidden="true"
        onClick={() => setRailOpen(false)}
      />
      {/* UI-12: a real `main` landmark. The eight workspace routes rendered
          this as a bare <div>, so screen-reader users had no landmark to jump
          to (Home and org settings already used <main>). The skip TARGET is a
          sentinel BELOW the topbar (pass 30): focusing the <main> itself put
          the topbar's own 6+ tab stops still ahead of the content, so the
          "skip" only skipped the rail — Home's identical link skips its whole
          header. */}
      <main className="main">
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
          livePaused={live.paused}
          onReconnect={live.reconnect}
          railOpen={railOpen}
          onToggleRail={() => setRailOpen((open) => !open)}
        />
        {board.project.archived ? (
          <ArchivedBanner
            canRestore={roleCan(loaderData.myRole, "edit-policy")}
          />
        ) : null}
        <div id="main-content" tabIndex={-1} />
        <Outlet />
      </main>
    </div>
  );
}
