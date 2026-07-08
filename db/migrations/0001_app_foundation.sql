-- 0001_app_foundation: users + sessions (phase 1).
-- schema_migrations bookkeeping is owned by the migration runner, not by
-- migration files. Timestamps are UTC ISO 8601 strings. Booleans are 0/1.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  password_hash TEXT,
  idp TEXT NOT NULL DEFAULT 'local',
  avatar_tone TEXT,
  pwreset_required INTEGER NOT NULL DEFAULT 0,
  theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('light', 'dark', 'system')),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_users__email ON users (email);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);

CREATE INDEX idx_sessions__user_id ON sessions (user_id);
CREATE INDEX idx_sessions__expires_at ON sessions (expires_at);
