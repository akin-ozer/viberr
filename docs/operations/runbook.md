# Runbook — operating Viberr

Quick reference for the common operational tasks and failure modes. All commands run
from the repo root. On the Docker deployment the read-only ones run INSIDE the container
(`docker compose exec -T app …`), never from the host against the live root; the reason
is under [Readers, and where they must run](#readers-and-where-they-must-run). The
writing CLIs refuse against a running app, see below.
Rewritten 2026-09-01 against `main` @ `68b5480` and re-verified 2026-09-02 against
`pass32/implementation` @ `478bed0`; the earlier text's stale claims are
listed in [`../validation/2026-09-01-doc-validation.md`](../validation/2026-09-01-doc-validation.md).
Every environment variable named here is documented in
[`configuration.md`](configuration.md).
Updated 2026-09-02 for ruling 127 (branch `claude/per-user-codex-auth-difdnn`): the health
`backends` row, the whole "Agent runtimes" section, the session-home retention row and the
backup note were rewritten for per-person agent accounts.

## First diagnostic: is every canonical file trustworthy?

```bash
npm run store:check
```

Read-only, needs no lock and no database, and runs against a live instance. It parses
every `project.md`, `tasks/*/task.md` and `goals/*.md`, and for anything the app cannot
trust it names the file, the parse error and the offending line with an excerpt; it exits
1 when any file is untrusted and also lists "degraded" files (error-severity findings). A
file in the untrusted state is forced to `blocked` and **the app refuses to write to it**
(a write would replace your content with defaults), so this is the first thing to run
when a task looks wrong. Recover one file from a backup with
`npm run restore -- --from <artefact> --file <store path>`; the broken bytes are kept
beside it as `<file>.broken-<ts>`.

`npm run rescan` counts parser throws, which tolerant parsing never produces, so it
reports zero errors for a malformed file; it appends the untrusted-file report from the
projected diagnostics instead. Use `store:check` for the question "is the file OK".

## Health & liveness

`GET /resources/health` is unauthenticated by design (aggregate counts only, never data).
Key order is part of the contract:

| Key | Meaning |
|---|---|
| `ok` | `false` only when SQLite is unreachable |
| `status` | `ok` \| `degraded` (`down` only in the 503 body below) |
| `degraded[]` | any of `watcher`, `kbWatcher`, `lock`, `disk` |
| `projections` | `{ projects, tasks }` row counts |
| `watcher`, `kbWatcher` | store and knowledge-base watchers alive; a watcher error clears the handle, so `false` is a real dead watcher, not "never started" |
| `lock` | `{ pid, hostname, startedAt }` of the single-writer holder, `null` if none |
| `backends` | `{ claude: { connectedUsers }, codex: { connectedUsers } }` → how many PEOPLE have connected each backend (ruling 127), recounted on every call. `0` is a normal reading, not a fault, and never degrades health; it is not a validity check, and it does not answer "can this task run", which is a fact about the task owner. *(Corrected 2026-09-02 — this was `real` \| `unavailable` from an env probe that no longer exists.)* |
| `browser` | `{ status: "ready" }` or `{ status: "unavailable", reason }` for the governed browser |
| `disk` | `{ freeBytes, totalBytes, usedPercent, status: ok\|low\|critical, lowThresholdBytes, criticalThresholdBytes }` or `null` when neither source could measure the root (not degraded); 5 s cache. The reading comes from POSIX `df -kP` (fragment-size aware), with `statfs(2)` only as the fallback — Node exposes `bsize` alone, and on Docker Desktop's virtiofs `f_bsize` ≠ `f_frsize`, which reported a near-full 229 GB volume as 62 TB with 1 TB free (F32-1, pass 32) |
| `maintenance` | `{ intervalMs, diskCheckIntervalMs, lastPassAt, lastPassReason: boot\|interval\|disk-pressure, lastFreedBytes, scheduled }` |
| `build` | `{ version, revision, revisionSource: env\|git\|null, builtAt }`; `revision` is `null` in the stock image |

Status codes: the bare URL is a **liveness** probe and returns `200` even when degraded;
`?probe=readiness` (or `?probe=ready`) returns `503` with the same body while
`degraded[]` is non-empty; `503 { "ok": false, "status": "down" }` when the snapshot
itself threw (database unreachable). A zero `connectedUsers`, an unavailable browser and a
`null` disk reading are deliberately **not** degraded. The compose healthchecks call the liveness
form, so a degraded instance never fails the Docker healthcheck.

The boot log (structured JSON on stdout) prints one `boot integrity check` line: data
root and dirs, applied migrations, projection counts, user count, build, disk, and a
separate WARN `projection schema drift` when the live `task_projections` CHECK lags the
shipped baseline (see [deployment.md](./deployment.md#re-baselining-the-projection-database)).
Grep for it after a deploy.

**One drift shape self-repairs and needs no remedy.** A baseline column ADDED after a
data root was created is applied at open by `ensureRunRowColumns`
(`app/server/db/sqlite.server.ts`), which `ALTER TABLE agent_runs ADD COLUMN`s each
missing entry of `RUN_ROW_COLUMNS` — today `dispatched_by_name` and
`dispatched_by_user_id` — idempotently, logging `added a baseline column this data root
predated`. So the re-baseline below is **not** the remedy for those two: without the
backstop every `patchRun` naming them would fail "no such column" and take every agent
completion on that root with it. A failure to ALTER is warned, not fatal, and retried
next boot. The re-baseline remains the remedy for the shape that cannot be patched
additively — a CHECK constraint that refuses a value the running build now produces.
*(Added 2026-09-02, pass 32.)*

## Files are canonical; the DB holds projections plus primary app data

Authoritative business state is the markdown under `$VIBERR_DATA_ROOT/projects/` (plus
`agents/profiles/`, `kb/`, `skills/`). SQLite holds *projections* derived from those
files, which can always be rebuilt, **and** primary app data that exists nowhere else:
users and better-auth credentials, sessions, sealed PATs and MCP credentials, audit,
notifications, prefs, instance settings, org resource rows, run history, controller
conversations and the provenance ledger. Back the database up
([deployment.md](./deployment.md#persistence-backup--restore)); only the projection tables
are a cache.

## Rescan vs. rebuild

- **Re-scan** (Home store strip, org admin, 10 s cooldown, or per project on the board for
  admin/maintainer; `npm run rescan` takes the single-writer lock and REFUSES against a
  live instance): incremental — re-reads changed files (content-hash short-circuit) and
  updates projections. Use after editing task/project/goal files directly, or if the
  watcher missed a change.
- **Rebuild projections** (Home, org admin, confirm dialog, 30 s cooldown): drops
  `projects`, `project_members`, `task_projections`, `task_events` and `diagnostics` and
  rebuilds them from files in one transaction. Use if projections look inconsistent,
  after restoring only `projects/` without the DB, or after a schema change to a
  projection table. Users/sessions/PATs/audit/notifications are **not** touched.
- **Boot** runs the *rescan*, never the rebuild, before the first request, so
  out-of-band edits made while the app was down converge.

The file watcher (chokidar, 250 ms trailing debounce per path, dotfiles and `*.tmp`
ignored, nothing below a task directory except `task.md`) drives incremental rebuilds in
both dev and prod. A watcher error clears the handle and health reports `watcher: false`;
transient errors re-arm after 2 s.

## Diagnostics (a task looks wrong / stuck)

Malformed or inconsistent task files never crash the app — they produce diagnostics and
a readiness downgrade (tolerant parsing):

- Invalid frontmatter or an unparseable file → the task's DiagnosticsPanel lists
  findings, the board pill and readiness reflect the severity (`input_required` /
  `inconsistency_risk_detected` / `blocked`), and an entry appears under Activity →
  Audit logs.
- Fix the file on disk → the watcher re-projects within ~1 s and the diagnostic clears
  (or, with the app stopped, `npm run rescan`).
- Unknown workflow stage → warning + readiness floor until the stage is added in project
  settings or the task is moved. Duplicate `## Goal` / `## Packet` / `## Timeline`
  sections → warning, first occurrence wins.
- A row that silently stops updating almost always means a schema or CHECK problem:
  `rebuildPath` swallows the throw into a provenance `error` row and the log line
  `projection rebuild failed`. Read the boot integrity WARN.
- A run that ended with `continuity error` in the runs panel is any error run; open the
  log console for the provider's own words (`The provider reported: …`) and the failure
  kind on the terminal tag (`quota`, `auth`, `idle_timeout`, `max_turns`,
  `session_missing`, `unavailable`).

## GitHub / PAT issues

- Per-project credential health and scope violations show on the GitHub view and the
  task. Diagnostics distinguish `insufficient_scope`, `expired`, `revoked`,
  `repo_not_found`, `org_approval_missing`, `network_error`.
- **An empty repository needs nothing from you** (ruling 128, pass 34). Viberr creates
  the default branch itself before a task's first branch (an initial commit through the
  Contents API, or the configured default at the first commit of a task branch GitHub
  made the default), disclosed on the task timeline and audited as
  `github.repo.bootstrapped`. "Delivery could not run … Viberr could not create it"
  names the one case that needs a person: the credential cannot write the repository
  (a `repo` scope violation opens) or GitHub refused the create; fix that, then deliver
  again. A delivery never pushes a task branch as the repository's first ref.
- Accept-completion merges the review PR; a missing `pull_request:write` scope surfaces
  as an open scope violation with a Grant-scope action (re-validate the PAT, 60 s
  cooldown) rather than a silent failure. Write permission is proven read-only from the
  repository's `permissions.push`; the empty-payload write probe runs only with
  `VIBERR_GITHUB_WRITE_PROBE=1`.
- PR/branch state refreshes on a background poller: once at boot, then every 5 minutes
  over every project with branched tasks. It emits divergence events, notifications,
  recommendation withdrawals and merge-pending nudges with no human in the loop, and
  raises a notification after 3 consecutive failures. The **Update status** button on
  the GitHub view forces an immediate reconcile; the page shows how old the cached state
  is ("never synced" is neutral, ruling 46).
- Secret key rotation: set `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` to the retired key(s),
  `npm run keys -- status` (read-only, live instance) shows how many sealed secrets still
  open only under a retired key, `npm run keys -- reseal` (writer lock) moves them, then
  drop the previous key.

## Agent runtimes

- **Whose account a run uses is the first question (ruling 127).** There is no
  instance-level "the backend is configured". Every run bills ONE person, persisted on
  the run row as `agent_runs.credential_user_id`: the **task owner** for anything on a
  task (operator, specialist, resume, scheduled, boot recovery, retry) and the **asker**
  for a controller turn. Whether that person can run a backend is re-derived on every
  check (`userBackendHealth` in `app/server/runtimes/backend-credentials.server.ts`), so a
  fresh sign-in counts without a restart and a wiped volume reads as "sign in again"
  immediately.

- **A refused run names its principal and starts no process.** Three refusals, and the
  sentence a human sees comes from one place (`principalRefusalMessage` in
  `run-principal.server.ts`), so the error run, the packet body and the UI agree:

  | Refusal | What it means | Remedy |
  |---|---|---|
  | unowned | the task has no owner, so no account can pay for the run | take the task (Assign me) and run again |
  | owner-missing | the owner's user row is gone or disabled | assign a new owner |
  | no-credential | the owner (or the asker) has not connected that backend, or their sign-in file is missing | that person connects it on their own Profile → Agent accounts |

  Each writes an honest `run·unavailable` error run and the usual blocked recovery packet
  through the normal completion pipeline. No agent process is started, so there is nothing
  to interrupt and no partial work to reconcile.

- **A missing sign-in file after a volume wipe** is the common Docker case. A hosted
  sign-in lives only at
  `$VIBERR_DATA_ROOT/runtimes/users/<userId>/claude-home/.credentials.json` or
  `.../codex-home/auth.json`; deleting or recreating that directory removes it while the
  credential ROW stays in `user_backend_credentials` (a wipe of the WHOLE `./docker-data`
  volume takes the database with it, and then the row is gone too). Health for that person
  then reads "Your <Backend> sign-in
  file is missing from this server (the runtime volume was wiped). Sign in again on your
  Profile → Agent accounts." Do not copy a file in by hand: the vendor binary owns that
  file, and Viberr never reads or writes its contents. The person signs in again. (On
  macOS only, an existing home with no credential file is honoured as a Keychain login and
  reported with the weaker `presence` verification rather than hidden.)

- **Check who is connected** without touching a credential:

  ```bash
  curl -s localhost:${PORT:-3000}/resources/health | jq .backends
  # {"claude":{"connectedUsers":3},"codex":{"connectedUsers":1}}
  ```

  The per-person rows are in the database, and on the Docker deployment a live database
  is read INSIDE the container and read-only, never from the host (why: [Readers, and
  where they must run](#readers-and-where-they-must-run)). `node:sqlite` is the driver
  the app itself uses, so nothing has to be installed:

  ```bash
  docker compose exec -T app node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.env.VIBERR_DATA_ROOT + "/state/projection.sqlite", { readOnly: true });
    console.table(db.prepare(`
      SELECT u.email, c.backend, c.kind, c.method, c.verified_at, c.created_at
        FROM user_backend_credentials c JOIN users u ON u.id = c.user_id
       ORDER BY u.email, c.backend`).all());
    db.close();
  '
  ```

  On bare metal (one host, one app process, a local `VIBERR_DATA_ROOT`) the same query
  may run from the host, still read-only:
  `sqlite3 "file:$VIBERR_DATA_ROOT/state/projection.sqlite?mode=ro" "SELECT …"`.

  One row per `(user, backend)`; connecting a new method REPLACES the previous row.
  `kind = 'login'` carries no secret at all (the vendor binary holds it), `api_key` /
  `access_token` carry a sealed `secret_box` you must never select into a terminal. A row
  is necessary but not sufficient for a `login`: the file above must also exist.

- **Removing an org account retires its agent accounts** (ruling 127): the vendor logout
  runs, the sign-in file is deleted from that person's runtime home, and the credential
  rows go, before the `users` row cascades. The audit detail on `org.user.removed` lists
  `backendsRetired`. Nothing else on any path removes that file, and a removed person can
  no longer reach Disconnect, so a leftover would be a live Claude.ai / ChatGPT credential
  on this server that no row accounts for and every runtime backup carries forward. Their
  transcripts stay (they are the run record) and age out through the retention sweep.
- Raw run logs are append-only under `$VIBERR_DATA_ROOT/runtimes/<backend>/<runId>.jsonl`;
  the log panel projects them. Provider session transcripts live in the principal's own
  home. Interrupt is admin/maintainer-gated and audited.
- Quota and rate-limit state per backend is on `/insights` (org admin); a quota-refused
  run opens a packet with a `retry_other_backend` option, offered only when the task owner
  has the other backend connected, and the switch sticks on the engagement
  (`pinnedBackend`). The Agent-logs "Retry on <other>" button passes the same test, so a
  task never offers in one surface what the other withholds.
- Concurrency: Org settings → runtime sets `maxConcurrentRuns` (0 = unlimited, ceiling
  64); excess runs wait in a `pending` queue that drains on every completion.
- After a restart, orphaned `running|queued` rows are finalized as `error`
  (`interruptedBy: restart`) and the operator is re-invoked once per affected task
  (capped 3 per 30 min); finished runs whose completion never posted are replayed. This
  is why `task.agent.replied` and `runtime.operator.plan_executed` audit rows are exempt
  from retention.

*(Rewritten 2026-09-02 for ruling 127. The old section listed "seven credential paths"
across `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `VIBERR_CLAUDE_USE_CLI_AUTH` and
`CODEX_ACCESS_TOKEN` / `CODEX_API_KEY` / `OPENAI_API_KEY` / `VIBERR_CODEX_USE_CLI_AUTH`,
and told an operator to `docker compose cp ~/.codex/auth.json` into a shared
`/data/runtimes/codex-home`. None of those variables, and neither shared home, exists.)*

## Auth / access

- Sessions live in better-auth's own `session` table (singular, better-auth's schema).
  **Expiry is 30-day rolling**, slid at most once a day on an active session; the
  refreshed cookie is forwarded by the root loader. **Nothing prunes expired rows**; an
  expired row is simply never honoured. Rows are deleted only by an explicit act: sign-out
  (`routes/logout.tsx`), a self-serve password change (deletes every OTHER session), the
  auth guard (deletes the session of a disabled or deleted user on sight), and admin
  revocation (`revokeUserSessions` on disable and on admin password reset; deleting the
  user cascades). To prune by hand, stop the app and delete by `expiresAt`, checking the
  stored textual form first (`SELECT expiresAt FROM session LIMIT 1`).
- Locked out / forgotten password: an admin resets it in Org settings → Users & access
  (a one-time temp password that forces a reset at next sign-in). The bootstrap admin
  comes from `VIBERR_SEED_ADMIN_*` on first boot of an empty users table (random
  password logged once as `VIBERR BOOTSTRAP ADMIN` when unset).
- OAuth sign-in only succeeds for a whitelisted account (a non-disabled user row) or an
  allow-listed Google domain; there is no self-signup. Implicit account linking does not
  trust unverified provider emails (F28-A1).
- Sign-in throttling keys on `email|ip`; behind a proxy set `VIBERR_TRUST_PROXY` or every
  client is `local`.

## Retention & growth

`runMaintenancePass` runs at **boot**, every **6 hours** (`VIBERR_MAINTENANCE_INTERVAL_MS`)
and on **disk pressure** (checked every 5 minutes, extra pass at most every 30 minutes;
thresholds 2 GiB low / 512 MiB critical, `VIBERR_DISK_LOW_FREE_MB` /
`VIBERR_DISK_CRITICAL_FREE_MB`). Each pass logs `store maintenance pass {reason, …}` and
is reported on `/resources/health` under `maintenance`.

| What | Policy | Configurable |
|---|---|---|
| `run_log_lines` | deleted after **30 days** | no |
| `audit_events` | deleted after **90 days**, **exported first** (below), except the two recovery-marker actions | no |
| `notifications` | trimmed to the **newest 500 per user** | no |
| run transcripts `runtimes/<backend>/*.jsonl` | mtime older than **30 days** | `VIBERR_TRANSCRIPT_RETENTION_DAYS` (0 = forever) |
| per-person provider session homes `runtimes/users/*/claude-home/projects/**/*.jsonl` and `runtimes/users/*/codex-home/sessions/**/*.jsonl` | mtime older than **30 days**. `*.jsonl` ONLY: `auth.json`, `.credentials.json` and `.claude.json` are the vendor-held sign-ins and are never touched, so retention can never sign anybody out (ruling 127) | `VIBERR_SESSION_HOME_RETENTION_DAYS` (0 = forever) |
| task `workspace/` directories | removed for tasks in the terminal stage, only when no run is queued or running | no |

**Two audit actions are exempt from the 90-day delete** because boot recovery uses them
as idempotency keys: `task.agent.replied` (read by `recoverUnreactedAgentRuns`) and
`runtime.operator.plan_executed` (read by `recoverStrandedOperatorPlans`). Pruning one
would make the next boot redo the work. They are listed explicitly in
`IDEMPOTENCY_AUDIT_ACTIONS` (`app/server/db/retention.server.ts`), never pattern-matched.

**Audit is exported before it is purged.** Every expiring row is appended as one JSON
line to `<dataRoot>/audit-exports/audit-events-<YYYY-MM-DD>.jsonl` before the delete; if
the export fails the delete is skipped for that pass (ruling 102). On demand, Org
settings → Audit export downloads CSV/JSON (cap 100 000 rows) or pushes to a configured
S3 target; the same card browses the newest 150 org-scoped rows. Task-scoped history also
lives in `task.md` indefinitely.

**Those export files are deliberately unbounded and belong in your backups.** They are
ruling 102's durable long-term record — the whole point is that they outlive the 90-day
window the database enforces — so nothing rotates, ages out or size-caps them; the only
supported way to shrink the directory is to move files off the box yourself, having
decided you no longer need that history. `audit-exports/` is created at boot with the
rest of the data root (`DATA_ROOT_SUBDIRS`) and is one of `npm run backup`'s
`BACKED_UP_STORE_DIRS`, so a standard backup carries it. *(Corrected 2026-09-02, pass 32
— C01-A3 / A00-6: the directory used to appear only on a root that had already purged,
and `npm run backup` silently dropped it.)*

**Tables with no retention:** `provenance` (append-only observation ledger, the one that
grows fastest; prune by hand with the app stopped: `DELETE FROM provenance WHERE
observed_at < …; VACUUM;`), better-auth `session`, `agent_runs`, `goal_projections`,
`controller_messages`, `staged_outcomes` (24 h TTL in code, rows kept), `scope_violations`,
`model_availability`. `diagnostics` is rebuilt, not pruned.

Canonical Markdown files are never touched by retention.

### Task workspaces (disk, not SQLite)

Every task that has run an agent holds git clones under
`projects/<slug>/tasks/<KEY>/workspace/` (the deliverer's `<repo>/`, one
`support/<profileId>/<repo>/` per supporting run), created from the project's bare mirror
in `projects/<slug>/.repo-mirror/`. The clone is a cache, never canonical: the record is
`task.md` and delivered work is on the remote branch. Reclaim happens at boot (after run
recovery, skipped with a log line while any run is in flight) and on every maintenance
pass, for tasks in their project's terminal stage, logging `reclaimed finished task
workspaces` with count and MB. Removing a finished task's `workspace/` by hand is safe;
removing one for a task in progress forces a re-clone and interrupts a running agent.

## The single-writer lock and CLI refusals

`<dataRoot>/state/writer.lock` holds `{ pid, hostname, startedAt, bootId }`. A second app
process refuses to boot naming the holder; the holder re-verifies ownership every 20 s and
exits with a synchronous `FATAL` line if the file is deleted or replaced. Same host + dead
pid is reclaimed automatically; a different hostname is never probed and always refused
(compose pins `hostname: viberr`). `VIBERR_FORCE_DATA_ROOT_LOCK=1` forces a takeover.

| CLI | Lock | Where it runs on the Docker deployment |
|---|---|---|
| `npm run seed`, `seed:demo`, `rescan`, `restore` (whole root), `keys -- reseal` | **takes the writer lock**; against a running app prints `refused to run: it would be a SECOND writer on this data root` and exits 1 | from the host, before the container starts or after `docker compose down`; the lock refuses anything else |
| `npm run backup`, `keys -- status` | reader; no lock | INSIDE the container while it runs (`docker compose exec -T app …`); from the host only once it is down. Both open the database, and a host-side reader of a live root is the hazard below |
| `npm run store:check`, `restore --file` | no lock, no database | either side: they read and write the markdown tree only |

So `docker compose exec app npm run seed` is refused. Seed before the container starts, or
stop it first. Do **not** wipe `state/` while the app runs.

### Readers, and where they must run

The writer lock stops a second WRITER. Nothing stops a second READER, and on the shipped
Docker deployment a reader on the wrong side of the container boundary is the hazard:
`./docker-data` is a bind mount, so a process on the HOST that opens
`state/projection.sqlite` (`sqlite3`, a host-side `npm run backup`, a desktop SQLite
browser) maps the WAL index (`-shm`) of a file the GUEST process is writing, across
VirtioFS. A stale shared mapping in the guest is what a SIGBUS looks like. The rules:

- **Every read of a live database runs inside the container, and always read-only.**
  The form is `docker compose exec -T app node -e '…'` opening the file with
  `new DatabaseSync(path, { readOnly: true })`, the option `openDatabaseReadOnly` in
  `app/server/db/sqlite.server.ts` uses for the read-only CLIs; the worked example is
  under [Agent runtimes](#agent-runtimes). The same goes for `npm run keys -- status`
  (`docker compose exec -T app npm run keys -- status`) and for `npm run backup`, which
  open the database themselves; the backup is the two-step form under
  [Backup / restore](#backup--restore), because its artefact may not land under `/data`
  and anywhere else in the container is gone with it.
- **`npm run store:check` needs no database** (it parses the markdown tree) and may run
  from either side; so may `restore --file`, which writes one markdown file and touches
  no SQLite.
- **On bare metal** (one host, one app process, a local `VIBERR_DATA_ROOT`) a host reader
  shares the kernel with the writer and is fine, and must still open read-only:
  `sqlite3 "file:$VIBERR_DATA_ROOT/state/projection.sqlite?mode=ro"`.
- **Once the container is down** the root is just files, and the host may read it.

*(Added 2026-09-04, pass 34 — D34-1. This page told an operator to run `sqlite3` against
`$VIBERR_DATA_ROOT/state/projection.sqlite` from the host, and the table above said
nothing about which side of the boundary a reader runs on. Done exactly that way during
the pass, host-side `sqlite3 -readonly` polling over VirtioFS every few seconds from
09:01Z preceded the container's SIGBUS at 09:12:46Z, exit 135; compose restarted it and
boot recovery finalized the two live runs as `interruptedBy: restart`. `-readonly` was no
protection: the shared mapping is the problem, not the write. The read block, the table
and `deployment.md`'s backup recipes now say where a reader runs, and
`app/shared/docs/runbook-db-read.test.ts` keeps them saying it.)*

## Self-heal and disk

- At boot, before the first handle opens, `PRAGMA quick_check` runs on the projection DB.
  On a corruption verdict (`SQLITE_CORRUPT`, `NOTADB`, "malformed" — never on
  `EACCES`/`EMFILE`) the non-rebuildable tables are streamed into a fresh file, the corrupt
  file and its `-wal` are moved to `state/projection.sqlite.corrupt-<ts>`, and boot logs a
  WARN with `movedTo` / `salvaged` / `skipped`. Projection tables are rebuilt by the boot
  rescan. Delete the `.corrupt-*` files once you have a backup.
- Low disk never refuses boot; it is logged, reported on health as `disk.status`, and
  triggers an extra maintenance pass. `ENOSPC` on a canonical write becomes a named "no
  space left on the data root" error; `ESTALE`/`EIO` become a 503.

## Backup / restore

`npm run backup [-- --out <dir>]` writes a consistent point-in-time artefact (`VACUUM
INTO` from a read-only connection plus the store tree — `projects/`, `agents/`, `kb/`,
`skills/` and `audit-exports/` — and a manifest) **without** taking the lock, so it works
on a live instance. On the Docker deployment "on a live instance" means INSIDE the
container ([Readers, and where they must run](#readers-and-where-they-must-run)), with an
explicit `--out`: the default `./backups` is `/app/backups` in the container and vanishes
with it, and `createBackup` refuses a destination under the data root it is backing up, so
`/data/…` is not an option either. Write it to a container-local directory and copy it out
in the same breath:

```bash
docker compose exec -T app npm run backup -- --out /tmp/viberr-backups
docker compose cp app:/tmp/viberr-backups/. ./backups/    # now the artefact is on the host
```

`runtimes/` is excluded unless you pass `--include-runtimes`, and
since ruling 127 that directory holds every person's live vendor sign-in
(`runtimes/users/<userId>/…`), so an artefact taken with it is a secret. `npm run restore -- --from <artefact>` takes the
lock, needs `--force` on an occupied root and moves displaced data to
`<dataRoot>.replaced-<ts>/`; `--file <store path>` restores one canonical file without
touching the database. Back up `VIBERR_SECRET_ENCRYPTION_KEY` separately: without it every
sealed PAT, MCP credential and **personal backend API key** (`user_backend_credentials`,
ruling 127) in the artefact is unreadable, and restoring the database without the key
leaves every person who pasted a key having to connect that backend again. Rotating is
safe: `npm run keys -- reseal` covers that store like the others. A raw copy of the live
`projection.sqlite` misses committed rows still in the WAL; use the CLI. Details and the
ghost-membership warning for a `projects/`-only restore:
[deployment.md](./deployment.md#persistence-backup--restore).
