import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectWithinBudget } from "../../test-support/perf-ratchet";
import { rowsMatching, tallyServerReads } from "../../test-support/perf-counters";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";
import { seedConsoleFixture } from "../../test-support/console-fixture";

/**
 * Ruling 454, journey `task-open`: what the task loader ships of the agent
 * console. Owner decision 2 (2026-09-24): a hard refresh arrives with the
 * shown agent's console filled; a revalidation or a client navigation (a
 * `.data` request) carries no console lines, and the console fills itself with
 * one small request.
 *
 * Fixture: the demo seed, arda (org admin, project admin), VIB-142 with the
 * enlarged console of `test-support/console-fixture.ts` (870 lines over three
 * agent groups, the developer's newest run streaming). Bytes are the loader
 * result as JSON; rows are `run_log_lines` rows the loader read. Measured on
 * the second call (the steady state).
 */

let app: AppTestContext;
let ardaId: string;
const SLUG = "viberr-core";
const KEY = "VIB-142";

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
  await seedConsoleFixture(app.db, SLUG, KEY);
});
afterAll(() => app.cleanup());

async function loadTask(cookie: string, suffix: "" | ".data") {
  const { loader } = await import("~/routes/project.task");
  const request = app.request(`/projects/${SLUG}/tasks/${KEY}${suffix}`, { cookie });
  return loader({
    request,
    url: new URL(request.url),
    params: { slug: SLUG, key: KEY },
    pattern: "/projects/:slug/tasks/:key",
    context: new RouterContextProvider(),
  });
}

type TaskData = Awaited<ReturnType<typeof import("~/routes/project.task").loader>>;

const bytes = (data: TaskData) => Buffer.byteLength(JSON.stringify(data));

describe("the task loader's console payload (ruling 454, owner decision 2)", () => {
  it("a revalidation ships the console's window facts and no lines", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    await loadTask(cookie, ".data");
    const { result, tally } = await tallyServerReads(app.dataRoot, () => loadTask(cookie, ".data"));

    // The three groups, in created order, with what the console needs to
    // follow and page them.
    expect(result.runtime.map((r) => r.who.name)).toEqual(["operator", "developer", "reviewer"]);
    const dev = result.runtime[1]!;
    expect(dev.state).toBe("running");
    expect(dev.serverRunId).toBe("run_dev_3");
    expect(dev.logWindow.runIds).toEqual(["run_dev_1", "run_dev_2", "run_dev_3"]);
    expect(dev.logWindow.headSeq).toBe(149);
    expect(dev.logWindow.totalLines).toBe(450);
    expect(dev.lineCount).toBe(450);

    expectWithinBudget("console:task-data.json-bytes", bytes(result));
    expectWithinBudget(
      "console:task-data.run-log-rows",
      rowsMatching(tally, /FROM run_log_lines/i),
    );
  });

  it("a hard refresh ships the shown agent's window", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    await loadTask(cookie, "");
    const result = await loadTask(cookie, "");
    const dev = result.runtime[1]!;
    // The running agent is the one the console opens on.
    expect(dev.lines.length).toBeGreaterThan(0);
    expect(dev.lines.at(-1)!.text).toContain("run_dev_3 line 149");
    expectWithinBudget("console:task-document.json-bytes", bytes(result));
  });
});
