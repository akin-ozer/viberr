import { useState, type ReactNode } from "react";
import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import {
  createMemoryRouter,
  data,
  Link,
  Outlet,
  RouterProvider,
  useFetcher,
  useParams,
  useRouteLoaderData,
  useSearchParams,
  type DataStrategyFunction,
  type DataStrategyResult,
  type LoaderFunctionArgs,
  type RouteObject,
  type ShouldRevalidateFunction,
} from "react-router";
import type { SseEvent } from "~/schemas/sse-event.schema";
import {
  connectSseClient,
  parseSseScope,
  publishSseEvent,
  type SseConnectionHandle,
  type SseRoute,
  type SseScope,
} from "~/server/events/sse-broker.server";
import { sseScopes } from "~/features/live-updates/event-types";
import { useLiveUpdates } from "~/features/live-updates/use-live-updates";
import {
  revalidateWhen,
  useLiveLedger,
} from "~/features/live-updates/revalidation-policy";
import { useRunLogStream } from "~/features/runtime/use-run-log-stream";

/**
 * Ruling 454: a browser tab's revalidation behaviour, measured in jsdom the way
 * the app runs it (`revalidation.perf.test.tsx` and the live-update policy
 * tests).
 *
 * - The router is React Router's own, with a data strategy that makes the
 *   choice single fetch makes (`react-router/lib/dom/ssr/single-fetch.js`,
 *   `singleFetchLoaderNavigationStrategy`): every route already on screen is
 *   asked `shouldRevalidate` with `defaultShouldRevalidate: true` unless an
 *   action failed. `createRoutesStub` has no such strategy, so under it a
 *   navigation never re-runs a parent loader, which the app always did.
 * - The live stream is the real broker (`sse-broker.server.ts`) in-process:
 *   `BrokerEventSource` connects through `connectSseClient`, so ids, the
 *   hello, scope routing, replay after a last event id and `stream.resync`
 *   are the server's own.
 * - The routes are the workspace's shape (root > routes/project > board | task)
 *   with loaders that count their calls and return a fresh object each time,
 *   as a decoded single-fetch payload is, plus `/inbox`, a surface streaming
 *   the `user` scope alone.
 */

export const SLUG = "viberr-core";
/** A second project, for a navigation that changes the layout's slug. */
export const OTHER_SLUG = "billing";
export const TASK = "VIB-1";
export const OTHER_TASK = "VIB-9";
export const USER_ID = "u_harness";
const OCCURRED_AT = "2026-09-24T10:00:00.000Z";

// ------------------------------------------------------------ the stream

/**
 * An EventSource over the in-process broker. A new source is CONNECTING until
 * {@link BrokerEventSource.connectAll} opens it, which is when the broker
 * writes its hello and any replay, synchronously, the way one response would
 * carry them.
 */
export class BrokerEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: BrokerEventSource[] = [];

  readonly url: string;
  readyState = BrokerEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  private handle: SseConnectionHandle | null = null;
  /** What the browser sends as `Last-Event-ID` when it retries this source. */
  private lastSeenId: number | null = null;

  constructor(url: string) {
    this.url = url;
    BrokerEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  removeEventListener(): void {}

  close(): void {
    this.readyState = BrokerEventSource.CLOSED;
    this.handle?.close();
    this.handle = null;
  }

  open(): void {
    if (this.readyState !== BrokerEventSource.CONNECTING) return;
    const url = new URL(this.url, "http://localhost");
    const scopes = url.searchParams
      .getAll("scope")
      .map(parseSseScope)
      .filter((s): s is SseScope => s !== null);
    const query = url.searchParams.get("lastEventId");
    const lastEventId =
      this.lastSeenId ?? (query !== null && /^\d+$/.test(query) ? Number(query) : null);
    this.readyState = BrokerEventSource.OPEN;
    this.onopen?.();
    this.handle = connectSseClient({
      userId: USER_ID,
      scopes,
      lastEventId,
      write: (chunk) => this.receive(chunk),
    });
  }

  /** A transient drop: the response ends and the browser retries on its own
   *  (readyState CONNECTING), sending the last id it saw. */
  drop(): void {
    this.handle?.close();
    this.handle = null;
    this.readyState = BrokerEventSource.CONNECTING;
    this.onerror?.();
  }

  /** A non-200 answer: the connection FAILS and the browser never retries. */
  fail(): void {
    this.handle?.close();
    this.handle = null;
    this.readyState = BrokerEventSource.CLOSED;
    this.onerror?.();
  }

  private receive(chunk: string): void {
    for (const block of chunk.split("\n\n")) {
      let id = "";
      let name = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) id = line.slice(4);
        else if (line.startsWith("event: ")) name = line.slice(7);
        else if (line.startsWith("data: ")) data = line.slice(6);
      }
      if (!data) continue;
      if (id) this.lastSeenId = Number(id);
      const event = new MessageEvent<string>(name, { data, lastEventId: id });
      for (const listener of this.listeners.get(name) ?? []) listener(event);
    }
  }

  static open(): BrokerEventSource[] {
    return BrokerEventSource.instances.filter((s) => s.readyState !== BrokerEventSource.CLOSED);
  }

  /** Opens every source still connecting. */
  static connectAll(): void {
    for (const source of BrokerEventSource.instances) source.open();
  }
}

