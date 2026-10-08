// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import { getSseBrokerStats } from "~/server/events/sse-broker.server";
import {
  advance,
  BrokerEventSource,
  connect,
  dropCard,
  harnessLifecycle,
  markRead,
  mountHarness,
  notificationRead,
  OTHER_SLUG,
  OTHER_TASK,
  runLogAppended,
  runStateChanged,
  savedComments,
  sendComment,
  settle,
  SLUG,
  TASK,
  taskUpdated,
  tab,
  typeInFilter,
} from "../../../test-support/revalidation-harness";
import { REVALIDATION_RULES, revalidateWhen } from "./revalidation-policy";

/**
 * Ruling 457: the revalidation policy's behaviour, on the harness in
 * `test-support/revalidation-harness.tsx` (React Router with single fetch's
 * revalidation choice, the real broker in-process). The perf ratchet counts
 * the loads it saves; these pin that every change still reaches the page.
 */

const BOARD = `/projects/${SLUG}/board`;
const TASK_PAGE = `/projects/${SLUG}/tasks/${TASK}`;

harnessLifecycle();

/** Settles until `done` holds (a load reached its loader), or fails. */
async function until(done: () => boolean): Promise<void> {
  for (let round = 0; round < 20 && !done(); round++) await settle();
  expect(done()).toBe(true);
}

/**
 * A gate a loader awaits once the test closes it: a load in flight. Open until
 * `close`, so the tab's first load goes through.
 */
