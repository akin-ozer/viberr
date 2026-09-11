# Agents and the run runtime

> How a Claude or Codex process is started for a task, what it is allowed to do, what
> it sees, how its output is stored and streamed, and how the server recovers when it
> dies. Source of truth: `app/server/runtimes/*`, `app/server/tasks/specialist-*.ts`,
> `app/server/tasks/agent-*.ts`, `app/shared/capabilities.ts`, `app/server/seed/*`.
> Verified against `main` @ `68b5480` (2026-09-01); §2.5 and §4.3 re-verified
> 2026-09-02 against `pass32/implementation` @ `478bed0`. Updated 2026-09-02 for
> ruling 127 (branch `claude/per-user-codex-auth-difdnn`): §§2.1, 2.2, 2.3, 3.1, 3.5,
> 3.6, 3.7 and gotcha 8 now describe the per-person credential principal, and the closing
> paragraph no longer claims the credentials are environment variables. Updated 2026-09-06 for
> the Claude Agent SDK upgrade 0.3.220 → 0.3.261: §2.4 (the `permissionPrompts` option, the
> `permission_denied` console line, the task-tool denylist note) and §§2.4/2.5/3.5 (the new
> `overloaded` failure class, read from the SDK's `api_error_status: 529`). Updated the same day
> for the Codex SDK upgrade 0.146.0 → 0.153.4: §2.3 (GPT-6 Astra offered, `max` effort per model,
> `ultra`/`persistent` deliberately not) and the §2.5 re-check of the sandbox carve-out.
> Updated 2026-09-11 for ruling 173: the Cognipeer Agent SDK was evaluated and not adopted,
> so both backends stay on the vendor SDKs this page describes; rulings 174 to 176 (the
> Option D plan, `planning/option-d-2026-09-11/PLAN.md`) update the sections they touch as
> each lands. Updated 2026-09-11 for ruling 174 (branch `option-d/pr1-permissions-and-kill`):
> §2.2 (the run marker every child carries), §2.4 (`allowDangerouslySkipPermissions`, the
> detached CLI, the stop ladder), §2.5 (the marker's two Codex channels), §3.4 (what a
> settled run leaves alive: nothing) and §8 (boot sweeps the orphans' processes). Updated
> 2026-09-11 for ruling 175 (branch `option-d/pr3-cost-cap-usage`): §2.4 and §2.5 (the
> instance's spending cap, `maxBudgetUsd` on Claude, none on Codex), §3.1 (token and cost
> columns folded from `modelUsage`, with a dated correction) and §3.5 (the `max_budget`
> kind). Updated 2026-09-11 for Option D PR 4 (branch `option-d/pr4-alwaysload-once-only`;
> no ruling, the plan assigns none): §2.4 (the `viberr` and `viberr_agent` servers load
> their tools up front, the controller's stay deferred, with the measurement) and §§3.1, 4.2
> (`report_outcome` stages once; a second call is refused and audited). Updated 2026-09-11
> for ruling 176 (branch `option-d/pr2-mcp-tool-gating`): §§2.4, 2.5, 4.3 and 6 (an org MCP
> server's admin-marked write tools are denied on runs that withhold repo write: by name on
> Claude, as `disabled_tools` on Codex; the P13-KM-04 prompt paragraph names only unmarked
> servers). Updated 2026-09-11 for the ruling 101(e) amendment (Option D PR 5, branch
> `option-d/pr5-pretooluse-deny`): §2.4 and §4.3 (the PreToolUse hook that refuses wrapped
> shapes of a denied command, with a reason the model reads). Updated 2026-09-11 for Option D
> PR 6 (branch `option-d/pr6-hygiene`): §2.5's sandbox sentence and gotcha 6 corrected.
> Updated 2026-09-11 for pass 36: ruling 183 (cluster 4: §6's skills bullet, the store body
> every writer judges before the mount normalises it) and cluster 5 (ruling 180, F36-8: §2.3's
> substitution column, §2.4 (`settingSources: []` on every run, the run's skill plugin as the
> one local plugin, no `managedSettings`), §3.2, §4.1 (a backend switch names the model it
> ran on and that the pin sticks), §6 (skills mount as a plugin BESIDE the checkout) and
> gotchas 4 and 7). The operator's own behaviour is in
> [operator.md](operator.md); the controller's in
> [controller-and-goals.md](controller-and-goals.md).

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
  `delivers: true|false`, `verdictCapable`, `backend`, optional `pinnedBackend`. At most
  one entry delivers; it owns the workspace, branch and PR. Engagements are written by
  the dispatch itself (ruling 98).
- **Backend**: `claude` (Claude Agent SDK 0.3.261) or `codex` (Codex SDK 0.153.4). A profile lists
  the backends it may run on; the first `codex` else `claude` is the deployment's
  "primary run backend".

## 2. Backends

### 2.1 Credential principal and per-person availability (ruling 127)

There is **no instance-level "the backend is configured"**. Every run bills ONE person —
its **credential principal**, persisted as `agent_runs.credential_user_id`: the **task
owner** for every task run (operator, specialist, resume, scheduled, boot recovery,
retry), the **asker** for a controller turn. A task with no owner cannot run agents.

`userBackendHealth(db, userId, backend)` (`backend-credentials.server.ts`) is the ONE
answer every surface reads. It re-probes on **every call**, never makes a paid request,
and needs a `user_backend_credentials` row for that (person, backend):

| Row kind | Available when | `verification` |
|---|---|---|
| `api_key` / `access_token` | always (the sealed box is the credential) | `credential` |
| `login` | the vendor's own file is in that person's home (`claude-home/.credentials.json`, `codex-home/auth.json`) | `file` |
| `login` on darwin | the home exists but holds no file (the Claude binary uses the Keychain) | `presence` |
| none, or a `login` whose file is gone | never — `detail` says which, addressed to the person | `none` |

`/resources/health` reports the instance-level number that remains: `backends: { claude:
{ connectedUsers }, codex: { connectedUsers } }` (`countConnectedUsers`). Zero is a real
reading, not a fault.

`run-principal.server.ts` resolves WHOSE account a run uses (`resolveTaskRunPrincipal` /
`resolveUserRunPrincipal`) and `principalRefusalMessage` writes the ONE human sentence
for the three refusals: **unowned** task, **owner-missing** (deleted or disabled), and
**no-credential** (named owner, plus the health detail). A refused run fails fast with
the tag `run·unavailable`, an honest error run carrying that sentence, and a blocked
recovery packet quoting it — no clone, no reservation, no process, and nothing spent on
its behalf either: the principal is resolved BEFORE the stdio MCP pre-flight (which
starts each declared server to handshake it and corrects its registry row) and before
the skills are mounted into the workspace, on the fresh, resume and operator paths
alike. There is no fallback engine and no other account to fall back to.

### 2.2 Per-person runtime homes

- `<dataRoot>/runtimes/users/<userId>/claude-home` is the child's `CLAUDE_CONFIG_DIR`
  (sessions under `projects/`); `…/codex-home` is its `CODEX_HOME` (sessions under
  `sessions/`). Created `0o700` on demand by `ensureUserBackendHome`
  (`user-homes.server.ts`); the user id is path-checked against
  `/^[A-Za-z0-9_-]{1,64}$/` first. The deployment-wide `runtimes/claude-home` /
  `runtimes/codex-home` and the host `~/.codex` mount are gone.
- **Every Codex run gets a private `CODEX_HOME` (ruling 181).** The Codex CLI extracts
  its exec helpers (`codex-linux-sandbox`, `codex-execve-wrapper`, `apply_patch`) into
  ONE directory per home, `$CODEX_HOME/tmp/arg0/codex-arg0XXXXXX/`, and every new
  process of the same home replaces it; with one `codex-home` per person, concurrent
  sandboxed runs of one person (a reviewer, the operator, a developer) deleted each
  other's helper mid-run (F36-3). So the Codex adapter forks
  `<codex-home>/runs/<runId>/` at spawn (`prepareCodexRunHome`, `user-homes.server.ts`)
  and hands it to the CLI as `CODEX_HOME`: `auth.json` and `config.toml` are **copied**
  in when present (a copy, so two runs never write one shared file through a link);
  `sessions/`, `skills/` and `memories/` are **symlinks** to the shared home's
  directories, created first, so a rollout the CLI writes lands where
  `probeSessionContinuity`, the exporter and the retention sweep look; `CODEX_SQLITE_HOME`
  is set to the shared home so the CLI's thread/state database stays the person's; `tmp/`
  is whatever the CLI creates inside the run home, private by construction. When the run
  settles — finished, failed, interrupted or crashed, the adapter's one `settle` — the
  run's `auth.json` is copied back to the shared home only when its bytes changed, under a
  per-person lockfile (`.auth.json.lock`, `O_EXCL` with retry; a holder older than 30 s is
  broken), only while the shared file still exists (a disconnect mid-run is not undone),
  and the run directory is deleted. Resume is unchanged: the SDK reads the rollout through
  the symlinked `sessions/`. `runCredentialFor` still names the SHARED home on
  `spec.env.CODEX_HOME`; the fork is the adapter's, so every path that builds a Codex
  spec (specialist, operator, controller, resume, scheduled, recovery) gets it.
- `runCredentialFor(db, userId, backend)` builds what the run's child env carries: the
  home always; `ANTHROPIC_API_KEY` (claude), `CODEX_API_KEY` / `CODEX_ACCESS_TOKEN`
  (codex) only for a pasted credential. In both codex secret cases `OPENAI_API_KEY` is
  explicitly absent. A `login` kind adds no secret: the vendor binary reads its own file.
- Spawn env hygiene: every variable matching `CREDENTIAL_ENV_RE` (`API_KEY`, `TOKEN`,
  `SECRET`, `PASSWORD`, `PRIVATE_KEY`, `CREDENTIALS`, `AUTH` …), the private-runtime
  set (`DATABASE_URL`, `REDIS_URL`, `SSH_AUTH_SOCK`, `GPG_AGENT_INFO`), **both vendor
  homes** (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` — neither is credential-shaped, but a home
  is where a vendor binary keeps its credential, so an ambient one would let a run billed
  to one person authenticate as whoever a leftover sign-in file names — and, since ruling
  181, `CODEX_SQLITE_HOME`, the CLI's state-db location, which the Codex adapter sets per
  run to the principal's shared home) **and every name
  the app's own env schema declares** (`ENV_KEYS`: `NODE_ENV`, `PORT`, `VIBERR_DATA_ROOT`,
  `BETTER_AUTH_URL`, the OAuth client ids, every `VIBERR_*` knob; ruling 142 — an agent
  works in the project's repository, not in Viberr's process, and the container's
  `NODE_ENV=production` / `PORT` broke a project's own `vitest` and `next start` inside a
  run) is stripped from the child (`filteredSpawnEnv`). A name the schema does not
  declare (`PATH`, `HOME`, locale, proxies, the image's `UV_*` caches) passes, which is
  safe because the "no undeclared env reads" gate keeps the schema complete; the one
  declared knob a child's tool depends on, `VIBERR_BROWSER_EXECUTABLE`, reaches the
  browser MCP as argv from the server, never from the env. The same base serves every
  spawned stdio MCP child (`mcpSpawnEnv`), the hosted sign-in driver and the vendor
  sign-out. The run service then adds exactly one principal's credential on top, and
  `startRun` throws if the caller's own `env` overlay names a key the credential owns.
  Last it adds the **run marker** `VIBERR_RUN_ID=<runId>` (ruling 174): not configuration
  and not a secret, but the one name every process the run starts inherits, so the settle
  sweep can find them (§3.4). It is set after the caller's overlay, so nothing renames a
  run's processes, and a refused run, which spawns nothing, carries none. The run sink redacts those
  plaintext values from every persisted line (`createRunSink(db, spec, { secrets })`) —
  the key belongs to one person and the run console is visible to every project member.

### 2.3 Models and effort

| Backend | Models (default first) | Efforts (default) | Rules |
|---|---|---|---|
| claude | `sonnet`, `opus`, `haiku` (aliases), plus a family alias carrying a bracketed context-window variant (`opus[1m]`, what the live catalog offers as "Opus (1M context)"), plus any dated `claude-*` id containing a digit, plus the live `supportedModels()` list of the VIEWER's OWN connected Claude account (10 min cache keyed by that person's home, 15 s timeout; ruling 127) | `low medium high xhigh max` (`high`) | Alias or dated id runs verbatim; a string containing opus/haiku/sonnet maps to the alias; the bracketed variant is split off FIRST, the base resolved, and the variant re-appended verbatim (`claude-opus[1m]` → `opus[1m]`, `claude-sonnet-4-5[1m]` unchanged), so it reaches the SDK and is known on a cold process (pass 34, F34-7); anything else falls back to the SDK default. Display: the live catalog row's name when cached, else "Claude Opus [1m]" |
| codex | `gpt-5.6-terra`, `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.5` (closed list, read off the pinned CLI's bundled catalog; Astra is the CLI's own default since 0.153.4 but Terra stays Viberr's, F20-33) | `low medium high xhigh max` (`medium`), per model as the bundled catalog lists them (GPT-5.5 stops at `xhigh`); `minimal` accepted at run time, never offered; `ultra` (automatic task delegation, i.e. sub-agents — the operator's job) and `persistent` (no bundled model) are in the SDK union but neither offered nor forwarded | A model persisted for the other backend is **substituted at start and disclosed** (`substituteRunModel`, one home for the swap): the run log opens with the `run·model_substituted` line, and a cross-backend retry names the model it ran on in its timeline event and its `retry_other_backend` option (F36-8, pass 36) |

`/resources/model-catalog?backend=` serves `{ models, efforts, defaultModel,
defaultEffort }` to the profile editor (unknown backend → claude; `requireUser` only).
The route resolves the viewer's own `runCredentialFor(db, user.id, "claude")` and passes
it to the catalog; a viewer who has not connected Claude gets the curated list and no
probe is spawned, and one person's live list is never served to another (the cache entry
carries the home that produced it).
A template (`agents/profiles/<id>.md`) may carry its own default `model` and `effort`
(ruling 153, pass 35 G35-2): `save_global_agent` takes both, checked by name against
the template's backend (a backend switch whose stored model belongs to the other
backend clears it and the toast says so), and a library deploy takes the template's
effort when no override is given and the backend offers that tier; a definition-less
deployment resolves the template's effort live. The org template modal has no picker
yet (follow-up).
Effort is ranked `minimal 0 … max 5` and clamped to the backend's list at RUN time only
(`resolveRunEffort`, for a tier stored before the check existed); every write surface
that takes a tier (`deploy_agent`, `update_agent_deployment`, and the profile editor for
a CHANGED value) refuses an unlisted one by name first (ruling 139,
`assertEffortForBackend`), and the editor re-seeds a stored tier the backend no longer
lists to the default rather than offering it. The re-seed reads the SAME list the effort
select renders — the selected model's own tiers when it narrows the backend-wide list —
so a tier the picker never shows is never left standing to be saved, and picking a model
with fewer tiers clamps the pick to one that model offers (the catalog default when it is
among them, else its first).

**Availability marks** (`model_availability`): a model is marked unavailable only from a
real run failure whose redacted text matches `MODEL_UNSUPPORTED_RE`, and cleared by a
real success. Never a synthetic probe (ruling 19 generalised).

**Quota and rate limits** (`instance_settings`): the run sink folds Claude
`rate_limit_event` envelopes into `backendRateLimit.<backend>`; a quota-refused failure
(terminal tag ending `·quota`) records `backendQuotaExhausted.<backend>` when the
terminal line's `failure.windowRejected` says the provider rejected the window OR the
provider's own sentence names a spent limit (`session | weekly | monthly | usage limit`,
never transient rate-limit wording), with only the PROVIDER half of the line as its
evidence and a reset instant that is the SDK's exact `resetsAt`, a Claude
`usage limit reached|<epoch>` (exact), a `resets 11:50am (UTC)` clock resolved to the
next UTC occurrence (`clock`, retired with the prose grace), Codex "try again at Sep
18th, 2026 5:20 PM" prose resolved in UTC (`prose`), or the time-only "try again at
6:18 PM" a five-hour Codex window refuses with (G35-4, pass 35): the Codex CLI prints
the wall clock of the process that ran it, so the hour is resolved with the process's
own local setters (never `Date.UTC`) to the next occurrence at or after the
observation, precision `clock`. Grace 24 h for prose and clock; an undated exhaustion
expires after 6 h. **The dispatch hold** (ruling 152(c)): `backendDispatchHold(db,
backend, { credentialUserId })` is the one read a dispatch makes before it spends
anything; it stands while the stored exhaustion has not passed its reset instant (no
grace: the hold trusts the provider's instant) or, when none was named, for
`UNDATED_HOLD_MS` (30 min) after the refusal, and only for the account the record
names (ruling 146; a record naming nobody holds every dispatch on the backend). See
§4.1. Ruling 130(d): every record (reading, exhaustion, credential refusal)
names the account it billed (`credentialUserId`, `credentialLabel`, the run's
principal under ruling 127); one latest record per backend, and a completed run by
ANY person retires an exhaustion or refusal, as does a change to the named person's
credential on that backend (a confirmed sign-in, a pasted key, a disconnect, an account
removal; ruling 165, `retireBackendRefusalsFor`). The principal reaches Insights (org
admin), `instance_health` (signed in) and the person's own Profile card; it is stripped
from the unauthenticated `/resources/health` body. Insights renders both; "no reading
yet" is neutral; a refused row says whose account, and a reading row names the hour
of its reset. The Profile card (`getProfileBackends` → `lastRefusal`) shows the
viewer's OWN record only: a `risk` "refused by the provider · <when>" pill with the
provider's sentence, or a neutral "usage window spent · reopens <when>" pill, each
stated as the last refusal Viberr observed, retired by any completed run or by
connecting a different account there (ruling 165).

### 2.4 Claude adapter

- Query options: `permissionMode: autonomous ? "bypassPermissions" : "default"`, with
  `allowDangerouslySkipPermissions: true` beside bypass on the autonomous run only (ruling
  174: the SDK declares it required with bypass and defaults it to false; the pinned CLI
  does not enforce it yet, and one that does would drop every run to `default` and deny
  every tool), `permissionPrompts: "none"` on every run (SDK ≥ 0.3.259: nobody answers a prompt in a
  server-spawned run, so a tool the mode would ask about is denied at once with a reason
  the model can act on; binds only on the `default` seam, bypass never prompts),
  `maxTurns` (default 2000, `VIBERR_CLAUDE_MAX_TURNS`), `maxBudgetUsd` when the instance
  has a spending cap (ruling 175: Org settings → Max spend per Claude run, stamped on every
  run by `startRun` as `RunSpec.maxSpendUsd`; none by default), `strictMcpConfig: true`,
  `settingSources: []` on EVERY run (ruling 180: no host tier and no project source over
  the checkout, so the repository under review's `.claude` and CLAUDE.md never reach the
  model), `plugins: [{ type: "local", path, skipMcpDiscovery: true }]` naming the run's
  own skill plugin (`RunSpec.skillPlugin`, §6) when granted skills mounted — else `[]` —
  with `skills: ["viberr:<name>", …]` qualified by that plugin's name, `disallowedTools`
  (binds even under bypass), `allowedTools` for the toolkit and mounted MCP names.
  `systemPrompt` **replaces** the preset for operator and controller runs and is
  `{ preset: "claude_code", append }` for specialists.
- Denylists: `BASE_DENIED_BUILTINS` (Skill, Task*, Workflow, Cron*, ScheduleWakeup,
  RemoteTrigger, Monitor, PushNotification, SendMessage, DesignSync, Enter/ExitWorktree;
  `Skill` is re-allowed when native skills are mounted; SDK 0.3.233 took `TaskCreate`/
  `TaskGet`/`TaskUpdate`/`TaskList` out of the default tool surface on Opus 4.8, Sonnet 5,
  Fable 5 and newer, and the denies stay because older models still expose them and the
  fence must not depend on the profile's model); operator read-only =
  `Bash Edit MultiEdit Write NotebookEdit`; supporting runs additionally lose `Bash(git
  push:*)`, `Bash(gh pr create:*)`, `Bash(gh pr merge:*)`; capability-derived denies in
  §4.3.
- The CLI is spawned by Viberr, not the SDK (`spawnClaudeCodeProcess` →
  `spawnClaudeCli`, `claude-spawn.server.ts`; ruling 174): `detached`, so its pid is its
  process group and the stdio MCP servers it starts share that group. Every signal the
  SDK sends it — its close ladder and its kill-all when the server exits — goes to the
  whole group. The SDK reads only stdin and stdout from a custom spawn, so Viberr drains
  stderr itself, keeps the SDK's 2 KB tail and delivers `exit` only once stderr has
  closed; the adapter adds that tail back onto the SDK's `Claude Code process exited with
  code N` error, which is how a resumed session the CLI cannot find still classifies as
  `session_missing`.
- MCP tool loading (Option D PR 4(a), 2026-09-11). The SDK defers MCP tools behind
  ToolSearch, so a run searches for a tool before it can call it; every stored operator
  run (16 of 16) opened with that search. The operator's `viberr` server and the
  specialists' `viberr_agent` server are created with `alwaysLoad: true` (the SDK stamps
  `anthropic/alwaysLoad` on each tool), which puts their tools in the first prompt.
  Measured in the image on `claude-opus-5[1m]`: an operator turn went from 3 model turns
  to 2 and 7-10 s to 4 s, $0.03-0.04 to $0.02 warm, for a turn-1 prompt of 12.9k tokens
  instead of 5.3k (cached after the first run; a cold first run pays the cache write
  once); a reviewer went from 4 turns to 3 at the same cost. The controller's
  `viberr_controller` (41 tools) and `viberr_ops` stay deferred: loading them saved a turn
  but tripled turn 1 (6.0k to 18.0k tokens) and quadrupled a cold turn's cost ($0.05 to
  $0.21). Org MCP servers are never loaded up front. Pinned per server by the
  `toolLoading` tests (`test-support/mcp-tool-meta.ts`).
- Org MCP write tools (ruling 176). A run that withholds `execute-code-or-write-repo`, and
  every operator run, carries `spec.mcpToolDenials`: each mounted server's admin-marked
  write tools. `startRun` has already added `mcp__<server>__<tool>` (anything outside
  `[A-Za-z0-9_-]` becomes `_`, as the CLI names tools) to `disallowedTools`, after the
  server's `mcp__<server>` auto-approval, which a deny rule outranks. An HTTP config also
  carries `tools: [{ name, permission_policy: "always_deny" }]`, the SDK's own per-tool
  channel for remote servers. The adapter forwards both unchanged. Live (2026-09-11), the
  run's `system/init` tool list no longer offers a marked tool.
- PreToolUse capability hook (ruling 101(e), amended by Option D PR 5). A run whose
  denylist names a `Bash(<prefix>:*)` rule, and whose Bash is not denied outright, carries
  one `PreToolUse` hook on `Bash`. `bash-policy.server.ts` reads the command as a shell
  would: it splits `&&`, `||`, `;`, `|` and newlines; unwraps `git -C`/`-c`/`--git-dir`,
  `sh -c`/`bash -lc`, `eval`, `env`, `xargs`, `timeout`, `$(…)` and backticks; and
  ignores quoted text (`echo "git push"` is not a push). A command that reaches a denied
  prefix is refused. The reason (`bashDenyReason`) names the capability the run withholds,
  read off the denylist, or says a supporting engagement never delivers, and comes back
  as the tool's result. The SDK reports a hook's decision in the tool result only, so the
  adapter writes a `system/permission_denied` frame of its own (`source: "viberr"`,
  `decision_reason_type: "hook"`), which the console shows as a rule's deny. Measured
  2026-09-11: the CLI's own rules already refused `cd . && git push` and `true; git push`
  and let `git -C . push` and `sh -c 'git push'` land. With the hook, all five were refused
  and nothing landed. The hook runs before the rules and only ever denies; the rules stay
  the fence.
- Timers: idle timeout 15 min (`VIBERR_CLAUDE_IDLE_TIMEOUT_MS`), interrupt grace 20 s
  then abort grace 10 s. The abort SIGTERMs the CLI's group at once (the SDK's own
  SIGTERM→SIGKILL follows); what happens after the run settles is §3.4.
- No `managedSettings` and no CLAUDE.md excludes file (both retired with ruling 180):
  nothing under cwd is a settings source, so there is no ingress to close.
- Success = a `result` envelope with `!is_error`. Failures tag `run·error·<kind>` with
  `kind ∈ quota | auth | overloaded | session_missing | unknown`; idle → `run·error·idle_timeout`;
  `error_max_turns` → `run·error·max_turns`; `error_max_budget_usd` → `run·error·max_budget`
  with a typed record carrying the cap (`spendCapUsd`) and the spend at cut-off (`spentUsd`,
  the result's cost), and a line saying it was cut off, not failed, and where the cap is
  raised (ruling 175). The pinned SDK yields an error result and then THROWS: when the CLI
  exits non-zero after it, `readMessages` replaces the exit error with "Claude Code
  returned an error result: <text>". So a cut-off is classified from the result even when
  the stream throws afterwards (`emitCutOff`, both paths); any other error result that
  ends in a throw is classified from the throw as before. *(Found by the ruling-175 live
  canary, 2026-09-11: the spending cap, and the turn cap with it, had been ending as
  `run·error·unknown` since the SDK began throwing.)* Provider text follows
  `"\n\nThe provider reported: "`.
- Ruling 130(a) (pass 34): refusals are classified from the STRUCTURED envelope first
  and from prose second, in the order spawn codes → `session_missing` → `quota` (a
  `rate_limit_event` whose `status` is `rejected`, an assistant-envelope `error` of
  `rate_limit` or `billing_error`, `api_error_status: 429`, or the prose regex now
  including `session limit | weekly limit | monthly limit | out of credits | credit
  balance`) → `auth` (`authentication_failed`, `oauth_org_not_allowed` or `account_on_hold`,
  status 401/403, or the prose regex) → `overloaded` (a result the SDK ended on a
  provider-side status — `api_error_status: 529` or another 5xx, structural since SDK
  0.3.223 — an assistant-envelope `error` of `overloaded` or `server_error`, or the prose
  regex `overloaded | 500/502/503/529 | temporarily unavailable | service unavailable |
  server error`) → `unknown`. A provider-side status is where the run ENDED, so an earlier
  `rate_limit` banner the SDK retried through does not re-route it to `quota`; a REJECTED
  rate-limit reading still does. With no prose at all (an API-refused result under
  `subtype: "success"`), the structured facts classify and no provider sentence is
  quoted — the word `success` used to be appended as "the provider reported". The
  terminal `err` line carries a typed `failure`
  record (`RunFailureFacts`: kind, `resetsAt`, `window`, `windowRejected`, `apiError`,
  `apiErrorStatus`, `terminalReason`; the reset and window ride ONLY on a rejected
  reading) beside its tag, and every reader consumes that record: the failure reason,
  the packet builders, the controller's note, the Agent-logs footer for every run kind,
  the quota store. The provider's API-error banner, streamed as an assistant message
  with an `error` code, projects as an `err` line tagged `assistant·<code>` and can never
  be selected as the agent's reply. A rejected `rate_limit_event` projects as an `err`
  line tagged `rate_limit_event·rejected` (exempt from the console's telemetry
  collapse) naming the window, the status and the absolute reset. U34-1: an error
  result whose subtype is `success` is labelled `error`, with `· api <status>` and
  `· <terminal_reason>` appended when the SDK sent them. A `system/permission_denied`
  frame (SDK ≥ 0.3.223: a tool call a deny rule, the mode or an unanswerable prompt
  refused — a supporting run reaching for `git push`, say) projects as an `err` line
  tagged `permission_denied` whose `name` is the tool and whose text is `denied by
  <decision_reason_type>: <decision_reason>` (the SDK's rejection sentence when no reason
  was given), so the attempt is visible in the console instead of a dim meta row.

### 2.5 Codex adapter

- The CLI's `CODEX_HOME` is the run's private fork of the principal's home,
  `<codex-home>/runs/<runId>/`, with `CODEX_SQLITE_HOME` pointed at the shared home
  (ruling 181, §2.2); the adapter builds it right after the spawn env is merged and
  removes it in `settle`, the one exit every outcome takes.
- Per-run `config.toml` merged per leaf into `$CODEX_HOME`: `allow_login_shell: false`,
  `project_doc_max_bytes: 0`, bundled skills and skill instructions off, apps/plugins/hooks
  off, memories off, `developer_instructions = systemPrompt`, `mcp_servers`.
- Only six env keys are re-exported through `shell_environment_policy`:
  `GIT_CEILING_DIRECTORIES`, `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_NAME/EMAIL` and, since
  ruling 174, the run marker `VIBERR_RUN_ID`, so a command the model backgrounds carries
  it. Each stdio MCP server is declared with `env = { VIBERR_RUN_ID = <runId> }` too: the
  CLI starts a server with its own short default environment plus the declared `env`, and
  the marker is an id, not a secret, so argv is a fine place for it.
- **Sandbox mode** (`resolveCodexSandboxMode`), in order: operator → `read-only`;
  repo-write withheld → `workspace-write` if an attachments dir exists else `read-only`;
  autonomous deliverer with egress → `danger-full-access`; otherwise `workspace-write`.
  The second arm is ruling 101(c)'s carve-out and it is **not** a gap in the docs: the
  pinned Codex 0.146 cannot express "read-only except `attachments/`" (`ReadOnly` admits
  no writable root; `--add-dir` widens `workspace-write` only), so ruling 109 kept it and
  made it visible instead — see §4.3. Re-checked on the 0.153.4 pin (2026-09-06):
  `--add-dir` still reads "writable alongside the primary workspace" and the sandbox
  modes are unchanged, so the carve-out stands. So `read-only` is a live seam for every
  write-withheld Codex run without an attachments dir (ruling 101), not a mode R22
  retired. Watch item (ruling 109): the CLI's `permissions.rs` per-path profile would
  express read-only plus a writable attachments dir; revisit when the SDK surfaces it.
  `approvalPolicy: "never"`, `skipGitRepoCheck: true`; operator threads have network
  off; withheld egress sets `webSearchMode: "disabled"`.
- **The sandbox is probed once per process and a confined run is refused while it fails
  (ruling 182).** Every mode but `danger-full-access` confines the agent's commands with
  bubblewrap (Linux) or seatbelt (macOS), and bubblewrap needs an unprivileged user
  namespace that Docker's default seccomp profile denies (F36-1: every reviewer failed at
  its first command and reported the environment failure as a verdict). So
  `app/server/ops/toolchain.server.ts` runs the CLI's own sandbox helper once — `codex
  sandbox --permission-profile <probe> -C <work> -- /bin/echo <nonce>` in a throwaway home
  under `runtimes/codex-sandbox-probe/` (not the OS temp dir, which the CLI refuses for
  its helpers), with a profile that reads `/` and writes the workdir, network off — and
  keeps the verdict beside the host's tool versions. `startRun` reads it after the
  credential: a Codex spec whose `resolveCodexSandboxMode` is below `danger-full-access`
  ends as a `run·unavailable` error run through `failRunUnavailable` — `Codex sandbox
  unavailable on this host: <detail>. Fix the deployment (see
  docs/operations/deployment.md, seccomp) or grant the run full access. No agent process
  was started.` — with `failedUnavailable` on the audit row, exactly the credential
  refusal's shape (§3.5 "unavailable"). A fully-autonomous deliverer with egress is never
  asked; a Claude run never is. Boot resolves the reading first (its WARN names the
  remedy), `healthSnapshot` appends it LAST as `toolchain`, and `instance_health` inherits
  it. The unit suite never probes (`test-support/toolchain.ts`).
- MCP servers are passed **without credentials** (argv exposure), and in-process SDK
  servers are skipped. A bearer-token HTTP MCP is therefore unauthenticated on Codex.
- Ruling 176: a server's entries in `spec.mcpToolDenials` become its `disabled_tools`
  (the pinned 0.153.4 CLI reads it per `mcp_servers.<name>`, beside `enabled_tools`), by
  the server's own tool names. Live (2026-09-11), a withheld run listed and called only the
  unmarked tools.
- No `maxTurns` and no budget option: the instance's spending cap (ruling 175) does not bind
  a Codex run, and its run-inputs disclosure says so ("Codex has no budget option: this run
  is bounded by its idle timer only"). Idle 15 min (`VIBERR_CODEX_IDLE_TIMEOUT_MS`);
  interrupt settle 20 s. The
  SDK spawns the CLI itself with a plain `spawn()` and only ever SIGTERMs it, so the settle
  sweep (§3.4) is what reaches a CLI that outlived its abort and everything its shell
  started. There is no wrapper around the Codex binary: the owner's decision D1 (a wrapper
  pointed at by `codexPathOverride`) was replaced by the sweep before it shipped, ruling 174.
- Success requires `turn.completed` with no top-level `turn.failed`/`error`; item-level
  errors are non-fatal. Same failure kinds as Claude on the tag suffix; `overloaded` is
  prose-only here (Codex streams no status): `overloaded | 500/502/503/529 | temporarily
  unavailable | service unavailable | server error`, matched after quota and auth.
- Structured output: when a specialist has a verdict, ask or evidence grant, the run
  carries `outputSchema = AGENT_OUTCOME_JSON_SCHEMA` and the envelope replaces the tool
  calls a Claude specialist would make. The Codex operator returns a plan the server
  executes ([operator.md §5](operator.md#5-tools-and-the-governed-actions-behind-them)).

## 3. A run's life

### 3.1 Persistence

- `agent_runs`: `id, task_key, project_slug, thread_id, role, kind, backend, model,
  session_id, sdk, state (queued|running|finished|error|interrupted), phase, step,
  started_at, finished_at, turns, input_tokens, cached_input_tokens, output_tokens,
  usage_final, total_cost_usd, interrupted_by, agent_name, agent_profile_id, outcome_key,
  credential_user_id, interrupted_reason`. `interrupted_by` is the person who stopped
  the run (a `users.id`) or null; `interrupted_reason` (`restart` or null) says why an
  `interrupted` run stopped when nobody did (ruling 158 addendum, pass 35 U35-7).
- **Token columns mean the same thing on both backends.** `input_tokens` is the total
  input the provider processed for the run, cache reads and cache writes included: Codex
  `usage.input_tokens` verbatim (its cache figures are subsets of it); Claude
  Σ over `result.modelUsage` of `inputTokens + cacheCreationInputTokens +
  cacheReadInputTokens` (ruling 175), normalized in `wire-format.server.ts` (Claude
  reports the three as disjoint figures, and the uncached slice alone is two tokens per
  call). `modelUsage` covers every call the query made — the main loop, subagents,
  sidechains, compaction — per model; `result.usage` (the same sum over the main loop only)
  and `total_cost_usd` are the fallback for a result whose `modelUsage` is absent, empty or
  zeroed (an older CLI, a crash result). The cost column is Σ `costUSD` on the same basis,
  and the result line keeps the per-model breakdown in its `stats.models` (and says "N
  models" when more than one ran); there is no per-model column. `cached_input_tokens` is the
  subset of `input_tokens` served from the prompt cache (Codex `cached_input_tokens`,
  Claude `cache_read_input_tokens`) and is never larger than `input_tokens`.
  `output_tokens` is the provider's figure. `turns` is Claude's `result.num_turns` (one
  plus the `user`-type messages that flowed through the SDK loop, so every tool result
  counts) and Codex's count of completed turns. The strip's **Tokens** is
  `input_tokens + output_tokens`: total tokens processed. During a Claude run the row
  holds the adapter's live figure: each API message's whole prompt summed once per
  `message.id` (exact; it reproduced `result.usage` on every stored run) and an
  **estimate** of the output from the streamed content (text, thinking and tool-call
  input at about four characters per token, summed per envelope), because the SDK's
  per-envelope `output_tokens` is the `message_start` placeholder of a few tokens
  (F35-1: a twelve-minute Opus run writing 20k characters read "49 tokens" until its
  result said 54,759). The prompt figures fold by max; the estimate folds by max while
  it is an estimate and is **replaced** by the provider's figure when one lands (a
  Claude `result`, a Codex `turn.completed`), which also sets `usage_final = 1`. While
  `usage_final` is 0 the row is not a total: the Live run panel prints it as `~n`
  with a tooltip, a Codex run whose turn has not ended prints "pending", and Insights
  leaves the row out of its token sums. An errored result carrying an empty usage
  reports nothing and leaves the estimate and the flag alone. Ending does not settle
  the question: a run somebody stopped, and one that errored before the provider
  replied, keep `usage_final = 0` for good, so the panel keeps the `~` on them and the
  Insights card names them ("N of M runs report no provider token total") instead of
  quietly understating its sums. Adding the column to a root that predates it heals the
  rows it already holds: a `finished` row's token columns were the provider's own
  figures before the estimate existed, so the boot healer stamps those 1; a stopped or
  errored row held the old placeholder and stays 0. A resumed Codex thread reports the
  thread's cumulative total. Claude rows written before this normalization hold the
  uncached slice only. *(Corrected 2026-09-11, ruling 175: this paragraph said Claude's
  tokens came from `result.usage`, which covers the main loop only, while the cost covered
  side-model calls too, so the two sat on different bases. Rows written before ruling 175
  folded `usage`, and a run that delegated to subagents or compacted stored fewer tokens
  than it processed; rows written after fold `modelUsage` and match the cost's basis.
  Insights sums the rows as stored, so old rows are unchanged.)*
- `credential_user_id` (ruling 127) is the run's **credential principal**: whose account
  it billed. It is written on the reserved row and on the started row, carried in the
  `runtime.run.started` audit, and read back by the transcript locator and the run
  projection. It is NULL only on a run that was refused before any credential was looked
  up — an unowned task, or one whose owner account is gone or disabled. A run refused
  because the owner has not connected THAT backend still records the owner
  (`refusedPrincipalUserId`), so the refusal is auditable rather than anonymous.
- `run_log_lines`: `(run_id, seq)` unique, `raw_json`, `display_json`.
- Raw NDJSON, the truth: `<dataRoot>/runtimes/<backend>/<runId>.jsonl` (always the run
  id, never the session id).
- Single-flight indexes: `idx_agent_runs__one_delivering` (one queued/running `primary`
  per task) and `idx_agent_runs__one_live_per_support` (one per task and profile among
  `reviewer` rows); the latter is re-created at every DB open for older roots. A
  constraint hit becomes a 409 naming which index refused.
- `staged_outcomes(outcome_key)` holds a specialist's first `report_outcome` until
  completion consumes it once (24 h TTL, in-memory cap 500); a later call in the same run
  changes nothing (§4.2).

### 3.2 Reservation and admission

`reserveRun` writes a `running` row with a phase before the clone starts, or declines
when the instance cap is exhausted; `assertRunReservationLive` re-checks after the
clone. `startRun` audits `runtime.run.started`, substitutes foreign-backend models
(`substituteRunModel`; the run log opens with the swap, the row stores what ran),
fails unavailable backends, and otherwise `launch`es a reserved row or `admitRun`s into
a `pending` queue drained on every completion. The cap is the instance setting
`maxConcurrentRuns` (0 = unlimited, ceiling 64, Org settings → set-concurrency).

**The coordination lane (ruling 152(b), pass 35).** A positive cap carries a lane of
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
Default thread ids: `op-<8>`, `primary-<8>`, `r<idx>-<8>`, `controller`.

### 3.3 Streaming

Adapter callbacks → `createRunSink` per line: fold facts → record rate limit → **redact**
(spawn-env values ≥ 12 chars that match the credential regex, plus `TOKEN_PATTERN_SOURCE`)
→ record quota exhaustion → append raw NDJSON → insert `run_log_lines` (display only) →
patch run facts → publish `run.log-appended {runId, seq}` (reference only). The
`wire-format` projector maps provider envelopes to display lines with `ev ∈ init | text
| tool | out | err | result | think | meta | diff`; the `step` column advances only on
`tool` lines (cap 120) and phases are `preparing | starting | working | finishing`
(updates throttled to 1 s).

Consumers: `GET /resources/run-log?runId=&since=|before=&limit=` (1..500, member-gated;
controller runs by conversation ownership) returns `{ runId, threadId, state, lines,
headSeq, oldestSeq, hasMore }`. The client `useRunLogStream` keeps its own `EventSource`
on the task scope, fetches since `headSeq` on each reference, revalidates once on
`run.state-changed`, and pages backwards 200 lines at a time. Its controller channel
(`source: { kind: "controller", conversationId }`) subscribes the `user` scope instead
and tails `controller.log-appended` frames for the open conversation only: a controller
run has no task scope, so the sink resolves the conversation owner once per run
(`controllerRunRoute`) and both publishers route there (lines as
`controller.log-appended`, state changes as the `controller.updated` reference).

### 3.4 Interrupt and completion

`interruptRun` needs `run-agents` (admin or maintainer, non-archived) for a task run, and
for a controller run `canInterruptControllerRun` (the conversation's owner or a live org
admin; anyone else gets the 404 shape): a live handle gets `handle.interrupt()` and
`interruptedBy`; a dead one is patched to `interrupted`, its slot released, and the run's
registered completion callback fired from that arm (there is no adapter exit to fire it
otherwise, so a reserved specialist's completion effects and a queued controller turn's
settle were lost); audit `runtime.run.interrupted`. The sink's `finalize` lets the first
terminal writer win, sets `finishedAt`, clears the backend's quota-exhaustion record on
`finished`, drains the pending queue, then fires the registered completion callback. A
callback that throws goes through `noteCompletionEffectsLost`: waiting flips to human
and a `continuity` timeline event is written, so a lost effect is visible.

**A settled run leaves no live process (ruling 174).** Neither vendor CLI keeps its
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
the container plus the server-owned delivery gate stay the boundary (ruling 93). The log
line is `reaped the processes a settled run left behind`, with the counts.

### 3.5 Failure kinds

`RunFailureKind = quota | auth | unavailable | overloaded | max_turns | max_budget |
idle_timeout | session_missing | unknown`, read from the terminal line's typed `failure` record first,
the tag suffix second and regexes last (ruling 130(a)). `runFailureReason` returns the
record as `facts`; `projectRunsForTask` sets `failureKind` on every errored run's view
(operator runs included) and flags `failedBackendUnavailable` from the class before the
raw scan; the controller's turn note (ruling 130(b)) names a quota window's reset and
the account switch, or an auth refusal's organization restriction, instead of "Say it
again to retry", which stays only for an unclassified failure.
`max_budget` (ruling 175) is a cut-off like `max_turns`: the instance's spending cap, not
the task, ended a Claude run. Its record carries the cap and the spend; the specialist's
blocked event reads "the Claude run reached the instance's spending cap of $X after
spending $Y and was CUT OFF mid-work, which is not a task failure" and says no "No changes
were delivered"; the remedy (operator and specialist alike, `describeRunFailure`) is to
re-run it or have an org admin raise the cap in Org settings; the operator's options are
the ordinary re-run set, never another-backend retry; the pill reads `cut off · spending
cap`; the controller's turn note names the cap and the spend.
`overloaded` (added with the Agent SDK 0.3.261 upgrade) is the provider's side, not the
account's: the Claude adapter reads it from `api_error_status: 529`/5xx or the `overloaded`
/ `server_error` banner codes, the Codex adapter from the same prose signatures the raw
scan uses. Its remedy is a retry — the same backend once the provider recovers, or the
other one now (`retry_other_backend` when the owner has it connected) — never Profile →
Agent accounts; the same-backend option asserts only that nothing was changed. The
footer reads "could not serve this run: the provider was overloaded or failed on its
side", the pill `provider overloaded`, the controller's note "Say it again in a few
minutes", and the projection counts it as the backend being unavailable (the retry offer).
U35-11 (pass 35): the record carries `origin`. `provider` is the case above. `local` is a
connection that failed BEFORE the provider answered, inside the deployment's own
environment: the Claude CLI reports a TLS verification error, DNS or a refused socket as
"API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)" under the
same `server_error` banner with no HTTP status, and both adapters read the shared
`LOCAL_NETWORK_FAILURE_RE` (`app/shared/run-failure.ts`) for it; a run the provider did
answer with a 5xx is never local. Same class, same retry, its own attribution: the
adapter's line reads "could not be reached from this deployment: the connection failed
before the provider answered (<code>)", `describeRunFailure` names "this deployment's
network path (TLS, DNS or a proxy)", the same-backend option says "this deployment could
not reach the provider", the footer "could not be reached from this deployment", the pill
`provider unreachable`, the controller's note "could not be reached from this
deployment"; `RunView.failureOrigin` carries it to the client.
The completion pipeline writes the `blocked` event, notes model availability, opens the
stuck-loop packet and clears waiting to human. For `quota` and `auth` the event, the
packet body and the controller's note are worded by ONE module,
`app/server/tasks/run-failure-remedy.server.ts` (`describeRunFailure`, ruling 130(b)):
the reason names the backend, the owner, the spent window and the reset instant
(absolute UTC) or the organization restriction; the remedy is the owner's own move on
Profile → Agent accounts. The packet's options come from the same module for
`quota | auth | unavailable`: `retry_other_backend` first only when the **task owner**
has the other backend connected (ruling 127 — otherwise the retry would be refused for
the same reason), else a `request_edit` that sends the agent back once the window has
reset or the account changed; `redirect` is present and never recommended for a
backend failure (the agent did nothing wrong); `hold_runtime_debug` closes the set.
`unavailable` keeps ruling 127's refusal sentence as its reason. A failed OPERATOR
run's packet (`escalateFailedOperatorRun`) uses the same module: its recommended
`block_on_policy` asserts only what the human says and records exactly that in its
`ev`, never "policy / credential updated" (ruling 130(c)). A reason clause is
terminated exactly once (the `..` of F34-12 is gone).

### 3.6 Resume, continuity, export

- `resumeRun` mints `thread_id = prev + "-r" + 6 chars`, probes the provider session
  (`SESSION_MISSING_RE`: "no conversation found", "rollout not found" …). A missing
  session records `run·session_missing`, writes a `continuity` timeline event (actor
  `runtime-continuity`) and starts a fresh run whose prompt carries a continuity-reset
  preamble anchored on `task.md`. Boot recovery reuses the same path.
- The resumed turn bills the task owner **as of now**: `resumeRun` re-resolves nothing,
  the caller passes `credentialUserId` (ruling 127). A task whose owner changed since
  the original run reads as a missing session and takes the continuity-reset path above
  — one fresh run re-anchored on `task.md`, with the timeline saying context was lost.
  The alternative would be resuming one person's conversation inside another person's
  account. `resumeRun` decides that from the CHANGE (the passed principal against the
  prior run's `credential_user_id`), not from the probe: `probeSessionContinuity` looks
  only in the passed principal's home, and a home with no transcript store yet — a new
  owner who has connected the backend but never had a run here — answers `unknown`,
  which means "resume as before".
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

`run-projection` builds a per-task window of 400 lines / 384 KiB, newest run first,
with `run·resumed` boundary lines between runs; groups are keyed `operator` or
`<kind>:<profileId>`. Render states: running → running, error → error, finished →
done or idle, queued/interrupted → idle. `failedBackendUnavailable` (tag
`run·unavailable` or known signatures) marks every such run, whatever its principal, and
the Agent-logs footer states that failure in those words; only the OTHER errored runs
get the generic **"continuity error"** sentence. The retry OFFER travels separately
(ruling 127). `altBackend` rides only when the run had a credential principal — a run
refused because the task has no owner at all would be refused on the other backend for
the same reason — and the "Retry on <other>" button additionally requires that the task
owner has that other backend connected, the same test the packet's
`retry_other_backend` option must pass, so the button and the packet never tell one task
two stories. With no offer the footer states the failure and advertises no retry at all.
The task page's own controls answer from the loader's `runPrincipal` (the owner's
per-backend health), so a disabled Run names the person, never a deployment credential.
Telemetry tags are collapsed by `log-noise.ts`, and the console shows the redacted
`run·inputs` line so a human can see exactly what the agent was given. The strip's
**Tokens** cell (F35-1) reads `RunView.tokens` and `tokensEstimated`: `~1.2M` with the
tooltip "Estimated from the streamed text. The provider's own total replaces it when one
lands; a run that was stopped never gets one" whenever the row's `usage_final` is 0
(while the run is live and after it ends), "pending" while no usage envelope has landed
at all and the run is still live (a Codex run before its turn ends), and the plain figure
once the provider's total landed.

## 4. Specialist runs

### 4.1 Dispatch

`startAgentRun` → `dispatchAgentRun`:

- `wantsDelivery = input.delivers ?? (no current deliverer && profile is
  delivery-capable)`; an explicit hand-off requires the repo-write grant; a second
  deliverer is refused; `delivers: false` on the current deliverer is refused.
- Backend = `backendOverride ?? engagement.pinnedBackend ?? resolved profile backend ??
  snapshot`. `pinnedBackend` is written by a `retry_other_backend` packet resolution so
  the switch sticks. F36-8 (pass 36): a run on a backend other than the profile's hands
  the profile's ORIGINAL model through to `startRun` (no pre-swap), so the F21-13
  substitution notice opens the run log; the "Started a … run (switched from …)" event
  names the model it ran on and the profile's own ("on `sonnet` — the profile's
  `gpt-5.6-luna` is a Codex model"), and a run that set the pin says later runs on this
  task stay on that backend. The `retry_other_backend` option says both before the human
  chooses.
- Workspace: the deliverer clones into `tasks/<KEY>/workspace/<repo>` through the
  project mirror; each supporting run gets `workspace/support/<profileId>/<repo>`, a
  fresh `git clone --local` of the delivering checkout. On clone failure the run
  continues from the workspace root and says so.
- Ruling 152(c) (pass 35, G35-4): after the eligibility gates and the principal
  resolution, before anything is spent, `backendDispatchHold` is read for the run's
  backend and the account it bills. A hold makes NO run row, reservation, clone or
  process: `holdDispatch` schedules the retry (`run-agent`, the same profile and
  directive, due one minute after the reopen instant, or `UNDATED_HOLD_MS` after the
  refusal when the provider named none; not scheduled when the profile is no longer
  deployed or the task refuses a schedule), writes a `note` titled "Dispatch held" by
  `system:policy-engine` ("**Held:** Codex is out of quota until Sep 6, 2026 · 18:18
  UTC (the provider said: "…"). Developer's run starts when the window reopens
  (scheduled for …); nothing was dispatched and no decision is needed."), audits
  `task.agent.run_held { backend, until, scheduleId, profileId }`, re-projects, and
  throws `DispatchHeldError` (`ERROR_CODES.DISPATCH_HELD`, 409, `hold` record, user
  message "Held: Codex is out of quota until …; Developer's run is scheduled for
  then."). ONE retry stands per profile per window: a repeat dispatch inside the same
  hold reuses the pending `run-agent` occurrence (a newer directive replaces its
  prompt) instead of adding a second, writes no second note and no second "Scheduled:"
  event, and its audit row records `reusedSchedule`. Without that, N held attempts
  became N occurrences all due at the reopen instant, and the ones that lost the
  single-flight race at reopen deferred and then ran the same directive again.
  Every door passes through the same read (`assertDispatchNotHeld`) against its own
  target backend, so a Claude retry proceeds while Codex is held: the Run control
  toasts the sentence and writes no hand-off comment (`isDispatchHeld`), an @mention
  returns it as `runNotStarted` on both of `commentToAgent`'s branches — the RESUME
  branch reads the hold itself, before the confinement's MCP pre-flight and skill
  re-mount, because it never reaches `dispatchAgentRun` — the operator's `run_agent`
  answers `noop` with the sentence plus "Do not open a packet for this; pick a Claude
  profile if the work cannot wait" (a throw would abort the rest of the Codex
  operator's plan), the controller's `run_agent_on_task` surfaces it as the tool's
  refusal text, and a scheduled occurrence retires `held-quota` (§4.5). A hold is not a
  decision packet and costs no operator turn. The record behind it is retired by a run
  that COMPLETES on the backend and by two other things: a person resolving the quota or
  auth packet's option that states the window has reset or the account changed
  (`run-failure-remedy.server.ts` names the backend on that option; `resolvePacket`
  clears it), because the option promises the agent continues now and the record would
  otherwise park it until the recorded instant (ruling 164); and the named person
  actually changing their credential on that backend (ruling 165), because the account
  the record was about is no longer the one the dispatch would bill.
  The operator's PROMPT door (`operatorPromptAgent`) writes no "did NOT start a run"
  note for a hold either: its own note asks for the directive to be re-sent, which
  the "Dispatch held" note two lines above says is not needed and which would mint a
  second schedule over the one the hold already made carrying that same directive.
- Then: mount granted skills (Claude), resolve the browser MCP, build the persona and
  the analyze prompt (task text, comments and repo content are **data**, never
  authority; ruling 159: every path the prompt hands the agent is ABSOLUTE, so the
  "Posting files on the task thread" section, the browser section and the workspace
  contract's one exception all name `taskAttachmentsDir` in full and say it is outside
  the checkout and never committed, because the store-relative form was created inside
  a clone and pushed), resolve delivery permissions, compute the denylist (or the "everything
  off" list when the profile vanished, ruling 26), write the redacted `run·inputs`
  line, audit `task.agent.run_started`, lift a packet-less hold (`liftHoldForRun`:
  `readiness: ready`, a "Hold lifted" note naming the dispatched agent,
  `task.hold.lifted {cause: "dispatch", profileId}`; ruling 157), mark `waiting:
  agent`, register the completion callback. A resume re-derives all of it
  (`resolveResumeConfinement`), the hold lift included: an @mention that resumes an
  existing session never reaches `dispatchAgentRun`, so `commentToAgent` calls
  `liftHoldForRun` itself on that branch. That is the common case for a hold, since a
  hold is usually set because a run FAILED and the agent therefore has a session.
- Git identity in the run: `<profileId>@viberr.local`; `GIT_CEILING_DIRECTORIES` is the
  task dir.

Stage eligibility (`stages:` on the profile, `spanAll`) gates NEW engagements
(`assignSpecialist`, `assignReviewer`, the dispatch's auto-engage); an empty list means
eligible everywhere. The refusal sentence names stages by their board names ("Rev is
not eligible for the Triage stage; its profile is scoped to Review."), never raw ids. Ruling 133 (pass 34): once a profile is the task's delivering
engagement it runs at EVERY stage, on every door (the operator's `run_agent`, the Run
control, a human @mention's resume, a schedule, `retry_other_backend`), for rework,
conflict resolution and follow-ups; `runEligibilityFor` is the one home, and the
`task.agent.run_started` audit row records `stageEligibility` (`declared`,
`engaged-deliverer`, or `undeployed`), naming the exemption only when it was needed.
A supporting engagement stays stage-scoped, and an unengaged profile whose session
survives is judged by the new-engagement rule, so the @mention resume door
(`assertResumeEligible`) refuses with the dispatcher's own sentence and posts the
comment as a partial success.


Before a delivering dispatch, `ensureTaskBranchBestEffort` prepares the task branch; a
failure it cannot fix (credential rejected, GitHub unreachable, base branch missing and
not creatable, or an unexpected throw) is disclosed once on the task timeline as a
`github` event by `system:delivery`, audited as `github.branch.prepare_failed`, and logged
on every attempt; the run still starts in its workspace and delivery retries the branch
(F34-3, pass 34).

### 4.2 The `viberr_agent` toolkit (Claude specialists)

Mounted only when at least one tool is granted; Codex specialists get the outcome
envelope instead.

| Tool | Grant | Effect |
|---|---|---|
| `post_comment` | `comment-on-task` | timeline comment, audit `task.agent.commented` |
| `ask_human {title, body?, options?}` | `ask-human` | opens an "Agent question" input packet with `askedBy = profileId` (≤ 4 custom options); refused while a packet is open; the resolution resumes this agent (ruling 33) |
| `report_outcome {summary, verdict?, evidence?}` | `report-validation-verdict` for `verdict`, `attach-evidence-references` for `evidence` | staged ONCE under the run's `outcome_key`, consumed once at completion; a second call changes nothing, is answered `[already staged] Your outcome was recorded once; this call was ignored. Finish with your full findings.` and audits `task.agent.outcome_duplicate` {`runId`, `outcomeKey`, `count`} |
| `github_read {path}` | `read-github-api` | GET-only, repo-scoped read through the project PAT on the server (≤ 48 000 chars), audit `task.agent.github_read` |

The outcome is the first envelope a run reports. The already-staged check reads the
in-process map and the persisted row, so an envelope staged before a restart still stands
against a later call. The `count` is the run's refusals so far; it is cleared when
completion consumes the envelope. *(Changed 2026-09-11, Option D PR 4(b): a second call
used to replace the first without a word, "last write wins", so the verdict that counted
was whichever came last, even one sent after the agent had moved on. The tool's own
description already said "exactly once".)*

### 4.3 Capability → enforcement

Claude: `CAP_DENY_RULES` turn withheld grants into `disallowedTools`. Codex: the same
markers become `repoWriteWithheld` (`Edit|Write|NotebookEdit` denied) and
`webSearchWithheld` (`WebFetch|WebSearch` denied) and drive the sandbox mode (§2.5).
Ruling 176 adds one row that does not come from `CAP_DENY_RULES`: a withheld
`execute-code-or-write-repo` also removes the org MCP tools an admin marked as write
tools on the server (Org settings, MCP server editor), per mounted server, derived from
the same denylist (`repoWriteWithheldFromDenylist`).

| Withheld capability | Claude denies | Codex |
|---|---|---|
| `execute-code-or-write-repo` (headline) | `Edit MultiEdit Write NotebookEdit Bash(git commit:*)` | read-only sandbox — **except** the ruling-109 carve-out below |
| `execute-code-or-write-repo`, org MCP write tools (ruling 176) | `mcp__<server>__<tool>` for each marked tool; an HTTP config also carries `always_deny` | that server's `disabled_tools` (binds; no carve-out) |
| `create-task-branch` | `Bash(git checkout -b:*)`, `-B`, `git switch -c/-C` | advisory |
| `commit-push-branch` | `Bash(git push:*) Bash(git commit:*)` | advisory |
| `open-review-pr` | `Bash(gh pr create:*)` | advisory |
| `merge-pull-request` (always human) | `Bash(gh pr merge:*)` | advisory |
| `use-web-search-fetch` | `WebFetch WebSearch` | `webSearchMode: disabled` |
| `comment-on-task`, `ask-human`, `report-validation-verdict`, `read-github-api` | the toolkit tool is not built | envelope field ignored / not requested |

On Claude every command-level row above also binds through the PreToolUse capability hook
(§2.4): `git -C . push`, `sh -c 'git push'` and the like are refused with a reason naming
the withheld capability, not only the command's plain form.

**The write family binds on BOTH backends** (ruling 101): Claude through the tool
denylist, Codex through the read-only sandbox. There is exactly ONE disclosed exception,
and it is labeled rather than hidden (ruling 109): a Codex run that withholds
`execute-code-or-write-repo` while granting `attach-evidence-references` keeps
`workspace-write`, because the pinned SDK has no "read-only plus one writable directory"
sandbox and blocking the file-posting assignment was the F22-03 defect. That exact shape
— and only it; a profile with an EMPTY grant list runs fully withheld and is not tagged
— is what `codexRepoWriteAdvisory` (`app/server/tasks/specialist-tool-policy.ts`)
answers true for, and every surface rendering the enforcement says **"advisory on
Codex"**: the profile editor row, the capability matrix (naming the profiles), the agent
card's withheld bucket, and the run console's `sandbox` inputs row. The scoped delivery
commands in the rows below are a different story: they bind at the tool layer on Claude
only (the sandbox is all-or-nothing), and what constrains either backend is the
server-owned delivery gate plus credential-less agents — that is ruling 101(e), not an
unenforced rule. *(Added 2026-09-02, pass 32 — C02-R2 / V11-1: several surfaces and
comments still called Codex's file and command limits simply "advisory", which stopped
being true at ruling 101.)*

"Withheld" means: always-human ids always; absent grant when the id is in
`GRANT_REQUIRED_CAPABILITY_IDS`; mode `human` or `off`. Specialists have no `recommend`
lane: a stored `recommend` is coerced to `off` on read (ruling 81). Delivery permissions
`{ canBranch, canCommitPush, canOpenPr }` are keyed on the headline write grant.

### 4.4 Completion

`registerAgentCompletion` → `applyAgentCompletionEffects`:

1. Grants are re-resolved live (an undeployed profile becomes fully withheld).
2. Envelope = staged outcome by `outcome_key`, else a Codex parse when one was
   requested. The reply comment is posted (audit `task.agent.replied`, the recovery
   idempotency marker), with a cc-line to the dispatcher (`@<name>` or `@operator`).
3. Verdict: envelope → prose classification (`classifyReviewerVerdict`) → at the review
   stage a "no verdict" note unless a human directive dispatched the run.
   `verdictAuthorized = engagement.verdictCapable ?? live verdict grant`.
4. Question → packet using the live ask grant; evidence rows are written; browser
   working artifacts not cited are pruned (ruling 105). Ruling 159: the run's workspace
   candidates (its `workdir`, `workspace/<repoName>`, `workspace/repo`, `workspace`) are
   scanned for a stray `projects/<slug>/tasks/<KEY>/attachments` folder an older prompt
   caused; when one exists a `policy` line by `system:delivery` names the folder, the
   files it holds ("NOT posted on this task") and the real attachments dir.
5. Error runs: `blocked` timeline event (worded by `describeRunFailure` for a
   classified refusal), model-availability note, stuck-loop packet whose options come
   from the same module (`retry_other_backend` only when the owner has the other
   backend; else "send the agent back to continue"; `redirect` never recommended),
   waiting → human (ruling 130(b)).
6. Finished deliverer runs reconcile what the agent pushed itself
   (`reconcileWorkspaceDelivery`).
7. The operator reacts (`trigger: agent-reply`) when the reply is non-empty, differs
   from the previous one and `reactDepth < 4`, or always when the run was dispatched by
   name; otherwise a stuck packet and waiting → human. Auto-transition chains are
   capped at 8.

Comments addressed to agents route by handle (`agent-reply.server.ts`): `@operator` →
`@agent` (the deliverer) → a named specialist (name or id) → a single backend
candidate; an ambiguous backend handle routes to nobody. Reserved handles: `operator`,
`agent`, `claude`, `codex`. The resumed session is the latest run matching profile,
kind and backend that is not marked session-missing; the reply preview is capped at
1 200 chars and workspace paths are normalised.

### 4.5 Scheduled runs

`schedules[]` in `task.md`: `scheduleTaskAction({ dueAt, action: run-operator |
run-agent, profileId?, prompt? })` (future only, not on a terminal task, profile must
be deployed; audit `task.schedule.created`/`cancelled`), reached from the task page's
run controls and, ruling 153 (pass 35), the controller's `schedule_task_action` /
`cancel_task_schedule` under the same `run-agents` tier and bounds. `startScheduleRunner` fires at
boot and every 60 s: it claims in the file (lease = clone timeout + 5 min, 3 retries),
skips moot schedules with an outcome (`skipped-done`, `skipped-archived`), starts the
agent (`400` → failed, `409` → back to pending) or runs the operator with `trigger:
scheduled` and `scheduleId`, and audits `task.schedule.fired`. The outcomes a
`run-operator` occurrence can end with: `claimed` (the claim-time row), `skipped-done`
(terminal stage), `skipped-held` (ruling 131(d)), `skipped-packet` (ruling 141: a
decision packet is open, the same refusal a person's Run operator gets), and
`queued-behind-drive` (the run waits behind a live drive; a refusal at the front of the
lease queue then writes the final `skipped-*` row with `atDrain: true` and a "Scheduled
action skipped" note). A `run-agent` occurrence fired into a backend the instance knows
is out of quota (ruling 152(c)) retires `fired` with outcome `held-quota` and
`rescheduledAs: <the hold's own schedule id>`: the dispatcher already wrote the
"Dispatch held" note and put the retry on the schedule, so the occurrence spends no
retry and is never deferred as a 409 would be (that would mint a fresh hold and a fresh
schedule row every tick). None of the skips spends a retry. A schedule pins no backend
or autonomy (ruling 94).

## 5. The capability catalog

`UNIFIED_CAP_CATALOG` in `app/shared/capabilities.ts`; modes `direct | recommend | human |
off`.

| id | Kinds | Default | Enforcement | Notes |
|---|---|---|---|---|
| `dispatch-agents` | operator | direct | operator gate | absent ⇒ granted |
| `generate-packets` | operator | direct | operator gate | |
| `append-typed-events` | operator | direct | operator gate | |
| `stage-transitions` | operator | recommend | operator gate | full autonomy promotes to direct |
| `completion-for-acceptance` | operator | recommend | operator gate | `promotable: false`; never promoted |
| `deliver-review-pr` | operator | direct | operator gate | absent ⇒ recommend when a human gates pre-work, else direct (ruling 28) |
| `update-task-branch` | operator | direct | operator gate | absent follows delivery |
| `execute-code-or-write-repo` | agent | direct | both | headline write grant; grant-required |
| `create-task-branch` | agent | direct | claude-only | scoped; grant-required |
| `commit-push-branch` | agent | direct | claude-only | scoped; grant-required |
| `open-review-pr` | agent | direct | claude-only | scoped; grant-required |
| `comment-on-task` | agent | direct | claude-only | |
| `ask-human` | agent | direct | both | |
| `use-web-search-fetch` | agent, operator | direct | both | absent ⇒ granted |
| `use-browser` | agent | off | both | direct forces egress direct (ruling 95) |
| `read-github-api` | agent | off | claude-only | `promotable: false` |
| `report-validation-verdict` | agent | off | both | grant-required; gates `approve-review`, `request-changes`, `post-quality-flags` |
| `attach-evidence-references` | agent | direct | both | |
| `run-unit-integration-validation`, `move-task-to-review`, `read-repo-diff`, `run-validation-suites`, `post-quality-flags`, `approve-review`, `request-changes`, `author-test-cases`, `read-task-repo`, `flag-underspecified-tasks` | agent | direct | advisory | persona text only, disclosed as such (ruling 31) |
| `merge-pull-request`, `transition-to-done`, `change-project-policy` | agent | human | always human | never produce a tool on either side |

Couplings applied on save: `repairDeliveryGrants` (the headline is materialised as
direct only when absent; an explicit off/human is respected with a "withheld" notice),
`repairBrowserEgressGrants`. `withheldAgentGrants()` (human kept, everything else off)
is what an undeployed or grant-less specialist runs with. MCP grants are outside the
matrix (ruling 39), except the tools an admin marks as write tools, which a withheld
repo-write grant denies (ruling 176).

Absent-grant polarity is deliberately not uniform: `dispatch-agents` and
`use-web-search-fetch` absent ⇒ granted; `deliver-review-pr` absent ⇒ derived from
workflow strictness; the grant-required family absent ⇒ withheld.

**A save cannot revert a write it never saw** (pass 34, B5/U34-3). `updateAgentProfile`
rebuilds the whole governed grant set from the SUBMITTED form, and the editor seeds that
form once, at open time, so a modal opened before a concurrent write and saved after it
reverted every grant that write changed and reported success. Every update now carries
`deploymentFingerprint` — the sha256 of the deployment's grants (order-independent),
extras and definition, NOT of the whole file, so an unrelated project edit never refuses
a save — which the writer recomputes from the freshly parsed record inside its own lock
and refuses on mismatch with "This profile changed while the editor was open." A refused
save writes nothing and audits nothing: it is a validation refusal like every other one
on this path. A create carries none (there is no prior record); the controller's
`update_agent_deployment` sends the fingerprint of the record it just read, so its own
read-modify-write inside one turn is never refused by itself.

The controller's `update_agent_deployment` validates every capability patch against
this catalogue per KIND and refuses an unknown or impossible id or mode by name before
writing (ruling 139, `capabilityPatchRefusal`); the advisory row above has no toggle and
is refused as such. The absent-grant polarity has ONE home, `absentGrantMode` in
`agents-query.server.ts`: the roster materialises absent grants with it and the
controller's `list_capabilities` publishes it as `whenUngranted`, so the Default column
above is the create-seed value and never the runtime's answer for a missing grant.

## 6. Context mounting

- **Skills, Claude** (ruling 180, pass 36): `mountGrantedSkills` builds the run's own
  LOCAL PLUGIN at `<checkout>/../.viberr-plugins/<runId>/` — `.claude-plugin/plugin.json`
  (`name: "viberr"`) plus `skills/<slug>/` copied from the store (no symlinks, no nested
  `.git`, SKILL.md frontmatter rewritten to `name` + `description` ≤ 400 chars; ruling 183
  keeps every store writer from landing an empty, JSON-escaped or unparseable body, so
  what the mount normalises is a skill — the frontmatter schema it reads,
  `skillFrontmatterSchema`, lives with the check in `skill-body.server.ts`) — after
  `stripUngovernedRepoCatalog` has hidden the repo's own tracked `.claude` with
  `git update-index --skip-worktree` and removed it whole. Nothing Viberr writes for a run
  lives inside the tree the project's tools scan (F36-9: the in-checkout mount failed the
  project's own `prettier --check .`), so no exclude entry exists any more. The run gets
  `plugins: [{ type: "local", path }]`, `skills: ["viberr:<slug>", …]` and
  `settingSources: []`; the plugin is one per RUN (the directory is named by the run id
  when the row was reserved before the mount, else by a fresh id; the run carries the
  path) and run-service removes it when the run settles, the dispatch when a run fails
  before it starts. A plugin that is gone by the start enables no skill and the persona
  is corrected (`droppedSkillsNotice`). Residual: a run that never settles in-process (a
  crash) leaves its directory, inert, until the workspace is reclaimed. Canaried inside
  the image 2026-09-11 (SDK 0.3.261 / CLI 2.1.261): the init lists `viberr:<slug>` and the
  model invokes it.
- **Skills, Codex and the operator**: bodies are injected into the prompt under a shared
  24 000-char budget (`skill-body.server.ts`); symlinked folders or files are refused.
- **Knowledge bases**: text files under `kb/<dir>` (depth ≤ 32, no symlinks, no
  dotfiles) are injected under a separate 24 000-char budget with `### <rel>` headings and
  truncation markers; `KB_PRECEDENCE_NOTE` (repo conventions outrank KBs) is emitted only
  when KB text is present, by all three runtimes (ruling 56). Supporting runs inherit the
  deliverer's KBs, deduplicated, and nothing else (rulings 47, 57).
- **Grants mount from the deployment's copy, never from the template** (ruling 156,
  pass 35): a library deploy copies the template's `resources` onto `project.md`
  `agents[].definition.resources`, and `effectiveProfileView` reads that copy first;
  only a deployment that carries no definition (the seeded rows) resolves the template
  live. A template edit therefore changes nothing a run mounts until the copy is
  rewritten (the template writer's `propagate`, the org modal's box, or an org admin's
  "Use the template's grants" on the Agents page), and the roster marks a copy whose
  grants differ with the exact difference (`templateDrift`).
- **MCP servers**: org registry rows resolve to stdio `{command, args, env:
  {MCP_CREDENTIAL}}` or http `{url, headers: {Authorization: Bearer}}`; reserved names
  are skipped; a missing row is reported "unresolved"; an unhealthy row is still
  mounted but flagged; stdio mounts get a real discovery handshake before the run and
  are dropped (and marked unreachable) on failure. On a run that withholds repo write,
  and on every operator run, a server's marked write tools are withheld (ruling 176,
  §2.4, §2.5): the persona's MCP governance paragraph then names only the servers with no
  marks, a short section names the gated servers as mounted and lists the removed tools,
  and the run-inputs `mcp` row lists them too. Precedence when names collide:
  org < browser < toolkit. Reserved names: `viberr`, `viberr_agent`, `viberr-agent`,
  `viberr_browser`, `viberr-browser`, `viberr_controller`, `viberr-controller`,
  `viberr_ops`, `viberr-ops`.
- **Browser**: `viberr_browser` = `@playwright/mcp` cli.js run with `process.execPath`,
  `--headless --isolated --output-dir <attachments>` (+ `--image-responses omit` on
  Codex, + `--executable-path $VIBERR_BROWSER_EXECUTABLE --no-sandbox` when set).
  Requires effective `use-browser: direct` **and** `use-web-search-fetch: direct` and
  the package on disk. `/resources/health.browser` is the instance-level probe.

## 7. Workspaces and git

- Layout: `projects/<slug>/tasks/<KEY>/workspace/<repoName>` (deliverer and operator,
  shared), `…/workspace/support/<profileId>/<repoName>`, Codex operator scratch
  `<taskDir>/.operator-scratch`, attachments `<taskDir>/attachments/`. The
  store-relative spelling here is a display form (ruling 159); an agent is only ever
  handed the absolute path, and a delivery whose tree carries `projects/<slug>/tasks/`
  is refused.
- Mirror (ruling 87): bare `projects/<slug>/.repo-mirror/<owner>__<repo>.git`, `fetch
  --prune` with a heads-to-heads refspec before each clone (timeout 120 s, rebuilt after
  2 consecutive failures), then a local hardlinked clone with `origin` rewritten to the
  credential-free `https://github.com/<repo>.git`; a shallow direct clone is the
  fallback.
- Credentials never touch argv or `.git/config`: the PAT is delivered through
  `GIT_ASKPASS` (`x-access-token`), `GIT_TERMINAL_PROMPT=0`, credential helper reset.
  Clone timeout 15 min (`VIBERR_GIT_CLONE_TIMEOUT_MS`); progress is streamed to the run
  strip ("Receiving objects" 0..90 %, "Resolving deltas" 90..100 %).
- Retention: workspaces of tasks in the terminal stage are removed at boot (after run
  recovery, only when no run is live) and on every maintenance pass; transcripts and
  session homes older than 30 days are pruned (`VIBERR_TRANSCRIPT_RETENTION_DAYS`,
  `VIBERR_SESSION_HOME_RETENTION_DAYS`, `0` = forever).

## 8. Boot recovery

`reconcileRestartedWork` (fire-and-forget after the watchers start):

0. `finalizeOrphanedRuns`: `running|queued` rows → `interrupted` with
   `interrupted_reason: "restart"` (`interrupted_by` untouched: a person or null; the
   pill and footer say "interrupted by a restart", Insights counts the run as stopped and
   leaves a never-started one out of the completion rate); one `runOperator({ trigger:
   "manual" })` per affected task (controller turns get a conversation note instead),
   capped at 3 per task per 30 min via `run.recovery.reinvoked` audit rows. The orphans'
   run ids are swept too (ruling 174, §3.4): a Claude CLI leads its own group, so a
   server that died without shutting down did not take it along.
1. `recoverUnreactedAgentRuns`: finished specialist runs on tasks still `waiting: agent`
   with no `task.agent.replied` audit row carrying their run id are replayed through the
   completion pipeline using the persisted `outcome_key` (audit
   `run.recovery.reply_replayed`).
2. `recoverStrandedOperatorPlans`: finished Codex operator runs younger than 1 h with no
   `runtime.operator.plan_executed` audit row are executed.
3. After the re-invokes settle and the orphans' sweep has finished, terminal workspaces
   are reclaimed only if no run is active.

Both marker actions are exempt from the 90-day audit purge for exactly this reason.
Every mutating request is also bounded by a 30 s action watchdog (503 on an async hang).

## 9. Guardrails and loop bounds

- Comment guardrails (`project.md` `guardrails`, defaults on): `meaningful-comment`
  (only strings ≤ 60 chars can be meaningless), `no-duplicate-summary`,
  `evidence-separation` (fences longer than 12 lines are moved to evidence, 3 lines
  kept), `compression-threshold` (project default 40 events; the module fallback is
  60 / keep 24). Dropped comments audit `task.comment.dropped`. No length cap (ruling
  104).
- Prompt-side rules: task text, comments, repo content and agent reports are data; a
  directive is not an authority grant; a directive asking for delivery posts a policy
  event; supporting runs get the read-only paragraph and the delivery denies.
- Bounds: operator react depth 4, transition chain 8 (counted across re-triggered
  turns; since ruling 152(a) a live operator run's own moves queue no turn, so
  consecutive `auto` boundaries are walked inside one turn and the stranded-stage
  backstop covers an abandoned chain), carried triggers 8, recovery re-invokes 3 per
  30 min, schedule retries 3, Claude max turns 2000, idle 15 min per backend, action
  watchdog 30 s, coordination lane `max(1, ceil(cap / 4))` extra slots beyond the run
  cap for operator and controller turns (§3.2, ruling 152(b)).

## 10. Seeded catalog

`SEED_AGENT_PROFILES` (written by `npm run seed` and the demo seed) and the shipped
base templates (`app/server/seed/assets/`, refreshed by hash through
`state/shipped-assets.json`, hand-edited copies kept and warned about):

| Profile | Kind | Backends | Model | Stages | Skills / KB | Grants |
|---|---|---|---|---|---|---|
| `operator` | operator | claude, codex | `orchestration runtime` (a sentinel, not a catalog id; falls back to the backend default) | all (`spanAll`) | `viberr-app-expertise` / `architecture-notes` in demo stores, `kb: []` in the base template | direct: dispatch, packets, typed events, deliver; recommend: transitions, acceptance; human: repo write, done, policy |
| `developer` | specialist | claude, codex (Claude first) | `sonnet` | ready, impl | `developer-expertise` / `architecture-notes`, `api-contracts` | direct: repo write, branch, commit/push, open PR, comments, ask, browser, egress, advisory items; human: merge, done |
| `reviewer` | specialist | claude | `sonnet` | impl, review | `reviewer-expertise` / `api-contracts` | direct: read diff, validation suites, tests, evidence, quality flags, comments, ask, verdict, approve, request changes; human: merge, done, commit/push |
| `controller` | controller | claude | `sonnet` | n/a | `controller-guide` / `controller-handbook` | none (tools are gated by the asker's RBAC) |

The shipped operator doctrine (`operator.definition.md`, upgraded in place through
`PRIOR_SHIPPED_HASHES`) tells the operator, since ruling 131, that a wait on other work
is a fact with its own tool, `set_dependencies`, and never a packet.

`ensureBaseAgentsDeployed` runs at boot: the operator is ensured on every project;
Developer and Reviewer are backfilled only into a project with **no** specialists.
Profile files use `agentProfileFrontmatterSchema` (kind, icon default `cpu`, `resources
{skills, mcps, kb}`); unknown keys raise a drift warning and are dropped by the
serializer. Deployment overrides (`project.md` `agents[]`) carry autonomy `supervised |
full` and the project-effective grants.

## 11. Gotchas

1. `kind: reviewer` means "supporting run", not "the Reviewer profile".
2. Specialist `recommend` coerces down to `off`; operator `recommend` promotes up to
   `direct` under full autonomy, except acceptance.
3. Codex drops MCP credentials and browser images; a bearer-token MCP silently runs
   unauthenticated there.
4. Foreign-backend models are substituted at start and disclosed: the run log's first
   line, the switched-backend timeline event and the `retry_other_backend` option all
   name the model (F36-8). The run row stores what ran.
5. `RUN_STATE.error` is labelled "continuity error" for every error run.
6. Codex repo-write is enforced by the sandbox mode since ruling 101. The last code
   comment that still said "R22: no run is read-only" (`RunSpec.attachmentsWritableDir`)
   was corrected on 2026-09-11 (Option D PR 6). The one place "advisory on Codex" is
   still the honest word is the evidence carve-out of ruling 109 (§4.3), which is printed
   on every surface that shows the grant.
7. A run's skills live in a plugin directory BESIDE the checkout (ruling 180), removed
   when the run settles; nothing under the checkout is ever a settings source, so there
   is no CLAUDE.md excludes file and no `managedSettings` any more.
8. Agent backends are connected **per person** on Profile → Agent accounts (ruling 127):
   there is no deployment-wide key, no `CODEX_HOME`/`CLAUDE_CONFIG_DIR` to set and no
   host `~/.codex` mount. A wiped runtime volume signs each person out of their own
   vendor sign-in (a sealed pasted key survives in the database).
9. A supporting Claude run with write grants can commit locally in its own support
   checkout; only push, PR create and PR merge are denied on top of the grants.

The tuning knobs above (turn caps, timeouts, concurrency, the browser executable) are
environment variables and are listed in
[../operations/configuration.md](../operations/configuration.md). The agent CREDENTIALS
are not: since ruling 127 each person connects Claude and Codex on Profile → Agent
accounts, and nothing about a backend account is read from the deployment environment.
