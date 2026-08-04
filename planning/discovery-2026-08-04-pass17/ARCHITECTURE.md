# Viberr — Architecture reference (pass 17)

Written 2026-08-04 against `main` @ `8541a32` — the merge of PR #125 (`pass16/product-fixes`),
i.e. **after** the three pass-16 implementation waves. Self-contained: an implementation agent
with no other context should be able to navigate the codebase from this document alone. Every
path is repo-relative from the repository root; line anchors were verified against this commit.

This supersedes `planning/discovery-2026-08-04/ARCHITECTURE.md`, which was written against
`2442945` — **before** commits `5e03c6e`, `53b796d`, `71fa506`, `0955ac9` changed 196 files
(+16 823 / −5 535). Its companion docs (`DOMAIN-MODEL.md`, `RBAC-GOVERNANCE.md`,
`UI-INVENTORY.md`, `AGENTS-RUNTIME.md`, `TESTING-INFRA.md`) are stale in the same way and have
**not** been re-verified here; treat their line anchors as approximate and their §"known drift"
lists as pre-wave.

> **Working-copy note.** `data/`, `docker-data/`, `build/`, `.react-router/`, `node_modules/`
> and `.env` are gitignored, so a fresh git worktree of this repo has none of them. Commands
> that need a data root (`npm run seed`, `npm run rescan`, `npm run dev`) will fall back to the
> `./data` schema default there. See §4.6 before starting any process that writes a data root.

---

## Delta from the pass-16 doc

Everything below was verified against the current tree. These are the corrections; the rest of
this document is the pass-16 content re-anchored.

**Facts that are now simply wrong**

