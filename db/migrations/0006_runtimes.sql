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
  -- Exact operator-routing decision that launched this run. Null for human,
  -- deterministic-resume, operator, historical, and unrelated runs.
  source_intent_id TEXT,
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

-- Durable, visible queue for automatic operator assessments. Task creation and
-- lifecycle triggers enqueue here instead of fanning out unbounded paid runs.
-- Manual "Run operator" actions bypass this dispatcher and remain explicit.
CREATE TABLE operator_dispatches (
  id TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL,
  task_key TEXT NOT NULL,
  -- Canonical task frontmatter.createdAt captured at enqueue. Slug/key can be
  -- reused after deletion; this token cannot authorize a replacement task.
  task_incarnation TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('create', 'transition')),
  -- claiming is a short durable capacity reservation before a newly-created run
  -- is attached. A dispatch is `running` only after it owns that run id.
  state TEXT NOT NULL CHECK (state IN
    ('queued', 'claiming', 'running', 'finished', 'failed', 'cancelled')),
  run_id TEXT,
  estimated_cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  -- Durable scheduler wake for cost-budget or per-task-lease backoff.
  next_attempt_at TEXT
);

CREATE INDEX idx_operator_dispatches__state_created
  ON operator_dispatches (state, created_at);
CREATE INDEX idx_operator_dispatches__task
  ON operator_dispatches (project_slug, task_key, created_at);
CREATE UNIQUE INDEX idx_operator_dispatches__active_task
  ON operator_dispatches (project_slug, task_key, task_incarnation)
  WHERE state IN ('queued', 'claiming', 'running');

-- Latest-wins mailbox for ordinary/manual operator triggers that arrive while
-- another operator owns the task lease. Unlike the automatic dispatcher above,
-- these rows preserve the complete trigger context supplied by a human or a
-- specialist-completion reaction. A process restart may abandon the in-memory
-- lease, but it cannot abandon the instruction waiting behind it.
CREATE TABLE operator_pending_triggers (
  project_slug TEXT NOT NULL,
  task_key TEXT NOT NULL,
  task_incarnation TEXT NOT NULL,
  -- Ordinary human/manual coordination instructions are substitutable and
  -- share one latest-wins slot. A source-linked reaction gets its own slot per
  -- specialist run: neither a human instruction nor a different completion
  -- may erase an unprocessed reaction.
  coalescing_key TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN
    ('create', 'transition', 'agent-reply', 'manual')),
  backend TEXT CHECK (backend IN ('claude', 'codex')),
  autonomy TEXT CHECK (autonomy IN ('supervised', 'full')),
  react_depth INTEGER,
  human_comment TEXT,
  source_run_id TEXT,
  actor_json TEXT,
  data_root TEXT,
  -- Every upsert receives a fresh generation. The drainer deletes only the
  -- generation it launched, so a newer instruction can never be erased by a
  -- slower predecessor finishing its admission step.
  generation TEXT NOT NULL,
  -- Monotonic mailbox order. An upsert moves its slot to the back so drains
  -- preserve arrival order even when multiple writes share a millisecond.
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_slug, task_key, coalescing_key),
  CHECK (
    (source_run_id IS NULL AND coalescing_key = 'ordinary') OR
    (source_run_id IS NOT NULL AND coalescing_key = 'source:' || source_run_id)
  )
);

CREATE INDEX idx_operator_pending_triggers__sequence
  ON operator_pending_triggers (sequence, project_slug, task_key, coalescing_key);

-- A project-directory removal is the canonical commit point for destructive
-- deletion, while SQLite cleanup and the organization-wide deletion audit are
-- convergent side effects. Keep the actor and project label here so boot can
-- finish those side effects truthfully after a process crash. The row also
-- reserves the slug until cleanup is complete.
CREATE TABLE project_deletion_tombstones (
  project_slug TEXT PRIMARY KEY,
  deletion_id TEXT NOT NULL UNIQUE,
  project_name TEXT NOT NULL,
  actor_user_id TEXT,
  actor_label TEXT NOT NULL,
  authority_source TEXT CHECK (authority_source IN ('org_admin_override')),
  created_at TEXT NOT NULL
);

