# Deployment — single-node Docker

Viberr is a single-node, self-hosted monolith: one Node process serving the SSR app,
SSE live updates, and an embedded SQLite projection database, with all authoritative
state on the local filesystem. There is no external database, cache, or queue to run.

*Updated 2026-09-02 for ruling 127 (branch `claude/per-user-codex-auth-difdnn`): agent
backends are connected per person in the app, not configured in the deployment
environment. "Agent backends in the container" below was rewritten; the persistence tree,
the backup notes and the health example follow it.*

## What runs

- One container (see [`Dockerfile`](../../Dockerfile) + [`compose.yml`](../../compose.yml)).
- `react-router-serve` on `$PORT` (default `3000` in the image).
- SQLite projections + app data at `$VIBERR_DATA_ROOT` (default `/data` in the image),
  which **must** be a persistent volume.

## Secrets & configuration

All configuration comes from environment variables, validated at startup
([`app/server/config/env.server.ts`](../../app/server/config/env.server.ts)) — the
process refuses to boot and prints every missing/invalid variable if configuration is
incomplete. Two secrets are required; everything else is optional (see
[`.env.example`](../../.env.example)).

```bash
VIBERR_SESSION_SECRET=$(openssl rand -base64 48)        # ≥ 32 chars
VIBERR_SECRET_ENCRYPTION_KEY=$(openssl rand -base64 32)  # decodes to exactly 32 bytes (AES-256-GCM for PATs)
```

Inject them at runtime — do not bake them into the image. With Compose they come from
`.env` via `env_file`; on a container platform, set them as runtime secrets/env vars.
`VIBERR_SECRET_ENCRYPTION_KEY` encrypts stored GitHub PATs and MCP credentials;
**losing it makes existing encrypted tokens undecryptable** (users must re-add PATs).
Rotating is supported and finishable: set `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` to
the old key, run `npm run keys -- status` (read-only, works on a live instance) to see
how many secrets still open only under it, `npm run keys -- reseal` to move them, and
drop the previous key once status reports none. Without that count there is no moment
at which removing the old key is known to be safe.

Optional integrations, enabled only when their vars are present:
`GITHUB_OAUTH_*` / `GOOGLE_OAUTH_*` (OAuth sign-in) and `VIBERR_SEED_ADMIN_*` (bootstrap
admin on first boot of an empty DB). Agent backends are **not** among them: since ruling
127 they carry no environment variables at all, and are connected per person in the app
(below). `VIBERR_SECRET_ENCRYPTION_KEY` also seals the personal backend API keys people
paste, so losing it costs those too.

## TLS and the reverse proxy

**Viberr must be deployed behind a TLS-terminating reverse proxy.** The container speaks
plain HTTP — `react-router-serve` on `$PORT`, `EXPOSE 3000`, no certificate handling and
no proxy in the image or in `compose.yml`. Encryption in transit is the deployment's
responsibility, not the Node process's. Do not attempt to terminate TLS inside the app.

Put nginx, Caddy, Traefik, or your platform's ingress in front, terminate HTTPS there,
and forward to the container port. Then set one variable:

```bash
BETTER_AUTH_URL=https://viberr.example.com   # the PUBLIC https origin, no trailing path
```

That variable is what makes the proxied topology work. better-auth builds OAuth callback
URLs and cookie attributes from it; unset behind a proxy, `trustedOrigins` collapses to
`[]` and the OAuth flow breaks. The boot log warns when OAuth is configured and
`BETTER_AUTH_URL` is not.

**The failure mode if you skip the proxy.** The image sets `NODE_ENV=production`, and with
no explicit origin better-auth falls through to its production defaults: it issues
`__Secure-`-prefixed session cookies with `secure: true`. A browser will not store those
over plain http. The user submits correct credentials, gets a 200, and lands back on the
login page — a silent login loop with nothing in the app logs to explain it. This is
better-auth failing closed, which is the correct behaviour; the fix is to front the app
with TLS, not to weaken the cookie.

Two proxy details worth getting right:

