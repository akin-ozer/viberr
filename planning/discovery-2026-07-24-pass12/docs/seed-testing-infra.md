# Seed + testing infrastructure (pass 12 code map)

Repo: `/Users/akinozer/projects/viberr`, branch `main` @ `0981cfa`. This subsystem was rewritten in
the two most recent commits: `e306248` (clean-sheet product seed, owner ruling 2026-07-24: the
product ships NO demo board data) and `625eb71` (fixture drift guards + e2e switched to an explicit
demo-fixture seeder). All paths below are repo-relative unless absolute.

Two seeds now exist and must never be confused:

| | Product seed | Demo fixture |
|---|---|---|
| CLI | `npm run seed` → `scripts/seed.ts` | `npm run seed:demo` → `scripts/seed-demo.ts` |
| Core fn | `runSeed` in `app/server/seed/seed.server.ts:116` | `runDemoSeed` in `test-support/demo-seed.ts:136` |
| Ships | agent catalog templates, bootstrap admin, org KBs/skills; **empty board** | arda & co (5 users), viberr-core + 2 stubs, VIB-139..168, inbox, violation, pins |
| Consumers | fresh instances, Docker (`docker compose exec app npm run seed`) | ~19 vitest suites + the Playwright e2e run |

---

## 1. Product seed (`npm run seed`)

### Entry: `scripts/seed.ts`
- `scripts/seed.ts:19-29` — reads env (`getEnv()`), parses `--reset` from argv, calls
  `runSeed(getDb(), { dataRoot: env.VIBERR_DATA_ROOT, reset, admin })`. Admin email comes from
  `VIBERR_SEED_ADMIN_EMAIL` (only passed when set), password from `VIBERR_SEED_ADMIN_PASSWORD ??
  SEED_DEFAULT_PASSWORD` — so **the CLI always seeds a known password** (never the random one-time
  path; that path is boot-only).
- `scripts/seed.ts:33-36` — then calls `seedOrgResources(getDb(), { dataRoot, reset })`
  (`app/server/org/org-seed.server.ts:287`). Org resources are a *separate* seeder, run by the
  script, not by `runSeed`.
- `scripts/seed.ts:38-53` — prints the clean-sheet summary; either `Sign in: <email> / <password>`
  (admin created) or `Admin untouched (users already exist)`.

### Core: `app/server/seed/seed.server.ts`
- `seed.server.ts:55` — `SEED_DEFAULT_PASSWORD = "viberr-dev-2828"` (the well-known dev password).
- `runSeed` (`seed.server.ts:116-194`), in order:
  1. `ensureDataRootDirs` (`:121`), then `resetStore` if `--reset` (`:123`).
  2. **Bootstrap admin** (`:127-159`): calls the SAME `seedInitialAdmin` boot runs, with email
     defaulted to `DEFAULT_SEED_ADMIN_EMAIL` (= `admin@viberr.dev`,
     `app/server/auth/seed-admin.server.ts:19`), lowercased. If not created (users exist) and the
     configured admin email exists: **P11-01 recovery** (`:141-152`) — `provisionIdentity` then, if
     the stored credential is not a better-auth hash (`isBetterAuthPasswordHash`), re-hash to the
     configured password so a pre-migration data root isn't permanently locked out. A valid hash
     (legitimately changed password) is left alone.
  3. **Agent catalog templates** (`:162-170`): serializes each of `SEED_AGENT_PROFILES`
     (see §1c) to `agents/profiles/<id>.md` via `writeFileAtomic` + `serializeAgentProfile` —
     always **overwritten** (documented idempotency at `:45-46`).
  4. **Projection rescan** (`:174`): `rebuildAll(db, { dataRoot, force: true })` over whatever real
     project files exist — none on a fresh/reset store, so the board starts empty by design.
  5. Audit row `seed.baseline` (`:176-184`), returns `SeedSummary {adminCreated, adminEmail,
     agentProfiles, rescanChanged}` (`:64-70`).

### `seedInitialAdmin` — also runs at boot
- `app/server/auth/seed-admin.server.ts:37-91` — no-op unless `countUsers(db) === 0` (`:41`).
  Creates the admin (`role: "admin"`, name derived from the email local part, `:28-35`), provisions
  the better-auth identity. Without an env/CLI password it generates `randomBytes(12).base64url`
  (`:45`), sets `pwresetRequired` (`:54`), and logs the password ONCE marked
  `VIBERR BOOTSTRAP ADMIN` (`:77-81`).
