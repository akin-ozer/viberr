// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import type { NotificationView } from "~/features/notifications/notification-item";
import { BELL_LIST_CAP, TopBell } from "./top-bell";
import { UserMenu } from "./user-menu";
import { PageTopbar } from "./page-topbar";
import { LivePausedStrip, Topbar, WORKSPACE_PAUSED_SENTENCE } from "./topbar";
import { Rail } from "./rail";

/**
 * UI-26: `features/shell/*` had NO component tests. These cover the pass-13
 * shell fixes (UI-14 bell truncation, UI-45 popover focus + menu roles, UI-03
 * paused-stream chip, UI-55 platform-aware shortcut hint).
 */

afterEach(cleanup);

/** The bell list's resource route, as `routes.ts` mounts it. */
const LIST_ROUTE = "/resources/notifications";

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
    href: "/projects/viberr-core/tasks/VIB-142",
    occurredAt: new Date().toISOString(),
    unread: false,
  };
}

function renderIn(node: React.ReactNode, list: NotificationView[] = []) {
  const listLoads: string[] = [];
  const Stub = createRoutesStub([
    { path: "/", Component: () => <ToastProvider>{node}</ToastProvider> },
    // The account menu's Theme item really posts here. Without the route the
    // fetcher 404s and React Router's default ErrorBoundary replaces the whole
    // tree — which reads in a test exactly like the menu having closed.
    { path: "/prefs/theme", action: () => ({ ok: true, theme: "light" }) },
    // Ruling 300: the bell's own list (`routes/resources.notifications.ts`).
    {
      path: LIST_ROUTE,
      loader: ({ request }) => {
        listLoads.push(request.url);
        return { notifications: list };
      },
    },
  ]);
  return { ...render(<Stub initialEntries={["/"]} />), listLoads };
}

/** Opens the bell and waits for its list to land. */
async function openBell(view: ReturnType<typeof renderIn>) {
  fireEvent.click(view.getByLabelText(/Notifications/));
  await waitFor(() =>
    expect(view.container.querySelector(".ntf-pop-list")!.getAttribute("aria-busy")).toBe("false"),
  );
}

describe("UI-14: the bell popover discloses its own cap", () => {
  it("says which slice it is showing once the list hits the loader cap", async () => {
    const items = Array.from({ length: BELL_LIST_CAP }, (_, i) => notification(i));
    const view = renderIn(<TopBell unread={150} orphanUnread={0} />, items);
    await openBell(view);
    // The head claims 150 unread while the list holds 100 rows — before the fix
    // there was no notice at all that the list was truncated.
    expect(view.getByText("150 unread")).toBeTruthy();
    expect(view.getByText(`Showing the newest ${BELL_LIST_CAP}`)).toBeTruthy();
  });

  it("says nothing when the list is not capped", async () => {
    const view = renderIn(<TopBell unread={1} orphanUnread={0} />, [notification(1)]);
    await openBell(view);
    expect(view.queryByText(/Showing the newest/)).toBeNull();
  });
});

/**
 * Ruling 300 (owner, 2026-09-24; FL-4 / SRV-6): pages carry the bell's counts,
 * not its list. The bell fetches the list when the pointer or the focus reaches
 * it and on open, and while open whenever the counts move.
 */
describe("ruling 300: the bell loads its own list", () => {
  it("a first open with no intent before it shows a loading row, then the list", async () => {
    const view = renderIn(<TopBell unread={1} orphanUnread={0} />, [notification(1)]);
    fireEvent.click(view.getByLabelText(/Notifications/));
    expect(view.getByText("Loading notifications…")).toBeTruthy();
    await waitFor(() => expect(view.getByText("Notification 1")).toBeTruthy());
    expect(view.queryByText("Loading notifications…")).toBeNull();
    expect(view.listLoads).toHaveLength(1);
  });

  it("while open, a count that moves reloads the list", async () => {
    let setCounts: (n: number) => void = () => {};
    function Host() {
      const [unread, setUnread] = useState(1);
      setCounts = setUnread;
      return <TopBell unread={unread} orphanUnread={0} />;
    }
    const view = renderIn(<Host />, [notification(1)]);
    await openBell(view);
    expect(view.listLoads).toHaveLength(1);
    // A notification.created revalidated the page: its counts moved.
    await act(async () => setCounts(2));
    await waitFor(() => expect(view.listLoads).toHaveLength(2));
    expect(view.getByText("2 unread")).toBeTruthy();
  });

  it("F19-25: the head counts rows whose project is gone, from the counts", async () => {
    const orphan = { ...notification(2), unread: true, href: null, targetMissing: true };
    const view = renderIn(<TopBell unread={0} orphanUnread={1} />, [orphan]);
    // The badge leaves the orphan out; the head and Mark all read keep it.
    expect(view.container.querySelector(".bell-badge")).toBeNull();
    await openBell(view);
    expect(view.getByText("1 unread")).toBeTruthy();
    expect(view.getByText("Mark all read")).toBeTruthy();
  });
});

