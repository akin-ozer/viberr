# Architecture overview

> The shape of the system as it runs today: stack, layers, the two request paths, the
> boot sequence, the background services, and the security posture. Sourced from
> `package.json`, `Dockerfile`, `app/entry.server.tsx`, `app/root.tsx`,
> `app/server/boot.server.ts` and the modules named inline. Verified against `main` @
> `68b5480` (2026-09-01). For the directory-by-directory map see
> [codebase-map.md](codebase-map.md); for the storage model see
> [data-model.md](data-model.md); for the binding rulings see
> [decisions.md](decisions.md). Updated 2026-09-02 for ruling 127 (branch
> `claude/per-user-codex-auth-difdnn`): the data-root subdirectory list and the security
> posture, both of which described deployment-wide agent credentials. Updated 2026-09-11
> for ruling 174 (branch `option-d/pr1-permissions-and-kill`): the shutdown paragraph in §6.

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
| Runtime | Node ≥ 26 (`.nvmrc`, image `node:26-slim`), ESM, TypeScript 7, `~/*` → `app/*` |
| Framework | React Router 8 framework mode, `ssr: true`, served by `@react-router/serve`; React 19 |
| Build / test | Vite 8, Vitest 4 (`app/**/*.test.{ts,tsx}`), Playwright 1.62 (chromium only, against the production image), oxlint 1.79 + the vendored `tools/oxlint/anti-slop` plugin (15 rules, CI gate) |
| Data | `node:sqlite` `DatabaseSync`, `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`; one file `state/projection.sqlite`; one squashed migration `db/migrations/0001_baseline.sql` applied at open |
| Validation | Zod 4 for env, files, SSE, DB row decoding |
| Files | `yaml` frontmatter, chokidar 5 watchers (250 ms debounce) |
| Auth | better-auth 1.6.25 behind `app/lib/auth.server.ts`; no plugins |
| Agents | `@anthropic-ai/claude-agent-sdk` 0.3.261, `@openai/codex-sdk` 0.153.4, `@playwright/mcp` 0.0.79 with Debian chromium; `uv`/`uvx` in the image for Python stdio MCP servers |
| UI | one stylesheet `app/app.css` (ported `viberr.css`, no Tailwind), Manrope / Noto Sans / JetBrains Mono, lexical (comment composer), dnd-kit (board), react-markdown + remark-gfm |
| Logging | dependency-free JSON lines on stdout with `AsyncLocalStorage` request correlation |

## 3. Layers and the rules between them

```
app/routes/      thin: guard (auth, CSRF, intent) → server call → route-shaped data
app/features/    per-surface components + *.server.ts query/action modules
app/ui/          primitives; imports nothing from features/ or server/
app/lib/         the better-auth instance
app/schemas/     zod contracts shared by both halves (task-file, project-file, goal-file, sse-event, github-pat, file-diagnostics)
app/shared/      client-safe cross-surface code (rbac, capabilities, workflow, mapping, dates, freshness, ids)
app/server/      everything server-only, *.server.ts
```

