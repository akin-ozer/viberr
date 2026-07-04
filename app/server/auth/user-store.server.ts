import type Database from "better-sqlite3";
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

export function findUserByEmail(
  db: Database.Database,
  email: string,
): UserRecord | null {
  const row = db
    .prepare(`SELECT * FROM users WHERE lower(email) = ?`)
    .get(normalizeEmail(email)) as UserRow | undefined;
  return row ? mapUserRow(row) : null;
}

export function findUserById(
  db: Database.Database,
  id: string,
): UserRecord | null {
  const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as
    | UserRow
    | undefined;
  return row ? mapUserRow(row) : null;
}

export function listUsers(db: Database.Database): UserRecord[] {
  const rows = db
    .prepare(`SELECT * FROM users ORDER BY created_at ASC, id ASC`)
    .all() as UserRow[];
  return rows.map(mapUserRow);
}

export function countUsers(db: Database.Database): number {
  const row = db.prepare(`SELECT count(*) AS c FROM users`).get() as {
    c: number;
  };
  return row.c;
}

/** Active (non-disabled) admins — used by the last-admin lockout guard. */
export function countActiveAdmins(db: Database.Database): number {
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
  passwordHash?: string | null;
  idp?: string;
  avatarTone?: string | null;
  pwresetRequired?: boolean;
  createdBy?: string | null;
}

export function insertUser(
  db: Database.Database,
  input: InsertUserInput,
): UserRecord {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users
       (id, email, name, title, role, password_hash, idp, avatar_tone,
        pwreset_required, theme, disabled, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'system', 0, ?, ?, ?)`,
  ).run(
    input.id,
    normalizeEmail(input.email),
    input.name,
    input.title ?? null,
    input.role,
    input.passwordHash ?? null,
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
  passwordHash: "password_hash",
  pwresetRequired: "pwreset_required",
  avatarTone: "avatar_tone",
} as const;

export interface UserFieldPatch {
  name?: string;
  title?: string | null;
  role?: UserRole;
  disabled?: boolean;
  idp?: string;
  theme?: UserRecord["theme"];
  passwordHash?: string | null;
  pwresetRequired?: boolean;
  avatarTone?: string | null;
}

/** Generic column patch; bumps updated_at. Returns the fresh record. */
export function updateUserFields(
  db: Database.Database,
  id: string,
  patch: UserFieldPatch,
): UserRecord | null {
  const sets: string[] = [];
  const values: unknown[] = [];
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
export function recordUserLogin(db: Database.Database, id: string): void {
  db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    id,
  );
}
