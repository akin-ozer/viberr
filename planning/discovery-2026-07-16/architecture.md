# Viberr — Current Architecture (from code inspection, 2026-07-16)

Everything below was derived by reading the code at commit `81dafe3` (branch `main`),
not from docs. Paths are repo-relative; line numbers are from this commit.

Viberr is a **single-node monolith**: React Router 8 (framework mode) + Vite 8 +
TypeScript 7.0.2, Node >= 26, better-sqlite3. Canonical business truth is
**markdown files** under `${VIBERR_DATA_ROOT}` (`projects/<slug>/project.md`,
`projects/<slug>/tasks/<KEY>/task.md`); SQLite is a **rebuildable projection**
(plus a few app-owned tables: users, auth, notifications, audit, secrets, runs).
AI agents run in-process via `@anthropic-ai/claude-agent-sdk` (0.3.207) and
`@openai/codex-sdk` (0.144.1), with a deterministic **simulated** engine as fallback.

---

## 1. Boot sequence

`app/server/boot.server.ts` (`bootServer()`, called from entry.server module scope,
HMR-safe via `Symbol.for("viberr.booted")`):

1. `getEnv()` — zod-validated env (`app/server/config/env.server.ts`), fail-fast.
2. `ensureDataRootDirs()` — creates `DATA_ROOT_SUBDIRS` (`app/server/files/file-store-root.server.ts:24`):
   `projects, agents, agents/profiles, runtimes, runtimes/claude-home, kb, skills, state, cache, auth, logs`.
   **Note: `runtimes/codex-home` is NOT in this list** (relevant to Docker, §12).
3. `seedDefaultAgentAssets()` — ships built-in agent assets (operator + Developer + Reviewer
   definitions, expertise skills, profile templates) from `app/server/seed/assets/` into the
   store when missing (never clobbers edits).
4. `getDb()` — opens SQLite, auto-applies pending migrations from `db/migrations/`.
5. `seedInitialAdmin()` — seeds an admin when `users` is empty (env `VIBERR_SEED_ADMIN_*`).
6. `startEventPublisher()` — bridges projection events → SSE broker (§8).
7. `rescanProjections()` — hash-short-circuit boot reconcile of offline file drift.
8. `ensureBaseAgentsDeployed()` — operator unconditionally ensured on every project;
   Developer/Reviewer added only where the roster was never deliberately edited (E10).
9. `startFileWatcher()` — chokidar v5 on `${dataRoot}/projects` (250 ms debounce,
   ignores dotfiles/`*.tmp`, handles `unlinkDir`) driving incremental reprojections.
10. `registerSeededLiveFromData()` — re-registers seeded "running" runs' live drip lines.
11. `recoverUnreactedAgentRuns()` (`app/server/runtimes/run-recovery.server.ts`) — boot
    recovery for finished-but-unreacted specialist/reviewer runs (server restarted before
    the in-process completion callback fired): posts the missing reply + re-invokes the
    operator. Keyed off missing `task.agent.replied` audit rows; idempotent.
12. `logBootIntegrity()` — data-root dirs + migration count + projection counts.

---

## 2. Route map

Defined in `app/routes.ts`. All mutations are CSRF-checked POST intents (`_csrf` field,
`app/server/auth/csrf.server.ts`); toast copy is computed server-side.

| Route | File | Loader / Action |
|---|---|---|
| `/` | `routes/_index.tsx` | Home multi-project landing; loader = project cards + pins (`features/home/home-query.server.ts`); action = create-project (`project-create.server.ts`), pins, rescan. |
| `/login` | `routes/login.tsx` | Two modes (providers + local credentials, forced pw-reset); better-auth sign-in; rate-limited (`auth/rate-limit.server.ts`). |
| `/logout` | `routes/logout.tsx` | POST; revokes better-auth session, audits `auth.logout`. |
| `/api/auth/*` | `routes/api.auth.$.ts` | Splat → better-auth's own handler (OAuth callbacks, `.well-known`, getSession). No app CSRF (better-auth Origin check). |
| `/org/users` | `routes/org.users.tsx` | Redirect → `/org/settings?tab=users` (legacy). |
| `/org/settings` | `routes/org.settings.tsx` | Org-admin surface. Loader = all slices (`org/org-view.server.ts`): GitHub owner connections, users & Google-domain allowlist, KBs/MCPs/skills (disk-scanned), global agent templates. Actions = every org mutation intent incl. StoreBrowser multipart uploads. |
| `/profile` | `routes/profile.tsx` | PageOverlay; identity, notification routing prefs (`user_prefs`), appearance, password change. |
| `/notifications` | `routes/notifications.tsx` | PageOverlay; "waiting on you" + day-grouped stream from `notifications` table. |
| `/notifications/read` | `routes/notifications.read.tsx` | POST-only fetcher; intents `read` / `read-all`; emits user-scoped `notification.read` SSE. |
| `/prefs/theme` | `routes/prefs.theme.tsx` | POST; persists `users.theme` + `viberr_theme` cookie. |
| `/resources/events` | `routes/resources.events.ts` | **SSE stream** (§8). Authenticated; `?scope=` params (`project:<slug>`, `task:<slug>/<key>`, `projects`, `user`); Last-Event-ID replay. |
| `/resources/run-log` | `routes/resources.run-log.ts` | Run-log tail since `?since=<seq>` — the dedicated log consumer fetches after a `run.log-appended` SSE ref. Any signed-in user. |
| `/resources/health` | `routes/resources.health.ts` | Unauthenticated ops probe: `{ ok, projections:{projects,tasks}, watcher, backends:{claude,codex: "real"\|"simulated"} }` (env-presence only, never validity). |
| `/resources/model-catalog` | `routes/resources.model-catalog.ts` | Model + effort catalog per backend for the agent modal (§11). |
| `/resources/session-export` | `routes/resources.session-export.ts` | Downloads a self-contained bash installer carrying a run's provider transcript for local resume (§11). |
| `/projects` | `routes/projects.tsx` | Redirect → `/`. |
| `/projects/:slug` | `routes/project.tsx` | Workspace shell layout (rail + topbar); loader = project + live rail counts; children read via `useRouteLoaderData("routes/project")`. |
| `/projects/:slug` (index) | `routes/project._index.tsx` | Redirect → `board`. |
| `…/board` | `routes/project.board.tsx` | Board columns from layout loader; actions: `create-task`, `rescan`, reorder (board_rank). |
| `…/review` | `routes/project.review.tsx` | Read-only review queue (`projections/review-queue.server.ts` — the workflow-resolved review stage, not literal "review"). |
| `…/agents` | `routes/project.agents.tsx` | Agent governance: roster (org templates ⊕ project.md deployments) + live deployments projection; profile CRUD actions (admin `manage-agents`). |
| `…/policy` | `routes/project.policy.tsx` | Members + roles, workflow boundaries, RBAC table (renders `RBAC_TABLE` from `app/shared/rbac.ts`); actions `set-role` (last-admin guard), `set-boundary` (review→done hard-locked human). |
| `…/github` | `routes/project.github.tsx` | Repo panel (checkRepoAccess + credential health) + PR/branch rows; actions `reconcile` → `reconcileProject`, `grant-scope` → revalidate credential. |
| `…/activity` | `routes/project.activity.tsx` | Cross-task activity stream (`task_events`) + audit log panel; `?stream=`/`?audit=` pagination. |
| `…/settings` | `routes/project.settings.tsx` | Identity, stage editor, membership CRUD, repo override, grant-scope, danger-zone delete/archive. |
| `…/tasks/:key` | `routes/project.task.tsx` | The full task workspace. Loader = task + bounded timeline slice (`?events=`) + runs + recommendations. Action intents: `comment` (with @mention resume), `resolve-packet`, `owner-take/assign/release`, `transition`, `run-interrupt`, `assign-specialist`, `run-specialist`, `assign-reviewer`, `run-reviewer`, `remove-reviewer`, goal update, recommendation apply/dismiss, merge completion. |

