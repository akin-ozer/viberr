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

export function createPathDebouncer(
  delayMs: number,
  onFlush: (key: string) => void,
): PathDebouncer {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    schedule(key: string): void {
      const existing = timers.get(key);
      if (existing) clearTimeout(existing);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          onFlush(key);
        }, delayMs),
      );
    },
    cancelAll(): void {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
    pendingCount(): number {
      return timers.size;
    },
  };
}
