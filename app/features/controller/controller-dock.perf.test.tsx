// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ControllerDockView } from "./controller-dock-query.server";
import { mountDock } from "../../../test-support/controller-dock-stub";
import { expectWithinBudget } from "../../../test-support/perf-ratchet";
import { FakeEventSource } from "../../../test-support/fake-event-source";
// The open panel's chunk, compiled while this file loads, where no deadline
// runs: on a loaded machine the compile alone took seconds. The dock still
// imports it when it opens (openDock) and finds it ready.
import "./controller-dock-panel";

/**
 * Ruling 457, the controller journey: what the dock costs the page under it.
 * Every figure is a count of requests (the dock's view, its unseen list, the
 * page's own loaders) on the routed stub every dock test uses, so it moves
 * only when the code does.
 */

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Lets every request a step started, and its effects, finish. The stub's
 *  loaders answer synchronously, so a short quiet spell is the end of it. */
async function settle() {
  for (let i = 0; i < 3; i += 1) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  }
}

const CONVERSATION = {
  id: "cnv_a",
  userId: "u1",
  userLabel: "arda@viberr.dev",
  projectSlug: "viberr",
  taskKey: null,
  title: "Plan the release",
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
  lastMessageAt: "2026-09-01T10:00:00.000Z",
};

/** A board thread of thirty messages, as the discovery measured. */
function boardView(over: Partial<ControllerDockView> = {}): ControllerDockView {
  const messages: ControllerDockView["messages"] = Array.from({ length: 30 }, (_, i) => ({
    id: `m${i + 1}`,
    conversationId: "cnv_a",
    seq: i + 1,
    author: i % 2 === 0 ? ("user" as const) : ("controller" as const),
    userId: i % 2 === 0 ? "u1" : null,
    text: i % 2 === 0 ? "Where is VIB-1? ".repeat(25) : "VIB-1 waits on review. ".repeat(65),
    runId: i % 2 === 0 ? null : `run_${i}`,
    surface: null,
    replyTo: null,
    steeredInto: null,
    createdAt: "2026-09-01T10:00:00.000Z",
  }));
  return {
    available: true,
    controllerName: "Controller",
    unavailable: false,
    staleSelection: false,
    scope: {
      kind: "board",
      projectSlug: "viberr",
      taskKey: null,
      projectName: "Viberr",
      label: "Viberr",
      contextLine: "Knows the Viberr board: stages, members, open tasks, goal chains · acts with your permissions",
      pageHref: "/projects/viberr/controller",
    },
    conversation: CONVERSATION,
    messages,
    taskLinks: { "VIB-1": "/projects/viberr/tasks/VIB-1" },
    turn: { working: false, runId: null, phase: null, step: null, answering: null, queued: [], steering: [] },
    threads: [{ id: "cnv_a", title: "Plan the release", lastMessageAt: "2026-09-01T10:00:00.000Z", unread: false }],
    viewerOwnsActive: true,
    ...over,
  };
}

function taskView(): ControllerDockView {
  return {
    ...boardView(),
    scope: {
      kind: "task",
      projectSlug: "viberr",
      taskKey: "VIB-1",
      projectName: "Viberr",
      label: "VIB-1 · Viberr",
      contextLine: "Knows the VIB-1 task file · acts with your permissions",
      pageHref: "/projects/viberr/controller",
    },
    conversation: null,
    messages: [],
    threads: [],
  };
}

function viewFor(request: Request): ControllerDockView {
  return new URL(request.url).searchParams.get("task") ? taskView() : boardView();
}

function dockRequests(m: { loads: URL[]; unseenLoads: URL[] }): number {
  return m.loads.length + m.unseenLoads.length;
}

/** Opens the dock with its body on screen. The open panel's body is its own
 *  chunk (ruling 457, FL-1): act() awaits the import the click starts and
 *  commits the body once it resolves, so no deadline races the host (inside
 *  act, React reveals a resolved boundary at once, with no 300 ms throttle).
 *  Polled against findBy's one-second deadline while the chunk compiled, the
 *  send test met the "Loading…" stand-in, not the composer, under a loaded
 *  suite. */
async function openDock() {
  // The stub's first navigation and the dock's mount loads are promise
  // chains that act() runs to their end. Polled against findBy's one-second
  // deadline instead, a loaded suite found the page still empty.
  await settle();
  const button = screen.getByRole("button", { name: /^Controller · / });
  await act(async () => {
    fireEvent.click(button);
    await import("./controller-dock-panel");
  });
  await screen.findByRole("dialog", { name: "Controller dock" });
  await settle();
}

