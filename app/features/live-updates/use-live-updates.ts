import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { z } from "zod";
import {
  buildEventsUrl,
  CONTROLLER_UPDATED_EVENT,
  SSE_CONTROL_EVENTS,
  SSE_CONVERSATION_EVENTS,
  SSE_RUN_LINE_EVENTS,
  SSE_STREAM_EVENTS,
  SSE_EVENT_NAMES,
  sseScopes,
} from "./event-types";

/**
 * Live updates (Phase 6): subscribe the current surface to its SSE scopes
 * and revalidate the active React Router loaders when anything relevant
 * changes. No optimistic state, no client caches — revalidation IS the
 * update mechanism (docs/architecture/decisions.md "no optimistic UI for governed state").
 *
 * Revalidations are debounced 300 ms (trailing) so event bursts — a rescan
 * projecting ten tasks, a mutation emitting task + project + notification —
 * coalesce into one loader round-trip. Run LINES are the exception: they
 * revalidate only the surface showing that task, at most once per
 * `RUN_LINE_REVALIDATE_MS`, and never push a pending revalidation out.
 * Conversation events are the other (ruling 454): only a surface that renders
 * a conversation revalidates on them; elsewhere they go, debounced the same
 * way, to the controller dock as `CONTROLLER_UPDATED_EVENT`.
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
 * The floor between two revalidations that run LINES cause
 * (`SSE_RUN_LINE_EVENTS`). A line only moves the Live run strip (phase, step,
 * turns, tokens); the console itself tails through `useRunLogStream`, which
 * never waits on this.
 *
 * Measured on a live instance (2026-09-23, the ax-clone board): a Claude run
 * writes ~0.7 lines a second with bursts of 2-3, three quarters of them
 * thinking-token ticks, and one revalidation of a task page is a 1.4 MB payload,
 * ~95 ms of the server's event loop (the one the agents run on) and ~30 ms of the
 * tab's main thread. Debounced only, the lines of a few concurrent runs
 * revalidated every open board and task page of the project two or three times
 * a second; three such pages pushed a trivial request's p90 from 8 ms to 157 ms.
 */
export const RUN_LINE_REVALIDATE_MS = 2_000;

/** The fields of a run-line frame this hook reads, parsed rather than trusted
 *  (`app/schemas/sse-event.schema.ts` is the wire contract). */
const runLineSchema = z.object({
  data: z.object({ projectSlug: z.string(), taskKey: z.string() }),
});

/** The `task:` scope a run-line frame belongs to, or null for a frame that does
 *  not parse (dropped, the way the log consumer drops one). */
function runLineTaskScope(raw: string): string | null {
  try {
    const parsed = runLineSchema.safeParse(JSON.parse(raw));
    return parsed.success
      ? sseScopes.task(parsed.data.data.projectSlug, parsed.data.data.taskKey)
      : null;
  } catch {
    return null;
  }
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
    let lastRevalidateAt = Number.NEGATIVE_INFINITY;
    const revalidateNow = () => {
      timer = null;
      lastRevalidateAt = Date.now();
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
    // A run line JOINS a pending revalidation instead of pushing it out: under a
    // steady stream of lines a trailing debounce would never fire, and each one
    // resetting the clock is how a few runs turned into a loader round-trip
    // every few hundred ms.
    const scheduleRunLineRevalidate = () => {
      if (timer !== null) return;
      const wait = Math.max(
        REVALIDATE_DEBOUNCE_MS,
        lastRevalidateAt + RUN_LINE_REVALIDATE_MS - Date.now(),
      );
      timer = setTimeout(revalidateNow, wait);
    };

    const scopeList = scopeKey.split(SCOPE_SEPARATOR);
    const url = buildEventsUrl(scopeList);
    const source = new EventSource(url);
    for (const name of SSE_EVENT_NAMES) {
      // A stream event (one per console line) is the dedicated log consumer's
      // to handle; revalidating every surface of the person on each would turn
      // one controller turn into a loader storm.
      if (SSE_CONTROL_EVENTS.includes(name) || SSE_STREAM_EVENTS.includes(name)) continue;
      if (SSE_CONVERSATION_EVENTS.includes(name)) {
        source.addEventListener(name, scheduleConversationEvent);
        continue;
      }
      if (name === "stream.resync") {
        source.addEventListener(name, scheduleCatchUp);
        continue;
      }
      if (SSE_RUN_LINE_EVENTS.includes(name)) {
        // Only the surface showing THAT task has anything a line changes. The
        // `project:` scope delivers every run of the project here as well — to
        // the board and to every other open task page — and each of those used
        // to refetch its whole loader per line of somebody else's run.
        source.addEventListener(name, (event: MessageEvent<string>) => {
          const scope = runLineTaskScope(event.data);
          if (scope !== null && scopeList.includes(scope)) scheduleRunLineRevalidate();
        });
        continue;
      }
      source.addEventListener(name, scheduleRevalidate);
    }
    source.onopen = () => {
      setPaused(false);
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
