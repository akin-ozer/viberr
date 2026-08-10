# UI-INVENTORY — Viberr current state (pass 19)

> Verified against main @65063b8 on 2026-08-06 (pass 19).

Every route, the shell, the design-token discipline, and the pass-18/19 UI fixes.
Anchors re-verified against `main @65063b8`. Route table: `app/routes.ts` (52 lines,
React Router 7 `RouteConfig`) — **unchanged**: no route was added, removed or
renamed in the 12 app-touching commits since `6656d6f`.

---

## 1. Routes → features

| `routes.ts` | URL | Module | Renders |
| --- | --- | --- | --- |
| :4 | `/` (index) | `routes/_index.tsx` | Home — project list, greeting, StoreStrip, bell |
| :5 | `/login` | `routes/login.tsx` | Login (local-first; OAuth provider buttons) |
| :6 | `/logout` | `routes/logout.tsx` | Logout action |
| :9 | `/org/settings` | `routes/org.settings.tsx` | Tabbed org settings (profile, members, resources) |
| :13 | `/api/auth/*` | `routes/api.auth.$.ts` | better-auth handler (no UI) |
| :16 | `/profile` | `routes/profile.tsx` | Profile overlay (identity, prefs, GitHub identity) |
| :17 | `/notifications` | `routes/notifications.tsx` | Full notifications page |
| :19 | `/notifications/read` | `routes/notifications.read.tsx` | Mark-read fetcher (no UI) |
| :20 | `/prefs/theme` | `routes/prefs.theme.tsx` | Theme cookie action (no UI) |
| :22 | `/resources/events` | `routes/resources.events.ts` | SSE stream (no UI) |
| :25 | `/resources/run-log` | `routes/resources.run-log.ts` | Run-log tail (no UI) |
| :27 | `/resources/health` | `routes/resources.health.ts` | Ops health probe (+ F18-5 lock holder) |
| :30 | `/resources/search` | `routes/resources.search.ts` | ⌘K palette query (no UI) |
| :33 | `/resources/model-catalog` | `routes/resources.model-catalog.ts` | Model/effort catalog (no UI) |
| :36 | `/resources/session-export` | `routes/resources.session-export.ts` | Session export download (no UI) |
| :39 | `/projects` | `routes/projects.tsx` | Alias → Home (N5, not a 404) |
| :41 | `/projects/:slug` | `routes/project.tsx` | **Layout route**: workspace shell (rail + topbar) |

