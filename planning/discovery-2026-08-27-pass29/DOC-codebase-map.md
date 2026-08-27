# Viberr codebase map (pass 29 discovery)

Generated 2026-08-27 by reading real code (not guessed). Paths are relative to
repo root. Line numbers are as of this pass's checkout (`fix/pass28-findings`)
and will drift — use them as a starting point, not gospel.

Stack: React Router 7 (framework mode, SSR-only, `ssr: true` in
`react-router.config.ts`), Node 26, `node:sqlite` (no ORM), event-sourced
markdown files as the canonical store, chokidar file watcher projecting into
SQLite, Claude Agent SDK + Codex SDK for agent execution, better-auth for auth.

---

## 1. High-level architecture

### 1.1 Request flow

```
browser
  → React Router route module (app/routes/*.tsx)
      loader() / action()
      → app/server/auth/*  (requireAuth / requireProjectMember / requireProjectMutable)
      → app/server/**/*.server.ts  (service layer — the ONLY place that touches
                                     SQLite or the filesystem)
           ├─ reads: app/server/projections/*.server.ts (SQLite SELECTs)
           └─ writes: app/server/files/*-writer.server.ts (markdown mutation)
                → rebuildPath()/rebuildTaskFile() (app/server/projections/rebuilder.server.ts)
                    re-derives SQLite rows from the just-written .md file(s)
                    IN THE SAME REQUEST (synchronous), then emits a
                    ProjectionEvent
      ← loader/action returns data/redirect
  ← route component renders (app/features/<area>/*-page.tsx does most of the
    actual UI; the route module in app/routes/ is thin — loader/action plus a
    default export that renders the feature page)
```

Almost every `app/routes/*.tsx` file is a thin shim: it composes
guards + a feature-layer query/action function and renders a component that
lives in `app/features/<area>/`. Business logic and most tests live in
`app/features/*` and `app/server/*`, not in `app/routes/*`.

### 1.2 Canonical store vs. SQLite projection

- **Canonical truth** = markdown files under `<dataRoot>/projects/<slug>/project.md`
  and `<dataRoot>/projects/<slug>/tasks/<key>/task.md`, each with YAML
  frontmatter (schemas: `app/schemas/project-file.schema.ts`,
  `app/schemas/task-file.schema.ts`) plus an append-only timeline of typed
  events in the body. Frontmatter + timeline events are the event-sourced
  history; nothing is ever deleted, only appended (task-file.schema.ts docs
  the full event-type union and the "typed important events" model).
- **SQLite** (`<dataRoot>/state/projection.sqlite`, opened by
  `app/server/db/sqlite.server.ts`) is a **derived, disposable** read cache:
  `projects`, `project_members`, `task_projections`, `task_events`,
  `diagnostics` tables are fully rebuildable from the .md tree
  (`app/server/projections/rebuild.server.ts` / `rebuilder.server.ts`). Other
  tables are NOT file-derived and are real state of their own: `users`,
  `sessions`, `agent_runs`/`run_log_lines`, `audit_events`, `notifications`,
  sealed PATs/secrets, org resources — deleting `projection.sqlite` loses
  those too (see the boot-integrity remedy text in
  `app/server/boot.server.ts:298-309`).
- **Every mutation path** (task actions, operator actions, GitHub delivery,
  the file watcher for out-of-band edits) ends by calling `rebuildPath` /
  `rebuildTaskFile` (`app/server/projections/rebuilder.server.ts`), which
  re-parses the changed .md file(s), upserts the projection rows in one
  transaction, and emits a `ProjectionEvent` (`task.updated`,
  `project.updated`, etc. — full union in
  `app/server/events/projection-events.server.ts:11-42`).
- **Full rebuild** (`app/server/projections/rebuild.server.ts`) drops every
  file-derived table and reprojects the whole tree — the "corrupted DB"
  recovery hammer, wired to Board/Home "Re-scan" buttons
  (`app/server/projections/rescan.server.ts` is the lighter, hash-diffed
  everyday version run at boot and from the same buttons).

### 1.3 File watcher

`app/server/files/file-watch.service.server.ts` wraps chokidar, watching
`<dataRoot>/projects/**`. 250ms trailing debounce per path; ignores dotfiles
and `*.tmp` (atomic-write staging files, see
`app/server/files/atomic-file.server.ts`). `ignoreInitial: true` — it assumes
the boot rescan (`rescanProjections`, called from `bootServer` in
`app/server/boot.server.ts:576-585`) already reconciled any offline drift, so
the watcher only reacts to changes made *after* boot (an external edit — e.g.
someone hand-editing task.md, or a git operation that touches the file
outside the app). On add/change it calls `rebuildTaskFile`/`rebuildPath`; on
unlink it reconciles the projection rows for the removed file. A sibling
watcher, `app/server/files/kb-watch.service.server.ts`, does the same for
knowledge-base store files (re-indexes on change).

