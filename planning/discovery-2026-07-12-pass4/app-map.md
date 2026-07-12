# Viberr app map — verified from code (pass 4, 2026-07-12)

Built by reading the actual source on branch `full-pass-2026-07-12`. Every claim carries a
file (and usually line) reference. Planning docs were NOT trusted.

Stack: React Router 8 framework mode (`react-router.config.ts`, routes in `app/routes.ts`),
better-sqlite3 projections over a **file-native canonical store** (`${VIBERR_DATA_ROOT}`),
better-auth for authN, `@anthropic-ai/claude-agent-sdk` ^0.3.207 + `@openai/codex-sdk`
^0.144.1 for agent runs (`package.json`). `engines.node >= 26`.

Core architecture invariant (repeated everywhere): **markdown files are canonical truth**
(`projects/<slug>/project.md`, `projects/<slug>/tasks/<KEY>/task.md`); SQLite is a rebuildable
projection (`db/migrations/0003_projections.sql` header). Every mutation follows
**file write → incremental reproject → audit → notification fan-out**
(`app/server/tasks/task-actions.server.ts:49-57`).

---

## 1. Route table (`app/routes.ts`)

Guard legend: `requireUser`/`requireAuth` = any signed-in user (app/server/auth/require-user.server.ts:121,134);
`requireRole(request,"admin")` = org admin (require-user.server.ts:152); `requireProjectMember` =
project member 403-wrapper (app/server/auth/require-project.server.ts:18); RBAC-in-mutation =
the action calls phase-3 server functions which enforce `requireAction` internally.

| Path | File | Loader | Action intents | Guard |
|---|---|---|---|---|
| `/` | app/routes/_index.tsx:34,52 | home projects+prefs+org summary+notifications | `pin`, `view`, `rescan` (org-admin), `rebuild-projections` (org-admin), `create-project` (ANY signed-in user — deliberate, creator becomes project admin) | requireUser / requireAuth+CSRF |
| `/login` | app/routes/login.tsx:38,66 | providers + flash; modes `login`/`reset` (forced pwreset) | `login`, reset intents | assertTrustedOrigin + rate limit (no session yet) |
| `/logout` | app/routes/logout.tsx:11 | GET redirects `/` | POST revokes better-auth session | authenticate+CSRF |
| `/org/users` | app/routes/org.users.tsx:8 | redirect → `/org/settings?tab=users` | — | — |
| `/org/settings` | app/routes/org.settings.tsx:65,96 | full org view (connections, users, domains, kb/skills/MCP, global agents) | ~25 intents: connection-add/replace/remove/set-default, user CRUD/whitelist/domains, kb/skill/MCP save/delete/reindex/test, StoreBrowser folder/upload/delete, GitHub snapshot import, global agent profile save/delete | **requireRole "admin"** + CSRF |
| `/api/auth/*` | app/routes/api.auth.$.ts:11,15 | better-auth handler (GET+POST); no app CSRF — better-auth's own Origin check | | — |
| `/profile` | app/routes/profile.tsx:48,56 | profile view (PageOverlay) | `identity`, `set-notif`, `set-motion`, `set-tl-default`, `change-password`, `github-disconnect` | requireUser/requireAuth+CSRF |
| `/notifications` | app/routes/notifications.tsx:30 | own notifications (limit 200) | — (uses /notifications/read) | requireUser |
| `/notifications/read` | app/routes/notifications.read.tsx:21 | GET redirects | `read` (ids), `read-all` — own rows only | requireAuth+CSRF |
| `/prefs/theme` | app/routes/prefs.theme.tsx:19 | GET redirects | theme → users.theme + `viberr_theme` cookie | requireAuth+CSRF |
| `/resources/events` | app/routes/resources.events.ts:55 | **SSE stream**; scope auth: org admin any scope; non-admin `projects` firehose expanded to member projects; explicit foreign project/task scopes DROPPED (403 when nothing left) (lines 94-131) | — | authenticate (401 JSON, no redirect) |
| `/resources/run-log` | app/routes/resources.run-log.ts:17 | run-log tail `?runId&since` | — | requireUser (V1 read RBAC: app-wide) |
| `/resources/health` | app/routes/resources.health.ts:23 | `{ok, projections, watcher, backends:{claude,codex}}` — **unauthenticated by design** | — | none |
| `/resources/model-catalog` | app/routes/resources.model-catalog.ts:18 | model+effort catalog per backend | — | requireUser |
| `/resources/session-export` | app/routes/resources.session-export.ts:25 | downloads bash installer carrying a run's provider transcript (`claude --resume` / `codex resume`) | — | requireUser |
| `/projects/:slug` layout | app/routes/project.tsx:34 | board + rail counts + myRole + notifications; subscribes SSE scopes project/user(+task) | — | requireUser (**board read is app-wide**, FR4) |
| `/projects/:slug` index | app/routes/project._index.tsx:5 | redirect → board | — | — |
| `…/board` | app/routes/project.board.tsx:24 | (data from layout) | `create-task`, `reorder` (drag; stage change = transition, into Done = acceptance), `rescan` (admin\|maintainer via requireProjectRole) | requireAuth+CSRF; RBAC in mutations |
| `…/review` | app/routes/project.review.tsx:20 | review queue projection | — | **requireProjectMember** |
| `…/agents` | app/routes/project.agents.tsx:32,55 | roster (templates⊕deployments) + live deployments + resource catalog | `create-profile`, `update-profile`, `delete-profile` (admin — `manage-agents` inside agent-profile-actions.server.ts) | **requireProjectMember** loader; CSRF action |
| `…/policy` | app/routes/project.policy.tsx:26,36 | members+roles, workflow boundaries, roster, last-change chip | `set-role` (last-admin guard), `set-boundary` (review→done hard-locked human — app/features/policy/policy-actions.server.ts:210) | **requireProjectMember** loader; admin inside actions |
| `…/github` | app/routes/project.github.tsx:29,39 | repo access + credential health + PR/branch rows | `reconcile` (non-viewer member), `grant-scope`/`set-credential`/`clear-credential` (admin\|maintainer — checked inline in the route) | **requireProjectMember** loader |
| `…/activity` | app/routes/project.activity.tsx:34 | activity stream + audit log, `?stream=`/`?audit=` paging | — | **requireProjectMember** |
| `…/settings` | app/routes/project.settings.tsx:43,53 | identity+stages+membership+credential health | `save-project`, stage add/rename/remove/reorder, `invite`/`remove-member`, repo override, credential intents, archive, delete | **requireProjectMember** loader; admin (`edit-policy` tier) inside actions |
| `…/tasks/:key` | app/routes/project.task.tsx:73,136 | full task detail: bounded timeline (`?events=`), runtime runs, deployed specialists, mentionables, recommendations (read from task FILE, line 108) | `comment` (commentToAgent), `update-goal`, `resolve-packet`, `complete-merge`, `owner-take/assign/release`, `transition` (manual), `run-interrupt`, `assign-specialist`, `run-specialist`, `assign-reviewer`, `run-reviewer`, `remove-reviewer`, `apply-recommendation`, `dismiss-recommendation`, `run-operator` (admin\|maintainer inline check line 424-434, backend+autonomy form fields) | requireUser loader (**task read app-wide**); RBAC in mutations |

