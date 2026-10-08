// @vitest-environment jsdom
import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ErrorBoundary } from "./root";

afterEach(cleanup);

/** What a guard can throw as a route error's `data`: user-facing page copy, the
 *  router's own null for an unmatched URL, or a JSON error body. */
type ThrownErrorData =
  | string
  | null
  | { error?: { code: string; message?: string } };

/**
 * Shape-matches react-router's ErrorResponse — what `isRouteErrorResponse`
 * duck-types (status + statusText + internal + data). Loader `throw
 * data("<message>", { status })` reaches the boundary in exactly this form.
 */
interface RouteErrorResponse {
  status: number;
  statusText: string;
  internal: boolean;
  data: ThrownErrorData;
}

function routeError(
  status: number,
  data: ThrownErrorData,
  statusText = "",
): RouteErrorResponse {
  return { status, statusText, internal: false, data };
}

function renderBoundary(error: RouteErrorResponse) {
  return render(<ErrorBoundary error={error} params={{}} />);
}

describe("root ErrorBoundary (route error responses)", () => {
  it("renders the thrown denial message on a 403, not statusText boilerplate", () => {
    // requireProjectMember throws data(error.userMessage, { status: 403 }) —
    // the non-member must read WHY, not "Error 403 Internal Server Error".
    const { container } = renderBoundary(
      routeError(
        403,
        "Only project members can view this project's policy.",
        "Internal Server Error",
      ),
    );
    // writ-1: the title says what happened to the reader, not the status.
    expect(container.querySelector("h2")!.textContent).toBe(
      "You don't have access to this page",
    );
    expect(container.querySelector(".detail-line")!.textContent).toBe(
      "Only project members can view this project's policy.",
    );
  });

  it("prefers the thrown message over the generic copy on a 404", () => {
    const { container } = renderBoundary(
      routeError(404, "No project at projects/ghost."),
    );
    expect(container.querySelector("h2")!.textContent).toBe("Page not found");
    expect(container.querySelector(".detail-line")!.textContent).toBe(
      "No project at projects/ghost.",
    );
  });

  it("keeps the generic 404 copy when the router 404s without a message", () => {
    // Unmatched URLs produce a router-internal 404 with null data.
    const { container } = renderBoundary(routeError(404, null, "Not Found"));
    expect(container.querySelector(".detail-line")!.textContent).toBe(
      "The page you are looking for does not exist.",
    );
  });

  it("keeps the generic 404 copy over the router's own 'No route matches' diagnostic", () => {
    // Live, an unmatched URL's 404 carries the router's diagnostic string, not
    // null, and it used to become the page's sentence (interface review 2026-09-24).
    const { container } = renderBoundary(
      routeError(404, 'Error: No route matches URL "/nope-404"', "Not Found"),
    );
    expect(container.querySelector(".detail-line")!.textContent).toBe(
      "The page you are looking for does not exist.",
    );
    expect(document.title).toBe("Page not found · Viberr");
  });

  it("D32-15: shows the reason from requireRole's JSON envelope, not 'Forbidden'", () => {
    // requireRole answers page requests with the API envelope; a non-admin
    // opening /org/settings used to learn THAT they were refused, never WHY.
    // Canary: make `thrownMessage` a bare `z.string()` again and this reads
    // "Forbidden".
    const { container } = renderBoundary(
      routeError(
        403,
        {
          error: {
            code: "forbidden",
            message:
              "Only org admins can open this page. Ask an org admin for access.",
          },
        },
        "Forbidden",
      ),
    );
    expect(container.querySelector(".detail-line")!.textContent).toBe(
      "Only org admins can open this page. Ask an org admin for access.",
    );
  });

  it("writ-1: never shows statusText; the generic copy says how to recover", () => {
    // An envelope WITHOUT a message is transport noise, not page copy — and
    // so is statusText: "Forbidden" names no way out.
    const recover =
      "Reload the page to try again. If it keeps failing, go back to Home.";
    const { container: withStatusText } = renderBoundary(
      routeError(403, { error: { code: "forbidden" } }, "Forbidden"),
    );
    expect(
      withStatusText.querySelector(".detail-line")!.textContent,
    ).toBe(recover);

    const { container: bare } = renderBoundary(
      routeError(500, {}, "Internal Server Error"),
    );
    expect(bare.querySelector("h2")!.textContent).toBe(
      "Unable to load this page",
    );
    expect(bare.querySelector(".detail-line")!.textContent).toBe(recover);
  });

  it("writ-1: a thrown non-route error gets the same recoverable copy", () => {
    const { container } = render(
      <ErrorBoundary error={"not an Error"} params={{}} />,
    );
    expect(container.querySelector("h2")!.textContent).toBe(
      "Unable to load this page",
    );
    expect(container.querySelector(".detail-line")!.textContent).toBe(
      "Reload the page to try again. If it keeps failing, go back to Home.",
    );
  });
});

/**
 * Ruling 458(d): the error page shows the id of the request that failed, so a
 * person can quote it and the server's log line can be found. Root's data
 * carries the DOCUMENT request's id, which belongs to the error only when that
 * error came with the document: its server render and the hydration of that
 * markup. Root does not re-run on a navigation, so an error met later sits
 * beside an earlier request's id and must show none rather than a wrong one.
 * The server render itself, with root's real loader and without its data, is
 * `entry.server.test.ts`'s, through React Router's own handler.
 */
describe("root ErrorBoundary request id (ruling 458(d))", () => {
  const documentData = {
    theme: "system",
    csrf: null,
    liveHead: 0,
    requestId: "a1b2c3d4e5f6",
  } as const;
  const serverError = new Error("Unexpected Server Error");
  const boundary = (error: Error, loaderData?: typeof documentData) => (
    <ErrorBoundary error={error} params={{}} loaderData={loaderData} />
  );

  describe("after hydration", () => {
    let container: HTMLDivElement;
    let root: Root | null = null;
    afterEach(() => {
      act(() => root?.unmount());
      root = null;
      container.remove();
    });

    async function hydrate(element: React.ReactElement): Promise<() => void> {
      container = document.createElement("div");
      container.innerHTML = renderToString(element);
      document.body.append(container);
      const mismatch = vi.fn();
      await act(async () => {
        root = hydrateRoot(container, element, { onRecoverableError: mismatch });
      });
      return () => expect(mismatch).not.toHaveBeenCalled();
    }

    it("hydration keeps the id: the same markup, no mismatch", async () => {
      const noMismatch = await hydrate(boundary(serverError, documentData));
      expect(container.textContent).toContain("Request id: a1b2c3d4e5f6");
      noMismatch();
    });

    it("a later error in the hydrated boundary shows none", async () => {
      await hydrate(boundary(serverError, documentData));
      await act(async () => root?.render(boundary(new Error("a navigation failed"), documentData)));
      expect(container.textContent).not.toContain("Request id");
    });
  });

  it("a boundary mounted after hydration shows none: root's data is an earlier request's", () => {
    // CANARY: show `loaderData.requestId` unconditionally and this reads the id.
    const { container } = render(boundary(serverError, documentData));
    expect(container.textContent).not.toContain("Request id");
  });
});
