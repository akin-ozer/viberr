# UI-INVENTORY — Viberr current state (pass 21, revised for pass 22)

> **Revised 2026-08-21 against `main @26fca45`** (pass-22 worktree
> `.claude/worktrees/viberr-app-inspection-e1b87f`). Sections stamped
> *Re-verified 2026-08-21* below carry fresh anchors; sections still stamped
> *Verified 2026-08-19* were NOT re-anchored — treat their line numbers as
> approximate (see the Pass-22 revision note).
>
> Originally **verified 2026-08-19 against `main @ce2bc9e`** (worktree
> `.claude/worktrees/viberr-app-inspection-1fe423`, branch
> `claude/viberr-app-inspection-1fe423`, identical to `main` at that time).
> Supersedes `planning/discovery-2026-08-14-pass20/reference/UI-INVENTORY.md`,
> which was anchored to `main @b97ad02` — i.e. **before** the pass-20 branch was
> merged. `b97ad02..ce2bc9e` is 27 commits and **835 changed files**, so almost
> every line anchor in the pass-20 doc is stale. See §11 for the itemised
> corrections.

## Pass-22 revision (2026-08-21)

**Baseline correction first.** This doc's 2026-08-19 anchors were taken at
`ce2bc9e` — **before** PR #175 merged the pass-21 fix ledger (`ce2bc9e..d1bc4a2`
= 267 files, ~127 of them UI modules under `app/`). PRs #176–#186 then landed on
top (`d1bc4a2..26fca45`). Original anchors therefore carry **two** layers of
drift, not one. Every section this revision touched is re-stamped *Re-verified
2026-08-21 against `26fca45`*; in un-restamped sections (§2 shell, §3 Home, §6
except 6.6, §7, §8.1/8.4/8.5, §9.3–9.7) the *claims* were spot-checked sound but
the line anchors were not re-walked — files there moved by the #175 window too
(e.g. `activity-page.tsx` 623→819, `settings-page.tsx` 1744→1796,
`accept-confirm.tsx` 436→496, `copy-ban.test.ts` 966→1031,
`app.css.test.ts` 2385→2503).

