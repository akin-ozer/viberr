# Runbook — operating Viberr

> Quick reference for the common operational tasks and failure modes: health and probes,
> the boot log, diagnostics, agent runtimes, retention, the writer lock, self-heal and
> backup. Every environment variable named here is documented in
> [`configuration.md`](configuration.md). Source of truth: `app/routes/resources.health.ts`,
> `app/server/ops/health-snapshot.server.ts`, `app/server/controller/controller-ops-mcp.server.ts`,
> `app/server/boot.server.ts`, `app/server/db/` (`sqlite.server.ts`, `self-heal.server.ts`,
> `retention.server.ts`, `backup.server.ts`, `data-root-lock.server.ts`, `cli-lock.server.ts`),
> `app/server/ops/`, `app/server/runtimes/`, `app/server/logging/`, `scripts/`.
> Verified against `main` @ `7d9fbf72` (2026-09-23).

All commands run from the repo root. On the Docker deployment the read-only ones run
INSIDE the container (`docker compose exec -T app …`), never from the host against the
live root; the reason is under [Readers, and where they must run](#readers-and-where-they-must-run).
The writing CLIs refuse against a running app, see below.

## First diagnostic: is every canonical file trustworthy?

```bash
npm run store:check
```

Read-only, needs no lock and no database, and runs against a live instance. It parses
every `project.md`, `tasks/*/task.md` and `epics/*.md`, and for anything the app cannot
trust it names the file, the parse error and the offending line with an excerpt; it exits
1 when any file is untrusted and also lists "degraded" files (parsed with error-severity
findings: readable, integrity in doubt). A file in the untrusted state is forced to
`blocked` and **the app refuses to write to it** (a write would replace your content with
defaults), so this is the first thing to run when a task looks wrong. Recover one file
from a backup with `npm run restore -- --from <artefact> --file <store path>`; the broken
bytes are kept beside it as `<file>.broken-<ts>`.

`npm run rescan` counts parser throws, which tolerant parsing never produces, so it
reports zero errors for a malformed file; it appends the untrusted-file report from the
projected diagnostics instead. Use `store:check` for the question "is the file OK".

## Health & liveness

`GET /resources/health` is unauthenticated by design (aggregate counts only, never data).
The route spreads `healthSnapshot()` after `ok`, and key order is part of the contract
(new fields go at the end):

| Key | Meaning |
|---|---|
| `ok` | `false` only when SQLite is unreachable |
| `status` | `ok` \| `degraded` (`down` only in the 503 body below) |
| `degraded[]` | any of `watcher`, `kbWatcher`, `lock`, `disk`, `projections`, `agentIsolation` |
| `projections` | `{ projects, tasks }` row counts |
| `projectionStore` | `null` while every canonical file projects; otherwise `{ files, latest: { at, sourcePath, message, failures } }` — how many files currently fail to rebuild and the most recent one, with the store's own error (rulings 217/218). A latch set by the rebuilder's catch and cleared per file by that file's next successful rebuild, never a probe. Non-null marks `degraded: ["projections"]` |
| `watcher`, `kbWatcher` | store and knowledge-base watchers alive; a watcher error clears the handle, so `false` is a real dead watcher, not "never started" |
| `lock` | `{ pid, hostname, startedAt }` of the single-writer holder, `null` if none |
| `backends` | `{ claude: { connectedUsers }, codex: { connectedUsers } }` → how many PEOPLE have connected each backend (ruling 127), recounted on every call. `0` is a normal reading, not a fault, and never degrades health; it is not a validity check, and it does not answer "can this task run", which is a fact about the task owner |
| `browser` | `{ status: "ready" }` or `{ status: "unavailable", reason }` for the governed browser (the `@playwright/mcp` CLI missing, or a pinned `VIBERR_BROWSER_EXECUTABLE` not on disk) |
| `disk` | `{ freeBytes, totalBytes, usedPercent, status: ok\|low\|critical, source: data-root\|host, lowThresholdBytes, criticalThresholdBytes }` or `null` when neither source could measure the root (not degraded); 5 s cache. The reading comes from POSIX `df -kP` (fragment-size aware), with `statfs(2)` only as the fallback — Node exposes `bsize` alone, and on Docker Desktop's virtiofs `f_bsize` ≠ `f_frsize`, which reported a near-full 229 GB volume as 62 TB with 1 TB free (F32-1). `source: host` means the host disk under the data root (`VIBERR_HOST_DISK_PATH`, Compose's `/host-disk` mount) had less room than the data root's own filesystem and is the reading (ruling 603): on Docker Desktop the named volume reports its disk image's virtual size, 940.8 GB free while the Mac had 19.9 GB |
| `maintenance` | `{ intervalMs, diskCheckIntervalMs, lastPassAt, lastPassReason: boot\|interval\|disk-pressure, lastFreedBytes, scheduled }` |
| `build` | `{ version, revision, revisionSource: env\|git\|null, builtAt }`; `revision` is `null` in an image built without `npm run deploy` or the build args |
| `quota` | one row per backend, `{ backend, reading, credentialRefused, exhausted }`: the latest rate-limit reading (a reading also lists every window it knows, `reading.windows`: Codex's from its rollout, ruling 608, and Claude's plan windows from the run's CLI, ruling 611; a window whose reset has passed reads `utilization: null`, and the binding fields move to the current window closest to its limit, ruling 612), the latest credential refusal and the latest quota exhaustion the run sink recorded (F32-9). On this unauthenticated route `credentialUserId` and `credentialLabel` are stripped from each record (ruling 130(d)); never `degraded` (ruling 146) |
| `toolchain` | `{ node, npm, git, python3, go, make, docker, pnpm, yarn, curl, codexCli, claudeAgentSdk }` — each version a string or `null` when that tool is not installed, plus the two pinned agent packages (rulings 182(b), 191, 196). Memoized per process. Never `degraded`: what an agent's shell finds is information, not a fault |
| `mcpProxy` | `{ listening, port, liveTokens }` — the loopback MCP gateway (ruling 461): whether it is listening on `127.0.0.1`, on which port (`VIBERR_MCP_PROXY_PORT`, or the one picked at boot), and how many runs hold a live gateway token. Never `degraded`: a gateway that failed to bind leaves credentialed MCP servers unmountable, which each run's prompt states |
| `agentIsolation` | (last) `{ status: on\|off\|degraded, uidFloor, reason }` (ruling 460). `on`: the launcher is installed and the boot probe, reading `state/projection.sqlite` as a uid that is not the server's, was refused — every agent process runs as its person's own OS user and cannot read the server's environment, the database or another person's home. `off`: no launcher (the host dev server, the test harness); runs spawn as the server's user; never `degraded`. `degraded` (marks `degraded: ["agentIsolation"]`): the launcher exists but the probe READ the store — the data root is on a mount that enforces no permissions between users, the macOS `./docker-data` bind mount; move it with `npm run store:to-volume` (deployment.md) — or the probe itself failed, with the launcher's own words in `reason` |

Status codes: the bare URL is a **liveness** probe and returns `200` even when degraded;
`?probe=readiness` (or `?probe=ready`) returns `503` with the same body while
`degraded[]` is non-empty; `503 { "ok": false, "status": "down" }` when the snapshot
itself threw (database unreachable). A zero `connectedUsers`, an unavailable browser, a
`null` disk reading and a per-person backend refusal or spent quota are deliberately
**not** degraded (ruling 146: one member's expired key must not make `?probe=readiness`
503 for an instance serving everyone else; the readings stay in the body under `quota`,
and Insights and Profile render them per person). The compose healthchecks call the
liveness form, so a degraded instance never fails the Docker healthcheck.

**The controller's `instance_health`** (a `viberr_ops` tool, ruling 107) reads the same
`healthSnapshot`, signed in, so its `quota` rows keep the account they belong to, and adds:
`backendCredentials` (per backend: `connectedUsers` and `askerConnected`, whether the
person asking can run it on their own tasks), `runs` (`{ cap, lane, live, queued }` from
the concurrency cap), `browserDetail` (org admins only, and only when there is one: the
pinned executable path) and, when the caller passes `probe` (up to 8 bare command names,
ruling 377), `probe[]` with `{ name, present: true, version }` or
`{ name, present: false, reason }` for each. Every call is audited as a read.

The boot log (structured JSON on stdout) prints one `boot integrity check` line:
`dataRoot`, `dataRootDirsOk` (and `missingDirs` when some are gone), `migrationsApplied`,
`latestMigration`, `projections`, `users`, `build`, `disk` and `toolchain`. When this
root's rebuilder tables lag the shipped baseline it is followed by a separate WARN,
`projection schema drift: this root's rebuilder tables lag the shipped baseline`, whose
`refuses` list names CHECK values the root will not admit and whose `missingColumns` list
names `task_projections` / `task_events` columns it lacks, each with the impact and the
remedy (see [deployment.md](./deployment.md#re-baselining-the-projection-database)). Grep
for both after a deploy.

**Most additive drift self-repairs and needs no remedy.** Every read-write open of the
database through `getDb` runs `ensureSingleFlightIndexes` and `ensureBaselineColumns`
(`app/server/db/sqlite.server.ts`): each missing entry of `BASELINE_COLUMNS` is
`ALTER TABLE … ADD COLUMN`ed, the missing `BASELINE_TABLES` and `BASELINE_INDEXES` are
created and `user_backend_credentials` is created or brought to its several-accounts shape
(ruling 507), idempotently, logging `added a baseline column this data root predated` for
each column (the lists, table by table, are in
[data-model.md §6](../architecture/data-model.md#6-schema-changes)). A column's one-time
backfill runs in the same step when the DEFAULT would misdescribe the rows that predate it
(`usage_final = 1` on the `finished` runs, so an upgraded root keeps its Insights token
history). Without that backstop every writer naming those columns would fail "no such
column" (on `agent_runs`, every agent completion). A failure to ALTER is warned, not fatal,
and retried next boot. Boot also widens a lagging `notifications.kind` CHECK in place
(ruling 481). The
re-baseline remains the remedy for the shape that cannot be patched additively — a CHECK
constraint that refuses a value the running build produces.

## Files are canonical; the DB holds projections plus primary app data

Authoritative business state is the markdown under `$VIBERR_DATA_ROOT/projects/` (plus
`agents/`, `kb/`, `skills/`). SQLite holds *projections* derived from those files, which
can always be rebuilt, **and** primary app data that exists nowhere else: users and
better-auth credentials, sessions, sealed PATs, MCP credentials and personal backend keys,
audit, notifications, prefs, instance settings, org resource rows, run history, controller
conversations and the provenance ledger. Back the database up
([deployment.md](./deployment.md#persistence-backup--restore)); only the projection tables
are a cache.

## Rescan vs. rebuild

- **Re-scan** (Home store strip, org admin, 10 s cooldown (`RESCAN_MIN_INTERVAL_MS`), or
  per project on the board for admin/maintainer (`rescan-project`); `npm run rescan` takes
  the single-writer lock and REFUSES against a live instance): incremental — re-reads
  changed files (content-hash short-circuit; `--force` on the CLI re-projects everything)
  and updates projections. Use after editing task/project/epic files directly, or if the
  watcher missed a change.
- **Rebuild projections** (Home, org admin, confirm dialog, 30 s cooldown
  (`REBUILD_MIN_INTERVAL_MS`)): deletes every row of `projects` (and so `project_members`),
  `task_projections`, `task_events` and `diagnostics` and rebuilds them from files in one
  transaction (`rebuildProjections`). Use if projections look inconsistent, after
  restoring only `projects/` without the DB, or after a schema change to a projection
  table. Users/sessions/PATs/audit/notifications are **not** touched.
- **Boot** runs the *rescan*, never the rebuild, before the first request, so
  out-of-band edits made while the app was down converge.

The file watcher (chokidar, 250 ms trailing debounce per path, dotfiles and `*.tmp`
ignored, nothing below a task directory except `task.md`) drives incremental rebuilds in
both dev and prod. A watcher error clears the handle and health reports `watcher: false`;
transient errors (`EMFILE`, `ENFILE`, `ENOSPC`, `EPERM`, `EACCES`) re-arm the watcher
after 2 s. A rebuild that FAILS is retried on its own (ruling 218): the watcher re-queues
that path after 2 s, 5 s, 15 s, 45 s and 120 s (`RETRY_BACKOFF_MS`), resets on the first
success, and after the last step leaves the file in `projectionStore` on health, which
marks the instance degraded until the file projects again. A `project.md` whose cascade
could not re-project one of its tasks counts as failed (ruling 457): its own row and
members land, and the fault names the task's file.

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
  `rebuildPath` catches the throw into a provenance `error` row and the log line
  `projection rebuild failed`, and health names the file under `projectionStore`. Read
  the boot integrity WARN.
- A task that nothing will move: when a task has been quiet for 15 minutes
  (`STRANDED_AFTER_MS`) with no decision packet, no pending recommendation, no queued
  question, no scheduled run, no agent running or queued and nothing it is waiting on,
  the stranded sweep that runs after the 60-second schedule tick writes a note ("Nothing
  has happened on this task for N minutes, and nothing is scheduled to. …") and
  re-invokes the operator, once per silence (ruling 330, `stranded-sweep.server.ts`).
- A run that ended in error: the Agent-logs footer names the classified cause for every
  run kind (ruling 130(a)): "refused this run: the account's usage window is spent" or
  "the account was rejected by the provider"; `continuity error` is only an
  unclassified failure. The terminal line in the log console carries the kind on its
  tag (`quota`, `auth`, `overloaded`, `idle_timeout`, `tool_loop`, `max_turns`, `max_budget`,
  `session_missing`, `unavailable`), the typed facts (the window, the absolute reset, the
  API status and code) and the provider's own words (`The provider reported: …`). A 403
  `oauth_org_not_allowed` means the connected Claude account's organization does not allow
  it: the remedy is on that person's Profile → Agent accounts, never a retry. A 403
  `account_on_hold` is the same family: the account itself is on hold. `overloaded`
  (`api 529` or another 5xx on the result line, or an `overloaded` / `server_error`
  banner) is the provider's side: nothing about the account or the task is wrong, and the
  packet's options are a retry on the same backend or on the other one.

## Finding a request by its id

Every response the app answers carries its request's id as `X-Request-Id` (ruling
458(d)): the browser's devtools show it under the request's response headers. For a
failure met while moving around the app, it is the failing `.data` request's. An inbound
`X-Request-Id`, from a proxy in front, is reused, so the proxy's access log and the app's
records share one id. The error page shows it too, as "Request id: …", when the failure
arrived with the document itself (a server render, or the hydration that reuses it); an
error met on a later navigation shows none rather than an earlier request's, so read that
one from devtools (ruling 458(n) raised the ruling-457 ceilings for the error page's id).

The app logs JSON lines on stdout. To find one request's records:

```bash
docker compose logs --no-log-prefix app | grep '"requestId":"<id>"'
```

A record made inside a request carries `requestId`, `method` and `path` (never the query
string), and `userId` once the session resolved. A run started by a request logs its own
work (the stream, the settle, the completion effects) under its `runId` and `taskKey`
plus the `requestId` and `userId` of the request that started it, long after that
request answered; `grep '"runId":"<run id>"'` finds a run's records whatever started it.
Records from boot, the watchers and the timers, and from a run they started, carry no
`requestId`: they name their own ids.

A few answers carry no header: static assets (served before the app sees the request),
a document form post whose `Origin` header is not a URL, which React Router refuses
before routing (a plain `400 Bad Request`, whose log record does carry an id; a
cross-origin post gets the app's own 403, which carries the header, ruling 687), the route
manifest, and React Router's last-resort
answers (a document it could not render at all). Match those by time, method and path.

## A task waits on other work (ruling 131)

A task whose `blockedBy` list is non-empty is HELD, not stuck: its readiness is floored
at `blocked`, the card leads with a neutral "blocked by …" chip, the task page names
each entry with its live state, and `waiting` is `none` unless a packet or a
recommendation is open. Nothing is owed by anyone while it waits.

- **Who set it:** the task page's Details panel (its "Blocked by" row), the controller's
  `update_task` / `create_task`, or the operator's `set_dependencies`
  tool. Every write is a "Dependencies updated" note and a `task.dependencies.updated`
  audit row; a bad reference is refused by name (unknown, archived, self, a cycle).
- **Why the operator is quiet:** `create`, `transition` and `scheduled` triggers are
  refused at fire time (`refused: "blocked-by"`, no run, no cost) and the stranded
  backstop never nudges a held task. A run that does start (an @mention, a resolved
  packet, a manual run) is told the wait and told not to advance, dispatch delivery or
  open a packet about it. A scheduled `run-operator` occurrence retires as
  `skipped-held` with a note; a scheduled `run-agent` still fires.
- **How it releases:** when every entry is done (its task at the terminal stage) the
  release engine, which runs from the task-write hooks (a stage move, an archive or
  restore, an acceptance) and from its own minute tick (`startDependencyRunner`), clears the
  list, writes "Dependencies released", lifts a stored `blocked` to `ready`, clears
  `heldAtStage`, notifies the owner and supervisors (kind `dependency`, its own
  toggle) and re-invokes the operator with `dependencies-released`. A person emptying
  the list is the same release.
- **It never releases** when an entry was archived before it was done: the dependent
  gets one "Waiting on archived work" note, its watchers one notification, and it is left
  `waiting: human` until someone edits the list; the entry renders as "archived". An
  entry archived at the terminal stage is done (ruling 651): archiving finished work,
  one task or a Done epic's all at once, releases or holds nothing.
- **Converting an old hold** (the live JC-7 / JC-9 shapes): set the list on the task
  page first (setting a wait never touches a packet), then resolve any standing packet
  with its recommended option; that one reactive turn reads the wait and stops. The
  projection column `blocked_by_json` is additive and is not in `BASELINE_COLUMNS`: on a
  root that predates it the boot drift WARN lists `task_projections.blocked_by_json`
  under `missingColumns`, and the remedy is `ALTER TABLE task_projections ADD COLUMN
  blocked_by_json TEXT NOT NULL DEFAULT '[]'` with the app stopped — never a re-baseline
  (the file also carries users, sessions and sealed PATs), and never a write against the
  running container.

## Goal chains became epics (ruling 503)

The first boot of a build with epics converts every chained-goal file once, after the
rescan (`convertGoalsToEpics`). Each `projects/<slug>/goals/goal-N.md` becomes
`epics/epic-N.md` with its tasks in it, and the goal file moves to `goals/converted/`,
which is what stops the conversion running again. What it did is one `info` line,
"converted goal chains into epics", listing each `<slug>/goal-N -> epic-N (N tasks, made
<keys>, N listed)` and the tasks whose waits were respelled by task key; each epic's
history opens with "Converted from goal-N …", and the project's Activity column has an
`epic.converted` row.

- **A goal file was not converted:** the WARN "some goal files were not converted; they
  stay in goals/ for the next boot" names each one and why (its frontmatter could not be
  read, or a step threw). Nothing else changed for that goal. Fix the file, then restart;
  every step is idempotent, so a half-finished goal finishes (its epic is found again by
  `convertedFrom`, a link already made a task is recorded in the goal file).
- **A link that had not started is not a task:** it is listed in the epic's description
  with its text and the reason (a paused, stopped or closed chain, a creator who lost task
  creation, a wait on work that will never exist). A person makes it a task from the epic
  page's New task.
- **A task says it "waits for you" after the upgrade:** everything it waited on was a goal
  link that can never have a task, so the conversion cleared the list and put it in front
  of a person, with a "Waits on other work" note saying which links. Give it other work to
  wait on, or move it on.

## GitHub / PAT issues

- Per-project credential health and scope violations show on the GitHub view and the
  task. Diagnostics distinguish `insufficient_scope`, `expired`, `revoked`,
  `repo_not_found`, `org_approval_missing`, `network_error`.
- **An empty repository needs nothing from you** (ruling 128). Viberr creates
  the default branch itself before a task's first branch (an initial commit through the
  Contents API, or the configured default at the first commit of a task branch GitHub
  made the default), disclosed on the task timeline and audited as
  `github.repo.bootstrapped`. "Delivery could not run … Viberr could not create it"
  names the one case that needs a person: the credential cannot write the repository
  (a `repo` scope violation opens) or GitHub refused the create; fix that, then deliver
  again. A delivery never pushes a task branch as the repository's first ref.
  A repository whose default branch is not named for one of the project's tasks is
  not given another (ruling 670): when the project names a branch the repository does
  not have (written unconfirmed before ruling 671 while GitHub was unreachable, or
  renamed on GitHub since), the project takes the repository's default, the task's
  timeline says so, and
  the audit row is `project.default_branch.adopted`. After a rename, a workspace that
  already has commits on the old name stays on it: rename that branch in the workspace,
  or let the task finish there.
- **A board with no repository, and the question about one** (ruling 672). Any board
  can be created with none; its tasks come back as files. The first time a task needs a
  repository its operator opens "Connect a repository to <project>?", which a project
  admin answers once for the board. **Connect** attaches what they type through the
  settings door and starts the controller on the board to switch it to pull requests; the
  task's timeline says whether the controller started, and when it did not (the person
  has no Claude account connected) the remedy is to ask the controller for the switch, or
  to grant repo-write on the Agents page. **Keep without** writes `no-repository-<project>.md` into
  the project's rulings knowledge base (audit `project.repo.ruling_recorded`), and the
  operator is not offered the question again. To have it asked again, delete that
  document in Instance settings → Agent resources; attaching a repository in project
  settings removes it too (`project.repo.ruling_removed`) and answers every task still
  asking. A task that shows "waiting on agent" with no run right after a connect is
  waiting for the controller to finish the switch; the stranded sweep (ruling 330) starts
  its operator after fifteen quiet minutes if nothing else does.
- **A branch collision packet whose PR is the task's own** (ruling 136): the
  `resolve_remote_collision` option performs the push the person asked for when origin's
  copy is behind or absent, keeps the block only for a diverged remote, and every branch
  delete re-confirms a cached open PR against GitHub before refusing. "GitHub could not
  confirm whether PR #N is still open" means the check itself failed: nothing was deleted;
  resolve the packet again when GitHub answers.
- **"Delivery push refused: workflow scope"** (ruling 144): the task changes a file
  under `.github/workflows/` and the project's token cannot push it (a classic token without
  the `workflow` scope, refused before the push; or GitHub's own refusal on any token). A
  `workflow` scope violation is open on the task and the credential card carries the
  advisory. Grant `workflow` to the token on GitHub, then use **Re-check scopes** on
  the project's GitHub page. It sits in the card's footer whenever an advisory is open,
  including when every required scope is proven and the footer is green. The header
  listing `workflow` resolves the violation, as
  does the next successful push of workflow files. Then deliver again. Nothing here asks a
  person to push.
- Accept-completion merges the review PR; a missing `pull_request:write` scope surfaces
  as an open scope violation with a **Re-check scopes** action (re-validate the PAT, 60 s
  cooldown) rather than a silent failure. Write permission is proven read-only from the
  repository's `permissions.push`; the empty-payload write probe runs only with
  `VIBERR_GITHUB_WRITE_PROBE=1` (or `true` / `yes`).
- PR/branch state refreshes on a background poller: once at boot, then every 5 minutes
  (`RECONCILE_POLL_MS`) over every project with branched tasks. It emits divergence
  events, notifications, recommendation withdrawals and merge-pending nudges with no human
  in the loop, and raises a notification after 3 consecutive failures for a project
  (`RECONCILE_FAILURE_ALERT_THRESHOLD`). The
  **Update status** button on the GitHub view forces an immediate reconcile; the page
  shows how old the cached state is ("never synced" is neutral, ruling 46).
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
  | no-credential | the owner (or the asker) has not connected that backend, or the sign-in file of the account they have in use is missing | that person connects it on their own Profile → Agent accounts, or switches to another of their accounts there (ruling 507; the sentence says when one works) |

  Each writes an honest `run·unavailable` error run and the usual blocked recovery packet
  through the normal completion pipeline. No agent process is started, so there is nothing
  to interrupt and no partial work to reconcile.

- **A missing sign-in file after a volume wipe** is the common Docker case. A hosted
  sign-in lives only in its account's own home (ruling 507),
  `$VIBERR_DATA_ROOT/runtimes/users/<userId>/claude-home/accounts/<accountId>/.credentials.json`
  or `.../codex-home/accounts/<accountId>/auth.json` (directly in `claude-home/` or
  `codex-home/` for an account connected before ruling 507); deleting or recreating that
  directory removes it while the credential ROW stays in `user_backend_credentials` (a
  wipe of the WHOLE `viberr-data` volume takes the database with it, and then the row is
  gone too). Health for that person then reads "Your <Backend> sign-in file is missing
  from this server (the runtime volume was wiped). Sign in again on your Profile → Agent
  accounts.", followed by "Another of your <Backend> accounts is connected there:
  switching to it needs no sign-in." when one of their other accounts still works. Do not
  copy a file in by hand: the vendor binary owns that file, and Viberr never reads or
  writes its contents. The person signs that account in again from its row on the card
  (into the same account), or switches. (On macOS only, an existing account home with no
  credential file is honoured as a Keychain login and reported with the weaker `presence`
  verification rather than hidden.)

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
      SELECT u.email, c.backend, c.id AS account, c.label, c.kind, c.method,
             c.verified_at, c.selected_at, c.legacy_home, c.created_at
        FROM user_backend_credentials c JOIN users u ON u.id = c.user_id
       ORDER BY u.email, c.backend, c.selected_at DESC, c.created_at DESC, c.id DESC`).all());
    db.close();
  '
  # 3. throw the copy away
  docker compose exec -T app rm -rf /tmp/viberr-snap
  ```

  A person may hold several accounts per backend (ruling 507): the first row of each
  (email, backend) in that order is the account their runs bill.

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
  card, and `/resources/health` names nobody. A quota-refused run opens a packet with a
  `retry_other_backend` option, offered only when the task owner has the other backend
  connected, and the switch sticks on the engagement (`pinnedBackend`). The Agent-logs
  "Retry on <other>" button passes the same test, so a task never offers in one surface
  what the other withholds.
- Spending cap (ruling 175): Instance settings → the spending-cap row sets `maxRunSpendUsd`,
  what one Claude run may spend (none by default). A run that reaches it ends
  `run·error·max_budget`, pill `cut off · spending cap`, and its line and packet name the
  cap and the spend. It is a cut-off, not a failure: re-run to continue, or raise the cap.
  Codex runs are not capped (no budget option in its SDK).
- Concurrency: Instance settings → runtime sets `maxConcurrentRuns` (0 = unlimited, ceiling
  64); excess runs wait in a `pending` queue that drains on every completion. Operator
  and controller turns have a lane of `max(1, ceil(cap / 4))` extra slots beyond the cap
  and are promoted first (ruling 152(b)), so `live` may exceed the cap by that many. Past
  its lane a coordination turn only borrows a cap slot no build is using: with a build
  parked, the next freed slot goes to the build. `instance_health` → `runs` shows
  `{ cap, lane, live, queued }` right now.
- After a restart, orphaned `running|queued` rows are finalized as `interrupted` with
  `interrupted_reason: restart` (`interrupted_by` stays a person or null; the task page
  reads "interrupted by a restart", and Insights counts them as stopped, not as errors,
  with a never-started queued run out of the completion rate; ruling 158 addendum) and
  the operator is re-invoked once per affected task (capped at `RECOVERY_REINVOKE_CAP`,
  3 per 30 min); finished runs whose completion never posted are replayed, and plans
  nobody executed are recovered. This is why `task.agent.replied` and
  `runtime.operator.plan_executed` audit rows are exempt from retention. A fourth pass,
  `settleAbandonedWaits` (ruling 213), finds live tasks that claim `waiting: agent` with
  no run `running` or `queued`, skipping the tasks the orphan pass already took (ruling
  215): each gets a "Left waiting on an absent agent" note and a fresh operator
  invocation, or is settled to `waiting: human` when the operator cannot start.
- **`bwrap: No permissions to create a new namespace`, or `EPERM` from `npm ci` inside a
  Codex run** — the image predates ruling 185 (2026-09-12), or something has
  re-introduced an OS sandbox. Viberr starts every Codex run `danger-full-access`:
  nothing should invoke bubblewrap, and no seccomp filter should be installed. Rebuild and
  recreate (`docker compose build app && docker compose up -d`; a restart keeps the old
  image). The symptoms, for reading old runs: every confined Codex run failed at its
  first shell command (F36-1) or could not complete `npm ci` because the network-off
  filter denies the socketpair libuv's synchronous spawn needs (F36-11) — both reported
  by the model as verdicts on correct work. `compose.yml` must NOT carry
  `security_opt: [seccomp=unconfined]`; see
  [deployment.md — Codex runs are not OS-confined](deployment.md#codex-runs-are-not-os-confined-ruling-185).
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
  Viberr SIGTERMs whatever still carries that id, waits 5 s (`RUN_REAP_GRACE_MS`) and
  SIGKILLs the rest. The `info` line `reaped the processes a settled run left behind`
  gives the run ids and how many were terminated and killed. A non-zero `killed` means
  something ignored SIGTERM. A process the run started that is still alive after its row
  settled is a bug. An agent runs as its person's own uid (ruling 460), so the server
  user cannot read its environment: list a run's processes by hand with the launcher,
  which reads it as root, `docker compose exec -T app /usr/local/libexec/viberr-launch
  --reap 0 <runId>` (one pid per line; `--reap KILL <runId>` ends them).
- **Every agent runs as its person's own OS user (ruling 460).** `ps -o user,pid,cmd`
  inside the container shows agent processes under numeric uids from 20001 (the person's
  uid is `agent_os_users.os_uid`, allocated once and never reused). A run that fails at
  start with "The agent could not be started as its person's own user (ruling 460): …"
  is refused before any process started, and the sentence carries the launcher's own
  words: the person's home could not be handed to their uid (a directory on the path owned
  by someone else, a path outside `runtimes/users/`). Nothing falls back to the server's
  user. `scripts/check-agent-isolation.sh` checks the whole mechanism in place:
  `docker compose exec -T app sh scripts/check-agent-isolation.sh` (it uses two throwaway
  uids at the top of the range and removes what it creates). A person's files under
  `runtimes/users/<userId>/` are theirs: read them as the server (group `node` reads every
  file there once the launcher has handed the home back after a run) or with
  `docker compose exec`, never by changing their owner.
- **A delivered page has no picture** (ruling 691). The task says why in three places: the
  "Page captures" note on its timeline ("Viberr could not picture `x.html`: …"), "No
  picture of this page: …" under that file on the completion or Result card, and
  `task.md` `pageCaptures.pages[].error`. The server logs `a page could not be captured`
  with the task, the file and the reason, and `page captures made` with the counts and
  the wall time; audit `task.pages.captured` carries who it ran as. The reasons: "the
  render ran past 25 seconds" (a script that never finishes or a page that never finishes
  loading; the job as a whole is stopped at 10 s plus 25 s a page), "the browser ended
  before the page was pictured", "the task has no owner to render it as" (isolation is on
  and the task has no owner: give it one and the next delivery is pictured), "the pinned
  browser executable (VIBERR_BROWSER_EXECUTABLE) is not on disk" (health's `browser` says
  the same), a source over 10 MB (markdown 2 MB), "a delivery is pictured up to 8 pages"
  for a page past the eighth, and "the delivered files could not be handed to the
  renderer": the server could not make `<task>/.capture-input/` its own folder in the
  agent group (the log line `a delivery's files could not be handed to the page renderer`
  carries the cause; check the store layout and that the server's user is in the agent
  group), and it copies a delivery nowhere else. The note ends by naming `capture_page`
  only when that tool can still show the page. A result file that is a page with no row
  at all under it was not this render's to picture: a person's own upload, a relayed
  file, or a page past the 40 one record names. No note at all on a files delivery means
  the deployment names no browser, the delivery held no page, or the task's delivery is
  a revision. A picture that shows boxes where text should be is a script the image has
  no font for (it ships Liberation and an emoji font). A page that opens `alert()`,
  `confirm()` or `prompt()` as it loads is pictured with the dialog dismissed, and the
  note says so. Renders are one at a time for the whole instance, so a burst of
  deliveries queues; an agent's `capture_page` goes ahead of waiting deliveries and
  answers `[busy]` when it has not started within 15 s. Its pictures stay under
  `workspace/.captures/<runId>/` until the run ends; a folder there whose run is no
  longer live is removed before the next render on the task. A restart during a render
  loses that delivery's pictures: the next delivery is pictured, and an agent can look
  with `capture_page` meanwhile. `docker compose exec -T app sh
  scripts/check-page-capture.sh` checks the renderer against the image's own browser.

## Auth / access

- Sessions live in better-auth's own `session` table (singular, better-auth's schema).
  **Expiry is 30-day rolling**, slid at most once a day on an active session; the
  refreshed cookie is forwarded by root's `sessionRenewalMiddleware` on whichever GET
  resolved the session (ruling 457). **Nothing prunes expired rows**; an
  expired row is simply never honoured. Rows are deleted only by an explicit act: sign-out
  (`routes/logout.tsx`), a self-serve password change (deletes every OTHER session), the
  auth guard (deletes the session of a disabled or deleted user on sight), and admin
  revocation (`revokeUserSessions` on disable and on admin password reset; deleting the
  user cascades). To prune by hand, stop the app and delete by `expiresAt`, checking the
  stored textual form first (`SELECT expiresAt FROM session LIMIT 1`).
- Locked out / forgotten password: an admin resets it in Instance settings → Users & access
  (a one-time temp password that forces a reset at next sign-in). The bootstrap admin
  comes from `VIBERR_SEED_ADMIN_*` on first boot of an empty users table (random
  password logged once as `VIBERR BOOTSTRAP ADMIN` when unset).
- OAuth sign-in only succeeds for a whitelisted account (a non-disabled user row) or an
  allow-listed Google domain; there is no self-signup. Implicit account linking does not
  trust unverified provider emails (F28-A1).
- Sign-in throttling keys on `email|ip`; behind a proxy set `VIBERR_TRUST_PROXY` or every
  client is `local`.
- **Every request hangs, in every tab, with no error** (ruling 301): the browser's
  per-origin connection pool is exhausted. Each visible Viberr page holds at most one SSE
  stream, except the project controller page, which holds two (the layout's and its own);
  `/insights` has none, and the controller dock opens one there while its panel is open.
  HTTP/1.1 allows about six connections per origin, so a handful of visible Viberr pages
  (side-by-side windows, say) are enough. Close or hide some; a hidden tab closes its
  streams and catches up when it comes back (the broker replays what it missed). The
  server is not the problem: the same endpoint answers `curl` at once.

## Retention & growth

`runMaintenancePass` runs at **boot**, every **6 hours** (`VIBERR_MAINTENANCE_INTERVAL_SECONDS`)
and on **disk pressure** (checked every 5 minutes, `VIBERR_DISK_CHECK_INTERVAL_SECONDS`; an
extra pass at most every 30 minutes; thresholds 2 GiB low / 512 MiB critical,
`VIBERR_DISK_LOW_FREE_MB` / `VIBERR_DISK_CRITICAL_FREE_MB`). Each pass logs
`store maintenance pass {reason, runLogLines, auditEvents, notifications, transcripts,
sessionFiles, workspaces, freed, …}` and is reported on `/resources/health` under
`maintenance`. Every step is caught independently, so one failing never stops the next.

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
`BACKED_UP_STORE_DIRS`, so a standard backup carries it.

**Tables with no retention:** `provenance` (append-only observation ledger, the one that
grows fastest; prune by hand with the app stopped: `DELETE FROM provenance WHERE
observed_at < …; VACUUM;`), better-auth `session`, `agent_runs`, `goal_projections` (an
upgraded root's; nothing writes it since ruling 503),
`controller_conversations`, `controller_messages`, `staged_outcomes` (24 h TTL in code,
rows kept), `scope_violations`, `model_availability`. `diagnostics` is rebuilt, not
pruned.

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
Viberr removes a workspace, a checkout and anything else an agent writes as the person it
belongs to (ruling 485), because a tool an agent ran can leave a directory only its uid can
enter (wrangler's 0700 `.wrangler/tmp/dev-*`), and the server's own `rm -rf` then deletes
`.git` and stops half-way. By hand, do the same: find the owner with `docker compose exec
-T app stat -c '%u' <dir>` and remove it as that uid, `docker compose exec -T -u
<uid>:20000 app rm -rf <dir>`; anything left belongs to another uid, removed the same way.
What is left as uid 1000 is the server's own (a run's skill plugin copied before ruling
495, the `workspace/` root itself). Viberr opens that to the agents' group and never
removes it with `rm` (ruling 495): do the same, `docker compose exec -T app chmod -R -P
g+rwX <dir>`, then remove as the owner again, and take an emptied `workspace/` root with
`docker compose exec -T app rmdir <dir>`. A finished task's reclaim does all of this
itself, so a workspace logged as "could not reclaim a finished task's workspace" before
ruling 495 goes at the next boot or maintenance pass.
A checkout left without `.git/HEAD` also heals by itself: the next run's checkout
preparation removes it as its person and clones again. A run whose checkout could not be
prepared says so as a workspace fault ("… could not be replaced: EACCES on <path>"), never
as a credential problem: attaching or re-issuing a GitHub credential does nothing for it.

The mirror is built in a `<mirror>.building` sidecar and renamed into place, and a mirror
counts as usable only once its `remote.origin.fetch` refspec is written — so a clone killed
mid-download (a container stop, an interrupted run) leaves nothing the cache will serve, and
the next clone rebuilds. A mirror whose `HEAD` does not resolve to a branch it holds is
skipped for the same reason: `git clone` warns and exits 0 on one, producing an empty tree.
Symptoms of an older half-built mirror, all at once: a `.repo-mirror/<owner>__<repo>.git`
with zero refs and orphaned `objects/pack/tmp_pack_*`, repeated `mirror could not be
refreshed; serving a possibly stale mirror` warnings, and agents reporting an EMPTY
repository — after which a delivering agent commits with no ancestry and the push is refused
as non-fast-forward. That refusal is NOT a stale remote branch: check the workspace's
`git log` before clearing anything on GitHub. The repair is to delete the mirror directory
(the server's, `docker compose exec -T app rm -rf …`) and the affected task's `workspace/`
(its agents', removed as their uid as above); both re-clone on the next run.

## The single-writer lock and CLI refusals

`<dataRoot>/state/writer.lock` holds `{ pid, hostname, startedAt, bootId }` and, on Linux,
`procStartedAt`. A second app process refuses to boot naming the holder; the holder
re-verifies ownership every 20 s and exits with a synchronous `FATAL` line if the file is
deleted or replaced. Same host + dead pid is reclaimed automatically, and so is a lock
naming this process's own pid whose recorded start time differs (a crashed predecessor
that was also pid 1); a different hostname is never probed and always refused (compose
pins `hostname: viberr`). `VIBERR_FORCE_DATA_ROOT_LOCK=1` forces a takeover.

| CLI | Lock | Where it runs on the Docker deployment |
|---|---|---|
| `npm run seed`, `seed:demo`, `rescan`, `restore` (whole root), `keys -- reseal` | **takes the writer lock**; against a running app prints `refused to run: it would be a SECOND writer on this data root` (to stderr, with the holder and, where there is one, the in-app alternative) and exits 1 | from the host, before the container starts or after `docker compose down`; the lock refuses anything else |
| `npm run backup`, `keys -- status` | reader; no lock. A `state/writer.lock` of any age means they copy `projection.sqlite` and its `-wal` to `state/tmp/reader-<pid>/` and open the copy, never the live file (ruling 158); only a root with no lock file at all is just files, which they open in place, read-only | either side of the container boundary, since neither opens a live database. The in-container form (`docker compose exec -T app …`) is the worked example for the backup, whose artefact must land outside `/data` and be copied out |
| `npm run store:check`, `restore --file` | no lock, no database | either side: they read and write the markdown tree only |

So `docker compose exec app npm run seed` is refused. Seed before the container starts, or
stop it first. Do **not** wipe `state/` while the app runs.

### Readers, and where they must run

The writer lock stops a second WRITER. Nothing stops a second READER, and a second reader
is the hazard: any process that opens `state/projection.sqlite` while the app holds it
(`sqlite3`, a desktop SQLite browser, `node -e` with `readOnly: true`) maps the WAL index
(`-shm`) the server has memory-mapped, and on the Docker deployment as it shipped until
ruling 460 (`./docker-data`, a bind mount over VirtioFS) the open path's lock probe on
that file was unreliable, so a reader could truncate the index under the server; the store
is now the named volume `viberr-data`, which the host cannot open at all, and the rule
below stands regardless. A stale shared
mapping in the guest is what a SIGBUS looks like. `readOnly` is no protection and neither
is being inside the container: pass 34 saw exit 135 one second after a host-side reader,
pass 35 one second after an in-container `readOnly: true` reader (and boot recovery then
interrupted 23 runs). The side of the boundary was never the point; the second mapping
was. The rule (ruling 158), which `app/shared/docs/runbook-db-read.test.ts` holds this
page, `deployment.md` and `scripts.md` to:

- **No process but the server opens a live root's database. Copy first, never a second
  connection, on either side of the container boundary.** Copy `projection.sqlite` and
  `projection.sqlite-wal` (never the `-shm`: that IS the shared index, and a copy
  rebuilds its own) to a scratch directory, open the copy, throw it away; the worked
  example is under [Agent runtimes](#agent-runtimes). The read-only CLIs do exactly this
  on their own: `npm run backup` and `npm run keys -- status` look for
  `state/writer.lock`, and if one is there at all they copy both files to
  `state/tmp/reader-<pid>/`, open the copy and remove it when they close
  (`openDatabaseReadOnly` in `app/server/db/sqlite.server.ts`; a copy left by a reader
  that died is swept by the next one); only a root carrying no lock file is just files
  they open in place, read-only. They deliberately do NOT reuse the boot's `stale`
  verdict: liveness is probed inside ONE pid namespace and `compose.yml` pins
  `hostname: viberr`, so a live holder in a second container from that file reads as a
  dead pid on the same host, and believing it would open the live database. A needless
  copy costs disk; that mistake costs the server. `keys -- status` says which it did on
  stdout; the backup manifest records it. The backup is still the two-step form under
  [Backup / restore](#backup--restore), because its artefact may not land under `/data`
  and anywhere else in the container is gone with it.
- **Ask the server before copying anything.** `/resources/health` answers the health,
  lock-holder and connected-backend questions in-process, and the controller reads
  through the server's own handle: its `viberr_ops` tools (`instance_health` for the
  same snapshot, `list_runs` for the live runs or one task's runs, `read_run_log` for a
  run's console, `read_store_doc` for a knowledge-base or skill file) and its
  `viberr_controller` tools (`inspect_audit_log`, `get_task` and the rest) need no copy
  at all, and are the reader to reach for first.
- **`npm run store:check` needs no database** (it parses the markdown tree) and may run
  from either side; so may `restore --file`, which writes one markdown file and touches
  no SQLite.
- **Once the app is down** the root is just files, and any program may open it in place.

## Self-heal and disk

- At boot, before the first handle opens, `PRAGMA quick_check` runs on the projection DB.
  On a corruption verdict (`SQLITE_CORRUPT`, `NOTADB`, "malformed" — never on
  `EACCES`/`EMFILE`) `selfHealProjectionDbIfCorrupt` builds a fresh file at a temp path,
  runs the migrations into it and copies every table except the ones the rescan rebuilds
  (`REBUILT_FROM_FILES`), then copies the corrupt file and its `-wal`/`-shm` to
  `state/projection.sqlite.corrupt-<ts>` (preserved, never deleted) and renames the fresh
  file into place. It logs `projection database is CORRUPT: self-healing` and
  `projection database self-healed` at error level, then boot WARNs `recovered a corrupt
  projection database at boot` with `movedTo` / `salvaged` / `skipped` (a non-empty
  `skipped` means some readable rows could only be kept in the preserved file). Projection
  tables are rebuilt by the boot rescan. Delete the `.corrupt-*` files once you have a
  backup.
- Low disk never refuses boot; it is logged, reported on health as `disk.status`, and
  triggers an extra maintenance pass. The status is the tighter of the data root and the
  host disk under it (`disk.source`, ruling 603), and each transition's log line names
  which one; the first check after a boot only records its reading. `ENOSPC` on a canonical write becomes a named "No
  space left on the data root" error; `ESTALE`/`EIO` (a data-root mount gone stale under a
  running container) become a 503 naming the data root as unreachable.

## Backup / restore

`npm run backup [-- --out <dir>]` writes a consistent point-in-time artefact (`VACUUM
INTO` plus the store tree — `projects/`, `agents/`, `kb/`, `skills/` and
`audit-exports/`, without task `workspace/` checkouts and `.repo-mirror/` mirrors — and a
manifest) **without** taking the lock, so it works on a live instance, and without opening
the live database: with a `state/writer.lock` present at all it copies
`projection.sqlite` and its `-wal` to `state/tmp/reader-<pid>/`, runs the `VACUUM INTO` on
the copy and removes it, so the artefact stays one self-contained file and the manifest's
first `contains` line says it was read from a copy ([Readers, and where they must
run](#readers-and-where-they-must-run)). On the Docker deployment run it INSIDE the
container with an explicit `--out`: the default `./backups` is `/app/backups` in the
container and vanishes with it, and `createBackup` refuses a destination under the data
root it is backing up, so `/data/…` is not an option either. Write it to a
container-local directory and copy it out in the same breath:

```bash
docker compose exec -T app npm run backup -- --out /tmp/viberr-backups
docker compose cp app:/tmp/viberr-backups/. ./backups/    # now the artefact is on the host
```

`runtimes/` is excluded unless you pass `--include-runtimes`, and that directory holds
every person's live vendor sign-in (`runtimes/users/<userId>/…`, ruling 127), so an
artefact taken with it is a secret. `npm run restore -- --from <artefact>` takes the
lock, needs `--force` on an occupied root and moves displaced data to
`<dataRoot>.replaced-<ts>/`; `--file <store path>` restores one canonical file without
touching the database. A key the instance generated for itself travels in the artefact
(`instance-secrets.json`, ruling 504), which makes the artefact a secret. Back up a
`VIBERR_SECRET_ENCRYPTION_KEY` set in the environment separately: without it every
sealed PAT, MCP credential and **personal backend API key** (`user_backend_credentials`,
ruling 127) in the artefact is unreadable, and restoring the database without the key
leaves every person who pasted a key having to connect that backend again. Rotating is
safe: `npm run keys -- reseal` covers that store like the others. A raw copy of the live
`projection.sqlite` misses committed rows still in the WAL; use the CLI. Details and the
ghost-membership warning for a `projects/`-only restore:
[deployment.md](./deployment.md#persistence-backup--restore).
