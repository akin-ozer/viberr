# UI-INVENTORY — Viberr current state (pass 21)

> **Verified 2026-08-19 against `main @ce2bc9e`** (worktree
> `.claude/worktrees/viberr-app-inspection-1fe423`, branch
> `claude/viberr-app-inspection-1fe423`, identical to `main`).
> Supersedes `planning/discovery-2026-08-14-pass20/reference/UI-INVENTORY.md`,
> which was anchored to `main @b97ad02` — i.e. **before** the pass-20 branch was
> merged. `b97ad02..ce2bc9e` is 27 commits and **835 changed files**, so almost
> every line anchor in the pass-20 doc is stale. See §11 for the itemised
> corrections.

This document is written to be usable **without any other context**: every
surface names its files, its exports, its action intents and its load-bearing
copy. Paths are relative to the repository root unless stated otherwise.

**Stack (from `package.json`):** React 19.2, **React Router 8.3** (framework
mode, `@react-router/dev` route config), Vite 8.2, TypeScript 7.0.2,
`@dnd-kit/react` + `@dnd-kit/dom` **0.5.0**, `lexical` + `@lexical/react` +
`@lexical/utils` **0.49.0**, `react-markdown` 10 + `remark-gfm` 4, `better-auth`
1.6.25, `zod` 4. **No Tailwind, no CSS framework, no component library.**

---

## 1. Routes → features

*Verified 2026-08-19 against `ce2bc9e`.*

`app/routes.ts` — **69 lines**, `satisfies RouteConfig` from
`@react-router/dev/routes`. **One route added since pass 20**: the pathless
`layout("routes/palette-shell.tsx", …)` wrapper (F20-30) at `:21-26`, which
wraps `/org/settings`, `/profile` and `/notifications` without changing their
URLs.

`L` = exports `loader`, `A` = exports `action`, `EB` = exports `ErrorBoundary`.
"Server modules" names the query/action layer the route delegates to, not the
full import list.

### 1.1 Top-level routes

| `routes.ts` | URL | Module (lines) | L/A/EB | Renders / server modules |
| --- | --- | --- | --- | --- |
| `:4` | `/` (index) | `routes/_index.tsx` (225) | L A | Home — project list, greeting, `SettingsPanel`, `StoreStrip`, bell, ⌘K · `home-query.server`, `project-create.server`, `rescan.server`, `rebuild.server`, `data-root-lock.server`, `single-flight.server`, `user-prefs.server`, `notifications.server`. **5 intents**: `pin`, `view`, `rescan`, `rebuild-projections`, `create-project` |
| `:5` | `/login` | `routes/login.tsx` (609) | L A | Login (local-first; OAuth buttons at `:271-343`) · `login.server`, `oauth-providers.server`, `csrf.server`, `theme-cookie.server`. **2 intents**: `login`, `set-password` |
| `:6` | `/logout` | `routes/logout.tsx` (38) | L A | Logout action (loader redirects) |
| `:11` | `/api/auth/*` | `routes/api.auth.$.ts` (17) | L A | better-auth handler (splat, no UI) |
| **`:21-26`** | **(pathless)** | **`routes/palette-shell.tsx` (34)** | — | **NEW — F20-30.** Mounts `useCommandPaletteShortcut` + `CommandPalette` around the three top-level authenticated surfaces that render OUTSIDE the workspace layout. Deliberately does **not** wrap Home or the workspace (both mount the shortcut themselves — nothing double-registers) |
| `:23` | `/org/settings` | `routes/org.settings.tsx` (588) | L A | Instance settings, admin-only, **4 tabs** · `org-view.server`, `connections.server`, `org-users.server`, `user-admin.server`, `resources.server`, `store-files.server`, `gagents.server`, `oauth-providers.server`, `oauth-credential-test.server`. **35 intents** (§6) |
| `:24` | `/profile` | `routes/profile.tsx` (231) | L A | Profile & preferences, in a `PageOverlay` · `profile-query.server`, `profile-actions.server`, `theme-cookie.server`, `csrf-result.server`. **6 intents**: `identity`, `set-notif`, `set-motion`, `set-tl-default`, `change-password`, `github-disconnect` |
| `:25` | `/notifications` | `routes/notifications.tsx` (133) | L | Full notifications page, in a `PageOverlay` · `notifications.server` |
| `:29` | `/notifications/read` | `routes/notifications.read.tsx` (50) | L A | Mark-read fetcher target (no UI) |
| `:30` | `/prefs/theme` | `routes/prefs.theme.tsx` (45) | L A | Theme cookie action + `headers` export (no UI) |
| `:32` | `/resources/events` | `routes/resources.events.ts` (189) | L | SSE stream · `sse-broker.server` (no UI) |
| `:35` | `/resources/run-log` | `routes/resources.run-log.ts` (92) | L | Run-log tail · `run-service.server`, `run-store.server` (no UI) |
| `:37` | `/resources/health` | `routes/resources.health.ts` (139) | L | Ops health probe — `{ ok, projections, watcher }` + lock holder, `disk-space`, `maintenance`, `build-info` (no UI; **no in-app consumer**) |
| `:40` | `/resources/search` | `routes/resources.search.ts` (25) | L | ⌘K palette query · `command-search.server` (no UI) |
| `:43` | `/resources/model-catalog` | `routes/resources.model-catalog.ts` (31) | L | Model/effort catalog per backend, fetched by the agent-profile modal (no UI) |
| `:46` | `/resources/session-export` | `routes/resources.session-export.ts` (75) | L | Bash installer download carrying a run's provider transcript (no UI) |
| `:50-53` | `/projects/:slug/tasks/:key/attachments/:file` | `routes/task-attachment.ts` (71) | L | One browser-produced attachment as raw bytes. Deliberately OUTSIDE the workspace layout. `requireUser` + `requireProjectMember(…, "view task attachments")`, traversal → plain 404, 50 MB cap → 413, `nosniff` + `content-security-policy: sandbox; default-src 'none'`, HTML/SVG never inline |
| `:56` | `/projects` | `routes/projects.tsx` (9) | L | Alias → Home (N5, not a 404) |
| `:58` | `/projects/:slug` | `routes/project.tsx` (283) | L | **Layout route**: workspace shell · `board-query.server`, `decisions.server`, `policy-violations.server`, `review-queue.server`, `notifications.server`. Also exports `ArchivedBanner` (`:165`) |

### 1.2 Children of `/projects/:slug` (rendered in `project.tsx`'s `<Outlet>`)

| `routes.ts` | Path | Module (lines) | L/A/EB | Server modules / intents |
| --- | --- | --- | --- | --- |
| `:59` | index | `routes/project._index.tsx` (7) | L | Redirect to the default project view |
| `:60` | `board` | `routes/project.board.tsx` (127) | A | dnd-kit board · `task-actions.server`, `project-authority.server`, `rescan.server`. **3 intents**: `create-task`, `reorder`, `rescan`. *(The loader lives on the layout.)* |
| `:61` | `review` | `routes/project.review.tsx` (72) | L | Review queue · `review-queue.server`, `review-acceptance-authority.server`, `board-query.server` |
| `:62` | `agents` | `routes/project.agents.tsx` (245) | L A | Agents · `agents-query.server`, `agent-profile-actions.server`, `agent-deployments.server`, `resource-catalog.server`, `runtime-registry.server`. **4 intents**: `create-profile`, `deploy-profile`, `update-profile`, `delete-profile` |
| `:63` | `policy` | `routes/project.policy.tsx` (95) | L A | Policy · `policy-query.server`, `policy-actions.server`. **2 intents**: `set-role`, `set-boundary` |
| `:64` | `github` | `routes/project.github.tsx` (224) | L A | GitHub · `github-query.server`, `github-actions.server`, `freshness-policy.server`, `audit-query.server`, `project-writer.server`. **4 intents**: `reconcile`, `grant-scope`, `set-credential`, `clear-credential` |
| `:65` | `activity` | `routes/project.activity.tsx` (81) | L | Activity feed · `activity-feed.server` |
| `:66` | `settings` | `routes/project.settings.tsx` (225) | L A | Project settings · `settings-query.server`, `settings-actions.server`, `github-actions.server`, `project-authority.server`. **14 intents** (§7) |
| `:67` | `tasks/:key` | `routes/project.task.tsx` (990) | L A **EB** | Task detail — the largest route. **25 intents** (§5). `ErrorBoundary` at `:963` |

### 1.3 Error boundaries

Exactly **two** in the whole app:

- `app/root.tsx:183` — the app-wide splash (`<main className="app-splash">` at
  `:204`, styled `app.css:3110-3129`). 404 → "Page not found"; other statuses →
  `Error ${status}`; a thrown string wins over `statusText`; DEV-only stack in a
  `<pre className="mono">`; "Back to home" link.
- `app/routes/project.task.tsx:963` — `data-screen-label="Task detail — not
  found"`, "Task not found" / "Something went wrong", "Back to board".

**`project.tsx` still has no `ErrorBoundary`** — a 404 under the workspace
layout bubbles all the way to the root splash. There is **no `HydrateFallback`**
anywhere.

### 1.4 Canonical screen list (`data-screen-label`)

Every addressable surface stamps a `data-screen-label`; this is the list e2e and
screenshot tooling keys on.

