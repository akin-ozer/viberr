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
  decisionCount: 1,
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

  /**
   * R14-3: mark-all-read owns its own fetcher. Sharing ONE with the per-row
   * read meant a row click aborted an in-flight mark-all, and React Router
   * discards an aborted submission's result — so the submit-time flag was never
   * cleared and the ROW read's result fired the mark-all handler, toasting
   * "All notifications marked read" for a request that was cancelled.
   */
  it("a row Mark read cannot make an aborted Mark all read report success", async () => {
    // The mark-all FAILS server-side and the row read succeeds. Sharing one
    // fetcher, the row's submit aborts the mark-all, its `{ok:true}` reaches
    // the mark-all handler, and the user is told it worked — the failure branch
    // is unreachable. With its own fetcher the mark-all reports its own result.
    // SAFETY: same contract as `renderOverlay` above — `Notifications` reads
    // only `loaderData`, and that value is checked against the route's own
    // loader data type, so the rest of the props the router supplies at runtime
    // is unobservable here.
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
      {
        path: "/notifications/read",
        action: async ({ request }) => {
          const fd = await request.formData();
          return fd.get("intent") === "read-all"
            ? { ok: false, error: "Your session expired — sign in again." }
            : { ok: true };
        },
      },
    ]);
    const { container, getByText, getAllByText } = render(
      <Stub initialEntries={["/notifications"]} />,
    );

    fireEvent.click(getByText("Mark all read"));
    // Before the POST settles the rows still render unread, so a row click
    // passes the `!item.unread` guard and submits.
    fireEvent.click(getAllByText("Mark read")[0]!);

    await waitFor(() =>
      expect(container.querySelector(".toast")).not.toBeNull(),
    );
    const toast = container.querySelector(".toast")!;
    expect(toast.getAttribute("data-kind")).toBe("error");
    expect(toast.textContent).toContain("Your session expired");
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

/**
 * B-FD6: `listNotifications` resolves a destination for every row — a task
 * page, a project board, or null — and both surfaces ignored it, re-deriving
 * navigability as `projectSlug && taskKey`. A project-scoped row (a failing
 * GitHub sync, a completed goal) therefore rendered as a live-looking control
 * that navigated nowhere.
 */
describe("notifications overlay: row destinations come from href", () => {
  const rowWith = (over: Partial<(typeof LOADER_DATA)["notifications"][number]>) => ({
    ...LOADER_DATA.notifications[0]!,
    ...over,
  });

  function renderRows(
    notifications: (typeof LOADER_DATA)["notifications"],
  ) {
    // SAFETY: same contract as `renderOverlay` above — the component reads only
    // `loaderData`, and that value is checked against the route's loader type.
    const props = {
      loaderData: { ...LOADER_DATA, notifications, unread: 0 },
    } as Route.ComponentProps;
    let path = "/notifications";
    const Stub = createRoutesStub([
      {
        path: "/notifications",
        Component: () => (
          <ToastProvider>
            <Notifications {...props} />
          </ToastProvider>
        ),
      },
      {
        path: "/projects/:slug",
        Component: () => {
          path = "/projects/board";
          return <div>board</div>;
        },
      },
      { path: "/notifications/read", action: () => ({ ok: true }) },
    ]);
    const utils = render(<Stub initialEntries={["/notifications"]} />);
    return { ...utils, wentTo: () => path };
  }

  it("a project-scoped row opens that project's board", async () => {
    const { container, wentTo } = renderRows([
      rowWith({
        id: "n-proj",
        taskKey: null,
        title: "GitHub sync is failing for this project",
        href: "/projects/viberr-core",
        unread: false,
      }),
    ]);
    // The row body marks read; the "key" button is the navigable control.
    const keybtn = container.querySelector(".ntf-ev .keybtn")!;
    expect(keybtn.textContent).toBe("Viberr Core"); // no trailing separator
    fireEvent.click(keybtn);
    await waitFor(() => expect(wentTo()).toBe("/projects/board"));
  });

  it("a row with no destination is marked non-navigable rather than looking live", () => {
    const { container } = renderRows([
      rowWith({
        id: "n-org",
        projectSlug: null,
        projectName: null,
        taskKey: null,
        title: "An org-wide notice",
        href: null,
        unread: false,
      }),
    ]);
    const row = container.querySelector(".ntf-ev")!;
    // The key button is the navigable control; with no destination the row
    // must not present one at all.
    expect(row.querySelector(".keybtn")).toBeNull();
  });
});
