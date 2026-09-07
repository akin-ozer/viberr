import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RouterContextProvider } from "react-router";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { reviewRowSub, type ReviewRowView } from "./review-helpers";

/**
 * Route-level tests for /projects/:slug/review against the seeded demo
 * store: auth gating, the panel split (project-wide per ruling 10), and
 * the subline precedence contract (packet header → newest event → the
 * boundary placeholder copy).
 */

let app: AppTestContext;
let ardaId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
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
    expect(vib160.atReviewStage).toBe(false);
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

  it("falls back to the strict boundary for a store with no such project", async () => {
    const { resolveAcceptanceAuthority } = await import(
      "./review-acceptance-authority.server"
    );
    expect(
      resolveAcceptanceAuthority("no-such-project", { dataRoot: app.dataRoot }),
    ).toEqual({ operatorCanAccept: false, operatorName: "the operator" });
  });

  // F19-31: this test USED to pin "Agent working — the packet arrives at the
  // boundary." for a `waiting: "none"` row, which is the defect: the row claims
  // a live agent run while the board renders no wait tag at all for the very
  // same stored value. The placeholder is per-`waiting` now, so the test names
  // which placeholder each value gets instead of pinning one for all three.
  it("falls back to the placeholder matching the row's `waiting` when it has neither packet nor events", () => {
    const bare: ReviewRowView = {
      key: "VIB-999",
      title: "t",
      stageName: "Review",
      atReviewStage: true,
      priority: "normal",
      labels: [],
      dueDate: null,
      waiting: "none",
      packet: null,
      goalEditPending: false,
      latestEventText: null,
      pr: null,
      validation: "none",
      blockReason: null,
      lastActivityAt: null,
      quiet: false,
      continuity: null,
    };
    // Nothing is waiting on either side — say exactly that, claim no agent.
    expect(reviewRowSub(bare)).toBe(
      "At the review boundary: no agent is running and no decision is pending.",
    );
    // The agent sentence is not deleted, just no longer the catch-all: a row
    // that really IS waiting on an agent still gets it.
    expect(reviewRowSub({ ...bare, waiting: "agent" })).toBe(
      "Agent working. The packet arrives at the boundary.",
    );
    // R8-3, unchanged: a human-waiting bare row names a person, not an agent.
    expect(reviewRowSub({ ...bare, waiting: "human" })).toBe(
      "Waiting at the review boundary. Needs a human decision.",
    );
  });
});
