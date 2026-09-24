// Ruling 365: one UI typeface. Inter carries both the body and the display
// token (Manrope and Noto Sans are gone); JetBrains Mono stays for code and
// identifiers that are code. 400–800 so every weight the sheet declares is a
// real face and nothing is synthesised.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/inter/800.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "./app.css";

import { useEffect, useMemo } from "react";
import { z } from "zod";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import { RoutePendingBar } from "./features/shell/route-pending-bar";
import { setDocumentTheme } from "./features/shell/theme-preference";
import { ControllerDock } from "./features/controller/controller-dock";
import { SHELL_FONT_PRELOADS } from "./features/shell/font-preloads";
import { ToastProvider } from "./ui/toast";
import { getCsrfToken } from "./server/auth/csrf.server";
import { requestContextMiddleware } from "./server/logging/request-context.server";
import {
  authenticate,
  sessionRenewalMiddleware,
} from "./server/auth/require-user.server";
import { liveHeadContext, liveHeadMiddleware } from "./server/events/sse-broker.server";
import { isDocumentNavigation } from "./server/http/single-fetch.server";
import {
  getThemePreference,
  type ThemePreference,
} from "./server/theme/theme-cookie.server";

export const links: Route.LinksFunction = () => [
  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
  // Ruling 454: the faces every first paint draws, fetched alongside the CSS.
  ...SHELL_FONT_PRELOADS,
];

/**
 * P13-D-30: binds one correlation id for the whole request, so every
 * `logger.*` call from any loader, action or nested route carries it with no
 * call-site work. `entry.server.tsx` reuses the id bound here rather than
 * minting a second one, so the render and the data phase share it.
 *
 * The architecture doc promised "structured JSON logs with request/job
 * correlation identifiers" from the start. The affordance shipped once as an
 * opt-in `logger.child({ requestId })`, was never called by anything, and was
 * deleted as dead code — which is what happens to an opt-in nobody opts into.
 * This one is not optional.
 *
 * Ruling 454: `liveHeadMiddleware` reads the SSE broker's head before any
 * loader runs (the page's first stream replays from it), and
 * `sessionRenewalMiddleware` forwards the rolling-session renewal (F10-17) on
 * every GET, which this loader used to do only when it ran.
 */
export const middleware = [requestContextMiddleware, liveHeadMiddleware, sessionRenewalMiddleware];

export async function loader({ request, context }: Route.LoaderArgs) {
  const theme = getThemePreference(request);
  // Identifies the signed-in user for the shell and <CsrfInput />.
  const auth = await authenticate(request);
  // Ruling 148(c): the in-app reduce-motion preference (and its
  // <html data-motion> hook) is gone; the OS setting is the one signal.
  const payload = {
    theme,
    csrf: auth ? getCsrfToken(auth.sessionId) : null,
  };
  // Ruling 454 (RF-1): where the page's first live stream starts. Only a
  // document load seeds it; a `.data` answer would find the tab's streams
  // already under way.
  if (!isDocumentNavigation(request)) return payload;
  return { ...payload, liveHead: context.get(liveHeadContext) };
}

/**
 * Runs before first paint. Resolves the "system" preference against
 * prefers-color-scheme (and follows OS changes live); explicit light/dark
 * are simply applied. Mirrors the inline script in the design mock's <head>.
 *
 * The `viberr_theme` cookie is read as the AUTHORITATIVE source and overrides
 * the SSR-passed preference. This keeps the theme correct on the ErrorBoundary
 * page, where the root loader data (and thus `preference`) may be missing so the
 * Layout falls back to "system" — without the cookie read a dark session would
 * flash/stay light on a 404/403 (F3).
 */
