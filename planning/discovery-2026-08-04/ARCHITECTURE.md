# Viberr — Architecture reference

Written 2026-08-04 against `main` @ `2442945` (post-merge of the 2026-08-03 modernization,
PR #122). Self-contained: an implementation agent with no other context should be able to
navigate the codebase from this document alone. Every path is repo-relative from
`/Users/akinozer/projects/viberr`.

Companion documents in this same directory cover narrower slices in more depth:
`DOMAIN-MODEL.md`, `RBAC-GOVERNANCE.md`, `UI-INVENTORY.md`, `TESTING-INFRA.md`.

---

## 0. What Viberr is, in one paragraph

Viberr is a self-hosted, single-node project-management plane for AI-agent-orchestrated
software delivery. Business truth lives in **Markdown files on disk** (`project.md`,
`task.md`) that both humans and agents may edit directly; SQLite is a **derived
projection** that exists to make those files queryable. An "operator" agent coordinates
each task, dispatches specialist agents (developer/reviewer) into cloned git workspaces
via the Claude Agent SDK or the Codex SDK, and every governed mutation is RBAC-checked,
audited, and written back into the canonical file before it is re-projected and published
over SSE.

---

## 1. Stack and versions

| Layer | Choice | Version (`package.json`) |
| --- | --- | --- |
| Framework | React Router **framework mode**, SSR on | `react-router` / `@react-router/dev` / `@react-router/serve` `^8.3.0` |
| UI | React | `^19.2.8` |
| Bundler / dev server | Vite | `^8.2.0` |
| Language | TypeScript | `^7.0.2` (`strict`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noUnusedLocals/Parameters`) |
| Runtime | Node | `>=26` (`engines`), `.nvmrc`, `node:26-slim` image |
| Database | **`node:sqlite`** (`DatabaseSync`) — no third-party driver | built into Node 26 |
| Auth | `better-auth` | `1.6.25` (exact pin) |
| Validation | `zod` | `^4.4.3` |
| Watchers | `chokidar` | `5.0.0` (exact pin; new 2026-08-03) |
| Board drag | `@dnd-kit/react` + `@dnd-kit/dom` | `0.5.0` (exact pins; new 2026-08-03) |
| Comment composer | `lexical` + `@lexical/react` | `0.49.0` (exact pins; new 2026-08-03) |
| Agent runtimes | `@anthropic-ai/claude-agent-sdk` `^0.3.220`, `@openai/codex-sdk` `^0.146.0` | |
| Tests | `vitest` `^4.1.10` (node env), `@playwright/test` `^1.62.1`, `jsdom` `^30.0.1` | |

**There is no linter, formatter, Tailwind, or PostCSS config, and adding one is an
explicit non-goal** (`planning/planning-artifacts/architecture.md`, CI/CD decision). One
hand-written stylesheet: `app/app.css`. Conventions are enforced by typecheck, tests, and
a static stylesheet test (`app/app.css.test.ts`).

npm scripts (`package.json:8-17`):

```
dev        react-router dev
build      react-router build
start      react-router-serve ./build/server/index.js
typecheck  react-router typegen && tsc     # tsc is a REQUIRED gate; `build` is not a typecheck
test       vitest run
e2e        tsx scripts/e2e.ts              # boots a production-image compose stack
seed       tsx scripts/seed.ts             # clean-sheet product seed
seed:demo  tsx scripts/seed-demo.ts        # demo fixture (test/dev only)
rescan     tsx scripts/rescan.ts
```

---

## 2. Repo layout

```
viberr/
├── app/                     the application (see §2.1)
├── db/migrations/           0001_baseline.sql — the ONLY migration (squashed, §4.2)
├── scripts/                 seed.ts, seed-demo.ts, rescan.ts, e2e.ts, measure-routes.mjs,
│                            docker-entrypoint.sh
├── e2e/                     Playwright specs (01,05,06,07,08,09,10 + auth.setup.ts)
├── test-support/            fakes + harnesses shared by the unit suite; NOT shipped in the
│                            production image (demo fixture lives here)
├── design/                  the canonical HTML/JSX design mocks + PRD (§7.5)
├── docs/                    architecture/decisions.md, architecture/file-formats.md,
│                            operations/{deployment,runbook}.md, testing*.md,
│                            contributing-quickstart.md
├── qa/pass15/               per-use-case QA scripts from product pass 15
├── planning/                planning-artifacts/ (original PRD + architecture + UX spec)
│                            and one discovery-<date>-passN/ dir per product pass
├── data/                    default VIBERR_DATA_ROOT (stale; see §8.2 warning)
├── docker-data/             the data root the dev server and compose actually use
├── build/                   react-router build output (server + client)
├── public/                  favicon.svg only
├── .claude/                 launch.json (dev server), settings.local.json, skills/, worktrees/
├── compose.yml              production single-node stack
├── compose.e2e.yml          isolated production-image stack for the e2e suite
├── Dockerfile               two-stage; final stage runs react-router-serve as pid 1
├── .env / .env.example      runtime config (§8)
└── react-router.config.ts, vite.config.ts, vitest.config.ts, playwright.config.ts,
    tsconfig.json, doctor.config.ts
```

### 2.1 `app/` layout

```
app/
  root.tsx           document shell, root loader (theme/motion/csrf), middleware, ErrorBoundary
  routes.ts          the route table (explicit, not file-system routing)
  entry.server.tsx   awaits bootServer() at MODULE SCOPE; streaming render; handleError
  entry.client.tsx   hydrateRoot(document, <HydratedRouter/>) inside startTransition
  app.css            3419 lines — the entire design system, one file
  routes/            26 thin route modules (+ co-located route tests and one
                     project-visibility.server.ts helper)
  ui/                20 reusable primitives/hooks — MUST NOT import from features/
  lib/auth.server.ts the better-auth instance + Viberr bridge
  features/          16 product surfaces (activity, agents, board, github, home, kb-browser,
                     live-updates, notifications, org-settings, policy, profile,
                     project-settings, review, runtime, shell, task-detail)
  schemas/           Zod contracts: task-file, project-file, sse-event, github-pat,
                     file-diagnostics
  server/            server-only modules, 17 subdirectories (see below)
  shared/            client-safe cross-surface code: rbac.ts, capabilities.ts, freshness.ts,
                     auth/, dates/, ids/, mapping/, workflow/
```

`app/server/` subdirectories and their single responsibilities:

| Dir | Owns |
| --- | --- |
| `audit/` | `audit-recorder.server.ts` — the only writer of `audit_events` |
| `auth/` | csrf, login, identity, password hashing, OAuth provisioning, project authority, route guards, user store/admin, rate limits, seed admin |
| `config/` | `env.server.ts` — **the only place `process.env` is parsed** |
| `db/` | sqlite handle, migration runner, transaction helper, retention, data-root lock |
| `errors/` | `AppError` + stable machine codes |
| `events/` | sse-broker, event-publisher, projection-events (in-process emitter) |
| `files/` | data-root paths, the two watchers, atomic writes, per-file mutex, frontmatter, task/project/agent-profile readers + writers, KB/skill body injection |
| `github/` | client, repo access check, branch sync/cleanup, PR linker/open, reconciler + poller, workspace delivery, scope flags |
| `interpretation/` | readiness / diagnostics / freshness derivation policies |
| `logging/` | `logger.server.ts` + `request-context.server.ts` (AsyncLocalStorage correlation) |
| `org/` | org users, connections, resources (KB/skills/MCP), global agents, store files, org seed |
| `prefs/`, `theme/` | user prefs table; theme cookie |
| `projections/` | rebuilder, rescan, rebuild, board/task queries, activity feed, decisions, notifications, review queue, policy violations, agent deployments, single-flight |
| `provenance/` | the only reader/writer of the `provenance` table |
| `runtimes/` | Claude + Codex adapters, registry, run service/store/sink/events/projection/recovery, wire format, session export, model catalog |
| `secrets/` | AES-256-GCM secret box, PAT store + validator |
| `seed/` | product seed, agent catalog, shipped default agent assets |
| `tasks/` | the governed-mutation core (`task-actions.server.ts` is the largest module in the tree), operator actions/toolkit, agent toolkit, specialist run + MCP + tool policy, agent reply/outcome, comment guardrails, mentions, schedules, timeline compaction, git clone auth, workspace retention |

Naming conventions (`docs/architecture/decisions.md:24-48`): server-only files end in
`*.server.ts` and are never imported by client components; tests are co-located as
`foo.server.test.ts`; files/dirs kebab-case; no `utils.ts`/`helpers.ts` dumping grounds.
There is deliberately **no `app/features/auth/`** — sign-in is one route.

---

## 3. Server architecture (React Router v8, framework mode)

### 3.1 Config

`react-router.config.ts` is four lines of substance:

```ts
export default {
  ssr: true,
  future: { unstable_optimizeDeps: true },   // pre-crawl route modules at dev start
} satisfies Config;
```

`vite.config.ts` loads `.env` via `node:process.loadEnvFile()` (tolerating ENOENT),
resolves tsconfig `paths` natively (Vite 8 — the `vite-tsconfig-paths` plugin is gone), and
**excludes the whole data root from the dev watcher** (`vite.config.ts:16-32`): task
workspaces under the data root are full nested repo clones with their own `.git` and
`tsconfig.json`, which Vite would otherwise treat as app source (finding F10-36).

### 3.2 Route table

Routing is **explicit** in `app/routes.ts` — not file-system-convention routing. Path
segments map to `app/routes/<dotted-name>.tsx`:

```
/                                     routes/_index.tsx            home / project list
/login  /logout                       routes/login.tsx, logout.tsx
/api/auth/*                           routes/api.auth.$.ts         better-auth splat
/org/settings                         routes/org.settings.tsx      tabbed org admin
/profile  /notifications              PageOverlay routes
/notifications/read                   fetcher target, no UI
/prefs/theme                          fetcher target, no UI
/projects                             loader returns redirect("/") — home IS the
                                      project list; not a 404 (N5)
/projects/:slug                       routes/project.tsx           workspace shell (rail+topbar)
  index → board                       routes/project._index.tsx
  /board /review /agents /policy       the seven project views
  /github /activity /settings
  /tasks/:key                         routes/project.task.tsx      the deepest surface
/resources/events                     SSE stream
/resources/run-log                    run-log tail (seq-based)
/resources/health                     unauthenticated ops probe
/resources/search                     ⌘K palette query
/resources/model-catalog              model + effort catalog per backend
/resources/session-export             downloads a bash installer carrying a run transcript
```

`app/routes/*` modules are thin: they call guards, delegate to `app/features/<surface>/…`
for UI and to `app/server/…` for behavior. `resources.*` routes are **resource routes** —
loader (and sometimes action) only, no default export.

### 3.3 Loaders, actions, and the mutation contract

- Loaders return route-shaped data directly. JSON endpoints (rare, automation only) use
  `{ data, meta? }` on success and `{ error: { code, message, details? } }` on failure;
  route **actions are exempt** and return their own result shapes
  (`docs/architecture/decisions.md:49-72`).
- The canonical mutation shape is: **RBAC check → write the canonical file (atomic,
  frontmatter-preserving) → re-parse → re-project into SQLite → emit a projection event →
  SSE publish**. Never write a projection without file backing for task/project state
  (`docs/architecture/decisions.md:73-96`).
- **No optimistic UI for governed state.** Revalidate after the action and on SSE.
- Every governed action writes an audit event and, where user-visible, a typed timeline
  event inside `task.md`.
- The shared action preamble is `requireFormAction(request)`
  (`app/server/auth/form-action.server.ts:7-19`): it requires auth, opens the db, parses
  `formData`, asserts CSRF against the already-parsed form data, and returns
  `{ auth, db, formData, actor, intent }`. `appErrorResponse(error)` (`:21-27`) converts an
  `AppError` into `data({ ok: false, error: userMessage }, { status })`.

### 3.4 Middleware and request correlation

`app/root.tsx:55` exports `middleware = [requestContextMiddleware]`. It binds one
correlation id (AsyncLocalStorage, `app/server/logging/request-context.server.ts`) for the
whole request so every `logger.*` call from any loader/action carries it with no call-site
work. `entry.server.tsx:61` reuses that id for the document render rather than minting a
second one, and `handleError` (`entry.server.tsx:34-47`) swallows aborted requests and
route-not-found 404s (favicon probes, crawlers) while logging everything else through the
app logger.

`app/root.tsx:87-89` re-exports `headers({ loaderHeaders })` so the root loader's
`Set-Cookie` (better-auth rolling-session renewal) surfaces on routes that have no
`headers` export of their own — React Router uses the deepest one available.

### 3.5 Authentication (better-auth)

The instance is built in `app/lib/auth.server.ts` and cached process-wide keyed to the
current `DatabaseSync` handle (`:324-368`), so it rebuilds when tests reset the db
singleton.

Key configuration (`buildAuthOptions`, `app/lib/auth.server.ts:112-313`):

| Setting | Value | Note |
| --- | --- | --- |
| `basePath` | `/api/auth` (`AUTH_BASE_PATH`, `:35`) | mounted as a splat route |
| Cookie | `viberr.session_token` (`advanced.cookiePrefix: "viberr"`, `:312`) | signed with `BETTER_AUTH_SECRET ?? VIBERR_SESSION_SECRET` |
| Session | `expiresIn` 30 days, `updateAge` 1 day (`:247-250`) | rolling, server-side rows in SQLite |
| Sign-up | `disableSignUp: true` (`:146`) | **no open registration on any path** |
| Password hashing | routed through the app's own `hashPassword`/`verifyPassword` (`:159-162`) | makes verification TOTAL — a legacy/unparseable hash reads as a wrong password (401), not a 500 |
| better-auth rate limiting | `/sign-in/email` and `/sign-in/social` set to `false` (`:184-191`) | replaced by app-level per-`email\|ip` buckets in the `before` hook, because without a reverse proxy every sign-in shares one `no-trusted-ip` bucket = an org-wide denial-of-login lever |
| Account linking | enabled, trusted `github`/`google`/`credential` (`:263-266`) | preserves `user.id === users.id` |

**The `/api/auth/*` allow-list is a load-bearing invariant.** Because the handler is a
splat, *every* endpoint better-auth registers would otherwise be reachable — including
`/change-password`, `/update-user`, `/link-social`, `/list-accounts` — which would bypass
the app's own audited, session-revoking flows and split-brain the canonical `users` row.
`ALLOWED_AUTH_PATHS` (`app/lib/auth.server.ts:53-60`) enumerates the **driven** set, and
the `before` hook 404s everything else (`:218-220`):

```
/sign-in/email   /sign-in/social   /callback/:id   /error   /get-session   /sign-out
```

Entries are the endpoints' *declared* paths (params un-substituted, hence
`/callback/:id`). The hook pipeline also runs for server-side `auth.api.*` calls, which is
why `/get-session` and `/sign-out` must be listed.

OAuth is optional: the login buttons stay inert unless the provider env vars are set.
Provisioning is whitelist-based via `databaseHooks.user.create.before/after`
(`:271-311`) — a new social user is admitted only if `isOAuthWhitelisted` says so, and the
provider is read off the callback endpoint by `oauthProviderOf` (`:79-89`) rather than
guessed (P13-D-22: guessing let the Google-only domain allowlist admit GitHub sign-ins).

Request-side guards live in `app/server/auth/require-user.server.ts`:

- `authenticateWithHeaders(request)` → `{ ctx, renewalHeaders }` — used by the **root
  loader only**, so the rolling-session `Set-Cookie` actually reaches the browser (F10-17).
- `authenticate(request)` → `AuthContext | null` (drops renewal headers).
- `requireAuth(request)` → `AuthContext` or throws a redirect to `/login?returnTo=…`
  (the returnTo is normalized off React Router's `.data` single-fetch URL, `:128-146`).
- `requireProjectMember(request, slug, what)`
  (`app/server/auth/require-project.server.ts:20-45`) — wraps the canonical
  `assertProjectAction(db, "any-member", …)` and converts the `AppError` into a thrown
  `data(message, { status })` so a non-member sees a clean 403 page. Org admins pass as the
  audited D2 emergency override.
- A disabled or vanished user has their better-auth session row deleted and reads as
  signed out (`:88-91`).

### 3.6 CSRF (`_csrf` convention)

`app/server/auth/csrf.server.ts`. Two layers:

1. **Origin / `Sec-Fetch-Site` check** (`assertTrustedOrigin`, `:46-69`). Cross-site
   browser requests are rejected; requests carrying neither header (curl,
   server-to-server) pass — the token is the backstop for cookie-bearing browser requests.
2. **Double-submit token bound to the session**: `HMAC-SHA256(VIBERR_SESSION_SECRET,
   "viberr-csrf:" + sessionId)`, base64url (`csrfTokenForSession`, `:18-22`). Compared with
   `timingSafeEqual`.

Field name is the constant `CSRF_FIELD_NAME = "_csrf"` (`:15`). The token is produced by
the **root loader** (`app/root.tsx:73`) and consumed anywhere in the tree via
`<CsrfInput />` or `useCsrfToken()` (`app/ui/csrf-input.tsx`). Programmatic
`fetcher.submit` calls must set `_csrf` in the FormData (or send `X-Csrf-Token`, which
`assertCsrfWithSecret` checks first, `:81-88`).

**Every new mutating form needs `_csrf`.** The login action is the sole exception — it has
no session yet, so it uses `assertTrustedOrigin` plus rate limiting only. `/api/auth/*`
also has no `_csrf`: better-auth enforces its own Origin/`trustedOrigins` check
(`app/routes/api.auth.$.ts:4-10`).

### 3.7 SSE

Two endpoints and one broker.

**`GET /resources/events`** (`app/routes/resources.events.ts`) — the general stream.
Repeatable `scope` query params: `project:<slug>`, `task:<slug>/<key>`, `projects`
(all-projects firehose, used by Home), `user` (this session's targeted events + broadcasts).
Reconnect position comes from the native `Last-Event-ID` header. Auth is the session
cookie, but an unauthenticated EventSource cannot render a login page, so it returns plain
401 JSON (`:62-68`). `MAX_QUEUED_CHUNKS = 1024` bounds a stalled client (`:59`); past that,
enqueue throws and the broker drops the connection.

Note the correction recorded in the docblock (`:33-40`): per the HTML spec, an EventSource
that receives a non-200 **fails permanently and does not reconnect**, so recovery is the
client's job (see §7.6).

**`GET /resources/run-log`** (`app/routes/resources.run-log.ts`) — the seq-based tail the
agent-log console uses after a `run.log-appended` reference arrives. Params
`runId`, `since` | `before`, `limit` (clamped 1..500). Guarded by `requireUser` **and**
`requireProjectMember`.

**Broker** (`app/server/events/sse-broker.server.ts`):

| Fact | Value |
| --- | --- |
| Heartbeat | `": hb\n\n"` every `25_000` ms per connection (`:41`, `:172`) |
| Replay ring buffer | last `256` events with monotonic ids (`:42`) |
| Wire format | `id: <n>\nevent: <name>\ndata: <single-line JSON>\n\n` (`:167-169`) |
| Routing | exactly one of `userId` (that user's `user`-scoped conns), `broadcast`, or `projectSlug` (+optional `taskKey`) — `routeMatchesConnection`, `:85-108` |
| Stale reconnect | `Last-Event-ID` older than the buffer window → `stream.resync` control event, client revalidates once |
| Singleton | `Symbol.for("viberr.sseBroker")` on `globalThis` (HMR-safe) |

**The broker also owns the process's only signal handler** (`:152-160`). `SIGINT`/`SIGTERM`
run `runProcessShutdown()` — close connections, stop both watchers, checkpoint + close
SQLite, release the data-root writer lock — then re-raise the signal. Skipped when
`NODE_ENV === "test"`.

Two publish paths:

- **Projection events** (`app/server/events/event-publisher.server.ts`) — the emitter in
  `projection-events.server.ts` receives every mutation (task actions, watcher rebuilds,
  rescan, notification fan-out, scope violations), and `translateProjectionEvent` converts
  each into the SSE shape `{ type, entityId, occurredAt, data }` plus a route.
- **Direct-to-broker**, deliberately bypassing the emitter, for high-frequency streams:
  `run.log-appended` and `run.state-changed` (`app/server/runtimes/run-events.server.ts:4-10`).
  Routing chatty events through the emitter would imply a projection rebuild per event.

SSE payloads are **compact facts and references, never fat objects**, and the wire shape is
parsed against `app/schemas/sse-event.schema.ts` before publish because it is a contract.

---

## 4. Data layer

### 4.1 SQLite via `node:sqlite`

There is **no third-party SQLite driver** — the app uses Node 26's built-in
`DatabaseSync`. `app/server/db/sqlite.server.ts`:

```ts
// openDatabase(), :12-19
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;`);
```

- Path: `${VIBERR_DATA_ROOT}/state/projection.sqlite` (`getProjectionDbPath`, `:22-25`).
- `getDb()` (`:35-53`) is a process-wide singleton cached on
  `Symbol.for("viberr.db")` so it survives HMR module reloads; on first open it applies
  pending migrations and logs `sqlite ready`.
- `shutdownDatabase()` (`:84-106`) is the graceful path: `PRAGMA wal_checkpoint(TRUNCATE)`
  then close. The docblock (`:66-83`) records why: an exited container was observed leaving
  a 4.1 MB `projection.sqlite-wal` beside a stale main file, proving the close never
  happened — and this database is **primary storage** for users, sessions, PATs, audit and
  notifications, rows no rescan can rebuild.
- `withTransaction(db, fn)` in `app/server/db/transaction.server.ts` is the transaction
  helper; migrations use it.

### 4.2 Migrations — squashed into `0001` (owner ruling, pre-prod)

`db/migrations/` contains exactly one file: `0001_baseline.sql` (360 lines). Its header
(`:1-20`) is the binding convention:

> Collapses the original 13-file migration history … We are pre-prod: no deployed database
> needs the incremental chain … **while pre-prod, schema changes are squashed INTO this
> baseline — no incremental migration chain is kept.** The runner records this filename in
> `schema_migrations` and skips by FILENAME alone, so editing this file reaches FRESH
> databases only: an existing DB keeps its old schema and every projection write touching a
> new column throws (there is no drift healer). That is accepted: … after pulling a
> baseline change, wipe the sqlite and re-seed (`npm run seed -- --reset`). **Because
> users/auth live in the same file, a wipe regenerates user ids.** Revisit this convention
> at the first real deployment.

**Implication for an implementer: if you add a column, edit `0001_baseline.sql` in place,
then wipe and re-seed your local DB. Do not add `0002_*.sql`** until the owner lifts this
ruling at first deployment. Practical consequence: a running dev DB created before your
edit will throw on the first write to the new column, and a re-baseline invalidates every
existing user id (sessions, PATs, run history keyed to users all reset).

`runMigrations` (`app/server/db/migration-runner.server.ts:28-81`) applies every `*.sql` in
`db/migrations/` in filename order, each inside its own transaction together with its
`schema_migrations` bookkeeping row. Migration files must not contain `BEGIN`/`COMMIT`. A
failure raises `AppError` with `ERROR_CODES.DB_MIGRATION_FAILED`. `DEFAULT_MIGRATIONS_DIR`
resolves against `process.cwd()` (`:9-12`) — which is why the Dockerfile copies `db/` into
the runtime stage.

### 4.3 Tables

23 tables. Grouped by role:

| Group | Tables |
| --- | --- |
| **Primary storage** (no rescan can rebuild these) | `users`, `user` / `session` / `account` / `verification` (better-auth's own, lowercase singular, camelCase columns — created verbatim by better-auth's generator), `github_pats`, `project_github_credentials`, `github_connections`, `google_domain_allowlist`, `user_prefs`, `audit_events`, `notifications`, `org_knowledge_bases`, `org_mcp_servers`, `org_skills`, `agent_runs`, `run_log_lines`, `staged_outcomes` |
| **Derived projections** (rebuildable from files) | `projects`, `project_members`, `task_projections`, `task_events`, `diagnostics`, `provenance`, `scope_violations` |

Naming: plural snake_case tables, snake_case columns, `<entity>_id` FKs,
`idx_<table>__<cols>` indexes. Rows map to camelCase **only** through
`app/shared/mapping/*` — never ad hoc at a call site
(`docs/architecture/decisions.md:49-72`).

Three indexes are load-bearing invariants rather than performance tuning:

```sql
-- db/migrations/0001_baseline.sql:341-343 — one delivering agent per task
CREATE UNIQUE INDEX idx_agent_runs__one_delivering ON agent_runs (project_slug, task_key)
  WHERE kind = 'primary' AND state IN ('queued','running');
-- :331-332 — thread uniqueness (a resume mints a fresh thread id)
CREATE UNIQUE INDEX idx_agent_runs__thread ON agent_runs (project_slug, task_key, thread_id);
-- :344 — dense per-run log sequence
CREATE UNIQUE INDEX idx_run_log_lines__run_seq ON run_log_lines (run_id, seq);
```

`startRun` catches SQLite errcode `2067` (CONSTRAINT_UNIQUE) on the first and turns it into
a 409 (`app/server/runtimes/run-service.server.ts:336-350`).

Bounded growth: `applyRetention(db)` (`app/server/db/retention.server.ts`) compacts the
high-volume log/audit/notification tables at boot (F10-29). Canonical task files are never
touched.

### 4.4 `VIBERR_DATA_ROOT` and the file-native store

`app/server/files/file-store-root.server.ts` is the single source of data-root paths.
`getDataRoot(dataRoot?)` resolves `dataRoot ?? getEnv().VIBERR_DATA_ROOT` to an absolute
path (`:40-42`); every helper accepts an optional override so tests and scripts can point
at a temp root.

`DATA_ROOT_SUBDIRS` (`:23-37`), all created at boot by `ensureDataRootDirs()`:

```
${VIBERR_DATA_ROOT}/
├── projects/<slug>/project.md
├── projects/<slug>/tasks/<KEY>/task.md      (+ attachments/, workspace/ clone)
├── agents/profiles/<id>.md                  org-level agent profile templates
├── runtimes/                                NDJSON run logs: <backend>/<runId>.jsonl
├── runtimes/claude-home/                    CLAUDE_CONFIG_DIR (sessions + transcripts)
├── runtimes/codex-home/                     CODEX_HOME (auth.json + sessions/)
├── kb/<dir>/                                knowledge bases  (store://kb/<dir>/)
├── skills/<name>/SKILL.md                   skills           (store://skills/<name>/)
└── state/projection.sqlite                  SQLite (+ -wal, -shm)
    state/writer.lock                        the single-writer lock (§4.6)
```

UI copy renders **real store-relative paths** (`projects/viberr-core/tasks/VIB-142/task.md`),
never a `.viberr/…` fiction — `storeRelativePath()` (`:154-157`).

**Path-traversal containment**: `resolveStoreSegment(root, name)` (`:108-127`) rejects
separators, dot-segments, absolute paths and NUL before joining, because a KB/skill name
comes from a profile's resource array and the resolved content is injected as **trusted
persona material** — crossing a prompt trust boundary. `kbDirPath`, `skillDirPath` and
`agentProfileFilePath` all route through it. Injection readers catch the throw and degrade
to "inject nothing" while logging the denial.

**Atomic writes**: `writeFileAtomic` (`app/server/files/atomic-file.server.ts:10-15`)
writes `<target>.<8 hex>.tmp` then renames over the target, so readers and the watcher never
see a half-written file. The watcher explicitly ignores `*.tmp`. Per-file serialization is
`app/server/files/file-mutex.server.ts`.

Canonical file formats are documented in `docs/architecture/file-formats.md` (project.md,
task.md frontmatter + Goal + Packet + Timeline grammar, actor references
`user:<id>` / `agent:<backend>/<role>`, agent-profile templates, and §5 "what is
deliberately NOT in files"). The Zod contracts are `app/schemas/task-file.schema.ts` (the
largest) and `app/schemas/project-file.schema.ts`.

**Tolerant parsing is a contract** (`app/schemas/task-file.schema.ts:11-21`): unknown
frontmatter fields are *preserved* and re-written verbatim by the serializer; missing or
invalid fields produce structured `FileDiagnostic`s plus a readiness downgrade
(`input_required` / `inconsistency_risk_detected` / `blocked`); the parser never throws and
never drops a task.

### 4.5 Projection rebuild

`app/server/projections/rebuilder.server.ts` (docblock `:34-46`):

- `rebuildAll` — full rescan of `${dataRoot}/projects`, projecting every `project.md` and
  `tasks/<KEY>/task.md`, pruning rows whose files vanished.
- `rebuildPath` — single-file incremental, driven by the file watcher **and by every
  mutation** ("write file → reproject").
- **Content-hash short-circuit**: an unchanged file is not re-projected and records no
  provenance.
- Every acting rebuild records provenance (`projected`/`removed`/`error`); a full rescan
  adds one summary `rescan` row.
- Emits change events through the in-process projection emitter, which the SSE publisher
  subscribes to.

`rescanProjections` (`app/server/projections/rescan.server.ts`) is the entry point used at
boot, by `npm run rescan`, and by the Home/Board "Re-scan" buttons.

### 4.6 The single-writer constraint (B-FD1) — **ONE app process per data root, EVER**

This is the most important operational invariant in the repo, and it is now *enforced*
rather than remembered. `app/server/db/data-root-lock.server.ts:9-37`:

> Two processes pointed at one root is not a slow path, it is corruption: it has bitten this
> project twice — a host dev server and a compose container sharing `docker-data` over
> VirtioFS clobbered the WAL and ate PATs and run logs, and the run pipeline's
> handles/completion callbacks are per-process globals, so process B "interrupts" a run that
> process A is still driving and A overwrites the state at finalize.

Mechanism:

- Boot takes an exclusive `O_EXCL` lock file at `<dataRoot>/state/writer.lock`
  (`DATA_ROOT_LOCK_FILENAME`, `:40`) whose content is `{ pid, hostname, startedAt, bootId }`.
- `takeDataRootWriterLock(env)` (`app/server/boot.server.ts:150-169`) runs **before anything
  opens the database or writes a file** (`boot.server.ts:198-204`). On a
  `DataRootLockedError` it prints the refusal to stderr and `process.exit(1)` — a refusal to
  boot, not a crash, because `bootServer` is awaited from `entry.server.tsx` module scope
  and an escaping throw would surface as an SSR crash page instead of the one message that
  diagnoses the problem.
- Staleness is decided by **evidence, never a timeout** (`classifyLock`, `:194-206`):
  same-host + pid gone → stale, auto-taken-over; same-host + pid alive → held, refuse;
  **different host → refuse** (cannot probe — this is exactly the docker-data incident
  shape); unreadable lock → refuse.
- `bootId` is a per-OS-process UUID kept on `globalThis` (`:130-139`). It exists because
  `compose.yml` pins `hostname: viberr`, which makes "same host" trivially true for every
  container from that file, and two containers over one data root routinely land on the
  same low pid — without the discriminator the self-reclaim branch would hand a *live*
  holder's lock to a second writer.
- Release happens on `process.once("exit")` **and** explicitly in the signal shutdown
  before the re-raise (`releaseDataRootLock`, `:154-156`) — the `exit` event never fires
  when the handler re-raises SIGTERM.
- Escape hatch: `VIBERR_FORCE_DATA_ROOT_LOCK=1` for one boot.

**Practical rule for agents working in this repo: a dev server is usually already running
against `docker-data`. Do not start a second one, and do not run `npm run seed`/`rescan`
against a data root a live process holds.**

---

## 5. Background machinery and the boot sequence

Everything starts from `bootServer()` (`app/server/boot.server.ts:179-311`), awaited at
`app/entry.server.tsx:21` **module scope**, guarded by `Symbol.for("viberr.booted")` so it
runs once per process and survives HMR.

Ordered sequence (line numbers in `boot.server.ts`):

| # | Step | Line |
| --- | --- | --- |
| 1 | `getEnv()` — parse + validate env, fail fast | `183` |
| 2 | Warn if OAuth configured without `BETTER_AUTH_URL` | `189-196` |
| 3 | `ensureDataRootDirs()` | `198` |
| 4 | **`takeDataRootWriterLock(env)`** — before any db open or file write | `204` |
| 5 | `armProcessShutdown()` — register the SIGINT/SIGTERM handler that releases it | `209` |
| 6 | `seedDefaultAgentAssets()` — ship default agent skills/definitions into an empty store | `214` |
| 7 | `getDb()` — open sqlite, run migrations | `215` |
| 8 | `seedInitialAdmin(db, …)` — only when `users` is empty | `217-220` |
| 9 | `startEventPublisher()` — projection emitter → SSE broker, **first**, so later steps reach clients | `224` |
| 10 | `rescanProjections(db)` — reconcile drift from edits made while down (hash short-circuit) | `231` |
| 11 | `ensureBaseAgentsDeployed(db)` — preinstall operator + Developer + Reviewer into every project | `248` |
| 12 | **`startFileWatcher()`** — store watcher | `257` |
| 13 | **`startKbWatcher()`** — KB watcher | `261` |
| 14 | `finalizeOrphanedRuns(db)` — `running`/`queued` rows have no live process in a fresh boot → `error` + re-coordinate | `268` |
| 15 | `applyRetention(db)` — bounded log/audit/notification compaction | `279` |
| 16 | `void reconcileRestartedWork(db)` — fire-and-forget recovery chain (below) | `288` |
| 17 | `startScheduleRunner(db)` | `294` |
| 18 | `startGithubReconcilePoller(db)` | `300` |
| 19 | `logBootIntegrity(db)` — dirs, migration state, projection counts | `302` |

`reconcileRestartedWork(db)` (`:97-125`) is one ordered, self-catching chain — each step
idempotent, one failure never stopping the next, none blocking boot:

1. `recoverUnreactedAgentRuns(db)` — a specialist/reviewer run that finished before its
   in-process reply callback fired left the task at `waiting=agent` with no error. Post the
   reply and re-invoke the operator.
2. `recoverStrandedOperatorPlans(db)` — a Codex operator coordinates *after* its run
   finishes, so a restart loses the whole turn.
3. `reclaimTerminalTaskWorkspaces(db)` — each task that ever ran a specialist holds an
   11–16 MB working tree; the clone is a cache (canonical state is `task.md`, delivered work
   is on the remote) and a reopened task re-clones. **Sequenced after the recovery steps**
   (P14-RT-09) so a recovered run's delivery reconcile cannot race the `rmSync`.

### 5.1 Store watcher — `app/server/files/file-watch.service.server.ts`

Watches `${dataRoot}/projects` with **chokidar 5** (replaced raw recursive `node:fs.watch`
on 2026-08-03). Chokidar supplies typed `add`/`change`/`unlink`/`unlinkDir` events with
real paths (no rename inference), atomic-write coalescing, and portable recursion;
everything domain — debounce, ignore rules, rebuilds, removal reconciliation, lifecycle —
stays Viberr code (`:10-30`).

| Fact | Value |
| --- | --- |
| Debounce | `WATCH_DEBOUNCE_MS = 250` trailing, **per path** (`:32`) |
| Options | `{ ignoreInitial: true, ignored: shouldIgnoreWatchPath, followSymlinks: false, atomic: true }` (`:223-228`) |
| Ignored | dotfiles, `*.tmp`, and anything deeper than `projects/<slug>/tasks/<KEY>/task.md` (`:77-85`) — this prunes traversal so the watcher never enters workspace clones (F-SPAWN1) |
| Handled files | only basenames `project.md` and `task.md` (`:215-221`) |
| Dir removal | `unlinkDir` maps onto the projection rows it backed — project dir / `tasks` dir → reconcile the whole project; `tasks/<KEY>` → reproject that task; deeper → ignored; the projects root itself → reconcile every projected project (`:147-210`) |
| Singleton | `Symbol.for("viberr.fileWatcher")` — HMR reuses the running watcher |
| Health | `isFileWatcherAlive()` (`:301-304`) backs `/resources/health` `watcher` |
| Error policy | `ENOENT` is **not** fatal (deleting a watched subtree races chokidar into a spurious ENOENT while the unlink reconcile is still queued — killing the watcher there orphaned projections). Other errors clear the handle so health reports the truth, then re-arm after 2 s for transient FS pressure (`EMFILE`/`ENFILE`/`ENOSPC`/`EPERM`/`EACCES`) with an **owned, generation-guarded** timer so teardown can cancel it (F10-08) (`:237-290`) |

`ignoreInitial: true` pairs with the boot rescan (step 10): offline drift is reconciled
before the watcher starts. Chokidar arms asynchronously, so an external edit landing inside
the sub-second initial-scan window is picked up on its next touch or a manual rescan; route
actions project synchronously and never depend on the watcher.

### 5.2 KB watcher — `app/server/files/kb-watch.service.server.ts`

Same shape, watching `${dataRoot}/kb`. Debounce `KB_WATCH_DEBOUNCE_MS = 250` **per KB
directory** (`:31`); the changed path's first segment under `kb/` names the KB to re-index
(`kbDirOfChange`, `:42-49`); handles `add`/`change`/`unlink`/`addDir`/`unlinkDir`;
dispatches `reindexKnowledgeBaseByDir` (a KB pinned to "manual" is skipped inside that
function). Returns `null` and does not start if `${dataRoot}/kb` does not exist (`:65`).
Same ENOENT tolerance, handle-clearing and 1 s transient re-arm; `isKbWatcherAlive()`
backs `/resources/health` `kbWatcher`.

### 5.3 Schedule runner — `app/server/tasks/schedule.server.ts`

Fires due scheduled operator re-runs ("re-check this in 24h"). `SCHEDULE_TICK_MS = 60_000`
(`:39`): once at boot (catching anything that came due while down), then every minute. The
timer is `unref`'d so it never blocks exit. It calls `runOperator`, which is
backend-agnostic — so this works identically for Claude and Codex with no per-backend agent
tool (the parity-correct form, vs the Claude-only Cron tool). The schedule lives in the task
**file** (canonical, survives rebuild); `schedules_json` on the projection lets the runner
find due entries without reading every file. Crash-safety: an occurrence is CLAIMED in the
file (`pending → claimed`) before `runOperator` is invoked and finalized to `fired` only
once the enqueue returned (`:22-37`).

### 5.4 GitHub reconcile poller — `app/server/github/reconcile-poller.server.ts`

`RECONCILE_POLL_MS = 5 * 60_000` (`:22`) — every active (non-archived) project that has task
branches, once at boot then every 5 minutes, so a PR merged/closed out-of-band surfaces
automatically instead of only when a maintainer clicks "Update status". Poller ticks
suppress the per-project summary audit (`skipProjectAudit`) to avoid log spam; per-task
divergence events still fire. Best-effort per project — one project's GitHub failure never
aborts the others. It also runs `nudgeMergePendingTasks` (F12-05, `:39-86`): a task accepted
into Done whose PR is still open gets one deduped notification, because `merge-pull-request`
is always-human and an autonomous operator's self-acceptance cannot merge.

### 5.5 Shutdown

`runProcessShutdown()` (in `sse-broker.server.ts`, armed by
`armProcessShutdown()` at `boot.server.ts:209`) closes SSE connections, calls
`stopFileWatcher()` and `stopKbWatcher()`, `shutdownDatabase()` (WAL TRUNCATE checkpoint +
close), and `releaseDataRootLock()` — then re-raises the signal. The Dockerfile runs the
server binary directly rather than `npm run start` specifically so node is pid 1 and the
SIGTERM reaches it (`Dockerfile:75-81`).

---

## 6. Runtime adapters (Claude / Codex)

### 6.1 The adapter interface

`app/server/runtimes/adapter.server.ts:111-115`:

```ts
export interface RuntimeAdapter {
  readonly backend: RunBackend;            // "claude" | "codex"
  start(spec: RunSpec, cb: RunCallbacks): RunHandle;
}
```

- `RunSpec` (`:13-71`): `runId, projectSlug, taskKey, threadId, role, kind, backend, model,
  effort?, prompt, workdir, resumeSessionId?, autonomous?, systemPrompt?, mcpServers?,
  allowedTools?, disallowedTools?, repoWriteWithheld?, webSearchWithheld?, outputSchema?,
  env?`.
- `RunExit` (`:86-93`): `{ outcome: "finished"|"error"|"interrupted", effectiveBackend,
  sessionId? }`. **Outcome comes from the stream, never an exit code** (`:85`).
- `RunHandle` (`:104-109`): `{ runId, interrupt() }`, idempotent.

There is no dynamic registry map — adapters are a two-field struct
`AdapterSet { claude, codex }` built once per process by `createAdapters()`
(`app/server/runtimes/runtime-registry.server.ts:268-319`) and cached on
`Symbol.for("viberr.runService")` (`run-service.server.ts:88-98`). `selectAdapter(backend)`
(`runtime-registry.server.ts:342-351`) returns `{kind:"real"}` or `{kind:"unavailable"}`;
`isBackendAvailable` (`:147-157`) is an **env-presence probe only** — it never makes a paid
call to detect availability, and an expired token still reads "real".

`RunKind` = `operator | primary | reviewer`; `RunState` = `queued | running | finished |
error | interrupted` (CHECK constraints at `db/migrations/0001_baseline.sql:262`, `:267-268`).

### 6.2 Claude — SDK, and the env-REPLACE fact

`@anthropic-ai/claude-agent-sdk`'s `query()`, lazily imported and cached
(`claude-runtime.server.ts:267-275`). The prompt is fed as a streaming-input async iterable
of one `SDKUserMessage` purely so `Query.interrupt()` is available (`:22-25`).

**The SDK's `env` option REPLACES the child process environment — it does not merge.**
`runtime-registry.server.ts:241-254`:

> The SDK REPLACES the child `claude` process env with the `env` we pass — verified in the
> bundled sdk.mjs (`env = options.env` when provided; only a default `{...process.env}` when
> omitted). So filtering here is REAL: the spawned agent never sees a variable we drop.

The same is true of `@openai/codex-sdk` (`envOverride` replaces wholesale). Practical
consequence: the env you pass must be *complete* — `codex-runtime.server.ts:463-485`
explicitly notes that overlaying `spec.env` on `{}` would strip `PATH`/`HOME` and break the
spawned binary.

Env construction: `filteredSpawnEnv()` (`runtime-registry.server.ts:204-213`) starts from
`process.env` and drops everything matching `CREDENTIAL_ENV_RE`
(`/(?:^|_)(?:API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIALS?|AUTH)(?:_|$)/i`)
or `PRIVATE_RUNTIME_ENV_RE` (`DATABASE_URL|REDIS_URL|SSH_AUTH_SOCK|GPG_AGENT_INFO`), then
`claudeSpawnEnv()` re-adds only `CLAUDE_CONFIG_DIR` + the selected credential. Before F10-02
the raw `process.env` was spread through and leaked session secrets, the encryption key, the
GitHub PAT and every provider key to the agent. The same regex is reused as the *output*
redactor in `run-sink.server.ts:117-132`.

| Concern | Where |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | one resolver, `claude-config.server.ts:25-32`: explicit env wins → `VIBERR_CLAUDE_USE_CLI_AUTH` → `~/.claude` → else `${VIBERR_DATA_ROOT}/runtimes/claude-home` |
| Resume | `options.resume = spec.resumeSessionId` (`claude-runtime.server.ts:539`); session id captured from `system·init` facts |
| Tool confinement | `disallowedTools` is the real mechanism (`:569-586`) = `BASE_DENIED_BUILTINS` + kind-specific sets + `spec.disallowedTools`. `allowedTools` only skips the permission prompt — it does **not** remove tools from context (`:52-55`) |
| Isolation | `settingSources: []`, `skills: []`, `plugins: []` (`:535-537`). Note `skills: []` does *not* empty the skill set — the SDK compiles ~16 first-party skills into its binary and still exposes the `Skill` tool, which is why `Skill` is denied (`:526-534`) |
| Permission mode | `bypassPermissions` when `spec.autonomous`, else `"default"` (`:513`) — deny still binds under bypass |
| Turn cap | `DEFAULT_CLAUDE_MAX_TURNS = 2000`, `VIBERR_CLAUDE_MAX_TURNS` (`:329-334`). A runaway guard, not a work budget — the old hard-coded 50 killed a finished implementation at turn 51 |
| Idle timeout | 15 min default, `VIBERR_CLAUDE_IDLE_TIMEOUT_MS` (`:150-155`); on fire → `queryHandle.interrupt()` → `run·error·idle_timeout` |
| Error handling | `classifyClaudeError` (`:336-390`) → `quota|auth|session_missing|unknown`; raw error text is never persisted, only the class rides the tag |

### 6.3 Codex — SDK, CODEX_HOME, and the confinement asymmetry

`@openai/codex-sdk`: `new Codex(opts)` → `startThread(...)` / `resumeThread(id, ...)` →
`thread.runStreamed(prompt, { signal, outputSchema? })` → `for await (event of events)`
(`codex-runtime.server.ts:487-542`).

Two distinct directories (`codex-config.server.ts`):

- `resolveCodexAuthSource(env)` (`:50-54`) = `CODEX_HOME || ~/.codex` — the **human's** login dir.
- `resolveCodexHome(env)` (`:62-68`) = `${VIBERR_DATA_ROOT}/runtimes/codex-home` — the
  **app-owned run home**.
- `prepareCodexHome(env)` (`:116-166`) mirrors `auth.json` into the run home (symlink
  preferred, copy fallback, refresh on newer mtime), only in `VIBERR_CODEX_USE_CLI_AUTH`
  mode, never throwing. Called **per run** from `selectAdapter` (P14-RT-05).

The dedicated home exists because the Codex CLI merges `--config` overrides *into*
`$CODEX_HOME/config.toml` per dotted leaf key, so config alone cannot remove the host's MCP
servers, skills, plugins or `AGENTS.md` (`codex-config.server.ts:17-45`). Historically this
bit the project: **Codex inherited the host's skills and MCP servers**.

Auth precedence (`runtime-registry.server.ts:272-288`): `CODEX_ACCESS_TOKEN` (ChatGPT
workspace subscription) or a cached CLI login **wins over** `CODEX_API_KEY`/`OPENAI_API_KEY`,
so a subscription run cannot silently fall through to usage-based Platform billing;
`codexSpawnEnv` deletes the API keys when a token/cached login is in play.

Per-run hardening (`codexConfigForRun`, `:189-253`): `allow_login_shell:false`,
`project_doc_max_bytes:0` (the repo's `AGENTS.md` is a prompt-injection ingress with no
Claude counterpart), `skills.include_instructions:false` + `skills.bundled.enabled:false`,
`features.{apps,plugins,hooks}:false`, `memories:*false`,
`shell_environment_policy.inherit:"core"` with only `GIT_CEILING_DIRECTORIES` and the four
`GIT_AUTHOR_*/GIT_COMMITTER_*` vars exported.

**Codex has no tool denylist channel.** `allowedTools`/`disallowedTools` are Claude-only
(`adapter.server.ts:44-49`, `run-service.server.ts:224-226`). Compensations derived from the
denylist:

- `repoWriteWithheld` → read-only sandbox — "a physical block, strictly stronger than
  Claude's tool denylist" (P13-RT-02, `adapter.server.ts:50-55`).
- `webSearchWithheld` → `webSearchMode: "disabled"` (P14-RT-06).

Two further documented, accepted limitations: a credentialed org MCP authenticates on
Claude runs only (the Codex SDK passes config as `--config key=value` argv, visible in
`ps auxww`), and the Codex CLI lowercases hyphens to underscores in MCP tool names
(`mcp__everything-http__echo` vs `mcp__everything_http__echo`) — the transform is inside the
binary and nothing here can fix it (`codex-runtime.server.ts:69-96`).

Codex has **no max-turns equivalent**; only the idle timeout (15 min default,
`VIBERR_CODEX_IDLE_TIMEOUT_MS`) prevents a run staying `running` forever, because Codex only
settles on `turn.completed` (`:391-397`).

### 6.4 Where run logs and transcripts land

| Artifact | Path |
| --- | --- |
| **Run log (NDJSON)** | `${VIBERR_DATA_ROOT}/runtimes/<backend>/<runId>.jsonl` — `rawLogPath` (`run-store.server.ts:360-366`), appended one JSON object per line by `appendRawLine` (`:369-378`) |
| **Claude transcript** | `$CLAUDE_CONFIG_DIR/projects/<cwd with non-alnum → dashes>/<sessionId>.jsonl` |
| **Codex transcript** | `<codex run home>/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl` |

(`session-export.server.ts:13-14`; located by session id rather than by reproducing the cwd
encoding.) `/resources/session-export` packages a transcript into a bash installer so a
conversation can be resumed locally on the same subscription.

**Log line sequencing.** `run_log_lines(run_id, seq, …)` with `seq` dense from 0 per run
(`nextSeq = MAX(seq)+1 || 0`, `run-store.server.ts:222-227`), inserted `ON CONFLICT DO
NOTHING`. Forward tail: `seq > since ORDER BY seq ASC`. Backward page: `seq < before ORDER BY
seq DESC LIMIT n` then reversed. Default page `RUN_LOG_PAGE_LINES = 200`; the endpoint clamps
`limit` to 500; the task loader's window budget is `RUN_LOG_WINDOW_LINES = 400` /
`RUN_LOG_WINDOW_BYTES = 384 KiB` (`run-projection.server.ts:61-62`).

**Sink ordering matters** (`run-sink.server.ts:248-309`): (0) redact both `raw` and
`display` through a per-run redactor built from this process's credential-shaped env values,
(1) append to the `.jsonl`, (2) insert the DB row *only when `display` is non-null*, (3)
patch the run row (session/turns/usage/cost), (4) publish `run.log-appended`. **Persist
before publish**, so a client that reacts to the event can always fetch the line it
references (`:63-64`). If a persist fails, `markDivergent` writes one `run·line_lost` line to
both sinks so a truncated console announces itself.

### 6.5 Run lifecycle

- **Single-flight** is three separate mechanisms: the partial unique index for the
  delivering agent (409 on conflict), the thread-uniqueness index (a resume mints
  `<thread>-r<6>`), and a **process-level operator lease**
  (`operator-run.server.ts:181-204`, `Symbol.for("viberr.operatorLease")`) keyed
  `<slug>/<key>`, whose entry object *is* the release token. Trigger coalescing:
  machine triggers newest-wins, human `@operator` comments queued oldest-first capped at 8.
- Live `RunHandle`s live in an in-process `Map` — **completion callbacks are lost on
  restart**, which is exactly what the boot recovery chain (§5) compensates for.
- Interrupt (`interruptRun`) requires admin|maintainer, is idempotent on an already-terminal
  run, and audits `runtime.run.interrupted`.
- First-terminal-wins: an already-terminal run is never demoted and `finishedAt` is not
  restamped (B-FD7, `run-sink.server.ts:28-33`).
- An unavailable backend does **not** fabricate a run: `failRunUnavailable` opens a real
  sink, marks running, writes one server-authored `run·unavailable` error line, and
  finalizes — so completion callbacks and escalation paths behave identically.

---

## 7. Frontend

### 7.1 Entry points and the document shell

- `app/entry.client.tsx` — `hydrateRoot(document, <StrictMode><HydratedRouter/></StrictMode>)`
  inside `startTransition`.
- `app/entry.server.tsx` — `await bootServer()` at module scope, then a
  `renderToPipeableStream` document render with `streamTimeout = 5_000` (+1 s abort margin).
- `app/root.tsx` — the `<html>` shell. The root loader returns `{ theme, motion, csrf }`
  (`:57-83`). `<html data-theme data-motion suppressHydrationWarning>` (`:124-129`); a
  pre-paint inline script (`themeBootScript`, `:102-113`) reads the `viberr_theme` cookie as
  **authoritative** and resolves `system` against `prefers-color-scheme` before first paint —
  which is what keeps the ErrorBoundary page (where loader data may be missing) from flashing
  light in a dark session (F3). A post-hydration effect (`:155-166`) keeps it in sync and
  live-follows the OS. `<App>` mounts `ToastProvider` + `RoutePendingBar` + `Outlet`.

### 7.2 `app/features/` — 16 surfaces

Convention: `*-page.tsx` is the presentational tree taking props; `*.server.ts` holds
loader/action helpers; feature components never import server modules.

| Feature | Main files | Role |
| --- | --- | --- |
| `shell` | `rail.tsx`, `topbar.tsx`, `command-palette.tsx`, `top-bell.tsx`, `user-menu.tsx`, `route-pending-bar.tsx`, `nav.ts` | 232 px rail (frozen 7-item nav), topbar with crumbs / ⌘K / bell / account, global route-pending bar (220 ms delay, deliberately **excludes** SSE revalidation) |
| `board` | `board-page.tsx` (~1300 lines), `board-dnd.ts`, `board-filters.ts` | Kanban over task projections; dnd-kit stage moves; URL-param filter/view/search |
| `task-detail` | `task-detail-page.tsx` (~1760), `timeline.tsx`, `comment-composer.tsx`, `lexical-mention-plugin.tsx`, `mention-menu.tsx`, `decision-packet.tsx`, `execution-profile.tsx`, `operator-recommendations.tsx` | The operator workspace. Fixed layout order: hero → live run strip → decision packet → execution profile → agent logs → timeline |
| `live-updates` | `use-live-updates.ts`, `event-types.ts` | SSE → route revalidation (§7.6) |
| `runtime` | `runs-panels.tsx`, `use-run-log-stream.ts`, `log-clock.ts`, `runtime-types.ts` | Live run strip + streamed log console (its **own** EventSource) |
| `activity` | `activity-page.tsx`, `feed-helpers.ts` | Per-project audit/activity stream, day-grouped |
| `notifications` | `notifications-page.tsx`, `notification-item.tsx` | Cross-project inbox; `notification-item` is shared with the bell popover |
| `home` | `home-page.tsx`, `home-query.server.ts`, `project-create.server.ts` | Project cards; per-user prefs come from the DB, not localStorage |
| `agents` | `agents-page.tsx`, `capability-matrix-modal.tsx`, `create-profile-modal.tsx` | Agent profile roster, eligible stages, capability policy |
| `review` | `review-page.tsx` | Read-only human-acceptance triage queue (zero mutations) |
| `github` | `github-view.tsx`, `credential-card.tsx` | Repo + credential health, PRs, execution branches, Reconcile |
| `policy` | `policy-page.tsx`, `policy-data.ts` | RBAC matrix + capability rows, rendered from the same table the guards use |
| `project-settings` | `settings-page.tsx`, `membership.server.ts` | Identity, workflow-stage editor, members, credentials, danger zone |
| `org-settings` | `org-settings-page.tsx`, `connections-panel.tsx`, `users-panel.tsx`, `resources-panel.tsx` | `/org/settings?tab=connections\|users\|resources` |
| `profile` | `profile-page.tsx`, `notification-prefs.ts` | Appearance (theme + reduce-motion), password, GitHub connection |
| `kb-browser` | `store-browser.tsx`, `tree.ts` | Store file manager over a real disk scan |

### 7.3 The Lexical mention composer (new 2026-08-03)

Exactly three files touch Lexical, all under `app/features/task-detail/`:
`comment-composer.tsx`, `lexical-mention-plugin.tsx`, `mention-composer.test.tsx`.

`CommentComposer` wraps `<LexicalComposer>` with `namespace: "task-comment"` and
`nodes: [MentionTextNode]`. It uses **`PlainTextPlugin`, not `RichTextPlugin`**. Children:
`EditorBridge` (captures the editor into a ref), the content editable (with combobox ARIA:
`role`, `aria-expanded/controls/activedescendant/autocomplete`), `HistoryPlugin`,
`OnChangePlugin`, `MentionHighlightPlugin`, `ComposerKeysPlugin`, `MentionMenu`.

Keyboard handling is Lexical commands at `COMMAND_PRIORITY_HIGH` with
`if (editor.isComposing()) return false` first — Enter during IME is never a send or a pick.

**Mention node design** — deliberately not a decorator/element node
(`lexical-mention-plugin.tsx:18-27`):

> A `MentionTextNode` is a NORMAL text node with the `.mention` class — fully
> character-editable, exports/copies exactly its `@Name` text, and **never persists as
> anything but plain text**. A paragraph-level transform keeps the segmentation honest
> against the SAME matcher the rendered comments use (`findMentionSpans`).

**The persistence invariant** (`comment-composer.tsx:42-51`):

> The editor owns only the DRAFT UI: one paragraph of plain text with line breaks, known
> @mentions highlighted live as character-editable text. The posted value, storage, and
> rendering pipeline are untouched — the parent reads the raw draft through `onChange` and
> submits exactly `raw.trim()`, the same bytes the textarea composer produced. **No rich
> text, Markdown, HTML, or editor state ever persists.**

Mechanically: `handleChange` reads `$getRoot().getTextContent()` (a plain string);
`timeline.tsx` stores it in a **ref** (nothing renders from it, and `send()` must read the
exact current text, not a value one batch behind the keystroke); `send()` posts
`fd.set("text", draftRef.current.trim())`. `EditorState` is never serialized. A fixture
table in `mention-composer.test.tsx` (`describe("plain-text submission contract (exact
posted bytes)")`) pins the exact byte contract, and
`e2e/09-task-comment-composer.spec.ts` gates it live.

**On read**, the same matcher drives every surface: `app/ui/mention-spans.ts`'s
`findMentionSpans(text, names)` (longest-first known-name matching so `@Arda Kaya` beats
`@Arda`; `RESERVED_MENTION_HANDLES = ["operator","agent","claude","codex"]`) and its
`extractMentions`, which is the one function the server-side resolvers
(`app/server/tasks/mention-notify.server.ts`, `agent-reply.server.ts`) use. Comments render
through `app/ui/markdown.tsx` (react-markdown + remark-gfm, no raw HTML) with a rehype pass
that chips **only known** handles — an unknown `@handle` routes to nobody, and chipping it
told the author their tag had landed when it hadn't (P13-LV-12).

Autocomplete lives in `use-mention-autocomplete.ts` and is DOM-decoupled: the editing
surface feeds it `refreshFrom(text, caret)` and receives insertions via `applyInsert`; the
controller never touches the DOM.

### 7.4 The dnd-kit board drag (new 2026-08-03)

Only `app/features/board/board-page.tsx` imports dnd-kit; the pure resolver is
framework-free in `board-dnd.ts`.

**Whole-card drag, no grip handle** (`board-page.tsx:87-113`). A `preventActivation`
override returns true only for real controls (`button, input, select, textarea`) so the
card face — which is a `<Link>` — stays the drag surface. Activation constraints: mouse/pen
`Distance({ value: 5 })` (distance-only, because a hold-to-lift delay would swallow a slow
press-and-release that must stay a navigation); touch `Delay({ value: 250, tolerance: 5 })`.
The anchor gets `draggable={false}`.

dnd-kit's **Accessibility plugin is removed** (`BOARD_PLUGINS`, `:120-122`): its
`role="button"` wrapper nested the task link and StageMenu inside an interactive control
(axe `nested-interactive`, serious). The accessible move path is, and stays, the per-card
`StageMenu` — **drag is pointer-only** (F10-25).

Drag layer: no portal/`DragOverlay`. `Feedback.configure({ feedback: "clone" })` — the
source card keeps `.dragging` (faded, dashed) while a clone follows the pointer; a dashed
`DropPreview` ghost is interleaved at the resolved slot inside the hovered column; the
column gets `.drop-over`; on arrival a `.just-arrived` pulse retires after 1500 ms.

**Server-authoritative drop** — three load-bearing statements:

1. `board-page.tsx:214-218` — "Optimistic sorting is OFF — the board never reorders
   client-side; the DropPreview shows the requested slot and the server's answer is the only
   commit." Implemented by filtering `OptimisticSortingPlugin` out of the plugin list.
2. `board-page.tsx:1049-1051` — "The server stays authoritative: nothing commits
   client-side; a resolved drop submits the governed reorder and revalidation applies the
   server's order." `onDragEnd` bails on `event.canceled`, calls `resolveBoardDrop`, and
   submits `{_csrf, intent: "reorder", taskKey, to, beforeKey}` through a `useFetcher`.
   There is no `setColumns` and no local array mutation — `columns` is loader data.
3. `board-dnd.ts:1-8` — the resolver "never reorders board state, it only names the
   requested destination" (`beforeKey: null` = end of column). A slot that no longer exists
   in the target column (the board can change under a drag via SSE revalidation) degrades to
   "end of column" rather than submitting a reference the server can't place.

On `{ok:false}` the card snaps back because loader data never changed, and an error toast
appears.

### 7.5 Design tokens and `design/`

**Correction to a common assumption: there are no `--viberr-*` CSS custom properties.**
`grep -c -- "--viberr-" app/app.css` → `0`. Tokens are unprefixed single words.

`app/app.css` is 3419 lines — the app's only stylesheet.

| Fact | Detail |
| --- | --- |
| Light tokens | one `:root` block, `app.css:7-78`, 40 declarations |
| Dark tokens | `:root[data-theme="dark"]`, `app.css:2197-2237`, 28 declarations — a pure token swap, plus ~10 hardcoded-color fixups |
| `color-scheme` | set per branch (`:root { color-scheme: light }` / dark override) |
| Token families | surface/text (`--bg --surface --fg --muted --faint --placeholder --border --ring --hairline`), brand (`--blue --blue-pressed --blue-soft --cta-bg --cta-fg`), semantic pastel pairs (`--success --coral-light/dark --rose-light --teal-light/dark --orange-light --yellow-dark --red-light --pin-star`), agent identity (`--agent --agent-dark --agent-soft`), type (`--font-display --font-body --font-mono`), elevation (`--shadow-ring --shadow-card --shadow-pop`), motion (`--ease-out`), radii (`--radius-button/chip/card/panel`), layout (`--rail-w: 232px`, `--topbar-h: 60px`) |
| Sections | 12 banner-delimited sections: shell, BOARD (`:491`), TASK DETAIL (`:815`), AGENTS (`:1224`), POLICY (`:1722`), ACTIVITY (`:1960`), SETTINGS (`:1991`), REVIEW/GITHUB (`:2049`), PROFILE (`:2142`), DARK THEME (`:2194`), AGENT RUNTIME (`:2340`), HUMAN REVIEWERS (`:2462`) |
| Reduce-motion hook | `[data-motion="reduce"] *, ::before, ::after { animation-duration:.01ms!important; … }` at `app.css:2251-2256` — sourced from the **DB user pref**, SSR'd onto `<html>` so it applies without a flash; six independent `@media (prefers-reduced-motion)` blocks exist in parallel |
| Static gate | `app/app.css.test.ts` asserts every `var(--x)` resolves to a declared token, that required utility classes exist, and that `--faint`/`--placeholder` clear WCAG AA 4.5:1 on `--surface` in both themes with the `--muted > --faint > --placeholder` ordering preserved |

`design/` holds the canonical mocks:

```
design/
  index.html  design-system.html  landing.html   reference pages
  prd.md      CONVERSATION-SUMMARY.md            product requirements + design log
  html-app/
    Viberr {Home,Login,Operator Workspace}.html  React+Babel shells
    app/*.jsx      ← THE canonical per-surface mocks (board, task, agents, activity,
                     github, home, kb-browser, login, notifications, org-settings,
                     policy, profile, review, runs, settings, ui, data.js, viberr.css)
    reference/     design-system.html, index.html, landing.html
    _shots/        16 reference screenshots
```

The UI porting rule (`docs/architecture/decisions.md:97-118`) is that `design/html-app/app/*.jsx`
is the design source of truth — reproduce structure, class names and behavior 1:1 unless the
mock is prototype-only. A recurring maintenance task is cleaning off-palette Tailwind-style
literals back onto the token set.

### 7.6 Live updates on the client

`app/features/live-updates/use-live-updates.ts` is the single hook. Its contract (`:9-14`):

> subscribe the current surface to its SSE scopes and revalidate the active React Router
> loaders when anything relevant changes. **No optimistic state, no client caches —
> revalidation IS the update mechanism.**

| Fact | Value |
| --- | --- |
| Mechanism | `useRevalidator()`; every non-control event name from `SSE_EVENT_NAMES` gets an `addEventListener` that schedules a revalidate |
| Debounce | `REVALIDATE_DEBOUNCE_MS = 300` trailing, so bursts coalesce into one loader round-trip |
| Loop safety | revalidation re-runs GET loaders only, which never write projections — so an SSE-triggered revalidation cannot emit further SSE events |
| Reconnect | `onerror` + `readyState === CLOSED` → flip a `paused` flag (topbar chip) and open a **fresh** EventSource on `[2000, 5000, 15000, 30000]` ms backoff; revalidate once on reconnect to close the gap |
| Progressive enhancement | no-ops when `typeof EventSource === "undefined"` |
| Scopes | `sseScopes` in `event-types.ts`; URL built by `buildEventsUrl` |
| Call sites | exactly two: `routes/project.tsx` (the workspace shell — `project:` + `user`, plus `task:` when a task is open) and `routes/_index.tsx` (`user` + `projects`); `routes/notifications.tsx` uses `[user]` |

Deliberate exception: the run-log console has its own EventSource
(`features/runtime/use-run-log-stream.ts:12-19`) consuming `run.log-appended` directly and
fetching deltas from `/resources/run-log` since the last seq — using `useLiveUpdates` there
would refetch the whole task loader per log line. It revalidates the task loader only on
`run.state-changed`.

### 7.7 Hydration determinism — absolute-UTC first paint

The container SSRs in UTC and the viewer hydrates in their own zone, so any viewer-local
timestamp is a hydration text mismatch — a recoverable React #418 that forces a full client
re-render. The fix landed in commit `12db757`.

`app/ui/local-time.tsx:8-14`:

> Hydration-safe timestamp text. The server's timezone and the viewer's can differ, so
> rendering the viewer-local form on both sides hydrates to different text — a recoverable
> React #418 that forces a full client re-render of the page. **First paint is the UTC form,
> identical on server and client by construction; an effect swaps in the viewer-local
> rendering.**

Primitives:

- `useHydrated()` (`:25-29`) — `useState(false)` + `useEffect(() => setHydrated(true), [])`.
  False during SSR *and* during the hydration render; true on the first post-hydration commit.
- `LocalDayDotTime` — `local ? formatDayDotTime(iso) : formatDayDotTimeUTC(iso)`.
- `LocalRelative` (`:31-41`) — renders `" "` on **both** sides, because relative text
  depends on *now* and both sides could straddle a minute boundary. The blank lasts one
  hydration frame.

Paired formatters in `app/shared/dates/format.ts`: `formatDayBucketUTC`,
`formatDayDotTimeUTC`, `formatClockUTC`. The strongest statement is on
`formatDayBucketUTC` — it renders the **absolute UTC calendar day ("Mar 30") for every row
and deliberately never Today/Yesterday**, because the activity page uses that value as its
**grouping key** and an SSR/hydration render straddling UTC midnight would mismatch every
header at once.

Consumers: `timeline.tsx` (`LocalDayDotTime`), `activity-page.tsx` (`useHydrated` selects
`groupStreamByDay` vs `groupStreamByDayUTC`, `formatClock` vs `formatClockUTC`,
`auditTimeLabel` vs `auditTimeLabelUTC`), `runs-panels.tsx` (`finishedClock` and the
streamed log clock). Gated by `e2e/10-activity-hydration.spec.ts`: an Auckland-timezone
viewer against the UTC container, asserting zero page errors and no `Today`/`Yesterday` in
the SSR HTML.

A second, **older** strategy is still live and distinct: `app/ui/use-relative-time.ts`
re-renders once on mount and every 30 s, and must be paired with `suppressHydrationWarning`
on the element. Call sites: `home-page.tsx`, `timeline.tsx`. Two hydration strategies
coexist — know which one a surface uses before editing it.

---

## 8. Config, env, and deployment

### 8.1 Environment variables

Parsed and validated in exactly one place: `app/server/config/env.server.ts`, a Zod schema
evaluated once per process and cached on `Symbol.for("viberr.env")`. Empty strings are
treated as unset. A bad configuration produces a multi-line message listing *every* problem
and fails the boot. `.env` is loaded via `node:process.loadEnvFile()` at module scope
(ENOENT tolerated) — both here and in `vite.config.ts`.

| Variable | Required | Meaning |
| --- | --- | --- |
| `VIBERR_SESSION_SECRET` | **yes** | ≥32 chars. Signs the session cookie and derives the CSRF HMAC. `openssl rand -base64 48` |
| `VIBERR_SECRET_ENCRYPTION_KEY` | **yes** | base64 decoding to **exactly 32 bytes**; AES-256-GCM key for PATs at rest. `openssl rand -base64 32` |
| `VIBERR_DATA_ROOT` | no (`./data`) | the runtime data root (§4.4) |
| `VIBERR_FORCE_DATA_ROOT_LOCK` | no | `1`/`true`/`yes` — take over a live-looking writer lock for one boot |
| `PORT` | no (`5173`) | dev server and `react-router-serve` |
| `NODE_ENV` | no (`development`) | `development` \| `production` \| `test` |
| `BETTER_AUTH_URL` | no | absolute public origin; **required behind a reverse proxy** — unset with OAuth configured, `trustedOrigins` collapses to `[]` and OAuth breaks (boot logs a warning) |
| `BETTER_AUTH_SECRET` | no | defaults to `VIBERR_SESSION_SECRET`; only to rotate independently |
| `LOG_LEVEL` | no | read **directly off `process.env` by the logger**, not validated by the schema |
| `GITHUB_OAUTH_CLIENT_ID` / `_SECRET`, `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | no | login buttons stay inert when unset |
| `VIBERR_SEED_ADMIN_EMAIL` / `_PASSWORD` | no | used when `users` is empty. Without them the default is `admin@viberr.dev` with a random one-time password printed once to stdout as `VIBERR BOOTSTRAP ADMIN` |
| `ANTHROPIC_API_KEY` \| `CLAUDE_CODE_OAUTH_TOKEN` \| `VIBERR_CLAUDE_USE_CLI_AUTH` | no | Claude credential (any one) |
| `CLAUDE_CONFIG_DIR` | no | Claude SDK session dir; default `${DATA_ROOT}/runtimes/claude-home` |
| `CODEX_ACCESS_TOKEN` \| `CODEX_API_KEY` \| `OPENAI_API_KEY` \| `VIBERR_CODEX_USE_CLI_AUTH` | no | Codex credential; the access token / cached login wins over the API keys |
| `CODEX_HOME` | no | Codex login dir; compose sets `/data/runtimes/codex-home` |
| `VIBERR_CLAUDE_MAX_TURNS` | no (2000) | runaway guard |
| `VIBERR_CLAUDE_IDLE_TIMEOUT_MS`, `VIBERR_CODEX_IDLE_TIMEOUT_MS` | no (900000) | hang guards |

`.env.example` (119 lines) documents every one of these with generation commands.

### 8.2 Dev server (`.claude/launch.json`)

```json
{ "name": "viberr-dev", "runtimeExecutable": "bash",
  "runtimeArgs": ["-c", "... nvm use ...; export VIBERR_DATA_ROOT=<repo>/docker-data;
                          exec npm run dev"],
  "port": 5173, "autoPort": true }
```

(The committed version of this file also exported
`CODEX_HOME=<repo>/docker-data/runtimes/codex-home`; the working tree at the time of
writing has that line removed by an uncommitted local edit. Without it, a host dev server
falls back to `resolveCodexHome()` = `${VIBERR_DATA_ROOT}/runtimes/codex-home`, which is the
same path — so the removal is behaviour-neutral for the run home, but it does change
`resolveCodexAuthSource()` from that directory to `~/.codex`.)

**Note the conflict:** `.env` points `VIBERR_DATA_ROOT` at the stale `./data`, while
`launch.json` overrides it to `./docker-data`. `docker-data` is the live root. Combined with
the single-writer lock this means: a dev server started through `launch.json` and a
`docker compose up` both target `docker-data`, and the second one will (correctly) refuse to
boot.

### 8.3 Docker

`Dockerfile` — two stages on `node:26-slim`.

- **build**: `npm ci`, `npm run build`, `npm prune --omit=dev`.
- **runtime**: installs `git` + `ca-certificates` (real agent runs clone repos and shell out
  to git); copies `node_modules`, `build/`, `package.json`, and **also `db/`, `scripts/`,
  `app/`, `tsconfig.json`** so migrations resolve from cwd and `npm run seed|rescan` work via
  `tsx` inside the container. Sets `VIBERR_DATA_ROOT=/data`,
  `CLAUDE_CONFIG_DIR=/data/runtimes/claude-home`, `CODEX_HOME=/data/runtimes/codex-home`,
  `PORT=3000`. Runs as `USER node` (UID 1000).
- `ENTRYPOINT ["sh", "/app/scripts/docker-entrypoint.sh"]` seeds `auth.json` from the
  optional read-only `/host-codex` mount into the writable `$CODEX_HOME` **only when
  missing**, then `exec "$@"`.
- `CMD` runs the server binary directly, **not `npm run start`**: with npm in between, npm is
  pid 1 and the SIGTERM never reaches node — and node's shutdown handler is what checkpoints
  the WAL and releases the writer lock (`Dockerfile:75-81`).

`compose.yml` — the production single-node stack:

| Setting | Value / why |
| --- | --- |
| `hostname: viberr` | **stable identity across container recreation** — the writer lock refuses a lock from a different host, and compose's default hostname is the container id, so every `down && up` came back a stranger to its own leftover lock |
| `env_file: .env` + explicit `environment` | forces `NODE_ENV=production`, `VIBERR_DATA_ROOT=/data`, `CODEX_HOME=/data/runtimes/codex-home` even when `.env` carries dev equivalents |
| Volumes | `./docker-data:/data` (everything stateful — back this up) and `${CODEX_CLI_HOME:-~/.codex}:/host-codex:ro` (a **directory** mount, not the file, because the CLI rewrites `auth.json` via rename and a file mount would pin a dead inode) |
| Ports | `${PORT:-3000}:${PORT:-3000}` |
| Healthcheck | `node -e fetch('http://127.0.0.1:$PORT/resources/health')`, 30 s interval |

`compose.e2e.yml` — an isolated production-image stack for the e2e suite, driven by
`scripts/e2e.ts`. **Owner policy (2026-08-02): anything that serves the app for a test runs
the PRODUCTION image — never a dev server.** It never touches `compose.yml`'s project,
`.env`, `./docker-data`, or any host credential:

- A `seed` one-shot built from the **build stage** (which still has the full source tree,
  including `test-support/`, which the final image deliberately omits) runs
  `npm run seed:demo` then `chown -R 1000:1000 /data`.
- The `app` service builds the final stage, depends on the seed completing successfully,
  pins `hostname: viberr-e2e`, publishes `127.0.0.1::3000` (random host port), and shares a
  project-scoped named volume `e2e-data`.
- Deterministic synthetic secrets via the `x-e2e-env` anchor.

`scripts/e2e.ts` orchestrates: `down --volumes --remove-orphans` → `up --build --detach
--wait` → derive the port from `docker compose port app 3000` → wait for `/resources/health`
`{ok:true}` → run `playwright test` with `VIBERR_E2E_BASE_URL` → tear down with `--volumes`.
`VIBERR_E2E_KEEP=1` leaves the stack up. `playwright.config.ts` throws if
`VIBERR_E2E_BASE_URL` is unset — a bare `npx playwright test` has no app to target. One
worker, `fullyParallel: false`, because the specs share the seeded store; a `setup` project
logs in through the real `/login` UI and stores the session at `e2e/.auth/arda.json`.

### 8.4 CI

`.github/workflows/ci.yml` — Node 26, two jobs:

- `verify`: `npm ci` → `npm run typecheck` → `npm test` → `npm run build`.
- `e2e`: `npm ci` → `npx playwright install --with-deps chromium` → `npm run e2e`, uploading
  the Playwright report on failure.

**`npm run build` is not a typecheck.** `tsc` (via `npm run typecheck`, which first runs
`react-router typegen`) is the required gate — this has produced real self-inflicted bugs in
past passes.

### 8.5 Test infrastructure (brief; see `TESTING-INFRA.md`)

`vitest.config.ts`: node environment, includes `app/**/*.test.{ts,tsx}` and `db/**/*.test.ts`
(scripts are deliberately excluded), setup files `test-support/setup-env.ts` and
`test-support/setup-dom.ts`.

`test-support/setup-env.ts` makes the suite **hermetic**: it seeds
`VIBERR_SESSION_SECRET` / `VIBERR_SECRET_ENCRYPTION_KEY` before any app module loads, and —
critically — **blanks every real-backend credential to `""`** (`ANTHROPIC_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN`, `VIBERR_CLAUDE_USE_CLI_AUTH`, `CODEX_ACCESS_TOKEN`,
`CODEX_API_KEY`, `OPENAI_API_KEY`, `VIBERR_CODEX_USE_CLI_AUTH`) so `npm test` can never make
a paid provider call (F10-10). It assigns `""` rather than `delete`-ing, because
`env.server.ts` calls `loadEnvFile()` *after* setup files run and would refill a deleted key
from the developer's `.env`. It also pins `CLAUDE_CONFIG_DIR` / `CODEX_HOME` at an **empty
real temp directory** so the transcript-continuity probe answers `missing` deterministically
instead of differing between a laptop and CI.

Other harnesses: `test-app.ts` (route-level harness — temp data root, reset singletons, real
Requests with signed session cookies and CSRF tokens; **import route modules after
`setupAppTest()`**), `test-db.ts`, `test-store.ts`, `fake-runtime.ts`, `fake-github.ts`,
`demo-seed.ts` + `demo-data.ts` (the mock dataset the route + e2e suites are written
against), `audit-log.ts`, `custom-board.ts`.

---

## 9. Invariants an implementer must not break

1. **One app process per data root, EVER.** Enforced by `state/writer.lock` (§4.6). Never
   run a second server, seed, or rescan against a data root a live process holds. A second
   writer is corruption of the WAL and of per-process run handles, not a slow path.
2. **Files are the only canonical business truth.** Write through the dedicated writer
   modules (frontmatter-preserving, atomic), then re-parse → re-project → publish. Never
   write a task/project projection without file backing.
3. **Plain-text mention persistence.** The comment composer posts exactly `raw.trim()`. No
   rich text, Markdown, HTML, or Lexical editor state ever persists. The composer highlight,
   the rendered chip, and the server-side routing resolver must all use the *same*
   `findMentionSpans`/`extractMentions` matcher.
4. **Absolute-UTC first paint for anything timezone- or now-dependent.** Render the
   deterministic UTC form while `useHydrated()` is false; swap to viewer-local after. Grouping
   keys must use *absolute* days (never Today/Yesterday). The alternative strategy
   (`use-relative-time.ts`) requires `suppressHydrationWarning` on the element.
5. **`/api/auth/*` allow-list.** `ALLOWED_AUTH_PATHS` enumerates the endpoints the app
   drives; everything else 404s in the `before` hook. Never convert it to a deny-list — better-auth
   adds endpoints over time and a deny-list rots silently.
6. **`ACTION_ROLES` in `app/shared/rbac.ts` is the single source** for project-role
   authorization. The server guards consult it and the Policy page renders the same object,
   so display and enforcement cannot drift; `policy-rbac.server.test.ts` drives each guard
   per role to keep them bound. Roles are a strict tier `viewer ⊂ contributor ⊂ maintainer ⊂
   admin` and every action is monotonic. Add a governed action by adding a row to
   `RBAC_DEFINITIONS`, not by hand-checking a role at a call site.
7. **The board drop is server-authoritative.** No optimistic reordering; `columns` is loader
   data. `OptimisticSortingPlugin` stays removed.
8. **No optimistic UI for governed state** generally — revalidate after the action and on
   SSE. SSE payloads carry compact facts/references only.
9. **Every mutating form needs `_csrf`** (or an `X-Csrf-Token` header) and goes through
   `requireFormAction` / `assertCsrf`.
10. **Every governed action writes an audit event**, and where user-visible, a typed timeline
    event in `task.md`. Mutating actions must be idempotent-safe — a retry must not duplicate
    transitions, branches, PRs or events.
11. **Secrets come only from env.** PATs are AES-256-GCM encrypted in SQLite; secrets never
    appear in files under `projects/`, in logs, in SSE payloads, or in error messages. The
    spawned-agent env is a filtered *replacement*, not `process.env`.
12. **Tolerant parsing.** Malformed input produces diagnostics plus a readiness downgrade,
    never a crash and never a silent drop; unknown frontmatter fields are preserved verbatim.
13. **Human-only, server-enforced**: transition to Done and completion acceptance — with the
    single disclosed exception that under the `auto` preset a full-autonomy operator holding
    an explicit `completion-for-acceptance: direct` grant may accept.
14. **Migrations stay squashed into `0001_baseline.sql`** while pre-prod. Edit in place; wipe
    and re-seed locally afterwards.
15. **`tsc` is a required gate.** `npm run build` does not typecheck.
16. **`app/ui/` must not import from `app/features/`**; client components must not import
    `*.server.ts`.

---

## 10. Deliberate divergences from `planning/planning-artifacts/architecture.md`

That document is the original architecture decision record, but it is **maintained, not
frozen** — its directory tree is regenerated from the filesystem (last resynced 2026-07-25)
and its Authentication section carries an explicit "Revised 2026-07-25" note. So most of it
still matches. The changes recorded below came from the numbered discovery/product passes
and from the 2026-08-03 modernization, and where they contradict the original text the code
is authoritative.

| Original intent | Current reality | Recorded where |
| --- | --- | --- |
| "OAuth-first login" | **Local email+password is the shipped default and first-class**; OAuth is optional and inert without env vars; no self-signup on any path | architecture.md revised inline 2026-07-25 |
| Hand-rolled sessions | `better-auth` is the sole auth system behind a Viberr bridge, with the `/api/auth/*` splat allow-list | `app/lib/auth.server.ts`; memory: better-auth migration |
| "SQL-first migrations, explicit and checked in" (implying a chain) | **Squashed into a single `0001_baseline.sql` while pre-prod**; forward-only additive migrations resume at first deployment | owner ruling, pass 11; `db/migrations/0001_baseline.sql:10-20` |
| Nothing about concurrency between processes | **Exclusive single-writer lock on the data root (B-FD1)**, refusing to boot with a named holder | `app/server/db/data-root-lock.server.ts` |
| Raw `node:fs.watch` recursive watchers | **chokidar 5** for both the store and KB watchers (typed events, no rename inference); domain logic unchanged | modernization 2026-08-03 (A1) |
| HTML5 `dataTransfer` board drag | **@dnd-kit/react**, whole-card, `OptimisticSortingPlugin` removed, ARIA plugin removed (StageMenu is the accessible path) | modernization 2026-08-03 (A2) |
| `<textarea>` + transparent mirror backdrop composer | **Lexical plain-text composer** with character-editable `MentionTextNode`s; posted bytes unchanged | modernization 2026-08-03 (A3) |
| E2E against a dev server (`webServer` in playwright.config) | **E2E runs the production Docker image** in an isolated compose stack; the dev-server path is deleted | owner policy 2026-08-02; `compose.e2e.yml`, `scripts/e2e.ts` |
| "Simulated" agent runtime for demos | **Do not simulate at all** — the simulated runtime was cut from product and seed; only an e2e-only fake adapter remains | ruling R7-2 |
| Demo data in the product seed | **Clean-sheet product seed** (`npm run seed`); the mock dataset moved to `test-support/demo-seed` behind `npm run seed:demo` | pass 11 |
| Topbar "global search" input | Replaced by the **⌘K command palette** over the viewer's visible projects (`/resources/search`) | ruling R15-5 |
| App-wide readable boards ("FR4") | **Projects are members-only** — `view`/`comment` reach exactly as far as project membership does; a non-member gets the unknown-slug 404 | ruling R15-4; `app/shared/rbac.ts:46-54` |
| No stated hydration policy | **Absolute-UTC first paint** for every timezone/now-dependent string | commit `12db757` |
| "Structured JSON logs with request/job correlation identifiers" (shipped once as an unused opt-in, then deleted as dead code) | Correlation is now **non-optional** root middleware | `app/root.tsx:43-55` |

---

## 11. Known drift, sharp edges, and surprises

Things that are true today and will confuse someone who reads only the comments. None of
these were changed while writing this document.

**Naming / documentation drift**

1. **There are no `--viberr-*` CSS tokens.** Every custom property in `app.css` is
   unprefixed (`--bg`, `--fg`, `--blue`). Any instruction referring to a `--viberr-`
   namespace is describing something that does not exist.
2. `app.css` comments reference several tokens that were removed long ago (`--coral`,
   `--line`, `--panel`, `--font-sans`, `--link`, `--accent`, `--surface-2`, `--mono`).
   `app.css.test.ts` strips comments before validating, which is why they don't trip it —
   but a naive grep will "find" undefined tokens.
3. `app/ui/mention-spans.ts:5` still describes a "composer highlight backdrop" that the
   Lexical commit deleted.
4. SDK-version comments are stale: `codex-runtime.server.ts:23` says "verified v0.144.1" and
   `model-catalog.server.ts:95` pins reasoning to "SDK 0.144.1", but the installed
   `@openai/codex-sdk` is `0.146.0`.
5. `run-store.server.ts:357-359` documents the raw-log path as
   `<sessionOrRunId>.jsonl`; the sink passes `spec.runId` unconditionally
   (`run-sink.server.ts:268`). It is always the run id.
6. Thread-id docs (`adapter.server.ts:18`, `run-service.server.ts:193`) say
   `"op" | "primary" | "c0"`; the code actually uses `r0` for reviewers and `op-<8 chars>`
   for operators.
7. `claude-runtime.server.ts:52-55` advises using a `tools` option to restrict the built-in
   set — **`tools` is not in `ClaudeQueryOptions` and is never passed anywhere.** All
   confinement is via `disallowedTools`.

**Real, potentially exploitable or behavioral**

8. **The model-catalog live probe bypasses the runtime isolation.**
   `fetchLiveClaudeModels` calls `queryFn({ prompt: "", options: {} })`
   (`model-catalog.server.ts:356`). Empty options means no `env` (so the SDK's
   `{...process.env}` default applies — the spawned `claude` sees `DATABASE_URL`, the GitHub
   PAT, the session secret, every provider key: exactly the F10-02 leak `claudeSpawnEnv`
   exists to close) and no `CLAUDE_CONFIG_DIR` (so it reads/writes the host `~/.claude`). It
   is reached from the agent create/edit UI whenever Claude is available. **This looks like a
   genuine regression of a fixed finding.**
9. **`app/ui/rich-text.tsx:17` uses its own `@[A-Za-z][\w-]*` regex and chips
   unconditionally** — no known-name check, no multi-word match — contradicting
   `mention-spans.ts`'s claim that one matcher governs highlight and routing. `RichText` with
   mentions enabled is live on typed timeline events (`timeline.tsx:171`), so there
   `@Arda Kaya` chips only `@Arda`, and `@nobody` chips despite routing nowhere. That is the
   exact P13-LV-12 defect the markdown renderer was fixed for, surviving on a second surface.
10. **Claude CLI-auth is presence-only; Codex CLI-auth is validated.** `hasCredential`
    accepts `VIBERR_CLAUDE_USE_CLI_AUTH=1` with no file check, while the Codex branch requires
    `auth.json` to exist. The F-DOCKER1-class failure (flag set, credential absent → every run
    dies with one redacted line) is still reachable on the Claude side.
11. **Log-line clocks are server-local wall time.** `wire-format.server.ts:8-12` uses
    `getHours/getMinutes/getSeconds`, so `LogLine.t` carries the *server's* clock —
    the same class of bug that was fixed for `finished_at` by shipping ISO and formatting
    client-side. `log-clock.ts` re-anchors and reprojects it at render time, which mitigates
    but does not remove the stored-value issue.
12. **`agent_runs.outcome_key`** exists in the schema and is read/written by the recovery and
    task-action paths, but is absent from the `AgentRunRow` interface and from
    `upsertRun`/`RunPatch`. It survives upserts only because the `ON CONFLICT DO UPDATE`
    column list happens not to mention it.
13. **Three drag idioms coexist.** dnd-kit replaced only the board;
    `project-settings/settings-page.tsx` (workflow-stage reorder — and it *is* optimistic,
    unlike the board) and `kb-browser/store-browser.tsx` still use raw HTML5 `dataTransfer`.
14. **`@lexical/utils` is a phantom dependency.** `comment-composer.tsx:28` imports
    `mergeRegister` from `@lexical/utils`, which is **not in `package.json`** — it resolves
    only because `@lexical/react` hoists it. A stricter installer (pnpm, nested install
    strategy) or a `@lexical/react` minor that drops the dep breaks the build.
15. **`.env` and `.claude/launch.json` disagree about the data root** (`./data` vs
    `./docker-data`). `docker-data` is live; `data/` is stale. This has previously caused a
    dual-writer incident.
16. Dead code: `codexSpawnEnv` explicitly `delete`s `CODEX_API_KEY`/`OPENAI_API_KEY` that
    `filteredSpawnEnv` already stripped one line earlier, with a comment that reads as
    load-bearing.
17. `run-sink.server.ts`'s `effectiveBackend` is write-after-use (assigned in `finalize`,
    after every `appendRawLine` already ran) — vestigial from a fallback-adapter era, harmless
    only because `RunExit.effectiveBackend` always equals the requested backend.
18. Claude's adapter-authored error lines write `raw: ""`, which `appendRawLine` turns into a
    bare newline in the NDJSON transcript. Codex synthesizes a real event object instead —
    an asymmetry in the on-disk log format.
19. `e2e/` has no spec numbered `02`, `03`, or `04` (jumps `01` → `05`).
20. `design/html-app/app/tweaks-panel.jsx` is the only canonical mock surface never ported to
    the app.
