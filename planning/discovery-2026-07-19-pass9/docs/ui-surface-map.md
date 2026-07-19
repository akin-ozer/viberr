# Viberr UI Surface Map (pass 9)

Scope: every route and feature surface in `app/`, and which parts are REAL vs
mock/unwired/placeholder. Branch `main`, repo root `/Users/akinozer/projects/viberr`.

Method: read every file in `app/routes/` and `app/routes.ts`; deep-scanned every
non-test file in `app/features/*` (three parallel sub-scans) and traced each UI
intent to its server `case`. Cross-checked each README "Known gaps (V1)" item
against code.

**Headline finding:** the app was ported from a static mock (`design/html-app/`)
but the port is thorough. Every route loader/action pulls REAL data from
projections / the file store / the connections/secrets stores. No inert buttons,
`href="#"`, empty `onClick`, "coming soon", or hardcoded-in-JSX fake data were
found on any surface. The prototype's fabricated bits (fake token growth
`tick*42`, unconditional pills, toast-only GitHub links, mock resource catalogs)
were explicitly removed. The most notable issues are **three README "known gaps"
that are actually already closed in code** (stale docs), plus two cosmetic/honesty
nits. Details in the final section.

---

## 1. Route table

Source: `app/routes.ts`. Layout nesting shown by indentation.

| Path | Module | Feature dir | What it does |
| --- | --- | --- | --- |
| `/` (index) | `routes/_index.tsx` | `features/home/` | Home / multi-project landing. Loader: real projects, prefs, org summary, notifications. Actions: pin, view-toggle, rescan (admin), rebuild-projections (admin), create-project. |
| `/login` | `routes/login.tsx` | (inline) | Sign-in (providers + local creds) and forced set-new-password step. Loader reflects which OAuth providers are configured. |
| `/logout` | `routes/logout.tsx` | — | POST revokes better-auth session + audit row. |
| `/org/users` | `routes/org.users.tsx` | — | Legacy redirect → `/org/settings?tab=users`. |
| `/org/settings` | `routes/org.settings.tsx` | `features/org-settings/` | Org admin surface (admin-only). Tabs: connections, users, resources. ~25 CSRF POST intents (connections, users/domains, kb/mcp/skill/agent CRUD, store-browser). |
| `/api/auth/*` | `routes/api.auth.$.ts` | — | better-auth request handler (sign-in/out, social, getSession). |
| `/profile` | `routes/profile.tsx` | `features/profile/` | PageOverlay. Identity, notif routing, appearance, RBAC read view, GitHub identity, self password change. |
| `/notifications` | `routes/notifications.tsx` | `features/notifications/` | PageOverlay. Waiting-on-you cards + everything-else stream. Loader caps at newest 200. |
| `/notifications/read` | `routes/notifications.read.tsx` | — | POST mark-read / read-all (fetcher target, no UI). |
| `/prefs/theme` | `routes/prefs.theme.tsx` | — | POST theme cycle → user row + cookie (fetcher target). |
| `/resources/events` | `routes/resources.events.ts` | `features/live-updates/` | SSE stream driving scoped route revalidation (Phase 6). |
| `/resources/run-log` | `routes/resources.run-log.ts` | `features/runtime/` | GET run-log tail since seq (logs consumer). |
| `/resources/health` | `routes/resources.health.ts` | — | GET ops probe `{ ok, projections, watcher, backends }` (unauthenticated by design). |
| `/resources/model-catalog` | `routes/resources.model-catalog.ts` | `features/agents/` | GET model+effort catalog per backend (create/edit modal). |
| `/resources/session-export` | `routes/resources.session-export.ts` | `features/runtime/` | GET bash installer carrying a run transcript to resume locally. |
| `/projects` | `routes/projects.tsx` | — | Redirect → `/` (bare projects has no listing, N5). |
| `/projects/:slug` | `routes/project.tsx` | `features/shell/` | Workspace shell (rail + topbar + Outlet). Loader: board, myRole, live rail counts, violations, notifications. |
| `/projects/:slug` (index) | `routes/project._index.tsx` | — | Index child; loader redirects `/projects/:slug` → `/projects/:slug/board`. |
| `/projects/:slug/board` | `routes/project.board.tsx` | `features/board/` | Kanban board. Actions: create-task, reorder (drag/drop), rescan. Data from layout loader. |
| `/projects/:slug/review` | `routes/project.review.tsx` | `features/review/` | Review queue (read-only projection, member-scoped acceptance split). |
| `/projects/:slug/agents` | `routes/project.agents.tsx` | `features/agents/` | Agent governance. Loader: profile roster, deployments, stages, live resource catalog. Actions: create/update/delete-profile. |
| `/projects/:slug/policy` | `routes/project.policy.tsx` | `features/policy/` | Governance matrix. Actions: set-role, set-boundary (both admin-gated). |
| `/projects/:slug/github` | `routes/project.github.tsx` | `features/github/` | GitHub surface. Actions: reconcile, grant-scope, set/clear-credential (maintainer+). |
| `/projects/:slug/activity` | `routes/project.activity.tsx` | `features/activity/` | Activity stream + audit log (read-only projections, loader pagination). |
| `/projects/:slug/settings` | `routes/project.settings.tsx` | `features/project-settings/` | Project admin. ~13 action intents (identity, stages, members, override, credential, archive, delete). |
| `/projects/:slug/tasks/:key` | `routes/project.task.tsx` | `features/task-detail/` + `features/runtime/` | Full task workspace. ~20 action intents (comment, transition, owner/specialist/reviewer, run-operator, resolve-packet, complete-merge, recommendations, schedule). |

