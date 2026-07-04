# Phase 4 report — Shell, Home, Board

Status: complete. All gates pass: `npm run typecheck` clean, `npm test`
227/227 (185 phase-1/2/3 + 42 new), `npm run build` clean (only RR v8
future-flag warnings, pre-existing). Live-verified against `npm run dev`
(curl + preview browser): `/` → `/login` signed out; login as
arda@viberr.dev / viberr-dev-2828 lands on Home with 3 project cards
(Pinned: Viberr Core + Deploy Pipeline), hero stats "3 runs active … 2
decisions waiting on you"; `/projects/viberr-core` redirects to `/board`
which renders 5 columns with all seeded cards (VIB-142 in Review with
`card wait-human urgent`, ReadinessPill input required, owner rev-stack
"Arda Kaya", branch chip `vib-142-attach-…`, PR `#318`); rail counts
board 10 / review 2 / settings 1 (coral); create-task POST (cookies+CSRF)
minted VIB-169, task.md appeared on disk with the exact create defaults
and the card showed after revalidation (rail count 11); bell stream
carried all 10 notifications, mark-one-read 6→5 and mark-all-read →0;
theme POST set `users.theme=dark` + `viberr_theme=dark` cookie and the
next SSR rendered `data-theme="dark"`; task preview crumb showed
"VIB-142 · Attach execution workspace to task runtime"; DEP-31 (stub
project) rendered the in-shell 404 panel with the rail intact; New-task
modal verified in-browser: aria-modal, autofocus, stage chips exclude
Done, Escape closes. Verification artifacts removed (VIB-169 deleted +
rescan, theme reset, re-seed restored notification read state) and the
server was stopped.

New deps: `@testing-library/react@^16.3.2`, `jsdom@^29.1.1` (dev; versions
verified via `npm view`). New migration: `0004_user_prefs.sql`.

## File inventory

```
db/migrations/0004_user_prefs.sql        # user_prefs(user_id, key, value_json) — personal UI prefs
test-support/test-app.ts                 # route-level harness: env→temp data root, real session
                                         # cookies + CSRF tokens against actual route modules
app/
  root.tsx                               # + ToastProvider around <Outlet/>; theme-applier effect
                                         # (re-applies data-theme post-paint, matchMedia on "system")
  routes.ts                              # full phase-4 route map (below)
  app.css                                # + home.css ported VERBATIM (deduped vs phase-2 login block;
                                         # body overflow scoped to :has(.login-wrap)/:has(.home)) +
                                         # marked phase-4 additions (anchor resets, .task-preview,
                                         # .ntf-page)
  routes/
    _index.tsx                           # Home: loader (projects/prefs/org/notifications) + action
                                         # (pin | view | rescan | create-project)
    project.tsx                          # workspace layout: rail+topbar+Outlet; THE board loader
    project._index.tsx                   # /projects/:slug → redirect board
    project.board.tsx                    # board view (data from layout) + action (create-task | rescan)
    project.task.tsx                     # tasks/:key placeholder panel + in-shell 404 boundary
    project.{review,agents,policy,github,activity,settings}.tsx   # real routes, PlaceholderView
    profile.tsx                          # PageOverlay route: identity + theme picker (phase 9 fills)
    notifications.tsx                    # PageOverlay route: full list + read actions (phase 9 fills)
    notifications.read.tsx               # POST resource: intent read {id…} | read-all
    prefs.theme.tsx                      # POST resource: users.theme + viberr_theme cookie
    org.settings.tsx                     # placeholder (Home tiles link here; phase 9 replaces)
  features/
    shell/
      nav.ts                             # WORKSPACE_NAV + workspaceViewFromPathname/Label
      rail.tsx                           # rail: project-switch→/, NavLinks + live counts
      topbar.tsx                         # brand, crumbs, REAL search (?q=), ⌘K, bell, user menu
      top-bell.tsx                       # THE bell popover (both shells) — real reads + navigation
      user-menu.tsx                      # THE account menu (+ applyThemePreference helper)
      placeholder-view.tsx               # "arrives in phase N" panel
      workspace-routes.server.test.ts    # route-level tests (auth gating, board shape, actions)
    board/
      board-page.tsx                     # Board port: columns/TaskCard/OwnerLine/ReviewerStack/
                                         # WaitTag/ListView/NewTaskModal/filter bar
      board-filters.ts [test]            # matchesBoardFilter/matchesSearch/shortBranch (pure)
    home/
      home-page.tsx                      # Home port: StageMeter/ProjectStats/MemberStack/Card/Row/
                                         # NewProjectModal/HomePage (+ StarIco)
      home-query.server.ts               # listHomeProjects + getHomeOrgSummary (+ accentForSlug)
      project-create.server.ts           # createProject (template → project.md → reproject → audit)
      project-name.ts                    # keyFromName + slugifyProjectName (client-safe)
    notifications/
      notification-meta.ts               # THE ntfMeta + plainText (ruling 14, ported once)
      notification-item.tsx              # THE .ntf-item row (popover + page) [jsdom test]
  server/
    prefs/user-prefs.server.ts           # getPref/setPref + Home prefs helpers
    projections/policy-violations.server.ts [test]  # rail Settings badge derivation (see below)
    auth/require-user.server.ts          # SessionUser + avatarTone (additive)
    seed/demo-seed.server.ts             # + Arda's Home pins (INSERT OR IGNORE user_prefs)
  shared/dates/format.ts [test]          # THE display formatter (ruling 4): formatClock/
                                         # formatDayBucket/formatDayTime/formatDayDotTime/formatRelative
  ui/
    use-dialog.ts                        # useDialog(onClose): Escape/focus-trap/restore/scroll-lock
    toast.tsx                            # + ToastProvider/useToast context (single app-wide host)
    csrf-input.tsx                       # + useCsrfToken() for programmatic fetcher.submit
.claude/launch.json                      # viberr-dev preview config (npm run dev, port 5173)
```

