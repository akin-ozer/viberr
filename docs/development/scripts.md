# Scripts and CLIs

> Every entry in `package.json` `scripts` plus the loose tools under `scripts/`, with
> what each touches and whether it takes the data-root writer lock. Source of truth:
> `package.json`, `scripts/*`, `app/server/db/cli-lock.server.ts`,
> `app/server/db/backup.server.ts`, `app/server/db/sqlite.server.ts`
> (`openDatabaseReadOnly`), `app/server/seed/*`, `app/server/org/org-seed.server.ts`,
> `test-support/demo-seed.ts`.
> Verified against `main` @ `7d9fbf72` (2026-09-23).

## 1. The writer lock rule

The app holds `<dataRoot>/state/writer.lock` while it runs. A CLI that writes the store
or the database takes the **same lock** through `runWithDataRootWriterLock`
(`app/server/db/cli-lock.server.ts`), with the same staleness rules boot uses; against a
live instance it prints `"<command> refused to run: it would be a SECOND writer on this
data root"` to stderr, followed by the holder and, where there is one, the in-app
alternative, and exits 1. The lock is released when the command finishes, however it
finishes. `VIBERR_FORCE_DATA_ROOT_LOCK=1` forces a takeover for both the app and the CLIs
(only when you know the holder is dead). `docker compose exec app npm run seed` is
therefore **refused**; seed before the container starts or stop it first.

Read-only CLIs take no lock and never open a live database (ruling 158): `npm run backup`
and `npm run keys -- status` go through `openDatabaseReadOnly`, which opens the file in
place, read-only, only when the root has no `state/writer.lock`; with a lock file there at
all it copies `projection.sqlite` and its `-wal` to `state/tmp/reader-<pid>/`, opens the
copy and removes it on close. `npm run store:check` and `restore --file` open no database
at all. A new read-only CLI should use the same helper.

Every script that imports the app's config loads `.env` from the working directory first
(`env.server.ts`), so a host-side CLI reads the same `VIBERR_DATA_ROOT` as `npm run dev`.

## 2. Table

