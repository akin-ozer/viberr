import type { DatabaseSync } from "node:sqlite";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { getEnv } from "~/server/config/env.server";
import { openSecretRotating, sealSecret } from "~/server/secrets/secret-box.server";
import type { OAuthProvider } from "./oauth-credential-test.server";

/**
 * R19-16 (owner ruling) — SIGN-IN PROVIDERS ARE CONFIGURED IN THE APP.
 *
 * GitHub/Google sign-in used to exist only if the deployment happened to carry
 * `GITHUB_OAUTH_*` / `GOOGLE_OAUTH_*` when the process started, so an admin
 * looking at "GitHub · off" had no way to turn it on and no way to learn what
 * was missing. An admin now pastes the client id + secret, PROVES them against
 * the provider, and enables the button — no redeploy, no restart.
 *
 * Two owner rulings shape this module:
 *
 *  1. **The app row OVERRIDES the deployment env.** The env stays a bootstrap
 *     default for automated deployments, but once a provider is configured
 *     here, this is the truth — including when it is configured and DISABLED,
 *     which switches the provider off even on a deployment whose env sets it.
 *     Anything else would make the switch in the UI a lie.
 *  2. **`enabled` requires a passing test.** `verified_at` is only written by a
 *     live provider round-trip (`testOAuthCredentials`), and it is CLEARED the
 *     moment either credential changes, so a provider can never be left on with
 *     a credential nothing ever proved.
 */

export interface OAuthProviderRow {
  provider: OAuthProvider;
  clientId: string;
  enabled: boolean;
  verifiedAt: string | null;
  verifiedDetail: string | null;
  updatedAt: string;
}

/** Resolved credentials better-auth should actually run with. */
export interface ResolvedOAuthCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * The row as db/migrations/0001_baseline.sql declares it: `provider` under a
 * CHECK that admits only 'github' and 'google', client_id/client_secret/
 * enabled/created_at/updated_at NOT NULL, verified_at/verified_detail nullable.
 */
type DbRow = {
  provider: OAuthProvider;
  client_id: string;
  client_secret: string;
  enabled: number;
  verified_at: string | null;
  verified_detail: string | null;
  updated_at: string;
};

const PROVIDERS: readonly OAuthProvider[] = ["github", "google"];

function readRow(db: DatabaseSync, provider: OAuthProvider): DbRow | null {
  // SAFETY: the migration cited on DbRow pins every column it names, and this
  // is a `SELECT *` of that table.
  const row = db
    .prepare(`SELECT * FROM oauth_providers WHERE provider = ?`)
    .get(provider) as DbRow | undefined;
  return row ?? null;
}

function toView(row: DbRow): OAuthProviderRow {
  return {
    provider: row.provider,
    clientId: row.client_id,
    enabled: row.enabled === 1,
    verifiedAt: row.verified_at,
    verifiedDetail: row.verified_detail,
    updatedAt: row.updated_at,
  };
}

export function getOAuthProviderRow(
  db: DatabaseSync,
  provider: OAuthProvider,
): OAuthProviderRow | null {
  const row = readRow(db, provider);
  return row ? toView(row) : null;
}

/**
 * The credential pair to TEST — the stored secret when the caller did not
 * retype it, so "Test" works on a saved provider without asking an admin to
 * paste a secret they cannot read back.
 */
export function readOAuthSecret(
  db: DatabaseSync,
  provider: OAuthProvider,
): string | null {
  const row = readRow(db, provider);
  if (!row) return null;
  try {
    return openSecretRotating(row.client_secret).plaintext;
  } catch {
    return null;
  }
}

/**
 * Store a credential pair. Saving NEVER enables and always clears a previous
 * verdict when a value actually changed: a proof belongs to the exact pair it
 * was made against.
 */
