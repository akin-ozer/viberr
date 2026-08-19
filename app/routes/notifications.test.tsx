// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import type { Route } from "./+types/notifications";
import { ToastProvider } from "~/ui/toast";
import Notifications from "./notifications";

/**
 * P13-D-10 (UX-5): the /notifications overlay's mark-all-read handler already
 * reported failures honestly (P11-40) but pushed them with `push`'s default
 * `"success"` kind — the bell's twin handler in `top-bell.tsx` passed the kind,
 * this one did not.
 */

afterEach(cleanup);

const LOADER_DATA: Route.ComponentProps["loaderData"] = {
  notifications: [
    {
      id: "n-1",
      userId: "u-arda",
      kind: "policy",
      ptype: null,
      title: "VIB-142",
      text: "something happened",
      from: null,
      projectSlug: "viberr-core",
      projectName: "Viberr Core",
      taskKey: "VIB-142",
      occurredAt: "2026-07-01T09:00:00.000Z",
      unread: true,
      readAt: null,
      waitingOnYou: false,
      href: "/projects/viberr-core/tasks/VIB-142",
      targetMissing: false,
    },
  ],
  unread: 1,
  truncated: false,
  limit: 200,
};

function renderOverlay(result: { ok: boolean; error?: string }) {
  // SAFETY: `Notifications` destructures `loaderData` and reads nothing else
  // off its props — no params, matches or actionData appear in its body — so
  // the remainder the router supplies at runtime is unobservable here.
  // `loaderData` itself is checked against the route's real loader data above.
  const props = { loaderData: LOADER_DATA } as Route.ComponentProps;
  const Stub = createRoutesStub([
    {
      path: "/notifications",
      Component: () => (
        <ToastProvider>
          <Notifications {...props} />
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
