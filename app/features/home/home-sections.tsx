import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { Link } from "react-router";
import type { ThemePreference } from "~/server/theme/theme-cookie.server";
import type { SessionUser } from "~/server/auth/require-user.server";
import { countLabel } from "~/shared/text/plural";
import { useModifierHint } from "~/ui/use-shortcut-hint";
import { Icon } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { useDialog } from "~/ui/use-dialog";
import { TopBell } from "~/features/shell/top-bell";
import { LivePausedStrip } from "~/features/shell/topbar";
import { UserMenu } from "~/features/shell/user-menu";
import type { HomeOrgSummary, HomeProjectCard } from "./home-query.server";
import {
  MemberStack,
  ProjectCard,
  ProjectRow,
  StarIco,
} from "./project-cards";

/**
 * The home page's own sections, top to bottom: header, hero, empty state, the
 * pinned/all/archived project groups, the org settings tiles and the admin
 * store strip (plus its rebuild confirm). Split out of `home-page.tsx` (pass
 * 16, pure structural refactor — no behaviour or copy change): state stays in
 * `HomePage` and flows down via explicit props, so the rendered DOM is
 * unchanged.
 */

const HOME_PAUSED_SENTENCE = "Live updates paused. Cards may be out of date.";

export function HomeTopBar({
  searchRef,
  query,
  onQuery,
  unread,
  orphanUnread,
  user,
  theme,
  livePaused = false,
  onReconnect,
  onOpenPalette,
}: {
  searchRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (q: string) => void;
  /** The bell's counts (`bellCounts`); the bell loads its own list (ruling 457). */
  unread: number;
  orphanUnread: number;
  user: SessionUser;
  theme: ThemePreference;
  /** UI-03: the SSE stream is down — the cards are a stale snapshot. */
  livePaused?: boolean;
  onReconnect?: () => void;
  /** R15-5: the shortcut chip is the palette's affordance, not decoration. */
  onOpenPalette: () => void;
}) {
  const modifierHint = useModifierHint();
  return (
    <header className="home-top">
      <div className="home-top-in">
        <button
          type="button"
          className="home-brand"
          onClick={() => window.scrollTo({ top: 0 })}
          title="Viberr"
        >
          <span className="mark">V</span>
          <b>Viberr</b>
        </button>
        {/* Ruling 149: `role="status"` replaced the button's own role, so the
            one control that can restart the stream was announced as a status
            sentence and never as something to press — and a status region is
            atomic, so it re-read the whole label. The sentence moves to an
            always-mounted announcer (the idiom at controller-dock.tsx and
            ui/label-input.tsx): a live region inserted together with its text
            is the one case screen readers skip.

            The sentence and the retry are then split the way the workspace
            header splits them (`shell/topbar.tsx`): a `.pill` has no cursor and
            no hover, so one element that was both read as neither, and with no
            `onReconnect` it was a button that did nothing. Both now sit in the
            strip under this row (layo-10, below). */}
        <span className="vh" role="status" aria-live="polite">
          {livePaused ? HOME_PAUSED_SENTENCE : ""}
        </span>
        <div className="top-search">
          <Icon name="search" />
          <input
            ref={searchRef}
            placeholder="Find a project…"
            aria-label="Find a project"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
          {/* R15-5: ⌘K no longer focuses this box — it opens the global
              palette — so the chip is the button that does that, not a label
              for a shortcut that goes somewhere else. UI-55: platform-aware,
              the handler accepts Ctrl too. */}
          <button
            type="button"
            className="kbd"
            aria-haspopup="dialog"
            aria-label="Search everything"
            title="Search tasks, branches, agents and projects"
            onClick={onOpenPalette}
            suppressHydrationWarning
          >
            {modifierHint}
          </button>
        </div>
        <TopBell unread={unread} orphanUnread={orphanUnread} />
        <UserMenu
          user={{
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            avatarTone: user.avatarTone,
          }}
          theme={theme}
        />
      </div>
      {/* Interface review 2026-09-24 (layo-10): the chip and Retry sat in the
          row above, which cannot wrap, and scrolled the page sideways at phone
          width. The strip stays inside the sticky header. */}
      {livePaused && (
        <LivePausedStrip
          message={HOME_PAUSED_SENTENCE}
          onReconnect={onReconnect}
        />
      )}
    </header>
  );
}

