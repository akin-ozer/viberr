import { EventEmitter } from "node:events";

/**
 * Minimal in-process projection event hook (Phase 3). Phase 6 subscribes
 * the SSE broker to this emitter; until then only tests listen.
 *
 * Payloads are compact facts + references — never fat objects
 * (docs/architecture/decisions.md SSE rules; the same shapes feed the SSE payloads later).
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
      scope: "full" | "project";
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
    }
  /** Ruling 503: an epic's projection changed (created, edited, a status
   * set). Project-routed; the Epics pages revalidate. A task joining or
   * leaving an epic is a `task.updated` on that task, since the membership is
   * the task's own field. */
  | {
      type: "epic.updated";
      projectSlug: string;
      epicId: string;
      occurredAt: string;
    };

const EMITTER_KEY = Symbol.for("viberr.projectionEvents");
const CHANNEL = "projection";

/** The single `globalThis` slot this module owns — the emitter survives an HMR
 *  module reload, which a module-level variable would not. */
interface EmitterHost {
  [EMITTER_KEY]?: EventEmitter;
}

function getEmitter(): EventEmitter {
  // SAFETY: `globalThis` carries no index signature, so the symbol slot has to
  // be named to be read at all. `EMITTER_KEY` is module-private and the only
  // write to it in the process is the assignment below, which stores the
  // EventEmitter constructed one line earlier — the slot therefore holds ours
  // or nothing.
  const cache = globalThis as EmitterHost;
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

/** `fn`'s own result plus the events its call buffered, for the caller to
 *  re-emit after the transaction commits. */
export interface CollectedProjectionEvents<T> {
  result: T;
  events: ProjectionEvent[];
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
export function collectProjectionEvents<T>(
  fn: () => T,
): CollectedProjectionEvents<T> {
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
