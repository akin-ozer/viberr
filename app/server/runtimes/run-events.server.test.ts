import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sseEventSchema } from "~/schemas/sse-event.schema";
import {
  connectSseClient,
  getSseBrokerStats,
  resetSseBrokerForTests,
  type SseScope,
} from "~/server/events/sse-broker.server";
import {
  publishRunLogAppended,
  publishRunStateChanged,
} from "./run-events.server";

/**
 * The run stream's direct-to-broker publishers.
 *
 * These two functions are the ONLY producers of `run.log-appended` /
 * `run.state-changed`, and they are the only ones that skip the projection
 * emitter — which is also the only place an event is zod-parsed against the
 * wire contract (`event-publisher.server.ts` calls
 * `publishSseEvent(sseEventSchema.parse(...))`; `publishSseEvent` itself just
 * `JSON.stringify`s whatever it is handed). So on this path there is no
 * validator downstream: whatever these functions build goes on the wire
 * verbatim, to whatever connections the route matches.
 *
 * The load-bearing line is the ruling-99 guard. A controller conversation turn
 * is a real `agent_runs` row that streams through the same sink, but it carries
 * `project_slug = ''` and `task_key = <conversation id>` — "a scope no task
 * query matches" (ruling 99(d)). An empty slug is not a harmless one:
 * `routeMatchesConnection` only skips project routing when `projectSlug` is
 * *undefined*, so `""` is a live route that every `projects`-scoped connection
 * (the Home firehose, on every signed-in user's landing page) matches
 * unconditionally. Without the guard, one person's private controller
 * conversation would tick every other person's Home page, carrying a payload
 * (`projectSlug: ""`) that the wire schema's `z.string().min(1)` rejects. The
 * controller has its own owner-routed `controller.updated` reference instead.
 *
 * Until this file existed, nothing in the suite imported the module: the guard
 * could be deleted and every gate stayed green (ruling 65).
 */

interface TestClient {
  writes: string[];
  /** Event names received; the `retry:`/hello preamble lines are skipped. */
  names(): string[];
}

function connect(scopes: SseScope[]): TestClient {
  const writes: string[] = [];
  connectSseClient({
    userId: "u_watcher",
    scopes,
    lastEventId: null,
    write: (chunk) => {
      writes.push(chunk);
    },
  });
  return {
    writes,
    names() {
      return this.writes
        .flatMap((chunk) => chunk.split("\n"))
        .filter((line) => line.startsWith("event: "))
        .map((line) => line.slice("event: ".length));
    },
  };
}

/** The `data:` JSON of every message written to a client, in order. */
function dataLines(writes: string[]): string[] {
  return writes
    .flatMap((chunk) => chunk.split("\n"))
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
}

beforeEach(() => resetSseBrokerForTests());
afterEach(() => resetSseBrokerForTests());

describe("publishRunLogAppended", () => {
  it("publishes one task-scoped run.log-appended carrying reference facts only", () => {
    const page = connect([{ kind: "task", slug: "viberr-core", key: "VIB-42" }]);

    publishRunLogAppended({
      projectSlug: "viberr-core",
      taskKey: "VIB-42",
      runId: "run_9",
      threadId: "thr_3",
      seq: 17,
    });

    expect(page.names()).toEqual(["stream.open", "run.log-appended"]);
    const payload: unknown = JSON.parse(dataLines(page.writes).at(-1)!);
    // The whole point of this stream is that it is chatty: one event per
    // streamed line. The payload must therefore stay a POINTER (runId + the
    // highest seq now readable) and never the line itself — the console fetches
    // content through the members-only logs endpoint, which is also where
    // P13-U-1 output redaction lives. A payload that grew a `text`/`display`
    // field would put unredacted agent output on an unvalidated wire.
    expect(payload).toEqual({
      type: "run.log-appended",
      entityId: "viberr-core/VIB-42",
      occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      data: {
        projectSlug: "viberr-core",
        taskKey: "VIB-42",
        runId: "run_9",
        threadId: "thr_3",
        seq: 17,
      },
    });
  });

  it("routes by project AND task — a sibling task's page never sees the run", () => {
    const own = connect([{ kind: "task", slug: "viberr-core", key: "VIB-42" }]);
    const sibling = connect([
      { kind: "task", slug: "viberr-core", key: "VIB-7" },
    ]);
    const project = connect([{ kind: "project", slug: "viberr-core" }]);
    const foreign = connect([{ kind: "project", slug: "billing-service" }]);
    const inbox = connect([{ kind: "user" }]);

    publishRunLogAppended({
      projectSlug: "viberr-core",
      taskKey: "VIB-42",
      runId: "run_9",
      threadId: "thr_3",
      seq: 1,
    });

    // The route facts are what scope the fan-out. Dropping `taskKey` from the
    // route still "works" for the task that owns the run, so the regression is
    // invisible from the owning page — it shows up as every OTHER open task in
    // the project revalidating its logs on every line of somebody else's run.
    expect(own.names()).toContain("run.log-appended");
    expect(sibling.names()).not.toContain("run.log-appended");
    // A project-scoped subscriber (the board) is a legitimate recipient: a
    // task-keyed route matches project scope by design.
    expect(project.names()).toContain("run.log-appended");
    expect(foreign.names()).not.toContain("run.log-appended");
    expect(inbox.names()).not.toContain("run.log-appended");
  });

  it("publishes at seq 0 — the first line of a run is not 'no line'", () => {
    const page = connect([{ kind: "task", slug: "viberr-core", key: "VIB-42" }]);

    publishRunLogAppended({
      projectSlug: "viberr-core",
      taskKey: "VIB-42",
      runId: "run_9",
      threadId: "thr_3",
      seq: 0,
    });

    // `seq` is a zero-based counter and 0 is falsy: a truthiness guard added
    // beside the ruling-99 one would silently swallow the opening line of every
    // run, and the console would sit empty until the second line arrived.
    expect(page.names()).toContain("run.log-appended");
  });

  it("ruling 99: a controller turn (project_slug = \"\") publishes nothing at all", () => {
    // Every signed-in user's Home page holds a `projects` firehose connection,
    // and `routeMatchesConnection` matches that scope on ANY defined slug — ""
    // included. This is the leak the guard exists to stop, so the firehose is
    // the connection that has to stay silent.
    const home = connect([{ kind: "projects" }]);
    const owner = connect([{ kind: "user" }]);
    const board = connect([{ kind: "project", slug: "viberr-core" }]);
    const headBefore = getSseBrokerStats().headId;

    publishRunLogAppended({
      // Exactly what `startController`'s StartRunInput carries: no project, and
      // the conversation id standing in for a task key.
      projectSlug: "",
      taskKey: "cconv_01H8XABCDEF",
      runId: "run_ctl",
      threadId: "thr_ctl",
      seq: 4,
    });

    expect(home.names()).not.toContain("run.log-appended");
    expect(owner.names()).not.toContain("run.log-appended");
    expect(board.names()).not.toContain("run.log-appended");
    // Nothing entered the ring buffer either: a buffered event is replayed to
    // any client reconnecting with a Last-Event-ID behind it, so "nobody was
    // listening right now" would not be enough.
    const stats = getSseBrokerStats();
    expect(stats.headId).toBe(headBefore);
    expect(stats.bufferedEvents).toBe(0);
  });
});

