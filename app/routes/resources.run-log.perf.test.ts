import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countSql } from "../../test-support/perf-counters";
import { expectWithinBudget } from "../../test-support/perf-ratchet";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * Ruling 454 (LIVE-9): every console line a viewer watches costs one
 * `/resources/run-log?since=` tail fetch, so its run-table work is paid per
 * line per viewer on the event loop the agents share. The session lookups the
 * route also makes are the server-read cluster's (a per-request memo) and are
 * not counted here.
 */

let app: AppTestContext;
let ardaId: string;
const RUN_ID = "run_tailfixture";

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
  const { insertRunLine, upsertRun } = await import("~/server/runtimes/run-store.server");
  upsertRun(app.db, {
    id: RUN_ID,
    projectSlug: "viberr-core",
    taskKey: "VIB-142",
    threadId: "thread_tailfixture",
    role: "developer",
    kind: "primary",
    agentProfileId: "developer",
    backend: "claude",
    model: "claude-opus-4-8",
    sdk: "claude-agent-sdk",
    state: "running",
  });
  for (let seq = 0; seq < 11; seq += 1) {
    insertRunLine(app.db, {
      runId: RUN_ID,
      seq,
      occurredAt: "2026-07-24T00:00:00.000Z",
      raw: JSON.stringify({ seq }),
      display: { t: "00:00:00", ev: "text", tag: "assistant", text: `line ${seq}` },
    });
  }
});
afterAll(() => app.cleanup());

describe("run-log tail cost (ruling 454)", () => {
  it("LIVE-9: a one-line tail reads the run once and scans no line count", async () => {
    const { loader } = await import("~/routes/resources.run-log");
    const { cookie } = await app.cookieFor(ardaId);
    const request = app.request(`/resources/run-log?runId=${RUN_ID}&since=9`, { cookie });
    const probe = countSql(app.db);
    const res = await loader({
      request,
      url: new URL(request.url),
      params: {},
      pattern: "/resources/run-log",
      context: new RouterContextProvider(),
    });
    const sql = probe.stop().sql;
    expect(res.status).toBe(200);

    const runTables = sql.filter((s) => /\b(agent_runs|run_log_lines)\b/.test(s));
    expectWithinBudget("writes:run-log-tail.run-sql", runTables.length);
    // The page's `hasMore` needs "is there an older line", never a count.
    expect(runTables.filter((s) => /count\(/i.test(s))).toEqual([]);
  });
});
