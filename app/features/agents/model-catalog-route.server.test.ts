import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RouterContextProvider } from "react-router";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import type { ModelCatalog } from "~/server/runtimes/model-catalog.server";

/**
 * Route-level tests for GET /resources/model-catalog: requires auth,
 * returns the curated catalog shape per backend (claude enhances live only
 * when a credential is present — none in tests, so curated), and defaults
 * an unknown backend to claude so the modal always renders.
 */

let app: AppTestContext;
let ardaId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
  // Deterministic curated path: force claude unavailable so the route never
  // spawns a live supportedModels() query against an ambient dev credential.
  const { setBackendAvailability } = await import(
    "~/server/runtimes/runtime-registry.server"
  );
  const { resetModelCatalogCache } = await import(
    "~/server/runtimes/model-catalog.server"
  );
  setBackendAvailability("claude", false);
  resetModelCatalogCache();
});
afterAll(async () => {
  const { resetRegistryForTests } = await import(
    "~/server/runtimes/runtime-registry.server"
  );
  resetRegistryForTests();
  app.cleanup();
});

/** The wire body: the route wraps the catalog in `{ data }`. */
interface ModelCatalogBody {
  data: ModelCatalog;
}

async function runLoader(
  query: string,
  userId?: string,
): Promise<Response> {
  const { loader } = await import("~/routes/resources.model-catalog");
  const cookie = userId ? (await app.cookieFor(userId)).cookie : undefined;
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

describe("resources/model-catalog", () => {
  it("redirects signed-out users to /login", async () => {
    const thrown = await runLoader("?backend=claude").catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    // SAFETY: the assertion above has already failed the test unless `thrown`
    // is the redirect Response `requireUser` throws for a signed-out request.
    expect((thrown as Response).status).toBe(302);
  });

  it("returns the curated claude catalog for a signed-in user", async () => {
    const res = await runLoader("?backend=claude", ardaId);
    const body: ModelCatalogBody = await res.json();
    expect(body.data.models.map((m) => m.value)).toEqual([
      "sonnet",
      "opus",
      "haiku",
    ]);
    expect(body.data.defaultModel).toBe("sonnet");
    expect(body.data.defaultEffort).toBe("high");
    expect(body.data.efforts).toContain("xhigh");
  });

  it("returns the curated codex catalog", async () => {
    const res = await runLoader("?backend=codex", ardaId);
    const body: ModelCatalogBody = await res.json();
    // Sol is still OFFERED, but F20-33 makes Terra the default (Sol 400s on a
    // ChatGPT-plan Codex account, so a model-less operator must not fall back to it).
    expect(body.data.models.map((m) => m.value)).toContain("gpt-5.6-sol");
    expect(body.data.defaultModel).toBe("gpt-5.6-terra");
    expect(body.data.efforts).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("defaults an unknown/missing backend to claude", async () => {
    const res = await runLoader("", ardaId);
    const body: ModelCatalogBody = await res.json();
    expect(body.data.defaultModel).toBe("sonnet");
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
