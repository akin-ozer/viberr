import { z } from "zod";
import { READINESS_VALUES } from "./task-file.schema";

/**
 * SSE wire contract (docs/architecture/decisions.md "SSE" rules): event names are lowercase
 * dot-separated facts; every payload is `{ type, entityId, occurredAt,
 * data }` with compact facts + references only — never fat objects.
 * The server publisher zod-parses every event against this schema before
 * it goes on the wire; the client mirrors the types from here
 * (app/features/live-updates/event-types.ts re-exports them).
 *
 * `stream.open` / `stream.resync` are broker CONTROL events (connection
 * bookkeeping, never buffered/replayed):
 * - stream.open: first message on a connection; carries the current head
 *   event id so a client that never receives a data event still resumes
 *   from the right position after a reconnect.
 * - stream.resync: sent when a reconnect's Last-Event-ID predates the
 *   ring buffer window (or an earlier server process: ids are unique across
 *   processes, ruling 454) — the client cannot be caught up by replay and
 *   should revalidate once.
 */

export const SSE_EVENT_NAMES = [
  "task.updated",
  "task.removed",
  "project.updated",
  "project.removed",
  "projection.rebuilt",
  "notification.created",
  "notification.read",
  "violation.updated",
  // F32-2 (pass 32): an org resource changed — a KB re-indexed (the file
  // watcher or a manual re-scan), a KB/skill/MCP saved or deleted. Broadcast,
  // reference-only: the Settings page revalidates its own loader.
  "resource.updated",
  // Phase 8 — high-frequency runtime stream. Published STRAIGHT to the
  // broker from the run-service (NOT the projection emitter): reference-only
  // payloads (runId + seq); the dedicated logs consumer fetches content.
  // `run.state-changed` carries the new lifecycle so the strip/pill flip
  // without a loader round-trip. Both scoped to the task.
  "run.log-appended",
  "run.state-changed",
  // Ruling 99 — controller conversation activity (message appended, turn
  // started/settled). Routed to the conversation OWNER's user-scoped
  // connections only; reference-only, the page revalidates its own loader.
  "controller.updated",
  // The controller's half of the runtime stream: one reference per console
  // line of a controller turn (`project_slug = ''`, so the task-scoped
  // `run.log-appended` cannot carry it). Routed to the conversation OWNER's
  // user-scoped connections; consumed ONLY by the dedicated log consumer
  // (`SSE_STREAM_EVENTS` in event-types.ts keeps it out of the surface-wide
  // revalidation every `user`-scoped page runs on the other names).
  "controller.log-appended",
  // Ruling 99 — a chained goal changed (created, link advanced, redirected).
  // Project-routed like task.updated; the goals panel revalidates.
  "goal.updated",
  "stream.open",
  "stream.resync",
] as const;

export type SseEventName = (typeof SSE_EVENT_NAMES)[number];

const occurredAt = z.iso.datetime();
const entityId = z.string().min(1);
const slug = z.string().min(1);
const taskKey = z.string().min(1);

export const sseEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("task.updated"),
    entityId,
    occurredAt,
    data: z.object({
      projectSlug: slug,
      taskKey,
      // Null when the projection row could not be read back (never expected
      // on the happy path, but the publisher must not invent facts).
      stage: z.string().nullable(),
      readiness: z.enum(READINESS_VALUES).nullable(),
    }),
  }),
  z.object({
    type: z.literal("task.removed"),
    entityId,
    occurredAt,
    data: z.object({ projectSlug: slug, taskKey }),
  }),
  z.object({
    type: z.literal("project.updated"),
    entityId,
    occurredAt,
    data: z.object({ projectSlug: slug }),
  }),
  z.object({
    type: z.literal("project.removed"),
    entityId,
    occurredAt,
    data: z.object({ projectSlug: slug }),
  }),
  z.object({
    type: z.literal("projection.rebuilt"),
    entityId,
    occurredAt,
    data: z.object({
      scope: z.enum(["full", "project"]),
      changed: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    type: z.literal("notification.created"),
    entityId,
    occurredAt,
    // Compact reference only — the recipient revalidates its own inbox.
    data: z.object({ userId: z.string().min(1) }),
  }),
  z.object({
    // Mark-read happened (any tab / packet resolution) — other tabs of the
    // same user revalidate so their bell badge drops without a manual reload.
    type: z.literal("notification.read"),
    entityId,
    occurredAt,
    data: z.object({ userId: z.string().min(1) }),
  }),
  z.object({
    type: z.literal("violation.updated"),
    entityId,
    occurredAt,
    data: z.object({ projectSlug: slug, taskKey: taskKey.nullable() }),
  }),
  z.object({
    type: z.literal("run.log-appended"),
    entityId,
    occurredAt,
    // Compact reference only — the logs consumer fetches lines since `seq`.
    data: z.object({
      projectSlug: slug,
      taskKey,
      runId: z.string().min(1),
      threadId: z.string().min(1),
      /** Highest seq now available for this run. */
      seq: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    type: z.literal("run.state-changed"),
    entityId,
    occurredAt,
    data: z.object({
      projectSlug: slug,
      taskKey,
      runId: z.string().min(1),
      threadId: z.string().min(1),
      state: z.enum(["queued", "running", "finished", "error", "interrupted"]),
    }),
  }),
  z.object({
    type: z.literal("controller.updated"),
    entityId,
    occurredAt,
    // Compact reference only — the conversation surface revalidates.
    data: z.object({
      conversationId: z.string().min(1),
      userId: z.string().min(1),
    }),
  }),
  z.object({
    type: z.literal("controller.log-appended"),
    entityId,
    occurredAt,
    // Compact reference only, like `run.log-appended`: the console fetches the
    // lines since `seq` from `/resources/run-log`, where the owner gate and the
    // output redaction live.
    data: z.object({
      conversationId: z.string().min(1),
      userId: z.string().min(1),
      runId: z.string().min(1),
      threadId: z.string().min(1),
      seq: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    type: z.literal("goal.updated"),
    entityId,
    occurredAt,
    data: z.object({ projectSlug: slug, goalId: z.string().min(1) }),
  }),
  z.object({
    type: z.literal("resource.updated"),
    entityId,
    occurredAt,
    data: z.object({
      kind: z.enum(["kb", "skill", "mcp"]),
      id: z.string().min(1),
    }),
  }),
  z.object({
    type: z.literal("stream.open"),
    entityId,
    occurredAt,
    data: z.object({ headId: z.number().int().nonnegative() }),
  }),
  z.object({
    type: z.literal("stream.resync"),
    entityId,
    occurredAt,
    data: z.object({}),
  }),
]);

export type SseEvent = z.infer<typeof sseEventSchema>;