| # | Pass-16 claim | Current truth |
| --- | --- | --- |
| D1 | `@lexical/utils` is a phantom dependency (§11.14) | Declared: `package.json` `"@lexical/utils": "0.49.0"`, and pinned by `app/server/runtimes/harness-hermeticity.server.test.ts:102` |
| D2 | `e2e/` has no spec `02`/`03`/`04` (§11.19) | Renumbered contiguous `01`–`07` + `auth.setup.ts` (commit `71fa506`, pure renames) |
| D3 | The model-catalog live probe leaks the full `process.env` and the host `~/.claude` (§11.8) | Fixed: `claudeProbeOptions()` (`app/server/runtimes/model-catalog.server.ts:380-393`) passes the same filtered spawn env and app-owned config dir a real run gets; used at `:403` |
| D4 | `rich-text.tsx` carries its own `@`-regex and chips unknown handles (§11.9) | Fixed: `app/ui/rich-text.tsx:52` routes through `findMentionSpans(...).filter(s => s.known)`; rationale `:16-23` |
| D5 | Three drag idioms coexist (§11.13) | Two: one dnd-kit *reorder* language (board **and** project-settings stages), plus an HTML5 `dataTransfer` **file-upload drop zone** in `store-browser.tsx` — a different verb, no dnd-kit equivalent |
| D6 | Claude CLI-auth is presence-only (§11.10) | Fixed: `claudeCliAuthUsable(env)` (`runtime-registry.server.ts:262-273`) verifies the config dir, symmetric with the Codex branch |
| D7 | `claude-runtime.server.ts:52-55` advises a nonexistent `tools` option (§11.7) | Fixed at `:52-57` — it now names `disallowedTools` and retracts the old advice |
| D8 | Stale SDK-version comments pinned to 0.144.1 (§11.4) | Fixed: `CODEX_SDK_VERIFIED_VERSION = "0.146.0"` (`codex-runtime.server.ts:59`), pinned by test against `package.json`; `model-catalog.server.ts:101-108` defers to it |
| D9 | `run-store.server.ts` documents the raw-log path as `<sessionOrRunId>.jsonl` (§11.5) | Fixed at `:356-365` — **but the same falsehood survives in the file header at `:8-9`** |
| D10 | 23 tables in `0001_baseline.sql` (§4.3) | **25** `CREATE TABLE` statements (the pass-16 doc's own enumeration already listed 25). It was 25 at `2442945` too — a counting error, not drift |
| D11 | `0001_baseline.sql` is 360 lines | **413** lines (all three load-bearing index anchors moved ~+53) |
| D12 | `app.css` is 3419 lines with 12 banner sections | **3936** lines, **14** sections (two new: “P16-F3 — declarations reclaimed from JSX `style={{…}}`” `:3732`, “1100px — THE TWO-COLUMN COLLAPSE” `:3890`) |
| D13 | `app/server/` has 17 subdirectories | **19** |
| D14 | The pass-16 §7.2 file sizes (`task-detail-page` ~1760, `home-page` 1691, `resources-panel` 1471) | All three were split. Current: 538 / 297 / 259. The largest frontend file is now `project-settings/settings-page.tsx` at **1559** |
| D15 | `.env.example` is 119 lines and leaves `VIBERR_DATA_ROOT` commented | **132** lines; `:34` actively prescribes `VIBERR_DATA_ROOT=./docker-data` with a 13-line dual-writer warning (`:21-33`) |
| D16 | `.claude/launch.json`’s missing `CODEX_HOME` export is an *uncommitted* local edit | It is **committed** (`5e03c6e`), and `0955ac9` reworked both Codex home resolvers to derive `HOME` from the passed env, which is what made dropping it safe |
| D17 | `vitest.config.ts` carries a dead `db/**/*.test.ts` glob | Removed by `71fa506`; `include` is now `["app/**/*.test.{ts,tsx}"]` only |
| D18 | “a non-member sees a clean 403 page” (§3.5) | **Wrong for every `/projects/:slug/*` surface** — it is the unknown-slug **404**, produced by the layout loader (`app/routes/project.tsx:75`) on reads and `requireVisibleProject` (`app/routes/project-visibility.server.ts:40`) on actions. 403 survives only on `/resources/run-log` and `/resources/session-export` |
| D19 | CSRF: “requests carrying neither Origin nor `Sec-Fetch-Site` pass” (§3.6) | **Fails closed** now: `csrf.server.ts:91-93` throws. `Referer` is a third checked signal (`:79-90`). Every anchor in that section moved |
| D20 | `allowedTools` never reaches a run and cannot survive resume | Fixed in wave 3: `withMcpAutoApproval` (`run-service.server.ts:319-332`, called at `:410`) and `resumeRun`’s new `allowedTools` parameter (`:676-681`, forwarded at `:738` and `:772`) |
| D21 | `docs/contributing-quickstart.md` / `docs/testing-quickstart.md` no longer exist (FINDINGS R16-7) | **Both exist** and were last touched in pass 13 (`e9b4f8d`). No pass-16 commit removed them |

**Material omissions the pass-16 doc had**

- **`app/routes/project-visibility.server.ts`** and the membership 404 chokepoint in
  `app/routes/project.tsx:56-76` (§3.6 below) — the enforcement half of the members-only ruling.
- **SSE subscription authorization** (`app/routes/resources.events.ts:100-137`): the `projects`
  firehose is narrowed to the viewer’s member projects, foreign scopes are dropped, and a
  non-member left with nothing gets 403.
- **`stream.open`** — a 12th SSE event, sent as a hello on connect with `retry: 5000`.
- **The credential-health / diagnostics layer** wave 1 added to `runtime-registry.server.ts`
  (+264 lines) — §6.3 here.
- **`app/server/github/pr-adoption.server.ts`** — the one PR-adoption rule (R16-1) now shared by
  all three adoption sites.
- **`applyAcceptanceWrite`** (`task-actions.server.ts:4942`) — the single Done write that carries
  the PR-head gate for every acceptance path, including the operator’s.
- **`app/shared/text/plural.ts`** and **`app/shared/text/store-extensions.ts`** — new shared modules.
- **`app/ui/use-dismiss.ts`** — the one dismiss hook that replaced seven hand-rolled effects.
- **`app/app.css.test.ts`** grew 253 → 1006 lines and is now 13 assertion families, including a
  no-allowlist className/TSX integrity scan and an inline-style budget (§7.5).
- `docs/architecture/decisions.md` §“ORCHESTRATOR RULINGS” (`:119-284`, 34 numbered rulings that
  code comments cite by number) and its §“Route map” (`:285-297`).
- Top-level `.agents/`, `CONTRIBUTING.md`, `FILES.md`, `README.md`, `skills-lock.json`,
  `.react-doctor/`, `qa/smoke/`, `docs/testing.md` and the two quickstarts.

**Still true, unchanged** — everything in `boot.server.ts` (all 19 documented steps at their
documented lines), both watchers, `data-root-lock.server.ts`, `file-store-root.server.ts`,
`atomic-file.server.ts`, `retention.server.ts`, `migration-runner.server.ts`, `sqlite.server.ts`,
`use-live-updates.ts`, `local-time.tsx`, `entry.client.tsx`, `entry.server.tsx`, `root.tsx`, the
`RunSpec`/`RunExit`/`RunHandle` contracts, and the Lexical persistence invariant.

---

## 0. What Viberr is, in one paragraph

Viberr is a self-hosted, single-node project-management plane for AI-agent-orchestrated software
delivery. Business truth lives in **Markdown files on disk** (`project.md`, `task.md`) that both
humans and agents may edit directly; SQLite is a **derived projection** that exists to make those
files queryable — plus the primary store for users, sessions, secrets, audit and run logs. An
“operator” agent coordinates each task, dispatches specialist agents into cloned git workspaces
via the Claude Agent SDK or the Codex SDK, and every governed mutation is RBAC-checked, audited,
and written back into the canonical file before it is re-projected and published over SSE.

---

## 1. Stack and versions

| Layer | Choice | Version (`package.json`) |
| --- | --- | --- |
| Framework | React Router **framework mode**, SSR on | `react-router` / `@react-router/dev` / `@react-router/serve` `^8.3.0` |
| UI | React | `^19.2.8` (`react-dom` `^19.2.8`) |
| Bundler / dev server | Vite | `^8.2.0` |
| Language | TypeScript | `^7.0.2` (`strict`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noUnusedLocals/Parameters`) |
| Runtime | Node | `>=26` (`engines`), `.nvmrc`, `node:26-slim` image |
| Database | **`node:sqlite`** (`DatabaseSync`) — no third-party driver | built into Node 26 |
| Auth | `better-auth` | `1.6.25` (exact pin) |
| Validation | `zod` | `^4.4.3` |
| YAML frontmatter | `yaml` | `^2.9.0` |
| Watchers | `chokidar` | `5.0.0` (exact pin) |
| Board / stage drag | `@dnd-kit/react` + `@dnd-kit/dom` | `0.5.0` (exact pins) |
| Comment composer | `lexical` + `@lexical/react` + **`@lexical/utils`** | `0.49.0` (exact pins) |
| Markdown render | `react-markdown` `^10.1.0` + `remark-gfm` `^4.0.1` | |
| Fonts | `@fontsource/manrope`, `@fontsource/noto-sans`, `@fontsource/jetbrains-mono` `^5.3.0` | self-hosted, no CDN |
| Agent runtimes | `@anthropic-ai/claude-agent-sdk` `^0.3.220`, `@openai/codex-sdk` `^0.146.0` | |
| Script runner | `tsx` `^4.23.5` | a **dependency**, not a devDependency — the runtime image runs `npm run seed`/`rescan` |
| Tests | `vitest` `^4.1.10` (node env), `@playwright/test` `^1.62.1`, `@axe-core/playwright` `^4.12.1`, `@testing-library/react` `^16.3.2`, `jsdom` `^30.0.1` | |

**There is no linter, formatter, Tailwind, or PostCSS config, and adding one is an explicit
non-goal.** Verified: no eslint/prettier/biome/postcss/tailwind file exists at any level. One
hand-written stylesheet: `app/app.css`. Conventions are enforced by `tsc`, the vitest suite, and
the static stylesheet test `app/app.css.test.ts`. `doctor.config.ts` configures the optional
`npx react-doctor` scan (ignores `design/`, `.claude/`, `data/`, `*.server.test.ts`).

npm scripts (`package.json:8-17`):

```
dev        react-router dev
build      react-router build
start      react-router-serve ./build/server/index.js
typecheck  react-router typegen && tsc     # tsc is a REQUIRED gate; `build` is not a typecheck
test       vitest run
e2e        tsx scripts/e2e.ts              # boots a production-image compose stack
seed       tsx scripts/seed.ts             # clean-sheet product seed (`-- --reset` to wipe)
seed:demo  tsx scripts/seed-demo.ts        # demo fixture (test/dev only)
rescan     tsx scripts/rescan.ts           # `-- --force` to bypass the hash short-circuit
```

---

## 2. Repo layout

```
viberr/
├── app/                     the application (see §2.1)
├── db/migrations/           0001_baseline.sql — the ONLY migration (squashed, §4.2)
├── scripts/                 seed.ts, seed-demo.ts, rescan.ts, e2e.ts, measure-routes.mjs,
│                            docker-entrypoint.sh
├── e2e/                     Playwright specs 01–07 + auth.setup.ts
├── test-support/            11 fakes/harnesses shared by the unit suite; deliberately NOT
│                            excluded by .dockerignore, because the e2e seed one-shot needs it
├── design/                  the canonical HTML/JSX design mocks + PRD (§7.9)
├── docs/                    architecture/{decisions,file-formats}.md,
│                            operations/{deployment,runbook}.md, testing.md,
│                            contributing-quickstart.md, testing-quickstart.md
├── qa/                      pass15/ (per-use-case QA scripts) and smoke/ (VIB-1 governed-
│                            delivery smoke note)
├── planning/                README.md, planning-artifacts/ (PRD + architecture + UX spec),
│                            modernization-2026-08-03/, one discovery-<date>-passN/ per pass
├── .agents/skills/          6 vendored design/animation skills (gitignored dir, tracked files)
├── .claude/                 launch.json (dev server), settings.local.json, skills/, worktrees/
├── .github/workflows/ci.yml
├── .react-doctor/           false-positives.md (the canonical FP filter)
├── compose.yml              production single-node stack
├── compose.e2e.yml          isolated production-image stack for the e2e suite
├── Dockerfile               two-stage; final stage runs react-router-serve as pid 1
├── .dockerignore            32 lines, with a "NOT excluded, on purpose: test-support/" block
├── .env.example             132 lines (the real .env is gitignored)
├── CONTRIBUTING.md  README.md  FILES.md  skills-lock.json
└── react-router.config.ts, vite.config.ts, vitest.config.ts, playwright.config.ts,
    tsconfig.json, doctor.config.ts
```

Gitignored and therefore absent from a clean worktree: `node_modules/`, `build/`, `data/`,
`docker-data/`, `.env`, `.react-router/`, `coverage/`, `playwright-report/`, `test-results/`,
`e2e/.tmp-data/`, `e2e/.auth/`, `.agents/`.

### 2.1 `app/` layout

```
app/
  root.tsx           document shell, root loader (theme/motion/csrf), middleware, ErrorBoundary
  routes.ts          the route table (explicit, not file-system routing) — 52 lines
  entry.server.tsx   awaits bootServer() at MODULE SCOPE; streaming render; handleError
  entry.client.tsx   hydrateRoot(document, <HydratedRouter/>) inside startTransition
  app.css            3936 lines — the entire design system, one file
  app.css.test.ts    1006 lines — the static stylesheet + markup integrity gate (§7.5)
  routes/            26 thin route modules + project-visibility.server.ts + co-located tests
  ui/                21 reusable primitives/hooks — MUST NOT import from features/
  lib/auth.server.ts the better-auth instance + Viberr bridge
  features/          16 product surfaces
  schemas/           Zod contracts: task-file, project-file, sse-event, github-pat,
                     file-diagnostics
  server/            server-only modules, 19 subdirectories (below)
  shared/            client-safe cross-surface code: rbac.ts, capabilities.ts, freshness.ts,
                     auth/, dates/, ids/, mapping/, text/, workflow/
```

`app/server/` subdirectories and their single responsibilities:

| Dir | Owns |
| --- | --- |
| `audit/` | `audit-recorder.server.ts` — the only writer of `audit_events` (failures are logged and swallowed; `details` must be secret-free) |
| `auth/` | csrf, form-action preamble, login, identity, password hashing, OAuth provisioning, project authority, route guards, user store/admin, rate limits, seed admin |
| `config/` | `env.server.ts` — **the only place `process.env` is parsed** (one documented exception, §8.1) |
| `db/` | sqlite handle, migration runner, transaction helper, retention, data-root lock |
| `errors/` | `AppError` + 7 stable machine codes (`error-codes.ts`) |
| `events/` | sse-broker, event-publisher, projection-events (in-process emitter) |
| `files/` | data-root paths, the two watchers, atomic writes, per-file mutex, frontmatter, task/project/agent-profile readers + writers, KB/skill body injection |
| `github/` | client, repo access check, branch sync/cleanup, **pr-adoption**, pr-linker/open, reconciler + poller, workspace delivery, scope flags |
| `interpretation/` | readiness / diagnostics / freshness derivation policies |
| `logging/` | `logger.server.ts` + `request-context.server.ts` (AsyncLocalStorage correlation) |
| `org/` | org users, connections, resources (KB/skills/MCP), global agents, store files, org seed, resource catalog + references |
| `prefs/`, `theme/` | user prefs table; theme cookie |
| `projections/` | 12 modules — rebuilder, rescan, rebuild, board/task queries, activity feed, decisions, notifications, review queue, policy violations, agent deployments, single-flight |
| `provenance/` | the only reader/writer of the `provenance` table |
| `runtimes/` | 16 modules — Claude + Codex adapters, registry + credential diagnostics, run service/store/sink/events/projection/recovery, operator run, wire format, session export, model catalog |
| `secrets/` | AES-256-GCM secret box (with key rotation), PAT store + validator |
| `seed/` | product seed, agent catalog, shipped default agent assets (`assets/`), base-agent deployment |
| `tasks/` | the governed-mutation core (`task-actions.server.ts`, **5517 lines** — the largest module in the tree), operator actions/toolkit, agent toolkit, specialist run + MCP + **tool policy**, agent reply/outcome, comment guardrails, mentions, schedules, timeline compaction, git clone auth, workspace retention |

Naming conventions (`docs/architecture/decisions.md:24-48`): server-only files end in `*.server.ts`
and are never imported by client components (`import type` is fine); tests are co-located as
`foo.server.test.ts`; files/dirs kebab-case; no `utils.ts`/`helpers.ts` dumping grounds. There is
deliberately **no `app/features/auth/`** — sign-in is one route.

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

`vite.config.ts` loads `.env` via `node:process.loadEnvFile()` tolerating ENOENT (`:6-10`),
resolves tsconfig `paths` natively (`resolve.tsconfigPaths: true`, `:22-26` — the
`vite-tsconfig-paths` plugin is gone in Vite 8), and **excludes the whole data root from the dev
watcher** (rationale `:12-17`, `const dataRoot` `:18`, `server.watch.ignored` `:30-32`): task
workspaces under the data root are full nested repo clones with their own `.git` and
`tsconfig.json`, which Vite would otherwise treat as app source (F10-36). `strictPort: true`.

### 3.2 Route table

Routing is **explicit** in `app/routes.ts` — not file-system-convention routing.

| Path | Module | `routes.ts` line |
| --- | --- | --- |
| `/` | `routes/_index.tsx` — home / project list | `:4` |
| `/login`, `/logout` | `routes/login.tsx`, `routes/logout.tsx` | `:5-6` |
| `/org/settings` | `routes/org.settings.tsx` — tabbed org admin | `:9` |
| `/api/auth/*` | `routes/api.auth.$.ts` — better-auth splat | `:13` |
| `/profile`, `/notifications` | PageOverlay routes | `:16-17` |
| `/notifications/read` | fetcher target, no UI | `:19` |
| `/prefs/theme` | fetcher target, no UI | `:20` |
| `/resources/events` | SSE stream | `:22` |
| `/resources/run-log` | seq-based run-log tail | `:25` |
| `/resources/health` | **unauthenticated** ops probe | `:27` |
| `/resources/search` | ⌘K palette query (`requireUser`) | `:30` |
| `/resources/model-catalog` | model + effort catalog per backend (`requireUser`) | `:33` |
| `/resources/session-export` | bash installer carrying a run transcript (`requireUser` + `requireProjectMember`) | `:36` |
| `/projects` | `routes/projects.tsx` — loader returns `redirect("/")`; home IS the project list, not a 404 (N5) | `:39` |
| `/projects/:slug` | `routes/project.tsx` — workspace shell (rail + topbar) | `:41` |
| ↳ index | `routes/project._index.tsx` → board | `:42` |
| ↳ `board` `review` `agents` `policy` `github` `activity` `settings` | the seven project views | `:43-49` |
| ↳ `tasks/:key` | `routes/project.task.tsx` — the deepest surface | `:50` |

`app/routes/*` modules are thin: they call guards, delegate to `app/features/<surface>/…` for UI
and to `app/server/…` for behavior. `resources.*` routes are **resource routes** — loader (and
sometimes action) only, no default export.

`docs/architecture/decisions.md:285-297` carries a route map that is now slightly behind: it omits
`/resources/search`, `/notifications/read` and `/prefs/theme`.

### 3.3 Loaders, actions, and the mutation contract

- Loaders return route-shaped data directly. JSON endpoints (rare, automation only) use
  `{ data, meta? }` on success and `{ error: { code, message, details? } }` on failure; route
  **actions are exempt** and return their own result shapes
  (`docs/architecture/decisions.md:49-72`).
- The canonical mutation shape is: **RBAC check → write the canonical file (atomic,
  frontmatter-preserving) → re-parse → re-project into SQLite → emit a projection event → SSE
  publish**. Never write a projection without file backing for task/project state
  (`docs/architecture/decisions.md:73-96`).
- **No optimistic UI for governed state.** Revalidate after the action and on SSE.
- Every governed action writes an audit event and, where user-visible, a typed timeline event
  inside `task.md`.
- The shared action preamble is `requireFormAction(request)`
  (`app/server/auth/form-action.server.ts:7-19`): requires auth, opens the db, parses `formData`,
  asserts CSRF against the already-parsed form data, and returns
  `{ auth, db, formData, actor, intent }`. `appErrorResponse(error)` (`:21-27`) converts an
  `AppError` into `data({ ok: false, error: userMessage }, { status })` and re-throws anything
  that is not an `AppError` (`:22`).

### 3.4 Middleware and request correlation

`app/root.tsx:55` exports `middleware = [requestContextMiddleware]` — the only `export const
middleware` in the tree. It binds one correlation id (AsyncLocalStorage,
`app/server/logging/request-context.server.ts`) for the whole request so every `logger.*` call
from any loader/action carries it with no call-site work. `entry.server.tsx:61` reuses that id for
the document render rather than minting a second one, and `handleError` (`entry.server.tsx:34-47`)
swallows aborted requests (`:35`) and route-not-found 404s (`:36`) while logging everything else.

`app/root.tsx:87-89` re-exports `headers({ loaderHeaders })` so the root loader's `Set-Cookie`
(better-auth rolling-session renewal) surfaces on routes that have no `headers` export of their own.

### 3.5 Authentication (better-auth)

The instance is built in `app/lib/auth.server.ts` and cached process-wide keyed to the current
`DatabaseSync` handle (`AUTH_CACHE_KEY = Symbol.for("viberr.betterAuth")` `:324`, `getAuth()`
`:332-368`, rebuild when `entry.db !== db` `:339`) so it rebuilds when tests reset the db singleton.

Key configuration (`buildAuthOptions`, `app/lib/auth.server.ts:112-314`):

| Setting | Value | Note |
| --- | --- | --- |
| `basePath` | `/api/auth` (`AUTH_BASE_PATH` `:35`, used `:142`) | mounted as a splat route |
| Cookie | `viberr.session_token` (`advanced.cookiePrefix: "viberr"` `:312`) | signed with `BETTER_AUTH_SECRET ?? VIBERR_SESSION_SECRET` (`:344`) |
| Session | `expiresIn` 30 days, `updateAge` 1 day (`:247-250`) | rolling, server-side rows in SQLite |
| Sign-up | `disableSignUp: true` (`:147`) | **no open registration on any path** |
| Password hashing | routed through the app's own `hashPassword`/`verifyPassword` (`:159-162`) | makes verification TOTAL — a legacy/unparseable hash reads as a wrong password (401), not a 500 |
| better-auth rate limiting | enabled (`:165`) with `/sign-in/email` and `/sign-in/social` set to `false` (`:184`, `:191`) | replaced by app-level buckets in the `before` hook: `` `${email}|${ip}` `` (`:221-230`) and `` `${provider}|${ip}` `` at 30/min (`:236-244`) — without a reverse proxy every sign-in would otherwise share one `no-trusted-ip` bucket = an org-wide denial-of-login lever |
| Account linking | enabled, trusted `github`/`google`/`credential` (`:263-266`) | preserves `user.id === users.id` |

**The `/api/auth/*` allow-list is a load-bearing invariant.** Because the handler is a splat,
*every* endpoint better-auth registers would otherwise be reachable — including
`/change-password`, `/update-user`, `/link-social`, `/list-accounts` — bypassing the app's own
audited, session-revoking flows. `ALLOWED_AUTH_PATHS` (`app/lib/auth.server.ts:53-60`, entries at
`:54-59`) enumerates the **driven** set and the `before` hook 404s everything else (`:218-220`):

```
/sign-in/email   /sign-in/social   /callback/:id   /error   /get-session   /sign-out
```

Entries are the endpoints' *declared* paths (params un-substituted, hence `/callback/:id`). The
hook pipeline also runs for server-side `auth.api.*` calls, which is why `/get-session` and
`/sign-out` must be listed.

OAuth is optional: the login buttons stay inert unless the provider env vars are set.
Provisioning is whitelist-based via `databaseHooks.user.create.before/after` (`:277-300`) — a new
social user is admitted only if `isOAuthWhitelisted` says so, and the provider is read off the
callback endpoint by `oauthProviderOf` (`:79-89`) rather than guessed (P13-D-22). A third hook,
`databaseHooks.account.create.after → linkOAuth` (`:303-310`), keeps the Viberr-side link honest.

Request-side guards live in `app/server/auth/require-user.server.ts`:

- `authenticateWithHeaders(request)` → `{ ctx, renewalHeaders }` (`:77-101`) — used by the **root
  loader only** (`root.tsx:62`), so the rolling-session `Set-Cookie` actually reaches the browser.
- `authenticate(request)` → `AuthContext | null` (`:114-118`).
- `requireAuth(request)` → `AuthContext` or a thrown redirect to `/login?returnTo=…` (`:154-164`;
  returnTo normalized off React Router's `.data` single-fetch URL in `loginRedirect`, `:128-146`).
- A disabled or vanished user has their better-auth session row deleted and reads as signed out
  (`:88-91`).

### 3.6 Project visibility — members-only, and the unknown-slug 404

This is the enforcement half of ruling R15-4, and the pass-16 doc did not describe it. Two
chokepoints produce a byte-identical “no such project” 404 for a signed-in non-member:

- **Reads** — the layout loader `app/routes/project.tsx:56-76`: `requireUser` `:56`, a board miss
  → `throw data("No project at projects/<slug>.", { status: 404 })` `:60`, and a non-member with
  no org-admin override → the same 404 at `:75`. Rationale comment `:40-46`.
- **Actions** — `requireVisibleProject` (`app/routes/project-visibility.server.ts:28-44`): the same
  `assertProjectAction("any-member", { allowArchived: true })`, converting *any* `AppError` into
  the 404 at `:40`. Wave 1 added the missing call sites (`project.agents.tsx:106`,
  `project.settings.tsx:64`, `project.github.tsx:48`) to join the pre-existing ones
  (`project.board.tsx:31`, `project.task.tsx:103` and `:312`, `project.policy.tsx:43`). Pinned by
  `app/routes/project-visibility-actions.server.test.ts:67-73`.

`requireProjectMember` (`app/server/auth/require-project.server.ts:20-45`) is unchanged and still
throws a **403** — it wraps `assertProjectAction`, which ends in `AppError.forbidden(...)`
(`app/server/auth/project-authority.server.ts:362`). That 403 is now user-visible only on the two
standalone resource routes with no parent layout loader: `app/routes/resources.run-log.ts:69` and
`app/routes/resources.session-export.ts:44`. Org admins pass every gate as the audited D2
emergency override.

### 3.7 CSRF (`_csrf` convention)

`app/server/auth/csrf.server.ts` (140 lines). Two layers:

1. **Origin / `Sec-Fetch-Site` / `Referer` check** — `assertTrustedOrigin`, `:57-94`. Current
   ordering: `Sec-Fetch-Site` present and not `same-origin`/`none` → 403 (`:58-65`); unparseable
   request origin → 403 (`:66-71`); `Origin: "null"` → 403 (`:73`); `Origin` present and
   mismatched → 403 (`:74-76`); `Referer` present and mismatched → 403 (`:79-90`); **all three
   absent → 403** (`:91-93`, rationale docblock `:47-55`, finding A7). This is the wave-1 change:
   the pass-16 tree let a request carrying none of the three signals through.
2. **Double-submit token bound to the session**: `HMAC-SHA256(VIBERR_SESSION_SECRET,
   "viberr-csrf:" + sessionId)`, base64url (`csrfTokenForSession`, `:20-24`), compared with
   `timingSafeEqual` after a length check (`:117-121`).

Field name is `CSRF_FIELD_NAME = "_csrf"` (`:17`). `X-Csrf-Token` is checked first (`:106-113`).
The token is produced by the **root loader** (`app/root.tsx:73`) and consumed via `<CsrfInput />`
or `useCsrfToken()` (`app/ui/csrf-input.tsx:10`, `:15`). Programmatic `fetcher.submit` calls must
set `_csrf` in the FormData.

**Every new mutating form needs `_csrf`.** The login action is the sole exception — it has no
session yet, so it uses `assertTrustedOrigin` (`app/routes/login.tsx:57`) plus rate limiting only.
`/api/auth/*` also has no `_csrf`: better-auth enforces its own Origin/`trustedOrigins` check
(`app/routes/api.auth.$.ts:4-10`).

### 3.8 SSE

Two endpoints and one broker.

**`GET /resources/events`** (`app/routes/resources.events.ts`, 187 lines) — the general stream.
Repeatable `scope` query params: `project:<slug>`, `task:<slug>/<key>`, `projects` (all-projects
firehose, used by Home), `user` (this session's targeted events + broadcasts). Reconnect position
comes from the native `Last-Event-ID` header (`:139-141`). An unauthenticated (or
password-reset-pending) EventSource cannot render a login page, so it returns plain 401 JSON
(`:62-68`). `MAX_QUEUED_CHUNKS = 1024` bounds a stalled client (`:59`, enforced `:149-152`).

Per the HTML spec an EventSource that receives a non-200 **fails permanently and does not
reconnect**, so recovery is the client's job (docblock `:33-40`; see §7.7).

**Subscription authorization (D9), `:100-137`** — invalid scope → 400 (`:76-85`); zero scopes →
400 (`:88-98`); org admins get every scope as asked (`:111-112`); non-admins have `projects`
**expanded to only their member projects** and explicitly-named foreign `project:`/`task:` scopes
**dropped** (`:114-123`); a non-member left with nothing → 403 (`:126-136`).

**`GET /resources/run-log`** (`app/routes/resources.run-log.ts`, 88 lines) — the seq-based tail the
agent-log console uses after a `run.log-appended` reference arrives. `requireUser` `:40`,
`requireProjectMember` `:69`; params `runId` (400 if absent, `:43-48`), `since` (default `-1`,
`:53`) | `before` (`:54`), `limit` clamped 1..500 (`:58`). Unknown run → 404 (`:62-67`), which is
evaluated *before* the membership gate.

**Broker** (`app/server/events/sse-broker.server.ts`):

| Fact | Value |
| --- | --- |
| Heartbeat | `": hb\n\n"` every `25_000` ms per connection (`:41`, `:172`, interval `:291-295`, `unref`'d) |
| Replay ring buffer | last `256` events with monotonic ids (`:42`, trim `:315-317`) |
| Wire format | `id: <n>\nevent: <name>\ndata: <single-line JSON>\n\n` (`formatSseMessage`, `:167-169`) |
| Connect hello | `retry: 5000` + a `stream.open` event carrying `headId` (`:251-261`) |
| Routing | exactly one of `userId`, `broadcast`, or `projectSlug` (+optional `taskKey`) — `routeMatchesConnection` `:85-108` |
| Stale reconnect | `Last-Event-ID` older than the buffer window → `stream.resync` control event (`:277-287`), client revalidates once |
| Singleton | `Symbol.for("viberr.sseBroker")` (`:137`) — HMR-safe |

**The broker owns the process's only signal handler** (`:152-160`). `SIGINT`/`SIGTERM` run
`runProcessShutdown()` (`:358-366`) then re-raise. `armProcessShutdown()` (`:354-356`) is called
**eagerly** from `boot.server.ts:209` — registration is no longer lazy-on-first-connection,
because on a warm store with no connections `docker compose stop` previously ran no handler at all
(docblock `:345-353`). Skipped when `NODE_ENV === "test"`.

Two publish paths:

- **Projection events** — `app/server/events/projection-events.server.ts` (8 event variants
  `:11-44`, `emitProjectionEvent` `:65-71`, `collectProjectionEvents` defer-until-commit `:82-95`)
  feeds `event-publisher.server.ts`, whose `translateProjectionEvent` (`:51-145`) converts each
  into `{ type, entityId, occurredAt, data }` plus a route, validates it against
  `sseEventSchema.parse` and only then publishes (`:188`).
- **Direct-to-broker**, deliberately bypassing the emitter, for high-frequency streams:
  `publishRunLogAppended` (`app/server/runtimes/run-events.server.ts:12-34`) and
  `publishRunStateChanged` (`:36-58`). Routing chatty events through the emitter would imply a
  projection rebuild per event.

`SSE_EVENT_NAMES` (`app/schemas/sse-event.schema.ts:22-40`) — 12 names:
`task.updated`, `task.removed`, `project.updated`, `project.removed`, `projection.rebuilt`,
`notification.created`, `notification.read`, `violation.updated`, `run.log-appended`,
`run.state-changed`, `stream.open`, `stream.resync`.
(`docs/architecture/decisions.md:64-66` still names `task.readiness-changed` and
`auth.session-expired`; neither exists.)

SSE payloads are **compact facts and references, never fat objects**, and the wire shape is parsed
against the schema before publish because it is a contract.

---

## 4. Data layer

### 4.1 SQLite via `node:sqlite`

There is **no third-party SQLite driver** — the app uses Node 26's built-in `DatabaseSync`.
`app/server/db/sqlite.server.ts`:

```ts
// openDatabase(), :12-19
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;`);       // :15-17
```

- Path: `${VIBERR_DATA_ROOT}/state/projection.sqlite` (`getProjectionDbPath`, `:22-25`).
- `getDb()` (`:35-53`) is a process-wide singleton on `Symbol.for("viberr.db")` (`:28`) so it
  survives HMR; on first open it applies pending migrations and logs `sqlite ready` (`:45`).
- `shutdownDatabase()` (`:84-106`) is the graceful path: `PRAGMA wal_checkpoint(TRUNCATE)` (`:92`)
  then close (`:99`). The docblock (`:66-83`) records why: an exited container was observed leaving
  a 4.1 MB `projection.sqlite-wal` beside a stale main file — and this database is **primary
  storage** for users, sessions, PATs, audit and notifications, rows no rescan can rebuild.
- `withTransaction(db, fn)` in `app/server/db/transaction.server.ts`.

### 4.2 Migrations — squashed into `0001` (owner ruling, pre-prod)

`db/migrations/` contains exactly one file: **`0001_baseline.sql`, 413 lines**. Its header
(`:1-19`, convention paragraph `:10-19`) is binding:

> Collapses the original 13-file migration history … We are pre-prod: no deployed database needs
> the incremental chain … **while pre-prod, schema changes are squashed INTO this baseline — no
> incremental migration chain is kept.** The runner records this filename in `schema_migrations`
> and skips by FILENAME alone, so editing this file reaches FRESH databases only … after pulling a
> baseline change, wipe the sqlite and re-seed (`npm run seed -- --reset`). **Because users/auth
> live in the same file, a wipe regenerates user ids.**

**Implication: if you add a column, edit `0001_baseline.sql` in place, then wipe and re-seed your
local DB. Do not add `0002_*.sql`** until the owner lifts this ruling at first deployment. A
running dev DB created before your edit will throw on the first write to the new column, and a
re-baseline invalidates every existing user id.

`runMigrations` (`app/server/db/migration-runner.server.ts:28-81`) applies every `*.sql` in
filename order, each inside its own transaction together with its `schema_migrations` bookkeeping
row (`:62-65`). Migration files must not contain `BEGIN`/`COMMIT` (docblock `:21-27`). A failure
raises `AppError` with `ERROR_CODES.DB_MIGRATION_FAILED` (`:69-75`). `DEFAULT_MIGRATIONS_DIR`
resolves against `process.cwd()` (`:9-12`) — which is why the Dockerfile copies `db/` into the
runtime stage.

### 4.3 Tables

**25** `CREATE TABLE` statements. Grouped by role:

| Group | Tables |
| --- | --- |
| **Primary storage** (no rescan can rebuild these) | `users:23`, `audit_events:37`, `notifications:165`, `user_prefs:180`, `github_pats:187`, `project_github_credentials:197`, `github_connections:214`, `google_domain_allowlist:224`, `org_knowledge_bases:230`, `org_mcp_servers:240`, `org_skills:252`, `agent_runs:259`, `run_log_lines:302`, `staged_outcomes:409`, and better-auth's own `user:338` / `session:339` / `account:340` / `verification:352` |
| **Derived projections** (rebuildable from files) | `projects:49`, `project_members:66`, `task_projections:72`, `task_events:126`, `diagnostics:144`, `provenance:156`, `scope_violations:203` |

Naming: plural snake_case tables, snake_case columns, `<entity>_id` FKs, `idx_<table>__<cols>`
indexes. Rows map to camelCase **only** through `app/shared/mapping/*` — never ad hoc at a call
site (`docs/architecture/decisions.md:49-72`).

Load-bearing unique indexes (invariants, not tuning):

```sql
-- :394-396 (comment :381-393) — one delivering engagement per task
CREATE UNIQUE INDEX idx_agent_runs__one_delivering ON agent_runs (project_slug, task_key)
  WHERE kind = 'primary' AND state IN ('queued','running');
-- :382-383 — thread uniqueness (a resume mints a fresh thread id)
CREATE UNIQUE INDEX idx_agent_runs__thread ON agent_runs (project_slug, task_key, thread_id);
-- :397 — dense per-run log sequence
CREATE UNIQUE INDEX idx_run_log_lines__run_seq ON run_log_lines (run_id, seq);
-- :375-377 — one open violation per (project, scope), a fourth genuine invariant
CREATE UNIQUE INDEX idx_scope_violations__open_unique ... WHERE status = 'open';
```

`startRun` catches SQLite errcode `2067` (CONSTRAINT_UNIQUE) on the first and turns it into a 409
(`app/server/runtimes/run-service.server.ts:373-387`, gated on `kind === "primary"` at `:376`).

**Schema comments wave 3 corrected — read these before touching the columns:**

- `task_projections.repo` (`:99-103`) — the “task-level override” it used to document was deleted
  by P13-D-5. The rebuilder writes `project.repo ?? null` unconditionally; the column is a
  denormalization so task-detail GitHub links resolve without a join. **It is not dead** (pinned
  by `app/server/projections/rebuilder.server.test.ts:309-350`).
- `agent_runs.kind` (`:265-274`) — not a role taxonomy, the **delivery axis**. `'operator'` is the
  operator runtime's own run; every other run is tagged `'primary'` when it *delivers* and
  `'reviewer'` when it merely supports. A non-delivering developer is stored as `'reviewer'`; the
  real role rides `role`. `kind` CHECK at `:275`, `state` CHECK at `:280-281`.
- `verification` (`:341-351`) — **KEEP.** It reads as dead (no app query names it) and pass 16 came
  one edit from dropping it. better-auth writes it on every OAuth sign-in (`storeStateStrategy`
  resolves to `"database"`; state is INSERTed at `/sign-in/social`, read-then-deleted at
  `/callback/:id`). Dropping it kills GitHub/Google login. Pinned by
  `app/server/db/migration-runner.server.test.ts:71-76`, canaried by deleting the CREATE TABLE.
- better-auth provenance block (`:311-336`) — the four better-auth statements are verbatim
  `npx @better-auth/cli@1.6.25 generate` output; the CLI is deliberately not a dependency; a
  step-by-step refresh recipe is at `:322-335`, including that `githubHandle` on `user` is
  Viberr's own additional field and that there is no ALTER path — re-baseline.

Bounded growth: `applyRetention(db)` (`app/server/db/retention.server.ts`) compacts exactly three
tables at boot — `run_log_lines` by age (`RUN_LOG_RETENTION_DAYS = 30`, `:21`), `audit_events` by
age (`AUDIT_RETENTION_DAYS = 90`, `:23`), `notifications` newest-N-per-user
(`NOTIFICATION_MAX_PER_USER = 500`, `:47`). **`IDEMPOTENCY_AUDIT_ACTIONS` (`:42-45`) —
`task.agent.replied` and `runtime.operator.plan_executed` are exempt from the audit window**
because boot recovery uses their existence as an idempotency key; deleting one makes the next boot
replay the effect (docblock `:25-41`). Canonical task files are never touched.

### 4.4 `VIBERR_DATA_ROOT` and the file-native store

`app/server/files/file-store-root.server.ts` is the single source of data-root paths.
`getDataRoot(dataRoot?)` resolves `dataRoot ?? getEnv().VIBERR_DATA_ROOT` to an absolute path
(`:40-42`); every helper accepts an optional override so tests and scripts can point at a temp root.

`DATA_ROOT_SUBDIRS` (`:23-37`), all created at boot by `ensureDataRootDirs()` (`:45-51`):

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

UI copy renders **real store-relative paths** (`projects/viberr-core/tasks/VIB-142/task.md`), never
a `.viberr/…` fiction — `storeRelativePath()` (`:154-157`).

**Path-traversal containment**: `resolveStoreSegment(root, name)` (`:108-127`) rejects separators,
dot-segments, absolute paths and NUL before joining (`:109-119`) and re-checks containment against
the resolved root (`:123`), because a KB/skill name comes from a profile's resource array and the
resolved content is injected as **trusted persona material** — crossing a prompt trust boundary.
`kbDirPath` (`:135-137`), `skillDirPath` (`:145-147`) and `agentProfileFilePath` (`:88-94`) all
route through it. Injection readers catch the throw and degrade to “inject nothing” while logging
the denial. Wave 1 extended the same symlink containment KB bodies had to **skill bodies**
(`app/server/files/skill-body.server.ts`).

**Atomic writes**: `writeFileAtomic` (`app/server/files/atomic-file.server.ts:10-15`) writes
`<target>.<8 hex>.tmp` then renames over the target, so readers and the watcher never see a
half-written file. The watcher explicitly ignores `*.tmp`. Per-file serialization is
`app/server/files/file-mutex.server.ts` (6 lines, delegates to `navigator.locks.request`).

Canonical file formats are documented in `docs/architecture/file-formats.md` — `project.md` (§1
`:50`), `task.md` frontmatter + Goal + Packet + Timeline grammar (§2 `:122`), actor references
(§3 `:304`), agent-profile templates (§4 `:313`), and §5 “What is deliberately NOT in files”
(`:352`). The Zod contracts are `app/schemas/task-file.schema.ts` (1232 lines, the largest) and
`app/schemas/project-file.schema.ts`.

**Tolerant parsing is a contract** (`app/schemas/task-file.schema.ts:9-21`, bullets `:13-17`):
unknown frontmatter fields are *preserved* and re-written verbatim by the serializer; missing or
invalid fields produce structured `FileDiagnostic`s; **the parser never throws and never drops a
task**. The paired readiness downgrade (`input_required` / `inconsistency_risk_detected` /
`blocked`) lives in `app/server/interpretation/readiness-policy.server.ts`, not in the schema.

### 4.5 Projection rebuild

`app/server/projections/rebuilder.server.ts` (799 lines, docblock `:34-47`):

- `rebuildAll` (`:704`) — full rescan of `${dataRoot}/projects`, projecting every `project.md` and
  `tasks/<KEY>/task.md`, pruning rows whose files vanished.
- `rebuildPath` (`:581`) — single-file incremental, driven by the file watcher **and by every
  mutation** (“write file → reproject”). `rebuildProject` `:621`, `rebuildProjectFile` `:145`,
  `rebuildTaskFile` `:323`.
- **Content-hash short-circuit** (`sha256` `:85`; short-circuits `:177-178`, `:366-367`) — an
  unchanged file is not re-projected and records no provenance. `RebuildOptions.force` (`:49-59`)
  bypasses it.
- Every acting rebuild records provenance (`projected`/`removed`/`error`); a full rescan adds one
  summary `rescan` row.
- Emits change events through the in-process projection emitter, which the SSE publisher subscribes
  to.
- **Wave 3 change**: `acceptanceBlockReason` (`:294-322`) now evaluates
  `closedPrBlockedReason(fm, fm.key)` **first**, before the reviewer gate (`:306-307`) — ruling
  R16-3, so the projected `acceptance_block_reason` names the terminal GitHub fact ahead of the
  process gate.

Entry points in `app/server/projections/rescan.server.ts`: `rescanProjections(db, …)` (`:10-24`,
used at boot, by `npm run rescan`, and by Home's Re-scan) and `rescanProject(db, slug, …)`
(`:32-46`, the Board's Re-scan, gated on `rescan-project`).

The full directory (12 modules) — the pass-16 doc named only two:

| File | Role |
| --- | --- |
| `rebuilder.server.ts` (799) | files → SQLite projector |
| `rescan.server.ts` (48) | audited instance-wide / project-scoped rescan entry points |
| `rebuild.server.ts` (61) | **recovery hammer** `rebuildProjections`: DROP `task_events`/`diagnostics`/`task_projections`/`projects` then a full forced rebuild in one transaction, events emitted post-commit |
| `single-flight.server.ts` (78) | per-key **cooldown** (not a mutex) throttling the rescan/rebuild buttons (P13-D-33); returns `ran` or `throttled` + `retryAfterMs` |
| `board-query.server.ts` (227) | board/home read models |
| `task-query.server.ts` (136) | task-detail read models |
| `review-queue.server.ts` (184) | review-queue read model keyed on the project's resolved review stage |
| `decisions.server.ts` (214) | the single source of “which open decisions require this user's action” — Home, project cards, notifications, board chip, review queue all call `indexDecisionInbox` |
| `activity-feed.server.ts` (390) | activity read models over `task_events` |
| `notifications.server.ts` (311) | per-user notification rows, monotonic read state |
| `agent-deployments.server.ts` (154) | live engagement instances |
| `policy-violations.server.ts` (253) | scope-violation records + lifecycle |

### 4.6 The single-writer constraint (B-FD1) — **ONE app process per data root, EVER**

The most important operational invariant in the repo, and it is *enforced*.
`app/server/db/data-root-lock.server.ts:9-37`:

> Two processes pointed at one root is not a slow path, it is corruption: it has bitten this
> project twice — a host dev server and a compose container sharing `docker-data` over VirtioFS
> clobbered the WAL and ate PATs and run logs, and the run pipeline's handles/completion callbacks
> are per-process globals, so process B “interrupts” a run that process A is still driving and A
> overwrites the state at finalize.

Mechanism:

- Boot takes an exclusive `O_EXCL` lock at `<dataRoot>/state/writer.lock`
  (`DATA_ROOT_LOCK_FILENAME`, `:40`) whose content is `{ pid, hostname, startedAt, bootId }`.
- `takeDataRootWriterLock(env)` (`app/server/boot.server.ts:150-169`) runs **before anything opens
  the database or writes a file** (`boot.server.ts:204`). On a `DataRootLockedError` it prints the
  refusal to stderr and `process.exit(1)` — a refusal to boot, not a crash, because `bootServer` is
  awaited from `entry.server.tsx` module scope and an escaping throw would surface as an SSR crash
  page instead of the one message that diagnoses the problem.
- Staleness is decided by **evidence, never a timeout** (`classifyLock`, `:194-206`): same-host +
  pid gone → stale, auto-taken-over; same-host + pid alive → held, refuse; **different host →
  refuse** (cannot probe — exactly the docker-data incident shape); unreadable lock → refuse.
  Takeover retries up to 3 times and refuses if it loses the re-create race (`:266-324`).
- `bootId` is a per-OS-process UUID kept on `globalThis` (`:130-139`, rationale `:50-62`). It
  exists because `compose.yml` pins `hostname: viberr`, making “same host” trivially true for every
  container from that file, and two containers over one data root routinely land on the same low
  pid.
- Release happens on `process.once("exit")` **and** explicitly in the signal shutdown before the
  re-raise (`releaseDataRootLock`, `:154-156`) — the `exit` event never fires when the handler
  re-raises SIGTERM.
- Escape hatch: `VIBERR_FORCE_DATA_ROOT_LOCK` (`FORCE_LOCK_ENV`, `:43`) accepting `1|true|yes`
  (`:159-162`) for one boot.

**Practical rule for agents working in this repo: a dev server or compose container is usually
already running against `docker-data`. Do not start a second one, and do not run
`npm run seed`/`rescan` against a data root a live process holds.**

---

## 5. Background machinery and the boot sequence

Everything starts from `bootServer()` (`app/server/boot.server.ts:179-311`), awaited at
`app/entry.server.tsx:21` **module scope**, guarded by `Symbol.for("viberr.booted")` (`:36`, guard
`:181`) so it runs once per process and survives HMR.

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
| 15 | `applyRetention(db)` | `279` |
| 16 | `void reconcileRestartedWork(db)` — fire-and-forget recovery chain (below) | `288` |
| 17 | `startScheduleRunner(db)` | `294` |
| 18 | `startGithubReconcilePoller(db)` | `300` |
| 19 | `logBootIntegrity(db)` — dirs, migration state, projection counts | `302` |
| 20 | `logger.info("viberr server booted", …)` | `304-308` |
| 21 | `cache[BOOT_KEY] = true` — **set LAST**, so a throw anywhere above leaves boot re-runnable | `310` |

`reconcileRestartedWork(db)` (`:97-125`) is one ordered, self-catching chain — each step
idempotent, one failure never stopping the next, none blocking boot:

1. `recoverUnreactedAgentRuns(db)` (`:99`) — a specialist/reviewer run that finished before its
   in-process reply callback fired left the task at `waiting=agent` with no error. Post the reply
   and re-invoke the operator.
2. `recoverStrandedOperatorPlans(db)` (`:106`) — a Codex operator coordinates *after* its run
   finishes, so a restart loses the whole turn.
3. `reclaimTerminalTaskWorkspaces(db)` (`:113`) — each task that ever ran a specialist holds an
   11–16 MB working tree; the clone is a cache (canonical state is `task.md`, delivered work is on
   the remote) and a reopened task re-clones. **Sequenced after the recovery steps** (P14-RT-09,
   docblock `:91-95`) so a recovered run's delivery reconcile cannot race the `rmSync`.

### 5.1 Store watcher — `app/server/files/file-watch.service.server.ts`

Watches `${dataRoot}/projects` with **chokidar 5**. Chokidar supplies typed
`add`/`change`/`unlink`/`unlinkDir` events with real paths (no rename inference), atomic-write
coalescing, and portable recursion; everything domain — debounce, ignore rules, rebuilds, removal
reconciliation, lifecycle — stays Viberr code (`:10-30`).

| Fact | Value |
| --- | --- |
| Debounce | `WATCH_DEBOUNCE_MS = 250` trailing, **per path** (`:32`) |
| Options | `{ ignoreInitial: true, ignored: shouldIgnoreWatchPath, followSymlinks: false, atomic: true }` (`:223-228`) |
| Ignored | dotfiles, `*.tmp`, and anything deeper than `projects/<slug>/tasks/<KEY>/task.md` (`:77-85`, depth rule `:83-84`) — this prunes traversal so the watcher never enters workspace clones (F-SPAWN1) |
| Handled files | only basenames `project.md` and `task.md` (`:215-221`) |
| Dir removal | `unlinkDir` maps onto the projection rows it backed (`:147-210`): projects root → reconcile every projected project (`:183-190`); `<slug>` (`:192`) / `tasks` (`:194`) → reconcile the project; `tasks/<KEY>` → reproject that task (`:195-202`); deeper → ignored |
| Singletons | `Symbol.for("viberr.fileWatcher")` (`:34`) + `Symbol.for("viberr.fileWatcherLifecycle")` (`:54`) |
| Health | `isFileWatcherAlive()` (`:301-304`) backs `/resources/health` `watcher` |
| Error policy | `ENOENT` is **not** fatal (`:244-247`) — deleting a watched subtree races chokidar into a spurious ENOENT while the unlink reconcile is still queued, and killing the watcher there orphaned projections. Other errors clear the handle so health reports the truth (`:255-260`), then re-arm after 2 s for transient FS pressure (`EMFILE`/`ENFILE`/`ENOSPC`/`EPERM`/`EACCES`, `:268`) with an **owned, generation-guarded, `unref`'d** timer so teardown can cancel it (F10-08, `:269-289`) |

`ignoreInitial: true` pairs with the boot rescan (step 10): offline drift is reconciled before the
watcher starts. Chokidar arms asynchronously, so an external edit landing inside the sub-second
initial-scan window is picked up on its next touch or a manual rescan; **route actions project
synchronously and never depend on the watcher.**

### 5.2 KB watcher — `app/server/files/kb-watch.service.server.ts`

Same shape, watching `${dataRoot}/kb`. `KB_WATCH_DEBOUNCE_MS = 250` **per KB directory** (`:31`);
the changed path's first segment under `kb/` names the KB to re-index (`kbDirOfChange`, `:42-49`);
handles `add`/`change`/`unlink`/`addDir`/`unlinkDir` (`:109-114`); dispatches
`reindexKnowledgeBaseByDir` (`:72` — a KB pinned to “manual” is skipped inside that function).
Returns `null` and does not start if `${dataRoot}/kb` does not exist (`:65`), and the `watch()`
call itself is try/caught to `null` (`:103-121`). Same ENOENT tolerance (`:128-131`),
handle-clearing (`:141-145`) and 1 s transient re-arm (`:147-160`) — **note its re-arm is not
generation-guarded** (only an `undefined`-handle check at `:150`), unlike the store watcher's
F10-08 fix. `isKbWatcherAlive()` (`:171-174`) backs `/resources/health` `kbWatcher`.

### 5.3 Schedule runner — `app/server/tasks/schedule.server.ts`

Fires due scheduled operator re-runs (“re-check this in 24h”). `SCHEDULE_TICK_MS = 60_000` (`:39`):
once at boot (catching anything due while down), then every minute (`:491`); the timer is `unref`'d
(`:493`). It calls `runOperator` (`:392-396`), which is backend-agnostic — so this works identically
for Claude and Codex with no per-backend agent tool. The schedule lives in the task **file**
(canonical, survives rebuild); `schedules_json` on the projection lets the runner find due entries
without reading every file. Crash-safety: an occurrence is CLAIMED in the file
(`pending → claimed`, `:317-349`) before `runOperator` is invoked and finalized to `fired` only
once the enqueue returned (`:416-435`); a claim carries a `CLAIM_LEASE_MS` lease so a stale claim
is re-driven by a later tick (`:269-274`) rather than lost.

### 5.4 GitHub reconcile poller — `app/server/github/reconcile-poller.server.ts`

`RECONCILE_POLL_MS = 5 * 60_000` (`:22`) — every active (non-archived) project that has task
branches, once at boot then every 5 minutes, so a PR merged/closed out-of-band surfaces
automatically instead of only when a maintainer clicks “Update status”. Non-overlapping via a
`running` flag (`:191-204`). Poller ticks pass `skipProjectAudit: true` (`:129`),
`taskBudget: RECONCILE_POLL_TASK_BUDGET` (`:127`, the B-GH5 rate-limit slice) and
`skipUnchangedProvenance: true` (`:130`). Best-effort per project (`:122-140`) — one project's
GitHub failure never aborts the others.

It also runs `nudgeMergePendingTasks` (F12-05, `:39-93`): a task accepted into Done whose PR is
still open gets one deduped notification, because `merge-pull-request` is always-human and an
autonomous operator's self-acceptance cannot merge. **Wave 1 (B9) replaced the JSON *substring*
match** — a PR *title* containing `"state":"accepted"` satisfied it just as well — with
`json_valid(t.pr_json) AND json_extract(t.pr_json, '$.state') = 'accepted'` (`:53-55`, rationale
`:44-46`). Dedupe is still by exact notification title scoped to `(project_slug, task_key,
kind='policy')` (`:67-74`).

### 5.5 Shutdown

`runProcessShutdown()` (`sse-broker.server.ts:358-366`), armed by `armProcessShutdown()` at
`boot.server.ts:209`, runs in this order: `closeAllSseConnections()` → `stopFileWatcher()` →
`stopKbWatcher()` → `shutdownDatabase()` (WAL TRUNCATE checkpoint + close) →
`releaseDataRootLock()` — then re-raises the signal. The watcher stops are deliberately **before**
the DB close so no debounced rebuild fires into a shut-down database (`:360-361`). The Dockerfile
runs the server binary directly rather than `npm run start` specifically so node is pid 1 and the
SIGTERM reaches it (`Dockerfile:73-81`).

### 5.6 Process-wide singletons

Twenty `Symbol.for("viberr.*")` keys on `globalThis`, all HMR-safe. Knowing the list saves you from
inventing a 21st:

`viberr.betterAuth`, `viberr.booted`, `viberr.dataRootLock`, `viberr.db`, `viberr.env`,
`viberr.eventPublisher`, `viberr.fileWatcher`, `viberr.fileWatcherLifecycle`,
`viberr.githubReconcilePoller`, `viberr.kbWatcher`, `viberr.loginRateLimiter`,
`viberr.modelCatalog`, `viberr.operatorLease`, `viberr.patValidationRateLimiter`,
`viberr.processBootId`, `viberr.projectionEvents`, `viberr.runService`, `viberr.runtimeRegistry`,
`viberr.socialStartRateLimiter`, `viberr.sseBroker`.

---

## 6. Runtime adapters (Claude / Codex)

### 6.1 The adapter interface

`app/server/runtimes/adapter.server.ts:111-115` (115 lines, unchanged since the pass-16 doc):

```ts
export interface RuntimeAdapter {
  readonly backend: RunBackend;            // "claude" | "codex"
  start(spec: RunSpec, cb: RunCallbacks): RunHandle;
}
```

- `RunSpec` (`:13-71`): `runId, projectSlug, taskKey, threadId, role, kind, backend, model,
  effort?, prompt, workdir, resumeSessionId?, autonomous?, systemPrompt?, mcpServers?,
  allowedTools?, disallowedTools?, repoWriteWithheld?, webSearchWithheld?, outputSchema?, env?`.
- `RunExit` (`:86-93`): `{ outcome: "finished"|"error"|"interrupted", effectiveBackend, sessionId? }`.
  **Outcome comes from the stream, never an exit code** (`:85`).
- `RunHandle` (`:104-109`): `{ runId, interrupt() }`, idempotent.
- `allowedTools`/`disallowedTools` are **Claude-only** (`:44-49`); `repoWriteWithheld` (`:50-55`)
  and `webSearchWithheld` are the Codex-side compensations.

There is no dynamic registry map — adapters are a two-field struct `AdapterSet { claude, codex }`
(`runtime-registry.server.ts:422-425`) built once per process by `createAdapters()` (`:510-561`)
and cached on `Symbol.for("viberr.runService")` (`run-service.server.ts:90-100`).
`selectAdapter(backend)` (`runtime-registry.server.ts:584-593`) returns `{kind:"real"}` or
`{kind:"unavailable"}` and refreshes the Codex auth mirror per run.

`RunKind` = `operator | primary | reviewer`; `RunState` = `queued | running | finished | error |
interrupted` (CHECK constraints at `db/migrations/0001_baseline.sql:275` and `:280-281`).

### 6.2 Claude — SDK, and the env-REPLACE fact

`@anthropic-ai/claude-agent-sdk`'s `query()`, lazily imported and cached
(`claude-runtime.server.ts:269-277`). The prompt is fed as a streaming-input async iterable of one
`SDKUserMessage` purely so `Query.interrupt()` is available (`:22-25`, `singlePrompt` `:259-267`).

**The SDK's `env` option REPLACES the child process environment — it does not merge.**
`runtime-registry.server.ts:482-496`:

> The SDK REPLACES the child `claude` process env with the `env` we pass — verified in the bundled
> sdk.mjs (`env = options.env` when provided; only a default `{...process.env}` when omitted). So
> filtering here is REAL: the spawned agent never sees a variable we drop.

The same is true of `@openai/codex-sdk` (`envOverride` replaces wholesale). Practical consequence:
the env you pass must be *complete* — `codex-runtime.server.ts:482-489` notes that overlaying
`spec.env` on `{}` would strip `PATH`/`HOME` and break the spawned binary.

Env construction: `filteredSpawnEnv()` (`runtime-registry.server.ts:446-455`) starts from
`process.env` and drops everything matching `CREDENTIAL_ENV_RE` (`:441-442`) or
`PRIVATE_RUNTIME_ENV_RE` (`DATABASE_URL|REDIS_URL|SSH_AUTH_SOCK|GPG_AGENT_INFO`, `:443-444`), then
`claudeSpawnEnv()` (`:497-507`) re-adds only `CLAUDE_CONFIG_DIR` + the selected credential.
Before F10-02 the raw `process.env` was spread through and leaked session secrets, the encryption
key, the GitHub PAT and every provider key to the agent. The same regex feeds the *output*
redactor in `run-sink.server.ts:117-137`, which is now **two rules**: exact env values plus
anchored token-shape patterns (`:100-111`).

| Concern | Where |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | `claude-config.server.ts:25-32` — explicit env wins → `VIBERR_CLAUDE_USE_CLI_AUTH` → `~/.claude` → else `${VIBERR_DATA_ROOT}/runtimes/claude-home`. `resolveClaudeConfigDirFrom(env)` (`:34-53`, new in wave 1) applies the same order to a raw env snapshot, because availability probes must be live while `getEnv()` is a process-lifetime cache |
| Resume | `options.resume = spec.resumeSessionId` (`claude-runtime.server.ts:541`); session id captured from `system·init` facts |
| Tool confinement | `disallowedTools` is the real mechanism: `BASE_DENIED_BUILTINS` (`:229-257`, 26 entries) + kind-specific sets + `spec.disallowedTools`, composed at `:581-588`. `allowedTools` (`:568-570`) only skips the permission prompt — it does **not** remove tools from context (`:52-57`) |
| Isolation | `settingSources: []`, `skills: []`, `plugins: []` (`:537-539`). `skills: []` does *not* empty the skill set — the SDK compiles ~16 first-party skills into its binary and still exposes the `Skill` tool, which is why `Skill` is denied (`:528-536`) |
| Permission mode | `bypassPermissions` when `spec.autonomous`, else `"default"` (`:515`) — **deny still binds under bypass**, which is what makes `specialist-tool-policy.ts` real enforcement |
| Turn cap | `DEFAULT_CLAUDE_MAX_TURNS = 2000`, `VIBERR_CLAUDE_MAX_TURNS` (`:331-336`). A runaway guard, not a work budget |
| Idle timeout | 15 min default, `VIBERR_CLAUDE_IDLE_TIMEOUT_MS` (`:152-157`); on fire → `interrupt()` → `run·error·idle_timeout` (`:471-493`) |
| Error handling | `classifyClaudeError` (`:338-392`) → `quota\|auth\|session_missing\|unknown`; raw error text is never persisted, only the class rides the tag |

**Capability → tool confinement.** `app/server/tasks/specialist-tool-policy.ts` (213 lines) maps the
repo-mutating capability grants to concrete Bash tool specifiers and builds the run's
`disallowedTools`. Its polarity is safe-by-default (P14-LV-01): a delivery or verdict capability is
granted **only** when a grant says so; “no grant at all” means withheld. The two Codex-side
compensations (`repoWriteWithheldFromDenylist`, `webSearchWithheldFromDenylist`, derived in
`run-service.server.ts:265-297`) are computed from this same list. Ruling **R16-5**: MCP grants
stay outside the capability matrix, and `specialist-tool-policy.test.ts` pins the *absence* of an
`mcp__*` deny rule so the tempting “obvious fix” cannot silently revoke read-only servers.

### 6.3 Backend availability and credential health (new in wave 1)

`isBackendAvailable(backend)` (`runtime-registry.server.ts:296-317`) is no longer a pure
env-presence probe. It never makes a paid call, but the CLI-auth opt-ins are now *verified*:

| Export | Lines | Role |
| --- | --- | --- |
| `codexCliAuthDiagnostics(env)` | `:124-155` | live re-probe; returns `runHome`, `sourceIsRunHome`, `defaultLoginPath`, `defaultLoginExists`. `codexCliAuthUsable` (`:84-86`) is a thin wrapper |
| `codexAuthMisconfiguration(diag)` | `:171-183` | **D1** — names the “`CODEX_HOME` points at Viberr's own run home” trap and tells the operator to *unset* it. Escalated to `logger.error` at `:304-314` |
| `claudeCliAuthDiagnostics(env, platform)` | `:185-260` | **D2** — three-tier verification `file` \| `presence` \| `refuted`; `presence` is the normal darwin/Keychain state, `refuted` (config dir absent) reports unavailable |
| `claudeCliAuthUsable(env)` | `:262-265` | consumed by `hasCredential` at `:280`, symmetric with the Codex branch |
| `backendCredentialHealth(backend, env)` | `:327-399` | the single source for “why is this backend (un)available”: `verification: "credential"\|"file"\|"presence"\|"none"` plus an actionable sentence. Consumed by the Agents page, `run-service.server.ts:500-517` and the boot logs |

A raw `ANTHROPIC_API_KEY` / `CODEX_ACCESS_TOKEN` is still presence-only, so an **expired** token
still reads “real”. Commit `0955ac9` fixed the last machine-dependency here: `defaultLoginPath` now
derives from `env.HOME ?? env.USERPROFILE ?? os.homedir()` (`:137`, mirrored in
`codex-config.server.ts:58`) instead of reading `os.homedir()` directly — the previous form made
the D1 test pass on any box with a real `~/.codex` and fail on CI.

### 6.4 Codex — SDK, CODEX_HOME, and the confinement asymmetry

`@openai/codex-sdk`: `new Codex(opts)` (`codex-runtime.server.ts:504-509`) → `startThread` /
`resumeThread` (`:546-548`) → `thread.runStreamed(prompt, { signal, outputSchema? })` (`:552-557`)
→ `for await (event of events)` (`:559`).

Two distinct directories (`codex-config.server.ts`, 171 lines):

- `resolveCodexAuthSource(env)` (`:50-59`) = `env.CODEX_HOME || <env-derived $HOME>/.codex` — the
  **human's** login dir.
- `resolveCodexHome(env)` (`:67-73`) = `${VIBERR_DATA_ROOT}/runtimes/codex-home` — the **app-owned**
  run home.
- `prepareCodexHome(env)` (`:121-171`) mirrors `auth.json` into the run home: mode gate `:130-132`,
  live-symlink short-circuit `:147-148`, mtime refresh `:149-157`, symlink→copy fallback
  `:158-162`, never throws `:164-169`. Called **per run** from `selectAdapter` (P14-RT-05).
- `codexSessionRoots(env)` (`:78-84`) returns run home + login dir so pre-split transcripts stay
  exportable.

The dedicated home exists because the Codex CLI merges `--config` overrides *into*
`$CODEX_HOME/config.toml` per dotted leaf key, so config alone cannot remove the host's MCP servers,
skills, plugins or `AGENTS.md` (`codex-config.server.ts:13-45`, verified against codex-cli
0.144.6). Historically this bit the project: **Codex inherited the host's skills and MCP servers.**

Auth precedence (`runtime-registry.server.ts:512-530`): `CODEX_ACCESS_TOKEN` (ChatGPT workspace
subscription) or a cached CLI login **wins over** `CODEX_API_KEY`/`OPENAI_API_KEY`, so a
subscription run cannot silently fall through to usage-based Platform billing; `codexSpawnEnv`
(`:463-480`) deletes the API keys when a token/cached login is in play.

Per-run hardening (`codexConfigForRun`, `:206-270`): `allow_login_shell:false` (`:217`),
`project_doc_max_bytes:0` (`:223` — the repo's `AGENTS.md` is a prompt-injection ingress with no
Claude counterpart), `skills.include_instructions:false` + `skills.bundled.enabled:false`
(`:234-237`), `features.{apps,plugins,hooks}:false` (`:238-250`), `memories:*false` (`:253-257`),
`shell_environment_policy.inherit:"core"` exporting only `SHELL_EXPORTED_ENV_KEYS` (`:171-177`) =
`GIT_CEILING_DIRECTORIES` + the four `GIT_AUTHOR_*`/`GIT_COMMITTER_*` vars (`:264-268`).
`resolveCodexSandboxMode` (`:284-289`) makes operator **and reviewer** runs read-only
unconditionally, before `repoWriteWithheld` is even consulted.

**Codex has no tool denylist channel.** Compensations derived from the Claude denylist:
`repoWriteWithheld` → read-only sandbox (“a physical block, strictly stronger than Claude's tool
denylist”, P13-RT-02); `webSearchWithheld` → `webSearchMode: "disabled"` (`:542-544`); the operator
also gets `networkAccessEnabled:false` (`:530-534`).

Two documented, accepted limitations: a credentialed org MCP authenticates on Claude runs only (the
Codex SDK passes config as `--config key=value` argv, visible in `ps auxww` — `:105-113`), and the
Codex CLI lowercases hyphens to underscores in MCP tool names (`:88-95`).

Codex has **no max-turns equivalent**; only the idle timeout (`codexIdleTimeoutMs()`, `:291-298`,
15 min default, `VIBERR_CODEX_IDLE_TIMEOUT_MS`) prevents a run staying `running` forever, because
Codex only settles on `turn.completed` (`:407-414`, handled `:569-575`). An idle abort is
distinguished from a user interrupt and reported as `error` (`:592-601`), matching Claude.

### 6.5 Where run logs and transcripts land

| Artifact | Path |
| --- | --- |
| **Run log (NDJSON)** | `${VIBERR_DATA_ROOT}/runtimes/<backend>/<runId>.jsonl` — `rawLogPath` (`run-store.server.ts:366-372`), appended one JSON object per line by `appendRawLine` (`:375-384`) |
| **Claude transcript** | `$CLAUDE_CONFIG_DIR/projects/<cwd with non-alnum → dashes>/<sessionId>.jsonl` |
| **Codex transcript** | `<codex run home>/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl` |

(`session-export.server.ts:13-14`; located by session id rather than by reproducing the cwd
encoding.) `/resources/session-export` packages a transcript into a bash installer (`:272`, `:319`)
so a conversation can be resumed locally on the same subscription.

**Log line sequencing.** `run_log_lines(run_id, seq, …)` with `seq` dense from 0 per run
(`nextSeq = MAX(seq)+1 || 0`, `run-store.server.ts:222-227`), inserted `ON CONFLICT DO NOTHING`
(`:394`). Forward tail `seq > since ASC`, backward page `seq < before DESC LIMIT n` then reversed
(`listRunLines` `:236-244`, mode select `run-service.server.ts:990-996`). Default page
`RUN_LOG_PAGE_LINES = 200` (`run-service.server.ts:962`); the endpoint clamps `limit` to 500; the
task loader's window budget is `RUN_LOG_WINDOW_LINES = 400` / `RUN_LOG_WINDOW_BYTES = 384 KiB`
(`run-projection.server.ts:61-62`).

**Sink ordering matters** (`run-sink.server.ts`, `line()` at `:248-309`): (0) redact both `raw` and
`display` (`:261-265`), (1) append to the `.jsonl` (`:268`), (2) insert the DB row *only when
`display` is non-null* (`:271-280`), (3) patch the run row (session/turns/usage/cost, `:283-290`),
(4) publish `run.log-appended` (`:292-301`). **Persist before publish** (`:62-63`), so a client that
reacts to the event can always fetch the line it references. If a persist fails, `markDivergent`
(`:190-…`, invoked `:307`) writes one `run·line_lost` line to both sinks so a truncated console
announces itself.

### 6.6 Run lifecycle

- **Single-flight** is three separate mechanisms: the partial unique index for the delivering
  engagement (409 on conflict), the thread-uniqueness index (a resume mints `<thread>-r<6>`,
  `run-service.server.ts:704-705`), and a **process-level operator lease**
  (`Symbol.for("viberr.operatorLease")`, `operator-run.server.ts:239`, `leaseState()` `:241-249`,
  `leaseKeyFor` `:251-253`) keyed `<slug>/<key>`, whose entry object *is* the release token.
  Trigger coalescing: machine triggers newest-wins; human `@operator` comments queue oldest-first,
  capped at `MAX_PENDING_HUMAN_TRIGGERS = 8` (`:267`, trim `:295-301`).
- **`withMcpAutoApproval`** (`run-service.server.ts:319-332`, called from `startRun` at `:410`,
  applied to the spec at `:436`) — every mounted MCP server the caller did not already name gets an
  `mcp__<server>` approval entry. Wave 3 (D4): the agent toolkit previously worked only because
  every run happened to be `bypassPermissions`. `resumeRun` now accepts and forwards `allowedTools`
  (`:676-681`, `:738`, `:772`), so confinement survives a resume.
- Live `RunHandle`s live in an in-process `Map` (`:84`) — **completion callbacks are lost on
  restart**, which is exactly what the boot recovery chain (§5) compensates for.
- `interruptRun` requires admin|maintainer, is idempotent on an already-terminal run, and audits
  `runtime.run.interrupted`. It deliberately passes `archived: false` so an archived project's
  in-flight run is still stoppable.
- First-terminal-wins: an already-terminal run is never demoted and `finishedAt` is not restamped
  (B-FD7, `run-sink.server.ts:28-33`, applied `:319-335`).
- An unavailable backend does **not** fabricate a run: `failRunUnavailable` (`:473-490`) opens a
  real sink, marks running, writes one server-authored `run·unavailable` error line (`:481`), and
  finalizes — so completion callbacks and escalation paths behave identically.
  `backendUnavailableMessage` (`:500-517`) emits state-aware copy from `backendCredentialHealth`.

---

## 7. Frontend

### 7.1 Entry points and the document shell

- `app/entry.client.tsx` (12 lines) — `hydrateRoot(document, <StrictMode><HydratedRouter/></StrictMode>)`
  inside `startTransition` (`:5-12`).
- `app/entry.server.tsx` — `await bootServer()` at module scope (`:21`), then a
  `renderToPipeableStream` document render with `streamTimeout = 5_000` (`:23`) and a `+1000 ms`
  abort margin (`:97`).
- `app/root.tsx` — the `<html>` shell. The root loader returns `{ theme, motion, csrf }`
  (`:57-83`, bare at `:79` or wrapped in `data(payload, { headers })` at `:80-82`).
  `<html data-theme data-motion suppressHydrationWarning>` (`:124-129`); a pre-paint inline script
  (`themeBootScript`, `:102-113`, injected `:135-137`) reads the `viberr_theme` cookie as
  **authoritative** (`:105-106`) and resolves `system` against `prefers-color-scheme` before first
  paint — which keeps the ErrorBoundary page (where loader data may be missing) from flashing light
  in a dark session (F3). A post-hydration effect (`:155-166`) keeps it in sync and live-follows
  the OS. `<App>` (`:168-175`) mounts `ToastProvider` + `RoutePendingBar` + `Outlet`.

### 7.2 `app/features/` — 16 surfaces

Convention: `*-page.tsx` is the presentational tree taking props; `*.server.ts` holds loader/action
helpers; feature components never import server modules at runtime (`import type` only). All 16
still respect it.

| Feature | Current files (non-test) | Role |
| --- | --- | --- |
| `shell` | `rail.tsx`, `topbar.tsx`, `command-palette.tsx`, **`use-command-palette.ts`**, `top-bell.tsx`, `user-menu.tsx`, `route-pending-bar.tsx`, `nav.ts`, `theme-preference.ts`, `command-search.server.ts`, `csrf-result.server.ts` | 232 px rail (`--rail-w`, `app.css:81`; frozen 7-item nav, `WORKSPACE_NAV` `nav.ts:20-28`), topbar with crumbs / ⌘K / bell / account, global route-pending bar (220 ms delay, deliberately **excludes** SSE revalidation) |
| `board` | `board-page.tsx` (1330), `board-dnd.ts`, `board-filters.ts` | Kanban over task projections; dnd-kit stage moves; URL-param filter/view/search |
| `task-detail` | `task-detail-page.tsx` (538), **`task-main-sections.tsx`** (535), **`task-side-panels.tsx`** (589), **`task-detail-hooks.ts`** (190), `timeline.tsx` (421), `timeline-slice.ts`, `comment-composer.tsx` (304), `lexical-mention-plugin.tsx` (216), `mention-menu.tsx`, `mention-autocomplete.ts`, `use-mention-autocomplete.ts`, `decision-packet.tsx` (341), `execution-profile.tsx` (819), `operator-recommendations.tsx`, `accept-/archive-/release-confirm.tsx`, `event-meta.ts` | The operator workspace. Fixed layout order unchanged: hero → live run strip → decision packet → execution profile → agent logs → timeline (`task-detail-page.tsx:338`, `:360`, `:404`, `:434`) |
| `live-updates` | `use-live-updates.ts`, `event-types.ts` | SSE → route revalidation (§7.7) |
| `runtime` | `runs-panels.tsx` (632), `use-run-log-stream.ts`, `log-clock.ts`, `log-noise.ts`, `runs-helpers.ts`, `runtime-types.ts` | Live run strip + streamed log console (its **own** EventSource) |
| `activity` | `activity-page.tsx`, `feed-helpers.ts`, `feed-limits.ts` | Per-project audit/activity stream, day-grouped |
| `notifications` | `notifications-page.tsx`, `notification-item.tsx`, `notification-meta.ts`, `notifications-page-helpers.ts` | Cross-project inbox; `notification-item` shared with the bell popover |
| `home` | `home-page.tsx` (297), **`home-sections.tsx`** (631), **`new-project-modal.tsx`** (569), **`project-cards.tsx`** (273), `home-query.server.ts`, `project-create.server.ts`, `project-name.ts` | Project cards; per-user prefs come from the DB, not localStorage. Split documented at `home-page.tsx:31-35` |
| `agents` | `agents-page.tsx` (1385), `capability-matrix-modal.tsx`, `create-profile-modal.tsx` (998), `agent-types.ts`, `capability-catalog.ts`, `agents-query.server.ts`, `agent-profile-actions.server.ts` | Agent profile roster, eligible stages, capability policy; now reports **backend credential health** rather than a flat “available” |
| `review` | `review-page.tsx`, `review-helpers.ts`, `review-acceptance-authority.server.ts` | Human-acceptance triage queue. Wave 3 (G2/R16-3): a closed-unmerged PR is named ahead of the missing verdict and the force-accept the task page withholds is no longer offered |
| `github` | `github-view.tsx`, `credential-card.tsx`, `github-copy.ts`, `github-pills.ts`, `github-query.server.ts`, `github-actions.server.ts` | Repo + credential health, PRs, execution branches, Reconcile |
| `policy` | `policy-page.tsx` (620), `policy-data.ts`, `policy-query.server.ts`, `policy-actions.server.ts` | RBAC matrix + capability rows, rendered from the same table the guards use |
| `project-settings` | `settings-page.tsx` (**1559 — the largest frontend file**), `membership.server.ts`, `settings-query.server.ts`, `settings-actions.server.ts` | Identity, workflow-stage editor (now dnd-kit, §7.4), members, credentials, danger zone. Each panel gates on the action **its own server guard checks** — `edit-policy` for identity/stages/repo, `manage-members` for members |
| `org-settings` | `org-settings-page.tsx` (118), `connections-panel.tsx` (356), `users-panel.tsx` (764), `resources-panel.tsx` (259), **`resource-rows.tsx`** (411), **`resource-modals.tsx`** (423), **`agent-template-modal.tsx`** (387), **`resource-helpers.ts`**, `mini-modal.tsx`, `use-org-action.ts` | `/org/settings?tab=connections\|users\|resources`; split documented at `resources-panel.tsx:25-29` |
| `profile` | `profile-page.tsx` (914), `notification-prefs.ts`, `profile-query.server.ts`, `profile-actions.server.ts` | Appearance (theme + reduce-motion), password, GitHub connection |
| `kb-browser` | `store-browser.tsx` (1251), `tree.ts`, `local-files.ts`, `icons.tsx` | Store file manager over a real disk scan |

Largest source files overall (non-test): `task-actions.server.ts` 5517, `operator-run.server.ts`
2274, `operator-actions.server.ts` 2070, `specialist-run.server.ts` 1940, `resources.server.ts`
1679, `settings-page.tsx` 1559, `agents-page.tsx` 1385, `board-page.tsx` 1330, `store-browser.tsx`
1251, `task-file.schema.ts` 1232. **No frontend file exceeds 1600 lines.**

### 7.3 The Lexical mention composer

Composer code is three files, all under `app/features/task-detail/`: `comment-composer.tsx`,
`lexical-mention-plugin.tsx`, `mention-composer.test.tsx`. (Two further files *mention* Lexical in
assertions: `app/app.css.test.ts` and `app/server/runtimes/harness-hermeticity.server.test.ts`.)

`CommentComposer` wraps `<LexicalComposer>` with `namespace: "task-comment"` and
`nodes: [MentionTextNode]` (`:249-250`). It uses **`PlainTextPlugin`, not `RichTextPlugin`**
(`:13`, `:257`). Children: `EditorBridge` (`:256`), the content editable with combobox ARIA
(`:259-266`), `HistoryPlugin` (`:277`), `OnChangePlugin` (`:278`), `MentionHighlightPlugin`
(`:279`), `ComposerKeysPlugin` (`:280`), `MentionMenu` (`:281`).

Keyboard handling is Lexical commands at `COMMAND_PRIORITY_HIGH` with
`if (editor.isComposing()) return false` first (`:116`) — Enter during IME is never a send or a pick.

**Mention node design** — deliberately not a decorator/element node
(`lexical-mention-plugin.tsx:18-27`, class `:29`, `getType() === "viberr-mention"` `:31`):

> A `MentionTextNode` is a NORMAL text node with the `.mention` class — fully character-editable,
> exports/copies exactly its `@Name` text, and **never persists as anything but plain text**. A
> paragraph-level transform keeps the segmentation honest against the SAME matcher the rendered
> comments use (`findMentionSpans`).

**The persistence invariant** (`comment-composer.tsx:42-51`):

> The editor owns only the DRAFT UI: one paragraph of plain text with line breaks, known @mentions
> highlighted live as character-editable text. The posted value, storage, and rendering pipeline are
> untouched — the parent reads the raw draft through `onChange` and submits exactly `raw.trim()`,
> the same bytes the textarea composer produced. **No rich text, Markdown, HTML, or editor state
> ever persists.**

Mechanically: `handleChange` reads `$getRoot().getTextContent()`; `timeline.tsx` stores it in a
**ref**; `send()` posts `fd.set("text", draftRef.current.trim())`. `EditorState` is never
serialized. `mention-composer.test.tsx` pins the exact byte contract and
`e2e/05-task-comment-composer.spec.ts` gates it live.

**On read**, one matcher drives every surface — `app/ui/mention-spans.ts` (109 lines):
`findMentionSpans(text, names)` (`:50`, longest-first known-name matching so `@Arda Kaya` beats
`@Arda`; reserved handles merged at `:55`, `RESERVED_MENTION_HANDLES` `:35`) and `extractMentions`
(`:100`), which the server-side resolvers (`mention-notify.server.ts`, `agent-reply.server.ts`) use.
Comments render through `app/ui/markdown.tsx` (react-markdown + remark-gfm, no raw HTML) with a
rehype pass that chips **only known** handles.

**Wave 3 made that claim true on the second surface.** `app/ui/rich-text.tsx` (the inline
micro-format renderer used on typed timeline events) previously carried its own
`@[A-Za-z][\w-]*` regex and chipped unconditionally. It now calls
`findMentionSpans(chunk, names).filter(s => s.known)` (`:2`, `:52`, rationale `:16-23`) and adds a
visually-hidden `mention ` prefix (`.mention-vh`) so a chip is not colour-only for AT.

Autocomplete is split: `mention-autocomplete.ts` (194 lines) is the framework-free matcher (token
grammar `:9-13`, mirroring the server's `MENTION_RE`), and `use-mention-autocomplete.ts` (136 lines)
is the DOM-decoupled controller — the editing surface feeds it `refreshFrom(text, caret)` (`:42`)
and receives insertions via `applyInsert` (`:78`); the controller never touches the DOM. The menu
opens only once ≥1 character follows the `@`.

### 7.4 Drag: one reorder language, one file-drop zone

**Two surfaces share one dnd-kit configuration.** Wave 2 converted the project-settings stage list,
which had shipped the opposite affordance (hand-rolled HTML5 `draggable` *with a visible grip*) and
reordered optimistically — and whose drop onto a neighbour POSTed a no-op reorder and toasted
success for a change that never happened.

| Aspect | Board (`board-page.tsx`) | Stages (`project-settings/settings-page.tsx`) |
| --- | --- | --- |
| Sensors | `BOARD_SENSORS` `:96-115` | `STAGE_SENSORS` `:239-257` (banner `:229-237`) |
| `preventActivation` | `:101-107`, selector `"button, input, select, textarea"` `:105` | `:244-251`, same selector |
| Activation | mouse `Distance({value:5})`, touch `Delay({value:250, tolerance:5})` `:111-114` | identical `:252-255` |
| Accessibility plugin | removed, `BOARD_PLUGINS` `:124-126` (rationale `:119-123`), applied `:1289` | removed, `STAGE_PLUGINS` `:261-266` |
| `OptimisticSortingPlugin` | filtered out `:230` | filtered out `:516` |
| Feedback | `Feedback.configure({ feedback: "clone" })` `:231` | identical `:517` |
| Grip | none (card face is the surface; anchor gets `draggable={false}` `:248`) | none (`stg-handle off` `:537`) |
| Commit | server-authoritative | server-authoritative (`:45` “route-action POST (no optimistic UI)”) |

Why the Accessibility plugin is removed: its `role="button"` wrapper nested the task link /
StageMenu (board) and the rename/move/remove controls (stages) inside an interactive control (axe
`nested-interactive`, serious). **Drag is pointer-only**; the accessible move path is the per-card
`StageMenu` and the per-row Move menu (F10-25).

**Server-authoritative drop** — three load-bearing statements on the board:

1. `board-page.tsx:219-222` — “Optimistic sorting is OFF — the board never reorders client-side;
   the DropPreview shows the requested slot and the server's answer is the only commit.”
2. `board-page.tsx:1077-1079` — “The server stays authoritative: nothing commits client-side.”
   `onDragEnd` (`:1080`) bails on `event.canceled` (`:1085`), calls `resolveBoardDrop` (`:1086`),
   and submits `{_csrf, intent: "reorder", taskKey, to, beforeKey}` through a `useFetcher`
   (`:1099-1101`). There is no `setColumns` anywhere in the tree — `columns` is loader data.
3. `board-dnd.ts:1-8` — the resolver “never reorders board state, it only names the requested
   destination” (`beforeKey: null` = end of column). A slot that no longer exists in the target
   column (the board can change under a drag via SSE revalidation) degrades to “end of column”.

On `{ok:false}` the card snaps back because loader data never changed, and an error toast appears.

Drag visuals: no portal/`DragOverlay`; the source keeps `.dragging` (`:240`) while a clone follows
the pointer, a dashed `DropPreview` ghost is interleaved at the resolved slot (`:358`), the column
gets `.drop-over` (`:410`), and on arrival a `.just-arrived` pulse retires after 1500 ms (`:413`).

The one remaining `dataTransfer` use is `app/features/kb-browser/store-browser.tsx` (`:53-54`,
`:286`, `:294`, `:341`, `:393`) — an **OS-file-upload drop target** (`types.includes("Files")`,
`dropEffect="copy"`), a different verb with no dnd-kit equivalent, not a third reorder idiom.

The board's attention filter (R16-2) now includes `input_required` —
`matchesBoardFilter` (`app/features/board/board-filters.ts:32-63`), `risk` branch `:40-59`, with the
in-line rationale — and the chip is named **“Blocked or waiting”**, so the amber card state and the
filter finally agree. The predicate is `inconsistency_risk_detected | blocked | input_required |
validation failing | urgent | pr.state === "closed"`, and archived tasks are excluded from every
filter but `archived`.

### 7.5 Design tokens, `app.css`, and the stylesheet test

**There are no `--viberr-*` CSS custom properties.** `grep -c -- "--viberr-" app/app.css` → `0`.
Tokens are unprefixed single words.

`app/app.css` is **3936 lines** — the app's only stylesheet.

| Fact | Detail |
| --- | --- |
| Light tokens | one `:root` block, `app.css:7-83`, **40** declarations |
| Dark tokens | `:root[data-theme="dark"]`, `app.css:2438-2478`, **28** declarations — a pure token swap, plus hardcoded-color fixups from `:2480` |
| `color-scheme` | set per branch (`:root { color-scheme: light }` `:2437` / dark override) |
| Token families | surface/text (`--bg --surface --fg --muted --faint --placeholder --border --ring --hairline`), brand (`--blue --blue-pressed --blue-soft --cta-bg --cta-fg`), semantic pastel pairs, agent identity (`--agent --agent-dark --agent-soft`), type (`--font-display --font-body --font-mono`), elevation (`--shadow-ring --shadow-card --shadow-pop`), motion (`--ease-out`), radii, layout (`--rail-w: 232px` `:81`, `--topbar-h: 60px`) |
| Sections (14) | shell `:2`, BOARD `:632`, TASK DETAIL `:994`, AGENTS `:1441`, POLICY `:1934`, ACTIVITY `:2175`, SETTINGS `:2203`, REVIEW/GITHUB `:2293`, PROFILE `:2382`, DARK THEME `:2435`, AGENT RUNTIME `:2581`, HUMAN REVIEWERS `:2731`, **P16-F3 reclaimed declarations `:3732`**, **1100px two-column collapse `:3890`** |
| Reduce-motion hook | `[data-motion="reduce"] * …` at `app.css:2492-2497` — sourced from the **DB user pref**, SSR'd onto `<html>`; six independent `@media (prefers-reduced-motion)` blocks exist in parallel (`:945`, `:1892`, `:2337`, `:2895`, `:3631`, `:3710`) |

`app/app.css.test.ts` is now **1006 lines** and is the enforcement mechanism for most of the pass-16
UI rulings. Thirteen assertion families:

1. `:110` **Custom properties** — every `var(--x)` resolves to a declared token (comments stripped
   at `:54`).
2. `:155` **Utility classes** — the `.btn.primary` / `.btn.ghost` vocabulary; hyphenated aliases
   must never be declared.
3. `:177` **Keyboard focus ring (P16-UI-01)** — one app-wide `:focus-visible` ring covering every
   control kind, wrapped in `:where()` so component rules still win, with the ring colour asserted
   ≥3:1 on every surface it lands on, in both themes.
4. `:255` **Dead-and-drifted rules (P16-UI-04)** — `--font-display` declared exactly once; **the UA
   button background is cleared in the element reset (`:270`)** — this is load-bearing: Chrome
   resolves `ButtonFace` per color-scheme (#efefef light, **#6b6b6b dark**), so any button whose
   class declares no surface painted a mid-grey block in dark mode; no `.card.wait-human` no-op;
   the board scroll fade only paints when scrollable; grab cursor on the row that drags.
5. `:388` **`<select>` treatment (P16-UI-05)** — one base rule; remaining rules are variants.
6. `:426` **Contrast / WCAG AA** — `--faint`/`--placeholder` ≥4.5:1 on `--surface` in both themes
   with the `--muted > --faint > --placeholder` ordering preserved; plus both tokens over the 4%
   `--fg` surface tint (`:465`), the primary CTA and its hover (`:482`), and CTA-vs-surface
   distinguishability (`:502`).
7. `:602` **className/TSX integrity scan (P16-UI-02)** — recursive walk of all of `app/`, a
   balanced-brace `className={…}` extractor (`:547-570`), literal filtering (`:574-580`) and
   template-literal static-chunk harvesting (`:584-588`). Asserts a rule exists for **every** class
   name used anywhere in `app/`. **`CLASSLESS_BY_DESIGN` is `{}` and is documented as
   never-to-be-grown (`:596-601`)** — there is no allowlist.
8. `:708` **Hover-revealed board actions (P16-F7)** — hidden behind hover on pointer devices, drawn
   unconditionally where hover cannot happen, without reintroducing a grip.
9. `:734` **Search field vs palette trigger (P16-F6)** — one silhouette for both.
10. `:802` **Breakpoint inventory (P16-F8)** — a named map of **9** values, each with a stated job:
    `max 1400` board columns, `max 1300` invite row, **`max 1100` THE two-column collapse**,
    `max 1080` topbar tier 1, `max 1000` settings tab rail, `max 900` home topbar → palette,
    `min 900` login brand aside, `max 760` topbar tier 2, `max 720` mobile shell. Each must be
    declared **exactly once** (1100px had been nine separate blocks) — custom properties do not work
    inside media queries and `@custom-media` needs build config this project does not run, so one
    occurrence is the only mechanism that makes a half-update inexpressible.
11. `:861` **Palette reachability on touch (P16-G3)** — Home's search box collapses to a 36 px
    magnifier button instead of vanishing below 900 px (it previously lost both the project finder
    and the only ⌘K trigger on a phone).
12. `:939` **Task-key treatment** — the board LIST row's `.key` matches the grid card's.
13. `:960` **Inline-style scan (P16-F3)** — walks every `.tsx` for `style={{`, fails any site whose
    values are **all literals** (a literal value is a design decision and belongs in the sheet where
    a theme/density/breakpoint rule can reach it; a value read at runtime belongs in the markup),
    and **holds the line at ≤20 sites (`:984`)**. Current count: exactly **20** (down from 184).

### 7.6 `app/ui/` — the shared primitives (21 non-test modules)

`app/ui/` must not import from `app/features/`.

| File | Role |
| --- | --- |
| `avatar.tsx` / `initials.ts` | human avatar; `initialsOf()` split out for the Fast Refresh boundary |
| `csrf-input.tsx` | `<CsrfInput />` / `useCsrfToken()` — the token from the root loader |
| `icon.tsx` | shared 24 px stroke icon set; unknown names fall back to `dot` |
| `identity.tsx` | agent backend glyph (claude/codex/operator) |
| `local-time.tsx` | UTC-first-paint hydration primitives (§7.8) |
| `markdown.tsx` | GFM renderer for multi-line comments; no raw HTML |
| `mention-spans.ts` | `findMentionSpans` / `extractMentions` / `RESERVED_MENTION_HANDLES` — **the** matcher |
| `page-overlay.tsx` | full-page modal on native `<dialog>` via `useDialog` |
| `pill.tsx` | status/readiness/validation pills — the one canonical-enum → CSS-kind mapping |
| `rich-text.tsx` | inline micro-format renderer (`**bold**`, `` `code` ``, `@mention`) — rewritten in wave 3 |
| `skip-link.tsx` | WCAG 2.4.1 bypass block (inline styles on purpose) |
| `stage-menu.tsx` | stage-change dropdown shared by board card + task detail; converted onto `useDismiss` |
| `toast.tsx` | `ToastProvider` / `useToast` — see below |
| `toggle.tsx` | controlled toggle switch, required aria label |
| `use-action-toast.ts` | fetcher result → success/error toast |
| `use-dialog.ts` | native-`<dialog>` behaviour the platform doesn't give: scroll lock, backdrop-click close, focus restore |
| **`use-dismiss.ts`** | **NEW** — “Escape or a press outside closes me”, the one implementation |
| `use-fetcher-result.ts` | run a handler exactly once per settled fetcher result |
| `use-relative-time.ts` | live “2m ago”; re-renders on mount + every 30 s; **requires `suppressHydrationWarning`** |
| `use-shortcut-hint.ts` | platform-correct ⌘/Ctrl hint; SSR emits the Mac form, first client effect corrects |

`use-dismiss.ts` (`:4-9`) names the **seven** near-identical hand-rolled effects it consolidated —
`shell/user-menu.tsx`, `shell/top-bell.tsx`, `ui/stage-menu.tsx`, three menus in
`task-detail/execution-profile.tsx`, and `runtime/runs-panels.tsx`'s AgentPicker — which disagreed
on `document` vs `window`, on whether an outside press closes at all, and on whether the trigger
counts as inside. Options: `also` (extra “inside” refs, for portaled popovers) and `onReflow`
(close on scroll/resize for rect-positioned popovers). It is deliberately **not** `useDialog`:
these are inline popovers, so they must not trap focus, take the top layer, or scroll-lock.

`toast.tsx` carries two independent wave-2 fixes:

1. **Stack cap** — `TOAST_STACK_CAP = 4`; oldest drops with no exit animation (an exit caused by an
   *arrival* would misread as the new toast shoving the old one). Every other list in the app was
   already capped; this one was not.
2. **Announcement fix (P16-UI-26)** — the host is the app's **only** `role="status"
   aria-live="polite"` region, and it was silent for every dialog-driven action: a modal `<dialog>`
   inerts everything outside it, and the old code called `showPopover()` in the same commit that
   inserted the toast, which is precisely the case screen readers do not announce. It now promotes
   the still-empty host to the top layer, then commits the message a frame later, and **re-arms**
   (hide→show) when the set of open dialogs changed since promotion. `aria-atomic` is **`false`**,
   not `true`: `role="status"` implies `true`, which would re-read the whole (now 4-deep) stack on
   every arrival.

Also shared, in `app/shared/text/` (both new in wave 3):

- **`plural.ts`** (34 lines) — `pluralNoun(count, one, many?)` (`:17`) and
  `countLabel(count, one, many?)` (`:28`). Every `{n} thing` surface used to hand-roll
  `n === 1 ? "" : "s"`, and the ones that forgot shipped “1 instance accounts”, “1 knowledge
  bases”, “1 stages”. Explicitly English-only, and named as the single site an `Intl.PluralRules`
  swap would replace.
- **`store-extensions.ts`** (41 lines) — `STORE_TEXT_EXTENSIONS` (`.md .markdown .mdx .txt .rst
  .text .json .yaml .yml`) plus a display list. It lives in `shared/` because `store-browser.tsx`
  runs in the browser and cannot import either `.server` module (`:8-11`); it unifies three
  previously divergent copies (KB injector, store-file editor, store browser).

### 7.7 Live updates on the client

`app/features/live-updates/use-live-updates.ts` is the single hook. Its contract (`:9-14`):

> subscribe the current surface to its SSE scopes and revalidate the active React Router loaders
> when anything relevant changes. **No optimistic state, no client caches — revalidation IS the
> update mechanism.**

| Fact | Value |
| --- | --- |
| Mechanism | `useRevalidator()` (`:61`); every non-control event name from `SSE_EVENT_NAMES` gets a listener |
| Control events | `SSE_CONTROL_EVENTS = ["stream.open"]` (`event-types.ts:15`) — merely connecting never revalidates |
| Debounce | `REVALIDATE_DEBOUNCE_MS = 300` trailing (`:39`, applied `:88`) |
| Loop safety | revalidation re-runs GET loaders only, which never write projections (`:19-23`) |
| Reconnect | `onerror` + `readyState === CLOSED` (`:106`) → flip a `paused` flag (topbar chip) and open a **fresh** EventSource on `SSE_REOPEN_BACKOFF_MS = [2000, 5000, 15000, 30000]` (`:47`, clamped `:109`); revalidate once on reconnect |
| Progressive enhancement | no-ops when `typeof EventSource === "undefined"` (`:78`) |
| Scopes | `sseScopes` in `event-types.ts:20-26`; URL by `buildEventsUrl` (`:29-34`) |
| Call sites | **three**: `routes/project.tsx:150` (`project:` + `user`, plus `task:` when a task is open), `routes/_index.tsx:201` (`user` + `projects`), `routes/notifications.tsx:78` (`user`) |

Deliberate exception: the run-log console has its own EventSource
(`features/runtime/use-run-log-stream.ts:11-27`) consuming `run.log-appended` directly and fetching
deltas from `/resources/run-log` since the last seq — using `useLiveUpdates` there would refetch the
whole task loader per log line. It revalidates the task loader only on `run.state-changed`, and it
also owns backward paging (`loadOlder()`) because the loader ships a bounded window (P13-D-11).

### 7.8 Hydration determinism — absolute-UTC first paint

The container SSRs in UTC and the viewer hydrates in their own zone, so any viewer-local timestamp
is a hydration text mismatch — a recoverable React #418 that forces a full client re-render.

`app/ui/local-time.tsx:8-14` (41 lines):

> Hydration-safe timestamp text … **First paint is the UTC form, identical on server and client by
> construction; an effect swaps in the viewer-local rendering.**

Primitives: `useHydrated()` (`:25-29`) — false during SSR *and* the hydration render, true on the
first post-hydration commit; `LocalDayDotTime` (`:15-18`); `LocalRelative` (`:31-41`) renders `" "`
on **both** sides, because relative text depends on *now* and both sides could straddle a minute
boundary.

`app/shared/dates/format.ts` (163 lines) exports **nine** formatters: `formatClock` `:51`,
`formatDayBucket` `:64`, `formatCalendarDate` `:75`, `formatDayTime` `:82`, `formatDayDotTime`
`:90`, `formatDayBucketUTC` `:118`, `formatDayDotTimeUTC` `:129`, `formatClockUTC` `:140`,
`formatRelative` `:147`. **Wave 2 (F19)** zero-padded the 24 h clock on both fields (`"9:41"` →
`"09:41"`) via a private `clock(hours, minutes)` helper (`:57-59`) — “the one place hour:minute is
assembled — local and UTC share it so the two passes of a hydration swap can never drift apart on
padding” (rationale `:41-50`; an audit row stamped `today 0:18` read as a fragment).

The strongest statement is on `formatDayBucketUTC` (`:118`) — it renders the **absolute UTC
calendar day (“Mar 30”) for every row and deliberately never Today/Yesterday**, because the
activity page uses that value as its **grouping key** and an SSR/hydration render straddling UTC
midnight would mismatch every header at once.

Consumers: `timeline.tsx:158` and `task-main-sections.tsx:319` (`LocalDayDotTime`),
`task-side-panels.tsx:151` (`LocalRelative`), `activity-page.tsx:258` (`useHydrated` selecting
`groupStreamByDay` vs `groupStreamByDayUTC`, `formatClock` vs `formatClockUTC`, `auditTimeLabel` vs
`auditTimeLabelUTC`), `runs-panels.tsx:362`. Gated by `e2e/06-activity-hydration.spec.ts`: an
Auckland-timezone viewer against the UTC container, asserting zero page errors and no
`Today`/`Yesterday` in the SSR HTML.

A second, **older** strategy is still live and distinct: `app/ui/use-relative-time.ts` re-renders
once on mount and every 30 s, and must be paired with `suppressHydrationWarning` on the element.
Its call sites are now `app/features/home/project-cards.tsx:5,:99` (it moved with the home split)
and `app/features/kb-browser/store-browser.tsx:15,:229`. **Two hydration strategies coexist — know
which one a surface uses before editing it.**

### 7.9 `design/` and the porting rule

```
design/
  index.html  design-system.html  landing.html  Canvas.dc.html   reference pages
  prd.md      CONVERSATION-SUMMARY.md  better-auth-migration.md  product + design log
  support.js  two draw-*.png
  html-app/
    Viberr {Home,Login,Operator Workspace}.html  React+Babel shells
    app/*.jsx      ← THE canonical per-surface mocks (activity, agents, board, github, home,
                     kb-browser, login, notifications, org-settings, policy, profile, review,
                     runs, settings, task, ui, main.jsx, tweaks-panel.jsx, data.js,
                     viberr.css, home.css)
    reference/     design-system.html, index.html, landing.html
    _shots/        reference screenshots
```

The UI porting rule (`docs/architecture/decisions.md:97-118`) is that `design/html-app/app/*.jsx` is
the design source of truth — reproduce structure, class names and behavior 1:1 unless the mock is
prototype-only. `tweaks-panel.jsx` is explicitly **not** a product surface (orchestrator ruling 8):
it is the prototype host's edit-mode scaffold, not a screen.

---

## 8. Config, env, and deployment

### 8.1 Environment variables

Parsed and validated in exactly one place: `app/server/config/env.server.ts`, a Zod schema evaluated
once per process and cached on `Symbol.for("viberr.env")` (`:142-152`). Empty strings are treated as
unset. A bad configuration produces a multi-line message listing *every* problem and fails the boot
(`:159-169`). `.env` is loaded via `node:process.loadEnvFile()` at module scope (`:172`, ENOENT
tolerated) — both here and in `vite.config.ts`.

| Variable | Required | Meaning | Line |
| --- | --- | --- | --- |
| `VIBERR_SESSION_SECRET` | **yes** | ≥32 chars. Signs the session cookie and derives the CSRF HMAC. `openssl rand -base64 48` | `:21-26` |
| `VIBERR_SECRET_ENCRYPTION_KEY` | **yes** | base64 → **`Buffer`, exactly 32 bytes**; AES-256-GCM key for PATs at rest. `openssl rand -base64 32` | `:50-73` |
| `VIBERR_DATA_ROOT` | no (`./data`) | the runtime data root (§4.4) | `:76` |
| `VIBERR_FORCE_DATA_ROOT_LOCK` | no | `1`/`true`/`yes` — take over a live-looking writer lock for one boot | `:83` |
| `PORT` | no (`5173`) | coerced int 1–65535 | `:18` |
| `NODE_ENV` | no (`development`) | `development` \| `production` \| `test` | `:13-15` |
| `BETTER_AUTH_URL` | no | absolute public origin; **required behind a reverse proxy** — unset with OAuth configured, `trustedOrigins` collapses to `[]` (boot logs a warning) | `:44` |
| `BETTER_AUTH_SECRET` | no | ≥32 chars; the *default to `VIBERR_SESSION_SECRET`* happens at the call site (`auth.server.ts:344`), not in the schema | `:33-36` |
| `GITHUB_OAUTH_CLIENT_ID` / `_SECRET`, `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | no | login buttons stay inert when unset | `:86-89` |
| `VIBERR_SEED_ADMIN_EMAIL` / `_PASSWORD` | no | used when `users` is empty. Without them the default is `admin@viberr.dev` with a one-time password printed once to stdout | `:92-96` |
| `ANTHROPIC_API_KEY` \| `CLAUDE_CODE_OAUTH_TOKEN` \| `VIBERR_CLAUDE_USE_CLI_AUTH` | no | Claude credential (any one); the CLI-auth flag is now **verified**, not merely present (§6.3) | `:107-109` |
| `CLAUDE_CONFIG_DIR` | no | default `${DATA_ROOT}/runtimes/claude-home` | `:113` |
| `CODEX_ACCESS_TOKEN` \| `CODEX_API_KEY` \| `OPENAI_API_KEY` \| `VIBERR_CODEX_USE_CLI_AUTH` | no | Codex credential; access token / cached login wins over the API keys | `:117-124` |
| `CODEX_HOME` | no | the human's Codex **login** dir; compose sets `/data/runtimes/codex-home` | `:123` |
| `VIBERR_CLAUDE_MAX_TURNS` | no | **declared as a bare optional string with no default.** The `2000` fallback is applied at `claude-runtime.server.ts:331-336`, not by the schema | `:135` |
| `VIBERR_CLAUDE_IDLE_TIMEOUT_MS`, `VIBERR_CODEX_IDLE_TIMEOUT_MS` | no | same shape; the 900 000 ms fallbacks live at the call sites | `:136-137` |
| `LOG_LEVEL` | no | **not in the schema** — read directly off `process.env` by `logger.server.ts:37` | — |
| `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` | no | **the documented gap.** Key rotation shipped in wave 1 (`secrets/secret-box.server.ts:26-35`, `previousSecretKeys()` `:55-72`, `openSecretRotating` `:88-101`, used by `pat-store.server.ts:204-205`) and the operator-facing error names it verbatim (`org/resources.server.ts:643`) — but it is read off raw `process.env` (`secret-box.server.ts:50-54`), is **absent from the Zod schema**, and is **absent from `.env.example`**. Malformed entries are silently skipped (`:64-69`) | — |

`.env.example` is **132 lines** and documents every schema variable with generation commands.
Commit `71fa506` made `VIBERR_DATA_ROOT` an **active** setting there (`:34` = `./docker-data`) with
13 lines of rationale (`:21-33`) naming the dual-writer / VirtioFS-WAL hazard and the requirement
that it not disagree with `.claude/launch.json`.

### 8.2 Dev server (`.claude/launch.json`)

```json
{ "name": "viberr-dev", "runtimeExecutable": "bash",
  "runtimeArgs": ["-c", "… nvm use …; export VIBERR_DATA_ROOT=/Users/akinozer/projects/viberr/docker-data; exec npm run dev"],
  "port": 5173, "autoPort": true }
```

The `CODEX_HOME` export was **removed and committed** in `5e03c6e`. Behaviour: `resolveCodexHome()`
already returns `${VIBERR_DATA_ROOT}/runtimes/codex-home`, so the run home is unchanged; dropping
the export restores `resolveCodexAuthSource()` to the human's `~/.codex`, which is the point — with
the export in place, source == run home, the auth mirror was a no-op and every Codex run was refused
(finding D1). `0955ac9` then made both resolvers derive `$HOME` from the passed env rather than
`os.homedir()`.

**The live `.env` still says `VIBERR_DATA_ROOT=./data`** while `launch.json` overrides it to
`docker-data`. `docker-data` is the live root; `data/` is stale. Combined with the single-writer
lock this means a dev server started through `launch.json` and a `docker compose up` both target
`docker-data`, and the second one will (correctly) refuse to boot. Aligning the real `.env` is a
local config choice the owner left open (G6); the *template* now prescribes the right value.

### 8.3 Docker

`Dockerfile` — two stages on `node:26-slim`.

- **build**: `npm ci` (`:12`), `npm run build && npm prune --omit=dev` (`:15-16`).
- **runtime**: installs `git` + `ca-certificates` (`:29-31` — real agent runs clone repos and shell
  out to git); copies `node_modules` (`:48`), `build/` (`:49`), `package.json` (`:50`), and **also
  `db/` (`:56`), `scripts/` (`:57`), `app/` (`:58`), `tsconfig.json` (`:59`)** so migrations resolve
  from cwd and `npm run seed|rescan` work via `tsx` inside the container. Sets
  `NODE_ENV=production` (`:33`), `VIBERR_DATA_ROOT=/data` (`:36`),
  `CLAUDE_CONFIG_DIR=/data/runtimes/claude-home` (`:39`),
  `CODEX_HOME=/data/runtimes/codex-home` (`:42`), `PORT=3000` (`:43`). Runs as `USER node` (`:64`).
- `ENTRYPOINT ["sh", "/app/scripts/docker-entrypoint.sh"]` (`:71`) seeds `auth.json` from the
  optional read-only `/host-codex` mount into the writable `$CODEX_HOME` **only when missing**, then
  `exec "$@"`. (A directory mount, not a file mount, because the CLI rewrites `auth.json` via
  rename and a file mount would pin a dead inode.)
- `CMD` (`:81`) runs the server binary directly, **not `npm run start`**: with npm in between, npm
  is pid 1 and the SIGTERM never reaches node — and node's shutdown handler is what checkpoints the
  WAL and releases the writer lock (`:73-80`).

`.dockerignore` (32 lines) excludes `node_modules build .react-router data docker-data .env .env.*`
(with `!.env.example`), `.git .github .claude .DS_Store *.log coverage test-results e2e design
planning docs Dockerfile compose.yml README.md`. **`test-support/` is deliberately NOT excluded**
(`:21-29`, a comment block added by `71fa506`) because the e2e seed one-shot runs from the *build*
stage and needs the demo fixture.

`compose.yml` — the production single-node stack:

| Setting | Value / why |
| --- | --- |
| `hostname: viberr` (`:10`) | **stable identity across container recreation** — the writer lock refuses a lock from a different host, and compose's default hostname is the container id, so every `down && up` came back a stranger to its own leftover lock |
| `env_file: .env` (`:11`) + explicit `environment` | forces `NODE_ENV=production` (`:15`), `VIBERR_DATA_ROOT=/data` (`:16`), `CODEX_HOME=/data/runtimes/codex-home` (`:35`) even when `.env` carries dev equivalents |
| Volumes | `./docker-data:/data` (`:43` — everything stateful, back this up) and `${CODEX_CLI_HOME:-~/.codex}:/host-codex:ro` (`:51`) |
| Ports | `${PORT:-3000}:${PORT:-3000}` (`:39`) |
| Healthcheck | `node -e fetch('http://127.0.0.1:$PORT/resources/health')`, 30 s interval / 5 s timeout / 3 retries / 20 s start period (`:52-63`) |
| Restart | `unless-stopped` (`:64`) |

`compose.e2e.yml` — an isolated production-image stack driven by `scripts/e2e.ts`. **Owner policy
(2026-08-02): anything that serves the app for a test runs the PRODUCTION image — never a dev
server.** It never touches `compose.yml`'s project, `.env`, `./docker-data`, or any host credential:

- Deterministic synthetic secrets via the `x-e2e-env` anchor (`:12-16`).
- A `seed` one-shot built from the **build stage** running `sh -c "npm run seed:demo && chown -R
  1000:1000 /data"` (`:20-27`).
- The `app` service builds the final stage, `depends_on: seed: service_completed_successfully`
  (`:36-38`), pins `hostname: viberr-e2e` (`:43`), publishes `127.0.0.1::3000` (`:50`, random host
  port), and shares the project-scoped named volume `e2e-data` (`:66-67`). Project name
  `viberr-e2e` (`:17`).

`scripts/e2e.ts`: `down --volumes --remove-orphans` (`:64`) → `up --build --detach --wait
--wait-timeout 300` (`:66`) → derive the port from `docker compose port app 3000` (`:74-75`) → wait
for `/resources/health` `{ok:true}` (`:41-58`, `:84`) → run `playwright test` with
`VIBERR_E2E_BASE_URL` (`:87-89`) → tear down with `--volumes` (`:100`). `VIBERR_E2E_KEEP=1` leaves
the stack up (`:96-99`).

`playwright.config.ts` throws if `VIBERR_E2E_BASE_URL` is unset (`:17-25`) — a bare
`npx playwright test` has no app to target. `workers: 1` (`:30`), `fullyParallel: false` (`:29`)
because the specs share the seeded store; a `setup` project (`:44`) logs in through the real
`/login` UI and stores the session at `e2e/.auth/arda.json` (`:45-52`). `retries: CI ? 1 : 0`,
`timeout` 45 s, `trace: retain-on-failure`.

### 8.4 CI

`.github/workflows/ci.yml` — Node 26, two jobs, triggered on push + PR to `main`:

- `verify` (`:10-30`): `npm ci` → `npm run typecheck` → `npm test` → `npm run build`.
- `e2e` (`:32-56`): `npm ci` → `npx playwright install --with-deps chromium` → `npm run e2e`,
  uploading `playwright-report/` on failure (7-day retention).

**`npm run build` is not a typecheck.** `tsc` (via `npm run typecheck`, which first runs
`react-router typegen`) is the required gate — this has produced real self-inflicted bugs.

### 8.5 Test infrastructure

`vitest.config.ts`: `environment: "node"` (`:11`), `include: ["app/**/*.test.{ts,tsx}"]` (`:21` —
the dead `db/**/*.test.ts` glob was removed by `71fa506`, rationale `:16-20`), `setupFiles:
["./test-support/setup-env.ts", "./test-support/setup-dom.ts"]` (`:15`),
`resolve.tsconfigPaths: true` (`:4-7`). No pool/threads configuration — vitest defaults apply.
**213 test files** currently; the wave-3 gate reported 2794 tests green.

`test-support/setup-env.ts` makes the suite **hermetic**: it seeds `VIBERR_SESSION_SECRET` /
`VIBERR_SECRET_ENCRYPTION_KEY` via `??=` before any app module loads (`:19-23`), and **blanks seven
real-backend credentials to `""`** (`:44-54`) so `npm test` can never make a paid provider call
(F10-10). It assigns `""` rather than `delete`-ing, because `env.server.ts` calls `loadEnvFile()`
*after* setup files run and would refill a deleted key from the developer's `.env`. It also
`mkdtempSync`s one root and creates two populated subtrees — `$CLAUDE_CONFIG_DIR/projects` and
`$CODEX_HOME/sessions` (`:81-85`) — so the transcript-continuity probe answers `missing`
deterministically. `CODEX_HOME` is deliberately **not** in the blanked list (`:74-79`):
hermeticity holds because the temp dir has no `auth.json`.

`test-support/` (11 files):

| File | Role |
| --- | --- |
| `setup-env.ts` | hermetic env seeding + credential blanking + transcript-store pinning |
| `setup-dom.ts` | jsdom `<dialog>` `showModal/show/close` polyfill; no-op under node |
| `test-app.ts` | route-level harness — temp data root, reset singletons, real Requests with signed session cookies and CSRF tokens. **Import route modules after `setupAppTest()`** |
| `test-db.ts` | temp migrated SQLite DB |
| `test-store.ts` | file-store + user/project/task seeding helpers |
| `demo-data.ts` | the 41 KB mock dataset (projects/tasks/packets/events) |
| `demo-seed.ts` | writes `demo-data` into a DB + file store; drives `npm run seed:demo` and the e2e one-shot |
| `fake-runtime.ts` | scripted `RunHandle`/`RunSpec` adapter, no provider calls (the only remaining “simulated” runtime, e2e/test-only) |
| `fake-github.ts` | canned `fetchImpl` keyed `"METHOD /path"` |
| `audit-log.ts` | raw `audit_events` reader (bypasses the whitelisting display query) |
| `custom-board.ts` | hand-customized 3-stage board fixture |

E2E specs (`e2e/`, 7 + setup): `01-home-board`, `02-feeds-profile`, `03-org-settings-store`,
`04-palette-mobile`, `05-task-comment-composer`, `06-activity-hydration`, `07-accessibility`,
`auth.setup.ts`. The accessibility sweep is parameterized (the wave-3 gate reported 62 e2e specs
green) and now covers activity / project settings / github / org settings / profile / notifications
**and dialogs in their open state, in both themes**.

---

## 9. Invariants an implementer must not break

1. **One app process per data root, EVER.** Enforced by `state/writer.lock` (§4.6). Never run a
   second server, seed, or rescan against a data root a live process holds. A second writer is
   corruption of the WAL and of per-process run handles, not a slow path.
2. **Files are the only canonical business truth.** Write through the dedicated writer modules
   (frontmatter-preserving, atomic), then re-parse → re-project → publish. Never write a
   task/project projection without file backing.
3. **Plain-text mention persistence.** The comment composer posts exactly `raw.trim()`. No rich
   text, Markdown, HTML, or Lexical editor state ever persists. The composer highlight, both
   rendered surfaces (`markdown.tsx` and `rich-text.tsx`) and the server-side routing resolver must
   all use the *same* `findMentionSpans`/`extractMentions` matcher, and must chip only **known**
   handles.
4. **Absolute-UTC first paint for anything timezone- or now-dependent.** Render the deterministic
   UTC form while `useHydrated()` is false; swap to viewer-local after. Grouping keys must use
   *absolute* days (never Today/Yesterday). The alternative strategy (`use-relative-time.ts`)
   requires `suppressHydrationWarning` on the element.
5. **`/api/auth/*` allow-list.** `ALLOWED_AUTH_PATHS` enumerates the endpoints the app drives;
   everything else 404s in the `before` hook. Never convert it to a deny-list — better-auth adds
   endpoints over time and a deny-list rots silently.
6. **`ACTION_ROLES` in `app/shared/rbac.ts` is the single source** for project-role authorization
   (105 lines; **18** actions in `RBAC_DEFINITIONS` `:60-88`). The server guards consult it and the
   Policy/Profile/task-Permissions surfaces render the same object, so display and enforcement
   cannot drift; `policy-rbac.server.test.ts` drives each guard per role AND pins the matrix itself
   (the old matrix test derived its expectation from the map it guarded, so widening a tier passed
   silently). Roles are a strict tier `viewer ⊂ contributor ⊂ maintainer ⊂ admin` and every action
   is monotonic. Add a governed action by adding a row, not by hand-checking a role at a call site.
   **Gate a UI control on the action id its own server guard checks** — not on `myRole === "admin"`,
   and not on an id that merely shares a tier today (wave 3, E3).
7. **Membership is the outer gate on every project action.** A non-member gets the unknown-slug 404
   (§3.6) — never a 403 that confirms the project exists. `view` and `comment` are held by every
   role, so their entire enforcement *is* that membership gate. The `appWide` concept is deleted.
8. **The board and stage drops are server-authoritative.** No optimistic reordering;
   `OptimisticSortingPlugin` stays filtered out on both surfaces; the list is loader data.
9. **No optimistic UI for governed state** generally — revalidate after the action and on SSE. SSE
   payloads carry compact facts/references only, and the wire shape is schema-validated pre-publish.
10. **Every mutating form needs `_csrf`** (or an `X-Csrf-Token` header) and goes through
    `requireFormAction` / `assertCsrf`. The origin check **fails closed**.
11. **Every governed action writes an audit event**, and where user-visible, a typed timeline event
    in `task.md`. Mutating actions must be idempotent-safe — a retry must not duplicate transitions,
    branches, PRs or events. Note the two audit actions retention deliberately keeps forever
    (§4.3).
12. **Secrets come only from env.** PATs are AES-256-GCM encrypted in SQLite; secrets never appear
    in files under `projects/`, in logs, in SSE payloads, or in error messages. The spawned-agent
    env is a filtered *replacement*, not `process.env` — and that includes probes (§6.2).
13. **Tolerant parsing.** Malformed input produces diagnostics plus a readiness downgrade, never a
    crash and never a silent drop; unknown frontmatter fields are preserved verbatim.
14. **Human-only, server-enforced**: transition to Done, completion acceptance, merging a PR
    (R16-6) and changing project policy — with the single disclosed exception that under the `auto`
    preset a full-autonomy operator holding an explicit `completion-for-acceptance: direct` grant
    may accept. Because merge stays human-only, a full-autonomy task reaches Done with its PR open;
    that “merge pending” state must be visible on the card, not only on the detail page.
15. **The acceptance PR-head gate lives inside the shared write.** `applyAcceptanceWrite`
    (`task-actions.server.ts:4942`) re-asserts the verified `(PR, revision)` pair inside the file
    lock and `skipInLockRecheck` (the audited force override) does **not** relax the head check.
    Do not re-implement a Done write per caller.
16. **A PR becomes a task's PR only under `decidePrAdoption`** (`github/pr-adoption.server.ts:46`,
    ruling R16-1): OPEN **and** head sha == the delivered revision. Identity, not containment. A
    name-matched stranger is reported as the branch collision it is
    (`prAdoptionRefusalNote`, `:89`). All three adoption sites (`workspace-delivery.server.ts:476`,
    `pr-open.server.ts:238`, `github-reconciler.server.ts:291`) route through it.
