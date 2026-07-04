# Build state

**Current status:** Phase 2 complete (auth & org). Phase 3 (file store & projections) not started.

## Environment facts

- Repo root: /Users/akinozer/projects/viberr (git initialized, branch main). planning/ and design/ are read-only reference.
- macOS (darwin), zsh. Node available via system. Dev server port 5173 expected by .claude/launch.json (`npm run dev`).
- Data root for dev: ./data (gitignored).

## Phase log

- Phase 0 (orchestrator): read PRD/architecture/change-proposals/mock entry points; wrote BUILD-PLAN.md, CONVENTIONS.md, STATE.md; created git repo and task list.
- Phase 1: RR7 (7.18.1) SSR app at repo root, no Tailwind; viberr.css ported verbatim → app/app.css (+marked additions); @fontsource fonts (no CDN); viberr_theme cookie light/dark/system with pre-paint script; typed env (zod4, fail-fast, key as 32-byte Buffer); better-sqlite3 WAL + migration runner + 0001 (users, sessions); JSON logger + AppError/toErrorResponse; scripts dev/build/start/typecheck/test/migrate/seed; 16 tests green; typecheck/build/dev(:5173)/start all verified. See docs/build/reports/phase-1.md.
- Phase 2: auth & org. Migration 0002 (users +last_login_at/+created_by, audit_events); scrypt passwords (`scrypt$N$r$p$salt$hash`, min 8); server sessions (sha256-hashed ids, 30-day sliding, daily sweeper, rotation) behind signed httpOnly `viberr_session` cookie; CSRF (origin/sec-fetch-site + session-bound token via root loader + <CsrfInput/>); login/logout/forced-reset flows ported 1:1 from login.jsx (+reset step, providers, flash); GitHub/Google OAuth (state cookie, PKCE for Google, verified-email whitelist = user row exists, idp update) active only with env creds; requireUser/requireRole/authenticate helpers; user-admin server fns + TEMP /org/users admin page (replace in phase 9); boot seed admin (env or generated+logged once); audit recorder wired for all auth/org events; full app/ui primitive set (icon/avatar/pill/identity/page-overlay/toggle/toast/csrf-input); orchestrator rulings folded in (roles surfaced admin|member, data-screen-label kept, pw min 8). 100 tests green; typecheck/build/dev+curl+browser flows verified. See docs/build/reports/phase-2.md.
