# Viberr UI/UX inventory — pass 17 (2026-08-04, post-implementation)

Written for an implementation agent with **no other context**. Everything here was read out of the
tree at commit `8541a32` (branch `main`, clean) — i.e. **after** the three pass-16 implementation
waves (`5e03c6e` correctness, `53b796d` UI/UX, `71fa506` wave 3, `0955ac9` runtime). Paths are
repo-relative; `file:line` refs point at the current tree and will drift — treat them as
"start reading here", not as identifiers.

This document **supersedes** `planning/discovery-2026-08-04/UI-INVENTORY.md`, which was written at
commit `2442945` and describes the tree *before* those waves. Read §0 first if you already know the
old doc; read §1 onward if you don't.

**One-paragraph orientation.** Viberr is a React Router v8 (framework mode, SSR) app for supervising
AI agents that do real work on real git branches. There is **one** stylesheet (`app/app.css`, 3936
lines), **no** CSS framework, **no** component library, **no** Tailwind. Tokens are **unprefixed**
(`--bg`, `--fg`, `--blue`) — there is no `--viberr-*` layer and never was (pass-16 G9 corrected that
record). Layout is CSS grid/flex with per-component rem values. State lives in the URL and in loader
data; there is essentially no client store. Mutations are `useFetcher().submit(FormData)` against the
*current route's* action, discriminated by an `intent` field, and the UI re-renders from a
revalidated loader — **not** from optimistic local state. Live updates arrive over one SSE connection
per tab that only ever triggers `revalidate()`.

Contents:

