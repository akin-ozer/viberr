import type { OlderLogState, RunLogStore, ThreadView } from "~/features/runtime/run-log-store";
import { isRunBoundary, type LogLine } from "~/features/runtime/runtime-types";

/**
 * A run-log store over lines already in hand, for a console a test feeds by
 * props: it shows what it was given and asks for nothing; `onLoadOlder` stands
 * in for the backward walk. A line without a key is keyed by its position.
 */
export function staticRunLogStore(input: {
  linesByThread: Record<string, readonly { display: LogLine; raw: string | null; key?: string }[]>;
  olderByThread?: Record<string, OlderLogState>;
  streamError?: string | null;
  onLoadOlder?: (threadId: string) => void;
}): RunLogStore {
  const listeners = new Set<() => void>();
  let rawView = false;
  const views = new Map<string, ThreadView>();
  for (const [threadId, lines] of Object.entries(input.linesByThread)) {
    const keyed = lines.map((line, i) => ({ key: line.key ?? `#${i}`, display: line.display, raw: line.raw }));
    views.set(threadId, {
      lines: keyed,
      epoch: 0,
      // Stored lines only: the synthetic run boundaries are not console history.
      total: keyed.filter((line) => !isRunBoundary(line.display)).length,
      older: input.olderByThread?.[threadId] ?? { hasMore: false, withheld: 0, loading: false, error: null },
      status: "ready",
      loadError: null,
    });
  }
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    thread: (threadId) => views.get(threadId) ?? null,
    facts: () => null,
    streamError: () => input.streamError ?? null,
    rawView: () => rawView,
    show() {},
    loadOlder(threadId) {
      input.onLoadOlder?.(threadId);
    },
    setRawView(on) {
      if (rawView === on) return;
      rawView = on;
      for (const listener of listeners) listener();
    },
  };
}
