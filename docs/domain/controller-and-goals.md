# The controller and chained goals

> Updated 2026-09-17 for rulings 309, 310 and 312 (pass 37): §3's system prompt names each
> granted MCP server that did not mount with the reason its own probe gave, carries the
> ruling-namespace paragraph above the tool manifest, and closes its conversation block with
> the generated project-authority tier list (advisory, never enforcing); the task and board
> context reads carry the asking person's live project role as `your authority: …`.
> Updated 2026-09-13 for rulings 192, 194 and 197 (pass 37): a chain can be renamed, a retry
> rebuilds from the failed TASK's own contract, `get_goal` carries `liveGoal`, a retry that
> starts nothing says so, and a template's persona is readable so a summary-only edit is not
> a blind one.
> Updated 2026-09-13 for ruling 188 (pass 37): a controller read answers with what the
> equivalent human surface renders. `get_project` reports board-RESOLVED eligible stages
> (plus `declaredStages`, so a ruling-R14-1 remap is visible); `get_task` reports
> `notAcceptableReason` — the acceptance gate's own verdict — instead of the stage-unaware
> `blockReason` column; `list_mcp_servers` reports ruling 176's `writeTools`,
> `writeToolsReviewed` and what the marking does; and `save_mcp_server` takes `writeTools`,
> answering with the marking that landed and, when none is set, naming the tools that look
> like writes so a server is never left ungoverned in silence.

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
> correction to ruling 107). Updated 2026-09-11 for pass 36 cluster 4 (ruling 183, U36-3,
> U36-4, U36-5, G36-1): §3 and §4.1 (`save_knowledge_base` takes `doc.append` (ruling 377/F39-1: add to the end, create when absent, no `replace`/`replaces` because an append destroys nothing, and the two modes together are refused) so a long document is built in bounded calls instead of one large one; `save_knowledge_base` and `save_skill` answer with the
> id and grantKey, a `disk:<dir>` id whose folder has a row updates that row, `save_skill`
> refuses a body that is not a skill, `update_agent_deployment` takes `skills` / `mcps` /
> `kbs` for every kind) and §4.2 (the reply lists every changed field old → new, the
> `updated` audit row carries model and effort, the effort descriptions read the catalog).
> Updated 2026-09-11 for ruling 178 (pass 36, G36-3): §4 gains `set_required_reviewers`,
> and `get_project` reports `requiredReviewers`.

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
| `/controller` | any signed-in user | Instance scope. `?c=<id>` selects a conversation; `?all=1` lets an org admin list everyone's. With a thread open, the thread's execution (§2.2). |
| `/projects/:slug/controller` | project members (non-members get the unknown-slug 404) | Board scope: the same conversation machinery bound to the project, plus the **Goals panel**. Eighth item in the workspace rail. Same execution panels as the instance page. |
| Org settings → Controller tab | org admins | Configures the controller itself (§6). |
| **The dock**, on every signed-in surface | any signed-in user | Ruling 121: a floating Controller button, bottom-right, opening a non-modal panel bound to the place the person is standing (§2.1). Hidden on the two controller pages and on `/login`. |
| `/resources/controller` | any signed-in user; project and task scopes require membership | The dock's data route: `GET ?project=&task=&c=` answers the scope's view, `POST intent=send` records the message and runs the turn (409 when the asker has no Claude connected, U35-4). |

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
  page, which is the hazard ruling 121(f) named for CSRF. The unavailable view names
  nothing but what was typed (F35-4, pass 35): `projectName` is null, the label reads
  "Not available here", and the projection is never read for it, so a non-member
  cannot learn a project's display name from a guessed slug (the same posture as
  every other door).
- **The send door says no where the composer does** (U35-4, pass 35): `POST
  intent=send` for a person with no Claude connected answers `409 { ok:false, error }`
  with the refusal sentence and creates no thread for a new conversation; a refused
  turn on an existing thread answers 409 too, with the note already in the transcript.
  Both page routes (`/controller`, `/projects/:slug/controller`) answer the same 409.
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

