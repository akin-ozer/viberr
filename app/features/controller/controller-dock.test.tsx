// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ControllerDockView } from "./controller-dock-query.server";
import type { UnseenReplyView } from "~/routes/resources.controller-unseen";
import { CONTROLLER_UPDATED_EVENT } from "~/features/live-updates/event-types";
import { mountDock as mount } from "../../../test-support/controller-dock-stub";
import { DockPanelBody } from "./controller-dock-panel";

/**
 * Ruling 121 — the controller dock, driven through a routed stub: the trigger
 * names the scope, the panel opens on the current place, focus lands in the
 * composer and returns to the trigger, threads and sends go through the
 * resource route, and the two controller pages carry no dock at all.
 */

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

function conversationFixture() {
  return {
    id: "cnv_a",
    userId: "u1",
    userLabel: "arda@viberr.dev",
    projectSlug: "viberr",
    taskKey: "VIB-1",
    title: "First",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    lastMessageAt: "2026-09-01T10:00:00.000Z",
  };
}

function taskView(over: Partial<ControllerDockView> = {}): ControllerDockView {
  return {
    available: true,
    controllerName: "Controller",
    unavailable: false,
    staleSelection: false,
    scope: {
      kind: "task",
      projectSlug: "viberr",
      taskKey: "VIB-1",
      projectName: "Viberr",
      label: "VIB-1 · Viberr",
      contextLine: "Knows the VIB-1 task file and its place in the Viberr workflow · acts with your permissions",
      pageHref: "/projects/viberr/controller",
    },
    conversation: null,
    messages: [],
    taskLinks: {},
    turn: { working: false, runId: null, phase: null, step: null },
    threads: [],
    viewerOwnsActive: false,
    ...over,
  };
}

/**
 * Review finding 11: the mount-time restore effect writes the open flag back
 * only after it has read it, so this is a true happens-after — waiting on the
 * write is how a test knows the restore has landed.
 *
 * It is no longer how a test protects a click from it: the restore now yields
 * to an `open` the person has already set, and the test below pins that. This
 * is only for the cases that want the settled per-tab state before they look.
 */
async function restored(expected: "0" | "1" = "0") {
  await waitFor(() =>
    expect(window.sessionStorage.getItem("viberr.dock.open")).toBe(expected),
  );
}

/**
 * O39-d. A controller turn runs one to five minutes. Its answer reached the
 * surfaces still open on it, and a person who moved to another page had no
 * signal anywhere that it had landed.
 */
