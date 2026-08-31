# 04 — UI surface map

Pass 31 discovery. Every user-facing surface in the React Router 8 app: routes, the shell,
the board, task detail, the design system, the `app/ui/` primitive library, and the traps a
UI implementer will hit. Paths are repo-relative to `/Users/akinozer/projects/viberr`.

Framework facts that shape everything below:

- React Router v8 **framework mode** with a typed route config at `app/routes.ts`; loaders
  and actions live in the route module, feature folders hold the components.
- **No optimistic UI for governed state.** Mutations POST to a route action; the SSE stream
  revalidates the loaders; the server's answer is the only commit
  (`app/features/live-updates/use-live-updates.ts:9-18`).
- Every mutating form carries `_csrf` (`app/ui/csrf-input.tsx`) and an `intent` field the
  action switches on.
- One stylesheet: `app/app.css` (5230 lines), no Tailwind, no CSS modules.

---

## 1. Route table

Config: `app/routes.ts`. Three top-level groups — public/auth, the pathless
**palette shell** (F20-30), and the `/projects/:slug` **workspace layout**.

### 1.1 Public / auth / redirect

| Path | Route module | Feature component | What the user sees / does | Loader + actions |
| --- | --- | --- | --- | --- |
| `/login` | `app/routes/login.tsx` | (self-contained, 20 KB) | Two server-driven modes: `"login"` (OAuth provider buttons + local credentials form) and `"reset"` (forced set-new-password behind the `pwreset_required` gate). Brand aside appears at `min-width: 900px` — the sheet's only `min-width` query. | Loader returns `{ mode, returnTo, providers: { github, google } }`; unconfigured providers render **disabled with an explicit reason** (D12), never hidden. Action signs in via better-auth. |
| `/logout` | `app/routes/logout.tsx` | — | No UI. POST only. | Revokes the better-auth session + clears the cookie. |
| `/api/auth/*` | `app/routes/api.auth.$.ts` | — | better-auth's own router (sign-in/out, social, `.well-known`, `getSession`). Splat so OAuth callbacks at `/api/auth/callback/*` reach it. | — |
| `/projects` | `app/routes/projects.tsx` | — | Redirects to `/` — bare `/projects` is a reasonable-looking URL and must not 404 (N5). | — |
| `/` | `app/routes/_index.tsx` | `HomePage` (`app/features/home/home-page.tsx`) | Multi-project landing: greeting, project grid/list toggle, pinned + archived sections, New-project modal, org store strip, settings tiles. Mounts its own `useCommandPaletteShortcut` and the `TopBell`/`UserMenu` pair. | Loader: `user, greet, projects (listHomeProjectsForUser), prefs (getHomePrefs), org (getHomeOrgSummary), notifications (limit 100), unread`, plus data-root hints. Actions: create project, rescan/rebuild projections (single-flight + throttled), home-pref patches. SSE scope `projects` + `user`. |

### 1.2 Palette shell (`app/routes/palette-shell.tsx`)

A **pathless layout** that mounts only `useCommandPaletteShortcut` + `<CommandPalette>`.
It exists because `/profile`, `/notifications`, `/org/settings`, `/controller` and
`/insights` render OUTSIDE the workspace layout as top-level `PageOverlay` routes, so ⌘K —
which Home calls "one shortcut app-wide" — never reached them. It deliberately does **not**
wrap Home or the workspace, both of which mount the hook themselves.

