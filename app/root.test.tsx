// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ErrorBoundary } from "./root";

afterEach(cleanup);

/** What a guard can throw as a route error's `data`: user-facing page copy, the
 *  router's own null for an unmatched URL, or a JSON error body. */
type ThrownErrorData = string | null | { error?: { code: string } };

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
    expect(container.querySelector("h2")!.textContent).toBe("Error 403");
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

  it("falls back to statusText, then generic copy, for non-string data", () => {
    // requireRole throws a JSON body ({ error: {...} }) — not page copy.
    const { container: withStatusText } = renderBoundary(
      routeError(403, { error: { code: "forbidden" } }, "Forbidden"),
    );
    expect(
      withStatusText.querySelector(".detail-line")!.textContent,
    ).toBe("Forbidden");

    const { container: bare } = renderBoundary(routeError(500, {}));
    expect(bare.querySelector(".detail-line")!.textContent).toBe(
      "An unexpected error occurred.",
    );
  });
});
