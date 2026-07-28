# UI + Routes code map (pass 15, 2026-07-28)

Scope: route inventory, feature ownership, design language, shared UI primitives, live updates, board, task detail, settings surfaces, KB/store/skill cluster. All paths repo-relative to `/Users/akinozer/projects/viberr`.

## Route inventory (app/routes.ts:3-51)

| Path | Module | Renders / behavior |
|---|---|---|
| `/` | routes/_index.tsx | Home landing (`HomePage`). Loader (routes/_index.tsx:42-58): user, greeting, project cards, home prefs, org summary, notifications(100), unread, `storeRoot` (raw `VIBERR_DATA_ROOT`). Action intents: `pin`, `view`, `rescan` (org-admin, single-flighted, routes/_index.tsx:87-120), `rebuild-projections` (org-admin, routes/_index.tsx:121-153), `create-project` (ANY signed-in member by pinned RBAC decision, routes/_index.tsx:154-180). |
| `/login` | routes/login.tsx | Two server-driven modes: `login` (providers + local creds) and `reset` (forced password reset) — routes/login.tsx:22-54. |
| `/logout` | routes/logout.tsx | POST-only sign-out (user menu form, features/shell/user-menu.tsx:187-193). |
| `/org/settings` | routes/org.settings.tsx | Org admin surface, `requireRole(request,"admin")` (routes/org.settings.tsx:71). ~35 action intents in one switch (see "Org settings" below). |
| `/api/auth/*` | routes/api.auth.$.ts | better-auth splat handler. |
| `/profile` | routes/profile.tsx | URL-addressable `PageOverlay` (native `<dialog>`); identity / notif routing / appearance / tl-default / password / GitHub-disconnect intents (routes/profile.tsx:72-123). Theme posts to `/prefs/theme` with settle-time toast + rollback (routes/profile.tsx:174-202). |
| `/notifications` | routes/notifications.tsx | PageOverlay; 200-row cap with explicit `truncated` flag (routes/notifications.tsx:35-48); row click navigates only when the notification carries `projectSlug`+`taskKey` (routes/notifications.tsx:105-109). |
| `/notifications/read` | routes/notifications.read.tsx | Fetcher-only action (`read` / `read-all`), no UI. |
| `/prefs/theme` | routes/prefs.theme.tsx | Fetcher-only theme cookie + users.theme action. |
| `/resources/events` | routes/resources.events.ts | The SSE stream (see "Live updates"). |
| `/resources/run-log` | routes/resources.run-log.ts | Log paging: `?since=` forward tail, `?before=&limit=` backward page; project-membership gated after run lookup (routes/resources.run-log.ts:61-69). |
| `/resources/health` | routes/resources.health.ts | Ops probe `{ok, projections, watcher}` — **no UI consumer**; deliberate ops-only endpoint. |
| `/resources/model-catalog` | routes/resources.model-catalog.ts | Model+effort catalog per backend; fetched by the agent create/edit modal (features/agents/create-profile-modal.tsx:859-866). |
| `/resources/session-export` | routes/resources.session-export.ts | Downloads a bash resume-installer for a run's provider transcript; membership-gated (routes/resources.session-export.ts:26-33); linked from the runs panel (features/runtime/runs-panels.tsx:305). |
| `/projects` | routes/projects.tsx | Redirect → `/` (home IS the project list, N5). |
| `/projects/:slug` | routes/project.tsx | Workspace shell layout (rail + topbar + `<Outlet/>`); index child redirects → `board` (routes/project._index.tsx:5-7). |
| `…/board` | routes/project.board.tsx | Board; data comes from the LAYOUT loader; actions `create-task`, `reorder` (drag/drop + honest "Accepted … — moved to Done" copy, routes/project.board.tsx:43-70), `rescan` (`rescan-project`, maintainer+, project-scoped, routes/project.board.tsx:71-81). |
| `…/review` | routes/project.review.tsx | Review queue; member-gated FIRST then 404 (WI-13, routes/project.review.tsx:28-32); ships RESOLVED stage names (UI-49) + acceptance-autonomy signal (P13-D-9). |
| `…/agents` | routes/project.agents.tsx | Agent governance: roster (org templates ⊕ project deployments), library picker, live deployments, stage graph for eligibility (R14-1, routes/project.agents.tsx:55-62), resource catalog, backend availability. Actions: create/deploy/update/delete-profile. |
| `…/policy` | routes/project.policy.tsx | Members+roles, workflow boundaries; actions `set-role`, `set-boundary` (routes/project.policy.tsx:41-66). |
| `…/github` | routes/project.github.tsx | Repository/PRs/branches panels; actions `reconcile` (`reconcile-github`), `grant-scope`/`set-credential`/`clear-credential` (`grant-github-scope`), archived gate enforced (routes/project.github.tsx:44-70). |
| `…/activity` | routes/project.activity.tsx | Stream + audit, bounded slices raised via `?stream=`/`?audit=` params (routes/project.activity.tsx:45-63). |
| `…/settings` | routes/project.settings.tsx | Project-admin surface; actions: identity, stage CRUD/reorder, invite/remove member, `repair-repo` (owner ruling 2026-07-26, routes/project.settings.tsx:133-144), credential set/clear/grant-scope, archive/delete project. |
| `…/tasks/:key` | routes/project.task.tsx | The full task workspace; ~24 action intents (see "Task detail"). Loader mixes projection + task FILE reads (recommendations/schedules/archived, routes/project.task.tsx:174-184). |