| Path | Route module | Feature component | What the user sees / does | Loader + actions |
| --- | --- | --- | --- | --- |
| `/org/settings` | `app/routes/org.settings.tsx` (27 KB) | `OrgSettingsPage` (`app/features/org-settings/org-settings-page.tsx`) | Tabbed instance-admin surface. H1 reads **"Instance settings"** (the user menu's entry uses the same name — D2 pass 23). Panels: users & access, agent resources (with the KB `StoreBrowser`), connections, SSO, controller admin, agent templates. | Org-admin gated. Many `intent`s through `useOrgAction`. |
| `/org/settings/audit-export` | `app/routes/org.settings.audit-export.ts` | — | CSV/JSON audit-log file download, org-admin gated. | Resource route, no UI. |
| `/controller` | `app/routes/controller.tsx` | `ControllerPage` (`app/features/controller/controller-page.tsx`) | Ruling 99: the instance controller. **Every signed-in user converses**; what it answers and applies is gated per tool call on that user's own authority. Conversations belong to their owner; org admins may read everyone's with `?all=1`. | `getControllerSurface` (`controller-query.server.ts`). |
| `/insights` | `app/routes/insights.tsx` | `InsightsPage` (`app/features/insights/insights-page.tsx`) | Instance-wide agent-run analytics (cost/token totals across projects). **Org-admin only**, read-only: one aggregate query, the page formats it. | Loader only. |
| `/profile` | `app/routes/profile.tsx` | `ProfilePage` (`app/features/profile/profile-page.tsx`) | URL-addressable `PageOverlay`: identity, notification routing prefs, Appearance panel (theme + reduce-motion, ruling 13), read-only RBAC access view, GitHub identity, self-serve password change. | `getProfileView`; actions in `profile-actions.server.ts`. Opened from the user menu with `state.returnTo`. |
| `/notifications` | `app/routes/notifications.tsx` | `NotificationsPage` (`app/features/notifications/notifications-page.tsx`) | URL-addressable `PageOverlay`: "Waiting on you" packet/approval cards, "Everything else" day-grouped stream, All/Unread filter, mark-all-read. Row clicks navigate for real, cross-project included. | Mutations go through the ONE `/notifications/read` action. SSE `user` scope. Opened with `state.returnTo` (parsed defensively — history state is not the app's to trust). |

### 1.3 Resource routes (fetcher / file targets, no UI)

| Path | Module | Purpose |
| --- | --- | --- |
| `/notifications/read` | `app/routes/notifications.read.tsx` | The ONE mark-read action behind both bells and the page. Intents `read` (repeatable `id` fields) and `read-all`. Idempotent; emits a user-scoped `notification.read` SSE so other tabs revalidate (E12). |
| `/prefs/theme` | `app/routes/prefs.theme.tsx` | Theme cycling. Persists to `users.theme` **and** the `viberr_theme` cookie so the next SSR paints correctly. The client applies `data-theme` optimistically. |
| `/resources/events` | `app/routes/resources.events.ts` | The SSE stream. Repeatable `scope=` params: `project:<slug>`, `task:<slug>/<key>`, `projects`, `user`. Plain **401 JSON** for an expired session (an EventSource cannot render a login page); 400 bad scope, 403 all-foreign. `MAX_QUEUED_CHUNKS = 1024` backpressure cap. |
| `/resources/run-log` | `app/routes/resources.run-log.ts` | Run-log tail: lines since a seq, plus backward paging. Member-only (403 otherwise). |
| `/resources/health` | `app/routes/resources.health.ts` | Ops probe: `{ ok, projections, watcher }`. |
| `/resources/search` | `app/routes/resources.search.ts` | ⌘K palette query. `q` truncated to 120 chars; `searchWorkspace` scopes to the viewer's visible projects, so the route needs no project guard. |
| `/resources/model-catalog` | `app/routes/resources.model-catalog.ts` | Model + effort (reasoning) pickers for the agent create/edit modal, per backend. |
| `/resources/session-export` | `app/routes/resources.session-export.ts` | Downloads a bash installer carrying a run's provider transcript so the conversation resumes locally. |
| `/projects/:slug/tasks/:key/attachments/:file` | `app/routes/task-attachment.ts` | Serves one browser-produced attachment (R19-19). **Member-only**, outside the workspace layout. Traversal-refusing resolver, `X-Content-Type-Options: nosniff` + `Content-Security-Policy: sandbox`, whitelisted inline types only, memory-bounded. |

### 1.4 Workspace layout — `/projects/:slug` (`app/routes/project.tsx`)

The single chokepoint for every project surface. Loader:

- 404s an unknown slug **and** a non-member with a byte-identical message (R15-4 / WI-13:
  the reply must never confirm a project exists).
- `orgAdminOverride` — an org admin who is not a member gets audited emergency
  project-admin authority and an honest topbar pill.
- Returns `user, board, myRole, orgAdminOverride, taskCount, reviewCount, violations,
  notifications (limit 100), unread`.
- Rail counts use the **live** (non-archived) predicate `isArchived`, and `reviewCount` is
  zeroed for an archived project — badge/queue parity is an asserted contract (F19-9, F25-2).
- `waitingOnMe` is annotated per task as the **union** of `decisionsRequiring(...).mine` and
  `getReviewQueue(...).ready` so the board chip and the review queue answer one question
  (UI-48).

Renders `SkipLink` → `Rail` → `rail-scrim` → `<main>` (`Topbar`, optional `ArchivedBanner`,
`#main-content` sentinel, `Outlet`).

| Path | Route module | Feature component | What the user sees / does | Loader + actions |
| --- | --- | --- | --- | --- |
| `/projects/:slug` | `project._index.tsx` | — | Redirect to `board`. | — |
| `…/board` | `project.board.tsx` | `BoardPage` (`app/features/board/board-page.tsx`, 96 KB) | The stage board / list. See §3. | Reads the LAYOUT loader via `useRouteLoaderData("routes/project")` — one query feeds rail counts and columns. Intents: `create-task`, `reorder`, `rescan`. Visibility gated by `roleCan(myRole, "create-task" \| "reorder-board" \| "rescan-project")` — the action ids the server enforces, never role literals (UI-58/E3). |
| `…/review` | `project.review.tsx` | `ReviewQueuePage` (`app/features/review/review-page.tsx`) | The review queue: tasks at the review boundary, split by whether the viewer holds acceptance authority. Read-only loader; SSE revalidation removes accepted tasks with no local state. | `getReviewQueue` + `resolveAcceptanceAuthority`. |
| `…/controller` | `project.controller.tsx` | `ControllerPage` | The same controller machinery bound to this board, plus the **Goals panel** where a human sees and redirects every chain (ruling 99). | `getControllerSurface`. |
| `…/agents` | `project.agents.tsx` | `AgentsPage` (`app/features/agents/agents-page.tsx`, 64 KB) + `CreateProfileModal` + `CapabilityMatrixModal` | Agent roster (org templates ⊕ `project.md` deployments), live-deployment view, capability matrix. | Loader assembles roster + live deployments joined with `agent_runs` + stages. Actions: create/update/delete-profile via the phase-3 `project.md` writers; toast copy computed server-side. SSE revalidates on `project.updated` / `task.updated` / `run.state-changed`. |
| `…/policy` | `project.policy.tsx` | `PolicyPage` (`app/features/policy/policy-page.tsx`) | Members + roles, workflow transitions, the RBAC grant table rendered from `app/shared/rbac.ts`, agent roster, audit-derived last-change chip. | `getPolicyViewData`. Actions `set-role` (last-admin guard) and `set-boundary` (review→done hard-locked human). Admin-gated inside the action. |
| `…/github` | `project.github.tsx` | `GithubViewPage` (`app/features/github/github-view.tsx`) + `CredentialCard` | Repository panel, credential health/scopes, PR + branch rows. **The only loader in `app/routes/` that awaits the network** — hence `RoutePendingBar`. | `getGithubViewData` = `checkRepoAccess` + `getProjectCredentialHealth` + task projections. Actions: `reconcile`, `grant-scope`. Every degraded GitHub state is a typed value, never a thrown error. |
| `…/activity` | `project.activity.tsx` | `ActivityPage` (`app/features/activity/activity-page.tsx`, 29 KB) | Cross-task activity stream + audit log, both day-grouped and bounded newest-first. `?stream=` / `?audit=` raise the limits ("Show older"). | Read-only projection loader; shell SSE keeps it fresh. |
| `…/settings` | `project.settings.tsx` | `SettingsPage` (`app/features/project-settings/settings-page.tsx`, 64 KB) | Project identity, stages + per-stage counts, membership with invite status, credential health, **Danger zone** (archive/restore/delete) rendered only for `edit-policy` holders (Q-V1). | `getSettingsViewData`; a large `intent` surface in `settings-actions.server.ts`. |
| `…/tasks/:key` | `project.task.tsx` (52 KB) | `TaskDetailPage` (`app/features/task-detail/task-detail-page.tsx`) | The deepest surface. See §4. | 23 action intents (§4.6). Adds a `task:` SSE scope; keeps the Board rail item active (the task view is "inside" Board). |

### 1.5 Per-surface notes

**Home** (`home-page.tsx:52`, sections in `home-sections.tsx`, cards in `project-cards.tsx`).
Header brand → hero (`{greet}, {firstName}` + a three-way sub-line) → Grid/List seg +
Controller link + New project → `ProjectSections` (Pinned · "All projects", retitled
"Everything else" when a pinned group exists · Archived) → `SettingsPanel` (4 org tiles;
non-admins get `aria-disabled` tiles footed "Org admins manage this") → `StoreStrip`
(**returns `null` entirely for non-admins**). Intents: `view`, `pin` (both **optimistic**,
read back off `fetcher.formData`), `rescan`, `rebuild-projections` (both org-admin +
single-flight/throttled), `create-project`. `NewProjectModal` derives the task key and repo
name from the name two-way until you edit either, warns (never blocks) on a duplicate key,
and navigates into `/projects/<slug>/board` on success. Project creation is deliberately
**self-serve for any signed-in member** — no admin gate. Zero-project state drops the hero
actions so `EmptyHero` carries the page's single primary CTA.

**Activity** (`activity-page.tsx:626`). Two side-by-side panels — **Stream** and **Audit
logs** — each with its own `FeedFilters` instance on **disjoint URL namespaces**
(`sq/sty/sac/stk/sfrom/sto` vs `aq/aky/aac/atk/afrom/ato`). **Zero mutations**: everything is
navigation or URL state. Pagination is `?stream=`/`?audit=` in steps of 200/60, capped at
2000/600 (`feed-limits.ts`), with a "Showing the newest 2000…" note at the ceiling. The
actor mini-seg is **client-side and filters the Stream only**. `compactAuditEntries` folds
runs of ≥2 `runtime.run.started` rows into one "N runtime sessions opened" row (regex
anchored at the end so a hostile display name cannot trigger the fold). `ACT_ICON` is
`satisfies Record<TIMELINE_EVENT_TYPES[number], IconName>` — a new event type is a compile
error.

**Insights** (`insights-page.tsx:48`). Org-admin only, **no actions at all**. Six stat cards,
a daily bar chart (`role="img"`, per-column `title`), five "Delivery oversight" cards, four
breakdown bar-lists (backend / kind / project / model), and a backend quota panel. Honesty
rules: the metric is **"Completion rate"**, not success rate; a null cost renders
**"not reported"**, never `$0.00`; absent values render `"n/a"` with a `.na` de-emphasis so
they cannot read as data.

**GitHub** (`github-view.tsx:405`). Repository + Pull requests side by side, Branches full
width. The header freshness chip carries **two clocks** — last check vs last change. Intents:
`reconcile`, `grant-scope`, `set-credential`, `clear-credential`. `CredentialCard` is shared
with project settings. The credential is **redacted in the loader** by
`withoutCredentialDetail` (`credential-visibility.server.ts:70`), so the token tail never
reaches the HTML. A never-reconciled branch renders **"not compared"**, never green "synced".

**Review queue** (`review-page.tsx:172`). Two panels: "Waiting on your acceptance" and
"Still in review". **Zero mutations** — the row is deliberately labelled **"Review", not
"Accept"**, because acceptance is verdict-gated and may refuse. The one header control is a
chip reading `{reviewStage} → {terminalStage} · human only` (or `· human or operator`) that
navigates to Policy; its state comes from `resolveAcceptanceAuthority`, which requires the
operator to be deployed at full autonomy with `completion-for-acceptance: direct` and falls
back to the strict boundary on any error.

**Controller** (`controller-page.tsx:36`, rendered by **two** routes). Transcript + composer
beside a side column of `GoalsPanel` (project scope only) and `ConversationList` (org admins
can toggle `?all=1`). Intents: `send` (creates a conversation when `conversationId` is
absent, then writes the id into `?c=`) and `goal-op` with `op` in
`pause | resume | cancel | skip_link | retry_link`. Live: `useLiveUpdates` **plus a 5-second
fallback poll while `turn.working`**, because a missed settle event would read as a hang.

**Notifications** (`notifications-page.tsx:269`). "Waiting on you" cards over an
"Everything else" day-grouped stream, All/Unread seg, Mark all read. `splitNotifications`
dedupes to exactly one waiting card per task **before** the filter runs, so filtering cannot
change what counts as pending. The panel header states the authoritative `decisionCount`
(same source as the home hero), and discloses the shortfall as "N on their task pages". Hard
cap `NOTIF_PAGE_LIMIT = 200`, over-fetched by one to detect truncation. Orphan rows render a
dead `span.keybtn.dead` reading "project no longer exists".

**Agents** (`agents-page.tsx:1246`). `.seg` tabs Profiles / Live · N, plus Capability matrix ·
Add from library · New profile. Profiles tab is a master-detail: profile list (Orchestration
= the operator, then Agent profiles) beside `ProfileDetail` — hero, eligible stages,
**Capability policy** in three columns (Acts directly / Recommends only / Reserved for
humans), context resources & runtime, active deployments. Selection and tab ride the URL
(`?profile=`, `?tab=live`). Intents: `create-profile`, `update-profile`, `deploy-profile`,
`delete-profile`. Specialists get **3** capability modes (Allowed / Human-only / Off) while
the operator gets 4 — `recommend` is operator-only. Granting the browser capability **pins**
web egress to Allowed, with the coupling explained on screen. Switching backend clears model
and effort on the click and holds Save until `/resources/model-catalog` answers, so a
Codex model on a Claude profile is unrepresentable.

**Instance settings** (`org-settings-page.tsx:64`). Five `?tab=`-driven tabs with live count
badges — connections · users · sso · resources · controller — plus always-rendered run
concurrency, audit export (browse + CSV/JSON download + S3 target) and a storage line. ~30
intents, all routed through `useOrgAction` to `/org/settings`. `MiniModal` is the shared
editor chrome (Save **truly disabled** when invalid, with an "Fill the required fields (*)"
hint — the opposite choice from the Agents modal, which keeps Save clickable so the refusal
guard can speak). Resources polls every 20 s while an MCP server is `warming`.

**Project settings** (`settings-page.tsx:1569`). Project · Workflow stages / Members ·
Repository & credentials, then `DangerZone` **rendered only for `edit-policy` holders**
(Q-V1). Stage reorder is dnd-kit with the same no-optimistic, no-`Accessibility`-plugin
configuration as the board, and `StageMoveMenu` is the full keyboard path (`role="menu"`,
↑/↓ wrapping, Home/End, Escape returns focus to the trigger). Delete-project requires typing
the project name. Four panels carry read-only `.pol-note` banners naming the exact grant and
tier. `ProjectActionGate` is an injectable gate so each panel pins to *its own* action id
(`edit-policy` / `manage-members` / `grant-github-scope`) even though all three resolve to
admin today.

**Policy** (`policy-page.tsx:622`). Human access (per-member 4-button role radiogroup with
roving tabindex, then the full 19-row × 4-role RBAC table rendered from
`app/shared/rbac.ts`) beside Agent capability, then full-width Workflow rules (a `.flow-map`
of chained stage chips plus a 3-button boundary radiogroup per transition). Only two intents:
`set-role` and `set-boundary`. Two *different* gates on one page — `manage-members` vs
`edit-policy` — deliberately kept separate. `BCLS` reuses the capability colours on purpose
("do NOT fix to semantic names").

**Profile** (`profile-page.tsx:877`). Two columns: Identity / Notification routing /
Appearance, and Your access / GitHub identity / Change password (the last only when the
account has one). **Five separate fetchers** — Appearance was split out of `prefs` because
sharing one stranded the notification panel's rollback snapshot (UI-56). Toggles are
optimistic **with rollback** on the settled result. Theme posts to `/prefs/theme`, not to a
profile intent. Escape in the identity fields **commits** rather than cancels, because
`useDialog`'s cancel unmounts the overlay before React fires `onBlur`.

**Store browser** (`kb-browser/store-browser.tsx:894`). Not a route — a wide modal rendered
by the org-settings resources tab for a KB or a skill. Toolbar (Upload files · Upload folder ·
Add from GitHub · New document · New folder · an `into` destination select), an inline
document editor, and a real on-disk tree. Intents: `store-upload` (multipart, files or whole
folders via `webkitGetAsEntry` recursion), `store-mkdir`, `store-delete`,
`store-import-github`, `store-read-doc`, `store-write-doc`. **Three stacked native dialogs**
with layered Escape via `useDialog`'s `onDismissRequest` (new-folder row → document draft →
close). A truncated read **disables Save entirely** rather than let a partial body overwrite
the file. Row action buttons are always visible — a hover-reveal `opacity: 0` still
hit-tests on touch, so a tap near a row edge could delete a file invisibly.

---

## 2. The shell

### 2.1 Navigation structure

`app/features/shell/nav.ts` is the single source of the rail model — order and copy are
exact (shell spec §4.1):

```
Board · Review queue · Controller · Agents · Policy · GitHub · Activity · Settings
```

- `workspaceViewFromPathname()` maps `/projects/:slug/tasks/:key` → `board`, so a task page
  keeps Board highlighted. `Rail` is a plain `<Link>` (not `NavLink`) with a hand-set
  `aria-current` because NavLink only emits `aria-current` when its own `to` matches, and
  a task URL never matches `.../board` (P13-D-37, WCAG 1.3.1).
- `boardHref(slug, location)` carries `?filter/view/q/label` **only** when already on that
  project's board, so the rail's Board item and the project crumb do not silently reset a
  filtered board (P13-D-35 / UX-7).
- Rail badges: Board = all live tasks incl. Done (ruling 16), Review = live tasks in the
  **structural** review stage (`resolveStageRoles`, not the stage literally named "review"),
  Settings = open policy violations, rendered only when `> 0`.
- Rail width `--rail-w: 232px`; under `max-width: 720px` it becomes an overlay behind a
  topbar toggle. The scrim is a decorative `<div aria-hidden>` (pointer-only); the keyboard
  path is the toggle's `aria-expanded` plus Escape, handled in `topbar.tsx:82-91` with focus
  returned to the toggle.

Topbar (`app/features/shell/topbar.tsx`): rail toggle → brand → breadcrumb `<nav>` (CSS
truncation tiers at 1080px and 760px) → `org-admin override` pill → `live updates paused ·
retry` pill → ⌘K trigger → `TopBell` → `UserMenu`.

### 2.2 Command palette (⌘K)

- One binding: `useCommandPaletteShortcut` (`app/features/shell/use-command-palette.ts`).
  Accepts ⌘ or Ctrl, **excludes Alt** (⌥⌘K / Ctrl-Alt-K are OS/IDE combos). Mounted by
  Home, the workspace `Topbar`, and `palette-shell.tsx`.
- `CommandPalette` (`app/features/shell/command-palette.tsx`) is a native `<dialog>` via
  `useDialog`, so it stacks in the top layer above an open `PageOverlay`.
- Real APG **combobox**: the input keeps focus, `aria-activedescendant` points at the
  highlighted row, options are direct `role="option"` children of a `role="listbox"` through
  `role="group"` wrappers. Rows are `tabIndex={-1}` and `onMouseDown` is prevented so the
  input never blurs mid-click.
- 140 ms debounce; stale results are discarded by comparing `payload.q` to the query on
  screen. Groups: Projects · Tasks · Branches · Agents, `COMMAND_GROUP_LIMIT = 6` per group,
  `TASK_SCAN_LIMIT = 60` (`app/features/shell/command-search.server.ts`).
- Empty states are `role="status"` — a combobox cannot announce "nothing to point at"
  through `aria-activedescendant`.
- The board's `?q=` filter is a **different** question ("hide cards on THIS board") and says
  so (R15-5).

### 2.3 Notifications bell

`app/features/shell/top-bell.tsx` — one implementation for the workspace topbar and Home
(ruling 14).

- A declarative non-modal `<dialog open>` anchored by `.ntf-pop` CSS, plus a `menu-scrim`
  div for pointer dismissal. `useDismiss(open, …, { outside: false })` — Escape or an
  explicit action closes it, not a stray press.
- Focus moves into the panel on open and back to the bell on close (UI-45: the popover is
  rendered **before** its trigger in the DOM).
- `BELL_LIST_CAP = 100`. The head count and the list can disagree, so the footer discloses
  "Showing the newest N".
- `shownUnread = unread + orphan-unread` — `countUnreadNotifications` excludes rows whose
  project is gone, but those rows still render with an unread dot (F19-25).
- Two separate fetchers for row-read and mark-all-read: sharing one meant a row click
  aborted an in-flight mark-all and React Router drops an aborted submission's result
  (R14-3). Both toast on the **server result**, never on submit (P11-40).

### 2.4 Account menu + theme

`app/features/shell/user-menu.tsx`. Items: Profile & preferences · Switch project (workspace
only) · Theme · Instance settings (admins) · Sign out (a real `<Form method="post">` to
`/logout` with `<CsrfInput/>`).

- Theme cycles `light → dark → system → light`. It applies optimistically via
  `applyThemePreference`, POSTs `/prefs/theme`, and toasts only on the server result.
  **The menu deliberately stays open** on theme clicks (rapid cycling).
- `role="menu"`/`menuitem` were deliberately **dropped**: the code has no arrow-key handling,
  and a declared-but-unimplemented ARIA menu contract is worse than plain Tab order (UI-45).
- Theme plumbing: `root.tsx` renders `<html data-theme data-motion suppressHydrationWarning>`,
  an inline `themeBootScript` runs before first paint and treats the `viberr_theme` cookie as
  authoritative (so the ErrorBoundary page cannot flash light on a dark session, F3), and a
  post-paint effect live-follows `prefers-color-scheme` when the preference is `system`.
- `data-motion="reduce"` comes from `user_prefs` and is SSR-rendered so the CSS hook applies
  with no flash (ruling 13).

### 2.5 Live updates (SSE)

`app/features/live-updates/use-live-updates.ts` + `event-types.ts`.

- One `EventSource` per tab for the whole workspace shell. Scopes: `project:<slug>`,
  `task:<slug>/<key>` when a task is open, `user`. Home uses `projects` + `user`.
- **Revalidation IS the update mechanism** — no client cache, no optimistic state. Events
  schedule a trailing 300 ms debounced `revalidator.revalidate()` so bursts coalesce.
  `stream.open` is a control event and never revalidates.
- Recovery, because the HTML spec says an EventSource that receives a non-200 **fails the
  connection and never retries**: `onerror` with `readyState === CLOSED` flips `paused`
  (the topbar chip), and a fresh EventSource is opened on backoff
  `[2s, 5s, 15s, 30s]` counted on **consecutive** failures.
- OBS-6: after `SSE_SESSION_PROBE_AFTER = 2` consecutive failures the client `fetch`es the
  same URL; a 401 means the session is gone, so it sets `signedOut` and **stops** rather than
  hammering `/resources/events` overnight. Anything that is not a 401 counts as alive.
- Any reconnect that follows a previous stream pulls the loaders once — a scope change
  (navigating between tasks) tears down and reopens, and an event in that gap is lost.
- The **run log has its own consumer** (`app/features/runtime/use-run-log-stream.ts`) with
  its own EventSource, because revalidating the whole task loader per log line is not viable.

### 2.6 Route pending + toasts

- `RoutePendingBar` (`app/features/shell/route-pending-bar.tsx`) is mounted once in
  `root.tsx` above the `Outlet`. It shows only for **real navigations**
  (`navigation.location != null`, so SSE revalidation never paints it) and only after
  `ROUTE_PENDING_DELAY_MS = 220`.
- `ToastProvider` is mounted in `root.tsx`; features call `useToast()` → `push(text, kind?)`.

---

## 3. Board UX

`app/features/board/board-page.tsx` (2421 lines) + `board-dnd.ts` + `board-filters.ts`.

### 3.1 Drag model (dnd-kit)

- Library: `@dnd-kit/react` `DragDropProvider` + `useSortable`, `@dnd-kit/dom` presets.
- **Whole card is the drag surface — no grip handle.** `PointerSensor.configure` sets
  `preventActivation` to refuse a lift only from real controls
  (`button, input, select, textarea`), so the card's `<Link>` face still drags.
  Mouse activation is **distance-only** (5 px) so a slow press-and-release stays a
  navigation; touch uses a 250 ms `Delay` (tolerance 5) so column scrolling is not hijacked.
- **`OptimisticSortingPlugin` is filtered out** and `Feedback.configure({ feedback: "clone" })`
  is used: the original stays as a faded `.dragging` ghost, a clone follows the pointer, and
  the board never reorders client-side. The `DropPreview` shows the *requested* slot; the
  server's revalidated order is the only commit.
- The dnd-kit `Accessibility` plugin is **removed from `BOARD_PLUGINS`**: its
  `role="button"` on the card wrapper nests the task link and the StageMenu inside an
  interactive control (axe `nested-interactive`, serious). The accessible move path is and
  stays the per-card `StageMenu` (F10-25); dragging is a pointer enhancement.
- Drop resolution is a pure function, `resolveBoardDrop` (`board-dnd.ts`): returns `null` for
  a no-op (before itself, before the card that already follows it, end-while-already-last),
  degrades a slot that vanished mid-drag to "end of column", and never lets a cross-stage
  slot reference the dragged card. `onDragMove` refines the slot against the pointer's
  vertical midpoint (top half → before this card, bottom half → before `nextKey`).
- **Acceptance interception (B1 / ruling 88):** a drop on the FINAL column is an acceptance
  (a real PR merge), so it opens `AcceptOnBoardConfirm` → the shared `AcceptConfirm`
  ceremony, and the confirmed submit carries `acceptanceDisclosureFields(disclosure)`. The
  server refuses an acceptance POST that arrives without the echo. The keyboard `StageMenu`
  path reaches the same confirm.
- **`aria-live` announcements (D9):** a visually-hidden `SR_ONLY` region announces
  "Move requested: KEY to Stage.", then the completed move in the server's own toast words,
  or "Move refused: …" (including the 409 on an off-boundary move).

### 3.2 Keyboard traversal (D19 / ruling R19-10)

- A **roving tab stop**: exactly one card is tabbable (`rovingKey`), arrows move it, Tab
  leaves the board. `useRovingStageMenu` also rovers the card's `StageMenu` trigger so the
  board holds one stop, not 2N.
- Lanes are read back off the DOM (`data-board-lane` / `data-board-card`), so traversal
  order is by construction what the human sees — filters, archived view and list layout come
  along for free, and empty lanes cannot strand focus.
- Enter and Space both re-issue `from.click()` (the card face is an anchor; Space would only
  scroll).
- Coexistence with the dnd-kit `KeyboardSensor` is verified against `@dnd-kit/dom` 0.5.0:
  the sensor binds to `.card-wrap` while roving focus sits on the descendant `<a>`, and a
  running drag's document-capture arrow handling is respected via the `defaultPrevented`
  guard.

### 3.3 Columns, filters, layouts

- Two layouts, both URL-state only (no sessionStorage): `?view=list` toggles `StageBoard` ↔
  `ListView`; `?filter=`, `?q=`, `?label=` carry the rest.
- Filter chips (`FILTERS`, `board-page.tsx:1335`), all `aria-pressed`:
  All tasks · Waiting on me · Agent working · **Blocked or waiting** (renamed from "Needs
  attention", R16-2) · **No activity** (quiet detector, Gap-10) · **Degraded continuity**
  (D4) · **Archived** (R14-3). The last two render only when the project has any such task,
  or the filter is already on.
- Label chips: `LABEL_CHIP_CAP = 6` visible before a "+N more" overflow; the active label is
  pinned first. The vocabulary mirrors the server's `listProjectLabels` contract exactly
  (archived excluded, case-insensitive dedupe, first spelling wins — F26-15).
- `STATE_PILL_CAP = 2` full-strength state pills per card before a "+N" fold (pass 30).
- The whole `FilterBar` is withheld on a board with nothing to filter.
- Header count is honest: "N of M tasks" when filtered, and the "waiting on a human **in this
  project**" stat names its scope (P14-WL-04 collapsed five near-duplicate "waiting"
  phrasings to one per scope).
- Empty states (`boardEmptyCopy`) name the filter or search that is hiding tasks; the
  teaching line appears only on the entry column of a wholly empty board (R15-10), keyed on
  live tasks so an archived-only board still teaches.
- `OrphanBanner` surfaces tasks whose stage id is not in the workflow.

### 3.4 Card affordances

`TaskCard` (`board-page.tsx:492`), wrapper `role="listitem"` inside a lane list so a screen
reader says "3 of 7":

- `card-top`: mono task key · readiness pill (`ReadinessPill`) or `ArchivedPill`. An
  agent-carried task goes quiet in this slot rather than claiming a human is needed (R21-8).
- `owner-row`: `OwnerLine` + `ReviewerStack` (avatars).
- `card-meta`: `PriorityFlag`, `LabelChips`, `DueDatePill` — only non-default metadata
  renders (`app/ui/task-meta.tsx`).
- `card-foot`: branch chip (`shortBranch`), PR chip, then `StateSignals` (validation, checks,
  PR state, review, wait tag, quiet tag, continuity tag).
- `card-move`: the `StageMenu` trigger, `opacity: 0` until `:focus-within` on hover-capable
  pointers, drawn unconditionally where hover cannot happen (P16-F7 — the fix explicitly did
  *not* reintroduce a grip).
- An **archived** card is inert: no live pills, no drag, no Move menu (F19-8).

---

## 4. Task detail

`app/routes/project.task.tsx` (loader/action) → `app/features/task-detail/task-detail-page.tsx`.

### 4.1 Layout

`.detail` is a CSS grid `minmax(0,1fr) 340px`, collapsing 1-up at `max-width: 1100px`.
**`.detail-side` is FIRST in the DOM** and both children name their grid cell explicitly
(`grid-column` + `grid-row: 1`) rather than using `order` — the spec's stacking rule is a
*reading* order (current state, latest packet, next action, then the timeline), and `order`
created a visual-vs-focus mismatch below the breakpoint (WCAG 1.3.2 / 2.4.3). `.detail` is
the scroll container and is programmatically focused (`tabIndex={-1}`) on mount so keyboard
scrolling works, with its focus ring suppressed (G7).

### 4.2 Side column

| Panel | File | Contents |
| --- | --- | --- |
| `GithubTrace` | `task-side-panels.tsx:38` | Branch, PR, checks, **two distinct freshness rows** — `reconciledAt` ("something moved") and `checkedAt` ("we looked", from `github.reconcile.task` audit rows). Conflating them was F19-22. Controls: **Deliver** (R15-2 safety net b, maintainer+ or owner), **Complete merge** (F19-24, the mandatory human half of a full-autonomy operator acceptance), **Force accept** (DG-2, admin-only, withheld on a terminal task). All three open the confirm; none submits on a bare click. |
| `CurrentStatePanel` | `task-side-panels.tsx:642` | Stage `StageMenu`, owner take/assign/release, Accept, Archive/Restore. Picking the LAST stage routes to the page's accept confirm (F19-37) because the server reads a human move into the final stage as an acceptance. |
| `TaskDetailsPanel` | `task-side-panels.tsx:375` | Priority / labels (`LabelInput`) / due date (`DatePicker`), edited inline behind `edit-task-meta`. |
| `PolicyPanel` | `task-side-panels.tsx:519` | Permissions rows naming this project's own review and terminal stages, the owner exception (R6-2), and the operator's acceptance exception when the project runs full autonomy (A6). |

### 4.3 Main column, in order

`TaskHero` → `LiveRunPanel` → `DiagnosticsPanel` → `ContinuityRecoveryPanel` (D18: above the
packet) → `DecisionPacket` → `OperatorRecommendations` → `ExecutionSection` →
`AgentLogsPanel` → raw-console panel → `AttachmentsPanel` → `Timeline`.

### 4.4 Comments (Lexical) and @-mentions

`app/features/task-detail/comment-composer.tsx`:

- Lexical **plain text only** (`PlainTextPlugin`). The editor owns only the draft UI; the
  parent submits exactly `raw.trim()` — the same bytes the old textarea produced. No rich
  text, markdown, HTML or editor state ever persists.
- Custom `MentionTextNode` + `registerMentionHighlighting` highlight *known* mentionables
  live, as character-editable text.
- Keyboard model as Lexical commands, composition-safe (`editor.isComposing()` blocks Enter
  during IME): ⌘/Ctrl+Enter sends always; while the mention menu is open ↑/↓ move, Enter/Tab
  insert, Escape closes; otherwise Enter is a line break.
- The `ContentEditable` is a `role="combobox"` with `aria-controls` / `aria-activedescendant`
  into `MentionMenu` — the pattern the ⌘K palette was later modelled on.
- Imperative handle: `focus()`, `prefillIfEmpty(text)` (the "Ask operator" button prefills
  `"@operator "` only into a blank draft, then scrolls + focuses), `clearAfterSuccess()`
  (clears the draft **and** dispatches `CLEAR_HISTORY_COMMAND` so ⌘Z cannot resurrect a
  posted comment).
- `mentionNamesFor()` + `findMentionSpans` (`app/ui/mention-spans.ts`) are shared by the
  composer highlight, the rendered-comment renderer and the **server's routing resolver**, so
  "highlighted as a mention" and "actually routed" cannot drift (P13-LV-11/12). Known names
  are tried longest-first so `@Arda Kaya` wins over `@Arda`.
- Timeline hint uses `useModifierHint("↵")` so a non-Mac keyboard is not shown `⌘↵`.

### 4.5 Runs, logs, attachments

- `LiveRunPanel` (run strip: glyph, state pill, elapsed, tokens) and `AgentLogsPanel` (the
  dark console) live in `app/features/runtime/runs-panels.tsx`.
- `useRunLogStream` seeds from the loader's bounded window (`runtime[].lines` + `raw` +
  `logWindow`), tails live via `run.log-appended`, revalidates the task loader once on
  `run.state-changed`, and pages **backwards** through withheld history via `loadOlder()`
  (P13-D-11 / NFR5). `streamError` is surfaced — the console used to freeze silently on a
  403.
