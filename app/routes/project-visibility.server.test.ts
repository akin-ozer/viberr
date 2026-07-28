import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../test-support/test-app";

/**
 * R15-4 on the ACTION side (`requireVisibleProject`).
 *
 * The layout loader refuses a non-member's READ with the unknown-slug 404, but
 * React Router runs a child route's ACTION without its parent's loader — so
 * every project-scoped action needs the same gate, in the same words. These
 * cases drive the real route actions: a non-member gets the byte-identical 404,
 * a member reaches the intent switch, and an ORG admin passes as the audited
 * D2 override.
 */

let app: AppTestContext;
let ids: { arda: string; deniz: string };

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ids = {
    arda: findUserByEmail(app.db, "arda@viberr.dev")!.id,
    deniz: findUserByEmail(app.db, "deniz@viberr.dev")!.id,
  };
});
afterAll(() => app.cleanup());

type Refusal = { init?: { status: number }; data?: unknown };

const GATED: {
  name: string;
  path: string;
  module: () => Promise<{ action: unknown }>;
  params: Record<string, string>;
}[] = [
  {
    name: "task detail",
    path: "/projects/viberr-core/tasks/VIB-142",
    module: () => import("~/routes/project.task"),
    params: { slug: "viberr-core", key: "VIB-142" },
  },
  {
    name: "policy",
    path: "/projects/viberr-core/policy",
    module: () => import("~/routes/project.policy"),
    params: { slug: "viberr-core" },
  },
];

async function post(
  route: (typeof GATED)[number],
  userId: string,
  fields: Record<string, string>,
): Promise<unknown> {
  const { action } = (await route.module()) as {
    action: (args: unknown) => Promise<unknown>;
  };
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  return action({
    request: app.request(route.path, {
      method: "POST",
      cookie,
      body: new URLSearchParams({ _csrf: csrf, ...fields }),
    }),
    params: route.params,
    context: {},
  });
}

describe("requireVisibleProject — every project-scoped action", () => {
  for (const route of GATED) {
    it(`${route.name}: a non-member is refused as an unknown slug`, async () => {
      const thrown = (await post(route, ids.deniz, {
        intent: "no-such-intent",
      }).catch((e) => e)) as Refusal;
      expect(thrown?.init?.status).toBe(404);
      // Byte-identical to the loader's unknown-slug refusal: the response can
      // never confirm that `viberr-core` exists (WI-13).
      expect(String(thrown?.data)).toBe("No project at projects/viberr-core.");
    });

    it(`${route.name}: a member reaches the intent switch`, async () => {
      const result = (await post(route, ids.arda, {
        intent: "no-such-intent",
      })) as { init: { status: number }; data: { error: string } };
      expect(result.init.status).toBe(400);
      expect(result.data.error).toBe("Unknown action.");
    });

    it(`${route.name}: an org admin passes as the D2 override`, async () => {
      const { updateUserFields } = await import(
        "~/server/auth/user-store.server"
      );
      updateUserFields(app.db, ids.deniz, { role: "admin" });
      try {
        const result = (await post(route, ids.deniz, {
          intent: "no-such-intent",
        })) as { init: { status: number } };
        expect(result.init.status).toBe(400);
      } finally {
        updateUserFields(app.db, ids.deniz, { role: "member" });
      }
    });
  }
});
