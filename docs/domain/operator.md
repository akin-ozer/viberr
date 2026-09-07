# The operator

> The per-task coordination agent: what wakes it, what it may do, how its
> authority is gated, and the packets it opens. Source of truth:
> `app/server/runtimes/operator-run.server.ts`, `app/server/tasks/operator-actions.server.ts`,
> `app/server/tasks/operator-toolkit.server.ts`, `app/server/tasks/task-actions.server.ts`.
> Verified against `main` @ `68b5480` (2026-09-01). Updated 2026-09-02 for ruling 127
> (branch `claude/per-user-codex-auth-difdnn`): §2 now says whose account an operator
> run bills. Line numbers are omitted on purpose; function names are stable, line
> numbers are not.

## 1. Role

Every project deploys exactly one operator (`kind: operator`, profile id
`operator`, ensured on every project at boot by `ensureBaseAgentsDeployed`). A task
gets its operator when it leaves the entry stage (`operator: {assignedAtStageId}`),
and the operator is auto-invoked from task creation onward. It never writes code and
never pushes: it reads the task and the repository, scopes the goal, dispatches
deployed agents, opens decision packets, recommends or performs stage transitions,
decides delivery, and, under full autonomy with an explicit grant, accepts completion.

Its persona is the doctrine file `agents/definitions/operator.md` plus the
`viberr-app-expertise` skill; both ship from `app/server/seed/assets/` and are
written into the store by the boot backfill.

## 2. Authority

`resolveOperatorAuthority(ctx, projectSlug, overrides)` reads the project's operator
deployment and returns the policy map (capability id → `direct | recommend | human |
off`), the configured `autonomy` (`supervised | full`), backend, model, effort,
resources, persona, whether the operator is deployed, and `humanGatedBeforeWork`
(derived from the workflow graph, never a stored preset).

- **Autonomy is a ceiling, not a pin** (ruling 67). A per-run level may sit at or
  below the configured one; a clamp that bites writes the audit fact
  `task.operator.autonomy_clamped`. The run control shows the backend and keeps Run;
  it no longer picks backend or autonomy (ruling 92).
- **An operator run bills the TASK OWNER** (ruling 127), like every other run on a task:
  `runOperator` resolves `resolveTaskRunPrincipal` before it starts anything and spawns
  with that person's own Claude or Codex credential. Authority is still the operator's
  own capability policy — whose account pays and what the run may do are separate
  questions — but a task with no owner, or an owner who has not connected the operator's
  backend, gets an honest refusal run and no process, and the task page's Run control is
  disabled with the same sentence.
- **Three gates**, because two capabilities carry absent-means-granted polarity:
  `gate(authority, id)` (`direct` → act; `recommend` → act only under full autonomy,
  except `completion-for-acceptance`, which is never promoted; `human`/`off` → deny;
  not deployed → deny), `deliverGate` (`deliver-review-pr`; an absent grant resolves
  from `absentDeliverReviewPrMode(humanGatedBeforeWork)`, ruling 28) and
  `dispatchGate` (`dispatch-agents`; absent → catalog default `direct`, because the
  id replaced two retired ids in ruling 98).
- **Operator capabilities** (`UNIFIED_CAP_CATALOG`, kind `operator`):
  `dispatch-agents`, `generate-packets`, `append-typed-events`, `stage-transitions`
  (default `recommend`), `completion-for-acceptance` (default `recommend`, not
  promotable), `deliver-review-pr`, `update-task-branch`, `use-web-search-fetch`.
- `off` is a hard refusal on every route to the action, checked before any read,
  card or audit row (ruling 60). The operator refuses out loud and narrates it.
- **The boundary always wins** (ruling 151, pass 35). A `stage-transitions` grant of
  `direct` (or full autonomy promoting `recommend`) crosses `auto` boundaries only. A
  declared `approval` boundary always files a transition recommendation a human
  applies, whatever the autonomy or the grant mode; a declared `human` boundary is
  refused with a sentence; the terminal stage is reachable only through acceptance.
  `transitionStage` enforces the same rule for every operator-authorized caller, so a
  `task.transition` row with `by: operator` and `boundary: approval` cannot be written.
  Rework moves on a failing task (R7-4) are unchanged. Before the ruling a supervised
  operator with the grant set to `direct` crossed Review to Merge alone while the
  Policy page said a human approves it.