---

## 3. Server module map (`app/server/*`)

| Dir | Purpose / key entry points |
|---|---|
| `audit/` | Append-only governed-action log. `audit-recorder.server.ts` (`recordAudit`, swallows failures); `audit-actions.ts` = canonical action catalog, statically enforced against every call site by `audit-coverage.server.test.ts`. |
| `auth/` | better-auth bridge + app RBAC plumbing. `app/lib/auth.server.ts` = better-auth instance (owns credentials/sessions/OAuth/org membership); legacy `users` table stays the canonical profile/org-role store, bridged by invariant `user.id === users.id` (`identity.server.ts`). `require-user.server.ts`/`require-project.server.ts`/`project-role-guard.server.ts` guards; `csrf.server.ts`; `oauth-provision.server.ts` (whitelist = account row exists, Google domain allowlist, GitHub-handle placeholder claiming — both **wired**, not stubs); `rate-limit`, `seed-admin`, `user-admin`, `password`. |
| `config/` | `env.server.ts` — zod schema of every env var (see §12 for the runtime-credential set), cached via global symbol. |
| `db/` | `sqlite.server.ts` (open + auto-migrate), `migration-runner.server.ts` (per-file transactions, `schema_migrations` bookkeeping), `schema-reconcile.server.ts` (self-heals columns added by editing already-applied migrations). |
| `errors/` | `AppError` + `ERROR_CODES` typed error envelope. |
| `events/` | SSE (§8): `sse-broker.server.ts`, `event-publisher.server.ts`, `projection-events.server.ts`. |
| `files/` | File-native store engine: `file-store-root.server.ts` (paths + `DATA_ROOT_SUBDIRS`), `atomic-file.server.ts` (tmp+rename), `file-mutex.server.ts` (per-path in-process mutex), `task-writer.server.ts`/`project-writer.server.ts` (frontmatter-preserving writers; unknown fields survive), `file-watch.service.server.ts` (chokidar), `kb-injection.server.ts` (the ONE KB→prompt reader, recursive, all text extensions, global `KB_INJECTION_BUDGET`), `frontmatter.server.ts`, `agent-profile-file.server.ts`, `actor-ref.server.ts`. |
| `github/` | §9. `github-client.server.ts` (fetch wrapper, rate-limit aware), `github-context.server.ts` (project credential resolution), `branch-sync.server.ts` (`taskBranchName`, `ensureTaskBranch`, compare), `pr-open.server.ts` (`openTaskPr`), `pr-linker.server.ts` (`findPrForBranch`, PR state cache vocab), `github-reconciler.server.ts` (`reconcileTask/reconcileProject/mergeTaskPr`), `workspace-delivery.server.ts` (agent-side delivery reconciliation), `scope-flag.server.ts` (policy-engine scope violations), `repo-access-check.server.ts`, `git-clone-auth.server.ts` (ephemeral askpass PAT clone plan, remote-URL sanitization). |
| `interpretation/` | `readiness-policy.server.ts` — the ONLY place task readiness is derived (stored readiness, floored downward by diagnostics; never improved). `diagnostics-policy.server.ts` — severity → readiness-floor mapping (info/warning/error/hardStop). |
| `logging/` | `logger.server.ts` structured logger. |
| `org/` | Org-settings server layer: `org-users.server.ts` (local/Google/GitHub-handle account provisioning, domain allowlist), `connections.server.ts` (GitHub owner ↔ PAT bindings, validate-before-save), `resources.server.ts` (KB/MCP/skill CRUD; disk is truth; HTTP MCP health probes are real), `resource-catalog.server.ts` (live grantable-resource catalog for agent profiles), `gagents.server.ts` (global agent profile templates under `agents/profiles/*.md`), `store-files.server.ts` (StoreBrowser real FS ops + GitHub tree import), `org-view.server.ts`, `org-seed.server.ts`. |
| `prefs/` | `user-prefs.server.ts` key-value JSON per user. |
| `projections/` | Files → SQLite: `rebuilder.server.ts` (`rebuildAll`/`rebuildPath`, content-hash short-circuit, provenance rows), `rescan.server.ts`, `rebuild.server.ts` (drop-and-rebuild recovery hammer), read models `board-query`, `task-query`, `activity-feed`, `notifications` (fan-out + routing prefs), `review-queue`, `policy-violations`, `agent-deployments`. |
| `runtimes/` | §7. Adapters + run lifecycle service + operator runtime + catalog + export. |
| `secrets/` | `secret-box.server.ts` AES-256-GCM (`v1$iv$ct$tag`, key = `VIBERR_SECRET_ENCRYPTION_KEY`); `pat-store.server.ts` encrypted GitHub PATs (only last-4 suffix kept in clear); `pat-validator.server.ts` (classic scopes via `x-oauth-scopes`; fine-grained = "assumed"). |
| `seed/` | `demo-seed.server.ts` (mock-parity demo dataset), `default-assets.server.ts` + `assets/` (built-in agent definitions/skills/profiles), `ensure-base-agents.server.ts`, `demo-data.server.ts`. |
| `tasks/` | §6–7. `task-actions.server.ts` (2,988 lines — create/comment/@mention/ownership/transition/packet resolve/reorder/accept-completion/merge + the agent-completion react loop), `specialist-run.server.ts` (assign + run specialists/reviewers, clone, persona, confinement), `operator-actions.server.ts` (capability-gated operator mutations + `gate()`/`resolveOperatorAuthority()`), `operator-toolkit.server.ts` (in-process `viberr` MCP server), `specialist-tool-policy.ts` (capability → `disallowedTools`), `specialist-mcp.server.ts` (declared org MCPs → SDK shapes), `agent-reply.server.ts` (mention resolution + reply extraction + `runFailureReason` quota/auth classification), `comment-guardrails.server.ts`, `timeline-compaction.server.ts`, `mention-suggestions.server.ts`, `git-clone-auth.server.ts`, `model-prose.server.ts` (`normalizeEscapedNewlines`). |
| `theme/` | `theme-cookie.server.ts`. |

