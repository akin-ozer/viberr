import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RouterContextProvider } from "react-router";
import { z } from "zod";
import { setupAppTest, type AppTestContext } from "../../../test-support/test-app";
import type { SeedUserIds } from "../../../test-support/demo-data";

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
/**
 * The seeded people these cases call the artifact routes as: arda is project
 * admin on viberr-core; deniz is registered, but a member of NO project — the
 * exact F10-06/33 subject.
 */
let ids: SeedUserIds;

const RUN_ID = "run_authfixture";

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  ids = (await runDemoSeed(app.db, { dataRoot: app.dataRoot })).userIds;

  // The demo seed deliberately fabricates no runs (R7-2), so plant one.
  const { upsertRun } = await import("~/server/runtimes/run-store.server");
  upsertRun(app.db, {
    id: RUN_ID,
    projectSlug: "viberr-core",
    taskKey: "VIB-142",
    threadId: "thread_authfixture",
    role: "developer",
    kind: "primary",
    agentProfileId: "developer",
    backend: "claude",
    model: "claude-opus-4-8",
    sdk: "claude-agent-sdk",
    state: "finished",
  });
});
afterAll(() => app.cleanup());

/** The two routes under test, with the pattern the framework matches them under. */
const ARTIFACT_ROUTES = {
  "resources.run-log": "/resources/run-log",
  "resources.session-export": "/resources/session-export",
} as const;
type ArtifactRoute = keyof typeof ARTIFACT_ROUTES;

/**
 * requireProjectMember throws react-router's `data(message, {status})`, which
 * is a DataWithResponseInit — not a Response — so the rejection reaches the
 * test untyped and is parsed where it lands. A thrown refusal is still a
 * refusal: the route must not fall through to content either way.
 */
const thrownRefusalSchema = z.object({
  data: z.unknown(),
  init: z.object({ status: z.number() }),
});

/** Invoke a resource loader and normalize thrown Responses into a status. */
async function callLoader(
  mod: ArtifactRoute,
  path: string,
  userId: string,
): Promise<{ status: number; body: string }> {
  const { loader } =
    mod === "resources.run-log"
      ? await import("~/routes/resources.run-log")
      : await import("~/routes/resources.session-export");
  const { cookie } = await app.cookieFor(userId);
  const request = app.request(path, { cookie });
  try {
    const res = await loader({
      request,
      url: new URL(request.url),
      params: {},
      pattern: ARTIFACT_ROUTES[mod],
      context: new RouterContextProvider(),
    });
    return { status: res.status, body: await res.text() };
  } catch (thrown) {
    const refusal = thrownRefusalSchema.safeParse(thrown);
    if (refusal.success) {
      return {
        status: refusal.data.init.status,
        body: String(refusal.data.data ?? ""),
      };
    }
    if (!(thrown instanceof Response)) throw thrown;
    return { status: thrown.status, body: await thrown.text() };
  }
}

describe("F10-06/F10-33: raw run artifacts require project membership", () => {
  it("run-log: denies a signed-in NON-MEMBER and leaks no log content", async () => {
    const res = await callLoader(
      "resources.run-log",
      `/resources/run-log?runId=${RUN_ID}`,
      ids.deniz,
    );
    // F19-28: was 403 ("Only project members can view raw run logs") — a
    // project-existence oracle R15-4 forbids. The refusal is now the same 404
    // an unknown slug produces, and because this route is addressed by RUN id
    // (not by slug) the body must not name the project either: echoing it would
    // hand a non-member the name of a project they never asked about.
    expect(res.status).toBe(404);
    expect(res.body).toBe("Not found.");
    expect(res.body).not.toContain("viberr-core");
    expect(res.body).not.toMatch(/member/i);
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
    // F19-28: was 403 — see the run-log case above.
    expect(res.status).toBe(404);
    expect(res.body).toBe("Not found.");
    expect(res.body).not.toContain("viberr-core");
    // Must not hand back the installer script under any status.
    expect(res.body).not.toContain("#!/");
  });

  it("session-export: a member gets past the gate (its own 404 — no real session)", async () => {
    const res = await callLoader(
      "resources.session-export",
      `/resources/session-export?run=${RUN_ID}`,
      ids.arda,
    );
    // The fixture has no provider session, so a member is refused for a
    // non-authorization reason. Since F19-28 collapsed the non-member refusal
    // to 404 too, the BODY is what proves the gate opened — the member reads
    // the route's own reason, never the guard's bare "Not found.".
    expect(res.status).toBe(404);
    expect(res.body).toContain("never opened an exportable provider session");
    expect(res.body).not.toBe("Not found.");
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
      agentProfileId: "developer",
      backend: "claude",
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
    // F19-28: refused as an unknown slug (404), and the body must not name
    // `billing-service` — the caller addressed a RUN, not that project.
    expect(res.status).toBe(404);
    expect(res.body).toBe("Not found.");
    expect(res.body).not.toContain("billing-service");
  });
});
