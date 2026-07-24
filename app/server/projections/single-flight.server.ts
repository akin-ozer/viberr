/**
 * Min-interval guard for expensive whole-store operations (P13-D-33).
 *
 * `architecture.md` asks for targeted limits on "expensive sync/projection
 * rebuild operations"; only the auth flows had any. A global re-scan or a
 * projection rebuild walks every project directory, re-parses every file and
 * rewrites every projection row — and both were reachable by clicking a button
 * as fast as the browser allows, with no limiter, lock or min-interval.
 *
 * This is deliberately NOT a mutex. The guarded operations are SYNCHRONOUS, so
 * on a single-threaded server two of them can never actually overlap; what
 * costs real CPU is the same full sweep running back-to-back N times. So the
 * rule is a per-key cooldown: run it, then refuse the next identical request
 * until the interval has passed, and tell the caller how long to wait.
 *
 * Scope: in-process, matching the app's single-node deployment (same as the
 * auth token buckets). A restart clears the cooldowns, which is harmless — the
 * first sweep after a restart is one the operator wants to run anyway.
 *
 * NOT for correctness-critical rebuilds. A rebuild that must happen (e.g. the
 * one after `deleteProject` removes a project directory — skipping it would
 * leave the deleted project's rows in the projections) must never be wrapped:
 * this helper's whole contract is that a skipped run is acceptable.
 */

export type SingleFlightOutcome<T> =
  | { status: "ran"; result: T }
  | { status: "throttled"; retryAfterMs: number };

export interface SingleFlightOptions {
  /** Minimum gap between two runs of the same key. */
  minIntervalMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Cooldowns for the operations this guard fronts. Sized by how expensive the
 *  sweep is, not by how impatient the button is. */
export const RESCAN_MIN_INTERVAL_MS = 10_000;
export const REBUILD_MIN_INTERVAL_MS = 30_000;

const lastRunAt = new Map<string, number>();

/**
 * Runs `work` unless the same `key` ran less than `minIntervalMs` ago.
 *
 * The timestamp is stamped BEFORE the work runs, so a throw still holds the
 * cooldown — a sweep that fails is exactly the one that should not be
 * hammered.
 */
export function runSingleFlight<T>(
  key: string,
  work: () => T,
  options: SingleFlightOptions,
): SingleFlightOutcome<T> {
  const now = (options.now ?? Date.now)();
  const previous = lastRunAt.get(key);
  if (previous !== undefined && now - previous < options.minIntervalMs) {
    return {
      status: "throttled",
      retryAfterMs: options.minIntervalMs - (now - previous),
    };
  }
  lastRunAt.set(key, now);
  return { status: "ran", result: work() };
}

/** Human copy for a throttled outcome, e.g. "…try again in 7s." */
export function throttledMessage(what: string, retryAfterMs: number): string {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return `${what} already ran a moment ago — try again in ${seconds}s.`;
}

/** Clears cooldowns (tests, and any future "force" affordance). */
export function resetSingleFlight(key?: string): void {
  if (key === undefined) lastRunAt.clear();
  else lastRunAt.delete(key);
}