`app/shared/`: `rbac.ts` (§6), `capabilities.ts` (§6), `workflow/stage-roles` (resolves
work/review/done stage ids from the workflow graph, not positionally), `ids/`, `dates/`,
`mapping/` (DB row → camelCase render shapes), `auth/`.

`app/schemas/`: zod schemas + tolerant parsers for `project-file` (stages, workflow
boundaries `auto|approval|human`, members, capability grants, agent deployments,
guardrails), `task-file` (frontmatter: key/title/stage/readiness/waiting/owner/
specialist/reviewers/operator/packet/recommendations/urgent/validation/branch/repo/
pr/github-cache/boardRank + timeline events), `sse-event`, `github-pat`, `file-diagnostics`.

### Features (`app/features/*`) — one line each
- `activity/` — activity stream + audit panel UI.
- `agents/` — agent roster page, create/edit profile modal, capability matrix modal, `agents-query.server.ts` (`effectiveProfileView` = org template ⊕ deployment definition merge).
- `board/` — kanban board UI + filters.
- `github/` — GitHub view (repo card, credential card, PR pills) + `github-actions.server.ts`.
- `home/` — landing page, project create.
- `kb-browser/` — StoreBrowser tree UI for KB/skill folders.
- `live-updates/` — SSE client (`sse-client.ts`, `use-live-updates.ts` → route revalidation).
- `notifications/` — bell + notifications page components.
- `org-settings/` — org settings panels (users, connections, resources).
- `policy/` — policy page (RBAC table, boundaries) + `policy-rbac.server.test.ts` binding guards to display.
- `profile/` — profile overlay.
- `project-settings/` — settings page + membership server layer.
- `review/` — review queue page.
- `runtime/` — run panels, log console, `use-run-log-stream.ts`, `runtime-types.ts` (RunKind/RunState/LogLine).
- `shell/` — workspace rail/topbar/user menu/bell.
- `task-detail/` — task page: timeline, composer with @mention autocomplete, decision packets, operator recommendations, runtime slots, release-confirm.

`app/ui/` — shared primitives: avatar, csrf-input, icon, identity, markdown (react-markdown+gfm), mention-spans, page-overlay, pill, rich-text, stage-menu, toast, toggle, use-dialog.

---

## 4. Database schema

Migrations live in `db/migrations/*.sql` (13 files, `0007` gap is intentional/absent),
applied automatically at boot and via `npm run migrate` (which also runs the
schema-reconciler). SQLite file lives under the data root.

App-owned tables (truth):
- **users** (0001+0002+0009): `id, email(unique), name, title, role('admin'|'member'), password_hash, idp('local'|…), avatar_tone, pwreset_required, theme, disabled, created_at, updated_at, last_login_at, created_by, github_handle`.
- **audit_events** (0002): `id, occurred_at, actor_user_id, actor_label, action, subject_kind, subject_id, project_slug, task_key, details_json`.
- **user_prefs** (0004): `(user_id, key) PK, value_json, updated_at`.
- **notifications** (0003): `id, user_id, kind('packet'|'approval'|'mention'|'quality'|'policy'), ptype('input'|'blocked'), title, text, actor_json, project_slug, task_key, occurred_at, read_at, created_at`.
- **github_pats** (0005): `id, user_id, label, encrypted_token, token_suffix, created_at, last_validated_at, validation_json`.
- **project_github_credentials** (0005): `project_slug PK (soft ref), pat_id, created_at, updated_at`.
- **scope_violations** (0005): `id, project_slug, task_key, scope, detail, status('open'|'resolved'), created_at, resolved_at, resolved_by`; partial unique idx = one OPEN per (project, scope, task). **Migration seeds a mock violation row `sv_seed_vib142_pr_write` for `viberr-core`/`VIB-142`** (see §13).
- **github_connections** (0008): `id(slugified owner), owner unique, pat_id, is_default, repos_count, expires_at, created_at, updated_at`.
- **google_domain_allowlist** (0008): `id, domain unique, role('admin'|'member'), created_at` — consumed by `oauth-provision.server.ts`.
- **org_knowledge_bases** (0008): `id, name, dir unique, refresh('manual'|'on change'|'nightly'), last_indexed_at, created_at, updated_at` (content = real folders under `kb/`).
- **org_mcp_servers** (0008): `id, name unique, transport('HTTP'|'stdio'), target, cred_ref, tools_count, up, last_checked_at, created_at, updated_at`.
- **org_skills** (0008): `id, name unique, summary, created_at, updated_at` (content under `skills/<name>/SKILL.md`).
- **agent_runs** (0006, rebuilt in 0011, +0010 cols): `id, task_key, project_slug, thread_id, role, kind('operator'|'primary'|'reviewer'), backend('claude'|'codex'|'simulated'), simulated(0/1), model, session_id, sdk, state('queued'|'running'|'finished'|'error'|'interrupted'), phase, step, started_at, finished_at, turns, input_tokens, cached_input_tokens, output_tokens, total_cost_usd, interrupted_by, created_at, updated_at, agent_name, agent_profile_id`. Unique `(project_slug, task_key, thread_id)`.
- **run_log_lines** (0006/0011): `id, run_id FK cascade, seq, occurred_at, raw_json (exact wire envelope), display_json (projected LogLine), created_at`. Raw truth is ALSO an append-only `.jsonl` at `${DATA_ROOT}/runtimes/<backend>/<runId>.jsonl` (`run-store.server.ts`).
- better-auth (0013, generated by `scripts/gen-better-auth-schema.ts`): **user, session, account, verification, organization, member, invitation** (camelCase columns; `user.githubHandle`). 0014 drops the legacy hand-rolled `sessions` table.

