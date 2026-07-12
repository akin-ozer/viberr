import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  const { runDemoSeed } = await import("~/server/seed/demo-seed.server");
  runDemoSeed(app.db, { dataRoot: app.dataRoot });
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

async function runLoader(
  query: string,
  userId?: string,
): Promise<Response> {
  const { loader } = await import("~/routes/resources.model-catalog");
  const cookie = userId ? (await app.cookieFor(userId)).cookie : undefined;
  return (await loader({
    request: app.request(
      `/resources/model-catalog${query}`,
      cookie ? { cookie } : {},
    ),
    params: {},
    context: {},
  } as never)) as Response;
}

describe("resources/model-catalog", () => {
  it("redirects signed-out users to /login", async () => {
    const thrown = await runLoader("?backend=claude").catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
  });

  it("returns the curated claude catalog for a signed-in user", async () => {
    const res = await runLoader("?backend=claude", ardaId);
    const body = (await res.json()) as { data: ModelCatalog };
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
    const body = (await res.json()) as { data: ModelCatalog };
    expect(body.data.models.map((m) => m.value)).toContain("gpt-5.6-sol");
    expect(body.data.defaultModel).toBe("gpt-5.6-sol");
    expect(body.data.efforts).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("defaults an unknown/missing backend to claude", async () => {
    const res = await runLoader("", ardaId);
    const body = (await res.json()) as { data: ModelCatalog };
    expect(body.data.defaultModel).toBe("sonnet");
  });
});
