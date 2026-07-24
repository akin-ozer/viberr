// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type React from "react";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import Notifications from "./notifications";

/**
 * P13-D-10 (UX-5): the /notifications overlay's mark-all-read handler already
 * reported failures honestly (P11-40) but pushed them with `push`'s default
 * `"success"` kind — the bell's twin handler in `top-bell.tsx` passed the kind,
 * this one did not.
 */

afterEach(cleanup);

const LOADER_DATA = {
  notifications: [
    {
      id: "n-1",
      kind: "comment",
      ptype: null,
      title: "VIB-142",
      text: "something happened",
      projectSlug: "viberr-core",
      projectName: "Viberr Core",
      taskKey: "VIB-142",
      occurredAt: "2026-07-01T09:00:00.000Z",
      unread: true,
    },
  ],
  unread: 1,
  truncated: false,
  limit: 200,
};

function renderOverlay(result: { ok: boolean; error?: string }) {
  const Stub = createRoutesStub([
    {
      path: "/notifications",
      Component: () => (
        <ToastProvider>
          {/* The route component only reads `loaderData`. The rest of
              Route.ComponentProps (params, matches, actionData) is supplied by
              the framework at runtime and unused here — `as never` for the
              spread is not a valid object type, so narrow through `unknown`. */}
          <Notifications
            {...({ loaderData: LOADER_DATA } as unknown as React.ComponentProps<
              typeof Notifications
            >)}
          />
        </ToastProvider>
      ),
    },
    { path: "/notifications/read", action: () => result },
  ]);
  return render(<Stub initialEntries={["/notifications"]} />);
}

describe("notifications overlay: mark-all-read feedback", () => {
  it("renders a failed mark-all-read with the failure glyph", async () => {
    const { container, getByText } = renderOverlay({
      ok: false,
      error: "Your session expired — sign in again.",
    });
    fireEvent.click(getByText("Mark all read"));
    await waitFor(() =>
      expect(container.querySelector(".toast")).not.toBeNull(),
    );
    const toast = container.querySelector(".toast")!;
    expect(toast.textContent).toContain("Your session expired");
    expect(toast.getAttribute("data-kind")).toBe("error");
  });

  it("keeps the success tick when the read really landed", async () => {
    const { container, getByText } = renderOverlay({ ok: true });
    fireEvent.click(getByText("Mark all read"));
    await waitFor(() =>
      expect(container.querySelector(".toast")).not.toBeNull(),
    );
    const toast = container.querySelector(".toast")!;
    expect(toast.textContent).toContain("All notifications marked read");
    expect(toast.getAttribute("data-kind")).toBe("success");
  });
});
