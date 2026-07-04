import type Database from "better-sqlite3";
import type { Readiness } from "~/schemas/task-file.schema";
import { sseEventSchema, type SseEvent } from "~/schemas/sse-event.schema";
import { getDb } from "~/server/db/sqlite.server";
import { logger } from "~/server/logging/logger.server";
import {
  onProjectionEvent,
  type ProjectionEvent,
} from "./projection-events.server";
import { publishSseEvent, type SseRoute } from "./sse-broker.server";

/**
 * Event publisher: subscribes the SSE broker to the phase-3 projection
 * emitter and translates every ProjectionEvent into CONVENTIONS-shaped SSE
 * events (`{ type, entityId, occurredAt, data }`, compact facts only).
 *
 * EVERY mutation source already flows through the emitter — verified:
 * - task actions (comment/owner/transition/resolve/create) end in
 *   `rebuildPath` → `task.updated` (+ `project.updated` on key allocation);
 * - the chokidar watcher calls `rebuildPath` for external file edits;
 * - rescan (`rebuildAll`) emits per-file events + one `projection.rebuilt`
 *   summary; the Home/Board Re-scan buttons call it;
 * - notification fan-out (`createNotification`) emits
 *   `notification.created` with the recipient user id — routed here as a
 *   USER-TARGETED event (only that user's `user`-scoped connections);
 * - Phase-7 scope violations emit `violation.updated`.
 * No mutation path bypasses the emitter, so no direct publish calls are
 * needed. (Phase 8's high-frequency `run.log-appended` should NOT go
 * through the emitter — publish straight to the broker; see the phase-6
 * report.)
 *
 * `task.readiness-changed` is derived here: the emitter only says "task
 * changed", so the publisher reads the projected readiness back and
 * compares it with the last value it saw for that task. First sightings
 * emit no change event (boot rescans would otherwise flood).
 */

export interface TaskFacts {
  stage: string | null;
  readiness: Readiness | null;
}

export interface TranslateContext {
  /** Projected facts for the task, null when the row is gone. */
  taskFacts?: TaskFacts | null;
  /**
   * Readiness the publisher last saw for this task; `undefined` = first
   * sighting (no readiness-changed event), null = seen but row was gone.
   */
  previousReadiness?: Readiness | null | undefined;
}

export interface PublishableEvent {
  event: SseEvent;
  route: SseRoute;
}

/** Pure translation ProjectionEvent → SSE events + routing. */
export function translateProjectionEvent(
  e: ProjectionEvent,
  ctx: TranslateContext = {},
): PublishableEvent[] {
  switch (e.type) {
    case "task.updated": {
      const facts = ctx.taskFacts ?? null;
      const route: SseRoute = { projectSlug: e.projectSlug, taskKey: e.taskKey };
      const entityId = `${e.projectSlug}/${e.taskKey}`;
      const out: PublishableEvent[] = [
        {
          event: {
            type: "task.updated",
            entityId,
            occurredAt: e.occurredAt,
            data: {
              projectSlug: e.projectSlug,
              taskKey: e.taskKey,
              stage: facts?.stage ?? null,
              readiness: facts?.readiness ?? null,
            },
          },
          route,
        },
      ];
      if (
        facts?.readiness &&
        ctx.previousReadiness !== undefined &&
        ctx.previousReadiness !== facts.readiness
      ) {
        out.push({
          event: {
            type: "task.readiness-changed",
            entityId,
            occurredAt: e.occurredAt,
            data: {
              projectSlug: e.projectSlug,
              taskKey: e.taskKey,
              stage: facts.stage ?? null,
              readiness: facts.readiness,
            },
          },
          route,
        });
      }
      return out;
    }
    case "task.removed":
      return [
        {
          event: {
            type: "task.removed",
            entityId: `${e.projectSlug}/${e.taskKey}`,
            occurredAt: e.occurredAt,
            data: { projectSlug: e.projectSlug, taskKey: e.taskKey },
          },
          route: { projectSlug: e.projectSlug, taskKey: e.taskKey },
        },
      ];
    case "project.updated":
    case "project.removed":
      return [
        {
          event: {
            type: e.type,
            entityId: e.projectSlug,
            occurredAt: e.occurredAt,
            data: { projectSlug: e.projectSlug },
          },
          route: { projectSlug: e.projectSlug },
        },
      ];
    case "projection.rebuilt":
      return [
        {
          event: {
            type: "projection.rebuilt",
            entityId: "store",
            occurredAt: e.occurredAt,
            data: { scope: e.scope, changed: e.changed },
          },
          route: { broadcast: true },
        },
      ];
    case "notification.created":
      return [
        {
          event: {
            type: "notification.created",
            entityId: e.userId,
            occurredAt: e.occurredAt,
            data: { userId: e.userId },
          },
          // Targeted: ONLY this user's `user`-scoped connections.
          route: { userId: e.userId },
        },
      ];
    case "violation.updated":
      return [
        {
          event: {
            type: "violation.updated",
            entityId: e.taskKey ? `${e.projectSlug}/${e.taskKey}` : e.projectSlug,
            occurredAt: e.occurredAt,
            data: { projectSlug: e.projectSlug, taskKey: e.taskKey },
          },
          route: {
            projectSlug: e.projectSlug,
            ...(e.taskKey ? { taskKey: e.taskKey } : {}),
          },
        },
      ];
  }
}

