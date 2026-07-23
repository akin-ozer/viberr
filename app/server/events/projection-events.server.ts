import { EventEmitter } from "node:events";

/**
 * Minimal in-process projection event hook (Phase 3). Phase 6 subscribes
 * the SSE broker to this emitter; until then only tests listen.
 *
 * Payloads are compact facts + references — never fat objects
 * (CONVENTIONS SSE rules; the same shapes feed the SSE payloads later).
 */

export type ProjectionEvent =
  | {
      type: "task.updated";
      projectSlug: string;
      taskKey: string;
      occurredAt: string;
    }
  | {
      type: "task.removed";
      projectSlug: string;
      taskKey: string;
      occurredAt: string;
    }
  | { type: "project.updated"; projectSlug: string; occurredAt: string }
  | { type: "project.removed"; projectSlug: string; occurredAt: string }
  | {
      type: "projection.rebuilt";
      scope: "full" | "file" | "project";
      occurredAt: string;
      /** Number of files whose projection actually changed. */
      changed: number;
    }
  | { type: "notification.created"; userId: string; occurredAt: string }
  /** Some of this user's notifications were marked read — other tabs
   * revalidate so the bell badge drops everywhere at once. */
  | { type: "notification.read"; userId: string; occurredAt: string }
  /** Phase 7: a scope violation was opened or resolved (rail badge,
   * GitHub view, Settings card and Activity all revalidate on it). */
  | {
      type: "violation.updated";
      projectSlug: string;
      taskKey: string | null;
      occurredAt: string;
    };

const EMITTER_KEY = Symbol.for("viberr.projectionEvents");
const CHANNEL = "projection";

function getEmitter(): EventEmitter {
  const cache = globalThis as unknown as Record<symbol, EventEmitter | undefined>;
  let emitter = cache[EMITTER_KEY];
  if (!emitter) {
    emitter = new EventEmitter();
    emitter.setMaxListeners(100); // many SSE subscribers later
    cache[EMITTER_KEY] = emitter;
  }
  return emitter;
}

// Active collection buffer (see collectProjectionEvents). Module-local is
// fine: node:sqlite transactions are synchronous, so a collection window
// can never interleave with another request's emissions.
let collectBuffer: ProjectionEvent[] | null = null;

export function emitProjectionEvent(event: ProjectionEvent): void {
  if (collectBuffer) {
    collectBuffer.push(event);
    return;
  }
  getEmitter().emit(CHANNEL, event);
}

/**
 * Runs `fn` with projection-event emission DEFERRED: every
 * emitProjectionEvent call inside is buffered and returned instead of being
 * delivered. Used by write transactions (rebuildProjections) so SSE
 * subscribers never observe an event for state that has not committed yet —
 * the caller re-emits the returned events after commit. Nested collections
 * buffer into the innermost collector. If `fn` throws, buffered events are
 * DISCARDED (the transaction rolled back, so nothing actually changed).
 */
export function collectProjectionEvents<T>(fn: () => T): {
  result: T;
  events: ProjectionEvent[];
} {
  const parent = collectBuffer;
  const events: ProjectionEvent[] = [];
  collectBuffer = events;
  try {
    const result = fn();
    return { result, events };
  } finally {
    collectBuffer = parent;
  }
}

/** Subscribes; returns the unsubscribe function. */
export function onProjectionEvent(
  listener: (event: ProjectionEvent) => void,
): () => void {
  const emitter = getEmitter();
  emitter.on(CHANNEL, listener);
  return () => emitter.off(CHANNEL, listener);
}
