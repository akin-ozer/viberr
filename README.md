# Viberr

Viberr is a multi-user web application for **governed AI software delivery**, built for
small AI-forward engineering teams that want persistent coding agents to do real delivery
work while engineers keep control of flow, review, and acceptance. It closes a coordination
gap: coding agents are improving fast, but task systems remain human-native and give
multi-agent work no durable operating layer. Viberr makes the task the canonical operating
contract between humans, agents, and GitHub execution — each task carries state, execution
context, timeline, decisions, and evidence in one readable markdown file. A dedicated
operator agent manages each active task, specialist agent threads do the stage work, and
humans govern through policy, comments, decisions, and explicit acceptance of completion.
Above the per-task operators sits one instance-wide CONTROLLER: a conversational agent
(`/controller`, and per project) that answers questions and performs governed actions
strictly within each asking user's own permission level, and that defines and advances
chained goals (one outcome decomposed into an ordered chain of tasks the server carries
forward as each link completes).

What makes it different: Viberr is agent-native in both action and responsibility. In
Jira-like tools humans are the default workers and AI helps at the edges; in Viberr agents
own task execution while engineers govern movement, approvals, and quality boundaries.
Canonical truth is **files, not the database**: projects and tasks live as markdown
(frontmatter + body) under a runtime data root that humans and agents may edit directly.
The app watches the files, parses tolerantly (malformed input becomes readable diagnostics,
never a crash), derives readiness, and materializes projections into SQLite for fast reads.
SQLite holds the projections plus app-management data — users, sessions, encrypted secrets,
audit, notifications, run history — never canonical business truth.

Stack: React Router 8 (framework mode, SSR) · Node >= 26 · TypeScript 7 · `node:sqlite` (WAL)
· Zod v4 · SSE for live updates (no websockets) · the ported `viberr.css` design system
(no Tailwind). Agent runtimes: Claude Agent SDK + Codex SDK — configure a credential for
at least one to run real agents. A backend with no credential is reported unavailable and
runs on it fail fast with an honest error.

**Status: pre-production.** Schema and file formats change without migrations or
back-compat.

## Documentation

Start at [`docs/README.md`](docs/README.md): a code-verified reference set (2026-09-01)
covering the product, architecture, every domain subsystem, operations, development and
the UI surfaces, plus the binding rulings in
[`docs/architecture/decisions.md`](docs/architecture/decisions.md). Agents working in this
repository should read [`AGENTS.md`](AGENTS.md) first.

## Quickstart (local dev)

Requirements: Node >= 26, npm.

```sh
git clone <this-repo> viberr && cd viberr

# 1. Environment — copy the documented template and fill in the two
#    required secrets:
cp .env.example .env
#    VIBERR_SESSION_SECRET       — generate: openssl rand -base64 48
#    VIBERR_SECRET_ENCRYPTION_KEY — generate: openssl rand -base64 32
#    (every other variable is optional; see .env.example and docs/operations/configuration.md)

# 2. Install
npm ci

# 3. Baseline data (migrations auto-apply at boot)
npm run seed

# 4. Run
npm run dev        # http://localhost:5173
```

Sign in as the bootstrap admin: `admin@viberr.dev` / `viberr-dev-2828` by default, or
set `VIBERR_SEED_ADMIN_EMAIL` / `VIBERR_SEED_ADMIN_PASSWORD` in `.env` before seeding.
The admin is created only while the users table is EMPTY — after that, manage users
in-app (Org settings).

The seed is a **clean sheet** — no demo/mock board data. It ships only the product
baseline: the built-in agent catalog (Operator, Developer, Reviewer profile templates),
knowledge bases with real files, skills, and the domain allowlist. Projects, tasks and
notifications start empty, and no run history is ever fabricated — agent runs only come
from real runs you start. `npm run seed -- --reset` wipes projects, agent profile
templates, org knowledge bases, skills and MCP server rows, runtime transcripts, user
prefs, scope violations and all derived state back to that clean sheet (users/auth,
GitHub connections and PATs, instance settings and the runtime credential homes survive).

Without `npm run seed`, an empty instance boots too: when the users table is empty the
server creates the same bootstrap admin at startup — set `VIBERR_SEED_ADMIN_EMAIL` /
`VIBERR_SEED_ADMIN_PASSWORD` in `.env`, or take the one-time generated password printed
to stdout (marked `VIBERR BOOTSTRAP ADMIN`; that account must set a new password at
first sign-in).

### All npm scripts

