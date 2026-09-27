import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SseEvent } from "~/schemas/sse-event.schema";
import { sseScopes } from "~/features/live-updates/event-types";
import {
  acquireDataRootLock,
  heldDataRootLock,
} from "~/server/db/data-root-lock.server";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  closeAllSseConnections,
  connectSseClient,
  getSseBrokerStats,
  HEARTBEAT_CHUNK,
  HEARTBEAT_INTERVAL_MS,
  parseSseScope,
  publishSseEvent,
  resetSseBrokerForTests,
  RING_BUFFER_SIZE,
  STREAM_RING_BUFFER_SIZE,
  runProcessShutdown,
  type SseScope,
} from "./sse-broker.server";

const lockCtx = createTestDbContext();

function taskEvent(slug: string, key: string): SseEvent {
  return {
    type: "task.updated",
    entityId: `${slug}/${key}`,
    occurredAt: new Date().toISOString(),
    data: { projectSlug: slug, taskKey: key, stage: "impl", readiness: "ready" },
  };
}

function notificationEvent(userId: string): SseEvent {
  return {
    type: "notification.created",
    entityId: userId,
    occurredAt: new Date().toISOString(),
    data: { userId },
  };
}

function rebuiltEvent(): SseEvent {
  return {
    type: "projection.rebuilt",
    entityId: "store",
    occurredAt: new Date().toISOString(),
    data: { scope: "full", changed: 3 },
  };
}

interface TestClient {
  writes: string[];
  handle: ReturnType<typeof connectSseClient>;
  closed: boolean;
  /** Event names received (data messages only, comments skipped). */
  names(): string[];
}

function connect(
  userId: string,
  scopes: SseScope[],
  options: { lastEventId?: number | null; failWrites?: boolean } = {},
): TestClient {
  const writes: string[] = [];
  // A failing hello write drops the connection INSIDE `connectSseClient`, so
  // `onClose` can fire before the client object exists — it records into this
  // holder, which the client then exposes.
  const lifecycle = { closed: false };
  const handle = connectSseClient({
    userId,
    scopes,
    lastEventId: options.lastEventId ?? null,
    write: (chunk) => {
      if (options.failWrites) throw new Error("boom");
      writes.push(chunk);
    },
    onClose: () => {
      lifecycle.closed = true;
    },
  });
  const client: TestClient = {
    writes,
    get closed() {
      return lifecycle.closed;
    },
    handle,
    names() {
      return this.writes
        .flatMap((w) => w.split("\n"))
        .filter((line) => line.startsWith("event: "))
        .map((line) => line.slice("event: ".length));
    },
  };
  return client;
}

beforeEach(() => resetSseBrokerForTests());
afterEach(() => {
  resetSseBrokerForTests();
  lockCtx.cleanup();
  vi.useRealTimers();
});

describe("parseSseScope", () => {
  it("parses the four scope forms", () => {
    expect(parseSseScope("user")).toEqual({ kind: "user" });
    expect(parseSseScope("projects")).toEqual({ kind: "projects" });
    expect(parseSseScope("project:viberr-core")).toEqual({
      kind: "project",
      slug: "viberr-core",
    });
    expect(parseSseScope("task:viberr-core/VIB-142")).toEqual({
      kind: "task",
      slug: "viberr-core",
      key: "VIB-142",
    });
  });

  it("rejects malformed scopes", () => {
    for (const bad of [
      "",
      "users",
      "projectss",
      "projects:",
      "project:",
      "task:viberr-core",
      "task:viberr-core/",
      "project:has space",
      "task:a/b/c",
      "project:../../etc",
    ]) {
      expect(parseSseScope(bad), bad).toBeNull();
    }
  });

  it("every client-side sseScopes helper produces a parseable scope (contract)", () => {
    expect(parseSseScope(sseScopes.user())).not.toBeNull();
    expect(parseSseScope(sseScopes.allProjects())).not.toBeNull();
    expect(parseSseScope(sseScopes.project("viberr-core"))).not.toBeNull();
    expect(parseSseScope(sseScopes.task("viberr-core", "VIB-1"))).not.toBeNull();
  });
});