Members-only surfaces: review, agents, policy, github, activity, settings.
App-wide (any authenticated): home, board, task detail, comment, notifications, profile,
run-log/model-catalog/session-export reads. Health is unauthenticated.

---

## 2. RBAC as coded

### Org roles
`users.role IN ('admin','member')` (db/migrations/0001:10). Hierarchy in
require-user.server.ts:141-149 (`roleSatisfies`). Org admin: /org/settings, home
rescan/rebuild, SSE any-scope. Better-auth org plugin `member.role` exists (migration 0013)
but Viberr enforcement stays on `users.role` (app/lib/auth.server.ts:165-168 comment).

### Project roles (app/shared/rbac.ts)
`PROJECT_ROLES = ["admin","maintainer","contributor","viewer"]`
(app/schemas/project-file.schema.ts:23; legacy `reviewer` coerced → `contributor` at parse,
line 28-30). Strict tier viewer ⊂ contributor ⊂ maintainer ⊂ admin (`ROLE_RANK` rbac.ts:27).

### ACTION_ROLES matrix (rbac.ts:75-95) — single source for display AND enforcement
| Action | Floor |
|---|---|
| `view`, `comment` | app-wide authenticated (listed for display only; NOT gated by requireAction — rbac.ts:18-23) |
| `create-task`, `own-task`, `reconcile-github` | contributor+ |
| `approve-transition`, `resolve-packet`, `accept-completion`, `run-agents`, `reorder-board`, `update-goal`, `grant-github-scope` | maintainer+ |
| `release-any-ownership`, `manage-members`, `manage-agents`, `edit-policy` | admin |

`roleCan` rbac.ts:98; `rolesForAction` rbac.ts:104; Policy page renders `RBAC_TABLE`
(rbac.ts:113) derived from the same object (consumed via
app/features/policy/policy-data.ts / policy-page.tsx; pinned by
app/features/policy/policy-rbac.server.test.ts which drives each guard per role).

### Guards
- **`requireAction(project, actor, action, what)`** — THE canonical guard, task-actions.server.ts:319.
  Resolves the actor's role from project.md `members:` (read fresh each call, no caching —
  loadProjectContext task-actions.server.ts:157) and checks `rolesForAction`.
- **`requireProjectRole(slug, actor, allowed|"any-member", what)`** — route-level membership
  guard, task-actions.server.ts:206.
- **`requireProjectMember`** (require-project.server.ts:18) wraps requireProjectRole and
  converts AppError → thrown `data()` Response for clean 403 pages.
- **`assertProjectAction(action, slug, userId, what)`** — config-surface guard
  (app/server/auth/project-role-guard.server.ts:15); same ACTION_ROLES map; used by
  policy/settings/agent-profile action modules.
- **`requireRuntimeRole`** (specialist-run.server.ts:1340) — `roleCan(role,"run-agents")`,
  i.e. admin|maintainer, for assign/run specialist/reviewer; bypassed when
  `ctx.operatorAuthorized` (runtimeAuditActor:1324).
- **Packet resolution exception** (task-actions.server.ts:2481-2501): the task OWNER
  (contributor+, current member) may resolve non-completion packet options;
  `accept_completion` re-gates to `accept-completion` (maintainer+).

### Role bindings storage
Canonical: `project.md` frontmatter `members: [{userId, role}]`
(project-file.schema.ts:68-74,175). Projected into `project_members` table
(migration 0003:30-36) by the rebuilder — SQL is only used for reads
(SSE membership filter resources.events.ts:11-16, board members, interruptRun RBAC
run-service.server.ts:449).

### ALWAYS_HUMAN + capability enforcement (app/shared/capabilities.ts)
- `CAP_CATALOG` (line 29): 26 capability ids across operator-coordination / delivery /
  review / validation / shared groups. Pruned 2026-07-12 (line 63-68): `edit-other-task-branch`,
  `open-or-merge-pr`, `compress-timelines`, `owner-reassignment` removed (F11: the broad
  `git checkout:*` deny defeated granted branching).
- `ALWAYS_HUMAN_CAPABILITY_IDS` (line 72): `merge-pull-request`, `transition-to-done`,
  `change-project-policy`. Coerced to `human` mode at grant-persist time
  (agent-profile-actions.server.ts `grantsFor`), locked at the workflow layer
  (policy-actions.server.ts:210) and the operator completion path.