### 2.2 The open thread's execution

A controller turn is a run like any other (§3), so with a thread open both pages show
it the way the task page shows a task's runs, fed by the same projection
(`listRunsForTask(db, "", <conversation id>)`, the ruling-99 scope): every turn of the
thread resumes the same agent, so the runs group into ONE console entry with `run N of
M` boundaries between turns.

- **Live run** (above the transcript, only while a turn is `running`): the run's phase
  and last tool step, elapsed from the run's own `started_at`, turns and tokens off the
  run row, the model, **View logs** (scrolls to the console and selects the thread) and
  **Interrupt**. Turns and tokens refresh with the loader: the 5-second poll, and the
  `controller.updated` reference a lifecycle flip now publishes (the sink routes a
  controller run's state changes there instead of the task-scoped `run.state-changed`).
- **Interrupt** is offered to the conversation's owner and to org admins
  (`canInterruptTurn`); it confirms first (D6, "Interrupt this turn?" / "Interrupt
  turn") and posts `intent=interrupt` with the conversation and the run id. The engine's
  `interruptRun` gates a controller run on `canInterruptControllerRun` (owner or live org
  admin, the same two people who may read its log; a stranger gets the 404 shape) instead
  of the project membership the run has none of, then settles the turn: the transcript
  records "This turn was stopped before I could answer." and the lease is released, so
  the next message starts a fresh turn. A turn stopped while still queued (no adapter to
  exit) is settled the same way, because the engine now fires the run's completion
  callback from its no-live-handle arm.
- **Agent logs** (below the composer): the grouped console with the `{ } raw` and follow
  toggles, the session-id chip and the backward paging of `/resources/run-log`, behind
  the owner-or-admin gate that serves the raw view. Live tailing is the controller channel
  of `useRunLogStream`: the sink publishes `controller.log-appended {conversationId,
  userId, runId, threadId, seq}` to the OWNER's `user` stream for every stored line
  (`controllerRunRoute` resolves the owner once per run), the console fetches the lines
  since its cursor, and the frame is a stream event `useLiveUpdates` ignores
  (`SSE_STREAM_EVENTS`), so one turn's tool calls never revalidate every surface the
  person has open. A supervising org admin reading someone else's thread sees the same
  console off the loader's poll; the frames are the owner's. The streaming footer says
  "never in the transcript" here, where the task record does not exist.
- Neither panel renders for a thread that has not run yet.

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

**A reply the owner has not seen (O39-d, ruling 448).** `seen_seq` on the conversation is
the highest message `seq` its owner has looked at. The two surfaces that show a transcript,
the controller page and the open dock, set it when its owner is the one looking
(`markConversationSeen`: monotonic, publishes nothing, so a revalidation can run it
again). A controller message above it is unseen (`listUnseenReplies`). The dock's button
carries a dot and says "a new reply" on every page. `/resources/controller-unseen` lists the
viewer's unseen replies in any scope, with the page that opens each, and leaves out any
thread in a project the viewer can no longer open. The open panel links to replies from
other places and marks unread threads here, and the page's rail and phone picker mark them
too. None of this is a notification row: replies stay out of the bell (§8).

**One user message is one run** (`runControllerTurn` in `controller-run.server.ts`):

1. The user message is recorded first.
2. If Claude is unavailable, a refusal is written into the transcript and the turn
   returns `{ state: "refused", reason }`; every send door answers that as a 409
   (U35-4, pass 35), and the dock's door refuses before creating a new thread.
3. Single-flight per conversation with a FIFO capped at 8 queued messages; overflow
   is refused in-transcript.
4. The run row is `agent_runs.kind = 'controller'`, `project_slug = ''`,
   `task_key = <conversation id>`, so no task-scoped query ever matches it. Model is
   the profile's through `resolveRunModel("claude", …)`; effort only when set. The
   newest prior controller run is resumed when it has a session id, otherwise a fresh
   run starts — unless that session is BOTH idle past its cache TTL (60 min on a
   sign-in, 5 min on an API key) AND above 150k tokens, in which case ruling 372 starts a
   fresh run instead of replaying it (the two largest first calls this instance ever made,
   911k and 929k, were controller resumes 39 hours and 71 minutes after the previous turn
   on a 945k conversation): the prior run gets a `run·session_stale` line, the fresh turn's
   prompt says the session was set aside on purpose and points at the digest below, and
   the run's start audit records `continuityReset: "stale_large_session"`. Each prompt
   opens with the **context read** (ruling 121,
   `gatherControllerContext`): a block labelled as a server read taken when the turn
   started — for a task-anchored conversation a derived header (stage and position, next
   stages with their boundaries, the asking person's live project role as
   `your authority: …` (ruling 309), owner, engaged agents, branch and PR, open packet, goal
   chain) plus the canonical `task.md` verbatim inside a five-backtick fence, bounded by
   `TASK_FILE_CONTEXT_CHARS` (24 000; over budget the head stays whole and the newest
   timeline entries are kept, with a marker naming how many were omitted); for a board,
   the project's description, repo, members, the same `your authority: …` line (ruling
   309), stages with counts, boundaries, the open-task table (`BOARD_CONTEXT_TASKS` 40
   rows, `BOARD_CONTEXT_CHARS` 12 000) and the goal chains; for the instance, the projects
   the person can see with their role; then, when the message carried one, `They are
   looking at: <surface>`. The authority line (ruling 309, `askerAuthorityLine`) names the
   role and stops — `project role maintainer`, or the org-admin override named as such
   (it holds every action here), or `not a member of this project` — a live read taken
   with the visibility gate at the end of this step, and never a held/not-held set: the
   tier list in the system prompt is static, this line is personal, and the model
   multiplies the two; it ends by saying that a role on any OTHER project is not in this
   read (`whoami` has it). The whole block stays under
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
   preset and reaches the SDK as `{ type: "custom", prompt: [static, boundary, dynamic],
   snapshot: true }` (ruling 373): recorded on the session's first request and reused
   verbatim on every later turn until a compaction, so a changed append on a resume does
   not invalidate the cache prefix — which is also why the per-turn tool manifest reaches a
   running conversation at its next compaction. Every list in it is sorted by name (ruling
   370). The static block is doctrine, attached skills and KBs (24 000-char KB budget), a runtime block
   naming the mounted MCP servers and, for every granted server that did NOT mount, the
   reason its own probe gave, with the instruction to say so in those terms and not to
   infer a cause the server did not give (ruling 310, the third surface), then the
   ruling-namespace paragraph above the per-turn tool manifest (ruling 297): a ruling
   number inside a tool description is Viberr's own product decision, not readable from a
   run and not a project's rule, while a project's rules live in its knowledge base,
   number from 1, and are cited by document and section rather than a bare number (ruling
   312); the measured shell inventory (ruling 191); and a conversation block naming the
   asker, their live org role, the project binding (and the task anchor, when there is
   one: "tools default to both, and every turn opens with the task's canonical file as a
   server read") and the rule that only this person's own messages authorize actions,
   followed by the project-authority tier list (ruling 309): generated from
   `RBAC_DEFINITIONS` by `projectAuthorityPrompt`, each tier naming the actions it is the
   floor for (a grant that gates more than its name says carries its `covers` scope in
   parentheses, ruling 309(a)), then the hand-written exceptions marked as hand-written,
   and the rule that the list is ADVISORY, NEVER ENFORCING — predict a refusal, say why,
   make the call anyway, and let the server's answer be the answer; the asking person's
   own project role is not in this list but in the context read above. The conversation
   block, the tier list beside it (ruling 309: the claim and what makes it usable stay in
   one place) and the "did NOT mount this turn" notice are the dynamic tail behind the
   SDK's boundary. Working directory is `<dataRoot>/runtimes/controller-scratch`. The
   run carries no context window (ruling 376: the CLI's own limit stands, and a turn that
   leaves the conversation above 100k is compacted at its end, warm), and a
   `SessionStart` hook on the `compact` source hands the conversation anchor back after a
   compaction — the conversation id, the person, the scope, that every turn's server read
   outranks the summary, that `viberr_ops` is still attached, and to ask rather than guess
   when the last request depends on lost context. The controller's tools stay deferred
   behind ToolSearch (deferred tools only append and keep the cache).
6. `settleTurn` records the reply (or a failure note naming quota/auth/other),
   releases the lease and starts the next queued message.

Everything the run machinery gives every other run applies: raw NDJSON transcript,
line redaction, token accounting, the run-log console (owner or org admin, via
`canReadControllerRunLog`, the same gate `/resources/run-log` and the session export
apply; rendered on the controller pages, §2.2), the interrupt (`canInterruptControllerRun`,
§2.2) and boot orphan finalization. Boot also gives any conversation whose turn a
restart orphaned an honest "interrupted by a server restart" note
(`recoverControllerConversations`). The task-scoped run stream cannot carry a controller
run (the wire schema's non-empty-slug rule, and an empty slug would match every `projects`
firehose), so `run-events.server.ts` routes a controller run's frames to the conversation
owner instead: `controller.log-appended` per stored line, and the `controller.updated`
reference for a lifecycle change. Insights labels them `controller (instance)`.

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

The 42 tools (ruling 121: `projectSlug` defaults to the bound project and, on a
task-anchored conversation, every task tool's `taskKey` defaults to the anchored task —
**only within the anchor's own project**: a call that names a different `projectSlug`
must name its task, or it is refused. `whoami` reports both bindings):

| Scope | Tools | Gate |
|---|---|---|
| Instance reads | `whoami`, `list_users`, `list_knowledge_bases`, `list_skills`, `list_mcp_servers`, `list_global_agents`, `inspect_audit_log` (limit 50, max 200), `inspect_run_analytics` | `whoami`: signed-in; the rest: org admin |
| Instance writes | `create_user` (relays the one-time temp password), `update_user`, `set_user_org_role`, `save_knowledge_base` (U36-4: the reply names the KB id the next save takes and the grantKey a grant takes; a `disk:<dir>` id whose folder already has a row updates that row), `save_skill` (the same reply; ruling 183: an empty, JSON-escaped or unparseable SKILL.md body is refused by name, never rewritten), `save_mcp_server` (takes no credential; reserved names refused), `test_mcp_server`, `save_global_agent` (specialists only; **grants are store keys and an omitted list is left alone** — see below; ruling 153: `model` and `effort` set the template's defaults, checked by name; ruling 156: the reply names every project copy whose grants differ and `propagate: true` rewrites them) | org admin |
| Project creation | `create_project` (any shape: stages, boundaries, members, description) | any signed-in user; the asker is seeded project admin (FR5) |
| Board reads | `get_project` (each deployment with its `resources` copy and `templateDrift`, ruling 156; `requiredReviewers`, the project's required-reviewer rules resolved to stage and agent names, ruling 178), `list_tasks`, `get_task` (events 12, max 50; `schedules` lists the pending entries, ruling 153), `get_github_state`, `list_goals`, `get_goal` (ruling 192: a link with a task carries `liveGoal`, that task's CURRENT goal, whenever it has moved past the text the link was declared with — the declared text stays beside it, because that is what the chain declared and what the history means) | `requireVisible` |
| Board writes | `create_task` (`create-task`), `move_task` (refuses a terminal target and points at the task page; else `approve-transition`), `comment_on_task` (any member; posts as `controller`, never starts a run), `set_task_owner` (`own-task`, takeover needs the acceptance tier; ruling 140(b): the person whose seat changed is notified, and the audit row says whether they were told), `update_task` (ruling 121: the goal under `update-goal`, priority / labels / due date under `edit-task-meta` as a full replace — the task page's two writers and gates, each part reported on its own, and an axis already holding the asked-for value answers `[noop]` rather than claiming a write nobody made; ruling 131: `blockedBy` is the FULL list of what the task waits on through `setTaskDependencies`, reported on its own arm, a refusal in the validator's words, `[]` clearing it and releasing the task), `create_task` also takes `blockedBy` (validated before a key is allocated; the task is born held) and, ruling 140(a), `owner` (a member email or `me`; seated in the creating write before the first operator run, checked by the hand-off rule; the release word is refused by name) and `dueDate`, with `priority: urgent` as the urgent flag itself, `run_agent_on_task` (`run-agents`; operator → `runOperator({trigger: "manual"})` relaying `open-packet` / `closed` (ruling 177) / queued honestly, else `startAgentRun`), `schedule_task_action` and `cancel_task_schedule` (ruling 153; `run-agents`: the task page's schedule form through the controller, `agent: "operator"` or a deployed profile id, `delayMinutes` 1 to 40320 or an ISO `dueAt` with the same bounds and sentences, the entry on `task.md` with the `<email> · via controller` label; a cancel answers `[noop]` when the entry is not pending), `update_project_settings`, `update_stages`, `set_transition_boundary`, `set_required_reviewers` (ruling 178: the project's required reviewers per review stage as the WHOLE list, `[]` clearing it, through the same writer Settings → Required reviewers uses; every stage id must be a non-terminal stage and every profile id a deployed agent holding report-validation-verdict, else refused by name with nothing written; an unchanged list answers `[noop]`; audited `project.required_reviewers.updated`) (`edit-policy`), `invite_member` (C4: takes the `role` the member joins in, seated in ONE write with one audit row; omitted is viewer, and an unknown role is refused by name with nothing written), `set_member_role` (`manage-members`), `deploy_agent`, `update_agent_deployment` (`manage-agents`; G36-1: `skills` / `mcps` / `kbs` for every kind, the operator included, grant keys resolved before the write, omitted = unchanged, `[]` = clear; U36-3: the reply lists every changed field old → new) | `requireVisible` then the same `requireAction` / `assertProjectAction` matrix humans use |
| Goals | `create_goal` (`create-task`, 1..20 links, each with an optional `blockedBy`), `update_goal` (creator or `run-agents`; `edit_link` without `blockedBy` leaves the link's list, `[]` clears it; on an ACTIVE link `blockedBy` is the only editable field and is written on the link's task through `setTaskDependencies`, under that writer's own gate, the link mirroring it back (ruling 155); `add_link` takes one) | `requireVisible` then the goal gate (§7) |

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
  `kbs`. **And the PERSONA, which that fix left out** (ruling 197, pass 37 F37-18): a blank
  persona has always kept the stored one (`description: persona || existing.description`),
  but the tool's description spelled the merge rule out for the three lists and said nothing
  about the one field whose loss destroys an agent's whole system prompt, and
  `list_global_agents` did not return it — so the controller hit the same wall F33-7 had
  cleared, two rulings later, and refused: "`save_global_agent` gives me no way to edit a
  summary without also supplying a persona, and I cannot read the personas I'd be replacing."
  Three template summaries advertising Testcontainers, Docker Compose and Playwright stayed
  on a host with none of them, to the operator, which picks agents by that text. Both
  descriptions now state the rule and the persona rides the list.
- **A project copy is its own record** (ruling 156, pass 35 F35-7). A library deploy
  copies the template's three lists onto the deployment (`definition.resources`) and a
  run mounts that copy, so a template grant never reached a deployed project and the
  tool answered a bare `[done]` (live: `context7` on the template, `mcp.mounted:
  ["viberr_agent"]` on the next run). The reply is built from the result now: it names
  every non-archived project whose copy differs and what it lacks or holds beyond the
  template ("1 project copy does not carry this change: k9c-k9s-clone is missing MCP
  server context7"), and the two doors: `propagate: true` on the next call, or an org
  admin's "Use the template's grants" on that project's Agents page (owner, Q35-8:
  org admins only; a project admin sees the marker and asks). Propagation REPLACES the
  copy's three lists (owner, Q35-7: a project-local extra is dropped and the reply says
  so) and nothing else, records `project.agent_profile.resources_synced` per project,
  and `list_global_agents` carries `copiesDiffering` so "is it granted on the project?"
  is answerable without a run. Names are entity-decoded once and angle brackets are
  refused (U35-1): `Test &amp; CI Engineer` is stored as `Test & CI Engineer` with the
  id `test-ci-engineer`.
- **The controller edits a deployment's copy for every kind** (G36-1, owner Q36-7, pass
  36). `update_agent_deployment` takes `skills` / `mcps` / `kbs` with the same semantics:
  grant keys resolved through `resolveResourceGrants` before anything is written, an
  unknown key refused by name, an omitted list left alone, `[]` clearing it. They merge
  into the deployment's own copy (`definition.resources`), the operator included. The
  Agents page already rendered the picker for every kind while the controller answered
  "a system profile I can't give resources to". The `grantKey` each `list_*` tool leads
  with is what it takes; `get_project` shows the copy; the reply lists each list old →
  new.
- **A create reply is re-enterable** (U36-4, pass 36). `save_knowledge_base` and
  `save_skill` answer with the id the next save takes and the grantKey a grant takes:
  `[done] X created. Folder ready at store://kb/x/ (id kb_…, grantKey x).` The toast
  alone named the folder, so the controller guessed `disk:<dir>` — the shape shipped,
  row-less folders carry — and was refused "already exists" on a KB it had just made,
  because a `disk:` id matched no row and fell into the create arm. A `disk:<dir>` (or
  `disk:<name>`) id whose folder has since gained a row now resolves to that row and
  updates it (`kbRowForId` / `skillRowForId` in `resources.server.ts`); the folder
  conflict fires only for its real case, another row holding the target name.
- **A SKILL.md body is judged before it is written** (ruling 183, pass 36, F36-2).
  `save_skill` is one of the writers `assertSkillBodyWellFormed` guards
  (`skill-body.server.ts`, beside the containment reader; the others are the
  org-settings editor, an upload and the store browser's document editor). A body that
  is empty, that arrived JSON-escaped (literal `\n` sequences and no real newline — what
  the model sent twice, live, and what landed on disk as one line) or whose frontmatter
  block does not parse is refused by name with the remedy, never rewritten; plain
  markdown with no block stays valid, since the mount adds the block and the editor
  never wrote one. `body` is required on a create and omitted on an update to keep what
  is on disk.

### 4.2 Catalogued writes read first and refuse by name (pass 34, ruling 139)

Every controller write that takes a catalogued identifier validates it against the
catalogue the runtime resolves by and refuses an unknown or impossible value BY NAME,
listing what is valid, before anything is written; `[done]` is never answered for a
write the store did not make. `update_agent_deployment` refuses, through
`capabilityPatchRefusal` (`app/features/agents/capability-catalog.ts`): an id outside
the deployment's KIND (an operator id on a specialist and the reverse are named as
such), an id nothing in the catalogue answers to, a matrix-only advisory id (refused as
"no toggle", never as "no such id"), `recommend` on a specialist, a non-`human` mode on
an always-human id, `report-validation-verdict` at any mode but `direct` or `off`; and,
in the same call, a stage id the project does not declare (listed with the project's
stage ids). The check lives in the tool, not in `grantsFor`: the project editor
legitimately preserves advisory and retired ids a strict catalogue check would refuse.

For every such catalogue there is a read the same person may call first, and the write's
description names it. `get_project` returns each deployment's RESOLVED grants (every
stored id at the mode the runtime applies, with its label — and, ruling 377(a), an
`advisory` note on a matrix-only row, which is persona guidance nothing enforces and
`update_agent_deployment` refuses; no such key means a real, settable grant), model, effort
and, for the operator, autonomy, derived by the Agents page's own `assembleAgentRoster` from the
projection (every agent writer reprojects before it returns), so the controller reads what
the roster renders: an absent `deliver-review-pr` at the project's delivery-gate mode, the
grant-required family at `off`. `list_capabilities` (instance scope, any signed-in person,
like `whoami`) serves the ids per kind with their labels, the modes each kind takes, the
always-human three, and `whenUngranted`: the mode a deployment resolves to when project.md
carries NO grant for the id, which is `absentGrantMode` in `agents-query.server.ts`, the one
home the roster also materialises absent grants with, never the catalogue's create-seed
default (`create-task-branch` seeds `direct` and resolves `off` when absent). The two
policy-dependent operator grants (`deliver-review-pr`, `update-task-branch`) are named as
such and read from `get_project`.

Every controller write is audited under the ASKING PERSON with the controller named as
the instrument (ruling 99(b)); pass 34's C5 made the Activity audit column render that
disclosure ("<name> (via the controller)") instead of dropping it for the joined user
name.

`update_agent_deployment` also carries the `deploymentFingerprint` of the record it just
read (B5), so its own read-modify-write inside one turn is never refused by itself while a
hand-save landing between that read and the write is, with the same by-name refusal shape:
re-read, then write again.

Effort is settable wherever model is (ruling 139): `deploy_agent` takes `model` and
`effort` overrides and `update_agent_deployment` takes `effort`; both check the value
against the backend's tier list (`assertEffortForBackend`, `assertModelForBackend` in
`model-catalog.server.ts`) BEFORE the write and refuse by name, listing the tiers, so the
controller can never store a tier the runtime would silently clamp. A backend switch with
no effort resets to that backend's default and the reply says so; both the `deployed` and
the `updated` audit rows record the model and effort written (U36-3, pass 36: the
`updated` row used to carry neither). The three effort descriptions (`save_global_agent`,
`deploy_agent`, `update_agent_deployment`) are generated from the catalog's tier lists
(`effortsFor`; U36-5), so a tier the catalog offers — Codex `max` since CLI 0.153 — is
never described as missing. The profile editor shares the check for a CHANGED value only,
so a deployment that legitimately stores a preserved tier (Codex `minimal`) stays
editable, and the editor re-seeds a stored tier the backend does not list instead of
offering it.

