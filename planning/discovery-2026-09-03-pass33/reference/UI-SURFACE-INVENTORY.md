# UI surface inventory

This is a complete, factual inventory of Viberr's rendered UI surfaces: every route module declared in
`app/routes.ts`, the feature components each route renders, the distinct UI states those components can
render (empty, loading, error, degraded, permission-denied, withheld control, disabled control), the form
intents each action accepts together with the guard that action applies, and every dialog/modal reachable
from the surface. It was generated on 2026-09-03 as reference material for pass 33 and records only what
is observable in the source: file paths, `data-screen-label` values, JSX conditionals, and action-side
guards. No recommendations, no speculation about intent.

Counts: 53 files under `app/routes/` — 19 co-located tests, one shared server helper
(`project-visibility.server.ts`) and 33 route modules, of which 18 render UI, 13 are resource/action
targets with no UI, and 2 are pure redirects. Under `app/features/` there are 110 non-test modules across
19 feature directories, and `app/ui/` holds 27 non-test shared primitives.

## Conventions used below

- **Route path** is the URL from `app/routes.ts`; **module** is the file under `app/routes/`.
- **Screen label** is the value of the `data-screen-label` attribute the surface stamps (the handle
  co-located tests and browser drivers select by).
- **Guard** names the server-side check the action applies before the intent's effect, as written in the
  route module or the `*.server.ts` it delegates to.
- "Withheld control" means the JSX does not render the control at all for that viewer/state; "disabled
  control" means it renders with `disabled`/`aria-disabled`.

---

## 0. App shell (mounted on every route)

### `app/root.tsx` — document root

| Component | File |
| --- | --- |
| `Layout` / `App` | `app/root.tsx` |
| `RoutePendingBar` | `app/features/shell/route-pending-bar.tsx` |
| `ToastProvider` | `app/ui/toast.tsx` |
| `ControllerDock` | `app/features/controller/controller-dock.tsx` |
| `ErrorBoundary` | `app/root.tsx` |

States:

- **Theme resolution** — `<html data-theme>` is SSR'd as `light` unless the stored preference is `dark`;
  the inline `themeBootScript` re-resolves pre-paint from the `viberr_theme` cookie and follows
  `prefers-color-scheme` live when the preference is `system`.
- **Motion** — `<html data-motion="reduce">` when `getPref(db, user.id, "motion") === "reduce"`, else
  `"full"`; signed-out documents are always `"full"`.
- **Signed-out** — `rootData.csrf` is null, so `ControllerDock` is not mounted at all.
- **Route pending** — `RoutePendingBar` renders nothing until a real navigation
  (`navigation.state !== "idle" && navigation.location != null`) has been pending for
  `ROUTE_PENDING_DELAY_MS` (220 ms); then an indeterminate `role="progressbar"` bar. SSE revalidations
  are excluded by the `navigation.location` check.
- **ErrorBoundary — 404** — title "Page not found", detail from the thrown string or
  "The page you are looking for does not exist."
- **ErrorBoundary — other route error** — title `Error <status>`; detail is the thrown copy parsed by
  `thrownMessage` (accepts a bare string or `{ error: { message } }`, the shape `requireRole` throws),
  falling back to `statusText`.
- **ErrorBoundary — dev-only stack** — `<pre className="mono">` with `error.stack`, only when
  `import.meta.env.DEV` and the error is an `Error`.
- Every boundary state renders the "error" pill and a `Back to home` link.

Forms/intents: none (the root has no action).

### `app/routes/palette-shell.tsx` — pathless layout

Wraps `/org/settings`, `/controller`, `/org/settings/audit-export`, `/insights`, `/profile`,
`/notifications`. Mounts `useCommandPaletteShortcut` and renders `CommandPalette` on ⌘K/Ctrl-K only.
It has no loader, no action, and no visual chrome of its own.

### `ControllerDock` — `app/features/controller/controller-dock.tsx`

Screen label: `Controller dock`. Data route: `/resources/controller` (GET view, POST send).

| Component | File |
| --- | --- |
| `ControllerDock` / `DockShell` / `DockLive` | `app/features/controller/controller-dock.tsx` |
| scope resolution | `app/features/controller/controller-dock-context.ts` |
| server view | `app/features/controller/controller-dock-query.server.ts` |

States:

- **Hidden** — `dockContextFromMatches(...).hidden`; the dock returns `null` (login and the full
  controller pages).
- **Closed (FAB only)** — `dock-fab` button with `aria-expanded={false}`, `aria-label="Controller · <scope
  label>"`; scope label comes from the route alone (`localScopeLabel`) before the first load.
- **Working while closed** — `live-dot` on the FAB plus a visually-hidden `role="status"` region saying
  `<controllerName> is working`.
- **Open, view not yet loaded** — transcript body renders `Loading…`; context line renders
  "Reading where you are…"; composer placeholder `Loading…` and `disabled`.
- **Open, scope unavailable** (`current.unavailable`) — body replaced by "The controller has nothing to
  work with here: this project or task is not open to you, or it no longer exists."; composer disabled.
- **Backend unavailable** (`!current.available`) — composer disabled with placeholder "The Claude backend
  is unavailable, so the controller cannot answer."
- **Read-only thread** (`current.conversation !== null && !current.viewerOwnsActive`) — composer disabled
  with placeholder "Read-only: only the thread's owner can talk in it."
- **Empty conversation** — `emptyCopy(view)`, three variants keyed on `view.scope.kind`
  (`task` / `board` / instance).
- **Threads panel open** — `dock-threads`; empty variant "No threads here yet.", otherwise a list with
  `aria-current` on the active thread.
- **Turn working** — `ctl-working` `role="status"` row: `<controllerName> is working…`; a 5 s poll
  (`WORKING_POLL_MS`) re-loads the view.
- **Sending** — Send button label flips to `Sending…`, `disabled={busy || disabled || !text.trim()}`.
- **Send failed** — toast (error kind) from `result.error` or "The controller could not take that. Try
  again."; refusals appear in the transcript instead.
- **Stale selection** (`current.staleSelection`) — the stored conversation id is dropped for that scope.
- **Closing** — `data-closing` attribute drives the exit transition; Escape closes instantly and only
  while focus is inside the panel.

Intents (POSTed to `/resources/controller`): `send` (fields `_csrf`, `intent`, `text`, `surface`,
`project`, `task`, `conversationId` where `"new"` starts a thread).

Dialogs: the dock itself is `role="dialog" aria-modal="false"` — non-modal, no scrim, no focus trap.

### Shell chrome (workspace + home)

| Component | File | Notes |
| --- | --- | --- |
| `Rail` | `app/features/shell/rail.tsx` | nav model in `app/features/shell/nav.ts` |
| `Topbar` | `app/features/shell/topbar.tsx` | |
| `TopBell` | `app/features/shell/top-bell.tsx` | screen label `Notifications popover` |
| `UserMenu` | `app/features/shell/user-menu.tsx` | |
| `CommandPalette` | `app/features/shell/command-palette.tsx` | screen label `Command palette` |
| `SkipLink` | `app/ui/skip-link.tsx` | |

`Rail` states:

- Board/Review counts always rendered; the **violations count is withheld** unless `violations > 0`.
- Active item is computed by `workspaceViewFromPathname`; `tasks/*` maps to `board`, so the Board item
  carries `aria-current="page"` on a task page.
- Board link preserves `?filter/view/q` only when already on that project's board (`boardHref`).

`Topbar` states:

- **Rail toggle withheld** unless an `onToggleRail` handler is passed (mobile breakpoint); carries
  `aria-expanded={railOpen}`; Escape closes the rail and restores focus to the toggle.
- **Crumbs — task open** — project → `Board` → `KEY · title` with `aria-current="page"`.
- **Crumbs — no task** — project → current view label.
- **Org-admin override pill** — rendered only when `orgAdminOverride`; the full sentence is the element's
  `aria-label`.
- **Live updates paused** — `livePaused` renders a `role="status"` pill "live updates paused · retry"
  which calls `onReconnect`.

`TopBell` states:

- **Badge withheld** when `unread === 0`; otherwise a keyed `bell-badge` so the pulse re-fires.
- **Popover head** — `<n> unread` or `caught up`; **Mark all read is withheld** when `shownUnread === 0`.
  `shownUnread` adds back unread rows whose target project is missing (`n.targetMissing`), which
  `countUnreadNotifications` excludes.
- **Empty list** — "Nothing yet. You're caught up."
- **Truncation notice** — rendered when `notifications.length >= BELL_LIST_CAP` (100): "Showing the newest
  N".
- **Mark-all result** — success/error toast from a dedicated `readAllFetcher`.

Intents: `read` and `read-all`, both POSTed to `/notifications/read` with `_csrf`.

`UserMenu` states:

- **Switch project item withheld** unless `showSwitchProject` (workspace only).
- **Instance settings item withheld** unless `user.role === "admin"`.
- **Theme item** cycles light → dark → system and deliberately does not close the menu; toast fires on the
  server result, error toast on failure.
- ARIA `menu`/`menuitem` roles are deliberately absent (plain tab order).

Intents: `POST /prefs/theme` (`_csrf`, `theme`), `POST /logout` (`_csrf`).

`CommandPalette` states:

- **Untyped** — "Type to jump to a task, a branch, an agent or a project, across every project you can
  open."
- **Searching** — `role="status"` "Searching…" while `fetcher.state !== "idle"`.
- **No matches** — `role="status"` `Nothing matches “<query>”.`
- **Results** — `role="listbox"` with `role="group"` runs per hit kind (project/task/branch/agent); the
  combobox keeps focus and points via `aria-activedescendant`.
- Hits whose payload does not answer the current query are discarded (stale-flash guard).
---

## 1. `/` — Home (project selection)

Module: `app/routes/_index.tsx`. Screen label: `Home · project selection`.

| Component | File |
| --- | --- |
| `HomePage` | `app/features/home/home-page.tsx` |
| `HomeTopBar`, `HomeHero`, `EmptyHero`, `ProjectSections`, `SettingsPanel`, `StoreStrip`, `RebuildConfirm` | `app/features/home/home-sections.tsx` |
| `ProjectCard`, `ProjectRow`, `ProjectMeter`, `MemberStack` | `app/features/home/project-cards.tsx` |
| `NewProjectModal` | `app/features/home/new-project-modal.tsx` |
| `TopBell`, `UserMenu`, `CommandPalette` | `app/features/shell/*` |
| `SkipLink` | `app/ui/skip-link.tsx` |
| loader queries | `app/features/home/home-query.server.ts` |
| create | `app/features/home/project-create.server.ts`, `app/features/home/project-name.ts` |

Live scopes: `sseScopes.user()` + `sseScopes.allProjects()` (`app/features/live-updates/use-live-updates.ts`).

States:

- **No projects at all** — `EmptyHero` (screen label `Empty state`): "Create your first project" plus a
  three-step `empty-steps` block, replacing the whole project grid.
- **Hero summary, four variants** — `projectCount === 0`; `totalRunning === 0 && totalWaiting > 0`;
  `totalRunning === 0 && totalWaiting === 0`; `totalRunning > 0`.
- **View toggle withheld** when `projectCount === 0`; otherwise a `role="group"` segmented control with
  `aria-pressed` on grid/list.
- **Pinned section withheld** when nothing is pinned (`pinned.length === 0`); screen label
  `Pinned projects`.
- **All projects section** — heading flips to "Everything else" when a pinned section exists; screen label
  `All projects`.
- **Search empty — nothing at all matches** — `No project matches “<query>”.`
- **Search empty — only pinned match** — second empty variant (rest is empty but pinned is not).
- **New-project tile withheld** when a query is active (`!query` guards the trailing create tile in both
  grid and list).
- **Archived section withheld** when `archivedList.length === 0`; screen label `Archived projects`.
- **Per-card empty state** — `pj-meter is-empty` with `aria-label`/`title` "No tasks yet. Ready for its
  first" plus the `pj-empty-hint` "No tasks yet · ready for its first".
- **Per-card activity** — `running > 0` shows the working dot and `<n> agents running`; `running === 0 &&
  total > 0` shows the idle variant; `waiting > 0` shows "<n> waiting on you"; `overrideWaiting > 0` adds
  a titled span explaining the decision needs an org-admin override.
- **No task activity** — `no task activity yet` replaces the relative timestamp.
- **Settings tiles — permission-denied form** — `OrgTile` renders a non-link
  `div.org-tile[aria-disabled="true"]` with the foot "Org admins manage this" when `!isAdmin`; four tiles
  (`connections`, `users`, `resources`, `/insights`). Screen label `Settings`.
- **Store strip withheld entirely** when `!isAdmin` (`StoreStrip` returns `null`). Screen label
  `Store strip`.
- **Writer lock line** — rendered only when `lockHolder` is present (admin-only loader field): "Writer: pid
  N on HOST."
- **Re-scan busy** — icon spins, label flips to `Scanning…`.
- **Rebuild busy** — icon spins, label flips to `Rebuilding…`.
- **Re-scan / rebuild failure** — error toast ("Re-scan failed. Check the server log" /
  "Rebuild failed. Check the server log"), including the 403 body for a non-admin.