describe("UI-45: popovers rendered before their trigger move focus", () => {
  it("focuses the bell panel on open and restores the button on close", () => {
    const { getByLabelText, container } = renderIn(
      <TopBell unread={1} orphanUnread={0} />,
      [notification(1)],
    );
    const button = getByLabelText(/Notifications/);
    fireEvent.click(button);
    expect(document.activeElement).toBe(container.querySelector("dialog.ntf-pop"));
    fireEvent.click(button);
    expect(document.activeElement).toBe(button);
  });

  it("the account menu no longer declares menu roles it does not implement", async () => {
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
    // Radix opens on pointerdown, which is what the first half of a real click
    // is; `fireEvent.click` alone never reaches the trigger's handler.
    fireEvent.pointerDown(getByLabelText("Account menu"), { button: 0 });
    // Ruling 14: the menu roles are BACK, and this time they are honoured.
    // UI-45 had dropped them because they were declared with no arrow-key
    // handling — a contract that promises Up/Down navigation that does not
    // exist. Radix implements the widget, so the promise is kept. (Ruling 11:
    // the menu module is lazy, so the press opens it once it has arrived.)
    const menu = await waitFor(() => {
      const found = container.querySelector('[role="menu"]');
      if (!found) throw new Error("the menu has not opened yet");
      return found;
    });
    expect(menu, "the panel is a real menu again").not.toBeNull();
    expect(menu).toBe(container.querySelector(".user-menu"));
    expect(container.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0);
    // The menu is NAMED by the control that opened it, rather than repeating
    // the string — one source for the name instead of two that can drift.
    const trigger = container.querySelector<HTMLElement>(".home-user")!;
    expect(menu!.getAttribute("aria-labelledby")).toBe(trigger.id);
    expect(trigger.getAttribute("aria-label")).toBe("Account menu");
    // The trigger promises what the panel is.
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // Focus moves into the menu on open (Radix), as it did when this was a
    // hand-rolled panel with its own focus effect.
    expect(container.contains(document.activeElement)).toBe(true);
    // The theme item names its action, not just the current value.
    const theme = [...container.querySelectorAll(".menu-item")].find((b) =>
      b.textContent!.includes("Switch theme"),
    );
    expect(theme).toBeTruthy();
  });
});

/**
 * P16-UI-12 — the bell popover moved from a hand-rolled `window` keydown
 * listener to the shared `useDismiss` hook, and passes `{ outside: false }`
 * deliberately: it closes on an explicit action, not on any press. Converting
 * it to the hook's DEFAULT would silently take that away, so it is asserted.
 *
 * The account menu no longer uses the hook at all (ruling 14 — Radix owns its
 * dismissal). What that block protected for the menu was never "ignore outside
 * presses" for its own sake; it was "the Theme item cycles in place". That is
 * now asserted directly, which is a better test than the proxy it replaces —
 * and pressing outside a menu to close it is what a menu should do.
 */
