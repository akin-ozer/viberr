import {
  consoleBoundaryKey,
  consoleLineKey,
  isRunBoundary,
  runBoundaryLine,
  RUN_LOG_WINDOW_LINES,
  type LogLine,
  type RunLiveFacts,
  type RunLogWindow,
  type RunView,
} from "./runtime-types";

/**
 * Ruling 457 (LIVE-2 / TASK-1 / LIVE-3): the run-log console's line buffer,
 * held OUTSIDE React state.
 *
 * The buffer used to be the task page's own state (`useRunLogStream` ran in
 * `TaskDetailPage`), so every console line re-rendered the whole page, and
 * every revalidation re-seeded it from the loader's copy of the window. It is
 * an external store now: the console reads the thread it shows with
 * `useSyncExternalStore`, so a line re-renders the console and nothing else,
 * and a revalidation changes nothing the console holds unless a thread's
 * representative run changed.
 *
 * Owner decision 2 (2026-09-24): a page's payload carries console lines only
 * on a hard load, and only the shown agent's. Every other thread arrives
 * `unloaded` and the console fills it with ONE `/resources/run-log?window=1`
 * request when it shows it. The stored envelopes arrive only while the raw
 * view is open.
 */

/** One console line: its identity, its display projection, its envelope. */
export interface StreamedLine {
  /** `consoleLineKey` / `consoleBoundaryKey`: the row's React key and the key
   *  of its open disclosures, stable across appends and backward pages. */
  key: string;
  display: LogLine;
  /** The stored wire envelope; null until the raw view asked for it. */
  raw: string | null;
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

/** Where a thread's lines stand. */
export type ThreadStatus =
  /** The lines are in hand (and follow the live tail). */
  | "ready"
  /** The page did not carry them; `show` loads them. */
  | "unloaded"
  | "loading"
  /** The window request failed; `loadError` says why. */
  | "failed";

/** One thread as the console reads it. Replaced, never mutated. */
export interface ThreadView {
  lines: readonly StreamedLine[];
  /** Moves whenever `lines` changed other than by lines appended at its end
   *  (a new window, a backward page, envelopes filled in). */
  epoch: number;
  /**
   * The stored lines that EXIST for the thread (the console's "N events"),
   * UI-53 boundaries excluded: the window's `totalLines` plus every line the
   * tail appended since. Ruling 457 (LIVE-1): the page no longer revalidates
   * per line, so the count follows the tail rather than the loader.
   */
  total: number;
  older: OlderLogState;
  status: ThreadStatus;
  loadError: string | null;
}

/** What a store needs from a page's run projection. `RunView` is one. */
export type ConsoleThreadInput = Pick<
  RunView,
  | "id"
  | "serverRunId"
  | "lines"
  | "raw"
  | "lineKeys"
  | "logWindow"
  | "phase"
  | "step"
  | "turns"
  | "tokens"
  | "tokensEstimated"
  | "cache"
  | "factsAt"
>;

/** The live facts a page's projection carries for its representative run. */
function factsOf(input: ConsoleThreadInput): RunLiveFacts {
  const facts: RunLiveFacts = {
    phase: input.phase,
    step: input.step,
    turns: input.turns,
    tokens: input.tokens,
    tokensEstimated: input.tokensEstimated,
    cache: input.cache,
  };
  if (input.factsAt !== undefined) facts.factsAt = input.factsAt;
  return facts;
}

/** What the console reads and asks of its line source. */
export interface RunLogStore {
  subscribe(listener: () => void): () => void;
  /** The thread, or null when the store does not know it (yet). */
  thread(threadId: string): ThreadView | null;
  /** A run's live facts as its newest tail read them (ruling 457, LIVE-1). */
  facts(runId: string): RunLiveFacts | null;
  /** UI-03/UI-30: why the live tail stopped, or null while it follows. */
  streamError(): string | null;
  /** The `{ } raw` view is open. */
  rawView(): boolean;
  /** The console is showing this thread: fill it if the page did not. */
  show(threadId: string): void;
  /** P13-D-11: one page of older lines. */
  loadOlder(threadId: string): void;
  /** Opens or closes the raw view; opening loads the shown threads' envelopes. */
  setRawView(on: boolean): void;
}

/** What the store follows: a task's runs, or a controller conversation's. */
export type RunLogSource =
  | { kind: "task"; projectSlug: string; taskKey: string }
  | { kind: "controller"; conversationId: string };

/** One phrase for "this stream is not yours", per source: the task channel's
 *  logs are project-member material, a controller turn's are the conversation
 *  owner's (and org admins'). */
function forbiddenNote(kind: RunLogSource["kind"]): string {
  return kind === "task"
    ? "project-member only"
    : "for the conversation's owner and org admins only";
}

/** Page size for a backward fetch. The endpoint clamps to 1…500. */
const OLDER_PAGE_LINES = 200;
/** The most lines one `/resources/run-log` page returns. */
const MAX_PAGE_LINES = 500;

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

interface ThreadState {
  threadId: string;
  /** The group's representative run: the one the live tail follows. */
  runId: string;
  runIds: string[];
  /** Highest seq held for `runId`. */
  cursor: number;
  /** Highest seq a frame announced for `runId`. */
  announced: number;
  tailing: boolean;
  /** A facts-only read is in flight (CON-1), and a frame landed during it. */
  readingFacts: boolean;
  factsAgain: boolean;
  /** A `window=1` request is in flight. */
  windowing: boolean;
  /** The lines held are drawn until a window replaces them (CON-3): the
   *  cursor is not theirs, so the tail waits for the window. */
  replacing: boolean;
  paging: boolean;
  fillingRaw: boolean;
  /** Lines without their envelope arrived while a fill was in flight (CON-8). */
  fillAgain: boolean;
  shown: boolean;
  page: PageCursor | null;
  view: ThreadView;
}

/** Stored lines only — the synthetic run boundaries are not console history. */
function storedCount(lines: readonly { display: LogLine }[]): number {
  return lines.reduce((n, l) => (isRunBoundary(l.display) ? n : n + 1), 0);
}

function seedOlder(window: RunLogWindow, lines: readonly StreamedLine[]): OlderLogState {
  return {
    hasMore: window.hasMore && window.oldest !== null,
    withheld: Math.max(0, window.totalLines - storedCount(lines)),
    loading: false,
    error: null,
  };
}

function seedPageCursor(window: RunLogWindow): PageCursor {
  // `oldest` is the oldest line the window carries, so the next page is
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

/** A window's lines with their keys; a boundary's envelope is the empty one
 *  the projection gives it. Lines without keys (a hand-built fixture) are
 *  keyed by position. */
function keyedLines(
  lines: readonly LogLine[],
  keys: readonly string[] | undefined,
  raw: readonly string[],
): StreamedLine[] {
  return lines.map((display, i) => ({
    key: keys?.[i] ?? `#${i}`,
    display,
    raw: isRunBoundary(display) ? "" : (raw[i] ?? null),
  }));
}

const NO_OLDER: OlderLogState = { hasMore: false, withheld: 0, loading: false, error: null };

// ------------------------------------------------------------ wire shapes

/** A tail or backward page as `/resources/run-log` answers it (`RunLog` in
 *  run-service.server.ts; each line's `raw` is absent under `raw=0`). */
interface TailPage {
  runId: string;
  state: string;
  lines: { seq: number; display: LogLine; raw?: string }[];
  headSeq: number;
  oldestSeq: number;
  hasMore: boolean;
  facts?: RunLiveFacts;
}

/** The `?window=1` answer (`RunLogWindowPage` in run-projection.server.ts). */
interface WindowPage {
  runId: string;
  lines: LogLine[];
  lineKeys: string[];
  logWindow: RunLogWindow;
  facts: RunLiveFacts;
}

function sameFacts(a: RunLiveFacts, b: RunLiveFacts): boolean {
  return (
    a.phase === b.phase &&
    a.step === b.step &&
    a.turns === b.turns &&
    a.tokens === b.tokens &&
    a.tokensEstimated === b.tokensEstimated &&
    JSON.stringify(a.cache) === JSON.stringify(b.cache)
  );
}

/** The run index a line key names, and its seq; null for a boundary or a
 *  position-keyed line. */
function parseLineKey(key: string): { run: number; seq: number } | null {
  const match = /^(\d+):(\d+)$/.exec(key);
  return match ? { run: Number(match[1]), seq: Number(match[2]) } : null;
}

// ------------------------------------------------------------ live store

export interface LiveRunLogStore extends RunLogStore {
  /** A revalidation brought the page's projection again. */
  reconcile(threads: readonly ConsoleThreadInput[]): void;
  /** A live frame named a line of `runId` up to `seq`. */
  onFrame(runId: string, seq: number): void;
  /** Reads the tail of `runId` now (the controller's status poll) and
   *  answers the run's state, or null when the read failed. */
  poll(runId: string): Promise<string | null>;
  /** UI-30: false for a viewer whose run-log requests would 403. */
  setEnabled(enabled: boolean): void;
  /** Aborts every request in flight (unmount). React can go on using a
   *  disposed store, so a window load it cuts short is asked again the next
   *  time its thread is shown (ruling 524(e)). */
  dispose(): void;
}

export function createLiveRunLogStore(
  source: RunLogSource,
  threads: readonly ConsoleThreadInput[],
  initiallyEnabled = true,
): LiveRunLogStore {
  const listeners = new Set<() => void>();
  let threadMap = new Map<string, ThreadState>();
  const factsByRun = new Map<string, RunLiveFacts>();
  let streamError: string | null = null;
  let rawView = false;
  let enabled = initiallyEnabled;
  let abort = new AbortController();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const fromInput = (input: ConsoleThreadInput): ThreadState => {
    const window = input.logWindow;
    const loaded = window.loaded !== false;
    const lines = loaded ? keyedLines(input.lines, input.lineKeys, input.raw) : [];
    return {
      threadId: input.id,
      runId: input.serverRunId,
      runIds: window.runIds,
      cursor: window.headSeq,
      announced: window.headSeq,
      tailing: false,
      readingFacts: false,
      factsAgain: false,
      windowing: false,
      replacing: false,
      paging: false,
      fillingRaw: false,
      fillAgain: false,
      shown: false,
      page: loaded ? seedPageCursor(window) : null,
      view: {
        lines,
        epoch: 0,
        total: Math.max(window.totalLines, storedCount(lines)),
        older: loaded ? seedOlder(window, lines) : NO_OLDER,
        status: loaded ? "ready" : "unloaded",
        loadError: null,
      },
    };
  };

  for (const input of threads) {
    threadMap.set(input.id, fromInput(input));
    factsByRun.set(input.serverRunId, factsOf(input));
  }

  /** Replaces a thread's view (and tells the console). */
  const update = (t: ThreadState, patch: Partial<ThreadView>) => {
    t.view = { ...t.view, ...patch };
    notify();
  };

  /**
   * Ruling 457 (CON-7): the NEWEST read of a run's facts wins, not the last
   * to arrive. A revalidation's projection and a tail read race, and taking
   * whichever landed last stepped the strip's turns back (5, 4, 5), or left a
   * settled run on a late pre-finalization tail answer for good. Each read is
   * stamped with the row's `updated_at` (`factsAt`); an older stamp is
   * dropped, and equal facts under a newer stamp only move the stamp.
   */
  const setFacts = (runId: string, facts: RunLiveFacts | undefined) => {
    if (!facts) return;
    const held = factsByRun.get(runId);
    if (held) {
      if (held.factsAt !== undefined && facts.factsAt !== undefined && facts.factsAt < held.factsAt) return;
      if (sameFacts(held, facts)) {
        // Nothing drawn changed, so nothing re-renders; the stamp still moves,
        // so a read older than this one cannot land after it.
        if (facts.factsAt !== undefined) held.factsAt = facts.factsAt;
        return;
      }
    }
    factsByRun.set(runId, facts);
    notify();
  };

  const setStreamError = (next: string | null) => {
    if (streamError === next) return;
    streamError = next;
    notify();
  };

  /** Is `t` still the thread the store holds (a revalidation may have
   *  replaced it while a request was in flight)? */
  const current = (t: ThreadState) => threadMap.get(t.threadId) === t;

  const runIndex = (t: ThreadState, runId: string) => {
    const at = t.runIds.indexOf(runId);
    if (at >= 0) return at;
    t.runIds = [...t.runIds, runId];
    return t.runIds.length - 1;
  };

  /** A `/resources/run-log` answer's `data`, or null with the status of a
   *  refusal (or of a 200 that is not the route's body, e.g. a proxy page). */
  const getData = async <T,>(url: string): Promise<{ status: number; data: T | null }> => {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: abort.signal,
    });
    if (!res.ok) return { status: res.status, data: null };
    // SAFETY: a 200 from this app's own `/resources/run-log` loader, which
    // answers `Response.json({ data })` in the shape of the mode the URL asked
    // for; every other body it produces carries a non-200 status and returned
    // above. `data` stays optional and is checked, so a 200 that is not that
    // body surfaces as a failed read instead of throwing.
    const body = (await res.json()) as { data?: T };
    return { status: res.status, data: body.data ?? null };
  };