## 3. Triggers

`RunOperatorInput.trigger` is a closed union that selects the turn doctrine:

| Trigger | Posture | Fired from |
|---|---|---|
| `create` | coordinate (triage) | `createTask` |
| `transition` | coordinate | every stage move; the stranded backstop |
| `goal-updated` | re-scope | `updateTaskGoal` |
| `agent-reply` | react | the agent completion pipeline |
| `pr-diverged` | recover | the GitHub reconciler on an out-of-band PR change |
| `delivered` | proceed | a full-autonomy delivery that opened a new PR, or whose push moved the head of the task's open PR (rulings 48 and 134) |
| `packet-resolved` | proceed | `resolvePacket`, when no asking agent absorbed the answer. The payload carries the option (kind, title), the person's own note, and, for a ceremony that performs work of its own (`resolve_remote_collision`), Viberr's record of what it did in a separate `serverOutcome` field rendered as Viberr's sentence, never inside the quoted note (ruling 136(a)) |
| `dependencies-released` | proceed after a hold | the release engine (ruling 131(e)): the payload names what was waited on and who cleared it; the doctrine says the base branch has changed since the hold and that a hold packet the operator opened itself is now moot |
| `scheduled` | re-check | the schedule runner |
| `manual` | coordinate | the Run-operator control, an `@operator` comment, boot recovery, the controller's `run_agent_on_task`. A person's manual run (one carrying `actor`) or a `scheduled` run on a held task lifts the hold on the record (`task.hold.lifted`, ruling 157) |

`autoInvokeOperator` is the shared fire-and-forget seam; it is a no-op when no
operator is deployed and writes an honest timeline note if the hand-off throws before
a run row exists.

**The transition re-trigger** (ruling 152(a), pass 35). Every stage move used to queue
a fresh operator turn, the operator's own moves included, so a task walking three
`auto` stages paid three turns. Now a transition made by a LIVE operator run (the ctx
carries `operatorRun`) queues nothing: the `transition_stage` reply names the next
boundary ("The next boundary, Impl to Validation, is auto: continue in this turn when
nothing at Impl needs an agent"; "... is approved by a human: recommend it when the
work is ready") and the prompt says to walk consecutive `auto` boundaries in one
turn. Human and system moves still re-trigger. A chain the model abandons is the
stranded-stage backstop's job. The fold (owner decision Q35-15): when a move lands on
the acceptance boundary (the review stage, or any stage with a declared edge into the
terminal one), the acceptance recommendation is filed in the same act, under the
deployed operator's own acceptance gate, instead of by a second turn: the operator's
own move folds it into its reply, and a person's move (an applied "Move the task to
Merge" card, a board drop) folds it before the re-trigger and skips the turn when the
card was filed. A full-autonomy operator holding a direct acceptance grant is never
folded into an acceptance; a refused gate leaves no card and the reply (or the
re-invoked turn) says why.

**Holds** (ruling 157, pass 35). A stored `blocked` with no open packet and no
`blockedBy` list is a hold (the `hold_runtime_debug` decision, the refused arm of a
collision ceremony). Before `markWaitingAgent`, `runOperator` calls `liftHoldForRun`
for a person's `manual` run (`actor` set: Run operator, an `@operator` comment, the
controller) and for a `scheduled` run: `readiness: ready`, a "Hold lifted" note naming
who started the work, and `task.hold.lifted {cause: "operator-run", trigger,
byUserId}`. A bare `manual` with no actor (boot recovery) and every machine trigger
lift nothing; an open packet keeps the withdrawal paths as the only lift; a dependency
list keeps ruling 131's floor. Every dispatch lifts the same way (§4.1 of
agents-and-runtime). The lift is not a claim that the cause is fixed: the operator
re-checks and opens a new packet when the block stands.

