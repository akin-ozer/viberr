# Agents and the run runtime

> How a Claude or Codex process is started for a task, what it is allowed to do, what
> it sees, how its output is stored and streamed, and how the server recovers when it
> dies. The operator's own behaviour is in [operator.md](operator.md); the controller's in
> [controller-and-epics.md](controller-and-epics.md).
> Source of truth: `app/server/runtimes/*` (the two adapters, `run-service`, `run-sink`,
> `run-projection`, `context-policy.server.ts`, `prompt-prefix.server.ts`),
> `app/server/tasks/specialist-*.ts`, `app/server/tasks/agent-*.ts`,
> `app/server/tasks/run-failure-remedy.server.ts`, `app/shared/capabilities.ts`,
> `app/shared/run-failure.ts`, `app/server/files/kb-injection.server.ts`,
> `app/server/ops/toolchain.server.ts`, `app/server/seed/*`; the OS user a run executes as:
> `app/server/runtimes/agent-isolation.server.ts`, `tools/viberr-launch/viberr-launch.c`
> (ruling 139).
> Verified against `main` @ `7d9fbf72` (2026-09-23).

## 1. Vocabulary that bites

- **Profile kind** (`agents/profiles/<id>.md`, `kind:`): `operator | specialist |
  controller`. A specialist is any deployable agent that does stage work (Developer,
  Reviewer, anything an admin creates).
- **Run kind** (`agent_runs.kind`): `operator | primary | reviewer | controller`. This is
  the **delivery axis**, not the persona: `primary` is the run of the delivering
  engagement, `reviewer` is the run of *any* supporting engagement (a non-delivering
  Developer is stored as `reviewer`), `controller` rows carry `project_slug = ''` and the
  conversation id as `task_key`. The persona is in `role` and `agent_profile_id`.
- **Engagement** (`task.md` `engagements[]`): an agent's seat on a task, with
  `profileId`, the `role` snapshot, `backend`, `delivers: true|false`, `verdictCapable`,
  optional `pinnedBackend` and, while a reviewer is answering the completeness question,
  `question: {kind: "completeness", runId, at}` (ruling 93). At most one entry
  delivers; it owns the workspace, branch and PR. Engagements are written by the dispatch
  itself (ruling 51).
- **Backend**: `claude` (Claude Agent SDK `^0.3.292`, Claude Code 2.1.292) or `codex`
  (Codex SDK `^0.160.1`). Both run on the vendor SDKs; the Cognipeer Agent SDK was
  evaluated and not adopted (ruling 143). A profile lists the backends it may run on; the
  FIRST listed one is the deployment's "primary run backend" (`primaryRunBackend`,
  `app/server/agents/deployment-view.server.ts`), `claude` when none is listed.

## 2. Backends

### 2.1 Credential principal and per-person availability (ruling 137)

There is **no instance-level "the backend is configured"**. Every run bills ONE person —
its **credential principal**, persisted as `agent_runs.credential_user_id`: the **task
owner** for every task run (operator, specialist, resume, scheduled, boot recovery,
retry), the **asker** for a controller turn. A task with no owner cannot run agents.

**Several accounts per backend (ruling 138).** A person may keep up to ten accounts per
backend (`MAX_ACCOUNTS_PER_BACKEND`), one `user_backend_credentials` row each. Exactly one
per (person, backend) is **active**, the one every run on that backend bills: the most
recently selected (`selected_at`; `ACTIVE_FIRST`). Every selection is stamped past the
person's latest one on that backend (`selectionStamp`), so two selections in one millisecond
still rank in the order they happened. Connecting, by a
hosted sign-in or a pasted key, adds an account and makes it active; switching
(`switchBackendAccount`, Profile → Agent accounts' **Runs use** picker, ruling 323) stamps
`selected_at` and nothing else, so no vendor process runs and no file moves, and a run
already going keeps the account it started on. Disconnecting is per account
(`disconnectBackendAccount`): removing the active one hands runs to the account used
before it. `agent_runs.credential_account_id` records which account a run billed.

`userBackendHealth(db, userId, backend)` (`backend-credentials.server.ts`) is the ONE
answer every surface reads: the health of the person's ACTIVE account on that backend
(`backendAccountHealth` answers for any one account, and names it: `accountId`,
`accountName`). It re-probes on **every call**, never makes a paid request, and needs a
`user_backend_credentials` row for that (person, backend):

| Row kind | Available when | `verification` |
|---|---|---|
| `api_key` / `access_token` | always (the sealed box is the credential) | `credential` |
| `login` | the vendor's own file is in that ACCOUNT's home (`claude-home/accounts/<id>/.credentials.json`, `codex-home/accounts/<id>/auth.json`; for a `legacy_home` account, the backend home itself) | `file` |
| Claude `login` on darwin | the account's home exists but holds no file (the Claude binary uses the Keychain; Codex signs in to its `auth.json` alone, the one file a run copies, so a Codex home without it is `none` on every platform) | `presence` |
| none, or a `login` whose file is gone | never — `detail` says which, addressed to the person, and adds that another of their accounts on the backend works when one does ("switching to it needs no sign-in") | `none` |

`/resources/health` reports the instance-level number that remains: `backends: { claude:
{ connectedUsers }, codex: { connectedUsers } }` (`countConnectedUsers`). Zero is a real
reading, not a fault.

`run-principal.server.ts` resolves WHOSE account a run uses (`resolveTaskRunPrincipal` /
`resolveUserRunPrincipal`) and `principalRefusalMessage` writes the human sentence for a
task run's three refusals (a controller turn writes its own, addressed to the asker):
**unowned** task, **owner-missing** (deleted or disabled), and **no-credential** (named
owner, plus the health detail). A refused run fails fast with the tag `run·unavailable`,
an honest error run carrying that sentence, and a blocked recovery packet quoting it — no
clone, no reservation, no process, and nothing spent on its behalf either: the principal
is resolved BEFORE the stdio MCP pre-flight (which starts each declared server to
handshake it and corrects its registry row) and before the skills are mounted into the
workspace, on the fresh, resume and operator paths alike. There is no fallback engine and
no fallback account: a run bills the active account or is refused, even when the person
holds another that works (ruling 138; the refusal sentence says the switch is theirs to
make).

### 2.2 Per-person runtime homes

- `<dataRoot>/runtimes/users/<userId>/claude-home` holds the person's Claude transcripts
  (`projects/`); `…/codex-home` is the `CODEX_HOME` a Codex run forks from (sessions under
  `sessions/`, the thread database, `config.toml`). Created on demand by
  `ensureUserBackendHome` (`user-homes.server.ts`); the user id is path-checked against
  `/^[A-Za-z0-9_-]{1,64}$/` first. There is no deployment-wide `runtimes/claude-home` /
  `runtimes/codex-home` and no host `~/.codex` mount.
- **Every account has a vendor home of its own (ruling 138).** An account connected since
  the ruling keeps its sign-in in `<backend home>/accounts/<accountId>`
  (`backendAccountHome`, the account id path-checked like a user id), where the vendor's
  binary wrote it: a hosted sign-in into a new account runs in an empty home minted with
  the account's id, and one that does not end connected takes that home with it once its
  process has exited. A Claude run's `CLAUDE_CONFIG_DIR` is the active account's home,
  whose `projects/` is a relative link to the backend home's (`ACCOUNT_HOME_SHARED_DIRS`),
  so every transcript lands where resume, the exporter and the retention sweep look,
  whichever account wrote it; two accounts never share a credential file, and switching
  moves none. A Codex account's home holds only its `auth.json`. An account connected
  before the ruling (`legacy_home = 1`, carried by the boot rebuild) keeps its sign-in in
  the backend home itself. `ensureBackendAccountHome` makes the home and its link before
  any vendor process runs, and `agentLaunchFor` hands both, when the server created them,
  to the person's uid (the launcher still hands back the whole backend home after every
  process).
- **Every agent process runs as its person's own OS user (ruling 139).** In the image,
  each person gets a stable agent uid (`agent_os_users`, allocated from 20001, never
  reused) and every agent shares the primary group `viberr-agents` (gid 20000); the
  server (`node`) is a supplementary member of that group. The person's runtime root
  `runtimes/users/<userId>/` and everything under it — `claude-home`, `codex-home` and
  `home` (the agent's `$HOME`: npm's cache, a `git config --global`) — is owned
  `<uid>:node`, directories 2770: the person's agents own it, the server reads and writes it
  through group `node`, and another person's agents (neither owner nor in `node`) reach
  nothing. The server never becomes root: `agentLaunchFor`
  (`agent-isolation.server.ts`) hands those three directories to the uid through the
  setuid launcher's `--prepare-home` when they are not already its, and `startRun` puts
  the launch on `RunSpec.agent` (uid, launcher, the vendor home to hand back) and
  `HOME=<runtime root>/home` on the env. After every launched process exits, the launcher
  hands the vendor home back again (owner the uid, group `node`, files gaining group read
  and write), because a vendor writes its sign-in 0600 and the server copies, re-points or
  backs it up. Without a launcher (the host dev server, the test harness) nothing of this
  applies and runs spawn as the server's user; health says `agentIsolation: off`. The
  project's gates (ruling 139) are agent processes in this sense: each `sh -c` command,
  the clone it runs in and its clean-up go through the launcher as the task owner's uid
  (`agentGitLaunchFor`, no vendor home), with `filteredSpawnEnv()` and the agent `$HOME`;
  a task with no owner records a gate error and runs nothing as the server.
- **Every Codex run gets a private `CODEX_HOME` (ruling 145).** The Codex CLI extracts
  its exec helpers (`codex-linux-sandbox`, `codex-execve-wrapper`, `apply_patch`) into
  ONE directory per home, `$CODEX_HOME/tmp/arg0/codex-arg0XXXXXX/`, and every new
  process of the same home replaces it, so concurrent runs of one person sharing one
  `codex-home` (a reviewer, the operator, a developer) delete each other's helper mid-run
  (F36-3). So the Codex adapter forks
  `<codex-home>/runs/<runId>/` at spawn (`prepareCodexRunHome`, `user-homes.server.ts`)
  and hands it to the CLI as `CODEX_HOME` — the server builds it as itself, so on a
  launched run it is handed to the person's uid (`--prepare-home`) before the CLI starts,
  and at the settle handed over again before the server reads it, with the written-back
  `auth.json` handed back after (ruling 139): `auth.json` and `config.toml` are **copied**
  in when present (a copy, so two runs never write one shared file through a link) — the
  sign-in from the home of the account the run bills (`RunSpec.accountHome`, ruling 138),
  never from another account's, and the config from the shared home;
  `sessions/`, `skills/` and `memories/` are **symlinks** to the shared home's
  directories, created first, so a rollout the CLI writes lands where
  `probeSessionContinuity`, the exporter and the retention sweep look; `CODEX_SQLITE_HOME`
  is set to the shared home so the CLI's thread/state database stays the person's; `tmp/`
  is whatever the CLI creates inside the run home, private by construction. When the run
  settles — finished, failed, interrupted or crashed, the adapter's one `settle` — the
  run's `auth.json` is copied back to the billed account's home only when the CLI changed
  it (its digest differs from the seed's, `.auth.json.seed`, so a copy that went stale
  while another run of the account refreshed never overwrites the newer token) and its
  bytes differ from the account's file, under that home's lockfile (`.auth.json.lock`,
  `O_EXCL` with retry; a holder older than 30 s, or one still held after a 3 s wait, is
  broken; last writer wins), only while the account's file still exists (a disconnect
  mid-run is not undone), and the run directory is
  deleted — on a launched run as the person, through the launcher (ruling 140: their CLI
  wrote it); a run a restart orphaned is finished the same way by boot recovery before the
  operator is re-invoked, its sign-in handed back to the account `credential_account_id`
  names (to nobody when that account has been removed since), together with its completion
  compaction's own fork when the restart cut that. The completion compaction (ruling 145)
  runs in a fork of its own, `runs/<runId>-compaction`, seeded and settled the same way;
  a specialist's run has finished by then, so boot finds a fork the restart cut by the
  mark on that finished row (ruling 175, §8). **The settle also re-points the CLI's thread index** (ruling 145,
  F37-20): the CLI finds a rollout by `threads.rollout_path` in its own state database,
  and what it records there is the path it SAW through the link,
  `…/runs/<runId>/sessions/…`. Deleting the run directory would leave the file intact at
  the shared path and the index pointing at nothing, so every `thread/resume` would answer
  "no rollout found" (measured before the fix: 137 of 137 threads recorded under a per-run
  home, 135 of those paths gone, 135 of 135 files present at the shared path). So the
  settle re-points that run's threads at the shared path before removing the directory,
  and a boot pass (`repairCodexRolloutPaths`) repairs any left from before. Both are
  fail-soft against a vendor artefact whose file name carries a schema version
  (`state_5.sqlite`): the shape is parsed, never asserted, an unrecognised one is skipped
  whole with a logged warning, a path is moved only onto a file that is really there, and
  a run still in flight owns its own path. `probeSessionContinuity`, the exporter and the
  retention sweep read the shared `sessions/` tree directly. `runCredentialFor` names the
  SHARED home on `spec.env.CODEX_HOME`; the fork is the adapter's, so every path that
  builds a Codex spec (specialist, operator, controller, resume, scheduled, recovery) gets
  it.
- `runCredentialFor(db, userId, backend)` builds what the run's child env carries for the
  person's ACTIVE account: the home always (Claude: the account's own home as
  `CLAUDE_CONFIG_DIR`; Codex: the shared `CODEX_HOME` the adapter forks, with the account's
  home on `accountHome`); `ANTHROPIC_API_KEY` (claude), `CODEX_API_KEY` / `CODEX_ACCESS_TOKEN`
  (codex) only for a pasted credential. In both codex secret cases `OPENAI_API_KEY` is
  explicitly absent. A `login` kind adds no secret: the vendor binary reads its own file.
