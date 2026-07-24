import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { buildEventsUrl, sseScopes } from "~/features/live-updates/event-types";
import {
  isRunBoundary,
  runBoundaryLine,
  type LogLine,
  type RunLogWindow,
} from "./runtime-types";

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
 *
 * P13-D-11: that seed is now a BOUNDED window (NFR5), so this hook also owns
 * the other direction — `loadOlder()` walks backwards through the history the
 * loader did not ship, prepending pages, so the console stays the agent's whole
 * history on the task (UI-53) without loading it all at once.
 */

/** One console line with its display projection + exact stored envelope. */
export interface StreamedLine {
  display: LogLine;
  raw: string;
}

/** P13-D-11: backward-paging state for one thread's console. */
export interface OlderLogState {
  /** Older lines remain — render the "load older" affordance. */
  hasMore: boolean;
  /** How many stored lines are NOT loaded yet (0 once everything is in). */
  withheld: number;
  /** A backward page is in flight. */
  loading: boolean;
  /** The last backward page failed; null while healthy. */
  error: string | null;
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
  /** P13-D-11: threadId → whether/how much older history is still withheld. */
  olderByThread: Record<string, OlderLogState>;
  /** P13-D-11: fetch the next page of OLDER lines for a thread and prepend it.
   *  Deliberately manual — an agent log is scanned, not doom-scrolled, and
   *  auto-loading upward fights the live tail at the bottom. */
  loadOlder: (threadId: string) => void;
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

/** P13-D-11: where the backward walk has got to, per thread. */
interface PageCursor {
  /** The group's run ids, oldest-first (`logWindow.runIds`). */
  runIds: string[];
  /** Index of the run being paged; < 0 → the whole group is loaded. */
  runIdx: number;
  /** Next `before` seq within that run; null → fetch that run's NEWEST page
   *  (how the walk enters a previous run). */
  before: number | null;
  /** Index of the run whose block is currently TOPMOST in the console — the
   *  run a newly prepended block needs a `── resumed ──` boundary against. */
  topRunIdx: number;
}

/** Page size for a backward fetch. The endpoint clamps to 1…500. */
const OLDER_PAGE_LINES = 200;

/** Stored lines only — the synthetic run boundaries are not console history. */
function storedCount(lines: StreamedLine[]): number {
  return lines.reduce((n, l) => (isRunBoundary(l.display) ? n : n + 1), 0);
}

/** The seed paging state for a thread, straight off the loader's window. */
function seedOlder(window: RunLogWindow, lines: StreamedLine[]): OlderLogState {
  return {
    hasMore: window.hasMore && window.oldest !== null,
    withheld: Math.max(0, window.totalLines - storedCount(lines)),
    loading: false,
    error: null,
  };
}

function seedPageCursor(window: RunLogWindow): PageCursor {
  // `oldest` is the oldest line the payload carries, so the next page is
  // everything with a SMALLER seq in that same run. `hasMore` without an
  // `oldest` cursor is not reachable server-side, but treat it as "nothing to
  // page" rather than guessing a cursor that would duplicate lines.
  const runIdx = window.oldest ? window.runIds.indexOf(window.oldest.runId) : -1;
  return {
    runIds: window.runIds,
    runIdx: window.hasMore ? runIdx : -1,
    before: window.oldest ? window.oldest.seq : null,
    topRunIdx: runIdx,
  };
}

export function useRunLogStream(input: {
  projectSlug: string;
  taskKey: string;
  /** thread id → { runId, the loader's window of lines, its window meta }. */
  threads: {
    threadId: string;
    runId: string | null;
    lines: StreamedLine[];
    /** P13-D-11: `RunView.logWindow` — the live-tail seed + backward cursor. */
    window: RunLogWindow;
  }[];
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
  const [olderByThread, setOlderByThread] = useState<Record<string, OlderLogState>>(() =>
    Object.fromEntries(input.threads.map((t) => [t.threadId, seedOlder(t.window, t.lines)])),
  );

  // Cursors: highest seq held per run. RunId is needed to fetch the tail.
  const cursorsRef = useRef<Map<string, ThreadCursor>>(new Map());
  const pageCursorsRef = useRef<Map<string, PageCursor>>(new Map());
  /**
   * P13-D-11: threads the reader has already paged backwards in. They are
   * FROZEN against loader re-seeds — a revalidation (any `run.state-changed`,
   * plus the F22 safety interval) would otherwise throw away every older page
   * they loaded, and silently open a gap in the middle of the console, because
   * the loader's window slides forward as the run grows. The live tail keeps
   * the bottom current from OUR cursor, so ignoring the loader's copy of lines
   * we already hold loses nothing.
   */
  const pagedRef = useRef<Set<string>>(new Set());
  const taskRef = useRef(`${projectSlug} ${taskKey}`);
  const threadsKey =
    `${projectSlug} ${taskKey}|` +
    input.threads
      .map((t) => `${t.threadId}:${t.runId ?? ""}:${t.lines.length}:${t.window.headSeq}`)
      .join("|");

  useEffect(() => {
    // A different task entirely → nothing is frozen, everything re-seeds.
    const taskId = `${projectSlug} ${taskKey}`;
    if (taskRef.current !== taskId) {
      taskRef.current = taskId;
      pagedRef.current = new Set();
    }
    const paged = pagedRef.current;
    // Re-seed lines + cursors whenever the loader thread-set changes (e.g. a
    // revalidation after a state change delivered new backfill) — except for
    // threads the reader has paged backwards in (see `pagedRef`).
    setLinesByThread((prev) =>
      Object.fromEntries(
        input.threads.map((t) => [
          t.threadId,
          paged.has(t.threadId) ? (prev[t.threadId] ?? t.lines) : t.lines,
        ]),
      ),
    );
    setOlderByThread((prev) =>
      Object.fromEntries(
        input.threads.map((t) => [
          t.threadId,
          paged.has(t.threadId)
            ? (prev[t.threadId] ?? seedOlder(t.window, t.lines))
            : seedOlder(t.window, t.lines),
        ]),
      ),
    );
    const map = new Map<string, ThreadCursor>();
    const pages = new Map<string, PageCursor>();
    for (const t of input.threads) {
      if (paged.has(t.threadId)) {
        const keptPage = pageCursorsRef.current.get(t.threadId);
        if (keptPage) pages.set(t.threadId, keptPage);
      } else {
        pages.set(t.threadId, seedPageCursor(t.window));
      }
      if (!t.runId) continue;
      const kept = paged.has(t.threadId) ? cursorsRef.current.get(t.runId) : undefined;
      map.set(
        t.runId,
        kept ?? {
          runId: t.runId,
          threadId: t.threadId,
          // P13-D-11: the representative run's real max seq. This used to be
          // `t.lines.length - 1`, which has been wrong since UI-53 concatenated
          // several runs (plus boundary rows) into one group: the index
          // OVERSHOT the seq, `?since=` asked for lines that do not exist yet,
          // and the live tail silently stalled on every resumed agent.
          headSeq: t.window.headSeq,
        },
      );
    }
    cursorsRef.current = map;
    pageCursorsRef.current = pages;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadsKey]);

  // Backward pages are fired from a click, not from the SSE effect, so they get
  // their own abort scope (torn down when the task changes / on unmount).
  const pageAbortRef = useRef<AbortController | null>(null);
  const pagingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const ctl = new AbortController();
    pageAbortRef.current = ctl;
    return () => {
      ctl.abort();
      pagingRef.current = new Set();
    };
  }, [projectSlug, taskKey]);