Projection tables (rebuildable from files, 0003 + 0011 + 0012):
- **projects**: `slug PK, name, archived, repo, default_branch, task_prefix, description, stages_json, workflow_json, agent_policy_json, credential_policy_json, guardrails_json, source_path, content_hash, parsed_at`.
- **project_members**: `(project_slug, user_id) PK, role CHECK in ('admin','maintainer','contributor','viewer')`.
- **task_projections**: `(project_slug, task_key) PK, title, stage, readiness('ready'|'input_required'|'inconsistency_risk_detected'|'blocked'), stored_readiness, waiting('human'|'agent'|'none'), urgent, validation('healthy'|'changed'|'failing'|'none'), owner_user_id, specialist_json, reviewers_json, operator_json, branch, repo, pr_json, github_json, goal, packet_json, event_count, comment_count, diagnostic_count, created_at, updated_at, source_path, content_hash, parsed_at, board_rank`.
- **task_events**: per-task timeline replaced wholesale on reproject: `id, project_slug, task_key, position(0=newest), occurred_at, type, actor_kind('human'|'agent'|'operator'|'system'), actor_ref, actor_json, title, text, to_agent, evidence_json`.
- **diagnostics**, **provenance** — parse diagnostics + rebuilder observation log.

---

## 5. Scripts (`scripts/`)

- `run-migrations.ts` (`npm run migrate`) — applies pending SQL + `reconcileSchemaFromMigrations` column self-heal.
- `seed.ts` (`npm run seed [-- --reset]`) — full demo dataset (users incl. `arda@viberr.dev` admin, agent templates, project/task files, projections, notifications, seeded runs) + `seedOrgResources` (real KB/skill files, domain allowlist; deliberately NO fabricated MCPs/GitHub connections). `--reset` wipes projects/, agents/profiles, kb/, skills/ and derived tables first.
- `rescan.ts` (`npm run rescan [-- --force]`) — file store ↔ projection reconcile.
- `gen-better-auth-schema.ts` — regenerates migration 0013 from better-auth's engine.

---

## 6. RBAC & capability model

### Org roles
Two: `users.role ∈ {admin, member}` (migration 0001; enforced by `requireRole` in the
auth layer — org settings and user admin are org-admin only). better-auth's
organization-plugin `member.role` exists in parallel but the legacy `users` table is
canonical for app RBAC.

### Project roles + action matrix — `app/shared/rbac.ts` (single source)
`PROJECT_ROLES = viewer ⊂ contributor ⊂ maintainer ⊂ admin` (strict monotonic tier,
`ROLE_RANK` at line 27). `ACTION_ROLES` (line 75) is THE map both server guards
(`requireAction` in task-actions) and the Policy page table (`RBAC_TABLE`, line 113)
consult; `policy-rbac.server.test.ts` binds them.

| RbacAction | Roles |
|---|---|
| `view`, `comment` | all four — but actually app-wide: ANY authenticated user (FR4); shown in the table, not gated by `requireAction`. |
| `create-task`, `own-task` (take/release OWN ownership), `reconcile-github` | contributor+ |
| `approve-transition`, `resolve-packet` (task owner additionally allowed at call site), `accept-completion`, `run-agents` (assign/run/prompt/interrupt agents), `reorder-board`, `update-goal`, `grant-github-scope` | maintainer+ |
| `release-any-ownership`, `manage-members`, `manage-agents`, `edit-policy` (incl. project settings via requireProjectAdmin) | admin |

### Agent capability catalog — `app/shared/capabilities.ts`
`CAP_CATALOG` (line 29): 25 id'd capabilities grouped as operator-coordination
(`assign-primary-specialist, summon-reviewers, generate-packets, append-typed-events,
stage-transitions, completion-for-acceptance, execute-code-or-write-repo`), delivery
(`create-task-branch, commit-push-branch, run-unit-integration-validation,
open-review-pr, move-task-to-review, report-validation-verdict`), review
(`read-repo-diff, run-validation-suites, post-quality-flags, comment-on-task,
approve-review, request-changes`), validation (`author-test-cases,
attach-evidence-references`), shared (`read-task-repo, flag-underspecified-tasks`),
and always-human (`merge-pull-request, transition-to-done, change-project-policy`).

- Grants are stored per agent deployment in project.md as `{capabilityId, mode}` with
  `mode ∈ {direct, recommend, human, off}` (`CAPABILITY_MODES`, project-file.schema.ts:41).
- **ALWAYS_HUMAN_CAPABILITY_IDS** (line 72): `merge-pull-request`,
  `transition-to-done`, `change-project-policy` — coerced to `human` at grant-persist
  time; Done boundary additionally locked in workflow policy + operator completion path.
- **ENFORCED_CAPABILITY_IDS** (line 96) really bind at runtime; the rest are advisory
  persona guidance. **CLAUDE_ONLY_ENFORCED** (line 128): `create-task-branch,
  commit-push-branch, open-review-pr, execute-code-or-write-repo` bind via Claude
  `disallowedTools` only — **the Codex SDK has no tool deny-list, so these are advisory
  on Codex** (deliberate, honestly labeled via `capabilityEnforcement()`).
- Specialist enforcement mapping: `app/server/tasks/specialist-tool-policy.ts`
  (`CAP_DENY_RULES`, line 30) — withheld (`human`/`off`/always-human) caps become deny
  specifiers, e.g. `Bash(git push:*)`, `Bash(gh pr create:*)`, `Bash(gh pr merge:*)`,
  and `execute-code-or-write-repo` → `Edit/MultiEdit/Write/NotebookEdit/Bash(git commit:*)`.
  Deny wins even under `bypassPermissions`.