- Boot call site: `app/server/boot.server.ts:102-105` — `bootServer()` calls it with
  `env.VIBERR_SEED_ADMIN_EMAIL` / `env.VIBERR_SEED_ADMIN_PASSWORD` on every startup (empty-table
  guarded). So an instance that never ran `npm run seed` still gets an admin: env-configured, or
  `admin@viberr.dev` + random printed password + forced reset. Env schema:
  `app/server/config/env.server.ts:85-89` (`VIBERR_SEED_ADMIN_EMAIL` must be an email,
  `VIBERR_SEED_ADMIN_PASSWORD` min 8 chars, both optional).

### `--reset`: what is wiped vs preserved
`resetStore` (`seed.server.ts:93-114`):
- **Wiped**: `projects/` dir (`:94-97`); `agents/profiles/` dir (`:98-101`, includes custom
  profiles); per-backend transcript dirs `runtimes/claude/` and `runtimes/codex/` (`:102-108` —
  loops exactly `["claude","codex"]`); all `DERIVED_TABLES` rows (`:72-83`): `staged_outcomes,
  run_log_lines, agent_runs, notifications, provenance, diagnostics, task_events,
  task_projections, project_members, projects`.
- **Preserved (critical)**: users/auth tables (`users` + better-auth `user/session/account/
  verification`), and the runtime **credential homes** `runtimes/codex-home/` (Codex subscription
  `auth.json`) and `runtimes/claude-home/` (Claude SDK sessions/config) — P11-04: deleting those
  logged the whole instance out of Codex. Guard test:
  `app/server/seed/seed.server.test.ts:134-154` writes `runtimes/codex-home/auth.json`,
  `runtimes/claude-home/config.json`, and a `runtimes/codex/run_abc.jsonl` transcript, then asserts
  homes survive and the transcript dies. Also preserved: `github_pats`,
  `project_github_credentials`, `github_connections`, `audit_events`, org tables (but see
  `seedOrgResources` reset below), `scope_violations`, `user_prefs` (the last two look like
  omissions — see Findings).

### Org resources: `app/server/org/org-seed.server.ts`
`seedOrgResources` (`:287-387`) — run by BOTH CLI scripts, not by `runSeed`/`runDemoSeed`:
- 3 KBs with real on-disk files under `${dataRoot}/kb/<dir>` (`KB_SEEDS` `:49-174`:
  `architecture-notes` 6 files, `api-contracts` 6 files, `deploy-runbooks` 3 files), rows
  `INSERT OR REPLACE` with deterministic ids (`kb_seed_*`) and back-dated file mtimes
  (`backdate`/`writeSeedFile` `:264-285`).
- 4 skills with `SKILL.md` + extras under `/skills/` (`SKILL_SEEDS` `:176-254`:
  `conventional-commits`, `terraform-review`, `api-design`, `changelog-writer`).
- Google domain allowlist row `@viberr.dev → member` (`:361-366`).
- **Honest empty slate** (`:256-262`, `:358-359`): NO MCP servers, NO GitHub connection seeded
  (the old fabricated `github-mcp`/placeholder-PAT rows are gone); `connections` in the summary
  just counts whatever `github_connections` rows already exist.
- Its own `reset` (`:295-307`): rm `kb/` + `skills/` dirs and DELETE from
  `org_knowledge_bases, org_mcp_servers, org_skills, google_domain_allowlist`, then reseed.

### Agent catalog: `app/server/seed/agent-catalog.server.ts`
PRODUCT data (moved out of the old demo mock by `e306248`); consumed by the seed, boot
default-assets, ensure-base-agents, and project creation
(`app/features/home/project-create.server.ts`).
- `mapActions` (`:23-40`) — maps action-label lists onto `CAP_CATALOG` ids via `capabilityByLabel`;
  unmatched labels become display-only `extras`. Modes: direct/recommend/forbidden→`human`.
