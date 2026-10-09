import type { SseEventName } from "~/schemas/sse-event.schema";

/**
 * Client-side mirror of the SSE wire contract. The single source of truth
 * is app/schemas/sse-event.schema.ts (shared zod, client-safe) — this
 * module re-exports it plus the URL/scope helpers the client needs, so
 * feature code never imports server modules.
 */

export { SSE_EVENT_NAMES } from "~/schemas/sse-event.schema";
export type { SseEventName } from "~/schemas/sse-event.schema";

/** Control events carry connection bookkeeping, not domain changes — the
 * initial `stream.open` must never trigger a revalidation. */
export const SSE_CONTROL_EVENTS: readonly SseEventName[] = ["stream.open"];

/**
 * Stream events: one reference per console line of a run, consumed by the
 * run-log console (`useRunLogStream`, through `onLiveFrame`) and by nothing
 * else, so no surface revalidates on them. `controller.log-appended` rides the
 * `user` scope every signed-in surface subscribes for its bell;
 * `run.log-appended` reaches only a connection holding its task's scope (ruling
 * 300, LIVE-5). The task page used to revalidate root, layout and task on its
 * own run's lines every 2 s to move the Live run strip; the strip now reads the
 * facts each tail fetch returns (ruling 11, LIVE-1).
 */
export const SSE_STREAM_EVENTS: readonly SseEventName[] = [
  "controller.log-appended",
  "run.log-appended",
];

/**
 * Conversation events (ruling 11, CTL-4): a controller conversation changed —
 * a message landed, a turn started or settled. Only the two controller pages
 * render a conversation, so only they revalidate on it (`useLiveUpdates`'s
 * `conversations` option). Everywhere else the one thing that shows a
 * conversation is the dock, which reloads its own two resources when the
 * stream hands it {@link CONTROLLER_UPDATED_EVENT}. One dock send publishes five
 * of these, and each used to re-run every loader of every page the asker had
 * open, none of which render a word of it.
 */
export const SSE_CONVERSATION_EVENTS: readonly SseEventName[] = ["controller.updated"];

/** The window event a live stream dispatches, debounced, for a conversation
 *  event (and for a reconnect or resync, which may have missed one) on a
 *  surface that does not render conversations: the dock's cue to reload. */
export const CONTROLLER_UPDATED_EVENT = "viberr:controller-updated";

const SSE_ENDPOINT = "/resources/events";

/** Scope strings as the endpoint expects them (`scope=` query params). */
export const sseScopes = {
  user: () => "user" as const,
  /** Every project/task-routed event, any project (Home landing page). */
  allProjects: () => "projects" as const,
  project: (slug: string) => `project:${slug}`,
  task: (slug: string, key: string) => `task:${slug}/${key}`,
};

/**
 * Builds the stream URL for a set of scopes. `lastEventId` is where this tab
 * stands in the broker's event ids: the broker replays what the tab missed
 * since then, on the new connection's scopes, or answers `stream.resync` when
 * its buffer no longer reaches back that far (ruling 11). A new EventSource
 * cannot send the `Last-Event-ID` header itself; the browser's own retry of
 * the same source does, and the header wins.
 */
export function buildEventsUrl(scopes: readonly string[], lastEventId: number | null = null): string {
  const params = scopes.map((scope) => `scope=${encodeURIComponent(scope)}`);
  if (lastEventId !== null) params.push(`lastEventId=${lastEventId}`);
  return `${SSE_ENDPOINT}?${params.join("&")}`;
}