- A non-member gets `runsVisible: false`: the loader withholds `lines`/`raw`/`sid` and the
  panel renders an honest gate notice, and no stream is opened (UI-30).
- `AttachmentsPanel` + `AttachmentThumb`/`AttachmentImage` + a shared
  `AttachmentLightboxProvider`. `attachmentsTotal` lets the panel disclose "showing 100 of N"
  (C8). Timeline **evidence labels** that cite a real attachment filename become links to
  the serving route (R19-19); names with no matching file stay plain text.

### 4.6 Actions (route intents)

`app/routes/project.task.tsx` action switch:

```
comment · update-goal · set-task-metadata · resolve-packet ·
request-maintainer-decision · complete-merge · accept-completion · deliver-review ·
archive-task · restore-task · force-accept ·
owner-take · owner-assign · owner-release · transition ·
run-interrupt · run-agent · release-agent ·
apply-recommendation · dismiss-recommendation · run-operator ·
schedule-action · cancel-schedule
```

Client gating always asks `roleCan(role, "<action-id>")` for the id the **server** enforces,
never a neighbouring one (E3 caught `update-goal` reading `run-agents`). The owner exception
(R6-2 / R14-2) widens packet resolve, apply and dismiss to a contributor-owner.

### 4.7 The one acceptance ceremony

