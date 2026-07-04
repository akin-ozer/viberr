import { SSE_EVENT_NAMES, type SseEventName } from "./event-types";

/**
 * EventSource wrapper (Phase 6):
 * - auto-reconnect with jittered exponential backoff. Native EventSource
 *   retry is bypassed (we close on error) because it neither backs off nor
 *   survives fatal responses — instead a NEW EventSource is created, which
 *   means the browser won't re-send `Last-Event-ID`, so the wrapper tracks
 *   the last seen id itself and appends it as `?lastEventId=`;
 * - page-visibility pause/resume: a hidden tab drops its stream (server
 *   resources, browser connection budget); on visible it reconnects
 *   immediately and the broker's ring buffer replays what was missed;
 * - the server's `stream.open` hello carries the current head id as its
 *   `id:` field, so even a connection that never saw a data event resumes
 *   from the right position.
 *
 * All environment touchpoints (EventSource ctor, document, random, delays)
 * are injectable for tests.
 */

export interface SseClientOptions {
  /** Stream URL including scope params (no lastEventId — appended here). */
  url: string;
  /** Called for every named server event (control events included). */
  onEvent: (name: SseEventName, event: MessageEvent<string>) => void;
  eventNames?: readonly SseEventName[];
  createEventSource?: (url: string) => EventSource;
  /** Visibility source; pass null to disable pause/resume (tests). */
  doc?: Document | null;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Jitter source, [0,1). */
  random?: () => number;
}

export interface SseClient {
  close(): void;
  /** Introspection (tests/devtools). */
  readonly lastEventId: string | null;
}

export function createSseClient(options: SseClientOptions): SseClient {
  const eventNames = options.eventNames ?? SSE_EVENT_NAMES;
  const create =
    options.createEventSource ?? ((url: string) => new EventSource(url));
  const doc = options.doc === undefined ? document : options.doc;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 15_000;
  const random = options.random ?? Math.random;

  let es: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  let lastEventId: string | null = null;
  let closed = false;

  const urlWithPosition = () => {
    if (lastEventId === null) return options.url;
    const sep = options.url.includes("?") ? "&" : "?";
    return `${options.url}${sep}lastEventId=${encodeURIComponent(lastEventId)}`;
  };

  const clearTimer = () => {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const teardownSource = () => {
    if (!es) return;
    es.close();
    es = null;
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== null) return;
    if (doc && doc.visibilityState === "hidden") return; // resume reconnects
    // Exponential backoff with 50–150 % jitter so tab herds don't stampede.
    const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempts);
    const delay = Math.round(exp * (0.5 + random()));
    attempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (closed) return;
    teardownSource();
    const source = create(urlWithPosition());
    es = source;
    source.onopen = () => {
      attempts = 0;
    };
    source.onerror = () => {
      if (es !== source) return;
      teardownSource();
      scheduleReconnect();
    };
    for (const name of eventNames) {
      source.addEventListener(name, (raw) => {
        const event = raw as MessageEvent<string>;
        if (event.lastEventId) lastEventId = event.lastEventId;
        options.onEvent(name, event);
      });
    }
  };

  const onVisibilityChange = () => {
    if (closed || !doc) return;
    if (doc.visibilityState === "hidden") {
      clearTimer();
      teardownSource();
    } else if (!es) {
      attempts = 0;
      connect();
    }
  };

  doc?.addEventListener("visibilitychange", onVisibilityChange);
  if (doc && doc.visibilityState === "hidden") {
    // Opened in a background tab — connect on first visibility instead.
  } else {
    connect();
  }

  return {
    close() {
      closed = true;
      clearTimer();
      teardownSource();
      doc?.removeEventListener("visibilitychange", onVisibilityChange);
    },
    get lastEventId() {
      return lastEventId;
    },
  };
}