- `ENFORCED_CAPABILITY_IDS` (line 96) vs advisory; `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`
  (line 128): specialist tool-denies bind only on Claude (Codex SDK has no deny list);
  `capabilityEnforcement()` (line 138) returns both|claude-only|advisory for honest UI labels.
- Specialist enforcement: `resolveSpecialistDisallowedTools`
  (app/server/tasks/specialist-tool-policy.ts:63) maps withheld (`human`/`off`/always-human)
  caps → Claude `disallowedTools`: create-task-branch → `Bash(git checkout -b:*)`+`Bash(git switch -c:*)`;
  commit-push-branch → `git push`/`git commit`; open-review-pr → `gh pr create`;
  merge-pull-request → `gh pr merge`; execute-code-or-write-repo → `Edit`,`Write`,`NotebookEdit`,`git commit`
  (lines 30-57). Deny wins even under bypassPermissions.
- Operator enforcement: capability `off`/`human` → the MCP tool is NOT BUILT
  (operator-toolkit.server.ts:98-333 gate checks per tool); `allowedTools` confines the run
  to `mcp__viberr__*`; built-ins Bash/Edit/MultiEdit/Write/NotebookEdit/Task are denied for
  every operator run (claude-runtime.server.ts:112-119,261-265).

---

## 3. Data model (db/migrations/, 14 files; **no 0007**)

Canonical-truth tables are marked (proj) = projection rebuildable from files.

- **users** (0001,0002,0009): id, email UQ, name, title, role admin|member, password_hash,
  idp, avatar_tone, pwreset_required, theme, disabled, last_login_at, created_by,
  github_handle. Legacy profile/role store — still canonical for app RBAC.
- **sessions** — DROPPED by 0014 (better-auth owns sessions).
- **audit_events** (0002): append-only governed-action log; actor_user_id nullable
  (operator = null + label "operator"), details_json never secrets.
- **projects** (proj, 0003): slug PK, name, archived, repo, default_branch, task_prefix,
  description, stages_json, workflow_json, agent_policy_json, credential_policy_json,
  guardrails_json, source_path, content_hash, parsed_at.
- **project_members** (proj, 0003): (project_slug, user_id) PK, role CHECK 4-role.
- **task_projections** (proj, 0003 + 0011 rename + 0012): (project_slug, task_key) PK; title,
  stage, readiness (derived, 4-enum) + stored_readiness, waiting human|agent|none, urgent,
  validation healthy|changed|failing|none, owner_user_id, specialist_json, reviewers_json,
  operator_json, branch, repo (effective), pr_json, github_json, goal, packet_json,
  event/comment/diagnostic counts, board_rank REAL (0012 — sparse drag rank, NULL→key number).
- **task_events** (proj, 0003): per-task timeline replaced wholesale; position 0 = newest;
  actor_kind human|agent|operator|system, denormalized actor_json, to_agent, evidence_json.
- **diagnostics** / **provenance** (proj, 0003): tolerant-parse findings; every rebuild action.
- **notifications** (app-owned, 0003): per-user; kind packet|approval|mention|quality|policy,
  ptype input|blocked, soft task/project refs, read_at monotonic.
- **user_prefs** (0004): (user_id,key) PK, value_json — pins, view, motion, tlDefault, notif routing.
- **github_pats** (0005): AES-256-GCM `v1$iv$ct$tag` encrypted_token
  (secret-box.server.ts, key VIBERR_SECRET_ENCRYPTION_KEY), token_suffix (last 4), validation_json cache.
- **project_github_credentials** (0005): project_slug PK (SOFT ref — survives seed --reset) → pat_id.
- **scope_violations** (0005): open/resolved rows; partial UNIQUE open per (project,scope,task);
  seeded `sv_seed_vib142_pr_write` row for VIB-142 `pull_request:write`.
- **agent_runs** (0006 + 0010 + 0011 rebuild): run projection; thread_id UQ per (project,task);
  kind operator|primary|reviewer (0011 renamed consultant); backend claude|codex|simulated +
  separate `simulated` flag; session_id (provider), state queued|running|finished|error|interrupted,
  phase/step, tokens (real usage only), total_cost_usd (claude only), interrupted_by,
  agent_name + agent_profile_id (0010 — Agent-logs grouping). Raw NDJSON truth lives in
  `${DATA_ROOT}/runtimes/<backend>/<id>.jsonl`.
