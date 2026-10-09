import { revalidateWhen } from "~/features/live-updates/revalidation-policy";
import { useEffect, useState } from "react";
import { pageTitle } from "~/shared/page-title";
import {
  Outlet,
  useLocation,
  useRouteLoaderData,
} from "react-router";
import type { Route } from "./+types/project";
import type { loader as taskLoader } from "./project.task";
import type { loader as rootLoader } from "../root";
import { requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { bellCounts } from "~/server/projections/notifications.server";
import { countOpenPolicyViolations } from "~/server/projections/policy-violations.server";
import { roleCan } from "~/shared/rbac";
import { readWorkspace } from "./project-workspace.server";
import { isArchived } from "~/features/board/board-filters";
import { sseScopes } from "~/features/live-updates/event-types";
import { Icon } from "~/ui/icon";
import { SkipLink } from "~/ui/skip-link";
import { useLiveUpdates } from "~/features/live-updates/use-live-updates";
import { Rail } from "~/features/shell/rail";
import {
  LivePausedStrip,
  Topbar,
  WORKSPACE_PAUSED_SENTENCE,
} from "~/features/shell/topbar";
import { WORKSPACE_FONT_PRELOADS } from "~/features/shell/font-preloads";

/**
 * Workspace shell layout for /projects/:slug (shell spec): rail with live
 * counts + topbar + child view Outlet. Children read this loader's data via
 * useRouteLoaderData("routes/project"): the viewer, the project's shell slice,
 * its members and the viewer's role. Ruling 11 (BOARD-6): the board's columns
 * are the board route's own loader (routes/project.board.tsx); both read the
 * project through `readWorkspace`, once per request.
 *
 * Rail counts: board = ALL LIVE tasks incl. Done (ruling 295), review = the
 * review queue's own `total` (U35-5, pass 35: the queue's membership is no
 * longer one stage id — review work at Validation with an open PR counts too —
 * so the badge reads the queue instead of re-deriving a stage filter that had
 * drifted from it), settings = open policy violations (Phase-4 derivation — see
 * policy-violations.server.ts).
 *
 * F19-9 (pass 19): "live" is the load-bearing word. `getBoardWithTasks` loads with
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
 * Done tasks stay counted: that half is ruling 295 and deliberate.
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
    { title: pageTitle(loaderData?.project.name) },
  ];
}

// Ruling 11: the rail, crumbs and board chrome draw at 500 on first paint.
export const links: Route.LinksFunction = () => WORKSPACE_FONT_PRELOADS;

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const db = getDb();
  // R15-4: the membership refusal (the unknown-slug 404) comes first, inside
  // `readWorkspace`, before any viewer-scoped projection work.
  const workspace = readWorkspace(request, db, params.slug, user);
  const { board, memberRole, orgAdminOverride, reviewQueue } = workspace;
  // F19-9: the SAME predicate the board header and the review queue use — an
  // archived task is a terminal disposition, not work waiting at a boundary.
  const liveTasks = workspace.tasks.filter((t) => !isArchived(t));
  const myRole = memberRole ?? (orgAdminOverride ? ("admin" as const) : null);
  const { project } = board;
  return {
    user,
    // Ruling 11 (BOARD-6): the shell's slice of the project. The columns are
    // the board route's own loader; every page under this layout used to
    // compute and ship them on every revalidation.
    project: {
      slug: project.slug,
      name: project.name,
      repo: project.repo,
      archived: project.archived,
    },
    // The task page's assignees and mention chips, the rail's member count.
    members: board.members,
    myRole,
    orgAdminOverride,
    taskCount: liveTasks.length,
    // U35-5: the queue's own count. It already answers the archived-project
    // case with 0 (F25-2 / D-1: an archived project has no review boundary) and
    // excludes archived tasks (F19-9), so the badge and the list it opens are
    // one number by construction, not by two predicates kept in step.
    reviewCount: reviewQueue.total,
    violations: countOpenPolicyViolations(db, params.slug),
    // Ruling 300 (FL-4 / SRV-6): the bell's counts; the bell loads its own
    // list when it is wanted, instead of every revalidation shipping it.
    ...bellCounts(db, user.id),
  };
}

/**
 * Pass-19 UX coherence audit, finding #15 — the archived banner used to tell
 * EVERY reader to "restore it from Settings → Danger zone". Q-V1 (pass-18 owner
 * ruling; `SettingsPage`'s `DangerZone` gate in
 * project-settings/settings-page.tsx) renders that panel only when the reader
 * holds `edit-policy`, so a maintainer, contributor or viewer followed an exact
 * named path to a panel that is not on their Settings page — and nothing
 * anywhere told them who CAN restore it. Name the route only to the reader
 * who has it; everyone else gets the authority instead,
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
  const { user, project } = loaderData;
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const taskData = useRouteLoaderData<typeof taskLoader>("routes/project.task");
  const openTask = taskData ? taskData.task : null;

  // Live updates (Phase 6): ONE stream per tab for the whole workspace
  // shell. `project:` covers board columns + rail counts + violations,
  // `user` covers the bell (notification.created is user-targeted; the
  // badge updates silently — shell spec defines no incoming-notification
  // toast), and the open task adds its own `task:` scope (task-detail
  // brief) — any matching event revalidates layout + child loaders, except a
  // run's console line: that revalidates nothing, and goes to the open task's
  // console through this same stream (`onLiveFrame`, ruling 11: the tab's one
  // live connection).
  const slug = project.slug;
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
  // `railOpen` is only ever set under the mobile breakpoint, but nothing
  // un-sets it when the viewport grows past it — and with <main inert> that
  // would be a page nobody can click, with no scrim or toggle on screen. A
  // resize (rotation is the real one; the drawer has no inputs, so the soft
  // keyboard cannot cause it) closes it. Not a viewport READ (R19-12).
  useEffect(() => {
    if (!railOpen) return;
    const close = () => setRailOpen(false);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [railOpen]);
  // The controller dock is mounted by root.tsx as a SIBLING of this layout, so
  // no selector under `.app` can reach it and `inert` on <main> does not cover
  // it. The body carries the drawer state for the dock's sake (app.css
  // `body[data-rail-open]`), so the trigger leaves the tab order and the scrim
  // wins the tap while the drawer is up.
  useEffect(() => {
    if (!railOpen) return;
    document.body.dataset.railOpen = "true";
    return () => {
      delete document.body.dataset.railOpen;
    };
  }, [railOpen]);

  return (
    <div className="app" data-rail-open={railOpen ? "true" : "false"}>
      {/* UI-12: bypass block — the rail + topbar sit ahead of the content on
          every workspace navigation and there was no way past them. */}
      <SkipLink inert={railOpen} />
      <Rail
        open={railOpen}
        projectSlug={project.slug}
        projectName={project.name}
        projectRepo={project.repo}
        membersCount={loaderData.members.filter((m) => !m.missing).length}
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
      {/* F8 (interface review 2026-09-06): while the drawer is open the page
          behind it is inert, so Tab stays inside the rail; the scrim, Escape
          and a rail link are the ways out. The toggle lives in here too, which
          is why topbar.tsx restores focus to it in an effect, after this
          attribute is gone. */}
      <main className="main" inert={railOpen}>
        <Topbar
          projectSlug={project.slug}
          projectName={project.name}
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
          unread={loaderData.unread}
          orphanUnread={loaderData.orphanUnread}
          livePaused={live.paused}
          railOpen={railOpen}
          onToggleRail={() => setRailOpen((open) => !open)}
        />
        {/* Interface review 2026-09-24 (layo-10): under the header, not in
            its fixed-height row, where it pushed the bell and account menu
            off a phone-width screen. */}
        {live.paused ? (
          <LivePausedStrip
            message={WORKSPACE_PAUSED_SENTENCE}
            onReconnect={live.reconnect}
          />
        ) : null}
        {project.archived ? (
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

/** Ruling 11: when this loader re-runs (`revalidation-policy.ts`). */
export const shouldRevalidate = revalidateWhen("routes/project");
