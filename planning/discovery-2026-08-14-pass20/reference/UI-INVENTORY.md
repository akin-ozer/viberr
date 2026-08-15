# UI-INVENTORY — Viberr current state (pass 20)

> Verified against `main @b97ad02` on 2026-08-14 (pass 20).
> Supersedes `planning/discovery-2026-08-06-pass19/reference/UI-INVENTORY.md`.
> Every line/anchor below was re-read at HEAD — the pass-19 doc was anchored to
> `65063b8` (the pass-18 MERGE), so most of its line numbers were already stale
> the day it was written. See §7 for the specific corrections.

Every route, the shell, the design-token discipline, and the UI that landed in
the twelve commits since the pass-19 merge (`4184e95`).

Route table: `app/routes.ts` (**59 lines**, React Router 7 `RouteConfig`) —
**one route added** since pass 19 (`task-attachment.ts`, R19-19). Everything
else in the table is unchanged.

---

## 1. Routes → features

`L` = exports `loader`, `A` = exports `action`. "Server modules" names the
query/action layer the route delegates to (not the full import list).

| `routes.ts` | URL | Module | L/A | Renders / server modules |
| --- | --- | --- | --- | --- |
| :4 | `/` (index) | `routes/_index.tsx` (224) | L A | Home — project list, greeting, `StoreStrip`, bell · `home-query.server`, `project-create.server`, `rescan.server`, `rebuild.server`, `data-root-lock.server`. Action intents: `pin`, `view`, `rescan`, `rebuild-projections`, `create-project` |
| :5 | `/login` | `routes/login.tsx` (600) | L A | Login (local-first; OAuth provider buttons at :277/:306) · `login.server`, **`oauth-providers.server`** (R19-16 — was `env.server`) |
| :6 | `/logout` | `routes/logout.tsx` (38) | L A | Logout action (loader redirects) |
| :9 | `/org/settings` | `routes/org.settings.tsx` (559) | L A | Tabbed org settings, admin-only · `org-view.server`, `connections.server`, `org-users.server`, `resources.server`, `store-files.server`, `gagents.server`, **`oauth-providers.server` + `oauth-credential-test.server`** (R19-16). 35 action intents incl. the four new `oauth-save` / `oauth-test` / `oauth-toggle` / `oauth-remove` (:311-381) |
| :13 | `/api/auth/*` | `routes/api.auth.$.ts` (17) | L A | better-auth handler (no UI) |
| :16 | `/profile` | `routes/profile.tsx` (222) | L A | Profile overlay · `profile-query.server`, `profile-actions.server`. Intents: `identity`, `set-notif`, `set-motion`, `set-tl-default`, `change-password`, `github-disconnect` |
| :17 | `/notifications` | `routes/notifications.tsx` (126) | L | Full notifications page · `notifications.server` |
| :19 | `/notifications/read` | `routes/notifications.read.tsx` (50) | L A | Mark-read fetcher (no UI) |
| :20 | `/prefs/theme` | `routes/prefs.theme.tsx` (45) | L A | Theme cookie action + `headers` export (no UI) |
| :22 | `/resources/events` | `routes/resources.events.ts` (187) | L | SSE stream · `sse-broker.server` (no UI) |
| :25 | `/resources/run-log` | `routes/resources.run-log.ts` (88) | L | Run-log tail · `run-service.server`, `run-store.server` (no UI) |
| :27 | `/resources/health` | `routes/resources.health.ts` (136) | L | Ops health probe (+ F18-5 lock holder, `disk-space`, `maintenance`) |
| :30 | `/resources/search` | `routes/resources.search.ts` (25) | L | ⌘K palette query · `command-search.server` (no UI) |
| :33 | `/resources/model-catalog` | `routes/resources.model-catalog.ts` (25) | L | Model/effort catalog (no UI) |
| :36 | `/resources/session-export` | `routes/resources.session-export.ts` (75) | L | Session-export bash installer download (no UI) |
| **:40-43** | **`/projects/:slug/tasks/:key/attachments/:file`** | **`routes/task-attachment.ts` (71)** | **L** | **NEW (R19-19)** — serves one browser-produced attachment as raw bytes. Deliberately OUTSIDE the workspace layout. `requireUser` + `requireProjectMember(…, "view task attachments")`, `resolveTaskAttachment` (traversal → plain 404), 50 MB cap → 413, `nosniff` + `content-security-policy: sandbox; default-src 'none'`, HTML/SVG never inline |
| :46 | `/projects` | `routes/projects.tsx` (9) | L | Alias → Home (N5, not a 404) |
| :48 | `/projects/:slug` | `routes/project.tsx` (286) | L | **Layout route**: workspace shell (rail + topbar) · `board-query.server`, `decisions.server`, `policy-violations.server`, `review-queue.server`, `notifications.server`. Also exports `ArchivedBanner` (:165) |

