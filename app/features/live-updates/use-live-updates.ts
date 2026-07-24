import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import {
  buildEventsUrl,
  SSE_CONTROL_EVENTS,
  SSE_EVENT_NAMES,
} from "./event-types";

/**
 * Live updates (Phase 6): subscribe the current surface to its SSE scopes
 * and revalidate the active React Router loaders when anything relevant
 * changes. No optimistic state, no client caches — revalidation IS the
 * update mechanism (docs/architecture/decisions.md "no optimistic UI for governed state").
 *
 * Revalidations are debounced 300 ms (trailing) so event bursts — a rescan
 * projecting ten tasks, a mutation emitting task + project + notification —
 * coalesce into one loader round-trip.
 *
 * Loop safety: revalidation only re-runs loaders (GETs). Loaders never
 * write files or projections, so they never re-enter the projection
 * emitter — an SSE-triggered revalidation cannot emit further SSE events.
 * The initial `stream.open` hello is also ignored, so merely connecting
 * never revalidates.
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

/** Joins the scope list into one effect-dependency string. Scope ids never
 *  contain whitespace, so a newline is an unambiguous separator. */
const SCOPE_SEPARATOR = "\n";

/** Backoff schedule for re-opening a failed stream (ms). Caps out — after the
 *  last step it keeps retrying at that interval rather than giving up. */
export const SSE_REOPEN_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000] as const;

export interface LiveUpdatesState {
  /** True while the stream is down — the surface is a stale snapshot. */
  paused: boolean;
  /** Re-open immediately (the "retry" affordance next to the paused chip). */
  reconnect: () => void;
}

/**
 * @param scopes scope strings (see `sseScopes` in event-types.ts), e.g.
 *   `["project:viberr-core", "user"]`. Changing the set reconnects.
 */
export function useLiveUpdates(scopes: readonly string[]): LiveUpdatesState {
  const revalidator = useRevalidator();
  const [paused, setPaused] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Latest revalidate without resubscribing per render.
  const revalidateRef = useRef(revalidator.revalidate);
  useEffect(() => {
    revalidateRef.current = revalidator.revalidate;
  });

  const scopeKey = scopes.join(SCOPE_SEPARATOR);
  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (scopeKey === "") return;
    // SSR / jsdom-without-EventSource: live updates are progressive
    // enhancement, silently skip where the platform lacks EventSource.
    if (typeof EventSource === "undefined") return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let reopen: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const scheduleRevalidate = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void revalidateRef.current();
      }, REVALIDATE_DEBOUNCE_MS);
    };

    const source = new EventSource(buildEventsUrl(scopeKey.split(SCOPE_SEPARATOR)));
    for (const name of SSE_EVENT_NAMES) {
      if (!SSE_CONTROL_EVENTS.includes(name)) {
        source.addEventListener(name, scheduleRevalidate);
      }
    }
    source.onopen = () => {
      setPaused(false);
      // A gap in the stream means the surface may have missed events; pull the
      // loaders once on (re)connect so the snapshot is current again.
      if (attempt > 0) scheduleRevalidate();
    };
    source.onerror = () => {
      // readyState CONNECTING = the browser's own retry is running (a transient
      // network drop); CLOSED = the connection FAILED and will never retry.
      if (source.readyState !== EventSource.CLOSED || closed) return;
      setPaused(true);
      const delay =
        SSE_REOPEN_BACKOFF_MS[Math.min(attempt, SSE_REOPEN_BACKOFF_MS.length - 1)]!;
      if (reopen !== null) clearTimeout(reopen);
      reopen = setTimeout(() => {
        reopen = null;
        setAttempt((n) => n + 1);
      }, delay);
    };

    return () => {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      if (reopen !== null) clearTimeout(reopen);
      source.close();
    };
    // `attempt` is the reconnect trigger: bumping it tears the failed stream
    // down and opens a brand-new one (the only thing that recovers a failed
    // EventSource).
  }, [scopeKey, attempt]);

  return { paused, reconnect };
}
