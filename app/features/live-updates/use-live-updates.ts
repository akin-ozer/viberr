import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  buildEventsUrl,
  CONTROLLER_UPDATED_EVENT,
  SSE_CONTROL_EVENTS,
  SSE_CONVERSATION_EVENTS,
  SSE_STREAM_EVENTS,
  SSE_EVENT_NAMES,
  type SseEventName,
} from "./event-types";
import { useLiveLedger } from "./revalidation-policy";

/**
 * Live updates (Phase 6): subscribe the current surface to its SSE scopes
 * and revalidate the active React Router loaders when anything relevant
 * changes. No optimistic state, no client caches — revalidation IS the
 * update mechanism (docs/architecture/decisions.md "no optimistic UI for governed state").
 *
 * Ruling 11: each data event is recorded, the moment it arrives, in the
 * tab's revalidation ledger (`revalidation-policy.ts`), and a debounced flush
 * (300 ms, trailing) revalidates once if a route on screen still owes one of
 * them. An event is owed by the routes that read what it changes (a run's
 * state is not the workspace shell's, a notification is not a task page's),
 * and it is not owed by a route whose data was requested after the event
 * arrived: the echo of the person's own action, published while the action
 * ran, is already in the action's own revalidation once the action answered
 * inside the 300 ms, so the flush finds nothing to do (it waits for a load in
 * flight, not for a slow submission: ruling 11, RV-6). Bursts — a rescan projecting ten tasks, a mutation emitting
 * task + project + notification — still coalesce into one loader round-trip.
 * Stream events (one per console line) revalidate nothing: they go to the
 * tab's run-log consoles through `onLiveFrame`. Conversation events only
 * revalidate a surface that renders a conversation; elsewhere they go,
 * debounced the same way, to the controller dock as `CONTROLLER_UPDATED_EVENT`.
 *
 * Ruling 11 (RF-1): every (re)connect asks the broker to replay what this
 * tab missed since the last event id it saw (`lastEventId` on the URL; the
 * browser's own retry sends the header), so a reconnect revalidates only for
 * events it actually missed, and a deliberate re-scope (opening a task)
 * revalidates nothing. When the buffer cannot reach back that far, the broker
 * answers `stream.resync` and the surface catches up with one revalidation.
 * The document's first stream starts from the position root's middleware read
 * before any loader ran (root's `liveHead`, seeded into the tab's
 * `LiveLedger`), so an event published between the server render and
 * hydration is replayed rather than lost.
 *
 * Loop safety: revalidation only re-runs loaders (GETs). The one loader-side
 * write — R19-15's task-view read-marking — is MONOTONIC (`read_at IS NULL`
 * guard) and emits only when rows actually change, so an SSE-triggered
 * revalidation marks nothing on the second pass and the chain stops there;
 * no other loader writes files or projections. The initial `stream.open`
 * hello only records where the stream stands, so merely connecting never
 * revalidates.
 *
 * UI-03 — DISCONNECT HANDLING. `/resources/events` answers 401 for an expired
 * session, 400 for an invalid scope and 403 for all-foreign scopes. Per the
 * HTML spec an EventSource that receives a non-200 response *fails the
 * connection* and never reconnects, and nothing here used to observe `error` —
 * so a tab left open overnight silently froze the board, rail counts, bell
 * badge and review queue while still looking live. Now:
 *
 *  - a closed stream flips `paused` (a "live updates paused" strip renders under
 *    the header, so the user knows the screen is a snapshot), and
 *  - a fresh EventSource is opened on a bounded exponential backoff, which is
 *    what actually recovers after a re-login (the browser's own retry does not
 *    run for a failed connection).
 */

/** The live flush's debounce. Exported with no importer on purpose, as
 *  `SSE_SESSION_PROBE_AFTER` is: module-local, it grows every route's closure
 *  (root by 11 B gzip, measured against ruling 11's ratchet). */
export const REVALIDATE_DEBOUNCE_MS = 300;

/**
 * Ruling 11 (TASK-6 / LIVE-5): ONE live connection per tab. The run-log
 * console used to open an EventSource of its own on the task scope the
 * layout's stream already held, so a task tab took two of HTTP/1.1's six
 * connections per origin (ruling 25 named merging them "the next cut") and
 * received every console line twice. The console now takes its frames from
 * whichever stream this hook holds, through this registry.
 *
 * A tab holding two streams whose scopes both carry an event (the project
 * controller page: the layout's and the page's own) would hand it over twice,
 * so a frame is handed out once per id and body.
 */
