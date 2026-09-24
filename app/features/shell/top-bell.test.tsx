// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub, redirect, useRevalidator, type LoaderFunctionArgs } from "react-router";
import { ToastProvider } from "~/ui/toast";
import type { NotificationListItem } from "~/server/projections/notifications.server";
import * as listRoute from "~/routes/resources.notifications";
import { BELL_LIST_URL, TopBell } from "./top-bell";

/**
 * Ruling 454 (FL-4 / SRV-6): the bell loads its own list. These pin what the
 * list is allowed to be when the popover shows it: never older than the counts
 * the page last read (review finding bell-stale-list-count-key), and never a
 * reason to lose the page (bell-hover-error-boundary).
 */

afterEach(cleanup);

/** A row as the list route answers it (`listNotifications`). */
function notification(i: number): NotificationListItem {
  return {
    id: `n-${i}`,
    userId: "u-arda",
    kind: "mention",
    ptype: null,
    title: `Notification ${i}`,
    text: "something happened",
    from: null,
    projectSlug: "viberr-core",
    projectName: "Viberr Core",
    taskKey: "VIB-142",
    occurredAt: new Date().toISOString(),
    unread: true,
    readAt: null,
    waitingOnYou: false,
    href: "/projects/viberr-core/tasks/VIB-142",
    targetMissing: false,
  };
}

type ListAnswer = { notifications: NotificationListItem[] };

/**
 * The server as the page and the bell see it: the counts the workspace
 * layout's loader reads and the rows the list route answers, both changeable
 * between loads. The page's route carries the layout's id, so the bell sees
 * the counts come from a route that reads the bell (`REVALIDATION_RULES`).
 */
function mountWorkspace(server: { unread: number; list: NotificationListItem[] }) {
  const listLoads: string[] = [];
  let revalidate: () => Promise<void> = async () => {};
  const Stub = createRoutesStub([
    {
      id: "routes/project",
      path: "/",
      loader: () => ({ unread: server.unread, orphanUnread: 0 }),
      Component: ({ loaderData }) => {
        // SAFETY: this route's own loader, above, answers exactly these counts.
        const counts = loaderData as { unread: number; orphanUnread: number };
        revalidate = useRevalidator().revalidate;
        return (
          <ToastProvider>
            <TopBell unread={counts.unread} orphanUnread={counts.orphanUnread} />
          </ToastProvider>
        );
      },
    },
    {
      path: BELL_LIST_URL,
      loader: ({ request }): ListAnswer => {
        listLoads.push(request.url);
        return { notifications: [...server.list] };
      },
      // As the real route: a page revalidation never reloads the list.
      shouldRevalidate: listRoute.shouldRevalidate,
    },
  ]);
  const view = render(<Stub initialEntries={["/"]} />);
  return {
    ...view,
    listLoads,
    /** A live event reached the page: its loaders re-read the counts. */
    revalidate: () => act(() => revalidate()),
  };
}

const bellOf = (view: ReturnType<typeof render>) => view.getByLabelText(/^Notifications/);

async function listSettled(view: ReturnType<typeof render>) {
  await waitFor(() =>
    expect(view.container.querySelector(".ntf-pop-list")!.getAttribute("aria-busy")).toBe("false"),
  );
}

