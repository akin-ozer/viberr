# Task lifecycle

> Updated 2026-09-13 for rulings 186 and 189 (pass 37): a task with a non-empty `blockedBy`
> refuses **every** agent dispatch at `startAgentRun`, beside ruling 177's closure gate and
> in the same shape (`holdRefusal`, shared with the task page so the words before the click
> are the words the server answers with); ruling 131(d)'s three-trigger operator refusal
> stands and the held doctrine now states the dispatch refusal rather than asking for it. And
> resolving a decision packet APPENDS the decision to the task's goal, so the contract every
> fresh run re-anchors on carries the human's answer — the timeline alone did not, and the
> stale goal overruled it.

> How a task is born, moves, waits, gets reviewed, is delivered and is closed;
> and which server invariants hold at each step. Source of truth:
> `app/server/tasks/task-actions.server.ts`, `app/schemas/task-file.schema.ts`,
> `app/shared/workflow/*`, `app/shared/rbac.ts`. File fields are in
> [file-formats.md](../architecture/file-formats.md). Verified against `main`
> @ `68b5480` (2026-09-01). Updated 2026-09-02 for ruling 127 (branch
> `claude/per-user-codex-auth-difdnn`): §3 (creation seats the creator as owner)
> and §7 (whose accounts a task's agent runs bill, and what an unowned task
> refuses). Updated 2026-09-11 for ruling 175 (branch `option-d/pr3-cost-cap-usage`): §7's
> wording for a run the spending cap cut off. Updated 2026-09-11 for ruling 178 (pass 36,
> G36-3): §6 (a project-level required reviewer beside the engaged one) and §11 gate 4a.

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

Rules that follow from it:

- **Files first.** Projections are never written without file backing.
- **Archived projects are read-only** for every governed mutation
  (`requireProjectMutable`, 409 `conflict`).
- **Membership is the outer gate.** A non-member gets the unknown-slug 404 on reads
  (layout loader) and on actions (`requireVisibleProject`, called outside the try
  block so it never turns into a 403 that would confirm the project exists).
- **In-lock re-checks, not pre-checks.** The state checks outside the lock are fast
  paths; `transitionStage`, `resolvePacket` and the acceptance writers re-run the
  decision inside the lock, so two submits of one human act produce one event and
  one audit row (NFR16).
- **In-process authority flags never come from a request.** `operatorAuthorized`,
  `recommendationAuthorized` and `rework` are set only by server code.
- **A hard-stop file is never written.** A `task.md` that parsed only with fallback
  defaults is projected as `blocked` and refused for writes (`file_not_trusted`); fix
  the file or restore it.

## 2. Who may do what

`app/shared/rbac.ts` is the one table both the guards and the Policy page read.
Roles are a strict tier: `viewer ⊂ contributor ⊂ maintainer ⊂ admin`.

| Action id | admin | maintainer | contributor | viewer |
|---|---|---|---|---|
| `view`, `comment` | ✓ | ✓ | ✓ | ✓ |
| `create-task`, `own-task`, `edit-task-meta`, `attach-file` | ✓ | ✓ | ✓ | |
| `approve-transition`, `resolve-packet`, `accept-completion`, `update-goal`, `run-agents`, `reorder-board`, `reconcile-github`, `grant-github-scope`, `rescan-project` | ✓ | ✓ | | |
| `release-any-ownership`, `manage-members`, `manage-agents`, `edit-policy`, `force-accept-completion` | ✓ | | | |

Three deliberate short-circuits, each re-asserting the archive freeze first: the live
task **owner** (contributor or above) may accept their own task and govern any open
decision on it (packets and recommendations, including transition recommendations
their role could not authorize from the stage menu); the loosest gate
`requireAnyMember` covers idempotent paths; and an **org admin** passes any project
gate as an audited emergency override (`project.org_admin.override`, deduped per
minute). Denials are audited as `project.authority.denied`.

## 3. Creation

`createTask` (`create-task`; the `create-task` intent on the board, the controller's
`create_task`, goal-chain advancement) refuses any stage but the **entry stage**
(ruling 70). It allocates the key from `project.md` `nextTaskNumber` under the
project mutex, writes `task.md` with `readiness: input_required`, `waiting: human`,
the goal (or the placeholder "Goal to be refined at the triage quality gate."),
optional `priority | labels | dueDate`, optional `goalRef`, then auto-invokes the
operator with the `create` trigger.

**Creation seats the creator as owner** (ruling 127), or the member named at creation
(ruling 140(a): `CreateTaskInput.ownerUserId`, the controller's `create_task` `owner`,
checked by the hand-off rule `requireOwnable` that `setOwner` shares, seated in the SAME
`task.md` write and before the operator's `create` trigger, so the first triage run bills
the named owner and is refused honestly when they have no credential; `task.created`
details carry `seat: creator | named | none`, and the release word `none` is refused by
name at creation). `ownerUserId` is the human actor,
and the file is written with the SAME `assign` timeline event a take through `setOwner`
writes (one event builder, so the timeline reads identically however the seat was
filled), with the audit's `task.created` details carrying `ownerUserId`. The reason is
the credential principal: every agent run on a task bills the OWNER's own Claude and
Codex accounts, so a task born unowned could not run the operator it was about to
invoke. A task created by the OPERATOR itself (`OPERATOR_TASK_ACTOR`, or an
operator-authorized context) keeps a null seat — the operator is not a person and has no
account to bill — and a human has to take that one before agents can run on it. A
controller-driven creation IS a human creation: the asker is the actor, and they get the
seat. Priority is `low | normal | high | urgent`
(`urgent` also sets the legacy boolean the board highlights), labels are at most 12
of 32 characters, due date is a plain `YYYY-MM-DD`. `edit-task-meta` grooms these
later without touching any gate.