-- Archive/restore commits in project.md before its rebuildable projection and
-- audit fact. Persist the exact operation and original human authority before
-- that canonical write, and leave an intent marker in project.md, so restart
-- can distinguish a committed lifecycle change from a pre-write orphan.
CREATE TABLE project_lifecycle_intents (
  id TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL CHECK (operation IN ('archive', 'restore')),
  expected_archived INTEGER NOT NULL CHECK (expected_archived IN (0, 1)),
  target_archived INTEGER NOT NULL CHECK (target_archived IN (0, 1)),
  project_name TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  authority_source TEXT NOT NULL CHECK (
    authority_source IN ('project_role', 'org_admin_override')
  ),
  stopped_runs INTEGER NOT NULL DEFAULT 0,
  cancelled_dispatches INTEGER NOT NULL DEFAULT 0,
  cancelled_pending_triggers INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CHECK (expected_archived != target_archived),
  CHECK (
    (operation = 'archive' AND target_archived = 1) OR
    (operation = 'restore' AND target_archived = 0)
  )
);

-- Removing an ownership-capable role is a multi-file operation. Each task
-- release is journaled before task.md changes so a retry/boot can independently
-- restore its timeline, projection and audit without releasing a newer owner.
CREATE TABLE ownership_cleanup_intents (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  project_slug TEXT NOT NULL,
  task_key TEXT NOT NULL,
  task_incarnation TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  target_name TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (
    reason IN ('member_removed', 'role_demoted', 'org_user_removed')
  ),
  actor_user_id TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  actor_name_hint TEXT NOT NULL,
  authority_source TEXT CHECK (authority_source IN ('org_admin_override')),
  created_at TEXT NOT NULL,
  UNIQUE (
    project_slug, task_key, task_incarnation, target_user_id, batch_id
  )
);

CREATE INDEX idx_ownership_cleanup_intents__target
  ON ownership_cleanup_intents (project_slug, target_user_id, created_at);

-- Human attribution for the irreversible GitHub merge boundary. The intent is
-- written before PUT and retained until every local merge side effect has
-- converged, so a retry/restart never credits a different accepter for a
-- remote merge that the earlier request performed.
CREATE TABLE github_merge_intents (
  id TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL,
  task_key TEXT NOT NULL,
  task_incarnation TEXT NOT NULL,
  repo TEXT NOT NULL COLLATE NOCASE,
  default_branch TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  authority_source TEXT CHECK (
    authority_source IN ('project_role', 'task_owner', 'org_admin_override')
  ),
  created_at TEXT NOT NULL,
  UNIQUE (
    project_slug, task_key, task_incarnation, repo, pr_number, head_sha
  )
);

CREATE INDEX idx_github_merge_intents__task
  ON github_merge_intents (project_slug, task_key, task_incarnation);

-- Opening a review PR is also a remote/canonical split boundary. Persist the
-- exact repository/base/head/task incarnation and the original author before
-- POST /pulls. `posting` means the request may have reached GitHub; recovery
-- must observe the exact live target before it considers another POST.
-- `observed` pins a returned/live PR number and therefore never posts again.
-- Review transitions stage the lighter handoff BEFORE task.md moves. It is the
-- durable wake-up that closes the process-crash gap before the asynchronous
-- GitHub request can resolve and pin a full remote head.
CREATE TABLE github_pr_open_handoffs (
  id TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL,
  task_key TEXT NOT NULL,
  task_incarnation TEXT NOT NULL,
  review_stage_id TEXT NOT NULL,
  review_revision INTEGER NOT NULL,
  repo TEXT NOT NULL COLLATE NOCASE,
  default_branch TEXT NOT NULL,
  branch TEXT NOT NULL,
  actor_user_id TEXT,
  actor_label TEXT NOT NULL,
  authority_source TEXT NOT NULL CHECK (authority_source IN
    ('project_role', 'org_admin_override', 'operator', 'system_delivery')),
  created_at TEXT NOT NULL,
  UNIQUE (
    project_slug, task_key, task_incarnation, review_stage_id, review_revision, repo,
    default_branch, branch
  )
);

CREATE INDEX idx_github_pr_open_handoffs__task
  ON github_pr_open_handoffs (project_slug, task_key, task_incarnation);