Rules that hold in the tree today (verified by grep, restated from
[decisions.md](decisions.md#layout)):

1. `app/ui/` never imports from `features/` or `server/`.
2. `*.server.ts` never enters the client bundle. Client components may import from a
   `.server` module only as `import type`.
3. Server → features imports are allowed only for `features/*.server.ts` modules (query
   and action modules that live beside their surface), for type-only imports, and for
   two pure catalog helpers (`features/agents/capability-catalog`,
   `features/kb-browser/tree`). Server code never imports a component.
4. One-definition rules: readiness derivation only in
   `server/interpretation/readiness-policy.server.ts`; freshness thresholds only in
   `shared/freshness.ts`; RBAC grants only in `shared/rbac.ts`; the capability catalog
   only in `shared/capabilities.ts`; provenance writes only in `server/provenance/`;
   the workspace `.claude` catalog only through `runtimes/skill-mount.server.ts`;
   reserved MCP names only in `shared/mcp-reserved.ts`; env parsing only in
   `config/env.server.ts` (a handful of ops knobs read `process.env` directly, listed in
   [../operations/configuration.md](../operations/configuration.md#3-raw-processenv-reads-outside-the-schema));
   DB row → camelCase only in `shared/mapping/*`.
5. `logger.server.ts` imports only `request-context.server.ts`;
   `tasks/task-mutation.server.ts` exists to break the `specialist-run → agent-toolkit
   → task-actions` cycle.
6. Runtime adapters (`claude-runtime`, `codex-runtime`) never touch the DB, files or
   the SSE broker; they emit lines and an exit, and `run-service` + `run-sink` persist
   and publish.

## 4. Request lifecycle

**Process start.** `entry.server.tsx` awaits `bootServer()` at module scope, so boot
finishes before the first request (§5). `root.tsx` mounts the request-correlation
middleware; the root loader authenticates through better-auth (forwarding the rolling
session cookie), reads theme and prefs, and mints the CSRF token.

**Read path** (`/projects/:slug/board`): layout loader → `requireUser` → project query
→ membership check from the project's own `members` list (files are truth) with the
audited org-admin override → non-member and unknown slug both 404 → viewer-scoped
annotations (decisions requiring the viewer, the review queue split) → rail counts and
notifications. Child routes read the layout data with `useRouteLoaderData`.

**Write path** (`intent=create-task`): route action → `requireFormAction` (session,
`assertCsrf`: the request must *prove* same-origin through Origin / Sec-Fetch-Site /
Referer **and** carry the HMAC double-submit `_csrf` token, intent) →
`requireVisibleProject` (404 parity) → `server/tasks/task-actions.createTask` →
`requireAction` consults `shared/rbac.ts` through `resolveProjectAuthority` (audits
`project.org_admin.override` or `project.authority.denied`) → `updateTaskFile`:
per-file mutex → parse → mutate → stamp `updatedAt` → serialize → atomic write (tmp +
rename; ENOSPC / ESTALE / EIO typed) → `recordAudit` → `rebuildPath` (synchronous
re-projection with hash short-circuit, derived readiness and validation, diagnostics,
provenance, SSE emit) → notifications → `autoInvokeOperator` → `{ ok, … }`; React
Router revalidates. Mutating actions run inside a 30 s watchdog that fails with a
typed 503 on an async hang.

**Out-of-band edits.** chokidar over `<dataRoot>/projects` (dotfiles, `*.tmp` and
everything below a task dir except `task.md` ignored; goal files included) →
`rebuildPath` → the same SSE event as an in-app write. Details in
[projections-and-events.md](projections-and-events.md).

**Live updates.** Projection events are emitted in-process (buffered inside
transactional rebuilds until commit), translated to the zod-parsed wire shape `{ type,
entityId, occurredAt, data }`, appended to a 256-event ring buffer and fanned out to
the scope-matching connections on `GET /resources/events`. The client revalidates the
active loaders (300 ms debounce); run logs are fetched by reference from
`/resources/run-log`. There is no optimistic UI for governed state.

## 5. Boot sequence (`app/server/boot.server.ts`)

1. Crash-visibility handlers (one synchronous stderr line, then exit 1).
2. Parse env once; warn when OAuth is configured without `BETTER_AUTH_URL` or when a
   production origin is plain `http://`.
3. `ensureDataRootDirs` (`projects`, `agents`, `agents/profiles`, `runtimes`,
   `runtimes/users`, `kb`, `skills`, `audit-exports`, `state`). *(Corrected 2026-09-02 —
   `audit-exports` was missing, and ruling 127 replaced the shared
   `runtimes/claude-home` / `runtimes/codex-home` with `runtimes/users`, under which each
   person's own `<userId>/{claude-home,codex-home}` is created 0o700 on demand.)*
4. Take `state/writer.lock` (refuse with the holder named, exit 1) and arm the
   SIGINT/SIGTERM shutdown; start the 20 s lock-ownership guard (fails closed).
5. Seed the shipped agent assets (skills, operator and controller definitions, base
   profile templates) when missing or unchanged since a shipped version.
6. Self-heal the projection DB if `quick_check` reports corruption (salvage the
   non-rebuildable tables into a fresh file, move the corrupt one aside).
7. Open SQLite, apply migrations, ensure the single-flight indexes.
8. Bootstrap admin on an empty `users` table (random one-time password logged once
   unless `VIBERR_SEED_ADMIN_PASSWORD` is set).
9. Start the event publisher, then a reconciling **rescan** (hash short-circuit, not
   the drop-all rebuild) for edits made while the process was down.
10. `ensureBaseAgentsDeployed` (operator everywhere; Developer/Reviewer only into
    roster-less projects).
11. Start the file watcher and the KB watcher.
12. Store maintenance: reap stale MCP warm-ups, one retention pass (no workspace
    reclaim), arm the scheduler.
13. `reconcileRestartedWork` (async): finalize orphaned runs, replay unreacted agent
    replies and stranded Codex operator plans, reclaim terminal workspaces when idle.
14. Start the schedule runner, the GitHub reconcile poller, the goal runner; note
    controller conversations interrupted by the restart.
15. Log one `boot integrity check` line (dirs, migrations, counts, users, build, disk)
    and a `projection schema drift` WARN when the live CHECK constraints lag the
    baseline.

Hard exits: invalid env, a held or stolen writer lock, a migration failure, an uncaught
exception. Everything else is best-effort and logged.

## 6. Background services

| Service | Cadence | Module |
|---|---|---|
| File watcher (`projects/`) | event-driven, 250 ms debounce per path | `files/file-watch.service.server.ts` |
| KB watcher (`kb/`) | event-driven, 250 ms debounce | `files/kb-watch.service.server.ts` |
| SSE heartbeat + re-authorization | 25 s per connection | `events/sse-broker.server.ts` |
| Data-root lock guard | 20 s, fail-closed | `db/data-root-lock.server.ts` |
| Schedule runner | boot + 60 s | `tasks/schedule.server.ts` |
| Goal runner | boot + 60 s | `tasks/goal-actions.server.ts` |
| GitHub reconcile poller | boot + 5 min; alert after 3 consecutive failures | `github/reconcile-poller.server.ts` |
| Maintenance pass (retention, transcripts, workspaces) | boot + 6 h (`VIBERR_MAINTENANCE_INTERVAL_MS`) | `ops/maintenance.server.ts` |
| Disk-pressure check | 5 min; extra pass at most every 30 min | `ops/maintenance.server.ts` |
| MCP warm-up | detached, ≤ 15 min per first install | `org/mcp-warmup.server.ts` |
| Run idle watchdogs | 15 min per backend; Claude max 2000 turns | `runtimes/*-runtime.server.ts` |
| Action watchdog | 30 s per mutating action | `actions/action-watchdog.server.ts` |
| Rate-limiter prune | on insert, ≥ 1 s apart, 10 000 keys | `auth/rate-limit.server.ts` |
| Rescan / rebuild cooldown | 10 s / 30 s | `projections/single-flight.server.ts` |
| PAT revalidate cooldown | 60 s | `secrets/pat-validator.server.ts` |
| Live Claude model list | 10 min cache | `runtimes/model-catalog.server.ts` |

Shutdown (SIGINT/SIGTERM, or the `exit` event): close SSE connections, stop watchers and
the lock guard, WAL `TRUNCATE` checkpoint and close, release the lock, re-raise the
signal. The container runs node as pid 1 through `exec` so the signal arrives. A live
Claude run's CLI leads its own process group (ruling 174), so a terminal's Ctrl+C no longer
reaches it directly. The Agent SDK's own exit hook SIGTERMs each one's group as node
exits, and whatever a crash left alive is swept by run id at the next boot.

## 7. The storage model in one paragraph

Canonical: `projects/<slug>/project.md`, `projects/<slug>/tasks/<KEY>/task.md`,
`projects/<slug>/goals/<id>.md`, `agents/profiles/<id>.md`, plus `kb/` and `skills/`
folders. Derived and rebuildable: `projects`, `project_members`, `task_projections`,
`task_events`, `goal_projections`, `diagnostics`. App-owned primary rows that live only
in SQLite: users and better-auth tables, audit, notifications, prefs, instance settings,
sealed PATs and MCP credentials, connections, scope violations, OAuth providers, org
resources, model availability, S3 config, controller conversations, agent runs and log
lines, staged outcomes, and the append-only `provenance` ledger. The full table list
with retention is in [data-model.md](data-model.md).

## 8. Security posture

- **Sessions**: better-auth rows, cookie `viberr.session_token`, 30-day rolling expiry
  slid at most once a day, `Secure` derived from `BETTER_AUTH_URL` (a plain `http://`
  production origin only warns; the app never terminates TLS).
- **Endpoints**: `/api/auth/*` is an allow-list of six paths; no self-signup; OAuth
  succeeds only for whitelisted accounts or allow-listed Google domains.
- **CSRF**: header proof plus HMAC double-submit on every form action; sign-in has an
  origin check and a per-email-and-IP token bucket (client IP is trusted only with
  `VIBERR_TRUST_PROXY`).
- **Authorization**: membership from `project.md`, one role → action table, audited
  org-admin override, audited denials, project existence never disclosed to
  non-members.
- **Secrets**: env-only keys; AES-256-GCM sealed columns with lazy key rotation (GitHub
  PATs, MCP credentials, OAuth client secrets, the S3 key, and the personal backend API
  keys of ruling 127); the PAT reaches git only through `GIT_ASKPASS`; git output and
  run-log lines are redacted, including each run's own credential value; SSE payloads are
  references, never content.
- **Agent accounts are per person (ruling 127)**: there is no deployment-wide provider
  credential. Each person connects Claude and Codex on Profile → Agent accounts; a hosted
  sign-in is executed by the unmodified vendor binary and its credential file stays in
  that person's own runtime home (`<dataRoot>/runtimes/users/<userId>/{claude-home,
  codex-home}`, mode 0700), while a pasted key or workspace token is sealed in
  `user_backend_credentials` and never returned to a loader. Every run resolves ONE
  principal (the task owner, or the asker on a controller turn), persisted as
  `agent_runs.credential_user_id`; a run with no available principal is refused before any
  process starts. Viberr implements none of the vendors' OAuth and stores no Claude.ai or
  ChatGPT session token.
- **Agent confinement**: Claude deny lists bind under `bypassPermissions`; Codex sandbox
  mode from grants plus the principal's own `CODEX_HOME`; the repo's own `.claude` catalog
  is stripped and only granted skills are mounted; reserved MCP names are enforced at the
  writer, picker and resolver; the browser MCP is isolated and capability-gated; the
  in-process GitHub read tool scopes every path under the task's own repo; every child env
  starts from `filteredSpawnEnv()`, which strips every credential-shaped variable AND
  both vendor home variables, and gains back only the one principal's credential and the
  one home they own.
- **Ops**: single-writer lock with a fail-closed guard, WAL checkpoint on shutdown,
  self-heal on corruption, liveness vs readiness on `/resources/health`.

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