`app/features/task-detail/accept-confirm.tsx` — modes `accept`, `force`, `complete-merge`,
`apply-recommendation`, `packet`, `stage-move`. It states PR number, delivered revision head
sha, the drifted merge head (R17-1), verdict state, target branch, and any signal a
force-accept would carry past. Ruling 88 / F21-2: the confirmed click returns an
`AcceptanceDisclosure` read off **the values this render displayed**, and the server refuses
an acceptance that arrives without one or with one that no longer matches the live task. The
board's drop confirm and the packet's `accept_completion` option both route through it.

Other confirms: `ArchiveConfirm`, `ReleaseConfirm`, `PacketArchiveConfirm`,
`PacketDiscardConfirm`, plus the shared light `ConfirmDialog` for interrupt-run and
dismiss-recommendation (D6).

---

## 5. Design system

### 5.1 Token model (`app/app.css` `:root`, lines 7-144)

Unprefixed, flat names. There is **no** `--viberr-*` layer and no Tailwind.

- Core: `--bg --surface --fg --muted --faint --placeholder --border --border-control --ring
  --hairline`.
- **Two border tokens by WCAG 1.4.11**: `--border` (1.64:1) for decorative frames;
  `--border-control` (3.44:1 in *both* themes) wherever the border is the only thing
  identifying a control. Locked in `app.css.test.ts`.
