// @vitest-environment jsdom
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useLiveUpdates } from "~/features/live-updates/use-live-updates";
import { sseScopes } from "~/features/live-updates/event-types";
import {
  useRunLogStream,
  type RunLogSource,
  type RunLogStore,
} from "./use-run-log-stream";
import type { ConsoleThreadInput } from "./run-log-store";
import {
  runBoundaryLine,
  type LogLine,
  type RunLiveFacts,
  type RunLogWindow,
} from "./runtime-types";
import { NO_RUN_CACHE } from "../../../test-support/run-view";
import { DataRouter, loaderRunCount, resetDataRouter } from "../../../test-support/data-router";
import { FakeEventSource } from "../../../test-support/fake-event-source";

/**
 * The hook calls `useRevalidator`, so it runs under a real data router
 * (`test-support/data-router.tsx`).
 *
 * Ruling 11: the console opens no connection of its own. Its frames come from
 * the tab's one live stream (`useLiveUpdates`, the layout's on a task page),
 * so every probe here mounts that stream beside the hook, on the scope the
 * page's layout holds.
 */
/** The `run.log-appended` frame body, as the broker puts it on the wire. */
interface RunLogAppended {
  projectSlug: string;
  taskKey: string;
  runId: string;
  threadId: string;
  seq: number;
}

/** The `controller.log-appended` frame body (ruling 247: keyed by conversation). */
interface ControllerLogAppended {
  conversationId: string;
  userId: string;
  runId: string;
  threadId: string;
  seq: number;
}

/** What `/resources/run-log` answers, as far as a test spells it out. */
interface TailBody {
  data: {
    runId?: string;
    state?: string;
    headSeq?: number;
    oldestSeq?: number;
    hasMore?: boolean;
    lines: { seq: number; display: LogLine; raw?: string }[];
    facts?: RunLiveFacts;
    lineKeys?: string[];
    logWindow?: RunLogWindow;
  };
}

/** The members the store reads off a `fetch` response. */
interface FakeResponse {
  ok: boolean;
  status?: number;
  json: () => Promise<TailBody | { data: unknown }>;
}

let nextId = 1;

/** One frame as the broker sends it: the payload under `data`, a fresh id. */
function emitFrame(
  source: FakeEventSource,
  name: string,
  data: RunLogAppended | ControllerLogAppended,
): void {
  source.emit(name, String(nextId++), JSON.stringify({ data }));
}

const line = (text: string): LogLine => ({
  t: "09:41:00",
  ev: "text",
  tag: "assistant",
  text,
});

const win = (patch: Partial<RunLogWindow> = {}): RunLogWindow => ({
  totalLines: 0,
  hasMore: false,
  runIds: ["run_1"],
  oldest: null,
  headSeq: -1,
  ...patch,
});

const FACTS: RunLiveFacts = {
  phase: "Working",
  step: null,
  turns: 1,
  tokens: 100,
  tokensEstimated: true,
  cache: NO_RUN_CACHE,
};

/** One thread of a page's projection, as much of a `RunView` as the store reads. */
function thread(patch: Partial<ConsoleThreadInput> = {}): ConsoleThreadInput {
  return {
    id: "primary",
    serverRunId: "run_1",
    lines: [],
    raw: [],
    logWindow: win(),
    ...FACTS,
    ...patch,
  };
}

const TASK: RunLogSource = { kind: "task", projectSlug: "viberr-core", taskKey: "VIB-142" };

let store: RunLogStore;

function Probe({
  threads,
  source = TASK,
  poll,
  shown,
}: {
  threads?: ConsoleThreadInput[];
  source?: RunLogSource;
  poll?: { runId: string | null; everyMs: number };
  /** A console on the page showing this thread. */
  shown?: string;
}) {
  const input: Parameters<typeof useRunLogStream>[0] = {
    source,
    threads: threads ?? [thread()],
  };
  if (poll) input.poll = poll;
  store = useRunLogStream(input);
  return shown ? <ShowsThread logs={store} threadId={shown} /> : null;
}

