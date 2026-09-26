import { z } from "zod";
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
  // Ruling 481(a): an agent's question, its own toggle. It used to ride
  // "approvals", so silencing stage-approval noise silenced every question.
  "questions",
  "approvals",
  "mentions",
  "policy",
  "quality",
  // Ruling 503: the epics this person leads. It replaced ruling 99's
  // `controller` category, whose only writer was the chained-goal progress
  // note that epics retired.
  "epics",
  // Ruling 131: a task this person owns or supervises was released from (or
  // stranded on) the work it waited for.
  "dependencies",
  // Ruling 140: this person's owner seat on a task changed hands.
  "ownership",
] as const;

export type NotifPrefCategory = (typeof NOTIF_PREF_CATEGORIES)[number];

export type NotifChannelPrefs = {
  app: boolean;
};

export type NotifPrefs = Record<NotifPrefCategory, NotifChannelPrefs>;

/** Every routing category ON by default — the model is opt-OUT (a user only
 *  ever stores a pref when they silence a category). A factory, not a shared
 *  constant, because `mergeNotifPrefs` hands its fallback straight to callers:
 *  the exported default must never be reachable (and mutable) through one. */
function defaultNotifPrefs() {
  return {
    packets: { app: true },
    questions: { app: true },
    approvals: { app: true },
    mentions: { app: true },
    policy: { app: true },
    quality: { app: true },
    epics: { app: true },
    dependencies: { app: true },
    ownership: { app: true },
  } satisfies NotifPrefs;
}

export const DEFAULT_NOTIF_PREFS = defaultNotifPrefs();

/**
 * The EXPLICIT singular-kind → plural-category map (contracts §4). Every
 * `notifications.kind` routes through exactly one pref category; `satisfies`
 * against a `Record` keyed by `NotificationKind` makes adding a kind a compile
 * error until it is mapped. This is the single source consulted before a
 * notification is inserted (createNotification) — off category ⇒ the row is
 * never written.
 */
const KIND_TO_CATEGORY = {
  packet: "packets",
  question: "questions",
  approval: "approvals",
  mention: "mentions",
  policy: "policy",
  quality: "quality",
  // Ruling 503: the rows an upgraded inbox holds from goal chains were epic
  // progress in all but name, so they answer to the category that replaced
  // theirs.
  controller: "epics",
  dependency: "dependencies",
  ownership: "ownership",
  epic: "epics",
} satisfies Record<NotificationKind, NotifPrefCategory>;

export function notifCategoryForKind(kind: NotificationKind): NotifPrefCategory {
  return KIND_TO_CATEGORY[kind];
}

/** The routing categories — PROFILE_NTF (the rows of profile.jsx;
 *  `dependencies` per ruling 131, `ownership` per ruling 140, `questions` per
 *  ruling 481 and `epics` per ruling 503).
 *
 *  Ruling 481(a) (F40-48): each description names what its kind's writers
 *  actually send. "Approval requests" said "Operator transition requests at
 *  boundaries you can approve" while it carried every agent question, so a
 *  person who switched it off to quiet stage traffic stopped hearing from the
 *  agents waiting on them. `notification-prefs.test.ts` pins each writer's
 *  subject to the description of the category it routes through. */
export const PROFILE_NTF: {
  id: NotifPrefCategory;
  n: string;
  d: string;
}[] = [
  {
    id: "packets",
    n: "Decision packets for you",
    d: "Decisions the operator opened for you: a blocked task, a question about scope, or a completion report waiting on your acceptance.",
  },
  {
    id: "questions",
    n: "Agent questions",
    d: "A question an agent working on your task asked a person to answer. The agent waits until someone does.",
  },
  {
    id: "approvals",
    n: "Approval requests",
    d: "The operator's recommendations and the next step recorded after a delivery, waiting for you to apply or dismiss them.",
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
  {
    id: "epics",
    n: "Epic updates",
    d: "Tasks joining or leaving an epic you lead, being made its lead, someone else closing or reopening it, and every task in it being done.",
  },
  {
    id: "dependencies",
    n: "Dependency releases",
    d: "A task you own or supervise was released from the work it waited on, or that work can no longer complete.",
  },
  {
    id: "ownership",
    n: "Ownership changes",
    d: "A task's owner seat was handed to you or taken from you; the owner's accounts run its agents and accept its completion.",
  },
];

const notifPrefCategorySchema = z.enum(NOTIF_PREF_CATEGORIES);

export function isNotifPrefCategory(value: string): value is NotifPrefCategory {
  return notifPrefCategorySchema.safeParse(value).success;
}

/**
 * What the pref store can hand back for this key. `user_prefs.value_json` is
 * TEXT that `getPref` runs through `JSON.parse`, so any JSON value can arrive —
 * including a record an older build wrote under a different set of keys.
 * `mergeNotifPrefs` is the decode boundary that turns it into `NotifPrefs`.
 */
export type StoredPrefJson =
  | StoredPrefJson[]
  | boolean
  | number
  | string
  | { [key: string]: StoredPrefJson }
  | null;

/** A category whose stored entry does not decode reads as ON — the model is
 *  opt-OUT, so an unreadable entry must never silence a category. */
const storedChannelPrefsSchema = z
  .object({ app: z.boolean() })
  .catch(() => ({ app: true }));

/** Tolerant decode of a stored (possibly partial/malformed) pref value:
 *  unknown keys are dropped by `z.object`'s strip, and the per-category
 *  `.catch` keeps one junk entry from discarding the others. */
const storedNotifPrefsSchema = z.object({
  packets: storedChannelPrefsSchema,
  // Ruling 481: absent on prefs stored before agent questions had their own
  // category — the per-field catch reads it as ON.
  questions: storedChannelPrefsSchema,
  approvals: storedChannelPrefsSchema,
  mentions: storedChannelPrefsSchema,
  policy: storedChannelPrefsSchema,
  quality: storedChannelPrefsSchema,
  // Ruling 503: absent on prefs stored before epics — the per-field catch
  // reads it as ON, the opt-out default every category has. A person who had
  // silenced ruling 99's `controller` category keeps it silenced here, since
  // that category carried the goal-chain notes epics replaced
  // (`mergeNotifPrefs`).
  epics: storedChannelPrefsSchema,
  // Rulings 131 / 140 (pass 34): same posture — absent reads ON.
  dependencies: storedChannelPrefsSchema,
  ownership: storedChannelPrefsSchema,
});

/** Tolerant merge of a stored (possibly partial/malformed) pref value over
 * the defaults — unknown keys dropped, missing keys defaulted. */
export function mergeNotifPrefs(raw: StoredPrefJson | null): NotifPrefs {
  const parsed = storedNotifPrefsSchema.safeParse(carryControllerPref(raw));
  return parsed.success ? parsed.data : defaultNotifPrefs();
}

/**
 * Ruling 503: a value stored before epics names the retired `controller`
 * category, whose only notes were goal-chain progress. Read it as `epics`
 * when `epics` itself was never stored, so silencing goal-chain notes keeps
 * epic notes silenced instead of turning them back on at the upgrade.
 */
function carryControllerPref(raw: StoredPrefJson | null): StoredPrefJson | null {
  if (raw === null || !isStoredPrefMap(raw)) return raw;
  if ("epics" in raw || !("controller" in raw)) return raw;
  return { ...raw, epics: raw.controller ?? null };
}

function isStoredPrefMap(raw: StoredPrefJson): raw is { [key: string]: StoredPrefJson } {
  return storedPrefMapSchema.safeParse(raw).success;
}

const storedPrefMapSchema = z.record(z.string(), z.unknown());