- Forward `X-Forwarded-For` **and set `VIBERR_TRUST_PROXY=1`** (the number of proxy hops
  to trust). The header is ignored unless that variable is set, so forwarding it alone
  changes nothing. It is the container's only view of the client IP: the sign-in throttle
  keys on `email|ip` and falls back to a literal `local` without it, so the limiter still
  works per account but stops distinguishing attackers from the legitimate owner of that
  account. *(Corrected 2026-09-01 — `app/server/auth/rate-limit.server.ts`.)*
- Forward `Accept` and `Cache-Control` untouched and disable response buffering on
  `/resources/events`. That is the SSE stream; a buffering proxy stalls live updates.

HSTS, certificate renewal and redirect-to-https all belong to the proxy layer.

## Agent accounts are per person (ruling 127)

The image ships everything needed to run real agents: the Claude/Codex SDKs' native
linux binaries (installed by `npm ci` in the linux build stage) plus, in the runtime
stage, `git` and a CA bundle (a real run clones the task's repo and the coding agent
shells out to git), Debian `chromium` with `fonts-liberation` for the governed browser
(`VIBERR_BROWSER_EXECUTABLE=/usr/bin/chromium`), and `uv`/`uvx` for Python stdio MCP
servers (their caches live under `runtimes/uv-cache` and `runtimes/uv-python` on the
volume). *(Inventory corrected 2026-09-01.)*

What it does **not** ship is a credential. There is no deployment-wide key, no shared
runtime home, no `/host-codex` mount and no entrypoint that seeds one. **Every person
connects Claude and Codex for themselves, in the app, on Profile → Agent accounts**, and
every run bills exactly one person: the **task owner** for a run on a task (operator,
specialist, resume, scheduled, boot recovery, retry) and the **asker** for a controller
turn. That principal is persisted on the run row as `agent_runs.credential_user_id`.

Two ways to connect, per backend:

- **Hosted sign-in through the unmodified vendor binary.** Claude: `claude auth login`
  with `--claudeai` (a Pro/Max subscription) or `--console`. Codex: `codex login
  --device-auth`, the device-code flow OpenAI ships for headless machines. Viberr drives
  the binary, shows the URL (and, for Codex, the one-time code to type), and never sees
  the token: the binary writes its own credential file into that person's runtime home,
  `<dataRoot>/runtimes/users/<userId>/claude-home/.credentials.json` or
  `.../codex-home/auth.json` (Viberr creates the directory mode `0700` and nothing else
  about that file). This is what Anthropic's
  [Claude Code legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance)
  requires of a platform that hosts Claude Code: each end user authenticates with their
  own credentials, billed to them, through the vendor's own flow, and the app may not
  collect or store a Claude.ai session token. There is deliberately no "paste your
  setup-token" field.
- **A pasted key or token.** Claude: a Console API key (`sk-ant-…`), verified against a
  free `GET https://api.anthropic.com/v1/models` before it is stored. Codex: an OpenAI
  Platform API key (verified against `GET https://api.openai.com/v1/models`) or a ChatGPT
  **workspace access token**, which is stored *unverified* because there is no free probe
  for one. Pasted values are sealed with `VIBERR_SECRET_ENCRYPTION_KEY` in
  `user_backend_credentials`, displayed only as their last 4 characters, and handed to a
  child process only for a run that person's account is paying for. The run sink redacts
  them from every persisted log line.

A ChatGPT workspace can have device-code authorization switched off; the sign-in card
then reports the vendor's own refusal and points at the workspace admin, or at a pasted
key. Treat a pasted token as a secret, prefer a finite expiration, and rotate it.

**First run, as the first admin.** After `docker compose up -d`, sign in as the bootstrap
admin, open **Profile → Agent accounts**, and connect at least one backend for yourself.
Until somebody does, the instance runs no agents: an agent started on a task whose owner
has nothing connected is refused before any process starts, with an honest
`run·unavailable` error run and a blocked recovery packet naming the owner and the
backend. Because task creation now seats the creator as owner, the person who creates
work is the person whose accounts pay for it, unless ownership is reassigned.

