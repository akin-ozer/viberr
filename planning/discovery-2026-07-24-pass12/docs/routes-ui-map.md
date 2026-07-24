# Viberr — Routes + UI Surface Map (pass 12, 2026-07-24)

Audience: implementation subagents with **zero other context**. Every claim below is
verified against `main` at commit `0981cfa` (2026-07-24 — post-PR #87 round-2 fixes
`63cfe53`, post clean-sheet seed `e306248`/`625eb71`). All paths relative to the repo
root `/Users/akinozer/projects/viberr`. This supersedes
`planning/discovery-2026-07-23-pass11/docs/routes-ui-map.md`; see "Delta since
pass 11" near the end for what changed.

## 0. Architecture in one paragraph

React Router v8 **framework mode**. Route table is explicit in `app/routes.ts` (no
file-convention globbing — `app/routes/run-artifact-routes.server.test.ts` sits in the
routes dir but is never mounted). Every page loads via a route `loader` reading SQLite
projections (`getDb()` from `app/server/db/sqlite.server`); every mutation is a POST
route `action` dispatching on a form field named `intent`, guarded by
`requireFormAction` (`app/server/auth/form-action.server.ts:7` = better-auth session +
CSRF `_csrf` field check) or route-specific `requireAuth`/`requireRole`/
`requireProjectMember`. No optimistic UI for governed state — mutations return
`{ ok, toast }`, the client shows the server-computed toast, and SSE-driven
revalidation (`useLiveUpdates`) re-runs loaders. Client-computed toasts settle on the
server RESULT via the shared `useFetcherResult` hook (`app/ui/use-fetcher-result.ts` —
new in 63cfe53, P11-40). RBAC is single-sourced in `app/shared/rbac.ts`
(`ACTION_ROLES`; A=admin, M=maintainer, C=contributor, V=viewer) and enforced
server-side via `assertProjectAction`/`requireRunAgents`
(`app/server/auth/project-authority.server.ts`); org admins pass every project gate as
the audited "D2 override". The seed is clean-sheet (e306248): the product ships zero
demo boards; **no route or loader references demo data** (verified — no
`demo-data`/`demo-seed` import outside `*.test.*`; the mock dataset lives in
`test-support/demo-data.ts` + `test-support/demo-seed.ts`, seeded only by tests and
`npm run seed:demo`).

Route table (`app/routes.ts` — verified 1:1, nothing added or removed since pass 11):

| URL | Module |
|---|---|
| `/` | `routes/_index.tsx` (Home) |
| `/login` | `routes/login.tsx` |
| `/logout` | `routes/logout.tsx` (POST only) |
| `/org/settings` | `routes/org.settings.tsx` |
| `/api/auth/*` | `routes/api.auth.$.ts` (better-auth splat, now allow-listed) |
| `/profile` | `routes/profile.tsx` (PageOverlay) |
| `/notifications` | `routes/notifications.tsx` (PageOverlay) |
| `/notifications/read` | `routes/notifications.read.tsx` (fetcher target, no UI) |
| `/prefs/theme` | `routes/prefs.theme.tsx` (fetcher target, no UI) |
| `/resources/events` | `routes/resources.events.ts` (SSE) |
| `/resources/run-log` | `routes/resources.run-log.ts` |
| `/resources/health` | `routes/resources.health.ts` |
| `/resources/model-catalog` | `routes/resources.model-catalog.ts` |
| `/resources/session-export` | `routes/resources.session-export.ts` |
| `/projects` | `routes/projects.tsx` (redirect → `/`) |
| `/projects/:slug` | `routes/project.tsx` (workspace shell layout) |
| `/projects/:slug` (index) | `routes/project._index.tsx` (redirect → `board`) |
| `/projects/:slug/board` | `routes/project.board.tsx` |
| `/projects/:slug/review` | `routes/project.review.tsx` |
| `/projects/:slug/agents` | `routes/project.agents.tsx` |
| `/projects/:slug/policy` | `routes/project.policy.tsx` |
| `/projects/:slug/github` | `routes/project.github.tsx` |
| `/projects/:slug/activity` | `routes/project.activity.tsx` |
| `/projects/:slug/settings` | `routes/project.settings.tsx` |
| `/projects/:slug/tasks/:key` | `routes/project.task.tsx` |

There is **no `/favicon.ico` route and no `public/favicon.ico` file** — see Findings
candidates #1.

---

## 1. `app/root.tsx` — document shell

