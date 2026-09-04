# The controller and chained goals

> The instance-level conversational agent, its governed toolkit, its built-in
> diagnostics server, its deployment locks, and the goal chains it can define.
> Source of truth: `app/server/controller/*`, `app/server/tasks/goal-actions.server.ts`,
> `app/server/files/goal-writer.server.ts`, `app/schemas/goal-file.schema.ts`,
> `app/features/controller/*`, `app/routes/resources.controller.ts`, `app/root.tsx` (the
> dock mount), `app/features/org-settings/controller-admin-panel.tsx`.
> Rulings 99, 100, 106, 107, 108, 121, 127 in [decisions.md](../architecture/decisions.md).
> Verified against `main` @ `68b5480` (2026-09-01); the ruling-121 dock, conversation
> scopes, context read and `update_task` verified against the working tree on 2026-09-02
> and re-verified on 2026-09-03 after the ruling's adversarial review (see the dated
> correction note under ruling 121 for what that review changed). Updated 2026-09-02 for
> ruling 127 (branch `claude/per-user-codex-auth-difdnn`): §1 and §2 (a turn runs on the
> asker's own Claude account), §5 (`instance_health`'s new per-backend shape, and a dated
> correction to ruling 107).

## 1. What it is

The controller is one instance-wide agent that every signed-in user can talk to.
It is machinery like the per-task operator but sits above it: it answers questions
about the instance and its projects, performs governed actions **strictly within the
asking user's own permissions**, and defines chained goals that the server then
carries forward task by task. It never replaces the operator; each task a goal
creates gets its own operator through the ordinary create-task path.

Identity facts:

- A third profile kind, `kind: controller`, exactly one per instance:
  `agents/profiles/controller.md` (shipped frontmatter: `backends: [claude]`,
  `model: sonnet`, `spanAll: true`, `resources.skills: [controller-guide]`,
  `resources.kb: [controller-handbook]`, `capabilities: []`) plus its doctrine at
  `agents/definitions/controller.md`, its skill `skills/controller-guide/SKILL.md`
  and its knowledge base `kb/controller-handbook/handbook.md`. All four are shipped
  into the store by the boot backfill (`seedDefaultAgentAssets`), never by the
  project-deployment seed.
- Not deployable to projects: `readTemplate` resolves a controller-kind template as
  absent, and the global-agents panel lists and edits specialists only.
- No capability matrix. Its runtime authority is the asking user's, so a stored grant
  row would be a toggle with no effect.
- Claude only. The toolkit is in-process (DB handles and sealed credentials never
  cross a process boundary) and Codex's single-shot plan executor cannot serve a
  conversation that reads mid-turn.
