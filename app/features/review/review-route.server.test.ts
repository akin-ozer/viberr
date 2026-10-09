import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  routeArgs,
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { decisionRowSub, reviewRowSub } from "./review-helpers";

/**
 * Route-level tests for /projects/:slug/review against the seeded demo
 * store: auth gating, the panels (each viewer's own tasks, ruling 304), and
 * the sublines the seeded rows get (the precedence itself is
 * review-helpers.test.ts's).
 */

let app: AppTestContext;
let ardaId: string;
let muratId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda;
  muratId = userIds.murat;
});
afterAll(() => app.cleanup());

async function runLoader(slug: string, cookie?: string) {
  const { loader } = await import("~/routes/project.review");
  const request = app.request(`/projects/${slug}/review`, cookie ? { cookie } : {});
  return loader(routeArgs(request, { slug }, "/projects/:slug/review"));
}

describe("/projects/:slug/review", () => {
  it("redirects signed-out users to /login", async () => {
    const thrown = await runLoader("viberr-core").catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    // SAFETY: the assertion above pins `thrown instanceof Response` and throws
    // otherwise — `requireProjectMember` signs a viewer out by throwing
    // `redirect()`, which is a Response.
    expect((thrown as Response).status).toBe(302);
  });

  it("404s for an unknown project", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const thrown = await runLoader("nope", cookie).catch((e) => e);
    expect(thrown?.init?.status ?? thrown?.status).toBe(404);
  });

  it("ruling 304: each viewer gets their own seeded tasks, by the decision each holds", async () => {
    // Arda owns VIB-142, whose completion packet offers the acceptance. The
    // seeded VIB-160 (murat's, blocked at In Progress) and VIB-145 (nobody's,
    // with agents at Review) are not hers, however her admin role reaches them.
    const arda = await runLoader("viberr-core", (await app.cookieFor(ardaId)).cookie);
    expect(arda.completions.map((t) => t.key)).toEqual(["VIB-142"]);
    expect(arda.decisions).toEqual([]);
    expect(arda.working).toEqual([]);

    const vib142 = arda.completions[0]!;
    expect(vib142.packet?.kind).toBe("Completion report");
    expect(vib142.pr).toEqual({ number: 318, state: "review" });
    expect(vib142.validation).toBe("changed");
    // F10-11/F10-15: acceptance readiness is revision-bound. VIB-142 has a
    // verdict-capable reviewer engaged but no approving verdict on its current
    // revision, so the subline states WHY the acceptance the packet offers is
    // not ready yet, rather than promising it.
    expect(vib142.blockReason).toMatch(/waiting on 1 required reviewer/i);
    expect(reviewRowSub(vib142)).toBe(vib142.blockReason);

    // Murat owns VIB-160: an open blocked packet before the review stage is
    // his decision, listed wherever the task stands.
    const murat = await runLoader("viberr-core", (await app.cookieFor(muratId)).cookie);
    expect(murat.completions).toEqual([]);
    expect(murat.decisions.map((t) => t.key)).toEqual(["VIB-160"]);
    const vib160 = murat.decisions[0]!;
    expect(vib160.atAcceptanceBoundary).toBe(false);
    expect(vib160.stageName).toBe("In Progress");
    expect(decisionRowSub(vib160)).toBe(
      "Blocked decision: Continuity degraded — pick a recovery path",
    );
  });

  it("ships the board's own waiting-on-you answer (interface review 2026-09-24, writ-3)", async () => {
    // The queue tagged VIB-142/145/160 "waiting on a human" while the board
    // told the same viewer "waiting on you". Ruling 11 took the board's columns
    // out of the layout, so both loaders now call `waitingOnViewer`; this pins
    // them to one answer on the seeded store.
    const { cookie } = await app.cookieFor(ardaId);
    const review = await runLoader("viberr-core", cookie);
    const { loader: boardLoader } = await import("~/routes/project.board");
    const request = app.request("/projects/viberr-core/board", { cookie });
    const board = await boardLoader(routeArgs(request, { slug: "viberr-core" }, "/projects/:slug/board"));
    const flagged = [...board.columns.flatMap((c) => c.tasks), ...board.orphanTasks]
      .filter((t) => t.waitingOnMe)
      .map((t) => t.key)
      .sort();
    expect(flagged.length).toBeGreaterThan(0);
    expect([...review.waitingOnMe].sort()).toEqual(flagged);
  });

  it("ships the acceptance-authority signal the queue copy needs (P13-D-9)", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const result = await runLoader("viberr-core", cookie);
    // The loader used to pass `stageNames` and nothing else, so the page's
    // "always a human action" claim could not be qualified at all. The seeded
    // operator holds `completion-for-acceptance: recommend`, so the strict
    // boundary is the honest answer here — but it is now a computed one.
    expect(result.acceptance).toEqual({
      operatorCanAccept: false,
      operatorName: "Operator",
    });
  });
});
