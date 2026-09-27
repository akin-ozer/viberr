import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RouterContextProvider } from "react-router";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import type { ModelCatalog } from "~/server/runtimes/model-catalog.server";
import { ERROR_CODES } from "~/server/errors/error-codes";

/**
 * Route-level tests for GET /resources/model-catalog: requires auth (a 401,
 * never a login redirect), answers the backend asked for (the curated lists
 * themselves are model-catalog.server.test.ts's), and defaults an unknown
 * backend to claude so the modal always renders.
 *
 * Ruling 127 gave this route BOTH arms to answer, and which one it takes is a
 * fact about the person asking: Claude's live `supportedModels()` list is what
 * ONE account offers, so the route resolves the VIEWER's own credential
 * (`runCredentialFor`) and hands it to the catalog. A viewer who has not
 * connected Claude is the ordinary case, not an error: they get the curated
 * list and no probe is spawned. Both arms are covered below, and the live one
 * is driven WITHOUT a network or a spawned binary by warming the catalog's own
 * per-home cache through its injectable query seam — which also proves the
 * route passes THAT viewer's home, since a cache entry belonging to another
 * home is a miss by construction.
 */

let app: AppTestContext;
let ardaId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda;
  // Ruling 127: the enhanced probe needs the VIEWER's own Claude credential,
  // and the demo seed connects nobody — so the route takes the curated path by
  // construction and never spawns a live supportedModels() query. That is the
  // product's real behaviour for a person who has not connected Claude, not a
  // test-only override.
  const { resetModelCatalogCache } = await import(
    "~/server/runtimes/model-catalog.server"
  );
  resetModelCatalogCache();
});
afterAll(() => {
  app.cleanup();
});

/** The wire body: the route wraps the catalog in `{ data }`. */
interface ModelCatalogBody {
  data: ModelCatalog;
}

/** One load, signed in with `cookie` or with no session at all. */
async function load(query: string, cookie?: string): Promise<Response> {
  const { loader } = await import("~/routes/resources.model-catalog");
  const request = app.request(
    `/resources/model-catalog${query}`,
    cookie ? { cookie } : {},
  );
  return await loader({
    request,
    url: new URL(request.url),
    params: {},
    pattern: "/resources/model-catalog",
    context: new RouterContextProvider(),
  });
}

async function runLoader(
  query: string,
  userId?: string,
): Promise<Response> {
  return load(query, userId ? (await app.cookieFor(userId)).cookie : undefined);
}

