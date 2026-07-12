import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";

/**
 * Route-level tests for GET /resources/events: auth gating, scope
 * validation, SSE headers, and a real published event flowing through the
 * Response's ReadableStream.
 */

let app: AppTestContext;
let userId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { insertUser } = await import("~/server/auth/user-store.server");
  const user = insertUser(app.db, {
    id: "u_sse_test_user",
    email: "sse@viberr.dev",
    name: "Sse Tester",
    role: "member",
  });
  userId = user.id;
  // Full D9: an explicit project scope now requires project membership. Seed a
  // minimal viberr-core projection + membership so the replay/scope tests below
  // exercise the member path (a dedicated non-member 403 test lives further down).
  app.db
    .prepare(
      `INSERT OR IGNORE INTO projects (slug, name, task_prefix, stages_json, workflow_json, source_path, content_hash, parsed_at)
       VALUES ('viberr-core', 'Viberr Core', 'VIB', '[]', '[]', 'projects/viberr-core/project.md', 'h', '2026-07-04T00:00:00Z')`,
    )
    .run();
  app.db
    .prepare(
      `INSERT OR REPLACE INTO project_members (project_slug, user_id, role) VALUES (?, ?, ?)`,
    )
    .run("viberr-core", userId, "contributor");
});
afterAll(async () => {
  const { resetSseBrokerForTests } = await import(
    "~/server/events/sse-broker.server"
  );
  const { stopEventPublisherForTests } = await import(
    "~/server/events/event-publisher.server"
  );
  stopEventPublisherForTests();
  resetSseBrokerForTests();
  app.cleanup();
});
afterEach(async () => {
  const { closeAllSseConnections } = await import(
    "~/server/events/sse-broker.server"
  );
  closeAllSseConnections();
});

async function callLoader(url: string, init: { cookie?: string; headers?: HeadersInit; signal?: AbortSignal } = {}) {
  const { loader } = await import("~/routes/resources.events");
  const requestInit: RequestInit & { cookie?: string } = {};
  if (init.cookie) requestInit.cookie = init.cookie;
  if (init.headers) requestInit.headers = init.headers;
  if (init.signal) requestInit.signal = init.signal;
  const request = app.request(url, requestInit);
  return loader({ request, params: {}, context: {} } as never);
}

describe("/resources/events", () => {
  it("401s when signed out (EventSource can't follow a login redirect)", async () => {
    const res = (await callLoader("/resources/events?scope=user")) as Response;
    expect(res.status).toBe(401);
  });

  it("400s on missing or malformed scopes", async () => {
    const { cookie } = await app.cookieFor(userId);
    const missing = (await callLoader("/resources/events", { cookie })) as Response;
    expect(missing.status).toBe(400);
    const malformed = (await callLoader("/resources/events?scope=banana:split", {
      cookie,
    })) as Response;
    expect(malformed.status).toBe(400);
  });

  it("403s a non-member naming a foreign project scope (full D9)", async () => {
    const { insertUser } = await import("~/server/auth/user-store.server");
    const outsider = insertUser(app.db, {
      id: "u_sse_outsider",
      email: "outsider@viberr.dev",
      name: "Out Sider",
      role: "member",
    });
    const { cookie } = await app.cookieFor(outsider.id);
    // Non-member of viberr-core → denied.
    const denied = (await callLoader(
      "/resources/events?scope=project:viberr-core",
      { cookie },
    )) as Response;
    expect(denied.status).toBe(403);
    // A task scope in the same project is likewise denied.
    const deniedTask = (await callLoader(
      "/resources/events?scope=task:viberr-core/VIB-139",
      { cookie },
    )) as Response;
    expect(deniedTask.status).toBe(403);
    // Their own `user` scope still works (that's their targeted events).
    const own = (await callLoader("/resources/events?scope=user", { cookie })) as Response;
    expect(own.status).toBe(200);
    own.body?.cancel();
  });

  it("org admin may subscribe to any project scope (bypass)", async () => {
    const { insertUser } = await import("~/server/auth/user-store.server");
    const orgAdmin = insertUser(app.db, {
      id: "u_sse_orgadmin",
      email: "orgadmin@viberr.dev",
      name: "Org Admin",
      role: "admin",
    });
    const { cookie } = await app.cookieFor(orgAdmin.id);
    const res = (await callLoader(
      "/resources/events?scope=project:viberr-core",
      { cookie },
    )) as Response;
    expect(res.status).toBe(200);
    res.body?.cancel();
  });

  it("streams: SSE headers, hello first, then published events", async () => {
    const { cookie } = await app.cookieFor(userId);
    const abort = new AbortController();
    const res = (await callLoader(
      "/resources/events?scope=project:viberr-core&scope=user",
      { cookie, signal: abort.signal },
    )) as Response;

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain("event: stream.open");
    expect(first).toContain("retry: 5000");

    // Publish through the emitter → publisher → broker → this stream.
    const { startEventPublisher } = await import(
      "~/server/events/event-publisher.server"
    );
    const { emitProjectionEvent } = await import(
      "~/server/events/projection-events.server"
    );
    startEventPublisher();
    emitProjectionEvent({
      type: "notification.created",
      userId,
      occurredAt: new Date().toISOString(),
    });

    const second = decoder.decode((await reader.read()).value);
    expect(second).toContain("event: notification.created");
    expect(second).toContain(userId);

    // Client disconnect (abort) closes the broker connection.
    const { getSseBrokerStats } = await import(
      "~/server/events/sse-broker.server"
    );
    expect(getSseBrokerStats().connections).toBe(1);
    abort.abort();
    expect(getSseBrokerStats().connections).toBe(0);
    const done = await reader.read();
    expect(done.done).toBe(true);
  });

  it("replays from ?lastEventId= (wrapper reconnect path)", async () => {
    const { publishSseEvent, getSseBrokerStats } = await import(
      "~/server/events/sse-broker.server"
    );
    const head = getSseBrokerStats().headId;
    publishSseEvent(
      {
        type: "task.updated",
        entityId: "viberr-core/VIB-1",
        occurredAt: new Date().toISOString(),
        data: {
          projectSlug: "viberr-core",
          taskKey: "VIB-1",
          stage: "impl",
          readiness: "ready",
        },
      },
      { projectSlug: "viberr-core", taskKey: "VIB-1" },
    );

    const { cookie } = await app.cookieFor(userId);
    const res = (await callLoader(
      `/resources/events?scope=project:viberr-core&lastEventId=${head}`,
      { cookie },
    )) as Response;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("task.updated")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    expect(text).toContain("event: stream.open");
    expect(text).toContain("event: task.updated");
    expect(text).toContain("VIB-1");
    await reader.cancel();
  });
});
