import type { DatabaseSync } from "node:sqlite";

/**
 * Per-user UI preference store (`user_prefs`, migration 0004): JSON values
 * under string keys. Personal UI state only (Home pins, grid/list view) —
 * never governed state, so callers may update it optimistically.
 *
 * Phase 9's profile preferences (notification routing, nudge, motion,
 * timeline default) are expected to live under their own keys here.
 */

export const HOME_PREFS_KEY = "home";

export interface HomePrefs {
  view: "grid" | "list";
  /** projectSlug → pinned. */
  stars: Record<string, boolean>;
}

export function getPref<T>(
  db: DatabaseSync,
  userId: string,
  key: string,
): T | null {
  const row = db
    .prepare(`SELECT value_json FROM user_prefs WHERE user_id = ? AND key = ?`)
    .get(userId, key) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null; // tolerant: malformed pref falls back to defaults
  }
}

export function setPref(
  db: DatabaseSync,
  userId: string,
  key: string,
  value: unknown,
): void {
  db.prepare(
    `INSERT INTO user_prefs (user_id, key, value_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET
       value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(userId, key, JSON.stringify(value), new Date().toISOString());
}

/** Home prefs with tolerant fallback to defaults for missing/partial rows. */
export function getHomePrefs(db: DatabaseSync, userId: string): HomePrefs {
  const raw = getPref<Partial<HomePrefs>>(db, userId, HOME_PREFS_KEY);
  return {
    view: raw?.view === "list" ? "list" : "grid",
    stars:
      raw?.stars && typeof raw.stars === "object" ? { ...raw.stars } : {},
  };
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