Reachability: every page route has a nav entry (rail: features/shell/nav.ts:20-28; overlays: user menu + bell; org settings: user menu admin-only at features/shell/user-menu.tsx:176-185 AND ungated Home tiles — see Suspect 1). Fetcher/data routes (`notifications/read`, `prefs/theme`, `resources/*`) are intentionally UI-less.

## Workspace shell (routes/project.tsx)

- Layout loader annotates every task with viewer-scoped `waitingOnMe` as the UNION of `decisionsRequiring` and the review queue's `ready` list (UI-48 fix, routes/project.tsx:61-77).
- `myRole` = membership role, else org-admin D2 override with an honest topbar pill (routes/project.tsx:87-88).
- Rail counts: board = ALL tasks incl. Done (ruling 16), review = tasks whose stage id equals `resolveStageRoles(...).reviewId` (routes/project.tsx:95-103), settings badge = open policy violations. NOTE the file-top comment still says review counts "the literal `review` stage" (routes/project.tsx:28-29) — code moved to structural resolution, comment did not.
- One SSE stream per tab: `project:` + `user`, plus `task:` when a task match is open (routes/project.tsx:128-132). Archived projects get a read-only banner pointing at "Settings → Danger zone" (routes/project.tsx:170-179).
- The shell (and the task page) require only `requireUser` — the board/task READ surface is app-wide by design (FR4); `review/agents/policy/github/activity/settings` require membership.

## Feature ownership (app/features/)

- `home/` Home page + project create; `shell/` rail, topbar, bell, user menu, nav model, route-pending bar, theme boot; `board/` board page + filters; `task-detail/` the task workspace (timeline, packet, recommendations, execution profile, archive/release confirms, mentions); `runtime/` run panels + log streaming (`use-run-log-stream.ts` — its own EventSource, NOT `useLiveUpdates`); `review/`, `activity/`, `github/`, `policy/`, `project-settings/`, `agents/` the six project views; `org-settings/` connections/users/resources panels + `mini-modal`; `kb-browser/` StoreBrowser + tree; `notifications/`, `profile/` overlay content; `live-updates/` SSE client.

## Design language (app/app.css, 3234 lines)

- **Tokens are NOT `--viberr-*`**: `grep -rn -- '--viberr-'` over `app/` and `design/` returns nothing. The real palette is unprefixed custom properties in `:root` (app.css:7-79): `--bg/--surface/--fg/--muted/--faint/--placeholder/--border/--ring/--hairline`, brand `--blue`+`--blue-pressed`+`--blue-soft`, AA-audited CTA pair `--cta-bg/--cta-fg` (app.css:33-45), `--success`, coral/rose/teal/orange/yellow/red accents, agent violet `--agent/--agent-dark/--agent-soft`, three font stacks, shadow + radius + layout tokens (`--rail-w: 232px`, `--topbar-h: 60px`). Any doc/memory referring to "--viberr-* tokens" describes an older or aspirational naming.
- Contrast ladders are engineered and commented in-place (P13-D-12, app.css:12-23 and 33-45).
- Motion vocabulary: one strong ease token `--ease-out: cubic-bezier(.23,1,.32,1)` (app.css:68-70); keyframes `pulse, dropPreviewIn, cardArrive, stagePulse, smPop, pulse-a, rise (toast), menu-in/menu-in-up, fade-in, pop-center (dialogs), livePulse, runSpin, caretBlink, spin, route-pending-slide` (app.css:330-3208). Reduced motion is two-layer: `@media (prefers-reduced-motion)` for board animations (app.css:725-730) plus the global `[data-motion="reduce"]` kill-switch stamped on `<html>` from the user pref (app.css:2112, root.tsx:126-127).
- Dark theme: `:root[data-theme="dark"]` overrides (app.css:2058-2107); SSR renders `data-theme` + a boot script (root.tsx:102-127).

