import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { READINESS_VALUES, type Readiness } from "~/schemas/task-file.schema";
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
 * emitter and translates every ProjectionEvent into the SSE shape
 * docs/architecture/decisions.md fixes
 * events (`{ type, entityId, occurredAt, data }`, compact facts only).
 *
 * EVERY mutation source already flows through the emitter — verified:
 * - task actions (comment/owner/transition/resolve/create) end in
 *   `rebuildPath` → `task.updated` (+ `project.updated` on key allocation);
 * - the file watcher calls `rebuildPath` for external edits;
 * - rescan (`rebuildAll`) emits per-file events + one `projection.rebuilt`
 *   summary; the Home/Board Re-scan buttons call it;
 * - notification fan-out (`createNotification`) emits
 *   `notification.created` with the recipient user id — routed here as a
 *   USER-TARGETED event (only that user's `user`-scoped connections);
 *   mark-read emits the matching `notification.read` the same way;
 * - Phase-7 scope violations emit `violation.updated`.
 * No mutation path bypasses the emitter, so no direct publish calls are
 * needed. (Phase 8's high-frequency `run.log-appended` should NOT go
 * through the emitter — publish straight to the broker; see the phase-6
 * report.)
 */

export interface TaskFacts {
  stage: string | null;
  readiness: Readiness | null;
}

export interface TranslateContext {
  /** Projected facts for the task, null when the row is gone. */
  taskFacts?: TaskFacts | null;
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
      return [
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
    case "notification.read":
      return [
        {
          event: {
            type: e.type,
            entityId: e.userId,
            occurredAt: e.occurredAt,
            data: { userId: e.userId },
          },
          // Targeted: ONLY this user's `user`-scoped connections.
          route: { userId: e.userId },
        },
      ];
    case "violation.updated": {
      // A project-scoped violation carries no task key: the route must stay
      // project-wide rather than name an empty task.
      const route: SseRoute = { projectSlug: e.projectSlug };
      if (e.taskKey) route.taskKey = e.taskKey;
      return [
        {
          event: {
            type: "violation.updated",
            entityId: e.taskKey ? `${e.projectSlug}/${e.taskKey}` : e.projectSlug,
            occurredAt: e.occurredAt,
            data: { projectSlug: e.projectSlug, taskKey: e.taskKey },
          },
          route,
        },
      ];
    }
  }
}

/** The two projected columns this publisher reads back, parsed at the DB
 *  boundary: `stage` and `readiness` are both NOT NULL in the baseline schema
 *  and `readiness` carries a CHECK over exactly `READINESS_VALUES`, so a row
 *  that fails this parse is a corrupt projection — the publisher's caller logs
 *  it rather than putting an invented fact on the wire. */
const taskFactsRowSchema = z.object({
  stage: z.string(),
  readiness: z.enum(READINESS_VALUES),
});

export function readTaskFacts(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
): TaskFacts | null {
  const row = db
    .prepare(
      `SELECT stage, readiness FROM task_projections
       WHERE project_slug = ? AND task_key = ?`,
    )
    .get(projectSlug, taskKey);
  return row ? taskFactsRowSchema.parse(row) : null;
}

// -------------------------------------------------------------- lifecycle

interface PublisherState {
  unsubscribe: () => void;
}

const PUBLISHER_KEY = Symbol.for("viberr.eventPublisher");

/** The single `globalThis` slot this module owns — the subscription survives an
 *  HMR module reload, which a module-level variable would not. */
interface PublisherHost {
  [PUBLISHER_KEY]?: PublisherState;
}

function publisherHost(): PublisherHost {
  // SAFETY: `PUBLISHER_KEY` is a registry symbol under a viberr-namespaced name
  // that only `startEventPublisher` / `stopEventPublisherForTests` below read or
  // write, so the slot holds either the state they put there or nothing at all.
  return globalThis as PublisherHost;
}

/**
 * Starts the emitter→broker bridge (idempotent, HMR-safe). Called from
 * bootServer(). Uses getDb() lazily so it works before/without any request.
 */
export function startEventPublisher(): void {
  const cache = publisherHost();
  if (cache[PUBLISHER_KEY]) return;

  const unsubscribe = onProjectionEvent((e) => {
    try {
      const ctx: TranslateContext = {};
      if (e.type === "task.updated") {
        ctx.taskFacts = readTaskFacts(getDb(), e.projectSlug, e.taskKey);
      }
      for (const publishable of translateProjectionEvent(e, ctx)) {
        // Parse before publish: the wire shape is a contract
        // (docs/architecture/decisions.md);
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
  cache[PUBLISHER_KEY] = { unsubscribe };
}

/** Test-only: detach from the emitter. */
export function stopEventPublisherForTests(): void {
  const cache = publisherHost();
  cache[PUBLISHER_KEY]?.unsubscribe();
  cache[PUBLISHER_KEY] = undefined;
}