Note: `resources.events.ts` (SSE) and `api.auth.$.ts` (better-auth splat) are
infra endpoints, all real.

---

## 2. Per-surface: real vs mock

Verdict legend: **REAL** = loader/action reads/writes the live store; controls
wired to server actions.

### Home — `routes/_index.tsx` + `features/home/home-page.tsx`
- **REAL.** Loader pulls `listHomeProjectsForUser`, `getHomeOrgSummary`,
  `getHomePrefs`, `listNotifications` (`_index.tsx:40-49`). All from Phase-3
  projections / stores.
- Project search box **filters for real** — `matchesQuery` over name/key/repo
  (`home-page.tsx:1294-1304`), empty-state "No project matches" (`:966`). ⌘K
  focuses it (`:1186-1195`). Not decorative.
- New-project modal: connection field offers **real** `connectionOwners`
  (`home-page.tsx:690`, from the connections store); template/policy picks are
  real form fields feeding `create-project`.
- Store strip (Re-scan / Rebuild projections) rendered **only for admins**
  (`home-page.tsx:1143`) so it never silently 403s; both wired to real actions.
- GitHub connections tile: reads `org.connectionOwners` (`home-page.tsx:1065`)
  from the **real connections store** (`home-query.server.ts:276`
  `listConnections(db)`). See §3 — README says this "derives from project repos";
  that is stale.

### Board — `routes/project.board.tsx` + `features/board/board-page.tsx`
- **REAL.** Columns/orphans from the layout loader; create-task, drag-drop
  `reorder`, and `rescan` are real POSTs with both-outcome toasts
  (`board-page.tsx:841-942`). Same-stage drop short-circuits (`:849-858`).
- Nit: comment at `board-page.tsx:762` says "dropdown" but the impl is
  drag-and-drop (cosmetic doc drift, no functional impact).

### Task detail — `routes/project.task.tsx` + `features/task-detail/*` + `features/runtime/*`
- **REAL.** ~20 action intents, all mapping to real `task-actions.server` /
  `specialist-run.server` / `operator-run.server` / `run-service.server`
  mutations. Toast copy is the verbatim spec contract, computed server-side.