Nested children of `/projects/:slug` (rendered in `project.tsx`'s `<Outlet>`):

| :42 | index | `project._index.tsx` | Default project view |
| :43 | `board` | `project.board.tsx` | Board (dnd-kit) |
| :44 | `review` | `project.review.tsx` | Review queue |
| :45 | `agents` | `project.agents.tsx` | Agents (profiles, grants) |
| :46 | `policy` | `project.policy.tsx` | Policy (RBAC table, workflow) |
| :47 | `github` | `project.github.tsx` | GitHub (connection, PRs) |
| :48 | `activity` | `project.activity.tsx` | Activity feed |
| :49 | `settings` | `project.settings.tsx` | Project settings (members, resources) |
| :50 | `tasks/:key` | `project.task.tsx` | Task detail |

Only the root index and the `project.tsx` layout use nesting. **`project.tsx` has
no `ErrorBoundary` export** — a 404 under it bubbles to the root boundary (relevant
to F18-1, §4).

---

## 2. The shell (`app/features/shell/`, `app/features/notifications/`)

- **`rail.tsx`** — `Rail`, the left `<nav aria-label="Primary">`. Project switcher
  → `/` (:33-43), `WORKSPACE_NAV` items (`nav.ts`) as `Link`s with `aria-current`
  from `activeView` (:46-81), live count badges on `board` (`boardCount`), `review`
  (`reviewCount`), and `settings` (`violations`, only when >0).
- **`topbar.tsx`** — `Topbar`: rail-toggle (mobile, :93-104), brand→Home,
  breadcrumb `<nav aria-label="Breadcrumb">` (:116-144), the **org-admin override
  pill** (:145-159, the D2 surface — UXA-13 moved the full sentence out of the
  `title` and into `aria-label` at :155, so keyboard/AT/touch reach it), the
  **livePaused "live updates paused — retry" pill** (:163-174), the search button
  opening `CommandPalette` (:177-191), `<TopBell>` (:192), `<UserMenu>` (:193).
- **`top-bell.tsx`** — `TopBell`: bell button + non-modal `<dialog>` popover
  (:119-170), `BELL_LIST_CAP=100`, mark-all-read, `.bell-badge` pulse keyed on
  `unread`. Shared by the workspace topbar AND Home.
- **`notifications/notification-item.tsx`** — the shared `.ntf-item` row for both
  the bell popover and `/notifications`.
- Also: `command-palette.tsx`, `user-menu.tsx`, `route-pending-bar.tsx`.

---

## 3. Design-token discipline

- **ONE stylesheet** `app/app.css` (**3966** lines — +13 since pass 18). Integrity
  gate `app/app.css.test.ts` (1006 lines). **No Tailwind** (no `tailwind` dep, no
  config files); icons are
  inline SVG paths (`app/ui/icon.tsx`), styling is hand-authored CSS with
  custom-property tokens.
- **Unprefixed tokens**: `--bg`, `--fg`, `--blue`, `--muted`, `--surface`,
  `--faint`, `--placeholder`, `--coral-*`, `--hairline`, `--border`, `--font-mono`,
  `--font-body`, `--cta-bg` (regression anchors at `app.css.test.ts:126-137`). No
  `--viberr-*` layer, no Tailwind utility layer — both long gone.
- **`app.css.test.ts` asserts**:
  - Token resolution (:110) — every `var(--x)` resolves to a declared token
    (`undefinedTokens === []`).
  - **WCAG AA contrast gate** (:426, `AA_SMALL_TEXT=4.5`) — `--faint`/`--placeholder`
    clear 4.5:1 on `--surface` in BOTH themes, the muted>faint>placeholder ladder
    never inverts, CTA + hover clear 4.5:1, `--cta-bg` clears 3:1 non-text (WCAG
    1.4.11), focus ring clears 3:1 on every surface.
  - Focus ring (:177) — one app-wide `:where(...):focus-visible` outline.
  - **No-allowlist whole-tree scan** (:602) — it scans the whole `app/` tree (not
    a hand-written list, :633), asserts every class used in markup has a rule
    (:642), and holds inline styling to a bounded, shrinking budget of 20 sites
    (:960-984).

---

## 4. Pass-18 UI fixes (current line numbers)

**F18-13 — terminal task withdraws force-accept** (`7abb286`) ·
`app/features/task-detail/task-side-panels.tsx`. Component `GithubTrace` (:21-248).
`isTerminal` from `task.displayReadiness === "accepted" | "merged"` (:59-60);
`forceAcceptReason` is nulled when terminal (:61-66); the `forceAcceptRow` (the
"Acceptance is blocked…" hint + "Force accept (override review gate)" button) only
renders for a non-terminal task with `onForceAccept` (:67-86). Rationale (:54-58):
force-accept bypasses the verdict gate so `blockReason` persists into Done — a Done
task must not keep offering to force-accept an already-accepted task.

**F18-12 — mobile profile-grid stacks** (`4147036`) · `app/app.css`. Base rule
`.profile-grid { grid-template-columns: minmax(0,1fr) minmax(0,1fr) … }` (:1126);
inside the mobile `@media` breakpoint, `.profile-grid { grid-template-columns:
1fr; }` (**:2912**, comment above it) so the execution-profile governance controls
(DELIVERING AGENT "Run", HUMAN OWNER "Manage"/"Assign me") no longer render off the
right edge at 375 px. Live-verified single column, controls reachable.

**F18-3 — OAuth affordances key off configured providers** (`20c2785`), an R17-4
generalization:
- Profile GitHub-identity card · `app/features/profile/profile-page.tsx`
  (`ProfileGithub` :516, heading :577). `showConnectAffordance = gh ||
  data.githubConfigured` (**:535**, branch at :599) — a no-OAuth deployment
  renders a quiet explanatory note instead of a Connect button that could only
  fail; `githubConfigured` prop at :46.
- Allow-access modal · `app/features/org-settings/users-panel.tsx` `InviteModal`
  (:59). `defaultIdp` leads with the first configured OAuth provider else
  `local` (:73-78); GitHub/Google method buttons are `disabled={!providers.*}` with
  "isn't configured" titles + "· off" labels. So the modal no longer
  DEFAULTS to a method the deployment can't honor.

**F18-4 — KB "folder missing" honesty** (`7b8696c`) ·
`app/features/org-settings/resource-rows.tsx`. When `kb.folderExists` is false the
row renders "folder missing — no docs reach a granted agent; re-create it or
delete this knowledge base" (:86-90) instead of the healthy "0 docs · re-scanned…"
chip. Backed server-side by `resources.server.ts` (`folderExists` flag).

**F18-1 — orphaned notifications drop out** (`5e67127`):
- Server · `app/server/projections/notifications.server.ts`. `targetMissing`
  computed from the LEFT JOIN yielding a null project name for a deleted project
  (:223, field declared :128); `href` nulled for orphans (:231).
  `countUnreadNotifications` (:238) counts only org-wide rows or rows whose
  project still exists (`AND (n.project_slug IS NULL OR p.slug IS NOT NULL)`,
  :251), so a wiped project stops inflating the badge.
- Renderer · `app/features/notifications/notification-item.tsx` — adds `orphaned`
  class (:48), `aria-disabled` but focusable, "project no longer exists" copy;
  consumers guard navigation on `!n.targetMissing` (`top-bell.tsx`,
  `notifications-page.tsx`).
- Shell/theme retention · `app/root.tsx` `ErrorBoundary` (:178, `.app-splash` at
  :200) renders a shell-less panel but `Layout` keeps `data-theme` (:126) + the
  theme boot script, so the error page holds the viewer's theme.

**F18-5b — Home lock-holder strip** (`23c9ce6`):
- Loader · `app/routes/_index.tsx` — `lockHolder` computed admin-only from
  `heldDataRootLock()?.holder` → `{pid, hostname, startedAt}` (:66-74).
- Render · `app/features/home/home-sections.tsx` `StoreStrip` — accepts `lockHolder`
  (:539, type :548), admin-gated (`if (!isAdmin) return null`, :552), renders
  "Writer: pid {pid} on {hostname}." (:566-577). Live-verified.

**F18-6 — ghost-admin members** (`643ca81`) — the removal path is in
`app/features/project-settings/settings-actions.server.ts:690-706` (see
RBAC-GOVERNANCE.md §1.4). The org-level sibling guard is `countActiveAdmins`
(`user-store.server.ts:63-65`, `disabled = 0`), enforced in
`user-admin.server.ts:135-142`. The members panel
(`org-settings/users-panel.tsx`) now renders server refusals INLINE as a
`.cred-warn` (**:504**; a second one at :313) — R15-11, refusals are rendered copy
in place, not only a backgrounded toast.

---

## 4b. Pass-19 UI changes (10 commits after `6656d6f`)

Two live-verify findings, one owner ruling, one PRD-gap finding, and a 16-item
accessibility/copy audit (UXA-*). All anchors below are current.

**B1 — a board acceptance now asks first** (`7ee2864`) ·
`app/features/board/board-page.tsx`. A human dragging a card into the FINAL
stage is not a move: `reorderTask` routes it through `acceptCompletion`, which
attempts a REAL PR merge. Task detail has always confirmed this; the board drag
AND the keyboard Move menu committed it straight from the gesture. New
`AcceptOnBoardConfirm` component (:543-586, "Merging is one-way" at :566), the
pending-acceptance state (:1090), the render site (:1419). Both paths now route
through it.

**UXA-2 — one PR-state colour map** (`7ee2864`) ·
`app/features/review/review-page.tsx:63-67` now calls `prStatePill(t.pr.state)`
(imported :4 from `~/features/github/github-pills`) instead of a private map that
rendered a closed-unmerged (rejected) PR neutral grey.

**UXA-1 — honest comment scope** (`7ee2864`) ·
`app/features/task-detail/timeline.tsx:370` — "Every project member can comment ·
@mentions route to agents" (was "Open to every registered user", already removed
from the Permissions panel on the same page under E1).

