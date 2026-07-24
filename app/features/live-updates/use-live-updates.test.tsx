// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  REVALIDATE_DEBOUNCE_MS,
  SSE_REOPEN_BACKOFF_MS,
  useLiveUpdates,
} from "./use-live-updates";

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
  url: string;
  closed = false;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  /** Simulate the browser FAILING the connection (a non-200 response — an
   *  expired session 401s — never retries per spec). */
  fail() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
  addEventListener(name: string, fn: (e: MessageEvent<string>) => void) {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, lastEventId = "") {
    for (const fn of this.listeners.get(name) ?? []) {
      fn({ data: "{}", lastEventId } as MessageEvent<string>);
    }
  }
  static last(): FakeEventSource {
    return FakeEventSource.instances.at(-1)!;
  }
}

let lastPaused = false;
function Probe({ scopes }: { scopes: string[] }) {
  const { paused } = useLiveUpdates(scopes);
  lastPaused = paused;
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", FakeEventSource);
  FakeEventSource.instances = [];
  revalidate.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useLiveUpdates", () => {
  it("subscribes one EventSource with the scope params", () => {
    render(<Probe scopes={["project:viberr-core", "user"]} />);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.last().url).toBe(
      "/resources/events?scope=project%3Aviberr-core&scope=user",
    );
  });

  it("coalesces an event burst into ONE debounced revalidation", () => {
    render(<Probe scopes={["user"]} />);
    const es = FakeEventSource.last();

    act(() => {
      es.emit("task.updated", "1");
      es.emit("task.updated", "2");
      es.emit("notification.created", "3");
    });
    expect(revalidate).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS - 1);
    });
    expect(revalidate).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(revalidate).toHaveBeenCalledTimes(1);

    // A later, separate event revalidates again.
    act(() => {
      es.emit("projection.rebuilt", "4");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    });
    expect(revalidate).toHaveBeenCalledTimes(2);
  });

  it("a fresh event inside the window pushes the trailing edge out", () => {
    render(<Probe scopes={["user"]} />);
    const es = FakeEventSource.last();

    act(() => {
      es.emit("task.updated", "1");
      vi.advanceTimersByTime(200);
      es.emit("task.updated", "2");
      vi.advanceTimersByTime(200);
    });
    // 400 ms elapsed but the second event reset the 300 ms window.
    expect(revalidate).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it("ignores the stream.open control hello (connecting must not revalidate)", () => {
    render(<Probe scopes={["user"]} />);
    act(() => {
      FakeEventSource.last().emit("stream.open", "9");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS * 2);
    });
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("closes the stream and cancels pending revalidation on unmount", () => {
    const { unmount } = render(<Probe scopes={["user"]} />);
    const es = FakeEventSource.last();
    act(() => {
      es.emit("task.updated", "1");
    });
    unmount();
    expect(es.closed).toBe(true);
    act(() => {
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS * 2);
    });
    expect(revalidate).not.toHaveBeenCalled();
  });

  /**
   * UI-03: nothing observed `error`, and per the HTML spec an EventSource that
   * receives a non-200 response FAILS the connection and never reconnects. A
   * board tab left open overnight outlived its session, the stream 401'd once,
   * and from then on the board, rail counts, bell badge and review queue were
   * frozen with no banner, no toast and no "reconnecting" state — while looking
   * like live governance state.
   */
  it("reports a failed stream as paused and re-opens a FRESH one on backoff", () => {
    render(<Probe scopes={["user"]} />);
    const first = FakeEventSource.last();
    expect(lastPaused).toBe(false);

    act(() => {
      first.fail();
    });
    expect(lastPaused).toBe(true);
    // Still one connection — the browser does not retry a failed one.
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(SSE_REOPEN_BACKOFF_MS[0]!);
    });
    // A brand-new EventSource — the only thing that recovers after a re-login.
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(first.closed).toBe(true);

    act(() => {
      FakeEventSource.last().onopen?.();
    });
    expect(lastPaused).toBe(false);
  });

  it("a transient error while the browser is still retrying does not pause", () => {
    render(<Probe scopes={["user"]} />);
    const es = FakeEventSource.last();
    act(() => {
      es.readyState = FakeEventSource.CONNECTING;
      es.onerror?.();
    });
    expect(lastPaused).toBe(false);
  });

  it("reconnects when the scope set changes", () => {
    const { rerender } = render(<Probe scopes={["project:p"]} />);
    const first = FakeEventSource.last();
    rerender(<Probe scopes={["project:p", "task:p/K-1"]} />);
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.last().url).toContain("task%3Ap%2FK-1");
  });
});
