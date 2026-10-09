// @vitest-environment jsdom
import { File as NodeFile } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ControllerDockView } from "./controller-dock-query.server";
import type { UnseenReplyView } from "~/routes/resources.controller-unseen";
import { CONTROLLER_UPDATED_EVENT } from "~/features/live-updates/event-types";
import { mountDock as mount } from "../../../test-support/controller-dock-stub";
import { DockPanelBody } from "./controller-dock-panel";

/**
 * Ruling 256 — the controller dock, driven through a routed stub: the trigger
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

/** A message builder for the open thread `cnv_a`, every message recorded `at`. */
function messagesAt(at: string) {
  return (id: string, seq: number, author: "user" | "controller", text: string, replyTo: string | null = null) => ({
    id,
    conversationId: "cnv_a",
    seq,
    author,
    userId: author === "user" ? "u1" : null,
    text,
    runId: author === "user" ? null : `run_${id}`,
    surface: null,
    replyTo,
    steeredInto: null,
    createdAt: at,
  });
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
    turn: { working: false, runId: null, phase: null, step: null, answering: null, queued: [], steering: [] },
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

/** A reply waiting in a board conversation, not the task's (O39-d). */
const BOARD_REPLY: UnseenReplyView = {
  id: "cnv_board",
  title: "Plan the release",
  projectSlug: "viberr",
  taskKey: null,
  href: "/projects/viberr/controller?c=cnv_board",
};

/**
 * O39-d. A controller turn runs one to five minutes. Its answer reached the
 * surfaces still open on it, and a person who moved to another page had no
 * signal anywhere that it had landed.
 */
describe("the dock tells a person a reply is waiting (O39-d)", () => {
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
   * Ruling 257, and ruling 11 (CTL-3): only the OPEN dock reads the transcript
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
    // CANARY: make `dockResourceShouldRevalidate` answer true and the
    // revalidation reloads the transcript with `seen=1`, reading the reply
    // (the routes' own export is pinned in resources.controller-unseen.test.ts).
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

describe("the controller dock (ruling 256)", () => {
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
   * Ruling 319. The empty dock said what the controller KNOWS and nothing about
   * what it can DO, so a person who had never used it faced a text box and a
   * claim. The owner chose examples over a capability list: a list tells and
   * goes stale, an example teaches by being clicked.
   */
  it("ruling 319: the empty state offers scoped examples, and clicking one SENDS it", async () => {
    const { sends } = mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () => taskView(),
    });
    await restored();
    fireEvent.click(await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" }));
    await screen.findByText(/Ask about VIB-1 or say what to do with it/);

    // Scoped to the task, and naming it — a generic example would not show that
    // the controller already knows where it is standing. Ruling 291: the row's
    // glyph and arrow are drawn, never read, so its name is the sentence alone
    // (CANARY: give the glyph a text alternative and this finds nothing).
    const first = await screen.findByRole("button", { name: "What's blocking VIB-1?" });
    expect(
      screen.getByRole("button", {
        name: "Draft a directive for this task's agent, but don't send it.",
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
    expect(sends[0]!.get("text")).toBe("What's blocking VIB-1?");
    expect(sends[0]!.get("intent")).toBe("send");
    expect(sends[0]!.get("task")).toBe("VIB-1");
  });

  it("ruling 319: the examples follow the scope", async () => {
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
      name: "What's waiting on me, and what's waiting on an agent?",
    });
    expect(screen.queryByRole("button", { name: /What's blocking VIB-1/ })).toBeNull();
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
    // Ruling 137: the dock's refusal is the person's own, and names the one
    // place they fix it — the same sentence the page's composer and the
    // refused turn's transcript line carry.
    // U39-10: as a visible note with the place linked, not a placeholder cut
    // after the dock's two rows. CANARY: drop <NotConnectedNote /> from the dock.
    // Waited for: under a loaded suite the note can commit after the focus move.
    await waitFor(() =>
      expect(panel.querySelector(".ctl-composer [data-not-connected]")?.textContent).toMatch(
        /your own Claude account/,
      ),
    );
    const note = panel.querySelector(".ctl-composer [data-not-connected]");
    expect(note?.querySelector('a[href="/profile"]')?.textContent).toBe("Profile → Agent accounts");
    // Ruling 319: the note is the one statement; the box and the empty state
    // do not add a placeholder or examples nobody here could send.
    // CANARY: restore the not-connected placeholder, or the examples.
    expect(composer.hasAttribute("placeholder")).toBe(false);
    expect(panel.querySelector(".ctl-examples")).toBeNull();
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
   * Interface review 2026-09-24 (acce-14): no focus trap (ruling 318), so Tab
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

  it("forgets a picked thread the server could not honour (review finding 2)", async () => {
    // A thread from the list that is gone by the time its view is asked for.
    const { loads } = mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: (request) =>
        new URL(request.url).searchParams.get("c") === "cnv_gone"
          ? taskView({ staleSelection: true })
          : taskView({
              threads: [{ id: "cnv_gone", title: "Gone by now", lastMessageAt: "2026-09-01T10:00:00.000Z", unread: false }],
            }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" }));
    fireEvent.click(await screen.findByRole("button", { name: "Threads here (1)" }));
    fireEvent.click(await screen.findByRole("button", { name: /Gone by now/ }));
    // It asked once with the picked id, then dropped it for the scope's
    // newest thread — the page is intact. CANARY: drop the `stale` effect and
    // the dock stays on the id the server refused.
    await waitFor(() => expect(loads.at(-1)?.searchParams.get("c")).toBe("cnv_gone"));
    await waitFor(() => expect(loads.at(-1)?.searchParams.has("c")).toBe(false));
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

  /**
   * Ruling 256, test audit L14-29: a signed-out tab's dock loads used to
   * navigate it to /login. They now answer 401 with an empty status and the
   * signed-out view (returned, not thrown, so the view reaches the panel
   * rather than the `clientLoader`'s failure answer), and the panel says what
   * happened and what to do, blaming neither the scope nor a missing Claude
   * account.
   */
  it("says the person is signed out, and offers no composer, on a signed-out tab", async () => {
    mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () =>
        taskView({
          signedOut: true,
          unavailable: true,
          available: false,
          scope: {
            ...taskView().scope,
            projectName: null,
            label: "Signed out",
            contextLine: "Signed out: sign in again to talk to the controller.",
          },
        }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" }));
    const panel = await screen.findByRole("dialog", { name: "Controller dock" });
    // CANARY: drop the panel's `signedOut` branches and it says the task is
    // not open to the person, and that their Claude account isn't connected.
    await screen.findByText(
      "You're signed out, so the controller can't answer here. Reload the page to sign in again.",
    );
    expect(screen.queryByText(/nothing to work with here/)).toBeNull();
    expect(panel.querySelector("[data-not-connected]")).toBeNull();
    const composer = await screen.findByLabelText("Message to the controller");
    expect(composer.hasAttribute("disabled")).toBe(true);
    expect(composer.getAttribute("placeholder")).toBe("Sign in again to send a message.");
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

  it("ruling 285: at sheet width a pull down the header dismisses the dock, and focus comes back", async () => {
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
      // Focus returns after the close settles, a beat after the dialog leaves
      // the tree; a loaded full suite read it before (2026-09-28).
      await waitFor(() => expect(document.activeElement).toBe(trigger));
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
   * Finding 32, and ruling 11 (CTL-2): while a turn works the dock polls every
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
            ? { working: true, runId: "run_1", phase: null, step, answering: null, queued: [], steering: [] }
            : { working: false, runId: null, phase: null, step: null, answering: null, queued: [], steering: [] },
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
      // Ruling 257: the step moves between polls. CANARY: poll the view again
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
      replyTo: null,
      steeredInto: null,
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
    // replies arrive (ruling 11): the page's stream hands the dock the
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
            { id: "m2", conversationId: "cnv_a", seq: 2, author: "controller", userId: null, text: "VIB-2 waits on VIB-1.", runId: "run_1", surface: null, replyTo: null, steeredInto: null, createdAt: "2026-09-01T10:00:05.000Z" },
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
    // Ruling 319: cleared once the server TOOK it, not when it went out.
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
     * Ruling 319 (pass 37, F37-90): the composer keeps the words until the
     * server takes them. `setText("")` ran synchronously after
     * `fetcher.submit`, so this refusal — which happens BEFORE the controller
     * engine is reached, leaving the text in no transcript anywhere — used to
     * destroy what the person had written, with a toast that unmounts itself
     * after 2,600 ms as the only account of it.
     *
     * CANARY: move `setText("")` back beside `send.submit(...)`, or clear
     * before the `result.ok` check, and this is "".
     */
    // SAFETY: `findByLabelText("Message to the controller")` resolves the
    // composer, which the dock renders as a `<textarea>`.
    expect((composer as HTMLTextAreaElement).value).toBe("hello");
  });

  /**
   * Ruling 256: a request the server never answers (a restart, a 5xx, a dead
   * network) is the dock's, never the page's. React Router sends a fetcher's
   * failure to the error boundary of the route that owns the fetcher, and
   * root owns all three of the dock's, so a failed send, reload or working
   * poll replaced the whole page with root's error page. The send's
   * `clientAction` answers a failure as a refused send: the toast, and the
   * message kept. Each load's `clientLoader` answers null, which the dock
   * reads as it reads the time before its first answer: no reply waiting,
   * and the panel's loading lines, until the next load answers.
   */
  it("keeps the page when the server can't answer: a failed send toasts, a failed load reads as not loaded", async () => {
    let up = true;
    mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () => taskView(),
      unseen: () => [BOARD_REPLY],
      reachable: () => up,
    });
    fireEvent.click(await screen.findByRole("button", { name: /a new reply/ }));
    const composer = await screen.findByLabelText<HTMLTextAreaElement>("Message to the controller");
    await waitFor(() => expect(composer.hasAttribute("disabled")).toBe(false));
    expect(screen.queryByText("Reading where you are…")).toBeNull();
    fireEvent.change(composer, { target: { value: "hello" } });
    up = false;
    // CANARY: delete `resources.controller.ts`'s `clientAction` and the send
    // takes the page down with it.
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("The controller could not take that. Try again.");
    expect(composer.value).toBe("hello");
    // A conversation changed somewhere: the status and the open view reload.
    // CANARY: delete either route's `clientLoader` and this takes the page
    // down instead.
    act(() => {
      window.dispatchEvent(new Event(CONTROLLER_UPDATED_EVENT));
    });
    await screen.findByText("Reading where you are…");
    await waitFor(() => expect(screen.queryByRole("button", { name: /a new reply/ })).toBeNull());
    expect(screen.getByText("task page")).toBeTruthy();
  });

  it("renders the transcript and the working state", async () => {
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
            { id: "m1", conversationId: "cnv_a", seq: 1, author: "user", userId: "u1", text: "What is this?", runId: null, surface: "/projects/viberr/tasks/VIB-1", replyTo: null, steeredInto: null, createdAt: "2026-09-01T10:00:00.000Z" },
            { id: "m2", conversationId: "cnv_a", seq: 2, author: "controller", userId: null, text: "A **task**.", runId: "run_1", surface: null, replyTo: null, steeredInto: null, createdAt: "2026-09-01T10:00:05.000Z" },
          ],
          turn: { working: true, runId: "run_2", phase: null, step: null, answering: null, queued: [], steering: [] },
          threads: [{ id: "cnv_a", title: "First", lastMessageAt: "2026-09-01T10:00:00.000Z", unread: false }],
          viewerOwnsActive: true,
        }),
      // Ruling 11: the button's announcer reads the dock's status.
      working: () => [{ id: "cnv_a", projectSlug: "viberr", taskKey: "VIB-1", phase: null, step: null }],
    });
    const trigger = await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" });
    fireEvent.click(trigger);
    await screen.findByText("What is this?");
    expect(screen.getByText("task", { selector: "strong" })).toBeTruthy();
    // Two status regions by design (ruling 320): the visually-hidden
    // announcer beside the trigger, which survives a close and says a turn is
    // working, and the open panel's, which says the thread on screen replied.
    // The working row itself is visual only.
    expect(
      screen.getAllByRole("status").map((el) => el.textContent).join(" | "),
    ).toContain("Controller is working");
    // History never wears the entry animation marker.
    expect(document.querySelector(".ctl-msg[data-fresh]")).toBeNull();
    // Ruling 320: the transcript is a tab stop, so the keyboard scrolls it
    // (axe's scrollable-region-focusable). CANARY: drop its `tabIndex`.
    expect(screen.getByRole("region", { name: "Conversation transcript" }).getAttribute("tabindex")).toBe("0");
  });

  /**
   * Ruling 320 (F40-8): the dock reads a transcript the way the page does —
   * each reply under the message it answers, "answering now" and the working
   * row on the answered message, "queued · N ahead" on the ones behind it.
   */
  it("ruling 320: renders reply order and the queue from the server's view", async () => {
    const at = "2026-09-24T20:00:00.000Z";
    const msg = messagesAt(at);
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
            title: "Dossier",
            createdAt: at,
            updatedAt: at,
            lastMessageAt: at,
          },
          messages: [
            msg("p1", 1, "user", "Part one."),
            msg("p2", 2, "user", "Part two."),
            msg("p3", 3, "user", "Part three."),
            msg("r1", 4, "controller", "Filed part one.", "p1"),
          ],
          turn: {
            working: true,
            runId: "run_live",
            phase: null,
            step: null,
            answering: "p2",
            queued: [{ messageId: "p3", ahead: 1 }],
            steering: [],
          },
          threads: [{ id: "cnv_a", title: "Dossier", lastMessageAt: at, unread: false }],
          viewerOwnsActive: true,
        }),
      working: () => [{ id: "cnv_a", projectSlug: "viberr", taskKey: "VIB-1", phase: null, step: null }],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" }));
    await screen.findByText("Part three.");
    const order = [...document.querySelectorAll(".dock-msgs > .ctl-msg, .dock-msgs > .ctl-working")].map((el) =>
      el.classList.contains("ctl-working") ? "WORKING" : (el.querySelector(".md-body")?.textContent ?? "").trim(),
    );
    // CANARY: map the dock's `messages` in seq order again.
    expect(order).toEqual(["Part one.", "Filed part one.", "Part two.", "WORKING", "Part three."]);
    const states = [...document.querySelectorAll(".dock-msgs > .ctl-msg")].map(
      (el) => el.querySelector("[data-msg-state]")?.textContent ?? null,
    );
    // CANARY: drop <MessageState> from the dock's header.
    expect(states).toEqual([null, null, "answering now", "queued · 1 ahead"]);
  });

  it("ruling 251: steering sits in its turn, Retract fills the composer, and Queue waits behind the turn", async () => {
    const at = "2026-09-27T16:00:00.000Z";
    const msg = messagesAt(at);
    const { sends } = mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () =>
        taskView({
          conversation: {
            id: "cnv_a",
            userId: "u1",
            userLabel: "arda@viberr.dev",
            projectSlug: "viberr",
            taskKey: "VIB-1",
            title: "Agents",
            createdAt: at,
            updatedAt: at,
            lastMessageAt: at,
          },
          messages: [msg("p1", 1, "user", "Tidy the agents."), msg("q", 2, "user", "Then list them."), msg("s", 3, "user", "The KB is gone too.")],
          turn: {
            working: true,
            runId: "run_live",
            phase: null,
            step: null,
            answering: "p1",
            queued: [{ messageId: "q", ahead: 1 }],
            steering: ["s"],
          },
          threads: [{ id: "cnv_a", title: "Agents", lastMessageAt: at, unread: false }],
          viewerOwnsActive: true,
        }),
      working: () => [{ id: "cnv_a", projectSlug: "viberr", taskKey: "VIB-1", phase: null, step: null }],
      action: (form) =>
        form.get("intent") === "retract"
          ? { ok: true, retracted: "Then list them.", toast: "Taken back into your composer." }
          : { ok: true, conversationId: "cnv_a" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" }));
    await screen.findByText("The KB is gone too.");
    const rows = [...document.querySelectorAll<HTMLElement>(".dock-msgs > .ctl-msg, .dock-msgs > .ctl-working")];
    // CANARY: drop `turn` from the dock's `inReplyOrder` and the steering
    // message sits below the queued one.
    expect(
      rows.map((el) =>
        el.classList.contains("ctl-working")
          ? "WORKING"
          : `${el.querySelector(".md-body")?.textContent?.trim()} | ${el.querySelector("[data-msg-state]")?.textContent}`,
      ),
    ).toEqual([
      "Tidy the agents. | answering now",
      "The KB is gone too. | steering · next step",
      "WORKING",
      "Then list them. | queued · 1 ahead",
    ]);

    const composer = await screen.findByLabelText<HTMLTextAreaElement>("Message to the controller");
    await waitFor(() => expect(composer.hasAttribute("disabled")).toBe(false));
    fireEvent.change(composer, { target: { value: "And the scheduler." } });
    // CANARY: drop the dock's `onRetracted` and the message is gone from both places.
    fireEvent.click(within(rows[3]!).getByRole("button", { name: "Retract" }));
    await screen.findByText("Taken back into your composer.");
    expect(composer.value).toBe("And the scheduler.\n\nThen list them.");
    // CANARY: drop `mode` from the dock's send and the server steers it.
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends.map((f) => [f.get("intent"), f.get("messageId") ?? f.get("mode")])).toEqual([
      ["retract", "q"],
      ["send", "queue"],
    ]);
    expect(sends[1]!.get("text")).toBe("And the scheduler.\n\nThen list them.");
  });
});

/**
 * Ruling 319's clear, for a message that ends in whitespace, in the dock (the
 * page composer's twin). The dock sends the TRIMMED text, and its success
 * handler compared that against the raw box, so "hello " or a message ending
 * in a newline stayed in the box after the controller had taken it.
 */
describe("ruling 319: the dock compares the box with what went out, trimmed", () => {
  const typed = "hello \n";

  /** Opens the dock on VIB-1 and types `typed` into the composer. */
  async function typeIntoDock() {
    fireEvent.click(await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" }));
    const box = await screen.findByLabelText<HTMLTextAreaElement>("Message to the controller");
    await waitFor(() => expect(box.hasAttribute("disabled")).toBe(false));
    fireEvent.change(box, { target: { value: typed } });
    return box;
  }

  function clickSend() {
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
  }

  it("clears a message sent with a trailing space and newline", async () => {
    const { loads, sends } = mount({ path: "/projects/viberr/tasks/VIB-1", view: () => taskView() });
    const box = await typeIntoDock();
    clickSend();
    // The success handler selects the thread the send landed in; that load
    // shows the handler has run.
    await waitFor(() => expect(loads.at(-1)?.searchParams.get("c")).toBe("cnv_new"));
    expect(sends[0]!.get("text")).toBe("hello");
    // CANARY: compare the raw box (`cur === sent`) and this stays "hello \n".
    expect(box.value).toBe("");
  });

  it("keeps what was typed while the send was in flight", async () => {
    const { loads, sends } = mount({ path: "/projects/viberr/tasks/VIB-1", view: () => taskView() });
    const box = await typeIntoDock();
    clickSend();
    // The person types on before the answer lands: nothing between the click
    // and this line awaits, and the stub's action is async, so the POST has
    // not even reached the action yet.
    fireEvent.change(box, { target: { value: `${typed}and the next thing` } });
    expect(sends.length).toBe(0);
    await waitFor(() => expect(loads.at(-1)?.searchParams.get("c")).toBe("cnv_new"));
    expect(sends[0]!.get("text")).toBe("hello");
    // CANARY: clear on every success and the next message is lost.
    expect(box.value).toBe(`${typed}and the next thing`);
  });
});

/**
 * Ruling 258: the dock's composer takes files. Picked ones show in its tray,
 * go out as a multipart form (files alone are a message), and leave the tray
 * only once the server took them.
 */
describe("ruling 258: files from the dock", () => {
  /** A file the request body can carry, as a browser's can. jsdom's `File`
   *  is not one Node's `Request` encodes or parses back, and jsdom's
   *  `FormData` turns Node's `File` into a string, so these tests run on
   *  Node's pair (installed below; `File` here is Node's). */
  const file = (bits: string, name: string) => new File([bits], name);
  beforeEach(async () => {
    // Node's own FormData, from a body Node parsed (jsdom replaces the global).
    const nodeForm = await new Response(new URLSearchParams("a=1")).formData();
    vi.stubGlobal("FormData", nodeForm.constructor);
    vi.stubGlobal("File", NodeFile);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function pickIntoDock(files: File[]) {
    fireEvent.click(await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" }));
    const box = await screen.findByLabelText<HTMLTextAreaElement>("Message to the controller");
    await waitFor(() => expect(box.hasAttribute("disabled")).toBe(false));
    // SAFETY: AttachButton renders its picker as the input beside it.
    const picker = screen.getByRole("button", { name: "Attach files" }).nextElementSibling as HTMLInputElement;
    fireEvent.change(picker, { target: { files } });
  }

  it("sends the tray's files with no words, and empties the tray once the server took them", async () => {
    // CANARY: drop the `files` append from the dock's send and the form
    // carries no file; clear the tray at submit and the failure below loses it.
    const { sends } = mount({ path: "/projects/viberr/tasks/VIB-1", view: () => taskView() });
    await pickIntoDock([file("host,cpu", "inventory.csv")]);
    expect(screen.getByRole("list", { name: "1 of 10 files attached" }).textContent).toContain("inventory.csv");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends.length).toBe(1));
    const sent = sends[0]!.getAll("files");
    expect(sent).toHaveLength(1);
    const got = sent[0];
    if (!(got instanceof NodeFile)) throw new Error("the form carried the file as a string");
    expect(await got.text()).toBe("host,cpu");
    await waitFor(() => expect(screen.queryByRole("list", { name: /files attached/ })).toBeNull());
  });

  it("keeps the tray when the send fails, and says why a file was refused", async () => {
    mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () => taskView(),
      action: () => ({ ok: false, error: "That request expired." }),
    });
    await pickIntoDock([file("a", "notes.txt"), file("x".repeat(10 * 1024 * 1024 + 1), "memory.dmp")]);
    expect(screen.getByRole("alert").textContent).toContain("memory.dmp");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("That request expired.");
    expect(screen.getByRole("list", { name: "1 of 10 files attached" }).textContent).toContain("notes.txt");
  });
});

/**
 * Ruling 286: the dock's Send named its work ("Sending…") but sat at the .45
 * refused step with no busy mark while the controller took the message. It is
 * `aria-busy` now, the loader spinning.
 * Canary: drop `aria-busy={busy || undefined}` in controller-dock-panel-regions.tsx
 * (`DockComposerFoot`).
 */
describe("ruling 286: the dock's send in flight", () => {
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
          csrf=""
          onPick={() => {}}
          onLeave={() => {}}
          composerRef={{ current: null }}
          onMount={() => {}}
          files={[]}
          onFiles={() => {}}
        />
      </MemoryRouter>,
    );
    const sending = screen.getByRole("button", { name: "Sending…" });
    expect(sending.getAttribute("aria-busy")).toBe("true");
    expect(sending.hasAttribute("disabled")).toBe(true);
    expect(sending.querySelector("svg.ico.spin")).not.toBeNull();
  });
});

/**
 * Ruling 285(b), the dock's deferred half (owner, 2026-09-24: "do the two dock
 * fixes now"), built on the 285(c) sheet. F20: the open and close can be turned
 * around mid-flight. F24: a panel the per-tab restore reopens appears in
 * place (`data-restored`). The motion itself is CSS, pinned in app.css.test.ts
 * "ruling 285: the dock's deferred half"; these are the component's halves.
 *
 * jsdom loads no stylesheet, so its transition duration reads 0 and a close
 * finishes at once. A test that needs the close in flight gives the panel the
 * desktop exit's duration inline, and the dock then waits for `transitionend`
 * (or its fallback timer) as it does in a browser.
 */
describe("ruling 285: the dock's deferred half", () => {
  const DIALOG = { name: "Controller dock" } as const;
  function leaveSlowly(panel: HTMLElement) {
    panel.style.setProperty("transition-duration", "0.12s");
  }

  it("(F20) a trigger click while the panel leaves takes the close back, and focus goes in", async () => {
    mount({ path: "/projects/viberr/tasks/VIB-1", view: () => taskView() });
    const trigger = await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" });
    await restored();
    fireEvent.click(trigger);
    const panel = await screen.findByRole("dialog", DIALOG);
    const composer = await screen.findByLabelText("Message to the controller");
    await waitFor(() => expect(document.activeElement).toBe(composer));
    leaveSlowly(panel);
    fireEvent.click(screen.getByRole("button", { name: "Close the controller dock" }));
    expect(panel.hasAttribute("data-closing")).toBe(true);
    // The person clicks the trigger again before the exit ends (a click
    // focuses the button it lands on).
    trigger.focus();
    // CANARY: drop the `closing` branch from `onTrigger`, the trigger's
    // click — the click is swallowed by the close already running, and the
    // panel goes.
    fireEvent.click(trigger);
    expect(panel.isConnected).toBe(true);
    expect(panel.hasAttribute("data-closing")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // It is the person's own open: focus goes in, as on any other.
    expect(document.activeElement).toBe(composer);
    // The close it took back never lands: not on the exit's transitionend,
    // not on the fallback timer (the exit's .12s plus 50ms).
    fireEvent.transitionEnd(panel);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.getByRole("dialog", DIALOG)).toBe(panel);
    expect(panel.hasAttribute("data-closing")).toBe(false);
    expect(window.sessionStorage.getItem("viberr.dock.open")).toBe("1");
    // One toggle per click: the next click closes it again.
    fireEvent.click(trigger);
    expect(panel.hasAttribute("data-closing")).toBe(true);
    fireEvent.transitionEnd(panel);
    await waitFor(() => expect(screen.queryByRole("dialog", DIALOG)).toBeNull());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(window.sessionStorage.getItem("viberr.dock.open")).toBe("0");
  });

  it("(F20) a close writes nothing on the panel: the exit starts from where it is, nothing pinned", async () => {
    // Ruling 285 amended: the dock no longer pins its live pose. Its
    // entrance is a transition, which `data-closing` retargets from wherever
    // it has got to; a pin's inline pose would only fight the reversal.
    // CANARY: put `pinLivePose(panelRef.current)` back in closeDock.
    mount({ path: "/projects/viberr/board", view: () => taskView() });
    const trigger = await screen.findByRole("button", { name: "Controller · viberr" });
    fireEvent.click(trigger);
    const panel = await screen.findByRole("dialog", DIALOG);
    leaveSlowly(panel);
    const before = panel.getAttribute("style");
    const observer = new MutationObserver(() => {});
    observer.observe(panel, { attributes: true, attributeFilter: ["style"] });
    fireEvent.click(screen.getByRole("button", { name: "Close the controller dock" }));
    expect(panel.hasAttribute("data-closing")).toBe(true);
    const writes = observer.takeRecords();
    observer.disconnect();
    expect(writes).toEqual([]);
    expect(panel.getAttribute("style")).toBe(before);
  });

  it("(F24) a restored panel is marked until the person's own open, and keeps the mark through its close", async () => {
    window.sessionStorage.setItem("viberr.dock.open", "1");
    mount({ path: "/projects/viberr/board", view: () => taskView() });
    const panel = await screen.findByRole("dialog", DIALOG);
    const dock = panel.closest<HTMLElement>(".dock")!;
    const trigger = screen.getByRole("button", { name: /^Controller · / });
    // CANARY: drop `setRestoredOpen(...)` from the restore effect.
    expect(dock.hasAttribute("data-restored")).toBe(true);
    // A pointer close keeps it while the panel leaves (the attribute is gated
    // on `open`, and the CSS already steps aside for `[data-closing]`)…
    // CANARY: clear it in closeDock.
    leaveSlowly(panel);
    fireEvent.click(trigger);
    expect(panel.hasAttribute("data-closing")).toBe(true);
    expect(dock.hasAttribute("data-restored")).toBe(true);
    fireEvent.transitionEnd(panel);
    // …and it leaves with the panel.
    await waitFor(() => expect(screen.queryByRole("dialog", DIALOG)).toBeNull());
    expect(dock.hasAttribute("data-restored")).toBe(false);
    // The person's own open plays its entrance.
    // CANARY: drop `setRestoredOpen(false)` from `onTrigger`'s open path.
    fireEvent.click(trigger);
    await screen.findByRole("dialog", DIALOG);
    expect(dock.hasAttribute("data-restored")).toBe(false);
  });

  it("(F24) a click that beat the restore's read is the person's own open, and keeps its entrance", async () => {
    // The race "keeps an open the person clicked before the restore had read
    // storage" pins above, with the tab remembering the dock open.
    // CANARY: set `restoredOpen` from `stored` alone.
    window.sessionStorage.setItem("viberr.dock.open", "1");
    const storage: Storage = Object.getPrototypeOf(window.sessionStorage);
    const read = storage.getItem;
    const spy = vi
      .spyOn(storage, "getItem")
      .mockImplementation(function (this: Storage, key: string) {
        if (key === "viberr.dock.open") document.querySelector<HTMLButtonElement>(".dock-fab")?.click();
        return read.call(this, key);
      });
    try {
      mount({ path: "/projects/viberr/board", view: () => taskView() });
      await screen.findByRole("dialog", DIALOG);
    } finally {
      spy.mockRestore();
    }
    const dock = document.querySelector<HTMLElement>(".dock")!;
    expect(dock.getAttribute("data-open")).toBe("true");
    expect(dock.hasAttribute("data-restored")).toBe(false);
  });

  it("(F20, F24) taking back a restored panel's close drops the mark, so the way back retargets", async () => {
    // Under `data-restored` the panel has no transition, and a reversal would
    // snap open instead of turning around from where the exit had got to.
    // CANARY: drop `setRestoredOpen(false)` from `onTrigger`'s closing branch.
    window.sessionStorage.setItem("viberr.dock.open", "1");
    mount({ path: "/projects/viberr/board", view: () => taskView() });
    const panel = await screen.findByRole("dialog", DIALOG);
    const dock = panel.closest<HTMLElement>(".dock")!;
    const trigger = screen.getByRole("button", { name: /^Controller · / });
    leaveSlowly(panel);
    fireEvent.click(trigger);
    expect(panel.hasAttribute("data-closing")).toBe(true);
    fireEvent.click(trigger);
    expect(panel.hasAttribute("data-closing")).toBe(false);
    expect(dock.hasAttribute("data-restored")).toBe(false);
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it("(F20) a click that lands after the exit ended, before React renders that, still keeps the panel open", async () => {
    // The exit's transitionend queues the unmount at default priority, which
    // renders a task later; Chrome can run a queued click first, and that
    // click's handler still sees `closing`. One `act` holds both, so neither
    // renders before the other has run.
    // CANARY: drop `setOpen(true)` from `onTrigger`'s closing branch — the
    // pending close lands after the take-back and unmounts the panel, and
    // focus falls to <body>.
    mount({ path: "/projects/viberr/tasks/VIB-1", view: () => taskView() });
    const trigger = await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" });
    await restored();
    fireEvent.click(trigger);
    const panel = await screen.findByRole("dialog", DIALOG);
    const composer = await screen.findByLabelText("Message to the controller");
    await waitFor(() => expect(document.activeElement).toBe(composer));
    leaveSlowly(panel);
    fireEvent.click(trigger);
    expect(panel.hasAttribute("data-closing")).toBe(true);
    trigger.focus();
    act(() => {
      fireEvent.transitionEnd(panel);
      fireEvent.click(trigger);
    });
    expect(panel.isConnected).toBe(true);
    expect(panel.hasAttribute("data-closing")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(composer);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.getByRole("dialog", DIALOG)).toBe(panel);
    expect(window.sessionStorage.getItem("viberr.dock.open")).toBe("1");
  });

  it("(F24) under StrictMode, as on the dev server, a restored panel is still marked", async () => {
    // React runs mount effects twice there, and between the runs the `[open]`
    // write has stored "0": the second restore reads a closed dock.
    // CANARY: set `restoredOpen` with a plain value again
    // (`setRestoredOpen(fromStore)`) — the second run clears the mark.
    window.sessionStorage.setItem("viberr.dock.open", "1");
    mount({ path: "/projects/viberr/board", view: () => taskView(), strict: true });
    const panel = await screen.findByRole("dialog", DIALOG);
    const dock = panel.closest<HTMLElement>(".dock")!;
    expect(dock.getAttribute("data-open")).toBe("true");
    expect(dock.hasAttribute("data-restored")).toBe(true);
  });

  describe("at sheet width, a close that interrupts a pull's settle", () => {
    // Ruling 285: the (c) gesture under the (b) take-back. The 720px block's
    // flag makes the panel a sheet; jsdom lays nothing out, so the sheet's
    // height is stubbed (halfway at 300px).
    let height: { mockRestore(): void } | null = null;
    function sheet(panel: HTMLElement) {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: (query: string) => ({ matches: false, media: query }),
      });
      height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
      panel.style.setProperty("--sheet-draggable", "1");
      const head = panel.querySelector<HTMLElement>("header.dock-head")!;
      return (type: string, y: number) =>
        fireEvent(
          head,
          new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, clientY: y, bubbles: true }),
        );
    }
    afterEach(() => {
      height?.mockRestore();
      height = null;
      Reflect.deleteProperty(window, "matchMedia");
    });

    it("lets go of the gesture at the close, so taking the close back retargets instead of snapping to the spring", async () => {
      // CANARY: pass `open` (not `open && !closing`) to useSheetDrag — the
      // host keeps `data-sheet-drag` through the close, and the take-back
      // drops [data-closing] under the drag rule's `transition: none`.
      mount({ path: "/projects/viberr/board", view: () => taskView() });
      const trigger = await screen.findByRole("button", { name: "Controller · viberr" });
      fireEvent.click(trigger);
      const panel = await screen.findByRole("dialog", DIALOG);
      const dock = panel.closest<HTMLElement>(".dock")!;
      const at = sheet(panel);
      leaveSlowly(panel);
      // A pull of 180px, held still, then let go short of halfway: the
      // return spring runs.
      at("pointerdown", 100);
      for (let y = 120; y <= 300; y += 20) at("pointermove", y);
      await new Promise((resolve) => setTimeout(resolve, 80));
      at("pointerup", 300);
      expect(dock.hasAttribute("data-sheet-drag")).toBe(true);
      fireEvent.click(trigger);
      expect(panel.hasAttribute("data-closing")).toBe(true);
      expect(dock.hasAttribute("data-sheet-drag")).toBe(false);
      expect(dock.style.getPropertyValue("--sheet-drag")).toBe("");
      fireEvent.click(trigger);
      expect(panel.hasAttribute("data-closing")).toBe(false);
      expect(dock.hasAttribute("data-sheet-drag")).toBe(false);
      // No frame of the stopped spring writes it back.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(dock.hasAttribute("data-sheet-drag")).toBe(false);
      expect(dock.style.getPropertyValue("--sheet-drag")).toBe("");
      expect(screen.getByRole("dialog", DIALOG)).toBe(panel);
    });

    it("a dismiss throw the person closes and then takes back does not dismiss the dock anyway", async () => {
      // CANARY: pass `open` (not `open && !closing`) to useSheetDrag — the
      // throw's spring runs on under the take-back, reaches the bottom and
      // calls onDismiss, and the panel the person kept open unmounts.
      mount({ path: "/projects/viberr/board", view: () => taskView() });
      const trigger = await screen.findByRole("button", { name: "Controller · viberr" });
      fireEvent.click(trigger);
      const panel = await screen.findByRole("dialog", DIALOG);
      const dock = panel.closest<HTMLElement>(".dock")!;
      const at = sheet(panel);
      leaveSlowly(panel);
      at("pointerdown", 100);
      for (let y = 120; y <= 500; y += 20) at("pointermove", y);
      at("pointerup", 500);
      fireEvent.click(trigger);
      fireEvent.click(trigger);
      expect(panel.hasAttribute("data-closing")).toBe(false);
      // Well past the throw's own settle.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(screen.getByRole("dialog", DIALOG)).toBe(panel);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(dock.hasAttribute("data-sheet-drag")).toBe(false);
    });
  });
});

