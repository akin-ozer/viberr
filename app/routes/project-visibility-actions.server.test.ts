import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RouterContextProvider } from "react-router";
import { z } from "zod";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";
import type { SeedUserIds } from "../../test-support/demo-data";

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
/**
 * The seeded people these cases POST as: arda is project admin, deniz a
 * non-member.
 */
let ids: SeedUserIds;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  ids = (await runDemoSeed(app.db, { dataRoot: app.dataRoot })).userIds;
});
afterAll(() => app.cleanup());

/**
 * A guard refuses by THROWING React Router's `data(message, { status })`, so
 * the rejection reaches the test untyped and is parsed where it lands.
 */
const thrownRefusalSchema = z.object({
  data: z.unknown(),
  init: z.object({ status: z.number() }).nullish(),
});

/** The `data(payload, { status })` envelope an action answers a bad intent on.
 *  `init.status` is required: a bare success object is not a refusal at all,
 *  and must fail the case rather than read as "some status other than 404". */
const statusEnvelopeSchema = z.object({
  init: z.object({ status: z.number() }),
});

/** The three routes, each with the pattern React Router matches it under. */
const ROUTES = [
  {
    name: "agents",
    path: "agents",
    pattern: "/projects/:slug/agents",
    load: () => import("~/routes/project.agents"),
  },
  {
    name: "settings",
    path: "settings",
    pattern: "/projects/:slug/settings",
    load: () => import("~/routes/project.settings"),
  },
  {
    name: "github",
    path: "github",
    pattern: "/projects/:slug/github",
    load: () => import("~/routes/project.github"),
  },
] as const;

async function post(
  route: (typeof ROUTES)[number],
  slug: string,
  userId: string,
  fields: Record<string, string>,
) {
  const { action } = await route.load();
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  const request = app.request(`/projects/${slug}/${route.path}`, {
    method: "POST",
    cookie,
    body: new URLSearchParams({ _csrf: csrf, ...fields }),
  });
  return action({
    request,
    url: new URL(request.url),
    params: { slug },
    pattern: route.pattern,
    context: new RouterContextProvider(),
  });
}

describe("project actions — a non-member never learns the project exists (E2)", () => {
  for (const route of ROUTES) {
    it(`${route.name}: refused as an unknown slug, not forbidden`, async () => {
      const thrown: unknown = await post(route, "viberr-core", ids.deniz, {
        intent: "no-such-intent",
      }).catch((e) => e);
      const refusal = thrownRefusalSchema.parse(thrown);
      expect(refusal.init?.status).toBe(404);
      expect(String(refusal.data)).toBe("No project at projects/viberr-core.");
    });

    it(`${route.name}: a member reaches the intent switch`, async () => {
      const result = statusEnvelopeSchema.parse(
        await post(route, "viberr-core", ids.arda, {
          intent: "no-such-intent",
        }),
      );
      // Past the gate: the route answers its own "unknown intent", not a 404.
      expect(result.init.status).not.toBe(404);
    });
  }
});