/** Publishes one wire event through the broker, routed as the server routes it. */
export function publish(event: SseEvent, route: SseRoute): number {
  return publishSseEvent(event, route);
}

export function taskUpdated(taskKey = TASK, slug = SLUG): number {
  return publish(
    {
      type: "task.updated",
      entityId: `${slug}/${taskKey}`,
      occurredAt: OCCURRED_AT,
      data: { projectSlug: slug, taskKey, stage: "impl", readiness: "ready" },
    },
    { projectSlug: slug, taskKey },
  );
}

export function runStateChanged(
  taskKey = TASK,
  state: "queued" | "running" | "finished" | "error" | "interrupted" = "running",
): number {
  return publish(
    {
      type: "run.state-changed",
      entityId: `${SLUG}/${taskKey}`,
      occurredAt: OCCURRED_AT,
      data: { projectSlug: SLUG, taskKey, runId: `run_${taskKey}`, threadId: "primary", state },
    },
    { projectSlug: SLUG, taskKey },
  );
}

/** One console line of `taskKey`'s run, routed as `run-events.server.ts`
 *  routes it: to that task's scope only (`taskOnly`). */
export function runLogAppended(taskKey = TASK, seq = 1): number {
  return publish(
    {
      type: "run.log-appended",
      entityId: `${SLUG}/${taskKey}`,
      occurredAt: OCCURRED_AT,
      data: { projectSlug: SLUG, taskKey, runId: `run_${taskKey}`, threadId: "primary", seq },
    },
    { projectSlug: SLUG, taskKey, taskOnly: true },
  );
}

export function notificationRead(): number {
  return publish(
    {
      type: "notification.read",
      entityId: USER_ID,
      occurredAt: OCCURRED_AT,
      data: { userId: USER_ID },
    },
    { userId: USER_ID },
  );
}

// ------------------------------------------------------------ the router

/** Single fetch's revalidation choice (see the module comment). */
export const singleFetchStrategy: DataStrategyFunction = async ({ request, matches, fetcherKey }) => {
  const results: Record<string, DataStrategyResult> = {};
  if (request.method !== "GET" || fetcherKey) {
    const target = matches.find((m) => m.shouldCallHandler());
    if (target) results[target.route.id] = await target.resolve();
    return results;
  }
  await Promise.all(
    matches.map(async (m) => {
      const status = m.shouldRevalidateArgs?.actionStatus;
      const byDefault = !m.shouldRevalidateArgs || status == null || status < 400;
      if (!m.shouldCallHandler(byDefault)) return;
      results[m.route.id] = await m.resolve();
    }),
  );
  return results;
};

/** Loader calls per route since the last reset. */
const calls = {
  root: 0,
  "routes/project": 0,
  "routes/project.board": 0,
  "routes/project.task": 0,
};

export type HarnessRouteId = keyof typeof calls;

/** The `?events` each task loader call read, in order. */
const noEventsParams: (string | null)[] = [];
const tally = { actions: 0, eventsParams: noEventsParams };