/**
 * UI-19: the loader computes the greeting from the SERVER's clock, so a user in
 * another timezone was told "Good evening" at 9am. The server value is kept as
 * the SSR text (no flash of empty heading) and corrected from the browser clock
 * on mount — the `<h1>` already carries `suppressHydrationWarning`.
 */
function useLocalGreeting(serverGreet: string): string {
  const [greet, setGreet] = useState(serverGreet);
  useEffect(() => {
    const hour = new Date().getHours();
    setGreet(
      hour < 12
        ? "Good morning"
        : hour < 18
          ? "Good afternoon"
          : "Good evening",
    );
  }, []);
  return greet;
}

export function HomeHero({
  greet,
  firstName,
  projectCount,
  totalRunning,
  activeIn,
  totalWaiting,
  view,
  onView,
  onNew,
}: {
  greet: string;
  firstName: string;
  projectCount: number;
  totalRunning: number;
  activeIn: number;
  totalWaiting: number;
  view: "grid" | "list";
  onView: (v: "grid" | "list") => void;
  onNew: () => void;
}) {
  const localGreet = useLocalGreeting(greet);
  return (
    <div className="home-hero">
      <div>
        <h1 suppressHydrationWarning>
          {localGreet}, {firstName}
        </h1>
        {/* UI-10: the copy (and the animated `.working` pulse dot) asserted
            activity even at zero — "Your agents kept working — •0 runs active".
            The zero case now reads as the quiet state it is, and the pulse dot
            renders only when something is actually running.

            P14-WL-04: "N decisions waiting on you" is counted across EVERY
            project this user belongs to, while a board header counts tasks in
            one project and the Agents page counts engagements — three numbers,
            three questions, near-identical copy. Each names its scope now. */}
        <p className="sub">
          {projectCount === 0 ? (
            "No projects yet. Create your first project below."
          ) : totalRunning === 0 ? (
            <>
              All quiet. No agent runs right now.{" "}
              {totalWaiting > 0 ? (
                <>
                  <b>{countLabel(totalWaiting, "decision")}</b>{" "}
                  waiting on you across all your projects.
                </>
              ) : (
                "Nothing is waiting on you in any of your projects."
              )}
            </>
          ) : (
            <>
              Your agents kept working:{" "}
              <b>
                <span className="working"></span>
                {countLabel(totalRunning, "run")} active
              </b>{" "}
              across {countLabel(activeIn, "project")},{" "}
              <b>{countLabel(totalWaiting, "decision")}</b>{" "}
              waiting on you across all your projects.
            </>
          )}
        </p>
      </div>
      {/* Zero projects: EmptyHero below carries the page's single primary CTA;
          a second identical "New project" up here plus a view toggle over a
          grid that does not exist read as chrome for content that is not
          there. */}
      {projectCount > 0 && (
      <div className="hero-actions">
        {/* UI-13: selection was conveyed by the `on` class alone — invisible to
            assistive tech. `aria-pressed` carries it now. */}
        <div className="seg" role="group" aria-label="View">
          <button
            type="button"
            className={view === "grid" ? "on" : ""}
            aria-pressed={view === "grid"}
            onClick={() => onView("grid")}
          >
            <Icon name="board" />
            Grid
          </button>
          <button
            type="button"
            className={view === "list" ? "on" : ""}
            aria-pressed={view === "list"}
            onClick={() => onView("list")}
          >
            <Icon name="review" />
            List
          </button>
        </div>
        <Link to="/controller" className="btn">
          <Icon name="cpu" />
          Controller
        </Link>
        <button type="button" className="btn primary" onClick={onNew}>
          <Icon name="plus" />
          New project
        </button>
      </div>
      )}
    </div>
  );
}

export function EmptyHero({ onNew }: { onNew: () => void }) {
  return (
    <div className="empty-hero" data-screen-label="Empty state">
      <span className="plus">
        <Icon name="plus" />
      </span>
      <h2>Create your first project</h2>
      <p>
        A project is one board, one repo, and a policy that decides what
        agents may do on their own, and what waits for you.
      </p>
      <div className="empty-steps">
        <span className="st">
          <span className="n">1</span>Connect a repository
        </span>
        <span className="st">
          <span className="n">2</span>Define workflow stages
        </span>
        <span className="st">
          <span className="n">3</span>Put agents under policy
        </span>
      </div>
      <button type="button" className="btn primary" onClick={onNew}>
        <Icon name="plus" />
        New project
      </button>
    </div>
  );
}

