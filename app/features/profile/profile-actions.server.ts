import type Database from "better-sqlite3";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { setCredentialPassword } from "~/server/auth/identity.server";
import {
  hashPassword,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from "~/server/auth/password.server";
import {
  findUserById,
  updateUserFields,
} from "~/server/auth/user-store.server";
import { getPref, setPref } from "~/server/prefs/user-prefs.server";
import { AppError } from "~/server/errors/app-error.server";
import {
  isNotifPrefCategory,
  mergeNotifPrefs,
  type NotifPrefs,
} from "./notification-prefs";
import {
  getMotionPref,
  listUserMemberships,
  MOTION_PREF_KEY,
  NOTIFS_PREF_KEY,
  TL_DEFAULT_PREF_KEY,
  type MotionPreference,
  type TimelineDefault,
} from "./profile-query.server";

/**
 * Profile mutations (Phase 9C, profile.md §5). Route-level auth + CSRF
 * happen in routes/profile.tsx; these functions trust their caller and
 * take the acting user for audit (phase-2 pattern). All errors are typed
 * AppError (user-correctable) — the route maps them to inline copy.
 */

export interface ProfileActor {
  userId: string;
  label: string;
}

/** Name/Title blur-commit. Toast copy is the mock's, parameterized with
 * the first membership's project name (single-project mock literal). */
export function updateProfileIdentity(
  db: Database.Database,
  actor: ProfileActor,
  input: { name: string; title: string },
): { toast: string } {
  const name = input.name.trim();
  if (!name) {
    throw AppError.validation("Display name can't be empty.");
  }
  const title = input.title.trim();
  updateUserFields(db, actor.userId, { name, title: title || null });
  recordAudit(db, {
    action: "profile.updated",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "user",
    subjectId: actor.userId,
    details: { fields: ["name", "title"] },
  });
  const first = listUserMemberships(db, actor.userId)[0];
  return {
    toast: first
      ? `Profile saved — visible to ${first.name} members`
      : "Profile saved",
  };
}

/** Notification-routing toggle (app channel only — ruling 13). */
export function setNotifRoutingPref(
  db: Database.Database,
  userId: string,
  category: string,
  on: boolean,
): NotifPrefs {
  if (!isNotifPrefCategory(category)) {
    throw AppError.validation("Unknown notification category.");
  }
  const current = mergeNotifPrefs(getPref(db, userId, NOTIFS_PREF_KEY));
  const next: NotifPrefs = {
    ...current,
    [category]: { ...current[category], app: on },
  };
  setPref(db, userId, NOTIFS_PREF_KEY, next);
  return next;
}

export function setMotionPref(
  db: Database.Database,
  userId: string,
  motion: string,
): MotionPreference {
  if (motion !== "full" && motion !== "reduce") {
    throw AppError.validation("Invalid motion preference.");
  }
  setPref(db, userId, MOTION_PREF_KEY, motion);
  return getMotionPref(db, userId);
}

export function setTimelineDefaultPref(
  db: Database.Database,
  userId: string,
  value: string,
): TimelineDefault {
  if (value !== "all" && value !== "typed" && value !== "comment") {
    throw AppError.validation("Invalid timeline default.");
  }
  setPref(db, userId, TL_DEFAULT_PREF_KEY, value);
  return value;
}

/**
 * Self-serve password change (phase-2 machinery: scrypt hash/verify,
 * shared MIN_PASSWORD_LENGTH, login-flow validation copy). Keeps the
 * current session, signs out every other one.
 */
export function changeOwnPassword(
  db: Database.Database,
  actor: ProfileActor & { sessionId: string },
  input: { current: string; next: string; confirm: string },
): { toast: string } {
  const user = findUserById(db, actor.userId);
  if (!user) throw AppError.notFound("Account not found.");
  if (!user.passwordHash) {
    throw AppError.validation(
      "This account has no local password — it signs in through an identity provider.",
    );
  }
  if (!verifyPassword(input.current, user.passwordHash)) {
    throw AppError.validation("Current password is incorrect.");
  }
  if (input.next.length < MIN_PASSWORD_LENGTH) {
    throw AppError.validation(
      `New password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  if (input.next !== input.confirm) {
    throw AppError.validation("Passwords don't match.");
  }
  const hash = hashPassword(input.next);
  updateUserFields(db, actor.userId, { passwordHash: hash });
  // better-auth holds the credential that sign-in verifies.
  setCredentialPassword(db, actor.userId, hash);
  // Sign out every OTHER session; the one making this change survives.
  db.prepare(`DELETE FROM session WHERE userId = ? AND id != ?`).run(
    actor.userId,
    actor.sessionId,
  );
  recordAudit(db, {
    action: "auth.password.changed",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "user",
    subjectId: actor.userId,
  });
  return { toast: "Password updated — other sessions were signed out" };
}

/**
 * GitHub identity disconnect (attribution only). Connected state is
 * derived from users.idp (ruling 13); disconnecting flips sign-in back to
 * the local account — refused when no password exists (the account would
 * lock itself out). Audit-relevant per profile.md §5.
 */
export function disconnectGithubIdentity(
  db: Database.Database,
  actor: ProfileActor,
): { toast: string } {
  const user = findUserById(db, actor.userId);
  if (!user) throw AppError.notFound("Account not found.");
  if (user.idp !== "github") {
    throw AppError.validation("GitHub isn't connected on this account.");
  }
  if (!user.passwordHash) {
    throw AppError.validation(
      "Set a password first — this account signs in only through GitHub.",
    );
  }
  updateUserFields(db, actor.userId, { idp: "local" });
  recordAudit(db, {
    action: "identity.github.disconnected",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "user",
    subjectId: actor.userId,
  });
  return {
    toast: "GitHub disconnected — audit falls back to your workspace identity",
  };
}