  const tailUrl = (runId: string, since: number) =>
    `/resources/run-log?runId=${encodeURIComponent(runId)}&since=${since}${rawView ? "" : "&raw=0"}`;
  /** A run's facts and no lines: a `since` past every line answers none. */
  const factsUrl = (runId: string) => tailUrl(runId, Number.MAX_SAFE_INTEGER);

  /** Appends a tail page's fresh lines; true when any arrived. */
  const appendTail = (t: ThreadState, page: TailPage): boolean => {
    // UI-35: drop anything at or below the seq already held, so an
    // overlapping page can never duplicate a line.
    const fresh = page.lines.filter((l) => l.seq > t.cursor);
    t.cursor = Math.max(t.cursor, page.headSeq);
    if (fresh.length === 0) return false;
    const run = runIndex(t, page.runId);
    update(t, {
      lines: [
        ...t.view.lines,
        ...fresh.map((l) => ({ key: consoleLineKey(run, l.seq), display: l.display, raw: l.raw ?? null })),
      ],
      total: t.view.total + fresh.length,
    });
    // CON-8: a read made before the raw view opened brought no envelopes.
    if (rawView && fresh.some((l) => l.raw === undefined)) void fillRaw(t);
    return true;
  };

  /**
   * Ruling 457 (CON-2): a thread the tail fell more than one window behind
   * (a tab back from hidden, a resync, a revalidation after a long gap) is
   * re-windowed, the bounded read a fresh load makes, instead of reading every
   * missed line forward in one request and holding them all. A shown console
   * keeps drawing what it holds until the window lands; any other thread lets
   * go of its lines and loads when it is shown.
   */
  const rewindow = (t: ThreadState) => {
    if (t.shown) {
      t.replacing = true;
      void loadWindow(t);
      return;
    }
    t.page = null;
    update(t, { lines: [], epoch: t.view.epoch + 1, older: NO_OLDER, status: "unloaded" });
  };