- Runtime panels: token/elapsed come from `run.tokens`/`run.startedAt` props;
  the mock's fabricated `tick*42` growth was removed (`runs-panels.tsx:20-22`,
  `runs-helpers.ts:9`). Interrupt (`runs-panels.tsx:212`) and retry-on-other-
  backend (`:418-429`) are real, RBAC+state gated.
- `execution-profile.tsx:356` `aria-disabled` is a **non-interactive empty-state
  label** ("All deployed specialists are already reviewers"), not a dead button.
  "Run operator" `disabled` (`:427-440`) is busy/terminal-stage only (G9).
- Session export button is a real `<a href="/resources/session-export?run=…">`
  shown only for non-simulated runs with a session id.
- `PolicyPanel` (`task-detail-page.tsx:192`) renders fixed "V1 platform rules"
  text, but each row value is computed live via `roleCan(myRole,…)` — static
  copy driven by real role, not invented per-task data.

### Review queue — `routes/project.review.tsx` + `features/review/review-page.tsx`
- **REAL, read-only by spec.** Loader `getReviewQueue` with member-scoped
  acceptance split. Zero mutations; rows + policy chip navigate
  (`review-page.tsx:82-84`). Not unwired — intentionally a triage list.

### Agents — `routes/project.agents.tsx` + `features/agents/*`
- **REAL.** Roster = org templates ⊕ project deployments; live deployment
  projection; live resource catalog (`project.agents.tsx:53`,
  `buildResourceCatalog`). Create/update/delete-profile write `project.md`.
- Create/edit modal resource picker pulls the **live catalog**, not a mock list
  (`create-profile-modal.tsx:769`); empty store → empty picker with "None in the
  store yet" (`:645-650`), never a mock fallback. The old hardcoded mock catalog
  (`repo-write`, "Coding standards") was explicitly removed
  (`create-profile-modal.tsx:761-768`; loader comment `project.agents.tsx:48-52`).
- Model/effort catalog fetched live from `/resources/model-catalog`.

### Policy — `routes/project.policy.tsx` + `features/policy/policy-page.tsx`
- **REAL.** set-role and set-boundary POST real intents (`policy-page.tsx:444-458`).
  Disabled states are RBAC/busy (`:122,382`) or the terminal Review→Done "locked ·
  V1" lock (`:366-396`). Non-admin read-only by design.

### GitHub — `routes/project.github.tsx` + `features/github/github-view.tsx`
- **REAL.** Reconcile (`github-view.tsx:351-358` → `runReconcile` →
  `reconcileProject`), grant-scope, set/clear-credential are real POSTs,
  RBAC-gated (`canGrant`) and state-gated (`hasCredential`).
- Scope chips render **server verdicts directly** (`credential-card.tsx:90-95`);
  the mock's `s.ok || scopeGranted` fudge is gone. Unprobed PAT → honest
  "scopes not yet verified" branch (`credential-card.tsx:71-79,126-134`).
- Static labels "1 · V1 limit" (`github-view.tsx:147`) and "project default ·
  task-level override allowed" (`:141`) are intentional product-fact copy.
- Nit: no copy tells the user reconcile is manual-only / not scheduled (see §3).

### Activity — `routes/project.activity.tsx` + `features/activity/activity-page.tsx`
- **REAL, read-only.** Stream + audit from projections with loader-driven
  "Show older" pagination (`activity-page.tsx:180-188`). Actor filter is local
  state and (by mock parity) does not touch the audit panel.

### Project settings — `routes/project.settings.tsx` + `features/project-settings/settings-page.tsx`
- **REAL.** Every one of ~13 controls is a real route-action POST
  (`settings-page.tsx:795-916`): identity, stage rename/add/remove/reorder (DnD),
  member invite/remove, repo override, grant/set/clear credential, archive,
  delete (typed-name confirm `:593-651`). Disabled = RBAC (`!canManage`/`!isAdmin`),
  busy, or structural stage locks (`stageLockReason`). Shares the real CredentialCard.

