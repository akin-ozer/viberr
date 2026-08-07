# ARCHITECTURE — Viberr current state (pass 19)

> Verified against main @65063b8 on 2026-08-06 (pass 19).

Viberr is a governed-AI-delivery web app: **React Router 7** (framework mode,
loaders/actions) over a **file-native store** (markdown/frontmatter files are
canonical) projected into a **rebuildable SQLite read-model**, with **better-auth**
for sessions, an **SSE bus** for live updates, and a **single-writer data-root
lock**. Node 26, Vite 8, TypeScript 7. All anchors re-verified against
`main @65063b8`.

---

## 1. Layering

```
routes/  →  features/  →  server/  →  shared/ + schemas/
(loaders/    (UI slices +   (all server-    (isomorphic helpers +
 actions)     query.server)   only logic)     Zod file schemas)
```

Routes are thin: a loader/action calls a `server/` function and renders a
`features/` component. `server/*.server.ts` is server-only (never bundled to the
client). `shared/` is isomorphic (client+server safe). `schemas/` holds the Zod
schemas + tolerant parsers for the canonical files.

### Directory map (`app/`)

File counts (`find app/<dir> -type f`, pass 19): `routes/` 35, `features/` 164,
`server/` 251, `shared/` 29, `schemas/` 7, `lib/` 2, `ui/` 31.

