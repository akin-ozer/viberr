import type { DatabaseSync } from "node:sqlite";
import { AUTH_BASE_PATH, type ViberrAuth } from "~/lib/auth.server";
import type { UserRecord } from "~/shared/mapping/user.server";
import { recordAudit } from "../audit/audit-recorder.server";
import { AppError } from "../errors/app-error.server";
import { setCredentialPassword } from "./identity.server";
import { hashPassword, MIN_PASSWORD_LENGTH } from "./password.server";
import {
  findUserByEmail,
  normalizeEmail,
  recordUserLogin,
  updateUserFields,
} from "./user-store.server";

/**
 * Credentials login + forced-password-reset completion. Sessions are minted by
 * Better Auth; this layer keeps the nicer failure taxonomy and audit trail,
 * and enforces the whitelist checks (disabled / OAuth-only) that
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
 * Verifies credentials and mints a Better Auth session. Pre-checks the app
 * `users` row for the specific failure reasons (unknown email, disabled, no
 * password), then delegates password verification + session creation to
 * better-auth. The better-auth credential is synced to the current hash at
 * write time by the password writers (resetPassword / completeForcedPasswordReset),
 * so no sync happens here.
 */
export async function loginWithCredentials(
  db: DatabaseSync,
  auth: ViberrAuth,
  attempt: LoginAttempt,
  deps: { requestHeaders?: Headers; requestUrl?: string } = {},
): Promise<LoginSuccess | LoginFailure> {
  const email = normalizeEmail(attempt.email);

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
  if (!user.hasPassword) return fail("no_password");

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
  if (response.status === 429) {
    recordAudit(db, {
      action: "auth.login.rate_limited",
      actor: { userId: null, label: email },
      details: { email },
    });
    return { ok: false, reason: "rate_limited" };
  }
  if (!response.ok) return fail("wrong_password");

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
