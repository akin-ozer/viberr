import "@fontsource/noto-sans/400.css";
import "@fontsource/noto-sans/500.css";
import "@fontsource/noto-sans/600.css";
import "@fontsource/noto-sans/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/manrope/800.css";
import "./app.css";

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
import {
  getThemePreference,
  type ThemePreference,
} from "./server/theme/theme-cookie.server";

export const links: Route.LinksFunction = () => [
  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
];

export function loader({ request }: Route.LoaderArgs) {
  return { theme: getThemePreference(request) };
}

/**
 * Runs before first paint. Resolves the "system" preference against
 * prefers-color-scheme (and follows OS changes live); explicit light/dark
 * are simply applied. Mirrors the inline script in the design mock's <head>.
 */
function themeBootScript(preference: ThemePreference): string {
  return (
    `(function(){try{var p=${JSON.stringify(preference)};` +
    `var d=document.documentElement;` +
    `if(p==="system"){var m=window.matchMedia("(prefers-color-scheme: dark)");` +
    `var a=function(){d.dataset.theme=m.matches?"dark":"light";};a();` +
    `if(m.addEventListener)m.addEventListener("change",a);}` +
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
  return (
    <html lang="en" data-theme={ssrTheme} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <script
          dangerouslySetInnerHTML={{ __html: themeBootScript(theme) }}
        />
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
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let detail = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    title = error.status === 404 ? "Page not found" : `Error ${error.status}`;
    detail =
      error.status === 404
        ? "The page you are looking for does not exist."
        : error.statusText || detail;
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
