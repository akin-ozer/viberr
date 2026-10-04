import type { DatabaseSync } from "node:sqlite";
import type { ViberrAuth } from "~/lib/auth.server";
import { AUTH_BASE_PATH } from "~/shared/auth/auth-paths";
import type { UserRecord } from "~/shared/mapping/user.server";
import { recordAudit } from "../audit/audit-recorder.server";
import { AppError } from "../errors/app-error.server";
import { setCredentialPassword } from "./identity.server";
import { hashPassword, MIN_PASSWORD_LENGTH } from "./password.server";
import { clientIpOf, getLoginRateLimiter } from "./rate-limit.server";
import {
  findUserByEmail,
  normalizeEmail,
  recordUserLogin,
  updateUserFields,
} from "./user-store.server";

/**
 * Credentials login + forced-password-reset completion. Sessions are minted by
 * Better Auth; this layer keeps the nicer failure taxonomy, rate limiting, and
 * audit trail, and enforces the whitelist checks (disabled / OAuth-only) that
 * better-auth's generic sign-in does not distinguish. Route modules map the
 * reasons to the login screen's copy.
 */

export type LoginFailureReason =
  | "unknown_email" // no user row for that email
  | "no_password" // account exists but is OAuth-only
  | "wrong_password"
  | "disabled"
  | "rate_limited";

export interface LoginSuccess {
  ok: true;
  user: UserRecord;
  /** Set-Cookie header values from better-auth's sign-in response. */
  setCookies: string[];
  /** pwreset_required was set — gate everything until a new password is set. */
  mustResetPassword: boolean;
}

export interface LoginFailure {
  ok: false;
  reason: LoginFailureReason;
}

export interface LoginAttempt {
  email: string;
  password: string;
}

/**
 * Verifies credentials and mints a Better Auth session. Throttles per
 * email+ip first, then pre-checks the app `users` row for the specific failure
 * reasons (unknown email, disabled, no password), then delegates password
 * verification + session creation to better-auth. The better-auth credential
 * is synced to the current hash at write time by the password writers
 * (resetPassword / completeForcedPasswordReset), so no sync happens here.
 *
 * The per-`email|ip` throttle itself lives on better-auth's sign-in hook (see
 * lib/auth.server.ts) so that a POST straight to /api/auth/sign-in/email is
 * throttled too; this function only spends a token for the pre-check failures
 * that never reach that handler, and forgives the bucket on success.
 */
export async function loginWithCredentials(
  db: DatabaseSync,
  auth: ViberrAuth,
  attempt: LoginAttempt,
  deps: {
    requestHeaders?: Headers;
    requestUrl?: string;
  } = {},
): Promise<LoginSuccess | LoginFailure> {
  const email = normalizeEmail(attempt.email);
  const limiter = getLoginRateLimiter();
  const rateKey = `${email}|${clientIpOf(deps.requestHeaders)}`;

  const rateLimited = (): LoginFailure => {
    recordAudit(db, {
      action: "auth.login.rate_limited",
      actor: { userId: null, label: email },
      details: { email },
    });
    return { ok: false, reason: "rate_limited" };
  };

  const fail = (reason: LoginFailureReason): LoginFailure => {
    // Failure audit records the email only — never the password.
    recordAudit(db, {
      action: "auth.login.failure",
      actor: { userId: null, label: email },
      details: { email, reason },
    });
    return { ok: false, reason };
  };

  // These three fail BEFORE better-auth's handler runs, so the sign-in hook
  // that normally spends the token never fires for them. Spend it here, or an
  // attacker could enumerate addresses without ever touching the bucket.
  const user = findUserByEmail(db, email);
  if (!user || user.disabled || !user.hasPassword) {
    if (!limiter.tryConsume(rateKey)) return rateLimited();
    if (!user) return fail("unknown_email");
    if (user.disabled) return fail("disabled");
    return fail("no_password");
  }

  let response: Response;
  try {
    const headers = new Headers(deps.requestHeaders);
    headers.set("Content-Type", "application/json");
    const url = new URL(
      `${AUTH_BASE_PATH}/sign-in/email`,
      deps.requestUrl ?? "http://localhost",
    );
    response = await auth.handler(
      new Request(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ email, password: attempt.password }),
      }),
    );
  } catch {
    return fail("wrong_password");
  }
  // The sign-in hook in lib/auth.server.ts spends this attempt's token and
  // answers 429 when the email+ip bucket is empty.
  if (response.status === 429) return rateLimited();
  if (!response.ok) return fail("wrong_password");

  // Success: forgive earlier typos so users don't stay near the limit.
  limiter.reset(rateKey);
  recordUserLogin(db, user.id);
  recordAudit(db, {
    action: "auth.login.success",
    actor: { userId: user.id, label: user.email },
    subjectKind: "user",
    subjectId: user.id,
    details: { idp: "local", pwresetPending: user.pwresetRequired },
  });
  return {
    ok: true,
    user,
    setCookies: response.headers.getSetCookie(),
    mustResetPassword: user.pwresetRequired,
  };
}

/**
 * Forced-reset gate completion: sets the Better Auth credential and clears
 * the application flag. The current Better Auth
 * session stays valid — the user is already authenticated — so no re-issue is
 * needed. Other sessions are left to expire (the reset flow is a first-login
 * gate, not a credential-compromise recovery).
 */
export async function completeForcedPasswordReset(
  db: DatabaseSync,
  args: {
    user: Pick<UserRecord, "id" | "email">;
    newPassword: string;
  },
): Promise<void> {
  if (args.newPassword.length < MIN_PASSWORD_LENGTH) {
    throw AppError.validation(
      `New password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  const hash = await hashPassword(args.newPassword);
  updateUserFields(db, args.user.id, {
    pwresetRequired: false,
  });
  setCredentialPassword(db, args.user.id, hash);
  recordAudit(db, {
    action: "auth.password.forced_reset_completed",
    actor: { userId: args.user.id, label: args.user.email },
    subjectKind: "user",
    subjectId: args.user.id,
  });
}
