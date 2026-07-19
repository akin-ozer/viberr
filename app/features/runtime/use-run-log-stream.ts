import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { createSseClient } from "~/features/live-updates/sse-client";
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
}): RunLogState {
  const { projectSlug, taskKey } = input;
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

    let cancelled = false;

    const fetchTail = async (runId: string, sinceSeq: number) => {
      try {
        const res = await fetch(
          `/resources/run-log?runId=${encodeURIComponent(runId)}&since=${sinceSeq}`,
          { headers: { Accept: "application/json" } },
        );
        if (!res.ok) return;
        const body = (await res.json()) as {
          data?: {
            threadId: string;
            lines: { seq: number; display: LogLine; raw: string }[];
            headSeq: number;
          };
        };
        const data = body.data;
        if (!data || cancelled || data.lines.length === 0) return;
        const cursor = cursorsRef.current.get(runId);
        if (cursor) cursor.headSeq = data.headSeq;
        setLinesByThread((prev) => {
          const existing = prev[data.threadId] ?? [];
          const appended = data.lines.map((l) => ({ display: l.display, raw: l.raw }));
          return { ...prev, [data.threadId]: [...existing, ...appended] };
        });
      } catch {
        // Network hiccup — the next append or a revalidation recovers state.
      }
    };

    const client = createSseClient({
      url: buildEventsUrl([sseScopes.task(projectSlug, taskKey)]),
      onEvent: (name, event) => {
        if (name === "run.log-appended") {
          try {
            const parsed = JSON.parse(event.data) as { data: RunLogAppendedData };
            const d = parsed.data;
            if (d.projectSlug !== projectSlug || d.taskKey !== taskKey) return;
            const cursor = cursorsRef.current.get(d.runId);
            const since = cursor ? cursor.headSeq : -1;
            if (d.seq <= since) return; // already have it
            void fetchTail(d.runId, since);
          } catch {
            // Malformed frame — ignore.
          }
        } else if (name === "run.state-changed") {
          try {
            const parsed = JSON.parse(event.data) as { data: RunStateChangedData };
            if (parsed.data.projectSlug !== projectSlug || parsed.data.taskKey !== taskKey) return;
            // Lifecycle is loader-owned (strip appears/disappears, pill flips).
            void revalidateRef.current();
          } catch {
            // Ignore.
          }
        }
      },
    });

    return () => {
      cancelled = true;
      client.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSlug, taskKey]);

  return { linesByThread };
}
