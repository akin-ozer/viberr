// @vitest-environment jsdom
import { createContext, useContext, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import {
  REVALIDATE_DEBOUNCE_MS,
  SSE_REOPEN_BACKOFF_MS,
  useLiveUpdates,
} from "./use-live-updates";

/**
 * The hook runs under a REAL data router, so `useRevalidator` is React Router's
 * own and a revalidation is observable the way the product sees one: the route
 * loader runs again. `hydrationData` starts the router initialized, so the tree
 * paints synchronously and the initial load is not counted.
 *
 * The subject renders through a context slot rather than as the route's own
 * element, so `rerender` with new props still reaches it.
 */
const SubjectContext = createContext<ReactNode>(null);

function Subject() {
  return <>{useContext(SubjectContext)}</>;
}

let loaderRuns = 0;
let router = makeRouter();

function makeRouter() {
  loaderRuns = 0;
  return createMemoryRouter(
    [
      {
        path: "*",
        Component: Subject,
        loader: () => {
          loaderRuns += 1;
          return null;
        },
      },
    ],
    { hydrationData: { loaderData: { "0": null } } },
  );
}

function DataRouter({ children }: { children: ReactNode }) {
  return (
    <SubjectContext.Provider value={children}>
      <RouterProvider router={router} />
    </SubjectContext.Provider>
  );
}

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
      fn(new MessageEvent<string>(name, { data: "{}", lastEventId }));
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
  router = makeRouter();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useLiveUpdates", () => {
  it("subscribes one EventSource with the scope params", () => {
    render(<Probe scopes={["project:viberr-core", "user"]} />, {
      wrapper: DataRouter,
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.last().url).toBe(
      "/resources/events?scope=project%3Aviberr-core&scope=user",
    );
  });

  it("coalesces an event burst into ONE debounced revalidation", () => {
    render(<Probe scopes={["user"]} />, { wrapper: DataRouter });
    const es = FakeEventSource.last();

    act(() => {
      es.emit("task.updated", "1");
      es.emit("task.updated", "2");
      es.emit("notification.created", "3");
    });
    expect(loaderRuns).toBe(0);

    act(() => {
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS - 1);
    });
    expect(loaderRuns).toBe(0);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(loaderRuns).toBe(1);

    // A later, separate event revalidates again.
    act(() => {
      es.emit("projection.rebuilt", "4");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    });
    expect(loaderRuns).toBe(2);
  });

  it("a fresh event inside the window pushes the trailing edge out", () => {
    render(<Probe scopes={["user"]} />, { wrapper: DataRouter });
    const es = FakeEventSource.last();

    act(() => {
      es.emit("task.updated", "1");
      vi.advanceTimersByTime(200);
      es.emit("task.updated", "2");
      vi.advanceTimersByTime(200);
    });
    // 400 ms elapsed but the second event reset the 300 ms window.
    expect(loaderRuns).toBe(0);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(loaderRuns).toBe(1);
  });

  it("ignores the stream.open control hello (connecting must not revalidate)", () => {
    render(<Probe scopes={["user"]} />, { wrapper: DataRouter });
    act(() => {
      FakeEventSource.last().emit("stream.open", "9");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS * 2);
    });
    expect(loaderRuns).toBe(0);
  });

  it("ignores a stream event: one console line must not refetch every surface", () => {
    // `controller.log-appended` rides the `user` scope, which this hook
    // subscribes on Home, every board and the settings page for the bell. It
    // is the dedicated log consumer's frame; a revalidation here would run all
    // of those loaders once per tool call of a controller turn.
    // Canary: drop the `SSE_STREAM_EVENTS` clause in the listener loop.
    render(<Probe scopes={["user"]} />, { wrapper: DataRouter });
    act(() => {
      FakeEventSource.last().emit("controller.log-appended", "10");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS * 2);
    });
    expect(loaderRuns).toBe(0);
    // The conversation reference beside it still revalidates, as before.
    act(() => {
      FakeEventSource.last().emit("controller.updated", "11");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    });
    expect(loaderRuns).toBe(1);
  });

  it("closes the stream and cancels pending revalidation on unmount", () => {
    const { unmount } = render(<Probe scopes={["user"]} />, { wrapper: DataRouter });
    const es = FakeEventSource.last();
    act(() => {
      es.emit("task.updated", "1");
    });
    unmount();
    expect(es.closed).toBe(true);
    act(() => {
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS * 2);
    });
    expect(loaderRuns).toBe(0);
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
    render(<Probe scopes={["user"]} />, { wrapper: DataRouter });
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
    render(<Probe scopes={["user"]} />, { wrapper: DataRouter });
    const es = FakeEventSource.last();
    act(() => {
      es.readyState = FakeEventSource.CONNECTING;
      es.onerror?.();
    });
    expect(lastPaused).toBe(false);
  });

  it("reconnects when the scope set changes", () => {
    const { rerender } = render(<Probe scopes={["project:p"]} />, { wrapper: DataRouter });
    const first = FakeEventSource.last();
    rerender(<Probe scopes={["project:p", "task:p/K-1"]} />);
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.last().url).toContain("task%3Ap%2FK-1");
  });

  /**
   * An event emitted while the stream is torn down and reopened is simply
   * lost (SSE has no replay here). Live-proven with R19-15: navigating to a
   * task fires the view-marking `notification.read` DURING the navigation
   * that re-scopes this very stream, so the bell badge stayed stale until
   * the next interaction. A (re)connect that follows a previous stream must
   * pull the loaders once; only the very first stream of the surface's life
   * skips the pull (its loaders just ran).
   */
  it("revalidates once when a SCOPE CHANGE reopens the stream (missed-event catch-up)", () => {
    const { rerender } = render(<Probe scopes={["project:p", "user"]} />, {
      wrapper: DataRouter,
    });
    act(() => {
      FakeEventSource.last().onopen?.();
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS * 2);
    });
    // First stream of the surface's life: opening must NOT revalidate.
    expect(loaderRuns).toBe(0);

    rerender(<Probe scopes={["project:p", "task:p/K-1", "user"]} />);
    act(() => {
      FakeEventSource.last().onopen?.();
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS * 2);
    });
    // The reopened stream may have missed events emitted in the gap — one pull.
    expect(loaderRuns).toBe(1);
  });
});

