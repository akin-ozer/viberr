# Viberr — Routes + UI Surface Map (pass 11, 2026-07-23)

Audience: implementation subagents with **zero other context**. Everything below is
verified against the code on `main` as of 2026-07-23 (post-PR #84: node:sqlite,
better-auth, node:fs watchers). All paths are relative to the repo root
`/Users/akinozer/projects/viberr`.

## 0. Architecture in one paragraph

React Router v8 **framework mode**. Route table is explicit in `app/routes.ts` (no
file-convention globbing — `app/routes/run-artifact-routes.server.test.ts` sits in the
routes dir but is never mounted). Every page loads via a route `loader` reading SQLite
projections (`getDb()` from `app/server/db/sqlite.server`); every mutation is a POST
route `action` dispatching on a form field named `intent`, guarded by
`requireFormAction` (`app/server/auth/form-action.server.ts:7` = better-auth session +
CSRF `_csrf` field check) or route-specific `requireAuth`/`requireRole`/
`requireProjectMember`. There is **no optimistic UI for governed state** — mutations
return `{ ok, toast }`, the client shows the server-computed toast, and SSE-driven
revalidation (`useLiveUpdates`) re-runs loaders. RBAC is single-sourced in
`app/shared/rbac.ts` (`ACTION_ROLES`; A=admin, M=maintainer, C=contributor, V=viewer)
and enforced server-side via `assertProjectAction`/`requireRunAgents`
(`app/server/auth/project-authority.server.ts`); org admins pass every project gate as
the audited "D2 override".

Route table (`app/routes.ts`):

| URL | Module |
|---|---|
| `/` | `routes/_index.tsx` (Home) |
| `/login` | `routes/login.tsx` |
| `/logout` | `routes/logout.tsx` (POST only) |
| `/org/settings` | `routes/org.settings.tsx` |
| `/api/auth/*` | `routes/api.auth.$.ts` (better-auth splat) |
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

---

## 1. `app/root.tsx` — document shell

- **Loader** (`root.tsx:41-68`): runs on every document request. Returns
  `{ theme, motion, user, csrf }`.
  - `theme` from the `viberr_theme` cookie (`getThemePreference`).
  - `motion` (`"full" | "reduce"`) from `user_prefs` key `motion` (root.tsx:50-53).
  - `user` = better-auth session user or null (via `authenticateWithHeaders`, which also
    forwards better-auth's rolling-session renewal `Set-Cookie` — root.tsx:63-67 with a
    `headers` export at :72).
  - `csrf` = session-bound token (`getCsrfToken(sessionId)`), consumed everywhere via
    `app/ui/csrf-input.tsx` (`<CsrfInput />` hidden field / `useCsrfToken()` for
    programmatic `fetcher.submit`).
- **Layout** (`root.tsx:100-131`): renders `<html data-theme data-motion>` +
  an inline pre-paint theme boot script (`themeBootScript`, root.tsx:87-98) that reads
  the `viberr_theme` cookie as authoritative and resolves `system` against
  `prefers-color-scheme` (live-follows OS changes).
- **App** (`root.tsx:133-158`): wraps the outlet in `<ToastProvider>`
  (`app/ui/toast.tsx` — `useToast()` push API; all toasts in the app render through
  this one provider). A post-paint effect keeps `data-theme` in sync when the pref
  changes.
- **ErrorBoundary** (`root.tsx:160-203`): renders thrown `data("<message>", {status})`
  strings as the page copy (404 "Page not found", 403 messages from
  `requireProjectMember`, etc.), plus a "Back to home" link. Dev-only stack trace.
- There is **no global nav in root** — the Home page and the workspace shell each render
  their own topbar (see §3 and §5). Notifications bell + user menu are shared
  components (`app/features/shell/top-bell.tsx`, `user-menu.tsx`) mounted by both.

---

## 2. Auth routes

### `/login` — `routes/login.tsx`

- **Loader** (:33-54): `authenticate()`; if signed in and no forced reset → redirect to
  `returnTo ?? "/"`. Returns `{ mode: "login" | "reset", returnTo, providers: { github, google } }`
  where provider flags = OAuth env vars configured (`GITHUB_OAUTH_CLIENT_ID/SECRET`,
  `GOOGLE_OAUTH_CLIENT_ID/SECRET`).
- **Action** (:56-148), guarded by `assertTrustedOrigin` (no CSRF token for `login` —
  pre-session; `set-password` DOES `assertCsrf` at :122):
  - `intent=login` — email + password via `loginWithCredentials` (better-auth). Error
    copy per reason: wrong_password / rate_limited / disabled / unknown-email
    (:89-100). On success forwards better-auth `Set-Cookie`s + syncs `viberr_theme`
    cookie; a `mustResetPassword` account redirects back to `/login` in reset mode.
  - `intent=set-password` — the forced-reset step (`npw`/`npw2`, min length from
    `~/shared/auth/password-policy`), `completeForcedPasswordReset`, then redirect.
- **UI** (two modes):
  - *login*: aside brand panel (aria-hidden marketing copy, :333-346); "Continue with
    GitHub" / "Continue with Google" buttons that POST JSON to
    `/api/auth/sign-in/social` and follow the returned provider URL (:302-325) —
    disabled with "not configured" labels when the loader flag is off; local
    email+password `<Form>` (`intent=login`); a **"Forgot password?" button that only
    shows an info message** ("Ask an admin to reset…", :518-531) — there is no
    self-serve reset flow, by design.
  - *reset*: `SetNewPassword` form (`intent=set-password`, CSRF included).

### `/logout` — `routes/logout.tsx`

- **Action** (:11-34): CSRF-checked POST; records `auth.logout` audit row; calls
  better-auth `signOut` and forwards its cookie-clearing `Set-Cookie`s; redirect
  `/login`. **Loader** redirects `/` (GET never logs out).

### `/api/auth/*` — `routes/api.auth.$.ts`

- Both loader and action forward the raw `Request` to `getAuth().handler(request)`
  (better-auth's own router: `/api/auth/sign-in/social`, OAuth callbacks under
  `/api/auth/callback/*`, `getSession`, `.well-known`, sign-out). No app CSRF —
  better-auth enforces its own trustedOrigins check.

---