### Org settings — `routes/org.settings.tsx` + `features/org-settings/*`
- **REAL, admin-only.** 3 tabs (connections / users / resources) URL-driven
  (`org-settings-page.tsx:15,17-21`). Every mutation is a CSRF POST via the
  `useOrgAction` hook.
  - Connections: add/replace/set-default/remove real; modal runs the real PAT
    validator before saving. Scope chips show the required-scope constant, checked
    only when `verified` (`connections-panel.tsx:222,241`).
  - Users & access: invite (github/google/domain/local), edit, role, reset-pw,
    disable/enable, remove, domain-remove — all real. Temp password shown once
    (no mailer).
  - Resources: kb/mcp/skill/agent CRUD real. **MCP credential field IS built** —
    `cred` is sealed AES-256-GCM and stored (`resources.server.ts:657-664`), not
    a stub (see §3). MCP reachability is a real stdio/HTTP probe
    (`resources.server.ts` `probeStdio` spawns the command via `child_process.spawn`).
  - **No org-level audit tab** — `SETTINGS_TABS` has only 3 entries; audit exists
    only at project level. Deliberate (README gap; see §3).

### Profile — `routes/profile.tsx` + `features/profile/profile-page.tsx`
- **REAL.** identity, set-notif, set-motion, set-tl-default, change-password,
  github-disconnect all fetch real intents (`profile-page.tsx:103,214,281,291,535`).
  Email field is `disabled` (read-only — legit, can't self-change email `:154`).
  Notification toggles are wired and functional: the `app` toggle is the **opt-out
  gate** that controls whether the notification row is ever written
  (`notification-prefs.ts:41-58`). GitHub connect uses the real better-auth social
  flow (`:445-460`); the old dead `/auth/github` href was removed.
- The RBAC "access" panel is read-only (informational); its "policy" link
  navigates for real (`profile-page.tsx:409`).

### Notifications — `routes/notifications.tsx` + `features/notifications/notifications-page.tsx`
- **REAL.** Loader `listNotifications` (cap 200), mark-read/read-all via the one
  `/notifications/read` action. Row click navigates to the real task, cross-project
  included (stub projects are seeded — see §3).

### Login — `routes/login.tsx`
- **REAL.** Local credentials → `loginWithCredentials`; social → better-auth
  `/api/auth/sign-in/social`. Unconfigured OAuth providers render **disabled with
  an explicit "not configured" label** (`login.tsx:357-415`) rather than looking
  clickable (loader `providers` flags reflect env). "Forgot password?" is an
  info-only affordance (no self-serve reset — admin resets; by design `:513-526`).

### KB browser — `features/kb-browser/store-browser.tsx`
- **REAL** (presentational). Upload files/folder, import-from-GitHub, mkdir, delete
  buttons all wired to parent handlers that POST the org.settings store intents
  (`store-upload`, `store-import-github`, `store-mkdir`, `store-delete`). Real disk
  tree via `local-files.ts` / `tree.ts`.

### Shell — `features/shell/{rail,topbar,user-menu,top-bell}.tsx`
- **REAL.** No inert controls (grep for `href="#"`/empty onClick/coming-soon/disabled
  returns nothing). Topbar search filters the board via `?q` and navigates from a
  non-board view (`topbar.tsx:54-82`). Bell popover + user menu wired.

---

## 3. Known-gaps (V1) cross-check

README lists these under "Known gaps (V1 release notes)" (`README.md:200-223`).
Verdict per item:

| # | README claim | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | **No mailer** — notifications in-app only; email/nudge prefs on profile are schema-only; invited users get a shown one-time password. | **TRUE (deliberate)** — but "email/nudge prefs schema-only" is *stale*: the dead email booleans + nudge shape were **removed entirely** (`notification-prefs.ts:9-13`); only the real in-app `app` opt-out toggle remains. Temp password shown once. | `notification-prefs.ts:11-12`; `org-users.server.ts:205`; `project-settings/settings-actions.server.ts:343` |
| 2 | **Org-level audit console** absent; only project-scoped audit has a UI. | **TRUE (deliberate)** — org-settings has only connections/users/resources tabs; audit UI is project-only (Activity → Audit). | `org-settings-page.tsx:15,17-21`; `activity/activity-page.tsx` (AuditLogs) |
| 3 | Provenance/audit tables grow unboundedly (no retention). | **TRUE (deliberate)** — no retention/cleanup job found; runbook documents manual cleanup. | (no scheduler for pruning; consistent with README) |
| 4 | **Notifications page caps at newest 200** (no pagination). | **TRUE** — hard `limit: 200`, no offset / "Show older". | `routes/notifications.tsx:34` |
| 5 | **Stub-project task links (DEP-31, BIL-7)** land on an in-shell 404; their tasks are **not seeded**. | **STALE / FALSE** — the stub tasks ARE seeded and open to real records. Also the key is wrong: it is **BIL-9**, not BIL-7. | `seedStubTasks` writes real DEP-31/BIL-9 files (`demo-data.server.ts:824-875`), invoked at `demo-seed.server.ts:215-231`; docblock: "opening either notification lands on a genuine task". |
| 6 | **Home "GitHub connections" tile** derives from project repos, not org connections. | **STALE / FALSE** — the tile reads the real org connections store. | `home-query.server.ts:276` `listConnections(db)` → `home-page.tsx:1065` renders `org.connectionOwners` |
| 7 | **MCP server credentials UI is not built** (org lists servers + probes reachability; secrets a follow-up). | **STALE / FALSE (mostly)** — a credential field exists, is sealed AES-256-GCM at rest, preserved on blank re-save, and read server-side for runs. | field `resources-panel.tsx:228-235` (placeholder `:233`) → intent `mcp-save` → `org.settings.tsx:264-276` → `saveMcpServer` seals via `sealSecret` (`resources.server.ts:657-664,726-752`); server-only decrypt accessor `resources.server.ts:419-435` |
| 8 | **Fine-grained PAT validation is partly probe-based** ("assumed" until first use). | **TRUE (deliberate)** — unverifiable fine-grained write scopes are marked `source: "assumed"` (granted until a real 403). The connections-panel chips show the *required* scope set (checked only when verified); the GitHub credential card labels unprobed scopes "not yet verified". | `pat-store.server.ts:297-302`; `pat-validator.server.ts:41,241,282,289,354`; `connections.server.ts:34` |
| 9 | **No scheduled GitHub reconcile** — refresh via explicit Reconcile action. | **TRUE (deliberate)** — reconcile is manual-only; no cron/interval reconciles GitHub. (Note: an operator-re-run scheduler DOES exist and is wired — `boot.server.ts:157` `startScheduleRunner` — but that fires operator runs, not GitHub reconcile.) | manual action only (`github-view.tsx:351-358`); no reconcile scheduler found |

Net: gaps #1–4, #8, #9 are genuine deliberate scope boundaries; **#5, #6, #7 are
stale README entries where the gap has actually been closed** (and #5 carries a
wrong task key). #1 has a minor stale sub-claim (email/nudge prefs removed, not
schema-only).

