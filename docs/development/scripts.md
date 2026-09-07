# Scripts and CLIs

> Every entry in `package.json` `scripts` plus the loose tools under `scripts/`, with
> what each touches and whether it takes the data-root writer lock. Source of truth:
> `package.json`, `scripts/*`, `app/server/db/cli-lock.server.ts`,
> `app/server/db/backup.server.ts`, `app/server/seed/*`, `app/server/org/org-seed.server.ts`.
> Verified against `main` @ `68b5480` (2026-09-01); the table and the backup contents
> re-verified 2026-09-02 against `pass32/implementation` @ `478bed0`.
> Updated 2026-09-02 for ruling 127 (branch `claude/per-user-codex-auth-difdnn`): the
> entrypoint row is gone, `keys` now covers personal backend keys, and the seed and
> backup directory lists name the per-person runtime homes.

## 1. The writer lock rule

The app holds `<dataRoot>/state/writer.lock` while it runs. A CLI that writes the store
or the database takes the **same lock** through `runWithDataRootWriterLock`; against a
live instance it prints `"<command> refused to run: it would be a SECOND writer on this
data root"` plus the holder and an in-app alternative, and exits 1. Read-only CLIs open
the database read-only and need no lock. `VIBERR_FORCE_DATA_ROOT_LOCK=1` forces a
takeover for both the app and the CLIs (only when you know the holder is dead).
`docker compose exec app npm run seed` is therefore **refused**; seed before the
container starts or stop it first.

## 2. Table

