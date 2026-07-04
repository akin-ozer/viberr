# Phase 1 report — Scaffold & foundations

Status: complete. All verification gates pass (`npm run typecheck`, `npm run build`,
`npm test` 16/16, dev server 200 on :5173 with placeholder rendered, production
`npm run start` boots and serves 200, fail-fast env validation confirmed).

## File inventory

```
package.json  package-lock.json
react-router.config.ts        # ssr: true
vite.config.ts                # reactRouter + tsconfigPaths plugins; PORT from .env, default 5173, strictPort
tsconfig.json                 # RR7 standard (paths ~/* → app/*, rootDirs with .react-router/types)
vitest.config.ts              # SEPARATE from vite.config.ts — node environment, no RR plugin
.env                          # real random secrets, gitignored — regenerate freely
.env.example                  # documented placeholders for every variable
public/favicon.svg            # simple V mark (mock ships no favicon)
app/
  root.tsx                    # Layout (theme attr + boot script), App, ErrorBoundary, root loader
  routes.ts                   # explicit RouteConfig: index("routes/_index.tsx")
  app.css                     # viberr.css ported VERBATIM (lines 1–2035) + "/* === app additions === */" section
  entry.client.tsx            # stock RR 7.18.1 (npx react-router reveal)
  entry.server.tsx            # stock + bootServer() call at module scope + JSON logger for stream errors
  routes/_index.tsx           # placeholder panel "Viberr — foundation online" (replaced in phase 4)
  server/
    boot.server.ts            # bootServer(): getEnv() + getDb() once per process
    config/env.server.ts      # typed env (zod v4)  [+ env.server.test.ts, 9 tests]
    db/sqlite.server.ts       # openDatabase/getDb/closeDb/getProjectionDbPath
    db/migration-runner.server.ts  # runMigrations, DEFAULT_MIGRATIONS_DIR  [+ migration-runner.server.test.ts, 7 tests]
    errors/error-codes.ts     # ERROR_CODES stable strings (no .server suffix — isomorphic constants)
    errors/app-error.server.ts      # AppError + factories + isAppError
    errors/error-response.server.ts # toErrorResponse(error, requestId?) → Response
    logging/logger.server.ts  # createLogger/logger (JSON lines, child bindings)
    theme/theme-cookie.server.ts    # viberr_theme cookie read/serialize
db/migrations/0001_app_foundation.sql   # users, sessions + indexes
scripts/run-migrations.ts     # npm run migrate (tsx)
scripts/seed.ts               # exits 1 with "arrives in phase 3" message
```

## Package versions chosen (verified via `npm view`, in lockfile)