**What a wiped volume loses.** The hosted sign-in files live only under
`runtimes/users/<userId>/` on the `/data` volume. Deleting or recreating that volume
signs everyone out of the vendors: their cards flip to "sign-in file missing (the runtime
volume was wiped)" and each person signs in again. Sealed API keys survive a volume wipe
only if the database did, and are readable only with the same
`VIBERR_SECRET_ENCRYPTION_KEY`. Nothing else is lost: the credential rows, the runs and
the transcripts are unaffected by a re-signin, and no run is retried automatically.

**Backups include the homes only on request.** `npm run backup` excludes `runtimes/` by
default precisely because it now holds every person's live sign-in; `--include-runtimes`
carries `runtimes/users/` (and the raw transcripts) and turns the artefact into a secret.
The sealed keys ride in `projection.sqlite`, which the default backup does take, and are
unreadable without the encryption key backed up separately.

**Security boundary.** A per-person runtime home keeps one person's vendor sign-in out of
another person's runs, and `filteredSpawnEnv()` strips every credential-shaped variable
from the base env both adapters spawn on, so a child sees only its own principal's
credential. It does **not** isolate those homes, or the application data, from an
autonomous coding process running as the same container user: a run can read the
filesystem it executes on. Treat the single-container setup as trusted-task mode.
Untrusted tasks need a separate worker user/container with only the task workspace
mounted, plus server-owned Git push/PR delivery so repository credentials never enter the
agent's environment.

Confirm what's connected:

```bash
curl -s localhost:${PORT:-3000}/resources/health | jq .backends
# {"claude":{"connectedUsers":3},"codex":{"connectedUsers":1}}
```

That is a count of PEOPLE, not a verdict on this server. Zero is a normal reading, never
degraded: it means nobody has connected that backend yet. It is not a validity check
either, and it cannot answer "can this task run", which is a fact about the task's owner
and is shown on the task page, in the packet and on the Agents page.

*(Rewritten 2026-09-02 for ruling 127. This section used to be titled "Agent backends in
the container" and told an operator to run `claude setup-token`, paste
`CLAUDE_CODE_OAUTH_TOKEN` / `CODEX_ACCESS_TOKEN` into `.env`, or copy `~/.codex/auth.json`
into a shared `runtimes/codex-home` and set `VIBERR_CODEX_USE_CLI_AUTH=1`. All nine
variables, the shared homes, the `/host-codex` mount and the entrypoint that seeded it are
deleted; the health example returned `{"claude":"real","codex":"unavailable"}`.)*

## Codex runs are not OS-confined (ruling 185)

Viberr starts **every** Codex run `danger-full-access`, and the container keeps Docker's
own seccomp profile — `compose.yml` carries no `security_opt`. Do not add one back without
a ruling.

The Codex CLI *can* confine a run (bubblewrap on Linux, seatbelt on macOS), and Viberr used
to ask it to for every run below full access. Two upstream properties made that cost more
than it bought, and pass 36 measured both:

- **bubblewrap needs an unprivileged user namespace** (`unshare(CLONE_NEWUSER)`), which
  Docker's builtin seccomp profile refuses to a non-root process — and the app runs as the
  non-root `node` user. Every confined run therefore died at its first shell command with
  `bwrap: No permissions to create a new namespace`, and the models reported the
  environment as a verdict on correct work (F36-1). The remedy was to run the whole
  container `seccomp=unconfined`, which is a bigger hole than the sandbox was a wall.
- **with the network off the CLI installs a seccomp filter that refuses every socket
  syscall, `AF_UNIX` included.** libuv's *synchronous* spawn needs a socketpair, so inside
  such a sandbox `spawnSync` reports `EPERM` *after the child has already run*,
  `execSync`/`execFileSync` throw it, `net` fails on both `AF_UNIX` and `AF_INET`, and only
  async `spawn` is unaffected. `npm ci` dies on esbuild's postinstall, so no
  `npm`/`npx`/`pnpm`/`yarn` gate can run at all (F36-11). Live, that deadlocked the review
  gate: the reviewer called it "an environment evidence blocker, not a code finding" and
  still requested changes, and the operator sent the deliverer back around.