  /**
   * UI-35 / LIVE-3: at most one tail read per thread in flight, and a frame
   * that lands while one is in flight is not lost: the read runs again for as
   * long as a frame announced a line past what it brought.
   */
  const tail = async (t: ThreadState): Promise<void> => {
    if (t.tailing || t.replacing || t.view.status !== "ready" || !enabled) return;
    t.tailing = true;
    try {
      while (current(t) && t.announced > t.cursor) {
        if (t.announced - t.cursor > RUN_LOG_WINDOW_LINES) {
          rewindow(t);
          return;
        }
        const { status, data } = await getData<TailPage>(tailUrl(t.runId, t.cursor));
        if (data === null) {
          // UI-30: a 403 here means the viewer is not a project member (or, on
          // the controller channel, not the conversation's owner). It used to
          // be swallowed, leaving a console that silently stopped following.
          setStreamError(
            status === 403
              ? `Live tail stopped: raw run logs are ${forbiddenNote(source.kind)}.`
              : `Live tail stopped: the log endpoint returned ${status}.`,
          );
          return;
        }
        if (!current(t)) return;
        setFacts(data.runId, data.facts);
        if (appendTail(t, data)) setStreamError(null);
        // Nothing past the cursor after all: stop rather than ask again.
        else t.announced = t.cursor;
      }
    } catch {
      // Network hiccup: the next frame, or the revalidation a reconnect
      // brings, asks again from the same cursor.
    } finally {
      t.tailing = false;
    }
  };