17. **Migrations stay squashed into `0001_baseline.sql`** while pre-prod. Edit in place; wipe and
    re-seed locally afterwards.
18. **`tsc` is a required gate.** `npm run build` does not typecheck.
19. **`app/ui/` must not import from `app/features/`**; client components must not import
    `*.server.ts` at runtime.
20. **The stylesheet is the design surface.** Every class name used in `app/` must have a rule
    (`app.css.test.ts:602`, no allowlist); an inline `style={{}}` whose values are all literals is a
    test failure; a new breakpoint must be declared once and named. Do not reintroduce a drag grip.
21. **“Nothing reads it” is not proof something is dead** when a library or a projection consumer
    owns it — `verification` and `task_projections.repo` were each one edit from deletion (§4.3).

---

## 10. Deliberate divergences from `planning/planning-artifacts/architecture.md`

That document is the original architecture decision record, but it is **maintained, not frozen** —
its directory tree is regenerated from the filesystem and its Authentication section carries an
explicit “Revised 2026-07-25” note. Where it contradicts the code, the code is authoritative. The
numbered orchestrator rulings that code comments cite live in
`docs/architecture/decisions.md:119-284` (34 of them).

| Original intent | Current reality | Recorded where |
| --- | --- | --- |
| “OAuth-first login” | **Local email+password is the shipped default and first-class**; OAuth is optional and inert without env vars; no self-signup on any path | architecture.md revised inline 2026-07-25 |
| Hand-rolled sessions | `better-auth` is the sole auth system behind a Viberr bridge, with the `/api/auth/*` splat allow-list | `app/lib/auth.server.ts` |
| “SQL-first migrations, explicit and checked in” | **Squashed into a single `0001_baseline.sql` while pre-prod** | owner ruling, pass 11; `0001_baseline.sql:10-19` |
| Nothing about concurrency between processes | **Exclusive single-writer lock on the data root (B-FD1)** | `app/server/db/data-root-lock.server.ts` |
| Raw `node:fs.watch` recursive watchers | **chokidar 5** for both watchers | modernization 2026-08-03 (A1) |
| HTML5 `dataTransfer` board drag | **@dnd-kit/react**, whole-card, non-optimistic, ARIA plugin removed — and as of pass 16 the **same** language governs the project-settings stage list | modernization (A2) + pass-16 wave 2 |
| `<textarea>` + transparent mirror backdrop composer | **Lexical plain-text composer**; posted bytes unchanged | modernization (A3) |
| E2E against a dev server | **E2E runs the production Docker image** in an isolated compose stack | owner policy 2026-08-02 |
| “Simulated” agent runtime for demos | **Do not simulate at all** — only an e2e/test-only fake adapter remains | ruling R7-2 |
| Demo data in the product seed | **Clean-sheet product seed** (`npm run seed`); the mock dataset lives in `test-support/` behind `npm run seed:demo` | pass 11 |
| Topbar “global search” input | Replaced by the **⌘K command palette** over the viewer's visible projects | ruling R15-5 |
| App-wide readable boards (“FR4”) | **Projects are members-only** — a non-member gets the unknown-slug 404 | ruling R15-4; `app/shared/rbac.ts:18-26` |
| No stated hydration policy | **Absolute-UTC first paint** for every timezone/now-dependent string | commit `12db757` |
| “Structured JSON logs with request/job correlation identifiers” (shipped once as an unused opt-in, then deleted) | Correlation is now **non-optional** root middleware | `app/root.tsx:55` |
| Capability grants as a display-only policy matrix | **Repo-mutating grants map to real `disallowedTools`** (`specialist-tool-policy.ts`), safe-by-default: no grant means withheld | P14-LV-01 |
| MCP grants inside the capability system | **MCP stays outside the matrix** (R16-5) — granting a server IS the grant; the disclosure names the consequence and a test pins the absence of an `mcp__*` deny rule | ruling R16-5 |

