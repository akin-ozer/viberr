import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";

/**
 * Phase 10 route-level coverage:
 * - Home loader org tile: REAL KB/MCP/skill counts from the 0008 tables
 *   (the phase-4 loader predated them — honest zeros closed here).
 * - Home `rebuild-projections` intent: admin-only full drop + rebuild with
 *   identical counts and an audit row.
 * - /resources/health: `{ ok, projections: { projects, tasks }, watcher }`.
 */

let app: AppTestContext;
let ardaId: string;
let denizId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("~/server/seed/demo-seed.server");
  runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { seedOrgResources } = await import("~/server/org/org-seed.server");
  seedOrgResources(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id; // org admin
  denizId = findUserByEmail(app.db, "deniz@viberr.dev")!.id; // org member
});
afterAll(() => app.cleanup());

async function runHomeLoader(cookie: string) {
  const { loader } = await import("~/routes/_index");
  return loader({
    request: app.request("/", { cookie }),
    params: {},
    context: {},
  } as never) as Promise<{
    org: {
      knowledgeBases: number;
      mcpServers: number;
      skills: number;
      globalAgents: number;
    };
  }>;
}

async function postHome(
  userId: string,
  fields: Record<string, string>,
): Promise<Response | Record<string, unknown>> {
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  const body = new URLSearchParams({ _csrf: csrf, ...fields });
  const { action } = await import("~/routes/_index");
  return action({
    request: app.request("/", {
      method: "POST",
      cookie,
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
    params: {},
    context: {},
  } as never) as Promise<Response | Record<string, unknown>>;
}

describe("home org tile counts (Phase 10)", () => {
  it("counts KBs / MCP servers / skills from the real 0008 tables", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const data = await runHomeLoader(cookie);
    // seedOrgResources: 3 KBs · 3 MCP rows · 4 skills (9B report).
    expect(data.org.knowledgeBases).toBe(3);
    expect(data.org.mcpServers).toBe(3);
    expect(data.org.skills).toBe(4);
    expect(data.org.globalAgents).toBeGreaterThan(0);
  });
});

describe("rebuild-projections intent (Phase 10 recovery)", () => {
  it("refuses non-admins with a 403", async () => {
    const result = await postHome(denizId, { intent: "rebuild-projections" });
    const status = (result as { init?: { status?: number } }).init?.status;
    expect(status).toBe(403);
  });

  it("admin rebuild drops + re-projects to identical counts and audits", async () => {
    const counts = () => ({
      projects: (
        app.db.prepare(`SELECT count(*) c FROM projects`).get() as {
          c: number;
        }
      ).c,
      tasks: (
        app.db.prepare(`SELECT count(*) c FROM task_projections`).get() as {
          c: number;
        }
      ).c,
      events: (
        app.db.prepare(`SELECT count(*) c FROM task_events`).get() as {
          c: number;
        }
      ).c,
    });
    const before = counts();
    expect(before.projects).toBe(3); // seeded demo dataset
    expect(before.tasks).toBe(10);

    const result = (await postHome(ardaId, {
      intent: "rebuild-projections",
    })) as { ok: boolean; projects: number; tasks: number; errors: number };
    expect(result.ok).toBe(true);
    expect(result.projects).toBe(before.projects);
    expect(result.tasks).toBe(before.tasks);
    expect(result.errors).toBe(0);
    expect(counts()).toEqual(before);

    const { listAuditEvents } = await import(
      "~/server/audit/audit-recorder.server"
    );
    const rows = listAuditEvents(app.db, { action: "projection.rebuild" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.actorUserId).toBe(ardaId);
  });
});

describe("/resources/health (Phase 10 ops probe)", () => {
  it("returns ok + projection counts + watcher liveness, no auth required", async () => {
    const { loader } = await import("~/routes/resources.health");
    const response = (await loader()) as {
      data: { ok: boolean; projections: { projects: number; tasks: number }; watcher: boolean };
      init?: { status?: number };
    };
    // react-router data() wrapper — unwrap tolerantly.
    const body = (response as { data?: unknown }).data ?? response;
    expect(body).toMatchObject({
      ok: true,
      projections: { projects: 3, tasks: 10 },
    });
    expect(typeof (body as { watcher: boolean }).watcher).toBe("boolean");
  });
});
