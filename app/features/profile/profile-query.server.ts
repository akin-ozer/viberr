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
import {
  latestBackendRateLimits,
  providerSentence,
  type BackendQuotaRow,
} from "~/server/runtimes/backend-quota.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import { ROLE_IDS } from "~/features/policy/policy-data";
import type { ProjectRole } from "~/shared/rbac";
import { ROLE_RANK } from "~/shared/rbac";
import { observedAfter } from "~/shared/freshness";
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

export type TimelineDefault = "all" | "typed" | "comment";

/** Decoder for the scalar pref key — a stored value outside the vocabulary
 *  reads as null from `getPref`, i.e. as the default. (Ruling 148(c): the
 *  `motion` key and its decoder are gone with the in-app setting.) */
const timelineDefaultSchema = z.enum(["all", "typed", "comment"]);

/** Phase-5 contract: routes/project.task.tsx reads this same key. */
export const TL_DEFAULT_PREF_KEY = "tlDefault";
export const NOTIFS_PREF_KEY = "notifs";

export interface ProfileMembership {
  slug: string;
  name: string;
  role: ProjectRole;
}

/**
 * One backend card on Profile → Agent accounts (ruling 127).
 *
 * `health` is the SAME per-person answer every other surface reads
 * (`userBackendHealth`), never a second opinion computed here; `login` is the
 * viewer's own hosted sign-in when one is running or recently ended; `methods`
 * is what this vendor actually offers, so the card renders the buttons the
 * vendor supports instead of a hardcoded pair.
 */
/**
 * Ruling 130(d) (pass 34, F34-1): the last refusal Viberr OBSERVED on this
 * person's OWN account, for their Agent-accounts card. Live, every run on an
 * account was refused with a 403 while the card said "connected · verified".
 * A completed run on the backend by anyone retires the record, so the absence
 * of a refusal is not proof the account works; the card says so.
 */
export interface ProfileBackendRefusal {
  /** `credential`: the provider rejected the account; `quota`: a usage window
   *  is spent. */
  kind: "credential" | "quota";
  /** The provider's own sentence, the provider half only. */
  providerText: string;
  /** ISO instant of the failure line the record was read off. */
  observedAt: string;
  runId: string;
  /** ISO instant the spent window reopens (quota only; null when undated). */
  resetsAt: string | null;
  /** How exact that instant is (pass 34 review): `exact`/`clock` carry a real
   *  minute, `prose` is a UTC calendar DAY the provider named in words, and a
   *  surface that renders it as a local time claims precision it never had. */
  resetsAtPrecision: "exact" | "prose" | "clock" | null;
}

/**
 * Ruling 294: what this backend last told Viberr about THIS person's window.
 *
 * An observation, never a probe — Viberr has no way to ask a provider how much
 * of a window is left, so this is whatever the last run billed to this person
 * happened to report. That is why it carries `observedAt` and why the card
 * renders the age beside the number: a percentage with no age reads as current
 * when it may be hours old, and the honest failure here is a person deciding
 * they have room to run on a figure from this morning.
 */
export interface ProfileBackendUsage {
  /** Provider's own status word, e.g. "allowed" / "allowed_warning". */
  status: string;
  /** The window the reading is about, e.g. "seven_day" / "five_hour". */
  rateLimitType: string;
  /** 0..1 of the window consumed; null when the provider omitted it. */
  utilization: number | null;
  /** ISO instant the window resets; null when the provider omitted it. */
  resetsAt: string | null;
  isUsingOverage: boolean;
  /** ISO instant of the run line this reading was read off. */
  observedAt: string;
}

export interface ProfileBackend {
  backend: RealBackend;
  health: UserBackendHealth;
  login: LoginSessionView | null;
  methods: {
    signIn: LoginMethod[];
    paste: PastedKind[];
  };
  /** The viewer's own last observed refusal on this backend, or null. Optional
   *  so fixtures that predate it stay valid; the loader always sets it. */
  lastRefusal?: ProfileBackendRefusal | null;
  /** Ruling 294: the viewer's OWN last reading on this backend, or null.
   *  Optional so fixtures that predate it stay valid; the loader always sets
   *  it. */
  usage?: ProfileBackendUsage | null;
}

