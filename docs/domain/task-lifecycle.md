# Task lifecycle

> How a task is born, moves, waits, gets reviewed, is delivered and is closed, and which
> server invariants hold at each step. Source of truth:
> the task-action modules (`app/server/tasks/task-action-core.server.ts` and the families
> beside it, ruling 654), `app/server/tasks/task-mutation.server.ts`,
> `app/server/tasks/dependencies.server.ts`, `app/server/tasks/schedule.server.ts`,
> `app/server/tasks/required-reviewers.server.ts`, `app/server/tasks/task-closure.server.ts`,
> `app/server/tasks/file-leases.server.ts`, `app/server/projections/review-queue.server.ts`,
> `app/schemas/task-file.schema.ts`, `app/shared/workflow/*`, `app/shared/rbac.ts`,
> `app/shared/dependencies.ts`, `app/shared/task-refs.ts`, `app/shared/file-leases.ts`.
> File fields are in [file-formats.md](../architecture/file-formats.md).
> Verified against `main` @ `7d9fbf72` (2026-09-23).

## 1. The shape of every governed mutation

Every write to a task lives in `app/server/tasks/*.server.ts` and follows one order:

```
loadProjectContext(ctx, slug)                      # stages, workflow, members, archived, from project.md
requireAction(db, project, actor, "<rbac action>") # archive freeze, then the role check
readTaskFile(...)                                  # pre-checks (fast path)
await updateTaskFile(ref, mutate)                  # per-file mutex, read-modify-write, atomic tmp+rename
reprojectTask(db, ctx, slug, key)                  # synchronous rebuild of that one file → SSE
recordAudit(db, { action, actor, ... })            # secret-free details
```

`loadProjectContext`, `reprojectTask` and `notifyTaskWatchers` live in
`task-mutation.server.ts`; `requireAction` and the owner exception live in
`task-action-core.server.ts`; `requireProjectMutable` and the authority
resolution live in `app/server/auth/project-authority.server.ts`.

Rules that follow from it:

- **Files first.** Projections are never written without file backing.
- **Archived projects are read-only** for every governed mutation
  (`requireProjectMutable`, 409 `conflict`).
- **Membership is the outer gate.** A non-member gets the unknown-slug 404 on reads
  (layout and board loaders, `readWorkspace`) and on actions (`requireVisibleProject` through `requireProjectFormAction`, called outside the try
  block so it never turns into a 403 that would confirm the project exists).
- **In-lock re-checks, not pre-checks.** The state checks outside the lock are fast
  paths; `transitionStage`, `resolvePacket` and the acceptance writers re-run the
  decision inside the lock, so two submits of one human act produce one event and
  one audit row (NFR16). An idempotent no-op still pays the gate a real write would.
- **In-process authority flags never come from a request.** `operatorAuthorized`,
  `recommendationAuthorized` and `rework` are set only by server code.
- **A hard-stop file is never written.** A `task.md` that parsed only with fallback
  defaults is projected as `blocked` and refused for writes (`file_not_trusted`); fix
  the file or restore it.
- **One write, one instant** (ruling 255). Every timeline event a single write adds
  carries that write's own timestamp, so the file's newest-first order is the
  arrangement the writer chose, not a race between clock reads.

## 2. Who may do what

`app/shared/rbac.ts` is the one table both the guards and the Policy page read.
Roles are a strict tier: `viewer ⊂ contributor ⊂ maintainer ⊂ admin`.

| Action id | admin | maintainer | contributor | viewer |
|---|---|---|---|---|
| `view`, `comment` | ✓ | ✓ | ✓ | ✓ |
| `create-task`, `own-task`, `edit-task-meta`, `attach-file`, `manage-epics` | ✓ | ✓ | ✓ | |
| `approve-transition`, `resolve-packet`, `accept-completion`, `update-goal`, `run-agents`, `reorder-board`, `reconcile-github`, `grant-github-scope`, `rescan-project` | ✓ | ✓ | | |
| `release-any-ownership`, `manage-members`, `manage-agents`, `delete-controller-conversations`, `edit-policy`, `remove-from-record`, `force-accept-completion` | ✓ | | | |

Two grants gate more than their labels name, and each definition carries a `covers`
line saying so (ruling 309(a)): `edit-task-meta` also gates what a task waits on
(`setTaskDependencies`, which releases a held task when the list is cleared) and which
epic it is in (`setTasksEpic`, ruling 503), and
`edit-policy` also gates archiving and restoring the project itself. `update-goal` gates
the task title as well as its goal (§3). `app/shared/rbac.test.ts` fails when this table
and `RBAC_DEFINITIONS` disagree.

Three deliberate short-circuits, each re-asserting the archive freeze first: the live
task **owner** (contributor or above) may accept their own task and govern any open
decision on it (packets and recommendations, including transition recommendations
their role could not authorize from the stage menu); the loosest gate
`requireAnyMember` covers idempotent paths; and an **org admin** passes any project
gate as an audited emergency override (`project.org_admin.override`, deduped per
minute). Denials are audited as `project.authority.denied`.

## 3. Creation