`Home — project selection` · `Empty state` · `Pinned projects` · `All projects` ·
`Archived projects` · `Project card — <name>` · `Project row — <name>` ·
`Settings` (Home's org panel) · `Store strip` · `New project modal` ·
`Instance settings` · `Settings — GitHub connections` · `Settings — Users &
access` · `Settings — Sign-in & SSO` · `Settings — Agent resources` ·
`Files — <title>` · `Board` · `Review queue` · `Agents` · `Policy` · `GitHub` ·
`Activity` · `Settings` (project) · `Task <KEY>` · `Task detail — not found` ·
`Profile & preferences` · `Notifications` · `Notifications popover` ·
`Command palette` · `Login` · `Login — set new password` ·
`Accept completion dialog` · `Archive task dialog` · `Release ownership dialog` ·
`Packet archive dialog` · `Packet discard dialog` · `<label> — overlay`
(`PageOverlay`) · plus `MiniModal`'s per-modal `screen || title`.

---

## 2. The shell

*Verified 2026-08-19 against `ce2bc9e`.*

### 2.1 Workspace shell — `app/routes/project.tsx` (283)

`<div className="app" data-rail-open>` → `<SkipLink />` (`:222`) → `<Rail …>`
(`:223`) → a decorative `<div className="rail-scrim" aria-hidden>` (`:245`) →
`<main className="main" id="main-content" tabIndex={-1}>` (`:253`) → `<Topbar …>`
(`:254`) → `<ArchivedBanner …>` (`:275`, only when the project is archived) →
`<Outlet />` (`:279`). Live updates via `useLiveUpdates([project, task?, user])`
(`:202`), feeding `livePaused` / `onReconnect` into the topbar. Mobile `railOpen`
state resets on every pathname change (`:212`).

The loader (`:70`) is the **membership gate**: a non-member gets
`throw data("No project at projects/<slug>.", { status: 404 })` — byte-identical
to an unknown slug (R15-4), with `orgAdminOverride` set when an org admin is
viewing a project they do not belong to. It returns `board`, `myRole`,
`taskCount` / `reviewCount` (both counted over **live**, non-archived tasks),
`violations`, and the newest 100 notifications.

`ArchivedBanner` (`:165`) is `<div className="archived-banner" role="status">`:
*"This project is **archived** — it's read-only. Timelines and audit stay
visible;"* then either *"restore it from **Settings → Danger zone** to make
changes."* or *"a **project admin** can restore it to make changes."*

### 2.2 `app/features/shell/`

| File | Lines | What it is |
| --- | --- | --- |
| `nav.ts` | 70 | `WORKSPACE_NAV` (`:20`) — the 7 views in order: `board` "Board", `review` "Review queue", `agents` "Agents", `policy` "Policy", `github` "GitHub", `activity` "Activity", `settings` "Settings". Plus `workspaceViewFromPathname` (`:35`, `tasks/*` counts as `board`), `boardHref` (`:57`, preserves board filter/search params only while already on that board), `workspaceViewLabel` (`:68`) |
| `rail.tsx` | 86 | `Rail` — `<nav className="rail" aria-label="Primary">` (`:32`). Project switcher `Link` → `/` (`:33`), `WORKSPACE_NAV` items as `Link`s with `aria-current="page"` from `activeView` (`:67`), live `.count` badges on `board` (`:71`), `review` (`:72`), `settings` (`.count.violations`, `:75`, only when >0) |
| `topbar.tsx` | 197 | `Topbar` — rail toggle (mobile, `:94`, `aria-expanded`) · brand `Link` → `/` (`:105`) · `<nav className="crumbs" aria-label="Breadcrumb">` (`:116`, `aria-current="page"` at `:133`/`:140`) · **org-admin override pill** (`:153`, `pill risk sm`, full sentence in `aria-label` at `:155`) · **`livePaused` retry pill** (`:163-176`) · search button (`:177`) · `<TopBell>` (`:192`) · `<UserMenu>` (`:193`) · `<CommandPalette>` (`:194`) |
| `top-bell.tsx` | 202 | `TopBell` — bell button + **declarative non-modal `<dialog open>`** popover (`:127`, `data-screen-label="Notifications popover"`), `BELL_LIST_CAP = 100` (`:29`, cap notice `:159`), mark-all-read, `.bell-badge` pulse keyed on `unread` (`:195`). Shared by the workspace topbar AND Home |
| `command-palette.tsx` | 233 | The ⌘K palette — see §9.14 |
| `use-command-palette.ts` | 36 | `useCommandPaletteShortcut(onOpen)` — the app's ONE ⌘K/Ctrl-K binding on `window`; excludes `altKey`; `onOpen` held in a ref |
| `user-menu.tsx` | 208 | Avatar menu: theme, profile, switch project, sign out (`aria-expanded` at `:201`) |
| `route-pending-bar.tsx` | 63 | Top progress bar during route navigation; mounted in `root.tsx:173` |
| `theme-preference.ts` | 11 | `"light" | "dark" | "system"` type + cookie name |
| `command-search.server.ts` | 230 | Palette query across the viewer's VISIBLE projects |
| `csrf-result.server.ts` | 40 | Shared CSRF failure shape for fetcher routes |

### 2.3 Root — `app/root.tsx` (225)

- `:1-12` — 11 `@fontsource` imports (Noto Sans 400/500/600/700, JetBrains Mono
  400/500/600, Manrope 500/600/700/800) then **`import "./app.css"` at `:12` —
  the only stylesheet import in the app**.
- `:40` `links` — one entry, the SVG favicon. **No `meta` export.**
- `:56` `export const middleware = [requestContextMiddleware]` — one correlation
  id per request.
- `:58` `loader` → `{ theme, motion, csrf }` (theme cookie; better-auth rolling
  session renewal captured into `headers` at `:88`).
- `:103` `themeBootScript(preference)` — pre-paint inline script; the
  `viberr_theme` cookie is **authoritative** over the SSR value, `"system"`
  resolves against `prefers-color-scheme` and live-follows OS changes.
- `:116` `Layout` — `<html lang="en" data-theme data-motion suppressHydrationWarning>`.
- `:149` `App` — `<ToastProvider>` wrapping `<RoutePendingBar />` + `<Outlet />`.
- `:183` `ErrorBoundary`.

`app/entry.server.tsx` (149): top-level `await bootServer()` (`:21`),
`streamTimeout = 5_000` (`:23`), `handleError` swallowing aborts and
route-not-found 404s (`:34`), `HEAD` short-circuit (`:81`).

---

## 3. Home — `/`

*Verified 2026-08-19 against `ce2bc9e`.*

`app/routes/_index.tsx` (225) + `app/features/home/`.

| File | Lines | Contents |
| --- | --- | --- |
| `home-page.tsx` | 315 | `HomePage` — `.home[data-density="comfortable"][data-screen-label="Home — project selection"]`. Order (`:231-315`): `<SkipLink />` (`:238`) → `HomeTopBar` (`:239`, brand/search/bell/avatar + `livePaused` reconnect) → `<main className="home-shell" id="main-content">` → `HomeHero` (`:253`, greeting, project count, running/waiting tallies, grid/list toggle, "New project") → `EmptyHero` **or** `ProjectSections` (`:266`/`:270`) → `SettingsPanel` (`:281`) → `StoreStrip` (`:282`) → `RebuildConfirm` / `NewProjectModal` / `CommandPalette` |
| `home-sections.tsx` | 646 | `HomeHero`, `EmptyHero` (`:244`), `ProjectSections` (Pinned `:320` / All `:329` / Archived `:392`), `SettingsPanel` (`:461`), **`StoreStrip` (`:533`)** with the F18-5b lock-holder strip (`lockHolder` prop `:539`, admin gate, "Writer: pid {pid} on {hostname}." at `:573`), `RebuildConfirm` (`:613`). Grid/list toggle is `.seg[role="group" aria-label="View"]` with `aria-pressed` (`:217`/`:226`) |
| `project-cards.tsx` | 273 | `ProjectCard` (`:178`, `.pj-card`) and `ProjectRow` (`:233`, `.pj-row`), each stamping `data-screen-label="Project card|row — <name>"`; pin star, stage tallies, readiness pills |
| `new-project-modal.tsx` | 623 | `NewProjectModal` (`:452` panel, `:545` `data-screen-label`) — name/prefix, GitHub connection owner picker (`.pick-chip aria-pressed` `:136`), and the **agent policy preset** trio strict/balanced/auto (`:315`/`:324`/`:333`). UX19-14: with zero connections it names *who* can add one instead of linking a member into an org-settings 403 |
| `home-query.server.ts` / `project-create.server.ts` / `project-name.ts` | 364 / 423 / 27 | Loader projection, creation pipeline, slug rules |

---

## 4. Project board — `/projects/:slug/board`

*Verified 2026-08-19 against `ce2bc9e`.*

`app/routes/project.board.tsx` (127, action only) +
`app/features/board/board-page.tsx` (**2064**), `board-dnd.ts` (51),
`board-filters.ts` (227).

### 4.1 dnd-kit — whole-card drag, server-authoritative

- Imports `DragDropProvider`, `useDroppable`, `useSortable`
  (`@dnd-kit/react`, `@dnd-kit/react/sortable`), `OptimisticSortingPlugin`
  (`@dnd-kit/dom/sortable`), sensors/constraints from `@dnd-kit/dom`
  (`board-page.tsx:16-32`).
- **`BOARD_SENSORS` (`:139-160`)** — the whole card is the drag surface, **no
  grip handle**:
  - `PointerSensor.configure({ preventActivation })` returns true only for
    `button, input, select, textarea` (`:144-150`), so the card face (a `Link`)
    still lifts and only real controls opt out.
  - Mouse: `Distance({ value: 5 })`. Touch: `Delay({ value: 250, tolerance: 5 })`
    so column scrolling is never hijacked (`:154-157`).
  - `KeyboardSensor` is registered but the accessible move path is the
    `StageMenu`, not drag.
- **`DragDropProvider` is mounted only in `group === "stage"` mode** (`:1993`);
  list mode has no drag.
- **`BOARD_PLUGINS` (`:167-169`) = `defaultPreset.plugins` minus
  `Accessibility`** — the plugin's `role="button"` wrapper would nest the task
  link and StageMenu inside an interactive control (axe `nested-interactive`,
  serious). D9's live region and D19's arrow traversal replace it.
- **Per-card `useSortable` (`:480-490`) removes `OptimisticSortingPlugin`** and
  adds `Feedback.configure({ feedback: "clone" })`. Optimistic sorting is
  deliberately **OFF** — this is the second half of "server-authoritative".
- Columns are `useDroppable({ id: \`stage:${stage.id}\`, collisionPriority: 1 })`
  (`:649`) so empty lanes and blank space accept drops; card collisions (priority
  2) win.
- Handlers: `onDragStart` (`:1550`), `onDragOver` (`:1558`, `stage:` prefix →
  column end, card id → `beforeKey`), `onDragMove` (`:1577`, pointer-midpoint
  refinement — top half before this card, bottom half before `nextKey`),
  `onDragEnd` (`:1598`).
- **Server-authoritative**: `board-dnd.ts`'s `resolveBoardDrop(state)` is a pure
  function that returns `{ to, beforeKey } | null` and **never reorders board
  state**. A slot that vanished under an SSE revalidation degrades to
  "end of column" rather than submitting an unplaceable reference; a no-op drop
  returns `null`. The action intent is `reorder`.
- **`aria-live` announcements (pass-20 D9)** — `SR_ONLY` style constant at
  `:90-105` (inline because `app.css` has no visually-hidden utility, and it
  must stay in the DOM rather than `display:none`). `announceMove` at `:1539`
  speaks `Move requested: {KEY} to {stage}.`, called from `onDragEnd` (`:1626`)
  and from the StageMenu path (`:1639`). The **outcome** effect (`:1665-1682`)
  then re-announces the server's own sentence on success (`:1672`) or
  `Move refused: {error}` on failure (`:1680`) — which is what covers the
  server's 409 on an off-boundary move. The region is
  `<div style={SR_ONLY} role="status" aria-live="polite">` at **`:1945`**, the
  first child of `.board-wrap`.
  Cards carry **no** ARIA drag decoration on purpose (see `BOARD_PLUGINS`
  above). Keyboard traversal of the board is the roving arrow handler
  `onCardKeyDown` (`:1795-1866`), which reads lanes back off the DOM via
  `data-board-lane` / `data-board-card` and re-issues Enter/Space as `.click()`;
  `useRovingStageMenu` (`:188`) keeps one tab stop rather than 2N.

### 4.2 Filters and layout

`FILTERS` (`:1143-1169`), rendered by `FilterBar` as `.fchip` buttons with
`aria-pressed` (`:1312`):

| id | label | selects (`matchesBoardFilter`, `board-filters.ts:47`) |
| --- | --- | --- |
| `all` | All tasks | everything not archived |
| `human` | Waiting on me | `waitingOnMe === true` (member-scoped, R8-3) |
| `agent` | Agent working | `waiting === "agent"` |
| `risk` | Blocked or waiting | blocked / input_required / inconsistency risk / failing validation / urgent / rejected PR |
| `quiet` | No activity | server-derived `quiet === true` (never re-derived client-side — SSR/hydration would disagree) |
| **`continuity`** | **Degraded continuity** | **`continuity === "degraded"` — pass-20 D4.** Its own chip, not folded into "Blocked or waiting": a task can lose continuity while otherwise healthy |
| `archived` | Archived | `archived === true` |

`continuity` and `archived` are **rarity-gated** — the chip renders only when the
project has such a task or the filter is already on (`:1300-1306`). Tallies
render on `human`, `quiet`, `continuity`, `archived`.

Layout toggle is `.seg[role="group" aria-label="Board layout"]` stage/list with
`aria-pressed` (`:1231`/`:1240`). Board state lives **only in URL params** — no
sessionStorage (see `nav.ts:44-56`).

### 4.3 Acceptance on the board

Pass 20 collapsed the board's bespoke dialog into the shared ceremony:
`AcceptOnBoardConfirm` (`:924`) is now a thin adapter that renders **the one
shared `AcceptConfirm`** imported from `~/features/task-detail/accept-confirm`
(`:50`, rationale `:897-923`) in
`ceremony={{ mode: "stage-move", label: "<from> → <terminal>" }}` (`:967`).
Refusal text comes from `boardAcceptRefusal` (`:875-895`), which layers
archived → closed-PR → the stage-boundary sentence → `blockReason` → open-packet
→ conflicting-PR.

Two triggers set `pendingAccept` (state at `:1521`): a drag into the final stage
(`:1617-1624`) and the StageMenu keyboard move (`:1656`). The target task is
re-read from `allTasks` on every render rather than captured (`:1722`); a lookup
that misses clears the state and pushes an **error** toast — *"`{taskKey}` left
the board before its acceptance was confirmed — nothing was accepted."*
(`:1733-1740`).

Other board pieces: `StageBoard` columns via `useDroppable` (`:649`),
`ReadinessPill` / `ValidationPill` on cards (`:538`), the archived card's
replacement chip (`:329`), `OrphanBanner` (`:1990`, `role="status"` at `:1980`).

---

## 5. Task detail — `/projects/:slug/tasks/:key`

*Verified 2026-08-19 against `ce2bc9e`.*

`app/routes/project.task.tsx` (990) + `app/features/task-detail/` (18 modules).
The largest surface in the app.

### 5.1 Route

- `loader` `:106` — `requireVisibleProject` (`:115`), notification read-marking
  when the navigation is a task view (`:139-149`), timeline slice
  (`:150-153`), **`runsVisible`** membership computation (`:173-176`) with a
  withheld projection at `:183-199`, `resolveAcceptanceAffordance` (`:274-278`),
  two-row GitHub freshness (`:309`, `:320`), and **attachments gated on
  `runsVisible`** (`:259-261`).
- `action` `:358`, switch at `:375`. **25 intent strings** (`archive-task` and
  `restore-task` share one body):

  `comment` `:376` · `update-goal` `:409` · `resolve-packet` `:417` ·
  `request-maintainer-decision` `:477` · `complete-merge` `:501` ·
  `accept-completion` `:513` · `deliver-review` `:543` ·
  `archive-task`/`restore-task` `:568-569` · `force-accept` `:580` ·
  `owner-take` `:590` · `owner-assign` `:602` · `owner-release` `:619` ·
  `transition` `:636` · `run-interrupt` `:660` · `assign-specialist` `:677` ·
  `run-specialist` `:691` · `assign-reviewer` `:707` · `run-reviewer` `:722` ·
  `remove-reviewer` `:741` · `apply-recommendation` `:754` ·
  `dismiss-recommendation` `:768` · `run-operator` `:780` ·
  `schedule-action` `:838` · `cancel-schedule` `:868` · default `:887`.

  ⚠️ The route's own header comment (`:97-103`) lists only 15 — it is stale.
- The page is remounted on task switch via `key={loaderData.task.key}` (`:928`);
  `attachmentsBase` built at `:931`.

### 5.2 Page composition — `task-detail-page.tsx` (895), `TaskDetailPage` at `:95`

`.detail[data-screen-label="Task <KEY>"]` (`:532`).

**`.detail-main`**, in order:

| Line | Component | Notes |
| --- | --- | --- |
| `:540` | `TaskHero` | key/title/stage/readiness/validation + inline goal editor |
| `:551` | `LiveRunPanel` | only when `runtime.length > 0` |
| `:561` | `DiagnosticsPanel` | `<h2>Diagnostics</h2>` (`task-main-sections.tsx:55`); returns `null` when empty |
| **`:569`** | **`ContinuityRecoveryPanel`** | **above** the packet — "degraded continuity is execution TRUTH, so it sits with Diagnostics, ahead of the decision it may explain" (`:563-568`) |
| `:579` | `DecisionPacket` | only when `task.packet` |
| `:609` | `OperatorRecommendations` | the operator card |
| `:617` | `ExecutionSection` | wraps `ExecutionProfile` |
| `:643`/`:654` | `ScheduledActions` or the collapsed "Schedule a re-run" button | C8 |
| `:665` | `AgentLogsPanel` | `runtime.length > 0 && runsVisible` |
| `:682` | member gate panel | "Raw agent output, wire envelopes and provider session ids are limited to project members. The run summary above is public to signed-in users." |
| `:696` | `AttachmentsPanel` | only when `attachmentsBase` is set |
| `:707` | `Timeline` | |

**`.detail-side`:** `GithubTrace` (`:727`) → `CurrentStatePanel` (`:743`) →
`PolicyPanel` (`:760`).

**Dialogs (conditional, at the end):** `AcceptConfirm` (`:769`),
`ArchiveConfirm` (`:831`), `ReleaseConfirm` (`:844`), `ConfirmDialog` interrupt
(`:860`), `ConfirmDialog` dismiss-recommendation (`:875`).

**Diagnostics and readiness.** `ReadinessPill` (`app/ui/pill.tsx:98`) has exactly
**four** render sites, and they are two different things:

- `board-page.tsx:538` (card) and `:791` (list row) — the task's own
  `displayReadiness`, suppressed on archived cards in favour of `ArchivedPill`.
- `task-main-sections.tsx:187` — the same `displayReadiness` on the task hero,
  guarded by `!archived` (UXO-1).
- `task-main-sections.tsx:67` — **one pill per diagnostic**, rendered from that
  finding's `readinessEffect` (pass-18 G2: a diagnostic's pill *is* its readiness
  effect, so the panel and the hero cannot disagree). `readinessEffect` is a
  per-diagnostic field derived server-side by `readinessEffectOf`
  (`app/server/interpretation/diagnostics-policy.server.ts:28`) and consumed by
  `task-query.server.ts`; a diagnostic with a `null` effect renders a neutral
  `heads-up` pill instead.

