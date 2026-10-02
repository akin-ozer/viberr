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
A route that a page loads in the background (through a fetcher, a plain `fetch` or an
`EventSource`) answers a request with no session, or with a forced password reset pending,
with a 401 rather than the login redirect, and its row says so: a fetcher follows a
redirect as a navigation, and the redirect's returnTo names the resource, so signing in
again opened a page of raw JSON (ruling 457). The page's next real navigation asks for the
sign-in, with its own path as the returnTo. A route a fetcher loads in the background also
has a `clientLoader` (the dock's send a `clientAction`) that answers a request the server
never answered (a restart, a 5xx, a dead network) with the surface's own "not loaded", and
its row says what that reads as: React Router sends a fetcher's failure to the error
boundary of the route that owns the fetcher, which replaced the whole page (ruling 457).
The intent lists below are every `intent ===` / `case "…"` branch in each route's action.

| Path | Module | Guard | Renders / does | Intents |
|---|---|---|---|---|
| `/login` | `login.tsx` | public; `login` runs the origin check, `set-password` full CSRF | local sign-in, forced-reset mode; with at least one OAuth provider configured the card leads with both provider buttons (an unconfigured one disabled and labelled), with none the local form leads; at 900px and wider the pitch and the card sit as one centred pair and the pitch's mark is the only brand mark (the card's returns when the two stack, ruling 625) | `login`, `set-password` |
| `/logout` | `logout.tsx` | CSRF | better-auth sign-out | |
| `/api/auth/*` | `api.auth.$.ts` | better-auth | six allow-listed paths incl. OAuth callbacks | |
| `/` | `_index.tsx` | user, form | Home: the setup checklist while any of the viewer's steps is open (ruling 532: "Finish setting up", GitHub, Your own account, Claude or Codex and First project for an org admin, the last two for a member; the first step the viewer can take leads with its sentence and the primary action, each action opens its place, and the card leaves once every step is done; once the viewer has a project, the cross in its head, "Hide for this session", closes it until the sign-in or the browser's session ends, ruling 621), pinned, all and archived projects, waiting counts, the Settings tiles (connections, users, resources, insights; each tile's faces or glyphs sit in its foot, ruling 625), store strip (org admin), new-project modal (the hero's New project is its one entry in both views: no grid tile, no list button, ruling 625; at 1100px and narrower a list row keeps "N waiting on you" and drops "· quiet") | `create-project`, `pin`, `view`, `hide-setup` (ruling 621), `rescan` (org admin), `rebuild-projections` (org admin) |
| `/projects` | `projects.tsx` | user | redirects to `/` | |
| `/projects/:slug` | `project.tsx` + `project._index.tsx` | user → member (404 parity) | workspace shell (rail, topbar, palette, live updates); index redirects to the board | |
| `/projects/:slug/board` | `project.board.tsx` | member (the layout's `readWorkspace` gate), form | board by stage from its own loader (ruling 457: the columns, as board cards carrying the fields the board reads, `toBoardCard`; the layout carries none) (a card is one status chip, a row of problem chips and an avatar stack, ruling 365; a decision the viewer owes beside an agent's wait leads the chips as "waiting on you", ruling 529), filters in the URL (`filter`, `view`, `q`; on a phone the filter chips are one sideways-scrolling row, ruling 625; clicking the active chip clears it, ruling 632), lanes the board's full height (ruling 631), a list row reading key, title, status and problem chips, agent, stage, then the owner seat, with no per-row owner label (ruling 625), drag-and-drop and the card's Move menu (a stage, or Move up / Move down within the lane: the keyboard and single-pointer path to a slot, ruling 455(c)), accept-from-board confirm (the shared accept dialog, whose "Collides" row the board computes from its own cards' `pr.paths`, ruling 475), the shared move-back confirm (ruling 381: a drag or keyboard move to an EARLIER stage asks why first), the epic filter (ruling 503: `?epic=<epic id>` or `none`, a select shown once the project has an epic; Clear resets it and the empty copy names it; cards and list rows draw no epic, ruling 172) and the New task dialog's Epic select (it starts on the filtered epic) | `create-task` (with `epic`, ruling 503), `reorder` (carries `reason` on a backward move), `rescan` (admin/maintainer) |
| `/projects/:slug/epics` | `project.epics.tsx` | member (the layout's `readWorkspace` gate), form | Epics (ruling 503): Open (the default), Closed and All (`?show=`); each row its colour dot, id, name and status pill, the progress bar in the project's stage colours with "N of M done" (plus held and archived counts), its lead and, while it is open, its target date, the row a link to the epic; "No epics yet" (with New epic for a viewer who may) when there are none, the head then showing no count and no New epic of its own (ruling 625); New epic (for `manage-epics`) opens the epic dialog (name, description, status, lead, start and target dates, colour) | `create-epic` (`manage-epics`) |
| `/projects/:slug/epics/:epicId` | `project.epic.tsx` | member (404 for an id the project has no epic for), form | one epic (ruling 503): the head, which scrolls with the panels (ruling 615): the crumb, the title with Edit (the same dialog) at the end of its row, and the status line, which opens on the status select (a chip: the status's dot, its name, a chevron) where a viewer without the grant reads the status pill; About (the markdown description); Tasks (the progress bar, one row per task with its stage, the board card's status word, "waits on N" when it waits, its owner and Remove, which under 36rem of list put the title on its own line and the rest under it; Add tasks lists every live task not in it and says which will move from another epic; New task makes one in it; archived tasks fold under the list); History (ruling 560: a feed, the newest eight under their days, a rail of entries with their clock and key-chip task links, "Show N more" / "Show less"; at 1100px and under the page is one column); Details (status, lead, dates, creator, and "Planned in <conversation>" for a viewer who may open that thread, ruling 476(h)). A read-only project, or a viewer without the grant, sees no controls | `update-epic` (`manage-epics`; the fields the form carries, so the head's select posts `status` alone), `add-tasks` (`taskKeys`), `remove-task` (`taskKey`; both `edit-task-meta`), `create-task` (`title`, `goal`; `create-task`, born in this epic) |
| `/projects/:slug/review` | `project.review.tsx` | member | review queue split into "Waiting on your acceptance" (tasks at a stage the workflow makes acceptance legal from, whose acceptance nothing blocks, for a viewer who can accept) and "Still in review" (every other review-work row: at the review stage, an open review PR at any stage, or a required reviewer's verdict outstanding; a row before the boundary reads "Review in progress at Validation · PR #8 · awaiting verdict", or names the live PR fact instead when it carries one: unpushed revision, conflict, drifted head; U35-5). A row whose open PR shares changed paths with another open PR carries a "collides with <keys>" chip on both rows (ruling 236, read-only). A row's status chip (the board card's own, ruling 625) reads "waiting on you" for the tasks whose next move is the viewer's (`waitingOnViewer`, the same answer the board's loader gives its cards), and an agent still working keeps "agent working", as on the board card (ruling 455); a failing validation and a degraded continuity are the card's problem chips, the subline wraps to two lines (full text on hover) and on a phone the key is the row's eyebrow (ruling 625). Every row, and the "Review → Done" policy chip, is a link to its page (`<a href>`), never a button that navigates, so a row opens in a new tab (ruling 477(c)). Header: "N in review · M waiting on your acceptance" | |
| `/projects/:slug/controller` | `project.controller.tsx` | member (CSRF checked as a result, not a throw) | the instance controller addressed inside this project: New conversation in the page head (which the title shares with "Claude not connected" while the asker's Claude is not connected, at the place the rail's other pages put their title, ruling 625), and one band as tall as the screen holding the conversation, the run pane while the thread has a run to show, and the rail (conversations first, then the Knowledge base panel), each scrolling itself (rulings 419, 524); the Knowledge base panel (`#kb-corrections`, rulings 483 and 498) heads "Knowledge base" with "N corrected" and lists the newest 20 corrections the project's agents wrote: a "Ruling" or "Knowledge base" pill ("Undone" beside it once undone), `<kb>/<doc>`, "Was" and the replaced passage struck through, "Now" (or "Added") and the text written, a collapsed "Evidence", the task (linked), filer, time and id; an org admin gets Undo (confirm "Undo <id>?" with an optional "Why", "Undo correction" / "Keep it") and "Open document"; an undone one reads "Undone by <name> · <time>: <reason>" instead; everyone else reads "An org admin can undo a correction."; none reads "No corrections yet. An agent writes one when its work proves a knowledge-base line wrong."; more than 20 adds "The newest 20 of N. The audit log keeps the rest for 90 days."; proposals filed before ruling 498 follow under "Open proposals (N)" (`#kb-proposals`) with "Filed before corrections were written straight into the document…", each with its pill, `<kb>/<doc>`, "Corrects" and the quoted line, the correction, "Evidence: …", the task, filer, day and id; an org admin gets Promote, Dismiss (confirm "Dismiss <id>?", "Dismiss proposal" / "Keep it"), "Open document", Promote all (two or more) and the note "Promote and Dismiss ask the controller here; it edits the document."; Promote, Dismiss and Promote all post the `send` intent with the request `proposalRequest` / `promoteAllRequest` words, disabled while a message is on its way or Claude is not connected; everyone else reads "An org admin promotes or dismisses proposals."; unseen replies marked (ruling 448); a reply shown from its first line and announced by one always-mounted status region (ruling 476(c), (d)); while Claude is not connected the composer's note is the one statement of it (the box has no placeholder and the blank transcript offers no examples, ruling 625, which narrows ruling 419(g) to a controller that can answer); while a turn works the composer's Steer (primary) and Queue, and Send now and Retract on the owner's waiting messages, which read "steering · next step" or "queued · N ahead" and, once a turn read them, "steered" (ruling 527); the Goals panel left with the chains (ruling 503: epics have their own pages); with a thread open, its Live-run strip and Agent-logs console (interrupt for the owner or an org admin); each rail row the viewer may delete carries "Delete <title>" (the row ✕, confirm "Delete this conversation?" or "Delete <name>'s conversation?", "Delete conversation" / "Cancel"), and a project admin's "Show everyone's (project admin)" lists the others' threads about the project sealed, as "<name>'s conversation" with no link (ruling 525) | `send` (`text`, `conversationId`, `surface`, `timeZone`, `mode`: `queue` queues behind a working turn, else it steers it, ruling 527), `send-now` and `retract` (`conversationId`, `messageId`; the conversation's owner, ruling 527), `interrupt` (`conversationId`, `runId`), `kb-correction-undo` (`id`, `reason`; org admins, ruling 498), `delete-conversation` (`conversationId`, `open`, `all`; ruling 525: a toast, or a replacing redirect to the bare page when it deletes the thread `open` names) |
| `/projects/:slug/agents` | `project.agents.tsx` | member, form | deployed roster, live runs, profile detail (a copy whose grants differ from its template says so on the scope line and under each list, ruling 156; the project's rulings knowledge base named when one is set, ruling 239; a granted MCP server no run gets tools from is marked, ruling 479(b)), capability matrix modal (enforced capabilities only; advisory lines collapsed under the grid, ruling 479(a); the modal is sized to its grid and "Claude-enforced" is a mark named once in the legend, ruling 625); a deployment whose backend is not connected reads "not connected" in the rose status (its title names the backend), a backend chip is badged only when the note under the row does not already name it, and Live rows wear each profile's own glyph (ruling 625) | `create-profile`, `update-profile`, `deploy-profile`, `delete-profile`, `sync-profile-resources` (org admin only, carries the record's fingerprint, sent from a confirm that names what it removes and adds, ruling 479(d)) |
| `/projects/:slug/policy` | `project.policy.tsx` | member, form | role matrix (rendered from `rbac.ts`; each role header carries its member count on a second line, ruling 625), member roles, transition boundaries, guardrails (ruling 112), the required reviewers read-only (ruling 178; edited on Settings) | `set-role`, `set-boundary`, `set-guardrail` |
| `/projects/:slug/github` | `project.github.tsx` | member, form | credential card (with the workflow-scope advisory, ruling 144; an advisory scope is a note, not a violation, ruling 380; its `repo` / `pull_request:write` chips read the project repository's proof, ruling 480; its manage row is **Attach credential**, or **Re-attach connection** + **Remove credential** with **Replace token** linking an instance admin to the connection's Update token and a sentence for everyone else, ruling 480), repo state, branched tasks, scope violations, update status | `reconcile` (`reconcile-github`), `grant-scope`, `set-credential`, `clear-credential` (all three `grant-github-scope`) |
| `/projects/:slug/activity` | `project.activity.tsx` | member | activity feed with day groups; audit column (compacted, ruling 61) carrying the epic rows (ruling 503) and the goal-chain rows an upgraded store holds (ruling 477(b)); every task key is a link to the task (ruling 477(c)) | |
| `/projects/:slug/settings` | `project.settings.tsx` | member, form; writes need `edit-policy` (admin) except `invite` / `remove-member` (`manage-members`, admin) and the credential intents (`grant-github-scope`, maintainer and above) | two stacked columns (ruling 625): on the left the project profile, members (the invite form is a head button opening the `Add member` modal, ruling 148(b)), repository and branch cleanup; on the right stages (the row's dot opens a 20-swatch colour menu, ruling 364) with required reviewers under Workflow stages (ruling 178: a stage + verdict-capable agent per row, saved whole), File leases under them (ruling 396: paths as a glob line, the holder task, the reason; a spent lease is marked and "Clear finished" removes exactly those; read-only text without `edit-policy`), Gates under those (ruling 482: a name, the command and a timeout in seconds per row, saved whole; an empty timeout is the 600 s default; at most 10; read-only text without `edit-policy`; the note says Viberr runs each with `sh -c` in a fresh checkout of every delivered revision as the task owner and that acceptance waits until every one exited 0); archive/delete full width below. An empty reviewer, lease or gate list is one row, its sentence and its Add, and Save appears once there is something to save (ruling 625) | `save-project`, `add-stage`, `rename-stage`, `recolor-stage`, `remove-stage`, `reorder-stages`, `set-required-reviewers`, `set-file-leases`, `set-project-gates` (ruling 482: the whole list as one JSON field; a changed list queues the gates on every open delivered task), `invite`, `remove-member`, `set-credential`, `clear-credential`, `grant-scope`, `change-repo`, `set-branch-cleanup`, `archive-project`, `delete-project` |
| `/projects/:slug/tasks/:key` | `project.task.tsx` | member, form | task detail (page label `Task <KEY>`): state (the "Waiting on" row reads "Other work: …" for a held task), the hero's wait chips (one neutral link per `blockedBy` entry with its state, ruling 131) and its epic chip, a link to the epic's page (ruling 503), execution profile (the operator run control carries a hold note with Run left enabled; on a closed task the control is withdrawn to its sentence and any pending schedules, ruling 625), packet (ruling 521: a decision that offers acceptance carries the completion packet between its observations and its options, "Completion" and "Summarized by Operator <time>" over Operator's summary; "Reviewers", each reviewer's verdict on the revision under review, "Approved", "Requested changes" or "No verdict on <sha7> yet", with its reason, a quiet "not required" pill for one the gate does not wait on, and a "Stale" tag on a verdict given for earlier work; "Screenshots", the ones Operator picked with its captions, opening in the lightbox; "Changes", "N files changed +a −d" with the diff open whole at 200 lines or fewer, else "Over 200 lines, so this is Operator's summary" over its summary and "Show the diff"; a packet written for earlier work says so first, and "Operator has not summarized this work yet" stands in for a missing one; beside an acceptance recommendation, or at the boundary once written, the same packet is its own card), recommendations (an acceptance card prints the gate's refusal as an alert and its Apply refuses the click while one stands, ruling 162), the accept dialog (its "Collides" row, "Merging this will likely put WEB-2's PR #3 in conflict on `package.json`. Viberr re-checks it right after the merge, and the operator hands a conflict to the delivering agent.", names every other open PR that changes a path this one changes, from the loader's `mergeCollisions`, ruling 475), Details (ruling 501: each property's value is its control; the "Blocked by" row's chips each carry a remove cross that saves the wait without that entry, the plus after them opening the wait's own form, a picker since ruling 548: its entries as chips with a remove cross over a field that finds the project's tasks, read from `…/dependency-candidates` as it opens; the Epic row is a menu of the open epics with "No epic" first, ruling 503), attachments (every task; "Attach a file" for `attach-file`, ruling 379; an empty panel is its sentence and the Attach button, left-aligned, ruling 625; a long list folds behind "Show more" as a long comment does, ruling 510), timeline (an entry's files show their first row and the rest fold, with a comment's text behind its one Show more, which counts them, "Show more · +6 images", or under a typed event's strip, ruling 522; a `proposal` event pills "Proposal", is titled "Proposed ruling change" or "Proposed knowledge-base correction", and links "Open proposals" to the project Controller page's `#kb-proposals`, ruling 483; a `kb_correction` event pills "Knowledge base", is titled "Knowledge base corrected", "Rulings corrected" or "Knowledge-base correction undone", lists "Was" struck through and "Now", and an agent's links "Review or undo" to `#kb-corrections`, ruling 498; a gate run's note pills its ending, "passed", "failed" or "could not run", names its revision, "on `<sha7>`", and is the gate table, ruling 493; a reviewer's verdict is a card, its title in the verdict's green or red over "N of M checks failed" or "M checks passed", the revision it judged at its end in the code face, what the note adds beyond its opening, then its evidence as a checklist, a failure first and tinted, and its rail node the verdict's check or cross, ruling 526; any other outcome's evidence is the same checklist, and a file a row names opens from that row rather than again as a tile, a picture excepted), runs, GitHub trace (ruling 511, drawn after GitHub's merge box under the inverted bar, which holds the repository and the PR's state pill, "no PR" for a branch alone; then the PR's title and number, the link to it; the branch chip, the link to its tree, and the diff; then one status row per signal, a mark in its pill's tone over the pill's words and what the state rests on: a branch collision, the gates (ruling 482: "Gates passed" or the run's other state over the server's line, "Gates on `<sha7>`: N/M exit 0 (run by Viberr)", then the gate table, ruling 493: per gate its mark, its name, a failure's outcome, its time and a Log button that opens the log in the reader, folded behind "Show all" on a pass; and "Run gates" / "Run gates again" for maintainer+ or the owner, disabled while a run is queued or running), GitHub's checks and review, "Conflicts" on a conflicting open PR, ruling 162, and "Unpushed revision" when the open PR lacks the delivered revision, ruling 134(c); then the commits, subject first; the actions, among them the "Push `<sha>` to PR #N" control, disabled with the refusal named for a diverged remote; and the Checked and Last change facts at the values' size, ruling 625), the accept dialog's "Gates" row (the same line, the failing gates in the same table; a failure is also the Blocked row, so the plain confirm is disabled and force names it under Bypassing), Changes (ruling 484: while the review PR is open and a revision is delivered, a closed panel whose Show changes loads its reader chunk and `…/changes`; each file is a `<details>` of its hunks, a line's number is the button that opens a note under it, a mouse drag across the numbers or a shift-click (Shift+Enter) spreads a note over several lines of one hunk, stopping before a line that has its own note, ruling 509, and "Send to @<deliverer>" posts every note at once; ruling 521: not while the completion packet carries the same reader), diagnostics | `comment`, `review-notes` (ruling 484: `notes` as JSON `[{path, line, side, body}]`, at most 50, and the `headSha` they were written on; ruling 509: a note on several lines adds its first line's `startLine` and `startSide`; one comment addressed to the deliverer quoting each `file:line` or `file:start-end`, through the `comment` door and its toasts), `transition` (ruling 381: a BACKWARD move carries a `reason`, collected by the shared `MoveBackConfirm` dialog and refused server-side without one), `update-goal`, `set-task-metadata` (ruling 501: writes only the axes whose fields the form carries, `priority`, `labels`, `dueDate`; a present empty field clears its axis), `set-task-dependencies` (ruling 131: the full `blockedBy` list, empty clears and releases), `set-task-epic` (ruling 503: `epic`, empty takes the task out; `edit-task-meta`), `owner-take`, `owner-release`, `owner-assign`, `run-agent`, `run-operator`, `run-interrupt`, `release-agent`, `resolve-packet`, `apply-recommendation`, `dismiss-recommendation`, `deliver-review`, `run-gates` (ruling 482: queue the project's gates on the revision under review again; maintainer+ or the owner, audited `task.gates.requested`), `accept-completion`, `refresh-and-review` (ruling 449: the accept dialog's "update the branch and re-review first" when the head that would merge is one no review ran on), `force-accept`, `complete-merge`, `request-maintainer-decision`, `schedule-action`, `cancel-schedule`, `archive-task`, `restore-task`, `attach-file` (ruling 379: the one MULTIPART intent, contributor and above, one file per submit, at most 10 MB) |
| `/projects/:slug/tasks/:key/attachments/:file` | `task-attachment.ts` | member | raw bytes, whitelist renders inline, `?download=1` forces the save dialog (ruling 105); over 50 MB answers 413 | |
| `/projects/:slug/tasks/:key/changes` | `task-changes.ts` | member (404 parity); signed out answers 401, never a login redirect | the Changes panel's read (ruling 484): the delivered revision's files and patches from its pull request, bound to that revision (a PR at another head answers why, not its files), with who a note reaches; `?path=` reads one file the first read left out for size. `shouldRevalidate` false: the panel loads it itself, and its `clientLoader` turns a failed load into the panel's own failure row | |
| `/projects/:slug/tasks/:key/dependency-candidates` | `task-dependency-candidates.ts` | member (404 parity, and for a key the project has no task for); signed out answers 401, never a login redirect | the Blocked by picker's read (ruling 548): every task in the project but this one, newest key first, each with its title, its stage's name and the refusal the writer would give it as a new entry (`archived`, `cycle` for one that already waits on this task, with the cycle's `chain`, `done`), or none; the picker says each in the writer's words (`app/shared/dependency-candidates.ts`). `shouldRevalidate` false: the wait's editor loads it as it opens, and its `clientLoader` turns a failed load into the picker's own line | |
| `/org/settings` | `org.settings.tsx` | org admin | "Instance settings" under the standalone-page header (ruling 145); tabs in order GitHub connections, Users & access, Sign-in & SSO, Agent resources (its four panels one per row, ruling 625), Controller (whose note lists grants the controller asked for and cannot make, each naming its unlock variable and the restart and carrying a Decline button, ruling 390); `?tab=resources&kb=<dir>&doc=<path>` (a knowledge-base proposal's "Open document", ruling 483) opens that knowledge base's browser on that document; `?tab=connections&add` opens the New GitHub connection dialog and `?tab=users&add=admin` the Allow access dialog with Admin chosen (Home's setup checklist, ruling 532); the run-concurrency and spending-cap rows (the form idiom: an uppercase label over the field, its hint under it, ruling 625); the Audit log card (browse, download, and the S3 target as one fact row, "S3 export", plus a button that opens the target modal, ruling 148(b); "Export to S3 now" and "Remove" stay on the card) | see §3 |
| `/org/settings/audit-export` | `org.settings.audit-export.ts` | org admin | CSV/JSON download, 100 000-row cap | |
| `/controller` | `controller.tsx` | user (CSRF checked as a result, not a throw) | "Controller" under the standalone-page header (ruling 623): instance controller conversation (per user), same page layout as the project controller, its band filling the height the header leaves (ruling 419; a reply shown from its first line and announced by one always-mounted status region, ruling 476(c), (d); steering, the queue, Send now and Retract, ruling 527); with a thread open, its Live-run strip and Agent-logs console (interrupt for the owner or an org admin); the rail's Delete on the viewer's own threads, and on everyone's for an org admin (ruling 525) | `send` (`text`, `conversationId`, `surface`, `timeZone`, `mode`, ruling 527), `send-now` and `retract` (`conversationId`, `messageId`, ruling 527), `interrupt` (`conversationId`, `runId`), `delete-conversation` (`conversationId`, `open`, `all`; ruling 525) |
| `/insights` | `insights.tsx` | org admin | run analytics under the standalone-page header (ruling 145), headed like Instance settings (title 20/700, a 14px lede; ruling 625): totals as wells, as on Agents, coordination share, outcomes (a restart-interrupted run is stopped, not an error, and a never-started one is out of the completion rate, ruling 158), breakdowns naming what their top 8 left out, the **Prompt cache** table (ruling 369: by run kind, by backend and run kind and by credential kind, with the planning baseline's columns and, under it, resumes by idle time and operator bursts, ruling 505; every figure on a `data-` attribute, rows keyed `data-cache-row="by run kind:primary"`, resume rows `data-resume-row="codex · login"` with each bucket's `data-past-ttl`, the burst note `data-operator-bursts`), oversight cards naming their exceptions (ruling 290; seven tiles run 4 + 3 on desktop, and an empty day on the runs chart draws a neutral tick, ruling 625), backend quota readings (a refused or exhausted row names whose account, a reading names the hour of its reset, ruling 130(d)). Details in [../domain/auth-and-rbac.md §6](../domain/auth-and-rbac.md#6-insights-insights-org-admin-only) | |
| `/profile` | `profile.tsx` | user | identity, password, notification routing (nine in-app toggles, agent questions on their own; and the per-browser Desktop notifications switch, the one place the browser permission is asked for; ruling 481), appearance, Your access, **Agent accounts** (ruling 127: connect Claude and Codex for yourself; ruling 130(d): each connected card shows the last refusal Viberr observed on YOUR account, never another person's; ruling 294: the last usage reading on it, in the past tense once its window has reset, ruling 481(d); Disconnect asks first, ruling 481(b); ruling 507: several accounts per backend, each renamable and disconnected on its own; ruling 616: the one in use is a "Runs use" picker whose menu lists every account and switches to the one chosen with no sign-in, and offers "Add another account" and "Manage other accounts"; `#agent-accounts`, the setup checklist's link, brings the panel to rest below the overlay's pinned head, ringed and focused, ruling 532), GitHub identity (its Disconnect asks first too). The password change is a row on the Profile card whose button opens a modal (ruling 148(b)); there is no reduce-motion setting (148(c)) | `identity`, `change-password`, `github-disconnect`, `set-notif`, `set-tl-default`, `backend-login-start`, `backend-login-code`, `backend-login-cancel`, `backend-set-key`, `backend-account-switch`, `backend-account-rename`, `backend-disconnect` |
| `/notifications` | `notifications.tsx` | user | newest 200, auto-read on viewing the target; every row is one anatomy (title, body, "Project · KEY" meta, the unread dot beside the time, "Mark read" a small ghost button), and "decision required" is the board's blue, amber staying for agent questions (ruling 625) | |
| `/notifications/read` | `notifications.read.tsx` | user (CSRF as a result) | fetcher target; GET redirects to `/notifications` | `read` (the default; repeatable `id`), `read-all` |
| `/prefs/theme` | `prefs.theme.tsx` | user (CSRF as a result) | writes `theme` to the user row and the `viberr_theme` cookie; GET redirects to `/` | |
| `/resources/events` | `resources.events.ts` | user (401 JSON) | SSE stream, scopes `project:<slug>`, `task:<slug>/<key>`, `projects`, `user` | |
| `/resources/run-log` | `resources.run-log.ts` | member / conversation owner; signed out answers a 401 `{ error: { code: "unauthorized", message } }`, never a login redirect, and the console says its tail stopped | run log lines for `runId` by `since` or `before`, `limit` clamped to 500, each answer with the run row's live facts (phase, step, turns, tokens, cache; the Live run strip reads them); `raw=0` leaves the stored envelopes out; `window=1` answers the run's agent group's console window as a hard refresh ships it (display lines, their keys, the window facts; ruling 457) | |
| `/resources/health` | `resources.health.ts` | public | liveness; `?probe=readiness` → 503 when degraded | |
| `/resources/search` | `resources.search.ts` | user; signed out answers a 401 `{ error: { code: "unauthorized", message } }`, never a login redirect | ⌘K palette query (`q`) over visible projects, loaded through a fetcher as the person types; a 401 reads as no hits, and so does a failed search, which its `clientLoader` answers with null | |
| `/resources/model-catalog` | `resources.model-catalog.ts` | user; signed out answers a 401 `{ error: { code: "unauthorized", message } }`, never a login redirect | models and efforts per backend (Claude enhanced with the VIEWER's own account), loaded through a fetcher by the agent editors; a 401, or a failed load (its `clientLoader` answers null), reads as a failed load the editor offers to retry | |
| `/resources/controller` | `resources.controller.ts` | user; a project or task scope the viewer cannot reach answers an empty `unavailable` view (GET) or `{ ok:false }` (POST), never a thrown response, because it feeds a root-owned fetcher; signed out answers a 401 with the `signedOut` view (GET, which names only the scope asked about and reads nothing) or `{ ok:false, error }` (POST), never a login redirect | the controller dock's view for the scope the person is standing in (ruling 121); `?seen=1` marks the shown transcript read (ruling 448). Its `clientLoader` answers a failed load with null (the open panel's loading lines) and its `clientAction` a failed send with `{ ok:false }` (the send's toast), never root's error page (ruling 457) | `send` (`text`, `conversationId`, `project`, `task`, `surface`, `timeZone`) |
| `/resources/notifications` | `resources.notifications.ts` | user | the bell popover's list: the viewer's newest `BELL_LIST_CAP` (100) notifications. Pages carry only the bell's counts (`bellCounts`); the bell loads this when the pointer or focus reaches it and on open, and again once the page has re-read the counts since (at once while open). It answers `shouldRevalidate` false; a signed-out request gets a 401, never a login redirect, and its `clientLoader` turns any failed load into the bell's failure row (ruling 457) | |
| `/resources/attention` | `resources.attention.ts` | user; a signed-out request (or a pending password reset) gets a 401, never a login redirect | ruling 481(c): `{ waiting, items }` (`attentionSnapshot`), the viewer's unread decisions (an operator packet, an agent question, a recommendation to approve) that lead somewhere, and the newest ten worded for a desktop notification with the bell's destination. `Cache-Control: no-store`; `shouldRevalidate` false. The root's attention watcher reads it with a plain `fetch` | |
| `/resources/controller-file/:id` | `resources.controller-file.ts` | the conversation's owner or a live org admin; anyone else, and a file that does not exist, 404 | one file sent with a controller message (ruling 573): the task route's serving rules (`nosniff`, a sandbox CSP, only the inline whitelist rendered, `?download=1` for the save dialog), the name in an ASCII `filename` and a UTF-8 `filename*` | |
| `/resources/controller-unseen` | `resources.controller-unseen.ts` | user; signed out answers a 401 with an empty status, never a login redirect | the dock's status: the viewer's controller conversations holding a reply they have not seen, each with the page that opens it; a thread in a project the viewer can no longer open is left out (ruling 448); and the viewer's turns working right now, with scope, phase and step (ruling 457). Like `/resources/controller`, it answers `shouldRevalidate` false: the dock loads it itself, and its `clientLoader` answers a failed load with null (no dot, no working poll) | |
| `/resources/mcp-oauth/callback` | `resources.mcp-oauth.callback.ts` | org admin (a signed-out admin goes through `/login` and back with the query) | where an MCP server's authorization server sends the browser after an OAuth sign-in started in Instance settings (ruling 469): spends the `state` once (bound to the session that started it), exchanges the code with the PKCE verifier, seals the tokens, probes the connection, and answers a plain page (`MCP sign-in`, no-store, no referrer, no token, code or state in it) that says the tab can be closed; a refused callback is a 400 page with the reason | |
| `/resources/backend-login` | `resources.backend-login.ts` | user; signed out answers a 401 `{ error: { code: "unauthorized", message } }`, never a login redirect | `?backend=claude\|codex` → the CALLER's own hosted sign-in session (`{ login, health }`), polled every 2 s by Profile → Agent accounts, whose card keeps what its page drew when a poll answers 401 or fails (its `clientLoader` answers a failed poll with null); an unknown backend is a 400 `{ error: { code: "validation_failed", message } }`, and it reads nobody else's session | |
| `/resources/session-export` | `resources.session-export.ts` | member / conversation owner | `?run=<id>`: resume-script download | |

The seven `backend-*` intents on `/profile` are the Agent-accounts panel: `backend-login-start`
{backend, method, account?} spawns the vendor's own binary (`claude auth login
--claudeai|--console`, `codex login --device-auth`) in the home of a new account, or with
`account` in that existing sign-in's own home (ruling 507); `backend-login-code` {backend, code}
writes Anthropic's one-time code to the child's stdin (Claude only); `backend-login-cancel`
{backend} kills it; `backend-set-key` {backend, kind, secret} verifies and seals a pasted API
key or ChatGPT workspace access token as a new account; `backend-account-switch` {account}
makes another of the person's accounts the one their runs bill, with no sign-in;
`backend-account-rename` {account, name} names it (an empty name clears it);
`backend-disconnect` {account} runs that account's vendor logout, deletes its home (or its
credential file) and drops its row. An `account` is refused unless it is the session user's
own. Full behaviour in
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
  double-registering. It finds projects, epics (by name or id, open ones first, a done or
  cancelled one saying so; ruling 503), tasks, branches and agents, in that order, over
  the projects the viewer may open (`searchWorkspace`). A task row leads with an open-circle
  glyph and its key as its own quiet span ahead of the title (`CommandHit.key`, ruling 625).
- **Topbar**: project crumb, notifications bell (popover), and the account menu. The
  bell (one implementation for the topbar, Home and the standalone header, ruling 14)
  draws the badge from the page's `unread` count and the popover head from
  `unread + orphanUnread` (F19-25); its list is its own fetch of
  `/resources/notifications`, started when the pointer or focus reaches the bell or on
  open (a first open with neither may show one "Loading notifications…" row) and reloaded
  once the page has re-read the counts since, whatever values they came back with (at
  once while open). A failed load shows "Couldn't load notifications." with Try again,
  never the error page. At the cap the list discloses it ("Showing the newest
  100", UI-14) (ruling 457). A row opens the thing it is about (ruling 497): the event
  on its task's timeline (marked, focused, its filter tab opened, older events loaded
  until it is shown), the task's open packet (`#decision-<id>`; once the packet closes,
  the timeline entry that records how) or `#recommendations`, a proposal's entry on the
  Controller page, the project's GitHub page, an epic's page; a click on a row about the
  page already on screen brings the place back into view, and the place stays where the
  link put it while the page settles, until the person scrolls, presses or types. A link
  to a place the task page no longer shows lands on its Timeline panel (ruling 547). The
  mark lasts until
  the person's next press anywhere on the page or key (a lone modifier aside), which takes
  the hash out of the URL in place, keeps the focus where the link put it and reloads
  nothing (ruling 523). The
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
  it: `/org/settings` ("Instance settings"), `/controller` ("Controller", ruling 623) and
  `/insights`. None of them carries a back button: the brand and the crumb root are the
  way back, as they are on the board's own settings page. The controller page keeps its
  own head under the header (its name, scope, New conversation) and fills the height the
  header leaves. The two routes NOT on the list keep their own chrome:
  `/profile` and `/notifications` render inside a `showModal()` `PageOverlay` that
  covers the viewport, where a header behind it would be a dimmed sliver.
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
  Claude (ruling 127); that sentence is the one statement of it (no placeholder in the box,
  no examples, ruling 625). On a tab whose session has ended, the dock's loads answer 401
  rather than navigating to `/login` (ruling 457): the button shows no dot, the open panel
  says "You're signed out, so the controller can't answer here. Reload the page to sign in
  again." over a disabled composer ("Sign in again to send a message."), and a send keeps
  its message in the composer with the error toast "You're signed out, so this wasn't
  sent. Copy it, then reload the page to sign in again." A load or send the server never
  answers (a restart, a 5xx, a dead network) keeps the page (ruling 457): a failed load
  reads as not loaded yet (no dot; the open panel's loading lines until the next load
  answers, as the stream's resync after a restart makes one), and a failed send toasts
  "The controller could not take that. Try again." with the message kept. Every open lands
  on the scope's newest thread, and a thread picked in the panel holds only while it stays
  open (ruling 528). The button's one dot is a still blue dot when a reply its owner has
  not seen waits in any scope, a working turn included (`/resources/controller-unseen`,
  rulings 448, 457 and 528); a turn at work shows in the open panel, never as a dot. The
  open panel links to replies elsewhere. Both transcripts (the dock and the controller pages) read in reply order,
  each reply under the message it answers, and a message with no reply yet says
  "answering now" or "queued · N ahead" from the server's lease, never from what the page
  sent; "… is working" sits under the answered message (ruling 465). Both transcripts show
  a reply that lands from its first line, never pulling a reader who scrolled up to
  history, and a link's URL or any other long token in prose wraps inside them (ruling
  476(a), (c), (i)). Both are tab stops that draw the focus ring inside their edge, so the
  keyboard scrolls them (ruling 626). A reader scrolled away from the newest message gets a jump back at the
  foot of the box, "New reply" when one landed meanwhile and "Latest" otherwise, and both
  set the thread as one centred column with the person's messages as bubbles and each reply
  as unframed text (ruling 572); the open panel has its
  own always-mounted status region that says "<name> replied: <first sentence>" for the
  thread on screen, and the working row is no live region (ruling 476(d)). Root ships only the button, the panel's frame and header; the panel's body
  loads on the first open, preloaded on hover or focus (ruling 457). The dock's data
  rides no page revalidation: the page's `user` stream hands it `controller.updated`
  instead (ruling 457). On `/insights`, which has no stream of its own, the open panel
  opens one (`DOCK_SELF_STREAM_ROUTE_IDS`). Details in
  [../domain/controller-and-epics.md §2.1](../domain/controller-and-epics.md#21-the-dock-ruling-121).
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
  inputs, the store browser's inputs and its document's raw text, and the
  concurrency field (the 720px block in `app.css` is the list). Under the 1100px collapse the task page stacks
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
  the Change repository dialog, the S3 audit target (a `MiniModal`: its unmet line
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
The store browser shows a document it opens (`store-read-doc`) as one card (ruling
614): a head with the file's path and, for a markdown file (`.md`, `.markdown`), a
Preview / Raw switch; the document, rendered on arrival when it is markdown and its raw
text otherwise; and a foot with its state and Close (Cancel once it changed) beside Save
document. Raw is where a document is edited; Save (`store-write-doc`) stays disabled on
an opened document until its text changes, and the foot reads "Unsaved changes" while it
differs (its line count and size otherwise). A new document opens on Raw under its
file-name row, and Preview renders the draft.
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
in, the pasted-credential field is replaced by a sentence saying none is used, and what
the field held goes with it, so a save sends no key typed before the sign-in landed and a
sign-out brings the field back empty (ruling 514); editing the endpoint warns that
saving drops the sign-in. `mcp-oauth-sign-out` revokes
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
A refusal that names the `cred` field (ruling 514: a credential under 8 characters, or
one pasted over a live sign-in the page had not read yet) reads under the credential
input, which it marks `aria-invalid` and describes; every other refusal reads at the
form's foot.

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
[../domain/controller-and-epics.md §6](../domain/controller-and-epics.md#6-configuring-the-controller-rulings-106-and-108)
and [../operations/configuration.md §2](../operations/configuration.md).

## 4. Screen labels

Every top-level surface and dialog carries `data-screen-label` so tests and agents can
address it by name: `Login`, `Login · set new password`, `Home · project selection`,
`Setup` (Home's setup checklist, ruling 532), `Pinned projects`, `All projects`, `Archived
projects`, `Settings` (the Home tiles and the project settings page), `Store strip`, `New
project modal`, `Board`, `Empty state` (Insights, the controller page and the Epics page), `Epics`, `Epic`, `New epic
dialog`, `Edit epic dialog`, `Add tasks dialog` and `New task in epic dialog` (ruling
503), `Review queue`, `Controller`, `Agents`,
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
`Interrupt turn dialog` (ruling 419), `Undo correction dialog` and `Dismiss proposal
dialog` (the Controller page's knowledge-base panel, rulings 498 and 483),
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
  top-level entry under `app/` must be claimed by one of these scans. Em and en dashes,
  typed or spelled as an escape or an HTML entity, are banned from the same rendered copy,
  from the seed assets (P21: reword with a comma, period, colon or parentheses) and from
  every string literal under the same four server roots, prompts and log lines included
  (ruling 571; its one exemption is the task.md glyph for an empty evidence result).
  "primary specialist" may not appear in rendered or server-built copy (the capability id
  `assign-primary-specialist` excepted); say "delivering agent".
- **Retired "specialist" wording** (`app/features/retired-vocabulary.test.tsx`): no
  seeded agent asset teaches the retired "primary specialist" model; no
  operator-recommendation chip renders "specialist"; the Agents
  page's live-roster empty state, run-in-flight stat, capability matrix modal and
  role-less profile card say "agent profile" / "agent threads", not "specialist".
- **One Operator, with no role** (ruling 518; `app/features/copy-ban.test.ts`,
  `agents-page.test.tsx`): nothing a person or an agent reads calls the operator a
  coordinator, in code or in a seeded asset. Its rows on Agents and Policy, its hero and
  its glyph's tooltip give the name alone, with no role pill, no "Orchestration" group
  label and "Built in · runs on every task" under it; its editor has no Name or Role
  field; the task page's OPERATOR cell shows the since line and what it does, with no
  second name.
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
  is mapped; ruling 508: every scope family the theme emits has a colour, so a diff's
  lines are green and red, and a log colours a number whole and a level by severity),
  unless a NUL byte in its first 8,000 characters sends it to the no-preview
  card ("This file is not text"). A markdown file opens rendered instead, under a
  Preview / Raw switch at the top of the card whose Raw is that code reader; its pictures
  and links to the task's own files resolve to their serving route (ruling 614). A body whose fetch proved the file unservable (404
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
  settled-runs archive, so exactly one console exists either way. The console is a tab
  stop (`role="log"`, "Log stream for <run>"), so the keyboard scrolls it (ruling 626). On the task page the
  timeline's own "open console" still travels to the anchor, because from there the
  console really is elsewhere, and opens the disclosure first so there is something to
  travel to. On the Controller page the card, or the archive after it, is a pane of its own
  between the conversation and the rail, and the console fills the pane's height; hidden,
  the strip goes under the composer (ruling 524(a)).
- **The Live run card reads as a strip** (ruling 524(d)): the phase and step, with Hide
  console and Interrupt beside them; the four facts (Elapsed, Turns, Tokens, Runtime) under
  them as one strip of equal cells, two by two on a phone; the console under that. The
  clock's digits roll in 300ms, so each second's digit stands (ruling 524(b)), and a run is
  named once where its role only repeats its name ("Controller", not "Controller ·
  Controller"; ruling 524(c)).
- **A person may attach a file to a task** (ruling 379): the Attachments panel renders
  for every task and carries an "Attach a file" control for a viewer holding
  `attach-file` (contributor and above) on a task that is not archived. The picker offers
  any kind of file (ruling 574); the writer refuses a traversing or dot-prefixed name and
  anything over 10 MB (`MAX_UPLOAD_BYTES`). Every file name carries its whole self in `title`, and under
  the 720px breakpoint a file row gives the name its own line, whole, with "by <actor> ·
  <time>" and the size under it (ruling 478(b)).
- **A project admin takes a file off a task's record** (ruling 582): the card a file
  opens in carries Remove, which asks first, in the shared confirm, with an optional
  reason. A removed file leaves the attachments and every entry that claimed it, and a
  note says who removed it and why. A comment offers no Remove: the operator edits or
  deletes an agent's comment itself, silently (ruling 584).
- **Every chat takes files** (rulings 573 and 574): the controller page, the controller
  dock and a task's comment composer (for a viewer holding `attach-file`) share one tray
  (`app/ui/attach-files.tsx`): a paperclip, a drop on the composer (its frame dashed while
  files are held over it) and a pasted screenshot, shown as removable chips, a picture as
  its thumbnail. Any kind of file; a pick over 10 MB, or past 10 files or 25 MB together,
  is refused in the tray before the request, in the server's own words. Files alone are a
  message, and a file leaves the tray only once the server took it. A controller
  message's files show under it (a picture as itself, any other file as the tray's chip);
  a comment's show under it as the timeline's tiles.
- **A long attachment list folds the way a long comment does** (ruling 510): past 340px
  (the comment's fold, `Collapsible` in `app/ui/collapsible.tsx`) the panel's pictures and
  files clamp under a soft fade with "Show more" / "Show less" (`aria-expanded`) below them,
  while the heading, its file count and "Attach a file" stay above the fold. Keyboard focus
  on a row under the fade opens it; a row in plain sight, focused again when an attachment's
  card closes, or a pointer's focus leaves it folded. A comment's links under its fade open
  it the same way.
- **A timeline entry's pictures show their first row and fold with its text** (ruling 522):
  the files an event's run saved show as many tiles as stand on the strip's first line
  (four at a 1728px window, one at 390px), and the rest are not drawn until the fold opens.
  A comment's one toggle stays at the foot of its card and says what it hides beyond the
  text: "Show more · +6 images" when the text is cut too, "Show 3 more images" when only
  pictures fold (a comment with short text gets it for them alone), "files" once anything
  but a picture is among them, and "Show less" open; it opens and folds the text and the
  pictures together. A typed event's toggle follows its strip. Show less, on every fold,
  keeps the toggle where it stood on screen, scrolling the nearest box back by what folded
  above it.
- **An agent's question is answered to the agent** (ruling 478(e)): on a packet the render
  marks with `answerTo` (an `Agent question` with `askedBy`) nothing is preselected, even
  the option the agent recommends (its "recommended" pill stays, and only a "(Recommended)"
  mark earns it); no packet that recommends nothing preselects anything. The box under the
  options reads "Your answer to <agent>" with the hint "optional · goes back to <agent> with
  your choice · 4,000 characters max", or "required · …" (and the `*`) when the chosen
  option carries `reply`; the directive's hint reads "resolves this decision · goes back
  to <agent>". Every other packet keeps "Note for the operator".
- **The task page's agent components** (ruling 500, AICSS's free components redrawn in the
  app's tokens): the decision packet is an approval card, a tile in its tone (amber for a
  question with a hand, coral for a block with an alert) beside the kind as its title and
  "from <who>" at the right, its options each led by their key, the digit that selects them
  (`aria-keyshortcuts`), where the radio stood, the chosen key filled with the call to
  action; a comment's or note's fenced block has a head, the language its fence names (or
  "code") and Copy, over the block, which past one line takes the attachment reader's
  line-number gutter; a comment's table is one card, its header a quiet band, hairlines
  between cells; and the task's composer takes the controller composer's frame (the card
  radius, the 4px focus ring) with Comment as its primary action.
- **A question the work does not wait on** (ruling 529): an open question while the task's
  wait is an agent's sits flat on its hairline with a neutral tile, and its first line reads
  "Not blocking: an agent keeps working while you decide." beside the agent pulse; a block,
  and a question the task waits on, keep the approval card's shadow and tone.
- **Details: each property is its own control** (ruling 501, the way Linear's and GitHub's
  issue sidebars draw properties): the rows are a property grid (ruling 520), a label
  column of one width and every value starting on one left edge beside it, with no
  hairline between; a value that wraps keeps its first line on its label's. A value is
  the board card's vocabulary (the priority
  flag, the label chips, the due pill; a wait's entries as chips with a status ring: a
  dotted ring open, a check done, a red ring and red chip for an entry that can never
  complete), or, with nothing to say, a quiet line in the placeholder ink: "Normal",
  "None", "Nothing" for a viewer; "Add labels", "Set due date", "Add dependency" for an
  editor (`edit-task-meta`). For an editor the value is a ghost trigger (the hover fill,
  a blue edge while open, named "<label> <value>") that opens its editor under the row:
  Priority a menu (Urgent, High, Normal, Low, each flag in its pill's tone, the current
  one checked; arrows, Home, End), Labels the label picker with Cancel and Save (a press
  that leaves its field lands where it began: the field keeps its height until the press
  is over, ruling 561), Due date
  the calendar (a pick saves; "Clear due date" when one is set), Blocked by the wait's own
  form (ruling 131), a picker since ruling 548: each entry the row's chip with the Owner
  row's remove cross (Backspace in the empty field takes the last), then a field that finds
  the project's tasks by key or title ("Search by key or title"): the free ones while
  nothing is typed; once typed, the task whose key it is first, then the free matches,
  then the ones the writer would refuse as a new entry, dimmed, the reason where the stage
  was ("done", "archived", "waits on <KEY>"), a pick of one adding nothing and the live
  region saying the writer's own sentence. Enter adds the highlighted task (typing
  highlights the best match; a key already listed, nothing) and, with none highlighted,
  saves; a pointer highlights the row it moves over and takes the highlight with it when it
  leaves the list; a pasted list of keys goes in key by key; an entry that can never
  complete reads "<KEY> can never complete: take it out to save." under the field; an
  unchanged Save closes without a request. For an editor the row's own chips carry the
  cross too, and the trigger is the plus after them: a press saves the wait without that
  entry at once (the cross spins until the server answers, and the other crosses and the
  plus ignore presses meanwhile), a cross that leaves nothing still open asks first
  ("Release <KEY>?", "Keep the wait" or "Release <KEY>"), since that is the release, and
  once the chip goes the plus takes the focus. Escape closes and hands focus back to the
  trigger; a save shows "Saving…" with the spinning loader on the trigger that started it
  (ruling 368), and a refused wait keeps its editor open beside the error. An archived
  task's values are text, with "Archived. Restore this task to edit its details." under
  them.
- **Current state is the same property grid** (ruling 520): Stage, Waiting on, Last
  activity, Owner and Repo are Details' rows, so the side column's property panels and the
  PR card's two facts share one value line. Each value is led by its mark in a 16px column:
  the stage's dot; who owes the next move in the board card's marks (the hand for a human
  or a goal edit, the clock for a schedule, the ring for a queued run, the live pulse for
  agent work, the ban for other work, whose keys never break at their hyphen); the activity
  pulse; the owner's avatar; the GitHub mark, the repository in the code face. The values
  read at one size and weight, the tone on the mark alone. An empty value is the quiet line
  ("Nothing", "Nothing on the timeline yet", "Unowned"), and "Assign me" the invitation, a
  ghost trigger. The stage is a ghost trigger too, its menu hanging from its left edge.
- **Written text sits under the page's headings and shows what it holds** (ruling 478(a),
  (f)): typed timeline events render as markdown like comments (a fenced block scrolls on
  its own, inline code breaks); a timeline entry's or a packet body's top heading renders
  at h3 with deeper ones following; the GitHub panel's bar carries a visually hidden h2
  "GitHub". The Live run strip's step cuts at the strip's edge with its ellipsis
  (`.run-phase-text`, ruling 478(c)).
- **The stream pickers say whose console is shown** (ruling 478(d)): the Agent logs picker
  is named "Agent log stream: <name> · <role>" (the role left out when it only repeats the
  name, ruling 524(c)) and the live strip's "Running agent: …";
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
- The Activity **audit** column carries the epics (ruling 503): "<person> created epic
  **epic-3** (<title>) with N tasks.", "<person> changed epic **epic-3** (<title>): renamed
  it from … to … and set the status to Done." (the writer's own summary of what changed),
  a task's move on its chip ("set the epic to **epic-3** (<title>) on", "moved the epic
  from **epic-2** to **epic-3** … on", "cleared the epic **epic-3** … on"), and the
  conversion's own record, "Goal **goal-3** became epic **epic-3** (<title>) with N
  tasks." A task the conversion made for an unstarted link has its creation events signed
  by **Epic conversion** (a system actor, so the stream's Humans filter leaves them out).
  The goal-chain rows an upgraded store holds still read as ruling 477(b) wrote them
  ("<person> created goal **goal-1** (<title>) with N links.", a sentence per redirect op,
  "Goal **goal-1** (<title>) completed: every link is settled.", and creation events
  signed by **Goal chain**).
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
    editor shows it as a pressed chip that can be pressed off (and back on) before the
    save: under its project's name in Custom stages, or, when no live board has it, as
    "build" in the "On no project's board" row (ruling 618).
- **The global profile editor offers each project's own stages** (ruling 618, pinned by
  `org-settings-page.test.tsx` "ruling 618", `pagination.test.tsx` and
  `org-view.server.test.ts`): Default eligible stages reads in two groups, "Default
  workflow" and "Custom stages" ("N selected" once the profile names any; "From each
  project's own board. A profile names stages by id, so a stage counts on every board
  that has it."; "No project's board adds a stage of its own." when none does). Each live
  project whose board has stages outside the default workflow is a row named for the
  project, with its task key, "N selected" once the profile names any of its stages, and
  that board's own stage chips in its names and colours, never its last stage. An id two
  boards share is pressed on both. The rows the profile names come first, then the rest
  by name, ordered at the open. Past three projects the rows page behind the "Custom stage
  pages" control, in shadcn's Pagination shape: "Previous", the page numbers with "…" for
  a skipped run (at most seven slots), "Next", the current page outlined, an end with no
  page past it aria-disabled, and "Projects 4 to 6 of 7" beside it. Below 560px the ends show
  their chevrons alone. A stored stage no live board has sits above the rows in the dashed
  "On no project's board" row, on every page.
