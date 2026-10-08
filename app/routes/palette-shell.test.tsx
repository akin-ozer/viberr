// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import PaletteShell from "./palette-shell";

/**
 * Ruling 145 — the layout that puts the app header on the standalone pages.
 *
 * The loader decides WHAT the header shows (`palette-shell.server.test.ts`);
 * this is the other half: the header is on the page routes and absent from the
 * ones that render their own chrome, and the page below it is untouched either
 * way. The two overlay routes are the case that matters — a header behind a
 * `showModal()` dialog that covers the viewport is a dimmed sliver, not a
 * header.
 */

afterEach(cleanup);

/** The header as the layout's loader answers it, so the fixture cannot drift
 *  from what a page route is handed (ruling 457 took the bell's list out). */
type ShellHeader = NonNullable<Parameters<typeof PaletteShell>[0]["loaderData"]["header"]>;

const HEADER: ShellHeader = {
  user: {
    id: "u",
    name: "Arda Kaya",
    email: "arda@viberr.dev",
    role: "admin",
    avatarTone: "",
  },
  unread: 0,
  orphanUnread: 0,
};

function renderShell(
  path: string,
  header: ShellHeader | null,
) {
  // SAFETY: the layout reads `loaderData` and nothing else. React Router's
  // generated ComponentProps also carries `params`, `actionData` and `matches`,
  // which only a real router can build.
  const props = { loaderData: { header } } as Parameters<typeof PaletteShell>[0];
  // The layout wraps a real child route: the page below it must render either
  // way, and asserting that is what makes a broken header FAIL here — React
  // Router answers a crash inside the layout with its default error boundary,
  // which renders no header at all and would otherwise read as "no header on
  // this route, as intended".
  //
  // No root loader: the stub would then need a HydrateFallback, and the theme
  // the header passes on is the root payload's, which falls back to "system"
  // exactly as it does before the root loader has answered.
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ToastProvider>
          <PaletteShell {...props} />
        </ToastProvider>
      ),
      children: [
        {
          path: path.slice(1),
          Component: () => <main data-testid="page">the page</main>,
        },
      ],
    },
  ]);
  return render(<Stub initialEntries={[path]} />);
}

describe("the standalone-page layout mounts the header (ruling 145)", () => {
  it("renders it on a page route, above the page", () => {
    const { container, getByRole, getByTestId } = renderShell(
      "/org/settings",
      HEADER,
    );
    expect(getByTestId("page"), "the page itself still renders").toBeTruthy();
    expect(container.querySelector("header.home-top")).toBeTruthy();
    expect(getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain(
      "Instance settings",
    );
    // The skip target sits BELOW the header, so the bypass link skips the
    // header's own tab stops rather than only the page's.
    const shell = container.querySelector(".home")!;
    const order = [...shell.children].map((el) => el.tagName + "." + el.className);
    expect(order[1]).toBe("HEADER.home-top");
    const target = shell.querySelector("#main-content")!;
    expect(target).toBeTruthy();
    expect(
      target.compareDocumentPosition(container.querySelector("header.home-top")!) &
        Node.DOCUMENT_POSITION_PRECEDING,
      "the skip target must come after the header",
    ).toBeTruthy();
  });

  it("renders none on the overlay routes, and nothing else changes", () => {
    // The loader already answered `null` here; this is the render half of the
    // same decision, so a future page added to the layout cannot pick up a
    // header by accident.
    const { container, getByTestId } = renderShell("/profile", null);
    expect(getByTestId("page"), "the page itself still renders").toBeTruthy();
    expect(container.querySelector("header.home-top")).toBeNull();
    expect(container.querySelector(".home")).toBeNull();
  });

  it("keeps the page mounted when a revalidation arrives without a header", () => {
    // THE bug this pins: the tree's shape used to depend on the loader data, so
    // a revalidation that came back without a header swapped the whole shell
    // for a fragment. React unmounted everything below the Outlet, and the
    // org-settings file browser someone had open closed itself mid-edit. The
    // page's own shell must survive: only the header bar is missing.
    const { container, getByTestId } = renderShell("/insights", null);
    expect(getByTestId("page"), "the page itself still renders").toBeTruthy();
    expect(container.querySelector(".home"), "the shell stays").toBeTruthy();
    expect(container.querySelector("header.home-top")).toBeNull();
  });
});
