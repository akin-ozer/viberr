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

interface TailRequest {
  /** Highest sequence announced while this request (if any) is in flight. */
  targetSeq: number;
  inFlight: boolean;
  controller: AbortController | null;
}

export function useRunLogStream(input: {
  projectSlug: string;
  taskKey: string;
  /** thread id → { runId, initial lines } from the loader. */
  threads: { threadId: string; runId: string | null; lines: StreamedLine[] }[];
}): RunLogState {
  const { projectSlug, taskKey } = input;
  const revalidator = useRevalidator();
  const revalidateRef = useRef(revalidator.revalidate);
  revalidateRef.current = revalidator.revalidate;

  // Seed local lines from the loader on mount / thread-set change.
  const [linesByThread, setLinesByThread] = useState<Record<string, StreamedLine[]>>(() =>
    Object.fromEntries(input.threads.map((t) => [t.threadId, t.lines])),
  );

  // Cursors: highest seq held per run. Loader lines are seq 0..N-1, so the
  // head seq is (lines.length - 1). RunId is needed to fetch the tail.
  const cursorsRef = useRef<Map<string, ThreadCursor>>(new Map());
  const tailRequestsRef = useRef<Map<string, TailRequest>>(new Map());
  const seedGenerationRef = useRef(0);
  const threadsKey = input.threads
    .map(
      (t) =>
        `${t.threadId}:${t.runId ?? ""}:${t.lines.length}:${t.lines.at(-1)?.raw ?? ""}`,
    )
    .join("|");

  useEffect(() => {
    // Re-seed lines + cursors whenever the loader thread-set changes (e.g. a
    // revalidation after a state change delivered new backfill).
    seedGenerationRef.current += 1;
    for (const request of tailRequestsRef.current.values()) {
      request.controller?.abort();
    }
    tailRequestsRef.current.clear();
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

    /**
     * One serialized tail pump per run. SSE bursts only raise targetSeq while
     * the current request is in flight. A response is applied against the
     * cursor that exists *when it resolves*, then sorted/deduped by sequence.
     */
    const pumpTail = (runId: string) => {
      if (cancelled) return;
      const cursor = cursorsRef.current.get(runId);
      const request = tailRequestsRef.current.get(runId);
      if (!cursor || !request || request.inFlight || request.targetSeq <= cursor.headSeq) {
        return;
      }

      const requestedGeneration = seedGenerationRef.current;
      const sinceSeq = cursor.headSeq;
      const controller = new AbortController();
      request.inFlight = true;
      request.controller = controller;

      void (async () => {
        let madeProgress = false;
        try {
          const res = await fetch(
            `/resources/run-log?runId=${encodeURIComponent(runId)}&since=${sinceSeq}`,
            {
              headers: { Accept: "application/json" },
              signal: controller.signal,
            },
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
          if (
            !data ||
            cancelled ||
            controller.signal.aborted ||
            seedGenerationRef.current !== requestedGeneration
          ) {
            return;
          }

          const current = cursorsRef.current.get(runId);
          if (!current) return;
          // The route returns ordered rows, but sort and unique here as a
          // defensive boundary. Only append a contiguous monotonic suffix;
          // never jump over a missing seq and permanently discard it.
          const unique = new Map(
            data.lines.map((line) => [line.seq, line] as const),
          );
          const ordered = [...unique.values()].sort((a, b) => a.seq - b.seq);
          const appended: StreamedLine[] = [];
          let expected = current.headSeq + 1;
          for (const line of ordered) {
            if (line.seq < expected) continue;
            if (line.seq > expected) break;
            appended.push({ display: line.display, raw: line.raw });
            expected += 1;
          }
          if (appended.length === 0) return;

          current.headSeq = expected - 1;
          madeProgress = true;
          setLinesByThread((prev) => {
            const existing = prev[current.threadId] ?? [];
            return {
              ...prev,
              [current.threadId]: [...existing, ...appended],
            };
          });
        } catch (error) {
          if ((error as { name?: string } | null)?.name !== "AbortError") {
            // Network hiccup — the next append or revalidation recovers state.
          }
        } finally {
          const currentRequest = tailRequestsRef.current.get(runId);
          if (currentRequest?.controller === controller) {
            currentRequest.inFlight = false;
            currentRequest.controller = null;
            // If more events landed during the request, immediately fetch the
            // remaining suffix. Do not spin when the server made no progress.
            if (madeProgress) pumpTail(runId);
          }
        }
      })();
    };

    const client = createSseClient({
      url: buildEventsUrl([sseScopes.task(projectSlug, taskKey)]),
      onEvent: (name, event) => {
        if (name === "run.log-appended") {
          try {
            const parsed = JSON.parse(event.data) as { data: RunLogAppendedData };
            const d = parsed.data;
            if (d.projectSlug !== projectSlug || d.taskKey !== taskKey) return;
            let cursor = cursorsRef.current.get(d.runId);
            if (!cursor) {
              cursor = { runId: d.runId, threadId: d.threadId, headSeq: -1 };
              cursorsRef.current.set(d.runId, cursor);
            }
            if (d.seq <= cursor.headSeq) return;
            const request = tailRequestsRef.current.get(d.runId) ?? {
              targetSeq: d.seq,
              inFlight: false,
              controller: null,
            };
            request.targetSeq = Math.max(request.targetSeq, d.seq);
            tailRequestsRef.current.set(d.runId, request);
            pumpTail(d.runId);
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
      seedGenerationRef.current += 1;
      for (const request of tailRequestsRef.current.values()) {
        request.controller?.abort();
      }
      tailRequestsRef.current.clear();
      client.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSlug, taskKey]);

  return { linesByThread };
}
