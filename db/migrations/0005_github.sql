-- 0005_github: phase 7 (GitHub server layer).
--
-- github_pats: user-provided fine-grained PATs, AES-256-GCM encrypted at
-- rest (secret-box format v1$<iv>$<ct>$<tag>, key from
-- VIBERR_SECRET_ENCRYPTION_KEY). token_suffix keeps ONLY the last 4 chars
-- for the masked display ("····42af") — the plaintext token exists nowhere
-- else. validation_json caches the last PAT-validator result.
--
-- project_github_credentials: which stored PAT a project executes with
-- (the mock's POLICY.repo.credential). project_slug is a SOFT ref — the
-- projects table is a projection that seed --reset wipes; the credential
-- binding must survive that.
--
-- scope_violations: per-violation open/resolved records (orchestrator
-- ruling 5 — replaces the phase-4 policy-event derivation). Rail badge =
-- COUNT(open) per project. task_key is a soft ref to the task the policy
-- engine flagged. The partial unique index makes opening idempotent: one
-- OPEN row per (project, scope, task).

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

CREATE INDEX idx_github_pats__user_id ON github_pats (user_id);

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

CREATE INDEX idx_scope_violations__project_status
  ON scope_violations (project_slug, status);
CREATE INDEX idx_scope_violations__task
  ON scope_violations (project_slug, task_key);
CREATE UNIQUE INDEX idx_scope_violations__open_unique
  ON scope_violations (project_slug, scope, coalesce(task_key, ''))
  WHERE status = 'open';

-- Seed the mock's one open violation (VIB-142 · pull_request:write) so the
-- rail Settings badge stays 1 for viberr-core out of the box. Deterministic
-- id → re-running migrations elsewhere stays idempotent; resolving it via
-- the grant flow is permanent (a re-seed does NOT reopen it — the policy
-- engine reopens violations only on real 403-scope failures).
INSERT INTO scope_violations
  (id, project_slug, task_key, scope, detail, status, created_at)
VALUES
  ('sv_seed_vib142_pr_write', 'viberr-core', 'VIB-142', 'pull_request:write',
   'Project credential is missing `pull_request:write` — flagged by the policy engine on VIB-142. PR status can''t auto-sync after merge.',
   'open', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