---

## 11. Known drift, sharp edges, and surprises

Things that are true today and will confuse someone who reads only the comments. Nine of the
pass-16 doc's twenty items were closed by the waves (see the Delta table); these are what remain,
plus what the waves introduced.

**Naming / documentation drift**

1. **There are no `--viberr-*` CSS tokens.** Every custom property in `app.css` is unprefixed
   (`--bg`, `--fg`, `--blue`). Any instruction referring to a `--viberr-` namespace describes
   something that does not exist.
2. `app.css` **comments** reference eleven tokens that were removed long ago: `--accent`,
   `--coral` (only `--coral-light`/`--coral-dark` exist), `--font-sans`, `--ink`, `--line`,
   `--link`, `--mono`, `--panel`, `--panel-2`, `--surface-2`, `--teal`. `app.css.test.ts:54` strips
   comments before validating, which is why they don't trip it — but a naive grep will “find”
   undefined tokens. **Live `var()` usage is 100 % clean.**
3. `app/ui/mention-spans.ts:5` still describes a “composer highlight backdrop” that the Lexical
   commit deleted. No backdrop element exists.
4. **Thread-id docstrings are still wrong in the code**: `adapter.server.ts:18` and
   `run-service.server.ts:195` both say `("op" | "primary" | "c0")`. There is no `c0`. Reality:
   `DEFAULT_THREAD = {operator:"op", primary:"primary", reviewer:"r0"}`
   (`run-service.server.ts:249-253`), operators actually get `op-<8 chars>`
   (`operator-run.server.ts:1136`, `:1665`), and a resume mints `<thread>-r<6>` (`:704-705`).
   Wave 3's D5 fixed three lying docstrings and missed this one.
