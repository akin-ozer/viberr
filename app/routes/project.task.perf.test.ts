import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pinPerfClock } from "../../test-support/perf-clock";
import { expectWithinBudget } from "../../test-support/perf-ratchet";
import {
  rowsMatching,
  statementsMatching,
  tallyServerReads,
} from "../../test-support/perf-counters";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * Ruling 457, journey `task-open` / `server`: what one task-page revalidation
 * costs the shared event loop. React Router runs root + the workspace layout +
 * the task loader for it, all handed ONE Request (single fetch), so the three
 * are measured together that way.
 *
 * Fixture: the demo seed, arda (org admin, project admin), VIB-142 with 60
 * extra comments so its timeline (69 events) is longer than the 30 the page
 * ships. Measured on the SECOND revalidation: the steady state a live page
 * pays on every SSE event.
 */

let app: AppTestContext;
let ardaId: string;
const SLUG = "viberr-core";
const KEY = "VIB-142";
const EXTRA_EVENTS = 60;

beforeAll(async () => {
  pinPerfClock();
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
  const { updateTaskFile } = await import("~/server/files/task-writer.server");
  await updateTaskFile({ dataRoot: app.dataRoot, projectSlug: SLUG, taskKey: KEY }, (parsed) => {
    for (let i = 0; i < EXTRA_EVENTS; i++) {
      parsed.timeline.unshift({
        occurredAt: new Date(Date.UTC(2026, 8, 20, 9, i)).toISOString(),
        type: "comment",
        actor: { kind: "human", userId: ardaId, nameHint: "Arda" },
        title: null,
        text: `Perf fixture comment ${i}: the timeline grows past the first slice.`,
        toAgent: false,
        evidence: null,
      });
    }
  });
  const { rebuildAll } = await import("~/server/projections/rebuilder.server");
  rebuildAll(app.db, { dataRoot: app.dataRoot });
});
afterAll(() => {
  vi.useRealTimers();
  app.cleanup();
});

async function revalidateTaskPage(cookie: string) {
  const [root, layout, task] = await Promise.all([
    import("~/root"),
    import("~/routes/project"),
    import("~/routes/project.task"),
  ]);
  // One Request for every loader, as single fetch hands it (react-router
  // router.js `loadRouteData`); a `.data` URL is a revalidation, not a view.
  const request = app.request(`/projects/${SLUG}/tasks/${KEY}.data`, { cookie });
  const args = {
    request,
    url: new URL(request.url),
    params: { slug: SLUG, key: KEY },
    pattern: "/projects/:slug/tasks/:key",
    context: new RouterContextProvider(),
  };
  return Promise.all([root.loader(args), layout.loader(args), task.loader(args)]);
}

describe("task-page timeline window (ruling 457)", () => {
  it("'Show older' still pages through the whole history", async () => {
    const { loader } = await import("~/routes/project.task");
    const { cookie } = await app.cookieFor(ardaId);
    const request = app.request(`/projects/${SLUG}/tasks/${KEY}?events=60`, { cookie });
    const task = await loader({
      request,
      url: new URL(request.url),
      params: { slug: SLUG, key: KEY },
      pattern: "/projects/:slug/tasks/:key",
      context: new RouterContextProvider(),
    });
    expect(task.task.timeline).toHaveLength(60);
    expect(task.timelineRemaining).toBe(9);
    expect(task.timelineNextLimit).toBe(69);
    // Newest first, oldest of the window last: the seed's own events follow
    // the 60 comments.
    expect(task.task.timeline[59]?.text).toContain("comment 0:");
  });
});

describe("task-page revalidation (ruling 457)", () => {
  it("stays within its server-read budgets", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    await revalidateTaskPage(cookie);
    const { storeFileParseCounts } = await import("~/server/files/parse-memo.server");
    const totalParses = () => Object.values(storeFileParseCounts()).reduce((a, b) => a + b, 0);
    const parsesBefore = totalParses();
    const { result, tally } = await tallyServerReads(app.dataRoot, () =>
      revalidateTaskPage(cookie),
    );
    const parses = totalParses() - parsesBefore;

    // Correctness first: the same slice and counts the page always showed.
    const task = result[2];
    expect(task.task.timeline).toHaveLength(30);
    expect(task.timelineRemaining).toBe(9 + EXTRA_EVENTS - 30);
    expect(task.task.timeline[0]?.text).toContain(`comment ${EXTRA_EVENTS - 1}`);

    expectWithinBudget(
      "server-read:task-revalidation.yaml-parses",
      parses,
    );
    expectWithinBudget("server-read:task-revalidation.store-reads", tally.storeReads.length);

    // A first open: every distinct file parses once, however many helpers ask.
    const { resetParseMemoForTests } = await import("~/server/files/parse-memo.server");
    resetParseMemoForTests();
    await revalidateTaskPage(cookie);
    expectWithinBudget("server-read:task-revalidation.yaml-parses-cold", totalParses());
    expectWithinBudget("server-read:task-revalidation.sql", tally.statements.length);
    expectWithinBudget(
      "server-read:task-revalidation.session-lookups",
      statementsMatching(tally, /from "session"/i).length,
    );
    expectWithinBudget(
      "server-read:task-loader.timeline-rows",
      rowsMatching(tally, /SELECT \* FROM task_events/),
    );
  });
});
