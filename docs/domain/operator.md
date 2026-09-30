# The operator

> The Operator, the one agent that drives every task: what wakes it, what it may do, how
> its authority is gated, what it reads, the packets it opens, and the backstops that keep
> a task from stopping silently.
> Source of truth: `app/server/runtimes/operator-run.server.ts`,
> `app/server/tasks/operator-actions.server.ts`, `app/server/tasks/operator-toolkit.server.ts`,
> `app/server/tasks/operator-repo-read.server.ts`,
> `app/server/github/update-branch-operator.server.ts`, `app/server/tasks/task-actions.server.ts`,
> `app/server/tasks/stranded-sweep.server.ts`, `app/server/tasks/review-deadlock.server.ts`,
> `app/schemas/task-file.schema.ts` (`PACKET_OPTION_KINDS`).
> Line numbers are omitted on purpose; function names are stable, line numbers are not.
> Verified against `main` @ `7d9fbf72` (2026-09-23).

## 1. Role

Every project deploys exactly one operator (`kind: operator`, profile id
`operator`, ensured on every project at boot by `ensureBaseAgentsDeployed`). A task
records its operator when it first leaves the entry stage (`operator: {assignedAtStageId}`),
and the operator is auto-invoked from task creation onward. It never writes code and
never pushes by hand: it reads the task and the repository, scopes the goal, dispatches
deployed agents, opens decision packets, recommends or performs stage transitions,
decides delivery (the server pushes), leases shared files to its own task, schedules
its own task's later runs (ruling 487), proposes changes to the project's rulings, and,
under full autonomy with an explicit grant, accepts completion.

It is one agent, called Operator, with no role (ruling 518). Every surface shows it as
"Operator" over "Built in · runs on every task" (`OPERATOR_NAME`, `OPERATOR_SCOPE`);
no template or deployment renames it, gives it a role or rewords that line
(`OPERATOR_FIXED_FIELDS`, dropped when a deployment resolves). Its editor on Agents has no
Name or Role field and edits the rest: backend, model, effort, autonomy, stages,
description, persona, capabilities and grants. Boot removes the name, role and scope a
save stored on the deployment before the ruling.

Its persona is the doctrine file `agents/definitions/operator.md` plus the
`viberr-app-expertise` skill; both ship from `app/server/seed/assets/` and are
written into the store by the boot backfill. A project's customised operator persona is
appended to the shipped doctrine as "Project operator guidance", never in place of it.

## 2. Authority

