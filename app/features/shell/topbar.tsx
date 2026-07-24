import { useEffect, useRef, useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router";
import type { ThemePreference } from "~/server/theme/theme-cookie.server";
import { Icon } from "~/ui/icon";
import { useModifierHint } from "~/ui/use-shortcut-hint";
import type { NotificationView } from "~/features/notifications/notification-item";
import { TopBell } from "./top-bell";
import { UserMenu, type MenuUser } from "./user-menu";
import { workspaceViewFromPathname, workspaceViewLabel } from "./nav";

/**
 * Workspace topbar (shell spec §4.2): brand → Home, crumbs (CSS truncation
 * tiers ported verbatim in viberr.css), REAL search (filters the board via
 * the `?q=` param; ⌘K focuses it), bell popover, account menu.
 *
 * Typing in the search while on a non-board view navigates to the board
 * with the query applied (mirrors Home's "typing leaves settings" rule).
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
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);

  const modifierHint = useModifierHint();
  const view = workspaceViewFromPathname(location.pathname);
  const onBoard =
    view === "board" && !openTask && location.pathname.endsWith("/board");
  const boardPath = `/projects/${projectSlug}/board`;
  const urlQuery = onBoard ? (searchParams.get("q") ?? "") : "";
  const [query, setQuery] = useState(urlQuery);

  // Leaving the board (or an external URL change) resets the input.
  useEffect(() => {
    setQuery(urlQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onBoard ? urlQuery : location.pathname]);

  const onSearch = (value: string) => {
    setQuery(value);
    if (onBoard) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set("q", value);
          else next.delete("q");
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
    } else {
      // UI-55: the first keystroke on a non-board view PUSHES (so Back returns
      // to the view you were on); every keystroke after that REPLACES. Without
      // it, fast typing pushed `?q=a`, `?q=ab`, `?q=abc` and Back walked the
      // user backwards through their own partial queries.
      navigate(value ? `${boardPath}?q=${encodeURIComponent(value)}` : boardPath, {
        replace: query.length > 0,
      });
    }
  };

  // ⌘K / Ctrl-K focuses the search (mock Home behavior, shell requirement).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="topbar">
      <Link className="home-brand" to="/" title="Home — all projects">
        <span className="mark">V</span>
        <b>Viberr</b>
      </Link>
      <div className="crumbs">
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
            <span className="cur" title={openTask.key + " · " + openTask.title}>
              {openTask.key} · {openTask.title}
            </span>
          </>
        ) : (
          <span className="cur">{workspaceViewLabel(view)}</span>
        )}
      </div>
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
      <div className="top-search">
        <Icon name="search" />
        <input
          ref={inputRef}
          placeholder="Search tasks, branches, agents…"
          aria-label="Search tasks, branches, agents"
          value={query}
          onChange={(e) => onSearch(e.target.value)}
        />
        {/* UI-55: the handler accepts Ctrl as well; show what the viewer's
            keyboard actually has. */}
        <span className="kbd" suppressHydrationWarning>
          {modifierHint}
        </span>
      </div>
      <TopBell notifications={notifications} unread={unread} />
      <UserMenu user={user} theme={theme} showSwitchProject />
    </div>
  );
}
