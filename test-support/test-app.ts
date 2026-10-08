import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RouterContextProvider } from "react-router";
import { createTempDirs } from "./temp-dirs";

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
  /** Cookie header value for a fresh session of the given user. */
  cookieFor(userId: string): Promise<{ cookie: string; sessionId: string }>;
  /** Session-bound CSRF token (formData "_csrf" field). */
  csrfFor(sessionId: string): Promise<string>;
  /** One signed-in session per person for this context, made on first use and
   *  answered again after: every sign-in is a scrypt verify. */
  sessionFor(userId: string): Promise<{ cookie: string; csrf: string }>;
  /** Drops `userId`'s session, for a test that signed them out (a password
   *  change ends the person's other sessions). */
  forgetSession(userId: string): void;
  /** Request builder with session cookie + trusted origin headers. */
  request(
    url: string,
    init?: RequestInit & { cookie?: string },
  ): Request;
  cleanup(): void;
}

export const APP_TEST_PASSWORD = "test-harness-password-000";

/**
 * Its better-auth hash, made on the file's first sign-in. scrypt is slow on
 * purpose and any hash of the password verifies it, so every sign-in in the
 * file shares one, and a file that never signs in makes none.
 */
let appTestPasswordHash: Promise<string> | undefined;

export async function setupAppTest(): Promise<AppTestContext> {
  // A `createTempDirs` root, so one whose `cleanup` never ran (a second
  // `setupAppTest` in the same test) still goes when the file finishes.
  const temp = createTempDirs();
  const dataRoot = temp.make("viberr-app-test-");
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
    { getCsrfToken },
  ] = await Promise.all([
    import("~/lib/auth.server"),
    import("~/server/auth/identity.server"),
    import("~/server/auth/password.server"),
    import("~/server/auth/user-store.server"),
    import("~/server/auth/csrf.server"),
  ]);

  const sessions = new Map<string, { cookie: string; csrf: string }>();
  const context: AppTestContext = {
    db,
    dataRoot,
    async cookieFor(userId: string) {
      const user = findUserById(db, userId);
      if (!user) throw new Error(`cookieFor: no user ${userId}`);
      // Ensure a better-auth identity with a known password, then sign in:
      // provisioning overwrites the user's credential with this one.
      provisionIdentity(db, {
        id: user.id,
        email: user.email,
        name: user.name,
        passwordHash: await (appTestPasswordHash ??= hashPassword(APP_TEST_PASSWORD)),
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
      return getCsrfToken(sessionId);
    },
    async sessionFor(userId: string) {
      const known = sessions.get(userId);
      if (known) return known;
      const { cookie, sessionId } = await context.cookieFor(userId);
      const made = { cookie, csrf: getCsrfToken(sessionId) };
      sessions.set(userId, made);
      return made;
    },
    forgetSession(userId: string) {
      sessions.delete(userId);
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
      temp.cleanup();
    },
  };
  return context;
}

/**
 * The arguments React Router 8 hands a route's loader or action, built
 * whole so a direct call type-checks against the real route signature: the
 * request, its URL, the matched route's `params` and `pattern`, and a fresh
 * context. Without a dynamic segment the pattern is the request's path.
 */
export function routeArgs<Params extends Record<string, string>>(
  request: Request,
  params: Params,
  pattern: string = new URL(request.url).pathname,
) {
  return { request, url: new URL(request.url), params, pattern, context: new RouterContextProvider() };
}
