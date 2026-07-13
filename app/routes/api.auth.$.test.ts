import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "~/server/config/env.server";
import { action, loader } from "./api.auth.$";

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:5173");
  resetEnvCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCacheForTests();
});

describe("Better Auth canonical local origin guard", () => {
  it("rejects an alias-host social POST before an OAuth state cookie is set", async () => {
    const response = await action({
      request: new Request(
        "http://127.0.0.1:5173/api/auth/sign-in/social",
        { method: "POST", headers: { Origin: "http://127.0.0.1:5173" } },
      ),
    } as Parameters<typeof action>[0]);

    expect(response.status).toBe(409);
    expect(response.headers.get("location")).toBe(
      "http://localhost:5173/api/auth/sign-in/social",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CANONICAL_ORIGIN_REQUIRED" },
    });
  });

  it("also refuses direct alias-host GET resource requests without cookies", async () => {
    const response = await loader({
      request: new Request("http://127.0.0.1:5173/api/auth/get-session"),
    } as Parameters<typeof loader>[0]);

    expect(response.status).toBe(409);
    expect(response.headers.get("location")).toBe(
      "http://localhost:5173/api/auth/get-session",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