| Command | Lock | Does |
|---|---|---|
| `npm run dev` | app | `react-router dev`: Vite dev server on `PORT` (default 5173, `strictPort`); boots the whole server, including watchers and background timers |
| `npm run build` / `npm run start` | app (`start`) | `react-router build` / `react-router-serve ./build/server/index.js` (the image runs the serve binary with `node` directly instead, see [deployment.md](../operations/deployment.md#what-runs)) |
| `npm run lint` | none | `oxlint` with the vendored anti-slop plugin (`tools/oxlint/anti-slop/`, config `.oxlintrc.json`); must exit 0 |
| `node scripts/anti-slop-manifest.mjs` | none | re-pins `tools/oxlint/anti-slop/` to `tools/oxlint/anti-slop.manifest.json` (relative path → sha256) after the install-anti-slop skill refreshes it (`app/shared/docs/anti-slop-vendor-sync.test.ts` holds the tree to that manifest); not in `package.json` |
| `npm run typecheck` | none | `react-router typegen` + `tsc` |
| `npm test` | none | `vitest run` over `app/**/*.test.{ts,tsx}` (`vitest.config.ts`) |
| `npm run e2e [-- <playwright args>]` | n/a (Docker) | `tsx scripts/e2e.ts`: production-image Playwright run in the isolated `viberr-e2e` compose project; `VIBERR_E2E_KEEP=1` keeps the stack up. See [testing.md](testing.md#4-end-to-end-suite-playwright) |
| `npm run deploy [-- --no-up]` | n/a (Docker) | `tsx scripts/deploy.ts` (ruling 345): stamps `VIBERR_BUILD_VERSION`/`SHA`/`TIME` from `package.json` and git, `docker compose build`, then (unless `--no-up`) `docker compose up -d` and polls `/resources/health` on the port compose publishes (`PORT` from the shell, else `.env`, else 3000) for up to 180 s, exiting 1 unless the running build reports the stamped sha. See [deployment.md](../operations/deployment.md#upgrades) |
| `npm run seed [-- --reset]` | **writer** | product baseline: bootstrap admin, three agent profile templates, org KBs and skills, domain allowlist. No projects, tasks, notifications or run history |
| `npm run seed:demo [-- --reset]` | **writer** | test/dev fixture: five users, three projects, twelve tasks, notifications, one scope violation; refuses in the production image (no `test-support/`) |
| `npm run rescan [-- --force]` | **writer** | `rescanProjections` (hash short-circuit unless `--force`) and a report of untrusted files from the `diagnostics` table |
| `npm run store:check` | none, no DB | parses every `project.md`, `tasks/*/task.md`, `goals/*.md`; exit 1 when any file is untrusted |
| `npm run backup [-- --out <dir>] [--include-runtimes]` | none; with a `state/writer.lock` present at all it reads a copy of the DB taken under `state/tmp/`, never the live file (ruling 158) | `VACUUM INTO` snapshot + store tree copy (incl. `audit-exports/`, ruling 102) + manifest, whose first `contains` line says whether the projection was read from the file or from a copy |
| `npm run restore -- --from <artefact> [--force]` | **writer** | whole-root restore; occupied roots need `--force` and are moved aside, never deleted |
| `npm run restore -- --from <artefact> --file <store path>` | none | single canonical file restore; the displaced file is kept as `<file>.broken-<ts>` |
| `npm run keys -- status` | none; reads a copy of the DB whenever `state/writer.lock` is present (ruling 158), and says so | how many sealed secrets still open only under a retired `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` key, across every registered store (`SEALED_STORES`): GitHub PATs, MCP server credentials, sign-in provider secrets, the S3 audit-export secret and personal backend API keys (`user_backend_credentials`, ruling 127; a `login` row has no box and is skipped) |
| `npm run keys -- reseal [--dry-run]` | **writer** | re-seal them under the current key, personal backend keys included. A row it reports as unopenable is a person who must connect that backend again; the report names the backend, never the person's email |
| `node scripts/measure-routes.mjs [routeId…]` | none | client asset closure per route (raw + gzip bytes, stable JSON) from a prior `npm run build`; not in `package.json`. `--check` compares every `bundle:` entry of `test-support/perf-budgets/bundle.json` and exits 1 on a regression or an unrecorded improvement (ruling 454; a CI step) |

`tools/` holds no CLI: `tools/oxlint/` is the vendored lint plugin and its manifest.

## 3. Details that matter

### `npm run seed`

1. `ensureDataRootDirs`.
2. With `--reset`: `rm -rf projects/`, `agents/profiles/`, `runtimes/claude/`,
   `runtimes/codex/` (the RUN-LOG dirs only, never `runtimes/users/`, which holds every
   person's own vendor sign-in, ruling 127), then `DELETE FROM` `staged_outcomes,
   run_log_lines, agent_runs, notifications, provenance, diagnostics, scope_violations,
   user_prefs, task_events, task_projections, project_members, projects`
   (`DERIVED_TABLES`); then `kb/`, `skills/` and the tables `org_knowledge_bases,
   org_mcp_servers, org_skills, google_domain_allowlist`.
3. `seedInitialAdmin` (`VIBERR_SEED_ADMIN_EMAIL ?? admin@viberr.dev`,
   `VIBERR_SEED_ADMIN_PASSWORD ?? viberr-dev-2828`) only on an empty users table; an
   existing admin with an unverifiable legacy hash is re-hashed to the configured
   password.
4. Writes the `operator`, `developer`, `reviewer` templates (`SEED_AGENT_PROFILES`) and
   `rebuildAll(force)`; audit `seed.baseline`.
5. `seedOrgResources`: three KBs (`architecture-notes`, `api-contracts`,
   `deploy-runbooks`, 15 files), four skills (`conventional-commits`,
   `terraform-review`, `api-design`, `changelog-writer`), one allowlist row
   `@viberr.dev → member`; existing KB/skill folders are skipped on a plain re-seed;
   zero MCP servers and zero GitHub connections; audit `seed.org_resources`.

Survives `--reset`: every auth table, `github_connections`, `github_pats`,
`project_github_credentials`, `instance_settings`, `s3_audit_config`,
`model_availability`, `user_backend_credentials`, controller conversations,
`oauth_providers`, and on disk `runtimes/users/` (each person's `claude-home` and
`codex-home`), `runtimes/uv-*`, `audit-exports/`. A `--reset` that deleted
`runtimes/users/` would sign every person on the instance out of their own Claude and
Codex accounts.
Does **not** survive: `kb/`, `skills/`, admin-registered MCP server rows, `user_prefs`,
`scope_violations`.

### `npm run seed:demo`

Upserts users `arda@viberr.dev` (org admin), `elif`, `murat`, `selin`, `deniz`
(members; deniz is a registered non-member), all with `viberr-dev-2828` (arda honours
`VIBERR_SEED_ADMIN_PASSWORD`); the Developer template is forced to `backends: [codex,
claude]` with model `gpt-5.6-terra`; projects `viberr-core` (`VIB`, governed 5-stage,
no PAT), `deploy-pipeline` (`DEP`), `billing-service` (`BIL`, custom 3-stage board);
ten full tasks in viberr-core plus `DEP-31` and `BIL-9`; ten notifications and Home pins
for Arda; one open scope violation on VIB-142; audit `seed.demo_dataset`; then
`seedOrgResources`. No run history, no PATs, no MCP servers. The fixture lives in
`test-support/demo-seed.ts`, which the final image does not ship; `compose.e2e.yml` runs
this command from the `build` stage.

### `npm run backup`

Writes `<--out ?? ./backups>/viberr-backup-<timestamp>/` (refuses an existing dir and
any path inside the data root): `projection.sqlite` via `VACUUM INTO` on whatever
`openDatabaseReadOnly` handed it (WAL folded in, no sidecars) — the live file, opened
read-only, ONLY on a root with no `state/writer.lock`; with a lock file there at all, a
copy of `projection.sqlite` and its `-wal` under `state/tmp/reader-<pid>/`, opened
read-write so SQLite recovers the WAL into it, and removed on close (ruling 158: no
process but the server opens a live root's database, and a reader cannot judge a
holder's liveness from another pid namespace, so presence is the whole question) —
`projects/`, `agents/`, `kb/`, `skills/`, `audit-exports/` (`BACKED_UP_STORE_DIRS`; a
directory that does not exist yet is skipped), without each task's `workspace/` checkout
and each project's `.repo-mirror/` (re-derivable from the remote, and possibly mid-write)
— and `runtimes/` only with `--include-runtimes`, which means every person's live vendor
sign-in under `runtimes/users/`; treat that artefact as a secret. `*.tmp` files are
skipped everywhere. It also writes `MANIFEST.json` (`viberr-backup/1`, sha256, row counts
for `users`, `session`, `account`, `github_pats`, `audit_events`, `notifications`,
`org_mcp_servers`) and `README.txt`. Always excluded: `state/writer.lock`, the encryption
key (back up `VIBERR_SECRET_ENCRYPTION_KEY` separately or the sealed columns are
unreadable, personal backend API keys included), `*.tmp`.

### `npm run restore`

Refuses a foreign manifest. "Occupied" = a non-empty `projects/`, `agents/`, `kb/`,
`skills/` or `audit-exports/`, `runtimes/` when the artefact carries it, or any `state/*`
entry except the lock. With `--force` everything occupied is moved to
`<dataRoot>.replaced-<ts>/`, stale `-wal/-shm` are removed, the store and database are
copied back, audit `store.restored` is written inside the restored DB, and a `TRUNCATE`
checkpoint runs. The report says whether `runtimes/` was replaced. `--file` restores
exactly one canonical file under `projects/`, `agents/`, `kb/`, `skills/` or
`audit-exports/` and leaves the database alone; a running app re-projects it within
~1 s, otherwise run `npm run rescan`.

### `npm run store:check` versus `npm run rescan`

`store:check` is the first diagnostic: read-only, no lock, no database, names the
file, code, message, line and excerpt of every file the app cannot trust (hard stop) or
that is degraded (error). `rescan` counts parser *throws*, which tolerant parsing never
produces, so it reports zero errors for a malformed file and instead appends the
untrusted-file report from the projected diagnostics.

### `.claude/launch.json`

Two dev launchers exist for Claude Code users: `viberr-dev` refuses to start while a
`viberr-app-1` container runs and exports `VIBERR_DATA_ROOT=$PWD/docker-data` on port
5173; `viberr-dev-hermetic` uses `$PWD/data` on port 5174. Neither is part of CI.
