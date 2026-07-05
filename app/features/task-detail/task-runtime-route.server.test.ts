import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAppTest, type AppTestContext } from "../../../test-support/test-app";
import type { loader as taskLoader, action as taskAction } from "~/routes/project.task";

/**
 * Route-level tests for the Phase-8 runtime wiring on routes/project.task:
 * the loader's `runtime` projection shape (VIB-142/151/166) and the
 * `run-interrupt` action's RBAC + audit through a real Request.
 *
 * One seed per file; read-only assertions before the mutating interrupt.
 */

let app: AppTestContext;
let ids: { arda: string; selin: string };

type LoaderData = Awaited<ReturnType<typeof taskLoader>>;
type ActionData = Awaited<ReturnType<typeof taskAction>>;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("~/server/seed/demo-seed.server");
  runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ids = {
    arda: findUserByEmail(app.db, "arda@viberr.dev")!.id,
    selin: findUserByEmail(app.db, "selin@viberr.dev")!.id,
  };
});
afterAll(() => app.cleanup());

async function runLoader(key: string, userId: string): Promise<LoaderData> {
  const { loader } = await import("~/routes/project.task");
  const { cookie } = await app.cookieFor(userId);
  return (await loader({
    request: app.request(`/projects/viberr-core/tasks/${key}`, { cookie }),
    params: { slug: "viberr-core", key },
    context: {},
  } as never)) as LoaderData;
}

async function postIntent(key: string, userId: string, fields: Record<string, string>) {
  const { action } = await import("~/routes/project.task");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  return (await action({
    request: app.request(`/projects/viberr-core/tasks/${key}`, {
      method: "POST",
      cookie,
      body: new URLSearchParams({ _csrf: csrf, ...fields }),
    }),
    params: { slug: "viberr-core", key },
    context: {},
  } as never)) as ActionData | { data: { ok: false; error: string }; init: { status: number } };
}

describe("loader — runtime projection shape", () => {
  it("VIB-142: op idle (finished-no-label), primary+consultant done, stored order", async () => {
    const { runtime } = await runLoader("VIB-142", ids.arda);
    expect(runtime.map((r) => r.id)).toEqual(["op", "primary", "c0"]);
    expect(runtime[0]).toMatchObject({ op: true, state: "idle", who: { name: "Operator" } });
    expect(runtime[1]).toMatchObject({ backend: "codex", state: "done", finished: "9:41" });
    expect(runtime[1]!.raw.length).toBe(runtime[1]!.lines.length);
    // Real usage — codex turn.completed in+out tokens (no fabrication).
    expect(runtime[1]!.tokens).toBe(128034 + 6188);
  });

  it("VIB-151: 2 running specialists + 1 idle operator", async () => {
    const { runtime } = await runLoader("VIB-151", ids.arda);
    expect(runtime.filter((r) => r.state === "running").length).toBe(2);
    expect(runtime.filter((r) => r.op).length).toBe(1);
  });

  it("VIB-166 (triage): no runtime threads", async () => {
    const { runtime } = await runLoader("VIB-166", ids.arda);
    expect(runtime).toEqual([]);
  });
});

describe("action — run-interrupt RBAC + audit", () => {
  it("reviewer (selin) is denied (403)", async () => {
    const { runtime } = await runLoader("VIB-151", ids.selin);
    const running = runtime.find((r) => r.state === "running")!;
    const result = await postIntent("VIB-151", ids.selin, { intent: "run-interrupt", runId: running.serverRunId });
    expect("init" in result && result.init?.status).toBe(403);
  });

  it("admin (arda) interrupts a running run → interrupted + audit event", async () => {
    const { runtime } = await runLoader("VIB-151", ids.arda);
    const running = runtime.find((r) => r.state === "running")!;
    const result = await postIntent("VIB-151", ids.arda, { intent: "run-interrupt", runId: running.serverRunId });
    expect("ok" in result && result.ok).toBe(true);

    const after = await runLoader("VIB-151", ids.arda);
    const interrupted = after.runtime.find((r) => r.serverRunId === running.serverRunId)!;
    expect(interrupted.lifecycle).toBe("interrupted");
    expect(interrupted.interruptedBy?.userId).toBe(ids.arda);

    const { listAuditEvents } = await import("~/server/audit/audit-recorder.server");
    const audits = listAuditEvents(app.db, { action: "runtime.run.interrupted" });
    expect(audits[0]?.actorUserId).toBe(ids.arda);
    expect(audits[0]?.taskKey).toBe("VIB-151");
  });

  it("interrupting an already-terminal run is a friendly no-op", async () => {
    const { runtime } = await runLoader("VIB-142", ids.arda);
    const done = runtime.find((r) => r.state === "done")!;
    const result = await postIntent("VIB-142", ids.arda, { intent: "run-interrupt", runId: done.serverRunId });
    expect("ok" in result && result.ok).toBe(true);
    // "already finished" toast copy.
    expect("toast" in result && String(result.toast)).toContain("already finished");
  });
});