type FrameHandler = (event: MessageEvent<string>) => void;
const frameHandlers = new Map<SseEventName, Set<FrameHandler>>();
const RECENT_FRAMES = 256;
const recentFrames = new Set<string>();

/**
 * Hands `handler` every `name` frame this tab's live stream receives (a stream
 * event: `run.log-appended`, `controller.log-appended`; or, ruling 74, a
 * data event such as `notification.created`, after the ledger has recorded
 * it). Returns the unsubscribe. The stream itself belongs to the surface's `useLiveUpdates`,
 * with everything that implies: closed while the tab is hidden (ruling 25),
 * reopened on a backoff, the frames it missed replayed on every reconnect.
 */
export function onLiveFrame(name: SseEventName, handler: FrameHandler): () => void {
  let handlers = frameHandlers.get(name);
  if (!handlers) {
    handlers = new Set();
    frameHandlers.set(name, handlers);
  }
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

function dispatchFrame(name: SseEventName, event: MessageEvent<string>): void {
  const handlers = frameHandlers.get(name);
  if (!handlers || handlers.size === 0) return;
  // Keyed by id and body. (The id alone would do: the broker's ids are unique
  // across processes, ruling 11, RV-5.)
  if (event.lastEventId) {
    const seen = `${event.lastEventId}|${event.data}`;
    if (recentFrames.has(seen)) return;
    recentFrames.add(seen);
    if (recentFrames.size > RECENT_FRAMES) {
      const oldest = recentFrames.values().next().value;
      if (oldest !== undefined) recentFrames.delete(oldest);
    }
  }
  for (const handler of handlers) handler(event);
}

/**
 * UI-03 for the frames above: a stream of this tab has FAILED (it is
 * reconnecting on its backoff), so a console fed through `onLiveFrame` is not
 * following. The topbar's chip says so for the workspace; the console says it
 * in its own footer, which is where a reader of a frozen console looks.
 */
const failedStreams = new Set<symbol>();
const statusListeners = new Set<() => void>();

function setStreamFailed(stream: symbol, failed: boolean): void {
  const had = failedStreams.has(stream);
  if (failed === had) return;
  if (failed) failedStreams.add(stream);
  else failedStreams.delete(stream);
  for (const listener of statusListeners) listener();
}

function subscribeStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

/** True while a live stream of this tab is down and reconnecting. */
export function useLiveStreamFailed(): boolean {
  return useSyncExternalStore(
    subscribeStatus,
    () => failedStreams.size > 0,
    () => false,
  );
}

/** Joins the scope list into one effect-dependency string. Scope ids never
 *  contain whitespace, so a newline is an unambiguous separator. */
const SCOPE_SEPARATOR = "\n";

/** Backoff schedule for re-opening a failed stream (ms). Caps out — after the
 *  last step it keeps retrying at that interval rather than giving up. */
const SSE_REOPEN_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000] as const;

/**
 * OBS-6 — consecutive failures (with no successful open in between) before the
 * client stops guessing and asks the SERVER what is wrong.
 *
 * A backoff alone cannot fix an EXPIRED SESSION: every reopen 401s, and the
 * schedule above then retries at its cap forever. Live, an owner's overnight tab
 * hammered `/resources/events` with a 401 every couple of seconds indefinitely —
 * the client had no way to tell "the server is briefly unreachable" (retry,
 * correctly) from "this session is gone" (retrying can never succeed).
 *
 * Two, not one: a single failure is the ordinary transient case the first
 * backoff step already handles, and the probe costs a round-trip.
 *
 * Exported with no importer on purpose: exported, the build inlines it at its
 * one use; module-local, it ships as a variable in the shell chunk every route
 * loads, which moves every ruling-11 closure budget (measured for ruling
 * 11; the same reason as `ROUTE_PENDING_DELAY_MS`).
 */
export const SSE_SESSION_PROBE_AFTER = 2;

/**
 * OBS-6 — is the session behind this stream still authenticated?
 *
 * Probes the SAME URL the EventSource just failed on, because its auth
 * semantics are the ones that matter: `/resources/events` answers a plain 401
 * for an expired session (it cannot redirect — an EventSource has no login page
 * to render). The response is never read: `fetch` resolves as soon as the
 * headers land, and the request is aborted immediately, so an authenticated
 * probe costs one short-lived connection rather than a second live stream.
 *
 * Anything that is not a 401 counts as alive — a 500, a proxy error or a dead
 * network say nothing about the session, and refusing to reconnect on those
 * would strand a healthy tab (the very failure this whole file exists to avoid).
 */
