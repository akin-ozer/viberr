# Architecture overview

> The shape of the system as it runs: stack, layers, the two request paths, the boot
> sequence, the background services, and the security posture. For the
> directory-by-directory map see [codebase-map.md](codebase-map.md); for the storage
> model, [data-model.md](data-model.md); for the binding rulings,
> [decisions.md](decisions.md).
>
> Source of truth: `package.json`, `Dockerfile`, `compose.yml`, `app/entry.server.tsx`,
> `app/root.tsx`, `app/server/boot.server.ts`, and the modules named inline.
>
> Verified against `main` @ `7d9fbf72` (2026-09-23).

## 1. One process, one data root

Viberr is a single Node process that serves a server-rendered React Router app, an SSE
stream, and an embedded SQLite database, with all canonical business state as markdown
files under one data root. There is no external database, cache, queue or worker: agent
runs are child processes of the same server, background work runs on in-process timers,
and one exclusive `state/writer.lock` guarantees a single writer per data root. Scaling
is vertical; run one instance per data root.

## 2. Stack

| Concern | Choice |
|---|---|
| Runtime | Node ≥ 26 (`engines`, `.nvmrc`, image `node:26-slim`), ESM, TypeScript 7, `~/*` → `app/*` |
| Framework | React Router 8 framework mode, `ssr: true`, served by `@react-router/serve`; React 19 |
| Build / test | Vite 8, Vitest 4 (`app/**/*.test.{ts,tsx}`, 20 s per-test budget), Playwright 1.62 (chromium only, against the production image), oxlint 1.79 + the vendored `tools/oxlint/anti-slop` plugin (15 rules, CI gate) |
| Data | `node:sqlite` `DatabaseSync`, `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`; one file `state/projection.sqlite`; one squashed migration `db/migrations/0001_baseline.sql` applied at open, plus an idempotent backfill of the nullable columns the baseline gained after an existing root first applied it (`ensureBaselineColumns`) |
| Validation | Zod 4 for env, files, SSE, DB row decoding |
| Files | `yaml` frontmatter, chokidar 5 watchers (250 ms debounce) |
| Auth | better-auth 1.6.25 behind `app/lib/auth.server.ts`; no plugins |
| Agents | `@anthropic-ai/claude-agent-sdk` ^0.3.280, `@openai/codex-sdk` ^0.156.0, `@playwright/mcp` 0.0.79 with Debian chromium; in the image, `uv`/`uvx` 0.12.3 for Python stdio MCP servers and `git`, `make`, `curl` and `pnpm` 12.4.1 for agent shells (ruling 196) |
| UI | one stylesheet `app/app.css` (no Tailwind), Inter / JetBrains Mono from `@fontsource` (ruling 365), lexical (comment composer), dnd-kit (board), Shiki (the attachment code reader, ruling 363), `radix-ui` for unstyled behaviour only (the user menu and `radio-seg`, ruling 166), thinking-orbs + @number-flow/react (the run console's wait row and rolling counts, rulings 366 and 451), react-markdown + remark-gfm |
| Logging | dependency-free JSON lines on stdout with `AsyncLocalStorage` request correlation (`requestId`, method, path, the signed-in `userId`, and `runId`/`taskKey` on a run's own work); every response the app's handlers answer carries the id as `X-Request-Id` (ruling 458(d); the exceptions: [runbook.md §Finding a request by its id](../operations/runbook.md#finding-a-request-by-its-id)); a fatal crash writes one synchronous stderr line first |

## 3. Layers and the rules between them

```
app/routes/      thin: guard (auth, CSRF, intent) → server call → route-shaped data
app/features/    per-surface components + *.server.ts query/action modules
app/ui/          primitives; imports nothing from features/ or server/
app/lib/         the better-auth instance
app/schemas/     zod contracts shared by both halves (task-file, project-file, goal-file, sse-event, github-pat, file-diagnostics)
app/shared/      cross-surface code (rbac, capabilities, workflow, dependencies, run failure, dates, freshness, ids); client-safe except mapping/*.server.ts and ids/new-id.server.ts
app/server/      everything server-only, *.server.ts
```

Rules that hold in the tree (verified by grep, restated from
[decisions.md](decisions.md#layout)):

1. `app/ui/` never imports from `features/` or `server/`.
2. `*.server.ts` never enters the client bundle. Client components may import from a
   `.server` module only as `import type`.
3. Server → features imports are allowed only for `features/*.server.ts` modules (query
   and action modules that live beside their surface), for type-only imports, and for
   four pure client-safe helpers: `features/agents/capability-catalog`,
   `features/kb-browser/tree`, `features/github/github-pills` (`liveMergeable`, ruling
   405) and `features/runtime/runtime-types` (`RUN_INPUTS_TAG`). Server code never
   imports a component.
4. One-definition rules: readiness derivation only in
   `server/interpretation/readiness-policy.server.ts`; freshness thresholds only in
   `shared/freshness.ts`; RBAC grants only in `shared/rbac.ts`; the capability catalog
   only in `shared/capabilities.ts`; provenance writes only in `server/provenance/`;
   the workspace `.claude` catalog only through `runtimes/skill-mount.server.ts`;
   reserved MCP names only in `shared/mcp-reserved.ts`; every context, compaction and
   prompt-cache figure only in `runtimes/context-policy.server.ts` (ruling 370); "this
   task is closed" only in `tasks/task-closure.server.ts` (ruling 177); env parsing
   only in `config/env.server.ts` (a handful of ops knobs read `process.env` directly,
   listed in
   [../operations/configuration.md](../operations/configuration.md#3-raw-processenv-reads-outside-the-schema));
   DB row → camelCase only in `shared/mapping/*`.
5. `logger.server.ts` imports only `request-context.server.ts`;
   `tasks/task-mutation.server.ts` exists to break the `specialist-run → agent-toolkit
   → task-actions` cycle.
6. Runtime adapters (`claude-runtime`, `codex-runtime`) never touch the DB, the canonical
   files or the SSE broker; they emit lines and an exit, and `run-service` + `run-sink`
   persist and publish.

## 4. Request lifecycle

**Process start.** `entry.server.tsx` awaits `bootServer()` at module scope, so boot
finishes before the first request (§5). `root.tsx` mounts three middlewares: request
correlation, the SSE broker's head read before any loader (a document load hands it to
the page's first stream, ruling 457) and the rolling-session renewal, which forwards
better-auth's refreshed cookie on whichever GET resolved the session (F10-17). The
correlation middleware binds one id per request (an inbound `X-Request-Id` is reused) and
answers with it as `X-Request-Id`; `entry.server.tsx` stamps the responses React Router
answers without route middleware (an unmatched URL, a 405, a refused `.data` mutation).
The session guard binds the user's id once the session resolves, and a run started in the
request logs its own work under its `runId` and `taskKey` (ruling 458(d)). The root
loader authenticates, reads the theme cookie and mints the CSRF token; it re-runs only
after a sign-in, a sign-out, a theme or profile change and on a document load (ruling
457). A signed-in page also mounts the controller dock (ruling 121).

**Read path** (`/projects/:slug/board`): layout loader and board loader, together on one
request → `requireUser` → `readWorkspace` (`routes/project-workspace.server.ts`, once per
request): project query → membership check from the project's projected `members` list
(files are truth) with the audited org-admin override → non-member and unknown slug both
404 → the review queue. The layout returns the shell's slice (the project's name, slug,
repo and archived flag, members, the viewer's role), the rail counts and the bell's two
counts; the board loader returns the columns as board cards (`toBoardCard`), annotated
with the viewer's decisions and live runs (ruling 457). Child routes read the layout data
with `useRouteLoaderData`; only the board reads the columns, and the bell loads its own
list (`/resources/notifications`).

**Write path** (`intent=create-task`): route action → `requireFormAction` (session,
`assertCsrf`: the request must *prove* same-origin through Origin / Sec-Fetch-Site /
Referer **and** carry the HMAC double-submit `_csrf` token; returns the intent) →
`requireVisibleProject` (404 parity) → `server/tasks/task-actions.createTask` →
`requireAction` consults `shared/rbac.ts` through `resolveProjectAuthority` (audits
`project.org_admin.override` or `project.authority.denied`) → `allocateTaskKey` (a locked
`project.md` counter bump) → `createTaskFile`: per-file mutex → serialize → atomic write
(tmp + rename; ENOSPC / ESTALE / EIO typed) → `rebuildPath` for `project.md` and the task
(synchronous re-projection with hash short-circuit, derived readiness and validation,
diagnostics, provenance, SSE emit) → notifications → `recordAudit` →
`autoInvokeOperator` → `{ ok, … }`; React Router revalidates. An edit to an existing task
goes through `updateTaskFile` instead: per-file mutex → parse → trust guard (a file with a
hard-stop diagnostic is refused, `file_not_trusted`, 409) → mutate → stamp `updatedAt` →
serialize → atomic write, then the same re-projection, notifications and audit. Project
creation runs inside a 30 s watchdog (`withActionWatchdog`) that fails with a typed 503 on
an async hang.

**Out-of-band edits.** chokidar over `<dataRoot>/projects` (dotfiles, `*.tmp` and
everything below a task dir except `task.md` ignored; goal files included) →
`rebuildPath` → the same SSE event as an in-app write. Details in
[projections-and-events.md](projections-and-events.md).

**Live updates.** Projection events are emitted in-process (buffered inside
transactional rebuilds until commit), translated to the zod-parsed wire shape `{ type,
entityId, occurredAt, data }`, appended to a 256-event replay ring (console lines have
their own) and fanned out to the scope-matching connections on `GET /resources/events`. The client revalidates the
loaders that read what an event changed (300 ms debounce; `revalidation-policy.ts`,
ruling 457), and not those whose data was requested after the event arrived; run logs
are fetched by reference from `/resources/run-log`. A hidden tab holds no stream (ruling
301); a reconnect replays what it missed from the ring buffer. There is no optimistic UI
for governed state.

## 5. Boot sequence (`app/server/boot.server.ts`)

1. Crash-visibility handlers for `uncaughtException` and `unhandledRejection` (one
   synchronous stderr line, then exit 1).
2. Parse env once; warn when OAuth is configured without `BETTER_AUTH_URL` or when a
   production origin is plain `http://`.
3. `ensureDataRootDirs` (`DATA_ROOT_SUBDIRS`: `projects`, `agents`, `agents/profiles`,
   `runtimes`, `runtimes/users`, `kb`, `skills`, `audit-exports`, `state`). There is no
   shared runtime home: each person's `runtimes/users/<userId>/{claude-home,codex-home}`
   is created 0o700 on demand (ruling 127).
4. Take `state/writer.lock` (a held root refuses with the holder named and exits 1;
   `VIBERR_FORCE_DATA_ROOT_LOCK` takes it over), arm the SIGINT/SIGTERM shutdown, and
   start the 20 s lock-ownership guard (fails closed).
5. `seedDefaultAgentAssets`: write the shipped skills, the `agents/definitions/` doctrine
   files and the base profile templates when missing or still identical to a version the
   app shipped (`state/shipped-assets.json` plus `PRIOR_SHIPPED_HASHES`).
6. Self-heal the projection DB if `PRAGMA quick_check` reports corruption (salvage the
   non-rebuildable tables into a fresh file, move the corrupt one aside).
7. Open SQLite, apply migrations, ensure the single-flight indexes, backfill the
   baseline columns an older root lacks (`ensureBaselineColumns`), and widen a
   `notifications.kind` CHECK that predates a kind by rebuilding that table in place, rows
   and indexes kept (`widenNotificationKindCheck`, ruling 481).
8. Bootstrap admin on an empty `users` table (`VIBERR_SEED_ADMIN_EMAIL`, default
   `admin@viberr.dev`; a random one-time password is logged once unless
   `VIBERR_SEED_ADMIN_PASSWORD` is set).
9. Start the loopback MCP gateway on `127.0.0.1` (`VIBERR_MCP_PROXY_PORT`, ruling 461;
   a bind failure is logged and boot carries on), then the event publisher.
10. Converge projections with the files: when the stored `projection.derivationVersion`
    lags `PROJECTION_DERIVATION_VERSION`, one forced full rescan (the new stamp is written
    only when no file failed); otherwise a reconciling **rescan** (hash short-circuit, not
    the drop-all rebuild) for edits made while the process was down.
11. `ensureBaseAgentsDeployed` (the operator everywhere; Developer/Reviewer only into
    projects with no specialist deployment at all).
12. Start the file watcher and the KB watcher.
13. Store maintenance: clear MCP warm-ups a restart interrupted, one retention pass (no
    workspace reclaim), arm the maintenance scheduler.
14. `repairCodexRolloutPaths` (ruling 199): re-point Codex thread rollouts recorded under
    removed per-run homes at their transcripts in the shared `sessions/` directory.
15. `reconcileRestartedWork` (async, not awaited): move orphaned runs to `interrupted`
    (reason `restart`) and sweep their surviving processes (ruling 174), replay unreacted
    agent replies, recover stranded Codex operator plans, settle waits no run backs
    (`settleAbandonedWaits`, rulings 213 and 215), then reclaim terminal-task workspaces
    only when no run is active.
16. Start the schedule runner, the GitHub reconcile poller and the goal runner; give
    controller conversations the restart interrupted an "interrupted" note
    (`recoverControllerConversations`).
17. Log one `boot integrity check` line (dirs, migrations, counts, users, build, disk,
    toolchain per ruling 182) and a `projection schema drift` WARN when a live CHECK
    (`task_projections.validation`, `task_projections.waiting`, and `notifications.kind`
    when step 7 could not widen it) does not admit a value the code declares, or
    `task_projections` / `task_events` lacks a baseline column.
18. Log `viberr server booted`.

Hard exits: invalid env, a held writer lock, a migration failure, an uncaught exception
or unhandled rejection; the lock guard shuts the process down when the lock file is
gone or replaced. Everything else is best-effort and logged.

## 6. Background services

| Service | Cadence | Module |
|---|---|---|
| File watcher (`projects/`) | event-driven, 250 ms debounce per path; a failed rebuild retries at 2 / 5 / 15 / 45 / 120 s (ruling 218) | `files/file-watch.service.server.ts` |
| KB watcher (`kb/`) | event-driven, 250 ms debounce per KB | `files/kb-watch.service.server.ts` |
| SSE heartbeat + re-authorization | 25 s per connection | `events/sse-broker.server.ts` |
| Data-root lock guard | 20 s, fail-closed | `db/data-root-lock.server.ts` |
| Schedule runner + stranded-task sweep | boot + 60 s; the sweep (ruling 330) runs after the schedules on each interval tick | `tasks/schedule.server.ts`, `tasks/stranded-sweep.server.ts` |
| Goal runner + dependency release | boot + 60 s; each tick reconciles goal chains, then releases held tasks whose waits are done (ruling 131) | `tasks/goal-actions.server.ts` |
| GitHub reconcile poller | boot + 5 min; alert after 3 consecutive failures | `github/reconcile-poller.server.ts` |
| Maintenance pass (retention, transcripts, workspaces) | boot + 6 h (`VIBERR_MAINTENANCE_INTERVAL_SECONDS`); the workspace reclaim skips while any run is queued or running | `ops/maintenance.server.ts` |
| Disk-pressure check | 5 min (`VIBERR_DISK_CHECK_INTERVAL_SECONDS`); extra pass at most every 30 min | `ops/maintenance.server.ts` |
| MCP warm-up | detached, ≤ 15 min per first install | `org/mcp-warmup.server.ts` |
| MCP gateway (ruling 461) | listener on `127.0.0.1` for the process lifetime; one token per live run that mounts a credentialed server, one upstream per (run, server) | `mcp-proxy/gateway.server.ts` |
| MCP OAuth sign-ins in flight (ruling 469) | in memory, 10 min each, spent by the first callback; a restart forgets them (the admin starts again) | `org/mcp-oauth.server.ts` |
| Run idle watchdogs | 15 min per backend (`VIBERR_CLAUDE_IDLE_TIMEOUT_MS`, `VIBERR_CODEX_IDLE_TIMEOUT_MS`); Claude max 2000 turns (`VIBERR_CLAUDE_MAX_TURNS`) | `runtimes/*-runtime.server.ts` |
| Action watchdog | 30 s, around project creation | `actions/action-watchdog.server.ts` |
| Rate-limiter prune | on insert, ≥ 1 s apart, 10 000 keys | `auth/rate-limit.server.ts` |
| Rescan / rebuild cooldown | 10 s / 30 s | `projections/single-flight.server.ts` |
| PAT revalidate cooldown | 60 s | `secrets/pat-validator.server.ts` |
| Live Claude model list | 10 min cache | `runtimes/model-catalog.server.ts` |

Shutdown (SIGINT/SIGTERM, `runProcessShutdown` in `events/sse-broker.server.ts`, the
app's only signal handler): close SSE connections, tear down the MCP gateway (every
token, session and upstream, killing each stdio server it spawned), stop both watchers and the lock
guard, WAL `TRUNCATE` checkpoint and close, release the lock, re-raise the signal. A
normal process `exit` also releases the lock. The image's `CMD` runs node directly
rather than through npm so the signal reaches it, and compose's `init: true` runs an
init as pid 1 that forwards signals and reaps orphans. A live Claude run's CLI leads its
own process group (ruling 174), so a terminal's Ctrl+C does not reach it directly. The
Agent SDK's own exit hook SIGTERMs each one's group as node exits, and whatever a crash
left alive is swept by run id at the next boot.

## 7. The storage model in one paragraph

Canonical: `projects/<slug>/project.md`, `projects/<slug>/tasks/<KEY>/task.md`,
`projects/<slug>/goals/<id>.md`, `agents/profiles/<id>.md`, `agents/definitions/<id>.md`,
`agents/controller-requests.md` (ruling 390), plus `kb/` and `skills/` folders. Derived
and rebuildable: `projects`, `project_members`, `task_projections`, `task_events`,
`goal_projections`, `diagnostics`. App-owned primary rows that live only in SQLite: users
and the better-auth tables, audit, notifications, prefs, instance settings, sealed GitHub
PATs and project credentials, each person's backend credentials, project GitHub health,
GitHub connections, scope violations, OAuth providers and the Google domain allowlist,
org resources (knowledge bases, MCP servers with their sealed credentials, skills), model
availability, the S3 audit-export config, controller conversations and messages, agent
runs and log lines, staged outcomes, and the append-only `provenance` ledger. The full
table list with retention is in [data-model.md](data-model.md).

## 8. Security posture

- **Sessions**: better-auth rows, cookie `viberr.session_token`, 30-day rolling expiry
  slid at most once a day, `Secure` derived from `BETTER_AUTH_URL` (a plain `http://`
  production origin only warns; the app never terminates TLS).
- **Endpoints**: `/api/auth/*` is an allow-list of six paths (`/sign-in/email`,
  `/sign-in/social`, `/callback/:id`, `/error`, `/get-session`, `/sign-out`); no
  self-signup; OAuth succeeds only for whitelisted accounts or allow-listed Google
  domains.
- **CSRF**: header proof plus HMAC double-submit on every form action; sign-in has an
  origin check and a per-email-and-IP token bucket (10 attempts per 15 minutes; client
  IP is trusted only with `VIBERR_TRUST_PROXY`).
- **Authorization**: membership from `project.md`, one role → action table, audited
  org-admin override, audited denials, project existence never disclosed to
  non-members.
- **Secrets**: env-only keys; AES-256-GCM sealed columns (`v1$iv$ct$tag`) with lazy key
  rotation (GitHub PATs, MCP credentials, OAuth client secrets, the S3 key, and the
  personal backend API keys of ruling 127); the PAT reaches git only through
  `GIT_ASKPASS`; git output and run-log lines are redacted, including each run's own
  credential value; SSE payloads are references, never content.
- **Agent accounts are per person (ruling 127)**: there is no deployment-wide provider
  credential. Each person connects Claude and Codex on Profile → Agent accounts; a hosted
  sign-in is executed by the unmodified vendor binary and its credential file stays in
  that person's own runtime home (`<dataRoot>/runtimes/users/<userId>/{claude-home,
  codex-home}`, owned by that person's agent uid, ruling 460), while a pasted key or
  workspace token is sealed in
  `user_backend_credentials` and never returned to a loader. Every run resolves ONE
  principal (the task owner, or the asker on a controller turn), persisted as
  `agent_runs.credential_user_id`; a run with no available principal is refused before any
  process starts. Viberr implements none of the vendors' OAuth and stores no Claude.ai or
  ChatGPT session token.
- **Org MCP credentials (ruling 461)**: a credentialed org MCP server is never handed to
  an agent process. The server hosts a loopback MCP gateway (`127.0.0.1` only, not a
  route); a run that mounts such a server gets a random run-scoped bearer the gateway
  accepts only for that run's granted servers and only while the run is live, and the
  gateway attaches the sealed credential upstream in the server process (Streamable
  HTTP with the SSE fallback, or a stdio command the server spawns with
  `MCP_CREDENTIAL`, under the server's own uid). Both backends get the same config. The
  run token rides the CLI's arguments, so another process on the host can read it while
  the run lives; it opens nothing but that run's grants, through the gateway, until the
  run settles.
- **Agent confinement**: Claude deny lists bind under `bypassPermissions`, and a
  withheld repo-write grant denies `Bash` command prefixes, including wrapped shapes such
  as `git -C` and `sh -c` (ruling 101(e), `runtimes/bash-policy.server.ts`). Codex runs
  `danger-full-access` with no OS sandbox (ruling 185): a withheld repo-write grant is
  advisory there (the prompt omits the steps and the delivery gate refuses them), web
  search is off unless granted, and marked MCP write tools are removed through
  `disabled_tools` (ruling 176). The repo's own `.claude` catalog is stripped and only
  granted skills are mounted; reserved MCP names are enforced at the writer, picker and
  resolver; the browser MCP is isolated and capability-gated; the in-process GitHub read
  tool scopes every path under the task's own repo; every child env starts from
  `filteredSpawnEnv()`, which strips every credential-shaped variable AND both vendor home
  variables, and gains back only the one principal's credential and the one home they
  own. A settled run leaves no live process: the Claude CLI leads its own process group
  and both backends' leftovers are swept by run id (ruling 174).
- **Every agent process runs as its person's own OS user (ruling 460)**: in the image,
  each person gets a stable agent uid (from 20001, never reused) in the shared group
  `viberr-agents`, and every Claude and Codex CLI, the Codex compaction and the backend
  sign-in flows are started through one setuid launcher (`viberr-launch`, root:node 4750,
  `tools/viberr-launch/viberr-launch.c`) that execs them as that uid. The server stays
  `node` and never becomes root. What that buys, measured: a run's shell is refused the
  server's `/proc/<pid>/environ` (the secret-encryption key, the session secret), the
  projection database (`state/` is 0700) and every other person's home. It needs the store
  on a mount that enforces permissions — the named volume `viberr-data`, not the macOS bind
  mount, which enforces none between uids — and health says which it is
  (`agentIsolation: on | off | degraded`). Workspaces, attachments and the uv caches are
  shared with the agent group (2770 setgid); canonical files, knowledge bases and skills are
  readable and never writable to an agent.
- **Ops**: single-writer lock with a fail-closed guard, WAL checkpoint on shutdown,
  self-heal on corruption, liveness vs readiness on `/resources/health` (readiness 503s
  when the watcher, KB watcher, lock, disk, a projection or agent isolation is degraded).

## 9. Where the canon lives

- Binding rulings and conventions: [decisions.md](decisions.md) (numbers are stable;
  code cites "ruling N").
- Canonical file formats: [file-formats.md](file-formats.md).
- Product requirements: `planning/planning-artifacts/prd.md` (mirrored byte-for-byte
  into `design/prd.md` by a test; edit canon only). Status per requirement:
  [../product/requirements-status.md](../product/requirements-status.md).
- `planning/planning-artifacts/architecture.md` is the original design document. It is
  useful for intent and history but is stale in places (see
  [../validation/2026-09-01-doc-validation.md](../validation/2026-09-01-doc-validation.md));
  when it disagrees with the code, the code and the `docs/` set here win.