describe("scope filtering", () => {
  it("delivers project-routed events to matching project scopes only", () => {
    const core = connect("u1", [{ kind: "project", slug: "viberr-core" }]);
    const other = connect("u1", [{ kind: "project", slug: "billing-service" }]);

    publishSseEvent(taskEvent("viberr-core", "VIB-1"), {
      projectSlug: "viberr-core",
      taskKey: "VIB-1",
    });

    expect(core.names()).toContain("task.updated");
    expect(other.names()).not.toContain("task.updated");
  });

  it("task scope matches its own task + project-level events, not siblings", () => {
    const conn = connect("u1", [
      { kind: "task", slug: "viberr-core", key: "VIB-1" },
    ]);

    publishSseEvent(taskEvent("viberr-core", "VIB-1"), {
      projectSlug: "viberr-core",
      taskKey: "VIB-1",
    });
    publishSseEvent(taskEvent("viberr-core", "VIB-2"), {
      projectSlug: "viberr-core",
      taskKey: "VIB-2",
    });
    publishSseEvent(
      {
        type: "project.updated",
        entityId: "viberr-core",
        occurredAt: new Date().toISOString(),
        data: { projectSlug: "viberr-core" },
      },
      { projectSlug: "viberr-core" },
    );

    const names = conn.names();
    expect(names.filter((n) => n === "task.updated")).toHaveLength(1);
    expect(names).toContain("project.updated");
  });

  it("the `projects` scope receives every project/task-routed event (E2 — Home)", () => {
    const home = connect("u1", [{ kind: "projects" }]);

    publishSseEvent(taskEvent("viberr-core", "VIB-1"), {
      projectSlug: "viberr-core",
      taskKey: "VIB-1",
    });
    publishSseEvent(taskEvent("billing-service", "BIL-9"), {
      projectSlug: "billing-service",
      taskKey: "BIL-9",
    });
    publishSseEvent(
      {
        type: "project.updated",
        entityId: "viberr-core",
        occurredAt: new Date().toISOString(),
        data: { projectSlug: "viberr-core" },
      },
      { projectSlug: "viberr-core" },
    );

    const names = home.names();
    expect(names.filter((n) => n === "task.updated")).toHaveLength(2);
    expect(names).toContain("project.updated");

    // …but never user-targeted events (those stay `user`-scope + same user).
    publishSseEvent(notificationEvent("u1"), { userId: "u1" });
    expect(home.names()).not.toContain("notification.created");
  });

  it("user-targeted events reach ONLY that user's user-scoped connections", () => {
    const ardaUser = connect("u_arda", [{ kind: "user" }]);
    const elifUser = connect("u_elif", [{ kind: "user" }]);
    // Arda again, but without a user scope — must not receive it either.
    const ardaProject = connect("u_arda", [
      { kind: "project", slug: "viberr-core" },
    ]);

    publishSseEvent(notificationEvent("u_arda"), { userId: "u_arda" });

    expect(ardaUser.names()).toContain("notification.created");
    expect(elifUser.names()).not.toContain("notification.created");
    expect(ardaProject.names()).not.toContain("notification.created");
  });

  it("broadcast events reach every connection", () => {
    const a = connect("u1", [{ kind: "user" }]);
    const b = connect("u2", [{ kind: "project", slug: "x" }]);

    publishSseEvent(rebuiltEvent(), { broadcast: true });

    expect(a.names()).toContain("projection.rebuilt");
    expect(b.names()).toContain("projection.rebuilt");
  });
});

