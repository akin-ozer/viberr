# The controller and epics

> The instance-level conversational agent: whose authority and account a turn runs on, its
> surfaces (the dock and the two pages), conversation scopes and the per-turn context read, its
> `viberr_controller` toolkit and built-in `viberr_ops` diagnostics server, its deployment locks,
> and the project epics it plans work into for a person (§7), which replaced its chained goals.
> Source of truth: `app/server/controller/*`, `app/server/tasks/epic-actions.server.ts`,
> `app/server/files/epic-writer.server.ts`, `app/schemas/epic-file.schema.ts`,
> `app/shared/task-refs.ts` (the epic id and statuses),
> `app/server/projections/epic-query.server.ts`, `app/server/tasks/goal-epic-conversion.server.ts`,
> `app/server/projections/rebuilder.server.ts` (the epic projection), `app/features/epics/*`,
> `app/routes/project.epics.tsx`, `app/routes/project.epic.tsx`, `app/features/controller/*`,
> `app/routes/controller.tsx`, `app/routes/project.controller.tsx`,
> `app/routes/resources.controller.ts`, `app/routes/resources.controller-unseen.ts`, `app/root.tsx`
> (the dock mount), `app/features/org-settings/controller-admin-panel.tsx`,
> `db/migrations/0001_baseline.sql` (the two controller tables).
> Rulings 99, 100, 106, 107, 108, 121, 127, 373, 390, 483, 492, 502 and 503 in
> [decisions.md](../architecture/decisions.md) set most of what is here.
> Verified against `main` @ `7d9fbf72` (2026-09-23); §7 rewritten for ruling 503 (2026-09-26).

## 1. What it is

The controller is one instance-wide agent that every signed-in user can talk to.
It is machinery like the per-task operator but sits above it: it answers questions
about the instance and its projects, performs governed actions **strictly within the
asking user's own permissions**, and plans work into the project's epics for them (§7).
It never replaces the operator; each task it creates gets its own operator through the
ordinary create-task path.

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
| `/projects/:slug/controller` | project members (non-members get the unknown-slug 404) | Board scope: the same conversation machinery bound to the project, plus the **Knowledge base panel** (§4.3, rulings 483 and 498); `POST intent=kb-correction-undo` is the panel's Undo (org admins). Fourth item in the workspace rail (after Board, Epics and Review queue). Same execution panels as the instance page. |
| Instance settings → Controller tab | org admins | Configures the controller itself (§6). |
| **The dock**, on every signed-in surface | any signed-in user | Ruling 121: a floating Controller button, bottom-right, opening a non-modal panel bound to the place the person is standing (§2.1). |
| `/resources/controller` | any signed-in user; project and task scopes require membership; a signed-out request gets a 401, never a login redirect | The dock's data route: `GET ?project=&task=&c=` answers the scope's view, `POST intent=send` records the message and runs the turn (409 when the asker has no Claude connected; `mode=queue` queues it behind a working turn instead of steering it, ruling 527), `POST intent=send-now` / `intent=retract` (`conversationId`, `messageId`) are ruling 527's moves on a message still waiting, for the conversation's owner (409 with a sentence once it is not waiting). |
| `/resources/controller-unseen` | any signed-in user; a signed-out request gets a 401 with an empty status, never a login redirect | The dock's status: the viewer's unseen controller replies in every scope, each with the page that opens it (§3, ruling 448), and the viewer's turns working right now with their scope, phase and step (ruling 457). |

