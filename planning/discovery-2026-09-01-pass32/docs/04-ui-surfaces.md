# 04 — UI surface map

Pass 32 discovery, at `main` **68b5480e** (2026-09-01). Every user-facing surface in the
React Router 8 app: routes and their document titles, the shell, the board, task detail, the
design system, the `app/ui/` primitive library, and the traps a UI implementer will hit.
Paths are repo-relative to `/Users/akinozer/projects/viberr`; every `path:line` below was
re-resolved against this tree, not carried over from pass 31.

Framework facts that shape everything below:

- React Router v8 **framework mode** with a typed route config at `app/routes.ts` (80 lines);
  loaders and actions live in the route module, feature folders hold the components.
- **No optimistic UI for governed state.** Mutations POST to a route action; the SSE stream
  revalidates the loaders; the server's answer is the only commit
  (`app/features/live-updates/use-live-updates.ts:9-13`).
- Every mutating form carries `_csrf` (`app/ui/csrf-input.tsx`) and an `intent` field the
  action switches on.
- One stylesheet: `app/app.css` (**5258** lines), no Tailwind, no CSS modules. Its gate,
  `app/app.css.test.ts` (**2702** lines, 94 tests, green on this tree), has no allowlist.

**What moved in the UI since pass 31** (`git log f868f131..HEAD`): PR #253 (pass-31
implementation), #254 (rulings 100-103 + the full UX-spec controller retrofit), #257
(ruling 104), #258/#259 (ruling 105 + addendum), #260 (ruling 106), #261 (ruling 107),
#262-#264 (ruling 108). In this domain the touched files are exactly: `app/app.css`,
`app/app.css.test.ts`, `app/routes.ts`, `app/routes/{insights,org.settings,task-attachment,
resources.health,resources.run-log,resources.session-export}.*`, `app/ui/markdown.tsx`,
`app/features/agents/create-profile-modal.tsx`, `app/features/insights/insights-page.tsx`,
`app/features/org-settings/{controller-admin-panel,org-settings-page,agent-template-modal}.tsx`,
`app/features/runtime/{runs-helpers,runtime-types}.ts`, and
`app/features/task-detail/{decision-packet,attachment-lightbox,attachments-panel,timeline,
task-side-panels,task-detail-page}.tsx`. Nothing else in `app/features/` or `app/ui/` changed;
`app/features/controller/controller-page.tsx`, the board, policy, profile, review, github,
activity, shell and store-browser files are byte-identical to pass 31.

---

## 1. Route table

Config: `app/routes.ts`. Three top-level groups — public/auth, the pathless
**palette shell** (F20-30), and the `/projects/:slug` **workspace layout**.

### 1.1 Public / auth / redirect

| Path | Route module | Feature component | What the user sees / does | Loader + actions |
| --- | --- | --- | --- | --- |
| `/login` | `app/routes/login.tsx` | (self-contained, 20 KB) | Two server-driven modes: `"login"` (OAuth provider buttons + local credentials form) and `"reset"` (forced set-new-password behind the `pwreset_required` gate). Brand aside appears at `min-width: 900px` (`app/app.css:3605`) — the sheet's only `min-width` query. | Loader returns `{ mode, returnTo, providers: { github, google } }` (`login.tsx:60`); unconfigured providers render **disabled with an explicit reason** (D12, `login.tsx:281-290`), never hidden. Action signs in via better-auth. |
| `/logout` | `app/routes/logout.tsx` | — | No UI. POST only. | Revokes the better-auth session + clears the cookie. |
| `/api/auth/*` | `app/routes/api.auth.$.ts` | — | better-auth's own router (sign-in/out, social, `.well-known`, `getSession`). Splat so OAuth callbacks at `/api/auth/callback/*` reach it (`routes.ts:11`). | — |
| `/projects` | `app/routes/projects.tsx` | — | Redirects to `/` — bare `/projects` is a reasonable-looking URL and must not 404 (N5, `routes.ts:66`). | — |
| `/` | `app/routes/_index.tsx` | `HomePage` (`app/features/home/home-page.tsx:52`) | Multi-project landing: greeting, project grid/list toggle, pinned + archived sections, New-project modal, org store strip, settings tiles. Mounts its own `useCommandPaletteShortcut` and the `TopBell`/`UserMenu` pair. | Loader: `user, greet, projects (listHomeProjectsForUser), prefs (getHomePrefs), org (getHomeOrgSummary), notifications (limit 100), unread`, plus data-root hints. Actions: create project, rescan/rebuild projections (single-flight + throttled), home-pref patches. SSE scope `projects` + `user`. |

### 1.2 Palette shell (`app/routes/palette-shell.tsx`)

A **pathless layout** (`routes.ts:23-36`) that mounts only `useCommandPaletteShortcut` +
`<CommandPalette>`. It exists because `/profile`, `/notifications`, `/org/settings`,
`/controller` and `/insights` render OUTSIDE the workspace layout as top-level `PageOverlay`
routes, so ⌘K — which Home calls "one shortcut app-wide" — never reached them. It
deliberately does **not** wrap Home or the workspace, both of which mount the hook
themselves. Its comment block was corrected in this delta (`routes.ts:13-22`): the `§4.6` /
`§5.11` numbers are now explicitly labelled *historical*, pointing at the `docs/build/specs`
set deleted in `c1acf2c`, with `planning-artifacts/ux-design-specification.md` named as the
live canon.