Both watchers are started from `bootServer()` (`app/server/boot.server.ts:603,607`),
which also: takes a single-writer lock over the data root
(`app/server/db/data-root-lock.server.ts` — one process per data root, ever),
self-heals a corrupt projection.sqlite, seeds the initial admin, starts the
SSE publisher, seeds default agent profiles, recovers runs orphaned by a
restart, and starts the GitHub reconcile poller + schedule runner.

### 1.4 Live updates (SSE)

`app/server/events/event-publisher.server.ts` subscribes to the projection
emitter and republishes each `ProjectionEvent` as a compact SSE event via
`app/server/events/sse-broker.server.ts`. The route `resources/events`
(`app/routes/resources.events.ts`) is the SSE endpoint the client's
`app/features/live-updates/use-live-updates.ts` hook consumes to trigger
React Router revalidation — no fat payloads over the wire, just "this
task/project changed, go refetch." Run log lines are a **separate**,
higher-frequency channel (`run.log-appended` events go straight to the broker,
bypassing the projection emitter) consumed by
`app/features/runtime/use-run-log-stream.ts` against
`app/routes/resources.run-log.ts`.

### 1.5 Agent execution

Two backends, one adapter interface (`app/server/runtimes/adapter.server.ts`):
Claude (`claude-runtime.server.ts`, via the Claude Agent SDK) and Codex
(`codex-runtime.server.ts`). `runtime-registry.server.ts` picks the adapter
and detects credential availability (env-var presence, never a paid API call).
`app/server/runtimes/run-service.server.ts` (1647 lines) is the shared
run-lifecycle service: admits/reserves a run against the concurrency cap
(`getMaxConcurrentRuns`, `app/server/settings/instance-settings.server.ts`),
persists `agent_runs`/`run_log_lines` rows (`run-store.server.ts`), and
publishes state changes (`run-events.server.ts`).

Two run "shapes" sit above `run-service`:
- **Specialist runs** — `app/server/tasks/specialist-run.server.ts` (3294
  lines): builds the prompt/context for a Developer/Reviewer/etc. agent
  profile, mounts its tool policy (`specialist-tool-policy.ts`), MCP servers
  (`specialist-mcp.server.ts`, `specialist-browser-mcp.server.ts`), KB
  injections (`app/server/files/kb-injection.server.ts`), clones the repo
  workspace (`repo-mirror.server.ts`), and on completion runs the outcome
  pipeline (`agent-outcome.server.ts`, `agent-reply.server.ts`).
- **Operator runs** — `app/server/runtimes/operator-run.server.ts` (3382
  lines) is the operator's own execution wrapper (it is itself a Claude/Codex
  run, with `viberr`-namespaced in-process tools); the actual coordination
  *decisions* it can make live in `app/server/tasks/operator-actions.server.ts`
  (2985 lines — `operatorAssignSpecialist`, `operatorRunSpecialist`,
  `operatorTransitionStage`, `operatorDeliverForReview`,
  `operatorAcceptCompletion`, etc., each gated by `resolveOperatorAuthority`
  + `gate()`/`deliverGate()`).

Both agent- and operator-facing in-process tools are defined in
`app/server/tasks/agent-toolkit.server.ts` (511 lines, the `report_outcome` /
`post_comment` / `ask_human` / evidence tools available to specialists) and
`app/server/tasks/operator-toolkit.server.ts` (727 lines, the operator's own
tool surface: engage agent, open packet, deliver, transition stage...).

### 1.6 GitHub delivery

`app/server/github/` is the PR-delivery subsystem: `push-workspace.server.ts`
pushes the task's branch, `pr-open.server.ts` opens the review PR (via the
project's sealed PAT, `secrets/pat-store.server.ts`), `pr-human-approval.server.ts`
gates acceptance on a real GitHub review verdict,
`workspace-delivery.server.ts` reconciles a specialist that pushed/opened a PR
*itself* (Codex with its own git/gh creds) back into the canonical task
record, `branch-sync.server.ts`/`update-branch.server.ts` handle rebase/update,
`reconcile-poller.server.ts` polls PR status every 5 minutes
(`bootServer` wires it), and `github-reconciler.server.ts` +
`branch-cleanup.server.ts` handle merged/closed/deleted-branch convergence.

---

## 2. Route inventory

All routes are declared in `app/routes.ts` (73 lines). Table below groups by
area; "file" is under `app/routes/` unless noted.

### Auth