export function saveOAuthProvider(
  db: DatabaseSync,
  input: {
    provider: OAuthProvider;
    clientId: string;
    /** Omitted/empty = keep the stored secret (write-only field, never read back). */
    clientSecret?: string | null;
  },
  actor: AuditActor,
): OAuthProviderRow {
  const now = new Date().toISOString();
  const clientId = input.clientId.trim();
  const secret = input.clientSecret?.trim() || null;
  const existing = readRow(db, input.provider);

  if (!existing && !secret) {
    throw new Error("A client secret is required the first time.");
  }

  const secretChanged =
    secret !== null &&
    (!existing || openSafely(existing.client_secret) !== secret);
  const idChanged = !existing || existing.client_id !== clientId;
  // A verdict survives only a no-op save (e.g. re-saving the same values).
  const keepVerdict = Boolean(existing) && !secretChanged && !idChanged;

  db.prepare(
    `INSERT INTO oauth_providers
       (provider, client_id, client_secret, enabled, verified_at, verified_detail, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider) DO UPDATE SET
       client_id = excluded.client_id,
       client_secret = excluded.client_secret,
       enabled = excluded.enabled,
       verified_at = excluded.verified_at,
       verified_detail = excluded.verified_detail,
       updated_at = excluded.updated_at`,
  ).run(
    input.provider,
    clientId,
    secret ? sealSecret(secret) : existing!.client_secret,
    // Changing a credential takes the provider OFF: what was proved is gone.
    keepVerdict && existing!.enabled === 1 ? 1 : 0,
    keepVerdict ? existing!.verified_at : null,
    keepVerdict ? existing!.verified_detail : null,
    existing ? existing.updated_at : now,
    now,
  );

  recordAudit(db, {
    action: existing ? "org.oauth_provider.updated" : "org.oauth_provider.created",
    actor,
    subjectKind: "org_oauth_provider",
    subjectId: input.provider,
    details: {
      provider: input.provider,
      clientId,
      secretReplaced: secretChanged,
      verdictCleared: !keepVerdict,
    },
  });
  return getOAuthProviderRow(db, input.provider)!;

  function openSafely(box: string): string | null {
    try {
      return openSecretRotating(box).plaintext;
    } catch {
      return null;
    }
  }
}