describe("wire format", () => {
  it("messages carry id, event name and single-line JSON data", () => {
    const conn = connect("u1", [{ kind: "project", slug: "p" }]);
    const id = publishSseEvent(taskEvent("p", "K-1"), {
      projectSlug: "p",
      taskKey: "K-1",
    });

    const message = conn.writes.at(-1)!;
    expect(message).toMatch(/^id: \d+\nevent: task\.updated\ndata: \{.*\}\n\n$/);
    expect(message.startsWith(`id: ${id}\n`)).toBe(true);
    const payload: unknown = JSON.parse(message.match(/^data: (.*)$/m)![1]!);
    expect(payload).toMatchObject({
      type: "task.updated",
      entityId: "p/K-1",
      data: { projectSlug: "p", taskKey: "K-1", stage: "impl", readiness: "ready" },
    });
  });

  it("hello is a stream.open event whose id equals the current head", () => {
    const head = publishSseEvent(rebuiltEvent(), { broadcast: true });
    const conn = connect("u1", [{ kind: "user" }]);

    const hello = conn.writes[0]!;
    expect(hello).toContain("retry: 5000\n");
    expect(hello).toContain(`id: ${head}\n`);
    expect(hello).toContain("event: stream.open\n");
    expect(hello).toContain(`"headId":${head}`);
  });
});

