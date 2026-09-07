# Data model: the file store and the SQLite database

> What is canonical, what is derived, and where each kind of state lives.
> Source of truth: `app/server/files/file-store-root.server.ts` (layout),
> `db/migrations/0001_baseline.sql` (schema), `app/server/db/retention.server.ts`
> and `app/server/ops/maintenance.server.ts` (retention). Field-level file formats
> are in [file-formats.md](file-formats.md). Verified against `main` @ `68b5480`
> (2026-09-01); the ruling-121 controller columns re-verified against the working
> tree on 2026-09-03; §5 and §6 re-verified 2026-09-02 against `pass32/implementation`
> @ `478bed0`. Updated 2026-09-02 for ruling 127 (branch
> `claude/per-user-codex-auth-difdnn`): per-person agent-backend credentials and
> runtime homes.

## 1. The two stores and the rule that separates them

Viberr keeps **business truth in markdown files** under the data root and
**app-management truth in SQLite**. The split is per table, not per file:

- `projects/<slug>/project.md`, `projects/<slug>/tasks/<KEY>/task.md`,
  `projects/<slug>/goals/<id>.md` and `agents/profiles/<id>.md` are canonical.
  Humans and agents may edit them directly. The app watches them, parses them
  tolerantly, and materializes projection rows for fast reads.
- `state/projection.sqlite` holds two kinds of table. **Projection tables** are
  derived from the files and can be rebuilt at any time. **Primary tables**
  (users, better-auth credentials and sessions, sealed secrets, audit,
  notifications, run history, controller transcripts, org resource metadata)
  exist nowhere else and are not rebuildable. Back the file up.

A write to canonical state always goes file first: writer module → atomic write →
re-parse → re-project → audit → SSE. Projections are never written without file
backing for task or project state.

## 2. Data root layout

`DATA_ROOT_SUBDIRS` creates these at boot (`ensureDataRootDirs`):

```
${VIBERR_DATA_ROOT}/
  projects/                      canonical project + task + goal files
  agents/
    profiles/<id>.md             org-level agent profile templates (operator, controller, specialists)
  runtimes/
    users/                       per-person agent homes (ruling 127); one subdirectory per
                                 connected person, created 0o700 on demand
  kb/                            knowledge-base folders (store://kb/<dir>/)
  skills/                        skill folders (store://skills/<name>/SKILL.md)
  audit-exports/                 rows the 90-day audit purge exported before deleting
  state/                         projection.sqlite (+ -wal/-shm) and writer.lock
```

*(Corrected 2026-09-02 — `audit-exports` was already in `DATA_ROOT_SUBDIRS` and missing
here; ruling 127 replaced the shared `runtimes/claude-home` and `runtimes/codex-home` with
`runtimes/users`, whose per-person subdirectories are created on demand rather than at
boot.)*

Created lazily by the code that needs them:

```
  projects/<slug>/project.md
  projects/<slug>/tasks/<KEY>/task.md
  projects/<slug>/tasks/<KEY>/attachments/          files agents post on the task thread (member-only served)
  projects/<slug>/tasks/<KEY>/workspace/<repo>       the delivering engagement's git clone (cache, not canonical)
  projects/<slug>/tasks/<KEY>/workspace/support/<profileId>/<repo>   a supporting engagement's isolated clone
  projects/<slug>/goals/<goal-id>.md                chained goals (ruling 99)
  projects/<slug>/.mirror or equivalent             per-project git mirror cache (repo-mirror.server.ts)
  agents/definitions/operator.md, controller.md     system-profile doctrine files shipped by boot
  runtimes/users/<userId>/claude-home/               that person's CLAUDE_CONFIG_DIR (ruling 127): the vendor's own
                                                    sign-in file plus their Claude transcripts under projects/
  runtimes/users/<userId>/codex-home/                that person's CODEX_HOME: auth.json plus sessions/
  runtimes/<backend>/<runId>.jsonl                  raw NDJSON transcript of every run (canonical run truth)
  runtimes/uv-cache/, runtimes/uv-python/           uv's cache for Python MCP servers (container)
  audit-exports/audit-events-<YYYY-MM-DD>.jsonl     rows the 90-day audit purge exported before deleting
```

There is deliberately no `cache/`, `auth/` or `logs/` directory. Application logs are
structured JSON on stdout. The watcher (`file-watch.service.server.ts`) watches only
`projects/` down to `<slug>/tasks/<KEY>/task.md` and the goal files; `workspace/`,
`attachments/` and anything deeper are invisible to it on purpose. The KB watcher
(`kb-watch.service.server.ts`) watches `kb/` and re-indexes a knowledge base on change.