describe("resources/model-catalog", () => {
  /**
   * Ruling 457, test audit L14-29. The agent editors load this through a
   * fetcher when they open and when the backend changes, and `requireUser`
   * answered a missing session with a login redirect naming THIS route as the
   * returnTo: a fetcher follows a redirect as a navigation, so opening an
   * editor in a stale tab went to /login and, once signed in, to a page of
   * raw JSON. No session, or a forced password reset pending, answers 401 in
   * the conventions' JSON error shape, which the editor reads as a failed load
   * it offers to retry.
   */
  it("answers a signed-out load 401 in the conventions' error shape, never a login redirect", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const { updateUserFields } = await import("~/server/auth/user-store.server");
    updateUserFields(app.db, ardaId, { pwresetRequired: true });
    try {
      // CANARY: guard with `requireUser` again and both loads reject with its
      // 302 to /login?returnTo=%2Fresources%2Fmodel-catalog%3Fbackend%3Dcodex.
      for (const res of [await load("?backend=codex"), await load("?backend=codex", cookie)]) {
        expect({ status: res.status, body: await res.json() }).toEqual({
          status: 401,
          body: {
            error: {
              code: ERROR_CODES.UNAUTHORIZED,
              message: "Sign in to read the model catalog.",
            },
          },
        });
      }
    } finally {
      updateUserFields(app.db, ardaId, { pwresetRequired: false });
    }
  });

  it("defaults an unknown/missing backend to claude", async () => {
    const res = await runLoader("", ardaId);
    const body: ModelCatalogBody = await res.json();
    expect(body.data.defaultModel).toBe("sonnet");
  });

  /**
   * Ruling 127, the OTHER arm: a viewer who HAS connected Claude gets the list
   * their own account offers.
   *
   * Nothing here spawns a binary or opens a socket. The catalog caches a live
   * result under the HOME DIRECTORY that produced it (one person's subscription
   * must never decide another's picker), so warming that cache through the
   * module's injectable query seam, keyed to the home `runCredentialFor` will
   * hand the route, is enough: the route serving those models proves it passed
   * this viewer's credential, and a second viewer still getting the curated
   * list proves it did not pass somebody else's.
   */
  it("serves the VIEWER's own live model list once they have connected Claude, and nobody else's", async () => {
    const { connectFakeBackend, disconnectFakeBackend } = await import(
      "../../../test-support/backend-credentials"
    );
    const { insertUser } = await import("~/server/auth/user-store.server");
    const { backendAccountHome, userBackendHome } = await import(
      "~/server/runtimes/user-homes.server"
    );
    const { getBackendCredential } = await import(
      "~/server/runtimes/backend-credentials.server"
    );
    const { getModelCatalog, resetModelCatalogCache } = await import(
      "~/server/runtimes/model-catalog.server"
    );
    const stranger = insertUser(app.db, {
      id: "u_catalog_stranger",
      email: "stranger@viberr.test",
      name: "Stranger",
      role: "member",
    });
    await connectFakeBackend(app.db, ardaId, "claude");
    try {
      // The cache entry Arda's own credential would produce. The account's
      // home is the identity the catalog keys on (ruling 507), and it is the
      // one the route resolves for him (`runCredentialFor` reads the same one).
      const home = userBackendHome(ardaId, "claude");
      const account = getBackendCredential(app.db, ardaId, "claude")!;
      const accountHome = backendAccountHome(ardaId, "claude", account);
      const warmed = await getModelCatalog("claude", {
        credential: {
          env: { CLAUDE_CONFIG_DIR: accountHome },
          secrets: [],
          kind: "api_key",
          homeDir: home,
          accountId: account.id,
          accountHome,
          ownDirs: [],
        },
        claudeQueryFn: () =>
          Object.assign((async function* () {})(), {
            supportedModels: async () => [
              {
                value: "claude-sonnet-4-5",
                displayName: "Claude Sonnet (Arda's account)",
                description: "live",
                supportsEffort: true,
                supportedEffortLevels: ["low", "high"],
              },
            ],
            interrupt: async () => {},
          }),
      });
      expect(warmed.models.map((m) => m.value)).toEqual(["claude-sonnet-4-5"]);

      // The ROUTE, for the connected viewer: the live list, not the curated one.
      const mine: ModelCatalogBody = await (
        await runLoader("?backend=claude", ardaId)
      ).json();
      expect(mine.data.models.map((m) => m.value)).toEqual(["claude-sonnet-4-5"]);
      expect(mine.data.models[0]!.displayName).toContain("Arda's account");

      // …and for a viewer who has connected nothing: curated, with no probe.
      // (A stranger's cache miss cannot fall through to Arda's entry.)
      const theirs: ModelCatalogBody = await (
        await runLoader("?backend=claude", stranger.id)
      ).json();
      expect(theirs.data.models.map((m) => m.value)).toEqual([
        "sonnet",
        "opus",
        "haiku",
      ]);
    } finally {
      await disconnectFakeBackend(app.db, ardaId, "claude");
      resetModelCatalogCache();
    }
  });

  // R20-3 / F20-4: the route threads the db so `getModelCatalog` stamps each
  // model `unavailable` from the `model_availability` marks — the picker then
  // disables + explains a model a real run proved this account can't use.
  it("stamps a provider-refused model unavailable so the picker can disable it", async () => {
    const { markModelUnavailable, clearModelMark } = await import(
      "~/server/runtimes/model-availability.server"
    );
    markModelUnavailable(app.db, {
      backend: "codex",
      model: "gpt-5.6-sol",
      reason:
        "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
    });
    try {
      const res = await runLoader("?backend=codex", ardaId);
      const body: ModelCatalogBody = await res.json();
      const sol = body.data.models.find((m) => m.value === "gpt-5.6-sol");
      expect(sol?.unavailable?.reason).toContain("not supported");
      // An unmarked model carries no mark (unknown-but-offered, ruling 19).
      expect(
        body.data.models.find((m) => m.value === "gpt-5.6-terra")?.unavailable,
      ).toBeUndefined();
    } finally {
      clearModelMark(app.db, "codex", "gpt-5.6-sol");
    }
  });
});