| Path | File | Purpose |
|---|---|---|
| `/login` | `login.tsx` | Sign-in form (email/password + configured OAuth); loader l.46, action l.67 |
| `/logout` | `logout.tsx` | POST revokes the better-auth session + cookie (action l.11) |
| `/api/auth/*` | `api.auth.$.ts` | Splat forwarding every sub-path to better-auth's own router (sign-in/out, social callbacks, `.well-known`, `getSession`) — no CSRF here, better-auth does its own Origin check |

### Org / projects (home)

| Path | File | Purpose |
|---|---|---|
| `/` | `_index.tsx` | Home: project grid + create-project action (loader l.43, action l.78) |
| `/projects` | `projects.tsx` | Redirects to `/` (bare path has no listing of its own) |
| `/org/settings` | `org.settings.tsx` | Tabbed org-admin surface: org profile, members, resources, SSO (loader l.103, action l.189 — 686-line file) |
| `/org/settings/audit-export` | `org.settings.audit-export.ts` | CSV/JSON audit-log download, org-admin gated |
| `/insights` | `insights.tsx` | Instance-wide agent-run cost/token analytics, org-admin only, read-only |

### Board / task workspace (mounted under `/projects/:slug`, layout = `project.tsx`)

| Path | File | Purpose |
|---|---|---|
| `/projects/:slug` (index) | `project._index.tsx` | Redirects to `board` |
| `/projects/:slug/board` | `project.board.tsx` | Kanban board; action l.45 (drag/reorder/quick actions) |
| `/projects/:slug/review` | `project.review.tsx` | Review queue (tasks awaiting a human verdict) |
| `/projects/:slug/agents` | `project.agents.tsx` | Agent profile roster: create/edit/deploy (loader l.40, action l.135) |
| `/projects/:slug/policy` | `project.policy.tsx` | Governance: member roles, workflow boundaries (loader l.28, action l.44) |
| `/projects/:slug/github` | `project.github.tsx` | GitHub connection/credential card + delivery status (loader l.44, action l.105) |
| `/projects/:slug/activity` | `project.activity.tsx` | Project-wide activity feed |
| `/projects/:slug/settings` | `project.settings.tsx` | Project settings: name, members, **stages/workflow editor**, archive (loader l.50, action l.82, 236-line component) |
| `/projects/:slug/tasks/:key` | `project.task.tsx` | Task detail: the single biggest route (1159 lines; loader l.117, action l.411 covers comment/transition/accept/deliver/etc.) |

The `project.tsx` layout loader (l.70) is the READ chokepoint (membership
404-gate for the whole subtree); `project-visibility.server.ts`
(`requireVisibleProject`, l.28) is the matching gate for **actions**, needed
because React Router runs a child action without re-running the parent loader
(the single-fetch `?_routes=` hole documented at
`app/server/auth/require-project.server.ts:16-27`).

### KB (knowledge base)

No dedicated route — the KB browser (`app/features/kb-browser/`) is embedded
inside `project.settings.tsx` / org settings resource panels rather than
routed separately; store files are read via `app/server/org/store-files.server.ts`
and indexed by `kb-watch.service.server.ts`.

### MCP / resources / connections

Org-level MCP server registry lives under `/org/settings` (Connections tab —
`app/features/org-settings/connections-panel.tsx`), backed by
`app/server/org/resources.server.ts` + `mcp-warmup.server.ts` (background
install/health probing). No standalone `/mcp` route.

### Settings / profile / notifications (top-level, outside the workspace shell)

| Path | File | Purpose |
|---|---|---|
| `/profile` | `profile.tsx` | Personal profile + notification prefs (loader l.59, action l.67) |
| `/notifications` | `notifications.tsx` | Full notification list page |
| `/notifications/read` | `notifications.read.tsx` | POST mark-read (single or all), idempotent |
| `/prefs/theme` | `prefs.theme.tsx` | POST theme cycle; persists to `users.theme` + sets cookie |

All four of the above (plus `/org/settings*` and `/insights`) are mounted
under the pathless `palette-shell.tsx` layout (`routes.ts:21-30`) so the ⌘K
palette mounts outside the workspace shell too (F20-30).

### Resources / API (fetcher targets, no UI of their own)

| Path | File | Purpose |
|---|---|---|
| `/resources/events` | `resources.events.ts` | SSE stream driving live revalidation (loader l.63) |
| `/resources/run-log` | `resources.run-log.ts` | Paged run-log tail, `?since=<seq>` |
| `/resources/health` | `resources.health.ts` | Unauthenticated ops probe: `{ ok, projections, watcher }` |
| `/resources/search` | `resources.search.ts` | ⌘K palette query across the viewer's visible projects |
| `/resources/model-catalog` | `resources.model-catalog.ts` | Model+effort picker data per backend (Claude live-enhanced, Codex curated) |
| `/resources/session-export` | `resources.session-export.ts` | Downloads a bash installer carrying a run's provider transcript for local resume |
| `/projects/:slug/tasks/:key/attachments/:file` | `task-attachment.ts` | One task attachment (agent browser screenshot/PDF), member-gated raw bytes |

