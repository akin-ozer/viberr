import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RouterContextProvider } from "react-router";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { reviewRowSub } from "./review-helpers";

/**
 * Route-level tests for /projects/:slug/review against the seeded demo
 * store: auth gating, the panel split (project-wide per ruling 10), and
 * the sublines the seeded rows get (the precedence itself is
 * review-helpers.test.ts's).
 */

let app: AppTestContext;
let ardaId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda;
});
afterAll(() => app.cleanup());

async function runLoader(slug: string, cookie?: string) {
  const { loader } = await import("~/routes/project.review");
  const request = app.request(`/projects/${slug}/review`, cookie ? { cookie } : {});
  return loader({
    request,
    url: new URL(request.url),
    params: { slug },
    pattern: "/projects/:slug/review",
    context: new RouterContextProvider(),
  });
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

  it("splits the seeded review stage: VIB-142 waits on a human, VIB-145 with agents", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const result = await runLoader("viberr-core", cookie);

    // U35-5 (pass 35): three, not two. The seeded VIB-160 sits at In Progress
    // with a verdict-capable reviewer whose verdict on the current revision is
    // request_changes (validation "failing"), which is review work in flight
    // wherever the stage is, so it is listed under "Still in review" naming
    // its stage. It was invisible while the queue keyed on the review stage.
    expect(result.total).toBe(3);
    // F10-11/F10-15: acceptance readiness is revision-bound now. VIB-142 has a
    // verdict-capable reviewer engaged but no approving verdict on its current
    // revision (validation "changed"), so it is NOT acceptance-ready — it sits
    // in "Still in review" with an honest block reason, not the acceptance
    // panel. VIB-145 waits on agents.
    expect(result.ready.map((t) => t.key)).toEqual([]);
    expect(result.working.map((t) => t.key)).toEqual(["VIB-142", "VIB-145", "VIB-160"]);

    const vib160 = result.working.find((t) => t.key === "VIB-160")!;
    expect(vib160.atAcceptanceBoundary).toBe(false);
    expect(vib160.stageName).toBe("In Progress");
    expect(reviewRowSub(vib160)).toBe(
      "Review in progress at In Progress · changes requested",
    );

    const vib142 = result.working.find((t) => t.key === "VIB-142")!;
    expect(vib142.packet?.kind).toBe("Completion report");
    expect(vib142.pr).toEqual({ number: 318, state: "review" });
    expect(vib142.validation).toBe("changed");
    // The subline states WHY it isn't ready (a required reviewer is outstanding).
    expect(vib142.blockReason).toMatch(/waiting on 1 required reviewer/i);
    expect(reviewRowSub(vib142)).toBe(vib142.blockReason);

    const vib145 = result.working.find((t) => t.key === "VIB-145")!;
    expect(vib145.packet).toBeNull();
    // No revision / no required reviewer verdict yet → also not acceptance-ready.
    const sub = reviewRowSub(vib145);
    expect(sub).not.toContain("**");
    expect(sub).not.toContain("`");
  });

  it("ships the board's own waiting-on-you answer (interface review 2026-09-24, writ-3)", async () => {
    // The queue tagged VIB-142/145/160 "waiting on a human" while the board
    // told the same viewer "waiting on you". Ruling 457 took the board's columns
    // out of the layout, so both loaders now call `waitingOnViewer`; this pins
    // them to one answer on the seeded store.
    const { cookie } = await app.cookieFor(ardaId);
    const review = await runLoader("viberr-core", cookie);
    const { loader: boardLoader } = await import("~/routes/project.board");
    const request = app.request("/projects/viberr-core/board", { cookie });
    const board = await boardLoader({
      request,
      url: new URL(request.url),
      params: { slug: "viberr-core" },
      pattern: "/projects/:slug/board",
      context: new RouterContextProvider(),
    });
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
