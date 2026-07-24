import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { buildEventsUrl, sseScopes } from "~/features/live-updates/event-types";
import type { LogLine } from "./runtime-types";

/**
 * The DEDICATED runtime-log consumer (phase-6 report §"High-frequency
 * streams", requirement (c)): its OWN EventSource on the task scope,
 * consuming `run.log-appended` directly — NOT `useLiveUpdates` revalidation
 * (which would refetch the whole task loader per log line). On a
 * `run.log-appended` for a run we're viewing, it fetches the new lines since
 * our last seq from /resources/run-log and appends them. On
 * `run.state-changed` it revalidates the task loader ONCE so the run strip /
 * pills flip (lifecycle is loader-owned).
 *
 * Seeded from the loader's `runtime[].lines`; the append-only design means
 * `follow`/auto-scroll in the panel just works.
 */

/** One console line with its display projection + exact stored envelope. */
export interface StreamedLine {
  display: LogLine;
  raw: string;
}

export interface RunLogState {
  /** threadId → its current log lines (seeded from the loader, tailed live). */
  linesByThread: Record<string, StreamedLine[]>;
  /**
   * UI-03/UI-30: why the live tail is not running, or null while it is healthy.
   * The stream used to fail silently — a 403 from `/resources/run-log` (or a
   * dropped EventSource after the session expired) left the console frozen with
   * no indication it had stopped following.
   */
  streamError: string | null;
}

interface RunLogAppendedData {
  projectSlug: string;
  taskKey: string;
  runId: string;
  threadId: string;
  seq: number;
}

interface RunStateChangedData {
  projectSlug: string;
  taskKey: string;
  runId: string;
  threadId: string;
  state: string;
}

/** Per-thread bookkeeping: the run id + the highest seq we hold. */
interface ThreadCursor {
  runId: string;
  threadId: string;
  headSeq: number;
}

