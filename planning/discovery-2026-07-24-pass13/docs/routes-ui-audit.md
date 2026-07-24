# Viberr — Routes + UI honesty audit (pass 13, 2026-07-24)

Base: `main` @ `c7abebf` (post PR #94 / pass-12 merge). Every claim below was read
from source at that commit; line numbers are from the working tree at audit time.
Supersedes `planning/discovery-2026-07-24-pass12/docs/routes-ui-map.md` for the
*honesty* question — that document remains the better structural map of loader
payload shapes, and is not repeated here.

Focus of this pass: **what is real, what is decorative, what is dishonest** on every
route and UI surface. "Dishonest" means the UI asserts something the data does not
support (a checkmark for an unverified fact, a green pill for an unknown state, a
success toast before the server answered, an animated "working" dot at zero runs).

---

## 0. Re-verification of the pass-12 route/UI candidates

| pass-12 item | status on `c7abebf` | evidence |
|---|---|---|
| #1 favicon 404 spam (F12-02) | **PARTIAL** — `handleError` now swallows routine 404s (`app/entry.server.tsx:29-35`), but `public/` still has only `favicon.svg`, so every `/favicon.ico` hit still SSR-renders the full root ErrorBoundary document | `app/entry.server.tsx:29`, `public/` |
| #2 Profile optimistic toasts (RU-1) | fixed for the no-op case (`app/features/profile/profile-page.tsx:316` comment); see §3 agent findings for residuals | `profile-page.tsx:303-330` |
| #3 create-profile offers unavailable backends (RU-2) | **FIXED** — loader now returns `backendAvailable`; the chip is disabled unless usable | `app/routes/project.agents.tsx:60-66`, `create-profile-modal.tsx:223-224,748` |
| #4 role literal in settings-page (RU-3) | **FIXED** for the danger zone (`a197043`); page-level `isAdmin` intentionally retained | `settings-page.tsx` |
| #5 `githubHost ?? "https://github.com"` | **STILL OPEN**, and worse than recorded — see F-11 | `task-detail-page.tsx:126` |
| #6 hardcoded `profileId:"operator"` | by-design ruling, unchanged | `project.agents.tsx` |
| #7 notification caps | **FIXED for `/notifications`** (`truncated` + `limit` surfaced); the **bell popover is still silently capped** — see F-14 | `app/routes/notifications.tsx:33-48`, `notifications-page.tsx:238` |
| #8 triple-duplicated run-agents guard | **FIXED** (`runAgentsAuthority` helper) | `app/routes/project.task.tsx:177,498,542,570` |
| #9 review-queue lock chip is a button dressed as a static chip | **STILL OPEN** | `review-page.tsx:106-115` |
| #10 Permissions panel hand-written prose | **STILL OPEN** | `task-detail-page.tsx:272` |
| #11 layout loader mutated projection objects | **FIXED** (non-mutating `annotate`) | `app/routes/project.tsx:45-60` |
| #12 live roster falls back to raw profileId | **STILL OPEN** | `agents-page.tsx:513` |
| #13 `.server.test.ts` inside `app/routes/` | **FIXED** (moved to `app/features/runtime/`) | — |
| #14/#15/#16 (health unauthenticated, login CSRF, credential binding) | by-design, unchanged | — |

**Intent wiring is clean.** Every one of the 74 action intents declared across the
route actions has at least one client caller in `app/features`, and every
`intent` value submitted from a component exists in the matching route action.
There are no dead server intents and no broken client submissions. (Verified by
extracting both sets and diffing; the only client-side literals with no server
case are `login`/`set-password`, which live in `routes/login.tsx` itself.)

---

## (a) Route-by-route table

RBAC column: the *first* gate the route applies. `requireFormAction` = better-auth
session + `_csrf`; the finer per-action gate is named where it differs.

| URL | Module | Loader sources | Action intents | RBAC gate | Renders | Route/component tests |
|---|---|---|---|---|---|---|
| `/` | `routes/_index.tsx` | `listHomeProjectsForUser`, `getHomePrefs`, `getHomeOrgSummary`, `listNotifications(100)`, `VIBERR_DATA_ROOT` | `pin`, `view`, `rescan`*, `rebuild-projections`*, `create-project` | `requireUser` / `requireFormAction`; *org-admin inline check (`_index.tsx:83,98`) | `features/home/home-page` | `home-phase10-route.server.test.ts`, `home-query.server.test.ts`, `project-create.server.test.ts`. **No component test for `home-page.tsx` (1426 lines)** — only `StageMeter` is imported by `notification-item.test.tsx` |
| `/login` | `routes/login.tsx` | `authenticate()`, OAuth env pairs | `login`, `set-password` | `assertTrustedOrigin` (+`assertCsrf` on `set-password` only) | inline | **none** (server helper `login.server.test.ts` only) |
| `/logout` | `routes/logout.tsx` | redirect `/` | POST only | `assertCsrf` | — | **none** |
| `/org/settings` | `routes/org.settings.tsx` | `getOrgSettingsView` (connections, users, domains, kbs, mcps, skills, gagents, stages; kb/skill trees are real disk scans) | 29 intents (connections, users/invites, kb/mcp/skill/gagent, store browser) | `requireRole(admin)` / `requireRoleAuth(admin)` + CSRF | `features/org-settings/*`, `features/kb-browser/store-browser` | `org-settings-route.server.test.ts`, `org-settings-page.test.tsx`, `store-browser.test.tsx` |
| `/profile` | `routes/profile.tsx` | `getProfileView` | `identity`, `set-notif`, `set-motion`, `set-tl-default`, `change-password`, `github-disconnect` | `requireUser` + CSRF | `features/profile/profile-page` (in `PageOverlay`) | `profile-route.server.test.ts`, `profile-page.test.tsx` |
| `/notifications` | `routes/notifications.tsx` | `listNotifications(200+1)`, `countUnreadNotifications` | none (posts to `/notifications/read`) | `requireUser` | `features/notifications/notifications-page` | `notifications-route.server.test.ts`, `notifications-page.test.tsx`, `notification-item.test.tsx` |
| `/notifications/read` | `routes/notifications.read.tsx` | redirect | `read`, `read-all` | `assertCsrf` | — | covered by the two suites above |
| `/prefs/theme` | `routes/prefs.theme.tsx` | redirect | theme value (no `intent`) | `assertCsrf` | — | `workspace-routes.server.test.ts` |
| `/resources/events` | `routes/resources.events.ts` | SSE broker | — | session cookie → **401 JSON**; D9 scope authorization | — | `sse-route.server.test.ts` |
| `/resources/health` | `routes/resources.health.ts` | projections + watchers + backend env flags | — | **unauthenticated (by design)** | — | `home-phase10-route.server.test.ts` |
| `/resources/run-log` | `routes/resources.run-log.ts` | `run_log` rows | — | `requireUser` + `requireProjectMember` | — | `run-artifact-routes.server.test.ts` |
| `/resources/model-catalog` | `routes/resources.model-catalog.ts` | curated list ⊕ live `supportedModels()` | — | `requireUser` | — | `model-catalog-route.server.test.ts` |
| `/resources/session-export` | `routes/resources.session-export.ts` | `locateTranscript` | — | `requireUser` + `requireProjectMember` | — | `run-artifact-routes.server.test.ts` |
| `/api/auth/*` | `routes/api.auth.$.ts` | better-auth handler | — | better-auth trustedOrigins + `ALLOWED_AUTH_PATHS` | — | `app/lib/auth.server.test.ts` |
| `/projects` | `routes/projects.tsx` | redirect `/` | — | — | — | none (trivial) |
| `/projects/:slug` | `routes/project.tsx` | `getBoard`, `decisionsRequiring`, `resolveStageRoles`, `countOpenPolicyViolations`, `listNotifications(100)` | — | `requireUser` (read is app-wide by design) | `features/shell/{rail,topbar,top-bell,user-menu}` + `<Outlet/>` | `workspace-routes.server.test.ts`. **No component test for any shell component** |
| `…/board` | `routes/project.board.tsx` | *(none — layout loader)* | `create-task`, `reorder`, `rescan` | `requireFormAction`; `assertProjectAction("rescan-project")` | `features/board/board-page` | `board-filters.test.ts` only. **No component test for `board-page.tsx` (1049 lines)** |
| `…/review` | `routes/project.review.tsx` | `getReviewQueue(viewerUserId)` | none | `requireProjectMember` | `features/review/review-page` | `review-route.server.test.ts`, `review-page.test.tsx`, `review-helpers.test.ts` |
| `…/agents` | `routes/project.agents.tsx` | `assembleAgentRoster`, `listAgentDeployments`, `buildResourceCatalog`, `isBackendAvailable` | `create-profile`, `update-profile`, `delete-profile` | `requireProjectMember` / `requireFormAction` (project-admin inside) | `features/agents/*` | `agents-route.server.test.ts`, `agents-page.test.tsx` (incl. `CreateProfileModal`), `agents-query.server.test.ts` |
| `…/policy` | `routes/project.policy.tsx` | `getPolicyViewData` | `set-role`, `set-boundary` | `requireProjectMember` | `features/policy/policy-page` | `policy-route.server.test.ts`, `policy-page.test.tsx`, `policy-rbac.server.test.ts` |
| `…/github` | `routes/project.github.tsx` | `getGithubViewData` (**live network probe**, 30 s cache) | `reconcile`, `grant-scope`, `set-credential`, `clear-credential` | `requireProjectMember`; `assertProjectAction` per intent | `features/github/*` | `github-route.server.test.ts`, `github-view.test.tsx`, `github-pills.test.ts`, `github-copy.test.ts` |
| `…/activity` | `routes/project.activity.tsx` | bounded feed slices (`?stream=`, `?audit=`) | none | `requireProjectMember` | `features/activity/activity-page` | `activity-route.server.test.ts`, `activity-page.test.tsx` |
| `…/settings` | `routes/project.settings.tsx` | `getSettingsViewData` | 13 intents (identity, stages, members, repo/credential, archive/delete) | `requireProjectMember`; `assertProjectAction("grant-github-scope")` on credential intents | `features/project-settings/settings-page` | `settings-route.server.test.ts`, `settings-page.test.tsx` |
| `…/tasks/:key` | `routes/project.task.tsx` | `getTaskDetail`, `listRunsForTask`, `readTaskFile` frontmatter, `isBackendAvailable`, `githubWebHost()` | 24 intents (comment → schedule-action, incl. new `force-accept` at `:288`) | `requireUser` + `requireFormAction`; `runAgentsAuthority` for run/schedule intents | `features/task-detail/*`, `features/runtime/*` | `task-detail-route.server.test.ts`, `task-runtime-route.server.test.ts`, `task-detail-components.test.tsx` (only `GithubTrace` + `execution-profile` exports), `runs-panels.test.tsx`, `mention-composer.test.tsx` |

E2E (`e2e/`, Playwright): 8 tests total — home renders projects, board columns,
review queue row, activity day grouping, notifications mark-all-read, profile theme
persistence, org-settings tabs, StoreBrowser folder creation. **No e2e for task
detail, agents, policy, GitHub view, project settings, or login.** The spec files
are numbered 01/05/06 (02–04 absent).

---

## (b) Inventory: inert / mock / dishonest controls and values

Nothing in the app is *inert* in the classic sense — there is no `href="#"`, no
empty `onClick`, no permanently-disabled control, and no orphan intent. The
dishonesty in this codebase is **assertive**: controls work, but several of them
report a state the data cannot justify.

| # | Surface | file:line | Verdict |
|---|---|---|---|
| 1 | Connection scope chips ✓ repo / workflow / pull_request:write | `app/features/org-settings/connections-panel.tsx:211,227-234` | **Dishonest** — ✓ is painted from `validationState === "valid"`, but for fine-grained PATs every scope is pushed `{ok:true, source:"assumed"}` (`app/server/secrets/pat-validator.server.ts:284-291`). The `source` field is already persisted and ignored by the UI. |
| 2 | "validated against the minimum scopes before anything is saved" | `connections-panel.tsx:200-206` | **Dishonest copy** — same root cause as #1. |
| 3 | Home card "updated <rel>" | `home-page.tsx:207-211` ← `home-query.server.ts:245` (`agg?.updated_at ?? project.parsedAt`) | **Derived-but-wrong** — `parsed_at` is `nowIso()` at projection time (`rebuilder.server.ts:231`), so a task-less project reads "updated just now" right after any rebuild. |
| 4 | "N repos" on a connection row | `connections-panel.tsx:224` ← `connections.server.ts:236-242` (`public_repos`) | **Misleading** — public repos only, captured once at connect time, never refreshed. |
| 5 | Home hero "Your agents kept working — **0 runs active** across 0 projects, 0 decisions waiting on you", with the animated `.working` dot | `home-page.tsx:831-843` | **Dishonest** — mock copy asserting activity at zero; the pulsing dot renders inside the "0 runs active" bold. |
| 6 | Branch table Sync pill | `github-query.server.ts:168-171` + `branch-sync.server.ts:138-145` | **Dishonest** — a never-reconciled branch has `behindBy = 0` by default, so `deriveSyncState` returns green **"synced"** for a state that was never measured. The comment at `github-query.server.ts:30` calls this "honest". |
| 7 | `githubHost` / "GHE-safe web host (WI-17) — the view must never hardcode github.com" | `github-query.server.ts:220-221`, `app/routes/project.task.tsx:162`, `github-client.server.ts:210-220` | **Decorative abstraction** — both call sites invoke `githubWebHost()` with no argument, so it *always* returns `https://github.com`. No code path can produce a different host (`github-reconciler.server.ts:573` says so outright). |
| 8 | Task-detail browse-link host fallback | `app/features/task-detail/task-detail-page.tsx:126` | Residual pass-12 #5: `githubHost ?? "https://github.com"` under a "never hardcoded" comment. |
| 9 | Pin/unpin star toast | `home-page.tsx:1215-1231` | **Optimistic** — "Pinned — it will stay at the top" fires at submit; `prefsFetcher` (`:1180`) has no result handler, so a CSRF/session failure shows success and silently reverts. |
| 10 | "Re-scan" (store strip) failure path | `home-page.tsx:1235-1252` | **Swallows `{ok:false,error}`** — the 403 from `_index.tsx:83-91` produces no toast and no inline error; the spinner just stops. The sibling rebuild handler (`:1273-1288`) does it correctly. |
| 11 | Store-browser upload | `app/features/kb-browser/store-browser.tsx:489-516`, `:494`; `app/routes/org.settings.tsx:336` | **Silent no-op** — no busy state at all, and a folder whose files are all dot-filtered returns bare `ok()` with zero feedback. |
| 12 | New-project connection chips | `home-page.tsx:355-366` ← `home-query.server.ts:275-276` | Lists connections **without** a validation filter (the store import path requires `validationState === "valid"`, `connections.server.ts:152`), so a failed-token connection is offered as if healthy. |
| 13 | New-project repo field | `project-create.server.ts:97-115,200-207` | **Unverified** — a nonexistent repo 404s, is swallowed, falls back to `main`, and the toast reports success. Also a raw `fetch("https://api.github.com/...")` bypassing the shared client. |
| 14 | Bell popover "N unread" | `top-bell.tsx:102-104` vs `project.tsx:92` / `_index.tsx:48` (`limit: 100`) | `unread` is the *full* count while the list holds 100 rows — the popover can claim 150 unread and show 100, with no truncation notice (the fix landed only on `/notifications`). |
| 15 | MCP "not health-checked yet" branch | `resources-panel.tsx:741-753,763-769` | **Unreachable UI state** — `saveMcpServer` always writes `up = 0|1` (`resources.server.ts:788-798`) and is the only insert; `m.up === null` can never render. |
| 16 | `validation: "changed"` → "evidence changed" pill | `app/ui/pill.tsx:93` | **Likely unreachable** — no server code path writes `validation: "changed"`; the only literal write is `"none"` (`task-actions.server.ts:447`), with `deriveValidation`/explicit `healthy`/`failing` elsewhere. Reachable only if an agent hand-writes the frontmatter. |
| 17 | Org tile "N users · N admins · N members" vs the panel it links to | `home-query.server.ts:278` (excludes disabled) vs `users-panel.tsx:554` / `org-settings-page.tsx:39` (all users) | Two different populations under the same nav gesture. |
| 18 | Skill editor "clear SKILL.md" | `resources-panel.tsx:326-332`, `org.settings.tsx:282-294`, `resources.server.ts:1034` | Emptying the body cannot delete the file; the toast discloses it, the control does not. |
| 19 | Hardcoded terminal stage id `"done"` | `resources-panel.tsx:383,409`, `home-page.tsx:103` | Direct violation of the documented contract in `app/shared/workflow/stage-roles.ts:5-10` ("NOTHING may hard-code the literal ids"). |
| 20 | `data-screen-label` on ~22 components | e.g. `page-overlay.tsx:25`, `board-page.tsx:996`, `top-bell.tsx:98` | **Design-mock leftover** — zero consumers anywhere in the repo (no CSS, no test, no e2e, no script). |
| 21 | Review-queue lock chip | `review-page.tsx:106-115` | A `<button class="hero-file">` with inline `cursor:pointer`, visually identical to the non-interactive `hero-file` spans elsewhere. |
| 22 | Task-detail Permissions panel prose | `task-detail-page.tsx:190-272` | Values derive from `roleCan`; the surrounding copy ("V1 rules", `:272`) is hand-maintained, unlike Policy's matrix-rendered table. |
| 23 | Live roster agent name | `agents-page.tsx:513` | Falls back to the raw `profileId` when the profile was deleted from the roster. |
| 24 | Home greeting | `app/routes/_index.tsx:39-41` | `new Date().getHours()` on the **server** — a user in another timezone gets "Good evening" at 9am. `<h1 suppressHydrationWarning>` (`home-page.tsx:824`) hides the symptom. |
| 25 | `formatRelative` computed during client render | `home-page.tsx:209`, `store-browser.tsx:328`, `resources-panel.tsx:31` | Uses `new Date()` at render on both server and client — hydration-mismatch risk and a value that never ages. The GitHub view deliberately computes its freshness label server-side (`github-query.server.ts:200-202`) — the convention is not applied consistently. |
| 26 | Operator's `viberr` MCP grant chip | `create-profile-modal.tsx:609-614,646-650` ← `app/routes/project.agents.tsx:55-58` | **Dishonest** — the catalog is always built with `profileKind:"specialist"`, which excludes the reserved operator toolkit (`resource-catalog.server.ts:50-58`), so editing the operator flags its real `viberr` grant as `missing` with "No longer in the store — click to remove this grant". |
| 27 | Policy member rows for org-deleted users | `policy-page.tsx:91-116` ← `membership.server.ts:43-45` | **Dishonest** — `deleteOrgUser` (`org-users.server.ts:302-322`) never prunes project.md memberships, so a deleted account renders as `usr_9f3a…` with an enabled role radiogroup and is counted in "N members" and the role headers. |
| 28 | Reduce-motion + timeline-default + theme toasts (Profile) | `profile-page.tsx:303-321`, `app/routes/profile.tsx:158-167` | **Optimistic, no rollback** — the shared `prefsFetcher` result handler early-returns unless `data.intent === "set-notif"` (`profile-page.tsx:222`), so `set-motion`/`set-tl-default` failures are consumed by nobody. |
| 29 | "Applies on this device" (Appearance) | `profile-page.tsx:333-336` | **False** — `/prefs/theme` writes `users.theme` (`app/routes/prefs.theme.tsx:28`) and login re-syncs the cookie (`login.tsx:109`); the choice follows the account everywhere. |
| 30 | GitHub "Disconnect" | `profile-actions.server.ts:168-192`, copy at `profile-page.tsx:571-578` | **Dishonest** — only flips `users.idp` to `local`; the better-auth `account` row and `github_handle` survive and the next GitHub sign-in restores the link (`oauth-provision.server.ts:130-133`). |
| 31 | GitHub OAuth scope chips `read:user` / `user:email` | `profile-page.tsx:541-550` | **Hardcoded** — rendered as satisfied purely from `idp === "github"`, never read from the provider account. |
| 32 | "Your access" role pill + grant matrix | `profile-query.server.ts:138-143`, `profile-page.tsx:400-427` | **Derived-but-wrong** — the *maximum* role across all memberships is presented as the user's access with no project qualifier. |
| 33 | Every failure toast | `app/ui/toast.tsx:66-69` | Always renders `<Icon name="check"/>`; error strings pushed by `user-menu.tsx:81` / `top-bell.tsx:52-56` appear with a success tick. |
| 34 | Toast host vs modal overlays | `app/ui/toast.tsx:62-73` (`z-index:100`) vs `page-overlay.tsx:22-38` (`showModal()` → top layer) | Toasts render **under** `dialog::backdrop`, so confirmations inside `/profile` and `/notifications` are veiled. |
| 35 | Raw agent logs, `{ } raw` envelopes and `sid` | loader `app/routes/project.task.tsx:105`, render `task-detail-page.tsx:1308` | **Gate inconsistency** — served to any signed-in user, while `/resources/run-log:47` and `/resources/session-export:44` require membership. |
| 36 | Task-panel PR pill for a closed PR | `task-detail-page.tsx:139-151` | No `closed` branch; a rejected PR renders as blue "PR #14", identical to in-review. `github-pills.ts:37-42` already handles it. |
| 37 | "Update status" (Reconcile) button | `github-view.tsx:444-453`, optimistic toast at `:331` | Rendered for every role while `reconcile-github` is admin/maintainer; a viewer sees "Updating branch and PR status…" then a 403. |
| 38 | Agent-logs failure footer copy | `runs-panels.tsx:374-392` ← `task-detail-page.tsx:975-991` | Explanation is keyed to the viewer's `run-agents` grant, so a contributor sees "continuity error — see the blocked packet" for a quota failure. |
| 39 | Timeline empty state | `timeline.tsx:451-454` | "No activity yet — this task hasn't started its operator loop" renders when a *filter* matched nothing, next to "Show older events · N more". |
| 40 | Activity actor filter | `activity-page.tsx:255-266` vs `:341-348` | Page-level in appearance, Stream-only in effect; the audit panel receives the unfiltered list. |
| 41 | Activity "N events" + "Show older · N more" | `activity-page.tsx:241,279-281,328-333` | The count is the filtered *loaded slice*; at `STREAM_MAX`/`AUDIT_MAX` the button is a no-op but still promises N more. |
| 42 | Board "Waiting on me" vs Review "Waiting on your acceptance" | `app/routes/project.tsx:47-58` (decision-object presence) vs `review-queue.server.ts` `isReady` (acceptance authority) | The same task can be "waiting on you" in one surface and not the other. |
| 43 | Review header "Review → Done · human only" and "moves the task to **Done**" | `review-page.tsx:106-115,148-152` | Hardcoded stage names on a product whose stages are per-project and renameable (Lightweight is `todo/doing/done`). |
| 44 | Agent profile "Eligible stages · N of M" | `agents-page.tsx:304-325` ← `agents-query.server.ts:233` | Counts stage ids the project no longer has (`removeStage` doesn't prune profiles), producing "5 of 4 stages" with an invisible, un-uncheckable chip. |
| 45 | Agents "N active tasks · one operator each" | `agents-page.tsx:633,730-734` | Counts operator engagements; `createTask` assigns no operator in the entry stage (`task-actions.server.ts:440-444`), so 12 fresh tasks read as "0 active tasks". |
| 46 | Agent "Execution backend" chip list | `agents-page.tsx:354-366` | Renders every entry in `a.backends`, but runs always take the first runnable one (`specialist-run.server.ts:120-123`, `operator-actions.server.ts:132`). |
| 47 | Live roster header row | `agents-page.tsx:474-484` | A `.live-head` row of `<span>`s over button rows — a table that is not a table. |

---

## (c) FINDINGS CANDIDATES

Severity: **HIGH** = correctness/security/trust failure a user acts on ·
**MED** = wrong behaviour or a materially misleading state · **LOW** = polish,
dead code, contract drift.

---

### F13-01 (HIGH · dishonest security signal) — connection scope ✓ marks are painted for scopes that were never verified

`app/features/org-settings/connections-panel.tsx:211,227-234` renders
`<Icon name="check"/>` beside each of the three hardcoded `SCOPES` whenever
`c.validationState === "valid"`. `createConnection` validates with
`repo: null` (`app/server/org/connections.server.ts:198-202`); with a
**fine-grained** PAT there is no `x-oauth-scopes` header, so
`app/server/secrets/pat-validator.server.ts:284-291` falls into the terminal
`else` and pushes `{ id, ok: true, source: "assumed", note: "fine-grained tokens
expose no scope introspection" }` for **every** required scope — producing
`status: "valid"` with zero probes.

**User-visible failure:** an admin pastes a fine-grained PAT scoped only to
`Contents: read`. The modal promises "If any scope is missing the token is
refused" (`connections-panel.tsx:145-151`); the saved row then shows
✓ repo ✓ workflow ✓ pull_request:write. Every agent PR-open and workflow push
later 403s, and the first signal the human gets is a failed delivery.

**Fix:** `PatValidation.scopes[].source` is already persisted in
`validation_json`. Surface it and render `assumed` scopes as an unverified chip
(dashed/neutral, tooltip "not verifiable for fine-grained tokens") rather than a
checkmark, and soften the modal copy.

---

### F13-02 (HIGH · dishonest freshness) — "updated just now" on projects that did not change

`app/features/home/home-page.tsx:207-211` renders
`updated {formatRelative(p.updatedAt)}`; `home-query.server.ts:245` sets
`updatedAt: agg?.updated_at ?? project.parsedAt`, and `parsed_at` is written as
`nowIso()` on every (re)projection (`app/server/projections/rebuilder.server.ts:231`).
`rebuildProjections` deletes and force-reprojects everything
(`app/server/projections/rebuild.server.ts:41-47`).

**User-visible failure:** an admin clicks "Rebuild projections" in the store strip
and every task-less project card on the same page flips to "updated just now"
although nothing changed. The same happens after any restart-time rescan. The
timestamp is the only recency signal on the home grid, so it actively misleads
triage.

**Fix:** return `null` when there is no task aggregate and render "no activity
yet", or carry the `project.md` mtime instead of `parsed_at`.

---

### F13-03 (MED · silent permanent degradation) — a dropped SSE stream is never surfaced, and after session expiry it never reconnects

Neither EventSource consumer registers an `error` handler:
`app/features/live-updates/use-live-updates.ts:58-63` and
`app/features/runtime/use-run-log-stream.ts:143-172`. `/resources/events`
returns **401 JSON** for an expired session (`app/routes/resources.events.ts:53-60`),
400 for an invalid scope (`:66-90`) and 403 for all-foreign scopes (`:118-128`).
Per the HTML spec an EventSource that receives a non-200 response *fails the
connection* — it does **not** reconnect. The route's own comment
(`resources.events.ts:29-32`) claims "the client backs off and retries; after a
re-login the next retry succeeds", which is not what the browser does.

**User-visible failure:** a board tab left open overnight outlives the session.
The stream 401s once, EventSource closes permanently, and from then on the board,
rail counts, bell badge and review queue are frozen — with no banner, no toast and
no "reconnecting" state. The user believes they are looking at live governance
state. (The task-detail page partially self-heals via the 20 s
`hasActiveRun` interval at `use-run-log-stream.ts:76-82`; every other surface does
not.)

**Fix:** add `source.onerror` → surface a "live updates paused — reload" chip in
the topbar and attempt a bounded re-open (a fresh `EventSource` after a backoff
recovers post-re-login); correct the misleading comment.

---

### F13-04 (MED · unbounded wait with no feedback) — the GitHub HTTP client has no request timeout, and the app has no navigation pending UI

`createGithubClient` (`app/server/github/github-client.server.ts:112-129`) issues
`fetchImpl(url, init)` with **no `AbortSignal`/timeout** anywhere — contrast the
git subprocess calls, which all pass `timeoutMs` (`push-workspace.server.ts:164+`,
`workspace-delivery.server.ts:277+`). The `/projects/:slug/github` loader awaits a
live `checkRepoAccess` through that client (`github-query.server.ts:154`, 30 s
memo at `:118,139`). Separately, `useNavigation` appears **only** in
`app/routes/login.tsx:258` — there is no global route-pending indicator and no
`HydrateFallback` anywhere in the app.

**User-visible failure:** with GitHub unreachable at the TCP level (corporate
proxy, DNS blackhole), clicking "GitHub" in the rail produces *nothing at all* —
no spinner, no skeleton — until undici's default timeout elapses. The same
unbounded client backs the org-settings PAT validation action and project
creation.

**Fix:** give `createGithubClient` a default `AbortSignal.timeout(10_000)` (the
`network` failure branch at `:145-152` already renders honestly as "offline"), and
add a top-level pending bar driven by `useNavigation().state !== "idle"`.

---

### F13-05 (MED · dishonest positive state) — a never-reconciled branch renders the green "synced" pill

`app/features/github/github-query.server.ts:168-171` calls `deriveSyncState`
with `behindBy: behindByFor(t.filePath)`, and `createBehindByResolver`
(`:81-100`) returns **0** when no `github.reconcile` provenance row exists.
`deriveSyncState` (`app/server/github/branch-sync.server.ts:138-145`) then returns
`"synced"` → `SYNC_PILL.synced` = `{ kind: "ready", label: "synced" }`
(`github-pills.ts:24`).

**User-visible failure:** every execution branch on a project that has never
successfully reconciled (no credential, repo not found, poller failing) shows a
green "synced" pill in the Sync column. The page-level freshness chip says
"stale", but the per-row assertion contradicts it. A maintainer reads "synced" as
"this branch is up to date with main" when nothing was ever compared.

**Fix:** make the resolver return `null` for "never measured" and add an
`unknown` sync state rendering a neutral "not compared" pill.

---

### F13-06 (MED · optimistic success on a governed pref) — pin/unpin toasts before the server answers and swallows failures

`app/features/home/home-page.tsx:1215-1231` — `toggleStar` pushes
`"Pinned — it will stay at the top"` synchronously at submit time; the
`prefsFetcher` declared at `:1180` has **no** result handler, so
`{ ok: false, error }` from `_index.tsx` is never read.

**User-visible failure:** with an expired CSRF token or session, the star toggles,
the toast says "Pinned", and the next revalidation silently reverts it. The app
has a shared `useFetcherResult` hook (`app/ui/use-fetcher-result.ts`) adopted by
the bell, user-menu and profile — this is the surface it was not applied to.

**Fix:** move both the pin and the view-mode toasts into a `useFetcherResult`
handler and toast `data.error` on failure.

---

### F13-07 (MED · swallowed error) — a failed "Re-scan" is indistinguishable from success

`app/features/home/home-page.tsx:1235-1252` toasts only when
`rescanFetcher.data?.ok` is true. Both failure paths in the route — the
non-admin 403 (`app/routes/_index.tsx:83-91`) and `appErrorResponse`
(`:140`) — return `{ ok: false, error }`, which renders nothing at all: the
spinner stops and the page looks as if the rescan succeeded.

**Fix:** mirror the rebuild handler in the same file (`:1273-1288`), which
already toasts `d.error`.

---

### F13-08 (MED · silent no-op) — store uploads have no busy state and can complete with zero feedback

`app/features/kb-browser/store-browser.tsx:489-516` never reads
`opsFetcher.state` (only the GitHub-import bar has a busy flag, `:137-150`), so a
large folder drop shows nothing until the revalidation lands. Worse, `:494`
returns early when every entry was dot-filtered (`local-files.ts:25,50`), and
`app/routes/org.settings.tsx:336` returns a bare `ok()` when `result.added === 0`.

**User-visible failure:** dragging a folder that contains only `.env` /
`.DS_Store` produces no toast, no error and no new row — indistinguishable from a
broken drop target.

**Fix:** disable/spin the toolbar while `opsFetcher.state !== "idle"`; return a
toast such as "nothing uploaded — N hidden files were skipped".

---

### F13-09 (MED · unverified destination) — the new-project modal accepts any repo string and any connection health

Two gaps compound. (1) `home-page.tsx:355-366` renders
`org.connectionOwners` from `home-query.server.ts:275-276`, which applies **no**
validation filter — unlike the store-import path, which requires
`validationState === "valid"` (`connections.server.ts:152`). (2)
`createProject` only best-effort probes the repo
(`project-create.server.ts:97-115,200-207`): a 404 is swallowed and the default
branch silently falls back to `main`.

**User-visible failure:** typo the repo name (or pick a connection whose token is
in `failed` state) → the toast reports "<KEY> initialized — task store created at
…", the card shows `owner/typo`, and the failure only appears when the first
agent delivery cannot push.

**Fix:** mark unvalidated/failed connections in the chip list, and verify
`GET /repos/{owner}/{repo}` before writing `project.md` (or warn in the modal).

---

### F13-10 (MED · mock copy asserting activity that does not exist) — the home hero at zero runs

`app/features/home/home-page.tsx:831-843` renders, for any user with ≥1 project:
"Your agents kept working — **0 runs active** across 0 projects, **0 decisions**
waiting on you", with an animated `.working` pulse dot (`:834`) inside the bold
"0 runs active".

**Fix:** branch the copy on `totalRunning === 0` ("All quiet — no agent runs
right now") and drop the pulse dot when the count is zero.

---

### F13-11 (MED · decorative abstraction) — "GHE-safe" host derivation can only ever return github.com

`githubWebHost(apiBaseUrl?)` (`app/server/github/github-client.server.ts:210-220`)
is called with **no argument** at both of its call sites —
`app/features/github/github-query.server.ts:221` (directly under the comment
"GHE-safe web host (WI-17) — the view must never hardcode github.com") and
`app/routes/project.task.tsx:162`. No connection record stores an API base URL,
and `github-reconciler.server.ts:573` states outright "V1 is github.com-only (no
non-default baseUrl is ever wired)". `task-detail-page.tsx:126` then adds a
second literal fallback (`githubHost ?? "https://github.com"`).

**User-visible failure:** on a GitHub Enterprise deployment every "Open on
GitHub" / PR / branch link points at github.com. The abstraction advertises
support that does not exist and hides the gap from anyone reading the code.

**Fix:** either wire an API base URL onto the connection record and thread it
through, or delete the parameterisation and state the github.com-only limitation
in one place.

---

### F13-12 (MED · accessibility, bypass blocks) — the workspace shell has no `main` landmark and the app has no skip link

`app/routes/project.tsx:120,130` renders `<div className="app">` →
`<div className="main">` → `<Outlet/>`. The rail is a proper `<nav
aria-label="Primary">` (`rail.tsx:32`), but there is **no `<main>` element** on
any of the eight workspace routes, and a repo-wide search finds **no skip link**
anywhere. Home (`home-page.tsx:1331`) and org settings
(`org-settings-page.tsx:45`) do use `<main>`; the workspace does not.

**User-visible failure:** a keyboard or screen-reader user landing on a task
detail page must tab through the entire rail (7 nav items + project switcher) and
topbar (brand, 2–3 crumbs, search, bell, avatar menu) on every navigation, with no
landmark to jump to and no bypass mechanism (WCAG 2.4.1).

**Fix:** change the workspace content wrapper to `<main className="main">` and add
a visually-hidden skip link in `app/root.tsx`.

---

### F13-13 (MED · accessibility, toggle state) — five selected-state toggle groups convey selection with CSS only

`users-panel.tsx:640-655` (row Admin/Member), `:274-281`, `:406-413`;
`resources-panel.tsx:105-111` (Re-index), `:192-199` (Transport);
`home-page.tsx:847-864` (Grid/List — `role="group"` but no per-button state).
Selection is carried solely by `className="on"`. The same files get it right
elsewhere with `aria-pressed` (`users-panel.tsx:158,172,187`,
`resources-panel.tsx:468,481`), so this is an omission rather than a convention.

**Fix:** add `aria-pressed` (or `role="radiogroup"` + `aria-checked`) to the five
groups.

*(Positive control: a scripted sweep of all 236 `<button>` elements in `app/`
found 11 icon-only buttons, **all 11** labelled — 8 via `aria-label`, 3 via
`title`; `Icon` is `aria-hidden` (`app/ui/icon.tsx:74`). All 15 `<dialog>`s carry
`aria-label`/`aria-labelledby`, confirms carry `role="alertdialog"`, and all go
through `useDialog`/`showModal`. The a11y baseline is otherwise strong.)*

---

### F13-14 (LOW · silent truncation) — the bell popover claims an unread count larger than the list it shows

`app/features/shell/top-bell.tsx:102-104` renders `{unread} unread` from the
full `countUnreadNotifications`, while the popover list is loaded with
`limit: 100` (`app/routes/project.tsx:92`, `app/routes/_index.tsx:48`). The
pass-12 truncation fix (RU-4) was applied only to `/notifications`
(`app/routes/notifications.tsx:33-48` → `notifications-page.tsx:238`).

**Fix:** apply the same over-fetch-by-one + "showing the newest N" note to the
popover, or link "See all" more prominently once the count exceeds the cap.

---

### F13-15 (LOW · contract violation) — hardcoded `"done"` stage id in two UI surfaces

`app/features/org-settings/resources-panel.tsx:383,409`
(`stages.filter(s => s.id !== "done")`) and `home-page.tsx:103`
(`opacity: s.id === "done" ? 0.45 : 1`) contradict
`app/shared/workflow/stage-roles.ts:5-10`, which states nothing may hard-code
those ids and exports `resolveStageRoles`/`isTerminalStage` (already used at
`home-query.server.ts:222`).

**User-visible failure:** on a board whose terminal stage is renamed (e.g.
`shipped`), the global-agent stage picker would offer the terminal stage for
agent grants, directly under its own hint that "Done is human-only, always"
(`resources-panel.tsx:509`).

---

### F13-16 (LOW · unreachable UI branch) — MCP "not health-checked yet" state can never render

`resources-panel.tsx:741-753,763-769` branch on `m.up === null`, but
`saveMcpServer` writes `up = 0|1` on both insert and update
(`app/server/org/resources.server.ts:788-798`) and is the only
`INSERT INTO org_mcp_servers` in the tree. Dead branch plus a neutral dot colour
that never appears.

---

### F13-17 (LOW · likely unreachable) — the `validation: "changed"` → "evidence changed" pill has no producer

`app/ui/pill.tsx:93` maps `changed` to an amber "evidence changed" pill and it is
part of `VALIDATION_VALUES` (`app/schemas/task-file.schema.ts:36`), but the only
literal write in server code is `validation: "none"`
(`app/server/tasks/task-actions.server.ts:447`); everything else sets `healthy`,
`failing`, or `deriveValidation(...)`. `workspace-delivery.server.ts:335`
mentions flipping to `"changed"` only as behaviour it deliberately avoids.
Either wire the state or drop it from the enum and the pill map.

---

### F13-18 (LOW · design-mock leftover) — `data-screen-label` is rendered on ~22 components with zero consumers

Examples: `app/ui/page-overlay.tsx:25`, `home-page.tsx:179,236,653,876,952,961,1024,1052,1149,1319`,
`board-page.tsx:996`, `activity-page.tsx:245`, `top-bell.tsx:98`,
`store-browser.tsx:695`, `org-settings-page.tsx:45`, `mini-modal.tsx:42`,
`resources-panel.tsx:1011`, `connections-panel.tsx:186`, `users-panel.tsx:540`,
`review-page.tsx:96`, `release-confirm.tsx:57`. A repo-wide search (app, e2e,
scripts, design, build, CSS) finds **no reader**. It is the mock's screenshot-
tooling hook, shipped into production DOM.

---

### F13-19 (LOW · wrong clock) — the home greeting uses the server timezone

`app/routes/_index.tsx:39-41` computes `new Date().getHours()` in the loader.
`home-page.tsx:824` carries `suppressHydrationWarning`, which masks the symptom
rather than fixing it. A user in a different timezone from the server is greeted
"Good evening" at 9am.

---

### F13-20 (LOW · hydration + staleness) — `formatRelative` is computed during client render on three surfaces

`home-page.tsx:209`, `store-browser.tsx:328`, `resources-panel.tsx:31` call
`formatRelative(iso)` with the implicit `now = new Date()` inside render, so SSR
and hydration can disagree and the value never ages. The GitHub view deliberately
computes its freshness label server-side for exactly this reason
(`github-query.server.ts:200-202`) — the convention is not applied consistently.

---

### F13-21 (LOW · misleading empty state) — "No project matches" while a matching pinned card is visible

`app/features/home/home-page.tsx:967-968` gates the empty message on
`rest.length === 0 && query`, ignoring the `pinned` array rendered above it.

---

### F13-22 (LOW · information hidden) — `overrideWaiting` disappears whenever `waiting > 0`

`app/features/home/home-page.tsx:146-152` renders the "N override-available" pill
only when `p.waiting === 0`. An org admin with 2 personal and 3 override-eligible
decisions sees "2 waiting on you" and no trace of the other 3.

---

### F13-23 (LOW · accidental mutation) — the store browser's new-folder input commits on blur

`app/features/kb-browser/store-browser.tsx:251-253` — clicking any other control
while the inline input holds text silently creates a folder with whatever was
typed.

---

### F13-24 (LOW · counts disagree across one nav gesture) — home org tile vs users panel

`home-query.server.ts:278` filters `!u.disabled` (tile:
`home-page.tsx:1086-1094`), while the panel the tile links to reports all
accounts (`users-panel.tsx:554`) and the tab-rail count agrees with the panel
(`org-settings-page.tsx:39`). Clicking the tile changes the number.

---

### F13-25 (LOW · control implies an impossible edit) — SKILL.md cannot be cleared from the editor

`resources-panel.tsx:326-332` submits `body: ""`; `app/routes/org.settings.tsx:282-294`
never sends a `clearBody` flag, so `saveSkill` keeps the file on disk
(`app/server/org/resources.server.ts:1034`). The toast discloses "existing
SKILL.md kept" — the textarea does not.

---

### F13-26 (LOW · test coverage) — the two largest UI files and the whole shell have no component test

- `app/features/home/home-page.tsx` (1426 lines) — no component test; only
  `StageMeter` is imported by `notification-item.test.tsx`.
- `app/features/board/board-page.tsx` (1049 lines) — no component test at all
  (only the pure `board-filters.test.ts`). Drag/drop, the StageMenu, the filter
  bar and the new-task modal are untested at the component level.
- `app/features/shell/{rail,topbar,top-bell,user-menu}.tsx` — no component tests.
- `app/routes/login.tsx` and `app/routes/logout.tsx` — no route tests
  (`login.server.test.ts` covers the helper, not the action's error mapping).
- `app/features/task-detail/task-detail-page.tsx` — only `GithubTrace` is
  exercised by `task-detail-components.test.tsx`.

Pass 12 recorded the lesson "cover the new render branch" after SELF-1 (a
`ReferenceError` in `GithubTrace` that 500'd every blocked task because no test
rendered that branch). The same exposure exists today for the home page, the
board and the shell.

---

### F13-27 (LOW · residuals carried from pass 12, re-verified open)

- `public/favicon.ico` still absent; `handleError` now silences the log but each
  `/favicon.ico` hit still SSR-renders the root ErrorBoundary document
  (`app/entry.server.tsx:29-35`).
- Review-queue lock chip is still a `<button class="hero-file">`
  (`review-page.tsx:106-115`).
- Task-detail Permissions panel copy is still hand-maintained prose
  (`task-detail-page.tsx:190-272`).
- Live roster still falls back to the raw profile id
  (`agents-page.tsx:513`).

---

### F13-28 (HIGH · destructive misinformation) — the profile editor tells an admin to delete the operator's real MCP grant

`app/routes/project.agents.tsx:55-58` always builds the picker catalog with
`buildResourceCatalog(db, undefined, { profileKind: "specialist" })`. By design
that scoping drops the reserved operator toolkit
(`app/server/org/resource-catalog.server.ts:50-58` —
`mcpIds = profileKind === "specialist" ? new Set() : new Set([RESERVED_OPERATOR_MCP])`).
The **same** modal edits the operator, whose seeded grant is `mcps: [viberr]`
(`app/server/seed/assets/operator.profile.md:22`), and "Edit profile" is offered
for every profile including the operator (`agents-page.tsx:286-289` — only
*Delete* is specialist-gated). `create-profile-modal.tsx:609-614,646-650` then
classifies `viberr` as `missing` and labels the chip
**"No longer in the store — click to remove this grant"**.

**User-visible failure:** an admin opens Edit on the Operator, sees a red/"missing"
chip with an explicit instruction to remove it, clicks it and saves — the operator
loses the governance MCP it needs, even though the resource exists and is reserved.

**Fix:** build the catalog for the profile being edited (`profileKind: initial?.kind
?? "specialist"`), or ship both catalogs and select per profile kind in the modal.

---

### F13-29 (HIGH · governance hole) — org-deleted users survive as project members and still satisfy the last-admin guard

`deleteOrgUser` (`app/server/org/org-users.server.ts:302-322`) deletes the
better-auth identity and the `users` row but never touches project.md
memberships. `app/features/project-settings/membership.server.ts:43-45` then
falls back to `name = member.userId`, so `app/features/policy/policy-page.tsx:91-116`
renders a row named `usr_9f3a…` with an empty email, a "?" avatar and an **enabled**
role radiogroup, counted in "N members" and in every `Role · count` header
(`:79-81,123-127`).

**User-visible failure (the governance part):** `setMemberRole`'s last-admin guard
counts project.md admins (`app/features/policy/policy-actions.server.ts:113-121`),
not live accounts. One ghost admin therefore lets the only real admin demote
themselves — leaving a project whose only "admin" is a deleted account, with no
one able to change policy, manage members, or delete the project.

**Fix:** prune project memberships in `deleteOrgUser`, and/or filter members with
no `users` row out of the admin count and render them as "removed account".

---

### F13-30 (HIGH · sensitive data past its own gate) — raw run logs, wire envelopes and session ids are served to non-members

`app/routes/project.task.tsx:105` calls `listRunsForTask` behind `requireUser`
only (the layout at `app/routes/project.tsx:38` is likewise membership-free — the
deliberate app-wide task read), and the payload carries `lines`, `raw[]` (the exact
stored wire envelopes) and `sid`
(`app/features/runtime/runtime-types.ts:97,121-126`).
`task-detail-page.tsx:1308` renders `AgentLogsPanel` with no role gate.
Meanwhile the two resource routes that serve the *same* material explicitly
require membership, with comments saying raw logs and provider transcripts are the
most sensitive run artifacts (`app/routes/resources.run-log.ts:47`,
`app/routes/resources.session-export.ts:44`).

**User-visible failure:** a non-member opens a task URL and reads the full agent
console including the `{ } raw` envelopes and the provider session id — but the
live tail silently 403s (`use-run-log-stream.ts:121` swallows it) and Export
downloads a 403 body. The surface is simultaneously more permissive than its own
data routes and broken.

**Fix:** decide one policy. Either gate `runtime` in the loader on membership
(return `[]` plus an honest "logs are member-only" empty state), or drop
`lines`/`raw`/`sid` for non-members and keep the summary strip.

---

### F13-31 (MED · optimistic success with no rollback) — Appearance panel (motion, timeline default, theme)

`app/features/profile/profile-page.tsx:303-313` (`flipMotion`) and `:315-321`
(`pickTl`) set local state, mutate `document.documentElement.dataset.motion`,
submit, then `push(...)` immediately. The shared `prefsFetcher` result handler
(`:221-232`) **returns early unless `data.intent === "set-notif"`**, so
`set-motion` and `set-tl-default` failures are consumed by nobody: no error toast,
no rollback of the toggle, no rollback of `data-motion`. The next root
revalidation re-renders `<html data-motion>` from the unchanged server pref, so
the DOM snaps back while the control still reads "on".
`app/routes/profile.tsx:158-167` (`onTheme`) has the same shape — contrast
`user-menu.tsx:79-82`, which settles on the result correctly.

Note this is *not* the same as pass-12's RU-1 (which fixed the re-pick no-op at
`:316`); the failure path was never wired.

**Fix:** give Appearance its own fetcher and route it through `useFetcherResult`
with rollback, exactly as `ProfileNotifications` does.

---

### F13-32 (MED · unreachable error handling) — a CSRF failure blows the whole app to the root boundary

`assertCsrf` throws a raw `Response` (`app/server/auth/csrf.server.ts:29-38`) and
is called **before** the try/catch in `app/routes/profile.tsx:60` (the `try` opens
at `:64`), and unguarded in `notifications.read.tsx:25` and `prefs.theme.tsx:23`.
A thrown response from a fetcher renders the nearest boundary, so the entire UI is
replaced by root's "403 Forbidden" page (`root.tsx:159-201`).

**Consequence:** the carefully written `{ok:false,error}` toast branches in
`top-bell.tsx:49-57`, `notifications.tsx:62-70` and `user-menu.tsx:79-82` — all
commented "P11-40: reports the failure instead of a false success" — can only fire
for validation cases the UI cannot actually produce. The realistic failure
(expired session) takes the other path: `requireAuth` throws `loginRedirect`
(`require-user.server.ts:159`), which the fetcher follows as a full navigation to
`/login`, discarding unsaved fields.

**Fix:** move `assertCsrf` inside the try and map it to `{ ok:false, error }`.

---

### F13-33 (MED · silent data loss) — Profile identity fields commit on blur only, and Escape unmounts before blur

`app/features/profile/profile-page.tsx:101-104,132` — the only save path is
`onBlur`/Enter. `useDialog`'s cancel handler (`app/ui/use-dialog.ts:88-92`) closes
and unmounts the overlay on Escape while focus is still in the input, and React
does not fire `onBlur` on unmount.

**User-visible failure:** type a new display name, press Escape, reopen — the old
name is back with no warning. (Clicking the X works, because mousedown blurs
first.) **Fix:** commit on dialog `cancel`/`close`, or guard dismissal while dirty.

---

### F13-34 (MED · toasts unreadable inside overlays) — the toast host renders below `dialog::backdrop`

`app/ui/toast.tsx:62-73` mounts `.toast-wrap` at the app root
(`app/app.css:1060`, `position:fixed; z-index:100`), outside any dialog.
`PageOverlay` (`app/ui/page-overlay.tsx:22-38`) opens with `showModal()`
(`use-dialog.ts:82`), which promotes the dialog to the **top layer**; the
`dialog::backdrop` veil (`app/app.css:1279`) therefore paints over every
normal-layer element regardless of z-index. On viewports under ~820 px the card
itself (`app/app.css:2045-2050`) also overlaps the toast.

**User-visible failure:** every confirmation inside `/profile` and
`/notifications` — password changed, notification routing saved, mark-all-read —
appears dimmed or clipped. **Fix:** render the toast host into the open dialog, or
use a top-layer `[popover]` host.

---

### F13-35 (MED · duplicate log lines) — the run-log tail has no in-flight guard or seq dedupe

`app/features/runtime/use-run-log-stream.ts:146-157` calls
`fetchTail(runId, cursor.headSeq)` on every `run.log-appended`, but `headSeq` only
advances after the fetch resolves (`:132`) and the append (`:133-137`)
concatenates blindly. The sink publishes one event per console line
(`app/server/runtimes/run-sink.server.ts:109`).

**User-visible failure:** on a chatty run each line appears 2–3× and the "N events"
counter over-counts until the next revalidation re-seeds from the loader.
**Fix:** skip while a fetch for that `runId` is in flight and drop lines whose
`seq <= headSeq` on append.

---

### F13-36 (MED · missing state branch) — a rejected PR looks like an open PR on the task page

`app/features/task-detail/task-detail-page.tsx:139-151` branches only on
`merged` and `accepted`; `PR_STATE_VALUES` also contains `"closed"`
(`app/schemas/task-file.schema.ts:226`), which pass-12's NEW-1 fix made a
first-class state. A PR closed without merging renders as a blue `info` pill
"PR #14" — visually identical to in-review. The GitHub page and the review queue
both render it correctly (`github-pills.ts:37-42`, `review-page.tsx:40-53`).
**Fix:** reuse `prStatePill` here.

---

### F13-37 (MED · ungated control + fake progress) — "Update status" is offered to viewers

`app/features/github/github-view.tsx:444-453` renders the reconcile button
unconditionally, while `reconcile-github` is admin/maintainer
(`app/shared/rbac.ts`, enforced at `app/routes/project.github.tsx:56`). The
handler also pushes `RECONCILE_START_TOAST` ("Updating branch and PR status from
GitHub…") *before* submitting (`github-view.tsx:331`).

**User-visible failure:** a viewer clicks, sees fake progress, then a 403 toast.
The sibling grant-scope control in the same file is correctly gated
(`:347-351,366`). **Fix:** gate on `roleCan(myRole, "reconcile-github")` and push
the start toast only for permitted roles.

---

### F13-38 (MED · wrong explanation) — the agent-logs failure copy is keyed to the viewer's role, not the run

`app/features/runtime/runs-panels.tsx:374-392` derives its footer copy from
`canRetryBackend`, which is `onRetryBackend != null`;
`task-detail-page.tsx:975-991` sets that to `undefined` for anyone without
`run-agents` **and** whenever any run is active.

**User-visible failure:** a quota/backend-unavailable failure reads "stream ended
on a continuity error — see the blocked packet" to a contributor (and to everyone
while another run streams), pointing at a packet that need not exist.
**Fix:** derive the copy from `cur.failedBackendUnavailable`; gate only the button.

---

### F13-39 (MED · menus ignore data the loader already ships) — assign/engage offer agents that cannot do the job

`DeployedSpecialistView` carries `capabilities.{delivery,verdict}`
(`app/server/tasks/specialist-run.server.ts:1477-1486`), but the client type at
`app/features/task-detail/execution-profile.tsx:12-18` declares only
id/name/role/backend/model. So "Assign delivering agent" (`:646`) offers agents
with no repo-write grant — the run starts, streams, and delivers nothing — and the
reviewer menu (`:664-721`) gives no hint which reviewers are `verdictCapable`
(snapshotted at engage time, `specialist-run.server.ts:383`) and therefore
actually gate acceptance. (`model` is likewise declared and never rendered.)
**Fix:** surface `capabilities`; disable/annotate non-delivery agents and badge
verdict-capable reviewers.

---

### F13-40 (MED · empty state contradicts the control next to it) — timeline "this task hasn't started"

`app/features/task-detail/timeline.tsx:451-454` — `items` is the *filtered* view
of an already-bounded slice, but the empty copy is "No activity yet — this task
hasn't started its operator loop."

**User-visible failure:** pick the "Comments" tab on a task whose newest 30 events
are all typed → the panel declares the task never ran, with "Show older events ·
N more" rendered directly below it. **Fix:** distinguish `events.length === 0`
from `items.length === 0`.

---

### F13-41 (MED · offers an action the server rejects) — release dialog hands off to members who cannot own tasks

`app/features/task-detail/release-confirm.tsx:46-50` filters only the current
owner. `OwnerControl` correctly also filters `roleCan(m.role, "own-task")`
(`execution-profile.tsx:111-118`, F10-13), and `setOwner` rejects viewers
(`app/server/tasks/task-actions.server.ts:2238-2243`).

**User-visible failure:** click a viewer's chip → the dialog closes and a toast
says ownership can only go to someone who can own tasks. Chips are also not
disabled while `busy`. **Fix:** apply the same `own-task` filter.

---

### F13-42 (MED · dead-end decision) — `edit_goal` is offered to an owner who cannot edit the goal

`canResolvePacket` includes the task owner
(`app/features/task-detail/task-detail-page.tsx:1169-1170`), but
`canEditGoal={canRunAgents}` (`:1252`) and `update-goal` is admin/maintainer.

**User-visible failure:** a contributor-owner picks "a human refines the task
goal", gets "Decision recorded — type the new goal; the packet clears when it
lands" (`app/routes/project.task.tsx:263`), no editor opens, no Edit button
exists, and the packet stays open forever. **Fix:** hide/disable `edit_goal`
without `update-goal`, mirroring the `accept_completion` treatment at
`decision-packet.tsx:166-169`.

---

### F13-43 (MED · toast asserts an outcome the server did not achieve) — "Retrying on X · streaming to agent logs"

`app/routes/project.task.tsx:261` computes the toast from the packet option's
`kind` alone. `resolvePacket` catches a failed `startAgentRun` and merely appends
a timeline note ("The retry could not start — …",
`app/server/tasks/task-actions.server.ts:3305-3320`) before returning `ok`.

**User-visible failure:** the user is told the retry is streaming; nothing streams;
the truth is buried in the timeline. **Fix:** return the start outcome and choose
the toast from it.

---

### F13-44 (MED · accessibility) — the decision-packet radiogroup has no roving tabindex and never moves focus

`app/features/task-detail/decision-packet.tsx:124-148` — every `role="radio"`
stays tabbable (no `tabIndex`), and the container's arrow handler (`:114-122`)
only changes `sel`, so DOM focus stays on the previously focused radio while
`aria-checked` moves elsewhere. Screen-reader users get no feedback and Tab walks
every option. This is the app's highest-stakes control (it resolves governance
decisions). **Fix:** `tabIndex={sel === i ? 0 : -1}` plus focusing the newly
selected radio in `move()`.

---

### F13-45 (MED · accessibility) — popovers are rendered before their trigger, and the account menu declares menu roles it does not implement

`app/features/shell/top-bell.tsx:84-136` renders the dialog *before* the button at
`:137`; `app/features/shell/user-menu.tsx:99-172` likewise precedes its button at
`:173`. Nothing moves focus into the popover on open and nothing restores it on
close. The account menu additionally declares `role="menu"`/`role="menuitem"`
(`user-menu.tsx:108`) with no arrow-key handling — a broken menu contract.

**User-visible failure:** a keyboard user activates the bell, presses Tab, and
lands on the account button; the popover they just opened is reachable only by
Shift+Tab. **Fix:** focus the first item on open, restore on close, and either
implement arrow keys or drop the menu roles.

---

### F13-46 (MED · filter/panel mismatch) — Activity's actor filter is page-level in appearance, Stream-only in effect

`app/features/activity/activity-page.tsx:255-266` renders the seg in the page
header with `aria-label="Filter activity"`, above both panels; only `:238-241`
consumes it, and `AuditLogs` at `:341-348` receives the unfiltered list. (Pass 12
recorded this as "mock parity"; it is still a live honesty defect.)

**User-visible failure:** the user picks "Humans", the audit panel keeps showing
agent and system rows, and they conclude either the filter is broken or those rows
are human. **Fix:** move the seg into the Stream panel head and relabel it, or
apply the same predicate to audit entries.

---

### F13-47 (MED · counts describe the page, not the project) — Activity "N events" and a "Show older" that stops working

`app/features/activity/activity-page.tsx:241` computes `total` from the filtered
*loaded* slice (default 200 rows, `feed-limits.ts:8`) and renders it as
"{total} events" (`:279-281`) beside "Show older events · {streamRemaining} more"
computed from the true `streamTotal` (`:242`). Separately, `:328-333` submits
`Math.min(stream.length + STREAM_STEP, STREAM_MAX)`, so once `stream.length ===
STREAM_MAX` the click is a no-op while the button still promises N more (same at
`AUDIT_MAX`, `:345-347`).

**Fix:** label the count "N of M loaded" (or filter server-side), and compute
`remaining` against the ceiling so the button hides or says "showing the newest
2000".

---

### F13-48 (MED · two surfaces answer the same question differently) — "Waiting on me" (board) vs "Waiting on your acceptance" (review)

The board's `waitingOnMe` comes from decision-*object* presence
(`app/routes/project.tsx:47-58` → `decisionsRequiring`, which only scans tasks
with a packet or recommendations, `app/server/projections/decisions.server.ts:90-99`).
The review queue deliberately does **not** require a decision object
(`app/server/projections/review-queue.server.ts:111-117`, "not by decision-object
presence — a review-stage task waiting on a human can have no packet").

**User-visible failure:** a maintainer sees VIB-142 under "Waiting on your
acceptance" in Review, while the board's "Waiting on me · N" chip excludes it and
the card reads "waiting on a human" (`board-page.tsx:66-70`,
`board-filters.ts:26`). **Fix:** union the acceptance-authority predicate into the
layout loader's `waitingOnMe`.

---

### F13-49 (MED · hardcoded stage vocabulary) — the review queue names stages the project may not have

`app/features/review/review-page.tsx:106-115` ("Review → Done · human only") and
`:148-152` ("moves the task to **Done**"). The queue itself resolves the review
stage dynamically and its own docstring notes that on a Lightweight board the
review role is `doing` (`review-queue.server.ts:8-20`); the Lightweight template
ships `todo/doing/done` (`app/shared/workflow/templates.ts:65-87`) and stages are
renameable. **Fix:** pass the resolved review/terminal stage names from the loader.
(Same family as F13-15.)

---

### F13-50 (MED · stale grants counted and un-removable) — agent profile "Eligible stages · 5 of 4"

`removeStage` drops workflow rules but never prunes agent-profile `stages`
(`app/features/project-settings/settings-actions.server.ts:226-247`), and
`effectiveProfileView` returns them unfiltered
(`app/features/agents/agents-query.server.ts:233`).
`app/features/agents/agents-page.tsx:304-325` prints
`a.stages.length + " of " + stages.length` while rendering chips only for live
stages. The editor has the same hole: `stg` seeds from `initial.stages`
(`create-profile-modal.tsx:753`) but `StagesField` (`:397-411`) draws only live
stages, so the stale id is re-persisted on every save.
**Fix:** intersect with live stage ids in `effectiveProfileView`, or render stale
ids as removable "missing" chips like the resource picker does.

---

### F13-51 (MED · count means something other than its label) — Agents "N active tasks · one operator each"

`app/features/agents/agents-page.tsx:633,730-734` counts operator *engagements*,
but `createTask` deliberately assigns no operator in the entry stage
(`app/server/tasks/task-actions.server.ts:440-444`).

**User-visible failure:** a board with 12 fresh tasks shows "12" on the Board rail
and "0 active tasks" on Agents. **Fix:** relabel to "tasks with an operator
engaged", or count non-terminal tasks.

---

### F13-52 (MED · list implies choice that does not exist) — "Execution backend" chips, and editing the operator silently drops one

`app/features/agents/agents-page.tsx:354-366` renders one chip per entry in
`a.backends` (the seeded Operator is `[claude, codex]`, Developer
`[codex, claude]`), but runs always take the **first** runnable backend
(`app/server/tasks/specialist-run.server.ts:120-123`,
`app/server/tasks/operator-actions.server.ts:132`) and the Model row resolves for
that primary only (`agents-query.server.ts:203-211`). Compounding it, the editor
is single-select ("pick exactly one", `create-profile-modal.tsx:754-756` seeds
`backends[0]`) and the writer persists `backends: [form.backend]`
(`app/features/agents/agent-profile-actions.server.ts:333`).

**User-visible failure:** the roster reads "Claude Code · Codex" as if either can
run; Codex never does. Then an admin edits the operator's persona for an unrelated
reason and its backend list silently narrows from two to one, with no diff and no
warning in the toast. **Fix:** mark the first chip "primary" and grey the rest (or
render only the effective backend); warn in the modal when
`initial.backends.length > 1`, or preserve the remainder as fallbacks.

---

### F13-53 (MED · a merged run hides its own history) — a resumed agent's earlier runs disappear from the console

`app/server/runtimes/run-projection.server.ts:235-244` collapses all of an
agent's runs into one entry and loads lines/turns/tokens from the *representative*
row only.

**User-visible failure:** `@mention` an agent (which mints a new run row) and the
Agent-logs console silently drops everything it printed before, "N events" resets,
and the Turns/Tokens cells in the live-run strip (`runs-panels.tsx:190-201`)
report only the newest run — while the picker still labels the entry as the
agent's thread. **Fix:** concatenate the group's lines, or label the entry
"run k of n" with a way to reach the earlier ones.

---

### F13-54 (LOW · notifications page) — three smaller honesty defects

- **Read rows are focusable buttons that do nothing.**
  `app/features/notifications/notifications-page.tsx:123-138` gives every stream
  row `role="button"`, `tabIndex={0}` and Enter/Space handling whose only effect
  is `onRead(id)`, and `app/routes/notifications.tsx:84-92` early-returns for rows
  already read. The inner `.keybtn` (`:148-158`) is the only thing that navigates
  — an interactive element nested inside a `role="button"`, which is invalid.
- **"Waiting on you — N decisions" counts post-filter.** `:45-50,93-95` —
  `splitNotifications` applies the All/Unread filter *before* the needs-you split
  (`notifications-page-helpers.ts:21,33`), so three read decisions under the
  Unread filter render "0 decisions" and "Nothing is waiting on you."
- **Bell popover truncation** — see F13-14.

---

### F13-55 (LOW · topbar search) — hardcoded ⌘K and one history entry per keystroke

`app/features/shell/topbar.tsx:140` renders `⌘K` unconditionally although the
handler accepts Ctrl (`:85`). `:63-80`: on a non-board view every keystroke calls
`navigate()` until the location settles, so fast typing can push `?q=a`, `?q=ab`,
`?q=abc` and Back walks the user through partial queries. (The placeholder itself
is honest — `matchesSearch` at `board-filters.ts:51-66` really covers key, title,
branch, owner, specialist, reviewers and operator — but the search only ever
filters the *board*: typing on any other workspace view yanks you there.)
**Fix:** platform-aware hint; `replace: true` after the first navigate.

---

### F13-56 (LOW · shared fetcher) — a pending rollback can be stranded

`app/features/profile/profile-page.tsx:220-232` keeps `pending.current` (toast +
rollback snapshot) while `:832-838` hands the *same* fetcher to the Appearance
panel. A notification flip immediately followed by a motion flip means the
`set-notif` result never arrives, `pending.current` is never cleared, and a later
`set-notif` failure rolls back to a stale snapshot. **Fix:** one fetcher per panel.

---

### F13-57 (LOW · misc. task-detail / runtime residuals)

- **Queued runs render contradictory state.** `runs-panels.tsx:152` shows the
  live strip only for `state === "running"` while the loader's `deliveringActive`
  counts `queued` (`app/routes/project.task.tsx:115-118`) — a queued run shows a
  disabled "Running…" button, a "queued" pill, no strip, and the footer "thread
  alive — no run executing" (`runs-panels.tsx:392`).
- **Unknown timeline event types render a pill labelled "commented."**
  `event-meta.ts:35-37` falls back to comment meta but `timeline.tsx:171-175`
  renders the typed branch because `type !== "comment"`.
- **The agent-logs empty state is unreachable.** `runs-panels.tsx:357-369` is dead
  code: `task-detail-page.tsx:1308` mounts the panel only when
  `runtime.length > 0`.
- **"finished" uses the server clock.** `run-projection.server.ts:64-69` formats
  with `d.getHours()` server-side and carries no date; everything else formats
  client-side from ISO. (Same family as F13-19.)
- **`{ } raw` and `follow` toggles lack `aria-pressed`** (`runs-panels.tsx:429-448`),
  as do the timeline filter tabs (`timeline.tsx:348-357`).
- **Goal draft never resyncs.** `task-detail-page.tsx:368` seeds `draft` once; the
  Edit button re-seeds (`:467`) but the `edit_goal` packet path (`:385-391`) does
  not, so the packet-opened editor can save stale text over another user's edit.
- **The task's GitHub card has no freshness cue.** Diff/commits/PR
  (`task-detail-page.tsx:161-193`) come from the same cached projection the GitHub
  page labels "Updated 3m ago / Not yet synced" (`github-view.tsx:431-443`).

---

### F13-58 (LOW · misc. board / agents / policy residuals)

- **`?profile=` is read once at mount and never written back.**
  `agents-page.tsx:597-599` — sidebar clicks don't update the URL, so the
  selection can't be shared, refreshed, or navigated with Back/Forward.
- **`mini-seg` groups claim `role="radiogroup"` with no radios.**
  `activity-page.tsx:255-265`; the Board's Board/List seg
  (`board-page.tsx:606-623`) and the Agents Profiles/Live seg
  (`agents-page.tsx:695-712`) have neither role nor `aria-pressed`. Policy does it
  correctly (`policy-page.tsx:99-112,350-374`) and the board filter chips already
  use `aria-pressed` (`board-page.tsx:658-671`). (Same family as F13-13.)
- **Stage moves are keyboard-reachable only in Board view.** `TaskCard` gets the
  `StageMenu` (`board-page.tsx:213-221`), `ListView` (`:338-393`) renders no move
  control at all — so the list view has no keyboard equivalent for drag-and-drop.
- **Two role-literal drift hazards.** `app/routes/project.board.tsx:95-96`
  hardcodes `admin|maintainer` for drag/move while the server gate is
  `reorder-board` (`app/shared/rbac.ts:57`) — the same file uses `roleCan` at `:99`
  precisely to avoid this. `policy-page.tsx:425` enables the member seg on
  `edit-policy` while `set-role` enforces `manage-members`. Equivalent today.
- **Magic stage id fallback.** `board-page.tsx:1005` falls back to the literal
  `"triage"` when a project has no stages — a create that can only fail
  server-side. (Same family as F13-15.)
- **Profile modal submit has no busy affordance** (`create-profile-modal.tsx:698-707`
  sets no `aria-busy`, unlike `board-page.tsx:549-558`), and **delete jumps the
  selection before the server answers** (`agents-page.tsx:676-682` sets
  `sel = "operator"` pre-submit, so a rejected delete strands the user).

---

## Coverage note

Everything above was read from source. Systematic sweeps that came back **clean**
and are worth recording so a later pass does not re-do them:

- **Intent wiring**: 74 server intents ↔ client submissions, both directions, no
  orphans (see §0).
- **Icon-only buttons**: 236 `<button>` elements scanned; 11 icon-only, all 11
  labelled (8 `aria-label`, 3 `title`); `Icon` is `aria-hidden`
  (`app/ui/icon.tsx:74`).
- **Dialogs**: all 15 native `<dialog>`s carry `aria-label`/`aria-labelledby`,
  confirms carry `role="alertdialog"`, all open through `useDialog` + `showModal`
  (focus trap, Escape, backdrop dismiss, focus restore, scroll lock).
- **Mock data**: no fake counts, invented names, placeholder avatars, lorem text
  or static timestamps survive in any render path. Avatars are real initials +
  a derived tone; all counts trace to disk scans or DB rows.
- **Enum coverage**: `TIMELINE_EVENT_TYPES`, `READINESS_VALUES`,
  `VALIDATION_VALUES`, `RepoAccessResult` statuses and `RunState` all have
  branches with fallbacks (the two exceptions are F13-17 and F13-36).
- **Degraded states that are honest**: no-repo / no-credential / expired /
  revoked / org-approval / offline connection pills (`github-pills.ts:50-78`),
  `exportable=false` hides Export, unconfigured backends disabled in the operator
  picker, KB "re-scanned never", MCP `stale`, GitHub-import error kinds, review
  queue's "waiting on a human" vs "agent working" split, and the archived-project
  read-only banner.

</content>
</invoke>
