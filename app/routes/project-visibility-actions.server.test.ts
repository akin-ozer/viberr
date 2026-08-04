import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * E2, second half (pass 16): the same members-only gate on the three project
 * actions that still confirmed the project's existence.
 *
 * `project.board`'s action was the leak I reproduced live, but agents, settings
 * and github had the identical shape — `requireFormAction` and then straight
 * into an RBAC assert, with no `requireVisibleProject` — because React Router
 * does not run the layout loader for an action. A signed-in non-member got a
 * 403 ("your role cannot …"), which answers the only question R15-4 refuses to
 * answer: whether `projects/<slug>` is a real project.
 *
 * These three routes gate BEFORE the role assert, so a non-member gets the
 * byte-identical unknown-slug 404. The board's own coverage lives in
 * `project.board.server.test.ts`.
 */

let app: AppTestContext;
let ids: { arda: string; deniz: string };

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ids = {
    arda: findUserByEmail(app.db, "arda@viberr.dev")!.id, // project admin
    deniz: findUserByEmail(app.db, "deniz@viberr.dev")!.id, // non-member
  };
});
afterAll(() => app.cleanup());

type Refusal = { init?: { status: number }; data?: unknown };

const ROUTES = [
  { name: "agents", mod: "~/routes/project.agents", path: "agents" },
  { name: "settings", mod: "~/routes/project.settings", path: "settings" },
  { name: "github", mod: "~/routes/project.github", path: "github" },
] as const;

async function post(
  route: (typeof ROUTES)[number],
  slug: string,
  userId: string,
  fields: Record<string, string>,
): Promise<unknown> {
  const { action } = (await import(route.mod)) as {
    action: (args: never) => Promise<unknown>;
  };
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  return action({
    request: app.request(`/projects/${slug}/${route.path}`, {
      method: "POST",
      cookie,
      body: new URLSearchParams({ _csrf: csrf, ...fields }),
    }),
    params: { slug },
    context: {},
  } as never);
}

describe("project actions — a non-member never learns the project exists (E2)", () => {
  for (const route of ROUTES) {
    it(`${route.name}: refused as an unknown slug, not forbidden`, async () => {
      const thrown = (await post(route, "viberr-core", ids.deniz, {
        intent: "no-such-intent",
      }).catch((e) => e)) as Refusal;
      expect(thrown?.init?.status).toBe(404);
      expect(String(thrown?.data)).toBe("No project at projects/viberr-core.");
    });

    it(`${route.name}: a member reaches the intent switch`, async () => {
      const result = (await post(route, "viberr-core", ids.arda, {
        intent: "no-such-intent",
      })) as { init: { status: number } };
      // Past the gate: the route answers its own "unknown intent", not a 404.
      expect(result.init.status).not.toBe(404);
    });
  }
});