5. `run-store.server.ts:8-9` (the **file header**) still documents the raw-log path as
   `<sessionOrRunId>.jsonl` — the exact claim the function docstring 350 lines below (`:355-365`)
   explicitly retracts. Same falsehood, one docstring higher.
6. `docs/architecture/decisions.md:64-66` names two SSE events (`task.readiness-changed`,
   `auth.session-expired`) that do not exist, and its route map (`:285-297`) omits
   `/resources/search`, `/notifications/read` and `/prefs/theme`.
7. Ruling **R16-7** (`FINDINGS.md:29-31`) asserts that `docs/contributing-quickstart.md` and
   `docs/testing-quickstart.md` no longer exist. **Both exist** (29 and 40 lines), last touched in
   pass 13. The ruling's conclusion (delete the branch) may still be right; its stated reason is not.

**Real, potentially behavioral**

8. **`agent_runs.outcome_key` is still invisible to the row layer.** The column exists
   (`0001_baseline.sql:300`) and is written by a bare out-of-band `UPDATE`
   (`task-actions.server.ts:2152`), but `AgentRunRow` (`run-store.server.ts:14-43`), `upsertRun`'s
   INSERT/`ON CONFLICT DO UPDATE` lists (`:78-101`) and `RunPatch` (`:131-145`) all omit it. It
   survives upserts only because the conflict column list happens not to mention it.