Fire-time refusals from `runOperator`: `terminal-stage` (a scheduled re-run never
fires on a terminal task), `open-packet` (a **human-pressed** Run operator, or the same turn a person
**scheduled**, while a packet is open is a paid no-op, rulings 76 and 141; machine
reaction triggers such as `pr-diverged` and `agent-reply` are not refused; a scheduled
occurrence is retired `fired` with a "Scheduled action skipped" note and outcome
`skipped-packet`, and a trigger refused at the front of the lease queue says so on the
task through `noteQueuedTriggerRefused`, which settles nothing), and `blocked-by` (ruling 131(d): while the
task's `blockedBy` list is non-empty the `create`, `transition` and `scheduled`
triggers are refused before any run row exists, no run and no cost; the refusal
settles the waiting flag itself, to `none` when nothing else is pending, so a
transition drained off the lease queue never strands `waiting: agent`; a scheduled
occurrence is retired `fired` with a "Scheduled action skipped" note and outcome
`skipped-held`; a human-scheduled AGENT run is not refused). The stranded-coordination
backstop treats a non-empty list as a recorded hold and never nudges.

**Single-flight per task.** One drive at a time; queued triggers coalesce per kind:
machine triggers keep only the latest, while reason-carrying triggers (a human
`@operator` comment, a scheduled re-check) queue FIFO up to 8 and drain oldest-first
ahead of the machine slot. Consecutive comments from the same author merge into one
turn. A restart-orphaned run is finalized and re-driven rather than chained onto a
dead callback.

**Loop caps.** `OPERATOR_REACT_DEPTH_CAP = 4` (agent-reply reactions),
`OPERATOR_TRANSITION_CHAIN_CAP = 8` (operator-authored transitions; a human move
resets the chain), and a boot recovery re-invoke cap of 3 per task per 30 minutes.
Hitting a cap opens a stuck-loop packet instead of looping. A stranded drive (no
packet, no recommendation, and either an outbound `auto` boundary or a stage this
drive's own move landed on) gets one resume nudge; a drive that strands again
records a deliberate hold (`heldAtStage`) rather than nudging forever. Since ruling
152(a) the backstop judges the stage the drive's own last transition landed on
(`ctx.operatorRun.movedToStageId`, shared with the lease): a nudged drive that moved
the task and stopped made progress and gets a fresh nudge, bounded by the chain cap;
only a nudge that ends where it started is the deliberate hold. The drive's own move
counts whatever the new stage's outbound boundary is, because that move queues no
re-trigger: on the standard board the operator's own move lands on In Progress,
whose outbound boundary is `approval`, and judging it by the `auto` test alone left
it with no follow-up at all.

## 4. The turn

`operatorTurnDoctrine` builds the trigger-specific instruction, `operatorTurnInstruction`
appends the capability-gap remedy clause (ruling 85: a packet must name the grantable
capability and where a human grants it, not only workarounds), and the backend prompt
builders wrap it. The default arm states that `liveRuns` is the only proof a run is in
flight: `waiting` is a display flag and a directive comment is not a running agent.
The pre-work rule says to call `transition_stage` again in the same turn when the new
stage's outbound boundary is `auto` and nothing there needs an agent (ruling 152(a)):
the operator is re-invoked only when its turn ends at a stage that still needs work.
While the snapshot's `blockedBy` is non-empty (ruling 131(d)) the held doctrine
REPLACES the stage-rule tail rather than following it, so the prompt never carries
two contradictory orders: it names every entry with its live state and the one tool
that changes the wait (`set_dependencies`), forbids advancing the stage, dispatching
delivery work and opening a packet about the wait, and says that ending the turn with
one concise comment is correct. The "confirm the hold" packet exit stays only for
holds a human directed.

`get_task` returns the `OperatorTaskSnapshot`: stage and `previousStage` (so "back
from Review" reads as rework), `validation` (derived), `reworkStages` (non-empty only
while validation is `failing`), PR facts including the head sha, revision drift and
the current unpushed-revision record with the acceptance gate's own sentence (ruling
135: an unpushed revision reaches its PR through `deliver_for_review`), `noChanges`,
`liveRuns`, pending and recently declined recommendations (so a supervised operator
does not re-propose a just-dismissed move), `blockedBy` (ruling 131: each entry with
its resolved state), `deployedSpecialists[].eligibleForCurrentStage` meaning "may RUN
here" (declared stages, or the engaged deliverer, ruling 133) beside
`engagedAsDeliverer`, and its own `operatorPolicy` labelled with scope so it cannot
mistake its own web grant for a specialist's.

