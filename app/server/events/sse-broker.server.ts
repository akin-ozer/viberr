import { createContext, type MiddlewareFunction } from "react-router";
import type { SseEvent } from "~/schemas/sse-event.schema";
import { SSE_STREAM_EVENTS } from "~/features/live-updates/event-types";
import {
  releaseDataRootLock,
  stopDataRootLockGuard,
} from "~/server/db/data-root-lock.server";
import { shutdownDatabase } from "~/server/db/sqlite.server";
import { stopFileWatcher } from "~/server/files/file-watch.service.server";
import { stopKbWatcher } from "~/server/files/kb-watch.service.server";
import { logger } from "~/server/logging/logger.server";
import { stopMcpGateway } from "~/server/mcp-proxy/gateway.server";
import { errorMessage, toError } from "~/shared/errors";

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
 * - Ring buffers of the last published events with a monotonically
 *   increasing id (`id:` SSE field), unique across processes (ruling 457,
 *   RV-5): 256 data events, and 256 stream events (console lines) in a ring
 *   of their own (RV-3). A reconnect presenting Last-Event-ID replays the
 *   missed events of both (scope-filtered, in id order); when a data event it
 *   missed has left its ring (or the id predates this process) the client
 *   gets `stream.resync` and revalidates once instead.
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

const HEARTBEAT_INTERVAL_MS = 25_000;
const RING_BUFFER_SIZE = 256;
/**
 * Ruling 457 (RV-3): the stream events' own ring (`SSE_STREAM_EVENTS`: one
 * `run.log-appended` or `controller.log-appended` per console line). They used
 * to share the data ring, and a connection's position moves only on events in
 * its own scopes: a board open while an agent printed 300 lines stood at a
 * position the ring no longer reached, so opening that task answered
 * `stream.resync` and reloaded the page for lines its console reads itself.
 * Lines this ring has let go of never resync: the console fetches whatever
 * lies past its cursor on the next frame or reload.
 */
const STREAM_RING_BUFFER_SIZE = 256;

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
  /** Skip the all-projects firehose. For a high-frequency event whose only
   *  consumers are scoped to the project or the task — one reference PER
   *  CONSOLE LINE of a run, in practice. Home subscribes `projects`, so
   *  without this a single agent run re-ran Home's loaders once per line of
   *  output. Project- and task-scoped subscribers are unaffected: a board
   *  showing that task IS a legitimate recipient (pinned in
   *  run-events.server.test.ts) and still gets it. */
  skipFirehose?: boolean;
  /** Ruling 457 (LIVE-5): deliver to connections holding THIS task's scope
   *  only. For a reference whose one reader is the console of the page
   *  showing that task: one `run.log-appended` per console line reached every
   *  board of the project, which parsed and dropped it. Implies
   *  `skipFirehose`. */
  taskOnly?: boolean;
}

function routeMatchesConnection(
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
    if (s.kind === "projects") return route.skipFirehose !== true && route.taskOnly !== true;
    if (s.kind === "project") return route.taskOnly !== true && s.slug === route.projectSlug;
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
  reauthorize: (() => SseScope[]) | undefined;
  closed: boolean;
}

interface BrokerState {
  nextEventId: number;
  nextConnectionId: number;
  /** Data events: every name but the stream events. */
  buffer: BufferedEvent[];
  /** Stream events (console lines), ruling 457 (RV-3). */
  streamBuffer: BufferedEvent[];
  /** The newest data event id the data ring has let go of (this process's
   *  base until it lets one go): a position below it missed one for good. */
  replayFloor: number;
  connections: Map<number, SseConnection>;
  signalsRegistered: boolean;
}

const BROKER_KEY = Symbol.for("viberr.sseBroker");

/**
 * Ruling 457 (RV-5): where this process's event ids start, a thousand per
 * millisecond of the clock at boot, so they are unique across processes and
 * grow from one to the next. A tab's position from before a restart is below
 * every id this process hands out, so it reads as uncovered and gets
 * `stream.resync`. Ids used to start at 1 in every process, and once the new
 * one had published past a tab's old position, that position read as its own:
 * the broker replayed only what followed it and the new process's earlier
 * changes never reached the tab. (Room for 1,000 events per millisecond of
 * uptime, and within `Number.MAX_SAFE_INTEGER` for two centuries.)
 */
function eventIdBase(): number {
  return Date.now() * 1000;
}