describe("the bell's list is never older than the counts it sits under (ruling 454)", () => {
  it("reloads on open when the counts were re-read since, even if they came back the same", async () => {
    const server = { unread: 1, list: [notification(1)] };
    const view = await mountWorkspaceReady(server);
    fireEvent.pointerEnter(bellOf(view));
    await waitFor(() => expect(view.listLoads).toHaveLength(1));
    // Closed: another maintainer resolves the packet behind n-1 (read for
    // everyone, the page revalidates to 0), then the operator raises a new
    // one (back to 1). The counts left their value and came back to it.
    server.unread = 0;
    server.list = [];
    await view.revalidate();
    server.unread = 1;
    server.list = [notification(2)];
    await view.revalidate();
    await waitFor(() => expect(bellOf(view).getAttribute("aria-label")).toBe("Notifications, 1 unread"));
    fireEvent.pointerEnter(bellOf(view));
    fireEvent.click(bellOf(view));
    await listSettled(view);
    expect(view.listLoads).toHaveLength(2);
    expect(view.getByText("Notification 2")).toBeTruthy();
    expect(view.queryByText("Notification 1")).toBeNull();
  });

  it("while open, reloads whenever the page re-reads the counts", async () => {
    const server = { unread: 1, list: [notification(1)] };
    const view = await mountWorkspaceReady(server);
    fireEvent.click(bellOf(view));
    await listSettled(view);
    expect(view.listLoads).toHaveLength(1);
    // One debounced revalidation spans an offer withdrawn and re-offered: the
    // count is the same, the row is not.
    server.list = [notification(3)];
    await view.revalidate();
    await waitFor(() => expect(view.getByText("Notification 3")).toBeTruthy());
    expect(view.queryByText("Notification 1")).toBeNull();
    expect(view.listLoads).toHaveLength(2);
  });

  it("an open right after the pointer's arrival still needs no second fetch", async () => {
    const view = await mountWorkspaceReady({ unread: 1, list: [notification(1)] });
    fireEvent.pointerEnter(bellOf(view));
    await waitFor(() => expect(view.listLoads).toHaveLength(1));
    fireEvent.click(bellOf(view));
    await listSettled(view);
    expect(view.getByText("Notification 1")).toBeTruthy();
    expect(view.listLoads).toHaveLength(1);
  });
});

/** Mounts the workspace and waits for its first render. */
async function mountWorkspaceReady(server: { unread: number; list: NotificationListItem[] }) {
  const view = mountWorkspace(server);
  await waitFor(() => expect(bellOf(view)).toBeTruthy());
  return view;
}

/**
 * The list route as React Router's framework mode runs it for a fetcher load
 * (react-router `lib/dom/ssr/routes.js`, `createClientRoutes`): the module's
 * `clientLoader` with the server call handed to it, or the server call alone
 * when the module has none. `server` stands in for that call.
 */
function listLoaderOver(server: () => Promise<ListAnswer>) {
  return (args: LoaderFunctionArgs) =>
    listRoute.clientLoader?.({ ...args, serverLoader: server }) ?? server();
}

function mountFailing(server: () => Promise<ListAnswer>) {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ToastProvider>
          <p>PAGE CONTENT</p>
          <TopBell unread={1} orphanUnread={0} />
        </ToastProvider>
      ),
    },
    { path: BELL_LIST_URL, loader: listLoaderOver(server), shouldRevalidate: listRoute.shouldRevalidate },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

describe("a failed list load stays in the bell (ruling 454)", () => {
  for (const [failure, reject] of [
    ["a 503 during a restart", () => Promise.reject(new Response("down", { status: 503 }))],
    ["a network rejection", () => Promise.reject(new TypeError("Failed to fetch"))],
    // Review finding bell-hover-login-returnto-resource: a dead session's
    // login redirect, as the route answered it before its 401, is not
    // followed from a hover either (the stub has no /login: a navigation
    // would lose the page).
    ["a login redirect", () => Promise.reject(redirect("/login?returnTo=%2Fresources%2Fnotifications"))],
  ] as const) {
    it(`a hover that meets ${failure} keeps the page, and the open says so and retries`, async () => {
      let calls = 0;
      let up = false;
      const view = mountFailing(() => {
        calls += 1;
        return up ? Promise.resolve({ notifications: [notification(1)] }) : reject();
      });
      fireEvent.pointerEnter(bellOf(view));
      await waitFor(() => expect(calls).toBe(1));
      // Let the failed load land.
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(view.getByText("PAGE CONTENT")).toBeTruthy();
      // The open retries the failed load and says it failed.
      fireEvent.click(bellOf(view));
      await waitFor(() => expect(calls).toBe(2));
      await waitFor(() => expect(view.getByText(/Couldn't load notifications/)).toBeTruthy());
      expect(view.getByText("PAGE CONTENT")).toBeTruthy();
      expect(view.queryByText("Loading notifications…")).toBeNull();
      // Back up: Try again fills the list.
      up = true;
      fireEvent.click(view.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(view.getByText("Notification 1")).toBeTruthy());
      expect(view.queryByText(/Couldn't load notifications/)).toBeNull();
      expect(calls).toBe(3);
    });
  }
});