- **A turn runs on the ASKER's own Claude account** (ruling 127). The credential
  principal of a controller run is `input.user.id` (`resolveUserRunPrincipal`), and the
  run row records it in `credential_user_id`; there is no instance account, so "is the
  controller available" is a question about the person looking at it. A viewer who has
  not connected Claude is refused honestly INSIDE the transcript ("The controller runs
  on your own Claude account, and Claude isn't connected for you yet. Connect it on your
  Profile → Agent accounts, then send your message again."), and the composer is
  disabled with that same sentence before they type it. Somebody who DID connect and
  whose sign-in file went with a wiped runtime volume gets the store's specific sentence
  instead ("Your Claude sign-in file is missing from this server …"), because telling
  them to connect something they already connected is not an instruction anyone can
  follow. Another member who HAS connected
  Claude keeps conversing at the same moment: one person's missing connection is never
  an instance outage. Dispatches the toolkit makes (`startAgentRun` / `runOperator`) act
  on a TASK, so they bill that task's owner, not the asker.
- Its actor reference in task files is the bare `controller`; it renders as an agent
  named "Controller". `@controller` is a reserved mention handle.

## 2. Surfaces and access

| Surface | Who | Notes |
|---|---|---|
| `/controller` | any signed-in user | Instance scope. `?c=<id>` selects a conversation; `?all=1` lets an org admin list everyone's. |
| `/projects/:slug/controller` | project members (non-members get the unknown-slug 404) | Board scope: the same conversation machinery bound to the project, plus the **Goals panel**. Eighth item in the workspace rail. |
| Org settings → Controller tab | org admins | Configures the controller itself (§6). |
| **The dock**, on every signed-in surface | any signed-in user | Ruling 121: a floating Controller button, bottom-right, opening a non-modal panel bound to the place the person is standing (§2.1). Hidden on the two controller pages and on `/login`. |
| `/resources/controller` | any signed-in user; project and task scopes require membership | The dock's data route: `GET ?project=&task=&c=` answers the scope's view, `POST intent=send` records the message and runs the turn. |

Entry points: the dock (everywhere), the workspace rail item, the Home hero link (once a
project exists), the org-settings tab's "Open the controller", and the goal chip on a
task page. There is no command-palette entry. The page subscribes to the user SSE scope (and the
project scope on the project surface) and polls every 5 seconds while a turn is
working. The composer is disabled when the VIEWER has no Claude connected (ruling 127)
or when they do not own the active conversation; the two states render different
sentences, because only the first one is theirs to fix.

Conversations belong to the asking user. `canAccessConversation` allows the owner and
a **live-resolved** org admin; project members do not read each other's transcripts;
a non-owner gets a 404-shaped refusal so "not yours" and "never existed" look the same.
Only the owner may send. Org admins reading project-scoped transcripts for projects
they are not members of is intended (ruling 100).

### 2.1 The dock (ruling 121)

`controller-dock.tsx`, mounted once in `root.tsx` whenever the root payload carries a
csrf token (the signed-in signal). Its scope follows the matched routes
(`controller-dock-context.ts`, pure and tested): a task page anchors it to that task,
any workspace view binds it to that board, everything else is instance scope; on
`/controller`, `/projects/:slug/controller`, `/login`, `/profile` and `/notifications`
it renders nothing — the last two render their whole page inside a `showModal()`
overlay, which would leave the dock inert behind it.

- **Trigger**: a 44 px circular button, 20 px from the bottom-right corner, named
  `Controller · <scope>` (`Instance`, `<project name>`, `<KEY> · <project name>`) — the
  name comes from the workspace loader, so it reads the same before the first open and
  after it,
  `aria-haspopup="dialog"` / `aria-expanded`, wearing the `.live-dot` while a turn is
  working in the dock's conversation (open or closed; the dock polls every 5 s until it
  settles).
- **Panel**: `role="dialog" aria-modal="false"`, `data-screen-label="Controller dock"`,
  400 × min(640, 100dvh − 96) px docked above the trigger; no scrim, no focus trap, no
  body scroll lock (the page stays usable). Header: the controller's name, the scope
  pill, Threads (this scope's threads, count in the name), New, Open page (the full
  surface with `?c=`), Close. One context line names what the controller knows here.
  The transcript reuses the page's message vocabulary and the composer takes focus on
  open (⌘↵ / Ctrl↵ sends) — on a user-initiated open only, so a remembered-open reload
  never starts focus inside the textarea. Escape closes and returns focus to the trigger
  **while focus is inside the panel**; an Escape elsewhere (the palette, a confirm
  dialog, a stage menu) leaves the dock alone, and an outside press never closes it.
- **Availability is the VIEWER's** (ruling 127): the dock's `available` is
  `isBackendAvailableFor(db, viewer, "claude")`, in the normal view and in the
  `unavailable` refusal view alike, so a person with no Claude connected reads the
  same sentence the full page's composer and the refused turn's transcript line
  carry. There is no instance credential for it to report.
- **Continuity**: the dock opens on the newest thread of the current scope; the selected
  thread per scope and the open/closed state survive a reload for the life of the tab
  (`sessionStorage`, wrapped, absent in SSR). Navigating swaps the scope and keeps the
  panel open; a working turn keeps working.
- **Live**: the view is a root-owned `fetcher.load` of `/resources/controller`, re-run
  on every revalidation, so any surface streaming the `user` scope refreshes it. While
  open, the dock mounts its own `user` stream only on the surfaces that have none —
  today `/insights` alone (`DOCK_SELF_STREAM_ROUTE_IDS`, pinned by a test against the
  modules that really call the hook); everywhere else a second socket would only
  duplicate revalidations.