export function ProjectSections({
  view,
  stars,
  onStar,
  pinned,
  rest,
  archivedList,
  query,
  onNew,
}: {
  view: "grid" | "list";
  stars: Record<string, boolean>;
  onStar: (slug: string) => void;
  pinned: HomeProjectCard[];
  rest: HomeProjectCard[];
  archivedList: HomeProjectCard[];
  query: string;
  onNew: () => void;
}) {
  const renderGroup = (list: HomeProjectCard[]) =>
    view === "grid" ? (
      <div className="pj-grid">
        {list.map((p) => (
          <ProjectCard
            key={p.slug}
            p={p}
            starred={!!stars[p.slug]}
            onStar={onStar}
            repoAccess={p.repoAccess ?? undefined}
            showDesc
          />
        ))}
      </div>
    ) : (
      <div className="pj-list">
        {list.map((p) => (
          <ProjectRow
            key={p.slug}
            p={p}
            repoAccess={p.repoAccess ?? undefined}
            starred={!!stars[p.slug]}
            onStar={onStar}
          />
        ))}
      </div>
    );

  return (
    <>
      {pinned.length > 0 && (
        <section data-screen-label="Pinned projects">
          <div className="sec-h">
            <StarIco on />
            <h2>Pinned</h2>
            <span className="ct">{pinned.length}</span>
          </div>
          {renderGroup(pinned)}
        </section>
      )}
      <section data-screen-label="All projects">
        <div className="sec-h">
          <Icon name="board" />
          <h2>{pinned.length > 0 ? "Everything else" : "All projects"}</h2>
          <span className="ct">{rest.length}</span>
        </div>
        {/* UI-21: "no match" must account for the pinned group rendered above —
            it used to claim nothing matched while a matching pinned card was
            on screen. */}
        {rest.length === 0 && pinned.length === 0 && query ? (
          <div className="empty">No project matches “{query}”.</div>
        ) : rest.length === 0 && query ? (
          <div className="empty">
            Every match for “{query}” is pinned above.
          </div>
        ) : view === "grid" ? (
          <div className="pj-grid">
            {rest.map((p) => (
              <ProjectCard
                key={p.slug}
                p={p}
                starred={!!stars[p.slug]}
                onStar={onStar}
                repoAccess={p.repoAccess ?? undefined}
                showDesc
              />
            ))}
            {!query && (
              <button type="button" className="pj-new" onClick={onNew}>
                <span className="plus">
                  <Icon name="plus" />
                </span>
                New project
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="pj-list">
              {rest.map((p) => (
                <ProjectRow
                  key={p.slug}
                  p={p}
                  repoAccess={p.repoAccess ?? undefined}
                  starred={!!stars[p.slug]}
                  onStar={onStar}
                />
              ))}
            </div>
            {!query && (
              <button
                type="button"
                className="pj-new inline"
                onClick={onNew}
              >
                <span className="inline-row">
                  <Icon name="plus" />
                  New project
                </span>
              </button>
            )}
          </>
        )}
      </section>
      {archivedList.length > 0 && (
        <section data-screen-label="Archived projects">
          <div className="sec-h">
            <Icon name="board" />
            <h2>Archived</h2>
            <span className="ct">{archivedList.length}</span>
          </div>
          <p className="sub sec-lede">
            Hidden from the active workspace. A project admin can restore one
            from its Settings → Danger zone.
          </p>
          <div className="pj-list">
            {archivedList.map((p) => (
              <ProjectRow
                key={p.slug}
                p={p}
                repoAccess={p.repoAccess ?? undefined}
                starred={!!stars[p.slug]}
                onStar={onStar}
              />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/**
 * B-FD4: every tile linked into `/org/settings`, which hard-requires the ORG
 * ADMIN role — so a plain member's "Manage →" was a click into a 403. The
 * counts are org-wide summary and stay readable; only the link is admin-only,
 * and a member is told why instead of finding out at the boundary. The user
 * menu has always gated its own entry this way.
 */
function OrgTile({
  isAdmin,
  to,
  verb = "Manage",
  children,
}: {
  isAdmin: boolean;
  to: string;
  /** The action word in the tile foot (default "Manage"; a read-only tile like
   *  Insights passes "View"). */
  verb?: string;
  children: ReactNode;
}) {
  if (!isAdmin) {
    return (
      <div className="org-tile" aria-disabled="true">
        {children}
        <span className="foot go-hint muted">Org admins manage this</span>
      </div>
    );
  }
  return (
    <Link className="org-tile go" to={to}>
      {children}
      <span className="foot go-hint">
        {verb}
        <Icon name="arrow" />
      </span>
    </Link>
  );
}

export function SettingsPanel({
  org,
  isAdmin,
}: {
  org: HomeOrgSummary;
  isAdmin: boolean;
}) {
  return (
    // Design pass 2026-09-08: this was a `.panel` — a bordered, shadowed,
    // full-width box holding bordered tiles — sitting directly under the
    // project cards that are the page's actual content. The heaviest container
    // on Home belonged to its least important section, which is hierarchy
    // upside down. It takes the same `.sec-h` section header the three project
    // sections above it use, so the page reads as four peers with the projects
    // carrying the weight, and the tiles are the objects rather than being
    // objects inside a bigger object.
    <section data-screen-label="Settings">
      <div className="sec-h">
        <Icon name="sliders" />
        <h2>Settings</h2>
      </div>
      <div className="org-tiles">
        <OrgTile isAdmin={isAdmin} to="/org/settings?tab=connections">
          <span className="lbl">
            <Icon name="github" />
            GitHub connections
          </span>
          <span className="val">
            <span>
              <span className="nm">
                {countLabel(org.connectionOwners.length, "connection")}
              </span>
              <div className="sub">
                {org.connectionOwners.join(" · ") || "none connected"}
              </div>
            </span>
          </span>
        </OrgTile>
        <OrgTile isAdmin={isAdmin} to="/org/settings?tab=users">
          <span className="lbl">
            <Icon name="user" />
            Users &amp; access
          </span>
          <span className="val">
            <MemberStack members={org.users.first} />
            <span>
              <span className="nm">{countLabel(org.users.total, "user")}</span>
              <div className="sub">
                {countLabel(org.users.admins, "admin")} ·{" "}
                {countLabel(org.users.members, "member")}
                {org.users.disabled > 0
                  ? ` · ${org.users.disabled} disabled`
                  : ""}
              </div>
            </span>
          </span>
        </OrgTile>
        <OrgTile isAdmin={isAdmin} to="/org/settings?tab=resources">
          <span className="lbl">
            <Icon name="memory" />
            Agent resources
          </span>
          <span className="val">
            {/* A pictogram of the two backends, not data: the tile's own text
                names what it counts. */}
            <span className="glyphs">
              <AgentGlyph backend="codex" decorative />
              <AgentGlyph backend="claude" decorative />
            </span>
            <span>
              <span className="nm">
                {countLabel(org.globalAgents, "agent profile")}
                <span className="muted"> · + operator</span>
              </span>
              {/* Hardcoded plurals here read "1 knowledge bases · 1 MCP ·
                  1 skills" on a one-of-each instance — the Users-tab
                  disagreement, three nouns at a time. */}
              <div className="sub">
                {countLabel(org.knowledgeBases, "knowledge base")} ·{" "}
                {countLabel(org.mcpServers, "MCP server")} ·{" "}
                {countLabel(org.skills, "skill")}
              </div>
            </span>
          </span>
        </OrgTile>
        <OrgTile isAdmin={isAdmin} to="/insights" verb="View">
          <span className="lbl">
            <Icon name="activity" />
            Insights
          </span>
          <span className="val">
            <span>
              <span className="nm">Agent-run analytics</span>
              <div className="sub">cost, tokens, timing &amp; outcomes</div>
            </span>
          </span>
        </OrgTile>
      </div>
    </section>
  );
}

export function StoreStrip({
  scanning,
  onRescan,
  isAdmin,
  rebuilding,
  onRebuild,
  lockHolder = null,
}: {
  scanning: boolean;
  onRescan: () => void;
  isAdmin: boolean;
  rebuilding: boolean;
  onRebuild: () => void;
  /** F18-5: the process that owns this data root's single-writer lock, so an
   *  admin can SEE there is exactly one writer and who it is. */
  lockHolder?: { pid: number; hostname: string; startedAt: string } | null;
}) {
  // Both store-maintenance actions are org-admin only server-side; render them
  // only for an admin rather than a Re-scan button that silently 403s (MU-4).
  if (!isAdmin) return null;
  return (
    <footer className="store-strip" data-screen-label="Store strip">
      {/* F13/UI-D: this footer was two unlabelled buttons on the landing page,
          one of which carried "Drop every projection row and re-project the
          whole store from files" as its only explanation — in a `title`
          tooltip, i.e. invisible on touch and to a keyboard. It read as a dev
          drawer leaking into product chrome. The capability is unchanged; it
          now says whose it is and what it is for, and the destructive half is
          styled as such and confirmed before it runs. */}
      <Icon name="memory" />
      <span>
        <b>Store maintenance</b> · admins only. Projects and boards are a
        projection of the task files on disk. Neither action edits a task file.
        {lockHolder && (
          // F18-5: one writer per data root. Naming the holder makes a
          // second-writer mistake visible instead of only surfacing as silent
          // WAL loss (the incident this guard exists to stop).
          <>
            {" "}
            <span className="sub">
              Writer: pid {lockHolder.pid} on {lockHolder.hostname}.
            </span>
          </>
        )}
      </span>
      {/* The auto margin now lives on `.store-strip > :last-child`, so the
          GROUP is pushed to the end rather than the first button. What stays
          inline is this row's own layout, not compensation for that. */}
      <span className="inline-row">
        <button
          type="button"
          className="btn ghost sm"
          onClick={onRescan}
          title="Re-read the task files and update any board row that drifted from them"
        >
          <Icon name="refresh" className={scanning ? "spin" : ""} />
          {scanning ? "Scanning…" : "Re-scan store"}
        </button>
        <button
          type="button"
          className="btn ghost sm danger"
          onClick={onRebuild}
          title="Recovery: drop every projection row and re-project the whole store from files"
        >
          <Icon name="memory" className={rebuilding ? "spin" : ""} />
          {rebuilding ? "Rebuilding…" : "Rebuild projections…"}
        </button>
      </span>
    </footer>
  );
}

/** Confirm dialog for the full projection rebuild (admin recovery action).
 *  Hand-written, not the shared `ConfirmDialog` ruling 458(f) moved the other
 *  plain confirms onto. Home loads no other confirm, and the shared one's
 *  chunk would add ~0.5 KB gzip to Home's ruling-457 budget (ruling 458's
 *  2026-09-24 note). */
export function RebuildConfirm({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { ref, close } = useDialog(onCancel);
  return (
    // Native <dialog>; role="alertdialog" kept for the stronger semantics.
    // Escape + backdrop-click close come from showModal() + useDialog.
    <dialog
      ref={ref}
      className="confirm-card"
      role="alertdialog"
      aria-labelledby="rebuild-confirm-title"
      data-screen-label="Rebuild projections dialog"
    >
      <div className="confirm-icon">
        <Icon name="alert" />
      </div>
      <h3 id="rebuild-confirm-title">Rebuild all projections?</h3>
      <p>
        Drops every derived board/task row and re-projects the whole store from
        the files on disk. Nothing is lost: task files, repositories and pull
        requests are never touched, and every row here is rebuilt from them.
      </p>
      <p>
        This is a recovery action. Day-to-day drift only needs{" "}
        <b>Re-scan store</b>. Use it when the board disagrees with the files.
      </p>
      <div className="confirm-actions">
        <button type="button" className="btn ghost" onClick={close}>
          Cancel
        </button>
        {/* The trigger is tertiary-destructive; inside the confirmation the
            commit IS the primary action, so it carries the danger tone here —
            not out on the page (skill: destructive placement). */}
        <button type="button" className="btn danger" onClick={onConfirm}>
          Rebuild projections
        </button>
      </div>
    </dialog>
  );
}
