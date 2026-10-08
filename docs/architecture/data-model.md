# Data model: the file store and the SQLite database

> What is canonical, what is derived, and where each kind of state lives: the data-root
> layout, every SQLite table and index, retention, and id formats. Field-level file formats
> are in [file-formats.md](file-formats.md).
> Source of truth: `app/server/files/file-store-root.server.ts` (layout),
> `db/migrations/0001_baseline.sql` plus `ensureBaselineColumns` / `ensureSingleFlightIndexes`
> in `app/server/db/sqlite.server.ts` (schema), `app/server/db/retention.server.ts`,
> `app/server/ops/maintenance.server.ts` and `app/server/ops/transcript-retention.server.ts`
> (retention), `app/shared/ids/new-id.server.ts` (ids).
> Verified against `main` @ `7d9fbf72` (2026-09-23).

## 1. The two stores and the rule that separates them

Viberr keeps **business truth in markdown files** under the data root and
**app-management truth in SQLite**. The split is per table, not per file:

- `projects/<slug>/project.md`, `projects/<slug>/tasks/<KEY>/task.md` and
  `projects/<slug>/epics/<id>.md` are canonical. Humans and agents may edit them
  directly. The watcher reconciles them into projection rows for fast reads; project and
  task files parse tolerantly, epic files strictly ([file-formats.md](file-formats.md)).