---

## 3. `app/features/` inventory

Each dir pairs a `*-page.tsx` (component), a `*-query.server.ts` (loader data
shaping) and/or `*-actions.server.ts` (action handling), plus focused unit
tests. This is where almost all UI logic and business rules for a surface
actually live (routes/ just wires them to React Router).

| Dir | Purpose | Key files |
|---|---|---|
| `activity/` | Project activity feed rendering + time-window grouping | `activity-page.tsx`, `feed-helpers.ts`, `feed-limits.ts` |
| `agents/` | Agent profile roster page, create/edit modal, capability matrix modal | `agents-page.tsx`, `agent-profile-actions.server.ts`, `capability-catalog.ts` (editor-facing projection of `shared/capabilities.ts`), `capability-matrix-modal.tsx`, `create-profile-modal.tsx` |
| `board/` | Kanban board rendering, drag-and-drop (dnd-kit), filters | `board-page.tsx`, `board-dnd.ts`, `board-filters.ts` |
| `github/` | GitHub connection card, credential visibility, delivery copy/pills | `github-view.tsx`, `credential-card.tsx`, `credential-visibility.server.ts`, `github-actions.server.ts`, `github-pills.ts` |
| `home/` | Project grid, new-project modal, project-name validation | `home-page.tsx`, `home-query.server.ts`, `project-create.server.ts`, `new-project-modal.tsx` |
| `insights/` | Instance-wide run analytics page | `insights-page.tsx` |
| `kb-browser/` | Knowledge-base file tree browser (used from settings/org panels) | `store-browser.tsx`, `tree.ts`, `local-files.ts` |
| `live-updates/` | SSE client hook + event-type union consumed by routes | `use-live-updates.ts`, `event-types.ts` |
| `notifications/` | Bell popover item rendering, notification list page | `notification-item.tsx`, `notifications-page.tsx`, `notification-meta.ts` |
| `org-settings/` | Org settings page tabs: members, resources (MCP/KB), SSO, connections | `org-settings-page.tsx`, `resources-panel.tsx`, `resource-modals.tsx`, `sso-panel.tsx`, `connections-panel.tsx`, `agent-template-modal.tsx` |
| `policy/` | Governance page: member roles table, workflow boundary editor | `policy-page.tsx`, `policy-actions.server.ts` (`setMemberRole` l.98, `setTransitionBoundary` l.186), `policy-query.server.ts` |
| `profile/` | Personal profile page + notification prefs | `profile-page.tsx`, `profile-actions.server.ts`, `notification-prefs.ts` |
| `project-settings/` | Project settings page: rename, members, **stage/workflow editor** (uses `shared/workflow/transitions.ts`), archive | `settings-page.tsx`, `settings-actions.server.ts` (`spliceStageIntoChain` call l.524, `rejoinChainAroundStage` call l.623), `membership.server.ts` |
| `review/` | Review queue page + acceptance-authority checks | `review-page.tsx`, `review-acceptance-authority.server.ts`, `review-helpers.ts` |
| `runtime/` | Run panels (log viewer, elapsed timer), log-stream hook, log-noise filtering | `runs-panels.tsx`, `use-run-log-stream.ts`, `log-clock.ts`, `log-noise.ts`, `runtime-types.ts` |
| `shell/` | App chrome: rail nav, topbar, ⌘K command palette, user menu, theme toggle | `rail.tsx`, `topbar.tsx`, `command-palette.tsx`, `command-search.server.ts`, `nav.ts`, `use-command-palette.ts` |
| `task-detail/` (largest, 35 files) | Everything on the task page: timeline rendering, comment composer + @mentions (Lexical), decision packets, accept/release/archive confirms, attachments, execution-profile (engagements) display, operator recommendations | `task-detail-page.tsx`, `task-main-sections.tsx`, `timeline.tsx`, `timeline-slice.ts`, `comment-composer.tsx`, `lexical-mention-plugin.tsx`, `mention-autocomplete.ts`, `decision-packet.tsx`, `execution-profile.tsx`, `accept-confirm.tsx`, `continuity-recovery.tsx` |

---

## 4. `app/server/` inventory

Organized by subdirectory (135+ files total). Highlighted modules per the
task brief are called out explicitly.