- **Neutral tint ladder** — every grey fill is one of three ink strengths mixed from the
  theme's own `--fg`: `--tint-well` (3%), `--tint-hover` (5%), `--tint-press` (8%). No rule
  mints its own grey.
- Accents: `--blue --blue-pressed --blue-soft`, plus `--focus-wash` (the one blue tint text
  never sits on) and a **separate CTA pair** `--cta-bg` (#3f5efd) / `--cta-fg`, because
  `--blue` is an accent token, not a text background (white on `--blue` is 3.58:1 and
  `.btn.primary` is 14px/700, not WCAG "large text").
- Status families: `--success/-soft/-dark`, `--coral-light/-dark`, `--rose-light`,
  `--teal-light/-dark`, one amber pair `--amber-light/-dark`, `--red-light`. Agent identity
  `--agent/-dark/-soft`; backend tints `--codex-soft`, `--claude-soft/-fg/-line`.
- Fonts: `--font-display` **Manrope** (declared exactly once — a second `:root` used to
  silently override it), `--font-body` Noto Sans, `--font-mono` JetBrains Mono. Loaded
  weights: Noto 400-700, Manrope 500-800, Mono 400-600.
- Elevation `--shadow-ring/-card/-menu/-pop/-lift` (by z-position, card < menu < pop);
  motion `--ease-out: cubic-bezier(.23,1,.32,1)`; layout `--rail-w: 232px`,
  `--topbar-h: 60px`.
- The page canvas is **flat `--bg`** in both themes; the two decorative pastel radial blobs
  were removed because they reused two hues the sheet uses as *status*.

### 5.2 Scales locked by `app/app.css.test.ts` (2584 lines, no allowlist)

- **Type scale — 13 steps**: `.62 .68 .74 .8 .86 .92 .98 1.05 1.18 1.3 1.5 1.7 1.9` rem.
  Every `font-size` must be a step (or the sanctioned `0` / `inherit`). Weights are limited
  to those the loaded faces ship, and `font-weight: 800` is legal only in rules that resolve
  the display face or select `h1-h4`.
- **Spacing scale — 9 steps**: `.125 .25 .375 .5 .75 1 1.5 2 3` rem (~760 values snapped in
  pass 30; sub-.1rem nudges and negative overlaps stay literal).
- **Radius family — 6 steps**: `--radius-small 6 · --radius-button 8 · --radius-box 12 ·
  --radius-card 16 · --radius-panel 22 · --radius-chip 999`.
- **Every `var(--x)` must resolve** to a declared token — a bug, not a style choice.
- **Every class name used anywhere in `app/` must have a rule**, scanned from the tree, with
  a short justified `CLASSLESS_BY_DESIGN` list.
- **Full contrast sweep in both themes**: 4.5:1 text / 3:1 large text and meaningful glyphs,
  over an **empty** below-AA baseline list; every exemption must be load-bearing and explain
  itself in the sheet's own words.
- **Breakpoints are a named map, each declared exactly once**:
  `1400` board columns tighten · `1300` invite row stacks · **`1100` the two-column
  collapse** · `1080` topbar tier 1 · `1000` settings tab rail goes horizontal · `900` Home
  topbar collapses to the palette · `min-width: 900` login brand aside (the only min-width) ·
  `760` topbar tier 2 · **`720` mobile shell, rail becomes an overlay** · `560` phone-width
  home rows.
- **No control may be hidden at any width**, proven against both the sheet's width queries
  and the markup, with an exact shrinking exemption list; and `app/` may read the viewport
  only to *position* things — `matchMedia` is for user preferences, never width.
- `style={{…}}` objects whose every value is a literal are banned (held at 24 sites), and no
  style object may restate a utility class.

### 5.3 Action hierarchy — one solid primary per view

Design pass 30 (commit `19c03bd`): **`Run operator`, `Run`, `Schedule re-run`, `Comment` and
`Apply` were demoted to secondary**; only the decision-stakes commits keep `.btn.primary` —
`Confirm decision`, `Accept completion`, `Deliver` / `Complete merge`, and `Save goal` while
editing. Home's zero-project state drops its duplicate hero CTA so the `EmptyHero` carries
the page's single primary. The vocabulary is `.btn.primary` / `.btn.ghost`; the hyphenated
`btn-primary` aliases are asserted **never** to exist.

Two opacity steps for unavailable controls: `.45` disabled, `.7` busy
(`.btn[aria-busy="true"]`), both in the sheet, never inline.

### 5.4 Dialogs

`useDialog(onClose, onDismissRequest?)` → `{ ref, close }` (`app/ui/use-dialog.ts`):

- Native `<dialog>` + `showModal()`, so the browser supplies focus trap, top layer, Escape
  (`cancel`) and `::backdrop`.
- The hook adds: body scroll lock, backdrop-click close (rect-tested), focus restore on
  unmount, preservation of React's imperative `autoFocus` (showModal would move focus off it)
  or a `[data-autofocus]` opt-in, and an **animated close** — `close()` sets `[data-closing]`,
  reads the transition duration, waits for the dialog's *own* `transitionend` (bubbled
  descendant transitions are ignored) with a timeout fallback, then unmounts.
