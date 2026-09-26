# Surfaces and routes

> Every URL the app serves, who may reach it, what it renders and which form intents
> it accepts; the shell around the pages; the screen-label contract; and the copy rules
> tests enforce. The behaviour behind each intent is in the domain docs linked per row.
> Source of truth: `app/routes.ts`, `app/routes/*`, `app/features/shell/*`,
> `app/features/controller/controller-dock-context.ts`, `app/root.tsx`,
> `app/features/copy-ban.test.ts`, `app/features/retired-vocabulary.test.tsx`.
> Verified against `main` @ `7d9fbf72` (2026-09-23).

## 1. Route table

Guards: **user** = signed-in session (`requireUser` / `requireAuth`); **member** =
project member, non-members and unknown slugs get the same 404 (`requireVisibleProject`
/ `requireProjectMember`, org admins override with an audit row); **org admin** =
`requireRole("admin")`; **form** = `requireFormAction` (session + CSRF + intent) on
POST. Each intent then checks its own RBAC action ([../domain/auth-and-rbac.md §3](../domain/auth-and-rbac.md#3-roles)).
The intent lists below are every `intent ===` / `case "…"` branch in each route's action.

| Path | Module | Guard | Renders / does | Intents |
|---|---|---|---|---|
| `/login` | `login.tsx` | public; `login` runs the origin check, `set-password` full CSRF | local sign-in, forced-reset mode; with at least one OAuth provider configured the card leads with both provider buttons (an unconfigured one disabled and labelled), with none the local form leads | `login`, `set-password` |
| `/logout` | `logout.tsx` | CSRF | better-auth sign-out | |
| `/api/auth/*` | `api.auth.$.ts` | better-auth | six allow-listed paths incl. OAuth callbacks | |
| `/` | `_index.tsx` | user, form | Home: pinned, all and archived projects, waiting counts, the Settings tiles (connections, users, resources, insights), store strip (org admin), new-project modal | `create-project`, `pin`, `view`, `rescan` (org admin), `rebuild-projections` (org admin) |
| `/projects` | `projects.tsx` | user | redirects to `/` | |
| `/projects/:slug` | `project.tsx` + `project._index.tsx` | user → member (404 parity) | workspace shell (rail, topbar, palette, live updates); index redirects to the board | |
| `/projects/:slug/board` | `project.board.tsx` | member (the layout's `readWorkspace` gate), form | board by stage from its own loader (ruling 457: the columns, as board cards carrying the fields the board reads, `toBoardCard`; the layout carries none) (a card is one status chip, a row of problem chips and an avatar stack, ruling 365), filters in the URL (`filter`, `view`, `q`), drag-and-drop and the card's Move menu (a stage, or Move up / Move down within the lane: the keyboard and single-pointer path to a slot, ruling 455(c)), accept-from-board confirm (the shared accept dialog, whose "Collides" row the board computes from its own cards' `pr.paths`, ruling 475), the shared move-back confirm (ruling 381: a drag or keyboard move to an EARLIER stage asks why first) | `create-task`, `reorder` (carries `reason` on a backward move), `rescan` (admin/maintainer) |
| `/projects/:slug/review` | `project.review.tsx` | member | review queue split into "Waiting on your acceptance" (tasks at a stage the workflow makes acceptance legal from, whose acceptance nothing blocks, for a viewer who can accept) and "Still in review" (every other review-work row: at the review stage, an open review PR at any stage, or a required reviewer's verdict outstanding; a row before the boundary reads "Review in progress at Validation · PR #8 · awaiting verdict", or names the live PR fact instead when it carries one: unpushed revision, conflict, drifted head; U35-5). A row whose open PR shares changed paths with another open PR carries a "collides with <keys>" chip on both rows (ruling 236, read-only). A row's wait tag reads "waiting on you" for the tasks whose next move is the viewer's (`waitingOnViewer`, the same answer the board's loader gives its cards), and an agent still working keeps "agent working", as on the board card (ruling 455). Every row, and the "Review → Done" policy chip, is a link to its page (`<a href>`), never a button that navigates, so a row opens in a new tab (ruling 477(c)). Header: "N in review · M waiting on your acceptance" | |
| `/projects/:slug/controller` | `project.controller.tsx` | member (CSRF checked as a result, not a throw) | the instance controller addressed inside this project: New conversation in the page head, a sticky rail (conversations first, then the Knowledge base panel, then goal chains) and a capped transcript (ruling 419); the Knowledge base panel (`#kb-corrections`, rulings 483 and 497) heads "Knowledge base" with "N corrected" and lists the newest 20 corrections the project's agents wrote: a "Ruling" or "Knowledge base" pill ("Undone" beside it once undone), `<kb>/<doc>`, "Was" and the replaced passage struck through, "Now" (or "Added") and the text written, a collapsed "Evidence", the task (linked), filer, time and id; an org admin gets Undo (confirm "Undo <id>?" with an optional "Why", "Undo correction" / "Keep it") and "Open document"; an undone one reads "Undone by <name> · <time>: <reason>" instead; everyone else reads "An org admin can undo a correction."; none reads "No corrections yet. An agent writes one when its work proves a knowledge-base line wrong."; more than 20 adds "The newest 20 of N. The audit log keeps the rest for 90 days."; proposals filed before ruling 497 follow under "Open proposals (N)" (`#kb-proposals`) with "Filed before corrections were written straight into the document…", each with its pill, `<kb>/<doc>`, "Corrects" and the quoted line, the correction, "Evidence: …", the task, filer, day and id; an org admin gets Promote, Dismiss (confirm "Dismiss <id>?", "Dismiss proposal" / "Keep it"), "Open document", Promote all (two or more) and the note "Promote and Dismiss ask the controller here; it edits the document."; Promote, Dismiss and Promote all post the `send` intent with the request `proposalRequest` / `promoteAllRequest` words, disabled while a message is on its way or Claude is not connected; everyone else reads "An org admin promotes or dismisses proposals."; unseen replies marked (ruling 448); a reply shown from its first line and announced by one always-mounted status region (ruling 476(c), (d)); the Goals head counted by status ("1 active · 1 paused · 2 need attention · 3 settled"), each link row numbered and anchored `#goal-N-link-M`, a started link wearing its board card's status word, "N waiting on you" on the chain, "Planned in <conversation>" under About this chain and "Where this board's chains were planned" in the rail (ruling 476(b), (f), (g), (h)); goal chain controls, `cancel` and skip behind a confirm; with a thread open, its Live-run strip and Agent-logs console (interrupt for the owner or an org admin) | `send` (`text`, `conversationId`, `surface`, `timeZone`), `goal-op` (`op`: `pause`, `resume`, `cancel`, `skip_link`, `retry_link`; `goalId`, `index`, `reason`), `interrupt` (`conversationId`, `runId`), `kb-correction-undo` (`id`, `reason`; org admins, ruling 497) |
| `/projects/:slug/agents` | `project.agents.tsx` | member, form | deployed roster, live runs, profile detail (a copy whose grants differ from its template says so on the scope line and under each list, ruling 156; the project's rulings knowledge base named when one is set, ruling 239; a granted MCP server no run gets tools from is marked, ruling 479(b)), capability matrix modal (enforced capabilities only; advisory lines collapsed under the grid, ruling 479(a)) | `create-profile`, `update-profile`, `deploy-profile`, `delete-profile`, `sync-profile-resources` (org admin only, carries the record's fingerprint, sent from a confirm that names what it removes and adds, ruling 479(d)) |
| `/projects/:slug/policy` | `project.policy.tsx` | member, form | role matrix (rendered from `rbac.ts`), member roles, transition boundaries, guardrails (ruling 112), the required reviewers read-only (ruling 178; edited on Settings) | `set-role`, `set-boundary`, `set-guardrail` |
| `/projects/:slug/github` | `project.github.tsx` | member, form | credential card (with the workflow-scope advisory, ruling 144; an advisory scope is a note, not a violation, ruling 380; its `repo` / `pull_request:write` chips read the project repository's proof, ruling 480; its manage row is **Attach credential**, or **Re-attach connection** + **Remove credential** with **Replace token** linking an instance admin to the connection's Update token and a sentence for everyone else, ruling 480), repo state, branched tasks, scope violations, update status | `reconcile` (`reconcile-github`), `grant-scope`, `set-credential`, `clear-credential` (all three `grant-github-scope`) |
| `/projects/:slug/activity` | `project.activity.tsx` | member | activity feed with day groups; audit column (compacted, ruling 61) carrying the goal-chain rows (ruling 477(b)); every task key is a link to the task (ruling 477(c)) | |
| `/projects/:slug/settings` | `project.settings.tsx` | member, form; writes need `edit-policy` (admin) except `invite` / `remove-member` (`manage-members`, admin) and the credential intents (`grant-github-scope`, maintainer and above) | project profile, stages (the row's dot opens a 20-swatch colour menu, ruling 364), required reviewers (ruling 178: a stage + verdict-capable agent per row under Workflow stages, saved whole), File leases under them (ruling 396: paths as a glob line, the holder task, the reason; a spent lease is marked and "Clear finished" removes exactly those; read-only text without `edit-policy`), Gates under those (ruling 482: a name, the command and a timeout in seconds per row, saved whole; an empty timeout is the 600 s default; at most 10; read-only text without `edit-policy`; the note says Viberr runs each with `sh -c` in a fresh checkout of every delivered revision as the task owner and that acceptance waits until every one exited 0), members (the invite form is a head button opening the `Add member` modal, ruling 148(b)), repository, branch cleanup, archive/delete | `save-project`, `add-stage`, `rename-stage`, `recolor-stage`, `remove-stage`, `reorder-stages`, `set-required-reviewers`, `set-file-leases`, `set-project-gates` (ruling 482: the whole list as one JSON field; a changed list queues the gates on every open delivered task), `invite`, `remove-member`, `set-credential`, `clear-credential`, `grant-scope`, `repair-repo`, `set-branch-cleanup`, `archive-project`, `delete-project` |
| `/projects/:slug/tasks/:key` | `project.task.tsx` | member, form | task detail (page label `Task <KEY>`): state (the "Waiting on" row reads "Other work: …" for a held task), the hero's wait chips (one neutral link per `blockedBy` entry with its state, ruling 131), execution profile (the operator run control carries a hold note with Run left enabled), packet, recommendations (an acceptance card prints the gate's refusal as an alert and its Apply refuses the click while one stands, ruling 162), the accept dialog (its "Collides" row, "Merging this will likely put WEB-2's PR #3 in conflict on `package.json`. Viberr re-checks it right after the merge, and the operator hands a conflict to the delivering agent.", names every other open PR that changes a path this one changes, from the loader's `mergeCollisions`, ruling 475), Details (a "Blocked by" row and its own "Edit what it waits on" form), attachments (every task; "Attach a file" for `attach-file`, ruling 379), timeline (a `proposal` event pills "Proposal", is titled "Proposed ruling change" or "Proposed knowledge-base correction", and links "Open proposals" to the project Controller page's `#kb-proposals`, ruling 483; a `kb_correction` event pills "Knowledge base", is titled "Knowledge base corrected", "Rulings corrected" or "Knowledge-base correction undone", lists "Was" struck through and "Now", and an agent's links "Review or undo" to `#kb-corrections`, ruling 497; a gate run's note pills its ending, "passed", "failed" or "could not run", names its revision, "on `<sha7>`", and is the gate table, ruling 493), runs, GitHub trace (the "conflicts" pill on a conflicting open PR, ruling 162; the "Unpushed" row and the "Push `<sha>` to PR #N" control when the open PR lacks the delivered revision, ruling 134(c), disabled with the refusal named for a diverged remote; ruling 482: a gates pill in the bar and a "Gates" row printing the server's line, "Gates on `<sha7>`: N/M exit 0 (run by Viberr)", then the gate table (ruling 493: per gate its mark, its name, a failure's outcome, its time and a Log button that opens the log in the reader), and "Run gates" / "Run gates again" for maintainer+ or the owner, disabled while a run is queued or running), the accept dialog's "Gates" row (the same line, the failing gates in the same table; a failure is also the Blocked row, so the plain confirm is disabled and force names it under Bypassing), Changes (ruling 484: while the review PR is open and a revision is delivered, a closed panel whose Show changes loads its reader chunk and `…/changes`; each file is a `<details>` of its hunks, a line's number is the button that opens a note under it, and "Send to @<deliverer>" posts every note at once), diagnostics | `comment`, `review-notes` (ruling 484: `notes` as JSON `[{path, line, side, body}]`, at most 50, and the `headSha` they were written on; one comment addressed to the deliverer quoting each `file:line`, through the `comment` door and its toasts), `transition` (ruling 381: a BACKWARD move carries a `reason`, collected by the shared `MoveBackConfirm` dialog and refused server-side without one), `update-goal`, `set-task-metadata`, `set-task-dependencies` (ruling 131: the full `blockedBy` list, empty clears and releases), `owner-take`, `owner-release`, `owner-assign`, `run-agent`, `run-operator`, `run-interrupt`, `release-agent`, `resolve-packet`, `apply-recommendation`, `dismiss-recommendation`, `deliver-review`, `run-gates` (ruling 482: queue the project's gates on the revision under review again; maintainer+ or the owner, audited `task.gates.requested`), `accept-completion`, `refresh-and-review` (ruling 449: the accept dialog's "update the branch and re-review first" when the head that would merge is one no review ran on), `force-accept`, `complete-merge`, `request-maintainer-decision`, `schedule-action`, `cancel-schedule`, `archive-task`, `restore-task`, `attach-file` (ruling 379: the one MULTIPART intent, contributor and above, one file per submit, at most 10 MB) |
| `/projects/:slug/tasks/:key/attachments/:file` | `task-attachment.ts` | member | raw bytes, whitelist renders inline, `?download=1` forces the save dialog (ruling 105); over 50 MB answers 413 | |
| `/projects/:slug/tasks/:key/changes` | `task-changes.ts` | member (404 parity); signed out answers 401, never a login redirect | the Changes panel's read (ruling 484): the delivered revision's files and patches from its pull request, bound to that revision (a PR at another head answers why, not its files), with who a note reaches; `?path=` reads one file the first read left out for size. `shouldRevalidate` false: the panel loads it itself, and its `clientLoader` turns a failed load into the panel's own failure row | |
| `/org/settings` | `org.settings.tsx` | org admin | "Instance settings" under the standalone-page header (ruling 145); tabs in order GitHub connections, Users & access, Sign-in & SSO, Agent resources, Controller (whose note lists grants the controller asked for and cannot make, each naming its unlock variable and the restart and carrying a Decline button, ruling 390); `?tab=resources&kb=<dir>&doc=<path>` (a knowledge-base proposal's "Open document", ruling 483) opens that knowledge base's browser on that document; the run-concurrency and spending-cap rows; the Audit log card (browse, download, and the S3 target as one fact row plus a button that opens the target modal, ruling 148(b); "Export to S3 now" and "Remove" stay on the card) | see §3 |
| `/org/settings/audit-export` | `org.settings.audit-export.ts` | org admin | CSV/JSON download, 100 000-row cap | |
| `/controller` | `controller.tsx` | user (CSRF checked as a result, not a throw) | instance controller conversation (per user), same page layout as the project controller (ruling 419; a reply shown from its first line and announced by one always-mounted status region, ruling 476(c), (d)); with a thread open, its Live-run strip and Agent-logs console (interrupt for the owner or an org admin) | `send` (`text`, `conversationId`, `surface`, `timeZone`), `interrupt` (`conversationId`, `runId`) |
| `/insights` | `insights.tsx` | org admin | run analytics under the standalone-page header (ruling 145): totals, coordination share, outcomes (a restart-interrupted run is stopped, not an error, and a never-started one is out of the completion rate, ruling 158), breakdowns naming what their top 8 left out, the **Prompt cache** table (ruling 369: by run kind and by credential kind; every figure on a `data-` attribute, rows keyed `data-cache-row="by run kind:primary"`), oversight cards naming their exceptions (ruling 290), backend quota readings (a refused or exhausted row names whose account, a reading names the hour of its reset, ruling 130(d)). Details in [../domain/auth-and-rbac.md §6](../domain/auth-and-rbac.md#6-insights-insights-org-admin-only) | |
| `/profile` | `profile.tsx` | user | identity, password, notification routing (nine in-app toggles, agent questions on their own; and the per-browser Desktop notifications switch, the one place the browser permission is asked for; ruling 481), appearance, Your access, **Agent accounts** (ruling 127: connect Claude and Codex for yourself; ruling 130(d): each connected card shows the last refusal Viberr observed on YOUR account, never another person's; ruling 294: the last usage reading on it, in the past tense once its window has reset, ruling 481(d); Disconnect asks first, ruling 481(b)), GitHub identity (its Disconnect asks first too). The password change is a row on the Profile card whose button opens a modal (ruling 148(b)); there is no reduce-motion setting (148(c)) | `identity`, `change-password`, `github-disconnect`, `set-notif`, `set-tl-default`, `backend-login-start`, `backend-login-code`, `backend-login-cancel`, `backend-set-key`, `backend-disconnect` |
| `/notifications` | `notifications.tsx` | user | newest 200, auto-read on viewing the target | |
| `/notifications/read` | `notifications.read.tsx` | user (CSRF as a result) | fetcher target; GET redirects to `/notifications` | `read` (the default; repeatable `id`), `read-all` |
| `/prefs/theme` | `prefs.theme.tsx` | user (CSRF as a result) | writes `theme` to the user row and the `viberr_theme` cookie; GET redirects to `/` | |
| `/resources/events` | `resources.events.ts` | user (401 JSON) | SSE stream, scopes `project:<slug>`, `task:<slug>/<key>`, `projects`, `user` | |
| `/resources/run-log` | `resources.run-log.ts` | member / conversation owner | run log lines for `runId` by `since` or `before`, `limit` clamped to 500, each answer with the run row's live facts (phase, step, turns, tokens, cache; the Live run strip reads them); `raw=0` leaves the stored envelopes out; `window=1` answers the run's agent group's console window as a hard refresh ships it (display lines, their keys, the window facts; ruling 457) | |
| `/resources/health` | `resources.health.ts` | public | liveness; `?probe=readiness` → 503 when degraded | |
| `/resources/search` | `resources.search.ts` | user | ⌘K palette query (`q`) over visible projects | |
| `/resources/model-catalog` | `resources.model-catalog.ts` | user | models and efforts per backend (Claude enhanced with the VIEWER's own account) | |
| `/resources/controller` | `resources.controller.ts` | user; a project or task scope the viewer cannot reach answers an empty `unavailable` view (GET) or `{ ok:false }` (POST), never a thrown response, because it feeds a root-owned fetcher | the controller dock's view for the scope the person is standing in (ruling 121); `?seen=1` marks the shown transcript read (ruling 448) | `send` (`text`, `conversationId`, `project`, `task`, `surface`, `timeZone`) |
| `/resources/notifications` | `resources.notifications.ts` | user | the bell popover's list: the viewer's newest `BELL_LIST_CAP` (100) notifications. Pages carry only the bell's counts (`bellCounts`); the bell loads this when the pointer or focus reaches it and on open, and again once the page has re-read the counts since (at once while open). It answers `shouldRevalidate` false; a signed-out request gets a 401, never a login redirect, and its `clientLoader` turns any failed load into the bell's failure row (ruling 457) | |
| `/resources/attention` | `resources.attention.ts` | user; a signed-out request (or a pending password reset) gets a 401, never a login redirect | ruling 481(c): `{ waiting, items }` (`attentionSnapshot`), the viewer's unread decisions (an operator packet, an agent question, a recommendation to approve) that lead somewhere, and the newest ten worded for a desktop notification with the bell's destination. `Cache-Control: no-store`; `shouldRevalidate` false. The root's attention watcher reads it with a plain `fetch` | |
| `/resources/controller-unseen` | `resources.controller-unseen.ts` | user | the dock's status: the viewer's controller conversations holding a reply they have not seen, each with the page that opens it; a thread in a project the viewer can no longer open is left out (ruling 448); and the viewer's turns working right now, with scope, phase and step (ruling 457). Like `/resources/controller`, it answers `shouldRevalidate` false: the dock loads it itself | |
| `/resources/mcp-oauth/callback` | `resources.mcp-oauth.callback.ts` | org admin (a signed-out admin goes through `/login` and back with the query) | where an MCP server's authorization server sends the browser after an OAuth sign-in started in Instance settings (ruling 469): spends the `state` once (bound to the session that started it), exchanges the code with the PKCE verifier, seals the tokens, probes the connection, and answers a plain page (`MCP sign-in`, no-store, no referrer, no token, code or state in it) that says the tab can be closed; a refused callback is a 400 page with the reason | |
| `/resources/backend-login` | `resources.backend-login.ts` | user | `?backend=claude\|codex` → the CALLER's own hosted sign-in session (`{ login, health }`), polled every 2 s by Profile → Agent accounts; an unknown backend is a 400 `{ error: { code: "validation_failed", message } }`, and it reads nobody else's session | |
| `/resources/session-export` | `resources.session-export.ts` | member / conversation owner | `?run=<id>`: resume-script download | |

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
[../domain/auth-and-rbac.md](../domain/auth-and-rbac.md#4-instance-settings-orgsettings-org-admin-only).

## 2. The shell

- **Rail** order and copy are exact: Board · Review queue · Controller · Agents ·
  Policy · GitHub · Activity · Settings (`WORKSPACE_NAV`). The task route counts as
  "Board" for crumb and rail purposes. The Board count includes Done; the Review
  queue count is the queue's own `total` (`getReviewQueue`, so the badge and the
  list it opens are one number, U35-5); Settings carries a badge only while open
  scope violations exist, and it counts violations, not advisories (ruling 386).
- **Board URL state** lives only in the query string (`filter`, `view`, `q`); `boardHref`
  keeps it when navigating from the board itself and drops it from anywhere else.
- **⌘K palette** is mounted by Home, the workspace layout and the pathless
  `palette-shell` layout that wraps `/org/settings`, `/controller`, `/insights`,
  `/profile` and `/notifications`, so the shortcut works app-wide without
  double-registering.
- **Topbar**: project crumb, notifications bell (popover), and the account menu. The
  bell (one implementation for the topbar, Home and the standalone header, ruling 14)
  draws the badge from the page's `unread` count and the popover head from
  `unread + orphanUnread` (F19-25); its list is its own fetch of
  `/resources/notifications`, started when the pointer or focus reaches the bell or on
  open (a first open with neither may show one "Loading notifications…" row) and reloaded
  once the page has re-read the counts since, whatever values they came back with (at
  once while open). A failed load shows "Couldn't load notifications." with Try again,
  never the error page. At the cap the list discloses it ("Showing the newest
  100", UI-14) (ruling 457). The
  account menu is a Radix ARIA menu (arrows, typeahead, Home/End, focus back to the
  avatar on close; ruling 166), fetched when the pointer or focus reaches the avatar or
  on the first press, which opens it on arrival unless Escape, a second press, or a press
  or the focus elsewhere took it back first (ruling 457). It holds "Profile &
  preferences", "Switch project" where it applies, "Switch theme · <value>" (cycles in
  place without closing), "Instance settings" for org admins, and Sign out.
- **The tab title and desktop notifications** (ruling 481(c)). `AttentionWatcher`,
  mounted once by `root.tsx` for a signed-in tab (its own chunk, fetched after
  hydration), prefixes the page's own title with the
  count of unread decisions ("(1) WEB-3 · … · Viberr"; "99+" past 99), re-applied
  whenever `<head>` changes and taken off at zero. It reads `/resources/attention` on
  mount, on a `notification.created` or `notification.read` its tab's live stream hands
  it (`onLiveFrame`), when the tab gains or loses attention, and every 60 s while it has
  not got it (visible and focused). A hidden tab holds no stream (ruling 301), so that
  short read is how a background tab hears. When the person switched **Desktop
  notifications** on for this browser (Profile), a decision that is new to every tab of
  the browser shows a system notification (title, task and project, the first 180
  characters of the text; tagged with the row id) while the tab is not attended; a
  tab's first reading only records what was already waiting. A click focuses the tab,
  marks the row read and opens where the bell would. Rows an attended tab saw are never
  announced by another tab (a shared list of handled ids in `localStorage`).
- **The standalone-page header** (ruling 145) is the same header on the instance
  pages that render outside the workspace: brand → Home, a `Home › <page>` crumb,
  the ⌘K trigger, the bell and the account menu. `palette-shell` mounts it, and
  `STANDALONE_PAGES` / `standalonePageLabel` (`shell/nav.ts`) list the routes that take
  it: `/org/settings` ("Instance settings") and `/insights`. Neither page carries a back
  button: the brand and the crumb root are the way back, as they are on the board's own
  settings page. The three routes NOT on the list keep their own chrome, for a reason
  each: `/profile` and `/notifications` render inside a `showModal()` `PageOverlay` that
  covers the viewport, and `/controller` has its own identity header and a layout that
  scrolls inside itself.
- **Live updates** are mounted by the workspace layout, Home, Notifications, Org
  settings and the controller page; every governed change arrives by loader
  revalidation, of the loaders that read what changed (`revalidation-policy.ts`,
  ruling 457: a board filter keystroke, the echo of one's own action and root's theme
  and csrf on a live event re-run nothing). A task tab holds ONE stream, the layout's:
  the run-log console takes its frames from it (`onLiveFrame`) instead of opening a
  second one, and a console line revalidates nothing (ruling 457). A hidden tab holds no
  stream: `useLiveUpdates` closes on `visibilitychange` and reopens on return from the
  last event id it saw, the broker replays what it missed (or answers `stream.resync`,
  which pulls every loader once), and the console reads whatever it missed as one gap
  (ruling 301). While the stream is down, the workspace and Home both show a
  strip directly under the header (the archived banner's idiom: "Live updates paused. …"
  with a trailing `Retry` button, the button rendered only when the surface really has a
  reconnect to offer). It used to be a chip inside the header row, where at 320–375 px it
  pushed search, the bell and the account menu off the screen (ruling 455(f)). The sentence is also announced through a
  visually hidden `role="status"` region that is mounted at all times and only changes
  its text: a live region inserted together with its text is the one case screen
  readers skip.
- **The controller dock** (ruling 121) is mounted once by `root.tsx` on every signed-in
  surface except the route ids in `DOCK_HIDDEN_ROUTE_IDS`: `/login`, the two controller
  pages, and `/profile` and `/notifications` (both render their whole page inside a
  `showModal()` overlay, which would leave the dock inert behind it). It is a floating
  bottom-right button named `Controller · <scope>` opening a non-modal panel bound to
  the current instance, board or task (a bottom sheet at ≤ 720 px, which a finger pulls down
  to dismiss, ruling 454). Its open and close are one transition, so a click on the button
  while the panel leaves turns it back open from where it is, and a panel the per-tab memory
  reopens appears in place with no entrance (ruling 459, F20 and F24). Its composer is
  disabled, with the same sentence the full page uses, when the VIEWER has not connected
  Claude (ruling 127). The button carries a pulsing dot while a turn works in its scope
  and a still blue dot when a reply its owner has not seen waits in any scope
  (`/resources/controller-unseen`, rulings 448 and 457); the open panel links to replies
  elsewhere. Both transcripts (the dock and the controller pages) read in reply order,
  each reply under the message it answers, and a message with no reply yet says
  "answering now" or "queued · N ahead" from the server's lease, never from what the page
  sent; "… is working" sits under the answered message (ruling 465). Both transcripts show
  a reply that lands from its first line, never pulling a reader who scrolled up to
  history, and a link's URL or any other long token in prose wraps inside them (ruling
  476(a), (c), (i)); the open panel has its
  own always-mounted status region that says "<name> replied: <first sentence>" for the
  thread on screen, and the working row is no live region (ruling 476(d)). Root ships only the button, the panel's frame and header; the panel's body
  loads on the first open, preloaded on hover or focus (ruling 457). The dock's data
  rides no page revalidation: the page's `user` stream hands it `controller.updated`
  instead (ruling 457). On `/insights`, which has no stream of its own, the open panel
  opens one (`DOCK_SELF_STREAM_ROUTE_IDS`). Details in
  [../domain/controller-and-goals.md §2.1](../domain/controller-and-goals.md#21-the-dock-ruling-121).
- **Theme**: light / dark / system, per user plus the `viberr_theme` cookie for
  first paint. Motion follows the OS `prefers-reduced-motion` setting only. After first
  paint, `setDocumentTheme` (`shell/theme-preference.ts`) is the one writer of
  `<html data-theme>`. A change fades over `THEME_FLIP_MS` (250 ms) on ONE clock: for
  the flip's length an override gives every element the same colour transitions, so
  text and its fill move together instead of each rule crossfading on its own, and the
  page stays clickable throughout (ruling 453(c); a view transition would swallow the
  clicks of someone cycling the account menu's theme item). The menu, the profile page
  and the root effect's OS-follow listener all go through it; the boot script paints
  once and registers no listener of its own. The page flips at the press, before the
  root loader confirms the save, so the controls read the theme on screen, not the
  loader's: while a save is out, the menu item's label, the step its next press cycles
  from and the profile page's selected segment all follow the choice the save carries
  (the fetcher's form data). Two quick presses from Light land on System, not on Dark
  twice. A refused save puts the controls and the page back on the confirmed theme. React renders `<html
  data-theme>` once and freezes it: the server renders the preference, and in the browser
  React keeps the value already on `<html>`, so it never rewrites it on a revalidation or an
  error-boundary remount (ruling 459).
- **Motion, materials and type** (ruling 453). The board's drop flight is a critically
  damped spring (`ui/spring.ts`) that leaves at the pointer's release velocity. A
  dialog or page overlay closed while its entrance is still playing leaves from where
  it got to (`ui/live-pose.ts`); the dock's entrance is a transition, which its close
  retargets with nothing pinned (ruling 459). Every transform transition, and so every
  press, runs on `--ease-out`. The Home and standalone header, and the page overlay's
  sticky head, draw their bottom edge only once content scrolls under them. The OS
  increased-contrast setting swaps every frame and divider onto `--border-control`,
  the two lighter text rungs onto `--muted`, and the translucent chrome solid, as
  reduced transparency does. Headings track by size (`--track-title`,
  `--track-section`, `--track-page`: -.011, -.017 and -.021em at 16, 20 and 28px).
- **Polish** (ruling 459, the better-ui pass). Nested corners are concentric (outer =
  inner + inset, on the radius scale). A control's glyph side pads 2px less than its text
  side, and a glyph's stroke follows its label's weight (2 beside 500–600, 2.5 beside
  700–800; the set's 1.7 otherwise). Every press belongs to the element pressed and eases
  on `--ease-out` at .96 (controls) or .99 (surfaces); what cannot act neither hovers nor
  presses, and hover changes colour, never position, on anything hovered all day.
  Floating surfaces take their edge from the translucent `--shadow-ring` over a transparent
  border; images carry `--image-outline`. Dialogs travel a fixed 8px in and 6px out, and a
  primary action plays that exit too (`useDialog`'s `commit`). The drawer's scrim fades. A
  live status line rises only when it replaces the line first painted. A glyph that changes
  with its control (busy loaders, Run → Schedule, a copy check) cross-fades in place
  through `GlyphSwap` (`ui/copy-glyph.tsx`).
- **Responsive**: same surface, reflowed; the rail collapses at ≤ 720 px, the topbar
  trims at ≤ 760 px. There is no review-first mobile mode. Under the breakpoint
  the rail is a drawer: opening it moves focus to the `nav`, sets `inert` on
  `main` and on the skip link, drops the topbar under the scrim and hides the
  controller dock (which root mounts beside the layout, so `<body
  data-rail-open>` carries the state for it); closing it by Escape, the scrim,
  a rail link or a resize returns focus to the toggle after the close has
  committed, and an open modal dialog keeps its own Escape. Closed, the drawer is
  `visibility: hidden` as well as translated away, so its links leave the tab order
  (ruling 455). Under the same
  breakpoint the typing surfaces render at the 1.05rem scale step (16.8px) so
  iOS Safari does not zoom on focus: every `.field` input and textarea,
  `select`, the search, board-filter and palette inputs, the comment and
  controller composers, the goal editor, the label, stage and steer
  inputs, the store browser's inputs and the concurrency field (the 720px block
  in `app.css` is the list). Under the 1100px collapse the task page stacks
  title and goal, the open decision, then the side column (GitHub, current
  state and next action, Details), then the rest (runs, the timeline): the
  page is four regions in source order (`.detail-head`, `.detail-packet`,
  `.detail-side`, `.detail-main`) and the stack is that order, so the screen
  reader, the Tab key and the phone read the task's name and the question it
  asks before its metadata (U35-2). On desktop the head opens the main column,
  the open packet follows it at the same width as the panels under it, and the
  side column stands beside all of it from the top: the GitHub trace parallel to
  the goal, Current state under it (ruling 170). The controller page below its
  two-column breakpoint carries a native select naming the open thread
  (`ConversationPicker`) in its head (ruling 419).
- **Dock clearance**: `--dock-clear` (`:root`) is the fixed dock trigger's reach,
  `44px + max(20px, safe-area-inset-bottom) + 1rem`; the scroll containers that
  end under the trigger (`.home-shell`, `.insights`, `.policy-wrap`, `.detail`,
  `.col-body`, `.live-wrap`, `.board.list`, `.profile-list`, `.ag-detail`)
  reserve it below their last block, so the last control on a surface can
  always be scrolled clear of the trigger. The set is pinned in
  `app.css.test.ts`; a new scroller under the dock joins it there.
- **Form refusals** (ruling 147): every create/save primary stays enabled until
  the request starts (`busy` alone disables it, painted by the `aria-busy`
  rule). A submit that fails validation is refused with the message the surface
  already carried, re-inserted as an alert, the failing field marked
  `aria-invalid` and described by that message, and focus moved to it: the New
  project and New task modals, `/login` (whose action returns `{ error, field }`,
  `field` naming the input or `null` for a form-level refusal such as a rate
  limit), every org-settings `MiniModal` (its unmet line becomes the alert and
  focus lands on the first empty control unless the caller passes `focusUnmet`),
  the repository-repair dialog, the S3 audit target (a `MiniModal`: its unmet line
  names the missing field and focus lands there), the task page's agent run
  starter (an empty picker is refused with "Choose an agent first", the combobox
  marked and focused; a live run on that profile and the owner-credential refusal
  are availability and keep `disabled`), the project's **Add member** modal (a
  `MiniModal` opened from a head button, ruling 148(b)), the agent profile editor, and the
  task page's decision packet (ruling 478(e): a Confirm with nothing chosen is refused with
  "Choose an answer above first.", the radiogroup marked and its first choice focused; a
  choice the asking agent marked `reply` with the answer box empty is refused with "Write
  your answer to <agent> first.", the box marked and focused; the empty directive keeps
  "Write the directive first.").
  A save with nothing changed and a typed-name destructive confirmation keep
  `disabled` on purpose (147(d)).
  While the request is in flight, the New project primary shows it: the `loader`
  glyph spins where the plus was and the label reads "Creating project…" until the
  action answers. The dialog's task-key collision note reads the project list as it
  was when Create was pressed, not the live one, because `/` revalidates its projects
  on the all-projects live scope the moment the new project is projected, still
  mid-request, and the live list would already carry the key being created. It reads
  the live list again once a refused submit has settled.
  Under its repository field, once a connection is picked, the dialog offers
  "Create this repository on GitHub if it does not exist" (ruling 462), unchecked by
  default so a typo never becomes a repository; checking it shows "Create it as a
  private repository", checked by default. The choice travels as
  `createRepository=private|public` on the `create-project` intent to the same server
  function the controller's `create_project` reaches. A refusal (the token cannot
  create repositories, GitHub's own 422 message) renders in the dialog's error alert
  with nothing written; on success the toast adds what became of the repository
  ("Created owner/name on GitHub (private)." or that the existing one was used).
- **Requests in flight** (rulings 147(a) and 368): the button that started a request
  carries `aria-busy` (the sheet's .7 busy step, which wins over `.btn:disabled`), the
  `loader` glyph with `spin` in place of its icon, and a label naming the work
  ("Checking…", "Updating…", "Attaching…", "Scheduling…"). A sibling that merely waits
  keeps the .45 disabled step and its resting label. When one fetcher serves several
  buttons, `inFlightIntent(fetcher)` (`app/ui/in-flight.ts`) reads the intent it carries
  off its form data, which survives `submitting` and the revalidating `loading` after;
  a dialog that closes on its click is never the starter, so its confirm only waits.

## 3. Instance settings intents

`org.settings.tsx` checks the org admin role and CSRF, then accepts, by tab:
connections (`connection-add`, `connection-replace`, `connection-recheck`,
`connection-default`, `connection-remove`), users (`invite-local`, `invite-github`, `invite-google`,
`invite-domain`, `domain-remove`, `user-role`, `user-edit`, `user-disable`,
`user-enable`, `user-remove`, `user-reset-password`), sign-in (`oauth-save`,
`oauth-test`, `oauth-toggle`, `oauth-remove`), resources (`kb-save`, `kb-reindex`,
`kb-delete`, `skill-save`, `skill-delete`, `mcp-save`, `mcp-test`, `mcp-delete`,
`mcp-oauth-start`, `mcp-oauth-sign-out`, `store-mkdir`, `store-upload`,
`store-read-doc`, `store-write-doc`, `store-delete`, `store-import-github`), agent
templates (`agent-save`, `agent-delete`), controller (`controller-save`, `controller-request-decline`), runtime
(`set-concurrency`, `set-run-spend-cap`, ruling 175), audit (`audit-export-s3`,
`s3-config-save`, `s3-config-clear`). That is 45 intents.
A GitHub connection row (ruling 463) says what its token reaches: a `<details>`
(`.conn-reach`) whose summary reads "Reaches 3 repositories · 1 private" (or "300+"
when the read stopped at its cap) and whose body lists each repository with a quiet
"private" pill and "read only" where the token cannot push; a failed read says "could
not be read" with GitHub's reason, and a connection not read yet says Re-check reads
it. The row's **Re-check** (`connection-recheck`) carries the in-flight state of
ruling 368 ("Checking…", the `loader` spinning where `refresh` was).
Its scope chips are token-wide (ruling 480): a fine-grained token's `repo` and
`pull_request:write` read "… unproven for the token as a whole: each repository proves
them", followed while no repository has by how one will ("attaching the token to a project
does, and so does Viberr's first write there"), and one `.sub` line per repository that
proved something ("akin-ozer/website: repo, pull_request:write proven", "…: repo refused",
`data-repo-proof`). `?tab=connections&update=<connection id>` opens that connection's
**Update token** modal (the project credential card's **Replace token** link). The modal's
note says a fine-grained PAT is proven when a project attaches it and by the first branch,
push or pull request Viberr makes there; it promises no dry-run.
`mcp-oauth-start` (ruling 469) answers `{ ok, authorizeUrl, issuer }`: the MCP editor's
"OAuth sign-in" section, shown for a saved HTTP server, renders the URL as a link to a
new tab ("Continue at <host>", so no popup blocker intervenes) and its status line
reads "Needs sign-in", "Signed in (expires in 52 minutes, renews itself) · <host>" or
"Sign-in expired: an admin must sign in again" with the server's reason; while signed
in, the pasted-credential field is replaced by a sentence saying none is used, and
editing the endpoint warns that saving drops the sign-in. `mcp-oauth-sign-out` revokes
and drops the tokens. The row says the same without a click: "needs sign-in · checked
…" on a red dot instead of "unreachable", or "auth: OAuth, signed in (…); held by
Viberr, runs connect through its gateway". Ruling 486 adds what the sign-in was
granted: the row reads "auth: OAuth, signed in (…), read-only · 194 scopes; held by
Viberr, runs connect through its gateway" ("194 scopes · 12 writes" for a grant that
writes), and under the editor's status line "Granted read-only · 194 scopes. Runs can
read through it, and the server refuses any call that writes. To allow writes, add
write scopes to Requested scopes above, save, and sign in again." with a disclosure
"The 194 scopes it granted" (every scope, each write marked "write"); a server that
named no scope reads "The server did not say which scopes it granted." The editor's
optional "Requested scopes" text area (HTTP only, above the sign-in) is hinted "Sent as
the sign-in's scope, separated by spaces; blank asks for what the server advertises.
The server's own sign-in page decides what it grants, so this editor shows what it
granted. A change applies at the next sign-in."
`mcp-save` carries the MCP editor's `writeTools`, a JSON array of tool names (ruling 176):
absent keeps the stored marks, a malformed list or a name outside the MCP alphabet is
refused. The editor's "Write tools" section lists the probe's tool names as chips and
takes a typed name; every server row states where it stands on write tools (ruling 220).
For an HTTP server it also carries `requestedScopes` (ruling 486): absent keeps what is
stored, blank clears it, and a scope OAuth does not allow is refused ("The requested
scope … is not one OAuth allows").

The **Controller** tab (screen label `Controller settings`) is the one org-settings
surface whose controls are not all live (rulings 106, 107, 108): model and effort use
the agent profile editor's own catalog pickers and are always editable; the skills,
knowledge-base and MCP grant lists and the doctrine body render read-only unless the
matching `VIBERR_UNLOCK_CONTROLLER_*` variable is set at deploy time, with one note
naming the locked sections and their variables; the built-in `viberr_ops` diagnostics
server appears in the MCP group as a **pinned, non-interactive chip** (deliberately not
a disabled control, because a toggle that cannot do anything is worse than a
statement); and the grant requests the controller raised for itself
(`request_resource_grant`, recorded in `agents/controller-requests.md`) are listed with
their remedy and one control each, **Decline**. There is no Grant button: the save that
leaves the resource granted is what answers a request (ruling 390). Details in
[../domain/controller-and-goals.md §6](../domain/controller-and-goals.md#6-configuring-the-controller-rulings-106-and-108)
and [../operations/configuration.md §2](../operations/configuration.md).

## 4. Screen labels

Every top-level surface and dialog carries `data-screen-label` so tests and agents can
address it by name: `Login`, `Login · set new password`, `Home · project selection`,
`Pinned projects`, `All projects`, `Archived projects`, `Settings` (the Home tiles and
the project settings page), `Store strip`, `New project modal`, `Board`, `Empty state`
(Home, Insights and the controller page), `Review queue`, `Controller`, `Agents`,
`Policy`, `GitHub`, `Activity`, `Task detail · not found`, `Accept completion dialog`,
`Archive task dialog`, `Release ownership dialog`, `Move back dialog` (ruling 381),
`Packet archive dialog`, `Packet discard dialog`, `Packet collision dialog`,
`Attachment lightbox`, `Command palette`, `Notifications`, `Notifications popover`,
`Profile & preferences`, `Change password dialog`, `Instance settings`,
`Settings · Users & access`, `Settings · GitHub connections`, `Settings · Sign-in &
SSO`, `Settings · Agent resources`, `MCP sign-in` (the OAuth callback's page, ruling
469), `Controller settings`, `Audit log`, `Controller
dock` (the panel, ruling 121), `Insights`, `Capability matrix modal`, `Agent profile
modal`, `S3 export target dialog` and `Add member dialog` (both ruling 148(b)), `Delete
project dialog` (ruling 458(l)), `Rebuild projections dialog` (Home's hand-written confirm,
ruling 458's 2026-09-24 note), and the seventeen confirms the shared `ConfirmDialog`
names: `Resource removal dialog`, `Stage removal dialog`, `Member removal dialog`,
`Schedule cancel dialog`, `Interrupt run dialog`, `Dismiss recommendation dialog`,
`Interrupt turn dialog`, `Cancel goal dialog` and `Skip link dialog` (ruling 419),
`Disable user dialog`, `Credential removal dialog`, `Store deletion dialog`, `Replace
document dialog` and `Profile deletion dialog` (the hand-written confirms ruling 458(f)
moved onto it), `Template grants dialog` (the Agents page's "Use the template's grants",
ruling 479(d)), and `Disconnect agent account dialog` and `Disconnect GitHub dialog`
(Profile's two Disconnects, ruling 481(b)).
`screenLabel` is a required prop on `ConfirmDialog`, so a new call site cannot ship
unlabelled; the typecheck refuses it.

Labels composed at render time rather than listed here: `Task <KEY>` (the task page),
`Files · <resource>` (the store browser), `Project card · <name>` / `Project row ·
<name>` (Home), `<page> · overlay` (`PageOverlay`), and the title of any org-settings
`MiniModal` that passes no `screen` of its own (e.g. `Allow access`, `New knowledge
base`, `Edit MCP server`, `GitHub sign-in`).

## 5. Copy rules that tests enforce

- Readiness pills come from one table (`READINESS_DISPLAY` in `app/ui/pill.tsx`);
  "accepted", "merged", "agent working", "agent queued" (a run parked behind the
  concurrency cap, ruling 349) and "goal edit pending" (a decided `edit_goal` packet,
  ruling 138) are display states, never stored. An unrecognised value renders a neutral
  "unknown", never a green "ready".
- Backend label is "Claude", never "Claude Code", except for the product itself (CLI
  login, transcript retention) (ruling 92).
- **Banned vocabulary** (`app/features/copy-ban.test.ts`): the "govern / governor /
  governance / governed" family may not appear in rendered copy (every file under
  `app/features`, `app/routes`, `app/ui`, `app.css` and the top-level render files), in
  any string literal under `app/server`, `app/schemas`, `app/shared` or `app/lib`, or in
  a seeded agent definition or skill doc outside its named prompt sentences; every
  top-level entry under `app/` must be claimed by one of these scans. Em and en dashes
  are banned from the same rendered copy and from the seed assets (P21: reword with a
  comma, period, colon or parentheses). "primary specialist" may not appear in rendered
  or server-built copy (the capability id `assign-primary-specialist` excepted); say
  "delivering agent".
- **Retired "specialist" wording** (`app/features/retired-vocabulary.test.tsx`): the
  seeded agent assets, the developer skill mounted into a run, the seeded Task-contract
  KB doc and the workflow template written into every new `project.md` name the
  delivering agent; no operator-recommendation chip renders "specialist"; the Agents
  page's live-roster empty state, run-in-flight stat, capability matrix modal and
  role-less profile card say "agent profile" / "agent threads", not "specialist".
- Queue rows say "Review", not "Accept" (ruling 30). The board's attention chip is
  "Blocked or waiting" and excludes `input_required` while an agent is working or the
  task rests on a clock (rulings 36, 91, 225). It selects a task holding an open decision
  packet with `waiting: human` whatever its stored readiness, so a `ready` task with an
  agent's question open is not hidden under its own "waiting on you" (ruling 477(a)).
- A failure toast never renders the success tick: the kind is passed from the server
  result (`use-action-toast.ts`).
- An error toast stays until it is dismissed (it carries a Dismiss button); a success
  toast lasts 5 s and pauses while the pointer or focus is inside the stack
  (`ui/toast.tsx`, ruling 455(a)).
- **Every attachment kind opens a card, and every card carries Download** (ruling 105):
  images show the picture; the known binary kinds (archives, media, fonts, office and
  PDF documents, executables, databases) are decided by name and get an honest "no
  in-app preview" note; every other file is fetched and read in a read-only CODE reader
  (ruling 363: Shiki tokens by the name's grammar, line numbers, plain when no grammar
  is mapped), unless a NUL byte in its first 8,000 characters sends it to the no-preview
  card ("This file is not text"). A body whose fetch proved the file unservable (404
  after the completion-time prune, 413 over the 50 MB cap, an auth redirect) reports the
  failure and drops Download rather than saving an error body under the real filename.
  The `Attachment lightbox` screen label covers all three.
- **The console fills itself** (ruling 457, owner decision 2): a hard refresh arrives
  with the shown agent's console drawn (its display lines; the stored envelopes load
  when `{ } raw` opens, each row saying "loading the stored envelope…" until they
  land); a client navigation or a revalidation carries no console lines, and the
  console fills the thread it shows with one request, reading "loading this console…"
  meanwhile; a console already drawn when its agent starts a new run keeps its lines on
  screen until the new run's window replaces them; another agent's console loads when
  the picker opens it. A line appends one row, keyed by its run and seq, and leaves
  every drawn row alone; the Live run strip's phase, step, turns and tokens move with
  each line of whichever running agent it shows (the console's tail reads carry them,
  and a line of an agent whose console is not loaded reads that run's facts alone), and
  its Elapsed clock ticks alone. The console's rows skip layout and paint while off
  screen (`content-visibility: auto`). While the tab's live stream is down the
  console's footer says "Live tail disconnected: reconnecting…".
- **A live run's console is disclosed on its own card** (ruling 380): while a run streams,
  the Agent-logs console renders INSIDE the Live-run strip, open by default, and the strip's
  trigger reads "Hide console"/"Show console" with `aria-expanded`; the panel below is the
  settled-runs archive, so exactly one console exists either way. On the task page the
  timeline's own "open console" still travels to the anchor, because from there the
  console really is elsewhere, and opens the disclosure first so there is something to
  travel to.
- **A person may attach a file to a task** (ruling 379): the Attachments panel renders
  for every task and carries an "Attach a file" control for a viewer holding
  `attach-file` (contributor and above) on a task that is not archived. `accept` comes
  from the server's own whitelist, so the picker cannot offer a file the writer would
  refuse; the writer also refuses a traversing or dot-prefixed name and anything over
  10 MB (`MAX_UPLOAD_BYTES`). Every file name carries its whole self in `title`, and under
  the 720px breakpoint a file row gives the name its own line, whole, with "by <actor> ·
  <time>" and the size under it (ruling 478(b)).
- **An agent's question is answered to the agent** (ruling 478(e)): on a packet the render
  marks with `answerTo` (an `Agent question` with `askedBy`) nothing is preselected, even
  the option the agent recommends (its "recommended" pill stays, and only a "(Recommended)"
  mark earns it); no packet that recommends nothing preselects anything. The box under the
  options reads "Your answer to <agent>" with the hint "optional · goes back to <agent> with
  your choice · 4,000 characters max", or "required · …" (and the `*`) when the chosen
  option carries `reply`; the directive's hint reads "resolves this decision · goes back
  to <agent>". Every other packet keeps "Note for the operator".
- **Written text sits under the page's headings and shows what it holds** (ruling 478(a),
  (f)): typed timeline events render as markdown like comments (a fenced block scrolls on
  its own, inline code breaks); a timeline entry's or a packet body's top heading renders
  at h3 with deeper ones following; the GitHub panel's bar carries a visually hidden h2
  "GitHub". The Live run strip's step cuts at the strip's edge with its ellipsis
  (`.run-phase-text`, ruling 478(c)).
- **The stream pickers say whose console is shown** (ruling 478(d)): the Agent logs picker
  is named "Agent log stream: <name> · <role>" and the live strip's "Running agent: …";
  opening one moves focus to the stream shown, the arrows move focus between streams, and
  only Enter, Space or a click switches the console, returning focus to the trigger.
- **The Agent-logs console carries a prompt-cache facts row** (ruling 369) under its bar:
  quiet chips for the first call's temperature and figures (green "warm start · read 47.9k",
  amber "cold start · wrote 298k"), the provider's miss reason when it sent one, the TTL
  bucket ("cache 1h"), the run's writes and reads, the peak prompt (the last prompt, what a
  resume would replay, in its tooltip) and the compaction count; each figure rides a `data-`
  attribute, and a run with no first call says "no first call yet". The Live-run strip's
  Tokens cell says on hover what the cache wrote and read. Both follow the console's tail
  reads while a run streams (ruling 457).
- Timestamps render through `app/shared/dates/format.ts` only: zero-padded `HH:MM`,
  `{day} · {time}`, relative forms. **The hydration contract** (pass 34, C6): a
  timestamp's first pass depends on the timestamp alone (the `*UTC` formatters take no
  `now` and render the absolute UTC day + UTC clock, `Jul 3 · 23:59`, identical on the
  server and in any viewer's browser at any clock) and the viewer-local form replaces it
  once hydration commits (`LocalDayDotTime`, `LocalRelative`, `useHydrated` in
  `app/ui/local-time.tsx`; the console's line clocks sit behind the same flag). The flag
  is React's own hydration state (`useSyncExternalStore` with a server snapshot), so a
  stamp that mounts after hydration (a client navigation, a new row, a console opened
  later) renders local from its first commit instead of drawing the UTC form for a
  frame (ruling 457).
  Calendar dates (`formatCalendarDate`, host-zone by construction) render through
  `LocalCalendarDate` for the same reason: `YYYY-MM-DD (UTC)` first, the local calendar
  date after hydration. Gated by `app/features/task-detail/hydration-determinism.test.tsx`
  (a real `renderToString` → `hydrateRoot` of the task page across the UTC/Auckland zone
  pair and the UTC-midnight clock pair, interrupted hydration included),
  `app/features/org-settings/resources-hydration.test.tsx` (the same pair over the Agent
  resources tab, ruling 480: its "re-scanned", "checked" and "updated" stamps are
  `LocalRelative`, and the MCP row's stale mark and a signed-in token's "expires in …" wait
  for hydration) and `e2e/06-activity-hydration.spec.ts`. The controller's grant requests
  say when they were asked through `LocalDayDotTime` (ruling 480), never the stored ISO.
- The Activity **audit** column carries the goal chains (ruling 477(b)): "<person> created
  goal **goal-1** (<title>) with N links.", a sentence per redirect op ("paused", "skipped
  link 3 of goal **goal-1** (<title>): <reason>", "bound link 2 of … to an existing task
  on" with the task's chip, "changed nothing on" for a no-op), and "Goal **goal-1**
  (<title>) completed: every link is settled." A task a chain starts has its creation
  events signed by **Goal chain** (a system actor, so the stream's Humans filter leaves
  them out): "Started by **goal-1** as link 2, on <creator>'s authority, with <owner> as
  owner. …".
- The Activity **audit** column names a controller-driven write as the person **(via the
  controller)** (ruling 99(b)): both producers write one shared instrument label and the
  column decodes it on both legs, so a row whose user no longer resolves reads the same
  way. The ORG audit log keeps the RAW stored label on purpose: it is the forensic
  surface. The actor filter still lists one option per person. The runtime-session FOLD
  is unaffected (the instrument sits before the sentence), but a folded run's collapsed
  summary names no actor, so the instrument on folded sessions is readable only when the
  run is expanded.
- The agents page's `update-profile` intent carries the `deploymentFingerprint` the
  loader shipped, and a save composed against a record a concurrent write replaced is
  refused with "This profile changed while the editor was open." (pass 34, B5).
- **The collision confirm renders TWO shapes** (pass 34, C3/U34-8): with an unowned PR
  recorded it names the stranger, its pull request and the stale branch ("Clear collision
  & redeliver"); with none it describes THIS task's own remote branch and says no pull
  request is closed ("Delete branch & redeliver"), because that is what
  `resolveRemoteBranchCollision` actually does then. An OPEN pull request of
  the task's own raises a warn row in both dialogs, before the button, and each says what
  its OWN ceremony does with it: the archive still archives and keeps the branch (only the
  deletion is refused), while the collision resolution deletes nothing at all under ruling
  136(b) and pushes the delivered revision to that pull request.
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
  and no second availability pair.
- A "Retry on <other backend>" offer is rendered only where the retry could actually run,
  and the console explains a withheld one (see
  [../domain/task-lifecycle.md](../domain/task-lifecycle.md), the owner-is-who-a-run-bills
  bullet).
- **Every Agents Live row states what a run is doing** (F34-5): an engagement's status is
  read from its own `agent_runs` row first ("coordinating" (operator) and "working" name a
  running row and are the only rows that pulse, "queued" a run admitted but not yet given a
  slot) and only an engagement with no live row reads the task's `waiting` ("packet open"
  with a packet, "waiting on a human", "on call"). The rule is the same for every
  engagement kind. The stats row counts runs in flight ("agent threads with a run in
  flight") and task-level waiting ("agent threads waiting on a human"; an engagement
  running on a human-waiting task still counts there). Pinned by
  `app/server/projections/agent-deployments.server.test.ts`, `agents-page.test.tsx` and
  `retired-vocabulary.test.tsx`.
- **The Eligible stages panel says what "N of M stages" gates** (ruling 133 clause c): under
  the chips it always renders "Eligibility decides where this profile may be newly engaged.
  Once it delivers a task it may be prompted on that task at any stage." and appends "A
  supporting or reviewing engagement runs only at the stages above." only for a profile that
  is actually scoped on this board, not for `spanAll`, an empty declaration, or a
  declaration that resolves to nothing here (R14-1 rule 3), where naming "the stages above"
  would name a scope the profile does not have. The profile editor's Eligible stages hint
  reads "stages where this profile may be newly engaged". Pinned by `agents-page.test.tsx`.
- **The Agents page and the global profile editor say what the runtime does** (ruling 479,
  pinned by `agents-page.test.tsx` "ruling 479", `org-settings-page.test.tsx` "ruling
  479(h)", and the server tests the ruling names):
  - (a) The capability matrix's grid holds only capabilities something enforces: the
    agent editor's groups plus "Operator actions". Advisory lines sit under the grid in a
    collapsed "Advisory only · N lines the runtime does not read", each as "Move the task
    to Review (acts directly: Site Engineer, Site Reviewer)", with the sentence "These
    describe how a profile is meant to work. Nothing in the runtime enforces them, so
    they never grant or refuse anything, and the grid above leaves them out. Whether a
    profile's review can approve or request changes is its Report a validation verdict
    row." There is no "Other actions" group.
  - (b) A granted MCP chip a run gets no tools from carries the missing chip's look and
    a note: "needs sign-in", "sign-in expired", "credential unreadable" or "unreachable";
    its title and its visually hidden text give the remedy ("Runs do not mount
    cloudflare-api until an org admin signs it in (Instance settings → Agent
    resources).").
  - (c) "Use the template's grants" works on the Operator as on any profile; it never
    answers "No such agent profile." about the profile on screen.
  - (d) "Use the template's grants" opens "Replace <name>'s grants with the template's?"
    ("<project>'s copy of <name> takes the template's skills, MCP servers and knowledge
    bases, and loses any it granted on its own. Removes MCP server cloudflare-api · adds
    nothing. Changes apply from the next run.", confirm "Replace grants", danger-toned
    when it removes something). The toast reads `"<name>" now carries the template's
    grants · removed … · added … · changes apply from the next run`, each clause only when
    it has grants to name.
  - (e) The runtime row's "Model · effort" cell reads "Claude Opus · Maximum" ("default
    effort" when none is stored) for every kind; the operator adds its Autonomy cell. The
    Live tab's Backend column names the operator's backend ("Claude", "Codex"), never
    "orchestration".
  - (f) Each Eligible stages chip carries ", eligible" or ", not eligible" as visually
    hidden text.
  - (g) The profile editor says "Saving forks this profile for <project>…" only for a copy
    that still follows its template (`tracksTemplate`); every other edit reads "Update
    this project's copy. Changes apply from the next run."
  - (h) In Instance settings → Agent resources, a global profile's stored stage the
    default workflow lacks reads "build (not in the default workflow)" on the row, and the
    editor shows it as a pressed chip "build" with the note "not in the default workflow"
    that can be pressed off (and back on) before the save.