Nested children of `/projects/:slug` (rendered in `project.tsx`'s `<Outlet>`):

| `routes.ts` | Path | Module | L/A | Server modules / action intents |
| --- | --- | --- | --- | --- |
| :49 | index | `project._index.tsx` (7) | L | Redirect to the default project view |
| :50 | `board` | `project.board.tsx` (126) | A | dnd-kit board · `task-actions.server`, `project-authority.server`, `rescan.server`. Intents: `create-task`, `reorder`, `rescan` (the loader lives on the layout) |
| :51 | `review` | `project.review.tsx` (72) | L | Review queue · `review-queue.server`, `review-acceptance-authority.server` |
| :52 | `agents` | `project.agents.tsx` (215) | L A | Agents (profiles, grants) · `agents-query.server`, `agent-profile-actions.server`, `agent-deployments.server`, `resource-catalog.server`. Intents: `create-profile`, `deploy-profile`, `update-profile`, `delete-profile` |
| :53 | `policy` | `project.policy.tsx` (95) | L A | Policy (RBAC table, workflow) · `policy-query.server`, `policy-actions.server`. Intents: `set-role`, `set-boundary` |
| :54 | `github` | `project.github.tsx` (224) | L A | GitHub (connection, PRs) · `github-query.server`, `github-actions.server`, `freshness-policy.server`, `audit-query.server`. Intents: `reconcile`, `grant-scope`, `set-credential`, `clear-credential` |
| :55 | `activity` | `project.activity.tsx` (81) | L | Activity feed · `activity-feed.server` |
| :56 | `settings` | `project.settings.tsx` (225) | L A | Project settings · `settings-query.server`, `settings-actions.server`, `github-actions.server`. 13 intents from `save-project` to `delete-project` |
| :57 | `tasks/:key` | `project.task.tsx` (949) | L A | Task detail · the largest route: `task-query.server`, `task-writer.server`, **`task-attachments.server`** (R19-19), `specialist-run.server`, `operator-run.server`, `run-service.server`, `operator-actions.server`, `schedule.server`, `mention-suggestions.server`, `provenance-query.server`. 24 intents (`comment` … `cancel-schedule`). **Has an `ErrorBoundary` (:922)** |

**`project.tsx` still has no `ErrorBoundary` export** — a 404 under it bubbles to
the root boundary (`app/root.tsx:178`, `.app-splash` at :200).

---

## 2. The shell (`app/features/shell/`, `app/features/notifications/`)

- **`rail.tsx` (86)** — `Rail`, the left `<nav aria-label="Primary">` (:32).
  Project switcher `Link` → `/` (:33-44), `WORKSPACE_NAV` items (`nav.ts`) as
  `Link`s with `aria-current` from `activeView` (:46+), live count badges on
  `board` (`boardCount`), `review` (`reviewCount`), `settings` (`violations`,
  only when >0).
- **`topbar.tsx` (197)** — `Topbar`: rail toggle (mobile, `aria-label="Project
  navigation"` :98), brand → Home, breadcrumb `<nav aria-label="Breadcrumb">`
  (:116), the **org-admin override pill** (:155 carries the full sentence in
  `aria-label`, UXA-13), the **livePaused "live updates paused — retry" pill**
  (:163), the search button (:181) opening `CommandPalette` (:194),
  `<TopBell>` (:192), `<UserMenu>` (:193).
- **`top-bell.tsx` (202)** — `TopBell`: bell button + declarative non-modal
  `<dialog open>` popover (:127), `BELL_LIST_CAP = 100` (:29, cap notice at
  :159), mark-all-read, `.bell-badge` pulse keyed on `unread` (:195). Shared by
  the workspace topbar AND Home.
- **`notifications/notification-item.tsx` (68)** — the shared `.ntf-item` row
  for both the bell popover and `/notifications`; `orphaned` class at :48,
  `aria-disabled` at :54 (F18-1).
- Also: `command-palette.tsx` (233), `user-menu.tsx` (208),
  `route-pending-bar.tsx` (63).

---

## 3. Design-token discipline

- **ONE stylesheet** `app/app.css` — **4218 lines** (was 4014 at the pass-19
  merge; +204 across P19-RC1, R19-17/18 and R19-19). Integrity gate
  `app/app.css.test.ts` — **2381 lines, ~81 assertions** (the pass-19 doc's
  "1006 lines" was wrong even at pass 18). **No Tailwind**; icons are inline SVG
  paths (`app/ui/icon.tsx`), styling is hand-authored CSS with custom-property
  tokens.
- **Unprefixed tokens**: `--bg`, `--fg`, `--blue`, `--muted`, `--surface`,
  `--faint`, `--placeholder`, `--coral-*`, `--teal-dark`, `--hairline`,
  `--border`, `--font-mono`, `--font-body`, `--cta-bg`. No `--viberr-*` layer,
  no Tailwind utility layer — both long gone.
- **`app.css.test.ts` gates (anchors re-verified at HEAD, all unchanged)**:
  - Token resolution — `describe` at **:110**, `undefinedTokens === []` at :118.
  - Focus ring — **:177**, one app-wide `:where(…):focus-visible` outline.
  - **WCAG AA contrast gate** — **:426**, `AA_SMALL_TEXT = 4.5` at :427.
  - **No-allowlist whole-tree class scan** — **:602**; every class used in
    markup must have a rule, and the inline-styling budget holds at **20 sites**
    (:1138/:1142).
  - **R19-12 additions the pass-19 doc never listed**: "every pair it paints
    clears WCAG AA, in both themes" (**:1773**, with the `RENDERED_INSIDE`
    nesting map at **:1542** — this is what lets the console's literal-hex
    palette be measured against `.console`'s own near-black fill rather than
    `--bg`), "hides no control at any width" (**:2207**), "gates no rendering on
    the viewport" (**:2341**).