| Path | Route module | Feature component | What the user sees / does | Loader + actions |
| --- | --- | --- | --- | --- |
| `/org/settings` | `app/routes/org.settings.tsx` (27 KB) | `OrgSettingsPage` (`app/features/org-settings/org-settings-page.tsx:65`) | Tabbed instance-admin surface. H1 reads **"Instance settings"** (`org-settings-page.tsx:151`; the user menu's entry uses the same name, D2 pass 23). Five tabs, then three always-rendered cards. | Org-admin gated (`org.settings.tsx:109` loader, action re-checks). Many `intent`s through `useOrgAction`. Loader now also returns `controllerConfig` **and** `controllerLocks` (`org.settings.tsx:126-128`, ruling 108). |
| `/org/settings/audit-export` | `app/routes/org.settings.audit-export.ts` | — | CSV/JSON audit-log file download, org-admin gated. | Resource route, no UI. |
| `/controller` | `app/routes/controller.tsx` | `ControllerPage` (`app/features/controller/controller-page.tsx:36`) | Ruling 99: the instance controller. **Every signed-in user converses**; what it answers and applies is gated per tool call on that user's own authority. Conversations belong to their owner; org admins may read everyone's with `?all=1`. | `getControllerSurface` (`controller-query.server.ts`). |
| `/insights` | `app/routes/insights.tsx` | `InsightsPage` (`app/features/insights/insights-page.tsx:48`) | Instance-wide agent-run analytics (cost/token totals across projects). **Org-admin only**, read-only: one aggregate query, the page formats it. | Loader only (`insights.tsx:16`). |
| `/profile` | `app/routes/profile.tsx` | `ProfilePage` (`app/features/profile/profile-page.tsx:877`) | URL-addressable `PageOverlay`: identity, notification routing prefs, Appearance panel (theme + reduce-motion, ruling 13), read-only RBAC access view, GitHub identity, self-serve password change. | `getProfileView`; actions in `profile-actions.server.ts`. Opened from the user menu with `state.returnTo`. |
| `/notifications` | `app/routes/notifications.tsx` | `NotificationsPage` (`app/features/notifications/notifications-page.tsx:269`) | URL-addressable `PageOverlay`: "Waiting on you" packet/approval cards, "Everything else" day-grouped stream, All/Unread filter, mark-all-read. Row clicks navigate for real, cross-project included. | Mutations go through the ONE `/notifications/read` action. `NOTIF_PAGE_LIMIT = 200` over-fetched by one (`notifications.tsx:44-50`). SSE `user` scope. Opened with `state.returnTo` (parsed defensively — history state is not the app's to trust, `notifications.tsx:37`). |

### 1.3 Resource routes (fetcher / file targets, no UI)

| Path | Module | Purpose |
| --- | --- | --- |
| `/notifications/read` | `app/routes/notifications.read.tsx` | The ONE mark-read action behind both bells and the page. Intents `read` (repeatable `id` fields) and `read-all`. Idempotent; emits a user-scoped `notification.read` SSE so other tabs revalidate (E12). |
| `/prefs/theme` | `app/routes/prefs.theme.tsx` | Theme cycling. Persists to `users.theme` **and** the `viberr_theme` cookie so the next SSR paints correctly. The client applies `data-theme` optimistically. |
| `/resources/events` | `app/routes/resources.events.ts` | The SSE stream. Repeatable `scope=` params: `project:<slug>`, `task:<slug>/<key>`, `projects`, `user`. Plain **401 JSON** for an expired session (an EventSource cannot render a login page); 400 bad scope, 403 all-foreign. `MAX_QUEUED_CHUNKS = 1024` backpressure cap (`resources.events.ts:62`). |
| `/resources/run-log` | `app/routes/resources.run-log.ts` | Run-log tail: lines since a seq, plus backward paging. Member-only (403 otherwise). **Changed this delta**: a controller run's log now follows conversation ownership through the shared `canReadControllerRunLog` gate (ruling 107) rather than a local check. |
| `/resources/health` | `app/routes/resources.health.ts` | Ops probe. **Rewritten this delta** (ruling 107): the body assembly moved to `~/server/ops/health-snapshot.server`, and the route is now **two probes on one URL** — liveness (default, always 200 while serving) and readiness (`?probe=readiness\|ready`, 503 when anything in `degraded` is set). The body carries `status: ok \| degraded \| down` plus a `degraded` list on both. It is **no longer** the pass-31 `{ ok, projections, watcher }` shape. |
| `/resources/search` | `app/routes/resources.search.ts` | ⌘K palette query. `q` truncated to 120 chars; `searchWorkspace` scopes to the viewer's visible projects, so the route needs no project guard. |
| `/resources/model-catalog` | `app/routes/resources.model-catalog.ts` | Model + effort (reasoning) pickers. **Two consumers now**: the agent create/edit modal and the org-settings Controller tab (ruling 106), both through `useModelCatalog`. |
| `/resources/session-export` | `app/routes/resources.session-export.ts` | Downloads a bash installer carrying a run's provider transcript so the conversation resumes locally. |
| `/projects/:slug/tasks/:key/attachments/:file` | `app/routes/task-attachment.ts` | Serves one browser-produced attachment (R19-19). **Member-only**, outside the workspace layout. Traversal-refusing resolver, `X-Content-Type-Options: nosniff` + `Content-Security-Policy: sandbox`, whitelisted inline types only, memory-bounded. **New this delta (ruling 105)**: `?download=1` forces `content-disposition: attachment` even for an inline type (`task-attachment.ts:54-66`) — that is what the lightbox's Download button asks for. |

### 1.4 Workspace layout — `/projects/:slug` (`app/routes/project.tsx`)

The single chokepoint for every project surface. Loader (`project.tsx:70`):

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
| `…/board` | `project.board.tsx` | `BoardPage` (`app/features/board/board-page.tsx`, 2420 lines) | The stage board / list. See §3. | Reads the LAYOUT loader via `useRouteLoaderData("routes/project")` — one query feeds rail counts and columns. Intents: `create-task`, `reorder`, `rescan`. Visibility gated by `roleCan(myRole, "create-task" \| "reorder-board" \| "rescan-project")` — the action ids the server enforces, never role literals (UI-58/E3). |
| `…/review` | `project.review.tsx` | `ReviewQueuePage` (`app/features/review/review-page.tsx:172`) | The review queue: tasks at the review boundary, split by whether the viewer holds acceptance authority. Read-only loader; SSE revalidation removes accepted tasks with no local state. | `getReviewQueue` + `resolveAcceptanceAuthority`. |
| `…/controller` | `project.controller.tsx` | `ControllerPage` | The same controller machinery bound to this board, plus the **Goals panel** where a human sees and redirects every chain (ruling 99). | `getControllerSurface`. Membership enforced on this route's own loader, not only the layout's. |
| `…/agents` | `project.agents.tsx` | `AgentsPage` (`app/features/agents/agents-page.tsx:1246`, 1661 lines) + `CreateProfileModal` + `CapabilityMatrixModal` | Agent roster (org templates ⊕ `project.md` deployments), live-deployment view, capability matrix. | Loader assembles roster + live deployments joined with `agent_runs` + stages. Actions: create/update/delete-profile via the phase-3 `project.md` writers; toast copy computed server-side. SSE revalidates on `project.updated` / `task.updated` / `run.state-changed`. |
| `…/policy` | `project.policy.tsx` | `PolicyPage` (`app/features/policy/policy-page.tsx:622`) | Members + roles, workflow transitions, the RBAC grant table rendered from `app/shared/rbac.ts`, agent roster, audit-derived last-change chip. | `getPolicyViewData`. Actions `set-role` (last-admin guard) and `set-boundary` (review→done hard-locked human). Admin-gated inside the action. |
| `…/github` | `project.github.tsx` | `GithubViewPage` (`app/features/github/github-view.tsx:405`) + `CredentialCard` | Repository panel, credential health/scopes, PR + branch rows. **The only loader in `app/routes/` that awaits the network** — hence `RoutePendingBar`. | `getGithubViewData` = `checkRepoAccess` + `getProjectCredentialHealth` + task projections. Actions: `reconcile`, `grant-scope`. Every degraded GitHub state is a typed value, never a thrown error. |
| `…/activity` | `project.activity.tsx` | `ActivityPage` (`app/features/activity/activity-page.tsx:626`, 829 lines) | Cross-task activity stream + audit log, both day-grouped and bounded newest-first. `?stream=` / `?audit=` raise the limits ("Show older"). | Read-only projection loader; shell SSE keeps it fresh. |
| `…/settings` | `project.settings.tsx` | `SettingsPage` (`app/features/project-settings/settings-page.tsx:1569`, 1799 lines) | Project identity, stages + per-stage counts, membership with invite status, credential health, **Danger zone** (archive/restore/delete) rendered only for `edit-policy` holders (Q-V1). | `getSettingsViewData`; a large `intent` surface in `settings-actions.server.ts`. |
| `…/tasks/:key` | `project.task.tsx` (1163 lines) | `TaskDetailPage` (`app/features/task-detail/task-detail-page.tsx`, 978 lines) | The deepest surface. See §4. | 23 action intents (§4.6). Adds a `task:` SSE scope; keeps the Board rail item active (the task view is "inside" Board). |

### 1.5 Document titles per route

`root.tsx` exports **no** `meta`, so a route without its own `meta` inherits the closest
ancestor that has one. Complete inventory (module `:line` of the `meta` export):

| Route | Title | Where |
| --- | --- | --- |
| `/` | `Viberr` (+ a `description` meta) | `app/routes/_index.tsx:36-41` |
| `/login` | `Viberr · Sign in` | `app/routes/login.tsx:30-32` |
| `/controller` | `Controller · Viberr` | `app/routes/controller.tsx:21-23` |
| `/insights` | `Insights · Viberr` | `app/routes/insights.tsx:12-14` **(added this delta)** |
| `/notifications` | `Notifications · Viberr` | `app/routes/notifications.tsx:29-31` |
| `/profile` | `Profile & preferences · Viberr` | `app/routes/profile.tsx:47-49` |
| `/org/settings` | `Instance settings` (**no `· Viberr` suffix**) | `app/routes/org.settings.tsx:104-106` |
| `/projects/:slug` (layout) | `{project.name} · Viberr`, or `Viberr` before the loader answers | `app/routes/project.tsx:64-68` |
| `…/review` | `Review queue · {slug} · Viberr` | `app/routes/project.review.tsx:18-20` |
| `…/activity` | `Activity · {slug} · Viberr` | `app/routes/project.activity.tsx:34-36` |
| `…/tasks/:key` | `{task.key} · {task.title}`, else `{params.key}` (**no `· Viberr` suffix**) | `app/routes/project.task.tsx:1067-1075` |
| `…/board`, `…/agents`, `…/policy`, `…/github`, `…/settings`, `…/controller` | **no `meta` of their own** — all six inherit the layout's `{project.name} · Viberr` | — |
| `/logout`, `/projects`, `palette-shell`, every `/resources/*`, `/notifications/read`, `/prefs/theme`, `/api/auth/*`, `/org/settings/audit-export`, the attachment route | no `meta` (no UI, or a pathless layout) | — |

### 1.6 Per-surface notes

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
2000/600 (`app/features/activity/feed-limits.ts:8-11`), with a "Showing the newest 2000…"
note at the ceiling. The actor mini-seg is **client-side and filters the Stream only**.
`compactAuditEntries` folds runs of ≥2 `runtime.run.started` rows into one "N runtime
sessions opened" row (regex anchored at the end so a hostile display name cannot trigger the
fold). `ACT_ICON` is `satisfies Record<TIMELINE_EVENT_TYPES[number], IconName>` — a new event
type is a compile error. Row glyph classes are composed as `"pev-ico act-" + r.type`
(`activity-page.tsx:761`), so the eleven `.pev-ico.act-*` rules in the sheet are all live.

**Insights** (`insights-page.tsx:48`, 505 lines). Org-admin only, **no actions at all**. Six
top stat cards (`insights-page.tsx:77-119`), a daily bar chart (`role="img"`, per-column
`title`), then **six** "Delivery oversight" cards (`:158, :168, :178, :193, :203, :216`),
four breakdown bar-lists (backend / kind / project / model), and a backend quota panel.
Honesty rules: the metric is **"Completion rate"**, not success rate; a null cost renders
**"not reported"** (`:469`, `:494`), never `$0.00`; absent values render `"n/a"` and
`StatCard` de-emphasises exactly that string with `.na` (`:420`, `:426`).

Two changes this delta:
- **Coordination overhead** card (`insights-page.tsx:216-225`, F31-D6). Value is
  `fmtPercent(g.coordination.share)`; sub-text names **operator and controller** runs
  together so controller turns are never implied to be free, and reads "no run has reported
  a cost yet" when nothing did. Share is over cost-reporting runs only, `null` (→ "n/a" +
  `.na`) rather than a fake 0%.
- **Backend quota rows gained a fourth state** (`insights-page.tsx:250-401`, D5/V4). A
  provider that *refused* a run now renders `"usage limit reached"` with the track at 100%
  and a `bar-cost` line reading `"from a refused run"` plus an optional `retry after …`
  (an `exact` reset renders a local instant post-hydration; a `prose` one renders only the
  ISO calendar date, because it was reconstructed in the account's unknown timezone). A
  utilization reading observed *after* the refusal wins (`observedAfter` at
  `insights-page.tsx:233-239`, applied at `:267-270`), so the row cannot pin at 100% while
  the backend is demonstrably answering. The panel footnote (`:395-401`) states exactly when
  the row clears.

**GitHub** (`github-view.tsx:405`). Repository + Pull requests side by side, Branches full
width. The header freshness chip carries **two clocks** — last check vs last change. Intents:
`reconcile`, `grant-scope`, `set-credential`, `clear-credential`. `CredentialCard` is shared
with project settings. The credential is **redacted in the loader** by
`withoutCredentialDetail` (`app/features/github/credential-visibility.server.ts:70`), so the
token tail never reaches the HTML. A never-reconciled branch renders **"not compared"**,
never green "synced".

**Review queue** (`review-page.tsx:172`). Two panels: "Waiting on your acceptance"
(`:244`) and "Still in review". **Zero mutations** — the row is deliberately labelled
**"Review", not "Accept"**, because acceptance is verdict-gated and may refuse. The one
header control is a chip reading `{reviewStage} → {terminalStage} · human only` (or
`· human or operator`, `review-page.tsx:234`) that navigates to Policy; its state comes from
`resolveAcceptanceAuthority`, which requires the operator to be deployed at full autonomy
with `completion-for-acceptance: direct` and falls back to the strict boundary on any error.

**Controller** (`controller-page.tsx:36`, 482 lines, rendered by **two** routes; unchanged
this delta). Transcript + composer beside a side column of `GoalsPanel` (project scope only)
and `ConversationList` (org admins toggle `?all=1` via the `Show everyone's (org admin)` /
`Show mine only` links, `:165-167`). Header sub-line is `Managing the {slug} board with your
own permissions.` or `Managing this instance with your own permissions.` (`:101-102`).
Composer footer: `Acts with your permissions · refusals say why · ⌘↵ sends` (`:305`) above
the surface's single `.btn.primary.sm` Send (`:309`). Live signal is one line,
`{controllerName} is working…` (`:246`) — no token count, elapsed, or cost. Intents: `send`
(creates a conversation when `conversationId` is absent, then writes the id into `?c=`) and
`goal-op` with `op` in `pause | resume | cancel | skip_link | retry_link`. Live:
`useLiveUpdates` **plus a 5-second fallback poll while `turn.working`**, because a missed
settle event would read as a hang.

**Notifications** (`notifications-page.tsx:269`). "Waiting on you" cards over an
"Everything else" day-grouped stream, All/Unread seg, Mark all read. `splitNotifications`
dedupes to exactly one waiting card per task **before** the filter runs, so filtering cannot
change what counts as pending. The panel header states the authoritative `decisionCount`
(same source as the home hero), and discloses the shortfall as "N on their task pages".
Orphan rows render a dead `span.keybtn.dead` reading "project no longer exists".

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

`create-profile-modal.tsx` was refactored this delta (ruling 106) without changing its own
UX: the model/effort pickers are now the exported `ModelEffortFields`
(`create-profile-modal.tsx:510`) driven by the exported `useModelCatalog` hook
(`:128`), so the controller tab renders the identical control. One behaviour fix rode along
in both editors (review D1, `:178-187`): a stored model is re-seeded to the catalog default
**only** when the runtime would itself substitute it — a dated `claude-*` id or family alias
that `claudeModelRunsVerbatim` accepts is preserved by the select's own
preserve-a-seeded-value option instead of being silently repinned on the next save.

**Instance settings** (`org-settings-page.tsx:65`, 585 lines). Five `?tab=`-driven tabs with
live count badges — **connections · users · sso · resources · controller**
(`org-settings-page.tsx:33-43`) — plus always-rendered `RunConcurrencyControl`,
`AuditExportCard` and `StorageLine` (`:205-207`). ~30 intents, all routed through
`useOrgAction` to `/org/settings`. `MiniModal` is the shared editor chrome (Save **truly
disabled** when invalid, with a "Fill the required fields (*)" hint — the opposite choice
from the Agents modal, which keeps Save clickable so the refusal guard can speak). Resources
polls every 20 s while an MCP server is `warming`.

Two changes this delta:
- The recent-audit list is now a focusable scroll region (`org-settings-page.tsx:268-276`):
  `tabIndex={0}` + `aria-label="Recent audit events"`, because `.audit-list` caps at 15rem
  and its overflowed rows were mouse-only (WCAG 2.1.1 / axe `scrollable-region-focusable`).
- The audit-export card's copy now discloses **export-before-purge** (ruling 102,
  `org-settings-page.tsx:345-348`): entries past 90 days are written to `audit-exports/` in
  the data root, one JSON object per line, before the retention sweep deletes them. The old
  sentence sent an admin to a backup schedule for "a longer record" and would now be false.