describe("the dock tells a person a reply is waiting (O39-d)", () => {
  const BOARD_REPLY: UnseenReplyView = {
    id: "cnv_board",
    title: "Plan the release",
    projectSlug: "viberr",
    taskKey: null,
    href: "/projects/viberr/controller?c=cnv_board",
  };

  it("marks the button, says so to a screen reader, and links to the reply from the panel", async () => {
    mount({ path: "/projects/viberr/tasks/VIB-1", view: () => taskView(), unseen: () => [BOARD_REPLY] });
    // CANARY: drop the unseen dot from the button and nothing on this page
    // says the board conversation has answered.
    const fab = await screen.findByRole("button", { name: /a new reply/ });
    await waitFor(() => expect(fab.querySelector(".unseen-dot")).not.toBeNull());
    expect(screen.getByRole("status").textContent).toBe("Controller replied in “Plan the release”");
    fireEvent.click(fab);
    const link = await screen.findByRole("link", { name: "Plan the release" });
    expect(link.getAttribute("href")).toBe("/projects/viberr/controller?c=cnv_board");
  });

  it("does not count the thread the open panel is showing", async () => {
    const shown = { ...BOARD_REPLY, id: "cnv_a", title: "First", taskKey: "VIB-1", href: "/projects/viberr/controller?c=cnv_a" };
    mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () =>
        taskView({
          conversation: conversationFixture(),
          threads: [{ id: "cnv_a", title: "First", lastMessageAt: "2026-09-01T10:00:00.000Z", unread: false }],
        }),
      unseen: () => [shown],
    });
    const fab = await screen.findByRole("button", { name: /a new reply/ });
    fireEvent.click(fab);
    // CANARY: drop the `open && u.id === shownId` filter and the person is told
    // about the reply they are reading.
    await waitFor(() => expect(screen.getByRole("button", { name: /^Controller · VIB-1 · Viberr$/ })).toBeTruthy());
    expect(screen.queryByText(/New reply in/)).toBeNull();
  });

  /**
   * Ruling 448, and ruling 457 (CTL-3): only the OPEN dock reads the transcript
   * it shows. The view was a root-owned fetcher, so once the dock had been
   * opened, every page revalidation reloaded its last URL, `seen=1` and all:
   * the reply's own `controller.updated` revalidated the page, which marked the
   * reply read with the panel closed, and the dot never lit.
   */
  it("lights the dot for a reply that lands in the last-opened thread while the panel is closed", async () => {
    const shown: UnseenReplyView = {
      id: "cnv_a",
      title: "First",
      projectSlug: "viberr",
      taskKey: "VIB-1",
      href: "/projects/viberr/controller?c=cnv_a",
    };
    let replied = false;
    let readAfterReply = false;
    const { loads } = mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: (request) => {
        // What the route does: a `seen=1` load marks the thread read.
        if (replied && new URL(request.url).searchParams.get("seen") === "1") readAfterReply = true;
        return taskView({
          conversation: conversationFixture(),
          viewerOwnsActive: true,
          threads: [{ id: "cnv_a", title: "First", lastMessageAt: "2026-09-01T10:00:00.000Z", unread: false }],
        });
      },
      unseen: () => (replied && !readAfterReply ? [shown] : []),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" }));
    await screen.findByText("Knows the VIB-1 task file and its place in the Viberr workflow · acts with your permissions");
    fireEvent.click(screen.getByRole("button", { name: "Close the controller dock" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Controller dock" })).toBeNull());
    const closedAt = loads.length;

    // The reply lands. Its `controller.updated` reaches the page's stream: the
    // page revalidates for its own reasons, and the dock gets its cue.
    replied = true;
    fireEvent.click(screen.getByRole("button", { name: "revalidate page" }));
    act(() => {
      window.dispatchEvent(new Event(CONTROLLER_UPDATED_EVENT));
    });
    // CANARY: drop `shouldRevalidate` from the dock's view route and the
    // revalidation reloads the transcript with `seen=1`, reading the reply.
    const fab = await screen.findByRole("button", { name: /a new reply/ });
    expect(fab.querySelector(".unseen-dot")).not.toBeNull();
    expect(loads.length).toBe(closedAt);
  });

  it("marks an unread thread in the panel's own list", async () => {
    mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () =>
        taskView({
          threads: [
            { id: "cnv_a", title: "First", lastMessageAt: "2026-09-01T10:00:00.000Z", unread: false },
            { id: "cnv_b", title: "Second", lastMessageAt: "2026-09-01T11:00:00.000Z", unread: true },
          ],
        }),
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Controller · / }));
    fireEvent.click(await screen.findByRole("button", { name: /^Threads here/ }));
    // CANARY: drop the unread mark from the dock's thread list.
    expect(await screen.findByRole("button", { name: /^Second, new reply/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^First/ }).textContent).not.toContain("new reply");
  });
});