export function readTaskFacts(
  db: Database.Database,
  projectSlug: string,
  taskKey: string,
): TaskFacts | null {
  const row = db
    .prepare(
      `SELECT stage, readiness FROM task_projections
       WHERE project_slug = ? AND task_key = ?`,
    )
    .get(projectSlug, taskKey) as
    | { stage: string; readiness: Readiness }
    | undefined;
  return row ? { stage: row.stage, readiness: row.readiness } : null;
}

// -------------------------------------------------------------- lifecycle

interface PublisherState {
  unsubscribe: () => void;
  /** `${slug}/${key}` → last readiness this publisher saw. */
  lastReadiness: Map<string, Readiness>;
}

const PUBLISHER_KEY = Symbol.for("viberr.eventPublisher");

/**
 * Starts the emitter→broker bridge (idempotent, HMR-safe). Called from
 * bootServer(). Uses getDb() lazily so it works before/without any request.
 */
export function startEventPublisher(): void {
  const cache = globalThis as unknown as Record<symbol, PublisherState | undefined>;
  if (cache[PUBLISHER_KEY]) return;

  const lastReadiness = new Map<string, Readiness>();
  const unsubscribe = onProjectionEvent((e) => {
    try {
      const ctx: TranslateContext = {};
      if (e.type === "task.updated") {
        const facts = readTaskFacts(getDb(), e.projectSlug, e.taskKey);
        const cacheKey = `${e.projectSlug}/${e.taskKey}`;
        ctx.taskFacts = facts;
        ctx.previousReadiness = lastReadiness.has(cacheKey)
          ? (lastReadiness.get(cacheKey) ?? null)
          : undefined;
        if (facts?.readiness) lastReadiness.set(cacheKey, facts.readiness);
      } else if (e.type === "task.removed") {
        lastReadiness.delete(`${e.projectSlug}/${e.taskKey}`);
      }
      for (const publishable of translateProjectionEvent(e, ctx)) {
        // Parse before publish: the wire shape is a contract (CONVENTIONS);
        // a malformed event is a bug we want loud in the log, not on clients.
        publishSseEvent(sseEventSchema.parse(publishable.event), publishable.route);
      }
    } catch (error) {
      logger.error("sse publish failed", {
        eventType: e.type,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  });
  cache[PUBLISHER_KEY] = { unsubscribe, lastReadiness };
}

/** Test-only: detach from the emitter and forget readiness state. */
export function stopEventPublisherForTests(): void {
  const cache = globalThis as unknown as Record<symbol, PublisherState | undefined>;
  cache[PUBLISHER_KEY]?.unsubscribe();
  cache[PUBLISHER_KEY] = undefined;
}
