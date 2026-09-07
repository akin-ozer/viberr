import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { normalizeHandle } from "~/shared/github-handle";
import { newId } from "~/shared/ids/new-id.server";
import { USER_ROLES, type UserRecord, type UserRole } from "~/shared/mapping/user.server";
import { recordAudit, type AuditActor } from "../audit/audit-recorder.server";
import { AppError } from "../errors/app-error.server";
import {
  provisionIdentity,
  revokeUserSessions,
  setCredentialPassword,
} from "./identity.server";
import { hashPassword, MIN_PASSWORD_LENGTH } from "./password.server";
import {
  countActiveAdmins,
  countUsers,
  findUserByEmail,
  findUserById,
  insertUser,
  normalizeEmail,
  otherEnabledGithubHandleHolders,
  updateUserFields,
  type UserFieldPatch,
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

export async function createUser(
  db: DatabaseSync,
  input: CreateUserInput,
  actor: AuditActor,
): Promise<UserRecord> {
  const parsed = createUserSchema.safeParse(input);
  if (!parsed.success) {
    throw AppError.validation(
      parsed.error.issues[0]?.message ?? "Invalid user data.",
    );
  }
  const { email, name, title, role, tempPassword } = parsed.data;

  if (findUserByEmail(db, email)) {
    throw AppError.conflict(
      `A user with email ${normalizeEmail(email)} already exists.`,
    );
  }

  const passwordHash = tempPassword ? await hashPassword(tempPassword) : null;
  const user = insertUser(db, {
    id: newId("u"),
    email,
    name,
    title: title || null,
    role,
    // A temp password must be replaced at first sign-in.
    pwresetRequired: Boolean(tempPassword),
    idp: "local",
    avatarTone: AVATAR_TONES[countUsers(db) % AVATAR_TONES.length],
    createdBy: actor.userId,
  });
  // Provision the better-auth identity (credential only when a password is set;
  // OAuth-only invitees get user + membership, no credential).
  provisionIdentity(db, {
    id: user.id,
    email: user.email,
    name: user.name,
    passwordHash,
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
  return findUserById(db, user.id)!;
}

export interface UpdateUserPatch {
  name?: string;
  title?: string | null;
  role?: UserRole;
  disabled?: boolean;
}

export function updateUser(
  db: DatabaseSync,
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
    throw AppError.conflict("Cannot demote or disable the last active admin.");
  }

  // Ruling 154: a handle is unique among ENABLED accounts, and the holder
  // lookup ignores disabled rows (as the verdict reader does). So enabling a
  // row whose handle was linked elsewhere in the meantime is the third way to
  // make `resolveGithubHandle` answer `ambiguous` forever. Refuse and name the
  // holder: the admin clears one side, then enables.
  if (patch.disabled === false && existing.disabled && existing.githubHandle) {
    const holder = otherEnabledGithubHandleHolders(
      db,
      normalizeHandle(existing.githubHandle) ?? existing.githubHandle,
      userId,
    )[0];
    if (holder) {
      throw AppError.conflict(
        `@${existing.githubHandle} is linked to ${holder.name}, and a GitHub handle counts for one account. ` +
          `Clear it there, then enable ${existing.name}.`,
      );
    }
  }

  // Only the fields the caller actually sent reach the UPDATE — an absent key
  // means "leave this column alone", which is not the same as clearing it.
  const fields: UserFieldPatch = {};
  if (patch.name !== undefined) fields.name = patch.name.trim();
  if (patch.title !== undefined) fields.title = patch.title;
  if (patch.role !== undefined) fields.role = patch.role;
  if (patch.disabled !== undefined) fields.disabled = patch.disabled;
  const updated = updateUserFields(db, userId, fields);
  if (!updated) throw AppError.notFound("No such user.", { userId });

  if (patch.disabled === true && !existing.disabled) {
    revokeUserSessions(db, userId);
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
      // A role change names both ends; any other edit only lists its fields.
      details:
        patch.role !== undefined && patch.role !== existing.role
          ? {
              email: existing.email,
              fields: changedFields,
              roleFrom: existing.role,
              roleTo: patch.role,
            }
          : { email: existing.email, fields: changedFields },
    });
  }
  return updated;
}

/**
 * Admin password reset: sets a temp password, forces a reset at next login
 * and kills all existing sessions of that user.
 */
export async function resetPassword(
  db: DatabaseSync,
  userId: string,
  tempPassword: string,
  actor: AuditActor,
): Promise<UserRecord> {
  const existing = findUserById(db, userId);
  if (!existing) throw AppError.notFound("No such user.", { userId });
  if (tempPassword.length < MIN_PASSWORD_LENGTH) {
    throw AppError.validation(
      `Temp password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }

  const hash = await hashPassword(tempPassword);
  const updated = updateUserFields(db, userId, {
    pwresetRequired: true,
  });
  if (!updated) throw AppError.notFound("No such user.", { userId });
  // Update the better-auth credential and kill existing sessions.
  setCredentialPassword(db, userId, hash);
  revokeUserSessions(db, userId);

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
  db: DatabaseSync,
  userId: string,
  actor: AuditActor,
): UserRecord {
  return updateUser(db, userId, { disabled: true }, actor);
}

export function enableUser(
  db: DatabaseSync,
  userId: string,
  actor: AuditActor,
): UserRecord {
  return updateUser(db, userId, { disabled: false }, actor);
}