### 5.3 Decision-packet UI — `decision-packet.tsx` (879)

Exports `DELIVER_LABEL = "Deliver branch & open PR"` (`:40`), `observationLabel`
(`:80`), `observationValue` (`:93`), `PacketArchiveDisclosure` (`:109`),
**`DecisionPacket` (`:384`)**. Private: `PacketArchiveConfirm` (`:138`),
`PacketDiscardConfirm` (`:292`).

There is **no `KIND_LABEL` map** here — behaviour branches per `o.kind`. The
canonical union is `PACKET_OPTION_KINDS` in
`app/schemas/task-file.schema.ts:74-101`, now **10 kinds**:
`accept_completion`, `request_edit`, `block_on_policy`, `hold_runtime_debug`,
`redirect`, `retry_other_backend`, `edit_goal`, `archive_task`,
**`discard_branch`** (pass-20 F20-6, `:99`), `custom`.

- **Options** — `role="radiogroup" aria-label="Decision options"` (`:594`) with
  its own arrow-key roving (a ref array, not `roving-radio.ts` — UI-44); each
  option is a `role="radio"` button (`:625`) with `aria-checked`,
  `aria-disabled`, roving `tabIndex`; blocked options dim to `opacity: .55`.
  `deletes branch` blocked-pill at `:672`; `operator pick` vs `recommended` pill
  at `:686`.
- **Per-kind authority gates** (`:504-541`) with these refusal strings:
  `"Accepting completion is reserved for maintainers and this task's owner."` ·
  `"Editing the goal is reserved for maintainers and admins."` ·
  `"Archiving is reserved for maintainers and admins."` ·
  `"Discarding the branch is reserved for maintainers and admins."`
- **Confirm never resolves directly for two kinds:** `archive_task` →
  `PacketArchiveConfirm` (`:810`), `discard_branch` → `PacketDiscardConfirm`
  (`:816`). `accept_completion` is intercepted one level up by the page and
  routed through `AcceptConfirm` mode `"packet"`.
- The primary button's visible label is always `"Confirm decision"`; the
  accessible name is `Confirm decision: <option title>` (`:782-830`). On a role
  refusal it stays focusable with `aria-disabled` +
  `aria-describedby="pkt-block-reason"`.
- **F20-18 escalation** (`:755-778`) renders only for the contributor-owner
  whose *every* option is above their tier: "Every option here needs maintainer
  or admin authority — you own {taskKey} and raised this decision, but settling
  it is above your role." + **Send to a maintainer** (intent
  `request-maintainer-decision`).
- `PacketDiscardConfirm` (`:292`, `data-screen-label="Packet discard dialog"`) —
  "Discard this task's workspace branch?"; **Deletes**: the *local* branch and
  commits only there; **GitHub**: "Nothing on GitHub changes — this branch was
  never pushed."

### 5.4 The operator card — `operator-recommendations.tsx` (143)

`.panel.op-recs`, `<h2>Operator recommendations</h2>`, right pill `{n} pending`.
`KIND_ICON` (`:38`) and **`KIND_LABEL` (`:48-63`)** over the 7-kind union:

| kind | label |
| --- | --- |
| `assign_specialist` | **Delivering agent** (UXA-6 — was "Specialist") |
| `assign_reviewer` | Reviewer |
| `run_specialist` | **Run delivering agent** |
| `run_reviewer` | Run reviewer |
| `transition` | Stage |
| `accept_completion` | Completion |
| `delivery` | Delivery |

The panel owns **no fetcher and no confirm state** on purpose (docstring
`:12-17`): Apply routes up to the page's `AcceptConfirm`; Dismiss routes up to
the page's `ConfirmDialog`.

**The pass-20 autonomy gate mirror (F20-9 / D1) is NOT in this file.** It has two
halves:

1. `execution-profile.tsx` `OperatorRunControl` (`:597`) — the
   `<select aria-label="Operator autonomy">` renders `Full autonomy` **only when
   `configuredAutonomy === "full"`** (`:666-668`); otherwise it prints
   *"Project policy: supervised — raise it on the operator profile."*
   (`:673-675`).
2. `agents-page.tsx:643-655` — on the **operator card only**, when
   "Accept completion into Done" is granted while "Transition a task to Done"
   sits under *Reserved for humans*, the card borrows the Policy page's single
   canonical exception sentence (`TRANSITION_TO_DONE_EXCEPTION`,
   `policy-data.ts:70`) rather than restating it, so the two surfaces cannot
   drift. Rendered as `.cap-exception` (`agents-page.tsx:748`).

### 5.5 The acceptance ceremony — `accept-confirm.tsx` (436)

**One dialog, six modes** (`AcceptCeremonyMode`, `:38`):
`accept` · `force` · `complete-merge` · `apply-recommendation` · `packet` ·
`stage-move`. Rationale in the file header (`:7-35`): ruling 20 says *every*
accept confirms, and four indirect writers used to merge silently.

- `data-screen-label="Accept completion dialog"`; `role="alertdialog"` on a
  native `<dialog>` via `useDialog(onCancel)` (`:163`).
- Headings (`:76-93`): "Force-accept this completion?" / "Run the merge now?" /
  "Apply this recommendation?" / `Moving to {terminal} accepts this completion` /
  "Accept this completion?".
- Rows: **Merges** (`:260-316`, four branches including the pass-20 F20-6
  `noPullRequest` branch — *"**Nothing to merge yet.** … Accepting re-checks
  `branch` on GitHub: if it carries no commits the task closes as **completed
  with no changes**; if it carries work the acceptance is refused and says how
  many commits."*), **Revision** (`:317`), **Merge head** drift (`:333`, R17-1),
  **Verdict** + `verdictSatisfiedBy` (`:351`, R19-B human GitHub approval),
  **Skips** (force only, `:371`), **Blocked** (`:386`).
- Confirm labels (`:408-431`): `Force-accept {KEY}` / `Merge PR #{n} into
  {defaultBranch}` / `Run the merge` / `{Apply|Move|Accept} → {terminal}[ &
  merge]`. Cancel is `"Not yet"`.

The two sibling ceremonies use the identical contract:

- `archive-confirm.tsx` (141) — `ArchiveConfirm` (`:17`),
  `data-screen-label="Archive task dialog"`, rows **Now / After / Withdrawn**,
  confirm `Archive {KEY}`, cancel "Keep on the board".
- `release-confirm.tsx` (196) — `ReleaseConfirm` (`:25`),
  `data-screen-label="Release ownership dialog"`, rows **Owner / Open now /
  After**, hand-off chips filtered to `own-task`-capable members, confirm
  `Release` / `Release {firstName}`.

### 5.6 The composer — Lexical, plain text only

`comment-composer.tsx` (304), `CommentComposer` at `:175` (a `forwardRef`
exposing `focus` / `prefillIfEmpty` / `clearAfterSuccess`).

- **Packages** (`:7-28`): `@lexical/react/LexicalComposer`,
  `LexicalComposerContext`, `LexicalContentEditable`, `LexicalErrorBoundary`,
  `LexicalHistoryPlugin`, `LexicalOnChangePlugin`, **`LexicalPlainTextPlugin`**,
  core `lexical`, `@lexical/utils` (`mergeRegister`).
- **Plain text is structural, not a setting**: `PlainTextPlugin` (not
  RichText) at `:257`; `initialConfig` registers only `nodes: [MentionTextNode]`
  (`:250`); the parent reads `root.getTextContent()` through `OnChangePlugin`
  and submits `raw.trim()` — the same bytes the old `<textarea>` produced. **No
  rich text, Markdown, HTML, or editor state ever persists.**
- Plugins mounted (`:256-288`): `EditorBridge` (`:71`), `PlainTextPlugin`,
  `HistoryPlugin`, `OnChangePlugin`, `MentionHighlightPlugin` (`:83`),
  `ComposerKeysPlugin` (`:102`), `MentionMenu`.
- **`ContentEditable` ARIA (`:259-268`)**: `role="combobox"`,
  `aria-label="Add a comment"`, `aria-expanded`, `aria-controls`,
  `aria-activedescendant`, `aria-autocomplete="list"`. Placeholder: *"Add a
  comment… type @ to tag the operator, an agent, or a teammate"*.
- Keyboard (`:102-173`, all `COMMAND_PRIORITY_HIGH`, IME-safe via
  `editor.isComposing()`): ⌘/Ctrl+Enter submits; with the mention menu open
  Enter/Tab pick, ↑/↓ move, Escape closes.

Supporting modules: `lexical-mention-plugin.tsx` (216 — the `MentionTextNode`
class, `registerMentionHighlighting`, segmentation via `findMentionSpans` from
`~/ui/mention-spans` so live highlighting and rendered comments use one matcher),
`mention-menu.tsx` (107 — `role="listbox"` + `role="option"` rows),
`use-mention-autocomplete.ts` (136 — `MAX_SUGGESTIONS = 8`),
`mention-autocomplete.ts` (198 — pure token grammar mirroring the server's
`MENTION_RE`).

### 5.7 Continuity — `continuity-recovery.tsx` (404)

The UX spec's "Continuity Recovery Panel". Exports `CONTINUITY_EVENT_TYPE`
(`:74`), `EXECUTION_PANEL_LABEL` (`:91`), `ContinuityProgress` (`:94`),
`deriveContinuityLoss` (`:173`), **`ContinuityRecoveryPanel` (`:230`)**.

- **It reports; it never asks.** `resumeRun` already probed the session, stamped
  a `session_missing` error line, wrote the `continuity` typed event and
  re-entered `startRun` with a canonical-anchor preamble — so a "resume or start
  fresh?" control would name an outcome no server path can promise (docstring
  `:26-41`).