| script | what it does |
|---|---|
| `npm run dev` | dev server (port `PORT`, default 5173) |
| `npm run build` / `npm run start` | production build / serve it |
| `npm run lint` | oxlint with the vendored `anti-slop` plugin (`tools/oxlint/anti-slop`, config `.oxlintrc.json`) — a required CI gate; it must exit 0 |
| `npm run typecheck` | route typegen + tsc |
| `npm test` | vitest unit + integration suite (`app/**/*.test.{ts,tsx}`) |
| `npm run e2e` | playwright end-to-end suite against the production Docker image — CI's second job |
| `npm run seed` | idempotent baseline seed — agent catalog, KBs, skills, bootstrap admin; no demo data (`-- --reset` wipes board + derived state first); takes the writer lock |
| `npm run seed:demo` | test/dev-only: the mock demo board (arda & co, viberr-core) the e2e + route suites use; takes the writer lock |
| `npm run rescan` | reconcile projections with the file store; takes the writer lock |
| `npm run store:check` | read-only: list every canonical file the app cannot trust, with the offending line |
| `npm run backup` | consistent point-in-time backup (`VACUUM INTO` + store tree + manifest); no lock |
| `npm run restore -- --from <artefact> [--force] [--file <path>]` | whole-root or single-file restore |
| `npm run keys -- status \| reseal` | secret-key rotation status / finish |

Details for each: [`docs/development/scripts.md`](docs/development/scripts.md).

## Enabling real agent backends

Out of the box no agent backend is configured, so runs fail fast with an honest
"backend unavailable" error. To run agents you can use a
**subscription (no per-token API key)** or an API key; set it in `.env` and restart —
detection is presence-only, no paid call, re-checked on every probe:

- **Claude — Pro/Max subscription:** `claude setup-token` (once, on any logged-in
  machine) → `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…`. _(Or pay-as-you-go
  `ANTHROPIC_API_KEY=sk-ant-…`.)_
