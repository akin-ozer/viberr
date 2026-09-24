import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRevalidator } from "react-router";
import { z } from "zod";
import { onLiveFrame } from "~/features/live-updates/use-live-updates";
import {
  createLiveRunLogStore,
  type ConsoleThreadInput,
  type LiveRunLogStore,
  type RunLogSource,
  type RunLogStore,
  type ThreadView,
} from "./run-log-store";
import type { RunLiveFacts } from "./runtime-types";

export type { OlderLogState, RunLogSource, RunLogStore, StreamedLine, ThreadView } from "./run-log-store";

/**
 * The run-log console's live half (phase-6 report §"High-frequency streams",
 * requirement (c)): it follows the runs a page shows, line by line, without
 * revalidating the page's loaders (which would refetch the whole task per
 * log line).
 *
 * Ruling 454 reshaped it (owner decision 2, 2026-09-24):
 *
 *   - the lines live in a store outside React state (`run-log-store.ts`); the
 *     page holds the store, the console reads the thread it shows, so a line
 *     re-renders the console and not the page (LIVE-2);
 *   - it opens no connection of its own: the frames come from the tab's one
 *     live stream (`onLiveFrame`, the layout's `useLiveUpdates`), which also
 *     carries ruling 301's hidden-tab close and the reconnect catch-up
 *     (TASK-6 / LIVE-5);
 *   - a thread the page did not carry lines for loads with one request when
 *     the console shows it (TASK-1), and a revalidation keeps whatever a
 *     thread already holds unless its representative run changed (TASK-3 /
 *     LIVE-3);
 *   - each tail read brings the run's live facts, which the Live run strip
 *     reads, so the page no longer revalidates on run lines (LIVE-1).
 *
 * Two SOURCES (ruling 99): a task's runs (`run.log-appended`, on the task
 * scope) and a controller conversation's, which have no task scope — their
 * frames reach the conversation owner's `user` stream as
 * `controller.log-appended` (`run-events.server.ts`).
 *
 * P13-D-11: the page carries a BOUNDED window (NFR5), so the console also
 * pages backwards through the history it did not ship (`loadOlder`).
 */

/** The two runtime frames this consumer subscribes, as the broker puts them on
 *  the wire (`app/schemas/sse-event.schema.ts`). Parsed rather than trusted: a
 *  frame that does not match is dropped, the way a malformed one always was. */
const runLogAppendedSchema = z.object({
  data: z.object({
    projectSlug: z.string(),
    taskKey: z.string(),
    runId: z.string(),
    threadId: z.string(),
    seq: z.number(),
  }),
});

/** The controller channel's frame: the same reference, keyed by conversation. */
const controllerLogAppendedSchema = z.object({
  data: z.object({
    conversationId: z.string(),
    runId: z.string(),
    threadId: z.string(),
    seq: z.number(),
  }),
});

/** The run a frame names, when it belongs to `source`; null otherwise. */
function frameFor(source: RunLogSource, raw: string): { runId: string; seq: number } | null {
  try {
    const json: unknown = JSON.parse(raw);
    if (source.kind === "task") {
      const parsed = runLogAppendedSchema.safeParse(json);
      if (!parsed.success) return null;
      const d = parsed.data.data;
      return d.projectSlug === source.projectSlug && d.taskKey === source.taskKey ? d : null;
    }
    const parsed = controllerLogAppendedSchema.safeParse(json);
    if (!parsed.success) return null;
    const d = parsed.data.data;
    // The `user` stream carries every conversation of this person; only the
    // open one is followed.
    return d.conversationId === source.conversationId ? d : null;
  } catch {
    return null;
  }
}

/** The client-only layout effect, silent on the server (no store changes there). */
const useClientLayoutEffect = "document" in globalThis ? useLayoutEffect : useEffect;

/** The run lifecycles a status poll treats as still going. */
const LIVE_STATES = new Set(["queued", "running"]);