The exact mirror path and the per-project mirror layout are owned by
`app/server/tasks/repo-mirror.server.ts`; treat every workspace and mirror directory
as a cache that a boot or maintenance pass may remove.

## 3. SQLite tables

`node:sqlite` in WAL mode, opened by `app/server/db/sqlite.server.ts`. Migrations are
squashed into one forward-only baseline; the runner records the filename in
`schema_migrations` and skips by filename, so editing the baseline reaches **fresh**
databases only (see §6).

Legend: **P** primary (not rebuildable) · **D** derived projection (rebuilt from
files) · **C** cache/operational (safe to lose).

### Identity, access, audit

| Table | Kind | What it holds |
|---|---|---|
| `users` | P | Canonical app profile and org role: `role` (`admin \| member`), `idp`, `pwreset_required`, `theme`, `disabled`, `github_handle`, `last_login_at`, `created_by`. Better-auth `user.id` equals `users.id`. |
| `user` / `session` / `account` / `verification` | P | better-auth's own tables (singular names, camelCase columns, generated by its CLI at version-bump time). `verification` looks unused but is written on every OAuth sign-in. There is no `organization` / `member` / `invitation` table; the org plugin is not in use. |
| `audit_events` | P | Every governed action: `action` (lowercase dot-separated), actor id/label, subject, project/task scope, secret-free `details_json`. Retained 90 days (§5). |
| `user_prefs` | P | Per-user JSON preferences keyed by string (home pins, view, motion, notification routing, timeline default). |
| `instance_settings` | P | Instance-wide JSON key-value store (run concurrency cap, backend quota observations: the latest reading, exhaustion and credential refusal per backend, each naming the account it billed since ruling 130(d)). Never a secret. `projection.derivationVersion` stamps the rule set the projections were derived under; a stamp behind `PROJECTION_DERIVATION_VERSION` forces one full rebuild at boot (pass 32, D32-14: `task_events.actor_ref` for agents became `agent/<profileId>`). |
| `oauth_providers` | P | In-app OAuth client id + sealed secret per provider, `enabled`, `verified_at`. Overrides the env pair. |
| `google_domain_allowlist` | P | Domains whose Google sign-ins provision on first login, with the org role they join as. |
| `s3_audit_config` | P | The single S3 audit-export target; secret key sealed in its own column. |

### Projects, tasks, goals (projections of the files)

| Table | Kind | What it holds |
|---|---|---|
| `projects` | D | One row per `project.md`: name, `archived`, `repo`, `default_branch`, `task_prefix`, JSON copies of stages/workflow/agent policy/credential policy/guardrails, `content_hash`. |
| `project_members` | D | `members[]` from `project.md` (`admin \| maintainer \| contributor \| viewer`). |
| `task_projections` | D | One row per `task.md`: stage, **derived** `readiness` plus `stored_readiness`, `waiting`, `priority`/`labels_json`/`due_date`, `blocked_by_json` (ruling 131: the task's `blockedBy` list verbatim; resolved to per-entry states at read time, never cached), `archived`, derived `validation` (CHECK mirrors `VALIDATION_VALUES`), `validation_block_reason`, `acceptance` (`forced`), `continuity` (`degraded`), owner, engagement snapshots, `branch`, `repo` (always the project's), `pr_json`, `github_json`, `work_revision_sha`, `goal`, `packet_json`, `recommendation_count`, `schedules_json`, counts, `goal_id`/`goal_link_index`, `board_rank`, `content_hash`. |
| `task_events` | D | The task timeline, one row per entry, `position` 0 = newest, with a denormalized `actor_json` snapshot, `title`, `text`, `to_agent`, `evidence_json`, `attachments_json`. Replaced wholesale per task on every re-project. |
| `goal_projections` | D | One row per goal file with link statuses **reconciled against live task rows**, `current_index`, `links_total/done`. |
| `diagnostics` | D | Tolerant-parse findings per source path: `severity` (`info \| warning \| error`), `code`, `hard_stop`. |
| `provenance` | C | Observational log of what the projector and reconciler saw (`projected \| removed \| error \| rescan`, `github.reconcile`, `github.merge`). No retention; prune by hand. |

### GitHub and secrets