- `agents/profiles/<id>.md`, `agents/definitions/<id>.md`, `agents/controller-requests.md`,
  `kb/` and `skills/` are file-store content too, but nothing projects them: they are read
  from disk when needed (the KB watcher only refreshes a knowledge base's index metadata).
- `state/projection.sqlite` holds two kinds of table. **Projection tables** are
  derived from the files and can be rebuilt at any time. **Primary tables**
  (users, better-auth credentials and sessions, sealed secrets, audit,
  notifications, run history, controller transcripts, org resource metadata)
  exist nowhere else and are not rebuildable. Back the file up.

A write to canonical state always goes file first: writer module → atomic write →
re-parse → re-project → audit → SSE. Projections are never written without file
backing for task or project state.

## 2. Data root layout

`DATA_ROOT_SUBDIRS` creates these nine at boot (`ensureDataRootDirs`):

```
${VIBERR_DATA_ROOT}/
  projects/                      canonical project + task + epic files
  agents/
    profiles/<id>.md             org-level agent profile templates (operator, controller, specialists)
  runtimes/
    users/                       per-person agent homes (ruling 127); one subdirectory per
                                 connected person, owned by that person's agent uid (ruling 460)
  kb/                            knowledge-base folders (store://kb/<dir>/)
  skills/                        skill folders (store://skills/<name>/SKILL.md)
  audit-exports/                 rows the 90-day audit purge exported before deleting
  state/                         projection.sqlite (+ -wal/-shm) and writer.lock
```

Created by the code that needs them:

```
  projects/<slug>/project.md
  projects/<slug>/tasks/<KEY>/task.md
  projects/<slug>/tasks/<KEY>/attachments/          files agents save and people upload on the task
                                                    (member-only served; ruling 96, ruling 379), and
                                                    Viberr's own pictures of the delivered pages,
                                                    `<file>.capture-desktop.png` and
                                                    `<file>.capture-phone.png`, replaced by the next
                                                    delivery's (ruling 691)
  projects/<slug>/tasks/<KEY>/deliveries/<stamp>/   each files delivery as it was delivered, copied
                                                    when `deliveredAt` is stamped (ruling 597): every
                                                    file on the task then (ruling 610), and that
                                                    delivery's own page pictures (ruling 691)
  projects/<slug>/tasks/<KEY>/sources/              the sources the task's result rests on: `index.jsonl`
                                                    and one bytes file a source, the server's own
                                                    (ruling 690; file-formats.md §10)
  projects/<slug>/tasks/<KEY>/workspace/<repo-name>/ the delivering engagement's git clone, shared by the
                                                    operator (a cache, not canonical)
  projects/<slug>/tasks/<KEY>/workspace/support/<profileId>/<repo-name>/
                                                    a supporting engagement's own clone, re-cloned each run
  projects/<slug>/tasks/<KEY>/workspace/.viberr-plugins/<runId>/
                                                    one Claude run's skill plugin (ruling 180), beside the
                                                    checkout it serves (a supporting run's sits under
                                                    support/<profileId>/); removed when the run settles
  projects/<slug>/tasks/<KEY>/workspace/.gates/<runId>/<repo-name>/
                                                    one project-gate run's clone of the delivering
                                                    checkout, detached at the revision's sha and made
                                                    by the task owner's agent uid (ruling 482);
                                                    removed when the run finishes. Each gate's log
                                                    lands in attachments/ as
                                                    `gate-<sha7>-<NN>-<name>-<stamp>.log`
  projects/<slug>/tasks/<KEY>/.captures/<run>/<captureId>/
                                                    one page render's scratch (ruling 691): `out/`
                                                    (the pictures and the report), `tmp/` and
                                                    `profile/` (the browser's), written by the task
                                                    owner's agent uid. `<run>` is the id of the run
                                                    whose `capture_page` asked, or `no.run` for a
                                                    delivery's own render. `.captures/` and `<run>/`
                                                    are the server's own, 0710 in the agent group
                                                    (passed through, never listed or written by an
                                                    agent); only `<captureId>/`, made new, is 2770
                                                    for the renderer. Beside `deliveries/`, never
                                                    under `workspace/`, which agents write. A
                                                    delivery's is removed when its render finishes.
                                                    An agent's `capture_page` keeps `out/` alone,
                                                    replaced by that run's next capture and removed
                                                    with `<run>/` when the run ends; whatever a
                                                    restart left goes before the next render on the
                                                    task, with a finished task's at boot, and as the
                                                    task's owner on a seed reset
  projects/<slug>/tasks/<KEY>/.capture-input/<captureId>/
                                                    a kept delivery's files, copied for the one render
                                                    that pictures it and removed with it, or, when a
                                                    restart cut that render, before the task's next
                                                    one (ruling 691):
                                                    the server's own, 0710 in the agent group with
                                                    each file 0640, so the renderer reads a file by
                                                    its name and no agent lists the folder or writes
                                                    in it. Beside `deliveries/`, never under
                                                    `workspace/`, which agents write
  projects/<slug>/tasks/<KEY>/.operator-scratch/    the Codex operator's working directory
  projects/<slug>/epics/<epic-id>.md                epics (ruling 503)
  projects/<slug>/goals/converted/<goal-id>.md      ruling 99's chained goals, filed by the
                                                    one-time conversion to epics; a record,
                                                    not watched or projected
  projects/<slug>/.repo-mirror/<owner>__<repo>.git  the project's bare repository mirror (ruling 87);
                                                    built in a `.building` sidecar and renamed into place
  agents/definitions/operator.md, controller.md     shipped doctrine files (written at boot)
  agents/controller-requests.md                     resource grants the controller asked for (ruling 390)
  runtimes/<backend>/<runId>.jsonl                  raw NDJSON transcript of every run (canonical run truth)
  runtimes/controller-scratch/                      the controller turns' working directory
  runtimes/users/<userId>/claude-home/              that person's Claude home (ruling 127): their Claude transcripts
                                                    under projects/<cwd-as-dashes>/<sessionId>.jsonl, and the
                                                    sign-in of an account connected before ruling 507
  runtimes/users/<userId>/claude-home/accounts/<accountId>/
                                                    one account's CLAUDE_CONFIG_DIR (ruling 507): the vendor's own
                                                    sign-in (.credentials.json, .claude.json) and a projects/ link
                                                    to the claude-home's
  runtimes/users/<userId>/codex-home/               that person's shared Codex home: config.toml,
                                                    sessions/YYYY/MM/DD/rollout-*.jsonl, skills/, memories/,
                                                    the CLI's own state_*.sqlite (CODEX_SQLITE_HOME), and the
                                                    auth.json of an account connected before ruling 507
  runtimes/users/<userId>/codex-home/accounts/<accountId>/
                                                    one Codex account's home (ruling 507): its auth.json
  runtimes/users/<userId>/codex-home/runs/<runId>/  one live run's CODEX_HOME (ruling 181): a copy of the billed
                                                    account's auth.json (with its seed digest) + config.toml,
                                                    symlinked sessions/ skills/ memories/, the CLI's own tmp/;
                                                    deleted when the run settles (`<runId>-compaction/` is its
                                                    completion compaction's own, ruling 507)
  runtimes/users/<userId>/home/                     that person's agents' $HOME (ruling 460): npm's cache, a
                                                    `git config --global`, whatever a tool writes under ~
  runtimes/uv-cache/, runtimes/uv-python/           uv's cache for Python MCP servers (set by the container image)
  kb/controller-handbook/handbook.md                the controller's shipped knowledge base (written at boot)
  audit-exports/audit-events-<YYYY-MM-DD>.jsonl     rows the 90-day audit purge exported before deleting
  state/shipped-assets.json                         hashes of the agent assets boot last shipped (unedited
                                                    copies are refreshed, edited ones never overwritten)
  state/tmp/reader-<pid>/                           a read-only CLI's private copy of the database (ruling 158)
```

Boot's `seedDefaultAgentAssets` writes the shipped skills
(`skills/{viberr-app-expertise,developer-expertise,reviewer-expertise,controller-guide}/SKILL.md`),
the two doctrine files, the `operator` and `controller` profile templates and the controller
handbook. Each person's `runtimes/users/<userId>/{claude-home,codex-home}` is created by
`ensureUserBackendHome` the first time a run or a sign-in needs it, and each account's home
inside it by `ensureBackendAccountHome` (ruling 507); `userRuntimeRoot` refuses any user id, and
`backendAccountHome` any account id, that is not a path-safe segment (`^[A-Za-z0-9_-]{1,64}$`).

**Who owns what (ruling 460).** In the image every agent process runs as its person's own
uid in the group `viberr-agents`, so the modes are part of the layout and boot re-asserts
them (`enforceStoreLayout`, `agent-isolation.server.ts`): the root `node:viberr-agents` 0750;
`state/`, `audit-exports/` and `runtimes/claude|codex/` 0700; `runtimes/` 0750 and
`runtimes/users/` 0710 in the agent group; `agents/`, `kb/`, `skills/`, `projects/` 0755 (the
server's files, readable and never writable to an agent); each person's
`runtimes/users/<userId>/` tree owned `<uid>:node`, directories 2770; and the directories a run
writes — a task's `workspace/`, `attachments/`, `.operator-scratch/`, and
`runtimes/controller-scratch/`, `uv-cache/`, `uv-python/` — `node:viberr-agents` 2770. On the
host dev server (no launcher) none of this is applied.

There is deliberately no `cache/`, `auth/` or `logs/` directory. Application logs are
structured JSON on stdout. The watcher (`file-watch.service.server.ts`) watches only
`projects/`: `project.md`, `tasks/<KEY>/task.md` and `epics/<id>.md`, with a 250 ms debounce.
Every dot-prefixed path segment and every `*.tmp` file is ignored, and so is anything deeper
than `tasks/<KEY>/task.md`, which keeps `workspace/`, `attachments/`, `.repo-mirror/` and the
scratch folders invisible to it. The KB watcher (`kb-watch.service.server.ts`) watches `kb/`
and re-indexes a knowledge base in `on change` mode when a document under it changes.

The mirror path is owned by `app/server/tasks/repo-mirror.server.ts`. Treat every workspace
and mirror directory as a cache: workspaces are reclaimed by boot and maintenance passes (§5),
and a mirror that fails to refresh twice in a row is rebuilt from scratch.

## 3. SQLite tables

`node:sqlite` in WAL mode (`foreign_keys = ON`, `busy_timeout = 5000`), opened by
`app/server/db/sqlite.server.ts`. Migrations are squashed into one forward-only baseline,
`db/migrations/0001_baseline.sql`, still the only file there. The runner
(`migration-runner.server.ts`) creates `schema_migrations` (`filename` primary key,
`applied_at`), applies each `*.sql` file in its own transaction and skips by filename, so
editing the baseline reaches **fresh** databases only (see §6).

Legend: **P** primary (not rebuildable) · **D** derived projection (rebuilt from
files) · **C** cache/operational (safe to lose).

### Identity, access, audit

| Table | Kind | What it holds |
|---|---|---|
| `users` | P | Canonical app profile and org role: `id`, `email` (unique), `name`, `title`, `role` (`admin \| member`), `idp` (default `local`), `avatar_tone`, `pwreset_required`, `theme` (`light \| dark \| system`), `disabled`, `last_login_at`, `created_by`, `github_handle`, `created_at`, `updated_at`. Better-auth `user.id` equals `users.id`. |
| `user` / `session` / `account` / `verification` | P | better-auth's own tables (generated by 1.6.25, unchanged in 1.7.7), its schema output pasted into the baseline (singular names, quoted camelCase columns). `user`: `id`, `name`, `email`, `emailVerified`, `image`, `createdAt`, `updatedAt`, and Viberr's own `githubHandle` additional field. `session`: `id`, `expiresAt`, `token`, `createdAt`, `updatedAt`, `ipAddress`, `userAgent`, `userId`. `account`: `id`, `accountId`, `providerId`, `userId`, `accessToken`, `refreshToken`, `idToken`, `accessTokenExpiresAt`, `refreshTokenExpiresAt`, `scope`, `password`, `createdAt`, `updatedAt`. `verification`: `id`, `identifier`, `value`, `expiresAt`, `createdAt`, `updatedAt`; it looks unused but holds the OAuth state of every social sign-in (inserted at `/sign-in/social`, read and deleted at the callback). There is no `organization` / `member` / `invitation` table; the org plugin is not in use. |
| `audit_events` | P | Every governed action: `id`, `occurred_at`, `actor_user_id`, `actor_label` (a row written through the controller ends ` · via controller`), `action` (lowercase dot-separated), `subject_kind`, `subject_id`, `project_slug`, `task_key`, secret-free `details_json`. Retained 90 days (§5). |
| `notifications` | P | One row per delivered notification: `id`, `user_id`, `kind` (the CHECK is `NOTIFICATION_KINDS`: `packet \| question \| approval \| mention \| quality \| policy \| controller \| dependency \| ownership \| epic`), `ptype` (`input \| blocked`, packet kind only), `title`, `text`, `actor_json`, `project_slug`, `task_key`, `href` (ruling 497: where the row opens, recorded by the notifier that knows: a timeline event `#event-<occurredAt>`, the task's open packet `#decision-<packet id>` (moved to the `#event-` of the entry that closed it once it closes, ruling 547) or `#recommendations`, a proposal's entry on the Controller page, the project's GitHub page, an epic's page; NULL opens the task or the board, and a link outside the row's own project is ignored; added at open on an older root by `ensureBaselineColumns`), `occurred_at`, `read_at`, `created_at`. A controller conversation reply is never a row; `controller` rows are chained-goal progress, which nothing has written since ruling 503 (the conversion repointed the ones that opened a goal to its epic); `epic` rows are an epic's notices to its lead (ruling 503); `question` rows are an agent's question to a person (`ask_human`, or the Codex outcome envelope's question; ruling 481). Boot widens a live root whose `kind` CHECK predates a kind in place, rows and indexes kept (`widenNotificationKindCheck`, ruling 481). Newest 500 per user (§5). |
| `user_prefs` | P | Per-user JSON preferences: (`user_id`, `key`) → `value_json`, `updated_at`. Keys in use: `home` (grid or list view and pinned projects), `notifs` (notification routing) and `tlDefault` (the task timeline's default filter). |
| `instance_settings` | P | Instance-wide JSON key-value store (`key`, `value_json`, `updated_at`). Never a secret. Keys: `maxConcurrentRuns` (the run concurrency cap, 0 or absent = unlimited, at most 64), `maxRunSpendUsd` (the spending cap per Claude run in USD, absent when none is set, ruling 175), and the backend quota observations, each naming the account it billed (`credentialUserId`, `credentialLabel`): `backendRateLimit.<backend>` the latest reading, `backendQuotaExhausted.<backend>` the exhaustion (`resetsAt` unix seconds with `resetsAtPrecision` `exact` / `prose` / `clock`, the last for a UTC wall-clock time (ruling 130(d)) and for a time-only "try again at 6:18 PM" resolved in the process zone; `providerText`, `runId`, `observedAt`; also the dispatch hold's evidence, ruling 152(c)) and `backendCredentialRefused.<backend>` the credential refusal. `projection.derivationVersion` stamps the rule set the projections were derived under; a stamp behind `PROJECTION_DERIVATION_VERSION` (4) forces one full rebuild at boot. |
| `oauth_providers` | P | In-app OAuth client per provider (`provider` `github \| google`, primary key): `client_id`, sealed `client_secret`, `enabled` (cannot be set before `verified_at`), `verified_at`, `verified_detail`, `created_at`, `updated_at`. Overrides the env pair. |
| `google_domain_allowlist` | P | Domains whose Google sign-ins provision on first login: `id`, `domain` (unique, normalized `@company.dev`), `role` they join as, `created_at`. |
| `s3_audit_config` | P | The single S3 audit-export target (`id` always `default`): `bucket`, `region`, `prefix`, `endpoint`, `access_key_id`, sealed `secret_box`, `updated_at`. |

### Projects, tasks, epics (projections of the files)

| Table | Kind | What it holds |
|---|---|---|
| `projects` | D | One row per `project.md`: `slug`, `name`, `archived`, `repo` (NULL for a project with no repository, ruling 667), `default_branch`, `task_prefix`, `description`, JSON copies `stages_json`, `workflow_json`, `agent_policy_json`, `credential_policy_json`, `guardrails_json`, `required_reviewers_json` (ruling 178: the required-reviewer rules RESOLVED to stage and agent names at project-rebuild time, so the task walk prints the acceptance gate's sentence from the row), `gates_json` (ruling 482: the declared gates, `[]` when none, so the task walk's acceptance block says when the gates have not passed on the revision under review; a change cascades into every task like the reviewer rules), `source_path`, `content_hash`, `parsed_at`. |
| `project_members` | D | `members[]` from `project.md`: (`project_slug`, `user_id`) → `role` (`admin \| maintainer \| contributor \| viewer`). |
| `task_projections` | D | One row per `task.md`, keyed (`project_slug`, `task_key`): `title`, `stage`, **derived** `readiness` plus `stored_readiness`, `waiting` (CHECK mirrors `WAITING_VALUES`, including the projection-only `schedule`, ruling 225), `urgent`, `priority`, `labels_json`, `due_date`, `blocked_by_json` (ruling 131: the task's `blockedBy` list verbatim; entry states are resolved at read time, never stored), `archived`, derived `validation` (CHECK mirrors `VALIDATION_VALUES`), `validation_block_reason`, `acceptance` (`forced`), `continuity` (`degraded`), `owner_user_id`, the engagement snapshots `specialist_json` (the delivering engagement) / `reviewers_json` (the supporting engagements) / `operator_json` (the operator assignment), `branch`, `repo` (always the project's), `pr_json`, `github_json`, `work_revision_sha`, `goal`, `packet_json`, `recommendation_count` and `recommendation_kinds` (the distinct kinds of the pending recommendations, sorted and comma-joined), `schedules_json`, `event_count`, `comment_count`, `diagnostic_count`, `epic_id` (ruling 503: the task's `epic`, indexed with the project; an upgraded root keeps the retired `goal_id` / `goal_link_index`, which nothing reads), `created_at`, `updated_at`, `source_path`, `content_hash`, `parsed_at`, `board_rank`. |
| `task_events` | D | The task timeline, one row per entry: `id`, `project_slug`, `task_key`, `position` (0 = newest), `occurred_at`, `type`, `actor_kind` (`human \| agent \| operator \| controller \| system`; an unrecognized author projects as `system`), `actor_ref` (a user id, `agent/<profileId>`, `operator`, `controller`, or a system id), a denormalized `actor_json` snapshot, `title`, `text`, `to_agent`, `evidence_json`, `attachments_json`. A re-project keeps the rows of events that did not change (aligned from the oldest end; their `id` survives, their `position` shifts, changed content is updated in place) and deletes and inserts the rest (ruling 457), so an appended comment re-issues no existing id. |
| `epic_projections` | D | One row per epic file (ruling 503), keyed (`project_slug`, `epic_id`): `epic_number`, `title`, `status` (CHECK mirrors `EPIC_STATUS_VALUES`, compared at boot by `projectionCheckGaps`), `color`, `lead_user_id`, `start_date`, `target_date`, `description`, `created_by`, `created_by_label`, `conversation_id`, `created_at`, `updated_at`, `source_path`, `content_hash`, `parsed_at`. The epic's tasks are not here: an epic's progress is counted from `task_projections.epic_id` at read time. An upgraded root gains the table at open and keeps ruling 99's `goal_projections`, which nothing reads. |
| `diagnostics` | D | Parse findings per source path: `id`, `project_slug`, `task_key`, `source_path`, `severity` (`info \| warning \| error`), `code`, `path`, `message`, `hard_stop`, `observed_at`. |
| `provenance` | C | Observational log of what the projector and reconciler saw: `id`, `source_path`, `content_hash`, `observed_at`, `action` (`projected \| removed \| error \| rescan`, `github.reconcile`, `github.merge`, `github.branch_delete`, `github.push`), `details_json`. A `github.reconcile` row names the branch head its compare read (`headSha`, ruling 494), and a `github.push` row the head a Viberr push published. No retention; prune by hand. |

`specialist_json` and `reviewers_json` keep the names of the static delivering and reviewer
slots that ruling 98 replaced with dynamic dispatch (ruling 458(e)); they hold engagements.
`specialist_json` is the delivering engagement (`deliveringEngagement`, NULL while the task
has none) and `reviewers_json` every supporting engagement in `engagements[]` order
(`supportingEngagements`), whatever its role. A supporting run's `thread_id` starts `r<n>`,
its index into `reviewers_json`; that is how `agent-deployments.server.ts` joins a run to its
engagement.

### GitHub and secrets

| Table | Kind | What it holds |
|---|---|---|
| `github_pats` | P | User-owned PATs: `id`, `user_id`, `label`, AES-256-GCM sealed `encrypted_token`, `token_suffix`, `created_at`, `last_validated_at`, cached `validation_json` (the newest validator run), and `repo_scopes_json` (ruling 480: per repository, the last `probe` verdict each of `repo` / `pull_request:write` received there, from a repository-scoped validation or a write Viberr made; NULL until one; cleared when the token is replaced). |
| `github_connections` | P | Org-level owner connections: `id` (`slugify(owner)`), `owner` (unique) → `pat_id`, `is_default`, `repos_count`, `expires_at`, `created_at`, `updated_at`. |
| `project_github_credentials` | P | Which PAT a project uses (one per project): `project_slug` → `pat_id`, `created_at`, `updated_at`. |
| `scope_violations` | P | PAT scope violations per project (and optional task): `id`, `project_slug`, `task_key`, `scope`, `detail`, `status` (`open \| resolved`), `created_at`, `resolved_at`, `resolved_by`; at most one open row per (`project_slug`, `scope`, `task_key`). |
| `agent_os_users` | P | Ruling 460: `user_id` (primary key), `os_uid` (UNIQUE), `created_at` — the OS user a person's agent processes run as, allocated once by `agentUidFor` as one more than the highest ever allocated (20001 for the first) and never deleted: deliberately no foreign key to `users`, because a removed account's transcripts stay on disk owned by its uid, and a uid handed to a second person would own them. |
| `user_backend_credentials` | P | Ruling 127, ruling 507: one row per ACCOUNT a person connected on Claude or Codex, up to ten per (`user_id`, `backend`): `id`, `kind` (`login \| api_key \| access_token`), `method`, `secret_box`, `secret_suffix`, `detail_json`, `verified_at`, `label` (the person's own name for it, or NULL), `selected_at` (when it last became the active one), `legacy_home` (1 = connected before ruling 507, its sign-in in the backend home itself), `created_at`, `updated_at`; indexed on (`user_id`, `backend`, `selected_at`). `kind = 'login'` carries NO secret (the vendor binary holds it in the account's home under `runtimes/users/<id>/…`), only `method` (`claudeai \| console \| device`) and the non-secret `detail_json` the vendor reported; `api_key` / `access_token` carry a sealed `secret_box` + `secret_suffix`. `verified_at` is the last time the provider itself accepted the value (null on a ChatGPT workspace token, which has no free probe). Connecting adds a row; the ACTIVE account of a (person, backend), the one runs bill, is the newest `selected_at` (ties to the newer row). |
| `project_github_health` | P | The LAST repository-access probe per project: `project_slug`, `result_json`, `checked_at`, one row overwritten in place. An app-owned OBSERVATION, not a projection (a rebuild must not clear it), so the board and the home card can say a repository is unreachable without calling GitHub on a render path (U33-2). Written by project creation's own probe, the GitHub page's cached probe, a repository change's probe, the reconcile poller, which takes a failing reading again each tick (ruling 517), and a new reading after the project's credential or the token behind it changes (`refreshRepoAccess`, ruling 540); deleted with the project. A reading is read back only while the project still points at the repository it was taken of (ruling 517). |

The sealed columns are the ones `SEALED_STORES` (`app/server/secrets/key-rotation.server.ts`)
registers for key rotation: `github_pats.encrypted_token`, `org_mcp_servers.cred_ref`,
`oauth_providers.client_secret`, `s3_audit_config.secret_box` and
`user_backend_credentials.secret_box`.

### Org resources, models, controller

| Table | Kind | What it holds |
|---|---|---|
| `org_knowledge_bases` | P (metadata) | `id`, `name`, `dir` (unique; the grant key), `refresh` (`manual \| on change`; the CHECK still admits `nightly`, which nothing writes), `last_indexed_at`, `created_at`, `updated_at`. Content is the folder on disk. |
| `org_skills` | P (metadata) | `id`, `name` (unique; slug and folder), `summary`, `created_at`, `updated_at`. Content is `skills/<name>/SKILL.md`, judged by `assertSkillBodyWellFormed` at every writer (ruling 183). |
| `org_mcp_servers` | P | `id`, `name` (unique slug), `transport` (`HTTP \| stdio`), `target` (endpoint or command), optional sealed credential `cred_ref`, probe results (`tools_count`, `up`, `last_checked_at`, `last_error`), warm-up bookkeeping (`warming_since`, `first_success_at`, `heuristic_warmups`), `created_at`, `updated_at`. Ruling 176: `tool_policy_json` (the admin-marked write tools as `{ name, gate: "repo-write" }`; NULL until first reviewed, `[]` a reviewed none) and `tool_names_json` (the names the last successful probe listed, kept across a failed one and cleared when the target changes). Ruling 469: `oauth_ref` (the sealed OAuth sign-in: endpoints, registered client, tokens) and `oauth_json` (its public half: status, expiry, whether it renews, issuer host, the challenge's metadata URL, an expiry's reason and, ruling 486, the `scope` the server granted). Ruling 486: `oauth_requested_scope` (the scopes an admin asks the next sign-in for, space-joined; NULL asks for the resource's advertised `scopes_supported`). |
| `model_availability` | C | Models the provider refused for this account, keyed (`backend`, `model`): `reason` (the provider's redacted sentence), `marked_at`, `run_id`. Written only from a real run's failure and cleared by a real run's success; presence = unavailable. |
| `controller_conversations` / `controller_messages` | P | The controller's transcripts, owned by the asking user. `controller_conversations`: `id`, `user_id`, `user_label`, the scope (ruling 121) `project_slug` + `task_key` (both null = instance, slug alone = board, slug + key = one task; `CHECK (task_key IS NULL OR project_slug IS NOT NULL)`), `title`, `created_at`, `updated_at`, `last_message_at`, and `seen_seq`, the highest message `seq` the owner has seen (ruling 448). `controller_messages`: `id`, `conversation_id`, `seq` (unique per conversation), `author` (`user \| controller`), `user_id` (null on controller rows), `text`, `run_id` (the run behind a controller reply), `surface` (the in-app path a user message was sent from), `created_at`, `reply_to`, on a controller row the id of the user message it answers (ruling 465), `unlinked_history`, 1 on an old user message whose answer the backfill could not prove (earlier history, not linked; boot recovery skips it), and `steered_into`, on a user message a running turn read at one of its steps, the message that turn answers (ruling 527; it has no reply of its own and boot recovery skips it). A retracted message (ruling 527) is deleted, so `seq` can have gaps. `controller_message_files` (ruling 573): the files a person sent with a user message, one row each: `id`, `message_id` and `conversation_id` (both `ON DELETE CASCADE`, so a retracted message or a deleted conversation takes its files), `name` (unique per conversation, case-folded by the writer: `screenshot.png`, then `screenshot-2.png`), `bytes`, `data` (the file itself, a BLOB, so a backup's `VACUUM INTO` carries it and a message and its files commit in one transaction) and `created_at`. A transcript read carries each message's files' ids, names and sizes in the same statement (`MESSAGE_FILES_COLUMN`), never the bytes. |
| `controller_follow_ups` | P | What a controller conversation left itself to do when a task is accepted (ruling 685): `id`, `conversation_id` (deleted with the conversation), `user_id` (the person who asked, as whom the next turn runs), `project_slug` + `task_key` (the task waited on), `text` (the step, at most 2,000 characters), `created_at`, `fired_at` (set once, by the acceptance that claims the row, so one acceptance starts one turn), `outcome` (the started turn's state, or why none started) and `message_id` (the message Viberr sent to open the turn; the turn that answers that message is the one a follow-up started, and leaves no further step). A conversation holds one open row a task. Deleting the project drops its open rows (as its other app-owned rows, ruling 274); a started one stays with its conversation. |

### Runs

| Table | Kind | What it holds |
|---|---|---|
| `agent_runs` | P | One row per run. Identity and routing: `id`, `project_slug`, `task_key`, `thread_id`, `role` (the engagement's role), `kind`, `backend` (`claude \| codex`), `model`, `session_id`, `sdk`, `agent_name`, `agent_profile_id`. Lifecycle: `state` (`queued \| running \| finished \| error \| interrupted`), `phase`, `step` (what a live run is doing; on a `queued` row the step says when it waits for the summary of its session's last run and not for a slot, and a terminal row keeps the phase "Compacting context" with the step "after the run ended" while its session's completion compaction is in flight, ruling 701), `started_at`, `finished_at`, `created_at`, `updated_at`, `interrupted_by` (the person, or null) and `interrupted_reason` (`restart` when boot recovery stopped it, else null). Usage: `turns`, `input_tokens`, `cached_input_tokens`, `output_tokens`, `total_cost_usd`, `usage_final`. Completion contract: `outcome_key`, `dispatched_by_name`, `dispatched_by_user_id`, `no_checkout` (ruling 248), `verdict_withheld` (ruling 316), `review_subject` (ruling 544). Credential: `credential_user_id`, `credential_kind`. Prompt cache (ruling 369): `cache_write_tokens`, `first_call_prompt_tokens`, `first_call_cache_write`, `first_call_cache_read`, `first_call_warm`, `first_call_miss_reason`, `cache_ttl_bucket`, `peak_prompt_tokens`, `last_prompt_tokens`, `compactions`. |
| `run_log_lines` | C | Projected console lines per run: `id`, `run_id`, `seq` (unique per run), `occurred_at`, `raw_json`, `display_json`, `created_at`. Retained 30 days; the `.jsonl` file is the truth. |
| `staged_outcomes` | C | A Claude `report_outcome` envelope staged mid-run (`outcome_key`, `outcome_json`, `created_at`; the run's first; a later call is refused) until the completion callback consumes it; orphans pruned after 24 h. |

`agent_runs` column notes:

- `kind` is a **delivery axis**, not a role: `operator` is the operator's own run,
  `primary` a delivering engagement, `reviewer` any supporting run whatever its role, and
  `controller` a controller turn. Controller turns use `project_slug = ''` and
  `task_key = <conversation id>`, so no task-scoped query matches them. `primary` and
  `reviewer` are slot-era names kept by ruling 458(e): `agent_runs` is a primary table, so
  no rescan can rewrite its rows, and the two single-flight indexes below are keyed on them.
- `usage_final` (F35-1) is 1 once a provider usage figure landed; while it is 0 the token
  columns hold the Claude adapter's live estimate or nothing, which the Live run panel prints
  as an estimate and Insights leaves out of its token sums. A stopped or errored run never
  gets a provider figure, so its 0 is permanent.
- `no_checkout` is 1 when the run's workspace checkout could not be provisioned; the verdict
  path (envelope and prose fallback) is closed for such a run. `verdict_withheld` is 1 when
  the run was dispatched with its verdict channel withheld, so a reply without an envelope
  verdict is an answer and the prose fallback does not manufacture one. `review_subject`
  (ruling 544) is the task's review subject when the run was dispatched (`reviewSubjectId`,
  or `none` when nothing had been delivered); the run's verdict binds only if the task still
  has it at completion. NULL on the operator's and the controller's runs and on rows from
  before the ruling, which bind to the subject at completion.
- The prompt-cache columns are folded by the run sink from the provider's own usage figures.
  The `first_call_*` columns describe the first model call and stay NULL until one lands
  (NULL for ever on a run that never reached the provider); `first_call_warm` is 1 when that
  call read more than it wrote; `cache_ttl_bucket` is `5m`, `1h` or `mixed` (NULL on Codex);
  `last_prompt_tokens` is the size a resume replays (ruling 372).
- `credential_kind` (`login`, `api_key`, `access_token`) is the kind of credential the run
  billed, which decides the TTL the resume policy assumes; NULL on a refused run.
  `credential_account_id` (ruling 507) is which of the principal's accounts it billed
  (`user_backend_credentials.id`, no foreign key: the run outlives the account); NULL on a
  refused run and on runs from before the ruling.

`agent_runs.credential_user_id` is the run's **credential principal** (ruling 127):
whose connected backend account it billed, and therefore whose runtime home holds
its transcript. Task runs carry the task owner, controller turns the asker; a run
refused because that person has not connected THAT backend still records them, so
the refusal is auditable rather than anonymous. It is NULL only on a run that was
refused before any credential was looked up: an unowned task, or one whose owner
account is gone or disabled. No process was ever started in either case.

### Indexes

| Table | Indexes |
|---|---|
| `users` | `idx_users__email` UNIQUE (`email`) |
| `audit_events` | `idx_audit_events__occurred_at`, `idx_audit_events__actor_user_id`, `idx_audit_events__action`, `idx_audit_events__task_action` (`project_slug`, `task_key`, `action`, `occurred_at`; the task page's last-check read, ruling 457) |
| `project_members` | `idx_project_members__user_id` |
| `task_projections` | `idx_task_projections__stage` (`project_slug`, `stage`) |
| `task_events` | `idx_task_events__task` (`project_slug`, `task_key`, `position`), `idx_task_events__occurred_at` |
| `diagnostics` | `idx_diagnostics__source_path`, `idx_diagnostics__task` (`project_slug`, `task_key`) |
| `provenance` | `idx_provenance__source_path`, `idx_provenance__observed_at`, `idx_provenance__path_action` (`source_path`, `action`; the per-task reconcile reads, ruling 457) |
| `notifications` | `idx_notifications__user` (`user_id`, `occurred_at DESC`), `idx_notifications__user_task` (`user_id`, `task_key`, `kind`) |
| `github_pats` | `idx_github_pats__user_id` |
| `scope_violations` | `idx_scope_violations__project_status` (`project_slug`, `status`), `idx_scope_violations__task` (`project_slug`, `task_key`), `idx_scope_violations__open_unique` UNIQUE (`project_slug`, `scope`, `coalesce(task_key, '')`) WHERE `status = 'open'` |
| `github_connections` | `idx_github_connections__default` (`is_default`) |
| `controller_conversations` | `idx_controller_conversations__user` (`user_id`, `last_message_at DESC`), `idx_controller_conversations__scope` (`user_id`, `project_slug`, `task_key`, `last_message_at DESC`) |
| `controller_message_files` | `idx_controller_message_files__message` (`message_id`) |
| `controller_follow_ups` | `idx_controller_follow_ups__task` (`project_slug`, `task_key`, `fired_at`) |
| `agent_runs` | `idx_agent_runs__task` (`project_slug`, `task_key`), `idx_agent_runs__state`, `idx_agent_runs__thread` UNIQUE (`project_slug`, `task_key`, `thread_id`), `idx_agent_runs__one_delivering` and `idx_agent_runs__one_live_per_support` (below) |
| `run_log_lines` | `idx_run_log_lines__run_seq` UNIQUE (`run_id`, `seq`) |
| better-auth | `session_userId_idx`, `account_userId_idx`, `verification_identifier_idx` |

Unique constraints declared on columns rather than as indexes: `user.email`, `session.token`,
`github_connections.owner`, `google_domain_allowlist.domain`, `org_knowledge_bases.dir`,
`org_mcp_servers.name`, `org_skills.name` and `controller_messages (conversation_id, seq)`.
(`user_backend_credentials (user_id, backend)` was one until ruling 507 let a person keep
several accounts per backend.)

Two partial unique indexes on `agent_runs` enforce single-flight at the DB layer:
`idx_agent_runs__one_delivering` (one queued or running `primary` run per task) and
`idx_agent_runs__one_live_per_support` (one queued or running supporting run per profile per
task). The run service translates a violation into a 409. Boot re-creates the second
idempotently for older data roots (`ensureSingleFlightIndexes`); a root that already holds
duplicate live rows gets a WARN and a retry on the next boot.

## 4. Naming conventions

Viberr's own tables are plural snake_case with snake_case columns, `<entity>_id`
foreign keys and `idx_<table>__<cols>` indexes. Rows become camelCase domain shapes at the
module boundary: `app/shared/mapping/` for projects, tasks, task events, users, notifications
and actors, and otherwise the one module that owns the table (for example
`app/server/runtimes/run-store.server.ts` for `agent_runs`). The four better-auth tables are
the documented exception (singular, camelCase). Timestamps are UTC ISO 8601 strings;
booleans are `0/1` in SQLite.

## 5. Retention and growth

| Store | Window | Where enforced |
|---|---|---|
| `run_log_lines` | 30 days | `applyRetention` (boot + every maintenance pass) |
| `audit_events` | 90 days, appended to `audit-exports/audit-events-<YYYY-MM-DD>.jsonl` first; an export failure skips that pass's purge; `task.agent.replied` and `runtime.operator.plan_executed` are exempt because boot recovery uses them as idempotency keys | `applyRetention` |
| `notifications` | newest 500 per user | `applyRetention` |
| `staged_outcomes` | consumed rows deleted; orphans older than 24 h pruned whenever an outcome is staged | `agent-outcome.server.ts` |
| `runtimes/<backend>/*.jsonl` | `VIBERR_TRANSCRIPT_RETENTION_DAYS` (30; `0` keeps them for ever), by file mtime | `pruneRuntimeTranscripts` |
| `runtimes/users/*/claude-home/projects/**/*.jsonl`, `runtimes/users/*/codex-home/sessions/**/*.jsonl` | `VIBERR_SESSION_HOME_RETENTION_DAYS` (30; `0` keeps them for ever), by file mtime; emptied date folders are removed. Extension-gated to `*.jsonl`: `auth.json`, `.credentials.json` and `.claude.json` are the vendor-held sign-ins and config and are never touched, so retention cannot sign a person out (ruling 127) | `pruneRuntimeTranscripts` |
| task `workspace/` clones | removed once the task is in its project's terminal stage. At boot this runs after run recovery; a periodic pass skips the whole step while any run on the instance is queued or running | `reclaimTerminalTaskWorkspaces` (`app/server/tasks/workspace-retention.server.ts`) |
| `.viberr-plugins/<runId>/`, `codex-home/runs/<runId>/` | removed when the run settles | `removeSkillPlugin`, `finishCodexRunHome` |
| `.repo-mirror/` | each successful mirror build removes every sibling under `.repo-mirror/` (a killed build's `.building` sidecar, the mirror of a repository the project no longer uses) | `pruneStaleMirrors` (`repo-mirror.server.ts`) |
| `state/tmp/reader-<pid>/` | removed when the reader closes; a dead reader's copy is swept by the next reader | `openDatabaseReadOnly` |
| `provenance` | none | manual `DELETE … WHERE observed_at < …; VACUUM;` with the app stopped |
| `controller_conversations` / `controller_messages` / `controller_message_files` | none | a file goes with its message (Retract) or its conversation (delete, ruling 525) |
| `controller_follow_ups` | none | a step goes with its conversation (delete, ruling 525, which says so on the task) and with its project (delete); a started or refused one stays as the record of what became of it |
| better-auth `session` rows | none on a timer; expired rows are simply never honoured | sign-out, password change, admin disable/reset, or the auth guard on a disabled user |
| `attachments/` | one **completion-time prune** (ruling 105): when a run finishes (and no sibling run on the task is live), the machine-stamped non-visual artifacts its browser MCP wrote (a short lowercase prefix plus the MCP's dashed-ISO stamp, such as `page-*.yml` and `console-*.log`; png/jpg/webp/gif/pdf are always kept) are deleted unless the exact filename is cited in the run's reply, its evidence rows or the timeline since it started (any entry's text, evidence rows or claimed files, ruling 593). A run that finishes while a sibling is live deletes nothing and claims only the working files it cited, so the sibling's completion decides the rest and no entry names a file that later goes (ruling 593). Beside another specialist run, live or finished inside its window, a run that does not deliver claims only the files its own words name and never one the delivery holds (ruling 627). Deliberately named files, every screenshot or PDF and every person's upload stay. No age- or size-based retention beyond that: the rest of the directory rides with the task | `pruneBrowserWorkingArtifacts` (`app/server/files/task-attachments.server.ts`, driven from `applyAgentCompletionEffects`); archive/delete of the task |
| `sources/` (a task's kept sources) | none: a kept source is never pruned or overwritten (ruling 690). It goes with its task's directory, so with the project when the project is deleted. After 30 days it is the only copy of what a run read: `run_log_lines` and the raw run log are gone by then, and the record's `runId` names an `agent_runs` row whose lines went with them | `writeTaskSource` (`app/server/files/task-sources.server.ts`) writes it; nothing removes it |

The maintenance pass (`runMaintenancePass`: retention, transcript pruning, workspace reclaim)
runs at boot and then every `VIBERR_MAINTENANCE_INTERVAL_SECONDS` (default 6 h). A disk check runs
every `VIBERR_DISK_CHECK_INTERVAL_SECONDS` (default 5 min), logs each transition between `ok`,
`low` and `critical`, and while the status is not `ok` triggers an extra pass at most every
30 minutes. Every pass logs `store maintenance pass` even when it removed nothing, which is
how an operator confirms the timer is alive; `/resources/health` reports
`maintenance.lastPassAt`.

## 6. Schema changes

The baseline is the schema. A change to `0001_baseline.sql` reaches fresh databases only; an
existing root keeps its old DDL. Two mechanisms cover the gap.

**Healed at open.** `getDb` runs `ensureSingleFlightIndexes` (the single-flight index on
`agent_runs`, `idx_agent_runs__one_live_per_support`) and `ensureBaselineColumns`
(`app/server/db/sqlite.server.ts`) after the migrations, idempotently on every open. The
second adds each missing `BASELINE_COLUMNS` entry with `ALTER TABLE … ADD COLUMN`:

- `agent_runs`: `dispatched_by_name`, `dispatched_by_user_id`, `credential_user_id`,
  `interrupted_reason`, `usage_final` (backfilled to 1 on `finished` rows), `no_checkout`,
  `verdict_withheld`, `review_subject` (ruling 544) and the eleven ruling-369 columns
  (`cache_write_tokens` through `credential_kind`), and `credential_account_id` (ruling 507);
- `controller_conversations`: `task_key`, `seen_seq` (backfilled to each conversation's
  newest `seq`, so existing threads count as read);
- `org_mcp_servers`: `tool_policy_json`, `tool_names_json`, `oauth_ref`, `oauth_json`,
  `oauth_requested_scope` (rulings 469 and 486; no backfill, NULL is the truth for an older row);
- `controller_messages`: `surface`, `reply_to` and `unlinked_history` (one walk backfills
  both: it replays the writers' order and links only what it proves, a run's reply to the
  oldest waiting message while the walk is in step, a refusal to the message directly
  before it; at a restart or a failed start it stops, and what was still waiting is marked
  earlier history that boot recovery does not note; a root the first `reply_to` backfill
  already linked is walked again when it gains `unlinked_history`, ruling 465's dated note),
  and `steered_into` (ruling 527; no backfill, nothing before it could steer a turn);
- `github_connections`: `reach_json` (ruling 463; no backfill, NULL says "not read yet");
- `github_pats`: `repo_scopes_json` (ruling 480; no backfill, NULL is "nothing stored yet");
- `projects`: `required_reviewers_json`, `gates_json` (ruling 482; `'[]'` is the truth for
  every project that predates it);
- `task_projections`: `recommendation_kinds`, `epic_id` (ruling 503; no backfill, NULL says
  "in no epic");
- `notifications`: `href` (ruling 497; no backfill, NULL opens the task or the board, where
  every older row opened).

It also creates the `BASELINE_TABLES` (`project_github_health`, `agent_os_users`,
`epic_projections`, `controller_message_files`, `controller_follow_ups`), brings `user_backend_credentials` to the baseline's shape
(`ensureBackendAccountsTable`, ruling 507: creates it on a root that predates it, and on a root
that still has `UNIQUE (user_id, backend)` rebuilds it once from the baseline DDL in one
transaction, carrying every row as its person's active account with `legacy_home = 1`) and
`BASELINE_INDEXES` (`idx_controller_conversations__scope`, `idx_audit_events__task_action`,
`idx_provenance__path_action`, `idx_task_projections__epic`, `idx_controller_message_files__message`,
`idx_controller_follow_ups__task`) with `IF NOT EXISTS`. The healer adds neither the baseline's column CHECKs (its `ADD COLUMN` definitions leave
them out) nor the table-level conversation-scope CHECK, so an upgraded root lacks both; the
writers enforce those values instead.

**Reported at boot.** `logBootIntegrity` (`app/server/boot.server.ts`) compares the live
root with the shipped baseline and logs a `projection schema drift` WARN naming the remedy for
two shapes: a CHECK that refuses a value the build now produces
(`task_projections.validation`, `task_projections.waiting`, `notifications.kind`,
`epic_projections.status`; boot widens `notifications.kind` in place first, ruling 481), and a
column the rebuilder INSERTs that the live `task_projections` / `task_events` lacks (for
example `blocked_by_json` or `board_rank`, which the open-time healer does not add). The
second shape is additive, and the WARN prescribes `ALTER TABLE <table> ADD COLUMN <column>`.
For a CHECK that no ALTER can widen, the remedy is to re-baseline, preferably preserve-copy
(fresh file + migrations, then copy the non-rebuildable tables across with foreign keys off,
the shape `selfHealProjectionDbIfCorrupt` in `app/server/db/self-heal.server.ts` implements),
because the blunt form (stop the app, `npm run backup`, delete `state/projection.sqlite*`,
start) regenerates user ids and destroys every primary row in the file. Both are written out in
[../operations/deployment.md](../operations/deployment.md#re-baselining-the-projection-database).

`npm run seed -- --reset` deletes `projects/`, `agents/profiles/` and the
`runtimes/<backend>/` transcripts, and empties `staged_outcomes`, `run_log_lines`,
`agent_runs`, `notifications`, `provenance`, `diagnostics`, `scope_violations`, `user_prefs`,
`task_events`, `task_projections`, `project_members` and `projects` (the full rescan that
follows prunes the orphaned `epic_projections` rows). The same command then deletes `kb/` and `skills/` and empties
`org_knowledge_bases`, `org_mcp_servers`, `org_skills` and `google_domain_allowlist` before
reseeding the example knowledge bases and skills (`seedOrgResources`). It
keeps users and better-auth tables, GitHub connections and PATs, backend credentials, audit
rows, controller transcripts and the per-person runtime homes
([../development/scripts.md](../development/scripts.md) §3 lists both sides). The owner kept this convention at launch
(ruling 683).

## 7. Identity and ids

`newId(prefix)` mints `<prefix>_<12 base64url chars>` (9 random bytes). Prefixes in use:
users `u_`, better-auth credential accounts `acct_`, audit rows `evt_`, notifications `ntf_`,
runs `run_`, packets `pkt_`, work revisions `rev_`, recommendations `rec_`, schedules `sch_`,
queued questions `qq_`, outcome keys `oc_`, PATs `pat_`, backend credentials `ubc_`,
knowledge bases `kb_`, skills `sk_`, MCP servers `mcp_`, allowlisted domains `dom_`, scope
violations `sv_`, controller conversations `cnv_` and messages `cmsg_`, controller resource
requests `rq_`. Other ids: a GitHub connection's id is `slugify(owner)`, the S3 target's is
`default`, an epic's is `epic-<n>` (the next free number in the project's `epics/`), and
session ids are better-auth's. Compare users by id everywhere; display names are render-only
(ruling 6). Task keys are `<PREFIX>-<n>` allocated by `allocateTaskKey` from `project.md`
`nextTaskNumber` under the project file mutex, with a directory max-scan rescuing a stale
counter; `EPIC` is a reserved prefix (ruling 503; it was `GOAL` before). Actor references inside files use the codec in
`app/server/files/actor-ref.server.ts` (`user:<id> (Name)`,
`agent:<backend>/<profileId> (Role)`, `operator`, `controller`, `system:<id>`).
