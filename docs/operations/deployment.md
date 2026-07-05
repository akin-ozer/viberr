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

## Agent backends in the container

The image ships everything needed to run real agents: the Claude/Codex SDKs' native
linux binaries (installed by `npm ci` in the linux build stage) plus `git` and a CA
bundle in the runtime stage (a real run clones the task's repo and the coding agent
shells out to git). The container is stateless and has no logged-in CLI, so **auth is
purely credential-based — inject one env var**:

- **Claude** — set **`ANTHROPIC_API_KEY`**, or **`CLAUDE_CODE_OAUTH_TOKEN`** (generate
  once on any machine with `claude setup-token` using your Claude subscription, then put
  the token in the container's `.env`). Either flows to the SDK.
- **Codex** — set `CODEX_API_KEY` or `OPENAI_API_KEY`.

`VIBERR_CLAUDE_USE_CLI_AUTH` / `VIBERR_CODEX_USE_CLI_AUTH` are for hosts with an
already-logged-in CLI and are **not** useful in a fresh container — use a key/token there.

Without any credential the app falls back to the built-in **simulated** backend (runs
still stream in the UI, clearly labelled). Confirm what's active:

```bash
curl -s localhost:${PORT:-3000}/resources/health | jq .backends
# {"claude":"real","codex":"simulated"}   ← claude credential reached the container
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
  / `VIBERR_SEED_ADMIN_PASSWORD` (or a random password logged once). This is *not* the
  demo dataset.
- To load the demo org/projects/tasks (the mock content) into a fresh store:
  `docker compose exec app npm run seed`. Omit this for a clean production instance.
- Health: `GET /resources/health` → `{ ok, projections: { projects, tasks }, watcher }`.
  Compose has a healthcheck hitting it; container platforms should use it as the readiness
  probe.

## Persistence, backup & restore

Everything stateful lives under `$VIBERR_DATA_ROOT` (Compose mounts `./docker-data:/data`):

```
projects/   canonical project.md + task.md (the source of truth — human/agent editable)
kb/ skills/ knowledge-base and skill files
runtimes/   raw agent run logs (NDJSON/JSONL)
state/      projection.sqlite (users, sessions, projections, audit, PATs, notifications)
auth/ cache/ logs/
```

- **Backup** = snapshot the whole data-root directory. Stop the container (or accept a
  crash-consistent copy — SQLite is WAL, so also copy `*-wal`/`*-shm`) and archive it.
- **Restore** = drop the directory back and start the container. If only
  `state/projection.sqlite` is lost but `projects/` survives, you do **not** need a DB
  backup: the projections are derived — boot runs a reconciling rescan, or run a full
  rebuild (see the [runbook](./runbook.md)). Files are canonical; the DB is a cache.

## Upgrades

New app version → rebuild the image and `docker compose up -d`. Migrations apply at boot;
the data-root volume carries state across deploys. Roll back by redeploying the previous
image against the same volume (migrations are additive and forward-only — take a data-root
backup before a major upgrade).

## Scaling note

Single-node by design (SQLite + local file authority + in-process SSE bus). There is no
horizontal-scale story in V1; run one instance per data root. Vertical sizing is governed
by projection query volume and concurrent agent runs, both modest for small teams.
