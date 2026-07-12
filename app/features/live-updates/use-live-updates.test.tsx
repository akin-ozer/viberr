// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { REVALIDATE_DEBOUNCE_MS, useLiveUpdates } from "./use-live-updates";

const revalidate = vi.fn(() => Promise.resolve());

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useRevalidator: () => ({ revalidate, state: "idle" as const }),
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
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
  open() {
    this.onopen?.();
  }
  fail() {
    this.onerror?.();
  }
  static last(): FakeEventSource {
    return FakeEventSource.instances.at(-1)!;
  }
}

function Probe({ scopes }: { scopes: string[] }) {
  const status = useLiveUpdates(scopes);
  return <output data-testid="status">{status}</output>;
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

  it("exposes connected and reconnecting transport states", () => {
    render(<Probe scopes={["user"]} />);
    expect(screen.getByTestId("status").textContent).toBe("connecting");

    act(() => FakeEventSource.last().open());
    expect(screen.getByTestId("status").textContent).toBe("connected");

    act(() => FakeEventSource.last().fail());
    expect(screen.getByTestId("status").textContent).toBe("reconnecting");
  });

  it("reports browser offline and reconnects immediately when online", () => {
    render(<Probe scopes={["user"]} />);
    const first = FakeEventSource.last();

    act(() => window.dispatchEvent(new Event("offline")));
    expect(screen.getByTestId("status").textContent).toBe("offline");

    act(() => window.dispatchEvent(new Event("online")));
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(screen.getByTestId("status").textContent).toBe("connecting");
  });

  it("reports unavailable when no scopes can be subscribed", () => {
    render(<Probe scopes={[]} />);
    expect(screen.getByTestId("status").textContent).toBe("unavailable");
    expect(FakeEventSource.instances).toHaveLength(0);
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

  it("reconnects when the scope set changes", () => {
    const { rerender } = render(<Probe scopes={["project:p"]} />);
    const first = FakeEventSource.last();
    rerender(<Probe scopes={["project:p", "task:p/K-1"]} />);
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.last().url).toContain("task%3Ap%2FK-1");
  });
});