describe("P16-UI-12: the shell popovers dismiss on Escape, not on any press", () => {
  async function openMenu() {
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
    fireEvent.pointerDown(view.getByLabelText("Account menu"), { button: 0 });
    await waitFor(() => expect(view.container.querySelector(".user-menu")).not.toBeNull());
    return view;
  }

  it("the account menu cycles theme in place, without closing", async () => {
    // The behaviour the old outside-press assertion stood in for. Every other
    // item dismisses the menu; this one must not, or cycling
    // light -> dark -> system becomes three trips through the trigger.
    const { container, getByText } = await openMenu();
    fireEvent.click(getByText(/Switch theme/));
    expect(container.querySelector(".user-menu")).not.toBeNull();
  });

  it("the bell popover survives an outside press and closes on Escape", () => {
    const { getByLabelText, container } = renderIn(
      <TopBell unread={1} orphanUnread={0} />,
      [notification(1)],
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
      unread={0}
      orphanUnread={0}
      {...props}
    />
  );

  it("hides the paused chip while the stream is healthy", () => {
    const { queryByText } = renderIn(topbar());
    expect(queryByText(/live updates paused/)).toBeNull();
  });

  it("layo-10: the header row carries no chip or Retry while paused", () => {
    // The ~186px pair sat in a fixed-height row that cannot wrap, and at
    // 320-375px pushed the bell and account menu past `.main`'s clipped edge.
    // The row keeps only the announcer; the layout renders the strip below.
    // Canary: put the chip back in Topbar and this goes red.
    const { container, queryByRole } = renderIn(topbar({ livePaused: true }));
    expect(container.querySelector(".topbar .pill")).toBeNull();
    expect(container.querySelector(".archived-banner")).toBeNull();
    expect(queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("surfaces a dropped stream as a strip, with the retry as a real control", () => {
    let retried = 0;
    const { container, getByText, getByRole } = renderIn(
      <LivePausedStrip
        message={WORKSPACE_PAUSED_SENTENCE}
        onReconnect={() => (retried += 1)}
      />,
    );
    // The sentence is a status; the retry is an action. One `.pill` (no cursor,
    // no hover) with role="status" over a click handler was neither, and
    // role="status" hid the button role, so "retry" was unreachable by name.
    const sentence = getByText(
      "Live updates paused. Counts and board state may be out of date.",
    );
    expect(sentence.tagName).toBe("SPAN");
    // The strip is not itself the live region (the header's always-mounted
    // announcer is), so the sentence is not read twice on the drop.
    expect(container.querySelector(".archived-banner")!.getAttribute("role")).toBeNull();
    expect(sentence.closest('[role="status"]')).toBeNull();
    fireEvent.click(getByRole("button", { name: "Retry" }));
    expect(retried).toBe(1);
  });

  it("renders no retry control when there is nothing to reconnect", () => {
    const { getByText, queryByRole } = renderIn(
      <LivePausedStrip message={WORKSPACE_PAUSED_SENTENCE} />,
    );
    expect(getByText(WORKSPACE_PAUSED_SENTENCE)).toBeTruthy();
    expect(queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("ruling 299: the announcer is mounted before the stream drops", () => {
    // A live region inserted together with its text is the one case screen
    // readers skip, so the region has to exist (and be empty) while the stream
    // is healthy, and only its TEXT may change.
    // Canary: wrap the announcer in `livePaused && …` and this goes red.
    const { container, rerender } = renderIn(topbar());
    const live = container.querySelector('span.vh[role="status"]');
    expect(live).not.toBeNull();
    expect(live!.getAttribute("aria-live")).toBe("polite");
    expect(live!.textContent).toBe("");

    rerender(<div />);
    const paused = renderIn(topbar({ livePaused: true }));
    expect(
      paused.container.querySelector('span.vh[role="status"]')!.textContent,
    ).toMatch(/^Live updates paused\./);
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
      unread={0}
      orphanUnread={0}
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

describe("acce-19: the rail's violations count says what it counts", () => {
  function railWith(violations: number) {
    return renderAt(
      <Rail
        projectSlug="viberr-core"
        projectName="Viberr Core"
        projectRepo={null}
        membersCount={1}
        boardCount={10}
        reviewCount={3}
        violations={violations}
      />,
      "/projects/viberr-core/board",
    );
  }

  it("names the alarm in words, so red is not the only cue", () => {
    // A bare red "1" gave the link the name "Settings 1" — the same shape as
    // the neutral "Board 10" — and read as just another count in grayscale.
    const one = railWith(1);
    expect(one.getByText("Settings").closest("a")!.textContent).toBe(
      "Settings1 violation",
    );
    expect(one.container.querySelector(".count.violations")!.textContent).toBe(
      "1 violation",
    );
    cleanup();
    const many = railWith(3);
    expect(many.container.querySelector(".count.violations")!.textContent).toBe(
      "3 violations",
    );
    // The neutral counts keep their bare numerals: the item names them.
    expect(many.getByText("Board").closest("a")!.textContent).toBe("Board10");
  });

  it("renders no count at all while nothing is open", () => {
    const { container } = railWith(0);
    expect(container.querySelector(".count.violations")).toBeNull();
  });
});

describe("ruling 224: the rail lists GitHub only for a project that has a repository", () => {
  const items = (container: HTMLElement) =>
    [...container.querySelectorAll("a.nav-item")].map((a) => a.getAttribute("href")!.split("/").pop());

  it("drops the GitHub item for a project with none, and keeps every other item in its place", () => {
    // CANARY: list the whole nav whatever the project is and a board that
    // delivers results carries a page of credential warnings in its rail.
    const withRepo = railAt("/projects/viberr-core/board");
    expect(items(withRepo.container)).toContain("github");
    cleanup();
    const none = renderAt(
      <Rail
        projectSlug="viberr-core"
        projectName="Viberr Core"
        projectRepo={null}
        membersCount={1}
        boardCount={4}
        reviewCount={0}
        violations={0}
      />,
      "/projects/viberr-core/board",
    );
    expect(items(none.container)).toEqual([
      "board",
      "epics",
      "review",
      "controller",
      "agents",
      "policy",
      "activity",
      "settings",
    ]);
  });
});

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
    const trigger = getByLabelText("Search tasks, epics, branches, agents, projects");
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
        unread={0}
        orphanUnread={0}
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
  // The layout's shape, not a bare Topbar: the rail before the page, the page
  // inert while the drawer is open, and the toggle inside the page. The
  // restore-to-toggle is an effect keyed on the close, so the harness has to
  // let `railOpen` actually change.
  function RailShell({
    initialOpen,
    onToggle,
  }: {
    initialOpen: boolean;
    onToggle: () => void;
  }) {
    const [open, setOpen] = useState(initialOpen);
    return (
      <>
        <Rail
          open={open}
          projectSlug="viberr-core"
          projectName="Viberr Core"
          projectRepo={null}
          membersCount={1}
          boardCount={0}
          reviewCount={0}
          violations={0}
        />
        <main inert={open}>
          <Topbar
            projectSlug="viberr-core"
            projectName="Viberr Core"
            openTask={null}
            user={USER}
            theme="system"
            unread={0}
            orphanUnread={0}
            railOpen={open}
            onToggleRail={() => {
              onToggle();
              setOpen((o) => !o);
            }}
          />
        </main>
      </>
    );
  }
  function railOverlayAt(initialOpen: boolean) {
    let toggled = 0;
    const utils = renderAt(
      <RailShell initialOpen={initialOpen} onToggle={() => (toggled += 1)} />,
      "/projects/viberr-core/board",
    );
    return { ...utils, toggles: () => toggled };
  }

  it("closes the open rail on Escape and returns focus to the toggle", () => {
    const { container, getByLabelText, toggles } = railOverlayAt(true);
    const toggle = getByLabelText("Project navigation");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // Interface review 2026-09-06: the drawer takes focus. (The `inert` on
    // <main> is the HARNESS's own; routes/project.tsx is pinned by e2e/07.)
    expect(document.activeElement).toBe(container.querySelector("nav.rail"));

    fireEvent.keyDown(window, { key: "Escape" });

    expect(toggles()).toBe(1);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // jsdom does not enforce `inert`, so a synchronous focus() would also pass
    // here; e2e/07 (Chromium) is the canary for the after-inert ordering.
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

/**
 * Ruling 294 — the app header on the standalone pages.
 *
 * Every project surface, the board's own Settings included, sits under a header
 * with the brand, the ⌘K search, the bell and the account menu. The instance
 * surfaces behind Home's Settings tiles had none of it, so opening "Users &
 * access" or "Insights" replaced the whole app with a bare page. These pin what
 * the header IS: the same four parts, in one place, naming where the reader is.
 */
describe("ruling 294: the standalone-page header", () => {
  function headerFor(title: string) {
    let opened = 0;
    const Stub = createRoutesStub([
      {
        path: "/org/settings",
        Component: () => (
          <ToastProvider>
            <PageTopbar
              title={title}
              user={USER}
              theme="system"
              unread={3}
              orphanUnread={0}
              onOpenPalette={() => (opened += 1)}
            />
          </ToastProvider>
        ),
      },
      { path: "/", Component: () => <p>home</p> },
      // Ruling 300: the bell loads its own list.
      { path: LIST_ROUTE, loader: () => ({ notifications: [notification(1)] }) },
    ]);
    return {
      ...render(<Stub initialEntries={["/org/settings"]} />),
      opens: () => opened,
    };
  }

  it("names where the reader is, under a crumb that leads back to Home", () => {
    const { getByRole, getByText } = headerFor("Instance settings");
    // The brand and the crumb root are the way back — the pages dropped their
    // in-page back buttons for exactly these two.
    expect(getByRole("link", { name: /Viberr/ }).getAttribute("href")).toBe("/");
    expect(getByRole("link", { name: "Home" }).getAttribute("href")).toBe("/");
    const current = getByText("Instance settings");
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
  });

  it("carries the same search, bell and account menu as the workspace", () => {
    const { getByLabelText, getByText, opens } = headerFor("Insights");
    fireEvent.click(getByLabelText("Search tasks, epics, branches, agents, projects"));
    expect(opens(), "the palette trigger reports to the layout").toBe(1);
    // The bell badge and the account menu were simply absent on these pages:
    // a notification arriving while you were in settings had nowhere to show.
    fireEvent.click(getByLabelText(/Notifications/));
    expect(getByText("3 unread")).toBeTruthy();
    expect(getByLabelText(/Account/)).toBeTruthy();
  });
});

describe("ruling 284: the bell badge pulses on an arrival, not on a paint", () => {
  /** The bell with its count driven from outside, as SSE revalidation does. */
  function Harness({ start }: { start: number }) {
    const [unread, setUnread] = useState(start);
    return (
      <>
        <TopBell unread={unread} orphanUnread={0} />
        <button type="button" onClick={() => setUnread((n) => n + 1)}>
          arrive
        </button>
        <button type="button" onClick={() => setUnread((n) => n - 1)}>
          read
        </button>
      </>
    );
  }
  const badge = (container: HTMLElement) => container.querySelector(".bell-badge");

  it("stands still on first paint, and on every remount of the bell", () => {
    // CANARY: key the badge on the count again and mark every one arrived
    // (`data-arrived` always set): the pulse plays on every page load.
    const { container, unmount } = renderIn(<Harness start={3} />);
    expect(badge(container)?.textContent).toBe("3");
    expect(badge(container)?.hasAttribute("data-arrived")).toBe(false);
    unmount();
    // Home, the workspace and the standalone pages each mount their own bell.
    const again = renderIn(<Harness start={3} />);
    expect(badge(again.container)?.hasAttribute("data-arrived")).toBe(false);
  });

  it("pulses on a rise, again on the next rise, and not when reading lowers the count", () => {
    // CANARY: bump `arrivals` on any change (`unread !== seenUnread`) and the
    // fall below remounts the badge, replaying the pulse.
    const { container, getByText } = renderIn(<Harness start={3} />);
    const first = badge(container)!;
    fireEvent.click(getByText("arrive"));
    const risen = badge(container)!;
    // A new node, so the one-shot keyframe replays; marked, so it plays at all.
    expect(risen).not.toBe(first);
    expect(risen.textContent).toBe("4");
    expect(risen.getAttribute("data-arrived")).toBe("");
    fireEvent.click(getByText("read"));
    expect(badge(container)).toBe(risen);
    expect(badge(container)!.textContent).toBe("3");
    fireEvent.click(getByText("arrive"));
    expect(badge(container)).not.toBe(risen);
    expect(badge(container)!.getAttribute("data-arrived")).toBe("");
  });

  it("pulses when the first notification arrives on an empty bell", () => {
    const { container, getByText } = renderIn(<Harness start={0} />);
    expect(badge(container)).toBeNull();
    fireEvent.click(getByText("arrive"));
    expect(badge(container)?.getAttribute("data-arrived")).toBe("");
  });
});