## Shared UI primitives (app/ui/)

- `use-dialog.ts` — THE dialog pattern: native `<dialog>`+`showModal()`, returns `{ref, close}`; `close()` sets `[data-closing]`, waits for the dialog's own transitionend (descendant transitions filtered, app/ui/use-dialog.ts:54-59), then unmounts; `onDismissRequest` lets layered UIs (store browser's editor/new-folder) consume Escape/backdrop (app/ui/use-dialog.ts:88-108). Used by `PageOverlay` (app/ui/page-overlay.tsx:19), `MiniModal` (features/org-settings/mini-modal.tsx:36), StoreBrowser, confirms.
- `toast.tsx` — bottom-center stack, 2600 ms + 200 ms leave phase; host is a manual `popover` so it paints above `showModal()` top-layer dialogs (UI-34, app/ui/toast.tsx:82-97); `data-kind` success/error. Toast copy is computed SERVER-side in actions and pushed on the settled fetcher result (`use-action-toast.ts`, `use-fetcher-result.ts`) — never at submit time.
- `pill.tsx` — canonical readiness enum (ruling 1) + display states `accepted/merged`; **validation chip** values `healthy → "validation healthy"`, `changed → "awaiting verdict"` (owner-ruled label, app/ui/pill.tsx:92-96), `failing`, `none`.
- Others: `avatar/identity/initials` (human tone vs agent glyph), `icon.tsx`, `csrf-input.tsx` (`useCsrfToken` — every form ships `_csrf`), `markdown.tsx`/`rich-text.tsx`/`mention-spans.ts`, `stage-menu.tsx` (keyboard stage move, used by board + task detail), `toggle`, `skip-link` (UI-12), `use-relative-time`, `use-shortcut-hint`.

## Live updates

- Server: `GET /resources/events?scope=…` (routes/resources.events.ts). Scopes `user | projects | project:<slug> | task:<slug>/<key>`. Non-admin scope authorization expands `projects` to member projects and silently DROPS foreign explicit scopes, 403 only when nothing survives (routes/resources.events.ts:110-137). Backpressure cap 1024 chunks (routes/resources.events.ts:59, 148-153). `Last-Event-ID` resume.
- Client: `useLiveUpdates(scopes)` (features/live-updates/use-live-updates.ts) — revalidation IS the update mechanism (no optimistic governed state), 300 ms trailing debounce, `stream.open` ignored; failed EventSource → `paused` chip in topbar + bounded backoff reconnect [2s,5s,15s,30s] (use-live-updates.ts:47, 103-115).
- Run logs bypass this path: `use-run-log-stream.ts` opens its own EventSource and fetches lines from `/resources/run-log` on `run.log-appended` references (thin-event contract), seeded by the loader's bounded `logWindow` (P13-D-11).

## Board (features/board/board-page.tsx)

- URL-state only: `?filter=`, `?view=stage|list`, `?q=` (board-page.tsx:931-935); rail's Board link preserves them via `boardHref` (features/shell/nav.ts:57-65).
- HTML5 drag/drop with per-card midpoint insertion slot (`beforeKey`), cross-column count preview (+1/−1), drop preview card, arrival pulse; same-stage no-op detection (board-page.tsx:941-1024). Drop submits `reorder` — a stage change is a governed transition; into-Done is an ACCEPTANCE. Keyboard fallback: per-card "Move to stage" menu (F10-25, board-page.tsx:868-871).
- Gates mirror ACTION_ROLES ids, not role literals: `reorder-board`, `rescan-project` (routes/project.board.tsx:99-105). Orphan banner for tasks whose stage id no longer exists.

