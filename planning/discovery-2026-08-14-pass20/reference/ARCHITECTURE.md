# ARCHITECTURE — Viberr current state (pass 20)

> Verified against `main @b97ad02` on 2026-08-14 (pass 20).
>
> **Read this before trusting the pass-19 copy.** The pass-19 doc
> (`planning/discovery-2026-08-06-pass19/reference/ARCHITECTURE.md`) was pinned to
> `main @65063b8`, which is **74 commits before** the pass-19 merge `4184e95` —
> so its closing claim that "everything else … is unchanged" was already wrong on
> the day pass 19 shipped. Its counts, most of its `rebuilder.server.ts` anchors,
> its boot ordering and its table list all moved before the ~12 commits this pass
> was asked about. Every anchor below was re-read at `b97ad02`.

Viberr is a governed-AI-delivery web app: **React Router 8** (framework mode,
loaders/actions) over a **file-native store** (markdown/frontmatter files are
canonical) projected into a **rebuildable SQLite read-model**, with **better-auth**
for sessions, an **SSE bus** for live updates, and a **single-writer data-root
lock**. Node 26, Vite 8, TypeScript 7, React 19. `package.json` version `0.19.0`.

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

> The server-only boundary is load-bearing and the build enforces it. R19-16 hit
> it: importing `AUTH_BASE_PATH` from `lib/auth.server` into a route pulled a
> server-only module into the browser bundle and broke the production build. The
> constant moved to **`app/shared/auth/auth-paths.ts`** (`AUTH_BASE_PATH`,
> `oauthCallbackPath`, `oauthCallbackUrl`); `lib/auth.server.ts:44` re-exports it
> so every existing server importer is unchanged. Any constant a client component
> needs belongs in `shared/`, not in a `.server` module.

### Directory map (`app/`)

File counts (`git ls-tree -r --name-only HEAD app/<dir> | wc -l`, pass 20):
`routes/` **42**, `features/` **176**, `server/` **293**, `shared/` **31**,
`schemas/` 7, `lib/` 2, `ui/` 31. (Pass 19 recorded 35 / 164 / 251 / 29 / 7 / 2 / 31
— correct at `65063b8`, stale from `4184e95` onward.)

