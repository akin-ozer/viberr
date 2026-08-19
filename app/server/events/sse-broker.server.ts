import type { SseEvent } from "~/schemas/sse-event.schema";
import {
  releaseDataRootLock,
  stopDataRootLockGuard,
} from "~/server/db/data-root-lock.server";
import { shutdownDatabase } from "~/server/db/sqlite.server";
import { stopFileWatcher } from "~/server/files/file-watch.service.server";
import { stopKbWatcher } from "~/server/files/kb-watch.service.server";
import { logger } from "~/server/logging/logger.server";

/**
 * SSE broker: in-process fan-out from the event publisher to connected
 * clients (Phase 6).
 *
 * - One connection per browser tab (`/resources/events`), authenticated;
 *   each carries its session user id + the scopes it asked for.
 * - Per-connection filtering by scope (`project:<slug>` | `task:<slug>/<key>`
 *   | `projects` (every project) | `user`). User-targeted events
 *   (notification.created/read) are delivered ONLY to `user`-scoped
 *   connections of that exact user id.
 * - Heartbeat comment every 25 s per connection keeps proxies/browsers from
 *   idling the socket out.
 * - Backpressure-safe: writes go through the connection's `write` callback;
 *   any throw (closed controller, backpressure limit exceeded — see the
 *   route) drops and closes that connection. A slow client can never block
 *   or crash the publisher.
 * - Ring buffer of the last 256 published events with a monotonically
 *   increasing id (`id:` SSE field). A reconnect presenting Last-Event-ID
 *   replays the missed events (scope-filtered); when the id predates the
 *   buffer window (or a restart reset ids) the client gets `stream.resync`
 *   and revalidates once instead.
 * - HMR-safe singleton (global-symbol state, same pattern as getDb()) +
 *   graceful shutdown: SIGINT/SIGTERM runs `runProcessShutdown` (connections,
 *   database, data-root writer lock), then re-raises the signal for the default
 *   handler. This is the app's only signal handler, so it is the process
 *   shutdown hook, not just the SSE one.
 *
 * High-frequency streams (Phase 8 `run.log-appended`): publish straight to
 * `publishSseEvent` from the runtime adapter — do NOT route chatty streams
 * through the projection emitter (that path implies a projection rebuild
 * per event).
 */

export const HEARTBEAT_INTERVAL_MS = 25_000;
export const RING_BUFFER_SIZE = 256;

// ---------------------------------------------------------------- scopes

export type SseScope =
  | { kind: "project"; slug: string }
  | { kind: "task"; slug: string; key: string }
  /** Global project firehose: every project/task-routed compact event, any
   * project. The Home landing page subscribes it so cross-project changes
   * (a transition, a new task) refresh the cards without a manual re-scan. */
  | { kind: "projects" }
  | { kind: "user" };

const PROJECT_SCOPE_RE = /^project:([A-Za-z0-9][A-Za-z0-9_-]*)$/;
const TASK_SCOPE_RE = /^task:([A-Za-z0-9][A-Za-z0-9_-]*)\/([A-Za-z0-9][A-Za-z0-9_-]*)$/;

/** Parses one `scope` query param. Null on anything malformed. */
export function parseSseScope(raw: string): SseScope | null {
  if (raw === "user") return { kind: "user" };
  if (raw === "projects") return { kind: "projects" };
  const project = PROJECT_SCOPE_RE.exec(raw);
  if (project) return { kind: "project", slug: project[1]! };
  const task = TASK_SCOPE_RE.exec(raw);
  if (task) return { kind: "task", slug: task[1]!, key: task[2]! };
  return null;
}

// --------------------------------------------------------------- routing

/**
 * Routing facts attached to a published event — which connections get it.
 * Exactly one flavor applies:
 * - `userId`      → that user's `user`-scoped connections only.
 * - `broadcast`   → every connection (projection.rebuilt).
 * - `projectSlug` (+ optional `taskKey`) → matching project/task scopes.
 */
export interface SseRoute {
  projectSlug?: string;
  taskKey?: string;
  userId?: string;
  broadcast?: boolean;
}

export function routeMatchesConnection(
  route: SseRoute,
  conn: { userId: string; scopes: SseScope[] },
): boolean {
  if (route.userId !== undefined) {
    return (
      conn.userId === route.userId &&
      conn.scopes.some((s) => s.kind === "user")
    );
  }
  if (route.broadcast) return true;
  if (route.projectSlug === undefined) return false;
  return conn.scopes.some((s) => {
    if (s.kind === "projects") return true; // all-projects firehose
    if (s.kind === "project") return s.slug === route.projectSlug;
    if (s.kind === "task") {
      return (
        s.slug === route.projectSlug &&
        (route.taskKey === undefined || s.key === route.taskKey)
      );
    }
    return false;
  });
}