**UXO-1 — an archived task drops its live-state pills** (`d69af18`) ·
`app/features/task-detail/task-main-sections.tsx:160-174`. `TaskHero` renders the
readiness/agent-working pill and the `ValidationPill` only when `!archived`; the
stage pill stays. An archived task no longer reads "archived · Review · ready ·
awaiting verdict".

**LV-F1 — a pending reset no longer hides the re-issue action** (`6e93238`) ·
`app/features/org-settings/users-panel.tsx:450-500`. The Password field was a
ternary that rendered the "Reset pending" banner INSTEAD of the button whenever
`pwreset || status === "invited" || tempPassword` — and a freshly created account
always has `pwreset: true`, so the one branch that hid the button was exactly the
new-account case (owner-reported lockout). The banner is now CONTEXT above the
action (:460-470); the button always renders for a local account, relabelled
"Generate a new temp password" while a reset is pending (:487-488).

**LV-F2 / UXA-3 — project Settings explains its read-only state** (`2301612`,
`3eba761`) · `app/features/project-settings/settings-page.tsx`. Lock notes on
Project (:91), Stages (:758) and Members (:868) panels — plus RepoPanel (:1121),
which UXA-3 caught as the missed fourth. The Stages "drag to reorder / click a
name to rename" how-to now renders only for a reader who can act.

