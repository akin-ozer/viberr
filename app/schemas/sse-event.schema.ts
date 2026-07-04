import { z } from "zod";
import { READINESS_VALUES } from "./task-file.schema";

/**
 * SSE wire contract (CONVENTIONS "SSE" rules): event names are lowercase
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
 *   ring buffer window (or a server restart reset the ids) — the client
 *   cannot be caught up by replay and should revalidate once.
 */

export const SSE_EVENT_NAMES = [
  "task.updated",
  "task.removed",
  "task.readiness-changed",
  "project.updated",
  "project.removed",
  "projection.rebuilt",
  "notification.created",
  "violation.updated",
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
    type: z.literal("task.readiness-changed"),
    entityId,
    occurredAt,
    data: z.object({
      projectSlug: slug,
      taskKey,
      stage: z.string().nullable(),
      readiness: z.enum(READINESS_VALUES),
    }),
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
      scope: z.enum(["full", "file"]),
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
    type: z.literal("violation.updated"),
    entityId,
    occurredAt,
    data: z.object({ projectSlug: slug, taskKey: taskKey.nullable() }),
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