`update_agent_deployment`'s reply is built from the record it read and the result the
writer returned, never from the request (U36-3): it lists every field the call changed,
old → new — backend, model, effort (a switch-time reset marked "(Codex default: none
given)"), stages, autonomy, each patched capability and each grant list — as
`[done] Developer updated on viberr-core: backend Claude → Codex; effort high → max; …`,
and a call that changes nothing answers `[done] … No field changed.` One live call that
switched backend, model, effort, stages and grants used to answer "Effort is now max."

## 5. The `viberr_ops` diagnostics server (ruling 107)

An in-process, read-only MCP server mounted on **every** controller turn with no
config read and no grant row, so nothing can remove it. Its name `viberr_ops` is in
`RESERVED_MCP_NAMES` and refused at the writer (`saveMcpServer`), skipped by the
picker (`buildResourceCatalog`) and never resolved from the registry
(`resolveSpecialistMcpServersDetailed`). The Controller settings tab shows it as a
pinned, non-interactive chip.

| Tool | What it returns | Gate |
|---|---|---|
| `instance_health` | The same `healthSnapshot` the `/resources/health` route serves (status, degraded subsystems, projections, watchers, lock holder, `backends.<b>.connectedUsers`, browser, disk, maintenance, build), plus `backendCredentials: [{ backend, connectedUsers, askerConnected }]` and the run concurrency snapshot `{cap, lane, live, queued}` (`lane` is the ruling-152(b) coordination lane beyond the cap). Ruling 377(b): an optional `probe: string[]` (≤ 8 bare names) answers `present` + version, or `present: false` + the reason, for any command the fixed `toolchain` struct does not name — the gate binary a project declares and nothing could verify | Open to anyone: nothing here names another person or any deployment configuration; a probe reports presence and version, never a path. The browser executable **path** stays org-admin only (`browserDetail`) |
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
  validator's sentence. From that moment the task's list IS the wait (ruling 155,
  pass 35): every change to it, whoever makes it (the task page, the controller's
  `update_task`, the operator's `set_dependencies`, the release engine), is mirrored
  onto `links[].blockedBy` by `mirrorLinkWait` (`dependencies.server.ts`) with a goal
  timeline line, "Link 1 (Log view) now waits on nothing: KNC-3's list was changed by
  arda@viberr.dev." (the engine signs as "Viberr (release)"), and the goal projection
  is rebuilt so the Goals panel's "waits on" reads the task's list. The mirror is
  convergent and quiet: it writes only while the link is `active` and carried by that
  task, and only when the two lists differ; a retried link is therefore born on the
  wait the record last held, not on the one it was declared with.

### 7.4 Redirecting

`updateGoal` is gated by `requireGoalAuthority`: the creator (project mutable and any
membership) **or** a member holding `run-agents`. Operations (terminal chains refuse
all of them): `rename` (ruling 192, pass 37: the chain's title and/or description, on any
non-terminal chain; neither steers work, and the timeline says what a rename does NOT reach —
link tasks created before it keep the old name in the chain header they were born with, which
is written once and never re-read), `pause`, `resume`, `cancel`, `skip_link`, `retry_link`
(failed links only; a fresh task under the present caller, rebuilt from THAT TASK's own
current title and goal rather than the link's frozen copy — ruling 192: ruling 155 settles an
active link's text while nothing settles the task's, so the two drift, and live they drifted
into disagreeing about which task owns `packages/contracts`; the chain header is rebuilt
rather than stacked and the goal's timeline records the substitution), `edit_link` (pending or failed; ruling
131(c): `blockedBy` absent leaves the link's declared wait, `[]` clears it, any list is
validated at declaration time, this chain's own links included; on an ACTIVE link,
ruling 155, `blockedBy` is the only field that may change and it is forwarded to
`setTaskDependencies` on the link's task after the goal-file lock is released; the
chain's own rules are applied first (never itself, an existing link, never a LATER
link of its own chain, which the task's writer does not know), then the task's writer
validates and gates it and mirrors it back, the reply reading "Link
1 waits on nothing, through KNC-3."; a title or goal on an active link, or an edit
with nothing to forward, is refused with "Only a pending or failed link's title or
goal can be edited; link 1 is active. Its wait follows KNC-3: pass blockedBy here or
edit it on the task."), `add_link` (≤ 20), `remove_pending_link` (re-indexes). Audit
`goal.updated {op}`. A retry that starts NOTHING — `startLinkTask` declines silently when the
chain stopped being active, and the fire-and-forget reconcile the failing task's own archive
triggers lands in exactly that window — re-parks the chain, notes the link and records the
decline instead of leaving the "retried by" entry standing over a link with no task
(ruling 194).
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
  A conversation reply is not a notification: the unseen-reply dot (§3) is its signal.
- SSE: `controller.updated {conversationId, userId}` (owner-routed),
  `controller.log-appended {conversationId, userId, runId, threadId, seq}` (owner-routed,
  one per stored console line of a controller run; a stream event, tailed by the console
  and ignored by `useLiveUpdates`),
  `goal.updated {projectSlug, goalId}` (project-routed).
- Timeline: `comment` events authored by `controller` with the trailer
  `_Posted by the controller for <name>._`.

## 9. Known drift (recorded, not fixed here)

*(2026-09-02: the first two items recorded here on 2026-09-01 — the doctrine's
`list_projects` mention and its "a comment mention can start a run" sentence — were fixed
by ruling 121's doctrine and skill rewrite, shipped through the hash upgrade.)*

*(2026-09-23, pass 39: the notification-kind comments that described a "controller
conversation reply" notification now say what happens, a `controller.updated`
revalidation and no row, so that item is gone from this list.)*

- Ruling 108's note that the panel "skips the P13-KM-01 display-name repair" under a
  lock is stale wording: the panel runs the repair for display and posts blank for
  locked sections; the byte-for-byte outcome holds through the server.