function themeBootScript(preference: ThemePreference): string {
  return (
    `(function(){try{var p=${JSON.stringify(preference)};` +
    `var c=(document.cookie.match(/(?:^|; )viberr_theme=([^;]+)/)||[])[1];` +
    `if(c==="dark"||c==="light"||c==="system")p=c;` +
    `var d=document.documentElement;` +
    // First paint only: the App effect below takes over the OS "change"
    // listener on hydration. A second, permanent listener here wrote the
    // attribute directly, ahead of the effect, so an OS flip bypassed the
    // one writer (`setDocumentTheme`) and kept following the OS even after
    // an explicit in-session pick.
    `if(p==="system"){d.dataset.theme=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}` +
    `else{d.dataset.theme=p;}}catch(e){}})();`
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Layout also renders for ErrorBoundary, where loader data may be missing.
  const data = useRouteLoaderData<typeof loader>("root");
  const theme: ThemePreference = data?.theme ?? "system";
  // SSR renders the explicit preference; "system" starts light and is
  // corrected pre-paint by the inline script (hence suppressHydrationWarning).
  const ssrTheme = theme === "dark" ? "dark" : "light";
  // Ruling 454: one `{__html}` object per preference. React compares it by
  // identity, and a fresh object rewrote the script's text on every root
  // reload (the icon cost, in <head>).
  const bootScript = useMemo(() => ({ __html: themeBootScript(theme) }), [theme]);
  return (
    <html lang="en" data-theme={ssrTheme} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <script dangerouslySetInnerHTML={bootScript} />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const rootData = useRouteLoaderData<typeof loader>("root");
  const theme: ThemePreference = rootData?.theme ?? "system";

  // Keeps <html data-theme> in sync AFTER first paint (the boot script owns
  // first paint): re-applies when the pref changes (user-menu cycling
  // revalidates the root loader) and live-follows the OS on "system".
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    // One writer for <html data-theme> (`theme-preference.ts`), so the
    // OS-follow path swaps without the crossfade smear the menu path avoids.
    const apply = () =>
      setDocumentTheme(theme === "dark" || (theme === "system" && media.matches));
    apply();
    if (theme === "system") {
      media.addEventListener("change", apply);
      return () => media.removeEventListener("change", apply);
    }
  }, [theme]);

  return (
    <ToastProvider>
      {/* P13-D-36: one app-wide route pending indicator, mounted above the
          Outlet so it survives every route change. */}
      <RoutePendingBar />
      <Outlet />
      {/* Ruling 121: the controller dock, one mount for every signed-in
          surface. A csrf token in the root payload is the signed-in signal;
          the dock hides itself on the login and controller pages. */}
      {rootData?.csrf ? <ControllerDock /> : null}
    </ToastProvider>
  );
}

/** Guards throw `data("<user message>", { status })`, so a route error's `data`
 *  is user-facing copy when it came through as a string. D32-15 (pass 32): the
 *  role guard (`requireRole`) answers page and API requests alike with the JSON
 *  envelope `{ error: { code, message } }`, and a non-admin opening
 *  /org/settings or /insights read only "Forbidden" — the WHY ("This area
 *  requires the admin role.") was in the payload the boundary threw away. Both
 *  shapes are copy; anything else is transport noise. */
const thrownMessage = z
  .union([
    z.string(),
    z
      .object({ error: z.object({ message: z.string() }) })
      .transform((v) => v.error.message),
  ])
  .catch("");

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let detail = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    title = error.status === 404 ? "Page not found" : `Error ${error.status}`;
    // The thrown string (e.g. the 403 from requireProjectMember) IS the page
    // copy. statusText is transport boilerplate, so it is only a fallback.
    const thrown = thrownMessage.parse(error.data).trim();
    detail =
      thrown ||
      (error.status === 404
        ? "The page you are looking for does not exist."
        : error.statusText || detail);
  } else if (import.meta.env.DEV && error instanceof Error) {
    detail = error.message;
    stack = error.stack;
  }

  return (
    <main className="app-splash">
      <section className="panel">
        <div className="panel-head">
          <h2>{title}</h2>
          <span className="right pill blocked">
            <span className="pdot" />
            error
          </span>
        </div>
        <p className="detail-line">{detail}</p>
        {stack ? (
          <pre className="mono">
            <code>{stack}</code>
          </pre>
        ) : null}
        <a className="btn" href="/">
          Back to home
        </a>
      </section>
    </main>
  );
}