// ----------------------------------------------------------------- state

interface BufferedEvent {
  id: number;
  name: string;
  json: string;
  route: SseRoute;
}

interface SseConnection {
  id: number;
  userId: string;
  scopes: SseScope[];
  write: (chunk: string) => void;
  heartbeat: ReturnType<typeof setInterval> | null;
  onClose: (() => void) | undefined;
  closed: boolean;
}

interface BrokerState {
  nextEventId: number;
  nextConnectionId: number;
  buffer: BufferedEvent[];
  connections: Map<number, SseConnection>;
  signalsRegistered: boolean;
}

const BROKER_KEY = Symbol.for("viberr.sseBroker");

function getState(): BrokerState {
  const cache: Record<symbol, BrokerState | undefined> = globalThis;
  let state = cache[BROKER_KEY];
  if (!state) {
    state = {
      nextEventId: 0,
      nextConnectionId: 0,
      buffer: [],
      connections: new Map(),
      signalsRegistered: false,
    };
    cache[BROKER_KEY] = state;
  }
  if (!state.signalsRegistered && process.env.NODE_ENV !== "test") {
    const shutdown = (signal: NodeJS.Signals) => {
      runProcessShutdown();
      process.kill(process.pid, signal);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    state.signalsRegistered = true;
  }
  return state;
}

// ----------------------------------------------------------- wire format

/** One SSE message: id + event name + single-line JSON data. */
export function formatSseMessage(id: number, name: string, json: string): string {
  return `id: ${id}\nevent: ${name}\ndata: ${json}\n\n`;
}

/** Heartbeat comment — clients ignore it, proxies see traffic. */
export const HEARTBEAT_CHUNK = ": hb\n\n";

/** The hello a connection opens with — its `headId` is where a client that
 *  never receives a data event resumes from after a reconnect. */
function streamOpenEvent(headId: number): SseEvent {
  return {
    type: "stream.open",
    entityId: "stream",
    occurredAt: new Date().toISOString(),
    data: { headId },
  };
}

/** Sent when replay cannot catch a reconnecting client up. */
function streamResyncEvent(): SseEvent {
  return {
    type: "stream.resync",
    entityId: "stream",
    occurredAt: new Date().toISOString(),
    data: {},
  };
}

// ------------------------------------------------------------ connection

function dropConnection(state: BrokerState, conn: SseConnection): void {
  if (conn.closed) return;
  conn.closed = true;
  if (conn.heartbeat) clearInterval(conn.heartbeat);
  conn.heartbeat = null;
  state.connections.delete(conn.id);
  try {
    conn.onClose?.();
  } catch {
    // The response stream may already be gone — nothing left to close.
  }
}

/** Write or drop: any throwing write closes the connection (backpressure
 * limit from the route, closed controller, torn socket). */
function safeWrite(state: BrokerState, conn: SseConnection, chunk: string): void {
  if (conn.closed) return;
  try {
    conn.write(chunk);
  } catch (error) {
    logger.info("sse connection dropped on failed write", {
      connectionId: conn.id,
      reason: error instanceof Error ? error.message : String(error),
    });
    dropConnection(state, conn);
  }
}

export interface ConnectSseInput {
  userId: string;
  scopes: SseScope[];
  /** Last-Event-ID from the reconnecting client (header or query param). */
  lastEventId?: number | null;
  /** Synchronous chunk writer. MUST throw to signal a failed write. */
  write: (chunk: string) => void;
  /** Called exactly once when the broker drops/closes the connection. */
  onClose?: () => void;
}

export interface SseConnectionHandle {
  id: number;
  close(): void;
}

/**
 * Registers a connection: sends the `stream.open` hello (carrying the head
 * event id as its `id:` so the client can resume even if it never receives
 * a data event), replays missed events for reconnects, starts the
 * heartbeat.
 */
export function connectSseClient(input: ConnectSseInput): SseConnectionHandle {
  const state = getState();
  const conn: SseConnection = {
    id: ++state.nextConnectionId,
    userId: input.userId,
    scopes: input.scopes,
    write: input.write,
    heartbeat: null,
    onClose: input.onClose,
    closed: false,
  };
  state.connections.set(conn.id, conn);

  const headId = state.nextEventId;
  safeWrite(
    state,
    conn,
    `retry: 5000\n` +
      formatSseMessage(
        headId,
        "stream.open",
        JSON.stringify(streamOpenEvent(headId)),
      ),
  );

  // Reconnect catch-up: replay everything the client missed (scope-filtered)
  // when the buffer still covers its position; otherwise tell it to resync.
  const last = input.lastEventId;
  if (!conn.closed && last !== null && last !== undefined && last !== headId) {
    const oldest = state.buffer[0]?.id;
    const covered =
      last <= headId && (oldest === undefined ? last === headId : last >= oldest - 1);
    if (covered) {
      for (const buffered of state.buffer) {
        if (conn.closed) break;
        if (buffered.id <= last) continue;
        if (!routeMatchesConnection(buffered.route, conn)) continue;
        safeWrite(state, conn, formatSseMessage(buffered.id, buffered.name, buffered.json));
      }
    } else {
      safeWrite(
        state,
        conn,
        formatSseMessage(
          headId,
          "stream.resync",
          JSON.stringify(streamResyncEvent()),
        ),
      );
    }
  }

  if (!conn.closed) {
    conn.heartbeat = setInterval(() => {
      safeWrite(state, conn, HEARTBEAT_CHUNK);
    }, HEARTBEAT_INTERVAL_MS);
    // Never keep the process alive just for heartbeats.
    conn.heartbeat.unref?.();
  }

  return {
    id: conn.id,
    close: () => dropConnection(state, conn),
  };
}

// ----------------------------------------------------------------- publish

/**
 * Publishes one event: assigns the next monotonic id, appends it to the
 * ring buffer, fans out to every scope-matching connection. Returns the id.
 */
export function publishSseEvent(event: SseEvent, route: SseRoute): number {
  const state = getState();
  const id = ++state.nextEventId;
  const json = JSON.stringify(event);
  state.buffer.push({ id, name: event.type, json, route });
  if (state.buffer.length > RING_BUFFER_SIZE) {
    state.buffer.splice(0, state.buffer.length - RING_BUFFER_SIZE);
  }
  const chunk = formatSseMessage(id, event.type, json);
  // A failed write drops the connection it was writing to — deleting the entry
  // the loop is standing on is well-defined for a Map iterator.
  for (const conn of state.connections.values()) {
    if (!routeMatchesConnection(route, conn)) continue;
    safeWrite(state, conn, chunk);
  }
  return id;
}

// ---------------------------------------------------------------- teardown

/**
 * Everything the process must do before it dies, in order. Exported because the
 * signal handler itself ends in a re-raise (unrunnable in a test), while THIS is
 * the part that has to be right.
 *
 * - Sockets first: open SSE responses otherwise keep the prod server's sockets
 *   alive past the signal.
 * - Then the database (P13-D-43): this is the app's ONLY signal handler, so the
 *   close belongs here — nothing else ever checkpointed the WAL, leaving
 *   `projection.sqlite-wal`/`-shm` (which hold unrebuildable users/sessions/PATs
 *   rows) beside the main file on exit.
 * - Then the data-root writer lock (B-FD1/G1): the handler re-raises the signal,
 *   so `process.once("exit")` NEVER fires on SIGINT/SIGTERM and the lock file
 *   survived every `docker compose stop`. The next `up` gets a new hostname and
 *   `classifyLock` refuses a foreign-host lock it cannot probe — the app never
 *   booted again. Last, so the lock outlives the final database write.
 */
/**
 * Arm the SIGINT/SIGTERM handler eagerly, from boot.
 *
 * Registration used to happen lazily inside `getState()`, whose only callers
 * are the publish/connect paths — so on a warm store, where the boot rescan
 * emits nothing and no client has connected yet, `docker compose stop` ran NO
 * handler at all: no WAL checkpoint and no writer-lock release, which is the
 * exact state the release was written to end.
 */
export function armProcessShutdown(): void {
  getState();
}

export function runProcessShutdown(): void {
  closeAllSseConnections();
  // Detach both watchers (timers + handlers cleared synchronously) BEFORE the
  // database closes, so no debounced rebuild can fire into a shut-down DB.
  stopFileWatcher();
  stopKbWatcher();
  // Stop the F18-5 ownership guard before we deliberately release the lock — a
  // clean shutdown must not be mistaken for a steal.
  stopDataRootLockGuard();
  shutdownDatabase();
  releaseDataRootLock();
}

/** Graceful shutdown / test teardown: closes every connection. */
export function closeAllSseConnections(): void {
  const state = getState();
  for (const conn of state.connections.values()) {
    dropConnection(state, conn);
  }
}

/** Test-only: fresh ids, empty buffer, no connections. */
export function resetSseBrokerForTests(): void {
  closeAllSseConnections();
  const cache: Record<symbol, BrokerState | undefined> = globalThis;
  cache[BROKER_KEY] = undefined;
}

/** What {@link getSseBrokerStats} reports. */
export interface SseBrokerStats {
  connections: number;
  bufferedEvents: number;
  headId: number;
}

/** test-only — leak invariants (buffer cap, connection registry) have no
 * behavioral surface, so the tests introspect. */
export function getSseBrokerStats(): SseBrokerStats {
  const state = getState();
  return {
    connections: state.connections.size,
    bufferedEvents: state.buffer.length,
    headId: state.nextEventId,
  };
}