function resetCounts(): void {
  calls.root = 0;
  calls["routes/project"] = 0;
  calls["routes/project.board"] = 0;
  calls["routes/project.task"] = 0;
  tally.actions = 0;
  tally.eventsParams = [];
}

/** Every loader answer's number, across routes: a later load has a larger one. */
let version = 0;

/** The mounted harness's options (one tab per test). */
let active: HarnessOptions = { path: "/" };

async function taskLoader({ request, params }: LoaderFunctionArgs) {
  calls["routes/project.task"] += 1;
  tally.eventsParams.push(new URL(request.url).searchParams.get("events"));
  active.onTaskLoader?.();
  await active.gate?.["routes/project.task"]?.();
  version += 1;
  return { key: params.key ?? TASK, n: calls["routes/project.task"], version };
}

export interface HarnessOptions {
  /** Where the tab starts. */
  path: string;
  /**
   * Replaces a route's `shouldRevalidate` (each defaults to the one its route
   * module exports: `revalidateWhen(<id>)`, ruling 454). `null` leaves the
   * route on React Router's default, as it was before ruling 454.
   */
  shouldRevalidate?: Partial<Record<HarnessRouteId, ShouldRevalidateFunction | null>>;
  /** Runs inside the task action, before it answers (its writes' events). */
  onTaskAction?: () => void;
  /** The status the task action answers with (a refusal is a 4xx). */
  taskActionStatus?: number;
  /** Runs at the start of each task loader call (an event published while a
   *  load is on its way). */
  onTaskLoader?: () => void;
  /** A loader awaits its route's gate before answering (a load in flight). */
  gate?: Partial<Record<HarnessRouteId, () => Promise<void>>>;
  /** Root's `liveHead`: the stream position of the server render. */
  liveHead?: number | null;
  /** Runs inside the board action, before it answers. */
  onBoardAction?: () => void;
  /** The task page shows an active run (the F22 safety net arms). */
  activeRun?: boolean;
}

export interface Harness {
  router: ReturnType<typeof createMemoryRouter>;
  /** Loader calls per route since the last `resetCounts`. */
  calls: typeof calls;
  /** Action calls since the last `resetCounts`. */
  actions: () => number;
  /** The `?events` each task loader call read since the last `resetCounts`. */
  eventsParams: () => (string | null)[];
  /** Loader calls of every route since the last `resetCounts`. */
  total: () => number;
  resetCounts: () => void;
}

let submitComment: (() => void) | null = null;
let submitRead: (() => void) | null = null;
let submitDrop: (() => void) | null = null;
let typeFilter: ((value: string) => void) | null = null;

/** Submits the task page's comment form (a fetcher, as the timeline's is). */
export function sendComment(): void {
  submitComment?.();
}

/** Marks the bell read from the task page (the bell's `/notifications/read`
 *  fetcher), whose write publishes `notification.read` to this user. */
export function markRead(): void {
  submitRead?.();
}

/** Submits the board's drop (a fetcher, as the board's drag is). */
export function dropCard(): void {
  submitDrop?.();
}

/** One keystroke into the board filter (the board's `setParam("q", …)`). */
export function typeInFilter(value: string): void {
  typeFilter?.(value);
}

function Layout() {
  const slug = useParams().slug ?? SLUG;
  const task = useRouteLoaderData<typeof taskLoader>("routes/project.task");
  // The scopes `routes/project.tsx` subscribes. One instance across a slug
  // change, as the route module's is.
  useLiveUpdates(
    task
      ? [sseScopes.project(slug), sseScopes.task(slug, task.key), sseScopes.user()]
      : [sseScopes.project(slug), sseScopes.user()],
  );
  return <Outlet />;
}

/** A surface that streams the `user` scope alone (the notifications page,
 *  Instance settings, the profile): no project events reach its stream. */
function UserSurface() {
  useLiveUpdates([sseScopes.user()]);
  return <Link to={`/projects/${SLUG}/board`}>board</Link>;
}