| Table | Kind | What it holds |
|---|---|---|
| `github_pats` | P | User-owned PATs, AES-256-GCM sealed (`encrypted_token`), `token_suffix`, cached `validation_json`. |
| `github_connections` | P | Org-level owner connections: `owner` → `pat_id`, `is_default`, `repos_count`, `expires_at`. |
| `project_github_credentials` | P | Which PAT a project uses (one per project). |
| `scope_violations` | P | Open/resolved PAT scope violations per project (and optional task); at most one open row per `(project, scope, task)`. |
| `user_backend_credentials` | P | Ruling 127: one row per `(user, backend)` — how that person connected Claude/Codex. `kind = 'login'` carries NO secret (the vendor binary holds it in `runtimes/users/<id>/…`), only `method` (`claudeai \| console \| device`) and the non-secret `detail_json` the vendor reported; `api_key`/`access_token` carry a sealed `secret_box` + `secret_suffix`. `verified_at` is the last time the provider itself accepted the value (null on a ChatGPT workspace token, which has no free probe). Connecting a new method REPLACES the row. |
| `project_github_health` | P | The LAST repository-access probe per project (`result_json`, `checked_at`), one row overwritten in place. An app-owned OBSERVATION, not a projection — a rebuild must not clear it — so the board and the home card can say a repository is unreachable without calling GitHub on a render path (U33-2, pass 33). Written only where the answer was already in hand: project creation's own probe and the GitHub page's 30-second cached probe. |

### Org resources, models, controller

| Table | Kind | What it holds |
|---|---|---|
| `org_knowledge_bases` | P (metadata) | `name`, `dir` (the grant key), `refresh` (`manual \| on change`; the CHECK still admits `nightly`, which is coerced away), `last_indexed_at`. Content is the folder on disk. |
| `org_skills` | P (metadata) | `name` (slug and folder), `summary`. Content is `skills/<name>/SKILL.md`. |
| `org_mcp_servers` | P | `name`, `transport` (`HTTP \| stdio`), `target`, optional `cred_ref`, probe results (`tools_count`, `up`, `last_checked_at`, `last_error`), warm-up bookkeeping (`warming_since`, `first_success_at`, `heuristic_warmups`). |
| `model_availability` | C | Models the provider refused for this account, learned only from real run failures; presence = unavailable. |
| `controller_conversations` / `controller_messages` | P | The controller's transcripts, owned by the asking user. Scope (ruling 121): `project_slug` + `task_key` (both null = instance, slug alone = board, slug + key = one task; `CHECK (task_key IS NULL OR project_slug IS NOT NULL)`), indexed per user and scope. `controller_messages.surface` is the in-app path a user message was sent from (null on controller rows). |

### Runs

