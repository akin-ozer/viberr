// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import type { NotificationView } from "~/features/notifications/notification-item";
import { BELL_LIST_CAP, TopBell } from "./top-bell";
import { UserMenu } from "./user-menu";
import { Topbar } from "./topbar";
import { Rail } from "./rail";

/**
 * UI-26: `features/shell/*` had NO component tests. These cover the pass-13
 * shell fixes (UI-14 bell truncation, UI-45 popover focus + menu roles, UI-03
 * paused-stream chip, UI-55 platform-aware shortcut hint).
 */

afterEach(cleanup);

function notification(i: number): NotificationView {
  return {
    id: `n-${i}`,
    kind: "comment",
    ptype: null,
    title: `Notification ${i}`,
    text: "something happened",
    projectSlug: "viberr-core",
    projectName: "Viberr Core",
    taskKey: "VIB-142",
    occurredAt: new Date().toISOString(),
    unread: false,
  } as NotificationView;
}

function renderIn(node: React.ReactNode) {
  const Stub = createRoutesStub([
    { path: "/", Component: () => <ToastProvider>{node}</ToastProvider> },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

describe("UI-14: the bell popover discloses its own cap", () => {
  it("says which slice it is showing once the list hits the loader cap", () => {
    const items = Array.from({ length: BELL_LIST_CAP }, (_, i) => notification(i));
    const { getByLabelText, getByText } = renderIn(
      <TopBell notifications={items} unread={150} />,
    );
    fireEvent.click(getByLabelText(/Notifications/));
    // The head claims 150 unread while the list holds 100 rows — before the fix
    // there was no notice at all that the list was truncated.
    expect(getByText("150 unread")).toBeTruthy();
    expect(getByText(`Showing the newest ${BELL_LIST_CAP}`)).toBeTruthy();
  });

  it("says nothing when the list is not capped", () => {
    const { getByLabelText, queryByText } = renderIn(
      <TopBell notifications={[notification(1)]} unread={1} />,
    );
    fireEvent.click(getByLabelText(/Notifications/));
    expect(queryByText(/Showing the newest/)).toBeNull();
  });
});

describe("UI-45: popovers rendered before their trigger move focus", () => {
  it("focuses the bell panel on open and restores the button on close", () => {
    const { getByLabelText, container } = renderIn(
      <TopBell notifications={[notification(1)]} unread={1} />,
    );
    const button = getByLabelText(/Notifications/);
    fireEvent.click(button);
    expect(document.activeElement).toBe(container.querySelector("dialog.ntf-pop"));
    fireEvent.click(button);
    expect(document.activeElement).toBe(button);
  });

  it("the account menu no longer declares menu roles it does not implement", () => {
    const { getByLabelText, container } = renderIn(
      <UserMenu
        user={{
          id: "u",
          name: "Arda Kaya",
          email: "arda@viberr.dev",
          role: "admin",
          avatarTone: "",
        }}
        theme="system"
      />,
    );
    fireEvent.click(getByLabelText("Account menu"));
    // It declared role="menu"/"menuitem" with NO arrow-key handling — a broken
    // ARIA contract. Plain buttons + links in Tab order is what it implements.
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(container.querySelector('[role="menuitem"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector(".user-menu"));
  });
});

describe("Topbar: UI-03 paused chip + UI-55 shortcut hint", () => {
  const topbar = (props: Record<string, unknown> = {}) => (
    <Topbar
      projectSlug="viberr-core"
      projectName="Viberr Core"
      openTask={null}
      user={{
        id: "u",
        name: "Arda Kaya",
        email: "arda@viberr.dev",
        role: "admin",
        avatarTone: "",
      }}
      theme="system"
      notifications={[]}
      unread={0}
      {...props}
    />
  );

  it("hides the paused chip while the stream is healthy", () => {
    const { queryByText } = renderIn(topbar());
    expect(queryByText(/live updates paused/)).toBeNull();
  });

  it("surfaces a dropped stream with a retry affordance", () => {
    let retried = 0;
    const { getByText } = renderIn(
      topbar({ livePaused: true, onReconnect: () => (retried += 1) }),
    );
    const chip = getByText(/live updates paused/);
    fireEvent.click(chip);
    expect(retried).toBe(1);
  });

  it("renders a shortcut hint (⌘K on mac, Ctrl K elsewhere)", () => {
    const { container } = renderIn(topbar());
    // jsdom's userAgent is not a mac, so the client effect corrects the SSR
    // ⌘K to the Ctrl form — the point of UI-55.
    expect(container.querySelector(".top-search .kbd")!.textContent).toBe("Ctrl K");
  });
});

/**
 * P13-D-35 / P13-D-37 — the shell's own navigation surfaces: returning to the
 * board must not silently reset the filter and search, and the current
 * location must be programmatic, not just visual.
 */

function renderAt(node: React.ReactNode, entry: string) {
  const Stub = createRoutesStub([
    { path: "/projects/:slug/board", Component: () => <ToastProvider>{node}</ToastProvider> },
    { path: "/projects/:slug/review", Component: () => <ToastProvider>{node}</ToastProvider> },
    {
      path: "/projects/:slug/tasks/:key",
      Component: () => <ToastProvider>{node}</ToastProvider>,
    },
  ]);
  return render(<Stub initialEntries={[entry]} />);
}

const USER = {
  id: "u",
  name: "Arda Kaya",
  email: "arda@viberr.dev",
  role: "admin",
  avatarTone: "",
};

function topbarAt(entry: string, openTask: { key: string; title: string } | null = null) {
  return renderAt(
    <Topbar
      projectSlug="viberr-core"
      projectName="Viberr Core"
      openTask={openTask}
      user={USER}
      theme="system"
      notifications={[]}
      unread={0}
    />,
    entry,
  );
}

function railAt(entry: string) {
  return renderAt(
    <Rail
      projectSlug="viberr-core"
      projectName="Viberr Core"
      projectRepo="akin-ozer/viberr"
      membersCount={3}
      boardCount={12}
      reviewCount={2}
      violations={0}
    />,
    entry,
  );
}

describe("P13-D-35: in-app paths back to the board keep filter and search", () => {
  it("keeps the project crumb pointed at the filtered board", () => {
    const { container } = topbarAt(
      "/projects/viberr-core/board?filter=risk&q=auth",
    );
    expect(container.querySelector(".crumb-root")!.getAttribute("href")).toBe(
      "/projects/viberr-core/board?filter=risk&q=auth",
    );
  });

  it("keeps the rail's Board item pointed at the filtered board", () => {
    const { getByText } = railAt("/projects/viberr-core/board?filter=human");
    expect(getByText("Board").closest("a")!.getAttribute("href")).toBe(
      "/projects/viberr-core/board?filter=human",
    );
    // Only the Board item owns URL state — the rest stay bare.
    expect(getByText("Review queue").closest("a")!.getAttribute("href")).toBe(
      "/projects/viberr-core/review",
    );
  });

  it("does not paste a task route's query onto the Board crumb or rail item", () => {
    const { container, getByText } = topbarAt(
      "/projects/viberr-core/tasks/VIB-1?tab=runs",
      { key: "VIB-1", title: "Attach a project credential" },
    );
    expect(container.querySelector(".crumb-mid")!.getAttribute("href")).toBe(
      "/projects/viberr-core/board",
    );
    expect(getByText("Viberr Core").getAttribute("href")).toBe(
      "/projects/viberr-core/board",
    );
  });
});

describe("P13-D-37: current location is programmatic, not just visual", () => {
  it("marks the rail's Board item aria-current on a task page", () => {
    // The product's deepest surface: `/projects/x/tasks/VIB-1` never matches
    // `to=".../board"`, so NavLink emitted no aria-current while the item was
    // visually highlighted — a WCAG 1.3.1 visual/programmatic mismatch.
    const { getByText } = railAt("/projects/viberr-core/tasks/VIB-1");
    const board = getByText("Board").closest("a")!;
    expect(board.classList.contains("active")).toBe(true);
    expect(board.getAttribute("aria-current")).toBe("page");
    expect(
      getByText("Review queue").closest("a")!.getAttribute("aria-current"),
    ).toBeNull();
  });

  it("marks the rail's Review item on the review route", () => {
    const { getByText } = railAt("/projects/viberr-core/review");
    expect(
      getByText("Review queue").closest("a")!.getAttribute("aria-current"),
    ).toBe("page");
    expect(getByText("Board").closest("a")!.getAttribute("aria-current")).toBeNull();
  });

  it("gives the crumb trail a landmark and a current-page marker", () => {
    const { container } = topbarAt("/projects/viberr-core/review");
    const crumbs = container.querySelector(".crumbs")!;
    expect(crumbs.tagName).toBe("NAV");
    expect(crumbs.getAttribute("aria-label")).toBe("Breadcrumb");
    const cur = crumbs.querySelector(".cur")!;
    expect(cur.getAttribute("aria-current")).toBe("page");
    expect(cur.textContent).toBe("Review queue");
  });

  it("marks the open task as the current crumb", () => {
    const { container } = topbarAt("/projects/viberr-core/tasks/VIB-1", {
      key: "VIB-1",
      title: "Attach a project credential",
    });
    const cur = container.querySelector(".crumbs .cur")!;
    expect(cur.getAttribute("aria-current")).toBe("page");
    expect(cur.textContent).toContain("VIB-1");
  });
});
