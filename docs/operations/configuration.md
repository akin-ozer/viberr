# Configuration reference

> Every knob the running app reads, where it is read, and what the default is.
> Source of truth: `app/server/config/env.server.ts` (the validated schema),
> plus the raw `process.env` reads listed in §3. `.env.example` documents the
> operator-facing subset. Verified against `main` @ `68b5480` (2026-09-01);
> §2 and §3 re-verified 2026-09-02 against `pass32/implementation` @ `478bed0`.
> Updated 2026-09-02 for ruling 127 (branch `claude/per-user-codex-auth-difdnn`):
> the nine deployment-wide agent-backend variables are gone; agent backends are
> connected per person and appear in §4, not here.

Viberr is configured almost entirely through environment variables, validated
once at boot by `parseEnv` in `app/server/config/env.server.ts`. The process
refuses to start and prints every missing or invalid variable at once. Empty
strings are treated as unset. A handful of tuning knobs are read straight off
`process.env` and are listed separately in §3 so the surface is complete.

Three things are **not** environment variables and are listed in §4: instance
settings an org admin edits in the app, the controller's own configuration
files, and the in-app OAuth provider rows that override the deployment env.

## 1. Required

| Variable | Rule | Purpose |
|---|---|---|
| `VIBERR_SESSION_SECRET` | ≥ 32 characters | Signs the session cookie (`viberr.session_token`) and the CSRF double-submit token. Generate with `openssl rand -base64 48`. |
| `VIBERR_SECRET_ENCRYPTION_KEY` | base64 decoding to exactly 32 bytes | AES-256-GCM key for every sealed secret in SQLite: GitHub PATs, MCP credentials, OAuth client secrets, the S3 audit export key, and each person's agent-backend API keys (ruling 127). Generate with `openssl rand -base64 32`. Losing it makes every stored secret unreadable; rotate it with `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` + `npm run keys`. |

## 2. Validated optional variables (the schema)

Every name in this section, and the two in §1, is Viberr's own configuration: the server
reads it, and **none of it reaches a process the server spawns** (ruling 142).
`filteredSpawnEnv` strips every name the schema declares from the base env that agent
runs, stdio MCP servers and the hosted sign-in driver start from, so an agent working in a
project's repository never inherits this server's `NODE_ENV`, `PORT` or data root. §3
states the rule and what still passes.

### Process and data root

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development \| production \| test`. The image sets `production`. |
| `PORT` | `5173` | Dev server and `react-router-serve`. The image sets `3000`; compose maps `${PORT:-3000}` on both sides. |
| `VIBERR_DATA_ROOT` | `./data` | The runtime data root (canonical markdown, SQLite, run logs, KBs, skills). The image sets `/data`; `.env.example` tells developers to set `./docker-data` so the host and the container share one store. Relative paths resolve against the working directory. |
| `VIBERR_FORCE_DATA_ROOT_LOCK` | unset | Set to `1`/`true` for ONE boot to take over a `state/writer.lock` left by a process on another host. See the single-writer lock in the runbook. |
| `BETTER_AUTH_URL` | unset | Absolute public origin. Optional in dev (inferred per request). **Required behind a reverse proxy**: better-auth derives OAuth callback URLs, `trustedOrigins` and the cookie `Secure` attribute from it. Boot warns when OAuth is configured without it, and when it is an `http://` non-loopback origin in production. |
| `BETTER_AUTH_SECRET` | falls back to `VIBERR_SESSION_SECRET` | ≥ 32 chars. Set only to rotate the auth secret independently. |
| `VIBERR_TRUST_PROXY` | unset (trust none) | Number of trusted reverse proxies. Only when set does the login throttle read `X-Forwarded-For`, taking the Nth hop from the right (`clientIpOf` in `app/server/auth/rate-limit.server.ts`). |

### Sign-in

