# Record verification: does what viberr SHOWS match what HAPPENED

Reader-agent output, pass 35 (k9s-clone observation), 2026-09-06. Every claim below was
checked against the working tree of `pass35/k9s-clone-observation` (treated as main). "verified
in `<file>:<line>`" means the code was read; "docs claim, code disagrees" lines are collected in
§16 as candidate findings. Files are truth; SQLite holds projections plus app-owned primaries.

Conventions used here: no secrets are ever selected (never `secret_box`, `encrypted_token`,
`client_secret`, `account.password`, `session.token`). SQL string literals use SINGLE quotes;
double quotes are identifiers (a live probe with `type="table"` failed with
`no such column: "table"`; `type='table'` works). Every live-DB read runs INSIDE the container,
read-only, via stdin heredoc (so the SQL can carry single quotes): NEVER host `sqlite3` against
`docker-data/state/projection.sqlite` (VirtioFS shared mapping → SIGBUS in the container; runbook
"Readers, and where they must run", `docs/operations/runbook.md:429-463`).

Live facts at write time: container `viberr-app-1` (image `viberr-app`, healthy), Node `v26.8.1`
inside, `VIBERR_DATA_ROOT=/data` mapped from `./docker-data` (verified in `compose.yml:23,55`).
The root currently holds ZERO projects (`SELECT slug FROM projects` → `[]`), one user, and
`instance_settings` keys `backendRateLimit.claude` and `projection.derivationVersion`.

## 1. Data-root layout (docker-data on host = /data in container)

| Path | What | Canonical? | Verified |
|---|---|---|---|
| `projects/<slug>/project.md` | project truth | yes | `file-store-root.server.ts:57-63` |
| `projects/<slug>/tasks/<KEY>/task.md` | task truth | yes | `:65-75` |
| `projects/<slug>/tasks/<KEY>/attachments/` | agent-posted files, served member-only at `/projects/:slug/tasks/:key/attachments/:file` | bytes canonical, not projected | `:77-90`, `app/routes.ts:75-78` |
| `projects/<slug>/tasks/<KEY>/workspace/<repo>` and `workspace/support/<profileId>/<repo>` | git clones; cache, reclaimed for terminal-stage tasks | no | `docs/architecture/data-model.md:62-63`; not watched (`file-watch.service.server.ts` ignores below task dir) |
| `projects/<slug>/goals/<goal-id>.md` | chained goal truth | yes | `:92-104` |
| `projects/<slug>/.repo-mirror/` (or equivalent) | bare mirror cache | no | data-model.md:65 says "or equivalent"; owned by `app/server/tasks/repo-mirror.server.ts` (path not verified here) |
| `agents/profiles/<id>.md` | org agent templates | yes | `:106-108` |
| `agents/definitions/{operator,controller}.md` | shipped doctrine | app-written | `:114-117` |
| `runtimes/<backend>/<runId>.jsonl` | raw NDJSON run transcript, ONE file per run | run truth | `run-store.server.ts:443-460` |
| `runtimes/users/<userId>/claude-home/projects/<cwd-as-dashes>/<sid>.jsonl` | Claude provider session | vendor-written | `session-export.server.ts:18` |
| `runtimes/users/<userId>/codex-home/sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl` | Codex session | vendor-written | `:19` |
| `kb/<dir>/`, `skills/<slug>/SKILL.md` | KB / skill folders | content canonical, metadata in DB | `:180-200` |
| `audit-exports/audit-events-<YYYY-MM-DD>.jsonl` | rows exported before the 90-day audit purge | app-written | `retention.server.ts:110` |
| `state/projection.sqlite` (+`-wal`,`-shm`), `state/writer.lock`, `state/shipped-assets.json` | DB, lock | DB primary for app tables | `sqlite.server.ts:36` |

`DATA_ROOT_SUBDIRS` created at boot: `projects agents agents/profiles runtimes runtimes/users kb
skills audit-exports state` (verified `file-store-root.server.ts:27-47`; live `ls docker-data`
shows exactly `agents audit-exports kb projects runtimes skills state`). No `cache/`, `auth/`,
`logs/`.

Write discipline (verified `docs/architecture/file-formats.md:62-74`, `atomic-file.server.ts`):
writers stage `<file>.<rand>.tmp` then rename; watcher ignores dotfiles and `*.tmp`;
`WATCH_DEBOUNCE_MS = 250` (`file-watch.service.server.ts:33`). Order of a canonical write:
file → re-parse → re-project → audit → SSE.

## 2. `task.md` format (source: `app/schemas/task-file.schema.ts`)

Frontmatter keys in canonical write order (`TASK_FRONTMATTER_KEYS`, `:1133-1171`):

| Key | Type | Meaning | Verified |
|---|---|---|---|
| `key` | `^[A-Za-z]+-\d+$` | task key | `:744` |
| `title` | string | | |
| `stage` | stage id from project.md | | |
| `previousStageId` | string \| null | where the task came from; null until first transition | `:751` |
| `heldAtStage` | string \| null | durable deliberate-hold marker; cleared by transition, packet resolution, goal edit; NOT by manual operator run | `:764` |
| `readiness` | `ready \| input_required \| inconsistency_risk_detected \| blocked` | STORED value; projection derives the effective one | `:28-33` |
| `waiting` | `human \| agent \| none` | | `:36` |
| `ownerUserId` | string \| null | one human owner (credential principal, ruling 127) | |
| `engagements[]` | `{profileId, backend: codex\|claude, role, delivers, verdictCapable, pinnedBackend?}` | at most one `delivers: true` | `:196-224` |
| `operator` | `{assignedAtStageId}` \| null | | `:238-241` |
| `recommendations[]` | `{id, kind: transition\|run_agent\|accept_completion\|delivery, profileId?, prompt?, delivers?, toStageId?, label, detail, forHeadSha?}` | pending operator cards | `:247-300` |
| `schedules[]` | `{id, action: run-operator\|run-agent, dueAt, profileId?, prompt?, status: pending\|claimed\|fired\|failed\|cancelled, claimedAt?, firedAt?}` | | `:307-325` |
| `urgent` | boolean | derived from `priority === 'urgent'` at write | |
| `priority` | `low \| normal \| high \| urgent` | | `:49` |
| `labels[]` | string[] | | |
| `dueDate` | `YYYY-MM-DD` \| null | | |
| `blockedBy[]` | `JC-6` or `goal-1 link 3` spellings | non-empty floors derived readiness at `blocked` | `:796` |
| `archived` | boolean | | |
| `validation` | `healthy \| changed \| failing \| none \| bypassed` | DERIVED cache recomputed on write; `bypassed` only with `acceptance: forced` | `:45` |
| `workRevision` | `{id: rev_…, headSha, treeSha, branch, createdAt, sourceProfileId, kind?: delivered\|verified}` \| null | | `:631-668` |
| `verdicts[]` | `{profileId, revisionId, headSha, result: approve\|request_changes, reason, at}` | bound to a revision | `:681-696` |
| `baseRefreshes[]` | `{mergeSha, baseSha, base, commits, at}` | ruling 132 | `:722-738` |
| `branch` | string \| null | | |
| `pr` | `{number, state: review\|merged\|closed\|accepted, title, checks?, review?, mergeable?, headSha?, revisionDrift?: {headSha, authored, baseRefresh: {merges, commits}\|null}, unpushedRevision?: {revisionSha, prHeadSha, relation: behind\|diverged\|unknown}}` \| null | reconciler-owned cache | `:424-490` |
| `noChanges` | boolean? | no-change completion flag; cleared when a PR opens | `:842` |
| `acceptance` | `forced` \| null? | durable force-accept fact | `:849` |
| `github` | `{commits: [{sha,msg}], changed: {files,add,del}\|null, unownedPr?: number\|null}` \| null | | `:548-566` |
| `goalRef` | `{goalId, linkIndex}` \| null | | `:858-865` |
| `createdAt`, `updatedAt` | ISO \| null | | |
| `boardRank` | number \| null | | `:869` |