- `onDismissRequest` returning `true` consumes an Escape/backdrop dismiss without closing
  (used by the store browser's inner new-folder row).
- Escape's native close is suppressed so React state stays the source of truth.
- Non-modal anchored popovers use `useDismiss(open, onClose, { outside })` instead — one
  implementation replacing seven near-identical hand-rolled effects that disagreed on
  `document` vs `window` and on whether an outside press closes at all.

### 5.5 Toasts

`app/ui/toast.tsx`. `useToast()` returns `push(text, kind?)` with `kind: "success" | "error"`
defaulting to `"success"`. Bottom-center stack, 2600 ms auto-dismiss, 200 ms `.leaving` exit,
`TOAST_STACK_CAP = 4` (oldest drops immediately, without an exit animation, because animating
an exit *caused by an arrival* would misread).

**A failure toast must not render the success tick.** Both kinds paint `var(--fg)`, so the
glyph is the entire signal. `app/features/toast-honesty.test.ts` scans every `push(...)` call
in `features`/`routes`/`ui` and fails any refusal-shaped string literal with no explicit
`"error"`. Server-computed toasts go through `useActionToast(fetcher)` (which passes
`data.ok ? "success" : "error"`) or `useFetcherResult(fetcher, handler)`; both dedupe by data
identity and fire on the **settled result**, never on submit (P11-40).

### 5.6 Copy bans (`app/features/copy-ban.test.ts`, 980+ lines)

1. **`govern*`** — `govern / governor / governance / governed` banned in copy a human reads.
   Use *Maintainer* (human role), *Permissions* (panel), *managed*. Two scans: a line-wise
   scan over the JSX render layer (`app/features`, `app/routes`, `app/ui`, `root.tsx`,
   `entry.*.tsx`, **and `app.css`** — `content:` renders copy), and a **literal-wise** lexer
   scan over every pure-TS root that inspects *every string literal*, not call shapes.
   Agent prompt text is the only legitimate exemption and is allowlisted by name;
   `app/server/seed/assets/*.md` is in scope because an org admin reads and edits them.
   The gate asserts its **own coverage**: every entry `readdirSync(app/)` returns must be
   claimed by a scan or named in `IGNORED_ENTRIES` (empty today).
2. **Em and en dashes (`—` `–`) banned in rendered copy and seed assets** (P21, owner
   2026-08-20) — they are the reliable tell of machine-written prose. Reword with a comma,
   period, colon or parentheses. `DASH_ALLOW` is **empty on purpose**. The minus sign `−`
   (U+2212), arrows `→` and the middle dot `·` stay legal. Comments are stripped before the
   scan, so explanations keep their dashes. `app/server/**` prompt machinery is out of scope.
3. **"primary specialist" is retired** (`app/features/retired-vocabulary.test.tsx`) — the
   actor is the **delivering agent**. Asserted against the *shipped* artifact (seeded file on
   disk, exported constant, rendered HTML), and at its worst inside agent prompt text.

---

## 6. UI primitives — `app/ui/`

Props conventions across the library: **presentational and route-agnostic** (the caller owns
the mutation and passes `onX` callbacks); boolean size/variant flags rather than a `size`
enum (`sm`, `lg`, `xl`); `busy` disables and sets `aria-busy`; nothing reaches for a fetcher
except the hooks.

### Components

| Module | Export(s) | Props / contract |
| --- | --- | --- |
| `avatar.tsx` | `Avatar` | `{ person: { initials, tone } \| null, lg?, xl? }` — 26/34/56 px. `tone` maps to `.avatar.rose/.teal/.violet`. |
| `identity.tsx` | `AgentGlyph` | `{ backend?, op? }`. Branch on `op` **before** backend (operator rows carry no backend and must not render as Codex). |
| `icon.tsx` | `Icon`, `IconName`, `storeIcon` | One 24 px stroke set; unknown names fall back to `dot`. `svg.ico` is 16 px in the sheet. |
| `pill.tsx` | `Pill`, `ReadinessPill`, `ValidationPill`, `validationLabel` | `Pill{ kind, dot?, sm? }`. The ONE mapping from the canonical readiness enum (`ready \| input_required \| inconsistency_risk_detected \| blocked`) to CSS kinds; `accepted`, `merged`, `agent_working` are **derived display** values produced server-side by `deriveDisplayReadiness` — never re-decided in a component. |
| `task-meta.tsx` | `PriorityFlag`, `LabelChips`, `DueDatePill`, `formatDueDate`, `todayISO`, `isOverdue`, `hasVisibleMeta` | Only **non-default** metadata renders (`priority: normal`, empty labels, null due date each draw nothing). Due-date overdue is hydration-gated. |
| `stage-menu.tsx` | `StageMenu`, `StageOption` | Trigger (colour dot + optional name + caret) → popover of all stages; picking a *different* stage calls `onSelect(stageId)`. **Portaled to `<body>` and fixed-positioned from the trigger rect** so it never clips inside a scrolling column. Closes on outside click, Escape, scroll or resize. Shared by the board card and the task Current-state panel. |
| `label-input.tsx` | `LabelInput` | GitHub-style multi-select: chips + a checkbox list with chosen labels pinned on top, type-to-filter, a "Create <label>" row, comma/Enter/blur commit, Backspace-on-empty removes the last chip. Normalisation matches the server's `normalizeTaskLabels`. **Renders in flow, not portaled** (see `date-picker`). Polite live region announces changes. |
| `date-picker.tsx` | `DatePicker` | Trigger + **in-flow** calendar; emits/accepts plain `YYYY-MM-DD` or null. In-flow because it is used inside a transform-centred `<dialog>` with `overflow: hidden`, where a fixed popover mis-anchors and an absolute one is clipped. |
| `calendar.tsx` | `Calendar`, `fromISODate`, `toISODate` | Dependency-free month grid, fixed 6×7 so the popover never resizes. Works in **local-midnight dates only** — never `toISOString()`, never `new Date("YYYY-MM-DD")` (which parses as UTC and rolls the day back west of UTC). `role="grid"`, roving tabindex, per-day aria-labels. |
| `toggle.tsx` | `TglP` | `{ on, onChange(): void, label }` — fully controlled, `role="switch"`, `label` is required aria copy. |
| `confirm-dialog.tsx` | `ConfirmDialog` | `{ title, body, confirmLabel, cancelLabel?, tone: "danger"\|"primary", icon?, busy?, onCancel, onConfirm }`. `role="alertdialog"`. `confirmLabel` must **name the outcome** ("Remove stage", "Interrupt run"), never a bare verb. |
| `page-overlay.tsx` | `PageOverlay` | `{ label, onClose, children }` — full-page native `<dialog>` with a close X and `data-screen-label`. |
| `markdown.tsx` | `Markdown` | react-markdown with overrides; images become lightbox buttons **except** when wrapped in a link (a `<button>` inside an `<a>` is nested-interactive). |
| `rich-text.tsx` | `RichText` | The shared inline micro-format (ruling 14): `**bold**`, `` `code` ``, `@mention` for **known** names only, via the shared `findMentionSpans`. `mentions={false}` is the activity-feed variant. Not a markdown library. |
| `csrf-input.tsx` | `CsrfInput`, `useCsrfToken` | Hidden `_csrf` field from the root loader; the hook feeds programmatic `fetcher.submit`. |
| `skip-link.tsx` | `SkipLink` | `{ targetId = "main-content", label }`. Styles are **inline on purpose** — the sheet carries no visually-hidden utility. Visibility is driven by focus state, and the visible state suppresses the app ring it would otherwise stack on. |
| `local-time.tsx` | `LocalDayDotTime`, `LocalRelative`, `useHydrated` | See §7.1. |
| `mention-spans.ts` | `findMentionSpans`, `extractMentions`, `RESERVED_MENTION_HANDLES` | Shared by composer, renderer **and** server resolver. |
| `initials.ts` | `initialsOf` | Split out of `avatar.tsx` so a non-component export does not drop the file out of Fast Refresh. |

### Hooks

| Module | Export | Contract |
| --- | --- | --- |
| `use-dialog.ts` | `useDialog(onClose, onDismissRequest?)` | `{ ref, close }`. §5.4. |
| `use-dismiss.ts` | `useDismiss(open, onClose, { outside?, ... })` | Escape / outside-press for **non-modal anchored popovers** — no focus trap, no top layer, no scroll lock. |
| `use-action-toast.ts` | `useActionToast(fetcher)` | Server-computed toast, once per settled result, kind from `data.ok`. |
| `use-fetcher-result.ts` | `useFetcherResult(fetcher, handler)` | Same dedupe, caller decides what the result means. |
| `use-relative-time.ts` | `useRelativeTime(iso)` | Re-renders on mount (replacing the server-clock string) and every 30 s. Pair with `suppressHydrationWarning`. |
| `use-shortcut-hint.ts` | `useModifierHint(key = "K")` | `"⌘K"` on Mac, `"Ctrl K"` elsewhere. SSR emits the Mac form; the first client effect corrects it — pair with `suppressHydrationWarning`. |
| `roving-radio.ts` | `rovingRadioKeyDown(event)` | Arrow traversal for a `role="radiogroup"` whose options commit on activation; skips disabled, wraps at the ends. |

---

## 7. Gotchas for UI implementers

### 7.1 Hydration (React #418)

The container SSRs in UTC; the viewer hydrates in their own zone. Rendering viewer-local text
on both sides produces a **recoverable #418 that regenerates the whole page on the client** —
it looks fine and costs a full re-render. The established patterns:

- **Timezone-dependent text**: render the UTC/deterministic form while `useHydrated()` is
  false, swap in the local form after (`LocalDayDotTime`, `finishedClock` in
  `runs-panels.tsx:13`, `insights-page.tsx:220`, `notifications-page.tsx:151`,
  `activity-page.tsx:657`).
- **Relative text ("2m ago")** has no deterministic form — both sides render `" "` and an
  effect fills it in (`LocalRelative`). One blank hydration frame is the price.
- **Day grouping** is worse than clock text: the server and client disagree on the header
  *and* on which rows share a group. `activity/feed-helpers.ts:64` does an absolute-UTC
  first-pass grouping and regroups after hydration.
- **Platform-dependent text** (`⌘K` vs `Ctrl K`) needs `suppressHydrationWarning` on the
  element (`topbar.tsx:192`).
- `<html>` carries `suppressHydrationWarning` because the pre-paint theme script mutates
  `data-theme` before React sees it.
- `e2e/06-activity-hydration.spec.ts` pins the viewer zone to `Pacific/Auckland` so the spec
  keeps discriminating on a UTC CI host and crosses a day boundary.

### 7.2 Pre-hydration clicks

The login inputs are React-controlled. **A fill or click that lands before hydration is
wiped when React takes over.** `e2e/auth.setup.ts` waits for `networkidle` and then retries
the whole fill-fill-click-waitForURL sequence under `expect(...).toPass()`. The same applies
to ⌘K: the shortcut is a hydrated `window` keydown listener, so a bare press can land on
server-rendered HTML and be lost — `e2e/04-palette-mobile.spec.ts` retries the press until
the dialog appears.

### 7.3 Dialogs close on a programmatic `.click()`

`useDialog`'s backdrop-close handler fires on a click whose `target === dialog` and whose
`clientX/clientY` fall **outside** the dialog's `getBoundingClientRect()`
(`app/ui/use-dialog.ts:96-108`). A scripted `element.click()` synthesises coordinates of
`(0, 0)`. In a real browser that is outside the centred card, so driving a dialog with
`javascript_tool`/`.click()` on the dialog element silently dismisses it. (In jsdom the rect
is all zeros, so `(0,0)` reads as *inside* and the dialog stays — the two environments
disagree, which is exactly why this bites only when driving the live app.)

### 7.4 Other traps

- **Board drag vs the card link.** The card face is a `<Link>`; the pointer sensor is
  distance-only on mouse precisely so a slow press-and-release stays a navigation. Any new
  interactive element on a card must be a real `button/input/select/textarea` or the sensor
  will lift from it.
- **`aria-current` needs a hand.** `NavLink` will not emit it for the Board item on a task
  URL. Use the derived `activeView`.
- **`className={bareVariable}`** trips the `app.css.test.ts` class-coverage gate — the
  scanner reads literals.
- **The `button { background: none }` reset is load-bearing**, not tidiness: without it a
  class-less button keeps the UA `ButtonFace`, which Chrome resolves per color-scheme
  (`#6b6b6b` in dark) and drops `--muted` to 3.2:1.
- **`<select>` keeps native `appearance`** on purpose so the drop-down arrow and popup follow
  `color-scheme`; overriding it would mean shipping a hard-coded arrow colour.
- **`aria-hidden` on anything interactive** is a latent `aria-hidden-focus` violation. The
  mobile rail scrim was demoted from a hidden `<button>` to a decorative `<div>` for this
  reason; the keyboard path is the toggle plus Escape.
- **Opacity composites are gate-blind** (pass-30 lesson): the contrast sweep resolves
  colours, not stacked alphas. A fill built from layered translucency can pass the gate and
  fail on screen.
- **Mechanical sweeps break derived sums and hover directions** — snapping every spacing or
  colour value mechanically has previously broken computed totals and inverted hover states.
- Two surfaces counting the same thing at different scopes is a recurring defect class
  (F19-9 rail-vs-queue, UI-48 board-chip-vs-review-queue, P14-WL-04 three "waiting" counts).
  **Any new count must name its scope in the copy and share the predicate with the surface it
  links to.**
- **Do not trust the spec citations in code comments.** See §8.1 — the `§N.M` numbers point
  at a deleted document set, and every `ux-design-specification.md:NNN` line citation is now
  stale by +37 lines.

---

## 8. Intended UX vs what shipped

Source: `planning/planning-artifacts/ux-design-specification.md` (985 lines, authored
2026-03-30, amended eight times since).

### 8.1 Two citation traps

1. **The `§4.6` / `§5.11` numbering in code comments (e.g. `app/routes.ts:15`,
   `org-settings-page.tsx:20`, `board-page.tsx:962`, `rich-text.tsx:6`, `mini-modal.tsx:9`)
   does not resolve against `ux-design-specification.md`.** It belongs to a **deleted** spec
   set, `docs/build/specs/*.md`, removed in commit **`c1acf2c`** ("Remove obsolete code and
   simplify project structure", 2026-07-22). Read them with
   `git show c1acf2c^:docs/build/specs/<name>.md`. Every one of those specs shares a skeleton:
   §1 purpose · §2 component tree · §3 data consumed · §4 UI states & interactions · §5
   events/mutations · §6 CSS classes · §7 porting notes · §8 open questions — **except
   `home.md`, where §4 is verbatim markup and §5 is UI states**, which is why the overlays are
   shell §4.6 but home §5.11. `CONVENTIONS.md` in that tree holds the 16 binding orchestrator
   rulings.
2. **Every `ux-design-specification.md:NNN` line citation in the tree is stale by exactly
   +37 lines** — the inserted amendment blocks pushed everything down. `:846-847`
   (`board-filters.ts:205`) is now 883-884; `:824-825` (`nav.ts:48`) is now 861-862;
   `:849-850` (`route-pending-bar.tsx:9`) is now 886-887. The **named** citations
   (`§Accessibility Strategy`, `§Breakpoint Strategy`, `§State Semantics`) are still correct.

### 8.2 The rules the spec actually sets

- **`§Button Hierarchy` (768-794): "at most one primary action per decision surface";
  informational surfaces may have none; destructive actions never share visual weight with
  safe progression; button labels describe the outcome, not generic UI verbs.** This is the
  source the pass-30 action-hierarchy commit (§5.3) implements.
- **`§State Semantics` (748-766):** every state means the same thing everywhere; state is
  carried by **text + icon + semantic emphasis together**; input gaps, inconsistency risk,
  blocked conditions and continuity degradation must not collapse into one generic "error".
  Canonical vocabulary: `ready`, `input_required`, `inconsistency_risk_detected`, `blocked`,
  plus *waiting on human* / *waiting on agent* and the diagnostic *degraded continuity*;
  `review-ready` and `done` are workflow labels, **not** canonical readiness values.
- **`§Feedback Patterns` (796-821):** prefer inline state over detached notifications;
  **"toasts must never be the sole record of a consequential event"**; error feedback must say
  what failed, what remains true, and what to do next. **Empty states (883-884):** explain
  what is absent, why it matters, and what to do next. **Loading (886-887):** preserve layout
  stability, **skeletons over large spinners** when the page shape is known (shipped reality:
  one `RoutePendingBar`, no skeletons — an open gap).
- **"One surface, reflowed" (901, amended 2026-07-25):** the three-capability-mode responsive
  model is *retired*. **Every action, including destructive and policy actions, renders at
  every width; nothing is gated on viewport size.** *"A user on a narrow window is a
  supervisor with less room, not a different kind of user with fewer rights."* R19-12 (922)
  turned this and the both-theme AA contrast baseline into **failing test gates** — hiding a
  control below a breakpoint is *"a correctness failure wearing accessibility clothing."*
- **Accessibility (924-940):** WCAG 2.2 AA for core workflows, in both themes;
  *"inaccessible state is untrustworthy state."* Screen-reader testing named as VoiceOver +
  NVDA. As of 2026-08-19 only Chromium is exercised in Playwright — an open item.
- Named product directions: the board is the **Signal Console** ("what needs me now?"), task
  detail is the **Operator Desk** ("more like an operations console than a ticket page"),
  with the reading order current state → execution truth → latest packet → next action →
  timeline, which is also the narrow-width stacking order.
- Two former open questions were **ruled built, not deferred**: board lane keyboard traversal
  (D19, at 647) and the Continuity Recovery Panel (D18, at 695, *"sits on the product's trust
  story rather than its feature list"*). Run controls were ruled to **show** configuration,
  never pick it (462, R21-9/R22): no per-run backend or autonomy dropdowns.

### 8.3 Where the spec's own superseding notes have themselves gone stale

The spec repeatedly defers to the tree (*"this document does not certify it — read the
tree"*), and three of its 2026-08-06 N19-4 notes are now out of date after design pass 30:

| Spec note says | Shipped today |
| --- | --- |
| "the ported design system defines **no spacing tokens** … a retrofit would touch every surface for no user-visible gain" | A **9-step spacing scale** (`.125 … 3rem`), ~760 values snapped, pass 30 |
| "Radius vocabulary is **exactly four**" | **Six** steps — `--radius-small` and `--radius-box` were added |
| "**No elevation scale.** Elevation is three named shadow tokens" | **Five** — `--shadow-ring/card/menu/pop/lift`, chosen by z-position |
| No numeric type scale given anywhere | A **13-step type scale**, locked by `app.css.test.ts` |

Two things the spec never covers at all and that exist only as later rulings: **the ⌘K
command palette** (R15-5 — in the deleted specs the topbar search was explicitly *inert*, and
shell §8 asked "is a command palette in scope?") and **the Home multi-project landing page**
(the spec is project-scoped: board / task / review / settings only). The spec's own authority
note is `planning/README.md`'s canon rule: **where the app and the documents disagree, the app
is right and the document is the one being corrected.**