**Controller tab** (`app/features/org-settings/controller-admin-panel.tsx`, 444 lines,
rewritten this delta). See §1.7.

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

**Store browser** (`app/features/kb-browser/store-browser.tsx:894`, 1263 lines). Not a route
— a wide modal rendered by the org-settings resources tab for a KB or a skill. Toolbar
(Upload files · Upload folder · Add from GitHub · New document · New folder · an `into`
destination select), an inline document editor, and a real on-disk tree. Intents:
`store-upload` (multipart, files or whole folders via `webkitGetAsEntry` recursion),
`store-mkdir`, `store-delete`, `store-import-github`, `store-read-doc`, `store-write-doc`.
**Three stacked native dialogs** with layered Escape via `useDialog`'s `onDismissRequest`
(new-folder row → document draft → close). A truncated read **disables Save entirely**
rather than let a partial body overwrite the file. Row action buttons are always visible — a
hover-reveal `opacity: 0` still hit-tests on touch, so a tap near a row edge could delete a
file invisibly.

### 1.7 The org-settings Controller tab (rulings 106, 107, 108)

`app/features/org-settings/controller-admin-panel.tsx` was rewritten three times in this
delta and is now the largest single UI change since pass 31.

**Ruling 106 — it speaks the agent editor's language.** The bespoke `ctladm-*` dialect is
gone from both the component and the sheet (the CSS block shrank from ~20 rules to
`app/app.css:5249-5254`: only `.ctladm` and `.ctladm-foot` survive). What it renders now:

- `ModelEffortFields` + `useModelCatalog("claude", …)` (`controller-admin-panel.tsx:251-259,
  344-358`). The backend is fixed to Claude because that is what controller runs resolve, so
  there is no backend picker. A free-text model field is gone: an admin picks a real model.
- `effort` is editable for the first time and is posted on save (`:278`); `/org/settings`
  forwards it (`org.settings.tsx:439`). A model with no effort tiers submits `""`.
- Grants are pick-chip toggles in a `.ctx-groups` block (`:359-404`), KBs displayed by
  **name** and stored by **dir** with the editor's own `kbDirsOf` display-name repair on open
  (`:234-236`, P13-KM-01).
- A grant the store lost renders through the shared `MissingChips`
  (`app/features/org-settings/agent-template-modal.tsx:68-92`) — one removable red chip
  implementation for both editors, `aria-pressed={true}` by construction (F19-5).
- The missing-profile warning now uses the app-wide `.deny-note` idiom (`:307`) instead of a
  local `.ctladm-warn`.

**Ruling 107 — the pinned `viberr_ops` chip that is deliberately not a control.** The MCP
group renders a `pinned` chip (`:385-389`) as a `<span className="pick-chip on mono">` with a
`lock` glyph and a `title` naming what it is: *"Built-in diagnostics (instance health, run
logs, store documents). Part of the controller: mounted on every run and not removable."*
The comment states the reasoning explicitly (`:143-145`): a disabled `<button>` would be a
toggle that does nothing, and its `title` would never open because no pointer events reach a
disabled control. It never enters the save payload.

**Ruling 108 — deployment locks.** `ControllerSectionLocks` (`:60-65`) is a client mirror of
the server's shape; `org.settings.tsx:128` supplies it from
`controllerSectionLocks()` (`app/server/controller/controller-profile.server.ts:84-98`),
which reads four env vars. Default is **locked**; `enabled` (case/space-tolerant) unlocks.
UI consequences:

- `GrantChips` gains `locked` (`:103-204`). Under a lock it renders **only the granted**
  options (`:132-134`) as non-interactive `<span className="pick-chip on">` with a `check`
  glyph, drops `aria-pressed` on purpose (a read-only disclosure has no granted/ungranted
  distinction to announce), and renders dangling grants as non-removable
  `.pick-chip.missing.on` spans with their own explanatory title (`:183-191`). The empty
  string differs by mode: `"none granted"` under a lock vs `"none defined"` unlocked
  (`:195-200`).
- The Instructions textarea gets `readOnly={locks.instructions}` (`:423`) and a
  lock-specific `fhint` ("read-only, locked on this deployment", `:410-412`). New sheet
  rules give a read-only field a muted fill, a resting border on focus, no blue ring and no
  resize grip (`app/app.css:2264-2271`).
- A `lock` glyph sized for a small-caps label sits beside every locked section label
  (`app/app.css:2276`, `.flabel .lbl-lock, .ctx-lbl .lbl-lock`).
- One `.pol-note` above the fields (`:318-343`) lists the locked sections, states that model
  and effort stay editable, prints each `VIBERR_UNLOCK_CONTROLLER_*=enabled` variable, and
  — per the owner's narrow-scope ruling — states the boundary honestly: *"This locks the
  grant lists and the doctrine file edited on this tab; a granted skill or knowledge base can
  still be edited from Agent resources, which changes what the controller loads."*
- The save posts **blank** for every locked section (`:279-286`), which the server reads as
  "keep the stored value". That is what lets a model/effort-only save succeed under a lock,
  and it means a stale grant/doctrine copy the panel is holding can never be posted back as a
  change. Under a lock the panel also skips writing back the P13-KM-01 KB repair, so a locked
  save round-trips the stored grants byte-for-byte.

---

## 2. The shell

### 2.1 Navigation structure

`app/features/shell/nav.ts` is the single source of the rail model — order and copy are
exact (`nav.ts:21-31`):

```
Board · Review queue · Controller · Agents · Policy · GitHub · Activity · Settings
```

- `workspaceViewFromPathname()` (`nav.ts:38-44`) maps `/projects/:slug/tasks/:key` → `board`,
  so a task page keeps Board highlighted. `Rail` is a plain `<Link>` (not `NavLink`) with a
  hand-set `aria-current` because NavLink only emits `aria-current` when its own `to`
  matches, and a task URL never matches `.../board` (P13-D-37, WCAG 1.3.1).
- `boardHref(slug, location)` (`nav.ts:60-68`) carries `?filter/view/q/label` **only** when
  already on that project's board, so the rail's Board item and the project crumb do not
  silently reset a filtered board (P13-D-35 / UX-7).
- Rail badges: Board = all live tasks incl. Done (ruling 16), Review = live tasks in the
  **structural** review stage (`resolveStageRoles`, not the stage literally named "review"),
  Settings = open policy violations, rendered only when `> 0`.
- Rail width `--rail-w: 232px` (`app.css:162`); under `max-width: 720px` it becomes an
  overlay behind a topbar toggle. The scrim is a decorative `<div aria-hidden>`
  (pointer-only); the keyboard path is the toggle's `aria-expanded` plus Escape, handled in
  `app/features/shell/topbar.tsx:82-91` with focus returned to the toggle
  (`railToggleRef.current?.focus()`).

Topbar (`topbar.tsx`): rail toggle → brand → breadcrumb `<nav>` (CSS truncation tiers at
1080px and 760px) → `org-admin override` pill → `live updates paused · retry` pill → ⌘K
trigger → `TopBell` → `UserMenu`.

### 2.2 Command palette (⌘K)

- One binding: `useCommandPaletteShortcut` (`app/features/shell/use-command-palette.ts`).
  Accepts ⌘ or Ctrl, **excludes Alt** (⌥⌘K / Ctrl-Alt-K are OS/IDE combos). Mounted by
  Home, the workspace `Topbar` (`topbar.tsx:69`), and `palette-shell.tsx`.
- `CommandPalette` (`app/features/shell/command-palette.tsx`) is a native `<dialog>` via
  `useDialog`, so it stacks in the top layer above an open `PageOverlay`.
- Real APG **combobox**: the input keeps focus, `aria-activedescendant` points at the
  highlighted row, options are direct `role="option"` children of a `role="listbox"` through
  `role="group"` wrappers. Rows are `tabIndex={-1}` and `onMouseDown` is prevented so the
  input never blurs mid-click.
- `QUERY_DEBOUNCE_MS = 140` (`command-palette.tsx:34`); stale results are discarded by
  comparing `payload.q` to the query on screen. Groups: Projects · Tasks · Branches · Agents,
  `COMMAND_GROUP_LIMIT = 6` per group (`command-search.server.ts:34`),
  `TASK_SCAN_LIMIT = 60` (`command-search.server.ts:37`).
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
- `BELL_LIST_CAP = 100` (`top-bell.tsx:29`). The head count and the list can disagree, so
  the footer discloses "Showing the newest N".
