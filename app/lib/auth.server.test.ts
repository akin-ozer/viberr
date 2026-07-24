import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../test-support/test-db";
import {
  ALLOWED_AUTH_PATHS,
  AUTH_BASE_PATH,
  createAuth,
  type ViberrAuth,
} from "~/lib/auth.server";

/**
 * The `/api/auth/*` allow-list gate (P11-02). `/api/auth/*` is a splat
 * (routes/api.auth.$.ts), so EVERY endpoint Better Auth registers is reachable
 * — including account-mutating ones (update-user, change-password,
 * forget-password) the app deliberately does NOT drive because it owns those
 * flows itself with auditing + session revocation. The `before` hook rejects
 * any path outside ALLOWED_AUTH_PATHS with a 404. This behavior rides on
 * version-sensitive Better Auth internals (the hook fires for every registered
 * endpoint, `ctx.path` is the un-prefixed declared path), so it is exercised
 * end-to-end through `auth.handler` rather than by inspecting the set alone.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function makeAuth(db: DatabaseSync): ViberrAuth {
  return createAuth({
    db,
    secret: "test-secret-at-least-32-characters-long-000",
    baseURL: "http://localhost:5173",
    trustedOrigins: ["http://localhost:5173"],
  });
}

function get(auth: ViberrAuth, path: string) {
  return auth.handler(
    new Request(`http://localhost:5173${AUTH_BASE_PATH}${path}`, {
      method: "GET",
      headers: { Origin: "http://localhost:5173" },
    }),
  );
}

function post(auth: ViberrAuth, path: string, body: Record<string, unknown>) {
  return auth.handler(
    new Request(`http://localhost:5173${AUTH_BASE_PATH}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:5173",
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("ALLOWED_AUTH_PATHS gate", () => {
  it("pins the driven set to exactly the six endpoints the app uses", () => {
    // A guard against silent widening: adding a path here must be deliberate.
    expect([...ALLOWED_AUTH_PATHS].sort()).toEqual(
      [
        "/callback/:id",
        "/error",
        "/get-session",
        "/sign-in/email",
        "/sign-in/social",
        "/sign-out",
      ].sort(),
    );
  });

  it("lets an allowed path (get-session) through the gate", async () => {
    const auth = makeAuth(ctx.makeDb());
    // No session cookie → Better Auth answers 200 with a null session. The
    // point is only that the gate did NOT 404 it.
    const res = await get(auth, "/get-session");
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(200);
  });

  it("404s a registered-but-not-allowed Better Auth endpoint (update-user)", async () => {
    const auth = makeAuth(ctx.makeDb());
    // update-user is a real Better Auth endpoint; the app never drives it (it
    // would split-brain the canonical `users` row), so the gate rejects it
    // BEFORE the endpoint runs — a 404, not a 401/200.
    const res = await post(auth, "/update-user", { name: "Mallory" });
    expect(res.status).toBe(404);
  });

  it("404s another account-mutating endpoint (forget-password)", async () => {
    const auth = makeAuth(ctx.makeDb());
    const res = await post(auth, "/forget-password", {
      email: "someone@viberr.test",
    });
    expect(res.status).toBe(404);
  });
});
