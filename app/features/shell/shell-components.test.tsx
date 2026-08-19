// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ComponentProps } from "react";
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
  };
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

/**
 * P16-UI-12 — both shell popovers moved from a hand-rolled `window` keydown
 * listener to the shared `useDismiss` hook. They pass `{ outside: false }`,
 * which is not an oversight: the account menu is meant to be cycled in place
 * (the Theme item deliberately does not close it) and the bell closes on an
 * explicit action. Converting them to the hook's DEFAULT would silently take
 * that away, and nothing would have noticed — so it is asserted here.
 */
describe("P16-UI-12: the shell popovers dismiss on Escape, not on any press", () => {
  function openMenu() {
    const view = renderIn(
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
    fireEvent.click(view.getByLabelText("Account menu"));
    expect(view.container.querySelector(".user-menu")).not.toBeNull();
    return view;
  }

  it("the account menu survives an outside press (theme cycling in place)", () => {
    const { container } = openMenu();
    fireEvent.mouseDown(document.body);
    expect(container.querySelector(".user-menu")).not.toBeNull();
  });

  it("the account menu closes on Escape from anywhere", () => {
    const { container } = openMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector(".user-menu")).toBeNull();
  });

  it("the bell popover survives an outside press and closes on Escape", () => {
    const { getByLabelText, container } = renderIn(
      <TopBell notifications={[notification(1)]} unread={1} />,
    );
    fireEvent.click(getByLabelText(/Notifications/));
    fireEvent.mouseDown(document.body);
    expect(container.querySelector("dialog.ntf-pop")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector("dialog.ntf-pop")).toBeNull();
  });
});

describe("Topbar: UI-03 paused chip + UI-55 shortcut hint", () => {
  const topbar = (props: Partial<ComponentProps<typeof Topbar>> = {}) => (
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

/**
 * R15-5 — the topbar box is the ⌘K palette trigger, not a board filter.
 * F15-18 — the rail collapses behind a topbar toggle on mobile.
 */
describe("Topbar: palette trigger + rail toggle", () => {
  it("is a button that opens the palette, not an input that filtered the board", () => {
    const { container, getByLabelText } = topbarAt("/projects/viberr-core/board");
    const trigger = getByLabelText("Search tasks, branches, agents, projects");
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    // The old input lived here and wrote ?q= on every keystroke.
    expect(container.querySelector(".top-search input")).toBeNull();
    fireEvent.click(trigger);
    expect(container.querySelector("dialog.cmdk-card")).toBeTruthy();
  });

  it("opens the palette on ⌘K / Ctrl-K", () => {
    const { container } = topbarAt("/projects/viberr-core/board");
    expect(container.querySelector("dialog.cmdk-card")).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(container.querySelector("dialog.cmdk-card")).toBeTruthy();
  });

  it("renders the rail toggle only when the layout supplies one", () => {
    const { queryByLabelText } = topbarAt("/projects/viberr-core/board");
    expect(queryByLabelText("Project navigation")).toBeNull();
  });

  it("reports the rail's open state to assistive tech", () => {
    let toggled = 0;
    const { getByLabelText } = renderAt(
      <Topbar
        projectSlug="viberr-core"
        projectName="Viberr Core"
        openTask={null}
        user={USER}
        theme="system"
        notifications={[]}
        unread={0}
        railOpen={false}
        onToggleRail={() => (toggled += 1)}
      />,
      "/projects/viberr-core/board",
    );
    const toggle = getByLabelText("Project navigation");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggled).toBe(1);
  });
});

/**
 * UI-C (inventory rough edge #15) — the mobile rail overlay's dismiss layer was
 * a `<button aria-hidden="true" tabIndex={-1}>`: an interactive element hidden
 * from assistive tech, and the ONLY dismissal besides re-pressing the toggle.
 * The scrim is now a decorative div (`routes/project.tsx`) and this is the
 * keyboard half — Escape closes the overlay and puts focus back where it came
 * from, which is what a scrim could never do.
 */
describe("F15-18/UI-C: the mobile rail overlay has a keyboard way out", () => {
  function railOverlayAt(railOpen: boolean) {
    let toggled = 0;
    const utils = renderAt(
      <Topbar
        projectSlug="viberr-core"
        projectName="Viberr Core"
        openTask={null}
        user={USER}
        theme="system"
        notifications={[]}
        unread={0}
        railOpen={railOpen}
        onToggleRail={() => (toggled += 1)}
      />,
      "/projects/viberr-core/board",
    );
    return { ...utils, toggles: () => toggled };
  }

  it("closes the open rail on Escape and returns focus to the toggle", () => {
    const { getByLabelText, toggles } = railOverlayAt(true);
    const toggle = getByLabelText("Project navigation");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(window, { key: "Escape" });

    expect(toggles()).toBe(1);
    expect(document.activeElement).toBe(toggle);
  });

  it("leaves Escape alone while the rail is closed", () => {
    const { toggles } = railOverlayAt(false);
    fireEvent.keyDown(window, { key: "Escape" });
    // Escape belongs to whatever dialog or popover is open; the rail must not
    // consume it just because the shell is on screen.
    expect(toggles()).toBe(0);
  });
});
