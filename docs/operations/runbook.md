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
Updated 2026-09-11 for ruling 174 (branch `option-d/pr1-permissions-and-kill`): the
restart bullet under "Agent runtimes" gains the settle sweep and how to read it. Updated
2026-09-11 for ruling 175 (branch `option-d/pr3-cost-cap-usage`): the spending-cap bullet
and the `max_budget` tag.
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
| `toolchain` | (last, ruling 182) `{ node, npm, git, python3, go, codexCli, claudeAgentSdk, codexSandbox: { ok, detail } }` — each version a string or `null` when that tool is not installed; `codexSandbox` is the once-per-process verdict of the CLI's own sandbox helper, with the sandbox's first stderr line as `detail` when it failed (`bwrap: No permissions to create a new namespace` under Docker's default seccomp profile). Never `degraded`: a host that runs no Codex is a correct host; a confined Codex run is refused with the remedy instead |

Status codes: the bare URL is a **liveness** probe and returns `200` even when degraded;
`?probe=readiness` (or `?probe=ready`) returns `503` with the same body while
`degraded[]` is non-empty; `503 { "ok": false, "status": "down" }` when the snapshot
itself threw (database unreachable). A zero `connectedUsers`, an unavailable browser and a
`null` disk reading are deliberately **not** degraded — and neither is a per-person backend
refusal. *(Confirmed 2026-09-06, ruling 146: this table was already right and the CODE had
drifted from it. `health-snapshot.server.ts` was pushing `credential:<backend>` and
`quota:<backend>` into `degraded`, so one member's expired key made `?probe=readiness` 503
for the whole instance and an orchestrator drained a deployment that was serving everyone
else. Those readings stay in the response body under `quota`, and Insights and Profile
render them per person.)* The compose healthchecks call the liveness
form, so a degraded instance never fails the Docker healthcheck.

The boot log (structured JSON on stdout) prints one `boot integrity check` line: data
root and dirs, applied migrations, projection counts, user count, build, disk, and a
separate WARN `projection schema drift` when the live `task_projections` CHECK lags the
shipped baseline (see [deployment.md](./deployment.md#re-baselining-the-projection-database)).
Grep for it after a deploy.

**One drift shape self-repairs and needs no remedy.** A baseline column ADDED after a
data root was created is applied at open by `ensureBaselineColumns`
(`app/server/db/sqlite.server.ts`), which `ALTER TABLE … ADD COLUMN`s each missing entry
of `BASELINE_COLUMNS` — on `agent_runs` `dispatched_by_name`, `dispatched_by_user_id`,
`credential_user_id`, `interrupted_reason` and `usage_final`, plus the ruling-121
controller columns — idempotently, logging `added a baseline column this data root
predated`, and runs a column's one-time backfill in the same step when the DEFAULT would
misdescribe the rows that predate it (`usage_final = 1` on the `finished` runs, so an
upgraded root keeps its Insights token history). So the re-baseline below is **not** the
remedy for those columns: without the backstop every `patchRun` naming them would fail
"no such column" and take every agent completion on that root with it. A failure to ALTER is warned, not fatal, and retried
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
- A run that ended in error: the Agent-logs footer names the classified cause for every
  run kind (ruling 130(a)): "refused this run: the account's usage window is spent" or
  "the account was rejected by the provider"; `continuity error` is now only an
  unclassified failure. The terminal line in the log console carries the kind on its
  tag (`quota`, `auth`, `overloaded`, `idle_timeout`, `max_turns`, `max_budget`,
  `session_missing`, `unavailable`), the typed facts (the window, the absolute reset, the API status and
  code) and the provider's own words (`The provider reported: …`). A 403
  `oauth_org_not_allowed` means the connected Claude account's organization does not allow
  it: the remedy is on that person's Profile → Agent accounts, never a retry. A 403
  `account_on_hold` is the same family: the account itself is on hold. `overloaded`
  (`api 529` or another 5xx on the result line, or an `overloaded` / `server_error`
  banner) is the provider's side: nothing about the account or the task is wrong, and the
  packet's options are a retry on the same backend or on the other one.

## A task waits on other work (ruling 131)

A task whose `blockedBy` list is non-empty is HELD, not stuck: its readiness is floored
at `blocked`, the card leads with a neutral "blocked by …" chip, the task page names
each entry with its live state, and `waiting` is `none` unless a packet or a
recommendation is open. Nothing is owed by anyone while it waits.

- **Who set it:** the task page's "Edit what it waits on" form, the controller's
  `update_task` / `create_task` / a goal link, or the operator's `set_dependencies`
  tool. Every write is a "Dependencies updated" note and a `task.dependencies.updated`
  audit row; a bad reference is refused by name (unknown, archived, self, a cycle).
- **Why the operator is quiet:** `create`, `transition` and `scheduled` triggers are
  refused at fire time (`refused: "blocked-by"`, no run, no cost) and the stranded
  backstop never nudges a held task. A run that does start (an @mention, a resolved
  packet, a manual run) is told the wait and told not to advance, dispatch delivery or
  open a packet about it. A scheduled `run-operator` occurrence retires as
  `skipped-held` with a note; a scheduled `run-agent` still fires.
- **How it releases:** when every entry is done (its task at the terminal stage; its
  goal link done or skipped) the release engine, which runs from the same task-write
  hooks that advance goal chains and from the goal runner's minute tick, clears the
  list, writes "Dependencies released", lifts a stored `blocked` to `ready`, clears
  `heldAtStage`, notifies the owner and supervisors (kind `dependency`, its own
  toggle) and re-invokes the operator with `dependencies-released`. A person emptying
  the list is the same release.
- **It never releases** when an entry is archived: the dependent gets one "Waiting on
  archived work" note, its watchers one notification, and it is left `waiting: human`
  until someone edits the list; the entry renders as "archived".
- **Converting an old hold** (the live JC-7 / JC-9 shapes): set the list on the task
  page first (setting a wait never touches a packet), then resolve any standing packet
  with its recommended option; that one reactive turn reads the wait and stops. The
  projection column `blocked_by_json` is additive: an existing data root takes
  `ALTER TABLE task_projections ADD COLUMN blocked_by_json TEXT NOT NULL DEFAULT '[]'`
  through the boot integrity path, never a re-baseline (the file also carries users,
  sessions and sealed PATs), and never a host-side write against the running
  container.

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
- **A branch collision packet whose PR is the task's own** (ruling 136, pass 34): the
  `resolve_remote_collision` option performs the push the person asked for when origin's
  copy is behind or absent, keeps the block only for a diverged remote, and every branch
  delete re-confirms a cached open PR against GitHub before refusing. "GitHub could not
  confirm whether PR #N is still open" means the check itself failed: nothing was deleted;
  resolve the packet again when GitHub answers.
- **"Delivery push refused: workflow scope"** (ruling 144, pass 34): the task changes a file
  under `.github/workflows/` and the project's token cannot push it (a classic token without
  the `workflow` scope, refused before the push; or GitHub's own refusal on any token). A
  `workflow` scope violation is open on the task and the credential card carries the
  advisory. Grant `workflow` to the token on GitHub, then use **Re-check** (Grant scope) on
  the project's GitHub view: the header now listing `workflow` resolves the violation, as
  does the next successful push of workflow files. Then deliver again. Nothing here asks a
  person to push.
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

  The per-person rows are in the database, and a live database is never opened by a
  second program, on either side of the container boundary: copy it first and query the
  copy (why: [Readers, and where they must run](#readers-and-where-they-must-run)).
  `node:sqlite` is the driver the app itself uses, so nothing has to be installed:

  ```bash
  # 1. copy the database and its WAL (never the -shm) to a scratch directory in the container
  docker compose exec -T app sh -c '
    mkdir -p /tmp/viberr-snap &&
    cp "$VIBERR_DATA_ROOT/state/projection.sqlite" /tmp/viberr-snap/ &&
    { [ ! -f "$VIBERR_DATA_ROOT/state/projection.sqlite-wal" ] || cp "$VIBERR_DATA_ROOT/state/projection.sqlite-wal" /tmp/viberr-snap/; }
  '
  # 2. open the COPY, read-write so SQLite folds the copied WAL in; it is your copy
  docker compose exec -T app node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("/tmp/viberr-snap/projection.sqlite");
    console.table(db.prepare(`
      SELECT u.email, c.backend, c.kind, c.method, c.verified_at, c.created_at
        FROM user_backend_credentials c JOIN users u ON u.id = c.user_id
       ORDER BY u.email, c.backend`).all());
    db.close();
  '
  # 3. throw the copy away
  docker compose exec -T app rm -rf /tmp/viberr-snap
  ```

  On bare metal (one host, one app process, a local `VIBERR_DATA_ROOT`) the rule is the
  same: copy `$VIBERR_DATA_ROOT/state/projection.sqlite` and `projection.sqlite-wal` to a
  scratch directory and run `sqlite3 /tmp/viberr-snap/projection.sqlite "SELECT …"` on
  the copy. Only with the app stopped is the root just files that any program may open
  in place.

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
- Quota and rate-limit state per backend is on `/insights` (org admin), and it says WHOSE
  account the refusal was (ruling 130(d)): a spent window or a rejected credential is one
  person's, not the instance's; the same person sees it on their Profile → Agent accounts
  card, and `/resources/health` names nobody. A quota-refused
  run opens a packet with a `retry_other_backend` option, offered only when the task owner
  has the other backend connected, and the switch sticks on the engagement
  (`pinnedBackend`). The Agent-logs "Retry on <other>" button passes the same test, so a
  task never offers in one surface what the other withholds.
- Spending cap (ruling 175): Org settings → the spending-cap row sets `maxRunSpendUsd`,
  what one Claude run may spend (none by default). A run that reaches it ends
  `run·error·max_budget`, pill `cut off · spending cap`, and its line and packet name the
  cap and the spend. It is a cut-off, not a failure: re-run to continue, or raise the cap.
  Codex runs are not capped (no budget option in its SDK).
- Concurrency: Org settings → runtime sets `maxConcurrentRuns` (0 = unlimited, ceiling
  64); excess runs wait in a `pending` queue that drains on every completion. Operator
  and controller turns have a lane of `max(1, ceil(cap / 4))` extra slots beyond the cap
  and are promoted first (ruling 152(b)), so `live` may exceed the cap by that many. Past
  its lane a coordination turn only borrows a cap slot no build is using: with a build
  parked, the next freed slot goes to the build.
- After a restart, orphaned `running|queued` rows are finalized as `interrupted` with
  `interrupted_reason: restart` (`interrupted_by` stays a person or null; the task page
  reads "interrupted by a restart", and Insights counts them as stopped, not as errors,
  with a never-started queued run out of the completion rate; ruling 158 addendum) and
  the operator is re-invoked once per affected task
  (capped 3 per 30 min); finished runs whose completion never posted are replayed. This
  is why `task.agent.replied` and `runtime.operator.plan_executed` audit rows are exempt
  from retention.
- **`bwrap: No permissions to create a new namespace`** (ruling 182) — in a Codex run's
  console at its first shell command, in the boot log as the WARN `codex sandbox
  unavailable on this host`, or as `toolchain.codexSandbox.ok: false` on
  `/resources/health` and `instance_health`. The Codex CLI confines every run below full
  access with bubblewrap, which needs an unprivileged user namespace, and Docker's default
  seccomp profile refuses `unshare(CLONE_NEWUSER)` to the non-root app user. Symptoms
  before the probe existed (F36-1): every Codex reviewer and supporting run recorded
  `request-changes` for "missing evidence" on correct deliveries while fully-autonomous
  deliverers (no sandbox) built fine. Since the probe, a confined Codex run is refused
  before any process starts, as an honest `run·unavailable` error run whose text names
  the sandbox's own words and the remedy: run the container with
  `security_opt: [seccomp=unconfined]` as `compose.yml` does, recreate it (`docker compose
  up -d`; a restart keeps the old profile), and confirm with `docker compose exec -T app
  unshare -U true`. A host kernel that disables unprivileged user namespaces
  (`kernel.unprivileged_userns_clone=0`, `user.max_user_namespaces=0`) fails the same way
  and is fixed on the host, not in compose. The other remedy the message names — grant the
  run full access — is a profile decision (a fully-autonomous deliverer with egress runs
  unsandboxed), not an operator one. See
  [deployment.md — Codex sandbox (seccomp)](deployment.md#codex-sandbox-seccomp).
- **A Codex run says `codex-linux-sandbox` is missing or `launch rejected … No such file or
  directory` mid-run** (F36-3) — the CLI's exec helpers live in ONE directory per
  `CODEX_HOME` and every new process of that home replaces it. Ruling 181 gives every run
  a private `CODEX_HOME` (`runtimes/users/<id>/codex-home/runs/<runId>/`, removed at
  settle), so this cannot recur on the current image; on an older one it means two Codex
  runs of one person overlapped. A `runs/` directory that survives with no live run is a
  crash's leftover and is replaced the next time that run id is prepared; deleting it by
  hand while the app is stopped is safe (the shared home's `auth.json` and `sessions/` are
  never inside it, only a copy and links).
- A settled run leaves no live process (ruling 174). Every agent child carries
  `VIBERR_RUN_ID=<runId>`, and when a run settles, or boot finalizes it as an orphan,
  Viberr SIGTERMs whatever still carries that id, waits 5 s and SIGKILLs the rest. The
  `info` line `reaped the processes a settled run left behind` gives the run ids and how
  many were terminated and killed. A non-zero `killed` means something ignored SIGTERM. A
  process the run started that is still alive after its row settled is a bug. To list a
  run's processes by hand inside the container, run
  `docker compose exec -T app sh -c 'grep -l "VIBERR_RUN_ID=<runId>" /proc/[0-9]*/environ'`.

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

The mirror is built in a `<mirror>.building` sidecar and renamed into place, and a mirror
counts as usable only once its `remote.origin.fetch` refspec is written — so a clone killed
mid-download (a container stop, an interrupted run) leaves nothing the cache will serve, and
the next clone rebuilds. A mirror whose `HEAD` does not resolve to a branch it holds is
skipped for the same reason: `git clone` warns and exits 0 on one, producing an empty tree.
Symptoms of an older half-built mirror, all at once: a `.repo-mirror/<owner>__<repo>.git`
with zero refs and orphaned `objects/pack/tmp_pack_*`, repeated `mirror could not be
refreshed — serving a possibly stale mirror` warnings, and agents reporting an EMPTY
repository — after which a delivering agent commits with no ancestry and the push is refused
as non-fast-forward. That refusal is NOT a stale remote branch: check the workspace's
`git log` before clearing anything on GitHub. The repair is to delete the mirror directory
and the affected task's `workspace/`; both re-clone on the next run.

## The single-writer lock and CLI refusals

`<dataRoot>/state/writer.lock` holds `{ pid, hostname, startedAt, bootId }`. A second app
process refuses to boot naming the holder; the holder re-verifies ownership every 20 s and
exits with a synchronous `FATAL` line if the file is deleted or replaced. Same host + dead
pid is reclaimed automatically; a different hostname is never probed and always refused
(compose pins `hostname: viberr`). `VIBERR_FORCE_DATA_ROOT_LOCK=1` forces a takeover.

| CLI | Lock | Where it runs on the Docker deployment |
|---|---|---|
| `npm run seed`, `seed:demo`, `rescan`, `restore` (whole root), `keys -- reseal` | **takes the writer lock**; against a running app prints `refused to run: it would be a SECOND writer on this data root` and exits 1 | from the host, before the container starts or after `docker compose down`; the lock refuses anything else |
| `npm run backup`, `keys -- status` | reader; no lock. A `state/writer.lock` of any age means they copy `projection.sqlite` and its `-wal` to `state/tmp/reader-<pid>/` and open the copy, never the live file (ruling 158); only a root with no lock file at all is just files, which they open in place, read-only | either side of the container boundary, since neither opens a live database. The in-container form (`docker compose exec -T app …`) stays the worked example for the backup, whose artefact must land outside `/data` and be copied out |
| `npm run store:check`, `restore --file` | no lock, no database | either side: they read and write the markdown tree only |

So `docker compose exec app npm run seed` is refused. Seed before the container starts, or
stop it first. Do **not** wipe `state/` while the app runs.

### Readers, and where they must run

The writer lock stops a second WRITER. Nothing stops a second READER, and a second reader
is the hazard: any process that opens `state/projection.sqlite` while the app holds it
(`sqlite3`, a desktop SQLite browser, `node -e` with `readOnly: true`) maps the WAL index
(`-shm`) the server has memory-mapped, and on the shipped Docker deployment
(`./docker-data` is a bind mount over VirtioFS) the open path's lock probe on that file
is unreliable, so a reader can truncate the index under the server. A stale shared
mapping in the guest is what a SIGBUS looks like. `readOnly` is no protection and neither
is being inside the container: pass 34 saw exit 135 one second after a host-side reader,
pass 35 one second after an in-container `readOnly: true` reader. The rule (ruling 158):

- **No process but the server opens a live root's database. Copy first, never a second
  connection, on either side of the container boundary.** Copy `projection.sqlite` and
  `projection.sqlite-wal` (never the `-shm`: that IS the shared index, and a copy
  rebuilds its own) to a scratch directory, open the copy, throw it away; the worked
  example is under [Agent runtimes](#agent-runtimes). The read-only CLIs do exactly this
  on their own: `npm run backup` and `npm run keys -- status` look for
  `state/writer.lock`, and if one is there at all they copy both files to
  `state/tmp/reader-<pid>/`, open the copy and remove it when they close
  (`openDatabaseReadOnly` in `app/server/db/sqlite.server.ts`); only a root carrying no
  lock file is just files they open in place, read-only. They deliberately do NOT reuse
  the boot's `stale` verdict: liveness is probed inside ONE pid namespace and
  `compose.yml` pins `hostname: viberr`, so a live holder in a second container from that
  file reads as a dead pid on the same host, and believing it would open the live
  database. A needless copy costs disk; that mistake costs the server. `keys -- status`
  says which it did on stdout; the backup manifest records it. The backup is still the
  two-step form under [Backup / restore](#backup--restore), because its artefact may not
  land under `/data` and anywhere else in the container is gone with it.
- **Ask the server before copying anything.** `/resources/health` answers the health,
  lock-holder and connected-backend questions in-process, and the controller reads
  through the server's own handle: its `viberr_ops` tools (`instance_health` for the
  same snapshot, `read_run_log` for a run's console, `read_store_doc` for a knowledge-base
  or skill file) and its `viberr_controller` tools (`inspect_audit_log`, `get_task` and the
  rest) need no copy at all, and are the reader to reach for first.
- **`npm run store:check` needs no database** (it parses the markdown tree) and may run
  from either side; so may `restore --file`, which writes one markdown file and touches
  no SQLite.
- **Once the app is down** the root is just files, and any program may open it in place.

*(Rewritten 2026-09-06, pass 35 — F35-9, ruling 158. Added on 2026-09-04 (pass 34, D34-1)
after a host-side `sqlite3 -readonly` polling over VirtioFS preceded the container's SIGBUS
at 09:12:46Z, this section called the same read INSIDE the container with `readOnly: true`
the safe form, and `openDatabaseReadOnly` used it for the read-only CLIs. On 2026-09-06 at
18:40:29Z the container died with exit 135 one second after exactly that in-container
reader, and boot recovery interrupted 23 runs and re-fired 23 operator turns. The side of
the boundary was never the point; the second mapping was. This section, the table above
and `deployment.md`'s backup recipes now say copy first, and
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
INTO` plus the store tree — `projects/`, `agents/`, `kb/`, `skills/` and
`audit-exports/` — and a manifest) **without** taking the lock, so it works on a live
instance, and without opening the live database: with a `state/writer.lock` present at
all it copies `projection.sqlite` and its `-wal` to `state/tmp/reader-<pid>/`, runs the
`VACUUM INTO` on the copy and removes it, so the artefact stays one self-contained file
and the manifest's first `contains` line says it was read from a copy ([Readers, and
where they must run](#readers-and-where-they-must-run)). On the Docker deployment run it
INSIDE the container with an explicit `--out`: the default `./backups` is `/app/backups`
in the container and vanishes with it, and `createBackup` refuses a destination under the
data root it is backing up, so `/data/…` is not an option either. Write it to a
container-local directory and copy it out in the same breath:

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
