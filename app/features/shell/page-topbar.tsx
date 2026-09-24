import { Link } from "react-router";
import type { ThemePreference } from "~/server/theme/theme-cookie.server";
import { Icon } from "~/ui/icon";
import { PaletteTrigger } from "./palette-trigger";
import { TopBell } from "./top-bell";
import { UserMenu, type MenuUser } from "./user-menu";

/**
 * The app header for the standalone pages — the instance-level surfaces that
 * render OUTSIDE the workspace layout (`/org/settings`, `/insights`).
 *
 * Ruling 145 (owner, 2026-09-05). Every project surface, the board's own
 * Settings included, sits under a header carrying the brand, the ⌘K search, the
 * bell and the account menu; Home carries the same one. The instance surfaces
 * behind Home's Settings tiles carried none of it: opening "Users & access" or
 * "Insights" replaced the whole app with a bare page whose only way back was an
 * in-page back button, and the notifications and account menu simply were not
 * there. This is that header, on the standalone pages, built from the SAME
 * parts as the other two — `.home-top` is Home's own header shell (so the
 * responsive tiers already exist), the crumb trail is the workspace topbar's,
 * and the trigger, bell and menu are the shared components.
 *
 * The brand and the crumb root are the way back: an in-page back button beside
 * them would be a third control for the same navigation, and the board's
 * settings page has none.
 */
export function PageTopbar({
  title,
  user,
  theme,
  unread,
  orphanUnread,
  onOpenPalette,
}: {
  /** The page's name, as the current crumb (`Instance settings`, `Insights`). */
  title: string;
  user: MenuUser;
  theme: ThemePreference;
  /** The bell's counts (`bellCounts`); the bell loads its own list (ruling 454). */
  unread: number;
  orphanUnread: number;
  /** The palette lives in the layout (one mount per surface), so the trigger
   *  reports the click rather than owning the dialog. */
  onOpenPalette: () => void;
}) {
  return (
    <header className="home-top">
      <div className="home-top-in">
        <Link className="home-brand" to="/" title="Home · all projects">
          <span className="mark">V</span>
          <b>Viberr</b>
        </Link>
        {/* Same shape as the workspace crumbs (`topbar.tsx`), so the two read as
            one trail: root → current page, with `aria-current` on the leaf. The
            root here is Home, because these pages belong to the instance rather
            than to any project. */}
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link className="crumb-root" to="/">
            Home
          </Link>
          <span className="sep sep-root">
            <Icon name="chevron" />
          </span>
          <span className="cur" aria-current="page">
            {title}
          </span>
        </nav>
        <PaletteTrigger onOpen={onOpenPalette} />
        <TopBell unread={unread} orphanUnread={orphanUnread} />
        {/* No "Switch project" item: these pages are not inside a project, so
            the brand and the crumb root already ARE that navigation — the same
            reason Home omits it. */}
        <UserMenu user={user} theme={theme} />
      </div>
    </header>
  );
}