export function useRunLogStream(input: {
  source: RunLogSource;
  /** The page's run projection: one thread per agent group (a `RunView` is one). */
  threads: readonly ConsoleThreadInput[];
  /** True while the loader shows at least one running run. Drives a bounded
   *  safety revalidation so a `run.state-changed` finalize event MISSED during
   *  an SSE drop (rapid reaction chains) self-heals instead of leaving a
   *  phantom "1 agent running" strip until a manual reload (F22). */
  hasActiveRun?: boolean;
  /**
   * Ruling 454 (CTL-2): instead of the F22 revalidation, read this run's tail
   * every `everyMs` while `runId` is set, and revalidate once when the tail
   * says the run is no longer live. The controller page's fallback for a
   * missed settle, which used to revalidate root, layout and page every 5 s of
   * a turn. A null `runId` polls nothing, and the F22 net applies.
   */
  poll?: { runId: string | null; everyMs: number };
  /** UI-30: false for a NON-MEMBER, whose `/resources/run-log` requests 403.
   *  Asking for what can only be refused is worse than not asking. */
  enabled?: boolean;
}): RunLogStore {
  const { source } = input;
  // One key per stream: a different task (or conversation) is a new store.
  const streamKey =
    source.kind === "task"
      ? `task:${source.projectSlug}/${source.taskKey}`
      : `controller:${source.conversationId}`;
  const enabled = input.enabled !== false;

  // TASK-3: the store is seeded ONCE per stream, from the payload it is
  // created with, so the server render draws the same lines the first client
  // render does and mounting sets nothing. A different task or conversation is
  // a different store.
  const [held, setHeld] = useState(() => ({
    key: streamKey,
    store: createLiveRunLogStore(source, input.threads, enabled),
  }));
  let store: LiveRunLogStore = held.store;
  if (held.key !== streamKey) {
    const next = { key: streamKey, store: createLiveRunLogStore(source, input.threads, enabled) };
    setHeld(next);
    store = next.store;
  }
  useEffect(() => () => store.dispose(), [store]);
  useEffect(() => store.setEnabled(enabled), [store, enabled]);

  // A revalidation brought the projection again: the store keeps what each
  // thread holds and takes only what changed (a new representative run, a
  // head the tail has not reached, the run row's newer facts). A projection
  // that changed nothing changes nothing in the store, and the console does
  // not render (TASK-3 / LIVE-3). On mount this is the projection the store
  // was seeded from, so it is a no-op too.
  const threads = input.threads;
  useClientLayoutEffect(() => {
    store.reconcile(threads);
  }, [store, threads]);

  // The tab's one live stream hands the console its frames. `source` is the
  // value `streamKey` spells, so the key is the dependency.
  useEffect(() => {
    if (!enabled) return;
    const name = source.kind === "task" ? "run.log-appended" : "controller.log-appended";
    return onLiveFrame(name, (event) => {
      const frame = frameFor(source, event.data);
      if (frame) store.onFrame(frame.runId, frame.seq);
    });
  }, [store, streamKey, enabled]);

  const revalidator = useRevalidator();
  const revalidateRef = useRef(revalidator.revalidate);
  useEffect(() => {
    revalidateRef.current = revalidator.revalidate;
  });

  // F22: while a run is shown as active, revalidate the loader on a slow safety
  // interval. `run.state-changed` normally flips the strip instantly; this only
  // covers the case where that terminal event never arrived (dropped stream /
  // reconnect gap), bounding a stale "running" strip to one interval. A page
  // with a status poll running (below) has the cheaper net and skips this one.
  const polls = (input.poll?.runId ?? null) !== null;
  useEffect(() => {
    // The `window` probe asks the HOST what it provides, which is the question
    // this guard has: a server render has no timer to schedule on.
    if (polls || !input.hasActiveRun || !("window" in globalThis)) return;
    const id = window.setInterval(() => {
      void revalidateRef.current();
    }, 20_000);
    return () => window.clearInterval(id);
  }, [input.hasActiveRun, polls]);

  // CTL-2: the status poll. Reads the run's tail (its new lines and facts
  // included) and revalidates once the run has settled.
  const pollRunId = input.poll?.runId ?? null;
  const pollEvery = input.poll?.everyMs ?? 0;
  useEffect(() => {
    if (!pollRunId || pollEvery <= 0 || !enabled || !("window" in globalThis)) return;
    let settled = false;
    const id = window.setInterval(() => {
      if (settled) return;
      void store.poll(pollRunId).then((state) => {
        if (state === null || LIVE_STATES.has(state) || settled) return;
        settled = true;
        void revalidateRef.current();
      });
    }, pollEvery);
    return () => window.clearInterval(id);
  }, [store, pollRunId, pollEvery, enabled]);

  return store;
}

/** A thread of `store` as the console draws it; re-renders only when it
 *  changes. Null while the store does not know the thread. */
export function useConsoleThread(store: RunLogStore, threadId: string): ThreadView | null {
  return useSyncExternalStore(
    store.subscribe,
    () => store.thread(threadId),
    () => store.thread(threadId),
  );
}

/** A run's live facts from `store`, or null before any tail read them. */
export function useRunFacts(store: RunLogStore | null, runId: string | null): RunLiveFacts | null {
  return useSyncExternalStore(
    store ? store.subscribe : noSubscribe,
    () => (store && runId ? store.facts(runId) : null),
    () => (store && runId ? store.facts(runId) : null),
  );
}

/** What the console's bar and footer read of the store. */
export interface ConsoleStatus {
  /** UI-03/UI-30: why the live tail stopped, or null while it follows. */
  streamError: string | null;
  /** The `{ } raw` view is open. */
  rawView: boolean;
}

/** The store's stream error and raw-view flag, for the console's bar and footer. */
export function useConsoleStatus(store: RunLogStore): ConsoleStatus {
  const streamError = useSyncExternalStore(store.subscribe, store.streamError, store.streamError);
  const rawView = useSyncExternalStore(store.subscribe, store.rawView, store.rawView);
  return { streamError, rawView };
}

function noSubscribe(): () => void {
  return () => {};
}