  /**
   * Ruling 457 (CON-1): the Live run strip reads a run's facts from this
   * store, and only a `ready` thread tails, so a running agent whose console
   * was never shown (the strip's picker is its own, and a hard load carries
   * one group's lines) kept the loader's phase, step, turns and tokens for
   * its whole run. A frame for such a thread reads that run's facts alone:
   * one small request, at most one in flight per thread, and one more for
   * the frames that landed while it was.
   */
  const readFacts = async (t: ThreadState): Promise<void> => {
    if (!enabled) return;
    if (t.readingFacts) {
      t.factsAgain = true;
      return;
    }
    t.readingFacts = true;
    try {
      do {
        t.factsAgain = false;
        const { data } = await getData<TailPage>(factsUrl(t.runId));
        if (data === null) return;
        setFacts(data.runId, data.facts);
      } while (t.factsAgain && current(t));
    } catch {
      // The next frame asks again.
    } finally {
      t.readingFacts = false;
    }
  };

  /**
   * Owner decision 2: the one request that fills a thread the page did not.
   * A thread `replacing` its lines keeps drawing them until the window lands.
   */
  const loadWindow = async (t: ThreadState): Promise<void> => {
    if (t.windowing || !enabled) return;
    // A failed load is asked again the next time the thread is shown.
    if (!t.replacing && t.view.status !== "unloaded" && t.view.status !== "failed") return;
    t.windowing = true;
    if (!t.replacing) update(t, { status: "loading", loadError: null });
    const fail = (loadError: string) => {
      t.replacing = false;
      update(t, { status: "failed", loadError });
    };
    // Ruling 524(e): a request `dispose` aborted is not a failure, and the
    // thread is no longer this request's (`dispose` handed it back).
    const { signal } = abort;
    try {
      const { status, data } = await getData<WindowPage>(
        `/resources/run-log?runId=${encodeURIComponent(t.runId)}&window=1`,
      );
      if (signal.aborted || !current(t)) return;
      if (data === null) {
        fail(
          status === 403
            ? `This console is ${forbiddenNote(source.kind)}.`
            : `Could not load this console: the log endpoint returned ${status}.`,
        );
        return;
      }
      const { lines, lineKeys, logWindow, facts, runId } = data;
      const seeded = keyedLines(lines, lineKeys, []);
      t.runIds = logWindow.runIds;
      t.page = seedPageCursor(logWindow);
      // Ruling 457 (CON-5): the window answers for the group's representative
      // NOW, which may be a newer run than the page projected (a resume
      // before the state-change revalidation landed). Follow that run: kept on
      // the old one, the tail re-read its lines past a stale cursor and
      // appended them after the new run's, and the new run's frames matched
      // no thread.
      const previous = t.runId;
      t.runId = runId;
      t.cursor = logWindow.headSeq;
      t.announced = runId === previous ? Math.max(t.announced, t.cursor) : t.cursor;
      setFacts(runId, facts);
      t.replacing = false;
      update(t, {
        lines: seeded,
        epoch: t.view.epoch + 1,
        total: Math.max(logWindow.totalLines, storedCount(seeded)),
        older: seedOlder(logWindow, seeded),
        status: "ready",
        loadError: null,
      });
      if (rawView) void fillRaw(t);
      void tail(t);
    } catch {
      if (!signal.aborted && current(t)) fail("Could not load this console: the request failed.");
    } finally {
      if (!signal.aborted) t.windowing = false;
    }
  };

