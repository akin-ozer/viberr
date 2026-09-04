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
| `packet-resolved` | proceed | `resolvePacket`, when no asking agent absorbed the answer |
| `scheduled` | re-check | the schedule runner |
| `manual` | coordinate | the Run-operator control, an `@operator` comment, boot recovery, the controller's `run_agent_on_task` |

`autoInvokeOperator` is the shared fire-and-forget seam; it is a no-op when no
operator is deployed and writes an honest timeline note if the hand-off throws before
a run row exists.

Fire-time refusals from `runOperator`: `terminal-stage` (a scheduled re-run never
fires on a terminal task) and `open-packet` (a **human-pressed** Run operator while a
packet is open is a paid no-op; machine triggers such as `pr-diverged` and
`agent-reply` are not refused, ruling 76).

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
packet, no recommendation, an outbound `auto` boundary) gets one resume nudge; a
drive that strands again records a deliberate hold (`heldAtStage`) rather than
nudging forever.

## 4. The turn

`operatorTurnDoctrine` builds the trigger-specific instruction, `operatorTurnInstruction`
appends the capability-gap remedy clause (ruling 85: a packet must name the grantable
capability and where a human grants it, not only workarounds), and the backend prompt
builders wrap it. The default arm states that `liveRuns` is the only proof a run is in
flight: `waiting` is a display flag and a directive comment is not a running agent.

`get_task` returns the `OperatorTaskSnapshot`: stage and `previousStage` (so "back
from Review" reads as rework), `validation` (derived), `reworkStages` (non-empty only
while validation is `failing`), PR facts including the head sha, revision drift and
the current unpushed-revision record with the acceptance gate's own sentence (ruling
135: an unpushed revision reaches its PR through `deliver_for_review`), `noChanges`,
`liveRuns`, pending and recently declined recommendations (so a supervised operator
does not re-propose a just-dismissed move), and its own `operatorPolicy` labelled with
scope so it cannot mistake its own web grant for a specialist's.

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
  choice.
- **Transitions.** An `auto` boundary is crossed directly even when supervised; a
  backward move on a `failing` task is a rework move performed directly; a supervised
  move into the terminal stage is rerouted to `operatorAcceptCompletion` so the
  acceptance capability, not `stage-transitions`, answers for it.
- **Acceptance.** `completionCapabilityRefusal` runs first (`off` and `human` refuse
  with different wording), then the no-change check, then the shared acceptance
  refusal stack. Full autonomy plus `completion-for-acceptance: direct` writes
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
  person's job and never an agent's.

## 6. Decision packets

One open packet per task; every writer refuses on the pre-read and again inside the
locked write. Header: `id`, `type` (`input | blocked`; `blocked` also floors
readiness at `blocked`), `kind` (free text; `Agent question` is load-bearing),
`from` (an actor-ref string), `title`, `body`, `observations`, `options`, `awaiting`
(only `goal_edit`), `askedBy` (the agent profile whose session resumes on
resolution, ruling 33).

Who opens packets: the operator's own decision (`operatorOpenPacket`, either
backend); an agent's `ask_human` (kind `Agent question`, `custom` option only); the
stuck-loop escalation after a failed agent run, a no-progress react or the transition
chain cap (`redirect`, `request_edit`, `hold_runtime_debug`, plus a recommended
`retry_other_backend` when the failure is quota/auth/unavailable); a failed operator
run (`escalateFailedOperatorRun`, with the provider's own redacted words); a Codex
run that produced no parseable plan; the branch-update conflict; and the
`pr-diverged` recovery (closed PR → rework, `archive_task`, `archive_task` +
`deleteBranch`; merged → no packet, accept instead; reopened → withdraw the moot
packet).

Resolution effects by option kind (`resolvePacket`):

| Kind | Effect |
|---|---|
| `accept_completion` | Runs the full acceptance contract (authority, disclosure echo, live no-change probe, refusal stack, PR head check, merge). Not re-queued. |
| `request_edit`, `redirect`, `custom` | Task back to `waiting: agent`, `readiness: ready`, packet cleared, operator re-queued; an agent question routes to the asker's resumed session first. |
| `block_on_policy` | "I fixed the policy or credential": `readiness: ready`, `waiting: agent`, re-queued (ruling 76). Since ruling 127 the credential half of that is a person connecting their own backend on Profile → Agent accounts, usually the task owner. |
| `hold_runtime_debug` | `readiness: blocked`, `waiting: human`, packet cleared, not re-queued. |
| `retry_other_backend` | Re-runs the failed agent on the named backend under operator authority; the switch sticks on the engagement's `pinnedBackend`. Offered only when the TASK OWNER has that backend connected (ruling 127). |
| `edit_goal` | The only kind that keeps its packet open (`awaiting: goal_edit`); cleared when the edited goal is saved. |
| `archive_task` | The archive contract; with `deleteBranch: true` also deletes the remote branch (the product's only remote-branch deletion besides collision resolution). Requires `approve-transition`. |
| `discard_branch` | Deletes the **local**, never-pushed workspace branch; refuses when the branch exists on the remote. Requires `approve-transition`. |
| `resolve_remote_collision` | Closes the recorded unowned PR, deletes the stale remote branch, re-delivers this task's local work. Requires `approve-transition`. |

Who may resolve: `accept_completion` is guarded by `requireAcceptCompletion` (admin,
maintainer, or the live task owner); every other kind by the owner exception or
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