function getState(): BrokerState {
  const cache: Record<symbol, BrokerState | undefined> = globalThis;
  let state = cache[BROKER_KEY];
  if (!state) {
    const base = eventIdBase();
    state = {
      nextEventId: base,
      nextConnectionId: 0,
      buffer: [],
      streamBuffer: [],
      replayFloor: base,
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
function formatSseMessage(id: number, name: string, json: string): string {
  return `id: ${id}\nevent: ${name}\ndata: ${json}\n\n`;
}

/** Heartbeat comment — clients ignore it, proxies see traffic. */
const HEARTBEAT_CHUNK = ": hb\n\n";

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
      reason: errorMessage(error),
    });
    dropConnection(state, conn);
  }
}

/**
 * Narrow a live connection to the scopes its user still holds.
 * Returns false when the connection was dropped for holding none.
 */
function applyReauthorization(
  state: BrokerState,
  conn: SseConnection,
): boolean {
  if (!conn.reauthorize) return true;
  let next: SseScope[];
  try {
    next = conn.reauthorize();
  } catch (error) {
    // A check that could not run must not WIDEN access, and must not tear down
    // a healthy stream over a transient read either: keep what the connection
    // already had and try again on the next beat.
    logger.warn("sse scope re-authorization failed", {
      connectionId: conn.id,
      err: toError(error),
    });
    return true;
  }
  if (next.length === 0) {
    dropConnection(state, conn);
    return false;
  }
  conn.scopes = next;
  return true;
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
  /**
   * Re-resolve the scopes this connection is still allowed, called on every
   * heartbeat.
   *
   * Authorization is otherwise decided once, at connect time, and these
   * streams are open-ended: a member removed from a project (or an admin
   * demoted) would keep receiving that project's live events for as long as
   * the tab stays open. Returning an empty list closes the connection — the
   * client's own backoff then re-opens and meets the ordinary 403.
   */
  reauthorize?: () => SseScope[];
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
    reauthorize: input.reauthorize,
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
  // when the data ring still holds every data event after its position;
  // otherwise tell it to resync. The stream ring replays what it still holds
  // and never resyncs (ruling 457, RV-3).
  const last = input.lastEventId;
  if (!conn.closed && last !== null && last !== undefined && last !== headId) {
    const covered = last <= headId && last >= state.replayFloor;
    if (covered) {
      const missed = [...state.buffer, ...state.streamBuffer]
        .filter((buffered) => buffered.id > last)
        .toSorted((a, b) => a.id - b.id);
      for (const buffered of missed) {
        if (conn.closed) break;
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
      if (!applyReauthorization(state, conn)) return;
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
 * Publishes one event: assigns the next monotonic id, appends it to its ring
 * (a stream event's own, or the data ring), fans out to every scope-matching
 * connection. Returns the id.
 */
export function publishSseEvent(event: SseEvent, route: SseRoute): number {
  const state = getState();
  const id = ++state.nextEventId;
  const json = JSON.stringify(event);
  if (SSE_STREAM_EVENTS.includes(event.type)) {
    state.streamBuffer.push({ id, name: event.type, json, route });
    if (state.streamBuffer.length > STREAM_RING_BUFFER_SIZE) state.streamBuffer.shift();
  } else {
    state.buffer.push({ id, name: event.type, json, route });
    if (state.buffer.length > RING_BUFFER_SIZE) {
      const evicted = state.buffer.shift();
      if (evicted) state.replayFloor = evicted.id;
    }
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

// ------------------------------------------------------------- live head

/**
 * Ruling 457 (RF-1): the broker's head when a request began, before any of
 * its loaders read anything. Every event at or below it was published, and
 * its write committed, before those reads, so the data the request renders
 * holds them; the page's first stream asks the broker to replay from here and
 * receives exactly what happened after (root's loader hands it over as
 * `liveHead`).
 */
export const liveHeadContext = createContext<number | null>(null);

/** Root middleware: records {@link liveHeadContext} for the request. */
export const liveHeadMiddleware: MiddlewareFunction = ({ context }, next) => {
  context.set(liveHeadContext, getState().nextEventId);
  return next();
};

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
  // Ruling 461: the MCP gateway's live tokens, sessions and upstreams go
  // first; its teardown kills every stdio server it spawned synchronously
  // (they lead their own process groups, so nothing else would).
  void stopMcpGateway();
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
function closeAllSseConnections(): void {
  const state = getState();
  for (const conn of state.connections.values()) {
    dropConnection(state, conn);
  }
}

/** Test-only: a restart. Ids start again from the clock (ruling 457, RV-5),
 *  the buffer is empty and no connection is left. */
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
    bufferedEvents: state.buffer.length + state.streamBuffer.length,
    headId: state.nextEventId,
  };
}