---

## 4. Forms / CSRF / no-op / disabled audit

- **CSRF:** every POST form/fetcher includes `_csrf`. The three org-settings
  panels (`connections-panel`, `resources-panel`, `users-panel`) don't reference
  `_csrf` directly but submit through the `useOrgAction` hook, which injects it
  (`use-org-action.ts:29,55-57`). Login uses `CsrfInput` on the set-password step;
  the login POST itself is guarded by `assertTrustedOrigin` (`login.tsx:67`).
  No form was found missing CSRF.
- **No-ops (all legitimate):** `policy-actions.server.ts:131,218` (same-value
  short-circuit, no event); `github-actions.server.ts:140` (`result:"noop"` =
  honest idempotent clear); `board-page.tsx:849-858` (same-stage drop);
  `agent-profile-actions.server.ts:165` (specialist repo-mutating tool denied →
  silent no-op by policy). None are unwired features.
- **Disabled controls:** every `disabled` found is attributable to RBAC
  (`!canManage`/`!isAdmin`/`!canGrant`), busy/in-flight, terminal task stage (G9),
  structural stage locks, or **unconfigured OAuth providers** (`login.tsx:361,390`)
  — none are "feature not built".
- **Coming soon / TODO / not-implemented in `app/routes` + `app/features`:** none
  found (grep clean of these literals in shipping code; only test files and
  design-parity comments mention "mock").

