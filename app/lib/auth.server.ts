import { betterAuth, type BetterAuthOptions } from "better-auth";
import { organization } from "better-auth/plugins";
import type Database from "better-sqlite3";
import { MIN_PASSWORD_LENGTH } from "~/shared/auth/password-policy";
import { hashPassword, verifyPassword } from "~/server/auth/password.server";
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
 * Scope decision (see design/better-auth-migration.md): better-auth owns
 * CREDENTIALS + SESSIONS + OAUTH + ORG MEMBERSHIP; the legacy `users` table
 * stays the app's canonical profile/role/disabled store. The two are bridged
 * by the invariant  better-auth `user.id` === legacy `users.id`, so every
 * profile/RBAC reader (findUserById, org-users, project_members, user_prefs,
 * audit) is untouched. `authenticate()` resolves a better-auth session, then
 * loads the legacy `users` row for the SessionUser it returns.
 *
 * - Cookie: `viberr.session_token` (cookiePrefix "viberr"), signed with the
 *   existing VIBERR_SESSION_SECRET — no new required env.
 * - Sessions: 30-day rolling (expiresIn) with a daily slide (updateAge), to
 *   match the retired hand-rolled session TTL.
 * - Passwords: our scrypt `hashPassword`/`verifyPassword` are plugged in as
 *   the hash/verify hooks, so better-auth reads the EXISTING 6-part
 *   `scrypt$N$r$p$salt$hash` strings verbatim — no forced reset.
 * - Sign-up is disabled: identities are provisioned through the whitelist
 *   (seed admin, org-users invite, OAuth provisioning hooks), never open reg.
 */

export const AUTH_BASE_PATH = "/api/auth";

/** The concrete better-auth instance type (with our plugins). */
export type ViberrAuth = ReturnType<typeof betterAuth>;

export interface AuthDeps {
  /** The app database handle (shared better-sqlite3 file). */
  db: Database.Database;
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

/** Better Auth should trust the configured canonical origin exactly. OAuth
 * state cookies are host-only, so merely trusting both loopback aliases would
 * let a 127.0.0.1 start generate a localhost callback that cannot receive its
 * state cookie. The root loader canonicalizes local page loads instead. */
export function trustedAuthOrigins(baseURL: string | undefined): string[] {
  if (!baseURL) return [];
  return [new URL(baseURL).origin];
}

/** Return the canonical local URL when the same Compose app was opened through
 * the other IPv4 loopback spelling. This redirect must happen before an OAuth
 * request sets its host-only state cookie. Non-local deployments are untouched. */
export function canonicalLoopbackRedirectUrl(
  requestUrl: string,
  baseURL: string | undefined,
): string | null {
  if (!baseURL) return null;
  const requested = new URL(requestUrl);
  const canonical = new URL(baseURL);
  const loopback = new Set(["localhost", "127.0.0.1"]);
  if (
    !loopback.has(requested.hostname) ||
    !loopback.has(canonical.hostname) ||
    requested.origin === canonical.origin
  ) {
    return null;
  }
  return new URL(`${requested.pathname}${requested.search}`, canonical.origin)
    .href;
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
      // Plug Viberr's scrypt in so existing 6-part hashes verify unchanged.
      password: {
        hash: (password) => Promise.resolve(hashPassword(password)),
        verify: ({ hash, password }) =>
          Promise.resolve(verifyPassword(password, hash)),
      },
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
    // Org/tenant membership + invitations (Option B). The org role continues
    // to be enforced through Viberr's hierarchical check; the plugin supplies
    // the membership tables and invitation flow.
    plugins: [organization({ allowUserToCreateOrganization: false })],
    advanced: {
      cookiePrefix: "viberr",
    },
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
  db: Database.Database;
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
      trustedOrigins: trustedAuthOrigins(baseURL),
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
