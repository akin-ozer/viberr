// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  onLiveFrame,
  REVALIDATE_DEBOUNCE_MS,
  SSE_REOPEN_BACKOFF_MS,
  useLiveStreamFailed,
  useLiveUpdates,
} from "./use-live-updates";
import { CONTROLLER_UPDATED_EVENT } from "./event-types";
import { DataRouter, loaderRunCount, resetDataRouter } from "../../../test-support/data-router";
import { FakeEventSource } from "../../../test-support/fake-event-source";

/** One console line of a task run, as the broker frames it. */
function emitRunLine(source: FakeEventSource, projectSlug: string, taskKey: string, seq: number): void {
  source.emit(
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

let lastPaused = false;
function Probe({ scopes }: { scopes: string[] }) {
  const { paused } = useLiveUpdates(scopes);
  lastPaused = paused;
  return null;
}

/** A surface that renders a controller conversation (the controller pages). */
const CONVERSATION_SCOPES = ["user"];
function ConversationProbe() {
  useLiveUpdates(CONVERSATION_SCOPES, { conversations: true });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", FakeEventSource);
  FakeEventSource.instances = [];
  resetDataRouter();
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

  /**
   * Ruling 301, as ruling 457 (RF-1) carries it out: a returning tab must be
   * correct, so it asks the broker for everything it missed since the last id
   * it saw, and revalidates for what the broker replays. It used to pull every
   * loader on every return, whether anything had happened or not.
   */
  it("ruling 301: coming back asks the broker for what the tab missed, from where it stood", () => {
    const visibility = { current: "visible" };
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility.current,
    });
    render(<Probe scopes={["project:viberr-core"]} />, { wrapper: DataRouter });
    act(() => {
      FakeEventSource.last().onopen?.();
      FakeEventSource.last().emit("stream.open", "42");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS * 2);
    });
    // The first stream of a surface's life never revalidates on open.
    expect(loaderRunCount()).toBe(0);

    act(() => {
      visibility.current = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      visibility.current = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // CANARY: open the returning stream without its position and the broker
    // has nothing to replay from.
    expect(FakeEventSource.last().url).toBe(
      "/resources/events?scope=project%3Aviberr-core&lastEventId=42",
    );
    act(() => {
      FakeEventSource.last().onopen?.();
      FakeEventSource.last().emit("stream.open", "44");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS * 2);
    });
    expect(loaderRunCount(), "nothing was missed, so nothing reloads").toBe(0);

    // What the tab missed while it was away arrives as the broker's replay.
    act(() => {
      FakeEventSource.last().emit("task.updated", "43");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    });
    expect(loaderRunCount(), "a returning tab rendered a stale snapshot").toBe(1);
  });

  it("a reconnect that cannot say where it stood still pulls the loaders once", () => {
    const visibility = { current: "visible" };
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility.current,
    });
    render(<Probe scopes={["project:viberr-core"]} />, { wrapper: DataRouter });
    // No hello and no event ever carried an id.
    act(() => {
      FakeEventSource.last().onopen?.();
    });
    act(() => {
      visibility.current = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      visibility.current = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(FakeEventSource.last().url).toBe("/resources/events?scope=project%3Aviberr-core");
    act(() => {
      FakeEventSource.last().onopen?.();
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS * 2);
    });
    expect(loaderRunCount()).toBe(1);
  });

  it("a stream.resync (the broker could not replay that far back) pulls the loaders once", () => {
    render(<Probe scopes={["project:viberr-core"]} />, { wrapper: DataRouter });
    act(() => {
      FakeEventSource.last().emit("stream.resync", "9");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    });
    expect(loaderRunCount()).toBe(1);
  });

  it("coalesces an event burst into ONE debounced revalidation", async () => {
    render(<Probe scopes={["user"]} />, { wrapper: DataRouter });
    const es = FakeEventSource.last();

    act(() => {
      es.emit("task.updated", "1");
      es.emit("task.updated", "2");
      es.emit("notification.created", "3");
    });
    expect(loaderRunCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS - 1);
    });
    expect(loaderRunCount()).toBe(0);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(loaderRunCount()).toBe(1);

    // A later, separate event revalidates again.
    await act(async () => {
      es.emit("projection.rebuilt", "4");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    });
    expect(loaderRunCount()).toBe(2);
  });

  /**
   * Ruling 457: a flush that finds a load in flight waits for it to land,
   * because that load may already carry the event (the echo of one's own
   * action). It then revalidates only if the event is still owed.
   */
  it("an event that arrives while a revalidation is in flight revalidates once it lands", async () => {
    render(<Probe scopes={["user"]} />, { wrapper: DataRouter });
    const es = FakeEventSource.last();
    act(() => {
      es.emit("task.updated", "1");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    });
    // The first revalidation is in flight (its loader ran; it has not landed).
    expect(loaderRunCount()).toBe(1);
    act(() => {
      es.emit("task.updated", "2");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    });
    expect(loaderRunCount()).toBe(1);
    await act(async () => {
      await Promise.resolve();
    });
    // Received after that load was sent: not in it, so it reloads.
    expect(loaderRunCount()).toBe(2);
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
    expect(loaderRunCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(loaderRunCount()).toBe(1);
  });

  it("ignores the stream.open control hello (connecting must not revalidate)", () => {
    render(<Probe scopes={["user"]} />, { wrapper: DataRouter });
    act(() => {
      FakeEventSource.last().emit("stream.open", "9");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS * 2);
    });
    expect(loaderRunCount()).toBe(0);
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
    expect(loaderRunCount()).toBe(0);
  });

  /**
   * Ruling 457 (CTL-4): a conversation event changes only what shows a
   * conversation. Measured before: one dock send published five of them, and
   * each re-ran every loader of every page the asker had open (Home, a board,
   * a 1.4 MB task page) for a transcript none of them render. The dock is the
   * one thing on those pages that shows it, so it gets the event instead,
   * debounced like a revalidation; the controller pages still revalidate.
   */
  it("hands a conversation event to the dock, unless the surface renders conversations", () => {
    const notices: Event[] = [];
    const listen = (e: Event) => notices.push(e);
    window.addEventListener(CONTROLLER_UPDATED_EVENT, listen);
    try {
      render(<Probe scopes={["user"]} />, { wrapper: DataRouter });
      act(() => {
        // One send's burst.
        for (let i = 0; i < 5; i += 1) FakeEventSource.last().emit("controller.updated", String(i));
        vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
      });
      // CANARY: route `controller.updated` to `scheduleRevalidate` again.
      expect(loaderRunCount()).toBe(0);
      expect(notices).toHaveLength(1);
      cleanup();

      render(<ConversationProbe />, { wrapper: DataRouter });
      act(() => {
        FakeEventSource.last().emit("controller.updated", "11");
        vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
      });
      expect(loaderRunCount()).toBe(1);
      expect(notices).toHaveLength(1);
    } finally {
      window.removeEventListener(CONTROLLER_UPDATED_EVENT, listen);
    }
  });

  /**
   * A run writes a console line every second or so, in bursts of two or three,
   * and the `project:` scope delivers every run of the project to the board and
   * to every open task page. Measured live (ax-clone, 2026-09-23): each line
   * revalidated those surfaces, a task page's revalidation being a 1.4 MB
   * payload and ~95 ms of the server's event loop, the one the agents run on.
   * Nothing on a board or on another task's page changes per line.
   */
  it("a run line revalidates neither the board nor a sibling task page; a domain event still does", () => {
    // The board: project + user, no task open.
    render(<Probe scopes={["project:viberr-core", "user"]} />, { wrapper: DataRouter });
    act(() => {
      for (let seq = 1; seq <= 20; seq += 1) {
        emitRunLine(FakeEventSource.last(), "viberr-core", "VIB-42", seq);
        vi.advanceTimersByTime(100);
      }
      vi.advanceTimersByTime(4_000);
    });
    // CANARY: route `run.log-appended` to `scheduleRevalidate`.
    expect(loaderRunCount(), "the board refetched per console line").toBe(0);
    cleanup();

    // Another task's page: it subscribes the project for its rail, so the
    // frame of a sibling's run reaches it as well.
    render(
      <Probe scopes={["project:viberr-core", "task:viberr-core/VIB-7", "user"]} />,
      { wrapper: DataRouter },
    );
    act(() => {
      emitRunLine(FakeEventSource.last(), "viberr-core", "VIB-42", 21);
      vi.advanceTimersByTime(4_000);
    });
    expect(loaderRunCount(), "a sibling task page refetched per line").toBe(0);
    // Its own domain events still revalidate, as before.
    act(() => {
      FakeEventSource.last().emit("run.state-changed", "23");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    });
    expect(loaderRunCount()).toBe(1);
  });

  /**
   * Ruling 457 (LIVE-1 / RF-2): the task's OWN page does not revalidate on its
   * run's lines either. It used to, floored at one revalidation per 2 s, only
   * to move the Live run strip's phase, step, turns and tokens: root, the
   * layout and the task loader every 2 s of a run (30 loader runs per 20 s in
   * `task-console.perf.test.tsx`). The strip now reads the facts each console
   * tail read returns, and the lines go to the tab's console (below).
   */
  it("the task's own page does not revalidate on its run's lines; a domain event still does", () => {
    render(
      <Probe scopes={["project:viberr-core", "task:viberr-core/VIB-42", "user"]} />,
      { wrapper: DataRouter },
    );
    const es = FakeEventSource.last();
    // CANARY: route `run.log-appended` to `scheduleRevalidate` again.
    act(() => {
      for (let seq = 1; seq <= 42; seq += 1) {
        emitRunLine(es, "viberr-core", "VIB-42", seq);
        vi.advanceTimersByTime(100);
      }
      vi.advanceTimersByTime(4_000);
    });
    expect(loaderRunCount()).toBe(0);
    act(() => {
      es.emit("task.updated", "44");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    });
    expect(loaderRunCount()).toBe(1);
  });

  /**
   * Ruling 457 (TASK-6 / LIVE-5): ONE live connection per tab. The console
   * used to open a second EventSource on the task scope the layout's stream
   * already held (ruling 301 called merging them "the next cut"); it now takes
   * its frames from this hook's stream.
   */
  it("hands the tab's consoles every stream frame, once, whichever stream carried it", () => {
    const seen: string[] = [];
    const off = onLiveFrame("run.log-appended", (event) => seen.push(event.lastEventId));
    try {
      // Two surfaces of one tab whose scopes both carry the frame (the project
      // controller page holds the layout's stream and its own).
      render(
        <>
          <Probe scopes={["project:viberr-core", "task:viberr-core/VIB-42", "user"]} />
          <Probe scopes={["task:viberr-core/VIB-42"]} />
        </>,
        { wrapper: DataRouter },
      );
      const [a, b] = FakeEventSource.instances;
      act(() => {
        emitRunLine(a!, "viberr-core", "VIB-42", 1);
        emitRunLine(b!, "viberr-core", "VIB-42", 1);
        emitRunLine(b!, "viberr-core", "VIB-42", 2);
      });
      // CANARY: drop the id-and-body check in `dispatchFrame`.
      expect(seen).toEqual(["1", "2"]);
    } finally {
      off();
    }
    // Unsubscribed: nothing more reaches the handler.
    act(() => emitRunLine(FakeEventSource.last(), "viberr-core", "VIB-42", 3));
    expect(seen).toEqual(["1", "2"]);
  });

  /**
   * Ruling 481(c): a DATA event reaches a frame listener too (the root's
   * attention watcher re-reads the unread decisions on `notification.*`), once
   * per id, and it still revalidates the routes that read it.
   *
   * Canary: drop the `dispatchFrame` call beside `recordLive` and `seen` stays
   * empty.
   */
  it("hands a data event to a frame listener once, and still revalidates on it (ruling 481)", () => {
    const seen: string[] = [];
    const off = onLiveFrame("notification.created", (event) => seen.push(event.lastEventId));
    try {
      render(
        <>
          <Probe scopes={["user"]} />
          <Probe scopes={["user"]} />
        </>,
        { wrapper: DataRouter },
      );
      const [a, b] = FakeEventSource.instances;
      act(() => {
        a!.emit("notification.created", "7");
        b!.emit("notification.created", "7");
        vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
      });
      expect(seen).toEqual(["7"]);
      expect(loaderRunCount()).toBe(1);
    } finally {
      off();
    }
  });

  it("says when the tab's stream failed, for the console's footer, until it reopens", () => {
    let failed = false;
    function Status() {
      failed = useLiveStreamFailed();
      return null;
    }
    render(
      <>
        <Probe scopes={["project:viberr-core", "user"]} />
        <Status />
      </>,
      { wrapper: DataRouter },
    );
    expect(failed).toBe(false);
    act(() => FakeEventSource.last().fail());
    expect(failed).toBe(true);
    act(() => {
      vi.advanceTimersByTime(SSE_REOPEN_BACKOFF_MS[0]);
    });
    act(() => FakeEventSource.last().onopen?.());
    expect(failed).toBe(false);
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
    expect(loaderRunCount()).toBe(0);
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
   * An event emitted while the stream is torn down and reopened must not be
   * lost. Live-proven with R19-15: navigating to a task fired the
   * view-marking `notification.read` DURING the navigation that re-scopes this
   * very stream, and the bell badge stayed stale until the next interaction.
   * The reopen used to pull every loader to cover that gap, so every task open
   * loaded the task twice (RF-1). Ruling 457: the reopen names the last id the
   * stream saw, the broker replays the gap on the new scopes, and a replayed
   * event revalidates like any other; a gap with nothing in it reloads nothing.
   */
  it("a SCOPE CHANGE reopens from where the stream stood and pulls nothing (ruling 457, RF-1)", () => {
    const { rerender } = render(<Probe scopes={["project:p", "user"]} />, {
      wrapper: DataRouter,
    });
    act(() => {
      FakeEventSource.last().onopen?.();
      FakeEventSource.last().emit("stream.open", "7");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS * 2);
    });
    // First stream of the surface's life: opening must NOT revalidate.
    expect(loaderRunCount()).toBe(0);

    rerender(<Probe scopes={["project:p", "task:p/K-1", "user"]} />);
    expect(FakeEventSource.last().url).toContain("&lastEventId=7");
    act(() => {
      FakeEventSource.last().onopen?.();
      FakeEventSource.last().emit("stream.open", "8");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS * 2);
    });
    expect(loaderRunCount()).toBe(0);

    // The broker replays the gap's notification.read: it reaches the page.
    act(() => {
      FakeEventSource.last().emit("notification.read", "8");
      vi.advanceTimersByTime(REVALIDATE_DEBOUNCE_MS);
    });
    expect(loaderRunCount()).toBe(1);
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
