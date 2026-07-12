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
Project/task/profile/KB/skill truth is file-native. SQLite also owns non-rebuildable app state —
users, sessions, encrypted GitHub and MCP secrets, audit, notifications, org-resource metadata,
runtime projections, and the automatic-operator dispatch queue — so the database remains part of
the backup surface even though it is never canonical task truth.

Stack: React Router 8 (framework mode, SSR) · Node >= 26 · TypeScript 7 (native compiler) · better-sqlite3 (WAL)
· Zod v4 · SSE for live updates (no websockets) · the ported `viberr.css` design system
(no Tailwind). Agent runtimes: Claude Agent SDK + Codex SDK, with a built-in simulated
backend so the full product works with zero external credentials.

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

# 3. Database + demo data (migrations also auto-apply at boot)
npm run migrate
npm run seed

# 4. Run
npm run dev        # http://localhost:5173
```

Sign in with the seeded demo accounts:

| user | email | password | org role |
|---|---|---|---|
| Arda Kaya | `arda@viberr.dev` | `viberr-dev-2828` | admin |
| Elif Demir | `elif@viberr.dev` | `viberr-dev-2828` | member |
| Murat Yıldız / Selin Aksoy / Deniz Şahin | `…@viberr.dev` | `viberr-dev-2828` | member |

The seed materializes the full demo dataset: the **viberr-core** project with tasks
VIB-139…VIB-168 (packets, timelines, agent runs with live-dripping logs), two small
cross-project task fixtures, notifications, agent profiles, and knowledge bases.

`npm run seed -- --reset` is a **destructive demo reset**, not a schema upgrade: it removes every
canonical project, agent profile, runtime log, KB/skill file, MCP configuration/domain allowlist,
and derived row before recreating the demo. Users, installed GitHub credentials, and encrypted org
secret values survive. Back up the data root and stop the app before using it on a store that matters.

Without `npm run seed`, an empty instance boots too: when the users table is empty the
server creates a bootstrap admin at startup — set `VIBERR_SEED_ADMIN_EMAIL` /
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
| `npm run e2e` | Playwright golden paths (isolated data root, own port — safe to run next to a dev server; first time: `npx playwright install chromium`) |
| `npm run migrate` | apply pending `db/migrations/*.sql` |
| `npm run seed` | idempotent demo dataset (`-- --reset` destructively replaces canonical demo/resource state; see above) |
| `npm run rescan` | reconcile projections with the file store |

## Enabling real agent backends

Out of the box every agent run uses the built-in **simulated** engine (clearly labeled,
streams the seeded demo scripts live over SSE). To run real agents you can use a
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

Confirm what's live: `GET /resources/health` reports each backend as `unconfigured`, `unknown`,
`verified`, or `degraded`. `configured` means a credential or explicit CLI-auth opt-in is present;
only a recent real run can make the provider `verified` or `degraded`. The health request itself
never spends a provider call. New runs stream SDK output; raw NDJSON of every run is persisted under
`<data root>/runtimes/`. Container specifics: `docs/operations/deployment.md`.

## Enabling GitHub integration

Branch/PR traceability uses **user-provided GitHub tokens, encrypted at rest**
(AES-256-GCM with `VIBERR_SECRET_ENCRYPTION_KEY`). The same key protects organization secrets
referenced by MCP HTTP-header or stdio-environment mappings.

1. Create a token on GitHub — *Settings → Developer settings → Fine-grained personal
   access token*, resource owner = the org/user owning the project repo, grant access to
   that repository, permissions: **Contents: Read and write** (branches),
   **Pull requests: Read and write** (PR link/status/merge), **Metadata: Read-only**
   (implied), optional **Workflows: Read and write**. A classic token with `repo`
   (+ `workflow`, `read:org`) also works and validates more precisely.
2. In Viberr: **Org settings → Connections** → add the connection (the token is
   validated before anything is saved), then attach the repo in
   **Project settings → Repository**.
3. Keep `VIBERR_SECRET_ENCRYPTION_KEY` stable — rotating it orphans stored tokens and MCP
   organization secrets (they must be deleted and re-added).

Without a token everything degrades honestly (typed "no credential" states, never a crash).
Specialists never receive the token or push themselves: Viberr prepares the checkout, then owns the
authenticated push, verifies the exact remote head and a non-empty comparison, and opens/reuses the
task PR after the model run.

## Enabling OAuth sign-in

Optional; the login buttons stay disabled until the env vars exist. Sign-in is
whitelist-based: it succeeds only for emails that already have a (non-disabled) Viberr
user row — plus, for Google, domains added to the org allowlist (those provision on
first login).

- **GitHub**: OAuth app with callback `https://<host>/auth/github/callback` →
  `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` (scopes `read:user user:email`).
- **Google**: OAuth web client with redirect `https://<host>/auth/google/callback` →
  `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` (scopes `openid email profile`, PKCE).

## Docker

```sh
cp .env.example .env    # fill in the two required secrets
docker compose up --build -d
docker compose exec app npm run seed   # optional: demo dataset
```

The app listens on `PORT` (container default 3000; compose maps the same port on the
host). All state lives in the volume mounted at `/data` (`./docker-data` by default) —
that directory is the complete backup surface. The compose file wires a healthcheck
against `/resources/health` and `restart: unless-stopped`. See
[docs/operations/deployment.md](docs/operations/deployment.md) for the full single-node
story (backup/restore, projection rebuild) and
[docs/operations/runbook.md](docs/operations/runbook.md) for day-2 operations.

For this breaking development pass, do not reuse a database whose canonical migration files were
already recorded at their older contents. Stop Compose, preserve the SQLite/WAL/SHM trio, move that
trio out of `docker-data/state/`, rebuild the image, then run
`docker compose run --rm app npm run seed` to create a fresh demo database. This is intentionally
destructive; the runbook separates that development reset from production restore/recovery.

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
scripts/           # migrate / seed / rescan (tsx)
e2e/               # Playwright golden paths (isolated data root)
test-support/      # in-memory app/db/store/github fakes for vitest
data/              # runtime data root (gitignored): projects/<slug>/tasks/<KEY>/task.md,
                   # agents/, runtimes/, kb/, state/projection.sqlite, logs/
```

## Architecture

The current product authority for this correction pass lives in
[`planning/discovery-2026-07-13/`](planning/discovery-2026-07-13/). The original PRD, architecture,
epics, and UX material under [`planning/planning-artifacts/`](planning/planning-artifacts/) remain
historical intent; phase reports under [`docs/build/`](docs/build/) are historical build records.
Canonical file formats are specified in
[`docs/architecture/file-formats.md`](docs/architecture/file-formats.md).

## Screenshots / design parity

The high-fidelity mock in `design/html-app/` remains the visual starting point: its tokens, themes,
and much of its copy are carried forward. It is not a current behavioral golden. Responsive shell,
governance, routing, reviewer, archive, recovery, and honest integration states deliberately diverge;
the dated walkthrough and fresh validation evidence live in the current discovery dossier.

## Current governance contracts

- A contributor who currently owns a task may resolve its packets and accept that task's completion;
  maintainers/admins retain project-wide authority. Organization admins have visible, audited
  emergency project-admin authority without acquiring membership.
- Automatic operator triggers use a durable, coalescing queue with concurrency/cost bounds. Hard
  eligibility removes impossible specialists; the intelligent operator then compares declared
  skill/KB/MCP fit, backend health, workload, and observed cost, and persists its reason. Viberr does
  not apply a hidden static score.
- Reviewers use isolated workspaces and must emit one structured, non-simulated verdict. Every
  assigned reviewer must approve the current evidence round; any rejection returns the task to
  implementation.
- Completion requires the governed Review stage and exactly healthy validation. A repository task
  needs a linked PR and reaches Done only after a real merge. If acceptance succeeds but merge cannot,
  it remains in Review as **accepted · merge pending**. A healthy repo-less task may finish directly.
- Archived projects are readable history. Mutations and new runs are blocked, active runs are
  stopped, and Settings exposes Restore as the only project mutation.

## Known gaps (V1 release notes)

Deliberate scope boundaries, documented rather than half-built:

- **No mailer.** Notifications are in-app only; email/nudge preferences on the profile
  are schema-only. Project **Grant access** provisions an OAuth-whitelisted account and membership
  but sends nothing; admins must give the person the exact sign-in instruction. Local org-user
  creation separately surfaces a one-time password for manual handoff.
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