| Command | Lock | Does |
|---|---|---|
| `npm run dev` | app | Vite dev server on `PORT` (default 5173); boots the whole server, including watchers and background timers |
| `npm run build` / `npm run start` | app | production build / `react-router-serve ./build/server/index.js` |
| `npm run lint` | none | `oxlint` with the vendored anti-slop plugin; must exit 0 |
| `node scripts/anti-slop-manifest.mjs` | none | re-pins `tools/oxlint/anti-slop/` to `tools/oxlint/anti-slop.manifest.json` after the install-anti-slop skill refreshes it (the vendor-sync test holds the tree to that manifest on CI) |
| `npm run typecheck` | none | `react-router typegen` + `tsc` |
| `npm test` | none | vitest over `app/**/*.test.{ts,tsx}` |
| `npm run e2e [-- <playwright args>]` | n/a (Docker) | production-image Playwright run, see [testing.md](testing.md#4-end-to-end-suite-playwright) |
| `npm run seed [-- --reset]` | **writer** | product baseline: bootstrap admin, three agent profile templates, org KBs and skills, domain allowlist. No projects, tasks, notifications or run history |
| `npm run seed:demo [-- --reset]` | **writer** | test/dev fixture: five users, three projects, twelve tasks, notifications, one scope violation; refuses in the production image (no `test-support/`) |
| `npm run rescan [-- --force]` | **writer** | `rescanProjections` (hash short-circuit unless `--force`) and a report of untrusted files from the `diagnostics` table |
| `npm run store:check` | none, no DB | parses every `project.md`, `tasks/*/task.md`, `goals/*.md`; exit 1 when any file is untrusted |
| `npm run backup [-- --out <dir>] [--include-runtimes]` | none; with a `state/writer.lock` present at all it reads a copy of the DB taken under `state/tmp/`, never the live file (ruling 158) | `VACUUM INTO` snapshot + store tree copy (incl. `audit-exports/`, ruling 102) + manifest, whose first `contains` line says whether the projection was read from the file or from a copy |
| `npm run restore -- --from <artefact> [--force]` | **writer** | whole-root restore; occupied roots need `--force` and are moved aside, never deleted |
| `npm run restore -- --from <artefact> --file <store path>` | none | single canonical file restore; the displaced file is kept as `<file>.broken-<ts>` |
| `npm run keys -- status` | none; reads a copy of the DB whenever `state/writer.lock` is present (ruling 158), and says so | how many sealed secrets still open only under a retired `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` key, across every registered store: GitHub PATs, org MCP credentials, OAuth client secrets, the S3 key and, since ruling 127, `user_backend_credentials` ("Personal backend API keys"; a `login` row has no box and is skipped) |
| `npm run keys -- reseal [--dry-run]` | **writer** | re-seal them under the current key, personal backend keys included. A row it reports as unopenable is a person who must connect that backend again; the report names the backend, never the person's email |
| `node scripts/measure-routes.mjs [routeId…]` | none | client asset closure per route (raw + gzip bytes) from a prior `npm run build`; not in `package.json` |

## 3. Details that matter

### `npm run seed`

1. `ensureDataRootDirs`.
2. With `--reset`: `rm -rf projects/`, `agents/profiles/`, `runtimes/claude/`,
   `runtimes/codex/` (the RUN-LOG dirs only, never `runtimes/users/`, which since ruling
   127 holds every person's own vendor sign-in), then `DELETE
   FROM` `staged_outcomes, run_log_lines, agent_runs, notifications, provenance,
   diagnostics, scope_violations, user_prefs, task_events, task_projections,
   project_members, projects`; then `kb/`, `skills/` and the tables
   `org_knowledge_bases, org_mcp_servers, org_skills, google_domain_allowlist`.
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
   zero MCP servers and zero GitHub connections.

Survives `--reset`: every auth table, `github_connections`, `github_pats`,
`project_github_credentials`, `instance_settings`, `s3_audit_config`,
`model_availability`, `user_backend_credentials`, controller conversations,
`oauth_providers`, and on disk `runtimes/users/` (each person's `claude-home` and
`codex-home`), `runtimes/uv-*`, `audit-exports/`. *(Corrected 2026-09-02, ruling 127 —
the shared `runtimes/claude-home/` and `runtimes/codex-home/` this line named no longer
exist; a `--reset` that deleted `runtimes/users/` would sign every person on the instance
out of their own Claude and Codex accounts.)*
Does **not** survive (the README used to omit these): `kb/`, `skills/`,
admin-registered MCP server rows, `user_prefs`, `scope_violations`.

### `npm run seed:demo`

Upserts users `arda@viberr.dev` (org admin), `elif`, `murat`, `selin`, `deniz`
(members; deniz is a registered non-member), all with `viberr-dev-2828` (arda honours
`VIBERR_SEED_ADMIN_PASSWORD`); the Developer template is forced to `backends: [codex,
claude]` with model `gpt-5.6-terra`; projects `viberr-core` (`VIB`, governed 5-stage,
no PAT), `deploy-pipeline` (`DEP`), `billing-service` (`BIL`, custom 3-stage board);
ten full tasks in viberr-core plus `DEP-31` and `BIL-9`; ten notifications and Home pins
for Arda; one open scope violation on VIB-142; audit `seed.demo_dataset`; then
`seedOrgResources`. No run history, no PATs, no MCP servers.

### `npm run backup`

Writes `<--out ?? ./backups>/viberr-backup-<timestamp>/` (refuses an existing dir and
any path inside the data root): `projection.sqlite` via `VACUUM INTO` on whatever
`openDatabaseReadOnly` handed it (WAL folded in, no sidecars) — the live file, opened
read-only, ONLY on a root with no `state/writer.lock`; with a lock file there at all, a
copy of `projection.sqlite` and its `-wal` under `state/tmp/reader-<pid>/`, opened
read-write so SQLite recovers the WAL into it, and removed on close (ruling 158: no
process but the server opens a live root's database, and a reader cannot judge a
holder's liveness from another pid namespace, so presence is the whole question) —
`projects/`, `agents/`, `kb/`, `skills/`,
`audit-exports/` (`BACKED_UP_STORE_DIRS`; a directory that does not exist yet is
skipped) — and `runtimes/` only with `--include-runtimes`, which since ruling 127 means
every person's live vendor sign-in under `runtimes/users/`; treat that artefact as a
secret — skipping `*.tmp`; `MANIFEST.json` (`viberr-backup/1`, sha256, row counts for users, sessions,
accounts, PATs, audit, notifications, MCP servers) and `README.txt`. Always excluded:
`state/writer.lock`, the encryption key (back up `VIBERR_SECRET_ENCRYPTION_KEY`
separately or the sealed columns are unreadable, personal backend API keys included),
`*.tmp`.

### `npm run restore`

Refuses a foreign manifest. "Occupied" = non-empty `projects/agents/kb/skills` or any
`state/*` entry except the lock. With `--force` everything occupied is moved to
`<dataRoot>.replaced-<ts>/`, stale `-wal/-shm` are removed, the store and database are
copied back, audit `store.restored` is written inside the restored DB, and a `TRUNCATE`
checkpoint runs. `--file` restores exactly one canonical file under
`projects/ agents/ kb/ skills/` and leaves the database alone; a running app
re-projects it within ~250 ms, otherwise run `npm run rescan`.

### `npm run store:check` versus `npm run rescan`

`store:check` is the first diagnostic: read-only, no lock, no database, names the
file, code, message, line and excerpt of every file the app cannot trust (hard stop) or
that is degraded (error). `rescan` counts parser *throws*, which tolerant parsing never
produces, so it reports zero errors for a malformed file and instead appends the
untrusted-file report from the projected diagnostics.

### `.claude/launch.json`

Two dev launchers exist for Claude Code users: `viberr-dev` refuses to start while a
`viberr-app-1` container runs and hard-codes a machine-specific data root;
`viberr-dev-hermetic` uses `$PWD/data` on port 5174. Neither is part of CI.