9. **Log-line clocks are server-local wall time.** `wire-format.server.ts:7-12` uses
   `getHours/getMinutes/getSeconds`, so `LogLine.t` carries the *server's* clock — the same class of
   bug that was fixed for `finished_at` by shipping ISO and formatting client-side. `log-clock.ts`
   re-anchors and reprojects it at render time, which mitigates but does not remove the stored-value
   issue.
10. **`VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` bypasses the env schema** and is undocumented in
    `.env.example` (§8.1). The one variable an operator sets during a key rotation is the one with
    no validation; malformed entries are silently skipped.
11. **The KB watcher's transient re-arm is not generation-guarded** (`kb-watch.service.server.ts:150`
    checks only for an `undefined` handle), unlike the store watcher's F10-08 fix. A teardown during
    the 1 s window cannot cancel it.
12. `codexSpawnEnv` explicitly `delete`s `CODEX_API_KEY`/`OPENAI_API_KEY` that `filteredSpawnEnv`
    already stripped via `CREDENTIAL_ENV_RE` one call earlier
    (`runtime-registry.server.ts:463-480`), behind a conditional and a comment that reads as
    load-bearing. Now conditional, still unreachable.
13. `run-sink.server.ts`'s `effectiveBackend` is write-after-use — initialized to `spec.backend`
    (`:154`), read by every `appendRawLine` (`:204`, `:268`), assigned from the exit only in
    `finalize` (`:319`). Vestigial from a fallback-adapter era; harmless only because
    `RunExit.effectiveBackend` always equals the requested backend.
