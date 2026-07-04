-- 0002_auth_org: phase 2 (auth & org).
--
-- users gains login bookkeeping columns. The OAuth whitelist model is
-- "an account row with that email exists" — deliberately NO separate
-- whitelist flag/table (admins whitelist someone by creating their user).
--
-- audit_events is the append-only governed-action log (phase 10 builds the
-- full audit UX on top). details_json is a JSON string, never secrets.
--
-- Session ids in `sessions` are stored as sha256(token) hex — the raw
-- 256-bit token only ever lives in the signed viberr_session cookie.

ALTER TABLE users ADD COLUMN last_login_at TEXT;
ALTER TABLE users ADD COLUMN created_by TEXT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  actor_user_id TEXT,
  actor_label TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_kind TEXT,
  subject_id TEXT,
  project_slug TEXT,
  task_key TEXT,
  details_json TEXT
);

CREATE INDEX idx_audit_events__occurred_at ON audit_events (occurred_at);
CREATE INDEX idx_audit_events__actor_user_id ON audit_events (actor_user_id);
CREATE INDEX idx_audit_events__action ON audit_events (action);
