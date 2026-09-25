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
· Zod v4 · SSE for live updates (no websockets) · one stylesheet, `app/app.css`, the
ported `viberr.css` design system set in Inter (no Tailwind). Agent runtimes: Claude
Agent SDK + Codex SDK. Each person connects their own Claude and Codex accounts on
Profile → Agent accounts (ruling 127), and every run bills exactly one person: the task
owner on a task, the asker on a controller conversation. A backend nobody connected simply has no runs; a run whose principal has
not connected it fails fast with an honest error and starts no process.

**Status: pre-production.** Schema and file formats change without migrations or
back-compat.

## Documentation

Start at [`docs/README.md`](docs/README.md): a code-verified reference set covering the
product, architecture, every domain subsystem, operations, development and
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
in-app (Instance settings → Users & access).

`.env.example` sets `VIBERR_DATA_ROOT=./docker-data`, the store `npm run dev` uses (unset,
the root defaults to `./data`). The container's store is the named volume `viberr-data`
(ruling 460), so the two no longer share one; `npm run store:to-volume` moves an older
`./docker-data` store into the volume once. One app process per data root: the writer lock
refuses a second one, and refuses a seed while the app runs.

The seed is a **clean sheet** — no demo/mock board data. It ships only the product
baseline: the built-in agent catalog (Operator, Developer, Reviewer profile templates),
knowledge bases with real files, skills, and the domain allowlist. Projects, tasks and
notifications start empty, and no run history is ever fabricated — agent runs only come
from real runs you start. `npm run seed -- --reset` wipes projects, agent profile
templates, org knowledge bases, skills, MCP server rows and the Google domain allowlist,
runtime transcripts, user prefs, scope violations and all derived state back to that
clean sheet, then re-seeds the baseline (users/auth, GitHub connections and PATs,
instance settings and every person's connected agent accounts, including their runtime
homes under `runtimes/users/`, survive).

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
| `npm run deploy [-- --no-up]` | Docker deployment: stamp the build from git, `docker compose build`, `up -d`, then read `/resources/health` back and fail unless the running build is the one just made (ruling 345) |

Details for each: [`docs/development/scripts.md`](docs/development/scripts.md).

## Enabling real agent backends

There is nothing to put in `.env` (ruling 127). **Every person connects Claude and Codex
for themselves**, in the app, on **Profile → Agent accounts**. Every agent run then bills
exactly one person: a run on a task uses the **task owner's** accounts, and a controller
conversation uses the **asker's** Claude account. A task with no owner cannot run agents;
it says so and starts no process.

Each backend card offers a hosted sign-in and a pasted credential:

- **Claude:** "Sign in with Claude" (a Claude Pro/Max subscription) or "Sign in with
  Console", both driven through the unmodified bundled `claude` binary, or paste a Console
  API key (`sk-ant-…`).
- **Codex:** "Sign in with ChatGPT", a device-code sign-in through the bundled `codex`
  binary, or paste an OpenAI Platform API key, or paste a ChatGPT **workspace access
  token** (workspace entitlements rather than Platform billing; stored unverified, because
  there is no free way to check one).

