// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogLine } from "./runtime-types";
import { useRunLogStream, type StreamedLine } from "./use-run-log-stream";

const revalidate = vi.fn(() => Promise.resolve());

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useRevalidator: () => ({ revalidate, state: "idle" as const }),
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (event: MessageEvent<string>) => void) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  close() {
    this.closed = true;
  }

  emit(name: string, data: unknown) {
    const event = {
      data: JSON.stringify({ data }),
      lastEventId: "",
    } as MessageEvent<string>;
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  static last(): FakeEventSource {
    return FakeEventSource.instances.at(-1)!;
  }
}

function streamed(text: string): StreamedLine {
  return {
    display: { t: "12:00", ev: "text", tag: "assistant", text },
    raw: JSON.stringify({ text }),
  };
}

function response(lines: { seq: number; text: string }[], headSeq: number) {
  return new Response(
    JSON.stringify({
      data: {
        threadId: "primary",
        headSeq,
        lines: lines.map(({ seq, text }) => ({
          seq,
          display: {
            t: "12:00",
            ev: "text",
            tag: "assistant",
            text,
          } satisfies LogLine,
          raw: JSON.stringify({ seq, text }),
        })),
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function appended(seq: number) {
  return {
    projectSlug: "viberr",
    taskKey: "VIB-1",
    runId: "run_1",
    threadId: "primary",
    seq,
  };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  revalidate.mockClear();
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useRunLogStream", () => {
  it("serializes a burst and appends a sorted, sequence-deduped suffix", async () => {
    const pending = deferredResponse();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(pending.promise);
    const { result } = renderHook(() =>
      useRunLogStream({
        projectSlug: "viberr",
        taskKey: "VIB-1",
        threads: [{ threadId: "primary", runId: "run_1", lines: [streamed("zero")] }],
      }),
    );

    act(() => {
      FakeEventSource.last().emit("run.log-appended", appended(2));
      FakeEventSource.last().emit("run.log-appended", appended(1));
      FakeEventSource.last().emit("run.log-appended", appended(2));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toContain("since=0");

    await act(async () => {
      pending.resolve(
        response(
          [
            { seq: 2, text: "two-first-copy" },
            { seq: 1, text: "one" },
            { seq: 2, text: "two" },
            { seq: 0, text: "stale-zero" },
          ],
          2,
        ),
      );
      await pending.promise;
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.linesByThread.primary?.map((line) => line.display.text)).toEqual([
      "zero",
      "one",
      "two",
    ]);
  });

  it("queues a higher announced seq and fetches it after the current tail", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() =>
      useRunLogStream({
        projectSlug: "viberr",
        taskKey: "VIB-1",
        threads: [{ threadId: "primary", runId: "run_1", lines: [streamed("zero")] }],
      }),
    );

    act(() => {
      FakeEventSource.last().emit("run.log-appended", appended(1));
      FakeEventSource.last().emit("run.log-appended", appended(3));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve(response([{ seq: 1, text: "one" }], 1));
      await first.promise;
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toContain("since=1");

    await act(async () => {
      second.resolve(
        response(
          [
            { seq: 2, text: "two" },
            { seq: 3, text: "three" },
          ],
          3,
        ),
      );
      await second.promise;
      await Promise.resolve();
    });
    expect(result.current.linesByThread.primary?.map((line) => line.display.text)).toEqual([
      "zero",
      "one",
      "two",
      "three",
    ]);
  });

  it("aborts and ignores a stale request when loader backfill re-seeds the thread", async () => {
    const pending = deferredResponse();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(
      ({ lines }: { lines: StreamedLine[] }) =>
        useRunLogStream({
          projectSlug: "viberr",
          taskKey: "VIB-1",
          threads: [{ threadId: "primary", runId: "run_1", lines }],
        }),
      { initialProps: { lines: [streamed("zero")] } },
    );

    act(() => FakeEventSource.last().emit("run.log-appended", appended(1)));
    const signal = (fetchMock.mock.calls[0]![1] as RequestInit).signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    // Same line count, different loader evidence: the seed fingerprint must
    // still invalidate the request (length-only keys miss this race).
    rerender({ lines: [streamed("loader-zero-replaced")] });
    expect(signal.aborted).toBe(true);
    await act(async () => {
      pending.resolve(response([{ seq: 1, text: "stale-network-one" }], 1));
      await pending.promise;
      await Promise.resolve();
    });

    expect(result.current.linesByThread.primary?.map((line) => line.display.text)).toEqual([
      "loader-zero-replaced",
    ]);
  });

  it("aborts an in-flight tail and closes SSE on unmount", () => {
    const pending = deferredResponse();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(pending.promise);
    const { unmount } = renderHook(() =>
      useRunLogStream({
        projectSlug: "viberr",
        taskKey: "VIB-1",
        threads: [{ threadId: "primary", runId: "run_1", lines: [streamed("zero")] }],
      }),
    );
    const source = FakeEventSource.last();
    act(() => source.emit("run.log-appended", appended(1)));
    const signal = (fetchMock.mock.calls[0]![1] as RequestInit).signal as AbortSignal;

    unmount();
    expect(signal.aborted).toBe(true);
    expect(source.closed).toBe(true);
  });

  it("keeps lifecycle changes loader-owned", () => {
    renderHook(() =>
      useRunLogStream({
        projectSlug: "viberr",
        taskKey: "VIB-1",
        threads: [],
      }),
    );
    act(() => {
      FakeEventSource.last().emit("run.state-changed", {
        projectSlug: "viberr",
        taskKey: "VIB-1",
        runId: "run_1",
        threadId: "primary",
        state: "done",
      });
    });
    expect(revalidate).toHaveBeenCalledTimes(1);
  });
});
