import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { DatabaseSync } from "node:sqlite";
import { MIN_PASSWORD_LENGTH } from "~/shared/auth/password-policy";
import { hashPassword, verifyPassword } from "~/server/auth/password.server";
import {
  clientIpOf,
  getLoginRateLimiter,
  getSocialStartRateLimiter,
} from "~/server/auth/rate-limit.server";
import {
  applyOAuthUser,
  isOAuthWhitelisted,
  linkOAuth,
} from "~/server/auth/oauth-provision.server";
import { getEnv } from "~/server/config/env.server";
import { getDb } from "~/server/db/sqlite.server";

/**
 * better-auth instance (authN mechanics only).
 *
 * Better Auth owns credentials, sessions, and OAuth. The `users` table owns
 * application profile and authorization data. Both rows share the same id.
 *
 * - Cookie: `viberr.session_token` (cookiePrefix "viberr"), signed with the
 *   existing VIBERR_SESSION_SECRET — no new required env.
 * - Sessions: 30-day rolling (expiresIn) with a daily slide (updateAge), to
 *   match the retired hand-rolled session TTL.
 * - Passwords: better-auth owns hashing and verification.
 * - Sign-up is disabled: identities are provisioned through the whitelist
 *   (seed admin, org-users invite, OAuth provisioning hooks), never open reg.
 */

export const AUTH_BASE_PATH = "/api/auth";

/**
 * Built-in Better Auth endpoints the app does NOT use and that must not be
 * reachable through the `/api/auth/*` splat (P11-02). The app owns these flows
 * itself (audited, session-revoking) — exposing Better Auth's versions would
 * bypass that governance or split-brain the canonical `users` row.
 */
export const BLOCKED_AUTH_PATHS = new Set<string>([
  "/change-password",
  "/change-email",
  "/update-user",
  "/delete-user",
  "/forget-password",
  "/reset-password",
  "/request-password-reset",
]);

/** The concrete better-auth instance type (with our plugins). */
export type ViberrAuth = ReturnType<typeof betterAuth>;

export interface AuthDeps {
  /** The app database handle. */
  db: DatabaseSync;
  /** Cookie-signing secret (>=32 chars) — reuse VIBERR_SESSION_SECRET. */
  secret: string;
  /**
   * Absolute app origin, e.g. http://localhost:5173. Undefined lets
   * better-auth infer the origin per request (correct for dev's varying port).
   */
  baseURL?: string;
  /** Origins allowed to POST to the auth handler (same-origin always ok). */
  trustedOrigins: string[];
  github?: { clientId: string; clientSecret: string };
  google?: { clientId: string; clientSecret: string };
}

/**
 * Pure options builder — the gen/validation script and the app both use this
 * so the schema that ships is exactly the schema the app runs against.
 */
