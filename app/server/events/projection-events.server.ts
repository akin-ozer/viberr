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
      scope: "full" | "file";
      occurredAt: string;
      /** Number of files whose projection actually changed. */
      changed: number;
    }
  | { type: "notification.created"; userId: string; occurredAt: string };

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

export function emitProjectionEvent(event: ProjectionEvent): void {
  getEmitter().emit(CHANNEL, event);
}

/** Subscribes; returns the unsubscribe function. */
export function onProjectionEvent(
  listener: (event: ProjectionEvent) => void,
): () => void {
  const emitter = getEmitter();
  emitter.on(CHANNEL, listener);
  return () => emitter.off(CHANNEL, listener);
}
