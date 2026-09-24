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

function connect(scopes: SseScope[], userId = "u_watcher"): TestClient {
  const writes: string[] = [];
  connectSseClient({
    userId,
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
    // Ruling 457 (LIVE-5): a project-scoped subscriber (the board) no longer
    // receives a console line: nothing it renders changes per line, and the
    // one reader, the console of the task's own page, holds the task scope.
    // CANARY: drop `taskOnly` from publishRunLogAppended.
    expect(project.names()).not.toContain("run.log-appended");
    expect(foreign.names()).not.toContain("run.log-appended");
    expect(inbox.names()).not.toContain("run.log-appended");
  });

  it("stays OFF the all-projects firehose — Home does not revalidate per console line", () => {
    // `routeMatchesConnection` returns true for `projects` on ANY defined
    // slug, and `run.log-appended` is one reference per LINE of run output, so
    // Home (which subscribes the firehose for its cross-project view) re-ran
    // its loaders once per line of every agent run on the instance.
    // Task-scoped delivery is deliberate and stays (above).
    // Canary: drop `taskOnly: true` from publishRunLogAppended and the
    // firehose below receives it again.
    const firehose = connect([{ kind: "projects" }]);
    const own = connect([{ kind: "task", slug: "viberr-core", key: "VIB-42" }]);

    publishRunLogAppended({
      projectSlug: "viberr-core",
      taskKey: "VIB-42",
      runId: "run_10",
      threadId: "thr_4",
      seq: 2,
    });

    expect(firehose.names()).not.toContain("run.log-appended");
    expect(own.names()).toContain("run.log-appended");

    // …while the lifecycle event, which fires a handful of times per run and
    // IS a project fact, still reaches Home.
    publishRunStateChanged({
      projectSlug: "viberr-core",
      taskKey: "VIB-42",
      runId: "run_10",
      threadId: "thr_4",
      state: "finished",
    });
    expect(firehose.names()).toContain("run.state-changed");
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

/**
 * Ruling 99, the other half: a controller turn DOES stream — to its owner.
 *
 * The guard above keeps a controller run off the project routes; without a
 * route of its own the controller page had no console at all (the run row
 * existed, the lines were stored, nobody was told). The sink now resolves the
 * conversation behind the run once (`controllerRunRoute`) and these publishers
 * route the same reference-only frame to that person's `user` stream as
 * `controller.log-appended`, and a lifecycle flip as the `controller.updated`
 * reference the page already revalidates on.
 */
describe("a controller run's frames route to the conversation owner", () => {
  const route = { conversationId: "cconv_01H8XABCDEF", userId: "u_owner" };

  it("a console line reaches the owner's user stream, and nobody else", () => {
    // Canary: drop the `input.controller` arm of publishRunLogAppended — the
    // empty-slug guard then swallows the frame and the owner sees nothing.
    const owner = connect([{ kind: "user" }], "u_owner");
    const stranger = connect([{ kind: "user" }], "u_other");
    const home = connect([{ kind: "projects" }], "u_owner");
    const board = connect([{ kind: "project", slug: "viberr-core" }], "u_owner");

    publishRunLogAppended({
      projectSlug: "",
      taskKey: route.conversationId,
      runId: "run_ctl",
      threadId: "thr_ctl",
      seq: 4,
      controller: route,
    });

    expect(owner.names()).toEqual(["stream.open", "controller.log-appended"]);
    expect(stranger.names()).not.toContain("controller.log-appended");
    // The person's own Home firehose and board stream are not `user`-scoped
    // connections: the frame is for the console, which subscribes `user`.
    expect(home.names()).not.toContain("controller.log-appended");
    expect(board.names()).not.toContain("controller.log-appended");
    // Reference-only, like the task frame, and valid on the wire — this path
    // has no validator downstream (see the file comment).
    const payload = sseEventSchema.parse(JSON.parse(dataLines(owner.writes).at(-1)!));
    expect(payload).toEqual({
      type: "controller.log-appended",
      entityId: route.conversationId,
      occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      data: {
        conversationId: route.conversationId,
        userId: "u_owner",
        runId: "run_ctl",
        threadId: "thr_ctl",
        seq: 4,
      },
    });
  });

  it("a lifecycle change reaches the owner as the conversation reference", () => {
    // Canary: drop the `input.controller` arm of publishRunStateChanged.
    const owner = connect([{ kind: "user" }], "u_owner");
    const stranger = connect([{ kind: "user" }], "u_other");

    publishRunStateChanged({
      projectSlug: "",
      taskKey: route.conversationId,
      runId: "run_ctl",
      threadId: "thr_ctl",
      state: "running",
      controller: route,
    });

    expect(owner.names()).toEqual(["stream.open", "controller.updated"]);
    expect(stranger.names()).toEqual(["stream.open"]);
    const payload = sseEventSchema.parse(JSON.parse(dataLines(owner.writes).at(-1)!));
    expect(payload.type).toBe("controller.updated");
    expect(payload.data).toEqual({ conversationId: route.conversationId, userId: "u_owner" });
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
