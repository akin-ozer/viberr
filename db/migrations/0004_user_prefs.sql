-- Phase 4: per-user UI preferences (Home pins + grid/list view; Phase 9's
-- profile prefs land in the same table). Key-value with JSON payloads —
-- personal UI state, never governed business truth.
CREATE TABLE user_prefs (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
