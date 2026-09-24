import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRevalidator } from "react-router";
import {
  buildEventsUrl,
  CONTROLLER_UPDATED_EVENT,
  SSE_CONTROL_EVENTS,
  SSE_CONVERSATION_EVENTS,
  SSE_STREAM_EVENTS,
  SSE_EVENT_NAMES,
  type SseEventName,
} from "./event-types";

/**
 * Live updates (Phase 6): subscribe the current surface to its SSE scopes
 * and revalidate the active React Router loaders when anything relevant
 * changes. No optimistic state, no client caches — revalidation IS the
 * update mechanism (docs/architecture/decisions.md "no optimistic UI for governed state").
 *
 * Revalidations are debounced 300 ms (trailing) so event bursts — a rescan
 * projecting ten tasks, a mutation emitting task + project + notification —
 * coalesce into one loader round-trip. Stream events (one per console line)
 * revalidate nothing: they go to the tab's run-log consoles through
 * `onLiveFrame` (ruling 454). Conversation events are the other exception
 * (ruling 454): only a surface that renders a conversation revalidates on
 * them; elsewhere they go, debounced the same way, to the controller dock as
 * `CONTROLLER_UPDATED_EVENT`.
 *
 * Loop safety: revalidation only re-runs loaders (GETs). The one loader-side
 * write — R19-15's task-view read-marking — is MONOTONIC (`read_at IS NULL`
 * guard) and emits only when rows actually change, so an SSE-triggered
 * revalidation marks nothing on the second pass and the chain stops there;
 * no other loader writes files or projections. The initial `stream.open`
 * hello is also ignored, so merely connecting never revalidates.
 *
 * UI-03 — DISCONNECT HANDLING. `/resources/events` answers 401 for an expired
 * session, 400 for an invalid scope and 403 for all-foreign scopes. Per the
 * HTML spec an EventSource that receives a non-200 response *fails the
 * connection* and never reconnects, and nothing here used to observe `error` —
 * so a tab left open overnight silently froze the board, rail counts, bell
 * badge and review queue while still looking live. Now:
 *
 *  - a closed stream flips `paused` (the topbar renders a "live updates paused"
 *    chip, so the user knows the screen is a snapshot), and
 *  - a fresh EventSource is opened on a bounded exponential backoff, which is
 *    what actually recovers after a re-login (the browser's own retry does not
 *    run for a failed connection).
 */

export const REVALIDATE_DEBOUNCE_MS = 300;

/**
 * Ruling 454 (TASK-6 / LIVE-5): ONE live connection per tab. The run-log
 * console used to open an EventSource of its own on the task scope the
 * layout's stream already held, so a task tab took two of HTTP/1.1's six
 * connections per origin (ruling 301 named merging them "the next cut") and
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
 * event: `run.log-appended`, `controller.log-appended`). Returns the
 * unsubscribe. The stream itself belongs to the surface's `useLiveUpdates`,
 * with everything that implies: closed while the tab is hidden (ruling 301),
 * reopened on a backoff, a revalidation on every reconnect.
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
  // The broker's ids restart with the process, so an id alone could match a
  // frame from before a restart; the id with the body cannot.
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
export const SSE_REOPEN_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000] as const;

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
  /** Re-open immediately (the "retry" affordance next to the paused chip). */
  reconnect: () => void;
}