The **triage quality gate is behavioral** (ruling 89): the operator flags an
underspecified goal with an `input` packet at triage; there is no mechanical block on
moving a task past an open packet. `input_required` set at creation clears when the
task leaves the entry stage.

**Waiting on other work at birth** (ruling 131(c)): `createTask` accepts `blockedBy`
(task keys and goal links in the same project, validated by
`validateDependencyRefs` BEFORE the key is allocated, so a refused reference burns
no counter value). The task is written with the list, `waiting: none`, a "Waits on
other work" note, and its stored readiness at the birth value `input_required`; the
`blocked` it shows is the derived floor. The controller's `create_task` and a goal
link's declared `blockedBy` both come in through this door; from then on the link's
record follows the task's list (ruling 155, §6).


## 4. Stages and the workflow graph

Stages are per project. Nothing hard-codes `triage`/`done`; `resolveStageRoles`
derives `entry` (first), `terminal` (last), `review` (the stage with an edge into
terminal) and `work` (the stage with an edge into review). `workflow` is a chain over
the stage order, one rule per consecutive pair, maintained by the stage editor
(`spliceStageIntoChain`, `rejoinChainAroundStage`, `realignChainToStages`): adding a
stage inherits the replaced edge's boundary, removing one merges neighbours with the
**stricter** boundary, a rule into terminal is always `human` and `locked`.

The Standard template: `Triage → Ready → In Progress → Review → Done` with boundaries
`auto, auto, approval, human`. Project creation offers three policy presets that
shape the graph and the operator deployment: **strict** (every pre-work `auto`
becomes `approval`; operator supervised), **balanced** (the template as is),
**autonomous** (operator at `full`). The preset is not stored; its effect is readable
off the graph (`humanGatesPreWorkAdvance`, ruling 28).

Agent stage eligibility resolves in three steps (`stageEligible`): a literal id on
this board; else the structural role the declared id names (`todo`, `backlog` →
entry; `impl`, `doing`, `wip` → work; `review`, `qa`, `verify` → review; …); else a
declaration that names nothing on this board is treated as unrestricted. Eligibility
decides where a profile may be NEWLY engaged; the task's engaged deliverer acts at any
stage (ruling 133), so rework routing is a workflow choice, never a way around a
profile's stages.

## 5. Transitions

`transitionStage(db, input, actor, ctx)`, in order:

1. Same stage → idempotent return. Unknown target → validation error.
2. Archived task → 409 (an archived card cannot be dragged column to column).
3. A **human moving a task into the terminal stage is accepting completion**: the call
   routes through `acceptCompletion` (real merge attempt, `completion` event, packet
   and recommendations cleared), never a bare move. The board drop and the keyboard
   Move menu raise the same confirmation as the task page (ruling 53).
4. Authority: `manual` (board menu, any stage) → `approve-transition`; an `auto`
   boundary → any member; `approval` → `approve-transition`; `human` →
   `requireAcceptCompletion`. Operator authority skips human RBAC but is forbidden a
   bare move to terminal, and (ruling 151, pass 35) is forbidden every declared
   `approval` or `human` boundary whatever its grant says: "The Review to Merge
   boundary is approved by a human on this board: the operator may recommend it, not
   cross it." The operator crosses `auto` boundaries and backward rework moves while
   validation is `failing`, and (ruling 163, pass 35) the one backward move a `changed`
   revision licenses: into the stage where the task's required reviewers can run
   (`verdictStageFor`: the nearest earlier stage where a verdict-capable engagement is
   eligible; the acceptance-boundary stage when none is deployed), so a revision that
   moved after a verdict goes back for its re-verdict instead of waiting at Merge. The
   operator's move INTO the acceptance-boundary stage is refused with the acceptance
   gate's own sentence while the review PR conflicts with the base or lacks the
   delivered revision (`mergeReadinessRefusal`, ruling 162: Merge means mergeable). An
   applied recommendation arrives with the human's `recommendationAuthorized`, never
   with operator authority.
5. Inside the file lock the stage is re-read: already there → write nothing; moved
   elsewhere → 409, because every guard above judged `fromStageId`.
6. On success: `previousStageId = fromStageId` (the durable "came back from Review"
   fact the operator weighs, ruling 98); terminal → `waiting = none`; leaving the
   entry stage attaches the operator and clears the triage gate; `task.transitioned`
   audit and a `transition` timeline event; the operator is re-triggered
   (`transition`) unless the move was made by a live operator run, whose own turn
   continues (ruling 152(a)); a human or system move onto the acceptance boundary
   first files the acceptance recommendation under the deployed operator's gate and
   skips the re-trigger when the card was filed (the fold, owner decision Q35-15);
   goal chains reconcile; held dependents are swept (`maybeReleaseDependents`,
   ruling 131(e)).

## 6. The three signals on a card

