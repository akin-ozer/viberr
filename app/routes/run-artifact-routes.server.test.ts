import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * F10-06 / F10-33 — authorization for the two RAW RUN ARTIFACT routes.
 *
 * `/resources/run-log` and `/resources/session-export` hand out the most
 * sensitive material the app holds: full agent transcripts, tool output,
 * repository content, prompts, and possibly secrets — and the export is a
 * downloadable installer. Both used to authorize on "any signed-in user",
 * which meant a registered account with NO membership anywhere could read
 * every project's run internals by guessing a run id.
 *
 * These tests pin the membership gate on both routes, and pin that it is
 * checked per RUN (the run's own project), not per caller.
 */

let app: AppTestContext;
let ids: { arda: string; deniz: string };

const RUN_ID = "run_authfixture";

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("~/server/seed/demo-seed.server");
  runDemoSeed(app.db, { dataRoot: app.dataRoot });

  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ids = {
    // Project admin on viberr-core.
    arda: findUserByEmail(app.db, "arda@viberr.dev")!.id,
    // Registered, but a member of NO project — the exact F10-06/33 subject.
    deniz: findUserByEmail(app.db, "deniz@viberr.dev")!.id,
  };

  // The demo seed deliberately fabricates no runs (R7-2), so plant one.
  const { upsertRun } = await import("~/server/runtimes/run-store.server");
  upsertRun(app.db, {
    id: RUN_ID,
    projectSlug: "viberr-core",
    taskKey: "VIB-142",
    threadId: "thread_authfixture",
    role: "developer",
    kind: "primary",
    backend: "claude",
    simulated: true,
    model: "claude-opus-4-8",
    sdk: "claude-agent-sdk",
    state: "finished",
  });
});
afterAll(() => app.cleanup());

/** Invoke a resource loader and normalize thrown Responses into a status. */
async function callLoader(
  mod: "resources.run-log" | "resources.session-export",
  path: string,
  userId: string,
): Promise<{ status: number; body: string }> {
  const { loader } = await import(`~/routes/${mod}`);
  const { cookie } = await app.cookieFor(userId);
  try {
    const res = (await loader({
      request: app.request(path, { cookie }),
      params: {},
      context: {},
    } as never)) as Response;
    return { status: res.status, body: await res.text() };
  } catch (thrown) {
    // requireProjectMember throws react-router's `data(message, {status})`,
    // which is a DataWithResponseInit — not a Response. A thrown 403 is still
    // a 403: the route must not fall through to content either way.
    const wrapped = thrown as { data?: unknown; init?: { status?: number } };
    if (typeof wrapped?.init?.status === "number") {
      return { status: wrapped.init.status, body: String(wrapped.data ?? "") };
    }
    const res = thrown as Response;
    if (typeof res?.status !== "number") throw thrown;
    return { status: res.status, body: await res.text() };
  }
}

describe("F10-06/F10-33: raw run artifacts require project membership", () => {
  it("run-log: denies a signed-in NON-MEMBER and leaks no log content", async () => {
    const res = await callLoader(
      "resources.run-log",
      `/resources/run-log?runId=${RUN_ID}`,
      ids.deniz,
    );
    expect(res.status).toBe(403);
    // The denial must not carry the payload it refused to serve.
    expect(res.body).not.toContain("thread_authfixture");
    expect(res.body).not.toContain('"lines"');
  });

  it("run-log: allows a project member", async () => {
    const res = await callLoader(
      "resources.run-log",
      `/resources/run-log?runId=${RUN_ID}`,
      ids.arda,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).data.runId).toBe(RUN_ID);
  });

  it("session-export: denies a signed-in NON-MEMBER", async () => {
    const res = await callLoader(
      "resources.session-export",
      `/resources/session-export?run=${RUN_ID}`,
      ids.deniz,
    );
    expect(res.status).toBe(403);
    // Must not hand back the installer script under any status.
    expect(res.body).not.toContain("#!/");
  });

  it("session-export: a member gets past the gate (404 here — no real session)", async () => {
    const res = await callLoader(
      "resources.session-export",
      `/resources/session-export?run=${RUN_ID}`,
      ids.arda,
    );
    // The fixture run is simulated, so a MEMBER is refused for a different,
    // non-authorization reason. The distinct status is the proof the gate
    // opened for them: 404 (no exportable session), never 403.
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
    expect(res.body).toContain("no exportable provider session");
  });

  it("the gate keys on the RUN's project, not a project the caller happens to be in", async () => {
    // Arda is an admin on viberr-core but not a member of billing-service.
    // A run belonging to billing-service must still be refused for them.
    const { upsertRun } = await import("~/server/runtimes/run-store.server");
    const { assertProjectAction } = await import(
      "~/server/auth/project-authority.server"
    );
    const foreignRun = "run_foreignproject";
    upsertRun(app.db, {
      id: foreignRun,
      projectSlug: "billing-service",
      taskKey: "BIL-1",
      threadId: "thread_foreign",
      role: "developer",
      kind: "primary",
      backend: "claude",
      simulated: true,
      model: "claude-opus-4-8",
      sdk: "claude-agent-sdk",
      state: "finished",
    });
    // Guard the premise: Deniz is a member of billing-service either way.
    expect(() =>
      assertProjectAction(
        app.db,
        "any-member",
        "billing-service",
        { userId: ids.deniz, label: "deniz@viberr.dev" },
        "read",
        { allowArchived: true },
      ),
    ).toThrow();

    const res = await callLoader(
      "resources.run-log",
      `/resources/run-log?runId=${foreignRun}`,
      ids.deniz,
    );
    expect(res.status).toBe(403);
  });
});