Before triage the operator gets a **full read-only clone** of the project repository
(ruling 55), the same per-task checkout a specialist run reuses; on the shared
workspace it reads the default branch through an anchored `git show` so it never
mistakes the delivering agent's branch for `main`. A clone failure is a first-class
`unavailable` arm carrying git's redacted complaint.

Writes and shell are denied on both backends. On Claude the operator gets the
in-process MCP server `viberr`; on Codex it emits a structured plan against the same
verb set (minus the reads), narrowed by the same three gates, and the server executes
the plan after the run (`runtime.operator.plan_executed` is the idempotency marker
boot recovery reads).

## 5. Tools and the governed actions behind them

A withheld capability means the tool is **not built**; the model cannot reach it.

| Tool (`viberr`) | Action | Capability |
|---|---|---|
| `get_task` | `operatorSnapshot` | always |
| `read_default_branch_file` | anchored default-branch read | always, when a checkout exists |
| `post_comment` | `operatorPostComment` (guardrails applied; narration stored verbatim, ruling 104) | `append-typed-events` |
| `set_goal` | `operatorSetGoal` (refuses to overwrite a human goal; drafts for a human to save) | `append-typed-events` |
| `flag_context_conflict` | `operatorFlagContextConflict` (repo convention vs KB, ruling 56) | `append-typed-events` |
| `open_decision_packet` | `operatorOpenPacket` (appends the delegated-ask disclosure, ruling 84) | `generate-packets` |
| `resolve_decision_packet` | `operatorResolvePacket` (refuses any packet not `from: operator` or carrying `askedBy`) | `generate-packets` |
| `set_dependencies` | `operatorSetDependencies` → `setTaskDependencies` (ruling 131(b): the FULL `blockedBy` list, `[]` clears; a validator refusal is a `noop` carrying the validator's own sentence, an unchanged list a `noop`; the Codex plan verb is `set_dependencies` with `blockedBy`) | `generate-packets` (the wait is the hold packet's replacement) |
| `run_agent` | `operatorDispatchAgent` | `dispatch-agents` |
| `deliver_for_review` | `operatorDeliverForReview` → `performDelivery` | `deliver-review-pr` |
| `update_branch_from_base` | `operatorUpdateBranchFromBase` (merge, never rebase; conflict → packet) | `update-task-branch` |
| `transition_stage` | `operatorTransitionStage` | `stage-transitions` |
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
  choice. A dispatch into a backend the instance already knows is out of quota for the
  task owner's account is held by `startAgentRun` itself (ruling 152(c), pass 35): the
  tool call fails with the hold sentence ("Held: Codex is out of quota until …;
  Developer's run is scheduled for then."), the retry is already on the task's
  schedule and the timeline carries the "Dispatch held" note; the operator opens no
  packet for it and picks the other backend only when the work cannot wait.
- **Transitions.** An `auto` boundary is crossed directly even when supervised; an
  `approval` boundary always files a recommendation card for a human, whatever the
  autonomy or the grant (ruling 151); a `human` boundary is refused; a backward move
  on a `failing` task is a rework move performed directly, and so is the one backward
  move a `changed` revision licenses, into the stage where the task's reviewers can
  run (`reworkStages` lists it; ruling 163); a move INTO the acceptance-boundary stage
  is refused with the gate's own sentence while `get_task` shows `notAcceptableReason`
  for a conflicting or unpushed PR ("... KNC-6 stays at Review: Merge is where
  acceptance happens, and the gate would refuse it. Open the conflict packet
  (update_branch_from_base) or deliver the revision instead of moving the task.",
  ruling 162); a move into the terminal
  stage is rerouted to `operatorAcceptCompletion` under either gate so the acceptance
  capability, not `stage-transitions`, answers for it. The done reply names the next
  boundary, and a move onto the acceptance boundary files the acceptance
  recommendation in the same call (ruling 152(a) and the fold, §3).
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
  the lock and the operator's audit row is skipped.
- **Delivery.** `deliver_for_review` runs `performDelivery`, with NO cached-state
  short-circuit (ruling 134): rework on a task whose PR is already open is pushed to
  that PR and the tool result names what moved ("pushed `<sha>` to the open review PR
  #N"); the only noop is the push itself answering `up_to_date` ("Nothing to push: PR
  #N already carries `<sha>`"). Under `recommend` the card reads the RECORDED
  `pr.unpushedRevision` fact and proposes "Push `<sha>` to PR #N". A supervised
  delivery always leaves an actionable next step (a "Move to Review" recommendation)
  when the operator recorded none (ruling 58); a full-autonomy delivery whose PR is
  new or whose head moved re-queues the operator with the `delivered` trigger (rulings
  48 and 134). The doctrine and the seeded persona say that pushing is never a
  person's job and never an agent's. A pull request a person closed without merging is
  that person's decision (ruling 160): the tool answers `closed_by_human` with the
  sentence naming the PR and the closer, opens no new PR for the branch, and the reply
  points at the closed-PR recovery packet (open one when none covers the PR; never
  deliver again, never ask an agent to push); a person's answer to that packet, or a
  reopen on GitHub, is what lets the next `deliver_for_review` open a fresh PR.
- **Branch update.** `update_branch_from_base` merges the base into the task branch in
  the delivering workspace (`--no-ff`, never rebase, never force) and pushes. Ruling 162
  / G35-5(d) (pass 35): it refuses at the acceptance-boundary stage and past it, because
  the acceptance ceremony refreshes the branch once and merges in the same step ("KNC-1
  is at Merge, the acceptance boundary: the branch is brought up to date once, at
  acceptance time, and merged in the same ceremony. Do not refresh it here; recommend or
  accept the completion instead."); a PR GitHub already reports conflicting is the
  exception, so the conflict list and the packet can be produced. The conflict packet's
  redirect option carries `rework: true` and says "The task returns to Review for the
  re-verdict." when the task stands past the stage where its reviewers can run (ruling
  163). Ruling
  134(c): it also fetches origin's copy of the TASK branch and reports it beside the
  base answer, derived from the workspace's own history: current, behind by N ("call
  `deliver_for_review` to push it; do not ask a person to push"), diverged ("a person
  resolves the branch history"), absent, or unknown with git's reason. It stays the
  base tool and never becomes a second push door. A lagging origin lands once on the
  timeline (the line is suppressed while the newest `github` event already says it);
  the audit row `github.branch_update.operator` fires on every call and always carries
  the `status`; the rest is whatever the outcome actually held — `remote` and
  `remoteHeadSha` when origin's copy was read (an update or an already-current answer,
  not a conflict), `commits` and `mergeSha` on an update, the conflicting `files` on a
  conflict, and the offered `resolver` on either conflict shape (ruling 133(b)). Ruling 132: a successful update records
  the refresh in `baseRefreshes` under the file lock, reconciles the task at once so
  `pr.revisionDrift` is re-measured now rather than by the poll, and writes its timeline
  line and tool message from the re-read, carrying the canonical drift sentence (or
  "Drift could not be re-measured now"). The seeded persona says all of this.

## 6. Decision packets

One open packet per task; every writer refuses on the pre-read and again inside the
locked write. Header: `id`, `type` (`input | blocked`; `blocked` also floors
readiness at `blocked`), `kind` (free text; `Agent question` is load-bearing),
`from` (an actor-ref string), `title`, `body`, `observations`, `options`, `awaiting`
(only `goal_edit`), `decided` (`{ optionIndex, at, byUserId }`, stamped beside `awaiting`
so a reload renders the packet as decided, ruling 138), `askedBy` (the agent profile
whose session resumes on resolution, ruling 33). An `edit_goal` option may carry
`goalDraft`, the proposed goal text itself (written as a goal: deliverable plus
acceptance criteria), which the goal editor opens with; both backends' prompts say so,
`operatorOpenPacket` caps it and refuses it by name on any other kind, and the Codex plan
schema requires the key (null off `edit_goal`).

Who opens packets: the operator's own decision (`operatorOpenPacket`, either
backend); an agent's `ask_human` (kind `Agent question`, `custom` option only); the
stuck-loop escalation after a no-progress react or the transition chain cap (the stock
set: `redirect` recommended, `request_edit`, `hold_runtime_debug`); the same escalation
after a failed agent run, whose reason and options come from `describeRunFailure`
(`app/server/tasks/run-failure-remedy.server.ts`, ruling 130(b)) when the failure is
`quota | auth | unavailable`: `retry_other_backend` first only when the task owner has
the other backend connected, else a `request_edit` titled "The window has reset (…), or
the account changed: send @agent back to continue", `redirect` present and never
recommended, `hold_runtime_debug` last; a failed operator run
(`escalateFailedOperatorRun`: "Operator run failed: pick a recovery path", body = the
classified reason, "No coordination was performed.", the owner's own remedy, the
provider's redacted words, a "Window reopens" observation when the reset instant is
known; options from the same module, ruling 130(b)/(c)); a Codex run that produced no
parseable plan (the stock blocked set, whose recommended option is "Re-run the operator
now"); the branch-update conflict and push conflict (ruling 133(b): the redirect to the
deliverer is offered only when that deliverer is deployed with repo-write, else resolving
by hand is recommended and the body says why); and the
`pr-diverged` recovery (closed PR → rework, `archive_task`, `archive_task` +
`deleteBranch`; merged → no packet, accept instead; reopened → withdraw the moot
packet). A person resolving any packet while the PR stands closed stamps
`pr.closure.answered` (ruling 160), which is what lets a later delivery open a fresh
PR; the operator's own withdrawal stamps nothing.

