/**
 * Notification-routing preference schema (Phase 9C, profile.md §3.4/§3.5 +
 * ruling 13). Client-safe: catalog copy + defaults + the EXPLICIT plural
 * pref-id ↔ singular notification-kind mapping (contracts §4 flags the
 * mismatch — keep both vocabularies, map once here).
 *
 * Per ruling 13 the `email` booleans and the nudge shape are SCHEMA-ONLY
 * (no mailer in V1): they persist through the store untouched but no UI
 * surfaces them — only the `app` toggle renders. The mock's `ghConnected`
 * pref is dropped entirely (derived from the user row instead).
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
  /** Schema-only in V1 — no mailer (ruling 13). */
  email: boolean;
}

export type NotifPrefs = Record<NotifPrefCategory, NotifChannelPrefs>;

/** Mock `initPrefs` defaults, verbatim (ui.jsx). */
export const DEFAULT_NOTIF_PREFS: NotifPrefs = {
  packets: { app: true, email: true },
  approvals: { app: true, email: false },
  mentions: { app: true, email: true },
  policy: { app: true, email: true },
  quality: { app: true, email: false },
};

/** Nudge prefs — schema-only (ruling 13 / profile.md §8 Q3): kept for a
 * future "re-ping unanswered decisions" feature, never rendered in V1. */
export const DEFAULT_NUDGE = { on: true, hours: 2 } as const;
export const PROFILE_NUDGE_HOURS = [1, 2, 4, 8, 24] as const;

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
    const { app, email } = entry as Record<string, unknown>;
    if (typeof app === "boolean") merged[category].app = app;
    if (typeof email === "boolean") merged[category].email = email;
  }
  return merged;
}