`createTask` (`create-task`; the `create-task` intent on the board and on an epic's page,
the controller's `create_task`, a packet's `create_task` option, the goal-to-epic
conversion) refuses any
stage but the **entry stage** (ruling 70), and a title under 3 characters. It allocates
the key from `project.md` `nextTaskNumber` under the project mutex, writes `task.md`
with `readiness: input_required`, `waiting: human`, the goal (or the placeholder "Goal
to be refined at the triage quality gate."), optional `priority | labels | dueDate`,
optional `epic` (ruling 503: the epic it is born in, with an "Epic" note; a task made
from an operator's `create_task` option joins the deciding task's epic), then
auto-invokes the operator with the `create` trigger. Every check that can refuse
(priority, due date, named owner, dependencies, the epic) runs before the key is
allocated, so a refused creation burns no counter value.

**Creation seats the creator as owner** (ruling 127), or the member named at creation
(ruling 140(a): `CreateTaskInput.ownerUserId`, the controller's `create_task` `owner`).
A named owner is checked by the hand-off rule `requireOwnable` that `setOwner` shares
and seated in the same `task.md` write, before the operator's `create` trigger, so the
first triage run bills the named owner and is refused honestly when they have no
credential. The seat is written with the same `assign` timeline event a take through
`setOwner` writes ("Took task ownership by creating the task …" or "Seated <name> as
owner at creation …"). A creation an automation makes on a person's authority signs
that event, and its "Waits on other work" and "Epic" notes, itself (`signedBy`, ruling
477(b)), so Activity does not credit the person with the automation's act: the one
caller is the goal-to-epic conversion (`system:epic-conversion`, "Made for link M of
goal-N (<title>) when goal chains became epics, on <creator>'s authority, …"; ruling
503). Tasks a goal chain started before that carry `system:goal-chain`. `task.created` details carry `ownerUserId` and `seat:
creator | named | none`; a named owner who is not the creator is notified (§7). The
reason is the credential principal: every agent run on a task bills the OWNER's own
Claude and Codex accounts, so a task born unowned could not run the operator it was
about to invoke. A task created by the OPERATOR itself (`OPERATOR_TASK_ACTOR`, or an
operator-authorized context) keeps a null seat, refuses a named owner, and has to be
taken by a human before agents can run on it. A controller-driven creation IS a human
creation: the asker is the actor and gets the seat; the controller refuses its release
word `none` as an owner at creation.

Priority is `low | normal | high | urgent` (`urgent` also sets the legacy boolean the
board highlights), labels are at most 12 of 32 characters (`MAX_TASK_LABELS`,
`MAX_LABEL_LENGTH`), due date is a plain `YYYY-MM-DD`. `edit-task-meta` grooms these
later without touching any gate, one property at a time from the task page's Details
panel: each edit writes only the axis its form carries, so it never overwrites another
(ruling 501). The title is edited through `updateTaskTitle`, gated on
`update-goal` (ruling 295): at most 200 characters (`TASK_TITLE_MAX_CHARS`), an
unchanged title writes nothing, and a rename writes a "Title updated" note naming the old
and new titles (the key does not change) and a `task.title.updated` audit row.

The **triage quality gate is behavioral** (ruling 89): the operator flags an
underspecified goal with an `input` packet at triage; there is no mechanical block on
moving a task past an open packet. `input_required` set at creation clears when the
task leaves the entry stage.

**Waiting on other work at birth** (ruling 131(c)): `createTask` accepts `blockedBy`
(task keys in the same project, validated by `validateDependencyRefs`).
The task is written with the list, `waiting: none`, a "Waits on other work" note
("Created waiting on … Held until every entry is done; Viberr releases it then."), and
its stored readiness at the birth value `input_required`; the `blocked` it shows is the
derived floor. When every entry is already done the note says so instead ("Created after
the work it waits on was done …, so nothing holds it; Viberr releases the list at
once."), and `createTask` keeps that promise before it returns: it releases the task
through the engine as a release at birth (`releaseTask(…, { atBirth: true })`, F39-65,
L02-1), before anything awaits, so the dependency runner's tick cannot release it first
as an ordinary hold. The list is cleared, the "Dependencies released" note reads
"Released: everything this task waits on was done before it was created (…), so nothing
held it.", the `task.dependencies.released` audit row carries `atBirth: true`, and
nobody is told the task "can move again". The release's `dependencies-released` turn,
whose payload carries `atBirth`, is the task's first operator turn in place of `create`,
and the creation does not wait for that run to start. The controller's `create_task`,
the goal-to-epic conversion (an unstarted link's declared wait, respelled by task key)
and a packet's `create_task` option all come in through this door.

## 4. Stages and the workflow graph

Stages are per project. Nothing hard-codes `triage`/`done`; `resolveStageRoles`
derives `entry` (first), `terminal` (last), `review` (the stage with an edge into
terminal) and `work` (the stage with an edge into review). `workflow` is a chain over
the stage order, one rule per consecutive pair, maintained by the stage editor
(`spliceStageIntoChain`, `rejoinChainAroundStage`, `realignChainToStages`): adding a
stage inherits the replaced edge's boundary, removing one merges neighbours with the
**stricter** boundary, a rule into terminal is always `human` and `locked`.

The Standard template (`governed-5`): `Triage → Ready → In Progress → Review → Done` with
boundaries `auto, auto, auto, human`. The operator moves the task into Review itself
when the work is ready, and a person's one gate is acceptance (ruling 519). The move into
Review was an `approval` before; at boot, `convertTemplateReviewEntry` turns a board
that still carries the template's old approval edge (its `by` words unchanged since
creation, on a board that is not strict) into the template's `auto` edge, once, with a
`project.policy.boundary_changed` audit row by the system. Project creation offers three
policy presets that shape the graph and the operator deployment (`presetWorkflow`,
`presetAgents` in `app/features/home/project-create.server.ts`): **`strict`** (every
`auto` short of the last stage becomes `approval`, the move into Review included;
operator supervised, `deliver-review-pr` set to `recommend`), **`balanced`** (the
template as is), **`auto`** ("Autonomous within policy": operator at `full`, with an
explicit `completion-for-acceptance: direct` grant). The preset is not stored; its
effect is readable off the graph (`humanGatesPreWorkAdvance`, ruling 28).

Agent stage eligibility resolves in three steps (`stageEligible`): a literal id on
this board; else the structural role the declared id names (`todo`, `backlog` →
entry; `impl`, `doing`, `wip` → work; `review`, `qa`, `verify` → review; …); else a
declaration that names nothing on this board is treated as unrestricted. Eligibility
decides where a profile may be NEWLY engaged; the task's engaged deliverer acts at any
stage (ruling 133), so rework routing is a workflow choice, never a way around a
profile's stages.

## 5. Transitions

`transitionStage(db, input, actor, ctx)`, in order:

1. Same stage → idempotent return, after the same archive freeze and
   `approve-transition` gate a real move pays (F32-10). Unknown target → validation
   error.
2. Archived task → 409 (an archived card cannot be dragged column to column).
3. A move with no declared edge, not `manual` and not an operator rework move is refused
   "No allowed transition from X to Y." A backward refusal says why and names the way
   forward (ruling 412): a `changed` revision licenses only the move into the stage
   where its re-verdict can be given (or says the re-verdict is given where the task
   already stands), a task with neither a `failing` verdict nor a `changed` revision has
   no rework move at all, and the engaged deliverer runs at every stage (ruling 133), so
   it can be dispatched where the task stands.
4. A **human moving a task into the terminal stage is accepting completion**: the call
   routes through `acceptCompletion` (real merge attempt, `completion` event, packet
   and recommendations cleared), never a bare move. The board drop and the keyboard
   Move menu raise the same confirmation as the task page (ruling 53).
5. Authority: `manual` (board menu, any stage) → `approve-transition`; an `auto`
   boundary → any member; `approval` → `approve-transition`; `human` →
   `requireAcceptCompletion`. An applied recommendation arrives with the human's
   `recommendationAuthorized`, which replaces the role check (the archive freeze still
   applies). A **manual backward** move needs a `reason` (ruling 381), checked after the
   authority gate: "Moving KEY back from X to Y needs a reason …". The stage menu, the
   drag and the keyboard move open a confirm that asks for it, an applied recommendation
   passes the card's own words, and a forward move asks nothing. The reason is quoted
   under the `transition` event and stored as `reason` on the audit row. The operator's
   own move quotes the reason it gave the same way (ruling 519), so the move into Review
   it makes by itself says why on the task's history.
   Operator authority skips human RBAC but is forbidden a bare move to terminal, and
   (ruling 151) every declared `approval` or `human` boundary whatever its grant says:
   "The Review to Merge boundary is approved by a human on this board: the operator may
   recommend it, not cross it." The operator crosses `auto` boundaries and backward
   rework moves while validation is `failing`, and (ruling 163) the one backward move a
   `changed` revision licenses: into the stage where the reviewers who still owe a
   verdict on the current revision can run (`verdictStageFor`, ruling 208: null when one
   of them is eligible where the task stands, else the nearest earlier stage where one
   is; the acceptance-boundary stage when no verdict-capable profile is deployed), so a
   revision that moved after a verdict goes back for its re-verdict instead of waiting
   at Merge. The operator's move INTO the acceptance-boundary stage is refused with the
   acceptance gate's own sentence while the review PR conflicts with the base or lacks
   the delivered revision (`mergeReadinessRefusal`, ruling 162: Merge means mergeable).
6. Inside the file lock the stage is re-read: already there → write nothing; moved
   elsewhere → 409, because every guard above judged `fromStageId`.
7. On success: `previousStageId = fromStageId` (the durable "came back from Review"
   fact the operator weighs, ruling 98); `heldAtStage` (the operator's recorded
   deliberate hold) is cleared; terminal → `waiting = none`; leaving the entry stage
   attaches the operator and lifts a stored `input_required` to `ready`; entering the
   review stage re-derives `validation`. Pending `transition` recommendations are
   dropped, and a move away from the acceptance boundary withdraws the standing
   acceptance offers (§9); the `transition` event is written first, so the
   "Recommendation withdrawn" note lands above it (ruling 387). Then the
   `task.transition` audit row (`from`, `to`, `boundary`, `manual`, `reason`, `by:
   operator`), and the operator is re-triggered (`transition`) unless the move was made
   by a live operator run, whose own turn continues (ruling 152(a)); a human or system
   move onto the acceptance boundary first files the acceptance recommendation under the
   deployed operator's gate and skips the re-trigger when the card was filed (the fold,
   owner decision Q35-15). Consecutive operator-authored moves carry a depth; at
   `OPERATOR_TRANSITION_CHAIN_CAP` (8) the chain stops and a stuck-loop packet opens
   instead. The task's epic is checked for being all done (`maybeNoteEpicComplete`,
   ruling 503), held dependents are swept (`maybeReleaseDependents`, ruling 131(e)), and
   entering the review stage with no live PR writes a "Review reached
   with no PR yet" `github` event, so the gap is never silent, except on a task
   delivered as the files saved on it, where there is no PR to open (ruling 546).
   Accepting such a task records it delivered: the no-change probe skips it
   (ruling 550).

A person's own operator run (a `manual` trigger) also clears `heldAtStage`; a scheduled
run does not (ruling 216).

## 6. The three signals on a card

- **Readiness** (stored, 4 values): `ready | input_required |
  inconsistency_risk_detected | blocked`. The projection stores the derived value:
  diagnostics floor it (warning → `input_required`, error →
  `inconsistency_risk_detected`, hard stop → `blocked`); a `blocked` packet sets it to
  `blocked`; recovery options lift it back to `ready`, and a person's operator run,
  a scheduled operator run or any dispatch lifts a packet-less, list-less hold with a
  "Hold lifted" note and `task.hold.lifted` (ruling 157).
  Surfaces render a derived display value from `deriveDisplayReadiness`
  (`app/shared/mapping/task.server.ts`) rather than the stored one:
  `agent_working` while `waiting === "agent"` over a stored `ready` or `input_required`
  (ruling 91); `agent_queued` when the run carrying the task is parked behind the
  concurrent-run cap, which the loaders read off the run row through `withLiveRun`
  (ruling 349); `goal_edit_pending` while a decided `edit_goal` packet waits for the
  edited goal (ruling 138: below `agent_working`, above `input_required` and a stored
  `blocked`); `input_required` over a stored `ready` while an `input` packet waits on a
  human; and `accepted` or `merged` for terminal-stage tasks. A stored `blocked` never
  yields to a run, with one exception (ruling 157): a stored block with no open packet
  and no dependency list is a hold, and while an agent carries such a hold the display
  reads `agent_working`, exactly as the server lifts it on the record; a diagnostics
  floor (derived `blocked` over a stored `ready`), a dependency hold and an open
  `blocked` packet keep reading `blocked` (`deriveDisplayReadiness`, fourth argument
  from `stored_readiness` and the list).
- **Waiting**: `human | agent | none` in the file, plus `schedule` in the projection.
  Raising a packet or a recommendation flips it to `human`; dispatching an agent sets
  `agent`; terminal forces `none`. A refusal settles it honestly: when the operator is
  refused (an open packet, a closed task, a dependency hold), `clearWaitingToHuman`
  moves a `waiting: agent` with no live run back to `human` (ruling 195). The projection
  derives `schedule` (never written to a file, ruling 225) for a task the file says waits
  on a human but that rests on a clock: no open packet, no recommendation, nothing a
  person could accept right now, an empty `blockedBy`, not archived or terminal, and a
  pending schedule occurrence; the card then names the instant it resumes. It is a
  display flag: `liveRuns` is the only proof a run is in flight.
- **Validation** (derived cache, `deriveValidation`): `none` while the task has
  delivered nothing to review; `failing` when a required reviewer requested changes on
  the current review subject; `healthy` when every required reviewer approved it;
  `bypassed` after a force-accept; `none` for a verified no-change task with no required
  reviewer; otherwise `changed`. The review subject is `reviewSubjectId` (ruling 388):
  the active work revision, or, for a task whose deliverable is not a commit, the moment
  a delivering run that finished last saved files (`files:<deliveredAt>`; a stopped
  run's files are its work in progress, ruling 601, and so are the drafts of a run
  that ended by asking a person, ruling 609), so a report or attachment
  deliverable is reviewable like a commit and a later save stales older verdicts. The
  browser's working files alone (`page-….yml`, `console-….log`, `isBrowserWorkingArtifact`)
  never move it: they are tool transport, not a delivery (ruling 570). A run not
  dispatched to deliver moves it when it saves again a file the delivery already holds
  (`deliveredFileNames`: the names the delivering engagement's entries claim), because the
  delivered content changed under the verdicts bound to it; a file of its own moves
  nothing (ruling 587). Beside another specialist run, live or finished inside its window,
  such a run claims only the files its own words name and never one the delivery holds, since
  the window also holds the other run's files (ruling 627). A
  verdict binds only to the subject its run was dispatched on (`agent_runs.review_subject`,
  ruling 544): one returned after a newer delivery binds to nothing, and its note says what
  moved and to run the review again. Never
  hand-edit it; the projection re-derives it from `workRevision`, `deliveredAt`,
  `verdicts`, `engagements`, `noChanges` and `acceptance`. A verdict's `quality` event (and
  the bell notification carrying its title) is titled from the validation it leaves:
  "Changes requested"; "Review passed"; "Approval noted, rework still needed" only when
  another required reviewer requested changes (`failing`, naming them); "Approval noted,
  waiting on <names>" while required reviewers still owe a verdict (`changed`); otherwise
  "Approval noted" (ruling 478(g)).

**Nothing moving.** `sweepStrandedTasks` (`stranded-sweep.server.ts`, ruling 330) runs
after each schedule tick and finds a task untouched for 15 minutes
(`STRANDED_AFTER_MS`) with no packet, no pending recommendation, no queued question, no
schedule, no live or queued run and no hold that explains the quiet (re-checked against
the file). It writes a "Nothing is moving this task" note and re-invokes the operator
with the `stranded` trigger, and skips the task while that note is the newest event.
Boot recovery settles a task left `waiting: agent` with no running or queued run with a
"Left waiting on an absent agent" note and an operator re-invoke, or `waiting: human`
when the operator cannot start (`settleAbandonedWaits`, rulings 213 and 337).

**Waiting on other work** (ruling 131). A task's `blockedBy` list is written by ONE
writer, `setTaskDependencies` (`app/server/tasks/dependencies.server.ts`), whichever
door it comes through: the task page's own "Blocked by" form (intent
`set-task-dependencies`, gate `edit-task-meta`), the controller's `update_task`, the
operator's `set_dependencies` tool (in-process authority), and a packet's
`block_on_dependencies` option (ruling 230). Every write validates against the store,
names the reference and the reason when it refuses (unparseable, self, unknown,
archived, a cycle through stored and declared edges, or an added
task that is already done, which would hold nothing), writes a "Dependencies updated"
note and a `task.dependencies.updated` audit row, and settles `waiting: none` when
nothing else is pending. An emptied list clears `heldAtStage`.

While the list is non-empty the derived readiness is `blocked` and the card, list row
and task page say what it waits on and in what state: the board's neutral "blocked by …"
chip leads the state stack (its title lists every entry with its state; the readiness
pill already carries the red), the hero renders one linked chip per entry, the
Current-state row reads "Other work: …", and the Details panel shows a "Blocked by" row
whose chips each carry a remove cross (it saves the list without that entry through the
same intent; a cross that releases the task asks first) and whose editor picks from the
project's tasks and bars the ones this writer would refuse as a new entry, read ahead of
the write (`listDependencyCandidates` in `app/server/projections/dependencies.server.ts`,
ruling 548). Every hold sentence is
built by `holdEntriesSentence` and `holdRefusal` (`app/shared/dependencies.ts`;
`holdRefusalFor` on the server): pending entries first, each done entry tagged in its
own parenthesis ("JC-2 and JC-3 (done)", ruling 420), and an entry that can never
complete named as such, with no promised release (rulings 355, 356).

**A hold refuses every agent dispatch** (ruling 186). `startAgentRun` refuses a
non-empty `blockedBy` beside the closure gate and before any auto-engage, with the
`holdRefusal` sentence: the operator's and the controller's `run_agent`, the task page's
Run-an-agent control (which renders the same sentence and disables Run before the
click), an @mention resume, and a scheduled `run-agent` occurrence at fire time.
Delivery is refused the same way (ruling 240, §10), and so are a `retry_other_backend`
or `resolve_remote_collision` resolution, before anything is written: the packet stays
open (ruling 354). A `question_reviewer` answer that lands on a held task is queued in
`queuedQuestions` instead of dropped, shown in the Details panel, and put when the hold
goes away, whoever clears it (rulings 241, 261). The operator holds without a packet
(ruling 131(d)): `create`, `transition` and `scheduled` are refused at fire time
(`refused: "blocked-by"`, the refusal settling `waiting` to `none` when nothing else is
pending), the stranded backstop never nudges a held task, and every turn that does run
is given the held doctrine in place of the stage rule, which tells it `run_agent` and
`deliver_for_review` are refused. Other operator triggers are not narrowed: with
dispatch gated they cannot cause work.

A PERSON emptying the list is the release itself (ruling 131(e)): the same two halves
the engine uses (`clearDependencies`, then `announceRelease`: the "Dependencies
released" note naming who cleared it, a stored `blocked` lifted to `ready`, the hold's
`waiting: none` settled to `human`, the `task.dependencies.released` audit row, a
`dependency` notification to the owner and supervisors, and the operator re-invoked with
`dependencies-released`). The `human` is where `clearWaitingToHuman` settles any task
nothing holds, so a released task shows as someone's to move even in a project with no
operator; an operator's drive marks it `agent` when it starts. A person's edit that
leaves only done entries on the list releases it too, in the same write and through the
engine's own `releaseTask` (ruling 620): such a list can only come from taking entries
off, since an added done entry is refused. Its "Dependencies updated" note says every
entry is done, the controller's `update_task` reply says the task is released, and the
task page toasts "Released: … is done". The operator's own edit leaves that release to
the minute sweep, because the release re-invokes the operator, and its reply says so.
A wait that can NEVER complete is noticed by the same sweep, whatever killed it (a task archived
before it was done, a reference to nothing; one archived at the terminal stage is done, ruling 651): ONE "Waiting on work that cannot complete" note, one
notification, `waiting: human`, and the list left for a person to edit. A task that
already reached the terminal stage has its list cleared quietly — no note, no operator
turn. An epic holds nothing (ruling 503): a task's epic never enters its wait, and the
order of an epic's work is each task's own list.

## 7. Ownership, comments, mentions

- `owner-take` / `owner-assign` / `owner-release` (`own-task`, contributor+;
  takeover of another owner needs the acceptance tier; `release-any-ownership` is
  admin). Ownership changes are `assign` timeline events; admin releases are audited.
  Removing a member releases their tasks (`task.ownership.released_on_removal`).
  **Every seat change tells the person whose seat it is** (ruling 140(b),
  `notifyOwnerSeatChange`): the new owner on a hand-off or a creation that named them,
  the DISPLACED owner on a takeover OR on a third-party hand-off (an admin moving the
  seat between two other people tells both sides, each on its own audit key `notified` /
  `notifiedDisplaced`), the released owner on an admin release. Nobody is told about
  their own take or release, and a member removal stays silent (the person is leaving).
  The row is kind `ownership` with its own routing toggle, opens the task page and never
  enters "Waiting on you"; the audit row carries `notified` — the user id, or `skipped:
  "silenced" | "failed"` — so a silenced preference and a broken store never read the
  same, and the notifier fails open rather than failing a write that already landed.
- **The owner is who a run bills** (ruling 127). Every task run — operator, specialist,
  resume, scheduled, boot recovery, retry — resolves `resolveTaskRunPrincipal` first and
  spawns with the owner's own backend credential; the run row records them in
  `credential_user_id`. Consequences a person can see:
  - an **unowned** task refuses agent runs. Nothing is spawned: the refusal is an honest
    `error` run carrying `principalRefusalMessage` ("… need a task owner … Own the task
    (Assign me) and run the agent again. No agent process was started."), the usual
    blocked packet, and the ordinary completion effects. The task page's run controls
    are disabled with the same sentence, so the refusal is visible before the click.
  - a task whose owner has not connected THAT backend refuses the same way, naming the
    owner and pointing at their Profile → Agent accounts. `retry_other_backend` is
    offered only when the owner has the other backend connected AND the instance holds
    no dispatch hold on it for them (`ownerHasOther`, ruling 326; `operatorOpenPacket`
    refuses the option onto a held backend, ruling 273), and the Agent-logs console asks
    the same question before it renders "Retry on <other>": with the owner unconnected
    there it renders no button and says so ("<Other> isn't connected for the task owner,
    so there is no other backend to retry on"), so the packet and the console never tell
    two stories about one task.
  - a run the provider **refused** for the owner's account (a spent usage window, a
    rejected credential) is worded once, by `describeRunFailure` (ruling 130(b)): the
    `blocked` timeline event, the recovery packet and the controller's note name the
    owner, the spent window and the instant it reopens (absolute UTC) or the
    organization restriction, and the owner's own move: wait, or connect a different
    account or an API key on Profile → Agent accounts. A quota packet whose reset instant
    is known and still ahead offers and recommends `wait_for_window`, which writes a
    `run-operator` schedule for one minute after the reset (ruling 224). Nothing on the task says "fix
    the credential" or "retry on the other backend" unless that backend can actually run
    now, and the resolved decision restates the option the human chose, never a "policy /
    credential updated" nobody performed (ruling 130(c)). Packets that share one account
    failure (`packet.cause` `backend:<backend>:<kind>:<credentialUserId>`) resolve
    together: answering one answers its siblings with the same option kind
    (`packet-fanout.server.ts`, ruling 319). A person's answer to a quota packet whose
    window is known stands until that window reopens (ruling 602): a later refusal of
    the same account in the same window opens its packet and is answered from that
    decision at once, with a note naming where it came from. Only waiting, retrying on
    the other backend and holding may stand; an answer that re-runs the agent on the
    refused account would answer its own next refusal, in a loop.
  - a run the provider could not serve (`overloaded`: the provider busy or failing on its
    own side, or, ruling 212, this deployment's network path) recommends the same-backend
    retry and lists it first ("Retry @agent on <backend> now: … nothing was changed"). The
    other backend stays offered when the owner has it, not recommended: it changes the
    agent's model for the rest of the task to save a wait of minutes (ruling 660).
  - a run the instance's **spending cap** cut off (ruling 175, Claude only) is a cut-off,
    not a failure, like the turn cap: the `blocked` event reads "the Claude run reached the
    instance's spending cap of $X after spending $Y and was CUT OFF mid-work, which is not a
    task failure", says nothing about undelivered changes, and ends with the remedy
    `describeRunFailure` words for it: re-run it to continue from its session, or have an
    org admin raise the cap in Instance settings (Max spend per Claude run). The packet's
    options are the ones a turn-cap cut-off gets (redirect for a specialist; re-run,
    redirect or hold for the operator), never another backend.
  - a **hand-off changes whose account pays** from the next run on. An in-flight run
    keeps the principal it started with (the column is per run), and a resume after a
    hand-off looks for the provider session in the NEW owner's home, finds none, and
    takes the continuity-reset path with a `continuity` timeline event
    ([agents-and-runtime.md §3.6](agents-and-runtime.md#36-resume-continuity-export)).
- `appendComment` (any member) writes a `comment` event, applies mention routing and
  fans out `mention` notifications, each quoting the recipient's own mention rather than
  the opening of the comment (ruling 233). **Mentions stay inside the project** (F33-9):
  the picker offers project members only, and a handle that resolves to exactly one real
  user who is NOT a member notifies nobody and is reported to the author as a visible
  non-delivery, beside the ambiguity note. `@operator` queues an operator turn carrying
  the comment as its steer; `@<agent name>`, `@claude` or `@codex` resumes that agent's
  session (auto-engaging a deployed but unengaged agent, ruling 98) and the reply
  posts back as a comment tagging the human. Mentions use one grammar shared by the
  composer and the server (`app/ui/mention-spans.ts`). The resume door is stage-gated
  like every other door (ruling 133): the engaged deliverer resumes at any stage; a
  supporting or released agent at a stage its profile does not declare gets the comment
  posted and the run refused with the dispatcher's sentence, which names stages by
  their board names. **A refused mention leaves a trace** (F35-5): whenever the
  mentioned agent's run does not start (stage ineligibility, a run already in flight, a
  dependency hold, an owner without the backend), the comment stays on the record and
  the server writes a `note`
  titled "Mention not started" ("**Not started:** @Architecture Reviewer was mentioned,
  but its run did not start: Architecture Reviewer is not eligible for the Triage stage;
  its profile is scoped to Design, Review. ... The comment stays on the record.") plus
  `task.comment.unrouted {profileId, reason: "run-not-started", detail}`; the toast
  carries the same reason. A packet decision the server relays through the same door
  reports to its resolver instead. A mention refused only because that agent's run was
  already in flight is delivered when the run completes: `deliverDeferredMention`
  gathers every human comment addressed to the agent since the busy run started into one
  directive, and a second failure writes no second note (rulings 203, 205).
- **Review notes are comments to the deliverer** (ruling 484,
  `review-notes.server.ts`). Two doors write the same comment through `commentToAgent`:
  the task page's Changes panel (`review-notes`: a person's notes on the delivered
  revision's patches, each on one line or on a range of one hunk's lines, ruling 509)
  and the reconciler's review relay (a project member's GitHub
  review of the delivered head, posted as that member, audit label `· via GitHub`,
  [github-delivery.md §6](github-delivery.md#6-reconciliation-and-freshness)). It opens
  `@<deliverer handle> Review notes on \`<sha7>\` (PR #N):` (the relay adds "from
  GitHub (a review by <login>)") and lists one note per item as `` `path:line` ``
  (`path:start-end` for a range, "(removed line)" or "(removed lines)" for the old
  file's, both ends for a range from a removed line to an added one, `` `path` (removed
  line 4 to line 7) ``, a bare `` `path` `` for a whole file, "Requested changes" for a
  review's own body). Every
  other `@` in a note is escaped, so the deliverer is the one addressee and a note
  cannot reroute it to the operator or notify a GitHub login. The deliverer resumes on it
  exactly as on a typed mention, under the same role gate: a contributor's notes post and
  start nothing, and the toast says so.
- **A task takes the files it works from** (ruling 557, `takeFromTask`). The operator's
  `take_from_task` copies named attachments of another task of the project, open or Done
  but never archived, onto its own task under a relay's header (so completion credits no
  run with them), and the source records "Taken by <task>: …". It is how a task gets the
  input a task it waited on made, once that task has closed and its operator runs no more.
  The source's line is written last and never fails the take (or a relay): the files, their
  claim and the audit row are already down.
- **Work on one task reaches another task of the same project** (ruling 488,
  `task-relay.server.ts`). The operator's `relay_to_task` and a specialist's `relay`
  entries (posted at completion, at most two per report) both go through `relayToTask`.
  On the TARGET it writes a `comment` by the relaying actor (the operator, or the agent's
  own ref), headed `**From <source> (<operator | agent name>):**` above the text, marked
  `toAgent` so compaction keeps the hand-off; @mentions in the text notify as on any
  comment; the audit row is `task.relayed {from, to}` on the target; and the target's
  operator is woken with the `relayed` trigger, the way an `@operator` comment wakes it.
  On the SOURCE it writes one `note` by the same actor: `Relayed to <target>: <first
  line>…` (the first non-blank line without heading marks, cut at 120 characters, the
  ellipsis when more follows). That line is how the source's operator sees in its
  snapshot that the relay went out. Refused with nothing written: an empty text, the
  source itself, a key that is not a task here (`noop`), a task of another project
  (`denied`, naming the project), a closed target, Done or archived (`noop` with the
  closure sentence, ruling 177: its operator starts no run, so a relay would reach
  nobody; reopening it is a person's stage move), and an archived project. There is no
  length cap, as there is none on a comment, and no operator guardrail applies: the
  meaningful-comment drop and the evidence trim would cut exactly what a relay carries.
  A specialist entry past the cap, refused by the door, or from a profile no longer
  deployed is named in one `note` titled "Not relayed" on the source task.
- A comment written by the operator or an agent starts no run for an agent it tags; it is
  stamped with the handles that will read nothing (rulings 214, 262). A directive the
  operator writes to an agent (`audience: "agent"`) notifies no person named inside it
  (ruling 232).
- Comment bodies are escaped so that a line that would read as file structure
  (`## `, `### `, `title:`, `to:`, `evidence:`) cannot forge a section or an event. A
  long body whose line breaks arrived as literal `\n` is repaired before the other
  guardrails run (`repairDoubledNewlines`, ruling 383).
- `attach-file` (contributor+, ruling 379) uploads a file into the task's attachments
  (`writeTaskAttachment`): a file of any kind (ruling 574); names that traverse or start
  with a dot, files over 10 MB (`MAX_UPLOAD_BYTES`) and archived tasks are refused; an accepted upload writes a
  timeline note that claims the file for the uploader (`attachments:`) and an audit row.
- `remove-from-record` (admin, ruling 582) takes a file off a task's record:
  `removeTaskAttachment` deletes the file, takes its name off every entry that claimed it
  and writes an "Attachment removed" note (audit `task.attachment.removed`, with the name,
  the size and the reason). An archived task allows it; an archived project does not.
- The operator edits or deletes a comment it or an agent wrote on its task (ruling 584,
  `edit_comment`), itself and without a word on the task or in an inbox: an edit replaces
  the words, a delete takes the entry off, and the notifications that link to it follow.
  Audit `task.comment.edited` or `task.comment.deleted` keeps the time, the author and the
  reason. A person's comment is theirs. An agent's own run log keeps what the run wrote.
- A task can be FILED with its files (ruling 533): the New task dialog takes a picker, a
  drop and a pasted screenshot, and `createTask` checks every file before it allocates a
  key (at most 10 files and 25 MB, the upload's own rules, the `attach-file` tier) and
  writes them before the task file and the operator's `create` trigger, so triage reads
  the input. A completion never credits a run with a file a person's note claimed during
  it, so a person's upload never stamps `deliveredAt`. Nor with one a writer is still
  putting down for someone else (ruling 558): a person's upload, a relay and a take hold
  the name (`withAttachmentClaims`) from before the file lands until their claim is on the
  timeline, and a completion reads the held names after it lists the run's files and
  before it reads the timeline. The file lands with its claim or not at all: a writer
  whose claim cannot be written takes its files back up (a new file removed, a replaced
  one put back), since a file nothing claims is the next completion's to credit.

## 8. Engagements, dispatch and verdicts

`engagements[]` is written by the dispatch (ruling 98). Running a deployed but
unengaged profile engages it: **delivering** iff the task has no deliverer and the
profile holds repo-write (`execute-code-or-write-repo` granted), **supporting**
otherwise. At most one engagement delivers; it owns the workspace, branch and PR.
A supporting engagement snapshotted with `verdictCapable: true` (an explicit
`report-validation-verdict` grant at engage time) is a **required reviewer**.
A project can also declare required reviewers **per review stage** in `project.md`
(ruling 178: `requiredReviewers: [{stageId, profileId}]`, edited on Settings → Required
reviewers or through the controller's `set_required_reviewers`, read on Policy): such a
reviewer is required on every task whether or not the operator engaged it, so a task
whose operator never ran it is not acceptable on another agent's verdict (§11 gate 4a).
The engaged set stays as it was; the project rule adds to it. The operator's `get_task`
names the rule as `requiredReviewers` and its turn prompt tells it to engage each one at
its stage. Such a reviewer cannot be made a task's deliverer: `assignSpecialist`, the one
door to `delivers: true`, refuses it by name, a dispatch with no delivery hint engages it
to review whatever its grants, and the operator's `run_agent` refuses an explicit hand-off
before any card (ruling 556), because its verdict on its own delivery would not count
(ruling 555). No reviewer's verdict binds to its own work: `reviewSubjectAuthor` names
who made the subject (the revision's `sourceProfileId`, or the agent whose event stamped
`deliveredAt`), and a verdict from it is recorded in words and binds to nothing. The
acceptance gates never wait on that review either: they take the subject's author and say
that a required reviewer made what is delivered, so another agent must deliver its own
work first. The task page's Run control says a required reviewer runs as a reviewer
before the click.

A dispatch goes through `startAgentRun`, which refuses a closed task (ruling 177) and a
held one (ruling 186, §6) before it engages anything, and holds a dispatch into a backend
already known to be out of quota for the account it bills (ruling 152(c), §9). It answers
`started`, `queued` (parked behind the concurrent-run cap) or `refused` (ruling 263), and
the timeline's dispatch line says which ("Started a <backend> run …", "Queued … Nothing is
streaming yet.", "Refused … — <refusal>", ruling 311). An interrupt kills the process
only: the workspace stays, and the next run continues from that tree (ruling 272).

`release-agent` removes a supporting engagement; a delivery hand-off routes through
`assignSpecialist`. **A closed task's seats are frozen** (F33-10): `removeReviewer`
refuses on a terminal or archived task and both panels withhold the ✕. Ruling 118 froze
the owner seat there; the engagement seat earns it harder, because `validation` is
derived from the required-reviewer set, and releasing the approving reviewer of a merged,
accepted task would re-derive `healthy` → `changed` on a closed task. Unlike the owner
seat, this freeze has no admin escape: an admin reassigning an owner is bookkeeping, an
admin releasing a reviewer restates history.

A delivering run's reconcile mints a **work revision** (`{id, headSha, treeSha,
branch, kind: delivered}`); a new head with a different tree mints a new revision and
stales every prior verdict, except a head reached only through Viberr's own base
refreshes, which keeps the revision and its verdicts (ruling 439,
[github-delivery.md §5](github-delivery.md#5-revisions-verdicts-and-acceptance)). A
revision is minted when the agent reports, before any push: it has **left the
workspace** only once a PR tracks the branch, an unowned PR stands on the name, or a
push stamped `pushedAt` (ruling 161). Until then a person may discard the branch
through a `discard_branch` packet, and the discard retires the revision (`kind:
discarded`, verdicts kept as history, `validation: none`); readers of "the revision
under review" go through `activeWorkRevision`, so no verdict binds to a retired head and
a re-created head mints a fresh id. A task whose deliverable is not a commit stamps
`deliveredAt` when its delivering run saves files (ruling 388), and when any other
agent's run rewrites one of the delivered files (ruling 587), in both cases only for a
run that finished: a run that stopped (an error, a Stop, a restart) posts its files
under its name and moves nothing (ruling 601). Nor does a run that ended with a question
for a person (ruling 609): the Calculator Builder's headline ask comes before the
delivered link, so what it saved is drafts, posted under its name, and its next report
once the question is answered is the delivery.

A reviewer's `report_outcome` records a **verdict** (`approve | request_changes`)
bound to the review subject (§6). A run whose workspace could not be provisioned
records no verdict (ruling 248). The reason is capped at 2,000 characters
(`VERDICT_REASON_MAX_CHARS`), and the full report stays on the timeline as a "Review
verdict" comment that compaction never folds (rulings 292, 317). The standing verdicts
ride whole in every agent's canonical anchor (ruling 392), and so does the project's gate
record on the revision under review, each gate's outcome, time and log, with the rule
that an agent never re-runs the gates to report them (ruling 482). A project member's GitHub
approval on the PR, whose `commit_id` equals the delivered head and whose login maps
to a member through `users.github_handle`, counts as an approving verdict (ruling 68);
anything ambiguous fails closed with the reason recorded.

**Review rounds and the deadlock.** A repeated `request_changes` by the same reviewer
on the same subject counts a new round only when the delivering agent has run since the
previous verdict, and a deliverer run the provider refused does not count
(`deliveredRoundSince`, rulings 242 and 416). On the third consecutive objection
(`REVIEW_DEADLOCK_ROUNDS = 3`, ruling 410; the second is the operator's to handle by
asking the reviewer for its complete blocking set) the policy engine opens a deadlock
packet inside the verdict's own write (`task.review.deadlock`, ruling 237) whose options
include `question_reviewer`, which dispatches the reviewer with its verdict withheld
(`withholdVerdict`, ruling 313). The deliverer never gets the channel: a verdict from
a run dispatched to deliver is discarded and its reply stamps the delivery (ruling 555).
Only such a run stamps it: a review run whose profile was handed delivery while it
worked keeps its captures as evidence.
A completeness question the operator asks through
`run_agent`'s `completeness: true` is recorded as the answer the next verdict gives
(ruling 421). An escalation skipped because another packet was open is retried when that
packet goes away (`retryReviewDeadlockEscalation`, ruling 328).

## 9. Packets, recommendations, schedules

- One open **decision packet** per task (see [operator.md §6](operator.md#6-decision-packets)
  for the kinds and their effects). Resolvers: the owner, `resolve-packet` holders,
  and for `accept_completion` the acceptance tier.
  **A decision joins the task's contract** (rulings 189, 284, 329): choosing a structured
  option appends "**Decision: <date>, <name> answered "<title>":**" and the option's
  title and detail, joined by a colon (ruling 571), to the goal in the same locked write,
  so every fresh run re-anchors on the human's answer. The exceptions are
  `PROCESS_ONLY_OPTION_KINDS` (the recovery and process kinds) and the resolutions that
  end the task (`accept_completion`, `force_accept`). A typed free-text directive never
  amends the goal: it is written verbatim to the timeline and reaches the operator in the
  re-queue's note. Notes and directives share one limit, `PACKET_NOTE_MAX` (4,000
  characters); a longer one is refused and nothing is recorded (ruling 315).
  An answer that names another deployed agent or the operator goes to the operator with
  the `packet-resolved` trigger rather than back to the agent that asked
  (`answerNamesAnotherActor`, ruling 447), and so does one for an asker that cannot run
  on the task now, such as a mapping agent whose question was answered after the task
  moved on to Estimate (ruling 562). An asker still running when its question is
  answered is not one of those: the answer waits for that run, a note says so, and the
  run's completion starts the asker on it (ruling 565).
- `edit_goal` is the only kind that keeps its packet open until the goal is saved; the
  confirm stamps `decided` beside `awaiting`, so the card, the hero, the queue and the
  rail all read the packet as decided after a reload, and the editor prefill is
  `goalDraftForOption` (the option's `goalDraft`, else its title and detail) on both the
  confirm and the reload path (ruling 138). The mapping composes it once as
  `packet.goalDraft` (F35-6): the decided card prints it under the decision line as
  "Requested goal (opens in the editor)", its "Edit the goal" opens it, and the hero's
  own Edit under the goal seeds it too while the packet waits. Saving the goal UNCHANGED
  while the packet awaits the edit is refused ("The goal reads exactly as before, so the
  requested edit has not landed. …"); an unchanged save with no packet writes nothing and
  the route toasts "Goal unchanged". A `goalDraft` or a new task's goal over 4,000
  characters (`GOAL_DRAFT_MAX_CHARS`) is refused at authoring, never cut (ruling 288).
- Other kinds this page's flows rely on: `move_stage` performs a manual board move on the
  stage picker's path (`transitionStage({ manual: true })`, `approve-transition`); the
  terminal stage is refused there, because a move to it is the acceptance contract, not
  a move, and resolving it lifts a stored `blocked` the packet was holding down, as every
  other resolution arm does. `block_on_dependencies` writes its `blockedBy` through
  `setTaskDependencies` (ruling 230). `create_task` creates a task through `createTask`
  under the resolving person's authority, leaves this task's goal alone, writes a "Task
  created from a decision" note naming the new key, and can add the new key to existing
  tasks' `blockedBy` (`newTask.blocks`, ruling 287); the card lists open tasks with
  similar titles before the confirm (ruling 324). `force_accept` is the admin override
  (§11 gate 4). `wait_for_window` closes the packet and schedules an operator run for one
  minute after the reopen instant (ruling 224).
  `accept_unverified_head` waives the head check for one head (§11 gate 5).
- A resolved `hold_runtime_debug` leaves a packet-less hold that the next person-started
  operator run or any dispatch lifts (ruling 157). A **stalled** packet (the operator's
  stuck-loop packets, stamped `stalled: true`) is withdrawn by the next successful run;
  no other packet is (`withdrawSupersededStuckPacket`, ruling 432).
- **Recommendations** are the supervised operator's pending cards (`transition`,
  `run_agent`, `accept_completion`, `delivery`). `applyRecommendation` passes
  `recommendationAuthorized` into the inner mutation, whose own capability gate still
  applies; the owner may apply or dismiss any card on their own task. Any stage move
  prunes pending transition cards; acceptance consumes every card. An `accept_completion`
  card opens with what the record holds (`acceptanceOfferBasis`: who approved, or "No
  review verdict is recorded on this task …", ruling 384), is bound to the work revision
  it was authored against (`forHeadSha`, rendered "for revision <sha7>"), and is
  withdrawn on the record, with a `note` titled "Recommendation withdrawn" and a
  `task.recommendation.withdrawn` audit row, when a new revision is delivered, when any
  decision packet opens, or when the task moves away from the acceptance boundary
  (ruling 137). The packet and stage causes also withdraw a `transition` card targeting
  the terminal stage; `run_agent` and `delivery` cards survive all three, and the
  "Waiting on you" bell is marked read only when no card survives.
- **The completion packet** (ruling 521) is what a person reads before accepting:
  `completionPacket` in task.md ([file-formats.md §2](../architecture/file-formats.md)),
  the operator's summary of the work, its summary of the code changes when they run past
  200 changed lines, and the screenshots it picked from the task's image attachments, each
  with a caption. Ruling 668: it also says what to weigh, what was assumed and what is
  missing (`considerations`, `assumptions`, `gaps`, each given only when there is
  something to say), and on a task delivered as files it names the files that are the
  result, each with a line saying what it is. Those files come from the delivery under
  review as it was kept (ruling 597) and must still be on the task, so a draft saved
  after the delivery, an input or one of the browser's working files is never a result;
  a task delivered as a revision names none, because its pull request holds them. Only
  the operator writes it (`write_completion_packet`), bound to the
  review subject like a verdict, and its offers to accept (the `accept_completion` card, a
  decision with an `accept_completion` option, the fold's card) are refused until it
  describes the current subject ([operator.md §5](operator.md)). A person's acceptance
  never waits for it. The task page shows it inside the decision that offers acceptance,
  or on its own card at the top of the main column while an acceptance card waits or the
  task stands at the boundary with a packet written. **Once the task is accepted the same
  card is its result** (ruling 668): titled "Result", it stays at the top of the main
  column of a task at the terminal stage, in the archive too, with the summary, the
  notes, the result files (a task delivered as files) or the pull request, the change's
  size, the operator's summary of the change and the first 40 paths it changed (a task
  delivered as a revision), and the reviewers who gave a verdict on the accepted work.
  The diff reader is the offer's alone, and nobody is shown as still owed a verdict. A
  task accepted with no packet on file (a person's own acceptance before the operator
  offered it, or a force-accept) has no result card. A reader on another task gets the
  same result as one text (`read_board`'s `outcome.completion`, ruling 569). Beside
  the summary it reads live: each reviewer's verdict on the revision under review (the
  required reviewers first, one with no verdict there shown as waiting, with any verdict
  it gave on earlier work marked stale; then anyone else who gave one, marked not
  required), the screenshots the viewer may see (the attachments' own bar), and the
  change: its size, and the diff open whole at 200 lines or fewer, else the operator's
  summary with the diff one press away. While the packet carries the diff, the Changes
  panel (ruling 484) steps aside.
- **Schedules** live in `task.md` `schedules[]`: `run-operator` (optional steer) or
  `run-agent` (a profile id and prompt; the profile must be deployed when the entry is
  created). Creating one needs `run-agents`, through the task page's run controls or
  the controller's `schedule_task_action` / `cancel_task_schedule` (ruling 153: the
  entry carries the `<email> · via controller` label); a closed task refuses it with the
  closure sentence. The operator schedules its own task's runs with tools of the same
  names (ruling 487): its own re-run or a deployed agent's, 1 minute to 28 days out, only
  on a `direct` `dispatch-agents` grant and never for an agent it could not dispatch now
  (a dependency hold, a stage the agent does not work). Its entry reads `createdBy:
  "operator"`, its "Scheduled:" line and audit row are the operator's, and it may cancel
  only its own entries. A pending schedule is a reason for quiet to both the stranded
  sweep and the settle-time backstop, and a hold it explains needs a note, never a
  packet. Each run control carries a when-picker (now, in 5 min, 1 hour, 6
  hours, 24 hours). The runner ticks every 60 seconds, claims an occurrence before
  enqueuing (`pending → claimed → fired | failed`, `cancelled` by a human or by an
  archive), never fires on a terminal or archived task (outcomes `skipped-done`,
  `skipped-archived`), and resolves the **live** deployment at fire time (ruling 94). A
  fire-time refusal no retry can cure (profile undeployed, stage-ineligible for a NEW
  engagement, a dependency hold) is a terminal `failed` with the reason on the timeline
  ("Scheduled action failed: … was refused: …"); the engaged deliverer fires at any
  stage (ruling 133). A `run-operator` occurrence on a task that waits on other work
  (ruling 131(d)) is retired `fired` with a "Scheduled action skipped" note and outcome
  `skipped-held` (no run, no cost). A `run-operator` occurrence on a task with an open
  decision packet is retired the same way, outcome `skipped-packet`, spending no retry
  (ruling 141: the same paid no-op ruling 76 refuses for a person); one that was queued
  behind a live drive records `queued-behind-drive` at fire time and, if the drive leaves
  a packet open, its final `skipped-packet` row (`atDrain: true`) and a "Scheduled action
  skipped" note when it reaches the front of the lease queue.
- A dispatch of any kind (the Run control, an @mention, the operator's `run_agent`, a
  schedule, `retry_other_backend`) into a backend the instance already knows is out of
  quota for the account the run bills is HELD (ruling 152(c)): no run, a "Dispatch held"
  note by the policy engine naming the reopen instant and the provider's own words, a
  `task.agent.run_held` audit row, and a `run-agent` schedule for one minute after the
  window reopens (thirty minutes after the refusal when the provider named no instant)
  carrying the same profile and prompt. The door reads "Held: Codex is out of quota until
  Sep 6, 2026 · 18:18 UTC; Developer's run is scheduled for then." A repeat dispatch
  inside the same window reuses that pending occurrence — one retry per profile per
  window, a newer directive replacing its prompt, no second note — so a cascade of held
  attempts cannot become a queue of duplicate runs at reopen. A hold is not a decision
  packet and costs no operator turn; a scheduled occurrence that lands on a hold retires
  `held-quota`. Resolving the quota or auth packet's option that states the window has
  reset (or that the account changed) retires the instance's exhaustion record for that
  backend: the option promises the agent continues now, and only a completed run would
  otherwise clear it (ruling 164).

## 10. Delivery

Delivery (push the task branch, open the review PR) is an operator decision executed
by the server (ruling 21); humans trigger it with the `deliver-review` intent
(`run-agents` or the owner). `performDelivery` first refuses a task that waits on other
work, with the hold sentence on the timeline (ruling 240), and a task delivered as the files
saved on it, which has no branch or pull request (ruling 647; the task page offers no
delivery for one). It then makes sure the
repository's default branch exists (ruling 128: an empty repository is bootstrapped,
never misreported as unreachable), pushes the workspace branch (auto-committing a dirty
tree; refusing a non-fast-forward as a `push_conflict` whose remedy names what is on the
branch, ruling 321; refusing a tree that carries Viberr's own store layout under
`projects/<slug>/tasks/` as `store_layout` with the paths named, ruling 159; refusing a
change to a path another task leases, ruling 245, §15; reading origin's head first and
answering `up_to_date` when there is nothing to push, ruling 134; stamping
`workRevision.pushedAt` on the revision whose head the push published, ruling 161),
detects a verified empty branch as a no-change outcome, opens or adopts the PR (adoption
only when the PR is open **and** its head is the delivered revision; anything else is a
branch collision, whose `resolve_remote_collision` ceremony re-confirms a cached open PR
against GitHub before refusing and never strands on either arm, ruling 136), records
`github.pr.opened` (or "Pushed `<sha>` to PR #N" when a push moved the head of the task's
open PR), and either re-queues a full-autonomy operator (`delivered`: a new PR or a moved
head) or ensures a supervised operator left a "Move to Review" recommendation, on a board
where a person approves that move (where the edge is `auto`, the operator makes the move
itself and no card is filed, ruling 519). When the
delivering drive is the operator's own, the `delivered` follow-up is deferred to the end
of the drive and queued only if the drive stopped without moving or dispatching (ruling
357). A PR Viberr did not open but adopts (open, head equal to the delivered revision) is
recorded as an adoption: a `github` event and the audit row `github.pr.adopted` (F34-9);
the reconciler's adoption also notifies the task's watchers, the delivery's does not,
because the person who asked for it is reading the answer. Rework on a task whose PR is
already open is delivered the same way: the push moves the PR's head, and the PR's
description is rewritten to describe the new revision unless a person edited it on
GitHub (ruling 474); nobody is ever asked to push by hand. The task page offers the same door as "Push `<sha>` to PR #N"
whenever the open PR does not carry the delivered revision (ruling 134(c)), and shows a
disabled control naming the refusal for a diverged remote. A task whose deliverable is
the files saved on it is refused before the push and offered no delivery (ruling 647,
which retired ruling 391's no-commits sentence for it). Entering the review stage with no PR writes a
typed event, never silence (§5), except on a project with no repository, where no pull
request can exist and a delivery attempt answers that the task is delivered as files
(ruling 667). Ruling 163: a delivery that moved the PR's head on a
task standing PAST the stage where its reviewers can run, with a revision that changed
or failed after the last verdict, records the transition back to that stage in the same
delivery ("Transition: KNC-20 returns from Merge to Review: `17e4a8c` changed after the
last verdict, so the reviewers judge it there"; audit `task.transition` with `via:
delivery`). The redirect option of a branch-conflict packet does the same when it is
resolved (`rework: true` on the option; `via: packet_redirect`), and the option's detail
says so before the person decides. Ruling 475: the operator's `update_branch_from_base`
hands a conflict to the deployed, repo-write delivering agent itself, and that handoff
returns the task in its own write (`via: conflict_handoff`, "WEB-2 returns from Merge to
Review, so the reviewers judge the resolved branch before anyone accepts it"); the
packet is the fallback when no agent can take the conflict.
Details in [github-delivery.md](github-delivery.md).

## 11. Acceptance and the endings

Every writer to the terminal stage goes through one contract. The direct ceremony
(`acceptCompletion`) runs: authority → disclosure echo → the live no-change probe →
the refusal stack (`acceptanceRefusalReasons`) → the PR head check → the merge attempt
(the gate stack re-run, the base refresh, the gate stack again, the merge) → the in-lock
write → the closure interrupt. The refusal stack reads, in order: archived → closed
unmerged PR → stage boundary → engaged required reviewers → project-declared required
reviewers → the probe's has-work refusal → the delivered-work verdict gate → an open
`blocked` packet → merge readiness (an unpushed delivered revision, then a conflicting
PR). The first refusal is the one a surface prints; force-accept's record lists all of
them.

1. **Authority**: `accept-completion` (admin, maintainer) or the live owner;
   `force-accept-completion` is admin-only with no owner exception.
2. **Disclosure echo** (ruling 88): the client sends back the three facts it showed
   (`ackPr`, `ackRevision`, `ackVerdict`). A bare POST is refused with
   `accept_disclosure_missing`; an echo that no longer matches the task is refused with
   `accept_disclosure_stale`. In-process callers (the full-autonomy operator) carry
   their own contract.
3. **Terminal GitHub fact first**: a closed, unmerged PR refuses acceptance and
   withdraws force-accept entirely (ruling 37), and refuses a new delivery too: a
   person's close is a decision about the task, recorded as `pr.closure`, and no fresh
   PR is opened for the branch until a person answers the recovery packet or reopens
   the PR (ruling 160; `closed_by_human` on every delivery door). Last in the stack, a
   delivered revision that is not on the pull request refuses with "deliver the branch
   to push it" (ruling 135) and outranks a conflicting PR, whose `mergeable` describes
   the head GitHub has, not the one that was reviewed; a conflicting PR refuses after
   it, and only when the conflict was measured on the PR's current head (`pr.mergeableAt`,
   `liveMergeable`, rulings 405 and 435). Its sentence says to merge the base into the
   branch, never to rebase (ruling 291). Both sentences come from ONE function,
   `mergeReadinessRefusal` (ruling 162), read by the acceptance stack, the operator's
   `get_task` (`notAcceptableReason`, computed by the whole stack through
   `acceptanceRefusalFor`), the controller's `move_task` to the terminal stage (ruling
   246), the operator's move into the acceptance-boundary stage, and the post-gate
   GitHub merge refusal: a 405 re-reads the pull, records `mergeable: conflicting`, and
   the person reads the gate's sentence with its way out instead of "GitHub refuses to
   merge ...". No surface offers an acceptance the gate will refuse: the task page's
   recommendation card prints the refusal as an alert and its Apply refuses the click,
   the accept dialog prints it above a disabled confirm, the GitHub card shows its
   "Conflicts" status row (ruling 511), and the reconciler withdraws a pending
   `accept_completion` card the moment `mergeable` flips to conflicting, with a
   "Conflict:" note on the timeline, and an open decision packet offering the acceptance
   too, telling the watchers why and waking the operator (`pr-conflicting`, ruling
   475(b)). After every merge Viberr re-reads the project's other open PRs
   (`recheckOpenReviewPrs`), so a sibling the merge put in conflict flips before anyone
   presses its Accept. The accept dialog also says
   what CI reports when the checks are not green (failing or pending); checks are not a
   gate (ruling 304). Its "Collides" row names every other open PR that changes a path
   this one changes ("Merging this will likely put WEB-2's PR #3 in conflict on
   `package.json`. ..."), from the task page's loader and from the board's own cards
   (ruling 475(b)).
3a. **The base refresh, once** (ruling 162): after the gate re-check and before the
   merge, the acceptance ceremony brings the branch up to date with the base through the
   same workspace merge `update_branch_from_base` performs (`refreshBranchAsPerson`),
   records it in `baseRefreshes` (ruling 132), reconciles, writes "Accepting the
   completion brought `<branch>` up to date with `<base>` ..." on the timeline and
   audits `github.branch_update.acceptance`. A refresh that CONFLICTS refuses the
   acceptance with the gate's sentence, records `mergeable: conflicting`, names the
   conflicting paths on the timeline and hands the task to the operator with the
   `pr-conflicting` trigger (ruling 332); a branch that cannot be refreshed from here
   (no workspace, no credential, a diverged origin, a path another task leases) proceeds
   to the merge, where GitHub decides. The refresh is itself an irreversible publish (the
   workspace merge is pushed), so the gate stack runs on BOTH sides of it. The operator's
   own tool refuses at the acceptance-boundary stage and past it
   (`acceptanceBoundaryRefusal`: "... the branch is brought up to date once, at
   acceptance time, and merged in the same ceremony"), except on a PR GitHub reports
   conflicting at its current head, and except while the work is still in its review
   loop (`validation` `failing` or `changed`, ruling 429).
   **Update and re-review first** (ruling 449): while the branch is behind its base, the
   task page's accept dialog offers to bring the branch up to date and re-review before
   accepting (intent `refresh-and-review`, `refreshAndReview`, the acceptance authority
   with the owner exception). It refreshes the branch as the person through the
   ceremony's own refresh, then starts a re-review by every reviewer whose verdict stands
   on the revision, with a directive naming the merge commit; the revision and its
   verdicts are kept (ruling 439) and the review subject moves to the refreshed head. It
   accepts nothing, and it starts nothing (409 with its own sentence) when the branch
   already carries its base, when the refresh conflicts, or when no verdict stands.
   Ruling 177: the acceptance (plain or forced) and an archive end the task's
   live runs through the run-service's closure interrupt (`interruptRunOnClosure`), note
   them once on the timeline ("Interrupted by acceptance", every run named) and audit
   `task.acceptance.interrupted_runs`; a closed task refuses every coordination door
   afterwards (`taskClosure` / `closureRefusal`, `task-closure.server.ts`), and a run
   that finishes after the closure records its report with a "Completed after the task
   closed" note and wakes no operator.
4. **Verdict gate**: every required reviewer must have approved the current review
   subject and none may request changes (ruling 20). The engaged reviewers' gate
   (`acceptanceBlockedReason`) reads the subject through `reviewSubjectId`, as the
   project rule below does (ruling 531): a delivery that is files on the task is
   released by an approval bound to `files:<deliveredAt>`, and its refusals name "the
   work delivered on this task". Keyed on the work revision alone, it had refused every
   files-only task whose reviewer was engaged with "No reviewed revision yet". Force-accept bypasses this and is
   audited `task.acceptance.forced` with EVERY gate it bypassed (U35-3: `bypassedGates`
   is the full refusal list in gate order, `skippedStages` the stage ids jumped,
   `validation`, `withdrawnPacket`; `bypassed` keeps the sentences joined with " | " for
   older readers), records `acceptance: forced`, and the forced `completion` event
   appends the same list, each gate reduced to its FIRST sentence ("Bypassed: Review
   skipped; the review gate; VIB-1 is at In Progress, not Review; This task's latest
   review requests changes on the current revision; the open decision "..." withdrawn
   unanswered."). The remedy half of each refusal ("Move the task through the workflow
   first") stays in `bypassedGates` only. A decision the force ANSWERS (ruling 471, step
   7) is not withdrawn, so `withdrawnPacket` is null and the list does not name it. The
   force dialog lists the same gates (`AcceptanceAffordance.blockedGates`, ruling 393).
   Force never bypasses two facts: a
   closed unmerged PR (ruling 37) and an **archived** task (ruling 123) — restore it
   first. Both are `forceIrreducibleRefusal`, and on an archived task the affordance is
   withdrawn rather than disabled. The offer itself appears only once the task has
   something to accept — a branch, a PR or a delivered revision — or is demonstrably
   wedged by an open `blocked` packet (ruling 124). A packet can offer the same override
   as a `force_accept` option (ruling 164): the resolution calls
   `forceAcceptCompletion` itself, so the tier, the ceremony, the irreducible gate and
   the audit record are the button's, and a non-admin resolver hears the button's own
   refusal instead of a decision that records nothing.
4a. **Project-declared required reviewers** (ruling 178): for every rule in
   `project.md` `requiredReviewers`, the named agent must hold an `approve` verdict
   bound to the task's current review subject (an approval of a replaced revision is
   history, ruling 163), whether or not anyone engaged it; otherwise the refusal reads
   "Required reviewer <Agent> (project rule at <Stage>) has not approved revision
   <sha7>. Run the review at <Stage>, or an admin can force-accept." ("the work
   delivered on this task" when the deliverable is not a commit, ruling 385). When the
   rule's agent is the task's own deliverer (engaged before ruling 556 refused it), the
   sentence says it "is this task's deliverer, so its review cannot count" and names the
   ways out (hand delivery to another agent, have that agent deliver, and run its review;
   or force-accept), whatever has been delivered. Otherwise a task that has delivered
   nothing (no active work revision, no pull request and no `deliveredAt`) is not held. ONE pure gate, `requiredReviewerRefusals`
   (`app/server/tasks/required-reviewers.server.ts`), is read by the acceptance refusal
   stack (so the task page, the operator's `notAcceptableReason` and every writer agree),
   by the projection's `validation_block_reason` (so the review queue lists the task as
   review work and never offers it for acceptance; the `projects` row carries the rules
   resolved to names, `required_reviewers_json`, and a project.md change cascades into
   every task row) and by the force-accept disclosure, which lists the sentence among
   the gates the override bypassed. The task hero's validation pill is unchanged by the
   rule: `validation` is derived from the ENGAGED required reviewers alone, so a task
   whose declared reviewer never ran can read `healthy` (another reviewer approved) or
   `changed` while the acceptance box beside it prints the rule's sentence.
4b. **Project gates** (ruling 482): when `project.md` declares `gates`, every one must
   have exited 0 in Viberr's own run on the revision under review (`gateRun`, bound to the
   revision id and sha). A run that is missing, queued or running, made under an earlier
   gate list, failed, or could not execute refuses with its own sentence ("The project's
   gates failed on WEB-4's revision `a95c337`: 3/4 exit 0 (`build` exit 1). Rework the
   branch; …"). ONE pure gate, `projectGatesRefusal` (`app/shared/project-gates.ts`),
   read by the refusal stack after the verdict gate, by the projection's
   `validation_block_reason` (the `projects` row carries the list as `gates_json`, and an
   edit cascades into every task row), by the operator's `notAcceptableReason` and by the
   force disclosure, which names it among the bypassed gates. Force accept bypasses it.
   A `verified` revision and a files-only delivery owe no gates. How the run happens is
   [github-delivery.md §5](github-delivery.md#5-revisions-verdicts-and-acceptance).
5. **PR head containment** (`acceptancePrHeadCheck`): the PR head must contain the
   delivered commit. A head ahead of the reviewed revision is accepted with a disclosed
   divergence (ruling 42; since ruling 132 the disclosure is the classified drift
   sentence: authored commits are named unreviewed, a base refresh is named as one); a
   diverged head refuses; a compare GitHub answers 404 to, confirmed by a commit read
   GitHub answers "not found" to (`isMissingCommitAnswer`: 404, the empty-repository
   409, or 422 "No commit found for SHA", ruling 223), is a never-pushed revision and
   refuses with the same "deliver the branch" sentence (ruling 135), records a `github`
   event and a `task.acceptance.head_unpushed` audit row, and hands the task to the
   operator (`head-unpushed`, ruling 235). A PR GitHub answers but whose compare it
   refuses is refused too, with a non-blocking packet whose `accept_unverified_head`
   option records a `headCheckWaiver` valid for that one (PR, revision, live head)
   triple (ruling 226). Force never bypasses this. The write re-checks inside the lock
   that the task still carries the PR and revision the check verified.
6. **Live no-change probe**: a branch with no commits or no branch at all routes into
   the **Completed, no changes** ending (still verdict-gated, ruling 62); `noChanges`
   is re-verified against the remote inside the lock so a branch that gained commits
   cannot ride a stale flag into Done. An empty task branch is deleted after a no-change
   acceptance, through the same guarded door as every branch cleanup. A task that
   corrected a knowledge base (ruling 498) and nobody undid it did change something:
   the approval, the operator's card and the completion record say "no repository
   changes" and name the corrections by id and document, with who made them, and the
   approval says when its own reviewer made them all; the accept dialog names no outcome,
   only what merges (ruling 576).
7. **Merge, then write.** A **human** acceptance attempts the real merge before the
   completion is written (`github.pr.merged`, or `github.pr.merge_refused`); GitHub
   refusing the merge (not mergeable, or a head that changed during the acceptance)
   refuses the acceptance unless forced, while an unreachable GitHub, a missing
   credential or a missing `pull_request:write` leaves `pr.state: accepted` (merge
   pending, with its cause). The file is then
   re-read, so the `completion` event names the head that actually merged and the base
   refresh the ceremony made (ruling 318), and it is dated when it is written, on the
   packet path as on the direct one (ruling 327). The write sets stage → terminal,
   `waiting: none`, `readiness: ready`, clears `heldAtStage`, the packet and the
   recommendations. The open packet is ANSWERED when a person's acceptance performs one
   of its options (ruling 471, `acceptanceAnswerOf` in
   `app/shared/packet-acceptance-answer.ts`): a plain acceptance answers
   `accept_completion`; a forced one answers `force_accept`, else `accept_completion`;
   the recommended option of the kind wins, and a decision already decided (`awaiting`)
   takes no answer. The answer is the packet door's record: a `task.packet.resolved` row
   under the person with `optionKind`, `optionTitle`, `packetKind` and `via` (`accept` or
   `force-accept`), the decision notifications (packet, agent question, approval) marked read, no operator
   hand-off, and one clause on the completion event ("This acceptance answers the open
   decision "…" with "…"."). Any other open packet is withdrawn (F32-11): a "Withdrew the
   open decision" note and a `task.packet.withdrawn` row with `by`. Whichever way the
   packet closes, and with every recommendation card consumed, every acceptance marks
   the task's decision notifications read for everyone (ruling 600): nothing on a Done
   task waits on a person. The operator's own
   full-autonomy acceptance answers nothing, so it always withdraws; it is refused instead
   while that decision offers a `create_task` whose new task waits on this one (ruling
   492). A full-autonomy
   **operator** acceptance records `pr.state: accepted` and leaves the merge to a human
   (`complete-merge` intent, `completeTaskMerge`, after re-running the head check)
   because `merge-pull-request` is always human (ruling 40). After a successful merge
   the `delete-branch-after-merge` guardrail (default on) deletes the remote task
   branch. Pending schedules are not cancelled; the runner never fires on a terminal
   task.

Post-acceptance: the task workspace is reclaimed once no run is live, the task's epic is
checked for being all done (ruling 503: its history says so once and its lead is told),
held dependents are swept (ruling 131(e): a task whose every `blockedBy`
entry is now done is released), a controller conversation that left itself a step for this
acceptance has its next turn started with it, as the person who asked (ruling 685), and the
board renders "accepted" (or "merged").

**A post-merge proof is a follow-up read task** (ruling 492, the owner's F40-64 decision).
Acceptance moves the task to Done and no stage sits after it, so nothing that happens after
the merge happens inside the task. A person's acceptance merges the PR first when GitHub
can merge it (step 7); a full-autonomy operator's acceptance, and a person's that left the
merge pending, leave `pr.state: accepted` and the merge to a person. A task's done
signal is therefore something it can show before acceptance: its gates, its reviewers'
verdicts, a measurement made on the branch or locally. A proof only the merged or deployed
code can show (a production deploy, a cron run on the merged code, a live page, a
production log) belongs to a follow-up read task whose `blockedBy` names this one,
created before this task is accepted. The sweep above releases it when this task reaches
Done, which can be before the merge and before the deploy, because a `blockedBy` entry
is done at Done whatever the PR's state; so the read's goal has it confirm the change is
merged and deployed before it reads.
Every door that writes a goal says so, from one constant (`DONE_SIGNAL_RULE`,
`app/server/tasks/done-signal.server.ts`): the controller's two
([controller-and-epics.md §7.5](controller-and-epics.md#75-the-agents-epic-tools)) and the operator's,
which also raises the read's `create_task` option itself
([operator.md §6](operator.md#6-decision-packets)). An acceptance withdraws an open
decision it does not answer (step 7), so the operator puts the task up for acceptance only
once a person has answered that option, and its own acceptance refuses while the open
decision offers a `create_task` whose new task waits on this one (`followUpOptionRefusal`).
A person's acceptance is not refused: its dialog names the decision it withdraws. Nothing
refuses a goal for its words.

**The review queue's membership** (`review-queue.server.ts`, U35-5) has two halves with
two rules. "Waiting on your acceptance" is about the boundary: a non-archived task
standing at a stage acceptance is legal from (the acceptance boundary the workflow graph
declares, the same predicate the accept writer and the board gate use, so a board with
several edges into the terminal stage keeps them all) that waits on a human, whose
acceptance nothing in the stack above refuses, for a viewer who may accept it
(maintainer+, or the owner). "Still in review" is about review work, which the board
defines by engagements and verdicts rather than by one stage id: every other
non-archived, non-terminal task that sits at the review stage, or carries a pull request
open for review (`pr.state: review`), or has a required reviewer (`verdictCapable`)
whose verdict on the current revision is missing (`validation: changed`) or is
request_changes (`failing`). On the default board the two rules coincide at Review; on a
board whose reviews happen at Validation and Review while the edge into Done leaves
Merge, the second rule is what lists the work. The row names its stage ("Review in
progress at Validation · PR #8 · awaiting verdict"), with a live pull-request fact taking
the place of the verdict words when there is one ("Review in progress at Validation · PR
#8 does not carry the delivered revision 385047c. Deliver the branch to push it." —
ruling 135, and the same for a conflict or a drifted head), and a row whose open PR
changes paths another open PR also changes carries a read-only "collides with <KEY>" chip
(`pr.paths`, `prPathOverlaps`, rulings 236 and 413). The header reads "N in review · M
waiting on your acceptance", and the workspace rail badge is the queue's `total`.
Nothing before the boundary is ever offered for acceptance.

## 12. Archive and restore

`archive-task` (`approve-transition`, `setTaskArchived`) is a terminal disposition, not
a delete: the file, its timeline and audit rows survive; the card leaves the board's
default view and the review queue; the open packet and pending recommendations are
withdrawn and named in the "Archived:" note; pending and claimed schedules are
cancelled; live runs are interrupted (ruling 177, §11); `waiting` becomes `none`; the
audit row is `task.archived`. `restore-task` brings it back waiting on a human
(`task.unarchived`), with a note that names the next step; a task restored at the
terminal stage is finished work, so it comes back with `waiting: none` and a note that
says it is done and nothing waits on it (ruling 664). Archiving through a `pr-diverged` recovery packet may also delete
the remote branch. An archived task cannot be moved. Archiving an unfinished task another
task waits on does not release the dependent (ruling 131(e)): before the archive returns,
`noteDeadDependency` writes one "Waiting on work that cannot complete" note on each
dependent, notifies its owner and supervisors once (`dependency`, titled "<KEY> waits on
archived work"), and sets it `waiting: human`, because a person owes the list an edit;
the entry renders as archived until they make it. A restore sweeps the dependents again.
A task archived at the terminal stage was done and still is (ruling 651): it satisfies
what waits on it and counts as done in its epic's progress, so filing finished work away
strands nothing. A Done epic's finished tasks are archived together from the Epics list
or the epic's page, and a row there archives or restores one. An archived task keeps
its `epic` (one archived unfinished is counted apart from the epic's progress) and
cannot change epics until it is restored; archiving the last open task of an epic is one
of the ways every task in it becomes done (ruling 503).

An `archive_task` option with `deleteBranch: true` deletes the remote branch through the
same door every branch cleanup uses: a cached open PR is re-confirmed against GitHub first
(ruling 136(c)), a PR GitHub reports closed lets the delete proceed, and an unconfirmed
state refuses with "GitHub could not confirm whether PR #N is still open", which the
archive note repeats verbatim. The no-change acceptance's empty-branch cleanup inherits
the same check. When the reconciler recorded `github.foreignHead` (origin's branch
carries commits this task did not author), the confirm dialog says so before the button,
the ref's head is read before the DELETE, and the audit records both heads
(`github.branch.deleted {sha}`, `task.branch.discarded {localSha, remoteSha}`; ruling
161).

## 13. Timeline and noise control

`## Timeline` in `task.md` is newest-first, `### <UTC ISO> · <type> · <actor ref>`,
with the eleven types in `TIMELINE_EVENT_TYPES`. `policy` is reserved for genuine
violations and refusals; neutral system remarks are `note`; `continuity` marks a
resumed session whose provider transcript was gone, or a large session deliberately set
aside for a fresh one. A `note` titled "Recommendation withdrawn" records an acceptance
offer that no longer holds and why (ruling 137); it is a system remark, never a `policy`
event. A `note` reading "Relayed to <task>: <first line>…" records text this task posted
on another task of the project, written by whoever relayed it; a `note` titled "Not
relayed" names a specialist's relay that did not go out and why (ruling 488, §7). The
projection serves a bounded newest-first slice and the page asks for older
events on demand (NFR5).

The compaction guardrail folds old routine comments into one "Compacted" marker once the
configured threshold is passed, wherever they sit in the older region
(`compactTimelineEvents`, ruling 206). It keeps every typed governance event, and it
never folds a person's comment, a controller-authored comment (ruling 257), a `toAgent`
hand-off, a comment carrying `evidence` or `attachments`, the "Review verdict" report
(ruling 317), or an event whose `notified` list is non-empty (ruling 382).

Files a run posted ride on its event as `attachments`, and the attachments panel lists
the whole directory. What a human sees there is not everything the run wrote: at
completion the browser MCP's machine-stamped working artifacts are pruned unless the
run cited the exact filename, and what survives opens in an in-app card with Download
(ruling 105 — [ui/surfaces.md §5](../ui/surfaces.md#5-copy-rules-that-tests-enforce),
retention in
[architecture/data-model.md §5](../architecture/data-model.md#5-retention-and-growth)).

## 14. Notifications a task produces

Kinds (`NOTIFICATION_KINDS`): `packet` (a decision waits, `ptype` `input | blocked`),
`approval` (a stage approval or acceptance waits), `mention`, `quality`, `policy` (a
violation, a refusal or a credential advisory), `controller` (ruling 99's goal progress,
unwritten since ruling 503), `epic` (ruling 503: a task joined or left an epic the reader
leads, they were made its lead, someone else closed or reopened it, or every task in it is
done; its own routing toggle, "epics"),
`dependency` (ruling 131: the work a task waited on landed and it was released, or a
dependency can never complete; its own routing toggle, "dependencies"), and `ownership`
(ruling 140(b): the reader's owner seat changed hands, addressed to that one person
rather than to the watcher set). Watcher notifications (`notifyTaskWatchers`) go to the
task owner plus project admins and maintainers, honouring each person's routing toggles;
a toggle off drops only the row, never the note, the audit row or the operator
re-invoke. Every such row names the actor its timeline entry names — there is no default
author (ruling 361); a question an agent asks arrives under that agent's name (ruling
222). Loading a task page marks all of the viewer's unread notifications for that task
read (ruling 71); the bell and inbox mark-read explicitly.

A row opens the thing it is about (ruling 497, `notifications.href`): a notice about a
timeline event opens that event (`#event-<occurredAt>`: a verdict, a failed run, a
delivery or PR note, a release, a lease, a scope violation, an ownership change, a
mention's comment), a packet or an agent's question opens its card by the packet's id
(`#decision-<id>`) and, once the packet has closed, the timeline entry that records how
(the answer, the withdrawal, the fulfilled goal edit, the acceptance or the archive: every
door that clears a packet moves its rows there, ruling 547), a recommendation
opens `#recommendations`, a knowledge-base proposal opens its entry on the project
Controller page, "GitHub sync is failing" opens the project's GitHub page, and an epic
notice opens the epic's page. A task notice names its subject
(`TaskWatcherNotice.about`); the anchors are spelled once in `app/shared/page-anchors.ts`.
A stored link is used only inside the row's own project, and a row with none opens the
task, or the project's board for a project-level row (B-FD6). On the task page the named
event is marked and focused, the filter tab that hid it opens, and older events load
until it is among them; a click on a row about the page already on screen brings the
place back into view (`useHashTarget`, `app/ui/use-hash-target.ts`). The place stays
where the link put it while the page settles around it (a task page that mounts for the
link folds its long entries only after the reveal), until the person scrolls, presses or
types (ruling 547). A link to a packet the page no longer shows, or to recommendations
none of which is pending, lands on the Timeline panel, marked. The mark lasts until
the person's next press anywhere on the page or key (a lone modifier aside), which takes
the hash out of the URL in place, so a reload does not bring it back; the event keeps
the focus the link gave it (ruling 523).

## 15. File leases

A **file lease** (ruling 245) says one task owns some paths until it merges: `project.md`
`fileLeases: [{paths, taskKey, reason}]`, where each path is a glob (`*` within one
segment, `**` across segments; `matchesGlob`, `app/shared/file-leases.ts`). It is weaker
than `blockedBy`: both tasks may proceed, and only the task that holds the path may
publish a change to it.

- **Writers.** The Settings File leases panel (ruling 396, intent `set-file-leases`,
  gate `edit-policy`) and the controller's `set_file_leases` share one writer
  (`setProjectFileLeases`, audit `project.file_leases.updated`), which refuses two active
  leases whose globs can match one file (`overlappingLeases`, `globsOverlap`). The
  operator leases paths to its OWN task with `lease_files` (`operatorLeaseFiles`, ruling
  417), gated on its delivery authority: first come, first served, refused by name when
  another active task holds an overlapping path, and refused when another task's open PR
  already changes the path while other work waits on that task (ruling 426). A new
  operator lease writes a "Files leased" note on the holder and a "Files leased by
  another task" note and notification on every other task whose open PR changes a newly
  leased path.
- **A lease whose holder is finished binds nobody.** Every gate reads through
  `activeFileLeases` (`app/server/tasks/file-leases.server.ts`), which drops a lease whose
  task is terminal, archived or gone (ruling 247); `staleFileLeases` names the spent ones,
  and the panel's "Clear finished" removes exactly those.
- **Enforcement.** The delivery push (`pushWorkspaceBranch`, status `lease_held`) and the
  base refresh (`updateWorkspaceBranchFromBase`, ruling 428) refuse a branch that changes
  a path another task holds, measured over every file the branch changed since its fork
  point, not only this push's delta (ruling 353). The refusal is one sentence
  (`leaseRefusal`): "<KEY> changes `<path>`, which <HOLDER> holds (<reason>). One task
  owns a shared file until it merges, so <KEY> waits for <HOLDER> before … Drop the
  change, or clear the lease once <HOLDER> has landed." A diff that cannot be measured
  refuses nothing.
- **Readers.** The run's canonical anchor, the controller's `get_project` (resolved
  leases, spent ones named separately) and the operator snapshot's `fileLeases` (ruling
  431) read the resolved list.