  /**
   * The raw view opened: load the stored envelopes of the lines the thread
   * holds without one, a backward page per run (`before` its newest missing
   * seq, as many as it misses, at most 500 at a time).
   *
   * Ruling 457 (CON-8): lines can arrive without their envelope after the
   * view opened (a `raw=0` tail read or an older page already in flight at
   * the toggle). Those appends ask for a fill too, and one asked for while a
   * fill is in flight runs once it ends, so no row reads "loading the stored
   * envelope…" for good.
   */
  const fillRaw = async (t: ThreadState): Promise<void> => {
    if (t.fillingRaw) {
      t.fillAgain = true;
      return;
    }
    t.fillAgain = false;
    if (t.view.status !== "ready" || !enabled) return;
    const missing = new Map<number, number[]>();
    for (const line of t.view.lines) {
      if (line.raw !== null) continue;
      const at = parseLineKey(line.key);
      if (!at) continue;
      const seqs = missing.get(at.run) ?? [];
      seqs.push(at.seq);
      missing.set(at.run, seqs);
    }
    if (missing.size === 0) return;
    t.fillingRaw = true;
    const found = new Map<string, string>();
    try {
      for (const [run, seqs] of missing) {
        const runId = t.runIds[run];
        if (!runId) continue;
        let high = Math.max(...seqs);
        const low = Math.min(...seqs);
        while (high >= low) {
          const limit = Math.min(MAX_PAGE_LINES, high - low + 1);
          const { data } = await getData<TailPage>(
            `/resources/run-log?runId=${encodeURIComponent(runId)}&before=${high + 1}&limit=${limit}`,
          );
          if (data === null || data.lines.length === 0) break;
          for (const l of data.lines) {
            if (l.raw !== undefined) found.set(consoleLineKey(run, l.seq), l.raw);
          }
          high = data.lines[0]!.seq - 1;
        }
      }
    } catch {
      // The raw view shows what it has; a later toggle asks again.
    } finally {
      t.fillingRaw = false;
    }
    if (!current(t)) return;
    if (found.size > 0) {
      update(t, {
        lines: t.view.lines.map((line) => {
          const raw = line.raw === null ? found.get(line.key) : undefined;
          return raw === undefined ? line : { ...line, raw };
        }),
        epoch: t.view.epoch + 1,
      });
    }
    if (t.fillAgain && rawView) void fillRaw(t);
  };