/** Record a live provider verdict. Only a PASS writes `verified_at`. */
export function recordOAuthVerification(
  db: DatabaseSync,
  provider: OAuthProvider,
  result: { ok: boolean; detail: string },
  actor: AuditActor,
): OAuthProviderRow | null {
  const existing = readRow(db, provider);
  if (!existing) return null;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE oauth_providers
        SET verified_at = ?, verified_detail = ?, enabled = ?, updated_at = ?
      WHERE provider = ?`,
  ).run(
    result.ok ? now : null,
    result.detail,
    // A failed test cannot leave a live provider on.
    result.ok ? existing.enabled : 0,
    now,
    provider,
  );
  recordAudit(db, {
    action: "org.oauth_provider.tested",
    actor,
    subjectKind: "org_oauth_provider",
    subjectId: provider,
    details: { provider, passed: result.ok, detail: result.detail },
  });
  return getOAuthProviderRow(db, provider);
}

/**
 * Turn a provider on or off. Enabling REFUSES without a standing verdict — the
 * whole point of the test gate (owner ruling): the login page must never offer
 * a button the deployment cannot honour.
 */
export function setOAuthProviderEnabled(
  db: DatabaseSync,
  provider: OAuthProvider,
  enabled: boolean,
  actor: AuditActor,
): { ok: true; row: OAuthProviderRow } | { ok: false; reason: string } {
  const existing = readRow(db, provider);
  if (!existing) {
    return { ok: false, reason: "That provider is not configured yet." };
  }
  if (enabled && !existing.verified_at) {
    return {
      ok: false,
      reason:
        "Test the credentials first: a sign-in method is only offered once the provider has accepted its client ID and secret.",
    };
  }
  db.prepare(
    `UPDATE oauth_providers SET enabled = ?, updated_at = ? WHERE provider = ?`,
  ).run(enabled ? 1 : 0, new Date().toISOString(), provider);
  recordAudit(db, {
    action: enabled
      ? "org.oauth_provider.enabled"
      : "org.oauth_provider.disabled",
    actor,
    subjectKind: "org_oauth_provider",
    subjectId: provider,
    details: { provider },
  });
  return { ok: true, row: getOAuthProviderRow(db, provider)! };
}

/** Forget the app-level configuration; the deployment env (if any) applies again. */
export function deleteOAuthProvider(
  db: DatabaseSync,
  provider: OAuthProvider,
  actor: AuditActor,
): void {
  db.prepare(`DELETE FROM oauth_providers WHERE provider = ?`).run(provider);
  recordAudit(db, {
    action: "org.oauth_provider.removed",
    actor,
    subjectKind: "org_oauth_provider",
    subjectId: provider,
    details: { provider },
  });
}

function envCredentials(
  provider: OAuthProvider,
): ResolvedOAuthCredentials | null {
  const env = getEnv();
  const clientId =
    provider === "github"
      ? env.GITHUB_OAUTH_CLIENT_ID
      : env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret =
    provider === "github"
      ? env.GITHUB_OAUTH_CLIENT_SECRET
      : env.GOOGLE_OAUTH_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export type OAuthSource = "app" | "env" | "none";

export interface ResolvedProvider {
  credentials: ResolvedOAuthCredentials | null;
  /** Where the LIVE answer came from — what the UI labels the card with. */
  source: OAuthSource;
  /** True when an app row exists and deliberately holds the provider off. */
  disabledInApp: boolean;
}

/**
 * The provider as the running app sees it (ruling 1: the app row wins).
 *
 * An app row that is present but disabled resolves to NO credentials even when
 * the env carries a pair — a switch that says off must mean off.
 */
export function resolveOAuthProvider(
  db: DatabaseSync,
  provider: OAuthProvider,
): ResolvedProvider {
  const row = readRow(db, provider);
  if (row) {
    if (row.enabled !== 1) {
      return { credentials: null, source: "app", disabledInApp: true };
    }
    const secret = readOAuthSecret(db, provider);
    if (secret) {
      return {
        credentials: { clientId: row.client_id, clientSecret: secret },
        source: "app",
        disabledInApp: false,
      };
    }
    // Sealed under a key this deployment no longer has: fail CLOSED rather
    // than silently falling back to a different (env) identity.
    return { credentials: null, source: "app", disabledInApp: false };
  }
  const env = envCredentials(provider);
  return {
    credentials: env,
    source: env ? "env" : "none",
    disabledInApp: false,
  };
}

export interface ResolvedOAuthProviders {
  github: ResolvedOAuthCredentials | null;
  google: ResolvedOAuthCredentials | null;
}

/** Both providers, resolved — what `getAuth` hands to better-auth. */
export function resolveOAuthProviders(
  db: DatabaseSync,
): ResolvedOAuthProviders {
  return {
    github: resolveOAuthProvider(db, "github").credentials,
    google: resolveOAuthProvider(db, "google").credentials,
  };
}

/**
 * Identity of the CURRENT provider configuration, for the auth-instance cache.
 *
 * better-auth is built once per process, so a credential saved in the UI would
 * otherwise not reach the running handler until a restart — the exact "no
 * redeploy" promise this feature makes. Keying the cached instance on this
 * string rebuilds it on the next request after any change.
 *
 * Deliberately built from NON-SECRET fields only (client id, enabled, the row's
 * updated_at, and whether an env pair exists): a secret rotation still changes
 * `updated_at`, so the fingerprint moves without the secret ever entering it.
 */
export function oauthConfigFingerprint(db: DatabaseSync): string {
  return PROVIDERS.map((provider) => {
    const row = readRow(db, provider);
    if (row) {
      return `${provider}:app:${row.client_id}:${row.enabled}:${row.updated_at}`;
    }
    return `${provider}:env:${envCredentials(provider) ? "set" : "unset"}`;
  }).join("|");
}