- State is the union of the `continuity` timeline event (the only source of
  WHEN) and the affected run group (the thread carrying a `…session_missing`
  line); the dead session id comes from that line's **stored wire envelope**,
  never parsed from display text.
- Renders `<section className="panel continuity-panel"
  aria-labelledby="continuity-heading">` with an off-screen
  `role="status" aria-live="polite"` region (`:286`), a status pill
  ("context lost" / "re-anchored · running" / "re-anchored · recovered" /
  "re-anchored · no run since"), a lede leading with **authoritative task truth**
  ("This task record is still the authority…"), then obs rows *still
  authoritative* / *lost* / *since then* / *continuity lost*, then per-agent
  "Open {name}'s console" and "Ask operator".
- Self-retiring: it derives from the loader's bounded 30-event timeline slice and
  the bounded console window, so once the task moves past the break the panel
  disappears and the record survives on the timeline.

The **board-side** half of pass-20 D4 is the "Degraded continuity" filter chip
(§4.2). The typed event's warning tone comes from `event-meta.ts` `TYPED_KIND`
(`continuity: "risk"`).

### 5.8 Attachments and evidence

`attachments-panel.tsx` (**99**, was 76 at pass 20). `AttachmentsPanel` (`:22`),
`IMAGE_RE` (`:20`), props `base` / `attachments` / `browserExpected`.

- `.attach-grid` of `.attach-thumb` anchors wrapping `<img loading="lazy">`
  (`:64-85`), `.attach-file` rows otherwise (`:87`); sizes via `prettySize` from
  `~/features/kb-browser/tree`. `data-comment-anchor="attachments"`.
- **New: the pass-20 D8 empty state (`:35-50`)** — returns `null` unless
  `browserExpected` (a deployed agent on this task holds `use-browser`),
  otherwise renders *"No attachments yet. A browser-capable agent on this task
  saves the screenshots and files it captures here — none have landed. They
  appear the next time such an agent runs and produces evidence."*
- Member-gated twice: the loader ships `[]` to non-members, and
  `routes/task-attachment.ts` re-checks membership on every fetch.

**Evidence linkify** — `timeline.tsx` `EvidenceLabel` (`:111`): an evidence label
is split on whitespace; a token that, stripped of backticks/quotes/trailing
punctuation, **exactly matches a real attachment filename** becomes
`<a class="ev-file">` to the serving route (`:131-138`); otherwise it stays the
plain text it always was. `TimelineItem` (`:147`) takes
`attachmentNames?: ReadonlySet<string>` + `attachmentsBase?`.

### 5.9 Timeline — `timeline.tsx` (501)

`TimelineItem` (`:147`) and `Timeline` (`:256`). `COLLAPSE_MAX = 340` (`:44`),
`CollapsibleComment` (`:55`). Filter tabs are `.tl-filter` buttons with
`aria-pressed` (`:396`). The composer mounts at `:417`; the closed-task line at
`:407`; the **UXA-1 honest comment scope** note at **`:434`**: *"Every project
member can comment · @mentions route to agents"*. Progressive disclosure
("Show older events · {n} more", `:495`) drives `?events=` through
`setSearchParams`; the math lives in `timeline-slice.ts` (43,
`TIMELINE_INITIAL_SLICE = 30`).

### 5.10 Side panels — `task-side-panels.tsx` (769)

`GithubTrace` (**`:26`**), `PolicyPanel` (`:356`, `<h2>Permissions</h2>` at
`:429`), `CurrentStatePanel` (`:465`, `<h2>Current state</h2>` at `:536`).
The F18-13 terminal-task force-accept withdrawal now lives at
`isTerminal` **`:107`**, `forceAcceptReason` **`:109`**, `forceAcceptRow`
**`:126`** (rendered at `:163` and `:339`).

### 5.11 Run console — `app/features/runtime/`

| File | Lines | Notes |
| --- | --- | --- |
| `runs-panels.tsx` | 869 | `LiveRunPanel` (`:171`), **`AgentLogsPanel` (`:413`)**. Pipeline `groupThoughts(collapseTelemetry(hoistRunInputs(shown), raw), raw)` (`:489`) — every folding is a no-op under the `{ } raw` toggle (`:605`, `aria-pressed`). Thought folds `:697-739` (disclosure labelled `Thought for {n}s · {k} steps`). **"show what this run was given" / "hide what this run was given" disclosure at `:776`.** Tool chips `.log-chip > .lc-name + .lc-detail` (`:814`); file chips carry `FILE_KIND_MARK` glyphs `+ ~ −` (`:351`) as well as colour (WCAG 1.4.1). `ConsoleCode` (`:366`) with a copy button and `.lk-line` bodies. Load-older control `:645-678`. Log stream is `aria-live="off"` (`:633`) deliberately |
| `runs-helpers.ts` | 540 | Pure folding: `isThoughtLine` (`:273`), `groupThoughts` (`:287`), `thoughtLabel` (`:330`, never invents a duration), `toolChip` (`:358`, null when the provider sent no name), `fileChangeChips` (`:376`), `consoleCodeBlock` (`:400`), `diffLineKind` (`:407`), `runInputRows` (`:138`, the `mcp` row lists `viberr_browser` under `mounted:`), `agentMessageProse` (`:469`) |
| `use-run-log-stream.ts` | 521 | The EventSource client. `streamError` strings at `:432`, `:433`, **`:478`** |
| `runtime-types.ts` / `log-clock.ts` / `log-noise.ts` | 298 / 65 / 80 | View types, clock formatting, telemetry collapse |

### 5.12 Other task-detail modules

- `task-main-sections.tsx` (626) — `DiagnosticsPanel` (`:49`), `TaskHero`
  (`:85`), `ScheduledActions` (`:287`), `ExecutionSection` (`:489`). The
  archived-task pill withdrawal (UXO-1) is at `:159-187`.
- `execution-profile.tsx` (**1064**) — `ExecutionProfile` (`:715`) plus
  `OwnerControl` (`:200`), `SpecialistControl` (`:381`), `ReviewerControl`
  (`:488`), `OperatorRunControl` (`:597`).
- `event-meta.ts` (82) — `EVENT_META` (`:25`), `eventMeta` (`:59`),
  `TYPED_KIND` (`:67`), `typedKind` (`:80`).
- `task-detail-hooks.ts` (230) — `useActionFeedback` (`:28`, the once-per-settled
  toast all 13 page fetchers route through), `useRunControls` (`:55`),
  `useLogSelection` (`:197`).

---

## 6. Instance settings — `/org/settings`

*Verified 2026-08-19 against `ce2bc9e`.*

`app/routes/org.settings.tsx` (588) + `app/features/org-settings/`. Admin-only
(`requireRole(request, "admin")`). Shell:
`<main className="home-shell" data-screen-label="Instance settings">`,
`<h1>Instance settings</h1>`, sub *"Instance level — shared by every project and
board. Board-level workflow & policy live inside each project."* Nav is
`<nav className="set-nav" aria-label="Settings sections">` with `aria-current`
on the active tab.

### 6.1 Tabs — `org-settings-page.tsx` (146), `SETTINGS_TABS` at `:19`

**Four tabs**, driven by `?tab=`, default `connections`:

| id | label | icon | badge |
| --- | --- | --- | --- |
| `connections` | GitHub connections | `github` | `connections.length` |
| `users` | Users & access | `user` | `users.length` |
| `sso` | Sign-in & SSO | `lock` | `authProviders.filter(p => p.active).length` — **live** methods, not configured rows |
| `resources` | Agent resources | `memory` | `kbs + mcps + skills` (agent profiles deliberately excluded) |

### 6.2 Action intents — 35

`connection-add` `:176` · `connection-replace` `:185` · `connection-default`
`:196` · `connection-remove` `:203` · `user-role` `:213` · `user-edit` `:221` ·
`user-reset-password` `:239` · `user-remove` `:243` · `user-disable` `:252` ·
`user-enable` `:261` · `invite-github` `:265` · `invite-google` `:273` ·
`invite-domain` `:281` · `invite-local` `:291` · `domain-remove` `:306` ·
`kb-save` `:312` · `kb-delete` `:324` · `kb-reindex` `:326` · `mcp-save` `:328` ·
`oauth-save` `:344` · `oauth-test` `:362` · `oauth-toggle` `:397` ·
`oauth-remove` `:409` · `mcp-test` `:415` · `mcp-delete` `:417` · `skill-save`
`:419` · `skill-delete` `:434` · `agent-save` `:436` · `agent-delete` `:454` ·
`store-upload` `:461` · `store-write-doc` `:505` · `store-read-doc` `:528` ·
`store-mkdir` `:535` · `store-delete` `:547` · `store-import-github` `:560`.

### 6.3 GitHub connections — `connections-panel.tsx` (369)

`ConnectionsPanel` (`:190`), `ConnectionModal` (`:27`).
`SCOPES = ["repo", "pull_request:write"]` (`:25`). Rows show the masked PAT, repo
count, expiry, and **only proven scope chips** — `source === "assumed"` collapses
to *"…unproven — verified when attached to a project"*. Pills: `not validated`,
`validation failed`, `expires in N days` (≤30), `default`. The token field is
`type="password" autoComplete="off" spellCheck={false} data-1p-ignore`. Save
labels `Validate & connect` / `Validate & replace`, busy `Verifying scopes…`.

### 6.4 Users & access — `users-panel.tsx` (828)

`UsersPanel` (`:567`), `SetupNotice` (`:54`), `InviteModal` (`:59`),
`EditUserModal` (`:326`), `DisableUserDialog` (`:530`).

- Invite modal title **"Allow access"** — *"Whitelist who can sign in — no invite
  emails, access on first login"*. Three-way idp picker (`:168-227`,
  `aria-pressed` at `:173`/`:195`/`:217`); GitHub/Google are `disabled` and read
  `GitHub · off` when that provider is not configured (F18-3), and the default
  idp is the first configured OAuth, else `local` (`:73`).
- Domain-shaped input flips the save to `Whitelist domain` (intent
  `invite-domain`).
- Role controls are `mini-seg` Admin/Member with `aria-pressed`
  (`:304`/`:307`, `:443`/`:446`, `:707`/`:715`).
- Client refusals push an **error-kind** toast (D5): "You can't demote yourself"
  (`:376`, `:593`), "You can't disable your own account" (`:750`), "You can't
  remove your own account" (`:765`). Two inline `.cred-warn role="alert"` slots
  at `:317` and `:519`.
- LV-F1: the reset-pending banner sits **above** an always-rendered reset button
  (`:454-463`), so a pending reset never removes the re-issue action.

### 6.5 Sign-in & SSO — `sso-panel.tsx` (362)

`SsoPanel` (`:188`), `ProviderModal` (`:47`), `CallbackUrl` (`:160`),
`PROVIDER_META` (`:32`). Header `.pol-note` (`:207`) states how many methods are
live and that *"Credentials set here override the ones a deployment passes in its
environment. Who may actually sign in is still the whitelist under **Users &
access**."* Each row carries a source line, `proved <date>`, the copyable
callback URL, the limit of the proof, `live`/`off` + `not tested` pills, and
**Set up/Update credentials · Test · Turn on/Turn off · Remove**. Turn-on is
disabled until a test passes, with the title *"Test the credentials first — a
sign-in method is only offered once the provider has accepted it"*. The modal's
foot hint is *"saving never switches sign-in on — test the pair first"*.

The callback URL spelling is shared via `app/shared/auth/auth-paths.ts`
(`oauthCallbackUrl`), and the route's loader returns `callbackOrigin =
new URL(request.url).origin` so SSR and hydration agree.

### 6.6 Agent resources — `resources-panel.tsx` (294) + `resource-rows.tsx` (495)

`<div data-screen-label="Settings — Agent resources">` → `.rsrc-grid` with four
panels in order **KbPanel → McpPanel → SkillPanel → AgentPanel**
(`resource-rows.tsx:18` / `:153` / `:317` / `:410`).

- **Knowledge bases** (`KbPanel`) — sub-mono
  `store://kb/{dir}/ · N doc(s) · agents read the live folder`; **F18-4 honesty
  branch at `:85-88`** when `kb.folderExists` is false: *"folder missing — no
  docs reach a granted agent; re-create it or delete this knowledge base"*.
  Actions: Browse files · Re-scan · Edit · Delete.