async function closeDock() {
  fireEvent.click(screen.getByRole("button", { name: "Close the controller dock" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Controller dock" })).toBeNull());
  await settle();
}

describe("the closed dock's cost to every page (ruling 457, RF-8 / CTL-3)", () => {
  it("adds no request to a client navigation", async () => {
    const m = mountDock({ path: "/projects/viberr/board", view: viewFor });
    await screen.findByText("board page");
    await settle();
    const before = dockRequests(m);
    fireEvent.click(screen.getByRole("link", { name: "open VIB-1" }));
    await screen.findByText("task page");
    await settle();
    fireEvent.click(screen.getByRole("link", { name: "back to the board" }));
    await screen.findByText("board page");
    await settle();
    expectWithinBudget("controller:closed-dock.requests-per-navigation", (dockRequests(m) - before) / 2);
  });

  it("adds no request to a page revalidation, even after it was opened once", async () => {
    const m = mountDock({ path: "/projects/viberr/board", view: viewFor });
    await openDock();
    await closeDock();
    const before = dockRequests(m);
    const closedLoads = m.loads.length;
    for (let i = 0; i < 3; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "revalidate page" }));
      await settle();
    }
    expectWithinBudget("controller:closed-dock.requests-per-revalidation", (dockRequests(m) - before) / 3);
    // Ruling 448: only the OPEN dock reads the transcript it shows.
    expect(m.loads.slice(closedLoads).filter((u) => u.searchParams.get("seen") === "1")).toEqual([]);
  });
});

describe("one dock send (ruling 457, CTL-4)", () => {
  it("loads the thread once and leaves the page's loaders alone", async () => {
    const m = mountDock({
      path: "/projects/viberr/board",
      view: viewFor,
      action: () => ({ ok: true, conversationId: "cnv_a" }),
    });
    await openDock();
    const composer = screen.getByLabelText<HTMLTextAreaElement>("Message to the controller");
    await waitFor(() => expect(composer.disabled).toBe(false));
    const views = m.loads.length;
    const pages = m.pageLoads.length;
    fireEvent.change(composer, { target: { value: "Move VIB-1 along" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(m.sends.length).toBe(1));
    await settle();
    expectWithinBudget("controller:dock-send.view-loads", m.loads.length - views);
    expectWithinBudget("controller:dock-send.page-loader-runs", m.pageLoads.length - pages);
    // The one load is the thread the send landed in, read by the open panel.
    expect(m.loads.at(-1)!.searchParams.get("seen")).toBe("1");
  });
});

describe("a controller event on a page that shows no conversation (ruling 457, CTL-4)", () => {
  it("refreshes the dock, not the page", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    FakeEventSource.instances = [];
    const m = mountDock({ path: "/projects/viberr/board", view: viewFor, live: true });
    // The first navigation, run to its end inside act() (see openDock).
    await settle();
    expect(screen.getByText("board page")).toBeTruthy();
    const pages = m.pageLoads.length;
    const unseen = m.unseenLoads.length;
    act(() => {
      FakeEventSource.instances.at(-1)!.emit("controller.updated");
    });
    // The live stream debounces 300 ms before it acts.
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    await settle();
    expectWithinBudget("controller:controller-event.page-loader-runs", m.pageLoads.length - pages);
    // The dot still hears it.
    expect(m.unseenLoads.length - unseen).toBeGreaterThanOrEqual(1);
  });
});

describe("a working turn (ruling 457, CTL-2)", () => {
  it("polls without re-fetching the transcript", async () => {
    // The turn starts once the page has settled: the poll's clock is armed by
    // the answer that says a turn works, so the fake clock goes in first and
    // every step after it is an awaited act().
    let started = false;
    const m = mountDock({
      path: "/projects/viberr/board",
      view: () =>
        boardView({
          turn: started
            ? { working: true, runId: "run_live", phase: null, step: "Reading VIB-1", answering: null, queued: [], steering: [] }
            : { working: false, runId: null, phase: null, step: null, answering: null, queued: [], steering: [] },
        }),
      working: () =>
        started
          ? [{ id: "cnv_a", projectSlug: "viberr", taskKey: null, phase: null, step: "Reading VIB-1" }]
          : [],
    });
    await screen.findByText("board page");
    await settle();
    vi.useFakeTimers();
    started = true;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Controller · / }));
    });
    expect(screen.getByText("Controller is working")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close the controller dock" }));
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.queryByRole("dialog", { name: "Controller dock" })).toBeNull();
    const views = m.loads.length;
    const statuses = m.unseenLoads.length;
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
    }
    expectWithinBudget("controller:working-poll.view-loads-per-tick", (m.loads.length - views) / 3);
    // The poll itself still runs, on the small status.
    expect(m.unseenLoads.length - statuses).toBe(3);
  });
});