- **Throttled** — 429 with `throttledMessage(...)` copy surfaced through the same error toast.
- **Live updates paused** — `HomeTopBar` renders a `role="status"` retry pill.

Intents on `action` (all through `requireFormAction`, which enforces auth + CSRF + trusted origin):

| Intent | Guard |
| --- | --- |
| `pin` | signed-in only; writes `home prefs.stars` |
| `view` | signed-in only; writes `home prefs.view` |
| `rescan` | `ctx.user.role !== "admin"` → 403 "Re-scanning the store requires the org admin role."; then `runSingleFlight("projections:rescan", …, { minIntervalMs: RESCAN_MIN_INTERVAL_MS })` → 429 when throttled |
| `rebuild-projections` | `ctx.user.role !== "admin"` → 403 "Rebuilding projections requires the org admin role."; then `runSingleFlight("projections:rebuild", …, { minIntervalMs: REBUILD_MIN_INTERVAL_MS })` → 429 when throttled |
| `create-project` | deliberately **no** org-admin gate — any signed-in member; creator seeded as project admin by `createProject` |
| anything else | 400 "Unknown action." |

Loader-side withholding: `storeRoot` and `lockHolder` are `null` unless `user.role === "admin"`.

Dialogs:

- `RebuildConfirm` — `app/features/home/home-sections.tsx` (native `<dialog>` via `useDialog`,
  `aria-labelledby="rebuild-confirm-title"`).
- `NewProjectModal` — screen label `New project modal`.

`NewProjectModal` states:

- **No GitHub connections — admin** — links to `/org/settings?tab=connections`.
- **No GitHub connections — member** — same copy without the link ("Ask an admin to add…"), avoiding a
  click into a 403.
- **Picked connection not valid** — warning naming either "token failed validation" or "hasn't been
  validated yet".
- **Repo field disabled** while no connection is picked (`disabled={!effOwner}`), hint
  "requires a GitHub connection".
- **Repo hint variants** — "from the project name (type to replace)" when derived, else "every task in this
  project uses it"; plus a fixed-owner note when a connection is picked.
- **Key collision** — `keyInUse` when the resolved key matches `existingKeys` case-insensitively (allowed,
  flagged, not blocked).
- **Create disabled with reason** — `blockedReason` names the first unmet requirement: name ≥ 2 chars →
  task key ≥ 2 letters → pick a connection → repository name; rendered in a `role="status"` foot hint.
- **Submitting** — `busy` disables Create.
- **Server refusal** — `role="alert"` `form-err` block with `fetcher.data.error`.
- **Created with repo warning** — success toast plus a second error-kind toast carrying `repoWarning`; then
  navigates to `/projects/<slug>/board`.
