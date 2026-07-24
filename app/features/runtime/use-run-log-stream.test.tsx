// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  useRunLogStream,
  type OlderLogState,
  type StreamedLine,
} from "./use-run-log-stream";
import { runBoundaryLine, type LogLine, type RunLogWindow } from "./runtime-types";

const revalidate = vi.fn(() => Promise.resolve());
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useRevalidator: () => ({ revalidate, state: "idle" as const }),
}));

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, data: unknown) {
    for (const fn of this.listeners.get(name) ?? []) {
      fn({ data: JSON.stringify({ data }) } as MessageEvent<string>);
    }
  }
  static last() {
    return FakeEventSource.instances.at(-1)!;
  }
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

type Thread = {
  threadId: string;
  runId: string | null;
  lines: StreamedLine[];
  window: RunLogWindow;
};

let state: {
  linesByThread: Record<string, StreamedLine[]>;
  streamError: string | null;
  olderByThread: Record<string, OlderLogState>;
  loadOlder: (threadId: string) => void;
};

function Probe({
  enabled = true,
  threads,
}: {
  enabled?: boolean;
  threads?: Thread[];
}) {
  state = useRunLogStream({
    projectSlug: "viberr-core",
    taskKey: "VIB-142",
    threads: threads ?? [
      { threadId: "primary", runId: "run_1", lines: [], window: win() },
    ],
    enabled,
  });
  return null;
}

