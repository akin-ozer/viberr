import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * Route-level guard tests for /projects/:slug/board's action.
 *
 * E2 (found live): a signed-in NON-member POSTing `intent=create-task` here got
 * **403** — "Only project members can create tasks" — while the same user got a
 * 404 from every other project route and every other intent. That single outlier
 * confirmed the project exists, which is exactly what R15-4 (members-only
 * projects, WI-13 secrecy) refuses to do. The board action now runs
 * `requireVisibleProject` first, like the task and policy actions do, so the
 * refusal is the byte-identical unknown-slug 404 for all three intents.
 *
 * A member below the required tier still gets the honest 403 — the project is
 * not a secret from its own members.
 */

let app: AppTestContext;
let ids: { arda: string; selin: string; deniz: string };

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ids = {
    arda: findUserByEmail(app.db, "arda@viberr.dev")!.id, // project admin
    selin: findUserByEmail(app.db, "selin@viberr.dev")!.id, // contributor
    deniz: findUserByEmail(app.db, "deniz@viberr.dev")!.id, // non-member
  };
});
afterAll(() => app.cleanup());

type Refusal = { init?: { status: number }; data?: unknown };

async function post(
  slug: string,
  userId: string,
  fields: Record<string, string>,
): Promise<unknown> {
  const { action } = await import("~/routes/project.board");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  return action({
    request: app.request(`/projects/${slug}/board`, {
      method: "POST",
      cookie,
      body: new URLSearchParams({ _csrf: csrf, ...fields }),
    }),
    params: { slug },
    context: {},
  } as never);
}

const INTENTS: Record<string, string>[] = [
  { intent: "create-task", title: "Probe", goal: "a goal long enough to pass" },
  { intent: "reorder", taskKey: "VIB-142", to: "impl", beforeKey: "" },
  { intent: "rescan" },
  { intent: "no-such-intent" },
];

describe("board action — a non-member never learns the project exists (E2)", () => {
  for (const fields of INTENTS) {
    it(`${fields.intent}: refused as an unknown slug, not forbidden`, async () => {
      const thrown = (await post("viberr-core", ids.deniz, fields).catch(
        (e) => e,
      )) as Refusal;
      expect(thrown?.init?.status).toBe(404);
      expect(String(thrown?.data)).toBe("No project at projects/viberr-core.");
    });
  }

  it("a member reaches the intent switch", async () => {
    const result = (await post("viberr-core", ids.arda, {
      intent: "no-such-intent",
    })) as { init: { status: number }; data: { error: string } };
    expect(result.init.status).toBe(400);
    expect(result.data.error).toBe("Unknown action.");
  });

  it("an org admin passes as the audited D2 override", async () => {
    const { updateUserFields } = await import("~/server/auth/user-store.server");
    updateUserFields(app.db, ids.deniz, { role: "admin" });
    try {
      const result = (await post("viberr-core", ids.deniz, {
        intent: "no-such-intent",
      })) as { init: { status: number } };
      expect(result.init.status).toBe(400);
    } finally {
      updateUserFields(app.db, ids.deniz, { role: "member" });
    }
  });

  it("a MEMBER below the required tier still gets the honest 403", async () => {
    // The secrecy rule is about non-members. Selin is a contributor here, so she
    // may open the board and must be told plainly why she cannot reorder it —
    // turning THAT into a 404 would be a different lie.
    const result = (await post("viberr-core", ids.selin, {
      intent: "reorder",
      taskKey: "VIB-142",
      to: "impl",
      beforeKey: "",
    })) as { init: { status: number }; data: { error: string } };
    expect(result.init.status).toBe(403);
    expect(result.data.error).toMatch(
      /role \(contributor\) cannot reorder the board/i,
    );
  });
});
