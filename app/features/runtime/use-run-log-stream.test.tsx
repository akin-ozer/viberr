// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useRunLogStream, type StreamedLine } from "./use-run-log-stream";
import type { LogLine } from "./runtime-types";

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

let state: { linesByThread: Record<string, StreamedLine[]>; streamError: string | null };

function Probe({ enabled = true }: { enabled?: boolean }) {
  state = useRunLogStream({
    projectSlug: "viberr-core",
    taskKey: "VIB-142",
    threads: [{ threadId: "primary", runId: "run_1", lines: [] }],
    enabled,
  });
  return null;
}

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