Entry points: the dock (everywhere), the workspace rail item, the Home hero link (once a
project exists) and the org-settings tab's "Open the controller". There is no
command-palette entry.
The page subscribes to the user SSE scope (and the project scope on the project surface)
and, while a turn is working, reads the turn's console tail every 5 seconds: the fallback
for a settle the stream missed, which revalidates the page once the tail says the run
ended (ruling 457, CTL-2; it used to revalidate root, the workspace layout and the page
every 5 s to move one step line). New conversation sits in the page head;
the rail lists the conversations, is `position: sticky` and scrolls
itself, and below the two-column breakpoint the head carries a native thread picker
(`ConversationPicker`); the transcript is a capped scroller that never moves the page
(ruling 419). A blank transcript offers three example asks per scope that send on click
(`controller-examples.tsx`, shared with the dock; ruling 314), drawn as one framed list of
rows: the glyph of what each is about, the sentence, and an arrow (ruling 516). A working
turn shows the run's `phase` and last tool `step` on the row that says it is working
(ruling 250). Below the
two-column breakpoint the thread picker takes a row of its own in the head, with New and
Home on the row under it (ruling 476(e)). A link in a message, and any other long token in
its prose (a word joined by slashes), wraps inside the transcript rather than scrolling it
sideways (`.md-body a`, and `.md-body` paragraphs, list items, blockquotes and headings;
a code block and a table keep their own scrollers; ruling 476(a), (i)). Where the transcript puts
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
never under a later message. A message sent while a turn works STEERS that turn unless its
sender queued it (ruling 527): it sits in the turn, under the message the turn answers and
above the working row and the turn's reply, saying "steering · next step" until the turn
reads it at a step (`turn.steering`) and "steered" for good after (`steered_into`); it gets
no reply of its own, the turn's reply answers it. While a turn works the composer offers
**Steer** (primary, ⌘↵) and **Queue** (⌘⇧↵), and a message still waiting offers its sender
**Send now** (a queued one, into the running turn) and **Retract** (a queued or steering one
nothing has read: it leaves the conversation and its text goes back into the composer,
under what is typed; `waiting-actions.tsx`). The composer is
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
  `turn-step.tsx`), ruling 527's steering, Steer and Queue, Send now and Retract (posted to
  its own resource route) and the composer takes focus on open (the send hint names the
  viewer's own modifier and drops on a coarse pointer) — on a user-initiated open only, so
  a remembered-open reload never starts focus inside the textarea. Escape closes and
  returns focus to the trigger **while focus is inside the panel**. An Escape pressed on a
  page control the panel covers also closes it and leaves focus on that control (with no
  focus trap, Tab reaches controls under the panel; ruling 455(d)). Any other Escape (the
  palette, a confirm dialog, a stage menu or its trigger, focus on nothing) leaves the dock
  alone, and an outside press never closes it. An empty thread offers the scope's three
  examples, which send on click: its sentence sits in the middle of the transcript and the
  examples at its foot, over the composer (ruling 516).
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
  the stored id). A thrown response from a root-owned fetcher replaced the whole page,
  which is the hazard ruling 121(f) named for CSRF. The unavailable view names
  nothing but what was typed (F35-4): `projectName` is null, the label reads "Not
  available here", and the projection is never read for it, so a non-member cannot learn
  a project's display name from a guessed slug. A request the server never answers (a
  restart, a 5xx, a dead network) keeps the page too (ruling 457). Both routes have a
  `clientLoader` that answers a failed load with null, which the dock reads as not
  loaded yet: no dot and no working poll, and the open panel's loading lines over a held
  composer that keeps what was typed, until a load answers (the next
  `controller.updated`, which a `stream.resync` after a restart hands it, a thread pick,
  or opening the panel again). The view's route has a `clientAction` that answers a
  failed send with `{ ok:false }`, which the dock toasts ("The controller could not take
  that. Try again.") while the message stays in its composer. Neither says why, so the
  handlers still answer rather than throw.
- **Never a login redirect** (ruling 457, test audit L14-29): both routes answer a
  request with no session, or with a forced password reset pending, with a 401, returned
  like every other answer. `requireAuth`'s login redirect named the route and the scope's
  query as the returnTo, and a fetcher follows a redirect as a navigation, so a stale
  tab's dock went to `/login` and, once signed in, to a page of raw JSON. The status
  answers an empty status, so the button shows no dot and the working poll stops. The
  view answers the `signedOut` view (`signedOutDockView`): the unavailable view's shape
  with the label "Signed out", built from the scope asked about with nothing read, not
  even the controller's configured name, and its panel says "You're signed out, so the
  controller can't answer here. Reload the page to sign in again." over a disabled
  composer. A send answers `{ ok:false, error }`, which the dock toasts while the message
  stays in its composer. The page's next real navigation asks for the sign-in, with its
  own path as the returnTo.
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
user|controller, user_id, text, run_id, surface, created_at, reply_to, unlinked_history,
steered_into)`
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
dated note of 2026-09-25). `steered_into` (ruling 527) is, on a user message a turn read
at one of its steps, the message that turn answers; it has no backfill (nothing before the
column could steer a turn). A Retract deletes a user message nothing has read yet, so a
conversation's `seq` can have gaps.

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
3. Single-flight per conversation with a FIFO capped at 8 waiting messages
   (`MAX_QUEUED_MESSAGES`, steering and queued together); overflow is refused
   in-transcript. The lease records the message the current turn answers, and
   `conversationTurnState` exposes it and the waiting ids (`answering`,
   `queued: [{ messageId, ahead }]`, `steering`) on both views, so the transcript names
   the queue from the server's side (ruling 465); joining either publishes
   `controller.updated`. A message sent while a turn holds the lease **steers** it unless
   the form says `mode=queue` (ruling 527): the lease keeps it in `steering` until the run's
   next step boundary asks (`RunSpec.steering.take`, which the Claude adapter calls from the
   SDK's `PostToolBatch` hook: every tool call of a batch answered, before the next model
   request). The adapter hands it to the model as that hook's `additionalContext`
   (`steeringText`: the person sent it while the turn worked, it is part of this turn, and
   the turn's reply answers it), writes a `run·steered` console line, and the lease marks
   it `steered_into` the message the turn answers. The SDK's `Stop` hook (the model has
   written its final answer) closes steering: what still waits, or is sent after, goes to
   the queue's front, behind any other message that missed a turn and ahead of the ones
   queued on purpose, and starts the next turn, which takes steering again. The SDK's own
   mid-turn input is not used (ruling 527(a)). `sendQueuedMessageNow` (Send now) moves a
   queued message into steering, or to the queue's front once the turn is closed, and
   `retractWaitingMessage` (Retract) deletes a waiting message nothing has read and
   answers its text; both are the conversation owner's alone and refuse a message that is
   not waiting (409).
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
   unlinked note written before it, and every message that steered one of those turns
   whatever its own `seq`, ruling 527; the newest 30 of those, `CONTEXT_MESSAGES`, 24 000
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
     (ruling 309), engaged agents, branch and PR, open packet, the task's epic, and what
     the task waits on with each entry's state) plus the canonical `task.md` verbatim inside
     a fence, bounded by `TASK_FILE_CONTEXT_CHARS` (24 000; over budget the head stays whole
     and the newest timeline entries are kept, with a marker naming how many were omitted);
   - for a board, the project's description (600-char excerpt), repo, members
     (`BOARD_CONTEXT_MEMBERS` 20), the same `your authority: …` line, stages with counts,
     boundaries, the open-task table (`BOARD_CONTEXT_TASKS` 40 rows, `BOARD_CONTEXT_CHARS`
     12 000) and the open epics with their progress (`BOARD_CONTEXT_EPICS` 20, ruling 503);
   - for the instance, the projects the person can see (`INSTANCE_CONTEXT_PROJECTS` 40)
     with their role and what is happening in each: task totals, how many are not done,
     running, and waiting on them (ruling 307);
   - on a board or a task, the project's open knowledge-base proposals (ruling 483,
     `projectProposalsContextLine`): the ones its tasks filed under "Proposed corrections
     (not binding)" in any knowledge base before ruling 498 ended the filing, up to 10 by id
     with the document, the task and filer, the line and the correction, and the instruction
     to tell the person they wait and to close one with `resolve_kb_proposal` only when the
     person asks; at the instance scope, the count per visible project. Corrections agents
     wrote (ruling 498) owe nobody anything and are not in the read: `get_project` lists them;
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
   bases as INDEXES (ruling 283: every document with its size class and sections, read on demand
   with `read_knowledge_doc`), which on a project-scoped conversation include the
   project's rulings knowledge base (ruling 239, with the rulings note when it resolved);
   a runtime block (the model is named in each turn's message; the mounted org MCP
   servers; `viberr_ops` always attached; no filesystem or shell); the gateway sentence
   naming the servers reached through Viberr's MCP gateway (ruling 461); the ruling-namespace
   paragraph (ruling 312: a ruling number inside a tool description is Viberr's own
   product decision, while a project's rules live in its knowledge base, number from 1,
   and are cited by document and section); the per-turn tool manifest generated from both
   in-process servers' registries (ruling 297); the measured shell inventory (ruling 191);
   and the writing guide, the vendored Humanizer skill every operator drive also carries
   (ruling 502, [operator.md §4](operator.md)). The controller writes its replies, epics
   and directives by the guide and never names it; no profile grants it, so the settings
   panel (§6), `configSkills` and the run's `run_inputs` skills row never list it, and no
   lock or save removes it. The dynamic tail behind the SDK's boundary is: the granted MCP
   servers that did NOT mount this turn, each with the reason its own probe gave and the
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
   message it answers, releases the lease and starts the next queued message; a steering
   message the turn never read (it stopped or failed first) goes to the queue's front
   before that (ruling 527). When that
   start fails, the note goes under the message it tried and every message dropped behind
   it gets its own note (ruling 465), a message sent to steer it included. A FIRST turn
   whose start fails does the same for any message another surface queued or sent to
   steer it while the start awaited.

Everything the run machinery gives every other run applies: raw NDJSON transcript,
line redaction, token accounting, the run's input disclosure (`recordRunInputs`, on the
fresh path and every resume; ruling 344), the run-log console (owner or org admin, via
`canReadControllerRunLog`, the same gate `/resources/run-log` and the session export
apply; rendered on the controller pages, §2.2), the interrupt (`canInterruptControllerRun`,
§2.2) and boot orphan finalization. Boot also writes an honest "interrupted by a server
restart" note under every user message no reply answers in a conversation no live turn
holds, that the backfill did not mark earlier history and that no turn read as steering
(`recoverControllerConversations`, rulings 465 and 527): the turn whose run died (its note
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

**57 tools**: 56 registered on every turn (`grep -c "^  add(" controller-toolkit.server.ts`
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
| `list_mcp_servers` | Org MCP connections led by `grantKey` (the registry name): transport, target, the cached `up` verdict with `lastCheckedAt` / `warmingSince`, ruling 176's `writeTools` and `writeToolsReviewed` and what the marking does, and `storeAccessNote` for a command pointed inside Viberr's own store (ruling 278); `signIn` (an HTTP server's OAuth sign-in: null, or `needs_sign_in`, `signed_in` with `expiresAt` and `renews`, or `expired` with its reason) and `signInNote`, which says what it means for runs and that only an org admin signs a server in or out, in Instance settings (ruling 469); `signIn.grant`, what the sign-in was granted ({`scopes`, `writes`, `readOnly`, `summary` such as "read-only · 194 scopes", `writeScopes`}, never the whole list; null when the server did not say), with the note ending in the grant and, for a read-only one, that every write is refused until an admin signs in again with write scopes, and `requestedScopes`, what the next sign-in asks for (ruling 486); never credentials or tokens | org admin |
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
| `resolve_kb_proposal` | Close one open knowledge-base proposal by id (§4.3, ruling 483; filed before ruling 498): `promote` writes `text` into the document's settled text in place of `replaces` (which must stand there once, outside the proposals section) or appended to it, and removes the entry; `dismiss` removes the entry only; audited `org.kb.proposal_promoted` / `org.kb.proposal_dismissed` with the `reason` | org admin |
| `undo_kb_correction` | Undo one knowledge-base correction an agent wrote, by its `kc-` id (§4.3, ruling 498): puts back the passage it replaced (or removes the text it added) when the written text still stands once, notes the undo on the task that made it, and records `task.kb_correction.undone` with the person's `reason`, which an agent that tries to write the same text again is shown; a document edited since is refused | org admin, when a person asks |
| `save_skill` | Create or update a skill (name, summary, SKILL.md body) (§4.1) | org admin |
| `save_mcp_server` | Create or update a connection; takes no credential; reserved names refused; `writeTools` marks the tools withheld from runs without repo-write and from every operator run (ruling 176), and a save with none set names the tools that look like writes. Its description says an HTTP server that asks for an OAuth sign-in is signed in by an org admin in Instance settings, which the controller cannot do, and a save that meets the sign-in challenge says so instead of "add a secret" (ruling 469). `requestedScopes` records the OAuth scopes the next sign-in asks for (space-separated; omitted keeps them, "" clears them), which the authorization server may grant or not (ruling 486) | org admin |
| `test_mcp_server` | Probe one connection now and report its health in the command's words; an OAuth server reads "needs sign-in", "healthy … signed in (expires in …, renews itself)" or "sign-in expired: an admin must sign in again" (ruling 469), a healthy one ending with its grant ("· read-only · 194 scopes", ruling 486) | org admin |
| `save_global_agent` | Create or update a specialist template: backend, summary, persona, stages, default model and effort, grants (§4.1, §4.2); `propagate: true` rewrites differing project copies' grants (ruling 156) and, on a call that changes the persona, the persona of every copy still running older text (ruling 467) | org admin |

**Project creation**

| Tool | What it does | Gate |
|---|---|---|
| `list_github_connections` | Every GitHub connection: `owner`, `default`, token kind, validation (`valid` / `failed` with the validator's reason / `unvalidated`) and `lastValidatedAt`, expiry, `missingScopes`, bound project count, and `reach`: the repositories the TOKEN reaches, each with `private` and `canPush`, read when the token was last validated (`read` with a summary and counts, `unknown` with GitHub's reason, or `not_read` for a connection saved before the read existed). No token material, not even the masked suffix (ruling 463) | signed-in |
| `create_project` | A project with any shape in one request (stages, boundaries, members, description); needs a GitHub connection for the repo owner, and its description sends the model to `list_github_connections` first (ruling 463); the asker is seeded project admin (FR5). `createRepository` (`{ private, description? }`, ruling 462) creates the repository on GitHub with the connection's token when the probe finds none, before the project is written: a refusal names what the token lacks and writes nothing, an existing repository is used as it is, and the reply says which happened. Audit `project.repository.created`. `agents` (`[{ profileId, model?, effort? }]`, ruling 464) writes the operator plus exactly that roster and no base Developer or Reviewer, each entry the deployment `deploy_agent` would write; `operator` (`{ model?, effort? }`) sets the operator's own. Every entry is judged before anything is written, GitHub included: an unknown or non-specialist template, a model or effort its backend does not offer, a duplicate or an empty list is refused by name. Without `agents` the base roster is written, as from the New project dialog. The reply lists every deployment written with its model and effort, and `project.created` records the roster's ids | signed-in |

**Board reads** (all `requireVisible`, archived projects included)

| Tool | What it does |
|---|---|
| `get_project` | Stages with task counts, workflow, members, deployed agents with their RESOLVED grants, board-resolved eligible `stages` beside `declaredStages` (ruling 188), model, effort, operator autonomy, `resources` and `templateDrift`; `advisory` marks a matrix-only grant (ruling 377(a)); `requiredReviewers` (ruling 178), `epics` (each with its status, lead, dates and progress; ruling 503), `rulingsKb` (ruling 239), `openProposals` (ruling 483, §4.3), `kbCorrections` (ruling 498, §4.3: the newest 20, each with its passages, evidence, task, filer and whether a person undid it), resolved `fileLeases` and `spentFileLeases` (rulings 245, 247), `gates` (ruling 482) |
| `list_tasks` | Key, title, stage, readiness, waiting, owner, priority, `epic` and `waitsOn`; `epicId` filters to one epic (`none` for the tasks in no epic, ruling 503); Done included, archived only with `includeArchived` |
| `get_task` | Live state (stage, readiness, goal, engaged agents, PR, open packet), its `epic` by id and title (ruling 503), `notAcceptableReason` (the acceptance gate's own verdict, ruling 188), `gates` (ruling 482: the PR card's line, the state, each gate's outcome, time and log, or null), pending `schedules` (ruling 153), `timelineTotal`, and the newest events (default 12, max 50), each cut at 700 characters |
| `read_timeline_entry` | One timeline entry in full, by the `at` stamp `get_task` prints (ruling 285) |
| `read_task_attachment` | One text attachment of a task (`.txt .log .md .json .yml .yaml .csv .diff .patch`; ruling 293) |
| `read_default_branch_file` | One file as the project's default branch has it, from the project's git mirror (built on first use), in pages of whole lines via `fromLine` (rulings 299, 436); an absent path is reported absent; audited `controller.repo.read` |
| `get_github_state` | Connection and credential health, task branches with sync state, PRs with checks, review and mergeability (the three meanings of a null `checks` spelled out), cache freshness |
| `read_pull_request` | A task's review PR: every changed file with status, counts and unified-diff hunks; `patches: false` for the file list, `path` for one file, a byte budget with `patchOmitted` flags (ruling 266); audited `controller.github.read` |
| `list_decisions` | Everything waiting on a person: open packets with every option and the `ownWords` free-text choice (ruling 271), pending recommendations, completions ready to accept, each with `releases.direct` / `releases.downstream` (ruling 336); answers nothing (ruling 251) |
| `list_epics` | The project's epics, each with its status, lead, dates and progress counted from its tasks (§7.2) |
| `get_epic` | One epic in full: what it is, its progress by stage, every task in it (archived ones included) with its stage, readiness, owner and what it waits on, and its history, newest first |

**Board writes** (`requireVisible`, then the same `requireAction` / `assertProjectAction`
matrix the human surfaces use; the tier in brackets is the floor)

| Tool | What it does |
|---|---|
| `create_task` | A task at the entry stage [contributor, `create-task`]; takes `blockedBy` (validated before a key is allocated; the task is born held, and released at once when every entry is already done), `owner` (a member email or `me`, seated in the creating write before the first operator run; ruling 140(a)), `dueDate`, `priority: urgent` as the urgent flag, and `epic`, the epic it is born in (checked before a key is allocated; ruling 503) |
| `move_task` | A stage move [`approve-transition`]; a move into the terminal stage is refused and pointed at the task page; a move to an EARLIER stage requires `reason`, which lands on the transition entry (ruling 381) |
| `comment_on_task` | A comment signed `_Posted by the controller for <name>._` [member; refused on an archived project]; @mentions of people notify; an @mention of an agent starts nothing and the line is stamped saying so (ruling 252) |
| `set_task_owner` | Seat the asker, another member, or release [`own-task`; takeover needs the acceptance tier]; the person whose seat changed is notified (ruling 140(b)) |
| `update_task` | The goal and the `title` [`update-goal`, maintainer; ruling 295], priority / labels / due date, each axis it is given replaced whole and the rest left as they stand [`edit-task-meta`], `blockedBy` as the FULL list through `setTaskDependencies` (`[]` clears it and releases the task; ruling 131), and `epic` through `setTasksEpic` (`""` takes the task out; ruling 503) [`edit-task-meta`]; each part reported on its own arm, an unchanged axis answers `[noop]` |
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

**Epics** (`requireVisible`, then the epic gates, §7.3)

| Tool | What it does |
|---|---|
| `create_epic` | An epic with its title, description, status (default `planned`), colour, `lead` (a member email or `me`), start and target dates, and `tasks`, existing tasks put in it as it is made (a task in another epic moves); records the turn's conversation (ruling 476(h)) [`manage-epics`; `edit-task-meta` for `tasks`] |
| `update_epic` | Any of those fields (`lead: "none"` and a blank date clear), plus `addTasks` and `removeTasks`; every task key is checked before anything is written (one not in this epic for `removeTasks`, an unknown or archived one, or a withheld grant refuses the whole call, fields included); there is no delete, and an epic is closed by its status [`manage-epics` for the fields, `edit-task-meta` for the tasks] |

Invariants pinned by tests: there is **no** tool for merge, acceptance,
force-accept, packet resolution or a move into the terminal stage (ruling 88's
disclosure ceremony is what chat cannot impersonate), and no tool deletes an entity
(`update_stages op: remove`, `update_epic`'s `removeTasks`, an empty
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

### 4.3 Knowledge-base corrections (rulings 483 and 498)

Any agent on a task corrects a knowledge base its run was given by writing the correction
into the document (ruling 498): a Claude specialist with `correct_knowledge_doc`, the operator
with its own (which also relays a Codex agent's reported correction), both through
`correctKnowledgeDoc` (`app/server/tasks/kb-correction-actions.server.ts`), which calls
`mergeKbCorrection` (`app/server/org/kb-corrections.server.ts`; the edit rules are
[file-formats.md §8](../architecture/file-formats.md)). Nobody approves it first: the owner
chose it on 2026-09-26 ("No human can approve all of these while inspecting them
thoroughly"). The task records it in one `kb_correction` event (the document, the id, the
passage before and after) and notifies nobody. The record is the
`task.kb_correction.merged` audit row, which carries both passages, so an undo is the same
edit in reverse.

- **Where it is read.** `get_project` carries `kbCorrections`. The project controller page's
  **Knowledge base panel** (`knowledge-panel.tsx`, loader `projectCorrections` in
  `controller-query.server.ts`) lists the newest 20 (`listKbCorrections`, audit retention
  bounds the rest) with the count on record: each with its kind (Ruling or Knowledge base),
  document, the passage it replaced (struck through) and the text it wrote, the evidence
  (collapsed), the task (linked), the filer, the time and the id, and "Open document" for an
  org admin. A `kb_correction` event on a task links "Review or undo" to the panel
  (`#kb-corrections`), and a controller reply naming a `kc-` id links to its entry
  (`#correction-<id>`), which is marked and focused the way ruling 497 reveals a
  notification's target.