- Spawn env hygiene: every variable matching `CREDENTIAL_ENV_RE` (`API_KEY`, `TOKEN`,
  `SECRET`, `PASSWORD`, `PRIVATE_KEY`, `CREDENTIALS`, `AUTH` …), the private-runtime set
  (`DATABASE_URL`, `REDIS_URL`, `SSH_AUTH_SOCK`, `GPG_AGENT_INFO`), **both vendor homes**
  (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` — neither is credential-shaped, but a home is where a
  vendor binary keeps its credential, so an ambient one would let a run billed to one
  person authenticate as whoever a leftover sign-in file names — and `CODEX_SQLITE_HOME`
  (ruling 141), the CLI's state-db location, which the Codex adapter sets per run to the
  principal's shared home) **and every name the app's own env schema declares**
  (`ENV_KEYS`: `NODE_ENV`, `PORT`, `VIBERR_DATA_ROOT`, `BETTER_AUTH_URL`, the OAuth client
  ids, every `VIBERR_*` knob the schema declares; ruling 141(a) — an agent works in the
  project's repository, not in Viberr's process, and the container's `NODE_ENV=production`
  / `PORT` broke a project's own `vitest` and `next start` inside a run) is stripped from
  the child (`filteredSpawnEnv`). A name the schema does not declare (`PATH`, `HOME`,
  locale, proxies, the image's `UV_*` caches) passes, which is safe because the "no
  undeclared env reads" gate keeps the schema complete; the one declared knob a child's
  tool depends on, `VIBERR_BROWSER_EXECUTABLE`, reaches the browser MCP as argv from the
  server, never from the env. The same base serves every spawned stdio MCP child
  (`mcpSpawnEnv`), the hosted sign-in driver, the vendor sign-out and the model catalog's
  `supportedModels()` probe (plus the viewer's credential). The run service then adds
  exactly one principal's credential on top, and `startRun` throws if the caller's own
  `env` overlay names a key the credential owns. After the overlay it merges
  `contextWindowEnv(backend, kind)` (`context-policy.server.ts`; empty, since every
  `AUTO_COMPACT_WINDOW` entry is null, ruling 174), and last it adds the **run marker**
  `VIBERR_RUN_ID=<runId>` (ruling 142): not configuration and not a secret, but the one
  name every process the run starts inherits, so the settle sweep can find them (§3.4). It
  is set after the caller's overlay, so nothing renames a run's processes, and a refused
  run, which spawns nothing, carries none. The run sink redacts those plaintext values
  from every persisted line (`createRunSink(db, spec, { secrets })`) — the key belongs to
  one person and the run console is visible to every project member. What a run can READ
  is a separate question, answered by the OS user it runs as (ruling 139): this env never
  carried the server's secrets, but before that ruling a run's shell could read them out of
  `/proc/<server pid>/environ`, and the projection database and every home off the disk,
  because it ran as the server's own uid. The launcher's environment is also where glibc's
  secure mode applies: a setuid program's `LD_*`, `TMPDIR` and the like are dropped before
  it runs, so an agent never inherits them from the server.

### 2.3 Models and effort

| Backend | Models (default first) | Efforts (default) | Rules |
|---|---|---|---|
| claude | `sonnet`, `opus`, `haiku` (aliases), plus a family alias carrying a bracketed context-window variant (`opus[1m]`, what the live catalog offers as "Opus (1M context)"), plus any dated `claude-*` id containing a digit, plus the live `supportedModels()` list of the VIEWER's OWN connected Claude account (10 min cache, one slot per backend tagged with the home that produced it, so another viewer misses and refills it; 15 s timeout; ruling 137) | `low medium high xhigh max` (`high`) | Alias or dated id runs verbatim; a string containing opus/haiku/sonnet maps to the alias; the bracketed variant is split off FIRST, the base resolved, and the variant re-appended verbatim (`claude-opus[1m]` → `opus[1m]`, `claude-sonnet-4-5[1m]` unchanged), so it reaches the SDK and is known on a cold process (pass 34, F34-7). Every run path first passes the stored id through `resolveRunModel`, which swaps an id `isKnownModel` rejects for the catalog default (`sonnet`) before the adapter sees it. Display: the live catalog row's name when cached, else "Claude Opus [1m]" |
| codex | `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5` (closed list, `CODEX_MODELS` in `model-catalog.server.ts`: the models the 0.160.1 CLI's bundled catalog lists as visible, in its priority order, GPT-6 Sol and Luna now among them; GPT-6.1 Sol is the CLI's own default since 0.159.1 and Viberr's (ruling 149); the default is read at each run start, so a run with no Codex model of its own uses it; whether a ChatGPT-plan account runs it is unverified, and a refusal marks it unavailable (F20-4) without moving the default) | `low medium high xhigh max` (`medium`) on every model except GPT-5.5, which stops at `xhigh`; a stored `minimal` runs as `low` (`resolveRunEffort`), never offered; a run with no effort of its own is sent `medium` rather than the CLI's per-model default, `low` on `gpt-6.1-sol` (ruling 149), where a Claude run with none is left on the SDK default; `ultra` (automatic task delegation, i.e. sub-agents — the operator's job) and `persistent` (no bundled model) are in the SDK union but neither offered nor forwarded | A model persisted for the other backend is **substituted at start and disclosed** (`substituteRunModel`, one home for the swap): the run log opens with the `run·model_substituted` line, and a cross-backend retry names the model it ran on in its timeline event and its `retry_other_backend` option (F36-8, pass 36) |

`/resources/model-catalog?backend=` serves `{ data: { models, efforts, defaultModel,
defaultEffort } }` to the profile editor (unknown backend → claude; any signed-in user, and a
signed-out request gets a 401 `{ error }`, never a login redirect, ruling 11). A load the
server never answers (a restart, a 5xx, a dead network) reaches the editor, not the page's
error boundary: the route's `clientLoader` answers null, and the editor offers its retry
(D5, ruling 11).
The route resolves the viewer's own `runCredentialFor(db, user.id, "claude")` and passes
it to the catalog; a viewer who has not connected Claude gets the curated list and no
probe is spawned, and one person's live list is never served to another (the cache entry
carries the home that produced it). The probe's CLI runs against the viewer's own
`claude-home`, where a token refresh rewrites their sign-in, so wherever the server
launches agents it runs as the viewer through the launcher like their runs (the route
passes `userId`; `spawnClaudeCodeProcess` = `spawnClaudeCli` with `agentLaunchFor`'s
launch; the home is handed back when it exits), and with no viewer to run as the curated
list is served instead (ruling 139 note (l), R-launcher-1). Each returned model is stamped with its availability
mark on every request, after the cache. A template (`agents/profiles/<id>.md`) may carry
its own default `model` and `effort` (ruling 261, pass 35 G35-2): `save_global_agent`
takes both, checked by name against the template's backend (a backend switch whose stored
model belongs to the other backend clears it and the toast says so), and a library deploy
takes the template's effort when no override is given and the backend offers that tier; a
definition-less deployment resolves the template's effort live. The org template modal has
no picker yet (follow-up). Effort is ranked `minimal 0 … max 5` (`ultra` 6, never offered)
and clamped to the backend's list at RUN time only (`resolveRunEffort`, for a tier stored
before the check existed); every write surface that takes a tier (`deploy_agent`,
`update_agent_deployment`, and the profile editor for a CHANGED value) refuses an unlisted
one by name first (ruling 261, `assertEffortForBackend`), and the editor re-seeds a stored
tier the backend no longer lists to the default rather than offering it. The re-seed reads
the SAME list the effort select renders — the selected model's own tiers when it narrows
the backend-wide list — so a tier the picker never shows is never left standing to be
saved, and picking a model with fewer tiers clamps the pick to one that model offers (the
catalog default when it is among them, else its first).

The Agents page's profile panel shows both values for every kind, the operator included
(ruling 326): a "Model · effort" cell ("Claude Opus · Maximum", the effort in the
picker's words, "default effort" when none is stored), with the operator's Autonomy as
its own cell beside it. The Live tab's Backend column names the backend an operator run
starts on (the operator profile's first backend, Claude when it names none), the rule
`resolveOperatorAuthority` applies.

**Availability marks** (`model_availability`): a model is marked unavailable only from a
real run failure whose redacted text matches `MODEL_UNSUPPORTED_RE`, and cleared by a
real success. Never a synthetic probe (ruling 149 generalised). A mark is instance-wide, not
per person.

**Quota and rate limits** (`instance_settings`): the run sink folds Claude
`rate_limit_event` envelopes, and the Codex rate-limit snapshot the adapter reads from each
rollout `token_count` event (ruling 161(c): the window closest to its limit, as
`five_hour`/`seven_day`, `rejected` at 100%, sent again only when it changes; ruling 161(b):
with every window it reported in `windows`, shortest first), and the plan windows a Claude
run's own CLI reports at `system/init` (ruling 161(a): §2.4), into
`backendRateLimit.<backend>` (read back with each listed window aged on its own reset,
ruling 161(c)); a quota-refused failure
(terminal tag ending `·quota`) records `backendQuotaExhausted.<backend>.<credentialUserId>`
when the terminal
line's `failure.windowRejected` says the provider rejected the window OR the provider's
own sentence names a spent limit (`session | weekly | monthly | usage limit`, never
transient rate-limit wording), with only the PROVIDER half of the line as its evidence and
a reset instant that is the SDK's exact `resetsAt`, a Claude `usage limit reached|<epoch>`
(exact), a `resets 11:50am (UTC)` clock resolved to the next UTC occurrence (`clock`,
retired with the prose grace), Codex "try again at Sep 18th, 2026 5:20 PM" prose resolved
in UTC (`prose`), or the time-only "try again at 6:18 PM" a five-hour Codex window refuses
with (G35-4, pass 35): the Codex CLI prints the wall clock of the process that ran it, so
the hour is resolved with the process's own local setters (never `Date.UTC`) to the next
occurrence at or after the observation, precision `clock`. Grace 24 h for prose and clock;
an undated exhaustion expires after 6 h. **The dispatch hold** (ruling 151):
`backendDispatchHold(db, backend, { credentialUserId })` is the one read a dispatch makes
before it spends anything; it stands while the stored exhaustion has not passed its reset
instant (no grace: the hold trusts the provider's instant) or, when none was named, for
`UNDATED_HOLD_MS` (30 min) after the refusal, and it reads only the record kept for the
account the dispatch would bill (ruling 151), so another person's refusal never holds it.
See §4.1. The
recovery-option builders read the same hold, so `retry_other_backend` is never offered
onto a backend already known to be spent (ruling 131). Ruling 160(a): every record
(reading, exhaustion, credential refusal) names the account it billed (`credentialUserId`,
`credentialLabel`, the run's principal under ruling 137). The reading is one latest record
per backend; the exhaustion and the credential refusal are one record per ACCOUNT, kept
under the person the run billed (`backendQuotaExhausted.<backend>.<credentialUserId>`,
`backendCredentialRefused.<backend>.<credentialUserId>`; the person stands for their account
in use, ruling 138), so one person's refusal never replaces another's, a run that billed
nobody records none, and only a run billed to the same account that completes on the
backend retires them. A read for one person (`latestBackendRateLimits(db, nowIso, userId)`:
the Profile card, the stored reset a failure's packet quotes) returns that person's records
and the reading only when it is theirs; an unscoped read (Insights, both health reads)
returns, per kind, the latest record still standing on any account. A change to the named
person's credential on that backend (a confirmed sign-in, a pasted key, a disconnect, an
account removal) retires all three records that name them, the utilization reading
included (rulings 160(b) and 161, `retireBackendRecordsFor`): a new account's window has no
relation to the old one's. A person resolving a quota or auth packet's option that states
the window has reset or the account changed (the option carries the backend) clears the
task owner's exhaustion too (ruling 131, `clearBackendQuotaExhaustion`). The principal reaches Insights
(org admin), `instance_health` (signed in) and the person's own Profile card; it is
stripped from the unauthenticated `/resources/health` body. Insights renders both; "no
reading yet" is neutral; an exhaustion yields to a later reading only from the same
account; a refused row says whose account, and a reading row names the
hour of its reset. The Profile card (`getProfileBackends` → `lastRefusal`, `usage`) shows
the viewer's OWN records only: a `risk` "refused by the provider · <when>" pill with the
provider's sentence, or a neutral "usage window spent · reopens <when>" pill, each stated
as the last refusal Viberr observed, retired by a completed run on that account or by
connecting a different account there (ruling 160(b)); and the utilization reading (ruling 161), shown only
when it names the viewer and was observed after the current connection, with its age, "not
reported" for a missing figure (never 0%), a clamped percentage, and no row on a Codex
card until one of the person's runs has made a model call (ruling 161(b)). A reading observed after an exhaustion hides the
"usage window spent" pill.

### 2.4 Claude adapter

- Query options: `permissionMode: autonomous ? "bypassPermissions" : "default"`, with
  `allowDangerouslySkipPermissions: true` beside bypass on the autonomous run only (ruling
  142: the SDK declares it required with bypass and defaults it to false; the pinned CLI
  does not enforce it yet, and one that does would drop every run to `default` and deny
  every tool), `permissionPrompts: "none"` on every run (SDK ≥ 0.3.259: nobody answers a
  prompt in a server-spawned run, so a tool the mode would ask about is denied at once
  with a reason the model can act on; binds only on the `default` seam, bypass never
  prompts), `maxTurns` (default 2000, `VIBERR_CLAUDE_MAX_TURNS`), `maxBudgetUsd` when the
  instance has a spending cap (ruling 159: Instance settings → Max spend per Claude run,
  stamped on every run by `startRun` as `RunSpec.maxSpendUsd`; none by default),
  `strictMcpConfig: true`, `settingSources: []` on EVERY run (ruling 185: no host tier and
  no project source over the checkout, so the repository under review's `.claude` and
  CLAUDE.md never reach the model), `plugins: [{ type: "local", path, skipMcpDiscovery:
  true }]` naming the run's own skill plugin (`RunSpec.skillPlugin`, §6) when granted
  skills mounted — else `[]` — with `skills: ["viberr:<name>", …]` qualified by that
  plugin's name, `disallowedTools` (binds even under bypass), `allowedTools` for the
  toolkit and mounted MCP names. `systemPrompt` follows the run's kind (rulings 170 and 170): the operator sends its prompt split as a `string[]` with the SDK's
  `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` between the static block and the per-task tail (the
  marker is left out when the tail is empty; a fresh session per turn, nothing recorded);
  the controller sends the same blocks as `{ type: "custom", prompt, snapshot: true }`,
  recorded on the session's first request and reused until compaction; a specialist sends
  `{ type: "preset", preset: "claude_code", append: <static block>,
  excludeDynamicSections: true, snapshot: true }` — the preset's working directory, git
  status and memory paths move into the first user message so every dispatch of one
  profile shares one system-prompt cache entry — and its dynamic tail opens the first user
  message under "# This run's context (Viberr, this run only)". A specialist's or
  controller's edited persona therefore reaches a RESUMED session only after its next
  compaction; for the same reason the controller's model is named in each turn's message,
  never in its recorded system prompt (ruling 255). Every list the adapter sends is in
  name order (`skills`, the `mcpServers` map, `allowedTools`, `disallowedTools`), so two
  runs of one profile hand the CLI the same bytes.
- Plan windows (ruling 161(a)). When `system/init` arrives the adapter asks its own CLI, once,
  for the data behind `/usage`: the SDK's experimental
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })`
  (no model call; the scan of local transcripts skipped), with a 20 s limit. The answer's
  windows that carry a percentage (`five_hour`, `seven_day`, `seven_day_opus`,
  `seven_day_sonnet`, `seven_day_oauth_apps`, and each per-model weekly window as
  `seven_day_<name>`) become `windows`, the percentage read as a fraction and clamped, the
  binding fields the window closest to its limit. They ride the next line's
  `facts.rateLimit`, and every later `rate_limit_event` is recorded beside them: its window
  takes the event's percentage and reset when the event has them, and a warning or a
  rejection keeps that window as the binding one with the provider's status. An SDK without
  the request, an API-key or third-party session (`rate_limits_available: false`), a failed
  request or one past the limit leaves the event readings as they came, and the run goes on.
- Context window and compaction (ruling 174). No mid-run window: every
  `AUTO_COMPACT_WINDOW` entry is null and the CLI compacts at its model's
  own limit (`startRun` would set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` from
  `context-policy.server.ts` if an entry were non-null). Instead, a run that finishes or
  errors with a session whose last prompt is above `COMPACT_AT_COMPLETION_TOKENS` (100k)
  is compacted at the END of the run, while its cache is warm. Not an interrupted run,
  not one its provider refused (ruling 174: `classifyRunEndOf` reads it as
  `failedBackendUnavailable`, and the compaction would be one more request to that
  provider on that account), and never an operator's session, which nothing resumes
  (ruling 174). The compaction's lines are never the run's failure
  (`runFailureReason` skips `run·compaction…` and `run·compacted…`): the adapter's `compact()`
  sends `/compact <COMPLETION_COMPACT_INSTRUCTIONS>` as a one-turn query that resumes the
  session, built by the same options builder as the run so it reads the run's cached
  prefix. For a `primary` or `reviewer` run it comes after the run has ended (ruling 175):
  `settleRun` finalizes the row, frees the slot and fires the completion first, so the
  report and the operator's next turn do not wait for the summary, and only a run that
  resumes that session is parked until it is written (§3.4). A controller turn's settle
  still waits for it, after the run's answered callback has put the reply on the page
  (U39-30), because the conversation's next turn resumes the same session. Either way the
  wait is bounded: after `COMPLETION_COMPACT_DEADLINE_MS` (10 minutes; Claude's request
  has no timeout of its own) the console says the compaction did not happen, its process
  is swept and the session keeps its size. Either way the
  boundary is the run's
  compaction fact with trigger `completion`, the request's cost and tokens add to the run's
  totals (`costAddUsd`, `usageAdd`) and `last_prompt_tokens` becomes the post size. The
  console reads
  `run·compacted·completion` ("context compacted at the end of the run · 111k → 9k
  tokens"), `run·compaction·request` (its cost and tokens) or `run·compaction·failed`;
  "Not enough messages to compact." is an outcome, never a failure. On a controller turn
  the phase is "Compacting context", step "at the end of the run". A specialist's row is
  terminal by then: the run service writes the same phase on it with the step "after the
  run ended" (`COMPACTING_AFTER_RUN_STEP`) and clears both when the compaction is over,
  which is how a restart and the workspace reclaim know of it (§3.4, §8). The
  compaction's child carries its
  own process marker (`compactionMarkerEnv`, `<runId>:compaction`) so the run's settle
  sweep does not kill it; the run service reaps it afterwards. An interrupted run is left
  alone. A run with a `compactAnchor` (every specialist and
  controller run) carries a `SessionStart` hook on the `compact` matcher that returns the
  anchor as `additionalContext` the moment the CLI has compacted the context — the task
  anchor (task.md path, branch, PR, knowledge bases, the rulings note) or the conversation
  anchor; every Claude run carries a `PreCompact` hook that sets the strip's phase to
  "Compacting context" for the length of the summary request. What compaction keeps: the
  system prompt (persona, knowledge-base indexes) untouched, the skills the run invoked
  (capped 5k per skill, 25k in all), up to five recent files under 5k; what it drops: tool
  results, reasoning and the un-invoked skill index. A `compact_boundary` envelope reads
  "context compacted (auto) · 972k → 10k tokens" and rides `facts.compaction` (ruling 172).
- Denylists: `BASE_DENIED_BUILTINS` (Skill, Task*, Workflow, Cron*, ScheduleWakeup,
  RemoteTrigger, Monitor, PushNotification, SendMessage, DesignSync, Enter/ExitWorktree;
  `Skill` is re-allowed when native skills are mounted; SDK 0.3.233 took `TaskCreate`/
  `TaskGet`/`TaskUpdate`/`TaskList` out of the default tool surface on Opus 4.8, Sonnet 5,
  Fable 5 and newer, and the denies stay because older models still expose them and the
  fence must not depend on the profile's model); operator and controller read-only
  (`OPERATOR_READ_ONLY_DENIED_TOOLS`) = `Bash Edit MultiEdit Write NotebookEdit`;
  supporting runs additionally lose `Bash(git push:*)`, `Bash(gh pr create:*)`, `Bash(gh
  pr merge:*)`; capability-derived denies in §4.3.
- The CLI is spawned by Viberr, not the SDK (`spawnClaudeCodeProcess` → `spawnClaudeCli`,
  `claude-spawn.server.ts`; ruling 142): `detached`, so its pid is its process group and
  the stdio MCP servers it starts share that group. Every signal the SDK sends it — its
  close ladder and its kill-all when the server exits — goes to the whole group. On a
  launched run (ruling 139) what is spawned, detached, is the launcher: the SDK's command
  resolved to an absolute path rides `VIBERR_LAUNCH_EXEC`, the principal's uid
  `VIBERR_LAUNCH_UID`, the SDK's argv passes through untouched. The launcher forks; its
  child drops to the uid, makes the agent's own process group and execs the CLI; the
  launcher relays every signal it receives (TERM, INT, HUP, QUIT, USR1) to that group,
  escalates a relayed SIGTERM to SIGKILL after 5 s, and takes **SIGUSR2 as "kill the whole
  group"** — so the server's SIGKILL of a launched group is sent as SIGUSR2
  (`launchedSignal`): a SIGKILL of the launcher alone would leave the agent's processes
  under a uid the server cannot signal. PDEATHSIG binds both ways (the launcher gets SIGTERM
  when the server dies, the agent SIGKILL when the launcher dies). The SDK
  reads only stdin and stdout from a custom spawn, so Viberr drains stderr itself, keeps
  the SDK's 2 KB tail and delivers `exit` once stderr has closed, or 200 ms after the CLI
  exits if it has not (`STDERR_DRAIN_MS`); the adapter adds that tail back onto the SDK's
  `Claude Code process exited with code N` error, which is how a resumed session the CLI
  cannot find still classifies as `session_missing`.
- MCP tool loading (Option D PR 4(a), 2026-09-11). The SDK defers MCP tools behind
  ToolSearch, so a run searches for a tool before it can call it; every stored operator
  run (16 of 16) opened with that search. The operator's `viberr` server and the
  specialists' `viberr_agent` server are created with `alwaysLoad: true` (the SDK stamps
  `anthropic/alwaysLoad` on each tool), which puts their tools in the first prompt.
  Measured in the image on `claude-opus-5[1m]`: an operator turn went from 3 model turns
  to 2 and 7-10 s to 4 s, $0.03-0.04 to $0.02 warm, for a turn-1 prompt of 12.9k tokens
  instead of 5.3k (cached after the first run; a cold first run pays the cache write
  once); a reviewer went from 4 turns to 3 at the same cost. The controller's
  `viberr_controller` (53 tools, 54 when the conversation has a knowledge base and so
  `read_knowledge_doc`) and `viberr_ops` stay deferred: loading them (at 41 tools)
  saved a turn but tripled turn 1 (6.0k to 18.0k tokens) and quadrupled a cold turn's cost
  ($0.05 to $0.21). The controller's prompt carries a tool manifest instead (ruling 255),
  each line naming the tool as it is mounted, `mcp__<server>__<name>`, which is what
  ToolSearch's `select:` takes (ruling 204, `mountedToolName`). Org MCP servers are never
  loaded up front. Pinned per server by the
  `toolLoading` tests (`test-support/mcp-tool-meta.ts`).
- Org MCP write tools (ruling 188). A run that withholds `execute-code-or-write-repo`, and
  every operator run, carries `spec.mcpToolDenials`: each mounted server's admin-marked
  write tools. `startRun` has already added `mcp__<server>__<tool>` (anything outside
  `[A-Za-z0-9_-]` becomes `_`, as the CLI names tools) to `disallowedTools`, after the
  server's `mcp__<server>` auto-approval, which a deny rule outranks. An HTTP config also
  carries `tools: [{ name, permission_policy: "always_deny" }]`, the SDK's own per-tool
  channel for remote servers. The adapter forwards both unchanged; the run's `system/init`
  tool list does not offer a marked tool (verified live 2026-09-11).
- PreToolUse capability hook (ruling 219(a), amended by Option D PR 5). A run whose
  denylist names a `Bash(<prefix>:*)` rule, and whose Bash is not denied outright, carries
  one `PreToolUse` hook on `Bash`. `bash-policy.server.ts` reads the command as a shell
  would: it ends a command at `;`, `&`, `|`, `(`, `)` and newlines (so `&&` and `||`
  too; a redirect's `&`, as in `2>&1`, does not split); unwraps leading `VAR=value`
  assignments, `{`/`}`, the pass-through wrappers (`env`, `command`, `exec`, `nohup`,
  `time`, `nice`, `xargs`, `sudo`, `doas`), `timeout <n>`, git's value options (`-C`,
  `-c`, `--git-dir`, `--work-tree` and the rest of `GIT_VALUE_OPTIONS`),
  `sh`/`bash`/`zsh`/`dash`/`ksh -c <script>`, `eval`, `$(…)` and backticks, reading a
  nested script up to 4 levels deep; and ignores quoted text (`echo "git push"` is not a
  push). A command that reaches a denied
  prefix is refused. The reason (`bashDenyReason`) names the capability the run withholds,
  read off the denylist, or says a supporting engagement never delivers, and comes back
  as the tool's result. The SDK reports a hook's decision in the tool result only, so the
  adapter writes a `system/permission_denied` frame of its own (`source: "viberr"`,
  `decision_reason_type: "hook"`), which the console shows as a rule's deny. Measured
  2026-09-11: the CLI's own rules already refused `cd . && git push` and `true; git push`
  and let `git -C . push` and `sh -c 'git push'` land. With the hook, all five were refused
  and nothing landed. The hook runs before the rules and only ever denies; the rules stay
  the fence.
- File tools of a run that posts files (ruling 217(d)). A specialist or review run with an
  attachments folder (`spec.attachmentsWritableDir`, its profile holds
  `attach-evidence-references`) whose grants deny `Edit`, `MultiEdit` and `Write` keeps
  the three: `fileWriteRoots` (`file-tool-policy.server.ts`) names the folder and the run's
  own temp directory and, on a task with no checkout (a board with no repository, ruling
  199), the run's working directory between them (`spec.scratchDir`, set fresh and on
  resume), which the workspace contract calls the task's scratch. A board with a
  repository never adds its working directory, even when the clone failed. The temp
  directory is the run's `$TMPDIR`, `<root>/<runId>` (`spec.tmpDir`, made at launch, ruling
  141(c)), never the server's shared temp directory, so it holds wherever
  `VIBERR_RUN_TMP_ROOT` points and a run writes no other run's scratch. A run whose
  directory could not be made starts without one and says so (`run·tmp_unavailable`); its
  tools, the file tools included, then use the server's shared temp directory, which is
  also what its `$TMPDIR` names. The SDK is handed the denylist
  without the three (`NotebookEdit` stays denied), and a second `PreToolUse` hook, matcher
  `Edit|MultiEdit|Write`, refuses a call whose `file_path` resolves outside every root
  (symlinks resolved, so `/tmp` and `/private/tmp` compare), naming the withheld grant,
  the folder and the scratch roots. Its refusals write the same
  `permission_denied` frame, named for the file tool. The Bash hook's reasons still read
  the grants' whole denylist, so a refused `git commit` names the repo-write grant. The
  operator and the controller never qualify. The run's disclosure takes the same
  derivation: `tools.denied` drops the three and `tools.fileWriteRoots` lists the roots,
  which the console's tools row states. It is written before the run launches, so it names
  the temp directory the run is given (`runTmpDirFor(runId)`; a resume's
  `runInputsFor(runId)` takes the resumed run's new id); a run whose directory then cannot
  be made says so on the next console line. Codex is unchanged (advisory, ruling 183).
- No auto-memory (ruling 141(b)). Every Claude run (operator, controller, specialist, and the
  completion compaction) sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (`AUTO_MEMORY_OFF_ENV`)
  over its base and per-run env. Claude Code's auto-memory keeps notes in the account
  home, outside every root a run may write, and a note one agent keeps on one task reaches
  no other; a board learns through its knowledge bases (ruling 210).
- Timers: idle timeout 15 min (`VIBERR_CLAUDE_IDLE_TIMEOUT_MS`), interrupt grace 20 s
  then abort grace 10 s. The abort SIGTERMs the CLI's group at once (the SDK's own
  SIGTERM→SIGKILL follows); what happens after the run settles is §3.4. Result grace 5 s
  (`RESULT_GRACE_MS`, ruling 155): Claude Code 2.1.292 keeps a run's stream open after
  its `result` until every command the agent backgrounded has ended, so a stream still
  open 5 s after the first `result`, a success or an error (a dev server left running,
  say), is aborted the same way, with the same 10 s backstop. The run then settles from
  the last `result` it read, as a stream that ended does: `finished` for a success, the
  cut-off line or the classified failure for an error (Success, below), never
  `run·error·idle_timeout`, and it settles once, so a stream that ends or throws after
  the backstop has settled it writes nothing more. Lines and later `result`s that arrive
  in those 5 s are read as before and do not extend the grace, and the idle timer stops
  counting once it starts. A Stop pressed inside the grace sends the cooperative
  interrupt but keeps the grace's clock instead of starting the 20 s one, and the run
  settles `interrupted`.
- No `managedSettings` and no CLAUDE.md excludes file (ruling 185):
  nothing under cwd is a settings source, so there is no ingress to close.
- Success = a `result` envelope with `!is_error`. A stream that throws AFTER a non-error
  `result` (the run's own work is done; since Claude Code 2.1.292 a backgrounded
  command's completion can wake a further turn behind it, which the result grace cuts at
  5 s) still settles `finished`, unless the last `result` it read was an error; the drop
  is recorded on its own `run·transport·after-turn` line with `ev: "meta"`, deliberately
  not an `err` line, because `runFailureReason` reads the last `err` line as the run's
  cause and this run has none (ruling 155(d)). The throw that the result grace's own abort
  causes is not a drop and writes no such line: the run settles from its last `result`
  as a stream that ended does. Failures tag `run·error·<kind>` with
  `kind ∈ quota | auth | overloaded | session_missing | unknown`; idle →
  `run·error·idle_timeout`; `error_max_turns` → `run·error·max_turns`;
  `error_max_budget_usd` → `run·error·max_budget` with a typed record carrying the cap
  (`spendCapUsd`) and the spend at cut-off (`spentUsd`, the result's cost), and a line
  saying it was cut off, not failed, and where the cap is raised (ruling 159). A stream a
  backgrounded command holds open after an error `result` keeps that class: the result
  grace stops the CLI and the run is classified from the `result`, the cut-off line
  written once (Timers, above). The SDK yields an error result and then THROWS: when the
  CLI exits non-zero after it, `readMessages` replaces the exit error with "Claude Code
  returned an error result: <text>". So a cut-off is classified from the result even when
  the stream throws afterwards (`emitCutOff`, both paths); any other error result whose
  stream throws on its own, before the result grace stops the CLI, is classified from the
  throw. Provider text follows `"\n\nThe provider reported: "`.
- Ruling 155(a) (pass 34): refusals are classified from the STRUCTURED envelope first and
  from prose second, in the order spawn codes → `session_missing` → `quota` (a
  `rate_limit_event` whose `status` is `rejected`, an assistant-envelope `error` of
  `rate_limit` or `billing_error`, `api_error_status: 429`, or the prose regex including
  `session limit | weekly limit | monthly limit | out of credits | credit balance`) →
  `auth` (`authentication_failed`, `oauth_org_not_allowed` or `account_on_hold`, status
  401/403, or the prose regex) → local network (`LOCAL_NETWORK_FAILURE_RE`, §3.5, only
  when the provider did not answer with a 5xx: kind `overloaded`, `origin: "local"`) →
  `overloaded` (a result the SDK ended on a provider-side status — `api_error_status: 529`
  or another 5xx, structural since SDK 0.3.223 — an assistant-envelope `error` of
  `overloaded` or `server_error`, or the prose regex `overloaded | at capacity |
  500/502/503/529 | temporarily unavailable | service unavailable | server error`; "at
  capacity" is an overload, ruling 155(c)) → `unknown`. A
  provider-side status is where the run ENDED, so an earlier `rate_limit` banner the SDK
  retried through does not re-route it to `quota`; a REJECTED rate-limit reading still
  does. With no prose at all (an API-refused result under `subtype: "success"`), the
  structured facts classify and no provider sentence is quoted. The terminal `err` line
  carries a typed `failure` record (`RunFailureFacts`: kind, `resetsAt`, `window`,
  `windowRejected`, `apiError`, `apiErrorStatus`, `terminalReason`, `origin` (`provider |
  local | null`), and on a `max_budget` cut-off `spendCapUsd` and `spentUsd`; the reset
  and window ride ONLY on a rejected reading) beside its tag, and every reader consumes
  that record: the failure reason, the packet builders, the controller's note, the
  Agent-logs footer for every run kind, the quota store. The provider's API-error banner,
  streamed as an assistant message with an `error` code, projects as an `err` line tagged
  `assistant·<code>` and can never be selected as the agent's reply. A rejected
  `rate_limit_event` projects as an `err` line tagged `rate_limit_event·rejected` (exempt
  from the console's telemetry collapse) naming the window, the status and the absolute
  reset. U34-1: an error result is labelled by its subtype, or `error` when the subtype is
  `success`, and every error result appends `· api <status>` and `· <terminal_reason>`
  when the SDK sent them. A `system/permission_denied` frame (SDK ≥ 0.3.223: a tool call a
  deny rule, the mode or an unanswerable prompt refused — a supporting run reaching for
  `git push`, say) projects as an `err` line tagged `permission_denied` whose `name` is
  the tool and whose text is `denied by <decision_reason_type>: <decision_reason>` (the
  SDK's rejection sentence when no reason was given), so the attempt is visible in the
  console instead of a dim meta row.

### 2.5 Codex adapter

- The CLI's `CODEX_HOME` is the run's private fork of the principal's home,
  `<codex-home>/runs/<runId>/`, with `CODEX_SQLITE_HOME` pointed at the shared home
  (ruling 145, §2.2); the adapter builds it right after the spawn env is merged and
  removes it in `settle`, the one exit every outcome takes.
- Per-run configuration, passed to the CLI as `--config key=value` overrides over the run
  home's copied `config.toml` (Viberr writes no file): `allow_login_shell: false`,
  `project_doc_max_bytes: 0`, bundled skills and skill instructions off, apps/plugins/hooks
  off, memories off, `developer_instructions` = the prompt split joined in order (ruling
  169: Codex has no boundary, so the static block and the per-task tail are one document),
  `mcp_servers` in name order with each server's withheld tools sorted and
  `default_tools_approval_mode: "approve"`, and on a specialist or controller run
  `compact_prompt = CODEX_COMPACT_PROMPT` (the shared summarizer prompt: keep the task key
  and goal, the task.md pointer, branch and PR, the knowledge-base names, decisions, failed
  attempts and why, pending work, files changed). No `model_auto_compact_token_limit` is
  written (ruling 174: the CLI compacts at its model's own limit); the operator sets
  neither. The completion compaction on Codex goes through the CLI's app-server
  (`codex-app-server.server.ts`: the vendored `codex app-server` over stdio, JSON-RPC
  `initialize`, `initialized`, `thread/resume` with the run's cwd, model and
  `compact_prompt`, `thread/compact/start`, then the `thread/compacted` notification or an
  `item/completed` compaction item; 5 min timeout), in the principal's shared home where
  the rollout lives. An `error` notification the CLI will not retry, or a `turn/completed`
  whose turn failed or was interrupted, ends the exchange at once with its message as the
  reason (ruling 174). The adapter writes only a `run·compaction·failed` line; the run
  service reads the result off the rollout and writes `run·compacted·completion` when a
  new compaction appears there. Codex keeps `developer_instructions` and recent user
  messages within a 20k budget plus the summary across a compaction and drops earlier
  assistant turns, tool calls, outputs and reasoning.
- Rollout statistics (ruling 172). The SDK's `turn.completed` is a turn TOTAL
  (on a resumed thread the thread's, ruling 165(b)), so the run's per-call prompt sizes and compactions are read off the principal's rollout
  once the CLI has exited (`codexRolloutRunStats`, `session-export.server.ts`): every
  `token_count` line from the run's start, the first one being the run's first call (the
  turn total's cached slice sums every call of the turn and says nothing about the
  start). A `context_compaction` item counts as a compaction, but the SDK streams none, so
  the rollout is the record and the sink audits each compaction at finalize. The
  CLI writes one compaction as a `compacted` line, the compaction's own size line (a
  `token_count` with a prompt of 0 and `total_tokens` = the compacted context) and a
  `ContextCompaction` item (an older CLI wrote a `context_compacted` event); a compaction
  stays open from its first marker until the next real call, so the three spellings are
  one event. The pre size is the last prompt before the marker; the post size is the size
  line, else the next real call's prompt, else NULL, which a note prints as "a summary"
  and never as 0. `compactions` is the length of that event list.
- Live usage (ruling 165(b)). A Viberr run is one Codex turn, and the SDK streams its usage
  once, on `turn.completed`, so the adapter reads the rollout while the run works
  (`codexUsageTail`, `session-export.server.ts`). The pinned CLI (0.160.1; first measured
  on 0.156.0) writes a top-level `token_usage_record` line the moment a model call
  completes, before the tool
  the call asked for runs (the `token_count` event waits for the tool's output), carrying
  the call's usage, the turn's running total and the thread's. On every SDK event the
  adapter reads the whole lines written since its last read; when a record has landed it
  puts the turn's running total on that line as the run's usage (the provider's figures,
  so `usage_final` is 1 from the first call on) and the number of records as the run's
  `turns`. A new thread's rollout is found by its id once `thread.started` names it; a
  resumed thread's is found before the CLI starts and read from its end, so the thread's
  earlier runs stay out. On `turn.completed` a new thread's figure stands, being the
  turn's total; a resumed thread's is the thread's running total, every earlier run's
  calls included, so the run stores its turn's own from the rollout and the raw line keeps
  the CLI's figure.
- `shell_environment_policy` is `inherit: "core"` with `ignore_default_excludes: false`,
  and its `set` table (written only when it has keys) re-exports at most six env keys:
  `GIT_CEILING_DIRECTORIES`, `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_NAME/EMAIL` and the
  run marker `VIBERR_RUN_ID` (ruling 142), so a command the model backgrounds carries
  it. Each stdio MCP server is declared with `env = { VIBERR_RUN_ID = <runId> }` too: the
  CLI starts a server with its own short default environment plus the declared `env`, and
  the marker is an id, not a secret, so argv is a fine place for it.
- **Sandbox mode: `danger-full-access`, always (ruling 144).** Viberr does not ask the CLI
  to confine a run. `resolveCodexSandboxMode`, `describeCodexSandbox`, the boot sandbox
  probe and its `run·unavailable` refusal, and the child-process question do not exist. The two upstream properties that decided it: bubblewrap needs an
  unprivileged user namespace Docker's default seccomp profile denies, so every confined
  run died at its first command (F36-1) unless the whole container ran
  `seccomp=unconfined`; and with the network off the CLI installs a seccomp filter that
  refuses every socket syscall (`AF_UNIX` included), so libuv's synchronous spawn reports
  `EPERM` after the child has run and no `npm` gate can complete (F36-11). What confines an
  agent is Viberr: the contract, the isolated per-engagement checkout, no credential in the
  run, server-owned delivery, revision-bound verdicts. The honest cost: a withheld
  `execute-code-or-write-repo` is ADVISORY on Codex (it is in
  `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`, and `codexRepoWriteAdvisory` tags it wherever the
  enforcement is rendered), and the operator's OS network is not forced off; it holds no
  shell tool anyway. `approvalPolicy: "never"`, `skipGitRepoCheck: true`, and withheld
  egress still sets `webSearchMode: "disabled"` (the CLI's own tool, not the sandbox).
- MCP servers are translated to `mcp_servers` and in-process SDK servers are skipped, so a
  Codex run mounts none of Viberr's own in-process tools (no `viberr_agent`, no
  `read_knowledge_doc`). A server with a stored credential arrives the same way it does
  on Claude (ruling 191, §6): as a mount on Viberr's loopback MCP gateway whose
  `Authorization: Bearer <run token>` becomes the server's `http_headers`. The run token
  sits in the CLI's `--config` argv; the credential never does, because it never leaves
  the server process.
- Ruling 188: a server's entries in `spec.mcpToolDenials` become its `disabled_tools`
  (the CLI reads it per `mcp_servers.<name>`, beside `enabled_tools`), by
  the server's own tool names. Live (2026-09-11), a withheld run listed and called only the
  unmarked tools.
- Ruling 146: every mounted server is `required = true` with `startup_timeout_sec = 60`.
  The CLI starts MCP servers in the background and gives a turn the tools of the
  servers that are ready when it starts, and a Codex run is one turn, so a server that
  started a second late was missing for the whole run without a word. A required server
  is started before the first turn, and one that cannot start ends the session before
  the model is called. The run then fails with a sentence naming the server
  (`classifyCodexFailure`), ahead of the network branch, which would otherwise read its
  transport error as this deployment failing to reach Codex. The exception is
  `spec.mcpOptional`: servers mounted although their last probe failed (the run's
  `unhealthy` disclosure, which the prompt names as possibly unavailable). They stay
  optional, so a server the run was told may be missing cannot stop it.
- No `maxTurns` and no budget option: the instance's spending cap (ruling 159) does not
  bind a Codex run, and its run-inputs disclosure says so ("Codex has no budget option:
  this run is bounded by its idle timer only"). Idle 15 min
  (`VIBERR_CODEX_IDLE_TIMEOUT_MS`), counted from the later of the last stream event and
  the last write to the run's rollout (ruling 158(a)): the CLI streams no event for a
  reasoning step whose summary is empty, and writes every one to the rollout, so a model
  reasoning for many minutes in one call is working, not hung. The rollout is read through
  the ruling 165(b) tail (`lastWriteMs`); a run with no shared home is watched on its stream
  alone. Interrupt settle 20 s. The SDK spawns the CLI itself
  with a plain `spawn()` and only ever SIGTERMs it, so the settle sweep (§3.4) is what
  reaches a CLI that outlived its abort and everything its shell started.
- **As the principal's own OS user (ruling 139).** On a launched run the SDK is given
  `codexPathOverride: <viberr-launch>` and the run's env plus `VIBERR_LAUNCH_EXEC` = the
  SDK's own vendored binary (`codexVendor()`, `codex-app-server.server.ts`, the one resolver
  the compaction also reads) and `VIBERR_LAUNCH_UID`; the SDK spawns the launcher with the
  argv it builds, and the launcher execs the CLI as the uid. The SDK prepends its helper
  directory (`codex-path/`, which holds `rg`) to `PATH` only when it resolves the binary
  itself, so the adapter prepends it for the override. The launcher leads no group the
  server shares (the SDK's spawn is not detached): its CHILD makes the agent's group, and
  the SDK's SIGTERM reaches the launcher, which relays it. Ruling 142's decision D1 (a
  wrapper pointed at by `codexPathOverride`) was replaced by the sweep; the launcher is not
  that wrapper — it confines nothing about the run and exists to change its user. The
  completion compaction's `codex app-server` is launched the same way, in the shared home.
- Success requires a `turn.completed` with no top-level `turn.failed`/`error`; item-level
  errors are non-fatal. Ruling 155(d): the adapter tracks whether anything started after the
  last completed turn (`turn.started` / `item.started` set it, `turn.completed` clears
  it), and a throw or a fatal event that lands behind a completed turn with nothing in
  flight settles `finished`, recorded on a `run·transport·after-turn` meta line (live, the
  socket died under Viberr's own completion compaction and two finished deliveries were
  written up as failures). A failure is an `err` line tagged `error·<kind>` (`kind ∈ quota |
  auth | overloaded | idle_timeout | session_missing | unknown`, and the service's own
  `run·error·tool_loop`, ruling 158(b)) carrying the typed
  `failure` record.
  Classification runs the session classes first, both `session_missing` with their own
  sentence: a session store the CLI cannot open (`SESSION_STORE_UNREADABLE_RE`, ruling
  162) and a torn rollout that "does not start with session metadata"
  (`SESSION_DAMAGED_RE`, ruling 162); then a missing session (`SESSION_MISSING_RE`); then
  a required MCP server that did not start (ruling 146: `unknown`, with a sentence naming
  the server); then quota and auth; then the local-network arm
  (`LOCAL_NETWORK_FAILURE_RE`, skipped when the text carries a 5xx code; kind
  `overloaded`, `origin: "local"`); then `overloaded`, which is prose-only here (Codex
  streams no status): `overloaded | at capacity | 500/502/503/529 | temporarily
  unavailable | service unavailable | server error`. "At capacity" (ruling 155(c)) is the
  CLI's "Selected model is at capacity", which also ends a run when it hits the CLI's own
  context compaction.
- Structured output: when a specialist has a verdict, ask or evidence grant, the run
  carries `outputSchema = AGENT_OUTCOME_JSON_SCHEMA` and the envelope replaces the tool
  calls a Claude specialist would make. The SDK writes the schema into a directory of
  its own (0700, the server's), so behind the launcher the adapter shares that file for
  the agent group to read before the CLI starts (`shareOutputSchemaWithAgent`,
  `shareFileForAgentsToRead`, ruling 145). Its `evidence` items require `label`, `result`
  (nullable) and `status` (`pass`, `fail` or `info`, ruling 16). Its `relay` field (ruling 202, required and
  nullable like the rest) is the Codex half of `report_outcome`'s: every entry is parsed
  and kept, a garbled one costs only itself, and the cap of two is applied where the
  entries are posted, with the rest named, because an envelope is the agent's last word. The Codex operator returns a plan the server
  executes ([operator.md §5](operator.md#5-tools-and-the-governed-actions-behind-them)).
- A knowledge-base correction (ruling 210): a Codex specialist with a knowledge
  base files it with `correct_knowledge_doc` on the gateway's `viberr_knowledge` server
  (ruling 216), and its Collaboration section names that tool as a Claude run's does. Only
  when the gateway is not running does it have no such tool, and then its prompt's
  Collaboration section (`KB_CORRECTION_NOTE_CODEX`) tells it to end its report with a
  `Knowledge-base correction` section naming the knowledge base, the document, the passage exactly as the
  document has it, what it should say instead and the evidence, and the operator's
  `agent-reply` turn writes it with its own `correct_knowledge_doc`. A Claude specialist's
  note (`KB_CORRECTION_NOTE_CLAUDE`) names the tool instead.
- The board (ruling 216): a Codex specialist that holds any collaboration grant
  (`holdsCollaborationGrant`, the gate a Claude toolkit builds `read_board` on) mounts
  `viberr_board`, a second server the gateway answers itself over the run's token
  (`board-tool.server.ts`), fresh and resumed. It has `read_board`,
  `read_timeline_entry`, `read_task_attachment` (ruling 214) and `read_task_source`
  (ruling 82), the same readers and
  descriptions as Claude's toolkit, over the run's own project and task; each refuses an
  argument it does not declare, as its Claude twin does (ruling 136), and the refusal names every
  argument by what it takes (ruling 216); the mount carries only the store, and the run is handed the
  URL and its token. On a server that can render a page it also lists `capture_page`,
  `measure_page` and, for a run whose mount carries the browser grant, `keep_page_look`
  (rulings 194, 328 and 327, §4.2); `capture_page` is answered with the text and one image block per width (one block for a picture of an exact size). Whether the
  Codex CLI hands an image block in a tool result to the model is not established (the
  browser mount leaves them out on Codex for the same reason), so the text names where
  each picture was saved in the run's scratch folder, which the run opens with its own
  image viewer. A profile with no collaboration grant mounts nothing, and neither
  does a run when the gateway is not running. Ruling 82: for a run that may save files
  on its task (`attach-evidence-references`) the mount also carries the agent a source is
  kept as and the run's web grant (`sources: { agent, web }`), and the server then lists
  `keep_source`, described for what the run can reach, and answers it with the run's own
  id on the record; a run without the grant is not offered it, and a call to it is
  answered as a call to any tool the server does not have. While the gateway is not
  running a Codex run has no `keep_source`, and its prompt says it cannot keep a source
  and why. The run-level suite reads the dispatched run's own mount and the resumed one,
  so what a run is told and what it is offered cannot part.

## 3. A run's life

### 3.1 Persistence

- `agent_runs`: `id, task_key, project_slug, thread_id, role, kind, backend, model,
  session_id, sdk, state (queued|running|finished|error|interrupted), phase, step,
  started_at, finished_at, turns, input_tokens, cached_input_tokens, output_tokens,
  usage_final, total_cost_usd, interrupted_by, agent_name, agent_profile_id, outcome_key,
  dispatched_by_name, dispatched_by_user_id, no_checkout, verdict_withheld, review_subject,
  credential_user_id, interrupted_reason, created_at, updated_at`, and the prompt-cache
  record (ruling 172):
  `cache_write_tokens, first_call_prompt_tokens, first_call_cache_write,
  first_call_cache_read, first_call_warm, first_call_miss_reason, cache_ttl_bucket,
  peak_prompt_tokens, last_prompt_tokens, compactions, credential_kind`. `interrupted_by`
  is the person who stopped the run (a `users.id`) or null; `interrupted_reason`
  (`restart` or null) says why an `interrupted` run stopped when nobody did (ruling 153
  addendum, pass 35 U35-7). `outcome_key`, `dispatched_by_*`, `no_checkout` and
  `verdict_withheld` are persisted for the completion pipeline because boot recovery must
  re-supply them after a restart: the staged outcome, who dispatched the run (its cc-tag),
  that the run's checkout failed so it records no verdict (ruling 87), and that the
  dispatch withheld the verdict channel so it records none either, from its envelope or
  the prose fallback (rulings 87, 66). `review_subject` is what the run was dispatched to judge (ruling
  153): its verdict binds only if the task still has that subject when it completes.
- **The prompt-cache record** (ruling 172) is folded by the sink from the provider's own
  figures: `cache_write_tokens` sums every call's cache write (Claude
  `cache_creation_input_tokens`; Codex `cache_write_input_tokens`, 0 on every run this
  backend has stored); the `first_call_*` columns are the run's FIRST model call — its
  whole prompt, its write and read slices, `first_call_warm` = 1 when it read more than it
  wrote (`startTemperature`, one rule in `context-policy.server.ts`), and the provider's
  `cache_miss_reason` when it sent one (`previous_message_not_found`, `unavailable`,
  `messages_changed`); they are NULL until a call lands and NULL for ever on a run that
  never reached the provider, which no surface prints as "cold". `cache_ttl_bucket` is
  which lifetime the provider billed the writes under (`5m`, `1h`, `mixed`; NULL on
  Codex). `peak_prompt_tokens` is the largest prompt any one call carried and
  `last_prompt_tokens` the last call's — the size a resume replays, which ruling 173
  reads; on Claude both fold from the stream (main-loop calls only), on Codex from the
  rollout at finalize, where the rollout's first `token_count` also replaces the streamed
  turn total as the first call (miss reason NULL). `compactions` counts
  `compact_boundary` envelopes and Codex compaction events (§2.5); a completion
  compaction's own cost and tokens add to the run's totals (ruling 174). A Claude
  result reports its SESSION's running totals (the CLI restores a session's cost state
  on resume), so the adapter records each run's and each compaction's share: what the
  report adds to the totals that session last reported, model by model
  (`sessionShareOf`, `reportedBySession`, ruling 165(c)). After a restart the
  adapter's memory is empty, so `startRun` reads the newest `result` line the session's
  earlier runs logged (`lastSessionResultRaw`) and hands it over as
  `resumedSessionReported` (ruling 165(c)). A resumed run's spending cap is raised by what its
  session had already spent only when the CLI will restore that spend: the session ran last
  where this run works, under the same account (`costStateRestored`, ruling 159).
  `credential_kind` is the kind of credential the run billed at start (`login`,
  `api_key`, `access_token`), which decides the TTL ruling 173 assumes; NULL on a refused
  run. A Codex run's usage is its turn's total over its calls. On a resumed thread the
  pinned CLI's `turn.completed.usage` is the thread's running total, so the run takes its
  own off the rollout (ruling 165(b); ruling 172 had measured the turn's on older runs).
- **Token columns mean the same thing on both backends.** `input_tokens` is the total
  input the provider processed for the run, cache reads and cache writes included: Codex
  `usage.input_tokens` verbatim (its cache figures are subsets of it); Claude Σ over
  `result.modelUsage` of `inputTokens + cacheCreationInputTokens + cacheReadInputTokens`
  (ruling 159), normalized in `wire-format.server.ts` (Claude reports the three as
  disjoint figures, and the uncached slice alone is two tokens per call). `modelUsage`
  covers every call the query made — the main loop, subagents, sidechains, compaction —
  per model; `result.usage` (the same sum over the main loop only) and `total_cost_usd`
  are the fallback for a result whose `modelUsage` is absent, empty or zeroed (an older
  CLI, a crash result). The cost column is Σ `costUSD` on the same basis, and the result
  line keeps the per-model breakdown in its `stats.models` (and says "N models" when more
  than one ran); there is no per-model column. `cached_input_tokens` is the subset of
  `input_tokens` served from the prompt cache (Codex `cached_input_tokens`, Claude
  `cache_read_input_tokens`) and is never larger than `input_tokens`. `output_tokens` is
  the provider's figure. `turns` is Claude's `result.num_turns` (one plus the `user`-type
  messages that flowed through the SDK loop, so every tool result counts) and, on Codex,
  the model calls the run made, counted as their rollout records land (ruling 165(b)). The strip's **Tokens** is `input_tokens + output_tokens`:
  total tokens processed. During a Claude run the row holds the adapter's live figure:
  each API message's whole prompt summed once per `message.id` (exact; it reproduced
  `result.usage` on every stored run) and an **estimate** of the output from the streamed
  content (text, thinking and tool-call input at about four characters per token, summed
  per envelope), because the SDK's per-envelope `output_tokens` is the `message_start`
  placeholder of a few tokens (F35-1: a twelve-minute Opus run writing 20k characters read
  "49 tokens" until its result said 54,759). The prompt figures fold by max; the estimate
  folds by max while it is an estimate and is **replaced** by the provider's figure when
  one lands (a Claude `result`; on Codex each model call's record, from the first call
  on, ruling 165(b)), which also sets `usage_final = 1`. While `usage_final` is 0 the row is not a total: the Live run panel prints it as
  `~n` with a tooltip, a Codex run before its first model call completes prints
  "pending", and Insights leaves the row out of its token sums. An errored result carrying an empty usage reports
  nothing and leaves the estimate and the flag alone. Ending does not settle the question:
  a run somebody stopped, and one that errored before the provider replied, keep
  `usage_final = 0` for good, so the panel keeps the `~` on them and the Insights card
  names them ("N of M runs report no provider token total") instead of quietly
  understating its sums. A Codex run stopped or failed after a model call completed keeps
  the provider's figures for the calls it made, `usage_final = 1` (ruling 165(b)). Adding the column to a root that predates it heals the rows it
  already holds: a `finished` row's token columns were the provider's own figures before
  the estimate existed, so the boot healer stamps those 1; a stopped or errored row held
  the old placeholder and stays 0. Claude rows written before this normalization hold the
  uncached slice only, and older rows folded `result.usage` (main loop
  only), so a run that delegated to subagents or compacted stored fewer tokens than it
  processed; Insights sums the rows as stored.
- `credential_user_id` (ruling 137) is the run's **credential principal**: whose account
  it billed. It is written on the reserved row and on the started row, carried in the
  `runtime.run.started` audit, and read back by the transcript locator and the run
  projection. It is NULL only on a run that was refused before any credential was looked
  up — an unowned task, or one whose owner account is gone or disabled. A run refused
  because the owner has not connected THAT backend still records the owner
  (`refusedPrincipalUserId`), so the refusal is auditable rather than anonymous.
- `run_log_lines`: `id`, `run_id`, `seq` (`(run_id, seq)` unique), `occurred_at`,
  `raw_json`, `display_json`, `created_at`. Viberr's own `run·inputs` disclosure is seq 0
  (§3.7), and an insert is `ON CONFLICT DO NOTHING`.
- Raw NDJSON, the truth: `<dataRoot>/runtimes/<backend>/<runId>.jsonl` (always the run
  id, never the session id).
- Unique indexes: `idx_agent_runs__thread` (project, task, thread id) and the two
  single-flight ones, `idx_agent_runs__one_delivering` (one queued/running `primary` per
  task) and `idx_agent_runs__one_live_per_support` (one per task and profile among
  `reviewer` rows); the latter is re-created at every DB open for older roots. A
  single-flight hit becomes a 409 naming the kind of run that is already live (delivering
  or supporting).
- `staged_outcomes(outcome_key)` holds a specialist's first `report_outcome` until
  completion consumes it once (24 h TTL, in-memory cap 500); a later call in the same run
  changes nothing (§4.2).

### 3.2 Reservation and admission

`reserveRun` writes a `running` row with a phase before the clone starts, or declines
when the instance cap is exhausted; `assertRunReservationLive` re-checks after the
clone. `startRun` audits `runtime.run.started` (with `failedUnavailable` and, on a
continuity reset, `continuityReset`), substitutes foreign-backend models
(`substituteRunModel`; the run log opens with the swap, the row stores what ran), stamps
the instance spending cap (`maxSpendUsd`, ruling 159), `credential_kind` and
`verdict_withheld`, fails unavailable backends, and otherwise `launch`es a reserved row or
`admitRun`s into a `pending` queue drained on every completion. It returns `{ runId,
outcome, refusal }` with `outcome ∈ started | queued | refused` (ruling 152), and
`admitRun` says whether it launched or parked, so every door that reports a dispatch says
which of the three happened; a refusal quotes the run's own sentence. A queued run that
later gets a slot writes a "Run started" note on its task ("The queued … run … got a slot
and started. It is streaming to the agent logs.", `noteRunStarted`, ruling 166). The cap
is the instance setting `maxConcurrentRuns` (0 = unlimited, ceiling 64, Instance settings
→ set-concurrency).

**The coordination lane (ruling 150, pass 35).** A positive cap carries a lane of
`coordinationLane(cap) = max(1, ceil(cap / 4))` extra slots for `operator` and
`controller` runs, so a decision never queues behind the builds it is deciding about
(live, fourteen operator turns waited ten minutes behind six four-minute builds). The
instance holds at most `cap + lane` runs in all and at most `cap` DELIVERY runs
(`primary`, `reviewer`) among them: a live operator turn never costs a build its slot,
and an operator turn may borrow a cap slot no build is using. The lane's own slots are
unconditional; past them a coordination turn takes a slot only while the delivery queue
is empty, so a freed slot returns to a parked build once coordination holds its whole
lane (otherwise the coordination bound contains the delivery one and a backlog of turns
starves the cap's own runs). `reserveRun` and
`admitRun` both apply the rule by the run's kind; the pending queue is one FIFO per
lane and `drainRunQueue` promotes the coordination queue first. Every held slot
(`handles`, `reserved`) carries its lane, so the two counts are read from the slots
themselves, never from a counter. `runConcurrencySnapshot` is `{cap, lane, live,
queued}` (`live` and `queued` count both lanes). Cap 0 has no lane.
Thread ids are minted by the callers: `op-<8>` (operator), `primary-<8>` and
`r<idx>-<8>` (specialists); a controller run uses the default `controller`
(`DEFAULT_THREAD` is `op | primary | r0 | controller` by kind).

### 3.3 Streaming

Adapter callbacks → `createRunSink` per line: fold facts → record rate limit → **redact**
(`createLineRedactor`: the value, 12 chars or longer, of every server env var whose NAME
matches `CREDENTIAL_ENV_RE`, the run's own credential (`secrets`, ruling 137), plus
`TOKEN_PATTERN_SOURCE`) → record quota exhaustion (a `·quota` line) or a credential
refusal (a `·auth` line) → append raw NDJSON (the directory is created only when the
append finds it missing) → insert `run_log_lines` (display only; the next `seq` is taken
inside the INSERT) → patch run facts, only when a folded value moved since the last patch,
in the same transaction as the line → publish `run.log-appended {runId, seq}` (reference
only). A line with no facts is therefore one statement and one commit, and
`agent_runs.updated_at` moves with the facts, not with every line (ruling 11). The sink also
writes the compaction audit row (`task.agent.compaction`); a compaction
leaves no note on the task timeline (ruling 172). The `wire-format` projector maps
provider envelopes to display lines with `ev ∈ init | text | tool | out | err | result |
think | meta | diff`. The `step` column (at most 120 characters, `STEP_MAX`) names the
tool being invoked and, once its result lands, reads `composing · <tool> · <input>
answered` (ruling 166, `answeredStep`/`stepUpdateForLine` in `adapter.server.ts`, from
Claude's `tool_result` row, Codex's completed command output, or a `toolAnswered` fact on
a succeeding Codex MCP call). Phases (`RUN_PHASE`) are stored as their display strings:
"Preparing workspace", "Starting", "Working", "Compacting context" (ruling 170),
"Finishing". Phase and step updates are throttled to 1 s; a step suppressed inside the
window is written when it closes, never onto a settled row.

Consumers: `GET /resources/run-log?runId=&since=|before=&limit=` (1..500, member-gated;
controller runs by conversation ownership; a signed-out request gets a 401 `{ error }`,
never a login redirect, ruling 11) returns `{ runId, threadId, state, lines,
headSeq, oldestSeq, hasMore, facts }`, `facts` being the run row's `RunLiveFacts` (phase,
step, turns, tokens, the cache record; ruling 11, one mapping with the task loader's
`RunView`, `runLiveFacts`); `raw=0` leaves each line's stored envelope out, and
`window=1` answers the run's agent group's console window instead (`RunLogWindowPage`:
display lines, their `consoleLineKey`s, the window facts and the representative's facts),
the window a hard refresh ships for the shown agent. The task loader carries console lines
on a document load only (owner decision 2, 2026-09-24): the shown agent's display lines,
the envelopes when the raw view opens; a `.data` request carries each group's window
facts and none of its lines (`ConsoleShipping` in `run-projection.server.ts`), plus
`sessionMissing` for a continuity marker inside the window (the Continuity Recovery
Panel's input) and the failure class, read from the representative's own newest lines
(`classifyRunEndOf`, shared with the review-round counter, ruling 92). The client
`useRunLogStream` holds the console's lines in an external store (`run-log-store.ts`),
takes its frames from the layout's live stream (`onLiveFrame`, no `EventSource` of its
own), fetches since the thread's cursor on each reference, fills a thread the payload did
not carry with one `window=1` request when the console shows it, pages backwards 200
lines at a time, and revalidates every 20 s while a run is active and the tab's live
stream is down (F22; with the stream up the terminal event arrives or is replayed,
ruling 11). Its controller channel
(`source: { kind: "controller", conversationId }`) tails `controller.log-appended` frames
for the open conversation only, off the `user` stream the page holds: a controller run
has no task scope, so the sink resolves the conversation owner once per run
(`controllerRunRoute`) and both publishers route there (lines as
`controller.log-appended`, state changes as the `controller.updated` reference).

### 3.4 Interrupt and completion

`interruptRun` needs `run-agents` (admin or maintainer, or an org admin) for a task run,
checked with `archived: false` on purpose so a run on an archived project can still be
stopped, and for a controller run `canInterruptControllerRun` (the conversation's owner
or a live org admin; anyone else gets the 404 shape). An already-terminal run, or a second
click while the first interrupt is landing, answers `already-terminal` and writes nothing.
A live handle gets `handle.interrupt()` and `interruptedBy`; a dead one is patched to
`interrupted`, its slot released, and the run's registered completion callback fired from
that arm (there is no adapter exit to fire it otherwise); audit
`runtime.run.interrupted`. The timeline note says the thread stays resumable only when a
session exists, and otherwise that there is no thread to resume and a re-run starts fresh
(ruling 154). Closing a task (acceptance, force-accept, archive) interrupts its live
runs through `interruptRunOnClosure` under the system actor, audited with `reason:
"task-closed"` (ruling 154).

When the adapter exits, `launch`'s `settleRun` runs the sink's `finalize`, releases the
slot, drains the pending queue and fires the registered completion callback. A completion
compaction that is due (§2.4, ruling 174) runs after all of that for a `primary` or
`reviewer` run (ruling 175), as the session's housekeeping. The session id is kept in the
run service's `settling` map from before the queue is drained until the compaction is
over, whatever it answered, and the finished row carries the phase "Compacting context"
with the step "after the run ended" for the same stretch. A run that resumes that session
meanwhile (a comment or an answer to that agent) is parked by `admitRun` in its lane's
queue, whatever the cap says: its row is `queued` with the step "waiting for the summary
of its last run" (`SESSION_SETTLING_STEP`, which the console's footer and the title of the
task page's "Agent queued" print, ruling 166), the drain passes it over, and when the
compaction is over it takes its turn under the cap like any
other, unless it was stopped while it waited. Its start is noted on the task as a wait for
the summary, not for a slot. `resumeRun` does not read ruling 173's verdict for a session
that is settling. The run's gateway token, skill plugin and temporary directory go when
the compaction is over. The compaction itself holds no slot, and the workspace reclaim
counts its run as still holding the folder (`activeRunCount`). On a controller turn the
compaction still runs before the finalize, and an operator's session is never compacted.
`finalize` lets the first
terminal writer win (only that writer stamps `finishedAt`) and, on `finished`, clears the
quota-exhaustion and credential-refusal records of the account the run billed on that
backend, and nobody else's (ruling 160(a)). A callback that throws goes
through `noteCompletionEffectsLost`: waiting flips to human, a `continuity` timeline event
is written and a `run.completion.effects_lost` audit row lets boot recovery replay the
effects (§8).

**A settled run leaves no live process (ruling 142).** Neither vendor CLI keeps its
children in one group: Claude Code starts every Bash command in a session of its own, so
a `sleep 600 &` a finished command left behind, or the command a SIGKILLed CLI was still
running, belongs to no group Viberr can name (measured on the pinned CLI, 2026-09-11: the
`&` survived a normal finish, and both survived a SIGKILL; a SIGTERMed CLI does clean up
the command it is running). So once a run settles, on every outcome, the adapter sweeps:
Claude waits (at most 5 s) for the CLI's own exit, then `reapRunProcesses`
(`run-processes.server.ts`) SIGTERMs the CLI's group and every process of this user whose
environment carries the run's `VIBERR_RUN_ID`, waits 5 s, re-scans, and SIGKILLs what is
still there. The scan reads `/proc/<pid>/environ` on Linux (the image) and `ps -E` on a
macOS development host; the re-scan means a pid the kernel recycled in the grace is never
signalled. Codex sweeps the same way without the group, since its SDK owns the spawn. It
is cleanup, not containment: a process that clears its own environment escapes it, and
the container plus the server-owned delivery gate stay the boundary (ruling 144). The log
line is `reaped the processes a settled run left behind`, with the counts.

On a launched run (ruling 139) the processes are another user's: the server can neither
read their `/proc/<pid>/environ` nor signal them. So the sweep also asks the launcher —
`viberr-launch --reap TERM <runId>…`, then after the grace `--reap KILL <runId>…` — which,
as root, signals every process whose uid is in the agent range and whose environment
carries one of the markers (root borrows the process's filesystem ids for the one
`environ` read: the container holds no `CAP_SYS_PTRACE`; a pidfd pins each process so a
recycled pid is never signalled). The group signal goes to the launcher, which relays it;
its hard kill is SIGUSR2 (`ReapTargets.launched`). When the agent exits on its own, the
launcher SIGTERMs whatever is still in the agent's group before it exits. The boot sweep
of restart-orphaned runs (§8) goes through the same `--reap`.

### 3.5 Failure kinds

`RunFailureKind = quota | auth | unavailable | overloaded | max_turns | max_budget |
idle_timeout | tool_loop | session_missing | unknown` (`app/shared/run-failure.ts`), read from the
terminal line's typed `failure` record first, the tag suffix second and regexes last
(ruling 155(a)). How a run ENDED (finished, a provider refusal, a crash) is one
classification, `classifyRunEnd` (`provider-refusal.server.ts`), read by the run card and
by the review-round count, where a deliverer run the provider refused (quota, auth, no
credential, overload) fights no round (ruling 92). A drop after a completed turn is not a
failure at all: the run settles `finished` with a `run·transport·after-turn` meta line
(ruling 155(d), §2.4, §2.5). `runFailureReason` returns the record as `facts`, and never
reads the completion compaction's lines as the failure (ruling 174);
`projectRunsForTask` sets `failureKind` on every errored run's view (operator runs
included) and flags `failedBackendUnavailable` from the class before the raw scan; the
controller's turn note (ruling 156(a)) names a quota window's reset and the account
switch, or an auth refusal's organization restriction, instead of "Say it again to retry",
which stays only for an unclassified failure.

`max_budget` (ruling 159) is a cut-off like `max_turns`: the instance's spending cap, not
the task, ended a Claude run. Its record carries the cap and the spend; the specialist's
blocked event reads "the Claude run reached the instance's spending cap of $X after
spending $Y and was CUT OFF mid-work, which is not a task failure" and says no "No changes
were delivered"; the remedy (operator and specialist alike, `describeRunFailure`) is to
re-run it or have an org admin raise the cap in Instance settings; the operator's options are
the ordinary re-run set, never another-backend retry; the pill reads `cut off · spending
cap`; the controller's turn note names the cap and the spend.

`overloaded` is the provider's side, not the account's: the Claude adapter reads it from
`api_error_status: 529`/5xx or the `overloaded` / `server_error` banner codes, the Codex
adapter from the same prose signatures the raw scan uses. Its remedy is a retry — the same
backend once the provider recovers, or the other one now (`retry_other_backend` when the
owner has it connected) — never Profile → Agent accounts; the same-backend option asserts
only that nothing was changed. The footer reads "could not serve this run: the provider
was overloaded or failed on its side", the pill `provider overloaded`, the controller's
note "Say it again in a few minutes", and the projection counts it as the backend being
unavailable (the retry offer).

U35-11 (pass 35): the record carries `origin`. `provider` is the case above. `local` is a
connection that failed BEFORE the provider answered, inside the deployment's own
environment: the Claude CLI reports a TLS verification error, DNS or a refused socket as
"API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)" under the
same `server_error` banner with no HTTP status, and both adapters read the shared
`LOCAL_NETWORK_FAILURE_RE` (`app/shared/run-failure.ts`) for it; a run the provider did
answer with a 5xx is never local. The pattern also carries the Codex CLI's own Rust
transport prose (`failed to lookup address information`, `name does not resolve`, `peer
closed connection`, `close_notify`, `error sending request`, `waiting for network`,
`request timed out`, `reconnecting`; rulings 155 and 155(c)). Same class, same retry,
its own attribution: the adapter's line reads "could not be reached from this deployment:
the connection failed before the provider answered (<code>)", `describeRunFailure` names
"this deployment's network path (TLS, DNS or a proxy)", the same-backend option says "this
deployment could not reach the provider", the footer "could not be reached from this
deployment", the pill `provider unreachable`, the controller's note "could not be reached
from this deployment"; `RunView.failureOrigin` carries it to the client.

`session_missing` has two roads, told apart by one marker constant
(`SESSION_STORE_UNREADABLE_MARK`, ruling 162): a vanished session heals on the next fresh
run, while a provider session store that cannot be opened keeps failing every resume until
the file is repaired or removed, and the reason says which.

The completion pipeline writes the `blocked` event, marks model availability, opens the
stuck-loop packet and clears waiting to human. For `quota`, `auth` and `overloaded` the
event, the packet body and the controller's note are worded by ONE module,
`app/server/tasks/run-failure-remedy.server.ts` (`describeRunFailure`, ruling 156(a)): the
reason names the backend, the owner, the spent window and the reset instant (absolute UTC)
or the organization restriction; the remedy is the owner's own move on Profile → Agent
accounts. The packet's options come from the same module for `quota | auth | unavailable |
overloaded`, in this order: `wait_for_window` first and recommended when the failure is
`quota` and its reset instant is known and still ahead (ruling 157: it closes the packet,
settles the board to `waiting: human` and schedules a `run-operator` one minute past the
instant; the instant is read from the quota store too, because a Codex refusal at spawn
sends no machine reset); `retry_other_backend` only when the **task owner** has the other
backend connected (ruling 137) and it is not itself held for quota (ruling 131),
recommended unless waiting is on offer or the fault was this deployment's own network
(ruling 156: offered then, never recommended, and it says why); a `request_edit` that
sends the agent back once the window has reset or the account changed (for `overloaded`, a
same-backend retry); `redirect`, never recommended for a backend failure (the agent did
nothing wrong); `hold_runtime_debug` closes the set. `unavailable` keeps ruling 137's
refusal sentence as its reason. A failed OPERATOR run's packet
(`escalateFailedOperatorRun`) uses the same module: on `quota` its recommended option is
`wait_for_window` when the reset is known and ahead, else `block_on_policy`, which asserts
only what the human says and records exactly that in its `ev`, never "policy / credential
updated" (ruling 62). A reason clause is terminated exactly once.

### 3.6 Resume, continuity, export

- `resumeRun` (the @mention resume and a person's answer to an agent's question, via
  `task-comments.server.ts`, and every controller turn after the first) mints `thread_id =
  prev + "-r" + 6 chars` and probes the provider session with `probeSessionContinuity`
  (`present | missing | damaged | unknown`; `SESSION_MISSING_RE` reads "no conversation
  found", "rollout not found" …). A located Codex rollout whose first line is not
  `session_meta` (an empty file or a head that is not JSON) answers `damaged` (ruling 162;
  a file it cannot read resumes as before). A missing or damaged session records
  `run·session_missing` on the dead run so it is never selected again, writes a
  `continuity` timeline event (actor `runtime-continuity`) that says whether the
  transcript is gone or damaged, and starts a fresh run whose prompt carries a
  continuity-reset preamble anchored on `task.md`. The loss reasons are `transcript_gone`,
  `transcript_damaged`, `owner_changed` and `stale_large_session`. Boot recovery does not
  resume sessions: it finalizes orphaned runs and re-invokes the operator (§8).
- The resumed turn bills the task owner **as of now**: `resumeRun` re-resolves nothing,
  the caller passes `credentialUserId` (ruling 137). A task whose owner changed since the
  original run takes the continuity-reset path above under `owner_changed`: one fresh run
  re-anchored on `task.md`, with the timeline saying continuity was reset because the
  session belongs to the account that held the seat before, and that the transcript is not
  missing (ruling 162). The alternative would be resuming one person's conversation
  inside another person's account. `resumeRun` decides that from the CHANGE (the passed
  principal against the prior run's `credential_user_id`), not from the probe:
  `probeSessionContinuity` looks only in the passed principal's home, and a home with no
  transcript store yet — a new owner who has connected the backend but never had a run
  here — answers `unknown`, which means "resume as before".
- **The resume policy** (ruling 173): after the probe says the session is present,
  `resumeRun` takes `resumeVerdict` (`context-policy.server.ts`) on how long the prior run
  has been finished (against the caller's `nowIso`; the service reads its clock once, the
  tests pin it), the cache TTL for the prior run's `credential_kind` (Claude: 60 min on a
  sign-in, 5 min on an API key or access token; Codex: 10 min; a row with no kind reads as
  a sign-in) and the size a resume would REPLAY — the prior run's `last_prompt_tokens`,
  else the provider's own transcript (`sessionContextTokens`: Claude's last main-loop
  assistant usage, Codex's rollout's last `token_count`). When the session is BOTH idle past
  its TTL AND above 150k tokens (`RESUME_FRESH_CONTEXT_TOKENS`), it is never replayed: the
  continuity-reset path runs under the reason `stale_large_session` — the prior run gets a
  `meta` line tagged `run·session_stale` (not `·session_missing`: the transcript is intact,
  and `latestSessionRun` must not skip the row), the task timeline a `continuity` event
  ("Started a fresh session: the previous one was 298k tokens and 1 hour 14 minutes old…"),
  the fresh turn's prompt a preamble that says the session was set aside on purpose and
  carries the prior run's last report (its newest agent-text line, clipped to 6,000
  characters) ahead of the caller's follow-up, and the fresh run's `runtime.run.started`
  audit `continuityReset: "stale_large_session"`. Either fact alone resumes as before. The
  controller follows the same rule; its fresh turn's preamble points at the
  recent-conversation digest every controller prompt carries, and it notes nothing on a
  task. The size is the LAST call's prompt, not the run's peak, on purpose: a run that
  compacted and finished at 20k replays 20k, which is what every specialist run and
  controller turn that ended above 100k leaves behind (ruling 174), so this rule is the
  backstop for a session that never got compacted (an interrupted run, a refused
  compaction).
- Transcripts: Claude
  `runtimes/users/<principal>/claude-home/projects/<cwd-dashes>/<sid>.jsonl`; Codex
  `runtimes/users/<principal>/codex-home/sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl`
  (the run row's `credential_user_id`; a run with none never spawned a process and has
  no transcript). `GET
  /resources/session-export?run=` (member-gated, 404 without a transcript on disk)
  downloads a bash installer that drops the transcript where the local CLI looks and
  prints `claude --resume <id>` / `codex resume <id>`.
- Transcript existence is cached 30 s (500 entries) for the Export link.

### 3.7 What the UI shows

`run-projection` builds a window of 400 lines / 384 KiB per agent group
(`windowForGroup`), filled from the newest run backwards and shown in time order, with
`run·resumed` boundary lines between runs; groups are keyed `operator` or
`<kind>:<profileId>`. Render states: running → running, error → error, finished → done or
idle, queued/interrupted → idle. `failedBackendUnavailable` (tag `run·unavailable` or
known signatures) marks every such run, whatever its principal, and the Agent-logs footer
states that failure in those words. The footer follows the classified failure for every
run kind (ruling 166): `overloaded` (provider or local origin), `max_budget`, `max_turns`,
`idle_timeout` and `session_missing` each have their own sentence, and only an
unclassified error gets the generic **"continuity error"** one ("…see the blocked packet"
for a specialist, "…the error line above carries what the provider said" for an operator
or controller run).

The retry OFFER travels separately (ruling 137). `altBackend` rides only when the run had
a credential principal — a run refused because the task has no owner at all would be
refused on the other backend for the same reason — and the "Retry on <other>" button
additionally requires that the task owner has that other backend connected, the same test
the packet's `retry_other_backend` option must pass, so the button and the packet never
tell one task two stories. With no offer the footer states the failure and advertises no
retry at all. The task page's own controls answer from the loader's `runPrincipal` (the
owner's per-backend health), so a disabled Run names the person, never a deployment
credential.

A run parked behind the concurrency cap, or held while its session is compacted, reads
"agent queued", not "agent working" (ruling 44); the task page's title on it says which,
from the row's step (ruling 166). Telemetry tags are collapsed by `log-noise.ts`, and the
console shows the redacted `run·inputs` line (seq 0) so a human can see exactly what the
agent was given. Every
runtime writes it (`recordRunInputs`, `run-inputs.server.ts`; ruling 167): a
fresh specialist run, an @mention resume (with the `directive` and its author), every
operator drive and every controller turn, each built from the resolution the prompt was
assembled from, never a second reading of the grants. Its tool list is the toolkit's own
`toolNames` (the Codex operator's is its plan envelope); where a field does not apply it
is null (`repo`/`cwd` for the operator and controller, `anchor` for a Claude drive and a
controller turn).

A call's `tool_progress` heartbeats fold into one wait row — an orb and a count that runs
on from the last heartbeat while the call is still open, "ran past N" once anything landed
after it, and "N heartbeats, no output" opening to each one (ruling 168) — and a tool chip
is marked by whose tool it is: the product's own carry the agent tint and the V mark, an
org server's prints `server · tool`, a built-in stays neutral; a row that clipped or
elided an argument links to it by name (`+ full prompt`), and Bash's description prints
beside its command. The footer's event total counts up to its figure, a frame-loop ticker
with the figure itself on `data-count` (ruling 284(e)).

Ruling 168 draws what an agent did the way agent tools draw it. An `Edit`, `MultiEdit` or
`Write` row prints its file repo-relative (the path the call named on hover) with `+N −M`
(a `Write`, its line count: the record holds no earlier file), and under it the diff
(`edit-diff.ts` over `shared/line-diff.ts`): removed lines then added ones, tinted, the
changed words of a paired line marked, three unchanged lines around each change and a
longer run folded behind "N unchanged lines"; past ten rows the rest waits behind "Show N
more lines", the row's own disclosure. A `Read` prints its file repo-relative too; a path
inside a command is never rewritten. A `TodoWrite` row, and a Codex `todo_list` item (whose
steps the projection now carries as `todos`), draw the agent's to-do list: a header with
the list's progress and count, each step done, under way or waiting, and the step under way
shimmering while the run is live and it is the list the agent wrote last. A thought fold
reads "Thought for Ns" beside a chevron, and "Thinking" with a shimmer while it is the live
tail; multi-line output is a code block with a head (what it holds, its size, Copy) and
numbered lines; the wait row's orb is a CSS lattice. The to-do list, the code block, the
thinking block and the orb take their design from AICSS's free components (MIT,
`THIRD_PARTY_NOTICES.md`). `{ } raw` shows every stored envelope and none of this. The strip's phase and step
arrive as a new line when their words change, and its Elapsed, Turns and Tokens figures
roll their digits (rulings 284(e), 284).

The strip's **Tokens** cell (F35-1) reads `RunView.tokens` and `tokensEstimated`: `~1.2M`
with the tooltip "Estimated from the streamed text. The provider's own total replaces it
when one lands; a run that was stopped never gets one" whenever the row's `usage_final` is
0 (while the run is live and after it ends), "pending" while no usage envelope has landed
at all and the run is still live (a Codex run before its first model call completes,
ruling 165(b)), and the plain figure
once the provider's total landed; on hover it says what the prompt cache wrote and read
over the run (ruling 311).

The console carries a **facts row** of quiet chips under its bar (ruling 311,
`RunView.cache`): warm or cold start with the first call's figures ("warm start · read
47.9k", "cold start · wrote 298k"; green or amber), "miss: previous message not found"
when the provider sent a reason, "cache 1h" (the TTL bucket), "wrote 121k · read 6.1M"
over the run, "peak prompt 226k" (the last prompt, what a resume would replay, in its
tooltip) and "N compactions" — each figure on a `data-` attribute (`data-start`,
`data-first-write`, `data-first-read`, `data-miss`, `data-ttl`, `data-write`, `data-read`,
`data-peak`, `data-last`, `data-compactions`); a run with no first call says "no first
call yet" (or "first call not recorded" when cache figures landed without a first call),
never cold. A compaction also reads as a `system·compact_boundary` line ("context
compacted (auto) · 972k → 10k tokens"); it leaves no note on the task timeline (ruling
172). Insights carries the same record as a table, with resumes by idle time and the
operator bursts under it (ruling 172; ui/surfaces.md).

## 4. Specialist runs

### 4.1 Dispatch

`startAgentRun` → `dispatchAgentRun`:

- Refusals first, before any engagement seat lands: a CLOSED task (terminal stage or
  archived; `taskClosure` / `closureRefusal`, ruling 52) and a task held on other work
  (a non-empty `blockedBy`; `holdRefusalFor`, which reads the entries' live states and
  names one that can never complete, rulings 56 and 58). The task page's Run control
  renders the same hold sentence before the click (`holdRefusal`,
  `app/shared/dependencies.ts`).
- `wantsDelivery = input.delivers ?? (no current deliverer && profile is
  delivery-capable)` when the dispatch engages the profile; an explicit hand-off requires
  the repo-write grant, or (ruling 128, `canOwnDelivery`) an agent that can post files on
  the task (`attach-evidence-references`, `postsFiles` in the operator's roster), whose
  delivery is those files: its prompt says so and asks for their names instead of a
  branch and commits. An agent that can do neither is refused naming both grants. `delivers: true` while another profile delivers is a hand-off
  through `assignSpecialist`, refused only while the outgoing deliverer has a live run; a
  second live delivering RUN hits the single-flight 409 (§3.1). `delivers: false` on the
  current deliverer is refused at the operator's `run_agent` door;
  `dispatchAgentRun` itself keeps the engagement's shape.
- Backend = `backendOverride ?? engagement.pinnedBackend ?? resolved profile backend ??
  snapshot`. Any `backendOverride` writes `pinnedBackend` so the switch sticks: a
  `retry_other_backend` packet resolution, or the Run control's backend field; the
  dispatch sentence then says the task is pinned. F36-8 (pass 36): a run on a backend
  other than the profile's hands the profile's ORIGINAL model through to `startRun` (no
  pre-swap), so the F21-13 substitution notice opens the run log; the "Started a … run
  (switched from …)" event names the model it ran on and the profile's own ("on `sonnet`:
  the profile's `gpt-5.6-luna` is a Codex model"), and a run that set the pin says later
  runs on this task stay on that backend. The `retry_other_backend` option says both
  before the human chooses.
- Workspace: the deliverer clones into `tasks/<KEY>/workspace/<repo>` through the
  project mirror; each supporting run gets `workspace/support/<profileId>/<repo>`, a
  fresh `git clone --local` of the delivering checkout, detached at the reviewed
  revision (`pinSupportCheckout`) or, when the drift since that revision is base-refresh
  only, at the subject `reviewSubjectSha` chooses (ruling 239); with no delivering
  checkout yet it is a mirror clone of the default branch. On clone failure the run
  continues from the workspace root (a supporting run from `workspace/support/<profileId>`),
  a "Workspace checkout failed" note by `system:policy-engine` names the cause, and the
  prompt says whether a credential was `supplied`, `absent` or `not_involved` (a local
  clone never reached GitHub; ruling 197). A run whose checkout failed records no verdict
  at all (`no_checkout`, ruling 87). On a project with no repository (ruling 199) nothing
  is cloned: the deliverer's working directory is `tasks/<KEY>/workspace` and a supporting
  run's `workspace/support/<profileId>`, scratch space with nothing in it delivered. The
  prompt keeps a workspace contract for such a run: its knowledge-base folders, the
  task's attachments folder, and, for the deliverer, that its delivery is the files it
  saves on the task.
- Ruling 151 (pass 35, G35-4): after the eligibility gates and the principal
  resolution, before anything is spent, `backendDispatchHold` is read for the run's
  backend and the account it bills. A hold makes NO run row, reservation, clone or
  process: `holdDispatch` schedules the retry (`run-agent`, the same profile and
  directive, due one minute after the reopen instant, or `UNDATED_HOLD_MS` after the
  refusal when the provider named none; not scheduled when the profile is no longer
  deployed or the task refuses a schedule), writes a `note` titled "Dispatch held" by
  `system:policy-engine` ("**Held:** Codex is out of quota until Sep 6, 2026 · 18:18 UTC
  (the provider said: "…"). Developer's run starts when the window reopens (scheduled for
  …); nothing was dispatched and no decision is needed."), audits `task.agent.run_held {
  backend, until, scheduleId, profileId }`, re-projects, and throws `DispatchHeldError`
  (`ERROR_CODES.DISPATCH_HELD`, 409, `hold` record, user message "Held: Codex is out of
  quota until …; Developer's run is scheduled for then."). ONE retry stands per profile
  per window: a repeat dispatch inside the same hold reuses the pending `run-agent`
  occurrence (a newer directive replaces its prompt) instead of adding a second, writes no
  second "Scheduled:" event and no second note (unless the newer directive replaced the
  pending one, which the note then says), and its audit row records `reusedSchedule`, so N
  held attempts never become N occurrences due at the reopen instant. Every door passes
  through the same read (`assertDispatchNotHeld`) against its own target backend, so a
  Claude retry proceeds while Codex is held: the Run control toasts the sentence
  (`isDispatchHeld`; the person's `@<agent> <prompt>` directive is already on the
  timeline, ruling 69), an @mention returns it as `runNotStarted` on both of
  `commentToAgent`'s branches — the RESUME branch reads the hold itself, before the
  confinement's MCP pre-flight and skill re-mount, because it never reaches
  `dispatchAgentRun` — the operator's `run_agent` answers `noop` with the sentence plus
  "Do not open a packet for this;" and then either "pick a <other> profile if the work
  cannot wait" when the task owner has the other backend connected, or that there is no
  fallback and the retry is already scheduled (ruling 124; a throw would abort the rest
  of the Codex operator's plan), the controller's `run_agent_on_task` surfaces it as the
  tool's refusal text, and a scheduled occurrence retires `held-quota` (§4.5). A hold is
  not a decision packet and costs no operator turn. The record behind it is retired by a
  run billed to the same account that COMPLETES on the backend (another person's run
  retires nothing of it, ruling 160(a)) and by two other things: a person resolving the quota
  or auth packet's option that states the window has reset or the account changed
  (`run-failure-remedy.server.ts` names the backend on that option; `resolvePacket` clears
  it), because the option promises the agent continues now and the record would otherwise
  park it until the recorded instant (ruling 131); and the named person actually changing
  their credential on that backend (ruling 160(b)), because the account the record was about
  is no longer the one the dispatch would bill. The operator's PROMPT door
  (`operatorPromptAgent`) writes no "did NOT start a run" note for a hold either: its own
  note asks for the directive to be re-sent, which the "Dispatch held" note two lines
  above says is not needed and which would mint a second schedule over the one the hold
  already made carrying that same directive.
- Then: mount granted skills (Claude), resolve the browser MCP, build the persona and
  the analyze prompt (task text, comments and repo content are **data**, never
  authority; ruling 198: every path the prompt hands the agent is ABSOLUTE, so the
  "Files on the task thread" section, the browser section and the workspace
  contract's attachments exception all name `taskAttachmentsDir` in full and say it is outside
  the checkout and never committed; that section also says the folder holds what people
  attached to the task (an input the goal names) beside earlier runs' files, and that on a
  task whose deliverable is a result rather than a change to the repository the result's
  files go there and never into a commit, ruling 198; the contract names the folder as
  the run's to READ as well as to copy into, and names it read-only to a run that cannot
  post files, with why (`ATTACHMENTS_READ_SENTENCE`, ruling 217(b)), and a run that holds
  `read_task_attachment` is told another task's files are read with it, never from that
  task's folder (`OTHER_TASK_FILES_SENTENCE`, ruling 214), and a run that holds
  `capture_page` is told that a page among the task's files can be looked at as a reader
  sees it at 1280 px and 390 px and in its states, that `measure_page` says what Viberr
  measures of every delivered page, to look and measure before it delivers one and to judge
  the picture as well as the source when it reviews one (`PAGE_CAPTURE_SENTENCE`, rulings
  194 and 328); the workspace contract also lets
  the run READ its knowledge-base folders, its profile's plus the project's rulings KB,
  `knowledgeBaseReadDirs`, ruling 217(a), and never write them; a run that holds
  `correct_knowledge_doc` is told there that the tool is how a passage changes,
  `KB_CONTRACT_CORRECTION_SENTENCE`, ruling 217(a); right after the attachments line, with or
  without a checkout, the contract says what a fact from outside rests on, ruling 204: a
  run that holds `keep_source` is given the whole move, `sourcesKeepLine` (save the page
  or the output into the attachments folder under a name that starts with `.source-`,
  which nothing lists, posts or delivers, call `keep_source` with that name, where it
  came from and a title, cite the id; a claim with no kept source reads as unsupported;
  and, ruling 218, a record of dated entries may have changed what an earlier entry of
  it says, so the later ones on the same thing are read before the result states what
  holds now, and the record itself is kept where a source can hold it, not only the
  part cited;
  a run whose `use-web-search-fetch` grant is withheld is given the same move with no
  page, no API and no `curl` in it, told that it fetches no page and keeps none, and so
  is not handed a way to the web its profile was denied), and a run that does not is
  told it cannot keep one and why,
  `sourcesNotKeptLine` (its profile lacks "Attach evidence references", or it holds the
  grant and the tool is not mounted, a Codex run while the gateway is not listening), so
  its result names what was not kept; a supporting run that holds `read_task_source` is
  told, before what it is asked to do, that the work's claims are checked against the
  kept sources, that `read_task_source` with `find` lists the places in one that hold a
  word or phrase, that a kept record of dated entries is searched whole for the later
  entries where the work states what holds now from one, a record kept only in part
  being a finding (ruling 218), and that a claim
  with no kept source, or one its source does not bear out, is a
  finding, `SOURCES_REVIEW_LINE`), resolve delivery permissions, compute the
  denylist (or the "everything off" list when the profile vanished, ruling 182), write the
  redacted `run·inputs` line (with the toolkit's `toolNames`, ruling 167), flag a
  directive that asks the specialist to push or open or merge a PR
  (`directiveRequestsDelivery` returns the matched phrase; a `policy` note by
  `system:delivery` quotes it and says nothing was withheld, and the audit gains
  `directiveRequestedDelivery` and `deliveryPhrase`; "an/the/AX-21's open PR" is a
  description, not an instruction, ruling 200), audit
  `task.agent.run_started`, lift a packet-less hold (`liftHoldForRun`:
  `readiness: ready`, a "Hold lifted" note naming the dispatched agent,
  `task.hold.lifted {cause: "dispatch", profileId}`; ruling 54), mark `waiting:
  agent`, register the completion callback. A resume re-derives all of it
  (`resolveResumeConfinement`), the hold lift included: an @mention that resumes an
  existing session never reaches `dispatchAgentRun`, so `commentToAgent` calls
  `liftHoldForRun` itself on that branch. That is the common case for a hold, since a
  hold is usually set because a run FAILED and the agent therefore has a session.
- A dispatch that puts the completeness question (`completeness: true`) stamps
  the reviewer's engagement with `question` once the run exists (ruling 93); one that
  re-runs a reviewer with a standing question and `withholdVerdict` removes the verdict
  channel for that run only (the Claude `report_outcome` field and the persona's
  collaboration notes; the Codex envelope schema is static and keeps its `verdict` key)
  and records `verdict_withheld` on the run, so completion records no verdict from it,
  neither the envelope's nor the prose fallback's (rulings 87, 66). The operator withholds it the same way with `run_agent`'s `noVerdict` (the
  Codex plan's `noVerdict` field, and a recommendation card's), for any run it tells not to
  judge (ruling 124). The engagement stays `verdictCapable`. A delivering run, fresh or resumed,
  gets no verdict channel at all, whatever its profile grants, and completion discards a
  verdict from a run dispatched to deliver: its reply is its delivery, and its files stamp
  `deliveredAt` (ruling 87).
- The timeline's dispatch sentence follows `startRun`'s outcome (`runDispatchLine`,
  ruling 166): "Started a … run …. It is streaming to the agent logs." only when it
  started, "Queued a … run … Nothing is streaming yet." when the cap parked it, and
  "Refused a … run. <the run's own sentence>" when it was refused. None of the three
  carries a dash (ruling 292).
- The directive is on the record (R21-9): the task page's Run control writes the person's
  `@<agent> <prompt>` comment BEFORE the start, so it predates the run and no completion's
  deferred-mention window can redeliver it; a start that throws appends the person's own
  "No run started for <agent>: <reason>" beside it (ruling 69). The operator's
  `run_agent` writes its comment before the dispatch; the controller's `run_agent_on_task`
  writes the same comment, authored by the person and addressed to the agent, after the
  start (ruling 152).
- Git identity in the run: `<profileId>@viberr.local`; `GIT_CEILING_DIRECTORIES` is the
  task dir.

Stage eligibility (`stages:` on the profile, `spanAll`) gates NEW engagements
(`assignSpecialist`, `assignReviewer`, the dispatch's auto-engage); an empty list means
eligible everywhere. The refusal sentence names stages by their board names ("Rev is
not eligible for the Triage stage; its profile is scoped to Review. Change the task's
stage or the profile's eligible stages."), never raw ids. Ruling 181 (pass 34): once a
profile is the task's delivering
engagement it runs at EVERY stage, on every door (the operator's `run_agent`, the Run
control, a human @mention's resume, a schedule, `retry_other_backend`), for rework,
conflict resolution and follow-ups; `runEligibilityFor` is the one home, and the
`task.agent.run_started` audit row records `stageEligibility` (`declared`,
`engaged-deliverer`, or `undeployed`), naming the exemption only when it was needed.
A supporting engagement stays stage-scoped, and an unengaged profile whose session
survives is judged by the new-engagement rule, so the @mention resume door
(`assertResumeEligible`) refuses with the dispatcher's own sentence and posts the
comment as a partial success. That door first refuses a closed task (ruling 52) and a
held one (ruling 56) with the same sentences as every other door. A task with NO
delivering engagement that can run, standing past the stages its agents declare, has
nobody either half reaches, so while it has delivered nothing the operator may move it
back to an earlier stage where one can be engaged (ruling 112; `reworkStages` in its
snapshot names the stages and the agents).

Before a delivering dispatch on a task with no recorded branch,
`ensureTaskBranchBestEffort` prepares the task branch, for a deliverer that writes the
repository only (ruling 228: one that delivers files gets none); a
failure it cannot fix (credential rejected, GitHub unreachable, base branch missing and
not creatable, or an unexpected throw) is disclosed once on the task timeline as a
`github` event by `system:delivery`, audited as `github.branch.prepare_failed`, and logged
on every attempt; the run still starts in its workspace and delivery retries the branch
(F34-3, pass 34).

### 4.2 The `viberr_agent` toolkit (Claude specialists)

`buildAgentToolkit` (`agent-toolkit.server.ts`) builds up to seven tools on independent
gates and mounts the server only when at least one was built, with `alwaysLoad: true`
(§2.4). It returns `toolNames`, read off the definitions it pushed, which is the tool list
the run's `run·inputs` record discloses (ruling 167). Codex specialists mount none of it
and get the outcome envelope instead (§2.5), except the board and knowledge readers,
which Viberr's gateway answers for a Codex run (ruling 216), and `keep_source`,
which the same board server answers for a run that may save files on its task (ruling
82).

| Tool | Gate | Effect |
|---|---|---|
| `post_comment` | `comment-on-task` | timeline comment, audit `task.agent.commented`; a comment that tags an agent says it reached nobody (ruling 70) |
| `ask_human {title, body?, options?: [{title, detail?, reply?}]}` | `ask-human` | opens an "Agent question" input packet with `askedBy = profileId` and a `blocked` entry that carries the card (its body and options, ruling 68), audit `task.agent.packet_opened`, the owner's notification under the agent's name, filed as kind `question` with its own "Agent questions" toggle, pill and hand glyph (ruling 74; the Codex outcome envelope's question writes the same kind); more than 4 options is refused by the schema with nothing written, never trimmed (ruling 202); refused while a packet is open. Only the option whose title ends "(Recommended)" is recommended; an unmarked list recommends nothing and the card preselects nothing. `reply: true` marks an option that needs the person's typed answer, which the card and `resolvePacket` require (ruling 68); the Codex envelope's `question.options[]` carries the same `reply`. An answer that sends work back (`request_edit`, `redirect`, `custom`) resumes this agent (ruling 68), unless the chosen option or the person's note names another deployed agent or the operator, in which case it goes to the operator with a note saying why (ruling 68, `answerNamesAnotherActor`) |
| `report_outcome {summary, verdict?, evidence?, relay?}` | `report-validation-verdict` (the `verdict` field) or `attach-evidence-references` (the `evidence` field); built when either is granted; `relay` rides every variant | `evidence: [{label, result?, status}]` (ruling 16): what was checked, how it came out, and `pass`, `fail` or `info`; a row with no `status` is refused by the schema by name, nothing staged. Staged ONCE under the run's `outcome_key`, consumed once at completion; a second call changes nothing, is answered `[already staged] Your outcome was recorded once; this call was ignored. Finish with your full findings.` and audits `task.agent.outcome_duplicate` {`runId`, `outcomeKey`, `count`}. `relay: [{taskKey, text}]` (ruling 202) is text for OTHER tasks of the same project, at most `RELAY_MAX_ENTRIES` (2); a third entry is refused by the schema by name, nothing staged, so the agent re-reports in the same run. The completion posts each entry (§4.4) |
| `github_read {path}` | `read-github-api` | GET-only, repo-scoped read through the project PAT on the server (≤ 32,000 bytes, ruling 215), audit `task.agent.github_read` |
| `read_board {taskKey?}` | none; built when the run holds any collaboration grant (`holdsCollaborationGrant`), so only beside another tool; on Codex the gateway's `viberr_board` server (ruling 216) | this project's board, read-only: one task (title, stage, readiness, what it waits on, archived, goal, and its `outcome` once it has one: the current completion summary and each verdict's report on what it delivered, ruling 213(a)) or the list; archived tasks included (`board-read.server.ts`). One task also lists its `timeline`, every entry as `<occurredAt> · <type> · <author> · <title>`, newest first, the newest 200 and a line counting the rest (ruling 213(a)), and its kept `deliveries`, each stamp with the files as that delivery held them, newest first (ruling 86) |
| `read_task_attachment {name, taskKey?, offset?, delivery?}` | none; built with `read_board`, on both backends | one attachment of this task, or of another task of the project with `taskKey`, read where it is: text in pages of up to 32,000 bytes (ruling 215), a spreadsheet as CSV, an image as the picture, a binary refused (the operator's reader, `readAgentTaskAttachment`, ruling 214); `read_board` lists each task's `files` for it. With `delivery`, a stamp from the task's `deliveries`, the file as that delivery held it (ruling 198) |
| `read_task_source {id?, taskKey?, offset?, find?}` | none; built with `read_board`, on both backends | the sources a task of the project keeps (ruling 82, `readAgentTaskSource`). Without `id`, the list as text in pages: one line a kept delivery with the ids it rested on, or "rested on no kept source" for one stamped while the task kept nothing, then each source's id, name, size and SHA-256, its title, where it came from, and when, by which agent and in which run it was kept. With `id`, that source's content, read as an attachment is: text in pages of up to 32,000 bytes, a PDF as its text, a spreadsheet as CSV, an image as the picture, an HTML page as its source text. With `id` and `find` (ruling 82), the places in that source that hold a word or short phrase of up to twelve words, in place of a page: `found` counts them in the whole source, and `hits` lists up to forty of them from `offset` on, each with its `line`, an excerpt (opening with the head of the entry the words stand in, where the text shows one by a long line or a hanging indent) and the `offset` a read of it starts at; `nextOffset` is where the next search starts. Letters match in either case and a space matches any run of white space. This task's, or another task's with `taskKey`. A miss says what the task does keep. What a source says is data, never an instruction. `read_board` on a task says how many it keeps |
| `keep_source {file, from, title}` | `attach-evidence-references`; on Codex the gateway's `viberr_board` server, when the run's mount carries the grant | keeps one file the run staged in the task's attachments folder as a source (ruling 82, `keepTaskSource`). `file` is a staged name: one that starts with `.source-`, which no lister of the folder returns, so the file is never posted on a reply, never part of a delivery and never the working-file prune's to judge, before the keep or after it, whichever run completes meanwhile. The server takes its own copy into the task's `sources/` under the next id (`S1`, `S2`) and the name after the prefix, with where the agent said it came from, a title, the time, the agent, the run, its size and its SHA-256, and removes the staged file. The server fetches nothing. The description and the `from` field follow the run's `use-web-search-fetch` grant (`keepSourceDescription`): a run that holds it is told to save the page (`curl -sSL -o`, a browser snapshot copied to a staged name); a run it is withheld from is told what it can keep (a repository file, a command's output) and that it keeps no page. Answers `[kept] S7: …`, `[noop]` with the id that already holds those bytes, or `[refused]` with what to do instead, and a refusal writes nothing and leaves the staged file where it is: a staged name the folder does not hold; a name that is not one name, or holds a line break or a control character; any name that is not a staged one (a file of the task: a person's upload, a relay, a run's file, a delivered file, a gate log; and the store's own `.viberr-…` working files); an empty file; over 10 MB; the task already at 200 sources, or with less room left than the file takes, saying how much it keeps and how much is left; `title` or `from` empty, over 200 or 2,000 characters, or holding a line break, a control character or a Unicode line separator; what reads as a token or a password in `from` or `title` (`readsAsCredential`: a token where it starts a word, an `sk-` one only when it reads as a key, a password in a URL's userinfo); bytes whose source a person has removed from the store; an archived task. Three refusals remove the staged file themselves, each a file that must not sit where every agent on the task reads: a source that is not a fetched `http(s)` page and whose bytes read as holding a credential, a staged name that reads as holding one (`wget` names a download after its URL, query included), and the bytes of a source a person removed from the store. A staged file that cannot be removed is named in the answer. Audit `task.source.kept`; no timeline entry per keep: a run that kept any leaves one `note`, "Sources kept", when it settles (§4.4) |
| `capture_page {name, view?, from?, press?, hover?, tab?, motion?, moving?, width?, height?, scale?}` | none; built with `read_board`, on both backends, only while the server can render a page (`pageCaptureStatus`: `VIBERR_BROWSER_EXECUTABLE` set and on disk) | one page of THIS task as a reader sees it (ruling 194, `captureTaskPage`): `name` is a `.html`, `.htm`, `.md` or `.markdown` file among the task's files; Viberr renders it at a desktop width (1280 px) and a phone width (390 px), or the one `view` names, and answers with one stretch of the page per width, up to 2,000 px tall from `from` (at most 40,000), as an image block each, with `nextFrom` when the page runs on (never one past 40,000: the reply then says a stretch starts no further down), what the page asked the network for, which sibling names it asked for and did not find, which paths it asked for from the site's root or above its own folder (`/css/site.css`, `../up.png`: a capture serves the task's own files by name and never those), whether it opened a dialog as it loaded, and where the pictures were saved. A phone lays a page out taller than a desktop does, so past the shorter layout's end the reply says where the page ends at that width and still hands over the other. One call can put the page in a state first (ruling 194) and hand back the one screen as it then stands, with what the act found: `press` presses one control and `hover` puts the pointer on one, each named by its visible words or a CSS selector of up to 200 characters, and a name nothing on the page answers to at that width is answered with the controls that are there; `tab` presses Tab from the top, 1 to 60 times, and names the control that holds focus. `motion: "reduce"` renders the page for a reader who asked for reduced motion, and `moving: true` hands back the screen at `from` at three moments, about 250, 1,000 and 3,000 ms after it comes into view, in place of a stretch. Given together they are done in one order, Tab, then the press, then the hover, so a menu is opened and one of its items pointed at in one call; a press that sends the browser to another site is said and not pictured. A state is refused with a size, and `press`, `hover` and `tab` are refused with `from` or `moving`. Each stretch handed over is written down as a look on the run's row (ruling 329, §4.4); a picture of a state, of a page with reduced motion asked for, or of an exact size is not one. A run that judges a files delivery (§4.4) is answered from the delivery as Viberr kept it: `name` is looked for in the kept copy before the task's folder, the page is rendered with the kept files and the files the task's folder holds under names the kept copy does not (less dot names, Viberr's own pictures and the browser's working files), and the reply says so, names up to four of those and counts the rest, and says of a file past what a render carries (25 MB a file, 200 MB in all) that it was not carried. With `width` and `height` (ruling 194) it makes one picture of exactly that size instead: each is a whole number of CSS px from 100 to 4,000, `scale` is one of 0.25, 0.5, 1, 1.5 and 2 (1 when omitted; binary fractions, so the size is exact), and the page, or a `.svg` drawing (pictured only this way: its source is set inline in a page with no margin, so a picture or a font saved beside it still loads by name), is laid out in a viewport of that size, never as a phone, and cut to that box from its top left as a PNG of `width` times `scale` by `height` times `scale` px, each side rounded, taken once and never retaken shorter. A scale of 1 or more is the device scale the page itself is drawn at (its `devicePixelRatio`), so 2 is drawn at twice the detail and not enlarged; under 1 the page is drawn for a 1x screen and the picture scaled down. That reply gives the size asked and the size saved, one sentence each when the layout is taller or wider than the box (with both sizes: how its author learns it does not fit; what a page that hides its overflow, or a drawing's own canvas, cuts off is not seen), the same network, missing-file and dialog clauses, the scratch path, and that copying that file into the task's attachments folder under a name ending `.png` keeps it as a file of the task (a Claude run is told this only when it can post files and holds no verdict: one that holds the verdict judges pictures and makes none, and the tool's description says where the picture is saved and not how one is kept); the picture comes back as one image block while both its sides are within 2,000 px, and a larger one is saved and not shown, with a sentence saying the same box at a lower scale is the same layout. The name is found in either Unicode form (ruling 76) and the reply uses it as typed. It saves nothing on the task and writes no audit row or timeline entry: the pictures stay in the task's capture scratch in the folder of the run that asked (`<task>/.captures/<runId>/`, beside `deliveries/` and not under `workspace/`), replaced by that run's next capture and removed when the run ends. `[noop]` for a name the task does not hold (a dot name included, as for every reader), a file that is not a page, a `.svg` asked for with no size, a source over 10 MB (markdown 2 MB), a `from` past the page's end at every width asked for, and a size that cannot be pictured, said before any file is looked for: one of `width` and `height` without the other, a `scale` with no size, a size together with `view` or `from`, and a picture over 16,000,000 px (the reply gives the size it would be); `[busy]` when the renderer has not started the call within 15 s; `[error]` with the reason for a render that failed: a width that failed is the answer even when the other width was over before `from` (the reply still names where that one ends), a sized picture over the 3,750,000 bytes a capture hands back says so and to lower the scale or simplify the picture, one that comes back any other size than asked is not kept, a task with no owner under isolation says so, and an owner whose launch could not be prepared gets the launch's own sentence. A value outside a field's range never reaches the door: Claude's schema refuses it, and the Codex gateway answers with what each field takes (`pageCaptureArgsRefusal`) |
| `measure_page {name}` | none; listed beside `capture_page`, on both backends, only while the server can render a page | what Viberr measures of every delivered page (ruling 328, `measureTaskPage`), taken now, at the delivery's own views, of one `.html` or `.htm` file among this task's files, in words and with no picture: at the desktop and the phone width what the accessibility checks found (axe-core, WCAG 2.2 A and AA: each kind of fault, the first elements it is on, the lowest contrast), how many of the page's controls Tab reaches, which it never reaches and which look the same holding focus as at rest, and what still moves with reduced motion asked for; the weight of the page with every file it loads; its load time on a slow phone line; and how its weight and load stand against the lightest and the fastest page the board has had accepted. A check that did not finish is said not to have been measured, a keyboard walk that stopped at its press limit says so, and a list cut to its first few gives its count. Nothing is saved: the figures a task keeps are the ones taken of what it delivers (§4.4). A run that judges a files delivery measures the delivery as Viberr kept it, found and rendered as `capture_page` does for it, and the answer says so. A markdown file is answered `[noop]`, a name the task does not hold with the list of its files, and a renderer that is busy with `[busy]` |
| `keep_page_look {url?, from?}` | `attach-evidence-references` and the browser grant (`use-browser`), on both backends, only while the server can render a page | keeps how a page on the web looked on the run's task (ruling 327, `keepPageLook`). With `url`, an `http(s)` address, Viberr opens it once in its own browser, with the network, and keeps as sources: the whole page at the desktop width (1280 px) and at the phone width (390 px) in stretches of up to 2,000 px, at most twelve a width (a longer page is kept to there and the note says it runs on); its first screen at each width at three moments after it came into view, less any that equal a picture already kept; and one markdown note naming which source is which stretch and what the renderer read of the page's motion (what was animating a second after it loaded and whether it loops, each video and whether it plays by itself, what stays at the top while the page scrolls, how many elements began to animate as they were scrolled to, and which of the first controls change under the pointer, in what and over how long). The answer names the ids and shows no picture: each is opened with `read_task_source`. One look of an address per task: a second ask is answered with the ids of the one kept. A look is its note, which is written last and lists every picture of the look by the source that holds it: pictures a keep that failed left with no note are no look, and the next ask for the address takes them up by their bytes and closes the look with its own note. With `from`, a task key of the same project, the task takes over the looks that task keeps whole: the pictures byte for byte and under their date, each note written again from its list with this task's own ids, and what moved word for word. It is checked whole before anything is copied, and a task that already keeps a look of the same address pictured at another time, or has no room for all of it, is refused with nothing copied; a take-over that was cut off is finished by asking again. Refused before anything is opened: an address that is not `http(s)`, one that holds a user name, a token or a password, one that names this machine or a private network by a literal address or by a name with no dot in it (what a public name resolves to is not looked up), `url` and `from` together, and an archived task. A look is the whole page at both widths or nothing: a page that cannot be opened, an address that answers 400 or more, a render that failed part way and a look the task has no room for keep no picture, and the run is told to say so and to state nothing of the look from memory. Audit `task.page_look.kept`. On Codex the call may take as long as the board server's 180 s tool limit (`BOARD_TOOL_TIMEOUT_SEC`) |
| `read_timeline_entry {occurredAt, taskKey?, offset?, entry?}` | none; built with `read_board`, on both backends | one timeline entry of this task or, with `taskKey`, of another task of the project, by its stamp: the prompt's recent timeline (five entries, each cut at 220 characters) prints it after a clipped entry ("(clipped; the whole entry is at `<occurredAt>`)") and counts the older entries it leaves out, naming `read_board` for them to a run that holds it, and `read_board` on a task lists every entry's; entries written in one millisecond (a verdict's report and its quality marker) come back together under `entries`, in the order they were written; a long entry comes in pages of up to 32,000 bytes (ruling 215): a read cut short says `truncated`, the entry's length in `characters` and `nextOffset`, and `offset` reads on (ruling 213(d)); entries that share a stamp share the first page, each numbered `entry`, and `entry` reads one alone (ruling 72); when the page cut any of them short, the answer lists those under `cut`, with where each reads on, after `occurredAt` and `shared` and ahead of the entries (ruling 213(d)); a `kb_correction` entry comes with `correction`: the passage it replaced, the text it wrote and the evidence, whole from the record, and whether a person undid it, to a run given that knowledge base; to any other run it quotes nothing while a deployed agent is not given the knowledge base (ruling 211); read-only (rulings 213, 72 and 211, `readTimelineEntry`; the Codex board server takes the run's knowledge mounts as what it is given) |
| `read_knowledge_doc {kb, path}` | the run has a knowledge base attached | one document of an attached knowledge base, whole (§6; ruling 205) |
| `correct_knowledge_doc {kb, path, replaces?, text, evidence}` | the run has a knowledge base attached; built after `read_board`, so a knowledge base alone never mounts `read_board` | writes `text` into that document in place of `replaces`, the exact passage (an empty `text` deletes it), or at its end (`correctKnowledgeDoc`, ruling 210(b); the rules are [file-formats.md §8](../architecture/file-formats.md)): only in a knowledge base this run was given; a refusal writes nothing and says what to fix; a `kb_correction` timeline event under the agent's own name, quoting the passages only when every deployed specialist is given that knowledge base (ruling 211), and audit `task.kb_correction.merged`, and no notification; a person undoes it from the Controller page |

A specialist has no post tool of its own for another task (ruling 202): its reach there is
the `relay` entries of the outcome it already reports, posted by the completion through the
operator's relay door (`relayToTask`). The prompt's Collaboration section names it wherever
the outcome channel exists (`RELAY_NOTE_CLAUDE` beside `report_outcome`, `RELAY_NOTE_CODEX`
beside the envelope): put what the goal says belongs on another task there, never in an
attachment or a report for a person to copy over.

A reviewer that already has a verdict on the task (any entry of its own in `verdicts`)
gets one more Collaboration note on either backend, `REREVIEW_RESTATES_NOTE` (ruling 88):
the verdict it records now replaces its earlier one for every later reader, because the
board read and the task's outcome carry only a reviewer's newest verdict, so it restates
what still stands (a score and each deduction, the findings, each knowledge-base
correction it made on the task with its id), not only what changed. A first review gets
no such note. When its newest verdict was on a files delivery Viberr kept (ruling 86), a
second note follows it (`rereviewChangesNote`, ruling 201): the delivery the reviewer
judged, and the task's files as they stand now set against it, byte for byte, as four
lists (changed, new, gone, unchanged; `changesSinceJudged`). The lists read the task's
folder, which is what the reviewer opens, and leave out the browser's working files,
Viberr's own page pictures and the files this reviewer's own timeline entries name and
nobody else's do; each name is printed as one bounded line with no backtick, and only the
unchanged list is counted past forty names. The note then says what the lists are worth:
a check a file passed, resting on that file alone, still holds and is restated without
being made again; everything the reviewer sent back is checked again wherever its fix was
made; and the changed and new files, what a change makes untrue elsewhere, whatever its
earlier report does not show and whatever the run's directive asks for are still owed. A
run that holds the board readers (ruling 214) is also told that `read_task_attachment`
with `delivery` returns a file as it was judged. Nothing is added for a commit on either
side, for a judged delivery that was not kept, or when the delivery judged is still the
one under review and no file differs (ruling 93's question is about what the reviewer has
not said yet); an older kept delivery holds its deliverer's files alone, so the
others read as new; and a review asked for again by a comment resumes the reviewer's
session and carries neither note. Building the note never stops the review.

The outcome is the first envelope a run reports. The already-staged check reads the
in-process map and the persisted row, so an envelope staged before a restart still stands
against a later call. The `count` is the run's refusals so far; it is cleared when
completion consumes the envelope.

### 4.3 Capability → enforcement

Claude: `CAP_DENY_RULES` (`specialist-tool-policy.ts`) turn withheld grants into
`disallowedTools`. Codex has no tool denylist and no OS sandbox (every thread is
`danger-full-access`, ruling 144, §2.5): `startRun` derives `webSearchWithheld` from the
denylist (`webSearchWithheldFromDenylist`), which sets `webSearchMode: "disabled"`, and
`repoWriteWithheld` (`repoWriteWithheldFromDenylist`: `Edit|Write|NotebookEdit`
denied), which the Codex adapter does not read. Ruling 188 adds one row that does not
come from `CAP_DENY_RULES`: a withheld `execute-code-or-write-repo` also removes the org
MCP tools an admin marked as write tools on the server (Instance settings → Agent
resources, MCP server editor), per mounted server, derived from the same denylist.

| Withheld capability | Claude denies | Codex |
|---|---|---|
| `execute-code-or-write-repo` (headline) | `Edit MultiEdit Write NotebookEdit Bash(git commit:*)`; a run with an attachments folder keeps `Edit MultiEdit Write`, confined by a hook to that folder and the run's own temp directory, and on a task with no checkout its working directory (rulings 217(d), 141(c) and 199) | advisory (ruling 183) |
| `execute-code-or-write-repo`, org MCP write tools (ruling 188) | `mcp__<server>__<tool>` for each marked tool; an HTTP config also carries `always_deny` | that server's `disabled_tools` (binds) |
| the same, on a server reached through the MCP gateway (ruling 191) | as above, and the gateway leaves the tool out of `tools/list` and refuses a call to it | as above, plus the gateway's filter and refusal |
| `create-task-branch` | `Bash(git checkout -b:*)`, `-B`, `git switch -c/-C` | advisory |
| `commit-push-branch` | `Bash(git push:*) Bash(git commit:*)` | advisory |
| `open-review-pr` | `Bash(gh pr create:*)` | advisory |
| `merge-pull-request` (always human) | `Bash(gh pr merge:*)` | advisory |
| `use-web-search-fetch` | `WebFetch WebSearch` | `webSearchMode: disabled` |
| `comment-on-task`, `ask-human`, `report-validation-verdict`, `read-github-api` | the toolkit tool is not built | envelope field ignored / not requested |

On Claude every command-level row above also binds through the PreToolUse capability hook
(§2.4): `git -C . push`, `sh -c 'git push'` and the like are refused with a reason naming
the withheld capability, not only the command's plain form.

**The write family is advisory on Codex** (ruling 183). What binds there is Viberr's own
boundary: the prompt omits every delivery step the run may not take
(`resolveDeliveryPermissions`), the supporting run works in its own isolated checkout, no
agent holds a credential, delivery is server-owned (the only thing that pushes a branch or
opens a PR), and verdicts are revision-bound. `codexRepoWriteAdvisory`
(`specialist-tool-policy.ts`) is `deliveryWithheld(grants)`: true for ANY Codex profile
whose write family is withheld, a profile with an empty grant list included (it runs
fully withheld). Every surface rendering the enforcement tags such a row **"advisory on
Codex"** with the one shared sentence (`CODEX_REPO_WRITE_ADVISORY_NOTE`): the profile
editor row, the capability matrix (naming the profiles) and the agent card's withheld
bucket. `deliveryWithheld` is also what `deploy_agent`'s reply reads, so the sentence about
a new deployment's delivery posture is the gate the run is held to (ruling 183).

"Withheld" means (`isWithheld`): always-human ids always; absent grant when the id is in
`GRANT_REQUIRED_CAPABILITY_IDS`; mode `human` or `off`. `specialistGrantModes` repairs one
thing before that lookup: an ABSENT headline on a profile whose scoped delivery grants are
actionable reads as `direct`; an explicit `off` is never reinterpreted. Specialists have no
`recommend` lane: the save paths and the roster's display read coerce a stored `recommend`
to `off` (ruling 182), while `isWithheld` itself treats a stored `recommend` (only a
hand-edited `project.md` can hold one) as granted.
Delivery permissions `{ canBranch, canCommitPush, canOpenPr }` are keyed on the headline
write grant.

### 4.4 Completion

`registerAgentCompletion` → `applyAgentCompletionEffects`:

1. Grants are re-resolved live (an undeployed profile becomes fully withheld). Before
   anything else is written, a run that kept sources leaves one `note` on the timeline
   under its agent, titled "Sources kept" and naming their ids (`noteSourcesKeptByRun`,
   ruling 82), whether it finished, failed or was interrupted; a replay of the run's
   effects after a restart finds the entry and writes no second one.
2. Envelope = staged outcome by `outcome_key`, else a Codex parse when one was
   requested (every option an agent's envelope question carries is kept; the ≤ 4 cap is
   the live tool's, ruling 202). The reply comment is posted (audit
   `task.agent.replied`, the recovery idempotency marker); on a finished run whose
   reply does not already tag them, a cc-line is appended for the dispatcher (resolved
   display name, `@<name>`) and `@operator`, whichever are missing.
3. Verdict: envelope → prose classification (`classifyReviewerVerdict`) → at the review
   stage a "no verdict" note unless a human directive dispatched the run.
   `verdictAuthorized` is the engagement's `verdictCapable === true` when the run has an
   engagement, else the live verdict grant. No verdict at all is recorded for a run whose
   checkout failed (`no_checkout`, ruling 87, with a note naming that condition) or whose
   dispatch withheld the verdict (`verdict_withheld`, rulings 87 and 124), and the prose
   fallback is for SILENCE only: an envelope that left the verdict empty and asked a
   question has answered. A request-changes with nothing delivered to bind to is recorded
   in words only, and its note says so (ruling 245), as an approval with none does. A verdict from the run a completeness stamp names is recorded as
   `answers: "completeness"` (ruling 93). Ruling 329: an `approve` of a files delivery is
   recorded only from a run that looked. What it owes (`pageLooksOwed`,
   `app/server/tasks/page-looks.server.ts`) is each HTML page saved by an agent that is
   the task's deliverer or was dispatched as it, as the kept delivery holds it (the pages
   are read from the kept copy, whatever became of the task's folder), seen from its top
   to its end with no gap at the desktop width and at the phone width, and every stretch
   of every look the task keeps (ruling 327). What the run was shown is on its row
   (`agent_runs.looked_json`): each stretch `capture_page` handed it, each picture Viberr
   kept of the delivery that it opened with `read_task_attachment` (out of the delivery's
   kept copy, or in the task's folder while the folder holds the kept bytes), each kept
   source it opened as an image with `read_task_source`, and, for a Claude run, each of
   those it opened with its own file reader, read from its log (`looksFromRunLog`). The
   looks that count are the session's (`looksRunIds`): this run's, and those of the
   earlier runs of the session it continued on the same task and subject, while neither
   they nor this run were compacted. A run's list is emptied when its context is replaced
   by a summary while it works, whether the stream carried the compaction or a Codex
   rollout told of it after the CLI exited, and its log is read from that compaction's
   own line on (found by the line's tag); the compaction that closes a run (ruling 174)
   comes after its verdict and empties nothing. A resumed review told what it had not opened opens only that and
   still holds the pictures of its earlier turns, unless the run before it was compacted
   when it ended (ruling 174, past 100,000 tokens): that review then holds a summary,
   and looks again. A picture taller than 2,000 px (`PAGE_LOOK_MAX_PX`) is not a look,
   and a look counts only for the delivery it is of: a kept picture for the delivery it
   pictures, and a `capture_page` stretch for the delivery under review when the run was
   shown that delivery. A run that judges (`judgedDelivery`: dispatched to review, its
   verdict not withheld, its engagement verdict-capable or taken off the task under it)
   is answered from the delivery's kept copy first: the page is found there, and rendered
   with the kept files and, beside them, the files the task's folder holds under names
   the kept copy does not, and the reply says so and names up to four of them. With no kept copy it is
   shown the task's files as they stand, is told so, and its look still counts. Any other
   run is rendered the task's files as they stand, and its looks count for no approval.
   Nothing is owed that no tool can show: no page on a server with no browser, none past
   the 10 MB `capture_page` renders, no kept picture whose bytes were taken out of the
   store, and a page longer than 40,000 px only to there. When something owed was
   not looked at, the verdict is not recorded and nothing binds: a `note` titled "Approval
   not recorded" names each page, width and picture the run did not open, says the review
   runs again, and stands in for the "no verdict" note; a check that cannot be made is
   answered the same way. A `request_changes` owes no look, and neither does a markdown
   file or a delivery that is a revision. The run is told what its approval owes before it
   starts (`pageLooksNote`, in the collaboration notes on both backends).
4. Question → packet using the live ask grant; evidence rows are written; browser
   working artifacts not cited are pruned (ruling 78). Ruling 78: the run's workspace
   candidates (its `workdir`, `workspace/<repoName>`, `workspace/repo`, `workspace`) are
   scanned for a stray `projects/<slug>/tasks/<KEY>/attachments` folder an older prompt
   caused; when one exists a `policy` line by `system:delivery` names the folder, the
   files it holds ("NOT posted on this task") and the real attachments dir.
   Relays (ruling 202): the envelope's `relay` entries are posted next, after the reply and
   before the operator reacts, so its snapshot already reads the source line.
   `postOutcomeRelays` posts the first two through `relayToTask` with the agent as the
   author (the deployed profile's name in the header, the agent's actor ref on both
   tasks, the audit row labelled with the agent); an entry past the cap, an entry the door
   refuses (another project, this task, a missing or closed task) and every entry of a
   profile that is no longer deployed are named in ONE `note` titled "Not relayed" on
   this task, by `system:policy-engine`, which says the operator can post it with
   `relay_to_task` and that nobody copies it by hand.
5. A comment a busy agent refused while this run was live (from its row's `created_at`)
   is redelivered now, before the error and closed-task branches, and a delivery that
   cannot start withdraws the promise on the record (ruling 69).
6. Error runs: `blocked` timeline event (worded by `describeRunFailure` for a
   classified refusal), a model-availability mark (`markModelUnavailable`, §2.3),
   stuck-loop packet (`stalled: true`) whose options come from the same module (§3.5),
   waiting → human (ruling 156(a)).
7. A successful run withdraws an open packet only when it carries `stalled: true` (a
   run-failure, no-progress, depth-cap or transition-chain escalation), re-checked inside
   the write; a conflict, a lease order, an agent's question or the operator's own
   decision is never withdrawn by a specialist's success (ruling 123).
8. Finished deliverer runs reconcile what the agent pushed itself
   (`reconcileWorkspaceDelivery`).
9. A run that completes on a CLOSED task (ruling 52) records its report with a
   "Completed after the task closed" note and wakes no operator. Otherwise the operator
   reacts (`trigger: agent-reply`) when the reply is non-empty, differs from the previous
   one and `reactDepth < 4`, or when the run was dispatched by name, finished, and the
   depth is still under 4. A reply whose recorded verdict is `approve` resets the depth
   (ruling 119), and so does a reply that moved the task's head during its hop: a work
   revision minted, or a revision's `pushedAt` stamped, after the run's row was created
   (ruling 119), or, on a task delivered as files, its `deliveredAt` stamped then (ruling
   119). A moved head does not restart the ceiling of 12 react hops since a person
   last acted (`OPERATOR_REACT_HOP_CEILING`, 489(d)); an approve does. At the ceiling no
   react follows and the stuck-loop packet opens. A completion that raised the review-deadlock packet does not react
   (ruling 94). With no react, a repeated reply (no progress) or the depth cap opens the
   stuck-loop packet unless the task is already acceptable (ruling 119); either way
   waiting → human. The depth-capped packet quotes the report's first paragraph, names the
   head and whether it is delivered and the last gate result, and over a committed head
   nothing delivered recommends `deliver_for_review` (ruling 119). Auto-transition chains
   are capped at 8.

Comments addressed to agents route by handle (`agent-reply.server.ts`): `@operator` →
`@agent` (the deliverer) → a named specialist (name or id) → a single backend
candidate; an ambiguous backend handle routes to nobody. Reserved handles: `operator`,
`agent`, `claude`, `codex`, whose one home is `RESERVED_MENTION_HANDLES`
(`app/ui/mention-spans.ts`); the mention fan-out also skips `controller` (ruling 247). The
resumed session is the latest run matching profile, kind and backend that is not marked
session-missing; the reply preview is capped at 1 200 chars and workspace paths are
normalised.

### 4.5 Scheduled runs

`schedules[]` in `task.md`: `scheduleTaskAction({ dueAt, action: run-operator | run-agent,
profileId?, prompt? })` (future only, not on a closed task, i.e. terminal stage or
archived (ruling 52), profile must be deployed; audit
`task.schedule.created`/`cancelled`), reached from the task page's run controls and,
ruling 264 (pass 35), the controller's `schedule_task_action` / `cancel_task_schedule`
under the same `run-agents` tier and bounds, and, ruling 125, the operator's own tools of
the same names for the task it runs on, gated like its immediate dispatch (a `direct`
`dispatch-agents` grant; an agent it could not dispatch now is refused). An entry written
under the operator's authority reads `createdBy: "operator"`, and at fire time its
`run-agent` arm passes no `directiveFrom` or triggerer (no person asked for it and none is
tagged), and its `run-operator` arm passes `scheduledByOperator`. `startScheduleRunner` fires at boot and every
60 s: it claims in the file (lease = clone timeout + 5 min, 3 retries), skips moot
schedules with an outcome (`skipped-done`, `skipped-archived`), leaves a `run-agent`
occurrence pending for the tick while the same profile has a live run on the task, fails a
`run-agent` entry with no profile, starts the agent (`400` → failed, `409` → back to
pending) or runs the operator with `trigger: scheduled` and `scheduleId`, and audits
`task.schedule.fired`. The outcomes a `run-operator` occurrence can end with: `claimed`
(the claim-time row), `skipped-done` (terminal stage), `skipped-archived` (the task or its
project is archived), `skipped-held` (ruling 115), `skipped-packet` (ruling 115: a
decision packet is open, the same refusal a person's Run operator gets), each skip carrying
`refusedAtStart: true` when the operator refused at start, and `queued-behind-drive` (the
run waits behind a live drive; a refusal at the front of the lease queue then writes the
final `skipped-*` row with `atDrain: true` and a "Scheduled action skipped" note). A
closed task's note names the closure the run met, the board's own name for its terminal
stage or the archive, at claim time and at start alike (ruling 52). An occurrence that an
archive or a person cancelled while it was being driven gets no final row: the cancel
wrote its last record. A `run-agent` occurrence fired into a backend the
instance knows is out of quota (ruling 151) retires `fired` with outcome `held-quota`
and `rescheduledAs: <the hold's own schedule id>`: the dispatcher already wrote the
"Dispatch held" note and put the retry on the schedule, so the occurrence spends no retry
and is never deferred as a 409 would be (that would mint a fresh hold and a fresh schedule
row every tick). None of the skips spends a retry. A schedule pins no backend or autonomy
(ruling 108). The same tick also runs the stranded-state sweep (ruling 122,
[operator.md](operator.md)).

## 5. The capability catalog

`UNIFIED_CAP_CATALOG` in `app/shared/capabilities.ts` (31 ids); modes `direct | recommend |
human | off`. The Enforcement column is `capabilityEnforcement(id)`: `both`, `claude-only`
(`CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`) or `advisory`; the operator rows are enforced by
the operator's own `gate()` (`operator-authority.server.ts`).

| id | Kinds | Default | Enforcement | Notes |
|---|---|---|---|---|
| `dispatch-agents` | operator | direct | operator gate | absent ⇒ granted |
| `generate-packets` | operator | direct | operator gate | |
| `append-typed-events` | operator | direct | operator gate | |
| `stage-transitions` | operator | recommend | operator gate | full autonomy promotes to direct |
| `completion-for-acceptance` | operator | recommend | operator gate | `promotable: false`; never promoted |
| `deliver-review-pr` | operator | direct | operator gate | absent ⇒ recommend when a human gates pre-work, else direct (ruling 109) |
| `update-task-branch` | operator | direct | operator gate | absent follows delivery |
| `execute-code-or-write-repo` | agent | direct | claude-only | headline write grant; grant-required; advisory on Codex (ruling 183, §4.3); withholding it also denies the marked org MCP write tools on both backends (ruling 188) |
| `create-task-branch` | agent | direct | claude-only | scoped; grant-required |
| `commit-push-branch` | agent | direct | claude-only | scoped; grant-required |
| `open-review-pr` | agent | direct | claude-only | scoped; grant-required |
| `comment-on-task` | agent | direct | claude-only | gates the mid-run `post_comment` tool; the final report always posts |
| `ask-human` | agent | direct | both | |
| `use-web-search-fetch` | agent, operator | direct | both | absent ⇒ granted; withheld, what the run is told about keeping a source names no page and no `curl`, in the workspace contract and in `keep_source`'s own description (ruling 204) |
| `use-browser` | agent | off | both | direct forces egress direct (ruling 193) |
| `read-github-api` | agent | off | claude-only | `promotable: false`; the PAT never leaves the server, so it is never mounted on Codex |
| `report-validation-verdict` | agent | off | both | grant-required; gates `approve-review`, `request-changes`, `post-quality-flags` |
| `attach-evidence-references` | agent | direct | both | the grant that lets a run save files on its task also lets it keep the sources its result rests on (`keep_source`, ruling 82) |
| `run-unit-integration-validation`, `move-task-to-review`, `read-repo-diff`, `run-validation-suites`, `post-quality-flags`, `approve-review`, `request-changes`, `author-test-cases`, `read-task-repo`, `flag-underspecified-tasks` | agent | direct | advisory | `group: null`: persona text only, no toggle, disclosed as such; `capabilityIsAdvisory` is true and the controller's `get_project` marks each with `advisory: ADVISORY_CAPABILITY_NOTE` (ruling 184) |
| `merge-pull-request`, `transition-to-done`, `change-project-policy` | agent | human | both (always human, `ALWAYS_HUMAN_CAPABILITY_IDS`) | never produce a tool on either side; `merge-pull-request` is also grant-required |

Couplings applied on save (`applyGrantCouplings`): `repairDeliveryGrants` (the headline
is materialised as direct only when absent; an explicit off/human is respected with a
"withheld" notice), then `repairBrowserEgressGrants` (a `direct` browser grant forces web
egress to `direct`). `withheldAgentGrants()` (`app/features/agents/capability-catalog.ts`;
human kept, everything else off) is what an undeployed or grant-less specialist runs with.
`conservativeGrantsFor("agent")` (the catalog defaults with repo write, the scoped
delivery steps and the three verdict outcomes `off`) seeds a template created in the org
editor, which has no capability UI, and a library deploy of a template that stores no
grants. MCP grants are outside the
matrix, except the tools an admin marks as write tools, which a withheld
repo-write grant denies (ruling 188).

**The matrix, the profile panel and the Policy counts count the same capabilities**
(ruling 184). `GOVERNED_CAP_LABELS` (every catalog row with a `group`) is the
partition all three read. The capability matrix modal's grid is the agent editor's groups
plus an "Operator actions" group (the operator's own capabilities); an advisory line
(`group: null`, the three verdict outcomes among them, or a bespoke extra) is never a
grid row. It is listed under the grid in a collapsed "Advisory only · N lines the runtime
does not read", with the profiles that hold it and the mode it is stored at, the way the
profile panel lists them (ruling 184); a line stored `off` holds nothing and is not listed.
Whether a profile's review can approve or request changes is its `report-validation-verdict`
row.

Absent-grant polarity is deliberately not uniform: `dispatch-agents` and
`use-web-search-fetch` absent ⇒ granted; `deliver-review-pr` absent ⇒ derived from
workflow strictness and `update-task-branch` absent ⇒ whatever delivery resolves to
(`absentPolarityGate` inside the operator's `gate()`); every other operator capability
absent ⇒ off; the grant-required family absent ⇒ withheld; every other agent capability
absent ⇒ its catalog default.

**A save cannot revert a write it never saw** (pass 34, B5/U34-3). `updateAgentProfile`
rebuilds the whole governed grant set from the SUBMITTED form, and the editor seeds that
form once, at open time, so a modal opened before a concurrent write and saved after it
reverted every grant that write changed and reported success. Every update carries
`deploymentFingerprint` (`agent-profile-actions.server.ts`) — a sha256 (32 hex chars) of
the deployment's grants (order-independent), extras and definition, NOT of the whole file,
so an unrelated project edit never refuses a save — which the writer recomputes from the
freshly parsed record inside its own lock and refuses on mismatch with "This profile
changed while the editor was open." A refused save writes nothing and audits nothing: it
is a validation refusal like every other one on this path. A create carries none (there is
no prior record); the controller's `update_agent_deployment` sends the fingerprint of the
record it just read, so its own read-modify-write inside one turn is never refused by
itself. The org template writer's propagation checks the same fingerprint
(`template-propagation.server.ts`).

The controller's `update_agent_deployment` validates every capability patch against this
catalogue per KIND and refuses an unknown or impossible id or mode by name before writing
(ruling 261, `capabilityPatchRefusal`): an id outside the kind's toggleable list (an
advisory row is refused as "matrix-only", another kind's id as belonging to it),
`recommend` on a specialist, a non-`human` mode on an always-human id, and
`report-validation-verdict` at anything but `direct` or `off`. The absent-grant polarity
has ONE home, `absentGrantMode` in `agents-query.server.ts`: the roster materialises
absent grants with it and the controller's `list_capabilities` publishes it as
`whenUngranted`, so the Default column above is the create-seed value and never the
runtime's answer for a missing grant.

## 6. Context mounting

- **Skills, Claude** (ruling 185, pass 36): `mountGrantedSkills` builds the run's own
  LOCAL PLUGIN at `<checkout>/../.viberr-plugins/<runId>/` — `.claude-plugin/plugin.json`
  (`name: "viberr"`) plus `skills/<slug>/` copied from the store (no symlinks, no nested
  `.git`, SKILL.md frontmatter rewritten to `name` + `description` ≤ 400 chars; ruling 186
  keeps every store writer from landing an empty, JSON-escaped or unparseable body, so
  what the mount normalises is a skill — the frontmatter schema it reads,
  `skillFrontmatterSchema`, lives with the check in `skill-body.server.ts`) — after
  `stripUngovernedRepoCatalog` has hidden the repo's own tracked `.claude` with `git
  update-index --skip-worktree` and removed it whole. Nothing Viberr writes for a run
  lives inside the tree the project's tools scan (F36-9: the in-checkout mount failed the
  project's own `prettier --check .`), so there is no exclude entry. The run gets
  `plugins: [{ type: "local", path, skipMcpDiscovery: true }]`, `skills: ["viberr:<slug>",
  …]` and `settingSources: []`; the plugin is one per RUN (the directory is named by the
  run id when the row was reserved before the mount, else by a fresh id; the run carries
  the path) and run-service removes it when the run settles, the dispatch when a run fails
  before it starts, as the task's person (ruling 140). Whatever modes the store's skill
  folder carries, every entry of the plugin is made anew with the mode that removal needs
  and never changed once it exists (`copySkillFolder`, `writeNewPluginFile`, ruling
  140): its folders by `mkdir` under the server's umask in the workspace's setgid
  chain (2775), its files group-readable on their own new descriptor (0644, 0755 when
  executable). `cpSync` kept the source's modes, and a store folder's 0755 had left every
  settled run's plugin behind, its files beyond the person's removal (F40-71); a chmod
  walk after the copy would follow a folder an agent swapped for a link. A plugin that is gone by the
  start enables no skill and the persona is corrected (`droppedSkillsNotice`). Residual: a run that never settles in-process (a
  crash) leaves its directory, inert, until the workspace is reclaimed. Canaried inside
  the image 2026-09-11 (SDK 0.3.261 / CLI 2.1.261): the init lists `viberr:<slug>` and the
  model invokes it.
- **Skills as prompt text**: on Codex, for the operator and the controller, for a Claude
  run with no checkout, and for a skill whose name the SDK would not accept
  (`isSdkSkillName`), bodies are injected into the prompt under a shared 24 000-char
  budget (`skill-body.server.ts`); symlinked folders or files are refused. A body past the
  budget is cut with a line at its foot, and the controller's `save_skill` and `edit_skill`
  tell whoever wrote it how much reaches no such run (ruling 186). The controller's own turn
  reads its skills under 40 000 (`CONTROLLER_SKILL_BUDGET`) and draws its guide from that
  first, so the guide this repository ships arrives whole whatever is attached beside it.
- **The writing guide** (ruling 187): the operator's and the controller's prompts
  close their static block with `HUMANIZER_PROMPT_SECTION`, the Humanizer skill vendored
  unchanged in `app/server/runtimes/humanizer/` (MIT, pinned by hash,
  `humanizer.server.ts`). It is not a store skill and no profile grants it, so it spends
  none of the budget above, and no grant list, plugin or `run_inputs` skills row names
  it. Every specialist run carries the same guide as `HUMANIZER_SPECIALIST_SECTION`, the
  last part of its static block on both backends, under a framing of its own: the prose
  it writes includes the task's result, a person's own writing (samples, or a voice guide
  made from them) outranks the guide, and a run that reviews prose a person will read
  holds it to the guide and says what it found in plain words.
- **The persona's order** (ruling 169): `buildSpecialistPromptPrefix` returns the persona
  as a static block (definition, the native-skill banner, the attached-resources banner,
  injected skill bodies, the knowledge-base notes and indexes, the MCP governance rules,
  the GitHub read section) and a per-run tail (the servers that failed their probe or
  did not mount, the attachments drop and the browser section — both carry the task's own
  directory — and the grants whose content did not arrive), every list sorted by name;
  Codex receives the same text joined (`joinedPrompt`). Two tasks of one profile therefore
  produce a byte-identical static block, which is what the Claude preset's
  `excludeDynamicSections` caches once (ruling 170).
- **Knowledge bases arrive as an INDEX** (ruling 205, `kb-injection.server.ts`): each KB's
  text files under `kb/<dir>` (depth ≤ 32, no symlinks, no dotfiles) are listed in
  code-point order with their size class and heading outline (outline budget
  `KB_INDEX_OUTLINE_BUDGET` 4 000 chars per KB, at most `KB_INDEX_MAX_DOCS` 200 documents
  named, the rest counted) and the folder's path on disk; the text is not in the prompt.
  The size is a 1-2-5 class ("2k to 5k chars", `kbSizeClass`, ruling 204), not the byte
  count, so a correction to a document's body leaves every static block that carries the
  index, and so every cached prefix on the project, as it was. `KB_INDEX_NOTE` tells the
  run to read what it needs: `read_knowledge_doc {kb, path}` (the specialist, operator and
  controller toolkits, one implementation, `readKbDocForRun`, only the KBs attached to that run,
  one document in pages of up to `READ_PAGE_BYTES` (32,000 bytes of UTF-8, ruling 215), each
  saying which characters it holds and the `offset` to read on with), or,
  on Codex, which mounts no Viberr tools, the file itself at the printed path (the
  workspace contract allows those reads, ruling 217(a); `kb/` stays readable, and never
  writable, to the agent's own OS user, ruling 15). A grant decides what a run is
  given, not what it can read: every agent of a person runs as that person's uid, so any
  of them can read an open knowledge base from its shell. A private one (ruling 209) is
  a folder the server keeps 0700 (`isPrivateKbFolder`; set with `save_knowledge_base`'s
  `private`, shown on the Instance settings row, never widened by the boot layout
  check): its index says to read it with `read_knowledge_doc`,
  `knowledgeBaseReadDirs` leaves it out of the workspace contract, and a Codex
  specialist reads it through `viberr_knowledge`, a server Viberr's MCP gateway answers
  itself over the run's token (ruling 216, `knowledge-tool.server.ts`). Every Codex
  specialist that holds a knowledge base mounts it, fresh and resumed: `read_knowledge_doc`
  and `correct_knowledge_doc`, the same reader, writer and refusals as Claude's toolkit,
  over exactly the knowledge bases the run was given, a correction written as the run's
  agent on its task. With the gateway not running, a Codex run gets a private knowledge
  base as an unresolved line with the reason. `KB_PRECEDENCE_NOTE` (repo
  conventions outrank KBs, ruling 206) is emitted only when an index is present. All three
  runtimes assemble the block (the attached-resources banner, injected skill bodies, these
  notes, the indexes) with one helper, `attachedResourcesBlock`, and pass only their own
  banner wording (the specialist adds its "When a knowledge base and the repository
  disagree" section); `kb-prompt-block.server.test.ts` pins its bytes, which the cached
  prompt prefix depends on (ruling 169). A KB that arrived only partly or not at all is
  named with its document under "Attached resources that did NOT fully reach this run"
  (ruling 205).
  Supporting runs inherit the deliverer's KBs, deduplicated (ruling 207). A project
  may name ONE knowledge base as its rulings (`project.md` `rulingsKb`, set by the
  controller's `set_project_rulings_kb`): `withProjectRulings` appends it, deduplicated,
  to every KB list the project builds, each specialist, the operator and a controller
  conversation scoped to the project (ruling 208(a)); its index carries
  `RULINGS_BINDING_LINE` and the prompt `KB_RULINGS_NOTE`, which names when to read it
  (ruling 208(b)). The operator's and controller's prompts also carry
  `RULING_NAMESPACE_NOTE`: a ruling number in a tool description is Viberr's own, a
  project's rules number from 1 in its knowledge base (ruling 208(c)).
- **Grants mount from the deployment's copy, never from the template** (ruling 177,
  pass 35): a library deploy copies the template's `resources` onto `project.md`
  `agents[].definition.resources`, and `effectiveProfileView` reads that copy first;
  only a deployment that carries no definition (the seeded rows) resolves the template
  live. A template edit therefore changes nothing a run mounts until the copy is
  rewritten (the template writer's `propagate`, the org modal's box, or an org admin's
  "Use the template's grants" on the Agents page), and the roster marks a copy whose
  grants differ with the exact difference (`templateDrift`). The button replaces the
  copy's three lists, so it opens a confirm ("Template grants dialog") that names what
  the press removes and adds, and the toast repeats both (ruling 326). The operator's
  template is a source like any other (ruling 177): an operator run mounts its copy's
  lists, and `propagateTemplateResources` refuses only a profile with no template. The
  profile editor says a save "forks" the profile only while the copy still resolves some
  field from the template live (`tracksTemplate`: a definition-less deployment, or one
  whose definition leaves a field a save writes unset); a copy that already holds its
  snapshot (a library deploy, any earlier save) is told the save updates it (ruling
  177). The copy's persona is a
  snapshot too: it changes through the Agents page editor, `update_agent_deployment`'s
  `persona`, or a template save that changes the persona with `propagate` (the org
  modal's box), which rewrites every copy still running the older text (ruling 177).
- **MCP servers**: an org registry row with no credential resolves to stdio
  `{command, args}` or http `{type: "http", url}` and the CLI connects to it directly. A
  row WITH a stored credential (a pasted one, or an OAuth sign-in's tokens, ruling 192)
  never reaches an agent process (ruling 191, F40-2, F40-3):
  it resolves, on either transport and on both backends, to `{type: "http", url:
  "http://127.0.0.1:<port>/mcp/<name>"}` on Viberr's loopback MCP gateway
  (`app/server/mcp-proxy/gateway.server.ts`), and `startRun` — the one funnel every
  specialist, operator, controller and resumed run goes through — mints ONE random
  256-bit token for the run (`bindRunToMcpGateway`) and adds `headers: {Authorization:
  "Bearer <token>"}` to each such mount. The token is bound to the run id, the exact
  server names the run mounts and the write tools it withholds on each; it is revoked on
  every path that ends the run (the settle — which stops its calls when the process exits
  and revokes it once a completion compaction, which lists the same servers to keep the
  cached prefix, is done — an interrupt with or without a live handle,
  a queued run the drain drops, a launch that throws) and dies with the process, and the
  gateway also refuses it once the run's row is no longer running or queued and no
  compaction of its session is in flight (ruling 175). An unknown,
  revoked or wrong-server token gets a 401 with a JSON-RPC error and nothing is
  forwarded. A run that sends one call and gets one answer (an error included) 100 times
  within 60 seconds is stopped (ruling 158(b), `repeatedCallStop`): the hundredth call is
  answered `[stopped] …` with `isError`, and the run service ends the run failed as
  `tool_loop`, its error line naming the tool, the server and the answer
  (`stopRunForToolLoop`). A script in Codex's code mode calls tools at machine speed
  between two model turns, and nothing else bounds it; a poll once a second never reaches
  the bound, and a call whose answer changes is a new call. The gateway speaks MCP to the run (Streamable HTTP, SDK server transport)
  and MCP to the real server with the credential attached in the server process
  (`app/server/mcp-proxy/upstream*.server.ts`): an HTTP server over Streamable HTTP with
  `Authorization: Bearer <credential>`, falling back to the legacy SSE transport on a
  4xx other than 401/403; a stdio server is a command the SERVER spawns (its own uid, the
  secret-filtered env plus `MCP_CREDENTIAL`, a process group of its own), one upstream
  per (run, server), killed at revoke — and at shutdown, even mid-handshake. An HTTP
  upstream that ends the session the gateway holds (a 404, or the 400 of servers built
  from the SDK's examples, to a request that carried it) gets a new session and the
  request is sent again, once; the run's own session never notices. An HTTP server an org admin **signed in with
  OAuth** (ruling 192) takes the same road: its tokens are sealed beside the registry row
  (`oauth_ref`), and the gateway (and the health probe) ask
  `mcpOAuthTokenSource` — bound to the endpoint its connection was opened against, so a
  connection to an endpoint the row no longer names is handed nothing and the gateway
  reconnects to the new one — for the access token on every request — renewed with the refresh
  token when it is within a minute of running out and once after an upstream 401
  (single-flight per server, so two runs spend a rotating refresh token once), then
  re-sealed. A renewal the authorization server refuses ends the sign-in — only while the
  refused tokens are still the stored ones, so a sign-in that landed meanwhile stands —
  the tokens are dropped (and the client registration too when the server refused the
  client itself, `invalid_client`, so the next sign-in registers again), the row reads
  "sign-in expired: an admin must sign in again" with the
  server's words, `org.mcp.oauth_failed` {stage: "refresh"} is audited, and the run's
  call fails with that sentence; a renewal that fails for now (unreachable, a 5xx,
  `temporarily_unavailable`) is reported and keeps the sign-in. A server that answers
  the MCP authorization challenge and holds no token (or whose sign-in expired) is not
  mounted at all: the run's prompt names it with that reason instead of a server that
  answers every call 401. What a sign-in was GRANTED is public (ruling 192): the token
  reply's `scope` (or, when it names none, the scope asked for) is kept in `oauth_json`,
  replaced by a refresh that names one and cleared by a sign-out or an expiry, and one
  classifier (`isWriteScope`, `app/shared/mcp-oauth.ts`: a write is any scope whose
  action is not `read`, `metadata_read`, `monitoring` or `report`, other than
  `offline_access`) summarizes it everywhere as "read-only · 194 scopes" or "194 scopes ·
  12 writes". A run's prompt names each signed-in server's grant, and a read-only one adds
  that the server refuses any call that writes. The prompt carries only that summary; the
  scopes themselves come from `viberr_connection_grant`, one tool the gateway adds to the
  `tools/list` of each connection signed in with OAuth and answers itself
  (`grant-tool.server.ts`, ruling 192, F40-66): the sign-in's expiry and the granted
  scopes, writes and reads listed apart, or that the server did not name them. It reads the
  row's public half, so it carries no token; it is never forwarded upstream, needs the
  run's token and is refused once the run's calls close like any call, and is never
  withheld or audited as a write. A known grant's line in the prompt tells the agent to call
  it before assuming a write will be refused or accepted. When a call through the gateway meets an
  upstream authorization refusal (an HTTP 401 or 403, a JSON-RPC error, or an `isError`
  tool result that says authentication or authorization, as Cloudflare's "10000:
  Authentication error" does) and the grant has no write, the run's error gains "This
  connection's sign-in granted read-only scopes (N); an admin must sign it in again with
  write scopes in Instance settings → Agent resources." after the upstream's own words,
  which stay untouched. The next sign-in asks for the admin's Requested scopes
  (`oauth_requested_scope`) when set, else the resource's advertised `scopes_supported`. The Agents page says the same before any run (ruling 184):
  `buildResourceCatalog` carries a `warning` on each MCP item a run would not get tools
  from, read off the registry row the Settings list renders ("needs sign-in", "sign-in
  expired", "credential unreadable", or "unreachable" for a failed last check, which is
  mounted and flagged down), and a profile's granted chip for that server is marked the
  way a missing one is, with the remedy (an org admin, Instance settings → Agent
  resources) in its title and its text. It forwards `tools/list` (withheld write tools
  removed, the grant tool added on an OAuth-signed-in connection), `tools/call` (a withheld
  one refused with `mcpWriteToolDenyReason`),
  resources and prompts when the upstream declares them, and `list_changed`
  notifications; a timeout (5 minutes a call, reset by progress) or an upstream error
  comes back as a JSON-RPC error naming the server. A stdio server that exits mid-call
  answers the call with its own exit and stderr (the run's session then 404s and it
  re-initializes onto a fresh process), and one that prints a single message over the
  SDK's 10 MiB stdio line limit is stopped and its calls fail saying so — nothing a
  child prints can throw out of the server's stream listener. Every forwarded call is logged at
  info (run id, server, tool, duration, outcome; never arguments or results), and a call
  to a tool an admin marked as a write tool is audited `task.agent.mcp_write_call` under
  the run's actor (the agent, the operator, or the asker as the controller's
  instrument). The prompt names a proxied server in one sentence (`gatewayMcpSection`:
  the credential is held by Viberr, the agent never needs or sees it, a 401 means the
  run ended), and each OAuth-signed-in one in a line with its grant (`oauthGrants` on the
  resolution, ruling 192). A gateway that is not listening leaves a credentialed server unmounted,
  with that reason in the run's prompt. Reserved names are skipped; a missing row is
  reported "unresolved"; an unhealthy row is still mounted but flagged; a credential that
  cannot be opened drops the server; stdio servers get a real discovery handshake, WITH
  the credential on both backends, before the run and are dropped (and marked
  unreachable) on failure. The handshakes start in mount order and run two at a time,
  each with its own 20 s limit, and two mounts of one command never at once
  (ruling 190); each verdict is applied in mount order as soon as every earlier
  server's is in, so for the same verdicts the mounts, the registry rows, the log lines
  and the prompt read as a one-at-a-time check left them. Two things differ. A later
  server's handshake can end while an earlier one is still running, and its failure is
  written only once the earlier verdict is in, so a Retest pressed in between is
  overwritten by the older failure, where a one-at-a-time check would only then have
  started that handshake. And every credential is read before the first handshake
  starts, so a credential re-seal that failed is logged before the verdicts, not among
  them. A verdict whose registry write fails fails the run start and ends the check
  there, as the one-at-a-time check did: nothing after it is applied, logged or spawned.
  A handshake that timed out on a visible install (a first-run or `@latest` download)
  also starts the background install a Retest starts (ruling 190, ruling 189's
  `startMcpWarmup`), so a later run finds the server installed; the run's prompt says so.
  Every grant that produced no usable server is listed in the prompt with the reason its
  own probe returned and an instruction not to infer another cause
  (`unavailableMcpSection`, `specialist-mcp.server.ts`, shared by the specialist and
  operator prompts, ruling 190); the run record keeps the names. On a run that withholds
  repo write, and on every operator run, a server's marked write tools are withheld
  (ruling 188, §2.4, §2.5): the persona's MCP governance paragraph then names only the
  servers with no marks, a short section names the gated servers as mounted and lists the
  removed tools, and the run-inputs `mcp` row lists them too. Precedence when names
  collide: org < browser < toolkit. Reserved names: `viberr`, `viberr_agent`,
  `viberr-agent`, `viberr_browser`, `viberr-browser`, `viberr_controller`,
  `viberr-controller`, `viberr_knowledge`, `viberr-knowledge`, `viberr_ops`, `viberr-ops`.
- **Browser**: `viberr_browser` = `@playwright/mcp` cli.js run with `process.execPath`,
  `--headless --isolated --no-webmcp --output-dir <attachments>` (`--no-webmcp`: a page's
  WebMCP tools never reach the tool list; + `--image-responses omit` on
  Codex, + `--executable-path $VIBERR_BROWSER_EXECUTABLE --no-sandbox` when set), under
  `browser-supervisor.server.ts --deadline-ms 90000` (ruling 193): every tool call has a
  90 s deadline, and a call past it gets every waiting request answered with a sentence
  saying the browser was restarted, the server and its browser ended, and a fresh server
  handed the client's handshake, so a page that stops answering costs the agent its tabs,
  not its browser. A cancelled call stays timed only as a check (restart when the browser
  answered nothing since and another call has itself waited 30 s behind it). The
  supervisor exits only once its last output has left stdout. Codex waits 120 s on this server
  (`tool_timeout_sec`) so the supervisor's answer is the one the model reads, and the
  persona states the deadline.
  Requires effective `use-browser: direct` **and** `use-web-search-fetch: direct`, the
  package and the supervisor on disk and, when `VIBERR_BROWSER_EXECUTABLE` is set, that
  binary. `/resources/health.browser` is the instance-level probe.
- **Page capture** (ruling 194; `page-capture.server.ts`, `page-capture-child.server.ts`):
  the same pinned browser, driven by Viberr itself and not by an agent, with no grant.
  The renderer is a script Node runs as TypeScript, started through the ruling 139
  launcher as the TASK OWNER's agent uid (`taskOwnerLaunch`, `runPersonCommand`: its own
  process group, `filteredSpawnEnv()`, the person's `$HOME`, a temp folder in its scratch,
  `VIBERR_RUN_ID` for the sweep; SIGTERM at 10 s plus 25 s a page, then the group killed).
  With isolation on and no owner nothing is rendered; with no launcher (the host dev
  server, tests) it runs as the server's own user, as runs and gates do. It serves the
  page and its sibling files from a loopback server on a random port under a random token
  path, one file name deep, opened without following a link, and loads it over http, so a
  page cannot pull a `file://` resource into the picture. What a page asks that server
  for and is not served is reported and said in the note and the tool's reply: a name
  that is not among the files, a name with a broken escape, and a path outside the
  token (from the site's root, or above the page's folder), all but the browser's own
  `/favicon.ico`. It starts one Chromium per page
  over `--remote-debugging-pipe` with `--headless=new --no-sandbox` (the sandbox cannot
  start in the image, which is why this is never the server's process) and
  `--proxy-server=http://127.0.0.1:9 --proxy-bypass-list=<-loopback>;127.0.0.1:<port>`:
  every request but the page server's, loopback included, goes to a closed port, and the
  page's own response carries `default-src 'self' data: blob: 'unsafe-inline'
  'unsafe-eval'`. Scripts run, with no network, on an origin that holds no cookie. Each
  width loads the page afresh (1280 by 800; 390 by 844 as a phone), walks it top to bottom
  so lazy content is drawn, and takes the page from the top to the view's cap with
  `captureBeyondViewport` and a clip, which leaves the layout alone (a `100vh` section
  stays one screen). A markdown file is first set as an article with react-markdown and
  remark-gfm, raw HTML left as text. A page past 25 s is stopped with its browser and the
  next one starts. The server reads back `out/report.json` and each PNG through
  `readAttachmentBytes`, and keeps a picture only when its own header says PNG at the
  view's width. A page that opens `alert()`, `confirm()` or `prompt()` would wait on its
  dialog for the whole 25 s: each is dismissed and counted, and the note and the tool's
  reply say the page opens one. A kept delivery's files are the server's own, which an
  agent uid cannot read, so a delivery's job first copies them (each up to 25 MB, 200 MB
  in all) into `<task>/.capture-input/<captureId>/`, beside `deliveries/` and not under
  `workspace/`: the server writes no file inside a tree an agent can write (ruling 140). The folder and its parent are the server's own, 0710 in the agent group, each
  file made new by descriptor and 0640, so the renderer reads a file by the name it is
  given (the job carries the names, and reaches the renderer on its standard input, since a
  delivery of thousands of files is past what the kernel takes as one argument) and lists
  and writes nothing there; a folder that
  cannot be made so is each page's reason for no picture, and the copy goes when the
  render ends. The renderer's own scratch is `<task>/.captures/<run>/<captureId>/`, in
  the task's own directory too: `.captures/` and the run's folder (`no.run` for a
  delivery's own render) are the server's own, 0710 in the agent group, each checked as
  the server's own directory before anything is made, listed or removed below it, so no
  entry on the way can be a link an agent put there. Only the one render's folder, made
  new, is 2770 for the renderer to write; the server reads back from it and removes it
  as the person, the emptied folder with its own `rmdir` (ruling 140(a)). A
  scratch that cannot be made so is the page's reason ("the render's scratch folder
  could not be made"). A page and
  the files beside it are found in whichever Unicode form they are stored (ruling 76's
  rule, restated in the child). Measured in the image (Debian Chromium 154, 2026-10-07):
  1.6 s for an HTML page at both widths in a fresh browser, 1.25 s for a markdown page.
- **Shell inventory** (rulings 148, 42, 204; `shellInventoryPrompt`,
  `app/server/ops/toolchain.server.ts`): every specialist run, operator run and controller
  turn carries "## Shell inventory (measured on this host, not a guess)": the versions
  present and the tools absent among `node`, `npm`, `git`, `make`, `docker`, `pnpm`,
  `yarn`, `curl`, `python3`, `go` (`cachedToolchain()`). Advice is derived from the
  reading: an absent `pnpm` or `yarn` is fetchable with `npx` when npm is present; the
  others come from the operating system and cannot be installed; an unrun check is never
  a pass and never the deliverable's fault. On a specialist run the paragraph also names
  any absent tool its own role description mentions (word-bounded; `go` excluded), so the
  persona and the measurement do not contradict each other in silence. The image ships
  `make`, `curl` and a pinned `pnpm` (from npm, not corepack) and deliberately no Docker
  (`Dockerfile`), and `poppler-utils` so a PDF an agent delivers or judges
  can be rendered and looked at (`pdftoppm`, ruling 42).

## 7. Workspaces and git

- Layout: `projects/<slug>/tasks/<KEY>/workspace/<repoName>` (deliverer and operator,
  shared), `…/workspace/support/<profileId>/<repoName>`, Codex operator scratch
  `<taskDir>/.operator-scratch`, attachments `<taskDir>/attachments/`. The
  store-relative spelling here is a display form (ruling 198); an agent is only ever
  handed the absolute path, and a delivery whose tree carries `projects/<slug>/tasks/`
  is refused.
- **Shared between the server and the agents' users (ruling 15).** The directories a run
  writes — a task's `workspace/`, `attachments/` and `.operator-scratch/`, and
  `runtimes/controller-scratch`, `uv-cache`, `uv-python` — are `node:viberr-agents` 2770
  (`shareDirWithAgents`, called where each is created, a resumed reply's `workspace/`
  included, ruling 15; boot hands an older tree over once, recursively). setgid keeps whatever either side creates inside in the agent group; the
  agent's umask is 0007 (the launcher sets it) and the server's is 0002 (set at boot when the
  launcher exists), so a file the server's clone checks out is one an agent can edit and a
  file one agent writes is one the delivery (the owner's uid) can commit. Nothing else the server
  writes is in the agent group (its own files are `node:node`), so the canonical
  `task.md`, `project.md`, knowledge bases and skills stay readable and unwritable to an
  agent. A task's `sources/` is the same (ruling 15): it is not one of the shared
  directories, the server creates it and writes it, and an agent reads a kept source and
  cannot change or delete it. That is what "never overwritten" rests on where agents run
  as their own users; on a host with no launcher an agent runs as the server's user, and
  only the writer (`writeTaskSource`, which never opens an existing bytes file) keeps a
  source as it was. A correction an agent proves goes through the server instead, which writes it into
  the document, keeps the record and lets a person undo it (ruling 210, §4.2). Git refuses a repository another uid owns, so the image's SYSTEM git config
  (`/etc/gitconfig`, root-owned, which no agent can edit) carries `safe.directory=*` and
  `core.sharedRepository=group`; it binds the server's git, an agent's shell and a tool that
  clears its environment alike.
- **Who runs git (pass 40 review, R-seams-1).** The server never executes git with an
  agent-writable repository as its working repository under its own uid: an agent can write
  any checkout's `.git` (hooks, `core.fsmonitor`, a filter or credential helper,
  `url.insteadOf`), and the server's git there ran them as `node` with the server's
  environment. So every git IN a workspace — the pre-run refresh (ruling 195), the unborn
  checkout's check (ruling 227), the supporting clone of the delivering checkout, the
  origin rewrite and identity, the `.claude` strip, the review pin, the delivery's
  status/add/commit and gate reads, the branch update's merge and abort, the reconcile's
  reads, the discard, the operator's default-branch fallback read — runs as the task
  owner's agent uid through the launcher (`taskWorkspaceGit` → `agentGitLaunchFor`, the
  agent's `$HOME`, no credential in its env); with no launcher (dev, tests) the same git
  runs as the server, as before, and with isolation on and no owner to name it refuses
  rather than fall back. What needs the PAT runs as the server in a repository it owns:
  the mirror, or a per-operation bare **stage** (`withServerStage`,
  `projects/<slug>/.repo-stage/`, readable by agents, never writable, borrowing the
  mirror's objects under its lock), which fetches GitHub's refs for the workspace to fetch
  from and takes the delivered branch out of the workspace through the launcher's
  `git-upload-pack` before pushing it (github-delivery §1). A new checkout is cloned by
  the server into a stage of its own, handed to the agent group (a file hardlinked from
  the mirror stays read-only) and renamed into place (`cloneThroughStage`). Every git the
  server spawns, as itself or as a person, carries `core.hooksPath=/dev/null` and
  `core.fsmonitor=false` at command-line precedence on a `filteredSpawnEnv()` base
  (`serverGitEnv`); an agent's own git keeps its hooks. `gh` (the reconcile's PR lookup)
  runs as the server but in the task's directory, never the checkout. The server's own
  non-git work — the stdio MCP probes, reading transcripts — stays `node`.
- **Who removes a tree (ruling 140).** A tool an agent runs can leave a directory only its
  uid can enter (wrangler's `mkdtemp` dirs are 0700); the server's own recursive remove
  then deleted what the group could, `.git` first, and died on the rest (F40-62), leaving
  a checkout no later clone could land in. So every removal or replacement of a tree an
  agent can write — a supporting checkout's replace, an unfinished clone, a clone
  destination in the way, a gate checkout, a finished task's `workspace/`, the stripped
  `.claude`, a run's skill plugin, a Codex run home, the seed's reset of a task's shared
  directories — goes through `removeAgentTree` / `removeAgentTreeSync`
  (`runtimes/agent-trees.server.ts`): `chmod -R u+rwX` then `rm -rf --`, absolute binaries,
  through the launcher as the task owner (`taskWorkspaceLaunch`, the launch the
  workspace's git uses) or, for a run home, the run's own launch. What that leaves is
  another uid's (a task whose owner changed): the server reads the owners it can see in
  what is left and removes as each of them, opening their entries to the group
  (`g+rwX`) so a deeper layer shows on the next round, three rounds at most. What the
  server itself wrote there no agent pass can remove (ruling 140, F40-71: a skill plugin
  copied at the store's 0755, the `workspace/` root in a task directory only the server
  writes), so when the passes leave entries the server opens its own to their group
  (`chmod -R -P g+rwX`, `-P` so it follows no link, not even the tree's own; a GNU chmod
  older than coreutils 9.5 has no `-P`, and there the step runs without it only when no
  agent can write the folder holding the tree, ruling 140(a)) and the
  person's pass and the rounds run again; when they leave an empty directory the server
  owns, the server removes it with `rmdir`. The server never runs `rm` there, and neither
  step runs while a directory above the tree is a link an agent could have put there (one
  an agent uid owns, or any link in a folder an agent can write, a link the server's own
  clone checked out included). A tree still
  there is a fault naming the path and the errno ("EACCES on …/dev-1wnDsF"; GNU rm names
  itself by the absolute path it was run by, which the reading drops). With no
  launcher the same two commands run as the server and nothing else; with isolation on
  and no owner to name the removal refuses and nothing is removed. A checkout with no `.git/HEAD` found when a
  run (or the operator) prepares its checkout is removed as its person and cloned again,
  so a tree an older build half-removed heals on the next run. Every local step of
  preparing a checkout (the removal, the directory, the clone of the delivering checkout,
  the origin rewrite, the strip) fails as a `workspace_fault` with `credential:
  not_involved` and a sentence that names the path and the OS error and nothing about
  access (ruling 197's note).
- Mirror (ruling 195): bare `projects/<slug>/.repo-mirror/<owner>__<repo>.git`, `fetch
  --prune` with a heads-to-heads refspec before each clone (timeout 120 s, rebuilt after
  2 consecutive failures), then a local hardlinked clone (in a stage, then moved into the
  workspace) with `origin` rewritten to the credential-free
  `https://github.com/<repo>.git`; a shallow direct clone (into a stage too) is the
  fallback. The mirror is the server's alone: boot takes group and other write off every
  mirror file and puts it back in the server's own group (ruling 140: a removal's
  `chmod -R -P g+rwX` can reach a checkout's object linked from the mirror, and opens it
  only to the group it is in), and a hand-over never widens a file with a second link.
- Credentials never touch argv or `.git/config`: the PAT is delivered through
  `GIT_ASKPASS` (`x-access-token`), `GIT_TERMINAL_PROMPT=0`, credential helper reset.
  Clone timeout 15 min (`VIBERR_GIT_CLONE_TIMEOUT_MS`); progress is streamed to the run
  strip ("Receiving objects" 0..90 %, "Resolving deltas" 90..100 %).
- Retention: workspaces of tasks in the terminal stage are removed at boot (after run
  recovery, only when no run is live) and on every maintenance pass, each as its task's
  owner (ruling 140; a task with no owner keeps its workspace while isolation is on), the
  emptied `workspace/` root, the server's own, by the server's `rmdir`; transcripts and
  session homes older than 30 days are pruned (`VIBERR_TRANSCRIPT_RETENTION_DAYS`,
  `VIBERR_SESSION_HOME_RETENTION_DAYS`, `0` = forever).

## 8. Boot recovery

First of all, right after the projection opens, `bootAgentIsolation` (ruling 139,
`agent-isolation.server.ts`): with a launcher present it sets the server's umask to 0002,
enforces the store layout (`enforceStoreLayout`: the root 0750 in the agent group, `state/`,
`audit-exports/` and the raw run logs 0700, `runtimes/users/` 0710, `agents/`, `kb/`,
`skills/`, `projects/` 0755, the shared directories of §7 2770, every task's pre-isolation
workspace handed over once), hands each person's runtime root to their uid (whole when it
is not yet theirs, else just the two vendor homes), and probes the store as the reserved
uid below the range: refused → `on`, readable → `degraded` (a bind mount; health names
it). Without a launcher it only records `off`. It never throws.

Before the chain, boot runs `repairCodexRolloutPaths` once (ruling 145, §2.2): every Codex
thread still indexed under a removed per-run home is re-pointed at the file in the shared
`sessions/` tree. Then `reconcileRestartedWork` (fire-and-forget after the watchers start;
`app/server/boot.server.ts`, `run-recovery.server.ts`):

0. `finalizeOrphanedRuns`: first, the completion compactions a restart cut on runs that
   had already finished (ruling 175): a terminal row that still carries the phase
   "Compacting context" with the step "after the run ended" has its compaction's process
   swept, a Codex compaction's private home finished against the account the run billed,
   and the mark cleared; the session keeps its size. Then `running|queued` rows →
   `interrupted` with
   `interrupted_reason: "restart"` (`interrupted_by` untouched: a person or null; the
   pill and footer say "interrupted by a restart", Insights counts the run as stopped and
   leaves a never-started one out of the completion rate). An orphaned Codex run's
   private home is finished the way its settle would have (auth write-back, directory
   removed, thread paths re-pointed; ruling 145), and the orphans' run ids are swept
   (ruling 142, §3.4): a Claude CLI leads its own group, so a server that died without
   shutting down did not take it along — in the image the launcher's PDEATHSIG now does
   (ruling 139), and the sweep, through the launcher's `--reap`, finds what a SIGKILLed
   launcher's agent had already detached. Each specialist or review run that had started
   first gets the completion effects a person's Stop gives it (`state: "interrupted"`,
   replayed, ruling 163(b)): its last words and the files it saved are posted under its
   name. They are its work in progress and never the delivery (ruling 85): only a run
   that finished reports one, so `deliveredAt` stays where it was. One
   "Interrupted by a restart" note per task then lists what was running and, separately,
   what was queued and had not started (ruling 163(b)), each agent run by its role, never
   by its kind (ruling 292(b)); then, once every note is written,
   one `runOperator({ trigger: "manual" })` per affected task (controller
   turns get a conversation note instead), capped at 3 per task per 30 min via
   `run.recovery.reinvoked` audit rows. **The cap is decided BEFORE the note is written**
   (ruling 163(c)), so a capped task's note says what Viberr decided, why, and that running
   the operator from the page is the way on, its `waiting` is settled off `agent` through
   `clearWaitingToHuman` (ruling 115) and its owner is notified; the note never promises
   a turn the cap has refused.
1. `recoverUnreactedAgentRuns`: finished specialist runs on tasks still `waiting: agent`
   with no `task.agent.replied` audit row carrying their run id, and runs carrying a
   `run.completion.effects_lost` audit row whatever the task's `waiting` (ruling 163(d)),
   are replayed through the completion pipeline with the persisted `outcome_key`,
   dispatcher and verdict facts (audit `run.recovery.reply_replayed`; at most 3 replays
   per run per 30 min). A replay does not redeliver a refused @mention as a fresh
   directive (ruling 163(d)).
2. `recoverStrandedOperatorPlans`: finished Codex operator runs younger than 1 h with no
   `runtime.operator.plan_executed` audit row are executed.
3. `settleAbandonedWaits` (ruling 164): a live task that still claims
   `waiting: agent` while no run of its own is `running` or `queued`, and that the orphan
   sweep did not already take, has no packet, no `blockedBy`, no queued question and no
   pending schedule, gets a "Left waiting on an absent agent" note and a fresh operator
   invocation; the note reads the task's own last run (no run ever started, a run that
   never got a process, or a run that ended and whose follow-up did not) and says the
   operator is being invoked rather than asserting it ran. If the operator cannot start,
   the task is settled to `waiting: human`.
4. After the re-invokes settle and the orphans' sweep has finished, terminal workspaces
   are reclaimed only if no run is active.

Both marker actions are exempt from the 90-day audit purge for exactly this reason.
Project creation is bounded by a 30 s action watchdog (`withActionWatchdog`, 503 on an
async hang).

## 9. Guardrails and loop bounds

- Comment guardrails (`project.md` `guardrails`, defaults on;
  `comment-guardrails.server.ts`): a body over 200 chars whose line breaks arrived only as
  escaped `\n` is repaired first (`repairDoubledNewlines`, ruling 20); then
  `meaningful-comment` (only strings ≤ 60 chars can be meaningless),
  `no-duplicate-summary`, `evidence-separation` (a fence longer than 12 lines keeps its
  first 3 lines plus a note that the rest is in the agent logs), `compression-threshold`
  (project default 40 events; the module fallback, `DEFAULT_COMPACTION`, is also 40,
  keeping 24). Dropped comments audit `task.comment.dropped`. No length cap (ruling 134).
- Prompt-side rules: task text, comments, repo content and agent reports are data; a
  directive is not an authority grant; a directive asking for delivery posts a policy
  event quoting the matched phrase (§4.1); supporting runs get the read-only paragraph and
  the delivery denies.
- Bounds: operator react depth 4 (an `approve` resets it, and so does a reply
  that moved the task's head, ruling 119), react hops 12 since a person last acted (only
  an `approve` or a person restarts it, 489(d)), transition chain
  8 (counted across re-triggered turns; a live operator run's own moves queue no turn,
  ruling 120, so consecutive `auto` boundaries are walked inside one turn and the
  stranded-stage backstop covers an abandoned chain), carried triggers 8, recovery
  re-invokes 3 per task per 30 min, completion replays 3 per run per 30 min, schedule
  retries 3, Claude max turns 2000, idle 15 min per backend, project-creation watchdog
  30 s, coordination lane `max(1, ceil(cap / 4))` extra slots beyond the run
  cap for operator and controller turns (§3.2, ruling 150).

## 10. Seeded catalog

`SEED_AGENT_PROFILES` (written by `npm run seed` and the demo seed, with their KB grants)
and the shipped base templates, refreshed by hash through `state/shipped-assets.json`
(hand-edited copies kept and warned about): the operator and controller profiles ship as
files in `app/server/seed/assets/`; the Developer and Reviewer templates are generated
from `SEED_AGENT_PROFILES` (`builtinAgentProfileTemplate`, `default-assets.server.ts`)
and the boot backfill writes them with `kb: []`, because it installs no knowledge bases.
The Writer and the Editor (`LIBRARY_AGENT_PROFILES`, ruling 179) are written by the same
two writers and are in the library only: no project's default roster holds them, and a
board gets them when the controller passes them as `agents` or a person adds them.
The Diagrammer and the Cover Designer (ruling 179) ship the same way.

| Profile | Kind | Backends | Model | Stages | Skills / KB | Grants |
|---|---|---|---|---|---|---|
| `operator` | operator | claude, codex | `orchestration runtime` (a sentinel, not a catalog id; falls back to the backend default) | all (`spanAll`) | `viberr-app-expertise` / `architecture-notes` after `npm run seed`, `kb: []` in the base template | direct: dispatch, packets, typed events, deliver; recommend: transitions, acceptance; human: repo write, done, policy |
| `developer` | specialist | claude, codex (Claude first) | `sonnet` | ready, impl | `developer-expertise` / `architecture-notes`, `api-contracts` (seed only) | direct: repo write, branch, commit/push, open PR, comments, ask, browser, egress, advisory items; human: merge, done |
| `reviewer` | specialist | claude | `sonnet` | impl, review | `reviewer-expertise` / `api-contracts` (seed only) | direct: read diff, validation suites, tests, evidence, quality flags, comments, ask, verdict, approve, request changes; human: merge, done, commit/push |
| `writer` (library) | specialist | claude, codex (Claude first) | `opus` | ready, impl | `writer-expertise` / none | direct: repo write, branch, commit/push, open PR (all four withheld on a board made to deliver results, ruling 199), comments, ask, evidence, browser, egress, advisory items; human: merge, done |
| `editor` (library) | specialist | claude | `opus` | impl, review | `editor-expertise` / none | direct: read diff, evidence, quality flags, comments, ask, verdict, approve, request changes, egress; human: merge, done, commit/push |
| `diagrammer` (library) | specialist | claude | `opus` | impl | `diagrammer-expertise` / none | direct: evidence, comments, egress; human: ask, merge, done, commit/push |
| `cover-designer` (library) | specialist | claude | `opus` | impl | `cover-designer-expertise` / none | direct: evidence, comments, egress; human: ask, merge, done, commit/push |
| `controller` | controller | claude | `sonnet` | n/a | `controller-guide` / `controller-handbook` | none (tools are gated by the asker's RBAC) |

The Writer and the Editor are for a task whose result is prose a person puts their name
to. Their manuals (`writer-expertise`, `editor-expertise`) say how such work is done on
any subject: a fact from outside rests on a source the run opened and kept (ruling 82),
code is run, or checked without running and presented as untested, or quoted with its
origin, the first person comes only from the person's notes and answers, the piece tells
what happened in their voice and keeps the writer's evidence about them in the writer's own
note (ruling 179: it does not cite the person's own records at them or quote their own
messages back; a source from outside is still named), a record that grows (a decisions
file, a changelog) is read to its latest entry on the subject, by the writer before it
states what holds now and by the editor beyond the entry cited (ruling 218), a person is
asked once and only what they alone know, their voice is taken from their own writing
and nothing of a sample is carried over, and the page is looked at as its reader sees it
(ruling 194). Each manual stays within half of the 24 000 characters a run with no
checkout is given, so a board's own skill still fits beside it.

The Diagrammer and the Cover Designer (ruling 179) make the pictures such a piece carries.
Neither holds a delivery grant, so each runs as a supporting agent at the stage a board
gives it: the piece stays its writer's delivery, the agent saves its picture on the task and
saves the piece again with the picture placed, and that save moves the review to the
assembled piece (ruling 85). A rework that only replaces a picture moves it too: a delivery
holds the files of every supporting agent engaged on the task that holds no verdict
(`deliveryMakers`, ruling 81, where the delivery is files and not a revision), while a
reviewer's own files still move nothing; beside another specialist run a maker still
claims the file it saved before, and never the deliverer's (ruling 85). Their manuals (`diagrammer-expertise`,
`cover-designer-expertise`) hold the rest. A diagram is drawn only where the piece needs
one, and none is a result; every box, arrow and label comes from the piece or from a kept
source the run opened. A cover shows something from the piece (its command, its number, its
real screen) in the look of the person's earlier covers, with no generated or stock imagery,
no decoration and nothing invented. Each agent draws its picture as an SVG or an HTML page
among the task's files, renders it at the size it names with `capture_page` (ruling 194),
looks at the picture the tool returns (a cover also at a quarter of its size, as a feed
shows it, a diagram at half, about a phone's width), fixes what it sees, makes the picture it keeps with one last call (scale 2 for a diagram,
1.5 for a cover, within 2,000 px a side so it is still shown), looks at that one too, and
copies that PNG onto the task. The picture is what the reviewer judges: each manual says
what the agent does not prove (nothing about a file it did not change, by checksum, kept
copy, diff or a count of lines; no check of its own work written up or kept as a source,
though every finding is reported), that a render is for looking, that the drawing is
finished before the picture is kept, and that only its own drawing and the piece are
pictured, every other file on the task being text. Neither asks the person
anything: `ask-human` is withheld by name, because an absent grant resolves to granted, and
what only the person can supply is a line of the report. The Editor's manual has it open
every picture the piece carries and judge a diagram against the kept sources and a cover
against the piece, naming the file with each finding so the fix goes to whoever made it;
the Writer's leaves the diagrams and the cover to a board's drawing agent where it has one,
and keeps out of its own note what those later pictures would make untrue (a count of the
whole file, a line number of the piece, that the piece has no pictures).

The shipped operator doctrine (`operator.definition.md`, upgraded in place through
`PRIOR_SHIPPED_HASHES`) tells the operator that a wait on other work is a fact with its
own tool, `set_dependencies`, and never a packet (ruling 55).

`ensureBaseAgentsDeployed` runs at boot: the operator is ensured on every project;
Developer and Reviewer are backfilled only into a project with **no** specialists. A new
project gets the operator, Developer and Reviewer, unless the controller's `create_project`
passes `agents` (ruling 266): then the operator plus exactly those library deployments, each
built by `buildLibraryDeployment` (the deploy the Agents page makes) with its `model` and
`effort` checked before anything is written. An empty `agents` is refused, because the
backfill above would put the base specialists back. `remove_agent_deployment` is the
controller's door to the Agents page's Delete (`deleteAgentProfile`), which also refuses a
profile engaged on an open task. Profile
files use `agentProfileFrontmatterSchema` (kind, icon default `cpu`, `resources {skills,
mcps, kb}`); the schema is `.loose()`, so an unknown key is kept and written back, and
raises a drift warning. Deployment overrides (`project.md` `agents[]`) carry autonomy
`supervised | full` and the project-effective grants.

## 11. Gotchas

1. `kind: reviewer` means "supporting run", not "the Reviewer profile".
2. Specialist `recommend` coerces down to `off`; operator `recommend` promotes up to
   `direct` under full autonomy, except acceptance.
3. Codex drops browser images. It no longer drops MCP credentials: a credentialed
   server is a gateway mount on both backends (ruling 191, §6), so the run token rides the
   Codex CLI's argv and the credential stays in Viberr.
4. Foreign-backend models are substituted at start and disclosed: the run log's first
   line, the switched-backend timeline event and the `retry_other_backend` option all
   name the model (F36-8). The run row stores what ran.
5. `RUN_STATE.error` reads "continuity error" only for an UNCLASSIFIED failure: the run
   pill names a classified one ("refused · quota", "refused · account", "backend
   unavailable", "cut off · spending cap", "provider overloaded", "provider
   unreachable"; `runStatePill`) and the footer follows it (§3.7).
6. Codex has no OS sandbox (every thread `danger-full-access`, ruling 144), so a withheld
   repo-write family is advisory on Codex and every surface that shows the grant says so
   (§4.3). What binds there is web search, MCP `disabled_tools` and Viberr's own
   server-side gates.
7. A run's skills live in a plugin directory BESIDE the checkout (ruling 185), removed
   when the run settles; nothing under the checkout is ever a settings source, so there
   is no CLAUDE.md excludes file and no `managedSettings`.
8. Agent backends are connected **per person** on Profile → Agent accounts (ruling 137):
   there is no deployment-wide key, no `CODEX_HOME`/`CLAUDE_CONFIG_DIR` to set and no
   host `~/.codex` mount. A wiped runtime volume signs each person out of their own
   vendor sign-in (a sealed pasted key survives in the database).
9. A supporting Claude run with write grants can commit locally in its own support
   checkout; only push, PR create and PR merge are denied on top of the grants.

The tuning knobs above (turn caps, timeouts, retention, the browser executable) are
environment variables and are listed in
[../operations/configuration.md](../operations/configuration.md); the concurrency cap and
the spending cap are set on Instance settings. The agent CREDENTIALS are neither:
each person connects Claude and Codex on Profile → Agent accounts (ruling 137), and
nothing about a backend account is read from the deployment environment.
