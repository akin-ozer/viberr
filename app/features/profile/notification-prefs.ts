import type { NotificationKind } from "~/shared/mapping/notification.server";

/**
 * Notification-routing preference schema (Phase 9C, profile.md §3.4/§3.5 +
 * ruling 13). Client-safe: catalog copy + defaults + the EXPLICIT plural
 * pref-id ↔ singular notification-kind mapping (contracts §4 flags the
 * mismatch — keep both vocabularies, map once here).
 *
 * V1 routes to the in-app channel ONLY (no mailer, ruling 13): each category
 * carries a single `app` toggle. The dead email booleans and the nudge shape
 * (which no UI ever surfaced and no code ever read) were removed. The mock's
 * `ghConnected` pref is dropped entirely (derived from the user row instead).
 */

export const NOTIF_PREF_CATEGORIES = [
  "packets",
  "approvals",
  "mentions",
  "policy",
  "quality",
] as const;

export type NotifPrefCategory = (typeof NOTIF_PREF_CATEGORIES)[number];

export interface NotifChannelPrefs {
  app: boolean;
}

export type NotifPrefs = Record<NotifPrefCategory, NotifChannelPrefs>;

/** Every routing category ON by default — the model is opt-OUT (a user only
 *  ever stores a pref when they silence a category). */
export const DEFAULT_NOTIF_PREFS: NotifPrefs = {
  packets: { app: true },
  approvals: { app: true },
  mentions: { app: true },
  policy: { app: true },
  quality: { app: true },
};

/**
 * The EXPLICIT singular-kind → plural-category map (contracts §4). Every
 * `notifications.kind` routes through exactly one pref category; a `Record`
 * keyed by `NotificationKind` makes adding a kind a compile error until it is
 * mapped. This is the single source consulted before a notification is
 * inserted (createNotification) — off category ⇒ the row is never written.
 */
const KIND_TO_CATEGORY: Record<NotificationKind, NotifPrefCategory> = {
  packet: "packets",
  approval: "approvals",
  mention: "mentions",
  policy: "policy",
  quality: "quality",
};

export function notifCategoryForKind(kind: NotificationKind): NotifPrefCategory {
  return KIND_TO_CATEGORY[kind];
}

/** The 5 routing categories — PROFILE_NTF, verbatim from profile.jsx. */
export const PROFILE_NTF: {
  id: NotifPrefCategory;
  n: string;
  d: string;
}[] = [
  {
    id: "packets",
    n: "Decision packets for you",
    d: "Blocked decisions and completion reports waiting on your acceptance.",
  },
  {
    id: "approvals",
    n: "Approval requests",
    d: "Operator transition requests at boundaries you can approve.",
  },
  {
    id: "mentions",
    n: "Mentions & replies",
    d: "Comments addressed to you in task timelines.",
  },
  {
    id: "policy",
    n: "Policy events",
    d: "Violations and blocked agent actions on tasks you can see.",
  },
  {
    id: "quality",
    n: "Quality flags",
    d: "Specialist flags on tasks where you own review or acceptance.",
  },
];

export function isNotifPrefCategory(
  value: unknown,
): value is NotifPrefCategory {
  return (
    typeof value === "string" &&
    (NOTIF_PREF_CATEGORIES as readonly string[]).includes(value)
  );
}

/** Tolerant merge of a stored (possibly partial/malformed) pref value over
 * the defaults — unknown keys dropped, missing keys defaulted. */
export function mergeNotifPrefs(raw: unknown): NotifPrefs {
  const merged: NotifPrefs = {
    packets: { ...DEFAULT_NOTIF_PREFS.packets },
    approvals: { ...DEFAULT_NOTIF_PREFS.approvals },
    mentions: { ...DEFAULT_NOTIF_PREFS.mentions },
    policy: { ...DEFAULT_NOTIF_PREFS.policy },
    quality: { ...DEFAULT_NOTIF_PREFS.quality },
  };
  if (raw === null || typeof raw !== "object") return merged;
  for (const category of NOTIF_PREF_CATEGORIES) {
    const entry = (raw as Record<string, unknown>)[category];
    if (entry === null || typeof entry !== "object") continue;
    const { app } = entry as Record<string, unknown>;
    if (typeof app === "boolean") merged[category].app = app;
  }
  return merged;
}