- **How it is undone.** An org admin's **Undo** (confirmed first, with an optional reason) posts
  `intent=kb-correction-undo` to the project controller route, which calls
  `undoKbCorrectionOnTask` directly: no controller turn, since there is nothing to compose.
  `undo_kb_correction` does the same for a person who asks the controller. The undo puts the
  passage back when the written text still stands once (a document edited since is refused),
  notes it on the task that made the correction ("Knowledge-base correction undone", as the
  person), and records `task.kb_correction.undone`. An agent that later tries to write the
  same text into that document is refused, told who undid it and why.
- **Proposals filed before ruling 498.** Ruling 483 filed each correction as a proposal under
  `## Proposed corrections (not binding)` in the document
  ([file-formats.md §7](../architecture/file-formats.md)) for a person to promote. Nothing
  files one now, but documents keep the ones they hold, and the document is still their
  record: `listKbProposals` / `listProjectKbProposals` (`app/server/org/kb-proposals.server.ts`)
  read every knowledge base's documents (parsed entries cached per file identity), a proposal
  belongs to the project whose task its stamp names, and a person who deletes an entry in the
  document editor has closed it. The per-turn context read of a board or a task lists them
  and tells the controller to say they wait (§3), and `get_project` carries them in
  `openProposals`. The Knowledge base panel lists them under the corrections with their
  count; for an org admin each carries **Promote** and **Dismiss** (Dismiss confirms first),
  and **Promote all** asks for the lot in one request. None of the three writes anything:
  each SENDS the request to the controller in the open conversation (the page's `send`
  intent), in the words `proposalRequest` / `promoteAllRequest` build, and the controller
  carries it out with `resolve_kb_proposal` (org admin, because it edits an org knowledge
  base). Anyone else reads "An org admin promotes or dismisses proposals." A proposal's
  notification opens its entry here (`#proposal-<id>`, ruling 497): the entry is marked and
  focused, and one promoted or dismissed since leaves the proposals list in view. The mark
  (`data-targeted`, never `:target`) lasts until the person's next press or key, which takes
  the hash out of the URL (ruling 523).

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