**Viberr never stores your sign-in tokens.** It does not implement the vendors' OAuth,
never reads or copies a Claude.ai or ChatGPT session token, and offers no "paste your
setup-token" field. Anthropic's [Claude Code legal and compliance
page](https://code.claude.com/docs/en/legal-and-compliance) requires a platform that hosts
Claude Code to have each end user authenticate with their own credentials, billed to them,
and forbids apps from collecting or storing Claude.ai credentials. So a hosted sign-in is
run by the vendor's own binary and the credential it writes stays in that person's runtime
home on this server, at `/data/runtimes/users/<userId>/claude-home/` or
`.../codex-home/` in the store (a directory Viberr creates and hands to that person's own
agent user, ruling 460, and nothing else about that file). A pasted key is sealed with `VIBERR_SECRET_ENCRYPTION_KEY`
in the database, is never shown again (only its last 4 characters), and reaches only the
child process of a run that person's account is paying for; the run sink redacts it from
every persisted log line.

The device-code sign-in for Codex is what OpenAI ships for headless machines, and some
ChatGPT workspaces have it switched off. If the card reports that device code
authorization is not enabled, ask your ChatGPT workspace admin to enable it, or paste an
API key or a workspace access token instead.

Those runtime homes live on the `/data` volume, so sign-ins and resumable sessions survive
a container restart. Wiping the volume signs everyone out: the card then reads "sign-in
file missing" and the person signs in again. A runtime home is not a security sandbox from
an autonomous coding run in the same container. For untrusted tasks, run agents under a
separate OS user or container with only the task workspace mounted, and keep delivery
credentials in the server process.

Confirm what's live: `GET /resources/health` reports `backends: { claude: { connectedUsers
}, codex: { connectedUsers } }`, a count of the people on this instance who have connected
that backend. Zero is a normal reading, never a fault: it means nobody has connected it
yet. It is still not a validity check. Whether a particular run can start is a fact about
its own principal, shown on the task page and the Agents page. New runs stream real SDK
output; raw NDJSON of every run is persisted under `<data root>/runtimes/<backend>/`.
Container specifics: [`docs/operations/deployment.md`](docs/operations/deployment.md); how
runs are confined:
[`docs/domain/agents-and-runtime.md`](docs/domain/agents-and-runtime.md).

## Enabling GitHub integration

Branch/PR traceability uses **user-provided GitHub tokens, encrypted at rest**
(AES-256-GCM with `VIBERR_SECRET_ENCRYPTION_KEY`).

1. Create a token on GitHub — *Settings → Developer settings → Fine-grained personal
   access token*, resource owner = the org/user owning the project repo, grant access to
   that repository, permissions: **Contents: Read and write** (branches),
   **Pull requests: Read and write** (PR link/status/merge), **Metadata: Read-only**
   (implied). A classic token with `repo` also works and validates more precisely; the
   required scope set is exactly `repo` + `pull_request:write`. To let Viberr create a
   project's repository for you (ruling 462), a fine-grained token also needs
   **Administration: Read and write** with access to All repositories; without it,
   create the repository on GitHub first.
2. In Viberr: **Instance settings → GitHub connections** → add the connection (the token
   is validated before anything is saved; validation never writes to your repository),
   then attach the repo in **Project settings → Repository & credentials**.
3. `VIBERR_SECRET_ENCRYPTION_KEY` can be rotated: set the old key in
   `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS`, run `npm run keys -- status` and
   `npm run keys -- reseal`, then drop the old key. Losing the key without a previous-key
   entry orphans stored tokens.

Branch and PR state refresh on their own: a background reconcile poller runs at boot and
then every 5 minutes over every active project with task branches, so a PR merged or
closed out-of-band surfaces without anyone clicking. It skips tasks in a terminal stage
such as Done (ruling 177). **Update status** on the GitHub view forces a refresh now,
and the page discloses how stale the cached state is.

Without a token everything degrades honestly (typed "no credential" states, never a crash).
Full pipeline: [`docs/domain/github-delivery.md`](docs/domain/github-delivery.md).

## Enabling OAuth sign-in

Optional; the login buttons stay disabled until a provider is configured. Providers are
configured **in the app** (Instance settings → Sign-in & SSO, ruling 72) or seeded from env
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
docker compose up --build -d    # or: npm run deploy (stamps the build, then verifies it)
```

The app listens on `PORT` (container default 3000; compose maps the same port on the
host) and speaks **plain HTTP** — for anything beyond localhost, front it with a
TLS-terminating reverse proxy, set `BETTER_AUTH_URL` to the public https origin and
`VIBERR_TRUST_PROXY=1`. Skipping the proxy gives you a silent login loop, not an
insecure-but-working app; the deployment guide explains why. All state lives in the
volume mounted at `/data` (the named volume `viberr-data`), including each person's
connected agent accounts under `runtimes/users/`. Every agent process runs as its person's
own OS user and cannot read the server's secrets, the database or anyone else's sign-in
(ruling 460); `/resources/health` reports it as `agentIsolation`. Back it up with `npm run backup` (a raw copy of
the live SQLite file misses rows still in the WAL; inside the container pass an absolute
`--out` outside `/data` and copy the artefact out, as the deployment guide shows) and
keep `VIBERR_SECRET_ENCRYPTION_KEY` with the backup; the default backup leaves
`runtimes/` out because it holds live sign-ins. A restore leaves an existing `runtimes/`
untouched, so people sign in again only when it is gone (a fresh volume), unless the
backup was taken with `--include-runtimes`; treat such an artefact as a secret.
`npm run seed` against a running
container is **refused**: it would be a second writer on the data root. The compose file
pins `hostname: viberr` (so a recreated container can reclaim its own writer lock), runs
an init (`init: true`), caps the container at `cpus: "7"` (tune it to your host), and
wires a liveness healthcheck against `/resources/health` and `restart: unless-stopped`.
See [docs/operations/deployment.md](docs/operations/deployment.md) for the full
single-node story (TLS, backup/restore, projection rebuild, the writer lock) and
[docs/operations/runbook.md](docs/operations/runbook.md) for day-2 operations.

## Health endpoint

