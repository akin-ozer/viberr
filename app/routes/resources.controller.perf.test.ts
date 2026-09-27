import { readFileSync, writeFileSync } from "node:fs";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pinPerfClock } from "../../test-support/perf-clock";
import { expectWithinBudget } from "../../test-support/perf-ratchet";
import { tallyServerReads } from "../../test-support/perf-counters";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * Ruling 457, journey `controller`: the dock's two data routes run on every
 * page (the unseen check on every navigation and revalidation, the view when
 * the panel is open), so what they read to answer yes/no questions is paid
 * everywhere.
 *
 * Fixture: the demo seed plus the shipped default agent assets (the controller
 * profile and definition a real store has), arda holding six unseen controller
 * replies on viberr-core. Measured on the second (warm) call.
 */

let app: AppTestContext;
let arda: string;
const SLUG = "viberr-core";
const UNSEEN_REPLIES = 6;

beforeAll(async () => {
  pinPerfClock();
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { seedDefaultAgentAssets } = await import("~/server/seed/default-assets.server");
  seedDefaultAgentAssets(app.dataRoot);
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  arda = findUserByEmail(app.db, "arda@viberr.dev")!.id;
  const { createConversation, appendMessage } = await import(
    "~/server/controller/controller-conversations.server"
  );
  for (let i = 0; i < UNSEEN_REPLIES; i++) {
    const c = createConversation(app.db, { userId: arda, userLabel: "Arda", projectSlug: SLUG });
    appendMessage(app.db, { conversationId: c.id, author: "user", userId: arda, text: `Question ${i}?` });
    appendMessage(app.db, { conversationId: c.id, author: "controller", text: `Answer ${i}.` });
  }
});
afterAll(() => {
  vi.useRealTimers();
  app.cleanup();
});

function args(request: Request, pattern: string) {
  return {
    request,
    url: new URL(request.url),
    params: {},
    pattern,
    context: new RouterContextProvider(),
  };
}

describe("controller dock routes (ruling 457)", () => {
  it("the unseen check stays within its server-read budgets", async () => {
    const { loader } = await import("~/routes/resources.controller-unseen");
    const { cookie } = await app.cookieFor(arda);
    const call = () =>
      loader(args(app.request("/resources/controller-unseen", { cookie }), "/resources/controller-unseen"));
    await call();
    const { result, tally } = await tallyServerReads(app.dataRoot, call);
    // Every call here is signed in, so each loader answers its own data; only
    // a caller who is not gets the 401 `data()` wraps (ruling 457).
    if (!("unseen" in result)) throw new Error(`expected the status, got ${JSON.stringify(result)}`);
    expect(result.unseen).toHaveLength(UNSEEN_REPLIES);
    expectWithinBudget("server-read:controller-unseen.store-reads", tally.storeReads.length);
    expectWithinBudget("server-read:controller-unseen.sql", tally.statements.length);
  });

  it("the task-scope dock view stays within its server-read budgets", async () => {
    const { loader } = await import("~/routes/resources.controller");
    const { cookie } = await app.cookieFor(arda);
    const query = `?project=${SLUG}&task=VIB-142`;
    const call = () =>
      loader(args(app.request(`/resources/controller${query}`, { cookie }), "/resources/controller"));
    await call();
    const { result, tally } = await tallyServerReads(app.dataRoot, call);
    if (!("view" in result)) throw new Error(`expected the view, got ${JSON.stringify(result)}`);
    expect(result.view.unavailable).toBe(false);
    expect(result.view.scope.kind).toBe("task");
    expect(result.view.controllerName).toBe("Controller");
    expectWithinBudget("server-read:dock-task-view.store-reads", tally.storeReads.length);
    expect(tally.storeReads).not.toContain("agents/definitions/controller.md");
    expectWithinBudget("server-read:dock-task-view.sql", tally.statements.length);
  });

  it("still names the controller the way its settings resolve it", async () => {
    const { agentProfileFilePath } = await import("~/server/files/file-store-root.server");
    const { resolveControllerConfig } = await import("~/server/controller/controller-profile.server");
    const file = agentProfileFilePath("controller", app.dataRoot);
    writeFileSync(file, readFileSync(file, "utf8").replace("name: Controller", "name: Switchboard"));
    const { loader } = await import("~/routes/resources.controller");
    const { cookie } = await app.cookieFor(arda);
    const named = await loader(
      args(app.request(`/resources/controller?project=${SLUG}&task=VIB-142`, { cookie }), "/resources/controller"),
    );
    if (!("view" in named)) throw new Error(`expected the view, got ${JSON.stringify(named)}`);
    expect(named.view.controllerName).toBe("Switchboard");
    expect(resolveControllerConfig(app.dataRoot).name).toBe("Switchboard");
    // A task that does not exist is still out of scope.
    const missing = await loader(
      args(app.request(`/resources/controller?project=${SLUG}&task=VIB-9999`, { cookie }), "/resources/controller"),
    );
    if (!("view" in missing)) throw new Error(`expected the view, got ${JSON.stringify(missing)}`);
    expect(missing.view.unavailable).toBe(true);
  });
});