/**
 * OBS-6 (live) — an owner's overnight tab outlived its session and hammered
 * `/resources/events` with a 401 every couple of seconds, indefinitely. The
 * backoff above cannot fix that on its own: an expired session fails EVERY
 * reopen, so the schedule just settles at its cap and retries forever, and no
 * amount of waiting makes a dead session authenticate.
 *
 * So after two consecutive failures the client asks the server which kind of
 * failure this is — a 401 means reconnecting can never work and the loop stops
 * (the paused chip and its retry stay, for the case where the human signs in
 * again). Anything else is treated as transient and keeps retrying, because a
 * 500 or a dropped network says nothing about the session.
 */
describe("useLiveUpdates — OBS-6: a dead session stops the retry loop", () => {
  /** A stubbed `fetch` that answers the session probe with one status. Typed as
   *  the real signature so the asserted call argument is the URL it was given. */
  const answer = (status: number) =>
    vi.fn((...args: Parameters<typeof fetch>) => {
      void args;
      return Promise.resolve(new Response(null, { status }));
    });

  /** Fail the current stream and run its backoff to the reopen. */
  async function failAndWait(step: number) {
    act(() => {
      FakeEventSource.last().fail();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SSE_REOPEN_BACKOFF_MS[step]!);
    });
  }

  it("probes after the second consecutive failure and stops reconnecting on 401", async () => {
    const probe = answer(401);
    vi.stubGlobal("fetch", probe);
    render(<Probe scopes={["user"]} />, { wrapper: DataRouter });

    // First failure: the ordinary transient case — reopen, no probe.
    await failAndWait(0);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(probe).not.toHaveBeenCalled();

    // Second: the client asks whether the session is still there…
    await failAndWait(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(String(probe.mock.calls[0]![0])).toContain("/resources/events");

    // …and the answer is no, so no third stream is ever opened. This is the
    // whole finding: before the probe, this window produced one 401 every two
    // seconds for as long as the tab stayed open.
    expect(FakeEventSource.instances).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    // The surface still says it is a snapshot — stopping is not pretending.
    expect(lastPaused).toBe(true);
  });

  it("keeps retrying when the probe says the session is fine (a server blip)", async () => {
    const probe = answer(500);
    vi.stubGlobal("fetch", probe);
    render(<Probe scopes={["user"]} />, { wrapper: DataRouter });

    await failAndWait(0);
    await failAndWait(1);
    expect(probe).toHaveBeenCalledTimes(1);
    // A 500 is not a verdict on the session: reconnect.
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it("the retry affordance re-opens a stream after the loop has stopped", async () => {
    const probe = answer(401);
    vi.stubGlobal("fetch", probe);
    let reconnectFn: () => void = () => {};
    function RetryProbe() {
      const { paused, reconnect } = useLiveUpdates(["user"]);
      lastPaused = paused;
      reconnectFn = reconnect;
      return null;
    }
    render(<RetryProbe />, { wrapper: DataRouter });

    await failAndWait(0);
    await failAndWait(1);
    expect(FakeEventSource.instances).toHaveLength(2);

    // The human signed in again in another tab and pressed retry.
    act(() => {
      reconnectFn();
    });
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it("a successful open resets the backoff, so a later outage starts over", async () => {
    const probe = answer(401);
    vi.stubGlobal("fetch", probe);
    render(<Probe scopes={["user"]} />, { wrapper: DataRouter });

    await failAndWait(0);
    act(() => {
      FakeEventSource.last().onopen?.();
    });
    // Recovered. The NEXT failure is the first of a new outage: it reopens on
    // the 2s step without probing (a probe here would call the session dead on
    // the strength of one drop).
    await failAndWait(0);
    expect(probe).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(3);
  });
});