## 3. Home — `/` (`routes/_index.tsx` → `app/features/home/home-page.tsx`)

- **Loader** (`_index.tsx:36-52`): `requireUser`. Returns:
  - `user` (session), `greet` (hour-based),
  - `projects` = `listHomeProjectsForUser(db, {id, role})`
    (`app/features/home/home-query.server.ts`) — per-project card data: stages, task
    distribution `dist`, `total/running/waiting/overrideWaiting`, members, repo,
    `archived`, `updatedAt`,
  - `prefs` = `getHomePrefs` (per-user `view` grid/list + `stars` pin map, stored in
    `user_prefs` DB table — not localStorage),
  - `org` = `getHomeOrgSummary` (connection owners, user counts, agent-resource counts),
  - `notifications` (limit 100) + `unread` counts (per-user `notifications` table),
  - `storeRoot` = `VIBERR_DATA_ROOT` (shown in the create-modal footer).
- **Action intents** (`_index.tsx:54-142`, all through `requireFormAction`):
  - `pin` (:64) — `slug` + `pinned=1|0` → patches `prefs.stars`.
  - `view` (:73) — `view=grid|list` → patches `prefs.view`.
  - `rescan` (:78) — **org-admin only** (inline check :83, 403 otherwise) →
    `rescanProjections` (all projects, files ↔ projections reconcile).
  - `rebuild-projections` (:95) — **org-admin only** → `rebuildProjections`
    (drop + re-project everything).
  - `create-project` (:110) — deliberately **any signed-in user** (no org gate; creator
    is seeded as project admin). Fields: `name, key, owner, repoName,
    template=governed|light, policy=strict|balanced|auto` → `createProject`
    (`app/features/home/project-create.server.ts`).
- **SSE** (`_index.tsx:150`): `useLiveUpdates([user, projects])` — `user` scope for the
  bell, the `projects` firehose so landing cards refresh on any project/task change.
- **UI** (`home-page.tsx`): see controls inventory §7.1.

`/projects` (`routes/projects.tsx`) is a bare redirect to `/`.

---

## 4. Overlay routes (URL-addressable full-page modals via `app/ui/page-overlay.tsx`)

Both render as native `<dialog>` overlays with a close X; closing navigates to
`location.state.returnTo ?? "/"`.

### `/profile` — `routes/profile.tsx` → `app/features/profile/profile-page.tsx`

- **Loader** (:48-54): `requireUser` → `getProfileView(db, user.id)` = `{ user:
  {name, title, email, idp, createdAt, avatarTone, hasPassword, githubConnected,
  githubHandle}, memberships, accessRole, prefs: {notifs, motion, tlDefault} }`.
  404s if the account row vanished.
- **Action intents** (:56-128, CSRF-checked; AppErrors mapped to `{ok:false}` at
  :116-127 so the overlay never crashes):
  - `identity` — `name`, `title` → `updateProfileIdentity`.
  - `set-notif` — `category` + `on=1|0` → `setNotifRoutingPref` (per-category in-app
    routing toggles from `PROFILE_NTF` in `notification-prefs.ts`).
  - `set-motion` — `motion=full|reduce` → `user_prefs` (SSR `<html data-motion>` hook).
  - `set-tl-default` — `tlDefault=all|typed|comment` (task-timeline default filter).
  - `change-password` — `current/next/confirm` → `changeOwnPassword` (only shown when
    `user.hasPassword`).
  - `github-disconnect` — `disconnectGithubIdentity` (with lockout guard server-side).
- **Theme is NOT this route's action** — the Appearance panel posts
  `theme=light|dark|system` to `/prefs/theme` via a separate fetcher
  (`profile.tsx:158-165`) and applies `data-theme` optimistically.
- **GitHub Connect** (profile-page.tsx:448-473) POSTs `/api/auth/sign-in/social` with
  `{provider:"github", callbackURL:"/profile"}` and follows the URL — the real OAuth
  link flow.
- No SSE subscription on this overlay.

### `/notifications` — `routes/notifications.tsx` → `app/features/notifications/notifications-page.tsx`

- **Loader** (:30-37): `requireUser` → `listNotifications(db, user.id, {limit: 200})` +
  `countUnreadNotifications`.
- **No action of its own** — all read mutations go to `/notifications/read`:
  - row click / open → `intent=read` with repeatable `id` fields (:59-67);
  - "Mark all read" → `intent=read-all` (:69-75, pushes an optimistic toast).
- Opening an item with `projectSlug`+`taskKey` navigates to
  `/projects/:slug/tasks/:key` (:77-81).
- **SSE** (:50): `useLiveUpdates([user])` — new rows / packet-resolution auto-reads
  land live.
- Page split (`notifications-page-helpers.ts`): "Waiting on you" packet/approval cards
  vs "Everything else" day-grouped stream, All/Unread mini-seg filter.

### `/notifications/read` — `routes/notifications.read.tsx` (resource action)

- **Action** (:21-39): CSRF; `intent=read` (repeatable `id`) →
  `markNotificationsRead`; `intent=read-all` → `markAllNotificationsRead`. Idempotent;
  server emits user-scoped `notification.read` SSE so other tabs' badges update.
  Loader redirects to `/notifications`.

### `/prefs/theme` — `routes/prefs.theme.tsx` (resource action)

