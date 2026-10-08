import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pinPerfClock } from "../../test-support/perf-clock";
import { expectWithinBudget } from "../../test-support/perf-ratchet";
import { rowsMatching, tallyServerReads } from "../../test-support/perf-counters";
import { routeArgs, setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * Ruling 457, journey `fresh-load` (FL-4): what Home's loader ships. The bell's
 * notification list used to ride every Home document and revalidation, closed
 * at first paint: 62 % of Home's payload on the demo seed. The owner decision
 * of 2026-09-24 moves it to the bell, which loads it on intent.
 *
 * Fixture: the demo seed, arda (org admin, ten notifications), the Home loader
 * alone on its second (warm) run, on the pinned clock (the greeting follows
 * the hour); bytes are the JSON of its result.
 */

let app: AppTestContext;
let ardaId: string;

beforeAll(async () => {
  pinPerfClock();
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
});
afterAll(() => {
  vi.useRealTimers();
  app.cleanup();
});

describe("Home payload (ruling 457)", () => {
  it("ships the bell's counts, not its list", async () => {
    const { loader } = await import("~/routes/_index");
    const { cookie } = await app.cookieFor(ardaId);
    const load = () => {
      const request = app.request("/.data", { cookie });
      return loader(routeArgs(request, {}, "/"));
    };
    await load();
    const { result, tally } = await tallyServerReads(app.dataRoot, load);
    // The cards and the bell's badge are all there.
    expect(result.projects.length).toBeGreaterThan(0);
    expect(result.unread).toBe(6);
    // An admin is shown the data root, which here is a temp directory whose
    // length is the host's (os.tmpdir() is 49 characters on macOS, 4 on
    // Linux), not the loader's: it is measured as empty.
    expect(result.storeRoot).toBe(app.dataRoot);
    expectWithinBudget(
      "payload:home.loader-bytes",
      Buffer.byteLength(JSON.stringify({ ...result, storeRoot: "" })),
    );
    expectWithinBudget(
      "payload:home.notification-rows",
      rowsMatching(tally, /SELECT n\.\*, p\.name AS project_name/),
    );
  });
});