- `SEED_AGENT_PROFILES` (`:79-152`) — exactly 3 profiles:
  - **operator** (`:80-100`): kind `operator`, backends `[claude, codex]`, model
    `"orchestration runtime"`, all 5 stages + `spanAll`, resources: skill
    `viberr-app-expertise`, MCP `viberr` (the real in-process governance server), KB
    `architecture-notes`. Forbidden: execute-code, transition-to-done, change-policy.
  - **developer** (`:101-127`): specialist, backends `[codex, claude]`, model `gpt-5.6-sol`,
    stages ready/impl, skills `developer-expertise`, `mcps: []` (honest slate, `:109-112`), KBs
    `architecture-notes` + `api-contracts`. Direct includes the HEADLINE
    `"Execute code or write to the repo"` — the master delivery gate (F14/VIB-1 comment
    `:118-121`).
  - **reviewer** (`:128-151`): specialist, backends `[claude]`, model `sonnet`, stages
    impl/review, KB `api-contracts`; forbidden includes the exact catalog label
    `"Commit & push to the branch"` so it becomes a real `commit-push-branch: human` grant
    (`:145-148`), not decorative.
- Deployments: `defaultAgentDeployments()` (`:160-162`, full roster — app-created projects + demo
  fixture) and `baseAgentDeployments()` (`:177-180`, filtered to
  `BASE_AGENT_PROFILE_IDS = [operator, developer, reviewer]` `:169-173`); both run
  `normalizeDeliveryGrants` (F14 repair) per profile (`:182-189`).

### Boot-time asset shipping (adjacent, for completeness)
- `app/server/seed/default-assets.server.ts:97-114` (`seedDefaultAgentAssets`, called at boot
  `boot.server.ts:99`) — writes bundled (`?raw`-imported from `app/server/seed/assets/`) skills,
  the operator definition, the **hand-written** `assets/operator.profile.md`, and
  specialist profile templates *generated* from `SEED_AGENT_PROFILES` with `kb: []` stripped
  (`:74-94`, the "N of 0 ghost" fix) — **only when the destination file is missing** (never
  clobbers, test `base-agents.server.test.ts:110-118`).
- `app/server/seed/ensure-base-agents.server.ts:32-90` (`ensureBaseAgentsDeployed`, boot
  `boot.server.ts:133`) — operator unconditionally re-ensured on every project; Developer/Reviewer
  backfilled only into a project with zero specialists (E10 roster-respect rules `:19-31`).
- Product-seed tests: `app/server/seed/seed.server.test.ts` (clean-sheet counts `:37-65`; env
  admin honored + lowercased `:67-81`; empty-table-only `:83-94`; P11-01 legacy-scrypt re-hash
  `:96-114`; reset-to-clean-sheet from a demo store `:116-132`; P11-04 homes survive `:134-154`).
  Catalog/asset tests: `app/server/seed/base-agents.server.test.ts` (real model ids `:24-41`,
  base template has no KB grants `:87-108`, persona assembly `:121-157`, E10 backfill matrix
  `:159-240`).

---

## 2. Demo fixture (TEST/DEV ONLY)