- Operator enforcement: capabilities in `off`/`human` mode ⇒ the corresponding
  `mcp__viberr__*` tool is **not built at all** (`operator-toolkit.server.ts`), and the
  run's `allowedTools` confines it to exactly the built set; the Claude adapter
  additionally denies `Bash/Edit/MultiEdit/Write/NotebookEdit/Task` for operator runs
  (`claude-runtime.server.ts:112`).
- Operator `gate()` (`operator-actions.server.ts:189`): `direct`→act;
  `recommend`→recommendation card, promoted to direct under FULL autonomy **except**
  `completion-for-acceptance` (must be explicitly `direct` — owner ruling Q1);
  `human`/`off`→deny.

---

## 7. Agent runtime lifecycle (dispatch → workspace → run → deliver → review)

### 7.1 Adapters & registry (`app/server/runtimes/`)

`adapter.server.ts` defines `RuntimeAdapter.start(spec, callbacks) → RunHandle`
(`onLine`/`onPhase`/`onExit`; `interrupt()`).

- **claude-runtime.server.ts** — official Claude Agent SDK `query()` in streaming-input
  mode (single async-iterable user message → `Query.interrupt()` works). Options:
  `cwd = spec.workdir`, model resolved by `resolveClaudeModel` (family label → cli alias
  `sonnet/opus/haiku`; dated ids pass through), `effort`,
  `permissionMode: bypassPermissions` when autonomous, `maxTurns: 50`, and full **SDK
  isolation: `settingSources: [], skills: [], plugins: []`** so host `~/.claude`
  settings/skills/plugins never reach a run (known dev-only leak: running the server
  from inside an active Claude Code session inherits the parent's managed toolset at
  process level — documented at lines 210–216). System-prompt strategy: operator persona
  REPLACES the default; specialist persona is APPENDED to the `claude_code` preset.
  Denylist = operator built-ins + capability denies. Live token/turn accumulation from
  assistant usage; success gated on final `result` with `is_error=false`.
- **codex-runtime.server.ts** — official Codex SDK. `codex.startThread({ workingDirectory,
  skipGitRepoCheck, sandboxMode, model, modelReasoningEffort, approvalPolicy: "never" })`
  then `thread.runStreamed(prompt, { signal, outputSchema? })`. **Sandbox matrix (line
  334): operator → `read-only` (+ `networkAccessEnabled:false`, `webSearchMode:disabled`);
  autonomous specialist → `danger-full-access`; non-autonomous → `workspace-write`.**
  Per-run config (line 123): `developer_instructions` = persona,
  `allow_login_shell:false`, `features.apps:false`, memories fully disabled,
  `mcp_servers` = translated portable subset of the profile's MCPs (in-process `sdk`
  type skipped), `shell_environment_policy inherit:"core"` + `GIT_CEILING_DIRECTORIES`.
  **Idle (not wall-clock) timeout 15 min** (`VIBERR_CODEX_IDLE_TIMEOUT_MS`) aborts hung
  runs → `error`. **Error redaction**: raw SDK/CLI stderr is never logged or persisted;
  failures are classified in-memory (quota/auth regexes, line 180) then replaced by
  canonical messages ("Codex execution failed. Review its authentication…").
  Success = saw `turn.completed` with no top-level `turn.failed`/`error`.
- **simulated-runtime.server.ts** — the default demo engine: scripted `LogLine` streams
  replayed over timers, fabricating wire-authentic raw envelopes via
  `rawLineFromDisplay` (wire-format.server.ts).
- **runtime-registry.server.ts** — availability = **credential presence only** (never a
  paid call): claude = `ANTHROPIC_API_KEY | CLAUDE_CODE_OAUTH_TOKEN |
  VIBERR_CLAUDE_USE_CLI_AUTH=1`; codex = `CODEX_ACCESS_TOKEN | CODEX_API_KEY |
  OPENAI_API_KEY | VIBERR_CODEX_USE_CLI_AUTH=1`; `VIBERR_FORCE_SIMULATED_RUNTIME=1`
  forces simulated (e2e). Unavailable backend ⇒ simulated adapter with the requested
  backend kept on the row (`simulated=1`). Env plumbing:
  - Claude SDK env MERGES into process.env; adapter passes process.env + credential +
    `CLAUDE_CONFIG_DIR = resolveClaudeConfigDir()` (data-root `runtimes/claude-home`
    unless CLI-auth mode → real `~/.claude`; explicit env always wins).
  - **Codex SDK env REPLACES the child env wholesale**, so `codexSpawnEnv()` (line 132)
    builds a full env from process.env **minus anything matching a credential-ish key
    regex** (`API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIALS|AUTH`),
    then force-sets `CODEX_HOME` and re-adds `CODEX_ACCESS_TOKEN`; when subscription
    auth is chosen it deletes `CODEX_API_KEY`/`OPENAI_API_KEY` so billing can't silently
    switch to API mode. The SDK locates the `codex` binary in the vendored optional
    platform package (`@openai/codex-<platform>/vendor/<triple>/bin/codex`).

### 7.2 Run service (`run-service.server.ts`)

The ONLY module routes call for runtime work: `startRun / resumeRun / interruptRun /
listRunsForTask / getRunLog`. `startRun` selects adapter, inserts the `queued` row,
audits `runtime.run.started`, wires `createRunSink` (persist raw jsonl + DB line +
fold usage, THEN publish `run.log-appended` / `run.state-changed` SSE), launches.
Live `RunHandle`s + one-shot completion callbacks live in a process-global registry
(`registerRunCompletion` / `chainRunCompletion`); **callbacks are in-process only — a
restart loses them (recovered at boot, §1.11)**. `resumeRun` mints a NEW run row with a
fresh thread id sharing the provider `session_id`, and re-applies confinement
(denylist/env/MCP/persona — XS-1). `interruptRun` = `run-agents` RBAC, idempotent.

### 7.3 Dispatch — who starts runs

1. **Humans** via task-detail intents (assign/run specialist/reviewer) or Board create.
2. **@mention comments** (`commentToAgent`, task-actions.server.ts:762): `@dev`,
   `@claude`, `@codex`, `@agent`, `@operator` resolve (agent-reply.server.ts) and resume
   that agent's session with the comment as prompt (or run the operator with
   `humanComment`).
