-- 0006_runtimes: phase 8 (agent runtimes).
--
-- agent_runs is the queryable PROJECTION of a runtime session (operator /
-- primary specialist / consultant) against a task; run_log_lines is the
-- projected, queryable form of each streamed wire envelope. The RAW NDJSON /
-- JSONL is the canonical truth — persisted append-only under
-- ${VIBERR_DATA_ROOT}/runtimes/<backend>/<sessionOrRunId>.jsonl. These tables
-- are rebuildable from those files; they exist for fast per-task reads and
-- live SSE tailing (run.log-appended).
--
-- Lifecycle (orchestrator ruling 11): queued | running | finished | error |
-- interrupted. Elapsed derives from started_at; tokens/cost come ONLY from
-- real usage envelopes (the mock's tick*42 fabrication is banned).
--
-- `simulated` = 1 marks a run the simulated backend produced (either the
-- default demo engine, OR a real backend that fell back because its CLI was
-- unavailable). The requested `backend` (claude|codex) is kept regardless so
-- the UI renders the correct glyph/SDK label — real-vs-sim is a separate flag.

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  task_key TEXT NOT NULL,
  project_slug TEXT NOT NULL,
  -- Thread id unique WITHIN the task (mock uses "op" | "primary" | "c0").
  -- Drives dropdown order + default selection; UI selection stores this.
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('operator', 'primary', 'consultant')),
  backend TEXT NOT NULL CHECK (backend IN ('claude', 'codex', 'simulated')),
  -- 1 when a real backend fell back to the simulated engine (or the run is
  -- natively simulated); the requested `backend` is preserved for glyphs.
  simulated INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  -- Provider session/thread id (claude session_id / codex thread_id). Null
  -- until the init/thread.started envelope lands.
  session_id TEXT,
  sdk TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN
    ('queued', 'running', 'finished', 'error', 'interrupted')),
  -- Human phrase for the live strip (running/idle) + current tool step.
  phase TEXT,
  step TEXT,
  started_at TEXT,
  finished_at TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- Dollar cost ONLY from real usage envelopes (claude result). Null for
  -- codex (tokens only) and while a run has produced no usage envelope.
  total_cost_usd REAL,
  -- User id of the actor who interrupted the run (SIGINT), else null.
  interrupted_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_agent_runs__task ON agent_runs (project_slug, task_key);
CREATE INDEX idx_agent_runs__state ON agent_runs (state);
CREATE UNIQUE INDEX idx_agent_runs__thread
  ON agent_runs (project_slug, task_key, thread_id);

CREATE TABLE run_log_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES agent_runs (id) ON DELETE CASCADE,
  -- 0-based append order within the run (drives the "since seq" tail query).
  seq INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  -- Exact wire envelope as persisted in the .jsonl (single-line JSON).
  raw_json TEXT NOT NULL,
  -- Projected LogLine ({ t, ev, tag, text, name?, ... }) — what the console
  -- renders in friendly mode; raw_json is what the "{ } raw" toggle shows.
  display_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_run_log_lines__run_seq ON run_log_lines (run_id, seq);