### `test-support/demo-data.ts` (~831 lines)
The former production mock, kept verbatim as data: `SEED_PEOPLE` (`:74-81` — arda admin, elif,
murat, selin, deniz all member; deniz is a registered NON-member/guest), time helpers
`todayAt/yesterdayAt/mar30At` (`:46-58` — the dataset is *relative to NOW*, re-dated every seed),
`seedProjects` (`:145` — viberr-core with GOVERNED_TEMPLATE + full member matrix +
`defaultAgentDeployments()` + credentialPolicy with `masked: ""` honest slate + 5 guardrails;
stub `deploy-pipeline` (governed) and `billing-service` (LIGHTWEIGHT 3-stage)), `seedTasks`
(`:333` — the 10 viberr-core tasks VIB-139..168 with packets + 9-type timelines), `seedStubTasks`
(`:697` — DEP-31, BIL-9 so cross-project inbox rows navigate to real records), `seedNotifications`
(`:803` — Arda's 10-row inbox with deterministic ids `n-*`).

### `test-support/demo-seed.ts` — `runDemoSeed` (`:136-285`)
`--reset` delegates to the product `resetStore` (`:143`). Then:
1. `upsertUsers` (`:73-134`) — upsert by email; existing users keep credentials but get
   display fields realigned; P11-01-style re-hash of legacy credentials (`:96-106`); new users get
   `adminPassword ?? SEED_DEFAULT_PASSWORD` for arda, `SEED_DEFAULT_PASSWORD` for the rest.
2. Agent profile templates from the shared `SEED_AGENT_PROFILES` (`:149-157`).
3. Project files (`:160-170`), 4. task files + 4b stub tasks (`:172-206`) — written through the
   CURRENT serializers (`serializeProjectFile`/`serializeTaskFile`) with
   `unknownFrontmatter: {}`.
5. `rebuildAll(force: true)` (`:210`).
6. Notifications via the real `createNotification` with `bypassPrefs: true` (`:213-232`).
7. The one open scope violation `sv_seed_vib142_pr_write` via `INSERT OR IGNORE`
   (`:239-247`) — a resolved violation stays resolved across re-seed.
8. Arda's Home pins in `user_prefs` via `INSERT OR IGNORE` (`:251-261`).
No run history is ever fabricated (`:234`).

### Importers (who uses the fixture)
22 files import `test-support/demo-seed` (grep `from ".../test-support/demo-seed"`, static or
dynamic). The **15 route suites** (dynamic `await import(...)` after `setupAppTest()` so the module
graph sees the overridden env — pattern at
`app/features/activity/activity-route.server.test.ts:20`):
`activity`, `agents`, `model-catalog`, `github`, `home-phase10`, `notifications`, `org-settings`,
`policy`, `profile`, `project-settings` (settings-route), `review`, `shell/workspace-routes`,
`task-detail`, `task-detail/task-runtime`, `app/routes/run-artifact-routes`. Plus non-route:
`app/server/auth/session-renewal.server.test.ts`, `app/server/org/org-seed.server.test.ts`,
`app/server/projections/policy-violations.server.test.ts`,
`app/server/seed/base-agents.server.test.ts`, `app/server/seed/seed.server.test.ts` (reset test),
`app/server/seed/demo-fixture.test.ts`, and `scripts/seed-demo.ts`.

### Drift guards: `app/server/seed/demo-fixture.test.ts`
Shape-pin suite for the fixture (header `:22-27`):
- Counts pin (`:40-64`): 5 users / 3 projects / 12 tasks / 36 events / 10 notifications /
  3 profiles / 7 project_members / 0 diagnostics / 0 agent_runs+run_log_lines.
- Idempotency (`:66-75`).
- Credentials + avatar tones (`:77-93`).
- **DRIFT GUARD 1** (`:95-135`): every one of the 12 task files must `readTaskFile` with zero
  diagnostics AND `unknownFrontmatter === {}`, then round-trip
  `parseTaskFileContent(serializeTaskFile(parsed))` reproducing frontmatter/packet/timeline
  exactly; same for the 3 project files via
  `parseProjectFileContent(serializeProjectFile(...))`. Rationale (`:96-103`): loose parsing
  tolerates unknown keys silently (the store is human-editable by design), so a renamed/removed
  schema field would keep every route suite green while the fixture stopped representing what the
  product writes — this fails loudly and forces the fixture migration into the same change.
- **DRIFT GUARD 2, writer parity** (`:137-152`): a task created through the REAL `createTask`
  action (`app/server/tasks/task-actions.server.ts`) into the fixture store must also parse with
  zero diagnostics/unknown frontmatter — anchors the fixture world and the real write path to one
  schema.
- Board-shape pin (`:154-183`, stage buckets incl. `displayReadiness: "merged"` for VIB-139),
  VIB-142 deep fidelity spot-check (`:185-256`, packet strings/option kinds/timeline
  types/actors/evidence/back-dated assign at local 15:12), guest flag (`:258-267`), inbox order +
  unread set + cross-project refs (`:269-299`).
- **Known residual risk** (documented `docs/testing.md:44-46`): a dead-but-tolerated field — one
  the schema still *knows* but the product no longer *writes* — passes both guards; caught only by
  full product passes.

---

## 3. Playwright e2e

### `playwright.config.ts`
- Isolated world: port 5177, `E2E_DATA_ROOT = e2e/.tmp-data` (`:20-21`), gitignored
  (`.gitignore:13-14` also covers `e2e/.auth/`).
- `E2E_ENV` (`:24-39`): deterministic `VIBERR_SESSION_SECRET` / `VIBERR_SECRET_ENCRYPTION_KEY`
  (base64 of 32 zero bytes), `VIBERR_SEED_ADMIN_EMAIL=arda@viberr.dev`,
  `VIBERR_SEED_ADMIN_PASSWORD=viberr-dev-2828` ("belt and braces" for boot-before-seed). Note
  `:35-38`: the simulated runtime is GONE — specs 02-packet/04-runtime were deleted with it; no
  agent credential is set, runs would report unavailable.
- `webServer.command` (`:72-82`): `rm -rf e2e/.tmp-data && npm run seed:demo && npm run dev` —
  **the demo fixture, not the product seed** (the `625eb71` fix: the suite previously ran
  `npm run seed` and would have booted an empty board after the clean-sheet change). Health URL
  `/resources/health`, `reuseExistingServer: false`, one worker (`:44`, shared seeded store).
- Projects (`:59-70`): `setup` runs `e2e/auth.setup.ts` first; `chromium` depends on it and
  reuses `storageState: "e2e/.auth/arda.json"`.
- `globalTeardown` (`:57` → `e2e/global-teardown.ts:5-10`): rm -rf the tmp data root.

### `scripts/seed-demo.ts` (`npm run seed:demo`, package.json:16)
`:21-30` — `runDemoSeed(getDb(), { dataRoot: env.VIBERR_DATA_ROOT, reset,
adminPassword: env.VIBERR_SEED_ADMIN_PASSWORD ?? SEED_DEFAULT_PASSWORD })` +
`seedOrgResources`; prints a summary explicitly labeled "test/dev only — the product seed is a
clean sheet" and the sign-in lines (`:32-46`). Also the sanctioned way for a developer to get the
demo board locally.

### `e2e/auth.setup.ts`
`:9-26` — logs in through the real `/login` UI as `arda@viberr.dev` / `viberr-dev-2828`
(hardcoded `:16-17`), with a hydration-race retry loop (`expect(...).toPass` around
fill+submit+waitForURL, `:14-20`), asserts Home renders a project card, saves storage state.

### Specs (8 tests + 1 setup = the "9 green")
- `e2e/01-home-board.spec.ts` — 3 seeded projects on Home; viberr-core board renders 5 stage
  columns with the VIB-142 card linking to the task workspace.
- `e2e/05-feeds-profile.spec.ts` — review queue partitions ("Waiting on your acceptance" vs
  "Still in review", R8-3 rename; VIB-142 on the agent side); day-grouped activity feed;
  notifications mark-all-read; profile theme switch persists across reload. Header `:8-12`: these
  assert SEEDED state only — the specs that mutated governed state died with the simulated
  runtime.
- `e2e/06-org-settings-store.spec.ts` — org settings tabs (connections/users/resources) for an
  org admin; StoreBrowser performs a REAL file-store mkdir through the UI.

---

## 4. Unit/integration test layout

### `vitest.config.ts`
- Node environment for everything (`:10-11`); `include`: `app/**/*.test.{ts,tsx}`,
  `db/**/*.test.ts`, `scripts/**/*.test.ts` (`:16-20`); tsconfig-paths resolved natively by
  Vite 8 (`:4-7`); setup files `test-support/setup-env.ts` + `test-support/setup-dom.ts` (`:15`).
  (Note: `test-support/**` itself is not an include root — helpers only, no tests there; and no
  `scripts/*.test.ts` currently exists.)

### `test-support/setup-env.ts` (hermetic env)
- `:15-19` — seeds `VIBERR_SESSION_SECRET` and `VIBERR_SECRET_ENCRYPTION_KEY` (32-byte base64)
  with `??=` BEFORE any app module loads, so `getEnv()`'s fail-fast validation passes with no
  `.env` (CI has none).
- `:40-51` — **fail-closed against paid backend calls (F10-10)**: assigns `""` (NOT `delete`,
  NOT `??=` — rationale `:33-39`: `loadEnvFile` only fills keys *absent* from `process.env`, so a
  deleted key would hand the developer's `.env` credential back) to every credential
  `hasCredential()` inspects: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `VIBERR_CLAUDE_USE_CLI_AUTH`, `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, `OPENAI_API_KEY`,
  `VIBERR_CODEX_USE_CLI_AUTH`, `CODEX_HOME`. A test exercising real-backend detection must set
  them explicitly in-test.
- `test-support/setup-dom.ts` — jsdom 29 `HTMLDialogElement` polyfill (showModal/show/close
  toggling `open` + firing `close`); no-op under node.

### Helpers (`test-support/`)
- `test-db.ts:24-49` — `createTestDbContext()`: `makeDb()` (fresh migrated SQLite in a mkdtemp
  dir; migrations from `db/migrations/` — a single squashed `0001_baseline.sql`, per the pass-11
  ruling), `makeTempDir()`, `cleanup()` for `afterEach`.
- `test-store.ts:52-` — `setupTestStore(ctx)`: minimal ACTION-BUILT store — temp root + migrated
  DB + 5 users with distinct project roles on a `viberr-core` project (arda proj-admin, murat
  maintainer, selin contributor, elif viewer, deniz non-member). This is sanctioned way #1.
- `test-app.ts` — route-level harness: points PROCESS env at a temp data root, resets env+db
  singletons, installs the fake runtime, provides `cookieFor`/`csrfFor`/`request()` (signed
  session cookies + CSRF + trusted-origin headers). Route modules must be dynamically imported
  AFTER `setupAppTest()` (header `:8-16`).
- `fake-runtime.ts` — scripted `RuntimeAdapter` via `configureRunServiceForTests` (the ONLY
  simulated runtime left; product simulation was removed in pass 7).
- `fake-github.ts` — canned-response `fetchImpl` keyed `"METHOD /path"`; no live GitHub in tests.
- `audit-log.ts` — raw `audit_events` reader (production reads go through the whitelisting
  display query).
- `livesix/` — **empty directory** (see Findings).

### Conventions (`docs/testing.md`, rewritten by `625eb71`)
- `:5-14` — `npm test` (app/, db/, scripts/; env auto-seeded, no `.env` needed).
- `:16-24` — `npm run e2e` seeds the **demo fixture**, isolated root.
- `:26-46` — the two sanctioned ways to build test state: (1) product actions on
  `test-store.ts` (preferred for behavior tests — can't drift), (2) the demo fixture (route/e2e +
  hand-edited-file coverage), guarded by the two drift guards; residual dead-but-tolerated-field
  risk documented.
- `:48-61` — `VIBERR_DATA_ROOT=$(mktemp -d) npm test` for hermetic ad-hoc runs (default
  `./data`). `docs/testing-quickstart.md` = 3 commands (test/typecheck/build).

---

## 5. Standing up a fresh dev instance

### Env contract (`app/server/config/env.server.ts`, template `.env.example`)
Required: `VIBERR_SESSION_SECRET` (≥32 chars), `VIBERR_SECRET_ENCRYPTION_KEY` (base64 of exactly
32 bytes). Key optionals: `VIBERR_DATA_ROOT` (default `./data`, `env.server.ts:76`), `PORT`
(5173 dev), `VIBERR_SEED_ADMIN_EMAIL`/`_PASSWORD` (`:85-89`), backend credentials
(`ANTHROPIC_API_KEY` | `CLAUDE_CODE_OAUTH_TOKEN` | `VIBERR_CLAUDE_USE_CLI_AUTH=1`;
`CODEX_ACCESS_TOKEN` | `CODEX_API_KEY` | `OPENAI_API_KEY` | `VIBERR_CODEX_USE_CLI_AUTH=1`),
`CLAUDE_CONFIG_DIR` and `CODEX_HOME` (`:116`) pointing session/auth dirs at the data volume,
`BETTER_AUTH_URL` (required behind a reverse proxy, warning at `boot.server.ts:85-92`).

### Flow (README "Quickstart", lines ~27-72)
`cp .env.example .env` (fill 2 secrets) → `npm ci` → `npm run seed` → `npm run dev` → sign in
`admin@viberr.dev` / `viberr-dev-2828` (or env-configured). Skipping the seed also works: boot
creates the same admin with a random printed one-time password. `npm run seed -- --reset`
returns to the clean sheet any time (users/auth + credential homes survive). For the demo board:
`npm run seed:demo` (README script table lines 80-81).

### Data root layout (`app/server/files/file-store-root.server.ts:23-37`)
`DATA_ROOT_SUBDIRS = projects, agents, agents/profiles, runtimes, runtimes/claude-home,
runtimes/codex-home, kb, skills, state` (SQLite lives under `state/`). `runtimes/<backend>/` holds
NDJSON run transcripts; the two `-home` dirs are credential/session homes.

### This workstation (`.claude/launch.json`)
`viberr-dev` config: nvm-activated `npm run dev` on port 5173 with
`VIBERR_DATA_ROOT=/Users/akinozer/projects/viberr/docker-data` and
`CODEX_HOME=/Users/akinozer/projects/viberr/docker-data/runtimes/codex-home` — i.e. the local dev
server shares the `docker-data/` store (gitignored, `.gitignore:4`) so Codex subscription auth
lives at `docker-data/runtimes/codex-home/auth.json`. **This is why `--reset` preserving
codex-home matters here** (pass-11 memory: a seed reset that killed codex auth).

### Docker parallels
- `Dockerfile`: node:26-slim, `VIBERR_DATA_ROOT=/data`, `CLAUDE_CONFIG_DIR=/data/runtimes/
  claude-home`, `CODEX_HOME=/data/runtimes/codex-home`, PORT 3000; copies `db/`, `scripts/`,
  `app/`, `tsconfig.json` into the runtime image so `docker compose exec app npm run seed|rescan`
  work via tsx (tsx is a **production** dependency, package.json:32).
- `compose.yml`: `./docker-data:/data` volume; host `~/.codex` mounted read-only at
  `/host-codex` (directory, not file — rename-safe); healthcheck on `/resources/health`.
- `scripts/docker-entrypoint.sh:16-21`: copies `/host-codex/auth.json` →
  `$CODEX_HOME/auth.json` only when missing (F-DOCKER1 self-repair after a volume wipe), chmod
  600, then `exec "$@"`.
- README deploy section (line ~153): `docker compose exec app npm run seed` is optional.

Other scripts: `scripts/rescan.ts` (`npm run rescan [-- --force]`) — manual projection
reconcile, unrelated to seeding but same env plumbing.

---

## Findings candidates (pass 12)

Verified while reading; each with the evidence location.

1. **`--reset` leaves the demo scope-violation and user-prefs rows behind** —
   `DERIVED_TABLES` (`app/server/seed/seed.server.ts:72-83`) omits `scope_violations` and
   `user_prefs`, both of which are board-derived state the demo fixture writes
   (`test-support/demo-seed.ts:239-247` open violation `sv_seed_vib142_pr_write` for
   viberr-core/VIB-142; `:251-261` Home pins/stars for viberr-core + deploy-pipeline). After
   `npm run seed -- --reset` on a store that ever held the fixture, the open violation row
   survives pointing at a deleted project; recreate a project with slug `viberr-core` and the
   rail Settings badge (`countOpenPolicyViolations`,
   `app/server/projections/policy-violations.server.ts:75-86`, keyed only on
   `project_slug + status='open'`) immediately shows a phantom violation for a task (VIB-142)
   that doesn't exist. Same class: stale `user_prefs` stars, and orphaned
   `project_github_credentials` rows (those at least are arguably the deliberate phase-7 "PATs
   survive" rule). The reset-coverage test (`seed.server.test.ts:116-132`) checks only
   projects/tasks/notifications, so this is untested.

2. **`npm run seed:demo` is shipped broken inside the Docker image** — the runtime image copies
   `scripts/` (which includes `scripts/seed-demo.ts`) and `app/` but NOT `test-support/`
   (`Dockerfile` COPY block, lines ~57-61), while `seed-demo.ts:16` imports
   `../test-support/demo-seed`. `docker compose exec app npm run seed:demo` fails with
   module-not-found. Either exclude the script from the image, guard it with a clear message, or
   copy `test-support/` — currently it's a dead script in the container next to a package.json
   entry that advertises it.

3. **Drift guards don't cover agent-profile files, and the profile schema can't even express the
   guard** — DRIFT GUARD 1 round-trips task + project files only
   (`app/server/seed/demo-fixture.test.ts:95-135`). Both seeds also write
   `agents/profiles/*.md`, and boot additionally ships the **hand-written**
   `app/server/seed/assets/operator.profile.md`. `agentProfileFrontmatterSchema` is `.loose()`
   with no `unknownFrontmatter` capture at all (`app/server/files/agent-profile-file.server.ts:
   26-69`), so a renamed profile field would silently pass through with zero detection anywhere —
   the exact failure mode the guards were built to catch, one file class over.

4. **The operator profile exists in two hand-synced sources** — `SEED_AGENT_PROFILES[operator]`
   (`app/server/seed/agent-catalog.server.ts:80-100`, written by both seeds, overwriting) vs the
   static `assets/operator.profile.md` (written by boot only-if-missing,
   `default-assets.server.ts:65`). Specialist templates are *generated* from the catalog
   (`default-assets.server.ts:74-94`), the operator is not. No parity test compares the asset's
   frontmatter to the catalog (base-agents.server.test.ts checks only `kb: []` and existence). A
   catalog edit to the operator (capability, stage, desc) will ship to seeded stores but NOT to
   fresh boot-only stores. Already visibly divergent: the asset has no `desc:` key (falls back to
   body-first-paragraph) while the seeded profile carries `desc` (`agent-catalog.server.ts:70`).

5. **`seedOrgResources` clobbers human edits to KB/skill files on every re-run** — `npm run seed`
   is documented as safe/idempotent, but `writeSeedFile` unconditionally overwrites the 15 KB
   files + 4 SKILL.md + extras and resets their mtimes (`org-seed.server.ts:279-285, 329-333,
   349-355`), and `INSERT OR REPLACE` resets row names/refresh cadence (`:316-327`). This is the
   opposite convention of `seedDefaultAgentAssets` ("never clobbers an existing asset",
   `default-assets.server.ts:41`, test `base-agents.server.test.ts:110-118`) for the same
   human-editable store. An admin who edited `kb/architecture-notes/overview.md` loses the edit
   on the next seed.

6. **`--reset` deletes admin-installed MCP servers but preserves GitHub connections** — the org
   reset wipes `org_mcp_servers` (`org-seed.server.ts:299-307`) and then seeds none back (honest
   empty slate), while `github_connections` is deliberately left intact (`:28-29, 358-359`).
   Both are "an admin installed a real integration" state; one survives reset, the other is
   silently destroyed. Inconsistent survival contract, undocumented in README's reset description
   (which only promises users/auth + credential homes survive).

7. **`test-support/livesix/` is a dead empty directory** — its only file (`vls-3.md`, a
   live-test probe marker from PR #17) was deleted by the Simplify commit `f578add`; git can't
   track the now-empty dir, so it lingers as local litter. Nothing references `livesix` anywhere
   (grep over ts/json/md: zero hits). Delete the directory.

8. **`viberr-dev-2828` is hardcoded in three places** — `SEED_DEFAULT_PASSWORD`
   (`seed.server.ts:55`) is the source of truth, but `playwright.config.ts:34` (E2E_ENV) and
   `e2e/auth.setup.ts:17` repeat the literal. Playwright config could import the constant (it's
   plain TS loaded by the Playwright runner); a password change would currently break e2e auth in
   a confusing way (seed uses new, login uses old).

9. **Stale "belt and braces" rationale in playwright.config.ts** — `:31-34` claims the env admin
   covers "if the server boots before the demo seed lands", but the webServer command (`:77`) is
   strictly sequential (`rm -rf && seed:demo && dev`); the server can never boot before the seed.
   Harmless (the env also keeps boot's `seedInitialAdmin` no-op consistent), but the comment
   describes an impossible race. Minor.

10. **`vitest.config.ts` includes `scripts/**/*.test.ts` but no such tests exist** — glob at
    `vitest.config.ts:19`; `scripts/` contains only `docker-entrypoint.sh`, `rescan.ts`,
    `seed-demo.ts`, `seed.ts`. In particular the two CLI entry scripts themselves
    (arg parsing, `seedOrgResources` composition, summary printing) have zero direct coverage —
    they're thin, but the `--reset`-passes-to-BOTH-seeders composition (`scripts/seed.ts:22-36`)
    is precisely where a wiring regression (like the pre-`625eb71` e2e product-seed mismatch)
    would live untested. Minor/forward-looking.