- **MCP servers** (`McpPanel`) — status dot IIFE at `:185-218` where
  **`warming = m.warmingSince !== null` outranks the stored `up`** (R19-18);
  classes `warming → stale → up → down`; sub-line reads
  *"first run — installing in the background"* while warming. The **`.rsrc-err`
  failure-reason line is at `:269-271`**: rendered only when
  `up === false && lastError && warmingSince === null`, printing the command's own
  stderr in monospace (already scrubbed of `MCP_CREDENTIAL` by
  `discoverStdioMcpTools`, and — pass-20 F20-7 — scrubbed at any credential
  length). A credential tail reports `auth: configured` or
  `auth: unreadable — rotate the encryption key or re-enter the credential`.
- **Skills** (`SkillPanel`) — `store://skills/{name}/ · N file(s) · {updated}`.
- **Global agent profiles** (`AgentPanel`) — the `.sub` is the **short blurb
  only**, never the persona (P13-AP-09); sub-mono
  `{Claude Code|Codex} · {stages} · N context resource(s) · used in N project(s)`.

**R19-18 warming poll** (`resources-panel.tsx:113-122`): a 20 s `useRevalidator`
interval armed **only while some row is warming**. Deliberately a poll, not SSE —
the event vocabulary is a closed typed union routed by user/project/task scope
and an org-settings row fits none of them.

D8 empty states (`resource-rows.tsx:141`, `:305`, `:398`, `:485`) follow the same
shape: *absent → why it matters → next action*.

Modals: `resource-modals.tsx` (433) — `KBModal` (`:16`), `McpModal` (`:88`),
`SkillModal` (`:271`); `agent-template-modal.tsx` (402) — `AgentModal` (`:86`);
`mini-modal.tsx` (141) — `MiniModal` (`:14`) with the UXA-9 disabled-Save
explainer at `:68-72` (`unmetHint ?? "Fill the required fields (*) to
continue."`), and `ConfirmDelete` (`:93`) which now **delegates to the shared
`ConfirmDialog`** (pass-20 D6).

### 6.7 The KB editor / in-app KB authoring — `kb-browser/store-browser.tsx` (1261)

**There is no separate `kb-editor` module.** In-app KB (and skill) authoring is
the StoreBrowser's in-place document editor. Exported: `StoreBrowserResource`
(`:49`), `StoreBrowser` (`:892`). Default `action` prop is `"/org/settings"`.

- **Toolbar** (`BrowserToolbar`, `:101`, rendered `:128-219`): Upload files ·
  Upload folder · **Add from GitHub** · **New document** · New folder, then one
  destination `<select id="fm-dest" aria-label="Destination folder">` whose first
  option is `"/ (store root)"`. **One `dest` drives every toolbar action**
  (R14-4).
- **GitHub snapshot import bar** (`.fm-gh`, `:184-212`): a mono input
  (`placeholder="https://github.com/owner/repo/tree/main/docs"`), Enter submits,
  Import → `Importing…` with `aria-busy`. It runs **anonymously when the org has
  no connection** and uses the default connection when there is one; the
  `.cred-warn` beneath now renders only the two refusals a missing credential
  actually explains (anonymous 404, anonymous 403/429), each naming its repair.
- **Document editor** (`.fm-doc`, `:1069-1148`, hook `useDocEditor` at `:753`):
  opened by "New document" or by clicking an editable row (`isEditableDoc`,
  `:92`, tests the extension against `STORE_TEXT_EXTENSIONS`; binaries stay
  inert). Body is a plain `<textarea className="ta mono" rows={10}
  aria-label="Document contents">`. A truncated read disables Save with *"This
  document is larger than the editor can load, so only the first part is shown —
  saving would destroy the rest. Edit it on disk instead."* A **failed save keeps
  the draft** (UI-60). A NEW document colliding with an existing name opens
  `ReplaceConfirm` (`:853`, a nested `<dialog className="confirm-card
  over-modal">`).
- Escape closes the editor, not the browser (`:984-997`); nesting is handled by
  `useDialog`'s `onDismissRequest` escape hatch.

---

## 7. Project settings — `/projects/:slug/settings`

*Verified 2026-08-19 against `ce2bc9e`.*

`app/routes/project.settings.tsx` (225) +
`app/features/project-settings/settings-page.tsx` (**1744**).

**14 intents:** `save-project` `:75` · `rename-stage` `:87` · `add-stage` `:95` ·
`remove-stage` `:107` · `reorder-stages` `:115` · `invite` `:126` ·
`remove-member` `:134` · `repair-repo` `:150` · `set-branch-cleanup` `:163` ·
`grant-scope` `:171` · `set-credential` / `clear-credential` `:180` ·
`archive-project` `:189` · `delete-project` `:197`.

**Panels in order** (`SettingsPage` at `:1518`, render `:1574-1741`):
`ProjectPanel` (`:81`, mounted `:1587`) → `StagesPanel` (`:639`, mounted `:1600`)
→ `MembersPanel` (`:847`, mounted `:1638`) → `RepoPanel` (`:1182`, mounted
`:1658`) → `DangerZone` (`:1412`, mounted `:1721`, **wrapped in
`{canEditPolicy && …}`** — the Q-V1 fix).

Three distinct gates (`:1551-1554`): `canEditPolicy` (Project, Stages, repo
repair, branch cleanup, Danger zone), `canManageMembers` (Members), `canGrant`
(Grant scope + credential manage row).

**Read-only explanations (LV-F2 / UXA-3 / F20-16)** — four `.pol-note` and one
`.deny-note`, each naming the real RBAC grant and its tier:
`ProjectPanel:119-131` · `StagesPanel:797-822` · `MembersPanel:933-941` ·
`RepoPanel:1240-1250` · `DangerZone:1450-1457`.

`StagesPanel` uses a second dnd-kit `DragDropProvider` (`:755`) for stage
reordering, with a `StageMoveMenu` (`:393`) as the keyboard path — the same
"drag is pointer-only, menu is accessible" pattern as the board.

---

## 8. Policy, Agents, GitHub, Review, Activity

*Verified 2026-08-19 against `ce2bc9e`.*

### 8.1 Policy — `policy-page.tsx` (697)

`HumanAccess` (`:56`), `AgentCapability` (`:267`), `WorkflowRules` (`:386`),
`PolicyPage` (`:590`). `.board-wrap[data-screen-label="Policy"]`,
`<h1>Policy</h1>`, sub *"Human access and agent capability — two surfaces,
managed separately"*.

- **Viewer-local policy stamp** (UXA-16) at **`:649`**:
  `<LocalDayDotTime iso={data.edited.at} />` inside a `.hero-file` chip.
- **Two roving radiogroups** (UXA-7) using `rovingRadioKeyDown` from
  `~/ui/roving-radio`: member roles at **`:170`** and transition boundaries at
  **`:498`**.
- RBAC table `.rbac-scroll > table.rbac-table` (`:193-232`), rows derived from
  `RBAC_DEFINITIONS` via `policy-data.ts` `RBAC_ROWS` (`:41`).
- `WorkflowRules` renders the flow map plus an off-chain note, and its trailing
  `.pol-note` carries the **F20-19 live/configured sentence** driven by
  `operatorAutonomyState` (`policy-data.ts:130`) — "the operator runs at **full
  autonomy** with that grant set to *Direct*, so the exception is **active**" vs
  "…is **not active**" vs "no operator is deployed".
- `policy-data.ts` (157) owns the single canonical
  `TRANSITION_TO_DONE_EXCEPTION` string (`:70`) that both this page and the
  Agents operator card render.

### 8.2 Agents — `agents-page.tsx` (1522)

`StageEligibility` (`:397`), `LibraryPicker` (`:485`), `ProfileDetail` (`:590`),
`LiveRoster` (`:946`), `AgentsPage` (`:1098`).
`.board-wrap[data-screen-label="Agents"]`, `Profiles | Live · N` seg with
`aria-pressed` (`:1298`/`:1307`), URL-as-state via `?profile=` and `?tab=live`.

- **UXA-15 read-only explanation at `:1344-1359`**: *"Read-only — deploying,
  editing or removing agent profiles needs the **Manage agent profiles** grant,
  held by a project admin. The capability matrix below is readable by every
  member."*
- **The operator** is split out under a group label **"Orchestration"**; it can
  never be deleted (`canDelete = a.kind !== "operator" && canManage`, `:677`); it
  gets an **Autonomy** cell where a specialist gets **Model**; and it is the only
  card that renders the Done exception (`showDoneException`, `:652`).
- `create-profile-modal.tsx` (1158) — `CreateProfileModal` (`:895`). Body order:
  Identity → Backend → Autonomy (operator only) → Model/Effort → Stages →
  Definition/Persona → **CapabilityGrants** → **ResourcePicker**. The capability
  accordion (`:564-733`) has `aria-expanded` group headers and a third roving
  radiogroup at `:701`.
- `capability-matrix-modal.tsx` (277) — read-only, shared by Agents and Policy.
- `capability-catalog.ts` (181) projects `app/shared/capabilities.ts`. Agent
  groups: **Repository & execution** · **Collaboration** · **Reserved for
  humans**. Operator groups: **Assignment** · **Coordination** · **Permissions** ·
  Collaboration. `use-browser` ("Drive a live web browser", `capabilities.ts:111`)
  is an ordinary Collaboration entry, **default `off`**, with no bespoke UI — it
  renders as a toggle in both profile editors, a row in the matrix, and a row on
  Policy's capability table. A granted-but-refused browser surfaces in the run
  console's "what this run was given" disclosure as
  `viberr_browser … granted but NOT mounted`.

### 8.3 GitHub — `github-view.tsx` (652)

`RepositoryPanel` (`:46`), `PullRequestsPanel` (`:174`), `BranchesPanel`
(`:268`), `GithubViewPage` (`:405`). `.board-wrap[data-screen-label="GitHub"]`.
Pill vocabulary is centralised in `github-pills.ts` (145): `syncPill`,
`prStatePill` (`:47`), `checksPill`, `reviewPill`, `mergeablePill`,
`connectionPill`; toast copy in `github-copy.ts` (80).

**R19-11 / Q-V1 credential redaction is complete on this route**: the loader
computes `credentialGrantHolder` (`project.github.tsx:90-102`) and, when false,
passes the payload through `withoutCredentialDetail` (`:120-133`); the view then
withdraws the whole card with an explanation (`github-view.tsx:148-169`). **The
project-settings route does NOT do this** — see §10.

### 8.4 Review queue — `review-page.tsx` (305)

`ReviewQueuePage` (`:164`), `RQRow` (`:48`).
`.board-wrap[data-screen-label="Review queue"]`, `<h1>Review queue</h1>`, two
sections: **"Waiting on your acceptance"** (`:236`) and **"Still in review"**
(`:284`). UXA-2: PR state colour comes from the canonical `prStatePill`
(imported `:6`, used `:92`/`:96`) — no local map.

### 8.5 Activity — `activity-page.tsx` (623)

`ActivityPage` (`:447`). `.board-wrap[data-screen-label="Activity"]`,
`<h1>Activity</h1>`, `<h2>Stream</h2>` (`:519`) + `<h2>Audit logs</h2>` (`:391`).
Hydration-safe day grouping: `useHydrated` from `~/ui/local-time` (`:472`) picks
`groupStreamByDayUTC` on the SSR pass and `groupStreamByDay` after hydration
(`:490`) — the fix that removed React #418 on this page. Stream filter is
`.mini-seg[role="group" aria-label="Filter the stream by actor"]` with
`aria-pressed` (`:530`/`:536`) — `role="radiogroup"` with plain buttons was
withdrawn as broken ARIA (UI-58 comment at `:526`). `compactAuditEntries`
(`:223`) folds runtime sessions.

---

## 9. Cross-cutting UI

*Verified 2026-08-19 against `ce2bc9e`.*

### 9.1 `app/ui/` — the shared kit