`resolveOperatorAuthority(ctx, projectSlug, overrides)` reads the project's operator
deployment and returns the policy map (capability id → `direct | recommend | human |
off`), the effective `autonomy` (`supervised | full`) with `configuredAutonomy` and
`autonomyClampedFrom`, backend, model, effort, name, skills, knowledge bases (its own
grants plus the project's rulings KB, ruling 239, with `rulingsKb` naming it), MCP
grants, persona, whether the operator is deployed, and `humanGatedBeforeWork` (derived
from the workflow graph, never a stored preset).

- **Autonomy is a ceiling, not a pin** (ruling 67). A per-run level may sit at or
  below the configured one; a clamp that bites writes the audit fact
  `task.operator.autonomy_clamped`. The task page's run control shows the backend and
  offers Run; it picks neither backend nor autonomy (ruling 92).
- **An operator run bills the TASK OWNER** (ruling 127), like every other run on a task:
  `runOperator` resolves `resolveTaskRunPrincipal` before it starts anything and spawns
  with that person's own Claude or Codex credential. Authority is still the operator's
  own capability policy — whose account pays and what the run may do are separate
  questions — but a task with no owner, or an owner who has not connected the operator's
  backend, gets an honest refusal run and no process, and the task page's Run control is
  disabled with the same sentence. A react chain follows the operator deployed NOW, not
  the backend the chain started on (ruling 231).
- **One gate, with an absent-polarity table.** `gate(authority, id)`: `direct` → act;
  `recommend` → act only under full autonomy, except `completion-for-acceptance`, which is
  never promoted; `human`/`off` → deny; not deployed → deny. Four capabilities postdate
  live deployments and resolve an ABSENT grant to a derived default inside `gate()`
  itself (`absentPolarityGate`): `deliver-review-pr` from
  `absentDeliverReviewPrMode(humanGatedBeforeWork)` (ruling 28), `dispatch-agents` to
  `direct` (it replaced two retired ids in ruling 98), `update-task-branch` to whatever
  delivery resolves to, and `use-web-search-fetch` to `direct`. `deliverGate`,
  `dispatchGate` and `updateBranchGate` are the named fronts for those.
- **Operator capabilities** (`UNIFIED_CAP_CATALOG` in `app/shared/capabilities.ts`, kind
  `operator`): `dispatch-agents`, `generate-packets`, `append-typed-events`,
  `stage-transitions` (default `recommend`), `completion-for-acceptance` (default
  `recommend`, not promotable), `deliver-review-pr`, `update-task-branch`,
  `use-web-search-fetch`.
- `off` is a hard refusal on every route to the action, checked before any read,
  card or audit row (ruling 60). The operator refuses out loud and narrates it.
- **The boundary always wins** (ruling 151). A `stage-transitions` grant of `direct` (or
  full autonomy promoting `recommend`) crosses `auto` boundaries only. A declared
  `approval` boundary always files a transition recommendation a human applies, whatever
  the autonomy or the grant mode; a declared `human` boundary is refused with a sentence;
  the terminal stage is reachable only through acceptance. `transitionStage` enforces the
  same rule for every operator-authorized caller, so a `task.transition` row with
  `by: operator` and `boundary: approval` cannot be written. Rework moves on a failing task
  (R7-4) are performed directly.

## 3. Triggers

`RunOperatorInput.trigger` is a closed union that selects the turn doctrine:

| Trigger | Posture | Fired from |
|---|---|---|
| `create` | coordinate (triage) | `createTask`, except for a task it releases at birth, which the release hands over |
| `transition` | coordinate | a human or system stage move (never the drive's own move, see below); the stranded-drive backstop's nudge |
| `goal-updated` | re-scope | `updateTaskGoal` |
| `agent-reply` | react | the agent completion pipeline |
| `pr-diverged` | recover | the GitHub reconciler on an out-of-band PR change |
| `delivered` | proceed | a full-autonomy delivery that opened a new PR or moved the head of the task's open PR, made outside a drive (rulings 48 and 134); for a delivery a drive made itself, the drive's lease release, only when the drive stopped right after delivering (`deliveredFollowUpFor`, ruling 357) |
| `packet-resolved` | proceed | `resolvePacket`, when no asking agent absorbed the answer, or when the answer names another actor (ruling 447). The payload carries the option (kind, title), the person's own note, and, for a ceremony that performs work of its own (`resolve_remote_collision`), Viberr's record of what it did in a separate `serverOutcome` field rendered as Viberr's sentence, never inside the quoted note (ruling 136(a)) |
| `dependencies-released` | proceed after a hold | the release engine (ruling 131(e)): the payload names what was waited on and who cleared it; the doctrine says the base branch has changed since the hold and that a hold packet the operator opened itself is now moot. A release at birth (`createTask`, when every entry was done before the task existed) carries `atBirth`, and the doctrine says instead that nothing held the task and there is nothing to bring up to date (F39-65) |
| `head-unpushed` | deliver | a person's refused acceptance whose cause is an unpushed reviewed revision, which only the operator can push (ruling 235) |
| `pr-conflicting` | resolve the conflict | a person's refused acceptance whose acceptance-time refresh met a conflict (ruling 332), or the reconciler's flip of an open PR to conflicting (ruling 475(b)); the instruction names both origins |
| `gates-failed` | rework | Viberr's own run of the project's gates on the revision under review finished with a gate that did not exit 0 (ruling 482). The turn names each failing gate, its command and its log's attachment name, tells the operator to `run_agent` the deliverer with them and deliver the fix, and forbids asking an agent to re-run the gates to report them |
| `stranded` | decide what happens next | the stranded-task sweep (§3.1, ruling 330) |
| `relayed` | read what arrived | another task of the project relayed text here (ruling 488): the operator's `relay_to_task` there, or a specialist's `relay` entry posted at its completion. The payload (`relay`) carries the source task, the author's name, the text and the relayed comment's stamp; the turn quotes the text (cut at `AGENT_REPORT_CAP_TOOLLESS`, with the stamp for the rest), says it is data, says to act on it when it delivers what the task waited for, and forbids asking a person to copy it or confirm it arrived. It goes first, ahead of the held doctrine, the way a person's comment does. Not refused by an open packet or a dependency hold |
| `scheduled` | re-check | the schedule runner; the turn says who set it ("a human set earlier", or "you set earlier yourself" for the operator's own entry, `scheduledByOperator`, ruling 487) |
| `manual` | coordinate | the Run-operator control, an `@operator` comment, boot recovery, the controller's `run_agent_on_task` |

`autoInvokeOperator` is the shared fire-and-forget seam; it is a no-op when no
operator is deployed, and when the hand-off throws before a run row exists it writes a
timeline note giving the reason and saying that was one attempt, not a decision to stop.

**The transition re-trigger** (ruling 152(a)). A transition made by a LIVE operator run
(the ctx carries `operatorRun`) queues no fresh turn: the `transition_stage` reply names
the next boundary ("The next boundary, Impl to Validation, is auto: continue in this turn
when nothing at Impl needs an agent"; "... is approved by a human: recommend it when the
work is ready") and the prompt says to walk consecutive `auto` boundaries in one turn (a
Codex plan carries the walk as one `transition_stage` per stage, ruling 450). Human and
system moves still re-trigger. A chain the model abandons is the stranded-drive
backstop's job. The fold (owner decision Q35-15): when a move lands on the acceptance
boundary (the review stage, or any stage with a declared edge into the terminal one), the
acceptance recommendation is filed in the same act, under the deployed operator's own
acceptance gate, instead of by a second turn: the operator's own move folds it into its
reply, and a person's move (an applied "Move the task to Merge" card, a board drop) folds
it before the re-trigger and skips the turn when the card was filed. A full-autonomy
operator holding a direct acceptance grant is never folded into an acceptance; a refused
gate leaves no card and the reply (or the re-invoked turn) says why.

**Holds** (rulings 157 and 216). A stored `blocked` with no open packet and no
`blockedBy` list is a hold (the `hold_runtime_debug` decision, the refused arm of a
collision ceremony). Before `markWaitingAgent`, `runOperator` calls `liftHoldForRun`
for a person's `manual` run (`actor` set: Run operator, an `@operator` comment, the
controller) and for a `scheduled` run: `readiness: ready`, a "Hold lifted" note naming
who started the work, and `task.hold.lifted {cause: "operator-run", trigger,
byUserId}`. A person's press also ends a recorded deliberate STAGE hold
(`liftStageHoldForPerson`, clearing `heldAtStage`); a schedule does not. A bare `manual`
with no actor (boot recovery) and every machine trigger lift nothing; an open packet keeps
the withdrawal paths as the only lift; a dependency list keeps ruling 131's floor. Every
dispatch lifts the same way (§4.1 of agents-and-runtime). The lift is not a claim that the
cause is fixed: the operator re-checks and opens a new packet when the block stands.

**Fire-time refusals** from `runOperator`, each before any run row exists and each
settling `waiting` itself (`settleWaitingAfterOperator`), so a trigger drained off the
lease queue never strands `waiting: agent`:

- `closed` (ruling 177): a task at its terminal stage or archived (`taskClosure`) refuses
  EVERY trigger; the refusal carries `refusalReason`, the one closed-task sentence
  `closureRefusal` builds. Reopening a closed task is a human stage move, and the
  transition that reopens it is the trigger that coordinates again.
- `blocked-by` (ruling 131(d)): while the task's `blockedBy` list is non-empty the
  `create`, `transition` and `scheduled` triggers are refused (`HELD_TRIGGERS`); the
  reactive triggers still run, under the held doctrine (§4). A scheduled occurrence is
  retired `fired` with a "Scheduled action skipped" note and outcome `skipped-held`.
- `open-packet` (rulings 76, 141, 195): a `manual` or `scheduled` trigger while a packet
  is open is refused (`PACKET_REFUSED_TRIGGERS`); machine reaction triggers such as
  `pr-diverged` and `agent-reply` are not. A scheduled occurrence is retired `fired` with
  outcome `skipped-packet`. With a packet open the settle leaves `waiting: human`, the
  packet's own owner.

A `manual` trigger refused at the door is noted on the task (ruling 227: an `@operator`
comment is a person who is owed an answer); a queued trigger refused when it reaches the
front of the lease queue is noted by `noteQueuedTriggerRefused` (ruling 141). The
stranded backstops treat a non-empty `blockedBy` as a recorded hold and never nudge.

**Single-flight per task.** One drive at a time, held by a process lease from
`runOperator` entry through provider completion and, for Codex, plan execution. Queued
triggers coalesce per kind: machine triggers keep only the latest (the deeper
`transitionDepth` and a `strandedResume` mark survive the overwrite), while
reason-carrying triggers (a human `@operator` comment, a scheduled re-check, a relay from
another task, ruling 488) queue FIFO
up to 8 (`MAX_PENDING_CARRIED_TRIGGERS`; an overflow drop is noted on the task) and drain
oldest-first ahead of the machine slot. Consecutive comments from the same author merge
into one turn. A restart-orphaned run is finalized (`interrupted`, reason `restart`) and
the trigger driven at once rather than chained onto a dead callback.

**Loop caps.** `OPERATOR_REACT_DEPTH_CAP = 4` (agent-reply reactions that got nowhere),
`OPERATOR_REACT_HOP_CEILING = 12` (every agent-reply reaction since a person last acted,
ruling 489(d)),
`OPERATOR_TRANSITION_CHAIN_CAP = 8` (consecutive operator-authored transitions and
stranded resumes; a human move resets the chain), and a boot recovery re-invoke cap of
`RECOVERY_REINVOKE_CAP = 3` per task per 30 minutes. Hitting a cap opens a stuck-loop
packet (or, for the stranded resume, leaves a note) instead of looping.

The react depth counts hops that got nowhere, so a reply that reached a boundary resets it
to 0 before the cap is checked: a reply whose recorded verdict is `approve` (ruling 362),
and a reply whose hop moved the task's head (ruling 489). The head signal is the one the
server writes, never the agent's prose: `headMovedSince` (`react-progress.server.ts`)
reads the active work revision after the completion's workspace reconcile, and the hop
moved it when a `delivered` revision was minted, or a revision's `pushedAt` was stamped by
a delivery push, at or after the finished run's row was created. A head reached only
through Viberr's own base refreshes mints nothing (ruling 439), and an `external` or
`verified` revision is not the chain's progress. A reply that leaves the head where it was
counts every hop, so a loop that gets nowhere is still capped. A task already acceptable
when the cap is reached gets no packet (ruling 258). Otherwise the depth-capped "Work
stalled: pick a recovery path" packet says where the work stands (`stuckLoopStandings`):
the first paragraph of the report that hit the cap (heading marks and the `cc` line
dropped, capped at 280 characters), the task's head and whether it is delivered (pushed by
a delivery, or carried by the live PR), and the last gate result on record (ruling 482).
When the head is committed and not delivered, its recommended option is `deliver_for_review`
("Deliver <sha7> for review"), with the stock redirect and send-back options beside it,
unrecommended, and the hold after them.

Because progress resets the depth, a second bound counts every hop:
`OPERATOR_REACT_HOP_CEILING` (3 × the depth cap = 12) react hops since a person last acted
(ruling 489(d)). The count rides the chain as `reactHops`: the react hands the operator one
more, the drive keeps it on `ctx.operatorRun` for every agent it dispatches, and the drive's
own `delivered` follow-up and stranded resume carry it on. A trigger a person causes carries
none, so a comment, a packet answer, a Run press or a person's own dispatch starts it over;
in the lease queue two of the chain's own triggers keep the deeper count, and a person's
trigger overwrites it. A moved head does not restart it; an approve does (ruling 362), and
an acceptable task at the ceiling gets no packet (ruling 258). Otherwise no operator turn
follows the twelfth hop, and the stuck-loop packet opens with the same state lines, its
reason "The chain made progress but ran 12 hops without a person or a boundary." A restart
loses the count, as it loses the depth.

### 3.1 The stranded-drive backstop and the stranded-task sweep

**At settle** (`settleWaitingAfterOperator` → `maybeResumeStrandedOperator`), when no run
is live on the task, a finished drive whose task is stranded gets ONE resume nudge (a
`transition` trigger with `strandedResume: true`) instead of a flip to "waiting on you".
`operatorLeftTaskStranded` says a task is stranded when it is not archived, has no packet,
no pending recommendation, no `blockedBy` and no pending schedule (ruling 487: a run with its
time on the record will move the task, so the nudge that told the operator to "record the
hold" with a packet no longer comes), and any of: the drive's own last transition
landed it on this stage (`ctx.operatorRun.movedToStageId`, ruling 152(a) — its move queues
no re-trigger, whatever the new stage's boundary); the drive's whole plan was refused
(ruling 228); the drive refreshed the branch and stopped without delivering (ruling 442);
or the stage's outbound boundary is `auto`. Only a drive that knows its starting stage, has
a run row and finished cleanly is judged; a stage someone else moved during the drive
belongs to that move's own re-trigger. The nudge's instruction says why it came: a
plan-refused nudge quotes every refusal in full (rulings 400, 408), a refresh nudge says a
refresh only prepares the step that follows (`REFRESH_ENDED_NUDGE`).

A nudged drive that again ends stranded WITHOUT progress — no stage move away from where
it started, no delivery, and no action carried out at all (rulings 202, 406) — records a
deliberate hold (`heldAtStage`) with a note, and later external triggers find the hold
and stay quiet until a person re-litigates it (a transition, a packet resolution, a goal
edit, a person's Run). When the nudged drive's plan was wholly refused again, the note
says the operator was STOPPED, not holding, and names the three remedies (ruling 399).
The nudge chain shares `OPERATOR_TRANSITION_CHAIN_CAP`; at the cap a note says the
operator ended that many runs without advancing, opening a packet or engaging an agent.

**The periodic sweep** (ruling 330, `sweepStrandedTasks`, riding the schedule runner's
60-second tick after due schedules fire) watches for the STATE rather than a cause: an
open task in an unarchived project, untouched for 15 minutes (`STRANDED_AFTER_MS`), with
no packet, no recommendation, no live or queued run, no `blockedBy`, no queued reviewer
question (ruling 241), no pending schedule, and not closed. It writes a "Nothing is moving
this task" note naming what it checked (also its idempotence key while it is the newest
entry) and invokes the operator with the `stranded` trigger.

## 4. The turn

The system prompt is built once per drive by `buildOperatorSystemPrompt` as a static block
and a per-task tail (ruling 370): the shipped definition and the project's operator
guidance, the attached skills (verbatim) and knowledge-base INDEXES (ruling 283, every
document with its size class and sections, read on demand; the project's rulings KB with its
note, ruling 286), sorted by name, the two-kinds-of-ruling note (ruling 312), the runtime
ground truth (backend, model, effort, the attached MCP servers in name order), the measured
shell inventory (ruling 191), the live capability policy (rows sorted by id), the triage
signals, the non-negotiable rules and the writing guide (ruling 502) close the static
block; the workspace section (the checkout's repository, branch and directory, and what
the run may write), the MCP governance and write-tool notes, the servers that failed their
probe or did not mount and the grants whose content did not arrive follow it as the tail.
On Claude the two blocks
reach the SDK as a `string[]` with `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` between them, so the
static block is one cache entry shared by every task of the project and the tail its own;
on Codex the same text, in the same order, is joined into `developer_instructions`. The
operator is a fresh session per turn on both backends, carries no context window (its
turns peak under 100k) and asks the provider for no cache lifetime (ruling 374). The
trigger doctrine and the task snapshot stay in the user turn.

The writing guide (ruling 502) is the Humanizer skill (`blader/humanizer`, MIT), vendored
unchanged in `app/server/runtimes/humanizer/` and pinned by hash. `HUMANIZER_PROMPT_SECTION`
("# How you write") frames it and then carries its body: the operator writes all its prose
by it, in its embedded mode (the final text only), below every other instruction in the
prompt, and never names it. It rides every drive on both backends whatever the project's
persona and skill grants say. It is no grant, so the Agents page and the run's
`run_inputs` skills row never list it; `personaChars` counts it with the rest of the
prompt.

`operatorTurnDoctrine` builds the trigger-specific instruction and
`operatorTurnInstruction` wraps it for every trigger: it PREPENDS, in order, the
unfinished report a failed run left standing (ruling 397), the refusal nothing has
answered yet (ruling 408), the person's decisions on the task (ruling 415), the
collisions with other open PRs (ruling 413), where the branch refresh is refused
(ruling 424), a behind count that describes an older head than the branch now carries
(ruling 494: the snapshot's `baseBehindBySentence`, plus "A decision packet never states a
behind count for a head other than the one the packet puts up."; nothing when the count
is current), whose the open packet is (ruling 437) and the runs already scheduled on the
task with whose each is (ruling 487: a hold one of them explains needs one note and no
packet), and it APPENDS the capability-gap
remedy clause (ruling 85: a packet must name the grantable capability and where a human
grants it, not only workarounds). The backend prompt builders wrap the result; the
Codex prompt adds `CODEX_PLAN_WHOLE_TURN` (nothing re-invokes it for a step of its own,
so a refresh goes in the same plan as the step it prepares, ruling 442). The default
arm states that `liveRuns` is the only proof a run is in flight: `waiting` is a display
flag and a directive comment is not a running agent. The pre-work rule says to call
`transition_stage` again in the same turn when the new stage's outbound boundary is
`auto` and nothing there needs an agent (ruling 152(a)). While the snapshot's `blockedBy`
is non-empty (ruling 131(d)) the held doctrine REPLACES the trigger's instruction and the
stage-rule tail rather than following them, so the prompt never carries two
contradictory orders: it names every entry with its live state and the one tool that
changes the wait (`set_dependencies`), forbids advancing the stage and opening a packet
about the wait, says `run_agent` and `deliver_for_review` are refused while the task is
held (rulings 186, 240), and says that ending the turn with one concise comment is
correct.

**The review loop.** Each ENGAGED reviewer carries `consecutiveRequestChanges`
(ruling 193): its successive request-changes verdicts, counted back from its newest and
reset by its own first approve; a re-review that blocks the SAME revision again counts as
another objection (ruling 204), and a re-dispatch that records no verdict counts as
nothing. At TWO the move is the operator's and it is not another rework (ruling 410):
run that reviewer once with no rework behind it, `completeness: true` on the `run_agent`
(ruling 421, so the verdict it returns is recorded as the complete set), and rework ONCE
against the whole answer. When the reviewer names something outside the work — a tool the
shell inventory says is absent, a baseline the repository does not have yet, a decision
nobody has made — the deliverer owes nothing: say so in one comment and
`open_decision_packet`, naming the real exits (drop or replace the required reviewer,
accept past the gate, fund the baseline as its own task). At THREE
(`REVIEW_DEADLOCK_ROUNDS`) Viberr opens the deadlock packet itself inside the verdict's
locked write, offering `question_reviewer` among its options (ruling 237); when another
packet is open at that instant the escalation is skipped and raised again when that one is
answered (ruling 328).

**Text for another task** (ruling 488). The non-negotiable rules carry it whatever the
persona says: text meant for ANOTHER task of the project is posted there with
`relay_to_task`, an agent's `relay` entries are posted for it, and nobody is handed text
to copy between tasks or asked to confirm a relay landed. The `agent-reply` instruction
says a "Relayed to …" line means the agent's relay already went out, and to relay the
work itself otherwise.

**A task whose deliverable is a result** (ruling 531; the boards of ruling 530). Two rules
live in `result-delivery.server.ts` and reach every drive on both backends. The triage gate
carries `RESULT_GOAL_RULE`: such a task is concrete when it names the result, the files it
comes back in on the task and the reviewer whose approval proves it, and it is scoped from
its goal, the rulings and its attachments, not from the repository. The stage rule and the
`agent-reply` instruction (which returns before the stage rule) carry
`RESULT_DELIVERY_RULE`: the files its delivering agent saves on the task are the delivery,
so the operator hands delivery to the agent that makes the result (`run_agent` with
`delivers: true`, which needs only that the agent can post files on the task, ruling
535), directs it to commit nothing, and never calls `deliver_for_review` for it, even
when something was committed. The shipped doctrine quotes both word for word.

**Knowledge the work proved wrong.** The `agent-reply` instruction carries two duties
about knowledge bases. A reviewer's objection to a defect CLASS the rulings have no
convention for is written into the rulings as that convention (ruling 418). And a report
that says a passage in a knowledge base is wrong (a version, a path, a command, a step it
measured), with no correction of it on the timeline, is relayed with
`correct_knowledge_doc` into that document with the agent's evidence (rulings 483 and 498).
A Codex agent makes its own through the gateway's `viberr_knowledge` server (ruling 585);
only when the gateway is not running does it have no tool, and then its prompt tells it to
end its report with a `Knowledge-base correction` section, the passage exactly as the
document has it, for exactly this. Either is written at once; a person undoes what they
disagree with.

`get_task` returns the `OperatorTaskSnapshot` (JSON-embedded in the Codex prompt):

- **The task**: key, title, goal, priority, labels, due date, stage and stage name,
  `previousStage` (so "back from Review" reads as rework), readiness, waiting,
  `validation` (derived: `healthy | failing | changed | none`), owner, `blockedBy` (each
  entry with its resolved state, ruling 131), `stageIds`, `doneStageId`, `reviewStageId`,
  `workStageId`, `nextStages` (with boundaries), `reworkStages` (the earlier stages the
  operator may move the task to directly: while validation is `failing`, and the one move
  back to the review stage a `changed` revision licenses, ruling 163), `repo`, `branch`,
  `noChanges`, `liveRuns`, `schedules` (ruling 487: the pending entries on the task, each
  with its action, due time, profile, prompt, `by` and `yours`, true for one the operator
  scheduled itself).
- **Agents**: `specialist` (the deliverer), `reviewers` (each with its own verdict on the
  current revision and `consecutiveRequestChanges`), `requiredReviewers` (ruling 178: the
  reviewers the PROJECT requires per review stage, each of which must hold an approve verdict
  on the delivered revision before acceptance whether or not anyone engaged it),
  `deployedSpecialists[]` with `eligibleForCurrentStage` meaning "may RUN here" (declared
  stages, or the engaged deliverer, ruling 133), `engagedAsDeliverer` and each agent's own
  `capabilities` (delivery, verdict, askHuman, browser, web), and `operatorPolicy`
  labelled `scope: "operator"` with a note, so the operator cannot mistake its own web grant
  for a specialist's. `orgResources` names the instance's KBs, skills and MCP servers, so
  "exists but not granted here" is distinguishable from "does not exist".
- **The PR**: number, state, title, `revisionDrift` with the canonical sentence, `headSha`,
  the current `unpushedRevision` with the acceptance gate's own sentence (ruling 135),
  `mergeable` (ruling 162); `notAcceptableReason` (the acceptance gate's own verdict,
  ruling 162), `unownedPr`, `foreignHead` (ruling 161), `baseBehindBy` (how far the base
  is ahead of the branch from the reconciler's last compare: `0` is level, `null` is "not
  compared yet" and never a reason to skip `update_branch_from_base`),
  `baseComparedHead` (ruling 494: `{sha, observedAt, current, pushedSince}`, the head that
  count was counted on and when; `current` is false when the count was not read on the head
  Viberr's newest push published, `pushedSince` naming it: the push came after the
  compare, or the compare right after the push read another head because GitHub had not
  shown the push yet. It is null when the compare named no head, a row written before the
  ruling; neither is ever read as current) with
  `baseBehindBySentence` (what to say instead of quoting the count, "" when it describes
  the current head), and
  `notRefreshableReason` (the sentence `update_branch_from_base` refuses with from where
  the task stands, ruling 424). `gates` (ruling 482): the project's gates as Viberr ran
  them on the revision under review, `{line, state, failed[], error}` with the PR card's
  own line ("Gates on `<sha7>`: N/M exit 0 (run by Viberr)"), or null when the project
  declares none or nothing is delivered. While gates are declared, the stage rule and the
  `delivered` turn carry a gate rule: Viberr runs them, the record is the result, and
  `accept_completion` is never offered or performed while `gates.state` is not `passed`.
- **Decisions and history**: `openPacket` and `packet` (type, title, body, options,
  `awaiting`, `raisedBy`, `yours`, ruling 437), `recommendations` (pending and recently
  declined, at most 5 each, so a supervised operator does not re-propose a just-dismissed
  move), `humanDecisions` (every decision a person made on the task, newest first, read
  from the whole timeline with their own words; ruling 415), `recentTimeline` (default 6
  entries, `events` up to 50), `timelineTotal` and `timelineOlder` (ruling 302),
  `unfinishedReport` (ruling 397), `unansweredRefusal` (ruling 408).
- **The board around it**: `epic` (ruling 503: the epic this task is in, its status, its
  description clipped at `EPIC_DESCRIPTION_CAP`, and its OTHER tasks, archived ones left
  out, each with its stage and `blockedBy`; absent for a task in no epic; it replaced
  ruling 402's `goalChain`), `openEpics` (the project's open epics, for `set_epic`),
  `collisions` (the other open review PRs whose
  diff shares a file with this one, ruling 413), `fileLeases` (the leases that bind now,
  ruling 431).

Each `recentTimeline` entry is cut at 1,500 characters for an operator that can call
`read_timeline_entry`; a Codex operator, which returns a plan and cannot call tools, is
handed up to `AGENT_REPORT_CAP_TOOLLESS` (16,000) for each window entry, every decision's
words, the unfinished report and the report that woke it, and a cut past that says so
(ruling 440). A Claude operator's prompt carries the waking agent report cut at 4,000
characters.

**The repository.** Before triage the operator's drive provisions the repository view
(`ensureOperatorRepoCheckout`, ruling 55): the SHARED task workspace, the delivering
agent's own checkout, which stands on the task branch once that agent commits. A clone
failure is a first-class `unavailable` arm carrying git's redacted complaint. The Claude
operator reads it with `Read` / `Grep` / `Glob`; what the DEFAULT branch holds is answered
only by `read_default_branch_file`, which reads the project's bare mirror (falling back to
the checkout's clone-time `origin/<default>` and saying it may be stale) and pages long
files by whole lines (`fromLine`, 40,000 characters a page; ruling 436). A checkout of an
EMPTY repository (HEAD with no commit) is initialized first: the server makes the default
branch's first commit (ruling 128's bootstrap) and moves the checkout onto it, and the
doctrine tells the operator an empty repository is never a person's chore, so it never asks
anyone to push a first commit (ruling 468).

**Backends.** Writes and shell are denied on both. On Claude the operator gets the
in-process MCP server `viberr` (loaded up front, `alwaysLoad`), its granted org MCP servers
with marked write tools withheld (ruling 176), and the deny list
`OPERATOR_READ_ONLY_DENIED_TOOLS` (`Bash`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`).
On Codex it runs in a scratch working directory with the task store and checkout read-only
and returns a structured plan over seventeen verbs (`post_comment`, `open_packet`,
`resolve_packet`, `set_goal`, `run_agent`, `transition_stage`, `deliver_for_review`,
`update_branch_from_base`, `accept_completion`, `flag_context_conflict`,
`set_dependencies`, `set_epic`, `correct_knowledge_doc`, `lease_files`,
`schedule_task_action`, `cancel_task_schedule`, `relay_to_task`, `take_from_task`), the schema narrowed to what its policy allows
(`operatorPlanToolsFor`; the two schedule verbs only on a `direct` dispatch grant, and never
in the all-denied fallback) and its packet options carrying every payload the
Claude tool does (ruling 433). `relay_to_task` takes the target in the plan's `taskKey` and the files it carries in `files` (ruling 538)
field (required and nullable, ruling 488) and the text in `text`, and like `post_comment`
it still posts after a step of the plan opened a packet. The server executes the plan after the run
(`runtime.operator.plan_executed` is the idempotency marker boot recovery reads). Once a
step leaves the task holding a packet it did not hold when the plan began, the remaining
acting steps are not carried out and a note lists them (ruling 430); a step whose outcome
IS the packet it opened is not narrated as refused (ruling 443); a dispatch carries the
refusals the plan collected before it (`withEarlierRefusals`, ruling 446).

## 5. Tools and the governed actions behind them

A withheld capability means the tool is **not built**; the model cannot reach it. The
`viberr` server holds up to 23 tools.

| Tool (`viberr`) | Action | Capability |
|---|---|---|
| `get_task` | `operatorSnapshot` (§4) | always |
| `read_board` | `readBoardList` / `readBoardTask`: this project's tasks, or one task by key, archived included (ruling 282); one task carries its `outcome` once it has one, the current completion summary and each current verdict's report (read whole from its "Review verdict" comment, not the 2,000-character stored excerpt), each up to 8,000 characters (ruling 569); a goal past 2,000 characters comes back as its opening with every decision recorded on it kept whole (rulings 289, 579); one task also lists its `timeline`, every entry by stamp, type, author and title, newest first, the newest 200 (ruling 596), and its kept `deliveries` (ruling 597) | always |
| `read_task_attachment` | one of this task's attachments: an `.xlsx` as its sheets in CSV, an image as the picture, any other file whose bytes are text as text whatever its name, a binary one named and refused (rulings 293, 533, 574), 40,000 characters at a time with `offset` reading on from a truncated read's `nextOffset` (ruling 551); with `delivery`, a stamp from `read_board`'s `deliveries`, the file as that delivery held it, not as a rework left it (ruling 597) | always |
| `read_timeline_entry` | one timeline entry in full, by its `occurredAt` stamp: this task's, or with `taskKey` another task's, by the stamp `read_board` lists in that task's `timeline` (rulings 285, 596) | always |
| `read_knowledge_doc` | one document of a KB attached to the operator (ruling 283) | always, when it holds a KB |
| `read_default_branch_file` | anchored default-branch read (§4) | always, when the run has a checkout |
| `post_comment` | `operatorPostComment` (guardrails applied, §7; narration stored verbatim, ruling 104) | `append-typed-events` |
| `relay_to_task` | `operatorRelayToTask` → `relayToTask` (ruling 488: posts `text` on ANOTHER task of this project as the operator's comment headed "From <this task> (operator):", audits `task.relayed {from, to}`, wakes that task's operator with the `relayed` trigger and writes "Relayed to <task>: <first line>…" on this task; refuses another project (`denied`), this task, a missing task and a closed one, Done or archived (`noop`)); `files` (ruling 538) copies named attachments of this task onto that task's attachments, claimed by the relay comment and named in it, all or none, never over a different file (the next free name instead), `task.relayed` then carrying `files` | `append-typed-events` |
| `take_from_task` | `operatorTakeFromTask` → `takeFromTask` (ruling 557: copies named attachments of ANOTHER task of this project, open or Done but not archived, onto THIS task, claimed by the operator's comment headed "From <that task> (operator):" (a relay's header, so no run here is credited with them), writes "Taken by <this task>: …" on that task and audits `task.files.taken {from, to, files}`; the relay's file checks, all or none; refuses this task, another project's task, a missing task, an archived source, a closed THIS task) | `append-typed-events` |
| `set_goal` | `operatorSetGoal` (fills only an unspecified goal; refuses to overwrite a specified one). Its `goal` field is described with `DONE_SIGNAL_RULE`, as are `goalDraft` and `newTask.goal` (§6) and, in the Codex plan, the `text` that carries `set_goal`'s goal (ruling 492) | `append-typed-events` |
| `flag_context_conflict` | `operatorFlagContextConflict` (repo convention vs KB, ruling 56) | `append-typed-events` |
| `correct_knowledge_doc` | `operatorCorrectKnowledgeDoc` → `correctKnowledgeDoc` → `mergeKbCorrection` (rulings 378, 483, 498 and 581: writes `text` in place of `replaces`, the exact passage, which must stand once in the settled text (an empty `text` deletes it), or at the end of the document when `replaces` is omitted, in a document of any knowledge base a run on the task was given, the operator's own or an engaged agent's; `kb` omitted means the project's rulings; when the written text would not stand once afterwards the record takes the lines around it (ruling 581), each side at most 8 KB; an addition the document already holds, or a correction whose record still stands, is a `noop`, and so is text a person undid in that document, naming them and their reason; refuses a knowledge base no run on the task was given, a project with no rulings KB when `kb` is omitted, and a document the knowledge base does not hold, a missing passage with the document's closest lines; writes a `kb_correction` event titled "Rulings corrected" or "Knowledge base corrected" and audit `task.kb_correction.merged` carrying both passages and the evidence, and notifies nobody; ruling 418 widens its use to a convention review shows is MISSING, and ruling 483 to relaying a correction an agent's report proved; a person undoes it from the Controller page) | `append-typed-events` |
| `edit_comment` | `operatorEditComment` (ruling 584: edits or deletes a comment the operator or an agent wrote on this task, itself and silently; an edit keeps the author, time, title and files, a delete takes the entry off, and the linked notifications follow; a person's comment is refused; audit `task.comment.edited` or `task.comment.deleted`, never the words) | `append-typed-events` |
| `open_decision_packet` | `operatorOpenPacketDisclosed` → `operatorOpenPacket` (appends the delegated-ask disclosure, ruling 84; refuses while a packet is open) | `generate-packets` |
| `resolve_decision_packet` | `operatorResolvePacket` (withdraws only a packet the operator raised: `from: operator` and no `askedBy`, `packetIsOperators`) | `generate-packets` |
| `set_dependencies` | `operatorSetDependencies` → `setTaskDependencies` (ruling 131(b): the FULL `blockedBy` list, `[]` clears; a validator refusal is a `noop` carrying the validator's own sentence, an unchanged list a `noop`) | `generate-packets` (the wait is the hold packet's replacement) |
| `set_epic` | `operatorSetEpic` → `setTasksEpic` (ruling 503: puts THIS task in an epic, moves it to another or takes it out with `""`; an unknown epic or an archived task is a `noop` with the writer's sentence, an unchanged one a `noop`; the Codex plan carries it in `epicId`) | `append-typed-events` |
| `run_agent` | `operatorDispatchAgent` (`profileId`, `prompt`, `delivers`, `reason`, `completeness`, `noVerdict`: ruling 583, the run's verdict is withheld) | `dispatch-agents` |
| `schedule_task_action` | `operatorScheduleRun` → `scheduleTaskAction` (ruling 487: THIS task's own re-run or a deployed agent's run with a directive, `delayMinutes` 1..40320 or an ISO `dueAt`, refused as `noop` for an agent it could not dispatch now) | `dispatch-agents: direct` only |
| `cancel_task_schedule` | `operatorCancelSchedule` → `cancelScheduledAction` (ruling 487: a pending entry the operator scheduled itself; a person's is `denied`) | `dispatch-agents: direct` only |
| `deliver_for_review` | `operatorDeliverForReview` → `performDelivery` | `deliver-review-pr` |
| `lease_files` | `operatorLeaseFiles` (ruling 417: lease path globs to THIS task until it merges) | `deliver-review-pr` |
| `update_branch_from_base` | `operatorUpdateBranchFromBase` (merge, never rebase; conflict → the delivering agent, or a packet when no agent can take it, ruling 475) | `update-task-branch` |
| `transition_stage` | `operatorTransitionStage` | `stage-transitions` |
| `write_completion_packet` | `operatorWriteCompletionPacket` → `writeCompletionPacket` (ruling 521: records `completionPacket` in task.md for the review subject, the operator's `summary`, its `changes` summary, required for a change of more than 200 lines, and up to 6 `screenshots` named from the task's image attachments with a caption each; refuses (`noop`) while nothing is delivered, an empty or oversized summary, a large change without `changes`, and a screenshot that is not an image or not among the attachments, listing the images it has; writes a `note` titled "Completion packet" and audit `task.completion_packet.written`; the Codex plan carries the summary in `text`, the changes in `reason`) | `completion-for-acceptance` |
| `accept_completion` | `operatorAcceptCompletion` | `completion-for-acceptance` |

Every action returns `OperatorActionResult` with `outcome: done | recommended |
denied | noop`. The `denied`/`noop` split is load-bearing: a refused plan step is
narrated as "refused by its capability policy" (a `policy` timeline event) versus
"did not apply to the task's current state" (a plain note).

Details that matter:

- **Recommendations.** Under `recommend`, `addRecommendation` writes an Apply/Dismiss
  card (`transition`, `run_agent`, `accept_completion`, `delivery`), sets `waiting =
  human`, notifies supervisors once per new card, and fans out `@mentions`. Dedupe is
  per `(kind, profileId, toStageId)`; a changed prompt or posture replaces the pending
  card.
- **Dispatch** (ruling 98). `run_agent(profileId, prompt?, delivers?)`: an explicit
  hint wins, an engaged profile keeps its posture, an unengaged profile delivers iff
  the task has no deliverer and the profile holds repo-write, otherwise supports. Two
  contradictory hints are refused as `noop`. Every selection writes
  `task.operator.agent_selected` listing each candidate with eligibility and the
  choice. A dependency hold refuses every dispatch (ruling 186). A dispatch into a
  backend the instance already knows is out of quota for the task owner's account is
  held by `startAgentRun` itself (ruling 152(c)): the tool answers `noop` with the hold
  sentence ("Held: Codex is out of quota until …; Developer's run is scheduled for then.
  Do not open a packet for this; pick a Claude profile if the work cannot wait."), the
  retry is already on the task's schedule and the timeline carries the "Dispatch held"
  note; the Codex plan mirror records the `noop` and executes the rest of the plan. A
  directive handed to an agent notifies no person named in it (ruling 232).
- **Schedules** (ruling 487, F40-65). `schedule_task_action(agent, delayMinutes | dueAt,
  prompt?)` is the controller's verb (ruling 153) at the operator's door, bound to the task
  it runs on: `agent` is `"operator"` for its own re-run or a deployed profile id, 1 minute
  to 28 days out (`scheduleDueMs`, the task page's bounds and sentence; the refusal says
  what time it is now, because the model has no clock). It writes the same `schedules[]`
  entry through `scheduleTaskAction` under `operatorAuthorized`, so the entry reads
  `createdBy: "operator"` and `createdByLabel: "operator"`, the "Scheduled:" line is the
  operator's, the `task.schedule.created` row's actor is the operator, and it fires on the
  profile deployed when it fires. It is gated like the operator's immediate dispatch: the
  tool is built, and the plan verb offered, only on a `direct` `dispatch-agents` grant (a
  scheduled run starts with nobody present; under `recommend` a person starts every run the
  operator proposes), and an agent it could not dispatch NOW is a `noop` naming why: not
  deployed, held by a dependency (ruling 186's sentence), or not eligible at the task's
  stage (ruling 133). The reply names the schedule id and says a hold it explains needs no
  packet. At fire time the operator's own entry starts the agent the way its `run_agent`
  would, with no person's name on the directive and no person to tag; its own re-run is
  told "a SCHEDULED re-check you set earlier yourself". `cancel_task_schedule(scheduleId)`
  cancels a pending entry the operator made on its own task; an entry of another task is
  not there (`noop`), and a person's entry is `denied`, theirs to cancel. A held dispatch
  (ruling 152(c)) made under the operator's authority writes its retry the same way, as the
  operator's. The doctrine, the non-negotiable rules, the stage rule's tail and the
  idle-stage nudge all say it: a wait a clock explains is scheduled, never asked, and a hold
  a pending schedule explains needs one timeline note naming it and no decision packet; the
  packet stays for a hold a person directed (ruling 131(f)).
- **Transitions.** An `auto` boundary is crossed directly even when supervised; an
  `approval` boundary always files a recommendation card for a human, whatever the
  autonomy or the grant (ruling 151); a `human` boundary is refused; a backward move
  on a `failing` task is a rework move performed directly, and so is the one backward
  move a `changed` revision licenses, into the stage where the task's reviewers can
  run (`reworkStages` lists it; ruling 163); a move INTO the acceptance-boundary stage
  is refused with the gate's own sentence while the PR conflicts (`pr.mergeable:
  "conflicting"`) or lacks the delivered revision (`pr.unpushedRevision`) ("... KNC-6
  stays at Review: Merge is where acceptance happens, and the gate would refuse it. Call
  update_branch_from_base, which routes the conflict (ruling 475), or deliver the revision
  instead of moving the task.", ruling 162); a move into the terminal stage is rerouted to
  `operatorAcceptCompletion` under either gate so the acceptance capability, not
  `stage-transitions`, answers for it. The done reply names the next boundary, and a move
  onto the acceptance boundary files the acceptance recommendation in the same call
  (ruling 152(a) and the fold, §3).
- **Acceptance.** `completionCapabilityRefusal` runs first (`off` and `human` refuse
  with different wording), then the no-change check, then the shared acceptance
  refusal stack, the same one `get_task` exposes as `notAcceptableReason` beside
  `pr.mergeable` (ruling 162: a PR the gate would refuse cannot be recommended for
  acceptance). A refusal on a task standing past the stage where its reviewers can run
  appends the way back (ruling 163): "move it there with transition_stage (a rework
  move you perform yourself); a person can also move it with the stage picker on the
  task page". Full autonomy plus `completion-for-acceptance: direct` writes
  through `applyAcceptanceWrite`; anything else files an `accept_completion` card.
  The operator **cannot merge**: it records `pr.state: accepted` (merge pending) and a
  human completes the merge (`complete-merge` intent). A racing human acceptance wins
  the lock and the operator's audit row is skipped. Ruling 492: after the refusal stack
  and before either branch, `followUpOptionRefusal` refuses (`noop`) while the open
  decision, not yet decided, offers a `create_task` whose `newTask.blockedBy` names this
  task. An acceptance withdraws the decision it does not answer, and the operator's own
  answers none, so accepting would bury the follow-up read the doctrine had it offer; the
  card is not filed either, the fold into the acceptance stage included. Every other open
  decision is withdrawn as before. Ruling 521: last of all, the operator's own offer
  (inside a drive, `ctx.operatorRun`, on either backend and through `transition_stage` to
  the terminal stage) and the fold's card (`requirePacket`) are refused (`noop`) by
  `completionPacketRefusal` until the completion packet describes the review subject:
  "Write the completion packet for revision `abc1234` first (write_completion_packet),
  then offer KEY for acceptance: …", with "The packet on file describes earlier work, so
  write it again for what is delivered now." when a new delivery replaced it. A task with
  nothing delivered is not refused over it (the gate speaks for that), and neither is a
  person's acceptance. After a person's move a fold refused this way wakes the operator,
  and after its own move the reply carries the sentence; either way the drive writes the
  packet and offers the task itself. `get_task` carries `completionPacket` (`state`:
  `current | stale | none | not_applicable`, `changedLines`, `changesSummaryRequired`,
  `screenshotCandidates`, the newest 20 image attachments, and a `note` saying what to do).
- **Delivery.** Its description says it never serves a task whose deliverable is a
  result, which is delivered on the task (ruling 531, §4). `deliver_for_review` runs
  `performDelivery`, with NO cached-state short-circuit (ruling 134): rework on a task whose PR is already open is pushed to
  that PR and the tool result names what moved ("pushed `<sha>` to the open review PR
  #N"); the only noop is the push itself answering `up_to_date` ("Nothing to push: PR
  #N already carries `<sha>`"). A held task refuses delivery (ruling 240), and a push
  that changes a path another task leases is refused before it reaches GitHub (rulings
  245, 353). Under `recommend` the card reads the RECORDED `pr.unpushedRevision` fact and
  proposes "Push `<sha>` to PR #N". A supervised delivery always leaves an actionable next
  step (a "Move to Review" recommendation) when the operator recorded none (ruling 58), on
  a board where a person approves that move; where the move is `auto` (the Standard
  template, ruling 519) the operator makes it itself and no card is filed;
  a full-autonomy delivery whose PR is new or whose head moved owes the `delivered`
  follow-up (§3). The doctrine and the seeded persona say that pushing is never a
  person's job and never an agent's. A pull request a person closed without merging is
  that person's decision (ruling 160): the tool answers `closed_by_human` with the
  sentence naming the PR and the closer, opens no new PR for the branch, and the reply
  points at the closed-PR recovery packet (open one when none covers the PR; never
  deliver again, never ask an agent to push); a person's answer to that packet, or a
  reopen on GitHub, is what lets the next `deliver_for_review` open a fresh PR.
- **Relays** (ruling 488, F40-67). Live on WEB-9 a goal told the task to post its
  deployed CPU numbers on WEB-8; nothing that worked a task could write on another one,
  the acceptance packet asked the owner to confirm two attachments had been pasted over,
  and a person pasted 5,117 characters by hand. `relay_to_task(taskKey, text)` is the
  comment's reach one task over, on the comment's grant: `relayToTask`
  (`task-relay.server.ts`) writes the target's comment as the operator with the source
  named in its header, marked `toAgent` so compaction keeps it, fans out the text's
  @mentions, audits `task.relayed {from, to}` on the target, writes the source's one line
  ("Relayed to WEB-8: <first line>…", which is how this operator's snapshot shows the relay
  went out) and wakes the target's operator fire-and-forget through `autoInvokeOperator`
  with the `relayed` trigger (§3). The reply says whether an operator is deployed there to
  pick it up. A closed target (Done or archived) is refused rather than allowed: its
  operator refuses every trigger (ruling 177), so the relay would wake nobody and read as
  delivered to finished work; reopening it is a person's stage move. The text takes a
  comment's limits: no length cap (there is none on a comment) and none of the operator's
  comment guardrails, whose chatter drop and evidence trim would cut what a relay carries.
  A specialist relays through its outcome's `relay` entries instead, posted by the same
  door at its completion ([agents-and-runtime.md §4.4](agents-and-runtime.md#44-completion)).
  The doctrine, the non-negotiable rules, the fallback persona, the app skill's Tools list
  and the `agent-reply` turn all say it: text meant for another task is relayed, a
  "Relayed to …" line means an agent's relay already went out, and nobody is asked to copy
  text between tasks or to confirm that a relay landed.
- **Leases** (rulings 417, 426). `lease_files(paths, reason)` leases globs to the
  operator's OWN task, checked inside the project file's lock: a path another active task
  already holds is refused by name (the holder keeps it), and so is a path another active
  task's open PR already changes when other work waits on that task (the refusal names who
  waits; which lands first is then a person's call). Idempotent for what the task already
  holds; every other task whose open PR changes a newly leased path is told on its own
  timeline. The lease releases itself when the task finishes; a person clears it on the
  project's settings page.
- **Branch update.** `update_branch_from_base` merges the base into the task branch in
  the delivering workspace (`--no-ff`, never rebase, never force) and pushes; it honours
  file leases before the fetch (ruling 428). It refuses at the acceptance-boundary stage
  once the work is APPROVED (rulings 162, 429), because the acceptance ceremony refreshes
  the branch once and merges in the same step; while a verdict is failing or a new
  revision awaits its verdict the refresh stays the operator's, and a PR GitHub already
  reports conflicting is the exception, so the conflict list and the packet can be
  produced. `notRefreshableReason` in the snapshot is that refusal, read before planning
  (ruling 424). A push the update makes, like a delivery's, is re-compared before the tool
  answers (ruling 494), and its tool text and `get_task`'s say to check
  `baseComparedHead` against the head just pushed and never to quote an older head's count,
  in a comment or a packet. A conflict aborts the merge and leaves the branch as it was. Ruling 475
  (owner decision): when the task's delivering engagement is deployed with a repo-write
  grant, the tool hands the conflict to that agent itself: it starts the agent's run with
  ruling 438's directive (merge `origin/<base>` in its own workspace, resolve, run the
  gates, commit; the operator then delivers the result), returns a task past the stage
  where its reviewers can run to that stage (ruling 163), and writes one person-facing
  timeline line. While that run is live on the same conflict the tool sends nothing new;
  once it has ended with the branch conflicting the same way (the same files against the
  same base commit), the deliverer has failed it once and a person decides. The blocking
  packet is the fallback for that, for no deliverer or grant, for a `dispatch-agents`
  policy that only recommends, and for a run that could not start; its redirect option
  carries `rework: true` and says "The task returns to Review for the re-verdict." when
  the task stands past the stage where its reviewers can run (ruling 163), and a person
  who routes the conflict to the deliverer through it gets the same directive (ruling
  438). An open packet offering `accept_completion` is withdrawn first. Ruling 134(c): it
  also fetches origin's copy of the TASK branch and reports it beside the base answer:
  current, behind by N ("call `deliver_for_review` to push it; do not ask a person to
  push"), diverged ("a person resolves the branch history"), absent, or unknown with
  git's reason; it never becomes a second push door. A lagging origin lands once on the
  timeline, in a sentence written for a person ("`web-2` is level with `main`. GitHub's
  copy of the branch (`9f96fc9`) is 7 commits behind the workspace; the operator's next
  delivery pushes them.", ruling 475(c)); the audit row `github.branch_update.operator`
  fires on every call and always carries the `status`, plus `remote` / `remoteHeadSha`,
  `commits` / `mergeSha` or the conflicting `files` / `baseSha`, and on a conflict the
  `resolver` and `route` (`deliverer`, `packet`, `in_progress`) with `handedTo`, `repeat`
  or `handoffRefused` as the outcome held (rulings 133(b), 475). Ruling 132: a successful update records the refresh in
  `baseRefreshes` under the file lock, reconciles the task at once so `pr.revisionDrift` is
  re-measured, and writes its timeline line and tool message from the re-read. Every `done`
  answer stamps the drive as having refreshed (`operatorRun.refreshed`, ruling 442).

## 6. Decision packets

One open packet per task; every writer refuses on the pre-read and again inside the
locked write. Header: `id`, `type` (`input | blocked`; `blocked` also floors
readiness at `blocked`), `kind` (free text; `Agent question` is load-bearing),
`from` (an actor-ref string), `title`, `body`, `observations`, `options`, `awaiting`
(only `goal_edit`), `decided` (`{ optionIndex, at, byUserId }`, stamped beside `awaiting`
so a reload renders the packet as decided, ruling 138), `askedBy` (the agent profile
whose session resumes on resolution, ruling 33). An option carries a `kind` from
`PACKET_OPTION_KINDS` and, per kind, its payload: `goalDraft` on `edit_goal` (the proposed
goal text, capped and refused by name on any other kind), `toStage` on `move_stage`,
`blockedBy` on `block_on_dependencies`, `dueAt` + `profileId` on `wait_for_window`,
`profileId` on `question_reviewer`, `newTask` on `create_task`, `backend` (and
`profileId`) on `retry_other_backend`, `deleteBranch` on `archive_task`. Both the Claude
tool and the Codex plan schema carry every payload (rulings 270, 433). The two payloads
that are goals, `goalDraft` and `newTask.goal`, are described on both with
`DONE_SIGNAL_RULE` (`app/server/tasks/done-signal.server.ts`, ruling 492): a done signal is
something the task can show before acceptance, and a proof only the merged or deployed code
can show is a follow-up read task.

Who opens packets: the operator's own decision (`operatorOpenPacket`, either
backend); an agent's `ask_human` (kind `Agent question`, `custom` option only); Viberr's
review-deadlock escalation at the third consecutive objection (§4, ruling 237); the
stuck-loop escalation after a no-progress react or the transition chain cap (the stock
set: `redirect` recommended, `request_edit`, `hold_runtime_debug`; at the react depth cap
the body says where the work stands and, over a committed head nothing delivered,
`deliver_for_review` is recommended ahead of the stock set, ruling 489); the same escalation
after a failed agent run, whose reason and options come from `describeRunFailure`
(`app/server/tasks/run-failure-remedy.server.ts`, ruling 130(b)) when the failure is
`quota | auth | unavailable | overloaded` (a spent window with a known reset offers
`wait_for_window`, ruling 224; a recovery onto a backend already known to be spent is not
offered, ruling 273) or a hung run's `idle_timeout`, whose recommended option runs the same
agent again with the same directive and keeps `redirect` unrecommended (ruling 595), or a
`tool_loop`, whose reason is the gateway's own sentence naming the call and its answer and
whose recommended option stays `redirect`, since a plain re-run repeats the loop (ruling 598); a
failed operator run (`escalateFailedOperatorRun`: "Operator run failed: pick a
recovery path", the classified reason, "No coordination was performed.", the owner's own
remedy, the provider's redacted words, a "Window reopens" observation when the reset
instant is known); a Codex run that produced no parseable plan (the stock blocked set,
whose recommended option is "Re-run the operator now"); the branch-update conflict and
push conflict (ruling 133(b): the redirect to the deliverer is offered only when that
deliverer is deployed with repo-write, else resolving by hand is recommended and the body
says why); and the `pr-diverged` recovery (closed PR → rework, `archive_task`,
`archive_task` + `deleteBranch`; merged → no packet, accept instead; reopened → withdraw
the moot packet). A person resolving any packet while the PR stands closed stamps
`pr.closure.answered` (ruling 160), which is what lets a later delivery open a fresh PR;
the operator's own withdrawal stamps nothing.

Every packet writer (the operator's `operatorOpenPacket`, an agent's `ask_human`, the Codex
completion envelope's question) withdraws the task's standing acceptance offers inside the
same locked write (ruling 137): the `accept_completion` card and any `transition` card
targeting the terminal stage go, a "Recommendation withdrawn" note names them and the packet,
a `task.recommendation.withdrawn` row records it, and the "Waiting on you" bell is marked read
only when no card survives. The operator re-recommends acceptance on its next turn if the
offer still holds.

The same three writers put the card itself on the entry that records it (ruling 586,
`askedEntryText`): the heading ("**Question for a human:** <title>", "**Decision packet:**
<title> Awaiting a human decision.", "**Blocked:** <title> Opened a decision packet…"), then
the body, the observations and the options, the recommended one marked. A packet leaves the
task when it is answered, and the decision entry names only the option and the person's
words, so this entry is where what was asked stays. Viberr's own recovery packets restate
facts already on the timeline and keep their one-line entries. A long entry folds behind
Show more, as a comment does.

Choosing a structured option is a decision and amends the task's goal contract; a typed
free-text directive answers the packet without amending the goal and reaches the operator
in its own `note` (rulings 189, 284), and every such decision stays in the operator's
snapshot as `humanDecisions` (ruling 415).

Resolution effects by option kind (`resolvePacket`):

| Kind | Effect |
|---|---|
| `accept_completion` | Runs the full acceptance contract (authority, disclosure echo, live no-change probe, refusal stack, PR head check, merge). Not re-queued. |
| `request_edit`, `redirect`, `custom` | Task back to `waiting: agent`, `readiness: ready`, packet cleared, operator re-queued. An agent question resumes the asker's own session with the answer, unless the chosen option or the person's note names another deployed agent or the operator (`answerNamesAnotherActor`, longest names first), in which case the operator gets it as `packet-resolved` and a note says why the asker was not resumed (ruling 447), or the asker cannot run on the task now (the resume gate: stage, hold, closure), in which case nothing is posted to it and the same note names the gate's reason (ruling 562). An asker still running on the task is owed the answer instead: it is posted, a note says it waits for that run, the operator is not handed it, and the run's completion starts the asker on it (`deliverDeferredMention`, ruling 565). The decision's record for an agent question names the option only. An option carrying `reply: true` is refused without a note ("… needs your answer …"), nothing recorded (ruling 478(e)). |
| `block_on_policy` | The re-run kind: `readiness: ready`, `waiting: agent`, re-queued (ruling 76). Its label states what the human asserts ("The usage window has reset (…), or I switched the Claude account: re-run", "I connected a different Claude account or an API key on Profile → Agent accounts: re-run", or the stock "Re-run the operator now"); the recorded decision is the option's pre-authored `ev` or its own title (ruling 130(c)). The toast says "Unblocked · the operator re-runs to re-check", and the re-run's instruction tells the operator to assume nothing about credentials or policy beyond the decision's own words. The credential half is a person connecting their own backend on Profile → Agent accounts, usually the task owner (ruling 127). |
| `hold_runtime_debug` | `readiness: blocked`, `waiting: human`, packet cleared, not re-queued; lifted by the next person-started operator run, a scheduled operator run, or any dispatch (ruling 157: `readiness: ready`, a "Hold lifted" note, `task.hold.lifted`). |
| `retry_other_backend` | Re-runs the failed agent on the named backend under operator authority; the switch sticks on the engagement's `pinnedBackend`. Offered only when the TASK OWNER has that backend connected (ruling 127). |
| `edit_goal` | The only kind that keeps its packet open (`awaiting: goal_edit`, plus `decided` recording the chosen option); cleared when the edited goal is saved. The card then reads decided (chosen option locked, no Confirm, one "Edit the goal" control), the readiness shows `goal_edit_pending`, the review queue row says a goal edit is owed, and `get_task` sees `packet.awaiting` (ruling 138). |
| `archive_task` | The archive contract; with `deleteBranch: true` also deletes the remote branch (the product's only remote-branch deletion besides collision resolution). Ruling 161: `get_task` carries `foreignHead` when origin's branch holds commits this task did not author, the toolkit tells the operator to say so in the option text, the confirm dialog says it before the button, and the audit records both heads. Requires `approve-transition`. |
| `discard_branch` | Deletes the **local**, never-pushed workspace branch; refuses when the branch exists on the remote. Offered while the revision has not left the workspace (no PR on the branch, no unowned PR on the name, no `pushedAt` from a delivery push), a reported head included; the discard retires that revision (`kind: discarded`, verdicts kept as history, `validation: none`) (ruling 161). Requires `approve-transition`. |
| `force_accept` | Runs `forceAcceptCompletion`, the same function the task page's Force accept button calls: the admin-only tier (`force-accept-completion`), the same disclosure echo, the same irreducible gate (a PR closed unmerged is refused) and the same `task.acceptance.forced` record naming every bypassed gate (ruling 164). Not re-queued: the task is Done. |
| `move_stage` | Moves the task to the option's own `toStage` through `transitionStage({ manual: true })`, the stage picker's path: the same `approve-transition` tier, the same transition event and `task.transition` row, and the operator re-invoked at the stage it lands on (ruling 164). The terminal stage is refused at authoring and at resolution. Best-effort after the resolution write: a refused move leaves a plain timeline note and the toast says the move did not complete. |
| `resolve_remote_collision` | Deletes the stale remote branch, closes the recorded unowned PR, re-delivers this task's local work; ends with exactly one operator hand-off carrying the outcome (ruling 136). When the PR on the ref turns out to be the task's own open review PR there is no collision: a behind or absent remote gets the push, a diverged one keeps the block. Authoring refuses it with no collision recorded (ruling 244). Requires `approve-transition`. |
| `wait_for_window` | Closes the packet, settles the task on a human, and writes a `run-agent` schedule for the provider's own reset instant (`dueAt`) that brings `profileId` back unattended (ruling 224). |
| `accept_unverified_head` | Re-reads the PR head check live; when it still cannot be verified, records a `headCheckWaiver` for that one (PR, delivered revision, live head) triple, honoured only while all three match (ruling 226). Requires `accept-completion`. |
| `block_on_dependencies` | Writes the option's `blockedBy` as the task's wait through `setTaskDependencies`, so Viberr holds the task and releases it when every entry is done (ruling 230). |
| `question_reviewer` | Starts THAT reviewer with `REVIEW_DEADLOCK_QUESTION` (name everything it would still block on, no new verdict), `waiting: agent`, the stage unmoved (ruling 237); on a held task the question is queued on the task and put the moment the wait clears (ruling 241). |
| `create_task` | Creates `newTask` through `createTask` under the RESOLVING person's authority and names the new key on both timelines; when `newTask.blocks` names this task, this task then waits on the new one (rulings 269, 287, 322). A created task starts from the base branch, which the authoring guidance says (`CREATE_TASK_BASE_NOTE`, ruling 441). It is also how a post-merge proof gets its task (ruling 492): acceptance closes the task and nothing after it happens inside the task, so before the operator puts a task up for acceptance, its doctrine has it read the goal and the delivering agent's report, and when either names a proof only the merged or deployed code can show and no task owns that read (`read_board` lists none, and no task in its `epic` is one), raise a `create_task` option for the read, `newTask.blockedBy` naming this task and `newTask.goal` confirming the change is merged and deployed before it reads (the read is released when this task reaches Done, which under the operator's own full-autonomy acceptance comes before the merge). The read is the new task's own done signal. The operator then waits for a person's answer before it puts the task up for acceptance, because an acceptance withdraws the option unanswered, and its `accept_completion` refuses while the option is open (§5). |
| `deliver_for_review` | After the resolution write, runs the task page's own delivery door (`manualDeliverForReview` → `performDelivery`, the core behind the operator's `deliver_for_review` tool) under the resolving person's authority: the push, the PR, the `github.delivery.manual` row and every refusal's own timeline event. A delivery that reached the PR lifts the stall's `blocked` readiness; a supervised task also gets the delivery's "Move to <review>" card. Exactly one hand-off: a full-autonomy delivery that moved the head re-queues the operator itself, otherwise `packet-resolved` carries the typed `serverOutcome` (`delivered`, `current`, `failed`). The `run-agents` tier (or the owner) and ruling 240's hold are checked before the write, so a refusal leaves the packet open. Authoring refuses it unless the task's head is committed and not delivered (ruling 489). Process-only: not appended to the goal. |

An option TITLE is a promise the resolution keeps (ruling 164). `operatorOpenPacket`
refuses a send-back option (`custom`, `redirect`, `request_edit`, whose resolution only
hands the task back to the agent side) whose title or detail describes a force-accept, a
move to one of this board's stages, or an edit to an agent profile, and the refusal names
the kind that performs it: `force_accept`, `move_stage` with `toStage`, or, for a profile,
the project's Agents surface (nothing a person confirms on a packet changes an agent's
configuration, ruling 85). `toStage` is refused off `move_stage`, and a `move_stage`
option that names no stage, an unknown stage, the terminal stage or the stage the task
already stands at is refused where it is authored. Every kind whose resolution needs a
payload is refused at authoring without it.

An `accept_completion` option is the operator's offer to accept (ruling 521). After the
pass 32 check (a task at the acceptance boundary with a healthy verdict),
`operatorOpenPacket` refuses it with `completionPacketRefusal` until the completion packet
describes the review subject (§5). The task page draws that packet inside the decision,
between the observations and the options: Operator's summary, each reviewer's verdict on
the revision under review (one on earlier work marked stale), the screenshots it picked
and the change (whole up to 200 lines, else its summary with the diff one press away). So
the tool tells the operator not to repeat the verdicts as observations.

Who may resolve: `accept_completion` is guarded by `requireAcceptCompletion` (admin,
maintainer, or the live task owner); `force_accept` by `force-accept-completion` (admin);
`accept_unverified_head` by `accept-completion`; `move_stage`, `archive_task`,
`discard_branch` and `resolve_remote_collision` by `approve-transition` (admin,
maintainer); `deliver_for_review` by the owner exception, or by `resolve-packet` and
`run-agents`, the manual delivery's own tier (both admin, maintainer; ruling 489); every
other kind by the owner exception or `resolve-packet` (admin, maintainer). A stranded
contributor-owner can `request-maintainer-decision`, which notifies and audits
`task.packet.escalated` without touching the packet.
`packetIdentity` (the id, or a content fingerprint) is snapshotted before any await,
re-compared before the irreversible GitHub write and again inside the file lock; a
replaced packet answers "This decision was replaced by a newer one." Confirming any
recovery option resolves the packet (no repeat confirms) and a repeat failure opens a
**new** packet (ruling 76).

The task page's own acceptances answer these two kinds too (ruling 471). A person's
plain acceptance (Accept, a board or stage-menu move into the terminal stage, an applied
acceptance card) answers an open decision that offers `accept_completion`; a Force accept
answers `force_accept`, or `accept_completion` when no `force_accept` is offered. The
record is the packet door's: the packet cleared, a `task.packet.resolved` row under the
person with `optionKind`, `optionTitle`, `packetKind` and `via` (`accept` or
`force-accept`), the packet notifications marked read, and no operator hand-off. A
decision offering neither kind is withdrawn by the acceptance (F32-11). The operator's own
full-autonomy acceptance answers nothing and withdraws as before, except that it is refused
while the decision offers a `create_task` whose new task waits on this one (ruling 492, §5).

## 7. Guardrails on what the operator writes

`writeOperatorComment` enforces the project's guardrail rows for real:
`meaningful-comment` (trivial status chatter is dropped and audited as
`task.comment.dropped`), `evidence-separation` (raw output dumps trimmed to a head plus a
reference), `no-duplicate-summary` (byte compare against the last operator comment inside
the write lock), and `compression-threshold` at the configured value (default 40 events;
the timeline compactor collapses old routine comments into one marker while keeping every
typed event, every human and controller comment, and every comment that notified someone,
ruling 382). There is no write-time length cap (ruling 104); long narration collapses
view-side behind "Show more". A comment is read by people and starts no run: an @mention
of an agent in it reaches nobody, and the comment is stamped with a note saying which
agents it did not reach (rulings 214, 252, 262); a handle that matches two people is
disclosed as not delivered. How the words themselves read is the writing guide's (§4,
ruling 502).

## 8. Where to look

- Triggers, lease and queue, stranded-drive backstop, prompts, Codex plan execution,
  failure escalation: `app/server/runtimes/operator-run.server.ts`.
- Authority, gates, snapshot, every governed action: `app/server/tasks/operator-actions.server.ts`.
- The Claude tool surface: `app/server/tasks/operator-toolkit.server.ts`.
- The default-branch read: `app/server/tasks/operator-repo-read.server.ts`.
- The branch update: `app/server/github/update-branch-operator.server.ts`.
- The stranded-task sweep: `app/server/tasks/stranded-sweep.server.ts`.
- The review-deadlock packet: `app/server/tasks/review-deadlock.server.ts`.
- Packet resolution, acceptance, transitions, delivery, `autoInvokeOperator`:
  `app/server/tasks/task-actions.server.ts`.
- The operator's shipped doctrine: `app/server/seed/assets/operator.definition.md`.
- The writing guide: `app/server/runtimes/humanizer.server.ts` and the vendored
  `app/server/runtimes/humanizer/SKILL.md` (ruling 502).
