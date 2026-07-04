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

## ORCHESTRATOR RULINGS (binding; resolve docs/build/specs/cross-cutting-contracts.md §7 — read that doc)

1. Readiness: canonical 4-value enum in files/Zod/SQLite; ONE mapping module → mock pill CSS kinds/labels (`input`, `risk`, ...); "accepted" is a derived display state (stage done + accepted), never stored readiness.
2. Roles: THREE separate systems, kept separate. Org roles `admin|member` (schema tolerates `viewer`, UI uses admin|member). Project membership roles `admin|maintainer|reviewer|viewer` with the 9-row RBAC grant table from contracts §3.2, stored in project.md membership + enforced server-side. Agent capability policy per profile (`direct|recommend|human`), id-based against a shared CAP_CATALOG (`{capabilityId, mode}` + display-only extras); always-human server invariant list: merge PR, transition to done, change project policy.
3. Task-file store per BUILD-PLAN (`$VIBERR_DATA_ROOT/projects/<slug>/tasks/<KEY>/task.md`); UI renders the REAL store-relative path wherever the mock showed `.viberr/...`.
4. Timestamps: UTC ISO at all boundaries; one shared formatter in app/shared/dates/ reproducing mock display forms (today→`H:MM`, else `{day} · {t}`, relative forms for home/store). Seed back-dates events so rendering matches mock.
5. PAT scope violations: server-derived per-scope validator results + per-violation open/resolved records; rail badge = open violation count; grant/re-validate writes typed `policy` event to the violation's own task, audit + SSE. No global boolean.
6. Identity: compare by user id everywhere; display names are render-only. Session user id is authoritative.
7. Packet options carry a stable `kind` (accept_completion | request_edit | block_on_policy | hold_runtime_debug | redirect | custom) — never dispatch on English titles. Accept-completion triggers a real async PR merge (Phase 7) with an explicit failure state.
8. tweaks-panel.jsx: DO NOT PORT (dev harness, dead code). review.jsx: packet/acceptance mechanics in Phase 5, queue surface in Phase 9, new `app/features/review/`.
9. Notifications: per-user rows in SQLite, sorted by real timestamp DESC; task/project references are soft refs; seed two small stub projects (deploy-pipeline, billing-service) so cross-project rows navigate for real.
10. "Waiting on you"/review queue stay project-wide in V1 (do not scope per-user, do not change labels).
11. Run lifecycle stored `queued|running|finished|error|interrupted`; map to mock pills (queued→neutral "queued"; interrupted→neutral "interrupted · by <actor>" footer). Raw NDJSON/JSONL is truth; LogLine display is a projection. Elapsed from startedAt; tokens from real usage envelopes only.
12. PR states: merged→done pill; open/draft→"in review"; closed-unmerged→risk pill "closed". Sync pill precedence merged > behind > synced, from real compare data.
13. Prefs: drop `ghConnected` (derive), keep email/nudge prefs schema-only (no mailer in V1), DO mount ProfileAppearance, map plural pref ids ↔ singular notification kinds explicitly.
14. Shared single implementations for: notification meta, markdown-ish stripper + rich-text renderer, cred-card, bell popover (parameterized). All toast/empty-state/boundary copy in specs is verbatim contract — including intentionally divergent board vs review wording.
15. Stages: per-project list in project.md (accept hex or var(--*) colors); instance-default workflow template (incl. "Lightweight · 3 stages") defined in Phase 3 config for org surfaces + project creation.
16. Deliberate keeps: board rail count includes Done; `.card.urgent` stays visually untreated; `data-screen-label` attributes kept app-wide. Additions: minimal list-view empty state; Escape-close + focus-trap + scrim-click on every dialog (markup unchanged). `operator.since`: store stage id, render "stage <1-based index>". Login keeps mock's explicit copy but password min is 8; local dev seed password `viberr-dev-2828`.

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