describe("publishRunStateChanged", () => {
  it("publishes the new lifecycle so the run strip flips without a reload", () => {
    const page = connect([{ kind: "task", slug: "viberr-core", key: "VIB-42" }]);

    publishRunStateChanged({
      projectSlug: "viberr-core",
      taskKey: "VIB-42",
      runId: "run_9",
      threadId: "thr_3",
      state: "running",
    });
    publishRunStateChanged({
      projectSlug: "viberr-core",
      taskKey: "VIB-42",
      runId: "run_9",
      threadId: "thr_3",
      state: "error",
    });

    // Unlike the log event this one is NOT reference-only: it carries the
    // lifecycle itself, because the pill/strip flip on it directly. A publisher
    // that stopped sending `state` (or sent a stale one) would leave a finished
    // run spinning "running" until the user reloaded the page.
    expect(page.names()).toEqual([
      "stream.open",
      "run.state-changed",
      "run.state-changed",
    ]);
    const states = dataLines(page.writes)
      .slice(1)
      .map((line) => sseEventSchema.parse(JSON.parse(line)))
      .map((event) => (event.type === "run.state-changed" ? event.data.state : null));
    expect(states).toEqual(["running", "error"]);
    const payload: unknown = JSON.parse(dataLines(page.writes).at(-1)!);
    expect(payload).toEqual({
      type: "run.state-changed",
      entityId: "viberr-core/VIB-42",
      occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      data: {
        projectSlug: "viberr-core",
        taskKey: "VIB-42",
        runId: "run_9",
        threadId: "thr_3",
        state: "error",
      },
    });
  });

  it("ruling 99: a controller turn's state changes stay off the stream too", () => {
    // Same guard, second function — the controller run settles through
    // `publishState` in the sink on exactly the same spec, so a guard fixed in
    // one publisher and forgotten in the other still leaks the whole turn
    // (queued → running → finished).
    const home = connect([{ kind: "projects" }]);
    const headBefore = getSseBrokerStats().headId;

    for (const state of ["queued", "running", "finished"] as const) {
      publishRunStateChanged({
        projectSlug: "",
        taskKey: "cconv_01H8XABCDEF",
        runId: "run_ctl",
        threadId: "thr_ctl",
        state,
      });
    }

    expect(home.names()).not.toContain("run.state-changed");
    const stats = getSseBrokerStats();
    expect(stats.headId).toBe(headBefore);
    expect(stats.bufferedEvents).toBe(0);
  });
});

describe("wire contract", () => {
  it("both events satisfy the SSE schema — nothing downstream checks them", () => {
    const page = connect([{ kind: "task", slug: "viberr-core", key: "VIB-42" }]);

    publishRunLogAppended({
      projectSlug: "viberr-core",
      taskKey: "VIB-42",
      runId: "run_9",
      threadId: "thr_3",
      seq: 2,
    });
    publishRunStateChanged({
      projectSlug: "viberr-core",
      taskKey: "VIB-42",
      runId: "run_9",
      threadId: "thr_3",
      state: "finished",
    });

    // The projection path parses every event before publishing; this path does
    // not, so an event shaped wrong here reaches browsers as-is and the client
    // union (`event-types.ts` mirrors this schema) mis-handles it. Parsing here
    // is the substitute for the validator this path skips — and it is also what
    // makes the ruling-99 guard necessary rather than merely tidy: the same
    // parse of a `projectSlug: ""` payload fails on `min(1)`.
    const events = dataLines(page.writes).slice(1);
    expect(events).toHaveLength(2);
    for (const line of events) {
      expect(() => sseEventSchema.parse(JSON.parse(line))).not.toThrow();
    }
  });
});