14. Claude's adapter-authored error lines write `raw: ""` (`claude-runtime.server.ts:446`, `:476`,
    `:664`, `:690`), which `appendRawLine` turns into a bare newline in the NDJSON transcript. Codex
    synthesizes a real event object instead — an asymmetry in the on-disk log format.
15. **A `pre-R16-1` PR binding does not self-heal.** The adoption rule stops a foreign PR from being
    bound; it does not un-bind one written before the rule existed.
    `github-reconciler.server.ts:288` treats a discovery matching the cached number as an owned link
    and keeps its live facts — right in general (a task's own PR moves its head), but it means a task
    polluted before pass 16 still carries the foreign PR in its `task.md`. The product path out is
    the operator's branch-collision packet plus `archive_task(+deleteBranch)`; a self-heal would need
    its own owner ruling about when Viberr may drop a PR reference it once wrote.
16. **The pass-16 companion docs are stale in the same way this one's predecessor was.**
    `DOMAIN-MODEL.md`, `RBAC-GOVERNANCE.md`, `UI-INVENTORY.md`, `AGENTS-RUNTIME.md` and
    `TESTING-INFRA.md` were written against `2442945`; only `TESTING-INFRA.md` and `UI-INVENTORY.md`
    received partial wave-3 corrections. Their §"drift"/§"rough edges" lists are the pass-16
    *backlog*, most of which is now fixed — do not re-file from them without checking the tree.
17. **`design/html-app/app/tweaks-panel.jsx` is not an unported screen.** It is the prototype host's
    edit-mode scaffold (`@ds-adherence-ignore`), and orchestrator ruling 8 states it is deliberately
    not ported. Nothing in `app/` or in `design/html-app/app/` references it.
18. `doctor.config.ts` ignores `data/` but **not** `docker-data/`, so an `npx react-doctor` run
    against the live dev root will scan the nested workspace clones.