export function buildAuthOptions(deps: AuthDeps): BetterAuthOptions {
  const socialProviders: NonNullable<BetterAuthOptions["socialProviders"]> = {};
  if (deps.github) {
    socialProviders.github = {
      clientId: deps.github.clientId,
      clientSecret: deps.github.clientSecret,
      // Match the retired hand-rolled scopes (read profile + verified emails).
      scope: ["read:user", "user:email"],
      // Carry the GitHub login into the user so the whitelist hook can mirror
      // it to legacy users.github_handle and claim placeholder rows.
      mapProfileToUser: (profile) => ({
        githubHandle: (profile as { login?: string }).login ?? null,
      }),
    };
  }
  if (deps.google) {
    socialProviders.google = {
      clientId: deps.google.clientId,
      clientSecret: deps.google.clientSecret,
      // Force account chooser + refresh token, as the old flow did.
      accessType: "offline",
      prompt: "select_account consent",
    };
  }

  return {
    appName: "Viberr",
    database: deps.db,
    secret: deps.secret,
    baseURL: deps.baseURL,
    basePath: AUTH_BASE_PATH,
    trustedOrigins: deps.trustedOrigins,
    emailAndPassword: {
      enabled: true,
      // No open registration — the whitelist provisions identities.
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      // Total hashing hooks (P11-01): a stored credential in a legacy/foreign
      // format (e.g. the pre-better-auth `scrypt$N$r$p$salt$key` shape) makes
      // Better Auth's built-in verifier THROW "Invalid password hash". Because
      // `/api/auth/*` is a splat (routes/api.auth.$.ts), that throw surfaces as
      // an unhandled 500 on a direct `POST /api/auth/sign-in/email`, and the
      // account is effectively unrecoverable. Routing through the app's own
      // wrappers makes verification TOTAL: `verifyPassword` catches any parse
      // failure and returns false, so an unparseable hash reads as a wrong
      // password (401) rather than a 500 — and hashing uses the exact same
      // format everywhere.
      password: {
        hash: (password) => hashPassword(password),
        verify: ({ hash, password }) => verifyPassword(password, hash),
      },
    },
    rateLimit: {
      enabled: true,
      customRules: {
        // Off here, throttled in server/auth/login.server.ts instead.
        //
        // Better Auth keys its limiter on the client ip, and Viberr ships
        // without a reverse proxy (Dockerfile + compose.yml run
        // react-router-serve directly), so there is no X-Forwarded-For and
        // `getIp()` returns null outside dev/test. Every sign-in then shares
        // ONE bucket, "no-trusted-ip|/sign-in/email" — under any max, N
        // unauthenticated POSTs lock every user in the org out for the rest of
        // the window. Raising the max only raises N; it cannot make the bucket
        // stop being shared, so it stays a denial-of-login lever.
        //
        // The app-level token bucket in the `before` hook below is
        // authoritative instead: its key is `email|ip`, so one identity's
        // failures can never deny another's sign-in, and it holds the same
        // 10-per-15-minutes policy. Setting a rule to `false` also suppresses
        // Better Auth's /sign-in default (3 per 10s), which is the same shared
        // bucket, only tighter.
        "/sign-in/email": false,
        // Same shared-bucket lever, same fix. `/sign-in/social` is a live path
        // (login.tsx and profile-page.tsx both POST it to start GitHub/Google),
        // and Better Auth's default here is the tighter 3-per-10s `/sign-in`
        // rule — so three people clicking "Sign in with GitHub" at once is
        // enough to deny social sign-in to the entire org for the window.
        // Throttled in the `before` hook below instead.
        "/sign-in/social": false,
      },
    },
    hooks: {
      /**
       * Per-`email|ip` login throttle. This lives on the HOOK rather than in
       * loginWithCredentials because `/api/auth/*` is mounted as a splat
       * (routes/api.auth.$.ts), so a POST straight to /api/auth/sign-in/email
       * reaches better-auth without passing through the app's login action —
       * throttling only in the app action would leave that path unlimited.
       * loginWithCredentials also drives better-auth through `auth.handler`,
       * so both entry points pass here and each attempt costs exactly one
       * token. The pre-check failures that return before the handler
       * (unknown_email / disabled / no_password) consume their own token in
       * login.server.ts, so email enumeration is bounded by the same bucket.
       */
      before: createAuthMiddleware(async (ctx) => {
        const ip = clientIpOf(ctx.headers);
        // P11-02: the `/api/auth/*` handler is a splat (routes/api.auth.$.ts), so
        // EVERY built-in Better Auth endpoint is reachable — including account
        // mutations Viberr does NOT use because it owns those flows itself with
        // auditing + session revocation (profile change-password, admin
        // user-edit/reset). Left open, `/change-password` would bypass the app's
        // audit + other-session kill, and `/update-user` would write Better
        // Auth's `user.name` only, diverging from the canonical `users` row
        // (split-brain). The password-reset endpoints are inert (no
        // sendResetPassword configured) but still answer and share Better Auth's
        // org-wide limiter bucket. Reject them all with a 404 so the splat only
        // exposes the endpoints the app actually drives (sign-in, sign-out,
        // get-session, the OAuth callback dance).
        if (BLOCKED_AUTH_PATHS.has(ctx.path)) {
          throw new APIError("NOT_FOUND", { message: "Not found." });
        }
        if (ctx.path === "/sign-in/email") {
          const email =
            typeof ctx.body?.email === "string" ? ctx.body.email.trim().toLowerCase() : "";
          if (!getLoginRateLimiter().tryConsume(`${email}|${ip}`)) {
            throw new APIError("TOO_MANY_REQUESTS", {
              message: "Too many sign-in attempts. Try again later.",
            });
          }
          return;
        }
        // `/sign-in/social` carries no identity — it only mints the provider
        // redirect URL — so provider+ip is the finest key available and the
        // bucket is org-wide without a proxy. Sized (30/min) to be unreachable
        // by real use while still displacing Better Auth's 3-per-10s default,
        // which is the actual denial-of-login lever on this path.
        if (ctx.path === "/sign-in/social") {
          const provider =
            typeof ctx.body?.provider === "string" ? ctx.body.provider : "";
          if (!getSocialStartRateLimiter().tryConsume(`${provider}|${ip}`)) {
            throw new APIError("TOO_MANY_REQUESTS", {
              message: "Too many sign-in attempts. Try again later.",
            });
          }
        }
      }),
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days, matching the old SESSION_TTL_MS
      updateAge: 60 * 60 * 24, // slide at most once/day (old renew interval)
    },
    user: {
      additionalFields: {
        // Captured from the GitHub OAuth profile; mirrored to legacy
        // users.github_handle by the whitelist hook.
        githubHandle: { type: "string", required: false, input: false },
      },
    },
    socialProviders,
    account: {
      // Link a social sign-in to an already-provisioned identity by verified
      // email, so an OAuth login for a whitelisted user reuses their row
      // (preserving user.id === users.id) instead of creating a duplicate.
      accountLinking: {
        enabled: true,
        trustedProviders: ["github", "google", "credential"],
      },
    },
    // Whitelist + provisioning: better-auth owns the OAuth dance; these hooks
    // gate NEW social users against Viberr's whitelist and keep the legacy
    // `users` row in step. `deps.db` is the request-time app database.
    databaseHooks: {
      user: {
        create: {
          before: (user) =>
            Promise.resolve(
              isOAuthWhitelisted(deps.db, {
                id: String(user.id),
                email: user.email,
                name: user.name,
                githubHandle: (user as { githubHandle?: string | null })
                  .githubHandle,
              })
                ? undefined
                : false,
            ),
          after: (user) => {
            applyOAuthUser(deps.db, {
              id: String(user.id),
              email: user.email,
              name: user.name,
              githubHandle: (user as { githubHandle?: string | null })
                .githubHandle,
            });
            return Promise.resolve();
          },
        },
      },
      account: {
        create: {
          after: (account) => {
            linkOAuth(deps.db, account.userId, account.providerId);
            return Promise.resolve();
          },
        },
      },
    },
    advanced: { cookiePrefix: "viberr" },
  };
}