| Dir | Purpose |
| --- | --- |
| `routes/` | RR7 route modules; the route table is `app/routes.ts` (52 lines). |
| `features/` | One dir per surface: activity, agents, board, github, home, kb-browser, live-updates, notifications, org-settings, policy, profile, project-settings, review, runtime, shell, task-detail. Each mixes `.tsx` with `*-query.server.ts` read helpers. |
| `server/` | All server-only logic (subdirs below). |
| `shared/` | `capabilities.ts`, `rbac.ts`, `freshness.ts`, `auth/`, mapping/dates/ids/text/workflow, and `docs/prd-sync.test.ts` (pins `design/prd.md` byte-identical to the canonical PRD — ruling 27). |
| `schemas/` | `task-file.schema.ts`, `project-file.schema.ts`, `sse-event.schema.ts`, `github-pat.schema.ts`, `file-diagnostics.ts`. |
| `lib/` | `auth.server.ts` — the better-auth instance factory. |
| `ui/` | Presentational primitives + hooks (markdown, rich-text, toast, pill, avatar, icon, `local-time.tsx`'s `useHydrated`, `stage-menu`, `roving-radio.ts` (UXA-7 arrow-key traversal for any `role="radiogroup"`), use-* hooks). |

`app/server/` subdirs (file counts, key files):

- **`tasks/` (46)** — task lifecycle domain: `task-actions.server.ts`,
  `operator-actions.server.ts`, `operator-toolkit.server.ts`,
  `agent-toolkit.server.ts`, `specialist-run.server.ts`, `schedule.server.ts`,
  `comment-guardrails.server.ts`, `specialist-tool-policy.ts` (see AGENTS-RUNTIME.md).
- **`runtimes/` (33)** — agent adapters + run pipeline: `claude-runtime`,
  `codex-runtime`, `operator-run`, `run-service`, `run-recovery`, `run-projection`,
  `session-export`, `model-catalog`, `{claude,codex}-config`, and (pass 18, R18-5)
  **`skill-mount.server.ts`** — the ONLY writer of a run workspace's `.claude`
  (strip the repo catalog + mount granted skills for the SDK).
- **`projections/` (24)** — files→SQLite read-model: `rebuilder.server.ts`,
  `rebuild.server.ts` (drop+rebuild), `rescan.server.ts`, `single-flight.server.ts`,
  `task-query`, `board-query`, and per-surface (activity-feed, notifications,
  decisions, review-queue, policy-violations, agent-deployments).
- **`github/` (23)** — `github-client`, `github-reconciler`, `reconcile-poller`,
  `pr-open`, `pr-linker`, `push-workspace`, `workspace-delivery`, `branch-*`.
- **`interpretation/` (5)** — the ONLY place readiness/diagnostics/freshness are
  derived: `readiness-policy`, `diagnostics-policy`, `freshness-policy`.
- **`db/` (9)** — SQLite lifecycle: `sqlite.server.ts` (`getDb`,
  `shutdownDatabase`), `migration-runner.server.ts`, **`data-root-lock.server.ts`**
  (§7), `retention.server.ts`, `transaction.server.ts`.
- **`events/` (5)** — `sse-broker.server.ts`, `event-publisher.server.ts`,
  `projection-events.server.ts`.
- **`files/` (25)** — file store I/O: `file-store-root.server.ts` (path helpers),
  `task-file`/`project-file` (read), `task-writer`/`project-writer` (write),
  `atomic-file`, `frontmatter`, `file-mutex`, **`file-watch.service.server.ts`**
  (chokidar store watcher), **`kb-watch.service.server.ts`** (KB watcher),
  `kb-injection`, `skill-body`, `agent-profile-file`.
- **`auth/` (24)** — `require-user`, `seed-admin`, `identity`, `password`, `login`,
  `oauth-provision`, `csrf`, `rate-limit`, `user-store`, `user-admin`,
  **`project-authority.server.ts`** (RBAC-GOVERNANCE.md), `require-project`.
- **`org/` (17)** — `resources.server.ts` (KB reindex), `connections`, `org-users`,
  `org-seed`, `resource-catalog`, `store-files`.
- **`secrets/` (6)** — `pat-store`, `pat-validator`, `secret-box` (AES PAT storage).
- **`config/` (2)** — `env.server.ts` (`getEnv`, validation).
- **`seed/` (18)** — `seed.server.ts`, `default-assets.server.ts`,
  `ensure-base-agents.server.ts`, `assets/`.
- Others: `prefs/`, `provenance/`, `audit/`, `errors/`, `logging/`, `theme/`, and
  the top-level `boot.server.ts`.

---

## 2. File-native store + SQLite projection model

**Files are canonical; SQLite is a derived, per-table-rebuildable read-model**
(`projections/rebuilder.server.ts:34-47`). Store layout + path helpers:
`app/server/files/file-store-root.server.ts` (layout doc :5-21, `DATA_ROOT_SUBDIRS`
:23-37). Key helpers: `getDataRoot` (:40), `projectFilePath` (:61) →
`projects/<slug>/project.md`, `taskFilePath` (:69) →
`projects/<slug>/tasks/<KEY>/task.md`, `resolveStoreSegment` (:108, traversal
guard). The read-model lives at `state/projection.sqlite`.

Store subdirs under the data root: `projects/`, `agents/profiles/`, `runtimes/`,
`kb/`, `skills/`, `state/`.

**Projection rebuild** (`projections/rebuilder.server.ts`):
`rebuildAll` (:707, full rescan + prune vanished rows), `rebuildProject` (:624,
scoped), `rebuildProjectFile` (:145), `rebuildTaskFile` (:326), `rebuildPath`
(:584, the watcher + mutation entry point, content-hash short-circuit at :369).

**Per-table drop+rebuild** (`projections/rebuild.server.ts`): `rebuildProjections`
(:35) DELETEs the derived tables (`task_events`, `diagnostics`, `task_projections`,
`projects`; `project_members` cascades, :41-44) then `rebuildAll(force)`, all in
one transaction with events buffered until commit. It explicitly PRESERVES the
non-projection SQLite tables (users, sessions, notifications, audit, provenance,
PATs, agent_runs, org resources — :26-30). **Everyday reconcile**: `rescanProjections`
/ `rescanProject` (`rescan.server.ts:10,32`), throttled by `single-flight.server.ts`
(`RESCAN_MIN_INTERVAL_MS=10s`, `REBUILD_MIN_INTERVAL_MS=30s`).

**Watchers (chokidar)**: `file-watch.service.server.ts` (`startFileWatcher` :106,
watcher :223-235 wiring add/change/unlink → `rebuildPath`, 250 ms debounce, keeps
only `project.md`/`task.md`); `kb-watch.service.server.ts` (`startKbWatcher` :52,
watcher :104-114 → `reindexKnowledgeBaseByDir`).

**Schema** (`db/migrations/0001_baseline.sql`, single migration, applied by
`migration-runner.server.ts` which tracks `schema_migrations`). Projection tables
(derived from files): `projects` (:49), `project_members` (:66), `task_projections`
(:72), `task_events` (:126), `diagnostics` (:144), `provenance` (:156). Canonical
SQLite tables (NOT projections — the data F18-5 protects): `users` (:23),
`audit_events` (:37), `notifications` (:165), `user_prefs` (:180), `github_pats`
(:187), `project_github_credentials` (:197), `github_connections` (:214),
`org_knowledge_bases` (:230), `org_mcp_servers` (:240), `org_skills` (:252),
`agent_runs` (:259), `run_log_lines` (:302), `staged_outcomes` (:409), plus
better-auth's `user`/`session`/`account`. See DOMAIN-MODEL.md §5 for the
task→row mapping.

---

## 3. Readiness / interpretation policy

Derivation is confined to `app/server/interpretation/` (rule stated at
`readiness-policy.server.ts:10-13`). The **canonical readiness enum** (4 values:
`ready`, `input_required`, `inconsistency_risk_detected`, `blocked`) is defined in
`schemas/task-file.schema.ts:25-31`; `"accepted"` is a derived display state.

- `deriveReadiness(input)` (`readiness-policy.server.ts:36`) — stored readiness is
  respected unless diagnostics impose a WORSE floor; derivation never improves
  readiness. `isAcceptedDisplayState` (:55).
- `diagnostics-policy.server.ts` — severity→floor: warning→`input_required`,
  error→`inconsistency_risk_detected`, hardStop→`blocked` (:4-17); `READINESS_RANK`
  (:20), `worstReadinessEffect` (:41), `referenceDiagnostics` (unknown-stage, :58).
- Applied in `rebuilder.server.ts:416` — writes both `readiness` (derived) and
  `stored_readiness` (raw) columns.
- `freshness-policy.server.ts` re-exports `isStale`/`STALE_AFTER_MS` from
  `~/shared/freshness`.

The **goal-interpretation / scoping-packet / triage gate** is the operator flow,
not this dir: the packet schema is in the task file (`taskPacketSchema`), and the
`triageQualityGate` lives in `runtimes/operator-run.server.ts:2085` (blocks
Triage→Ready until a vague goal survives scoping; placeholder `DEFAULT_GOAL` at
`task-actions.server.ts:421`). See AGENTS-RUNTIME.md §6.

---

## 4. better-auth (`app/lib/auth.server.ts` + `app/server/auth/`)

- **Instance**: `buildAuthOptions(deps)` (:112), `createAuth` (:316), cached
  singleton `getAuth()` (:332, keyed to the db handle). `AUTH_BASE_PATH =
  "/api/auth"` (:35); cookie prefix `viberr` → `viberr.session_token`.
- **Session**: rolling 30-day with daily slide (`expiresIn` 30d, `updateAge` 1d,
  :247-250); renewal `Set-Cookie` captured in
  `require-user.server.ts:77-84`. The canonical `users` row and better-auth `user`
  share one id.
- **Splat allow-list**: `ALLOWED_AUTH_PATHS` (:53-60) = sign-in/email, sign-in/social,
  callback/:id, error, get-session, sign-out; the `before` hook 404s any other
  `/api/auth/*` (:218-220). The route is `routes/api.auth.$.ts` (forwards the raw
  Request to `getAuth().handler`).
- **Passwords**: `emailAndPassword` with `disableSignUp: true` (no open
  registration), `minPasswordLength`, and TOTAL custom hash/verify wired to the
  app's `hashPassword`/`verifyPassword` (:159-162, so a bad legacy hash reads 401
  not 500). Login + social-start rate-limited per email|ip in the `before` hook
  (:207-245).