function Board() {
  const [, setSearchParams] = useSearchParams();
  const drop = useFetcher();
  typeFilter = (value) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set("q", value);
        else next.delete("q");
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  submitDrop = () =>
    void drop.submit({ intent: "reorder" }, { method: "post", action: `/projects/${SLUG}/board` });
  return <Link to={`/projects/${SLUG}/tasks/${TASK}`}>open</Link>;
}

function Task({ activeRun }: { activeRun: boolean }) {
  const data = useRouteLoaderData<typeof taskLoader>("routes/project.task");
  const key = data?.key ?? TASK;
  const comment = useFetcher();
  const read = useFetcher();
  const [threads] = useState(() => []);
  useRunLogStream({
    source: { kind: "task", projectSlug: SLUG, taskKey: key },
    threads,
    hasActiveRun: activeRun,
  });
  submitComment = () =>
    void comment.submit(
      { intent: "comment", text: "hello" },
      { method: "post", action: `/projects/${SLUG}/tasks/${key}` },
    );
  submitRead = () =>
    void read.submit({ all: "1" }, { method: "post", action: "/notifications/read" });
  return <Link to={`/projects/${SLUG}/board`}>board</Link>;
}

/** Root's component, as `app/root.tsx` holds the tab's live ledger and seeds
 *  it with the server render's stream position. */
function RootShell({ children }: { children: ReactNode }) {
  useLiveLedger(active.liveHead ?? null);
  return <>{children}</>;
}

export function mountHarness(options: HarnessOptions): Harness {
  resetCounts();
  active = options;
  const counted = (id: HarnessRouteId) => async () => {
    calls[id] += 1;
    const n = calls[id];
    await options.gate?.[id]?.();
    version += 1;
    return { id, n, version };
  };
  const rule = (id: HarnessRouteId) => {
    const override = options.shouldRevalidate?.[id];
    if (override === null) return undefined;
    return override ?? revalidateWhen(id);
  };
  const routes: RouteObject[] = [
    {
      id: "root",
      path: "/",
      loader: counted("root"),
      shouldRevalidate: rule("root"),
      element: (
        <RootShell>
          <Outlet />
        </RootShell>
      ),
      children: [
        {
          // The bell's mark-read target: an action, no page.
          id: "routes/notifications.read",
          path: "notifications/read",
          action: () => {
            tally.actions += 1;
            notificationRead();
            return { ok: true };
          },
        },
        {
          // No loader: only the stream matters here.
          id: "user-surface",
          path: "inbox",
          element: <UserSurface />,
        },
        {
          id: "routes/project",
          path: "projects/:slug",
          loader: counted("routes/project"),
          shouldRevalidate: rule("routes/project"),
          element: <Layout />,
          children: [
            {
              id: "routes/project.board",
              path: "board",
              loader: counted("routes/project.board"),
              shouldRevalidate: rule("routes/project.board"),
              action: () => {
                tally.actions += 1;
                options.onBoardAction?.();
                return { ok: true };
              },
              element: <Board />,
            },
            {
              id: "routes/project.task",
              path: "tasks/:key",
              loader: taskLoader,
              shouldRevalidate: rule("routes/project.task"),
              action: () => {
                tally.actions += 1;
                options.onTaskAction?.();
                const status = options.taskActionStatus ?? 200;
                return data({ ok: status < 400 }, { status });
              },
              element: <Task activeRun={options.activeRun ?? false} />,
            },
          ],
        },
      ],
    },
  ];
  const router = createMemoryRouter(routes, {
    initialEntries: [options.path],
    dataStrategy: singleFetchStrategy,
  });
  render(<RouterProvider router={router} />);
  return {
    router,
    calls,
    actions: () => tally.actions,
    eventsParams: () => tally.eventsParams,
    total: () => Object.values(calls).reduce((sum, n) => sum + n, 0),
    resetCounts,
  };
}

/** Lets loaders, actions and React settle: microtasks only, no clock. */
export async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });
}

/** Opens every stream the tab asked for, then settles. */
export async function connect(): Promise<void> {
  await act(async () => {
    BrokerEventSource.connectAll();
  });
  await settle();
}

/** Advances the fake clock inside `act`, settling after. */
export async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}