- **react-router / @react-router/node / @react-router/serve / @react-router/dev 7.18.1** —
  note React Router **v8 is out** (8.1.0); the plan locks v7, so I pinned `^7.18.1`
  (won't drift to 8). `create-react-router@7.18.1` scaffolds an RR8 template, so the
  template was used for file structure only; deps were hand-pinned.
- react / react-dom 19.2.7, vite 7.3.6 (not 8 — newest major, RR7 peer-supports both,
  7 is the conservative choice), typescript 5.9.3 (not 6.x), vitest 4.1.9, tsx 4.23.0,
  better-sqlite3 12.11.1 (+ @types 7.6.13), zod 4.4.3, dotenv 17.4.2, isbot 5.1.44,
  @types/node ^24 (host runs Node 24), vite-tsconfig-paths 6.1.1,
  @fontsource/noto-sans 5.2.10, @fontsource/jetbrains-mono 5.2.8, @fontsource/manrope 5.2.8.

## How things work (interfaces phase 2+ will use)

### Env — `app/server/config/env.server.ts`
- `getEnv(): Env` — parses `process.env` once per process (cached on
  `Symbol.for("viberr.env")` global, survives HMR). Throws a multi-line Error listing
  every missing/invalid var. Loads `.env` via dotenv at module top (`quiet: true`,
  never overrides real env).
- `parseEnv(raw: Record<string, string | undefined>): Env` — pure, used by tests.
  Empty strings are treated as unset.
- `Env` fields: `NODE_ENV` ("development"|"production"|"test", default development),
  `PORT` (number, default 5173), `VIBERR_SESSION_SECRET` (string ≥32),
  **`VIBERR_SECRET_ENCRYPTION_KEY` is a `Buffer`** (base64 decoded, exactly 32 bytes —
  feed it straight to AES-256-GCM in phase 7), `VIBERR_DATA_ROOT` (default "./data"),
  optional `GITHUB_OAUTH_CLIENT_ID/SECRET`, `GOOGLE_OAUTH_CLIENT_ID/SECRET`,
  `VIBERR_SEED_ADMIN_EMAIL/PASSWORD`.
- `resetEnvCacheForTests()` for tests.

### DB — `app/server/db/`
- `getDb(): Database.Database` — process-wide singleton (Symbol.for("viberr.db")).
  First call opens `${VIBERR_DATA_ROOT}/state/projection.sqlite` (mkdir -p), sets
  pragmas `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, and runs
  pending migrations. Just `import { getDb } from "~/server/db/sqlite.server"` and use it.
- `openDatabase(dbPath)` — low-level open with pragmas (scripts/tests).
- `getProjectionDbPath()`, `closeDb()`.
- `runMigrations(db, migrationsDir = DEFAULT_MIGRATIONS_DIR): { applied, alreadyApplied }`
  — applies `db/migrations/*.sql` in filename order, each file in its own transaction,
  bookkeeping in `schema_migrations(filename PK, applied_at)`. Idempotent.
- **To add a migration:** drop `db/migrations/0002_your_name.sql` (plain SQL, no
  BEGIN/COMMIT inside — the runner wraps it). It auto-applies at next boot / `npm run migrate`.
- Migrations run automatically at boot via `bootServer()` (called from
  entry.server.tsx module scope) and manually via `npm run migrate`.
- Schema now: `users` (id, email [unique via idx_users__email], name, title, role
  CHECK admin/member/viewer, password_hash NULL, idp default 'local', avatar_tone,
  pwreset_required 0/1, theme CHECK light/dark/system default 'system', disabled 0/1,
  created_at, updated_at — ISO 8601 UTC strings), `sessions` (id, user_id FK ON DELETE
  CASCADE, created_at, expires_at, ip, user_agent; idx_sessions__user_id,
  idx_sessions__expires_at).

### Logging — `app/server/logging/logger.server.ts`
- `logger.info(msg, fields?)` / debug / warn / error → one JSON line on stdout:
  `{ level, time (ISO), msg, ...boundFields, ...fields }`. Error instances in fields
  are serialized to `{ name, message, stack }`.
- `logger.child({ requestId })` returns a bound logger. `createLogger(bindings)` factory.
- Level: `LOG_LEVEL` env override, else debug in dev / info in production.
- Import-safe from anywhere server-side (imports nothing else).

### Errors — `app/server/errors/`
- `ERROR_CODES` (error-codes.ts): internal_error, not_found, validation_failed,
  unauthorized, forbidden, conflict, config_invalid, db_migration_failed. Add codes there.
- `new AppError({ code, status?, message?, userMessage?, details?, kind?, cause? })`,
  `AppError.notFound/validation/internal`, `isAppError(v)`. `kind` is
  "user" | "diagnostic" | "infrastructure" per CONVENTIONS error taxonomy.
- `toErrorResponse(error, requestId?): Response` — AppError → its status +
  `{ error: { code, message: userMessage, details? } }`; Response passes through;
  anything else → logged + opaque 500. Use in loader/action catch blocks.

### Theme — cookie + root.tsx
- Attribute the CSS uses: **`data-theme` on `<html>`, values "dark" (or anything else
  = light)**; light is the `:root` default. Mock also has `data-motion="reduce"` (not
  wired yet, see gaps).
- Cookie `viberr_theme` ∈ light|dark|system (plain value, NOT HttpOnly so a client
  switcher may write it; SameSite=Lax; ~400d). Helpers in
  `app/server/theme/theme-cookie.server.ts`: `getThemePreference(request)`,
  `serializeThemePreference(theme)` (use as a `Set-Cookie` header from the phase-4
  theme-switcher action), `THEME_COOKIE_NAME`, `isThemePreference`.
- Root loader (route id `"root"`) returns `{ theme }`. `Layout` renders
  `<html data-theme={...} suppressHydrationWarning>` (explicit prefs SSR exactly;
  "system" SSRs light) plus an inline `<script>` in `<head>` that resolves "system"
  against `prefers-color-scheme` **before first paint** and live-follows OS changes
  via a matchMedia listener. No flash; hydration verified clean.
- Phase 4's switcher: POST action → `Set-Cookie: serializeThemePreference(v)` →
  revalidation re-renders; users.theme column exists for per-user persistence later.

### Fonts (no CDN)
The mock's `<head>` loads Google Fonts (Noto Sans 400–700, JetBrains Mono 400–600,
Manrope 500–800) and overrides `--font-display` to Manrope (Roobert PRO isn't
web-available). Solution: @fontsource packages side-effect-imported at the top of
`root.tsx` (exact same weights); Vite bundles the woff2 files into `build/client/assets`
— verified zero external URLs in built CSS. The `--font-display` Manrope override
lives in the app-additions section of app.css (ported from the mock's inline style).

### CSS
`app/app.css` = `design/html-app/app/viberr.css` **verbatim** (diff-verified) + marked
`/* === app additions === */` section at the end. Only append below the marker
(currently: the --font-display override + `.app-splash` splash/error layout).
`design/html-app/app/home.css` was NOT ported — it belongs to the Home surface (phase 4).

### Routes
Registered explicitly in `app/routes.ts` (`RouteConfig` array using
`index()/route()/layout()/prefix()` helpers from `@react-router/dev/routes`). Add e.g.
`route("login", "routes/login.tsx")`. Route modules get generated types from
`./+types/<name>`; run `npm run typecheck` (typegen) after adding routes.

### npm scripts
dev (RR dev on PORT/5173, strictPort) · build · start (react-router-serve; reads real
env; dotenv also loads inside the bundle) · typecheck (typegen && tsc) · test
(vitest run, node env) · migrate · seed (exits 1 until phase 3).

## Deviations / notes

1. **React Router 8 exists** (8.1.0). Plan locks v7 → used 7.18.1. If a later phase
   wants v8, that's an orchestrator decision (v8 template also drops `resolve.tsconfigPaths`
   differences; we use the vite-tsconfig-paths plugin under Vite 7).
2. `app/server/theme/` is not in the CONVENTIONS server-dir list — added as the home
   for the theme cookie helper (profile-adjacent; can merge into auth/profile later).
3. `error-codes.ts` intentionally has no `.server` suffix (per plan wording): stable
   codes may be shared with client code eventually.
4. Mock's `data-motion="reduce"` preference is not wired yet — it's a per-user
   pref surfaced in the profile page (phase 9).
5. Added `public/favicon.svg` (mock ships no favicon; avoids RR-branded default/404).
6. Vitest config is separate (`vitest.config.ts`), NOT merged into vite.config.ts —
   the RR plugin must not load in test mode.
7. Test caveat: `.env` is auto-loaded by importing env.server (dotenv at module top);
   tests therefore only use the pure `parseEnv`, never `getEnv`.

## Known gaps (intentional, later phases)

- No auth/sessions logic yet (phase 2) — only the tables.
- No file store, watcher, projections, seed data (phase 3).
- Placeholder index route + splash CSS get replaced by real Home/shell (phase 4).
- No request-id middleware yet; `logger.child({ requestId })` + `toErrorResponse`'s
  requestId param are ready for it (phase 2 can add it with auth middleware).
