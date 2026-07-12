import type Database from "better-sqlite3";
import type { ViberrAuth } from "~/lib/auth.server";
import type { UserRecord } from "~/shared/mapping/user.server";
import { recordAudit } from "../audit/audit-recorder.server";
import { AppError } from "../errors/app-error.server";
import { setCredentialPassword } from "./identity.server";
import { hashPassword, MIN_PASSWORD_LENGTH } from "./password.server";
import {
  getLoginRateLimiter,
  type TokenBucketLimiter,
} from "./rate-limit.server";
import {
  findUserByEmail,
  normalizeEmail,
  recordUserLogin,
  updateUserFields,
} from "./user-store.server";

/**
 * Credentials login + forced-password-reset completion. Sessions are minted by
 * better-auth; this layer keeps the nicer failure taxonomy, rate limiting, and
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
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Verifies credentials and mints a better-auth session. Pre-checks the legacy
 * `users` row for the specific failure reasons (unknown email, disabled, no
 * password), then delegates password verification + session creation to
 * better-auth. The better-auth credential is synced to the current hash at
 * write time by the password writers (resetPassword / completeForcedPasswordReset),
 * so no sync happens here.
 */
export async function loginWithCredentials(
  db: Database.Database,
  auth: ViberrAuth,
  attempt: LoginAttempt,
  deps: { limiter?: TokenBucketLimiter; requestHeaders?: Headers } = {},
): Promise<LoginSuccess | LoginFailure> {
  const email = normalizeEmail(attempt.email);
  const ip = attempt.ip ?? "local";
  const limiter = deps.limiter ?? getLoginRateLimiter();
  const rateKey = `${email}|${ip}`;

  if (!limiter.tryConsume(rateKey)) {
    recordAudit(db, {
      action: "auth.login.rate_limited",
      actor: { userId: null, label: email },
      details: { email },
    });
    return { ok: false, reason: "rate_limited" };
  }

  const fail = (reason: LoginFailureReason): LoginFailure => {
    // Failure audit records the email only — never the password.
    recordAudit(db, {
      action: "auth.login.failure",
      actor: { userId: null, label: email },
      details: { email, reason },
    });
    return { ok: false, reason };
  };

  const user = findUserByEmail(db, email);
  if (!user) return fail("unknown_email");
  if (user.disabled) return fail("disabled");
  if (!user.passwordHash) return fail("no_password");

  let response: Response;
  try {
    response = await auth.api.signInEmail({
      body: { email, password: attempt.password },
      headers: deps.requestHeaders,
      asResponse: true,
    });
  } catch {
    return fail("wrong_password");
  }
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
 * Forced-reset gate completion: sets the new password (legacy store + the
 * better-auth credential account) and clears the flag. The current better-auth
 * session stays valid — the user is already authenticated — so no re-issue is
 * needed. Other sessions are left to expire (the reset flow is a first-login
 * gate, not a credential-compromise recovery).
 */
export function completeForcedPasswordReset(
  db: Database.Database,
  args: {
    user: Pick<UserRecord, "id" | "email">;
    newPassword: string;
  },
): void {
  if (args.newPassword.length < MIN_PASSWORD_LENGTH) {
    throw AppError.validation(
      `New password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  const hash = hashPassword(args.newPassword);
  // `users` stays the canonical mirror; better-auth holds the credential that
  // sign-in actually verifies.
  updateUserFields(db, args.user.id, {
    passwordHash: hash,
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