async function sessionUnauthenticated(url: string): Promise<boolean> {
  const abort = new AbortController();
  try {
    const res = await fetch(url, {
      signal: abort.signal,
      headers: { Accept: "text/event-stream" },
    });
    abort.abort();
    return res.status === 401;
  } catch {
    // Includes a platform with no `fetch` at all: the call throws inside the
    // try, and "we could not ask" is not evidence the session is gone.
    return false;
  }
}

export interface LiveUpdatesState {
  /** True while the stream is down — the surface is a stale snapshot. */
  paused: boolean;
  /** Re-open immediately (the "Retry" button in the paused strip). */
  reconnect: () => void;
}

export interface LiveUpdatesOptions {
  /**
   * This surface renders a controller conversation (the two controller
   * pages), so a conversation event revalidates it. Everywhere else the
   * event goes to the dock as `CONTROLLER_UPDATED_EVENT` and the page's own
   * loaders stay put (ruling 11, CTL-4).
   */
  conversations?: boolean;
}

/** Hands the dock its cue (see `CONTROLLER_UPDATED_EVENT`). */
function notifyDock(): void {
  window.dispatchEvent(new Event(CONTROLLER_UPDATED_EVENT));
}

/**
 * @param scopes scope strings (see `sseScopes` in event-types.ts), e.g.
 *   `["project:viberr-core", "user"]`. Changing the set reconnects.
 */