- `shownUnread = unread + orphan-unread` (`top-bell.tsx:42`) — `countUnreadNotifications`
  excludes rows whose project is gone, but those rows still render with an unread dot
  (F19-25).
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
- **Revalidation IS the update mechanism** (`use-live-updates.ts:9-13`) — no client cache, no
  optimistic state. Events schedule a trailing 300 ms debounced `revalidator.revalidate()`
  so bursts coalesce. `stream.open` is a control event and never revalidates.
- Recovery, because the HTML spec says an EventSource that receives a non-200 **fails the
  connection and never retries**: `onerror` with `readyState === CLOSED` flips `paused`
  (the topbar chip), and a fresh EventSource is opened on backoff
  `SSE_REOPEN_BACKOFF_MS = [2000, 5000, 15000, 30000]` (`use-live-updates.ts:48`) counted on
  **consecutive** failures.
- OBS-6: after `SSE_SESSION_PROBE_AFTER = 2` (`use-live-updates.ts:63`) consecutive failures
  the client `fetch`es the same URL; a 401 means the session is gone, so it sets `signedOut`
  and **stops** rather than hammering `/resources/events` overnight. Anything that is not a
  401 counts as alive.
- Any reconnect that follows a previous stream pulls the loaders once — a scope change
  (navigating between tasks) tears down and reopens, and an event in that gap is lost.
- The **run log has its own consumer** (`app/features/runtime/use-run-log-stream.ts:143`)
  with its own EventSource, because revalidating the whole task loader per log line is not
  viable.

### 2.6 Route pending + toasts

- `RoutePendingBar` (`app/features/shell/route-pending-bar.tsx`) is mounted once in
  `root.tsx` above the `Outlet`. It shows only for **real navigations**
  (`navigation.location != null`, so SSE revalidation never paints it) and only after
  `ROUTE_PENDING_DELAY_MS = 220` (`route-pending-bar.tsx:30`).
- `ToastProvider` is mounted in `root.tsx`; features call `useToast()` → `push(text, kind?)`.

---

## 3. Board UX

`app/features/board/board-page.tsx` (2420 lines) + `board-dnd.ts` + `board-filters.ts`.
Unchanged this delta apart from one added test.

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
- Drop resolution is a pure function, `resolveBoardDrop` (`board-dnd.ts:23`): returns `null`
  for a no-op (before itself, before the card that already follows it, end-while-already-last),
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
- **Driving the append slot is a two-phase gesture** (`e2e/01-home-board.spec.ts:131-152`,
  new this delta). A single pointer move onto the last card's bottom half is unstable: the
  insert preview shifts the card downward under the pointer, putting the same screen point
  back in its top half. The spec now hovers the last card, waits for `.card-drop-preview`,
  then corrects to just below the card's settled rect. Anything automating a drop must do
  the same.

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
  or the filter is already on. Predicate: `matchesBoardFilter` (`board-filters.ts:47`).
- Label chips: `LABEL_CHIP_CAP = 6` (`board-page.tsx:1330`) visible before a "+N more"
  overflow; the active label is pinned first. The vocabulary mirrors the server's
  `listProjectLabels` contract exactly (archived excluded, case-insensitive dedupe, first
  spelling wins — F26-15).
- `STATE_PILL_CAP = 2` (`board-page.tsx:1333`) full-strength state pills per card before a
  "+N" fold (pass 30).
- The whole `FilterBar` is withheld on a board with nothing to filter.
- Header count is honest: "N of M tasks" when filtered, and the "waiting on a human **in this
  project**" stat names its scope (P14-WL-04 collapsed five near-duplicate "waiting"
  phrasings to one per scope).
- Empty states (`boardEmptyCopy`, `board-filters.ts:210`) name the filter or search that is
  hiding tasks; the teaching line appears only on the entry column of a wholly empty board
  (R15-10), keyed on live tasks so an archived-only board still teaches.
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
- **No chain cue.** A goal chain's presence on a task is the task-hero chip only; the board
  card carries nothing (UX spec §Goal Chains, `ux-design-specification.md:713`).

---

## 4. Task detail

`app/routes/project.task.tsx` (loader/action, 1163 lines) →
`app/features/task-detail/task-detail-page.tsx` (978 lines).

### 4.1 Layout

`.detail` is a CSS grid `minmax(0,1fr) 340px` (`app.css:1166-1172`), collapsing 1-up at
`max-width: 1100px` (`app.css:4639`, `:4655`). **`.detail-side` is FIRST in the DOM**
(`task-detail-page.tsx:628` before `:676`) and both children name their grid cell explicitly
(`app.css:1192-1193`, `grid-column` + `grid-row: 1`) rather than using `order` — the spec's
stacking rule is a *reading* order (current state, latest packet, next action, then the
timeline), and `order` created a visual-vs-focus mismatch below the breakpoint
(WCAG 1.3.2 / 2.4.3). `.detail` is the scroll container and is programmatically focused
(`tabIndex={-1}`) on mount so keyboard scrolling works, with its focus ring suppressed (G7).

The whole page is wrapped in `AttachmentLightboxProvider`
(`task-detail-page.tsx:609`, closing `:976`).

### 4.2 Side column

| Panel | File | Contents |
| --- | --- | --- |
| `GithubTrace` | `task-side-panels.tsx:38` (rendered at `task-detail-page.tsx:629`) | Branch, PR, checks, **two distinct freshness rows** — `reconciledAt` ("something moved") and `checkedAt` ("we looked", from `github.reconcile.task` audit rows). Conflating them was F19-22. **New this delta (F31-1)**: a `Collision` row (`task-side-panels.tsx:290-302`) when `task.unownedPr !== null`, reading `PR #N holds this branch name but is not this task's review PR` — the branch on GitHub is a stranger, and the reconciler no longer records the stranger's stats, so the `Diff`/`commits` rows below are this task's own cache. Controls: **Deliver** (`.btn.primary.sm.panel-act`, `:337`), **Complete merge** (`.btn.primary.sm.panel-act`, `:356`), **Force accept** (DG-2, admin-only, withheld on a terminal task). All three open the confirm; none submits on a bare click. |
| `CurrentStatePanel` | `task-side-panels.tsx:656` (rendered at `:645`) | Stage `StageMenu`, owner take/assign/release, Accept (`.btn.primary.sm.full`, `:890`), Archive/Restore (`:946-953`). Picking the LAST stage routes to the page's accept confirm (F19-37) because the server reads a human move into the final stage as an acceptance. |
| `TaskDetailsPanel` | `task-side-panels.tsx:389` (rendered at `:662`) | Priority / labels (`LabelInput`) / due date (`DatePicker`), edited inline behind `edit-task-meta`; the inline Save is `.btn.primary.sm` (`:466`). |
| `PolicyPanel` | `task-side-panels.tsx:533` (rendered at `:667`) | Permissions rows naming this project's own review and terminal stages, the owner exception (R6-2), and the operator's acceptance exception when the project runs full autonomy (A6). |

### 4.3 Main column, in order

`TaskHero` (`task-main-sections.tsx:85`, rendered `task-detail-page.tsx:677`) →
`LiveRunPanel` (`runs-panels.tsx:171`, `:687`) →
`DiagnosticsPanel` (`task-main-sections.tsx:49`, `:697`) →
`ContinuityRecoveryPanel` (`continuity-recovery.tsx:230`, `:705`; D18: above the packet) →
`DecisionPacket` (`decision-packet.tsx:613`, `:715`) →
`OperatorRecommendations` (`operator-recommendations.tsx:57`, `:750`) →
`ExecutionSection` (`task-main-sections.tsx:290`, `:761`) →
`AgentLogsPanel` (`runs-panels.tsx:420`, `:778`) →
raw-console panel (`:790`) →
`AttachmentsPanel` (`attachments-panel.tsx:25`, `:809`) →
`Timeline` (`timeline.tsx:361`, `:822`).

### 4.4 Comments (Lexical) and @-mentions

`app/features/task-detail/comment-composer.tsx` (`CommentComposer` at `:179`):

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
- Imperative handle (`CommentComposerHandle`, `:53`): `focus()`, `prefillIfEmpty(text)` (the
  "Ask operator" button prefills `"@operator "` only into a blank draft, then scrolls +
  focuses), `clearAfterSuccess()` (clears the draft **and** dispatches
  `CLEAR_HISTORY_COMMAND` so ⌘Z cannot resurrect a posted comment).
- `mentionNamesFor()` (`comment-composer.tsx:306`) + `findMentionSpans`
  (`app/ui/mention-spans.ts`) are shared by the composer highlight, the rendered-comment
  renderer and the **server's routing resolver**, so "highlighted as a mention" and "actually
  routed" cannot drift (P13-LV-11/12). Known names are tried longest-first so `@Arda Kaya`
  wins over `@Arda`. **Ruling 104 tightened this**: the server's mention fan-out now scans
  the PRE-trim text on the operator and agent-reply paths (B-FD8b).
- Timeline hint uses `useModifierHint("↵")` so a non-Mac keyboard is not shown `⌘↵`.

**Ruling 104 — length is a view concern, not a write concern.** The `operator-brevity`
guardrail used to hard-truncate operator comments at 1000 chars in the canonical record. It
is gone. The record keeps the full narration and `CollapsibleComment`
(`timeline.tsx:58-124`) is the *only* length mechanism: it measures `scrollHeight` against
`COLLAPSE_MAX + 24`, clamps with an inline `maxHeight` plus a `.clamped` class, re-measures
through a `ResizeObserver` (first measure alone is the contract in jsdom), and renders a
`Show more` / `Show less` toggle carrying `aria-expanded`. Operator narration and long agent
replies now behave identically.

### 4.5 Runs, logs, attachments

- `LiveRunPanel` (run strip: glyph, state pill, elapsed, tokens) and `AgentLogsPanel` (the
  dark console) live in `app/features/runtime/runs-panels.tsx`.
- `useRunLogStream` (`app/features/runtime/use-run-log-stream.ts:143`) seeds from the
  loader's bounded window (`runtime[].lines` + `raw` + `logWindow`), tails live via
  `run.log-appended`, revalidates the task loader once on `run.state-changed`, and pages
  **backwards** through withheld history via `loadOlder()` (P13-D-11 / NFR5). `streamError`
  is surfaced — the console used to freeze silently on a 403.
- A non-member gets `runsVisible: false`: the loader withholds `lines`/`raw`/`sid` and the
  panel renders an honest gate notice, and no stream is opened (UI-30).