## Route map as built

```
/                          Home (loader+action)                       public: no
/login /logout /auth/*     unchanged phase-2
/org/users                 unchanged phase-2 temp admin page
/org/settings              placeholder (?tab= carried for phase 9)
/profile                   PageOverlay route (minimal; phase 9 fills)
/notifications             PageOverlay route (functional list; phase 9 fills)
/notifications/read        POST resource (read | read-all)
/prefs/theme               POST resource (theme cookie + user row)
/projects/:slug            layout "routes/project" (rail+topbar+Outlet)
  (index)                  redirect → board
  board                    Board (action: create-task | rescan)
  review|agents|policy|github|activity|settings   placeholder views
  tasks/:key               "routes/project.task" placeholder + 404 boundary
```

## Shell integration points for later phases

**Adding a rail view (phases 5/7/9).** Replace the placeholder route
module (e.g. `routes/project.review.tsx`) — the route, rail entry, count
and crumb label already exist. Rail labels/order live in
`app/features/shell/nav.ts` (`WORKSPACE_NAV`); the crumb label comes from
`workspaceViewLabel(workspaceViewFromPathname(pathname))`. Views render
inside `.main` under the topbar; the layout loader
(`routes/project.tsx`, id `"routes/project"`) already provides
`{ user, board (getBoard shape), myRole, taskCount, reviewCount,
violations, notifications, unread }` via
`useRouteLoaderData("routes/project")` — the board child has NO loader of
its own by design (one query feeds rail + columns; any action on a child
revalidates both). Add a child loader only for data the layout doesn't
have.

**Bell / notifications.** `TopBell` (features/shell/top-bell.tsx) is the
single popover used by both the workspace topbar and the Home header; it
takes `{ notifications: NotificationView[], unread }` from the surface's
loader and internally fetch-POSTs `/notifications/read`
(`intent=read&id=…` | `intent=read-all`, `_csrf` field required). Item
click marks read + `navigate("/projects/{slug}/tasks/{key}")` — works
cross-project because ruling 9 seeded the stub projects; unknown keys
land on the task route's in-shell 404 boundary. Row markup is
`NotificationItem` and kind→icon/palette is `ntfMeta`
(features/notifications/) — phase 9's full page must reuse both plus
`plainText` (page renders rich via the shared RichText renderer it will
add). "See all" navigates to `/notifications` with
`state.returnTo`.

**Search.** The topbar search is REAL: it writes `?q=` on the board URL
(replace navigation; typing on non-board views navigates to the board
with the query). The board filters client-side with
`matchesSearch(task, q)` (features/board/board-filters.ts — key, title,
branch, owner/specialist/consultant/operator names) combined with the
chip filter `matchesBoardFilter` (contracts §2.3 semantics on canonical
enums). ⌘K/Ctrl-K focuses the input on both shells. Filter/view state is
also URL params (`?filter=human&view=list`).

**Theme.** POST `/prefs/theme` (`theme=light|dark|system`, `_csrf`) —
updates `users.theme`, re-issues the `viberr_theme` cookie via the
route's `headers` export. Client-side `applyThemePreference()`
(user-menu.tsx) applies `data-theme` instantly; root.tsx's effect keeps
it in sync after revalidation and live-follows the OS on "system".

**Task-detail placeholder (phase 5 replaces `routes/project.task.tsx`).**
Its loader returns `{ task: TaskSummary }` from `getTaskSummary`; keep
that contract — the layout's crumbs read `task.key`/`task.title` from the
match with id `"routes/project.task"`. The 404 ErrorBoundary (in-shell
panel, rail intact) should be kept/extended. `useDialog` (app/ui) gives
any new dialog the ruling-16 behaviors without markup changes;
`useToast()` replaces the mock's prop-drilled `push`; `useCsrfToken()`
feeds programmatic `fetcher.submit` calls.

**Dates.** All display timestamps go through `app/shared/dates/format.ts`
(clock / Today-Yesterday-"Mar 30" buckets / `{day} · {t}` / relative).
Phase 5's timeline should use `formatDayDotTime`.

**Rail settings badge.** `countOpenPolicyViolations` scans projected
`policy` events (newest `**Policy violation:**` not superseded by a newer
`**Policy update:**` per task) — yields exactly 1 for the seeded VIB-142
flag. Phase 7 replaces the derivation with real per-violation records
(ruling 5); the rail only needs the count to keep coming from the layout
loader.

