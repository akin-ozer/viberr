import { useEffect, useRef } from "react";
import { useRevalidator } from "react-router";
import { buildEventsUrl, SSE_CONTROL_EVENTS } from "./event-types";
import { createSseClient } from "./sse-client";

/**
 * Live updates (Phase 6): subscribe the current surface to its SSE scopes
 * and revalidate the active React Router loaders when anything relevant
 * changes. No optimistic state, no client caches — revalidation IS the
 * update mechanism (CONVENTIONS "no optimistic UI for governed state").
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
 */

export const REVALIDATE_DEBOUNCE_MS = 300;

/**
 * @param scopes scope strings (see `sseScopes` in event-types.ts), e.g.
 *   `["project:viberr-core", "user"]`. Changing the set reconnects.
 */
export function useLiveUpdates(scopes: readonly string[]): void {
  const revalidator = useRevalidator();

  // Latest revalidate without resubscribing per render.
  const revalidateRef = useRef(revalidator.revalidate);
  useEffect(() => {
    revalidateRef.current = revalidator.revalidate;
  });

  const scopeKey = scopes.join("\u0000");

  useEffect(() => {
    if (scopeKey === "") return;
    // SSR / jsdom-without-EventSource: live updates are progressive
    // enhancement, silently skip where the platform lacks EventSource.
    if (typeof EventSource === "undefined") return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRevalidate = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void revalidateRef.current();
      }, REVALIDATE_DEBOUNCE_MS);
    };

    const client = createSseClient({
      url: buildEventsUrl(scopeKey.split("\u0000")),
      onEvent: (name) => {
        if (SSE_CONTROL_EVENTS.includes(name)) return;
        scheduleRevalidate();
      },
    });

    return () => {
      if (timer !== null) clearTimeout(timer);
      client.close();
    };
  }, [scopeKey]);
}