/** What the console does once mounted (`AgentLogsPanel`): shows its thread. */
function ShowsThread({ logs, threadId }: { logs: RunLogStore; threadId: string }) {
  useEffect(() => {
    logs.show(threadId);
  }, [logs, threadId]);
  return null;
}

/** The layout's live stream, on the scope the page's layout holds. */
function LayoutStream({ source = TASK }: { source?: RunLogSource }) {
  useLiveUpdates(
    source.kind === "task"
      ? [sseScopes.project(source.projectSlug), sseScopes.task(source.projectSlug, source.taskKey)]
      : [sseScopes.user()],
  );
  return null;
}

function Page(props: Parameters<typeof Probe>[0]) {
  return (
    <>
      <LayoutStream {...(props.source ? { source: props.source } : {})} />
      <Probe {...props} />
    </>
  );
}

const texts = (threadId = "primary") =>
  (store.thread(threadId)?.lines ?? []).map((l) => l.display.text);

const frame = (seq: number, runId = "run_1"): RunLogAppended => ({
  projectSlug: "viberr-core",
  taskKey: "VIB-142",
  runId,
  threadId: "primary",
  seq,
});

const tailOf = (lines: { seq: number; text: string }[], extra: Partial<TailBody["data"]> = {}): FakeResponse => ({
  ok: true,
  status: 200,
  json: async () => ({
    data: {
      runId: "run_1",
      state: "running",
      headSeq: lines.at(-1)?.seq ?? -1,
      oldestSeq: lines[0]?.seq ?? -1,
      hasMore: false,
      lines: lines.map((l) => ({ seq: l.seq, display: line(l.text), raw: "{}" })),
      ...extra,
    },
  }),
});

async function flush(times = 6) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  resetDataRouter();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("one live connection per tab (ruling 11, TASK-6 / LIVE-5)", () => {
  it("opens no EventSource of its own: the layout's stream carries the console's frames", async () => {
    // CANARY: open an EventSource in the hook again and this reads 2.
    fetchMock.mockResolvedValue(tailOf([{ seq: 0, text: "a" }]));
    render(<Page />, { wrapper: DataRouter });
    expect(FakeEventSource.instances).toHaveLength(1);
    await act(async () => {
      emitFrame(FakeEventSource.last(), "run.log-appended", frame(0));
      await flush();
    });
    expect(texts()).toEqual(["a"]);
  });
});

/**
 * UI-35: the tail had no in-flight guard and no seq dedupe. `headSeq` only
 * advanced AFTER a fetch resolved, and the run sink publishes ONE event per
 * console line, so a chatty run fired several overlapping fetches that each
 * returned the same window — and the append concatenated blindly. Every line
 * showed up 2–3× and the "N events" counter over-counted.
 */
