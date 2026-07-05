/**
 * Centralized snake_case DB row → camelCase mapping for `users`
 * (see CONVENTIONS "Data & naming"). Booleans are 0/1 in SQLite.
 */

export type UserRole = "admin" | "member" | "viewer";
export const USER_ROLES = ["admin", "member", "viewer"] as const;

export type ThemePreference = "light" | "dark" | "system";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  title: string | null;
  role: UserRole;
  password_hash: string | null;
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
  passwordHash: string | null;
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
    role: row.role,
    passwordHash: row.password_hash,
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