export interface LiveUpdatesOptions {
  /**
   * This surface renders a controller conversation (the two controller
   * pages), so a conversation event revalidates it. Everywhere else the
   * event goes to the dock as `CONTROLLER_UPDATED_EVENT` and the page's own
   * loaders stay put (ruling 454, CTL-4).
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
  const revalidator = useRevalidator();
  const [paused, setPaused] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // OBS-6: the session behind this stream is gone (a probe said 401), so no
  // reopen can succeed and the loop stops. `paused` stays true — the topbar
  // keeps its chip, whose retry calls `reconnect` and clears this.
  const [signedOut, setSignedOut] = useState(false);
  // Ruling 301: a BACKGROUND tab holds no stream. An SSE connection is a
  // permanent one, Viberr is served over HTTP/1.1, and a browser allows about
  // six connections per origin — so four open tabs deadlock the whole app for
  // every tab at once, with no error anywhere. A hidden tab does not need a
  // push; it needs to be correct when you come back, and the reopen below
  // already revalidates on any connect that follows a previous stream.
  const [hidden, setHidden] = useState(false);
  // True once ANY stream of this surface's life has opened — the marker that a
  // later `onopen` is a REconnect (scope change or recovery), not the first.
  const everOpenedRef = useRef(false);
  // OBS-6: consecutive failures with NO successful open between them. A ref, not
  // state: a successful open must reset the backoff without re-running the
  // effect (whose deps would tear down the stream that just opened).
  const failuresRef = useRef(0);
  // Ruling 454: this surface's marker in the tab's failed-stream set.
  const streamTokenRef = useRef(Symbol("live-stream"));
  useEffect(() => {
    const token = streamTokenRef.current;
    return () => setStreamFailed(token, false);
  }, []);

  // Latest revalidate without resubscribing per render.
  const revalidateRef = useRef(revalidator.revalidate);
  useEffect(() => {
    revalidateRef.current = revalidator.revalidate;
  });

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
    // Ruling 301: hidden means no connection held. The cleanup below closes
    // the stream this tab had, and the effect re-runs on the way back.
    if (hidden) return;
    // OBS-6: a probe proved this session is not authenticated — opening another
    // stream would 401 again, on a loop nothing breaks out of.
    if (signedOut) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let dockTimer: ReturnType<typeof setTimeout> | null = null;
    let reopen: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    // This surface's entry in the tab's failed-stream set (`useLiveStreamFailed`),
    // held across the reopens of one outage the way `paused` is.
    const token = streamTokenRef.current;
    const revalidateNow = () => {
      timer = null;
      void revalidateRef.current();
    };
    const scheduleRevalidate = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(revalidateNow, REVALIDATE_DEBOUNCE_MS);
    };
    // Ruling 454 (CTL-4): a conversation event on a surface that renders no
    // conversation is the dock's, debounced the same way (a send publishes
    // five). Where the surface does render one, it revalidates like any other.
    const scheduleDockNotice = () => {
      if (dockTimer !== null) clearTimeout(dockTimer);
      dockTimer = setTimeout(() => {
        dockTimer = null;
        notifyDock();
      }, REVALIDATE_DEBOUNCE_MS);
    };
    const scheduleConversationEvent = conversations ? scheduleRevalidate : scheduleDockNotice;
    // A reconnect or a resync may have lost a conversation event too, and the
    // dock's resources do not ride the revalidation that catches the page up.
    const scheduleCatchUp = () => {
      scheduleRevalidate();
      if (!conversations) scheduleDockNotice();
    };
    const scopeList = scopeKey.split(SCOPE_SEPARATOR);
    const url = buildEventsUrl(scopeList);
    const source = new EventSource(url);
    for (const name of SSE_EVENT_NAMES) {
      if (SSE_CONTROL_EVENTS.includes(name)) continue;
      // A stream event (one per console line) revalidates nothing: revalidating
      // on each would turn one run into a loader storm. The tab's consoles take
      // it from here (`onLiveFrame`, ruling 454). A task page used to
      // revalidate root, layout and task every 2 s during a run only to move
      // the Live run strip; the strip now reads the console's own tail.
      if (SSE_STREAM_EVENTS.includes(name)) {
        source.addEventListener(name, (event: MessageEvent<string>) => dispatchFrame(name, event));
        continue;
      }
      if (SSE_CONVERSATION_EVENTS.includes(name)) {
        source.addEventListener(name, scheduleConversationEvent);
        continue;
      }
      if (name === "stream.resync") {
        source.addEventListener(name, scheduleCatchUp);
        continue;
      }
      source.addEventListener(name, scheduleRevalidate);
    }
    source.onopen = () => {
      setPaused(false);
      setStreamFailed(token, false);
      // OBS-6: a real recovery — the next outage starts its backoff from the
      // top, and the session probe is no longer owed.
      failuresRef.current = 0;
      // A gap in the stream means the surface may have missed events; pull the
      // loaders once on any (re)connect that FOLLOWS a previous stream — a
      // failed one (attempt > 0) or a scope change (navigating between tasks
      // re-scopes and reopens the stream, and an event emitted during that
      // teardown/open gap is simply lost; live-proven with R19-15's
      // view-marking emit, fired by the very navigation that re-scoped the
      // stream, leaving the bell badge stale until the next interaction).
      // Only the very first stream of the surface's life stays excluded: its
      // loaders just ran, so a pull would be a redundant round-trip.
      if (attempt > 0 || everOpenedRef.current) scheduleCatchUp();
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

    return () => {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      if (dockTimer !== null) clearTimeout(dockTimer);
      if (reopen !== null) clearTimeout(reopen);
      source.close();
    };
    // `attempt` is the reconnect trigger: bumping it tears the failed stream
    // down and opens a brand-new one (the only thing that recovers a failed
    // EventSource). `signedOut` is the STOP: it re-runs the effect once so the
    // cleanup above closes the dead stream, and the guard at the top keeps it
    // from opening another until `reconnect` clears it.
    // `hidden` is ruling 301's trigger, on both edges: going hidden re-runs the
    // effect so the cleanup closes the connection, coming back opens a fresh
    // one, and `onopen` treats that as the REconnect it is and pulls the
    // loaders once. `conversations` is fixed per surface.
  }, [scopeKey, attempt, signedOut, hidden, conversations]);

  return { paused, reconnect };
}
