# Deployment — single-node Docker

> How to build, run, back up, upgrade and restore the shipped container, and what it
> expects from the host and the proxy in front of it. Source of truth: `Dockerfile`,
> `.dockerignore`, `compose.yml`, `compose.e2e.yml`, `scripts/deploy.ts`,
> `app/server/config/env.server.ts`, `app/server/db/backup.server.ts`,
> `app/server/db/data-root-lock.server.ts`, `app/server/db/sqlite.server.ts`,
> `app/server/boot.server.ts`, `app/routes/resources.health.ts`.
> Verified against `main` @ `7d9fbf72` (2026-09-23).

Viberr is a single-node, self-hosted monolith: one Node process serving the SSR app,
SSE live updates, and an embedded SQLite projection database, with all authoritative
state on the local filesystem. There is no external database, cache, or queue to run.

## What runs

- One container (see [`Dockerfile`](../../Dockerfile) + [`compose.yml`](../../compose.yml)),
  built from `node:26-slim` in four stages: `prod-deps` (`npm ci --omit=dev`, keyed on
  the lockfile only, so a source edit never reinstalls it), `build` (`npm ci` +
  `npm run build`), `launcher` (gcc compiles `tools/viberr-launch/viberr-launch.c`, keyed
  on that one file; ruling 460) and the runtime stage.
- `react-router-serve` on `$PORT` (`3000` in the image), started as
  `node /app/node_modules/@react-router/serve/bin.cjs ./build/server/index.js`, not
  `npm run start`: with node as pid 1 a `docker compose stop` SIGTERM reaches the process
  whose shutdown handler checkpoints the WAL and releases the writer lock. There is no
  `ENTRYPOINT`; compose's `init: true` reaps orphaned children.
- The app runs as the non-root `node` user (uid 1000). `EXPOSE 3000`.
- **Every agent process runs as its person's own OS user (ruling 460).** The image adds
  the group `viberr-agents` (gid 20000, `node` a supplementary member), the setuid launcher
  `/usr/local/libexec/viberr-launch` (root:node 4750: only root and group `node` can run
  it), and a root-owned `/etc/gitconfig` with `safe.directory=*` and
  `core.sharedRepository=group`. At boot the server sets its umask to 0002, re-asserts the
  store layout, hands each person's runtime home to their agent uid (from 20001) and probes
  the store as a uid that is not its own; `/resources/health` reports the outcome as
  `agentIsolation` (`on`, `off` where there is no launcher, `degraded` when the probe could
  read the store). The numbers are the Dockerfile's global ARGs
  (`VIBERR_AGENT_UID_FLOOR`/`_MAX`, `VIBERR_AGENT_GID`, `VIBERR_DATA_ROOT`), compiled into
  the launcher.