**What changed in the product (#176–#186), reflected below:**

1. **Decision packet redesigned as a quiet questionnaire card** (#180 + #182,
   §5.3, §10.1): hairline border + 3 px left tone accent replaces the gradient
   wash; observations are flat lines behind a thin left rule; options are dense
   and top-aligned with a soft `--blue-soft` selected fill; actions right-align
   with the primary **last** and "Ask operator" **first**; attribution is a bare
   shield glyph, no boxed `.agent-glyph.op`; the custom option's dashed frame is
   gone (solid, same frame as offered options).
2. **Operator run control shows, never picks** (#185, §5.4): the backend and
   autonomy `<select>`s (`.op-sel`) are **gone**. The control prints the
   profile's backend (`.op-backend`) plus an optional **steer** text input
   (`.op-steer`, 2000-char cap, Enter runs); the steer is recorded as a real
   `@operator` timeline comment and becomes the run's `humanComment`. The
   "Project policy: supervised — raise it…" sentence is gone; **full** autonomy
   now announces itself with a caption instead ("Full autonomy: this run can
   move the task and accept completion itself.").
3. **Owned task's owner cell is just the owner** (#186, §5.12): `OwnerControl`'s
   "Manage" popover (take-over / hand-off / release) is deleted — on an owned
   task the control renders `null` and the cell shows the owner chip alone.
   Release lives on the Current-state panel's Owner row (`own-x`); a hand-off
   survives inside `ReleaseConfirm`'s hand-off chips. `ExecutionProfile` no
   longer takes `members` / `onRelease`.
4. **Attachment lightbox** (#184, §5.8, §1.4, §9.2): new
   `task-detail/attachment-lightbox.tsx` (111) — context provider + a
   click-handler factory. Plain left click on any image-evidence surface opens
   an in-app `<dialog className="modal-card lightbox-card">`
   (`data-screen-label="Attachment lightbox"`, "Open original" link); modified
   clicks keep the raw-file tab; without a provider the anchors are plain links.
5. **Attachments render on the producing comment** (#177/#179, §5.8, §5.9,
   §9.1): image attachments on a timeline event draw as `.tl-attach-thumb`
   picture cards (non-images keep the `.tl-attach-chip`); `~/ui/markdown` gained
   `repairAttachmentHref` — an agent-written workspace-relative attachment
   link/embed (`../../attachments/x.png`) is rewritten to the serving route when
   the filename is a real task attachment; embedded task images render inside a
   keyboard-reachable `.md-img-btn` that opens the lightbox. (#179's
   agent-side attachments **drop** is server/workspace-contract work; its UI
   face is these previews.)
6. **Input-required yields to agent-working during a live run** (R21-8, #181,
   §4.2, §5.2): on the task hero, the board card top AND the list row, an
   `input_required` readiness pill is replaced by the agent pill while
   `waiting === "agent"`; the "Blocked or waiting" filter excludes those tasks
   for the same reason. An open packet flips `waiting` to `"human"` and the
   amber pill reasserts. Blocked / inconsistency-risk never yield.
7. **Engaged agents display the live backend** (#183): new
   `deployedSpecialistBackends` / `primaryRunBackend` in
   `agents-query.server.ts:372-425` overlay the engage-time snapshot with the
   backend a run started NOW would use, so exec-profile rows, card glyphs and
   the review queue can't disagree with Run.
8. **Browser grant carries web egress** (#176, §8.2): `coupleGrants`
   (`create-profile-modal.tsx:140`) pins "Search & fetch from the web" to
   Allowed while "Drive a live web browser" is Allowed — the pinned row is
   disabled with an explaining `aria-label`/`title`; the save layer repairs
   stored contradictions and reports via the (now plural) `notices` array.
9. **The backend display label is "Claude", not "Claude Code"** (commit
   `01daead`) — every rendered surface: backend chips, exec-profile rows, live
   roster, toasts, schedule rows, continuity panel, run-console footers,
   `AgentGlyph` title, org-settings agent rows, profile-modal copy.
10. **Corrections found while re-anchoring:** Q-V1's PAT half is **closed**
    (F21-5 — §8.3, §11 item 15): `/projects/:slug/settings` now shares
    `credential-visibility.server.ts` and withdraws + redacts the credential
    card below the `grant-github-scope` tier. `.detail-side` is now FIRST in
    the task page's DOM (U7). The board's shared accept ceremony now projects
    `workRevisionSha` and echoes a ruling-88 `AcceptanceDisclosure` on confirm.
    `copy-ban.test.ts` gained a **P21 em/en-dash ban** describe;
    `app.css.test.ts` gained a 20th describe (field chrome, P21) and is
    2503 lines / 84 `it`s.

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

*Re-verified 2026-08-21 against `26fca45` (route list, module line counts,
task-route anchors; other per-route anchors spot-checked).*

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
| `:60` | `board` | `routes/project.board.tsx` (153) | A | dnd-kit board · `task-actions.server`, `project-authority.server`, `rescan.server`. **3 intents**: `create-task`, `reorder`, `rescan`. *(The loader lives on the layout.)* |
| `:61` | `review` | `routes/project.review.tsx` (72) | L | Review queue · `review-queue.server`, `review-acceptance-authority.server`, `board-query.server` |
| `:62` | `agents` | `routes/project.agents.tsx` (245) | L A | Agents · `agents-query.server`, `agent-profile-actions.server`, `agent-deployments.server`, `resource-catalog.server`, `runtime-registry.server`. **4 intents**: `create-profile`, `deploy-profile`, `update-profile`, `delete-profile` |
| `:63` | `policy` | `routes/project.policy.tsx` (95) | L A | Policy · `policy-query.server`, `policy-actions.server`. **2 intents**: `set-role`, `set-boundary` |
| `:64` | `github` | `routes/project.github.tsx` (158 — shrank 224→158 when the credential-redaction logic moved to the shared `features/github/credential-visibility.server.ts`) | L A | GitHub · `github-query.server`, `github-actions.server`, `freshness-policy.server`, `audit-query.server`, `project-writer.server`. **4 intents**: `reconcile`, `grant-scope`, `set-credential`, `clear-credential` |
| `:65` | `activity` | `routes/project.activity.tsx` (149) | L | Activity feed · `activity-feed.server` |
| `:66` | `settings` | `routes/project.settings.tsx` (245 — now ALSO applies `credentialGrantHolder` / `withoutCredentialDetail` at `:76-78`, F21-5) | L A | Project settings · `settings-query.server`, `settings-actions.server`, `github-actions.server`, `project-authority.server`. **14 intents** (§7) |
| `:67` | `tasks/:key` | `routes/project.task.tsx` (1091) | L A **EB** | Task detail — the largest route. **25 intents** (§5). `ErrorBoundary` at `:1064` |

### 1.3 Error boundaries

Exactly **two** in the whole app:

- `app/root.tsx:183` — the app-wide splash (`<main className="app-splash">` at
  `:204`, styled `app.css:3110-3129` at ce2bc9e; app.css is 4455 lines at HEAD).
  404 → "Page not found"; other statuses →
  `Error ${status}`; a thrown string wins over `statusText`; DEV-only stack in a
  `<pre className="mono">`; "Back to home" link.
- `app/routes/project.task.tsx:1064` — `data-screen-label="Task detail — not
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
`Packet archive dialog` · `Packet discard dialog` ·
**`Attachment lightbox`** (new, #184 — `attachment-lightbox.tsx:73`) ·
`<label> — overlay`
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
*"This project is **archived**. It's read-only. Timelines and audit stay
visible;"* then either *"restore it from **Settings → Danger zone** to make
changes."* or *"a **project admin** can restore it to make changes."* (The
em-dash phrasing was rewritten by the P21 dash ban — §10.3; assume the same for
any other quoted copy in un-restamped sections that carries an em/en dash.)

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

*Re-verified 2026-08-21 against `26fca45`.*

`app/routes/project.board.tsx` (153, action only) +
`app/features/board/board-page.tsx` (**2102**), `board-dnd.ts` (51),
`board-filters.ts` (235).

### 4.1 dnd-kit — whole-card drag, server-authoritative

- Imports `DragDropProvider`, `useDroppable`, `useSortable`
  (`@dnd-kit/react`, `@dnd-kit/react/sortable`), `OptimisticSortingPlugin`
  (`@dnd-kit/dom/sortable`), sensors/constraints from `@dnd-kit/dom`
  (`board-page.tsx:16-32`).
- **`BOARD_SENSORS` (`:143-166`)** — the whole card is the drag surface, **no
  grip handle**:
  - `PointerSensor.configure({ preventActivation })` returns true only for
    `button, input, select, textarea`, so the card face (a `Link`)
    still lifts and only real controls opt out.
  - Mouse: `Distance({ value: 5 })`. Touch: `Delay({ value: 250, tolerance: 5 })`
    so column scrolling is never hijacked.
  - `KeyboardSensor` is registered but the accessible move path is the
    `StageMenu`, not drag.
- **`DragDropProvider` is mounted only in `group === "stage"` mode** (`:2028`);
  list mode has no drag.
- **`BOARD_PLUGINS` (`:171`) = `defaultPreset.plugins` minus
  `Accessibility`** — the plugin's `role="button"` wrapper would nest the task
  link and StageMenu inside an interactive control (axe `nested-interactive`,
  serious). D9's live region and D19's arrow traversal replace it.
- **Per-card `useSortable` (`:484`) removes `OptimisticSortingPlugin`** and
  adds `Feedback.configure({ feedback: "clone" })`. Optimistic sorting is
  deliberately **OFF** — this is the second half of "server-authoritative".
- Columns are `useDroppable({ id: \`stage:${stage.id}\`, collisionPriority: 1 })`
  (`:655`) so empty lanes and blank space accept drops; card collisions (priority
  2) win.
- Handlers: `onDragStart` (`:1569`), `onDragOver` (`:1577`, `stage:` prefix →
  column end, card id → `beforeKey`), `onDragMove` (`:1596`, pointer-midpoint
  refinement — top half before this card, bottom half before `nextKey`),
  `onDragEnd` (`:1617`).
- **Server-authoritative**: `board-dnd.ts`'s `resolveBoardDrop(state)` is a pure
  function that returns `{ to, beforeKey } | null` and **never reorders board
  state**. A slot that vanished under an SSE revalidation degrades to
  "end of column" rather than submitting an unplaceable reference; a no-op drop
  returns `null`. The action intent is `reorder`.
- **`aria-live` announcements (pass-20 D9)** — `SR_ONLY` style constant at
  `:99` (inline because `app.css` has no visually-hidden utility, and it
  must stay in the DOM rather than `display:none`). `announceMove` at `:1558`
  speaks `Move requested: {KEY} to {stage}.` (`:1561`), called from `onDragEnd`
  (`:1645`) and from the StageMenu path (`:1667`). The **outcome** effect
  then re-announces the server's own sentence on success or
  `Move refused: {error}` on failure (`:1715`) — which is what covers the
  server's 409 on an off-boundary move. The region is
  `<div style={SR_ONLY} role="status" aria-live="polite">` at **`:1980`**, the
  first child of `.board-wrap`.
  Cards carry **no** ARIA drag decoration on purpose (see `BOARD_PLUGINS`
  above). Keyboard traversal of the board is the roving arrow handler
  `onCardKeyDown` (`:1830`), which reads lanes back off the DOM via
  `data-board-lane` / `data-board-card` (`:518-519`) and re-issues Enter/Space
  as `.click()`; `useRovingStageMenu` (`:192`) keeps one tab stop rather than
  2N.

### 4.2 Filters and layout

`FILTERS` (`:1162`), rendered by `FilterBar` as `.fchip` buttons with
`aria-pressed` (`:1331`):

| id | label | selects (`matchesBoardFilter`, `board-filters.ts:47`) |
| --- | --- | --- |
| `all` | All tasks | everything not archived |
| `human` | Waiting on me | `waitingOnMe === true` (member-scoped, R8-3) |
| `agent` | Agent working | `waiting === "agent"` |
| `risk` | Blocked or waiting | blocked / input_required **while `waiting !== "agent"`** (R21-8, `board-filters.ts:87` — an input-required task an agent is actively carrying shows no stuck signal on its card, so the filter no longer selects it; it belongs to "Agent working" until a packet flips `waiting` to `"human"`) / inconsistency risk / failing validation / urgent / rejected PR |
| `quiet` | No activity | server-derived `quiet === true` (never re-derived client-side — SSR/hydration would disagree) |
| **`continuity`** | **Degraded continuity** | **`continuity === "degraded"` (`:68`) — pass-20 D4.** Its own chip, not folded into "Blocked or waiting": a task can lose continuity while otherwise healthy |
| `archived` | Archived | `archived === true` |

`continuity` and `archived` are **rarity-gated** — the chip renders only when the
project has such a task or the filter is already on (`:1320-1325`). Tallies
render on `human`, `quiet`, `continuity`, `archived`.

Layout toggle is `.seg[role="group" aria-label="Board layout"]` stage/list with
`aria-pressed` (`:1246-1259`). Board state lives **only in URL params** — no
sessionStorage (see `nav.ts:44-56`).

### 4.3 Acceptance on the board

Pass 20 collapsed the board's bespoke dialog into the shared ceremony:
`AcceptOnBoardConfirm` (`:941`) is a thin adapter that renders **the one
shared `AcceptConfirm`** imported from `~/features/task-detail/accept-confirm`
(`:50`, rationale `:905-940`) in
`ceremony={{ mode: "stage-move", label: "<from> → <terminal>" }}` (`:986-989`).
Refusal text comes from `boardAcceptRefusal` (`:884`), which layers
archived → closed-PR → the stage-boundary sentence → `blockReason` → open-packet
→ conflicting-PR. **Pass-21 fixes:** the delivered revision is now projected
(`TaskSummary.workRevisionSha`) and disclosed instead of hardcoded `null` —
ruling 88 made the confirmed click echo its disclosure back, and the hardcoded
absence turned every board drop on a delivered task into a stale-echo refusal;
`onConfirm` now hands the shared ceremony's `AcceptanceDisclosure` to the POST.

Two triggers set `pendingAccept` (state at `:1540`): a drag into the final stage
(`:1636-1645`) and the StageMenu keyboard move (`:1667`). The target task is
re-read from `allTasks` on every render rather than captured (`:1757`); a lookup
that misses clears the state and pushes an **error** toast — *"`{taskKey}` left
the board before its acceptance was confirmed. Nothing was accepted."*
(`:1769-1775`; the em-dash version recorded at pass 21 was rewritten by the P21
dash ban).

Other board pieces: `StageBoard` columns via `useDroppable` (`:655`),
`ReadinessPill` / `ValidationPill` on cards (`:544`), the archived card's
replacement chip, `OrphanBanner` (`:1382`, mounted `:2025` — now
`role="region" aria-label="Unstaged tasks"`, no longer `role="status"`).

---

## 5. Task detail — `/projects/:slug/tasks/:key`

*Re-verified 2026-08-21 against `26fca45`.*

`app/routes/project.task.tsx` (1091) + `app/features/task-detail/`
(**21 non-test modules** — `attachment-lightbox.tsx` is new, #184).
The largest surface in the app.

### 5.1 Route

- `loader` `:110` — `requireVisibleProject` (`:119`), **`runsVisible`**
  membership computation (`:180`), `resolveAcceptanceAffordance`, and
  **attachments gated on `runsVisible`** (`:263-264`).
- `action` `:384`, switch at `:401`. **25 intent strings** (`archive-task` and
  `restore-task` share one body):

  `comment` `:402` · `update-goal` `:435` · `resolve-packet` `:443` ·
  `request-maintainer-decision` `:517` · `complete-merge` `:541` ·
  `accept-completion` `:553` · `deliver-review` `:591` ·
  `archive-task`/`restore-task` `:616-617` · `force-accept` `:628` ·
  `owner-take` `:644` · `owner-assign` `:656` · `owner-release` `:673` ·
  `transition` `:690` · `run-interrupt` `:721` · `assign-specialist` `:738` ·
  `run-specialist` `:752` · `assign-reviewer` `:768` · `run-reviewer` `:789` ·
  `remove-reviewer` `:808` · `apply-recommendation` `:821` ·
  `dismiss-recommendation` `:846` · `run-operator` `:858` ·
  `schedule-action` `:938` · `cancel-schedule` `:968`.

  ⚠️ The route's own header comment (`:101-108`) still lists only 15 intents —
  it remains stale; read the switch at `:401`.
- **`run-operator` now takes an optional `steer` field** (#185, `:906-925`):
  the trimmed 2000-char steer is written as a REAL `@operator` timeline comment
  via the low-level `appendComment` (`forceToAgent: true` — `commentToAgent`
  would start a second run), then rides the run as `humanComment` +
  `humanCommentBy` (the display name via `userName`, so the operator's `@`-reply
  chips and notifies — NEW-4). The intent no longer receives per-run
  `backend`/`autonomy` from the exec-profile card (the schedule form still posts
  a backend).
- The page is remounted on task switch via `key={loaderData.task.key}`
  (`:1028`); `attachmentsBase` built at `:1032`.

### 5.2 Page composition — `task-detail-page.tsx` (990), `TaskDetailPage` at `:100`

The whole page is wrapped in **`AttachmentLightboxProvider`** (`:605`, #184) —
image evidence anywhere on the page (timeline thumbnails, inline markdown
embeds, the Attachments panel, cited evidence filenames) opens the in-app
lightbox instead of a raw-file tab.
`.detail[data-screen-label="Task <KEY>"]` (`:606-610`).

**`.detail-side` is now FIRST in the DOM** (U7, pass-21 fixes — reading order is
source order; below 1100 px the columns stack and a keyboard user used to reach
"Accept completion → Done" LAST; on desktop the grid still paints main left of
side): `GithubTrace` (`:625`) → `CurrentStatePanel` (`:641`) →
`PolicyPanel` (`:658`).

**`.detail-main`** follows, in order:

| Line | Component | Notes |
| --- | --- | --- |
| `:667` | `TaskHero` | key/title/stage/readiness/validation + inline goal editor. **R21-8 (#181)**: during a live run, an `input_required` readiness pill **yields the slot to the agent-working pill** while `waiting !== "human"` (`task-main-sections.tsx:196-207`); an open packet flips `waiting` to `"human"` and input-required reasserts. Supersedes C3's both-pills arrangement; blocked / inconsistency-risk never yield. The board card top and list row make the identical yield (§4.2) |
| `:678` | `LiveRunPanel` | only when `runtime.length > 0` |
| `:688` | `DiagnosticsPanel` | `<h2>Diagnostics</h2>` (`task-main-sections.tsx`); returns `null` when empty |
| **`:696`** | **`ContinuityRecoveryPanel`** | **above** the packet — degraded continuity is execution TRUTH, so it sits with Diagnostics, ahead of the decision it may explain |
| `:706` | `DecisionPacket` | only when `task.packet` |
| `:737` | `OperatorRecommendations` | the operator card |
| `:745` | `ExecutionSection` | wraps `ExecutionProfile` |
| `:769` | `ScheduledActions` or the collapsed "Schedule a re-run" button | C8 |
| `:791` | `AgentLogsPanel` | `runtime.length > 0 && runsVisible` |
| `:814` | member gate panel | "Raw agent output, wire envelopes and provider session ids are limited to project members. The run summary above is public to signed-in users." |
| `:822` | `AttachmentsPanel` | only when `attachmentsBase` is set |
| `:834` | `Timeline` | |

**Dialogs (conditional, at the end):** `AcceptConfirm` (`:854`),
`ArchiveConfirm` (`:925`), `ReleaseConfirm` (`:938` — still mounted; its
trigger moved to the Current-state panel's Owner row after #186 removed the
owner-cell Manage popover), `ConfirmDialog` interrupt (`:954`), `ConfirmDialog`
dismiss-recommendation (`:969`).

**Diagnostics and readiness.** `ReadinessPill` (`app/ui/pill.tsx:98`) has exactly
**four** render sites, and they are two different things:

- `board-page.tsx:544` (card top) and `:800` (list row) — the task's own
  `displayReadiness`, suppressed on archived cards in favour of `ArchivedPill`,
  and — R21-8, #181 — rendered as **nothing** when
  `waiting === "agent" && displayReadiness === "input_required"` (the foot's
  WaitTag "agent working" speaks alone; the claim is made once, F15-09).
- `task-main-sections.tsx:206` — the same `displayReadiness` on the task hero,
  guarded by `!archived` (UXO-1) and by the same R21-8 yield (`:198-205`).
- `task-main-sections.tsx:67` — **one pill per diagnostic**, rendered from that
  finding's `readinessEffect` (pass-18 G2: a diagnostic's pill *is* its readiness
  effect, so the panel and the hero cannot disagree). `readinessEffect` is a
  per-diagnostic field derived server-side by `readinessEffectOf`
  (`app/server/interpretation/diagnostics-policy.server.ts:28`) and consumed by
  `task-query.server.ts`; a diagnostic with a `null` effect renders a neutral
  `heads-up` pill instead.

### 5.3 Decision-packet UI — `decision-packet.tsx` (969)

Exports `DELIVER_LABEL = "Deliver branch & open PR"` (`:40`), `observationLabel`
(`:80`), `observationValue` (`:93`), `PacketArchiveDisclosure`,
**`DecisionPacket` (`:384`)**. Private: `PacketArchiveConfirm` (`:138`),
`PacketDiscardConfirm` (`:292`).

**Pass-22 redesign (#180 questionnaire density + #182 minimal, owner rulings
2026-08-20/21 — mostly CSS, `app.css` "Decision packet — the questionnaire
card"):** the card is now a QUIET surface — hairline border with a **3 px left
tone accent** (`--yellow-dark` input / `--coral-dark` blocked) instead of the
old gradient wash + shadow; one type ramp (title .92 rem → obs .76 → option
title .82 → option detail .72); observations inside the card render as **flat
one-line rows behind a thin left rule** (`.packet-body .packet-obs` — the boxed
two-column `.obs` grid is kept ONLY for the acceptance/archive dialogs, whose
labels are short fixed vocabulary); options are dense and **top-aligned**
(radio/kbd markers pin to the title line), selection is a soft `--blue-soft`
fill + dot — no lift, no shadow; `.packet-actions` are natural-width,
**right-aligned with the primary LAST** ("Ask operator" moved to FIRST in the
row, `:855-870`); attribution is a whisper — `from <shield glyph> <name>` at
text size, the boxed `.agent-glyph.op` square is gone (`:576-583`); the custom
free-text option **no longer wears a dashed frame** (solid, one visual
language); the kind pill is `sm` (`:576`); fhints shortened ("resolves this
decision · handed to the operator" / "optional · recorded on the decision");
textareas shrank (directive `rows={2}`, note `rows={1}`).

There is **no `KIND_LABEL` map** here — behaviour branches per `o.kind`. The
canonical union is `PACKET_OPTION_KINDS` in
`app/schemas/task-file.schema.ts:74-101`, now **10 kinds**:
`accept_completion`, `request_edit`, `block_on_policy`, `hold_runtime_debug`,
`redirect`, `retry_other_backend`, `edit_goal`, `archive_task`,
**`discard_branch`** (pass-20 F20-6, `:99`), `custom`.

- **Options** — `role="radiogroup" aria-label="Decision options"` (`:613`) with
  its own arrow-key roving (a ref array, not `roving-radio.ts` — UI-44); each
  option is a `role="radio"` button (`:655`) with `aria-checked`,
  `aria-disabled`, roving `tabIndex`; blocked options dim to `opacity: .55`.
  `deletes branch` blocked-pill at `:702`; `operator pick` vs `recommended` pill
  at `:713` (`authoredByOperator` decides which word — attributing every rec to
  "operator pick" was a lie on a developer-authored packet).
- **Per-kind authority gates** (`:536-545`) with these refusal strings:
  `"Accepting completion is reserved for maintainers and this task's owner."` ·
  `"Editing the goal is reserved for maintainers and admins."` ·
  `"Archiving is reserved for maintainers and admins."` ·
  `"Discarding the branch is reserved for maintainers and admins."`
- **Confirm never resolves directly for two kinds:** `archive_task` →
  `PacketArchiveConfirm` (`:940`), `discard_branch` → `PacketDiscardConfirm`
  (`:955`). `accept_completion` is intercepted one level up by the page and
  routed through `AcceptConfirm` mode `"packet"`.
- The primary button's visible label is always `"Confirm decision"`; the
  accessible name is `Confirm decision: <option title>` (`:890-895`). On a role
  refusal it stays focusable with `aria-disabled` +
  `aria-describedby="pkt-block-reason"` (`BLOCK_REASON_ID`, `:30`).
- **F20-18 escalation** (`:829-852`) renders only for the contributor-owner
  whose *every* option is above their tier: "Every listed option needs
  maintainer or admin authority. You own {taskKey} and raised this decision,
  but settling it with one of them is above your role. You can still answer
  with your own directive above." + **Send to a maintainer** (intent
  `request-maintainer-decision`). (The em-dash phrasing recorded here at pass 21
  was rewritten by the P21 dash ban — copy-ban.test.ts `:940`.)
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

**The autonomy gate mirror (F20-9 / D1) is NOT in this file**, and #185
rebuilt its first half. Two halves:

1. `execution-profile.tsx` `OperatorRunControl` (`:478`) — **the per-run
   backend and autonomy `<select>`s are GONE** (owner request 2026-08-21, #185):
   both are configured on the deployed operator profile and the run resolves
   the LIVE profile, so a picker here was a second place for the same decision.
   The control now renders the profile's backend as text (`.op-backend`,
   `:521`, "Claude" / "Codex"), an **optional steer input** (`.op-steer`,
   `:522-535`, `aria-label="Steer this operator run (optional)"`, placeholder
   *"Optional: tell the operator what this run should focus on"*,
   `maxLength 2000`, Enter runs) and the **Run operator** button. The old
   *"Project policy: supervised…"* caption is gone; the mirror inverted —
   **full** autonomy now announces itself (`:566-572`): *"Full autonomy: this
   run can move the task and accept completion itself."* Supervised is the
   quiet default. An unconfigured profile backend disables Run and says so in
   rendered copy (`:554-564`): *"{Claude|Codex} isn't configured on this
   instance, so the operator can't run. Configure it, or switch the operator
   profile's backend."* The steer's fate is §5.1's `run-operator` intent
   (@operator timeline comment + the run's `humanComment`).
2. `agents-page.tsx:663` (`showDoneException`) / `:783-788` (render) — on the
   **operator card only**, when "Accept completion into Done" is granted while
   "Transition a task to Done" sits under *Reserved for humans*, the card
   borrows the Policy page's single canonical exception sentence
   (`TRANSITION_TO_DONE_EXCEPTION`, `policy-data.ts`) rather than restating it,
   so the two surfaces cannot drift. Rendered as `.cap-exception`
   (`agents-page.tsx:784`).

### 5.5 The acceptance ceremony — `accept-confirm.tsx` (496)

**One dialog, six modes** (`AcceptCeremonyMode`, `:50-57`):
`accept` · `force` · `complete-merge` · `apply-recommendation` · `packet` ·
`stage-move`. Rationale in the file header: ruling 20 says *every*
accept confirms, and four indirect writers used to merge silently.

- **Ruling 88 (pass-21 fixes):** `onConfirm` now receives an
  **`AcceptanceDisclosure`** (`:177`, built at `:254`) — the confirmed click
  echoes the facts THIS render disclosed back to the server, which compares the
  echo against the live task and refuses a stale disclosure.
- `data-screen-label="Accept completion dialog"` (`:272`); `role="alertdialog"`
  (`:262`) on a native `<dialog>` via `useDialog(onCancel)` (`:179`).
- Headings (`headingFor`, `:88`): "Force-accept this completion?" / "Run the
  merge now?" / "Apply this recommendation?" / `Moving to {terminal} accepts
  this completion` / "Accept this completion?".
- Rows: **Merges** (four branches including the pass-20 F20-6
  `noPullRequest` branch — *"**Nothing to merge yet.** …"* at `:343`),
  **Revision**, **Merge head** drift (R17-1), **Verdict** + `verdictSatisfiedBy`
  (R19-B human GitHub approval), **Skips** (force only), **Blocked**.
- Confirm labels: `Force-accept {KEY}` / `Merge PR #{n} into
  {defaultBranch}` / `Run the merge` / `{Apply|Move|Accept} → {terminal}[ &
  merge]`. Cancel is `"Not yet"` (`:464`).

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

### 5.8 Attachments, evidence, and the lightbox

`attachments-panel.tsx` (**127**). `AttachmentsPanel` (`:26`),
**exported** `IMAGE_RE` (`:24` — now also consumed by `timeline.tsx` for the
producing-comment previews), props `base` / `attachments` / `browserExpected`.

- `.attach-grid` of `.attach-thumb` anchors wrapping `<img loading="lazy">`
  (`:81`), `.attach-file` rows otherwise (`:109`); sizes via `prettySize` from
  `~/features/kb-browser/tree`. `data-comment-anchor="attachments"`.
- The pass-20 D8 empty state (`:48-63`) — returns `null` unless
  `browserExpected` (a deployed agent on this task holds `use-browser`),
  otherwise renders *"No attachments yet. A browser-capable agent on this task
  saves the screenshots and files it captures here, and none have landed. They
  appear the next time such an agent runs and produces evidence."* (dash-free
  since P21).
- Member-gated twice: the loader ships `[]` to non-members, and
  `routes/task-attachment.ts` re-checks membership on every fetch.

**The attachment lightbox — `attachment-lightbox.tsx` (111), NEW (#184).**
`useAttachmentLightbox` (`:44`) is a click-handler **factory**; `Lightbox`
(`:61`) is a `<dialog className="modal-card lightbox-card">` on `useDialog`
(`data-screen-label="Attachment lightbox"` `:73`, caption + **"Open original"**
link + close button); `AttachmentLightboxProvider` (`:99`) mounts once around
the task page. Contract: trigger surfaces stay REAL anchors to the serving
route — a plain left click is intercepted into the popup, while
cmd/ctrl/shift/alt/middle clicks pass through untouched; **without a provider
the factory is inert** and the anchor behaves exactly as before. Trigger
surfaces: the Attachments-panel `.attach-thumb`s (`attachments-panel.tsx:86`),
the timeline's `.tl-attach-thumb` picture cards, image-typed `.ev-file`
evidence tokens, and markdown-embedded task images (`.md-img-btn`, §9.1). CSS:
`cursor: zoom-in` on all three trigger classes; `.lightbox-card` sizes to the
picture (`max-height: 76vh`), `app.css` "Attachment lightbox" block.

**Producing-comment previews (#177, owner ask 2026-08-20)** — `timeline.tsx`
`TimelineItem` (`:175`): image attachments on an event render as
`.tl-attach-thumb` cards (capped 240 px / 150 px — "the timeline is a feed, the
panel is the gallery") right on the producing message (`:290-315`); non-image
files keep the `.tl-attach-chip` row.

**Evidence linkify** — `timeline.tsx` `EvidenceLabel` (`:132`): an evidence
label is split on whitespace; a token that, stripped of
backticks/quotes/trailing punctuation, **exactly matches a real attachment
filename** becomes `<a class="ev-file">` to the serving route; otherwise it
stays the plain text it always was. Image-typed tokens additionally open the
lightbox on plain click (`:159-162`). `TimelineItem` takes
`attachmentNames?: ReadonlySet<string>` + `attachmentsBase?`, and now threads
both into `CollapsibleComment` → `Markdown` for the link/embed repair (§9.1).

### 5.9 Timeline — `timeline.tsx` (584)

`TimelineItem` (`:175`) and `Timeline` (`:339`). `COLLAPSE_MAX = 340` (`:46`),
`CollapsibleComment` (`:57` — now takes `attachmentNames` / `attachmentsBase`
and passes them plus the lightbox factory into `Markdown`, so an agent-written
workspace-relative attachment link or embed in a comment body resolves — #177,
§9.1). Filter tabs are `.tl-filter` buttons with
`aria-pressed` (`:472-479`). The composer mounts at `:500`; the closed-task line
at `:492` ("This task is closed. Comments are still recorded."); the **UXA-1
honest comment scope** note at **`:518`**: *"Every project
member can comment · @mentions route to agents"*. Progressive disclosure
("Show older events · {n} more", `:578`) drives `?events=` through
`setSearchParams`; the math lives in `timeline-slice.ts`
(`TIMELINE_INITIAL_SLICE = 30`).

### 5.10 Side panels — `task-side-panels.tsx` (769)

`GithubTrace` (**`:26`**), `PolicyPanel` (`:356`, `<h2>Permissions</h2>` at
`:429`), `CurrentStatePanel` (`:465`, `<h2>Current state</h2>` at `:536`).
The F18-13 terminal-task force-accept withdrawal now lives at
`isTerminal` **`:107`**, `forceAcceptReason` **`:109`**, `forceAcceptRow`
**`:126`** (rendered at `:163` and `:339`).

**After #186, the Current-state panel's Owner row is the ONLY release
affordance** (`own-x` button, `:637` — self, or the `release-any-ownership`
tier): the exec-profile owner cell's Manage popover is gone (§5.12). A hand-off
survives inside `ReleaseConfirm`'s hand-off chips (release → "Release
{firstName}"), which that dialog still renders.

### 5.11 Run console — `app/features/runtime/`

| File | Lines | Notes |
| --- | --- | --- |
| `runs-panels.tsx` | 876 | `LiveRunPanel` (`:171`), **`AgentLogsPanel` (`:420`)**. Every folding is a no-op under the `{ } raw` toggle (`:615`, `aria-pressed`; follow at `:624`). **"show what this run was given" / "hide what this run was given" disclosure at `:783`.** Tool chips `.log-chip > .lc-name + .lc-detail`; file chips carry `FILE_KIND_MARK` glyphs `+ ~ −` (`:358`, used `:842`) as well as colour (WCAG 1.4.1). `ConsoleCode` (`:373`) with a copy button. Log stream is `aria-live="off"` (`:640`) deliberately. Backend-unavailable footer says **"Claude"** now (`:554`, `:571` — the label sweep) |
| `runs-helpers.ts` | 540 | Pure folding: `isThoughtLine`, `groupThoughts`, `thoughtLabel` (never invents a duration), `toolChip` (null when the provider sent no name), `fileChangeChips`, `consoleCodeBlock`, `diffLineKind`, `runInputRows` (the `mcp` row lists `viberr_browser` under `mounted:`), `agentMessageProse` |
| `use-run-log-stream.ts` | 526 | The EventSource client. The reload-only disconnect copy is now dash-free (P21): *"Live tail disconnected. Reload the page to resume following."* at **`:483`**. Still embeds literal `\0` bytes as cache-key separators (now lines **207, 209, 216**) — `grep`/`rg` report "binary file matches"; use `Read`/`grep -a` |
| `runtime-types.ts` / `log-clock.ts` / `log-noise.ts` | 298 / 65 / 80 | View types, clock formatting, telemetry collapse |

### 5.12 Other task-detail modules

- `task-main-sections.tsx` (628) — `DiagnosticsPanel` (`:49`), `TaskHero`
  (`:85`), `ScheduledActions` (`:295`), `ExecutionSection` (`:497`). The
  archived-task pill withdrawal (UXO-1) plus the R21-8 agent-working yield is
  at `:183-207`. The schedule form's backend `<select>` options now read
  **"Claude"** (`:436`).
- `execution-profile.tsx` (**938**, was 1064 — #186 deleted the Manage
  popover) — `ExecutionProfile` (`:593`) plus `OwnerControl` (`:200`),
  `SpecialistControl` (`:257`), `ReviewerControl` (`:364`), `OperatorRunControl`
  (`:478`, rebuilt by #185 — §5.4).
  **`OwnerControl` after #186:** unowned + `own-task`-capable → the "Take
  ownership" button; owned → **`return null`** (`:242-247`) — the cell shows
  the owner chip alone, no Manage popover, no hand-off list. `ExecutionProfile`
  and `ExecutionSection` no longer take `members` / `onRelease`. The
  `usePopoverFocus` hook (`:165`) survives for the Specialist/Reviewer assign
  menus (`:273`, `:387`), which still use the `.own-btn`/`.own-menu` classes.
  Engaged-agent rows print the backend from the query layer's **live-profile
  overlay** (#183, `deployedSpecialistBackends` —
  `agents-query.server.ts:372-425`), labelled "Claude"/"Codex" (`:776`,
  `:841`).
- `event-meta.ts` (82) — `EVENT_META` (`:25`), `eventMeta` (`:59`),
  `TYPED_KIND` (`:67`), `typedKind` (`:80`).
- `task-detail-hooks.ts` (243) — `useActionFeedback` (`:32`, the once-per-settled
  toast all the page fetchers route through), `useRunControls` (`:59`),
  `useLogSelection` (`:210`).
- `attachment-lightbox.tsx` (111) — §5.8.

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

### 6.3 GitHub connections — `connections-panel.tsx` (379 at HEAD)

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

### 6.6 Agent resources — `resources-panel.tsx` (311 at HEAD) + `resource-rows.tsx` (505 at HEAD)

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
  `{Claude|Codex} · {stages} · N context resource(s) · used in N project(s)`
  (`resource-rows.tsx:461` — "Claude", not "Claude Code", since `01daead`).

**R19-18 warming poll** (`resources-panel.tsx:113-122`): a 20 s `useRevalidator`
interval armed **only while some row is warming**. Deliberately a poll, not SSE —
the event vocabulary is a closed typed union routed by user/project/task scope
and an org-settings row fits none of them.

D8 empty states (`resource-rows.tsx:141`, `:305`, `:398`, `:485`) follow the same
shape: *absent → why it matters → next action*.

Modals: `resource-modals.tsx` (515 at HEAD, was 433 — grew in the pass-21 fix
window) — `KBModal`, `McpModal`,
`SkillModal`; `agent-template-modal.tsx` (402) — `AgentModal` (`:86`);
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

`app/routes/project.settings.tsx` (245 at HEAD) +
`app/features/project-settings/settings-page.tsx` (**1796** at HEAD — the
route now applies the shared credential redaction, F21-5, §8.3; intent/panel
anchors below are ce2bc9e-era).

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

### 8.2 Agents — `agents-page.tsx` (1619)

*Re-verified 2026-08-21 against `26fca45`.*

`StageEligibility` (`:408`), `LibraryPicker` (`:496`), `ProfileDetail` (`:601`),
`LiveRoster` (`:1055`), `AgentsPage` (`:1210`).
`.board-wrap[data-screen-label="Agents"]`, `Profiles | Live · N` seg with
`aria-pressed` (`:1420`/`:1429`), URL-as-state via `?profile=` and `?tab=live`.
Backend chips and roster rows read **"Claude"** (`:121`, `:1145` — the label
sweep).

- **UXA-15 read-only explanation at `:1476`** (now dash-free): *"Read-only:
  deploying, editing or removing agent profiles needs the **Manage agent
  profiles** grant, held by a project admin…"*
- **The operator** is split out under a group label **"Orchestration"**
  (`:1492`); it can never be deleted
  (`canDelete = a.kind !== "operator" && canManage`, `:701`); it
  gets an **Autonomy** cell where a specialist gets **Model**; and it is the only
  card that renders the Done exception (`showDoneException`, `:663`).
- **Save notices are plural now** (#176): `ProfileActionResult.notices` is an
  **array** of `{ kind: "repaired" | "withheld", message }` (`:1194`, pushed
  per-notice at `:1331-1333`; `routes/project.agents.tsx:121-128`) — a save can
  carry both a delivery-headline decision AND a browser→egress coupling.
- `create-profile-modal.tsx` (1251) — `CreateProfileModal` (`:948`). Body order:
  Identity → Backend → Autonomy (operator only) → Model/Effort → Stages →
  Definition/Persona → **CapabilityGrants** → **ResourcePicker**. The capability
  accordion has `aria-expanded` group headers and a third roving
  radiogroup.
- **Browser→egress coupling (#176, owner ruling 2026-08-20)** —
  `coupleGrants` (`create-profile-modal.tsx:140`) forces
  `use-web-search-fetch` to `direct` whenever `use-browser` is `direct`, applied
  on **every state write AND on seed** (a stored pre-rule profile renders
  already-coupled, F19 UX-13 round-trip honesty). While the browser is Allowed
  the egress row is **pinned** (`:702-710`): its radios are `disabled`, the
  radiogroup's `aria-label` reads *"(required by Drive a live web browser: the
  browser is web egress)"* and a `title` names the escape hatch ("Set the
  browser to Human-only or Off to change this"). Constants
  `BROWSER_CAP_ID` / `WEB_EGRESS_CAP_ID` live in `app/shared/capabilities.ts`;
  the save layer repairs hand-written contradictions identically
  (`agent-profile-actions.server.ts`) and reports via `notices`.
- `capability-matrix-modal.tsx` — read-only, shared by Agents and Policy.
- `capability-catalog.ts` projects `app/shared/capabilities.ts`. Agent
  groups: **Repository & execution** · **Collaboration** · **Reserved for
  humans**. Operator groups: **Assignment** · **Coordination** · **Permissions** ·
  Collaboration. `use-browser` ("Drive a live web browser")
  is a Collaboration entry, **default `off`** — it
  renders as a toggle in both profile editors, a row in the matrix, and a row on
  Policy's capability table; its ONE bespoke behaviour is the egress pinning
  above. A granted-but-refused browser surfaces in the run
  console's "what this run was given" disclosure as
  `viberr_browser … granted but NOT mounted`.

### 8.3 GitHub — `github-view.tsx` (652)

`RepositoryPanel` (`:46`), `PullRequestsPanel` (`:174`), `BranchesPanel`
(`:268`), `GithubViewPage` (`:405`). `.board-wrap[data-screen-label="GitHub"]`.
Pill vocabulary is centralised in `github-pills.ts` (145): `syncPill`,
`prStatePill` (`:47`), `checksPill`, `reviewPill`, `mergeablePill`,
`connectionPill`; toast copy in `github-copy.ts` (80).

**R19-11 / Q-V1 credential redaction is now complete on BOTH routes (F21-5,
pass-21 fixes — supersedes the pass-21 doc's "settings does not" verdict and
§11 item 15):** the rule moved into the shared
`features/github/credential-visibility.server.ts` (`credentialGrantHolder`
`:40`, `withoutCredentialDetail` `:70`). `project.github.tsx:62-64` and
`project.settings.tsx:76-78` both apply it; below the `grant-github-scope` tier
the loaders redact and the views **withdraw** the credential card
(`github-view.tsx`; `settings-page.tsx:1340-1352` — the F21-5 comment block —
renders `CredentialCard` only when `canGrant`).

### 8.4 Review queue — `review-page.tsx` (305)

`ReviewQueuePage` (`:164`), `RQRow` (`:48`).
`.board-wrap[data-screen-label="Review queue"]`, `<h1>Review queue</h1>`, two
sections: **"Waiting on your acceptance"** (`:236`) and **"Still in review"**
(`:284`). UXA-2: PR state colour comes from the canonical `prStatePill`
(imported `:6`, used `:92`/`:96`) — no local map.

### 8.5 Activity — `activity-page.tsx` (819 at HEAD)

Grew 623→819 in the pass-21 fix window: a new `FeedFilters` control block
(search + kind/actor/task-id + from/to date filters, `role="group"` with
per-field `aria-label`s) landed on both feeds; the anchors below are
ce2bc9e-era except as noted. `ActivityPage` (`:616` at HEAD).
`.board-wrap[data-screen-label="Activity"]` (`:678`),
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
| `toast.tsx` | 267 | `ToastKind = "success" \| "error"` (`:19`) — exactly two, and **the glyph is the entire signal** (`check` vs `alert`; both kinds paint `var(--fg)`). `useToasts` (`:58`), `ToastProvider`, `useToast`. `TOAST_DISMISS_MS = 2600`, `TOAST_EXIT_MS = 200`, `TOAST_STACK_CAP = 4` (`:30`, `:31`, `:50`). Two-phase dismissal: `leaving: true` at 2600 ms plays the fade-down (`:77`), removal at 2800 ms — but a toast **evicted by the cap is removed immediately with no leaving phase** (animating an exit caused by an arrival misreads as the new toast pushing the old one). The host is the app's ONE announcer: `<div popover="manual" role="status" aria-live="polite" aria-atomic="false">` (`:217-228`) promoted to the top layer via `showPopover()`, with a two-commit dance so the live region is observed before it changes, and re-insertion when the set of open `<dialog>`s changed (the top layer is insertion-ordered) |
| `use-action-toast.ts` | 26 | `useActionToast(fetcher)` — dedupes by `data` identity, then `push(data.ok ? data.toast : data.error, data.ok ? "success" : "error")`. The toast path for ~11 fetchers (project settings, GitHub, Policy) |
| `use-fetcher-result.ts` | 27 | Once-per-result guard for **client-computed** messages (the handler is ref'd, so an inline arrow neither re-fires nor closes over stale state) |
| `use-dismiss.ts` | 110 | `useDismiss(open, onDismiss, { also?, onReflow?, outside? })` — outside-press (`mousedown`, not `click`), Escape, and optional capture-phase scroll/resize close, for **non**-dialog popovers. Explicitly not `useDialog` (`:15`): no focus trap, no top layer, no scroll lock. Replaced seven hand-rolled copies |
| `pill.tsx` | 157 | `PillKind` (8 values, `:15`), `Pill` (`:25`), `ReadinessPill` (`:98`), `ValidationPill` (`:144`). `ReadinessPill` carries an `activity` glyph as well as colour, and an **unrecognised value falls back to a neutral "unknown" pill, never to green "ready"** (C12, `:77-86`). Validation labels: healthy → "validation healthy", changed → "awaiting verdict", failing → "validation failing", none → "no validation", bypassed → "accepted · gate bypassed" (risk tone) |
| `stage-menu.tsx` | 213 | The board's and task hero's accessible stage-change menu — the keyboard path drag deliberately does not provide. Popover is **portaled to `document.body`** and rect-positioned, so `useDismiss(…, { onReflow: true, also: [btnRef] })` closes it on scroll/resize; `role="menu"` with `role="menuitemradio"` items, `onMenuKeyDown` (`:111-141`) handling ↑/↓ wrap, Home, End and Escape-returns-focus. The **only** file in the gate's `VIEWPORT_READS` |
| `markdown.tsx` / `rich-text.tsx` / `mention-spans.ts` | **267** / 94 / 109 | Comment rendering, typed-event rich text, the one `@mention` matcher shared with the Lexical composer. **`markdown.tsx` grew 171→267 (#177/#184):** `repairAttachmentHref` (`:150`) rewrites an agent-written workspace-relative attachment link (`../../attachments/x.png`, `attachments/x.png`, or the bare filename) to the serving route **only when** the last segment names a real task attachment — absolute/protocol URLs and other paths pass through untouched; `componentsFor` (`:172`) applies it to both `a` and `img`; an embedded TASK image (recognised by serving-route prefix) renders inside a `button.md-img-btn` (keyboard-reachable, `aria-label="Open attachment {name}"`) that opens the lightbox via the `onAttachmentImageClick` factory prop. `Markdown` (`:234`) takes optional `attachmentNames` / `attachmentsBase` / `onAttachmentImageClick`; absent (every non-task surface) ⇒ links and embeds render exactly as written (`DEFAULT_COMPONENTS`) |
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

CSS side: `dialog[data-closing]` at `app.css:1812-1819` plays the reverse of
`pop-center`; `.cmdk-card[data-closing]` has its own variant (`:1884`); the
reduced-motion block collapses it to a 120 ms opacity fade (`:3829`).

**Call sites (25 across 19 files):** `agents-page` ×2, `capability-matrix-modal`,
`create-profile-modal`, `board-page`, `credential-card`, `home-sections`,
`new-project-modal`, `store-browser` ×3, `mini-modal`, `users-panel`,
`settings-page` ×2, `command-palette`, `accept-confirm`, `archive-confirm`,
`decision-packet` ×2, `release-confirm`, `confirm-dialog`, `page-overlay`,
**`attachment-lightbox`** (new, #184).

### 9.3 The ⌘K palette — `command-palette.tsx` (234 at HEAD)

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
`task:<slug>/<key>`) and `buildEventsUrl`. `use-live-updates.ts` (**229** at
HEAD, was 141 — the pass-21 fix window added OBS-6: after two consecutive
failed opens with no success between, the client asks the server what is wrong
instead of retrying a dead session's 401 forever) —
`REVALIDATE_DEBOUNCE_MS = 300` (`:40`) trailing debounce; **revalidation IS the
update mechanism** (no optimistic state, no client caches); `stream.open` never
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

- **`app/app.css` — 4455 lines (re-verified at `26fca45`) — is the only
  stylesheet in the app.** Verified:
  the only other `.css` files in the repo are `design/html-app/app/*.css`, the
  static design mock, which nothing imports (and which is in oxlint's
  `ignorePatterns`). The only CSS import chain is `app/root.tsx:1-12`.
- **No Tailwind.** No `tailwind*` or `postcss*` config, no dependency,
  `vite.config.ts` plugins are `[reactRouter()]` only. The two literal "Tailwind"
  strings in the tree are a comment (`app.css:3127`, *"no Tailwind, no inline
  hex"*) and an unrelated test-local `interface TailWindow`. **There is no
  `--viberr-*` token layer either — both were removed long ago.**
- **New class families since pass 21** (#180/#182/#184/#185, #177): the
  redesigned `.packet` block ("Decision packet — the questionnaire card",
  `app.css:1093-1206` — left-accent card, flat `.packet-body .obs` evidence
  rows, dense `.opt` rows with `.opt.sel` fill, right-aligned
  `.packet-actions` `:1206`); `.op-backend` + `.op-steer` (the operator run
  control, `:1314-1323` — replacing the deleted `.op-sel`); `.tl-attach-thumb`
  (timeline picture cards, `:4412-4422`); the lightbox block (`.md-img-btn`,
  `.modal-card.lightbox-card`, `.lightbox-img`, `.lightbox-foot`,
  `:4424-4450`) with `cursor: zoom-in` on all three trigger classes (`:4430`).
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

Dark theme is `:root[data-theme="dark"]` (`:2607-2647`), overriding **28** of
them; `--hairline`, `--shadow-ring`, the fonts, `--ease-out`, the radii and the
layout tokens intentionally inherit. `:root { color-scheme: light }` at `:2606`.

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

*Re-verified 2026-08-21 against `26fca45`.*

**2503 lines, 20 top-level `describe` blocks, 84 `it`s** (the pass-21 fixes
added a 20th describe and 4 `it`s). No nested describes, no `.skip`/`.only`.

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
| 888 | `app.css palette reachability on touch (P16-G3)` |
| 1101 | `app.css draws a task key the same way everywhere (P16-F3 follow-on)` |
| 1153 | `app.css .obs label column fits its longest label (F19-3 follow-on)` |
| **1165** | `app.css owns static styling, not the JSX (P16-F3)` |
| 1210 | `app.css lets a container-sized button wrap (F19-42)` |
| 1241 | `app.css owns the shared idioms — hoisting is not an escape hatch (F19-33)` |
| **1824** | `app.css: every pair it paints clears WCAG AA, in both themes (R19-12)` |
| **2260** | `app.css hides no control at any width (R19-12)` |
| **2394** | `app/ gates no rendering on the viewport (R19-12)` |
| **2447** | `app.css field chrome covers every text-like input type (P21)` — **new** (pass-21 fixes): every `type="…"` a `.field` uses must be named in the `.field input[type=…]` chrome rule |

Key anchors:

- **Token resolution** — `undefinedTokens` computed `:113-116`,
  `expect(undefinedTokens).toEqual([])` at **`:118`**.
- **Focus ring** — `ringRule` regex `:179`; one app-wide `:where(…):focus-visible`
  with `outline: 2px solid var(--blue)` asserted at `:186-188`; `:where()` wrap
  checked `:217`; 3:1 ring contrast `:231`; wrapper rings for the two borderless
  search fields `:245`.
- **WCAG AA gate** — `const AA_SMALL_TEXT = 4.5` at **`:427`**; the whole-sheet
  successor sweep is the `:1824` block.
- **No-allowlist whole-tree class scan** — describe `:602`;
  `const CLASSLESS_BY_DESIGN = {}` — **empty** — at **`:600`**;
  `expect(orphans).toEqual([])` at `:650`; canaries `files.length > 150` and
  `used.size > 500`.
- **Inline-styling budget** — describe `:1165`; "leaves no `style={{…}}` whose
  every value is a literal"; **`expect(sites.length)
  .toBeLessThanOrEqual(20)` at `:1193`** ("holds the line at 20 sites" — a
  ceiling, not a target; 182 → 20 historically).
- **`RENDERED_INSIDE`** nesting map at **`:1591`**, 6 entries all nested in
  `.console` (`log-line`, `log-chip`, `log-file`, `lcaret`, `log-more`,
  `log-more-note`) — this is what lets the console's literal-hex palette be
  measured against `.console`'s own near-black fill rather than `--bg`.
- Other rot-guarded exemption maps: `GLYPH_NOT_TEXT` (`:1620`, 1),
  `BELOW_AA_BY_DESIGN` (`:1628`, 2), `UNFIXED_BELOW_AA` (`:1641`, 10 selectors),
  `RENDERS_NO_CONTROL` (`:2091`, 2), `HIDDEN_BY_DESIGN`
  (`:2176`, 4), `UNFIXED_HIDDEN` (`:2192`, **0**), `VIEWPORT_READS` (`:2197`, 1 —
  `app/ui/stage-menu.tsx`).

### 10.3 The copy-ban lint — `app/features/copy-ban.test.ts` (1031)

*Re-verified 2026-08-21 against `26fca45`.*

**F18-14 / G4.** `design/CONVERSATION-SUMMARY.md:22` bans
*govern/governor/governance* in human-read copy — use **Maintainer** (human
role), **Permissions** (panel), **managed**.

- **Banned regex, `:142`:** `/\bgovern(ance|ed|or|ors|ing|s)?\b/i`. `\b`-anchored,
  so identifiers like `isGoverned` are out of scope by construction.
- **THREE describes now.** `:637` `F18-14: the govern/governance copy ban
  holds on every surface a human reads`; **`:940` `P21: em/en dashes are banned
  in rendered copy and seed assets` — NEW in the pass-21 fixes**
  (`BANNED_DASH = /[–—]/` at `:931`; this is the gate that rewrote the
  escalation, UXA-15 and board-toast sentences quoted in this doc); `:1005`
  `F19-12: the retired 'primary specialist' vocabulary is gone from copy`.
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

*Counts re-verified 2026-08-21 against `26fca45`; the per-site line numbers in
the lists below are pass-21-era and have drifted (files re-anchored elsewhere in
this doc carry the fresh numbers).*

- **`aria-pressed` on mini-seg / seg / pick-chip / fchip toggles — 41 production
  sites in 13 files.** The rule (UI-58) is that `role="radiogroup"` with plain
  buttons is
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
- **`aria-expanded`** — 19 sites (stage menu, tree rows, bell, rail toggle,
  palette, user menu, settings, profile modals, run console folds, timeline,
  composer, the exec-profile assign menus — the owner Manage popover's site was
  deleted by #186).
- **`aria-live`** — 5 regions: the toast host (`toast.tsx:223`, `polite`, the
  app's ONE announcer), the board's D9 drag announcements
  (`board-page.tsx:1980`, `role="status"` + `SR_ONLY`), the store-browser upload
  note, the continuity panel (`continuity-recovery.tsx:286`), and the run log
  stream at **`aria-live="off"`** deliberately (`runs-panels.tsx:640`).
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

*Verified 2026-08-19 against `ce2bc9e` — this section is a HISTORICAL ledger
(pass-20 doc → ce2bc9e). Its line numbers and file lengths are ce2bc9e-era; the
Pass-22 revision section at the top carries what changed after. Item 15 is
struck below — it is no longer true at HEAD.*

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
    canonical exception sentence). *(At HEAD, #185 rebuilt the first half — the
    autonomy select is gone entirely and full autonomy announces itself as a
    caption instead; §5.4.)*
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
15. ~~**Q-V1's PAT half is still open.**~~ **SUPERSEDED — closed by F21-5 in
    the pass-21 fixes (PR #175).** The verdict above was true at `ce2bc9e`:
    `/projects/:slug/settings` shipped the full `ProjectCredentialHealth` to
    every member and rendered `CredentialCard` unconditionally. At HEAD both
    routes share `features/github/credential-visibility.server.ts`
    (`credentialGrantHolder` / `withoutCredentialDetail`);
    `project.settings.tsx:76-78` redacts below the `grant-github-scope` tier
    and `settings-page.tsx:1340-1352` **withdraws** the card (`canGrant` gate).
    See §8.3.
16. **`use-run-log-stream.ts` grew 457→521 lines.** The reload-only disconnect
    was at `:476-478`, and the file **still embeds literal `\0` bytes** as
    cache-key separators. `grep`/`rg` still report "binary file matches" and
    print nothing on this file; use `Read`/`sed`/`grep -a`. *(At HEAD: 526
    lines, the copy is dash-free at `:483`, the `\0` lines are 207/209/216 —
    §5.11.)*
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
