import type { DatabaseSync } from "node:sqlite";
import { findUserById } from "~/server/auth/user-store.server";
import { getPref } from "~/server/prefs/user-prefs.server";
import { ROLE_IDS } from "~/features/policy/policy-data";
import type { ProjectRole } from "~/shared/rbac";
import { ROLE_RANK } from "~/shared/rbac";
import type { NotificationKind } from "~/shared/mapping/notification.server";
import {
  mergeNotifPrefs,
  notifCategoryForKind,
  type NotifPrefs,
} from "./notification-prefs";

/**
 * Profile overlay read model (Phase 9C, profile.md). The session user is
 * the single source of `me` (ruling 6) — this module only widens the
 * session id into the display facts the panels need. Credential hashes never
 * leaves the server; only the derived `hasPassword` boolean ships.
 *
 * `githubConnected` is DERIVED from users.idp (ruling 13 dropped the
 * mock's `ghConnected` pref) — connected means this account currently
 * signs in through the GitHub OAuth whitelist flow.
 */

export type MotionPreference = "full" | "reduce";
export type TimelineDefault = "all" | "typed" | "comment";

export const MOTION_PREF_KEY = "motion";
/** Phase-5 contract: routes/project.task.tsx reads this same key. */
export const TL_DEFAULT_PREF_KEY = "tlDefault";
export const NOTIFS_PREF_KEY = "notifs";

export interface ProfileMembership {
  slug: string;
  name: string;
  role: ProjectRole;
}

export interface ProfileView {
  user: {
    id: string;
    name: string;
    title: string | null;
    email: string;
    idp: string;
    createdAt: string;
    avatarTone: string;
    hasPassword: boolean;
    githubConnected: boolean;
    /** GitHub login captured at OAuth sign-in (Phase 10); null until then. */
    githubHandle: string | null;
  };
  /** All project memberships, most-active project first. */
  memberships: ProfileMembership[];
  /** Highest project role across memberships (admin > maintainer >
   * contributor > viewer, the shared ROLE_RANK scale); null when the user
   * is in no project. */
  accessRole: ProjectRole | null;
  prefs: {
    notifs: NotifPrefs;
    motion: MotionPreference;
    tlDefault: TimelineDefault;
  };
}

/** Memberships ordered most-active project first (task count DESC, then
 * name) — the first entry drives the "visible to X members" toast and the
 * Policy/Settings links, so it should be the project the user actually
 * works in, not an alphabetical accident. */
export function listUserMemberships(
  db: DatabaseSync,
  userId: string,
): ProfileMembership[] {
  const rows = db
    .prepare(
      `SELECT pm.project_slug AS slug, pm.role, p.name,
              (SELECT COUNT(*) FROM task_projections tp
               WHERE tp.project_slug = pm.project_slug) AS task_count
       FROM project_members pm JOIN projects p ON p.slug = pm.project_slug
       WHERE pm.user_id = ? ORDER BY task_count DESC, p.name ASC`,
    )
    .all(userId) as { slug: string; role: string; name: string }[];
  return rows
    .filter((r): r is { slug: string; role: ProjectRole; name: string } =>
      (ROLE_IDS as readonly string[]).includes(r.role),
    )
    .map((r) => ({ slug: r.slug, name: r.name, role: r.role }));
}

/** A user's notification-routing prefs with defaults applied (opt-out model:
 *  a missing/partial row reads as every category ON). Single reader of the
 *  `notifs` pref key — both the profile view and the notification-creation
 *  gate go through here. */
export function getNotifPrefs(
  db: DatabaseSync,
  userId: string,
): NotifPrefs {
  return mergeNotifPrefs(getPref(db, userId, NOTIFS_PREF_KEY));
}

/** Whether a user wants in-app notifications of this kind. Opt-out: an unset
 *  pref defaults to ON. Consulted before every notification insert so a
 *  silenced category never reaches the recipient's inbox (FR26 routing). */
export function isNotifKindEnabled(
  db: DatabaseSync,
  userId: string,
  kind: NotificationKind,
): boolean {
  return getNotifPrefs(db, userId)[notifCategoryForKind(kind)].app;
}

export function getMotionPref(
  db: DatabaseSync,
  userId: string,
): MotionPreference {
  return getPref<string>(db, userId, MOTION_PREF_KEY) === "reduce"
    ? "reduce"
    : "full";
}

export function getTimelineDefaultPref(
  db: DatabaseSync,
  userId: string,
): TimelineDefault {
  const raw = getPref<string>(db, userId, TL_DEFAULT_PREF_KEY);
  return raw === "typed" || raw === "comment" ? raw : "all";
}

export function getProfileView(
  db: DatabaseSync,
  userId: string,
): ProfileView | null {
  const user = findUserById(db, userId);
  if (!user) return null;

  const memberships = listUserMemberships(db, userId);
  const accessRole =
    memberships.length === 0
      ? null
      : memberships.reduce<ProjectRole>(
          (best, m) => (ROLE_RANK[m.role] > ROLE_RANK[best] ? m.role : best),
          memberships[0]!.role,
        );

  return {
    user: {
      id: user.id,
      name: user.name,
      title: user.title,
      email: user.email,
      idp: user.idp,
      createdAt: user.createdAt,
      avatarTone: user.avatarTone ?? "",
      hasPassword: user.hasPassword,
      githubConnected: user.idp === "github",
      githubHandle: user.githubHandle,
    },
    memberships,
    accessRole,
    prefs: {
      notifs: getNotifPrefs(db, userId),
      motion: getMotionPref(db, userId),
      tlDefault: getTimelineDefaultPref(db, userId),
    },
  };
}