- **links** (`root.tsx:37-39`): the only asset link — `rel=icon type=image/svg+xml
  href=/favicon.svg` (file exists at `public/favicon.svg`, copied to
  `build/client/favicon.svg`; static assets served by Vite in dev /
  `react-router-serve`'s static middleware in prod, per `package.json` scripts).
- **Loader** (`root.tsx:41-67`): runs on every document request. Returns
  `{ theme, motion, csrf }` — the pass-11 dead `user` field was **removed** in PR #87.
  - `theme` from the `viberr_theme` cookie (`getThemePreference`).
  - `motion` (`"full" | "reduce"`) from `user_prefs` key `motion` (root.tsx:50-53).
  - `csrf` = session-bound token (`getCsrfToken(sessionId)`), consumed via
    `app/ui/csrf-input.tsx` (`<CsrfInput />` hidden field at :11 / `useCsrfToken()`
    at :17 for programmatic `fetcher.submit`).
  - Still calls `authenticateWithHeaders` (root.tsx:46) to forward better-auth's
    rolling-session renewal `Set-Cookie` (:62-66, with a `headers` export at :71-73).
- **Layout** (`root.tsx:99-130`): `<html data-theme data-motion>` + inline pre-paint
  theme boot script (`themeBootScript`, :86-97) reading the `viberr_theme` cookie as
  authoritative and resolving `system` against `prefers-color-scheme` (live-follows OS).
- **App** (`root.tsx:132-157`): wraps the outlet in `<ToastProvider>`
  (`app/ui/toast.tsx` — `useToast()` push API; every toast renders through this one
  provider). Post-paint effect keeps `data-theme` in sync.
- **ErrorBoundary** (`root.tsx:159-202`): renders thrown `data("<message>", {status})`
  strings as page copy (404 "Page not found", 403s from `requireProjectMember`), plus
  a "Back to home" link. Dev-only stack trace. This is also what an unmatched URL
  (e.g. `/favicon.ico`) renders.
- No global nav in root — Home and the workspace shell each render their own topbar
  (§3, §6.1). Bell + user menu are shared components
  (`app/features/shell/top-bell.tsx`, `user-menu.tsx`).
- `app/entry.server.tsx` exports **no `handleError`** — unmatched-route/loader errors
  log through react-router's default handler.

---

## 2. Auth routes

### `/login` — `routes/login.tsx`

- **Loader** (:33-54): `authenticate()`; signed in with no forced reset → redirect
  `returnTo ?? "/"`. Returns `{ mode: "login" | "reset", returnTo,
  providers: { github, google } }` — provider flags = OAuth env pairs configured
  (`GITHUB_OAUTH_CLIENT_ID/SECRET`, `GOOGLE_OAUTH_CLIENT_ID/SECRET`).
- **Action** (:56-148), guarded by `assertTrustedOrigin` (:57 — no CSRF token for
  `login`, pre-session by design; `set-password` DOES `assertCsrf` at :122):
  - `intent=login` (:67) — email+password via `loginWithCredentials` (better-auth).
    Double-submit guard :68-73. Error copy per reason: wrong_password / rate_limited /
    disabled / unknown-email-or-no-password (:89-100). Success forwards better-auth
    `Set-Cookie`s + syncs `viberr_theme` (:103-109); `mustResetPassword` redirects
    back to `/login` reset mode (:110-116).
  - `intent=set-password` (:120) — forced-reset step (`npw`/`npw2`, min length from
    `~/shared/auth/password-policy`), `completeForcedPasswordReset`, redirect.
- **UI**: aside brand panel (aria-hidden, :333-346); "Continue with GitHub/Google"
  buttons POST JSON to `/api/auth/sign-in/social` and follow the returned URL
  (:302-325), disabled + labeled when unconfigured; local email+password `<Form>`;
  "Forgot password?" button shows an info message only (:518-531 — "Ask an admin to
  reset your password…", no self-serve reset by design); reset mode renders
  `SetNewPassword` (:151+).

### `/logout` — `routes/logout.tsx`

- **Action** (:11-34): CSRF-checked POST; `auth.logout` audit row; better-auth
  `signOut` with cookie-clearing `Set-Cookie` forwarding; redirect `/login`.
  **Loader** (:36-38) redirects `/` (GET never logs out).

### `/api/auth/*` — `routes/api.auth.$.ts`

- Loader and action (:11-17) forward the raw `Request` to `getAuth().handler(request)`.
  No app CSRF — better-auth enforces its own trustedOrigins check.
- **NEW (63cfe53, P11-02): allow-list gate.** `app/lib/auth.server.ts:52-59` defines
  `ALLOWED_AUTH_PATHS` — the ONLY six endpoints the app drives: `/sign-in/email`,
  `/sign-in/social`, `/callback/:id`, `/error`, `/get-session`, `/sign-out`. A
  better-auth hook 404s everything else (`auth.server.ts:189-191`) — an allow-list,
  not a deny-list, so account-mutating endpoints better-auth registers
  (change-password, update-user, link-social, token, …) are blocked by construction
  and can't rot as better-auth adds endpoints. The hook pipeline also covers
  server-side `auth.api.*` calls, hence get-session/sign-out in the list.

---

## 3. Home — `/` (`routes/_index.tsx` → `app/features/home/home-page.tsx`)

- **Loader** (`_index.tsx:36-52`): `requireUser`. Returns `user`, `greet`
  (hour-based), `projects` = `listHomeProjectsForUser(db, {id, role})`
  (`app/features/home/home-query.server.ts` — stages, task `dist`,
  `total/running/waiting/overrideWaiting`, members, repo, `archived`, `updatedAt`),
  `prefs` = `getHomePrefs` (grid/list `view` + `stars` pin map in the `user_prefs` DB
  table — not localStorage), `org` = `getHomeOrgSummary`, `notifications`
  (limit **100**, :48) + `unread`, `storeRoot` = `VIBERR_DATA_ROOT` (:50).
- **Action intents** (`_index.tsx:54-142`, all `requireFormAction`):
  - `pin` (:64) — `slug` + `pinned=1|0` → patches `prefs.stars`.
  - `view` (:73) — `view=grid|list`.
  - `rescan` (:78) — **org-admin only** (inline check :83, 403) →
    `rescanProjections` (all projects).
  - `rebuild-projections` (:95) — **org-admin only** (:98) → `rebuildProjections`.
  - `create-project` (:110) — deliberately **any signed-in user** (creator seeded as
    project admin; pinned by test). Fields: `name, key, owner, repoName,
    template=governed|light, policy=strict|balanced|auto` → `createProject`
    (`app/features/home/project-create.server.ts`).
- **SSE** (`_index.tsx:150`): `useLiveUpdates([user, projects])` — `user` for the
  bell, `projects` firehose so landing cards refresh on any project/task change.
- **UI** (`home-page.tsx`, untouched since pass 11): controls in §8.1. Store strip is
  admin-only render (`home-page.tsx:1147` — `if (!isAdmin) return null`); org tiles
  at :1057-1101 link `/org/settings?tab=…`.

`/projects` (`routes/projects.tsx:7-9`) is a bare redirect to `/`.

---

## 4. Overlay routes (URL-addressable full-page modals via `app/ui/page-overlay.tsx`)

Both render as native `<dialog>` overlays with a close X; closing navigates to
`location.state.returnTo ?? "/"`.

### `/profile` — `routes/profile.tsx` → `app/features/profile/profile-page.tsx`

- **Loader** (:48-54): `requireUser` → `getProfileView(db, user.id)` = `{ user:
  {name, title, email, idp, createdAt, avatarTone, hasPassword, githubConnected,
  githubHandle}, memberships, accessRole, prefs: {notifs, motion, tlDefault} }`.
  404 if the account row vanished (:52).
- **Action intents** (:56-128, CSRF at :60; ALL AppErrors mapped to
  `{ok:false, intent, error}` at :116-127 so the overlay never crashes):
  `identity` (:66), `set-notif` (:73 — per-category in-app routing, categories from
  `PROFILE_NTF`), `set-motion` (:82 — SSR `<html data-motion>` hook),
  `set-tl-default` (:86), `change-password` (:94 — only shown when
  `user.hasPassword`), `github-disconnect` (:106 — lockout guard server-side).
- **Theme is NOT this route's action** — the Appearance panel posts
  `theme=light|dark|system` to `/prefs/theme` via a separate fetcher (`onTheme`,
  profile.tsx:158-165) and applies `data-theme` optimistically; **the theme success
  toast still fires on submit** (:164 — see Findings #2).
- **Notification-routing toggles** now settle on the server result with optimistic
  ROLLBACK on failure (`profile-page.tsx:220-231` via `useFetcherResult` — P11-40);
  the motion toggle (:303-313) and timeline-default seg (:315-319) still toast on
  submit (Findings #2).
- **GitHub Connect** (profile-page.tsx:479-482) POSTs `/api/auth/sign-in/social` with
  `{provider:"github", callbackURL:"/profile"}` and follows the URL — real OAuth link.
- No SSE subscription on this overlay.

### `/notifications` — `routes/notifications.tsx` → `app/features/notifications/notifications-page.tsx`

- **Loader** (:32-39): `requireUser` → `listNotifications(db, user.id, {limit: 200})`
  (:36) + `countUnreadNotifications`.
- **No action of its own** — all read mutations go to `/notifications/read`:
  row click / open → `intent=read` with repeatable `id` (markRead :75-83);
  "Mark all read" → `intent=read-all` (markAllRead :85-91). The mark-all toast now
  fires on the server RESULT via `useFetcherResult` + a `wantAllRead` ref (:52-61 —
  failure shows the error, P11-40).
- Opening an item with `projectSlug`+`taskKey` navigates to
  `/projects/:slug/tasks/:key` (:93-97).
- **SSE** (:66): `useLiveUpdates([user])`.
- Page split (`notifications-page-helpers.ts`): "Waiting on you" packet/approval
  cards vs "Everything else" day-grouped stream, All/Unread mini-seg.

### `/notifications/read` — `routes/notifications.read.tsx` (resource action)

- **Action** (:21-39): CSRF; `intent=read` (repeatable `id`) →
  `markNotificationsRead`; `intent=read-all` → `markAllNotificationsRead`. Idempotent;
  server emits user-scoped `notification.read` SSE so other tabs' badges update.
  Loader (:41-43) redirects `/notifications`.

### `/prefs/theme` — `routes/prefs.theme.tsx` (resource action)

- **Action** (:19-33): CSRF; `theme` must satisfy `isThemePreference` (else 400 :26) →
  writes `users.theme` AND sets the `viberr_theme` cookie (`headers` export :36-38).
  Callers: user-menu Theme cycler (settled toast, user-menu.tsx:79-82) and Profile
  Appearance panel (optimistic toast, profile.tsx:164). Loader (:40-42) redirects `/`.

---

## 5. Org settings — `/org/settings` (`routes/org.settings.tsx` → `app/features/org-settings/*`)

- **Loader** (:68-71): `requireRole(request, "admin")` (org role) →
  `{ view: getOrgSettingsView(db), meId }`. View slices: `connections`, `users`,
  `domains`, `kbs`, `mcps`, `skills`, `gagents`, `stages` (kb/skill trees are real
  disk scans).
- **Action** (:99-390): `requireRoleAuth(request, "admin")` (one session lookup,
  WI-12) + CSRF (:106); one intent switch; `{ok:true, toast?}` or `{ok:false, error}`
  (rendered in the open modal's `.cred-warn` or as a toast via `use-org-action.ts`):
  - **Connections** (:114-148): `connection-add` (owner+token, real scope validation —
    nothing saved on failure), `connection-replace`, `connection-default`,
    `connection-remove` (409 when default :146).
  - **Users & access** (:151-245): `user-role` / `user-edit` (self-demote blocked
    :153-155, :162-164), `user-reset-password` (one-time `tempPassword` :179),
    `user-remove` (self blocked :182), `user-disable` (self blocked :189; kills
    sessions; last-admin guard server-side) / `user-enable`, `invite-github`,
    `invite-google`, `invite-domain` (allowlist; invalid/duplicate errors :223-224),
    `invite-local` (returns `tempPassword` + `email` :237-240), `domain-remove`.
  - **Agent resources** (:248-318): `kb-save`/`kb-delete`/`kb-reindex` (real folder
    re-scan), `mcp-save` (transport HTTP|stdio; cred sealed, never round-tripped) /
    `mcp-test` (real reachability probe) / `mcp-delete`, `skill-save`
    (name/summary/SKILL.md body) / `skill-delete`, `agent-save` (global profile:
    name/backend/summary/stages/skills/mcps/kbs as JSON arrays) / `agent-delete`
    (409 `in_use` :316).
  - **Store browser** (:321-382): `store-upload` (multipart `files` + parallel
    `filePaths`, structure-preserving; captures SKILL.md → `captureToast` :343-348),
    `store-mkdir`, `store-delete`, `store-import-github` (URL snapshot import).
    Target via `resolveStoreTarget(kind, id)` (404 when gone).
- **UI** (`org-settings-page.tsx`): back → `/`; tab rail `?tab=connections|users|
  resources` (default connections) with live counts; three panels
  (`connections-panel.tsx`, `users-panel.tsx`, `resources-panel.tsx` +
  `kb-browser/store-browser.tsx`). Controls §8.11. The "New global agent profile"
  modal now defaults eligible stages to a REAL work stage (prefer literal `impl`,
  else middle non-terminal, else first — `resources-panel.tsx:379-390`, P11-47 fix).
- No SSE here; mutations rely on fetcher revalidation.

---

## 6. Workspace — `/projects/:slug` and children

### 6.1 Layout — `routes/project.tsx`

- **Loader** (:36-83): `requireUser` (any signed-in user may VIEW a board —
  app-wide read is deliberate); 404 when `getBoard` null (:40-42). Returns:
  - `board` (project + columns of `TaskSummary` + `orphanTasks` + `members`),
  - per-task `waitingOnMe` (R8-3): mutates the fresh `getBoard` objects **in place**
    with the viewer's open-decision set (:48-53 — see Findings #11),
  - `myRole` = membership role, or `"admin"` when `orgAdminOverride`
    (:54-63 — D2; drives the topbar honesty pill),
  - `taskCount` (ALL tasks incl. Done — rail Board badge :69), `reviewCount`
    (:70-78, resolved review stage), `violations` (:79 — rail Settings badge),
  - `notifications` (limit **100**, :80) + `unread` (:81, topbar bell).
- **Component** (:85-149): `Rail` + `Topbar` + archived banner (:135-144) +
  `<Outlet/>`. Children read this loader via `useRouteLoaderData("routes/project")`.
- **SSE** (:101-105): ONE stream per tab: `project:<slug>` + `user`, plus
  `task:<slug>/<key>` when a task route is open (detected via `useMatches` id
  `routes/project.task`, :88-92). Any matching event revalidates layout + child
  loaders, debounced 300 ms (`use-live-updates.ts:26` `REVALIDATE_DEBOUNCE_MS`).

Shell components (`app/features/shell/`):
- **Rail** (`rail.tsx`): switcher link → `/`; 7 nav items from `nav.ts`
  `WORKSPACE_NAV` (Board / Review queue / Agents / Policy / GitHub / Activity /
  Settings) with live counts (board=taskCount, review=reviewCount,
  settings=violations when >0). Task routes keep Board active
  (`workspaceViewFromPathname`, nav.ts:35).
- **Topbar** (`topbar.tsx`): brand → `/`; crumbs; `org-admin override` pill
  (:123-130); real search input — on the board it writes `?q=` (replace, no scroll
  reset, :66-73); on other workspace views typing navigates to the board with the
  query (:76-78); ⌘K/Ctrl-K focuses (:85). Then `TopBell` + `UserMenu`.
- **TopBell** (`top-bell.tsx`): bell + pulse badge; popover (non-modal
  `<dialog open>`); item click marks read + navigates; "Mark all read" toast settles
  on the server result via `useFetcherResult` + `wantAllRead` ref (:48-57 — P11-40);
  "See all" → `/notifications` with `returnTo`; Escape closes.
- **UserMenu** (`user-menu.tsx`): avatar menu — "Profile & preferences" → `/profile`
  (returnTo), "Switch project" → `/` (workspace only), "Theme · X" cycler
  (light→dark→system; posts `/prefs/theme`; toast settles on result :79-82, error
  toast on failure — P11-40; menu deliberately stays open), "Org settings" (org
  admins), "Sign out" (POST `/logout` with `<CsrfInput/>`).

### 6.2 Board — `/projects/:slug/board` (`routes/project.board.tsx` → `app/features/board/board-page.tsx`)

- **No loader** — data from the layout loader (one query feeds rail counts AND
  columns; every action revalidates both).
- **Action intents** (:22-89):
  - `create-task` (:26) — `title/goal/stage` → `createTask` (RBAC inside:
    contributor+).
  - `reorder` (:43) — `taskKey`, `to`, `beforeKey` (card to land before, empty=end) →
    `reorderTask` (A|M, server re-checks). Cross-stage move posts the
    `**Transition:**` timeline comment; dragging into Done is an ACCEPTANCE with
    honest toast copy (:62-69).
  - `rescan` (:71) — `assertProjectAction("rescan-project", …)` (:78; maintainer+ per
    `ACTION_ROLES`, rbac.ts:60) → `rescanProject` scoped to this slug.
- **Component gates** (:91-99): `canCreate` = role ≠ null ≠ viewer; `canTransition` =
  admin|maintainer; `canRescan` = `roleCan(myRole, "rescan-project")` (:99 —
  **P11-45 fix**: no longer borrows the transition gate; display tracks the server's
  exact RBAC row).
- **URL state**: `?filter=all|human|agent|risk` (`board-filters.ts` — `human` is
  member-scoped `waitingOnMe`, :26), `?view=list`, `?q=` (key/title/branch/owner/
  specialist/reviewers/operator, board-filters.ts:52-65).
- Controls §8.3.

### 6.3 Review queue — `/projects/:slug/review` (`routes/project.review.tsx` → `app/features/review/review-page.tsx`)

- **Loader** (:20-34): `requireProjectMember` FIRST (:26 — a non-member must not
  learn the project exists), then 404 (:27-29). `getReviewQueue(db, slug,
  {viewerUserId})` → `{ ready, working, total }` — `ready` member-scoped by
  acceptance authority (maintainer+/owner).
- **Zero mutations** — rows navigate to task detail; the "Review → Done · human only"
  chip navigates to Policy (review-page.tsx:96-105 — a `<button class="hero-file">`
  with inline `cursor:pointer`, Findings #9). SSE inherited from the shell.

### 6.4 Agents — `/projects/:slug/agents` (`routes/project.agents.tsx` → `app/features/agents/agents-page.tsx`)

- **Loader** (:33-58): `requireProjectMember`; returns `profiles`
  (= `assembleAgentRoster`: org templates ⊕ project.md deployments incl. the reserved
  operator), `deployments` (assignments ⋈ agent_runs), `stages`, `projectName`,
  `resourceCatalog` (live org skills/MCP/KB store, scoped `specialist`, :54-56).
- **Action intents** (:60-122): `create-profile` / `update-profile` (JSON `payload`
  parsed leniently :63-69) / `delete-profile` — phase-3 project.md writers (RBAC
  inside; project-admin). Delete still returns hardcoded `profileId:"operator"`
  (:112) so the page's handled-effect re-selects the operator (Findings #6).
- **UI** (`agents-page.tsx`): Profiles/Live tabs; roster + `ProfileDetail`;
  `canManage = roleCan(myRole, "manage-agents")` (:592 — role literal gone);
  `?profile=<id>` deep-links selection (:593-595); Live rows resolve display names
  via a `profileId → name` map with raw-id fallback (:462-463, :513 — **P11-42
  fix**, fallback remains); `CreateProfileModal` fetches
  `/resources/model-catalog?backend=` per backend pick
  (`create-profile-modal.tsx:786-793`) but its backend chips ignore backend
  availability (:50, :216-227 — Findings #3); `CapabilityMatrixModal` shared with
  Policy. Controls §8.5.

### 6.5 Policy — `/projects/:slug/policy` (`routes/project.policy.tsx` → `app/features/policy/policy-page.tsx`)

- **Loader** (:27-35): `requireProjectMember`; `getPolicyViewData` → members+roles,
  workflow transitions, agent-profile roster (shared with Agents), audit-derived
  `edited` chip.
- **Action intents** (:37-73): `set-role` (`userId`,`role` — last-admin guard
  server-side) and `set-boundary` (`from`,`to`,`boundary=auto|approval|human`;
  review→done hard-locked human). Both admin-gated inside the mutations.
- **UI**: Human access panel (per-member 4-role radio seg + read-only RBAC grant
  table from `RBAC_ROWS`), Agent capability panel (rows → `/agents?profile=<id>`),
  Workflow rules panel (3-way boundary seg; locked rows "locked · V1").
  `canManage = roleCan(myRole, "edit-policy")` (policy-page.tsx:425 — role literal
  gone). Controls §8.6.

### 6.6 GitHub — `/projects/:slug/github` (`routes/project.github.tsx` → `app/features/github/github-view.tsx`)

- **Loader** (:31-39): `requireProjectMember`; `getGithubViewData` (async — live
  `checkRepoAccess` probe + credential health + PR/branch rows from
  task_projections + reconcile freshness + `githubHost`).
- **Action intents** (:41-78), all via `assertProjectAction` (:51-52):
  - `reconcile` → RBAC `reconcile-github` (A|M) → `runReconcile` (degraded modes are
    values with honest toasts).
  - `grant-scope` → RBAC `grant-github-scope` (A|M) → `runGrantScope` (re-validate
    PAT scopes; resolves open scope violations, drops the rail badge).
  - `set-credential` / `clear-credential` (:65-70) → same `grant-github-scope` gate →
    `runSetCredential` (binds the **org default connection's PAT** — no token field,
    `github-actions.server.ts:100-122`) / `runClearCredential`.
  - Archived projects are read-only for all of these (R8-5, in the guard).
- **UI**: Repository panel + `CredentialCard` (scope chips, violation banner,
  Grant-scope + Fix-in-Settings, attach/rotate/remove), Pull-requests panel,
  Execution-branches table, freshness chip, Reconcile button, "Open on GitHub"
  external link. `canGrant = roleCan(myRole, "grant-github-scope")`
  (github-view.tsx:347 — role literal gone). Controls §8.7.
- A server-side reconcile **poller** now exists (PR #87: `app/server/github/
  reconcile-poller.server.ts`, started at boot `boot.server.ts:192` behind a
  `Symbol.for` HMR-singleton) — freshness can advance without the button.

### 6.7 Activity — `/projects/:slug/activity` (`routes/project.activity.tsx` → `app/features/activity/activity-page.tsx`)

- **Loader** (:34-64): `requireProjectMember` first (:40), 404 second (:41-44);
  bounded newest-first slices — `?stream=` / `?audit=` raise limits (steps/caps in
  `feed-limits.ts`, clamped :46-55). Returns `stream`, `streamTotal`, `audit`,
  `auditTotal`.
- **Read-only** (no action). Actor filter (All/Humans/Agents/System) is client state
  and does NOT touch the audit panel (mock parity). "Show older" buttons bump the URL
  params. Long texts collapse behind Show more. Task-key keybtns navigate to task
  detail. SSE via shell.

### 6.8 Settings — `/projects/:slug/settings` (`routes/project.settings.tsx` → `app/features/project-settings/settings-page.tsx`)

- **Loader** (:44-52): `requireProjectMember`; `getSettingsViewData` → identity,
  stages + per-stage counts, members (invite status), credential health,
  `repoOverride`, `archived`.
- **Action intents** (:54-176):
  - `save-project` (:61 — name/prefix/description), `rename-stage` (:74),
    `add-stage` (:82 — returns `stageId`, new row drops into edit mode),
    `remove-stage` (:90), `reorder-stages` (:98 — comma-joined `orderedIds`;
    entry/terminal pinned),
  - `invite` (:109 — joins as Viewer), `remove-member` (:117),
  - `override` (:125 — task-level repo override toggle),
  - `grant-scope` (:133) / `set-credential` / `clear-credential` (:142-150) — same
    `grant-github-scope` RBAC via `assertProjectAction` as the GitHub view;
    archived gate enforced,
  - `archive-project` (:151), `delete-project` (:159 — `confirmName` typed match; on
    success `redirect("/")` :165).
- **UI gates**: `isAdmin = myRole === "admin"`, `canGrant = admin || maintainer` —
  **still string literals** (settings-page.tsx:736-737, the last surface not moved to
  `roleCan`; Findings #4). Controls §8.9.

### 6.9 Task detail — `/projects/:slug/tasks/:key` (`routes/project.task.tsx` → `app/features/task-detail/task-detail-page.tsx`)

- **Loader** (:83-160): `requireUser` (app-wide task read is deliberate). Returns:
  - `task` = `getTaskDetail` with bounded newest-first `timeline` slice (`?events=`,
    `timeline-slice.ts`), plus `timelineTotal/HasMore/Remaining/NextLimit`,
  - `tlDefault` (user pref, sanitized :96-98),
  - `runtime` = `listRunsForTask` (per-task provider-run projection; each run now
    carries a REAL `exportable` flag — `run-projection.server.ts:154-156` probes
    `transcriptExists(backend, sid)` (filename-only, briefly cached) so the UI only
    offers Export when a transcript is actually on disk — **P11-43 fix**),
  - `deployedSpecialists`, `deliveringActive` (only the DELIVERING run
    single-flights — F10-04, :111-114), `activeReviewerIds` (:115-117),
  - `mentionables` (@-autocomplete directory :122),
  - `recommendations` + pending `schedules` — read from the **task FILE frontmatter**
    (`readTaskFile`, :127-132), not the projection,
  - **NEW** `operatorBackend` (:146 — P11-76: run picker defaults to the operator's
    configured backend, not hardcoded claude),
  - **NEW** `backendAvailable` `{claude, codex}` (:149-152 — P11-41: pickers disable
    unconfigured backends),
  - `githubHost` (:158, GHE-safe browse links).
- **Action intents** (:169-581, all `requireFormAction`; toast copy is the verbatim
  spec §5 contract, computed here):
  - `comment` (:182) — `text`; `commentToAgent` records it and, when an agent is
    @mentioned by an admin|maintainer, resumes that agent's session; returns
    `logThreadId` for log auto-select + toast variants (:195-202, incl.
    "your role can't trigger agent runs").
  - `update-goal` (:215) — A|M via canEditGoal=run-agents in UI.
  - `resolve-packet` (:223) — `option` (index) + **optional `note`** (:226 — capped
    2000 chars, threaded to the operator; the packet card has a note textarea,
    `decision-packet.tsx:152-156`). Server re-reads the packet and dispatches on the
    option's stable `kind` (accept_completion / block_on_policy / hold_runtime_debug
    / retry_other_backend / edit_goal / …); `block_on_policy` returns
    `navigateTo:/projects/:slug/settings` (:249-252).
  - `complete-merge` (:255) — real GitHub merge for an accepted "merge pending" PR
    (S2; accept-completion RBAC); honest not-merged copy.
  - `owner-take` (:267) / `owner-assign` (:279) / `owner-release` (:296 —
    forced-release toast when admin releases someone else :299-311) — `own-task`.
  - `transition` (:313) — manual StageMenu move (approve-transition A|M).
  - `run-interrupt` (:337) — idempotent-safe (run-agents RBAC).
  - `assign-specialist` (:354) / `run-specialist` (:368, optional `backend` override
    for D4 retry via `backendOverride()` :164-167) / `assign-reviewer` (:384) /
    `run-reviewer` (:399) / `remove-reviewer` (:418) — all run-agents (A|M).
  - `apply-recommendation` (:431) / `dismiss-recommendation` (:445) — `recId` (A|M).
  - `run-operator` (:457) — `requireRunAgents` guard (:465-476); `backend`/`autonomy`
    only OVERRIDE when explicitly sent (:477-495 — P11-76: absent field falls
    through to the operator profile's configured backend); attributed to the human
    presser (D8, :502-504).
  - `schedule-action` (:512 — `delayMinutes/backend/autonomy/note` →
    `scheduleTaskAction`, O-3) / `cancel-schedule` (:548).
  - The `{slug, memberRoles, archived}` guard input is constructed inline three
    times (:466-473, :516-523, :550-557 — Findings #8).
- **ErrorBoundary** (:634-661): task-scoped "Task not found" panel + Back-to-board
  link (does not take down the shell).
- **SSE**: shell adds the `task:` scope; PLUS a dedicated log consumer
  `useRunLogStream` (`app/features/runtime/use-run-log-stream.ts`) with its own
  EventSource: `run.log-appended` → fetch tail from `/resources/run-log?runId&since`
  and append (no loader refetch per line); `run.state-changed` → one revalidation;
  20 s safety interval revalidates while a run shows active (:72-80).
- **Layout** (contract order, task-detail-page.tsx:1197-1281): hero → LiveRunPanel
  (:1197) → DiagnosticsPanel (:1206) → DecisionPacket (:1209) →
  RecommendationsSection (:1219) → ScheduledActions (:1224) → ExecutionSection
  (:1230) → AgentLogsPanel (:1248) → Timeline (:1258); sidebar: GithubTrace (:1272)
  → CurrentStatePanel (:1278) → Permissions panel. Controls §8.10.
- Operator note (server-side, 63cfe53): operator-driven transitions re-trigger the
  queued operator, structurally bounded by `OPERATOR_TRANSITION_CHAIN_CAP` = 8
  (`app/server/tasks/task-actions.server.ts:103`); at the cap coordination pauses on
  the stuck-loop packet instead of another LLM run.

---

## 7. Resource routes (no UI)

### `/resources/events` — `resources.events.ts` (SSE, Phase 6)

- GET only. Auth = session cookie; unauthenticated/pwreset → **401 JSON** (:54-60 —
  an EventSource can't render a login page; client backs off and retries).
- Repeatable `scope=` params: `project:<slug>` | `task:<slug>/<key>` | `projects`
  (firehose) | `user`. 400 on invalid/absent scope (:62-90).
- **Authorization (D9, :92-129)**: org admins subscribe to anything (:103-104).
  Non-admins: `projects` firehose EXPANDED to member projects only (:108-110);
  explicit project/task scopes dropped unless a member (:111-113); `user` always
  passes; all-foreign requests → 403 (:118-128, never an empty stream).
- Streaming: `Response` wrapping a never-ending `ReadableStream` (:138-168);
  `Last-Event-ID` reconnect (:131-133); `Cache-Control: no-store, no-transform`,
  `X-Accel-Buffering: no` (:170-178); backpressure cap 1024 queued chunks then drop
  (:51, :140-146). Broker: `app/server/events/sse-broker.server.ts`.
- Event names from `app/schemas/sse-event.schema.ts` (client mirror
  `app/features/live-updates/event-types.ts`); `stream.open` is a control event that
  never triggers revalidation. Note: `projection.rebuilt` scope enum shrank to
  `"full" | "project"` in PR #87 (`sse-event.schema.ts:86`). Consumers:
  `useLiveUpdates` (revalidate-on-anything, 300 ms debounce) and `useRunLogStream`.

### `/resources/health` — `resources.health.ts`

- GET, **unauthenticated by design** (readiness probe; listed so nobody "fixes" it).
  200 `{ ok, projections:{projects,tasks}, watcher, backends:{claude,codex:
  "real"|"unavailable"} }` (:24-44) — backend flags are env-presence only, never
  token validity. 503 `{ok:false}` when the DB is unreadable (:45-50). Not consumed
  by any UI (the task-detail loader calls `isBackendAvailable` directly instead).

### `/resources/run-log` — `resources.run-log.ts`

- GET `?runId=<id>&since=<seq>` (default -1 = all, :35-36). `requireUser` (:26) +
  `requireProjectMember` for the run's project (:47 — raw logs are SENSITIVE,
  F10-06). Returns `{ data: { runId, threadId, state, headSeq, lines:[{seq,
  occurredAt, raw, display}] } }`. 400/404 JSON errors. Consumer: `useRunLogStream`.

### `/resources/model-catalog` — `resources.model-catalog.ts`

- GET `?backend=claude|codex` (unknown → claude, :22). `requireUser` only (read is
  ungated, V1 read RBAC). Returns `{ data: { models, efforts, defaultModel,
  defaultEffort } }` — Claude enhances a curated list with live `supportedModels()`
  when a credential exists; codex curated-only. Consumer: `CreateProfileModal`.

### `/resources/session-export` — `resources.session-export.ts`

- GET `?run=<runId>`. `requireUser` (:33) + `requireProjectMember` (:44 — a provider
  transcript is the most sensitive run artifact). Locates the on-disk provider
  session via the FULL `locateTranscript` (content scan — export-route-only since
  63cfe53; the cheap `transcriptExists` probe feeds the loader's `exportable` flag
  instead) and streams a downloadable **bash installer** (`application/x-sh`,
  attachment) for local `claude --resume` / `codex resume`. 404 when no session id
  (:45-50) or no on-disk transcript (:52-59). Consumer: the "Export" link in
  `SessionIdChip` (`runs-panels.tsx:293` — now rendered only when
  `exportable && runId`, fed from `cur.exportable` at :413).

---

## 8. Page-by-page interactive-controls inventory (what a tester can click)

### 8.1 Home (`/`)

- Topbar: brand button (scroll-to-top), project search input (client filter, ⌘K
  focuses), bell (popover: item rows, Mark all read, See all), avatar menu (Profile &
  preferences, Theme cycler, Org settings [admin], Sign out).
- Hero: Grid/List seg (persists via `intent=view`), "New project" button.
- Project cards/rows: whole card → `/projects/:slug/board`; star button (pin/unpin,
  `intent=pin`, optimistic + toast); "New project" ghost tile.
- Sections: Pinned / Everything-else / Archived (list-only, restore hint).
- Settings panel: three `org-tile` links → `/org/settings?tab=…` (home-page.tsx:1057-1101).
- Store strip (**admin-only render**, home-page.tsx:1147): "Re-scan" (`intent=rescan`,
  spin + result toast), "Rebuild projections" (RebuildConfirm alertdialog →
  `intent=rebuild-projections`).
- New-project modal: name (autocompletes key+repo), task-key input (4 uppercase),
  connection pick-chips (required; empty-state links to org settings), repo input
  with `owner/` prefix, template chips (Standard 5 / Lightweight 3), policy chips
  (Strict/Balanced/Autonomous), Cancel, "Create project" (disabled until valid),
  Escape/backdrop close, server error inline.

### 8.2 Login (`/login`)

- Continue with GitHub / Google (disabled + labeled when unconfigured; busy
  "Checking whitelist…"), email + password inputs, "Sign in" submit, "Forgot
  password?" (info message only, :518-531), reset mode: new/confirm password +
  "Save & continue".

### 8.3 Board (`/projects/:slug/board`)

- Header: Board/List seg (`?view`), "Re-scan" (visible iff
  `roleCan(role,"rescan-project")` = A|M), "New task" (contributor+).
- Filter bar: All / "Waiting on me · N" / Agent working / Needs attention (`?filter`).
- Orphan banner: per-key links to unstaged tasks.
- Column header: "+" new-task-in-stage (hidden on Done).
- Task card: whole card navigates; **drag** between/within columns (A|M; ghost +
  drop preview + optimistic counts; drop → `intent=reorder`); per-card keyboard
  **StageMenu** ("Move to stage", same intent); pills (readiness, PR#, branch chip,
  wait-tag).
- List view: row links with the same pills.
- New-task modal: title (required, Enter submits), stage pick-chips (Done excluded),
  goal textarea, Cancel / "Create task", server error in foot-hint.

### 8.4 Review queue (`/projects/:slug/review`)

- "Review → Done · human only" chip-button → Policy (review-page.tsx:96-105).
- Two panels of `rq-row` buttons → task detail. Nothing else mutable.

### 8.5 Agents (`/projects/:slug/agents`)

- Header: Profiles/Live tab seg, "Capability matrix" (modal), "New profile"
  (`manage-agents` = admin).
- Roster: operator + specialist `ag-item` buttons, "+" and "New specialist profile"
  (admin).
- ProfileDetail: "Delete" (specialists only, admin → confirm alertdialog →
  `intent=delete-profile`), "Edit profile" (admin → modal), deployment rows → task.
- Live tab: sortable table rows → task detail; agent names resolved via roster map
  (raw profileId fallback, :513).
- Create/Edit-profile modal: name, role, backend chips (both offered regardless of
  availability — Findings #3; fetches model catalog per backend), model + effort
  selects, stage chips, resource picker (live org catalog), submit posts JSON
  `payload` with `intent=create-profile|update-profile`.
- Capability-matrix modal: read-only grid, Close.

### 8.6 Policy (`/projects/:slug/policy`)

- Header: "last change" chip (info), "Capability matrix" button.
- Human access: per-member 4-role radio seg (`intent=set-role`; enabled iff
  `roleCan(myRole,"edit-policy")`; client last-admin toast mirror), read-only RBAC
  table.
- Agent capability: per-profile rows → `/agents?profile=<id>`, "Capability matrix",
  "Manage profiles" → `/agents`.
- Workflow rules: per-transition Auto/Approval/Human radio seg (`intent=set-boundary`;
  review→done row locked + "locked · V1").

### 8.7 GitHub (`/projects/:slug/github`)

- Header: freshness chip, "Reconcile" (`intent=reconcile`, start toast + server
  toast), "Open on GitHub" external link.
- Repository panel / CredentialCard: "Grant scope" (`intent=grant-scope`, only with
  a bound PAT + `canGrant`), "Fix in Settings" → settings, attach/rotate
  ("Set credential") and remove ("Clear credential") via `CredentialManageActions`
  (binds org DEFAULT connection — no token entry), violation task-key links → task.
- Pull requests: row buttons → task. Branches table: row buttons → task.

### 8.8 Activity (`/projects/:slug/activity`)

- All/Humans/Agents/System radio seg (client filter, stream panel only).
- Per-row task-key keybtns → task; Show more/less on long texts.
- "Show older events · N more" (`?stream=`), "Show older entries · N more" (`?audit=`).

### 8.9 Project settings (`/projects/:slug/settings`)

- Project panel: name / prefix / description inputs — **save on blur when dirty**
  (`intent=save-project`; admin only).
- Stages: drag-handle reorder (`reorder-stages`), click name → inline rename
  (Enter/blur commits `rename-stage`, Escape cancels), per-stage remove X (locked
  entry/terminal; blocked with toast when tasks remain), "Add stage" (new row enters
  edit mode via the returned `stageId`), "Policy → Workflow rules" keybtn.
- Members: rows with remove X (self/last-admin client toasts), invite name+email +
  "Invite" (`intent=invite`; joins as Viewer), "Policy → Human access" keybtn.
- Repository & credentials: override toggle (`intent=override`, admin), Grant scope /
  Set / Clear credential (A|M), violation task links.
- Danger zone (admin only enabled): "Archive"/"Restore" (`archive-project`), "Delete
  project" → typed-name confirm dialog → `delete-project` → redirect `/`.

### 8.10 Task detail (`/projects/:slug/tasks/:key`)

- Hero: goal "Edit" button (A|M) → textarea + "Save goal"/"Cancel"
  (`intent=update-goal`; the pass-11 no-op `onSubmit` was removed — comment at
  task-detail-page.tsx:391-392).
- LiveRunPanel (only while a run is `running`): agent picker (multi-run), "View
  logs" (scrolls + selects), "Interrupt" (A|M, `intent=run-interrupt`).
- DecisionPacket (when open): option radiogroup (arrow-key roving), **note textarea**
  (optional, decision-packet.tsx:152-156, sent as `note`), "Confirm decision"
  (`intent=resolve-packet`; blocked for owner-only viewers while accept_completion
  selected), "Ask operator" (prefills `@operator ` into the composer).
- OperatorRecommendations: per-card "Apply"/"Dismiss" (A|M).
- Scheduled re-runs: pending rows with "Cancel" (`cancel-schedule`); scheduler form —
  delay select (5m/1h/6h/24h), backend select, autonomy select, note input,
  "Schedule operator re-run" (`schedule-action`).
- ExecutionProfile (execution-profile.tsx):
  - Operator cell: backend select (defaults to the operator's configured backend;
    **unavailable backends render disabled with "— not configured"**, :434-441) +
    autonomy select + "Run operator" (`run-operator`; disabled when task closed),
  - Delivering agent: "Run" (`run-specialist`; disabled while a delivering run is
    active) or "Assign delivering agent" menu (`assign-specialist`),
  - Reviewing agents: per-reviewer "Run" (`run-reviewer`, per-reviewer gating) +
    release X (`remove-reviewer`), "Engage reviewer" menu (`assign-reviewer`;
    excludes already-engaged + the deliverer),
  - Human owner: "Assign me" (`owner-take`, contributor+) / "Manage" menu (Take
    over, Hand off to <member> [`owner-assign`], Release… → `ReleaseConfirm` →
    `owner-release`).
- AgentLogsPanel: agent picker, session-id chip (expand / copy / **Export** download →
  `/resources/session-export?run=` — link rendered only when the run's real
  `exportable` flag is true, runs-panels.tsx:293), "Retry on <other backend>" (D4),
  `{ } raw` toggle, `follow` toggle, scrollable console.
- Timeline: All/Important/Comments filter tabs (default from profile pref), comment
  composer (@-mention autocomplete, highlight backdrop, ⌘↵ send, "Comment",
  `intent=comment`; inline error keeps draft), "Show older events · N more"
  (`?events=`), per-comment Show more/less clamp.
- Sidebar: GithubTrace ("Complete merge" for accepted PRs [`complete-merge`, A|M],
  "Open on GitHub" external), CurrentState (StageMenu transition [A|M,
  `intent=transition`], owner Assign-me/release X, waiting-on display), Permissions
  panel (rows derived from `roleCan` :209-225 with hand-written prose, "V1 rules"
  :239; "View project policy" link).

### 8.11 Org settings (`/org/settings`)

- "Projects" back button, 3 tab buttons (`?tab=`).
- Connections: "Add connection" (modal: owner + PAT + validate; `connection-add`),
  per-row "Update token" (`connection-replace`), "Set default"
  (`connection-default`), remove X (default blocked with toast → confirm →
  `connection-remove`).
- Users & access: "Allow access" modal (GitHub/Google/Local seg; handle |
  email/domain | name+email; Admin/Member seg; `invite-*`), temp-password notice
  (dismissable), domain rows remove X (`domain-remove`), per-user: Admin/Member seg
  (`user-role`), edit pencil (modal: name/email/role, "Reset password"
  [`user-reset-password`, temp shown once], save `user-edit`), disable hand-button
  (confirm → `user-disable`) / enable check (`user-enable`), remove X (confirm →
  `user-remove`).
- Agent resources: 4 panels, each "New/Add" + per-row Browse (KB/skill →
  StoreBrowser), Re-scan (`kb-reindex`), Test (`mcp-test`), Edit, Delete (confirm).
  Modals: KB (name + re-index seg — `kb-save`), MCP (name, HTTP/stdio, target,
  sealed cred — `mcp-save`), Skill (name, summary, SKILL.md body — `skill-save`),
  Global agent (name, backend, summary, stage chips [real-stage default, P11-47],
  resource chips — `agent-save`).
- StoreBrowser popup: Upload files / Upload folder / import-from-GitHub toggle + URL
  form (`store-import-github`), New folder (`store-mkdir`), per-node
  upload/new/delete (`store-upload`/`store-delete`), Close.

### 8.12 Notifications overlay (`/notifications`)

- Overlay close X; All/Unread seg; "Mark all read" (settled toast); "Waiting on you"
  card rows (read + navigate); stream rows (click = mark read; keybtn = mark read +
  navigate).

### 8.13 Profile overlay (`/profile`)

- Overlay close X; identity name/title inputs (save on blur / Enter); notification
  routing toggles (settled toast + rollback on failure); Appearance: theme 3-way seg
  (posts `/prefs/theme`; optimistic toast), Reduce-motion toggle (optimistic toast),
  timeline-default 3-way seg (optimistic toast); Your access read-only RBAC list +
  "Policy → Human access" keybtn; GitHub identity "Connect" (OAuth) / "Disconnect"
  (`github-disconnect`); Change password (current/new/confirm; only when
  `hasPassword`).

---

## Delta since pass 11

What changed on `main` between the pass-11 map (2026-07-23) and commit `0981cfa`
(only 63cfe53, e306248, 625eb71 + merges):

1. **`app/ui/use-fetcher-result.ts` (NEW, 63cfe53)** — shared "run a handler once per
   settled fetcher result" hook (idle-check + seen-ref dedupe, handled-ref pattern).
   Adopted by `top-bell.tsx:49`, `user-menu.tsx:79`, `routes/notifications.tsx:53`,
   `profile-page.tsx:221` (the last with optimistic ROLLBACK for notification
   routing). This closes most of pass-11 finding #7 (optimistic success toasts);
   residuals in Findings #2 below.
2. **`exportable` on the loader path (P11-43)** — `run-projection.server.ts:154-156`
   computes real exportability via the new cheap `transcriptExists(backend, sid)`
   probe (`session-export.server.ts`; filename-only, briefly cached; codex walk split
   byFilename/byContent). The Export link renders only when true
   (`runs-panels.tsx:293`, `:413`). Pass-11 finding #8 closed.
3. **`/api/auth/*` allow-list (P11-02)** — deny-list inverted to
   `ALLOWED_AUTH_PATHS` (6 endpoints) in `app/lib/auth.server.ts:52-59` with a 404
   hook at :189-191. §2 updated.
4. **Operator transition-chain cap** — `OPERATOR_TRANSITION_CHAIN_CAP = 8`
   (`task-actions.server.ts:103`); `transitionDepth` threads
   `RunOperatorInput → ctx.operatorRun → transitionStage`; at the cap the transition
   lands but coordination pauses on the stuck-loop packet. Server-side only; no
   route shape changed.
5. **Reconcile-poller singleton** — handle moved behind a `Symbol.for` global; boot
   poll inside the idempotence guard (`reconcile-poller.server.ts`; started at
   `boot.server.ts:192`). KB watcher (`startKbWatcher`, boot :146) also runs from
   boot (both landed in PR #87).
6. **Clean-sheet seed (e306248/625eb71)** — `npm run seed` now seeds ONLY built-in
   agent catalog templates + projection rescan + the env-configured bootstrap admin
   (`VIBERR_SEED_ADMIN_EMAIL`/`_PASSWORD`, default `admin@viberr.dev`); no projects,
   tasks, notifications, or extra users. The mock dataset moved to
   `test-support/demo-data.ts` + `test-support/demo-seed.ts` (route test suites +
   Playwright use it; e2e seeds via new `npm run seed:demo`). **Verified: no product
   route/loader/feature imports demo data** — only `*.test.*` files do. Route
   behavior on a fresh install: `/` renders with zero project cards (create-modal is
   the on-ramp); no route depended on seeded demo rows.
7. **Migrations squashed** — 0002 (delivering single-flight partial unique index)
   folded into `db/migrations/0001_baseline.sql` (pre-prod squash convention). No
   route impact.
8. **Packet note channel** — `resolve-packet` accepts optional `note` (≤2000 chars,
   `project.task.tsx:226`); packet card grew a note textarea
   (`decision-packet.tsx:152-156`); its styles moved from inline JSX to `app.css`.
9. **Root loader slimmed** — the dead `user` field is gone from the root payload
   (pass-11 finding #1 closed); payload is `{ theme, motion, csrf }`.
10. **Pass-11 "suspicious" items closed by PR #87** (verified in current source):
    #1 root `user` (gone), #2 goal-editor no-op onSubmit (removed;
    task-detail-page.tsx:391-392 comment), #4 hardcoded `["impl"]` default
    (resources-panel.tsx:379-390, P11-47), #7 optimistic toasts (mostly — see
    Findings #2), #8 Export-when-no-transcript (P11-43), #9 live-roster raw ids
    (P11-42, nameById map agents-page.tsx:513), #12 backend availability (partially
    — execution-profile.tsx:434-441 P11-41; modal residual in Findings #3),
    #14 board rescan gate (roleCan, project.board.tsx:99, P11-45). UI role-literal
    cleanup (#6) landed for github-view (:347), policy-page (:425), agents-page
    (:592) — settings-page residual in Findings #4.

Line-number drift: task route loader/action and ErrorBoundary shifted ~+8..+32
(loader now :83-160, action :169-581, ErrorBoundary :634-661); notifications route
markRead/markAllRead now :75-91; everything else within ±3 of pass-11 refs (refreshed
above).

---

## Findings candidates (pass 12)

Verified against source at `0981cfa`; each cites file:line. Ordered roughly by
user-visible impact. Items marked *(by design)* are documented so nobody "fixes" them.

1. **No `/favicon.ico` — every miss is a full SSR 404 + server error log.**
   `app/routes.ts` mounts no favicon route; `public/` contains ONLY `favicon.svg`
   (also the only icon in `build/client/`); the sole declaration is
   `app/root.tsx:37-39` (`rel=icon type=image/svg+xml href=/favicon.svg`).
   `app/entry.server.tsx` exports no `handleError`, so a request to `/favicon.ico`
   falls through static serving into the react-router handler, matches nothing,
   SSR-renders the root ErrorBoundary 404 page (root.tsx:159-202) and logs the
   "No route matches URL /favicon.ico" error through react-router's default
   handler — on the server, per hit. Clients that don't honor the SVG `<link>`
   (Safari's SVG-favicon support is absent/partial; curl'd probes; anything fetching
   a non-HTML resource first) request `/favicon.ico` on every page load → repeated
   error-log spam + a wasted full document render each time. Fix: ship a
   `public/favicon.ico` (static middleware would then serve it before the router)
   or mount a tiny resource route that 302s to `/favicon.svg`.
2. **P11-40 residual: Profile overlay Appearance toasts are still optimistic.**
   The settled-result fix covered the bell, user-menu theme, notifications page and
   profile notification-routing — but in the Profile overlay: theme toast fires on
   submit (`app/routes/profile.tsx:164`, `onTheme` :158-165 — `themeFetcher` result
   never checked), Reduce-motion success toast on submit
   (`app/features/profile/profile-page.tsx:303-313` `flipMotion`), timeline-default
   toast on submit (:315-319 `pickTl`). A failed POST (expired session/CSRF) shows
   success and leaves the optimistic `data-motion`/local seg state stuck; no
   rollback (contrast the set-notif handler :220-231 in the same file).
3. **P11-41 residual: Create/Edit-profile modal offers unavailable backends.**
   `app/features/agents/create-profile-modal.tsx:50` (`BACKENDS`) + :216-227 render
   both backend chips unconditionally; the agents route loader
   (`app/routes/project.agents.tsx:33-58`) never returns availability, so a profile
   can be created on a backend whose runs fail fast. The task-detail loader already
   exposes `backendAvailable` (project.task.tsx:149-152) and execution-profile
   disables options (:434-441) — the modal is the one picker left blind.
4. **Last role-literal UI gate.** `app/features/project-settings/settings-page.tsx:736-737`
   — `isAdmin = myRole === "admin"; canGrant = myRole === "admin" || myRole ===
   "maintainer"` while github-view (:347), policy-page (:425), agents-page (:592)
   and board (project.board.tsx:99) all moved to `roleCan`/`ACTION_ROLES`. Will
   drift silently if the matrix changes.
5. **`https://github.com` fallback under the "never hardcoded" contract.**
   `app/features/task-detail/task-detail-page.tsx:94` — `const host = githubHost ??
   "https://github.com"` directly beneath the derived-server-side comment;
   `githubHost` is optional in props (:73) and the caller spreads it conditionally
   (:1274), so an omission silently points GHE deployments at github.com.
6. **Hardcoded `profileId:"operator"` + duplicate re-select mechanism.**
   `app/routes/project.agents.tsx:112` returns the magic string so
   `agents-page.tsx:651` re-selects the operator — but `deleteProfile` already does
   `if (sel === profileId) setSel("operator")` client-side (:672-673). Two
   mechanisms, one magic string assuming the operator's id is literally `"operator"`.
7. **Notification list caps disagree; nothing pages past 200.** Bell popovers load
   100 (`app/routes/project.tsx:80`, `app/routes/_index.tsx:48`); `/notifications`
   loads 200 (`app/routes/notifications.tsx:36`). The popover's "See all" is the
   only path to rows 101-200; rows past 200 are unreachable in any UI.
8. **Triple-duplicated `requireRunAgents` guard input.**
   `app/routes/project.task.tsx:466-473, :516-523, :550-557` construct the same
   `{slug, memberRoles: new Map(listProjectMembers…), archived}` inline for
   `run-operator` / `schedule-action` / `cancel-schedule`. Drift hazard when the
   guard input shape changes.
9. **Review queue's lock chip is a button dressed as a static file-chip.**
   `app/features/review/review-page.tsx:96-105` — `hero-file` class + inline
   `cursor:pointer`, navigates to Policy; visually indistinguishable from
   non-interactive `hero-file` spans (e.g. task hero file path,
   task-detail-page.tsx:384).
10. **Task-detail Permissions panel is hand-maintained prose.**
    `app/features/task-detail/task-detail-page.tsx:190-260` — row VALUES derive from
    `roleCan` (:209-225, honest today) but the copy ("V1 rules" :239, "admin
    releases anyone") is prose maintained by hand, not rendered from the matrix like
    Policy's table.
11. **Layout loader mutates projection objects in place.**
    `app/routes/project.tsx:53` — `for (const t of tasks) t.waitingOnMe = …` mutates
    what `getBoard` returned. Safe only while `getBoard` builds fresh objects per
    call (comment admits it); a future cache in `board-query.server` would leak one
    viewer's `waitingOnMe` to another.
12. **Live roster still falls back to the raw profile id.** P11-42 resolves names via
    the roster map, but `agents-page.tsx:513` renders `nameById?.[d.profileId] ??
    d.profileId` — a deployment whose profile was deleted from the roster shows a
    slug-ish id again (`AgentDeploymentView` carries no display name,
    `agent-types.ts`).
13. **A `.server.test.ts` lives in `app/routes/`**
    (`app/routes/run-artifact-routes.server.test.ts`). Never mounted (routes.ts is
    explicit) — a colocation oddity that can confuse tooling treating
    `app/routes/*` as route modules. (Still imports the demo fixture from
    `test-support/` post-seed-move — correctly.)
14. **`/resources/health` is unauthenticated** *(by design)* — exposes projection
    counts + which backends are credentialed
    (`app/routes/resources.health.ts:24-44`). Ops probe; don't auth it, don't extend
    it with data.
15. **`intent=login` has no CSRF token** *(by design — pre-session)* — only
    `assertTrustedOrigin` (`app/routes/login.tsx:57`); `set-password` does assert
    CSRF (:122). Don't "fix" into a broken login; don't copy the pattern to
    session-bearing actions.
16. **`set-credential` takes no token** *(by design)* — both credential surfaces
    (GitHub view + Settings) bind the **org default connection's PAT**
    (`app/features/github/github-actions.server.ts:100-122`); no way to point a
    project at a non-default connection from these UIs (rotation happens on the org
    connection). Testers will look for a token field and not find one.