0. [Delta from the pass-16 doc](#0-delta-from-the-pass-16-doc)
1. [Route table](#1-route-table)
2. [Per-page anatomy](#2-per-page-anatomy)
3. [Design system](#3-design-system)
4. [Motion vocabulary](#4-motion-vocabulary)
5. [Shared UI primitives](#5-shared-ui-primitives)
6. [Client data flow](#6-client-data-flow)
7. [Accessibility posture](#7-accessibility-posture)
8. [Enforcement gates (what fails the build)](#8-enforcement-gates-what-fails-the-build)
9. [Remaining rough edges](#9-remaining-rough-edges)
10. [Deliberate divergences from the UX spec](#10-deliberate-divergences-from-the-ux-spec)

---

## 0. Delta from the pass-16 doc

The pass-16 doc's §1–§7 are still broadly accurate as *architecture*. What changed is concentrated
in its §8 ("27 known rough edges") — most of that list was implemented — plus a large structural
split of the biggest files. If you are carrying a mental model from the old doc, these are the
corrections that matter.

### 0.1 Files that did not exist before (all new modules)

| new file | what moved into it | from |
|---|---|---|
| `app/ui/use-dismiss.ts` (110) | THE "Escape + outside-press closes me" hook | 7 hand-rolled copies |
| `app/features/shell/use-command-palette.ts` (36) | THE ⌘K binding | 2 copies (topbar + home) |
| `app/shared/text/plural.ts` (34) | `pluralNoun` / `countLabel` | inline `n === 1 ? "" : "s"` everywhere |
| `app/shared/text/store-extensions.ts` (41) | THE store-text-extension set (isomorphic) | 3 hand-maintained copies |
| `app/features/task-detail/task-main-sections.tsx` (535) | `DiagnosticsPanel`, `TaskHero`, `RecommendationsSection`, `ScheduledActions`, `ExecutionSection` | `task-detail-page.tsx` |
| `app/features/task-detail/task-side-panels.tsx` (589) | `GithubTrace`, `PolicyPanel`, `CurrentStatePanel` | `task-detail-page.tsx` |
| `app/features/task-detail/task-detail-hooks.ts` (190) | `useActionFeedback`, `useRunControls`, `useLogSelection` | `task-detail-page.tsx` |
| `app/features/task-detail/accept-confirm.tsx` (138) · `archive-confirm.tsx` (131) · `release-confirm.tsx` (189) | the three task dialogs | `task-detail-page.tsx` |
| `app/features/home/home-sections.tsx` (631) | `HomeTopBar`, `HomeHero`, `EmptyHero`, `ProjectSections`, `OrgTile`, `SettingsPanel`, `StoreStrip`, `RebuildConfirm` | `home-page.tsx` |
| `app/features/home/project-cards.tsx` (273) | `StarIco`, `StageMeter`, `ProjectStats`, `MemberStack`, `ProjectCard`, `ProjectRow` | `home-page.tsx` |
| `app/features/home/new-project-modal.tsx` (569) | the whole New-project modal + its six field components | `home-page.tsx` |
| `app/features/org-settings/resource-rows.tsx` (411) | `KbPanel`, `McpPanel`, `SkillPanel`, `AgentPanel` | `resources-panel.tsx` |
| `app/features/org-settings/resource-modals.tsx` (423) | `KBModal`, `McpModal`, `SkillModal` | `resources-panel.tsx` |
| `app/features/org-settings/agent-template-modal.tsx` (387) | `AgentModal` | `resources-panel.tsx` |
| `app/features/org-settings/resource-helpers.ts` (47) | `rel`, `isStaleCheck`, `useModalAction`, `useBusyRow` | `resources-panel.tsx` |
| `app/features/review/review-helpers.ts` (77) | `reviewRowSub` (R16-3 refusal ordering) | inline in `review-page.tsx` |

The three "files > 1200 lines" of the old §8 item 17 are gone as such:
`task-detail-page.tsx` **1761 → 538**, `home-page.tsx` **1691 (grown to 1739) → 297**,
`resources-panel.tsx` **1471 → 259**. The largest client files now are
`project-settings/settings-page.tsx` **1559** (it grew: dnd-kit + a Move menu),
`agents/agents-page.tsx` **1385** (grew: credential health), `board/board-page.tsx` **1330**,
`kb-browser/store-browser.tsx` **1251**.

### 0.2 The old §8 rough edges, dispositioned

| old # | claim in the pass-16 doc | current state |
|---|---|---|
| 1 | No app-wide `:focus-visible` ring (4 selectors only) | **FIXED.** One `:where(...)` rule, `app/app.css:179`. The four per-selector copies are gone; two borderless fields get a wrapper ring |
| 2 | 10 class names in TSX with no CSS rule | **FIXED + gated.** All defined; `app.css.test.ts` now diffs *every* className in `app/` against the sheet, no allowlist (`CLASSLESS_BY_DESIGN` is `{}`) |
| 3 | `.composer-box` has no `position: relative` | **FIXED.** Both `.composer-box` and `.composer-input` are real rules and the test asserts they are containing blocks |
| 4 | 184 inline `style={{…}}` | **FIXED to 20**, and the test parses each survivor and fails any whose values are all literals |
| 5 | `<select>` has no design-system treatment | **FIXED.** One base `select` rule at `app.css:130` mirroring `.field input`; `appearance` deliberately left native so the popup follows `color-scheme` |
| 6 | project-settings stage list is hand-rolled HTML5 drag *with a grip* | **FIXED.** dnd-kit, gripless, server-authoritative, same sensors/plugins as the board, plus a per-row `StageMoveMenu` keyboard path it never had. **KB browser is still HTML5 drag** — that one is file *upload*, deliberately not the same verb |
| 7 | ⌘K listbox structurally broken for AT | **FIXED.** `role="combobox"` + `aria-expanded` + `aria-activedescendant`; options are direct children of the listbox via `role="group"`; the empty result has its own `role="status"` |
| 8 | ⌘K bound twice | **FIXED.** `useCommandPaletteShortcut`, one hook, and it now ignores `altKey` so ⌥⌘K is not swallowed |
| 9 | `--font-display` declared twice | **FIXED.** Declared once (`app.css:64`, Manrope-first); pinned by test |
| 10 | `.card.wait-human` no-op | **FIXED** (deleted, pinned by test) |
| 11 | `.top-search` identical as input and as button | **FIXED as a differentiator, not a merge.** Same silhouette (R15-5 needs the topbar tiers), but `button.top-search` takes a filled face + a `--muted` **label** ("Search…"), Home's stays a white well with a placeholder |
| 12 | Two Escape idioms; 6 hand-rolled popovers | **FIXED.** `useDismiss` at 7 sites: `top-bell`, `user-menu`, `stage-menu`, 3 menus in `execution-profile`, `runs-panels` AgentPicker, plus `settings-page`'s StageMoveMenu |
| 13 | Toast stack unbounded | **FIXED.** `TOAST_STACK_CAP = 4`, oldest drops, no exit animation on cap-eviction |
| 14 | `.board-wrap::after` fade unconditional | **FIXED** with a **scroll-driven animation** (`scroll-timeline: --board-scroll-x`), so a board that fits paints nothing; `[data-motion="reduce"]` restores `animation-duration: auto` because it is an indicator |
| 15 | mobile rail scrim is `<button aria-hidden>` | **FIXED.** It is a `<div className="rail-scrim" aria-hidden onClick>`; the keyboard path is the topbar toggle + Escape (`topbar.tsx`), and an e2e test asserts no hidden interactive scrim |
| 16 | Breakpoint sprawl; 1100px does 8 jobs in 9 blocks | **FIXED.** Nine `max-width: 1100px` blocks became **one** (`app.css:3911`); the whole breakpoint set is pinned by test with the job each value does |
| 17 | three files > 1200 lines | **FIXED** (see §0.1) |
| 18 | axe sweep covers 6 surfaces, never a dialog | **FIXED.** 12 surfaces in both themes (adds activity, project settings, github, org settings, profile, notifications) **plus** 3 dialogs audited in their open state, plus signed-out login |
| 19 | `Icon` uses `dangerouslySetInnerHTML` | **unchanged** — still true, still from a frozen local map |
| 20 | `.mention` chip is colour-only for AT | **FIXED.** A `.mention-vh` visually-hidden "mention " word sits *beside* the chip (not inside it, so the chip's text content stays the literal span the shared matcher produced); `user-select: none` so copying yields the author's text |
| 21 | two SSE consumers, two disconnect stories | **unchanged** — `use-live-updates.ts` backs off and retries; `use-run-log-stream.ts` still says "reload the page" |
| 22 | PAT input is `type="text"` | **FIXED.** `type="password"` + `autoComplete="off"` + `spellCheck={false}` + `data-1p-ignore` (`connections-panel.tsx:135`) |
| 23 | four SVG icon sources | **partly changed**: `StarIco` moved to `home/project-cards.tsx:18`, `mini-modal.tsx` and `kb-browser/icons.tsx` still ship their own. Still four sources |
| 24 | `.stg-x` drifted into a generic icon button | **FIXED.** `.stg-x` is neutral by default (`app.css:2271`) and the destructive sites are named explicitly with `:not(.off)` so self-guarded controls read unavailable, not threatening |
| 25 | three "row actions on hover" idioms, touch-hostile | **FIXED.** `.fm-acts` is deleted — KB row actions are always drawn; `.card-move` keeps the hover reveal on pointer devices but `@media (hover: none)` draws it unconditionally |
| 26 | only two `aria-live` regions; the toast host is the only announcer | **root cause FIXED, coverage still thin.** The toast host was *inert whenever any modal dialog was open* — it entered the top layer in the same commit its first message appeared, which is the one case screen readers do not announce. It now takes its slot **empty** and commits the message a frame later, and re-arms above a dialog opened since. `aria-atomic="false"` (explicit, because `role="status"` implies `true` and would re-read the whole 4-deep stack) |
| 27 | `.gh-table .live-head` overrides the grid globally | **FIXED**, pinned by a test that each `.live-table` owns its own column template |

### 0.3 Corrections to the pass-16 doc's own factual claims

- **"25 route modules"** — there are **26** non-test route modules under `app/routes/` (the doc
  likely omitted `project._index.tsx`). `app/routes/project-visibility.server.ts` is a helper, not a
  route.
- **`app/app.css` is 3936 lines**, not 3419. `app/app.css.test.ts` is 1006 lines, not a handful of
  checks — it is now the primary UI gate (§8).
- **Token line numbers moved**: light `:root` is `app.css:7–78`-ish still, but dark is
  `:root[data-theme="dark"]` at **`:2438`** (was `:2197`), with its nine fixups at `:2480–2488`.
- **`--font-display` is declared once**, at `:64`. The old doc's "declared twice, Manrope wins" is
  no longer true (the answer is the same, the duplicate is gone).
- **The `.detail`-side dialogs are no longer inside `task-detail-page.tsx`** — `AcceptConfirm`,
  `ArchiveConfirm`, `ReleaseConfirm` are their own modules.
- **Task-detail's "13 fetchers"** is still 13, but they are now spread across four files
  (see §2.8) — a grep of `task-detail-page.tsx` alone finds only 5.
- **`e2e/` specs were renumbered** in wave 3 (`01-home-board`, `02-feeds-profile`,
  `03-org-settings-store`, `04-palette-mobile`, `05-task-comment-composer`,
  `06-activity-hydration`, `07-accessibility`, `auth.setup`).
- The old §9's "board drag results announce nothing" is **still true** — the dnd-kit `Accessibility`
  plugin is still off on both the board and the stage list, deliberately, and no live region
  replaced it. The toast fix (26) is what makes the *toast* audible; the drag itself still is not.

### 0.4 New behaviour/copy the old doc does not mention at all

- **`data-screen-label`** — a new attribute on ~20 surface roots (`board-page.tsx:1242`,
  `home-page.tsx:222`, `command-palette.tsx:136`, `page-overlay.tsx:25`, `pj-card`/`pj-row`, …).
  It names a screen for tooling/e2e without adding an ARIA claim.
- **`formatClock` zero-pads** both fields (`app/shared/dates/format.ts`) — the audit log said
  "today 0:18" before. The UTC and local passes share one `clock()` so the hydration swap can't
  drift on padding.
- **Board filter `risk` is labelled "Blocked or waiting"** and its predicate now includes
  `input_required` (R16-2, `board-filters.ts:50`).
- **Board card PR pill** comes from the shared `prStatePill` mapping (`board-page.tsx:304`), so a
  merge-pending or closed PR is visible on the card (R16-6).
- **Review-queue subline ordering** (R16-3): a `closed` PR outranks the process gate
  (`review-helpers.ts:reviewRowSub`); a `merged` PR does not.
- **Refusals are `aria-disabled` + visible reason + `aria-describedby`**, not `title` on a
  `disabled` element (`decision-packet.tsx:311-317`; policy radios likewise). Only transient /
  structural refusals (`busy`, "no options") stay genuinely `disabled`.
- **Agents page reports backend credential health** ("idle · Codex not configured") instead of
  claiming "available" (`agents-page.tsx:640`, F16).
- **Home's search box collapses to a 36px magnifier below 900px** instead of disappearing
  (`app.css:3571`, P16-G3) — a phone used to lose both the project finder and the only palette
  trigger.
- **Project settings gates each panel on the action its own server guard checks** — which is
  `edit-policy` for identity/stages/repo and `manage-members` only for members
  (`settings-page.tsx:1379-1381`), not `myRole === "admin"`.
- **`button { background: none }`** is in the element reset (`app.css:112`) and is load-bearing:
  without it, a class-less button keeps the UA `ButtonFace`, which Chrome resolves per
  color-scheme (#efefef light, **#6b6b6b dark**) and tanked contrast on the org-settings tab rail.

---

## 1. Route table

Route config is **explicit**, not file-convention: `app/routes.ts`. There are **26** route modules.

### 1.1 Layout tree

```
root (app/root.tsx, 221)                  <html>, ToastProvider, RoutePendingBar, theme boot script
├── /                       _index.tsx     own <main class="home-shell"> (no shell)
├── /login                  login.tsx      own .login-wrap (no shell, body scrolls)
├── /logout                 logout.tsx     resource
├── /org/settings           org.settings   own <main class="home-shell"> (Home-style chrome)
├── /profile                profile.tsx    PageOverlay (<dialog>) over whatever was below
├── /notifications          notifications  PageOverlay (<dialog>)
├── /projects               projects.tsx   redirect → /
├── /projects/:slug         project.tsx    ◀ THE WORKSPACE SHELL: .app grid = Rail | main(Topbar+Outlet)
│   ├── (index)             project._index redirect → /board
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
| `/` | `app/routes/_index.tsx` | own | Home: project grid/list, org tiles, store strip | `requireUser`; projects for viewer, home prefs, org summary, notifications(100), unread; `storeRoot` only for org admins | `pin`, `view`, `rescan`(admin), `rebuild-projections`(admin), `create-project` |
| `/login` | `routes/login.tsx` | own | Sign-in + forced password reset | `authenticate`; redirects if signed in; returns `mode`, `returnTo`, `providers.{github,google}` | `login`, `set-password`; `assertTrustedOrigin` first |
| `/logout` | `routes/logout.tsx` | resource | Sign out | redirect `/` | CSRF + audit + better-auth signOut → redirect `/login` |
| `/org/settings` | `routes/org.settings.tsx` | own | Instance settings: org profile, users, connections, resources (KB/MCP/skills/agent templates), store browser | `requireRole("admin")` | ~30 intents: `connection-*`, `user-*`, `invite-*`, `domain-remove`, `kb-*`, `mcp-*`, `skill-*`, `agent-*`, `store-*` |
| `/profile` | `routes/profile.tsx` | PageOverlay | Account, notification routing, theme + motion prefs | `requireUser` + `getProfileView` | `identity`, `set-notif`, `set-motion`, `set-tl-default`, `change-password`, `github-disconnect` |
| `/notifications` | `routes/notifications.tsx` | PageOverlay | Full notification inbox (bell shows top 100) | over-fetches `NOTIF_PAGE_LIMIT+1` (200) to compute `truncated` | — (posts to `/notifications/read`) |
| `/notifications/read` | `routes/notifications.read.tsx` | resource | Mark read | redirect | `read` (repeated `id` fields) / `read-all` |
| `/prefs/theme` | `routes/prefs.theme.tsx` | resource | Theme write + `Set-Cookie` | redirect `/` | single-purpose; exports `headers` so the cookie survives |
| `/api/auth/*` | `routes/api.auth.$.ts` | resource | better-auth splat handler | forwards raw `Request` | same; no app CSRF (better-auth enforces Origin) |
| `/resources/events` | `routes/resources.events.ts` | resource (SSE) | Live-update stream | see §6.4 | — |
| `/resources/run-log` | `routes/resources.run-log.ts` | resource | Run-log tail / backward page | `?runId` + `?since` or `?before&limit` (clamped 1..500); `requireProjectMember` | — |
| `/resources/health` | `routes/resources.health.ts` | resource | Ops probe `{ok, projections, watcher, kbWatcher, backends}` | **unauthenticated by design** | — |
| `/resources/search` | `routes/resources.search.ts` | resource | ⌘K palette query | `requireUser`, `q` truncated to 120 chars | — |
| `/resources/model-catalog` | `routes/resources.model-catalog.ts` | resource | Model + reasoning-effort picker data per backend | — | — |
| `/resources/session-export` | `routes/resources.session-export.ts` | resource | Downloads a bash installer carrying a run transcript | membership-gated, `Content-Disposition: attachment` | — |
| `/projects` | `routes/projects.tsx` | resource | Bare `/projects` is not a 404 | redirect `/` | — |
| `/projects/:slug` | `routes/project.tsx` | **shell** | Rail + Topbar + `<Outlet/>`; supplies board, counts, notifications, `myRole`, `orgAdminOverride` | viewer-scoped `waitingOnMe`; `meta` | — |
| `…/board` | `routes/project.board.tsx` | shell | Kanban board / list view | **none** — reads the layout loader | `create-task`, `reorder`, `rescan` |
| `…/review` | `routes/project.review.tsx` | shell | Review queue (triage list) | viewer-scoped queue + `stageNames` + `acceptance` | — |
| `…/agents` | `routes/project.agents.tsx` | shell | Agent profiles master-detail + live roster | roster, library, deployments, stages, workflow, resource catalog, **backend credential health** | `create-profile`, `deploy-profile`, `update-profile`, `delete-profile` (payload is a JSON blob in a `payload` field) |
| `…/policy` | `routes/project.policy.tsx` | shell | Human access + agent capability + workflow rules | — | `set-role`, `set-boundary` |
| `…/github` | `routes/project.github.tsx` | shell | Repo/branch/PR truth + PAT credential card | async `getGithubViewData` | `reconcile`, `grant-scope`, `set-credential`, `clear-credential` |
| `…/activity` | `routes/project.activity.tsx` | shell | Event stream + audit log, paginated via `?stream=`/`?audit=` | — | — |
| `…/settings` | `routes/project.settings.tsx` | shell | Project identity, stages, members, repo, danger zone | — | `save-project`, `rename-stage`, `add-stage`, `remove-stage`, `reorder-stages`, `invite`, `remove-member`, `repair-repo`, `set-branch-cleanup`, `grant-scope`, `set-credential`, `clear-credential`, `archive-project`, `delete-project`(→`redirect("/")`) |
| `…/tasks/:key` | `routes/project.task.tsx` | shell | **Task detail — the deepest surface** | run rows redacted for non-members (`runsVisible`); timeline sliced by `?events=` | **24 intents** — see §2.8 |

Notes that matter when adding a route:

- No route exports `shouldRevalidate` or `handle`. Only `prefs.theme.tsx` exports `headers`; only
  `project.task.tsx:857` exports an `ErrorBoundary`. The root `ErrorBoundary` (`app/root.tsx:178`)
  renders the `.app-splash` panel for everything else and reads a thrown `data("<copy>", {status})`
  string as the page copy.
- Guard helpers: `requireUser`, `requireAuth` (needs `sessionId` for CSRF), `requireRole("admin")`,
  `requireProjectMember`, `authenticate` (no redirect), and
  `app/routes/project-visibility.server.ts` `requireVisibleProject` — which rethrows a refusal as a
  **404 byte-identical to the unknown-slug 404** (R15-4). **Pass 16 closed the last leak**: the
  board's `create-task` used to answer a non-member with 403 while everything else answered 404
  (E2). Every project action now 404s.
- Action plumbing: `app/server/auth/form-action.server.ts` `requireFormAction(request)` returns
  `{auth, db, formData, actor, intent}` after doing auth + `assertCsrf`. The discriminator field is
  **`intent`**, never `_intent`.
- Three fetcher-only routes (`profile`, `prefs.theme`, `notifications.read`) use
  `app/features/shell/csrf-result.server.ts` `csrfError()` so an expired token becomes a
  `{ok:false,error}` result (→ error toast) instead of blowing to the error boundary.

---

## 2. Per-page anatomy

### 2.0 The shell (every `/projects/:slug/*` page)

`app/routes/project.tsx:168+`

```
<div class="app" data-rail-open>       grid: var(--rail-w)=232px | 1fr, height 100vh
  <SkipLink/>                          app/ui/skip-link.tsx — bypass block, focus-revealed
  <Rail/>                              app/features/shell/rail.tsx (86)
  <div class="rail-scrim" aria-hidden onClick/>   mobile dismiss layer — a DIV now, not a button
  <main class="main" id="main-content" tabIndex=-1>
    <Topbar/>                          app/features/shell/topbar.tsx (190)
    {archived && <div class="archived-banner" role="status">}
    <Outlet/>
```

- **Rail** (`rail.tsx`): `<nav aria-label="Primary">`, project switcher → `/`, then `WORKSPACE_NAV`
  (`app/features/shell/nav.ts`) = Board, Review queue, Agents, Policy, GitHub, Activity, Settings.
  Counts: board (all tasks incl. Done — deliberate keep), review, and violations (rendered only when
  `> 0`). Active state is `activeView` from `workspaceViewFromPathname` (task routes map to `board`),
  set on a plain `Link` with `aria-current="page"` — deliberately **not** `NavLink`, whose match
  wouldn't cover `/tasks/:key`. The Board item alone preserves `?filter/view/q` via `boardHref`.
- **Topbar** (`topbar.tsx`): rail toggle (mobile only, CSS-gated, `ref` held so **Escape closes the
  rail and returns focus to it** — the keyboard half of the scrim dismissal), brand → `/`,
  `<nav class="crumbs" aria-label="Breadcrumb">` with `aria-current="page"` on the leaf, optional
  `org-admin override` pill, optional **`live updates paused — retry`** pill (`role="status"`), the
  ⌘K trigger (`topbar.tsx:170`, a **button** with `aria-haspopup="dialog"`, a visible
  `.top-search-label` "Search…" and a `.kbd` modifier hint), `TopBell`, `UserMenu`.
  **⌘K/Ctrl-K comes from `useCommandPaletteShortcut`** — one hook, shared with Home.
- One SSE subscription per tab for the whole workspace: `project.tsx:150` subscribes
  `project:<slug>`, `task:<slug>/<key>` when a task is open, and `user`.

### 2.1 Home — `/` → `app/features/home/home-page.tsx` (297) + 3 sibling modules

`home-page.tsx` now holds only the page's state, its four fetchers (prefs/pin/view, re-scan, rebuild,
palette) and the composition. The pieces:

| piece | where | notes |
|---|---|---|
| `HomeTopBar` | `home-sections.tsx:30` | brand, real search **input** (a project finder), `.kbd` chip that opens ⌘K, `TopBell`, `UserMenu`. Below 900px the whole box **collapses to a 36px magnifier button** (P16-G3) rather than disappearing |
| `useLocalGreeting` | `home-sections.tsx:129` | corrects the server greeting client-side |
| `HomeHero` | `home-sections.tsx:144` | grid/list `seg` with `aria-pressed` |
| `EmptyHero` | `home-sections.tsx:242` | zero-project teaching state |
| `ProjectSections` | `home-sections.tsx:272` | pinned / all / archived `<section data-screen-label>`s |
| `ProjectCard` / `ProjectRow` | `project-cards.tsx:166` / `:223` | compose `StageMeter` `:37`, `ProjectStats` `:108`, `MemberStack` `:156`, `UpdatedLabel` `:98`, `Avatar`, `Pill`, `StarIco` `:18` |
| `OrgTile` / `SettingsPanel` | `home-sections.tsx:425` / `:453` | admin-gated `Link`, inert `div` otherwise |
| `StoreStrip` | `home-sections.tsx:533` | admin only: Re-scan, Rebuild projections — copy now says it is **admin-only recovery**, not a landing-page feature (F13) |
| `RebuildConfirm` | `home-sections.tsx:591` | `role="alertdialog"` |
| `NewProjectModal` | `new-project-modal.tsx:370` | native `<dialog>` + `useDialog`; fields `NewProjectNameFields` `:21`, `…ConnectionField` `:105`, `…RepoField` `:200`, `…WorkflowField` `:252`, `…PolicyField` `:269`, `…Footer` `:319`. `selectDerivedOnFocus` `:194` is the F14 fix — a manually-focused derived repo name is selected, so typing replaces instead of appending ("viberrviberr") |
| `CommandPalette` | shared | opened by `useCommandPaletteShortcut` |
| `SkipLink` | `home-page.tsx:225` | target `<main class="home-shell" id="main-content" tabIndex={-1}>` `:239` |

Four fetchers, zero `<Form>` elements. Home prefs are read optimistically off `prefsFetcher.formData`
— the one place Home guesses ahead of the server, and only for view/pin.

### 2.2 Board — `/projects/:slug/board` → `app/features/board/board-page.tsx` (1330)

Structure: `BoardHeader` (`:761` has the single `<h1>Board</h1>`) → `FilterBar` → `OrphanBanner`
(`.board-orphans`, `role="status"`, `:1274`) → `StageBoard` (or `ListView`) → `NewTaskModal`.

- **URL is the state.** `filter`, `view`, `q` in `useSearchParams`, written with
  `{replace: true, preventScrollReset: true}`. `FILTERS` `:712` = all / waiting on human / waiting
  on agent / **"Blocked or waiting"** (`risk`) / archived (archived chip only when `archived > 0`).
  Predicates are pure in `app/features/board/board-filters.ts` — `matchesBoardFilter:32` now covers
  `blocked | input_required | inconsistency_risk_detected | validation failing | urgent | pr closed`
  (R16-2 closed the "amber chip the filter hides" incoherence), `matchesSearch:101`,
  `boardEmptyCopy:149`.
- **Card** `TaskCard`: `ReadinessPill`, `<h3>`, `OwnerLine` / `ReviewerStack`, foot with short
  branch, a **PR chip driven by the shared `prStatePill` mapping** (`:304`, R16-6 — merge-pending
  and closed are visible on the card, not only on the detail page), `checksPill`/`reviewPill`
  (rendered **only when actionable**), `ValidationPill`, `WaitTag`.
- **Drag** — see §5.6. Whole card, no grip, server-authoritative.
- **`StageMenu`** (`app/ui/stage-menu.tsx`) is rendered as a *sibling* of the card `Link` inside
  `.card-move` and per-row in `ListView`. It is the keyboard/AT path for stage moves and posts the
  **same** `reorder` intent with `beforeKey: ""`. `.card-move` is hover-revealed on pointer devices
  and **drawn unconditionally under `@media (hover: none)`** (`app.css:846`).
- `NewTaskModal` — native `<dialog>` with title input, stage `pick-chips`
  (`role="group" aria-labelledby`), goal textarea. It **no longer shows "A title is required"
  before first input** (F15). Not a `<form>`; submit builds `FormData`.

### 2.3 Review queue — `app/features/review/review-page.tsx` (230) + `review-helpers.ts` (77)

Deliberately a **triage list with no primary action** (owner ruling R15-11): rows are buttons that
navigate to the task page, labelled `Review ›` (`.rq-go`, `aria-hidden`) and carrying
`aria-label="Review VIB-N: <title>"`. One `<h1>Review queue</h1>` at `:130`. No forms, no fetchers.

The subline is now `reviewRowSub` in `review-helpers.ts`, and its **ordering is a ruling**
(R16-3): a **closed** PR is a terminal GitHub fact and outranks the process gate, so the row says
"rework and reopen it, or archive the task" instead of "…no approving verdict yet — an admin can
force-accept" — the one override the task page withholds once the PR is gone. A **merged** PR does
*not* jump the gate (its "accept the completion" line would become the lie if a process gate is
genuinely holding). Order: closed PR → `blockReason` → packet → live PR state → newest timeline
event → a waiting-appropriate fallback.

### 2.4 Activity — `app/features/activity/activity-page.tsx` (409)

`.activity-cols` = stream panel (1.55fr) + `AuditLogs` (1fr), collapsing to one column at 1100px
(now in the single consolidated block). Loader-only: **no action, no fetchers, no dialogs, no menus**.
Root carries `data-screen-label="Activity"` (`:289`).

- Stream panel: actor filter `mini-seg` (`role="group"` + `aria-pressed`) placed *inside* the panel
  it filters; "N of M events (filtered)"; day groups; rows use `actIcon(r.type)` (keyed on
  `TIMELINE_EVENT_TYPES` so a new event type is a compile error), `ActivityText` (240-char preview
  + Show more with `aria-expanded`), and a `keybtn` task-key button.
- `AuditLogs` is deliberately **unfiltered** ("policy & access · all actors").
- Pagination writes `?stream=` / `?audit=`; limits in `feed-limits.ts`
  (`STREAM_STEP 200 / MAX 2000`, `AUDIT_STEP 60 / MAX 600`).
- **Hydration**: `useHydrated()` picks UTC formatters for the first pass, then regroups
  viewer-local. The grouping *key* is absolute-UTC on purpose (`groupStreamByDayUTC`,
  `auditTimeLabelUTC` in `feed-helpers.ts`). Both passes share one `clock()` in
  `app/shared/dates/format.ts`, so the F19 zero-padding fix could not desync them. Gated by
  `e2e/06-activity-hydration.spec.ts` (Auckland viewer vs UTC container).

### 2.5 Agents — `app/features/agents/agents-page.tsx` (1385)

Master-detail: `aside.profile-list` of `ProfileItem` + `ProfileDetail`, with a Profiles/Live `seg`.
URL state: `?profile=`, `?tab=`. One `<h1>Agents</h1>` at `:1170`.

`ProfileDetail` composes `ProfileGlyph`, `StageEligibility` (marks stale stage ids), a capability
policy panel of three `CapColumn` filtered to `GOVERNED_CAP_LABELS`, plus a collapsed
`<details class="cap-advisory">` for non-governed grants (R15-12 — collapse, never hide), a
context-resources panel of three `ResGroup` (dangling grants render `missing`, still clickable to
remove), a runtime row, and active deployments.

**New in pass 16 (F16): per-backend credential health.** `primaryBackendHealth` (`:101`) is the
page's one answer to "is this profile actually runnable". The roster read "idle · available" no
matter what while the task-level Execution panel, one click away, read "Codex — not configured".
Now: `idle · {backend} not configured` (`:640`), a card-level note ("`{backend}` has no usable
credential on this instance", `:802`), and deployment copy that says assigning it "would produce a
refused run". The create/edit modal disables an unavailable backend.

Four dialogs: `DeleteConfirm` (`role="alertdialog"`), `LibraryPicker`,
`CreateProfileModal` (`app/features/agents/create-profile-modal.tsx`, 998 — create *and* edit in
one), `CapabilityMatrixModal` (`capability-matrix-modal.tsx`, 256, read-only, shared with Policy —
it now carries the **R16-5 disclosure**: MCP grants sit outside the capability matrix on purpose,
and the disclosure names the consequence).

One fetcher. Note the **inconsistency**: this page passes a **plain object** to `fetcher.submit`
(not `FormData`), with the whole profile serialized into a single `payload` JSON field.
`create-profile-modal.tsx` holds its own GET fetcher for `/resources/model-catalog?backend=…`.

### 2.6 Policy · Notifications · Profile · GitHub · Settings · Org settings · KB browser

**Policy** — `app/features/policy/policy-page.tsx` (620). Three exported panels: `HumanAccess` `:46`
(per-member role control, a `.mini-seg` with `role="radiogroup"` / `role="radio"` / `aria-checked`),
`AgentCapability` `:238` (opens the shared `CapabilityMatrixModal`), `WorkflowRules` `:357`
(transition-boundary `.cap-seg` radiogroups). Two **different** RBAC gates on one page:
`canSetRole` = `manage-members` `:538`, `canEditPolicy` = `edit-policy` `:539`. Intents `set-role`,
`set-boundary`; toasts via `useActionToast`.

Two pass-16 corrections live here: the page no longer claims view/comment are **app-wide**
("membership not required") when enforcement 404s non-members — the `appWide` concept was *deleted*
from `app/shared/rbac.ts` so the Policy table, the Profile page and the task Permissions panel read
one matrix (E1); and role-refused radios are `aria-disabled` with a **visible** `.deny-note` reason
bound by `aria-describedby` (`:432-435`), never a bare `disabled` control (E4).

**Notifications** — `app/features/notifications/notifications-page.tsx` (274), rendered in a
`PageOverlay`. Fully presentational (`onRead` / `onReadAll` / `onOpen` props); the route owns the
fetcher. Two sections: *Waiting on you* (`.rq-list` of `.rq-row` buttons — clicking marks read
**then** opens; the header count ignores the All/Unread filter and adds "N hidden by the filter")
and *Everything else*, whose rows are deliberately plain `<div class="pol-ev ntf-ev">` and **not**
`role="button"` (UI-54) — instead they contain a focusable `.keybtn` task link and, for unread rows,
an explicit labelled **"Mark read"** button. Mark-read is monotonic and only the bulk case toasts.
Dedupe (one card per task, newest wins) lives in `notifications-page-helpers.ts`.

**"Waiting on you" is now computed once** (`indexDecisionInbox`) for both the inbox and the Home
cards (E6), so the two surfaces cannot answer it differently — an org admin's override reach is
governance, not a personal inbox item.

**Profile** — `app/features/profile/profile-page.tsx` (914), also a `PageOverlay`. `.profile-cols`
with `ProfileIdentity`, `ProfileNotifications`, `ProfileAppearance`, `ProfileAccess`,
`ProfileGithub`, `ProfilePassword`. **Two preference toggles post to two different routes**:

| control | shape | posts to |
|---|---|---|
| Theme (Light/Dark/System) | `.mini-seg` | **`/prefs/theme`** on its own fetcher; applies `applyThemePreference` optimistically, rolls back + error-toasts on failure; re-picking the active theme is a no-op |
| Reduce motion | `TglP` | **`/profile`**, `intent: "set-motion"`; flips local state *and* `document.documentElement.dataset.motion` immediately, rolling back both on failure |
| Timeline default | `.mini-seg` | `/profile`, `intent: "set-tl-default"` |
| Notification routing | `TglP` per row | `/profile`, `intent: "set-notif"`, on a **separate** fetcher from Appearance (UI-56) |

Identity edits commit on blur (Escape also commits). GitHub *connect* is not a fetcher at all — a raw
`fetch("/api/auth/sign-in/social")` then `window.location.href`.

**GitHub** — `app/features/github/github-view.tsx` (494): `RepositoryPanel` `:42`,
`PullRequestsPanel` `:132` (`.rq-list` rows → task detail), `BranchesPanel` `:213`
(`.gh-table > .live-table` with `.live-head`/`.live-row` — each `.live-table` now owns its own
column template, no global override), `GithubViewPage` `:315` with the `.gh-freshness` chip and an
**Update status** button gated on `roleCan(myRole,"reconcile-github")`. Pills come from the shared
`github-pills.ts` (which is also where `prStatePill` lives — the one PR-state → pill mapping used by
the board card, the queue and this page). The wave-3 style migration replaced ~12 inline style
objects here with real classes (`.fine`, `.probe-note`, `.v.plain`, `.pol-note.last`, `.empty.sm`,
`.live-branch`).

`app/features/github/credential-card.tsx` (264) is *the* shared credential card — also rendered by
project settings. Scope chips render **proven verdicts only**: an unverifiable fine-grained-PAT
scope collapses into one honest "unproven — verified on first use" line or `.scope-chip.assumed`
(dashed, muted), never a pseudo-check. A **zero-scope classic PAT no longer lands on
`source:"assumed"`** (B11). The footer resolves in strict priority order: revoked/expired →
missing scope (with a `.keybtn` deep-link to the flagged task) → unverified → green `.cred-ok`.
**PAT entry does not live here** — the only token input in the app is
`connections-panel.tsx:133`, and it is `type="password"` now.

**Project settings** — `app/features/project-settings/settings-page.tsx` (**1559**, the largest
client file): `ProjectPanel` `:58`, `StagesPanel` `:600`, `MembersPanel` `:761`, `RepoPanel` `:1026`,
`DangerZone` `:1240`.

- **Stage reorder is dnd-kit now** (the pass-16 doc's biggest single UI correction). `STAGE_SENSORS`
  `:239` and `STAGE_PLUGINS` `:266` mirror the board exactly: `PointerSensor` with
  `preventActivation` on `button, input, select, textarea`, mouse = Distance(5px), touch =
  Delay(250ms, tol 5), `KeyboardSensor`, and the `Accessibility` plugin **filtered out** for the same
  `nested-interactive` reason. **The `.stg-handle` grip is gone** (`.stg-handle.off`, `:537`) — the
  whole row drags, matching the board's affordance ruling. The reorder math is
  `resolveStageOrder(stages, moveId, beforeId)` `:285` — pure, unit-tested, the direct counterpart of
  `board-dnd.ts:resolveBoardDrop`, returning `null` for no-ops (dragging onto a neighbour used to
  POST a no-op and toast success) and degrading a vanished target to end-of-list, then pinning the
  entry stage first and the terminal stage last by current identity. Emits `reorder-stages` with
  `orderedIds`.
- **`StageMoveMenu`** `:354` + `stageMoveOptions` `:323` is the keyboard/AT path the list never had
  — the same shape as the board's `StageMenu`, dismissed by the shared `useDismiss` (`:371`).
- **Inline rename**: edit mode is lifted to `SettingsPage` so a fresh `add-stage` response drops the
  new row straight into edit mode. The row swaps `<button class="stg-name">` for
  `<input class="stg-input" autoFocus>`; **Enter blurs, Escape cancels, commit happens on blur**.
- `AddStageControl` `:163` is name-first — the button becomes an inline `.stg-add` field in place.
- Dialogs: `RepairRepoDialog` `:931` (footprint-ack checkbox, stays open on a failed probe) and
  `DeleteProjectDialog` `:1180` (`role="alertdialog"`, typed-name confirm).
- **Per-panel RBAC is action-id-based** `:1379-1381`: `canEditPolicy` (`edit-policy`) governs
  identity, stages and repo; `canManageMembers` (`manage-members`) only the members panel;
  `canGrant` (`grant-github-scope`) the credential card; `canManageLifecycle` (`edit-policy`,
  `:1263`) the danger zone. The tests mock `roleCan` **per action id**, so swapping two ids that
  share a role tier today still fails (E3).

**Org settings** — `app/features/org-settings/`. Shell `org-settings-page.tsx` (118): `.set-head`
(back button + `<h1>Instance settings</h1>` — R15-13) and `.set-layout` = sticky `.set-nav` rail +
`.set-content`. **Tab state rides the URL** (`?tab=`); each `.nav-item` carries `aria-current` and a
`.count` badge. (The `.nav-item` here is the button whose UA `ButtonFace` background tanked dark
contrast until `button { background: none }` landed — see §3.5.)

- `mini-modal.tsx` (128) — `MiniModal` is the shared modal chrome (native `<dialog class="modal-card">`
  + `useDialog`, `.modal-head`/`.modal-body`/`.modal-foot`, Save genuinely `disabled` +
  `aria-disabled`); `ConfirmDelete` is the `role="alertdialog"` `.confirm-card`.
- `use-org-action.ts` (64) — every org mutation goes through it: `useFetcher` + `_csrf` +
  `{method:"post", action:"/org/settings"}`, default toast from the server's `toast`/`error`, or the
  raw result handed to `onResult` for modals that want an inline `.cred-warn` and close-on-success.
- `connections-panel.tsx` (356) — `.conn-list` of `.conn-row`; `ConnectionModal` holds the app's only
  PAT field (`type="password"`, `autoComplete="off"`, `spellCheck={false}`, `data-1p-ignore`);
  `SCOPES = ["repo","pull_request:write"]`.
- `users-panel.tsx` (764) — `.member-list` of domain-allowlist rows then user rows, each with an
  `IdpChip`, status pills, an Admin|Member `.mini-seg`, and four `.stg-x` icon buttons. Self-guards
  are **error toasts**, not hidden controls. Modals: `InviteModal` (three-way `.be-pick.three`
  GitHub/Google/Local picker), `EditUserModal` (inline `user-reset-password` surfaces the temp
  password **once**), `DisableUserDialog`, two `ConfirmDelete`s. Counts go through
  `countLabel` now ("1 instance account", not "1 instance accounts").
- **Resources is now four files**: `resources-panel.tsx` (259, the `ResourcesPanel` shell and
  `StoreBrowser` launch), `resource-rows.tsx` (411 — `KbPanel` `:18`, `McpPanel` `:130`,
  `SkillPanel` `:247`, `AgentPanel` `:333`), `resource-modals.tsx` (423 — `KBModal`, `McpModal`,
  `SkillModal`), `agent-template-modal.tsx` (387 — `AgentModal`), `resource-helpers.ts` (47 —
  `rel`, `isStaleCheck`, `useModalAction`, `useBusyRow`). MCP health is a `.stat-dot`
  `up`/`down`/`stale`; orphaned grants are removable red `.pick-chip.missing.on`.

**KB / store browser** — `app/features/kb-browser/store-browser.tsx` (1251). A `<dialog class="modal-card
modal-wide">` with a **layered dismiss handler** (Escape closes the new-folder row first, then the
open editor, then the modal) via `useDialog`'s `onDismissRequest`; nested `DeleteConfirm` /
`ReplaceConfirm` are their own dialogs at `zIndex 71` (`.confirm-card.over-modal`, `app.css:3874`)
and the card goes `inert` while one is open.

- Tree `.fm-tree` / `.fm-row` with `paddingLeft: 0.6 + depth*1.3rem`; a dir row toggles, a text file
  row opens the editor. **Editability now comes from the shared
  `app/shared/text/store-extensions.ts`** (`STORE_TEXT_EXTENSIONS`) — the injector, the server-side
  editor and this browser had three hand-maintained copies, which is exactly how the first
  divergence shipped (C5). The browser runs in the browser and cannot import a `.server` module,
  which is why that file exists.
- **Row actions `.fm-acts` are gone.** Actions are **always drawn** (`store-browser.tsx:423`): the
  hover reveal was mouse-only, so on a touch device Delete was tappable with nothing on screen to
  explain it. `.fm-act` / `.fm-act.del` are the surviving classes (`app.css:3539`).
- **Drag-drop upload** is HTML5 (`.fm-row.droptgt`, `.fm-tree.droptgt`), inferring folder mode when
  any `relPath` contains `/`. Two hidden `<input type="file">` clicked programmatically. Uploads post
  multipart `files[]` + `filePaths[]` and drive a `.def-note aria-live="polite"` busy row. This is
  the app's **second** drag idiom and it is deliberate — it is file *ingest*, not reordering.
- **In-app document editor** `.fm-doc` with its own read/save fetchers so a failed read never rides
  the generic store toast; **the draft is preserved on failure** (UI-60); a `truncated` read
  disables Save.
- New-folder row: Enter commits, **blur dismisses rather than commits** (P13-UI-23), Escape
  `stopPropagation`s so the dialog's native cancel doesn't also fire.

### 2.7 Runtime panels — `app/features/runtime/runs-panels.tsx` (632)

Rendered inside task detail. `LiveRunPanel` (`.runbar`, `data-comment-anchor="live-run"`) only
renders while something is running: `.live-dot`, phase + current step, four `.run-cell` stats
(elapsed via `useElapsed`, turns, tokens, model), View logs, and a conditional Interrupt.
`AgentPicker` `:52` is a **listbox dropdown**, not a `<select>` — `aria-haspopup="listbox"`,
`role="listbox"`/`option`/`aria-selected`, Escape/↑/↓ keyboard. Its dismissal is
`useDismiss(open, …)` `:72` now (it previously had **no document-level Escape at all**).

`AgentLogsPanel` (`data-comment-anchor="agent-logs"`): `.logs-bar` with the state pill,
`SessionIdChip` (click to expand the id, copy with a 1400ms "copied" flip, and a plain
`<a download href="/resources/session-export?run=…">`), an optional *Retry on Claude Code/Codex*
button, and two `aria-pressed` chips — `{ } raw` and `follow`. The `.console` is `role="log"
aria-live="off"` (streaming lines must not flood AT) and re-arms `follow` when the user scrolls back
within 48px of the bottom. **"Load older" is a button, not scroll-linked**: it snapshots
`{scrollHeight, scrollTop}`, turns `follow` off, and a `useLayoutEffect` re-anchors `scrollTop` after
the prepend. Consecutive telemetry rows fold into one `.log-line.meta` (`collapseTelemetry`,
`log-noise.ts`).

### 2.8 Task detail — `app/features/task-detail/` (six modules, was one file)

The product's deepest surface, `.detail` = `minmax(0,1fr) 340px`. Component is remounted with
`key={task.key}` (`routes/project.task.tsx:827`). The page root carries
`data-screen-label={"Task " + task.key}`.

| module | lines | holds |
|---|---|---|
| `task-detail-page.tsx` | 538 | the page shell, 5 fetchers, `onOwner`/`submitArchive`/`onResolve`, the composition |
| `task-main-sections.tsx` | 535 | `DiagnosticsPanel` `:39`, `TaskHero` `:71`, `RecommendationsSection` `:223`, `ScheduledActions` `:268`, `ExecutionSection` `:402` |
| `task-side-panels.tsx` | 589 | `GithubTrace` `:21`, `PolicyPanel` `:241`, `CurrentStatePanel` `:345` |
| `task-detail-hooks.ts` | 190 | `useActionFeedback` `:20`, `useRunControls` `:47`, `useLogSelection` `:157` |
| `decision-packet.tsx` | 341 | the loud amber/red packet panel |
| `accept-confirm.tsx` / `archive-confirm.tsx` / `release-confirm.tsx` | 138 / 131 / 189 | the three `role="alertdialog"` dialogs |

`.detail-main` (in order — this ordering *is* the "operator-first" spec contract):

1. `TaskHero` — key, `<h1>`, goal with **inline edit** (`goalFetcher.Form`, the only real
   declarative `<Form>` in the app), hero file chip
2. `LiveRunPanel` (`runtime/runs-panels.tsx`) — pulsing run strip
3. `DiagnosticsPanel`
4. `DecisionPacket` — options are a real `role="radiogroup"` with roving `tabIndex` and arrow keys;
   per-option authority refusals are **rendered copy**. **E4 fix**: the Confirm button used to put
   its block reason in `title` on a `disabled` element, which a browser guarantees nobody can read;
   it is now `aria-disabled` + a refusing click handler (so the control keeps focus and its
   description) with the reason as **visible text** bound by `aria-describedby` (`:311-317`). Only
   `busy` / "no options" stay a real `disabled`.
5. `RecommendationsSection` → `operator-recommendations.tsx`
6. `ScheduledActions` — the one `fetcher.Form` that `preventDefault()`s and re-submits
   programmatically
7. `ExecutionSection` → `execution-profile.tsx` (819) — 4-cell grid: Operator (backend + autonomy
   `<select>`s + Run), Delivering agent, Reviewers, Human owner. Three hand-rolled popover menus
   (`aria-haspopup="menu"` + `role="menu"`/`menuitem`) — all three now use `useDismiss`
   (`:105`, `:254`, `:355`)
8. `AgentLogsPanel` — dark console; replaced by a membership-gate notice when `runsVisible === false`
9. `Timeline` (`timeline.tsx`, 421)

`.detail-side`: `GithubTrace` → `CurrentStatePanel` (`.kv-row` facts + a `StageMenu` + `.state-acts`
action block) → `PolicyPanel` (which now states **members-only**, matching enforcement).

**13 fetchers**, all setting `_csrf`, all routed through `useActionFeedback` (toast + optional
`navigateTo`, once per `fetcher.data` via a handled ref). They live in four files now:

| fetcher | file |
|---|---|
| `ownerFetcher`, `resolveFetcher`, `archiveFetcher`, `acceptFetcher`, `deliverFetcher` | `task-detail-page.tsx:147,148,151,233,245` |
| `goalFetcher`, `recFetcher`, scheduling fetcher, `specialistFetcher`, `reviewerFetcher`, `operatorFetcher` | `task-main-sections.tsx:93,231,278,437,438,439` |
| `transitionFetcher` | `task-side-panels.tsx:383` |
| `runFetcher` (run-interrupt, retry, complete-merge, force-accept) | `task-detail-hooks.ts:61` |
| the comment composer's | `timeline.tsx:246` |

`useRunControls` also carries the **R16-3 acceptance rule**: `acceptanceTerminallyBlocked` withholds
force-accept while the PR is closed — the recovery packet is the path.

`Timeline`: filter tabs (All / Important / Comments, `aria-pressed`), the composer block (§5.5),
then events via `TimelineItem` → `eventMeta` (`event-meta.ts`), `Markdown` for comments and
`RichText` for typed events, `CollapsibleComment` clamping over 340px with a mask fade. Slicing is
`?events=` + `timeline-slice.ts` (initial 30, step 30). The composer's containing block is
`<div className="composer-input" ref={composerBoxRef}>` (`:348`) — the class has a real CSS rule now
and the inline `style={{position:"relative"}}` is gone.

---

## 3. Design system

### 3.1 Canonical source and how it maps

- `design/design-system.html` — the ported **design system page** (tokens, type, spacing/radius,
  state vocabulary, component gallery). This is where `--blue: #5b76fe`, the pastel semantic pairs
  and the Roobert/Noto/JetBrains stack come from.
- `design/html-app/app/*.jsx` + `design/html-app/app/viberr.css` — the **React prototype** every
  product surface was ported from, screen by screen.
- The porting contract is `docs/architecture/decisions.md` § "UI porting rules":
  *reproduce structure, class names and behaviour 1:1*; replace prototype-only bits with real
  routes/loaders/actions/SSE; **record deliberate departures in a comment at the departure site**;
  keep the classes and CSS variables exactly; add new CSS only in clearly-marked appended sections;
  **no Tailwind, no inline hex — a `var(--x)` that is not defined in `:root` is a bug.**

Two token values were intentionally tightened during the port: `--radius-card` 18px → **16px** and
`--radius-panel` 28px → **22px**. `--radius-large: 44px` and `--pink` were dropped.

### 3.2 Token vocabulary — `app/app.css` `:root` (light) / `:root[data-theme="dark"]` `:2438`

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
each clear 4.5:1 on `--surface` *and* over the 4% `--fg` tint labels sometimes sit on. Enforced
statically by `app/app.css.test.ts` (§8).

**Accents.** `--blue #5b76fe` / `--blue-pressed` / `--blue-soft` — accent for borders, focus rings,
washes, text-on-light. It is **not** a text background: the CTA fill is its own pair, `--cta-bg
#3f5efd` / `--cta-fg #fff` in light, inverted in dark. `--success #00b473`. `--pin-star`.
**`--blue` now also carries the app-wide focus ring**, and the test asserts it clears WCAG 1.4.11's
3:1 against both `--bg` and `--surface` in both themes (light 3.84:1, dark 5.81:1).

**Pastel semantic pairs** (bg/text invert *together*): `--coral-light/--coral-dark`, `--rose-light`,
`--teal-light/--teal-dark`, `--orange-light/--yellow-dark`, `--red-light`.

**Agent identity** — violet, deliberately distinct from human blue: `--agent #7b61ff`,
`--agent-dark`, `--agent-soft`.

**Shadows** `--shadow-ring`, `--shadow-card`, `--shadow-pop`. **Radii** `--radius-button: 8px`,
`--radius-chip: 999px`, `--radius-card: 16px`, `--radius-panel: 22px`. **Layout**
`--rail-w: 232px`, `--topbar-h: 60px`.

**There are no spacing tokens.** Spacing is per-component rem values. Recorded, deliberate
divergence (§10).

### 3.3 Typography

`--font-display` — **Manrope** (bundled `@fontsource/manrope` 500/600/700/800), declared **exactly
once** at `app.css:64` (the Roobert-first duplicate is deleted and the single declaration is pinned
by test). Used for `h1–h4` (weight 800, `letter-spacing: -.01em`, `text-wrap: balance`), buttons,
names, `.nm`, `.pj-name`, uppercase labels.

`--font-body` — **Noto Sans** 400/500/600/700. `--font-mono` — **JetBrains Mono** 400/500/600, with
`.mono` = `font-variant-numeric: tabular-nums; font-size: .76rem; letter-spacing: -.01em`
(`app.css:194`). Mono is used *intentionally*: task keys, branches, SHAs, timestamps, counts, paths,
emails in member lists, kbd chips. (Wave 3 found the board **list** row's task key matched no `.key`
rule at all — every one was scoped to a container the row is not in — so it alone rendered in the
body face. Fixed and pinned against the grid card's treatment.)

Scale is compact and functional — page `h1` ~1.5–1.9rem, panel `h2` ~1.02rem, body `.86–.9rem`,
metadata `.72–.78rem`, uppercase micro-labels `.62–.68rem` at weight 900.

### 3.4 Light / dark

Dark is a **token swap only** (`:root[data-theme="dark"]`, `app.css:2438`) plus nine fixups at
`:2480-2488` for surfaces that hard-code an inverted colour (`.gh-bar`, `.toast`, `.tl-node.github`,
`.pill.done`, `.tl-node.completion`, backdrops, `.btn.primary:hover`, the Codex glyph tint).
Semantic meaning is identical in both themes.

Preference is `light | dark | system`, resolved in three places:
1. **Boot script** (`app/root.tsx`, inlined in `<head>`) — reads the `viberr_theme` **cookie as
   authoritative**, falls back to the SSR preference, resolves `system` against
   `prefers-color-scheme` and subscribes to OS changes. The cookie read is what keeps the
   ErrorBoundary page from flashing light in a dark session.
2. **SSR** renders `<html data-theme={explicit ?? "light"} data-motion suppressHydrationWarning>`
   (`root.tsx:126-127`).
3. **Post-paint** effect (`root.tsx:152+`) re-applies on preference change and live-follows the OS
   on `system`.

Writes go to `POST /prefs/theme`; the user menu applies `applyThemePreference()` optimistically
first (`app/features/shell/theme-preference.ts`).

The console (`.console`) is a **fixed dark surface in both themes** — its log-line colours are
literal hex on purpose, because theme tokens would invert against a background that never does.

`@media (prefers-reduced-transparency: reduce)` (`app.css:3641`) frosts `.rail` and `.home-top` solid.

### 3.5 The `button { background: none }` fact

`app/app.css:112` — `button { font: inherit; color: inherit; cursor: pointer; background: none; }`.
The `background` is **load-bearing**. Without it, a `<button>` whose class declares no surface keeps
the UA `ButtonFace`, which Chrome resolves **per color-scheme**: `#efefef` light, **`#6b6b6b` dark**.
The org-settings tab rail (`.nav-item`) painted that mid-grey block in dark mode, dropping `--muted`
to 3.2:1 and its `.count` to 1.9:1 (measured 9.81:1 / 6.64:1 after). This pre-existed pass 16 and
was only exposed by extending the axe sweep to org settings **in both themes**. Pinned in
`app.css.test.ts`. Do not remove it, and do not re-add a per-component `background: transparent`
patch instead.

---

## 4. Motion vocabulary

Easing is a single token: `--ease-out: cubic-bezier(.23, 1, .32, 1)`. The built-in `ease-out` is
deliberately considered too weak for entrances and presses; `ease-in-out` is reserved for on-screen
moves. Durations cluster at **.12–.18s** for UI reactions, **.3s** for page-level entrances, and
**.45s / 1.3s** for state-change pulses.

### 4.1 Keyframes

| keyframe | line | used by | shape |
|---|---|---|---|
| `pulse` | `:491` | `.live .dot` (teal) | expanding ring, infinite |
| `board-scroll-fade` | `:751` | `.board-wrap::after` | **NEW** — a *scroll-driven* animation on `scroll-timeline: --board-scroll-x`, so the "more to the right" gradient only paints when the board actually overflows |
| `dropPreviewIn` | `:880` | `.card-drop-preview`, `.cap-mbody` accordion | `translateY(-4px)` + fade, `.16s` |
| `cardArrive` | `:883` | `.card-wrap.just-arrived .card` | blue ring pulse, `1.3s` |
| `stagePulse` | `:905` | `.sm-current.changed`, `.bell-badge` | `scale(1) → 1.13 → 1`, `.45s` |
| `smPop` | `:924` | `.stage-menu-pop` | `translateY(-4px) scale(.985)`, origin top-right |
| `pulse-a` | `:987` | agent working dots (violet) | expanding ring, infinite |
| `rise` | `:1424` | `.toast`, `.login-card`, `.login-aside`, home surfaces | `translateY(10px)` + fade, `.3s` |
| `menu-in` | `:1427` | menus whose trigger is **above** (`.user-menu.from-top`, `.ntf-pop`, `.rsel-menu`, `.own-menu`) | `translateY(-4px) scale(.98)`, `.16s` |
| `menu-in-up` | `:1428` | menus whose trigger is **below** | mirrored |
| `fade-in` | `:1430` | scrims, `dialog::backdrop`, reduced-motion substitute | opacity only |
| `pop-center` | `:1665` | `.confirm-card`, `.modal-card`, `.page-overlay` | `translate(-50%,-46%) scale(.97)` → centered, `.18s` |
| `cmdk-in` | `:1737` | `.cmdk-card` only | top-anchored variant |
| `livePulse` | `:2595` | `.live-dot` on the run strip | |
| `runSpin` / `spin` | `:2602` / `:3115` | `.run-spin`, `.ico.spin` | rotation |
| `caretBlink` | `:2721` | `.lcaret` in the log console | `steps(2)` |
| `route-pending-slide` | `:3702` | `.route-pending .rp-fill` | `translateX(-100% → 320%)`, `1.05s` infinite |

The **menu entrance is origin-aware** by design: a menu grows from the edge that touches its trigger,
which is why there are two keyframes and why several popovers set `transform-origin` explicitly.

### 4.2 Press feedback

A single consolidated block gives every pressable surface an `:active` scale, graded by size: cards
`.99`, list rows `.99` (+ translate reset), chips and segmented buttons `.96`, small icon-X buttons
`.9`, nav items `.985`. `.btn` lifts `-1px` on hover and `scale(.97)` on press. This is the app's
tactility budget — do not add per-component press effects.

### 4.3 The dialog close pattern (mandatory on every dialog)

`app/ui/use-dialog.ts` (122) — `const { ref, close } = useDialog(onClose, onDismissRequest?)`.

```tsx
const { ref, close } = useDialog(onClose);
<dialog ref={ref} className="modal-card" aria-label="…">
  …
  <button onClick={close}>Cancel</button>
</dialog>
```

What the platform gives (via `showModal()`): focus trap, top-layer stacking, `::backdrop`, Escape.
What the hook adds:

- **Animated close.** `close()` sets `dialog.dataset.closing = ""`, then reads
  `getComputedStyle(dialog).transitionDuration` **after** the attribute lands. If it isn't
  `> 0.02s` — jsdom (no stylesheet) or `[data-motion="reduce"]` (clamped to `.01ms`) — it calls
  `onClose()` synchronously. Otherwise it waits for `transitionend` **filtered to
  `event.target === dialog`** (transitionend bubbles; a pressed Cancel button's transform would
  otherwise end the close mid-fade) with a `duration + 50ms` fallback timer.
- CSS side: `dialog[data-closing]` kills the entrance animation and transitions opacity+transform
  back over `.15s`; the backdrop fades with it. `.cmdk-card[data-closing]` overrides the transform
  because that card is top-anchored.
- Escape → native `cancel` event, `preventDefault()`ed so React state stays the source of truth,
  routed through the same animated `close()`.
- Backdrop click → hit-tested against the dialog rect, so clicks on the card's padding don't dismiss.
- Body scroll lock, focus restore, and initial focus via React's already-applied `autoFocus`
  (re-focused, because `showModal()` steals it) or a `[data-autofocus]` opt-in.
- `onDismissRequest` returning `true` consumes an Escape/backdrop dismiss without closing (used by
  the store browser's inner new-folder row). Explicit `close()` always closes.

**`useDialog` is for modal `<dialog>`s. For inline popovers, use `useDismiss` (§5.7) — never a new
hand-rolled effect.**

### 4.4 Toast two-phase exit (and the cap)

`app/ui/toast.tsx` (261). `TOAST_DISMISS_MS = 2600`, `TOAST_EXIT_MS = 200`,
**`TOAST_STACK_CAP = 4`** (new). Timer 1 flips `leaving: true` (CSS `.toast.leaving` transitions
opacity + `translateY(10px)` over `.2s`); timer 2 unmounts 200ms later. All timers are tracked in a
ref and cleared on unmount.

The cap drops the **oldest** and does so **without an exit animation** — the toast has already had
its time, and animating an exit caused by an *arrival* would read as the new toast shoving the old
one, which is not what happened. Evicted toasts' pending timers stay armed and become no-ops.

**Exits are always faster than entrances** across the app — same rule in the dialog (`.15s` out vs
`.18s` in) and the capability accordion (instant collapse vs `.16s` expand).

### 4.5 Reduced motion — two independent switches

1. **In-app preference** (`user_prefs.motion`, set on `/profile`). SSR renders
   `<html data-motion="reduce">` directly from the DB so there is no flash. The rule is a global kill
   switch: `[data-motion="reduce"] *, ::before, ::after` clamps `animation-duration` and
   `transition-duration` to `.01ms !important`. This is also what makes `useDialog.close()` take its
   synchronous branch.
2. **OS preference** `@media (prefers-reduced-motion: reduce)` — six blocks, and they are *not* a
   kill switch. Entrances collapse to `fade-in .12s` (movement is what nauseates; opacity still aids
   comprehension), dialogs stay centred while fading, the toast exit drops its translate, the
   board/stage-menu animations go to `none`, the rail transition is removed, `.rq-go`'s hover nudge
   is disabled.

**Three** indicators now need explicit reduced-motion fallbacks because clamping would leave them
meaningless: `.route-pending .rp-fill` becomes full-width, the toast still fades, and
`[data-motion="reduce"] .board-wrap::after { animation-duration: auto !important }` — a
progress-based scroll timeline clamped to `.01ms` collapses its whole range and the overflow fade
would never show.

---

## 5. Shared UI primitives

### 5.1 `app/ui/` inventory

| file | lines | export | notes |
|---|---|---|---|
| `icon.tsx` | 77 | `Icon({name, className})`, `IconName` | **37** inline 24px stroke paths; `stroke-width 1.7`, round caps; **always `aria-hidden="true"`**. Unknown name → `dot`. Names: `board review inbox shield agents github activity search filter plus branch pr check copy clock alert file lock arrow user cpu message sparkle refresh x bolt memory dot send hand flag bell chevron sliders grip ext term` |
| `avatar.tsx` | 30 | `Avatar({person:{initials,tone}, lg, xl})` | 26 / 34 / 56px; tones `rose`/`teal`/`violet` |
| `initials.ts` | 16 | `initialsOf(name)` | split out for the Fast Refresh boundary |
| `identity.tsx` | 38 | `AgentGlyph({backend, lg, op})` | angular clip-path; `op` → shield on `--fg`; claude → warm tint + `sparkle`; else codex + `cpu` |
| `pill.tsx` | 116 | `Pill`, `ReadinessPill`, `ValidationPill` | `PillKind = ready\|input\|risk\|blocked\|info\|agent\|neutral\|done`. Validation map: `healthy`→"validation healthy", `changed`→**"awaiting verdict"**, `failing`, `none`→"no validation" |
| `toggle.tsx` | 27 | `TglP({on, onChange, label})` | `role="switch"` + `aria-checked` + `aria-label` |
| `skip-link.tsx` | 58 | `SkipLink({targetId="main-content"})` | WCAG 2.4.1 bypass block; visibility driven by React focus state with **inline styles, no CSS classes** (deliberate — one of the surviving 20 inline-style sites) |
| `page-overlay.tsx` | 39 | `PageOverlay({label, onClose, children})` | `useDialog` + `.page-overlay` + `.overlay-x`; sets `data-screen-label={label + " — overlay"}` |
| `local-time.tsx` | 41 | `LocalDayDotTime`, `LocalRelative`, `useHydrated` | UTC-deterministic first paint, viewer-local after hydration — the React #418 fix |
| `use-relative-time.ts` | 26 | `useRelativeTime(iso)` | re-renders on mount and every 30s; callers add `suppressHydrationWarning` |
| `use-shortcut-hint.ts` | 29 | `useModifierHint(key="K")` | SSR emits `⌘K`, effect swaps to `Ctrl K` off `navigator.userAgent` |
| `markdown.tsx` | 156 | `Markdown({text, mentionNames})` | react-markdown + remark-gfm, no raw HTML; links get `target=_blank rel=noopener`; tables wrapped in `.md-table-wrap`; `rehypeMentions` chips **known** mentions via `findMentionSpans`, skipping `code`/`pre`, and emits a `.mention-vh` sibling label. Caller wraps in `.md-body` |
| `rich-text.tsx` | 94 | `RichText({text, mentions, names})` | inline micro-format: `**bold**`, `` `code` ``, `@mention`. **F20 fix**: it no longer carries its own regex — mentions go through `findMentionSpans` filtered to `known`, so `@nobody` stays prose and `@Arda Kaya` chips whole. Also emits the `.mention-vh` label |
| `mention-spans.ts` | 109 | `findMentionSpans`, `extractMentions`, `RESERVED_MENTION_HANDLES` | the single matcher shared by both renderers, the composer and the server router. Reserved: `operator agent claude codex` |
| `stage-menu.tsx` | 213 | `StageMenu` | see §5.6 |
| `csrf-input.tsx` | 18 | `CsrfInput`, `useCsrfToken` | see §6.2 |
| `toast.tsx` | 261 | `ToastProvider`, `useToast`, `useToasts` | see §4.4 + §7 |
| `use-dialog.ts` | 122 | `useDialog` | see §4.3 |
| **`use-dismiss.ts`** | **110** | **`useDismiss(open, onDismiss, {also, onReflow, outside})`** | **NEW** — see §5.7 |
| `use-action-toast.ts` | 26 | `useActionToast(fetcher)` | server-computed toast from `{ok, toast\|error}` |
| `use-fetcher-result.ts` | 27 | `useFetcherResult(fetcher, onResult)` | once-per-settled-result handler; the repo's canonical handled-ref pattern |

### 5.2 Shell primitives — `app/features/shell/`

`topbar.tsx` (190), `rail.tsx` (86), `nav.ts` (70) · `user-menu.tsx` (208) · `top-bell.tsx` (192) ·
`command-palette.tsx` (233) · **`use-command-palette.ts` (36)** · `route-pending-bar.tsx` (63) ·
`theme-preference.ts` · `csrf-result.server.ts` · `command-search.server.ts`.

- **`use-command-palette.ts`** — `useCommandPaletteShortcut(onOpen)`. THE ⌘K/Ctrl-K binding, called
  by `topbar.tsx` and `home-page.tsx`. It **ignores `altKey`**, so ⌥⌘K / Ctrl-Alt-K (OS and IDE
  combinations) are no longer swallowed. `onOpen` is held in a ref so an inline arrow does not
  resubscribe the listener. It is a `.ts` module rather than a `.tsx` export for the Fast Refresh
  boundary.
- **`user-menu.tsx`** — theme cycles light→dark→system with an optimistic `applyThemePreference`
  before the POST to `/prefs/theme`, and the menu **stays open** on theme click. `role="menu"`/
  `menuitem` were deliberately **removed**: the panel is `tabIndex={-1} aria-label="Account menu"`
  and the trigger is `aria-haspopup="dialog"`. Contains the only other `<CsrfInput/>` (the logout
  `<Form>`). Dismissal: `useDismiss(menu, …, { outside: false })` `:75` — it deliberately stays open
  until Escape or an explicit action.
- **`top-bell.tsx`** — `BELL_LIST_CAP = 100`. A **declarative non-modal `<dialog open>`** (not
  `showModal()`) so it stays anchored to the bell; focus moves in on open and back to the bell on
  close. Dismissal: `useDismiss(open, …, { outside: false })` `:49`. `markRead(ids)` /
  `markAllRead()` POST to `/notifications/read`. The `.bell-badge` is keyed on `unread` so
  `stagePulse` re-fires on every SSE arrival — that pulse is the *only* signal a notification landed.
- **`command-palette.tsx`** — `useDialog`, `.cmdk-card` anchored at `12vh`. 140ms debounce, and it
  only trusts a payload whose `q` matches the on-screen query so the list never flashes stale rows.
  `↑/↓` wrap, `Enter` navigates then closes (navigate first, so focus restore + exit transition still
  run). **It is now a real combobox** (§7). Server side `command-search.server.ts` scopes hits to the
  viewer's visible projects, 6 per group, 60-row task scan.
- **`route-pending-bar.tsx`** — the app's **one** route-level pending indicator, mounted once in
  `root.tsx:172`. 220ms delay so fast client navigations never flash it. Pending requires
  `state !== "idle" && navigation.location != null` — the `location` check deliberately excludes
  `useRevalidator`-driven SSE revalidations, so live updates never draw a loading bar.
  `role="progressbar"`, `z-index: 90`.

### 5.3 Z-index ladder

`.menu-scrim` 40 · mobile `.rail-scrim` 44 / `.rail` 45 · `.user-menu`/`.ntf-pop`/`.own-menu`/
`.rsel-menu` 50–60 · `.confirm-scrim` 60 · `.confirm-card`/`.modal-card`/`.page-overlay` 61 ·
`.confirm-card.over-modal` 71 · `.route-pending` 90 · `.toast-wrap` 100 ·
`.stage-menu-pop` 1000 (portaled to `<body>`).
Native `<dialog>` + `showModal()` promotes to the browser **top layer**, above all of these — which
is why the toast host is itself a `popover="manual"` element, and why it must also **re-insert**
itself when a dialog opens after it (the top layer is ordered by insertion; see §7).

### 5.4 Confirm / modal shells

Three card shapes, all native `<dialog>`: `.confirm-card` (420px, `.confirm-icon` + `h3` + `p` +
`.confirm-actions`), `.modal-card` (660px, `.modal-head`/`.modal-body`/`.modal-foot`; `.modal-wide`
= 1060px), `.page-overlay` (1080×780 max, `.overlay-x` + `.page-overlay-body`). Destructive dialogs
use `role="alertdialog"`. Form fields inside them use the shared `.field` / `.flabel` / `.fhint`
vocabulary with a blue focus ring (`box-shadow: 0 0 0 3px blue@14%`) — the same ring `select` now
uses, and the same blue the app-wide `:focus-visible` outline uses.

### 5.5 The Lexical mention composer

Files: `comment-composer.tsx` (304), `lexical-mention-plugin.tsx` (216), `mention-menu.tsx` (107),
`use-mention-autocomplete.ts` (136), `mention-autocomplete.ts` (194). Replaced a textarea +
transparent-text mirror backdrop in 2026-08-03 (A3).

- **Plain text only.** `PlainTextPlugin`, namespace `"task-comment"`, `nodes: [MentionTextNode]` —
  no rich text, no Markdown/HTML transformers, no editor state persisted. The value submitted is
  `$getRoot().getTextContent()` → `raw.trim()` in a `text` form field, pinned by a fixture table.
- **`MentionTextNode`** `extends TextNode`, type `"viberr-mention"`, and does exactly one thing:
  `createDOM` adds the `.mention` class. It stays **fully character-editable** and copies/exports as
  its plain `@Name` text. It deliberately does **not** get the `.mention-vh` label — that node has
  to speak the literal `@` the author typed.
- **Segmentation** is a paragraph-level node transform on both `TextNode` and `MentionTextNode`. It
  re-runs `findMentionSpans(text, names)` — the *same* matcher the renderers and the server router
  use — filters to `known`, diffs against the current mention ranges, and only splices when out of
  sync, restoring the caret. It bails while `editor.isComposing()` (IME-safe).
- **Trigger**: `@` at start-of-string or after whitespace, plus ≥1 `[\w-]` char before the caret
  (`detectMentionToken`). Inserting writes the **display name**, not the handle.
- **Keyboard model is Lexical commands at `COMMAND_PRIORITY_HIGH`**: `⌘/Ctrl+Enter` sends always;
  while the menu is open Enter/Tab pick, ↑/↓ move (wrapping), Escape closes; otherwise Enter is a
  plain line break. Every one returns `false` first if `editor.isComposing()`.
- **ARIA**: the `ContentEditable` is the combobox — `role="combobox"`, `aria-expanded`,
  `aria-controls`, `aria-activedescendant`, `aria-autocomplete="list"`; the menu is `role="listbox"`
  with `role="option"` rows carrying `id={listId}-opt-{i}`. Rows `preventDefault` their `mousedown`.
  **This is the pattern the ⌘K palette was rebuilt onto.** Covered by
  `e2e/05-task-comment-composer.spec.ts`.
- **Imperative handle**: `focus()`, `prefillIfEmpty(text)` (ask-operator → `"@operator "`),
  `clearAfterSuccess()` which also dispatches `CLEAR_HISTORY_COMMAND` so ⌘Z cannot resurrect a
  posted comment. A failed post keeps the draft.
- The draft is held in a **ref** (`timeline.tsx`), not state, so the Timeline does not re-render per
  keystroke.
- Its containing block is `.composer-input` (`timeline.tsx:348`), which is a **real CSS rule** now
  and is asserted to be `position: relative` by `app.css.test.ts`.

### 5.6 The dnd-kit layer — ONE drag language

`@dnd-kit/react` + `@dnd-kit/dom` `0.5.0` (exact-pinned). The board migrated from HTML5 drag events
2026-08-03 (A2); **project settings' stage list joined it in pass 16**. Board code:
`app/features/board/board-page.tsx` + the pure mapper `board-dnd.ts` (51). Stage code:
`app/features/project-settings/settings-page.tsx:228-350` + `resolveStageOrder`.

Both lists share, verbatim, the same five decisions:

- **Sensors**: `PointerSensor.configure({ preventActivation: target =>
  target.closest("button, input, select, textarea"), activationConstraints: touch ? Delay(250ms,
  tol 5) : Distance(5px) })` plus `KeyboardSensor`. Mouse is **distance-only** so a slow
  press-and-release still clicks/navigates; touch is a 250ms long-press so scrolling isn't hijacked.
- **The whole card/row is the handle. There is no grip.** `preventActivation` is the only carve-out,
  and it exists so the `StageMenu` / rename / remove controls inside stay clickable.
  (`.stg-handle` survives only as `.stg-handle.off`, and `app.css.test.ts` asserts the grab cursor
  sits on the row that drags, not on a missing grip.)
- **The `Accessibility` plugin is OFF** on both: `defaultPreset.plugins.filter(p => p !==
  Accessibility)`. Its `role="button"` wrapper nested the inner interactive controls → axe
  `nested-interactive` (serious). AutoScroller, Cursor, Feedback and PreventSelection stay. Drag is
  declared pointer-only; the AT path is the menu (`StageMenu` on the board, `StageMoveMenu` in
  settings).
- **Nothing reorders client-side.** `OptimisticSortingPlugin` is removed per-sortable and `Feedback`
  is `"clone"` — the original stays a faded dashed ghost while a clone follows the pointer.
- **The drop resolves through a pure function**, unit-tested without a drag library, returning
  `null` for no-ops and degrading a vanished target to end-of-list: `resolveBoardDrop`
  (`board-dnd.ts:23`, 13 cases) and `resolveStageOrder` (`settings-page.tsx:285`). Returning `null`
  is what stopped the stage list POSTing a no-op reorder and **toasting success for a change that
  never happened**.

Board-only extras: `DropPreview` (an `aria-hidden` ghost row, `.card-drop-preview`, dashed blue),
column droppables `useDroppable({id: "stage:"+id, collisionPriority: 1})` (Low, so an over-card
collision always wins; the column target is what makes empty stages droppable), the four-phase
state machine (`onDragStart` seeds, `onDragOver` proposes, `onDragMove` refines against the
pointer's vertical midpoint, `onDragEnd` bails on `event.canceled`), an optimistic **column header
count** during a cross-column drag (the board's only optimism), and a landing pulse
(`.just-arrived`, `cardArrive`) that retires after 1500ms.

**`StageMenu`** (`app/ui/stage-menu.tsx`, 213) is the keyboard/AT path and is shared with the
task-detail "Current state" panel. Trigger: real `<button>` with `aria-haspopup="menu"`,
`aria-expanded`, `aria-label="Change stage (currently X)"`. Popover is `createPortal`'d to `<body>`
and fixed-positioned from the trigger rect with an 8px viewport clamp. `role="menu"` +
`role="menuitemradio"` + `aria-checked`; the current stage is `disabled` and skipped. Keyboard: ↑/↓
wrap, Home/End, Escape → close **and return focus to the trigger** (the caller owns that, because
only the caller knows where focus belongs). Focus moves into the first enabled item on open.
Dismissal is `useDismiss(open, …, { onReflow: true, also: [btnRef] })` `:50` — `onReflow` because
the popover is positioned from a rect a column scroll makes stale, `also` because the portal means
the trigger is not inside the returned ref. Picking posts the identical `reorder` intent with
`beforeKey: ""`.

The **third** drag idiom, KB-browser file upload (`.fm-row.droptgt` / `.fm-tree.droptgt`), remains
HTML5 and remains deliberate: it is ingest from the OS, not reordering within the app.

### 5.7 `useDismiss` — the one popover dismissal hook

`app/ui/use-dismiss.ts`. `const ref = useDismiss<HTMLDivElement>(open, onDismiss, options?)`.

Seven near-identical effects shipped across the app and **disagreed on details that are not design
choices** — `document` vs `window` for the key listener, whether an outside press closes at all,
whether the trigger counts as inside — so the same gesture behaved differently depending on which
menu was open. All seven are converted.

Options: `also` (extra "inside" elements, for portaled popovers), `onReflow` (close on
capture-phase scroll + resize, for rect-positioned popovers), `outside` (default `true`; the account
menu and the bell pass `false` and stay open until Escape or an explicit action).

Details worth preserving: it listens on **`mousedown`, not `click`** (a click fires after the press
has moved focus and can land on whatever slid under the cursor); both listeners go on `document`;
callbacks and the `also` array are held in refs so inline arrow/array literals don't resubscribe on
every render; nothing is subscribed while `open` is false.

Call sites: `shell/top-bell.tsx:49`, `shell/user-menu.tsx:75`, `ui/stage-menu.tsx:50`,
`task-detail/execution-profile.tsx:105/254/355`, `runtime/runs-panels.tsx:72` (AgentPicker, which
previously had **no** document-level Escape at all), `project-settings/settings-page.tsx:371`
(StageMoveMenu).

**This is not `useDialog`.** These are inline popovers anchored to a trigger: they must not trap
focus, must not take the top layer, and must not scroll-lock the body, so there is no native
`cancel` event to hang Escape on.

---

## 6. Client data flow

### 6.1 The one rule

`docs/architecture/decisions.md` — **"No optimistic UI for governed state. Revalidate after the
action and on SSE."** Every governed mutation posts, the action returns `{ok, toast, …}`, and the UI
re-renders from a revalidated loader. The three sanctioned exceptions are cosmetic: Home's view/pin
prefs read off `fetcher.formData`, the theme applied before its POST resolves, and the board's
column header count during a drag. **Neither drag list reorders optimistically.**

### 6.2 Forms and CSRF

- The token comes from the **root loader** (derived from the session) and is read with
  `useCsrfToken()` (`app/ui/csrf-input.tsx`). Server side: `assertCsrf(request, sessionId, formData)`
  inside `requireFormAction`. Pass 16 made the **origin check fail closed** when both `Origin` and
  `Referer` are absent (A7).
- **Every mutating submission must carry `_csrf`.** Two shapes:
  - `<CsrfInput />` in a declarative `<Form>` — used in only **two** places app-wide
    (`routes/login.tsx`, `shell/user-menu.tsx`), plus one hand-rolled hidden input in the task hero's
    goal form (`task-main-sections.tsx`);
  - `fd.set("_csrf", csrf)` on a hand-built `FormData` passed to `fetcher.submit(fd, {method:"post"})`
    — the overwhelming default (~40 call sites).
- A handful of surfaces pass a **plain object** instead of `FormData` (`agents-page.tsx`,
  `settings-page.tsx`, `github-view.tsx`, `policy-page.tsx`, `org-settings/use-org-action.ts`,
  `store-browser.tsx`). Both work; the inconsistency is noted in §9.
- `fetcher.submit` is called **without an `action`** everywhere except `use-org-action.ts` — posts
  go to the current route's action, discriminated by `intent`.
- Result handling is always once-per-settled-result via a handled ref: `useActionToast(fetcher)` for
  server-computed `{ok, toast|error}`, or `useFetcherResult(fetcher, fn)` for anything custom. A
  failure toast **must** be pushed with `"error"` so it renders the alert glyph instead of the
  success tick.

Fetcher ownership, so you know where a mutation lives:

| surface | fetchers | toast helper |
|---|---|---|
| home | `prefsFetcher`, `rescanFetcher`, `rebuildFetcher`, modal-local | `useFetcherResult` + manual |
| board | `rescanFetcher`, `transitionFetcher`, modal-local | manual |
| task detail | **13**, across 4 files (see §2.8) | `useActionFeedback` (`task-detail-hooks.ts`) |
| timeline composer | 1 (`comment`) | manual, keeps draft on failure |
| agents | 1 (+ a GET catalog fetcher in the modal) | manual, routes errors into the open modal |
| policy | `roleFetcher`, `boundaryFetcher` | `useActionToast` |
| github | `reconcileFetcher`, `grantFetcher`, `credFetcher` | `useActionToast` |
| project settings | 6 | `useActionToast` |
| org settings | 1 shared hook `useOrgAction` | built into the hook |
| kb browser | 4 (`opsFetcher`, `ghFetcher`, `readFetcher`, `saveFetcher`) | split so a failed read never rides the generic store toast |
| profile | 6 (5 passed as props + `themeFetcher`) | `useFetcherResult` with rollback |
| notifications | 1 (route-owned) | `useFetcherResult`, bulk case only |
| review, activity, runtime | **none** — read-only surfaces | — |

### 6.3 Feedback hierarchy

Inline first, toast second. Refusals are **rendered copy next to the control**, never a bare disabled
button — `.deny-note` exists precisely because `title` is unreachable on a disabled element for
keyboard and touch. Pass 16 hardened this into a pattern: a **role refusal** is `aria-disabled` +
a refusing click handler (so the control keeps focus and its accessible description) + the reason as
**visible text** bound by `aria-describedby`; only **transient or structural** refusals (`busy`,
"no options at all") are a real `disabled`. `title` on a disabled control is asserted gone by test.
Disabled controls also *read* disabled (opacity .45, `not-allowed`, no lift). Form/server errors use
one framed treatment, `.login-err, .form-err`. Inline field errors carry `role="alert"`.

### 6.4 SSE / live updates

- Endpoint `GET /resources/events?scope=…&scope=…` (`app/routes/resources.events.ts`). Scope kinds:
  `user`, `projects`, `project:<slug>`, `task:<slug>/<key>`. Non-admins have `projects` expanded to
  their membership rows and foreign explicit scopes dropped; nothing left → **403**. Signed-out →
  **JSON 401** (not a redirect — EventSource can't render a login page). Bad scope → 400.
  `Last-Event-ID` resume; `text/event-stream`, `no-store`, `X-Accel-Buffering: no`; 1024-chunk
  backpressure cap.
- Event names (`app/schemas/sse-event.schema.ts`, zod-parsed before publish): `task.updated`,
  `task.removed`, `project.updated`, `project.removed`, `projection.rebuilt`,
  `notification.created`, `notification.read`, `violation.updated`, `run.log-appended`,
  `run.state-changed`, plus control events `stream.open`, `stream.resync`. Payloads are
  `{type, entityId, occurredAt, data}` with **compact facts and references only**.
- **Client hook** `app/features/live-updates/use-live-updates.ts` (129) — subscribes every
  non-control event name and does exactly one thing: `revalidate()`, debounced 300ms (trailing).
  Disconnect handling: an EventSource that receives a non-200 **fails permanently**, so `onerror` on
  `readyState === CLOSED` flips `paused` (the topbar renders the *live updates paused — retry* chip)
  and re-opens on a bounded backoff `[2s, 5s, 15s, 30s]`; `onopen` after a retry pulls the loaders
  once. Call sites: `_index.tsx` (`user` + `projects`), `notifications.tsx` (`user`),
  `project.tsx:150` (`project` + optional `task` + `user`).
- **Second, dedicated stream**: `app/features/runtime/use-run-log-stream.ts` (503) opens its own
  EventSource scoped to the task, and on `run.log-appended` fetches
  `/resources/run-log?runId=…&since=…` rather than revalidating; `run.state-changed` triggers a
  single `revalidate()`. Gated by `enabled: runsVisible`. Guards worth preserving: one in-flight tail
  per run; `fresh = lines.filter(l => l.seq > head)` dedupe; `headSeq` taken from `window.headSeq`,
  explicitly not `lines.length - 1`; and a `pagedRef` **freeze** so a loader re-seed cannot drop
  loaded pages and open a hole. Backward paging is `?before=&limit=` at 200 lines/page, re-synthesising
  the `── resumed · run N of M ──` divider at each boundary. **This stream still does not reconnect**
  — see §9.

### 6.5 Notification bell

`TopBell` renders the top 100 from the layout/home loader; `notification.created` and
`notification.read` are `user`-scoped SSE events, so the badge updates by revalidation in every open
tab. The badge is keyed on `unread` to re-fire `stagePulse`. Mark-read posts to `/notifications/read`.
The full page at `/notifications` renders in a `PageOverlay` and carries a "See all" path from the
popover with `state.returnTo`.

---

## 7. Accessibility posture

The claim is **WCAG 2.2 AA on core workflows, in both themes**, and it is gated, not asserted.

### 7.1 What the gates cover now

- `e2e/07-accessibility.spec.ts` runs axe (`wcag2a` + `wcag2aa` + `wcag22aa` tags **only** —
  best-practice rules are opinions) across **12 surfaces in both themes**: board, task detail, review
  queue, policy, home, agents, **activity, project settings, github, org settings, /profile,
  /notifications** — plus **3 dialogs audited in their open state** (`SURFACES` `:31`, dialogs
  `:99/:110/:121`), plus a mobile-rail-overlay test asserting there is no hidden interactive scrim,
  plus signed-out login in both themes. Violations are reported with their selectors, not a count.
- `app/app.css.test.ts` (1006) statically enforces contrast floors, token/class integrity, the focus
  ring, the breakpoint set and the inline-style budget (§8).

### 7.2 The toast/live-region fix (the most consequential a11y change of pass 16)

The toast host (`app/ui/toast.tsx:148` `ToastHost`) is the app's **one** announcer. It was **silent
for every dialog-driven action**: while a modal `<dialog>` is open everything outside it is inert, so
the live region is not in the accessibility tree at all — and the old code called `showPopover()` in
the same commit that inserted the toast, which is the one case screen readers do not announce (a live
region only announces *changes* to a region it was already observing). Every AcceptConfirm /
ArchiveConfirm / ReleaseConfirm / DeleteProject / RepairRepo / org-settings MiniModal / store-browser
confirmation completed in silence.

The fix is two-step on the 0 → n transition: (1) promote the still-**empty** host to the top layer,
which also un-inerts it; (2) commit the toast children in a **second** render (`regionReady`), so the
region is observed before it changes. `regionReady` flips from a passive effect, so React commits it
after first paint in the browser and synchronously inside `act()` in tests.

**The re-arm matters as much as the promotion**: the top layer is ordered by *insertion*, so a dialog
opened *after* the host was promoted sits above it. The host therefore hides→shows itself when the
set of open `dialog[open]` elements has changed since it was promoted. It deliberately does **not**
re-insert on every push — that would drop the region out of the tree mid-burst.

`aria-atomic="false"` is explicit and load-bearing: `role="status"` implies `true`, which would
re-read the whole (now up to 4-deep) stack on every arrival.

### 7.3 The app-wide focus ring

`app/app.css:179`:

```css
:where(
  a[href], area[href], button, summary, select, input, textarea,
  [tabindex="0"],
  [role="button"], [role="option"], [role="menuitem"], [role="menuitemradio"],
  [role="radio"], [role="switch"], [role="tab"], [role="link"]
):focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
```

- Wrapped in `:where()` so the whole selector weighs (0,1,0) — exactly one pseudo-class — and any
  component rule that already owns its focus treatment (`.field input:focus`,
  `.composer-box:focus-within`, `.stg-input`, `.cmdk-input`, …) still wins without `!important`.
- `[tabindex="0"]` deliberately **excludes** `tabindex="-1"`: skip-link targets, dialog panels and
  roving-tabindex resting items are focused programmatically and must not paint a ring around a
  whole region.
- Two borderless fields (`.top-search input`, `.board-filter-input input`) erase the outline
  unconditionally, so the **wrapper** draws the ring: `div.top-search:focus-within`,
  `.board-filter-input:focus-within` (`app.css:188`). `div.top-search` scopes it to Home's real
  input — the workspace's `button.top-search` is a button and gets the outline.
- The blue clears 1.4.11's 3:1 against `--bg` and `--surface` in both themes, asserted by test.

### 7.4 The ⌘K palette is now a real combobox

`command-palette.tsx`: input carries `role="combobox"` + `aria-expanded` + `aria-controls` +
**`aria-activedescendant`** + `aria-autocomplete="list"`. Options are **direct children** of the
listbox through `role="group" aria-label={GROUP_LABEL}` — the only other role a listbox may own; the
visible group heading is `aria-hidden` because the group already carries it as its accessible name.
Rows are `role="option"` with `tabIndex={-1}` (focus never leaves the input, per APG) and
`onMouseDown` `preventDefault` so the click doesn't blur the combobox and stale the
`aria-activedescendant`. The empty result gets its own `role="status"` — the one thing
`aria-activedescendant` cannot say is "there is nothing to point at".

**Gotcha recorded from the pass**: giving the input `role="combobox"` **replaces** its implicit
`textbox` role, so `getByRole("textbox")` matches nothing. The e2e spec asks for the combobox now.

Note that axe never flagged the old structure: `aria-required-children` descends through role-less
wrappers. The unit test next door, not the sweep, is what holds this shape in place.

### 7.5 Deliberate positions

| decision | where | why |
|---|---|---|
| dnd-kit's `Accessibility` plugin is **off** on both drag lists | `board-page.tsx:124`, `settings-page.tsx:265` | its `role="button"` wrapper nested the inner interactive controls → axe `nested-interactive` (serious). Keyboard drag was **not** added; the AT path is the menu |
| `StageMenu` / `StageMoveMenu` are the a11y path for moves | `ui/stage-menu.tsx`, `settings-page.tsx:354` | full `role="menu"`/`menuitemradio` contract, roving arrows, Home/End, Escape-with-focus-return, portaled so it never clips |
| `role="menu"` **removed** from the user menu | `user-menu.tsx` | it declared the role without implementing the keyboard contract; an honest `aria-haspopup="dialog"` + labelled panel replaced it |
| The bell is a **non-modal `<dialog open>`** | `top-bell.tsx` | `showModal()` would unanchor it from the bell |
| The mobile rail scrim is a **`<div aria-hidden>`**, and the keyboard dismissal is the topbar toggle + Escape | `project.tsx:193`, `topbar.tsx` | a hidden *interactive* element as a dismiss layer was a fragile pattern one `tabIndex` change from an `aria-hidden-focus` violation. An e2e test asserts it |
| `aria-current="page"` computed from `activeView`, on a plain `Link` | `rail.tsx` | `NavLink` only emits it on a URL match, so Board had no active signal on `/tasks/:key` |
| Role refusals are `aria-disabled` + visible reason + `aria-describedby`; only transient ones are `disabled` | `decision-packet.tsx:311-317`, `policy-page.tsx:432` | `title` on a `disabled` element can never surface, for anyone |
| Every icon is `aria-hidden` | `icon.tsx` | forces icon-only controls to carry their own `aria-label` |
| Advisory capabilities collapse under `<details>`, never hidden | `agents-page.tsx` | native `<details>` gives keyboard + SR behaviour free; R15-12 rejected hiding |
| `SkipLink` on both shells | `project.tsx:170`, `home-page.tsx:225` | target `<main id="main-content" tabIndex={-1}>` |
| One `h1` per surface | `board-page.tsx:761`, `review-page.tsx:130`, `agents-page.tsx:1170`, … | |
| Nothing is gated on viewport | app.css mobile blocks | every governance control renders at every width; the rail becomes an overlay rather than the controls disappearing. **Home's search box collapses to a magnifier rather than vanishing** (P16-G3) |
| Colour is never the only carrier | pills carry text + dot + icon; `.mention` carries `.mention-vh` | |
| The log console is `role="log" aria-live="off"` | `runs-panels.tsx` | a streaming agent log announced live would flood AT |
| Notification stream rows are **not** `role="button"` | `notifications-page.tsx` (UI-54) | a div that swallows a click is dishonest; the row contains a real task link and, when unread, an explicit *Mark read* button |
| Both mention renderers and the composer share one matcher | `ui/mention-spans.ts` | "highlighted as a mention" and "actually routed" cannot drift apart (F20) |
| Every filter/segment control carries `aria-pressed`; role pickers carry `role="radiogroup"` | board, activity, timeline, policy, agents | |

Landmarks: `<nav aria-label="Primary">` (rail), `<nav aria-label="Breadcrumb">` (topbar),
`<main id="main-content">` on both shells, `role="status" aria-live="polite" aria-atomic="false"` on
the toast host, `role="progressbar"` on the route-pending bar, `role="status"` on the archived
banner / live-paused chip / board orphan banner / the palette's empty result, `role="radiogroup"`
with roving tabindex on decision-packet options, `role="switch"` on every toggle.

---

## 8. Enforcement gates (what fails the build)

This section is new. `app/app.css.test.ts` grew from a handful of checks into the primary UI gate —
if you change the stylesheet or add a class, this is what will stop you.

| gate | what it asserts | why it exists |
|---|---|---|
| **token resolution** | every `var(--x)` in a *declaration* (comments stripped) resolves to a declared token | P13-D-18 shipped 11 references to tokens declared nowhere, silently dropping whole panels |
| **class coverage** | **every className used anywhere in `app/`** has a rule in the sheet — scanned, not listed. `CLASSLESS_BY_DESIGN` is `{}` and capped at 3 entries with ≥20-char justifications. Runtime-completed prefixes (`"pev-ico act-" + type`) must have ≥1 matching rule. Self-check: >150 files scanned, >500 classes found | ten orphan classes rendered unstyled on shipping surfaces and the old four-name check could not see them |
| **focus ring** | exactly one app-wide `:focus-visible` rule, on `--blue`, wrapped in `:where()`, covering the control kinds the markup uses; the four old per-selector copies are gone; the ring clears 3:1 on every surface in both themes; the two borderless fields have a wrapper ring | §7.3 |
| **contrast** | `--faint` / `--placeholder` clear 4.5:1 on `--surface` **and** on the 4% `--fg` tint, in both themes, keeping their subordination to `--muted`; the CTA pair and its hover clear 4.5:1 in both themes; the CTA background stays distinguishable from its surface; the collapsed palette trigger's label clears 4.5:1 on its new fill | |
| **UA background** | the element reset clears `background` on `button` | the dark-theme `ButtonFace` incident (§3.5) |
| **breakpoints** | only the nine named widths are used; **each appears exactly once**; each is actually used; the 1100px block carries all eight collapses | nine copies of 1100px meant "move the collapse" was nine edits and eight were easy to miss. Custom properties don't work in media queries and `@custom-media` needs build config this project doesn't run, so one occurrence is the only mechanism that makes a half-update inexpressible |
| **inline styles** | the tree is scanned (self-checked non-empty) and **no `style={{…}}` may have all-literal values**; the count is held at **20** | a literal value is a design decision and belongs in the sheet where a theme/density/breakpoint rule can reach it; a value read at runtime belongs in the markup |
| **dead/drifted rules** | `--font-display` declared once; no `.card.wait-human` no-op; the board fade only paints when scrollable; each `.live-table` owns its column template; `.stg-x` neutral by default with named destructive sites; no `.fm-acts` rules; grab cursor on the row that drags; `.rail-scrim` has no button-only reset | each is a regression anchor for a specific pass-16 fix |
| **select** | one base `select` rule matching the app's inputs, with the same focus ring; the remaining select rules are variants, not re-inventions | |
| **hover-revealed actions** | `.card-move` still hides behind hover on a pointer device **and** draws unconditionally under `@media (hover: none)`, without reintroducing a grip | |
| **search vs palette** | one silhouette for both (R15-5) **and** a filled face + label on the trigger the field does not have (P16-F6) | |
| **palette on touch** | the shortcut chip hides in the workspace topbar only; Home's box **collapses** rather than being deleted; both collapsed triggers are finger-sized | P16-G3 |
| **composer contract** | `.composer-box` and `.composer-input` both exist and are `position: relative` | delete the old inline style and the placeholder + mention menu jump to the viewport |

Companion gates: `e2e/07-accessibility.spec.ts` (rendered-page axe, §7.1), the unit suites next to
each primitive (`toast.test.tsx` 271, `stage-menu.test.tsx` 225, `use-dismiss.test.tsx` 137,
`command-palette.test.tsx`, `use-command-palette.test.tsx`, `shell-components.test.tsx`), and
`npm run typecheck` (`react-router typegen && tsc`) — which is a **required, separate** gate:
`npm run build` does **not** typecheck.

---

## 9. Remaining rough edges

The pass-16 §8 list of 27 is mostly closed (§0.2). What is genuinely still open:

1. **Two SSE consumers, two disconnect stories.** `use-live-updates.ts` detects a permanently-failed
   EventSource, shows the *live updates paused — retry* chip and re-opens on a `[2s,5s,15s,30s]`
   backoff. `use-run-log-stream.ts` does none of that: it sets *"Live tail disconnected — reload the
   page to resume following."* and stops. The same failure (an expired session 401s both streams)
   self-heals in the shell and needs a manual reload in the log panel. The backoff logic already
   exists next door.

2. **No announcement for drag results, stage moves or run-state flips.** The dnd-kit `Accessibility`
   plugin is off on both lists (deliberately) and nothing replaced it. The toast is now audible
   (§7.2), which closes most of the gap, but a screen-reader user still gets no confirmation of a
   *drop* beyond the toast — and drop targets announce nothing at all.

3. **Four SVG icon sources.** `app/ui/icon.tsx` is documented as *the* ported icon component, but
   `home/project-cards.tsx:18` (`StarIco`), `org-settings/mini-modal.tsx` (`EditIco`) and three in
   `kb-browser/icons.tsx` ship their own. Stroke widths and viewBoxes are not guaranteed to match the
   1.7/24 house style.

4. **`Icon` renders `dangerouslySetInnerHTML`** from a frozen local map. Safe today, but an icon name
   can never become dynamic/user-supplied without a real XSS review.

5. **Two fetcher payload shapes.** Most call sites build `FormData`; six pass a plain object
   (`agents-page.tsx`, `settings-page.tsx`, `github-view.tsx`, `policy-page.tsx`,
   `org-settings/use-org-action.ts`, `store-browser.tsx`). Agents additionally serializes an entire
   profile into a single `payload` JSON field. Both work; the inconsistency is a trap for the next
   person adding an intent.

6. **`settings-page.tsx` is now the largest client file (1559)** — it *grew* during the split pass,
   because dnd-kit + `StageMoveMenu` + per-panel RBAC landed in it. `agents-page.tsx` (1385),
   `board-page.tsx` (1330) and `store-browser.tsx` (1251) are the next three. These four are where a
   UI change is most likely to conflict with concurrent work.

7. **`.rq-` classes are shared by three unrelated surfaces** — review-queue rows, the notifications
   "Waiting on you" list, and the GitHub PR list. A layout change to `.rq-row` touches all three.

8. **20 inline styles survive** and are capped by test, but the cap is a budget, not a rule: the test
   only rejects *all-literal* style objects, so a mixed object with one runtime value can still carry
   four literals. `skip-link.tsx` and `toast.tsx`'s `TOAST_HOST_STYLE` are the two that must stay
   inline (the toast host's must beat the UA `[popover]` sheet).

9. **Residual data defect, not UI**: R16-1 stops a foreign PR from being adopted but does not
   un-adopt one bound *before* the rule existed. VIB-4 in the dev data root still carries merged PR
   #113 in its `task.md`, and the GitHub view will render it. The recovery path is the operator's
   branch-collision packet + `archive_task(+deleteBranch)`.

### 9.1 Class-name → owner map (for cross-referencing `app/app.css`)

| prefix | surface | representative site |
|---|---|---|
| `rq-` | review queue rows, reused by notifications + GitHub PR list | `review-page.tsx:25` |
| `pol-` | policy notes (`pol-note` is the app-wide explanatory-note class), `pol-ev` rows | `policy-page.tsx` |
| `ntf-` | bell popover + notifications page + profile routing grid | `notification-item.tsx` |
| `set-` | instance/project settings shell (`set-head/layout/nav/content/fields`) | `org-settings-page.tsx` |
| `fm-` | KB file browser (tree, rows, `.fm-act` actions, doc editor, GitHub import) | `store-browser.tsx` |
| `rsrc-` | org-settings resources panels | `resource-rows.tsx` |
| `conn-` | org-settings GitHub connections | `connections-panel.tsx` |
| `cred-` | shared credential card (github + project settings + profile) | `credential-card.tsx` |
| `gh-` | GitHub bar/body/table/freshness | `github-view.tsx` |
| `run-` / `runbar` / `rsel-` / `ri-` / `rdot` | runtime strip + agent picker | `runs-panels.tsx` |
| `log-` / `logs-` / `console` / `lt lx ltag ln lcaret` | streamed console (literal hex, never themed) | `runs-panels.tsx` |
| `stg-` | stage list; `.stg-x` is also the generic (now neutral) org-settings icon button | `settings-page.tsx` |
| `ag-` / `cap-` / `be-` / `res-` / `mx-` | agents page, capability matrix, backend picker | `agents-page.tsx` |
| `tl-` | task timeline rail/nodes/cards | `timeline.tsx` |
| `pj-` / `home-` / `sec-h` / `org-tile` / `store-strip` | home | `home-sections.tsx`, `project-cards.tsx` |
| `cmdk-` | ⌘K palette | `command-palette.tsx` |
| `pev-` / `act-` | activity + audit event rows | `activity-page.tsx` |
| `modal-` / `confirm-` / `page-overlay` | the three dialog shells | `mini-modal.tsx` |
| `mention` / `mention-vh` / `composer-` | the Lexical composer + both mention renderers | `rich-text.tsx`, `markdown.tsx`, `timeline.tsx` |
| `field` / `flabel` / `fhint` / `pick-chip` / `mini-seg` / `seg` / `fchip` / `fine` / `deny-note` | shared form + control vocabulary | app.css |

There is **no** `org-`-prefixed CSS class — every `org-*` grep hit is a module path or an identifier.

---

## 10. Deliberate divergences from the UX spec

Source: `planning/planning-artifacts/ux-design-specification.md`. The spec carries inline
"Superseded" notes for the first three; the rest were found by comparison.

| spec says | build does | status |
|---|---|---|
| Palette of graphite / fog / cool gray / **steel blue** | Bright Miro-inspired white canvas, `--blue #5b76fe`, pastel semantic surfaces, a violet agent tint, two radial gradients washing the page background | **Superseded in the doc.** Principles still bind: colour never alone, semantics stable across themes, contrast-constrained ladder |
| **IBM Plex Sans / IBM Plex Mono** | Manrope (display) / Noto Sans (body) / JetBrains Mono | **Superseded in the doc.** "Mono used intentionally" and scan-first rules are honoured |
| **8px base spacing with 4px sub-steps**, 12-column grid | No spacing tokens at all; per-component rem values; CSS grid/flex sized to content | **Superseded in the doc** — a retrofit would touch every surface for no user-visible gain |
| "Three capability modes" / review-first mobile | One capability mode, "the same surface reflowed"; nothing gated on viewport or `matchMedia` | **Amended in the doc** 2026-07-25 and again 2026-07-28 |
| Breakpoints cluster at 1400/1300/1100/1080/1000/900/760 | Those **plus 720** (the mobile rail overlay) — and each now declared **exactly once**, pinned by test with the job it does | Undocumented addition — worth folding into the spec |
| "Skeletons or placeholder structures are preferable to large spinners" | No skeletons anywhere. Loading is a 2px top progress bar (220ms delayed) plus `aria-busy` on individual controls and `.ico.spin` | **Divergence.** Justified by SSR + revalidation, but unmet as written |
| "Toasts for short-lived acknowledgement, not durable task truth" | Honoured — every consequential action also writes a timeline event and an audit row; toasts are 2.6s, capped at 4, never the sole record | Aligned |
| "One primary action per decision surface at most" | Honoured, and pushed further: the **review queue deliberately has no primary action** (R15-11) because acceptance is verdict-gated and can refuse. Pass 16 extended the principle to copy: the queue no longer *offers* a force-accept the task page withholds (R16-3) | Aligned, with two owner rulings |
| "Board is the attention-routing surface … empty states orient toward the next action" | Narrowed by **R15-10**: only the entry column teaches, and only when the whole board is empty | Deliberate narrowing |
| "clear screen-reader announcements for consequential state changes" | The toast host now genuinely announces, including over an open dialog (§7.2); the live-paused chip, archived banner, board orphan banner and empty palette result are `role="status"`. But **drag results, drop targets and stage moves still announce nothing** — the dnd-kit `Accessibility` plugin is off on both lists and no live region replaced it | **Substantially improved, still a partial divergence** — the largest remaining a11y gap |
| "touch targets large enough for tablet and mobile review flows" | `.btn` min-height 38px, `.icon-btn` 38px; the collapsed palette triggers are pinned finger-sized by test. But `.fm-act` 26px, `.rev-x` 26px, `.stg-x` 24px, `.own-x` 20px, `.tag button` 16px, `.ag-add` 22px are at or under the 24×24 minimum of WCAG 2.2 **2.5.8** | **Divergence**; axe does not check 2.5.8, so the gate misses it. (Hover-reveal *reachability* on touch was fixed; target *size* was not) |

Also worth knowing: `planning/discovery-2026-07-28-pass15/UX-ASSESSMENT.md` is the most recent
holistic judgement of the UI ("coherent — unusually so"), and names the five habits worth protecting:
empty states that teach, counts that name their scope, refusals rendered as copy rather than disabled
buttons, honesty over reassurance, and the two-surface mental model taught in subtitles. Pass 16
strengthened three of them directly — refusals became `aria-disabled` + visible reason, counts got
`countLabel` so they stop disagreeing with their nouns, and honesty reached the Agents page
("not configured" instead of "available") and the review queue (terminal facts over process gates).
Any change to this UI should still be checked against those five.
