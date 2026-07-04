# Viberr Build Plan (master handoff)

**Read this first. Then read `docs/build/CONVENTIONS.md` and `docs/build/STATE.md`.**

Viberr is a multi-user web app for governed AI software delivery: agents do the delivery
work, humans govern flow/review/acceptance. Full planning lives in
`planning/planning-artifacts/` (prd.md, architecture.md, epics.md, ux-design-specification.md).
The architecture document is authoritative for all technical decisions — when in doubt, read it.

A complete high-fidelity mock of the entire UI exists at `design/html-app/`:
- `Viberr Login.html`, `Viberr Home.html`, `Viberr Operator Workspace.html` — entry points (React + Babel, no build step)
- `design/html-app/app/*.jsx` — one file per surface; **this is the design source of truth to port**
- `design/html-app/app/viberr.css` — the full design system (CSS custom properties `--viberr`-ish tokens, light/dark themes)
- `design/html-app/app/data.js` — mock data; **defines the expected domain shapes** (tasks, stages, people, packets, timeline events, runtime streams, notifications, policy)
- `design/html-app/_shots/` — screenshots of expected rendering

## Product summary (what the app does)

- **Canonical truth is files, not the DB.** Projects and tasks live as markdown files
  (frontmatter + body) in a runtime data root. Humans and agents may edit them directly.
  The app observes files (watcher + manual rescan), parses tolerantly, derives readiness
  states and diagnostics, and materializes **projections** into SQLite for fast reads.
  SQLite is used for app management (users, sessions, secrets, projections, provenance,
  audit) — never as canonical business truth.
- **Readiness states (canonical):** `ready`, `input_required`, `inconsistency_risk_detected`, `blocked`.
  Waiting-on-human / waiting-on-agent are secondary signals. `done`/`review-ready` are workflow labels.
- **Workflow:** per-project stages (default: triage, ready, impl/In Progress, review, done) with
  governed transitions. Only humans transition to done. Decision/blocking packets are typed events
  requiring human resolution.
- **People model:** org users with roles (admin/member/viewer). One human **owner** per task =
  reviewer + acceptance authority; any member can take/release ownership; admins can release anyone.
  App-wide commenting (non-members labeled). Agents: one **operator** per active task, one primary
  **specialist**, optional **consultants** (Codex / Claude Code backends).
- **GitHub:** per-project default repo, per-task override. User-provided fine-grained PATs
  (encrypted at rest), task-key branches (`vib-142-...`), commit/PR traceability, PR status.
- **Live updates:** SSE (`task.updated`, `projection.rebuilt`, ...) triggering route revalidation.

## Tech stack (locked)