- **run_log_lines** (0006): (run_id, seq) UQ; raw_json (exact wire envelope) + display_json (projected LogLine).
- **github_connections** (0008): org-level owner→PAT bindings; is_default; repos_count; expires_at.
- **google_domain_allowlist**, **org_knowledge_bases**, **org_mcp_servers** (up/tools_count/cred_ref
  is a secret:// REFERENCE), **org_skills** (0008) — metadata only; kb/skill CONTENT is on disk.
- **better-auth** (0013, generated by scripts/gen-better-auth-schema.ts): `user`, `session`,
  `account`, `verification`, `organization`, `member`, `invitation`. Bridge invariant:
  better-auth `user.id === users.id`.

---

## 4. Server services (app/server/)

### Boot (app/server/boot.server.ts:68, called from entry.server.tsx)
env validation → ensureDataRootDirs → seedDefaultAgentAssets (ships operator/developer/reviewer
skill+definition+profile into the store when missing, default-assets.server.ts) → getDb (runs
migrations) → seedInitialAdmin → startEventPublisher → boot rescan (offline drift) →
ensureBaseAgentsDeployed (deploys operator+Developer+Reviewer into every project lacking them)
→ startFileWatcher → registerSeededLiveFromData → recoverUnreactedAgentRuns (fire-and-forget)
→ integrity log.

### auth/ — better-auth bridge
- app/lib/auth.server.ts:61 `buildAuthOptions`: better-auth owns credentials+sessions+oauth+org
  membership; cookie `viberr.session_token` (prefix "viberr"), 30-day rolling; Viberr's scrypt
  hash/verify plugged in (line 99-103); signup disabled; OAuth whitelist via databaseHooks
  user.create.before → `isOAuthWhitelisted` (whitelist model = a users row with that email
  exists); account linking by verified email; `organization()` plugin. Singleton `getAuth()`
  line 191, re-built when db handle changes.
- require-user.server.ts — authenticate/requireAuth/requireUser/requireRole (§1); disabled or
  vanished user → better-auth session row deleted (line 75-78).
- csrf.server.ts — Origin/Sec-Fetch-Site check + double-submit HMAC(secret, sessionId) token
  as form `_csrf`. **Every new form needs `_csrf`.** login uses assertTrustedOrigin only.
- login.server.ts (credentials + rate-limit via rate-limit.server.ts), login-flash, password
  (scrypt), oauth-provision (whitelist + legacy-row sync), seed-admin, user-admin, user-store,
  identity.server.

### db/ — sqlite.server.ts (WAL, FK on, HMR-safe singleton), migration-runner (per-file txn).

### files/ — canonical store IO
- file-store-root.server.ts — path helpers + `DATA_ROOT_SUBDIRS` (§5 layout).
- frontmatter.server.ts (split/serialize YAML), atomic-file (tmp+rename), file-mutex,
  project-file/project-writer (readProjectFile, allocateTaskKey — atomic per-project counter),
  task-file/task-writer (read/create/updateTaskFile), actor-ref.
- file-watch.service.server.ts:46 — chokidar v5 on `${root}/projects`, 250 ms per-path
  debounce, only project.md/task.md, `unlinkDir` reconciliation (lines 90-137), error clears
  handle (health honesty) + self-heals transient EMFILE/ENOSPC/etc. after 2 s (lines 158-193).
- kb-injection.server.ts:92 `readKbBody` — recursive walk, extensions .md/.markdown/.mdx/.txt/.rst/.text,
  **KB_INJECTION_BUDGET = 24 000 chars GLOBAL across all of an agent's KBs** (line 40), explicit
  truncation marker.

### projections/
- rebuilder.server.ts — `rebuildPath`:498 (incremental, content-hash short-circuit),
  `rebuildAll`:532, `rebuildTaskFile`:283; emits projection events; provenance rows.
- rescan.server.ts:10 / rebuild.server.ts:34 (drop + full rebuild, admin-only recovery).
- board-query, task-query (getTaskDetail/getTaskSummary), review-queue, activity-feed
  (stream from task_events + audit list), notifications.server.ts:53 `createNotification`
  (honors per-user routing prefs via `isNotifKindEnabled`, returns null when silenced),
  policy-violations (open count = rail badge), agent-deployments (task assignments ⋈
  agent_runs by profile id).
- interpretation/readiness-policy.server.ts — THE readiness derivation: stored value floored
  down by diagnostics (warning→input_required, error→inconsistency_risk_detected,
  hard-stop→blocked); never improves; "accepted" is display-only.

### events/ — SSE
- projection-events.server.ts:11 — emitter; event types task.updated/removed,
  project.updated/removed, projection.rebuilt, notification.created/read, violation.updated;
  `collectProjectionEvents` defers emission inside write transactions (line 82).
- event-publisher.server.ts:50 — translates to wire SSE (`{type, entityId, occurredAt, data}`
  compact facts), notification events USER-TARGETED, projection.rebuilt broadcast.
- sse-broker.server.ts — scopes `project:<slug>` | `task:<slug>/<key>` | `projects` | `user`
  (line 40); routeMatchesConnection:79; heartbeat 25 s; ring buffer 256 events with ids;
  Last-Event-ID replay else `stream.resync`; backpressure → drop connection.
- run-events.server.ts:12,36 — `run.log-appended` {runId,seq} and `run.state-changed` published
  DIRECTLY to the broker (never through the projection emitter); content fetched via
  /resources/run-log.
- Membership filtering happens at SUBSCRIBE time in the route (resources.events.ts:94-131), not
  per-event in the broker.

### runtimes/ — the run machinery
- **adapter.server.ts** — RunSpec (workdir, effort, systemPrompt, mcpServers, allowedTools,
  disallowedTools, outputSchema (codex), env overlay), callbacks onLine/onExit/onPhase.
- **runtime-registry.server.ts** — availability = credential presence only (claude:
  ANTHROPIC_API_KEY | CLAUDE_CODE_OAUTH_TOKEN | VIBERR_CLAUDE_USE_CLI_AUTH=1; codex:
  CODEX_API_KEY | OPENAI_API_KEY | VIBERR_CODEX_USE_CLI_AUTH=1) (line 59-76), cached;
  unavailable → simulated adapter but requested backend kept on the row (`simulated=1`).
  createAdapters:135 — Claude env merges process.env + creds + `CLAUDE_CONFIG_DIR`
  (claude-config.server.ts:25 — app-owned `${DATA_ROOT}/runtimes/claude-home` unless CLI-auth);
  **Codex SDK env REPLACES the child env wholesale** → codexSpawnEnv snapshots process.env +
  CODEX_HOME (line 125).
- **claude-runtime.server.ts:163** — `query()` with streaming-input single message (enables
  `Query.interrupt()`, line 122); `permissionMode: bypassPermissions` when autonomous (195);
  maxTurns 50; **isolation: `settingSources: []`, `skills: []`, `plugins: []`** (217-219) so
  host ~/.claude tiers/skills/plugins never leak in (documented caveat: running the server
  INSIDE a live Claude Code session still leaks the parent's managed toolset — process-level,
  can't be closed here, lines 206-216); system prompt REPLACES default for operator, APPENDS
  to `claude_code` preset for specialists (236-246); operator denies
  Bash/Edit/MultiEdit/Write/NotebookEdit/Task built-ins + specialist capability denies (261-265);
  resume via `options.resume`; live usage accumulation per assistant message (270-302);
  model label resolver `resolveClaudeModel`:95 (family → sonnet/opus/haiku alias).
- **codex-runtime.server.ts:84** — startThread/resumeThread, `sandboxMode:
  danger-full-access` when autonomous else workspace-write (168); interrupt via AbortSignal;
  **idle (inactivity) timeout 15 min** (VIBERR_CODEX_IDLE_TIMEOUT_MS, line 68) → settle error
  (hung-run recovery); success = saw turn.completed and no turn.failed/error; outputSchema for
  the structured-output operator; no system-prompt channel, no MCP channel, no tool denies.
- **simulated-runtime.server.ts** — default demo engine; replays scripted LogLines and
  fabricates wire envelopes via `rawLineFromDisplay` so raw_json round-trips through the same
  normalizer.
- **wire-format.server.ts** — `projectEnvelope` normalizer (both real adapters) + inverse.
- **run-service.server.ts** — startRun:212 (insert queued row → audit `runtime.run.started` →
  launch), resumeRun:300 (NEW row, fresh `<thread>-r<uid>` thread id, shared provider session,
  keeps clone workdir, can re-resolve current model), interruptRun:438 (admin|maintainer, writes
  interrupted + audit; idempotent), getRunLog:527; completion callbacks:
  registerRunCompletion:92 (one-shot, last-writer-wins) and chainRunCompletion:106 (compose).
  **Callbacks are in-process only — a restart loses them** (line 62-66); boot recovery covers it.
- **run-sink.server.ts** — per line: append raw .jsonl → insert run_log_lines → fold facts into
  run row → THEN publish run.log-appended (persist-before-publish).
- **run-projection.server.ts** — RunView[] grouped per agent (agent_profile_id / role fallback).
- **run-recovery.server.ts** — boot reconciler for finished-but-unreacted real runs
  (waiting=agent, no `task.agent.replied` audit row) → posts reply + re-invokes operator.
- **seed-resumer.server.ts** — drips seeded "running" runs' live lines over SSE on first subscribe.
- **session-export.server.ts** — locates Claude transcript
  `$CLAUDE_CONFIG_DIR/projects/<cwd-encoded>/<sid>.jsonl` / Codex
  `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<sid>.jsonl` by session id; buildResumeScript.
- **model-catalog.server.ts** — curated fallback + live `supportedModels()` enhancement for
  Claude (cached, injectable); codex list hand-maintained; resolveRunModel rejects display
  placeholders.
- **runtime-seed(-data)** — 18 seeded runs / 8 tasks with fabricated authentic envelopes.
- **operator-run.server.ts** — see §6 operator.

### tasks/ — governed mutations (detailed in §6)
task-actions.server.ts (2975 lines, the core), specialist-run.server.ts, operator-actions.server.ts,
operator-toolkit.server.ts, operator-run (in runtimes/), agent-reply.server.ts (mention resolution
+ reply extraction + runFailureReason:347 quota/auth classification), comment-guardrails
(meaningful-comment / operator-brevity / evidence-separation — all REAL enforcement),
timeline-compaction (collapses old routine comments, preserves typed events),
mention-suggestions (composer directory: deployed specialists + users by email local-part/first
name + reserved handles), specialist-mcp.server.ts:23 (org MCP registry → Claude mcpServers:
HTTP → `{type:"http",url}`, stdio → `{command,args}`; `viberr` name reserved; **credentials NOT
injected — cred_ref is a reference only**), specialist-tool-policy (§2), model-prose
(escaped-`\n` repair at the model→store boundary).

### github/ — all real HTTP against api.github.com, typed degraded results, never throws
- github-client.server.ts:111 — fetch wrapper: bearer PAT, ETag, rate-limit surfaced, ONE retry
  on 5xx only, injectable fetchImpl; githubWebHost:215 (GHE-aware links).
- github-context.server.ts:45 — project repo (task override wins) + bound PAT → client, or
  typed `no_repo_configured`/`no_pat_configured`.
- branch-sync.server.ts — `taskBranchName`:36 (`vib-142-<4-word-title-slug>`, diacritics
  stripped), ensureTaskBranch:177 (refs API, idempotent), getBranchCompare:77,
  deriveSyncState:135 (merged > behind_main > synced).
- pr-open.server.ts — composePrBody:28 (goal/summary/evidence/task link), openTaskPr:117
  (opened on entering the review stage — task-actions.server.ts:2270-2287 fire-and-forget).
- pr-linker.server.ts — findPrForBranch:108; PR state vocabulary review|merged|closed|accepted
  ("accepted" = human accepted, real merge pending — Viberr-only state).
- github-reconciler.server.ts — reconcileTask:133 (compare/PR/commits → task.md pr/github
  cache), reconcileProject:329, mergeTaskPr:422 (real PUT merge; 403-scope opens/reuses a
  scope violation).
- workspace-delivery.server.ts:193 — post-run reconciliation of what the agent ACTUALLY did in
  its workspace (real branch/commits/PR via the run's own git/gh), idempotent, never fights the
  PAT path. Runs from applyAgentCompletionEffects step 2 (task-actions.server.ts:1608-1624).
- scope-flag.server.ts:109,151 — violation open/resolve + typed policy events + watcher
  notifications; repo-access-check.server.ts:36 — typed Connection fact.
- **Verdict: GitHub integration is REAL, not stub** — clone (PAT-injected), branch create,
  compare, PR open, PR find, real merge, scope violations all execute HTTP; degraded states are
  typed values.

### org/ — org-settings server layer
connections (validate-before-save PAT + owner facts), org-users (local accounts, whitelists,
domains, roles; delete/disable), gagents (global agent profile template CRUD), resources
(kb/skills/MCP: **disk is truth** — scans real folders, synthetic `disk:<name>` ids adopted on
edit; MCP health = real HTTP probe / stdio JSON-RPC initialize+tools/list), store-files
(StoreBrowser: sanitized real FS mutations under kb/skills roots; GitHub snapshot import via
git trees API through the default org connection), org-view (loader payload), org-seed.

### secrets/ — secret-box (AES-256-GCM `v1$iv$ct$tag`), pat-store (only `getPatToken`
decrypts), pat-validator (classic scopes via x-oauth-scopes; fine-grained = `assumed`).

### audit/ — audit-recorder (recordAudit), audit-actions (canonical action-id list),
audit-coverage test sweeps call sites.

### seed/ — demo-seed (full mock dataset as real files + projections; idempotent; `--reset`
wipes), default-assets (ships built-in agent assets from app/server/seed/assets/*.md),
ensure-base-agents (operator id constant; deploys built-ins to every project), demo-data.

---

## 5. Agent definitions on disk

Store layout (file-store-root.server.ts:24-36): `projects/`, `agents/profiles/`,
`agents/definitions/`, `runtimes/` (+ `runtimes/claude-home`), `kb/<dir>/`,
`skills/<name>/SKILL.md`, `state/` (sqlite), `cache/`, `auth/`, `logs/`.

- **Profiles** `data/agents/profiles/<id>.md` — YAML frontmatter parsed by
  agent-profile-file.server.ts: id, kind operator|specialist, name, role, icon, backends
  [codex|claude], model, effort, scope, stages [stage-ids], spanAll, resources {skills, mcps,
  kb}, capabilities [{capabilityId, mode}], extras; body = description. Live store ships
  operator/developer/reviewer.
- **Definitions** `data/agents/definitions/<id>.md` — the persona body a run loads
  (specialist-run.server.ts:913-929 readAgentDefinition; operator equivalent in
  operator-run.server.ts).
- **Two-layer model** (agents-query.server.ts docblock): org template file ⊕ project.md
  `agents:` deployment ({profileId, capabilities, extras, definition?}); effective profile =
  template overridden per-field by the deployment's loose `definition`
  (effectiveProfileView:161, assembleAgentRoster:223). Capability policy ALWAYS comes from the
  deployment.
- **Scan/rescan**: profiles are read on demand from disk (no DB rows); project/task files are
  watched by chokidar (§4 files/) and reconciled by `npm run rescan`
  (scripts/rescan.ts → rescanProjections; `--force` ignores hashes). scripts/seed.ts →
  demo seed; scripts/run-migrations.ts; scripts/gen-better-auth-schema.ts.
- Note: the live store's developer.md still grants pruned ids (`edit-other-task-branch:
  human`) and operator.md grants removed `compress-timelines`/`owner-reassignment` — harmless:
  deny-rule mapping and gates only consult catalog ids that still exist.

---

## 6. Task lifecycle

### Stages
Per-project, free-form (`stages` in project.md; default template triage/ready/impl/review/done —
see data store + templates in app/shared/workflow/templates.ts). NOTHING hard-codes literal ids:
`resolveStageRoles` (app/shared/workflow/stage-roles.ts:32) derives entry (index 0), terminal
(last), review (first stage with a workflow edge INTO terminal, positional fallback), work
(edge into review). Boundaries per edge: `auto` | `approval` | `human`
(project-file.schema.ts:34); review→done locked `human` (policy-actions.server.ts:210 rejects
`locked` rows and ANY non-human boundary into the final stage).

### Transitions (task-actions.server.ts:2076 `transitionStage`)
- Same-stage = idempotent no-op; unknown target = validation error; non-manual moves require a
  declared boundary (line 2190-2196).
- RBAC: manual move (dropdown/drag) → `approve-transition`; `auto` boundary → any member;
  `approval` → `approve-transition`; `human` → `accept-completion` (lines 2152-2165).
- A HUMAN moving INTO the final stage is rerouted through the full `acceptCompletion`
  contract (lines 2126-2141); the OPERATOR can never bare-transition to Done (2147-2151).
- Side effects: leaving entry stage attaches the operator ref + clears triage
  `input_required`→ready (2183-2200); entering review resets validation → `changed` unless a
  standing `failing` without rework (hasReworkSinceLastRejection:1343, anti-laundering);
  transition recommendations dropped; audit `task.transition`; approval notifications
  auto-read; **non-operator transition auto-invokes the operator** (2258-2260, trigger
  "transition"); **entering review best-effort opens the review PR** (2270-2287).

### Ownership
`ownerUserId` in task.md. setOwner:1887 (`own-task` for self-take; assign checks
owner/admin + target membership), releaseOwner:2002 (self → `own-task`; releasing someone else
→ `release-any-ownership`, admin). Owner is a review/acceptance seat; operator may schedule on
owner-set (operatorSchedulesOnOwner:1863).

### Secondary assignments
- Primary specialist: `specialist: {profileId, backend, role}` (one);
  assignSpecialist (specialist-run.server.ts:222).
- Reviewers: `reviewers: [AgentRef]` (many, idempotent engage) — assignReviewer:307,
  removeReviewer:402. Reviewer runs record verdicts: classifyReviewerVerdict:1258 parses the
  FULL reply → validation healthy/failing + `quality` event + watcher notification
  (recordReviewerVerdict:1365); A3 state machine: approve-after-rework clears failing.
- Stage eligibility (F1): profile `stages`/`spanAll` enforced at assign AND run time
  (assertStageEligible specialist-run.server.ts:1398; specialistEligibleForStage:1383; empty
  list = unrestricted back-compat).

### Comments and @mentions
appendComment:597 — app-wide (any registered user, guests get a pill); AGENT_HANDLE_RE
`@(agent|operator|codex|claude)` flags toAgent; user mention fan-out by email local-part or
first name; compaction guardrail applies. commentToAgent:762 — superset: resolves a mentioned
agent (name/id/backend/generic — agent-reply.server.ts:154), records the comment always;
triggering the run requires admin|maintainer (`runtimeDenied` flag, never a throw); resume the
agent's session (reuse clone workdir) or start a fresh run; reply lands as an agent-authored
comment. `@operator` mentions run the operator with `humanComment`.

### Packets (task.md `packet`, one at a time)
Schema task-file.schema.ts:189-202: type input|blocked, kind label, title, body, observations
[{k,v,code}], options [{kind, t, d, rec, ev}]. Option kinds (ruling 7, line 56):
`accept_completion` | `request_edit` | `block_on_policy` | `hold_runtime_debug` | `redirect` |
`custom` — dispatch on kind, never on titles. Created by the operator via operatorOpenPacket
(operator-actions.server.ts:452, gated `generate-packets`; blocked packets also set
readiness=blocked; fans `packet` notifications) and by the stuck-loop/run-failure escalations
(task-actions.server.ts:1188 openStuckLoopPacket). Resolved via resolvePacket:2462 — owner OR
maintainer+ (§2); accept_completion re-gated + refuses standing `failing` validation (C2);
option `ev` text is written to the timeline; packet cleared.

### Recommendations (task.md `recommendations[]`, many pending)
Kinds (task-file.schema.ts:90): assign_specialist, assign_reviewer, transition, run_specialist,
run_reviewer, accept_completion. Written by a SUPERVISED operator (addRecommendation
operator-actions.server.ts:345 — dedup, waiting=human, timeline comment, `approval`
notification on new). Humans apply via `apply-recommendation` intent → applyRecommendation
task-actions.server.ts:2835 (executes through the governed mutation) or dismiss (:2934,
`resolve-packet` tier). Stale ones auto-cleared on assignment/transition/acceptance.

### Run trigger end-to-end (UI "Run specialist")
1. project.task action `run-specialist` → startSpecialistRun (specialist-run.server.ts:473):
   RBAC admin|maintainer (or operatorAuthorized) → resolve deployment (model/effort/skills/kb/
   mcps/capability denies) → stage eligibility → build persona (definition + skill bodies + KB
   docs under the 24k global budget, :956) → best-effort `git clone --depth 1` (PAT-injected
   `x-access-token:` URL) into `<taskDir>/workspace/<repo>` (:1251) → cwd = clone or empty
   workspace root, **never the task dir**; `GIT_CEILING_DIRECTORIES=<taskDir>` confines git
   ascent (:1232-1249) → buildAnalyzePrompt with the explicit workspace+delivery contract
   (branch `taskBranchName`, `[KEY]` commit prefixes, push+PR, :1018) → startRun (thread
   `primary-<uid>`, systemPrompt for Claude / persona folded into prompt for Codex, MCP servers
   Claude-only, disallowedTools, simulated fallback script) → timeline event + audit →
   markWaitingAgent → registerAgentCompletion.
2. Run streams: adapter → sink (jsonl + rows + facts) → `run.log-appended` SSE → UI tails
   /resources/run-log.
3. Completion (applyAgentCompletionEffects task-actions.server.ts:1510): post reply comment →
   **error runs**: typed `blocked` event + quota/auth-aware copy + stuck packet + quality
   notification + waiting→human (F8, lines 1554-1608) → **finished real runs**:
   reconcileWorkspaceDelivery (branch/PR truth from the workspace) → reviewer verdict →
   operator REACT decision: `operatorShouldReactToReply`:103 (finished + has reply + reply ≠
   previous reply + depth < OPERATOR_REACT_DEPTH_CAP=4, :93) → re-invoke runOperator with
   trigger "agent-reply" depth+1, else stuck-loop packet on no-progress/depth-cap and ALWAYS
   waiting→human when the chain ends.

### Operator (runtimes/operator-run.server.ts)
- Authority: resolveOperatorAuthority (operator-actions.server.ts:124) from the project's
  operator deployment (policy Map, autonomy supervised|full, backend, model, skills, kb).
- Gate:189 — direct → do; recommend → card (full autonomy promotes recommend→direct EXCEPT
  `completion-for-acceptance`, which needs an explicit `direct` — owner ruling Q1); human/off
  → deny (off also withholds the tool entirely).
- Triggers: create (createTask outside triage / autoInvokeOperator:550), transition, agent-reply
  (react), manual (task-detail Run-operator panel, `@operator` comments).
- Single-flight per task (operator-run.server.ts:115-193): process lease + newest-wins trigger
  queue + cross-boot DB-row backstop with chained release.
- Three modes (:283-299): **claude+cred → real tool-driven** (in-process MCP toolkit,
  buildOperatorToolkit operator-toolkit.server.ts:72 — tools get_task, post_comment,
  open_decision_packet, assign/run/prompt_specialist, assign/run/prompt_reviewer,
  transition_stage, accept_completion; allowedTools = exactly these); **codex+cred →
  structured-output plan** (OPERATOR_PLAN_SCHEMA :310; executeCodexPlan :457 runs the plan
  through the SAME gated operator-actions, dedups echo comments, aborts remaining plan on a
  failed step, escalates a blocked packet on no-plan); **neither → scripted drive** (:692,
  deterministic operator-actions calls + simulated narration run).
- Only path for an agent to reach Done: operatorAcceptCompletion (operator-actions.server.ts:1154)
  under an explicit `completion-for-acceptance: direct` grant; supervised → completion packet.
- Guardrails on operator prose (writeOperatorComment :239): meaningful-comment drop,
  evidence-separation, brevity cap, duplicate-summary drop, compaction at the configured
  threshold — all real (owner ruling Q3).

---

## 7. Shared schemas + features layout

app/schemas/: task-file.schema.ts (§6; tolerant parser — unknown fields preserved,
diagnostics not throws), project-file.schema.ts (§2/§6), sse-event.schema.ts (wire contract,
parsed before publish), github-pat.schema.ts, file-diagnostics.ts.

app/shared/: rbac.ts (§2), capabilities.ts (§2), workflow/stage-roles.ts + templates.ts
(project templates governed/light), mapping/ (task/project/user/actor/notification/task-event
render mappers), dates/format, ids/new-id.server + slugify, auth/password-policy.

app/features/ (component+server pairs per surface): activity, agents (roster, capability
matrix modal, create-profile modal, capability-catalog), board (filters + board-page), github
(view, pills, actions), home (home-page, project-create), kb-browser (StoreBrowser, tree),
live-updates (event-types, sse-client, use-live-updates hook), notifications, org-settings
(users/connections/resources panels), policy, profile, project-settings, review, runtime
(runs-panels, run-log stream hook, runtime-types), shell (rail, topbar, bell, user-menu,
nav, theme), task-detail (decision-packet, execution-profile, operator-recommendations,
timeline, mention composer/autocomplete, runtime-slots). app/ui/: shared primitives (avatar,
csrf-input, icon, markdown, pill, rich-text, stage-menu, toast, toggle, use-dialog,
page-overlay, mention-spans).

---

## 8. Tests

- **Vitest** (vitest.config.ts): node environment; includes `app/**/*.test.{ts,tsx}`,
  `db/**`, `scripts/**`; setup `test-support/setup-env.ts` (seeds VIBERR_SESSION_SECRET +
  VIBERR_SECRET_ENCRYPTION_KEY with `??=` so the suite is hermetic — no .env needed) +
  setup-dom.ts (jsdom <dialog> shim).
- **test-support/**: test-app.ts (route-level harness: temp data root, env+db singleton reset,
  real better-auth sign-in cookies, per-session CSRF tokens, real Request objects), test-db,
  test-store, fake-github (mock transport), audit-log, selftest fixtures.
- **e2e/** (Playwright, playwright.config.ts): isolated data root `e2e/.tmp-data`, port 5177,
  `rm -rf … && npm run seed && npm run dev` webServer, one worker serial, auth.setup.ts logs in
  arda once. Specs 01-06: home/board render, VIB-142 packet resolution, ownership+@operator
  comment routing, VIB-151 live run strip/log streaming, feeds+profile theme persistence,
  org-settings tabs + StoreBrowser folder creation.
- **Test run (as requested):** `npx vitest run --reporter=dot` →
  `Test Files 63 failed | 59 passed (122) · Tests 432 failed | 563 passed | 165 skipped (1160)`
  in 4.99 s. **Every failure is one environmental cause, not app regressions**: better-sqlite3
  native module compiled for NODE_MODULE_VERSION 147 (Node 26 — matching `engines: >=26`)
  while the shell's `node` was v24.14.1 (NODE_MODULE_VERSION 137) — `openDatabase`
  (app/server/db/sqlite.server.ts:14) throws on load, failing all 63 DB-touching files.
  Pure-logic files (e.g. app/shared/capabilities.test.ts, 7/7) pass. Run under Node 26 (or
  `npm rebuild better-sqlite3` for the active node) to get a true signal. Not debugged
  further per task instructions.

---

## 9. Notable findings / gotchas (verified)

1. Migration numbering skips 0007 (db/migrations/ has 0006 → 0008).
2. Availability ≠ validity: `/resources/health` backends and the runtime registry only check
   env-var presence (runtime-registry.server.ts:59) — an expired token still reads "real".
3. `allowedTools` only auto-approves; `disallowedTools` is the real restriction (removes tools
   from context, binds under bypassPermissions) — claude-runtime.server.ts:50-56 and the
   operator/specialist confinement both rely on the deny side.
4. Capability enforcement is backend-asymmetric: specialist git/gh denies bind on Claude only;
   Codex specialists get advisory persona text + `danger-full-access` sandbox
   (capabilities.ts:113-133, codex-runtime.server.ts:168).
5. Specialist workspace isolation: cwd is always `<taskDir>/workspace[/<repo>]` with
   `GIT_CEILING_DIRECTORIES=<taskDir>` (strict ancestor, specialist-run.server.ts:1232-1249) —
   the dogfooding fix that stops a run from checking out the host repo.
6. In-process-only state that a restart loses: run completion callbacks
   (run-service.server.ts:62-66, recovered at boot by run-recovery), the operator lease
   (DB-row backstop), and the SSE ring buffer (clients get `stream.resync`).
7. On-disk agent profiles still grant pruned capability ids (data/agents/profiles/developer.md
   `edit-other-task-branch`, operator.md `compress-timelines`/`owner-reassignment`) — inert but
   confusing to readers.
8. `create-project` is deliberately open to any signed-in user (routes/_index.tsx:108-113);
   org role is NOT consulted, pinned by test.
9. Better-auth owns sessions/oauth; legacy `users` stays the RBAC/profile source, bridged by
   id-equality — org plugin tables (organization/member/invitation) exist but Viberr RBAC does
   not read them yet.
10. MCP for specialists is wired config-only: `secret://` cred refs are never injected into
    the server config (specialist-mcp.server.ts docblock) — real-auth MCP is the remaining gap.
