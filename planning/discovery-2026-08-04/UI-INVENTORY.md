# Viberr UI/UX inventory — 2026-08-04

Written for an implementation agent with **no other context**. Everything here was read out of the
tree at commit `2442945` (branch `main`, clean). Paths are repo-relative; `file:line` refs point at
the current tree and will drift — treat them as "start reading here", not as identifiers.

**One-paragraph orientation.** Viberr is a React Router v8 (framework mode, SSR) app for supervising
AI agents that do real work on real git branches. There is **one** stylesheet (`app/app.css`, 3419
lines), **no** CSS framework, **no** component library, **no** Tailwind. Layout is CSS grid/flex with
per-component rem values. State lives in the URL and in loader data; there is essentially no client
store. Mutations are `useFetcher().submit(FormData)` against the *current route's* action, discriminated
by an `intent` field, and the UI re-renders from a revalidated loader — **not** from optimistic local
state. Live updates arrive over one SSE connection per tab that only ever triggers `revalidate()`.

Contents:

1. [Route table](#1-route-table)
2. [Per-page anatomy](#2-per-page-anatomy)
3. [Design system](#3-design-system)
4. [Motion vocabulary](#4-motion-vocabulary)
5. [Shared UI primitives](#5-shared-ui-primitives)
6. [Client data flow](#6-client-data-flow)
7. [Accessibility posture](#7-accessibility-posture)
8. [Known UI rough edges](#8-known-ui-rough-edges)
9. [Deliberate divergences from the UX spec](#9-deliberate-divergences-from-the-ux-spec)

---

## 1. Route table

Route config is **explicit**, not file-convention: `app/routes.ts`. There are 25 route modules.

### 1.1 Layout tree

```
root (app/root.tsx)                       <html>, ToastProvider, RoutePendingBar, theme boot script
├── /                       _index.tsx     own <main class="home-shell"> (no shell)
├── /login                  login.tsx      own .login-wrap (no shell, body scrolls)
├── /logout                 logout.tsx     resource
├── /org/settings           org.settings   own <main class="home-shell"> (Home-style chrome)
├── /profile                profile.tsx    PageOverlay (<dialog>) over whatever was below
├── /notifications          notifications  PageOverlay (<dialog>)
├── /projects               projects.tsx   redirect → /
├── /projects/:slug         project.tsx    ◀ THE WORKSPACE SHELL: .app grid = Rail | main(Topbar+Outlet)
│   ├── (index)                            redirect → /board
│   ├── board, review, agents, policy, github, activity, settings, tasks/:key
└── resource routes (no UI): api/auth/*, notifications/read, prefs/theme,
    resources/{events,run-log,health,search,model-catalog,session-export}
```

Only `/projects/:slug/*` renders the rail+topbar shell. Home, login and org settings each build their
own chrome from the shared `.home-top` / `.home-shell` classes. `/profile` and `/notifications` are
"page-as-popup": full pages that render inside a modal `<dialog class="page-overlay">` so they can be
opened from anywhere without losing the surface underneath (`app/ui/page-overlay.tsx`).

### 1.2 The table

| URL | Module | Layout | Purpose | Loader | Action (intents) |
|---|---|---|---|---|---|
| `/` | `app/routes/_index.tsx` | own | Home: project grid/list, org tiles, store strip | `:42` `requireUser`; projects for viewer, home prefs, org summary, notifications(100), unread; `storeRoot` only for org admins (`:61`) | `:65` `pin`, `view`, `rescan`(admin), `rebuild-projections`(admin), `create-project` |
| `/login` | `routes/login.tsx` | own | Sign-in + forced password reset | `:33` `authenticate`; redirects if signed in (`:40`); returns `mode`, `returnTo`, `providers.{github,google}` | `:56` `login`, `set-password`; `assertTrustedOrigin` first |
| `/logout` | `routes/logout.tsx` | resource | Sign out | `:36` redirect `/` | `:11` CSRF + audit + better-auth signOut → redirect `/login` |
| `/org/settings` | `routes/org.settings.tsx` | own | Instance settings: org profile, users, connections, resources (KB/MCP/skills/agent templates), store browser | `:70` `requireRole("admin")` | `:101` **switch at `:114`**, 30 intents: `connection-*`, `user-*`, `invite-*`, `domain-remove`, `kb-*`, `mcp-*`, `skill-*`, `agent-*`, `store-*` |
| `/profile` | `routes/profile.tsx` | PageOverlay | Account, notification routing, theme + motion prefs | `:50` `requireUser` + `getProfileView` | `:58` **switch at `:73`**: `identity`, `set-notif`, `set-motion`, `set-tl-default`, `change-password`, `github-disconnect` |
| `/notifications` | `routes/notifications.tsx` | PageOverlay | Full notification inbox (bell shows top 100) | `:37` over-fetches `NOTIF_PAGE_LIMIT+1` (200) to compute `truncated` | — (posts to `/notifications/read`) |
| `/notifications/read` | `routes/notifications.read.tsx` | resource | Mark read | `:48` redirect | `:21` `read` (repeated `id` fields) / `read-all` |
| `/prefs/theme` | `routes/prefs.theme.tsx` | resource | Theme write + `Set-Cookie` | `:43` redirect `/` | `:19` single-purpose; exports `headers` `:39` so the cookie survives |
| `/api/auth/*` | `routes/api.auth.$.ts` | resource | better-auth splat handler | `:11` | `:15` — both forward the raw `Request`; no app CSRF (better-auth enforces Origin) |
| `/resources/events` | `routes/resources.events.ts` | resource (SSE) | Live-update stream | `:61` — see §6.4 | — |
| `/resources/run-log` | `routes/resources.run-log.ts` | resource | Run-log tail / backward page | `:39` `?runId` + `?since` or `?before&limit` (clamped 1..500); `requireProjectMember` at `:69` | — |
| `/resources/health` | `routes/resources.health.ts` | resource | Ops probe `{ok, projections, watcher, kbWatcher, backends}` | `:25` **unauthenticated by design** | — |
| `/resources/search` | `routes/resources.search.ts` | resource | ⌘K palette query | `:14` `requireUser`, `q` truncated to 120 chars | — |
| `/resources/model-catalog` | `routes/resources.model-catalog.ts` | resource | Model + reasoning-effort picker data per backend | `:18` | — |
| `/resources/session-export` | `routes/resources.session-export.ts` | resource | Downloads a bash installer carrying a run transcript | `:32` membership-gated, `Content-Disposition: attachment` | — |
| `/projects` | `routes/projects.tsx` | resource | Bare `/projects` is not a 404 | `:7` returns redirect `/` | — |
| `/projects/:slug` | `routes/project.tsx` | **shell** | Rail + Topbar + `<Outlet/>`; supplies board, counts, notifications, `myRole`, `orgAdminOverride` | `:55`; viewer-scoped `waitingOnMe` annotation `:92-103`; `meta` `:49` | — |
| `…/board` | `routes/project.board.tsx` | shell | Kanban board / list view | **none** — reads the layout loader | `:22` `create-task`, `reorder`, `rescan` |
| `…/review` | `routes/project.review.tsx` | shell | Review queue (triage list) | `:22` viewer-scoped queue + `stageNames` + `acceptance` | — |
| `…/agents` | `routes/project.agents.tsx` | shell | Agent profiles master-detail + live roster | `:38` roster, library, deployments, stages, workflow, resource catalog, backend availability | `:87` `create-profile`, `deploy-profile`, `update-profile`, `delete-profile` (payload is a JSON blob in a `payload` field) |
| `…/policy` | `routes/project.policy.tsx` | shell | Human access + agent capability + workflow rules | `:28` | `:38` `set-role`, `set-boundary` |
| `…/github` | `routes/project.github.tsx` | shell | Repo/branch/PR truth + PAT credential card | `:31` async `getGithubViewData` | `:41` `reconcile`, `grant-scope`, `set-credential`, `clear-credential` |
| `…/activity` | `routes/project.activity.tsx` | shell | Event stream + audit log, paginated via `?stream=`/`?audit=` | `:34` | — |
| `…/settings` | `routes/project.settings.tsx` | shell | Project identity, stages, members, repo, danger zone | `:45` | `:55` **switch at `:61`**: `save-project`, `rename-stage`, `add-stage`, `remove-stage`, `reorder-stages`, `invite`, `remove-member`, `repair-repo`, `set-branch-cleanup`, `grant-scope`, `set-credential`, `clear-credential`, `archive-project`, `delete-project`(→`redirect("/")`) |
| `…/tasks/:key` | `routes/project.task.tsx` | shell | **Task detail — the deepest surface** | `:94`; run rows redacted for non-members (`:138-164`, `runsVisible` `:251`); timeline sliced by `?events=` | `:298` **switch at `:315`, 24 intents** — see §2.8 |

Notes that matter when adding a route:

- No route exports `shouldRevalidate` or `handle`. Only `prefs.theme.tsx:39` exports `headers`; only
  `project.task.tsx:849` exports an `ErrorBoundary`. The root `ErrorBoundary` (`app/root.tsx:186`)
  renders the `.app-splash` panel for everything else and reads a thrown `data("<copy>", {status})`
  string as the page copy.
- Guard helpers: `requireUser`, `requireAuth` (needs `sessionId` for CSRF), `requireRole("admin")`,
  `requireProjectMember`, `authenticate` (no redirect), and
  `app/routes/project-visibility.server.ts:28` `requireVisibleProject` — which rethrows a refusal as a
  **404 byte-identical to the unknown-slug 404** (R15-4: project existence is not leaked).
- Action plumbing: `app/server/auth/form-action.server.ts:7` `requireFormAction(request)` returns
  `{auth, db, formData, actor, intent}` after doing auth + `assertCsrf`. The discriminator field is
  **`intent`**, never `_intent`.
- Three fetcher-only routes (`profile`, `prefs.theme`, `notifications.read`) use
  `app/features/shell/csrf-result.server.ts:19` `csrfError()` so an expired token becomes a
  `{ok:false,error}` result (→ error toast) instead of blowing to the error boundary.

---

## 2. Per-page anatomy

### 2.0 The shell (every `/projects/:slug/*` page)

`app/routes/project.tsx:132`

```
<div class="app" data-rail-open>       grid: var(--rail-w)=232px | 1fr, height 100vh
  <SkipLink/>                          app/ui/skip-link.tsx — bypass block, focus-revealed
  <Rail/>                              app/features/shell/rail.tsx
  <button class="rail-scrim" aria-hidden tabIndex=-1/>   mobile dismiss layer
  <main class="main" id="main-content" tabIndex=-1>
    <Topbar/>                          app/features/shell/topbar.tsx
    {archived && <div class="archived-banner" role="status">}
    <Outlet/>
```

- **Rail** (`rail.tsx`): `<nav aria-label="Primary">`, project switcher → `/`, then `WORKSPACE_NAV`
  (`app/features/shell/nav.ts:20`) = Board, Review queue, Agents, Policy, GitHub, Activity, Settings.
  Counts: board (all tasks incl. Done — deliberate keep), review, and violations (rendered only when
  `> 0`). Active state is `activeView` from `workspaceViewFromPathname` (task routes map to `board`),
  set on a plain `Link` with `aria-current="page"` — deliberately **not** `NavLink`, whose match
  wouldn't cover `/tasks/:key` (`rail.tsx:58-67`). The Board item alone preserves `?filter/view/q`
  via `boardHref` (`nav.ts:57`).
- **Topbar** (`topbar.tsx`): rail toggle (mobile only, CSS-gated), brand → `/`,
  `<nav class="crumbs" aria-label="Breadcrumb">` with `aria-current="page"` on the leaf, optional
  `org-admin override` pill, optional **`live updates paused — retry`** pill (`role="status"`,
  `:144-155`), the ⌘K trigger (a **button**, `aria-haspopup="dialog"`, `:158-172`), `TopBell`,
  `UserMenu`. **⌘K/Ctrl-K** is bound at `topbar.tsx:69` (and again on Home, `home-page.tsx:1439`).
- One SSE subscription per tab for the whole workspace: `project.tsx:150-154` subscribes
  `project:<slug>`, `task:<slug>/<key>` when a task is open, and `user`.

### 2.1 Home — `/` → `app/features/home/home-page.tsx` (1691 lines)

| piece | where | notes |
|---|---|---|
| `HomeTopBar` | `:850` | brand, real search **input** (a project finder — Home's box is an input; the workspace's is a palette button), `.kbd` chip that opens ⌘K (`:917`), `TopBell`, `UserMenu` |
| `HomeHero` | `:965` | `useLocalGreeting` `:950` corrects the server greeting client-side; grid/list `seg` with `aria-pressed` `:1039` |
| `EmptyHero` | `:1068` | zero-project teaching state |
| `ProjectSections` | `:1098` | `ProjectCard` `:195` / `ProjectRow` `:252`, each composing `StageMeter` `:66`, `ProjectStats` `:137`, `MemberStack` `:185`, `UpdatedLabel` `:127`, `Avatar`, `Pill` |
| `SettingsPanel` | `:1286` | `OrgTile` `:1258` — admin-gated `Link`, inert `div` otherwise |
| `StoreStrip` | `:1365` | admin only: Re-scan, Rebuild projections |
| Dialogs | `NewProjectModal` `:628`, `RebuildConfirm` `:1654` (`role="alertdialog"`) | both native `<dialog>` + `useDialog` |
| `CommandPalette` | `:1648` | shared with the workspace |

`NewProjectModal` field components live in the same file: `NewProjectNameFields` `:306`,
`…ConnectionField` `:385`, `…RepoField` `:464`, `…WorkflowField` `:510`, `…PolicyField` `:527`,
`…Footer` `:577`. Name ↔ repo/key autocomplete uses `*Touched` latches (`:671-693`) over helpers in
`app/features/home/project-name.ts`. Four fetchers, zero `<Form>` elements. Home prefs are read
optimistically off `prefsFetcher.formData` (`:1449-1460`) — the one place Home guesses ahead of the
server, and only for view/pin.

### 2.2 Board — `/projects/:slug/board` → `app/features/board/board-page.tsx` (1302 lines)

Structure: `BoardHeader` `:698` → `FilterBar` `:792` → `OrphanBanner` `:865` → `StageBoard` `:890`
(or `ListView` `:428`) → `NewTaskModal` `:515`.

- **URL is the state.** `filter`, `view`, `q` in `useSearchParams`, written with
  `{replace: true, preventScrollReset: true}` (`:1162-1172`). `FILTERS` `:688` = all / waiting on
  human / waiting on agent / risk / archived (archived chip only when `archived > 0`).
  Predicates are pure in `app/features/board/board-filters.ts` (`matchesBoardFilter` `:32`,
  `matchesSearch` `:94`, `boardEmptyCopy` `:142`).
- **Card** `TaskCard` `:191`: `ReadinessPill`, `<h3>`, `OwnerLine` `:146` / `ReviewerStack` `:177`,
  foot with short branch, PR chip, `checksPill`/`reviewPill` (rendered **only when actionable** —
  failing checks `:281`, changes-requested `:288`), `ValidationPill`, `WaitTag` `:124`.
- **Drag** — see §5.6. Whole card, no grip, server-authoritative.
- **`StageMenu`** (`app/ui/stage-menu.tsx`) is rendered as a *sibling* of the card `Link` inside
  `.card-move` (`:309-317`) and per-row in `ListView` (`:485-490`). It is the keyboard/AT path for
  stage moves and posts the **same** `reorder` intent with `beforeKey: ""` (`:1081-1094`).
- `NewTaskModal` `:515` — native `<dialog>` with title input, stage `pick-chips`
  (`role="group" aria-labelledby`), goal textarea. Not a `<form>`; submit builds `FormData` at `:558`.

### 2.3 Review queue — `app/features/review/review-page.tsx` (241 lines)

Deliberately a **triage list with no primary action** (owner ruling R15-11): rows are buttons that
navigate to the task page, labelled `Review ›` (`.rq-go`, app.css:2085) and carrying
`aria-label="Review VIB-N: <title>"`; the chevron is `aria-hidden`. Acceptance lives on the task page
because it is verdict-gated and can refuse — a control must not name an outcome its surface cannot
promise. No forms, no fetchers.

### 2.4 Activity — `app/features/activity/activity-page.tsx` (444 lines)

`.activity-cols` = stream panel (1.55fr) + `AuditLogs` `:121` (1fr), collapsing to one column at
1100px. Loader-only: **no action, no fetchers, no dialogs, no menus**.

- Stream panel `:320-429`: actor filter `mini-seg` (`role="group"` + `aria-pressed`, `:334-345`)
  placed *inside* the panel it filters; "N of M events (filtered)"; day groups; rows use
  `actIcon(r.type)` `:109` (the map is keyed on `TIMELINE_EVENT_TYPES` so a new event type is a
  compile error), `ActivityText` `:31` (240-char preview + Show more with `aria-expanded`), and a
  `keybtn` task-key button.
- `AuditLogs` is deliberately **unfiltered** ("policy & access · all actors").
- Pagination writes `?stream=` / `?audit=` (`:282-290`); limits in `feed-limits.ts`
  (`STREAM_STEP 200 / MAX 2000`, `AUDIT_STEP 60 / MAX 600`).
- **Hydration**: `useHydrated()` `:276` picks UTC formatters for the first pass, then regroups
  viewer-local. The grouping *key* is absolute-UTC on purpose (`groupStreamByDayUTC`,
  `auditTimeLabelUTC` in `feed-helpers.ts`) so it can't depend on when "now" is sampled. Gated by
  `e2e/06-activity-hydration.spec.ts` (Auckland viewer vs UTC container).

### 2.5 Agents — `app/features/agents/agents-page.tsx` (1281 lines)

Master-detail: `aside.profile-list` of `ProfileItem` `:90` + `ProfileDetail` `:466`, with a
Profiles/Live `seg`. URL state: `?profile=`, `?tab=` (`:939-951`).

`ProfileDetail` composes `ProfileGlyph` `:66`, `StageEligibility` `:268` (marks stale stage ids), a
capability policy panel of three `CapColumn` `:113` filtered to `GOVERNED_CAP_LABELS`, plus a
collapsed `<details class="cap-advisory">` for non-governed grants (`:609-632`, owner ruling R15-12 —
collapse, never hide), a context-resources panel of three `ResGroup` `:139` (dangling grants render
`missing`, still clickable to remove), a runtime row, and active deployments.

Four dialogs: `DeleteConfirm` `:191` (`role="alertdialog"`), `LibraryPicker` `:361`,
`CreateProfileModal` (`app/features/agents/create-profile-modal.tsx`, 1015 lines — create *and* edit
in one), `CapabilityMatrixModal` (`capability-matrix-modal.tsx`, read-only, shared with Policy).

One fetcher. Note the **inconsistency**: this page passes a **plain object** to `fetcher.submit`
(not `FormData`), with the whole profile serialized into a single `payload` JSON field
(`:1032-1043`). `create-profile-modal.tsx:863` holds its own GET fetcher for
`/resources/model-catalog?backend=…`.

### 2.6 Policy · Notifications · Profile · GitHub · Settings · Org settings · KB browser

**Policy** — `app/features/policy/policy-page.tsx` (607). Three exported panels: `HumanAccess` `:46`
(per-member role control, a `.mini-seg` with `role="radiogroup"` / `role="radio"` / `aria-checked`
`:150-166`), `AgentCapability` `:238` (opens the shared `CapabilityMatrixModal` from the agents
feature, `:598-604`), `WorkflowRules` `:357` (transition-boundary `.cap-seg` radiogroups, `disabled`
when the transition is locked, `:454-468`). Two **different** RBAC gates on one page: `canSetRole` =
`manage-members`, `canEditPolicy` = `edit-policy` (`:525-526`). Intents `set-role`, `set-boundary`;
toasts via `useActionToast`.

**Notifications** — `app/features/notifications/notifications-page.tsx` (280), rendered in a
`PageOverlay`. Fully presentational (`onRead` / `onReadAll` / `onOpen` props); the route owns the
fetcher. Two sections: *Waiting on you* (`.rq-list` of `.rq-row` buttons — clicking marks read
**then** opens, `:69-72`; the header count ignores the All/Unread filter and adds "N hidden by the
filter") and *Everything else*, whose rows are deliberately plain `<div class="pol-ev ntf-ev">` and
**not** `role="button"` (UI-54 comment at `:135-144`) — instead they contain a focusable `.keybtn`
task link and, for unread rows, an explicit labelled **"Mark read"** button (`:172-184`). Mark-read
is monotonic (`routes/notifications.tsx:87` early-returns when the item is already read) and only the
bulk case toasts. Dedupe (one card per task, newest wins) lives in `notifications-page-helpers.ts`.

**Profile** — `app/features/profile/profile-page.tsx` (919), also a `PageOverlay`. `.profile-cols`
with `ProfileIdentity` `:96`, `ProfileNotifications` `:211`, `ProfileAppearance` `:296`,
`ProfileAccess` `:438`, `ProfileGithub` `:504`, `ProfilePassword` `:705`. **Two preference toggles
post to two different routes**, which is easy to get wrong:

| control | shape | posts to |
|---|---|---|
| Theme (Light/Dark/System) | `.mini-seg` `:390` | **`/prefs/theme`** on its own fetcher (`routes/profile.tsx:190-202`); applies `applyThemePreference` optimistically, rolls back + error-toasts on failure; re-picking the active theme is a no-op |
| Reduce motion | `TglP` `:408` | **`/profile`**, `intent: "set-motion"`; flips local state *and* `document.documentElement.dataset.motion` immediately, rolling back both on failure (`:342-358`) |
| Timeline default | `.mini-seg` `:418` | `/profile`, `intent: "set-tl-default"` |
| Notification routing | `TglP` per row `:244` | `/profile`, `intent: "set-notif"`, on a **separate** fetcher from Appearance (UI-56, `:308-312`) |

Identity edits commit on blur (Escape also commits, `:90-94`). GitHub *connect* is not a fetcher at
all — a raw `fetch("/api/auth/sign-in/social")` then `window.location.href` (`:530-554`).

**GitHub** — `app/features/github/github-view.tsx` (530): `RepositoryPanel` `:42`,
`PullRequestsPanel` `:150` (`.rq-list` rows → task detail), `BranchesPanel` `:231`
(`.gh-table > .live-table` with `.live-head`/`.live-row`), `GithubViewPage` `:344` with the
`.gh-freshness` chip (`+ " stale"`) and an **Update status** button gated on
`roleCan(myRole,"reconcile-github")`. Pills come from the shared `github-pills.ts`.
`app/features/github/credential-card.tsx` (272) is *the* shared credential card — also rendered by
project settings (`settings-page.tsx:800`). Scope chips render **proven verdicts only**: an
unverifiable fine-grained-PAT scope collapses into one honest "unproven — verified on first use" line
(`:88-110`) or `.scope-chip.assumed` (dashed, muted, app.css:3369), never a pseudo-check. The footer
resolves in strict priority order: revoked/expired → missing scope (with a `.keybtn` deep-link to the
flagged task) → unverified → green `.cred-ok`. **PAT entry does not live here** — the only token input
in the app is `connections-panel.tsx:125-137`.

**Project settings** — `app/features/project-settings/settings-page.tsx` (1211): `ProjectPanel` `:38`,
`StagesPanel` `:210`, `MembersPanel` `:396`, `RepoPanel` `:663`, `DangerZone` `:896`.

- **Stage reorder is raw HTML5 drag-and-drop, not dnd-kit** (`draggable` at `:301`, `onDragStart`
  `:302`, `onDragOver` `:306`, `onDrop` `:313`), with a visible `.stg-handle` **grip** and
  `.stg-row.dragging` / `.stg-row.over` classes (app.css:2007-2009). The reorder math (`drop()`
  `:260-278`) splices, then forces the entry stage first and the terminal stage last by current
  identity, and emits `reorder-stages` with `orderedIds: ids.join(",")`.
- **Inline rename**: edit mode is lifted to `SettingsPage` (`editingStageId` `:1038`) so a fresh
  `add-stage` response drops the new row straight into edit mode. The row swaps
  `<button class="stg-name">` for `<input class="stg-input" autoFocus>`; **Enter blurs, Escape
  cancels, commit happens on blur** (`commitName` `:239`, no-ops on empty/unchanged).
- `AddStageControl` `:143` is name-first — the button becomes an inline `.stg-add` field in place, so
  the panel does not jump.
- Dialogs: `RepairRepoDialog` `:566` (footprint-ack checkbox, stays open on a failed probe) and
  `DeleteProjectDialog` `:836` (`role="alertdialog"`, typed-name confirm).

**Org settings** — `app/features/org-settings/`. Shell `org-settings-page.tsx`: `.set-head` (back
button + `<h1>Instance settings</h1>` — R15-13, so it stops colliding with a project named Viberr) and
`.set-layout` = sticky `.set-nav` rail + `.set-content`. **Tab state rides the URL** (`?tab=`,
`resolveOrgTab` `:23`); each `.nav-item` carries `aria-current` and a `.count` badge with a `title`.

- `mini-modal.tsx` — `MiniModal` `:13` is the shared modal chrome (native `<dialog class="modal-card">`
  + `useDialog`, `.modal-head`/`.modal-body`/`.modal-foot`, Save genuinely `disabled` +
  `aria-disabled`); `ConfirmDelete` `:79` is the `role="alertdialog"` `.confirm-card`.
- `use-org-action.ts` — every org mutation goes through it: `useFetcher` + `_csrf` +
  `{method:"post", action:"/org/settings"}` (`:59-62`), default toast from the server's
  `toast`/`error` (error kind explicit), or the raw result handed to `onResult` for modals that want
  an inline `.cred-warn` and close-on-success.
- `connections-panel.tsx` — `.conn-list` of `.conn-row`; `ConnectionModal` `:26` holds the app's only
  PAT field; `SCOPES = ["repo","pull_request:write"]`.
- `users-panel.tsx` (763) — `.member-list` of domain-allowlist rows then user rows, each with an
  `IdpChip`, status pills, an Admin|Member `.mini-seg`, and four `.stg-x` icon buttons. Self-guards
  are **error toasts**, not hidden controls. Modals: `InviteModal` `:58` (three-way
  `.be-pick.three` GitHub/Google/Local picker), `EditUserModal` `:293` (inline `user-reset-password`
  surfaces the temp password **once**), `DisableUserDialog` `:473`, two `ConfirmDelete`s.
- `resources-panel.tsx` (1471) — `.rsrc-wrap > .rsrc-grid` with `KbPanel` `:873`, `McpPanel` `:985`,
  `SkillPanel` `:1102`, `AgentPanel` `:1188`; four `MiniModal`-based editors; MCP health as
  `.stat-dot` `up`/`down`/`stale`; orphaned grants as removable red `.pick-chip.missing.on`. This is
  where `StoreBrowser` is launched (`:1426-1445`).

**KB / store browser** — `app/features/kb-browser/store-browser.tsx` (1249). A `<dialog class="modal-card
modal-wide">` with a **layered dismiss handler** (Escape closes the new-folder row first, then the
open editor, then the modal) via `useDialog`'s `onDismissRequest`; nested `DeleteConfirm` /
`ReplaceConfirm` are their own dialogs at `zIndex 71` and the card goes `inert` while one is open.

- Tree `.fm-tree` / `.fm-row` with `paddingLeft: 0.6 + depth*1.3rem`; a dir row toggles, a text file
  row opens the editor (`isEditableDoc` over 9 extensions), binaries get no `role`/`tabIndex`.
  Row actions `.fm-acts` reveal on hover/`:focus-within`.
- **Drag-drop upload** is HTML5 again (`.fm-row.droptgt`, `.fm-tree.droptgt`), inferring folder mode
  when any `relPath` contains `/`. Two hidden `<input type="file">` clicked programmatically — the
  folder one carries `webkitdirectory`/`directory` behind a `@ts-expect-error` (`:1193-1204`).
  Uploads post multipart `files[]` + `filePaths[]` and drive a `.def-note aria-live="polite"` busy row.
- **In-app document editor** `.fm-doc` (app.css:3340) with its own read/save fetchers so a failed
  read never rides the generic store toast; **the draft is preserved on failure** (UI-60); a
  `truncated` read disables Save.
- New-folder row: Enter commits, **blur dismisses rather than commits** (P13-UI-23), Escape
  `stopPropagation`s so the dialog's native cancel doesn't also fire.

### 2.7 Runtime panels — `app/features/runtime/runs-panels.tsx` (634)

Rendered inside task detail. `LiveRunPanel` `:153` (`.runbar`, `data-comment-anchor="live-run"`) only
renders while something is running: `.live-dot`, phase + current step, four `.run-cell` stats
(elapsed via `useElapsed`, turns, tokens, model), View logs, and a conditional Interrupt.
`AgentPicker` `:52` is a **listbox dropdown**, not a `<select>` — `aria-haspopup="listbox"`,
`role="listbox"`/`option`/`aria-selected`, Escape/↑/↓ keyboard, outside-mousedown close; it is used
both on the run strip and in the logs head.

`AgentLogsPanel` `:332` (`data-comment-anchor="agent-logs"`): `.logs-bar` with the state pill,
`SessionIdChip` `:249` (click to expand the id, copy with a 1400ms "copied" flip, and a plain
`<a download href="/resources/session-export?run=…">`), an optional *Retry on Claude Code/Codex*
button, and two `aria-pressed` chips — `{ } raw` and `follow`. The `.console` is `role="log"
aria-live="off"` (streaming lines must not flood AT) and re-arms `follow` when the user scrolls back
within 48px of the bottom. **"Load older" is a button, not scroll-linked** (`:538-576`): it snapshots
`{scrollHeight, scrollTop}`, turns `follow` off, and a `useLayoutEffect` re-anchors `scrollTop` after
the prepend so the viewport doesn't jump. Consecutive telemetry rows fold into one `.log-line.meta`
(`collapseTelemetry`, `log-noise.ts:48`).

### 2.8 Task detail — `app/features/task-detail/task-detail-page.tsx` (1761 lines)

The product's deepest surface, `.detail` = `minmax(0,1fr) 340px` (app.css:817). Component is
remounted with `key={task.key}` (`routes/project.task.tsx:819`).

`.detail-main` (in order — this ordering *is* the "operator-first" spec contract):

1. `TaskHero` `:448` — key, `<h1>`, goal with **inline edit** (`goalFetcher.Form` `:541`, the only
   real declarative `<Form>` in the app), hero file chip
2. `LiveRunPanel` (`app/features/runtime/runs-panels.tsx`) — pulsing run strip
3. `DiagnosticsPanel` `:416`
4. `DecisionPacket` (`decision-packet.tsx`, 325) — the loud amber/red panel; options are a real
   `role="radiogroup"` with roving `tabIndex` and arrow keys (`:114-121`, `:164-195`); per-option
   authority refusals are **rendered copy**, not disabled buttons
5. `RecommendationsSection` `:603` → `operator-recommendations.tsx`
6. `ScheduledActions` `:648` — the one `fetcher.Form` that `preventDefault()`s and re-submits
   programmatically (`:724-728`)
7. `ExecutionSection` `:782` → `execution-profile.tsx` (862) — 4-cell grid: Operator (backend +
   autonomy `<select>`s + Run), Delivering agent, Reviewers, Human owner. Three hand-rolled popover
   menus (`aria-haspopup="menu"` + `role="menu"`/`menuitem`, outside-mousedown + Escape).
8. `AgentLogsPanel` — dark console; replaced by a membership-gate notice when `runsVisible === false`
9. `Timeline` (`timeline.tsx`, 424)

`.detail-side`: `GithubTrace` `:71` → `CurrentStatePanel` `:920` (`.kv-row` facts + a `StageMenu` +
`.state-acts` action block) → `PolicyPanel` `:305`.

Dialogs: `AcceptConfirm` `:1707`, `ArchiveConfirm` `:1733`, `ReleaseConfirm` `:1746` — all
`<dialog role="alertdialog">` + `useDialog`.

**13 fetchers**, each setting `_csrf`, all routed through `useActionFeedback` `:49` (toast + optional
`navigateTo`, once per `fetcher.data` via a handled ref). Intent→fetcher map:
`goalFetcher`(update-goal) · `recFetcher`(apply/dismiss-recommendation) · scheduling fetcher
(schedule-action, cancel-schedule) · `specialistFetcher` · `reviewerFetcher` · `operatorFetcher` ·
`transitionFetcher` · `runFetcher` (run-interrupt, retry, complete-merge, force-accept) ·
`ownerFetcher` · `resolveFetcher` · `archiveFetcher` · `acceptFetcher` · `deliverFetcher`.

`Timeline`: filter tabs (All / Important / Comments, `aria-pressed`), the composer block
(§5.5), then events via `TimelineItem` `:104` → `eventMeta` (`event-meta.ts`), `Markdown` for
comments and `RichText` for typed events, `CollapsibleComment` `:55` clamping over 340px with a
mask fade. Slicing is `?events=` + `timeline-slice.ts` (initial 30, step 30).

---

## 3. Design system

### 3.1 Canonical source and how it maps

- `design/design-system.html` — the ported **design system page** (tokens, type, spacing/radius,
  state vocabulary, component gallery). This is where `--blue: #5b76fe`, the pastel semantic pairs
  and the Roobert/Noto/JetBrains stack come from.
- `design/html-app/app/*.jsx` + `design/html-app/app/viberr.css` — the **React prototype** every
  product surface was ported from, screen by screen (`board.jsx`, `task.jsx`, `agents.jsx`,
  `policy.jsx`, `activity.jsx`, `github.jsx`, `settings.jsx`, `org-settings.jsx`, `kb-browser.jsx`,
  `review.jsx`, `runs.jsx`, `notifications.jsx`, `profile.jsx`, `home.jsx`, `login.jsx`, `ui.jsx`).
- The porting contract is `docs/architecture/decisions.md` § "UI porting rules":
  *reproduce structure, class names and behaviour 1:1*; replace prototype-only bits (localStorage
  session, `location.href` hops, `window.VIBERR`) with real routes/loaders/actions/SSE; **record
  deliberate departures in a comment at the departure site**; keep `viberr.css` classes and CSS
  variables exactly; add new CSS only in clearly-marked appended sections of `app/app.css`;
  **no Tailwind, no inline hex — a `var(--x)` that is not defined in `:root` is a bug, not a style choice.**

Two token values were intentionally tightened during the port: `--radius-card` 18px → **16px** and
`--radius-panel` 28px → **22px** (design-system.html:34-35 vs app.css:73-74). `--radius-large: 44px`
and `--pink` were dropped.

### 3.2 Token vocabulary — `app/app.css:7-78` (light) / `:2197-2237` (dark)

**Surfaces & text**

| token | light | dark | role |
|---|---|---|---|
| `--bg` | `#ffffff` | `#131419` | page |
| `--surface` | `#ffffff` | `#1b1d25` | cards, panels, menus |
| `--fg` | `#1c1c1e` | `#eceef4` | primary text; also the "inverted chip" fill |
| `--muted` | `#555a6a` | `#b9bdcb` | secondary text |
| `--faint` | `#616575` | `#969bac` | tertiary labels |
| `--placeholder` | `#6a6e81` | `#868d9f` | quaternary / placeholders |
| `--border` | `#c7cad5` | `#3d4152` | real borders |
| `--ring` | `#e0e2e8` | `#2b2e3a` | `--shadow-ring` |
| `--hairline` | `color-mix(--border, transparent 55%)` | (derived) | the app's divider |

The secondary ladder is **contrast-constrained, not free**: `--muted > --faint > --placeholder` must
each clear 4.5:1 on `--surface` *and* over the 4% `--fg` tint labels sometimes sit on. This is
enforced statically by `app/app.css.test.ts` (see §3.5).

**Accents**

`--blue #5b76fe` / `--blue-pressed` / `--blue-soft` — accent for borders, focus rings, washes,
text-on-light. It is **not** a text background: the CTA fill is its own pair, `--cta-bg #3f5efd` /
`--cta-fg #fff` in light, inverted to `--cta-bg #6f87ff` / `--cta-fg #131419` in dark (app.css:32-43,
2217-2220). `--success #00b473`. `--pin-star` for the pinned-project star.

**Pastel semantic pairs** (bg/text invert *together* between themes): `--coral-light/--coral-dark`,
`--rose-light`, `--teal-light/--teal-dark`, `--orange-light/--yellow-dark`, `--red-light`.

**Agent identity** — violet, deliberately distinct from human blue: `--agent #7b61ff`,
`--agent-dark`, `--agent-soft`.

**Shadows** `--shadow-ring`, `--shadow-card`, `--shadow-pop`. **Radii** `--radius-button: 8px`,
`--radius-chip: 999px`, `--radius-card: 16px`, `--radius-panel: 22px`. **Layout**
`--rail-w: 232px`, `--topbar-h: 60px`.

**There are no spacing tokens.** Spacing is per-component rem values chosen to match the surrounding
rhythm. This is a recorded, deliberate divergence (see §9).

### 3.3 Typography

`--font-display` — **Manrope** (bundled `@fontsource/manrope` 500/600/700/800). Note app.css declares
`--font-display` twice: the Roobert-first stack at `:59` and an overriding `:root { --font-display:
"Manrope", …}` at `:2724-2726`. Manrope wins. Used for `h1–h4` (weight 800, `letter-spacing: -.01em`,
`text-wrap: balance`), buttons, names, `.nm`, `.pj-name`, uppercase labels.

`--font-body` — **Noto Sans** 400/500/600/700. `--font-mono` — **JetBrains Mono** 400/500/600, with
`.mono` = `font-variant-numeric: tabular-nums; font-size: .76rem; letter-spacing: -.01em`
(app.css:104). Mono is used *intentionally*: task keys, branches, SHAs, timestamps, counts, paths,
emails in member lists, kbd chips.

Scale is compact and functional — page `h1` ~1.5–1.9rem, panel `h2` ~1.02rem, body `.86–.9rem`,
metadata `.72–.78rem`, uppercase micro-labels `.62–.68rem` at weight 900 with `letter-spacing .05em`.

### 3.4 Light / dark

Dark is a **token swap only** (`:root[data-theme="dark"]`, app.css:2197) plus nine fixups at
`:2239-2248` for surfaces that hard-code an inverted colour (`.gh-bar`, `.toast`, `.tl-node.github`,
`.pill.done`, backdrops, the Claude/Codex glyph tints). Semantic meaning is identical in both themes.

Preference is `light | dark | system`, resolved in three places:
1. **Boot script** (`app/root.tsx:106`, inlined in `<head>`) — reads the `viberr_theme` **cookie as
   authoritative**, falls back to the SSR preference, resolves `system` against
   `prefers-color-scheme` and subscribes to OS changes. The cookie read is what keeps the
   ErrorBoundary page from flashing light in a dark session.
2. **SSR** renders `<html data-theme={explicit ?? "light"} data-motion suppressHydrationWarning>`.
3. **Post-paint** effect (`root.tsx:157-170`) re-applies on preference change and live-follows the OS
   on `system`.

Writes go to `POST /prefs/theme` (sets the row *and* the cookie); the user menu applies
`applyThemePreference()` optimistically first (`app/features/shell/theme-preference.ts:5`).

The console (`.console`, app.css:2427) is a **fixed dark surface in both themes** — its log-line
colours are literal hex on purpose, because theme tokens would invert against a background that
never does (comment at app.css:3405).

`@media (prefers-reduced-transparency: reduce)` (app.css:3332) frosts `.rail` and `.home-top` solid.

### 3.5 The stylesheet integrity gate

`app/app.css.test.ts` fails the unit suite on three classes of defect that no compiler catches:

- every `var(--x)` in a **declaration** (comments stripped) must resolve to a declared token —
  P13-D-18 shipped 11 references to tokens declared nowhere, silently dropping whole panels;
- the utility classes the markup assumes (`muted`, `hint`, `.btn.primary`, `.btn.ghost`) must exist,
  and the hyphenated aliases must not;
- `--faint` / `--placeholder` must clear 4.5:1 on `--surface` **and** on the 4% `--fg` tint, in both
  themes, and keep their subordination; the CTA pair and its hover must clear 4.5:1 in both themes.

`e2e/07-accessibility.spec.ts` is the rendered-page counterpart.

---

## 4. Motion vocabulary

Easing is a single token: `--ease-out: cubic-bezier(.23, 1, .32, 1)` (app.css:69). The built-in
`ease-out` is deliberately considered too weak for entrances and presses; `ease-in-out` is reserved
for on-screen moves. Durations cluster at **.12–.18s** for UI reactions, **.3s** for page-level
entrances, and **.45s / 1.3s** for state-change pulses.

### 4.1 Keyframes

| keyframe | line | used by | shape |
|---|---|---|---|
| `rise` | `:1213` | `.toast`, `.login-card`, `.login-aside`, home surfaces | `translateY(10px)` + fade, `.3s` |
| `pop-center` | `:1439` | `.confirm-card`, `.modal-card`, `.page-overlay` | `translate(-50%,-46%) scale(.97)` → centered, `.18s` |
| `cmdk-in` | `:1511` | `.cmdk-card` only | top-anchored variant of pop-center |
| `menu-in` | `:1216` | menus whose trigger is **above** (`.user-menu.from-top`, `.ntf-pop`, `.rsel-menu`, `.own-menu`) | `translateY(-4px) scale(.98)`, `.16s` |
| `menu-in-up` | `:1217` | menus whose trigger is **below** (`.user-menu` in the rail) | mirrored |
| `smPop` | `:745` | `.stage-menu-pop` | `translateY(-4px) scale(.985)`, `transform-origin: top right` |
| `dropPreviewIn` | `:701` | `.card-drop-preview`, reused by `.cap-mbody` accordion | `translateY(-4px)` + fade, `.16s` |
| `stagePulse` | `:726` | `.sm-current.changed`, `.bell-badge` | `scale(1) → 1.13 → 1`, `.45s` |
| `cardArrive` | `:704` | `.card-wrap.just-arrived .card` | blue ring pulse, `1.3s` |
| `fade-in` | `:1219` | scrims, `dialog::backdrop`, reduced-motion substitute | opacity only — a full-screen veil has no edge to slide from |
| `pulse` / `pulse-a` | `:350` / `:808` | `.live .dot` (teal), agent working dots (violet) | expanding ring, infinite |
| `livePulse` | `:2354` | `.live-dot` on the run strip | |
| `runSpin` / `spin` | `:2361` / `:2833` | `.run-spin`, `.ico.spin` | rotation |
| `caretBlink` | `:2448` | `.lcaret` in the log console | `steps(2)` |
| `route-pending-slide` | `:3393` | `.route-pending .rp-fill` | `translateX(-100% → 320%)`, `1.05s` infinite |

The **menu entrance is origin-aware** by design (comment at `:1214`): a menu grows from the edge
that touches its trigger, which is why there are two keyframes and why several popovers set
`transform-origin` explicitly.

### 4.2 Press feedback

A single consolidated block at app.css:3307-3317 gives every pressable surface an `:active` scale,
graded by size: cards `.99`, list rows `.99` (+ translate reset), chips and segmented buttons `.96`,
small icon-X buttons `.9`, nav items `.985`. `.btn` lifts `-1px` on hover and `scale(.97)` on press
(`:374-375`). This is the app's tactility budget — do not add per-component press effects.

### 4.3 The dialog close pattern (mandatory on every dialog)

`app/ui/use-dialog.ts` — `const { ref, close } = useDialog(onClose, onDismissRequest?)`.

```tsx
const { ref, close } = useDialog(onClose);
<dialog ref={ref} className="modal-card" aria-label="…">
  …
  <button onClick={close}>Cancel</button>
</dialog>
```

What the platform gives (via `showModal()`): focus trap, top-layer stacking, `::backdrop`, Escape.
What the hook adds:

- **Animated close.** `close()` sets `dialog.dataset.closing = ""` → `[data-closing]`, then reads
  `getComputedStyle(dialog).transitionDuration` **after** the attribute lands (`:41`). If it isn't
  `> 0.02s` — jsdom (no stylesheet) or `[data-motion="reduce"]` (clamped to `.01ms`) — it calls
  `onClose()` synchronously. Otherwise it waits for `transitionend` **filtered to
  `event.target === dialog`** (transitionend bubbles; a pressed Cancel button's transform would
  otherwise end the close mid-fade) with a `duration + 50ms` fallback timer.
- CSS side: `dialog[data-closing]` (app.css:1445) kills the entrance animation and transitions
  opacity+transform back to `translate(-50%,-46%) scale(.97)` over `.15s`; the backdrop fades with it.
  `.cmdk-card[data-closing]` (`:1517`) overrides the transform because that card is top-anchored.
- Escape → native `cancel` event, `preventDefault()`ed so React state stays the source of truth,
  routed through the same animated `close()`.
- Backdrop click → hit-tested against the dialog rect, so clicks on the card's own padding don't
  dismiss.
- Body scroll lock, focus restore to the previously focused element, and initial focus via either
  React's already-applied `autoFocus` (re-focused, because `showModal()` steals it) or a
  `[data-autofocus]` opt-in.
- `onDismissRequest` returning `true` consumes an Escape/backdrop dismiss without closing (used by
  the store browser's inner new-folder row). Explicit `close()` always closes.

### 4.4 Toast two-phase exit

`app/ui/toast.tsx`. `TOAST_DISMISS_MS = 2600`, `TOAST_EXIT_MS = 200`. Timer 1 flips `leaving: true`
(CSS `.toast.leaving` transitions opacity+`translateY(10px)` over `.2s`, mirroring the `rise`
entrance path but faster); timer 2 unmounts 200ms later. All timers are tracked in a ref and cleared
on unmount. **Exits are always faster than entrances** across the app — same rule in the dialog
(`.15s` out vs `.18s` in) and the capability accordion (instant collapse vs `.16s` expand).

### 4.5 Reduced motion — two independent switches

1. **In-app preference** (`user_prefs.motion`, set on `/profile`). SSR renders
   `<html data-motion="reduce">` directly from the DB so there is no flash (`root.tsx:66-71`).
   The rule is a global kill switch: `[data-motion="reduce"] *, ::before, ::after` clamps
   `animation-duration` and `transition-duration` to `.01ms !important` (app.css:2251).
   This is also what makes `useDialog.close()` take its synchronous branch.
2. **OS preference** `@media (prefers-reduced-motion: reduce)` — six blocks, and they are *not*
   a kill switch. Entrances collapse to `fade-in .12s` (movement is what nauseates; opacity still
   aids comprehension) at app.css:3322-3329, dialogs stay centred while fading, the toast exit drops
   its translate, the board/stage-menu animations go to `none` (`:766`), the rail transition is
   removed (`:2611`), and `.rq-go`'s hover nudge is disabled (`:2093`).

Two indicators need explicit reduced-motion fallbacks because clamping would leave them
meaningless: `.route-pending .rp-fill` becomes full-width (`:3400-3403`), and the toast still fades.

---

## 5. Shared UI primitives

### 5.1 `app/ui/` inventory

| file | export | notes |
|---|---|---|
| `icon.tsx` | `Icon({name, className})`, `IconName` | 37 inline 24px stroke paths; `stroke-width 1.7`, round caps; **always `aria-hidden="true"`** — every icon-only control must supply its own label. Unknown name → `dot`. Names: `board review inbox shield agents github activity search filter plus branch pr check copy clock alert file lock arrow user cpu message sparkle refresh x bolt memory dot send hand flag bell chevron sliders grip ext term` |
| `avatar.tsx` | `Avatar({person:{initials,tone}, lg, xl})` | 26 / 34 / 56px; tones `rose`/`teal`/`violet` |
| `initials.ts` | `initialsOf(name)` | split out for the Fast Refresh boundary |
| `identity.tsx` | `AgentGlyph({backend, lg, op})` | angular clip-path ("machine"); `op` → shield on `--fg`; claude → warm tint + `sparkle`; else codex + `cpu`. `title` is the only AT affordance |
| `pill.tsx` | `Pill`, `ReadinessPill`, `ValidationPill` | `PillKind = ready\|input\|risk\|blocked\|info\|agent\|neutral\|done`. Readiness map: `ready`, `input_required`→"input required", `inconsistency_risk_detected`→"inconsistency risk", `blocked`, `accepted`/`merged`→done. Validation map: `healthy`→"validation healthy", `changed`→**"awaiting verdict"**, `failing`, `none`→"no validation" |
| `toggle.tsx` | `TglP({on, onChange, label})` | `role="switch"` + `aria-checked` + `aria-label`; knob translates 15px |
| `skip-link.tsx` | `SkipLink({targetId="main-content"})` | WCAG 2.4.1 bypass block; visibility driven by React focus state with **inline styles, no CSS classes** (deliberate) |
| `page-overlay.tsx` | `PageOverlay({label, onClose, children})` | `useDialog` + `.page-overlay` + `.overlay-x` close button |
| `local-time.tsx` | `LocalDayDotTime`, `LocalRelative`, `useHydrated` | UTC-deterministic first paint, viewer-local after hydration — the React #418 fix |
| `use-relative-time.ts` | `useRelativeTime(iso)` | re-renders on mount and every 30s; callers add `suppressHydrationWarning` |
| `use-shortcut-hint.ts` | `useModifierHint(key="K")` | SSR emits `⌘K`, effect swaps to `Ctrl K` off `navigator.userAgent` |
| `markdown.tsx` | `Markdown({text, mentionNames})` | react-markdown + remark-gfm, no raw HTML; links get `target=_blank rel=noopener`; tables wrapped in `.md-table-wrap` (overflow-x); a rehype plugin chips known mentions, skipping `code`/`pre`. Caller must wrap in `.md-body` |
| `rich-text.tsx` | `RichText({text, mentions})` | inline micro-format only: `**bold**`, `` `code` ``, `@mention` |
| `mention-spans.ts` | `findMentionSpans`, `extractMentions`, `RESERVED_MENTION_HANDLES` | the single matcher shared by the renderer, the composer and the server router. Reserved: `operator agent claude codex` |
| `stage-menu.tsx` | `StageMenu` | see §5.6 |
| `csrf-input.tsx` | `CsrfInput`, `useCsrfToken` | see §6.2 |
| `toast.tsx` | `ToastProvider`, `useToast`, `useToasts` | see §4.4 |
| `use-action-toast.ts` | `useActionToast(fetcher)` | server-computed toast from `{ok, toast\|error}` |
| `use-fetcher-result.ts` | `useFetcherResult(fetcher, onResult)` | once-per-settled-result handler; the repo's canonical handled-ref pattern |

### 5.2 Shell primitives — `app/features/shell/`

`topbar.tsx`, `rail.tsx`, `nav.ts` (see §2.0) · `user-menu.tsx` · `top-bell.tsx` ·
`command-palette.tsx` · `route-pending-bar.tsx` · `theme-preference.ts` ·
`csrf-result.server.ts` · `command-search.server.ts`.

- **`user-menu.tsx`** — Escape closes (`:73`); theme cycles light→dark→system with an optimistic
  `applyThemePreference` before the POST to `/prefs/theme` (`:99-108`), and the menu **stays open**
  on theme click. `role="menu"`/`menuitem` were deliberately **removed** (rationale at `:121-130`):
  the panel is `tabIndex={-1} aria-label="Account menu"` and the trigger is
  `aria-haspopup="dialog"`. Contains the only other `<CsrfInput/>` (`:188`, the logout `<Form>`).
- **`top-bell.tsx`** — `BELL_LIST_CAP = 100`. A **declarative non-modal `<dialog open>`** (not
  `showModal()`) so it stays anchored to the bell; Escape closes; focus moves in on open and back to
  the bell on close. `markRead(ids)` / `markAllRead()` POST to `/notifications/read`. The
  `.bell-badge` is keyed on `unread` so the `stagePulse` re-fires on every SSE arrival — that pulse
  is the *only* signal a notification landed (the shell defines no incoming-notification toast).
- **`command-palette.tsx`** — `useDialog`, `.cmdk-card` anchored at `12vh`. 140ms debounce, and it
  only trusts a payload whose `q` matches the on-screen query (`:51-55`) so the list never flashes
  stale rows. `↑/↓` wrap, `Enter` navigates then closes (navigate first, so focus restore + exit
  transition still run). Groups: Projects, Tasks, Branches, Agents. Server side
  `command-search.server.ts` scopes hits to the viewer's visible projects, 6 per group, 60-row task
  scan.
- **`route-pending-bar.tsx`** — the app's **one** route-level pending indicator, mounted once in
  `root.tsx:172`. 220ms delay so fast client navigations never flash it. Pending requires
  `state !== "idle" && navigation.location != null` — the `location` check deliberately excludes
  `useRevalidator`-driven SSE revalidations, so live updates never draw a loading bar.
  `role="progressbar"`, `z-index: 90` (above sticky headers 30/50 and popovers 60, below the toast
  host at 100).

### 5.3 Z-index ladder

`.menu-scrim` 40 · mobile `.rail-scrim` 44 / `.rail` 45 · `.user-menu`/`.ntf-pop`/`.own-menu`/
`.rsel-menu` 50–60 · `.confirm-card`/`.modal-card`/`.page-overlay` 61 · `.route-pending` 90 ·
`.toast-wrap` 100 · `.stage-menu-pop` 1000 (portaled to `<body>`).
Native `<dialog>` + `showModal()` promotes to the browser **top layer**, above all of these — which
is why the toast host is itself a `popover="manual"` element (`toast.tsx:69-97`), otherwise every
confirmation inside `/profile` and `/notifications` rendered dimmed behind the backdrop.

### 5.4 Confirm / modal shells

Three card shapes, all native `<dialog>`: `.confirm-card` (420px, `.confirm-icon` + `h3` + `p` +
`.confirm-actions`), `.modal-card` (660px, `.modal-head`/`.modal-body`/`.modal-foot`; `.modal-wide`
= 1060px), `.page-overlay` (1080×780 max, `.overlay-x` + `.page-overlay-body`). Destructive dialogs
use `role="alertdialog"`. Form fields inside them use the shared `.field` / `.flabel` / `.fhint`
vocabulary (app.css:1570-1582) with a blue focus ring (`box-shadow: 0 0 0 3px blue@14%`).

### 5.5 The Lexical mention composer

Files: `comment-composer.tsx` (304), `lexical-mention-plugin.tsx` (216), `mention-menu.tsx` (100),
`use-mention-autocomplete.ts`, `mention-autocomplete.ts`. Replaced a textarea + transparent-text
mirror backdrop in 2026-08-03 (A3).

- **Plain text only.** `PlainTextPlugin`, namespace `"task-comment"`, `nodes: [MentionTextNode]` —
  no rich text, no Markdown/HTML transformers, no editor state persisted. The value submitted is
  `$getRoot().getTextContent()` → `raw.trim()` in a `text` form field. The posted bytes are pinned by
  a fixture table in the tests.
- **`MentionTextNode`** (`lexical-mention-plugin.tsx:29`) `extends TextNode`, type
  `"viberr-mention"`, and does exactly one thing: `createDOM` adds the `.mention` class. It stays
  **fully character-editable** and copies/exports as its plain `@Name` text.
- **Segmentation** is a paragraph-level node transform registered on both `TextNode` and
  `MentionTextNode` (`registerMentionHighlighting:200`). It re-runs `findMentionSpans(text, names)`
  — the *same* matcher the renderer and the server router use — filters to `known`, diffs against
  the current mention ranges, and only splices when out of sync, restoring the caret. It bails while
  `editor.isComposing()` (IME-safe; Lexical re-runs on the settling update).
- **Trigger**: `@` at start-of-string or after whitespace, plus ≥1 `[\w-]` char before the caret
  (`detectMentionToken`). Inserting writes the **display name**, not the handle
  (`insertMention` → `` `@${name} ` ``).
- **Keyboard model is Lexical commands at `COMMAND_PRIORITY_HIGH`** (`ComposerKeysPlugin:102`):
  `⌘/Ctrl+Enter` sends always; while the menu is open Enter/Tab pick, ↑/↓ move (wrapping), Escape
  closes; otherwise Enter is a plain line break. Every one of them returns `false` first if
  `editor.isComposing()`.
- **ARIA**: the `ContentEditable` is the combobox — `role="combobox"`, `aria-expanded`,
  `aria-controls`, `aria-activedescendant`, `aria-autocomplete="list"`; the menu is
  `role="listbox"` with `role="option"` rows carrying `id={listId}-opt-{i}`. Rows `preventDefault`
  their `mousedown` so the editor keeps focus. Covered by `e2e/05-task-comment-composer.spec.ts:148`.
- **Imperative handle**: `focus()`, `prefillIfEmpty(text)` (ask-operator → `"@operator "`),
  `clearAfterSuccess()` which also dispatches `CLEAR_HISTORY_COMMAND` so ⌘Z cannot resurrect a
  posted comment. A failed post keeps the draft.
- The draft is held in a **ref** (`timeline.tsx:225`), not state, so the Timeline does not re-render
  per keystroke.

### 5.6 The dnd-kit board layer

`@dnd-kit/react` + `@dnd-kit/dom` `0.5.0` (exact-pinned). Migrated from HTML5 drag events
2026-08-03 (A2). All in `app/features/board/board-page.tsx` + the pure mapper `board-dnd.ts`.

- **Sensors** `BOARD_SENSORS:92-113`: `PointerSensor.configure({ preventActivation: target =>
  target.closest("button, input, select, textarea"), activationConstraints: touch ? Delay(250ms,
  tol 5) : Distance(5px) })` plus `KeyboardSensor`. Mouse is **distance-only** so a slow
  press-and-release on the card still navigates; touch is a 250ms long-press so column scrolling
  isn't hijacked.
- **Whole card is the handle, no grip.** The sortable `ref` goes on the wrapper `div` and the card
  face is a `<Link draggable={false}>` (`:238-245`). `preventActivation` is the only carve-out, and
  it exists so the `StageMenu` button inside `.card-move` stays clickable.
- **The `Accessibility` plugin is OFF**: `BOARD_PLUGINS = defaultPreset.plugins.filter(p => p !==
  Accessibility)` (`:120-122`). Its `role="button"` card wrapper nested the task `<Link>` and the
  `StageMenu` button → axe `nested-interactive` (serious). AutoScroller, Cursor, Feedback and
  PreventSelection stay. Drag is declared pointer-only; the AT path is the StageMenu (F10-25).
- **`OptimisticSortingPlugin` is removed per-sortable** and `Feedback` is `"clone"` — the original
  stays a faded dashed ghost (`.card-wrap.dragging`) while a clone follows the pointer, and
  **nothing reorders client-side**.
- **`DropPreview`** (`:327`) — an `aria-hidden` ghost row (`.card-drop-preview`, dashed blue,
  `dropPreviewIn`) showing the dragged key + title, interleaved before the target card, appended
  when `beforeKey === null`, or filling an empty column.
- **Column droppable** `useDroppable({id: "stage:"+id, collisionPriority: 1})` — Low, so an over-card
  collision (Normal) always wins; the column target is what makes empty stages droppable.
- **State machine** `:995-1077`: `onDragStart` seeds, `onDragOver` proposes (`stage:` → end of
  column, card → that card's key), `onDragMove` refines against the pointer's vertical midpoint
  (top half → before, bottom half → the `nextKey` carried in the sortable's `data`), `onDragEnd`
  bails on `event.canceled`.
- **Server-authoritative move**: `resolveBoardDrop` (`board-dnd.ts:23`, pure, 13 unit cases, returns
  `null` for no-ops and degrades a vanished `beforeKey` to end-of-column) → `FormData{_csrf, intent:
  "reorder", taskKey, to, beforeKey}` → `fetcher.submit` to the **current route** →
  `routes/project.board.tsx:43`. The toast distinguishes accepted-into-Done / moved / reordered. The
  only optimistic thing on the board is the **column header count** during a cross-column drag
  (`:929-934`); the landing pulse (`.just-arrived`, `cardArrive`) retires after 1500ms.
- **`StageMenu`** (`app/ui/stage-menu.tsx`, 227 lines) is the keyboard/AT path and is shared with the
  task-detail "Current state" panel. Trigger: real `<button>` with `aria-haspopup="menu"`,
  `aria-expanded`, `aria-label="Change stage (currently X)"`. Popover is `createPortal`'d to
  `<body>` and fixed-positioned from the trigger rect with an 8px viewport clamp (so it never clips
  inside a scrolling column). `role="menu"` + `role="menuitemradio"` + `aria-checked`; the current
  stage is `disabled` and skipped. Keyboard: ↑/↓ wrap, Home/End, Escape → close **and return focus
  to the trigger**; Enter/Space are native. Focus moves into the first enabled item on open. Closes
  on outside mousedown, Escape, and scroll (capture:true) / resize. Picking posts the identical
  `reorder` intent with `beforeKey: ""`.

Bundle cost of the migration: board route **+35.0 KiB gzip**; task route (Lexical) **+61.2 KiB gzip**.

---

## 6. Client data flow

### 6.1 The one rule

`docs/architecture/decisions.md:81` — **"No optimistic UI for governed state. Revalidate after the
action and on SSE."** Every governed mutation posts, the action returns `{ok, toast, …}`, and the UI
re-renders from a revalidated loader. The three sanctioned exceptions are cosmetic:
Home's view/pin prefs read off `fetcher.formData`, the theme applied before its POST resolves, and
the board's column header count during a drag.

### 6.2 Forms and CSRF

- The token comes from the **root loader** (`root.tsx:75`, derived from the session) and is read with
  `useCsrfToken()` (`app/ui/csrf-input.tsx:15`). Server side: `assertCsrf(request, sessionId,
  formData)` inside `requireFormAction`.
- **Every mutating submission must carry `_csrf`.** There are exactly two shapes:
  - `<CsrfInput />` in a declarative `<Form>` — used in only **two** places app-wide
    (`routes/login.tsx:203`, `shell/user-menu.tsx:188`), plus one hand-rolled hidden input in
    `task-detail-page.tsx:545`;
  - `fd.set("_csrf", csrf)` on a hand-built `FormData` passed to `fetcher.submit(fd, {method:"post"})`
    — this is the overwhelming default (~40 call sites).
- A handful of surfaces pass a **plain object** instead of `FormData`
  (`agents-page.tsx:1032`, `settings-page.tsx:1074+`, `github-view.tsx:376+`, `policy-page.tsx:532+`,
  `org-settings/use-org-action.ts:59`, `store-browser.tsx:585+`). Both work; the inconsistency is
  noted in §8.
- `fetcher.submit` is called **without an `action`** everywhere — posts always go to the current
  route's action, discriminated by `intent`.
- Result handling is always once-per-settled-result via a handled ref:
  `useActionToast(fetcher)` for server-computed `{ok, toast|error}`, or
  `useFetcherResult(fetcher, fn)` for anything custom. A failure toast **must** be pushed with
  `"error"` so it renders the alert glyph instead of the success tick (the glyph is the only signal —
  both kinds paint `var(--fg)`).

Fetcher ownership, so you know where a mutation lives:

| surface | fetchers | toast helper |
|---|---|---|
| home | `prefsFetcher`, `rescanFetcher`, `rebuildFetcher`, modal-local | `useFetcherResult` + manual |
| board | `rescanFetcher`, `transitionFetcher`, modal-local | manual |
| task detail | **13** (see §2.8) | `useActionFeedback` (local wrapper) |
| timeline composer | 1 (`comment`) | manual, keeps draft on failure |
| agents | 1 (+ a GET catalog fetcher in the modal) | manual, routes errors into the open modal |
| policy | `roleFetcher`, `boundaryFetcher` | `useActionToast` |
| github | `reconcileFetcher`, `grantFetcher`, `credFetcher` | `useActionToast` |
| project settings | 6 | `useActionToast` |
| org settings | 1 shared hook `useOrgAction` (3 instances in resources) | built into the hook |
| kb browser | 4 (`opsFetcher`, `ghFetcher`, `readFetcher`, `saveFetcher`) | split so a failed read never rides the generic store toast |
| profile | 6 (5 passed as props + `themeFetcher`) | `useFetcherResult` with rollback |
| notifications | 1 (route-owned) | `useFetcherResult`, bulk case only |
| review, activity, runtime | **none** — read-only surfaces | — |

### 6.3 Feedback hierarchy

Inline first, toast second. Refusals are **rendered copy next to the control**, never a bare disabled
button — `.deny-note` (app.css:403) exists precisely because `title` is unreachable on a disabled
element for keyboard and touch. Disabled controls also *read* disabled (opacity .45, `not-allowed`,
no lift — app.css:391-400). Form/server errors use one framed treatment, `.login-err, .form-err`
(app.css:2815). Inline field errors carry `role="alert"`.

### 6.4 SSE / live updates

- Endpoint `GET /resources/events?scope=…&scope=…` (`app/routes/resources.events.ts`). Scope kinds:
  `user`, `projects`, `project:<slug>`, `task:<slug>/<key>`. Non-admins have `projects` expanded to
  their membership rows and foreign explicit scopes dropped; nothing left → **403**. Signed-out →
  **JSON 401** (not a redirect — EventSource can't render a login page). Bad scope → 400.
  `Last-Event-ID` resume; `text/event-stream`, `no-store`, `X-Accel-Buffering: no`; 1024-chunk
  backpressure cap.
- Event names (`app/schemas/sse-event.schema.ts`, zod-parsed before publish):
  `task.updated`, `task.removed`, `project.updated`, `project.removed`, `projection.rebuilt`,
  `notification.created`, `notification.read`, `violation.updated`, `run.log-appended`,
  `run.state-changed`, plus control events `stream.open`, `stream.resync`. Payloads are
  `{type, entityId, occurredAt, data}` with **compact facts and references only** — never fat objects.
- **Client hook** `app/features/live-updates/use-live-updates.ts` — subscribes every non-control
  event name and does exactly one thing: `revalidate()`, debounced 300ms (trailing) so a burst
  coalesces into one loader round-trip. No optimistic state, no client cache.
  Disconnect handling: an EventSource that receives a non-200 **fails permanently** and never
  retries, so `onerror` on `readyState === CLOSED` flips `paused` (the topbar renders the
  *live updates paused — retry* chip) and re-opens on a bounded backoff `[2s, 5s, 15s, 30s]`;
  `onopen` after a retry pulls the loaders once so the snapshot is current.
  Call sites: `_index.tsx:201` (`user` + `projects`), `notifications.tsx:78` (`user`),
  `project.tsx:150` (`project` + optional `task` + `user`).
- **Second, dedicated stream**: `app/features/runtime/use-run-log-stream.ts:453` opens its own
  EventSource scoped to the task, and on `run.log-appended` fetches
  `/resources/run-log?runId=…&since=…` rather than revalidating (log lines are high-frequency and
  reference-only on the wire); `run.state-changed` triggers a single `revalidate()`. Gated by
  `enabled: runsVisible` — non-members get redacted run rows and no stream.
  Guards worth preserving: one in-flight tail per run (`inFlight` Set, `:404`) to stop duplicated
  lines; `fresh = lines.filter(l => l.seq > head)` dedupe on arrival; `headSeq` taken from
  `window.headSeq`, explicitly not `lines.length - 1`; and a `pagedRef` **freeze** so once a thread
  has been paged backwards a loader re-seed cannot drop the loaded pages and open a hole
  (`:215-247`). Backward paging is `?before=&limit=` at 200 lines/page, walking `logWindow.runIds`
  backwards and re-synthesising the `── resumed · run N of M ──` divider at each boundary.
  **This stream does not reconnect** — `onerror` on `CLOSED` just sets
  `"Live tail disconnected — reload the page to resume following."` (`:456-465`). A
  `setInterval(revalidate, 20_000)` while a run is active (`:168-174`) is the only safety net, and it
  refreshes the loader, not the log. See rough edge #21.

### 6.5 Notification bell

`TopBell` renders the top 100 from the layout/home loader; `notification.created` and
`notification.read` are `user`-scoped SSE events, so the badge updates by revalidation in every open
tab. The badge is keyed on `unread` to re-fire `stagePulse`. Mark-read posts to
`/notifications/read` (`intent=read` with repeated `id` fields, or `read-all`). The full page at
`/notifications` renders in a `PageOverlay` and carries a "See all" path from the popover with
`state.returnTo`.

---

## 7. Accessibility posture

The claim is **WCAG 2.2 AA on core workflows, in both themes**, and it is gated, not asserted:

- `e2e/07-accessibility.spec.ts` runs axe (`wcag2a` + `wcag2aa` + `wcag22aa` tags **only** —
  best-practice rules are opinions, and failing CI on an opinion trains people to ignore the gate)
  across board, task detail, review queue, policy, home, agents in **both themes**, plus login
  signed-out. Violations are reported with their selectors, not a count. Login waits for the card's
  animations to settle before sampling, because axe reads computed colours.
- `app/app.css.test.ts` statically enforces the contrast floors and the token/class integrity (§3.5).

Deliberate positions:

| decision | where | why |
|---|---|---|
| dnd-kit's `Accessibility` plugin is **off** | `board-page.tsx:120` | its `role="button"` wrapper nested the task link + StageMenu → axe `nested-interactive` (serious). Keyboard drag was **not** added; the AT path is StageMenu |
| `StageMenu` is the a11y path for board moves | `stage-menu.tsx` | full `role="menu"`/`menuitemradio` contract, roving arrows, Home/End, Escape-with-focus-return, portaled so it never clips |
| `role="menu"` **removed** from the user menu | `user-menu.tsx:121-130` | it declared the role without implementing the keyboard contract; an honest `aria-haspopup="dialog"` + labelled panel replaced it |
| The bell is a **non-modal `<dialog open>`** | `top-bell.tsx:117-127` | `showModal()` would unanchor it from the bell |
| `aria-current="page"` computed from `activeView`, on a plain `Link` | `rail.tsx:58-67` | `NavLink` only emits it on a URL match, so Board had no programmatic active signal on `/tasks/:key` |
| Refusals are rendered copy, not `title` on a disabled control | `.deny-note`, app.css:401-410 | `title` never opens on a disabled element |
| Every icon is `aria-hidden` | `icon.tsx:74` | forces icon-only controls to carry their own `aria-label` |
| Advisory capabilities collapse under `<details>`, never hidden | `agents-page.tsx:609`, app.css:1643 | native `<details>` gives keyboard + SR behaviour free; R15-12 rejected hiding |
| `SkipLink` on both shells | `project.tsx:170`, `home-page.tsx:1579` | target `<main id="main-content" tabIndex={-1}>` |
| One `h1` per surface | pass-15 fix | Agents used to announce itself twice |
| Nothing is gated on viewport | app.css mobile block `:2577` | every governance control renders at every width; the rail becomes an overlay rather than the controls disappearing |
| Colour is never the only carrier | pills carry text + dot + icon | e.g. `.pill.done` gets its own dark-theme colour so it doesn't rely on the token swap alone |
| The log console is `role="log" aria-live="off"` | `runs-panels.tsx:530` | a streaming agent log announced live would flood AT; the state pill and footer carry the meaning instead |
| Notification stream rows are **not** `role="button"` | `notifications-page.tsx:135-144` (UI-54) | a div that swallows a click is dishonest; the row instead contains a real task link and, when unread, an explicit labelled *Mark read* button |
| The mention menu is a proper combobox/listbox pair | `comment-composer.tsx:259-268` + `mention-menu.tsx:60-86` | `aria-activedescendant` keeps focus in the editor; rows `preventDefault` their mousedown |
| Every filter/segment control carries `aria-pressed`; role pickers carry `role="radiogroup"` | board, activity, timeline, policy, agents | selection was previously a CSS class only (UI-57) |

Landmarks: `<nav aria-label="Primary">` (rail), `<nav aria-label="Breadcrumb">` (topbar),
`<main id="main-content">` on both shells, `role="status" aria-live="polite"` on the toast host,
`role="progressbar"` on the route-pending bar, `role="radiogroup"` with roving tabindex on decision
packet options, `aria-pressed` on every segmented/filter control, `role="switch"` on every toggle.

---

## 8. Known UI rough edges

Found by reading; none are blocking, all are specific. Ordered roughly by impact.

1. **No app-wide focus-visible ring.** `app/app.css` defines `:focus-visible` on exactly four
   selectors — `.card:660`, `.cap-advisory > summary:1662`, `.pj-link:2929`, `.log-more:3418`.
   Every other button, link, nav item, menu item, chip, pill-button and segmented control falls back
   to the **UA default outline**, which is a black/white double ring that matches nothing in the
   design language and reads inconsistently across the two themes. Meanwhile a dozen inputs set
   `outline: 0` and substitute a blue `box-shadow` ring (`.field input:focus:1581`,
   `.invite-row input:2122`, `.fm-gh input:3236`, `.repo-input:3139`, …), so the app already *has* a
   focus idiom — it just isn't applied to the controls that need it most. axe does not catch this
   (2.4.7/2.4.11 are largely manual). **Suggested fix**: one `:focus-visible` rule keyed on the same
   blue ring, plus removal of the ad-hoc per-control duplicates.

2. **Ten class names are used in TSX with no rule in `app/app.css`** — they render unstyled and the
   integrity test does not catch them (it only checks four hard-coded names):
   `composer-input` (`task-detail/timeline.tsx:339`), `mention-menu` (`task-detail/mention-menu.tsx:61`),
   `cred-manage` (`github/credential-card.tsx`), `cursor` + `faint` (`runtime/runs-panels.tsx`),
   `ho-exc` + `trans-list` (`policy/policy-page.tsx`), `ntf-truncated`
   (`notifications/notifications-page.tsx`), `rsrc-wrap` (`org-settings/resources-panel.tsx`).
   `rsrc-wrap` in particular is a layout wrapper on the Agent-resources panel that currently does
   nothing. **Suggested fix**: extend `app.css.test.ts` to diff *all* TSX class names against the
   stylesheet, then either define or delete each.

3. **`.composer-box` has no `position: relative`.** `.composer-box .composer-placeholder` is
   `position: absolute; top: 0; left: 0` (app.css:1111) and `MentionMenu` positions itself absolutely
   (`mention-menu.tsx:64-70`), but the containing block is supplied by an **inline**
   `style={{position:"relative"}}` on an undefined `.composer-input` div
   (`timeline.tsx:338-341`). It works, but the positioning contract lives in a JSX attribute instead
   of the stylesheet — delete that inline style and the placeholder and mention menu jump to the
   viewport.

4. **184 inline `style={{…}}` attributes** across `app/features`, `app/routes`, `app/ui`
   (`task-detail-page.tsx` 24, `settings-page.tsx` 17, `agents-page.tsx` 14, `policy-page.tsx` 11,
   `home-page.tsx` 11, …). Many are legitimate (dynamic stage colours, portal coordinates), but a
   large share are static typography/colour that belongs in the sheet — e.g.
   `timeline.tsx:333,356,361,368` (`fontSize`/`color` on four spans),
   `rail.tsx:74-77` (violation count colour), `create-profile-modal.tsx:86` `selectStyle`.
   The porting rules say tokenized CSS only.

5. **`<select>` has no design-system treatment.** `create-profile-modal.tsx:86` carries an inline
   `selectStyle` with the explicit comment that the design system has no select rule;
   `.op-sel` (app.css:1009) and `.sched-controls select` (`:1143`) and `.fm-toolbar select`
   (`:3149`) each re-invent it. Four different select looks ship today.

6. **The project-settings stage list still uses hand-rolled HTML5 drag.** `.stg-row.dragging` /
   `.stg-row.over` (app.css:2008-2009) with a visible `.stg-handle` **grip** — the exact pattern the
   board deliberately migrated away from on 2026-08-03, and the opposite affordance (grip vs
   whole-row). Two drag idioms now coexist. The KB browser adds a third (`.fm-row.droptgt` /
   `.fm-tree.droptgt`, app.css:3243-3244).

7. **The ⌘K palette's listbox is structurally broken for AT.** `command-palette.tsx:125` declares
   `role="listbox"`, but each `role="option"` button (`:141`) is wrapped in a plain `<div>` together
   with its group heading (`:137-140`), so the options are not direct children of the listbox and
   the group headings are not `role="group"`/`aria-label`ed. The input carries `aria-controls` but
   **no `aria-activedescendant`** and no `role="combobox"` / `aria-expanded` — the mention composer
   next door gets all of this right (`comment-composer.tsx:259-268`), so the pattern exists in-repo.
   Focus never leaves the input, so nothing announces the highlighted row.

8. **⌘K is bound twice with duplicate handlers** — `topbar.tsx:67-76` and `home-page.tsx:1437-1446`.
   Same key, same behaviour, two implementations that can drift.

9. **`--font-display` is declared twice.** app.css:59 (Roobert-first, matching
   `design/design-system.html`) and app.css:2724-2726 (`Manrope`). The second wins, so the first is
   dead — and reading the token block at the top of the file tells you the wrong answer.

10. **`.card.wait-human, .card.wait-human.urgent { box-shadow: var(--shadow-card) }`** (app.css:662)
    is a no-op that exists only to neutralise a treatment that no longer exists (ruling 16 keeps
    `.card.urgent` "visually untreated"). It reads like a bug to the next person.

11. **`.top-search` is an input on Home and a button in the workspace.** Deliberate (R15-5: Home's
    box is a project finder, the workspace's opens the global palette) and documented at
    app.css:301-306 — but they are pixel-identical, so the same silhouette does two different things
    depending on the route. Worth a visual differentiator.

12. **Two Escape idioms coexist.** `useDialog` handles Escape via the native `cancel` event for
    every `<dialog>`; the hand-rolled popovers (`user-menu.tsx:73`, `top-bell.tsx:48`,
    `stage-menu.tsx:95`, the three menus in `execution-profile.tsx:100/266/384`) each register their
    own `window`/`document` keydown listener. Six near-identical implementations of
    "Escape + outside-mousedown closes me" with no shared hook.

13. **Toast stack is unbounded.** `toast.tsx:49` appends without a cap; a burst of failures stacks
    off-screen. Everything else in the app caps its lists (`BELL_LIST_CAP = 100`,
    `COMMAND_GROUP_LIMIT = 6`, feed limits).

14. **`.board-wrap::after` fade is unconditional** (app.css:588-594). The "there is more to the
    right" gradient paints even when the board fits and there is nothing to scroll to, tinting the
    right edge of every board.

15. **The mobile rail scrim is a `<button aria-hidden="true">`** (`project.tsx:183-189`). It passes
    axe because `tabIndex={-1}` makes it non-focusable, but a hidden interactive element as a
    dismiss layer is a fragile pattern — a future `tabIndex` change silently creates an
    `aria-hidden-focus` violation.

16. **Breakpoint sprawl.** Eight distinct widths: 1400, 1300, 1100 (×8 blocks), 1080, 1000, 900
    (both `max` and `min`), 760, 720. The UX spec documents seven of them and omits 720 (the mobile
    rail, added later by F15-18). 1100 doing eight unrelated jobs makes it hard to reason about what
    a change at that width affects.

17. **`app/features/task-detail/task-detail-page.tsx` is 1761 lines** and holds ~15 components plus
    13 fetchers; `home-page.tsx` is 1691 with the whole New-project modal inline;
    `resources-panel.tsx` is 1471. These are the three files where any UI change is most likely to
    conflict with concurrent work.

18. **Uncovered surfaces in the axe sweep**: the six audited surfaces are board, task detail, review,
    policy, home, agents (both themes) plus signed-out login. Not audited: **activity, project
    settings, GitHub, org settings, `/profile`, `/notifications`**, and no dialog is ever audited in
    its open state (the sweep never opens one). The two densest forms in the app — the create-profile
    modal and org settings — are outside the gate.

19. **`Icon` renders `dangerouslySetInnerHTML`** (`icon.tsx:73`) from a frozen local map. Safe today,
    but it means an icon name can never become dynamic/user-supplied without a real XSS review.

20. **The `.mention` chip has no accessible distinction from surrounding text** other than colour +
    background (app.css:1146). In a comment body read by a screen reader, `@Selin` is
    indistinguishable from the word "Selin".

21. **Two SSE consumers, two different disconnect stories.**
    `use-live-updates.ts` detects a permanently-failed EventSource, shows the *live updates paused —
    retry* chip and re-opens on a `[2s,5s,15s,30s]` backoff. `use-run-log-stream.ts:456-465` does
    none of that: it sets `"Live tail disconnected — reload the page to resume following."` and
    stops. The same failure (an expired session 401s both streams) therefore self-heals in the shell
    and requires a manual reload in the log panel. The backoff logic already exists next door.

22. **The PAT input is `type="text"`.** `connections-panel.tsx:125-137` — the field is
    `type="text" className="mono"` with placeholder `ghp_…`, labelled "stored encrypted · never
    displayed". The token is therefore shown in cleartext while typing, visible to shoulder-surfers,
    screen-sharing and screenshots, and offered to the browser's autofill/save heuristics as a normal
    text field. `.field input[type="password"]` is already styled (app.css:1574).

23. **Four SVG icon sources.** `app/ui/icon.tsx` is documented as the one ported icon component
    ("reused everywhere", `docs/architecture/decisions.md`), but four files ship their own inline
    SVGs: `home-page.tsx:49` (`StarIco`), `org-settings/mini-modal.tsx:114` (`EditIco`, a pencil),
    and three in `kb-browser/icons.tsx`. Stroke widths and viewBoxes are not guaranteed to match the
    1.7/24 house style.

24. **`.stg-x` has drifted from its name.** It was the stage-remove ✕ in project settings
    (app.css:2029) and is now the generic 24px icon-button across org settings — user disable
    (`users-panel.tsx:661`), user enable, user remove, resource delete/edit/re-index
    (`resources-panel.tsx:941`), connection remove (`connections-panel.tsx:306`) — with per-site
    `:hover` colour overrides (app.css:3186-3187) patching the semantics back. There is no neutral
    `.row-act` primitive; `.fm-act` and `.rsrc-acts .stg-x` and `.icon-btn` are three answers to the
    same question.

25. **Three different "row actions on hover" implementations.** `.card-move` (opacity 0 →
    `:hover`/`:focus-within`, app.css:668), `.fm-acts` (identical rule, app.css:3252), and
    `.rsrc-acts` (always visible). Hover-revealed controls are also a touch problem: on a
    touch-only device `.card-move` and `.fm-acts` are only reachable via `:focus-within`, i.e. after
    a tab.

26. **Only two `aria-live` regions exist in the whole feature tree** — the toast host
    (`role="status" aria-live="polite"`) and the KB uploader's busy note
    (`store-browser.tsx:1158`). Everything else that changes asynchronously — board reorder results,
    stage moves, run state flips, the notification badge — announces nothing. Combined with the
    dnd-kit `Accessibility` plugin being off, a screen-reader user gets no confirmation that a
    governed action succeeded beyond the toast, which they may miss entirely if focus is elsewhere.

27. **`.gh-table .live-head, .live-row` overrides the grid template globally** (app.css:2101) —
    the branches table reuses the agents-roster `.live-table` classes with a different column count.
    Any change to `.live-head`'s five-column template (app.css:2559) silently affects GitHub too.

---

### 8.1 Class-name → owner map (for cross-referencing `app/app.css`)

| prefix | surface | representative site |
|---|---|---|
| `rq-` | review queue rows, reused by notifications + GitHub PR list | `review-page.tsx:38` |
| `pol-` | policy notes (`pol-note` is the app-wide explanatory-note class, 16 sites), `pol-ev` rows | `policy-page.tsx:95` |
| `ntf-` | bell popover + notifications page + profile routing grid | `notification-item.tsx:38` |
| `set-` | instance/project settings shell (`set-head/layout/nav/content/fields`) | `org-settings-page.tsx:56` |
| `fm-` | KB file browser (tree, rows, actions, doc editor, GitHub import) | `store-browser.tsx:344` |
| `rsrc-` | org-settings resources panels | `resources-panel.tsx:1331` |
| `conn-` | org-settings GitHub connections | `connections-panel.tsx:214` |
| `cred-` | shared credential card (github + project settings + profile) | `credential-card.tsx:53` |
| `gh-` | GitHub bar/body/table/freshness | `github-view.tsx:474` |
| `run-` / `runbar` / `rsel-` / `ri-` / `rdot` | runtime strip + agent picker | `runs-panels.tsx:173` |
| `log-` / `logs-` / `console` / `lt lx ltag ln lcaret` | streamed console (literal hex, never themed) | `runs-panels.tsx:528` |
| `stg-` | stage list; `.stg-x` also the generic org-settings icon button | `settings-page.tsx:289` |
| `ag-` / `cap-` / `be-` / `res-` / `mx-` | agents page, capability matrix, backend picker | `agents-page.tsx` |
| `tl-` | task timeline rail/nodes/cards | `timeline.tsx` |
| `pj-` / `home-` / `sec-h` / `org-tile` / `store-strip` | home | `home-page.tsx` |
| `cmdk-` | ⌘K palette | `command-palette.tsx:105` |
| `pev-` / `act-` | activity + audit event rows | `activity-page.tsx:114` |
| `modal-` / `confirm-` / `page-overlay` | the three dialog shells | `mini-modal.tsx:38` |
| `field` / `flabel` / `fhint` / `pick-chip` / `mini-seg` / `seg` / `fchip` | shared form + control vocabulary | app.css:1570 |

There is **no** `org-`-prefixed CSS class — every `org-*` grep hit is a module path or an identifier.

---

## 9. Deliberate divergences from the UX spec

Source: `planning/planning-artifacts/ux-design-specification.md` (952 lines). The spec already
carries inline "Superseded" notes for the first three; the rest were found by comparison.

| spec says | build does | status |
|---|---|---|
| Palette of graphite / fog / cool gray / **steel blue** (§Color System, `:328-346`) | Bright Miro-inspired white canvas, `--blue #5b76fe`, pastel semantic surfaces, a violet agent tint, two radial gradients washing the page background | **Superseded in the doc** (`:348`). Principles still bind: colour never alone, semantics stable across themes, contrast-constrained ladder |
| **IBM Plex Sans / IBM Plex Mono** (`:354`, `:366-367`) | Manrope (display) / Noto Sans (body) / JetBrains Mono | **Superseded in the doc** (`:373`). The "mono used intentionally" and scan-first rules are honoured |
| **8px base spacing with 4px sub-steps**, 12-column grid (`:379-388`) | No spacing tokens at all; per-component rem values; CSS grid/flex sized to content | **Superseded in the doc** (`:381`) — a retrofit would touch every surface for no user-visible gain |
| "Three capability modes" / review-first mobile | One capability mode, "the same surface reflowed"; nothing gated on viewport or `matchMedia` | **Amended in the doc** 2026-07-25 and again 2026-07-28 |
| Breakpoints cluster at 1400/1300/1100/1080/1000/900/760 (`:879`) | Those **plus 720** (the mobile rail overlay, F15-18) and a `min-width: 900px` for the login two-column | Undocumented addition — worth folding into the spec |
| "Skeletons or placeholder structures are preferable to large spinners" (`:856`) | No skeletons anywhere. Loading is a 2px top progress bar (220ms delayed) plus `aria-busy` on individual controls and `.ico.spin` | **Divergence.** Justified by SSR + revalidation (the page shape is already on screen and only changes), but the spec's guidance is unmet as written |
| "Toasts for short-lived acknowledgement, not durable task truth" (`:783`) | Honoured — every consequential action also writes a timeline event and an audit row; toasts are 2.6s and never the sole record | Aligned |
| "One primary action per decision surface at most" (`:754`) | Honoured, and pushed further: the **review queue deliberately has no primary action** (R15-11) because acceptance is verdict-gated and can refuse | Aligned, with a documented owner ruling |
| "Board is the attention-routing surface … empty states orient toward the next action" (`:853`) | Narrowed by **R15-10**: only the entry column teaches, and only when the whole board is empty; every column goes bare the moment one task exists | Deliberate narrowing (P13-D-34 guarded against repeating one explanation five times beside real work) |
| "clear screen-reader announcements for consequential state changes" (`:901`) | Toast host is `role="status" aria-live="polite"`; the live-paused chip is `role="status"`; the archived banner is `role="status"`. But **board drag results, stage moves and drop targets announce nothing** — the dnd-kit `Accessibility` plugin is off and no live region replaced it | **Partial divergence**, and the most actionable a11y gap in the app |
| "touch targets large enough for tablet and mobile review flows" (`:900`) | `.btn` min-height 38px, `.icon-btn` 38px — fine. But `.fm-act` 26px, `.rev-x` 26px, `.stg-x` 24px, `.own-x` 20px, `.tag button` 16px, `.ag-add` 22px are all under the 24×24 minimum of WCAG 2.2 **2.5.8** (which the "2.2 AA" claim includes) | **Divergence**; axe does not check 2.5.8, so the gate misses it |

Also worth knowing: `planning/discovery-2026-07-28-pass15/UX-ASSESSMENT.md` is the most recent
holistic judgement of the UI ("coherent — unusually so"), and names the five habits worth protecting:
empty states that teach, counts that name their scope, refusals rendered as copy rather than disabled
buttons, honesty over reassurance, and the two-surface mental model taught in subtitles. Any change
to this UI should be checked against those five.