describe("UI-35: run-log tail deduplication", () => {
  it("runs at most one tail fetch per run and drops already-held seqs", async () => {
    let resolveFirst: (response: FakeResponse) => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise<FakeResponse>((resolve) => {
          resolveFirst = resolve;
        }),
    );

    render(<Page />, { wrapper: DataRouter });
    const es = FakeEventSource.last();

    // Two appended lines arrive back-to-back, as the sink really emits them.
    act(() => {
      emitFrame(es, "run.log-appended", frame(0));
      emitFrame(es, "run.log-appended", frame(1));
    });
    // Exactly ONE request — the second event waits for the first read.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst(tailOf([{ seq: 0, text: "a" }, { seq: 1, text: "b" }]));
      await flush();
    });
    expect(texts()).toEqual(["a", "b"]);
    // The read brought both lines, so the second frame asks for nothing more.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A later window that re-sends seq 0..1 plus a new line appends ONLY the
    // new one.
    fetchMock.mockResolvedValue(
      tailOf([
        { seq: 0, text: "a" },
        { seq: 1, text: "b" },
        { seq: 2, text: "c" },
      ]),
    );
    await act(async () => {
      emitFrame(es, "run.log-appended", frame(2));
      await flush();
    });
    expect(texts()).toEqual(["a", "b", "c"]);
  });

  /**
   * LIVE-3: a frame that landed while a read was in flight used to be dropped
   * (`if (inFlight.has(runId)) return`), and only the next frame, or the
   * revalidation that re-seeded the console, brought its line in. The last
   * line of a burst waited up to 2 s for a revalidation.
   */
  it("reads again when a frame announced a line the in-flight read did not bring", async () => {
    let resolveFirst: (response: FakeResponse) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<FakeResponse>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    fetchMock.mockResolvedValueOnce(tailOf([{ seq: 1, text: "b" }]));
    render(<Page />, { wrapper: DataRouter });
    const es = FakeEventSource.last();
    act(() => {
      emitFrame(es, "run.log-appended", frame(0));
      emitFrame(es, "run.log-appended", frame(1));
    });
    await act(async () => {
      // The first read was answered before line 1 was written.
      resolveFirst(tailOf([{ seq: 0, text: "a" }]));
      await flush(12);
    });
    // CANARY: drop the `announced` loop in `tail` and this is 1 fetch, ["a"].
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toContain("since=0");
    expect(texts()).toEqual(["a", "b"]);
    expect(loaderRunCount()).toBe(0);
  });
});

describe("UI-30 / UI-03: the tail says when it stopped", () => {
  it("reports a 404 instead of swallowing it", async () => {
    // F19-28: the route's refusal of a viewer who may not read the run (a
    // member removed while the page is open) is the 404 of a missing run.
    // CANARY: return from `tail` on a refusal without setting the stream
    // error (the swallow UI-30 fixed) and this reads null.
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    render(<Page />, { wrapper: DataRouter });
    await act(async () => {
      emitFrame(FakeEventSource.last(), "run.log-appended", frame(0));
      await flush();
    });
    expect(store.streamError()).toBe("Live tail stopped: the log endpoint returned 404.");
  });
});

/**
 * P13-D-11: the tail cursor was seeded from `lines.length - 1`. That has been
 * wrong since UI-53 concatenated an agent's runs (plus synthetic boundary rows)
 * into ONE console group — an array index is not a run's seq — and a bounded
 * loader window makes it wrong in the other direction too. Seed from
 * `logWindow.headSeq`, the representative run's real max seq.
 */
