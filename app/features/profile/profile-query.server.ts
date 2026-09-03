import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { resolveOAuthProvider } from "~/server/auth/oauth-providers.server";
import { findUserById } from "~/server/auth/user-store.server";
import { getPref } from "~/server/prefs/user-prefs.server";
import {
  BACKEND_PASTE_KINDS,
  userBackendHealth,
  type LoginMethod,
  type PastedKind,
  type UserBackendHealth,
} from "~/server/runtimes/backend-credentials.server";
import {
  BACKEND_SIGN_IN_METHODS,
  getBackendLogin,
  type LoginSessionView,
} from "~/server/runtimes/backend-login.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
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

/** Decoders for the two scalar pref keys — a stored value outside the
 *  vocabulary reads as null from `getPref`, i.e. as the default. */
const motionPrefSchema = z.enum(["full", "reduce"]);
const timelineDefaultSchema = z.enum(["all", "typed", "comment"]);

export const MOTION_PREF_KEY = "motion";
/** Phase-5 contract: routes/project.task.tsx reads this same key. */
export const TL_DEFAULT_PREF_KEY = "tlDefault";
export const NOTIFS_PREF_KEY = "notifs";

export interface ProfileMembership {
  slug: string;
  name: string;
  role: ProjectRole;
}

/**
 * One backend card on Profile → Agent accounts (ruling 121).
 *
 * `health` is the SAME per-person answer every other surface reads
 * (`userBackendHealth`), never a second opinion computed here; `login` is the
 * viewer's own hosted sign-in when one is running or recently ended; `methods`
 * is what this vendor actually offers, so the card renders the buttons the
 * vendor supports instead of a hardcoded pair.
 */
export interface ProfileBackend {
  backend: RealBackend;
  health: UserBackendHealth;
  login: LoginSessionView | null;
  methods: {
    signIn: LoginMethod[];
    paste: PastedKind[];
  };
}

/** Both agent backends, in the order the panel renders them. */
export const PROFILE_BACKENDS: readonly RealBackend[] = ["claude", "codex"];

/**
 * The viewer's own agent accounts. Re-derived per request (health re-probes the
 * filesystem, a sign-in session is live process state), and secret-free: a
 * `UserBackendHealth` carries a key's last four characters and never the key,
 * and a `LoginSessionView` carries only what the vendor showed the person.
 */
export function getProfileBackends(
  db: DatabaseSync,
  userId: string,
): ProfileBackend[] {
  return PROFILE_BACKENDS.map((backend) => ({
    backend,
    health: userBackendHealth(db, userId, backend),
    login: getBackendLogin(userId, backend),
    methods: {
      // The sign-in list is the DRIVER's own table, not a copy of it: a card
      // that offered a flow `startBackendLogin` refuses would post a button
      // that can only ever come back "Claude does not offer that sign-in
      // method." (AGENTS.md: one home per fact.)
      signIn: [...BACKEND_SIGN_IN_METHODS[backend]],
      // The paste list is the STORE's own table for the same reason: a card
      // that offered `access_token` for Claude would post a button
      // `setBackendApiKey` can only refuse.
      paste: [...BACKEND_PASTE_KINDS[backend]],
    },
  }));
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
  /**
   * F18-3: whether GitHub OAuth is configured on this deployment. When false, a
   * "Connect" here can only ever fail — so the card shows a quiet one-liner
   * instead of warn scope chips + a doomed Connect button (mirrors R17-4).
   */
  githubConfigured: boolean;
  /** Ruling 121: the viewer's own Claude and Codex accounts, one entry per
   *  backend. Runs on tasks they own, and their controller turns, bill these. */
  backends: ProfileBackend[];
  prefs: {
    notifs: NotifPrefs;
    motion: MotionPreference;
    tlDefault: TimelineDefault;
  };
}

/** The membership columns {@link listUserMemberships} reads. `role` is the raw
 *  stored value — a row whose role is outside the canonical four is dropped
 *  rather than trusted. */
type MembershipRow = {
  slug: string;
  role: string;
  name: string;
};

/** Memberships ordered most-active project first (task count DESC, then
 * name) — the first entry drives the "visible to X members" toast and the
 * Policy/Settings links, so it should be the project the user actually
 * works in, not an alphabetical accident. */
export function listUserMemberships(
  db: DatabaseSync,
  userId: string,
): ProfileMembership[] {
  // SAFETY: the three names the row type lists are exactly the three the SELECT
  // aliases, and 0001_baseline declares `project_members.project_slug`/`role`
  // and `projects.name` NOT NULL. `task_count` orders the result and is not
  // read, so it is deliberately absent from the row contract.
  const rows = db
    .prepare(
      `SELECT pm.project_slug AS slug, pm.role, p.name,
              (SELECT COUNT(*) FROM task_projections tp
               WHERE tp.project_slug = pm.project_slug) AS task_count
       FROM project_members pm JOIN projects p ON p.slug = pm.project_slug
       WHERE pm.user_id = ? ORDER BY task_count DESC, p.name ASC`,
    )
    .all(userId) as MembershipRow[];
  return rows
    .filter((r): r is MembershipRow & { role: ProjectRole } =>
      ROLE_IDS.some((id) => id === r.role),
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
  return getPref(db, userId, MOTION_PREF_KEY, motionPrefSchema) ?? "full";
}

export function getTimelineDefaultPref(
  db: DatabaseSync,
  userId: string,
): TimelineDefault {
  return getPref(db, userId, TL_DEFAULT_PREF_KEY, timelineDefaultSchema) ?? "all";
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
    // R19-16: resolved the same way better-auth resolves it (app configuration
    // overriding the deployment env), so "link GitHub" appears exactly when the
    // handler can actually start the flow.
    githubConfigured:
      resolveOAuthProvider(db, "github").credentials !== null,
    backends: getProfileBackends(db, userId),
    prefs: {
      notifs: getNotifPrefs(db, userId),
      motion: getMotionPref(db, userId),
      tlDefault: getTimelineDefaultPref(db, userId),
    },
  };
}