| Variable | Default | Notes |
|---|---|---|
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | unset | GitHub OAuth app (callback `/api/auth/callback/github`). A row in the `oauth_providers` table, managed on the org settings Sign-in & SSO tab, **overrides** these (ruling 72). |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | unset | Google OAuth web client (callback `/api/auth/callback/google`). Same override rule. |
| `VIBERR_SEED_ADMIN_EMAIL` | `admin@viberr.dev` | Bootstrap admin, created only while the `users` table is empty (boot and `npm run seed` both call `seedInitialAdmin`). |
| `VIBERR_SEED_ADMIN_PASSWORD` | boot: random one-time password printed once as `VIBERR BOOTSTRAP ADMIN`; seed CLI: `SEED_DEFAULT_PASSWORD` | ≥ 8 characters. The boot-generated password forces a reset at first sign-in (`pwreset_required`). |

### Agent backends: none

There are no agent-backend environment variables (ruling 127). The deployment-wide
`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `VIBERR_CLAUDE_USE_CLI_AUTH`,
`CLAUDE_CONFIG_DIR`, `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, `OPENAI_API_KEY`,
`CODEX_HOME` and `VIBERR_CODEX_USE_CLI_AUTH` were deleted from the schema, from
`.env.example`, from the image and from `compose.yml`. Claude and Codex are connected
**per person** on Profile → Agent accounts, and each run is built from the credential of
the one person it bills; see §4 and
[deployment.md](deployment.md#agent-accounts-are-per-person-ruling-127).

Setting one of those names in the deployment environment does nothing useful: the schema
does not read it, and `filteredSpawnEnv()` (`runtime-registry.server.ts`) strips every
credential-shaped variable from the base env both adapters spawn on, so an ambient value
never reaches an agent process either. The only credential env a child ever sees is the
principal's, added by `runCredentialFor` for that one run.

*(Corrected 2026-09-02, ruling 127 — this section used to be a seven-row table of
deployment credentials plus a presence-only availability rule. Both are gone: presence of
a key on this server is no longer what makes a backend usable, and `isBackendAvailable`
no longer exists.)*

### Runtime tuning

Declared in the schema as raw strings; each call site applies its own coercion
and fallback.

| Variable | Default | Where |
|---|---|---|
| `VIBERR_CLAUDE_MAX_TURNS` | `2000` | Runaway turn cap for a Claude run; hitting it ends the run as `run·error·max_turns` (`claude-runtime.server.ts`). |
| `VIBERR_CLAUDE_IDLE_TIMEOUT_MS` | `900000` (15 min) | Idle window before a Claude run is treated as hung and interrupted. |
| `VIBERR_CODEX_IDLE_TIMEOUT_MS` | `900000` (15 min) | Same guard for Codex. |
| `VIBERR_GIT_CLONE_TIMEOUT_MS` | `900000` (15 min) | Ceiling on one `git clone` / mirror fetch (`cloneTimeoutMs` in `git-clone-auth.server.ts`); the schedule claim lease is sized against it. Ignored unless a positive integer. |
| `VIBERR_TRANSCRIPT_RETENTION_DAYS` | `30` | Age at which `runtimes/<backend>/<runId>.jsonl` is pruned. `0` keeps forever. Aligned with the 30-day `run_log_lines` window. |
| `VIBERR_SESSION_HOME_RETENTION_DAYS` | `30` | Same window for the per-person provider session homes (`runtimes/users/*/claude-home/projects/`, `runtimes/users/*/codex-home/sessions/`). `*.jsonl` only, so a sign-in file is never pruned. `0` keeps forever. |
| `VIBERR_MAINTENANCE_INTERVAL_MS` | `21600000` (6 h) | Cadence of the periodic store-maintenance pass (`app/server/ops/maintenance.server.ts`). |
| `VIBERR_DISK_CHECK_INTERVAL_MS` | `300000` (5 min) | Cadence of the free-space check on the data root. |
| `VIBERR_DISK_LOW_FREE_MB` | `2048` | Free-space threshold below which the data root reads `low` (`app/server/ops/disk-space.server.ts`). |
| `VIBERR_DISK_CRITICAL_FREE_MB` | `512` | Threshold for `critical`. Either state marks health `degraded` and triggers an out-of-band maintenance pass at most every 30 minutes. |
| `VIBERR_GITHUB_WRITE_PROBE` | unset | `1`/`true`/`yes` opts the PAT validator into an empty-payload write probe; by default write access is proved read-only from the repo `permissions` block (`pat-validator.server.ts`). |

*(Corrected 2026-09-02, pass 32 — C01-A6: the five knobs above were raw `process.env`
reads listed in §3. They are declared in the schema and documented in `.env.example`
now; each call site still applies its own coercion and fallback and reads the live
environment, so a value can be changed without the process-lifetime `getEnv()` cache
pinning the old answer.)*

### Build identity

Baked at image-build time and read by `app/server/ops/build-info.server.ts`, which
reports them on the boot integrity line and `/resources/health` → `build`. All three
are optional and nothing is ever guessed: an unstamped build reports `null`, which is a
true statement rather than a placeholder version.

| Variable | Default | Notes |
|---|---|---|
| `VIBERR_BUILD_VERSION` | unset → `package.json` `version` | Semver of the build. |
| `VIBERR_BUILD_SHA` | unset → the checkout's `.git` (file reads only), else `null` | Full commit sha; reported shortened to 12 chars, with `revisionSource: env` when it came from here and `git` when it came from a checkout. |
| `VIBERR_BUILD_TIME` | unset → `builtAt: null` | ISO timestamp of the build. |

The `Dockerfile` declares all three as `ARG` and re-exports them as `ENV`, so a stamped
image is one build flag away:

```bash
docker compose build \
  --build-arg VIBERR_BUILD_SHA=$(git rev-parse HEAD) \
  --build-arg VIBERR_BUILD_TIME=$(date -u +%FT%TZ)
```

Left unset, the image still builds and reports `version` from `package.json` with a
`null` revision (`.git` is not copied into the image). *(Corrected 2026-09-02, pass 32 —
V11-9: `build-info.server.ts` described an image-build ARG the Dockerfile did not
declare, so `build.revision` was unconditionally `null` in the image and the deployment
doc's "redeploy the previous image" instructions were unverifiable at runtime.)*

### Controller configuration locks (ruling 108)

| Variable | Default | Notes |
|---|---|---|
| `VIBERR_UNLOCK_CONTROLLER_SKILLS` | locked | `enabled` unlocks the controller's skill grants for in-app editing. Any other value, or unset, keeps them locked, org admins included. |
| `VIBERR_UNLOCK_CONTROLLER_KB` | locked | Same, for knowledge-base grants. |
| `VIBERR_UNLOCK_CONTROLLER_MCPS` | locked | Same, for org MCP server grants. The built-in `viberr_ops` diagnostics mount is never a section and cannot be removed. |
| `VIBERR_UNLOCK_CONTROLLER_INSTRUCTIONS` | locked | Same, for the controller's doctrine file. |

Model and effort stay editable regardless. Compose passes all four through with
`disabled` as the default. Restart to apply.

**What a save does under a lock** (`resolveGrant` / `saveControllerConfig` in
`app/server/controller/controller-profile.server.ts`) — this matters to anything that
posts the form other than the panel:

| Posted for a locked section | Result |
|---|---|
| nothing, or an EMPTY list | **keep the stored value.** Blank means keep, never clear. The panel relies on this: under a lock it posts blank for the locked sections so the stored grants round-trip byte-for-byte |
| a NON-empty list that differs from what is stored | **refused**, naming the section and its unlock variable |
| a list holding the same members as the one it was SHOWN | passes — an identical round-trip is not a change. The comparison is set-based against the *displayed* list (for skills that is the stored list, or `CONTROLLER_DEFAULT_SKILLS` when the stored one is empty), and the stored list is still written back verbatim, order and duplicates included |

The same rule holds for the instructions body: blank keeps the file, a differing
non-blank body is refused. The consequence worth stating plainly is that **a scripted
caller cannot clear a locked list** — there is no posted value that empties one, because
the value that would mean "empty" means "keep". Clearing requires unlocking the section
at deploy time and restarting.
*(Added 2026-09-02, pass 32 — P07-E / C05-E: the behaviour was deliberate for blank-keeps
and undocumented for every other caller.)*

## 3. Raw `process.env` reads outside the schema

What is left here is honoured but not validated by the schema. `env.server.test.ts`
gates the rest: a raw `process.env.VIBERR_*` read that neither the schema nor
`.env.example` admits exists fails the suite. *(Corrected 2026-09-02, pass 32 — this
section used to say these were undocumented in `.env.example` too;
`VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` is documented there, and the five tuning knobs
that were here moved into the schema.)*

| Variable | Default | Where |
|---|---|---|
| `LOG_LEVEL` | `info` in production, `debug` otherwise | `app/server/logging/logger.server.ts`. Values `debug \| info \| warn \| error`. |
| `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` | unset | Comma-separated retired keys, newest first, for a rotation window (`app/server/secrets/secret-box.server.ts`). Reads only; a malformed entry is skipped silently so a key list never reaches an error message. |
| `VIBERR_E2E_KEEP` | unset | `1` keeps the e2e compose stack up after `npm run e2e` (`scripts/e2e.ts`). |
| `VIBERR_E2E_BASE_URL` | set by `scripts/e2e.ts` | The Playwright base URL; `playwright.config.ts` refuses to run without it. |

The runtime also **sets** environment for the processes it spawns and never inherits
its own configuration into them (ruling 142). Agent runs, spawned stdio MCP servers, the
hosted sign-in driver and the vendor sign-out all start from `filteredSpawnEnv`
(`app/server/runtimes/runtime-registry.server.ts`), which drops **every name the env
schema declares** (`ENV_KEYS`: everything in §1 and §2, so `NODE_ENV`, `PORT`,
`VIBERR_DATA_ROOT`, `BETTER_AUTH_URL`, the OAuth client ids, `VIBERR_TRUST_PROXY`, the
unlock flags and every tuning knob), every credential-shaped name (`CREDENTIAL_ENV_RE`),
`DATABASE_URL`, `REDIS_URL`, `SSH_AUTH_SOCK`, `GPG_AGENT_INFO`, and both vendor homes
(ruling 127). The rule is keyed on the schema, so a knob declared tomorrow is stripped
tomorrow. **A name the schema does not declare passes through**: `PATH`, `HOME`, locale,
proxy settings and the image's `UV_CACHE_DIR` / `UV_PYTHON_INSTALL_DIR` (§5) reach the
child, which is what keeps `npx` MCP servers, `uvx` and the vendor CLIs working. That is
safe because the gate above keeps the schema complete: the undeclared names in this
section's table are either credential-shaped and stripped by the regex
(`VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS`) or harmless in a child (`LOG_LEVEL`,
`VIBERR_E2E_*`). Nothing a child needs comes from a declared name:
`VIBERR_BROWSER_EXECUTABLE` is read by the server and handed to the browser MCP as
`--executable-path`. Git is invoked with `GIT_ASKPASS` carrying the PAT,
`GIT_CONFIG_SYSTEM`/`GIT_CONFIG_GLOBAL` pointed away from the host config,
`GIT_ALLOW_PROTOCOL` restricted, and `GIT_CEILING_DIRECTORIES` set to the task directory.
*(Corrected 2026-09-04, pass 34 — U34-7 / ruling 142: this paragraph used to say the
runtime "never inherits its own environment" while only the credential-shaped and
private-runtime names were stripped; the container's `NODE_ENV=production` and `PORT`
rode into every agent shell and stdio MCP child, and broke a project's own `vitest` and
`next start` inside a run until the agent unset them by hand.)*

## 4. Configuration that is not an environment variable

| Setting | Where it lives | Who edits it |
|---|---|---|
| Run concurrency cap (`maxConcurrentRuns`, `0` = unlimited, ceiling 64; a positive cap carries a coordination lane of `max(1, ceil(cap / 4))` extra slots for operator and controller turns, ruling 152(b)) | `instance_settings` table | Org admin, Org settings, the run-concurrency control below the tabs (`set-concurrency` intent) |
| Backend quota observations (`backendRateLimit.<backend>`, `backendQuotaExhausted.<backend>`, `backendCredentialRefused.<backend>`) | `instance_settings` | Written by the run sink from Claude `rate_limit_event` envelopes and from classified refusals (ruling 130(d): each names the account the run billed); read by `/insights`, `instance_health`, the person's Profile card and the dispatch hold (`backendDispatchHold`, ruling 152(c)); the unauthenticated health body strips the person |
| OAuth sign-in providers | `oauth_providers` table (sealed client secret) | Org admin, Sign-in & SSO tab; overrides the env pair per provider |
| S3 audit export target | `s3_audit_config` table (sealed secret key) | Org admin, Audit panel |
| Controller model, effort, grants, instructions | `agents/profiles/controller.md` + `agents/definitions/controller.md` in the data root | Org admin, Controller tab; grant sections and instructions locked unless unlocked by env (§2) |
| Per-project workflow, members, agent deployments, guardrails, credential policy | `projects/<slug>/project.md` | Project admins through Policy / Settings / Agents |
| Per-user theme, notification routing, timeline default, pins | `users.theme` + cookie `viberr_theme`; `user_prefs` table | The user, Profile overlay |
| Personal backend credentials (ruling 127) | `user_backend_credentials` (sealed `secret_box` for a pasted key or token; a `login` row holds no secret) + the vendor's own file in `runtimes/users/<id>/{claude-home,codex-home}` | The person, Profile → Agent accounts |
| Which account a run bills (the credential principal) | derived per run and persisted as `agent_runs.credential_user_id` | Nobody sets it: task runs take the task owner, controller turns the asker (`run-principal.server.ts`) |

## 5. What the container image bakes in

From the `Dockerfile` runtime stage: `NODE_ENV=production`, `VIBERR_DATA_ROOT=/data`,
`UV_CACHE_DIR=/data/runtimes/uv-cache`, `UV_PYTHON_INSTALL_DIR=/data/runtimes/uv-python`,
`PORT=3000`, `VIBERR_BROWSER_EXECUTABLE=/usr/bin/chromium`. Everything else comes from
`.env` via compose `env_file`. Compose additionally forces `NODE_ENV=production` and
`VIBERR_DATA_ROOT=/data` even when `.env` carries the dev values, pins `hostname: viberr`
(so a recreated container can reclaim its own writer lock) and runs with `init: true`.

The image bakes **no** backend credential and **no** runtime home, and it declares no
`ENTRYPOINT`: the CMD is pid 1 and compose's `init: true` reaps orphans. Each person's
home is created on demand at `/data/runtimes/users/<userId>/{claude-home,codex-home}`,
mode 0700, by `ensureUserBackendHome`. *(Corrected 2026-09-02, ruling 127 — the image
used to bake `CLAUDE_CONFIG_DIR=/data/runtimes/claude-home` and
`CODEX_HOME=/data/runtimes/codex-home` and to run `scripts/docker-entrypoint.sh`, which
seeded `auth.json` from a read-only `/host-codex` mount. The variables, the script, the
mount and the `CODEX_CLI_HOME` compose knob that pointed at it are all deleted.)*

## 6. Local development

`.claude/launch.json` defines two launchers: `viberr-dev` exports
`VIBERR_DATA_ROOT=<repo>/docker-data` on port 5173 and **refuses to start while the
`viberr-app-1` container is running** (two writers on one data root corrupt the
SQLite WAL); `viberr-dev-hermetic` uses `<repo>/data` on port 5174. `vite.config.ts`
loads `.env` itself and excludes the data root from the dev watcher, because task
workspaces under it are full nested clones of the target repository.
