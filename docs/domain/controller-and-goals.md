# The controller and chained goals

> The instance-level conversational agent: whose authority and account a turn runs on, its
> surfaces (the dock and the two pages), conversation scopes and the per-turn context read, its
> `viberr_controller` toolkit and built-in `viberr_ops` diagnostics server, its deployment locks,
> and the goal chains it defines and the server advances.
> Source of truth: `app/server/controller/*`, `app/server/tasks/goal-actions.server.ts`,
> `app/server/files/goal-writer.server.ts`, `app/schemas/goal-file.schema.ts`,
> `app/server/projections/rebuilder.server.ts` (the goal projection), `app/features/controller/*`,
> `app/routes/controller.tsx`, `app/routes/project.controller.tsx`,
> `app/routes/resources.controller.ts`, `app/routes/resources.controller-unseen.ts`, `app/root.tsx`
> (the dock mount), `app/features/org-settings/controller-admin-panel.tsx`,
> `db/migrations/0001_baseline.sql` (the two controller tables).
> Rulings 99, 100, 106, 107, 108, 121, 127, 373, 390, 398, 411 and 483 in
> [decisions.md](../architecture/decisions.md) set most of what is here.
> Verified against `main` @ `7d9fbf72` (2026-09-23).

## 1. What it is

The controller is one instance-wide agent that every signed-in user can talk to.
It is machinery like the per-task operator but sits above it: it answers questions
about the instance and its projects, performs governed actions **strictly within the
asking user's own permissions**, and defines chained goals that the server then
carries forward. It never replaces the operator; each task a goal creates gets its own
operator through the ordinary create-task path.

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
  instead ("Your Claude sign-in file is missing from this server …"). Another member who
  HAS connected Claude keeps conversing at the same moment: one person's missing
  connection is never an instance outage. Dispatches the toolkit makes
  (`startAgentRun` / `runOperator`) act on a TASK, so they bill that task's owner, not
  the asker.
- Its actor reference in task files is the bare `controller`; it renders as an agent
  named "Controller". `@controller` is a reserved mention handle.

## 2. Surfaces and access

| Surface | Who | Notes |
|---|---|---|
| `/controller` | any signed-in user | Instance scope. `?c=<id>` selects a conversation (`?c=new` starts one); `?all=1` lets an org admin list everyone's. With a thread open, the thread's execution (§2.2). |
| `/projects/:slug/controller` | project members (non-members get the unknown-slug 404) | Board scope: the same conversation machinery bound to the project, plus the **Proposals panel** (§4.3, ruling 483) and the **Goals panel** (§7.5). Third item in the workspace rail (after Board and Review queue). Same execution panels as the instance page. |
| Instance settings → Controller tab | org admins | Configures the controller itself (§6). |
| **The dock**, on every signed-in surface | any signed-in user | Ruling 121: a floating Controller button, bottom-right, opening a non-modal panel bound to the place the person is standing (§2.1). |
| `/resources/controller` | any signed-in user; project and task scopes require membership | The dock's data route: `GET ?project=&task=&c=` answers the scope's view, `POST intent=send` records the message and runs the turn (409 when the asker has no Claude connected). |
| `/resources/controller-unseen` | any signed-in user | The dock's status: the viewer's unseen controller replies in every scope, each with the page that opens it (§3, ruling 448), and the viewer's turns working right now with their scope, phase and step (ruling 457). |

Entry points: the dock (everywhere), the workspace rail item, the Home hero link (once a
project exists), the org-settings tab's "Open the controller", and the goal chip on a
task page (it lands on the task's own link row in its chain, `#goal-N-link-M`, ruling
476(b)). There is no command-palette entry.
The page subscribes to the user SSE scope (and the project scope on the project surface)
and, while a turn is working, reads the turn's console tail every 5 seconds: the fallback
for a settle the stream missed, which revalidates the page once the tail says the run
ended (ruling 457, CTL-2; it used to revalidate root, the workspace layout and the page
every 5 s to move one step line). New conversation sits in the page head;
the rail lists conversations first and goal chains after, is `position: sticky` and scrolls
itself, and below the two-column breakpoint the head carries a native thread picker
(`ConversationPicker`); the transcript is a capped scroller that never moves the page
(ruling 419). A blank transcript offers three example asks per scope that send on click
(`controller-examples.ts`, shared with the dock; ruling 314). A working turn shows the run's
`phase` and last tool `step` on the row that says it is working (ruling 250). Below the
two-column breakpoint the thread picker takes a row of its own in the head, with New and
Home on the row under it (ruling 476(e)). A link in a message wraps inside the transcript
rather than scrolling it sideways (`.md-body a`, ruling 476(a)). Where the transcript puts
its reader is one rule for the page and the dock (`useTranscriptFollow`,
`transcript-follow.ts`, ruling 476(c)): an opened thread shows its newest reply from the
first line when a reply is the newest message, and its end otherwise; a controller message
that lands is scrolled to its first line, unless the reader has scrolled up above the
newest reply they had, and then nothing moves; the person's own message, and a turn that
starts while they follow the thread, go to the end. One visually hidden `role="status"`
region, mounted outside the per-thread subtree and changing only its text, says "<name> is
working" when a turn starts and "<name> replied: <first sentence>" when the reply lands
(`useTurnAnnouncement`, ruling 476(d)); the working row is visual only. The transcript
is in REPLY order (ruling 465, `inReplyOrder` in `app/shared/controller-thread.ts`): each
controller row that names the message it answers sits directly under it, and user messages
and unlinked notes keep their `seq` order. A user message with no reply yet says where it
stands, from the lease the server holds (`turn.answering`, `turn.queued`): "answering now"
on the message the live turn took, "queued · N ahead" on one waiting behind it (N counts the
turns before its own, the answering one included); after a restart its reply is the restart
note. "… is working" sits under the answered message and any reply already posted to it,
never under a later message. The composer is
disabled when the VIEWER has no Claude connected (ruling 127) or when they do not own the
active conversation; the two states render different sentences, because only the first one
is theirs to fix. People are named by display name at render time (`userDisplayName`); the
stored `user_label` is the owner's email.

Conversations belong to the asking user. `canAccessConversation` allows the owner and
a **live-resolved** org admin; project members do not read each other's transcripts;
a non-owner gets a 404-shaped refusal so "not yours" and "never existed" look the same.
Only the owner may send. Org admins reading project-scoped transcripts for projects
they are not members of is intended (ruling 100). Deleting a project releases its
conversations to instance scope with a message naming the deleted project, rather than
leaving them bound to a slug a new project could reuse (ruling 274).

### 2.1 The dock (ruling 121)

`controller-dock.tsx`, mounted once in `root.tsx` whenever the root payload carries a
csrf token (the signed-in signal). Its scope follows the matched routes
(`controller-dock-context.ts`, pure and tested): a task page anchors it to that task,
any workspace view binds it to that board, everything else is instance scope; on
`/controller`, `/projects/:slug/controller`, `/login`, `/profile` and `/notifications`
(`DOCK_HIDDEN_ROUTE_IDS`) it renders nothing — the last two render their whole page inside
a `showModal()` overlay, which would leave the dock inert behind it.

- **Trigger**: a 44 px circular button (`.dock-fab`), 20 px from the bottom-right corner,
  named `Controller · <scope>` (`Instance`, `<project name>`, `<KEY> · <project name>`) —
  the name comes from the workspace loader, so it reads the same before the first open and
  after it, `aria-haspopup="dialog"` / `aria-expanded`. It wears the pulsing `.live-dot`
  while a turn of the viewer's is working in the dock's scope, open or closed and from the
  first page load, read from the dock's status (ruling 457; the dock polls it every 5 s
  until the turn settles), and a still blue dot plus "a new reply" in its name when any
  conversation of the viewer's holds a reply they have not seen (ruling 448).