  /**
   * P13-D-11: one page older. Walks `logWindow.runIds` backwards — page the
   * current run with `?before=`, and when the endpoint reports `hasMore: false`
   * (or hands back an empty page) that run is exhausted, so step to the
   * PREVIOUS run id and fetch its newest page with a bare `?limit=`. Empty runs
   * are skipped within the same call so a click always produces lines or
   * genuinely runs off the front of the group.
   */
  const loadOlder = useCallback((threadId: string) => {
    const cursor = pageCursorsRef.current.get(threadId);
    if (!cursor || cursor.runIdx < 0) return;
    if (pagingRef.current.has(threadId)) return;
    pagingRef.current.add(threadId);
    setOlderByThread((prev) => {
      const cur = prev[threadId];
      if (!cur) return prev;
      return { ...prev, [threadId]: { ...cur, loading: true, error: null } };
    });

    const fail = (message: string) => {
      setOlderByThread((prev) => {
        const cur = prev[threadId];
        if (!cur) return prev;
        return { ...prev, [threadId]: { ...cur, loading: false, error: message } };
      });
    };

    void (async () => {
      try {
        while (cursor.runIdx >= 0) {
          const runId = cursor.runIds[cursor.runIdx]!;
          const qs = new URLSearchParams({ runId, limit: String(OLDER_PAGE_LINES) });
          if (cursor.before !== null) qs.set("before", String(cursor.before));
          const res = await fetch(`/resources/run-log?${qs.toString()}`, {
            headers: { Accept: "application/json" },
            signal: pageAbortRef.current?.signal ?? null,
          });
          if (!res.ok) {
            fail(
              res.status === 403
                ? "Older lines are project-member only."
                : `Could not load older lines — the log endpoint returned ${res.status}.`,
            );
            return;
          }
          const body = (await res.json()) as {
            data?: {
              lines: { seq: number; display: LogLine; raw: string }[];
              oldestSeq: number;
              hasMore: boolean;
            };
          };
          const data = body.data;
          if (!data) {
            fail("Could not load older lines — malformed response.");
            return;
          }
          const from = cursor.runIdx;
          // Advance BEFORE prepending so an abort mid-flight can never re-fetch
          // the same page into the console twice.
          if (data.hasMore) {
            cursor.before = data.oldestSeq;
          } else {
            cursor.runIdx -= 1;
            cursor.before = null;
          }
          if (data.lines.length === 0) continue; // empty run — keep walking

          const block: StreamedLine[] = data.lines.map((l) => ({
            display: l.display,
            raw: l.raw,
          }));
          // Crossing into an earlier run re-creates UI-53's boundary above the
          // block that is currently topmost — the same rule the projection uses
          // (a boundary precedes every contributing run but the first).
          if (from !== cursor.topRunIdx) {
            block.push({
              display: runBoundaryLine(cursor.topRunIdx + 1, cursor.runIds.length),
              raw: "",
            });
          }
          cursor.topRunIdx = from;
          pagedRef.current.add(threadId);
          setLinesByThread((prev) => ({
            ...prev,
            [threadId]: [...block, ...(prev[threadId] ?? [])],
          }));
          setOlderByThread((prev) => {
            const cur = prev[threadId];
            if (!cur) return prev;
            return {
              ...prev,
              [threadId]: {
                hasMore: cursor.runIdx >= 0,
                withheld: Math.max(0, cur.withheld - data.lines.length),
                loading: false,
                error: null,
              },
            };
          });
          return;
        }
        // Walked off the front of the group — everything is loaded.
        setOlderByThread((prev) => {
          const cur = prev[threadId];
          if (!cur) return prev;
          return { ...prev, [threadId]: { hasMore: false, withheld: 0, loading: false, error: null } };
        });
      } catch {
        fail("Could not load older lines — the request failed.");
      } finally {
        pagingRef.current.delete(threadId);
      }
    })();
  }, []);

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

  return { linesByThread, streamError, olderByThread, loadOlder };
}