**Q-V1 — the Danger zone is hidden from members who cannot manage lifecycle**
(`0efe0d7`, owner ruling) · `settings-page.tsx:1596-1603`. `{canEditPolicy && (
<DangerZone …/> )}` where `canEditPolicy = roleCan(myRole, "edit-policy")`
(:1437). It used to render for every member with disabled buttons and a deny
note. **The PAT half is NOT implemented** — the viewer's HTML still carries the
connection tail, which renders from a component other than `settings-page` (which
only holds `credential.source` booleans). Recorded with an exact next step.

**UXA-4 — pick-chips and the capability control carry ARIA state** (`3eba761`).
The Direct/Recommend/Human/Off `cap-seg` is now a real
`role="radiogroup"`/`role="radio"`/`aria-checked` control
(`create-profile-modal.tsx:584-590`), matching its long-standing twin on the
Policy sheet. 12 `pick-chip` toggles gained `aria-pressed`:
`create-profile-modal.tsx:243`, `:304`, `:430`; `board-page.tsx:708`;
`new-project-modal.tsx:133`, `:284`, `:293`, `:302`;
`agent-template-modal.tsx:214`, `:228`, `:295`, `:317`, `:341`, `:365`.

**UXA-7 — roving radiogroups** (`2098289`). New shared helper
`app/ui/roving-radio.ts` `rovingRadioKeyDown(event)` — DOM-based arrow-key
traversal for any `role="radiogroup"` (skips disabled options, wraps, starts from
the checked one, `preventDefault`s only keys it owns). Adopted by
`policy-page.tsx:158` (member roles) and `:474` (workflow boundaries), which
declared the role and never wired the keys. `decision-packet.tsx` keeps its
ref-array implementation (it also MOVES selection).