| Subdir | Purpose | Notable files |
|---|---|---|
| `actions/` | Cross-cutting action-side watchdogs | `action-watchdog.server.ts` |
| `agents/` | Read-side view of agent deployments | `deployment-view.server.ts` |
| `audit/` | Append-only audit log: record, browse, query, CSV/JSON export, S3 export | `audit-recorder.server.ts` (`recordAudit`, used everywhere), `audit-export.server.ts`, `s3-put.server.ts`, `s3-config.server.ts` |
| `auth/` | **Auth & authorization** | `identity.server.ts`, `login.server.ts`, `oauth-providers.server.ts`/`oauth-provision.server.ts` (social sign-in + account linking — site of F28-A1), `password.server.ts`, `csrf.server.ts`, `rate-limit.server.ts`, `require-user.server.ts` (session gate), `require-project.server.ts` (membership gate for routes outside the layout, see §1.2/§2), `**project-authority.server.ts**` (THE single RBAC resolution path — `resolveProjectAuthority`, org-admin D2 override, denial auditing), `user-admin.server.ts`, `user-store.server.ts` |
| `boot.server.ts` | **Startup orchestration** | `bootServer()` — see §1.3; lock, migrations, seed, watchers, recovery, schedulers, boot-integrity log |
| `config/` | Env var parsing/validation | `env.server.ts` (`getEnv`, `Env` type, single source for all env access) |
| `db/` | **SQLite + migrations + data-root lock** | `sqlite.server.ts` (`getDb`, connection singleton), `migration-runner.server.ts`, `data-root-lock.server.ts` (single-writer-per-process lock), `self-heal.server.ts` (corrupt-DB recovery at boot), `backup.server.ts`, `retention.server.ts`, `transaction.server.ts` (`withTransaction`) |
| `errors/` | App-wide error shape | `app-error.server.ts` (`AppError`), `error-codes.ts` (`ERROR_CODES`) |
| `events/` | **Projection event bus + SSE** | `projection-events.server.ts` (in-process `EventEmitter`, the `ProjectionEvent` union), `event-publisher.server.ts` (bridges to SSE), `sse-broker.server.ts` (per-connection fan-out, scoping) |
| `files/` | **Markdown file I/O — the canonical store** | `file-store-root.server.ts` (path helpers: `projectFilePath`, `taskFilePath`, `taskDir`, `agentProfilesDir`...), `atomic-file.server.ts` (tmp-file+rename writes), `file-mutex.server.ts` (per-file write lock), `**file-watch.service.server.ts**` (chokidar watcher, §1.3), `kb-watch.service.server.ts`, `project-writer.server.ts`/`project-file.server.ts`, `task-writer.server.ts`/`task-file.server.ts` (frontmatter patch + timeline append), `frontmatter.server.ts` (YAML split/join), `agent-profile-file.server.ts`, `kb-injection.server.ts` (KB body injection into agent prompts), `task-attachments.server.ts` |
| `github/` | **PR delivery pipeline** (see §1.6) | `github-client.server.ts`, `github-context.server.ts`, `pr-open.server.ts`, `push-workspace.server.ts`, `workspace-delivery.server.ts`, `pr-human-approval.server.ts`, `branch-sync.server.ts`, `update-branch.server.ts`/`update-branch-operator.server.ts`, `reconcile-poller.server.ts`, `github-reconciler.server.ts`, `branch-cleanup.server.ts`, `pr-adoption.server.ts`, `repo-access-check.server.ts`, `scope-flag.server.ts` (policy-violation flagging) |
| `insights/` | Instance analytics query | `insights-query.server.ts` |
| `interpretation/` | Diagnostics/readiness/freshness derivation for a task | `diagnostics-policy.server.ts`, `readiness-policy.server.ts`, `freshness-policy.server.ts` |
| `logging/` | Structured logger | `logger.server.ts`, `request-context.server.ts` |
| `ops/` | Build metadata, disk space, maintenance/retention scheduling | `build-info.server.ts`, `disk-space.server.ts`, `maintenance.server.ts` (`runMaintenancePass`, `startMaintenanceScheduler`), `transcript-retention.server.ts` |
| `org/` | Org-level resources: MCP/KB registry, connections, org users, seed | `resources.server.ts` (MCP server registry: `listMcpServers`, `discoverStdioMcpTools`), `mcp-warmup.server.ts` (background MCP install/health), `connections.server.ts`, `org-users.server.ts`, `org-seed.server.ts`, `store-files.server.ts` |
| `prefs/` | Per-user preferences | `user-prefs.server.ts` |
| `projections/` | **SQLite projection layer (read side)** | `rebuilder.server.ts` (`rebuildPath`, `rebuildTaskFile`, `rebuildAll` — the re-derivation engine), `rebuild.server.ts` (full-rebuild wrapper, transactional), `rescan.server.ts` (hash-diffed everyday reconcile), `board-query.server.ts`, `task-query.server.ts`, `task-activity.server.ts`, `activity-feed.server.ts`, `review-queue.server.ts`, `decisions.server.ts`, `agent-deployments.server.ts`, `policy-violations.server.ts`, `single-flight.server.ts` (dedupes concurrent rescans) |
| `provenance/` | Records which actor/run produced which change | `provenance-recorder.server.ts`, `provenance-query.server.ts` |
| `runtimes/` | **Agent execution: adapters, run lifecycle, operator** | `adapter.server.ts` (the `RuntimeAdapter` interface + `RunSpec`/`RunHandle`), `claude-runtime.server.ts`, `codex-runtime.server.ts`, `**runtime-registry.server.ts**` (backend selection/availability), `**run-service.server.ts**` (1647 lines — admission/concurrency cap, persistence, publish), `run-store.server.ts` (raw SQL for `agent_runs`/`run_log_lines`), `run-projection.server.ts`, `run-events.server.ts`, `run-recovery.server.ts` (boot-time orphan/reply recovery), `**operator-run.server.ts**` (3382 lines — the operator's own run wrapper: clone, KB/skill injection, tool wiring), `model-catalog.server.ts`/`model-availability.server.ts`, `skill-mount.server.ts`, `session-export.server.ts`, `wire-format.server.ts` |
| `secrets/` | Credential sealing | `secret-box.server.ts` (encrypt/decrypt), `pat-store.server.ts` (`getPatToken`, `getProjectCredential`, `markWriteScopeProven`), `pat-validator.server.ts`, `key-rotation.server.ts`, `git-output-redact.server.ts` |
| `seed/` | First-boot content | `seed-admin.server.ts`, `default-assets.server.ts`, `ensure-base-agents.server.ts`, `agent-catalog.server.ts` (seeded profile definitions + capability grants) |
| `settings/` | Instance-wide settings | `instance-settings.server.ts` (`getMaxConcurrentRuns` — the run-concurrency cap) |
| `tasks/` | **Task mutation + agent/operator toolkits** (largest subdir) | `**task-actions.server.ts**` (8202 lines — every governed task mutation: comment, transition, accept, deliver, archive, own/release, RBAC-gated via `requireAction`/`roleCan`), `**operator-actions.server.ts**` (2985 lines — operator decision functions, `resolveOperatorAuthority`, `gate`/`deliverGate`), `task-mutation.server.ts`, `agent-toolkit.server.ts` (511 lines — specialist in-process tools), `operator-toolkit.server.ts` (727 lines — operator in-process tools), `agent-outcome.server.ts`/`agent-reply.server.ts` (post-run pipeline), `specialist-run.server.ts` (3294 lines — specialist run orchestration), `specialist-mcp.server.ts`/`specialist-browser-mcp.server.ts` (MCP mounting incl. R19-19 browser cap), `specialist-tool-policy.ts` (tool denylist resolution from capability grants), `comment-guardrails.server.ts`, `mention-notify.server.ts`/`mention-suggestions.server.ts`, `git-clone-auth.server.ts`/`repo-mirror.server.ts`/`git-clone-progress.server.ts`, `no-change-completion.server.ts`, `schedule.server.ts` (scheduled operator re-runs), `workspace-retention.server.ts` |
| `theme/` | Theme cookie | `theme-cookie.server.ts` |

---

## 5. Key shared modules

- **`app/shared/rbac.ts`** (117 lines) — THE single source of project-role
  authorization. `RBAC_DEFINITIONS` (l.61-93) maps each `RbacAction` id to its
  allowed roles (`admin`/`maintainer`/`contributor`/`viewer`); `roleCan()`
  (l.104) and `rolesForAction()` (l.110) are the two read APIs every server
  guard and the Policy page's permission table both consume. `ROLE_RANK`
  (l.31) and `ROLE_LABEL` (l.38) are the ordering/display companions.
- **`app/shared/capabilities.ts`** (619 lines) — THE agent/operator
  capability catalog. `UNIFIED_CAP_CATALOG` (l.33-154) is the full list (each
  entry: id, label, applicable kinds `operator`/`agent`, editor group,
  default mode, promotability). `ENFORCED_CAPABILITY_IDS` (l.223-258) vs.
  `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` (l.270-283) vs. advisory-only —
  `capabilityEnforcement(id)` (l.288) tells you which. `ALWAYS_HUMAN_CAPABILITY_IDS`
  (l.211-215): merge PR / transition to Done / change policy, never
  agent-executable. `GRANT_REQUIRED_CAPABILITY_IDS` (l.393-400): capabilities
  that default to **withheld** absent an explicit grant (repo-write family,
  merge, verdict). Grant-coupling repair functions:
  `repairDeliveryGrants`/`repairBrowserEgressGrants`/`applyGrantCouplings`
  (l.449-571) keep dependent grants consistent on save.
- **`app/features/agents/capability-catalog.ts`** (181 lines) — editor-facing
  projection of the unified catalog above, split into per-kind (`operator`
  vs `agent`) accordion groups for the create/edit-profile modal and the
  capability-matrix modal.
- **`app/schemas/project-file.schema.ts`** (455 lines) — canonical
  `project.md` frontmatter shape: `PROJECT_ROLES` (l.20), `BOUNDARY_VALUES`
  (l.25, workflow transition strictness `auto|approval|human`),
  `CAPABILITY_MODES` (l.31, `direct|recommend|human|off`), `stageSchema`
  (l.37), `workflowBoundarySchema` (l.47).
- **`app/schemas/task-file.schema.ts`** (1544 lines) — canonical `task.md`
  frontmatter + the full typed timeline-event union (the event-sourcing
  spine). Home of `deriveValidation`, `EVIDENCE_EMPTY_COLUMN`,
  `deliveringEngagement`, `PacketOption`/`TaskPacket`, guardrail-reason
  helpers (`acceptanceBlockedReason`, `archivedTaskBlockedReason`, etc.).
- **`app/shared/workflow/`** — stage/transition graph maintenance:
  `transitions.ts` (chain maintenance: `spliceStageIntoChain`,
  `rejoinChainAroundStage`, `realignChainToStages`, `strictestBoundary`),
  `stage-eligibility.ts` (three-tier agent-to-stage matching: literal id →
  structural role → unrestricted fallback), `stage-roles.ts`, `templates.ts`
  (the one seeded "Standard · 5 stages" workflow template).
- **`app/server/auth/project-authority.server.ts`** — `resolveProjectAuthority`
  is the single choke point every mutation guard calls: membership role →
  `ACTION_ROLES` lookup, org-admin D2 emergency override (audited), and
  denial auditing (`project.authority.denied` rows).
- **`app/server/audit/audit-recorder.server.ts`** — `recordAudit()`, called
  from nearly every mutation path; `SYSTEM_ACTOR`/`OPERATOR_AUDIT_ACTOR`
  constants for non-human actors.

---

## 6. Tests

- **Unit/integration**: `vitest` (`vitest.config.ts`). `environment: "node"`,
  setup files `test-support/setup-env.ts` (seeds required env secrets so the
  suite is hermetic — no `.env` needed) and `test-support/setup-dom.ts`
  (jsdom `<dialog>` shim). Test glob: `app/**/*.test.{ts,tsx}` — tests live
  **beside** the code they cover (e.g. `task-actions.server.test.ts` next to
  `task-actions.server.ts`), not in a separate `__tests__` tree. Run: `npm test`
  (= `vitest run`).
- **E2E**: Playwright, config `playwright.config.ts`, specs in `e2e/*.spec.ts`
  (`01-home-board`, `02-feeds-profile`, `03-org-settings-store`,
  `04-palette-mobile`, `05-task-comment-composer`, `06-activity-hydration`,
  `07-accessibility`, plus `auth.setup.ts`). Run via `npm run e2e` →
  `scripts/e2e.ts` (drives `compose.e2e.yml`, a dedicated container profile).
- **Lint**: `oxlint` (`.oxlintrc.json`), `npm run lint`.
- **Typecheck**: `npm run typecheck` = `react-router typegen && tsc` (route
  types must be regenerated before `tsc`, since `Route.LoaderArgs` etc. come
  from `.react-router/types`).
- **app.css gate**: `app/app.css.test.ts` (115KB test file) is a no-allowlist
  integrity + contrast gate over the single stylesheet `app/app.css` —
  every className used in the app must be defined there.
- Other scripts (`scripts/`): `seed.ts`/`seed-demo.ts` (data seeding),
  `rescan.ts` (CLI trigger for the projection rescan), `backup.ts`/`restore.ts`,
  `store-check.ts`, `secret-keys.ts` (key generation/rotation helper),
  `measure-routes.mjs`.

---

## 7. "Where do I go to change X?"

| I want to... | Start here |
|---|---|
| Add/rename/reorder a **board stage** | `app/features/project-settings/settings-actions.server.ts` (calls `spliceStageIntoChain`/`rejoinChainAroundStage` from `app/shared/workflow/transitions.ts`); UI in `app/features/project-settings/settings-page.tsx` |
| Change a **workflow transition boundary** (auto/approval/human) | `app/features/policy/policy-actions.server.ts:186` `setTransitionBoundary`; UI in `app/features/policy/policy-page.tsx` |
| Change **who can do what** (project RBAC) | `app/shared/rbac.ts` (`RBAC_DEFINITIONS`) — single source, consumed everywhere via `roleCan`/`rolesForAction` |
| Add a new **agent/operator capability** | `app/shared/capabilities.ts` (`UNIFIED_CAP_CATALOG`) — then decide its `ENFORCED_CAPABILITY_IDS` / `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` bucket, and wire actual enforcement in `app/server/tasks/specialist-tool-policy.ts` (agent tool denylist) or the relevant operator gate (`app/server/tasks/operator-actions.server.ts` `gate()`/`deliverGate()`) |
| Change **operator agent selection / assignment logic** | `app/server/tasks/operator-actions.server.ts` (`operatorAssignSpecialist` l.1902, `operatorAssignReviewer` l.1995, `operatorEngageAgent` l.2351) and `app/server/runtimes/operator-run.server.ts` for the run-wrapper side |
| Modify **PR delivery** (push branch, open PR) | `app/server/github/push-workspace.server.ts`, `pr-open.server.ts`; the operator-side trigger is `operatorDeliverForReview` in `operator-actions.server.ts:2523`, gated by `deliverGate` (`operator-actions.server.ts:478`) and the `deliver-review-pr` capability |
| Change **acceptance / Done gating** | `app/server/tasks/task-actions.server.ts` (`acceptanceBlockedReason` and friends, imported from `task-file.schema.ts`), `app/server/github/pr-human-approval.server.ts` (human GitHub-verdict gate), `operatorAcceptCompletion` (`operator-actions.server.ts:2806`) |
| Add a **task timeline event type** | `app/schemas/task-file.schema.ts` (`TaskFileEvent` union) — then a writer in `app/server/files/task-writer.server.ts` (`appendTimelineEvent`) and a projector case in `app/server/projections/rebuilder.server.ts` |
| Change **what the file watcher does on a change** | `app/server/files/file-watch.service.server.ts` |
| Add a **new SQLite-projected field** | `app/server/db/migration-runner.server.ts` + `db/migrations/0001_baseline.sql` (squashed, forward-only — see `app/server/boot.server.ts` `projectionMissingColumns`), then `app/server/projections/rebuilder.server.ts` |
| Add a **new route/page** | `app/routes.ts` (register it) + a thin file in `app/routes/` + the real component/loader-shaping in a new or existing `app/features/<area>/` dir |
| Change **SSE / live-update behavior** | `app/server/events/projection-events.server.ts` (event union), `event-publisher.server.ts` (translation), `sse-broker.server.ts` (fan-out/scoping); client side `app/features/live-updates/use-live-updates.ts` |
| Change **MCP server mounting for an agent** | `app/server/tasks/specialist-mcp.server.ts` (org MCPs) / `specialist-browser-mcp.server.ts` (R19-19 browser capability); registry itself in `app/server/org/resources.server.ts` |
| Change **KB injection into agent prompts** | `app/server/files/kb-injection.server.ts`; browsing UI in `app/features/kb-browser/` |
| Change **GitHub PAT / credential handling** | `app/server/secrets/pat-store.server.ts`, `pat-validator.server.ts`, `secret-box.server.ts` |
| Change **login / OAuth / account linking** | `app/server/auth/oauth-providers.server.ts`, `oauth-provision.server.ts`, `login.server.ts`; better-auth wiring in `app/lib/auth.server.ts` |
| Change **run concurrency cap** | `app/server/settings/instance-settings.server.ts` (`getMaxConcurrentRuns`), enforced in `app/server/runtimes/run-service.server.ts` |
| Change **audit logging** | `app/server/audit/audit-recorder.server.ts` (`recordAudit`), browse/export in `audit-browse.server.ts`/`audit-export.server.ts`/`s3-put.server.ts` |
| Add a **notification type** | `app/server/projections/notifications.server.ts` (creation), `app/shared/mapping/notification.server.ts` (mapping), UI in `app/features/notifications/` |
| Change the **⌘K command palette** | `app/features/shell/command-palette.tsx` (UI), `command-search.server.ts` + `app/routes/resources.search.ts` (server query) |
| Change **Dockerfile / deploy image** | `Dockerfile` (multi-stage: `prod-deps` → `build` → final slim image with chromium + uv for browser/Python tool support); entrypoint `scripts/docker-entrypoint.sh` |

---

## Appendix: file-size hotspots (largest server-side modules)

For orientation when a task touches "the task/operator engine":

```
8202  app/server/tasks/task-actions.server.ts
3382  app/server/runtimes/operator-run.server.ts
3294  app/server/tasks/specialist-run.server.ts
2985  app/server/tasks/operator-actions.server.ts
1647  app/server/runtimes/run-service.server.ts
1544  app/schemas/task-file.schema.ts
1159  app/routes/project.task.tsx
 727  app/server/tasks/operator-toolkit.server.ts
 619  app/shared/capabilities.ts
 511  app/server/tasks/agent-toolkit.server.ts
 455  app/schemas/project-file.schema.ts
```

These five task/operator/run files are where most cross-cutting product
logic concentrates — per prior passes' lesson (pass 27/28 memory), a new
cross-cutting field or capability must be verified against EVERY consumer in
this cluster, not just its origin point.