describe("P13-D-11: the live tail seeds from logWindow.headSeq", () => {
  it("asks ?since= the representative run's max seq, not the row index", async () => {
    // A resumed agent: 30 stored lines across 3 runs + 2 boundaries = 32 rows,
    // while the representative run's newest line is seq 9. The old cursor was
    // 31, so the append guard (`seq <= since`) dropped every real event and the
    // console silently stopped following.
    const rows: LogLine[] = [];
    for (let i = 0; i < 32; i++) {
      rows.push(i === 10 || i === 21 ? runBoundaryLine(2, 3) : line(`row ${i}`));
    }
    fetchMock.mockResolvedValue(tailOf([{ seq: 10, text: "fresh" }], { runId: "run_3" }));

    render(
      <Page
        threads={[
          thread({
            serverRunId: "run_3",
            lines: rows,
            raw: rows.map(() => "{}"),
            logWindow: win({ totalLines: 30, runIds: ["run_1", "run_2", "run_3"], headSeq: 9 }),
          }),
        ]}
      />,
      { wrapper: DataRouter },
    );
    await act(async () => {
      emitFrame(FakeEventSource.last(), "run.log-appended", frame(10, "run_3"));
      await flush();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("since=9");
    expect(texts().at(-1)).toBe("fresh");
  });
});

/**
 * Ruling 11 (TASK-3 / LIVE-3): a revalidation used to re-seed the console
 * from the loader's copy of the window: a second full commit of the page on
 * every open, and, once the window was full, every row rewritten as the
 * index keys shifted. The store keeps what a thread holds unless the thread's
 * representative run changed.
 */
describe("a revalidation keeps what the console holds", () => {
  it("mounting and an identical projection change nothing the console reads", async () => {
    const seeded = thread({ lines: [line("a")], raw: ["{}"], lineKeys: ["0:0"], logWindow: win({ headSeq: 0, totalLines: 1 }) });
    const { rerender } = render(<Page threads={[seeded]} />, { wrapper: DataRouter });
    const before = store.thread("primary");
    let notified = 0;
    const off = store.subscribe(() => (notified += 1));
    // CANARY: re-seed in `reconcile` whatever the thread's run and this is 1.
    rerender(<Page threads={[structuredClone(seeded)]} />);
    await act(async () => flush());
    off();
    expect(notified).toBe(0);
    expect(store.thread("primary")).toBe(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fills a gap past the cursor with one tail read (a missed frame, a tab back from hidden)", async () => {
    const seeded = thread({ lines: [line("a")], raw: ["{}"], lineKeys: ["0:0"], logWindow: win({ headSeq: 0, totalLines: 1 }) });
    const { rerender } = render(<Page threads={[seeded]} />, { wrapper: DataRouter });
    fetchMock.mockResolvedValue(
      tailOf([
        { seq: 1, text: "b" },
        { seq: 2, text: "c" },
      ]),
    );
    // Ruling 25: the reconnect revalidates, and the revalidation says the
    // run's head moved while the tab was away.
    await act(async () => {
      rerender(<Page threads={[thread({ logWindow: win({ headSeq: 2, totalLines: 3, loaded: false }) })]} />);
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("since=0");
    expect(texts()).toEqual(["a", "b", "c"]);
  });

  it("re-seeds a thread whose representative run changed (a resume)", async () => {
    const seeded = thread({ lines: [line("a")], raw: ["{}"], lineKeys: ["0:0"], logWindow: win({ headSeq: 0, totalLines: 1 }) });
    const { rerender } = render(<Page threads={[seeded]} />, { wrapper: DataRouter });
    await act(async () => {
      rerender(
        <Page
          threads={[
            thread({
              serverRunId: "run_2",
              lines: [line("a"), runBoundaryLine(2, 2), line("fresh")],
              raw: ["{}", "", "{}"],
              lineKeys: ["0:0", "1:resumed", "1:0"],
              logWindow: win({ runIds: ["run_1", "run_2"], headSeq: 0, totalLines: 2 }),
            }),
          ]}
        />,
      );
      await flush();
    });
    expect(texts()).toEqual(["a", "── resumed · run 2 of 2 ──", "fresh"]);
  });
});

/**
 * Ruling 300 (TASK-1, owner decision 2): a revalidation or a client navigation
 * carries no console lines, only each thread's window facts; the console fills
 * the thread it shows with ONE request, the window a hard refresh would have
 * shipped.
 */
describe("a thread the page did not carry", () => {
  const unloaded = thread({ logWindow: win({ headSeq: 4, totalLines: 5, loaded: false }) });

  it("loads its window with one request when the console shows it, then follows the tail", async () => {
    render(<Page threads={[unloaded]} />, { wrapper: DataRouter });
    expect(store.thread("primary")?.status).toBe("unloaded");
    // Nothing is asked for a thread nobody looks at.
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          runId: "run_1",
          threadId: "primary",
          lines: [0, 1, 2, 3, 4].map((seq) => line(`l${seq}`)),
          lineKeys: [0, 1, 2, 3, 4].map((seq) => `0:${seq}`),
          logWindow: win({ headSeq: 4, totalLines: 5 }),
          facts: { ...FACTS, step: "Bash · npm test" },
        },
      }),
    });
    await act(async () => {
      store.show("primary");
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/resources/run-log?runId=run_1&window=1");
    expect(texts()).toEqual(["l0", "l1", "l2", "l3", "l4"]);
    expect(store.thread("primary")?.lines.map((l) => l.key)).toEqual(["0:0", "0:1", "0:2", "0:3", "0:4"]);
    expect(store.facts("run_1")?.step).toBe("Bash · npm test");

    // The tail follows from the window's head, without the envelopes.
    fetchMock.mockResolvedValueOnce(tailOf([{ seq: 5, text: "l5" }]));
    await act(async () => {
      emitFrame(FakeEventSource.last(), "run.log-appended", frame(5));
      await flush();
    });
    expect(String(fetchMock.mock.calls[1]![0])).toBe("/resources/run-log?runId=run_1&since=4&raw=0");
    expect(texts().at(-1)).toBe("l5");
  });

  it("says why when the window cannot load", async () => {
    render(<Page threads={[unloaded]} />, { wrapper: DataRouter });
    // CANARY: return from `loadWindow` on a refusal without failing the
    // thread and it reads "loading" for good.
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await act(async () => {
      store.show("primary");
      await flush();
    });
    expect(store.thread("primary")).toMatchObject({
      status: "failed",
      loadError: "Could not load this console: the log endpoint returned 404.",
    });
  });

  it("ruling 153: a load the page's own cleanup aborted is asked again, not failed", async () => {
    // StrictMode, as on the dev server: React rehearses the mount, so the
    // console shows its thread, the page's cleanup disposes the store and
    // aborts that window load, and the console shows the thread again. Here
    // `fetch` answers as a browser's does: a task later, or with an
    // AbortError when its signal aborts first.
    const windowPage: FakeResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          runId: "run_1",
          threadId: "primary",
          lines: [0, 1, 2, 3, 4].map((seq) => line(`l${seq}`)),
          lineKeys: [0, 1, 2, 3, 4].map((seq) => `0:${seq}`),
          logWindow: win({ headSeq: 4, totalLines: 5 }),
          facts: FACTS,
        },
      }),
    };
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<FakeResponse>((resolve, reject) => {
          const { signal } = init;
          if (signal) signals.push(signal);
          const answer = setTimeout(() => resolve(windowPage), 0);
          signal?.addEventListener("abort", () => {
            clearTimeout(answer);
            reject(new DOMException("This operation was aborted", "AbortError"));
          });
        }),
    );
    // At the root, as `entry.client.tsx` mounts it: React rehearses the
    // effects of what mounts inside a StrictMode that is already in place.
    render(
      <StrictMode>
        <DataRouter>
          <Page threads={[unloaded]} shown="primary" />
        </DataRouter>
      </StrictMode>,
    );
    const seen: string[] = [];
    const stop = store.subscribe(() => {
      const view = store.thread("primary");
      seen.push(view?.loadError ?? view?.status ?? "none");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await flush();
    });
    stop();
    // CANARY: let `loadWindow`'s catch fail the thread whatever aborted the
    // request and this reads "Could not load this console: the request
    // failed."; drop only `dispose`'s hand-back and it is one request, the
    // thread left loading.
    expect(seen).not.toContain("Could not load this console: the request failed.");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/resources/run-log?runId=run_1&window=1",
      "/resources/run-log?runId=run_1&window=1",
    ]);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    expect(store.thread("primary")).toMatchObject({ status: "ready", loadError: null });
    expect(texts()).toEqual(["l0", "l1", "l2", "l3", "l4"]);
  });
});

