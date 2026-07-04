import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSseClient } from "./sse-client";

/**
 * Minimal EventSource stand-in: records instances + registered listeners,
 * exposes emit/open/error helpers.
 */
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
  emit(name: string, data: string, lastEventId = "") {
    for (const fn of this.listeners.get(name) ?? []) {
      fn({ data, lastEventId } as MessageEvent<string>);
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

function makeClient(overrides: Partial<Parameters<typeof createSseClient>[0]> = {}) {
  return createSseClient({
    url: "/resources/events?scope=user",
    onEvent: () => {},
    createEventSource: (url) =>
      new FakeEventSource(url) as unknown as EventSource,
    doc: null,
    baseDelayMs: 1000,
    maxDelayMs: 15000,
    random: () => 0.5, // jitter factor exactly 1.0 → deterministic delays
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createSseClient", () => {
  it("connects immediately and delivers named events", () => {
    const seen: string[] = [];
    makeClient({ onEvent: (name) => seen.push(name) });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.last().url).toBe("/resources/events?scope=user");

    FakeEventSource.last().emit("task.updated", "{}", "3");
    FakeEventSource.last().emit("stream.open", "{}", "3");
    expect(seen).toEqual(["task.updated", "stream.open"]);
  });

  it("reconnects with exponential backoff + jitter and lastEventId param", () => {
    const client = makeClient();
    const first = FakeEventSource.last();
    first.open();
    first.emit("task.updated", "{}", "7");

    first.fail();
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);

    // attempt 0 → base 1000 ms × jitter 1.0.
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.last().url).toBe(
      "/resources/events?scope=user&lastEventId=7",
    );

    // Second consecutive failure → 2000 ms.
    FakeEventSource.last().fail();
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);

    // A successful open resets the backoff.
    FakeEventSource.last().open();
    FakeEventSource.last().fail();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(4);

    client.close();
  });

  it("caps the backoff at maxDelayMs", () => {
    makeClient({ baseDelayMs: 1000, maxDelayMs: 4000 });
    for (let i = 0; i < 6; i += 1) {
      FakeEventSource.last().fail();
      vi.advanceTimersByTime(4000); // cap × jitter 1.0
    }
    // Every retry fired within the cap.
    expect(FakeEventSource.instances.length).toBe(7);
  });

  it("applies jitter to the delay", () => {
    makeClient({ random: () => 0 }); // factor 0.5 → 500 ms
    FakeEventSource.last().fail();
    vi.advanceTimersByTime(499);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("tracks lastEventId from any received event (incl. stream.open hello)", () => {
    const client = makeClient();
    FakeEventSource.last().emit("stream.open", '{"headId":12}', "12");
    expect(client.lastEventId).toBe("12");

    FakeEventSource.last().fail();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.last().url).toContain("lastEventId=12");
    client.close();
  });

  it("close() stops reconnecting", () => {
    const client = makeClient();
    FakeEventSource.last().fail();
    client.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  describe("page visibility pause/resume", () => {
    function fakeDoc(initial: "visible" | "hidden" = "visible") {
      const listeners: (() => void)[] = [];
      return {
        visibilityState: initial as string,
        addEventListener: (_: string, fn: () => void) => listeners.push(fn),
        removeEventListener: () => {},
        setVisibility(state: "visible" | "hidden") {
          this.visibilityState = state;
          for (const fn of listeners) fn();
        },
      };
    }

    it("hidden closes the stream; visible reconnects immediately", () => {
      const doc = fakeDoc();
      const client = makeClient({ doc: doc as unknown as Document });
      const first = FakeEventSource.last();
      first.emit("task.updated", "{}", "5");

      doc.setVisibility("hidden");
      expect(first.closed).toBe(true);

      doc.setVisibility("visible");
      expect(FakeEventSource.instances).toHaveLength(2);
      // Resumes from the tracked position → ring buffer replays the gap.
      expect(FakeEventSource.last().url).toContain("lastEventId=5");
      client.close();
    });

    it("no reconnect timers fire while hidden", () => {
      const doc = fakeDoc();
      const client = makeClient({ doc: doc as unknown as Document });
      doc.setVisibility("hidden");
      FakeEventSource.last().fail(); // error on the (already closed) source
      vi.advanceTimersByTime(60_000);
      expect(FakeEventSource.instances).toHaveLength(1);
      client.close();
    });
  });
});
