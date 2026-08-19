import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../test-support/test-app";
import type { action as taskAction } from "~/routes/project.task";
import type { action as policyAction } from "~/routes/project.policy";

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
let ids: SeededUserIds;

/** The seeded humans every request in this file is issued as. */
interface SeededUserIds {
  arda: string;
  deniz: string;
}

/** What either gated action resolves to; each case narrows to the arm it drives. */
type GatedActionData =
  | Awaited<ReturnType<typeof taskAction>>
  | Awaited<ReturnType<typeof policyAction>>;

/**
 * The one export this harness drives on a gated route module. `never` for the
 * args is what lets both actions sit behind one contract: they are generated
 * with route-specific `ActionArgs`, and the harness hands them the two fields
 * they actually destructure (see `post`).
 */
type GatedRouteModule = {
  action: (args: never) => Promise<GatedActionData>;
};

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
  module: () => Promise<GatedRouteModule>;
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
): Promise<GatedActionData> {
  const { action } = await route.module();
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  // SAFETY: both gated actions destructure `request` and `params` and nothing
  // else; React Router's generated `ActionArgs` additionally carries the
  // framework's `context` provider, which no path under test reads. `as never`
  // supplies the two fields they do read without standing a router up.
  return action({
    request: app.request(route.path, {
      method: "POST",
      cookie,
      body: new URLSearchParams({ _csrf: csrf, ...fields }),
    }),
    params: route.params,
    context: {},
  } as never);
}

describe("requireVisibleProject — every project-scoped action", () => {
  for (const route of GATED) {
    it(`${route.name}: a non-member is refused as an unknown slug`, async () => {
      // SAFETY: deniz is not a member, so `requireVisibleProject` throws the
      // unknown-slug 404 envelope OUTSIDE the action's try — the catch below
      // receives what was thrown, never a returned arm, so both fields stay
      // optional.
      const thrown = (await post(route, ids.deniz, {
        intent: "no-such-intent",
      }).catch((e) => e)) as Refusal;
      expect(thrown?.init?.status).toBe(404);
      // Byte-identical to the loader's unknown-slug refusal: the response can
      // never confirm that `viberr-core` exists (WI-13).
      expect(String(thrown?.data)).toBe("No project at projects/viberr-core.");
    });

    it(`${route.name}: a member reaches the intent switch`, async () => {
      // SAFETY: arda is a member, so the gate passes and an unrecognised intent
      // falls through to each action's shared `data({ ok: false, error }, 400)`
      // arm — the only arm this request can reach.
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
        // SAFETY: as an org admin deniz clears the D2 override, so this lands on
        // the same unknown-intent `data(..., 400)` arm a member reaches.
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