- New class families this pass, all registered in the gates: `.log-chip`
  (:4040), `.log-file`/`.lf-*` (:4061-4075), `.log-code`/`.lk-*` (:4080-4115),
  `.log-line.tstep` (:4032), `.rsrc-err` (:4124), `.stat-dot.warming` +
  `@keyframes warmPulse` (:4149-4152), `.attach-grid`/`.attach-thumb`/
  `.attach-file` (:4159-4213), `.tl-card .ev-row .ev-file` (:4217).

---

## 4. Pass-18 / pass-19 UI fixes still in force (re-anchored at HEAD)

Kept because later agents cite them; **every line number below is new** — the
pass-19 doc's anchors were taken at `65063b8` and the pass-19 merge moved most
of them.

| Fix | Where it lives NOW |
| --- | --- |
| **F18-13** terminal task withdraws force-accept | `task-detail/task-side-panels.tsx` — `GithubTrace` at **:19**, `isTerminal` **:100**, `forceAcceptReason` **:102**, `forceAcceptRow` **:119** (rendered at :155 and :331) |
| **F18-12** mobile profile grid stacks | `app.css` — base `.profile-grid` **:1165**, mobile override **:2956** |
| **F18-3** OAuth affordances key off configured providers | `profile/profile-page.tsx` — `githubConfigured` prop **:46**, `ProfileGithub` **:516**, `showConnectAffordance` **:535**, branch **:599**. Allow-access modal: `users-panel.tsx` `InviteModal` **:59**, `defaultIdp` **:73**. **Now fed by R19-16's live resolution**, not env vars (§5) |
| **F18-4** KB "folder missing" honesty | `org-settings/resource-rows.tsx` — `kb.folderExists` **:67**, copy **:86-90** |
| **F18-1** orphaned notifications drop out | `notifications/notification-item.tsx` **:22-55**; server side unchanged (`projections/notifications.server.ts`) |
| **F18-5b** Home lock-holder strip | `_index.tsx` `lockHolder` **:66-74**; `home/home-sections.tsx` `StoreStrip` **:533**, admin gate **:552**, "Writer: pid …" **:573** |
| **F18-6** ghost-admin members | `users-panel.tsx` inline `.cred-warn` refusals at **:317** and **:519** |
| **B1** board acceptance asks first | `board/board-page.tsx` — rationale comment **:791-792**, `AcceptOnBoardConfirm` **:824**, `pendingAccept` state **:1505**, stale-task guard **:1673-1688** |
| **UXA-2** one PR-state colour map | `review/review-page.tsx` — `prStatePill` imported **:6**, used **:87** and **:91** |
| **UXA-1** honest comment scope | `task-detail/timeline.tsx` **:435** |
| **UXO-1** archived task drops live pills | `task-detail/task-main-sections.tsx` — `archived` prop **:88/:98**, banner **:153**, `!archived &&` guards **:172** and **:180** |
| **LV-F1** pending reset keeps the re-issue action | `users-panel.tsx` — rationale **:455**, banner **:468**, relabelled button **:492** |
| **LV-F2 / UXA-3** read-only Settings explains itself | `project-settings/settings-page.tsx` — `.pol-note` at **:110** (Project), **:775**/**:883**/**:992** (Stages/Members), **:1173** (RepoPanel) |
| **Q-V1** Danger zone hidden without lifecycle rights | `settings-page.tsx` — `canEditPolicy` **:1483**, gate **:1649-1650**, `DangerZone` **:1344**. **PAT half still open** — see §6 |
| **UXA-4** ARIA state on pick-chips / capability seg | `agents/create-profile-modal.tsx`, `board-page.tsx`, `home/new-project-modal.tsx`, `org-settings/agent-template-modal.tsx` |
| **UXA-7** roving radiogroups | `ui/roving-radio.ts`; adopted at `policy/policy-page.tsx` **:162-164** and **:478-480** |
| **UXA-5** SSR-safe notification day buckets | `notifications/notifications-page.tsx` (`useHydrated` from `~/ui/local-time`) |
| **UXA-6** one name for the delivering agent | `task-detail/operator-recommendations.tsx` (`KIND_LABEL.assign_specialist`) |
| **UXA-15** Agents page explains read-only | `agents/agents-page.tsx` **:1260** |
| **UXA-8** wide tables scroll | `app.css` **:4011** (`.gh-table, .live-wrap { overflow-x: auto }`) |
| **UXA-9** disabled Save says what is missing | `org-settings/mini-modal.tsx` — `unmetHint` **:22/:35**, default line **:69** |
| **UXA-10/11/12/14** copy fixes | `profile-page.tsx` **:196**/**:212**; `connections-panel.tsx`; `routes/login.tsx`; `task-main-sections.tsx` **:220** |
| **UXA-16** viewer-local policy stamp | `policy/policy-page.tsx` **:595** (`<LocalDayDotTime iso={data.edited.at} />`) |

---

## 5. What landed since pass 19 (12 commits, `4184e95..b97ad02`)

Four of the twelve are Dockerfile-only (`a1ceb78`, `fa773e0`, `876aff0`,
`b97ad02`) and touch no UI. The rest:

### 5.1 Public-repo import without a connection (`881a4e1`)

`app/features/kb-browser/store-browser.tsx` — the `StoreBrowser` modal's GitHub
import bar. The **UI did not change shape**; what changed is that the
pre-request gate ("No GitHub connection with a validated token — add one under
GitHub connections first") is gone. `importGithubSnapshot` now runs anonymously
when the org has no connection and uses the default connection when there is
one. The `.cred-warn` under the import bar still renders refusals, but only the
two a missing credential actually explains (anonymous 404 on the repo; anonymous
403/429 rate limit), each naming its repair. Module doc rewritten at
`store-browser.tsx:34-44`. Server: `app/server/org/store-files.server.ts`,
`app/server/github/github-client.server.ts` (`token: string | null`, no
`Authorization` header when null).

### 5.2 Sign-in & SSO configured in-app — R19-16 (`affdaed`)

**A fourth org-settings tab.** `app/features/org-settings/org-settings-page.tsx`:
`OrgSettingsTab` is now `"connections" | "users" | "sso" | "resources"`; the tab
row is `SETTINGS_TABS` with `{ id: "sso", label: "Sign-in & SSO", icon: "lock" }`
sitting between Users and Agent resources. `resolveOrgTab` accepts `?tab=sso`.
The tab badge counts **live** methods (`view.authProviders.filter(p => p.active)`),
not configured rows.

**New pane** `app/features/org-settings/sso-panel.tsx` (361 lines):
- `SsoPanel` (:188) — a `.panel` with `data-screen-label="Settings — Sign-in &
  SSO"`, a `.pol-note` header stating how many methods are live and that app
  credentials override the deployment env (:207-222), then one `.conn-row` per
  provider (:229+) with: source line (`Configured here` / `From this
  deployment's environment — set credentials here to take it over` / `Not
  configured`), `proved <date>`, the **copyable callback URL**, the limit of the
  proof, a `live`/`off` pill plus a `not tested` pill, and the four actions
  **Set up / Update credentials**, **Test**, **Turn on / Turn off** (disabled
  with a title until a test passes), **Remove** (`.stg-x` → `ConfirmDelete`).
- `ProviderModal` (:47) — a `MiniModal` with client ID + client secret
  (`type="password"`, `autoComplete="off"`), `footHint="saving never switches
  sign-in on — test the pair first"`; on an existing provider the secret may be
  left blank to keep the stored value.
- `CallbackUrl` (:160) — copy button with a clipboard-denied fallback.
- `PROVIDER_META` (:32) names where to create the OAuth app per provider.

Route wiring: `app/routes/org.settings.tsx` loader now also returns
`callbackOrigin` (`new URL(request.url).origin`, computed server-side so SSR and
hydration agree); four action intents `oauth-save` / `oauth-test` /
`oauth-toggle` / `oauth-remove` delegating to
`app/server/auth/oauth-providers.server.ts` and
`app/server/auth/oauth-credential-test.server.ts`.

**Downstream surfaces now resolve through the same function the auth handler
uses** — no surface can advertise a method the handler would refuse:
- `app/routes/login.tsx` loader `providers` = `resolveOAuthProvider(getDb(), …)
  .credentials !== null` (was `getEnv()`), driving the disabled Continue-with
  buttons at :277 and :306.
- `app/server/org/org-view.server.ts` — new `AuthProviderView` (:59) and
  `authProviders` (:112); the legacy `providers: { github, google }` the
  Allow-access modal reads is now derived from `authProviders[n].active`
  (:127-130). `users-panel.tsx` itself was not touched.
- `app/features/profile/profile-query.server.ts` — `githubConfigured` resolves
  the same way (F18-3's affordance follows the app row now).

Shared: `app/shared/auth/auth-paths.ts` (new) — `oauthCallbackUrl`, the one
spelling of `/api/auth/callback/<provider>`, importable from a route without
pulling a server-only module into the client bundle.

### 5.3 Run console: thought traces, tool chips, code blocks — P19-RC1 (`45ddb70`)

All three foldings are **pure functions in `app/features/runtime/runs-helpers.ts`**
and all three are **no-ops when the `{ } raw` toggle is on**:

| Helper | Line | What it produces |
| --- | --- | --- |
| `isThoughtLine` | :266 | `ev:"think"` predicate |
| `groupThoughts` | :280 | folds CONSECUTIVE reasoning lines into `{ kind: "thought", lines }`; a lone line stays an ordinary row |
| `thoughtLabel` | :323 | "Thought for 4s · 3 steps" (duration measured from the stored clocks — never invented) |
| `toolChip` | :351 | `{ name, detail }` for a named tool call; **null when the provider sent no name** |
| `fileChangeChips` | :369 | one chip per file for `file_change` |
| `consoleCodeBlock` | :393 | multi-line `out`/`diff` → a bounded block |
| `diffLineKind` | :400 | `+`/`−` colouring inside a diff block |

Renderer `app/features/runtime/runs-panels.tsx` (865 lines):
- `AgentLogsPanel` (:412) — new `openThoughts` state (:452, keyed on the stored
  envelope so the key survives streaming/paging), pipeline
  `groupThoughts(collapseTelemetry(hoistRunInputs(shown), raw), raw)` (:489).
- The thought fold renders as `.log-line.think` with a `log-more` summary button
  carrying `aria-expanded` (:700-735); expanded steps are `.log-line.think.tstep`.
- Tool chips render as `.log-chip > .lc-name + .lc-detail`; file chips as
  `.log-files > .log-file.lf-{add,update,delete}` with `FILE_KIND_MARK`
  (`+`/`~`/`−`, :344-352) — **a glyph as well as a colour, WCAG 1.4.1**.
- `ConsoleCode` (:365) — `.log-code` with a `.lk-head` line count, a copy
  button, and `.lk-body > .lk-line` (never truncated, only scrolled).
- The pre-existing `P19-G11` "show what this run was given" disclosure
  (:751-790) and the `load older lines` control (:625-660) are unchanged.

### 5.4 MCP row: failure reason + background install — R19-17/17b/17c/18 (`8a5f782`, `101f72f`, `0cc9b55`, `88a17cc`)

`app/features/org-settings/resource-rows.tsx` — `McpPanel`:
- **`.rsrc-err` line (:257-258)** — `m.up === false && m.lastError &&
  m.warmingSince === null` renders the command's own stderr in monospace under
  the "unreachable" line, clamped to 8 lines (matching `redactGitOutput`'s bound
  so a traceback's last line survives). Persisted in `org_mcp_servers.last_error`,
  written by every probe path and **cleared by a passing probe**; already scrubbed
  of `MCP_CREDENTIAL` inside `discoverStdioMcpTools`.
- **INSTALLING state (:183, :218)** — `warming = m.warmingSince !== null`
  outranks the stored `up` for both the `.stat-dot` class (a new
  `stat-dot.warming` blue pulse) and its `title`, and the sub-line reads
  "installing on first use — finishing in the background".

`app/features/org-settings/resources-panel.tsx` (:102-122) — **a 20 s
`useRevalidator` poll armed only while some row is warming**, so the dot settles
without a manual refresh. Deliberately a poll, not SSE: the event vocabulary is
a closed typed union routed by user/project/task scope and an org-settings row
fits none of them.

Server: `app/server/org/mcp-warmup.server.ts` (new — one in-process registry
keyed by server id, 15-minute budget, `reapStaleWarmups` at boot),
`app/server/org/resources.server.ts` (stdio probe window 5 s → 20 s; the
"installing" reason is earned by stderr evidence only).

### 5.5 Browser capability + task attachments — R19-19 (`308cbc3`)

**Capability.** `app/shared/capabilities.ts:110` adds
`cap("use-browser", "Drive a live web browser", ["agent"], "Collaboration", "off")`.
It is an ordinary catalog entry, so it renders with no bespoke UI: it appears as
a toggle in the **Collaboration** accordion group of the agent profile editors
(`agents/create-profile-modal.tsx`, `org-settings/agent-template-modal.tsx`), as
a row in `agents/capability-matrix-modal.tsx`, and on the Policy page's agent
capability table. **Default `off`** — a casually created profile does not acquire
a driven browser.

**Where a granted browser becomes visible at runtime.** The mount is a
viberr-owned Playwright MCP server named `viberr_browser`
(`app/server/tasks/specialist-browser-mcp.server.ts:50`), so it surfaces in the
run console through the existing P19-G11 disclosure: `runInputRows`'s **`mcp`
row** (`runs-helpers.ts:185-200`) lists it under `mounted:`, and a browser
granted but refused (e.g. because `use-web-search-fetch` was withheld — the
egress interlock) is pushed onto `unresolvedResources` and shows as "granted but
NOT mounted", carrying its reason. There is no separate browser widget.

**Attachments panel.** `app/features/task-detail/attachments-panel.tsx` (76
lines, new) — `AttachmentsPanel` renders **nothing when the list is empty**;
otherwise a `.panel` with `data-comment-anchor="attachments"`, an
`.attach-grid` of `.attach-thumb` image tiles (each an `<a target="_blank">`
wrapping an `<img loading="lazy">`, with an `aria-label` naming file and size)
and `.attach-file` rows for everything else. Sizes format through
`prettySize` from `~/features/kb-browser/tree`.

Wiring:
- `app/routes/project.task.tsx:242-247` — the loader calls
  `listTaskAttachments(slug, key)` **gated on `runsVisible`** (non-members get
  `[]`, the same bar as the run console); the component builds
  `attachmentsBase = /projects/<slug>/tasks/<KEY>/attachments` from `params`
  (:889-890).
- `app/features/task-detail/task-detail-page.tsx` — new `attachments` /
  `attachmentsBase` props (:96-97, types :130-134); the panel renders at
  **:630-632**, immediately above `<Timeline>` (:634), and the same data is
  forwarded into the timeline (:644-648). `attachmentsBase = null` (bare test
  renders) hides both.

**Evidence linkify.** `app/features/task-detail/timeline.tsx` — new
`EvidenceLabel` (:111): an evidence label is split on whitespace and any token
that, stripped of backticks/quotes/trailing punctuation, **exactly matches a
real attachment filename** becomes an `<a class="ev-file">` to the serving
route. No matches ⇒ the plain text it always was. `TimelineItem` (:147) takes
`attachmentNames?: ReadonlySet<string>` + `attachmentsBase?`; `Timeline` (:256)
set-ifies once (`attachmentSet`, :305) and passes both down (:483).

**Serving route** — `app/routes/task-attachment.ts`, see §1.

---

## 6. UI rough edges (still present at HEAD)

- **Run-log stream disconnect is reload-only** ·
  `app/features/runtime/use-run-log-stream.ts:457-464`. The task-log
  `EventSource` never auto-reconnects; on `readyState === CLOSED` it sets "Live
  tail disconnected — reload the page to resume following.", surfaced through
  `AgentLogsPanel`'s `streamError`. Contrast the topbar's `livePaused` pill,
  which offers a retry.
- **`use-run-log-stream.ts` is "binary" to grep/ripgrep** — it embeds three
  literal `\0` bytes as cache-key separators (line 197,
  `` `${projectSlug}\0${taskKey}` ``). `grep`/`rg` silently report "binary file
  matches" and print nothing; use `sed`/`Read`/`grep -a` on this file. This
  costs every agent that greps for a string in it.
- **`Icon` uses `dangerouslySetInnerHTML`** · `app/ui/icon.tsx:73` injects a
  static path string from the in-module `ICON_PATHS` map. Values are hardcoded
  literals (safe today), but it is an innerHTML sink pattern worth noting.
- **Board drag has no aria-live announcements** · `app/features/board/board-page.tsx`
  — drag is deliberately pointer-only, keyboard users routed to `StageMenu`.
  Nothing announces drag pickup/drop; the accessible path is the menu.
- **Q-V1 PAT half — still open, now with an exact pointer.** The pass-19 doc
  said "the tail is rendered by another component; find and gate that one". It
  is **`app/features/github/credential-card.tsx:31` `CredentialCard`**, rendered
  unconditionally by `settings-page.tsx` `RepoPanel` (:1114, card at :1240-1276).
  Only the ACTIONS are gated: `manageActions={<CredentialManageActions
  … canManage={canGrant}/>}` and the `Grant scope` button (`canGrant &&
  credential.source !== "none"`, :1255). A project **Viewer** therefore still
  receives the credential label, masked value and scope list in the HTML.
  `github-view.tsx` renders the same card on the GitHub view.
- **F18-1b (low)** — during the closed-PR reopen-detection window a stale
  recovery-packet card renders beside a GitHub card already showing "in review"
  for ~50 s until the operator withdraws it.

**Do not re-open F18-9** ("the new-agent-profile modal pre-selects ALL org skills
ON") — dispositioned not reproducible; both profile modals initialise with EMPTY
grants.

No `TODO`/`FIXME`/`HACK` markers exist in task-detail, home, or shell.

---

## 7. What the pass-19 doc got wrong (corrected above)

1. **`app.css.test.ts` "1006 lines"** — it was **2373** lines at the pass-19
   merge and is **2381** now. The four cited anchors (:110, :177, :426, :602)
   were and remain correct; the file simply is not the size the doc claimed, and
   the doc omitted the three R19-12 `describe` blocks (:1773, :2207, :2341) and
   the `RENDERED_INSIDE` map (:1542) entirely.
2. **`app.css` "3966 lines"** — it was already **4014** at `4184e95`; it is
   **4218** now. The pass-19 doc's numbers were taken mid-pass, before its own
   merge.
3. **"Routes: unchanged"** — true for pass 19, false now: `task-attachment.ts`
   is a new top-level route (`routes.ts` 52 → 59 lines). The insertion sits at
   :40-43, so every citation from `/projects` down shifts: `projects` 39→46,
   the `projects/:slug` layout 41→48, its children 42-50→49-57. Citations
   above the insertion point are unchanged.
4. **Most §4/§4b line anchors were stale on arrival** — they were verified
   against `65063b8` (the pass-18 merge), not against the pass-19 merge the doc
   was published from. Representative drift: `GithubTrace` 21→19, `isTerminal`
   59→100, `forceAcceptRow` 67→119; `.profile-grid` 1126→1165 and 2912→2956;
   `users-panel` banner 460-470→455-470, button 487-488→492, `.cred-warn`
   313→317 and 504→519; `settings-page` Stages note 758→775, Members 868→883,
   RepoPanel 1121→1173, `canEditPolicy` 1437→1483, DangerZone gate
   1596-1603→1649-1650; `timeline.tsx` comment-scope 370→435;
   `task-main-sections` 160-174→153-180 and 208-215→220; `policy-page`
   158→162, 474→478, 585-590→595; `mini-modal` 62-71→69; `agents-page`
   1230-1240→1260; `top-bell` dialog 119-170→127; `.gh-table,.live-wrap`
   3955-3965→4011.
5. **F18-3's premise moved.** The doc describes `githubConfigured` /
   `providers.*` as reading the deployment ENV. Since R19-16 both resolve
   through `resolveOAuthProvider` / `org-view.server`'s `authProviders`, so an
   admin can now change what those affordances say from inside the app. The
   fix's SHAPE is unchanged; its data source is not.
6. **Q-V1's "find and gate that one" is now resolved to a file** (§6).

---

## 8. Delta summary (pass 19 → pass 20)

| Commit | UI surface | Files |
| --- | --- | --- |
| `881a4e1` | Public-repo import needs no connection | `kb-browser/store-browser.tsx` (+ `store-files.server`, `github-client.server`) |
| `affdaed` | **NEW** Sign-in & SSO tab (R19-16) | `org-settings/sso-panel.tsx` **(new)**, `org-settings/org-settings-page.tsx`, `routes/org.settings.tsx`, `routes/login.tsx`, `profile/profile-query.server.ts`, `org/org-view.server.ts`, `shared/auth/auth-paths.ts` **(new)** |
| `45ddb70` | Run console foldings (P19-RC1) | `runtime/runs-helpers.ts`, `runtime/runs-panels.tsx`, `app.css` |
| `8a5f782` `101f72f` `0cc9b55` | MCP failure reason on the row (R19-17/b/c) | `org-settings/resource-rows.tsx`, `app.css`, `org/resources.server.ts` |
| `88a17cc` | MCP INSTALLING state + 20 s poll (R19-18) | `org-settings/resource-rows.tsx`, `org-settings/resources-panel.tsx`, `org/mcp-warmup.server.ts` **(new)**, `app.css` |
| `308cbc3` | Browser capability, attachments panel, evidence links, **new route** (R19-19) | `routes.ts`, `routes/task-attachment.ts` **(new)**, `task-detail/attachments-panel.tsx` **(new)**, `task-detail/task-detail-page.tsx`, `task-detail/timeline.tsx`, `routes/project.task.tsx`, `shared/capabilities.ts`, `app.css` |
| `a1ceb78` `fa773e0` `876aff0` `b97ad02` | none (Dockerfile / build) | `Dockerfile` |

Routes: **+1** (`task-attachment.ts`). Org-settings tabs: **3 → 4**. Agent
capabilities: **+1** (`use-browser`, default off). Task-detail panels: **+1**
(Attachments, self-hiding when empty). The design-token discipline (one
stylesheet, unprefixed tokens, no Tailwind, the no-allowlist class gate at :602,
the contrast gate at :426, the focus ring at :177, token resolution at :110, the
20-site inline budget at :1142) is unchanged and re-verified.