## 7. Epics

An epic is **a named body of work inside one project**, the way Jira draws an epic and
Linear a project (ruling 503). Tasks join and leave it one at a time, whoever they are
and whatever stage they stand at. An epic never creates, starts, orders or holds a task:
what a task waits on is its own `blockedBy` (ruling 131), and the release engine starts
it when that work is done, whatever epic it is in. Epics replaced ruling 99(e)'s chained
goals, which the controller defined and the server advanced link by link; §7.6 is how an
upgraded store's chains became epics.

### 7.1 The file

Canonical at `projects/<slug>/epics/epic-<n>.md` (`app/schemas/epic-file.schema.ts`),
written only by `app/server/files/epic-writer.server.ts`: a per-file lock and an atomic
write, the id minted from a directory scan under the project's epics lock
(`withEpicsLock`, `nextEpicId`), unknown frontmatter keys round-tripped. Frontmatter
(`EPIC_FRONTMATTER_KEYS` order): `id`, `title` (3 to `EPIC_TITLE_MAX` 120 characters),
`status` `planned | in_progress | paused | done | cancelled`, `color` (one of ruling 364's
twenty stage presets; a new epic takes the next hue of a fixed far-apart sequence,
`defaultEpicColor`), `leadUserId` (a project member, or null), `startDate` and
`targetDate` (`YYYY-MM-DD` or null; the target may not precede the start), `createdBy`,
`createdByLabel`, `conversationId` (the controller conversation whose turn called
`create_epic`, ruling 476(h)), `convertedFrom` (`goal-N` for an epic the conversion
made, §7.6), `createdAt`, `updatedAt`. Body: `## Description` (markdown) then
`## Timeline` of newest-first `- <UTC ISO> · <text>` history bullets. A frontmatter the
schema rejects makes the file untrusted with a diagnostic naming the field
(`diagnoseEpicFileContent`, which the store doctor and the rebuilder share), and a file
whose frontmatter id differs from its name is refused the same way.

