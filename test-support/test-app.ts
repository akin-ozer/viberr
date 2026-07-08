import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

/**
 * Route-level test harness (phase 4): points the PROCESS env at a temp data
 * root, resets the env + db singletons, and hands back the same getDb()
 * handle the route loaders/actions will use — so tests can call the actual
 * route module functions with real Requests (signed session cookies, CSRF
 * tokens) end to end.
 *
 * Import route modules AFTER setupAppTest() (dynamic import in the test) so
 * their module graph reads the overridden env.
 */

export interface AppTestContext {
  db: Database.Database;
  dataRoot: string;
  sessionSecret: string;
  /** Cookie header value for a fresh session of the given user. */
  cookieFor(userId: string): Promise<{ cookie: string; sessionId: string }>;
  /** Session-bound CSRF token (formData "_csrf" field). */
  csrfFor(sessionId: string): Promise<string>;
  /** Request builder with session cookie + trusted origin headers. */
  request(
    url: string,
    init?: RequestInit & { cookie?: string },
  ): Request;
  cleanup(): void;
}

export async function setupAppTest(): Promise<AppTestContext> {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-app-test-"));
  const sessionSecret = "test-session-secret-test-session-secret";
  process.env.NODE_ENV = "test";
  process.env.VIBERR_SESSION_SECRET = sessionSecret;
  process.env.VIBERR_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.VIBERR_DATA_ROOT = dataRoot;
  delete process.env.VIBERR_SEED_ADMIN_EMAIL;
  delete process.env.VIBERR_SEED_ADMIN_PASSWORD;

  const { resetEnvCacheForTests } = await import(
    "~/server/config/env.server"
  );
  const { closeDb, getDb } = await import("~/server/db/sqlite.server");
  resetEnvCacheForTests();
  closeDb();
  const db = getDb();

  const { getAuth } = await import("~/lib/auth.server");
  const { provisionIdentity } = await import("~/server/auth/identity.server");
  const { hashPassword } = await import("~/server/auth/password.server");
  const { findUserById } = await import("~/server/auth/user-store.server");
  const { csrfTokenForSession } = await import("~/server/auth/csrf.server");

  // cookieFor signs the user in through better-auth, so it needs a known
  // credential — provisioning overwrites the user's credential with this.
  const HARNESS_PASSWORD = "test-harness-password-000";

  return {
    db,
    dataRoot,
    sessionSecret,
    async cookieFor(userId: string) {
      const user = findUserById(db, userId);
      if (!user) throw new Error(`cookieFor: no user ${userId}`);
      // Ensure a better-auth identity with a known password, then sign in.
      provisionIdentity(db, {
        id: user.id,
        email: user.email,
        name: user.name,
        passwordHash: hashPassword(HARNESS_PASSWORD),
        role: user.role,
      });
      const res = await getAuth().api.signInEmail({
        body: { email: user.email, password: HARNESS_PASSWORD },
        asResponse: true,
      });
      const setCookie = res.headers
        .getSetCookie()
        .find((c) => c.includes("viberr.session_token"));
      if (!setCookie) throw new Error("cookieFor: no session cookie issued");
      const session = db
        .prepare(
          `SELECT id FROM session WHERE userId = ? ORDER BY createdAt DESC LIMIT 1`,
        )
        .get(user.id) as { id: string };
      return { cookie: setCookie.split(";")[0], sessionId: session.id };
    },
    async csrfFor(sessionId: string) {
      return csrfTokenForSession(sessionId, sessionSecret);
    },
    request(url: string, init: RequestInit & { cookie?: string } = {}) {
      const { cookie, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (cookie) headers.set("Cookie", cookie);
      // Same-origin marker so assertTrustedOrigin passes on POSTs.
      headers.set("Origin", "http://localhost:5173");
      return new Request(new URL(url, "http://localhost:5173"), {
        ...rest,
        headers,
      });
    },
    cleanup() {
      closeDb();
      resetEnvCacheForTests();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}