CREATE TABLE github_pr_open_intents (
  id TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL,
  task_key TEXT NOT NULL,
  task_incarnation TEXT NOT NULL,
  repo TEXT NOT NULL COLLATE NOCASE,
  default_branch TEXT NOT NULL,
  branch TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  handoff_id TEXT,
  pr_title TEXT NOT NULL,
  pr_body TEXT NOT NULL,
  actor_user_id TEXT,
  actor_label TEXT NOT NULL,
  authority_source TEXT NOT NULL CHECK (authority_source IN
    ('project_role', 'org_admin_override', 'operator', 'system_delivery')),
  state TEXT NOT NULL CHECK (state IN ('staged', 'posting', 'observed')),
  pr_number INTEGER,
  pr_created INTEGER CHECK (pr_created IN (0, 1)),
  created_at TEXT NOT NULL,
  post_attempted_at TEXT,
  observed_at TEXT,
  CHECK (
    (state IN ('staged', 'posting') AND pr_number IS NULL AND pr_created IS NULL)
    OR
    (state = 'observed' AND pr_number IS NOT NULL AND pr_created IS NOT NULL)
  ),
  UNIQUE (
    project_slug, task_key, task_incarnation, repo, default_branch, branch,
    head_sha
  )
);

CREATE INDEX idx_github_pr_open_intents__task
  ON github_pr_open_intents (project_slug, task_key, task_incarnation);

-- Review → Done is a canonical file transition followed by projection and
-- audit side effects. Persist the accepting actor before the file write so a
-- crash can replay those effects exactly once without crediting the retrier.
CREATE TABLE task_completion_intents (
  id TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL,
  task_key TEXT NOT NULL,
  task_incarnation TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  -- Human acceptance keeps the accepting user id. Full-autonomy operator
  -- acceptance is a first-class non-human fact and therefore stores NULL.
  actor_user_id TEXT,
  actor_label TEXT NOT NULL,
  authority_source TEXT NOT NULL CHECK (
    authority_source IN (
      'project_role',
      'task_owner',
      'org_admin_override',
      'operator_full_autonomy'
    )
  ),
  phase TEXT NOT NULL CHECK (
    phase IN ('accepting_merge', 'merge_pending', 'done')
  ),
  done_stage_id TEXT NOT NULL,
  merged_pr INTEGER NOT NULL CHECK (merged_pr IN (0, 1)),
  repo TEXT COLLATE NOCASE,
  default_branch TEXT,
  pr_number INTEGER,
  head_sha TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (repo IS NULL AND default_branch IS NULL AND pr_number IS NULL AND head_sha IS NULL)
    OR
    (repo IS NOT NULL AND default_branch IS NOT NULL AND pr_number IS NOT NULL AND head_sha IS NOT NULL)
  ),
  CHECK (
    (
      authority_source = 'operator_full_autonomy'
      AND actor_user_id IS NULL
      AND phase = 'done'
      AND merged_pr = 0
      AND repo IS NULL
    )
    OR
    (
      authority_source != 'operator_full_autonomy'
      AND actor_user_id IS NOT NULL
    )
  ),
  UNIQUE (
    project_slug, task_key, task_incarnation, evidence_fingerprint
  )
);

CREATE INDEX idx_task_completion_intents__task
  ON task_completion_intents (project_slug, task_key, task_incarnation);

-- An intelligent operator chooses a concrete routed candidate before the
-- assignment/recommendation/provider effect. Keep that choice until its
-- canonical rationale, projection, and audit have all converged. `pending`
-- never means success: boot/retry promotes it only from objective action
-- evidence, so a failed provider action cannot acquire a false decision fact.
CREATE TABLE operator_routing_intents (
  id TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL,
  task_key TEXT NOT NULL,
  task_incarnation TEXT NOT NULL,
  data_root TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL CHECK (operation IN
    ('assign_primary', 'assign_reviewer', 'prompt_primary', 'prompt_reviewer')),
  purpose TEXT NOT NULL CHECK (purpose IN ('primary', 'reviewer')),
  profile_id TEXT NOT NULL,
  backend TEXT NOT NULL CHECK (backend IN ('claude', 'codex')),
  disposition TEXT NOT NULL CHECK (disposition IN ('selected', 'recommended')),
  reason TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  context_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'action_applied')),
  created_at TEXT NOT NULL,
  action_applied_at TEXT,
  UNIQUE (
    project_slug, task_key, task_incarnation, data_root, operation, purpose,
    profile_id, backend, disposition, reason
  )
);

CREATE INDEX idx_operator_routing_intents__task
  ON operator_routing_intents (project_slug, task_key, task_incarnation);