/**
 * Ruling 294: the viewer's OWN reading, or null.
 *
 * The store keeps ONE reading per backend for the whole instance (`KEY_PREFIX`
 * in backend-quota.server), written with the principal of whichever run
 * reported it. Rendering that unscoped on a personal card would put a
 * colleague's "91% of seven day" under the viewer's own name, on the one page
 * whose entire premise is that it is YOUR account. That is the defect ruling
 * 130(d) fixed for refusals, one field over, so this takes the same line
 * `ownRefusal` does — including for a record that names NOBODY, which predates
 * principals and is therefore not evidence about this account either.
 */
function ownReading(
  row: BackendQuotaRow | undefined,
  userId: string,
  /** When the credential now in the slot was connected, or null when nothing is
   *  connected. A reading OLDER than that describes the account this one
   *  replaced. */
  connectedAt: string | null,
): ProfileBackendUsage | null {
  const reading = row?.reading;
  if (!reading || reading.credentialUserId !== userId) return null;
  // Ruling 294, the second gate, and it is belt to `retireBackendRecordsFor`'s
  // braces rather than a duplicate of it. That function deletes the reading
  // when the credential changes, which closes the case at the source; this
  // catches a reading that outlived a connection some OTHER path replaced, and
  // the specific moment it matters is the panel's own
  // `revalidator.revalidate()` on a completed sign-in — the instant a person
  // finishes connecting a DIFFERENT account is exactly when a surviving reading
  // would be re-rendered as their current usage. The principal check above
  // cannot catch that one: the same person owns both accounts.
  if (connectedAt && !observedAfter(reading.observedAt, connectedAt)) return null;
  return {
    status: reading.status,
    rateLimitType: reading.rateLimitType,
    utilization: reading.utilization,
    resetsAt: reading.resetsAt === null ? null : new Date(reading.resetsAt * 1000).toISOString(),
    isUsingOverage: reading.isUsingOverage,
    observedAt: reading.observedAt,
  };
}

/** The record is this person's only when the run it was read off billed them
 *  (`credentialUserId`, ruling 127): another person's refusal, or a record
 *  written before principals were stored, is never shown on this card. */
function ownRefusal(row: BackendQuotaRow | undefined, userId: string): ProfileBackendRefusal | null {
  const refused = row?.credentialRefused;
  if (refused && refused.credentialUserId === userId) {
    return {
      kind: "credential",
      providerText: providerSentence(refused.providerText),
      observedAt: refused.observedAt,
      runId: refused.runId,
      resetsAt: null,
      resetsAtPrecision: null,
    };
  }
  const spent = row?.exhausted;
  // Ruling 294: a READING observed after an exhaustion record supersedes it,
  // the rule /insights has applied since pass 31 (V4) and this projection never
  // had. It was invisible while the card showed no usage; the moment it does,
  // the same card would carry "12% of seven day, observed 14:02" beside "usage
  // window spent, observed 09:30" — two claims from one provider with the
  // older one winning. An exhaustion is a claim about ONE moment; a later
  // reading is fresher evidence from the same source that the backend is
  // answering again.
  if (spent && spent.credentialUserId === userId && !observedAfter(row?.reading?.observedAt, spent.observedAt)) {
    return {
      kind: "quota",
      providerText: providerSentence(spent.providerText),
      observedAt: spent.observedAt,
      runId: spent.runId,
      resetsAt: spent.resetsAt === null ? null : new Date(spent.resetsAt * 1000).toISOString(),
      resetsAtPrecision: spent.resetsAtPrecision ?? null,
    };
  }
  return null;
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
  // One read of the quota store for both cards (ruling 130(d)).
  const limits = new Map(latestBackendRateLimits(db).map((row) => [row.backend, row]));
  return PROFILE_BACKENDS.map((backend) => {
    const health = userBackendHealth(db, userId, backend);
    return {
    backend,
    health,
    login: getBackendLogin(userId, backend),
    lastRefusal: ownRefusal(limits.get(backend), userId),
    usage: ownReading(limits.get(backend), userId, health.connectedAt),
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
    };
  });
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
    /** GitHub login captured at OAuth sign-in (Phase 10) or linked by an org
     *  admin under Users & access (ruling 154); null until either. */
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
  /** Ruling 127: the viewer's own Claude and Codex accounts, one entry per
   *  backend. Runs on tasks they own, and their controller turns, bill these. */
  backends: ProfileBackend[];
  prefs: {
    notifs: NotifPrefs;
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
      tlDefault: getTimelineDefaultPref(db, userId),
    },
  };
}