export function useLiveUpdates(
  scopes: readonly string[],
  { conversations = false }: LiveUpdatesOptions = {},
): LiveUpdatesState {
  const ledger = useLiveLedger();
  const [paused, setPaused] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // OBS-6: the session behind this stream is gone (a probe said 401), so no
  // reopen can succeed and the loop stops. `paused` stays true — the strip
  // under the header stays, and its Retry calls `reconnect` and clears this.
  const [signedOut, setSignedOut] = useState(false);
  // Ruling 25: a BACKGROUND tab holds no stream. An SSE connection is a
  // permanent one, Viberr is served over HTTP/1.1, and a browser allows about
  // six connections per origin — so four open tabs deadlock the whole app for
  // every tab at once, with no error anywhere. A hidden tab does not need a
  // push; it needs to be correct when you come back, and the reopen below
  // asks the broker for every event it missed meanwhile (ruling 11).
  const [hidden, setHidden] = useState(false);
  // True once ANY stream of this surface's life has opened — the marker that a
  // later `onopen` is a REconnect (scope change or recovery), not the first.
  const everOpenedRef = useRef(false);
  // Ruling 11 (RF-1): the broker event id this surface's streams stand at —
  // the hello's head, then every event after it. A reopen asks the broker to
  // replay from here.
  const positionRef = useRef<number | null>(null);
  // The scopes of this surface's last stream (null before its first).
  const scopesRef = useRef<readonly string[] | null>(null);
  // A dock notice this surface's last stream had not handed over when it
  // closed: its conversation event will not be replayed to the next stream.
  const dockOwedRef = useRef(false);
  // OBS-6: consecutive failures with NO successful open between them. A ref, not
  // state: a successful open must reset the backoff without re-running the
  // effect (whose deps would tear down the stream that just opened).
  const failuresRef = useRef(0);
  // Ruling 11: this surface's marker in the tab's failed-stream set.
  const streamTokenRef = useRef(Symbol("live-stream"));
  useEffect(() => {
    const token = streamTokenRef.current;
    return () => setStreamFailed(token, false);
  }, []);

  const scopeKey = scopes.join(SCOPE_SEPARATOR);
  // The human asked for a retry: forget the 401 verdict and the backoff with it
  // (they may have signed in again in another tab, which is exactly the case
  // this affordance exists for).
  useEffect(() => {
    // SSR and any host without a document: nothing to listen to, and the
    // stream effect's own guards already cover it.
    if (!("document" in globalThis)) return;
    const sync = () => setHidden(document.visibilityState === "hidden");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  const reconnect = useCallback(() => {
    failuresRef.current = 0;
    setSignedOut(false);
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    if (scopeKey === "") return;
    // SSR / jsdom-without-EventSource: live updates are progressive
    // enhancement, silently skip where the host provides no EventSource.
    if (!("EventSource" in globalThis)) return;
    // Ruling 25: hidden means no connection held. The cleanup below closes
    // the stream this tab had, and the effect re-runs on the way back.
    if (hidden) return;
    // OBS-6: a probe proved this session is not authenticated — opening another
    // stream would 401 again, on a loop nothing breaks out of.
    if (signedOut) return;
    // Live updates need the data router the ledger lives on.
    if (!ledger) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let dockTimer: ReturnType<typeof setTimeout> | null = null;
    let reopen: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    // This surface's entry in the tab's failed-stream set (`useLiveStreamFailed`),
    // held across the reopens of one outage the way `paused` is.
    const token = streamTokenRef.current;
    // Ruling 11: the event is in the ledger already (`recordLive` below); the
    // trailing flush revalidates once if a route on screen still owes it.
    const flushNow = () => {
      timer = null;
      ledger.flushLive();
    };
    const scheduleFlush = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flushNow, REVALIDATE_DEBOUNCE_MS);
    };
    const recordLive = (name: SseEventName, event: MessageEvent<string>) => {
      notePosition(event);
      ledger.recordLive(name, event);
      scheduleFlush();
    };
    // Ruling 11 (CTL-4): a conversation event on a surface that renders no
    // conversation is the dock's, debounced the same way (a send publishes
    // five). Where the surface does render one, it revalidates like any other.
    const scheduleDockNotice = () => {
      if (dockTimer !== null) clearTimeout(dockTimer);
      dockTimer = setTimeout(() => {
        dockTimer = null;
        notifyDock();
      }, REVALIDATE_DEBOUNCE_MS);
    };
    // A resync (the broker could not replay what this tab missed) may have
    // lost a conversation event too, and the dock's resources do not ride the
    // revalidation that catches the page up.
    const scheduleCatchUp = () => {
      ledger.recordResync();
      scheduleFlush();
      if (!conversations) scheduleDockNotice();
    };
    // Where this stream stands in the broker's ids. The hello carries the
    // head the connection starts at (the replay that follows is at or below
    // it); every later event moves it on.
    let sawId = false;
    const notePosition = (event: MessageEvent<string>) => {
      if (!/^\d+$/.test(event.lastEventId)) return;
      const id = Number(event.lastEventId);
      sawId = true;
      if (positionRef.current === null || id > positionRef.current) positionRef.current = id;
      if (ledger.position === null || id > ledger.position) ledger.position = id;
    };
    const scopeList = scopeKey.split(SCOPE_SEPARATOR);
    // A surface's first stream starts where the tab stands (the server
    // render's reading, or the stream of the surface before it); a reopen
    // starts where this surface's own streams stood.
    const standing = positionRef.current ?? ledger.position;
    // Ruling 11 (RV-2): a stream that takes on a project, the firehose or the
    // user scope (a slug change, a surface's first stream) cannot trust that
    // position for them: it moved on the old scopes' events only, and can be
    // past one the new scope published after the navigation's loaders read.
    // It opens from the tab's position when those loads were sent instead;
    // what the old scopes delivered since is replayed and recorded once. A
    // task scope brings only its console lines, so opening a task keeps the
    // surface's own position and replays nothing new.
    const previous = scopesRef.current;
    const gains =
      previous === null ||
      scopeList.some((scope) => !scope.startsWith("task:") && !previous.includes(scope));
    scopesRef.current = scopeList;
    const sent = gains ? ledger.positionAtLoad : null;
    const from = standing !== null && sent !== null ? Math.min(standing, sent) : (standing ?? sent);
    const url = buildEventsUrl(scopeList, from);
    const source = new EventSource(url);
    source.addEventListener("stream.open", (event: MessageEvent<string>) => {
      if (!/^\d+$/.test(event.lastEventId)) return;
      const head = Number(event.lastEventId);
      sawId = true;
      // After a restart the head is above where the stream stood (ids are
      // unique across processes, ruling 11, RV-5), and the broker answered
      // the replay with a resync.
      positionRef.current = head;
      ledger.position = head;
    });
    for (const name of SSE_EVENT_NAMES) {
      if (SSE_CONTROL_EVENTS.includes(name)) continue;
      // A stream event (one per console line) revalidates nothing: revalidating
      // on each would turn one run into a loader storm. The tab's consoles take
      // it from here (`onLiveFrame`, ruling 11). A task page used to
      // revalidate root, layout and task every 2 s during a run only to move
      // the Live run strip; the strip now reads the console's own tail.
      if (SSE_STREAM_EVENTS.includes(name)) {
        source.addEventListener(name, (event: MessageEvent<string>) => {
          notePosition(event);
          dispatchFrame(name, event);
        });
        continue;
      }
      if (SSE_CONVERSATION_EVENTS.includes(name) && !conversations) {
        // Ruling 11 (CTL-4): a conversation event on a surface that renders
        // no conversation is the dock's, debounced the same way (a send
        // publishes five).
        source.addEventListener(name, (event: MessageEvent<string>) => {
          notePosition(event);
          scheduleDockNotice();
        });
        continue;
      }
      if (name === "stream.resync") {
        source.addEventListener(name, scheduleCatchUp);
        continue;
      }
      source.addEventListener(name, (event: MessageEvent<string>) => {
        recordLive(name, event);
        // Ruling 74: a data event is handed on too, once per id, to a
        // listener that is not a loader (the root's attention watcher reads
        // `notification.*`). No listener, no work.
        dispatchFrame(name, event);
      });
    }
    source.onopen = () => {
      setPaused(false);
      setStreamFailed(token, false);
      // OBS-6: a real recovery — the next outage starts its backoff from the
      // top, and the session probe is no longer owed.
      failuresRef.current = 0;
      // A gap in the stream means the surface may have missed events. Ruling
      // 11 (RF-1): the connection asked the broker to replay them (`from` on
      // the URL, or the browser's own `Last-Event-ID` when it retries this
      // source), so the replay revalidates for what was missed and nothing
      // else: a scope change (opening a task) and a quiet return from a
      // hidden period pull no loader. Only a reconnect that could not say
      // where it stood (no position was ever known) still pulls once.
      const replayable = from !== null || sawId;
      if ((attempt > 0 || everOpenedRef.current) && !replayable) scheduleCatchUp();
      everOpenedRef.current = true;
    };
    source.onerror = () => {
      // readyState CONNECTING = the browser's own retry is running (a transient
      // network drop); CLOSED = the connection FAILED and will never retry.
      if (source.readyState !== EventSource.CLOSED || closed) return;
      setPaused(true);
      setStreamFailed(token, true);
      // OBS-6: the schedule steps on CONSECUTIVE failures, not on the lifetime
      // attempt count — a stream that recovered and later dropped is a new
      // outage and starts at 2s again, and one that never recovers walks the
      // schedule to its 30s cap instead of hammering at the first step.
      const failures = (failuresRef.current += 1);
      const delay =
        SSE_REOPEN_BACKOFF_MS[
          Math.min(failures - 1, SSE_REOPEN_BACKOFF_MS.length - 1)
        ]!;
      if (reopen !== null) clearTimeout(reopen);
      reopen = setTimeout(() => {
        reopen = null;
        // Under the probe threshold this is the ordinary transient case: just
        // reopen. At or past it, ask whether reconnecting can EVER work — an
        // expired session answers 401 to every attempt, forever, which is the
        // loop OBS-6 caught running overnight.
        if (failures < SSE_SESSION_PROBE_AFTER) {
          setAttempt((n) => n + 1);
          return;
        }
        void sessionUnauthenticated(url).then((gone) => {
          if (closed) return;
          if (gone) setSignedOut(true);
          else setAttempt((n) => n + 1);
        });
      }, delay);
    };

    // The events this stream delivered before the one it replaces closed are
    // in the ledger, and the replay starts after them: a flush still owed from
    // then (a re-scope or a hide inside the 300 ms window) runs now. A flush
    // with nothing owed does nothing.
    scheduleFlush();
    if (dockOwedRef.current) {
      dockOwedRef.current = false;
      scheduleDockNotice();
    }

    return () => {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      if (dockTimer !== null) {
        clearTimeout(dockTimer);
        dockOwedRef.current = true;
      }
      if (reopen !== null) clearTimeout(reopen);
      source.close();
    };
    // `attempt` is the reconnect trigger: bumping it tears the failed stream
    // down and opens a brand-new one (the only thing that recovers a failed
    // EventSource). `signedOut` is the STOP: it re-runs the effect once so the
    // cleanup above closes the dead stream, and the guard at the top keeps it
    // from opening another until `reconnect` clears it.
    // `hidden` is ruling 25's trigger, on both edges: going hidden re-runs the
    // effect so the cleanup closes the connection, coming back opens a fresh
    // one from where the tab stood, and the broker replays what it missed (or
    // resyncs it). `conversations` is fixed per surface.
  }, [scopeKey, attempt, signedOut, hidden, conversations, ledger]);

  return { paused, reconnect };
}
