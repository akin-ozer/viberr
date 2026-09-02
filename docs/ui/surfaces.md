# Surfaces and routes

> Every URL the app serves, who may reach it, what it renders and which form intents
> it accepts. Source of truth: `app/routes.ts`, `app/routes/*`, `app/features/shell/*`.
> Verified against `main` @ `68b5480` (2026-09-01). The behaviour behind each intent is
> in the domain docs linked per row.

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
| `/projects/:slug/controller` | `project.controller.tsx` | member, form | the instance controller addressed inside this project; goal chain controls | `send`, `goal-op` (`pause`, `resume`, `cancel`, `skip_link`, `retry_link`) |
| `/projects/:slug/agents` | `project.agents.tsx` | member, form | deployed roster, live runs, profile detail, capability matrix modal | `create-profile`, `update-profile`, `deploy-profile`, `delete-profile` |
| `/projects/:slug/policy` | `project.policy.tsx` | member, form | role matrix (rendered from `rbac.ts`), member roles, transition boundaries, guardrails (ruling 112) | `set-role`, `set-boundary`, `set-guardrail` |
| `/projects/:slug/github` | `project.github.tsx` | member, form | credential card, repo state, branched tasks, scope violations, update status | `set-credential`, `clear-credential`, `grant-scope`, `reconcile` |
| `/projects/:slug/activity` | `project.activity.tsx` | member | activity feed with day groups; audit column (compacted, ruling 61) | |
| `/projects/:slug/settings` | `project.settings.tsx` | member, form (admin for writes) | project profile, stages, members, repository, branch cleanup, archive/delete | `save-project`, `add-stage`, `rename-stage`, `remove-stage`, `reorder-stages`, `invite`, `remove-member`, `set-credential`, `clear-credential`, `grant-scope`, `repair-repo`, `set-branch-cleanup`, `archive-project`, `delete-project` |
| `/projects/:slug/tasks/:key` | `project.task.tsx` | member, form | task detail: state, execution profile, packet, recommendations, timeline, runs, GitHub trace, diagnostics | `comment`, `transition`, `update-goal`, `set-task-metadata`, `owner-take`, `owner-release`, `owner-assign`, `run-agent`, `run-operator`, `run-interrupt`, `release-agent`, `resolve-packet`, `apply-recommendation`, `dismiss-recommendation`, `deliver-review`, `accept-completion`, `force-accept`, `complete-merge`, `request-maintainer-decision`, `schedule-action`, `cancel-schedule`, `archive-task`, `restore-task` |
| `/projects/:slug/tasks/:key/attachments/:file` | `task-attachment.ts` | member | raw bytes, whitelist renders inline, `?download=1` forces the save dialog (ruling 105) | |
| `/org/settings` | `org.settings.tsx` | org admin | tabs: Users & access, GitHub connections, Sign-in & SSO, Agent resources, Controller settings; audit export card; concurrency | see §3 |
| `/org/settings/audit-export` | `org.settings.audit-export.ts` | org admin | CSV/JSON download, 100 000-row cap | |
| `/controller` | `controller.tsx` | user, form | instance controller conversation (per user) | `send` |
| `/insights` | `insights.tsx` | org admin | run analytics: counts, cost, tokens, outcomes, backend quota readings | |
| `/profile` | `profile.tsx` | user | identity, password, GitHub identity disconnect, theme, motion, notification and timeline prefs | `identity`, `change-password`, `github-disconnect`, `set-motion`, `set-notif`, `set-tl-default` |
| `/notifications` | `notifications.tsx` | user | newest 200, auto-read on viewing the target | |
| `/notifications/read` | `notifications.read.tsx` | user | fetcher target | `read-all` |
| `/prefs/theme` | `prefs.theme.tsx` | user | theme cookie + user row | |
| `/resources/events` | `resources.events.ts` | user (401 JSON) | SSE stream, scopes `project:`, `task:`, `projects`, `user` | |
| `/resources/run-log` | `resources.run-log.ts` | member / conversation owner | run log lines by `since` or `before` | |
| `/resources/health` | `resources.health.ts` | public | liveness; `?probe=readiness` → 503 when degraded | |
| `/resources/search` | `resources.search.ts` | user | ⌘K palette query over visible projects | |
| `/resources/model-catalog` | `resources.model-catalog.ts` | user | models and efforts per backend | |
| `/resources/session-export` | `resources.session-export.ts` | member / conversation owner | resume-script download | |

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
modal`, `Board`, `Empty state`, `Review queue`, `Controller`, `Agents`, `Policy`,
`GitHub`, `Activity`, `Settings`, `Task detail · not found`, `Accept completion dialog`,
`Archive task dialog`, `Release ownership dialog`, `Packet archive dialog`, `Packet
discard dialog`, `Packet collision dialog`, `Attachment lightbox`, `Command palette`,
`Notifications`, `Notifications popover`, `Profile & preferences`, `Instance settings`,
`Settings · Users & access`, `Settings · GitHub connections`, `Settings · Sign-in &
SSO`, `Settings · Agent resources`, `Controller settings`. The task page's own label
comes from the shell model.

## 5. Copy rules that tests enforce

- Readiness pills come from one table (`READINESS_DISPLAY` in `app/ui/pill.tsx`);
  "accepted", "merged" and "agent working" are display states, never stored.
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
  `{day} · {time}`, relative forms.
- Settings headings name their scope: "Instance settings" versus "<project> · settings"
  (ruling 32).