describe("ring buffer replay (Last-Event-ID)", () => {
  it("replays missed scope-matching events after the given id", () => {
    // Ids count from the process's base (ruling 457, RV-5).
    const base = getSseBrokerStats().headId;
    publishSseEvent(taskEvent("p", "K-1"), { projectSlug: "p", taskKey: "K-1" }); // 1
    publishSseEvent(taskEvent("p", "K-2"), { projectSlug: "p", taskKey: "K-2" }); // 2
    publishSseEvent(taskEvent("q", "Q-1"), { projectSlug: "q", taskKey: "Q-1" }); // 3
    publishSseEvent(taskEvent("p", "K-3"), { projectSlug: "p", taskKey: "K-3" }); // 4

    const conn = connect("u1", [{ kind: "project", slug: "p" }], {
      lastEventId: base + 1,
    });

    // Hello + events 2 and 4 (3 is another project's).
    const ids = conn.writes
      .flatMap((w) => w.split("\n"))
      .filter((l) => l.startsWith("id: "))
      .map((l) => Number(l.slice(4)) - base);
    expect(ids).toEqual([4, 2, 4]); // hello head id, then replayed 2 and 4
    expect(conn.names()).toEqual(["stream.open", "task.updated", "task.updated"]);
    expect(conn.writes.at(-1)).toContain("K-3");
  });

  it("replay respects user targeting", () => {
    const base = getSseBrokerStats().headId;
    publishSseEvent(notificationEvent("u_arda"), { userId: "u_arda" }); // 1
    publishSseEvent(notificationEvent("u_elif"), { userId: "u_elif" }); // 2

    const elif = connect("u_elif", [{ kind: "user" }], { lastEventId: base });
    expect(elif.names()).toEqual(["stream.open", "notification.created"]);
    expect(elif.writes.at(-1)).toContain("u_elif");
    expect(elif.writes.join("")).not.toContain("u_arda");
  });

  it("sends stream.resync when the id predates the buffer window", () => {
    const base = getSseBrokerStats().headId;
    for (let i = 0; i < RING_BUFFER_SIZE + 10; i += 1) {
      publishSseEvent(rebuiltEvent(), { broadcast: true });
    }
    // Oldest buffered id is now 11 — lastEventId 3 cannot be caught up.
    const conn = connect("u1", [{ kind: "user" }], { lastEventId: base + 3 });
    expect(conn.names()).toEqual(["stream.open", "stream.resync"]);
    // And 10, the newest id the ring let go of, can: 11 onwards is replayed.
    const edge = connect("u1", [{ kind: "user" }], { lastEventId: base + 10 });
    expect(edge.names().filter((n) => n === "projection.rebuilt")).toHaveLength(RING_BUFFER_SIZE);
    // 9, one short of the edge, is gone: the ring holds exactly RING_BUFFER_SIZE.
    const past = connect("u1", [{ kind: "user" }], { lastEventId: base + 9 });
    expect(past.names()).toEqual(["stream.open", "stream.resync"]);
  });

  it("sends stream.resync when the id is from a previous server life", () => {
    const conn = connect("u1", [{ kind: "user" }], { lastEventId: 42 });
    expect(conn.names()).toEqual(["stream.open", "stream.resync"]);
  });

  /**
   * Ruling 457 (RV-5): a tab's position from before a restart. The new
   * process's ids used to start at 1 again, so once it had published past the
   * old position, the position read as one of its own: the broker replayed only
   * what came after it, and the change the new process made earlier (id 5
   * here, this board's project) never reached the tab.
   */
  it("sends stream.resync for a position from before a restart, however far the new process has got", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-24T10:00:00.000Z"));
    for (let i = 0; i < 300; i += 1) publishSseEvent(rebuiltEvent(), { broadcast: true });
    const beforeRestart = getSseBrokerStats().headId;

    // The process restarts a minute later and publishes 400 events, the 5th
    // of them on the project this tab shows.
    resetSseBrokerForTests();
    vi.setSystemTime(new Date("2026-09-24T10:01:00.000Z"));
    for (let i = 1; i <= 400; i += 1) {
      if (i === 5) publishSseEvent(taskEvent("a", "A-1"), { projectSlug: "a", taskKey: "A-1" });
      else publishSseEvent(rebuiltEvent(), { projectSlug: "elsewhere" });
    }

    const conn = connect("u1", [{ kind: "project", slug: "a" }, { kind: "user" }], {
      lastEventId: beforeRestart,
    });
    // CANARY: start every process's ids at 0 and the old position reads as
    // covered: no resync, and the id-5 change is never replayed.
    expect(conn.names()).toEqual(["stream.open", "stream.resync"]);
  });

  /**
   * Ruling 457 (RV-3): console lines (`run.log-appended`, one per line of a
   * run) used to share the one 256-event ring with every data event, and a
   * stream's position only moves on events in its own scopes. So a board left
   * open while the agent it shows printed 300 lines stood at a position the
   * ring no longer reached, and opening that task answered `stream.resync`: the
   * page reloaded everything to catch up on lines its console reads by itself.
   */
  it("keeps console lines in a ring of their own, so a busy run cannot push a data event out of replay", () => {
    const standing = publishSseEvent(taskEvent("p", "K-2"), { projectSlug: "p", taskKey: "K-2" });
    for (let seq = 1; seq <= 300; seq += 1) {
      publishSseEvent(
        {
          type: "run.log-appended",
          entityId: "p/K-1",
          occurredAt: new Date().toISOString(),
          data: { projectSlug: "p", taskKey: "K-1", runId: "run_1", threadId: "primary", seq },
        },
        { projectSlug: "p", taskKey: "K-1", taskOnly: true },
      );
    }
    publishSseEvent(taskEvent("p", "K-3"), { projectSlug: "p", taskKey: "K-3" });

    // The board stood at `standing`; the person opens K-1.
    const conn = connect("u1", [{ kind: "project", slug: "p" }, { kind: "task", slug: "p", key: "K-1" }], {
      lastEventId: standing,
    });
    // CANARY: put console lines back in the data ring and this is a resync.
    expect(conn.names()).not.toContain("stream.resync");
    expect(conn.names().filter((n) => n === "task.updated")).toHaveLength(1);
    expect(conn.writes.at(-1)).toContain("K-3");
    // The newest console lines replay too, in id order (the console reads
    // any older ones through its own cursor).
    expect(conn.names().filter((n) => n === "run.log-appended")).toHaveLength(STREAM_RING_BUFFER_SIZE);
    const ids = conn.writes
      .slice(1)
      .map((w) => Number(/^id: (\d+)$/m.exec(w)?.[1]));
    expect(ids).toEqual(ids.toSorted((a, b) => a - b));
  });
});

