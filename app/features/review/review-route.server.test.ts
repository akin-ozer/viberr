import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  const { runDemoSeed } = await import("~/server/seed/demo-seed.server");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
});
afterAll(() => app.cleanup());

async function runLoader(slug: string, cookie?: string) {
  const { loader } = await import("~/routes/project.review");
  return loader({
    request: app.request(`/projects/${slug}/review`, cookie ? { cookie } : {}),
    params: { slug },
    context: {},
  } as never);
}

describe("/projects/:slug/review", () => {
  it("redirects signed-out users to /login", async () => {
    const thrown = await runLoader("viberr-core").catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
  });

  it("404s for an unknown project", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const thrown = await runLoader("nope", cookie).catch((e) => e);
    expect(thrown?.init?.status ?? thrown?.status).toBe(404);
  });

  it("splits the seeded review stage: VIB-142 waits on a human, VIB-145 with agents", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const result = (await runLoader("viberr-core", cookie)) as {
      slug: string;
      ready: ReviewRowView[];
      working: ReviewRowView[];
      total: number;
    };

    expect(result.total).toBe(2);
    // F10-11/F10-15: acceptance readiness is revision-bound now. VIB-142 has a
    // verdict-capable reviewer engaged but no approving verdict on its current
    // revision (validation "changed"), so it is NOT acceptance-ready — it sits
    // in "Still in review" with an honest block reason, not the acceptance
    // panel. VIB-145 waits on agents.
    expect(result.ready.map((t) => t.key)).toEqual([]);
    expect(result.working.map((t) => t.key)).toEqual(["VIB-142", "VIB-145"]);

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

  it("falls back to the boundary placeholder when a row has neither packet nor events", () => {
    const bare: ReviewRowView = {
      key: "VIB-999",
      title: "t",
      waiting: "none",
      packet: null,
      latestEventText: null,
      pr: null,
      validation: "none",
      blockReason: null,
    };
    expect(reviewRowSub(bare)).toBe(
      "Agent working — the packet arrives at the boundary.",
    );
  });
});