- **Workflow field** — a single non-interactive `pick-chip on[aria-disabled="true"]` ("Standard · 5
  stages"); the Lightweight preset was removed.

---

## 2. `/login` — sign-in and forced password reset

Module: `app/routes/login.tsx`. Two screen labels: `Login` and `Login · set new password`.

| Component | File |
| --- | --- |
| `Login`, `SetNewPassword`, `ProviderButtons` | `app/routes/login.tsx` |
| `CsrfInput` | `app/ui/csrf-input.tsx` |
| server | `app/server/auth/login.server.ts`, `app/server/auth/oauth-providers.server.ts` |

States:

- **Signed in, no reset pending** — the loader throws `redirect(returnTo ?? "/")`; the page never renders.
- **`mode === "reset"`** — `SetNewPassword` replaces the whole page.
- **SSO configured** (`providers.github || providers.google`) — provider buttons lead, then the divider
  "or a local account", then the local form.
- **SSO not configured at all** — local form leads; SSO shrinks to a single `login-tag providers` note.
  Provider buttons are not rendered.
- **One provider missing** — `login-tag providers` naming which of GitHub/Google is unconfigured.
- **Provider button disabled** — `disabled={!providers.x}` with a `title` and the label
  "GitHub (not configured)" / "Google (not configured)".
- **Provider busy** — spinning refresh icon, label "Checking whitelist…", `aria-busy`.
- **Provider start failed** — `cred-warn` `role="status"` "… sign-in couldn't start. Please try again."
- **Local submit busy** — button label "Signing in…", `aria-busy`.
- **Error** — `login-err` `role="alert"`; distinct server copy for `wrong_password`, `rate_limited`,
  `disabled`, and a shared message for `unknown_email`/`no_password` (deliberately non-enumerating).
- **Client-side error** — "Enter your email." (login) / "New password needs at least N characters." /
  "Passwords don't match." (reset), pre-empting submit.
- **Dismissed server error** — typing hides the current `actionError`; a *new* error re-shows itself
  (`dismissedServerErr` comparison, no effect).
- **Forgot password** — sets an info `cred-warn` `role="status"`; rendered after the form in the
  local-first layout so the button does not move.
- **Aside panel** — desktop-only brand/value column; the mark is `aria-hidden`, the prose is not.

Intents:

| Intent | Guard |
| --- | --- |
| `login` | `assertTrustedOrigin`; short-circuits to redirect if already authenticated without a pending reset; empty email → 400; `loginWithCredentials` failure reasons mapped to copy |
| `set-password` | `assertTrustedOrigin`; `requireAuth(..., { allowPendingPasswordReset: true })`; `assertCsrf(request, auth.sessionId, formData)`; redirects away if `!auth.pwresetRequired`; length + match checks |
| anything else | 400 "Unknown action." |

Dialogs: none.

---

## 3. `/logout` — `app/routes/logout.tsx`

Action-only route (no UI). Consumed by the `UserMenu` sign-out form.

## 4. `/api/auth/*` — `app/routes/api.auth.$.ts`

better-auth splat handler. No UI.
---

## 5. `/org/settings` — Instance settings (org admin)

Module: `app/routes/org.settings.tsx` (inside `palette-shell`). Screen label: `Instance settings`.
Loader guard: `requireRole(request, "admin")`. Action guard: `requireRoleAuth(request, "admin")` followed
by `assertCsrf(request, ctx.sessionId, formData)` — every intent below inherits both.

Tab lives in `?tab=` (`connections` default | `users` | `sso` | `resources` | `controller`).

| Component | File |
| --- | --- |
| `OrgSettingsPage`, `AuditBrowse`, `AuditExportCard`, `RunConcurrencyControl`, `StorageLine` | `app/features/org-settings/org-settings-page.tsx` |
| `ConnectionsPanel`, `ConnectionModal` | `app/features/org-settings/connections-panel.tsx` |
| `UsersPanel`, `InviteModal`, `EditUserModal`, `DisableUserDialog`, `IdpChip` | `app/features/org-settings/users-panel.tsx` |
| `SsoPanel`, `ProviderModal`, `CallbackUrl` | `app/features/org-settings/sso-panel.tsx` |
| `ResourcesPanel` | `app/features/org-settings/resources-panel.tsx` |
| `KbPanel`, `McpPanel`, `SkillPanel`, `AgentPanel` | `app/features/org-settings/resource-rows.tsx` |
| `KBModal`, `McpModal`, `SkillModal` | `app/features/org-settings/resource-modals.tsx` |
| `AgentModal`, `MissingChips` | `app/features/org-settings/agent-template-modal.tsx` |
| `ControllerAdminPanel`, `GrantChips` | `app/features/org-settings/controller-admin-panel.tsx` |
| `MiniModal`, `ConfirmDelete`, `EditIco` | `app/features/org-settings/mini-modal.tsx` |
| `useOrgAction` | `app/features/org-settings/use-org-action.ts` |
| `StoreBrowser`, `StoreTree`, `BrowserToolbar`, `DeleteConfirm` | `app/features/kb-browser/store-browser.tsx` |
| `ModelEffortFields` (shared) | `app/features/agents/create-profile-modal.tsx` |
| `ConfirmDialog` | `app/ui/confirm-dialog.tsx` |

Live scope: `sseScopes.user()` — broadcasts (`resource.updated` from a KB re-index, skill/MCP save or
delete) revalidate the page.

Page-level states:

- **Permission-denied** — a non-admin never reaches the component; `requireRole` throws the
  `{ error: { code, message } }` envelope which `root.tsx`'s `ErrorBoundary` renders as
  "This area requires the admin role."
- **Tab counts** — `sso` counts only *active* providers, not configured rows; `resources` counts
  KB + MCP + skills (agent profiles are disclosed in the `title` hint, not folded into the number);
  `controller` is always 1.

### Connections tab — screen label `Settings · GitHub connections`

- **Empty** — "No connections yet. Add one first: every project binds to a GitHub repo through a
  connection."
- **Per-row pills** — `not validated` (`validationState === "unvalidated"`), `validation failed`
  (`"failed"`), `expires in N days` (`daysLeft !== null && daysLeft <= 30`), `default` (`c.def`).
- **Set default withheld** when the row already is the default (`!c.def`).
- **Scope chips** — only *proven* scopes render a chip (`source !== "assumed"`); assumed ones collapse to a
  single "… unproven. Verified when attached to a project" line.
- **Repo count omitted** when `c.repos === null`; expiry falls back to "no expiry date".
- `ConnectionModal` — owner field is **disabled on the update path** (`disabled={!!initial}`) with an
  explanatory line; failures render in a `.cred-warn` inside the modal and nothing is saved.
- `ConfirmDelete` — detail text branches on `confirm.boundProjects > 0` (names how many projects lose
  branch/PR sync).

Intents: `connection-add`, `connection-replace` (404 when the connection is gone), `connection-default`
(404 "That connection no longer exists."), `connection-remove`.

### Users & access tab — screen label `Settings · Users & access`

- **Domain allowlist block withheld** when `domains.length === 0`.
- **Temp-password notice** (`cred-ok`) — rendered after `invite-local` / `user-reset-password`, showing the
  one-time password with a dismiss button.
- **Per-user pills** — `setup pending` (`status === "invited"`), `whitelisted`
  (`status === "whitelisted"`), `password reset pending` (`u.pwreset`), `disabled` (`u.disabled`).
- **Self row** — `you` tag; the disable and remove buttons render with an `off` class and, when clicked,
  push an error toast ("You can't disable your own account" / "You can't remove your own account") instead
  of submitting.
- **Enable vs disable** — the row shows *either* a re-enable check button (`u.disabled`) or a disable hand
  button, never both.
- `InviteModal` — the GitHub and Google IdP chips are **disabled** when
  `!providers.github` / `!providers.google`, each with a `title`; failures render in a
  `.cred-warn[role="alert"]`.
- `EditUserModal` — name and email fields are **disabled unless the account is local** (`!isLocal`); the
  reset-password button disables while `resetAction.busy`; a temp password is shown inline after a reset.

Intents and their guards:

| Intent | Guard |
| --- | --- |
| `user-role` | 409 "You can't demote yourself" when `userId === admin.id && role !== "admin"` |
| `user-edit` | same self-demotion 409 |
| `user-reset-password` | admin gate only; returns `tempPassword` |
| `user-remove` | 409 "You can't remove your own account" |
| `user-disable` | 409 "You can't disable your own account"; last-admin guard inside `updateUser` |
| `user-enable` | admin gate only |
| `invite-github`, `invite-google` | admin gate only |
| `invite-domain` | `invalid` → 400, `duplicate` → 409 |
| `invite-local` | returns `tempPassword` + `email` |
| `domain-remove` | admin gate only |

### Sign-in & SSO tab — screen label `Settings · Sign-in & SSO`

- **Lead sentence, three variants** — 0 / 1 / 2 live sign-on methods.
- **Per-provider source line** — `app` (client ID shown or "Configured here"), `env` ("From this
  deployment's environment. Set credentials here to take it over"), or "Not configured".
- **Proved** — "· proved <date>" plus the limitation sentence when `verifiedDetail` exists.
- **Overridden env** — extra line when `p.disabledInApp && p.envAvailable`.
- **Pills** — `live` / `off`; plus `not tested` when `configuredInApp && !verifiedAt`.
- **Test / Turn on|off / Remove withheld** unless `p.configuredInApp`.
- **Turn on disabled** when `!proved && !p.active`, with a `title` explaining the test must pass first.
- **Button label** flips `Set up` ↔ `Update credentials`, and `Turn on` ↔ `Turn off`.
- `ConfirmDelete` detail branches on `envAvailable` (falls back to env credentials vs stops being offered).

Intents: `oauth-save` (400 "Unknown sign-in provider." / "Paste the client ID." / "Paste the client
secret." when no row exists yet), `oauth-test` (400 "Save the client ID and secret first."; records the
verdict either way), `oauth-toggle` (fails with `result.reason`), `oauth-remove`.

### Agent resources tab — screen label `Settings · Agent resources`

Four panels, each with its own empty state:

- **KB empty** — "No knowledge bases yet. A knowledge base is a folder of docs agents read live while they
  work…"
- **KB folder missing** (`!kb.folderExists`) — "folder missing: no docs reach a granted agent; re-create it
  or delete this knowledge base"; the meta line also switches from "re-scanned" to "last scanned".
- **KB non-text files** — "· N non-text files skipped" when `fileCount > injectableCount`.
- **MCP status dot**, five states — `warming` (`warmingSince !== null`), `stale`, `up`, `down`, and no
  class at all for `up === null` ("not health-checked").
- **MCP credential** — "auth: unreadable (rotate the encryption key…)" when `credUnreadable`, else
  "auth: configured (Claude runs only · Codex mounts it unauthenticated)"; nothing when `!hasCred`.
- **MCP error line** — `rsrc-err` rendered only when `up === false && lastError && warmingSince === null`.
- **MCP empty**, **Skill empty**, **Agent-profile empty** — each an `.empty` block.
- **Agent delete refused in the client** — when `a.used > 0` an error toast "Detach <name> from its N
  projects first" fires and no dialog opens.
- **Testing / re-indexing busy** — the refresh icon gets `spin` for the row being tested/re-indexed.
- `ConfirmDelete` copy is per resource kind and appends `grantTail(...)` counting the template and project
  grants that would drop.
- `AgentModal` — per-group "no skills/MCPs/KBs exist" hints when the catalog is empty; `MissingChips`
  render granted ids that no longer exist in the store as red removable chips; Save disabled with a
  `storedRoleRepeatsName` explanation when the role prefills empty.

Intents: `kb-save`, `kb-delete`, `kb-reindex`, `mcp-save`, `mcp-test`, `mcp-delete`, `skill-save`,
`skill-delete`, `agent-save`, `agent-delete` (409 `in_use`).

### Controller tab — screen label `Controller settings`

- **Profile file missing** (`!config.profilePresent`) — `deny-note` "The controller profile file is missing
  from the store; defaults apply. Restart the app to restore the shipped one."
- **Deployment locks** (`controllerSectionLocks()`) — when any section is locked the lead sentence says so,
  and a `pol-note` (`id=LOCK_NOTE_ID`) names the locked sections plus the `VIBERR_UNLOCK_CONTROLLER_*`
  variables that would unlock them.
- **Locked grant group** — chips render as non-interactive `<span>`s, the group gets
  `aria-label="<label> (locked on this deployment)"` and `aria-describedby` pointing at the lock note; a
  locked-and-empty group renders a placeholder line.
- **Missing grant chips** — under a lock they are non-removable spans with a "No longer in the store…"
  title; unlocked they use `MissingChips` with a drop handler.
- **Pinned MCP** — `viberr_ops` renders as a disclosed, non-removable chip.
- **Instructions locked** — `readOnly` textarea with the hint "read-only, locked on this deployment".
- **Model catalog loading** — `ModelEffortFields` renders "loading available models…" and disables the
  model/effort selects (`disabled={!backend || catalogLoading}`).
- **Model catalog failed** — a `Retry` button appears next to the label.
- **Saving** — button label `Saving…`, `disabled={action.busy}`, `aria-busy`.

Intent: `controller-save`. Locked sections post **blank**, which `saveControllerConfig` reads as "keep";
a non-empty change to a locked section is refused server-side.

### Page-level cards below the tabs

- `RunConcurrencyControl` — intent `set-concurrency`; 400 "Enter a whole number (0 = unlimited)." when the
  value is not finite or negative; success copy branches on `applied === 0` (unlimited) and calls
  `drainRunQueue`.
- `AuditExportCard` — keyed on the stored S3 target so the form folds after a save/clear.
  - **No target configured** — the five-field form is open.
  - **Target configured** — folded behind a summary line.
  - Intents `s3-config-save` (400 with the thrown message), `s3-config-clear`, `audit-export-s3`
    (400 "No S3 target is configured…"; network throw → "S3 upload failed: could not reach the bucket. …";
    HTTP error → "S3 upload failed (HTTP N). …").
- `AuditBrowse` — client-side filter over the loader's recent rows.
  - **No events at all** — "No audit events recorded yet."
  - **No events match the filter** — "No events match this filter."
  - **Org-scoped toggle** — `aria-pressed` chip hiding rows that carry a `projectSlug`.
  - The list is `tabIndex={0}` because it scrolls.
- `StorageLine` — storage summary from `view.storage`.

### `StoreBrowser` — screen label `Files · <resource name>`

Opened from the KB and Skill rows. Native `<dialog>`; a nested delete confirm and the replace confirm each
get their own `<dialog>`, and the browser goes `inert` while one is open.

States:

- **Empty folder** — `fm-empty` "Empty. Drag files or folders here, upload, or import from GitHub."
- **Uploading** — `def-note[aria-live="polite"]` "Uploading N files…"
- **Upload that wrote nothing** — server toast naming the hidden-file skip, or "Nothing uploaded: that
  selection had no files."; a client-side empty selection produces no request at all.
- **Document editor — loading** — path line gains "· loading…".
- **Document editor — truncated** — `cred-warn` "This document is larger than the editor can load…"; Save
  is **disabled** (`doc.truncated` is part of the disabled predicate).
- **Document editor — error** — `cred-warn` with `doc.err` (read failure default "That document could not
  be read.", write failure default "The document was not saved.").
- **Save disabled** when the name is blank, the doc is truncated, or a save/load is in flight; label flips
  to `Saving…`.
- **New document collides** — opens the replace confirm instead of saving.
- **GitHub import** — collapsible bar with its own error line; the import button disables while
  `importing`.
- **Escape** — closes the open document editor first, not the browser under it.

Intents: `store-upload` (404 "That resource no longer exists."), `store-write-doc` (`overwrite` flag; a
collision without it is refused), `store-read-doc` (404 "That file no longer exists."), `store-mkdir`,
`store-delete`, `store-import-github` (fails with `result.message`).

Any unmatched intent on this route returns 400 "Unknown action."; thrown `AppError`s go through
`appErrorResponse`.

## 6. `/org/settings/audit-export` — `app/routes/org.settings.audit-export.ts`

Org-admin-gated CSV/JSON file response. No UI.
---

## 7. `/controller` — instance controller page

Module: `app/routes/controller.tsx`. Screen label: `Controller`. Guard: `requireAuth` (every signed-in
user); the action maps a stale token through `csrfError(...)` to a toast-shaped result rather than a
thrown 403.

| Component | File |
| --- | --- |
| `ControllerPage`, `Transcript`, `Composer`, `ConversationList`, `GoalsPanel`, `GoalCard`, `surfaceLabel` | `app/features/controller/controller-page.tsx` |
| server view | `app/features/controller/controller-query.server.ts` |
| `Markdown` | `app/ui/markdown.tsx` |

States:

- **Backend unavailable** — `Pill kind="risk"` "Claude backend unavailable" in the header, and the composer
  is disabled with the placeholder "The Claude backend is unavailable, so the controller cannot answer."
- **Header sub-line, three variants** — anchored to a task key; managing a named board; managing the
  instance.
- **Home link withheld** when `projectSlug` is set (only the instance page shows it).
- **No conversation selected** — transcript renders the `.empty` prompt "Ask a question or ask for a
  change: boards, tasks, users, resources, agents, goal chains…"
- **Conversation list empty** — "No conversations yet. Say something below."
- **Org-admin cross-user view** — `viewerIsOrgAdmin` renders a `Show everyone's (org admin)` /
  `Show mine only` toggle linked through `?all=1`; a row the viewer does not own prefixes the owner label.
- **Read-only conversation** — `view.conversation !== null && !view.viewerOwnsActive` disables the composer
  with "Read-only: only the conversation's owner can talk in it."
- **Turn working** — `ctl-working` `role="status"` row.
- **Message surface chip** — `from <surfaceLabel(m.surface)>` rendered only when the message recorded one.
- **Sending** — Send label `Sending…`; disabled while `busy || disabled || !text.trim()`.
- **Send error** — error toast; a *refusal* is recorded in the transcript and the action still answers
  `ok`.
- **Goals panel withheld** entirely when `view.goals === null` (the instance page passes no goals).

Intent: `send` (400 "Unknown action." otherwise). A missing `conversationId` creates one first.

## 8. `/projects/:slug/controller` — project-scoped controller

Module: `app/routes/project.controller.tsx`. Renders the same `ControllerPage` with `projectSlug` and
`canRedirectGoals`.

Loader guard: `requireProjectMember(request, params.slug, "talk to the controller about this project")` —
a non-member gets the unknown-slug 404, applied on this loader as well as the layout's (single-fetch
`?_routes=` hole). `canRedirectGoals` = `roleCan(memberRole, "run-agents")`, falling back to
`view.viewerIsOrgAdmin` when the member row has no parseable role.

Action guards: `requireAuth` → `csrfError` → `requireVisibleProject(db, slug, actor, "talk to the
controller about this project")`.

Extra states (Goals panel, `app/features/controller/controller-page.tsx`):

- **No goals** — "No goal chains yet. Ask the controller to plan one…"
- **Goal status pill** — `active` / `paused` / `attention` / `completed` / `cancelled`.
- **Link status pill** — `pending` / `active` / `done` / `failed` / `skipped` (unknown falls back to
  `pending`).
- **Current link** — `li.on` when `l.index === goal.currentIndex`.
- **Link task link withheld** when `l.taskKey` is absent.
- **Retry / Skip withheld** unless `canRedirectGoals && !settled && l.status === "failed"`.
- **Goal footer withheld** unless `canRedirectGoals && !settled` (settled = completed or cancelled).
- **Resume vs Pause** — Resume when `status === "paused" || "attention"`, otherwise Pause.
- **Busy** — every goal control disables while the goal fetcher is in flight.
- **Link note** — `ctl-link-note` rendered only when `l.note` exists.

Intents:

| Intent | Guard |
| --- | --- |
| `send` | project visibility + CSRF; creates the conversation when none is supplied |
| `goal-op` (`pause`, `resume`, `cancel`, `skip_link`, `retry_link`) | unknown op → 400 "Unknown goal action."; `updateGoal` applies the creator-OR-`run-agents` gate per submit |
| anything else | 400 "Unknown action." |

## 9. `/insights` — instance-wide run analytics

Module: `app/routes/insights.tsx`. Loader guard: `requireRole(request, "admin")`. Read-only, no action.

| Component | File |
| --- | --- |
| `InsightsPage`, `StatCard`, `BreakdownCard`, `DailyChart`, `OversightCards`, `BackendQuotaPanel` | `app/features/insights/insights-page.tsx` |

States:

- **Permission-denied** — non-admins hit the root `ErrorBoundary` via `requireRole`.
- **No runs at all** (`totals.runs === 0`) — the entire body is replaced by "No agent runs yet. Once agents
  start working, their cost, tokens and outcomes show up here."
- **Partial cost coverage** — the Total cost card gains a sub-label "N of M runs reported no cost" only
  when `costedRuns < runs`.
- **Completion-rate sub-label** — appends `running` / `queued` counts only when non-zero.
- **Breakdown card empty** — `rows.length === 0` renders an empty line per card (backend, run kind,
  project, model).
- **Daily chart** — `role="img"` with a per-day `title`; empty days render a floor tick.
- **Backend quota row, four states** — `credential refused` (outranks everything; bar rendered full),
  `usage limit reached` (an exhaustion record newer than any reading), `no reading yet` (`reading == null`),
  `utilization not reported` (`pct == null`), and the normal `N% of <rate limit type>`. Absent states use
  the de-emphasized `.na` class.
- **Hydration gating** — every localized timestamp `title` is omitted during SSR (`useHydrated`).

## 10. `/profile` — Profile & preferences (PageOverlay)

Module: `app/routes/profile.tsx` (inside `palette-shell`). Screen labels: `Profile & preferences · overlay`
(from `PageOverlay`) and `Profile & preferences` (the page body).

| Component | File |
| --- | --- |
| `ProfilePage`, `ProfileIdentity`, `ProfileNotifications`, `ProfileAppearance`, `ProfileAccess`, `ProfileGithub`, `ProfilePassword` | `app/features/profile/profile-page.tsx` |
| `PROFILE_NTF`, routing prefs | `app/features/profile/notification-prefs.ts` |
| query / actions | `app/features/profile/profile-query.server.ts`, `app/features/profile/profile-actions.server.ts` |
| `PageOverlay` | `app/ui/page-overlay.tsx` |

Loader: `requireUser`; a missing profile row throws `data("Account not found.", { status: 404 })`.
Action: `requireAuth` → `csrfError` (toast-shaped, not a thrown 403); every `AppError` is mapped to
`{ ok:false, intent, error }` with the error's status.

Return-to: `location.state.returnTo` is parsed by a Zod schema (`overlayReturnState`), defaulting to `/`.

States:

- **Email field disabled** — always (`<input id="profile-email" ... disabled />`).
- **No memberships** — the identity card renders "No projects yet" instead of a membership list.
- **Your access — no role** — `.empty` "No project membership yet. A project role, assigned by an admin,
  is what unlocks that project's board, tasks and the actions listed above…"; the RBAC grant table is
  withheld.
- **Your access — with role** — role `Pill` in the head plus a check/dash per `RBAC_ROWS` entry.
- **Policy link degraded** — when the viewer has no membership, "Policy → Human access" renders as
  `<strong>` text instead of a navigating `keybtn` (same treatment in the GitHub card).
- **GitHub — OAuth not configured and not connected** — the whole credential card is withheld and replaced
  by a `pol-note`: "GitHub sign-in isn't configured on this deployment…"
- **GitHub — connected** — `cred-ok` block naming the attribution handle plus a Disconnect button.
- **GitHub — not connected (provider configured)** — `cred-warn` plus a Connect button, disabled while
  `connectBusy` with the label "Connecting…"; scope chips render `miss` when unconnected.
- **GitHub error** — `login-err[role="alert"]` carrying either the action error or the connect error.
- **Change password panel withheld** unless `data.user.hasPassword` (OAuth-only accounts).
- **Password errors** — `login-err[role="alert"]`; client-side pre-checks for the minimum length and the
  confirm mismatch; fields reset on success; the button disables and sets `aria-busy` while submitting.
- **Theme re-selection is a no-op** — `onTheme` returns early when the value already matches; a failed
  `/prefs/theme` POST rolls the applied preference back and toasts the error.
- **Appearance / notification optimistic flips** — each panel keeps a rollback snapshot; Appearance owns a
  separate fetcher from the notification prefs so one result cannot speak for the other.

Intents (all on `/profile`):

| Intent | Guard |
| --- | --- |
| `identity` | CSRF + own account only (`actor` is the session user) |
| `set-notif` | own prefs |
| `set-motion` | own prefs |
| `set-tl-default` | own prefs |
| `change-password` | `changeOwnPassword` verifies the current password; server-side length/match |
| `github-disconnect` | own identity |
| anything else | 400 "Unknown action." |

Dialogs: the route itself is a `PageOverlay` (native `<dialog>` via `useDialog`, screen label
`<label> · overlay`).

## 11. `/notifications` — Notifications (PageOverlay)

Module: `app/routes/notifications.tsx` (inside `palette-shell`). Screen labels:
`Notifications · overlay` and `Notifications`.

| Component | File |
| --- | --- |
| `NotificationsPage`, `NtfNeedsYou`, `NtfStream` | `app/features/notifications/notifications-page.tsx` |
| `NotificationItem` | `app/features/notifications/notification-item.tsx` |
| grouping helpers | `app/features/notifications/notifications-page-helpers.ts`, `app/features/notifications/notification-meta.ts` |

Loader: `requireUser`; fetches `NOTIF_PAGE_LIMIT + 1` (201) rows to detect truncation, plus the
authoritative `decisionsRequiring(db, user.id).mine.length`. Live scope: `sseScopes.user()`.

States:

- **Header count** — `shownUnread = unread + orphanUnread`, where orphans are unread rows whose project no
  longer exists (`targetMissing`), which `countUnreadNotifications` excludes; the sub-line reads
  "· N unread" or "· all caught up".
- **Mark all read withheld** when `shownUnread === 0`.
- **Filter** — `role="group"` with `aria-pressed` (All / Unread); deliberately not `radiogroup`.
- **Waiting on you — empty, nothing pending** — "Nothing is waiting on you."
- **Waiting on you — empty, hidden by the filter** — "N decisions are waiting on you. Switch to "All" to
  see them."
- **Waiting on you — empty, rows exist elsewhere** — "N decisions are waiting on you. Open them from the
  board or the task page."
- **Waiting on you — shortfall disclosure** — the head sub appends "N hidden by the filter" and/or
  "N on their task pages" (`decisionCount - total`).
- **Stream empty** — "You're caught up."
- **Stream row — navigable** — `keybtn` rendered only when `n.href !== null`.
- **Stream row — orphan** — `keybtn dead` span with the title "The project this refers to no longer
  exists" when `href === null && targetMissing`; org-wide rows render neither.
- **Mark read control withheld** on already-read rows.
- **Truncated** — `ntf-truncated` "Showing the most recent 200 notifications. Older ones aren't listed
  here."
- **Time rendering** — `formatClock` after hydration, `formatClockUTC` during SSR.

Intents (POSTed to `/notifications/read`): `read` (repeatable `id` fields; 400 "No notification ids." when
none), `read-all`. Both are idempotent; a stale CSRF token returns the toast-shaped
`csrfError` result rather than throwing.

## 12. `/notifications/read` — `app/routes/notifications.read.tsx`

Action-only. Guards: `requireAuth` → `csrfError`. `loader` throws `redirect("/notifications")`.

## 13. `/prefs/theme` — `app/routes/prefs.theme.tsx`

Action-only. Guards: `requireAuth` → `csrfError`; 400 "Invalid theme." for a value
`isThemePreference` rejects. Writes `users.theme` and the `viberr_theme` cookie. `loader` throws
`redirect("/")`.
---

## 14. Resource routes (fetcher targets and file responses, no UI)

| Route | Module | Guard / notable states |
| --- | --- | --- |
| `/resources/events` | `app/routes/resources.events.ts` | `authenticate`; scopes `project:<slug>` / `task:<slug>/<key>` / `projects` / `user`; an unauthenticated EventSource gets plain 401 JSON (the browser then *fails* the connection and never retries — this is what drives the "live updates paused" pill) |
| `/resources/run-log` | `app/routes/resources.run-log.ts` | `requireUser` + `requireProjectMember` (org admins via the D2 override); forward tail `?since=` and backward page `?before=&limit=`; `hasMore`/`headSeq`/`oldestSeq` are page-local cursors |
| `/resources/health` | `app/routes/resources.health.ts` | Unauthenticated by design. `?probe=readiness` returns 503 when anything in `degraded` is set; liveness stays 200. `status` is `ok \| degraded \| down`. Degraded: `watcher`/`kbWatcher` false, `lock` null, `disk.status` low/critical. Deliberately not degraded: an unavailable backend, `disk: null` |
| `/resources/search` | `app/routes/resources.search.ts` | `requireUser`; `searchWorkspace` scopes to visible projects; query truncated to 120 chars |
| `/resources/controller` | `app/routes/resources.controller.ts` | `requireAuth` + `csrfError`. **Nothing throws** — a GET for an unreachable scope answers `unavailableDockView`, a POST answers `{ ok:false, error }`. Scope authorized by `assertProjectAction("any-member")`; a task scope additionally requires `dockTaskExists`. Intent `send` only (400 otherwise); 404 "That project or task is not open to you." and 404 "Conversation not found." for a thread from another scope |
| `/resources/model-catalog` | `app/routes/resources.model-catalog.ts` | `requireUser`; `?backend=claude\|codex` (unknown defaults to claude); models carry an `unavailable` mark from `model_availability` so the picker can disable one a real run proved unusable |
| `/resources/session-export` | `app/routes/resources.session-export.ts` | `requireUser` + `requireProjectMember`; 400 "Missing ?run=<runId>."; 404 "Run not found."; 404 when the run has no resumable on-disk session; a `controller`-kind run is gated on conversation ownership instead |
| `/projects/:slug/tasks/:key/attachments/:file` | `app/routes/task-attachment.ts` | `requireUser` + `requireProjectMember("view task attachments")`; traversal violations answer a plain 404 (no oracle); 413 over `MAX_ATTACHMENT_BYTES` (50 MB); `?download=1` forces `content-disposition: attachment`; every response carries `nosniff` + `content-security-policy: sandbox; default-src 'none'` |
| `/projects` | `app/routes/projects.tsx` | `redirect("/")` |
| `/projects/:slug` (index) | `app/routes/project._index.tsx` | `redirect("/projects/:slug/board")` |

Shared action-side guard for project routes: `requireVisibleProject`
(`app/routes/project-visibility.server.ts`) resolves through `assertProjectAction("any-member", …,
{ allowArchived: true })` and converts any `AppError` into the byte-identical
`No project at projects/<slug>.` 404, so a refusal can never confirm the project exists.

---

## 15. `/projects/:slug` — workspace layout

Module: `app/routes/project.tsx`.

| Component | File |
| --- | --- |
| `ProjectLayout`, `ArchivedBanner` | `app/routes/project.tsx` |
| `Rail` | `app/features/shell/rail.tsx` |
| `Topbar` (+ `TopBell`, `UserMenu`, `CommandPalette`) | `app/features/shell/*` |
| `SkipLink` | `app/ui/skip-link.tsx` |

Loader guard: `requireUser`, then `getBoard`; an unknown slug throws
`data("No project at projects/<slug>.", { status: 404 })`. Membership is resolved *before* any
viewer-scoped projection work and a non-member gets the **same** 404 (R15-4 / WI-13). An org admin who
is not a member passes as `orgAdminOverride`.

States:

- **Not a member, not an org admin** — 404 through the root `ErrorBoundary`.
- **Org-admin override** — the topbar pill; `myRole` is treated as `admin`.
- **Archived project** — `ArchivedBanner` (`role="status"`) between the topbar and the Outlet; its
  second half branches on `roleCan(myRole, "edit-policy")`: "restore it from Settings → Danger zone"
  vs "a project admin can restore it to make changes."
- **Rail counts** — board = live tasks incl. Done; review = live tasks in the *structural* review stage
  (0 for an archived project); violations rendered only when > 0.
- **Mobile rail overlay** — `data-rail-open` on the app root; a decorative `rail-scrim` div (pointer-only,
  `aria-hidden`) closes it; the rail auto-closes on every `location.pathname` change.
- **Live updates** — `project:<slug>` + `user` scopes, plus `task:<slug>/<key>` when a task route is
  matched; `live.paused` drives the topbar's retry pill.

No action on this route.

---

## 16. `/projects/:slug/board` — Board

Module: `app/routes/project.board.tsx`. Screen label: `Board`. Data comes from the layout loader.

| Component | File |
| --- | --- |
| `BoardPage`, `BoardHeader`, `FilterBar`, `StageBoard`, `Column`, `TaskCard`, `ListView`, `ListRow`, `DropPreview`, `OrphanBanner`, `NewTaskModal`, `AcceptOnBoardConfirm`, `StateSignals`, `WaitTag`, `QuietTag`, `ContinuityTag`, `ArchivedPill`, `OwnerLine`, `ReviewerStack` | `app/features/board/board-page.tsx` |
| filter/empty-copy model | `app/features/board/board-filters.ts` |
| drag model | `app/features/board/board-dnd.ts` |
| `AcceptConfirm` (shared ceremony) | `app/features/task-detail/accept-confirm.tsx` |
| `StageMenu` | `app/ui/stage-menu.tsx` |
| `LabelInput`, `LabelChips`, `PriorityFlag`, `DueDatePill`, `ReadinessPill`, `ValidationPill`, `Pill` | `app/ui/label-input.tsx`, `app/ui/task-meta.tsx`, `app/ui/pill.tsx` |

Role gates, all read through `roleCan` against the same action ids the server enforces:
`canCreate` = `create-task`, `canTransition` = `reorder-board`, `canRescan` = `rescan-project`.

Page states:

- **No stages at all** — `StageBoard` returns a `role="status"` notice: "This project has no workflow
  stages yet. Add a stage in project settings before tasks can be created or shown here."
- **New task with no stage** — the New-task button is rendered but its handler pushes an error toast
  ("Add a stage in project settings before creating tasks…") instead of opening the modal.
- **FilterBar withheld** entirely on a brand-new board (no tasks, no archived, no active filter/query/label).
- **Archived filter active** — an extra `role="status"` notice explaining archived tasks.
- **Orphan tasks** — `OrphanBanner` (`role="region"`, label "Unstaged tasks") listing keys whose stage
  matches no column.
- **Header count** — `N tasks` when unfiltered, `N of M tasks` when filtered; the denominator switches to
  the archived count under the Archived filter.
- **Re-scan withheld** unless `canRescan`; while scanning the icon spins, the label reads `Scanning…`,
  and the button is `disabled` with `aria-busy`.
- **New task withheld** unless `canCreate`.
- **Layout toggle** — `role="group"` Board/List with `aria-pressed`.
- **Screen-reader announcements** — a visually-hidden `role="status" aria-live="polite"` region carries
  drag pickup/drop requests and the server's move outcome, including refusals.

Filter chips (`FILTERS`): `all`, `human` ("Waiting on me"), `agent`, `risk` ("Blocked or waiting"),
`quiet` ("No activity"), `continuity` ("Degraded continuity"), `archived`.

- **`archived` and `continuity` chips withheld** unless the project has such tasks or the filter is
  already active.
- **Tallies** appended to `human`, `quiet`, `continuity`, `archived` only when > 0.
- **Label chips** — capped at `LABEL_CHIP_CAP` (6), active-first, with a `+N more` / `fewer labels`
  expander (`aria-expanded`); withheld when the project uses no labels.
- **Clear chip withheld** unless a filter, a query or a label filter is active; it resets all three in one
  history entry.

Empty-state copy (`boardEmptyCopy`, `app/features/board/board-filters.ts`), five variants:

1. Whole board empty, entry column, no filter/query — "No tasks yet. Create one to start the flow" (plus
   an emphasized `New task` CTA inside the lane).
2. Column has no tasks at all — "No tasks".
3. Hidden by both filter and search — "… hidden by the “<filter>” filter and the search “<q>”."
4. Hidden by the filter alone.
5. Hidden by the search alone.

Card states (`TaskCard` / `StateSignals`):

- **Archived card** — `ArchivedPill` replaces the readiness pill; **all** state signals, the meta row,
  drag and the Move menu are withheld (`isArchived(task)` returns null from `StateSignals`; `disabled`
  on the sortable; `canTransition && !archived` guards the `StageMenu`).
- **Agent working** — the readiness pill is withheld (`displayReadiness === "agent_working"`) so the foot's
  `WaitTag` speaks alone.
- **Wait tag** — "agent working" (`waiting === "agent"`), "waiting on you" (`waiting === "human" &&
  waitingOnMe`), or "waiting on a human"; nothing otherwise.
- **PR state pill** — only for `pr.state === "accepted"` (merge pending) or `"closed"`.
- **Checks pill** — only when `prChecks.state === "failing"`.
- **GitHub review pill** — only when `prReview === "changes_requested"`.
- **Validation pill** — only when not terminal (`displayReadiness` is `accepted`/`merged` suppresses it)
  and `validation !== "none"`.
- **Continuity pill** — only when `continuity === "degraded"`.
- **State-pill fold** — at most `STATE_PILL_CAP` (2) render full strength; the rest fold into one neutral
  `+N` chip whose `title` lists them.
- **Quiet pill** — only when `task.quiet && task.lastActivityAt`.
- **Branch chip** — "no branch" variant when `task.branch` is absent; PR chip only when `task.pr` exists.
- **Owner line** — agent glyph + role when a specialist is assigned, otherwise the human owner.
- **Roving tab stop** — exactly one card carries `tabIndex={0}`; empty lanes drop `role="list"` and
  `tabIndex` (an empty `list` would fail `aria-required-children`).
- **Drag** — the card is only `draggable` when `canTransition && !archived`; optimistic sorting is
  disabled, so the `DropPreview` shows the requested slot and the server's answer is the only commit.

Dialogs:

- `NewTaskModal` (`aria-label="New task"`) —
  - **Save disabled** until the title is ≥ 3 chars, and while busy.
  - **Foot hint, three variants** — the server error, "A title is required." (only once the title has been
    touched or submit attempted), or "The task key is assigned automatically."; the hint carries
    `role="alert"` exactly when it is an error.
  - **Success** — toast "<KEY> created in <stage>. Its task.md is in the store" and the modal closes.
- `AcceptOnBoardConfirm` → the shared `AcceptConfirm` in `ceremony.mode: "stage-move"`.
  - **Refusal** (`boardAcceptRefusal`) resolves, in order: archived-task reason → closed-PR reason →
    off-boundary reason (`atAcceptanceBoundary`) → `task.blockReason` → open blocked packet →
    conflicting-PR reason. A refusal shown here is final; the board has no force-accept.
  - `noChanges` and `noPullRequest` are passed `false` because the board cannot run the task page's
    accept-time branch re-probe.

Intents on `project.board.tsx`:

| Intent | Guard |
| --- | --- |
| `create-task` | `requireFormAction` (auth+CSRF+origin) → `requireVisibleProject` (404) → `createTask`'s own RBAC |
| `reorder` | same, plus `reorderTask` → `transitionStage`; a drop on the terminal stage consults the `acceptanceAck(formData)` disclosure and a missing/half-filled echo (`null`) is refused |
| `rescan` | `assertProjectAction(db, "rescan-project", slug, actor, "re-scan the project")` |
| anything else | 400 "Unknown action." |

Result toasts branch three ways: `Accepted <KEY>, moved to <stage>` (`acceptedIntoDone`),
`Moved <KEY> to <stage>` (`movedStage`), `Reordered <KEY>`. A failed re-scan surfaces
`rescanFetcher.data.error` with the error kind.
---

## 17. `/projects/:slug/review` — Review queue

Module: `app/routes/project.review.tsx`. Screen label: `Review queue`. Read-only (no action).

| Component | File |
| --- | --- |
| `ReviewQueuePage`, `RQRow` | `app/features/review/review-page.tsx` |
| row helpers | `app/features/review/review-helpers.ts` |
| acceptance authority | `app/features/review/review-acceptance-authority.server.ts` |

Loader guard: `requireProjectMember(request, slug, "view the review queue")` — repeated on *this*
loader because single-fetch honours a client-supplied `?_routes=` filter; an unknown project throws the
byte-identical 404.

States:

- **Boundary chip, two variants** — `<review> → <terminal> · human only` (lock icon) or
  `· human or operator` (bolt icon) when `acceptance.operatorCanAccept`. Stage names come from the
  resolved workflow, never hardcoded.
- **Boundary note, two variants** — the same split, spelled out in the panel foot; the operator variant
  names full autonomy plus the explicit `ACCEPTANCE_CAP_LABEL` = Direct grant.
- **"Waiting on your acceptance" empty** — "Nothing waits on you. Completion reports land here when a task
  reaches the boundary."
- **"Still in review" empty** — "No review work in flight. A task an agent is actively revising in a review
  stage shows here until it reaches the boundary and moves to the queue above."
- **Row PR pill** — the label rides along only for `closed` and `accepted`; `merged` and `review` render
  bare.
- **Row meta** — validation pill always; priority flag, label chips (max 3) and due-date pill only for
  non-default values; quiet pill only when `t.quiet && t.lastActivityAt`; continuity pill only when
  `continuity === "degraded"`.
- **Row wait tag, four cases** — `ready` → "waiting on you"; `waiting === "human"` → "waiting on a human";
  `waiting === "agent"` → "agent working"; `waiting === "none"` → nothing (deliberately silent, matching
  the board card).
- Row label is `Review <key>: <title>` — deliberately not "Accept", because acceptance is verdict-gated
  and may refuse.

---

## 18. `/projects/:slug/agents` — Agents

Module: `app/routes/project.agents.tsx`. Screen label: `Agents`.

| Component | File |
| --- | --- |
| `AgentsPage`, `ProfileItem`, `ProfileDetail`, `EligibleStages`, `LiveRoster`, `LibraryPicker`, `AgentStats`, `DeleteConfirm`, `ResGroup`, `DeploymentStatusPill` | `app/features/agents/agents-page.tsx` |
| `CreateProfileModal`, `ModelEffortFields`, `BackendField`, `CapabilityGrants`, `ResourcePicker`, `ModalFooter` | `app/features/agents/create-profile-modal.tsx` |
| `CapabilityMatrixModal` | `app/features/agents/capability-matrix-modal.tsx` |
| catalogs / types | `app/features/agents/capability-catalog.ts`, `app/features/agents/agent-types.ts` |
| roster query | `app/features/agents/agents-query.server.ts` |
| mutations | `app/features/agents/agent-profile-actions.server.ts` |

Loader guard: `requireProjectMember(..., "view this project's agents")`, plus the 404 for an unknown
project. `canManage = roleCan(myRole, "manage-agents")` (project admin only).

States:

- **Read-only banner** — `!canManage` renders a `pol-note`: "Read-only: deploying, editing or removing
  agent profiles needs the **Manage agent profiles** grant, held by a project admin. The capability matrix
  below is readable by every member."
- **Withheld controls for `!canManage`** — "Add from library", "New profile" (header), the `ag-add`
  plus button, the `ag-newbtn` buttons, Edit and Delete on the detail hero.
- **Delete withheld** for the operator profile (`a.kind !== "operator" && canManage`).
- **Live tab tally** — `Live · <deployments.length>`.
- **Profile status line, four variants** — "running on N tasks"; `idle · <backend> not configured` (risk
  pill, from `backendCredentialHealth`); "idle · engaged on N tasks"; "idle · available".
- **Scope line** — appends "· customized for <project>" when the deployment has diverged from the template.
- **Model cell** — "default" warning chip when `!a.modelKnown`; "unavailable" warning chip when
  `a.modelUnavailable` (a real run proved the provider refuses this model for this account); both carry
  the reason in `title`.
- **Eligible stages summary, four variants** — "active across the whole lifecycle" (`spanAll`);
  "no stage restriction · eligible everywhere" (no declared stages); "declared stages don't exist here ·
  eligible everywhere"; "N of M stages".
- **Stale stage chip** — a declared id that resolves to nothing renders `<id> · not on this board` with an
  explanatory `title`.
- **Dead declaration note** — `empty xs` block when `!spanAll && stages.length > 0 && resolved.length === 0`.
- **Active deployments empty, two variants** — the plain "Not currently engaged on any task. This profile
  is approved and available for assignment." and the `backendMissing` variant naming the refused run.
- **Resource group empty** — "None" (`items.length === 0`).
- **Codex advisory notes** — per-row `title` explaining that a Claude-enforced grant binds only advisorily
  on a Codex runtime.
- **Live roster empty** — "No agents are currently engaged. When an operator or an agent profile is running
  on a task, it appears here with its live status. Open a task and run the operator to engage one."
- **Live roster unresolved profile** — the condition is named instead of printing a raw id, with the id in
  the `title`.

Dialogs:

- `CreateProfileModal` (`aria-label` "New agent profile" / "Edit profile") — footer hint resolves in
  order: server `error` → "Name, role, one execution backend, and at least one stage are required." →
  model-pending variants (`catalogLoading` "Loading the models available on <backend>…" /
  `catalogFailed` "Couldn't load the models available on <backend>. Retry above…" / "Pick a model
  available on <backend>…") → `forksTemplate` "Ready to save: this forks <name> for <project>." →
  "Ready to save changes." → "Ready to add to <project>."
  - **Backend disabled** when `backendAvailable[backend]` is false.
  - **Model/effort selects disabled** while `!backend || catalogLoading`; a `Retry` button appears on
    `catalogFailed`.
- `LibraryPicker` — **empty**: "Every global profile is already deployed here. Create more in org settings
  → Global agent profiles."; each row disables while `busy` and carries a stage-count pill
  ("every stage here" vs "N stages here").
- `CapabilityMatrixModal` (`aria-label="Capability matrix"`) — readable by every member.
- `DeleteConfirm` — carries the active-engagement count.

Intents:

| Intent | Guard |
| --- | --- |
| `create-profile` | `requireFormAction` → `requireVisibleProject` (404) → `createAgentProfile`'s own RBAC |
| `deploy-profile` | same, `deployAgentProfileFromLibrary` |
| `update-profile` | same, `updateAgentProfile`; may return `governanceNotice` for an autonomy elevation / direct-accept grant |
| `delete-profile` | same, `deleteAgentProfile` |
| anything else | 400 "Unknown action." |

Saves may return `notices` (a coupling decision the save had to make — a withheld delivery headline, web
egress under the browser capability) which the page toasts alongside the success message.

---

## 19. `/projects/:slug/policy` — Policy

Module: `app/routes/project.policy.tsx`. Screen label: `Policy`.

| Component | File |
| --- | --- |
| `PolicyPage`, `HumanAccess`, `AgentCapability`, `WorkflowRules`, `Guardrails` | `app/features/policy/policy-page.tsx` |
| catalog | `app/features/policy/policy-data.ts` |
| query / actions | `app/features/policy/policy-query.server.ts`, `app/features/policy/policy-actions.server.ts` |
| `CapabilityMatrixModal` | `app/features/agents/capability-matrix-modal.tsx` |
| `rovingRadioKeyDown` | `app/ui/roving-radio.ts` |

Loader guard: `requireProjectMember(..., "view this project's policy")` + 404. Action guard:
`requireFormAction` → `requireVisibleProject(..., "change this project's policy")`.
`canSetRole = roleCan(myRole, "manage-members")`; `canEditPolicy = roleCan(myRole, "edit-policy")`.

States:

- **Last-change chip withheld** when `data.edited` is null.
- **Human access — read-only note** — `!canManage`: "Read-only: changing a member's role needs the
  **Manage members & roles** grant (project admin)."
- **Member — removed account** — `blocked` pill "removed account", the email line replaced by "This
  account no longer exists. Remove it in Settings → Members.", and the role radios `disabled`.
- **Member — disabled account** — neutral pill "disabled".
- **Role radios disabled** when `!canManage || busy || m.missing`.
- **Agent capability — no gated capabilities** — the counts collapse to "read-only · no gated
  capabilities" with an explanatory `title`.
- **Agent capability — Codex advisory** — an "advisory on Codex" chip when a Codex-primary profile holds
  Claude-only-enforced grants.
- **Always-human rows** — each carries either "all profiles" or "agent profiles" (when an exception
  exists).
- **Workflow — off-chain stages** — a `pol-note` naming the stages no transition rule reaches.
- **Workflow — read-only note** — `!canManage`: "Read-only: changing a transition's boundary needs the
  **Edit workflow & policy** grant (project admin)."
- **Locked transition** — `cap-seg locked` with a `title` ("Completion is human-authorized in V1…"), the
  radios `disabled`, and a `locked · V1` chip on the row.
- **Boundary radios disabled** when `t.locked || !canManage || busy`.
- **Autonomy-exception note** — the terminal-boundary note names whether the full-autonomy + Direct
  exception is actually live on this project.
- **Guardrails — read-only note** — same `deny-note` shape.
- **Guardrail row — not in project.md** — neutral pill "not in project.md" when `!g.present`.
- **Guardrail row — unknown id** — neutral pill "nothing reads this", the row gets the `inert` class, and
  the only control is a Remove button.
- **Guardrail row — github kind** — read-only text "<on|off> · managed on Settings → GitHub".
- **Guardrail Apply disabled** unless the draft is a changed positive integer (`valueChanged`).

Intents: `set-role` (last-admin guard inside `setMemberRole`), `set-boundary` (review→terminal
hard-locked human inside `setTransitionBoundary`), `set-guardrail` (`op` = toggle / value / remove);
400 "Unknown action." otherwise.

Dialogs: `CapabilityMatrixModal`.

---

## 20. `/projects/:slug/github` — GitHub

Module: `app/routes/project.github.tsx`. Screen label: `GitHub`.

| Component | File |
| --- | --- |
| `GithubViewPage`, `RepositoryPanel`, `PullRequestsPanel`, `BranchesPanel` | `app/features/github/github-view.tsx` |
| `CredentialCard`, `RemoveCredentialDialog` | `app/features/github/credential-card.tsx` |
| pill maps | `app/features/github/github-pills.ts`, copy in `app/features/github/github-copy.ts` |
| query / actions | `app/features/github/github-query.server.ts`, `app/features/github/github-actions.server.ts` |
| credential redaction | `app/features/github/credential-visibility.server.ts` |

Loader guard: `requireProjectMember(..., "view this project's GitHub surface")` + 404. Loader-side
redaction: unless `credentialGrantHolder(db, slug, userId)`, the credential detail is stripped with
`withoutCredentialDetail` *before it reaches the browser*.
`canReconcile = roleCan(myRole, "reconcile-github")`; `canGrant = roleCan(myRole, "grant-github-scope")`.

States:

- **Freshness chip, four variants** — both checked and changed timestamps; `staleCache` (no change for
  over an hour, rendered with the alert icon and the `stale` class); change-only; and "no branch or PR
  change has been recorded yet".
- **Update status withheld** unless `canReconcile`; `disabled` while busy.
- **Open on GitHub withheld** when `data.project.repo` is null.
- **Connection probe note** — "Live repository probe. The stored project credential is shown below."
  rendered only when the probe and the stored credential disagree in provenance.
- **Credential card withheld** (not disabled) when `!canGrant`, replaced by a `pol-note`: "Credential
  details need the **Grant GitHub scope** grant (project admin or maintainer). The Connection row above
  still shows whether this repository is reachable."
- `CredentialCard`, five mutually exclusive states:
  1. **No credential** (`source === "none"`) — "No GitHub PAT is connected to this project. Branch and PR
     sync stays offline until one is added."
  2. **Token revoked/expired** (`connectionAuth`) — "Token <revoked|expired>. Re-authenticate this
     connection to resume branch and PR sync…"
  3. **Missing scope** — names the missing scope id and, when present, the flagged task as a `keybtn`.
  4. **Unverified** (`proven.length === 0`) — "Credential attached. Scopes not yet verified against
     GitHub… Run Grant scope to validate."
  5. **Healthy** — `cred-ok`, wording differs on whether unproven scopes remain ("Every provable scope
     verified." vs "All required scopes proven.").
  - Scope chips render only for *proven* verdicts; `assumed`/`unchecked` collapse to an "unproven
    (verified on first use)" line.
- **Pull requests empty** — "No pull requests yet. One is opened at the review boundary by the server or
  the delivering agent."
- **Branches empty** — an `empty sm` block.
- **Per-row pills** — PR state, checks, review and mergeable pills render only when the corresponding fact
  exists.

Dialogs: `RemoveCredentialDialog` (`role="alertdialog"`).

Intents (all through `requireFormAction` → `requireVisibleProject` → `assertProjectAction`):

| Intent | RBAC action |
| --- | --- |
| `reconcile` | `reconcile-github` ("reconcile with GitHub") |
| `grant-scope` | `grant-github-scope` ("re-check the credential") |
| `set-credential` / `clear-credential` | `grant-github-scope` ("change the credential") |
| anything else | 400 "Unknown action." |

All four enforce the archived read-only gate inside `assertProjectAction` (R8-5).

---

## 21. `/projects/:slug/activity` — Activity

Module: `app/routes/project.activity.tsx`. Screen label: `Activity`. Read-only (no action).

| Component | File |
| --- | --- |
| `ActivityPage`, `AuditLogs`, `AuditRow`, `FeedFilters` | `app/features/activity/activity-page.tsx` |
| grouping | `app/features/activity/feed-helpers.ts` |
| limits | `app/features/activity/feed-limits.ts` (`STREAM_STEP/MAX`, `AUDIT_STEP/MAX`, `clampFeedLimit`) |
| `DatePicker` | `app/ui/date-picker.tsx` |

Loader guard: `requireProjectMember(..., "view project activity")` + 404. Both panels are URL-driven:
`?stream=` / `?audit=` raise the limits; the stream filters are `sq`/`sac`/`sty`/`stk`/`sfrom`/`sto`; the
audit filters are `aq`/`aky`/`aac`/`atk`/`afrom`/`ato`. Every param is trimmed and length-bounded before
it reaches a LIKE clause; `aky` is validated against the four known kinds.

States:

- **Stream empty, two variants** — "No activity yet." (`stream.length === 0`) and "No events match this
  filter."
- **Audit empty** — "No policy or access events yet."
- **Stream count line** — "N of M events" plus " (filtered)" when the actor filter is not `all`.
- **Actor filter** — `role="group"` with `aria-pressed` (All / Humans / Agents / System), scoped to the
  Stream panel only.
- **Show older** — rendered only when `remaining > 0`; raises the loader limit by one step.
- **Capped** — "Showing the newest 200 events. Older activity stays in the task timelines." /
  "Showing the newest <AUDIT_MAX> entries."
- **FeedFilters Clear** — rendered only when at least one of the panel's params is set.
- **Time rendering** — `formatClock` after hydration, `formatClockUTC` during SSR.
- Filter dropdowns are populated from `streamFilterOptions` / `auditFilterActors` — values that actually
  occur, so a filter is a pick rather than a guess.

---

## 22. `/projects/:slug/settings` — Project settings

Module: `app/routes/project.settings.tsx`. Screen label: `Settings`.

| Component | File |
| --- | --- |
| `SettingsPage`, `ProjectPanel`, `StagesPanel`, `StageRow`, `AddStageControl`, `MembersPanel`, `RepoPanel`, `DangerZone`, `RepairRepoDialog`, `DeleteProjectDialog` | `app/features/project-settings/settings-page.tsx` |
| query / actions | `app/features/project-settings/settings-query.server.ts`, `app/features/project-settings/settings-actions.server.ts`, `app/features/project-settings/membership.server.ts` |
| `CredentialCard` | `app/features/github/credential-card.tsx` |
| `ConfirmDialog` | `app/ui/confirm-dialog.tsx` |

Loader guard: `requireProjectMember(..., "view this project's settings")` + 404 + the same loader-side
credential redaction as `/github`. Gates: `canEditPolicy = edit-policy`,
`canManageMembers = manage-members`, `canGrant = grant-github-scope` — each panel asks for its own action
id rather than a shared literal.

States:

- **Project panel read-only note** — `!canManage` renders a `pol-note`; every field carries `disabled`.
- **Stages — locked stage** — the entry and terminal stages render a lock icon, a `title` naming the
  reason (`stageLockReason`), the remove control `disabled` and marked `off`, and drag suppressed
  (`canDrag = canManage && !locked && !editing`).
- **Stage remove refused in the client** — clicking a locked stage's remove pushes an error toast
  "<stage> can't be removed: <reason>".
- **Add stage disabled** while the name is empty (`disabled` + `aria-disabled`).
- **Add stage withheld** unless `canManage`.
- **Stages foot note** — copy branches on `canManage` (what you can change vs who can).
- **Members — removed account** — `blocked` pill; **disabled account** — neutral pill.
- **Member remove withheld** unless `canManage`; the invite form is withheld too.
- **Repo panel — branch-cleanup checkbox disabled** for a role without the grant; the Repair control is
  hidden entirely (`canRepair = canEditPolicy`).
- **Repo panel read-only note** — a `pol-note` explaining the missing grant.
- **Credential card withheld** unless `canGrant` (same rule as `/github`).
- **Danger zone withheld entirely** unless `canEditPolicy` (owner ruling Q-V1: a read-only viewer must not
  see a destructive surface at all).
- **Danger zone in-between roles** — a `deny-note` plus `disabled` Archive/Delete buttons with a `title`
  ("Only a project admin can archive/delete this project") for a role holding some but not all lifecycle
  grants.

Dialogs:

- `RepairRepoDialog` (`aria-label="Repair repository"`) —
  - **Save disabled** unless the repo string is > 2 chars and, when `footprintTasks > 0`, the
    acknowledgement checkbox is ticked.
  - **Footprint acknowledgement** rendered only when `footprintTasks > 0`.
  - **Credential note, two variants** — verified against the attached credential, or "No credential is
    attached, so the new repository can't be verified until one is."
  - **Error** — rendered in place (no `role="alert"`; the shared action toast already announces it).
  - The dialog closes only on success; a probe refusal keeps it open.
- `DeleteProjectDialog` (`role="alertdialog"`) — the confirm button is `disabled` (and
  `pointer-events: none`) until the typed name matches the project name exactly.
- `ConfirmDialog` for stage and member removals.

Intents:

| Intent | Guard |
| --- | --- |
| `save-project` | `requireFormAction` → `requireVisibleProject` → `updateProjectIdentity` RBAC |
| `rename-stage`, `add-stage`, `remove-stage`, `reorder-stages` | same, each writer's own RBAC + the model stage locks |
| `invite`, `remove-member` | same, `manage-members` inside the writer |
| `repair-repo` | same; `confirmFootprint === "1"` required when the project has branch/PR records; the server probes the new repo and refuses a miss |
| `set-branch-cleanup` | same |
| `grant-scope` | `assertProjectAction(db, "grant-github-scope", …, "re-check the credential")` |
| `set-credential` / `clear-credential` | `assertProjectAction(db, "grant-github-scope", …, "change the credential")` |
| `archive-project` | `setProjectArchived` |
| `delete-project` | `deleteProject` with `confirmName`; answers `redirect("/")` |
| anything else | 400 "Unknown action." |
---

## 23. `/projects/:slug/tasks/:key` — Task detail

Module: `app/routes/project.task.tsx` (1174 lines — the largest route in the app). Screen labels:
`Task <KEY>` (the page) and `Task detail · not found` (the route's own `ErrorBoundary`).

| Component | File |
| --- | --- |
| `TaskDetailPage` | `app/features/task-detail/task-detail-page.tsx` |
| `TaskHero`, `DiagnosticsPanel`, `ExecutionSection` | `app/features/task-detail/task-main-sections.tsx` |
| `GithubTrace`, `TaskDetailsPanel`, `PolicyPanel`, `CurrentStatePanel` | `app/features/task-detail/task-side-panels.tsx` |
| `DecisionPacket`, `PacketArchiveConfirm`, `PacketDiscardConfirm`, `PacketCollisionConfirm` | `app/features/task-detail/decision-packet.tsx` |
| `OperatorRecommendations` | `app/features/task-detail/operator-recommendations.tsx` |
| `ExecutionProfile`, `OperatorRunControl`, `AgentRunControl`, `EngagedAgents`, `PendingSchedules`, `DelayPicker`, `PromptInput`, `OwnerControl` | `app/features/task-detail/execution-profile.tsx` |
| `ContinuityRecoveryPanel` | `app/features/task-detail/continuity-recovery.tsx` |
| `AttachmentsPanel`, `AttachmentImage`, `AttachmentLightbox(Provider)` | `app/features/task-detail/attachments-panel.tsx`, `attachment-image.tsx`, `attachment-lightbox.tsx` |
| `Timeline`, `TimelineItem`, `CollapsibleComment`, `EvidenceLabel` | `app/features/task-detail/timeline.tsx`, `timeline-slice.ts`, `event-meta.ts` |
| `CommentComposer`, mention plumbing | `app/features/task-detail/comment-composer.tsx`, `lexical-mention-plugin.tsx`, `mention-menu.tsx`, `mention-autocomplete.ts`, `use-mention-autocomplete.ts` |
| `AcceptConfirm`, `ArchiveConfirm`, `ReleaseConfirm` | `app/features/task-detail/accept-confirm.tsx`, `archive-confirm.tsx`, `release-confirm.tsx` |
| `AgentSelect` | `app/features/task-detail/agent-select.tsx` |
| page hooks | `app/features/task-detail/task-detail-hooks.ts` |
| `LiveRunPanel`, `AgentLogsPanel`, `ConsoleCode`, `SessionIdChip`, `AgentPicker` | `app/features/runtime/runs-panels.tsx` |
| run log stream / helpers | `app/features/runtime/use-run-log-stream.ts`, `runs-helpers.ts`, `log-clock.ts`, `log-noise.ts`, `runtime-types.ts` |
| `StageMenu`, `ConfirmDialog`, `DatePicker`, `LabelInput`, task-meta pills | `app/ui/*` |

Loader guards and loader-side withholding:

- `requireProjectMember` via the layout, plus this loader's own read; a missing task throws a 404 which
  the route's `ErrorBoundary` renders.
- **`runsVisible`** = project member OR org admin. When false, the run projection is rewritten in the
  loader to strip `sid`, `raw`, `lines`, `lineCount` and to report an empty `logWindow` — the sensitive
  material never reaches the browser.
- **Attachments** obey the same bar: a non-member gets `attachments: []`, `attachmentsTotal: 0`,
  `attachmentProducers: {}`.
- **Timeline** ships a bounded slice (`clampTimelineLimit` over `?events=`), with `timelineHasMore`,
  `timelineRemaining` and `timelineNextLimit`.
- **Run console window** is bounded (`RUN_LOG_WINDOW_*`); `logWindow` carries the cursor
  `/resources/run-log?before=` pages with.
- `canDeliver` = `run-agents` OR org admin OR (the viewer owns the task AND holds `own-task`).

Client-side role gates (`task-detail-page.tsx`, all through `roleCan`):
`canRunAgents` (`run-agents`), `canOwn` (`own-task`), `canEditGoal` (`update-goal`),
`canEditMeta` (`edit-task-meta`), `canArchiveViaPacket` (`approve-transition`),
`isOwner`, `canResolvePacket = canRunAgents || isOwner`, `canDecideOwned = canRunAgents || isOwner`,
`canEscalatePacket = isOwner && !canRunAgents`, `taskClosed`.

### Panel-by-panel states

**`TaskHero`**

- **Archived** — a neutral `archived` pill replaces the readiness pill entirely.
- **Terminal** (`archived || displayReadiness === "accepted" | "merged"`) — the validation pill is
  withdrawn (it asserts a live obligation nobody owes).
- **Goal chip** — rendered only when `task.goalRef` exists; links to the project controller.
- **Goal editor** — opens on the Edit button or on an `edit_goal` packet decision (`editGoalSignal`),
  prefilled from `editGoalDraft ?? task.goal`; Save is `disabled` while submitting or while the draft is
  under 3 characters; a failed save toasts rather than leaving the editor silently open.
- **Goal edit withheld** unless `canEditGoal`.

**`DiagnosticsPanel`** — returns `null` when `diagnostics.length === 0`.

**`GithubTrace`**

- **No branch and no PR** — `empty sm` "No branch yet. A task-key branch is created when execution
  starts." (the force-accept row can still render beneath it).
- **Branch collision** — a `Collision` row when `task.unownedPr !== null`: "PR #N holds this branch name
  but is not this task's review PR".
- **Diff row withheld** when `task.changed` is absent; **commit list withheld** when empty.
- **Deliver button** — rendered only when `canDeliver && !taskClosed` *and* no live PR stands
  (`!task.pr || state === "closed" | "merged"`); label flips to `Delivering…`.
- **Complete merge** — rendered only when `task.pr?.state === "accepted"`; opens the shared
  `AcceptConfirm` in `complete-merge` mode rather than merging on the bare click.
- **Force accept** — rendered only when a `forceAcceptReason` exists and the handler is passed; the label
  and `title` branch on `skipsStages = !acceptance.atBoundary` ("skips the remaining stages and the review
  gate" vs "override review gate").
- **Freshness rows** — "Checked" (last completed reconcile pass) and the cache-change stamp carry distinct
  tooltips; both are server-rendered so SSR and hydration cannot straddle a minute.
- **Open on GitHub** — rendered only when a href resolves (PR, else branch tree).

**`CurrentStatePanel`**

- **Stage control** — a `StageMenu` when `roleCan(role, "approve-transition")`, otherwise a static
  stage label.
- **Waiting on, three values** — "a human" (with an always-true tooltip pointing at the packet / stage
  control / acceptance action), "Agent work", "Nothing". Deliberately never personalised to "you".
- **Last activity** — the newest timeline event, or "Nothing on the timeline yet".
- **Owner — seated** — avatar + first name (+ " (you)"); the release ✕ renders only when
  `(ownerMine && canOwn) || canReleaseAnyOwner`.
- **Owner — unowned, assignable** — "Assign me" renders only when
  `canOwn && !archived && (!closed || canReleaseAnyOwner)`; `closed` = `displayReadiness` accepted or
  merged (ruling 118 / E32-9), so a closed task's seat is frozen below the admin tier.
- **Owner — otherwise** — the plain text "Unowned".
- **Quiet hint** — rendered when `task.quiet`; archived and terminal tasks never reach it.
- **Acceptance block** — rendered only when `acceptance.hasAuthority && !archived &&
  (acceptance.atBoundary || acceptance.blockedReason)`.
  - Accept button rendered only at the boundary; `disabled={!acceptance.canAccept || acceptBusy}`;
    busy label "Accepting · merging the review PR…".
  - `verdictSatisfiedBy` renders a hint naming the human whose GitHub approval cleared the gate.
  - `blockedReason` renders as **text** (not a `title`, which a disabled control can never show); the
    heading flips between "Acceptance is closed." (`terminallyBlocked`) and "Not acceptable yet.", and a
    terminal block with an open packet appends "The decision on this task carries the recovery paths."
- **Archive / Restore** — the whole block is withheld unless `canTransition`; label and hint flip on
  `archived`.

**`TaskDetailsPanel`**

- **Read mode** — priority renders as plain "Normal" or a `PriorityFlag`; labels as `LabelChips` (max 6)
  or "None"; due date as a `DueDatePill` or "None".
- **Edit button withheld** unless `canEdit`; on an archived task it is replaced by
  "Archived. Restore this task to edit its details."
- **Edit mode** — a `fetcher.Form` posting `set-task-metadata` (priority + labels + due date as one full
  replace); Save `disabled` while in flight; the panel closes on a successful round-trip.

**`PolicyPanel`** — the acceptance row reads `ownsTask` (R6-2 gives the owner acceptance authority
whatever their role) and `acceptanceAuthority` (whether this project's operator holds the full-autonomy +
direct-accept exception), and names the project's own review and terminal stages rather than the literals.

**`LiveRunPanel`** — rendered only when `runtime.length > 0`; Interrupt opens `ConfirmDialog`
("Interrupt this run?") rather than acting on the click, and is `disabled` while `interrupting`.

**`ContinuityRecoveryPanel`** — returns `null` when `deriveContinuityLoss` finds nothing. Otherwise a
`role="status" aria-live="polite"` line plus a status pill whose label carries the state
("re-anchored · recovered" when every agent recovered). Console access is passed only when `runsVisible`.

**`DecisionPacket`** — rendered only when `task.packet` exists.

- **Pill** — `blocked` or `input`, matching the packet kind.
- **Option refusal** — an option above the viewer's tier renders `aria-disabled`, dimmed, with the reason
  in the option *description* (not only the `title`).
- **Viewer cannot resolve at all** (`!canResolve`) — every option is marked inert and one card-level deny
  note names who can decide.
- **Every option forbidden** (`everyOptionForbidden`) — a `deny-note` explaining the contributor-owner
  can still answer with their own directive, plus a "Send to a maintainer" button when
  `onRequestMaintainer` is passed (`canEscalatePacket`).
- **Custom directive** — an extra radio ("Write your own directive") offered whenever `canResolve`;
  Confirm is `disabled` while its text is blank.
- **Destructive option tags** — an `archive_task` option with `deleteBranch` carries a `blocked` pill
  "deletes branch"; a recommended option carries "operator pick" / "recommended" depending on who raised
  the packet.
- **Confirm decision** — withheld entirely unless `canResolve`; a role refusal keeps the button focusable
  with `aria-disabled` + `aria-describedby` so the reason is reachable; transient/structural refusals use
  a real `disabled`.
- **Ask operator** — always rendered (commenting is app-wide); drops `@operator` into the composer.
- Nested ceremonies: `PacketArchiveConfirm`, `PacketDiscardConfirm`, `PacketCollisionConfirm`, each a
  `role="alertdialog"`; an acceptance-bearing resolution instead routes through the shared
  `AcceptConfirm` in `packet` mode.

**`OperatorRecommendations`** — returns `null` when the list is empty; Apply/Dismiss render only when
`canDecideOwned`, both `disabled` while busy. Dismiss opens `ConfirmDialog`
("Dismiss this recommendation?").

**`ExecutionProfile` / `ExecutionSection`**

- **Operator run control**
  - `hardOff = busy || disabled` where `disabled` is the closed-task predicate.
  - **Backend not configured** — a `sub` line: "<backend> isn't configured on this instance, so the
    operator can't run. Configure it, or switch the operator profile's backend."
  - **Full autonomy caption** — rendered only when `configuredAutonomy === "full" && !disabled`:
    "Full autonomy: this run can move the task and accept completion itself."
  - **Blocked reason** — rendered copy (open packet wins over the closed copy).
  - **Closed task** — "Task closed. Reopen it to run the operator. Mentioning `@operator` in a comment
    still runs it."
  - Label flips `Run operator` / `Schedule` / `Running…` with the delay picker.
- **Agent run control**
  - **No agents deployed** — "No agents deployed. Deploy one on the Agents page first."
  - **Run disabled** when busy, no agent selected, or the selected agent already has a live run on this
    task (`selectedRunning`); the `title` names which.
  - **Model unavailable** — a `deny-note` quoting the provider's sentence; informs, does not block.
  - A standing `sub xs dim` line discloses the dispatch-completion contract.
- **Engaged agents (ledger)** — **empty**: "None yet. The operator picks who runs at each stage[, or run
  one yourself above]" (the tail only when `canRunAgents`). A ghost row is drawn when the engagement
  outlived its deployed profile; Release is `disabled` while `releaseBusy` and only offered for supporting
  engagements.
- **`PendingSchedules`** — returns `null` when empty; each pending entry is cancellable through a confirm.

**`AgentLogsPanel`** (rendered only when `runtime.length > 0 && runsVisible`)

- **No runs** — "No agent runs yet. Runtime streams appear here once the operator engages a specialist."
- **Non-member substitute** — when `runtime.length > 0 && !runsVisible` the panel is replaced by a
  `panel` with the `empty sm` copy: "Raw agent output, wire envelopes and provider session ids are limited
  to project members. The run summary above is public to signed-in users."
- **Backend unavailable** — a status line naming the quota/rate-limit condition; a
  `Retry on <other backend>` button appears only when `onRetryBackend` is supplied, `disabled` while
  retrying.
- **`{ } raw` toggle** — `aria-pressed`; suppresses the telemetry fold and the tool/file chips.
- **Load older lines** — a `history` meta row rendered only when `older.hasMore`; label flips to
  "loading older lines…" while `older.loading`; the note shows `older.error` or "N earlier lines not
  loaded".
- **Follow** — a toggle re-armed by scrolling to the bottom; the console is `role="log" aria-live="off"`.
- **Stream error** — surfaced through `streamError`.

**`AttachmentsPanel`**

- **Empty and no browser-capable agent** — returns `null` (avoids an "Attachments (0)" panel on every
  task).
- **Empty with `browserExpected`** — an `empty` paragraph explaining what is absent and why.
- **Truncated** — "Showing the most recent N of M files." when `total > attachments.length`.
- Every attachment kind carries a Download button; non-previewable kinds get a no-preview note; images
  open in the in-app `AttachmentLightbox` (screen label `Attachment lightbox`).

**`Timeline`**

- **No events at all** — "No activity yet. This task hasn't started its operator loop."
- **Filter hides everything, `comment` tab** — "No comments in the loaded history. Switch to All, or load
  older events."
- **Filter hides everything, `important` tab** — "No important events in the loaded history. Switch to
  All, or load older events."
- **Show older** — rendered when `hasMore`, labelled "Show older events · N more"; raises `?events=`.
- **Composer** — always enabled, including on a terminal task (R7-6: a hint, not a lock); the send button
  is `disabled` while busy with `aria-busy`; a `composer-err` `role="alert"` carries a failed post; the
  foot states "Every project member can comment · @mentions route to agents" and the platform-correct
  send shortcut.
- The default filter comes from the viewer's `tlDefault` preference (`all` / `typed` / `comment`).

### Dialogs reachable from this route

| Dialog | File | Screen label / role |
| --- | --- | --- |
| `AcceptConfirm` | `app/features/task-detail/accept-confirm.tsx` | `Accept completion dialog` |
| `ArchiveConfirm` | `app/features/task-detail/archive-confirm.tsx` | `Archive task dialog` |
| `ReleaseConfirm` | `app/features/task-detail/release-confirm.tsx` | `Release ownership dialog` |
| `AttachmentLightbox` | `app/features/task-detail/attachment-lightbox.tsx` | `Attachment lightbox` |
| `PacketArchiveConfirm` / `PacketDiscardConfirm` / `PacketCollisionConfirm` | `app/features/task-detail/decision-packet.tsx` | `role="alertdialog"`, label passed per ceremony |
| `ConfirmDialog` (interrupt run, dismiss recommendation) | `app/ui/confirm-dialog.tsx` | — |
| `StageMenu` | `app/ui/stage-menu.tsx` | inline menu, not a dialog |

`AcceptConfirm` runs in six ceremony modes, selected by `confirmAccept.mode`: `accept`, `force`,
`complete-merge`, `apply-recommendation`, `packet`, `stage-move`. The `blockedReason` it shows differs
per mode:

- `force` → `task.blockReason ?? acceptance.blockedReason ??` the open-blocked-packet sentence;
- `complete-merge` → `null` (the acceptance already happened; quoting a stale refusal would misread);
- `packet` → `acceptance.blockedReasonViaPacket` (the packet resolution is what clears the open packet, so
  the open packet cannot also be the refusal);
- everything else → `acceptance.blockedReason`.

It also renders `noPullRequest = !task.pr && !noChanges` (the accept path auto-detects by re-probing the
branch), `noChanges` (a verified no-change completion accepts without a merge), `openPacketTitle`,
`atBoundary`, and `verdictSatisfiedBy`. Every confirmed click hands the caller its own **disclosure echo**
(ruling 88), which the intent then POSTs; a missing or half-filled echo is refused server-side.

### Intents

All go through `requireFormAction` (auth + CSRF + trusted origin) and then
`requireVisibleProject(db, slug, actor, "act on this project")` — placed *outside* the try so the refusal
stays a thrown 404, byte-identical to the unknown-slug body.

| Intent | Guard / notable refusals |
| --- | --- |
| `comment` | `commentToAgent`; toast branches seven ways: agent picking it up, `operatorRefused: "open-packet"`, `operatorRefused: "terminal-stage"`, `runNotStarted` with the reason, `runtimeDenied` ("your role can't trigger agent runs"), routed-to-agent, plain |
| `update-goal` | `updateTaskGoal` (`update-goal` grant) |
| `set-task-metadata` | `setTaskMetadata`; validates priority + due date, normalizes labels; a bad value throws before any write |
| `resolve-packet` | `resolvePacket`; a non-empty `custom` (≤ 4000 chars) resolves through the un-gated `custom` kind; run ids are snapshotted before/after so the toast reports what actually started; note capped at 2000 |
| `request-maintainer-decision` | `requestPacketMaintainerDecision`; refuses (with a pointer) if the caller could resolve it themselves |
| `complete-merge` | `completeTaskMerge`; reports "Not merged: <reason>" honestly |
| `accept-completion` | `transitionStage` into the terminal stage with `ack: acceptanceAck(formData)`; 400 "This project has no stages to accept into." when the project has no stages; a missing ack (`null`) is refused |
| `deliver-review` | `manualDeliverForReview` (maintainer+ or the task's owner, audited as `github.delivery.manual`); 409 "Delivery did not complete: <message>" |
| `archive-task` / `restore-task` | `setTaskArchived` (`approve-transition`) |
| `force-accept` | `forceAcceptCompletion` (admin only, audited); still demands the disclosure echo |
| `owner-take` | `setOwner` (`own-task`) |
| `owner-assign` | `setOwner` with a target user id |
| `owner-release` | `releaseOwner`; distinct toast when an admin releases someone else's seat (`forced`) |
| `transition` | `transitionStage` with `manual: true`; a move onto the **last** stage additionally carries `acceptanceAck` (it is an acceptance); a permitted same-stage post reports "<KEY> is already at <stage> · nothing changed" |
| `run-interrupt` | `interruptRun` (admin/maintainer); idempotent — "That run already finished · nothing to interrupt" |
| `run-agent` | validation "Pick an agent to run." when no `profileId`; "Keep the run prompt under 4000 characters."; `startAgentRun`; a supplied prompt is also appended as the human's own `@<agent>` timeline comment, *after* the start so a refused dispatch leaves no orphan |
| `release-agent` | `removeReviewer`; "That agent wasn't engaged" when nothing was released |
| `apply-recommendation` | `applyRecommendation` with `ack`; the ack is consulted only on the arms that accept |
| `dismiss-recommendation` | `dismissRecommendation` |
| `run-operator` | `requireRunAgents(db, runAgentsAuthority(db, slug), actor, "run the operator")`; backend and autonomy come from the deployed profile, never the request; an optional `steer` (≤ 2000) rides as the run's directive and is recorded as an `@operator` comment **only when the run was not refused**; the toast distinguishes `refused: "open-packet"`, `refused: "terminal-stage"`, `queued`, and running |
| `schedule-action` | `requireRunAgents(..., "schedule a run")`; validation "Schedule between 1 minute and 28 days out." (1 ≤ minutes ≤ 40320) and "Keep the run prompt under 4000 characters."; a `profileId` selects the agent arm, otherwise the operator re-runs |
| `cancel-schedule` | `requireRunAgents(..., "cancel a scheduled run")`; "That schedule was already resolved" when nothing was cancelled |
| anything else | 400 "Unknown action." |

### Route `ErrorBoundary`

Screen label `Task detail · not found`. Two states: 404 ("Task not found" / "<KEY> isn't in this project's
store yet.") and any other error ("Something went wrong" / "An unexpected error occurred loading this
task."), each with a "Back to board" link.
---

## 24. Shared UI primitives (`app/ui/`) — states other surfaces inherit

| Primitive | File | States it contributes |
| --- | --- | --- |
| `PageOverlay` | `app/ui/page-overlay.tsx` | Native `<dialog>` via `useDialog`; stamps `data-screen-label="<label> · overlay"`; used by `/profile` and `/notifications` |
| `ConfirmDialog` | `app/ui/confirm-dialog.tsx` | `role="alertdialog"`, outcome-naming confirm button, confirm `disabled` + `aria-disabled` while busy |
| `useDialog` | `app/ui/use-dialog.ts` | Escape close, backdrop-click close, focus trap/restore, animated close (`{ ref, close }`) |
| `useDismiss` | `app/ui/use-dismiss.ts` | Escape / outside-press dismissal for non-`<dialog>` popovers (bell, user menu use `outside: false`) |
| `ToastProvider` / `useToast` | `app/ui/toast.tsx` | The app's ONE announcer (`role="status" aria-live="polite" aria-atomic="false"`); kinds `success` / `error`; the region is removed from the a11y tree while empty |
| `useActionToast` / `useFetcherResult` | `app/ui/use-action-toast.ts`, `use-fetcher-result.ts` | Settle toasts on the server RESULT, never at submit time |
| `StageMenu` | `app/ui/stage-menu.tsx` | `aria-haspopup="menu"`, `aria-expanded`, `role="menu"` with `menuitemradio` children; the current stage is `disabled` and `aria-checked`; the trigger disables while `busy` |
| `PriorityFlag`, `LabelChips`, `DueDatePill` | `app/ui/task-meta.tsx` | Each returns `null` for a default value (`priority === "normal"`, empty labels, no due date) — so a plain task adds no chrome |
| `ReadinessPill`, `ValidationPill`, `Pill` | `app/ui/pill.tsx` | Colour never carries state alone — the label always does |
| `LocalRelative`, `LocalDayDotTime` | `app/ui/local-time.tsx` | Renders a non-breaking space for one frame, then fills in after hydration (SSR and hydration must not straddle a minute) |
| `DatePicker`, `Calendar` | `app/ui/date-picker.tsx`, `calendar.tsx` | The app's only date-entry control |
| `LabelInput` | `app/ui/label-input.tsx` | Token input with suggestions; used by the board's New-task modal and the task Details panel |
| `Markdown`, `RichText`, `mention-spans` | `app/ui/markdown.tsx`, `rich-text.tsx`, `mention-spans.ts` | Rendering of agent/controller prose and @mention chips |
| `SkipLink` | `app/ui/skip-link.tsx` | The bypass block on Home and the workspace shell (target is a sentinel *below* the topbar) |
| `CsrfInput` / `useCsrfToken` | `app/ui/csrf-input.tsx` | Every mutation form carries `_csrf` |
| `Avatar`, `initialsOf`, `Identity` | `app/ui/avatar.tsx`, `initials.ts`, `identity.tsx` | Person rendering |
| `rovingRadioKeyDown` | `app/ui/roving-radio.ts` | Arrow-key traversal for the `role="radiogroup"` controls on Policy |
| `useShortcutHint` / `useModifierHint` | `app/ui/use-shortcut-hint.ts` | Renders ⌘ vs Ctrl per the viewer's keyboard (`suppressHydrationWarning`) |
| `Icon` | `app/ui/icon.tsx` | The single icon set |

---

## 25. Index of every `data-screen-label`

| Label | File |
| --- | --- |
| `Home · project selection` | `app/features/home/home-page.tsx` |
| `Empty state` | `app/features/home/home-sections.tsx` |
| `Pinned projects` | `app/features/home/home-sections.tsx` |
| `All projects` | `app/features/home/home-sections.tsx` |
| `Archived projects` | `app/features/home/home-sections.tsx` |
| `Settings` (Home org tiles) | `app/features/home/home-sections.tsx` |
| `Store strip` | `app/features/home/home-sections.tsx` |
| `Project card · <name>` | `app/features/home/project-cards.tsx` |
| `Project row · <name>` | `app/features/home/project-cards.tsx` |
| `New project modal` | `app/features/home/new-project-modal.tsx` |
| `Login` | `app/routes/login.tsx` |
| `Login · set new password` | `app/routes/login.tsx` |
| `Instance settings` | `app/features/org-settings/org-settings-page.tsx` |
| `Settings · GitHub connections` | `app/features/org-settings/connections-panel.tsx` |
| `Settings · Users & access` | `app/features/org-settings/users-panel.tsx` |
| `Settings · Sign-in & SSO` | `app/features/org-settings/sso-panel.tsx` |
| `Settings · Agent resources` | `app/features/org-settings/resources-panel.tsx` |
| `Controller settings` | `app/features/org-settings/controller-admin-panel.tsx` |
| `<modal title>` (MiniModal, overridable via `screen`) | `app/features/org-settings/mini-modal.tsx` |
| `Files · <resource>` | `app/features/kb-browser/store-browser.tsx` |
| `Controller` | `app/features/controller/controller-page.tsx` |
| `Controller dock` | `app/features/controller/controller-dock.tsx` |
| `Command palette` | `app/features/shell/command-palette.tsx` |
| `Notifications popover` | `app/features/shell/top-bell.tsx` |
| `Notifications` | `app/features/notifications/notifications-page.tsx` |
| `Profile & preferences` | `app/features/profile/profile-page.tsx` |
| `<label> · overlay` (PageOverlay) | `app/ui/page-overlay.tsx` |
| `Board` | `app/features/board/board-page.tsx` |
| `Review queue` | `app/features/review/review-page.tsx` |
| `Agents` | `app/features/agents/agents-page.tsx` |
| `Policy` | `app/features/policy/policy-page.tsx` |
| `GitHub` | `app/features/github/github-view.tsx` |
| `Activity` | `app/features/activity/activity-page.tsx` |
| `Settings` (project) | `app/features/project-settings/settings-page.tsx` |
| `Task <KEY>` | `app/features/task-detail/task-detail-page.tsx` |
| `Task detail · not found` | `app/routes/project.task.tsx` |
| `Accept completion dialog` | `app/features/task-detail/accept-confirm.tsx` |
| `Archive task dialog` | `app/features/task-detail/archive-confirm.tsx` |
| `Release ownership dialog` | `app/features/task-detail/release-confirm.tsx` |
| `Attachment lightbox` | `app/features/task-detail/attachment-lightbox.tsx` |
| `<packet ceremony label>` (`screenLabel` prop) | `app/features/task-detail/decision-packet.tsx` |

The `Insights` page (`app/features/insights/insights-page.tsx`) is the one full-page surface that stamps
no `data-screen-label`.

---

## 26. Cross-cutting patterns observed

These recur across surfaces and are recorded here so the per-route sections do not repeat them.

**Refusal shape.** Every project-scoped route repeats the membership gate on its own loader (the
single-fetch `?_routes=` hole) and on its own action (React Router does not run a parent loader for a
child action). Both refuse with the byte-identical `No project at projects/<slug>.` 404 rather than a
403 that would confirm the project exists.

**CSRF.** `requireFormAction` (auth + CSRF + trusted origin) fronts the board, agents, policy, github,
settings and task actions. The fetcher-target routes (`/notifications/read`, `/prefs/theme`, `/profile`,
`/controller`, `/projects/:slug/controller`, `/resources/controller`) use `csrfError(...)` instead, which
returns a toast-shaped `{ ok:false, error }` — a thrown 403 there would replace the whole page with the
root error boundary.

**Withheld vs disabled.** The codebase applies both deliberately: a control the server would refuse for a
whole role is *withheld* (Danger zone, credential card, Re-scan, New profile, Assign me), while a control
that is refusable for a *state* is rendered `disabled` with the reason as **text** — never a `title`,
because a disabled control receives no pointer events.

**Empty states.** The house pattern is "absent → why it matters → next action" (recorded as D8/P16 in the
source comments); a bare "No X" appears only where a sibling column is already carrying the explanation.

**Toast honesty.** Success and failure branches always pass the toast kind explicitly, and every toast
settles on the server RESULT (`useFetcherResult` / `useActionToast`) rather than at submit time. There is
a co-located gate for this at `app/features/toast-honesty.test.ts`.

**Live updates.** `useLiveUpdates` (`app/features/live-updates/use-live-updates.ts`) subscribes to scopes
from `app/features/live-updates/event-types.ts`; a failed EventSource never retries, so `live.paused`
surfaces a retry pill on the topbar and Home header rather than freezing a stale snapshot silently.

**Acceptance disclosure (ruling 88).** Every path that can accept a completion — the board drop on the
terminal stage, the task page's Accept, a manual `transition` onto the last stage, `force-accept`,
`apply-recommendation` and `resolve-packet` — carries the confirming dialog's own echo of what it
displayed, parsed by the one shared definition in `app/shared/acceptance-disclosure.ts`. A missing or
half-filled echo reads as no echo and the server refuses.
