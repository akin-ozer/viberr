import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import type { ThemePreference } from "~/server/theme/theme-cookie.server";
import { Icon } from "~/ui/icon";
import { CommandPalette } from "./command-palette";
import { PaletteTrigger } from "./palette-trigger";
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
  unread,
  orphanUnread,
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
  /** The bell's counts (`bellCounts`); the bell loads its own list (ruling 457). */
  unread: number;
  orphanUnread: number;
  /** UI-03: the SSE stream is down — everything on screen is a stale snapshot. */
  livePaused?: boolean;
  onReconnect?: () => void;
  /** F15-18: the rail is collapsed behind a toggle under the mobile breakpoint;
   *  this is the layout's state, so the button can report it (aria-expanded). */
  railOpen?: boolean;
  onToggleRail?: () => void;
}) {
  const location = useLocation();

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
  // the keyboard half of that dismissal — not a duplicate of it. The restore
  // is deferred past the close (see the second effect below).
  const railToggleRef = useRef<HTMLButtonElement>(null);
  const toggleRailRef = useRef(onToggleRail);
  // Kept current in an effect, not during render (render must stay pure); read
  // only from the deferred keydown handler below.
  useEffect(() => {
    toggleRailRef.current = onToggleRail;
  });
  useEffect(() => {
    if (!railOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A modal dialog (the palette opens over the drawer; showModal escapes
      // the inert page) owns its own Escape: one press closes one layer, and
      // the dialog's focus restore lands on the still-open drawer.
      if (document.querySelector("dialog[open]")) return;
      toggleRailRef.current?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [railOpen]);
  // Focus goes back to the toggle on EVERY close (Escape, the scrim, a rail
  // link), and only after the close has committed: the toggle sits inside
  // <main>, which the layout keeps `inert` while the rail is open, and
  // focus() into an inert subtree is a no-op, so the keydown handler cannot
  // do this itself (it ran before the commit and used to).
  const railWasOpen = useRef(false);
  useEffect(() => {
    if (!railOpen && railWasOpen.current) railToggleRef.current?.focus();
    railWasOpen.current = railOpen;
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
      <Link className="home-brand" to="/" title="Home · all projects">
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
            {/* Design pass 2026-09-08: the key alone. The title is the page's
                H1 twenty pixels below, so the leaf was the loudest of three
                copies of the same name; the full pair stays in `title`. */}
            <span
              className="cur"
              aria-current="page"
              title={openTask.key + " · " + openTask.title}
            >
              {openTask.key}
            </span>
          </>
        ) : (
          <span className="cur" aria-current="page">
            {workspaceViewLabel(view)}
          </span>
        )}
      </nav>
      {/* UXA-13: the two visible words are not the message — the sentence that
          matters lived only in a `title` on a non-focusable `<span>`, which
          keyboard and screen-reader users never reach and touch users cannot
          hover. This is the D2 authority surface: the reader must be able to
          learn they are acting outside their membership, and that it is
          audited. The full sentence is now the element's accessible name. */}
      {orgAdminOverride && (
        <span
          className="pill risk sm"
          title="You are not a member of this project. You're acting with org-admin emergency authority. Every override is recorded in the audit log."
          aria-label="org-admin override: you are not a member of this project; you're acting with org-admin emergency authority, and every override is recorded in the audit log."
        >
          org-admin override
        </span>
      )}
      {/* UI-03: an SSE stream that failed never reconnects on its own, so the
          board, rail counts, bell badge and review queue silently froze. Say so
          instead of presenting a stale snapshot as live governance state. */}
      {/* The sentence is a status, the retry is an action: one element wearing
          `.pill` (no cursor, no hover) with role="status" over a click handler
          was neither honestly. role="status" also replaced the button role, so
          "retry" was not reachable as a control by name, and with no
          `onReconnect` it was a button that did nothing.

          The announcer is mounted unconditionally (the idiom at
          `home-sections.tsx`, `controller-dock.tsx` and `ui/label-input.tsx`):
          a live region inserted together with its text is the one case screen
          readers skip, so a region that appears only while paused announces
          nothing. The visible chip is then a plain span — its text IS the
          headline and the `title` carries the detail, so an `aria-label` here
          would only replace the chip's own words with a longer duplicate. */}
      <span className="vh" role="status" aria-live="polite">
        {livePaused
          ? "Live updates paused. Counts and board state may be out of date."
          : ""}
      </span>
      {livePaused && (
        <span
          className="pill risk sm"
          title="The live update stream dropped (often an expired session). Counts and board state on this page may be out of date."
        >
          live updates paused
        </span>
      )}
      {livePaused && onReconnect && (
        <button
          type="button"
          className="btn ghost sm"
          title="Reconnect the live update stream"
          onClick={onReconnect}
        >
          Retry
        </button>
      )}
      {/* R15-5: a BUTTON, not an input — everything typed here is answered by
          the palette, across every project the viewer can open. Shared with the
          standalone-page header so the two cannot drift (`palette-trigger.tsx`). */}
      <PaletteTrigger onOpen={() => setPalette(true)} />
      <TopBell unread={unread} orphanUnread={orphanUnread} />
      <UserMenu user={user} theme={theme} showSwitchProject />
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  );
}