- SQLite projections + app data at `$VIBERR_DATA_ROOT` (`/data` in the image), which
  **must** be a persistent volume on a filesystem that enforces file permissions between
  users. Compose mounts the named volume `viberr-data` there (ruling 460). The earlier
  `./docker-data` bind mount does not qualify on Docker Desktop for macOS: VirtioFS let uid
  65534 read a 0600 file owned by uid 1000, and `ls -l` showed every entry as owned by
  whoever read it (measured 2026-09-24), so an agent uid could read the projection
  database. A store still there boots `agentIsolation: degraded` and readiness answers 503;
  move it once, below ([Moving the store to the named volume](#moving-the-store-to-the-named-volume-ruling-460)).
- The image also carries `db/`, `scripts/`, `app/` and `tsconfig.json`, so the maintenance
  CLIs (`npm run backup`, `keys`, `store:check`, …) run inside the container through `tsx`.

What `compose.yml` adds around it: `env_file: .env`, optional (ruling 504); `NODE_ENV=production` and
`VIBERR_DATA_ROOT=/data` forced over whatever `.env` says; the four controller unlock
flags defaulting to `disabled`; the three `VIBERR_BUILD_*` build args (ruling 345); an
empty `./.host-disk` mounted read-only at `/host-disk` and named in
`VIBERR_HOST_DISK_PATH`, so the free-space check reads the host disk under Docker
Desktop's volume (ruling 603, [configuration.md](configuration.md));
`hostname: viberr` (the writer lock's holder identity, see
[Single-writer safety](#single-writer-safety-b-fd1--f18-5)); `ports:
"${PORT:-3000}:${PORT:-3000}"`; a healthcheck that fetches `/resources/health` every 30 s
(timeout 5 s, 3 retries, 20 s start period); `restart: unless-stopped`; and
`cpus: "${VIBERR_CPUS:-0}"`. That CPU line is a ceiling, not a reservation: the
run-concurrency cap counts runs, and one run can fork a test worker per host CPU (measured
on a 10-core Mac with the cap at 0: six live runs, the container at 723% CPU and 5.4 GB).
Set `VIBERR_CPUS` in `.env` to roughly cores minus 3 on a machine someone also works on.
Unset, there is no ceiling (ruling 504): Docker refuses to start a container whose ceiling
exceeds the host's CPU count, so the fixed `7` it used to be stopped a starter's first `up`
on a small VM.

## Secrets & configuration

All configuration comes from environment variables, validated at startup
([`app/server/config/env.server.ts`](../../app/server/config/env.server.ts)) — the
process refuses to boot and prints every invalid variable. Every variable is optional
(see [`.env.example`](../../.env.example) and [configuration.md](configuration.md)),
the two secrets included (ruling 504). When the environment leaves
`VIBERR_SESSION_SECRET` or `VIBERR_SECRET_ENCRYPTION_KEY` unset, the first process that
reads the env generates both, once, into `<data root>/state/instance-secrets.json`: 0600,
inside the server-only `state/`, so no agent uid can open it. Every process after it (the
server, the seed, the backup, the key tools) reads the same file. It is never regenerated;
a file that cannot be read stops the process. The cost is that the key sits on the volume
beside the secrets it seals, and a backup carries it (below). To manage them yourself, set
them:

```bash
VIBERR_SESSION_SECRET=$(openssl rand -base64 48)        # ≥ 32 chars
VIBERR_SECRET_ENCRYPTION_KEY=$(openssl rand -base64 32)  # decodes to exactly 32 bytes (AES-256-GCM)
```

A value set in the environment wins over the file, key by key. Once anything has been
sealed under a generated key, take it over unchanged: copy both values out of the file
(`docker compose exec app cat /data/state/instance-secrets.json`) into `.env`. A new key
is a rotation instead (below), or every sealed secret becomes unreadable.

Inject them at runtime — do not bake them into the image (`.dockerignore` excludes
`.env` and `.env.*` except `.env.example`). With Compose they come from `.env` via
`env_file`; on a container platform, set them as runtime secrets/env vars.
`VIBERR_SECRET_ENCRYPTION_KEY` seals stored GitHub PATs, MCP credentials, OAuth client
secrets, the S3 audit-export secret and the personal backend API keys people paste;
**losing it makes every one of them undecryptable** (users must re-add PATs and
reconnect pasted keys). Rotating is supported and finishable: set
`VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` to the old key, run `npm run keys -- status`
(read-only, works on a live instance) to see how many secrets still open only under it,
`npm run keys -- reseal` (writer lock, app stopped) to move them, and drop the previous
key once status reports none. Without that count there is no moment at which removing
the old key is known to be safe.

Optional integrations, enabled only when their vars are present:
`GITHUB_OAUTH_*` / `GOOGLE_OAUTH_*` (OAuth sign-in; an `oauth_providers` row set in the
app overrides them) and `VIBERR_SEED_ADMIN_*` (bootstrap admin on first boot of an empty
DB). Agent backends are **not** among them: they carry no environment variables at all
(ruling 127) and are connected per person in the app (below).

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
URLs and cookie attributes from it, and PR bodies link back to tasks through it; unset
behind a proxy, `trustedOrigins` collapses to `[]` and the OAuth flow breaks. Boot logs
two warnings about it: when an OAuth client id is configured and `BETTER_AUTH_URL` is
not, and when `NODE_ENV=production` and it is an `http://` origin on a non-loopback host
(session cookies would then be issued without `Secure`).

**The failure mode if you skip the proxy.** The image sets `NODE_ENV=production`, and with
no explicit origin better-auth falls through to its production defaults: it issues
`__Secure-`-prefixed session cookies with `secure: true`. A browser will not store those
over plain http. The user submits correct credentials, gets a 200, and lands back on the
login page — a silent login loop with nothing in the app logs to explain it. This is
better-auth failing closed, which is the correct behaviour; the fix is to front the app
with TLS, not to weaken the cookie.

Three proxy details worth getting right:

- Forward `X-Forwarded-For` **and set `VIBERR_TRUST_PROXY=1`** (the number of proxy hops
  to trust). The header is ignored unless that variable is set, so forwarding it alone
  changes nothing. It is the container's only view of the client IP: the sign-in throttle
  keys on `email|ip` and falls back to a literal `local` without it, so the limiter still
  works per account but stops distinguishing attackers from the legitimate owner of that
  account (`clientIpOf` in `app/server/auth/rate-limit.server.ts`).
- Forward `Accept` and `Cache-Control` untouched and disable response buffering on
  `/resources/events`. That is the SSE endpoint every live page and the run console
  stream from; a buffering proxy stalls live updates. The response carries
  `Cache-Control: no-store, no-transform` and `X-Accel-Buffering: no`.
- Each visible page holds at most one SSE stream, except the project controller page,
  which holds two (the layout's and its own); `/insights` has none, and the controller
  dock opens one there while its panel is open. Over HTTP/1.1 a browser allows about six
  connections per origin, so several visible pages of one instance can exhaust the pool
  and every request then hangs with no error (ruling 301; a hidden tab closes its
  streams). The app serves HTTP/1.1; a proxy that speaks HTTP/2 to the browser
  multiplexes the streams over one connection.

**Why React Router stays at 8.3.0.** From 8.3.1 React Router refuses an action whose
`Origin` header differs from `request.url` in its whole origin, scheme included; 8.3.0
compared only the host. `react-router-serve` builds `request.url` from the socket and never
trusts `X-Forwarded-Proto` (`VIBERR_TRUST_PROXY` above is the app's own setting and does not
reach it), so behind this proxy every `request.url` is `http://` while the browser sends an
`https://` `Origin`, and every form and fetcher action answers 400 ("The `request.url`
origin does not match `origin` header from a forwarded action request"; measured on 8.4.0,
2026-10-07). Upstream's fix reads the header only in `react-router dev` and `vite preview`.
So `react-router`, `@react-router/serve` and `@react-router/dev` are pinned exactly in
`package.json`. Moving past 8.3.0 needs a server that takes the scheme from the proxy, or an
upstream `react-router-serve` that does. The e2e stack (`compose.e2e.yml`) has no proxy, so
the e2e suite would not catch the break.

HSTS, certificate renewal and redirect-to-https all belong to the proxy layer.

## Agent accounts are per person (ruling 127)

The image ships everything needed to run real agents: the Claude/Codex SDKs' native
linux binaries (inside the production `node_modules` from the `prod-deps` stage) plus, in
the runtime stage, `git` and a CA bundle (a real run clones the task's repo and the coding
agent shells out to git), `make`, `curl` and a pinned `pnpm` (ruling 196), Debian
`chromium` with `fonts-liberation` for the governed browser
(`VIBERR_BROWSER_EXECUTABLE=/usr/bin/chromium`), `poppler-utils` (`pdftoppm`, `pdftotext`,
`pdfinfo`) so an agent can look at the pages of a PDF it delivers or judges (ruling 566),
and `uv`/`uvx` for Python stdio MCP
servers (their caches live under `runtimes/uv-cache` and `runtimes/uv-python` on the
volume; uv manages its own CPython, so there is no system `python3`).

What it does **not** ship is a credential. There is no deployment-wide key, no shared
runtime home, no host mount and no entrypoint that seeds one. **Every person connects
Claude and Codex for themselves, in the app, on Profile → Agent accounts**, and every run
bills exactly one person: the **task owner** for a run on a task (operator, specialist,
resume, scheduled, boot recovery, retry) and the **asker** for a controller turn. That
principal is persisted on the run row as `agent_runs.credential_user_id`.

Two ways to connect, per backend:

- **Hosted sign-in through the unmodified vendor binary.** Claude: `claude auth login`
  with `--claudeai` (a Pro/Max subscription) or `--console`. Codex: `codex login
  --device-auth`, the device-code flow OpenAI ships for headless machines. Viberr drives
  the binary, shows the URL (and, for Codex, the one-time code to type), and never sees
  the token: the binary writes its own credential file into the home of the account being
  signed in (ruling 507), inside that person's runtime home,
  `<dataRoot>/runtimes/users/<userId>/claude-home/accounts/<accountId>/.credentials.json` or
  `.../codex-home/accounts/<accountId>/auth.json` (Viberr creates the directory mode `0700`
  and nothing else about that file; an account connected before ruling 507 keeps its file
  directly in `claude-home/` or `codex-home/`). This is what Anthropic's
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

A person may keep several accounts per backend (ruling 507), up to ten: each sign-in or
pasted key adds one and makes it the one their runs bill, and the **Runs use** picker on
Profile → Agent accounts switches to another without a sign-in (ruling 616), because each
keeps its sign-in in its own home. A run already going keeps the account it started on.

Each Codex run works in a private copy of its principal's home,
`runtimes/users/<userId>/codex-home/runs/<runId>/` (ruling 181): the billed account's
`auth.json` and the shared `config.toml` copied in, `sessions/`, `skills/` and `memories/`
linked back to the shared home, `CODEX_SQLITE_HOME` pointed at the shared home. When the
run settles, an `auth.json` the CLI refreshed is copied back to that account's home and the
directory is deleted; boot recovery does the same for a run a restart orphaned, and the
end-of-run compaction works in a copy of its own (`runs/<runId>-compaction/`).

**First run, as the first admin.** After `docker compose up -d`, sign in as the bootstrap
admin, open **Profile → Agent accounts**, and connect at least one backend for yourself.
Home's setup checklist (ruling 532) lists it with the instance's other gaps, each a link
to where it is closed: a GitHub connection, an account of your own beside the bootstrap
admin, and the first project. GitHub is needed only for a board that delivers through a
repository: a board that delivers results is created with none (ruling 667), a software
board can connect its repository later (ruling 672), and the
checklist stops listing GitHub once a project exists on an instance with no connection.
Until somebody does, the instance runs no agents: an agent started on a task whose owner
has nothing connected is refused before any process starts, with an honest
`run·unavailable` error run and a blocked recovery packet naming the owner and the
backend. Task creation seats the creator as owner, so the person who creates work is the
person whose accounts pay for it, unless ownership is reassigned.

**What a wiped volume loses.** The hosted sign-in files live only under
`runtimes/users/<userId>/` on the `/data` volume. Deleting or recreating that directory
signs everyone out of the vendors: their cards flip to "sign-in file missing (the runtime
volume was wiped)" and each person signs in again. Sealed API keys survive a volume wipe
only if the database did, and are readable only with the same
`VIBERR_SECRET_ENCRYPTION_KEY`. Nothing else is lost: the credential rows, the runs and
the transcripts are unaffected by a re-signin, and no run is retried automatically.

**Backups include the homes only on request.** `npm run backup` excludes `runtimes/` by
default precisely because it holds every person's live sign-in; `--include-runtimes`
carries `runtimes/` (the homes and the raw transcripts) and turns the artefact into a
secret. The sealed keys ride in `projection.sqlite`, which the default backup does take,
and are unreadable without the encryption key backed up separately.

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

## Codex runs are not OS-confined (ruling 185)

Viberr starts **every** Codex run `danger-full-access`, and the container keeps Docker's
own seccomp profile — `compose.yml` carries no `security_opt`. Do not add one back without
a ruling: it would lift the profile for every process in the container.

The Codex CLI *can* confine a run (bubblewrap on Linux, seatbelt on macOS). Viberr does
not ask it to, because two upstream properties made confinement cost more than it bought,
and pass 36 measured both:

- **bubblewrap needs an unprivileged user namespace** (`unshare(CLONE_NEWUSER)`), which
  Docker's builtin seccomp profile refuses to a non-root process — and the app runs as the
  non-root `node` user. A confined run dies at its first shell command with
  `bwrap: No permissions to create a new namespace`, and the models reported that
  environment failure as a verdict on correct work (F36-1). The only remedy is running the
  whole container `seccomp=unconfined`, which is a bigger hole than the sandbox is a wall.
- **with the network off the CLI installs a seccomp filter that refuses every socket
  syscall, `AF_UNIX` included.** libuv's *synchronous* spawn needs a socketpair, so inside
  such a sandbox `spawnSync` reports `EPERM` *after the child has already run*,
  `execSync`/`execFileSync` throw it, `net` fails on both `AF_UNIX` and `AF_INET`, and only
  async `spawn` is unaffected. `npm ci` dies on esbuild's postinstall, so no
  `npm`/`npx`/`pnpm`/`yarn` gate can run at all (F36-11). Live, that deadlocked the review
  gate: the reviewer called it "an environment evidence blocker, not a code finding" and
  still requested changes, and the operator sent the deliverer back around.

Chromium still needs `--no-sandbox` for the same user-namespace reason, and the browser
mount passes it whenever `VIBERR_BROWSER_EXECUTABLE` is set.

**What confines an agent** is Viberr, not the OS: the run's contract omits every step it
may not take, each supporting engagement works in its own isolated checkout, agents hold
no credential, delivery is server-owned, and verdicts bind to a revision. The honest cost
is that on Codex a withheld `execute-code-or-write-repo` is **advisory** — the agent editor,
the capability matrix and the agent card all say so on the row. Web search still binds on
both backends (it is the CLI's own tool, not the sandbox), and so do the MCP write-tool
denials.

The host toolchain is still reported — versions only (`app/server/ops/toolchain.server.ts`,
rulings 182(b), 191 and 196):

```bash
curl -s localhost:${PORT:-3000}/resources/health | jq .toolchain
# {"node":"26.8.2","npm":"11.19.1","git":"2.47.3","python3":null,"go":null,
#  "make":"4.4.1","docker":null,"pnpm":"12.9.1","yarn":null,"curl":"8.14.1",
#  "codexCli":"0.160.1","claudeAgentSdk":"0.3.291"}
```

`make`, `curl` and a pinned `pnpm` (`12.9.1`) ship in the image (ruling 196); `docker` is
`null` deliberately and is not coming — an agent holding the daemon socket controls every
container on the host. The same reading is injected into every specialist, operator and
controller prompt (ruling 191), so an agent plans around what is present instead of
discovering each absence as an exit-127. For any other command the controller's
`instance_health` takes a `probe` list of up to 8 bare names (ruling 377).

## First run

```bash
docker compose up -d --build
docker compose logs -f app  # boot integrity log: dirs, migrations, counts, users, build, disk, toolchain; the bootstrap admin's one-time password
curl -s localhost:3000/resources/health | grep -o '"agentIsolation":{[^}]*}'   # "status":"on"
```

No `.env` is needed (ruling 504): Compose treats it as optional, the two secrets are
generated into the store, and Compose creates the store, the named volume `viberr-data`
(ruling 460), on this first `up`. Docker initialises the empty volume from the image's
`/data` (owned `node:viberr-agents`, 0750), so there is no host directory to create or
chown.

`docker compose down` keeps the volume; `docker compose down -v` deletes it, and with it
the canonical files, the database, every sealed credential and every person's sign-in.
A host that people also work on wants `VIBERR_CPUS` (above), and one behind a TLS proxy
`BETTER_AUTH_URL` and `VIBERR_TRUST_PROXY` (below). A volume lives inside Docker, not in the
repository: read a live instance through the app, `docker compose exec app …` (the
maintenance CLIs, `ls`, `cat`) or a backup (`npm run backup`, below), never by opening
files on the host.

### Moving the store to the named volume (ruling 460)

A deployment from before ruling 460 keeps its store in `./docker-data` (a bind mount).
Move it once, with the app stopped:

```bash
docker compose stop app
npm run store:to-volume          # ./docker-data → the volume viberr-data
docker compose up -d
curl -s localhost:3000/resources/health | grep -o '"agentIsolation":{[^}]*}'   # "status":"on"
```

`npm run store:to-volume` (`scripts/store-to-volume.ts`) takes the data-root writer lock on
`./docker-data` first, so it refuses while the container still runs on it; refuses when the
volume already holds a store (a one-time move, never a merge); copies everything, drops its
own lock file and makes the tree the server's; and leaves `./docker-data` as it was — keep
it until the app is back and healthy. By hand, the same copy is:

```bash
docker run --rm -v viberr-data:/data -v "$PWD/docker-data":/from:ro node:26-slim \
  sh -c 'cp -a /from/. /data/ && chown -R 1000:1000 /data'
```

At its next boot the server re-asserts the layout (`state/` 0700 and the rest) and hands
each person's runtime home to their agent uid, so nothing else needs doing. The host dev
server (`npm run dev`) keeps using `./docker-data` as its own store from then on: it no
longer shares the container's.

**The image fetches its Debian packages over HTTPS.** The runtime stage installs from
`deb.debian.org` in four `apt-get` layers (`git` + `ca-certificates`, then `make` +
`curl`, then `chromium` + `fonts-liberation`, then `poppler-utils`), each refreshing a
package index of about 10 MB before fetching its archives (roughly 25 MB, 1 MB, 192 MB
and a few MB, a 15.2 MB layer once installed). The base image names
that mirror over plain HTTP, and on a connection that shapes port 80 (measured on the
owner's Mac: 20–50 KB/s to every Debian mirror over HTTP, 3.6 MB/s to the same host over
HTTPS) the first index alone took over three minutes, and a `docker compose up -d --build`
looked hung and was cancelled at 2m49s. So the first apt layer rewrites
`/etc/apt/sources.list.d/debian.sources` to `https://` before it fetches anything,
trusting the mirror through Node's embedded root store (`tls.rootCertificates`, written to
a temporary file passed as `Acquire::https::CaInfo`) for that one layer, which installs
`ca-certificates`; the system store that install creates carries every later apt call.
Every package is signature-checked over either transport; the change is about throughput.
Docker's layer cache hides all of this while the layers survive, so it surfaces only on a
cold cache — a fresh machine, a `docker builder prune`, a base-image bump. A build that
still stalls on an `apt-get` line is the network, not the image: from the host,
`curl -o /dev/null -w '%{speed_download}\n' https://deb.debian.org/debian/dists/trixie/InRelease`
is the two-second check, and the same URL over `http://` shows the throttle.

- Migrations apply automatically at boot; no manual migrate step is needed.
- On an **empty** users table the bootstrap admin is created from `VIBERR_SEED_ADMIN_EMAIL`
  / `VIBERR_SEED_ADMIN_PASSWORD` (or `admin@viberr.dev` with a random password logged once
  as `VIBERR BOOTSTRAP ADMIN`, which must be changed at first sign-in).
- Boot writes the shipped agent assets (each built-in agent's definition and expertise
  skill, the base profile templates) into a store that lacks them.
- Home's setup checklist lists what is still missing, until nothing is (ruling 532): for
  an org admin a GitHub connection (only while the instance has one or has no project
  yet, ruling 667), an account other than the bootstrap admin, their own
  Claude or Codex account and the first project; for everyone else the last two. Once
  there is a project, its cross hides it until the sign-in or the browser's session ends
  (ruling 621).
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
  tasks }, projectionStore, watcher, kbWatcher, lock, backends, browser, disk,
  maintenance, build, quota, toolchain }` (key order is part of the contract; `backends`
  is `{ claude: { connectedUsers }, codex: { connectedUsers } }`). The bare URL is a
  **liveness** probe: `200` even when `status: "degraded"`. For a **readiness** probe call
  `?probe=readiness` (or `?probe=ready`): it returns `503` with the same body while
  anything is degraded (a dead watcher, no lock, low disk, a projection that cannot be
  rebuilt). `503 { ok: false, status: "down" }` means SQLite is unreachable. Compose's own
  healthcheck is the liveness form. Field reference:
  [`runbook.md`](runbook.md#health--liveness).

## Persistence, backup & restore

Everything stateful lives in the named volume `viberr-data` in the Compose setup, mounted
at `/data` (ruling 460; `./docker-data` before it). Both SDKs keep their resumable state
under `runtimes/`:

```
projects/       canonical project.md, task.md, epics/*.md (the source of truth — editable);
                per task: workspace/ (git clones, a cache), attachments/ (evidence files) and
                deliveries/ (each files delivery as it was delivered, ruling 597);
                per project: .repo-mirror/ (bare mirror, a cache)
agents/         agents/profiles/*.md templates + agents/definitions/ doctrine files
kb/ skills/     knowledge-base and skill files
runtimes/       claude/ and codex/: raw NDJSON run logs per backend (0700);
                users/<userId>/{claude-home,codex-home}/: one person's provider sessions
                (ruling 127), each account's own home under accounts/<accountId>/ with
                its vendor sign-in file (ruling 507), and codex-home/runs/<runId>/
                while a Codex run is live (ruling 181); users/<userId>/home/: that person's
                agents' $HOME (ruling 460) — all owned by the person's agent uid;
                uv-cache/, uv-python/ and controller-scratch/ (shared with the agent group)
audit-exports/  audit-events-<date>.jsonl written before each 90-day purge
state/          projection.sqlite (users, sessions, projections, audit, PATs, notifications,
                sealed personal backend keys), writer.lock, shipped-assets.json;
                tmp/reader-<pid>/ only while a read-only CLI holds its copy (ruling 158)
```

Boot creates the nine `DATA_ROOT_SUBDIRS` (`projects`, `agents`, `agents/profiles`,
`runtimes`, `runtimes/users`, `kb`, `skills`, `audit-exports`, `state`;
`app/server/files/file-store-root.server.ts`); the rest appear when first written,
including each person's own `runtimes/users/<userId>/{claude-home,codex-home}` (created by
`ensureUserBackendHome` the first time they connect, and handed to their agent uid — owner
the uid, group `node`, 2770 — by the launcher, ruling 460). In the image boot then
re-asserts the modes: `/data` 0750 in group `viberr-agents`, `state/`, `audit-exports/` and
`runtimes/claude|codex/` 0700, `runtimes/users/` 0710, `agents/`, `kb/`, `skills/`,
`projects/` 0755, and each task's `workspace/`, `attachments/`, `.operator-scratch/` 2770 in
the agent group ([agents-and-runtime.md §8](../domain/agents-and-runtime.md#8-boot-recovery)).
There is no `auth/`,
`cache/` or `logs/` directory; application logs are structured JSON on stdout. Full layout
with retention: [`../architecture/data-model.md`](../architecture/data-model.md#2-data-root-layout).

- **Backup** = `npm run backup` (add `--out <dir>`). It writes
  `viberr-backup-<timestamp>/` containing a genuine point-in-time `projection.sqlite` —
  taken with `VACUUM INTO`, so it folds in WAL content and lands as ONE file with no
  sidecars — plus the canonical markdown tree — `projects/`, `agents/`, `kb/`, `skills/`
  and `audit-exports/` (`BACKED_UP_STORE_DIRS`; a directory that does not exist yet is
  skipped) — and a `MANIFEST.json` (format `viberr-backup/1`) recording byte size, sha256
  and the row counts read back out of the artefact, plus a `README.txt`. `audit-exports/`
  is in that list because ruling 102 makes it the durable record that outlives the 90-day
  `audit_events` window: a backup without it would drop exactly the history the purge was
  designed to preserve. It does **not** take the writer lock: a backup that refused to run
  on a live instance would be no backup at all.

  **How it reads a live root.** Never through a second connection: whenever
  `state/writer.lock` is there at all the CLI copies `projection.sqlite` and its
  `-wal` to `state/tmp/reader-<pid>/`, runs the `VACUUM INTO` on the copy and removes it
  (ruling 158; the manifest's first `contains` line then says the database was read from a
  copy taken while `state/writer.lock` named a holder). Only a root with no lock file is
  just files it opens in place, read-only: a reader cannot tell a dead holder from a live
  one in another pid namespace, and a copy it did not need costs nothing but disk. That is
  the rule for every reader, on either side of the container boundary: copy first, never a
  second connection to a live database, because the second mapping of the WAL index is
  what produced the SIGBUS in pass 34 (a host-side reader over the bind mount) and again
  in pass 35 (an in-container `readOnly: true` reader); the runbook's
  [Readers, and where they must run](./runbook.md#readers-and-where-they-must-run) has
  both. **Where it runs.** Inside the container is the worked form, and it needs an
  explicit `--out`: the default `./backups` is `/app/backups` inside the container and is
  lost with it, and `createBackup` refuses a destination under the data root it is backing
  up, so the artefact goes to a container-local directory and is copied out at once:

  ```bash
  docker compose exec -T app npm run backup -- --out /tmp/viberr-backups
  docker compose cp app:/tmp/viberr-backups/. ./backups/
  ```

  The store is a named volume (ruling 460), so the host cannot open it: the in-container
  form above is the one that reads the instance, running or not. `npm run backup` from the
  repo root backs up whatever `.env`'s `VIBERR_DATA_ROOT` names on the host — the dev
  server's `./docker-data`, not the container's store.

  Read the artefact's own README for what it excludes. Three exclusions matter most:
  `runtimes/` (live agent logins, one set per person under `runtimes/users/` — opt in
  with `--include-runtimes`, and then treat the artefact as a secret),
  **a `VIBERR_SECRET_ENCRYPTION_KEY` set in the environment**, and the git
  trees under `projects/` — each task's `tasks/<KEY>/workspace/` checkout and each
  project's `.repo-mirror/` bare mirror. Those two are re-derivable from the remote, a live
  run can be mid-write so the copy would be torn, and they dwarf what is actually truth (on
  the tree this was found on, 17M of git against 168K of project and task markdown); the
  next run re-clones and re-fetches. `state/writer.lock` and `*.tmp` files are never
  copied. Without the key every sealed PAT, MCP credential and personal backend API key in
  the backed-up database is unreadable, so back an environment key up separately. A key
  the instance generated for itself is IN the artefact, as `state/instance-secrets.json`
  (ruling 504): the manifest says so, and the artefact then opens every sealed secret, so
  treat it as a secret.

  Copying the volume wholesale (`docker run --rm -v viberr-data:/data:ro -v
  "$PWD/backups":/to node:26-slim cp -a /data/. /to/`), `-wal`/`-shm` sidecars included,
  also works with the app stopped, but a hot copy of `projection.sqlite` alone silently
  loses every committed row still living in the WAL — the trap `VACUUM INTO` removes.

- **Restore** = `npm run restore -- --from <artefact>`. Whole-root restore takes the writer
  lock, requires `--force` if the root is occupied, and *moves* displaced data aside to
  `<dataRoot>.replaced-<ts>/` rather than deleting it; `runtimes/` is displaced and
  replaced only when the artefact carries it. Generated secrets come back with the
  database they sealed; the replaced root's own move aside with its database, and on a
  fresh volume the pair the restore's own start generated never counts as data needing
  `--force` (ruling 504). To recover a single hand-broken canonical
  file without touching the database: `npm run restore -- --from <artefact> --file
  projects/<slug>/tasks/<KEY>/task.md` — the broken bytes are kept beside it as
  `task.md.broken-<ts>`.

**`state/projection.sqlite` is primary storage, not a cache — back it up.** The
projection tables inside it are derived and rebuild from `projects/`, but the same file is
the *only* home of every user row and better-auth credential, every session, every
AES-sealed GitHub PAT and personal backend key, the whole audit trail, and all
notifications. None of that exists in the canonical Markdown, so none of it is
rebuildable.

Restoring `projects/` without the database does not degrade gracefully. On the next boot
the users table is empty, so the bootstrap admin is minted with a **fresh** user id, while
the surviving task and project files still carry the old ids in `members[].userId` and
`ownerUserId`. Those ids now resolve to nobody: every membership and task owner becomes a
ghost. Rebuilding projections cannot fix it — the ids in the files are the problem, and
there is no re-mapping tool. Treat a `projects/`-only restore as a new instance whose
memberships and owners must be re-established by hand.

## Re-baselining the projection database

Boot's integrity line is followed by a `projection schema drift` **WARN** when this
database's rebuilder tables lag the running build (`logBootIntegrity` in
`app/server/boot.server.ts`). It carries up to two lists, each with an `impact` and a
`remedy`:

- `refuses`: CHECK values the running build produces that this root's stored CHECK does not
  admit (`projectionCheckGaps`): `task_projections.validation` (F21-1),
  `task_projections.waiting` (ruling 225) and `notifications.kind` (ruling 140). A task
  whose derived value lands on a refused member stops projecting behind a generic
  `projection rebuild failed`; a notification of a refused kind is refused at its insert.
  Boot widens `notifications.kind` itself before this check (`widenNotificationKindCheck`,
  ruling 481: the app-owned table is rebuilt from the baseline's DDL with its rows and
  indexes), so that entry appears only when the rebuild failed, and its ERROR line says
  so.
- `missingColumns`: `task_projections` / `task_events` columns the shipped baseline has and
  this root lacks (`projectionMissingColumns`), which fail EVERY task's projection with
  "no such column".

Migrations are squashed into `0001_baseline.sql` and forward-only, so a baseline change
reaches a **fresh** `projection.sqlite` and nothing else — a root opened by an older build
keeps the schema it was created with.

**First, check whether you need a remedy at all.** Most additive drift repairs itself: a
baseline column or table added after this root was created is applied at open by
`ensureBaselineColumns` (`app/server/db/sqlite.server.ts`), which `ALTER TABLE … ADD
COLUMN`s each missing entry of `BASELINE_COLUMNS` — on `agent_runs`
`dispatched_by_name`, `dispatched_by_user_id`, `credential_user_id`,
`interrupted_reason`, `usage_final`, `no_checkout`, `verdict_withheld`, `review_subject` and
the eleven prompt-cache columns of ruling 369; `controller_conversations.task_key` and `seen_seq`;
`controller_messages.surface`, `reply_to` and `unlinked_history`; `org_mcp_servers.tool_policy_json` and `tool_names_json`;
`projects.required_reviewers_json`; `task_projections.recommendation_kinds` — creates the
`BASELINE_TABLES` (`project_github_health`, `user_backend_credentials`) and indexes it
lacks, and logs `added a baseline column this data root predated`. A column whose DEFAULT
would be WRONG for the rows that predate it carries a one-time backfill run in the same
step (`usage_final = 1` on the `finished` runs, whose token columns held the provider's own
figures; `seen_seq` set to each conversation's newest message so a deploy does not mark
every old thread unread; `unlinked_history`'s walk linking `reply_to` where the
controller's FIFO proves it and marking the rest earlier history, so boot recovery does
not note old messages as unanswered, and a root the first `reply_to` backfill already
linked is walked again when it gains the column); a backfill that cannot run is
logged as a warn. A failure to
ALTER is warned, not fatal, and retried next boot.

A `missingColumns` entry that is NOT in that list (for example
`task_projections.blocked_by_json` on a root older than ruling 131) is still additive:
with the app stopped, the WARN's own remedy is `ALTER TABLE <table> ADD COLUMN <column>`
with the column's definition from `0001_baseline.sql`, which keeps every non-derived row.
What follows is for the shape no ALTER can fix: a CHECK constraint that refuses a value
the running build produces.

Two remedies, and the lossy one is not the only one:

**Preferred — preserve-copy.** Recreate the schema and carry the non-rebuildable rows
across, which is exactly the shape `selfHealProjectionDbIfCorrupt`
(`app/server/db/self-heal.server.ts`) performs on a corruption verdict: open a
FRESH file, run the migrations into it, then with `PRAGMA foreign_keys = OFF` copy every
table across on the intersection of the columns both sides have, skipping the ones the
rescan rebuilds from files (`REBUILT_FROM_FILES`: `provenance`, `schema_migrations`,
`projects`, `project_members`, `task_projections`, `task_events`, `diagnostics` — leaving
those EMPTY is what makes the boot rescan re-project every file rather than trust a stale
content hash). Move the old file aside rather than deleting it, then start the app: the
rescan refills the projection tables from `projects/`. Users, sessions, sealed PATs,
audit, notifications, org resources and run history survive. There is no CLI for this —
the self-heal path runs it only for a corrupt file — so it is a scripted one-off; write it
against that module's table list rather than inventing one, and take a backup first
either way (the in-container form under *Persistence, backup & restore*, or from the host
once the container is down).

**Lossy — delete and rebuild.** Simpler, and acceptable on a throwaway or freshly seeded
root:

```bash
docker compose exec -T app npm run backup -- --out /tmp/viberr-backups   # see the cost below
docker compose cp app:/tmp/viberr-backups/. ./backups/
docker compose stop app              # one writer per root; never delete state while it runs
docker compose run --rm --no-deps --entrypoint sh app \
  -c 'rm /data/state/projection.sqlite*'   # -wal and -shm too
docker compose up -d                 # migrations re-apply, projections rebuild from projects/
```

The store is the named volume (ruling 460), so the deletion runs in a one-off container
on it rather than on a host path. The backup reads a copy of the live root (ruling 158);
nothing writes between it and the stop but what a live instance writes in those seconds.

**Name the cost before you run it.** The projection *tables* are derived and rebuild from
`projects/` at boot — but they share the file with rows that exist nowhere else: users and
better-auth credentials, sessions, AES-sealed PATs, MCP credentials and personal backend
keys, the audit trail, notifications, org resources and run history. Deleting the file
deletes those too. Expect to sign in again as a freshly minted bootstrap admin, and read
the ghost-membership warning under *Persistence, backup & restore* first: the surviving
task and project files still carry the OLD user ids. Restoring the backup afterwards puts
the drifted schema back, so it is a safety net for the data, not a way to undo the
re-baseline.

## Upgrades

New app version → rebuild the image and `docker compose up -d`. Migrations apply at boot;
the data-root volume carries state across deploys. Roll back by redeploying the previous
image against the same volume (migrations are additive and forward-only — take a data-root
backup before a major upgrade).

**Use `npm run deploy`** (`scripts/deploy.ts`, ruling 345). It stamps the build from git,
builds, restarts, and then reads `/resources/health` back and refuses to report success
unless the running instance names the sha it just built:

```bash
npm run deploy              # stamp from git, build, up -d, verify
npm run deploy -- --no-up   # stamp and build only, nothing restarted
```

Before it builds, it measures the host (ruling 603, `app/server/ops/host-disk.server.ts`):
the checkout's disk, Docker Desktop's directory (`~/Library/Containers/com.docker.docker/Data`
on a Mac, `~/.docker/desktop` on Linux) and Docker's root directory when it is on this
host. With less than 8 GB free on the tightest, it refuses and names that disk. A build
writes into Docker's disk, which on Docker Desktop is a sparse image file growing on the
host: on 2026-09-30 a cold build (about 5-6 GB) filled the Mac, and the Docker VM
remounted its disk read-only under the running instance. Nothing inside the VM could warn,
because the volume there reported 940.8 GB free. `--skip-disk-check` builds without the
measurement.

After the instance reports the new build, it removes the older builds of this project's
app that earlier deploys left untagged, keeping the one this deploy replaced (ruling 605):
each is about 0.9 GB of its own layers, and three deploys left 2.6 GB. To roll back to the
kept build, tag it and restart without building:

```bash
docker images --filter dangling=true --filter label=com.docker.compose.service=app
docker tag <image id> viberr-app:latest && docker compose up -d --no-build
```

Then it trims Docker's build cache to at most 3 GiB of reclaimable cache, the most recently
used first (`docker builder prune --max-used-space`, ruling 628). That holds a whole build's
layers, so the next build stays incremental; the layers the running build holds are kept
beside it and not counted. Every build adds the layers it made, and after deploy 48 the cache had grown to
6.7 GB, 4.8 GB of it reclaimable.

It runs `git` on the host, sets `VIBERR_BUILD_VERSION` (from `package.json`),
`VIBERR_BUILD_SHA` (`git rev-parse HEAD`) and `VIBERR_BUILD_TIME` (now) for `docker compose
build`, warns (without refusing) when there is no git revision or the working tree is dirty,
then `docker compose up -d`, prints the URL it will poll, and polls
`http://127.0.0.1:<port>/resources/health` every 3 s for up to 180 s. `<port>` is the host
port `compose.yml` publishes, resolved the way compose resolves `${PORT:-3000}`: `PORT` from
your shell if it is set there, otherwise `PORT` from `.env`, and `3000` when neither sets
it or the value is empty. It exits 1, naming that URL, if nothing answers, and exits 1 if
the reported `build.revision` is not the first 12 characters of the sha it stamped.

Note that `up -d` kills every run in flight, so check the board before deploying.

Verify what is running from `/resources/health` → `build`: `version` comes from
`VIBERR_BUILD_VERSION` or `package.json`; `revision` from `VIBERR_BUILD_SHA`, or from the
checkout's `.git` when there is one (there is not, in the image — `.dockerignore` excludes
it, so **env is the only source a container can have**). `compose.yml` passes all three
build args through from the environment with empty defaults, which is what `npm run
deploy` fills; a bare `docker compose build` leaves them empty and the image honestly
reports a `null` revision. The manual equivalent, if you are not using the script:

```bash
docker compose build \
  --build-arg VIBERR_BUILD_SHA=$(git rev-parse HEAD) \
  --build-arg VIBERR_BUILD_TIME=$(date -u +%FT%TZ)
docker compose up -d
```

The `Dockerfile` declares `VIBERR_BUILD_VERSION`, `VIBERR_BUILD_SHA` and
`VIBERR_BUILD_TIME` as `ARG` and re-exports each as `ENV`; setting them in the container
environment works too.

## Scaling note

Single-node by design (SQLite + local file authority + in-process SSE bus). There is no
horizontal-scale story in V1; run one instance per data root. Vertical sizing is governed
by projection query volume and concurrent agent runs; the run-concurrency cap (Org
settings) bounds the runs, and compose's `cpus` ceiling bounds what those runs can take
from the host.

## Single-writer safety (B-FD1 / F18-5)

**One app process per data root, EVER.** Two processes pointed at one root corrupts the
SQLite WAL and silently loses transactions — `PRAGMA integrity_check` does NOT detect the
loss. Boot takes an exclusive `state/writer.lock` (an `O_EXCL` create) before it opens the
database; a second process refuses to boot naming the holder. The holder re-verifies
ownership every 20 s (`DATA_ROOT_LOCK_GUARD_INTERVAL_MS`) and **fails closed** (one
synchronous stderr `FATAL` line via `writeFatalSync`, then `process.exit(1)`) the moment
its lock file is deleted or replaced out from under it — because the fd stays valid on
the now-unlinked inode while a second boot can acquire the freed path.
`/resources/health` reports the current holder (`lock: { pid, hostname, startedAt }`) so
you can confirm exactly one writer.

Two ways this bites in practice, both to avoid:

- **Do NOT wipe `<dataRoot>/state` while a Viberr process is running.** Deleting the lock
  file lets a second process acquire the root; the first writes lock-less until the guard
  notices and exits. Stop the app first, then reset the store.
- **Beware the same-port `::1` vs IPv4 split.** A host dev server on `[::1]:5173` and a
  compose container's docker-proxy on `*:5173` both answer `localhost:5173` (macOS resolves
  `localhost` → `::1` first). Two live servers can look like one app. Since ruling 460 they
  no longer write the same store (the container's is the named volume, the dev server's
  `./docker-data`), which makes the split worse to notice, not better: you may be looking
  at the wrong store. Run exactly one per port; the health holder names which.

How the lock is judged (`classifyLock` in `app/server/db/data-root-lock.server.ts`): the
file records `{ pid, hostname, startedAt, bootId }` plus, on Linux, `procStartedAt` (the
holder pid's start time from `/proc`). A lock naming this very process's `bootId` is
reclaimed. A **different hostname is never probed** and is always refused (which is why
`compose.yml` pins `hostname: viberr`, so a recreated container matches its predecessor).
Same host and a lock naming this process's own pid (a crashed predecessor that was also
pid 1) is decided by `procStartedAt`: a different start time means the pid was recycled
and the lock is reclaimed. Otherwise same host and a dead pid → stale, reclaimed
automatically with a WARN; same host and a live pid → refused; an unreadable lock file →
refused. If the holder really is dead and the lock was not reclaimed, boot once with
`VIBERR_FORCE_DATA_ROOT_LOCK=1`. The writing CLIs (`seed`, `seed:demo`, `rescan`,
whole-root `restore`, `keys -- reseal`) take the same lock and refuse against a running
app; `backup`, `store:check`, `restore --file` and `keys -- status` take none. The two that
read the database (`backup`, `keys -- status`) copy it first rather than open it whenever
that lock file exists at all (they judge its PRESENCE, never its holder's liveness, which
cannot be probed from another pid namespace), since a second connection to a live root is
a hazard of its own (ruling 158). See
[`runbook.md`](runbook.md#the-single-writer-lock-and-cli-refusals).

## The e2e stack (`compose.e2e.yml`)

`npm run e2e` (`scripts/e2e.ts`) runs Playwright against the PRODUCTION image in a
separate compose project, `viberr-e2e`, that never touches `compose.yml`, `.env`,
`./docker-data` or any host credential. It uses synthetic secrets and a project-scoped
named volume `e2e-data`. A one-shot `seed` service built from the `build` stage (which
still has `test-support/`; the final image does not) runs `npm run seed:demo` into the
volume and hands it to uid 1000; the `app` service then boots the final image with
`hostname: viberr-e2e`, `init: true` and the app port published on a random loopback
port, which the script reads with `docker compose port app 3000`. The script removes any
leftover stack, runs `up --build --wait`, waits for `/resources/health`, requires
`agentIsolation.status` to be `on` and runs `scripts/check-agent-isolation.sh` inside the
app container (ruling 460: as a launched agent uid the server's `/proc/<pid>/environ`, the
projection database and another person's home are refused, its own home and a shared
workspace are writable, a workspace git launched with the server's overrides runs nothing
an agent planted and a branch is fetched out of an agent-only checkout through the
launcher's `git-upload-pack`, an agent-written checkout the server's own `rm -rf` cannot
finish is removed by the server's replace as its persons (ruling 485), what the server
itself wrote in an agent's tree is removable by the person and an emptied workspace root
goes with the server's `rmdir`, never through an agent's link (ruling 495), the launcher relays SIGTERM, SIGUSR2 kills the group grandchild
included, PDEATHSIG takes the agent down with the server, `--reap` finds a detached process
by its marker, and every refusal holds), passes the base URL to Playwright as
`VIBERR_E2E_BASE_URL`, and tears the stack down with its volume afterwards unless
`VIBERR_E2E_KEEP=1`. Details:
[testing.md](../development/testing.md#4-end-to-end-suite-playwright).
