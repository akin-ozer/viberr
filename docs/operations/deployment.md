# Deployment — single-node Docker

Viberr is a single-node, self-hosted monolith: one Node process serving the SSR app,
SSE live updates, and an embedded SQLite database. Project/task/profile/KB/skill truth is
file-native; SQLite owns both derived projections and non-rebuildable app state such as identity,
sessions, encrypted GitHub/MCP secrets, audit, notifications, org metadata, runtime rows, and the
automatic-operator dispatch queue. There is no external database, cache, or queue to run.

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
`VIBERR_SECRET_ENCRYPTION_KEY` encrypts stored GitHub PATs and organization secrets referenced by
MCP authentication mappings; **losing or rotating it makes those values undecryptable** (admins
must delete and re-add them).

Optional integrations, enabled only when their vars are present:
`GITHUB_OAUTH_*` / `GOOGLE_OAUTH_*` (OAuth sign-in), `VIBERR_SEED_ADMIN_*` (bootstrap
admin on first boot of an empty DB), and the agent backends below.

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

**Execution boundary:** the dedicated `CODEX_HOME` prevents importing the host's
full personal Codex configuration; it does not isolate that credential or the
application data from an autonomous coding process running as the same container
user. Treat the single-container setup as trusted-task mode. Untrusted tasks need
a separate worker user/container with only the task workspace mounted, plus
the server-owned Git push/PR delivery Viberr already uses so repository credentials never enter
the agent's environment. Viberr verifies the exact remote SHA and a non-empty comparison before it
opens/reuses the task PR.

Without any credential the app falls back to the built-in **simulated** backend (runs
still stream in the UI, clearly labelled). Simulated rows are demonstration output only:
they do not satisfy delivery, reviewer approval, backend-health, or completion evidence.
Confirm configuration and recent real-run evidence:

```bash
curl -s localhost:${PORT:-3000}/resources/health | jq .backends
# {
#   "claude":{"status":"verified","configured":true,"verified":true,...},
#   "codex":{"status":"unconfigured","configured":false,"verified":false,...}
# }
```

The states are `unconfigured`, `unknown`, `verified`, and `degraded`. Configuration is a
credential/CLI-auth presence check. Only a recent real run supplies the verified/degraded signal;
the health request never probes or spends a provider call.

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
- Health: `GET /resources/health` →
  `{ ok, integrity, projections: { projects, tasks }, watcher, backends }`. A structural SQLite
  failure returns 503 with `integrity.recoveryRequired=true`. Compose has a healthcheck hitting it;
  container platforms should use it as the readiness probe.

## Automatic operator limits

Task creation and lifecycle transitions enqueue durable, coalesced operator dispatches. A new task
whose goal is still the generated placeholder is recorded as awaiting input without starting a paid
turn. Defaults are two automatic operator runs at once, a rolling one-dollar observed/estimated
hourly budget, and a five-cent reservation per queued run. Deployments may tighten them with
`VIBERR_OPERATOR_AUTO_CONCURRENCY`, `VIBERR_OPERATOR_AUTO_HOURLY_BUDGET_USD`, and
`VIBERR_OPERATOR_AUTO_ESTIMATED_RUN_USD`. Queued/running dispatches recover at boot.

## Persistence, backup & restore

Everything stateful lives under `./docker-data` in the Compose setup, mounted
at `/data`. Both SDKs keep their resumable state under `runtimes/`:

```
projects/   canonical project.md + task.md (the source of truth — human/agent editable)
kb/ skills/ knowledge-base and skill files
runtimes/   raw run logs plus Claude/Codex session homes; Codex may contain auth.json
state/      projection.sqlite (users, sessions, projections, audit, PATs, notifications)
auth/ cache/ logs/
```

- **Backup** = snapshot the whole `./docker-data` directory. If `runtimes/codex-home/auth.json`
  exists, the backup contains a live credential and must be encrypted and access
  controlled like any other secret. Stop the container (or accept a
  crash-consistent copy — SQLite is WAL, so also copy `*-wal`/`*-shm`) and archive it.
- **Restore** = drop the complete directory back and start the container. Losing
  `state/projection.sqlite` is not merely losing a cache: users, sessions, secrets, audit, org
  resources, notifications, and dispatch state are app-owned there. Surviving project/task files
  let Viberr reconstruct only those projections after identity and member references are repaired.
  Prefer a complete backup; see the [runbook](./runbook.md) before attempting recovery.

## Upgrades

New app version → take a complete stopped data-root backup, rebuild the image, and follow that
release's compatibility note. Do not assume an older image can safely open a database touched by a
newer image.

This 2026-07-13 development correction intentionally edits canonical migration files without a
backward-compatibility layer. For its demo/validation store, stop Compose, preserve the SQLite/WAL/SHM
trio, move that trio out of `docker-data/state/`, rebuild, and run
`docker compose run --rm app npm run seed`. That creates a fresh migrated DB and destructively
recreates demo canonical/resource state. It is not a production restore procedure.

## Scaling note

Single-node by design (SQLite + local file authority + in-process SSE bus). There is no
horizontal-scale story in V1; run one instance per data root. Vertical sizing is governed
by projection query volume and concurrent agent runs, both modest for small teams.