---

## Mocks / gaps / bugs

Tagged `[BUG]` / `[MOCK]` / `[POOR]`, sorted by surface. (No true `[MOCK]`
runtime data or `[BUG]` were found in the UI surface; the items below are
documentation/honesty issues and stale gaps.)

- **Board** — `[POOR]` `features/board/board-page.tsx:762` comment says the control
  "enables the per-card stage-move **dropdown**", but the implementation is
  drag-and-drop. Cosmetic doc drift; no functional impact.

- **Docs/README (Home tile)** — `[POOR]` `README.md:215-216` known-gap "Home GitHub
  connections tile derives from project repos" is **stale**: the tile reads the real
  connections store (`home-query.server.ts:276`). Update or drop the gap.

- **Docs/README (MCP credentials)** — `[POOR]` `README.md:217-218` "MCP server
  credentials UI is not built" is **stale**: the credential field is built, sealed,
  persisted, and read for runs (`resources-panel.tsx:228-235`;
  `resources.server.ts:657-664`). Update the gap (residual follow-up, if any, is
  threading the secret into a live agent MCP session — not the UI).

- **Docs/README (stub tasks)** — `[POOR]`/`[BUG-doc]` `README.md:213-214` says stub
  tasks "are not seeded" and land on a 404, and names **BIL-7**. Both wrong: the
  tasks are seeded (`demo-seed.server.ts:217`, `demo-data.server.ts:824-875`) and
  the key is **BIL-9**. Fix the doc.

- **Docs/README (profile prefs)** — `[POOR]` `README.md:204-206` says email/nudge
  prefs on the profile are "schema-only". Actually removed entirely; only the real
  in-app opt-out toggle remains (`notification-prefs.ts:9-13`). Minor wording fix.

- **GitHub** — `[POOR]` (honesty) `features/github/github-view.tsx` has **no copy**
  telling the user reconcile is manual/not scheduled. The action works; the missing
  hint is what README gap #9 implies should exist. Consider a one-line note near
  the Reconcile button.

- **Org settings** — `[gap, deliberate]` No org-level audit console
  (`org-settings-page.tsx:17-21`). Confirmed intentional (README gap #2); audit is
  project-scoped only. Flagged so an implementation pass knows it's a genuine
  missing surface, not an oversight.

- **Notifications** — `[gap, deliberate]` Hard cap at newest 200, no pagination
  (`routes/notifications.tsx:34`). Genuine V1 boundary (README gap #4).

- **Audit/provenance storage** — `[gap, deliberate]` Unbounded growth, no retention
  job (README gap #3). Not a UI surface but affects long-run health.

### Bottom line for the implementation pass
The UI surface is overwhelmingly real and wired — there is **no dead/mock control
to rip out**. The actionable work is: (a) reconcile the README "Known gaps" list
with reality (3 stale closed gaps, 1 wrong task key, 1 stale sub-claim), (b) two
cosmetic/honesty nits (board comment, missing "manual reconcile" hint), and (c) the
genuinely-deferred deliberate gaps (org audit UI, notifications pagination, audit
retention, no scheduled GitHub reconcile, no mailer).