- **First-login temp password**: `seedInitialAdmin` (`seed-admin.server.ts:37`)
  creates the first admin with `pwresetRequired` when the password was generated
  (logged once); `requireAuth` redirects to `/login` while the flag is set
  (`require-user.server.ts:160-162`); the SSE route also refuses those sessions.
- **Env-admin bootstrap**: `seedInitialAdmin` creates the first `admin` when
  `users` is empty from `VIBERR_SEED_ADMIN_EMAIL/PASSWORD` (default
  `admin@viberr.dev`), called from boot. OAuth whitelist/provisioning hooks in
  `databaseHooks` (:271-311); org resource seeding is separate + additive
  (`org/org-seed.server.ts`).

---

## 5. SSE bus (`app/server/events/` + `app/features/live-updates/`)

- **Broker** (`sse-broker.server.ts`): `publishSseEvent(event, route)` (:313,
  monotonic id + ring buffer `RING_BUFFER_SIZE=256` + fan-out). Scopes
  (`SseScope`, :49-57): project / task / projects-firehose / user;
  `routeMatchesConnection` (:88). `connectSseClient` (:241) sends a `stream.open`
  hello, replays missed events on reconnect via `Last-Event-ID`, and starts an
  unref'd 25 s heartbeat.
- **Publisher bridge** (`event-publisher.server.ts:174`): subscribes the
  projection emitter → `translateProjectionEvent` → `publishSseEvent`.
  High-frequency `run.log-appended` bypasses the emitter.