- **Never the root error page**: the view's route answers a benign empty view for a
  scope the person cannot reach and falls back to this scope's newest thread for a
  selection it cannot honour (reporting `staleSelection`, which the dock uses to forget
  the stored id). A thrown response from a root-owned fetcher would replace the whole
  page, which is the hazard ruling 121(f) named for CSRF.
- **Motion**: the panel grows from its trigger (`transform-origin: bottom right`,
  .18s `--ease-out` in, .12s out on a pointer close, instant on Escape); a reply that
  arrives while the panel is open lands with a .2s fade-and-rise (history never
  animates: the component marks only messages it had not seen in the same
  conversation); reduced motion (OS or the in-app preference) fades only.
- **Small screens** (≤ 720 px): a full-width bottom sheet, `min(80dvh, 640px)` tall,
  entering and leaving along the bottom edge; the trigger stays on screen above the
  sheet (R19-12), smaller, as a second close.
- **Errors**: refusals are in the transcript (the run engine writes them); transport
  failures (expired session, stale CSRF) come back as `{ ok:false, error }` and show as an
  error toast, never as the root boundary.

## 3. Conversations and turns

Storage is app-owned SQLite, the same family as notifications and sessions:
`controller_conversations(id, user_id, user_label, project_slug, task_key, title,
created_at, updated_at, last_message_at)` with `CHECK (task_key IS NULL OR project_slug
IS NOT NULL)` and `controller_messages(id, conversation_id, seq, author user|controller,
user_id, text, run_id, surface, created_at)` with `UNIQUE (conversation_id, seq)`.