`repo` is NOT a task key (unknown key, preserved verbatim, ignored; `:1160-1161`). Unknown keys
round-trip. Parsing is tolerant per field (never throws, never drops a task); a bad field falls
back with a diagnostic that floors derived readiness (warning → `input_required`, error →
`inconsistency_risk_detected`, hard stop → `blocked`).

Body sections: `## Goal`, `## Packet` (only while open), `## Timeline`; unknown `## X` kept
verbatim; duplicate known sections: first wins + `body.duplicate_section` warning.

### 2.1 Packet (`taskPacketSchema`, `:604-650`)

`id: pkt_…` (minted `newId("pkt")`, `operator-actions.server.ts:1189`, `agent-outcome.server.ts:461`),
`type: input | blocked`, `kind` (pill label: operator writes `"Blocked decision"` or
`"Decision required"` (`operator-actions.server.ts:1191`); agent question packets write
`"Agent question"` (`AGENT_QUESTION_PACKET_KIND`, `agent-outcome.server.ts:435`) with
`askedBy: <profileId>`), `from` (actor ref string), `title`, `body`, `observations[] {k, v, code}`,
`options[] {kind, t, d, rec, ev?, backend?, profileId?, deleteBranch?, goalDraft?}`,
`awaiting: goal_edit?`, `decided: {optionIndex, at, byUserId}?`.

`PACKET_OPTION_KINDS` (11, `:131-172`): `accept_completion request_edit block_on_policy
hold_runtime_debug redirect retry_other_backend edit_goal archive_task discard_branch
resolve_remote_collision custom`. No acceptance marker field; acceptance gated on the kind alone
plus admin|maintainer re-check.

### 2.2 Timeline grammar (verified `file-formats.md:417-468` against `TIMELINE_EVENT_TYPES :110-128`)

- Newest first; heading `### <UTC ISO> · <type> · <actor-ref>` (U+00B7 separators).
- 11 types: `comment completion github policy note quality transition blocked agent assign continuity`.
- Optional metadata lines right after the heading: `title: <text>`, `to: agent`; after the text an
  `evidence:` block (`- <label> · <add> · <del>`) and/or `attachments:` block.
- Body-line escaping with one leading backslash for `## `, `### `, `title:`, `to:`, bare
  `evidence:`/`attachments:` lines.
- Actor refs (`actor-ref.server.ts`): `user:<id>` or `user:<id> (Name)`;
  `agent:<backend>/<profileId>` (+ optional ` (Role)`); `operator`; `controller`; `system:<id>`
  (`system:policy-engine`, `system:delivery`, `system:dependency-release`).

WHO writes WHAT (the event you must find after each act):

| Act | type · actor | text (exact or shape) | Verified |
|---|---|---|---|
| Human/operator stage move | `transition` · human or `operator` | `**Transition:** moved KEY from <From> to <To>.` / `**Transition:** operator moved KEY from … to ….` | `task-actions.server.ts:4902-4907` |
| Packet resolution (most kinds) | `transition` · human | `option.ev` if authored, else `**Decision:** <option.t>.`; a free-text note is appended as `\n\n> note` | `:7114-7117, 7148-7151, 7183-7186, 7255-7268` |
| `edit_goal` chosen | `transition` | `**Decision:** <t>. Waiting for the edited goal; the packet clears as soon as it lands.`; packet stays with `awaiting: goal_edit` + `decided` | `:7056-7061, 7255-7263` |
| `retry_other_backend` | `transition` | `**Decision:** <t>. Re-running on <Backend> with a fresh context.` | `:7079-7084` |
| `hold_runtime_debug` | `blocked` | `**Decision:** hold for runtime debug. KEY stays blocked while …` | `:7030-7035` |
| `block_on_policy` | `transition` | `**Decision:** <t>. KEY is unblocked and the operator …` | `:6998-7008` |
| `redirect` (summon) | `transition` | `**Decision:** <t>. Operator re-engages the specialist with a summon note.` | `:7198-7203` |
| Human accept (with PR) | `completion` · human, `title: Completion accepted` | `Human acceptance recorded. KEY transitioned to **Done** and the review PR was merged.` (or `…; the review PR is **accepted, merge pending** (<cause>).` / `…(no linked pull request).` / `…had already been merged on GitHub (out of band).`) + drift note | `:9127-9140` |
| No-change accept | `completion` · human, `title: Completed with no changes` | `<who>: **KEY completed with no changes**. Nothing was delivered and there was no pull request to merge: no \`<branch>\` branch exists on the remote, checked against \`<base>\`…` (forced variant: `**KEY closed as "no changes"** WITHOUT a passing remote re-check.`) | `no-change-completion.server.ts:389-423` |
| Operator opens packet | `comment` (input) or `blocked` (blocked) · `operator`, `title: <packet title>` | `**Decision packet:** <title>. Awaiting a human decision.` / `**Blocked:** <title>. Opened a decision packet for the owner to resolve.`; frontmatter `waiting: human`, `readiness: blocked` for blocked | `operator-actions.server.ts:1212-1224` |
| Agent final reply | `comment` · `agent:<backend>/<profileId>` | the reply text; `evidence:`/`attachments:` ride it when no verdict | `task-actions.server.ts:2178-2196, 3168-3170` |
| Agent verdict | `quality` · agent | `**Validation:** <healthy\|failing>. <summary>`; `verdicts[]` gains `{profileId, revisionId, headSha, result, reason, at}` | `:3193-3205` |
| Agent saved files, no verdict | `note` · agent | `Saved N files to this task's attachments during the run.` | `:3179-3188` |
| PR opened (created only) | `github` · `operator` when operator-authorized, else human, else synthetic `agent:claude/implementation` | `Opened **PR #N** for review.`; frontmatter `pr: {number, state: review, title, …}` | `pr-open.server.ts:760-780` |
| PR adopted (reconciler or delivery found a PR on the branch) | `github` · `system:policy-engine` (reconciler) / `system:delivery` | `Adopted **PR #N** (head \`sha7\`, the delivered revision) as KEY's review PR[, replacing PR #M (state)]. Viberr did not open it; it was found on branch \`b\` with this task's delivered head.` | `pr-adoption-record.server.ts:35-61` |
| Delivery could not run / nothing to deliver | `github` · `system:delivery`, `title` `Delivery could not run` or `Nothing to deliver` (title lands in the `policy` notification, event title is null) | message names cause; `nothing_to_review` sets `noChanges: true`, mints `verified` revision, recomputes `validation` | `task-actions.server.ts:5601-5640, 6054-6090` |
| Reconciler divergence | `note` · `system:policy-engine` | `**Divergence:** PR #N was merged on GitHub, but KEY hasn't been accepted through Viberr, so its stage is unchanged. …` / `…was closed on GitHub without merging, but KEY is still active. …` / `**Note:** accepted PR #N was closed on GitHub without merging, so the pending merge can no longer be completed from Viberr.` | `github-reconciler.server.ts:688, 751-753, 829-863` |
| Merge by Viberr | `github` | `Merged **PR #N** into \`<default>\`.`; `pr.state: merged` | `:1402-1412` |
| Branch deleted | `github` | `Deleted branch \`b\` from GitHub.` | `:1702-1709` |
| Unowned PR closed (collision remedy) | `github` | `Closed unrelated PR #N that stood on branch \`b\` (it was not KEY's review PR).` | `:1827-1830` |
| Continuity reset | `continuity` · agent | `Runtime continuity was lost: the <backend> session behind <agent>'s thread no longer has a provider transcript, so it could not be resumed. The agent re-anchored on \`task.md\` and continued in a fresh session. …` | `run-service.server.ts:1213-1216` |
| Dependencies released | `note` · `system:dependency-release`, `title: Dependencies released` | | `dependencies.server.ts:387-390` |
| Task created with blockers | `note` "wait note" prepended | | `task-actions.server.ts:700-703` |

docs claim, code disagrees: `file-formats.md:365-372` shows agents writing
`completion · agent:codex/developer` with `title: Completion report`. No non-test writer emits a
`completion` event for an agent or the title "Completion report" (grep of `app/server`); the
only `completion` producers are human acceptance ("Completion accepted") and the no-change close
("Completed with no changes"). Agent output lands as `comment` (+`quality` for a verdict). See §16.

