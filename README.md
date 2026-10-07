# Viberr

[![CI](https://github.com/akin-ozer/viberr/actions/workflows/ci.yml/badge.svg)](https://github.com/akin-ozer/viberr/actions/workflows/ci.yml)

**Governed AI software delivery for small engineering teams.** Viberr is a self-hosted,
multi-user workspace where persistent coding agents do the delivery work and engineers
keep control of the flow, the review and the decision to ship.

Coding agents are getting good fast, but task trackers are still built for humans: the
human does the work and AI helps at the edges. Agent work run through scattered chats,
branches and status labels cannot be governed. Viberr turns that around. Agents own task
execution. Engineers own movement, approvals and quality boundaries. Each task is one
readable markdown file, and that file is the contract between people, agents and GitHub.

## What you get

- **A board that agents work.** Tasks move through your project's stages (Triage →
  Ready → In Progress → Review → Done by default, editable per project). Each boundary
  says whether the agent may cross it on its own, must ask, or must leave the move to a
  person.
- **An Operator on every task.** It scopes the goal, dispatches specialist agents
  (Developer, Reviewer, or any agent you define), opens a *decision packet* when a person
  has to choose, and decides when the work is ready to deliver. It never writes code and
  never pushes by hand.
- **Specialists in isolated workspaces.** Each run gets its own git checkout, the
  skills, knowledge bases and MCP servers its profile is granted, and an optional
  headless browser. On Claude or Codex, through the official SDKs.
- **GitHub delivery with people in charge.** The server pushes the task's branch and
  opens the pull request. Reviewer verdicts are bound to the revision they reviewed, a
  reconciler keeps PR state current, and moving a task to Done, which merges, stays a
  human decision.
- **Boards that deliver results, not code.** A task's deliverable can be the files its
  agent saves on it (an estimate, a report), reviewed and accepted with no repository.
- **A controller for the whole instance.** A conversational agent docked on every page
  that answers questions and acts for you, with exactly your own permissions. It can plan
  work into **epics**.
- **Governance you can audit.** Human roles (RBAC) and agent capabilities are separate
  policies. Every governed action writes an audit row and a typed timeline event. People
  get in-app notifications when they are needed, and everything updates live over SSE.
- **Files are the truth.** Projects, tasks and epics are markdown under a data root you
  can read, grep and edit by hand. The app watches the files, parses them tolerantly (a
  malformed file becomes a readable diagnostic, never a crash) and projects them into
  SQLite for fast reads.
- **Everyone pays for their own agents.** Each person connects their own Claude or Codex
  account. A run bills the task's owner, or the asker for the controller. Viberr never
  stores vendor sign-in tokens.

## Quickstart

You need Docker with Compose 2.24 or newer.

```sh
git clone https://github.com/akin-ozer/viberr.git && cd viberr
docker compose up
```

That is the whole install: no `.env` to write and no volume to create (ruling 504). Open
<http://localhost:3000> and sign in as `admin@viberr.dev` with the one-time password the log
prints on the line marked `VIBERR BOOTSTRAP ADMIN`. You choose your own password at first
sign-in.

Home then shows **Finish setting up**, the steps this instance still needs, each linking
to where it is done:

1. **GitHub**: add a connection with a personal access token, in *Instance settings →
   GitHub connections*. A board that delivers results needs none.
2. **Your own account**: `admin@viberr.dev` is the instance's default account. Create a
   real one for yourself in *Instance settings → Users & access*.
3. **Claude or Codex**: connect your own account in *Profile → Agent accounts*, with a
   hosted sign-in or a pasted API key.
4. **First project**: choose what it delivers, its repository and an agent policy
   preset.

Then open the board, press **New task** and describe the work. The Operator starts at
once.

[**docs/getting-started.md**](docs/getting-started.md) walks through each step, including
the token permissions, inviting your team, single sign-on and running from source.

### Run from source

For working on Viberr itself you need Node.js 26 or newer and npm.

```sh
cp .env.example .env   # every variable is optional
npm ci
npm run seed           # baseline content and the bootstrap admin
npm run dev            # http://localhost:5173
```

Sign in as `admin@viberr.dev` / `viberr-dev-2828`, or with the
`VIBERR_SEED_ADMIN_EMAIL` / `VIBERR_SEED_ADMIN_PASSWORD` you set before seeding. The dev
server's store is `./docker-data`, separate from the container's volume, and one process
holds a store at a time. Contributor workflow: [CONTRIBUTING.md](CONTRIBUTING.md).

## How it works

```
people ──┐                                 ┌──▶ canonical files (task.md, project.md, epics)
         ├──▶ governed actions ────────────┤          │ watched · parsed · projected
agents ──┘    RBAC · agent capabilities    │          ▼
              audit · timeline events      │    SQLite projections ──SSE──▶ every open browser
                                           └──▶ GitHub: branches, pull requests, merges
```

- **One Node process** serves the server-rendered React Router app, the live-update
  stream and the background services (file watcher, GitHub reconciler, schedules,
  retention). There is no external database, cache or queue.
- **Canonical state is files** under the data root (`/data` in the container):
  `projects/<slug>/project.md`, `projects/<slug>/tasks/<KEY>/task.md`, epics, agent
  profiles, knowledge bases and skills. Writers hold a per-file lock, write atomically
  and re-project what they wrote.
- **SQLite** (`node:sqlite`, WAL) holds the projections plus what the app owns: users,
  sessions, encrypted secrets, audit, notifications and run history.
- **Agent runs** go through the Claude Agent SDK or the Codex SDK. In the container, every
  agent process runs as its person's own OS user, so it cannot read the server's secrets,
  the database or anyone else's sign-in (ruling 460).

The architecture in one read: [docs/architecture/overview.md](docs/architecture/overview.md).

## Configuration

Every variable is optional: [`.env.example`](.env.example) documents each one, and
[docs/operations/configuration.md](docs/operations/configuration.md) is the full
reference. Most instances only ever set these:

| Variable | When you need it |
|---|---|
| `BETTER_AUTH_URL` | Behind a reverse proxy: the public `https://` origin |
| `VIBERR_TRUST_PROXY=1` | Behind a reverse proxy, so the client address is read from it |
| `VIBERR_CPUS` | A CPU ceiling for the container, roughly cores minus 3 on a shared machine |
| `PORT` | The listening port (3000 in the container, 5173 for `npm run dev`) |
| `VIBERR_SEED_ADMIN_EMAIL`, `VIBERR_SEED_ADMIN_PASSWORD` | Your own bootstrap admin instead of the generated one |
| `VIBERR_SESSION_SECRET`, `VIBERR_SECRET_ENCRYPTION_KEY` | Managing the two secrets yourself; left unset, they are generated into the store on first boot |
| `GITHUB_OAUTH_CLIENT_ID/SECRET`, `GOOGLE_OAUTH_CLIENT_ID/SECRET` | Seeding sign-in providers from the environment (they can also be set in the app) |

Most other settings live in the app, not the environment:

- **Agent accounts**: each person, *Profile → Agent accounts*. Claude by "Sign in with
  Claude" (Pro/Max), "Sign in with Console" or a Console API key; Codex by "Sign in with
  ChatGPT", an OpenAI API key or a ChatGPT workspace access token. Several accounts per
  backend, one in use at a time. Hosted sign-ins are run by the vendor's own CLI and stay
  in that person's runtime home; Viberr never implements the vendors' OAuth and never
  stores a Claude.ai or ChatGPT session token, as Anthropic's
  [Claude Code legal and compliance terms](https://code.claude.com/docs/en/legal-and-compliance)
  require. Pasted keys are sealed with AES-256-GCM and reach only the runs that person
  pays for. [How runs are confined](docs/domain/agents-and-runtime.md).
- **GitHub**: *Instance settings → GitHub connections* (a fine-grained token with
  Contents and Pull requests read/write, or a classic `repo` token), then the repository
  in the New project dialog or *Project settings*. Without a token, everything degrades
  to typed "no credential" states. [The delivery pipeline](docs/domain/github-delivery.md).
- **Sign-in**: local accounts always; GitHub and Google OAuth optional, in *Instance
  settings → Sign-in & SSO*. Sign-in is a whitelist: only people with an account, or
  Google users in an allowed domain. [Auth and roles](docs/domain/auth-and-rbac.md).
- **Projects**: stages, transition boundaries, project roles, the agent capability
  matrix, agent profiles and their skills, knowledge bases and MCP servers, all per
  project in *Project settings*, *Policy* and *Agents*.

## Operating it

- **Production.** The app speaks plain HTTP. Put a TLS-terminating reverse proxy in
  front and set `BETTER_AUTH_URL` and `VIBERR_TRUST_PROXY=1`; without the first, sign-in
  answers 403 behind the proxy, and without the proxy, sign-in loops.
  [Deployment guide](docs/operations/deployment.md#tls-and-the-reverse-proxy).
- **Health.** `GET /resources/health` is an unauthenticated probe: `200` while the process
  answers, and `503` with `?probe=readiness` while any subsystem (watcher, lock, disk,
  projections, agent isolation) is degraded. It also reports the running build and how
  many people have connected each agent backend.
  [Every field](docs/operations/runbook.md#health--liveness).
- **Backups.** `npm run backup` takes a consistent copy of the database and the file
  store (a raw copy of the live SQLite file misses rows still in its write-ahead log). A
  backup carries the generated secrets, so treat it as one.
  [Backup and restore](docs/operations/deployment.md#persistence-backup--restore).
- **Upgrades.** `git pull && npm run deploy`: it stamps the build from git, builds,
  restarts and fails unless the running instance reports the build it just made.
- **Day 2.** Rescans, diagnostics, stuck runs, GitHub and auth issues, retention, the
  writer lock: [the runbook](docs/operations/runbook.md).

| Command | What it does |
|---|---|
| `npm run dev` | Development server (`PORT`, default 5173) |
| `npm run build` / `npm start` | Production build, and serve it |
| `npm run lint` / `npm run typecheck` / `npm test` | oxlint with the vendored anti-slop rules / route typegen and `tsc` / the vitest suite |
| `npm run e2e` | Playwright against the production Docker image |
| `npm run seed` | Baseline content and the bootstrap admin; `-- --reset` returns the store to a clean sheet |
| `npm run seed:demo` | The demo board the route and e2e suites use (development only) |
| `npm run rescan` | Reconcile the projections with the file store |
| `npm run store:check` | Read-only: list every canonical file the app cannot trust, with the offending line |
| `npm run backup` / `npm run restore -- --from <artefact>` | Point-in-time backup / whole-root or single-file restore |
| `npm run keys -- status \| reseal` | Encryption-key rotation |
| `npm run deploy` | Stamped Docker build, restart and verification |
| `npm run store:to-volume` | Move an older `./docker-data` store into the named volume |

`seed`, `seed:demo`, `rescan`, `restore` and `keys -- reseal` take the store's writer lock
and refuse to run while the app does. Every script, in detail:
[docs/development/scripts.md](docs/development/scripts.md).

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | Install, first sign-in, first project and task, team, SSO, production |
| [Product overview](docs/product/overview.md) | The operating model, what V1 covers, deliberate boundaries |
| [Glossary](docs/product/glossary.md) | Every term and enum in one place |
| [Architecture](docs/architecture/overview.md) | Stack, layers, request and boot lifecycles, security posture |
| [Decisions](docs/architecture/decisions.md) | The binding conventions and numbered rulings the code cites |
| [Operations](docs/operations/deployment.md) | Deployment, [configuration](docs/operations/configuration.md) and the [runbook](docs/operations/runbook.md) |
| [Documentation index](docs/README.md) | Every page, including the domain references and the development guides |

## Repository layout

```
app/
  routes/          thin route modules (loaders and actions), one per surface
  features/        per-surface UI and its loader/action glue
  ui/              reusable primitives (icon, pill, toast, dialogs, rich text …)
  server/          server-only modules: files, projections, tasks, agents, runtimes,
                   controller, github, auth, audit, db, ops, seed … and boot.server.ts
  schemas/         shared Zod schemas (task, project and epic files, SSE events …)
  shared/          cross-surface helpers (rbac, capabilities, workflow, dates, text …)
  lib/             the better-auth instance and its Viberr bridge
  app.css          the one stylesheet and its design tokens
db/migrations/     the squashed SQLite baseline, applied at boot
scripts/           operational CLIs (seed, rescan, backup, restore, keys, deploy, e2e …)
e2e/               Playwright specs
test-support/      vitest harnesses: test app, db and store, fake runtimes, fake GitHub
tools/             the vendored lint plugin and the setuid agent launcher
docs/              the documentation set
```

Directory by directory: [docs/architecture/codebase-map.md](docs/architecture/codebase-map.md).

## Known limitations

Deliberate V1 boundaries, documented rather than half-built:

- **Single node.** SQLite, a local file store and an in-process event bus: one app
  process per data root, enforced by a writer lock.
- **One schema baseline, no migration chain.** Schema changes edit
  `0001_baseline.sql`. On an older database, boot adds the columns, tables and indexes
  each release lists for it, and warns when a projection table lacks a column or a CHECK
  refuses a value the build now writes, naming the remedy (a manual `ADD COLUMN`, or
  re-baselining the projection database). Other drift is neither repaired nor reported,
  and file formats carry no back-compat promise. Back up before upgrading.
- **No email.** Notifications are in-app, plus an opt-in browser notification for a new
  decision. Admins hand new users their one-time password themselves.
- **TLS is the deployment's job.** The app serves plain HTTP and expects a reverse proxy.
- **Codex runs are not OS-sandboxed** beyond the per-person OS user: capabilities the
  Codex runtime cannot enforce are advisory there and labelled so.
- **Chromium only** for the declared browser matrix.
- **Retention windows are mostly fixed.** Run logs are kept 30 days and audit rows 90
  (exported to JSONL first); notifications are trimmed to the newest 500 per user, and
  the Notifications page shows the newest 200. `provenance` and a few other tables have
  no retention: the runbook shows how to prune them.
- **Instance audit browse is minimal.** The newest 150 rows with a text filter over the
  loaded window, CSV/JSON download (100,000-row cap) and an S3 push; no server-side
  query or paging.
- **Fine-grained token validation is partly assumed.** GitHub does not expose
  fine-grained permissions, so `pull_request:write` reads "assumed" until first use
  unless `VIBERR_GITHUB_WRITE_PROBE=1` enables the write probe.
- **The spending cap binds Claude only**; Codex has no budget option.

Requirement-by-requirement status: [docs/product/requirements-status.md](docs/product/requirements-status.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), then [AGENTS.md](AGENTS.md) if you work with a
coding agent. Before you push: `npm run lint && npm run typecheck && npm test && npm run build`.
CI also runs `npm run e2e` against the production image.

## License

Viberr is released under the [MIT License](LICENSE). Code adapted from other projects
keeps its own licence, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md);
dependencies installed from npm carry theirs in `node_modules`.
