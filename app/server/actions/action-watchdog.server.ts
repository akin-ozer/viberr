import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { logger } from "~/server/logging/logger.server";

/** Wall-clock ceiling for a single mutating server action. */
export const ACTION_WATCHDOG_MS = 30_000;

/**
 * F20-1: wrap a mutating server action in a wall-clock guard. A data-root write
 * against a stale/unreachable mount can hang an action long past any reasonable
 * time; this races the work against a timer and fails THAT action with a typed
 * `AppError` (503) so the request returns instead of the user staring at a
 * wedged page.
 *
 * LIMITATION (deliberate, documented — see the probe experiment in the pass-20
 * discovery notes): the timer only fires for an ASYNC hang — a promise that
 * never settles, an awaited call that yields the event loop. It CANNOT interrupt
 * a synchronous CPU spin on the main thread: while such a loop holds the thread
 * the timer callback never runs (the live F20-1 spin was exactly this). Those
 * are closed at the source instead — the bounded collision loop in
 * `store-files.server.ts` and the ESTALE/EIO throw arm in `atomic-file.server.ts`.
 * This watchdog is the cheap, general insurance the finding asked for on top of
 * those, catching the async-hang shape a bounded loop cannot.
 *
 * Implemented once here and applied at the mutating action entry point — do not
 * re-implement the race per route.
 */
export async function withActionWatchdog<T>(
  label: string,
  fn: () => Promise<T>,
  timeoutMs: number = ACTION_WATCHDOG_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      logger.error("action watchdog fired", { label, timeoutMs });
      reject(
        new AppError({
          code: ERROR_CODES.INTERNAL,
          status: 503,
          message: `action "${label}" exceeded ${timeoutMs}ms`,
          userMessage: `This action did not complete in ${Math.round(
            timeoutMs / 1000,
          )}s — the data root may be unreachable. Nothing reliable was changed; try again once storage is healthy.`,
        }),
      );
    }, timeoutMs);
    // Never let the guard timer keep the process alive on its own.
    timer.unref?.();
  });
  try {
    return await Promise.race([fn(), guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
