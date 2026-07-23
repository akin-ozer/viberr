import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  mapUserRow,
  type UserRecord,
  type UserRole,
  type UserRow,
} from "~/shared/mapping/user.server";

/**
 * Low-level `users` table access. Emails are stored lowercased; lookups are
 * case-insensitive. Admin-facing mutations with validation + audit live in
 * user-admin.server.ts — this module is plain storage.
 */

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const USER_SELECT = `SELECT users.*,
  EXISTS (
    SELECT 1 FROM account
    WHERE account.userId = users.id
      AND account.providerId = 'credential'
      AND account.password IS NOT NULL
  ) AS has_password
  FROM users`;

export function findUserByEmail(
  db: DatabaseSync,
  email: string,
): UserRecord | null {
  const row = db
    .prepare(`${USER_SELECT} WHERE lower(users.email) = ?`)
    .get(normalizeEmail(email)) as UserRow | undefined;
  return row ? mapUserRow(row) : null;
}

export function findUserById(
  db: DatabaseSync,
  id: string,
): UserRecord | null {
  const row = db.prepare(`${USER_SELECT} WHERE users.id = ?`).get(id) as
    | UserRow
    | undefined;
  return row ? mapUserRow(row) : null;
}

export function listUsers(db: DatabaseSync): UserRecord[] {
  const rows = db
    .prepare(`${USER_SELECT} ORDER BY users.created_at ASC, users.id ASC`)
    .all() as unknown as UserRow[];
  return rows.map(mapUserRow);
}

export function countUsers(db: DatabaseSync): number {
  const row = db.prepare(`SELECT count(*) AS c FROM users`).get() as {
    c: number;
  };
  return row.c;
}

/** Active (non-disabled) admins — used by the last-admin lockout guard. */
export function countActiveAdmins(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT count(*) AS c FROM users WHERE role = 'admin' AND disabled = 0`)
    .get() as { c: number };
  return row.c;
}

export interface InsertUserInput {
  id: string;
  email: string;
  name: string;
  title?: string | null;
  role: UserRole;
  idp?: string;
  avatarTone?: string | null;
  pwresetRequired?: boolean;
  createdBy?: string | null;
}

export function insertUser(
  db: DatabaseSync,
  input: InsertUserInput,
): UserRecord {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users
       (id, email, name, title, role, idp, avatar_tone,
        pwreset_required, theme, disabled, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system', 0, ?, ?, ?)`,
  ).run(
    input.id,
    normalizeEmail(input.email),
    input.name,
    input.title ?? null,
    input.role,
    input.idp ?? "local",
    input.avatarTone ?? null,
    input.pwresetRequired ? 1 : 0,
    now,
    now,
    input.createdBy ?? null,
  );
  const created = findUserById(db, input.id);
  if (!created) throw new Error(`user ${input.id} vanished after insert`);
  return created;
}

const UPDATABLE_COLUMNS = {
  name: "name",
  title: "title",
  role: "role",
  disabled: "disabled",
  idp: "idp",
  theme: "theme",
  pwresetRequired: "pwreset_required",
  avatarTone: "avatar_tone",
  githubHandle: "github_handle",
} as const;

export interface UserFieldPatch {
  name?: string;
  title?: string | null;
  role?: UserRole;
  disabled?: boolean;
  idp?: string;
  theme?: UserRecord["theme"];
  pwresetRequired?: boolean;
  avatarTone?: string | null;
  githubHandle?: string | null;
}

/** Generic column patch; bumps updated_at. Returns the fresh record. */
export function updateUserFields(
  db: DatabaseSync,
  id: string,
  patch: UserFieldPatch,
): UserRecord | null {
  const sets: string[] = [];
  const values: SQLInputValue[] = [];
  for (const [key, column] of Object.entries(UPDATABLE_COLUMNS)) {
    if (!(key in patch)) continue;
    const value = patch[key as keyof UserFieldPatch];
    sets.push(`${column} = ?`);
    values.push(typeof value === "boolean" ? (value ? 1 : 0) : (value ?? null));
  }
  if (sets.length > 0) {
    sets.push(`updated_at = ?`);
    values.push(new Date().toISOString());
    values.push(id);
    db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(
      ...values,
    );
  }
  return findUserById(db, id);
}

/** Stamps last_login_at (successful credential or OAuth login). */
export function recordUserLogin(db: DatabaseSync, id: string): void {
  db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    id,
  );
}