describe("the raw view (ruling 300: envelopes load when it opens)", () => {
  it("fills the shown thread's envelopes with backward pages, and tails with them", async () => {
    render(
      <Page
        threads={[
          thread({
            lines: [line("a"), line("b")],
            raw: [],
            lineKeys: ["0:3", "0:4"],
            logWindow: win({ headSeq: 4, totalLines: 5 }),
          }),
        ]}
      />,
      { wrapper: DataRouter },
    );
    expect(store.thread("primary")?.lines.map((l) => l.raw)).toEqual([null, null]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          runId: "run_1",
          lines: [
            { seq: 3, display: line("a"), raw: '{"n":3}' },
            { seq: 4, display: line("b"), raw: '{"n":4}' },
          ],
          oldestSeq: 3,
          hasMore: true,
          headSeq: 4,
        },
      }),
    });
    await act(async () => {
      store.show("primary");
      store.setRawView(true);
      await flush();
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/resources/run-log?runId=run_1&before=5&limit=2");
    expect(store.thread("primary")?.lines.map((l) => l.raw)).toEqual(['{"n":3}', '{"n":4}']);

    fetchMock.mockResolvedValueOnce(tailOf([{ seq: 5, text: "c" }]));
    await act(async () => {
      emitFrame(FakeEventSource.last(), "run.log-appended", frame(5));
      await flush();
    });
    // With the raw view open the tail asks for the envelopes too.
    expect(String(fetchMock.mock.calls[1]![0])).toBe("/resources/run-log?runId=run_1&since=4");
    expect(store.thread("primary")?.lines.at(-1)?.raw).toBe("{}");
  });
});

