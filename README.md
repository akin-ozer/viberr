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

What makes it different: Viberr is agent-native in both action and responsibility. In
Jira-like tools humans are the default workers and AI helps at the edges; in Viberr agents
own task execution while engineers govern movement, approvals, and quality boundaries.
Canonical truth is **files, not the database**: projects and tasks live as markdown
(frontmatter + body) under a runtime data root that humans and agents may edit directly.
The app watches the files, parses tolerantly (malformed input becomes readable diagnostics,
never a crash), derives readiness, and materializes projections into SQLite for fast reads.
SQLite handles app management only — users, sessions, encrypted secrets, projections,
audit — never canonical business truth.

Stack: React Router 8 (framework mode, SSR) · Node >= 26 · TypeScript 7 (native compiler) · `node:sqlite` (WAL)
· Zod v4 · SSE for live updates (no websockets) · the ported `viberr.css` design system
(no Tailwind). Agent runtimes: Claude Agent SDK + Codex SDK — configure a credential for
at least one to run real agents. A backend with no credential is reported unavailable and
runs on it fail fast with an honest error.

## Quickstart (local dev)

Requirements: Node >= 26, npm.

```sh
git clone <this-repo> viberr && cd viberr

# 1. Environment — copy the documented template and fill in the two
#    required secrets:
cp .env.example .env
#    VIBERR_SESSION_SECRET       — generate: openssl rand -base64 48
#    VIBERR_SECRET_ENCRYPTION_KEY — generate: openssl rand -base64 32
#    (every other variable is optional; see .env.example for docs)

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
from real runs you start. `npm run seed -- --reset` wipes projects, agent deployments,
runtime transcripts and all derived state back to that clean sheet at any time
(users/auth and the runtime credential homes survive).

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
| `npm run typecheck` | route typegen + tsc |
| `npm test` | vitest unit + integration suite |
| `npm run seed` | idempotent baseline seed — agent catalog, KBs, skills, bootstrap admin; no demo data (`-- --reset` wipes board + derived state first) |
| `npm run seed:demo` | test/dev-only: the mock demo board (arda & co, viberr-core) the e2e + route suites use |
| `npm run rescan` | reconcile projections with the file store |

## Enabling real agent backends

Out of the box no agent backend is configured, so runs fail fast with an honest
"backend unavailable" error. To run agents you can use a
**subscription (no per-token API key)** or an API key; set it in `.env` and restart —
detection is presence-only, no paid call:

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
persisted under `<data root>/runtimes/`. Container specifics: `docs/operations/deployment.md`.

## Enabling GitHub integration

Branch/PR traceability uses **user-provided GitHub tokens, encrypted at rest**
(AES-256-GCM with `VIBERR_SECRET_ENCRYPTION_KEY`).

1. Create a token on GitHub — *Settings → Developer settings → Fine-grained personal
   access token*, resource owner = the org/user owning the project repo, grant access to
   that repository, permissions: **Contents: Read and write** (branches),
   **Pull requests: Read and write** (PR link/status/merge), **Metadata: Read-only**
   (implied), optional **Workflows: Read and write**. A classic token with `repo`
   (+ `workflow`, `read:org`) also works and validates more precisely.
2. In Viberr: **Org settings → Connections** → add the connection (the token is
   validated before anything is saved), then attach the repo in
   **Project settings → Repository**.
3. Keep `VIBERR_SECRET_ENCRYPTION_KEY` stable — rotating it orphans stored tokens
   (they must be deleted and re-added).

Without a token everything degrades honestly (typed "no credential" states, never a crash).

## Enabling OAuth sign-in

Optional; the login buttons stay disabled until the env vars exist. Sign-in is
whitelist-based: it succeeds only for emails that already have a (non-disabled) Viberr
user row — plus, for Google, domains added to the org allowlist (those provision on
first login).

- **GitHub**: OAuth app with callback `https://<host>/api/auth/callback/github` →
  `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` (scopes `read:user user:email`).
- **Google**: OAuth web client with redirect `https://<host>/api/auth/callback/google` →
  `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` (scopes `openid email profile`, PKCE).

## Docker

```sh
cp .env.example .env    # fill in the two required secrets
docker compose up --build -d
docker compose exec app npm run seed   # optional: baseline (agent catalog, KBs, skills)
```

The app listens on `PORT` (container default 3000; compose maps the same port on the
host). All state lives in the volume mounted at `/data` (`./docker-data` by default) —
that directory is the complete backup surface. The compose file wires a healthcheck
against `/resources/health` and `restart: unless-stopped`. See
[docs/operations/deployment.md](docs/operations/deployment.md) for the full single-node
story (backup/restore, projection rebuild) and
[docs/operations/runbook.md](docs/operations/runbook.md) for day-2 operations.

## Project layout

```
app/
  routes/          # thin route modules (loaders/actions), one per surface
  features/        # per-surface UI: auth, home, board, task-detail, review,
                   # runtime, github, agents, policy, project-admin, org-admin,
                   # activity, notifications, profile, kb-browser, live-updates
  ui/              # reusable primitives (icon, pill, dialog, toast, rich-text…)
  server/          # server-only: config, db, files, interpretation, projections,
                   # provenance, auth, secrets, github, runtimes, events, audit
  schemas/         # shared Zod schemas (task file, project file, SSE events…)
  shared/          # cross-surface helpers (dates, ids, mapping)
  app.css          # the ported viberr.css design system + marked additions
db/migrations/     # SQL-first migrations (auto-applied at boot)
scripts/           # seed / rescan (tsx)
test-support/      # app/db/store/runtime/github fakes for vitest
data/              # runtime data root (gitignored): projects/<slug>/tasks/<KEY>/task.md,
                   # agents/, runtimes/, kb/, state/projection.sqlite, logs/
```

## Architecture

The authoritative planning artifacts are the [PRD](planning/planning-artifacts/prd.md),
[architecture](planning/planning-artifacts/architecture.md), and
[UX specification](planning/planning-artifacts/ux-design-specification.md). Canonical
project/task file formats and timeline grammar live in
[`docs/architecture/file-formats.md`](docs/architecture/file-formats.md).

## Known gaps (V1 release notes)

Deliberate scope boundaries, documented rather than half-built:

- **No mailer.** Notifications are in-app only (the profile has a real in-app opt-out
  toggle, not email/nudge preferences). Whitelisted users don't get an email — admins
  hand over the one-time password shown at creation.
- **Org-level audit console.** Org-scoped audit rows (user admin, connections, auth)
  are recorded but only project-scoped audit has a UI (Activity → Audit logs). The mock
  defines no org audit tab.
- **Provenance/audit tables grow unboundedly** — no retention policy yet; see the
  runbook for the manual cleanup story.
- **Notifications page caps at the newest 200 rows** (no pagination).
- **Fine-grained PAT validation is partly probe-based** — GitHub doesn't expose
  fine-grained permissions in headers, so some scope checks report "assumed" until
  first use (documented in the credential card).
- **No scheduled GitHub reconcile** — PR/branch state refreshes via the explicit
  Reconcile action on the GitHub view.