/**
 * Ruling 320 and (d) in the dock: the page's rules, in the panel a person
 * carries onto every page. Live, the dock's transcript was 400px wide at every
 * desktop width, so a reply opened at its tail there even on a desktop, and the
 * announcer beside its button cleared to "" when the reply on screen landed.
 */
describe("ruling 320: the dock meets a reply at its first line, and says it arrived", () => {
  const at = "2026-09-24T23:40:00.000Z";
  const msg = messagesAt(at);
  const idle = { working: false, runId: null, phase: null, step: null, answering: null, queued: [], steering: [] };

  function body(messages: ReturnType<typeof msg>[], working: boolean) {
    const turn = working ? { ...idle, working: true, runId: "run_live", answering: "p1" } : idle;
    return (
      <MemoryRouter>
        <DockPanelBody
          current={taskView({ conversation: conversationFixture(), messages, turn, viewerOwnsActive: true })}
          turn={turn}
          unseen={[]}
          threadsOpen={false}
          busy={false}
          disabled={false}
          text=""
          onText={() => {}}
          onSubmit={() => {}}
          csrf=""
          onPick={() => {}}
          onLeave={() => {}}
          composerRef={{ current: null }}
          onMount={() => {}}
          files={[]}
          onFiles={() => {}}
        />
      </MemoryRouter>
    );
  }

  const box = () => document.querySelector<HTMLElement>(".dock-transcript")!;

  /** Layout jsdom does not do: a 388px transcript box over 3,000px of
   *  content, `p1` at its top and `r1` 700px down. */
  function stubDockTranscript(): () => void {
    const tops = new Map([["p1", 0], ["r1", 700]]);
    const spies = [
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("dock-transcript") ? 3000 : 0;
      }),
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("dock-transcript") ? 388 : 0;
      }),
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        const top = tops.get(this.dataset.messageId ?? "");
        return DOMRect.fromRect({ x: 0, y: top === undefined ? 0 : top - box().scrollTop, width: 388, height: 100 });
      }),
    ];
    return () => {
      for (const spy of spies) spy.mockRestore();
    };
  }
  const asked = msg("p1", 1, "user", "Is the feed live?");
  const answered = [asked, msg("r1", 2, "controller", "Yes. Both feeds answer.", "p1")];

  it("(c) scrolls to the first line of a reply that lands, not to the end", () => {
    // CANARY: restore `el.scrollTop = el.scrollHeight` in the dock's effect.
    const restore = stubDockTranscript();
    try {
      const { rerender } = render(body([asked], true));
      expect(box().scrollTop).toBe(3000);
      rerender(body(answered, false));
      expect(box().scrollTop).toBe(692);
    } finally {
      restore();
    }
  });

  it("(ruling 320) offers a reader scrolled up in the dock the page's way back", async () => {
    // CANARY: drop the dock's <TranscriptJumpButton>, and the wheel is the
    // only way back down the panel.
    const restore = stubDockTranscript();
    try {
      render(body(answered, false));
      expect(box().scrollTop).toBe(692);
      expect(within(box()).queryByRole("button", { name: "Latest" })).toBeNull();
      box().scrollTop = 0;
      fireEvent.scroll(box());
      fireEvent.click(await within(box()).findByRole("button", { name: "Latest" }));
      expect(box().scrollTop).toBe(692);
    } finally {
      restore();
    }
  });

  it("(d) the open panel says the thread on screen replied, and its working row is no region", () => {
    // CANARY: drop the panel's announcer: the only status left is the
    // button's, which leaves the thread on screen out.
    const { rerender } = render(body([msg("p1", 1, "user", "Is the feed live?")], true));
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");
    expect(document.querySelector(".ctl-working")!.hasAttribute("role")).toBe(false);
    rerender(body([msg("p1", 1, "user", "Is the feed live?"), msg("r1", 2, "controller", "Yes. Both feeds answer.", "p1")], false));
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toBe("Controller replied: Yes.");
  });
});