## 3. `project.md` (`app/schemas/project-file.schema.ts`, keys `:259-273`)

`name`, `slug` (`^[a-z0-9][a-z0-9-]*$`), `archived?`, `repo` (`owner/name` | null; ONE per
project), `defaultBranch`, `taskPrefix` (`^[A-Za-z]+$`; `GOAL` reserved), `nextTaskNumber`
(int | null; atomic key counter with directory max-scan rescue), `stages[] {id, name, color}`,
`workflow[] {from, to, boundary: auto|approval|human, by, locked}`, `members[] {userId, role:
admin|maintainer|contributor|viewer}`, `agents[] {profileId, capabilities[] {capabilityId, mode:
direct|recommend|human|off}, extras[] {label, mode}, definition? {kind, name, role, icon,
backends, model, effort, scope, desc, persona, stages, spanAll, autonomy: supervised|full,
resources {skills, mcps, kb}}}`, `credentialPolicy {credentialLabel, masked, requiredScopes[]}
| null` (NON-secret; PAT sealed in `github_pats`), `guardrails[] {id, desc, on, value?, unit?}`.
Body = description. Always-human capabilities (`merge-pull-request`, `transition-to-done`,
`change-project-policy`) are a server invariant, not file state (docs claim; not re-verified here).

## 4. Goal file `projects/<slug>/goals/<id>.md` (`app/schemas/goal-file.schema.ts`, STRICT parser)

Frontmatter (`:90-102`): `id`, `title`, `status: active|paused|attention|completed|cancelled`,
`createdBy`, `createdByLabel`, `onFailure: pause|continue`, `links[] {index (1-based), title,
goal, taskKey|null, status: pending|active|done|failed|skipped, note|null, blockedBy[]}`,
`createdAt`, `updatedAt`. Body: `## Description` then `## Timeline` of bullets
`- <UTC ISO> · <text>` newest first. Never deleted by the product.

Timeline bullet texts the advance engine writes (`goal-actions.server.ts`): `Goal created with N
link(s) by <label>.` (`goal-writer.server.ts:246`); `Link i (<title>) started as KEY[, waiting on
…].` (`:749-767`); `Link i (<title>) completed by KEY.` (`:840`); `Link i (<title>) failed:
<note>` where note is `Task KEY was archived.` or `Task KEY is missing from the store.` (`:845-848`);
`Link i (<title>) reopened: KEY left the final stage.` (`:833`); `Link i (<title>) recovered: KEY
is on the board again.` (`:857`); `Chain paused (attention): a link failed.` (`:870`); `Chain
resumed: the failed link is live again.` (`:881`); `Every link is settled. Goal completed.`
(`:887, 901`); `Link i failed and was skipped (onFailure: continue).` (`:895`).

## 5. Agent profile `agents/profiles/<id>.md` (`agent-profile-file.server.ts:29-90`)

`id`, `kind: operator|specialist|controller`, `name`, `role`, `desc`, `icon`, `backends[]`,
`model`, `effort?`, `scope`, `stages[]`, `spanAll`, `capabilities[]`, `extras[]`, `resources
{skills[], mcps[], kb[]}` (values are FOLDER names; a KB display name resolves to nothing).
Unknown keys are DROPPED on write (`AGENT_PROFILE_KNOWN_KEYS :90-106`), unlike task/project files.

## 6. SQLite tables (`db/migrations/0001_baseline.sql`; live list confirmed via `sqlite_master`)

Legend: P primary (not rebuildable), D derived from files, C cache. Live DB has exactly:
`account agent_runs audit_events controller_conversations controller_messages diagnostics
github_connections github_pats goal_projections google_domain_allowlist instance_settings
model_availability notifications oauth_providers org_knowledge_bases org_mcp_servers org_skills
project_github_credentials project_github_health project_members projects provenance
run_log_lines s3_audit_config schema_migrations scope_violations session sqlite_sequence
staged_outcomes task_events task_projections user user_backend_credentials user_prefs users
verification`. There is NO `attachments` table and NO `schedules` table (attachments are files;
schedules live in `task.md` → `task_projections.schedules_json`).

| Table | Kind | Key columns (baseline line) |
|---|---|---|
| `task_projections` | D | PK `(project_slug, task_key)`; `title stage readiness stored_readiness waiting urgent priority labels_json due_date blocked_by_json archived validation validation_block_reason acceptance('forced') continuity('degraded') owner_user_id specialist_json (delivering engagement) reviewers_json (supporting engagements) operator_json branch repo (always project's) pr_json github_json work_revision_sha goal packet_json recommendation_count schedules_json event_count comment_count diagnostic_count goal_id goal_link_index created_at updated_at source_path content_hash parsed_at board_rank` (`:72-184`; INSERT `rebuilder.server.ts:534-644`) |
| `task_events` | D | `id project_slug task_key position (0 = newest) occurred_at type actor_kind(human\|agent\|operator\|controller\|system) actor_ref (user id / `agent/<profileId>` / `operator` / `controller` / system id) actor_json title text to_agent evidence_json attachments_json`; replaced wholesale per task (`:185-205`; `rebuilder:648-700`) |
| `projects` | D | `slug name archived repo default_branch task_prefix description stages_json workflow_json agent_policy_json credential_policy_json guardrails_json source_path content_hash parsed_at` (`:49-65`) |
| `project_members` | D | `(project_slug, user_id) role` (`:66-71`) |
| `goal_projections` | D | PK `(project_slug, goal_id)`; `title status created_by created_by_label on_failure links_json (RECONCILED against task rows) description current_index links_total links_done …content_hash` (`:211-233`) |
| `diagnostics` | D | `project_slug task_key source_path severity(info\|warning\|error) code path message hard_stop observed_at` (`:234-245`) |
| `provenance` | C | `source_path content_hash observed_at action(projected\|removed\|error\|rescan\|github.reconcile\|github.merge) details_json`; no retention (`:246-254`) |
| `agent_runs` | P | `id task_key project_slug thread_id role kind(operator\|primary\|reviewer\|controller) backend model session_id sdk state(queued\|running\|finished\|error\|interrupted) phase step started_at finished_at turns input_tokens cached_input_tokens output_tokens total_cost_usd interrupted_by created_at updated_at agent_name agent_profile_id outcome_key dispatched_by_name dispatched_by_user_id credential_user_id` (`:513-574`; live PRAGMA matches). NO `effort` column: effort reaches the SDK only (`run-service.server.ts:863-871`) and is not persisted on the row. `kind` is the delivery axis: `primary` = delivering, `reviewer` = any supporting run. Controller turns: `project_slug = ''`, `task_key = <conversation id>`, `role = 'Controller'`, `kind = 'controller'`, `backend = 'claude'` (`controller-run.server.ts:427-433, 442-443`). Operator: `role 'Operator'`, `kind 'operator'` (`operator-run.server.ts:1664-1665`). `sdk` is `Claude Agent SDK` / `Codex SDK` (`run-service.server.ts:267-270`). `interrupted_by` = user id on a human interrupt, `restart` on boot recovery (`run-service:1800`, `run-recovery`). Unique partial indexes: one live `primary` per task, one live `reviewer` per profile per task (`:667-684`). |
| `run_log_lines` | C (30 days) | `run_id seq occurred_at raw_json display_json created_at`, unique `(run_id, seq)` (`:575-583`) |
| `staged_outcomes` | C (24 h) | `outcome_key outcome_json created_at` (`:697-701`) |
| `audit_events` | P (90 days, exported first) | `id(evt_…) occurred_at actor_user_id actor_label action subject_kind subject_id project_slug task_key details_json` (`:37-48`). `task.agent.replied` and `runtime.operator.plan_executed` exempt from purge (recovery idempotency keys; data-model.md:175, not re-verified) |
| `notifications` | P (newest 500/user) | `id user_id kind(packet\|approval\|mention\|quality\|policy\|controller\|dependency\|ownership) ptype(input\|blocked) title text actor_json project_slug task_key occurred_at read_at created_at` (`:255-276`; `NOTIFICATION_KINDS` `notification.server.ts:17-38`) |
| `controller_conversations` | P | `id user_id user_label project_slug task_key title created_at updated_at last_message_at`, `CHECK (task_key IS NULL OR project_slug IS NOT NULL)`; both null = instance scope, slug alone = board, slug+key = task (`:469-492`) |
| `controller_messages` | P | `id conversation_id seq author(user\|controller) user_id text run_id surface created_at`, unique `(conversation_id, seq)` (`:493-512`; inserted `controller-conversations.server.ts:409-416`) |
| `users` | P | `id email name title role(admin\|member) idp avatar_tone pwreset_required theme disabled created_at updated_at last_login_at created_by github_handle` (`:23-36`) |
| `user`/`session`/`account`/`verification` | P | better-auth (singular, camelCase). Never select `session.token`, `account.password` (`:611-625`) |
| `user_backend_credentials` | P | `id user_id backend(claude\|codex) kind(login\|api_key\|access_token) method(claudeai\|console\|device) secret_box secret_suffix detail_json verified_at created_at updated_at`, unique `(user_id, backend)`. Select only `backend kind method secret_suffix detail_json verified_at` (`:327-343`) |
| `github_pats` | P | `id user_id label encrypted_token token_suffix created_at last_validated_at validation_json` — never `encrypted_token` (`:307-316`) |
| `github_connections` | P | `id owner pat_id is_default repos_count expires_at` (`:367-376`) |
| `project_github_credentials` | P | `project_slug pat_id` (`:317-322`) |
| `project_github_health` | P (observation) | `project_slug result_json checked_at` (`:351-355`) |
| `scope_violations` | P | `id project_slug task_key scope detail status(open\|resolved) created_at resolved_at resolved_by`; one open row per `(project, scope, task)` (`:356-366, 648-650`) |
| `instance_settings` | P | `key value_json updated_at`; live keys `backendRateLimit.<backend>` (`backend-quota.server.ts:50` prefix) and `projection.derivationVersion` (= `PROJECTION_DERIVATION_VERSION` 3, `derivation-version.server.ts:29-31`) |
| `user_prefs` | P | `(user_id, key) value_json` |
| `org_knowledge_bases` / `org_skills` / `org_mcp_servers` | P metadata | `name dir refresh last_indexed_at` / `name summary` / `name transport target cred_ref tools_count up last_checked_at warming_since last_error first_success_at heuristic_warmups` |
| `model_availability` | C | `(backend, model) reason marked_at run_id` |
| `oauth_providers`, `google_domain_allowlist`, `s3_audit_config` | P | never select `client_secret`, `secret_box` |
| `schema_migrations` | P | filename of applied baseline |

