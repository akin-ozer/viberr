-- 0014_drop_legacy_sessions.sql
-- The hand-rolled `sessions` table is retired: sessions now live in better-auth's
-- own `session` table (migration 0013). Drop the dead table. No BEGIN/COMMIT —
-- the migration runner wraps each file in its own transaction.

DROP TABLE IF EXISTS sessions;
