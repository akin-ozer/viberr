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
  source_intent_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  agent_name TEXT,
  agent_profile_id TEXT,
  run_purpose TEXT CHECK (run_purpose IN
    ('implementation', 'governance_review', 'conversation')),
  review_evidence_fingerprint TEXT,
  review_head_sha TEXT,
  -- A specialist completion may start one follow-up operator reaction. This
  -- durable source identity closes the crash-after-start replay window.
  completion_source_run_id TEXT,
  -- Canonical task lifecycle observed before provider launch. A deleted and
  -- recreated slug/key must never inherit completion/operator effects.
  task_incarnation TEXT,
  -- Automatic-dispatch claim which owns this operator run, persisted before
  -- provider launch so boot can distinguish an unlaunched claim from one
  -- whose governed effects may already have executed.
  operator_dispatch_id TEXT,
  -- Snapshot needed to replay specialist completion after process loss. Phase
  -- is monotonic: 0 pending, 1 reply, 2 delivery, 3 evidence, 4 verdict,
  -- 5 reaction, 6 complete.
  completion_context_json TEXT,
  completion_phase INTEGER NOT NULL DEFAULT 0
    CHECK (completion_phase BETWEEN 0 AND 6),
  -- Operator plans/tool effects are not complete merely because provider
  -- output is terminal. Boot recovery escalates unresolved pending effects.
  operator_effect_state TEXT
    CHECK (operator_effect_state IN ('pending', 'applied', 'recovery'))
);

INSERT INTO agent_runs_new
  (id, task_key, project_slug, thread_id, role, kind, backend, simulated,
   model, session_id, sdk, state, phase, step, started_at, finished_at, turns,
   input_tokens, cached_input_tokens, output_tokens, total_cost_usd,
   interrupted_by, source_intent_id, created_at, updated_at, agent_name, agent_profile_id,
   run_purpose, review_evidence_fingerprint, review_head_sha,
   completion_source_run_id, task_incarnation, operator_dispatch_id,
   completion_context_json, completion_phase,
   operator_effect_state)
SELECT
   id, task_key, project_slug, thread_id, role,
   CASE WHEN kind = 'consultant' THEN 'reviewer' ELSE kind END,
   backend, simulated, model, session_id, sdk, state, phase, step, started_at,
   finished_at, turns, input_tokens, cached_input_tokens, output_tokens,
   total_cost_usd, interrupted_by, source_intent_id, created_at, updated_at, agent_name,
   agent_profile_id,
   CASE
     WHEN kind = 'primary' THEN 'implementation'
     WHEN kind = 'consultant' THEN 'governance_review'
     ELSE NULL
   END,
   NULL,
   NULL,
   NULL,
   NULL,
   NULL,
   NULL,
   0,
   NULL
FROM agent_runs;

DROP TABLE agent_runs;
ALTER TABLE agent_runs_new RENAME TO agent_runs;

CREATE INDEX idx_agent_runs__task ON agent_runs (project_slug, task_key);
CREATE INDEX idx_agent_runs__state ON agent_runs (state);
CREATE UNIQUE INDEX idx_agent_runs__thread
  ON agent_runs (project_slug, task_key, thread_id);
CREATE UNIQUE INDEX idx_agent_runs__completion_source
  ON agent_runs (completion_source_run_id)
  WHERE kind = 'operator' AND completion_source_run_id IS NOT NULL;
CREATE UNIQUE INDEX idx_agent_runs__operator_dispatch
  ON agent_runs (operator_dispatch_id)
  WHERE kind = 'operator' AND operator_dispatch_id IS NOT NULL;
CREATE INDEX idx_agent_runs__source_intent
  ON agent_runs (source_intent_id)
  WHERE source_intent_id IS NOT NULL;

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