describe("the controller dock (ruling 121)", () => {
  it("names the scope on the trigger, opens on the current place, and focuses the composer", async () => {
    const { loads } = mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () => taskView(),
    });
    const trigger = await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" });
    await restored();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog", { name: "Controller dock" })).toBeNull();

    fireEvent.click(trigger);
    const panel = await screen.findByRole("dialog", { name: "Controller dock" });
    expect(panel.getAttribute("aria-modal")).toBe("false");
    expect(panel.getAttribute("data-screen-label")).toBe("Controller dock");
    // The view was asked for exactly this scope, newest thread first.
    await waitFor(() => expect(loads.length).toBeGreaterThan(0));
    expect(loads[0]!.searchParams.get("project")).toBe("viberr");
    expect(loads[0]!.searchParams.get("task")).toBe("VIB-1");
    expect(loads[0]!.searchParams.get("c")).toBeNull();
    // The server's label and context line replace the route's own names.
    await screen.findByText("Knows the VIB-1 task file and its place in the Viberr workflow · acts with your permissions");
    expect(screen.getByRole("button", { name: "Controller · VIB-1 · Viberr" })).toBeTruthy();
    expect(screen.getByText("VIB-1 · Viberr")).toBeTruthy();
    await screen.findByText(/Ask about VIB-1 or say what to do with it/);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Message to the controller")),
    );
    expect(window.sessionStorage.getItem("viberr.dock.open")).toBe("1");
  });

  /**
   * Ruling 314. The empty dock said what the controller KNOWS and nothing about
   * what it can DO, so a person who had never used it faced a text box and a
   * claim. The owner chose examples over a capability list: a list tells and
   * goes stale, an example teaches by being clicked.
   */
  it("ruling 314: the empty state offers scoped examples, and clicking one SENDS it", async () => {
    const { sends } = mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () => taskView(),
    });
    await restored();
    fireEvent.click(await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" }));
    await screen.findByText(/Ask about VIB-1 or say what to do with it/);

    // Scoped to the task, and naming it — a generic example would not show that
    // the controller already knows where it is standing.
    const first = await screen.findByRole("button", { name: "What is blocking VIB-1?" });
    expect(
      screen.getByRole("button", {
        name: "Draft a directive for the agent on this task, but do not send it.",
      }),
    ).toBeTruthy();

    fireEvent.click(first);

    /**
     * CANARY: have the example call `setText` and then `submit()` and this stays
     * empty — React has not re-rendered inside the click, so the submit reads
     * the EMPTY box. That is the same class of loss `pending.current` exists to
     * prevent for typed messages, which is why the value is a parameter.
     */
    await waitFor(() => expect(sends.length).toBe(1));
    expect(sends[0]!.get("text")).toBe("What is blocking VIB-1?");
    expect(sends[0]!.get("intent")).toBe("send");
    expect(sends[0]!.get("task")).toBe("VIB-1");
  });

  it("ruling 314: the examples follow the scope", async () => {
    // A board dock must not offer a task's questions. CANARY: collapse
    // `emptyExamples` to one list and this finds a task example on a board.
    mount({
      path: "/projects/viberr/board",
      view: () =>
        taskView({
          scope: {
            kind: "board",
            projectSlug: "viberr",
            taskKey: null,
            projectName: "Viberr",
            label: "Viberr",
            contextLine: "Knows the Viberr board · acts with your permissions",
            pageHref: "/projects/viberr/controller",
          },
        }),
    });
    await restored();
    fireEvent.click(await screen.findByRole("button", { name: "Controller · viberr" }));
    await screen.findByRole("button", {
      name: "What is waiting on me right now, and what is waiting on an agent?",
    });
    expect(screen.queryByRole("button", { name: /What is blocking VIB-1/ })).toBeNull();
  });

  it("keeps an open the person clicked before the restore had read storage", async () => {
    // The flake this closed. React flushes passive effects AFTER the commit
    // that paints the trigger, so the button is on screen and clickable while
    // the mount-time restore has still not read sessionStorage — and the
    // restore used to write its own answer over the person's. Under full-suite
    // load that ordering came up about one run in three, and took a different
    // test with it each time (the poll, the two sends, the focus fallback, the
    // entry animation), every one of them failing on a dock that had simply
    // stayed shut.
    //
    // Clicking from INSIDE the read is how a test gets that interleaving on
    // purpose rather than waiting for a loaded machine to hand it over: both
    // updates land in one batch, the person's first, which is the losing order.
    const storage: Storage = Object.getPrototypeOf(window.sessionStorage);
    const read = storage.getItem;
    const spy = vi
      .spyOn(storage, "getItem")
      .mockImplementation(function (this: Storage, key: string) {
        if (key === "viberr.dock.open") {
          document.querySelector<HTMLButtonElement>(".dock-fab")?.click();
        }
        return read.call(this, key);
      });
    try {
      mount({ path: "/projects/viberr/tasks/VIB-1", view: () => taskView() });
      await screen.findByRole("dialog", { name: "Controller dock" });
    } finally {
      spy.mockRestore();
    }
    // The click won outright, and counts as the person's own open: focus goes
    // to the composer the moment the view enables it, the way it does for any
    // other open they asked for…
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Message to the controller")),
    );
    // …and it is their choice the tab remembers, not the stored one.
    expect(window.sessionStorage.getItem("viberr.dock.open")).toBe("1");
  });

  it("puts focus on the panel itself when the composer cannot take it", async () => {
    mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () => taskView({ available: false }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" }));
    const panel = await screen.findByRole("dialog", { name: "Controller dock" });
    const composer = await screen.findByLabelText("Message to the controller");
    await waitFor(() => expect(composer.hasAttribute("disabled")).toBe(true));
    await waitFor(() => expect(document.activeElement).toBe(panel));
    // Ruling 127: the dock's refusal is the person's own, and names the one
    // place they fix it — the same sentence the page's composer and the
    // refused turn's transcript line carry.
    // U39-10: as a visible note with the place linked, not a placeholder cut
    // after the dock's two rows. CANARY: drop <NotConnectedNote /> from the dock.
    const note = panel.querySelector(".ctl-composer [data-not-connected]");
    expect(note?.textContent).toMatch(/your own Claude account/);
    expect(note?.querySelector('a[href="/profile"]')?.textContent).toBe("Profile → Agent accounts");
    expect(composer.getAttribute("placeholder")).toBe("Connect Claude to send a message.");
  });

  it("Escape inside the panel closes instantly and hands focus back to the trigger", async () => {
    mount({ path: "/projects/viberr/board", view: () => taskView() });
    const trigger = await screen.findByRole("button", { name: "Controller · viberr" });
    fireEvent.click(trigger);
    const panel = await screen.findByRole("dialog", { name: "Controller dock" });
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Controller dock" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(window.sessionStorage.getItem("viberr.dock.open")).toBe("0");
  });

  it("Escape OUTSIDE the panel leaves the dock alone (review finding 8)", async () => {
    // The palette, a confirm dialog and a stage menu all cancel on Escape; a
    // document-level listener closed the helper with them.
    mount({ path: "/projects/viberr/board", view: () => taskView() });
    fireEvent.click(await screen.findByRole("button", { name: "Controller · viberr" }));
    await screen.findByRole("dialog", { name: "Controller dock" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(window.sessionStorage.getItem("viberr.dock.open")).toBe("1"));
    expect(screen.getByRole("dialog", { name: "Controller dock" })).toBeTruthy();
  });

  /**
   * Interface review 2026-09-24 (acce-14): no focus trap (ruling 121), so Tab
   * reaches page controls the panel covers. Escape there uncovers the control
   * without moving focus. jsdom has no layout, so the hit test is stubbed: it
   * answers the panel for a covered control and the control itself otherwise.
   */
  async function withPageControl(
    covered: boolean,
    setup: (control: HTMLButtonElement) => void,
    check: (control: HTMLButtonElement) => Promise<void>,
  ) {
    mount({ path: "/projects/viberr/board", view: () => taskView() });
    fireEvent.click(await screen.findByRole("button", { name: "Controller · viberr" }));
    const panel = await screen.findByRole("dialog", { name: "Controller dock" });
    const control = document.createElement("button");
    control.textContent = "Edit";
    document.body.append(control);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => (covered ? panel : control),
    });
    try {
      setup(control);
      control.focus();
      fireEvent.keyDown(control, { key: "Escape" });
      await check(control);
    } finally {
      Reflect.deleteProperty(document, "elementFromPoint");
      control.remove();
    }
  }

  it("Escape on a page control under the panel closes the dock and leaves focus there (acce-14)", async () => {
    await withPageControl(true, () => {}, async (control) => {
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Controller dock" })).toBeNull());
      expect(document.activeElement).toBe(control);
      expect(window.sessionStorage.getItem("viberr.dock.open")).toBe("0");
    });
  });

  it.each([
    ["the control is not under the panel", false, () => {}],
    ["the control is an open popover's trigger", true, (c: HTMLButtonElement) => c.setAttribute("aria-expanded", "true")],
    ["something else already handled the Escape", true, (c: HTMLButtonElement) =>
      c.addEventListener("keydown", (e) => e.preventDefault())],
  ])("Escape on a page control leaves the dock alone when %s (acce-14)", async (_, covered, setup) => {
    await withPageControl(covered, setup, async () => {
      await waitFor(() => expect(window.sessionStorage.getItem("viberr.dock.open")).toBe("1"));
      expect(screen.getByRole("dialog", { name: "Controller dock" })).toBeTruthy();
    });
  });

  it("restores open without stealing focus, and never re-aims off a control (findings 7, 10)", async () => {
    window.sessionStorage.setItem("viberr.dock.open", "1");
    mount({ path: "/projects/viberr/tasks/VIB-1", view: () => taskView() });
    const panel = await screen.findByRole("dialog", { name: "Controller dock" });
    const composer = await screen.findByLabelText("Message to the controller");
    await waitFor(() => expect(composer.hasAttribute("disabled")).toBe(false));
    // A restore is not a user action: focus stays where the document put it.
    expect(document.activeElement).not.toBe(composer);
    expect(document.activeElement).not.toBe(panel);
    // And a later view refresh does not pull focus off the dock's own controls.
    const close = screen.getByRole("button", { name: "Close the controller dock" });
    close.focus();
    fireEvent.click(screen.getByRole("button", { name: /Threads here/ }));
    fireEvent.click(screen.getByRole("button", { name: /Threads here/ }));
    await waitFor(() => expect(screen.getByLabelText("Message to the controller")).toBeTruthy());
    expect(document.activeElement).toBe(close);
  });

  it("forgets a stored selection the server could not honour (review finding 2)", async () => {
    window.sessionStorage.setItem(
      "viberr.dock.selected",
      JSON.stringify({ "viberr|VIB-1": "cnv_gone" }),
    );
    const { loads } = mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: (request) =>
        new URL(request.url).searchParams.get("c") === "cnv_gone"
          ? taskView({ staleSelection: true })
          : taskView(),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" }));
    // It asked once with the stale id, then dropped it — the page is intact.
    await waitFor(() => expect(loads[0]!.searchParams.get("c")).toBe("cnv_gone"));
    await waitFor(() =>
      expect(window.sessionStorage.getItem("viberr.dock.selected")).not.toContain("cnv_gone"),
    );
    expect(screen.getByText("task page")).toBeTruthy();
  });

  it("says so, and offers no composer, when the scope is not open to the viewer", async () => {
    mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () =>
        taskView({
          unavailable: true,
          scope: { ...taskView().scope, contextLine: "Not available here: this project or task is not open to you." },
        }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" }));
    await screen.findByText(/The controller has nothing to work with here/);
    expect(
      (await screen.findByLabelText("Message to the controller")).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByText("task page")).toBeTruthy();
  });

  it("sends into the thread the person picked, not the one still on screen (finding 15)", async () => {
    const { sends } = mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: (request) =>
        // The New view never lands, so `current` keeps the previous thread.
        new URL(request.url).searchParams.get("c") === "new"
          ? taskView({ conversation: conversationFixture(), messages: [], viewerOwnsActive: true })
          : taskView({ conversation: conversationFixture(), viewerOwnsActive: true }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" }));
    const composer = await screen.findByLabelText("Message to the controller");
    await waitFor(() => expect(composer.hasAttribute("disabled")).toBe(false));
    fireEvent.change(composer, { target: { value: "start fresh" } });
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends.length).toBe(1));
    expect(sends[0]!.get("conversationId")).toBe("new");
  });

  it("closes on the Close button and returns focus to the trigger (finding 32)", async () => {
    mount({ path: "/projects/viberr/board", view: () => taskView() });
    const trigger = await screen.findByRole("button", { name: "Controller · viberr" });
    fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Controller dock" });
    fireEvent.click(screen.getByRole("button", { name: "Close the controller dock" }));
    // jsdom reports a 0s transition duration, so the close finishes at once.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Controller dock" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("ruling 454: at sheet width a pull down the header dismisses the dock, and focus comes back", async () => {
    // The 720px block's flag is what makes the panel a sheet; jsdom lays
    // nothing out, so the sheet's height is stubbed (halfway at 300px).
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ matches: false, media: query }),
    });
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    try {
      mount({ path: "/projects/viberr/board", view: () => taskView() });
      const trigger = await screen.findByRole("button", { name: "Controller · viberr" });
      fireEvent.click(trigger);
      const panel = await screen.findByRole("dialog", { name: "Controller dock" });
      // The grabber only says "this pulls"; Close stays the named way out.
      const grabber = panel.querySelector(".dock-grabber");
      expect(grabber?.getAttribute("aria-hidden")).toBe("true");
      expect(grabber?.hasAttribute("data-sheet-handle")).toBe(true);
      const head = panel.querySelector<HTMLElement>("header.dock-head");
      expect(head?.hasAttribute("data-sheet-handle")).toBe(true);
      panel.style.setProperty("--sheet-draggable", "1");
      const at = (type: string, y: number) =>
        fireEvent(
          head!,
          new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, clientY: y, bubbles: true }),
        );
      at("pointerdown", 100);
      for (let y = 120; y <= 500; y += 20) at("pointermove", y);
      const dock = panel.closest<HTMLElement>(".dock")!;
      expect(dock.style.getPropertyValue("--sheet-drag")).toBe("380px");
      at("pointerup", 500);
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Controller dock" })).toBeNull());
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(trigger);
      // The dock let go of the drag, so its button returns to rest.
      expect(dock.hasAttribute("data-sheet-drag")).toBe(false);
      expect(dock.style.getPropertyValue("--sheet-drag")).toBe("");
    } finally {
      height.mockRestore();
      Reflect.deleteProperty(window, "matchMedia");
    }
  });

  it("the Threads toggle keeps one name and lets aria-pressed carry the state (finding 25)", async () => {
    mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () => taskView({ threads: [{ id: "cnv_a", title: "First", lastMessageAt: null, unread: false }] }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" }));
    // The count only settles once the view lands; the NAME must not change
    // with the pressed state, which is the point of the finding.
    const toggle = await screen.findByRole("button", { name: "Threads here (1)" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Threads here (1)" }).getAttribute("aria-pressed"),
      ).toBe("true"),
    );
  });

  it("references the panel only while it exists (review G3)", async () => {
    mount({ path: "/projects/viberr/board", view: () => taskView() });
    const trigger = await screen.findByRole("button", { name: "Controller · viberr" });
    expect(trigger.hasAttribute("aria-controls")).toBe(false);
    fireEvent.click(trigger);
    // No loader stands between the click and the panel: `open` alone renders
    // it, inside the click's own act. A 5 s timeout used to sit here for a
    // "saturated machine" that was really the restore race above — a dock that
    // never opened waits out any budget you give it.
    await screen.findByRole("dialog", { name: "Controller dock" });
    expect(trigger.getAttribute("aria-controls")).toBe("controller-dock-panel");
    expect(document.getElementById("controller-dock-panel")).not.toBeNull();
  });

  /**
   * Finding 32, and ruling 457 (CTL-2): while a turn works the dock polls every
   * 5 s, open or closed. It polls the small status (unseen replies, turns
   * working), not the transcript: the step line moves from the status, and
   * the transcript reloads once, when the status says the turn settled.
   */
  it("keeps polling while a turn works, and stops when it settles (finding 32)", async () => {
    // The turn starts after the fake clock goes in (below): the status the
    // dock loads on mount would otherwise arm the poll on the real one.
    let working = false;
    let step = "Reading the task file";
    const { loads, unseenLoads } = mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () =>
        taskView({
          conversation: conversationFixture(),
          viewerOwnsActive: true,
          turn: working
            ? { working: true, runId: "run_1", phase: null, step }
            : { working: false, runId: null, phase: null, step: null },
        }),
      working: () =>
        working ? [{ id: "cnv_a", projectSlug: "viberr", taskKey: "VIB-1", phase: null, step }] : [],
    });
    const trigger = await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" });
    // The poll is armed by an effect of the ANSWER that says a turn is working —
    // not by the click, and not by the request for it. This test used
    // to wait for the request (`loads.length > 0`), which the click makes
    // synchronously, and then jump the clock 5 s. When the view took longer
    // than one `shouldAdvanceTime` tick to land (a loaded machine, a cold first
    // render), the jump crossed an empty timer queue, the poll armed at its far
    // end, and the 1 s wait for the second request ran out four seconds before
    // the poll's first tick.
    //
    // So the clock moves only when the test moves it (no `shouldAdvanceTime`),
    // and every step is an awaited act(), which does not return until what it
    // started — the request, the view that answers it, that view's effects —
    // has committed. What follows each one is a plain read.
    await restored();
    vi.useFakeTimers();
    working = true;
    try {
      await act(async () => {
        fireEvent.click(trigger);
      });
      expect(screen.getByText("Controller is working")).toBeTruthy();
      expect(screen.getByText("Reading the task file")).toBeTruthy();
      const views = loads.length;
      const polls = unseenLoads.length;
      // Ruling 250: the step moves between polls. CANARY: poll the view again
      // (or render the view's step instead of the status's) and this either
      // reloads the transcript or never moves.
      step = "Editing task.md";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(unseenLoads.length).toBe(polls + 1);
      expect(loads.length).toBe(views);
      expect(screen.getByText("Editing task.md")).toBeTruthy();
      // The turn settles: the next status says so, the transcript reloads
      // once to show it, and the poll stops asking.
      working = false;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(screen.queryByText("Controller is working")).toBeNull();
      expect(loads.length).toBe(views + 1);
      const afterSettle = loads.length + unseenLoads.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(loads.length + unseenLoads.length).toBe(afterSettle);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * O39-d: the working poll runs with the panel closed too, and a load nobody
   * is reading must not mark the reply it fetches as seen. Only the open
   * panel's loads say `seen`, and since ruling 457 the closed dock loads no
   * transcript at all.
   */
  it("O39-d: only an OPEN panel's load marks its transcript seen", async () => {
    // The turn starts once the fake clock is in, so the poll arms on it.
    let started = false;
    const { loads, unseenLoads } = mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () => taskView({ turn: { working: started, runId: "run_1", phase: null, step: null } }),
      working: () =>
        started ? [{ id: "cnv_a", projectSlug: "viberr", taskKey: "VIB-1", phase: null, step: null }] : [],
    });
    const trigger = await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" });
    await restored();
    vi.useFakeTimers();
    started = true;
    try {
      await act(async () => {
        fireEvent.click(trigger);
      });
      expect(loads.at(-1)!.searchParams.get("seen")).toBe("1");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Controller · VIB-1/ }));
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(screen.queryByRole("dialog", { name: "Controller dock" })).toBeNull();
      const closedAt = loads.length;
      const polledAt = unseenLoads.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      // CANARY: load the view from the closed dock's poll again and it reads
      // the reply while nobody is looking.
      expect(unseenLoads.length).toBeGreaterThan(polledAt);
      expect(loads.length).toBe(closedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("animates only a reply that arrives while the panel is open (finding 32)", async () => {
    const first: ControllerDockView["messages"][number] = {
      id: "m1",
      conversationId: "cnv_a",
      seq: 1,
      author: "user",
      userId: "u1",
      text: "first",
      runId: null,
      surface: null,
      createdAt: "2026-09-01T10:00:00.000Z",
    };
    const second: ControllerDockView["messages"][number] = {
      ...first,
      id: "m2",
      seq: 2,
      author: "controller",
      userId: null,
      text: "second",
    };
    let messages: ControllerDockView["messages"] = [first];
    mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () =>
        taskView({
          conversation: conversationFixture(),
          messages,
          viewerOwnsActive: true,
        }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" }));
    await screen.findByText("first");
    // History never wears the marker…
    expect(document.querySelector(".ctl-msg[data-fresh]")).toBeNull();
    // …but the reply that lands while the panel is up does. It arrives the way
    // replies arrive (ruling 457): the page's stream hands the dock the
    // `controller.updated` its conversation published.
    messages = [first, second];
    act(() => {
      window.dispatchEvent(new Event(CONTROLLER_UPDATED_EVENT));
    });
    await screen.findByText("second");
    const fresh = [...document.querySelectorAll(".ctl-msg[data-fresh]")].map(
      (el) => el.textContent ?? "",
    );
    expect(fresh.some((t) => t.includes("second"))).toBe(true);
    expect(fresh.some((t) => t.includes("first"))).toBe(false);
  });

  it("U39-29: a task the reply names opens from the dock too", async () => {
    // CANARY: drop `taskLinks={current.taskLinks}` from the dock's Markdown.
    mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () =>
        taskView({
          conversation: conversationFixture(),
          messages: [
            { id: "m2", conversationId: "cnv_a", seq: 2, author: "controller", userId: null, text: "VIB-2 waits on VIB-1.", runId: "run_1", surface: null, createdAt: "2026-09-01T10:00:05.000Z" },
          ],
          taskLinks: { "VIB-2": "/projects/viberr/tasks/VIB-2", "VIB-1": "/projects/viberr/tasks/VIB-1" },
          viewerOwnsActive: true,
        }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" }));
    const link = await screen.findByRole("link", { name: "VIB-2" });
    expect(link.getAttribute("href")).toBe("/projects/viberr/tasks/VIB-2");
  });

  it("returns focus to the trigger on close from a REMEMBERED-open panel too", async () => {
    // The e2e caught this: the dock restored open across a navigation, Escape
    // inside the panel closed it, and focus was left on nothing because the
    // return was gated on "the user opened it" rather than on "focus was
    // inside it".
    window.sessionStorage.setItem("viberr.dock.open", "1");
    mount({ path: "/projects/viberr/board", view: () => taskView() });
    const panel = await screen.findByRole("dialog", { name: "Controller dock" });
    const trigger = screen.getByRole("button", { name: /^Controller · / });
    panel.focus();
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Controller dock" })).toBeNull(),
    );
    expect(document.activeElement).toBe(trigger);
  });

  it("carries no dock on the controller pages", async () => {
    mount({ path: "/projects/viberr/controller", view: () => taskView() });
    await screen.findByText("controller page");
    expect(screen.queryByRole("button", { name: /^Controller ·/ })).toBeNull();
  });

  it("lists this scope's threads and reloads on the picked one; New asks for an empty thread", async () => {
    const { loads } = mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () =>
        taskView({
          threads: [
            { id: "cnv_a", title: "First thread", lastMessageAt: "2026-09-01T10:00:00.000Z", unread: false },
            { id: "cnv_b", title: "Second thread", lastMessageAt: "2026-09-01T11:00:00.000Z", unread: false },
          ],
        }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" }));
    const threadsButton = await screen.findByRole("button", { name: "Threads here (2)" });
    fireEvent.click(threadsButton);
    fireEvent.click(await screen.findByRole("button", { name: /Second thread/ }));
    await waitFor(() => expect(loads.at(-1)?.searchParams.get("c")).toBe("cnv_b"));
    // Back on the transcript view after picking.
    expect(screen.queryByRole("button", { name: /Second thread/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    await waitFor(() => expect(loads.at(-1)?.searchParams.get("c")).toBe("new"));
    expect(window.sessionStorage.getItem("viberr.dock.selected")).toContain('"viberr|VIB-1":"new"');
  });

  it("sends through the resource route with the scope and the surface, then follows the thread it landed in", async () => {
    const { loads, sends } = mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () => taskView(),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" }));
    const composer = await screen.findByLabelText<HTMLTextAreaElement>("Message to the controller");
    await waitFor(() => expect(composer.hasAttribute("disabled")).toBe(false));
    fireEvent.change(composer, { target: { value: "Move it along" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends.length).toBe(1));
    const form = sends[0]!;
    expect(form.get("intent")).toBe("send");
    expect(form.get("text")).toBe("Move it along");
    expect(form.get("project")).toBe("viberr");
    expect(form.get("task")).toBe("VIB-1");
    expect(form.get("surface")).toBe("/projects/viberr/tasks/VIB-1");
    // U39-24. CANARY: drop the zone from the dock's send.
    expect(form.get("timeZone")).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(form.get("_csrf")).toBe("tok");
    expect(form.get("conversationId")).toBe("");
    await waitFor(() => expect(loads.at(-1)?.searchParams.get("c")).toBe("cnv_new"));
    // Ruling 259: cleared once the server TOOK it, not when it went out.
    expect(composer.value).toBe("");
  });

  it("reports a failed send as a toast and keeps the page", async () => {
    mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () => taskView(),
      action: () => ({ ok: false, error: "That request expired." }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" }));
    const composer = await screen.findByLabelText("Message to the controller");
    await waitFor(() => expect(composer.hasAttribute("disabled")).toBe(false));
    fireEvent.change(composer, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("That request expired.");
    expect(screen.getByText("task page")).toBeTruthy();
    /**
     * Ruling 259 (pass 37, F37-90): the composer keeps the words until the
     * server takes them. `setText("")` ran synchronously after
     * `fetcher.submit`, so this refusal — which happens BEFORE the controller
     * engine is reached, leaving the text in no transcript anywhere — used to
     * destroy what the person had written, with a toast that unmounts itself
     * after 2,600 ms as the only account of it.
     *
     * CANARY: move `setText("")` back beside `send.submit(...)` and this is "".
     */
    // SAFETY: `findByLabelText("Message to the controller")` resolves the
    // composer, which the dock renders as a `<textarea>`.
    expect((composer as HTMLTextAreaElement).value).toBe("hello");
  });

  it("renders the transcript and the working state, and shows the dot on the trigger", async () => {
    mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () =>
        taskView({
          conversation: {
            id: "cnv_a",
            userId: "u1",
            userLabel: "arda@viberr.dev",
            projectSlug: "viberr",
            taskKey: "VIB-1",
            title: "First",
            createdAt: "2026-09-01T10:00:00.000Z",
            updatedAt: "2026-09-01T10:00:00.000Z",
            lastMessageAt: "2026-09-01T10:00:00.000Z",
          },
          messages: [
            { id: "m1", conversationId: "cnv_a", seq: 1, author: "user", userId: "u1", text: "What is this?", runId: null, surface: "/projects/viberr/tasks/VIB-1", createdAt: "2026-09-01T10:00:00.000Z" },
            { id: "m2", conversationId: "cnv_a", seq: 2, author: "controller", userId: null, text: "A **task**.", runId: "run_1", surface: null, createdAt: "2026-09-01T10:00:05.000Z" },
          ],
          turn: { working: true, runId: "run_2", phase: null, step: null },
          threads: [{ id: "cnv_a", title: "First", lastMessageAt: "2026-09-01T10:00:00.000Z", unread: false }],
          viewerOwnsActive: true,
        }),
      // Ruling 457: the button's dot reads the dock's status.
      working: () => [{ id: "cnv_a", projectSlug: "viberr", taskKey: "VIB-1", phase: null, step: null }],
    });
    const trigger = await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" });
    fireEvent.click(trigger);
    await screen.findByText("What is this?");
    expect(screen.getByText("task", { selector: "strong" })).toBeTruthy();
    // Two status regions by design: the panel's working row, and the
    // visually-hidden announcer beside the trigger that survives a close.
    expect(
      screen.getAllByRole("status").map((el) => el.textContent).join(" | "),
    ).toContain("Controller is working");
    await waitFor(() => expect(trigger.querySelector(".live-dot")).not.toBeNull());
    // History never wears the entry animation marker.
    expect(document.querySelector(".ctl-msg[data-fresh]")).toBeNull();
  });
});

/**
 * Ruling 368: the dock's Send named its work ("Sending…") but sat at the .45
 * refused step with no busy mark while the controller took the message. It is
 * `aria-busy` now, the loader spinning.
 * Canary: drop `aria-busy={busy || undefined}` in controller-dock-panel.tsx.
 */
describe("ruling 368: the dock's send in flight", () => {
  it("Send reads Sending…, busy, the loader spinning", () => {
    render(
      <MemoryRouter>
        <DockPanelBody
          current={taskView({ viewerOwnsActive: true })}
          turn={null}
          unseen={[]}
          threadsOpen={false}
          busy
          disabled={false}
          text="Move it along"
          onText={() => {}}
          onSubmit={() => {}}
          onPick={() => {}}
          onLeave={() => {}}
          composerRef={{ current: null }}
          onMount={() => {}}
        />
      </MemoryRouter>,
    );
    const sending = screen.getByRole("button", { name: "Sending…" });
    expect(sending.getAttribute("aria-busy")).toBe("true");
    expect(sending.hasAttribute("disabled")).toBe(true);
    expect(sending.querySelector("svg.ico.spin")).not.toBeNull();
  });
});