- **Action** (:19-33): CSRF; `theme` must satisfy `isThemePreference` → writes
  `users.theme` AND sets the `viberr_theme` cookie (`headers` export :36 surfaces the
  action's Set-Cookie). Called from the user-menu Theme cycler and the Profile
  Appearance panel. Loader redirects `/`.

---

## 5. Org settings — `/org/settings` (`routes/org.settings.tsx` → `app/features/org-settings/*`)

- **Loader** (:68-71): `requireRole(request, "admin")` (org role) →
  `{ view: getOrgSettingsView(db), meId }`. View slices: `connections`, `users`,
  `domains`, `kbs`, `mcps`, `skills`, `gagents`, `stages` (kb/skill trees are real
  disk scans).
- **Action** (:99-390): `requireRoleAuth(request, "admin")` + CSRF, one big intent
  switch; results are `{ok:true, toast?}` or `{ok:false, error}` (rendered in the open
  modal's `.cred-warn` or as a toast via `use-org-action.ts`):
  - **Connections**: `connection-add` (owner+token, real scope validation — nothing
    saved on failure), `connection-replace` (token rotate), `connection-default`,
    `connection-remove` (409 when default).
  - **Users & access**: `user-role`, `user-edit` (self-demote blocked :161-164),
    `user-reset-password` (returns one-time `tempPassword`), `user-remove`,
    `user-disable` / `user-enable` (kills sessions; last-admin guard server-side),
    `invite-github` (whitelist handle), `invite-google`, `invite-domain`
    (`@company.dev` allowlist), `invite-local` (creates account, returns
    `tempPassword` + `email`), `domain-remove`.
  - **Agent resources**: `kb-save`/`kb-delete`/`kb-reindex` (real folder re-scan),
    `mcp-save` (name/transport HTTP|stdio/target/cred — cred sealed, never
    round-tripped)/`mcp-test` (real reachability probe)/`mcp-delete`,
    `skill-save` (name/summary/SKILL.md body)/`skill-delete`,
    `agent-save` (global profile: name/backend/summary/stages/skills/mcps/kbs as JSON
    arrays)/`agent-delete` (409 `in_use`).
  - **Store browser**: `store-upload` (multipart `files` + parallel `filePaths`,
    structure-preserving; captures SKILL.md content), `store-mkdir`, `store-delete`,
    `store-import-github` (URL snapshot import). Target resolved by
    `resolveStoreTarget(kind, id)`.
- **UI** (`org-settings-page.tsx`): back button → `/`; tab rail rides
  `?tab=connections|users|resources` (default connections) with live counts; three
  panels (`connections-panel.tsx`, `users-panel.tsx`, `resources-panel.tsx` +
  `kb-browser/store-browser.tsx`). Controls in §7.9.
- No SSE subscription here; mutations rely on fetcher revalidation.

---

## 6. Workspace — `/projects/:slug` and children

### 6.1 Layout — `routes/project.tsx`

- **Loader** (:36-83): `requireUser` (any signed-in user may VIEW a board — app-wide
  read is deliberate); 404 when `getBoard` returns null. Returns:
  - `board` (project + columns of `TaskSummary` + `orphanTasks` + `members`),
  - per-task `waitingOnMe` annotation (R8-3): mutates the fresh `getBoard` objects in
    place with the viewer's open-decision set (:48-53),
  - `myRole` = membership role, or `"admin"` when `orgAdminOverride` (org admin viewing
    a project they're not a member of — D2; drives the topbar honesty pill),
  - `taskCount` (ALL tasks incl. Done — rail Board badge), `reviewCount` (tasks in the
    resolved review stage), `violations` (open policy violations — rail Settings
    badge), `notifications` (limit 100) + `unread` (topbar bell).
- **Component** (:85-149): renders `Rail` + `Topbar` + archived banner (when
  `board.project.archived`) + `<Outlet/>`. Children read this loader via
  `useRouteLoaderData("routes/project")`.
- **SSE** (:101-105): ONE stream per tab: `project:<slug>` + `user`, plus
  `task:<slug>/<key>` when a task route is open (detected via `useMatches` id
  `routes/project.task`). Any matching event revalidates layout + child loaders
  (debounced 300 ms in `use-live-updates.ts:26`).

Shell components (`app/features/shell/`):
- **Rail** (`rail.tsx`): project switcher link → `/`; 7 nav items from
  `nav.ts` `WORKSPACE_NAV` (Board / Review queue / Agents / Policy / GitHub / Activity
  / Settings) with live counts (board=taskCount, review=reviewCount,
  settings=violations when >0). Task routes keep Board active
  (`workspaceViewFromPathname`, nav.ts:35).
- **Topbar** (`topbar.tsx`): brand → `/`; crumbs (project → view, or project → Board →
  task); `org-admin override` pill when applicable (:123-130); **real search input** —
  on the board it writes `?q=` (replace, no scroll reset); on any other workspace view
  typing navigates to the board with the query (:63-80); ⌘K/Ctrl-K focuses it
  (:83-92). Then `TopBell` + `UserMenu`.
- **TopBell** (`top-bell.tsx`): bell button with pulse badge; popover (non-modal
  `<dialog open>`) listing notifications; item click marks read + navigates to the
  task; "Mark all read"; "See all" → `/notifications` with `returnTo` state; Escape
  closes.
- **UserMenu** (`user-menu.tsx`): avatar button; menu: "Profile & preferences" →
  `/profile` (with returnTo), "Switch project" → `/` (workspace only), "Theme · X"
  cycler (light→dark→system→light; posts `/prefs/theme`, menu deliberately stays
  open), "Org settings" → `/org/settings` (org admins only), "Sign out" (POST
  `/logout` `<Form>` with `<CsrfInput/>`).

### 6.2 Board — `/projects/:slug/board` (`routes/project.board.tsx` → `app/features/board/board-page.tsx`)

- **No loader** — data comes from the layout loader (one query feeds rail counts AND
  columns; every action here revalidates both).
- **Action intents** (:21-88):
  - `create-task` (:25) — `title/goal/stage` → `createTask` (RBAC inside: contributor+).
  - `reorder` (:42) — `taskKey`, `to` (stage id), `beforeKey` (card to land before,
    empty = end) → `reorderTask` (admin|maintainer, server re-checks). Cross-stage
    move posts the `**Transition:**` timeline comment; dragging into Done is an
    ACCEPTANCE (merge attempt) with honest toast copy (:63-67).
  - `rescan` (:70) — `assertProjectAction("rescan-project", …)` (maintainer+ per
    `ACTION_ROLES`, rbac.ts:60) → `rescanProject` scoped to this slug.
- **Component gates** (:90-104): `canCreate` = role ≠ null ≠ viewer; `canTransition` =
  admin|maintainer.
- **URL state**: `?filter=all|human|agent|risk` (`board-filters.ts` — `human` is
  member-scoped `waitingOnMe`), `?view=list`, `?q=` (search: key/title/branch/
  owner/specialist/reviewers/operator — board-filters.ts:51-66).
- Full controls in §7.3 (drag-and-drop, keyboard StageMenu per card, New-task modal).

### 6.3 Review queue — `/projects/:slug/review` (`routes/project.review.tsx` → `app/features/review/review-page.tsx`)

- **Loader** (:20-34): `requireProjectMember` FIRST (a non-member must not learn the
  project exists), then 404. `getReviewQueue(db, slug, {viewerUserId})` →
  `{ ready, working, total }` — `ready` is member-scoped by acceptance authority
  (maintainer+/owner).
- **Zero mutations** — rows navigate to task detail; the "Review → Done · human only"
  chip navigates to Policy. SSE: inherited from the shell (rows leave live).

### 6.4 Agents — `/projects/:slug/agents` (`routes/project.agents.tsx` → `app/features/agents/agents-page.tsx`)

- **Loader** (:33-58): `requireProjectMember`; returns
  `profiles` (= `assembleAgentRoster`: org templates ⊕ project.md deployments, incl.
  the reserved operator), `deployments` (live projection: assignments ⋈ agent_runs),
  `stages`, `projectName`, `resourceCatalog` (live org skills/MCP/KB store, scoped to
  `specialist` profiles).
- **Action intents** (:60-122): `create-profile` / `update-profile` (JSON `payload`
  field parsed leniently) / `delete-profile` — all via the phase-3 project.md writers
  (RBAC inside; project-admin). Delete returns hardcoded `profileId:"operator"` (:112)
  so the page's handled-effect re-selects the operator.
- **UI**: Profiles/Live tabs; roster list + `ProfileDetail` (eligible stages,
  three-bucket capability policy, resources, deployments); `CreateProfileModal`
  fetches `/resources/model-catalog?backend=` on backend pick
  (`create-profile-modal.tsx:786-790`); `CapabilityMatrixModal` shared with Policy.
  `?profile=<id>` deep-links a profile selection (agents-page.tsx:587). Controls §7.4.

### 6.5 Policy — `/projects/:slug/policy` (`routes/project.policy.tsx` → `app/features/policy/policy-page.tsx`)

- **Loader** (:27-35): `requireProjectMember`; `getPolicyViewData` → members+roles,
  workflow transitions, agent-profile roster (shared with Agents), audit-derived
  `edited` chip.
- **Action intents** (:37-73): `set-role` (`userId`, `role` — last-admin guard
  server-side) and `set-boundary` (`from`, `to`, `boundary=auto|approval|human`;
  review→done hard-locked human). Both admin-gated inside the mutations.
- **UI**: Human access panel (per-member 4-role radio seg + read-only RBAC grant table
  from `RBAC_ROWS`), Agent capability panel (per-profile counts; rows navigate to
  `/agents?profile=<id>`), Workflow rules panel (per-transition 3-way boundary seg,
  locked rows show "locked · V1"), Capability-matrix modal. Non-admins see everything
  read-only (`canManage = myRole === "admin"`, :425). Controls §7.5.

### 6.6 GitHub — `/projects/:slug/github` (`routes/project.github.tsx` → `app/features/github/github-view.tsx`)

- **Loader** (:31-39): `requireProjectMember`; `getGithubViewData` (async — live
  `checkRepoAccess` probe + credential health + PR/branch rows from
  task_projections + `reconcile` freshness + `githubHost`).
- **Action intents** (:41-78) — all through `assertProjectAction`:
  - `reconcile` → RBAC `reconcile-github` (A|M) → `runReconcile` (real GitHub
    reconciliation of branches/PRs; degraded modes are values with honest toasts).
  - `grant-scope` → RBAC `grant-github-scope` (A|M) → `runGrantScope`
    (re-validate PAT scopes; resolves open scope violations, drops the rail badge).
  - `set-credential` / `clear-credential` → same `grant-github-scope` gate →
    `runSetCredential` (binds the **org default connection's PAT** — no token field in
    the form, see `github-actions.server.ts:100-122`) / `runClearCredential`.
  - Archived projects are read-only for all of these (R8-5, enforced in the guard).
- **UI**: Repository panel (+ `CredentialCard` with scope chips, VIB-142 violation
  banner, Grant-scope + Fix-in-Settings buttons, attach/rotate/remove actions),
  Pull-requests panel, Execution-branches table, freshness chip
  ("Reconciled X ago" / "Never reconciled"), Reconcile button, "Open on GitHub"
  external link. Rows navigate to task detail. Controls §7.6.

### 6.7 Activity — `/projects/:slug/activity` (`routes/project.activity.tsx` → `app/features/activity/activity-page.tsx`)

- **Loader** (:34-64): `requireProjectMember`; bounded newest-first slices —
  `?stream=` and `?audit=` URL params raise limits (steps/caps in
  `feed-limits.ts`). Returns `stream`, `streamTotal`, `audit`, `auditTotal`.
- **Read-only** (no action). Actor filter (All/Humans/Agents/System) is client state
  and does NOT touch the audit panel (mock parity). "Show older" buttons bump the URL
  params. Long texts collapse behind Show more (activity-page.tsx:27-64). Task-key
  keybtns navigate to task detail. SSE via shell.

### 6.8 Settings — `/projects/:slug/settings` (`routes/project.settings.tsx` → `app/features/project-settings/settings-page.tsx`)

- **Loader** (:44-52): `requireProjectMember`; `getSettingsViewData` → project
  identity, stages + per-stage counts, members (with invite status), credential
  health, `repoOverride` flag, `archived`.
- **Action intents** (:54-176):
  - `save-project` (`name/prefix/description`), `rename-stage`, `add-stage` (returns
    `stageId` → new row drops into edit mode), `remove-stage`, `reorder-stages`
    (comma-joined `orderedIds`; entry/terminal pinned),
  - `invite` (`name`,`email` — member joins as Viewer), `remove-member` (`userId`),
  - `override` (`enabled=true|false` — task-level repo override toggle),
  - `grant-scope` / `set-credential` / `clear-credential` — same
    `grant-github-scope` RBAC as the GitHub view (:133-150),
  - `archive-project` (`archived=true|false`), `delete-project` (`confirmName` typed
    match; on success `redirect("/")`).
- **UI gates**: identity/stages/members/danger-zone `canManage = admin`; credential
  `canGrant = admin|maintainer`. Controls §7.7.

### 6.9 Task detail — `/projects/:slug/tasks/:key` (`routes/project.task.tsx` → `app/features/task-detail/task-detail-page.tsx`)

- **Loader** (:75-144): `requireUser` (app-wide task read is deliberate). Returns:
  - `task` = `getTaskDetail` with a bounded newest-first `timeline` slice (`?events=`
    param, `timeline-slice.ts`), plus `timelineTotal/HasMore/Remaining/NextLimit`,
  - `tlDefault` (user pref, sanitized :88-90),
  - `runtime` = `listRunsForTask` (per-task provider-run projection: lifecycle, kind
    `primary|reviewer|operator`, lines+raw, tokens, sid),
  - `deployedSpecialists` (assign menus), `deliveringActive` (only the DELIVERING run
    single-flights — F10-04), `activeReviewerIds` (per-reviewer run gating),
  - `mentionables` (@-autocomplete directory: agents, users, reserved handles),
  - `recommendations` + pending `schedules` — read from the **task FILE frontmatter**
    (`readTaskFile`, :119-124), not the projection,
  - `githubHost` (GHE-safe browse links).
- **Action intents** (:153-551, all `requireFormAction`; toast copy is the verbatim
  spec §5 contract, computed here):
  - `comment` — `text`; `commentToAgent` records it and, when an agent is @mentioned
    by an admin|maintainer, resumes that agent's session; returns `logThreadId` for
    log auto-select (BUG 3) + toast variants (:178-186).
  - `update-goal` — `goal` (admin|maintainer via canEditGoal=run-agents in UI).
  - `resolve-packet` — `option` (index); server re-reads packet and dispatches on the
    option's stable `kind` (accept_completion / block_on_policy / hold_runtime_debug /
    retry_other_backend / edit_goal / …); `block_on_policy` returns
    `navigateTo:/projects/:slug/settings` (:233-236).
  - `complete-merge` — real GitHub merge for an accepted "merge pending" PR (S2;
    accept-completion RBAC).
  - `owner-take` / `owner-assign` (`userId`) / `owner-release` (forced-release toast
    when admin releases someone else, :279-295) — `own-task` tiering.
  - `transition` — `to` stage id, manual move via StageMenu (approve-transition A|M).
  - `run-interrupt` — `runId`; idempotent-safe (run-agents RBAC).
  - `assign-specialist` / `run-specialist` (+optional `backend` override for D4
    retry) / `assign-reviewer` / `run-reviewer` (`profileId` + optional `backend`) /
    `remove-reviewer` — all run-agents (A|M).
  - `apply-recommendation` / `dismiss-recommendation` — `recId` (A|M).
  - `run-operator` — `backend=claude|codex`, `autonomy=supervised|full`;
    `requireRunAgents` guard (:448-459) then `runOperator` attributed to the human
    presser (D8).
  - `schedule-action` — `delayMinutes/backend/autonomy/note` → `scheduleTaskAction`
    (O-3, server-side runner fires later); `cancel-schedule` — `scheduleId`.
- **ErrorBoundary** (:602-629): task-scoped "Task not found" panel with a Back-to-board
  link (does not take down the shell).
- **SSE**: shell adds the `task:` scope; PLUS the page runs a **dedicated log
  consumer** `useRunLogStream` (`app/features/runtime/use-run-log-stream.ts`) with its
  own EventSource on the task scope: `run.log-appended` → fetch tail from
  `/resources/run-log?runId&since=seq` and append (no loader refetch per line);
  `run.state-changed` → one revalidation; a 20 s safety interval revalidates while a
  run shows active (F22 self-heal, :76-82).
- **Layout** (contract order, task-detail-page.tsx): hero → LiveRunPanel → Diagnostics
  → DecisionPacket → OperatorRecommendations → ScheduledActions → ExecutionProfile →
  AgentLogsPanel → Timeline; sidebar: GithubTrace → CurrentState → Permissions.
  Controls §7.8.

---

## 7. Resource routes (no UI)

### `/resources/events` — `resources.events.ts` (SSE, Phase 6)

- GET only. Auth = session cookie; unauthenticated/pwreset returns **401 JSON** (an
  EventSource can't render a login page; client backs off and retries) (:54-59).
- Repeatable `scope=` params: `project:<slug>` | `task:<slug>/<key>` | `projects`
  (firehose) | `user`. 400 on invalid/absent scope (:62-90).
- **Authorization (D9, :100-129)**: org admins subscribe to anything. Non-admins: the
  `projects` firehose is EXPANDED to their member projects only; explicit
  project/task scopes are dropped unless a member; `user` always passes; all-foreign
  requests get 403 (never an empty stream).
- Streaming: `Response` wrapping a never-ending `ReadableStream`;
  `Last-Event-ID` reconnect; `Cache-Control: no-store, no-transform`,
  `X-Accel-Buffering: no`; backpressure cap 1024 queued chunks then drop (:51,
  :140-145). Broker: `app/server/events/sse-broker.server.ts`.
- Event names come from `app/schemas/sse-event.schema.ts` (client mirror
  `app/features/live-updates/event-types.ts`); `stream.open` is a control event that
  never triggers revalidation. Consumers: `useLiveUpdates` (revalidate-on-anything,
  300 ms debounce) and `useRunLogStream` (targeted `run.log-appended` /
  `run.state-changed`).

### `/resources/health` — `resources.health.ts`

- GET, **unauthenticated by design** (readiness probe). 200
  `{ ok, projections:{projects,tasks}, watcher, backends:{claude,codex:
  "real"|"unavailable"} }` — backend flags are env-presence only, never token
  validity. 503 `{ok:false}` when the DB is unreadable. Not consumed by any UI.

### `/resources/run-log` — `resources.run-log.ts`

- GET `?runId=<id>&since=<seq>` (default -1 = all). `requireUser` +
  `requireProjectMember` for the run's project (raw logs are SENSITIVE — F10-06).
  Returns `{ data: { runId, threadId, state, headSeq, lines:[{seq, occurredAt, raw,
  display}] } }`. 400/404 JSON errors. Consumer: `useRunLogStream`.

### `/resources/model-catalog` — `resources.model-catalog.ts`

- GET `?backend=claude|codex` (unknown → claude). `requireUser` only (read is
  ungated). Returns `{ data: { models, efforts, defaultModel, defaultEffort } }` —
  Claude enhances a curated list with the live `supportedModels()` when a credential
  exists; codex is curated-only. Consumer: `CreateProfileModal`.

### `/resources/session-export` — `resources.session-export.ts`

- GET `?run=<runId>`. `requireUser` + `requireProjectMember` (a provider transcript is
  the most sensitive run artifact). Locates the on-disk provider session and streams a
  downloadable **bash installer** (`application/x-sh`, Content-Disposition attachment)
  that places the transcript for local `claude --resume` / `codex resume`. 404 when no
  resumable session/transcript. Consumer: the "Export" link in `SessionIdChip`
  (`runs-panels.tsx:293-308`).

---

## 8. Page-by-page interactive-controls inventory (what a tester can click)

### 8.1 Home (`/`)

- Topbar: brand button (scroll-to-top), project search input (client filter, ⌘K
  focuses), bell (popover: item rows, Mark all read, See all), avatar menu (Profile &
  preferences, Theme cycler, Org settings [admin], Sign out).
- Hero: Grid/List seg (persists via `intent=view`), "New project" button.
- Project cards/rows: whole card → `/projects/:slug/board`; star button
  (pin/unpin, `intent=pin`, optimistic + toast); "New project" ghost tile.
- Sections: Pinned / Everything-else / Archived (list-only, restore hint).
- Settings panel: three `org-tile` links → `/org/settings?tab=connections|users|resources`.
- Store strip (**admin-only render**, home-page.tsx:1147): "Re-scan" (`intent=rescan`,
  spin + result toast), "Rebuild projections" (opens `RebuildConfirm` alertdialog →
  `intent=rebuild-projections`).
- New-project modal: name input (autocompletes key+repo), task-key input (4 uppercase),
  connection pick-chips (required; empty-state links to org settings), repo input with
  `owner/` prefix, template chips (Standard 5 / Lightweight 3), policy chips
  (Strict/Balanced/Autonomous), Cancel, "Create project" (disabled until valid),
  Escape/backdrop close, server error inline.

### 8.2 Login (`/login`)

- Continue with GitHub / Google (disabled + labeled when unconfigured; busy state
  "Checking whitelist…"), email + password inputs, "Sign in" submit, "Forgot
  password?" (info message only), reset mode: new/confirm password + "Save & continue".

### 8.3 Board (`/projects/:slug/board`)

- Header: Board/List seg (`?view`), "Re-scan" (A|M only), "New task" (contributor+).
- Filter bar: All / "Waiting on me · N" / Agent working / Needs attention (`?filter`).
- Orphan banner: per-key links to unstaged tasks.
- Column header: "+" new-task-in-stage (hidden on Done).
- Task card: whole card navigates to task; **drag** between/within columns (A|M;
  ghost + drop preview + optimistic counts; drop → `intent=reorder`); per-card
  keyboard **StageMenu** ("Move to stage" dropdown, same intent); pills (readiness,
  PR#, branch chip, wait-tag).
- List view: row links with the same pills.
- New-task modal: title (required, Enter submits), stage pick-chips (Done excluded),
  goal textarea, Cancel / "Create task", server error in foot-hint.

### 8.4 Review queue (`/projects/:slug/review`)

- "Review → Done · human only" chip-button → Policy.
- Two panels of `rq-row` buttons → task detail. Nothing else is mutable here.

### 8.5 Agents (`/projects/:slug/agents`)

- Header: Profiles/Live tab seg, "Capability matrix" (modal), "New profile"
  (admin only).
- Roster: operator + specialist `ag-item` buttons (select detail), "+" and "New
  specialist profile" buttons (admin).
- ProfileDetail: "Delete" (specialists only, admin → confirm alertdialog →
  `intent=delete-profile`), "Edit profile" (admin → modal), deployment rows → task.
- Live tab: sortable table rows → task detail.
- Create/Edit-profile modal (`create-profile-modal.tsx`): name, role, backend chips
  (fetches model catalog per backend), model + effort selects, stage chips, resource
  picker (live org catalog), submit posts JSON `payload` with
  `intent=create-profile|update-profile`.
- Capability-matrix modal: read-only grid, Close.

### 8.6 Policy (`/projects/:slug/policy`)

- Header: "last change" chip (info), "Capability matrix" button.
- Human access: per-member 4-role radio seg (`intent=set-role`; admin-only enabled;
  client last-admin toast mirror), read-only RBAC table.
- Agent capability: per-profile rows → `/agents?profile=<id>`, "Capability matrix",
  "Manage profiles" → `/agents`.
- Workflow rules: per-transition Auto/Approval/Human radio seg
  (`intent=set-boundary`; review→done row locked + "locked · V1").

### 8.7 GitHub (`/projects/:slug/github`)

- Header: freshness chip, "Reconcile" (`intent=reconcile`, start toast + server
  toast), "Open on GitHub" external link.
- Repository panel / CredentialCard: "Grant scope" (`intent=grant-scope`, only with a
  bound PAT + A|M), "Fix in Settings" → settings, attach/rotate ("Set credential") and
  remove ("Clear credential") via `CredentialManageActions` (bind org DEFAULT
  connection — no token entry here), violation task-key links → task.
- Pull requests: row buttons → task. Branches table: row buttons → task.

### 8.8 Activity (`/projects/:slug/activity`)

- All/Humans/Agents/System radio seg (client filter, stream panel only).
- Per-row task-key keybtns → task; Show more/less on long texts.
- "Show older events · N more" (bumps `?stream=`), "Show older entries · N more"
  (bumps `?audit=`).

### 8.9 Project settings (`/projects/:slug/settings`)

- Project panel: name / prefix / description inputs — **save on blur when dirty**
  (`intent=save-project`; admin only).
- Stages: drag-handle reorder (`reorder-stages`), click name → inline rename input
  (Enter/blur commits `rename-stage`, Escape cancels), per-stage remove X (locked for
  entry/terminal; blocked with toast when tasks remain), "Add stage" (new row enters
  edit mode), "Policy → Workflow rules" keybtn.
- Members: rows with remove X (self/last-admin client toasts), invite name+email
  inputs + "Invite" button (`intent=invite`; joins as Viewer), "Policy → Human
  access" keybtn.
- Repository & credentials: task-level override toggle (`intent=override`, admin),
  Grant scope / Set / Clear credential (A|M), violation task links.
- Danger zone (admin only enabled): "Archive"/"Restore" (`archive-project`), "Delete
  project" → typed-name confirm dialog → `delete-project` → redirect `/`.

### 8.10 Task detail (`/projects/:slug/tasks/:key`)

- Hero: goal "Edit" button (A|M) → textarea + "Save goal"/"Cancel"
  (`intent=update-goal`).
- LiveRunPanel (only while a run is `running`): agent picker (multi-run), "View logs"
  (scrolls + selects), "Interrupt" (A|M, `intent=run-interrupt`).
- DecisionPacket (when open): option radiogroup (arrow-key roving), "Confirm decision"
  (`intent=resolve-packet`, index; blocked for owner-only viewers while
  accept_completion selected), "Ask operator" (prefills `@operator ` into the
  composer).
- OperatorRecommendations: per-card "Apply"/"Dismiss" (A|M,
  `intent=apply-recommendation|dismiss-recommendation`).
- Scheduled re-runs: pending rows with "Cancel" (`cancel-schedule`); scheduler form —
  delay select (5m/1h/6h/24h), backend select, autonomy select, note input, "Schedule
  operator re-run" (`schedule-action`).
- ExecutionProfile:
  - Operator cell: backend select + autonomy select + "Run operator"
    (`run-operator`; disabled when task closed),
  - Delivering agent: "Run" (`run-specialist`; disabled while delivering run active)
    or "Assign delivering agent" menu (`assign-specialist`),
  - Reviewing agents: per-reviewer "Run" (`run-reviewer`, per-reviewer gating) +
    release X (`remove-reviewer`), "Engage reviewer" menu (`assign-reviewer`;
    excludes already-engaged + the deliverer),
  - Human owner: "Assign me" (`owner-take`, contributor+) / "Manage" menu (Take over,
    Hand off to <member> [`owner-assign`], Release… → `ReleaseConfirm` dialog →
    `owner-release`).
- AgentLogsPanel: agent picker, session-id chip (expand / copy / **Export** download →
  `/resources/session-export?run=`), "Retry on <other backend>" (on backend-
  availability failures — D4), `{ } raw` toggle, `follow` toggle, scrollable console.
- Timeline: All/Important/Comments filter tabs (default from profile pref), comment
  composer (@-mention autocomplete menu, highlight backdrop, ⌘↵ send, "Comment"
  button, `intent=comment`; inline error keeps draft), "Show older events · N more"
  (`?events=`), per-comment Show more/less clamp.
- Sidebar: GithubTrace ("Complete merge" for accepted PRs [`complete-merge`, A|M],
  "Open on GitHub" external), CurrentState (StageMenu transition [A|M,
  `intent=transition`], owner Assign-me/release X, waiting-on display), Permissions
  panel ("View project policy" link).

### 8.11 Org settings (`/org/settings`)

- "Projects" back button, 3 tab buttons (`?tab=`).
- Connections: "Add connection" (modal: owner + PAT + validate; `connection-add`),
  per-row "Update token" (`connection-replace`), "Set default"
  (`connection-default`), remove X (default blocked with toast → confirm →
  `connection-remove`).
- Users & access: "Allow access" modal (GitHub/Google/Local seg; handle | email/domain
  | name+email; Admin/Member seg; `invite-github|invite-google|invite-domain|
  invite-local`), temp-password notice (dismissable), domain rows remove X
  (`domain-remove`), per-user: Admin/Member seg (`user-role`), edit pencil (modal:
  name/email/role, "Reset password" [`user-reset-password`, shows temp once], save
  `user-edit`), disable hand-button (confirm → `user-disable`) / enable check
  (`user-enable`), remove X (confirm → `user-remove`).
- Agent resources: 4 panels, each "New/Add" + per-row Browse (KB/skill →
  StoreBrowser), Re-scan (`kb-reindex`), Test (`mcp-test`), Edit, Delete (confirm).
  Modals: KB (name + re-index seg — `kb-save`), MCP (name, HTTP/stdio, target, sealed
  cred — `mcp-save`), Skill (name, summary, SKILL.md body — `skill-save`), Global
  agent (name, backend, summary, stage chips, resource chips — `agent-save`).
- StoreBrowser popup: Upload files / Upload folder / import-from-GitHub toggle + URL
  form (`store-import-github`), New folder (`store-mkdir`), per-node upload/new/delete
  (`store-upload`/`store-delete`), Close.

### 8.12 Notifications overlay (`/notifications`)

- Overlay close X; All/Unread seg; "Mark all read"; "Waiting on you" card rows
  (read + navigate); stream rows (click = mark read; keybtn = mark read + navigate).

### 8.13 Profile overlay (`/profile`)

- Overlay close X; identity name/title inputs (save on blur / Enter); notification
  routing toggles; Appearance: theme 3-way seg (posts `/prefs/theme`), Reduce-motion
  toggle, timeline-default 3-way seg; Your access read-only RBAC list + "Policy →
  Human access" keybtn; GitHub identity "Connect" (OAuth) / "Disconnect"
  (`github-disconnect`); Change password (current/new/confirm + button; only when
  `hasPassword`).

---

## 9. Suspicious / gaps

Factual observations; each cites file:line. None of these are confirmed product bugs
without a runtime check, but they are the places a tester/implementer should poke.

1. **Root loader ships an unread `user` field.** `app/root.tsx:57` returns `user` in
   the root payload on every document request, but the only consumers of the root
   loader are `useCsrfToken` (csrf — `app/ui/csrf-input.tsx:16`) and three theme reads
   (`app/routes/profile.tsx:132`, `app/routes/project.tsx:87`,
   `app/routes/_index.tsx:145`). No component reads `rootData.user` — dead payload
   (and it serializes the whole session user into every HTML response).

2. **No-op `onSubmit` on the goal editor.** `app/features/task-detail/task-detail-page.tsx:393`
   — `<goalFetcher.Form … onSubmit={() => setEditing(true)}>` sets `editing` to true
   while it is already true. Harmless, but it reads like a leftover of an earlier
   close-on-submit behavior.

3. **Hardcoded `profileId: "operator"` in the delete-profile action response.**
   `app/routes/project.agents.tsx:112` returns `profileId: "operator"` so
   `agents-page.tsx:637` (`if (d.profileId) setSel(d.profileId)`) re-selects the
   operator — but the client already does `if (sel === profileId) setSel("operator")`
   in `deleteProfile` (`agents-page.tsx:659`). Duplicate mechanism + a magic string
   that assumes the operator profile id is literally `"operator"`.

4. **Org "New agent profile" modal seeds stages with a hardcoded `["impl"]`.**
   `app/features/org-settings/resources-panel.tsx:378` — new global profiles default
   to stage id `impl`; if the org stage template ever renames/removes that id, the
   default selection silently references a nonexistent stage (the chips just render
   nothing selected for it).

5. **`https://github.com` fallback despite the "never hardcoded" contract.**
   `app/features/task-detail/task-detail-page.tsx:94` — `const host = githubHost ??
   "https://github.com"`, right under a comment saying the host "never hardcoded".
   `githubHost` is optional in props; the fallback would silently point GHE
   deployments at github.com if a caller ever omits it (the current caller always
   passes it, task-detail-page.tsx:1261).

6. **UI role gates hardcode role strings instead of `roleCan`/`ACTION_ROLES`.**
   Server guards go through the single source, but the client mirrors are literals:
   `app/features/github/github-view.tsx:346` (`canGrant = myRole === "admin" ||
   myRole === "maintainer"`), `app/features/project-settings/settings-page.tsx:736-737`,
   `app/features/policy/policy-page.tsx:425`, `app/features/agents/agents-page.tsx:586`.
   Consistent today; will drift silently if `ACTION_ROLES` changes.

7. **Optimistic success toasts before the server answers.** "All notifications marked
   read" fires on submit, not on result (`app/features/shell/top-bell.tsx:55`,
   `app/routes/notifications.tsx:74`); notification-routing flips toast immediately
   (`app/features/profile/profile-page.tsx:214`); theme toast likewise
   (`app/features/shell/user-menu.tsx:85-86`). A failed POST (expired session, CSRF)
   leaves a false success toast; none of these check the fetcher result.

8. **Session "Export" link renders whenever a `sid` exists** —
   `app/features/runtime/runs-panels.tsx:413` (`exportable={!!cur.sid}`) — but the
   server 404s when no on-disk transcript exists
   (`app/routes/resources.session-export.ts:52-59`). Clicking then downloads/renders a
   plain-text error instead of a script. The loader has no "is it actually exportable"
   flag to feed the UI.

9. **Live roster shows the raw profile id as the agent "name".**
   `app/features/agents/agents-page.tsx:507` renders `d.profileId` for non-operator
   rows; `AgentDeploymentView` (`app/features/agents/agent-types.ts:22-34`) carries no
   display name. Elsewhere (task detail) names are resolved via
   `deployedSpecialists`; here users see slug-ish ids.

10. **`/resources/health` is intentionally unauthenticated** but exposes
    projection counts and which backends are credentialed
    (`app/routes/resources.health.ts:24-44`). Fine for a self-hosted ops probe;
    listed so nobody "fixes" it into an auth'd route or, conversely, extends it with
    data.

11. **Layout loader mutates projection objects in place.**
    `app/routes/project.tsx:53` — `for (const t of tasks) t.waitingOnMe = …` mutates
    the objects `getBoard` returned. Safe only while `getBoard` builds fresh objects
    per call (the comment admits this); a future cache in `board-query.server` would
    leak one viewer's `waitingOnMe` to another.

12. **Backend pickers ignore backend availability.** The operator/profile backend
    selects (`app/features/task-detail/execution-profile.tsx:412-431`,
    `create-profile-modal.tsx` backend chips) offer Claude/Codex regardless of
    `isBackendAvailable`; a run on an unconfigured backend fails fast with an error
    toast rather than being prevented (health route knows the answer, the UI never
    asks).

13. **Notification list caps disagree.** Bell popovers load 100
    (`app/routes/project.tsx:80`, `app/routes/_index.tsx:48`), the `/notifications`
    page 200 (`app/routes/notifications.tsx:34`). Not a bug, but the popover's "See
    all" is the only path to rows 101-200, and nothing pages beyond 200.

14. **Board "Re-scan" visibility borrows the transition gate.**
    `app/features/board/board-page.tsx:998` passes `canRescan={canTransition}`
    (approve-transition A|M) while the server checks `rescan-project` (also A|M,
    `app/shared/rbac.ts:60`). Same set today — but the UI key is semantically the
    wrong capability and will desync if either row changes.

15. **`intent=login` has no CSRF token** — only `assertTrustedOrigin`
    (`app/routes/login.tsx:57`); deliberate (no session exists yet), noted so it isn't
    "fixed" into a broken login, and so nobody copies the pattern to
    session-bearing actions.

16. **Triple-duplicated guard boilerplate in the task action.**
    `app/routes/project.task.tsx:449-459, 484-495, 518-529` construct the same
    `{slug, memberRoles: new Map(listProjectMembers…), archived}` object inline for
    `run-operator`, `schedule-action`, `cancel-schedule`. Pure duplication; a drift
    hazard when the guard input shape changes.

17. **Task-detail Permissions panel is static client copy.**
    `app/features/task-detail/task-detail-page.tsx:192-272` ("V1 rules") derives rows
    from `roleCan` locally — honest against `ACTION_ROLES` today, but it is prose
    (e.g. "admin releases anyone") maintained by hand, not rendered from the matrix
    like Policy's table.

18. **A `.server.test.ts` lives in `app/routes/`**
    (`app/routes/run-artifact-routes.server.test.ts`). Not mounted (routes.ts is
    explicit), purely a colocation oddity that can confuse tooling that treats
    `app/routes/*` as route modules.

19. **Review queue's lock chip is a button styled as a static file-chip.**
    `app/features/review/review-page.tsx:96-106` — `hero-file` class with
    `cursor:pointer` inline style navigating to Policy; visually indistinguishable
    from the non-interactive `hero-file` spans used elsewhere (e.g. task hero file
    path, task-detail-page.tsx:384).

20. **`set-credential` takes no token.** Both credential attach/rotate surfaces
    (GitHub view + Settings) bind the **org default connection's PAT**
    (`app/features/github/github-actions.server.ts:100-122`) — there is no way to
    point a project at a non-default connection after creation from these UIs.
    Expected by design (rotation happens on the org connection), but testers will
    look for a token field and not find one.