**UXA-5 — SSR-safe notification day buckets** (`6ba5c77`) ·
`app/features/notifications/notifications-page.tsx:133-136`. `/notifications` is
SSR-rendered but formatted viewer-LOCAL day buckets on the first pass AND used
that value as the grouping KEY. Now `useHydrated()` (from `~/ui/local-time`)
selects `formatDayBucketUTC`/`formatClockUTC` for the first pass — the same
pattern activity, task detail and the run console already used.

**UXA-6 — one name for the delivering agent** (`6ba5c77`) ·
`app/features/task-detail/operator-recommendations.tsx` `KIND_LABEL
.assign_specialist` is now `"Delivering agent"` (was "Primary specialist" one
viewport from the execution profile, its assign menu and the deliver button).

**UXA-15 — Agents page explains its read-only state** (`6ba5c77`) ·
`agents-page.tsx:1230-1240` — a `.pol-note` naming the **Manage agents** grant.
Previously New profile / Add from library / Edit / Delete simply vanished.

**UXA-8 — wide tables scroll instead of crushing** (`2098289`) ·
`app/app.css:3955-3965` (inside the 1100 px block): `.gh-table, .live-wrap {
overflow-x: auto; }` plus `min-width` floors (34rem / 42rem) on their head/row
grids. A columnar table cannot collapse or wrap without losing row alignment.

**UXA-9 — a disabled Save says what is missing** (`2098289`) ·
`app/features/org-settings/mini-modal.tsx:22`/`:35`/`:62-71`. New optional
`unmetHint` prop; the default line is "Fill the required fields (*) to continue."
Applies across all 7 `MiniModal` callers.

**UXA-10 — profile copy** (`bbcd58a`) · `profile-page.tsx:196` renders "No
projects yet" instead of a bare em dash (which reads as UNKNOWN), and `:212` uses
`formatCalendarDate` for **Joined** instead of the timeline formatter (which said
"Today" for a new account and a year-less "Mar 30" forever after).

**UXA-11** (`bbcd58a`) · `org-settings/connections-panel.tsx:120-127` — the
update path's disabled owner field now says the owner is immutable.

**UXA-12 — the login value panel is exposed to AT** (`bbcd58a`) ·
`app/routes/login.tsx:431-432`. `.login-aside` was `aria-hidden="true"` wholesale;
now only the decorative `V` mark is hidden and the heading + three product claims
(which appear nowhere else) are readable.

**UXA-13 — the org-admin override pill is audible** (`2098289`) ·
`topbar.tsx:155` (§2).

**UXA-14** (`bbcd58a`) · `task-main-sections.tsx:208-215` — "A goal needs at least
3 characters." renders only while the Save-goal floor is unmet.

**UXA-16 — the Policy last-change stamp is viewer-local** (`2098289`) ·
`app/features/policy/policy-query.server.ts` `latestPolicyChange` now returns
`{by, at}` (raw ISO) instead of a server-formatted `{by, t}`; the client renders
it with `<LocalDayDotTime iso={data.edited.at} />` (`policy-page.tsx:585-590`). In
a UTC container the header used to show the SERVER's calendar day, year-less.

---

## 5. UI rough edges (still present)

- **Run-log stream disconnect is reload-only** ·
  `app/features/runtime/use-run-log-stream.ts:459-466`. The task-log `EventSource`
  never auto-reconnects; on `CLOSED` it sets "Live tail disconnected — reload the
  page to resume following." (:462, surfaced via `AgentLogsPanel`). Contrast the
  topbar's `livePaused` pill which offers a retry — the log tail's only recovery
  is a full reload.
- **`Icon` uses `dangerouslySetInnerHTML`** · `app/ui/icon.tsx:73` injects a static
  path string from the in-module `ICON_PATHS` map. Values are hardcoded literals
  (safe today), but it is an innerHTML sink pattern worth noting.