- **Readiness** (stored, 4 values): `ready | input_required |
  inconsistency_risk_detected | blocked`. The projection stores the derived value:
  diagnostics floor it (warning → `input_required`, error →
  `inconsistency_risk_detected`, hard stop → `blocked`); a `blocked` packet sets it to
  `blocked`; recovery options lift it back to `ready`, and a person's operator run,
  a scheduled operator run or any dispatch lifts a packet-less, list-less hold with a
  "Hold lifted" note and `task.hold.lifted` (ruling 157; the display side, an agent
  carrying such a hold reading `agent_working`, is in `deriveDisplayReadiness`).
  Surfaces render the derived
  display value `agent_working` instead of readiness while `waiting === "agent"`
  (`deriveDisplayReadiness`, ruling 91) — `agent_queued` when the run carrying the task is
  parked behind the concurrent-run cap, which the loaders read off the run row through
  `withLiveRun` (ruling 349) — `goal_edit_pending` while a decided `edit_goal`
  packet waits for the edited goal (ruling 138: below `agent_working`, above
  `input_required` and a stored `blocked`), and "accepted" for terminal-stage tasks.
  A stored `blocked` never yields to a run, with one exception (ruling 157): a
  stored block with no open packet and no dependency list is a hold, and while an
  agent carries such a hold the display reads `agent_working`, exactly as the server
  lifts it on the record; a diagnostics floor (derived `blocked` over a stored
  `ready`), a dependency hold and an open `blocked` packet keep reading `blocked`
  (`deriveDisplayReadiness`, fourth argument from `stored_readiness` and the list).
- **Waiting**: `human | agent | none`. Raising a packet or a recommendation flips it
  to `human`; dispatching an agent sets `agent`; terminal forces `none`. It is a
  display flag: `liveRuns` is the only proof a run is in flight.
- **Validation** (derived cache): `none` before any revision; `failing` when a
  required reviewer requested changes on the current revision; `healthy` when every
  required reviewer approved it; `bypassed` after a force-accept; `none` for a
  verified no-change task with no required reviewer; otherwise `changed`. Never
  hand-edit it; the projection re-derives it from `workRevision`, `verdicts`,
  `engagements`, `noChanges` and `acceptance`.

