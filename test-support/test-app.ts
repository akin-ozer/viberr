import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * Route-level test harness (phase 4): points the PROCESS env at a temp data
 * root, resets the env + db singletons, installs the fake runtime, and hands
 * back the same getDb() handle the route loaders/actions will use — so tests
 * can call the actual route module functions with real Requests (signed
 * session cookies, CSRF tokens) end to end.
 *
 * Import route modules AFTER setupAppTest() (dynamic import in the test) so
 * their module graph reads the overridden env.
 */

export interface AppTestContext {
  db: DatabaseSync;
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

export const APP_TEST_PASSWORD = "test-harness-password-000";

export async function setupAppTest(): Promise<AppTestContext> {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-app-test-"));
  const sessionSecret = "test-session-secret-test-session-secret";
  process.env.NODE_ENV = "test";
  process.env.VIBERR_SESSION_SECRET = sessionSecret;
  process.env.VIBERR_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.VIBERR_DATA_ROOT = dataRoot;
  delete process.env.VIBERR_SEED_ADMIN_EMAIL;
  delete process.env.VIBERR_SEED_ADMIN_PASSWORD;

  const [{ resetEnvCacheForTests }, { closeDb, getDb }] = await Promise.all([
    import("~/server/config/env.server"),
    import("~/server/db/sqlite.server"),
  ]);
  resetEnvCacheForTests();
  closeDb();
  const db = getDb();

  // Fail closed on the runtime too: every route-level test gets the fake
  // adapters. Without this a test that reaches autoInvokeOperator falls through
  // to selectAdapter and constructs a REAL adapter — a paid provider call from
  // `npm test` the moment a credential leaks in. The fakes complete
  // deterministically instead.
  //
  // Ruling 127: this decides only WHICH adapter a run reaches, never whether
  // it may run. That is a fact about the run's credential principal, so a test
  // whose dispatch must reach an adapter connects the backend for the person
  // it bills (`connectFakeBackend` in test-support/backend-credentials.ts),
  // and one that wants a refusal simply leaves them unconnected.
  const { installFakeRuntime } = await import("./fake-runtime");
  installFakeRuntime();

  const [
    { getAuth },
    { provisionIdentity },
    { hashPassword },
    { findUserById },
    { csrfTokenForSession },
  ] = await Promise.all([
    import("~/lib/auth.server"),
    import("~/server/auth/identity.server"),
    import("~/server/auth/password.server"),
    import("~/server/auth/user-store.server"),
    import("~/server/auth/csrf.server"),
  ]);

  // cookieFor signs the user in through better-auth, so it needs a known
  // credential — provisioning overwrites the user's credential with this.
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
        passwordHash: await hashPassword(APP_TEST_PASSWORD),
      });
      // cookieFor is harness plumbing that mints a session, not a login under
      // test, but it goes through better-auth's sign-in hook and so spends a
      // token from the per-`email|ip` login bucket — which is a per-process
      // global shared by every test in this worker. Clear just this key first
      // so a file that signs the same user in more than ten times doesn't
      // start failing with "Too many sign-in attempts". Tests that assert
      // throttling drive loginWithCredentials / the handler directly and are
      // unaffected.
      const { clientIpOf, getLoginRateLimiter } = await import(
        "~/server/auth/rate-limit.server"
      );
      getLoginRateLimiter().reset(`${user.email.trim().toLowerCase()}|${clientIpOf()}`);
      const res = await getAuth().api.signInEmail({
        body: { email: user.email, password: APP_TEST_PASSWORD },
        asResponse: true,
      });
      const setCookie = res.headers
        .getSetCookie()
        .find((c) => c.includes("viberr.session_token"));
      if (!setCookie) throw new Error("cookieFor: no session cookie issued");
      // SAFETY: the SELECT list is the single NOT NULL `session.id` column, and
      // the `!setCookie` guard above already failed if better-auth did not just
      // write the row this statement reads back.
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
