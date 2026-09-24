import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/**
 * Per-user UI preference store (`user_prefs`, db/migrations/0001_baseline.sql):
 * JSON values under string keys. Personal UI state only (Home pins, grid/list
 * view) — never governed state, so callers may update it optimistically.
 *
 * Phase 9's profile preferences (notification routing, motion, timeline
 * default) live under their own keys here. (The "nudge" preference was
 * retired with the metadata-nudge rework — pass 27; nothing reads it.)
 */

export const HOME_PREFS_KEY = "home";

export type HomePrefs = {
  view: "grid" | "list";
  /** projectSlug → pinned. */
  stars: Record<string, boolean>;
};

/** Any JSON document a pref row can carry — `value_json` holds nothing else,
 *  so this is both what `setPref` accepts and what an undecoded read returns
 *  (the client-safe twin is `StoredPrefJson` in notification-prefs.ts). */
export type PrefJson =
  | PrefJson[]
  | boolean
  | number
  | string
  | { [key: string]: PrefJson }
  | null;

/** `value_json` is TEXT NOT NULL — a row that does not decode as one is no
 *  readable pref, the same as a missing row. */
const prefRowSchema = z.object({ value_json: z.string() });

/**
 * Read one pref. With a schema, the stored JSON is decoded through it and a
 * value that does not conform reads as null — exactly like a missing row —
 * so a hand-edited junk blob degrades to the caller's default. Without one,
 * the raw JSON document is returned for callers that decode at their own
 * boundary (e.g. `mergeNotifPrefs`).
 */
export function getPref(
  db: DatabaseSync,
  userId: string,
  key: string,
): PrefJson | null;
export function getPref<S extends z.ZodType>(
  db: DatabaseSync,
  userId: string,
  key: string,
  schema: S,
): z.infer<S> | null;
export function getPref(
  db: DatabaseSync,
  userId: string,
  key: string,
  schema?: z.ZodType,
) {
  const row = prefRowSchema.safeParse(
    db
      .prepare(`SELECT value_json FROM user_prefs WHERE user_id = ? AND key = ?`)
      .get(userId, key),
  );
  if (!row.success) return null;
  let value: PrefJson;
  try {
    value = JSON.parse(row.data.value_json);
  } catch {
    return null; // tolerant: malformed pref falls back to defaults
  }
  if (!schema) return value;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function setPref(
  db: DatabaseSync,
  userId: string,
  key: string,
  value: PrefJson,
): void {
  db.prepare(
    `INSERT INTO user_prefs (user_id, key, value_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET
       value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(userId, key, JSON.stringify(value), new Date().toISOString());
}

/**
 * The stored `home` blob, decoded tolerantly: the file is hand-editable and
 * the row is whatever an older build wrote, so every field falls back to its
 * default rather than failing the page.
 */
const homePrefsSchema = z.object({
  view: z.enum(["grid", "list"]).catch("grid"),
  /** projectSlug → pinned; an entry that is not a boolean reads as unpinned. */
  stars: z.record(z.string(), z.boolean().catch(false)).catch({}),
});

/** Home prefs with tolerant fallback to defaults for missing/partial rows. */
export function getHomePrefs(db: DatabaseSync, userId: string): HomePrefs {
  return (
    getPref(db, userId, HOME_PREFS_KEY, homePrefsSchema) ?? {
      view: "grid",
      stars: {},
    }
  );
}

export function patchHomePrefs(
  db: DatabaseSync,
  userId: string,
  patch: Partial<HomePrefs>,
): HomePrefs {
  const current = getHomePrefs(db, userId);
  const next: HomePrefs = {
    view: patch.view ?? current.view,
    stars: patch.stars ?? current.stars,
  };
  setPref(db, userId, HOME_PREFS_KEY, next);
  return next;
}