  /**
   * P13-D-11: one page older. Walks `logWindow.runIds` backwards — page the
   * current run with `?before=`, and when the endpoint reports `hasMore: false`
   * (or hands back an empty page) that run is exhausted, so step to the
   * PREVIOUS run id and fetch its newest page with a bare `?limit=`. Empty runs
   * are skipped within the same call so a click always produces lines or
   * genuinely runs off the front of the group.
   */
  const loadOlder = async (t: ThreadState): Promise<void> => {
    const cursor = t.page;
    if (!cursor || cursor.runIdx < 0 || t.paging || !enabled) return;
    t.paging = true;
    const fail = (message: string) => {
      if (current(t)) update(t, { older: { ...t.view.older, loading: false, error: message } });
    };
    update(t, { older: { ...t.view.older, loading: true, error: null } });
    try {
      while (cursor.runIdx >= 0) {
        const runId = cursor.runIds[cursor.runIdx]!;
        const qs = new URLSearchParams({ runId, limit: String(OLDER_PAGE_LINES) });
        if (cursor.before !== null) qs.set("before", String(cursor.before));
        if (!rawView) qs.set("raw", "0");
        const { status, data } = await getData<TailPage>(`/resources/run-log?${qs.toString()}`);
        if (data === null) {
          fail(
            status === 403
              ? `Older lines are ${forbiddenNote(source.kind)}.`
              : status === 200
                ? "Could not load older lines: malformed response."
                : `Could not load older lines: the log endpoint returned ${status}.`,
          );
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
        if (!current(t)) return;
        const block: StreamedLine[] = data.lines.map((l) => ({
          key: consoleLineKey(from, l.seq),
          display: l.display,
          raw: l.raw ?? null,
        }));
        // Crossing into an earlier run re-creates UI-53's boundary above the
        // block that is currently topmost — the same rule the projection uses
        // (a boundary precedes every contributing run but the first).
        if (from !== cursor.topRunIdx) {
          block.push({
            key: consoleBoundaryKey(cursor.topRunIdx),
            display: runBoundaryLine(cursor.topRunIdx + 1, cursor.runIds.length),
            raw: "",
          });
        }
        cursor.topRunIdx = from;
        update(t, {
          lines: [...block, ...t.view.lines],
          epoch: t.view.epoch + 1,
          older: {
            hasMore: cursor.runIdx >= 0,
            withheld: Math.max(0, t.view.older.withheld - data.lines.length),
            loading: false,
            error: null,
          },
        });
        // CON-8: a page asked for before the raw view opened.
        if (rawView && block.some((l) => l.raw === null)) void fillRaw(t);
        return;
      }
      // Walked off the front of the group — everything is loaded.
      if (current(t)) update(t, { older: { hasMore: false, withheld: 0, loading: false, error: null } });
    } catch {
      fail("Could not load older lines: the request failed.");
    } finally {
      t.paging = false;
    }
  };

  const threadOfRun = (runId: string): ThreadState | undefined => {
    for (const t of threadMap.values()) if (t.runId === runId) return t;
    return undefined;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    thread: (threadId) => threadMap.get(threadId)?.view ?? null,
    facts: (runId) => factsByRun.get(runId) ?? null,
    streamError: () => streamError,
    rawView: () => rawView,
    show(threadId) {
      const t = threadMap.get(threadId);
      if (!t) return;
      t.shown = true;
      if (t.view.status === "unloaded" || t.view.status === "failed") void loadWindow(t);
      else if (rawView) void fillRaw(t);
    },
    loadOlder(threadId) {
      const t = threadMap.get(threadId);
      if (t) void loadOlder(t);
    },
    setRawView(on) {
      if (rawView === on) return;
      rawView = on;
      notify();
      if (!on) return;
      for (const t of threadMap.values()) if (t.shown) void fillRaw(t);
    },
    reconcile(inputs) {
      const next = new Map<string, ThreadState>();
      let changed = inputs.length !== threadMap.size;
      for (const input of inputs) {
        // The newest read of a run's facts wins, whichever carried it: this
        // projection, or a tail read after it.
        setFacts(input.serverRunId, factsOf(input));
        const held = threadMap.get(input.id);
        if (held && held.runId === input.serverRunId) {
          // TASK-3 / LIVE-3: the same thread on the same run keeps everything
          // it holds. The loader's copy of the window is older than the tail
          // (or absent), and swapping it in re-drew every row. A head the
          // loader saw past the cursor (a line whose frame was missed, a
          // reconnect after a hidden tab) is fetched as a gap, not re-seeded.
          next.set(input.id, held);
          if (input.logWindow.runIds.length > 0) held.runIds = input.logWindow.runIds;
          if (input.logWindow.headSeq > held.announced) held.announced = input.logWindow.headSeq;
          // A snapshot no newer than the tail may still know lines the tail
          // never sees (another run of the group); one past it is counted by
          // the gap read instead.
          if (input.logWindow.headSeq <= held.cursor && input.logWindow.totalLines > held.view.total) {
            update(held, { total: input.logWindow.totalLines });
          }
          if (held.view.status === "ready") void tail(held);
          continue;
        }
        // A new thread, or its representative changed (a resume): take what
        // the page carries, or load it when the console shows it.
        changed = true;
        const fresh = fromInput(input);
        if (held?.shown) {
          fresh.shown = true;
          // Ruling 457 (CON-3): a revalidation carries no lines, and swapping
          // in the empty thread blanked a console the reader was looking at
          // ("loading this console…") for the window's round trip. It keeps
          // drawing what it holds until the new run's window replaces it.
          if (fresh.view.status === "unloaded" && held.view.status === "ready") {
            fresh.view = held.view;
            fresh.replacing = true;
          }
        }
        next.set(input.id, fresh);
      }
      threadMap = next;
      if (changed) {
        notify();
        for (const t of threadMap.values()) {
          if (t.shown && (t.replacing || t.view.status === "unloaded")) void loadWindow(t);
        }
      }
    },
    onFrame(runId, seq) {
      const t = threadOfRun(runId);
      if (!t) return;
      if (seq > t.announced) t.announced = seq;
      if (t.view.status === "ready") {
        if (seq > t.cursor) void tail(t);
      } else if (t.view.status !== "loading") {
        // CON-1: no lines in hand, but the strip may show this run. A thread
        // that is loading gets its facts with the window.
        void readFacts(t);
      }
    },
    async poll(runId) {
      if (!enabled) return null;
      const t = threadOfRun(runId);
      try {
        // A thread whose lines are not in hand reads the facts only.
        const ready = t !== undefined && t.view.status === "ready";
        const { data } = await getData<TailPage>(ready ? tailUrl(runId, t.cursor) : factsUrl(runId));
        if (data === null) return null;
        setFacts(data.runId, data.facts);
        if (ready && current(t)) appendTail(t, data);
        return data.state;
      } catch {
        return null;
      }
    },
    setEnabled(next) {
      enabled = next;
    },
    dispose() {
      abort.abort();
      abort = new AbortController();
      // Ruling 524(e): under StrictMode, React's development build (the dev
      // server) rehearses every mount: the console shows its thread, the
      // page's cleanup disposes the store, and the console shows it again.
      // The aborted window load read as "the request failed" until the
      // console mounted anew. Each load cut short hands its thread back, so
      // the next show asks again.
      for (const t of threadMap.values()) {
        if (!t.windowing) continue;
        t.windowing = false;
        t.replacing = false;
        update(t, { status: "unloaded" });
      }
    },
  };
}
