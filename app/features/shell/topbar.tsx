import { useEffect, useRef, useState } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router";
import type { ThemePreference } from "~/server/theme/theme-cookie.server";
import { Icon } from "~/ui/icon";
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
  openTask,
  user,
  theme,
  notifications,
  unread,
}: {
  projectSlug: string;
  projectName: string;
  /** Open task (crumb state) — supplied by the layout from route matches. */
  openTask: { key: string; title: string } | null;
  user: MenuUser;
  theme: ThemePreference;
  notifications: NotificationView[];
  unread: number;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);

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
      navigate(
        value ? `${boardPath}?q=${encodeURIComponent(value)}` : boardPath,
      );
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
      <div className="top-search">
        <Icon name="search" />
        <input
          ref={inputRef}
          placeholder="Search tasks, branches, agents…"
          aria-label="Search tasks, branches, agents"
          value={query}
          onChange={(e) => onSearch(e.target.value)}
        />
        <span className="kbd">⌘K</span>
      </div>
      <TopBell notifications={notifications} unread={unread} />
      <UserMenu user={user} theme={theme} showSwitchProject />
    </div>
  );
}
