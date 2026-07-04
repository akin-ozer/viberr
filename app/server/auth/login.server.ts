import type Database from "better-sqlite3";
import type { UserRecord } from "~/shared/mapping/user.server";
import { recordAudit } from "../audit/audit-recorder.server";
import { AppError } from "../errors/app-error.server";
import {
  hashPassword,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from "./password.server";
import {
  getLoginRateLimiter,
  type TokenBucketLimiter,
} from "./rate-limit.server";
import {
  createSession,
  destroySessionsForUser,
  type CreatedSession,
  type SessionMeta,
} from "./session.server";
import {
  findUserByEmail,
  normalizeEmail,
  recordUserLogin,
  updateUserFields,
} from "./user-store.server";

/**
 * Credentials login + forced-password-reset completion. Route modules map
 * failure reasons to the mock's copy; this layer owns the decisions and the
 * audit trail.
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
  session: CreatedSession;
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

export function loginWithCredentials(
  db: Database.Database,
  attempt: LoginAttempt,
  deps: { limiter?: TokenBucketLimiter } = {},
): LoginSuccess | LoginFailure {
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
  if (!verifyPassword(attempt.password, user.passwordHash)) {
    return fail("wrong_password");
  }

  // Success: forgive earlier typos so users don't stay near the limit.
  limiter.reset(rateKey);
  recordUserLogin(db, user.id);
  const meta: SessionMeta = { ip: attempt.ip, userAgent: attempt.userAgent };
  // A brand-new session id on every login = session fixation protection.
  const session = createSession(db, user.id, meta);
  recordAudit(db, {
    action: "auth.login.success",
    actor: { userId: user.id, label: user.email },
    subjectKind: "user",
    subjectId: user.id,
    details: { idp: "local", pwresetPending: user.pwresetRequired },
  });
  return { ok: true, user, session, mustResetPassword: user.pwresetRequired };
}

/**
 * Forced-reset gate completion: sets the new password, clears the flag,
 * revokes every other session and rotates the current one (fresh token).
 */
export function completeForcedPasswordReset(
  db: Database.Database,
  args: {
    user: Pick<UserRecord, "id" | "email">;
    newPassword: string;
    /** Session meta carried into the replacement session. */
    ip?: string | null;
    userAgent?: string | null;
  },
): { session: CreatedSession } {
  if (args.newPassword.length < MIN_PASSWORD_LENGTH) {
    throw AppError.validation(
      `New password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  updateUserFields(db, args.user.id, {
    passwordHash: hashPassword(args.newPassword),
    pwresetRequired: false,
  });
  // Rotate: drop every session (including the current one) and mint a new one.
  destroySessionsForUser(db, args.user.id);
  const session = createSession(db, args.user.id, {
    ip: args.ip,
    userAgent: args.userAgent,
  });
  recordAudit(db, {
    action: "auth.password.forced_reset_completed",
    actor: { userId: args.user.id, label: args.user.email },
    subjectKind: "user",
    subjectId: args.user.id,
  });
  return { session };
}