- The console's capability-grant line changed with ruling 101 (`runs-helpers.ts:227-239`).
  On Codex it no longer says a flat "advisory": it reads *"capability grants deny (on this
  Codex run the repo-write and web families bind via sandbox and search toggles;
  command-level entries are advisory)"*, because those two families now bind through derived
  flags while `git push` / `gh pr` style entries stay advisory.
- `RunKind` gained a doc contract (`runtime-types.ts:24-35`, F31-C7): `kind` is a **delivery**
  axis, not a role taxonomy — `primary` = the run of the engagement that `delivers: true`;
  `reviewer` = any supporting non-delivering specialist run, including a Developer
  dispatched `delivers: false`. Any UI reading `kind` as "who" is reading the wrong field.
- `AttachmentsPanel` (`attachments-panel.tsx:25`) + `AttachmentThumb`/`AttachmentImage` + the
  shared `AttachmentLightboxProvider`. `attachmentsTotal` lets the panel disclose
  "showing 100 of N" (C8, `task-detail-page.tsx:812`). Timeline **evidence labels** that cite
  a real attachment filename become links to the serving route (R19-19); names with no
  matching file stay plain text.

**Ruling 105 + addendum — one card for every attachment kind.**
`app/features/task-detail/attachment-lightbox.tsx` (319 lines) is now a kind-aware factory:

- `IMAGE_RE` (`:38`) moved here from `attachments-panel.tsx` (which re-exports it, `:8`);
  `TEXT_VIEW_RE = /\.(txt|log|md|json|ya?ml|csv)$/i` (`:43`) mirrors the serving route's
  inert-text whitelist (`app/server/files/task-attachments.server.ts:223-239`) exactly.
- `useAttachmentLightbox()` (`:62-77`) intercepts **every plain left click**; meta/ctrl/
  shift/alt clicks and a provider-less render fall through to the real anchor, so the popup
  stays an enhancement.
- Three bodies: the image (`<img className="lightbox-img">`), the read-only text viewer
  (`LightboxTextBody`, `:117-182`), and the no-preview card (`:237-248`). The text viewer
  fetches the member-only route, streams at most `TEXT_VIEW_MAX_CHARS = 200_000` and then
  **cancels the transfer** (`readTextCapped`, `:89-109`) instead of buffering up to the
  route's 50 MB, treats a redirect as a failure (an expired session would otherwise render
  the login HTML as "file content"), distinguishes an empty file from a failed one, and
  discloses truncation.
- Every kind gets a **Download** button (`:272-281`) pointing at `${url}?download=1` with a
  `download` attribute, beside the unchanged **Open original**. Both are `.btn.ghost.sm`;
  Close is an `icon-btn` with `autoFocus` (F22-11 — the first focusable would otherwise be a
  link that navigates away).
- A body whose fetch **proved** the file unservable (404 after the ruling-105 prune, 413,
  auth redirect) drops Download, because some browsers save a failed download's error body
  under the attachment's real name. The no-preview card probes once and cancels the body
  (`:213-227`). The image branch deliberately never sets this: `<img onError>` cannot tell a
  404 from a corrupt-but-servable file, and Download is exactly the remedy for the latter.
- Copy: *"This file type has no in-app preview. Use Download to save it."* — honest, because
  the route does serve PDFs inline and Open original may still render one.
- Call sites now all pass the factory unconditionally: `attachments-panel.tsx:125-134`
  (file rows), `timeline.tsx:158-169` (evidence labels, previously image-only),
  `timeline.tsx:335-352` (non-image `tl-attach-chip`s), and `markdown.tsx` (below).

`app/ui/markdown.tsx` renamed its prop `onAttachmentImageClick` → `onAttachmentOpen`
(`:191-194`, `:340`) and gained an `a` override that opens the card
(`:267-304`). The interception is **narrow on purpose**: only a clean single-segment suffix
of the attachments base qualifies (`rest && !/[/?#]/.test(rest)`, `:284`), and the decode
goes through `safeDecodeName` (`:179-185`) so a hand-written `%zz` yields `null` rather than
throwing mid-render.

### 4.6 Actions (route intents)

`app/routes/project.task.tsx` action switch (23 cases, `:424` through `:1038`):

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

### 4.7 Ceremonies

**The one acceptance ceremony.** `app/features/task-detail/accept-confirm.tsx` — modes
`accept | force | complete-merge | apply-recommendation | packet | stage-move`
(`:51-56`). It states PR number, delivered revision head sha, the drifted merge head (R17-1),
verdict state, target branch, and any signal a force-accept would carry past. Ruling 88 /
F21-2: the confirmed click returns an `AcceptanceDisclosure` read off **the values this
render displayed**, and the server refuses an acceptance that arrives without one or with one
that no longer matches the live task. The board's drop confirm and the packet's
`accept_completion` option both route through it.

**The packet's three destructive ceremonies now share a shell** (new this delta, V-series
of the pass-31 self-review). `PacketDestructiveConfirm`
(`decision-packet.tsx:140-219`) owns the `role="alertdialog"`, the warn glyph, the close X,
the `.packet-obs.flush` body, and the `Not yet` / one-`.btn.danger` foot. Each ceremony
supplies only its subject, rows and wording:

| Ceremony | Where | `data-screen-label` | Commit label |
| --- | --- | --- | --- |
| `PacketArchiveConfirm` (UX19-9, `archive_task`) | `decision-packet.tsx:245-358` | `Packet archive dialog` | `Archive & delete {branch}` when `deleteBranch`, else `Archive {taskKey}` |
| `PacketDiscardConfirm` (F20-6/R20-2, `discard_branch`) | `decision-packet.tsx:368-421` | `Packet discard dialog` | `Discard {branch}` |
| `PacketCollisionConfirm` (F31-6, `resolve_remote_collision`) | `decision-packet.tsx:431-496` | `Packet collision dialog` | `Clear collision & redeliver` |

`CONFIRM_FIRST_KINDS` (`:607-611`) is the single set naming which option kinds interpose a
ceremony, and `pendingConfirm` is **one slot, not one per kind** (`:689-692`), so two can
never stand at once. `PacketArchiveDisclosure` (`:108-126`) made `unownedPr` **required**,
not optional (V1): the one production producer wrote the other three fields as an object
literal and silently skipped it, so the collision dialog's "and closes its pull request #N"
clause was unreachable outside tests. `task-detail-page.tsx:731-737` now supplies it.

`PACKET_TIER_GATES` (`decision-packet.tsx:536-604`, V16) is the second consolidation: five
option kinds (`accept_completion`, `edit_goal`, `archive_task`, `discard_branch`,
`resolve_remote_collision`), each with its grant predicate, its card-level `denyNote`, and
its per-option `{ title, note }`. It replaces six independent `o.kind === "…"` chains — the
drift it fixes is real: `resolve_remote_collision` shipped inert and hover-titled with **no**
description clause, so the only reason a keyboard or touch user could reach said nothing.
`accept_completion` deliberately has `option: null` (a packet addressed to someone else's
task keeps the option selectable and blocks Confirm, rather than 403ing on click).

Other confirms: `ArchiveConfirm`, `ReleaseConfirm`, plus the shared light `ConfirmDialog` for
interrupt-run and dismiss-recommendation (D6).

---

## 5. Design system

### 5.1 Token model (`app/app.css` `:root`, lines **7-164**)

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
  motion `--ease-out: cubic-bezier(.23,1,.32,1)`; layout `--rail-w: 232px` (`:162`),
  `--topbar-h: 60px` (`:163`).
- **The radius block and the spacing block are now self-documenting** (`app.css:128-145` and
  `:146-160`, both expanded this delta). The radius comment names the sanctioned micro set
  and states that a seventh radius is a deliberate widening made in the gate; the spacing
  comment states the nine steps, why they are deliberately untokenized, and that the gate
  locks the scale by **shape**, not by usage.
- The page canvas is **flat `--bg`** in both themes; the two decorative pastel radial blobs
  were removed because they reused two hues the sheet uses as *status*.

### 5.2 Scales locked by `app/app.css.test.ts` (2702 lines, 94 tests, no allowlist)

- **Type scale — 13 steps** (`app.css.test.ts:2541-2585`):
  `.62 .68 .74 .8 .86 .92 .98 1.05 1.18 1.3 1.5 1.7 1.9` rem. Every `font-size` must be a
  step (or the sanctioned `0` / `inherit`). Weights are limited to those the loaded faces
  ship, and `font-weight: 800` is legal only in rules that resolve the display face or select
  `h1-h4`.
- **Radius family — 6 steps, now three locks** (`app.css.test.ts:2588-2647`, **new this
  delta**): `--radius-small 6 · --radius-button 8 · --radius-box 12 · --radius-chip 999 ·
  --radius-card 16 · --radius-panel 22`, each declared exactly once and with exactly these
  values; every `border-radius` **corner value** must be a token, one of the sanctioned micro
  radii `2px | 3px | 4px` (proportional to a tiny box), or `50% | 0 | inherit`; and no corner
  may be a bare literal copy of a token's own value. Two `.3rem` literals in the run-console
  chips were converted to `var(--radius-small)` to satisfy it (`app.css:4736`, `:4759`).
- **Spacing scale — 9 steps, locked by shape** (`app.css.test.ts:2651-2701`, **new this
  delta**): the steps are `0 · .125 · .25 · .375 · .5 · .75 · 1 · 1.5 · 2` rem.
  *(This corrects the pass-31 doc, which listed `.125 … 3rem` and omitted `0`; `3rem` is not
  a de-facto step.)* The gate does not snap every usage — 81 of the sheet's 944 spacing
  declarations are deliberate one-offs (negative optical nudges, `.04rem` chip padding,
  fixed panel measures). Instead: any value reaching **ten** spacing sites is a de-facto step
  by then, and the set of those must be exactly the nine; and every declared step must reach
  ten sites, so a silent narrowing is a failure too (`2rem` is the thin one, 11 sites).
- **Every `var(--x)` must resolve** to a declared token — a bug, not a style choice.
- **Every class name used anywhere in `app/` must have a rule**, scanned from the tree, with
  a short justified `CLASSLESS_BY_DESIGN` list. The reverse is **not** gated generally: dead
  rules are caught only by the hand-curated `dead-and-drifted rules (P16-UI-04)` list
  (`app.css.test.ts:263-393`). See §Findings.
- **Full contrast sweep in both themes** (`:1858`): 4.5:1 text / 3:1 large text and
  meaningful glyphs, over an **empty** below-AA baseline list.