The status is a person's call, never derived. Nothing deletes an epic: a `done` or
`cancelled` one stays readable, a done one can be reopened, and tasks can still join or
leave a closed one. `epic_projections` is the derived row (rebuilt from the file by
`rebuildEpicFile`, watched, rescanned and store-checked like every canonical file), and
every change publishes the project-routed SSE event `epic.updated`.

### 7.2 Membership

Membership lives on the TASK: `task.md` carries `epic` (an epic id, or absent),
projected to `task_projections.epic_id`, the same project-to-task shape as `stage`. A
task is in at most one epic, so joining another moves it. The epic file does not list
its tasks.

An epic's **progress** is counted from those task rows at read time
(`progressByEpic` in `app/server/projections/epic-query.server.ts`, one grouped read per
project), never stored: `total`, `done` (at the terminal stage), `started` (past the
entry stage and not done), `notStarted`, `held` (waiting on other work, counted in the
three above too), `archived` (counted apart and left out of the total, as Linear leaves a
cancelled issue out of a project's progress) and `byStage`, the bar's segments in the
project's stage order.

`setTasksEpic` (`app/server/tasks/epic-actions.server.ts`) is THE writer of a task's
`epic` after creation, and every door lands there: the task page's Epic menu
(`intent=set-task-epic`), the epic page's Add tasks and Remove, the controller's
`update_task.epic` and `update_epic`'s `addTasks` / `removeTasks`, and the operator's
`set_epic`. It checks every key before it writes anything (a missing task is a 404, an
archived one is refused: its planning metadata is frozen), leaves a task already where it
was asked to be as unchanged, and re-reads each task under its own lock so a concurrent
move wins. A removal from one epic (the epic page's Remove, `update_epic`'s
`removeTasks`) names that epic as `fromEpicId`, so a stale page never takes a task out of
the epic it has since moved to: a task not in it is refused and nothing is written. Its
checks run on their own as `planTasksEpic`, which `update_epic` calls for its task keys
before it writes the epic's fields, so a call lands whole or not at all. Each move writes an "Epic" note on the task's timeline ("Added to **epic-3**
(Checkout redesign).", "Moved from … to …", "Removed from …"), a `task.epic.changed`
audit row `{from, to, title}`, and, once per epic touched however many tasks moved, one
line on that epic's history ("<who> added WEB-3 and WEB-4 and moved WEB-5 here from
epic-2.") and an `epic` notice to its lead.

A task can also be born in an epic: `createTask` takes `epic`, checked before a key is
allocated (`requireEpicForNewTask`), and writes the same "Epic" note, with the epic in
the `task.created` row's details. The epic's history says "<who> made WEB-7 in this
epic." and its lead is told, as for a task added later (`noteTaskMadeInEpic`); the
conversion's own tasks are named by its line on the epic instead. The board's New task
dialog, the epic page's New task and the controller's `create_task` pass it, and a task
a person creates from an operator's `create_task` option joins the deciding task's
epic.

### 7.3 Authority, notices and the all-done line

- `manage-epics` ("Create & edit epics": admin, maintainer, contributor) gates
  `createEpic` and `updateEpic`, which change what the epic is (name, description,
  status, colour, lead, dates). An archived project refuses both (R6-3).
- Moving a task in or out is the task's own planning metadata, like a label:
  `edit-task-meta` (the same three roles). The operator's `set_epic` moves its own task
  only, under the in-process authority and the `append-typed-events` grant its other
  typed writes use (`operatorSetEpic`).
- Audit: `epic.created {title, status, total}`, `epic.updated {title, summary, status?}`
  (the summary is the sentence of what changed, "renamed it from … to … and set the
  status to Done"), `task.epic.changed`. The project's Activity audit column writes one
  sentence per row (`activity-feed.server.ts`).
- **Notices** (kind `epic`, the profile's "Epic updates" category) go to the epic's
  lead, or to its creator while nobody leads it, and never to the person whose act they
  report: a task joining (made in it included), leaving or moving; being made the lead
  (at creation or by an edit); someone else changing the status. They fail open: the
  change has landed.
- **All done.** When the last open task of an OPEN epic is done (it reached the terminal
  stage, or the one still open left the epic or was archived), `noteEpicCompleteIfDone`
  writes "Every task is done (N tasks)." on the epic's history once and tells the lead
  "Set the epic to Done once the work has landed." The hooks are the task write paths
  that used to reconcile a chain: a stage transition, acceptance, archiving a task that
  was still open, and an open task leaving (`maybeNoteEpicComplete`, fire-and-forget).
  A done task archived or taken out, and a restore, complete nothing new, so they say
  nothing: the line would repeat with a smaller count. The status stays the person's:
  "every task I filed is done" and "the work has landed" are different claims.

The release engine kept the minute tick the goal runner gave it (ruling 131(e),
`startDependencyRunner`), so a hand edit the hooks never saw still releases within a
minute.

### 7.4 Where a person meets an epic

- **The rail** lists Epics second, after Board (`nav.ts`).
- **`/projects/:slug/epics`** (`project.epics.tsx`, `EpicsPage`): Open (the default),
  Closed and All; each row its colour dot and name, its status pill, the progress bar
  in the project's stage colours (the Home card's meter) with "N of M done", its lead and
  its target date. New epic (for `manage-epics`) opens the epic dialog: name, description,
  status, lead, start and target dates, colour; `intent=create-epic`.
- **`/projects/:slug/epics/:epicId`** (`project.epic.tsx`, `EpicPage`): the head carries
  the status select and Edit (the same dialog). About renders the description; Tasks
  has the bar and one row per task with its stage, the board card's status word (the
  same `cardStatus` the board computes, fed the review queue and live-run state, ruling
  476(g)), "waits on N" when it waits, its owner, and Remove; Add tasks offers every live
  task not in it and says which will move from another epic; New task makes one in it;
  archived tasks fold under the list. History is the file's timeline (the newest shown,
  "Show all" for the rest). Details: status, lead, dates, creator, and "Planned in
  <conversation>" for a viewer who may open that thread (its owner or an org admin,
  `canAccessConversation`). Intents: `update-epic`, `add-tasks`, `remove-task`,
  `create-task`, each gated inside its writer.
