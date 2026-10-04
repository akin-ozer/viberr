import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { MIN_PASSWORD_LENGTH } from "~/shared/auth/password-policy";
import { AUTH_BASE_PATH } from "~/shared/auth/auth-paths";
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
  recordSignIn,
  type OAuthProvider,
} from "~/server/auth/oauth-provision.server";
import { getEnv } from "~/server/config/env.server";
import { getDb } from "~/server/db/sqlite.server";
import {
  oauthConfigFingerprint,
  resolveOAuthProviders,
} from "~/server/auth/oauth-providers.server";

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

// The mount point lives in a SHARED module so client code (the Sign-in & SSO
// card) can render the callback URL without importing this server-only file.
// Re-exported here because every existing server importer reads it from this
// module.
export { AUTH_BASE_PATH };

/**
 * The ONLY Better Auth endpoints the app drives (P11-02) — everything else on
 * the `/api/auth/*` splat is rejected with a 404. An allow-list, not a
 * deny-list: Better Auth registers many more endpoints than the app uses
 * (change-password, update-user, link-social, list-accounts, token …), and any
 * of the account-mutating ones would bypass the app's own audited,
 * session-revoking flows or split-brain the canonical `users` row. Enumerating
 * the blocked set can silently rot as Better Auth adds endpoints; enumerating
 * the driven set cannot.
 *
 * Entries are the endpoints' DECLARED paths (hooks receive `endpoint.path`
 * verbatim, params un-substituted — hence the literal "/callback/:id").
 * The hook pipeline also runs for server-side `auth.api.*` calls, so this list
 * must cover those too: getSession (require-user) and signOut (logout).
 * "/error" stays reachable because a failed OAuth callback redirects there.
 */
const ALLOWED_AUTH_PATHS = new Set<string>([
  "/sign-in/email", // app login form
  "/sign-in/social", // OAuth start (login page buttons)
  "/callback/:id", // OAuth provider redirect back
  "/error", // Better Auth's OAuth-failure landing page
  "/get-session", // session resolution (require-user, on every request)
  "/sign-out", // logout route
]);

/** The concrete better-auth instance type. */
export type ViberrAuth = ReturnType<typeof betterAuth>;

/**
 * The slice of a Better Auth endpoint context the provider resolution reads.
 * Narrow on purpose: the database hooks hand over a full
 * `GenericEndpointContext`, but the provider id is readable from the declared
 * path and its route params alone.
 */
export interface AuthEndpointContext {
  path?: string;
  params?: Record<string, string | undefined>;
}

/**
 * P13-D-22: which provider's callback is running, read off the endpoint the
 * database hook fires under. The social callback endpoint is declared
 * `/callback/:id` (and `/oauth2/callback/:id`), so `params.id` IS the provider
 * id — the same resolution better-auth's own `lastLoginMethod` plugin uses.
 *
 * This has to be threaded explicitly: `databaseHooks.user.create` receives only
 * the user record, and the whitelist previously had to GUESS the provider from
 * whether a `githubHandle` came along. That guess is what let the Google-only
 * domain allowlist admit GitHub sign-ins.
 *
 * Returns null when the provider cannot be read; `isOAuthWhitelisted` fails
 * closed on null (no domain admission), which is the safe direction.
 */
function oauthProviderOf(
  context: AuthEndpointContext | null | undefined,
): OAuthProvider | null {
  const path = context?.path ?? "";
  if (!path.startsWith("/callback/") && !path.startsWith("/oauth2/callback/")) {
    return null;
  }
  const id = context?.params?.id ?? path.split("/").pop();
  return id === "github" || id === "google" ? id : null;
}

/**
 * The one field each throttled endpoint's POST body contributes to its bucket
 * key. Decoded rather than read off the raw body: `/api/auth/*` is a splat, so
 * the body is whatever the caller posted, and a missing or non-string field has
 * to collapse to the same empty key it always did (never a stringified object,
 * which would hand a caller a private bucket per payload).
 */
const signInEmailBody = z.object({ email: z.string() });
const signInSocialBody = z.object({ provider: z.string() });

/**
 * `githubHandle` off the record the user-create hooks receive. It is declared
 * in `user.additionalFields` below and written only by the GitHub provider's
 * `mapProfileToUser`, but Better Auth's `User` type does not model additional
 * fields — the hook payload carries it as an undecoded slot. Absent (every
 * non-GitHub sign-in) stays undefined and an explicit null stays null, which is
 * what `isOAuthWhitelisted`/`applyOAuthUser` read as "no handle".
 */