/**
 * Ruling 256 (owner, 2026-09-27: "this view shows old run(I made a new one),
 * also shows like there is a pending message that I didn't read yet ... I want
 * this for real but for only new messages else I don't want it"). The owner's
 * instance dock showed the thread it had shown before while the conversation
 * they had since started on the full page worked, and the button's pulsing
 * working dot read as a reply waiting.
 */
describe("ruling 256: the dock opens on the newest thread, and its one dot is a reply not yet read", () => {
  /** VIB-1's threads as the view lists them, newest first. */
  const threads = [
    { id: "cnv_new", title: "Started on the full page", lastMessageAt: "2026-09-27T16:18:00.000Z", unread: false },
    { id: "cnv_old", title: "Which model are you now?", lastMessageAt: "2026-09-27T16:13:00.000Z", unread: false },
  ];

  async function pickOlder(loads: URL[]) {
    fireEvent.click(await screen.findByRole("button", { name: "Threads here (2)" }));
    fireEvent.click(await screen.findByRole("button", { name: /Which model are you now\?/ }));
    await waitFor(() => expect(loads.at(-1)?.searchParams.get("c")).toBe("cnv_old"));
  }

  it("(a) every open asks for the newest thread; a pick holds only while the panel stays open", async () => {
    const { loads } = mount({ path: "/projects/viberr/tasks/VIB-1", view: () => taskView({ threads }) });
    const trigger = await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" });
    fireEvent.click(trigger);
    await waitFor(() => expect(loads.length).toBe(1));
    expect(loads[0]!.searchParams.has("c")).toBe(false);
    await pickOlder(loads);

    // Closed, then opened again: the newest thread, not the one picked.
    // CANARY: drop `setSelected({})` from `onTrigger`'s open, and this asks
    // for cnv_old.
    fireEvent.click(screen.getByRole("button", { name: "Close the controller dock" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Controller dock" })).toBeNull());
    const closed = loads.length;
    fireEvent.click(trigger);
    await waitFor(() => expect(loads.length).toBe(closed + 1));
    expect(loads.at(-1)!.searchParams.has("c")).toBe(false);

    // The owner's path: the panel open on the older thread, off to the full
    // page (which carries no dock; the tab remembers the panel open), and back.
    // CANARY: keep the selection in sessionStorage again, and the panel comes
    // back asking for cnv_old.
    await pickOlder(loads);
    fireEvent.click(screen.getByRole("link", { name: "open the controller page" }));
    await screen.findByText("controller page");
    expect(screen.queryByRole("dialog", { name: "Controller dock" })).toBeNull();
    const away = loads.length;
    fireEvent.click(screen.getByRole("link", { name: "back to VIB-1" }));
    await screen.findByRole("dialog", { name: "Controller dock" });
    await waitFor(() => expect(loads.length).toBe(away + 1));
    expect(loads.at(-1)!.searchParams.has("c")).toBe(false);
  });

  it("(b) the button shows no dot for a working turn, and the unread dot while one works", async () => {
    let replied = false;
    mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () => taskView(),
      working: () => [{ id: "cnv_a", projectSlug: "viberr", taskKey: "VIB-1", phase: null, step: null }],
      unseen: () => (replied ? [BOARD_REPLY] : []),
    });
    const trigger = await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" });
    // The status has landed: the announcer says the turn works (ruling 320).
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Controller is working"));
    // CANARY: put the `.live-dot` back on the trigger.
    expect(trigger.querySelector(".live-dot, .unseen-dot")).toBeNull();

    // A reply lands in another thread while the turn still works.
    replied = true;
    act(() => {
      window.dispatchEvent(new Event(CONTROLLER_UPDATED_EVENT));
    });
    const fab = await screen.findByRole("button", { name: /a new reply/ });
    // CANARY: gate the unread dot on `!working` again, and nothing shows.
    expect(fab.querySelector(".unseen-dot")).not.toBeNull();
    expect(fab.querySelector(".live-dot")).toBeNull();
  });
});
