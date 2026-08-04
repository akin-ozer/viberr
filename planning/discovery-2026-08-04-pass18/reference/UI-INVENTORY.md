# UI-INVENTORY — Viberr current state (pass 18)

Every route, the shell, the design-token discipline, and the pass-18 UI fixes.
Anchors current to `pass18/product-fixes`. Route table: `app/routes.ts` (52 lines,
React Router 7 `RouteConfig`).

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
  pill** (:145-152, the D2 surface), the **livePaused "live updates paused —
  retry" pill** (:156-167), the search button opening `CommandPalette` (:170-184),
  `<TopBell>` (:185), `<UserMenu>` (:186).
- **`top-bell.tsx`** — `TopBell`: bell button + non-modal `<dialog>` popover
  (:119-170), `BELL_LIST_CAP=100`, mark-all-read, `.bell-badge` pulse keyed on
  `unread`. Shared by the workspace topbar AND Home.
- **`notifications/notification-item.tsx`** — the shared `.ntf-item` row for both
  the bell popover and `/notifications`.
- Also: `command-palette.tsx`, `user-menu.tsx`, `route-pending-bar.tsx`.

---

## 3. Design-token discipline

- **ONE stylesheet** `app/app.css` (3953 lines). Integrity gate `app/app.css.test.ts`
  (1006 lines). **No Tailwind** (no `tailwind` dep, no config files); icons are
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
1fr; }` (:2910, comment :2907-2909) so the execution-profile governance controls
(DELIVERING AGENT "Run", HUMAN OWNER "Manage"/"Assign me") no longer render off the
right edge at 375 px. Live-verified single column, controls reachable.

**F18-3 — OAuth affordances key off configured providers** (`20c2785`), an R17-4
generalization:
- Profile GitHub-identity card · `app/features/profile/profile-page.tsx` (card
  :504-670). `showConnectAffordance = gh || data.githubConfigured` (:525) — a
  no-OAuth deployment renders a quiet explanatory note instead of a Connect button
  that could only fail; `githubConfigured` prop at :45-46.
- Allow-access modal · `app/features/org-settings/users-panel.tsx` `InviteModal`
  (:59-498). `defaultIdp` leads with the first configured OAuth provider else
  `local` (:73-78); GitHub/Google method buttons are `disabled={!providers.*}` with
  "isn't configured" titles + "· off" labels (:174-207). So the modal no longer
  DEFAULTS to a method the deployment can't honor.

**F18-4 — KB "folder missing" honesty** (`7b8696c`) ·
`app/features/org-settings/resource-rows.tsx`. When `kb.folderExists` is false the
row renders "folder missing — no docs reach a granted agent; re-create it or
delete this knowledge base" (:81-90) instead of the healthy "0 docs · re-scanned…"
chip. Backed server-side by `resources.server.ts` (`folderExists` flag).

**F18-1 — orphaned notifications drop out** (`5e67127`):
- Server · `app/server/projections/notifications.server.ts`. `targetMissing`
  computed from the LEFT JOIN yielding a null project name for a deleted project
  (:223); `href` nulled for orphans (:231). `countUnreadNotifications` counts only
  org-wide rows or rows whose project still exists (`AND (n.project_slug IS NULL OR
  p.slug IS NOT NULL)`, :242-254), so a wiped project stops inflating the badge.
- Renderer · `app/features/notifications/notification-item.tsx` — adds `orphaned`
  class (:48), `aria-disabled` but focusable, "project no longer exists" copy;
  consumers guard navigation on `!n.targetMissing` (`top-bell.tsx:102`,
  `notifications.tsx:108`).
- Shell/theme retention · `app/root.tsx` `ErrorBoundary` (:178-220) renders a
  shell-less `.app-splash` panel but `Layout` keeps `data-theme` + the theme boot
  script (:124-136), so the error page holds the viewer's theme.

**F18-5b — Home lock-holder strip** (`23c9ce6`):
- Loader · `app/routes/_index.tsx` — `lockHolder` computed admin-only from
  `heldDataRootLock()?.holder` → `{pid, hostname, startedAt}` (:63-74).
- Render · `app/features/home/home-sections.tsx` `StoreStrip` — accepts `lockHolder`
  (:539), admin-gated (:552), renders "Writer: pid {pid} on {hostname}." in a
  `.sub` span (:566-576). Live-verified.

**F18-6 — ghost-admin members** (`643ca81`) — the removal path is in
`app/features/project-settings/settings-actions.server.ts:689-706` (see
RBAC-GOVERNANCE.md §1.4). The org-level sibling guard is `countActiveAdmins`
(`user-store.server.ts:63-65`, `disabled = 0`), enforced in
`user-admin.server.ts:135-142`. The members panel
(`org-settings/users-panel.tsx`) now renders server refusals INLINE as a
`.cred-warn` (:490-494) — R15-11, refusals are rendered copy in place, not only a
backgrounded toast.

---

## 5. UI rough edges (still present)

- **Run-log stream disconnect is reload-only** ·
  `app/features/runtime/use-run-log-stream.ts:453-466`. The task-log `EventSource`
  never auto-reconnects; on `CLOSED` it sets "Live tail disconnected — reload the
  page to resume following." (surfaced via `AgentLogsPanel`). Contrast the topbar's
  `livePaused` pill which offers a retry — the log tail's only recovery is a full
  reload.
- **`Icon` uses `dangerouslySetInnerHTML`** · `app/ui/icon.tsx:73` injects a static
  path string from the in-module `ICON_PATHS` map. Values are hardcoded literals
  (safe today), but it is an innerHTML sink pattern worth noting.
- **Board drag has no aria-live announcements** · `app/features/board/board-page.tsx`
  — drag is deliberately pointer-only (:122; Escape cancels a lift), with keyboard
  users routed to the StageMenu instead. There is no `role="status"`/`aria-live`
  region announcing drag pickup/drop; the accessible path is the menu, not
  announced DnD.
- **F18-9 (unresolved, deliberately not changed)** — the new-agent-profile modal
  pre-selects ALL org skills ON at create time (contradicts deliberate-grant
  governance). Left as an observation pending an owner ruling; noted here as a
  live rough edge, not a bug.
- **F18-1b (low, left for a future pass)** — during the closed-PR reopen-detection
  window the stale recovery-packet card renders beside a GitHub card already showing
  "in review" for ~50 s until the operator withdraws it; the reconciler could stamp
  the packet `superseded` instantly.

No `TODO`/`FIXME`/`HACK` markers exist in task-detail, home, or shell.

---

## 6. Pass-18 delta summary

All six UI fixes above landed on `pass18/product-fixes`. Live-verified: F18-13
(Done shows no force-accept), F18-12 (375 px single column), F18-3 (profile quiet
one-liner; modal defaults Local), F18-4 (moved folder → "folder missing"), F18-1
(project-orphan excluded; task-404 keeps theme), F18-5b (Home strip "Writer: pid…").
F18-6 verified via file-recovery repro. The design-token discipline (one
stylesheet, unprefixed tokens, no Tailwind, `app.css.test.ts` no-allowlist gate) is
unchanged and re-verified.