| Dir | Purpose |
| --- | --- |
| `routes/` | RR8 route modules; the route table is `app/routes.ts` (**59** lines, was 52). |
| `features/` | One dir per surface: activity, agents, board, github, home, kb-browser, live-updates, notifications, org-settings, policy, profile, project-settings, review, runtime, shell, task-detail. Each mixes `.tsx` with `*-query.server.ts` read helpers. Two suite-level guards sit at the top level: `copy-ban.test.ts` (F18-14 — banned words in rendered copy) and `retired-vocabulary.test.tsx`. |
| `server/` | All server-only logic (subdirs below). |
| `shared/` | `capabilities.ts`, `rbac.ts`, `freshness.ts`, **`auth/auth-paths.ts`** + `auth/password-policy.ts`, mapping/dates/ids/text/workflow, and `docs/prd-sync.test.ts` + `docs/file-formats-sync.test.ts` (pin `design/prd.md` and the file-format doc byte-identical to canon — ruling 27). |
| `schemas/` | `task-file.schema.ts`, `project-file.schema.ts`, `sse-event.schema.ts`, `github-pat.schema.ts`, `file-diagnostics.ts` (+2 tests). |
| `lib/` | `auth.server.ts` — the better-auth instance factory (+ its test). |
| `ui/` | Presentational primitives + hooks (markdown, rich-text, toast, pill, avatar, icon, `local-time.tsx`'s `useHydrated`, `stage-menu`, `roving-radio.ts`, use-* hooks). |

`app/server/` subdirs (file counts at `b97ad02`, key files):

- **`tasks/` (53, was 46)** — task lifecycle domain: `task-actions.server.ts`,
  `operator-actions.server.ts`, `operator-toolkit.server.ts`,
  `agent-toolkit.server.ts`, `specialist-run.server.ts`, `schedule.server.ts`,
  `comment-guardrails.server.ts`, `specialist-tool-policy.ts`,
  `specialist-mcp.server.ts`, and (R19-19) **`specialist-browser-mcp.server.ts`**
  (§8). Also new since pass 19: `no-change-completion.server.ts` (R17-2),
  `task-mutation.server.ts`.
- **`runtimes/` (33)** — agent adapters + run pipeline: `claude-runtime`,
  `codex-runtime`, `operator-run`, `run-service`, `run-recovery`, `run-projection`,
  `session-export`, `model-catalog`, `{claude,codex}-config`, and
  `skill-mount.server.ts` (R18-5 — the ONLY writer of a run workspace's `.claude`).
- **`projections/` (26)** — files→SQLite read-model: `rebuilder.server.ts`,
  `rebuild.server.ts` (drop+rebuild), `rescan.server.ts`, `single-flight.server.ts`,
  `task-query`, `board-query`, `task-activity`, and per-surface (activity-feed,
  notifications, decisions, review-queue, policy-violations, agent-deployments).
- **`github/` (29, was 23)** — `github-client`, `github-reconciler`,
  `reconcile-poller`, `pr-open`, `pr-linker`, `push-workspace`,
  `workspace-delivery`, `branch-*`, plus **`update-branch{,-operator}.server.ts`**
  (N19-9) and **`pr-human-approval.server.ts`** (R19-B: a human's GitHub approval
  is a verdict).
- **`interpretation/` (5)** — the ONLY place readiness/diagnostics/freshness are
  derived: `readiness-policy`, `diagnostics-policy`, `freshness-policy`.
- **`db/` (13, was 9)** — SQLite lifecycle: `sqlite.server.ts` (`getDb` :47,
  `shutdownDatabase` :96), `migration-runner.server.ts`,
  **`data-root-lock.server.ts`** (§7), **`cli-lock.server.ts`** (§7, new),
  **`backup.server.ts`** (new — `createBackup` :170 / `restoreBackup` :390),
  `retention.server.ts`, `transaction.server.ts`.
- **`events/` (5)** — `sse-broker.server.ts`, `event-publisher.server.ts`,
  `projection-events.server.ts`.
- **`files/` (29, was 25)** — file store I/O: `file-store-root.server.ts` (path
  helpers), `task-file`/`project-file` (read), `task-writer`/`project-writer`
  (write), `atomic-file`, `frontmatter`, `file-mutex`,
  **`file-watch.service.server.ts`** (chokidar store watcher),
  **`kb-watch.service.server.ts`** (KB watcher), `kb-injection`, `skill-body`,
  `agent-profile-file`, **`store-check.server.ts`** (new),
  **`task-attachments.server.ts`** (R19-19, §8).
- **`auth/` (27, was 24)** — `require-user`, `seed-admin`, `identity`, `password`,
  `login`, `oauth-provision`, `csrf`, `rate-limit`, `user-store`, `user-admin`,
  **`project-authority.server.ts`**, `require-project`, plus (R19-16)
  **`oauth-providers.server.ts`** + **`oauth-credential-test.server.ts`** (§4).
- **`org/` (19, was 17)** — `resources.server.ts` (KB reindex + the MCP registry,
  §9), **`mcp-warmup.server.ts`** (R19-18, §9), `connections`, `org-users`,
  `org-seed`, `org-view`, `resource-catalog`, `store-files`.
- **`ops/` (8) — NOT in the pass-19 doc at all** (§11): `build-info`, `disk-space`,
  `maintenance`, `transcript-retention`.
- **`secrets/` (10, was 6)** — `pat-store`, `pat-validator`, `secret-box` (AES),
  plus **`key-rotation.server.ts`** (sealed-store registry, §4) and
  **`git-output-redact.server.ts`** (`redactGitOutput` :77 — ruling 69; also the
  MCP-probe scrubber, §9).
- **`config/` (2)** — `env.server.ts` (`getEnv`, validation).
- **`seed/` (18)** — `seed.server.ts`, `default-assets.server.ts`,
  `ensure-base-agents.server.ts`, `assets/`.
- Others: `prefs/`, `provenance/`, `audit/`, `errors/`, `logging/`, `theme/`, and
  the top-level `boot.server.ts`.

`app/app.css` is **4218** lines (pass 19: 3966) — one stylesheet, gated by
`app/app.css.test.ts` (class-coverage + contrast, no allowlist).

---

## 2. File-native store + SQLite projection model

**Files are canonical; SQLite is a derived, per-table-rebuildable read-model.**
Store layout + path helpers: `app/server/files/file-store-root.server.ts` (layout
doc :5-23, `DATA_ROOT_SUBDIRS` :26-39). Key helpers: `getDataRoot` (:43),
`projectFilePath` (:64) → `projects/<slug>/project.md`, `taskDir` (:68),
`taskFilePath` (:72) → `projects/<slug>/tasks/<KEY>/task.md`,
**`taskAttachmentsDir` (:87)** → `projects/<slug>/tasks/<KEY>/attachments/`
(R19-19, §8), `resolveStoreSegment` (:126, traversal guard),
`storeRelativePath` (:172). The read-model lives at `state/projection.sqlite`.

Store subdirs under the data root (`DATA_ROOT_SUBDIRS`): `projects/`, `agents/`,
`agents/profiles/`, `runtimes/`, `runtimes/claude-home/`, `runtimes/codex-home/`,
`kb/`, `skills/`, `state/`.

**Projection rebuild** (`projections/rebuilder.server.ts` — every anchor moved
since pass 19): `rebuildAll` (**:741**, was :707 — full rescan + prune vanished
rows), `rebuildProject` (**:658**, was :624), `rebuildProjectFile` (**:148**,
was :145), `rebuildTaskFile` (**:344**, was :326), `rebuildPath` (**:618**,
was :584 — the watcher + mutation entry point). Content-hash short-circuit at
:180 (project) and :387 (task). Derived + raw readiness are both written at
:464/:474 (`readiness` and `stored_readiness` columns).

**Per-table drop+rebuild** (`projections/rebuild.server.ts`): `rebuildProjections`
(:35) DELETEs the derived tables (`task_events`, `diagnostics`, `task_projections`,
`projects`; `project_members` cascades, :41-44) then `rebuildAll(force)`, all in
one transaction with events buffered until commit. It explicitly PRESERVES the
non-projection SQLite tables (users, sessions, notifications, audit, provenance,
PATs, agent_runs, org resources — the rationale comment is now at **:24-27**).
**Everyday reconcile**: `rescanProjections` / `rescanProject`
(`rescan.server.ts:10,32`), throttled by `single-flight.server.ts`
(`RESCAN_MIN_INTERVAL_MS=10s` :39, `REBUILD_MIN_INTERVAL_MS=30s` :40,
`runSingleFlight` :51).

**Watchers (chokidar 5)**: `file-watch.service.server.ts` (`startFileWatcher`
:106, `WATCH_DEBOUNCE_MS=250` :32, watcher :223-235 wiring add/change/unlink →
`rebuildPath` and `unlinkDir` → dir reconcile; keeps only
`project.md`/`task.md`; an ENOENT from a vanished path is logged, never fatal);
`kb-watch.service.server.ts` (`startKbWatcher` :52, `KB_WATCH_DEBOUNCE_MS=250`
:31, watcher :104-114 → `reindexKnowledgeBaseByDir`).

**Schema** (`db/migrations/0001_baseline.sql` — still a SINGLE squashed migration,
applied by `migration-runner.server.ts` which tracks `schema_migrations` :33).
Projection tables (derived from files): `projects` (:49), `project_members`
(:66), `task_projections` (:72), `task_events` (:126), `diagnostics` (:144),
`provenance` (:156). Canonical SQLite tables (NOT projections — the data F18-5
protects): `users` (:23), `audit_events` (:37), `notifications` (:165),
`user_prefs` (:180), `github_pats` (:187), `project_github_credentials` (:197),
**`scope_violations` (:203)**, `github_connections` (:214),
**`oauth_providers` (:230)**, **`google_domain_allowlist` (:240)**,
`org_knowledge_bases` (:246), `org_mcp_servers` (**:256**),
`org_skills` (:277), `agent_runs` (:284), `run_log_lines` (:327),
`staged_outcomes` (:434), plus better-auth's `user`/`session`/`account`/
`verification` (:363-377). See DOMAIN-MODEL.md §5 for the task→row mapping.

> Pass 19 omitted `scope_violations`, `oauth_providers` and
> `google_domain_allowlist` from the table list, and every line anchor from
> `org_knowledge_bases` down has moved. The pre-prod squash convention still
> holds: **schema changes go into `0001_baseline.sql` and the data root is
> wiped/re-seeded**, which is exactly what R19-17b and R19-16 did.

---

## 3. Readiness / interpretation policy

*(Unchanged since pass 19 — re-verified line by line.)*

Derivation is confined to `app/server/interpretation/` (rule stated at
`readiness-policy.server.ts:10-13`). The **canonical readiness enum** (4 values:
`ready`, `input_required`, `inconsistency_risk_detected`, `blocked`) is defined in
`schemas/task-file.schema.ts:25-31`; `"accepted"` is a derived display state.

- `deriveReadiness(input)` (`readiness-policy.server.ts:36`) — stored readiness is
  respected unless diagnostics impose a WORSE floor; derivation never improves
  readiness. `isAcceptedDisplayState` (:55).
- `diagnostics-policy.server.ts` — severity→floor: warning→`input_required`,
  error→`inconsistency_risk_detected`, hardStop→`blocked` (:4-17);
  `READINESS_RANK` (:20), `readinessEffectOf` (:28), `worstReadinessEffect` (:41),
  `referenceDiagnostics` (unknown-stage, :58).
- Applied in `rebuilder.server.ts:464` (was :416) — writes both `readiness`
  (derived) and `stored_readiness` (raw) columns.
- `freshness-policy.server.ts` re-exports `isStale`/`STALE_AFTER_MS` from
  `~/shared/freshness`.

The **goal-interpretation / scoping-packet / triage gate** is the operator flow,
not this dir: the packet schema is in the task file (`taskPacketSchema`), and
`triageQualityGate` lives in `runtimes/operator-run.server.ts:2524` (was :2085;
blocks Triage→Ready until a vague goal survives scoping; placeholder
`DEFAULT_GOAL` at `task-actions.server.ts:323`, was :421). See AGENTS-RUNTIME.md §6.

---

## 4. better-auth (`app/lib/auth.server.ts` + `app/server/auth/`)

- **Instance**: `buildAuthOptions(deps)` (**:121**), `createAuth` (**:325**),
  cached singleton `getAuth()` (**:353**). `AUTH_BASE_PATH = "/api/auth"` now
  lives in `~/shared/auth/auth-paths.ts` and is re-exported at :44; cookie prefix
  `viberr` → `viberr.session_token`.
- **Session**: rolling 30-day with daily slide (`expiresIn` 30d, `updateAge` 1d,
  **:256-258**); renewal `Set-Cookie` captured in
  `require-user.server.ts:77` (`authenticateWithHeaders`). The canonical `users`
  row and better-auth `user` share one id.
- **Splat allow-list**: `ALLOWED_AUTH_PATHS` (**:62-69**) = sign-in/email,
  sign-in/social, callback/:id, error, get-session, sign-out; the `before` hook
  (:216) 404s any other `/api/auth/*` (**:226-227**). Route: `routes/api.auth.$.ts`.
- **Passwords**: `emailAndPassword` with `disableSignUp: true`,
  `minPasswordLength`, and TOTAL custom hash/verify wired to the app's
  `hashPassword`/`verifyPassword` (**:169-170**, so a bad legacy hash reads 401
  not 500). Login + social-start rate-limited per email|ip via `rateLimit.customRules`
  (:175) inside the same `before` hook.
- **First-login temp password**: `seedInitialAdmin` (`seed-admin.server.ts:37`)
  creates the first admin with `pwresetRequired` when the password was generated;
  `requireAuth` redirects to `/login` while the flag is set
  (`require-user.server.ts:160`); the SSE route also refuses those sessions.
- **Env-admin bootstrap**: `seedInitialAdmin` creates the first `admin` when
  `users` is empty from `VIBERR_SEED_ADMIN_EMAIL/PASSWORD` (default
  `admin@viberr.dev`), called from boot. OAuth whitelist/provisioning hooks in
  `databaseHooks` (**:280**+); `oauthProviderOf(context)` (:88) reads the provider
  off the running endpoint (`/callback/:id`) and **fails closed on null**, which
  is what stopped the Google-only domain allowlist from admitting GitHub sign-ins.
  Org resource seeding stays separate + additive (`org/org-seed.server.ts`).

### 4a. In-app OAuth provider configuration (R19-16) — NEW

`GITHUB_OAUTH_*` / `GOOGLE_OAUTH_*` env vars are now only a **bootstrap default**.
Admins configure sign-in from **Org settings → "Sign-in & SSO"**
(`features/org-settings/org-settings-page.tsx:17` declares the tab union
`"connections" | "users" | "sso" | "resources"`; the panel is
`features/org-settings/sso-panel.tsx:188`, gated admin-only by the existing
`routes/org.settings.tsx` route guard).

- **Store**: `app/server/auth/oauth-providers.server.ts` over the
  `oauth_providers` table (:230 in the baseline) — `saveOAuthProvider` (:116),
  `recordOAuthVerification` (:189), `setOAuthProviderEnabled` (:225),
  `deleteOAuthProvider` (:258), `resolveOAuthProvider` (:304),
  `resolveOAuthProviders` (:334), `oauthConfigFingerprint` (:356).
- **Ruling 1 — the app row OVERRIDES the deployment env**, including when the row
  is configured and DISABLED. `getAuth()` calls `resolveOAuthProviders(db)`
  (`auth.server.ts:369`) and the env only fills the gap.
- **Ruling 2 — enabling requires a passing test.** `verified_at` is written only
  by a live provider round-trip and cleared the moment either credential changes.
  The probe is real, not a shape check
  (`auth/oauth-credential-test.server.ts:135` `testOAuthCredentials`,
  `OAUTH_TEST_TIMEOUT_MS` :31): GitHub `POST /applications/{id}/token` answers
  401 for a bad pair and 404/422 for a good one; Google's token endpoint answers
  `invalid_client` vs `invalid_grant`.
- **No restart needed.** better-auth reads `socialProviders` once at construction,
  so the singleton cache entry now carries a **non-secret `providerFingerprint`**
  alongside the db handle (`AuthCacheEntry`, `auth.server.ts:337-341`); any save /
  test / enable / delete moves the fingerprint and the next request rebuilds the
  instance (:353-384).
- **Secrets** are sealed with the existing `secret-box` and the store is
  registered in **`secrets/key-rotation.server.ts` `SEALED_STORES` (:43)** — the
  key-rotation integrity test caught it before it shipped, and registering it is
  what forced the descriptor to grow an `idColumn` (the rotation scanner had
  hardcoded `id`; `oauth_providers` is keyed by `provider`).

---

## 5. SSE bus (`app/server/events/` + `app/features/live-updates/`)

*(Unchanged since pass 19 — every anchor re-verified.)*

- **Broker** (`sse-broker.server.ts`): `publishSseEvent(event, route)` (:313,
  monotonic id + ring buffer `RING_BUFFER_SIZE=256` :45 + fan-out). Scopes
  (`SseScope`, :49): project / task / projects-firehose / user;
  `routeMatchesConnection` (:88). `connectSseClient` (:241) sends a `stream.open`
  hello, replays missed events on reconnect via `Last-Event-ID`, and starts an
  unref'd 25 s heartbeat (`HEARTBEAT_INTERVAL_MS` :44).
- **Publisher bridge** (`event-publisher.server.ts:174`): subscribes the
  projection emitter → `translateProjectionEvent` (:51) → `publishSseEvent`.
  High-frequency `run.log-appended` bypasses the emitter.
- **Endpoint** (`routes/resources.events.ts:61`): `GET /resources/events` — 401
  for unauth/pwreset, 400 for bad scope, 403 for non-member; streaming
  `text/event-stream` with backpressure cap `MAX_QUEUED_CHUNKS=1024` (:59).
- **Client** (`live-updates/use-live-updates.ts:61`): `useLiveUpdates(scopes)`
  opens an `EventSource` and **triggers route revalidation** (no optimistic UI),
  300 ms debounced (`REVALIDATE_DEBOUNCE_MS` :40), exponential-backoff reopen; the
  topbar shows a "live updates paused — retry" pill.
- **Shutdown teardown**: `runProcessShutdown()` (:361-372) — close SSE
  connections → `stopFileWatcher` → `stopKbWatcher` → **`stopDataRootLockGuard`**
  (:369) → `shutdownDatabase` → `releaseDataRootLock`. `armProcessShutdown()`
  (:357) is the eager boot registration.

> **The event vocabulary is a closed typed union routed by user/project/task
> scope** (`schemas/sse-event.schema.ts`). R19-18 deliberately did NOT add an
> event for a transient org-settings row state and used a 20 s poll instead (§9)
> — treat "add a new SSE event name" as a real design decision, not plumbing.

---

## 6. Boot sequence (`app/server/boot.server.ts`)

`bootServer()` (**:250**, was :180), ordered:

1. **`BOOT_KEY` idempotency guard** (:251-252; set at :383) — HMR/re-entrant safe.
2. `getEnv()` validation (:254) + a `BETTER_AUTH_URL`-behind-a-proxy warning
   (:260-267).
3. `ensureDataRootDirs()` (:269).
4. **`takeDataRootWriterLock(env)`** (:275) — `acquireDataRootLock({force:
   forceDataRootTakeover(env)})`; on `DataRootLockedError` prints the refusal to
   stderr and `exit(1)`. Takeover driven by `VIBERR_FORCE_DATA_ROOT_LOCK`.
5. `armProcessShutdown()` (:280) — register the lock-releasing signal handler.
6. **`startDataRootLockGuard()`** (:286) — the F18-5 fail-closed guard (§7).
7. `seedDefaultAgentAssets()` (:291).
8. **`getDb()`** (:292) — open `state/projection.sqlite` + run migrations.
9. `seedInitialAdmin(db, …)` (:294).
10. `startEventPublisher()` (:301).
11. **`rescanProjections(db)`** (:308) — reconcile offline file drift into SQLite.
12. `ensureBaseAgentsDeployed(db)` (:325).
13. **`startFileWatcher()`** (:334) + **`startKbWatcher()`** (:338).
14. `finalizeOrphanedRuns(db)` (:345).
15. **`startStoreMaintenance(db)`** (:357) — **replaces pass-19's
    `applyRetention(db)`.** Defined at :121 and does three things in order:
    **`reapStaleWarmups(db)`** (:127 — R19-18, clears `warming_since` rows left by
    a dead process, §9), `runMaintenancePass(db, {reason:"boot",
    reclaimWorkspaces:false})` (:137), then `startMaintenanceScheduler(db)` (:143)
    so a container that never restarts still prunes (§11). `reclaimWorkspaces:
    false` is deliberate — `reconcileRestartedWork` owns the reclaim (P14-RT-09).
16. `void reconcileRestartedWork(db)` (:361, fire-and-forget; defined :168 —
    agent-reply recovery → codex operator-plan recovery → workspace reclaim, in
    that order).
17. `startScheduleRunner(db)` (:367), `startGithubReconcilePoller(db)` (:373),
    `logBootIntegrity(db)` (:375).

The lock is taken and GUARDED (steps 4-6) before anything opens the DB or writes a
file (step 8+) — the ordering rationale at :270-285.

---

## 7. Single-writer data-root lock + the F18-5 fail-closed guard

`app/server/db/data-root-lock.server.ts`. This is B-FD1: the defense against the
documented dual-writer WAL-clobber catastrophe (two processes on one `docker-data`
root over VirtioFS silently losing SQLite transactions).

**The lock**: `acquireDataRootLock` (:340) does an `O_EXCL` create of
`<dataRoot>/state/writer.lock` (`DATA_ROOT_LOCK_FILENAME` :49), keeps the fd for
the process lifetime, and writes a `LockHolder` (pid/hostname/startedAt/`bootId`).
On `EEXIST`, `classifyLock` (:231) decides `stale`|`held`|`unknown-holder`: a
bootId self-reclaim or `VIBERR_FORCE_DATA_ROOT_LOCK` (`forceDataRootTakeover`
:196, env name at :52) removes and retries; a live foreign-host lock is refused
with `DataRootLockedError` (:133). `heldDataRootLock()` (:161);
`releaseDataRootLock` (:191).

**F18-5 — the bug**: the lock had **no defense against its own file being deleted
or replaced while held**. A store reset that deleted `state/` left the holder with
an unlinked-inode fd (still "holding" a ghost) while a second process booted into
the freed path — two live writers. Org-level SQLite tables were silently lost;
`PRAGMA integrity_check` passed before and after (it does not detect lost
transactions).

**The fix** — fail CLOSED when the lock is stolen:

- `DataRootLock` interface (:94) exposes `fd`, `abandon()` (:108 — drop tracking +
  close the stale fd WITHOUT unlinking) and `verifyOwnership()` (:110).
- **`verifyLockOwnership(lock, probes?)`** (:276) — pure + injectable: `fstat` the
  held fd, `stat` the path, compare `ino`+`dev`; on inode match, corroborate by
  reading the file's `bootId` (VirtioFS synthesizes inode numbers). Returns
  `"held" | "stolen" | "unverifiable"`. A torn read → `unverifiable` (retry, not
  shutdown).
- **`startDataRootLockGuard(options)`** (:490) — unref'd, HMR-safe, 20 s timer
  (`DATA_ROOT_LOCK_GUARD_INTERVAL_MS` :439); on `stolen` it calls
  `stopDataRootLockGuard()` (:520) then `loudlyShutDownOnStolenLock` (:464) — loud
  `logger.error` + `lock.abandon()` + `process.exit(1)`.
- **Surface the holder** (F18-5b): `/resources/health` returns
  `{pid, hostname, startedAt}` of the lock holder
  (`routes/resources.health.ts:103-110`), rendered admin-only in the Home
  store-maintenance strip.

### 7a. The CLI writer lock (`db/cli-lock.server.ts`) — NEW, not in pass 19

The invariant was enforced against a second **server**, not a second **writer**:
`npm run seed`, `npm run seed:demo` and `npm run rescan` opened the same
projection with no coordination — and both are recommended against a *live*
instance in `deployment.md` / `runbook.md`. Every writing CLI now goes through
**`runWithDataRootWriterLock`** (:105), which takes the same lock with the same
inode+bootId proof, the same staleness rules and the same
`VIBERR_FORCE_DATA_ROOT_LOCK` takeover, and fails closed with
`cliLockRefusalMessage` (:70) naming the holder. `acquireCliWriterLock` (:88),
`cliDataRoot` (:130).

**Read-only CLIs deliberately do NOT take it** — `npm run backup`,
`npm run store:check`, `npm run keys -- status` open the projection read-only
(`db/backup.server.ts`, `files/store-check.server.ts`). Refusing to back up a
running instance would defeat the point. New scripts: `scripts/backup.ts`,
`scripts/restore.ts`, `scripts/store-check.ts`, `scripts/secret-keys.ts`.

Operational notes (`deployment.md`): never wipe `state/` while a process runs;
beware the same-port `::1`(host dev)-vs-IPv4(docker-proxy) split-brain.

---

## 8. Agents get a real browser + the task attachments store (R19-19) — NEW

Owner ruling, `docs/architecture/decisions.md` **75**. Three pieces: a
capability-enforced MCP mount, a canonical attachments directory, and a
member-only serving route.

### 8a. The capability

`app/shared/capabilities.ts:111` —
`cap("use-browser", "Drive a live web browser", ["agent"], "Collaboration", "off")`.
**Default OFF** (absence is withholding, the P14-LV-01 polarity), agent-kind only.

### 8b. The mount IS the enforcement (`server/tasks/specialist-browser-mcp.server.ts`)

Deliberately **not** an org-registry row: registry MCPs sit outside the capability
policy (P13-KM-04, governance-by-instruction), and a browser is exactly the tool
that must not ride that gap — it is network egress, it executes page JavaScript,
and it feeds page content to an agent that may hold repo-write.

- `BROWSER_MCP_NAME = "viberr_browser"` (:50).
- `resolveBrowserMcp({grants, attachmentsDir, backend})` (:93) returns
  `{server, refused}` (`BrowserMcpResolution` :52). Granted ⇒ a viberr-owned
  **Playwright MCP** child (`@playwright/mcp` **0.0.79**, a *production*
  dependency in `package.json`) joins the run's `mcpServers` on **both** backends.
  Withheld ⇒ the tool surface does not exist.
- **The egress interlock** (:108-114): the mount also requires effective
  `use-web-search-fetch` to be `direct`. A profile whose web egress was revoked
  cannot re-acquire it one row down. The contradictory pair is **surfaced**, not
  silently resolved — it rides the existing P14-LV-09 `UnresolvedMcpGrant`
  disclosure pipe into the run's inputs and persona.
- **Containment** (argv at :126-138): `--headless`, `--isolated` (in-memory
  profile — no cookies surviving a run or crossing tasks), **no**
  `--allow-unrestricted-file-access` (so `file://` is blocked and file access is
  confined to the child cwd), `--output-dir <attachments>`, and on Codex
  `--image-responses omit` (image content blocks in MCP tool results are unproven
  on the codex CLI). The CLI entry is resolved through
  `playwrightMcpCliPath()` (:69) — the package's exports map hides `cli.js`, so it
  resolves `package.json` and joins. The child is `process.execPath` + args, with
  **no env and no credential**, so it survives the codex `--config` argv
  serialization intact.
- **Injection stance is prompt-level** (owner decision b):
  `browserPersonaSection(attachmentsRel)` (:150) — pages are DATA never
  instructions; never enter credentials; the browser widens no authority; and the
  screenshot-naming instruction below.
- **Wiring**: `tasks/specialist-run.server.ts:1184` computes `attachmentsDir`,
  :1190 resolves the mount (only for a real backend), :1212 announces it in the
  persona's MCP list, :1217 passes `attachmentsRel`, :1397 merges it into
  `mergedMcpServers` **between** the org grants and the toolkit (a registry row
  can never shadow it, and it can never shadow viberr's governance tools). The
  resume path repeats this at :2190-2264.
- `viberr_browser` / `viberr-browser` joined `RESERVED_MCP_NAMES`
  (`tasks/specialist-mcp.server.ts:60`) and `isReservedMcpName`
  (`org/resources.server.ts:1055`) — refused at save AND skipped by the resolver,
  both spellings.

**Live-verified quirk you must not "fix" away** (0.0.79): a screenshot taken with
the DEFAULT name lands in `--output-dir`; one taken with an explicit `filename:`
resolves against the **child cwd** (the run workspace) instead, because the SDK's
stdio config carries no `cwd`. The persona therefore steers agents to default
naming and says so out loud.

### 8c. The attachments store

`app/server/files/task-attachments.server.ts` — the read side is deliberately
dumb: **the directory is the truth**. No projection table, no upload path, no
retention machinery; attachments live inside the task dir so archive/delete flows
move them with the task. `listTaskAttachments` (:35, newest-first, `LIST_CAP=100`
:33, skips dotfiles, tolerates a raced unlink), `resolveTaskAttachment` (:67 —
through `resolveStoreSegment`, throws on traversal), `INLINE_TYPES` (:78) and
`attachmentContentType` (:91).

### 8d. The serving route

`app/routes/task-attachment.ts` → `GET /projects/:slug/tasks/:key/attachments/:file`
(registered in `app/routes.ts:41-44`, **outside** the workspace layout since it
serves raw bytes).

- Authorization is **project membership** (`requireProjectMember`, :33) — the same
  bar as `/resources/run-log`, because a screenshot can show anything the agent
  saw. Org admins pass via the audited D2 override inside the same guard.
- Traversal violations become a plain **404**, never an oracle (:36-40).
- `MAX_ATTACHMENT_BYTES = 50 MB` (:29) → 413 above it.
- Every response carries `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: sandbox; default-src 'none'` (:63-67), and only
  whitelisted types render inline — **stored HTML/SVG/JS are never inline** (they
  download as `application/octet-stream`), because a stored page served on the app
  origin would be stored XSS with the viewer's session attached.

### 8e. The UI

- `features/task-detail/attachments-panel.tsx:18` — newest-first panel, images in
  a thumbnail grid, everything else as files; **renders nothing at zero** rather
  than an empty "Attachments (0)" on every task.
- `routes/project.task.tsx:245` gates the list on `runsVisible` (non-members get
  `[]`; the route re-checks membership on every fetch anyway), and passes
  `attachmentsBase` at :890.
- **Evidence linkify**: `features/task-detail/timeline.tsx:111` `EvidenceLabel` —
  an evidence label token (backticks/quotes/trailing punctuation stripped) that
  matches a filename the task ACTUALLY has becomes a link to the serving route.
  Everything else stays plain text — no guessing.

### 8f. The image

`Dockerfile:60-73` installs Debian `chromium` + `fonts-liberation` (~700 MB with
its dependency closure; the owner accepted the weight over a sidecar) and sets
`ENV VIBERR_BROWSER_EXECUTABLE=/usr/bin/chromium`
(`server/config/env.server.ts:92`, optional). When that var is set the mount
builder also passes `--no-sandbox`, because chromium's user-namespace sandbox
cannot start under docker's default seccomp as the non-root `node` user. On a dev
host the var is unset and Playwright's own resolution + sandbox apply.

---

## 9. The org MCP registry: probe honesty + background first-run installs — NEW

`app/server/org/resources.server.ts` (+ `org/mcp-warmup.server.ts`). Four rulings
landed here since pass 19; together they turn "red dot, three words" into a real
diagnosis.

**R19-17 — surface what the command said.** The stdio probe spawned with
`stdio: ["pipe","pipe","ignore"]`, so the child's own explanation was discarded at
the OS level. stderr is now captured (bounded 8 KB) and carried in the failure
reason (`defaultSpawn` :765, `discoverStdioMcpTools` :811). The spawn error itself
is surfaced too (`spawn uvx-not-installed ENOENT`). The scrubber is
**`redactGitOutput`** (`secrets/git-output-redact.server.ts:77`) — deliberately,
not incidentally: the child is spawned WITH `MCP_CREDENTIAL` in its env
(P13-KM-05), so a server that dumps its environment while dying would otherwise
print the credential into a toast. It removes the token **by value**, strips ANSI
and clamps to the TAIL (where a traceback's actual error sits).

**R19-17b — keep the reason on the row.** `org_mcp_servers.last_error` (baseline
:256). Written by every probe path (save and test, both transports) and **CLEARED
by a passing probe** — a stale explanation under a green dot is worse than none.
Rendered monospace under the "unreachable" line, clamped to 8 lines to match
`redactGitOutput`'s own bound (a tighter clamp re-clipped the last line, which in
a traceback is the one that names the error).

**R19-17c — tell a first-run install apart from a hung command.** The stdio window
went 5 s → **20 s** (`discoverStdioMcpTools:826`): `npx` and `uvx` FETCH on first
use and were being killed before printing a word. When the probe gives up and
stderr matches `INSTALLING_RE`
(`/\b(downloading|building|installing|resolving|fetching|added \d+ packages)\b/i`,
:897) the reason says so and the discovery carries `installing: true`
(`StdioDiscovery` :774). **Earned by evidence only** — a silent command still
reports a plain timeout.

**R19-18 — finish the install in the background.** `org/mcp-warmup.server.ts`:

- `startMcpWarmup(db, {...}, opts)` (:62) re-runs **the same**
  `discoverStdioMcpTools` handshake with `WARMUP_CAP_MS = 15 min` (:35), detached
  from the request, and writes the real verdict to the row when it settles. It is
  reached by dynamic `import("./resources.server")` to break the cycle.
- One in-process `Set` keyed by server id makes a second registration a no-op
  (`isWarming` :41) rather than a second gigabyte of downloads.
- `org_mcp_servers.warming_since` is the row's own third state — **neither green
  nor red**, because nothing has answered and nothing is broken.
- **`reapStaleWarmups(db)`** (:129) runs at boot (`boot.server.ts:127`): the flag
  means "running HERE", so after a restart a surviving one would be a row claiming
  to install with no installer behind it.
- `saveMcpServer` starts a warm-up when `disc.kind === "down" && disc.installing`
  (:1282); `testMcpServer` does the same (:1412).
- **The settings page polls, it does not subscribe**:
  `features/org-settings/resources-panel.tsx:113-122` arms a 20 s
  `revalidator.revalidate()` interval **only while some row is warming**. The
  reason is architectural — the SSE vocabulary is a closed typed union routed by
  user/project/task scope and an org-settings row fits none of them (§5).

**Why the image ships uv** (`Dockerfile:85`): `specialist-mcp.server.ts` spawns a
registered stdio server's command **verbatim — there is no allow-list** — so
whatever the command names must exist in the runtime image. `npx` shipped with the
base image; the entire Python half of the ecosystem (`uvx mcp-server-…`) did not.
`uv` + `uvx` are copied as two static binaries from
`ghcr.io/astral-sh/uv:0.12.3`; **no system python3**, because uv downloads and
manages its own CPython. Its cache and that interpreter go on the `/data` volume
next to `CLAUDE_CONFIG_DIR` and `CODEX_HOME` for the same reason those do (both
default under `$HOME`, which is container-local) — measured 90 MB cache + 93 MB
interpreter, now persistent.

---

## 10. The run console (P19-RC1) — NEW

`app/features/runtime/runs-helpers.ts` + `runs-panels.tsx`. The run projection
already distinguished reasoning (`ev:"think"`), tool calls (`ev:"tool"` with
`name`/`input`), file changes (`changes`) and multi-line output (`out`/`diff`) —
the console painted all of them as the same flat grid row.

Three foldings, all **pure functions in `runs-helpers.ts`** so what a reader is
shown is testable against the stored lines, not only by rendering a panel:

- **Thought traces** — `isThoughtLine` (:266), `groupThoughts` (:280),
  `thoughtLabel` (:323) fold *consecutive* `think` lines into one "Thought for 4s ·
  3 steps" disclosure. Consecutive only: thought → acted → thought is the real
  shape of a turn. A lone reasoning line stays an ordinary row.
- **Tool chips** — `toolChip` (:351) promotes a *named* tool call out of the
  prose; a line whose provider sent no name keeps the plain row (a chip labelled
  with a guess is worse than no chip). `fileChangeChips` (:369) renders one chip
  per file, marked with a **glyph as well as a colour** (WCAG 1.4.1), and with no
  line counts — the envelope records a path and a kind and nothing else.
- **Code blocks** — `consoleCodeBlock` (:393) moves multi-line `out`/`diff` into a
  bounded, scrollable block with a copy affordance; `diffLineKind` (:400) colours
  `+`/`−` on top of the glyph the stored line already carries. **Bounded by CSS,
  never truncated** — dropping the tail of a build log is the exact dishonesty the
  raw toggle exists to rule out. No language label (the projection carries none).

`ConsoleBlock<T>` (:263) is the union the panel renders. **The `{ } raw` toggle
stays authoritative**: every folding is a no-op under `raw`, the same contract
`collapseTelemetry` already held — see `runs-panels.tsx:443` (state) and :488-490
(`groupThoughts(collapseTelemetry(hoistRunInputs(shown), raw), raw)`).

CSS is one appended section in `app/app.css` using the console's own literal-hex
palette (`.console` paints a fixed near-black fill in both themes). Two gates
caught real problems: the contrast gate rejected `.lk-meta` at 4.33:1 on the
block's own fill, and the class-coverage gate would have failed any class shipped
without a rule — both live in `app/app.css.test.ts`.

---

## 11. Ops / store maintenance (`app/server/ops/`) — NEW, absent from pass 19

Four modules, armed from `boot.server.ts:357` via `startStoreMaintenance` (§6):

- **`maintenance.server.ts`** — `runMaintenancePass` (:124),
  `DEFAULT_MAINTENANCE_INTERVAL_MS = 6 h` (:64),
  `DEFAULT_DISK_CHECK_INTERVAL_MS = 5 min` (:67),
  `MIN_PRESSURE_PASS_GAP_MS = 30 min` (:70), `activeRunCount` (:103 — the periodic
  pass's own active-run guard, since boot's pass runs with
  `reclaimWorkspaces:false`). Retention used to run exactly once per process, at
  boot — coupled to the restart a stable deployment never performs.
- **`transcript-retention.server.ts`** — `pruneRuntimeTranscripts` (:175);
  `DEFAULT_TRANSCRIPT_RETENTION_DAYS` / `DEFAULT_SESSION_HOME_RETENTION_DAYS` = 30
  (:62/:64). Prunes raw run transcripts and provider session homes on disk.
- **`disk-space.server.ts`** — `measureDataRootSpace` (:96),
  `cachedDataRootSpace` (:132, `DISK_MEASUREMENT_TTL_MS = 5 s` :122),
  `classifyFreeBytes` (:82) against `DEFAULT_DISK_LOW_FREE_BYTES = 2 GB` /
  `DEFAULT_DISK_CRITICAL_FREE_BYTES = 512 MB` (:45/:47).
- **`build-info.server.ts`** — `getBuildInfo` (:121) / `resolveBuildInfo` (:98).

---

## 12. The runtime image is part of the architecture

`Dockerfile` (143 lines). Because `specialist-mcp.server.ts` spawns registered
stdio commands verbatim and `specialist-browser-mcp.server.ts` mounts a browser,
**what the image carries is a functional contract, not packaging**:

| Layer | Why |
| --- | --- |
| `git`, `ca-certificates` (:55-58) | clone/deliver |
| `chromium` + `fonts-liberation` (:60-72) + `VIBERR_BROWSER_EXECUTABLE` (:73) | R19-19 (§8f) — a pinned binary, not `npx playwright install` into a container-local cache |
| `uv` + `uvx` from `ghcr.io/astral-sh/uv:0.12.3` (:85) | Python MCP servers (§9); no system python3 by design |
| `VIBERR_DATA_ROOT=/data` | canonical store + projections on the mounted volume |

Two build fixes landed this window and both are non-obvious:

- **`npm prune --omit=dev` needs `--no-audit --no-fund`** (`a1ceb78`). The
  floating `node:26-slim` tag moved to a digest shipping npm 11.19.0, whose prune
  stalls on a registry round-trip. Pruning an already-installed tree needs no
  registry.
- **`npm ci` needs `--foreground-scripts`** (`b97ad02`). A from-scratch install
  (changed lockfile + refreshed base ⇒ no layer cache) failed with **ETXTBSY**:
  esbuild's postinstall spawns its just-written binary for `--version` while
  overlayfs still counts a writer on it. Serializing install scripts on both
  `npm ci` lines costs only when the lockfile-keyed layers actually rebuild.
- `fa773e0` stopped pruning `node_modules` on every source change (docker build).

---

## 13. Delta summary (pass 19 → pass 20)

| Area | Change | Commit |
| --- | --- | --- |
| **Doc baseline** | pass-19 doc was pinned to `65063b8`, **74 commits behind** the pass-19 merge — counts, `rebuilder` anchors, boot order and the table list were already stale | `4184e95` |
| Sign-in | **NEW** `auth/oauth-providers.server.ts` + `oauth-credential-test.server.ts`, `oauth_providers` + `google_domain_allowlist` tables, `SsoPanel`, `getAuth()` keyed on a provider fingerprint; `AUTH_BASE_PATH` moved to `shared/auth/auth-paths.ts` | `affdaed` |
| GitHub import | `createGithubClient` takes `token: string \| null` and omits the header entirely when null (`github-client.server.ts:114,127`); `importGithubSnapshot` (`org/store-files.server.ts:592`) goes anonymous with no connection, probes the repo endpoint to disambiguate a 404 on the tree (:683) | `881a4e1` |
| Run console | **NEW** folding helpers in `runs-helpers.ts` (:263-400) + `runs-panels.tsx`; raw toggle stays a no-op contract | `45ddb70` |
| MCP registry | stderr capture + `redactGitOutput`, `last_error` column, 20 s window + `installing` evidence, `org/mcp-warmup.server.ts` + `warming_since` + boot reap + 20 s settings poll | `8a5f782`, `101f72f`, `0cc9b55`, `88a17cc` |
| Image | uv/uvx; chromium + `VIBERR_BROWSER_EXECUTABLE`; prune flags; `--foreground-scripts` | `876aff0`, `308cbc3`, `a1ceb78`, `b97ad02` |
| **Browser capability** | **NEW** `use-browser` cap (default off), `tasks/specialist-browser-mcp.server.ts`, mount-is-enforcement on both backends, egress interlock via the P14-LV-09 pipe, `viberr_browser` reserved | `308cbc3` |
| **Attachments** | **NEW** `taskAttachmentsDir` (`file-store-root.server.ts:87`), `files/task-attachments.server.ts`, member-only `routes/task-attachment.ts`, `AttachmentsPanel`, evidence linkify (`timeline.tsx:111`) | `308cbc3` |
| Ops (pre-existing, undocumented) | `server/ops/` (build-info, disk-space, maintenance, transcript-retention); boot's `applyRetention` → `startStoreMaintenance` | pass-19 merge |
| CLI lock (pre-existing, undocumented) | `db/cli-lock.server.ts` — writing CLIs take the data-root lock; read-only CLIs deliberately do not; `db/backup.server.ts`, `files/store-check.server.ts` + 4 new scripts | pass-19 merge |
| Counts | `routes/` 35→**42**, `features/` 164→**176**, `server/` 251→**293**, `shared/` 29→**31**; `routes.ts` 52→**59**; `app.css` 3966→**4218** | — |

**Unchanged and re-verified line by line at `b97ad02`**: the layering rule, the
interpretation policy (§3), the SSE bus (§5, every anchor identical), the
data-root lock and its F18-5 guard (§7 — `:276` verifyLockOwnership, `:340`
acquire, `:439` interval, `:490` guard, `:520` stop), the single squashed
migration, and the watcher/single-flight throttles.

Note: `docker-data/**` and `.claude/worktrees/**` contain checkout copies of the
same tree — the canonical source is `app/` and `db/`.
