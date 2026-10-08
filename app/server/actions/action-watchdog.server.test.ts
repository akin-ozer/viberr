import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, isAppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { withActionWatchdog } from "./action-watchdog.server";

/**
 * F20-1 wall-clock guard. These drive the clock with fake timers so the race
 * between the wrapped action and the watchdog timer is deterministic: nothing
 * here waits on real wall time. The budget is the 30 s the architecture pages
 * state for a mutating action.
 */
const BUDGET_MS = 30_000;

describe("withActionWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves a fast successful action and leaves no watchdog timer pending", async () => {
    expect(vi.getTimerCount()).toBe(0);

    const result = await withActionWatchdog("fast", () => Promise.resolve(42));

    expect(result).toBe(42);
    // The guard timer was armed, then cleared in `finally`: no leak, no 503.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with a typed AppError (status 503) once the action passes the budget, not a tick before", async () => {
    // An action that never settles on its own: only the watchdog can end it.
    const raced = withActionWatchdog("hang", () => new Promise<never>(() => {}));
    // Swallow the rejection here so advancing the clock cannot surface it as an
    // unhandled rejection; read the settled reason back afterwards.
    const settled = raced.then(
      () => undefined,
      (cause: unknown) => cause,
    );

    // One tick short of the budget: still pending.
    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    const pending = Symbol("pending");
    expect(await Promise.race([settled, Promise.resolve(pending)])).toBe(pending);

    // Cross the budget: the guard fires, and its own timer is spent, so nothing
    // is left pending.
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
    const reason = await settled;

    expect(isAppError(reason)).toBe(true);
    // isAppError narrows `reason` to AppError, so no cast is needed below.
    if (isAppError(reason)) {
      expect(reason).toBeInstanceOf(AppError);
      expect(reason.status).toBe(503);
      expect(reason.code).toBe(ERROR_CODES.INTERNAL);
      expect(reason.message).toContain("hang");
      expect(reason.message).toContain(String(BUDGET_MS));
    }
  });

  it("resolves a slow action that finishes just under the budget without firing the timer", async () => {
    // Settles 1 ms inside the budget: the work wins the race, the guard never fires.
    const slow = () =>
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("done"), BUDGET_MS - 1);
      });

    const raced = withActionWatchdog("slow", slow);
    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);

    await expect(raced).resolves.toBe("done");
    // The action's own timer fired and resolved it; the guard timer was cleared
    // in `finally` before it could reach the budget.
    expect(vi.getTimerCount()).toBe(0);
  });
});
