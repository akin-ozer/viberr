# Deployment — single-node Docker

Viberr is a single-node, self-hosted monolith: one Node process serving the SSR app,
SSE live updates, and an embedded SQLite projection database, with all authoritative
state on the local filesystem. There is no external database, cache, or queue to run.

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
`VIBERR_SECRET_ENCRYPTION_KEY` encrypts stored GitHub PATs; **losing or rotating it
makes existing encrypted tokens undecryptable** (users must re-add PATs).

Optional integrations, enabled only when their vars are present:
`GITHUB_OAUTH_*` / `GOOGLE_OAUTH_*` (OAuth sign-in), `VIBERR_SEED_ADMIN_*` (bootstrap
admin on first boot of an empty DB), and the agent backends below.

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

- Forward `X-Forwarded-For`. It is the container's only view of the client IP. The
  sign-in throttle keys on `email|ip` and falls back to a literal `local` without it, so
  the limiter still works per account but stops distinguishing attackers from the
  legitimate owner of that account.
- Forward `Accept` and `Cache-Control` untouched and disable response buffering on
  `/resources/events`. That is the SSE stream; a buffering proxy stalls live updates.

HSTS, certificate renewal and redirect-to-https all belong to the proxy layer.

## Agent backends in the container

The image ships everything needed to run real agents: the Claude/Codex SDKs' native
linux binaries (installed by `npm ci` in the linux build stage) plus `git` and a CA
bundle in the runtime stage (a real run clones the task's repo and the coding agent
shells out to git). The container is stateless with no logged-in CLI, so credentials
are injected. **You can use a subscription (no per-token API key) for either backend:**

**Claude — Pro/Max subscription (recommended, one env var):**
1. On any machine with the `claude` CLI logged in: `claude setup-token` → prints a
   long-lived OAuth token (`sk-ant-oat01-…`).
2. Put it in the container's `.env`: `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…`.
The SDK authenticates with it — verified: an invalid token returns a 401, a valid one
runs. (An `ANTHROPIC_API_KEY` also works if you prefer pay-as-you-go.)

