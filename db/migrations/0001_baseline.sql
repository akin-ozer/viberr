-- 0001_baseline.sql — squashed pre-prod baseline.
--
-- Collapses the original 13-file migration history (0001_app_foundation …
-- 0014_drop_legacy_sessions) into a single schema definition. We are pre-prod:
-- no deployed database needs the incremental chain, so the granular migrations
-- were removed and this file IS the schema. Generated from the end-state of the
-- old chain, so a fresh DB gets exactly what the chain produced — minus the
-- mock scope-violation the old 0005 seeded (schema only, zero demo data).
--
-- Convention (owner ruling, pass 11): while pre-prod, schema changes are
-- squashed INTO this baseline — no incremental migration chain is kept. The
-- runner records this filename in schema_migrations and skips by FILENAME
-- alone, so editing this file reaches FRESH databases only: an existing DB
-- keeps its old schema and every projection write touching a new column
-- throws (there is no drift healer — schema-reconcile.server was removed).
-- That is accepted: the DB is a derived projection, so after pulling a
-- baseline change, wipe the sqlite and re-seed (`npm run seed -- --reset`).
-- Because users/auth live in the same file, a wipe regenerates user ids.
-- Revisit this convention at the first real deployment.

-- ============================ tables ============================

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  idp TEXT NOT NULL DEFAULT 'local',
  avatar_tone TEXT,
  pwreset_required INTEGER NOT NULL DEFAULT 0,
  theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('light', 'dark', 'system')),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, last_login_at TEXT, created_by TEXT, github_handle TEXT);
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
CREATE TABLE projects (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  repo TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  task_prefix TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  stages_json TEXT NOT NULL DEFAULT '[]',
  workflow_json TEXT NOT NULL DEFAULT '[]',
  agent_policy_json TEXT NOT NULL DEFAULT '[]',
  credential_policy_json TEXT,
  guardrails_json TEXT NOT NULL DEFAULT '[]',
  source_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  parsed_at TEXT NOT NULL
);
CREATE TABLE project_members (
  project_slug TEXT NOT NULL REFERENCES projects (slug) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'maintainer', 'contributor', 'viewer')),
  PRIMARY KEY (project_slug, user_id)
);
CREATE TABLE task_projections (
  project_slug TEXT NOT NULL,
  task_key TEXT NOT NULL,
  title TEXT NOT NULL,
  stage TEXT NOT NULL,
  -- DERIVED readiness (readiness-policy.server.ts) — what the UI reads.
  readiness TEXT NOT NULL CHECK (readiness IN
    ('ready', 'input_required', 'inconsistency_risk_detected', 'blocked')),
  -- Raw stored value from the file (NULL when missing/invalid there).
  stored_readiness TEXT,
  waiting TEXT NOT NULL CHECK (waiting IN ('human', 'agent', 'none')),
  urgent INTEGER NOT NULL DEFAULT 0,
  validation TEXT NOT NULL CHECK (validation IN ('healthy', 'changed', 'failing', 'none')),
  -- Derived from the revision-bound review model (acceptanceBlockedReason): NULL
  -- when the current revision is acceptance-ready, a human-readable reason
  -- otherwise. Projected (P11-50) so the review-queue read model doesn't re-read
  -- task files on a loader path to recompute it.
  validation_block_reason TEXT,
  owner_user_id TEXT,
  specialist_json TEXT,
  reviewers_json TEXT NOT NULL DEFAULT '[]',
  operator_json TEXT,
  branch TEXT,
  -- Effective repo: task-level override, else the project default.
  repo TEXT,
  pr_json TEXT,
  github_json TEXT,
  goal TEXT NOT NULL DEFAULT '',
  packet_json TEXT,
  -- Pending operator recommendations on the task file (F7-NOTIF1): projected
  -- as a count so read paths (notifications "Waiting on you", home decisions)
  -- can reconcile decision notifications against LIVE state without file I/O.
  recommendation_count INTEGER NOT NULL DEFAULT 0,
  -- The KINDS of those pending recommendations (JSON string array). Decision
  -- scoping (R8-3) needs the kinds, not just the count: a task OWNER can act on
  -- an `accept_completion` recommendation (owner exception, like a packet) but
  -- NOT on transition/assign/run recommendations (maintainer+). '[]' when none.
  recommendation_kinds TEXT NOT NULL DEFAULT '[]',
  -- Pending/fired scheduled actions (O-3), as a JSON array of the task file's
  -- `schedules`. The server-side schedule runner queries this to find due
  -- entries without reading every task file. '[]' when none.
  schedules_json TEXT NOT NULL DEFAULT '[]',
  event_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  diagnostic_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  source_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  parsed_at TEXT NOT NULL, board_rank REAL,
  PRIMARY KEY (project_slug, task_key)
);
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_slug TEXT NOT NULL,
  task_key TEXT NOT NULL,
  -- 0 = newest (file order, newest-first). Replaced wholesale per task.
  position INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'operator', 'system')),
  -- user id / "codex/developer" / "operator" / system id.
  actor_ref TEXT NOT NULL,
  -- Denormalized render-shape snapshot (survives member removal).
  actor_json TEXT NOT NULL,
  title TEXT,
  text TEXT NOT NULL,
  to_agent INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT
);
CREATE TABLE diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_slug TEXT,
  task_key TEXT,
  source_path TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  code TEXT NOT NULL,
  path TEXT,
  message TEXT NOT NULL,
  hard_stop INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL
);
CREATE TABLE provenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  content_hash TEXT,
  observed_at TEXT NOT NULL,
  -- projected | removed | error | rescan (summary row per full rescan)
  action TEXT NOT NULL,
  details_json TEXT
);
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('packet', 'approval', 'mention', 'quality', 'policy')),
  -- packet kind only: input | blocked (card tint + pill).
  ptype TEXT CHECK (ptype IN ('input', 'blocked')),
  title TEXT,
  text TEXT NOT NULL,
  actor_json TEXT,
  project_slug TEXT,
  task_key TEXT,
  occurred_at TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE user_prefs (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE github_pats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  token_suffix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_validated_at TEXT,
  validation_json TEXT
);
CREATE TABLE project_github_credentials (
  project_slug TEXT PRIMARY KEY,
  pat_id TEXT NOT NULL REFERENCES github_pats (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE scope_violations (
  id TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL,
  task_key TEXT,
  scope TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE TABLE github_connections (
  id TEXT PRIMARY KEY,                -- slugify(owner)
  owner TEXT NOT NULL UNIQUE,
  pat_id TEXT NOT NULL REFERENCES github_pats (id) ON DELETE CASCADE,
  is_default INTEGER NOT NULL DEFAULT 0,
  repos_count INTEGER,                -- from GitHub at validation time
  expires_at TEXT,                    -- token expiry (ISO) when advertised
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE google_domain_allowlist (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,        -- normalized "@company.dev"
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  created_at TEXT NOT NULL
);
CREATE TABLE org_knowledge_bases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dir TEXT NOT NULL UNIQUE,           -- folder under ${DATA_ROOT}/kb/
  refresh TEXT NOT NULL DEFAULT 'on change'
    CHECK (refresh IN ('manual', 'on change', 'nightly')),
  last_indexed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE org_mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,          -- slug
  transport TEXT NOT NULL CHECK (transport IN ('HTTP', 'stdio')),
  target TEXT NOT NULL,               -- endpoint (HTTP) or command (stdio)
  cred_ref TEXT,                      -- optional secret:// reference only
  tools_count INTEGER,                -- discovered tool count (NULL unknown)
  up INTEGER,                         -- 1 up · 0 down · NULL never probed
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE org_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,          -- slug; folder ${DATA_ROOT}/skills/<name>/
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE "agent_runs" (
  id TEXT PRIMARY KEY,
  task_key TEXT NOT NULL,
  project_slug TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('operator', 'primary', 'reviewer')),
  backend TEXT NOT NULL CHECK (backend IN ('claude', 'codex')),
  model TEXT NOT NULL,
  session_id TEXT,
  sdk TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN
    ('queued', 'running', 'finished', 'error', 'interrupted')),
  phase TEXT,
  step TEXT,
  started_at TEXT,
  finished_at TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL,
  interrupted_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  agent_name TEXT,
  agent_profile_id TEXT NOT NULL
);
CREATE TABLE run_log_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES agent_runs (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  display_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "githubHandle" text);
CREATE TABLE "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);
CREATE TABLE "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
CREATE TABLE "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

-- ============================ indexes ===========================

CREATE UNIQUE INDEX idx_users__email ON users (email);
CREATE INDEX idx_audit_events__occurred_at ON audit_events (occurred_at);
CREATE INDEX idx_audit_events__actor_user_id ON audit_events (actor_user_id);
CREATE INDEX idx_audit_events__action ON audit_events (action);
CREATE INDEX idx_project_members__user_id ON project_members (user_id);
CREATE INDEX idx_task_projections__stage ON task_projections (project_slug, stage);
CREATE INDEX idx_task_events__task ON task_events (project_slug, task_key, position);
CREATE INDEX idx_task_events__occurred_at ON task_events (occurred_at);
CREATE INDEX idx_diagnostics__source_path ON diagnostics (source_path);
CREATE INDEX idx_diagnostics__task ON diagnostics (project_slug, task_key);
CREATE INDEX idx_provenance__source_path ON provenance (source_path);
CREATE INDEX idx_provenance__observed_at ON provenance (observed_at);
CREATE INDEX idx_notifications__user ON notifications (user_id, occurred_at DESC);
CREATE INDEX idx_notifications__user_task ON notifications (user_id, task_key, kind);
CREATE INDEX idx_github_pats__user_id ON github_pats (user_id);
CREATE INDEX idx_scope_violations__project_status
  ON scope_violations (project_slug, status);
CREATE INDEX idx_scope_violations__task
  ON scope_violations (project_slug, task_key);
CREATE UNIQUE INDEX idx_scope_violations__open_unique
  ON scope_violations (project_slug, scope, coalesce(task_key, ''))
  WHERE status = 'open';
CREATE INDEX idx_github_connections__default
  ON github_connections (is_default);
CREATE INDEX idx_agent_runs__task ON agent_runs (project_slug, task_key);
CREATE INDEX idx_agent_runs__state ON agent_runs (state);
CREATE UNIQUE INDEX idx_agent_runs__thread
  ON agent_runs (project_slug, task_key, thread_id);
-- F10-05: enforce ONE active delivering ("primary") run per task at the DB
-- layer. The run service preflight-checks for a live delivering run before its
-- expensive async setup (repo clone, adapter start), then inserts the run only
-- afterward — two racing dispatches can both pass that check during their
-- awaits. This partial unique index makes the second insert fail atomically;
-- startRun translates the constraint violation into a 409 conflict. Only
-- queued/running PRIMARY runs are constrained: operator/reviewer runs and any
-- terminal state (finished/error/interrupted) are unconstrained.
CREATE UNIQUE INDEX idx_agent_runs__one_delivering
  ON agent_runs (project_slug, task_key)
  WHERE kind = 'primary' AND state IN ('queued', 'running');
CREATE UNIQUE INDEX idx_run_log_lines__run_seq ON run_log_lines (run_id, seq);
CREATE INDEX "session_userId_idx" on "session" ("userId");
CREATE INDEX "account_userId_idx" on "account" ("userId");
CREATE INDEX "verification_identifier_idx" on "verification" ("identifier");

-- Staged agent outcomes (P11-28): the Claude `report_outcome` toolkit envelope
-- is staged mid-run, keyed by the run's outcomeKey, and consumed when the run's
-- completion is recorded. Persisted (not just in-process) so a server restart
-- between the run finishing and its completion callback firing doesn't lose the
-- structured verdict/question — boot recovery reads it here instead of falling
-- back to the prose regex. Rows are deleted on consumption; a bounded age prune
-- clears orphans from runs that never completed.
CREATE TABLE staged_outcomes (
  outcome_key TEXT PRIMARY KEY,
  outcome_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