Every packet writer (the operator's `operatorOpenPacket`, an agent's `ask_human`, the Codex
completion envelope's question) withdraws the task's standing acceptance offers inside the
same locked write (ruling 137): the `accept_completion` card and any `transition` card
targeting the terminal stage go, a "Recommendation withdrawn" note names them and the packet,
a `task.recommendation.withdrawn` row records it, and the "Waiting on you" bell is marked read
only when no card survives. The operator re-recommends acceptance on its next turn if the
offer still holds.

Resolution effects by option kind (`resolvePacket`):

| Kind | Effect |
|---|---|
| `accept_completion` | Runs the full acceptance contract (authority, disclosure echo, live no-change probe, refusal stack, PR head check, merge). Not re-queued. |
| `request_edit`, `redirect`, `custom` | Task back to `waiting: agent`, `readiness: ready`, packet cleared, operator re-queued; an agent question routes to the asker's resumed session first. |
| `block_on_policy` | The re-run kind: `readiness: ready`, `waiting: agent`, re-queued (ruling 76). Its label states what the human asserts ("The usage window has reset (…), or I switched the Claude account: re-run", "I connected a different Claude account or an API key on Profile → Agent accounts: re-run", or the stock "Re-run the operator now"); the recorded decision is the option's pre-authored `ev` or its own title, never a fixed "policy / credential updated" (ruling 130(c)). The toast says "Unblocked · the operator re-runs to re-check", and the re-run's instruction tells the operator to assume nothing about credentials or policy beyond the decision's own words. Since ruling 127 the credential half of that is a person connecting their own backend on Profile → Agent accounts, usually the task owner. |
| `hold_runtime_debug` | `readiness: blocked`, `waiting: human`, packet cleared, not re-queued; lifted by the next person-started operator run, a scheduled operator run, or any dispatch (ruling 157: `readiness: ready`, a "Hold lifted" note, `task.hold.lifted`). |
| `retry_other_backend` | Re-runs the failed agent on the named backend under operator authority; the switch sticks on the engagement's `pinnedBackend`. Offered only when the TASK OWNER has that backend connected (ruling 127). |
| `edit_goal` | The only kind that keeps its packet open (`awaiting: goal_edit`, plus `decided` recording the chosen option); cleared when the edited goal is saved. The card then reads decided (chosen option locked, no Confirm, one "Edit the goal" control), the readiness shows `goal_edit_pending`, the review queue row says a goal edit is owed, and `get_task` sees `packet.awaiting` (ruling 138). |
| `archive_task` | The archive contract; with `deleteBranch: true` also deletes the remote branch (the product's only remote-branch deletion besides collision resolution). Ruling 161 (U35-8): `get_task` carries `foreignHead` when origin's branch holds commits this task did not author, the toolkit tells the operator to say so in the option text, the confirm dialog says it before the button, and the audit records both heads. Requires `approve-transition`. |
| `discard_branch` | Deletes the **local**, never-pushed workspace branch; refuses when the branch exists on the remote. Ruling 161: offered while the revision has not left the workspace (no PR on the branch, no unowned PR on the name, no `pushedAt` from a delivery push), a reported head included; the discard retires that revision (`kind: discarded`, verdicts kept as history, `validation: none`). The operator's push-conflict reply says the refused push means the draft never left, so the discard may be offered when the person's choice is to throw it away, never as the way to clear the remote. Requires `approve-transition`. |
| `force_accept` | Ruling 164 (F35-14): runs `forceAcceptCompletion`, the same function the task page's Force accept button calls, so the same admin-only tier (`force-accept-completion`), the same disclosure echo, the same irreducible gate (a PR closed unmerged is refused) and the same `task.acceptance.forced` record naming every bypassed gate. The card opens the FORCE form of the acceptance ceremony with the option's title as its subject. Not re-queued: the task is Done. |
| `move_stage` | Ruling 164 (F35-14): moves the task to the option's own `toStage` through `transitionStage({ manual: true })`, the stage picker's path, so the same `approve-transition` tier, the same off-graph licence, the same transition event and `task.transition` row, and the operator re-invoked at the stage it lands on. The terminal stage is refused at authoring and at resolution (moving there accepts the completion). Best-effort after the resolution write: a refused move leaves a plain timeline note and the toast says the move did not complete. |
| `resolve_remote_collision` | Deletes the stale remote branch, closes the recorded unowned PR, re-delivers this task's local work; ends with exactly one operator hand-off carrying the outcome (ruling 136). When the PR on the ref turns out to be the task's own open review PR there is no collision: a behind or absent remote gets the push, a diverged one keeps the block. Requires `approve-transition`. |

An option TITLE is a promise the resolution keeps (ruling 164). `operatorOpenPacket`
refuses a send-back option (`custom`, `redirect`, `request_edit`, whose resolution only
hands the task back to the agent side) whose title or detail describes a force-accept, a
move to one of this board's stages, or an edit to an agent profile, and the refusal names
the kind that performs it: `force_accept`, `move_stage` with `toStage`, or, for a profile,
the project's Agents surface (nothing a person confirms on a packet changes an agent's
configuration, ruling 85). `toStage` is refused off `move_stage`, and a `move_stage`
option that names no stage, an unknown stage, the terminal stage or the stage the task
already stands at is refused where it is authored.

Who may resolve: `accept_completion` is guarded by `requireAcceptCompletion` (admin,
maintainer, or the live task owner); `force_accept` by `force-accept-completion` (admin);
`move_stage`, `archive_task`, `discard_branch` and `resolve_remote_collision` by
`approve-transition` (admin, maintainer); every other kind by the owner exception or
`resolve-packet` (admin, maintainer). A stranded contributor-owner can
`request-maintainer-decision`, which notifies and audits `task.packet.escalated`
without touching the packet. `packetIdentity` (the id, or a content fingerprint) is
snapshotted before any await, re-compared before the irreversible GitHub write and
again inside the file lock; a replaced packet answers "This decision was replaced by a
newer one." Confirming any recovery option resolves the packet (no repeat confirms)
and a repeat failure opens a **new** packet (ruling 76).

## 7. Guardrails on what the operator writes

`writeOperatorComment` enforces the project's guardrail rows for real:
`meaningful-comment` (trivial status chatter is dropped and audited as
`task.comment.dropped`), `evidence-separation`, `no-duplicate-summary` (byte compare
against the last operator comment inside the write lock), and
`compression-threshold` at the configured value (default 40 events; the timeline
compactor collapses old routine comments into one marker while keeping every typed
event). There is no write-time length cap since ruling 104; long narration collapses
view-side behind "Show more".

## 8. Where to look

- Turn doctrine, triggers, queue, stranded backstop, Codex plan execution, failure
  escalation: `app/server/runtimes/operator-run.server.ts`.
- Authority, gates, snapshot, every governed action: `app/server/tasks/operator-actions.server.ts`.
- The Claude tool surface: `app/server/tasks/operator-toolkit.server.ts`.
- Packet resolution, acceptance, transitions, delivery: `app/server/tasks/task-actions.server.ts`.
- The operator's shipped doctrine: `app/server/seed/assets/operator.definition.md`.