- **Endpoint** (`routes/resources.events.ts`): `GET /resources/events` — 401 for
  unauth/pwreset, 400 for bad scope, 403 for non-member; streaming
  `text/event-stream` with backpressure cap `MAX_QUEUED_CHUNKS=1024`.
- **Client** (`live-updates/use-live-updates.ts:60`): `useLiveUpdates(scopes)`
  opens an `EventSource` and **triggers route revalidation** (no optimistic UI),
  300 ms debounced, exponential-backoff reopen on failure; the topbar shows a
  "live updates paused — retry" pill.
- **Shutdown teardown**: `runProcessShutdown()` (:361-372) — close SSE
  connections → `stopFileWatcher` → `stopKbWatcher` → **`stopDataRootLockGuard`** →
  `shutdownDatabase` → `releaseDataRootLock`. Registered once on SIGINT/SIGTERM in
  `getState()` (:155-163); `armProcessShutdown()` (:357) is the eager boot
  registration.

---

## 6. Boot sequence (`app/server/boot.server.ts`)

`bootServer()` (:180), ordered:

1. **`BOOT_KEY` idempotency guard** (:181-182; set at :317) — HMR/re-entrant safe.
2. `getEnv()` validation (:184).
3. `ensureDataRootDirs()` (:199).
4. **`takeDataRootWriterLock(env)`** (:205) — `acquireDataRootLock({force:
   forceDataRootTakeover(env)})`; on `DataRootLockedError` prints the refusal to
   stderr and `exit(1)`. Takeover driven by `VIBERR_FORCE_DATA_ROOT_LOCK`.
5. `armProcessShutdown()` (:210) — register the lock-releasing signal handler.
6. **`startDataRootLockGuard()`** (:216) — the F18-5 fail-closed guard (§7).
7. `seedDefaultAgentAssets()` (:221).
8. **`getDb()`** (:222) — open `state/projection.sqlite` + run migrations.
9. `seedInitialAdmin(db, …)` (:224).
10. `startEventPublisher()` (:231).
11. **`rescanProjections(db)`** (:238) — reconcile offline file drift into SQLite.
12. `ensureBaseAgentsDeployed(db)` (:255).
13. **`startFileWatcher()`** (:264) + **`startKbWatcher()`** (:268).
14. `finalizeOrphanedRuns(db)` (:275), `applyRetention(db)` (:286),
    `reconcileRestartedWork(db)` (:295, fire-and-forget).
15. `startScheduleRunner(db)` (:301), `startGithubReconcilePoller(db)` (:307),
    `logBootIntegrity(db)` (:309).

The lock is taken and GUARDED (steps 4-6) before anything opens the DB or writes a
file (step 8+) — the ordering rationale at :200-204.

---

## 7. Single-writer data-root lock + the F18-5 fail-closed guard

`app/server/db/data-root-lock.server.ts`. This is B-FD1: the defense against the
documented dual-writer WAL-clobber catastrophe (two processes on one `docker-data`
root over VirtioFS silently losing SQLite transactions).

**The lock**: `acquireDataRootLock` (:340) does an `O_EXCL` create
(`openSync(lockPath,"wx")`, :326-333) of `<dataRoot>/state/writer.lock`, keeps the
fd for the process lifetime, and writes a `LockHolder` (pid/hostname/startedAt/
`bootId`, :54-72). On `EEXIST`, `classifyLock` (:231) decides `stale`|`held`|
`unknown-holder`: a bootId self-reclaim or `VIBERR_FORCE_DATA_ROOT_LOCK`
(`forceDataRootTakeover` :196) removes and retries; a live foreign-host lock is
refused with `DataRootLockedError` (:133). `heldDataRootLock()` (:161) returns the
process-held lock; `releaseDataRootLock` (:191).

