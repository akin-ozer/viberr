import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import type { ThemePreference } from "~/server/theme/theme-cookie.server";
import { Icon } from "~/ui/icon";
import { useModifierHint } from "~/ui/use-shortcut-hint";
import type { NotificationView } from "~/features/notifications/notification-item";
import { CommandPalette } from "./command-palette";
import { useCommandPaletteShortcut } from "./use-command-palette";
import { TopBell } from "./top-bell";
import { UserMenu, type MenuUser } from "./user-menu";
import { boardHref, workspaceViewFromPathname, workspaceViewLabel } from "./nav";

/**
 * Workspace topbar (shell spec §4.2): brand → Home, crumbs (CSS truncation
 * tiers ported verbatim in viberr.css), the ⌘K palette trigger, bell popover,
 * account menu.
 *
 * R15-5: the trigger used to be an input that filtered the OPEN BOARD via `?q=`
 * while promising a global "tasks, branches, agents" search. It opens the real
 * palette now (`command-palette.tsx`); the per-board filter moved onto the board
 * itself, where its scope is visible.
 */
export function Topbar({
  projectSlug,
  projectName,
  orgAdminOverride = false,
  openTask,
  user,
  theme,
  notifications,
  unread,
  livePaused = false,
  onReconnect,
  railOpen = false,
  onToggleRail,
}: {
  projectSlug: string;
  projectName: string;
  /** D2 honesty pill: the viewer is an ORG admin who is NOT a member of this
   *  project — every action here is the audited emergency override. */
  orgAdminOverride?: boolean;
  /** Open task (crumb state) — supplied by the layout from route matches. */
  openTask: { key: string; title: string } | null;
  user: MenuUser;
  theme: ThemePreference;
  notifications: NotificationView[];
  unread: number;
  /** UI-03: the SSE stream is down — everything on screen is a stale snapshot. */
  livePaused?: boolean;
  onReconnect?: () => void;
  /** F15-18: the rail is collapsed behind a toggle under the mobile breakpoint;
   *  this is the layout's state, so the button can report it (aria-expanded). */
  railOpen?: boolean;
  onToggleRail?: () => void;
}) {
  const location = useLocation();

  const modifierHint = useModifierHint();
  const view = workspaceViewFromPathname(location.pathname);
  // P13-D-35: the crumbs' board links kept the filter/search only if the URL
  // carried it — they were bare paths, so clicking the project crumb from a
  // filtered board silently reset it. `boardHref` carries `?filter/view/q` when
  // (and only when) we are already on this project's board.
  const boardPath = boardHref(projectSlug, location);
  const [palette, setPalette] = useState(false);

  // ⌘K / Ctrl-K opens the palette (R15-5 — it used to focus a board filter).
  // UI-C: ONE implementation, shared with Home (inventory rough edge #8).
  useCommandPaletteShortcut(() => setPalette(true));

  // F15-18/UI-C: the mobile rail is an overlay; Escape has to be able to get
  // out of it, and focus has to land back on the control that opened it. The
  // scrim is pointer-only by construction (`routes/project.tsx`), so this is
  // the keyboard half of that dismissal — not a duplicate of it.
  const railToggleRef = useRef<HTMLButtonElement>(null);
  const toggleRailRef = useRef(onToggleRail);
  toggleRailRef.current = onToggleRail;
  useEffect(() => {
    if (!railOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      toggleRailRef.current?.();
      railToggleRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [railOpen]);

  return (
    <div className="topbar">
      {/* F15-18: only rendered by CSS under the mobile breakpoint — above it the
          rail is always on screen and a toggle would be noise. */}
      {onToggleRail && (
        <button
          ref={railToggleRef}
          type="button"
          className="rail-toggle"
          aria-label="Project navigation"
          aria-expanded={railOpen}
          onClick={onToggleRail}
        >
          <Icon name="board" />
        </button>
      )}
      <Link className="home-brand" to="/" title="Home — all projects">
        <span className="mark">V</span>
        <b>Viberr</b>
      </Link>
      {/* P13-D-37: the crumb trail was an anonymous <div> with a <span
          class="cur"> — no landmark, no current-page signal. <nav> + the label
          and `aria-current` are pure semantics: `.crumbs` is a flex container
          styled by class, and <nav> is a block box exactly like the <div> it
          replaces, so the truncation tiers (app.css:2306-2316) are untouched.
          (The fuller <ol>/<li> shape would need `display: contents` rules that
          do not exist yet — reported rather than invented.) */}
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link className="crumb-root" to={boardPath}>
          {projectName}
        </Link>
        <span className="sep sep-root">
          <Icon name="chevron" />
        </span>
        {openTask ? (
          <>
            <Link className="crumb-mid" to={boardPath}>
              Board
            </Link>
            <span className="sep sep-mid">
              <Icon name="chevron" />
            </span>
            <span
              className="cur"
              aria-current="page"
              title={openTask.key + " · " + openTask.title}
            >
              {openTask.key} · {openTask.title}
            </span>
          </>
        ) : (
          <span className="cur" aria-current="page">
            {workspaceViewLabel(view)}
          </span>
        )}
      </nav>
      {orgAdminOverride && (
        <span
          className="pill risk sm"
          title="You are not a member of this project — you're acting with org-admin emergency authority. Every override is recorded in the audit log."
        >
          org-admin override
        </span>
      )}
      {/* UI-03: an SSE stream that failed never reconnects on its own, so the
          board, rail counts, bell badge and review queue silently froze. Say so
          instead of presenting a stale snapshot as live governance state. */}
      {livePaused && (
        <button
          type="button"
          className="pill risk sm"
          role="status"
          style={{ cursor: onReconnect ? "pointer" : "default" }}
          title="The live update stream dropped (often an expired session). Counts and board state on this page may be out of date."
          onClick={() => onReconnect?.()}
        >
          live updates paused — retry
        </button>
      )}
      {/* R15-5: a BUTTON, not an input — everything typed here is answered by
          the palette, across every project the viewer can open. */}
      <button
        type="button"
        className="top-search"
        aria-haspopup="dialog"
        aria-label="Search tasks, branches, agents, projects"
        onClick={() => setPalette(true)}
      >
        <Icon name="search" />
        <span className="top-search-label">Search…</span>
        {/* UI-55: the handler accepts Ctrl as well; show what the viewer's
            keyboard actually has. */}
        <span className="kbd" suppressHydrationWarning>
          {modifierHint}
        </span>
      </button>
      <TopBell notifications={notifications} unread={unread} />
      <UserMenu user={user} theme={theme} showSwitchProject />
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  );
}