- **Codex — ChatGPT Business/Enterprise subscription (recommended for the
  container):** create a [Codex access token](https://learn.chatgpt.com/docs/enterprise/access-tokens)
  in the ChatGPT workspace and set `CODEX_ACCESS_TOKEN=…`. It uses workspace
  subscription entitlements—not Platform API billing—and requires no host
  `~/.codex` mount.
- **Codex — other ChatGPT plans:** run `codex login`, then copy only
  `~/.codex/auth.json` to `./docker-data/runtimes/codex-home/auth.json` and set
  `VIBERR_CODEX_USE_CLI_AUTH=1`. The dedicated runtime directory is already on
  the app's `/data` volume, so login refresh and resumable sessions persist
  without importing personal config, MCP servers, rules, or skills. _(Or use `CODEX_API_KEY` /
  `OPENAI_API_KEY` for usage-based Platform billing.)_

The dedicated Codex home avoids importing the host's full personal setup, but
it is not a security sandbox from autonomous coding runs in the same container.
For untrusted tasks, run Codex under a separate OS user/container with only the
task workspace mounted and keep delivery credentials in the server process.

Confirm what's live: `GET /resources/health` → `backends: { claude, codex }` reports
`real` vs `unavailable` — `real` means a credential is configured/detected (presence
only; an expired token still reads `real`), `unavailable` means runs on that backend fail
fast. New runs then stream real SDK output; raw NDJSON of every run is
persisted under `<data root>/runtimes/<backend>/`. Container specifics:
[`docs/operations/deployment.md`](docs/operations/deployment.md); how runs are confined:
[`docs/domain/agents-and-runtime.md`](docs/domain/agents-and-runtime.md).

## Enabling GitHub integration

Branch/PR traceability uses **user-provided GitHub tokens, encrypted at rest**
(AES-256-GCM with `VIBERR_SECRET_ENCRYPTION_KEY`).

1. Create a token on GitHub — *Settings → Developer settings → Fine-grained personal
   access token*, resource owner = the org/user owning the project repo, grant access to
   that repository, permissions: **Contents: Read and write** (branches),
   **Pull requests: Read and write** (PR link/status/merge), **Metadata: Read-only**
   (implied). A classic token with `repo` also works and validates more precisely; the
   required scope set is exactly `repo` + `pull_request:write`.
2. In Viberr: **Org settings → GitHub connections** → add the connection (the token is
   validated before anything is saved; validation never writes to your repository), then
   attach the repo in **Project settings → Repository**.
3. `VIBERR_SECRET_ENCRYPTION_KEY` can be rotated: set the old key in
   `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS`, run `npm run keys -- status` and
   `npm run keys -- reseal`, then drop the old key. Losing the key without a previous-key
   entry orphans stored tokens.

Branch and PR state refresh on their own: a background reconcile poller runs at boot and
then every 5 minutes over every branched project, so a PR merged or closed out-of-band
surfaces without anyone clicking. **Update status** on the GitHub view forces a refresh
now, and the page discloses how stale the cached state is.

Without a token everything degrades honestly (typed "no credential" states, never a crash).
Full pipeline: [`docs/domain/github-delivery.md`](docs/domain/github-delivery.md).

## Enabling OAuth sign-in

Optional; the login buttons stay disabled until a provider is configured. Providers are
configured **in the app** (Org settings → Sign-in & SSO, ruling 72) or seeded from env
(`GITHUB_OAUTH_CLIENT_ID/SECRET`, `GOOGLE_OAUTH_CLIENT_ID/SECRET`; in-app rows win).
Sign-in is whitelist-based: it succeeds only for emails that already have a
(non-disabled) Viberr user row — plus, for Google, domains added to the org allowlist
(those provision on first login). Behind a proxy set `BETTER_AUTH_URL` to the public
https origin.

- **GitHub**: OAuth app with callback `https://<host>/api/auth/callback/github`
  (scopes `read:user user:email`).
- **Google**: OAuth web client with redirect `https://<host>/api/auth/callback/google`
  (scopes `openid email profile`, PKCE).

## Docker

```sh
cp .env.example .env            # fill in the two required secrets
docker compose run --rm app npm run seed   # optional baseline, BEFORE the app holds the lock
docker compose up --build -d
```

The app listens on `PORT` (container default 3000; compose maps the same port on the
host) and speaks **plain HTTP** — for anything beyond localhost, front it with a
TLS-terminating reverse proxy, set `BETTER_AUTH_URL` to the public https origin and
`VIBERR_TRUST_PROXY=1`. Skipping the proxy gives you a silent login loop, not an
insecure-but-working app; the deployment guide explains why. All state lives in the
volume mounted at `/data` (`./docker-data` by default). Back it up with `npm run backup`
(a raw copy of the live SQLite file misses rows still in the WAL) and keep
`VIBERR_SECRET_ENCRYPTION_KEY` with the backup. `npm run seed` against a running
container is **refused**: it would be a second writer on the data root. The compose file
wires a liveness healthcheck against `/resources/health` and `restart: unless-stopped`.
See [docs/operations/deployment.md](docs/operations/deployment.md) for the full
single-node story (TLS, backup/restore, projection rebuild, the writer lock) and
[docs/operations/runbook.md](docs/operations/runbook.md) for day-2 operations.

## Health endpoint

`GET /resources/health` is an unauthenticated ops probe. It returns `200` with
`{ ok, status, degraded, projections: { projects, tasks }, watcher, kbWatcher, lock,
backends, browser, disk, maintenance, build }` — `watcher` / `kbWatcher` report whether
the file-store and knowledge-base watchers are alive, `lock: { pid, hostname, startedAt }`
names the process holding the single-writer lock on this data root (one app process per
data root, ever), `backends: { claude, codex }` reports `real`/`unavailable` per runtime
(see [Enabling real agent backends](#enabling-real-agent-backends)), `disk` carries the
free-space status and `maintenance` the last retention pass. The bare URL is a liveness
probe (`200` even when `status: "degraded"`); `?probe=readiness` returns `503` while
anything is degraded. It returns `503` with `{ ok: false, status: "down" }` if the
database cannot be read.

## Project layout

```
app/
  routes/          # thin route modules (loaders/actions), one per surface
  features/        # per-surface UI: activity, agents, board, controller,
                   # github, home, insights, kb-browser, live-updates,
                   # notifications, org-settings, policy, profile,
                   # project-settings, review, runtime, shell, task-detail
  ui/              # reusable primitives (icon, pill, toast, rich-text, dialog hooks…)
  lib/             # better-auth server instance + its Viberr bridge
  server/          # server-only: actions, agents, audit, auth, config, controller,
                   # db, errors, events, files, github, insights, interpretation,
                   # logging, ops, org, prefs, projections, provenance, runtimes,
                   # secrets, seed, settings, tasks, theme + boot.server.ts
  schemas/         # shared Zod schemas (task file, project file, goal file, SSE events…)
  shared/          # cross-surface helpers (auth, capabilities, dates, docs,
                   # freshness, ids, mapping, rbac, text, workflow)
  app.css          # the ported viberr.css design system + marked additions
db/migrations/     # one squashed SQL baseline (auto-applied at boot)
scripts/           # seed, seed-demo, rescan, store-check, backup, restore, secret-keys,
                   # e2e (tsx) + docker-entrypoint.sh + measure-routes.mjs
e2e/               # playwright specs
test-support/      # app/db/store/runtime/github fakes for vitest
tools/oxlint/      # the vendored anti-slop lint plugin
docs/              # the code-verified documentation set (start at docs/README.md)
planning/          # PRD, original architecture and UX canon + pass ledgers
design/            # HTML mock, design system, PRD mirror (pinned by test)
data/ | docker-data/   # runtime data root (gitignored): projects/<slug>/tasks/<KEY>/task.md,
                   # projects/<slug>/goals/<id>.md, agents/, runtimes/, kb/, skills/,
                   # audit-exports/, state/projection.sqlite
```

There is no `features/auth` — sign-in lives in `app/routes/login.tsx` plus
`app/server/auth/` and `app/lib/auth.server.ts`. The data root's base directories are
created at boot from `DATA_ROOT_SUBDIRS` in
[`app/server/files/file-store-root.server.ts`](app/server/files/file-store-root.server.ts);
`audit-exports/`, per-task `workspace/` and `attachments/` and per-project `.repo-mirror/`
appear when first written. Nothing writes a `logs/` or `auth/` directory (application logs
are structured JSON on stdout).

## Architecture

The code-verified description of the system is
[`docs/architecture/overview.md`](docs/architecture/overview.md), with the module map in
[`docs/architecture/codebase-map.md`](docs/architecture/codebase-map.md) and the storage
model in [`docs/architecture/data-model.md`](docs/architecture/data-model.md). The
original planning artifacts are the [PRD](planning/planning-artifacts/prd.md) (canon for
requirements; status per requirement in
[`docs/product/requirements-status.md`](docs/product/requirements-status.md)),
[architecture](planning/planning-artifacts/architecture.md) and
[UX specification](planning/planning-artifacts/ux-design-specification.md). Canonical
project/task file formats and timeline grammar live in
[`docs/architecture/file-formats.md`](docs/architecture/file-formats.md), and the binding
conventions and numbered rulings that code comments cite are in
[`docs/architecture/decisions.md`](docs/architecture/decisions.md).

## Known gaps (V1 release notes)

Deliberate scope boundaries, documented rather than half-built (re-verified 2026-09-01):

- **No mailer.** Notifications are in-app only (the profile has a real in-app opt-out
  toggle, not email/nudge preferences). Whitelisted users don't get an email — admins
  hand over the one-time password shown at creation.
- **Org audit browse is minimal.** Org settings shows the newest 150 org-scoped audit
  rows and offers CSV/JSON download (100 000-row cap) and an S3 push, but there is no
  filtering or paging in the browse view; project-scoped audit has the fuller UI
  (Activity → Audit logs).
- **Retention windows are compile-time constants.** Run log lines are deleted after 30
  days, audit events after 90 (each expiring row is first exported to
  `<data root>/audit-exports/*.jsonl`), and notifications are trimmed to the newest 500
  per user; the pass runs at boot, every 6 hours and on disk pressure. Only the
  transcript and session-home windows are env-configurable.
- **Several tables have no retention.** `provenance` grows fastest; `session`,
  `agent_runs`, `goal_projections`, `controller_messages`, `scope_violations` and
  `model_availability` are also never pruned. See the runbook for pruning by hand.
- **No cleartext-transport guard in the app itself.** The Node process serves plain HTTP
  and ships no proxy; encryption in transit (NFR6) is the deployment's job. Boot warns
  when a production origin would issue insecure cookies. Put a TLS-terminating reverse
  proxy in front and set `BETTER_AUTH_URL` — see
  [docs/operations/deployment.md](docs/operations/deployment.md#tls-and-the-reverse-proxy).
- **Notifications page caps at the newest 200 rows** (no pagination).
- **Fine-grained PAT validation is partly assumed** — GitHub doesn't expose fine-grained
  permissions in headers, so `pull_request:write` reports "assumed" until first use
  unless the opt-in write probe (`VIBERR_GITHUB_WRITE_PROBE=1`) is enabled (documented in
  the credential card).
- **Codex runs receive MCP servers without credentials** (argv exposure); a bearer-token
  HTTP MCP is unauthenticated on Codex. Disclosed in the capability matrix.

## Capstone test

This change was delivered by a Viberr agent during pass-12 live testing.