## Task detail (features/task-detail/task-detail-page.tsx:1473-1648)

Main column order: `TaskHero` (key/title/stage/readiness/**ValidationPill** meta + editable goal) → `LiveRunPanel` (when runs exist) → `DiagnosticsPanel` → `DecisionPacket` (open packet only; option-index resolve; optional note ≤2000 chars; retry toast verified against actual new run ids, routes/project.task.tsx:316-361) → `RecommendationsSection` (supervised-operator cards, Apply/Dismiss) → `ScheduledActions` (pending operator re-runs, cancellable) → `ExecutionSection` (owner control + delivering specialist + reviewer engagements; per-engagement run gating F10-04) → `AgentLogsPanel` (member-only; non-members get an honest gate notice, task-detail-page.tsx:1563-1575) → `Timeline` (All / Important events / Comments filters, `?events=` progressive disclosure, @-mention composer with pixel-aligned highlight backdrop, features/task-detail/timeline.tsx:40-74). Side column: `GithubTrace` (with `reconciledAt` freshness cue, UI-57) → `CurrentStatePanel` (stage dropdown, acceptance affordance from the SAME server predicate as the review queue, P14-LV-06; archive/restore R14-3) → `PolicyPanel`. Confirms: `ArchiveConfirm`, `ReleaseConfirm`.
- Authority derivation is intricate: `canResolvePacket = run-agents ∨ owner(with own-task)`, `canDecideOwned` same, `canArchiveViaPacket = approve-transition` (task-detail-page.tsx:1361-1385).
- Loader membership split (UI-30): non-members get run SUMMARIES with `lines/raw/sid` stripped and an empty logWindow (routes/project.task.tsx:123-149).

## Settings surfaces

**Org settings** (`/org/settings`, tabs ride `?tab=`, org-settings-page.tsx:15-25): Connections (PAT add/replace/default/remove), Users & access (role/edit/reset-password/remove/disable/enable, invite via github/google/domain/local, temp-password return), Agent resources: KB / MCP / Skills / global Agent templates panels + the StoreBrowser intents (`store-upload/write-doc/read-doc/mkdir/delete/import-github`, routes/org.settings.tsx:329-441). Resources tab badge counts kbs+mcps+skills+gagents together (org-settings-page.tsx:37-42).

**Project settings** (settings-page.tsx): `ProjectPanel` (identity) → `StagesPanel` (rename/add/remove/reorder) → `MembersPanel` (invite/remove; roles are edited on the Policy page) → `RepoPanel` + `RepairRepoDialog` (server-probed repo correction, confirmFootprint) → `DangerZone` (archive/restore, name-confirmed delete).

## KB editor / store browser / New-skill

- KB row copy is honest about injection: "N docs agents read · M non-text files skipped" (P14-KM-13, resources-panel.tsx:913-927); Browse opens StoreBrowser, Re-scan refreshes count.
- StoreBrowser (features/kb-browser/store-browser.tsx:875-1227): tree + destination-folder picker (`dest`, P14-KM-08) driving Upload files / Upload folder / New folder / New document / **Add from GitHub** (single-file or repo-folder snapshot import into the browsed folder). In-place doc editor (`store-read-doc`/`store-write-doc`) with overwrite confirm (P14-UI-59) and layered Escape (editor > new-folder row > dialog, store-browser.tsx:968-985). Dot-files are never stored; skipped counts reported both client- and server-side (routes/org.settings.tsx:344-366).
- New-skill entry point (resources-panel.tsx:316-478): ONE modal, two content modes — "Write SKILL.md" (name+summary+body) or "Start from files" (creates empty folder, opens StoreBrowser; summary later harvested from SKILL.md frontmatter `description:`; upload capture toast at routes/org.settings.tsx:368-374). Edit mode: classic editor only; emptying the body sends explicit `clearBody` (P13-KM-18).
- StoreBrowser takes an `action` prop defaulting to `"/org/settings"` (store-browser.tsx:882) but the only production mount is org settings — the parameterization is currently speculative.

## Suspect areas

1. **Home's Settings panel offers admin-only links to everyone.** `SettingsPanel` renders unconditionally (home-page.tsx:1565) with three "Manage →" tiles into `/org/settings?tab=…` (home-page.tsx:1236-1307), but the route hard-requires org `admin` (routes/org.settings.tsx:71). The user menu gets this right (admin-gated, user-menu.tsx:176-185). A plain member clicking Manage hits the 403 boundary. Also the org summary itself (user counts+avatars, connection owners, resource counts from `getHomeOrgSummary`) is served to every signed-in user (routes/_index.tsx:53) — worth confirming that's intended.
2. **Stale rail-count comment.** routes/project.tsx:28-29 says review counts "tasks in the literal `review` stage" while the code resolves the structural review stage via `resolveStageRoles` (routes/project.tsx:95-103). Comment/code disagreement on a governed count.
3. **Notification rows without a task target are dead clicks.** `openItem` only navigates when both `projectSlug` and `taskKey` exist (routes/notifications.tsx:105-109); any notification category that isn't task-anchored renders a clickable-looking row that does nothing (no cursor/affordance differentiation observed in the route layer).
4. **`storeRoot` (server filesystem path) ships to every signed-in user** (routes/_index.tsx:56) for the New-project modal's "creates {storeRoot}/projects/{slug}/" hint (home-page.tsx:596). Harmless in a side project, but it leaks the host layout to non-admins while store maintenance buttons are admin-gated (home-page.tsx:1326-1328).
5. **Rescan tiering differs by surface.** Home `rescan` (whole store) is org-admin-only (routes/_index.tsx:87-100) while the board `rescan` is `rescan-project` maintainer+ (routes/project.board.tsx:71-81); the `_index` comment calls these "consistent" (routes/_index.tsx:90-92) though they gate different roles — deliberate (D7) but easy to misread as drift.
6. **Two half-generalized props.** StoreBrowser's `action` prop (store-browser.tsx:882-890) and `metaTail` have a single caller; nothing project-scoped mounts the browser, so project-level KB browsing appears unbuilt rather than wired elsewhere.
7. **Task page readable app-wide vs. member-gated everything else.** `/projects/:slug` layout + board + task detail need only `requireUser` (routes/project.tsx:39-45, routes/project.task.tsx:91-99), so any signed-in user can enumerate any project's board and read timelines/comments, while `review/activity/…` refuse non-members specifically so they "must not learn a project exists" (routes/project.review.tsx:27, WI-13). The two goals are in tension; the board leaks existence + task content that the WI-13 guard elsewhere protects.
8. **Inline style off-pattern.** The rail's violations badge colors via inline `style={{color:"var(--coral-dark)"}}` (rail.tsx:76-79) and SkillModal's radiogroup uses inline flex styles (resources-panel.tsx:401) — small, but the codebase otherwise keeps styling in app.css.
9. **Copy inconsistency, minor**: the org-settings "Agent resources" tab badge sums resources AND agent templates (org-settings-page.tsx:40-41) while the Home tile presents "N agent profiles · +operator" separately from the KB/MCP/skill counts (home-page.tsx:1293-1300) — the same concept is counted two different ways one click apart.

## Open questions

1. Should the Home Settings/org tiles be hidden (or rendered read-only) for non-admin members, matching the user menu's gate — or should `/org/settings` gain a read-only member view?
2. Is app-wide task/board readability (FR4) still wanted now that WI-13-style "don't reveal project existence" guards exist on sibling routes? If yes, should the review/activity 403 copy stop implying secrecy?
3. Notifications not anchored to a task: what should a row click do (open the project? mark read only?), and should un-navigable rows look non-interactive?
4. Should project members ever browse a KB/skill store from inside a project (StoreBrowser's `action` prop suggests it was anticipated) — or is resource authoring permanently org-admin-only?
5. The resources tab badge: count resources only, or resources+agent templates? Pick one framing for both Home tile and tab badge.
6. `/resources/health` is unauthenticated-shape ops surface (routes/resources.health.ts) — confirm it stays out of the UI and whether it needs auth in deployment.
7. Naming: memory/docs reference `--viberr-*` design tokens, but app.css owns unprefixed tokens. Rename the tokens or retire the `--viberr-*` phrasing so future Codex cleanup passes target the real names?