- **The task page** names the epic in its hero, a chip linking to the epic page
  (`EpicChip`), and in the Details panel's Epic row, a menu of the open epics with "No
  epic" first.
- **The board** has an epic filter (`?epic=<id>` or `none`; Clear resets it, the empty
  copy names it) and the New task dialog an Epic select that starts on the filtered
  epic. Cards and list rows draw no epic: ruling 172 keeps planning metadata off them, as
  it kept the goal link off.

Both epic routes read the project's domain and run facts (ruling 457), which
`epic.updated` and every task event move.

### 7.5 The agents' epic tools

- **Controller** (§4): `list_epics` (each with status, lead, dates and progress),
  `get_epic` (the epic in full: its tasks with stage, readiness, owner and waits, its
  progress by stage and its history), `create_epic` (`tasks` puts existing tasks in as it
  is created; the conversation is recorded) and `update_epic` (every field, `addTasks`,
  `removeTasks`; a key not in the epic refuses the removal before anything is written;
  no delete). `list_tasks` names each task's `epic` and filters by `epicId` (`none` for
  the tasks in no epic), `get_task` names it, `create_task` and `update_task` take
  `epic` (`""` takes the task out), and `get_project` summarises the epics. The board
  context read lists the open epics with their progress (`BOARD_CONTEXT_EPICS` 20) and a
  task-anchored one names the task's epic.