| File | Lines | API |
| --- | --- | --- |
| `use-dialog.ts` | 122 | **The dialog contract.** See §9.2 |
| `page-overlay.tsx` | 39 | `PageOverlay({label,onClose,children})` — full-page `<dialog className="page-overlay">` on `useDialog`, `data-screen-label={label + " — overlay"}`, close `×`. Used by `/profile` and `/notifications` only |
| `confirm-dialog.tsx` | 71 | **New in pass 20 (D6).** `ConfirmDialog({title, body, confirmLabel, busy, onCancel, onConfirm})` — the shared consequence-confirm; `mini-modal.tsx`'s `ConfirmDelete` and the task page's interrupt/dismiss dialogs all delegate here |
| `toast.tsx` | 264 | `ToastKind = "success" \| "error"` (`:19`) — exactly two, and **the glyph is the entire signal** (`check` vs `alert` at `:237`; both kinds paint `var(--fg)`). `useToasts` (`:58`), `ToastProvider` (`:250`), `useToast` (`:262`). `TOAST_DISMISS_MS = 2600`, `TOAST_EXIT_MS = 200`, `TOAST_STACK_CAP = 4` (`:30`, `:31`, `:50`). Two-phase dismissal: `leaving: true` at 2600 ms plays the fade-down (`:77`), removal at 2800 ms — but a toast **evicted by the cap is removed immediately with no leaving phase** (animating an exit caused by an arrival misreads as the new toast pushing the old one). The host is the app's ONE announcer: `<div popover="manual" role="status" aria-live="polite" aria-atomic="false">` (`:214-225`) promoted to the top layer via `showPopover()`, with a two-commit dance so the live region is observed before it changes, and re-insertion when the set of open `<dialog>`s changed (the top layer is insertion-ordered) |
| `use-action-toast.ts` | 26 | `useActionToast(fetcher)` — dedupes by `data` identity, then `push(data.ok ? data.toast : data.error, data.ok ? "success" : "error")`. The toast path for ~11 fetchers (project settings, GitHub, Policy) |
| `use-fetcher-result.ts` | 27 | Once-per-result guard for **client-computed** messages (the handler is ref'd, so an inline arrow neither re-fires nor closes over stale state) |
| `use-dismiss.ts` | 110 | `useDismiss(open, onDismiss, { also?, onReflow?, outside? })` — outside-press (`mousedown`, not `click`), Escape, and optional capture-phase scroll/resize close, for **non**-dialog popovers. Explicitly not `useDialog` (`:15`): no focus trap, no top layer, no scroll lock. Replaced seven hand-rolled copies |
| `pill.tsx` | 157 | `PillKind` (8 values, `:15`), `Pill` (`:25`), `ReadinessPill` (`:98`), `ValidationPill` (`:144`). `ReadinessPill` carries an `activity` glyph as well as colour, and an **unrecognised value falls back to a neutral "unknown" pill, never to green "ready"** (C12, `:77-86`). Validation labels: healthy → "validation healthy", changed → "awaiting verdict", failing → "validation failing", none → "no validation", bypassed → "accepted · gate bypassed" (risk tone) |
| `stage-menu.tsx` | 213 | The board's and task hero's accessible stage-change menu — the keyboard path drag deliberately does not provide. Popover is **portaled to `document.body`** and rect-positioned, so `useDismiss(…, { onReflow: true, also: [btnRef] })` closes it on scroll/resize; `role="menu"` with `role="menuitemradio"` items, `onMenuKeyDown` (`:111-141`) handling ↑/↓ wrap, Home, End and Escape-returns-focus. The **only** file in the gate's `VIEWPORT_READS` |
| `markdown.tsx` / `rich-text.tsx` / `mention-spans.ts` | 171 / 94 / 109 | Comment rendering, typed-event rich text, the one `@mention` matcher shared with the Lexical composer |
| `local-time.tsx` | 41 | `useHydrated`, `LocalDayDotTime` — viewer-local clocks that SSR as UTC |
| `icon.tsx` | 84 | `Icon` — inline SVG from an in-module `ICON_PATHS` map |
| `roving-radio.ts` | 52 | `rovingRadioKeyDown` (`:22`) — ←/→/↑/↓, skips disabled, wraps, starts from the checked option |
| `skip-link.tsx` | 58 | `SkipLink({targetId="main-content"})` — WCAG 2.4.1. Mounted at exactly two sites: `home-page.tsx:238`, `project.tsx:222` |
| `avatar.tsx` / `initials.ts` / `identity.tsx` / `toggle.tsx` / `csrf-input.tsx` / `use-shortcut-hint.ts` / `use-relative-time.ts` | 30 / 16 / 38 / 27 / 18 / 29 / 26 | Small shared primitives. **Every form needs `_csrf`** — that is what `csrf-input.tsx` is for |

### 9.2 The dialog pattern — `useDialog` + `[data-closing]`

`app/ui/use-dialog.ts:22` — `const { ref, close } = useDialog(onClose, onDismissRequest?)`.

Every modal in the app is a **native `<dialog>` opened with `showModal()`**, so
the browser supplies the focus trap, initial focus, Escape (`cancel`), top-layer
stacking and the `::backdrop` scrim. The hook adds the five things the platform
does not:

1. **Animated close** — `close()` sets `dialog.dataset.closing = ""` (`:37`),
   reads the resulting `transition-duration` (`:41`), and calls `onClose` only
   after the dialog's **own** `transitionend` (`event.target === dialog`,
   `:57-58` — `transitionend` bubbles, so a descendant's transform would
   otherwise end the close mid-fade), with a `seconds * 1000 + 50` fallback
   timer. A duration of `0`/`NaN` (jsdom, or `[data-motion="reduce"]`) closes
   synchronously.
2. **Escape** — the `cancel` event is `preventDefault()`ed so React state stays
   the source of truth (`:88-92`); it routes through the same animated close.
3. **Backdrop click** — a click whose target is the `<dialog>` itself *and* whose
   coordinates fall outside the card rect (`:96-108`); clicks on the card's own
   padding do not dismiss.