| Table | Kind | What it holds |
|---|---|---|
| `agent_runs` | P | One row per run: `kind` (`operator \| primary \| reviewer \| controller`, a **delivery axis**: `primary` = delivering, `reviewer` = any supporting run), `backend`, `model`, `session_id`, `state` (`queued \| running \| finished \| error \| interrupted`), `phase`/`step`, token and cost counters, `usage_final` (F35-1: 1 once a provider usage figure landed; 0 while the token columns hold the Claude adapter's live estimate or nothing, which the Live run panel prints as an estimate and Insights leaves out of its token sums), `interrupted_by`, `agent_profile_id`, `outcome_key`, `credential_user_id`. Controller turns use `project_slug = ''` and `task_key = <conversation id>`. |
| `run_log_lines` | C | Projected console lines per run (`raw_json`, `display_json`, `seq`). Retained 30 days; the `.jsonl` file is the truth. |
| `staged_outcomes` | C | A Claude `report_outcome` envelope staged mid-run until the completion callback consumes it; orphans pruned after 24 h. |

`agent_runs.credential_user_id` is the run's **credential principal** (ruling 127):
whose connected backend account it billed, and therefore whose runtime home holds
its transcript. Task runs carry the task owner, controller turns the asker; a run
refused because that person has not connected THAT backend still records them, so
the refusal is auditable rather than anonymous. It is NULL only on a run that was
refused before any credential was looked up: an unowned task, or one whose owner
account is gone or disabled — no process was ever started in either case.

Two partial unique indexes on `agent_runs` enforce single-flight at the DB layer:
`idx_agent_runs__one_delivering` (one live `primary` run per task) and
`idx_agent_runs__one_live_per_support` (one live supporting run per profile per
task). Boot re-creates the second idempotently for older data roots.

## 4. Naming conventions

Viberr's own tables are plural snake_case with snake_case columns, `<entity>_id`
foreign keys and `idx_<table>__<cols>` indexes. Rows map to camelCase through the
modules in `app/shared/mapping/`, never ad hoc at a call site. The four better-auth
tables are the documented exception (singular, camelCase). Timestamps are UTC ISO
8601 strings everywhere; booleans are `0/1` in SQLite.

## 5. Retention and growth

| Store | Window | Where enforced |
|---|---|---|
| `run_log_lines` | 30 days | `applyRetention` (boot + every maintenance pass) |
| `audit_events` | 90 days, exported to `audit-exports/*.jsonl` first; an export failure skips that pass's purge; `task.agent.replied` and `runtime.operator.plan_executed` are exempt because boot recovery uses them as idempotency keys | `applyRetention` |
| `notifications` | newest 500 per user | `applyRetention` |
| `staged_outcomes` | 24 h TTL | `agent-outcome.server.ts` on consumption |
| `runtimes/<backend>/*.jsonl` | `VIBERR_TRANSCRIPT_RETENTION_DAYS` (30) | `pruneRuntimeTranscripts` |
| `runtimes/users/*/claude-home/projects/**/*.jsonl`, `runtimes/users/*/codex-home/sessions/**/*.jsonl` | `VIBERR_SESSION_HOME_RETENTION_DAYS` (30). Extension-gated to `*.jsonl`: `auth.json`, `.credentials.json` and `.claude.json` are the vendor-held sign-ins and are never touched, so retention cannot sign a person out (ruling 127) | `pruneRuntimeTranscripts` |
| task `workspace/` clones | removed once the task is in its project's terminal stage, only when no run is live | `reclaimTerminalTaskWorkspaces` (boot after run recovery; each maintenance pass) |
| `provenance` | none | manual `DELETE … WHERE observed_at < …; VACUUM;` with the app stopped |
| better-auth `session` rows | none on a timer; expired rows are simply never honoured | sign-out, password change, admin disable/reset, or the auth guard on a disabled user |
| `attachments/` | one **completion-time prune** (ruling 105): when a run finishes, the machine-stamped non-visual artifacts its browser MCP wrote (`page-*.yml`, `console-*.log` — a short prefix plus the MCP's dashed-ISO stamp, excluding png/jpg/webp/gif/pdf) are deleted unless the exact filename is cited in the run's reply, its evidence rows or the timeline since it started. Deliberately named files and every screenshot or PDF always stay, and pre-existing artifacts in old tasks were left in place. No age- or size-based retention beyond that: the rest of the directory rides with the task | `pruneBrowserWorkingArtifacts` (`app/server/files/task-attachments.server.ts`, driven from `applyAgentCompletionEffects`); archive/delete of the task |

The maintenance pass runs at boot and then every `VIBERR_MAINTENANCE_INTERVAL_MS`
(default 6 h); a disk-pressure transition (`low`/`critical`) triggers an extra pass at
most every 30 minutes. Every pass logs `store maintenance pass` even when it removed
nothing, which is how an operator confirms the timer is alive; `/resources/health`
reports `maintenance.lastPassAt`.

## 6. Schema changes while pre-prod

The baseline is the schema. A change to `0001_baseline.sql` reaches fresh databases
only; an existing root keeps its old DDL. Boot detects two drift shapes on
`task_projections` / `task_events` and logs a `projection schema drift` WARN naming
the remedy: a CHECK that refuses a value the build now produces, and a column the
rebuilder INSERTs that the live table lacks. The second shape is repaired at open for
the columns that carry it: `ensureBaselineColumns` (`app/server/db/sqlite.server.ts`)
`ALTER TABLE agent_runs ADD COLUMN`s each missing `BASELINE_COLUMNS` entry
(`dispatched_by_name`, `dispatched_by_user_id`, `credential_user_id`, `usage_final`)
idempotently on every boot, so additive
drift there needs no operator action at all. For a CHECK that no ALTER can widen, the
remedy is to re-baseline — preferably preserve-copy (fresh file + migrations, then copy
the non-rebuildable tables across with foreign keys off, the shape
`selfHealProjectionDbIfCorrupt` already implements), because the blunt form (stop the
app, `npm run backup`, delete `state/projection.sqlite*`, start) regenerates user ids
and destroys every primary row in the file. Both are written out in
[../operations/deployment.md](../operations/deployment.md#re-baselining-the-projection-database).
*(Corrected 2026-09-02, pass 32 — this paragraph taught only the lossy form and did not
know about the additive backstop.)* `npm run seed -- --reset` wipes
projects, agent profiles, transcripts and all derived tables but keeps users and
credential homes. Revisit this convention at the first real deployment.

## 7. Identity and ids

`newId(prefix)` mints `<prefix>_<12 base64url chars>` (users `u_…`, audit `evt_…`,
packets `pkt_…`, revisions `rev_…`). Session ids are better-auth's. Compare users by
id everywhere; display names are render-only (ruling 6). Task keys are
`<PREFIX>-<n>` allocated from `project.md` `nextTaskNumber` under the project file
mutex, with a directory max-scan rescuing a stale counter. Actor references inside
files use the codec in `app/server/files/actor-ref.server.ts` (`user:<id> (Name)`,
`agent:<backend>/<profileId>`, `operator`, `controller`, `system:<id>`).