3. **The operator** — auto-invoked on task create, on transitions, on agent replies, and
   manually. `runOperator` (`operator-run.server.ts:196`):
   - **Single-flight lease per task** (process map + DB-row backstop); concurrent
     triggers are queued newest-wins and fired on release.
   - **claude available** → real tool-driven run: persona (store definition
     `agents/definitions/operator.md` or baked-in fallback) + every declared skill +
     KB (budgeted) + live capability policy as system prompt; in-process `viberr` MCP
     toolkit (`get_task, post_comment, open_decision_packet, assign_specialist,
     run_specialist, prompt_specialist, assign_reviewer, run_reviewer, prompt_reviewer,
     transition_stage, accept_completion`).
   - **codex available** → structured-output run: `OPERATOR_PLAN_SCHEMA` JSON plan,
     zod-revalidated (trust boundary), executed through the SAME gated operator-actions
     (`executeCodexPlan`, aborts remaining plan on first failure; no-plan ⇒ blocked
     recovery packet). Codex has no in-process MCP channel.
   - **neither** → deterministic scripted drive calling the same gated actions +
     a simulated narration run.
   - Failed operator runs escalate a blocked packet (F-OP1) — quota/auth-aware copy.
4. **Boot recovery** re-drives lost completions (§1.11).

### 7.4 Workspace & isolation (per-task, NOT git worktrees)

`startSpecialistRun`/`startReviewerRun` (`specialist-run.server.ts:483/724`):
- Resolve the deployed profile (`project.md agents:` ⊕ org template), stage-eligibility
  asserted at assign AND run time (F1).
- Best-effort `git clone` of the project repo into
  **`<dataRoot>/projects/<slug>/tasks/<KEY>/workspace/<repoName>`** (`cloneRepo`,
  line 1301) using a project-bound PAT via an **ephemeral askpass** plan
  (`git-clone-auth.server.ts`) or credential-free for public repos; re-used clones get
  their origin URL sanitized (legacy embedded-PAT scrub).
- Run cwd is ALWAYS inside the per-task `workspace/` (never the task dir); clone failure
  ⇒ empty workspace root + prompt tells the agent to clone itself.
- `GIT_CEILING_DIRECTORIES` pinned to the **task dir** (strict ancestor of both cwd
  shapes) so agent git can never discover a host checkout above the data root
  (`workspaceRunEnv`, line 1282). Explicit code comment: this constrains Git discovery
  only — autonomous Codex specialists still need an OS/container boundary for real FS
  isolation (line 1222).
- Persona = agent definition + declared skill bodies + KB docs (global
  `KB_INJECTION_BUDGET`); prompt = task/goal + **workspace & delivery contract**
  reflecting the profile's delivery permissions (branch name
  `taskBranchName(key,title)`, `[KEY]` commit prefix, push/PR instructions omitted when
  withheld — XS-4).
- `markWaitingAgent` flips the board to "agent working";
  `registerAgentCompletion` installs the one canonical completion handler.

Note: the repo's `.claude/worktrees/` (334 git worktrees named `agent-*`) belongs to the
**Claude Code dev tooling used to build viberr**, not to the app runtime — the app's
isolation unit is the per-task `workspace/` clone described above. Similarly
`.claude/skills/react-doctor/` is a dev-tooling skill; the AGENTS' skills live in the
data root (`${DATA_ROOT}/skills/<name>/SKILL.md`, seeded from
`app/server/seed/assets/`: `viberr-app-expertise`, `developer-expertise`,
`reviewer-expertise` + definitions for operator/developer/reviewer).

### 7.5 Completion → deliver → review → done

`applyAgentCompletionEffects` (task-actions.server.ts:1523) — shared by live callback
and boot recovery:
1. Post the agent's reply comment (guardrails: meaningless-chatter drop, operator
   brevity cap, evidence separation; timeline compaction keeps the canonical file lean).
2. `error` runs (real only): typed `blocked` timeline event with quota/auth-aware
   reason, stuck-loop packet, watcher notifications, waiting→human, stop (F8).
3. `finished` real runs: **`reconcileWorkspaceDelivery`**
   (`github/workspace-delivery.server.ts:193`) — inspects the workspace git repo the
   agent actually used (`git rev-parse --abbrev-ref HEAD`, shallow-aware
   `git log origin/<default>..HEAD`, `gh pr view <branch> --json`) and reconciles
   task.md `branch` / `github.commits` / `pr` from what the agent really did, with
   idempotence + "accepted" (merge-pending) state protection. Never throws.
4. Reviewer runs: `recordReviewerVerdict` classifies the FULL reply
   (`classifyReviewerVerdict`) → approve / request-changes quality events.
5. React loop: re-invoke the operator with `trigger:"agent-reply"` at `reactDepth+1`,
   bounded by `OPERATOR_REACT_DEPTH_CAP`; verbatim-repeated replies (CTL-3 no-progress
   guard) or depth cap ⇒ stuck-loop packet; chain end always flips waiting→human.

Server-side (PAT) delivery path complements the agent-side one:
- `operatorTransitionStage` → `ensureTaskBranchBestEffort`
  (operator-actions.server.ts:871) creates the task branch via the GitHub API.
- `transitionStage` into review → `openReviewPrBestEffort` → `openTaskPr`
  (task-actions.server.ts:2301→2309, pr-open.server.ts:117).
- Human accept / operator full-autonomy `accept_completion` → PR marked `accepted`
  (merge pending); `completeTaskMerge` / `mergeTaskPrIfPossible` →
  `mergeTaskPr` (github-reconciler.server.ts:422). Scope failures (403) open
  `scope_violations` via `flagScopeViolation`; `reconcileProject`/`reconcileTask` sync
  PR/branch state on demand from the GitHub view. **This path is live code** (wired from
  task-actions/operator-actions/routes) — the 2026-07-09 "dead delivery" finding has
  since been closed.

---

## 8. Events / SSE

- `events/projection-events.server.ts` — in-process EventEmitter; every mutation ends in
  `rebuildPath`/`rebuildAll` which emit `task.updated/removed`, `project.updated/removed`,
  `projection.rebuilt`, `notification.created/read`, `violation.updated`.
- `events/event-publisher.server.ts` — translates those into compact SSE events
  (facts + refs, never fat objects).
- `events/sse-broker.server.ts` — fan-out with per-connection scope filters
  (`project:`, `task:`, `projects` firehose, `user`), 25 s heartbeats, 256-event ring
  buffer with `Last-Event-ID` replay (or `stream.resync`), backpressure-safe drops,
  SIGINT/SIGTERM graceful close.
