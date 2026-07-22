/**
 * Centralized snake_case DB row → camelCase mapping for `users`
 * (see CONVENTIONS "Data & naming"). Booleans are 0/1 in SQLite.
 */

/** Org roles are a two-rung ladder: `admin` runs the instance, `member` is
 * everyone else. (The old read-only `viewer` rung was retired — nothing ever
 * gated behavior on it, so it only added dead vocabulary.) */
export type UserRole = "admin" | "member";
export const USER_ROLES = ["admin", "member"] as const;

/** Coerce an arbitrary stored/legacy role string to a live UserRole. Anything
 * that isn't exactly `admin` reads as `member` — this absorbs any stray legacy
 * `viewer` row without a data migration. */
export function coerceUserRole(raw: string | null | undefined): UserRole {
  return raw === "admin" ? "admin" : "member";
}

export type ThemePreference = "light" | "dark" | "system";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  title: string | null;
  role: UserRole;
  has_password: 0 | 1;
  idp: string;
  avatar_tone: string | null;
  pwreset_required: 0 | 1;
  theme: ThemePreference;
  disabled: 0 | 1;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  created_by: string | null;
  github_handle: string | null;
}

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  title: string | null;
  role: UserRole;
  hasPassword: boolean;
  idp: string;
  avatarTone: string | null;
  pwresetRequired: boolean;
  theme: ThemePreference;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  createdBy: string | null;
  /** GitHub login captured at OAuth sign-in (phase 10); null until then. */
  githubHandle: string | null;
}

export function mapUserRow(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    title: row.title,
    role: coerceUserRole(row.role),
    hasPassword: row.has_password === 1,
    idp: row.idp,
    avatarTone: row.avatar_tone,
    pwresetRequired: row.pwreset_required === 1,
    theme: row.theme,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    createdBy: row.created_by,
    githubHandle: row.github_handle ?? null,
  };
}
