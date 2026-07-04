import type Database from "better-sqlite3";
import { z } from "zod";
import { newId } from "~/shared/ids/new-id.server";
import { USER_ROLES, type UserRecord, type UserRole } from "~/shared/mapping/user.server";
import { recordAudit, type AuditActor } from "../audit/audit-recorder.server";
import { AppError } from "../errors/app-error.server";
import { ERROR_CODES } from "../errors/error-codes";
import { hashPassword, MIN_PASSWORD_LENGTH } from "./password.server";
import { destroySessionsForUser } from "./session.server";
import {
  countActiveAdmins,
  countUsers,
  findUserByEmail,
  findUserById,
  insertUser,
  normalizeEmail,
  updateUserFields,
} from "./user-store.server";

/**
 * Org user management (server layer). Route-level RBAC (requireRole("admin"))
 * is the access control — these functions trust their caller and take the
 * acting admin as `actor` for the audit trail.
 *
 * Whitelist model: creating a user row IS the whitelist entry — a user with
 * no password (passwordless) can only sign in through GitHub/Google OAuth
 * with a verified email matching their row.
 *
 * Lockout guard: the last active admin can never be disabled or demoted.
 */

const AVATAR_TONES = ["", "rose", "teal", "violet"] as const;

function conflict(userMessage: string): AppError {
  return new AppError({
    code: ERROR_CODES.CONFLICT,
    status: 409,
    userMessage,
    kind: "user",
  });
}

const createUserSchema = z.object({
  email: z.email("Enter a valid email address."),
  name: z.string().trim().min(1, "Name is required."),
  title: z.string().trim().max(120).optional(),
  role: z.enum(USER_ROLES),
  /**
   * Temp password (user must change it at first login) — or null/absent for
   * a passwordless, OAuth-only account.
   */
  tempPassword: z
    .string()
    .min(
      MIN_PASSWORD_LENGTH,
      `Temp password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
    )
    .nullish(),
});

export type CreateUserInput = z.input<typeof createUserSchema>;

export function createUser(
  db: Database.Database,
  input: CreateUserInput,
  actor: AuditActor,
): UserRecord {
  const parsed = createUserSchema.safeParse(input);
  if (!parsed.success) {
    throw AppError.validation(
      parsed.error.issues[0]?.message ?? "Invalid user data.",
    );
  }
  const { email, name, title, role, tempPassword } = parsed.data;

  if (findUserByEmail(db, email)) {
    throw conflict(`A user with email ${normalizeEmail(email)} already exists.`);
  }

  const user = insertUser(db, {
    id: newId("u"),
    email,
    name,
    title: title || null,
    role,
    passwordHash: tempPassword ? hashPassword(tempPassword) : null,
    // A temp password must be replaced at first sign-in.
    pwresetRequired: Boolean(tempPassword),
    idp: "local",
    avatarTone: AVATAR_TONES[countUsers(db) % AVATAR_TONES.length],
    createdBy: actor.userId,
  });

  recordAudit(db, {
    action: "org.user.created",
    actor,
    subjectKind: "user",
    subjectId: user.id,
    details: {
      email: user.email,
      role: user.role,
      passwordless: !tempPassword,
    },
  });
  return user;
}

export interface UpdateUserPatch {
  name?: string;
  title?: string | null;
  role?: UserRole;
  disabled?: boolean;
}

export function updateUser(
  db: Database.Database,
  userId: string,
  patch: UpdateUserPatch,
  actor: AuditActor,
): UserRecord {
  const existing = findUserById(db, userId);
  if (!existing) throw AppError.notFound("No such user.", { userId });

  if (patch.name !== undefined && patch.name.trim().length === 0) {
    throw AppError.validation("Name is required.");
  }
  if (patch.role !== undefined && !USER_ROLES.includes(patch.role)) {
    throw AppError.validation("Unknown role.");
  }

  // Lockout guard: never lose the last active admin.
  const losesAdmin =
    existing.role === "admin" &&
    !existing.disabled &&
    ((patch.role !== undefined && patch.role !== "admin") ||
      patch.disabled === true);
  if (losesAdmin && countActiveAdmins(db) <= 1) {
    throw conflict("Cannot demote or disable the last active admin.");
  }

  const updated = updateUserFields(db, userId, {
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.role !== undefined ? { role: patch.role } : {}),
    ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
  });
  if (!updated) throw AppError.notFound("No such user.", { userId });

  if (patch.disabled === true && !existing.disabled) {
    destroySessionsForUser(db, userId);
    recordAudit(db, {
      action: "org.user.disabled",
      actor,
      subjectKind: "user",
      subjectId: userId,
      details: { email: existing.email },
    });
  } else if (patch.disabled === false && existing.disabled) {
    recordAudit(db, {
      action: "org.user.enabled",
      actor,
      subjectKind: "user",
      subjectId: userId,
      details: { email: existing.email },
    });
  }

  const changedFields = Object.keys(patch).filter((k) => k !== "disabled");
  if (changedFields.length > 0) {
    recordAudit(db, {
      action: "org.user.updated",
      actor,
      subjectKind: "user",
      subjectId: userId,
      details: {
        email: existing.email,
        fields: changedFields,
        ...(patch.role !== undefined && patch.role !== existing.role
          ? { roleFrom: existing.role, roleTo: patch.role }
          : {}),
      },
    });
  }
  return updated;
}

/**
 * Admin password reset: sets a temp password, forces a reset at next login
 * and kills all existing sessions of that user.
 */
export function resetPassword(
  db: Database.Database,
  userId: string,
  tempPassword: string,
  actor: AuditActor,
): UserRecord {
  const existing = findUserById(db, userId);
  if (!existing) throw AppError.notFound("No such user.", { userId });
  if (tempPassword.length < MIN_PASSWORD_LENGTH) {
    throw AppError.validation(
      `Temp password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }

  const updated = updateUserFields(db, userId, {
    passwordHash: hashPassword(tempPassword),
    pwresetRequired: true,
  });
  if (!updated) throw AppError.notFound("No such user.", { userId });
  destroySessionsForUser(db, userId);

  recordAudit(db, {
    action: "auth.password.reset",
    actor,
    subjectKind: "user",
    subjectId: userId,
    details: { email: existing.email },
  });
  return updated;
}

export function disableUser(
  db: Database.Database,
  userId: string,
  actor: AuditActor,
): UserRecord {
  return updateUser(db, userId, { disabled: true }, actor);
}

export function enableUser(
  db: Database.Database,
  userId: string,
  actor: AuditActor,
): UserRecord {
  return updateUser(db, userId, { disabled: false }, actor);
}