**What confines an agent now** is Viberr, not the OS: the run's contract omits every step
it may not take, each supporting engagement works in its own isolated checkout, agents hold
no credential, delivery is server-owned, and verdicts bind to a revision. The honest cost
is that on Codex a withheld `execute-code-or-write-repo` is **advisory** — the agent editor,
the capability matrix and the agent card all say so on the row. Web search still binds on
both backends (it is the CLI's own tool, not the sandbox), and so do the MCP write-tool
denials.

The host toolchain is still reported — versions only:

```bash
curl -s localhost:${PORT:-3000}/resources/health | jq .toolchain
# {"node":"26.8.2","npm":"11.19.1","git":"2.47.3","python3":null,"go":null,
#  "make":"4.4.1","docker":null,"pnpm":"12.4.1","yarn":null,"curl":"8.14.1",
#  "codexCli":"0.153.4","claudeAgentSdk":"0.3.261"}
```

`make`, `curl` and a pinned `pnpm` ship in the image (ruling 196); `docker` is `null`
deliberately and is not coming — an agent holding the daemon socket controls every
container on the host. The same reading is injected into every specialist, operator and
controller prompt (ruling 191), so an agent plans around what is present instead of
discovering each absence as an exit-127.

## First run

```bash
cp .env.example .env        # fill in the two required secrets
mkdir -p docker-data && sudo chown 1000:1000 docker-data   # Linux, rootful daemon — see below
docker compose up -d --build
docker compose logs -f app  # boot integrity log: dirs, migrations, counts, users, build, disk
```

*(Added 2026-09-05.)* **Create `docker-data/` yourself, owned by uid 1000.** The image does
`chown node:node /data`, but compose bind-mounts `./docker-data` over that path and a bind
mount shadows the image's directory entirely — the HOST directory's ownership is what the
container sees. On Linux with a rootful daemon, a missing bind-mount source is created by
the daemon as **root**, so the container's `node` user (uid 1000) cannot write it, and the
app crash-loops at boot with `EACCES` before it can create `state/` or take the writer
lock. `sudo chown 1000:1000 docker-data` fixes it; the image's own `chown` only ever
applies when `/data` is NOT bind-mounted (a named volume, say). Rootless Docker and Docker
Desktop on macOS/Windows map ownership for you and need none of this.

- Migrations apply automatically at boot; no manual migrate step is needed.
- On an **empty** users table the bootstrap admin is created from `VIBERR_SEED_ADMIN_EMAIL`
  / `VIBERR_SEED_ADMIN_PASSWORD` (or a random password logged once).
- Connect an agent backend for yourself on **Profile → Agent accounts** before expecting
  any agent to run (ruling 127). Nothing in `.env` does it, and an instance with nobody
  connected refuses every agent run honestly rather than starting one. See
  [Agent accounts are per person](#agent-accounts-are-per-person-ruling-127).
- Seed BEFORE the app starts (or stop it first) — `npm run seed` takes the
  single-writer lock and refuses against a running container.
  `npm run seed` seeds the product baseline — the built-in agent
  catalog, knowledge bases, skills — and nothing else: no demo/mock board data. The board
  always starts as a clean sheet.
- Health: `GET /resources/health` → `{ ok, status, degraded[], projections: { projects,
  tasks }, watcher, kbWatcher, lock, backends, browser, disk, maintenance, build }` (key
  order is part of the contract; `backends` is `{ claude: { connectedUsers }, codex: {
  connectedUsers } }` since ruling 127). The bare URL is a **liveness** probe: `200` even when
  `status: "degraded"`. For a **readiness** probe call `?probe=readiness`: it returns
  `503` with the same body while anything is degraded (a dead watcher, no lock, low disk).
  `503 { ok: false, status: "down" }` means SQLite is unreachable. Compose's own
  healthcheck is the liveness form. *(Corrected 2026-09-01 — the body grew `status`,
  `degraded`, `browser`, `disk`, `maintenance` and `build`, and the readiness form was
  undocumented; earlier correction 2026-08-06, pass 19.)* Field reference:
  [`runbook.md`](runbook.md#health--liveness).

## Persistence, backup & restore

Everything stateful lives under `./docker-data` in the Compose setup, mounted
at `/data`. Both SDKs keep their resumable state under `runtimes/`:

```
projects/       canonical project.md, task.md, goals/*.md (the source of truth — editable);
                per task: workspace/ (git clones, a cache) and attachments/ (evidence files);
                per project: .repo-mirror/ (bare mirror, a cache)
agents/         agents/profiles/*.md templates + agents/definitions/ doctrine files
kb/ skills/     knowledge-base and skill files
runtimes/       raw NDJSON run logs per backend; users/<userId>/{claude-home,codex-home}/,
                one person's vendor sign-in file plus their provider sessions (ruling 127);
                uv-cache/ and uv-python/ in the container
audit-exports/  audit-events-<date>.jsonl written before each 90-day purge
state/          projection.sqlite (users, sessions, projections, audit, PATs, notifications,
                sealed personal backend keys), writer.lock, shipped-assets.json;
                tmp/reader-<pid>/ only while a read-only CLI holds its copy (ruling 158)
```

Boot creates the nine `DATA_ROOT_SUBDIRS` (`projects`, `agents`, `agents/profiles`,
`runtimes`, `runtimes/users`, `kb`, `skills`, `audit-exports`, `state`); the rest
appear when first written, including each person's own
`runtimes/users/<userId>/{claude-home,codex-home}` (mode 0700, created by
`ensureUserBackendHome` the first time they connect). *(Corrected 2026-09-02, ruling 127 —
the list used to hold the shared `runtimes/claude-home` and `runtimes/codex-home`, which
no longer exist.)* *(Corrected 2026-09-02, pass 32 — A00-6: `audit-exports/`
joined the list, so the folder the runbook, the backup and `file-formats.md` all name
exists on every root instead of only on one that has already purged.)* There is no `auth/`, `cache/` or `logs/` directory; application
logs are structured JSON on stdout. Full layout with retention:
[`../architecture/data-model.md`](../architecture/data-model.md#2-data-root-layout).
*(Corrected 2026-09-01.)*

- **Backup** = `npm run backup` (add `--out <dir>`). It writes a timestamped artefact
  containing a genuine point-in-time `projection.sqlite` — taken with `VACUUM INTO`, so it
  folds in WAL content and lands as ONE file with no sidecars —
  plus the canonical markdown tree — `projects/`, `agents/`, `kb/`, `skills/` and
  `audit-exports/` (`BACKED_UP_STORE_DIRS`; a directory that does not exist yet is
  skipped) — and a `MANIFEST.json` recording byte size, sha256 and the row counts read
  back out of the artefact. `audit-exports/` is in that list because ruling 102 makes it
  the durable record that outlives the 90-day `audit_events` window: a backup without it
  would drop exactly the history the purge was designed to preserve. *(Corrected
  2026-09-02, pass 32 — C01-A3.)* It does **not** take the writer lock: a
  backup that refused to run on a live instance would be no backup at all.

  **How it reads a live root.** Never through a second connection: whenever
  `state/writer.lock` is there at all the CLI copies `projection.sqlite` and its
  `-wal` to `state/tmp/reader-<pid>/`, runs the `VACUUM INTO` on the copy and removes it
  (ruling 158; the manifest's first `contains` line then says "read from a copy of the
  file and its WAL taken while state/writer.lock named a holder"). Only a root with no
  lock file is just files it opens in place, read-only: a reader cannot tell a dead
  holder from a live one in another pid namespace, and a copy it did not need costs
  nothing but disk. That is the rule for
  every reader, on either side of the container boundary: copy first, never a second
  connection to a live database, because the second mapping of the WAL index is what
  produced the SIGBUS in pass 34 (a host-side reader over the bind mount) and again in
  pass 35 (an in-container `readOnly: true` reader); the runbook's
  [Readers, and where they must run](./runbook.md#readers-and-where-they-must-run) has
  both. **Where it runs.** Inside the container is still the worked form, because the
  backup needs an explicit `--out`: the default `./backups` is `/app/backups` inside the
  container and is lost with it, and `createBackup` refuses a destination under the data
  root it is backing up, so the artefact goes to a container-local directory and is
  copied out at once:

  ```bash
  docker compose exec -T app npm run backup -- --out /tmp/viberr-backups
  docker compose cp app:/tmp/viberr-backups/. ./backups/
  ```

  With the container down the root is plain files, and `npm run backup -- --out ./backups`
  from the repo root is fine (`.env`'s `VIBERR_DATA_ROOT` must name the mounted directory,
  `./docker-data` as in `.env.example`). *(Corrected 2026-09-04, pass 34 — D34-1;
  corrected again 2026-09-06, pass 35 — F35-9, ruling 158: this said the in-container
  read-only form was the safe one, and it died the same way the host-side one had.)*

  Read the artefact's own README for what it excludes. Three exclusions matter most:
  `runtimes/` (live agent logins, now one set per person under `runtimes/users/` — opt in
  with `--include-runtimes`, and then treat the artefact as a secret),
  **`VIBERR_SECRET_ENCRYPTION_KEY` itself**, which lives in the
  environment, and the git trees under `projects/` — each task's
  `tasks/<KEY>/workspace/` checkout and each project's `.repo-mirror/` bare mirror.
  *(Added 2026-09-05: those two were being copied. They are re-derivable from the remote,
  a live run can be mid-write so the copy would be torn, and they dwarf what is actually
  truth — on the tree this was found on, 17M of git against 168K of project and task
  markdown. Restoring a stale checkout over a fresh one was never wanted; the next run
  re-clones and re-fetches.)* Without that key every sealed PAT, MCP credential and personal backend API
  key in the backed-up database is unreadable, so back the key up separately.

  The older advice — copy `./docker-data` wholesale, being careful to include the
  `-wal`/`-shm` sidecars — still works, but it is exactly the trap `VACUUM INTO` removes:
  a hot copy of `projection.sqlite` alone silently loses every committed row still living
  in the WAL.

- **Restore** = `npm run restore -- --from <artefact>`. Whole-root restore takes the writer
  lock, requires `--force` if the root is occupied, and *moves* displaced data aside rather
  than deleting it. To recover a single hand-broken canonical file without touching the
  database: `npm run restore -- --from <artefact> --file projects/<slug>/tasks/<KEY>/task.md`
  — the broken bytes are kept beside it as `task.md.broken-<ts>`.

**`state/projection.sqlite` is primary storage, not a cache — back it up.** The
projection tables inside it are derived and rebuild from `projects/`, but the same file is
the *only* home of every user row and better-auth credential, every session, every
AES-sealed GitHub PAT, the whole audit trail, and all notifications. None of that exists
in the canonical Markdown, so none of it is rebuildable.

Restoring `projects/` without the database does not degrade gracefully. On the next boot
the users table is empty, so the bootstrap admin is minted with a **fresh** user id, while
the surviving task and project files still carry the old ids in `members[].userId` and
`ownerUserId`. Those ids now resolve to nobody: every membership and task owner becomes a
ghost. Rebuilding projections cannot fix it — the ids in the files are the problem, and
there is no re-mapping tool. Treat a `projects/`-only restore as a new instance whose
memberships and owners must be re-established by hand.

## Re-baselining the projection database

Boot's integrity line is followed by a `projection schema drift` **WARN** when this
database's `task_projections` CHECK constraints no longer admit every value the running
build produces (F21-1). It names what the CHECK `refuses`. Migrations are squashed into
`0001_baseline.sql` and forward-only, so widening a CHECK changes what a **fresh**
`projection.sqlite` gets and nothing else — a root opened by an older build keeps the
constraint it was created with, and every task whose derived value lands on a refused
member stops projecting behind a generic `projection rebuild failed`.

**First, check whether you need a remedy at all.** The WARN covers two shapes, and one
of them repairs itself: a baseline COLUMN added after this root was created is applied
at open by `ensureBaselineColumns` (`app/server/db/sqlite.server.ts`), which `ALTER
TABLE … ADD COLUMN`s each missing entry of `BASELINE_COLUMNS` — on `agent_runs`
`dispatched_by_name`, `dispatched_by_user_id`, `credential_user_id`,
`interrupted_reason` and `usage_final`, plus the ruling-121 controller columns — and
logs `added a baseline column this data root predated`. A column whose DEFAULT would be
WRONG for the rows that predate it carries a one-time backfill run in the same step
(`usage_final = 1` on the `finished` runs, whose token columns held the provider's own
figures before the estimate existed); it is logged as a warn when it cannot run.
Additive drift on those columns needs nothing below. What follows is for the
shape no ALTER can fix: a CHECK constraint that refuses a value the running build now
produces. *(Added 2026-09-02, pass 32.)*

Two remedies, and the lossy one is not the only one:

**Preferred — preserve-copy.** Recreate the schema and carry the non-rebuildable rows
across, which is exactly the shape `selfHealProjectionDbIfCorrupt`
(`app/server/db/self-heal.server.ts`) already performs on a corruption verdict: open a
FRESH file, run the migrations into it, then with `PRAGMA foreign_keys = OFF` copy every
table across on the intersection of the columns both sides have, skipping the ones the
rescan rebuilds from files (`provenance`, `schema_migrations`, `projects`,
`project_members`, `task_projections`, `task_events`, `diagnostics` — leaving those
EMPTY is what makes the boot rescan re-project every file rather than trust a stale
content hash). Move the old file aside rather than deleting it, then start the app: the
rescan refills the projection tables from `projects/`. Users, sessions, sealed PATs,
audit, notifications, org resources and run history survive. There is no CLI for this
today — the self-heal path runs it only for a corrupt file — so it is a scripted
one-off; write it against that module's table list rather than inventing one, and take
a backup first either way (the in-container form under *Persistence, backup & restore*,
or from the host once the container is down).

**Lossy — delete and rebuild.** Simpler, and acceptable on a throwaway or freshly seeded
root:

```bash
docker compose down                  # one writer per root; never delete state while it runs
npm run backup -- --out ./backups    # only now, with nothing writing the root; see the cost below
rm ./docker-data/state/projection.sqlite*   # -wal and -shm too
docker compose up -d                 # migrations re-apply, projections rebuild from projects/
```

The backup sits below the `down` on purpose: with nothing writing the root the CLI reads
the file itself, and the artefact is the database exactly as it will be restored. Taken
while the container ran it would read a copy of a root still changing under it (ruling
158; before pass 35 it opened the live database across the bind mount, `.env.example`
pointing `VIBERR_DATA_ROOT` at `./docker-data`, the very directory compose mounts, which
is the reader-side hazard under the runbook's
[Readers, and where they must run](./runbook.md#readers-and-where-they-must-run)). To take
one without stopping first, use the in-container form under *Persistence, backup &
restore*. *(Corrected 2026-09-04, pass 34 — D34-1; 2026-09-06, pass 35 — ruling 158.)*

**Name the cost before you run it.** The projection *tables* are derived and rebuild from
`projects/` at boot — but they share the file with rows that exist nowhere else: users and
better-auth credentials, sessions, AES-sealed PATs and MCP credentials, the audit trail,
notifications, org resources and run history. Deleting the file deletes those too. Expect
to sign in again as a freshly minted bootstrap admin, and read the ghost-membership warning
under *Persistence, backup & restore* first: the surviving task and project files still
carry the OLD user ids. Restoring the backup afterwards puts the drifted schema back, so it
is a safety net for the data, not a way to undo the re-baseline.

## Upgrades

New app version → rebuild the image and `docker compose up -d`. Migrations apply at boot;
the data-root volume carries state across deploys. Roll back by redeploying the previous
image against the same volume (migrations are additive and forward-only — take a data-root
backup before a major upgrade). Verify what is running from `/resources/health` → `build`:
`version` comes from `VIBERR_BUILD_VERSION` or `package.json`; `revision` from
`VIBERR_BUILD_SHA`, or from the checkout's `.git` when there is one (there is not, in
the image). Stamp the build so every deploy is identifiable from the probe:

```bash
docker compose build \
  --build-arg VIBERR_BUILD_SHA=$(git rev-parse HEAD) \
  --build-arg VIBERR_BUILD_TIME=$(date -u +%FT%TZ)
docker compose up -d
```

The `Dockerfile` declares `VIBERR_BUILD_VERSION`, `VIBERR_BUILD_SHA` and
`VIBERR_BUILD_TIME` as `ARG` and re-exports each as `ENV`; setting them in the container
environment works too. Left unstamped the image reports a `null` revision, which the
probe says plainly rather than guessing. *(Noted 2026-09-01; corrected 2026-09-02, pass
32 — V11-9: the Dockerfile declared no ARG at all, so `revision` could not be anything
but `null` in the image.)*

## Scaling note

Single-node by design (SQLite + local file authority + in-process SSE bus). There is no
horizontal-scale story in V1; run one instance per data root. Vertical sizing is governed
by projection query volume and concurrent agent runs, both modest for small teams.

## Single-writer safety (B-FD1 / F18-5)

**One app process per data root, EVER.** Two processes pointed at one root corrupts the
SQLite WAL and silently loses transactions — `PRAGMA integrity_check` does NOT detect the
loss. Boot takes an exclusive `state/writer.lock`; a second process refuses to boot naming
the holder. As of F18-5 the holder also re-verifies ownership on a 20 s timer and **fails
closed** (one synchronous stderr `FATAL` line via `writeFatalSync`, then `process.exit(1)`
— the async logger line was the thing that got truncated) the moment its lock file is deleted or
replaced out from under it — because the fd stays valid on the now-unlinked inode while a
second boot can acquire the freed path. `/resources/health` reports the current holder
(`lock: { pid, hostname, startedAt }`) so you can confirm exactly one writer.

Two ways this bites in practice, both to avoid:

- **Do NOT wipe `<dataRoot>/state` while a Viberr process is running.** Deleting the lock
  file lets a second process acquire the root; the first now writes lock-less until the
  guard notices and exits. Stop the app first, then reset the store.
- **Beware the same-port `::1` vs IPv4 split.** A host dev server on `[::1]:5173` and a
  compose container's docker-proxy on `*:5173` both answer `localhost:5173` (macOS resolves
  `localhost` → `::1` first). Two live servers can look like one app while writing the same
  bind-mounted `docker-data`. Run exactly one; the writer lock + health holder make it
  visible which.

How the lock is judged: same host and a dead pid → stale, reclaimed automatically with a
WARN; same host and a live pid → refused; a **different hostname is never probed** and is
always refused (which is why `compose.yml` pins `hostname: viberr`, so a recreated container
matches its predecessor). If the holder really is dead and the lock was not reclaimed, boot
once with `VIBERR_FORCE_DATA_ROOT_LOCK=1`. The writing CLIs (`seed`, `seed:demo`, `rescan`,
`restore`, `keys -- reseal`) take the same lock and refuse against a running app;
`backup`, `store:check` and `keys -- status` are readers and need none; the two that read
the database copy it first rather than open it whenever that lock file exists at all
(they judge its PRESENCE, never its holder's liveness, which cannot be probed from
another pid namespace), since a second connection to a live root is a hazard of its own
(ruling 158). *(Added 2026-09-01; see
[`runbook.md`](runbook.md#the-single-writer-lock-and-cli-refusals).)*