- High-frequency `run.log-appended` / `run.state-changed` publish **directly** to the
  broker from the run sink (never through the projection emitter).
- Client: `features/live-updates/use-live-updates.ts` → route revalidation;
  `features/runtime/use-run-log-stream.ts` fetches `/resources/run-log?since=` on each
  log event.

---

## 9. GitHub layer summary

Two complementary delivery paths (both live):
1. **Server/PAT path** — project-bound PAT (`project_github_credentials` → encrypted
   `github_pats`) drives `ensureTaskBranch`, `openTaskPr`, `mergeTaskPr`,
   `reconcileTask/Project`, `findPrForBranch`, `checkRepoAccess`; 403s raise scope
   violations (rail badge), resolved by `grant-scope` revalidation.
2. **Agent/workspace path** — the coding agent pushes/opens PRs itself with its own
   git/gh auth inside the per-task workspace; `reconcileWorkspaceDelivery` then folds
   the real branch/commits/PR back into task.md (NFR15 traceability).

PR state vocabulary on task.md: `review | accepted (merge pending) | merged | closed`
(`pr-linker.server.ts`), with guards so `accepted` never regresses to `review` while the
PR is still open.

---

## 10. Auth

better-auth 1.6.23 owns credentials/sessions/OAuth (GitHub, Google)/org membership
(`app/lib/auth.server.ts`, mounted at `/api/auth/*`); legacy `users` remains the
canonical profile + org-role store, invariant `user.id === users.id`
(`auth/identity.server.ts`). Whitelist model: an account row IS the whitelist entry;
Google domain allowlist and GitHub-handle placeholder claiming are enforced in
`oauth-provision.server.ts`. CSRF for app forms via session-bound `_csrf`
(`csrf.server.ts`); login rate limiting; secrets encrypted with
`VIBERR_SECRET_ENCRYPTION_KEY` (AES-256-GCM secret-box).

---

## 11. Run logs, session export, health, model catalog

- **Run logs**: canonical append-only `.jsonl` per run at
  `${DATA_ROOT}/runtimes/<backend>/<runId>.jsonl` (`run-store.server.ts` — always run-id
  keyed); queryable copies in `run_log_lines` (raw + display JSON); provider transcripts
  additionally live in `runtimes/claude-home/projects/<encoded-cwd>/<sid>.jsonl` and
  `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`.
- **Session export** (`runtimes/session-export.server.ts` +
  `routes/resources.session-export.ts`): locates the provider transcript by session id
  (claude: glob project dirs under `resolveClaudeConfigDir()`; codex: recursive walk of
  `$CODEX_HOME/sessions`), and emits a self-contained bash installer (base64-embedded
  transcript, no credentials) that drops the file where the local CLI expects it and
  prints `claude --resume <id>` (cwd-encoded, symlink-resolved) / `codex resume <id>`.
- **Health** `GET /resources/health`: `{ ok, projections, watcher, backends }` —
  watcher=false means the chokidar handle actually died; backends are env-presence only.
- **Model catalog** (`runtimes/model-catalog.server.ts`): curated per-backend fallback
  (claude family aliases; hand-maintained codex id list — codex has no list endpoint),
  enhanced for claude by a live `supportedModels()` query when a credential exists
  (TTL-cached, silent fallback). `resolveRunModel` rejects legacy display labels so
  invalid ids never reach an SDK.

---

## 12. Docker deployment & the codex-under-compose problem

### Deployment shape
- **Dockerfile**: 2-stage on `node:26-slim`. Build stage: apt `python3 make g++`
  (better-sqlite3 fallback toolchain), `npm ci`, `npm run build`, `npm prune --omit=dev`.
  Runtime stage: apt `git ca-certificates` (agents shell out to git/HTTPS);
  `ENV NODE_ENV=production, VIBERR_DATA_ROOT=/data,
  CLAUDE_CONFIG_DIR=/data/runtimes/claude-home, CODEX_HOME=/data/runtimes/codex-home,
  PORT=3000`; copies `node_modules`, `build`, plus `db/ scripts/ app/ tsconfig.json`
  (so `docker compose exec app npm run seed|migrate|rescan` work via tsx);
  `USER node`; `CMD npm run start` (react-router-serve).
- **compose.yml**: one `app` service; `env_file: .env` + hard overrides
  `NODE_ENV=production, VIBERR_DATA_ROOT=/data, CODEX_HOME=/data/runtimes/codex-home`;
  port `${PORT:-3000}`; volume `./docker-data:/data`; healthcheck curls
  `/resources/health` via node fetch.

### Evidence: why codex runs break under compose but not local dev

**Observed failure (live artifact in the repo):** `docker-data/runtimes/codex/`
contains 4 run logs from 2026-07-16 07:30–07:34, each exactly one line:
`{"type":"error","message":"Codex execution failed. Review its authentication and runtime configuration."}`
— the generic execution-phase fallback from `safeCodexFailureMessage`
(`codex-runtime.server.ts:180`), i.e. NOT classified as quota or auth by the regexes.
Meanwhile `docker-data/runtimes/claude-home/` is fully populated (projects, sessions) —
Claude runs succeeded in the same container. **`docker-data/runtimes/codex-home/` does
not exist at all** — the codex CLI never wrote a session or created its home.

**Root cause chain (config mismatch dev vs compose):**
1. The owner's `.env` configures codex auth as `VIBERR_CODEX_USE_CLI_AUTH=1` +
   `CODEX_HOME=/Users/akinozer/.codex` — i.e. "use the host Mac's logged-in codex CLI".
   That works in local dev (the spawned codex binary reads the host `~/.codex/auth.json`).
