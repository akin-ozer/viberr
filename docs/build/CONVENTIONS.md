# Conventions (condensed from planning/planning-artifacts/architecture.md — that doc wins on conflict)

## Layout

```
app/
  root.tsx, routes.ts, app.css, entry.client.tsx, entry.server.tsx
  routes/          # thin route modules only; delegate to features/server
  ui/              # reusable primitives (button, badge, dialog, icon, avatar, toast...) — MUST NOT import from features/
  features/        # per-surface UI + loaders/actions glue: auth/, board/, task-detail/, project-admin/, org-admin/, live-updates/, home/, agents/, github/, activity/, notifications/, profile/
  schemas/         # shared Zod schemas (task-file, project-file, sse-event, auth, github-pat, api-error)
  server/          # server-only: config/, db/, files/, interpretation/, projections/, provenance/, auth/, secrets/, github/, runtimes/, events/, errors/, logging/, audit/
  shared/          # narrow cross-surface helpers (dates/, ids/, mapping/)
db/migrations/*.sql   scripts/*.ts   e2e/   test-support/
```

- Server-only files: `*.server.ts` suffix. Never import server modules into client components.
- Tests co-located: `foo.server.test.ts`. No `utils.ts`/`helpers.ts` dumping grounds.
- Files/dirs kebab-case; components/types PascalCase; vars/functions camelCase; constants UPPER_SNAKE_CASE.

## Data & naming

- SQLite: plural snake_case tables (`users`, `sessions`, `task_projections`, `audit_events`), snake_case columns, `<entity>_id` FKs, `idx_<table>__<cols>` indexes. DB rows map to camelCase via centralized mapping in `app/shared/mapping/`.
- TS/JSON: camelCase. Timestamps: UTC ISO 8601 strings at all boundaries and in files. Booleans stay booleans; null stays null.
- Readiness values exactly: `ready` | `input_required` | `inconsistency_risk_detected` | `blocked`. Derivation lives ONLY in `app/server/interpretation/readiness-policy.server.ts`.
- JSON endpoints (rare, only for automation): success `{ data, meta? }`, error `{ error: { code, message, details? } }`, real HTTP status codes. Loaders return route-shaped data directly.
- SSE: event names lowercase dot-separated facts (`task.updated`, `task.readiness-changed`, `projection.rebuilt`, `run.log-appended`, `auth.session-expired`); payload `{ type, entityId, occurredAt, data }` — compact facts + references, never fat objects.
- Errors: typed `AppError` with stable machine codes (`app/server/errors/`). Never leak stack traces or secrets to users. Distinguish user-correctable / inconsistency-diagnostic / infrastructure.

## Behavior rules

- Files are the only canonical business truth. The app writes files through dedicated writer modules (frontmatter-preserving), then re-parses → re-projects → publishes SSE. Never write projections without file backing for task/project state.
- Tolerant parsing: malformed input produces diagnostics + readiness downgrade (`input_required` / `inconsistency_risk_detected` / `blocked`), never a crash, never a silent drop.
- No optimistic UI for governed state; revalidate after action + on SSE.
- Mutating actions must be idempotent-safe (idempotency keys or existence checks) — retries must not duplicate transitions/branches/PRs/events.
- Every governed action (approval, transition, ownership change, policy change, PAT change, run start/interrupt) → audit event + (where user-visible) typed timeline event in task.md.
- Secrets: only from env; PATs encrypted (AES-256-GCM) in SQLite; never in files under projects/, never in logs, timelines, SSE, or error messages.
- RBAC on actions, not on file existence: `admin` (manage org/users/policy/release any owner), `member` (full task work, take/release own ownership), `viewer` (read + comment). Agents get capability policy per project — enforced server-side on agent-triggered actions.
- Human-only: transition to done / completion acceptance. Enforce server-side.

## UI porting rules

- The mock (`design/html-app/app/*.jsx`) is the design source of truth: reproduce structure, class names, and behavior 1:1 unless the mock is prototype-only (localStorage session, `location.href` page hops, `window.VIBERR` globals) — replace those with real routes/loaders/actions/SSE.
- Keep `viberr.css` classes and CSS variables exactly; add new CSS only in clearly-marked appended sections of `app/app.css`. NO Tailwind, no inline hex colors — use existing tokens (`var(--teal)` etc.).
- Icons: the mock's `Icon` component (in `ui.jsx`) — port it to `app/ui/icon.tsx` once, reuse everywhere.
- Theme: light/dark/system, persisted per user (profile) + cookie for SSR-safe first paint.
- Toasts for action feedback, packet-styled confirm dialogs (see mock `review.jsx`/ownership dialogs).
- Loading states: React Router pending states; no spinners-forever; long ops report server-derived progress.
- Accessibility: keep the mock's aria-* usage; visible focus; keyboard menus/dialogs (Escape closes, scrim click closes).

## Route map (target)

```
/login  /logout  /auth/github  /auth/github/callback  /auth/google  /auth/google/callback
/                         → home (project list)
/projects/:slug           → redirect board
/projects/:slug/board     /review  /agents  /policy  /github  /activity  /settings
/projects/:slug/tasks/:key
/org/settings             (org admin, tabbed)
/profile   /notifications
/resources/events         (SSE)   /resources/health
```
(Adjust to mock reality where the mock differs; document deviations in your phase report.)