export function useRunLogStream(input: {
  projectSlug: string;
  taskKey: string;
  /** thread id → { runId, initial lines } from the loader. */
  threads: { threadId: string; runId: string | null; lines: StreamedLine[] }[];
  /** True while the loader shows at least one running run. Drives a bounded
   *  safety revalidation so a `run.state-changed` finalize event MISSED during
   *  an SSE drop (rapid reaction chains) self-heals instead of leaving a
   *  phantom "1 agent running" strip until a manual reload (F22). */
  hasActiveRun?: boolean;
  /** UI-30: false for a NON-MEMBER, whose `/resources/run-log` requests 403.
   *  Opening a stream that can only fail is worse than not opening one. */
  enabled?: boolean;
}): RunLogState {
  const { projectSlug, taskKey } = input;
  const enabled = input.enabled !== false;
  const [streamError, setStreamError] = useState<string | null>(null);
  const revalidator = useRevalidator();
  const revalidateRef = useRef(revalidator.revalidate);
  useEffect(() => {
    revalidateRef.current = revalidator.revalidate;
  });

  // F22: while a run is shown as active, revalidate the loader on a slow safety
  // interval. `run.state-changed` normally flips the strip instantly; this only
  // covers the case where that terminal event never arrived (dropped stream /
  // reconnect gap), bounding a stale "running" strip to one interval.
  useEffect(() => {
    if (!input.hasActiveRun || typeof window === "undefined") return;
    const id = window.setInterval(() => {
      void revalidateRef.current();
    }, 20_000);
    return () => window.clearInterval(id);
  }, [input.hasActiveRun]);

  // Seed local lines from the loader on mount / thread-set change.
  const [linesByThread, setLinesByThread] = useState<Record<string, StreamedLine[]>>(() =>
    Object.fromEntries(input.threads.map((t) => [t.threadId, t.lines])),
  );

  // Cursors: highest seq held per run. Loader lines are seq 0..N-1, so the
  // head seq is (lines.length - 1). RunId is needed to fetch the tail.
  const cursorsRef = useRef<Map<string, ThreadCursor>>(new Map());
  const threadsKey = input.threads
    .map((t) => `${t.threadId}:${t.runId ?? ""}:${t.lines.length}`)
    .join("|");

  useEffect(() => {
    // Re-seed lines + cursors whenever the loader thread-set changes (e.g. a
    // revalidation after a state change delivered new backfill).
    setLinesByThread(Object.fromEntries(input.threads.map((t) => [t.threadId, t.lines])));
    const map = new Map<string, ThreadCursor>();
    for (const t of input.threads) {
      if (t.runId) map.set(t.runId, { runId: t.runId, threadId: t.threadId, headSeq: t.lines.length - 1 });
    }
    cursorsRef.current = map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadsKey]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    if (!enabled) return;

    // Aborts in-flight tail fetches on unmount / task change — a bare
    // `cancelled` flag would still let the response land and be parsed.
    const abort = new AbortController();
    // UI-35: at most ONE tail fetch per run in flight. `headSeq` only advanced
    // after a fetch resolved, and the sink publishes one event per console
    // line, so a chatty run fired several overlapping fetches that each
    // returned the same window and were concatenated blindly — every line
    // appeared 2–3× and the "N events" counter over-counted.
    const inFlight = new Set<string>();

    const fetchTail = async (runId: string, sinceSeq: number) => {
      if (inFlight.has(runId)) return;
      inFlight.add(runId);
      try {
        const res = await fetch(
          `/resources/run-log?runId=${encodeURIComponent(runId)}&since=${sinceSeq}`,
          { headers: { Accept: "application/json" }, signal: abort.signal },
        );
        if (!res.ok) {
          // UI-30: a 403 here means the viewer is not a project member. It used
          // to be swallowed, leaving a console that silently stopped following.
          setStreamError(
            res.status === 403
              ? "Live tail stopped — raw run logs are project-member only."
              : `Live tail stopped — the log endpoint returned ${res.status}.`,
          );
          return;
        }
        const body = (await res.json()) as {
          data?: {
            threadId: string;
            lines: { seq: number; display: LogLine; raw: string }[];
            headSeq: number;
          };
        };
        const data = body.data;
        if (!data || abort.signal.aborted || data.lines.length === 0) return;
        const cursor = cursorsRef.current.get(runId);
        // UI-35: drop anything at or below the seq we already hold, so an
        // overlapping window can never duplicate a line.
        const head = cursor ? cursor.headSeq : sinceSeq;
        const fresh = data.lines.filter((l) => l.seq > head);
        if (cursor) cursor.headSeq = Math.max(cursor.headSeq, data.headSeq);
        if (fresh.length === 0) return;
        setStreamError(null);
        setLinesByThread((prev) => {
          const existing = prev[data.threadId] ?? [];
          const appended = fresh.map((l) => ({ display: l.display, raw: l.raw }));
          return { ...prev, [data.threadId]: [...existing, ...appended] };
        });
      } catch {
        // Network hiccup — the next append or a revalidation recovers state.
      } finally {
        inFlight.delete(runId);
      }
    };

    const source = new EventSource(
      buildEventsUrl([sseScopes.task(projectSlug, taskKey)]),
    );
    // UI-03: an EventSource that receives a non-200 (an expired session 401s)
    // FAILS the connection per spec — it never reconnects. Nothing observed
    // that, so the console silently froze. Report it instead.
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setStreamError(
          "Live tail disconnected — reload the page to resume following.",
        );
      }
    };
    source.onopen = () => setStreamError(null);
    source.addEventListener("run.log-appended", (event) => {
      try {
        const parsed = JSON.parse(event.data) as { data: RunLogAppendedData };
        const d = parsed.data;
        if (d.projectSlug !== projectSlug || d.taskKey !== taskKey) return;
        const cursor = cursorsRef.current.get(d.runId);
        const since = cursor ? cursor.headSeq : -1;
        if (d.seq <= since) return;
        void fetchTail(d.runId, since);
      } catch {
        // Malformed frame — ignore.
      }
    });
    source.addEventListener("run.state-changed", (event) => {
      try {
        const parsed = JSON.parse(event.data) as { data: RunStateChangedData };
        if (
          parsed.data.projectSlug !== projectSlug ||
          parsed.data.taskKey !== taskKey
        ) {
          return;
        }
        void revalidateRef.current();
      } catch {
        // Malformed frame — ignore.
      }
    });

    return () => {
      abort.abort();
      source.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSlug, taskKey, enabled]);

  return { linesByThread, streamError };
}
