# Configuration reference

> Every knob the running app reads, where it is read, and what the default is.
> Source of truth: `app/server/config/env.server.ts` (the validated schema and its
> `ENV_KEYS`), the raw `process.env` reads listed in §3, `Dockerfile`, `compose.yml`,
> `.env.example`, `app/server/settings/instance-settings.server.ts`.
> Verified against `main` @ `7d9fbf72` (2026-09-23).

Viberr is configured almost entirely through environment variables, validated
once at boot by `parseEnv` in `app/server/config/env.server.ts` and cached for the
life of the process by `getEnv()`. The process refuses to start and prints every
missing or invalid variable at once. Empty strings are treated as unset.

`env.server.ts` loads a `.env` from the working directory when it is imported
(Node's `process.loadEnvFile`); no file is the normal case (container, CI), and a
value already set in the process environment wins over the file. Because every
server module and every `npm run` CLI imports it, the dev server, `react-router-serve`
and the maintenance CLIs all read the same `.env`. `vite.config.ts` loads it again
for the two values it needs before the app is imported (§3).

The schema declares 34 names (`ENV_KEYS`): the two in §1 and the 32 in §2. A
handful of values are read straight off `process.env` and are listed in §3 so the
surface is complete. Settings that live in the app rather than the environment are
in §4.

## 1. Secrets (generated when unset)

Neither has to be set (ruling 504). When the environment leaves one unset, `getEnv()`
takes it from `<data root>/state/instance-secrets.json`, which the first process to need
it creates holding both (0600, in the server-only `state/`;
`app/server/config/instance-secrets.server.ts`). A value set here wins, key by key. A
backup carries the file; to take the generated values over, copy them into `.env`
unchanged ([deployment.md](deployment.md#secrets--configuration)).

| Variable | Rule | Purpose |
|---|---|---|
| `VIBERR_SESSION_SECRET` | ≥ 32 characters | Signs the session cookie (`viberr.session_token`) and the CSRF double-submit token (`app/server/auth/csrf.server.ts`), and is better-auth's secret unless `BETTER_AUTH_SECRET` is set. Generate with `openssl rand -base64 48`. |
| `VIBERR_SECRET_ENCRYPTION_KEY` | base64 decoding to exactly 32 bytes | AES-256-GCM key for every sealed secret in SQLite (`SEALED_STORES` in `app/server/secrets/key-rotation.server.ts`): GitHub PATs, MCP server credentials, sign-in provider (OAuth) client secrets, the S3 audit-export secret, and each person's pasted agent-backend key or token (ruling 127). Generate with `openssl rand -base64 32`. Losing it makes every stored secret unreadable; rotate it with `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` (§3) and `npm run keys`. |

## 2. Validated optional variables (the schema)

Every name in this section, and the two in §1, is Viberr's own configuration: the server
reads it, and **none of it reaches a process the server spawns** (ruling 142).
`filteredSpawnEnv` strips every name the schema declares from the base env that agent
runs, stdio MCP servers and the hosted sign-in driver start from, so an agent working in a
project's repository never inherits this server's `NODE_ENV`, `PORT` or data root. §3
states the rule and what still passes.

Values read through `getEnv()` are fixed for the life of the process; the ones marked
"raw" below are read off `process.env` at each call. Either way, change them in the
deployment environment and restart.

### Process and data root

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development \| production \| test`. The image sets `production` and compose forces it. Also read raw by the logger (default level) and the SSE broker (no signal handlers under `test`). |
| `PORT` | `5173` | Dev server and `react-router-serve`. The image sets `3000`; compose publishes `${PORT:-3000}` on both sides. `vite.config.ts` reads it raw for the dev server (`strictPort`). |
| `VIBERR_DATA_ROOT` | `./data` | The runtime data root (canonical markdown, SQLite, run logs, KBs, skills, per-person runtime homes). The image sets `/data` and compose forces it (the named volume `viberr-data`, ruling 460); `.env.example` sets `./docker-data`, the host dev server's own store — since ruling 460 no longer the container's, whose volume the host cannot open. Relative paths resolve against the working directory. The agent launcher is compiled against the image's value (the Dockerfile's global `VIBERR_DATA_ROOT` ARG) and refuses a home outside `<that root>/runtimes/users/`. `vite.config.ts` reads it raw to keep the root out of the dev watcher. |
| `VIBERR_FORCE_DATA_ROOT_LOCK` | unset | `1`, `true` or `yes` for ONE boot (or one CLI run) to take over a `state/writer.lock` whose holder cannot be judged, typically one left by a process on another host (`forceDataRootTakeover` in `app/server/db/data-root-lock.server.ts`). See the single-writer lock in the [runbook](runbook.md#the-single-writer-lock-and-cli-refusals). |
| `VIBERR_RUN_TMP_ROOT` | `viberr-runs` under the server's temp directory (the container's `/tmp` in the image) | Where each agent run's own temporary directory is made, `<root>/<runId>` (ruling 636, `app/server/runtimes/run-tmp.server.ts`). The run's processes get it as `TMPDIR`, `TMP` and `TEMP`; it is removed as the run's person a grace after the run settles, and boot removes any a stopped server left. The root is the server's own, `0710` in the agent group, so an agent enters its run's directory and lists no other; a root that is a link or another user's is refused, and each run then starts without one, saying so on its console. |
| `BETTER_AUTH_URL` | unset | Absolute public origin. Optional in dev (inferred per request). **Required behind a reverse proxy**: better-auth derives OAuth callback URLs, `trustedOrigins` and the cookie `Secure` attribute from it, and its origin is the one the app's origin check (`assertTrustedOrigin`) accepts sign-ins and form posts from besides the request's own, so unset behind the proxy every sign-in and form post answers 403 (ruling 687). `publicOrigin()` (its origin, else the request's) gives the callback the Sign-in & SSO card shows and the Google probe sends, and the redirect URI an MCP OAuth sign-in registers and sends, `<origin>/resources/mcp-oauth/callback` (rulings 469 and 687). `appOrigin()` uses it for the back-links in PR bodies (no link at all when unset). Boot warns when an OAuth client id is configured without it, and when it is an `http://` non-loopback origin under `NODE_ENV=production` (`insecureAuthOriginWarning`). |
| `BETTER_AUTH_SECRET` | falls back to `VIBERR_SESSION_SECRET` | ≥ 32 chars. Set only to rotate the auth secret independently. |
| `VIBERR_TRUST_PROXY` | unset (trust none) | Number of trusted reverse proxies, read raw. Only when it is a positive integer does the login throttle read `X-Forwarded-For`, taking the Nth hop from the right; otherwise (or when the chain is shorter than N) the ip half of the `email\|ip` key is `local` (`clientIpOf` in `app/server/auth/rate-limit.server.ts`). |

### Sign-in

| Variable | Default | Notes |
|---|---|---|
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | unset | GitHub OAuth app (callback `/api/auth/callback/github`). A row in the `oauth_providers` table, managed on the org settings Sign-in & SSO tab, **overrides** these (ruling 72). |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | unset | Google OAuth web client (callback `/api/auth/callback/google`). Same override rule. |
| `VIBERR_SEED_ADMIN_EMAIL` | `admin@viberr.dev` (`DEFAULT_SEED_ADMIN_EMAIL`) | Bootstrap admin, created only while the `users` table is empty (boot and `npm run seed` both call `seedInitialAdmin`). |
| `VIBERR_SEED_ADMIN_PASSWORD` | boot: random one-time password printed once as `VIBERR BOOTSTRAP ADMIN`; seed CLIs: `SEED_DEFAULT_PASSWORD` (`viberr-dev-2828`) | ≥ 8 characters. The boot-generated password forces a reset at first sign-in (`pwreset_required`). `npm run seed:demo` uses it for `arda@viberr.dev`. |

### Agent backends: none

There are no agent-backend environment variables (ruling 127). Claude and Codex are
connected **per person** on Profile → Agent accounts, and each run is built from the
credential of the one person it bills; see §4 and
[deployment.md](deployment.md#agent-accounts-are-per-person-ruling-127). The names
`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `VIBERR_CLAUDE_USE_CLI_AUTH`,
`CLAUDE_CONFIG_DIR`, `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, `OPENAI_API_KEY`, `CODEX_HOME`
and `VIBERR_CODEX_USE_CLI_AUTH` are not in the schema (`env.server.test.ts` asserts it),
and the image and `compose.yml` set none of them.

Setting one of them in the deployment environment does nothing useful: the schema does
not read it, and `filteredSpawnEnv()` (`app/server/runtimes/runtime-registry.server.ts`)
strips every credential-shaped name and the vendor home names from the base env both
adapters spawn on, so an ambient value never reaches an agent process. The only
credential env a child sees is its principal's, added by `runCredentialFor` for that one
run (§3).

### Runtime tuning (ruling 458(j))

Parsed by the schema, which owns their coercion and defaults, as it does for the knobs
in the next section; each call site reads the typed value through `getEnv()`. The
numbers take `Number()` coercion. The turn cap must be 1 or more (a fraction rounds down),
the timeouts a number above zero, and the retention windows a number of days, `0` or more.
A value that does not parse fails boot with "Invalid environment configuration".

| Variable | Default | Read by |
|---|---|---|
| `VIBERR_CLAUDE_MAX_TURNS` | `2000` | Runaway turn cap for a Claude run; hitting it ends the run as `run·error·max_turns` (`resolveMaxTurns`, `claude-runtime.server.ts`, via `getEnv()`). |
| `VIBERR_CLAUDE_IDLE_TIMEOUT_MS` | `900000` (15 min) | Idle window before a Claude run is treated as hung and interrupted (`claudeIdleTimeoutMs`, `claude-runtime.server.ts`, via `getEnv()`). |
| `VIBERR_CODEX_IDLE_TIMEOUT_MS` | `900000` (15 min) | Same guard for Codex (`codexIdleTimeoutMs`, `codex-runtime.server.ts`, via `getEnv()`), counted from the later of the last stream event and the last write to the run's rollout (ruling 595). |
| `VIBERR_GIT_CLONE_TIMEOUT_MS` | `900000` (15 min) | Ceiling on one `git clone` / mirror fetch (`cloneTimeoutMs`, `git-clone-auth.server.ts`, via `getEnv()`); the schedule claim lease is sized against it. |
| `VIBERR_TRANSCRIPT_RETENTION_DAYS` | `30` | Age at which `runtimes/<backend>/<runId>.jsonl` is pruned (`transcript-retention.server.ts`, via `getEnv()`). `0` keeps forever. Aligned with the 30-day `run_log_lines` window. |
| `VIBERR_SESSION_HOME_RETENTION_DAYS` | `30` | Same window and rules for the per-person provider session files (`runtimes/users/*/claude-home/projects/**`, `runtimes/users/*/codex-home/sessions/**`). `*.jsonl` only, so a sign-in file is never pruned. |

### Maintenance, disk space and the write probe (rulings 458(c) and 458(i))

Parsed by the schema, which owns their coercion and defaults; each module reads the
typed value through `getEnv()`. The numbers take `Number()` coercion (so `1.5` and `1e3`
parse) and must come out above zero; the two periods are in seconds and at most `86400`
(24 hours). A value that does not parse fails boot with "Invalid environment
configuration", like any other invalid variable. So does the retired
`VIBERR_MAINTENANCE_INTERVAL_MS` or `VIBERR_DISK_CHECK_INTERVAL_MS`: the message names
the `_SECONDS` variable that replaced it. Like the rest of the env, they are read once
per process: restart to apply a change.

| Variable | Default | Read by |
|---|---|---|
| `VIBERR_MAINTENANCE_INTERVAL_SECONDS` | `21600` (6 h) | Cadence of the periodic store-maintenance pass, in seconds (`startMaintenanceScheduler`, `app/server/ops/maintenance.server.ts`). |
| `VIBERR_DISK_CHECK_INTERVAL_SECONDS` | `300` (5 min) | Cadence of the free-space check on the data root, in seconds (`maintenance.server.ts`). |
| `VIBERR_DISK_LOW_FREE_MB` | `2048` | Free-space threshold below which the data root reads `low` (`diskThresholds`, `app/server/ops/disk-space.server.ts`). |
| `VIBERR_DISK_CRITICAL_FREE_MB` | `512` | Threshold for `critical`. Either state marks health `degraded` and triggers an out-of-band maintenance pass at most every 30 minutes (`MIN_PRESSURE_PASS_GAP_MS`). |
| `VIBERR_HOST_DISK_PATH` | unset; `compose.yml` sets `/host-disk` | A directory on the host disk under the data root, measured beside it; when it has less room, it is the reading, with `source: host` (ruling 603, `measureDataRootSpace`). Compose mounts `./.host-disk` there read-only, because Docker Desktop's named volume reports its disk image's virtual size, not the host's free space. On a Linux host whose Docker storage is on another disk than the checkout, set it empty in `.env` to measure the data root alone. |
| `VIBERR_GITHUB_WRITE_PROBE` | off | `1`, `true` or `yes` opts the PAT validator into an empty-payload write probe; `0`, `false` or `no` leaves it off, and any other spelling fails boot. Off, write access is proved read-only from the repo `permissions` block (`writeProbeEnabled`, `pat-validator.server.ts`). |

### Governed browser

| Variable | Default | Notes |
|---|---|---|
| `VIBERR_BROWSER_EXECUTABLE` | unset; the image sets `/usr/bin/chromium` | Absolute path of the browser the `use-browser` capability's Playwright MCP server drives (ruling 75, `specialist-browser-mcp.server.ts`). When set, the server passes `--executable-path <path> --no-sandbox` to that MCP server (chromium's user-namespace sandbox cannot start under Docker's default seccomp profile as a non-root user). A set path that is not on disk makes health's `browser` read `unavailable`. Unset on a dev host, Playwright's own browser resolution applies. |

### MCP gateway

| Variable | Default | Notes |
|---|---|---|
| `VIBERR_MCP_PROXY_PORT` | `0` (a free port picked at boot) | Port of the loopback MCP gateway (ruling 461, `app/server/mcp-proxy/gateway.server.ts`), always bound to `127.0.0.1` and never reachable from outside the host or container. A run reaches every org MCP server that has a stored credential through it with a run-scoped token, so the credential never enters an agent process. `0` reads the chosen port back after listening; set a number only when something on the host needs it fixed. A port that cannot be bound leaves credentialed servers unmountable (each run's prompt says why) and health reports `mcpProxy.listening: false`; boot carries on. Integer `0`–`65535`, anything else fails boot. |

### Build identity

Baked at image-build time and read by `app/server/ops/build-info.server.ts` (raw), which
reports them on the boot integrity line, on `/resources/health` → `build` and in the
controller's `instance_health`. All three are optional and nothing is ever guessed: an
unstamped build reports `null`.

| Variable | Default | Notes |
|---|---|---|
| `VIBERR_BUILD_VERSION` | unset → `package.json` `version` | Semver of the build. |
| `VIBERR_BUILD_SHA` | unset → the checkout's `.git` (file reads only), else `null` | Full commit sha; reported shortened to 12 chars, with `revisionSource: env` when it came from here and `git` when it came from a checkout. |
| `VIBERR_BUILD_TIME` | unset → `builtAt: null` | ISO timestamp of the build. |

The `Dockerfile` declares all three as `ARG` and re-exports them as `ENV`, and
`compose.yml` passes each through as a build arg interpolated with an empty default
(ruling 345). `npm run deploy` fills them from git; a bare `docker compose build` leaves
them empty and the image reports `version` from `package.json` with a `null` revision
(`.dockerignore` excludes `.git`, so env is the only source a container has). The manual
equivalent of the deploy script's stamp:

```bash
docker compose build \
  --build-arg VIBERR_BUILD_SHA=$(git rev-parse HEAD) \
  --build-arg VIBERR_BUILD_TIME=$(date -u +%FT%TZ)
```

### Controller configuration locks (ruling 108)

| Variable | Default | Notes |
|---|---|---|
| `VIBERR_UNLOCK_CONTROLLER_SKILLS` | locked | `enabled` (case-insensitive) unlocks the controller's skill grants for in-app editing. Any other value, or unset, keeps them locked, org admins included. |
| `VIBERR_UNLOCK_CONTROLLER_KB` | locked | Same, for knowledge-base grants. |
| `VIBERR_UNLOCK_CONTROLLER_MCPS` | locked | Same, for org MCP server grants. The built-in `viberr_ops` diagnostics mount is never a section and cannot be removed. |
| `VIBERR_UNLOCK_CONTROLLER_INSTRUCTIONS` | locked | Same, for the controller's doctrine file. |

Model and effort stay editable regardless. Compose passes all four through with
`disabled` as the default. Restart to apply.

**What a save does under a lock** (`saveControllerConfig` in
`app/server/controller/controller-profile.server.ts`) — this matters to anything that
posts the form other than the panel:

| Posted for a locked section | Result |
|---|---|
| nothing, or an EMPTY list | **keep the stored value.** Blank means keep, never clear. The panel relies on this: under a lock it posts blank for the locked sections so the stored grants round-trip byte-for-byte |
| a NON-empty list that differs from what is stored | **refused**, naming the section and its unlock variable |
| a list holding the same members as the one it was SHOWN | passes — an identical round-trip is not a change. The comparison is set-based against the *displayed* list (for skills that is the stored list, or `CONTROLLER_DEFAULT_SKILLS` (`controller-guide`) when the stored one is empty), and the stored list is still written back verbatim, order and duplicates included |

The same rule holds for the instructions body: blank keeps the file, a non-blank body
identical to the stored doctrine is accepted and not rewritten, and a differing
non-blank body is refused. The consequence worth stating plainly is that **a scripted
caller cannot clear a locked list**: there is no posted value that empties one, because
the value that would mean "empty" means "keep". Clearing requires unlocking the section
at deploy time and restarting.

## 3. Raw `process.env` reads outside the schema

What is left here is honoured but not declared in the schema.
`env.server.test.ts` gates the `VIBERR_*` names: every raw `process.env.VIBERR_*` read in
a non-test file under `app/` must be declared in the schema, and it and every declared key
must appear as a `NAME=` or `#NAME=` line in `.env.example`. The exceptions are named in
the test: the test-only hooks `VIBERR_CATALOG_PROBE_MARKER`, `VIBERR_CLAUDE_TEST_MARKER`,
`VIBERR_CODEX_TEST_MARKER`, and `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS`, which
`.env.example` documents only as a commented rotation note.

| Variable | Default | Where |
|---|---|---|
| `LOG_LEVEL` | `info` in production, `debug` otherwise | `app/server/logging/logger.server.ts`. Values `debug \| info \| warn \| error`; anything else falls back to the default. |
| `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` | unset | Comma-separated retired keys, newest first, for a rotation window (`previousSecretKeys`, `app/server/secrets/secret-box.server.ts`). Reads only; an entry that is not base64 of 32 bytes is skipped silently so a key list never reaches an error message. `npm run keys -- status` says when it can be dropped. |
| `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `TEMP`, `TMP` | inherited | The whole env of a toolchain version probe (`probeBaseEnv`, `app/server/ops/toolchain.server.ts`); a probe has no principal, so it gets these and nothing else. |
| `VIBERR_E2E_KEEP` | unset | `1` keeps the e2e compose stack up after `npm run e2e` (`scripts/e2e.ts`). |
| `VIBERR_E2E_BASE_URL` | set by `scripts/e2e.ts` | The Playwright base URL; `playwright.config.ts` refuses to run without it. |
| `CI` | unset | `playwright.config.ts`: `forbidOnly`, one retry and the HTML reporter when set. |
| `VIBERR_DATA_ROOT`, `PORT` | as in §2 | Also read raw by `vite.config.ts` after its own `loadEnvFile()`: the data root is excluded from the dev watcher, and the port is the dev server's. |

Several server modules also start a child from the whole server environment rather than
reading one name: `filteredSpawnEnv` (below), the Codex adapter's fallback when no env is
passed, and the server's own `git` calls (`git-clone-auth.server.ts`,
`repo-mirror.server.ts`, `workspace-refresh.server.ts`). The run sink's line redactor
(`createLineRedactor`, `run-sink.server.ts`) reads the server environment for the VALUES
of every credential-shaped name and scrubs them, and the run's own pasted credential, from
every persisted log line. `scripts/deploy.ts` and `scripts/e2e.ts` hand their environment
to `docker compose` / Playwright.

**What a spawned process gets.** The runtime never inherits its own configuration into
the processes it spawns (ruling 142). Agent runs, spawned stdio MCP servers, the hosted
sign-in driver and the vendor sign-out all start from `filteredSpawnEnv`
(`app/server/runtimes/runtime-registry.server.ts`), which drops:

- **every name the env schema declares** (`ENV_KEYS`: everything in §1 and §2, so
  `NODE_ENV`, `PORT`, `VIBERR_DATA_ROOT`, `BETTER_AUTH_URL`, the OAuth client ids,
  `VIBERR_TRUST_PROXY`, the unlock flags and every tuning knob). The rule is keyed on the
  schema, so a knob declared tomorrow is stripped tomorrow;
- every credential-shaped name (`CREDENTIAL_ENV_RE`: a name segment `API_KEY`,
  `ACCESS_KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `PRIVATE_KEY`, `CREDENTIAL(S)` or
  `AUTH`);
- `DATABASE_URL`, `REDIS_URL`, `SSH_AUTH_SOCK`, `GPG_AGENT_INFO`;
- the vendor homes `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `CODEX_SQLITE_HOME`
  (`RUNTIME_HOME_ENV_RE`, rulings 127 and 181);
- the Claude CLI's prompt-cache switches `DISABLE_PROMPT_CACHING` (and its per-model
  variants), `ENABLE_PROMPT_CACHING_1H` (and `_BEDROCK`), `FORCE_PROMPT_CACHING_5M`,
  `CLAUDE_CODE_PROMPT_CACHE_TTL` and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`
  (`PROMPT_CACHE_ENV_RE`, ruling 506), so one on the host cannot turn caching off or
  force a lifetime for every run;
- the Claude CLI's compaction switches `CLAUDE_CODE_AUTO_COMPACT_WINDOW`,
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `DISABLE_AUTO_COMPACT` and `DISABLE_COMPACT`
  (`COMPACTION_ENV`, ruling 506), which a server started from inside a Claude Code
  session inherits, so one cannot move, stop or refuse any run's compaction.

**A name the schema does not declare passes through**: `PATH`, `HOME`, locale, proxy
settings and the image's `UV_CACHE_DIR` / `UV_PYTHON_INSTALL_DIR` (§5) reach the child,
which is what keeps `npx` MCP servers, `uvx` and the vendor CLIs working. That is safe
because the gate above keeps the schema complete: the undeclared names in this section's
table are either credential-shaped and stripped by the regex
(`VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS`) or harmless in a child (`LOG_LEVEL`,
`VIBERR_E2E_*`, `CI`). Nothing a child needs comes from a declared name:
`VIBERR_BROWSER_EXECUTABLE` is read by the server and handed to the browser MCP as argv,
and the agent toolkit and the controller's `viberr_ops` mount are in-process servers that
read the validated env themselves.

On top of that base a run adds exactly these keys, and `harness-hermeticity.server.test.ts`
pins the set by name:

- the principal's home, `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, and for a pasted credential
  that one key: `ANTHROPIC_API_KEY` (Claude), `CODEX_API_KEY` (an OpenAI Platform key) or
  `CODEX_ACCESS_TOKEN` (a ChatGPT workspace token) (`runCredentialFor`,
  `backend-credentials.server.ts`). The Codex adapter then points `CODEX_HOME` at the run's
  private fork `<codex-home>/runs/<runId>/` and sets `CODEX_SQLITE_HOME` to the shared home
  (ruling 181);
- `GIT_CEILING_DIRECTORIES=<task directory>` for a run in a task workspace, so git
  discovery cannot climb above it;
- `VIBERR_RUN_ID=<runId>` (ruling 174). It is not a knob and is not in the schema; the run
  service sets it last, and nothing reads it but the settle sweep, which finds the run's
  leftover processes by it (`app/server/runtimes/run-processes.server.ts`, 5 s grace,
  `RUN_REAP_GRACE_MS`). There is no environment variable for the sweep.

No context window rides a run's child env (ruling 376): every `AUTO_COMPACT_WINDOW` entry
in `app/server/runtimes/context-policy.server.ts` is null,
so the CLI compacts at its model's own limit, and a session above
`COMPACT_AT_COMPLETION_TOKENS` (100k) is compacted at the end of its run instead (not
after an interrupt, and not after a run its provider refused, ruling 599). The key
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` would be set by the run service from that table if an
entry were ever non-null again, and Codex would take its window through `config.toml`
(§2.5 of `agents-and-runtime.md`). It is not a deployment knob, and one in the server's own
environment is stripped before it reaches a child (ruling 506). No cache-TTL variable is
set on any run (ruling 374: `CLAUDE_CODE_PROMPT_CACHE_TTL` and `FORCE_PROMPT_CACHING_5M`
stay unset; the CLI's automatic choice stands), and one in the server's own environment
is stripped before it reaches a child (ruling 506).

The server's own git (clone, mirror fetch, delivery push) never puts a token in argv, a
URL or a config file: `createGitHubAskpassEnv` / `createGitHubClonePlan`
(`git-clone-auth.server.ts`) set `GIT_TERMINAL_PROMPT=0`, blank `credential.helper`
through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0`, and, when there
is a token, point `GIT_ASKPASS` at a throwaway script that answers from
`VIBERR_GIT_ASKPASS_USERNAME` / `VIBERR_GIT_ASKPASS_PASSWORD`; all three are deleted and
the script removed when the git process exits. Agents hold no GitHub credential.

## 4. Configuration that is not an environment variable

| Setting | Where it lives | Who edits it |
|---|---|---|
| Run concurrency cap (`maxConcurrentRuns`, `0` = unlimited, ceiling 64 (`MAX_CONCURRENT_RUNS_CEILING`); a positive cap carries a coordination lane of `max(1, ceil(cap / 4))` extra slots for operator and controller turns, ruling 152(b)) | `instance_settings` table | Org admin, Instance settings, the run-concurrency control below the tabs (`set-concurrency` intent) |
| Spending cap per Claude run (`maxRunSpendUsd`, USD above zero with at most two decimals, none by default; ruling 175). Claude only: the SDK's `maxBudgetUsd`; Codex has no budget option | `instance_settings` | Org admin, Instance settings, the spending-cap row under run concurrency (`set-run-spend-cap` intent; audited as `org.run_spend_cap.changed`) |
| Backend quota observations (`backendRateLimit.<backend>`, `backendQuotaExhausted.<backend>`, `backendCredentialRefused.<backend>`) | `instance_settings` | Written by the run sink from Claude `rate_limit_event` envelopes and from classified refusals (ruling 130(d): each names the account the run billed); read by `/insights`, `instance_health`, the person's Profile card and the dispatch hold (`backendDispatchHold`, ruling 152(c)); the unauthenticated health body strips the person (`stripQuotaPrincipals`) |
| OAuth sign-in providers | `oauth_providers` table (sealed client secret) | Org admin, Sign-in & SSO tab; overrides the env pair per provider |
| S3 audit export target | `s3_audit_config` table (sealed secret key) | Org admin, Audit panel |
| Controller model, effort, grants, instructions | `agents/profiles/controller.md` + `agents/definitions/controller.md` in the data root | Org admin, Controller tab; grant sections and instructions locked unless unlocked by env (§2) |
| Per-project workflow, members, agent deployments, guardrails, credential policy | `projects/<slug>/project.md` | Project admins through Policy / Settings / Agents |
| Per-user theme, notification routing, timeline default, pins | `users.theme` + cookie `viberr_theme`; `user_prefs` table | The user, Profile overlay |
| Home's setup checklist closed for the session (ruling 621) | cookie `viberr_setup_hidden`: the sign-in's session id, HttpOnly, no expiry, so it ends with the browser's session and matches no later sign-in | The person, the checklist's close (`hide-setup` intent), offered once they can see a project |
| Personal backend credentials (ruling 127), several accounts per backend (ruling 507) | `user_backend_credentials`, one row per account (sealed `secret_box` for a pasted key or token; a `login` row holds no secret) + the vendor's own file in that account's home, `runtimes/users/<id>/{claude-home,codex-home}/accounts/<accountId>` | The person, Profile → Agent accounts: connect, switch, rename, disconnect |
| Which account a run bills (the credential principal) | derived per run and persisted as `agent_runs.credential_user_id`, and which of that person's accounts as `agent_runs.credential_account_id` | Nobody sets the person: task runs take the task owner, controller turns the asker (`run-principal.server.ts`); the account is the one that person has in use, which they choose on Profile → Agent accounts |

## 5. What the container image bakes in

From the `Dockerfile` runtime stage: `NODE_ENV=production`, `VIBERR_DATA_ROOT=/data`,
`UV_CACHE_DIR=/data/runtimes/uv-cache`, `UV_PYTHON_INSTALL_DIR=/data/runtimes/uv-python`,
`PORT=3000`, `VIBERR_BROWSER_EXECUTABLE=/usr/bin/chromium`, and the three
`VIBERR_BUILD_*` build args re-exported as `ENV` (empty unless stamped). Everything else
comes from `.env` via compose `env_file`, which is optional (ruling 504). One `.env`
variable is Compose's rather than the app's: `VIBERR_CPUS` sets the container's CPU ceiling
(unset, none). Compose additionally forces `NODE_ENV=production`
and `VIBERR_DATA_ROOT=/data` even when `.env` carries the dev values, passes the four
controller unlock flags with `disabled` as the default, pins `hostname: viberr` (so a
recreated container can reclaim its own writer lock), runs with `init: true` and mounts
the named volume `viberr-data` at `/data` (ruling 460).

The image bakes **no** backend credential and **no** runtime home, and it declares no
`ENTRYPOINT`: the CMD runs `node` on `react-router-serve` directly as pid 1 (so a
`docker compose stop` SIGTERM reaches the process that checkpoints the WAL and releases
the writer lock), and compose's `init: true` reaps orphans. Each person's home is created
on demand at `/data/runtimes/users/<userId>/{claude-home,codex-home}` by
`ensureUserBackendHome`, each of their accounts' homes inside it by
`ensureBackendAccountHome` (ruling 507), and all of it is handed to that person's agent uid.

Ruling 460's image pieces are build arguments, not environment variables: the Dockerfile's
global `ARG VIBERR_AGENT_UID_FLOOR=20001`, `VIBERR_AGENT_UID_MAX=59999`,
`VIBERR_AGENT_GID=20000` and `VIBERR_DATA_ROOT=/data` are compiled into the setuid launcher
`/usr/local/libexec/viberr-launch` (root:node 4750), which reads none of them from its
environment; `agent-isolation.server.ts` holds the same three numbers and a test pins them
to the ARG defaults. The image also creates the group `viberr-agents` (with `node` in it)
and a root-owned `/etc/gitconfig` carrying `safe.directory=*` and
`core.sharedRepository=group`. The launcher reads exactly three variables from the
environment the server hands it — `VIBERR_LAUNCH_UID`, `VIBERR_LAUNCH_EXEC` and
`VIBERR_LAUNCH_HOME` — and removes every `VIBERR_LAUNCH_*` name before it execs anything;
they are process plumbing, not configuration, and nothing reads them from `.env`.

## 6. Local development

`.claude/launch.json` defines two launchers: `viberr-dev` exports
`VIBERR_DATA_ROOT=<repo>/docker-data` on port 5173 and **refuses to start while the
`viberr-app-1` container is running** (two writers on one data root corrupt the
SQLite WAL — true while the container still ran on that directory; since ruling 460 it
runs on the named volume, and the host dev server's `./docker-data` is its own store);
`viberr-dev-hermetic` uses `<repo>/data` on port 5174. The host dev server has no agent
launcher, so its runs spawn as your own user and its health says `agentIsolation: off`.
`vite.config.ts`
loads `.env` itself and excludes the data root from the dev watcher, because task
workspaces under it are full nested clones of the target repository.