**Waiting on other work** (ruling 131). A task's `blockedBy` list is written by ONE
writer, `setTaskDependencies` (`app/server/tasks/dependencies.server.ts`), whichever
door it comes through: the task page's own "Blocked by" form (intent
`set-task-dependencies`, gate `edit-task-meta`), the controller's `update_task`, or
the operator's `set_dependencies` tool (in-process authority). Every write validates
against the store, names the reference and the reason when it refuses (unparseable,
self, unknown, archived, unknown goal or link, a cycle through stored and declared
edges), writes a "Dependencies updated" note and a `task.dependencies.updated` audit
row, and settles `waiting: none` when nothing else is pending. While the list is
non-empty the derived readiness is `blocked` and the card, list row and task page
say what it waits on and in what state: the board's neutral "blocked by …" chip leads
the state stack (its title lists every entry with its state; the readiness pill
already carries the red), the hero renders one linked chip per entry, the
Current-state row reads "Other work: …", the Details panel shows a "Blocked by" row
with its own editor, and the operator run control carries a hold note with the
button left enabled (a manual run still answers a person). The operator holds without
a packet (ruling 131(d)): `create`, `transition` and `scheduled` are refused at fire
time (`refused: "blocked-by"`, the refusal settling `waiting` to `none` when nothing
else is pending), the stranded backstop never nudges a held task, and every turn that
does run is given the held doctrine in place of the stage rule. An emptied list clears `heldAtStage`; a
Because a goal-link wait is stored BY INDEX, removing a pending link is REFUSED while any
task or sibling link waits on that link or a later one: the removal renumbers them, so the
reference would silently denote different work. The refusal names every holder, and the
waits are re-pointed by hand first. A PERSON emptying it is the release itself (ruling 131(e)): the same two halves the
engine uses (`clearDependencies`, then `announceRelease`: the "Dependencies released"
note naming who cleared it, a stored `blocked` lifted to `ready`, the
`task.dependencies.released` audit row, a `dependency` notification to the owner and
supervisors, and the operator re-invoked with `dependencies-released`). A wait that can
NEVER complete is noticed by the same sweep, whatever killed it (an archived task, a
cancelled goal, a removed link, a reference to nothing): ONE "Waiting on work that cannot
complete" note, one notification, `waiting: human`, and the list left for a person to
edit. A task that already reached the terminal stage has its list cleared quietly — no
note, no operator turn. When the task carries a goal link (`goalRef`) and that link is
`active` on it, every one of these writes, the quiet terminal clear included, mirrors
the task's list onto the goal file's `links[].blockedBy` (ruling 155, `mirrorLinkWait`)
with a goal timeline line naming the task and who changed it (the engine as "Viberr
(release)"), and rebuilds the goal projection: the Goals panel's "waits on" and a later
retry of the link read the list the task last held. The link's `edit_link` accepts
`blockedBy` alone on an active link and forwards it to this same writer.

## 7. Ownership, comments, mentions

- `owner-take` / `owner-assign` / `owner-release` (`own-task`, contributor+;
  takeover of another owner needs the acceptance tier; `release-any-ownership` is
  admin). Ownership changes are `assign` timeline events; admin releases are audited.
  Removing a member releases their tasks. **Every seat change tells the person whose
  seat it is** (ruling 140(b), `notifyOwnerSeatChange`): the new owner on a hand-off or
  a creation that named them, the DISPLACED owner on a takeover OR on a third-party
  hand-off (an admin moving the seat between two other people tells both sides, each on
  its own audit key `notified` / `notifiedDisplaced`), the released owner on an admin
  release. Nobody is told about their own take or release, and a member removal
  stays silent (the person is leaving). The row is kind `ownership` with its own routing
  toggle, opens the task page and never enters "Waiting on you"; the audit row carries
  `notified` — the user id, or `skipped: "silenced" | "failed"` — so a silenced
  preference and a broken store never read the same, and the notifier fails open rather
  than failing a write that already landed.
- **The owner is who a run bills** (ruling 127). Every task run — operator, specialist,
  resume, scheduled, boot recovery, retry — resolves `resolveTaskRunPrincipal` first and
  spawns with the owner's own backend credential; the run row records them in
  `credential_user_id`. Three consequences a person can see:
  - an **unowned** task refuses agent runs. Nothing is spawned: the refusal is an honest
    `error` run carrying `principalRefusalMessage` ("… need a task owner … Own the task
    (Assign me) and run the agent again. No agent process was started."), the usual
    blocked packet, and the ordinary completion effects. The task page's run controls
    are disabled with the same sentence, so the refusal is visible before the click.
  - a task whose owner has not connected THAT backend refuses the same way, naming the
    owner and pointing at their Profile → Agent accounts. `retry_other_backend` is
    offered only when the owner has the other backend connected, and the Agent-logs
    console asks the same question before it renders "Retry on <other>": with the owner
    unconnected there it renders no button and says so ("<Other> isn't connected for the
    task owner, so there is no other backend to retry on"), so the packet and the console
    never tell two stories about one task.
  - a run the provider **refused** for the owner's account (a spent usage window, a
    rejected credential) is worded once, by `describeRunFailure` (ruling 130(b)): the
    `blocked` timeline event, the recovery packet and the controller's note name the
    owner, the spent window and the instant it reopens (absolute UTC) or the
    organization restriction, and the owner's own move: wait, or connect a different
    account or an API key on Profile → Agent accounts. Nothing on the task says "fix the
    credential" or "retry on the other backend" unless the owner actually has the other
    backend connected, and the resolved decision restates the option the human chose,
    never a "policy / credential updated" nobody performed (ruling 130(c)).
  - a run the instance's **spending cap** cut off (ruling 175, Claude only) is a cut-off,
    not a failure, like the turn cap: the `blocked` event reads "the Claude run reached the
    instance's spending cap of $X after spending $Y and was CUT OFF mid-work, which is not a
    task failure", says nothing about undelivered changes, and ends with the remedy
    `describeRunFailure` words for it: re-run it to continue from its session, or have an
    org admin raise the cap in Org settings (Max spend per Claude run). The packet's
    options are the ones a turn-cap cut-off gets (redirect for a specialist; re-run,
    redirect or hold for the operator), never another backend.
  - a **hand-off changes whose account pays** from the next run on. An in-flight run
    keeps the principal it started with (the column is per run), and a resume after a
    hand-off looks for the provider session in the NEW owner's home, finds none, and
    takes the continuity-reset path with a `continuity` timeline event
    ([agents-and-runtime.md §3.6](agents-and-runtime.md#36-resume-continuity-export)).
- `appendComment` (any member) writes a `comment` event, applies mention routing and
  fans out `mention` notifications. **Mentions stay inside the project** (pass 33, F33-9):
  the picker offers project members only, and a handle that resolves to exactly one real
  user who is NOT a member notifies nobody and is reported to the author as a visible
  non-delivery, beside the ambiguity note it already had. Before that, tagging a
  non-member wrote them an inbox row naming the project, the task and the comment — and
  the link then served them the members-only 404, which is ruling 25 read backwards. `@operator` queues an operator turn carrying the
  comment as its steer; `@<agent name>`, `@claude` or `@codex` resumes that agent's
  session (auto-engaging a deployed but unengaged agent, ruling 98) and the reply
  posts back as a comment tagging the human. Mentions use one grammar shared by the
  composer and the server (`app/ui/mention-spans.ts`). The resume door is stage-gated
  like every other door (ruling 133): the engaged deliverer resumes at any stage; a
  supporting or released agent at a stage its profile does not declare gets the comment
  posted and the run refused with the dispatcher's sentence, which names stages by
  their board names. **A refused mention leaves a trace** (F35-5, pass 35): whenever
  the mentioned agent's run does not start (stage ineligibility, a run already in
  flight, an owner without the backend), the comment stays on the record and the
  server writes a `note` titled "Mention not started" ("**Not started:** @Architecture
  Reviewer was mentioned, but its run did not start: Architecture Reviewer is not
  eligible for the Triage stage; its profile is scoped to Design, Review. ... The
  comment stays on the record.") plus `task.comment.unrouted {profileId, reason:
  "run-not-started", detail}`; the toast carries the same reason. A packet decision
  the server relays through the same door reports to its resolver instead.
- Comment bodies are escaped so that a line that would read as file structure
  (`## `, `### `, `title:`, `to:`, `evidence:`) cannot forge a section or an event.

## 8. Engagements, dispatch and verdicts

`engagements[]` is written by the dispatch (ruling 98). Running a deployed but
unengaged profile engages it: **delivering** iff the task has no deliverer and the
profile holds repo-write (`execute-code-or-write-repo` granted), **supporting**
otherwise. At most one engagement delivers; it owns the workspace, branch and PR.
A supporting engagement snapshotted with `verdictCapable: true` (an explicit
`report-validation-verdict: direct` grant at engage time) is a **required reviewer**.
Since ruling 178 (pass 36, G36-3) a project can also declare required reviewers
**per review stage** in `project.md` (`requiredReviewers: [{stageId, profileId}]`,
edited on Settings → Required reviewers or through the controller's
`set_required_reviewers`, read on Policy): such a reviewer is required on every task
whether or not the operator engaged it, so a task whose operator never ran it is not
acceptable on another agent's verdict (§11 gate 4a). The engaged set stays as it was;
the project rule adds to it. The operator's `get_task` names the rule as
`requiredReviewers` and its turn prompt tells it to engage each one at its stage.
`release-agent` removes a supporting engagement; a delivery hand-off routes through
`assignSpecialist`. **A closed task's seats are frozen** (pass 33, F33-10): `removeReviewer`
refuses on a terminal or archived task and both panels withhold the ✕. Ruling 118 froze the
owner seat there; the engagement seat earns it harder, because `validation` is derived from
the required-reviewer set — releasing the approving reviewer of a merged, accepted task
re-derived `healthy` → `changed` and left the board, the hero and the review queue calling a
closed task never-validated while its own timeline said otherwise. Unlike the owner seat,
this freeze has no admin escape: an admin reassigning an owner is bookkeeping, an admin
releasing a reviewer restates history.

A delivering run's reconcile mints a **work revision** (`{id, headSha, treeSha,
branch, kind: delivered}`); a new head with a different tree mints a new revision and
stales every prior verdict. A revision is minted when the agent reports, before any
push: it has **left the workspace** only once a PR tracks the branch, an unowned PR
stands on the name, or the delivery push stamped `pushedAt` (ruling 161). Until then a
person may discard the branch through a `discard_branch` packet, and the discard retires
the revision (`kind: discarded`, verdicts kept as history, `validation: none`); readers of
"the revision under review" go through `activeWorkRevision`, so no verdict binds to a
retired head and a re-created head mints a fresh id. A reviewer's `report_outcome` records a **verdict**
(`approve | request_changes`) bound to a revision id. A project member's GitHub
approval on the PR, whose `commit_id` equals the delivered head and whose login maps
to a member through `users.github_handle`, counts as an approving verdict (ruling 68);
anything ambiguous fails closed with the reason recorded.

## 9. Packets, recommendations, schedules

- One open **decision packet** per task (see [operator.md §6](operator.md#6-decision-packets)
  for the kinds and their effects). Resolvers: the owner, `resolve-packet` holders,
  and for `accept_completion` the acceptance tier. `edit_goal` is the only kind that
  keeps its packet open until the goal is saved; the confirm stamps `decided` beside
  `awaiting`, so the card, the hero, the queue and the rail all read the packet as decided
  after a reload, and the editor prefill is `goalDraftForOption` (the option's `goalDraft`,
  else its title and detail) on both the confirm and the reload path (ruling 138).
  The mapping composes it once as `packet.goalDraft` (pass 35, F35-6): the decided
  card prints it under the decision line as "Requested goal (opens in the editor)",
  its "Edit the goal" opens it, and the hero's own Edit under the goal seeds it too
  while the packet waits, so a reload never hides the requested text or hands the
  nearest door the goal the decision asked to replace.
  Saving the goal UNCHANGED while the packet awaits the edit is refused (F35-6, pass 35:
  "The goal reads exactly as before, so the requested edit has not landed. Open the
  requested goal from the decision card, or write the edit."); an unchanged save with
  no packet writes nothing and the route toasts "Goal unchanged". A resolved
  `hold_runtime_debug` leaves a packet-less hold that the next person-started operator
  run or any dispatch lifts (ruling 157).
- **Recommendations** are the supervised operator's pending cards (`transition`,
  `run_agent`, `accept_completion`, `delivery`). `applyRecommendation` passes
  `recommendationAuthorized` into the inner mutation, whose own capability gate still
  applies; the owner may apply or dismiss any card on their own task. Any stage move
  prunes pending transition cards; acceptance consumes every card. An `accept_completion`
  card is bound to the work revision it was authored against (`forHeadSha`, rendered
  "for revision <sha7>") and is withdrawn on the record, with a `note` titled
  "Recommendation withdrawn" and a `task.recommendation.withdrawn` audit row, when a new
  revision is delivered, when any decision packet opens, or when the task moves away from
  the acceptance boundary (ruling 137). The packet and stage causes also withdraw a
  `transition` card targeting the terminal stage; `run_agent` and `delivery` cards survive
  all three, and the "Waiting on you" bell is marked read only when no card survives.
- **Schedules** live in `task.md` `schedules[]`: `run-operator` (optional steer) or
  `run-agent` (a profile id and prompt; the profile must be deployed when the entry is
  created). Creating one needs `run-agents`, through the task page's run controls or
  the controller's `schedule_task_action` / `cancel_task_schedule` (ruling 153, pass
  35: the entry carries the `<email> · via controller` label). Each run control
  carries a when-picker (now, 5m, 1h, 6h, 24h). The runner ticks every 60 seconds, claims an occurrence
  before enqueuing (`pending → claimed → fired | failed`, `cancelled` by a human),
  never fires on a terminal or archived task, and resolves the **live** deployment at
  fire time (ruling 94). A fire-time refusal no retry can cure (profile undeployed,
  stage-ineligible for a NEW engagement; the engaged deliverer fires at any stage,
  ruling 133) is a terminal `failed` with the reason on the timeline. A
  `run-operator` occurrence on a task that waits on other work (ruling 131(d)) is
  retired `fired` with a "Scheduled action skipped" note and outcome `skipped-held`
  (no run, no cost); a `run-agent` occurrence STANDS, because the ruling refuses
  operator triggers only: a person who scheduled an agent run on a held task gets it.
  A `run-operator` occurrence on a task with an open decision packet is retired the same
  way, outcome `skipped-packet`, spending no retry (ruling 141: the same paid no-op ruling
  76 refuses for a person); one that was queued behind a live drive records
  `queued-behind-drive` at fire time and, if the drive leaves a packet open, its final
  `skipped-packet` row (`atDrain: true`) and a "Scheduled action skipped" note when it
  reaches the front of the lease queue. A dispatch of any kind (the Run control, an
  @mention, the operator's `run_agent`, a schedule, `retry_other_backend`) into a
  backend the instance already knows is out of quota for the account the run bills is
  HELD (ruling 152(c), pass 35): no run, a "Dispatch held" note by the policy engine
  naming the reopen instant and the provider's own words, a `task.agent.run_held` audit
  row, and a `run-agent` schedule for one minute after the window reopens (thirty
  minutes after the refusal when the provider named no instant) carrying the same
  profile and prompt. The door reads "Held: Codex is out of quota until Sep 6, 2026 ·
  18:18 UTC; Developer's run is scheduled for then." A repeat dispatch inside the same
  window reuses that pending occurrence — one retry per profile per window, a newer
  directive replacing its prompt, no second note — so a cascade of held attempts cannot
  become a queue of duplicate runs at reopen. A hold is not a decision packet and
  costs no operator turn; a scheduled occurrence that lands on a hold retires
  `held-quota`. Resolving the quota or auth packet's option that states the window has
  reset (or that the account changed) retires the instance's exhaustion record for that
  backend: the option promises the agent continues now, and only a completed run would
  otherwise clear it (ruling 164).

## 10. Delivery

Delivery (push the task branch, open the review PR) is an operator decision executed
by the server (ruling 21); humans trigger it with the `deliver-review` intent
(`run-agents` or the owner). `performDelivery` makes sure the repository's default
branch exists first (ruling 128: an empty repository is bootstrapped, never
misreported as unreachable), pushes the workspace branch (auto-committing a dirty
tree, refusing a non-fast-forward as a `push_conflict`; refusing a tree that carries
Viberr's own store layout under `projects/<slug>/tasks/` as `store_layout` with the
paths named, ruling 159; reading origin's head first
and answering `up_to_date` when there is nothing to push, ruling 134; stamping
`workRevision.pushedAt` on the revision whose head the push published, ruling 161), detects a
verified empty branch as a no-change outcome, opens or adopts the PR (adoption only
when the PR is open **and** its head is the delivered revision; anything else is a
branch collision, whose `resolve_remote_collision` ceremony re-confirms a cached open PR
against GitHub before refusing and never strands on either arm, ruling 136), records
`github.pr.opened` (or "Pushed `<sha>` to PR #N" when a
push moved the head of the task's open PR), and either re-queues a full-autonomy
operator (`delivered`: a new PR or a moved head) or ensures a supervised operator left
a "Move to Review" recommendation. A PR Viberr did not open but adopts (open, head equal
to the delivered revision) is recorded as an adoption: a `github` event and the audit
row `github.pr.adopted` (F34-9); the reconciler's adoption also notifies the task's
watchers, the delivery's does not, because the person who asked for it is reading the
answer. Rework on a task whose PR is already
open is delivered the same way: the push moves the PR's head; nobody is ever asked to
push by hand. The task page offers the same door as "Push `<sha>` to PR #N" whenever
the open PR does not carry the delivered revision (ruling 134(c)), and shows a disabled
control naming the refusal for a diverged remote. Entering the review stage with no PR
writes a typed event, never silence. Ruling 163 (pass 35): a delivery that moved the
PR's head on a task standing PAST the stage where its reviewers can run, with a
revision that changed or failed after the last verdict, records the transition back to
that stage in the same delivery ("Transition: KNC-20 returns from Merge to Review: `17e4a8c`
changed after the last verdict, so the reviewers judge it there"; audit `task.transition`
with `via: delivery`). The redirect option of a branch-conflict packet does the same when
it is resolved (`rework: true` on the option; `via: packet_redirect`), and the option's
detail says so before the person decides.
Details in [github-delivery.md](github-delivery.md).

## 11. Acceptance and the endings

Every writer to the terminal stage goes through one contract:

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
   the PR (ruling 160; `closed_by_human` on every delivery door). Lower in the stack, a delivered revision
   that is not on the pull request refuses with "deliver the branch to push it" (ruling
   135) and outranks a conflicting PR, whose `mergeable` describes the head GitHub has,
   not the one that was reviewed; a conflicting PR refuses after it. Both sentences come
   from ONE function, `mergeReadinessRefusal` (ruling 162, pass 35), read by the
   acceptance stack, the operator's `get_task` (`notAcceptableReason`, computed by the
   whole stack through `acceptanceRefusalFor`), the operator's move into the
   acceptance-boundary stage, and the post-gate GitHub merge refusal: a 405 re-reads the
   pull, records `mergeable: conflicting`, and the person reads the gate's sentence with
   its way out instead of "GitHub refuses to merge ...". No surface offers an acceptance
   the gate will refuse: the task page's recommendation card prints the refusal as an
   alert and its Apply refuses the click, the accept dialog prints it above a disabled
   confirm, the GitHub card wears the "conflicts" pill, and the reconciler withdraws a
   pending `accept_completion` card the moment `mergeable` flips to conflicting, with a
   "Conflict:" note on the timeline.
3a. **The base refresh, once** (ruling 162 / G35-5(d)): after the gate re-check and
   before the merge, the acceptance ceremony brings the branch up to date with the base through the
   same workspace merge `update_branch_from_base` performs, records it in
   `baseRefreshes` (ruling 132), reconciles, writes "Accepting the completion brought
   `<branch>` up to date with `<base>` ..." on the timeline and audits
   `github.branch_update.acceptance`. A refresh that CONFLICTS refuses the acceptance
   with the gate's sentence, records `mergeable: conflicting` and names the conflicting
   paths on the timeline; a branch that cannot be refreshed from here (no workspace, no
   credential, a diverged origin) proceeds to the merge, where GitHub decides. The
   The refresh is itself an irreversible publish (the workspace merge is pushed), so
   the gate stack runs on BOTH sides of it: the packet path's identity check
   (P14-GV-05) and the full acceptance gate refuse before the branch is moved, and
   again afterwards, since the refresh changes the facts they read.
   The
   operator's own tool refuses at the acceptance-boundary stage and past it ("... the
   branch is brought up to date once, at acceptance time, and merged in the same
   ceremony"), except on a PR GitHub already reports conflicting, where its job is to
   record the conflict list and open the packet.
   Ruling 177 (pass 36): the acceptance (plain or forced) and an archive end the task's
   live runs through the run-service's closure interrupt, note them once on the timeline
   ("Interrupted by acceptance", every run named) and audit
   `task.acceptance.interrupted_runs`; a closed task refuses every coordination door
   afterwards, and a run that finishes after the closure records its report with a
   "Completed after the task closed" note and wakes no operator.
4. **Verdict gate**: every required reviewer must have approved the current revision
   and none may request changes (ruling 20). Force-accept bypasses this and is
   audited `task.acceptance.forced` with EVERY gate it bypassed (U35-3, pass 35:
   `bypassedGates` is the full refusal list in gate order, `skippedStages` the stage
   ids jumped, `validation`, `withdrawnPacket`; `bypassed` keeps the sentences joined
   with " | " for older readers), records `acceptance: forced`, and the forced
   `completion` event appends the same list, each gate reduced to its FIRST sentence
   ("Bypassed: Review skipped; the review gate; VIB-1 is at In Progress, not Review;
   This task's latest review requests changes on the current revision; the open
   decision "..." withdrawn unanswered"). The remedy half of each refusal
   ("Move the task through the workflow first") stays in `bypassedGates` only: the
   reader of a completion event is looking at an override that already happened, the
   same rule the audit panel applies to this row. Force never bypasses two facts: a closed unmerged
   PR (ruling 37) and, since ruling 123, an **archived** task — restore it first. Both are
   `forceIrreducibleRefusal`, and on an archived task the affordance is withdrawn rather
   than disabled. The offer itself appears only once the task has something to accept — a
   branch, a PR or a delivered revision — or is demonstrably wedged by an open `blocked`
   packet (ruling 124). Since ruling 164 (pass 35, F35-14) a packet can offer the same
   override as a `force_accept` option: the resolution calls `forceAcceptCompletion`
   itself, so the tier, the ceremony, the irreducible gate and the audit record are the
   button's, and a non-admin resolver hears the button's own refusal instead of a
   decision that records nothing.
4a. **Project-declared required reviewers** (ruling 178, pass 36, G36-3): for every rule
   in `project.md` `requiredReviewers`, the named agent must hold an `approve` verdict
   bound to the task's active work revision (an approval of a replaced revision is
   history, ruling 163), whether or not anyone engaged it; otherwise the refusal reads
   "Required reviewer <Agent> (project rule at <Stage>) has not approved revision
   <sha7>. Run the review at <Stage>, or an admin can force-accept." A task with no
   active work revision and no pull request (planning work, or a discarded revision)
   is not held. ONE pure gate, `requiredReviewerRefusals`
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
   Its sibling `move_stage` performs a manual board move
   on the stage picker's path; the terminal stage is refused there, because a move to it
   is this contract, not a move. Resolving a `move_stage` option lifts a stored
   `blocked` the packet was holding down, as every other resolution arm does: a
   transition deliberately lets a block survive, so leaving it would show a blocked
   task with no packet on it.
5. **PR head containment**: the PR head must contain the delivered commit. A head
   ahead of the reviewed revision is accepted with a disclosed divergence (ruling 42; since
   ruling 132 the disclosure is the classified drift sentence: authored commits are named
   unreviewed, a base refresh is named as one); a diverged head refuses; a compare GitHub answers
   404 to, confirmed by a 404 commit read, is a never-pushed revision and refuses with
   the same "deliver the branch" sentence (ruling 135) rather than passing as
   unverifiable. Force never bypasses this.
6. **Live no-change probe**: a branch with no commits or no branch at all routes into
   the **Completed, no changes** ending (still verdict-gated, ruling 62); `noChanges`
   is re-verified against the remote inside the lock so a branch that gained commits
   cannot ride a stale flag into Done.
7. **Write**: stage → terminal, `waiting: none`, packet and recommendations cleared,
   pending schedules cancelled, a `completion` event, then the merge. A **human**
   acceptance triggers a real async merge (`github.pr.merged`, or `github.pr.merge_refused`);
   a full-autonomy **operator** acceptance records `pr.state: accepted` and leaves the
   merge to a human (`complete-merge` intent) because `merge-pull-request` is always
   human (ruling 40). After a successful merge the `delete-branch-after-merge`
   guardrail (default on) deletes the remote task branch.

Post-acceptance: the task workspace is reclaimed once no run is live, goal chains
reconcile, held dependents are swept (ruling 131(e): a task whose every `blockedBy`
entry is now done is released), and the board renders "accepted".

**The review queue's membership** (`review-queue.server.ts`, U35-5, pass 35) has two
halves with two rules. "Waiting on your acceptance" is about the boundary: a
non-archived task standing at a stage acceptance is legal from (the acceptance
boundary the workflow graph declares, the same predicate the accept writer and the
board gate use, so a board with several edges into the terminal stage keeps them all)
that waits on a human, whose acceptance nothing in the stack above refuses, for a
viewer who may accept it (maintainer+, or the owner). "Still in review"
is about review work, which the board defines by engagements and verdicts rather than
by one stage id: every other non-archived, non-terminal task that sits at the review
stage, or carries a pull request open for review (`pr.state: review`), or has a
required reviewer (`verdictCapable`) whose verdict on the current revision is missing
(`validation: changed`) or is request_changes (`failing`). On the default board the two
rules coincide at Review; on a board whose reviews happen at Validation and Review while
the edge into Done leaves Merge, the second rule is what lists the work. The row names
its stage ("Review in progress at Validation · PR #8 · awaiting verdict"), with a live
pull-request fact taking the place of the verdict words when there is one ("Review in
progress at Validation · PR #8 does not carry the delivered revision 385047c. Deliver
the branch to push it." — ruling 135, and the same for a conflict or a drifted head),
the header
reads "N in review · M waiting on your acceptance", and the workspace rail badge is the
queue's `total`. Nothing before the boundary is ever offered for acceptance.

## 12. Archive and restore

`archive-task` (`approve-transition`) is a terminal disposition, not a delete: the
file, its timeline and audit rows survive; the card leaves the board's default view
and the review queue; the open packet and pending recommendations are withdrawn;
pending schedules are cancelled; `restore-task` brings it back. Archiving through a
`pr-diverged` recovery packet may also delete the remote branch. An archived task
cannot be moved. Archiving a task another task waits on does not release the
dependent (ruling 131(e)): before the archive returns, `noteDeadDependency` writes
one "Waiting on archived work" note on each dependent, notifies its owner and
supervisors once (`dependency`), and sets it `waiting: human`, because a person owes
the list an edit; the entry renders as archived until they make it. A restore sweeps
the dependents again.

An `archive_task` option with `deleteBranch: true` deletes the remote branch through the
same door every branch cleanup uses: a cached open PR is re-confirmed against GitHub first
(ruling 136(c)), a PR GitHub reports closed lets the delete proceed, and an unconfirmed
state refuses with "GitHub could not confirm whether PR #N is still open", which the
archive note repeats verbatim. The no-change acceptance's empty-branch cleanup inherits
the same check. Ruling 161 (U35-8): when the reconciler recorded `github.foreignHead`
(origin's branch carries commits this task did not author), the confirm dialog says so
before the button, the ref's head is read before the DELETE, and the audit records both
heads (`github.branch.deleted {sha}`, `task.branch.discarded {localSha, remoteSha}`).

## 13. Timeline and noise control

`## Timeline` in `task.md` is newest-first, `### <UTC ISO> · <type> · <actor ref>`,
with the eleven types in `TIMELINE_EVENT_TYPES`. `policy` is reserved for genuine
violations and refusals; neutral system remarks are `note`; `continuity` marks a
resumed session whose provider transcript was gone. A `note` titled "Recommendation
withdrawn" records an acceptance offer that no longer holds and why (ruling 137); it is a
system remark, never a `policy` event. The projection serves a bounded
newest-first slice and the page asks for older events on demand (NFR5). The
compaction guardrail collapses old routine comments into one marker once the
configured threshold is passed, keeping every typed governance event.

Files a run posted ride on its event as `attachments`, and the attachments panel lists
the whole directory. What a human sees there is not everything the run wrote: at
completion the browser MCP's machine-stamped working artifacts are pruned unless the
run cited the exact filename, and what survives opens in an in-app card with Download
(ruling 105 — [ui/surfaces.md §5](../ui/surfaces.md#5-copy-rules-that-tests-enforce),
retention in
[architecture/data-model.md §5](../architecture/data-model.md#5-retention-and-growth)).

## 14. Notifications a task produces

Kinds: `packet` (a decision waits, `ptype` `input | blocked`), `approval` (a stage
approval or acceptance waits), `mention`, `quality`, `policy` (a violation or
refusal), `controller` (goal progress), `dependency` (ruling 131: the work a task
waited on landed and it was released, or a dependency can never complete because its
task was archived; its own routing toggle, "dependencies"), and `ownership` (ruling
140(b): the reader's owner seat changed hands, addressed to that one person rather than
to the watcher set).
Recipients are the task owner plus project admins and maintainers, honouring each
person's routing toggles; a toggle off drops only the row, never the note, the audit
row or the operator re-invoke. Loading a
task page marks all of the viewer's unread notifications for that task read
(ruling 71); the bell and inbox mark-read explicitly.