export function createAuth(deps: AuthDeps): ReturnType<typeof betterAuth> {
  return betterAuth(buildAuthOptions(deps));
}

// Process-wide singleton, cached across dev-server HMR reloads via a symbol
// (mirrors getDb / getEnv). Keyed to the current db handle so it rebuilds when
// the db singleton is reset — tests call closeDb() between cases, so a stale
// instance would otherwise query a closed database.
const AUTH_CACHE_KEY = Symbol.for("viberr.betterAuth");

interface AuthCacheEntry {
  db: DatabaseSync;
  auth: ReturnType<typeof betterAuth>;
}

/** The app's better-auth instance (from getEnv + getDb). */
export function getAuth(): ReturnType<typeof betterAuth> {
  const cache = globalThis as unknown as Record<
    symbol,
    AuthCacheEntry | undefined
  >;
  const db = getDb();
  const entry = cache[AUTH_CACHE_KEY];
  if (!entry || entry.db !== db) {
    const env = getEnv();
    const baseURL = env.BETTER_AUTH_URL;
    const auth = createAuth({
      db,
      secret: env.BETTER_AUTH_SECRET ?? env.VIBERR_SESSION_SECRET,
      // Undefined lets better-auth infer the origin from the request — correct
      // for dev where the preview port varies. Set BETTER_AUTH_URL in prod.
      baseURL,
      trustedOrigins: baseURL ? [baseURL] : [],
      github:
        env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET
          ? {
              clientId: env.GITHUB_OAUTH_CLIENT_ID,
              clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
            }
          : undefined,
      google:
        env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET
          ? {
              clientId: env.GOOGLE_OAUTH_CLIENT_ID,
              clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
            }
          : undefined,
    });
    cache[AUTH_CACHE_KEY] = { db, auth };
    return auth;
  }
  return entry.auth;
}