describe("the Live run strip's facts (ruling 11, LIVE-1)", () => {
  it("each tail read carries the run row's facts, and the page does not revalidate", async () => {
    render(<Page />, { wrapper: DataRouter });
    expect(store.facts("run_1")).toEqual(FACTS);
    fetchMock.mockResolvedValue(
      tailOf([{ seq: 0, text: "a" }], { facts: { ...FACTS, step: "Edit · app.ts", turns: 2 } }),
    );
    await act(async () => {
      emitFrame(FakeEventSource.last(), "run.log-appended", frame(0));
      await flush();
    });
    expect(store.facts("run_1")).toMatchObject({ step: "Edit · app.ts", turns: 2 });
    expect(loaderRunCount()).toBe(0);
  });
});

// ------------------------------------------------- P13-D-11 backward paging

const page = (lines: { seq: number; text: string }[], hasMore: boolean): FakeResponse => ({
  ok: true,
  json: async () => ({
    data: {
      lines: lines.map((l) => ({ seq: l.seq, display: line(l.text), raw: "{}" })),
      oldestSeq: lines.length ? lines[0]!.seq : -1,
      hasMore,
    },
  }),
});

/** run_a (4 lines) then run_b (6 lines); the window shipped run_b seq 3..5. */
function resumedThread(): ConsoleThreadInput[] {
  return [
    thread({
      serverRunId: "run_b",
      lines: [3, 4, 5].map((seq) => line(`b${seq}`)),
      raw: ["{}", "{}", "{}"],
      lineKeys: [3, 4, 5].map((seq) => `1:${seq}`),
      logWindow: {
        totalLines: 10,
        hasMore: true,
        runIds: ["run_a", "run_b"],
        oldest: { runId: "run_b", seq: 3 },
        headSeq: 5,
      },
    }),
  ];
}

