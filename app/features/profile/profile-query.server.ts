import type Database from "better-sqlite3";
import { findUserById } from "~/server/auth/user-store.server";
import { getPref } from "~/server/prefs/user-prefs.server";
import { ROLE_IDS, type RoleId } from "~/features/policy/policy-data";
import type { NotificationKind } from "~/shared/mapping/notification.server";
import {
  mergeNotifPrefs,
  notifCategoryForKind,
  type NotifPrefs,
} from "./notification-prefs";

/**
 * Profile overlay read model (Phase 9C, profile.md). The session user is
 * the single source of `me` (ruling 6) — this module only widens the
 * session id into the display facts the panels need. `passwordHash` never
 * leaves the server; only the derived `hasPassword` boolean ships.
 *
 * `githubConnected` is derived from Better Auth's linked-account table, not
 * the legacy `users.idp` display field. It therefore means a GitHub OAuth
 * sign-in is actually linked to this workspace account.
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
  role: RoleId;
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
  /** Explicit context for every project-scoped permission and destination. */
  selectedProject: ProfileMembership | null;
  prefs: {
    notifs: NotifPrefs;
    motion: MotionPreference;
    tlDefault: TimelineDefault;
  };
}

/** Memberships ordered most-active project first (task count DESC, then
 * name). The route may choose one explicitly with `?project=<slug>`; this
 * ordering is only the initial fallback when the URL has no valid selection. */
export function listUserMemberships(
  db: Database.Database,
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
    .filter((r): r is { slug: string; role: RoleId; name: string } =>
      (ROLE_IDS as readonly string[]).includes(r.role),
    )
    .map((r) => ({ slug: r.slug, name: r.name, role: r.role }));
}

/** A user's notification-routing prefs with defaults applied (opt-out model:
 *  a missing/partial row reads as every category ON). Single reader of the
 *  `notifs` pref key — both the profile view and the notification-creation
 *  gate go through here. */
export function getNotifPrefs(
  db: Database.Database,
  userId: string,
): NotifPrefs {
  return mergeNotifPrefs(getPref(db, userId, NOTIFS_PREF_KEY));
}

/** Whether a user wants in-app notifications of this kind. Opt-out: an unset
 *  pref defaults to ON. Consulted before every notification insert so a
 *  silenced category never reaches the recipient's inbox (FR26 routing). */
export function isNotifKindEnabled(
  db: Database.Database,
  userId: string,
  kind: NotificationKind,
): boolean {
  return getNotifPrefs(db, userId)[notifCategoryForKind(kind)].app;
}

export function getMotionPref(
  db: Database.Database,
  userId: string,
): MotionPreference {
  return getPref<string>(db, userId, MOTION_PREF_KEY) === "reduce"
    ? "reduce"
    : "full";
}

export function getTimelineDefaultPref(
  db: Database.Database,
  userId: string,
): TimelineDefault {
  const raw = getPref<string>(db, userId, TL_DEFAULT_PREF_KEY);
  return raw === "typed" || raw === "comment" ? raw : "all";
}

export function getProfileView(
  db: Database.Database,
  userId: string,
  selectedProjectSlug?: string | null,
): ProfileView | null {
  const user = findUserById(db, userId);
  if (!user) return null;

  const memberships = listUserMemberships(db, userId);
  const selectedProject =
    memberships.find((membership) => membership.slug === selectedProjectSlug) ??
    memberships[0] ??
    null;
  const githubConnected = Boolean(
    db
      .prepare(
        `SELECT 1 FROM account
         WHERE userId = ? AND providerId = 'github'
         LIMIT 1`,
      )
      .get(userId),
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
      hasPassword: user.passwordHash !== null,
      githubConnected,
      githubHandle: user.githubHandle,
    },
    memberships,
    selectedProject,
    prefs: {
      notifs: getNotifPrefs(db, userId),
      motion: getMotionPref(db, userId),
      tlDefault: getTimelineDefaultPref(db, userId),
    },
  };
}