`GET /resources/health` is an unauthenticated ops probe. It returns `200` with
`{ ok, status, degraded, projections: { projects, tasks }, projectionStore, watcher,
kbWatcher, lock, backends, browser, disk, maintenance, build, quota, toolchain }` —
`degraded` names the failing subsystems, `projectionStore` latches a projection rebuild
that failed, `watcher` / `kbWatcher` report whether the file-store and knowledge-base
watchers are alive, `lock: { pid, hostname, startedAt }` names the process holding the
single-writer lock on this data root (one app process per data root, ever),
`backends: { claude: { connectedUsers }, codex: { connectedUsers } }` counts the people
who have connected that backend (zero is a normal reading, not a fault; see
[Enabling real agent backends](#enabling-real-agent-backends)), `disk` carries the
free-space status, `maintenance` the last retention pass, `build` the stamped version,
revision and build time, `quota` the latest provider rate-limit readings (never a
verdict), and `toolchain` the versions of the tools an agent's shell finds. The bare URL
is a liveness probe (`200` even when `status: "degraded"`); `?probe=readiness` returns
`503` while anything is degraded. It returns `503` with `{ ok: false, status: "down" }`
if the database cannot be read. What each field means and what to do about it:
[`docs/operations/runbook.md`](docs/operations/runbook.md#health--liveness).

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
                   # freshness, ids, mapping, rbac, text, workflow, …)
  app.css          # the ported viberr.css design system + marked additions
db/migrations/     # one squashed SQL baseline (auto-applied at boot)
scripts/           # seed, seed-demo, rescan, store-check, backup, restore, secret-keys,
                   # deploy, e2e (tsx) + measure-routes.mjs, anti-slop-manifest.mjs
e2e/               # playwright specs + the auth setup
test-support/      # vitest setup and harnesses: db/store/app, fake runtime, fake GitHub
                   # and local git origin, fake vendor binaries, demo fixture
tools/oxlint/      # the vendored anti-slop lint plugin + its pinned manifest
tools/viberr-launch/ # the setuid agent launcher the image compiles (ruling 460)
docs/              # the code-verified documentation set (start at docs/README.md)
planning/          # PRD, original architecture and UX canon + pass ledgers
design/            # HTML mock, design system, PRD mirror (pinned by test)
qa/, test-artifacts/   # notes and captured evidence from live QA passes
data/ | docker-data/   # runtime data root (gitignored): projects/<slug>/tasks/<KEY>/task.md,
                   # projects/<slug>/goals/<id>.md, agents/, runtimes/ (incl.
                   # runtimes/users/<userId>/ per-person agent homes), kb/, skills/,
                   # audit-exports/, state/projection.sqlite
```

There is no `features/auth` — sign-in lives in `app/routes/login.tsx` plus
`app/server/auth/` and `app/lib/auth.server.ts`. The data root's base directories are
created at boot from `DATA_ROOT_SUBDIRS` in
[`app/server/files/file-store-root.server.ts`](app/server/files/file-store-root.server.ts)
(`projects`, `agents/profiles`, `runtimes/users`, `kb`, `skills`, `audit-exports`,
`state`); per-task `workspace/` and `attachments/`, per-project `.repo-mirror/` and each
person's `runtimes/users/<userId>/` home appear when first written. Nothing writes a
`logs/` or `auth/` directory (application logs are structured JSON on stdout).

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

Deliberate scope boundaries, documented rather than half-built (verified against `main` @
`7d9fbf72`, 2026-09-23):

- **No mailer.** Notifications are in-app only (the profile has a per-category in-app
  opt-out, no email or nudge channel; ruling 13). Whitelisted users don't get an email —
  admins hand over the one-time password shown at creation.
- **Instance audit browse is minimal.** Instance settings shows the newest 150 audit rows,
  with an Org-scoped toggle that reads its own newest 150 instance-level rows (the reconcile
  poller's `github.reconcile.task` heartbeat is left out of the browse, ruling 234), and
  offers CSV/JSON download (100 000-row cap) and an S3 push. The browse view's text filter
  searches only the loaded window; there is no server-side query or paging.
  Project-scoped audit has the fuller UI (Activity → Audit logs).
- **Retention windows are compile-time constants.** Run log lines are deleted after 30
  days, audit events after 90 (each expiring row is first exported to
  `<data root>/audit-exports/*.jsonl`), and notifications are trimmed to the newest 500
  per user; the pass runs at boot, every 6 hours (`VIBERR_MAINTENANCE_INTERVAL_SECONDS`) and
  on disk pressure. Only the transcript and session-home windows
  (`VIBERR_TRANSCRIPT_RETENTION_DAYS`, `VIBERR_SESSION_HOME_RETENTION_DAYS`) are
  env-configurable.
- **Several tables have no retention.** `provenance` grows fastest; `session`,
  `agent_runs`, `goal_projections`, `controller_messages`, `scope_violations` and
  `model_availability` are also never pruned. See the runbook for pruning by hand.
- **No cleartext-transport guard in the app itself.** The Node process serves plain HTTP
  and ships no proxy; encryption in transit (NFR6) is the deployment's job. Boot warns
  when a production origin would issue insecure cookies. Put a TLS-terminating reverse
  proxy in front and set `BETTER_AUTH_URL` — see
  [docs/operations/deployment.md](docs/operations/deployment.md#tls-and-the-reverse-proxy).
- **Notifications page caps at the newest 200 rows** (no pagination; the page says when
  it is truncated).
- **Fine-grained PAT validation is partly assumed** — GitHub doesn't expose fine-grained
  permissions in headers, so `pull_request:write` reports "assumed" until first use
  unless the opt-in write probe (`VIBERR_GITHUB_WRITE_PROBE=1`) is enabled (documented in
  the credential card).
- **Codex runs receive MCP servers without credentials** (argv exposure); a bearer-token
  HTTP MCP is unauthenticated on Codex. Disclosed in the capability matrix.