describe("P13-D-11: paging backwards through the withheld history", () => {
  it("reports what the window withheld", () => {
    render(<Page threads={resumedThread()} />, { wrapper: DataRouter });
    expect(store.thread("primary")?.older).toEqual({
      hasMore: true,
      withheld: 7,
      loading: false,
      error: null,
    });
  });

  it("pages within a run, then steps to the previous run and re-creates the boundary", async () => {
    render(<Page threads={resumedThread()} />, { wrapper: DataRouter });

    // Page 1 — `before` the window's oldest line, still inside run_b.
    fetchMock.mockResolvedValue(
      page([{ seq: 0, text: "b0" }, { seq: 1, text: "b1" }, { seq: 2, text: "b2" }], false),
    );
    await act(async () => {
      store.loadOlder("primary");
      await flush();
    });
    const first = String(fetchMock.mock.calls[0]![0]);
    expect(first).toContain("runId=run_b");
    expect(first).toContain("before=3");
    expect(texts()).toEqual(["b0", "b1", "b2", "b3", "b4", "b5"]);
    expect(store.thread("primary")?.older).toMatchObject({ hasMore: true, withheld: 4 });

    // Page 2 — run_b reported `hasMore: false`, so the walk enters run_a with a
    // bare `limit` (its NEWEST page) and marks the boundary above run_b.
    fetchMock.mockResolvedValue(
      page(
        [
          { seq: 0, text: "a0" },
          { seq: 1, text: "a1" },
          { seq: 2, text: "a2" },
          { seq: 3, text: "a3" },
        ],
        false,
      ),
    );
    await act(async () => {
      store.loadOlder("primary");
      await flush();
    });
    const second = String(fetchMock.mock.calls[1]![0]);
    expect(second).toContain("runId=run_a");
    expect(second).not.toContain("before=");
    expect(texts()).toEqual([
      "a0",
      "a1",
      "a2",
      "a3",
      "── resumed · run 2 of 2 ──",
      "b0",
      "b1",
      "b2",
      "b3",
      "b4",
      "b5",
    ]);
    // Every row keeps an identity of its own (ruling 11, LIVE-4).
    const keys = store.thread("primary")!.lines.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[4]).toBe("1:resumed");
    // Ran off the front of the group — the affordance retires.
    expect(store.thread("primary")?.older).toMatchObject({ hasMore: false, withheld: 0 });

    // A further call is a no-op, not another fetch.
    await act(async () => {
      store.loadOlder("primary");
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps walking past a run that has no lines", async () => {
    render(
      <Page
        threads={[
          {
            ...resumedThread()[0]!,
            lineKeys: [3, 4, 5].map((seq) => `2:${seq}`),
            logWindow: {
              totalLines: 10,
              hasMore: true,
              runIds: ["run_a", "run_empty", "run_b"],
              oldest: { runId: "run_b", seq: 3 },
              headSeq: 5,
            },
          },
        ]}
      />,
      { wrapper: DataRouter },
    );
    fetchMock
      .mockResolvedValueOnce(page([], false)) // run_b: already at its start
      .mockResolvedValueOnce(page([], false)) // run_empty: never logged
      .mockResolvedValueOnce(page([{ seq: 0, text: "a0" }], false));
    await act(async () => {
      store.loadOlder("primary");
      await flush(12);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The empty run contributes NO boundary — same rule the projection uses.
    expect(texts()).toEqual(["a0", "── resumed · run 3 of 3 ──", "b3", "b4", "b5"]);
  });

  it("surfaces a failed page instead of silently dropping the click", async () => {
    render(<Page threads={resumedThread()} />, { wrapper: DataRouter });
    // CANARY: return from `loadOlder` on a refusal without failing the page
    // and it reads loading, with no error, for good.
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await act(async () => {
      store.loadOlder("primary");
      await flush();
    });
    expect(store.thread("primary")?.older).toMatchObject({
      hasMore: true,
      loading: false,
      error: "Could not load older lines: the log endpoint returned 404.",
    });
    expect(texts()).toEqual(["b3", "b4", "b5"]);
  });

  it("a loader revalidation does not throw away the pages the reader loaded", async () => {
    const { rerender } = render(<Page threads={resumedThread()} />, { wrapper: DataRouter });
    fetchMock.mockResolvedValue(
      page([{ seq: 0, text: "b0" }, { seq: 1, text: "b1" }, { seq: 2, text: "b2" }], false),
    );
    await act(async () => {
      store.loadOlder("primary");
      await flush();
    });
    expect(texts()).toEqual(["b0", "b1", "b2", "b3", "b4", "b5"]);

    // The task loader revalidates (any `run.state-changed` does) and its window
    // has slid forward — it now starts at seq 4. Re-seeding from it would drop
    // b0..b2 AND open a silent gap at b3.
    fetchMock.mockResolvedValue(tailOf([{ seq: 6, text: "b6" }], { runId: "run_b" }));
    await act(async () => {
      rerender(
        <Page
          threads={[
            thread({
              serverRunId: "run_b",
              lines: [4, 5, 6].map((seq) => line(`b${seq}`)),
              raw: ["{}", "{}", "{}"],
              lineKeys: [4, 5, 6].map((seq) => `1:${seq}`),
              logWindow: {
                totalLines: 11,
                hasMore: true,
                runIds: ["run_a", "run_b"],
                oldest: { runId: "run_b", seq: 4 },
                headSeq: 6,
              },
            }),
          ]}
        />,
      );
      await flush();
    });
    // The head the loader saw is fetched as a gap; nothing is re-seeded.
    expect(texts()).toEqual(["b0", "b1", "b2", "b3", "b4", "b5", "b6"]);
  });
});

/**
 * Ruling 247: the controller channel. A controller conversation's runs have no
 * task scope, so their frames come down the owner's `user` stream as
 * `controller.log-appended`; the console follows the OPEN conversation only.
 */
describe("the controller channel", () => {
  const conversation: RunLogSource = { kind: "controller", conversationId: "cnv_1" };
  const controllerFrame = (over: Partial<ControllerLogAppended> = {}): ControllerLogAppended => ({
    conversationId: "cnv_1",
    userId: "u_owner",
    runId: "run_1",
    threadId: "controller",
    seq: 0,
    ...over,
  });
  const ctlThread = thread({ id: "controller" });

  it("tails the open conversation's frames off the user stream", async () => {
    // Canary: drop the `controller.log-appended` subscription and no line
    // ever arrives.
    fetchMock.mockResolvedValue(tailOf([{ seq: 0, text: "Reading the board." }]));
    render(<Page source={conversation} threads={[ctlThread]} />, { wrapper: DataRouter });
    expect(FakeEventSource.last().url).toBe("/resources/events?scope=user");

    await act(async () => {
      emitFrame(FakeEventSource.last(), "controller.log-appended", controllerFrame());
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/resources/run-log?runId=run_1&since=-1&raw=0");
    expect(texts("controller")).toEqual(["Reading the board."]);
  });

  it("ignores another conversation's frames on the same user stream", async () => {
    // Canary: drop the conversationId comparison and a frame from any thread
    // of this person fetches into the open console.
    fetchMock.mockResolvedValue(tailOf([{ seq: 0, text: "elsewhere" }]));
    render(<Page source={conversation} threads={[ctlThread]} />, { wrapper: DataRouter });
    await act(async () => {
      emitFrame(
        FakeEventSource.last(),
        "controller.log-appended",
        controllerFrame({ conversationId: "cnv_other", runId: "run_9" }),
      );
      await flush();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(texts("controller")).toEqual([]);
  });

  /**
   * CTL-2: the controller page's fallback for a settle the stream missed used
   * to revalidate root, the layout and the page every 5 s of a turn. It reads
   * the turn's tail instead and revalidates once, when the run has ended.
   */
  it("polls the turn's tail while it works, and revalidates once it ended", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    fetchMock.mockResolvedValue(tailOf([], { state: "running", headSeq: -1 }));
    render(
      <Page source={conversation} threads={[ctlThread]} poll={{ runId: "run_1", everyMs: 5_000 }} />,
      { wrapper: DataRouter },
    );
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        vi.advanceTimersByTime(5_000);
        await flush();
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(loaderRunCount()).toBe(0);

    fetchMock.mockResolvedValue(tailOf([], { state: "finished", headSeq: -1 }));
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        vi.advanceTimersByTime(5_000);
        await flush(12);
      });
    }
    // CANARY: revalidate on every poll and this reads 2.
    expect(loaderRunCount()).toBe(1);
  });
});
