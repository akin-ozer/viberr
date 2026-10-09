// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { startTransition } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { createRoutesStub, data, Link, useFetcher, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/root";
import App, { ErrorBoundary, Layout, type loader } from "./root";
import type { ThemePreference } from "./server/theme/theme-cookie.server";

/**
 * Ruling 283: after first paint `setDocumentTheme` is the ONE writer of
 * <html data-theme> (docs/ui/surfaces.md "Theme"). Layout used to render the
 * attribute from live loader data, so React wrote the loader's raw preference
 * on every revalidation, past the one-clock fade: Dark -> System on a dark OS
 * painted "light" until the App effect put "dark" back, a pick saved in
 * another tab landed with no fade at all, and the ErrorBoundary swap (which
 * strips and re-acquires <html>) wrote "light" for a "system" viewer on a
 * dark OS.
 *
 * The harness runs the product's own path: a real `renderToString` of the
 * root route (the server), the boot script's pass over <html> (jsdom runs no
 * inline script, so the test does what it does), then `entry.client.tsx`'s
 * `hydrateRoot(document)` inside `startTransition`, with React's recoverable
 * errors and console collected.
 *
 * Its own file, apart from root.test.tsx: any React root marks its document
 * as listening (it hangs `selectionchange` there), so a
 * `hydrateRoot(document)` after an RTL `render` in the same jsdom attaches no
 * event listeners of its own and no click reaches React.
 */

/** The preference the stub's root loader reads: the `viberr_theme` cookie a
 *  /prefs/theme POST writes, or one another tab wrote. */
let saved: ThemePreference = "system";
/** What the OS reports for `prefers-color-scheme: dark`. */
let osDark = true;

/** The index page: shows the root loader's preference (it flips in the same
 *  commit that used to write data-theme) and posts the way the account menu
 *  does, so the action revalidates the root loader. */
function ThemeProbe() {
  const root = useRouteLoaderData<typeof loader>("root");
  const fetcher = useFetcher();
  return (
    <>
      <output>saved: {root?.theme}</output>
      <fetcher.Form method="post">
        <button type="submit" name="theme" value="system">
          System
        </button>
        <button type="submit" name="theme" value="">
          Revalidate
        </button>
      </fetcher.Form>
      <Link to="/gone">Gone</Link>
    </>
  );
}

const RootStub = createRoutesStub([
  {
    id: "root",
    path: "/",
    loader: () => ({ theme: saved, csrf: null }),
    Component: () => (
      <Layout>
        <App />
      </Layout>
    ),
    ErrorBoundary: (props: Route.ErrorBoundaryProps) => (
      <Layout>
        <ErrorBoundary {...props} />
      </Layout>
    ),
    children: [
      {
        index: true,
        Component: ThemeProbe,
        action: async ({ request }) => {
          const pick = (await request.formData()).get("theme");
          if (pick === "system" || pick === "dark" || pick === "light") saved = pick;
          return null;
        },
      },
      {
        path: "gone",
        loader: () => {
          throw data("No project at projects/ghost.", { status: 404 });
        },
      },
    ],
  },
]);

interface HydrationReport {
  /** The server's markup. */
  html: string;
  /** React's recoverable errors: a #418 lands here. */
  recoverable: string[];
  /** console.error while serving and hydrating: an attribute mismatch lands here. */
  warnings: string[];
  /** data-theme writes from hydration and its effects (see `watchTheme`). */
  written: (string | null)[];
}

let hydrated: Root | null = null;

/** Queries over the served <body>: `screen` stays bound to the body jsdom
 *  started with, which the served document replaced. */
function page() {
  return within(document.body);
}

/** From the moment it is called: every value <html data-theme> is written to,
 *  in order, with "fade" where the one-clock override went into <head>. A
 *  record's oldValue is the value before its write, so each write's value is
 *  the next record's oldValue, and the last one's is on screen now. */
function watchTheme(): () => (string | null)[] {
  const html = document.documentElement;
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((batch) => records.push(...batch));
  observer.observe(html, {
    attributes: true,
    attributeFilter: ["data-theme"],
    attributeOldValue: true,
    childList: true,
    subtree: true,
  });
  return () => {
    records.push(...observer.takeRecords());
    observer.disconnect();
    const writes = records.filter((r) => r.type === "attributes");
    const log: (string | null)[] = [];
    for (const record of records) {
      if (record.type === "attributes") {
        const next = writes[writes.indexOf(record) + 1];
        log.push(next ? next.oldValue : html.getAttribute("data-theme"));
      } else if (
        record.target === document.head &&
        [...record.addedNodes].some((node) => node.nodeName === "STYLE")
      ) {
        log.push("fade");
      }
    }
    return log;
  };
}

/** Serves the document for `saved`, runs the boot script's pass (it paints
 *  `bootTheme`), then hydrates the whole document as `entry.client.tsx` does. */