- **Breakpoints are a named map, each declared exactly once** (`app.css.test.ts:830-841`):
  `1400` board columns tighten · `1300` invite row stacks · **`1100` the two-column
  collapse** · `1080` topbar tier 1 · `1000` settings tab rail goes horizontal · `900` Home
  topbar collapses to the palette · `min-width: 900` login brand aside (the only min-width,
  `app.css:3605`) · `760` topbar tier 2 · **`720` mobile shell, rail becomes an overlay** ·
  `560` phone-width home rows.
- **No control may be hidden at any width** (`:2294`), proven against both the sheet's width
  queries and the markup, with an exact shrinking exemption list; and `app/` may read the
  viewport only to *position* things (`:2428`) — `matchMedia` is for user preferences, never
  width.
- `style={{…}}` objects whose every value is a literal are banned (held at 24 sites), and no
  style object may restate a utility class.

### 5.3 Action hierarchy — one solid primary per view

Design pass 30 (commit `19c03bd`): **`Run operator`, `Run`, `Schedule re-run`, `Comment` and
`Apply` were demoted to secondary**; only the decision-stakes commits keep `.btn.primary` —
`Confirm decision`, `Accept completion`, `Deliver` / `Complete merge`, and `Save goal` while
editing. Home's zero-project state drops its duplicate hero CTA so the `EmptyHero` carries
the page's single primary. The vocabulary is `.btn.primary` / `.btn.ghost`; the hyphenated
`btn-primary` aliases are asserted **never** to exist.

The complete `.btn.primary` census on this tree (24 sites, excluding tests): home hero ×2 +
new-project modal · store-browser Upload files · board ×3 (empty CTA, modal, New task) ·
org-settings S3 save · **controller-tab Save controller** (new this delta,
`controller-admin-panel.tsx:433`) · `MiniModal` save · project-settings ×2 ·
create-profile-modal save · **runs-panels `Retry on {backend}`** (`runs-panels.tsx:601`) ·
agents New profile · task side panels ×4 (Deliver, Complete merge, meta Save, Accept) ·
decision-packet Confirm · controller Send · task-main-sections Save goal · login ×2.

Two opacity steps for unavailable controls: `.45` disabled, `.7` busy
(`.btn[aria-busy="true"]`), both in the sheet, never inline.

### 5.4 Dialogs

`useDialog(onClose, onDismissRequest?)` → `{ ref, close }` (`app/ui/use-dialog.ts`):

- Native `<dialog>` + `showModal()`, so the browser supplies focus trap, top layer, Escape
  (`cancel`) and `::backdrop`.
- The hook adds: body scroll lock, backdrop-click close (rect-tested,
  `use-dialog.ts:96-108`), focus restore on unmount, preservation of React's imperative
  `autoFocus` (showModal would move focus off it) or a `[data-autofocus]` opt-in, and an
  **animated close** — `close()` sets `[data-closing]`, reads the transition duration, waits
  for the dialog's *own* `transitionend` (bubbled descendant transitions are ignored) with a
  timeout fallback, then unmounts.
- `onDismissRequest` returning `true` consumes an Escape/backdrop dismiss without closing
  (used by the store browser's inner new-folder row).
- Escape's native close is suppressed so React state stays the source of truth.
- Non-modal anchored popovers use `useDismiss(open, onClose, { outside })` instead — one
  implementation replacing seven near-identical hand-rolled effects that disagreed on
  `document` vs `window` and on whether an outside press closes at all.

### 5.5 Toasts

`app/ui/toast.tsx`. `useToast()` returns `push(text, kind?)` with `kind: "success" | "error"`
defaulting to `"success"`. Bottom-center stack, `TOAST_DISMISS_MS = 2600` (`toast.tsx:30`),
200 ms `.leaving` exit, `TOAST_STACK_CAP = 4` (`toast.tsx:50`) — the oldest drops
immediately, without an exit animation, because animating an exit *caused by an arrival*
would misread.

**A failure toast must not render the success tick.** Both kinds paint `var(--fg)`, so the
glyph is the entire signal. `app/features/toast-honesty.test.ts` scans every `push(...)` call
in `features`/`routes`/`ui` and fails any refusal-shaped string literal with no explicit
`"error"`. Server-computed toasts go through `useActionToast(fetcher)` (which passes
`data.ok ? "success" : "error"`) or `useFetcherResult(fetcher, handler)`; both dedupe by data
identity and fire on the **settled result**, never on submit (P11-40).

### 5.6 Copy bans (`app/features/copy-ban.test.ts`, 1031 lines — unchanged this delta)

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
   2026-08-20). Reword with a comma, period, colon or parentheses. `DASH_ALLOW` is **empty
   on purpose**. The minus sign `−` (U+2212), arrows `→` and the middle dot `·` stay legal.
   Comments are stripped before the scan, so explanations keep their dashes.
   `app/server/**` prompt machinery is out of scope.
3. **"primary specialist" is retired** (`app/features/retired-vocabulary.test.tsx`) — the
   actor is the **delivering agent**. Asserted against the *shipped* artifact (seeded file on
   disk, exported constant, rendered HTML), and at its worst inside agent prompt text.

---

## 6. UI primitives — `app/ui/`

Props conventions across the library: **presentational and route-agnostic** (the caller owns
the mutation and passes `onX` callbacks); boolean size/variant flags rather than a `size`
enum (`sm`, `lg`, `xl`); `busy` disables and sets `aria-busy`; nothing reaches for a fetcher
except the hooks. Only `markdown.tsx` changed this delta.

### Components

| Module | Export(s) | Props / contract |
| --- | --- | --- |
| `avatar.tsx` | `Avatar` | `{ person: { initials, tone } \| null, lg?, xl? }` — 26/34/56 px. `tone` maps to `.avatar.rose/.teal/.violet`. |
| `identity.tsx` | `AgentGlyph` | `{ backend?, op? }`. Branch on `op` **before** backend (operator rows carry no backend and must not render as Codex). |
| `icon.tsx` | `Icon`, `IconName`, `storeIcon` | One 24 px stroke set, every `<svg>` `aria-hidden="true"` (`icon.tsx:81`); unknown names fall back to `dot`. `svg.ico` is 16 px in the sheet. |
| `pill.tsx` | `Pill`, `ReadinessPill`, `ValidationPill`, `validationLabel` | `Pill{ kind, dot?, sm? }`. The ONE mapping from the canonical readiness enum (`ready \| input_required \| inconsistency_risk_detected \| blocked`) to CSS kinds; `accepted`, `merged`, `agent_working` are **derived display** values produced server-side by `deriveDisplayReadiness` — never re-decided in a component. |
| `task-meta.tsx` | `PriorityFlag`, `LabelChips`, `DueDatePill`, `formatDueDate`, `todayISO`, `isOverdue`, `hasVisibleMeta` | Only **non-default** metadata renders (`priority: normal`, empty labels, null due date each draw nothing). Due-date overdue is hydration-gated. |
| `stage-menu.tsx` | `StageMenu`, `StageOption` | Trigger (colour dot + optional name + caret) → popover of all stages; picking a *different* stage calls `onSelect(stageId)`. **Portaled to `<body>` and fixed-positioned from the trigger rect** so it never clips inside a scrolling column. Closes on outside click, Escape, scroll or resize. Shared by the board card and the task Current-state panel. |
| `label-input.tsx` | `LabelInput` | GitHub-style multi-select: chips + a checkbox list with chosen labels pinned on top, type-to-filter, a "Create <label>" row, comma/Enter/blur commit, Backspace-on-empty removes the last chip. Normalisation matches the server's `normalizeTaskLabels`. **Renders in flow, not portaled** (see `date-picker`). Polite live region announces changes. |
| `date-picker.tsx` | `DatePicker` | Trigger + **in-flow** calendar; emits/accepts plain `YYYY-MM-DD` or null. In-flow because it is used inside a transform-centred `<dialog>` with `overflow: hidden`, where a fixed popover mis-anchors and an absolute one is clipped. |
| `calendar.tsx` | `Calendar`, `fromISODate`, `toISODate` | Dependency-free month grid, fixed 6×7 so the popover never resizes. Works in **local-midnight dates only** — never `toISOString()`, never `new Date("YYYY-MM-DD")` (which parses as UTC and rolls the day back west of UTC). `role="grid"`, roving tabindex, per-day aria-labels. |
| `toggle.tsx` | `TglP` | `{ on, onChange(): void, label }` — fully controlled, `role="switch"`, `label` is required aria copy. |
| `confirm-dialog.tsx` | `ConfirmDialog` | `{ title, body, confirmLabel, cancelLabel?, tone: "danger"\|"primary", icon?, busy?, onCancel, onConfirm }`. `role="alertdialog"`. `confirmLabel` must **name the outcome** ("Remove stage", "Interrupt run"), never a bare verb. |
| `page-overlay.tsx` | `PageOverlay` | `{ label, onClose, children }` — full-page native `<dialog>` with a close X and `data-screen-label`. |
| `markdown.tsx` | `Markdown` | react-markdown + `remark-gfm`, no raw HTML. Overrides: `a` (`:267`), `img` → `MarkdownImg` (`:203`), `code` → `.mono`, `table` → `.md-table-wrap`. `rehypeMentions` (`:125`) re-chips known `@mentions` outside `code`/`pre`, each chip preceded by a visually-hidden `mention ` sibling (P16-UI-20). `repairAttachmentHref` (`:162`) rewrites an agent's workspace-relative attachment link to the serving route. Images become lightbox buttons **except** when wrapped in a link (a `<button>` inside an `<a>` is nested-interactive), detected through the `MarkdownInsideLink` context (`:18`). Prop is `onAttachmentOpen` (renamed from `onAttachmentImageClick` this delta). |
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

**Shared components that live outside `app/ui/` but behave like primitives** (both widened
this delta): `ModelEffortFields` + `useModelCatalog`
(`app/features/agents/create-profile-modal.tsx:510`, `:128`) and `MissingChips` + `kbDirsOf`
+ `kbLegacyOf` (`app/features/org-settings/agent-template-modal.tsx:68`, `:33`, `:48`). The
controller settings panel imports all five. Anything new that edits an agent-shaped config
should reach for these rather than re-implement a picker.

---

## 7. Gotchas for UI implementers

### 7.1 Hydration (React #418)

The container SSRs in UTC; the viewer hydrates in their own zone. Rendering viewer-local text
on both sides produces a **recoverable #418 that regenerates the whole page on the client** —
it looks fine and costs a full re-render. The established patterns:

- **Timezone-dependent text**: render the UTC/deterministic form while `useHydrated()` is
  false, swap in the local form after (`LocalDayDotTime`, `finishedClock` in
  `runs-panels.tsx:13`, `insights-page.tsx:250-401`, `notifications-page.tsx:151`,
  `activity-page.tsx:657`). The new refusal row in the quota panel follows it too — the
  `title` is withheld until hydrated (`insights-page.tsx:315-318`) and a `prose` reset
  renders the ISO date rather than a local instant (`:334-341`).
- **Relative text ("2m ago")** has no deterministic form — both sides render `" "` and an
  effect fills it in (`LocalRelative`). One blank hydration frame is the price.
- **Day grouping** is worse than clock text: the server and client disagree on the header
  *and* on which rows share a group. `app/features/activity/feed-helpers.ts:60-72`
  (`groupStreamByDayUTC`) does an absolute-UTC first-pass grouping and `activity-page.tsx:676`
  regroups after hydration.
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
- **Driving an append-drop needs two moves.** See §3.1 — the insert preview moves the target
  under the pointer.
- **`aria-current` needs a hand.** `NavLink` will not emit it for the Board item on a task
  URL. Use the derived `activeView`.
- **`className={bareVariable}`** trips the `app.css.test.ts` class-coverage gate — the
  scanner reads literals. Dynamically composed names must be composed as
  `"prefix-" + value` with a literal prefix (`"pev-ico act-" + r.type`,
  `"log-file lf-" + f.kind`), and every value of that union needs a rule.
- **The `button { background: none }` reset is load-bearing**, not tidiness: without it a
  class-less button keeps the UA `ButtonFace`, which Chrome resolves per color-scheme
  (`#6b6b6b` in dark) and drops `--muted` to 3.2:1.
- **There is no global `p { margin: 0 }` reset.** A class written for a `<div>` carries no
  margin override, so putting it on a `<p>` silently adds the UA `margin-block: 1em`. See
  §Findings F32-U4.
- **`<select>` keeps native `appearance`** on purpose so the drop-down arrow and popup follow
  `color-scheme`; overriding it would mean shipping a hard-coded arrow colour.
- **`Icon` is `aria-hidden`**, always (`icon.tsx:81`). A glyph that carries meaning needs a
  text or `aria-label` sibling; the ruling-108 lock glyphs rely on the `.pol-note` sentence
  and the textarea's real `readonly` state, not on the icons.
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
- **A disabled button's `title` never opens** (no pointer events reach it). That is why both
  the ruling-107 pinned chip and every ruling-108 locked chip are `<span>`s carrying a
  `title`, not disabled `<button>`s (`controller-admin-panel.tsx:143-145`).
- **Do not trust the spec citations in code comments.** See §8.1 — the `§N.M` numbers point
  at a deleted document set, and the three `ux-design-specification.md:NNN` citations are
  stale by an offset that is **no longer a single number**.

---

## 8. Intended UX vs what shipped