- React Router v7 framework mode (SSR), Node >= 20, TypeScript. Vite build.
- `better-sqlite3` (WAL mode). SQL-first migrations in `db/migrations/*.sql`, applied by `scripts/run-migrations.ts` and automatically at boot.
- Zod v4 at parse/action boundaries. Tolerant parsing + explicit diagnostics; never silent fallback.
- Sessions: opaque session id in a signed, httpOnly, sameSite=lax cookie; session data server-side in SQLite. scrypt (node:crypto) password hashing. CSRF protection on state-changing POSTs (origin check + token).
- Secrets/config **only** from env vars, validated at startup by `app/server/config/env.server.ts` (fail fast, clear messages). `.env` supported for dev via dotenv; `.env.example` documents everything. Key env vars: `VIBERR_SESSION_SECRET`, `VIBERR_SECRET_ENCRYPTION_KEY` (32-byte base64, AES-256-GCM for PATs), `VIBERR_DATA_ROOT` (default `./data`), `PORT`, optional `GITHUB_OAUTH_CLIENT_ID/SECRET`, `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `VIBERR_SEED_ADMIN_EMAIL/PASSWORD`.
- Styling: **the ported `viberr.css` design system. No Tailwind.** Keep class names from the mock so ported JSX maps 1:1. Design tokens stay as-is (`--bg`, `--panel`, `--ink`, `--teal`, `--coral`, etc.), light/dark/system theme preserved.
- SSE via a resource route + in-process event bus. No websockets. No external queue/cache.
- Runtime data root (default `./data`, gitignored): `projects/<slug>/project.md`, `projects/<slug>/tasks/<KEY>/task.md` (+ `attachments/`), `agents/`, `runtimes/` (NDJSON run logs), `state/projection.sqlite`, `cache/`, `auth/` (nothing plaintext), `logs/`.
- Tests: vitest co-located `*.test.ts`. Playwright e2e later (phase 11).

## Execution protocol for phase agents

You are one of a sequence of fresh agents building this app. Protocol:

1. Read this file, `CONVENTIONS.md`, `STATE.md`, and the report(s) of the phase(s) you build on in `docs/build/reports/`.
2. Read the mock files relevant to your phase fully before porting.
3. Build. Don't cut corners; no placeholder/dead-end UI where the plan says working feature. Verify with `npm run typecheck` and `npm run build` (and tests where they exist) before finishing.
4. Write `docs/build/reports/phase-<N>.md`: what you built, file inventory, decisions/deviations, known gaps, exact instructions the next phase needs (interfaces, function signatures, gotchas).
5. Update `docs/build/STATE.md` (append your phase line; update "current status").
6. Do NOT git commit (the orchestrator commits), do not touch `design/` or `planning/` (read-only reference).

## Phases

**Phase 1 — Scaffold & foundations.** RR7 app at repo root (`app/`, `db/`, `scripts/`), typed env, SQLite bootstrap + migration runner + migration 0001 (users, sessions, migration bookkeeping), pino-style JSON logger (or minimal custom), typed AppError + error codes, port `viberr.css` → `app/app.css` (verbatim, plus font setup), `root.tsx` with theme handling (light/dark/system via cookie or localStorage like mock), placeholder index route. npm scripts: dev/build/start/typecheck/test/migrate/seed.

**Phase 2 — Auth & org.** Port login page 1:1. Credentials auth (scrypt), server sessions, CSRF, login/logout/forced-reset flows, org users CRUD (admin), roles, whitelist model for OAuth, optional Google/GitHub OAuth (only active when env vars present; hide/disable buttons with the mock's "not wired" messaging otherwise), auth middleware for loaders/actions, seed admin user. RBAC helper (`requireRole`).

**Phase 3 — File store & projections.** Everything under `app/server/files|interpretation|projections|provenance`: data-root bootstrap, project.md/task.md schemas (frontmatter: key/title/stage/readiness/waiting/owner/specialist/consultants/branch/repo/pr/urgent/validation + body sections incl. Goal, Timeline as structured event log), tolerant parser producing diagnostics, readiness policy, projection schema migration 0002 (projects, tasks, task_events, diagnostics, provenance), rebuilder (full + single-task), chokidar watcher with debounce, manual rescan function, seed script that writes the full demo dataset from the mock (`data.js` tasks VIB-139..VIB-168, people, stages, notifications) as real files + DB rows so the app boots looking like the mock.

**Phase 4 — Shell, Home, Board.** Port `main.jsx` shell (rail, topbar, crumbs, search stub→real filter, bell popover, user menu, toasts, theme switcher), `home.jsx` (project cards/home), `board.jsx` (columns by stage, task cards with readiness/waiting/validation/owner/agent chips, urgent markers), task create modal (writes task.md via action → projection refresh), list view if present in mock. Routes: `/` (home), `/projects/:slug/board`, deep-link `/projects/:slug/tasks/:key`.

**Phase 5 — Task detail.** Port `task.jsx` + `tweaks-panel.jsx` + `review.jsx`-related pieces: operator-first layout (current state, execution profile, latest packet), packet resolve actions (accept completion → done + human-authorized event; request edit; block on policy; hold for debug — all writing typed events into task.md + audit), unified timeline rendering (comment/agent/transition/quality/policy/github/completion/assign/blocked events, evidence blocks, markdown-ish bold/code), comment composer with @agent routing + app-wide commenting rules, ownership menu (take/handoff/release/admin-release + confirm dialog), stage transition governance (human-only done).

**Phase 6 — SSE.** `app/server/events/` broker + publisher, `resources/events` route (per-project + per-task streams), client hook revalidating affected routes, wire watcher/actions → events. Multi-tab/live-user correctness, reconnect safety.

**Phase 7 — GitHub.** `app/server/secrets/` (AES-256-GCM secret box keyed from env, PAT store, PAT validator with scope/expiry diagnostics), `app/server/github/` (fetch-based client, repo access check, branch create/sync, PR link/status), repo attachment UI in settings + task, `github.jsx` view port (repo panel, branch/PR table, scope-violation flow), graceful degraded mode without PAT/network. Real GitHub REST integration.

**Phase 8 — Runtimes.** `app/server/runtimes/`: registry + adapters. `claude` adapter: spawn `claude -p --output-format stream-json --verbose` non-interactive, parse NDJSON (system/init, assistant, user, result envelopes), session resume via session id. `codex` adapter: spawn `codex exec --json` (research exact current CLI/SDK flags), parse thread/turn/item events. `simulated` backend: built-in scripted stream (from mock RUNTIME data) so the app fully works with no CLIs/keys — auto-selected when the real CLI is unavailable, clearly labeled. Run lifecycle (queued/running/finished/error/interrupted), NDJSON persisted under data root `runtimes/`, interrupt, per-run usage/cost accounting, operator scheduling rules (assign specialist run on stage entry etc. per mock), live run strip + agent logs panel (`runs.jsx` port) fed via SSE.

**Phase 9 — Remaining surfaces.** `review.jsx` (review queue), `agents.jsx` (agents overview incl. runtime states), `policy.jsx` (agent capability matrix + RBAC table), `settings.jsx` (project settings: stages editor, members, repo, credential policy), `org-settings.jsx` (org admin: users, whitelist, agent profiles, KBs), `activity.jsx`, `notifications.jsx` (+ bell integration, mark read, per-user rows in SQLite), `profile.jsx` (name/title/theme/password), `kb-browser.jsx` (knowledge-base browser over data-root files).

**Phase 10 — Audit & recovery.** Audit table + recorder invoked by every governed action (who/what/when/task/project), audit views (activity + org settings audit tab if in mock), policy-violation + quality-flag events end-to-end, diagnostics console on task (parse errors, inconsistency findings, PAT diagnostics), rescan & rebuild-projection actions in UI, secret-isolation guard (scrub known secret patterns from logs/timeline writes) + tests.

**Phase 11 — Hardening.** Dockerfile (multi-stage, non-root) + compose.yml (volume for data root, env injection), `.github/workflows/ci.yml` (typecheck, lint, test, build), README (setup, env vars, seed logins, architecture pointer), ops docs, smoke script, Playwright e2e for the golden paths (login → board → open task → resolve packet → done), fix everything found in a full manual pass.

## Verification gates (every phase)

- `npm run typecheck` clean, `npm run build` clean, existing tests pass.
- App boots (`npm run dev`) and the phase's surfaces render with seeded data.
- No secrets in logs/timelines. No Tailwind classes. Class names/tokens match mock CSS.