async function serveAndHydrate(bootTheme: "dark" | "light"): Promise<HydrationReport> {
  const stub = (
    <RootStub
      initialEntries={["/"]}
      hydrationData={{ loaderData: { root: { theme: saved, csrf: null } } }}
    />
  );
  const report: HydrationReport = { html: "", recoverable: [], warnings: [], written: [] };
  const consoleError = vi
    .spyOn(console, "error")
    .mockImplementation((...args: (Error | string)[]) => {
      report.warnings.push(args.map(String).join(" "));
    });
  try {
    // The server pass runs in this jsdom too; with no data-theme on screen the
    // Layout seeds from the preference exactly as it does in Node.
    delete document.documentElement.dataset.theme;
    report.html = renderToString(stub);
    const served = new DOMParser().parseFromString(report.html, "text/html");
    document.replaceChild(document.importNode(served.documentElement, true), document.documentElement);
    document.documentElement.dataset.theme = bootTheme;
    const read = watchTheme();
    await act(async () => {
      startTransition(() => {
        hydrated = hydrateRoot(document, stub, {
          onRecoverableError: (error) => {
            report.recoverable.push(String(error));
          },
        });
      });
    });
    // The hydration commit's passive effects: the App effect's first apply.
    await act(async () => {});
    report.written = read();
  } finally {
    consoleError.mockRestore();
  }
  return report;
}

describe("root Layout: setDocumentTheme is the one writer of data-theme (ruling 283)", () => {
  const originalMatchMedia = window.matchMedia;
  beforeEach(() => {
    // ScrollRestoration scrolls on navigation; jsdom reports scrollTo as not
    // implemented, which is noise here, not something the code under test did.
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        media: query,
        matches: osDark,
        addEventListener() {},
        removeEventListener() {},
      }),
    });
  });
  afterEach(async () => {
    const root = hydrated;
    hydrated = null;
    if (root) await act(async () => root.unmount());
    vi.restoreAllMocks();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  });

  it("serves the preference, then hydrates over the boot script's theme with no mismatch and no write", async () => {
    saved = "system";
    osDark = true;
    const report = await serveAndHydrate("dark");
    // First paint is the server's: "system" starts light, the boot script
    // corrects it before paint.
    expect(report.html).toMatch(/^<html lang="en" data-theme="light">/);
    expect(report.recoverable).toEqual([]);
    expect(report.warnings.filter((w) => /hydrat|didn.t match/i.test(w))).toEqual([]);
    // Hydration adopts what the boot script painted, and the App effect's
    // first apply finds it already right.
    expect(report.written).toEqual([]);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("Dark -> System on a dark OS never writes the light theme", async () => {
    saved = "dark";
    osDark = true;
    const report = await serveAndHydrate("dark");
    expect(report.html).toMatch(/^<html lang="en" data-theme="dark">/);
    const read = watchTheme();
    fireEvent.click(page().getByRole("button", { name: "System" }));
    // The revalidated preference is committed: this is the commit that wrote
    // "light" onto <html> while the Layout rendered the attribute live.
    await page().findByText("saved: system");
    await act(async () => {});
    // CANARY: render `data-theme={theme === "dark" ? "dark" : "light"}` again
    // and this reads ["light", "fade", "dark"]: a light frame, then the fade back.
    expect(read()).toEqual([]);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("a pick saved in another tab lands through the one-clock fade", async () => {
    saved = "light";
    osDark = false;
    await serveAndHydrate("light");
    const read = watchTheme();
    // Another tab saves Dark; this tab's next revalidation (any mutation) reads it.
    saved = "dark";
    fireEvent.click(page().getByRole("button", { name: "Revalidate" }));
    await page().findByText("saved: dark");
    await act(async () => {});
    // CANARY: the live attribute reads ["dark"] here: React wrote it with
    // every rule on its own clock, and setDocumentTheme then found nothing to do.
    expect(read()).toEqual(["fade", "dark"]);
    // The override lifts once the colours have landed.
    await waitFor(() =>
      expect(
        [...document.head.querySelectorAll("style")].filter((s) =>
          (s.textContent ?? "").startsWith("*,*::before,*::after{transition:"),
        ),
      ).toEqual([]),
    );
  });

  it("the ErrorBoundary swap re-acquires <html> with the theme on screen, not the loader's", async () => {
    saved = "system";
    osDark = true;
    await serveAndHydrate("dark");
    const read = watchTheme();
    // A client navigation to a 404: the root swaps to its ErrorBoundary, which
    // remounts Layout, and React strips <html> and acquires it again. No App
    // effect runs on that page to put a wrong theme right.
    fireEvent.click(page().getByRole("link", { name: "Gone" }));
    await page().findByText("Page not found");
    await act(async () => {});
    // CANARY: seed from the preference alone and this ends on "light".
    expect(read()).not.toContain("light");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
