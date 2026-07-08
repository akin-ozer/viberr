-- 0003_projections: phase 3 (file store & projections).
--
-- SQLite is NEVER canonical business truth for projects/tasks: these tables
-- are projections materialized from the markdown files under
-- ${VIBERR_DATA_ROOT}/projects/ by app/server/projections/rebuilder.server.ts.
-- content_hash enables incremental short-circuits; provenance records every
-- observation the rebuilder acted on.
--
-- notifications ARE app-owned rows (per-user, orchestrator ruling 9) — the
-- task/project references are soft refs (string keys), cross-project capable.

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

CREATE INDEX idx_project_members__user_id ON project_members (user_id);

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
  owner_user_id TEXT,
  specialist_json TEXT,
  consultants_json TEXT NOT NULL DEFAULT '[]',
  operator_json TEXT,
  branch TEXT,
  -- Effective repo: task-level override, else the project default.
  repo TEXT,
  pr_json TEXT,
  github_json TEXT,
  goal TEXT NOT NULL DEFAULT '',
  packet_json TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  diagnostic_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  source_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  parsed_at TEXT NOT NULL,
  PRIMARY KEY (project_slug, task_key)
);

CREATE INDEX idx_task_projections__stage ON task_projections (project_slug, stage);

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

CREATE INDEX idx_task_events__task ON task_events (project_slug, task_key, position);
CREATE INDEX idx_task_events__occurred_at ON task_events (occurred_at);

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

CREATE INDEX idx_diagnostics__source_path ON diagnostics (source_path);
CREATE INDEX idx_diagnostics__task ON diagnostics (project_slug, task_key);

CREATE TABLE provenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  content_hash TEXT,
  observed_at TEXT NOT NULL,
  -- projected | removed | error | rescan (summary row per full rescan)
  action TEXT NOT NULL,
  details_json TEXT
);

CREATE INDEX idx_provenance__source_path ON provenance (source_path);
CREATE INDEX idx_provenance__observed_at ON provenance (observed_at);

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

CREATE INDEX idx_notifications__user ON notifications (user_id, occurred_at DESC);
CREATE INDEX idx_notifications__user_task ON notifications (user_id, task_key, kind);
