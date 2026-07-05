-- 0011_reviewer_rename: rename the "consultant" engagement to "reviewer".
--
-- The engagement type formerly called "consultant" is now "reviewer" across
-- the whole data model. Two schema objects encode the old name and must move:
--
--   1. agent_runs.kind CHECK (kind IN ('operator','primary','consultant'))
--   2. task_projections.consultants_json  →  reviewers_json
--
-- (1) needs a table rebuild — SQLite cannot ALTER a CHECK constraint in place.
-- agent_runs is the parent of run_log_lines (FK ON DELETE CASCADE), and this
-- migration runs inside a transaction where `PRAGMA foreign_keys` can't be
-- toggled, so a naive DROP of agent_runs would cascade-delete every log line.
-- We therefore back the child rows up into a constraint-free table FIRST, drop
-- the child, rebuild the parent (mapping any historical kind='consultant' →
-- 'reviewer'), then rebuild the child and restore its rows. All row data
-- (runs + log lines) is preserved.

-- --- 1. Back up + detach the child so rebuilding the parent can't cascade. ---
CREATE TABLE _run_log_lines_backup AS SELECT * FROM run_log_lines;
DROP TABLE run_log_lines;

-- --- 2. Rebuild agent_runs with the widened kind CHECK. ---
CREATE TABLE agent_runs_new (
  id TEXT PRIMARY KEY,
  task_key TEXT NOT NULL,
  project_slug TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('operator', 'primary', 'reviewer')),
  backend TEXT NOT NULL CHECK (backend IN ('claude', 'codex', 'simulated')),
  simulated INTEGER NOT NULL DEFAULT 0,
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
  agent_profile_id TEXT
);

INSERT INTO agent_runs_new
  (id, task_key, project_slug, thread_id, role, kind, backend, simulated,
   model, session_id, sdk, state, phase, step, started_at, finished_at, turns,
   input_tokens, cached_input_tokens, output_tokens, total_cost_usd,
   interrupted_by, created_at, updated_at, agent_name, agent_profile_id)
SELECT
   id, task_key, project_slug, thread_id, role,
   CASE WHEN kind = 'consultant' THEN 'reviewer' ELSE kind END,
   backend, simulated, model, session_id, sdk, state, phase, step, started_at,
   finished_at, turns, input_tokens, cached_input_tokens, output_tokens,
   total_cost_usd, interrupted_by, created_at, updated_at, agent_name,
   agent_profile_id
FROM agent_runs;

DROP TABLE agent_runs;
ALTER TABLE agent_runs_new RENAME TO agent_runs;

CREATE INDEX idx_agent_runs__task ON agent_runs (project_slug, task_key);
CREATE INDEX idx_agent_runs__state ON agent_runs (state);
CREATE UNIQUE INDEX idx_agent_runs__thread
  ON agent_runs (project_slug, task_key, thread_id);

-- --- 3. Rebuild run_log_lines (FK → new agent_runs) and restore its rows. ---
CREATE TABLE run_log_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES agent_runs (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  display_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO run_log_lines
  (id, run_id, seq, occurred_at, raw_json, display_json, created_at)
SELECT id, run_id, seq, occurred_at, raw_json, display_json, created_at
FROM _run_log_lines_backup;

DROP TABLE _run_log_lines_backup;

CREATE UNIQUE INDEX idx_run_log_lines__run_seq ON run_log_lines (run_id, seq);

-- --- 4. Rename the projection column consultants_json → reviewers_json. ---
ALTER TABLE task_projections RENAME COLUMN consultants_json TO reviewers_json;