## Decisions / deviations

1. **Profile/Notifications overlay-vs-route (shell §8.3, home §9.5):**
   real top-level routes rendering inside `PageOverlay`. In-app openers
   pass `state.returnTo` (close returns to the underlying view's URL);
   direct loads close to `/`. The view underneath is NOT kept mounted
   (true parallel routes aren't worth the complexity in V1) — the overlay
   covers the viewport, so the difference is invisible except behind the
   scrim edges. Both surfaces are deliberately minimal; phase 9 fills the
   same routes.
2. **Board filter/view/search in URL params** (spec §5.3 recommendation)
   — survives refresh/share; the mock lost them on reload.
3. **Re-scan toast wording** aligned to the real store (contracts §7.3):
   board "Re-scanning the task store…" (was ".viberr store"), completion
   string kept verbatim. Home keeps "Store re-scanned — N project dirs,
   no drift found" and says "… X changed" when drift exists (real
   numbers from `RescanSummary`).
4. **Home `running` count** = tasks with `waiting === "agent"` (agents
   actively working) until Phase 8's run registry exists. The seeded
   viberr-core yields 3 — the mock's number. `waiting` = open decision
   packets, project-wide (ruling 10). Stub projects honestly show
   "0 tasks" (the mock's 6-project HOME fixture was aspirational).
5. **Home "connections"** (modal picker + settings tile) are the distinct
   repo owners already in use (seed: `akin-ozer`) — honest stand-in until
   Phase 7's PAT store; the modal's zero-connection warning + disabled
   Create still work. Documented in home-query.server.ts.
6. **Project slug** (home §9.1) = slugified project name
   (`slugifyProjectName`), uniqueness-checked (409 into the modal's
   def-note error slot). Post-create stays on Home (mock behavior); the
   new card appears via revalidation.
7. **Accent stability** (home §8.6): deterministic djb2 hash of the slug
   over the mock's 6-color palette — stable across creations; individual
   projects may differ from the mock's index-based colors.
8. **Pins/view prefs** live in the new `user_prefs` table (home §9.8) —
   phase 9's profile prefs get the same table. Optimistic UI (personal,
   not governed). Seed adds Arda's mock pins with INSERT OR IGNORE so a
   user's own changes survive re-seeding.
9. **Rail settings badge derivation** is a documented Phase-4 stand-in
   (see integration points); ruling 5's real per-violation records arrive
   in Phase 7.
10. **Board cards show NO validation pill** — the phase brief mentions an
    "evidence-changed chip", but board spec §3.2/§7.12 and the mock are
    explicit: validation feeds only the Needs-attention filter. The
    task-preview panel DOES show the ValidationPill ("evidence changed"
    on VIB-142). Followed the spec; flagging the discrepancy here.
11. **List view empty state** added (`.empty` "No tasks", ruling 16);
    create-task modal stage picker excludes the LAST stage (matches the
    server's done-stage rejection; identical to the mock's literal
    `done` filter for both templates).
12. **New-task/new-project modals**: Escape/focus-trap/aria-modal added
    via `useDialog` (markup unchanged); server errors render in
    `foot-hint err` / a `def-note` row and the dialog stays open
    (mock could not fail).
13. **Cross-project bell rows navigate for real**; the target task
    (DEP-31/BIL-9) doesn't exist as a file, so they land on the task
    route's designed in-shell 404 panel — sanctioned by ruling 9 (stub
    projects exist so navigation works); phase 9 may seed stub tasks if
    the dead end bothers demos.
14. **`SessionUser.avatarTone` added** (additive phase-2 touch) so shell
    avatars render real tones; the phase-2 equality test was updated
    accordingly. Theme label in the user menu reads the root loader's
    cookie value (DB + cookie are kept in sync by the action).
15. **Org-settings placeholder route** added (not in the phase brief) so
    the Home settings tiles are real links (no dead ends); admin-only
    "Org users (temp)" also lives in the user menu per the brief.
16. **`nextTaskNumber` is not rolled back** when a created task is
    deleted externally (verification VIB-169 was removed; the counter
    stays at 170) — by design, keys are never reused.
17. **Greeting** is loader-computed (server local time) with
    `suppressHydrationWarning` — single-node self-host assumption
    (home §8.10).

## Known gaps (intentional, later phases)

- No SSE yet (Phase 6): board/bell update on action revalidation only;
  external file edits appear after reload or Re-scan (the watcher still
  reprojects in the background).
- review/agents/policy/github/activity/settings + /org/settings are
  placeholder panels (Phases 7/9); /profile and /notifications are
  minimal (Phase 9).
- Task detail is the preview panel only (Phase 5).
- `myRole` gates only create affordances so far (viewer/non-member hides
  New task + column "+"); the full RBAC UI surfaces arrive with their
  views. All mutations enforce RBAC server-side via the phase-3
  functions regardless.
- Notification popover is unbounded (mock parity; the brief's
  verification expects all 10 visible). Cap when real volume exists.
