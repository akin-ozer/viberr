import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { buildEventsUrl, SSE_CONTROL_EVENTS } from "./event-types";
import {
  createSseClient,
  type SseConnectionStatus,
} from "./sse-client";

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

export type LiveUpdateStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "paused"
  | "unavailable";

function visibleStatus(status: SseConnectionStatus): LiveUpdateStatus {
  return status === "closed" ? "unavailable" : status;
}

/**
 * @param scopes scope strings (see `sseScopes` in event-types.ts), e.g.
 *   `["project:viberr-core", "user"]`. Changing the set reconnects.
 */
export function useLiveUpdates(scopes: readonly string[]): LiveUpdateStatus {
  const revalidator = useRevalidator();
  // Stable SSR/client first render. The effect reports unsupported/offline.
  const [status, setStatus] = useState<LiveUpdateStatus>("connecting");

  // Latest revalidate without resubscribing per render.
  const revalidateRef = useRef(revalidator.revalidate);
  revalidateRef.current = revalidator.revalidate;

  const scopeKey = scopes.join("\u0000");

  useEffect(() => {
    if (scopeKey === "") {
      setStatus("unavailable");
      return;
    }
    // SSR / jsdom-without-EventSource: live updates are progressive
    // enhancement, silently skip where the platform lacks EventSource.
    if (typeof EventSource === "undefined") {
      setStatus("unavailable");
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let active = true;
    let offline =
      typeof navigator !== "undefined" && navigator.onLine === false;
    const scheduleRevalidate = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void revalidateRef.current();
      }, REVALIDATE_DEBOUNCE_MS);
    };

    const client = createSseClient({
      url: buildEventsUrl(scopeKey.split("\u0000")),
      onStatus: (next) => {
        if (active) setStatus(offline ? "offline" : visibleStatus(next));
      },
      onEvent: (name) => {
        if (SSE_CONTROL_EVENTS.includes(name)) return;
        scheduleRevalidate();
      },
    });

    const onOffline = () => {
      offline = true;
      if (active) setStatus("offline");
    };
    const onOnline = () => {
      offline = false;
      if (active) setStatus("connecting");
      client.reconnect();
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    if (offline) setStatus("offline");

    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      client.close();
    };
  }, [scopeKey]);

  return status;
}
