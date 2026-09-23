// @vitest-environment jsdom
import { createContext, useContext, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import {
  REVALIDATE_DEBOUNCE_MS,
  RUN_LINE_REVALIDATE_MS,
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
  emit(name: string, lastEventId = "", data = "{}") {
    for (const fn of this.listeners.get(name) ?? []) {
      fn(new MessageEvent<string>(name, { data, lastEventId }));
    }
  }
  /** One console line of a task run, as the broker frames it. */
  emitRunLine(projectSlug: string, taskKey: string, seq: number) {
    this.emit(
      "run.log-appended",
      String(seq),
      JSON.stringify({
        type: "run.log-appended",
        entityId: `${projectSlug}/${taskKey}`,
        occurredAt: "2026-09-23T12:00:00.000Z",
        data: { projectSlug, taskKey, runId: "run_1", threadId: "thr_1", seq },
      }),
    );
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

  /**
   * Ruling 301 (pass 37, F37-136). An SSE connection is a permanent one, this
   * app is served over HTTP/1.1, and a browser allows about six per origin. A
   * task page holds two streams, so FOUR open tabs exhaust the pool and every
   * request from every tab queues forever: loaders never resolve, a submitted
   * form's button stays busy, and nothing anywhere says why. Measured live
   * against the running instance: one tab 21ms, two tabs 10ms, four tabs still
   * hung after 300s while the same endpoint answered curl in 12ms, and closing
   * tabs recovered it.
   */
  it("ruling 301: a hidden tab holds NO connection, and gets one back when it returns", () => {
    const visibility = { current: "visible" };
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility.current,
    });
    render(<Probe scopes={["project:viberr-core", "user"]} />, { wrapper: DataRouter });
    expect(FakeEventSource.instances).toHaveLength(1);
    const first = FakeEventSource.last();
    expect(first.closed).toBe(false);

    // CANARY: drop the `hidden` guard and the connection is still held.
    act(() => {
      visibility.current = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(first.closed, "a background tab kept its connection").toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);

    // Coming back opens a fresh one: the tab is live again, not stuck closed.
    // CANARY: leave `hidden` out of the effect's deps.
    act(() => {
      visibility.current = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.last().closed).toBe(false);
  });

  it("ruling 301: coming back pulls the loaders, because the tab missed every event while it was away", () => {
    const visibility = { current: "visible" };
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility.current,
    });
    render(<Probe scopes={["project:viberr-core"]} />, { wrapper: DataRouter });
    act(() => {
      FakeEventSource.last().onopen?.();
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS * 2);
    });
    // The first stream of a surface's life never revalidates on open.
    expect(loaderRuns).toBe(0);

    act(() => {
      visibility.current = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      visibility.current = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // The reopen is a RECONNECT, and a reconnect already means "you may have
    // missed events". CANARY: make the reopen look like a first connect.
    act(() => {
      FakeEventSource.last().onopen?.();
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS * 2);
    });
    expect(loaderRuns, "a returning tab rendered a stale snapshot").toBe(1);
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

  /**
   * A run writes a console line every second or so, in bursts of two or three,
   * and the `project:` scope delivers every run of the project to the board and
   * to every open task page. Measured live (ax-clone, 2026-09-23): each line
   * revalidated those surfaces, a task page's revalidation being a 1.4 MB
   * payload and ~95 ms of the server's event loop, the one the agents run on.
   * Nothing on a board or on another task's page changes per line.
   */
  it("a run line never revalidates a surface that is not showing that task", () => {
    // The board: project + user, no task open.
    render(<Probe scopes={["project:viberr-core", "user"]} />, { wrapper: DataRouter });
    act(() => {
      for (let seq = 1; seq <= 20; seq += 1) {
        FakeEventSource.last().emitRunLine("viberr-core", "VIB-42", seq);
        vi.advanceTimersByTime(100);
      }
      vi.advanceTimersByTime(RUN_LINE_REVALIDATE_MS * 2);
    });
    // CANARY: drop the scope check in the run-line listener.
    expect(loaderRuns, "the board refetched per console line").toBe(0);
    cleanup();

    // Another task's page: it subscribes the project for its rail, so the
    // frame of a sibling's run reaches it as well.
    render(
      <Probe scopes={["project:viberr-core", "task:viberr-core/VIB-7", "user"]} />,
      { wrapper: DataRouter },
    );
    act(() => {
      FakeEventSource.last().emitRunLine("viberr-core", "VIB-42", 21);
      // A frame that does not parse is dropped, not treated as a match.
      FakeEventSource.last().emit("run.log-appended", "22", "not json");
      vi.advanceTimersByTime(RUN_LINE_REVALIDATE_MS * 2);
    });
    expect(loaderRuns, "a sibling task page refetched per line").toBe(0);
    // Its own domain events still revalidate, as before.
    act(() => {
      FakeEventSource.last().emit("run.state-changed", "23");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    });
    expect(loaderRuns).toBe(1);
  });

  it("the task's own page revalidates on its run's lines at most once per RUN_LINE_REVALIDATE_MS, and a steady stream cannot starve it", () => {
    render(
      <Probe scopes={["project:viberr-core", "task:viberr-core/VIB-42", "user"]} />,
      { wrapper: DataRouter },
    );
    const es = FakeEventSource.last();
    // The first line after a quiet spell shows on the ordinary debounce.
    act(() => {
      es.emitRunLine("viberr-core", "VIB-42", 1);
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    });
    expect(loaderRuns).toBe(1);

    // A line every 100 ms for 4.1 s: a trailing debounce would never fire;
    // this fires once per floor. CANARY: make a line reset the pending timer
    // (`scheduleRevalidate`) and this stays at 1.
    act(() => {
      for (let seq = 2; seq <= 42; seq += 1) {
        es.emitRunLine("viberr-core", "VIB-42", seq);
        vi.advanceTimersByTime(100);
      }
    });
    // CANARY: drop the floor (`lastRevalidateAt + RUN_LINE_REVALIDATE_MS`) and
    // this reads 14.
    expect(loaderRuns).toBe(3);

    // A domain event does not wait behind the floor.
    act(() => {
      es.emitRunLine("viberr-core", "VIB-42", 43);
      es.emit("task.updated", "44");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    });
    expect(loaderRuns).toBe(4);
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