const texts = () => state.linesByThread.primary!.map((l) => l.display.text);

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
    let resolveFirst: (v: unknown) => void = () => {};
    const body = {
      data: {
        threadId: "primary",
        headSeq: 1,
        lines: [
          { seq: 0, display: line("a"), raw: "{}" },
          { seq: 1, display: line("b"), raw: "{}" },
        ],
      },
    };
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );

    render(<Probe />);
    const es = FakeEventSource.last();

    // Two appended lines arrive back-to-back, as the sink really emits them.
    act(() => {
      es.emit("run.log-appended", {
        projectSlug: "viberr-core",
        taskKey: "VIB-142",
        runId: "run_1",
        threadId: "primary",
        seq: 0,
      });
      es.emit("run.log-appended", {
        projectSlug: "viberr-core",
        taskKey: "VIB-142",
        runId: "run_1",
        threadId: "primary",
        seq: 1,
      });
    });
    // Exactly ONE request — the second event is skipped while the first is in
    // flight (it used to fire a second overlapping fetch).
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({ ok: true, json: async () => body });
      await Promise.resolve();
    });
    expect(state.linesByThread.primary!.map((l) => l.display.text)).toEqual([
      "a",
      "b",
    ]);

    // A later window that re-sends seq 0..1 plus a new line appends ONLY the
    // new one.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          threadId: "primary",
          headSeq: 2,
          lines: [
            { seq: 0, display: line("a"), raw: "{}" },
            { seq: 1, display: line("b"), raw: "{}" },
            { seq: 2, display: line("c"), raw: "{}" },
          ],
        },
      }),
    });
    await act(async () => {
      es.emit("run.log-appended", {
        projectSlug: "viberr-core",
        taskKey: "VIB-142",
        runId: "run_1",
        threadId: "primary",
        seq: 2,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(state.linesByThread.primary!.map((l) => l.display.text)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("UI-30 / UI-03: the tail says when it stopped", () => {
  it("does not open a stream at all when the viewer cannot read logs", () => {
    render(<Probe enabled={false} />);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("reports a 403 instead of swallowing it", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    render(<Probe />);
    const es = FakeEventSource.last();
    await act(async () => {
      es.emit("run.log-appended", {
        projectSlug: "viberr-core",
        taskKey: "VIB-142",
        runId: "run_1",
        threadId: "primary",
        seq: 0,
      });
      await Promise.resolve();
    });
    expect(state.streamError).toMatch(/project-member only/);
  });

  it("reports a permanently closed EventSource", () => {
    render(<Probe />);
    const es = FakeEventSource.last();
    act(() => {
      es.readyState = FakeEventSource.CLOSED;
      es.onerror?.();
    });
    expect(state.streamError).toMatch(/disconnected/);
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
    const rows: StreamedLine[] = [];
    for (let i = 0; i < 32; i++) {
      rows.push(
        i === 10 || i === 21
          ? { display: runBoundaryLine(2, 3), raw: "" }
          : { display: line(`row ${i}`), raw: "{}" },
      );
    }
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          threadId: "primary",
          headSeq: 10,
          lines: [{ seq: 10, display: line("fresh"), raw: "{}" }],
        },
      }),
    });

    render(
      <Probe
        threads={[
          {
            threadId: "primary",
            runId: "run_3",
            lines: rows,
            window: win({
              totalLines: 30,
              runIds: ["run_1", "run_2", "run_3"],
              headSeq: 9,
            }),
          },
        ]}
      />,
    );
    const es = FakeEventSource.last();
    await act(async () => {
      es.emit("run.log-appended", {
        projectSlug: "viberr-core",
        taskKey: "VIB-142",
        runId: "run_3",
        threadId: "primary",
        seq: 10,
      });
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("since=9");
    expect(texts().at(-1)).toBe("fresh");
  });
});

// ------------------------------------------------- P13-D-11 backward paging

const page = (
  lines: { seq: number; text: string }[],
  hasMore: boolean,
) => ({
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
function resumedThread(): Thread[] {
  return [
    {
      threadId: "primary",
      runId: "run_b",
      lines: [3, 4, 5].map((seq) => ({ display: line(`b${seq}`), raw: "{}" })),
      window: {
        totalLines: 10,
        hasMore: true,
        runIds: ["run_a", "run_b"],
        oldest: { runId: "run_b", seq: 3 },
        headSeq: 5,
      },
    },
  ];
}

describe("P13-D-11: paging backwards through the withheld history", () => {
  it("reports what the window withheld", () => {
    render(<Probe threads={resumedThread()} />);
    expect(state.olderByThread.primary).toEqual({
      hasMore: true,
      withheld: 7,
      loading: false,
      error: null,
    });
  });

  it("pages within a run, then steps to the previous run and re-creates the boundary", async () => {
    render(<Probe threads={resumedThread()} />);

    // Page 1 — `before` the window's oldest line, still inside run_b.
    fetchMock.mockResolvedValue(
      page([{ seq: 0, text: "b0" }, { seq: 1, text: "b1" }, { seq: 2, text: "b2" }], false),
    );
    await act(async () => {
      state.loadOlder("primary");
      await Promise.resolve();
      await Promise.resolve();
    });
    const first = String(fetchMock.mock.calls[0]![0]);
    expect(first).toContain("runId=run_b");
    expect(first).toContain("before=3");
    expect(texts()).toEqual(["b0", "b1", "b2", "b3", "b4", "b5"]);
    expect(state.olderByThread.primary).toMatchObject({ hasMore: true, withheld: 4 });

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
      state.loadOlder("primary");
      await Promise.resolve();
      await Promise.resolve();
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
    // Ran off the front of the group — the affordance retires.
    expect(state.olderByThread.primary).toMatchObject({ hasMore: false, withheld: 0 });

    // A further call is a no-op, not another fetch.
    await act(async () => {
      state.loadOlder("primary");
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps walking past a run that has no lines", async () => {
    render(
      <Probe
        threads={[
          {
            ...resumedThread()[0]!,
            window: {
              totalLines: 10,
              hasMore: true,
              runIds: ["run_a", "run_empty", "run_b"],
              oldest: { runId: "run_b", seq: 3 },
              headSeq: 5,
            },
          },
        ]}
      />,
    );
    fetchMock
      .mockResolvedValueOnce(page([], false)) // run_b: already at its start
      .mockResolvedValueOnce(page([], false)) // run_empty: never logged
      .mockResolvedValueOnce(page([{ seq: 0, text: "a0" }], false));
    await act(async () => {
      state.loadOlder("primary");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The empty run contributes NO boundary — same rule the projection uses.
    expect(texts()).toEqual(["a0", "── resumed · run 3 of 3 ──", "b3", "b4", "b5"]);
  });

  it("surfaces a failed page instead of silently dropping the click", async () => {
    render(<Probe threads={resumedThread()} />);
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    await act(async () => {
      state.loadOlder("primary");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(state.olderByThread.primary).toMatchObject({
      hasMore: true,
      loading: false,
      error: "Older lines are project-member only.",
    });
    expect(texts()).toEqual(["b3", "b4", "b5"]);
  });

  it("a loader revalidation does not throw away the pages the reader loaded", async () => {
    const { rerender } = render(<Probe threads={resumedThread()} />);
    fetchMock.mockResolvedValue(
      page([{ seq: 0, text: "b0" }, { seq: 1, text: "b1" }, { seq: 2, text: "b2" }], false),
    );
    await act(async () => {
      state.loadOlder("primary");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(texts()).toEqual(["b0", "b1", "b2", "b3", "b4", "b5"]);

    // The task loader revalidates (any `run.state-changed` does) and its window
    // has slid forward — it now starts at seq 4. Re-seeding from it would drop
    // b0..b2 AND open a silent gap at b3.
    await act(async () => {
      rerender(
        <Probe
          threads={[
            {
              threadId: "primary",
              runId: "run_b",
              lines: [4, 5, 6].map((seq) => ({ display: line(`b${seq}`), raw: "{}" })),
              window: {
                totalLines: 11,
                hasMore: true,
                runIds: ["run_a", "run_b"],
                oldest: { runId: "run_b", seq: 4 },
                headSeq: 6,
              },
            },
          ]}
        />,
      );
    });
    expect(texts()).toEqual(["b0", "b1", "b2", "b3", "b4", "b5"]);
  });
});