const oauthUserFields = z
  .object({ githubHandle: z.string().nullish() })
  .catch({ githubHandle: undefined });

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
 * Pure options builder — factored out of `createAuth` (its sole caller) so the
 * exact Better Auth options the app runs against are assembled in one place
 * that unit tests can construct without spinning up the live handler.
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
        githubHandle: profile.login ?? null,
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
        // EVERY built-in Better Auth endpoint would be reachable — including
        // account mutations Viberr does NOT use because it owns those flows
        // itself with auditing + session revocation (profile change-password,
        // admin user-edit/reset). Left open, `/change-password` would bypass the
        // app's audit + other-session kill, and `/update-user` would write
        // Better Auth's `user.name` only, diverging from the canonical `users`
        // row (split-brain). Only the endpoints the app actually drives pass;
        // everything else 404s (see ALLOWED_AUTH_PATHS).
        if (!ALLOWED_AUTH_PATHS.has(ctx.path)) {
          throw new APIError("NOT_FOUND", { message: "Not found." });
        }
        if (ctx.path === "/sign-in/email") {
          const body = signInEmailBody.safeParse(ctx.body);
          const email = body.success ? body.data.email.trim().toLowerCase() : "";
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
          const body = signInSocialBody.safeParse(ctx.body);
          const provider = body.success ? body.data.provider : "";
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
        // F28-A1: github/google are DELIBERATELY not "trusted" here. A trusted
        // provider is linked to an existing account by email WITHOUT checking
        // the provider's own `emailVerified` claim — and because every viberr
        // account is provisioned `emailVerified: 1` (needed so a whitelisted
        // user's OAuth login can auto-link to their admin-created row), the
        // requireLocalEmailVerified backstop (better-auth's CVE-2026-53516 fix)
        // is moot too. Trusting github/google would leave NO gate: anyone who
        // gets the provider to report a victim's UNVERIFIED email would be
        // silently linked to and signed in as that victim. Leaving them
        // untrusted keeps the intended auto-link for a provider-VERIFIED email
        // (the normal case — a real user's primary GitHub/Google email is
        // verified) while refusing an unverified one. `credential` never reaches
        // the social-linking path, so it is a harmless no-op here.
        trustedProviders: ["credential"],
        // Copy the provider profile's ADDITIONAL fields onto an existing user
        // when a social account is linked to it. `githubHandle` is declared in
        // `user.additionalFields` above and produced by the GitHub provider's
        // `mapProfileToUser`, but that only ever reached a user better-auth
        // CREATED. Someone who already had a local Viberr account and then
        // signed in with GitHub therefore never got a handle recorded — and
        // `pr-human-approval.server.ts` matches a PR reviewer to a Viberr user
        // by `lower(github_handle)`, so ruling R19-B's human approval silently
        // never counted for them. better-auth never rewrites `email` /
        // `emailVerified` here, so a link still cannot rebind an identity.
        updateUserInfoOnLink: true,
      },
    },
    // Whitelist + provisioning: better-auth owns the OAuth dance; these hooks
    // gate NEW social users against Viberr's whitelist and keep the legacy
    // `users` row in step. `deps.db` is the request-time app database.
    databaseHooks: {
      user: {
        create: {
          // P13-D-22: `context` carries the callback endpoint, hence the
          // provider — without it the whitelist cannot tell a Google sign-in
          // from a GitHub one, and the Google-only domain rule admits both.
          before: (user, context) =>
            Promise.resolve(
              isOAuthWhitelisted(deps.db, {
                id: String(user.id),
                email: user.email,
                name: user.name,
                githubHandle: oauthUserFields.parse(user).githubHandle,
                provider: oauthProviderOf(context),
              })
                ? undefined
                : false,
            ),
          after: (user, context) => {
            applyOAuthUser(deps.db, {
              id: String(user.id),
              email: user.email,
              name: user.name,
              githubHandle: oauthUserFields.parse(user).githubHandle,
              provider: oauthProviderOf(context),
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
      session: {
        create: {
          after: (session) => {
            recordSignIn(deps.db, String(session.userId));
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
  /** R19-16: identity of the provider config this instance was built from. */
  providerFingerprint: string;
  auth: ReturnType<typeof betterAuth>;
}

/**
 * The app's better-auth instance (from getEnv + getDb + the stored provider
 * configuration).
 *
 * R19-16: the cache is keyed on the provider FINGERPRINT as well as the db
 * handle. better-auth reads `socialProviders` once at construction, so without
 * this an admin who configured GitHub sign-in in the UI would keep meeting the
 * old instance — "no redeploy" would have meant "no restart, but also no
 * effect" until the process bounced. The fingerprint moves on any save, test,
 * enable or removal, so the next request rebuilds.
 */
export function getAuth(): ReturnType<typeof betterAuth> {
  // SAFETY: `globalThis` carries no index signature, so the symbol slot has to
  // be named to be read at all. `Symbol.for("viberr.betterAuth")` is written
  // nowhere but the assignment below, which only ever stores an AuthCacheEntry
  // — the slot therefore holds one of ours or nothing.
  const cache = globalThis as Record<symbol, AuthCacheEntry | undefined>;
  const db = getDb();
  const providerFingerprint = oauthConfigFingerprint(db);
  const entry = cache[AUTH_CACHE_KEY];
  if (
    !entry ||
    entry.db !== db ||
    entry.providerFingerprint !== providerFingerprint
  ) {
    const env = getEnv();
    const baseURL = env.BETTER_AUTH_URL;
    // App configuration OVERRIDES the deployment env (owner ruling) — including
    // an app row that deliberately holds a provider off.
    const resolved = resolveOAuthProviders(db);
    const deps: AuthDeps = {
      db,
      secret: env.BETTER_AUTH_SECRET ?? env.VIBERR_SESSION_SECRET,
      // Undefined lets better-auth infer the origin from the request — correct
      // for dev where the preview port varies. Set BETTER_AUTH_URL in prod.
      baseURL,
      trustedOrigins: baseURL ? [baseURL] : [],
    };
    // A provider the app holds off stays ABSENT from the deps rather than
    // present as `undefined` — `AuthDeps.github`/`.google` are optional, and
    // "not configured" is the absence of the key.
    if (resolved.github) deps.github = resolved.github;
    if (resolved.google) deps.google = resolved.google;
    const auth = createAuth(deps);
    cache[AUTH_CACHE_KEY] = { db, providerFingerprint, auth };
    return auth;
  }
  return entry.auth;
}
