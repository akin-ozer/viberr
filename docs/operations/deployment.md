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
`VIBERR_SECRET_ENCRYPTION_KEY` encrypts stored GitHub PATs and MCP credentials;
**losing it makes existing encrypted tokens undecryptable** (users must re-add PATs).
Rotating is supported and finishable: set `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` to
the old key, run `npm run keys -- status` (read-only, works on a live instance) to see
how many secrets still open only under it, `npm run keys -- reseal` to move them, and
drop the previous key once status reports none. Without that count there is no moment
at which removing the old key is known to be safe.

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
- Seed BEFORE the app starts (or stop it first) — `npm run seed` takes the
  single-writer lock and refuses against a running container.
  `npm run seed` seeds the product baseline — the built-in agent
  catalog, knowledge bases, skills — and nothing else: no demo/mock board data. The board
  always starts as a clean sheet.
- Health: `GET /resources/health` →
  `{ ok, projections: { projects, tasks }, watcher, kbWatcher, lock, backends }`.
  Compose has a healthcheck hitting it; container platforms should use it as the readiness
  probe. *(Field list corrected 2026-08-06, pass 19 — `kbWatcher`, `lock` and `backends`
  ship and were missing here, though `lock` and `backends` are both documented below.)*

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

- **Backup** = `npm run backup` (add `--out <dir>`). It writes a timestamped artefact
  containing a genuine point-in-time `projection.sqlite` — taken with `VACUUM INTO` from a
  read-only connection, so it folds in WAL content and lands as ONE file with no sidecars —
  plus the canonical markdown tree, and a `MANIFEST.json` recording byte size, sha256 and
  the row counts read back out of the artefact. It does **not** take the writer lock: a
  backup that refused to run on a live instance would be no backup at all.

  Read the artefact's own README for what it excludes. Two exclusions matter most:
  `runtimes/` (live agent logins — opt in with `--include-runtimes`, and then treat the
  artefact as a secret), and **`VIBERR_SECRET_ENCRYPTION_KEY` itself**, which lives in the
  environment. Without that key every sealed PAT and MCP credential in the backed-up
  database is unreadable, so back the key up separately.

  The older advice — copy `./docker-data` wholesale, being careful to include the
  `-wal`/`-shm` sidecars — still works, but it is exactly the trap `VACUUM INTO` removes:
  a hot copy of `projection.sqlite` alone silently loses every committed row still living
  in the WAL.

- **Restore** = `npm run restore -- --from <artefact>`. Whole-root restore takes the writer
  lock, requires `--force` if the root is occupied, and *moves* displaced data aside rather
  than deleting it. To recover a single hand-broken canonical file without touching the
  database: `npm run restore -- --from <artefact> --file projects/<slug>/tasks/<KEY>/task.md`
  — the broken bytes are kept beside it as `task.md.broken-<ts>`.

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

## Re-baselining the projection database

Boot's integrity line is followed by a `projection schema drift` **WARN** when this
database's `task_projections` CHECK constraints no longer admit every value the running
build produces (F21-1). It names what the CHECK `refuses`. Migrations are squashed into
`0001_baseline.sql` and forward-only, so widening a CHECK changes what a **fresh**
`projection.sqlite` gets and nothing else — a root opened by an older build keeps the
constraint it was created with, and every task whose derived value lands on a refused
member stops projecting behind a generic `projection rebuild failed`.

The remedy is to recreate the file:

```bash
npm run backup                       # FIRST — see the cost below
docker compose down                  # one writer per root; never delete state while it runs
rm ./docker-data/state/projection.sqlite*   # -wal and -shm too
docker compose up -d                 # migrations re-apply, projections rebuild from projects/
```

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
backup before a major upgrade).

## Scaling note

Single-node by design (SQLite + local file authority + in-process SSE bus). There is no
horizontal-scale story in V1; run one instance per data root. Vertical sizing is governed
by projection query volume and concurrent agent runs, both modest for small teams.

## Single-writer safety (B-FD1 / F18-5)

**One app process per data root, EVER.** Two processes pointed at one root corrupts the
SQLite WAL and silently loses transactions — `PRAGMA integrity_check` does NOT detect the
loss. Boot takes an exclusive `state/writer.lock`; a second process refuses to boot naming
the holder. As of F18-5 the holder also re-verifies ownership on a 20 s timer and **fails
closed** (loud `logger.error` + `process.exit(1)`) the moment its lock file is deleted or
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
