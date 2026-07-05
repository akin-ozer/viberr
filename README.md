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

Stack: React Router 7 (framework mode, SSR) · Node >= 20 · TypeScript · better-sqlite3 (WAL)
· Zod v4 · SSE for live updates (no websockets) · the ported `viberr.css` design system
(no Tailwind). Agent runtimes: Claude Agent SDK + Codex SDK, with a built-in simulated
backend so the full product works with zero external credentials.

## Quickstart (local dev)

Requirements: Node >= 20 (Node 22 recommended), npm.

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
VIB-139…VIB-168 (packets, timelines, agent runs with live-dripping logs), two stub
projects, notifications, agent profiles, knowledge bases. `npm run seed -- --reset`
restores it to pristine at any time.

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
| `npm run seed` | idempotent demo dataset (`-- --reset` wipes derived state first) |
| `npm run rescan` | reconcile projections with the file store |

## Enabling real agent backends

Out of the box every agent run uses the built-in **simulated** engine (clearly labeled,
streams the seeded demo scripts live over SSE). To run real agents, set credentials in
`.env` and restart — detection is presence-of-key only, no paid API call:

- **Claude** (via `@anthropic-ai/claude-agent-sdk`): `ANTHROPIC_API_KEY=sk-ant-…`
- **Codex** (via `@openai/codex-sdk`): `CODEX_API_KEY=…` or `OPENAI_API_KEY=sk-…`,
  or an existing interactive `codex login` on the host (requires a working `codex` binary).

With a key present, new runs stream real SDK output; the raw NDJSON of every run is
persisted under `<data root>/runtimes/`. Without keys the simulated engine carries the
demo transparently.

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

The authoritative planning artifacts live in [`planning/planning-artifacts/`](planning/planning-artifacts/)
(PRD, architecture, epics, UX spec). Build-time documentation — phase-by-phase reports,
conventions, cross-cutting contracts — lives in [`docs/build/`](docs/build/). Canonical
file formats (project.md / task.md / timeline event grammar) are specified in
[`docs/architecture/file-formats.md`](docs/architecture/file-formats.md).

## Screenshots / design parity

The app is a 1:1 port of the high-fidelity design mock in `design/html-app/` — class
names, tokens, light/dark themes, and copy are kept intact, so the reference screenshots
under `design/html-app/_shots/` show exactly what the running app looks like (board,
task workspace with decision packets, live agent runs, review queue, org settings…).

## Known gaps (V1 release notes)

Deliberate scope boundaries, documented rather than half-built:

- **No mailer.** Notifications are in-app only; email/nudge preferences on the profile
  are schema-only. Invited users don't get an email — admins hand over the one-time
  password shown at creation.
- **Org-level audit console.** Org-scoped audit rows (user admin, connections, auth)
  are recorded but only project-scoped audit has a UI (Activity → Audit logs). The mock
  defines no org audit tab.
- **Provenance/audit tables grow unboundedly** — no retention policy yet; see the
  runbook for the manual cleanup story.
- **Notifications page caps at the newest 200 rows** (no pagination).
- **Stub-project task links** (DEP-31, BIL-7) land on an in-shell 404 — the two stub
  projects exist for cross-project navigation, their tasks are not seeded.
- **Home "GitHub connections" tile** derives from project repos, not from org
  connections.
- **MCP server credentials UI** is not built (org settings lists servers and probes
  reachability; secrets would be a follow-up).
- **Fine-grained PAT validation is partly probe-based** — GitHub doesn't expose
  fine-grained permissions in headers, so some scope checks report "assumed" until
  first use (documented in the credential card).
- **No scheduled GitHub reconcile** — PR/branch state refreshes via the explicit
  Reconcile action on the GitHub view.
