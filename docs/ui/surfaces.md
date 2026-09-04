# Surfaces and routes

> Every URL the app serves, who may reach it, what it renders and which form intents
> it accepts. Source of truth: `app/routes.ts`, `app/routes/*`, `app/features/shell/*`.
> Verified against `main` @ `68b5480` (2026-09-01); the ruling-121 rows and the shell
> note re-verified against the working tree on 2026-09-03, after the ruling's adversarial
> review. The behaviour behind each intent is in the domain docs linked per row.
>
> Updated 2026-09-02 for ruling 127 (branch `claude/per-user-codex-auth-difdnn`):
> `/profile` gained the **Agent accounts** panel and its five intents, and
> `/resources/backend-login` is a new fetcher target that answers the CALLER's own
> hosted sign-in session. Agent backends are connected per person there, never per
> deployment.

## 1. Route table

Guards: **user** = signed-in session (`requireUser` / `requireAuth`); **member** =
project member, non-members and unknown slugs get the same 404 (`requireVisibleProject`
/ `requireProjectMember`, org admins override with an audit row); **org admin** =
`requireRole("admin")`; **form** = `requireFormAction` (session + CSRF + intent) on
POST.

| Path | Module | Guard | Renders / does | Intents |
|---|---|---|---|---|
| `/login` | `login.tsx` | public (CSRF on POST) | local sign-in, forced-reset mode; OAuth buttons only when a provider is configured and enabled | `login`, `set-password` |
| `/logout` | `logout.tsx` | CSRF | better-auth sign-out | |
| `/api/auth/*` | `api.auth.$.ts` | better-auth | six allow-listed paths incl. OAuth callbacks | |
| `/` | `_index.tsx` | user, form | Home: pinned and all projects, waiting counts, store strip (org admin), new-project modal | `create-project`, `pin`, `rescan`, `rebuild-projections` (org admin), `view` |
| `/projects` | `projects.tsx` | user | redirects to `/` | |
| `/projects/:slug` | `project.tsx` + `project._index.tsx` | user → member (404 parity) | workspace shell (rail, topbar, palette, live updates); index redirects to the board | |
| `/projects/:slug/board` | `project.board.tsx` | member, form | board by stage, filters in the URL (`filter`, `view`, `q`), drag-and-drop, accept-from-board confirm | `create-task`, `reorder`, `rescan` (admin/maintainer) |
| `/projects/:slug/review` | `project.review.tsx` | member | review queue split into "Waiting on your acceptance" and "Still in review" | |
| `/projects/:slug/controller` | `project.controller.tsx` | member (CSRF checked as a result, not a throw) | the instance controller addressed inside this project; goal chain controls | `send`, `goal-op` (`pause`, `resume`, `cancel`, `skip_link`, `retry_link`) |
| `/projects/:slug/agents` | `project.agents.tsx` | member, form | deployed roster, live runs, profile detail, capability matrix modal | `create-profile`, `update-profile`, `deploy-profile`, `delete-profile` |
| `/projects/:slug/policy` | `project.policy.tsx` | member, form | role matrix (rendered from `rbac.ts`), member roles, transition boundaries, guardrails (ruling 112) | `set-role`, `set-boundary`, `set-guardrail` |
| `/projects/:slug/github` | `project.github.tsx` | member, form | credential card (with the workflow-scope advisory, ruling 144), repo state, branched tasks, scope violations, update status | `set-credential`, `clear-credential`, `grant-scope`, `reconcile` |
| `/projects/:slug/activity` | `project.activity.tsx` | member | activity feed with day groups; audit column (compacted, ruling 61) | |
| `/projects/:slug/settings` | `project.settings.tsx` | member, form (admin for writes) | project profile, stages, members, repository, branch cleanup, archive/delete | `save-project`, `add-stage`, `rename-stage`, `remove-stage`, `reorder-stages`, `invite`, `remove-member`, `set-credential`, `clear-credential`, `grant-scope`, `repair-repo`, `set-branch-cleanup`, `archive-project`, `delete-project` |
| `/projects/:slug/tasks/:key` | `project.task.tsx` | member, form | task detail: state (the "Waiting on" row reads "Other work: …" for a held task), the hero's wait chips (one neutral link per `blockedBy` entry with its state, ruling 131), execution profile (the operator run control carries a hold note with Run left enabled), packet, recommendations, Details (a "Blocked by" row and its own "Edit what it waits on" form), timeline, runs, GitHub trace (with the "Unpushed" row and the "Push `<sha>` to PR #N" control when the open PR lacks the delivered revision, ruling 134(c); disabled with the refusal named for a diverged remote), diagnostics | `comment`, `transition`, `update-goal`, `set-task-metadata`, `set-task-dependencies` (ruling 131: the full `blockedBy` list, empty clears and releases), `owner-take`, `owner-release`, `owner-assign`, `run-agent`, `run-operator`, `run-interrupt`, `release-agent`, `resolve-packet`, `apply-recommendation`, `dismiss-recommendation`, `deliver-review`, `accept-completion`, `force-accept`, `complete-merge`, `request-maintainer-decision`, `schedule-action`, `cancel-schedule`, `archive-task`, `restore-task` |
| `/projects/:slug/tasks/:key/attachments/:file` | `task-attachment.ts` | member | raw bytes, whitelist renders inline, `?download=1` forces the save dialog (ruling 105) | |
| `/org/settings` | `org.settings.tsx` | org admin | tabs: Users & access, GitHub connections, Sign-in & SSO, Agent resources, Controller settings; audit export card; concurrency | see §3 |
| `/org/settings/audit-export` | `org.settings.audit-export.ts` | org admin | CSV/JSON download, 100 000-row cap | |
| `/controller` | `controller.tsx` | user (CSRF checked as a result, not a throw) | instance controller conversation (per user) | `send` |
| `/insights` | `insights.tsx` | org admin | run analytics: counts, cost, tokens, outcomes, backend quota readings (a refused or exhausted row names whose account, a reading names the hour of its reset, ruling 130(d)) | |
| `/profile` | `profile.tsx` | user | identity, password, **Agent accounts** (ruling 127: connect Claude and Codex for yourself; ruling 130(d): each connected card shows the last refusal Viberr observed on YOUR account, never another person's), GitHub identity disconnect, theme, motion, notification and timeline prefs | `identity`, `change-password`, `github-disconnect`, `set-motion`, `set-notif`, `set-tl-default`, `backend-login-start`, `backend-login-code`, `backend-login-cancel`, `backend-set-key`, `backend-disconnect` |
| `/notifications` | `notifications.tsx` | user | newest 200, auto-read on viewing the target | |
| `/notifications/read` | `notifications.read.tsx` | user | fetcher target | `read-all` |
| `/prefs/theme` | `prefs.theme.tsx` | user | theme cookie + user row | |
| `/resources/events` | `resources.events.ts` | user (401 JSON) | SSE stream, scopes `project:`, `task:`, `projects`, `user` | |
| `/resources/run-log` | `resources.run-log.ts` | member / conversation owner | run log lines by `since` or `before` | |
| `/resources/health` | `resources.health.ts` | public | liveness; `?probe=readiness` → 503 when degraded | |
| `/resources/search` | `resources.search.ts` | user | ⌘K palette query over visible projects | |
| `/resources/model-catalog` | `resources.model-catalog.ts` | user | models and efforts per backend (Claude enhanced with the VIEWER's own account) | |
| `/resources/controller` | `resources.controller.ts` | user; a project or task scope the viewer cannot reach answers an empty `unavailable` view (GET) or `{ ok:false }` (POST), never a thrown response — it feeds a root-owned fetcher | the controller dock's view for the scope the person is standing in (ruling 121) | `send` (`text`, `conversationId`, `project`, `task`, `surface`) |
| `/resources/backend-login` | `resources.backend-login.ts` | user | `?backend=claude\|codex` → the CALLER's own hosted sign-in session (`{ login, health }`), polled every 2 s by Profile → Agent accounts; an unknown backend is a 400 `{ error: { code: "validation_failed", message } }`, and it reads nobody else's session | |
| `/resources/session-export` | `resources.session-export.ts` | member / conversation owner | resume-script download | |

The five `backend-*` intents on `/profile` are the Agent-accounts panel: `backend-login-start`
{backend, method} spawns the vendor's own binary (`claude auth login --claudeai|--console`,
`codex login --device-auth`) in that person's runtime home; `backend-login-code` {backend, code}
writes Anthropic's one-time code to the child's stdin (Claude only); `backend-login-cancel`
{backend} kills it; `backend-set-key` {backend, kind, secret} verifies and seals a pasted API
key or ChatGPT workspace access token; `backend-disconnect` {backend} runs the vendor logout,
deletes the credential file and drops the row. Full behaviour in
[../domain/auth-and-rbac.md §7](../domain/auth-and-rbac.md#7-profile-and-preferences-profile).

Intents behind `project.task.tsx` are explained in
[../domain/task-lifecycle.md](../domain/task-lifecycle.md); GitHub intents in
[../domain/github-delivery.md](../domain/github-delivery.md); agent intents in
[../domain/agents-and-runtime.md](../domain/agents-and-runtime.md); org settings in
[../domain/auth-and-rbac.md](../domain/auth-and-rbac.md#4-org-settings-orgsettings-org-admin-only).

## 2. The shell

- **Rail** order and copy are exact: Board · Review queue · Controller · Agents ·
  Policy · GitHub · Activity · Settings (`WORKSPACE_NAV`). The task route counts as
  "Board" for crumb and rail purposes. The rail count includes Done; the policy
  violation badge is the open-violation count.
- **Board URL state** lives only in the query string (`filter`, `view`, `q`); `boardHref`
  keeps it when navigating from the board itself and drops it from anywhere else.
- **⌘K palette** is mounted by Home, the workspace layout and the pathless
  `palette-shell` layout that wraps `/org/settings`, `/controller`, `/insights`,
  `/profile` and `/notifications`, so the shortcut works app-wide without
  double-registering.
- **Topbar**: project crumb, notifications bell (popover), user menu ("Instance
  settings" for org admins, "<name> · settings" for project settings).
- **Live updates** are mounted by the workspace layout, Home, Notifications and the
  controller page; every governed change arrives by loader revalidation. The rail
  shows "live updates paused" while the stream reconnects.
- **The controller dock** (ruling 121) is mounted once by `root.tsx` on every signed-in
  surface except the two controller pages, `/login`, and `/profile` and `/notifications`
  (both render their whole page inside a `showModal()` overlay, which would leave the
  dock inert behind it): a floating bottom-right button named `Controller · <scope>`
  opening a non-modal panel bound to the current instance, board or task (a bottom sheet
  at ≤ 720 px). Its composer is disabled, with the same sentence the full page uses,
  when the VIEWER has not connected Claude (ruling 127). Details in
  [../domain/controller-and-goals.md §2.1](../domain/controller-and-goals.md#21-the-dock-ruling-121).
- **Theme**: light / dark / system, per user plus the `viberr_theme` cookie for
  first paint. Motion preference is a user pref.
- **Responsive**: same surface, reflowed; the rail collapses at ≤ 720 px, the topbar
  trims at ≤ 760 px. There is no review-first mobile mode.

## 3. Org settings intents

`org.settings.tsx` accepts: users (`invite-local`, `invite-github`, `invite-google`,
`invite-domain`, `domain-remove`, `user-role`, `user-edit`, `user-disable`,
`user-enable`, `user-remove`, `user-reset-password`), connections (`connection-add`,
`connection-replace`, `connection-default`, `connection-remove`), sign-in
(`oauth-save`, `oauth-test`, `oauth-toggle`, `oauth-remove`), resources (`kb-save`,
`kb-reindex`, `kb-delete`, `skill-save`, `skill-delete`, `mcp-save`, `mcp-test`,
`mcp-delete`, `store-mkdir`, `store-upload`, `store-read-doc`, `store-write-doc`,
`store-delete`, `store-import-github`), agent templates (`agent-save`, `agent-delete`),
controller (`controller-save`), audit (`audit-export-s3`, `s3-config-save`,
`s3-config-clear`), runtime (`set-concurrency`).

The **Controller settings** tab is the one org-settings surface whose controls are not
all live (rulings 106, 107, 108): model and effort use the agent profile editor's own
catalog pickers and are always editable; the skills, knowledge-base and MCP grant lists
and the doctrine body render read-only unless the matching
`VIBERR_UNLOCK_CONTROLLER_*` variable is set at deploy time, with one note naming the
locked sections and their variables; and the built-in `viberr_ops` diagnostics server
appears in the MCP group as a **pinned, non-interactive chip** — deliberately not a
disabled control, because a toggle that cannot do anything is worse than a statement.
Details in
[../domain/controller-and-goals.md §6](../domain/controller-and-goals.md#6-configuring-the-controller-rulings-106-and-108)
and [../operations/configuration.md §2](../operations/configuration.md).
*(Added 2026-09-02, pass 32 — A00-5.)*

## 4. Screen labels

Every top-level surface and dialog carries `data-screen-label` so tests and agents can
address it by name: `Login`, `Login · set new password`, `Home · project selection`,
`Pinned projects`, `All projects`, `Archived projects`, `Store strip`, `New project
modal`, `Board` (a held card or list row leads its state stack with a NEUTRAL "blocked by …" chip whose title lists every entry with its state, ruling 131), `Empty state`, `Review queue`, `Controller`, `Agents`, `Policy`,
`GitHub`, `Activity`, `Settings`, `Task detail · not found`, `Accept completion dialog`,
`Archive task dialog`, `Release ownership dialog`, `Packet archive dialog`, `Packet
discard dialog`, `Packet collision dialog`, `Attachment lightbox`, `Command palette`,
`Notifications`, `Notifications popover`, `Profile & preferences`, `Instance settings`,
`Settings · Users & access`, `Settings · GitHub connections`, `Settings · Sign-in &
SSO`, `Settings · Agent resources`, `Controller settings`, `Controller dock` (the
panel, ruling 121), `Insights`, `Capability matrix modal`, `Agent profile modal`, and
the six confirms the shared `ConfirmDialog` now names: `Resource removal dialog`,
`Stage removal dialog`, `Member removal dialog`, `Schedule cancel dialog`,
`Interrupt run dialog`, `Dismiss recommendation dialog`. The task page's own label comes
from the shell model. Three labels are composed at render time rather than listed here:
`Files · <resource>` (the store browser), `Project card · <name>` / `Project row · <name>`
(home) and `<page> · overlay` (`PageOverlay`).

*(Corrected 2026-09-03, pass 33 — D33-2/D33-3. This section stated the contract as
universal while the shared `ConfirmDialog` backing seven confirms carried no label at all,
`InsightsPage` was the one full-page surface without one, and two agent modals were
unlabelled. `screenLabel` is now a REQUIRED prop on `ConfirmDialog`, so a new call site
cannot rejoin the gap silently — the typecheck refuses it.)*

## 5. Copy rules that tests enforce

- Readiness pills come from one table (`READINESS_DISPLAY` in `app/ui/pill.tsx`);
  "accepted", "merged", "agent working" and "goal edit pending" (a decided `edit_goal`
  packet, ruling 138) are display states, never stored.
- Backend label is "Claude", never "Claude Code", except for the product itself (CLI
  login, transcript retention) (ruling 92).
- The retired "primary specialist" vocabulary may not appear in seeded assets, skills,
  KB docs or templates (`app/features/retired-vocabulary.test.tsx`); a sibling test
  bans "govern*" vocabulary in UI copy while exempting agent prompt text.
- Queue rows say "Review", not "Accept" (ruling 30). The board's attention chip is
  "Blocked or waiting" and excludes `input_required` while an agent is working (rulings
  36, 91).
- A failure toast never renders the success tick: the kind is passed from the server
  result (`use-action-toast.ts`).
- **Every attachment kind opens a card, and every card carries Download** (ruling 105):
  images show the picture, text files (txt/log/md/json/yml/yaml/csv) a read-only
  monospace reader, anything else an honest "no in-app preview" note. A body whose
  fetch proved the file unservable (404 after the completion-time prune, 413 over the
  50 MB cap, an auth redirect) reports the failure and drops Download rather than
  saving an error body under the real filename. The `Attachment lightbox` screen label
  covers all three. *(Added 2026-09-02, pass 32 — A00-3: the docs described the panel
  as image thumbnails plus a lightbox, which was the pre-ruling-105 surface.)*
- Timestamps render through `app/shared/dates/format.ts` only: zero-padded `HH:MM`,
  `{day} · {time}`, relative forms. **The hydration contract** (pass 34, C6): a
  timestamp's first pass depends on the timestamp alone — the `*UTC` formatters take no
  `now` and render the absolute UTC day + UTC clock (`Jul 3 · 23:59`), identical on the
  server and in any viewer's browser at any clock — and an effect swaps in the
  viewer-local form after hydration (`LocalDayDotTime`, `LocalRelative`, `useHydrated`
  in `app/ui/local-time.tsx`; the console's line clocks sit behind the same flag).
  Calendar dates (`formatCalendarDate`, host-zone by construction) render through
  `LocalCalendarDate` for the same reason: `YYYY-MM-DD (UTC)` first, the local calendar
  date after hydration. Gated by `app/features/task-detail/hydration-determinism.test.tsx`
  (a real `renderToString` → `hydrateRoot` of the task page across the UTC/Auckland zone
  pair and the UTC-midnight clock pair, interrupted hydration included) and
  `e2e/06-activity-hydration.spec.ts`. *(Added 2026-09-04, pass 34 — `formatDayDotTimeUTC`
  used to sample `now` while documenting itself as the deterministic first pass, and four
  surfaces rendered a host-zone calendar date unguarded.)*
- **The collision confirm renders TWO shapes** (pass 34, C3/U34-8): with an unowned PR
  recorded it names the stranger, its pull request and the stale branch ("Clear collision
  & redeliver"); with none it describes THIS task's own remote branch and says no pull
  request is closed ("Delete branch & redeliver"), because that is what
  `resolveRemoteBranchCollision` actually does then. In BOTH shapes, and in the archive
  dialog's delete-the-branch variant, an OPEN pull request of the task's own raises a warn
  row naming the refusal (`deleteTaskRemoteBranch` never deletes a branch a PR is open on)
  before the button is pressed, rather than after the click.
- Settings headings name their scope: "Instance settings" versus "<project> · settings"
  (ruling 32).
- **No surface gates AUTHORING on the viewer's own agent account** (ruling 127): a run
  bills the task owner, so the agent profile editor's Execution backend chips are always
  live (a fresh instance where nobody has connected anything must still be able to create
  profiles) and an unconnected viewer gets a rendered note under the chips, never a
  disabled chip with the reason hidden in a `title` no browser opens: "You haven't
  connected <Backend>. You can still pin this profile to it: runs use the task owner's
  account … Connect <Backend> on your Profile → Agent accounts to run it on the tasks you
  own." The Agents roster states the rule plus a count ("Runs use the task owner's Codex
  account · 3 of 7 members connected"); the loader ships that one `backendHealth` probe
  and no second availability pair. *(Added 2026-09-02 for ruling 127 — the editor
  initially inherited the pre-ruling "disable an unconfigured backend" rule, which now
  reads as the author's own credential and blocked profile creation outright.)*
- A "Retry on <other backend>" offer is rendered only where the retry could actually run,
  and the console explains a withheld one (see
  [../domain/task-lifecycle.md](../domain/task-lifecycle.md), the owner-is-who-a-run-bills
  bullet).
- **Every Agents Live row states what a run is doing** (F34-5): an engagement's status is
  read from its own `agent_runs` row first — "coordinating" (operator) and "working" name a
  running row and are the only rows that pulse, "queued" a run admitted but not yet given a
  slot — and only an engagement with no live row reads the task's `waiting` ("packet open"
  with a packet, "waiting on a human", "on call"). The rule is the same for every
  engagement kind; the mock's "anchored · on call" reviewer literal is gone. The stats row
  counts runs in flight ("agent threads with a run in flight") and task-level waiting
  ("agent threads on tasks waiting on a human · this project" — an engagement running on a
  human-waiting task still counts there). Pinned by
  `app/server/projections/agent-deployments.server.test.ts`, `agents-page.test.tsx` and
  `retired-vocabulary.test.tsx`. *(Added 2026-09-04, pass 34 — B3: the projection derived
  "working" from `waiting === "agent"`, so a deliverer whose run had finished read "working"
  for as long as the operator's turns kept the task agent-waiting, while the reviewer that
  was running read idle.)*
- **The Eligible stages panel says what "N of M stages" gates** (ruling 133 clause c): under
  the chips it always renders "Eligibility decides where this profile may be newly engaged.
  Once it delivers a task it may be prompted on that task at any stage." and appends "A
  supporting or reviewing engagement runs only at the stages above." only for a profile that
  is actually scoped on this board — not for `spanAll`, an empty declaration, or a
  declaration that resolves to nothing here (R14-1 rule 3), where naming "the stages above"
  would name a scope the profile does not have. The profile editor's Eligible stages hint
  reads "stages where this profile may be newly engaged". Pinned by `agents-page.test.tsx`.
  *(Added 2026-09-04, pass 34 — A22.)*
