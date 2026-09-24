import { useState } from "react";
import { Outlet, useLocation, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/palette-shell";
import type { loader as rootLoader } from "../root";
import { requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { bellCounts } from "~/server/projections/notifications.server";
import { CommandPalette } from "~/features/shell/command-palette";
import { standalonePageLabel } from "~/features/shell/nav";
import { PageTopbar } from "~/features/shell/page-topbar";
import { useCommandPaletteShortcut } from "~/features/shell/use-command-palette";
import { SkipLink } from "~/ui/skip-link";

/**
 * The layout for the app's standalone surfaces — the routes that render
 * OUTSIDE the workspace shell. It carries two things.
 *
 * **The ⌘K palette (F20-30).** `home-page.tsx` calls ⌘K "ONE shortcut
 * app-wide", but the hook was mounted only by Home and the workspace `Topbar`,
 * so on these routes the shortcut — and any search affordance at all — simply
 * was not there. The palette is a native <dialog> (`showModal`) and stacks in
 * the top layer above a PageOverlay underneath, and the shortcut listens on
 * `window`, which the overlay's `useDialog` never intercepts, so it works while
 * an overlay is open. This layout deliberately does NOT wrap Home or the
 * workspace: both mount the shortcut themselves, so nothing double-registers.
 *
 * **The app header (ruling 145).** The board's own Settings page sits under the
 * workspace topbar; the INSTANCE settings behind Home's Settings tiles sat
 * under nothing — no brand, no search, no bell, no account menu, and an in-page
 * back button doing the navigating. `PageTopbar` is that header, rendered here
 * so one mount serves every standalone page, and `standalonePageLabel` decides
 * which routes are pages that take it (the two overlay routes and the
 * controller are not — see `nav.ts`).
 *
 * The loader is scoped to the same answer: on a route with no header it reads
 * nothing at all, so `/controller`, `/profile` and `/notifications` cost
 * exactly what they cost before — including their own auth guard, unchanged.
 */

/**
 * The path this request is really about. A revalidation is a single-fetch data
 * request — `GET /org/settings.data?tab=resources` — so the loader sees a
 * pathname the page list does not contain, and answering "no header" to it
 * would take the header off the page one submit after it loaded.
 */
function pagePathname(url: URL): string {
  return url.pathname.replace(/\.data$/, "");
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  if (!standalonePageLabel(pagePathname(url))) return { header: null };
  const user = await requireUser(request);
  const db = getDb();
  return {
    header: {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatarTone: user.avatarTone,
      },
      // The same counts the workspace topbar and Home read, so the bell says
      // the same thing on every surface. Ruling 454 (FL-4): the bell loads its
      // own list, and its popover discloses the cap.
      ...bellCounts(db, user.id),
    },
  };
}

export default function PaletteShell({ loaderData }: Route.ComponentProps) {
  const [palette, setPalette] = useState(false);
  useCommandPaletteShortcut(() => setPalette(true));
  const location = useLocation();
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const title = standalonePageLabel(location.pathname);
  const header = loaderData.header;
  const dialog = palette ? (
    <CommandPalette onClose={() => setPalette(false)} />
  ) : null;

  // The SHAPE of this tree is decided by the route alone, never by loader data.
  // Deciding it on `header` too cost a whole page: a revalidation that came
  // back without one swapped `.home` for a fragment, React unmounted
  // everything under the Outlet, and the org-settings file browser someone had
  // open closed itself mid-edit. The route cannot change under a revalidation;
  // data can.
  if (!title) {
    return (
      <>
        <Outlet />
        {dialog}
      </>
    );
  }

  return (
    // Home's own page shell: a full-height flex column whose header sticks and
    // whose body scrolls (`body:has(.home)`). Insights had neither — it rendered
    // straight into a `overflow: hidden` body, so anything below the fold was
    // unreachable.
    <div className="home">
      {/* UI-12: bypass block — the header sits ahead of the content on every
          navigation, exactly as it does on Home and in the workspace. */}
      <SkipLink />
      {header && (
        <PageTopbar
          title={title}
          user={header.user}
          theme={rootData?.theme ?? "system"}
          unread={header.unread}
          orphanUnread={header.orphanUnread}
          onOpenPalette={() => setPalette(true)}
        />
      )}
      {/* The skip TARGET is a sentinel BELOW the header (pass 30): focusing the
          page's own <main> would leave the header's tab stops ahead of the
          content, so the "skip" would skip nothing. */}
      <div id="main-content" tabIndex={-1} />
      <Outlet />
      {dialog}
    </div>
  );
}
