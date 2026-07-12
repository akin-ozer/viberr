/**
 * Per-key trailing debounce — the watcher's coalescing primitive, split out
 * so it can be unit-tested around fake timers. Each key (file path) gets an
 * independent timer; a burst of calls within `delayMs` yields ONE trailing
 * invocation per key.
 */

export interface PathDebouncer {
  schedule(key: string): void;
  /** Cancel everything (watcher shutdown / HMR teardown). */
  cancelAll(): void;
  /** Number of keys currently pending (tests). */
  pendingCount(): number;
}

/** Injectable clock used by the watcher and deterministic tests. */
export interface TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

const systemTimers: TimerScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function createPathDebouncer(
  delayMs: number,
  onFlush: (key: string) => void,
  timers: TimerScheduler = systemTimers,
): PathDebouncer {
  const pending = new Map<string, unknown>();

  return {
    schedule(key: string): void {
      const existing = pending.get(key);
      if (existing !== undefined) timers.clearTimeout(existing);
      pending.set(
        key,
        timers.setTimeout(() => {
          pending.delete(key);
          onFlush(key);
        }, delayMs),
      );
    },
    cancelAll(): void {
      for (const timer of pending.values()) timers.clearTimeout(timer);
      pending.clear();
    },
    pendingCount(): number {
      return pending.size;
    },
  };
}