Source: `planning/planning-artifacts/ux-design-specification.md` — now **1176 lines**
(985 at pass 31; PR #254 added 191 lines of controller retrofit), authored 2026-03-30,
amended nine times.

### 8.1 Two citation traps (the spec now documents both itself)

1. **The `§4.6` / `§5.11` numbering in code comments (`app/routes.ts:15`,
   `org-settings-page.tsx:20`, `board-page.tsx:962`, `rich-text.tsx:6`, `mini-modal.tsx:9`)
   does not resolve against `ux-design-specification.md`.** It belongs to a **deleted** spec
   set, `docs/build/specs/*.md`, removed in commit **`c1acf2c`** ("Remove obsolete code and
   simplify project structure", 2026-07-22). Read them with
   `git show c1acf2c^:docs/build/specs/<name>.md`. Every one of those specs shares a skeleton:
   §1 purpose · §2 component tree · §3 data consumed · §4 UI states & interactions · §5
   events/mutations · §6 CSS classes · §7 porting notes · §8 open questions — **except
   `home.md`, where §4 is verbatim markup and §5 is UI states**, which is why the overlays are
   shell §4.6 but home §5.11. `CONVENTIONS.md` in that tree holds the 16 binding orchestrator
   rulings. `app/routes.ts:13-22` now says this in the code itself.
2. **The `+37` offset is dead.** The spec carries its own correction table at
   `ux-design-specification.md:37-43`, located by TEXT and re-verified after this pass's last
   amendment (the arithmetic version was two lines out):

   | Code comment | Cites | Real target today |
   | --- | --- | --- |
   | `app/features/shell/nav.ts:48` | `:824-825` | **1052-1053** (§Navigation Patterns → context preservation) |
   | `app/features/board/board-filters.ts:205` | `:846-847` | **1074-1075** (§Additional Patterns → empty states) |
   | `app/features/shell/route-pending-bar.tsx:9` | `:849-850` | **1077-1078** (§Additional Patterns → loading) |

   The **named** citations (`§Accessibility Strategy`, `§Breakpoint Strategy`,
   `§State Semantics`) are unaffected and still resolve. Prefer a section name in anything new.

### 8.2 The rules the spec actually sets

- **`§Button Hierarchy` (957-984): "at most one primary action per decision surface";**
  informational surfaces may have none; destructive actions never share visual weight with
  safe progression; button labels describe the outcome, not generic UI verbs. This is the
  source the pass-30 action-hierarchy commit (§5.3) implements.
- **`§State Semantics` (933-956):** every state means the same thing everywhere; state is
  carried by **text + icon + semantic emphasis together**; input gaps, inconsistency risk,
  blocked conditions and continuity degradation must not collapse into one generic "error".
  Canonical vocabulary: `ready`, `input_required`, `inconsistency_risk_detected`, `blocked`,
  plus *waiting on human* / *waiting on agent* and the diagnostic *degraded continuity*;
  `review-ready` and `done` are workflow labels, **not** canonical readiness values. An
  amendment adds the goal-chain family (`active | paused | attention | completed | cancelled`
  for a chain, `pending | active | done | failed | skipped` for a link) as a *second* family
  under the same rules.
- **`§Feedback Patterns` (985-1011):** prefer inline state over detached notifications;
  **"toasts must never be the sole record of a consequential event"**; error feedback must say
  what failed, what remains true, and what to do next. **Empty states (1074-1075):** explain
  what is absent, why it matters, and what to do next. **Loading (1077-1078):** preserve
  layout stability, **skeletons over large spinners** when the page shape is known (shipped
  reality: one `RoutePendingBar`, no skeletons — still an open gap).
- **"One surface, reflowed" (1092, amended 2026-07-25):** the three-capability-mode responsive
  model is *retired*. **Every action, including destructive and policy actions, renders at
  every width; nothing is gated on viewport size.** *"A user on a narrow window is a
  supervisor with less room, not a different kind of user with fewer rights."* R19-12 turned
  this and the both-theme AA contrast baseline into **failing test gates** — hiding a control
  below a breakpoint is *"a correctness failure wearing accessibility clothing."*
- **Accessibility (1115-1132):** WCAG 2.2 AA for core workflows, in both themes;
  *"inaccessible state is untrustworthy state."* Screen-reader testing named as VoiceOver +
  NVDA. **Ruling 103 (2026-08-31) settled the browser matrix as Chromium-only** and struck
  Safari/Firefox from the PRD rather than leaving them as unexercised intent, so the
  pass-31 "open item" is now a closed decision: re-adding an engine requires a Playwright
  project that actually runs it.
- Named product directions: the board is the **Signal Console** ("what needs me now?", 482-494),
  task detail is the **Operator Desk**, with the reading order current state → execution truth
  → latest packet → next action → timeline, which is also the narrow-width stacking order.
- Two former open questions were **ruled built, not deferred**: board lane keyboard traversal
  (D19) and the Continuity Recovery Panel (D18, *"sits on the product's trust story rather
  than its feature list"*). Run controls were ruled to **show** configuration, never pick it
  (R21-9/R22): no per-run backend or autonomy dropdowns.

### 8.3 New this delta: the controller is specified, not just shipped

`§Controller and Goal Chain Surfaces` (**633-731**) plus two component specs,
`### Controller Conversation` (**848-858**) and `### Goal Chain Panel` (**859-871**), added
to the Workflow Component Layer list at **882-890**. The amendment at 506 retracts nothing: Signal
Console and Operator Desk still define the board and the task page; the controller is the
third surface, for work that has no task yet.

Spot-verified against the tree — every one of these is true today:

| Spec claim | Where it is true |
| --- | --- |
| header sub-line *"Managing the `<slug>` board / this instance with your own permissions"* | `controller-page.tsx:101-102` |
| composer footer *"Acts with your permissions · refusals say why · ⌘↵ sends"*, one primary Send | `controller-page.tsx:305`, `:309` |
| empty transcript names the reach, not a greeting | `controller-page.tsx:211-213` |
| Goals empty state is an instruction, not a create button | `controller-page.tsx:358` |
| org-admin *Show everyone's* / *Show mine only* toggle | `controller-page.tsx:165-167` |
| one live signal `"<name> is working…"`, no cost/token/elapsed | `controller-page.tsx:246` |
| rail item third of eight | `app/features/shell/nav.ts:25` |
| config panel opens by stating the talk-vs-configure distinction | `controller-admin-panel.tsx:301-305` |
| MCP grants *"widen no authority"*, no capability matrix | `controller-admin-panel.tsx:362-365` |
| missing profile degrades, does not down the surface | `controller-admin-panel.tsx:306-317` |
| a lost grant still renders, marked | `controller-admin-panel.tsx:180-194` |
| *"Changes apply from the next controller turn."* one primary | `controller-admin-panel.tsx:427-440` |
| Insights coordination measure names *"operator and controller"* | `insights-page.tsx:216-225` |

### 8.4 Where the spec's own superseding notes have gone stale

| Spec note says | Shipped today |
| --- | --- |
| "the ported design system defines **no spacing tokens** … a retrofit would touch every surface for no user-visible gain" | A **9-step spacing scale** (`0 … 2rem`), documented at `app.css:146-160` and shape-locked at `app.css.test.ts:2651` |
| "Radius vocabulary is **exactly four**" | **Six** steps, plus a three-part lock (`app.css.test.ts:2588`) |
| "**No elevation scale.** Elevation is three named shadow tokens" | **Five** — `--shadow-ring/card/menu/pop/lift`, chosen by z-position |
| No numeric type scale given anywhere | A **13-step type scale**, locked at `app.css.test.ts:2541` |
| §The Configuration Surface: the tab "edits the model, three grant lists … and the instructions" | Ruling 108 (one day later) **locks all four of those by default**; a default deployment edits **model and effort only**. The spec section has not been amended for it. |

Two things the spec never covers at all and that exist only as later rulings: **the ⌘K
command palette** (R15-5) and **the Home multi-project landing page** (the spec is
project-scoped). The spec's own authority note is `planning/README.md`'s canon rule: **where
the app and the documents disagree, the app is right and the document is the one being
corrected.**

---

## Findings for the pass-32 ledger

Nothing below is fixed. Each item is what / where / why / confidence.

**F32-U1 — `repairAttachmentHref` can throw mid-render on a malformed percent escape.**
`app/ui/markdown.tsx:170` calls `decodeURIComponent(segments[segments.length - 1] ?? "")`
unguarded, while the sibling call site added this delta uses `safeDecodeName`
(`markdown.tsx:179-185`, `:284`) precisely because "a percent-escape an author wrote by hand
can be malformed and `decodeURIComponent` THROWS on it — mid-render". `MarkdownImg` has the
same raw call twice (`:227`, `:248`). Verified reachable: micromark's `normalizeUri` leaves
`%zz` intact (`normalizeUri("attachments/%zz.png") === "attachments/%zz.png"`), and
`decodeURIComponent("%zz.png")` throws `URIError: URI malformed`. So an agent- or
human-written comment on a task page containing `[x](attachments/%zz.png)` throws inside the
`a` override before `safeDecodeName` is ever consulted, taking the whole task page to the
error boundary. Only fires where `attachmentNames` and `attachmentsBase` are supplied (the
task page). Why it matters: the guard that was just added is defeated by an unguarded call
one function above it, and the blast radius is the deepest surface in the product.
**Confidence: high** (mechanically verified).

**F32-U2 — Six of the eight workspace views have no document title of their own.**
`…/board`, `…/agents`, `…/policy`, `…/github`, `…/settings` and `…/controller` export no
`meta`, so all six inherit `{project.name} · Viberr` from `app/routes/project.tsx:64-68`,
while `…/review` (`project.review.tsx:18-20`) and `…/activity`
(`project.activity.tsx:34-36`) do specify one. Why it matters: browser tabs, history entries
and bookmarks cannot distinguish a project's board from its settings from its GitHub page;
two of eight views got the treatment and six did not, which reads as an unfinished sweep
rather than a decision. **Confidence: high.**

**F32-U3 — Two document titles break the app's own `X · Viberr` convention.**
`/org/settings` is titled exactly `"Instance settings"` (`app/routes/org.settings.tsx:105`)
with no product suffix, and the task page is `"{key} · {title}"`
(`app/routes/project.task.tsx:1070-1072`) with none either — while `/controller`,
`/insights`, `/notifications`, `/profile`, `…/review`, `…/activity` and the project layout
all end in `· Viberr`. `/login` inverts the order (`"Viberr · Sign in"`,
`login.tsx:31`). Why it matters: three different title grammars across eleven titled routes;
in a tab strip the product name is the disambiguator. **Confidence: high.**

**F32-U4 — `.pol-note` on a `<p>` picks up UA margins the class never absorbs.**
`app/features/org-settings/controller-admin-panel.tsx:319` is the **only**
`<p className="pol-note">` in the app; the other ten call sites are `<div>`s
(`org-settings-page.tsx:494`, `:563`; `users-panel.tsx:614`; `sso-panel.tsx:209`;
`connections-panel.tsx:235`; `settings-page.tsx:144`, `:821`, `:958`, `:1067`, `:1265`).
The rule (`app/app.css:2444-2448`) sets `margin-bottom: 1rem` but no `margin-top`, and there
is no global `p { margin: 0 }` reset in the sheet, so the ruling-108 lock note alone carries
an extra UA `margin-top: 1em` (≈12.8px at its `.8rem` font). Inside `.ctladm`
(`display: flex; flex-direction: column; gap: .9rem`) margins do not collapse, so the note
sits visibly further from the fields than every other `.pol-note` in the product.
`.deny-note` gets this right (`app.css:675`, `margin: 0`). **Confidence: high** (structural;
not visually confirmed in a browser).

**F32-U5 — Five dead rules in `app/app.css`.** No emitter anywhere in `app/`:
`.own-role` (`app.css:3354`), `.sched-form` (`:1758`), `.sched-controls` + `.sched-controls
.flabel` (`:1759-1760`), `.sched-note` + `.sched-note::placeholder` (`:1766-1767`),
`.sched-note-inline` (`:1763`). The only occurrences in the repo are inside stale
`.claude/worktrees/*` copies. The schedule UI moved into
`app/features/task-detail/execution-profile.tsx` and uses `.sched-list/.sched-row/.sched-when/
.sched-meta/.sched-cancel` (all live); the form-shaped rules are leftovers from the deleted
per-run steer form, which R21-9/R22 removed. `.op-sel` and `.fm-toolbar select` survive only
inside explanatory comments (`app.css:212`, `:1602`) and have no rules, which is correct.
Why it matters: the class-coverage gate (`app.css.test.ts:642`) only checks
markup → rule, never rule → markup, so dead rules accumulate silently, and the sheet's
credibility ("a stylesheet you cannot trust is one you stop reading",
`app.css.test.ts:264-266`) is the thing being spent. **Confidence: high** (scan verified by
hand against the dynamic-composition cases, which are `pev-ico act-*` and `log-file lf-*`
and ARE live).

**F32-U6 — "Retry on {backend}" is the only run-start action drawn as a primary.**
`app/features/runtime/runs-panels.tsx:601` renders `.btn.primary.sm`, while every sibling
run-start on the same page is secondary: `Run operator` / `Schedule`
(`execution-profile.tsx:389`, `.btn.sm`) and the agent `Run` (`execution-profile.tsx:581`,
`.btn.sm`) were deliberately demoted in pass 30. Both panels are co-visible on the task page
(`ExecutionSection` at `task-detail-page.tsx:761`, `AgentLogsPanel` at `:778`). It may be
defensible as a recovery CTA that only appears after a backend-unavailable error, but the
demotion commit's stated rule was that starting a run is not a decision-stakes commit.
**Confidence: medium** (real inconsistency; the intent may have been deliberate and is not
recorded either way).

**F32-U7 — Two solid primaries are permanently co-visible on `/org/settings`.**
`AuditExportCard`'s S3 save (`org-settings-page.tsx:427`) is rendered unconditionally below
the tab content (`:205-207`), so on `?tab=controller` it stands beside `Save controller`
(`controller-admin-panel.tsx:433`), and on every other tab beside that tab's own modal-less
panel. §Button Hierarchy is worded per *decision surface*, and a card and a tab panel are
arguably two, so this is a soft call — but the S3 form is always expanded (no disclosure),
which makes the second primary always present rather than opt-in.
**Confidence: low-medium.**

**F32-U8 — The controller tab's opening sentence still promises more than a default
deployment allows.** `controller-admin-panel.tsx:301-305` reads *"This tab configures the
controller itself, which only org admins can do."* Under ruling 108's default (all four
sections locked) an org admin can change **model and effort only**. The `.pol-note` directly
below (`:318-343`) does disclose the locks, so the surface is not dishonest overall, but the
lead paragraph and the note say different things and the lead is read first.
**Confidence: low-medium** (copy nuance, no functional defect).

**F32-U9 — A locked grant section announces nothing to assistive tech.** Under ruling 108
`GrantChips` renders granted resources as `<span className="pick-chip on">` with a decorative
`aria-hidden` `check` icon and no `aria-pressed`, `aria-disabled`, `role` or readonly state
(`controller-admin-panel.tsx:154-163`, `:183-191`), and the label's lock glyph is also
`aria-hidden` (`icon.tsx:81`, applied at `:139`). The code comment argues the case (a
read-only disclosure has no granted/ungranted distinction to lose) and the `.pol-note` names
the locked sections in text, so the information is on the page — but nothing associates the
note with the specific group, and a screen-reader user tabbing the panel goes from an
editable Model select straight past three non-focusable lists to a `readonly` textarea (the
textarea being the only element that announces its own state). Contrast the sibling case:
`MissingChips` was given a hardcoded `aria-pressed` (F19-5) for exactly this reason.
**Confidence: medium** (deliberate and reasoned; the asymmetry with F19-5 is what makes it
worth a ledger line).

**F32-U10 — `ux-design-specification.md` §The Configuration Surface is one day stale.**
Lines 721-731 describe the controller tab as editing "the model, three grant lists (skills,
knowledge bases, MCP servers), and the instructions", and its three "smaller rules" say
nothing about locks — but ruling 108 (`docs/architecture/decisions.md:1606-1638`, merged the
same day, PR #262) makes all four of those read-only by default. The section also predates
ruling 106's effort control. The spec was retrofitted in PR #254 and the locks landed in
#262, so this is ordering drift, not carelessness — but it is the newest section in the
document and it already misdescribes the surface.
**Confidence: high.**

**F32-U11 — The one-way `markdown.tsx` interception rule is not shared with the other three
call sites.** `markdown.tsx:279-284` deliberately intercepts only a clean single-segment
suffix of the attachments base, rejecting a query, fragment, nested path, or malformed
escape. The other three lightbox call sites — `attachments-panel.tsx:125-134`,
`timeline.tsx:158-169`, `timeline.tsx:335-352` — build the URL themselves with
`encodeURIComponent(name)` from a server-supplied filename, so they are safe *by
construction* rather than by a shared check, and `attachment-lightbox.tsx:264-271` documents
the invariant as a comment ("every call site passes a query-less serving-route URL (the
markdown gate rejects anything else), so plain concatenation is safe") rather than asserting
it. A fifth call site that passes a URL carrying a query would silently produce
`…?x=1?download=1`. Why it matters: this is the "one rule, N enforcement sites" shape that
`PACKET_TIER_GATES` and `MissingChips` were just consolidated to avoid, left un-consolidated
one file over. **Confidence: medium** (latent, no current defect).

**F32-U12 — Insights "Coordination overhead" has no scope caveat, unlike its neighbours.**
`insights-page.tsx:216-225` renders a share over *cost-reporting runs only* — and the page
already knows that only Claude runs report a cost, which is why the "Total cost" card carries
an explicit `"{n} of {m} runs reported no cost"` sub-line (`:84-88`). The coordination card's
sub-line names the two dollar figures but never says the denominator excludes every
non-reporting run, so on a mixed Claude/Codex instance the percentage silently describes a
subset. The panel-level honesty rule the page follows everywhere else ("name the scope in the
copy") is not applied here. **Confidence: medium.**