function gate() {
  let closed: Promise<void> | null = null;
  let release: () => void = () => {};
  return {
    wait: () => closed ?? Promise.resolve(),
    close: () => {
      closed = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    open: () => {
      closed = null;
      release();
    },
  };
}

describe("the echo of one's own action (RF-5)", () => {
  it("is covered by the action's own revalidation, and a later event still revalidates", async () => {
    const harness = await tab({ path: TASK_PAGE, onTaskAction: () => taskUpdated() });
    await act(async () => sendComment());
    await settle();
    await advance(1_000);
    // The action's revalidation, once; root reads neither.
    expect(harness.calls).toEqual({
      root: 0,
      "routes/project": 1,
      "routes/project.board": 0,
      "routes/project.task": 1,
    });

    // The operator reacts after that load was sent: its event is not in it.
    // CANARY: treat every recorded event as covered and this stays at 1.
    taskUpdated();
    await advance(1_000);
    expect(harness.calls["routes/project.task"]).toBe(2);
    expect(harness.calls["routes/project"]).toBe(2);
  });

  it("an echo that arrives after the post-action load was sent revalidates again", async () => {
    let publishOnLoad = false;
    const harness = await tab({
      path: TASK_PAGE,
      onTaskLoader: () => {
        if (!publishOnLoad) return;
        publishOnLoad = false;
        taskUpdated();
      },
    });
    publishOnLoad = true;
    await act(async () => sendComment());
    await settle();
    await advance(1_000);
    // The event reached the tab while the task loader was already answering,
    // so nothing proves that answer holds it.
    expect(harness.calls["routes/project.task"]).toBe(2);
  });

  it("a refused action reloads nothing, and the event its write published still does", async () => {
    const harness = await tab({
      path: TASK_PAGE,
      taskActionStatus: 422,
      onTaskAction: () => taskUpdated(),
    });
    await act(async () => sendComment());
    await settle();
    await advance(1_000);
    expect(harness.actions()).toBe(1);
    // React Router does not revalidate after a 4xx; the live event does, once.
    expect(harness.calls["routes/project.task"]).toBe(1);
    expect(harness.calls.root).toBe(0);
  });

  /**
   * RV-1: a stale CSRF token (the session changed in another tab) is answered
   * with a 403 result (`requireFormAction`'s `refused`), through a real fetcher
   * here: root re-reads the token, the page stays up (the composer keeps its
   * draft), and the next try carries a good token. Root re-runs on nothing
   * else a page does, so without this the tab failed every action until a
   * reload.
   */
  it("a stale-token refusal re-reads root's csrf, and only root, and keeps the page (RV-1)", async () => {
    const harness = await tab({ path: TASK_PAGE, taskActionStatus: 403 });
    await act(async () => sendComment());
    await settle();
    await advance(1_000);
    expect(harness.actions()).toBe(1);
    // CANARY: drop the 403 rule and root keeps the stale token (0).
    expect(harness.calls).toEqual({
      root: 1,
      "routes/project": 0,
      "routes/project.board": 0,
      "routes/project.task": 0,
    });
    // No route error: the task page (and a draft in its composer) is still up.
    expect(harness.router.state.errors).toBeNull();
    expect(harness.router.state.location.pathname).toBe(TASK_PAGE);
  });

  it("the bell's mark-read reloads the shell's counts, not the task page", async () => {
    const harness = await tab({ path: TASK_PAGE });
    await act(async () => markRead());
    await settle();
    await advance(1_000);
    expect(harness.calls).toEqual({
      root: 0,
      "routes/project": 1,
      "routes/project.board": 0,
      "routes/project.task": 0,
    });
  });
});

describe("search params (BOARD-1 / RF-3)", () => {
  it("the task's timeline window re-runs the task loader alone, with the new value", async () => {
    const harness = await tab({ path: TASK_PAGE });
    await act(async () => {
      await harness.router.navigate(`${TASK_PAGE}?events=60`);
    });
    await settle();
    expect(harness.calls).toEqual({
      root: 0,
      "routes/project": 0,
      "routes/project.board": 0,
      "routes/project.task": 1,
    });
    expect(harness.eventsParams()).toEqual(["60"]);
  });

  it("a keystroke while a drop's revalidation is in flight still loads what the drop changed", async () => {
    const board = gate();
    const harness = await tab({ path: BOARD, gate: { "routes/project.board": board.wait } });
    const before = harness.router.state.loaderData["routes/project.board"];
    board.close();
    await act(async () => dropCard());
    // The drop's revalidation is on its way (its board loader is answering);
    // the person keeps typing.
    await until(() => harness.calls["routes/project.board"] === 1);
    expect(harness.router.state.fetchers.size).toBe(1);
    expect([...harness.router.state.fetchers.values()][0]?.state).toBe("loading");
    await act(async () => typeInFilter("x"));
    await settle();
    await act(async () => board.open());
    await settle();
    await advance(1_000);
    // The keystroke's navigation superseded the drop's revalidation, so it
    // loaded the board itself. CANARY: let a search-only navigation skip a
    // route the ledger says is owed, and the board keeps its pre-drop data.
    expect(harness.router.state.loaderData["routes/project.board"]).not.toBe(before);
    expect(harness.router.state.navigation.state).toBe("idle");
  });
});

describe("live events (RF-4, RF-7)", () => {
  it("another task's run state reloads the task page (it shows instance run facts), not the shell", async () => {
    const harness = await tab({ path: TASK_PAGE });
    runStateChanged(OTHER_TASK, "finished");
    await advance(1_000);
    expect(harness.calls).toEqual({
      root: 0,
      "routes/project": 0,
      "routes/project.board": 0,
      "routes/project.task": 1,
    });
  });

  it("a notification reloads the shell's bell counts, not the task page", async () => {
    const harness = await tab({ path: TASK_PAGE });
    notificationRead();
    await advance(1_000);
    expect(harness.calls).toEqual({
      root: 0,
      "routes/project": 1,
      "routes/project.board": 0,
      "routes/project.task": 0,
    });
  });

  it("an event received while a navigation's load is on its way reaches the new page", async () => {
    const task = gate();
    const harness = await tab({ path: BOARD, gate: { "routes/project.task": task.wait } });
    task.close();
    let navigated: Promise<void> = Promise.resolve();
    await act(async () => {
      navigated = harness.router.navigate(TASK_PAGE);
    });
    await settle();
    // Published while the task loader is answering: the board's stream carries it.
    taskUpdated();
    await advance(1_000);
    await act(async () => task.open());
    await act(async () => navigated);
    await settle();
    await connect();
    await advance(1_000);
    expect(harness.router.state.location.pathname).toBe(TASK_PAGE);
    // The navigation's load, then one more for the event it may not hold.
    expect(harness.calls["routes/project.task"]).toBe(2);
  });

  it("a revalidate() from elsewhere (the F22 net, a settle) reloads every page loader, not root", async () => {
    const harness = await tab({ path: TASK_PAGE });
    await act(async () => {
      await harness.router.revalidate();
    });
    await settle();
    expect(harness.calls).toEqual({
      root: 0,
      "routes/project": 1,
      "routes/project.board": 0,
      "routes/project.task": 1,
    });
  });

  it("a link to the page on screen reloads it, as React Router's default does", async () => {
    const harness = await tab({ path: TASK_PAGE });
    await act(async () => {
      await harness.router.navigate(TASK_PAGE);
    });
    await settle();
    expect(harness.calls.root).toBe(1);
    expect(harness.calls["routes/project"]).toBe(1);
    expect(harness.calls["routes/project.task"]).toBe(1);
  });

  it("taking the hash away from the URL on screen reloads nothing (ruling 523)", async () => {
    const harness = await tab({ path: TASK_PAGE });
    // A notification's link lands on an event: React Router loads nothing for
    // a hash it adds.
    await act(async () => {
      await harness.router.navigate(`${TASK_PAGE}#event-2026-09-27T09:00:00.000Z`);
    });
    await settle();
    // The person's next press takes it away, in place (`useHashTarget`).
    await act(async () => {
      await harness.router.navigate(TASK_PAGE, { replace: true, preventScrollReset: true });
    });
    await settle();
    // CANARY: compare the path and search alone and root, the layout and the
    // task page all reload on a click that only clears a mark.
    expect(harness.calls).toEqual({
      root: 0,
      "routes/project": 0,
      "routes/project.board": 0,
      "routes/project.task": 0,
    });
  });
});

describe("reconnects replay what the tab missed (RF-1, ruling 301)", () => {
  it("an event published while opening a task re-scopes the stream is replayed to the page", async () => {
    const harness = await tab({ path: BOARD });
    await act(async () => {
      await harness.router.navigate(TASK_PAGE);
    });
    await settle();
    // The board's stream is closed and the task's is not open yet.
    const reopened = BrokerEventSource.instances.at(-1);
    expect(reopened?.url).toMatch(/&lastEventId=\d+$/);
    taskUpdated(OTHER_TASK);
    await connect();
    await advance(1_000);
    // CANARY: open the task's stream without its position and the event is lost.
    expect(harness.calls["routes/project.task"]).toBe(2);
  });

  /**
   * RV-2: the new project's events are not on the old stream, so the tab's
   * position says nothing about them. It moved past one published after the
   * new board's loader read (a console line of the task being left), and the
   * reopen named that position.
   */
  it("a slug change replays what the new project published after its load was sent (RV-2)", async () => {
    const board = gate();
    const harness = await tab({ path: TASK_PAGE, gate: { "routes/project.board": board.wait } });
    board.close();
    let navigated: Promise<void> = Promise.resolve();
    await act(async () => {
      navigated = harness.router.navigate(`/projects/${OTHER_SLUG}/board`);
    });
    await until(() => harness.calls["routes/project.board"] === 1);
    // The new board's loader has read. A member moves a card there, then the
    // task being left prints a line, which its still-open stream delivers.
    taskUpdated("BIL-1", OTHER_SLUG);
    runLogAppended(TASK, 1);
    await act(async () => board.open());
    await act(async () => navigated);
    await settle();
    await connect();
    await advance(1_000);
    expect(harness.router.state.location.pathname).toBe(`/projects/${OTHER_SLUG}/board`);
    // CANARY: open the re-scoped stream from the newest id the old one saw
    // and the move is never replayed: the board keeps its first answer.
    expect(harness.calls["routes/project.board"]).toBe(2);
    expect(harness.calls["routes/project"]).toBe(2);
  });

  it("a surface's first stream replays what its load could not have seen (RV-2)", async () => {
    const board = gate();
    const harness = await tab({ path: "/inbox", gate: { "routes/project.board": board.wait } });
    board.close();
    let navigated: Promise<void> = Promise.resolve();
    await act(async () => {
      navigated = harness.router.navigate(BOARD);
    });
    await until(() => harness.calls["routes/project.board"] === 1);
    // After the board's loader read, a change on the board; then the inbox's
    // stream (the user scope alone) moves the tab's position past it.
    taskUpdated(OTHER_TASK);
    notificationRead();
    await act(async () => board.open());
    await act(async () => navigated);
    await settle();
    await connect();
    await advance(1_000);
    // CANARY: start the layout's first stream at the tab's newest position
    // and the change is lost.
    expect(harness.calls["routes/project.board"]).toBe(2);
  });

  it("opening a task whose run printed 300 lines while the board watched reloads only the task (RV-3)", async () => {
    const harness = await tab({ path: BOARD });
    // The lines go to the task's scope only, so the board's stream never
    // moves past them.
    for (let seq = 1; seq <= 300; seq += 1) runLogAppended(TASK, seq);
    await act(async () => {
      await harness.router.navigate(TASK_PAGE);
    });
    await settle();
    await connect();
    await advance(1_000);
    // CANARY: share one ring between console lines and data events and the
    // reopen falls off it: stream.resync reloads the layout and the task again.
    expect(harness.calls).toEqual({
      root: 0,
      "routes/project": 0,
      "routes/project.board": 0,
      "routes/project.task": 1,
    });
  });

  it("an event still inside the 300 ms window when the stream re-scopes still reaches the page", async () => {
    const task = gate();
    const harness = await tab({ path: BOARD, gate: { "routes/project.task": task.wait } });
    task.close();
    let navigated: Promise<void> = Promise.resolve();
    await act(async () => {
      navigated = harness.router.navigate(TASK_PAGE);
    });
    await settle();
    // Delivered by the board's stream while the task loader answers; the
    // navigation lands, and the stream re-scopes, before the 300 ms flush.
    taskUpdated(OTHER_TASK);
    await act(async () => task.open());
    await act(async () => navigated);
    await settle();
    await connect();
    await advance(1_000);
    // The replay starts after that event, so only the flush the reopened
    // stream schedules brings it. CANARY: drop that flush and the task page
    // keeps the answer that predates the event.
    expect(harness.calls["routes/project.task"]).toBe(2);
  });

  it("a tab back from hidden gets what it missed while away", async () => {
    const visibility = { current: "visible" };
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility.current,
    });
    const harness = await tab({ path: TASK_PAGE });
    await act(async () => {
      visibility.current = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(BrokerEventSource.open()).toHaveLength(0);
    taskUpdated();
    await act(async () => {
      visibility.current = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await connect();
    await advance(1_000);
    expect(harness.calls["routes/project.task"]).toBe(1);
  });

  it("the page's first stream replays what was published after the server render", async () => {
    // The server render read the broker's head; an event lands before the
    // browser opens its stream.
    const head = getSseBrokerStats().headId;
    const harness = mountHarness({ path: TASK_PAGE, liveHead: head });
    await settle();
    harness.resetCounts();
    taskUpdated();
    await connect();
    await advance(1_000);
    expect(BrokerEventSource.instances[0]?.url).toContain(`&lastEventId=${head}`);
    expect(harness.calls["routes/project.task"]).toBe(1);
  });
});

describe("an action still running (RV-4)", () => {
  /**
   * A load that started while the send was still running cannot hold its
   * write, but it used to count as covering it (the send was recorded at
   * submit), and the ledger dropped it. A later navigation that reads nothing
   * then owed nothing, and still aborted the send's own revalidation.
   */
  it("a navigation during a slow send, then one that aborts its revalidation, still shows the write", async () => {
    const action = gate();
    const task = gate();
    const harness = await tab({
      path: TASK_PAGE,
      taskActionGate: () => action.wait(),
      gate: { "routes/project.task": task.wait },
    });
    action.close();
    await act(async () => sendComment());
    await settle();
    // While the send runs, a click the task loader does not read.
    await act(async () => {
      await harness.router.navigate(`${TASK_PAGE}?panel=1`);
    });
    await settle();
    // The send saves and answers; its revalidation is on its way.
    task.close();
    const before = harness.calls["routes/project.task"];
    await act(async () => action.open());
    await until(() => harness.calls["routes/project.task"] > before);
    expect(savedComments()).toBe(1);
    // Another such click supersedes that revalidation.
    let navigated: Promise<void> = Promise.resolve();
    await act(async () => {
      navigated = harness.router.navigate(`${TASK_PAGE}?panel=2`);
    });
    await settle();
    await act(async () => task.open());
    await act(async () => navigated);
    await settle();
    await advance(1_000);
    // CANARY: let a load that started before the send answered cover it, and
    // the page keeps the answer from before the write (0).
    expect(harness.savedOnPage()).toBe(1);
  });

  /**
   * React Router asks every route twice whether to re-run after an answer, and
   * a refused send withdrew the NEWEST send on its path each time: the send
   * still running beside it went with it.
   */
  it("a refused send withdraws itself, not a second send still running", async () => {
    const action = gate();
    const task = gate();
    const harness = await tab({
      path: TASK_PAGE,
      taskActionGate: (text) => (text === "slow" ? action.wait() : Promise.resolve()),
      taskActionStatusFor: (text) => (text === "refused" ? 422 : 200),
      gate: { "routes/project.task": task.wait },
    });
    action.close();
    await act(async () => sendComment("slow", 0));
    await act(async () => sendComment("refused", 1));
    await settle();
    expect(harness.actions()).toBe(2);
    expect(savedComments()).toBe(0);
    task.close();
    const before = harness.calls["routes/project.task"];
    await act(async () => action.open());
    await until(() => harness.calls["routes/project.task"] > before);
    let navigated: Promise<void> = Promise.resolve();
    await act(async () => {
      navigated = harness.router.navigate(`${TASK_PAGE}?panel=2`);
    });
    await settle();
    await act(async () => task.open());
    await act(async () => navigated);
    await settle();
    await advance(1_000);
    // CANARY: withdraw the newest send on the path per call and this is 0.
    expect(harness.savedOnPage()).toBe(1);
  });
});

describe("a slow action of the person's own (RV-6)", () => {
  it("does not hold another member's change until it answers", async () => {
    const action = gate();
    const harness = await tab({ path: TASK_PAGE, taskActionGate: () => action.wait() });
    action.close();
    // A send that takes seconds (an upload, a GitHub sync).
    await act(async () => sendComment());
    await settle();
    // Meanwhile another member moves this task.
    taskUpdated();
    await advance(1_000);
    expect(harness.submitting()).toBe(1);
    // CANARY: let the flush wait for a submission and nothing loads until the
    // send answers (0 and 0).
    expect(harness.calls["routes/project.task"]).toBe(1);
    expect(harness.calls["routes/project"]).toBe(1);
    // The send answers, and its own revalidation still brings its write
    // (that load started before the write committed: RV-4).
    await act(async () => action.open());
    await settle();
    await advance(1_000);
    expect(harness.submitting()).toBe(0);
    expect(harness.savedOnPage()).toBe(1);
    expect(harness.calls["routes/project.task"]).toBe(2);
  });

  it("still skips the echo of an action that answers inside the flush's 300 ms", async () => {
    const task = gate();
    const harness = await tab({
      path: TASK_PAGE,
      gate: { "routes/project.task": task.wait },
      // The write publishes as it commits, and the answer follows 200 ms later.
      taskActionGate: () => {
        taskUpdated();
        return new Promise((resolve) => setTimeout(resolve, 200));
      },
    });
    task.close();
    await act(async () => sendComment());
    await settle();
    // The send has answered; its revalidation is still in flight at the flush.
    await advance(1_000);
    expect(harness.submitting()).toBe(0);
    await act(async () => task.open());
    await settle();
    await advance(1_000);
    // CANARY: let the flush stop waiting for loads in flight too, and the echo
    // reloads the layout and the task a second time.
    expect(harness.calls).toEqual({
      root: 0,
      "routes/project": 1,
      "routes/project.board": 0,
      "routes/project.task": 1,
    });
  });
});

describe("the F22 net (RF-6)", () => {
  it("still revalidates a page showing an active run while its stream is down", async () => {
    const harness = await tab({ path: TASK_PAGE, activeRun: true });
    await act(async () => BrokerEventSource.open()[0]?.fail());
    await advance(20_000);
    expect(harness.calls["routes/project.task"]).toBeGreaterThan(0);
    expect(harness.calls.root).toBe(0);
  });
});

describe("the rules", () => {
  function args(over: Partial<ShouldRevalidateFunctionArgs>): ShouldRevalidateFunctionArgs {
    const url = new URL(`http://viberr.test${TASK_PAGE}`);
    return {
      currentUrl: url,
      nextUrl: url,
      currentParams: { slug: SLUG, key: TASK },
      nextParams: { slug: SLUG, key: TASK },
      defaultShouldRevalidate: true,
      ...over,
    };
  }

  it("root re-runs after a theme change and a sign-in, not after a page's action", async () => {
    await tab({ path: TASK_PAGE });
    const root = revalidateWhen("root");
    const task = revalidateWhen("routes/project.task");
    const posted = (formAction: string) => args({ formMethod: "POST", formAction, actionStatus: 200 });
    expect(root(posted("/prefs/theme"))).toBe(true);
    expect(root(posted("/login"))).toBe(true);
    expect(root(posted("/logout"))).toBe(true);
    expect(root(posted(`/projects/${SLUG}/tasks/${TASK}`))).toBe(false);
    expect(task(posted(`/projects/${SLUG}/tasks/${TASK}`))).toBe(true);
    expect(task(posted("/prefs/theme"))).toBe(false);
  });

  it("every page route module with a loader exports its own rule, and every rule names a module", () => {
    const dir = path.join(process.cwd(), "app/routes");
    const modules = readdirSync(dir).filter(
      (f) => f.endsWith(".tsx") && !f.includes(".test.") && !f.endsWith(".server.tsx"),
    );
    const pages = modules.filter((f) => {
      const text = readFileSync(path.join(dir, f), "utf8");
      return /^export (async )?function loader/m.test(text) && /^export default/m.test(text);
    });
    for (const file of pages) {
      const id = `routes/${file.replace(/\.tsx$/, "")}`;
      const text = readFileSync(path.join(dir, file), "utf8");
      expect(text, `${file} exports its rule`).toContain(
        `export const shouldRevalidate = revalidateWhen("${id}");`,
      );
    }
    const ids = Object.keys(REVALIDATION_RULES).filter((id) => id !== "root");
    expect(ids.toSorted()).toEqual(pages.map((f) => `routes/${f.replace(/\.tsx$/, "")}`).toSorted());
    expect(readFileSync(path.join(process.cwd(), "app/root.tsx"), "utf8")).toContain(
      `export const shouldRevalidate = revalidateWhen("root");`,
    );
  });
});