- **Panel**: `role="dialog" aria-modal="false"`, `data-screen-label="Controller dock"`,
  400 × min(640, 100dvh − 96) px docked above the trigger; no scrim, no focus trap, no
  body scroll lock (the page stays usable). Header: the controller's name, the scope
  pill, Threads (this scope's threads, count in the name, unread ones marked), New, Open
  page (the full surface with `?c=`), Close. One context line names what the controller
  knows here; a status line says where an unseen reply is, and the panel links to replies
  from other scopes and opens one of its own scope in place. Everything below the header
  (`controller-dock-panel.tsx`: the context line, the transcript through the markdown
  pipeline, the thread list and the composer) loads on demand, so root ships only the
  button, the frame, the header and the dock's state to every page (ruling 457); the
  button preloads it when a pointer or focus reaches it, and until it lands the frame
  shows the same "Reading where you are…" and "Loading…" the body shows before its view
  arrives. The shared not-connected note lives in `not-connected.tsx` for the same
  reason. The transcript reuses the
  page's message vocabulary, reply order and queue states (ruling 465; `MessageState` in
  `turn-step.tsx`) and the composer takes focus on open (the send hint names the
  viewer's own modifier and drops on a coarse pointer) — on a user-initiated open only, so
  a remembered-open reload never starts focus inside the textarea. Escape closes and
  returns focus to the trigger **while focus is inside the panel**. An Escape pressed on a
  page control the panel covers also closes it and leaves focus on that control (with no
  focus trap, Tab reaches controls under the panel; ruling 455(d)). Any other Escape (the
  palette, a confirm dialog, a stage menu or its trigger, focus on nothing) leaves the dock
  alone, and an outside press never closes it. An empty thread offers the scope's three examples, which send on click.
  The transcript meets a reply as the page's does (ruling 476(c) and (d), below in §2): it
  opens on the newest reply's first line and scrolls a reply that lands to its first line,
  and the panel's own visually hidden `role="status"` region says "<name> replied: <first
  sentence>" for the thread on screen, which the button's announcer leaves out while the
  panel is open. The "is working…" row is visual only; the button's announcer says a turn
  is working.
- **Phone sheet** (≤ 720 px, rulings 121(e) and 454): the panel is a bottom sheet a finger
  pulls down to dismiss. The grabber and the header are its handles, and their buttons keep
  their taps. After a 10px slop it follows 1:1, and it rubber-bands above its resting place.
  Momentum projection decides between dismissing and coming back, and the settle is a spring
  that keeps the finger's speed (`useSheetDrag`, `ui/use-sheet-drag.ts`). A sheet grabbed
  while it moves, its entrance included, is caught where it is. The perched trigger rides
  the pull, and Close stays the named way out.
- **Availability is the VIEWER's** (ruling 127): the dock's `available` is
  `isBackendAvailableFor(db, viewer, "claude")`, in the normal view and in the
  `unavailable` refusal view alike, so a person with no Claude connected reads the
  same sentence the full page's composer and the refused turn's transcript line
  carry.
- **Continuity**: the dock opens on the newest thread of the current scope; the selected
  thread per scope and the open/closed state survive a reload for the life of the tab
  (`sessionStorage`, wrapped, absent in SSR). Navigating swaps the scope and keeps the
  panel open; a working turn keeps working.
- **Live** (ruling 457): the dock has two resources, the open panel's view
  (`/resources/controller`) and the status every page's button reads
  (`/resources/controller-unseen`: unseen replies and the viewer's live turns). Both are
  root-owned fetchers whose routes answer `shouldRevalidate` false
  (`dockResourceShouldRevalidate`), so no navigation, action or page revalidation reloads
  them; the dock loads them itself. The view loads while the panel is open: on opening,
  on a new scope or selection, once after a send (which passes
  `defaultShouldRevalidate: false`, so the page under the dock is not reloaded either),
  and on a `controller.updated`. The status loads when the dock mounts (the first page,
  and every return from a page it stays off, where the controller page may have marked a
  reply read), when the panel opens or closes and after it shows a transcript, and on a
  `controller.updated`. Any surface streaming the `user` scope hands that event to the
  dock, debounced 300 ms, as the window event `CONTROLLER_UPDATED_EVENT` instead of
  revalidating its own loaders (only the two controller pages, which render the
  conversation, revalidate on it); a reconnect replays a missed one (ruling 457), and a
  `stream.resync` hands it one too.
  While a turn works the dock polls the STATUS every 5 s, open or closed: the working dot
  and the open panel's step line move from it, and the view reloads only when the status
  and the view disagree about whether the shown turn works. Before this, a closed dock
  that had been opened once reloaded its last transcript with `seen=1` on every
  revalidation of every page, which read a reply while the panel was closed and kept the
  dot from lighting (ruling 448 lets only the open dock mark a transcript). While open,
  the dock mounts its own `user` stream only on the surfaces that have none —
  `/insights` alone (`DOCK_SELF_STREAM_ROUTE_IDS`, pinned by a test against the
  modules that really call the hook); everywhere else a second socket would only
  duplicate the events.
- **Never the root error page**: the view's route answers a benign empty view for a
  scope the person cannot reach and falls back to this scope's newest thread for a
  selection it cannot honour (reporting `staleSelection`, which the dock uses to forget
  the stored id). A thrown response from a root-owned fetcher would replace the whole
  page, which is the hazard ruling 121(f) named for CSRF. The unavailable view names
  nothing but what was typed (F35-4): `projectName` is null, the label reads "Not
  available here", and the projection is never read for it, so a non-member cannot learn
  a project's display name from a guessed slug.
- **The send door says no where the composer does** (U35-4): `POST intent=send` for a
  person with no Claude connected answers `409 { ok:false, error }` with the refusal
  sentence and creates no thread for a new conversation; a refused turn on an existing
  thread answers 409 too, with the note already in the transcript. Both page routes
  (`/controller`, `/projects/:slug/controller`) answer the same 409.
- **Motion**: the panel grows from its trigger (`transform-origin: bottom right`,
  .18s `--ease-out` in, .12s out on a pointer close, instant on Escape). In and out are
  one transition (the entrance starts from `@starting-style`, the close's target is
  `[data-closing]`), so a click on the trigger while the panel leaves takes the close
  back: the panel turns around from wherever it has got to, and focus goes in as on any
  open the person asked for (ruling 459, F20). A panel the per-tab memory reopens (a
  reload, or a return from a page the dock is hidden on) was already open, so it appears
  in place with no entrance (`data-restored`, F24); its later close still animates. A
  reply that arrives while the panel is open lands with a .2s fade-and-rise (history
  never animates: the component marks only messages it had not seen in the same
  conversation); under the OS reduced-motion setting (ruling 148(c): the one signal)
  the panel fades only, .12s both ways at every width.
- **Small screens** (≤ 720 px): a full-width bottom sheet, `min(80dvh, 640px)` tall,
  rising along the bottom edge over .22s and leaving over .15s; the trigger stays on
  screen above the sheet (R19-12), smaller, as a second close, and travels to that perch
  on the sheet's clock. A restored sheet's trigger is simply there.
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
  **Interrupt**. The phase, step, turns and tokens follow the console's tail reads (each
  line, and the 5-second status read), and the loader on the `controller.updated`
  reference a lifecycle flip publishes (the sink routes a controller run's state
  changes there instead of the task-scoped `run.state-changed`). The transcript's working
  row reads the same step (ruling 250).
- **Interrupt** is offered to the conversation's owner and to org admins
  (`canInterruptTurn`); it confirms first (D6, "Interrupt this turn?" / "Interrupt
  turn") and posts `intent=interrupt` with the conversation and the run id. The engine's
  `interruptRun` gates a controller run on `canInterruptControllerRun` (owner or live org
  admin, the same two people who may read its log; a stranger gets the 404 shape) instead
  of the project membership the run has none of, then settles the turn: the transcript
  records "This turn was stopped before I could answer." and the lease is released, so
  the next message starts a fresh turn. A turn stopped while still queued (no adapter to
  exit) is settled the same way, because the engine fires the run's completion callback
  from its no-live-handle arm.
- **Agent logs** (below the composer): the grouped console with the `{ } raw` and follow
  toggles, the session-id chip and the backward paging of `/resources/run-log`, behind
  the owner-or-admin gate that serves the raw view. Live tailing is the controller channel
  of `useRunLogStream`: the sink publishes `controller.log-appended {conversationId,
  userId, runId, threadId, seq}` to the OWNER's `user` stream for every stored line
  (`controllerRunRoute` resolves the owner once per run), the console fetches the lines
  since its cursor, and the frame is a stream event that revalidates nothing
  (`SSE_STREAM_EVENTS`; `useLiveUpdates` hands it to the console, ruling 457), so one
  turn's tool calls never revalidate every surface the person has open. A supervising org
  admin reading someone else's thread sees the same console off the 5-second tail read;
  the frames are the owner's. The streaming footer says
  "never in the transcript" here, where the task record does not exist; the console
  speaks no engagement vocabulary for a controller run (no "supporting" role, and a
  finished turn's footer says to send a message).
- Neither panel renders for a thread that has not run yet.

## 3. Conversations and turns

Storage is app-owned SQLite, the same family as notifications and sessions:
`controller_conversations(id, user_id, user_label, project_slug, task_key, title,
created_at, updated_at, last_message_at, seen_seq)` with `CHECK (task_key IS NULL OR
project_slug IS NOT NULL)` and `controller_messages(id, conversation_id, seq, author
user|controller, user_id, text, run_id, surface, created_at, reply_to, unlinked_history)`
with `UNIQUE (conversation_id, seq)` and `ON DELETE CASCADE` to the conversation. `reply_to`
(ruling 465) is, on a controller row, the user message it answers: a turn's reply (posted
early or by the settle), every refusal (no Claude, a full queue, a turn that could not
start), both start failures and each message they dropped, and the restart notes all set
it; only a released project's note answers nothing. A user message takes its `seq` when it
is recorded, which for a message sent mid-turn is when it is QUEUED, so `seq` alone cannot
pair a reply with its message. An older data root gains both columns in one healer pass,
and `backfillControllerReplyLinks` replays the writers' order, linking only what that order
proves: it resets at every event that empties the real queue (a start failure, a restart,
a boot another conversation's restart note dates) and never guesses past a message lost
without a row. A user message it cannot link (lost to a restart or a failed start, or
waiting while the walk was out of step) gets `unlinked_history = 1`: earlier history, not
linked, which boot recovery does not note. A root whose `reply_to` the first version of the
backfill already linked is walked again when it gains `unlinked_history` (ruling 465's
dated note of 2026-09-25).

A conversation's **scope** (ruling 121) is fixed at creation: instance (`project_slug`
and `task_key` null), board (slug alone) or task (slug + key). `listConversations`
filters on both (`taskKey` undefined = any binding under the slug, null = the board's own
threads, a key = that task's); `createConversation` refuses a task without a project.
`surface` is the in-app path (pathname + query, normalized to 400 characters, no control
characters) a USER message was sent from; controller rows carry null. The title
(`deriveTitle`) is the first user message's first sentence when that sentence is 20 to
80 characters long, else the whole message when it fits in 80, else the message clipped
at a word with an ellipsis. Every appended message publishes the owner-routed SSE event
`controller.updated`.

**A reply the owner has not seen (ruling 448).** `seen_seq` is the highest message `seq`
its owner has looked at (added to older data roots with a backfill that marks every
existing thread read). The two surfaces that show a transcript, the controller page and
the open dock, set it when its owner is the one looking (`markConversationSeen`:
monotonic, publishes nothing, so a revalidation can run it again). A controller message
above it is unseen (`listUnseenReplies`). The dock's button carries a dot and says "a new
reply" on every page. `/resources/controller-unseen` lists the viewer's unseen replies in
any scope, with the page that opens each, and leaves out any thread in a project the
viewer can no longer open. The open panel links to replies from other places and marks
unread threads here, and the page's rail and phone picker mark them too. None of this is
a notification row: replies stay out of the bell (§8).

**One user message is one run** (`runControllerTurn` in `controller-run.server.ts`):

1. The user message is recorded first (with its surface and the reader's time zone).
2. If Claude is unavailable, a refusal is written into the transcript and the turn
   returns `{ state: "refused", reason }`; every send door answers that as a 409, and
   the dock's door refuses before creating a new thread.
3. Single-flight per conversation with a FIFO capped at 8 queued messages
   (`MAX_QUEUED_MESSAGES`); overflow is refused in-transcript. The lease records the
   message the current turn answers, and `conversationTurnState` exposes it and the queued
   ids with their positions (`answering`, `queued: [{ messageId, ahead }]`) on both views,
   so the transcript names the queue from the server's side (ruling 465); joining the queue
   publishes `controller.updated`.
4. The run row is `agent_runs.kind = 'controller'`, `project_slug = ''`,
   `task_key = <conversation id>`, so no task-scoped query ever matches it. Model is
   the profile's through `resolveRunModel("claude", …)`, re-read every turn (a resume
   passes it too); effort only when set. The newest prior controller run is resumed when
   it has a session id, otherwise a fresh run starts — unless that session is BOTH idle
   past its cache TTL (60 min on a sign-in, 5 min on an API key) AND above 150k tokens
   (`RESUME_FRESH_CONTEXT_TOKENS`), in which case ruling 372 starts a fresh run instead of
   replaying it: the prior run gets a `run·session_stale` line, the fresh turn's prompt
   says the session was set aside on purpose and points at the digest below, and the
   run's start audit records `continuityReset: "stale_large_session"`.

   The turn prompt is, in order: the **context read**, a line naming the model this turn
   runs on (ruling 444: the model is named here, never in the recorded system prompt), a
   digest of the conversation UP TO the message this turn answers (`messagesUpTo`, in reply
   order: every user message up to and including it, every reply to one of those, every
   unlinked note written before it; the newest 30 of those, `CONTEXT_MESSAGES`, 24 000
   chars, each message cut at 600), then, when messages wait behind it, one line: "N more
   messages from <person> are queued behind this one; each is answered in its own turn, in
   order — do not treat them as lost" (ruling 465, F40-10: a queued message used to reach
   the running turn as a 600-character stub, which the model reported lost), then
   `<user label> says:` and the message.

   The **context read** (ruling 121, `gatherControllerContext` in
   `controller-context.server.ts`) is a block labelled as a server read taken when the
   turn started:
   - for a task-anchored conversation, a derived header (stage and its position, readiness,
     waiting, validation, owner, priority, due date, labels, next stages with their
     boundaries, the asking person's live project role as `your authority: …`
     (ruling 309), engaged agents, branch and PR, open packet, goal chain link, and what
     the task waits on with each entry's state) plus the canonical `task.md` verbatim inside
     a fence, bounded by `TASK_FILE_CONTEXT_CHARS` (24 000; over budget the head stays whole
     and the newest timeline entries are kept, with a marker naming how many were omitted);
   - for a board, the project's description (600-char excerpt), repo, members
     (`BOARD_CONTEXT_MEMBERS` 20), the same `your authority: …` line, stages with counts,
     boundaries, the open-task table (`BOARD_CONTEXT_TASKS` 40 rows, `BOARD_CONTEXT_CHARS`
     12 000) and the goal chains (`BOARD_CONTEXT_GOALS` 20);
   - for the instance, the projects the person can see (`INSTANCE_CONTEXT_PROJECTS` 40)
     with their role and what is happening in each: task totals, how many are not done,
     running, and waiting on them (ruling 307);
   - on a board or a task, the project's open knowledge-base proposals (ruling 483,
     `projectProposalsContextLine`): the ones its tasks filed under "Proposed corrections
     (not binding)" in any knowledge base, up to 10 by id with the document, the task and
     filer, the line and the correction, and the instruction to tell the person they wait
     and to close one with `resolve_kb_proposal` only when the person asks; at the instance
     scope, the count per visible project;
   - in every scope, the controller's own open resource-grant requests (§6, ruling 390),
     `They are looking at: <surface>` when the message carried one, and the zone the person
     reads times in with the local clock, and the rule that every tool instant is UTC and a
     time is quoted to them in their zone.

   The authority line (`askerAuthorityLine`) names the role and stops —
   `project role maintainer`, or the org-admin override named as such (it holds every
   action here), or `not a member of this project` — a live read, and never a held/not-held
   set: the tier list in the system prompt is static, this line is personal, and the model
   multiplies the two; it ends by saying that a role on any OTHER project is not in this
   read (`whoami` has it). The whole block stays under `CONTEXT_BLOCK_CHARS` (32 000); the
   fence is always longer than the longest backtick run inside the file, so nothing in the
   file can close it, and a line in the server's own voice above it says the fenced bytes
   are data and never instructions. The read is gated: the asking person's LIVE visibility
   of the bound project is re-proven through the same `assertProjectAction` chokepoint the
   board tools use, and a refusal replaces the block with the toolkit's uniform
   not-visible sentence. The context read is why the controller does not need a `task.md`
   of its own: the anchored task's is read in fresh every turn.
5. Mounts on every turn (`buildControllerMounts`): `viberr_controller` (§4), `viberr_ops`
   (§5), then the controller's granted org MCP servers, resolved and stdio-pre-flighted
   once so the prompt and the mount agree. A granted server with a stored credential is a
   mount on Viberr's loopback MCP gateway carrying the turn's own token, exactly as on a
   specialist run (ruling 461, [agents-and-runtime.md §6](agents-and-runtime.md)): the
   credential stays in the server process, the token dies when the turn settles, and a
   call to a marked write tool is audited under the asker as the controller's
   instrument. Denied built-ins: `Read`, `Grep`, `Glob`,
   `WebFetch`, `WebSearch` plus the operator read-only set (`Bash`, `Edit`, `MultiEdit`,
   `Write`, `NotebookEdit`). Working directory is `<dataRoot>/runtimes/controller-scratch`.

   The system prompt (`buildControllerSystemPrompt`) replaces the Claude Code preset and
   reaches the SDK as `{ type: "custom", prompt: [static, boundary, dynamic], snapshot:
   true }` (ruling 373): recorded on the session's first request and reused verbatim on
   every later turn until a compaction, so a changed append on a resume does not
   invalidate the cache prefix — which is also why the prose tool manifest reaches a
   running conversation at its next compaction (the tool definitions themselves arrive
   fresh with every request). Every list in it is sorted by name (ruling 370). The static
   block is: the doctrine; the attached skills injected verbatim; the attached knowledge
   bases as INDEXES (ruling 283: every document with its size and sections, read on demand
   with `read_knowledge_doc`), which on a project-scoped conversation include the
   project's rulings knowledge base (ruling 239, with the rulings note when it resolved);
   a runtime block (the model is named in each turn's message; the mounted org MCP
   servers; `viberr_ops` always attached; no filesystem or shell); the gateway sentence
   naming the servers reached through Viberr's MCP gateway (ruling 461); the ruling-namespace
   paragraph (ruling 312: a ruling number inside a tool description is Viberr's own
   product decision, while a project's rules live in its knowledge base, number from 1,
   and are cited by document and section); the per-turn tool manifest generated from both
   in-process servers' registries (ruling 297); and the measured shell inventory
   (ruling 191). The dynamic tail behind the SDK's boundary is: the granted MCP servers
   that did NOT mount this turn, each with the reason its own probe gave and the
   instruction not to infer a cause the server did not give (ruling 310), and the
   conversation block — the asker, their live org role, the binding (and for a task
   anchor, "tools default to both, and every turn opens with the task's canonical file as
   a server read"), the rule that only this person's own messages authorize actions —
   followed by the project-authority tier list (ruling 309): generated from
   `RBAC_DEFINITIONS` by `projectAuthorityPrompt`, each tier naming the actions it is the
   floor for (a grant that gates more than its name says carries its `covers` scope),
   then the hand-written exceptions marked as hand-written, and the rule that the list is
   ADVISORY, NEVER ENFORCING — predict a refusal, say why, make the call anyway, and let the
   server's answer be the answer.

   The run carries no mid-run context window (ruling 376): a turn that leaves the
   conversation above 100k tokens (`COMPACT_AT_COMPLETION_TOKENS`) is compacted at its
   end, while the cache is warm, and the settle waits for that compaction before the next
   queued turn resumes the session; the reply is posted to the transcript as soon as it
   is written, before the compaction (U39-30). A `SessionStart` hook on the `compact`
   source hands the conversation anchor back (`controllerCompactAnchor`: the conversation
   id, the person, the scope, that every turn's server read outranks the summary, that
   `viberr_ops` is still attached, and to ask rather than guess when the last request
   depends on lost context). The controller's tools stay deferred behind ToolSearch
   (deferred tools only append and keep the cache).
6. `settleTurn` records the reply (or a failure note naming quota/auth/other) under the
   message it answers, releases the lease and starts the next queued message. When that
   start fails, the note goes under the message it tried and every message dropped behind
   it gets its own note (ruling 465). A FIRST turn whose start fails does the same for any
   message another surface queued while the start awaited.

Everything the run machinery gives every other run applies: raw NDJSON transcript,
line redaction, token accounting, the run's input disclosure (`recordRunInputs`, on the
fresh path and every resume; ruling 344), the run-log console (owner or org admin, via
`canReadControllerRunLog`, the same gate `/resources/run-log` and the session export
apply; rendered on the controller pages, §2.2), the interrupt (`canInterruptControllerRun`,
§2.2) and boot orphan finalization. Boot also writes an honest "interrupted by a server
restart" note under every user message no reply answers in a conversation no live turn
holds and the backfill did not mark earlier history (`recoverControllerConversations`,
ruling 465): the turn whose run died (its note
carries the run id, which settles that run, and answers the oldest waiting message), a
message whose run never started, and the messages the lost in-memory queue still held. The task-scoped run stream cannot carry a controller
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
- Every tool refuses an argument it does not declare (`strictTool`, ruling 296).

**55 tools**: 54 registered on every turn (`grep -c "^  add(" controller-toolkit.server.ts`
counts them) plus `read_knowledge_doc`, registered (indented, inside a condition) only when
the turn holds at least one knowledge base, which is every turn while the controller keeps
its `controller-handbook` grant. `projectSlug` defaults to the bound project and, on a
task-anchored conversation, every task tool's `taskKey` defaults to the anchored task —
**only within the anchor's own project**: a call that names a different `projectSlug` must
name its task, or it is refused (the same rule scopes `list_decisions`, ruling 256).
`whoami` reports both bindings.

**Instance reads**

| Tool | What it does | Gate |
|---|---|---|
| `whoami` | The asker's org role, visible projects with their project role, and this conversation's bindings | signed-in |
| `list_capabilities` | The capability catalogue per kind: settable ids with labels, the modes each kind takes, the always-human ids, and `whenUngranted` (§4.2) | signed-in |
| `list_users` | Every user: id, email, name, org role, status | org admin |
| `list_knowledge_bases` | Org KBs led by `grantKey` (the store directory), with id, name, refresh mode, file count and the document names | org admin |
| `read_knowledge_base_doc` | One document of any KB by id, with the `version` a replace must name (ruling 305) | org admin |
| `read_knowledge_doc` | One document of a KB granted to THIS turn, by the name and path its index gives (ruling 283) | the turn's own grants |
| `list_skills` | Org skills led by `grantKey` (the folder name), with name and summary | org admin |
| `list_mcp_servers` | Org MCP connections led by `grantKey` (the registry name): transport, target, the cached `up` verdict with `lastCheckedAt` / `warmingSince`, ruling 176's `writeTools` and `writeToolsReviewed` and what the marking does, and `storeAccessNote` for a command pointed inside Viberr's own store (ruling 278); `signIn` (an HTTP server's OAuth sign-in: null, or `needs_sign_in`, `signed_in` with `expiresAt` and `renews`, or `expired` with its reason) and `signInNote`, which says what it means for runs and that only an org admin signs a server in or out, in Instance settings (ruling 469); never credentials or tokens | org admin |
| `list_global_agents` | Global templates with full persona, grants (`skills` / `mcps` / `kbs`), default model and effort, `copiesDiffering` (ruling 156) and `copiesWithOlderText` (ruling 277) | org admin |
| `inspect_audit_log` | Audit rows filtered by project, action PREFIX, actor and time range (limit 1..200); every reply carries the `actions` vocabulary with counts, and an empty match lists the ids the window does contain (ruling 279); rows are retained 90 days | org admin |
| `inspect_run_analytics` | Run totals, success rate, cost and tokens, oversight, and breakdowns by backend, kind, project, model, profile and task, each a window carrying `hidden` / `hiddenRuns` / `hiddenCost`; an unreported cost is `null`, never zero (ruling 308) | org admin |

**Instance writes**

| Tool | What it does | Gate |
|---|---|---|
| `create_user` | A local account; relays the one-time temporary password | org admin |
| `update_user` | Name, email, org role, enable/disable, or a password reset (a new one-time password); deletes nothing | org admin |
| `set_user_org_role` | Admin or member; the last active admin cannot be demoted | org admin |
| `request_resource_grant` | Records an ask for a skill, KB or MCP server on the controller's OWN profile in `agents/controller-requests.md`; idempotent per (kind, name) while open; a name no resource carries is refused (§6, ruling 390) | org admin |
| `save_knowledge_base` | Create or update a KB (name, refresh mode) and optionally write one document (§4.1) | org admin |
| `resolve_kb_proposal` | Close one open knowledge-base proposal by id (§4.3, ruling 483): `promote` writes `text` into the document's settled text in place of `replaces` (which must stand there once, outside the proposals section) or appended to it, and removes the entry; `dismiss` removes the entry only; audited `org.kb.proposal_promoted` / `org.kb.proposal_dismissed` with the `reason` | org admin |
| `save_skill` | Create or update a skill (name, summary, SKILL.md body) (§4.1) | org admin |
| `save_mcp_server` | Create or update a connection; takes no credential; reserved names refused; `writeTools` marks the tools withheld from runs without repo-write and from every operator run (ruling 176), and a save with none set names the tools that look like writes. Its description says an HTTP server that asks for an OAuth sign-in is signed in by an org admin in Instance settings, which the controller cannot do, and a save that meets the sign-in challenge says so instead of "add a secret" (ruling 469) | org admin |
| `test_mcp_server` | Probe one connection now and report its health in the command's words; an OAuth server reads "needs sign-in", "healthy … signed in (expires in …, renews itself)" or "sign-in expired: an admin must sign in again" (ruling 469) | org admin |
| `save_global_agent` | Create or update a specialist template: backend, summary, persona, stages, default model and effort, grants (§4.1, §4.2); `propagate: true` rewrites differing project copies' grants (ruling 156) and, on a call that changes the persona, the persona of every copy still running older text (ruling 467) | org admin |

**Project creation**

| Tool | What it does | Gate |
|---|---|---|
| `list_github_connections` | Every GitHub connection: `owner`, `default`, token kind, validation (`valid` / `failed` with the validator's reason / `unvalidated`) and `lastValidatedAt`, expiry, `missingScopes`, bound project count, and `reach`: the repositories the TOKEN reaches, each with `private` and `canPush`, read when the token was last validated (`read` with a summary and counts, `unknown` with GitHub's reason, or `not_read` for a connection saved before the read existed). No token material, not even the masked suffix (ruling 463) | signed-in |
| `create_project` | A project with any shape in one request (stages, boundaries, members, description); needs a GitHub connection for the repo owner, and its description sends the model to `list_github_connections` first (ruling 463); the asker is seeded project admin (FR5). `createRepository` (`{ private, description? }`, ruling 462) creates the repository on GitHub with the connection's token when the probe finds none, before the project is written: a refusal names what the token lacks and writes nothing, an existing repository is used as it is, and the reply says which happened. Audit `project.repository.created`. `agents` (`[{ profileId, model?, effort? }]`, ruling 464) writes the operator plus exactly that roster and no base Developer or Reviewer, each entry the deployment `deploy_agent` would write; `operator` (`{ model?, effort? }`) sets the operator's own. Every entry is judged before anything is written, GitHub included: an unknown or non-specialist template, a model or effort its backend does not offer, a duplicate or an empty list is refused by name. Without `agents` the base roster is written, as from the New project dialog. The reply lists every deployment written with its model and effort, and `project.created` records the roster's ids | signed-in |

**Board reads** (all `requireVisible`, archived projects included)

| Tool | What it does |
|---|---|
| `get_project` | Stages with task counts, workflow, members, deployed agents with their RESOLVED grants, board-resolved eligible `stages` beside `declaredStages` (ruling 188), model, effort, operator autonomy, `resources` and `templateDrift`; `advisory` marks a matrix-only grant (ruling 377(a)); `requiredReviewers` (ruling 178), goals summary, `rulingsKb` (ruling 239), `openProposals` (ruling 483, §4.3), resolved `fileLeases` and `spentFileLeases` (rulings 245, 247), `gates` (ruling 482) |
| `list_tasks` | Key, title, stage, readiness, waiting, owner, priority, goal-chain chip and `waitsOn`; Done included, archived only with `includeArchived` |
| `get_task` | Live state (stage, readiness, goal, engaged agents, PR, open packet), `notAcceptableReason` (the acceptance gate's own verdict, ruling 188), `gates` (ruling 482: the PR card's line, the state, each gate's outcome, time and log, or null), pending `schedules` (ruling 153), `timelineTotal`, and the newest events (default 12, max 50), each cut at 700 characters |
| `read_timeline_entry` | One timeline entry in full, by the `at` stamp `get_task` prints (ruling 285) |
| `read_task_attachment` | One text attachment of a task (`.txt .log .md .json .yml .yaml .csv .diff .patch`; ruling 293) |
| `read_default_branch_file` | One file as the project's default branch has it, from the project's git mirror (built on first use), in pages of whole lines via `fromLine` (rulings 299, 436); an absent path is reported absent; audited `controller.repo.read` |
| `get_github_state` | Connection and credential health, task branches with sync state, PRs with checks, review and mergeability (the three meanings of a null `checks` spelled out), cache freshness |
| `read_pull_request` | A task's review PR: every changed file with status, counts and unified-diff hunks; `patches: false` for the file list, `path` for one file, a byte budget with `patchOmitted` flags (ruling 266); audited `controller.github.read` |
| `list_decisions` | Everything waiting on a person: open packets with every option and the `ownWords` free-text choice (ruling 271), pending recommendations, completions ready to accept, each with `releases.direct` / `releases.downstream` (ruling 336); answers nothing (ruling 251) |
| `list_goals` | The project's chains with status, current link and per-link status, task and `blockedBy` |
| `get_goal` | One chain in full with its history; a link's `goal` is the contract in force and `declaredGoal` the superseded declaration (ruling 335, §7.5) |

**Board writes** (`requireVisible`, then the same `requireAction` / `assertProjectAction`
matrix the human surfaces use; the tier in brackets is the floor)

| Tool | What it does |
|---|---|
| `create_task` | A task at the entry stage [contributor, `create-task`]; takes `blockedBy` (validated before a key is allocated; the task is born held), `owner` (a member email or `me`, seated in the creating write before the first operator run; ruling 140(a)), `dueDate`, and `priority: urgent` as the urgent flag |
| `move_task` | A stage move [`approve-transition`]; a move into the terminal stage is refused and pointed at the task page; a move to an EARLIER stage requires `reason`, which lands on the transition entry (ruling 381) |
| `comment_on_task` | A comment signed `_Posted by the controller for <name>._` [member; refused on an archived project]; @mentions of people notify; an @mention of an agent starts nothing and the line is stamped saying so (ruling 252) |
| `set_task_owner` | Seat the asker, another member, or release [`own-task`; takeover needs the acceptance tier]; the person whose seat changed is notified (ruling 140(b)) |
| `update_task` | The goal and the `title` [`update-goal`, maintainer; ruling 295], priority / labels / due date as a full replace [`edit-task-meta`], and `blockedBy` as the FULL list through `setTaskDependencies` (`[]` clears it and releases the task; ruling 131); each part reported on its own arm, an unchanged axis answers `[noop]` |
| `run_agent_on_task` | Start the operator (`runOperator({trigger: "manual"})`, relaying `open-packet` / `closed` / queued honestly) or a deployed profile (`startAgentRun`) with a directive, also written on the timeline [`run-agents`, maintainer] |
| `schedule_task_action` | A future operator re-run or profile run, 1 minute to 28 days out (`delayMinutes` 1..40320 or an ISO `dueAt`), written on `task.md` with the `<email> · via controller` label [`run-agents`; ruling 153] |
| `cancel_task_schedule` | Cancel one pending entry; `[noop]` when it is not pending [`run-agents`] |
| `update_project_settings` | Name, task-key prefix, description [`edit-policy`] |
| `set_required_reviewers` | The WHOLE required-reviewer list per non-terminal stage, `[]` clearing it; every profile must be deployed and hold `report-validation-verdict`; an unchanged list answers `[noop]`; audited `project.required_reviewers.updated` [`edit-policy`; ruling 178] |
| `set_project_rulings_kb` | Name the project's rulings KB by store directory, or `null` to clear; that KB is injected into every run the project makes [`edit-policy`; ruling 239] |
| `set_file_leases` | Replace the project's file-lease list (path globs a task owns until it merges); overlapping leases held by different unfinished tasks are refused [`edit-policy`; rulings 245, 353, 417] |
| `set_project_gates` | Replace the project's gates, the commands Viberr itself runs on every delivered revision (`{name, command, timeoutSeconds?}`, at most 10, run with `sh -c` in order, 600 s by default), `[]` clearing them; a duplicate or empty name, an empty command or a timeout outside 1..3600 is refused by name with nothing written; an unchanged list answers `[noop]`; a changed one queues the gates on every open task with a delivered revision; audited `project.gates.updated`. Its description sends a MEASURED gate set here instead of into the rulings KB as prose [`edit-policy`; ruling 482] |
| `update_stages` | Add (before the final stage), rename, recolor (one of the twenty presets), remove or reorder; removing a stage never loosens a boundary [`edit-policy`] |
| `set_transition_boundary` | `auto`, `approval` or `human` for one move; the move into the final stage stays human [`edit-policy`] |
| `invite_member` | Add a member by email (an unknown email gets an account and a relayed one-time password), seated in the given `role` in one write (default viewer; an unknown role refused by name) [`manage-members`] |
| `set_member_role` | Change a member's role; the last project admin cannot be demoted [`manage-members`] |
| `deploy_agent` | Deploy a global template; `model` / `effort` overrides checked before the write; the reply says whether the copy can write the repo; its description names `remove_agent_deployment` as the way back [`manage-agents`] |
| `remove_agent_deployment` | Take a specialist's deployment off the project (ruling 464): `deleteAgentProfile`, the Agents page's Delete, under its gate and its audit row `project.agent_profile.deleted`, with the required `reason` in the details. Refuses the Operator by name and a profile that is the delivering or an engaged agent on an open task (not archived, not in the final stage), naming the tasks; the global template is untouched; a project left with no specialist is told the base Developer and Reviewer come back at the next restart [`manage-agents`] |
| `update_agent_deployment` | A deployment's capability modes, backend, model, effort, stages, operator autonomy, its own `skills` / `mcps` / `kbs` for every kind, the operator included (G36-1), and its `persona` (ruling 467: the whole text, an empty one refused, the reply naming the length before and after and the first and last changed lines); merge semantics; checked before the write (§4.2) [`manage-agents`] |

**Goals** (`requireVisible`, then the goal gate, §7)

| Tool | What it does |
|---|---|
| `create_goal` | 1..20 links, each with an optional `blockedBy` (`link N` for a sibling, `goal-1 link 3`, or a task key); every link whose wait is satisfied starts at once (ruling 398) [`create-task`] |
| `update_goal` | `rename`, `pause`, `resume`, `cancel`, `skip_link`, `retry_link`, `edit_link`, `add_link`, `remove_pending_link`, `adopt_task` (§7.4) [the creator, or `run-agents`] |

Invariants pinned by tests: there is **no** tool for merge, acceptance,
force-accept, packet resolution or a move into the terminal stage (ruling 88's
disclosure ceremony is what chat cannot impersonate), and no tool deletes an entity
(`update_stages op: remove`, `update_goal op: remove_pending_link`, an empty
`set_file_leases` and, since ruling 464, `remove_agent_deployment` edit a file's list;
they do not delete a project, task, user, template or resource). The toolkit test pins
`remove_agent_deployment` as the only `remove_*` tool. Policy edits **are** offered, gated on the asker's `edit-policy`, because the
controller never initiates: it executes an explicit human directive with the same
authorization a settings form carries (ruling 100 confirmed the missing confirm ceremony
as intended).

### 4.1 Grants and store writes through the toolkit

- **Grants are STORE KEYS** (F33-8). `save_global_agent`'s and `update_agent_deployment`'s
  `skills` / `mcps` / `kbs` take the skill **folder name**, the MCP **registry name** and
  the knowledge-base **directory** — the same keys the runtime mounts by
  (`mountGrantedSkills` by folder, `byName.get(name)` for MCP, the glossary's "grants
  reference the directory" for KBs). `resolveResourceGrants` (`gagents.server.ts`)
  normalizes a recognised id to its key and refuses one nothing in the store answers to,
  naming it. The three list tools lead each row with `grantKey` for the same reason.
- **An omitted list is left alone** (F33-7). The three lists are merge fields on both
  tools; `[]` clears one explicitly. `list_global_agents` returns the grants so the model
  can see what it is about to change. The PERSONA follows the same rule: an omitted or
  empty persona keeps the stored one (`description: persona || existing.description`),
  `save_global_agent`'s description says so, and `list_global_agents` returns the persona
  so a summary-only edit is not a blind one (ruling 197).
- **A project copy is its own record** (ruling 156). A library deploy copies the
  template's three lists onto the deployment (`definition.resources`) and a run mounts
  that copy, so a template grant never reaches a deployed project by itself.
  `save_global_agent`'s reply is built from the result: it names every non-archived
  project whose copy differs and what it lacks or holds beyond the template ("1 project
  copy does not carry this change: k9c-k9s-clone is missing MCP server context7"), and the
  two doors: `propagate: true` on the next call, or an org admin's "Use the template's
  grants" on that project's Agents page (org admins only; a project admin sees the marker
  and asks). Propagation REPLACES the copy's three lists (a project-local extra is dropped
  and the reply says so), and records `project.agent_profile.resources_synced` per
  project. On a call that CHANGED the template's persona, `propagate` also rewrites the
  persona of every copy ruling 277's `copiesWithOlderText` names, audits each as the
  Agents page audits a persona edit (`project.agent_profile.updated` with
  `personaChanged`, `personaChars` and `source: "org-template"`) and says per project
  what it rewrote; a call that leaves the persona alone rewrites none, so a project's
  own persona survives a grants propagation, and a summary is never propagated
  (ruling 467). `update_agent_deployment`'s `persona` sets one copy. Names are entity-decoded once and
  angle brackets are refused (U35-1): `Test &amp; CI Engineer` is stored as `Test & CI
  Engineer` with the id `test-ci-engineer`.
- **The controller edits a deployment's copy for every kind** (G36-1).
  `update_agent_deployment` takes `skills` / `mcps` / `kbs` with the same semantics: grant
  keys resolved before anything is written, an unknown key refused by name, an omitted
  list left alone, `[]` clearing it. They merge into the deployment's own copy, the
  operator included. `get_project` shows the copy; the reply lists each list old → new.
- **A controller-built project's roster is the one it designed** (ruling 464).
  `create_project`'s `agents` goes through the same two steps as `deploy_agent`:
  `readLibraryTemplate` (a store key the store answers to, a specialist template) and
  `buildLibraryDeployment` (the template's grants copied, its model and effort unless the
  entry overrides them, an override judged against the template's backend), for every
  entry before the repository probe, so a refused entry leaves nothing on GitHub or on
  disk. The base Developer and Reviewer are written only when `agents` is absent. Taking an
  agent off later is `remove_agent_deployment`, the Agents page's own removal, which refuses
  a profile still engaged on an open task.
- **A create reply is re-enterable** (U36-4). `save_knowledge_base` and `save_skill`
  answer with the id the next save takes and the grantKey a grant takes: `[done] X
  created. Folder ready at store://kb/x/ (id kb_…, grantKey x).` A `disk:<dir>` (or
  `disk:<name>`) id whose folder has since gained a row resolves to that row and updates
  it (`kbRowForId` / `skillRowForId` in `resources.server.ts`); the folder conflict fires
  only for its real case, another row holding the target name.
- **A KB document write never destroys text silently** (rulings 257, 305, 377/F39-3).
  `save_knowledge_base`'s `doc` REPLACES a whole file, so a name that already exists is
  refused unless the call passes `replace: true` AND `replaces`, the `version`
  `read_knowledge_base_doc` returned; a document that moved between the read and the
  write is refused whole with both versions named, and the reply says how many bytes a
  replace destroyed. `doc.append: true` adds to the end (creating the file when absent)
  and needs no version, so a long document is built a section at a time; append and
  replace together are refused. An append concatenates EXACTLY the text sent, nothing
  trimmed and no separator inserted, so the caller owns the newlines and a part may end
  mid-table or inside a fenced block (ruling 466, F40-13). Every size a store, KB or
  skill write reports or audits (`org.store.doc_written`'s `bytes`, the reply's
  "Appended N bytes", "its previous N bytes are gone", `read_knowledge_base_doc`'s
  `bytes`) is a UTF-8 byte count (ruling 466).
- **A SKILL.md body is judged before it is written** (ruling 183). `save_skill` is one of
  the writers `assertSkillBodyWellFormed` guards (`skill-body.server.ts`; the others are
  the org-settings editor, an upload and the store browser's document editor). A body that
  is empty, that arrived JSON-escaped (literal `\n` sequences and no real newline) or whose
  frontmatter block does not parse is refused by name with the remedy, never rewritten;
  plain markdown with no block stays valid, since the mount adds the block. `body` is
  required on a create and omitted on an update to keep what is on disk.

### 4.2 Catalogued writes read first and refuse by name (ruling 139)

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
`update_agent_deployment` refuses; no such key means a real, settable grant), model,
effort and, for the operator, autonomy, derived by the Agents page's own
`assembleAgentRoster` from the projection (every agent writer reprojects before it
returns), so the controller reads what the roster renders. `list_capabilities` (instance
scope, any signed-in person) serves the ids per kind with their labels, the modes each
kind takes, the always-human three, and `whenUngranted`: the mode a deployment resolves
to when project.md carries NO grant for the id, which is `absentGrantMode` in
`agents-query.server.ts`, the one home the roster also materialises absent grants with,
never the catalogue's create-seed default (`create-task-branch` seeds `direct` and
resolves `off` when absent). The two policy-dependent operator grants
(`deliver-review-pr`, `update-task-branch`) are named as such and read from
`get_project`.

Every controller write is audited under the ASKING PERSON with the controller named as
the instrument (ruling 99(b)); the Activity audit column renders that disclosure
("<name> (via the controller)").

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
the `updated` audit rows record the model and effort written. The three effort
descriptions (`save_global_agent`, `deploy_agent`, `update_agent_deployment`) are
generated from the catalog's tier lists (`effortsFor`; U36-5), so a tier the catalog
offers is never described as missing. The profile editor shares the check for a CHANGED
value only, so a deployment that legitimately stores a preserved tier (Codex `minimal`)
stays editable, and the editor re-seeds a stored tier the backend does not list instead
of offering it.

`update_agent_deployment`'s reply is built from the record it read and the result the
writer returned, never from the request (U36-3): it lists every field the call changed,
old → new — backend, model, effort (a switch-time reset marked "(Codex default: none
given)"), stages, autonomy, each patched capability and each grant list — as
`[done] Developer updated on viberr-core: backend Claude → Codex; effort high → max; …`,
and a call that changes nothing answers `[done] … No field changed.`

### 4.3 Knowledge-base proposals (ruling 483)

Any agent on a task can propose a correction to a knowledge base its run was given: a
Claude specialist with `propose_kb_correction`, the operator with its own (which also
relays a Codex agent's reported correction), both through `proposeKbCorrection`
(`app/server/tasks/kb-proposal-actions.server.ts`). The entry lives in the corrected
document itself under `## Proposed corrections (not binding)`
([file-formats.md §7](../architecture/file-formats.md)), and the document is the record:
`listKbProposals` / `listProjectKbProposals` (`app/server/org/kb-proposals.server.ts`)
read every knowledge base's documents (parsed entries cached per file identity), and a
proposal belongs to the project whose task its stamp names. There is no second list to
drift from it: a person who deletes an entry in the document editor has closed it.

- **Where it is raised.** The per-turn context read of a board or a task lists the
  project's open ones and tells the controller to say they wait; the instance read
  counts them per visible project; `get_project` carries `openProposals` (each with
  `rulings`, whether it stands in the project's rulings KB).
- **How it is closed.** `resolve_kb_proposal` (org admin, because it edits an org
  knowledge base), and only when a person asks. The project controller page's
  **Proposals panel** (`proposals-panel.tsx`, loader `projectProposals` in
  `controller-query.server.ts`) lists each open proposal with its kind (Ruling or
  Knowledge base), document, the line it corrects, the correction, the evidence, the task
  (linked), the filer, the day and the id, and a count in its head. For an org admin it
  carries **Promote** and **Dismiss** (Dismiss confirms first) and **Open document**
  (`/org/settings?tab=resources&kb=<dir>&doc=<path>`, which opens that knowledge base's
  browser on the document). Promote and Dismiss do not write anything: each SENDS the
  request to the controller in the open conversation (the page's `send` intent), in the
  words `proposalRequest` builds, and the controller carries it out with the tool. Anyone
  else reads "An org admin promotes or dismisses proposals."

## 5. The `viberr_ops` diagnostics server (ruling 107)

An in-process, read-only MCP server mounted on **every** controller turn with no
config read and no grant row, so nothing can remove it. Its name `viberr_ops`
(`CONTROLLER_OPS_MCP_NAME`) is in `RESERVED_MCP_NAMES` (`app/shared/mcp-reserved.ts`) and
refused at the writer (`saveMcpServer`), skipped by the picker (`buildResourceCatalog`) and
never resolved from the registry (`resolveSpecialistMcpServersDetailed`). The Controller
settings tab shows it as a pinned, non-interactive chip. Its four tools are listed in the
per-turn manifest (ruling 297); every call is audited `controller.ops.read`.

| Tool | What it returns | Gate |
|---|---|---|
| `instance_health` | The same `healthSnapshot` the `/resources/health` route serves (status, degraded subsystems, projection counts and the standing projection fault, watchers, lock holder, `backends.<b>.connectedUsers`, browser, disk, maintenance, build, the backends' last quota readings, the host `toolchain`, and `mcpProxy`, the MCP gateway's `{listening, port, liveTokens}` of ruling 461), plus `backendCredentials: [{ backend, connectedUsers, askerConnected }]` and `runs`, the run concurrency snapshot `{cap, lane, live, queued}` (`lane` is the ruling-152(b) coordination lane beyond the cap). An optional `probe: string[]` (≤ 8 bare names) answers `present` + version, or `present: false` + the reason, for any command the fixed `toolchain` struct does not name (ruling 377(b)) | Open to anyone: nothing here names another person or any deployment configuration; a probe reports presence and version, never a path. The browser executable **path** stays org-admin only (`browserDetail`) |
| `list_runs` | With no arguments, every LIVE run (running, or queued behind the cap) across the projects visible to the asker, newest first; with `projectSlug` + `taskKey`, that task's runs, finished ones included. Default 50 rows, max 200; `total` and a `truncated` note when rows were left out (ruling 302) | Membership: an invisible run is simply absent; a task listing refuses a project the asker cannot see |
| `read_run_log` | A bounded page of a run's console: `run {…, logLines}`, `page {firstSeq, lastSeq, olderExist, newerExist, next}`, `lines[{seq, at, display}]`. Default 200 newest lines, max 500, in either direction; `since` together with `before` is refused | A member of the run's project; a controller turn's log follows conversation ownership with org-admin supervision. A missing run, a forbidden project and a forbidden conversation all answer the same not-visible sentence |
| `read_store_doc` | One document from a KB or skill folder in the org store, by kind, id and path segments, with `truncated` reported honestly | org admin |

Nothing here writes, deletes or starts anything. The health body assembly lives in
`app/server/ops/health-snapshot.server.ts` so the route and the tool read one
derivation.

`instance_health` answers every asker the same per-backend facts (ruling 127): there
is no deployment credential and no config path to withhold, so ruling 107's
org-admin-only credential detail arm does not exist. Each backend reports
`connectedUsers` (a count, the same one the unauthenticated health probe publishes) and
`askerConnected` (a fact about the person asking, and the only one that changes what
they can do next). Ruling 107's own subject — one health derivation, read by the route
and the tool — stands.

## 6. Configuring the controller (rulings 106 and 108)

Instance settings → Controller tab (`controller-admin-panel.tsx`, `controller-save`
intent, `saveControllerConfig`):

- **Model and effort** use the same catalog pickers as the agent profile editor
  (`ModelEffortFields` + `useModelCatalog("claude")`); a dated `claude-*` id or a
  family alias the served catalog does not list is preserved verbatim rather than
  repinned. Always editable. The model is read fresh on every turn, resumes included.
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
- **Grant requests** (ruling 390). The controller cannot grant itself a resource, so
  `request_resource_grant` records the ask in `agents/controller-requests.md` (beside the
  profile, never inside it): kind (`skills | kb | mcps`), name, reason, who asked and
  when, status `open | granted | declined | withdrawn`, audited
  `controller.resource_grant.requested` when a new row is raised (which also publishes
  `resource.updated`, so an open settings tab shows it without a reload). The Controller
  tab lists the open requests, each saying when it was asked in the viewer's time
  (`LocalDayDotTime`, ruling 480; it used to print the stored UTC ISO string), with one
  server-computed remedy sentence per kind ("… are
  deployment-locked (ruling 108): set `VIBERR_UNLOCK_CONTROLLER_KB=enabled` and restart,
  then add it on the Controller tab; saving it there answers this request. There is no
  in-app grant while the section is locked."). Every open request rides in the
  controller's own context read in every scope (`openRequestsContextLine`), so a new
  conversation knows it asked and does not claim the resource.
- **Answering a request** (ruling 390, amended 2026-09-23). A request leaves `open` in
  one of two ways, both through `closeResourceRequest`, both org-admin only:
  - **Granted.** `saveControllerConfig` closes, as `granted`, every open request whose
    name its save leaves in the resolved grants of that kind
    (`closeRequestsAnsweredByGrants`). It checks what the controller holds after the
    save, not what the save added, so a request for a resource the controller already
    had is answered by the next save of any kind, locked or not. The route's toast
    names the requests it answered. There is still no Grant button: ruling 108 keeps the
    grant itself in the unlocked grant chips and **Save controller**.
  - **Declined.** Each listed request carries a **Decline** button (`controller-request-decline`,
    `declineResourceRequest`). It changes no grant, so no section lock applies. A
    request that is no longer open is never closed twice: the refusal (409) names its
    stored status and who closed it, and an id no request carries is a 404.

  Either answer stamps `closedAt` and `closedByLabel` (the admin's email), records
  `controller.resource_grant.granted` or `controller.resource_grant.declined` (details
  `{ requestId, kind, name }`), and publishes `resource.updated` for the resource. The
  request drops off the tab and out of the controller's context. If the controller asks
  again later, that raises a new request. Nothing in the app sets `withdrawn`, and a grant
  made by hand-editing the profile file closes nothing until the next Controller-tab save.

## 7. Chained goals

A goal decomposes **one outcome into a set of linked tasks inside one project**. The
controller (or any authorized member through it) defines the chain; the server starts
each link as soon as nothing makes it wait, and advances the chain as links settle.
Position in the list is presentation, not order: a link's declared `blockedBy` is the only
thing that holds it back (ruling 398).

### 7.1 The file

Canonical at `projects/<slug>/goals/goal-<n>.md`, written only by the app (hand edits
are tolerated by the parser; unknown frontmatter keys round-trip). Frontmatter
(`GOAL_FRONTMATTER_KEYS` order): `id`, `title`, `status` `active | paused | attention |
completed | cancelled`, `createdBy`, `createdByLabel`, `conversationId` (the controller
conversation the chain was planned in, null for one written before the key; ruling 476(h)),
`onFailure` `pause | continue`
(default `pause`), `links[]`, `createdAt`, `updatedAt`. Each link carries `index`
(1-based), `title`, `goal` (the link's task text), `taskKey` (null until the link
starts), `status` `pending | active | done | failed | skipped`, `note`, `redeclared`
(ruling 192(b): an `edit_link` on a failed link re-declared its text, so the next retry
builds from the link; cleared by that retry) and `blockedBy` (what the link waits on, in
the canonical spellings of `app/shared/dependencies.ts`: a task key, or `goal-2 link 1`;
the writer accepts `link 2` for a sibling of the goal being written and stores the
absolute spelling). Body: `## Description` then `## Timeline` of newest-first
`- <UTC ISO> · <text>` bullets. Each member task carries the back-reference
`goalRef: {goalId, linkIndex}`, projected to `task_projections.goal_id` /
`goal_link_index`; the task hero shows a goal chip.

A link's task is created with its goal text prefixed by a frozen chain header
(`linkGoalText`): "Part of goal <id> (<title>), link <n>." plus "The previous link was
carried by <KEY>." when that task exists. Ruling 404: the header states only facts that
cannot move, so it never names the chain's length or another link's status; the live
chain is the operator snapshot's `goalChain` (operator §4).

`goal_projections` is the derived row; the rebuilder **reconciles link statuses
against live task rows** (archived → failed unless done; terminal stage → done; a
stored done/failed whose task is open again → active; skipped never re-derives), walks
goals after tasks, and emits the project-routed SSE event `goal.updated`. Goal files are
watched, rescanned and store-checked like every canonical file. Goals are never deleted;
terminal chains stay readable.

### 7.2 Defining

`createGoal` requires the asking user's own `create-task` in the project, a title of
at least 3 characters and 1..20 links (`GOAL_MAX_LINKS`; blank-titled links are dropped
before numbering). Under the project's goals lock it mints the id and validates every
link's wait at declaration time (`validateLinkWait`: a sibling reference must name an
existing link and never the link itself, a forward wait on a later sibling is ordinary,
everything else goes through the shared `validateDependencyRefs`), then refuses a cycle
among the chain's own links (`refuseLinkCycles`). It writes the FILE first (ruling 398(c):
a link's inherited wait on `goal-N link M` is validated against the store, which does not
hold the goal until the file exists), re-projects, and runs `reconcileGoal`, which starts
every link whose wait is already satisfied under the creator's re-proven authority. A
start that fails parks the goal in `attention` by name instead of throwing. The goal
records the conversation whose turn called `create_goal` (`conversationId`, handed to the
toolkit by the turn's mounts; ruling 476(h)). Audit `goal.created {title, links, firstTask}`,
which the project's Activity audit column reads as "<person> created goal **goal-N** (<title>)
with N links." (ruling 477(b)); the reply names every link started ("2 started
now (link 1 is KNC-3, link 3 is KNC-4)") or says every link waits on something.

### 7.3 Advancing

`reconcileGoal` is a convergent engine: hooks and the runner both just say "look at
this goal now". It runs from three task write paths (stage transition, archive or
restore, acceptance) through `maybeReconcileGoalForTask`, after `resume | skip_link |
add_link | edit_link` (an `edit_link` that sets `blockedBy`, ruling 411), and from
`startGoalRunner` (a boot catch-up, then every 60 seconds over goals in
`active | attention`). The same tick (`goalRunnerTick`) also runs the dependency release
engine (ruling 131(e), `releaseDueDependents`): every held task whose `blockedBy` entries
are all done is released, so a hand edit the hooks never saw releases within a minute.
Each pass reads every linked task's state from its canonical file and applies, under the
goal file's lock:

- a task at the terminal stage marks its link `done`; an archived or missing task marks
  it `failed` with a note; a done link whose task left the terminal stage reopens to
  `active`; a failed link whose task is back on the board recovers to `active` and lifts
  the `attention` that failure caused (never a person's `paused`);
- a failed link with `onFailure: pause` parks the chain in `attention` and notifies the
  creator; with `continue` it marks every failed link `skipped` and moves on;
- when every link is `done` or `skipped` and the chain is not in `attention`, the goal
  completes (audit `goal.completed {title}`, notification to the creator);
- otherwise, on an active chain, EVERY pending link with no task is judged
  (`linkWaitState`): a wait on a sibling is answered from the frontmatter being written (a
  `skipped` sibling settles it like `done`), anything else through the projection. `ready`
  links start; `open` ones wait; a `dead` wait (a failed sibling, a missing link, an
  archived task) parks the chain in `attention` with "Link N (…) waits on work that can
  never complete".

Before any start the creator's **live** `create-task` is re-proven (`creatorMayCreateTasks`,
silent deny); lost authority parks the chain in `attention` and notifies the creator. Each
start (`startLinkTask`) holds a per-link lock (`goal-start:<slug>:<goal>:<link>`), re-checks
that the chain is active and the link still pending before `createTask` and again under the
goal-file lock after it, and creates the task under the actor
`{ userId: createdBy, label: "<label> · goal chain" }`. The task's creation events (the
owner seat and any "Waits on other work" note) are signed `system:goal-chain`, not by the
creator, and the seat reads "Started by **goal-N** as link M, on <creator>'s authority,
with <owner> as owner. …" (ruling 477(b)); a retry's reads the same with the retrying
person's authority. The first start that throws parks
the chain and leaves the rest for a later pass. Each start notifies the creator ("Link N
started as KEY"). Ruling 131(c): the link's declared `blockedBy` is copied into
`createTask` and validated there, so the task is born held (readiness floored at
`blocked`); when the mint is the completion of the very work it waits on, the release
engine is asked once right away (`releaseTask`, ruling 358) instead of leaving the task for
the minute tick.

From the moment a link has a task, the task's list IS the wait (ruling 155): every
change to it, whoever makes it (the task page, the controller's `update_task`, the
operator's `set_dependencies`, the release engine), is mirrored onto `links[].blockedBy`
by `mirrorLinkWait` (`dependencies.server.ts`) with a goal timeline line naming who
changed it (the engine signs as "Viberr (release)"), and the goal projection is rebuilt.
The mirror writes only while the link is `active` and carried by that task, and only
when the two lists differ; a retried link is therefore born on the wait the record last
held.

### 7.4 Redirecting

`updateGoal` is gated by `requireGoalAuthority`: the creator (project mutable and any
membership) **or** a member holding `run-agents`. Every op except `rename` refuses on a
`completed` or `cancelled` chain. Audit `goal.updated {op, message, title, index?,
reason?, from?, to?, unchanged?}` (the chain's title after the op, the link an op touched,
a person's reason, a rename's two titles, `unchanged` for an op that changed nothing; an
`adopt_task` row carries the adopted task's key), from which the Activity audit column
writes one sentence per op (ruling 477(b)).

- `rename` — the chain's title and/or description, on any chain including a settled one
  (ruling 267); neither steers work, and the timeline says link tasks keep the old name in
  their frozen chain header.
- `pause`, `resume` (re-runs the reconcile), `cancel` (optional reason; terminal).
- `skip_link` — a pending or failed link (refused while an active link's task is being
  worked); un-parks `attention` and re-runs the reconcile.
- `retry_link` — failed links only; a fresh task under the PRESENT caller, rebuilt from
  the failed TASK's own current title and goal rather than the link's frozen copy
  (ruling 192), unless the link was re-declared by `edit_link` (ruling 192(b)); the goal
  timeline records which text it carried. A retry that starts nothing (the chain stopped
  being active while it ran) re-parks the chain, notes the link, notifies the creator and
  says so (ruling 194); a retry whose `createTask` throws parks the chain the same way.
- `edit_link` — a pending or failed link's title, goal and `blockedBy` (absent leaves the
  wait, `[]` clears it; validated at declaration time, cycles refused). Setting a pending
  link's `blockedBy` re-runs the reconcile in the same call, and when the wait is cleared
  the reply names the task just created ("Link N started as KEY"), not the chain's current
  link (ruling 411). On an ACTIVE link `blockedBy` is the only editable field: the chain's
  own rules are applied first, then it is forwarded to `setTaskDependencies` on the link's
  task after the goal-file lock is released, under that writer's own gate, and mirrored
  back ("Link 1 waits on nothing, through KNC-3."); a title or goal on an active link, or
  an edit with nothing to forward, is refused with "Only a pending or failed link's title
  or goal can be edited; link 1 is active. Its wait follows KNC-3: pass blockedBy here or
  edit it on the task."
- `add_link` — ≤ 20 links; the index is the highest + 1; re-runs the reconcile, so a link
  with no wait starts at once.
- `remove_pending_link` — a pending link with no task; re-indexes the later links, so it
  is refused while any link of this or another goal, or any task, waits on a link at or
  after the removed index (`referencesToLinksFrom`), naming them.
- `adopt_task` — binds an EXISTING, non-archived task that belongs to no other chain to a
  pending link with no task (ruling 243): the link goes `active` and mirrors the task's own
  `blockedBy`, and the task gains its `goalRef` and an "Adopted into a goal chain" note
  after the goal file commits.

The project route's `goal-op` intent exposes `pause`, `resume`, `cancel`, `skip_link` and
`retry_link`; `rename`, `edit_link`, `add_link`, `remove_pending_link` and `adopt_task` are
controller-tool-only.

### 7.5 Reading a chain

- **`get_goal`** reads the canonical file with its history and the `conversationId` the
  chain was planned in (ruling 476(h)). A link's `goal` is always the
  contract in force: for a link whose task's current goal (chain header stripped) differs
  from what the chain declared, `goal` is the task's text and the declaration is kept as
  `declaredGoal` (ruling 335, reversing ruling 192's `liveGoal` naming).
- **`list_goals`** and the Goals panel read the projection; each link carries `waits`, its
  declared entries with their live state (ruling 359).
- **The Goals panel** (the project controller page's rail): the head counts chains by
  status, naming only the non-zero ones ("1 active · 1 paused · 2 need attention · 3
  settled", `goalsCountLine`, ruling 476(f)). Each chain is a `<details>` card anchored
  `#goal-N`, stating "N of M done", plus "· N waiting on you" and "· N waiting on a human"
  for its started links whose task waits on a person; a settled chain starts folded. Each
  link row prints its number ("Link 3" to a screen reader) and is anchored
  `#goal-N-link-M` (`goalLinkAnchor`, `app/shared/goal-anchor.ts`): the task page's chain
  chip and a wait entry naming a goal link open that row, and the jump opens its chain,
  scrolls the row to the top of the rail, focuses it and marks it (`data-targeted`; ruling
  476(b)). "About this chain" folds "Planned in <conversation>" (a link to the thread whose
  turn created the chain, for a viewer who may open it: its owner or an org admin), the
  description and the newest six history entries, all read from the file in one pass
  (`readGoalFileFacts`, rulings 419(h) and 476(h)); the Conversations panel above lists the
  planning threads its own list does not hold under "Where this board's chains were
  planned" (`plannedElsewhere`). A started link's pill is the board card's status for its
  task, word and colour (`cardStatus` through `linkTaskStatuses`, fed the board's own
  review queue and live-run state; "waiting on you" in the board's blue, "waiting on a
  human", "input required", "agent working", "resumes <time>"; ruling 476(g)); without it,
  a link whose task exists and still waits on anything unfinished shows **blocked**. Its
  wait is a disclosure summarised as a count ("waits on 6 open · 4 done", plus "· N can
  never finish" in the danger colour) that opens to one row per entry with its state, link
  and title (ruling 425; the "open" is ruling 476(b)'s, so the count never reads as a link
  number). Controls (Retry and Skip per failed
  link, Pause/Resume, Cancel) render for `run-agents` holders, org admins and the chain's
  own creator (ruling 260). Cancel and Skip confirm in the danger face; the cancel confirm
  names the unstarted links that will never start and the other chains' links that would
  wait forever (`linksStrandedByCancel`) and takes an optional reason (ruling 419(c)).
- **The operator** of a chain task reads the live chain as `goalChain` in its snapshot
  (ruling 402).

## 8. Identifiers this subsystem emits

- Audit actions: `controller.authority.denied`, `controller.ops.read`,
  `controller.repo.read`, `controller.github.read`,
  `controller.resource_grant.requested|granted|declined`, `org.controller.updated`,
  `goal.created`, `goal.updated`, `goal.completed`, plus
  `task.agent.commented` with label `controller` and every downstream row under
  `<email> · via controller`.
- Notification kind: `controller`, created only for goal progress (a link started, the
  chain parked in attention, a retry that did not start, completion), addressed to the
  goal creator, from the "Controller" agent identity. The category has a routing toggle
  in the profile, default on. A conversation reply is not a notification: the
  unseen-reply dot (§3) is its signal.
- SSE: `controller.updated {conversationId, userId}` (owner-routed),
  `controller.log-appended {conversationId, userId, runId, threadId, seq}` (owner-routed,
  one per stored console line of a controller run; a stream event, tailed by the console
  and ignored by `useLiveUpdates`),
  `goal.updated {projectSlug, goalId}` (project-routed).
- Timeline: `comment` events authored by `controller` with the trailer
  `_Posted by the controller for <name>._`.

## 9. Known drift (recorded, not fixed here)

- Ruling 108's note that the panel "skips the P13-KM-01 display-name repair" under a
  lock is stale wording: the panel runs the repair for display and posts blank for
  locked sections; the byte-for-byte outcome holds through the server.
- `read_store_doc`'s not-found sentence says "Viberr has no tool that returns repository
  file contents"; `read_default_branch_file` (ruling 299) is one
  (`controller-ops-mcp.server.ts`).
- The shipped controller doctrine and `controller-guide` skill still describe chains as
  starting one link at a time (§7 is ruling 398's fan-out); they are product prompts
  pinned by tests and are the owner's to change.