**Codex — ChatGPT Business/Enterprise subscription (recommended):**
1. In the ChatGPT workspace [Access tokens page](https://learn.chatgpt.com/docs/enterprise/access-tokens),
   create a Codex access token for this trusted deployment.
2. Put it in `.env` as `CODEX_ACCESS_TOKEN=…`. This is a ChatGPT-workspace
   credential that uses subscription entitlements, not a Platform API key.

The SDK passes the token to its bundled Codex CLI through the environment. No
host Codex directory is mounted. Treat the token as a secret, use a finite
expiration, and rotate it regularly.

**Codex — cached login for other ChatGPT plans:**
1. On the host, run `codex login` and confirm `~/.codex/auth.json` exists.
2. Copy only that credential into the dedicated container home:
   `mkdir -p ./docker-data/runtimes/codex-home && cp ~/.codex/auth.json ./docker-data/runtimes/codex-home/auth.json`.
3. Set `VIBERR_CODEX_USE_CLI_AUTH=1` in `.env`. `CODEX_HOME` points to that
   isolated directory on the existing `/data` mount, allowing refresh and session persistence
   without importing host config, MCP servers, rules, or skills. The files must
   be readable and writable by uid 1000 (the container's `node` user).

If the host uses an OS credential store instead of `auth.json`, configure
[Codex file credential storage](https://learn.chatgpt.com/docs/auth#credential-storage)
before logging in. A `CODEX_API_KEY` / `OPENAI_API_KEY` also works, but uses
usage-based Platform billing.

If `VIBERR_CODEX_USE_CLI_AUTH=1` is set but `$CODEX_HOME/auth.json` is missing
(and no access token/API key is configured), Viberr reports Codex **unavailable**.
There is no fallback engine: a run started on that backend fails fast with an
honest error and a blocked recovery packet, rather than starting a run that would
die with a redacted "Codex execution failed" line. Copy `auth.json` (step 2 above)
to enable real Codex runs.

**Security boundary:** the dedicated `CODEX_HOME` prevents importing the host's
full personal Codex configuration; it does not isolate that credential or the
application data from an autonomous coding process running as the same container
user. Treat the single-container setup as trusted-task mode. Untrusted tasks need
a separate worker user/container with only the task workspace mounted, plus
server-owned Git push/PR delivery so repository credentials never enter the
agent's environment.

Without any credential a backend is **unavailable**: starting a run on it fails fast
with an honest error run and a blocked recovery packet.
Confirm what's active:

```bash
curl -s localhost:${PORT:-3000}/resources/health | jq .backends
# {"claude":"real","codex":"unavailable"}   ← claude credential reached the container
```

`real` means the credential is present (SDK executes); it is not a validity check — an
invalid key surfaces as a failed run in the agent log, not here.

## First run

```bash
cp .env.example .env        # fill in the two required secrets
docker compose up -d --build
docker compose logs -f app  # watch the boot integrity log (dirs, migrations, counts)
```

- Migrations apply automatically at boot; no manual migrate step is needed.
- On an **empty** users table the bootstrap admin is created from `VIBERR_SEED_ADMIN_EMAIL`
  / `VIBERR_SEED_ADMIN_PASSWORD` (or a random password logged once).
- `docker compose exec app npm run seed` seeds the product baseline — the built-in agent
  catalog, knowledge bases, skills — and nothing else: no demo/mock board data. The board
  always starts as a clean sheet.
- Health: `GET /resources/health` → `{ ok, projections: { projects, tasks }, watcher }`.
  Compose has a healthcheck hitting it; container platforms should use it as the readiness
  probe.

## Persistence, backup & restore

Everything stateful lives under `./docker-data` in the Compose setup, mounted
at `/data`. Both SDKs keep their resumable state under `runtimes/`:

```
projects/   canonical project.md + task.md (the source of truth — human/agent editable)
agents/     agents/profiles/*.md — the seeded and org-edited agent profile templates
kb/ skills/ knowledge-base and skill files
runtimes/   raw run logs plus Claude/Codex session homes; Codex may contain auth.json
state/      projection.sqlite (users, sessions, projections, audit, PATs, notifications)
```

That is the whole set — created at boot from `DATA_ROOT_SUBDIRS` in
`app/server/files/file-store-root.server.ts`. There is no `auth/`, `cache/` or `logs/`
directory; application logs are structured JSON on stdout.

- **Backup** = snapshot the whole `./docker-data` directory, **including the
  `projection.sqlite-wal` and `-shm` sidecars whenever they are present**. SQLite runs in
  WAL mode. On a *clean* shutdown the app now checkpoints the WAL into the main file and
  closes it (`shutdownDatabase()` → `PRAGMA wal_checkpoint(TRUNCATE)`, armed at boot by
  `armProcessShutdown()`), which unlinks the sidecars — but you cannot assume that
  happened. A crash, `SIGKILL`, an OOM kill or power loss bypasses the handler; the
  checkpoint is best-effort and logs-and-continues if it fails; and a hot backup of a
  *running* container captures live `-wal` data by definition. In all of those cases
  committed rows — users, sessions, PATs — still live in the `-wal` file, so copying
  `projection.sqlite` alone can silently lose them. Stopping the container first gives you
  a quieter snapshot and, when the checkpoint succeeds, may leave no sidecars to copy at
  all — but it does not let you *skip* them: include them if they exist. If
  `runtimes/codex-home/auth.json` exists, the backup contains a live credential and must be
  encrypted and access controlled like any other secret.
- **Restore** = drop the directory back — sidecars included — and start the container.

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

## Upgrades

New app version → rebuild the image and `docker compose up -d`. Migrations apply at boot;
the data-root volume carries state across deploys. Roll back by redeploying the previous
image against the same volume (migrations are additive and forward-only — take a data-root
backup before a major upgrade).

## Scaling note

Single-node by design (SQLite + local file authority + in-process SSE bus). There is no
horizontal-scale story in V1; run one instance per data root. Vertical sizing is governed
by projection query volume and concurrent agent runs, both modest for small teams.
