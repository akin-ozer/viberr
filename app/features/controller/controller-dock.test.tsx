// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRoutesStub, Outlet } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { ControllerDock } from "./controller-dock";
import type { ControllerDockView } from "./controller-dock-query.server";

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
    turn: { working: false, runId: null, phase: null, step: null },
    threads: [],
    viewerOwnsActive: false,
    ...over,
  };
}

interface MountOptions {
  path: string;
  view: (request: Request) => ControllerDockView;
  action?: (form: FormData) => { ok: true; conversationId: string } | { ok: false; error: string };
}

function mount(opts: MountOptions) {
  const loads: URL[] = [];
  const sends: FormData[] = [];
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      loader: () => ({ csrf: "tok", theme: "system" }),
      Component: () => (
        <ToastProvider>
          <Outlet />
          <ControllerDock />
        </ToastProvider>
      ),
      children: [
        {
          id: "routes/project",
          path: "projects/:slug",
          Component: () => <Outlet />,
          children: [
            { id: "routes/project.board", path: "board", Component: () => <div>board page</div> },
            { id: "routes/project.task", path: "tasks/:key", Component: () => <div>task page</div> },
            { id: "routes/project.controller", path: "controller", Component: () => <div>controller page</div> },
          ],
        },
        {
          id: "routes/resources.controller",
          path: "resources/controller",
          loader: ({ request }) => {
            loads.push(new URL(request.url));
            return { view: opts.view(request) };
          },
          action: async ({ request }) => {
            const form = await request.formData();
            sends.push(form);
            return opts.action ? opts.action(form) : { ok: true as const, conversationId: "cnv_new" };
          },
        },
      ],
    },
  ]);
  const utils = render(<Stub initialEntries={[opts.path]} />);
  return { ...utils, loads, sends };
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
    expect(composer.getAttribute("placeholder")).toMatch(
      /your own Claude account/,
    );
    expect(composer.getAttribute("placeholder")).toMatch(
      /Profile → Agent accounts/,
    );
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

  it("the Threads toggle keeps one name and lets aria-pressed carry the state (finding 25)", async () => {
    mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () => taskView({ threads: [{ id: "cnv_a", title: "First", lastMessageAt: null }] }),
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

  it("keeps polling while a turn works, and stops when it settles (finding 32)", async () => {
    let working = true;
    const { loads } = mount({
      path: "/projects/viberr/tasks/VIB-1",
      view: () => taskView({ turn: { working, runId: "run_1", phase: null, step: null } }),
    });
    const trigger = await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" });
    // The poll is armed by an effect of the VIEW that says a turn is working —
    // not by the click, and not by the request for that view. This test used
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
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(trigger);
      });
      expect(screen.getByText("Controller is working")).toBeTruthy();
      const afterOpen = loads.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(loads.length).toBe(afterOpen + 1);
      // The turn settles: the next answer says so, and the poll stops asking.
      working = false;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(screen.queryByText("Controller is working")).toBeNull();
      const afterSettle = loads.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(loads.length).toBe(afterSettle);
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
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mount({
        path: "/projects/viberr/tasks/VIB-1",
        view: () =>
          taskView({
            conversation: conversationFixture(),
            messages,
            viewerOwnsActive: true,
            // A working turn is what makes the dock poll, which is how the
            // second message arrives while the panel is up.
            turn: { working: true, runId: "run_1", phase: null, step: null },
          }),
      });
      fireEvent.click(await screen.findByRole("button", { name: "Controller · VIB-1 · viberr" }));
      await screen.findByText("first");
      // History never wears the marker…
      expect(document.querySelector(".ctl-msg[data-fresh]")).toBeNull();
      // …but the reply that lands while the panel is up does.
      messages = [first, second];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      await screen.findByText("second");
      const fresh = [...document.querySelectorAll(".ctl-msg[data-fresh]")].map(
        (el) => el.textContent ?? "",
      );
      expect(fresh.some((t) => t.includes("second"))).toBe(true);
      expect(fresh.some((t) => t.includes("first"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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
            { id: "cnv_a", title: "First thread", lastMessageAt: "2026-09-01T10:00:00.000Z" },
            { id: "cnv_b", title: "Second thread", lastMessageAt: "2026-09-01T11:00:00.000Z" },
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
    expect(form.get("_csrf")).toBe("tok");
    expect(form.get("conversationId")).toBe("");
    await waitFor(() => expect(loads.at(-1)?.searchParams.get("c")).toBe("cnv_new"));
    // The composer is cleared once the send went out.
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
          threads: [{ id: "cnv_a", title: "First", lastMessageAt: "2026-09-01T10:00:00.000Z" }],
          viewerOwnsActive: true,
        }),
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
