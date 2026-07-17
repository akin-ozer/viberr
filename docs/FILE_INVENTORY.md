# Repository file inventory

Generated for VIB-1 ("list files in the project"). Snapshot of the tracked file tree,
grouped by top-level directory, with a short architecture and risk summary. For the full
per-file list at any time, run `git ls-files` (627 tracked files as of this snapshot).

## File counts by top-level directory

| Path | Files | Purpose |
|---|---:|---|
| `app/` | 382 | Application source (React Router 8, SSR) — routes, features, server, ui, schemas, shared |
| `planning/` | 78 | Discovery notes, brainstorming, planning artifacts (PRD/architecture/epics/UX spec) |
| `docs/` | 55 | Build-time docs: conventions, phase plans, architecture (file formats), operations (deploy/runbook) |
| `design/` | 54 | HTML design mock (`design/html-app/`) the app is ported 1:1 from, plus reference screenshots |
| `.claude/` | 9 | Claude Code skills used during development (animation/design review skills, react-doctor) |
| `.agents/` | 9 | Mirrors of the same skills for other agent runtimes |
| `test-support/` | 8 | In-memory fakes for vitest (app/db/store/github, dom + env setup) |
| `e2e/` | 8 | Playwright golden-path specs + auth/teardown fixtures |
| `scripts/` | 4 | `tsx` scripts: migrate, seed, rescan, gen-better-auth-schema |
| `db/` | 1 | `db/migrations/0001_baseline.sql` — sole SQL-first migration |
| top-level configs | 16 | `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `react-router.config.ts`, `doctor.config.ts`, `compose.yml`, `Dockerfile`, `.env.example`, `.nvmrc`, `skills-lock.json`, etc. |
| `.github/workflows/` | 1 | `ci.yml` — typecheck, vitest, build on push/PR to `main` |
| `public/` | 1 | `favicon.svg` |

File extensions: 311 `.ts`, 157 `.md`, 87 `.tsx`, 18 `.jsx` (design mock only), 14 `.png`,
11 `.html`, 5 `.json`, 3 `.jpg`/`.css`, 1 `.sql`. 135 files are `*.test.ts(x)` or
`*.spec.ts` (unit/integration + e2e).

## `app/` breakdown (the actual product)

- `app/routes/` (26 files) — thin React Router route modules (loaders/actions only), one
  per URL surface (board, task detail, github, policy, org/project settings, auth, SSE
  resources for events/health/model-catalog/run-log/session-export).
- `app/features/` (16 feature folders, ~120 files) — per-surface UI: `activity`, `agents`,
  `board`, `github`, `home`, `kb-browser`, `live-updates`, `notifications`, `org-settings`,
  `policy`, `profile`, `project-settings`, `review`, `runtime`, `shell`, `task-detail`
  (largest, 18 files — decision packets, timeline).
- `app/server/` (19 subdirectories) — server-only: `auth`, `audit`, `config`, `db`,
  `errors`, `events`, `files` (file-store watcher/parser), `github`, `interpretation`,
  `logging`, `org`, `prefs`, `projections` (SQLite materialization), `runtimes` (Claude
  Agent SDK + Codex SDK integration, simulated backend), `secrets` (AES-256-GCM at rest),
  `seed`, `tasks`, `theme`.
- `app/ui/` (18 files) — reusable primitives: icon, pill, dialog (`use-dialog`), toast,
  rich-text/markdown rendering, mention spans, stage menu.
- `app/schemas/` (6 files) — shared Zod v4 schemas: `task-file`, `project-file`,
  `sse-event`, `github-pat`, `file-diagnostics`.
- `app/shared/` — cross-surface helpers: `capabilities.ts`, `rbac.ts`, `dates/`, `ids/`,
  `mapping/`, `workflow/`.
- `app/app.css` (148 KB) — ported `viberr.css` design system (no Tailwind).

## Dependencies (package.json)

Runtime: `react` 19 / `react-router` 8 (framework mode SSR) / `@react-router/node`,serve ·
`better-sqlite3` (WAL mode) · `better-auth` · `zod` v4 · `@anthropic-ai/claude-agent-sdk` ·
`@openai/codex-sdk` · `chokidar` (file watching) · `yaml` · `react-markdown` + `remark-gfm` ·
`@fontsource/*` (JetBrains Mono, Manrope, Noto Sans) · `isbot` · `tsx` · `dotenv`.

Dev/test: `vite` 8, `vitest` 4, `@testing-library/react`, `jsdom`, `@playwright/test`,
`typescript` 7 (native compiler), `@types/*`.

Node >= 26 required (`.nvmrc`, `engines` in package.json).

## Architecture summary

Viberr is a governed AI-delivery web app. Canonical business truth (projects, tasks) is
**markdown with frontmatter** on a runtime data root (`data/`, gitignored) — not the
database. The app watches those files (`app/server/files`), parses tolerantly (bad input
becomes diagnostics, never a crash — see `app/schemas/file-diagnostics.ts`), and
materializes read-optimized projections into SQLite (`app/server/projections`, WAL mode).
SQLite is scoped to app-management concerns only: users/sessions (better-auth),
projections, encrypted secrets, and audit — never the source of truth. Agent execution
runs through `app/server/runtimes` against Claude Agent SDK / Codex SDK, with a built-in
simulated backend so the product runs with zero external credentials. Live updates use
SSE (`resources.events.ts`), not websockets. The UI is a 1:1 port of the static mock in
`design/html-app/`.

Authoritative planning docs: `planning/planning-artifacts/` (PRD, architecture, epics, UX
spec). Build-time docs: `docs/build/` (conventions, phase plans, state). File-format spec:
`docs/architecture/file-formats.md`.

## Notable risks / gaps (from README "Known gaps" + inventory observations)

- **Single SQL migration** (`db/migrations/0001_baseline.sql`) — schema is still young;
  no migration-rollback tooling observed.
- **No mailer** — notifications are in-app only; invite flow hands over a one-time
  password instead of emailing it.
- **Org-level audit has no UI** (only project-scoped audit is surfaced); audit/provenance
  tables have no retention policy yet.
- **Notifications page caps at 200 rows**, no pagination.
- **Two stub projects** (`DEP-31`, `BIL-7`) have unseeded tasks and land on an in-shell 404.
- **No scheduled GitHub reconcile** — PR/branch state only refreshes via an explicit action.
- **`planning/` carries many dated discovery/pass folders** (`discovery-2026-07-10` through
  `-16-pass7`, `test-artifacts`, `brainstorming`) — historical working notes that could be
  pruned or archived now that `planning/planning-artifacts/` holds the authoritative spec.
- **`.claude/` and `.agents/` duplicate the same skill set** for two agent runtimes —
  worth confirming they're meant to stay in lockstep rather than drifting.