2. compose injects the same `.env` (env_file) but its `environment:` block **overrides
   `CODEX_HOME` to `/data/runtimes/codex-home`** — which is empty/nonexistent in the
   container. No `CODEX_ACCESS_TOKEN` is set (`.env` has no such key), and the README's
   required manual step for CLI-auth plans ("copy only `~/.codex/auth.json` to
   `./docker-data/runtimes/codex-home/auth.json`", README.md:100–102) was never done.
3. `VIBERR_CODEX_USE_CLI_AUTH=1` makes `hasCredential("codex")` return **true**
   (`runtime-registry.server.ts:73–78`) — availability is env-presence only — so the app
   selects the REAL codex adapter instead of falling back to simulated. Every codex run
   then spawns a CLI with no auth and dies immediately.
4. Diagnosis is hard **by design**: the adapter deliberately never logs or persists raw
   codex stderr (credential-redaction, `codex-runtime.server.ts:171–209`), so the only
   on-disk trace is the generic one-liner above.

**Contributing/secondary factors that would bite even after fixing auth:**
- `runtimes/codex-home` is **not** in `DATA_ROOT_SUBDIRS`
  (`file-store-root.server.ts:24`) — boot creates `runtimes/claude-home` but never the
  codex home, so nothing prepares the directory the container env points at.
- **Sandbox on Linux**: operator codex runs use `sandboxMode:"read-only"` and
  non-autonomous runs `workspace-write` (`codex-runtime.server.ts:334–339`). On macOS
  dev the binary sandboxes with Seatbelt; on Linux it needs Landlock/seccomp and a
  `codex-linux-sandbox` helper (binary strings include `Landlock`,
  `codex-linux-sandbox executable not found`, `Landlock was not able to fully enforce
  all sandbox rules`). Inside a default Docker container Landlock is frequently
  unavailable (kernel/seccomp profile), so sandboxed codex modes are likely to fail in
  compose while `danger-full-access` specialist runs would not. Untested here, but it is
  the next break in line once auth works.
- Binary resolution itself is fine in the image: the SDK resolves the vendored
  `codex` binary via the `@openai/codex` optional platform packages
  (`@openai/codex-linux-x64` etc. are in package-lock.json; `npm ci` in the linux build
  stage installs the right one and `npm prune --omit=dev` keeps prod optional deps).
  If an image were ever built with `--omit=optional`, the SDK throws "Unable to locate
  Codex CLI binaries".
- The Codex SDK **replaces** the child env; `codexSpawnEnv` strips any var matching the
  credential-ish regex — worth remembering when adding new env plumbing (e.g. a
  `*_TOKEN` var intended for the CLI would be silently dropped unless explicitly
  re-added like `CODEX_ACCESS_TOKEN` is).
- CODEX_ACCESS_TOKEN **is** supported by the pinned CLI (strings present in the 0.144.1
  binary), so the README-recommended compose auth path is viable once actually set.

---

## 13. Suspicious / mock / dead-code observations

Things that look unwired, stubbed, seeded-fake, or asymmetric (no TODO/FIXME markers
exist anywhere in `app/` — the codebase annotates gaps in prose instead):

1. **Migration-seeded mock violation** — `db/migrations/0005_github.sql` INSERTs an open
   `scope_violations` row (`sv_seed_vib142_pr_write`, project `viberr-core`, task
   VIB-142) into EVERY database, including production ones that never seeded the demo
   dataset. A fresh non-demo install starts with a phantom policy violation badge until
   someone resolves it.
2. **Simulated runtime everywhere by default** — with no backend credential every "run"
   is the scripted demo engine (`simulated-runtime.server.ts`,
   `buildAnalyzeScript`/`simulatedFinalReport` in specialist-run.server.ts). It honestly
   marks `simulated=1`, but the canned "@operator — done: implemented what you asked
   for…" reports (specialist-run.server.ts:1083) will advance a real board's stages via
   the operator react loop even though no code was written. `/resources/health` is the
   only place that makes real-vs-sim obvious.
3. **Codex capability enforcement is advisory** — the specialist tool denylist binds on
   Claude only (`CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`); a Codex specialist with a
   withheld `commit-push-branch` can still push (danger-full-access + own gh auth).
   Acknowledged in code, but it means the capability matrix's teeth depend on backend.
4. **Workspace isolation is Git-discovery-only** — `GIT_CEILING_DIRECTORIES` + prompt
   contract; an autonomous agent can still read/write anywhere the node user can
   (explicit comment specialist-run.server.ts:1222–1226; README.md:108 repeats it).
5. **Codex failure opacity** — deliberate stderr redaction (§12) means the ONLY
   diagnosis surface for codex-run failures is the generic message; there is no
   "verbose codex errors" escape hatch, even gated.
6. **`runtimes/codex-home` missing from `DATA_ROOT_SUBDIRS`** while
   `runtimes/claude-home` is present — asymmetric, and the compose CODEX_HOME points at
   the never-created dir.
7. **Hand-maintained codex model list** (`model-catalog.server.ts` curated ids;
   explicitly "a best-effort snapshot") — will silently go stale; claude side is
   live-enhanced, codex is not.
8. **In-process-only completion callbacks & leases** — run completion callbacks,
   operator leases, and the SSE ring buffer all live in process-global maps; the boot
   reconciler covers dropped agent replies, but a restart mid-codex-plan-execution
   (run row already `finished`, plan half-executed) has no recovery analog.
9. **`agent_runs.kind` migration vocabulary** — 0011 rebuilt the CHECK to
   `('operator','primary','reviewer')`; UI copy and thread-id conventions (`c0` legacy
   comments in 0006) still mention consultant in a few historical comments only.
10. **better-auth org tables largely dormant** — `organization/member/invitation`
    exist (migration 0013) and membership is provisioned, but app RBAC reads only the
    legacy `users` + `project_members` stores; the org-plugin data has no consumer
    surface yet.
11. **Seeded "running" runs drip fake liveness** — `seed-resumer.server.ts` replays
    seeded live lines on first subscribe so demo runs look live after restarts;
    process-scoped and demo-only, but it is fabricated stream activity by design.
12. **e2e forcing flag** — `VIBERR_FORCE_SIMULATED_RUNTIME` (runtime-registry) exists
    solely so Playwright's golden paths run scripted; if it leaked into a real env every
    backend silently degrades to simulated.
13. **Dev-only Claude toolset leak** — documented in `claude-runtime.server.ts:210`:
    running the server from inside an active Claude Code/Desktop session leaks the
    parent session's managed toolset into agent runs (cannot be closed from SDK options).

Historical gaps from the 2026-07-09 "operator runtime gaps" report that are now CLOSED
in code (verified): the operator generates real decision packets
(`open_decision_packet` tool / `operatorOpenPacket`), GitHub PR delivery is wired
(`openTaskPr` from `transitionStage`; `ensureTaskBranch` from operator transitions;
workspace reconciliation), notifications fan out (`notifyTaskWatchers` + SSE), and
three of the anti-noise guardrails are enforced (`comment-guardrails.server.ts`).
