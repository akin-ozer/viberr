import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, isAppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import {
  ACTION_WATCHDOG_MS,
  withActionWatchdog,
} from "./action-watchdog.server";

/**
 * F20-1 wall-clock guard. These drive the clock with fake timers so the race
 * between the wrapped action and the watchdog timer is deterministic: nothing
 * here waits on real wall time.
 */
describe("withActionWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves a fast successful action and leaves no watchdog timer pending", async () => {
    expect(vi.getTimerCount()).toBe(0);

    const result = await withActionWatchdog(
      "fast",
      () => Promise.resolve(42),
      1_000,
    );

    expect(result).toBe(42);
    // The guard timer was armed, then cleared in `finally`: no leak, no 503.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with a typed AppError (status 503) when the action exceeds the budget", async () => {
    const budget = 1_000;
    // An action that never settles on its own: only the watchdog can end it.
    const hang = () => new Promise<never>(() => {});

    const raced = withActionWatchdog("hang", hang, budget);
    // Swallow the rejection here so advancing the clock cannot surface it as an
    // unhandled rejection; read the settled reason back afterwards.
    const settled = raced.then(
      () => undefined,
      (reason: unknown) => reason,
    );

    await vi.advanceTimersByTimeAsync(budget);
    const reason = await settled;

    expect(isAppError(reason)).toBe(true);
    // isAppError narrows `reason` to AppError, so no cast is needed below.
    if (isAppError(reason)) {
      expect(reason).toBeInstanceOf(AppError);
      expect(reason.status).toBe(503);
      expect(reason.code).toBe(ERROR_CODES.INTERNAL);
      expect(reason.message).toContain("hang");
      expect(reason.message).toContain(String(budget));
    }
    // The guard fired; its own timer is spent, so nothing is left pending.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves a slow action that finishes just under the budget without firing the timer", async () => {
    const budget = 1_000;
    // Settles at budget minus 1ms: the work wins the race, the guard never fires.
    const slow = () =>
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("done"), budget - 1);
      });

    const raced = withActionWatchdog("slow", slow, budget);
    await vi.advanceTimersByTimeAsync(budget - 1);

    await expect(raced).resolves.toBe("done");
    // The action's own timer fired and resolved it; the guard timer was cleared
    // in `finally` before it could reach `budget`.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defaults the budget to ACTION_WATCHDOG_MS when no timeout is passed", async () => {
    const raced = withActionWatchdog("default-budget", () =>
      new Promise<never>(() => {}),
    );
    const settled = raced.then(
      () => undefined,
      (reason: unknown) => reason,
    );

    // One tick short of the default budget: still pending.
    await vi.advanceTimersByTimeAsync(ACTION_WATCHDOG_MS - 1);
    let reason = await Promise.race([
      settled,
      Promise.resolve<symbol>(Symbol.for("pending")),
    ]);
    expect(reason).toBe(Symbol.for("pending"));

    // Cross the default budget: the watchdog fires with the same 503 shape.
    await vi.advanceTimersByTimeAsync(1);
    reason = await settled;
    expect(isAppError(reason)).toBe(true);
    if (isAppError(reason)) {
      expect(reason.status).toBe(503);
    }
  });
});