docs claim, code disagrees (naming only): `data-model.md:198-201` says `ensureRunRowColumns`
with `RUN_ROW_COLUMNS` adds missing `agent_runs` columns at boot. The code is
`ensureBaselineColumns` over `BASELINE_COLUMNS` (`sqlite.server.ts:157-245`), which also covers
the ruling-121 controller columns. Behaviour matches; identifiers do not. And the baseline
header comment (`0001_baseline.sql:15`, "there is no drift healer") is stale against that healer.

## 7. Run NDJSON transcript

- Path: `runtimes/<backend>/<runId>.jsonl`, always the RUN id, one file per run
  (`run-store.server.ts:443-460`).
- Line shape: the provider envelope EXACTLY as emitted, single-line JSON, after `redact()`:
  Claude = `JSON.stringify(message)` of each Agent-SDK message (`claude-runtime.server.ts:27,
  1271`); Codex = `JSON.stringify(event)` (`codex-runtime.server.ts:790, 927`). Appended with
  `appendRawLine` (`raw.replace(/\n+$/, "") + "\n"`).
- Viberr-authored console rows (tags `run·inputs run·error run·line_lost run·max_turns
  run·model_substituted run·resumed run·session_missing run·unavailable`) carry `raw: ""`
  (`claude-runtime.server.ts:974, 1015, 1311, 1344`) and are still appended (`run-sink.server.ts:520`
  appends unconditionally), so BLANK lines in the `.jsonl` = viberr-authored rows; their content
  is only in `run_log_lines.display_json`.