4. **Body scroll lock** + **focus restore** on unmount (`:111-118`).
5. **`onDismissRequest`** — return `true` to consume an Escape/backdrop dismiss
   without closing (used by store-browser's nested new-folder row); explicit
   `close()` always closes.

CSS side: `dialog[data-closing]` at `app.css:1729-1740` plays the reverse of
`pop-center`; `.cmdk-card[data-closing]` has its own variant (`:1803`); the
reduced-motion block at `:3736` collapses it to a 120 ms opacity fade.

**Call sites (24 across 18 files):** `agents-page` ×2, `capability-matrix-modal`,
`create-profile-modal`, `board-page`, `credential-card`, `home-sections`,
`new-project-modal`, `store-browser` ×3, `mini-modal`, `users-panel`,
`settings-page` ×2, `command-palette`, `accept-confirm`, `archive-confirm`,
`decision-packet` ×2, `release-confirm`, `confirm-dialog`, `page-overlay`.

### 9.3 The ⌘K palette — `command-palette.tsx` (233)

- Shortcut: `useCommandPaletteShortcut` (`use-command-palette.ts`) on `window`;
  ⌘K / Ctrl-K, `altKey` excluded. Mounted by Home, the workspace `Topbar`, and
  — new in pass 20 — the `palette-shell.tsx` layout for `/profile`,
  `/notifications` and `/org/settings`.
- `data-screen-label="Command palette"`, native `<dialog>` via `useDialog`
  (`:66`), so it stacks in the top layer **above** an open `PageOverlay`.
- Input at `:150`: **`role="combobox"`** + `aria-expanded` (`:152`),
  `aria-controls={LISTBOX_ID}` (`:153`), `aria-activedescendant` (`:154`),
  `aria-autocomplete="list"` (`:155`), placeholder *"Search tasks, branches,
  agents, projects…"*.
- Results: `<div id={LISTBOX_ID} role="listbox" aria-label="Search results">`
  (`:186`) → per-kind `role="group"` wrappers carrying the heading as their
  accessible name (`:190`, the visible `.cmdk-group` heading is `aria-hidden`) →
  `role="option"` rows (`:203`). Groups: `Projects` · `Tasks` · `Branches` ·
  `Agents` (`GROUP_LABEL`, `:19`).
- Query hits `/resources/search?q=` (`:87`) with a 140 ms debounce
  (`QUERY_DEBOUNCE_MS`, `:34`), scoped server-side to the viewer's visible
  projects (`command-search.server.ts`: `COMMAND_GROUP_LIMIT = 6`,
  `TASK_SCAN_LIMIT = 60`). A stale-payload guard (`:76-80`) uses hits only when
  `payload.q` still equals the current trimmed query.
- `groupHits` (`:55`) groups by **runs of the same kind in server order**, so the
  render order and the flat `active` index stay in lockstep with ↑/↓.
- Empty states: untyped → *"Type to jump to a task, a branch, an agent or a
  project — across every project you can open."*; no hits →
  `<p className="cmdk-empty" role="status">` with `Searching…` or
  `Nothing matches “{query}”.`
- **The shortcut is registered in exactly three places** —
  `topbar.tsx:69`, `home-page.tsx:100`, `palette-shell.tsx:27` — and no route is
  covered by two of them.

### 9.4 Notifications

Two surfaces sharing one row component:

- **Bell popover** — `shell/top-bell.tsx` (202). A declarative **non-modal
  `<dialog open>`** (not `showModal`), `data-screen-label="Notifications
  popover"`, capped at `BELL_LIST_CAP = 100` with a cap notice, mark-all-read,
  `.bell-badge` pulse keyed on `unread`.
- **Full page** — `/notifications`, `notifications-page.tsx` (315) inside a
  `PageOverlay`. Sections `<h2>Waiting on you</h2>` (`:56`) and `<h2>Everything
  else</h2>` (`:142`); UXA-5 SSR-safe day buckets via `useHydrated` (`:133`);
  filter is `.mini-seg[role="group" aria-label="Filter notifications"]` with
  `aria-pressed` (`:283`).
- **Shared row** — `notifications/notification-item.tsx` (68). F18-1: an
  orphaned notification (`targetMissing`) gets the `orphaned` class (`:48`) and
  `aria-disabled` — **not** `disabled`, so it stays focusable and a click still
  marks it read (`:52-54`).

| | Bell popover | Full page |
| --- | --- | --- |
| Container | non-modal `<dialog open className="ntf-pop">` anchored to the bell | `.board-wrap` inside a modal `PageOverlay` |
| Row markup | shared `NotificationItem` | its own `rq-row` (needs-you) and `.pol-ev.ntf-ev` (stream) rows — **not** `NotificationItem` |
| Grouping | flat, newest-first | "Waiting on you" panel + day-bucketed "Everything else" |
| Cap | `BELL_LIST_CAP` 100, disclosed in the footer | `NOTIF_PAGE_LIMIT` 200 (`notifications.tsx:44`), disclosed via `truncated` |
| Filter | none | All / Unread `mini-seg` |
| Mark read | row click, "Mark all read" | row click (unread only), explicit "Mark read" button, "Mark all read" |

Both surfaces refuse to navigate for a `targetMissing` row (`top-bell.tsx:110`,
`notifications.tsx:115`) — the workspace layout has no `ErrorBoundary`, so a 404
there would drop the user on the shell-less root splash. Both count orphans into
the header total (`shownUnread`, F19-25) because the badge count excludes them.
`/notifications` subscribes to `sseScopes.user()` on its own, since it renders
outside the workspace shell.

### 9.5 Profile — `/profile`

`routes/profile.tsx` (231) → `PageOverlay label="Profile & preferences"`
(`:214`) → `profile-page.tsx` (961), `.board-wrap[data-screen-label="Profile &
preferences"]`. Sections: `ProfileIdentity` (`:99`) · `ProfileNotifications`
(`:225`) · `ProfileAppearance` (`:310`, theme and timeline-default `mini-seg`s
with `aria-pressed` at `:410`/`:439`) · `ProfileAccess` (`:454`) ·
`ProfileGithub` (`:533`, F18-3 `showConnectAffordance` at `:552`) ·
`ProfilePassword` (`:747`). F18-12: `.profile-grid` stacks on mobile
(`app.css:1165` base, `:2992` override).

### 9.6 Login — `/login` (`routes/login.tsx`, 609)

Two modes: `"login"` (`data-screen-label="Login"`, `:429`) and `"reset"` →
`SetNewPassword` (`:160`, the `pwreset_required` gate).

**Local-first (R17-4)** is structural, not cosmetic: `ssoConfigured =
providers.github || providers.google` (`:426`). When **neither** provider is
configured the whole `ProviderButtons` block and the "or a local account"
divider are not rendered at all — the credentials form leads, and the card
closes with *"GitHub & Google SSO isn't configured on this deployment — sign in
with a local account. An admin can enable OAuth to let whitelisted accounts sign
in directly."* When SSO is configured, `ProviderButtons` (`:271`) renders each
provider as a **disabled** button labelled `GitHub — not configured` with
`title="GitHub OAuth isn't configured on this deployment"` when that one is not
live. Since R19-16 the loader's `providers` flags resolve through
`resolveOAuthProvider` — the same function the auth handler uses — so **no
surface can advertise a method the handler would refuse**.

Two CSRF asymmetries worth knowing: the login form carries **no `_csrf`** (there
is no session yet — it relies on `assertTrustedOrigin`), and neither does
`/api/auth/*` (better-auth enforces its own Origin/trustedOrigins check). Every
other form in the app needs `<CsrfInput />`, including `SetNewPassword`
(`:218`).

### 9.7 Live updates (SSE)

`app/features/live-updates/`: `event-types.ts` (34) re-exports the shared zod
contract (`app/schemas/sse-event.schema.ts`) plus `SSE_ENDPOINT =
"/resources/events"`, `sseScopes` (`user` / `projects` / `project:<slug>` /
`task:<slug>/<key>`) and `buildEventsUrl`. `use-live-updates.ts` (141) —
`REVALIDATE_DEBOUNCE_MS = 300` trailing debounce; **revalidation IS the update
mechanism** (no optimistic state, no client caches); `stream.open` never
revalidates; a closed stream flips `paused` (the topbar's "live updates paused"
retry pill) and reconnects on bounded exponential backoff.

Event names (`sse-event.schema.ts:22`): `task.updated` · `task.removed` ·
`project.updated` · `project.removed` · `projection.rebuilt` ·
`notification.created` · `notification.read` · `violation.updated` ·
`run.log-appended` · `run.state-changed` · `stream.open` · `stream.resync`.

---

## 10. Design language and the gates

*Verified 2026-08-19 against `ce2bc9e`.*

### 10.1 One stylesheet, unprefixed tokens, no Tailwind

- **`app/app.css` — 4262 lines — is the only stylesheet in the app.** Verified:
  the only other `.css` files in the repo are `design/html-app/app/*.css`, the
  static design mock, which nothing imports (and which is in oxlint's
  `ignorePatterns`). The only CSS import chain is `app/root.tsx:1-12`.
- **No Tailwind.** No `tailwind*` or `postcss*` config, no dependency,
  `vite.config.ts` plugins are `[reactRouter()]` only. The two literal "Tailwind"
  strings in the tree are a comment (`app.css:3034`, *"no Tailwind, no inline
  hex"*) and an unrelated test-local `interface TailWindow`. **There is no
  `--viberr-*` token layer either — both were removed long ago.**
- Icons are inline SVG paths (`app/ui/icon.tsx`); everything else is
  hand-authored CSS on custom-property tokens.

**Tokens — 40 unprefixed names, all declared on `:root` (`app.css:7-83`), and
nowhere else.** No inline or component-scoped custom properties exist.

| Group | Tokens |
| --- | --- |
| Surfaces / text | `--bg` `--surface` `--fg` `--muted` `--pin-star` `--faint` `--placeholder` `--border` `--ring` `--hairline` |
| Brand / CTA | `--blue` `--blue-pressed` `--blue-soft` `--cta-bg` `--cta-fg` |
| Semantic | `--success` `--coral-light` `--coral-dark` `--rose-light` `--teal-light` `--teal-dark` `--orange-light` `--yellow-dark` `--red-light` |
| Agent identity | `--agent` `--agent-dark` `--agent-soft` |
| Type | `--font-display` `--font-body` `--font-mono` |
| Elevation | `--shadow-ring` `--shadow-card` `--shadow-pop` |
| Motion | `--ease-out` |
| Radii | `--radius-button` `--radius-chip` `--radius-card` `--radius-panel` |
| Layout | `--rail-w` `--topbar-h` |

Dark theme is `:root[data-theme="dark"]` (`:2514-2554`), overriding **26** of
them; `--hairline`, `--shadow-ring`, the fonts, `--ease-out`, the radii and the
layout tokens intentionally inherit. `:root { color-scheme: light }` at `:2513`.

**The `button` reset — `app.css:112`:**

```css
button { font: inherit; color: inherit; cursor: pointer; background: none; }
```

`background: none` is **load-bearing, not tidiness** (comment `:104-111`):
without it a button whose class declares no background keeps the UA
`ButtonFace`, which Chrome resolves per colour-scheme — `#efefef` light,
`#6b6b6b` dark. That mid-grey block dropped `.nav-item`'s `--muted` to 3.2:1 and
its `.count` to 1.9:1 in dark mode. Pinned by `app.css.test.ts:270`.

### 10.2 `app/app.css.test.ts` — the integrity + contrast gate

**2385 lines, 19 top-level `describe` blocks, 80 `it`s, 187 assertions.** No
nested describes, no `.skip`/`.only`.

| Line | describe |
| --- | --- |
| **110** | `app.css custom properties (P13-D-18)` |
| 155 | `app.css utility classes (P13-D-19)` |
| **177** | `app.css keyboard focus ring (P16-UI-01)` |
| 255 | `app.css dead-and-drifted rules (P16-UI-04)` |
| 388 | `app.css select treatment (P16-UI-05)` |
| **426** | `app.css secondary text tokens meet WCAG AA (P13-D-12)` |
| **602** | `app.css defines every class the markup uses (P16-UI-02)` |
| 708 | `app.css hover-revealed board actions (P16-F7)` |
| 734 | `app.css search field vs palette trigger (P16-F6)` |
| 802 | `app.css breakpoints (P16-F8)` |
| 861 | `app.css palette reachability on touch (P16-G3)` |
| 1074 | `app.css draws a task key the same way everywhere (P16-F3 follow-on)` |
| 1104 | `app.css .obs label column fits its longest label (F19-3 follow-on)` |
| **1116** | `app.css owns static styling, not the JSX (P16-F3)` |
| 1161 | `app.css lets a container-sized button wrap (F19-42)` |
| 1192 | `app.css owns the shared idioms — hoisting is not an escape hatch (F19-33)` |
| **1775** | `app.css: every pair it paints clears WCAG AA, in both themes (R19-12)` |
| **2211** | `app.css hides no control at any width (R19-12)` |
| **2345** | `app/ gates no rendering on the viewport (R19-12)` |

Key anchors:

- **Token resolution** — `undefinedTokens` computed `:113-116`,
  `expect(undefinedTokens).toEqual([])` at **`:118`**.
- **Focus ring** — `ringRule` regex `:179`; one app-wide `:where(…):focus-visible`
  with `outline: 2px solid var(--blue)` asserted at `:186-188`; `:where()` wrap
  checked `:217`; 3:1 ring contrast `:231`; wrapper rings for the two borderless
  search fields `:245`.
- **WCAG AA gate** — `const AA_SMALL_TEXT = 4.5` at **`:427`**; the whole-sheet
  successor sweep is the `:1775` block.
- **No-allowlist whole-tree class scan** — describe `:602`;
  `const CLASSLESS_BY_DESIGN = {}` — **empty** — at **`:600`**;
  `expect(orphans).toEqual([])` at `:648`; canaries `files.length > 150` and
  `used.size > 500`.
- **Inline-styling budget** — describe `:1116`; "leaves no `style={{…}}` whose
  every value is a literal" (`:1123`); **`expect(sites.length)
  .toBeLessThanOrEqual(20)` at `:1145`** ("holds the line at 20 sites" — a
  ceiling, not a target; 182 → 20 historically).
- **`RENDERED_INSIDE`** nesting map at **`:1542`**, 6 entries all nested in
  `.console` (`log-line`, `log-chip`, `log-file`, `lcaret`, `log-more`,
  `log-more-note`) — this is what lets the console's literal-hex palette be
  measured against `.console`'s own near-black fill rather than `--bg`.
- Other rot-guarded exemption maps: `GLYPH_NOT_TEXT` (`:1571`, 1),
  `BELOW_AA_BY_DESIGN` (`:1579`, 2), `UNFIXED_BELOW_AA` (`:1592`, 10 selectors →
  17 theme-pairs), `RENDERS_NO_CONTROL` (`:2042`, 2), `HIDDEN_BY_DESIGN`
  (`:2127`, 4), `UNFIXED_HIDDEN` (`:2143`, **0**), `VIEWPORT_READS` (`:2148`, 1 —
  `app/ui/stage-menu.tsx`).

### 10.3 The copy-ban lint — `app/features/copy-ban.test.ts` (966)

**F18-14 / G4.** `design/CONVERSATION-SUMMARY.md:22` bans
*govern/governor/governance* in human-read copy — use **Maintainer** (human
role), **Permissions** (panel), **managed**.

- **Banned regex, `:142`:** `/\bgovern(ance|ed|or|ors|ing|s)?\b/i`. `\b`-anchored,
  so identifiers like `isGoverned` are out of scope by construction.
- **Two describes, 7 `it`s.** `:637` `F18-14: the govern/governance copy ban
  holds on every surface a human reads`; `:940` `F19-12: the retired 'primary
  specialist' vocabulary is gone from copy`.
- **Three scans, covering every source directory under `app/`:**
  1. **Render layer, line-wise** — `ROOTS` (`:97`) = `app/features`,
     `app/routes`, `app/ui`, plus `EXTRA_RENDER_FILES` (`:109`) = `root.tsx`,
     `entry.client.tsx`, `entry.server.tsx` and **`app.css`**.
  2. **Pure TS, string-literal-wise** via a custom lexer — `LITERAL_ROOTS`
     (`:121`) = `app/server`, `app/schemas`, `app/shared`, `app/lib`, plus
     `app/routes.ts`. It tracks *literals*, not call shapes, so copy composed
     into a variable and thrown later is still caught.
  3. **Seeded assets** — `ASSETS` (`:139`) = `app/server/seed/assets/**`.
- **Coverage is an assertion, not prose** (`:678`): every entry `readdirSync(app/)`
  returns must be claimed by a scan or named in `IGNORED_ENTRIES`
  (`:137` — **empty**), so a new top-level directory fails the suite until
  someone classifies it.
- Three rot-checked allowlists: `ALLOW_SUBSTRINGS` (`:162`, 4 entries — exempts
  the **marker only**, via `redact()` at `:178`, never the whole line),
  `ALLOWED_LITERALS` (`:467`, 10 `{file, contains, why}` entries — all agent
  prompt text read by a model plus one template id `"governed-5"`),
  `ALLOWED_ASSET_LINES` (`:540`, 11).
- **There is no rendered-copy exception.** The login tagline had "governed"
  removed rather than allowlisted.

Sibling gates in the same tier:

- `app/features/retired-vocabulary.test.tsx` (171) — bans `/primary specialist/i`
  in rendered and server-built copy (F19-12).
- **`app/features/toast-honesty.test.ts` (219) — NEW in pass 20 (D5).** Scans
  every `push(...)` call in `features`/`routes`/`ui` and fails any whose message
  **literal** is refusal-shaped while the call passes no explicit `"error"` kind.
  Rationale: both toast kinds paint `var(--fg)` — the glyph is the whole signal,
  so a refusal on the default `"success"` kind renders a green check over a
  message saying the action was refused. Includes a planted-violation canary.

### 10.4 The anti-slop oxlint plugin — `tools/oxlint/anti-slop/` (NEW)

Landed in `54ffab8` + `ce2bc9e` (the latter a 387-file sweep taking findings from
2,843 → 26). A vendored port of `dmmulroy/anti-slop`: **15 oxlint JS-plugin
rules** rejecting low-evidence TypeScript — `no-unknown-parameters`,
`no-unknown-returns`, `no-unknown-type-aliases`, `no-unsafe-dictionary-type`,
`no-chained-type-assertions`, `no-widen-then-assert`, `no-known-value-widening`,
`no-runtime-typeof`, `no-reflect-get`, `no-reflect-apply`, `no-object-parameters`,
`no-module-mocking`, `no-conditional-empty-object-spread`,
`no-shape-in-symbol-names`, `require-safety-comment-for-type-assertion`.

Wiring: `package.json` `"lint": "oxlint"`; `.oxlintrc.json` registers the plugin
(`:19`) and sets all 15 rules to `"error"` (`:22-36`); the plugin directory is
excluded from both oxlint and `tsc`.

**Two facts a UI implementer needs:** (1) **it touches no rendered copy** — every
rule operates on type nodes and identifiers, never `JSXText` or string-literal
content, so copy remains exclusively `copy-ban.test.ts`'s job; (2) `npm run lint`
is **not in CI** (`.github/workflows/ci.yml` runs `typecheck`, `test`, `build`,
`e2e` only), so the gate is local-only today.

### 10.5 ARIA patterns in use

- **`aria-pressed` on mini-seg / seg / pick-chip / fchip toggles — 42 production
  sites in 13 files.** The rule (UI-58, recorded at `activity-page.tsx:526` and
  `notifications-page.tsx:268`) is that `role="radiogroup"` with plain buttons is
  broken ARIA; the app uses `role="group"` + `aria-pressed` instead. Sites:
  Home view toggle (`home-sections.tsx:217/226`), new-project connection owner
  and policy preset (`new-project-modal.tsx:136`, `:315/324/333`), board layout
  and filter chips (`board-page.tsx:1231/1240`, `:1312`), activity stream filter
  (`activity-page.tsx:536`), notifications filter
  (`notifications-page.tsx:283`), timeline filter (`timeline.tsx:396`), run
  console raw/follow (`runs-panels.tsx:608/617`), agents tabs
  (`agents-page.tsx:1298/1307`), profile-modal backend/autonomy/stages/resources
  (`create-profile-modal.tsx:292/353/494/829`), profile theme and timeline
  default (`profile-page.tsx:410/439`), users-panel idp and role segs
  (`users-panel.tsx:173/195/217`, `:304/307`, `:443/446`, `:707/715`),
  resource-modal re-index and transport (`resource-modals.tsx:62`, `:176/179`),
  agent-template backend/stages/skills/mcp/kbs
  (`agent-template-modal.tsx:75/225/239/306/328/352/376`).
- **`role="combobox"` — exactly 2 sites**, both replacing the implicit `textbox`
  role on a search-and-select input: the ⌘K palette input
  (`command-palette.tsx:150`) and the Lexical composer's `ContentEditable`
  (`comment-composer.tsx:261`). Both carry the full contract
  (`aria-expanded` + `aria-controls` + `aria-activedescendant` +
  `aria-autocomplete="list"`), and the palette's comment names the composer as
  the model.
- **`role="radiogroup"` where the pattern really is single-select** — 5 sites:
  `policy-page.tsx:168` and `:496` (adopting `rovingRadioKeyDown`),
  `create-profile-modal.tsx:695` (adopting it), `decision-packet.tsx:594`
  (its own ref-array roving, UI-44), `resource-modals.tsx:354`.
- **`aria-current`** — 4 sites: breadcrumb link and current crumb
  (`topbar.tsx:133`, `:140`, `"page"`), workspace rail (`rail.tsx:67`, `"page"`),
  org-settings tabs (`org-settings-page.tsx:106`, `"true"`).
- **`aria-expanded`** — 21 sites (stage menu, tree rows, bell, rail toggle,
  palette, user menu, settings, profile modals, run console folds, timeline,
  composer, execution profile).
- **`aria-live`** — 5 regions: the toast host (`toast.tsx:220`, `polite`, the
  app's ONE announcer), the board's D9 drag announcements
  (`board-page.tsx:1945`, `role="status"` + `SR_ONLY`), the store-browser upload
  note, the continuity panel (`continuity-recovery.tsx:286`), and the run log
  stream at **`aria-live="off"`** deliberately (`runs-panels.tsx:633`).
- **Labelled landmarks** — all three `<nav>`s carry a label: `Primary`
  (`rail.tsx:32`), `Breadcrumb` (`topbar.tsx:116`), `Settings sections`
  (`org-settings-page.tsx:100`). One labelled `<section>`:
  `aria-labelledby="continuity-heading"`.
- **`SkipLink`** (`ui/skip-link.tsx`) at `home-page.tsx:238` and
  `project.tsx:222`. Its styles are inline **on purpose** — `app.css` carries no
  visually-hidden utility, which the class-scan gate would otherwise flag; the
  same reason applies to `board-page.tsx:91`'s `SR_ONLY`.

---

## 11. Corrections vs the pass-20 doc

*Verified 2026-08-19 against `ce2bc9e`.*

The pass-20 doc was written against `main @b97ad02`, **before** the pass-20 branch
merged (`6c94f2c`, PR #169) and before the two anti-slop lint commits
(`54ffab8`, `ce2bc9e`). 409 files under `app/` changed in that window. The
corrections below are the ones that change a **claim**, not merely a line number;
after them, assume every unlisted line anchor in the pass-20 doc has moved.

1. **"React Router 7" → React Router 8.** `package.json` pins
   `react-router` and `@react-router/dev` at `^8.3.0`. Vite is 8.2, React 19.2.
2. **"`routes.ts` 59 lines, one route added" → 69 lines, and the addition is a
   pathless layout.** `layout("routes/palette-shell.tsx", …)` at `:21-26`
   (F20-30) now wraps `/org/settings`, `/profile` and `/notifications` so ⌘K
   reaches them; URLs are unchanged. Every citation from `/projects` down shifts
   again: `projects` 46→**56**, the `projects/:slug` layout 48→**58**, its
   children 49-57→**59-67**; the attachment route 40-43→**50-53**.
3. **"`project.task.tsx` … 24 intents" → 25 intent strings** (the switch has 25
   `case` labels; `archive-task`/`restore-task` share one body). The route is 990
   lines, not 949; its `ErrorBoundary` moved 922→**963**. The route's own header
   comment listing 15 intents is stale — read the switch at `:375`.
4. **Org-settings intents 35 → still 35, but re-anchored**, and the tab count is
   confirmed at 4. `org.settings.tsx` grew 559→**588**.
5. **The board's acceptance dialog is no longer its own.** Pass 20 replaced
   `AcceptOnBoardConfirm`'s bespoke body with the ONE shared `AcceptConfirm`
   (`board-page.tsx:50` imports it, `:924` wraps it, rationale `:905-912`). The
   pass-20 doc's B1 entry ("its OWN dialog, disclosing LESS than the task page")
   is now the opposite of the code.
6. **"Board drag has no aria-live announcements" is FIXED.** Pass-20 D9 added
   `SR_ONLY` (`board-page.tsx:90`), `announceMove` (`:1539`), and the
   `role="status" aria-live="polite"` region at **`:1945`**, fed from both
   `onDragEnd` (`:1626`) and the StageMenu path (`:1639`). The "cards carry no
   ARIA drag decoration" note remains correct and deliberate.
7. **`attachments-panel.tsx` is 99 lines, not 76** — pass-20 D8 added a real
   empty state (`:35-50`) that renders **only** when a deployed agent on the task
   holds `use-browser`.
8. **`decision-packet.tsx` grew 384→879 lines and gained a 10th packet kind.**
   `discard_branch` (`task-file.schema.ts:99`, pass-20 F20-6) discards a *local,
   never-pushed* branch with its own `PacketDiscardConfirm`
   (`decision-packet.tsx:292`). Also new: the F20-18 escalation affordance
   ("Send to a maintainer", `:755-778`) and the `request-maintainer-decision`
   route intent.
9. **`continuity-recovery.tsx` exists and is mounted.** The pass-20 doc never
   listed it. It is 404 lines, mounted at `task-detail-page.tsx:569` **above**
   the decision packet, and it is the task-side half of D4; the board-side half
   is the new "Degraded continuity" filter chip (`board-page.tsx:1165`,
   `board-filters.ts:63`).
10. **The pass-20 doc put the autonomy gate mirror on the wrong file.** It is not
    in `operator-recommendations.tsx` (which has no autonomy logic at all). F20-9
    / D1 has two halves: `execution-profile.tsx` `OperatorRunControl:666-676`
    (the `Full autonomy` option only exists when the profile is configured for
    it) and `agents-page.tsx:643-655` (the operator card borrows Policy's single
    canonical exception sentence).
11. **`app.css` 4218 → 4262 lines. `app.css.test.ts` 2381 → 2385 lines, and the
    correct structural counts are 19 `describe`s / 80 `it`s / 187 assertions.**
    The four headline anchors (`:110`, `:177`, `:426`, `:602`) are unchanged, as
    are `RENDERED_INSIDE` (`:1542`) and the three R19-12 blocks (`:1775`,
    `:2211`, `:2345`). The inline-styling budget assertion moved
    `:1138/:1142`→**`:1145`**. `CLASSLESS_BY_DESIGN` and `UNFIXED_HIDDEN` are
    both **empty**, which the pass-20 doc did not record.
12. **The pass-20 doc omitted the copy-ban lint entirely.** It is
    `app/features/copy-ban.test.ts`, **966 lines**, regex at `:142`, three scans
    covering every directory under `app/`, and a self-coverage assertion at
    `:678`. Its two siblings — `retired-vocabulary.test.tsx` and the **new**
    `toast-honesty.test.ts` (D5) — are also unrecorded there.
13. **New shared component: `app/ui/confirm-dialog.tsx` (71).** Pass-20 D6
    routed every consequence-confirm through it — `mini-modal.tsx`'s
    `ConfirmDelete`, the task page's run-interrupt and dismiss-recommendation
    dialogs, project-settings stage removal and member removal.
14. **`.gh-table, .live-wrap { overflow-x: auto }` (UXA-8) moved
    `app.css:4011`→`:4055`.** The `button` reset is at `:112`;
    `.profile-grid` at `:1165` (base) and `:2992` (mobile override, was `:2956`).
15. **Q-V1's PAT half is still open, and now has a precise verdict.** The
    redaction WAS applied to `/projects/:slug/github`
    (`project.github.tsx:90-133` + `github-view.tsx:148-169`) but **not** to
    `/projects/:slug/settings`: `settings-query.server.ts:81` still ships the
    full `ProjectCredentialHealth`, and `settings-page.tsx:1317` renders
    `CredentialCard` unconditionally, whose body prints `credential.label`
    (`credential-card.tsx:93`) and `credential.masked` (`:94-96`). Only the
    *actions* are
    gated. A project **Viewer** therefore still receives the credential label,
    masked tail and scope verdicts in the settings HTML, and
    `settings-page.test.tsx:1191-1196` currently pins that behaviour. (The
    pass-20 doc pointed at `credential-card.tsx:31` but did not note that the
    GitHub route had since been fixed while Settings had not.)
16. **`use-run-log-stream.ts` grew 457→521 lines.** The reload-only disconnect is
    now at `:476-478` (`"Live tail disconnected — reload the page to resume
    following."`), and the file **still embeds literal `\0` bytes** as cache-key
    separators — now at lines **205, 207, 214**, not 197. `grep`/`rg` still
    report "binary file matches" and print nothing on this file; use
    `Read`/`sed`/`grep -a`.
17. **`Icon`'s `dangerouslySetInnerHTML` moved `icon.tsx:73`→`:80`** and remains
    the app's only innerHTML sink (values are hardcoded literals in the
    in-module `ICON_PATHS` map).
18. **The two lint commits (`54ffab8`, `ce2bc9e`) touched 142 files under
    `app/features` / `app/routes` / `app/ui` / `app.css`.** They are type-level
    refactors with no intended visual change, but they shifted line numbers
    broadly — including in `project.task.tsx`, `project.agents.tsx`,
    `profile.tsx`, `markdown.tsx`, `pill.tsx`, `toast.tsx`, `roving-radio.ts` and
    `use-dismiss.ts`. Re-verify any anchor in those files before citing it.
19. **Still true and re-verified:** F18-1 orphaned notifications
    (`notification-item.tsx:48/54`), F18-3 OAuth affordances resolving through
    `resolveOAuthProvider` (`profile-page.tsx:47/533/552`), F18-4 KB folder-missing
    honesty (`resource-rows.tsx:67/85-88`), F18-5b Home lock-holder strip
    (`home-sections.tsx:533/566/573`), F18-6 ghost-admin refusals
    (`users-panel.tsx:317/519`), F18-13 terminal-task force-accept withdrawal
    (`task-side-panels.tsx:107/109/126`), UXA-1 comment scope (`timeline.tsx:434`),
    UXA-2 one PR-state colour map (`review-page.tsx:6/92`), UXA-7 roving
    radiogroups (`policy-page.tsx:170/498`), UXA-9 `unmetHint`
    (`mini-modal.tsx:68-72`), UXA-15 Agents read-only note
    (`agents-page.tsx:1344`), UXA-16 viewer-local policy stamp
    (`policy-page.tsx:649`), LV-F1 reset-pending banner
    (`users-panel.tsx:454-463`), and the pass-19 SSO tab / MCP failure-reason /
    MCP warming poll / browser capability / evidence-linkify work.
20. **Whole areas the pass-20 doc never inventoried, now in §9:** the shared
    `app/ui/` kit (20 modules), the `useDialog` / `[data-closing]` contract and
    its 24 call sites, the toast system's kinds and two-phase dismissal, the ⌘K
    palette's ARIA wiring and result grouping, the bell-vs-page notification
    split, `PageOverlay`, `useDismiss`, `SkipLink`, and the SSE/live-update
    contract. It also never recorded `ReadinessPill`'s four render sites or the
    per-diagnostic `readinessEffect` (§5.2) — treat any claim that
    `readinessEffect` "does not exist" as wrong; it is a real field derived by
    `diagnostics-policy.server.ts:28`.
21. **Do not re-open F18-9** ("the new-agent-profile modal pre-selects ALL org
    skills ON") — dispositioned not reproducible; both profile modals initialise
    with EMPTY grants. There are still **no `TODO`/`FIXME`/`HACK` markers** in
    task-detail, home, or shell.