- **Board drag has no aria-live announcements** · `app/features/board/board-page.tsx`
  — drag is deliberately pointer-only (:122; Escape cancels a lift), with keyboard
  users routed to the StageMenu instead. The only `role="status"` on the page is
  the orphan-bucket region (:1362); nothing announces drag pickup/drop. The
  accessible path is the menu, not announced DnD.
- **F18-1b (low, left for a future pass)** — during the closed-PR reopen-detection
  window the stale recovery-packet card renders beside a GitHub card already showing
  "in review" for ~50 s until the operator withdraws it; the reconciler could stamp
  the packet `superseded` instantly.
- **Q-V1 PAT half (open, exact next step recorded)** — a project **Viewer**'s
  Settings HTML still carries the GitHub connection tail. `settings-page.tsx`
  holds only `credential.source` booleans, so the tail is rendered by another
  component; find and gate that one (§4b).

**CLOSED since pass 18** — *F18-9* ("the new-agent-profile modal pre-selects ALL
org skills ON") was dispositioned **not reproducible** in `220103b`: both profile
modals initialise with EMPTY grants (`create-profile-modal.tsx:817-829`,
`agent-template-modal.tsx`). Acting on the original note would have introduced
the over-granting it feared. Do not re-open it from the pass-18 doc.

No `TODO`/`FIXME`/`HACK` markers exist in task-detail, home, or shell.

---

## 6. Delta summary (pass 18 + pass 19)

**Pass 18** (six fixes, §4). Live-verified: F18-13 (Done shows no force-accept),
F18-12 (375 px single column), F18-3 (profile quiet one-liner; modal defaults
Local), F18-4 (moved folder → "folder missing"), F18-1 (project-orphan excluded;
task-404 keeps theme), F18-5b (Home strip "Writer: pid…"). F18-6 verified via
file-recovery repro.

**Pass 19** (§4b), by commit:

| Commit | Items | Files |
| --- | --- | --- |
| `6e93238` | LV-F1 | `org-settings/users-panel.tsx` |
| `2301612` | LV-F2 | `project-settings/settings-page.tsx` |
| `d69af18` | UXO-1 | `task-detail/task-main-sections.tsx` |
| `7ee2864` | B1, UXA-1, UXA-2 | `board/board-page.tsx`, `review/review-page.tsx`, `task-detail/timeline.tsx` |
| `3eba761` | UXA-3, UXA-4 | `agents/create-profile-modal.tsx`, `board/board-page.tsx`, `home/new-project-modal.tsx`, `org-settings/agent-template-modal.tsx`, `project-settings/settings-page.tsx` |
| `6ba5c77` | UXA-5, UXA-6, UXA-15 | `notifications/notifications-page.tsx`, `task-detail/operator-recommendations.tsx`, `agents/agents-page.tsx` |
| `bbcd58a` | UXA-10, UXA-11, UXA-12, UXA-14 | `profile/profile-page.tsx`, `org-settings/connections-panel.tsx`, `routes/login.tsx`, `task-detail/task-main-sections.tsx` |
| `2098289` | UXA-7, UXA-8, UXA-9, UXA-13, UXA-16 | `ui/roving-radio.ts` (NEW), `policy/policy-page.tsx`, `policy/policy-query.server.ts`, `shell/topbar.tsx`, `org-settings/mini-modal.tsx`, `app.css` |
| `0efe0d7` | Q-V1 (owner ruling) | `project-settings/settings-page.tsx` |

Routes: **unchanged**. The design-token discipline (one stylesheet, unprefixed
tokens, no Tailwind, `app.css.test.ts` no-allowlist gate at :602, contrast gate at
:426, focus ring at :177, token resolution at :110) is unchanged and re-verified;
`app.css` grew from 3953 to 3966 lines (UXA-8 only).
