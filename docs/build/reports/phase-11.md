# Phase 11 — Hardening, Docker, verification (FINAL)

Closes the build. The interrupted first attempt (Fable 5 session limit) had already
produced most artifacts; this report covers the full delivered state after the
orchestrator finished and verified it.

## Delivered

### Docker
- `Dockerfile` — multi-stage (build → prune → runtime), `node:22-slim` both stages so the
  `better-sqlite3` native binary stays ABI-compatible; native-toolchain fallback in build
  stage; non-root `node` user; `VIBERR_DATA_ROOT=/data`, `PORT=3000`; migrations auto-apply
  at boot; ops scripts runnable via `docker compose exec`.
- `compose.yml` — app service, `env_file: .env`, forces prod env, `./docker-data:/data`
  volume, `/resources/health` healthcheck, `restart: unless-stopped`.
- `.dockerignore` present.
- **Verified locally**: image builds clean (~856 MB); container boots in production mode,
  applies migrations 0001–0009 (0007 intentionally absent — 9A needed no migration),
  creates the bootstrap admin from env, serves `/resources/health` → 200
  `{"ok":true,...,"watcher":true}`, redirects `/` → `/login`, and renders the login page.
  `docker exec … npm run seed` inside the container populated 3 projects / 10 tasks
  (health reflected it live). Container, volume, and image cleaned up after.

### CI
- `.github/workflows/ci.yml` — push/PR to `main`: checkout, setup-node 22 (npm cache),
  `npm ci`, typecheck, test, build. No lint step (no linter configured — not adding one
  this late). E2E kept local-only (browser-dependent; deterministic locally).

### Docs
- `README.md` — what Viberr is, quickstart (two required secrets + generation, install,
  migrate+seed, run, seeded logins), enabling real agent backends / GitHub / OAuth, Docker
  usage, project layout, architecture pointers, design-parity note, and an honest
  **Known gaps** release-notes section.
- `docs/operations/deployment.md` — single-node Docker deployment, secrets, first run,
  backup/restore (files are canonical; SQLite rebuilds from them), upgrades, scaling note.
- `docs/operations/runbook.md` — health, rescan vs rebuild, diagnostics flows, GitHub/PAT
  issues, runtimes, auth, growth/cleanup, backup/restore.
- `.env.example` verified complete against `env.server.ts` (all 13 vars).

### E2E (Playwright)
- `playwright.config.ts` — isolated `e2e/.tmp-data` root, own port 5177, fresh
  wipe→seed→dev per run, serial single-worker, real-login `auth.setup.ts` + stored session.
- 6 spec files / **13 tests**, all passing, covering the golden paths:
  1. login → home (3 projects) → board (columns + VIB-142 card)
  2. open VIB-142 → packet → resolve "Request one edit" → packet clears + decision event
  3. take ownership of VIB-148 → operator reaction event; comment `@operator` → routed card
  4. VIB-151 live run strip visible + agent logs stream + raw toggle
  5. review queue reflects post-resolution state; activity feed; notifications mark-all-read;
     profile theme switch persists across reload
  6. org settings tabs render; StoreBrowser creates a folder (real fs mutation)

### Manual pass + fixes
- Full sweep as **admin** (arda) and **reviewer** (selin) in the browser.
- **RBAC verified live**: reviewer sees the Policy surface with all mutation controls
  disabled (0 enabled role pickers, 28 disabled controls); non-org-admin gets HTTP 403 on
  `/org/settings` (server-side enforcement, matching the unit-tested denied paths).
- **Fixes made this phase:**
  - Three e2e specs were asserting against the wrong DOM (all were *spec* bugs — the app
    was correct in every case, confirmed live): (a) `button hasText "Comment"` also matched
    the "Comments" filter tab → exact-name submit selector; (b) StoreBrowser trigger is an
    icon button `aria-label="Browse files in <name>"`, not text "Browse"; (c) the theme
    spec reloaded before the async `/prefs/theme` POST persisted the cookie → now waits for
    the `viberr_theme` cookie before reload. Theme persistence, comment routing, and the
    store mutation were all verified working live via the preview browser.
  - Polish: the shell user menu's stale admin "Org users (temp)" link now points to the
    real `/org/settings` and is relabeled "Org settings".

## Final verification matrix

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **753 passed** (90 files) |
| `npm run build` | clean |
| `npm run e2e` | **13 passed** |
| Live admin sweep (all rail views, org settings, profile, notifications) | clean, console clean |
| Live reviewer RBAC sweep | controls gated; `/org/settings` → 403 |
| Docker image build + container run | **verified** — boots, migrates, health 200, auth gate, in-container seed populates 3/10 |
| Store restored pristine | 10 tasks / 32 events / 18 runs / 0 diagnostics |

## Known gaps (carried into README release notes)
No mailer (in-app notifications only); org-scoped audit recorded but only project-scoped
audit has a UI; provenance/audit/run-log tables grow without automated retention;
notifications page caps at 200 rows; stub-project task deep-links 404 by design; Home
GitHub-connections tile counts project repos not org connections; MCP credential UI not
built; fine-grained PAT scope checks partly probe-based; GitHub reconcile is manual (no
scheduler). All deliberate V1 boundaries, not defects.

## Status
**ALL PHASES COMPLETE.** The full Viberr application is built, tested, and verified.
