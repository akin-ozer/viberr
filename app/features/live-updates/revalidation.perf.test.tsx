// @vitest-environment jsdom
import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectWithinBudget } from "../../../test-support/perf-ratchet";
import {
  advance,
  BrokerEventSource,
  connect,
  dropCard,
  harnessLifecycle,
  markRead,
  OTHER_TASK,
  runStateChanged,
  sendComment,
  settle,
  SLUG,
  TASK,
  taskUpdated,
  tab,
  typeInFilter,
} from "../../../test-support/revalidation-harness";

/**
 * Ruling 457, journeys `board-live`, `compose-send`, `task-open` and
 * `live-run`: how many loaders one trigger re-runs in a tab, counted on the
 * harness in `test-support/revalidation-harness.tsx` (React Router with single
 * fetch's revalidation choice, the real broker in-process, the workspace's
 * route shape: root > routes/project > board | task, every loader counting).
 */

const BOARD = `/projects/${SLUG}/board`;
const TASK_PAGE = `/projects/${SLUG}/tasks/${TASK}`;

harnessLifecycle();

describe("loaders re-run per trigger (ruling 457)", () => {
  it("BOARD-1 / RF-3: five keystrokes in the board filter", async () => {
    const harness = await tab({ path: BOARD });
    for (const value of ["l", "lo", "log", "logi", "login"]) {
      await act(async () => typeInFilter(value));
      await settle();
    }
    await advance(1_000);
    expect(harness.router.state.location.search).toBe("?q=login");
    expectWithinBudget("revalidation:board.loader-runs-per-5-keystrokes", harness.total());
  });

  it("RF-5 / CS-2: a comment and the task.updated its write publishes", async () => {
    const harness = await tab({ path: TASK_PAGE, onTaskAction: () => taskUpdated() });
    await act(async () => sendComment());
    await settle();
    await advance(1_000);
    expect(harness.actions()).toBe(1);
    expectWithinBudget("revalidation:task.loader-runs-per-own-comment", harness.total());
  });

  it("RF-5 / BOARD-7: a drop on the board and the task.updated its write publishes", async () => {
    const harness = await tab({ path: BOARD, onBoardAction: () => taskUpdated(OTHER_TASK) });
    await act(async () => dropCard());
    await settle();
    await advance(1_000);
    expect(harness.actions()).toBe(1);
    expectWithinBudget("revalidation:board.loader-runs-per-own-drop", harness.total());
  });

  it("RF-5: the bell's mark-read on a task page and its notification.read", async () => {
    const harness = await tab({ path: TASK_PAGE });
    await act(async () => markRead());
    await settle();
    await advance(1_000);
    expect(harness.actions()).toBe(1);
    expectWithinBudget("revalidation:task.loader-runs-per-bell-mark-read", harness.total());
  });

  it("RF-1: opening a task from the board, streams re-scoped and connected", async () => {
    const harness = await tab({ path: BOARD });
    await act(async () => {
      await harness.router.navigate(TASK_PAGE);
    });
    await settle();
    await connect();
    await advance(1_000);
    expect(harness.router.state.location.pathname).toBe(TASK_PAGE);
    expectWithinBudget("revalidation:task-open.loader-runs", harness.total());
  });

  it("RF-4 / LIVE-8: the open task's own run.state-changed", async () => {
    const harness = await tab({ path: TASK_PAGE });
    runStateChanged(TASK);
    await advance(1_000);
    expectWithinBudget("revalidation:task.loader-runs-per-own-run-state", harness.total());
  });

  it("RF-4: another task's run.state-changed while a task page is open", async () => {
    const harness = await tab({ path: TASK_PAGE });
    runStateChanged(OTHER_TASK);
    await advance(1_000);
    expectWithinBudget("revalidation:task.loader-runs-per-other-run-state", harness.total());
  });

  it("RF-7: root loader runs for ten live events on a task page", async () => {
    const harness = await tab({ path: TASK_PAGE });
    for (let i = 0; i < 10; i++) {
      taskUpdated(OTHER_TASK);
      await advance(1_000);
    }
    expect(harness.calls["routes/project.task"]).toBeGreaterThan(0);
    expectWithinBudget("revalidation:root.loader-runs-per-10-live-events", harness.calls.root);
  });

  it("RF-6: a minute on a task page with an active run and a healthy stream", async () => {
    const harness = await tab({ path: TASK_PAGE, activeRun: true });
    await advance(60_000);
    expectWithinBudget("revalidation:task.loader-runs-per-60s-healthy-stream", harness.total());
  });

  it("RF-1 / ruling 301: a hidden tab comes back and nothing was published meanwhile", async () => {
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
    await act(async () => {
      visibility.current = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await connect();
    await advance(1_000);
    expect(BrokerEventSource.open()).toHaveLength(1);
    expectWithinBudget("revalidation:task.loader-runs-per-quiet-return", harness.total());
  });
});