**F18-5 — the bug** (`8d75181`): the lock had **no defense against its own file
being deleted or replaced while held**. A store reset that deleted `state/` left
the holder with an unlinked-inode fd (still "holding" a ghost) while a second
process booted into the freed path and acquired a fresh lock — two live writers.
Org-level SQLite tables (users, encrypted PAT, KB/MCP rows, 20 notifications) were
silently lost on the next boot; `PRAGMA integrity_check` passed before and after
(it does not detect lost transactions).

**The fix** — fail CLOSED when the lock is stolen:

- `DataRootLock` interface (:94) now exposes `fd` (:99-100), `abandon()` (:108,
  drop tracking + close the stale fd WITHOUT unlinking — the file now belongs to
  whoever replaced us), and `verifyOwnership()` (:110).
- **`verifyLockOwnership(lock, probes?)`** (:276) — pure + injectable: `fstat` the
  held fd, `stat` the path, compare `ino`+`dev`; on inode match, corroborate by
  reading the file's `bootId` (VirtioFS synthesizes inode numbers). Returns
  `"held" | "stolen" | "unverifiable"`. Absence/mismatch/wrong-boot → `stolen`; a
  torn read → `unverifiable` (retry, not shutdown). Cannot false-positive on a
  normal run: the lock file is written once and never rewritten.
- **`startDataRootLockGuard(options)`** (:490) — an unref'd, HMR-safe (via a
  global symbol), 20 s timer (`DATA_ROOT_LOCK_GUARD_INTERVAL_MS`, :439) that
  re-verifies ownership of the process-held lock; on `stolen` it calls
  `stopDataRootLockGuard()` (:520) then `loudlyShutDownOnStolenLock` (:464) — a
  loud `logger.error` diagnosis + `lock.abandon()` (no unlink) + `process.exit(1)`.
  Started at boot (:216), stopped in `runProcessShutdown` before the deliberate
  release (so a clean shutdown is never mistaken for a steal).
- **Surface the holder** (F18-5b, `23c9ce6`): `/resources/health` returns
  `{pid, hostname, startedAt}` of the lock holder, and the Home store-maintenance
  strip renders it admin-only ("Writer: pid … on …", UI-INVENTORY.md).

Operational notes (`deployment.md`): never wipe `state/` while a process runs (it
defeats B-FD1); beware the same-port `::1`(host dev)-vs-IPv4(docker-proxy)
split-brain that made two live servers look like one app.

---

## 8. Delta summary (pass 18 + pass 19)

| Area | Change | Commit |
| --- | --- | --- |
| Data-root lock | F18-5 fail-closed guard (verifyLockOwnership / startDataRootLockGuard / abandon) + F18-5b Home strip | `8d75181`, `23c9ce6` |
| Boot | `startDataRootLockGuard()` added at boot.server.ts:216 | `8d75181` |
| SSE shutdown | `stopDataRootLockGuard()` added to `runProcessShutdown` teardown | `8d75181` |
| `runtimes/` | **NEW** `skill-mount.server.ts` (+ its test) — R18-5 native skill mounting; `runtimes/` 31 → 33 | `776e0ed` |
| `ui/` | **NEW** `roving-radio.ts` (+ test) — shared radiogroup arrow-key traversal; `ui/` 29 → 31 | `2098289` |
| `shared/` | **NEW** `docs/prd-sync.test.ts` — pins `design/prd.md` byte-identical to canon | `220103b` |
| `app.css` | 3953 → **3966** lines (UXA-8 mobile overflow rules appended at the end of the 1100 px block) | `2098289` |

Everything else in this doc (layering, projection model, interpretation,
better-auth, SSE, boot order, the data-root lock) is unchanged and was
re-verified line by line against `main @65063b8`: `boot.server.ts` steps
:181-317, `data-root-lock.server.ts` (:276 verifyLockOwnership, :340 acquire,
:439 interval, :490 guard, :520 stop), `rebuilder.server.ts` (:145/:326/:584/
:624/:707), `rescan.server.ts` (:10/:32), `single-flight.server.ts`
(RESCAN 10 s :39, REBUILD 30 s :40), `file-store-root.server.ts`
(:23/:40/:61/:69/:108), `auth.server.ts` (:35/:53/:112/:147/:249/:316/:332),
`sse-broker.server.ts` (:45/:49/:88/:241/:313/:357/:361). Note:
`docker-data/**` and `.claude/worktrees/**` contain checkout copies of the same
tree — the canonical source is `app/` and `db/`.
