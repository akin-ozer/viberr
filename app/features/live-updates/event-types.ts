import type { SseEventName } from "~/schemas/sse-event.schema";

/**
 * Client-side mirror of the SSE wire contract. The single source of truth
 * is app/schemas/sse-event.schema.ts (shared zod, client-safe) — this
 * module re-exports it plus the URL/scope helpers the client needs, so
 * feature code never imports server modules.
 */

export { SSE_EVENT_NAMES } from "~/schemas/sse-event.schema";
export type { SseEvent, SseEventName } from "~/schemas/sse-event.schema";

/** Control events carry connection bookkeeping, not domain changes — the
 * initial `stream.open` must never trigger a revalidation. */
export const SSE_CONTROL_EVENTS: readonly SseEventName[] = ["stream.open"];

/**
 * Stream events: one reference per console line of a run, consumed by the
 * dedicated log consumer (`useRunLogStream`) and by nothing else. They ride the
 * `user` scope, which every signed-in surface subscribes for its bell, so a
 * surface-wide revalidation per line would refetch Home, a board and the
 * settings page for every tool call of somebody's controller turn.
 * `run.log-appended` is deliberately NOT here: it rides the task scope, which
 * only the surfaces showing that run subscribe, and the task page's counters
 * follow those revalidations.
 */
export const SSE_STREAM_EVENTS: readonly SseEventName[] = ["controller.log-appended"];

export const SSE_ENDPOINT = "/resources/events";

/** Scope strings as the endpoint expects them (`scope=` query params). */
export const sseScopes = {
  user: () => "user" as const,
  /** Every project/task-routed event, any project (Home landing page). */
  allProjects: () => "projects" as const,
  project: (slug: string) => `project:${slug}`,
  task: (slug: string, key: string) => `task:${slug}/${key}`,
};

/** Builds the stream URL for a set of scopes. */
export function buildEventsUrl(scopes: readonly string[]): string {
  const params = scopes
    .map((scope) => `scope=${encodeURIComponent(scope)}`)
    .join("&");
  return `${SSE_ENDPOINT}?${params}`;
}