describe("heartbeat", () => {
  it("writes a comment chunk every interval", () => {
    vi.useFakeTimers();
    const conn = connect("u1", [{ kind: "user" }]);
    const before = conn.writes.length;

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(conn.writes.length).toBe(before + 1);
    expect(conn.writes.at(-1)).toBe(HEARTBEAT_CHUNK);
    // Comment format: starts with ":", terminated by a blank line.
    expect(conn.writes.at(-1)!.startsWith(":")).toBe(true);
    expect(conn.writes.at(-1)!.endsWith("\n\n")).toBe(true);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(conn.writes.length).toBe(before + 2);
  });

  it("stops after close", () => {
    vi.useFakeTimers();
    const conn = connect("u1", [{ kind: "user" }]);
    conn.handle.close();
    const count = conn.writes.length;
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    expect(conn.writes.length).toBe(count);
  });

  /**
   * Subscription authority is decided when the stream opens, and an SSE
   * stream never ends on its own. Without a re-check, a member removed from a
   * project (or an admin demoted) keeps receiving that project's live events
   * for as long as the tab stays open.
   */
  it("re-authorizes scopes on each beat and drops a connection that lost them all", () => {
    vi.useFakeTimers();
    let allowed: SseScope[] = [
      { kind: "project", slug: "alpha" },
      { kind: "project", slug: "beta" },
    ];
    const writes: string[] = [];
    const lifecycle = { closed: false };
    const handle = connectSseClient({
      userId: "u1",
      scopes: allowed,
      lastEventId: null,
      write: (chunk) => writes.push(chunk),
      onClose: () => {
        lifecycle.closed = true;
      },
      reauthorize: () => allowed,
    });

    publishSseEvent(rebuiltEvent(), { projectSlug: "beta" });
    const afterFirst = writes.length;
    expect(afterFirst).toBeGreaterThan(0);

    // Removed from beta, still a member of alpha.
    allowed = [{ kind: "project", slug: "alpha" }];
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    const afterBeat = writes.length;
    publishSseEvent(rebuiltEvent(), { projectSlug: "beta" });
    expect(writes.length).toBe(afterBeat); // beta no longer reaches them
    publishSseEvent(rebuiltEvent(), { projectSlug: "alpha" });
    expect(writes.length).toBeGreaterThan(afterBeat); // alpha still does

    // Removed from everything: the stream closes rather than idling on with
    // scopes its user no longer holds.
    allowed = [];
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(lifecycle.closed).toBe(true);
    handle.close();
  });
});

describe("drop-and-close on failed write", () => {
  it("a throwing write drops the connection and calls onClose once", () => {
    const bad = connect("u1", [{ kind: "user" }], { failWrites: true });
    // Hello write already failed → dropped before it ever registered.
    expect(bad.closed).toBe(true);
    expect(getSseBrokerStats().connections).toBe(0);
  });

  it("a connection that starts failing mid-stream is removed", () => {
    let fail = false;
    let closed = 0;
    connectSseClient({
      userId: "u1",
      scopes: [{ kind: "user" }],
      write: () => {
        if (fail) throw new Error("EPIPE");
      },
      onClose: () => {
        closed += 1;
      },
    });
    expect(getSseBrokerStats().connections).toBe(1);

    fail = true;
    publishSseEvent(rebuiltEvent(), { broadcast: true });
    expect(getSseBrokerStats().connections).toBe(0);
    expect(closed).toBe(1);

    // Further publishes never touch the dropped connection again.
    publishSseEvent(rebuiltEvent(), { broadcast: true });
    expect(closed).toBe(1);
  });
});

describe("shutdown", () => {
  it("closeAllSseConnections closes everything", () => {
    const a = connect("u1", [{ kind: "user" }]);
    const b = connect("u2", [{ kind: "project", slug: "p" }]);
    closeAllSseConnections();
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
    expect(getSseBrokerStats().connections).toBe(0);
  });

  // G1: the SIGINT/SIGTERM handler ends in a re-raise, so Node's `exit` event
  // never fires — everything the process owes the disk has to happen HERE. A
  // stranded writer.lock is what bricks the next `docker compose up`.
  it("the shutdown sequence closes connections AND releases the data-root writer lock", () => {
    const dataRoot = lockCtx.makeTempDir();
    const lock = acquireDataRootLock({
      dataRoot,
      self: { pid: 4242, hostname: "viberr", startedAt: "2026-07-28T10:00:00.000Z" },
      isAlive: () => true,
    });
    expect(existsSync(lock.path)).toBe(true);
    const conn = connect("u1", [{ kind: "user" }]);

    runProcessShutdown();

    expect(conn.closed).toBe(true);
    expect(existsSync(lock.path)).toBe(false);
    expect(heldDataRootLock()).toBeNull();
  });
});
