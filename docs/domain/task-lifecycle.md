# Task lifecycle

> How a task is born, moves, waits, gets reviewed, is delivered and is closed;
> and which server invariants hold at each step. Source of truth:
> `app/server/tasks/task-actions.server.ts`, `app/schemas/task-file.schema.ts`,
> `app/shared/workflow/*`, `app/shared/rbac.ts`. File fields are in
> [file-formats.md](../architecture/file-formats.md). Verified against `main`
> @ `68b5480` (2026-09-01). Updated 2026-09-02 for ruling 127 (branch
> `claude/per-user-codex-auth-difdnn`): §3 (creation seats the creator as owner)
> and §7 (whose accounts a task's agent runs bill, and what an unowned task
> refuses).

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
| `create-task`, `own-task`, `edit-task-meta` | ✓ | ✓ | ✓ | |
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
link's declared `blockedBy` both come in through this door.


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
   bare move to terminal; a supervised operator recommends instead of moving, except
   across `auto` boundaries and on a backward rework move while validation is
   `failing`.
5. Inside the file lock the stage is re-read: already there → write nothing; moved
   elsewhere → 409, because every guard above judged `fromStageId`.
6. On success: `previousStageId = fromStageId` (the durable "came back from Review"
   fact the operator weighs, ruling 98); terminal → `waiting = none`; leaving the
   entry stage attaches the operator and clears the triage gate; `task.transitioned`
   audit and a `transition` timeline event; the operator is re-triggered
   (`transition`); goal chains reconcile; held dependents are swept
   (`maybeReleaseDependents`, ruling 131(e)).

## 6. The three signals on a card

- **Readiness** (stored, 4 values): `ready | input_required |
  inconsistency_risk_detected | blocked`. The projection stores the derived value:
  diagnostics floor it (warning → `input_required`, error →
  `inconsistency_risk_detected`, hard stop → `blocked`); a `blocked` packet sets it to
  `blocked`; recovery options lift it back to `ready`. Surfaces render the derived
  display value `agent_working` instead of readiness while `waiting === "agent"`
  (`deriveDisplayReadiness`, ruling 91), `goal_edit_pending` while a decided `edit_goal`
  packet waits for the edited goal (ruling 138: below `agent_working`, above
  `input_required` and a stored `blocked`), and "accepted" for terminal-stage tasks.
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
note, no operator turn.

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
  posted and the run refused with the dispatcher's sentence.
- Comment bodies are escaped so that a line that would read as file structure
  (`## `, `### `, `title:`, `to:`, `evidence:`) cannot forge a section or an event.

## 8. Engagements, dispatch and verdicts

`engagements[]` is written by the dispatch (ruling 98). Running a deployed but
unengaged profile engages it: **delivering** iff the task has no deliverer and the
profile holds repo-write (`execute-code-or-write-repo` granted), **supporting**
otherwise. At most one engagement delivers; it owns the workspace, branch and PR.
A supporting engagement snapshotted with `verdictCapable: true` (an explicit
`report-validation-verdict: direct` grant at engage time) is a **required reviewer**.
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
stales every prior verdict. A reviewer's `report_outcome` records a **verdict**
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
  18:18 UTC; Developer's run is scheduled for then." A hold is not a decision packet and
  costs no operator turn; a scheduled occurrence that lands on a hold retires
  `held-quota`.

## 10. Delivery

Delivery (push the task branch, open the review PR) is an operator decision executed
by the server (ruling 21); humans trigger it with the `deliver-review` intent
(`run-agents` or the owner). `performDelivery` makes sure the repository's default
branch exists first (ruling 128: an empty repository is bootstrapped, never
misreported as unreachable), pushes the workspace branch (auto-committing a dirty
tree, refusing a non-fast-forward as a `push_conflict`; reading origin's head first
and answering `up_to_date` when there is nothing to push, ruling 134), detects a
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
writes a typed event, never silence.
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
   withdraws force-accept entirely (ruling 37). Lower in the stack, a delivered revision
   that is not on the pull request refuses with "deliver the branch to push it" (ruling
   135) and outranks a conflicting PR, whose `mergeable` describes the head GitHub has,
   not the one that was reviewed; a conflicting PR refuses after it.
4. **Verdict gate**: every required reviewer must have approved the current revision
   and none may request changes (ruling 20). Force-accept bypasses this and is
   audited `task.acceptance.forced` with what it bypassed, records `acceptance: forced`
   and enumerates the stages it skips. Force never bypasses two facts: a closed unmerged
   PR (ruling 37) and, since ruling 123, an **archived** task — restore it first. Both are
   `forceIrreducibleRefusal`, and on an archived task the affordance is withdrawn rather
   than disabled. The offer itself appears only once the task has something to accept — a
   branch, a PR or a delivered revision — or is demonstrably wedged by an open `blocked`
   packet (ruling 124).
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
the same check.

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