A conversation's **scope** (ruling 121) is fixed at creation: instance (`project_slug`
and `task_key` null), board (slug alone) or task (slug + key). `listConversations`
filters on both (`taskKey` undefined = any binding under the slug, null = the board's own
threads, a key = that task's); `createConversation` refuses a task without a project.
`surface` is the in-app path (pathname + query, normalized to 400 chars, no control
characters) a USER message was sent from; controller rows carry null. The title is the
first user message clipped to 80 characters. Every appended message publishes the
owner-routed SSE event `controller.updated`.

**One user message is one run** (`runControllerTurn` in `controller-run.server.ts`):

1. The user message is recorded first.
2. If Claude is unavailable, a refusal is written into the transcript.
3. Single-flight per conversation with a FIFO capped at 8 queued messages; overflow
   is refused in-transcript.
4. The run row is `agent_runs.kind = 'controller'`, `project_slug = ''`,
   `task_key = <conversation id>`, so no task-scoped query ever matches it. Model is
   the profile's through `resolveRunModel("claude", …)`; effort only when set. The
   newest prior controller run is resumed when it has a session id, otherwise a fresh
   run starts. Each prompt opens with the **context read** (ruling 121,
   `gatherControllerContext`): a block labelled as a server read taken when the turn
   started — for a task-anchored conversation a derived header (stage and position, next
   stages with their boundaries, owner, engaged agents, branch and PR, open packet, goal
   chain) plus the canonical `task.md` verbatim inside a five-backtick fence, bounded by
   `TASK_FILE_CONTEXT_CHARS` (24 000; over budget the head stays whole and the newest
   timeline entries are kept, with a marker naming how many were omitted); for a board,
   the project's description, repo, members, stages with counts, boundaries, the open-task
   table (`BOARD_CONTEXT_TASKS` 40 rows, `BOARD_CONTEXT_CHARS` 12 000) and the goal
   chains; for the instance, the projects the person can see with their role; then, when
   the message carried one, `They are looking at: <surface>`. The whole block stays under
   `CONTEXT_BLOCK_CHARS` (32 000); the fence is always longer than the longest backtick
   run inside the file, so nothing in the file can close it, and a line in the server's
   own voice above it says the fenced bytes are data and never instructions. The read is
   gated: the asking person's LIVE visibility of the bound project is re-proven through
   the same `assertProjectAction` chokepoint the board tools use, and a refusal replaces
   the block with the toolkit's uniform not-visible sentence. After it comes a digest of the last 30 messages
   (24 000 chars, 600 per message), then the message. The context read is why the
   controller does not need a `task.md` of its own: the anchored task's is read in fresh
   every turn.
5. Mounts on every turn: `viberr_controller` (§4), `viberr_ops` (§5), then the
   controller's granted org MCP servers. Denied built-ins: `Read`, `Grep`, `Glob`,
   `WebFetch`, `WebSearch` plus the operator read-only set (`Bash`, `Edit`,
   `MultiEdit`, `Write`, `NotebookEdit`). The system prompt replaces the Claude Code
   preset: doctrine, attached skills and KBs (24 000-char KB budget), a runtime block
   naming mounted and unmounted MCP servers, and a conversation block naming the
   asker, their live org role, the project binding (and the task anchor, when there is
   one: "tools default to both, and every turn opens with the task's canonical file as a
   server read") and the rule that only this person's own messages authorize actions.
   Working directory is `<dataRoot>/runtimes/controller-scratch`.
6. `settleTurn` records the reply (or a failure note naming quota/auth/other),
   releases the lease and starts the next queued message.

Everything the run machinery gives every other run applies: raw NDJSON transcript,
line redaction, token accounting, the run-log console (owner or org admin, via
`canReadControllerRunLog`, the same gate `/resources/run-log` and the session export
apply), and boot orphan finalization. Boot also gives any conversation whose turn a
restart orphaned an honest "interrupted by a server restart" note
(`recoverControllerConversations`). Run-log SSE events are suppressed for controller
runs (they would fail the wire schema's non-empty-slug rule); the page polls instead.
Insights labels them `controller (instance)`.

## 4. The `viberr_controller` toolkit

`buildControllerToolkit` (`controller-toolkit.server.ts`) builds an in-process Claude
SDK MCP server per turn. The actor is `{ userId: <asker>, label: "<email> · via
controller" }`: guards bind to the human, audit rows disclose the instrument.

Guards (`controller-tool-guards.server.ts`, shared with `viberr_ops`):

- `requireOrgAdmin(what)` resolves `isOrgAdmin` live per call, writes
  `controller.authority.denied {scope: "instance", what}` and refuses with the guard's
  own sentence.
- `requireVisible(slug, what)` routes through `assertProjectAction(db, "any-member",
  …, { allowArchived: true })` and turns any failure into one uniform sentence,
  `[denied] No project "<slug>" is visible to you.`, so a probe cannot learn a project
  exists.
- Every handler maps a 401/403 to `[denied] <sentence>` and anything else to
  `[error] …`. The doctrine tells the model a `[denied]` is final and must be relayed.

The 38 tools (ruling 121: `projectSlug` defaults to the bound project and, on a
task-anchored conversation, every task tool's `taskKey` defaults to the anchored task —
**only within the anchor's own project**: a call that names a different `projectSlug`
must name its task, or it is refused. `whoami` reports both bindings):

| Scope | Tools | Gate |
|---|---|---|
| Instance reads | `whoami`, `list_users`, `list_knowledge_bases`, `list_skills`, `list_mcp_servers`, `list_global_agents`, `inspect_audit_log` (limit 50, max 200), `inspect_run_analytics` | `whoami`: signed-in; the rest: org admin |
| Instance writes | `create_user` (relays the one-time temp password), `update_user`, `set_user_org_role`, `save_knowledge_base`, `save_skill`, `save_mcp_server` (takes no credential; reserved names refused), `test_mcp_server`, `save_global_agent` (specialists only; **grants are store keys and an omitted list is left alone** — see below) | org admin |
| Project creation | `create_project` (any shape: stages, boundaries, members, description) | any signed-in user; the asker is seeded project admin (FR5) |
| Board reads | `get_project`, `list_tasks`, `get_task` (events 12, max 50), `get_github_state`, `list_goals`, `get_goal` | `requireVisible` |
| Board writes | `create_task` (`create-task`), `move_task` (refuses a terminal target and points at the task page; else `approve-transition`), `comment_on_task` (any member; posts as `controller`, never starts a run), `set_task_owner` (`own-task`, takeover needs the acceptance tier), `update_task` (ruling 121: the goal under `update-goal`, priority / labels / due date under `edit-task-meta` as a full replace — the task page's two writers and gates, each part reported on its own, and an axis already holding the asked-for value answers `[noop]` rather than claiming a write nobody made; ruling 131: `blockedBy` is the FULL list of what the task waits on through `setTaskDependencies`, reported on its own arm, a refusal in the validator's words, `[]` clearing it and releasing the task), `create_task` also takes `blockedBy` (validated before a key is allocated; the task is born held), `run_agent_on_task` (`run-agents`; operator → `runOperator({trigger: "manual"})` relaying `open-packet` / `terminal-stage` / queued honestly, else `startAgentRun`), `update_project_settings`, `update_stages`, `set_transition_boundary` (`edit-policy`), `invite_member`, `set_member_role` (`manage-members`), `deploy_agent`, `update_agent_deployment` (`manage-agents`) | `requireVisible` then the same `requireAction` / `assertProjectAction` matrix humans use |
| Goals | `create_goal` (`create-task`, 1..20 links, each with an optional `blockedBy`), `update_goal` (creator or `run-agents`; `edit_link` without `blockedBy` leaves the link's list, `[]` clears it; `add_link` takes one) | `requireVisible` then the goal gate (§7) |

Invariants pinned by tests: there is **no** tool for merge, acceptance,
force-accept, packet resolution or a move into the terminal stage (ruling 88's
disclosure ceremony is what chat cannot impersonate), and no tool deletes an entity
(`update_stages op: remove` and `update_goal op: remove_pending_link` edit a file's
list, they do not delete a project, task, user or resource). Policy edits **are**
offered, gated on the asker's `edit-policy`, because the controller never initiates:
it executes an explicit human directive with the same authorization a settings form
carries (ruling 100 confirmed the missing confirm ceremony as intended).

### 4.1 Grants through the toolkit (pass 33, F33-7 / F33-8)

Two defects made every resource grant the controller wrote inert, and made every
partial edit destructive. Both are fixed and both are worth knowing when reading the
tool descriptions.

- **Grants are STORE KEYS.** `save_global_agent`'s `skills` / `mcps` / `kbs` take the
  skill **folder name**, the MCP **registry name** and the knowledge-base **directory** —
  the same keys the runtime mounts by (`mountGrantedSkills` by folder,
  `byName.get(name)` for MCP, the glossary's "grants reference the directory" for KBs).
  They used to store whatever they were handed, and the model handed them the **ids** its
  own read tools returned, so a template created through chat carried
  `disk:developer-expertise` / `mcp_…` / `kb_…` and mounted nothing while the roster
  counted "3 context resources". `resolveResourceGrants` now normalizes a recognised id
  to its key and refuses one nothing in the store answers to, naming it. The three list
  tools lead each row with `grantKey` for the same reason.
- **An omitted list is left alone.** The three lists are merge fields now, matching the
  sibling `update_agent_deployment` ("only the fields you pass change"); `[]` clears one
  explicitly. They used to default to `[]` inside a full replace, so "change the summary"
  erased every grant — and `list_global_agents` returned no grants at all, so the model
  could not see what it was about to erase. That tool now returns `skills`, `mcps` and
  `kbs`.

## 5. The `viberr_ops` diagnostics server (ruling 107)

An in-process, read-only MCP server mounted on **every** controller turn with no
config read and no grant row, so nothing can remove it. Its name `viberr_ops` is in
`RESERVED_MCP_NAMES` and refused at the writer (`saveMcpServer`), skipped by the
picker (`buildResourceCatalog`) and never resolved from the registry
(`resolveSpecialistMcpServersDetailed`). The Controller settings tab shows it as a
pinned, non-interactive chip.

| Tool | What it returns | Gate |
|---|---|---|
| `instance_health` | The same `healthSnapshot` the `/resources/health` route serves (status, degraded subsystems, projections, watchers, lock holder, `backends.<b>.connectedUsers`, browser, disk, maintenance, build), plus `backendCredentials: [{ backend, connectedUsers, askerConnected }]` and the run concurrency snapshot `{cap, live, queued}` | Open to anyone: nothing here names another person or any deployment configuration. The browser executable **path** stays org-admin only (`browserDetail`) |
| `read_run_log` | A bounded page of a run's console: `run {…, logLines}`, `page {firstSeq, lastSeq, olderExist, newerExist, next}`, `lines[{seq, at, display}]`. Default 200 newest lines, max 500, in either direction; `since` together with `before` is refused | A member of the run's project; a controller turn's log follows conversation ownership with org-admin supervision. A missing run, a forbidden project and a forbidden conversation all answer the same not-visible sentence |
| `read_store_doc` | One store document with `truncated` reported honestly | org admin |

Nothing here writes, deletes or starts anything. The health body assembly lives in
`app/server/ops/health-snapshot.server.ts` so the route and the tool read one
derivation.

**Correction to ruling 107 (2026-09-02, ruling 127).** Ruling 107 split
`instance_health`'s backend reading in two: everyone learned WHETHER a backend was
usable, only an org admin learned WHY (the credential detail named the deployment's
config directory and the environment variable to set). That split no longer applies,
because the thing it protected is gone: agent backends are connected per person, there
is no deployment credential and no config path to withhold. The org-admin-only detail
arm is deleted, and the tool answers every asker the same two facts per backend, both
safe: `connectedUsers` (a count, the same one the unauthenticated health probe already
publishes) and `askerConnected` (a fact about the person asking, and the only one that
changes what they can do next). Ruling 107's own subject — one health derivation, read
by the route and the tool — is unchanged.

## 6. Configuring the controller (rulings 106 and 108)

Org settings → Controller tab (`controller-admin-panel.tsx`, `controller-save`
intent, `saveControllerConfig`):

- **Model and effort** use the same catalog pickers as the agent profile editor
  (`ModelEffortFields` + `useModelCatalog("claude")`); a dated `claude-*` id or a
  family alias the served catalog does not list is preserved verbatim rather than
  repinned. Always editable.
- **Grant sections** (skills, knowledge bases, org MCP servers) and **instructions**
  (the doctrine file) are **deployment-locked by default, org admins included**.
  Four variables unlock one section each: `VIBERR_UNLOCK_CONTROLLER_SKILLS`, `_KB`,
  `_MCPS`, `_INSTRUCTIONS`, unlocked only when the value is exactly `enabled`
  (case-insensitive, trimmed). `disabled`, any other value, or unset keeps the lock.
  Restart to apply; compose passes them through with `disabled` as the default.
- Enforcement is server-side: `saveControllerConfig` reads `controllerSectionLocks()`,
  writes a locked section's stored grants verbatim, and refuses a non-empty input
  that differs from what is stored, naming the section and its unlock variable. A
  locked, non-blank, differing instructions body is refused; a blank body keeps the
  file. The panel renders locked groups as plain chips (dangling grants shown but not
  removable), the doctrine read-only, and one note listing the locked sections and
  their variables. Audit: `org.controller.updated`.
- The lock covers the settings tab only, by owner decision: deleting or renaming a
  resource on the Agent resources tab still prunes the controller's grant through
  the shared reference rewrite, and editing a granted skill's or KB's file contents
  still changes what the controller loads.

## 7. Chained goals

A goal decomposes **one outcome into an ordered chain of tasks inside one project**.
The controller (or any authorized member through it) defines the chain; the server
advances it.

### 7.1 The file

Canonical at `projects/<slug>/goals/goal-<n>.md`, written only by the app (hand edits
are tolerated by the parser; unknown keys round-trip). Frontmatter: `id`, `title`,
`status` `active | paused | attention | completed | cancelled`, `createdBy`,
`createdByLabel`, `onFailure` `pause | continue` (default `pause`), `links[]` with
`index` (1-based), `title`, `goal` (becomes the created task's `## Goal`), `taskKey`
(null until reached), `status` `pending | active | done | failed | skipped`, `note`;
`createdAt`, `updatedAt`. Body: `## Description` then `## Timeline` of newest-first
`- <UTC ISO> · <text>` bullets. Each member task carries the back-reference
`goalRef: {goalId, linkIndex}`, projected to `task_projections.goal_id` /
`goal_link_index`; the task hero shows a goal chip.

`goal_projections` is the derived row; the rebuilder **reconciles link statuses
against live task rows** (archived → failed unless done; terminal stage → done; a
stored done/failed whose task is open again → active), walks goals after tasks, and
emits the project-routed SSE event `goal.updated`. Goal files are watched, rescanned
and store-checked like every canonical file. Goals are never deleted; terminal chains
stay readable.

### 7.2 Defining

`createGoal` requires the asking user's own `create-task` in the project, a title of
at least 3 characters and 1..20 links (`GOAL_MAX_LINKS`). Under the goals lock it
mints the id, creates **link 1's task first** through `createTask` (so a refusal
leaves no orphan file; the task's own operator auto-invoke fires as usual), marks
link 1 `active`, writes the file, re-projects and audits `goal.created`.

### 7.3 Advancing

`reconcileGoal` is a convergent engine: hooks and the runner both just say "look at
this goal now". It runs from three task write paths (stage transition, archive or
restore, acceptance), after `resume | skip_link | add_link`, and from
`startGoalRunner` (a boot catch-up, then every 60 seconds over goals in
`active | attention`). The same three hooks and the same tick (`goalRunnerTick`)
also run the dependency release engine (ruling 131(e), `releaseDependents` /
`releaseDueDependents`): every held task in the project whose `blockedBy` entries
are all done is released, so a link finishing releases whatever waited on it within
the same write, and a hand edit the hooks never saw releases within a minute. Each
pass reads every linked task's state from its canonical file and applies:

- a failed link (its task archived or missing) with `onFailure: pause` parks the
  chain in `attention` and notifies the creator; with `continue` it marks the link
  `skipped` and moves on;
- when every link is settled and the chain is not in `attention`, the goal completes
  (audit `goal.completed`, notification to the creator);
- the current pending link with no task is started: the creator's **live**
  `create-task` is re-proven (`creatorMayCreateTasks`, silent deny); lost authority
  parks the chain in `attention`. The task is created under the actor
  `{ userId: createdBy, label: "<label> · goal chain" }` inside a per-link lock that
  re-checks the chain status before and after `createTask`. Ruling 131(c): the link's
  declared `blockedBy` is copied into `createTask` and validated there, so the task is
  born held (`waiting: none`, readiness floored at `blocked`) and the link history says
  what it waits on; a wait that can no longer be satisfied (its task archived since the
  declaration) refuses the create and parks the chain in `attention` with the
  validator's sentence.

### 7.4 Redirecting

`updateGoal` is gated by `requireGoalAuthority`: the creator (project mutable and any
membership) **or** a member holding `run-agents`. Operations (terminal chains refuse
all of them): `pause`, `resume`, `cancel`, `skip_link`, `retry_link` (failed links
only; a fresh task under the present caller), `edit_link` (pending or failed; ruling
131(c): `blockedBy` absent leaves the link's declared wait, `[]` clears it, any list is
validated at declaration time, this chain's own links included),
`add_link` (≤ 20), `remove_pending_link` (re-indexes). Audit `goal.updated {op}`.
The project route's `goal-op` intent and the Goals panel expose only the first five;
`edit_link`, `add_link` and `remove_pending_link` are controller-tool-only today.

The Goals panel shows status and link pills, task-key links, per-failed-link Retry
and Skip, and Pause/Resume and Cancel. Its controls render only for `run-agents`
holders (or an org admin); a contributor-tier creator is allowed by the server but
currently sees no controls, and must redirect conversationally.

## 8. Identifiers this subsystem emits

- Audit actions: `controller.authority.denied`, `org.controller.updated`,
  `goal.created`, `goal.updated`, `goal.completed`, plus `task.agent.commented` with
  label `controller` and every downstream row under `<email> · via controller`.
- Notification kind: `controller`, created only for goal progress (started, attention,
  completed), addressed to the goal creator, from the "Controller" agent identity.
  The category has a routing toggle in the profile, default on.
- SSE: `controller.updated {conversationId, userId}` (owner-routed),
  `goal.updated {projectSlug, goalId}` (project-routed).
- Timeline: `comment` events authored by `controller` with the trailer
  `_Posted by the controller for <name>._`.

## 9. Known drift (recorded, not fixed here)

*(2026-09-02: the first two items recorded here on 2026-09-01 — the doctrine's
`list_projects` mention and its "a comment mention can start a run" sentence — were fixed
by ruling 121's doctrine and skill rewrite, shipped through the hash upgrade.)*

- Ruling 108's note that the panel "skips the P13-KM-01 display-name repair" under a
  lock is stale wording: the panel runs the repair for display and posts blank for
  locked sections; the byte-for-byte outcome holds through the server.
- The notification-kind comment describing a "controller conversation reply"
  notification describes something never created; replies arrive through
  `controller.updated` revalidation, not a notification row.