- `run_log_lines.display_json` = `LogLine {t, ev: init|text|tool|out|err|result|think|meta|diff,
  tag, text, inputs?, name?, input?, exit?, stats?, usage?, changes?}` (`runtime-types.ts:60-100`);
  the `run·inputs` row's `inputs` = `RunInputs {cwd, repo, cloned, workspaceRefresh?, delivers,
  personaChars, promptChars, anchor, skills{granted,native,injected}, knowledge[], mcp{mounted,
  unresolved, unhealthy}, unresolvedResources[], tools{denied, toolkit}, directive, sandbox}`
  (`:127-190`). That single row is the disclosure of what a run was GIVEN.
- Run row folds: `session_id`, `turns`, tokens (max of live sum vs result), `total_cost_usd`
  (`run-sink.server.ts:405-430, 541-548`).
- Sink write order per line: `.jsonl` append → `run_log_lines` insert → `patchRun` → SSE
  `run.log-appended {runId, seq}` (`:519-559`). A DB insert failure leaves the `.jsonl` complete
  and a `run·line_lost` row saying the console is INCOMPLETE (`:347`).

## 8. SSE event names (`app/schemas/sse-event.schema.ts:22-56`, all 16 verified)

`task.updated {projectSlug, taskKey, stage, readiness}`, `task.removed`, `project.updated`,
`project.removed`, `projection.rebuilt {scope: full|project, changed}`, `notification.created
{userId}`, `notification.read {userId}`, `violation.updated {projectSlug, taskKey|null}`,
`resource.updated {kind: kb|skill|mcp, id}`, `run.log-appended {projectSlug, taskKey, runId,
threadId, seq}`, `run.state-changed {…, state}`, `controller.updated {conversationId, userId}`,
`controller.log-appended {conversationId, userId, runId, threadId, seq}`, `goal.updated
{projectSlug, goalId}`, `stream.open {headId}`, `stream.resync {}`. Stream at `/resources/events`.
Every SSE name the docs mention exists in this list.

## 9. Audit action catalog (163 distinct literals in non-test `app/**`; grouped)

- task: `task.created {title, stage, ownerUserId, seat, notified?}` (`task-actions:732-741`),
  `task.comment {toAgent}` (`:1267`), `task.comment.unrouted`, `task.comment.dropped`,
  `task.transition {from, to, boundary, manual?, by: operator?}` (`:5028-5044`) and
  `{to, boundary: human, via: accept_completion}` on acceptance (`:9170-9178`),
  `task.packet.resolved {optionKind, optionTitle, packetKind}` (`:7279-7291`),
  `task.packet.withdrawn`, `task.packet.withdrawn_superseded`, `task.packet.escalated`,
  `task.acceptance.forced {bypassed}` (`:9371-9380`; `bypassed` = the acceptance refusal
  sentence, or `an open blocked decision packet`, or `no gate (already acceptable)`),
  `task.agent.replied {runId, droppedByGuardrail?|deduped?}` (`:2216-2230`),
  `task.agent.packet_opened`, `task.agent.run_started`, `task.agent.commented`,
  `task.agent.github_read`, `task.operator.packet_opened {type}` (`operator-actions:1260`),
  `task.operator.packet_withdrawn`, `task.operator.recommended`,
  `task.operator.recommended_completion`, `task.operator.accepted_completion`,
  `task.operator.agent_selected`, `task.operator.commented`, `task.operator.context_conflict`,
  `task.operator.autonomy_clamped`, `task.recommendation.applied`, `task.recommendation.withdrawn`,
  `task.recommendation.dismissed`, `task.goal.updated`, `task.metadata.updated`,
  `task.dependencies.updated`, `task.dependencies.released {entries, clearedBy}`
  (`dependencies:396-404`), `task.archived`, `task.unarchived`, `task.branch.discarded`,
  `task.branch.discard_refused`, `task.schedule.created|cancelled|fired`,
  `task.ownership.taken|handed_off|released|admin_released|released_on_removal`,
  `task.reviewer.assigned|removed`, `task.specialist.assigned`, `task.quality.flagged`,
  `task.delivery.handoff`.
- github: `github.pr.opened {repo, prNumber, created}` (created only, `pr-open:788-797`),
  `github.pr.adopted {repo, branch, prNumber, previousPrNumber, previousState, headSha, source:
  reconciler|delivery}` (`pr-adoption-record:66-80`), `github.pr.merged`, `github.merge`,
  `github.pr.merge_refused`, `github.pr.closed_unowned`, `github.delivery.manual {status,
  prNumber?, headSha?, moved?}` (`task-actions:5945-5958`), `github.delivery.operator`,
  `github.delivery.next_step` (constant `DELIVERY_NEXT_STEP_AUDIT_ACTION`, `:6097`),
  `github.branch.created`, `github.branch.deleted`, `github.branch_delete`,
  `github.branch.prepare_failed`, `github.branch_update.operator`, `github.collision.resolved`,
  `github.workspace.pr_linked`, `github.workspace.branch_reconciled`, `github.reconcile.task
  {repo, branch, changed, sync}` (`github-reconciler:993-999`), `github.reconcile.project`,
  `github.reconcile` (provenance), `github.repo.bootstrapped`, `github.scope_violation.opened|resolved`,
  `github.credential.assigned|cleared|revalidated`, `github.pat.created|deleted|token_replaced`.
- runtime/run: `runtime.run.started {threadId, backend, role, kind, resumed, credentialUserId,
  failedUnavailable?}` subject `run/<runId>` (`run-service:820-838`), `runtime.run.interrupted
  {threadId, backend, role}` (`:1843-1851`), `runtime.operator.plan_executed`,
  `run.recovery.reinvoked`, `run.recovery.reply_replayed`.
- goal: `goal.created`, `goal.updated`, `goal.completed` (`goal-actions:270, 551, 925`).
- controller: `controller.authority.denied`, `controller.ops.read {tool…}` (every `viberr_ops`
  read, ruling 111; `controller-ops-mcp:173`).
- project: `project.created|deleted`, `project.settings.updated`, `project.repo.updated`,
  `project.member.invited|removed|role_changed`, `project.stage.added|removed|renamed|reordered`,
  `project.policy.boundary_changed|guardrail_changed`, `project.operator.autonomy_changed`,
  `project.agent_profile.created|updated|deleted|deployed`, `project.authority.denied`,
  `project.org_admin.override`.
- org/profile/auth: `org.user.*`, `org.kb.*`, `org.skill.*`, `org.mcp.*`, `org.connection.*`,
  `org.controller.updated`, `org.store.*`, `org.audit_export.*`, `org.domain.*`,
  `org.oauth_provider.*`, `org.agent_profile.*`, `profile.backend.connected|disconnected|
  login_started|login_failed|login_cancelled`, `profile.updated`, `auth.*`,
  `identity.github.disconnected`, `projection.rescan {projects, tasks, changed, unchanged,
  removed, errors, durationMs}`, `projection.rebuild`, `secrets.resealed`, `seed.baseline`,
  `seed.org_resources`, `store.restored`.

docs claim, code disagrees: `docs/domain/task-lifecycle.md:154` names a `task.transitioned`
audit; the code writes `task.transition` (`task.transitioned` exists only in a test). Every other
dotted audit name the docs mention exists in code (diff run over `docs/**` vs `app/**`).

## 10. Notification kinds and producers (verified callers)

| kind | producer | title / text |
|---|---|---|
| `packet` (`ptype input\|blocked`) | operator packet open (`operator-actions:1273-1290`), agent question (`agent-toolkit:224`), decisions/mutation | `Decision needed: <title>` / `Blocked, decision needed: <title>`; text = packet body or title |
| `approval` | acceptance/transition offers (`task-actions:3321, 6212`, `operator-actions:916`) | |
| `mention` | `@name` in comments (`mention-notify:404`) | `mentioned you — “<clip>”` |
| `quality` | verdict/guardrail (`task-actions:3349, 4005`, `operator-actions:2125`) | |
| `policy` | delivery failure (`task-actions:6083`, title `Delivery could not run`/`Nothing to deliver`), reconciler divergence/adoption (`github-reconciler:886-923`: `PR #N adopted for KEY[: replaces PR #M]`, `PR #N merged on GitHub: accept KEY`, `PR #N closed on GitHub: KEY needs a decision`, `Accepted PR #N closed on GitHub: KEY's merge can't complete`), scope violations, poller failures | |
| `controller` | goal progress to the goal creator ONLY (`goal-actions:618-641`, title `<goalId> · <title>`) | |
| `dependency` | release engine (`dependencies:406`, title `KEY can move again`) | |
| `ownership` | seat changes (`task-mutation:233`) | |

docs claim, code disagrees: `0001_baseline.sql:258-259` and `data-model.md` §3 say `controller`
also covers "a controller conversation reply". No code path creates a notification when a
controller turn replies (`grep createNotification app/server/controller` → none; the only
`kind: "controller"` notification is the goal creator's). Controller replies surface only via
SSE `controller.updated` + the transcript row.

## 11. Rebuild / rescan / store:check: what each proves

| Command / action | Lock | What it does | Output / proof |
|---|---|---|---|
| `npm run store:check` (`scripts/store-check.ts`) | none, no DB | parses every `project.md`, `tasks/*/task.md`, `goals/*.md`; names UNTRUSTED files (hard-stop finding or unreadable) and DEGRADED files (error-severity) | text `viberr store check — N canonical files under <root>`; untrusted block says the task `is forced to \`blocked\` and the app REFUSES to write to it`; exit 1 if any untrusted (`store-check.server.ts:248-295`). Proves the FILE is parseable, nothing about the DB |
| `npm run rescan [-- --force]` (`scripts/rescan.ts`) | takes writer lock; REFUSED while the app runs | `rebuildAll` with content-hash short-circuit; audit `projection.rescan`; appends untrusted report from `diagnostics` | `viberr rescan complete: P projects, T tasks — c changed, u unchanged, r removed, e errors (ms)`. `errors` counts THROWS only (tolerant parse never throws) |
| In-app Re-scan (Home store strip `intent=rescan`, org admin; board `intent=rescan` admin/maintainer) | inside the locked server | same as above | SSE `projection.rebuilt`; audit `projection.rescan` (`_index.tsx:106`, `project.board.tsx:130`) |
| In-app Rebuild projections (Home `intent=rebuild-projections`) | server | `DELETE FROM task_events, diagnostics, task_projections, projects` (members cascade) then rebuild; audit `projection.rebuild` (`rebuild.server.ts:41-55`) | Proves projections are a pure function of files. `goal_projections` is NOT dropped (upserted) |
| boot | server | rescan (not rebuild) before first request; `projection.derivationVersion` behind `PROJECTION_DERIVATION_VERSION` (3) forces a full rebuild; `ensureBaselineColumns`; drift WARN `projection schema drift — this root's rebuilder tables lag the shipped baseline` (`boot.server.ts:367`) | |
| watcher | server | 250 ms debounce; `projects/**/project.md`, `tasks/<KEY>/task.md`, `goals/*.md` | `provenance.action = projected|removed`, `details_json {diagnostics, events, readiness, downgraded}` per file (`rebuilder:707-716`) |

Projection short-circuit: a `task_projections` row is rewritten only when `content_hash` (sha256
of the file) changes, unless forced (`rebuilder:421-430`). `content_hash` is written LAST as a
commit marker; `""` means a torn projection that will re-run (`:635-641`).

## 12. Controller and agent tool identifiers (for reading transcripts)

- Controller MCP server name `viberr_controller` (`controller-toolkit.server.ts:2083`); tools:
  `whoami list_capabilities list_users create_user update_user set_user_org_role
  list_knowledge_bases save_knowledge_base list_skills save_skill list_mcp_servers save_mcp_server
  test_mcp_server list_global_agents save_global_agent inspect_audit_log inspect_run_analytics
  create_project get_project list_tasks get_task create_task move_task comment_on_task
  set_task_owner update_task run_agent_on_task get_github_state update_project_settings
  update_stages set_transition_boundary invite_member set_member_role deploy_agent
  update_agent_deployment create_goal list_goals get_goal update_goal` (`:244-1972`).
  `comment_on_task` posts as `controller` with the suffix `_Posted by the controller for
  <name>._` (`:1198-1204`).
- Built-in diagnostics MCP `viberr_ops`: `instance_health read_run_log read_store_doc`
  (`controller-ops-mcp.server.ts:211-412`); each read audited `controller.ops.read`.
- Operator toolkit: `get_task read_default_branch_file post_comment set_goal
  flag_context_conflict open_decision_packet set_dependencies resolve_decision_packet run_agent
  deliver_for_review update_branch_from_base transition_stage accept_completion`.
- Agent toolkit (`viberr_agent`): `post_comment ask_human report_outcome github_read`;
  `report_outcome {verdict?: approve|request_changes, summary?, evidence?: [{label, add?, del?}]}`
  staged in `staged_outcomes` keyed by `agent_runs.outcome_key` (`agent-toolkit:55-104`).
- Delivery outcome statuses (`task-actions:5279-5310`): `delivered {prNumber, url, created,
  pushStatus, headSha, moved, operatorRequeued}`, `push_conflict`, `grant_withheld`,
  `push_failed`, `scope_violation`, `nothing_to_review`, `failed`.

## 13. Ready-to-run in-container read recipes

Form (verified live): `docker exec -i viberr-app-1 node - <<'EOF' … EOF`. Inside the script
`process.env.VIBERR_DATA_ROOT` is `/data`. Open read-only. Single-quote SQL literals. Set `SLUG`,
`KEY`, `SINCE`, `USER` as JS consts at the top. Never `SELECT *` from `github_pats`,
`user_backend_credentials`, `oauth_providers`, `s3_audit_config`, `account`, `session`.

```bash
# R0: preamble used by every recipe (paste, then one of the bodies below, then EOF)
docker exec -i viberr-app-1 node - <<'EOF'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.VIBERR_DATA_ROOT + "/state/projection.sqlite", { readOnly: true });
const SLUG = "k9s-clone", KEY = "K9S-1", SINCE = "2026-09-06T00:00:00.000Z";
const q = (sql, ...p) => db.prepare(sql).all(...p);
const show = (rows) => console.log(JSON.stringify(rows, null, 1));
// ---- body ----
show(q("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(r => r.name));
db.close();
EOF
```

```js
// R1: tasks with stage / derived + stored readiness / waiting / owner / packet / PR
show(q(`SELECT task_key, stage, readiness, stored_readiness, waiting, validation, acceptance,
  continuity, owner_user_id, branch, work_revision_sha, blocked_by_json, archived,
  recommendation_count, event_count, diagnostic_count, packet_json IS NOT NULL AS has_packet,
  json_extract(pr_json,'$.number') AS pr, json_extract(pr_json,'$.state') AS pr_state,
  json_extract(pr_json,'$.headSha') AS pr_head, goal_id, goal_link_index, updated_at, content_hash
  FROM task_projections WHERE project_slug = ? ORDER BY task_key`, SLUG));
```

```js
// R2: runs for a task (effort is NOT stored; read it from the run·inputs line or the profile)
show(q(`SELECT id, thread_id, role, kind, backend, model, sdk, state, phase, step, started_at,
  finished_at, turns, input_tokens, cached_input_tokens, output_tokens, total_cost_usd,
  interrupted_by, agent_name, agent_profile_id, outcome_key, dispatched_by_name,
  credential_user_id, session_id IS NOT NULL AS has_session
  FROM agent_runs WHERE project_slug = ? AND task_key = ? ORDER BY created_at`, SLUG, KEY));
// R2b: the run's declared inputs (what it was GIVEN)
const RUN = "<runId>";
show(q(`SELECT seq, occurred_at, json_extract(display_json,'$.tag') AS tag,
  json_extract(display_json,'$.inputs') AS inputs FROM run_log_lines
  WHERE run_id = ? AND json_extract(display_json,'$.tag') = 'run·inputs'`, RUN));
// R2c: console tail; blank raw_json = viberr-authored row
show(q(`SELECT seq, occurred_at, json_extract(display_json,'$.ev') AS ev,
  json_extract(display_json,'$.tag') AS tag, substr(json_extract(display_json,'$.text'),1,160) AS text,
  length(raw_json) AS raw_len FROM run_log_lines WHERE run_id = ? ORDER BY seq DESC LIMIT 40`, RUN));
```

```js
// R3: timeline of a task as projected (position 0 = newest)
show(q(`SELECT position, occurred_at, type, actor_kind, actor_ref, title, to_agent,
  substr(text,1,240) AS text, evidence_json, attachments_json
  FROM task_events WHERE project_slug = ? AND task_key = ? ORDER BY position`, SLUG, KEY));
```

```js
// R4: audit rows since a timestamp (optionally scoped)
show(q(`SELECT occurred_at, action, actor_label, actor_user_id, subject_kind, subject_id,
  project_slug, task_key, details_json FROM audit_events
  WHERE occurred_at >= ? ORDER BY occurred_at`, SINCE));
```

```js
// R5: notifications for a user (by email)
show(q(`SELECT n.occurred_at, n.kind, n.ptype, n.title, substr(n.text,1,160) AS text,
  n.project_slug, n.task_key, n.read_at FROM notifications n JOIN users u ON u.id = n.user_id
  WHERE u.email = ? ORDER BY n.occurred_at DESC LIMIT 50`, "you@example.com"));
```

```js
// R6: open packets across the project, with their option kinds
show(q(`SELECT task_key, stage, readiness, waiting,
  json_extract(packet_json,'$.id') AS pkt, json_extract(packet_json,'$.type') AS type,
  json_extract(packet_json,'$.kind') AS kind, json_extract(packet_json,'$.title') AS title,
  json_extract(packet_json,'$.awaiting') AS awaiting, json_extract(packet_json,'$.askedBy') AS askedBy,
  (SELECT group_concat(json_extract(o.value,'$.kind'), ',') FROM json_each(packet_json,'$.options') o) AS options
  FROM task_projections WHERE project_slug = ? AND packet_json IS NOT NULL`, SLUG));
```

```js
// R7: goal chains (reconciled view) + the stored claim side by side
show(q(`SELECT goal_id, title, status, on_failure, current_index, links_total, links_done,
  links_json, updated_at FROM goal_projections WHERE project_slug = ?`, SLUG));
show(q(`SELECT task_key, stage, goal_id, goal_link_index, blocked_by_json
  FROM task_projections WHERE project_slug = ? AND goal_id IS NOT NULL ORDER BY goal_id, goal_link_index`, SLUG));
```

```js
// R8: projection row vs task.md (compare inside the container; files are truth)
const fs = require("node:fs"), crypto = require("node:crypto");
const p = `${process.env.VIBERR_DATA_ROOT}/projects/${SLUG}/tasks/${KEY}/task.md`;
const file = fs.readFileSync(p, "utf8");
const row = db.prepare(`SELECT stage, stored_readiness, readiness, waiting, branch, pr_json,
  work_revision_sha, content_hash, parsed_at, event_count FROM task_projections
  WHERE project_slug = ? AND task_key = ?`).get(SLUG, KEY);
const fm = (k) => (file.match(new RegExp(`^${k}: (.*)$`, "m")) || [])[1];
console.log({ row, file: { stage: fm("stage"), readiness: fm("readiness"), waiting: fm("waiting"),
  branch: fm("branch"), sha256: crypto.createHash("sha256").update(file, "utf8").digest("hex"),
  headings: (file.match(/^### .*$/gm) || []).length } });
// content_hash must equal sha256 (else the projection is stale/torn); headings == event_count
```

```js
// R9: controller conversations + messages (owner-visible transcript)
show(q(`SELECT id, user_label, project_slug, task_key, title, last_message_at
  FROM controller_conversations ORDER BY last_message_at DESC LIMIT 20`));
const CONV = "<conversation id>";
show(q(`SELECT seq, author, run_id, surface, created_at, substr(text,1,300) AS text
  FROM controller_messages WHERE conversation_id = ? ORDER BY seq`, CONV));
show(q(`SELECT id, state, model, turns, input_tokens, output_tokens, total_cost_usd, started_at,
  finished_at FROM agent_runs WHERE project_slug = '' AND task_key = ? ORDER BY created_at`, CONV));
```

```js
// R10: diagnostics + provenance for one file (why readiness was floored; when it was projected)
show(q(`SELECT severity, code, path, message, hard_stop, observed_at FROM diagnostics
  WHERE project_slug = ? AND task_key = ?`, SLUG, KEY));
show(q(`SELECT observed_at, action, content_hash, details_json FROM provenance
  WHERE source_path LIKE ? ORDER BY observed_at DESC LIMIT 10`, `%/tasks/${KEY}/task.md`));
```

```js
// R11: who is connected (no secrets), and the run-refusal principal
show(q(`SELECT u.email, c.backend, c.kind, c.method, c.secret_suffix, c.detail_json, c.verified_at
  FROM user_backend_credentials c JOIN users u ON u.id = c.user_id ORDER BY u.email, c.backend`));
show(q(`SELECT slug, repo, task_prefix, default_branch, json_array_length(stages_json) AS stages
  FROM projects`));
show(q(`SELECT project_slug, result_json, checked_at FROM project_github_health`));
show(q(`SELECT project_slug, task_key, scope, status, detail FROM scope_violations WHERE status='open'`));
```

```js
// R12: schedules and recommendations pending
show(q(`SELECT task_key, recommendation_count, schedules_json FROM task_projections
  WHERE project_slug = ? AND (recommendation_count > 0 OR schedules_json != '[]')`, SLUG));
```

Host-side file reads (files are truth; safe from the host at any time):

```bash
cat docker-data/projects/k9s-clone/project.md
cat docker-data/projects/k9s-clone/tasks/K9S-1/task.md
ls docker-data/projects/k9s-clone/tasks/K9S-1/            # attachments/ workspace/
ls docker-data/projects/k9s-clone/goals/ && cat docker-data/projects/k9s-clone/goals/goal-1.md
ls -t docker-data/runtimes/claude docker-data/runtimes/codex | head
tail -n 5 docker-data/runtimes/claude/<runId>.jsonl | cut -c1-300
grep -c '^$' docker-data/runtimes/claude/<runId>.jsonl     # viberr-authored rows
ls docker-data/audit-exports/
docker compose logs --since 10m app | grep -i "maintenance\|drift\|watcher\|rebuild"
curl -s localhost:${PORT:-3000}/resources/health            # {status, degraded[], projections{projects,tasks}, watcher, kbWatcher, lock{pid,hostname,startedAt}, backends, browser, disk, maintenance, build, …}
# store doctor from the host works too (no DB): npm run store:check   (needs VIBERR_DATA_ROOT=./docker-data)
```

`git` truth for the same task: `gh pr view <n> --repo akin-ozer/k9s-clone --json number,state,
headRefName,headRefOid,mergeable,reviewDecision,statusCheckRollup` and `git ls-remote
https://github.com/akin-ozer/k9s-clone <branch>`; compare to `pr_json` / `branch` /
`work_revision_sha`.

## 14. Event-keyed verification checklist

Run R8 (row vs file) after EVERY event; then the specifics. "shows" = board/task page/inbox; "happened" = file + audit + GitHub.

| Event | task.md must show | task_projections / DB | audit row (`action`) | notifications / SSE | External truth |
|---|---|---|---|---|---|
| Controller creates a task | `key`, `stage` = entry stage, `ownerUserId` seated (ruling 140), `## Goal` text; blockers → `blockedBy` + wait `note` | row exists; `readiness` `blocked` if blockers; `goal` column | `task.created {title, stage, ownerUserId, seat}`; `project.md nextTaskNumber` bumped | `ownership` to a named owner; `task.updated` | `controller_messages` row with `surface`; conversation `agent_runs` turn `finished` |
| Operator run starts/ends | `waiting` flips `agent` → `human`; operator narration as `comment`·`operator`; `operator.assignedAtStageId` | `agent_runs` row `kind operator`, `state`, tokens; `run·inputs` line; `.jsonl` exists | `runtime.run.started {…, credentialUserId}`; refusal → `failedUnavailable: true` | `run.state-changed` | `credential_user_id` = task owner (ruling 127) |
| Operator opens a packet | `## Packet` with `id pkt_…`, `type`, `kind`, `options[].kind`; `waiting: human`; `readiness: blocked` when blocked; `comment`/`blocked` event `**Decision packet:** …` | `packet_json` non-null; R6 | `task.operator.packet_opened {type}` | `packet` notification to owner (title `Decision needed: …`); `notification.created` | none |
| Human resolves a packet | `## Packet` GONE (except `edit_goal`: stays with `awaiting: goal_edit` + `decided`); `heldAtStage: null`; `transition` event `**Decision:** <t>.` (+ quoted note); `waiting` per option | `packet_json` null; `readiness` recomputed | ONE `task.packet.resolved {optionKind, optionTitle, packetKind}` | packet notification marked read (`notification.read`); operator re-queued | agent question → the asking agent's session resumed (askedBy) |
| Agent (deliverer) run completes | `comment`·`agent:<b>/<p>` reply; `engagements[]` entry with `delivers: true`; `workRevision` minted `{id rev_, headSha, branch, kind delivered}`; `validation` recomputed | `specialist_json` = delivering engagement; `work_revision_sha` = `workRevision.headSha`; run `kind primary`, `state finished` | `task.agent.replied {runId}` (ONE per run; `droppedByGuardrail`/`deduped` disclosed) | `run.state-changed`, `task.updated` | `git` head on the workspace branch == `workRevision.headSha` |
| Reviewer verdict | `quality` event `**Validation:** healthy\|failing. …`; `verdicts[]` row binds `revisionId` == `workRevision.id`; `validation` `healthy`/`failing` | run `kind reviewer`; `validation_block_reason` null when acceptable | `task.agent.replied` | `quality` notification | `staged_outcomes` row consumed (gone) |
| Delivery (operator `deliver_for_review`, manual button, applied recommendation) | `branch` set; `pr {number, state review, title, headSha}`; `github` event `Opened **PR #N** for review.` by `operator` (operator-authorized) or the human; `noChanges` cleared; `pr.unpushedRevision` absent | `pr_json.number`, `branch`, `work_revision_sha`; row `content_hash` == file sha | `github.pr.opened {repo, prNumber, created: true}` ONLY when created; `github.delivery.operator` / `github.delivery.manual {status: delivered, prNumber, headSha, moved}`; `github.branch.created` earlier | `task.updated` | `gh pr view N`: `headRefName` == `branch`, `headRefOid` == `workRevision.headSha` == `pr.headSha` |
| Delivery failed / empty | `github`·`system:delivery` event with cause; empty branch → `noChanges: true`, `workRevision.kind verified`, `validation none` | `validation`; | `github.delivery.* {status: push_conflict\|push_failed\|grant_withheld\|scope_violation\|nothing_to_review\|failed}` | `policy` notification titled `Delivery could not run` / `Nothing to deliver` | remote branch state matches the sentence |
| PR reuse on same head | NO new "Opened PR" event, NO new `github.pr.opened` row | unchanged | `github.delivery.* {status: delivered, moved: false}` | | |
| Adoption (PR found on branch, not opened by Viberr) | `github` event `Adopted **PR #N** (head …) as KEY's review PR…` by `system:policy-engine` or `system:delivery`; `pr.number` = N, `pr.headSha` | `pr_json` | `github.pr.adopted {…, source: reconciler\|delivery}` | reconciler door: `policy` notification `PR #N adopted for KEY` (delivery door: none) | GitHub PR N exists on the task branch with the delivered head |
| Reconcile pass (5-min poller / page) | `pr.state`, `pr.checks`, `pr.review`, `pr.mergeable`, `pr.revisionDrift {authored, baseRefresh}`, `github.commits/changed`, `github.unownedPr`; divergence → `note` events | `pr_json`; `provenance github.reconcile` | `github.reconcile.task {repo, branch, changed, sync}` per task; project-level `github.reconcile.project` | `policy` notification on divergence (`PR #N merged on GitHub: accept KEY`, …) | GitHub state literally |
| Human accept (verdict gate passed) | `stage` = terminal; `completion` event `Completion accepted` + text naming merged / merge pending / no PR; `pr.state merged` or `accepted`; `waiting none` (projected) | `readiness`, `validation`; `acceptance` null | `task.transition {to, boundary: human, via: accept_completion}`; `github.pr.merged` + `github.merge` when Viberr merged, else `github.pr.merge_refused` | `approval`/`task.updated`; goal link → `done` + goal bullet `Link i (…) completed by KEY.`; `goal.updated`; dependents released (`task.dependencies.released`, `dependency` notification `KEY can move again`) | PR merged on GitHub; branch deleted (`Deleted branch …` + `github.branch.deleted`) when guardrail on |
| Force-accept (admin) | everything above PLUS `acceptance: forced` and `validation: bypassed` | `acceptance = 'forced'`, `validation = 'bypassed'` (CHECK admits both) | `task.acceptance.forced {bypassed: <reason sentence>}` AFTER the write, exactly one row; plus the ordinary `task.transition` | | hero/card say "accepted · gate bypassed" (display arm, docs claim) |
| No-change acceptance | `completion` `Completed with no changes` with the remote check named; `noChanges` true; no `pr` | `validation none` | `task.transition {…, via: accept_completion}`; branch cleanup rows if any | | remote branch absent/empty as the text claims |
| Stage move (drag/dropdown/operator) | `stage`, `previousStageId` = old stage, `heldAtStage: null`, `transition` event text with stage NAMES; exactly ONE event per act | `stage`; `readiness` recomputed | exactly ONE `task.transition {from, to, boundary, manual?, by: operator?}` | `task.updated {stage}` | |
| Comment (@mention) | `comment` event; `to: agent` when routed | `comment_count` +1 | `task.comment {toAgent}` | `mention` to tagged users (never the author) | routed comments re-trigger the operator |
| Goal created / advanced | goal file `links[].taskKey/status`, bullets (§4); link task carries `goalRef` | `goal_projections.current_index/links_done` RECONCILED from task rows (a hand-moved task cannot leave the chain lying) | `goal.created` / `goal.updated` / `goal.completed`; `task.created` per link | `controller` notification to `createdBy` titled `<goalId> · <title>`; `goal.updated` SSE | |
| Interrupt a run | | `agent_runs.state interrupted`, `interrupted_by` = user id (`restart` after boot recovery) | `runtime.run.interrupted {threadId, backend, role}` | `run.state-changed` | `.jsonl` ends without a result envelope |
| Continuity reset (resume with lost transcript) | `continuity` event | `continuity = 'degraded'` (persistent) | | | `run·session_missing`/`run·resumed` rows |
| Archive / discard / collision | `archived: true` / branch fields cleared / `github.unownedPr` null + `readiness` lifted | `archived = 1` | `task.archived`, `task.branch.discarded`, `github.collision.resolved {outcome, reason, prNumber, delivered, blockLifted}`, `github.pr.closed_unowned`, `github.branch.deleted` | | remote ref state |
| Re-scan / rebuild | files untouched | rows re-derived; `provenance` `projected` rows; `content_hash` == file sha256 | `projection.rescan` / `projection.rebuild` | `projection.rebuilt {scope, changed}` | `npm run store:check` exit 0 |

Generic lies to watch for: a row whose `content_hash` != sha256(file) (stale projection);
`event_count` != count of `### ` headings in the file; a "Waiting on: human" pill on a terminal
task (projection forces `none`, `rebuilder:499-506`); two `task.transition` rows for one act;
`github.pr.opened` on a reuse; a `Completion accepted` text saying "was merged" while `gh pr view`
says OPEN; `acceptance: forced` without a `task.acceptance.forced` row (or the reverse); a
`quality` "healthy" verdict whose `revisionId` != current `workRevision.id` (stale verdict, must
NOT unlock acceptance); `pr.headSha` != GitHub `headRefOid`; `credential_user_id` != owner on a
task run; a controller `comment_on_task` without the `_Posted by the controller for …_` suffix.

## 15. Retention windows you may hit during a long observation (`retention.server.ts:51-77`)

`run_log_lines` 30 days; `audit_events` 90 days (exported to `audit-exports/` first);
`notifications` newest 500 per user; `staged_outcomes` 24 h; `.jsonl` transcripts
`VIBERR_TRANSCRIPT_RETENTION_DAYS` (30, docs claim); provenance never pruned. Maintenance pass
every `VIBERR_MAINTENANCE_INTERVAL_MS` (default 6 h) logs `store maintenance pass`.

## 16. Drift ledger (docs vs code) — candidate findings

1. `docs/architecture/file-formats.md:365-372`: agents shown writing `completion` events titled
   `Completion report`. Code writes agent replies as `comment` and verdicts as `quality`; the only
   `completion` events are "Completion accepted" and "Completed with no changes". The sample
   misleads a hand-editor and any doc-driven checker.
2. `docs/domain/task-lifecycle.md:154`: audit `task.transitioned`. Code: `task.transition`
   (`task-actions.server.ts:5036, 9170`).
3. `db/migrations/0001_baseline.sql:258-259` and `docs/architecture/data-model.md` §3: notification
   kind `controller` = "a controller conversation reply or chained-goal progress". Code: only goal
   progress (`goal-actions.server.ts:618-641`); a controller reply raises no notification.
4. `docs/architecture/data-model.md:198-201`: `ensureRunRowColumns` / `RUN_ROW_COLUMNS`. Code:
   `ensureBaselineColumns` / `BASELINE_COLUMNS` (`sqlite.server.ts:157-245`), which also heals the
   controller columns. And `0001_baseline.sql:15` still says "there is no drift healer".
5. `docs/architecture/data-model.md:114` describes `task_projections` "engagement snapshots";
   the real columns are the legacy names `specialist_json` (delivering) and `reviewers_json`
   (supporting) (`0001_baseline.sql:135-136`, `rebuilder.server.ts:600-605`).
6. `docs/architecture/data-model.md:103` lists instance-setting quota keys as "quota
   observations"; live keys are `backendRateLimit.<backend>` (`backend-quota.server.ts:50`) and
   `projection.derivationVersion`. Naming only.
7. Observation, not a doc claim: viberr-authored console rows are appended to the run `.jsonl`
   as EMPTY lines (`raw: ""`, `run-sink.server.ts:520`), so a transcript reader that counts lines
   or JSON-parses every line sees blanks that only `run_log_lines` explains.
8. `agent_runs` has no `effort` column; the UI's effort claim for a run cannot be verified from
   the row, only from the profile/deployment at run time or the `run·inputs` line (which does not
   carry effort either: `RunInputs` has no such field, `runtime-types.ts:127-190`). Candidate
   "shows what cannot be checked".

## 17. Open questions (not verified here)

- Exact mirror directory name under `projects/<slug>/` (`.repo-mirror/` per file-formats.md vs
  ".mirror or equivalent" per data-model.md; `repo-mirror.server.ts` not read).
- Whether `ALWAYS_HUMAN_CAPABILITY_IDS` still lists exactly the three ids named in
  file-formats.md (not re-read).
- The `provenance` `github.merge` action's writer (only `github.reconcile` seen at
  `github-reconciler.server.ts:989`).
- `VIBERR_TRANSCRIPT_RETENTION_DAYS` default and `pruneRuntimeTranscripts` (docs claim 30 days).
- The display arm "accepted · gate bypassed" copy (client code not read).
