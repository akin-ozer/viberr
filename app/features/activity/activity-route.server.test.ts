import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import type { ActivityStreamRowView, AuditLogEntryView } from "./activity-page";

/**
 * Route-level tests for /projects/:slug/activity against the seeded demo
 * store: auth gating, the flattened cross-task stream (real projection over
 * task_events), and the audit panel reading the real scope_violations +
 * audit_events tables.
 */

let app: AppTestContext;
let ardaId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("~/server/seed/demo-seed.server");
  runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
});
afterAll(() => app.cleanup());

async function runLoader(slug: string, cookie?: string) {
  const { loader } = await import("~/routes/project.activity");
  return loader({
    request: app.request(
      `/projects/${slug}/activity`,
      cookie ? { cookie } : {},
    ),
    params: { slug },
    context: {},
  } as never);
}

describe("/projects/:slug/activity", () => {
  it("redirects signed-out users to /login", async () => {
    const thrown = await runLoader("viberr-core").catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
  });

  it("404s for an unknown project", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const thrown = await runLoader("nope", cookie).catch((e) => e);
    expect(thrown?.init?.status ?? thrown?.status).toBe(404);
  });

  it("returns the flattened seeded stream, newest first, with real actors", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const result = (await runLoader("viberr-core", cookie)) as {
      projectName: string;
      stream: ActivityStreamRowView[];
      audit: AuditLogEntryView[];
    };

    expect(result.projectName).toBe("Viberr Core");
    // All 32 seeded events across the 10 tasks, one flat feed.
    expect(result.stream.length).toBe(32);
    const times = result.stream.map((r) => r.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);

    // Every mock actor kind appears (drives the All/Humans/Agents/System filter).
    const kinds = new Set(result.stream.map((r) => r.actor?.kind));
    expect(kinds).toContain("human");
    expect(kinds).toContain("agent");
    expect(kinds).toContain("system");

    // Completion events carry the folded title (mock norm()).
    const completion = result.stream.find((r) => r.type === "completion");
    expect(completion?.text.startsWith("**Completion")).toBe(true);

    // Task keys link back to their tasks.
    expect(result.stream.every((r) => /^VIB-\d+$/.test(r.taskKey))).toBe(true);
  });

  it("audit panel carries the seeded open violation from scope_violations", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const result = (await runLoader("viberr-core", cookie)) as {
      audit: AuditLogEntryView[];
    };
    const violation = result.audit.find((e) => e.kind === "violation");
    expect(violation).toBeDefined();
    expect(violation!.status).toBe("open");
    expect(violation!.taskKey).toBe("VIB-142");
    expect(violation!.text).toBe(
      "Project credential is missing `pull_request:write` — flagged by the policy engine on",
    );
  });

  it("stub projects load with an empty stream (degrade gracefully)", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const result = (await runLoader("deploy-pipeline", cookie)) as {
      stream: ActivityStreamRowView[];
      audit: AuditLogEntryView[];
    };
    expect(result.stream).toEqual([]);
  });
});