- **Operator** ([operator.md §4](operator.md)): the snapshot carries `epic` (the epic
  this task is in, its description clipped, and its OTHER tasks with their stage and
  `blockedBy`; it replaced ruling 402's `goalChain`) and `openEpics`, the ones `set_epic`
  can put the task in. A Codex operator reaches `set_epic` through the plan schema's
  `epicId` argument.

**A task's done signal is one it can show before acceptance** (ruling 492). Acceptance
moves a task to Done and nothing after it happens inside the task; a person's acceptance
also merges the PR when GitHub can, and a full-autonomy operator's leaves the merge to a
person ([task-lifecycle.md §11](task-lifecycle.md#11-acceptance-and-the-endings)). So
planned work whose outcome needs a proof only the merged or deployed code can show (a
production deploy, a cron run on the merged code, a live page, a production log) is two
tasks, in the same epic when it has one: the delivery task, whose done signal is its
gates, its reviewers' verdicts or a measurement made on the branch, and a read task whose
`blockedBy` names it. The release engine starts the read task when the delivery task
reaches Done, which can be before the merge and before the deploy, so the read task's goal
confirms the change is merged and deployed before it reads. The controller's two goal
doors (`create_task.goal` and `update_task.goal`) carry the rule in the goal field's
description, from one constant (`DONE_SIGNAL_RULE`, `app/server/tasks/done-signal.server.ts`),
and the controller guide says it under "Creating a task" and "Epics". It is guidance:
nothing refuses a goal for its words.

### 7.6 The conversion from chained goals

Boot converts every goal file once, after the rescan and before the watcher
(`convertGoalsToEpics`, `app/server/tasks/goal-epic-conversion.server.ts`); a project
that fails is logged and retried on the next boot.

- Each `goals/goal-N.md` becomes the epic with its number (goal-3 becomes epic-3, or the
  next free number when that one exists), keeping its title, description, creator,
  `conversationId` and history, with `convertedFrom: goal-N`. Its status maps: active is
  `in_progress`, or `planned` while no link had started; paused and attention are
  `paused`; completed is `done`; cancelled is `cancelled`.
- Every task that carried a link, and every task whose `goalRef` named the goal, joins
  the epic with an "Epic" note, and the retired `goalRef` key leaves it, a dangling one
  (naming a goal the project no longer has) included. A task already in an epic keeps it
  and is not written again. A `goalRef: null` line the old writer left on a task in no
  chain is an unknown key now, kept as written and read by nothing, as ruling 98 left the
  retired engagement slots.
- An unstarted link of a chain that was still running becomes a task now, in the epic,
  waiting on what the link waited on, so the release engine starts it when that work
  lands, exactly as the chain would have. It is created on the goal creator's authority,
  re-proven as the chain re-proved it (`create-task`, silent deny), with its creation
  events signed `system:epic-conversion` (`createTask`'s `signedBy`, ruling 477(b)'s
  signature kept for this one caller). Links that wait on each other are made in the
  order their waits allow. A link that cannot be made that way (a paused, stopped, done
  or cancelled chain, a creator who lost task creation, a wait on work that will never
  exist, a loop) is listed in the epic's description with its text and why, so a person
  can make it a task.
- Every stored `goal-N link M` wait, in a task's `blockedBy` and in an open decision's
  options, is respelled by the key of the task that carried the link; an entry naming a
  skipped link is dropped (the chain counted it settled), and one naming a link that
  will never have a task is dropped with a note (an option whose list it emptied keeps
  an empty list, so the option stays). A task left waiting on nothing is released when
  everything it waited on was settled, and put in front of a person (`waiting: human`)
  when something it waited on can never happen. The waits are respelled, as text,
  before any task file is parsed and written for the joins, because the task parser
  drops a wait it cannot read and a decision option holding one.
- A goal file that cannot be read is left in `goals/` and reported, and so is
  everything naming it: its tasks keep their `goalRef`, and a task whose waits or
  decision name one of its links keeps them spelled the old way, until a boot can read
  the goal.
- Notices whose link opened the goal on the Controller page (`#goal-N`, `#goal-N-link-M`)
  open the epic's page.
- The epic's history gains "Converted from goal-N (<title>) when goal chains became
  epics, holding N tasks." (plus what was made and listed), the audit gains
  `epic.converted {title, from, total}` signed by the conversion, and the goal file is
  filed under `goals/converted/`, which is what makes the conversion run once. Every
  step is idempotent (an epic is found again by its `convertedFrom`, a link's new task is
  recorded in the goal file the moment it exists), so a conversion interrupted part-way
  finishes on the next boot.

An upgraded database keeps `goal_projections` and the two retired `task_projections`
columns (`goal_id`, `goal_link_index`), which nothing reads or writes.

## 8. Identifiers this subsystem emits

- Audit actions: `controller.authority.denied`, `controller.ops.read`,
  `controller.repo.read`, `controller.github.read`,
  `controller.resource_grant.requested|granted|declined`, `org.controller.updated`,
  `epic.created`, `epic.updated`, `task.epic.changed` and, once per converted goal,
  `epic.converted` (§7), plus `task.agent.commented` with label `controller` and every
  downstream row under `<email> · via controller`. The `goal.created`, `goal.updated`
  and `goal.completed` rows an upgraded store holds still read in the Activity column.
- Notification kind: `epic` (§7.3), addressed to the epic's lead or, while nobody leads
  it, its creator; its profile category is `epics` ("Epic updates", default on). The
  `controller` kind, written only for goal-chain progress, has no writer since ruling
  503; the rows an upgraded inbox holds still read and answer to the `epics` toggle, and
  a person who had silenced the old `controller` category keeps `epics` silenced. A
  conversation reply is not a notification: the unseen-reply dot (§3) is its signal.
- SSE: `controller.updated {conversationId, userId}` (owner-routed),
  `controller.log-appended {conversationId, userId, runId, threadId, seq}` (owner-routed,
  one per stored console line of a controller run; a stream event, tailed by the console
  and ignored by `useLiveUpdates`),
  `epic.updated {projectSlug, epicId}` (project-routed; a task joining or leaving an
  epic is that task's own `task.updated`).
- Timeline: `comment` events authored by `controller` with the trailer
  `_Posted by the controller for <name>._`.

## 9. Known drift (recorded, not fixed here)

- Ruling 108's note that the panel "skips the P13-KM-01 display-name repair" under a
  lock is stale wording: the panel runs the repair for display and posts blank for
  locked sections; the byte-for-byte outcome holds through the server.
- `read_store_doc`'s not-found sentence says "Viberr has no tool that returns repository
  file contents"; `read_default_branch_file` (ruling 299) is one
  (`controller-ops-mcp.server.ts`).
