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
  required_reviewers_json TEXT NOT NULL DEFAULT '[]',
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
  -- Ruling 225: `schedule` is derived by the projector, never authored in a
  -- task file. It belongs here anyway, because this CHECK is what the store
  -- would have used to refuse the derived value — a refusal that surfaces as
  -- "projection rebuild failed" and a stale row, which is precisely the
  -- silent-staleness failure boot.server.ts probes this column for.
  waiting TEXT NOT NULL CHECK (waiting IN ('human', 'agent', 'none', 'schedule')),
  urgent INTEGER NOT NULL DEFAULT 0,
  -- Pass-25 task metadata: graded priority (urgent is derived into `urgent`
  -- above for the existing board highlight), triage labels (JSON array), and an
  -- optional ISO `YYYY-MM-DD` due date.
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  labels_json TEXT NOT NULL DEFAULT '[]',
  due_date TEXT,
  -- Ruling 131 (pass 34): the task file's `blockedBy` list, verbatim (JSON
  -- array of canonical spellings). Projected so the release engine can select
  -- held dependents and walk cycles without reading task files; the entries'
  -- STATES are resolved at read time and never stored. Existing roots take the
  -- additive `ALTER TABLE task_projections ADD COLUMN blocked_by_json TEXT NOT
  -- NULL DEFAULT '[]'` that the boot drift WARN prescribes (never a re-baseline:
  -- this file also holds users, sessions and sealed PATs).
  blocked_by_json TEXT NOT NULL DEFAULT '[]',
  -- R14-3: the terminal disposition for abandoned work. Projected because every
  -- board/queue/inbox read model reads this table and each of them has to hide
  -- archived tasks without re-reading task files on a loader path.
  archived INTEGER NOT NULL DEFAULT 0,
  -- F21-1: this list IS VALIDATION_VALUES (task-file.schema.ts) — the rebuilder
  -- binds `deriveValidation(fm)` straight in, so a value the enum admits and the
  -- CHECK does not aborts the whole task rebuild ("projection rebuild failed")
  -- and leaves the row stale. `bypassed` (N20-14 force-accept) was missed here,
  -- which bricked reprojection of a force-accepted task that also had a
  -- `workRevision` — without one `deriveValidation` returns `none` first, which
  -- is what hid it. Widen this list whenever the enum grows.
  validation TEXT NOT NULL CHECK (validation IN
    ('healthy', 'changed', 'failing', 'none', 'bypassed')),
  -- Derived from the revision-bound review model (acceptanceBlockedReason): NULL
  -- when the current revision is acceptance-ready, a human-readable reason
  -- otherwise. Projected (P11-50) so the review-queue read model doesn't re-read
  -- task files on a loader path to recompute it.
  validation_block_reason TEXT,
  -- N20-14 (pass20 §5c): the durable acceptance-override fact. 'forced' when a
  -- human force-accepted this task past the verdict gate, NULL otherwise.
  -- Projected so the hero/card display arm (C-VOCAB) reads it without re-reading
  -- the task file, exactly like `validation` above.
  acceptance TEXT CHECK (acceptance IN ('forced')),
  -- D4 (pass20 C-CONTINUITY): runtime-continuity health as a TASK-LEVEL fact.
  -- 'degraded' when this task's timeline carries a `continuity` event — a resumed
  -- provider session whose transcript was gone, so the agent re-anchored on
  -- `task.md` and continued fresh (run-service.server.ts `noteContinuityReset`).
  -- NULL otherwise. The Continuity Recovery panel (continuity-recovery.tsx)
  -- derives the same state client-side from the same event; projecting it here is
  -- what lets the state mean the same thing on the board card, the board filter
  -- and the review row (UX spec §State Semantics: "Every state must mean the same
  -- thing everywhere it appears"; §Additional Patterns names a degraded-continuity
  -- default filter). Persistent by design — the record survives in the timeline,
  -- so the base-interface cue does too.
  continuity TEXT CHECK (continuity IN ('degraded')),
  owner_user_id TEXT,
  specialist_json TEXT,
  reviewers_json TEXT NOT NULL DEFAULT '[]',
  operator_json TEXT,
  branch TEXT,
  -- The project's repo, denormalized onto every task row so the task-detail
  -- GitHub links (task-side-panels) resolve without joining projects. P13-D-5
  -- deleted the task-level OVERRIDE this once documented: the rebuilder now
  -- writes `project.repo ?? null` unconditionally and nothing else may set it.
  repo TEXT,
  pr_json TEXT,
  github_json TEXT,
  -- Ruling 53 + ruling 88: the DELIVERED revision's head sha
  -- (`workRevision.headSha`), NULL before delivery. The board's acceptance
  -- ceremony has to DISCLOSE what it accepts, and its echo of that disclosure is
  -- what the server compares against the live task before it merges anything
  -- (acceptance-disclosure.ts). A board card is rendered from this table alone,
  -- so without the column the ceremony disclosed "No delivered revision
  -- recorded." on every task and the server refused the resulting `"none"` echo
  -- as stale — a board drop onto the terminal stage could never accept DELIVERED
  -- work. Projected rather than re-read per card because this is the hottest
  -- loader path in the app (see board-query.server.ts). The sha only, never the
  -- revision object: nothing here needs its id, branch or author, and a column
  -- carries what it is read for.
  work_revision_sha TEXT,
  goal TEXT NOT NULL DEFAULT '',
  packet_json TEXT,
  -- Pending operator recommendations on the task file (F7-NOTIF1): projected
  -- as a count so read paths (notifications "Waiting on you", home decisions)
  -- can reconcile decision notifications against LIVE state without file I/O.
  recommendation_count INTEGER NOT NULL DEFAULT 0,
  -- F37-71: the DISTINCT kinds of those pending recommendations, sorted and
  -- comma-joined ('accept_completion', 'accept_completion,transition', …).
  -- The count alone cannot say whether a task's only pending decision is an
  -- ACCEPTANCE, and UX19-3's gate applies to acceptances: live on SHOP-12 a
  -- conflicting PR was correctly dropped from the inbox as `kind: acceptance`
  -- and walked straight back in as `kind: recommendation` the moment the
  -- operator filed a card for the same acceptance.
  recommendation_kinds TEXT NOT NULL DEFAULT '',
  -- Pending/fired scheduled actions (O-3), as a JSON array of the task file's
  -- `schedules`. The server-side schedule runner queries this to find due
  -- entries without reading every task file. '[]' when none.
  schedules_json TEXT NOT NULL DEFAULT '[]',
  event_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  diagnostic_count INTEGER NOT NULL DEFAULT 0,
  -- Chained-goal back-reference (ruling 99): the goal this task is one link of,
  -- and its 1-based link position, from task.md `goalRef`. NULL for the vast
  -- majority of tasks. Projected so the board card chip and the goal-advance
  -- hook resolve the goal without reading task files on a loader path.
  goal_id TEXT,
  goal_link_index INTEGER,
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
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'operator', 'controller', 'system')),
  -- user id / "codex/developer" / "operator" / system id.
  actor_ref TEXT NOT NULL,
  -- Denormalized render-shape snapshot (survives member removal).
  actor_json TEXT NOT NULL,
  title TEXT,
  text TEXT NOT NULL,
  to_agent INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT,
  -- Names of files the event's run saved into the task's attachments/ dir
  -- (JSON array). The directory stays the truth; these attribute producers.
  attachments_json TEXT
);
-- Chained-goal projections (ruling 99): derived rows over the canonical
-- `projects/<slug>/goals/<id>.md` files, rebuilt by the same rebuilder that
-- owns task/project rows. Link statuses here are the RECONCILED view (the
-- goal file's stored status is a claim; the rebuilder derives each linked
-- task's real state from task_projections).
CREATE TABLE goal_projections (
  project_slug TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('active', 'paused', 'attention', 'completed', 'cancelled')),
  created_by TEXT NOT NULL,
  created_by_label TEXT NOT NULL,
  on_failure TEXT NOT NULL CHECK (on_failure IN ('pause', 'continue')),
  links_json TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '',
  -- 1-based index of the link currently being worked (first non-terminal
  -- link), NULL when every link is settled.
  current_index INTEGER,
  links_total INTEGER NOT NULL DEFAULT 0,
  links_done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  source_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  parsed_at TEXT NOT NULL,
  PRIMARY KEY (project_slug, goal_id)
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
  -- 'controller' (ruling 99): a controller conversation reply or a chained-goal
  -- progress note addressed to the conversation owner / goal creator.
  -- 'dependency' (ruling 131): the work a task waited on landed (or can never).
  -- 'ownership' (ruling 140): the reader's task-owner seat changed hands.
  -- This list IS NOTIFICATION_KINDS in app/shared/mapping/notification.server.ts,
  -- and the boot integrity check compares the live CHECK against it, because a root
  -- that predates a kind would otherwise reject every INSERT of it silently.
  kind TEXT NOT NULL CHECK (kind IN ('packet', 'approval', 'mention', 'quality', 'policy', 'controller', 'dependency', 'ownership')),
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
-- Instance-wide admin settings (single deployment). Key-value, JSON-encoded, no
-- FK — these are process/instance config an org admin edits (e.g. the run
-- concurrency cap), not per-user or per-project data. NEVER store a secret here:
-- a sealed secret belongs in a dedicated column so key rotation can reseal it
-- (see s3_audit_config + SEALED_STORES).
CREATE TABLE instance_settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- The S3 audit-export target (at most one; id is always 'default'). The secret
-- access key is SEALED in its own column so key rotation covers it (registered
-- in SEALED_STORES). The rest of the config is non-secret.
CREATE TABLE s3_audit_config (
  id            TEXT PRIMARY KEY DEFAULT 'default',
  bucket        TEXT NOT NULL,
  region        TEXT NOT NULL,
  prefix        TEXT NOT NULL DEFAULT '',
  endpoint      TEXT NOT NULL DEFAULT '',
  access_key_id TEXT NOT NULL,
  secret_box    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
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
-- Ruling 127: a person's connected agent backends. One row per (user, backend); connecting a new
-- method REPLACES the previous row. `kind = 'login'` rows carry NO secret: the vendor binary
-- holds the credential in the user's runtime home. API keys / access tokens are sealed boxes
-- (registered in SEALED_STORES so key rotation reaches them).
CREATE TABLE user_backend_credentials (
  id TEXT PRIMARY KEY,                       -- newId("ubc")
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  backend TEXT NOT NULL CHECK (backend IN ('claude', 'codex')),
  kind TEXT NOT NULL CHECK (kind IN ('login', 'api_key', 'access_token')),
  -- login: which vendor flow signed in ('claudeai' | 'console' | 'device'); NULL otherwise
  method TEXT,
  secret_box TEXT,                           -- sealSecret box; NULL for login
  secret_suffix TEXT,                        -- last 4 chars for display; NULL for login
  -- non-secret facts the vendor reported (JSON object): e.g. {"authMethod":"claudeai"} from
  -- `claude auth status`, or {"status":"Logged in using ChatGPT"} from `codex login status`.
  detail_json TEXT NOT NULL DEFAULT '{}',
  verified_at TEXT,                          -- last time the provider itself accepted it
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, backend)
);
-- U33-2 (pass 33): the last repository-access probe per project. App-owned
-- OBSERVATION, not a projection of project.md, so a rebuild must not clear it —
-- which is why it is its own table rather than a `projects` column. It exists so
-- the board and the home card can say "this project's repository is
-- unreachable" without calling GitHub on a hot render path: every writer is a
-- place that already had the answer in hand (the GitHub page's cached probe,
-- project creation's own probe).
CREATE TABLE project_github_health (
  project_slug TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  checked_at TEXT NOT NULL
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
-- OAuth sign-in providers configured IN THE APP (R19-16). The deployment env
-- (GITHUB_OAUTH_* / GOOGLE_OAUTH_*) remains a bootstrap default; a row here
-- OVERRIDES it, so SSO can be set up or rotated without a redeploy. At most one
-- row per provider. `client_secret` is a sealed secret box, never plaintext.
-- `verified_at` is the last time the PROVIDER ITSELF accepted the credential
-- pair — `enabled` cannot be set without it.
CREATE TABLE oauth_providers (
  provider TEXT PRIMARY KEY CHECK (provider IN ('github', 'google')),
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,        -- sealSecret box
  enabled INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,                   -- ISO; null = never proved
  verified_detail TEXT,               -- what the provider answered
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
  -- R19-18: set while a first-run install runs in the BACKGROUND for this
  -- server (ISO). A command that is still fetching its dependencies is not a
  -- broken one, so the row shows "installing" rather than a red dot, and the
  -- warm-up writes the real verdict when it settles.
  warming_since TEXT,
  -- R19-17: why the last probe failed, in the command's own words (scrubbed).
  -- NULL when the server is up or was never probed — a stale reason next to a
  -- green dot would be worse than none, so the up path CLEARS it.
  last_error TEXT,
  -- R20-4 (N20-2): when this server first answered a probe successfully (ISO).
  -- NULL means it has never worked here — which is what makes a timeout on an
  -- npx/uvx-style command a plausible first-run INSTALL rather than a broken
  -- server. Stamped idempotently (COALESCE), never cleared.
  first_success_at TEXT,
  -- R20-4 (N20-2): how many times the HEURISTIC (stderr said nothing install-y,
  -- but the command is an installer and the row has never succeeded) armed a
  -- background warm-up. Capped at 1 so a command that times out on EVERY probe
  -- still settles to `unreachable` instead of re-downloading forever — the
  -- terminal condition R19-17c's honesty depends on.
  heuristic_warmups INTEGER NOT NULL DEFAULT 0,
  -- Ruling 176: the tools an admin marked as WRITE tools, a JSON array of
  -- { name, gate: "repo-write" }, denied on runs whose repo-write grant is
  -- withheld. NULL until an admin first saves the editor's "Write tools"
  -- section; '[]' is a reviewed "none". The editor pre-ticks the discovery
  -- suggestion only while it is NULL.
  tool_policy_json TEXT,
  -- Ruling 176: the tool names the last successful probe listed (a JSON array),
  -- offered in the editor. An observation like tools_count, but kept across a
  -- failed probe: a stale list is still the right thing to mark from.
  tool_names_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- R20-3 (F20-4): a model the PROVIDER refused for this deployment's account.
-- Org-level (unscoped, like org_mcp_servers): the credential is a deployment
-- fact, not a project one. Written only from a REAL run's failure whose
-- redacted text matches MODEL_UNSUPPORTED_RE; cleared by a real run's success.
-- Never written by a synthetic probe (ruling 19). Presence of a row =
-- unavailable; absence = unknown-but-offered (never "proven available", the
-- claim we cannot make).
CREATE TABLE model_availability (
  backend    TEXT NOT NULL CHECK (backend IN ('claude','codex')),
  model      TEXT NOT NULL,
  reason     TEXT NOT NULL,        -- the provider's own redacted sentence
  marked_at  TEXT NOT NULL,
  run_id     TEXT,                 -- the run that proved it
  PRIMARY KEY (backend, model)
);
CREATE TABLE org_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,          -- slug; folder ${DATA_ROOT}/skills/<name>/
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- ---------------------------------------------------------------------------
-- Controller conversations (ruling 99). App-owned collaboration state, the
-- same family as notifications/sessions/audit (file-formats §5) — nothing
-- hand-edits a transcript, so it does not ride the file-canonical machinery.
-- The deep working record (tool calls, token usage) lives on the conversation
-- turns' agent_runs rows + raw NDJSON, exactly like every other run.
CREATE TABLE controller_conversations (
  id TEXT PRIMARY KEY,
  -- The asking user — the ONLY authority every action in this conversation is
  -- evaluated against, and (with org admins) the only reader.
  user_id TEXT NOT NULL,
  user_label TEXT NOT NULL,
  -- The conversation's SCOPE (ruling 121): NULL/NULL = instance; a slug alone
  -- binds the conversation to that project's board context (the project-role
  -- axis); slug + task_key anchors it to ONE task, whose canonical file the
  -- server reads into every turn. A task without a project is not a scope.
  project_slug TEXT,
  task_key TEXT,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_at TEXT,
  CHECK (task_key IS NULL OR project_slug IS NOT NULL)
);
CREATE INDEX idx_controller_conversations__user
  ON controller_conversations (user_id, last_message_at DESC);
-- The dock (ruling 121) lists ONE scope at a time: this user's threads for one
-- board or one task, newest first.
CREATE INDEX idx_controller_conversations__scope
  ON controller_conversations (user_id, project_slug, task_key, last_message_at DESC);
CREATE TABLE controller_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL
    REFERENCES controller_conversations (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  author TEXT NOT NULL CHECK (author IN ('user', 'controller')),
  -- The human author's id for 'user' rows; NULL on controller rows.
  user_id TEXT,
  text TEXT NOT NULL,
  -- The agent_runs row that produced a controller reply (its console is the
  -- deep record); NULL on user rows and on refusal notes written run-less.
  run_id TEXT,
  -- Ruling 121: the page the person was looking at when they sent a user
  -- message (pathname + query, e.g. /projects/viberr/board?filter=waiting) so
  -- a transcript read back later still says where the ask came from. NULL on
  -- controller rows and on messages sent before the dock existed.
  surface TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);
CREATE TABLE "agent_runs" (
  id TEXT PRIMARY KEY,
  task_key TEXT NOT NULL,
  project_slug TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  -- NOT a role taxonomy — the DELIVERY axis, and the three values no longer
  -- mean what their names suggest. 'operator' is the operator runtime's own
  -- run; every other run is a generic agent engagement, tagged 'primary' when
  -- that engagement DELIVERS and 'reviewer' when it merely supports
  -- (`kind: delivers ? "primary" : "reviewer"`, specialist-run.server.ts) —
  -- so a non-delivering developer is stored as 'reviewer'. The engagement's
  -- real role rides `role` instead; run rows stopped carrying the
  -- "Primary specialist"/"Reviewer" literals in the shadow-kind cleanup.
  -- idx_agent_runs__one_delivering below is keyed on this, and reads correctly
  -- BECAUSE 'primary' means delivering.
  -- 'controller' (ruling 99): a controller conversation turn. Its rows carry
  -- project_slug = '' (instance machinery — never a member-visible task scope)
  -- and task_key = the conversation id, so every task-scoped query, which
  -- filters by real (project_slug, task_key) equality, never matches them.
  kind TEXT NOT NULL CHECK (kind IN ('operator', 'primary', 'reviewer', 'controller')),
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
  -- The PERSON who interrupted the run (a users.id), or NULL. Never a
  -- pseudo-actor: a restart is a reason, not a person (pass 35 U35-7).
  interrupted_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  agent_name TEXT,
  -- F35-1: 1 once a PROVIDER usage figure landed on the row (a Claude result
  -- envelope, a Codex turn.completed). While 0 the token columns hold the
  -- Claude adapter's live ESTIMATE of the output (from the streamed text; the
  -- SDK's per-envelope output_tokens is a placeholder) or nothing at all
  -- (Codex before its turn ends), so the Live run panel prints the figure as
  -- an estimate and Insights leaves the row out of its token totals.
  usage_final INTEGER NOT NULL DEFAULT 0,
  agent_profile_id TEXT NOT NULL,
  -- Staging key for a Claude report_outcome envelope (staged_outcomes). Persisted
  -- so boot recovery (recoverUnreactedAgentRuns) can look the staged outcome up
  -- after a restart — the in-process completion callback that held this key is
  -- gone, so without it a recovered Claude verdict falls back to the prose regex.
  outcome_key TEXT,
  -- Dispatch-completion contract (pass 32, C02-R11): who dispatched this run.
  -- Persisted for the same reason as outcome_key — boot recovery must re-supply
  -- them so a run recovered after a restart still cc-tags its dispatcher and
  -- always re-invokes the operator. NULL on runs nobody dispatched by hand.
  dispatched_by_name TEXT,
  dispatched_by_user_id TEXT,
  -- Ruling 248 (pass 37, F37-77): 1 when this run's workspace checkout could
  -- NOT be provisioned, so the run executed with no working tree. A run that
  -- could not read the work judges nothing: the verdict path (envelope AND the
  -- prose fallback) is closed for these rows. Persisted rather than held in the
  -- completion closure so a run recovered after a restart keeps the fact --
  -- the closure dies with the process, and a recovered no-checkout reviewer
  -- would otherwise have its report re-classified into a verdict.
  no_checkout INTEGER NOT NULL DEFAULT 0,
  -- Ruling 127: the CREDENTIAL PRINCIPAL — whose connected backend accounts this
  -- run billed. Task runs (operator, specialist, resume, scheduled, boot recovery,
  -- retry) carry the task owner; controller turns carry the asker. NULL only on a
  -- run refused before any credential was looked up (an unowned task, or one whose
  -- owner account is gone or disabled): a run that ever spawned a process has a
  -- non-null principal. A run refused because the owner has not connected THAT
  -- backend still records the owner (refusedPrincipalUserId). Also the key the
  -- transcript lookup uses — a run's session lives in that person's runtime home.
  credential_user_id TEXT,
  -- Pass 35 U35-7 (ruling 158 addendum): WHY an `interrupted` run stopped when
  -- no person did it. 'restart' = boot recovery (finalizeOrphanedRuns, and the
  -- operator drive's own orphan sweep) found the row still queued/running with
  -- no process behind it. A human interrupt leaves this NULL and stamps
  -- interrupted_by instead. Readers: run-projection (the pill and footer say
  -- "interrupted by a restart") and Insights (a restart-interrupted run is not
  -- an error; one that never started is out of the completion denominator).
  interrupted_reason TEXT CHECK (interrupted_reason IN ('restart'))
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
-- ---------------------------------------------------------------------------
-- better-auth core tables (better-auth 1.6.25), hand-inlined.
--
-- PROVENANCE: these four statements are `npx @better-auth/cli@1.6.25 generate`
-- output for app/lib/auth.server.ts's `buildAuthOptions`, pasted verbatim —
-- hence the lower-case `not null` / quoted identifiers, which match nothing
-- else in this file. The CLI is deliberately NOT a dependency: it is a codegen
-- tool run by hand at version-bump time, and adding it would put better-auth's
-- whole plugin surface in the production install for four DDL statements a
-- year.
--
-- REFRESH RECIPE, after bumping the better-auth version in package.json:
--   1. npx @better-auth/cli@<new-version> generate \
--        --config app/lib/auth.server.ts --output /tmp/ba-schema.sql -y
--      (check `generate --help` first — the flag names have moved across
--      better-auth majors; the shape is always config-in, SQL-out.)
--   2. Diff /tmp/ba-schema.sql against this block. Column ADDITIONS and NEW
--      tables (a plugin's) get pasted in; better-auth never renames a core
--      column without a major, so a rename means read its changelog first.
--   3. `githubHandle` on "user" is OURS, not better-auth's — it comes from the
--      `user.additionalFields` in buildAuthOptions and the GitHub provider's
--      `mapProfileToUser`. Keep it through any regeneration; the CLI emits it
--      only if it reads the config successfully.
--   4. Re-baseline (`npm run seed -- --reset`) — see the convention note at the
--      top of this file. There is no ALTER path.
-- The longer version, with why the CLI is not vendored, is in
-- planning/discovery-2026-08-04/TESTING-INFRA.md ("better-auth schema refresh").
CREATE TABLE "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "githubHandle" text);
CREATE TABLE "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);
CREATE TABLE "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
-- KEEP: `verification` looks dead (no app code names it, and Viberr ships no
-- email-verification or password-reset flow) but better-auth writes it on EVERY
-- OAuth sign-in. `createAuthContext` picks the OAuth state strategy as
-- `account.storeStateStrategy || (isStateful ? "database" : "cookie")`, and
-- `isStateful` is just `!!options.database` — we pass one, so the strategy is
-- "database": `generateGenericState` INSERTs the signed state here at
-- /sign-in/social and `parseGenericState` reads then deletes it at /callback/:id
-- (better-auth 1.6.25, dist/state.mjs). Dropping the table makes every GitHub /
-- Google login fail with better-auth's own "there is a verification table in the
-- database" error. `verification_identifier_idx` below is the lookup that read
-- path uses.
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
-- queued/running kind='primary' runs are constrained — i.e. exactly the
-- DELIVERING engagements (see the column's note; every supporting engagement is
-- stored as 'reviewer' whatever its role). Operator runs, supporting runs and
-- any terminal state (finished/error/interrupted) are unconstrained.
CREATE UNIQUE INDEX idx_agent_runs__one_delivering
  ON agent_runs (project_slug, task_key)
  WHERE kind = 'primary' AND state IN ('queued', 'running');
-- Dispatch-rework bug hunt (2026-08-29): the SAME race, for supporting runs.
-- P8 gave every supporting engagement one destructively re-cloned checkout
-- (workspace/support/<profileId>/), so two overlapping runs of the SAME
-- profile are exactly as unsafe as two delivering runs — the second clone
-- rm -rf's the first run's working tree mid-run. The JS preflight in
-- dispatchAgentRun has the identical check-then-await window F10-05 closed
-- for primary, so it gets the identical backstop: one live run per supporting
-- profile per task, enforced atomically here. DIFFERENT profiles still run
-- concurrently (agent_profile_id is in the key); operator runs and terminal
-- states are unconstrained. reserveRun/startRun translate the violation to a
-- 409. (Existing data roots predate this line in the applied baseline, so
-- boot also ensures it idempotently — see ensureSingleFlightIndexes.)
CREATE UNIQUE INDEX idx_agent_runs__one_live_per_support
  ON agent_runs (project_slug, task_key, agent_profile_id)
  WHERE kind = 'reviewer' AND state IN ('queued', 'running');
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
