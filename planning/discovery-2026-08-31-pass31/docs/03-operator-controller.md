# 03 — OPERATOR and CONTROLLER

Two coordination agents sit above the specialists that do the work.

- **Operator** — coordinates **one task**. Deployed per project, holds a capability
  policy, woken by events on that task.
- **Controller** (ruling 99) — coordinates **the instance**. Exactly one per
  deployment, conversational, holds *no authority of its own*: every tool call runs
  under the asking human's live permissions.

The controller sits *above* operators and never replaces them — it briefs, triggers
and steers them, and each chained-goal task gets its own operator.

Sources: `docs/architecture/decisions.md:1325-1408` (ruling 99),
`planning/discovery-2026-08-30-controller/DESIGN.md`,
`planning/discovery-2026-08-30-bug-sweep/RESOLVED.md`.

---

## 1. The operator

### 1.1 Authority

`resolveOperatorAuthority(ctx, projectSlug, overrides)` —
`app/server/tasks/operator-actions.server.ts:353`. Reads the project's `agents:`
deployment whose profile `kind === "operator"`, returns `OperatorAuthority` (`:106`):
`policy` (capabilityId → `direct|recommend|human|off`), `autonomy`,
`configuredAutonomy`, `autonomyClampedFrom`, `backend`/`model`/`effort`,
`skills`/`kb`/`mcps`/`persona`, `deployed`, `humanGatedBeforeWork` (derived from the
workflow graph, not a stored preset).

**R19-A ceiling.** `clampAutonomy(requested, ceiling)` (`:227`) — a run may sit at or
below the deployment's configured autonomy, never above. A clamp that *bites* writes
`AUTONOMY_CLAMPED_AUDIT_ACTION = "task.operator.autonomy_clamped"` (`:197`) via
`auditAutonomyClamp` (`:249`), and **only** when the caller passed a `db`: loader
paths resolve authority as a pure read, and a read must not write audit rows.

Three gate functions, because two capabilities carry *absent-means-granted* polarity:

| gate | line | rule |
| --- | --- | --- |
| `gate(authority, id)` | `:446` | `direct`→direct; `recommend`→direct **only** under full autonomy, *except* `completion-for-acceptance` (owner ruling Q1); `human`/`off`→deny; not deployed→deny (A4) |
| `deliverGate` | `:476` | `deliver-review-pr`. Absent grant → `absentDeliverReviewPrMode(humanGatedBeforeWork)` (R15-9), so governance decides, not creation date. Undeployed still denies — before A4 an undeployed operator could push a branch and open a PR |
| `dispatchGate` | `:518` | `dispatch-agents`. Ruling 98(b) collapsed `assign-primary-specialist` + `summon-reviewers` into this id; pre-rework deployments store only the retired ids, so absent → catalog default `direct`. The plain `gate` read it as deny and silently removed dispatching from every existing project |

### 1.2 What wakes it — the triggers

`RunOperatorInput.trigger` (`app/server/runtimes/operator-run.server.ts:160`) is a
closed union of nine values and decides the turn doctrine:

| trigger | posture | fired from |
| --- | --- | --- |
| `create` | COORDINATE | `createTask` (`task-actions.server.ts:554`) |
| `transition` | COORDINATE | every stage move (`:4501`) + the stranded backstop (`operator-run.server.ts:805`) |
| `goal-updated` | re-scope | `updateTaskGoal` (`:633`) |
| `agent-reply` | REACT | the specialist completion pipeline (`:3720`) |
| `pr-diverged` | RECOVER | `github-reconciler.server.ts:793` |
| `delivered` | PROCEED | a full-autonomy delivery that opened a NEW PR (`:5049`) |
| `packet-resolved` | PROCEED | `resolvePacket` when no asking agent absorbed it (`:6431`) |
| `scheduled` | RE-CHECK | the schedule runner (`schedule.server.ts:628`) |
| `manual` | COORDINATE | Run-operator button (`routes/project.task.tsx:945`), `@operator` comment (`:1421`), boot recovery (`run-recovery.server.ts:167`), the controller (`controller-toolkit.server.ts:1161`) |

`autoInvokeOperator` (`task-actions.server.ts:862`) is the shared fire-and-forget
seam: dynamic-imported to avoid a module cycle, a no-op when no operator is deployed,
and — after C1 (pass 23) — it writes an honest timeline note if the handoff *throws*
before a run row exists, because a throw used to stop coordination in silence.

### 1.3 Fire-time refusals

`runOperator` (`:1162`) returns `{ runId: null, queued: false, refused }` for two cases:

- **`"terminal-stage"`** (`:1198`) — FR39/F19-20. A `scheduled` re-run never fires on a
  terminal stage, checked **where the run starts**, not only where the occurrence was
  claimed (the drain is sequential and a queued trigger has no mootness re-check).
  Calls `settleWaitingAfterOperator` so the refusal cannot strand `waiting: agent`.
- **`"open-packet"`** (`:1237`) — R20-1/F20-5. A **human-pressed** Run operator while a
  packet is open is a paid no-op (live: 6 turns, $0.27, only `get_task`). Scoped to
  `manual`: `pr-diverged` legitimately withdraws a moot packet, `agent-reply` reacts to
  a run already in flight.

### 1.4 Single-flight lease and the trigger queue

One drive per task, on `Symbol.for("viberr.operatorLease")` (`:332`) so an HMR reload
keeps it. Held from `runOperator` entry through provider completion **and**, on Codex,
through structured-plan execution — the `agent_runs` row alone under-covers both.

`queueOperatorTrigger` (`:385`) coalesces **per kind**:

- machine triggers → `PendingTriggers.latest`, newest-wins (the operator re-reads the
  whole task anyway);
- **reason-carrying** triggers → `carried`, an ordered FIFO capped at
  `MAX_PENDING_CARRIED_TRIGGERS = 8` (`:372`), drained oldest-first *ahead* of the
  machine slot. Two qualify: a human `@operator …` comment, and a `scheduled`
  re-check (its note is the reason the run exists, and the runner already stamped the
  occurrence `fired`). Consecutive comments from the **same author** merge into one turn.
- Anything pushed off the back gets `noteDroppedOperatorTurn` (`:439`) with kind-aware
  copy — never a bare `logger.warn`.

Cross-boot: `inFlightOperatorRun` (`:250`) flags a `restartOrphan` (row created before
`PROCESS_START_MS`, `:247`). Such a row has no completion callback behind it, so
`runOperator` finalizes it and drives now rather than chaining onto a dead callback (B10).

### 1.5 Loop caps and the stranded backstop

| cap | value | where |
| --- | --- | --- |
| `OPERATOR_REACT_DEPTH_CAP` | 4 | `task-actions.server.ts:173` |
| `OPERATOR_TRANSITION_CHAIN_CAP` | 8 | `task-actions.server.ts:186` |
| `RECOVERY_REINVOKE_CAP` | 3 / 30 min | `run-recovery.server.ts:19` |

`nextTransitionChainDepth` (`:189`) restarts at 0 for a human move, increments for an
operator move; the cap opens a stuck-loop packet instead of looping.

`maybeResumeStrandedOperator` (`operator-run.server.ts:667`) is the settle-time
backstop for `operatorLeftTaskStranded` (`:644`) — not archived, no packet, no pending
recommendation, current stage has an outbound `auto` boundary. It refuses to fire
unless the ref knows `stageAtStart` (a `null` means the read failed and is logged
loudly — B6), unless the ref names its own `runId`, and unless that run is `finished`.
If the drive moved the stage, the transition's own re-trigger owns the follow-up.

### 1.6 The turn instruction

`operatorTurnDoctrine(snapshot, trigger, humanComment, humanCommentBy, transition,
scheduleNote, resolvedOption)` (`:3153`) → the trigger-specific doctrine;
`operatorTurnInstruction` (`:3333`) appends `CAPABILITY_GAP_REMEDY_INSTRUCTION`
(`:3081`, ruling 85: a packet must name the grantable capability, not only
workarounds). `buildOperatorTurnPrompt` (`:3373`) for Claude,
`buildCodexOperatorPrompt` (`:3340`) for Codex.

Notable arms: `pr-diverged` branches on `pr.state` and force-feeds
`driftInstruction(snapshot)` (`:3136`) so a recovery packet cannot omit unreviewed
commits (F21-17). The default arm states that **`liveRuns` is the only proof a run is
in flight** — `waiting` is a display flag and a directive comment is not a running agent.

### 1.7 The snapshot — `get_task`

`operatorSnapshot` (`operator-actions.server.ts:1577`) → `OperatorTaskSnapshot`
(`:1238`). Each of these fields closed a live blindness:

- `previousStage` — durable `previousStageId`; "arrived back from Review" reads as
  rework for the same builder.
- `validation` — `deriveValidation(fm)`, the derived review outcome (F27-O5).
- `reworkStages` (`:1289`) — R7-4. The forward-only graph never lists earlier stages, so
  an operator reading only `nextStages` concluded it could not send failed work back.
  Non-empty only while validation is `failing`.
- `pr.revisionDrift` — the same fact the acceptance ceremony discloses (R17-1).
- `noChanges` — `noChangeApplies(fm)` (R19-8).
- `liveRuns` — queued/running rows.
- `recommendations.pending` + `.declined`; the latter reads
  `task.recommendation.dismissed` audit rows (`declinedRecommendations`, `:1480`),
  bounded to `MAX_SNAPSHOT_RECOMMENDATIONS = 5`. Without it a supervised operator
  re-proposed a just-declined move forever.
- `operatorPolicy` (`:1426`) — labelled `scope: "operator"` and carrying
  `OPERATOR_POLICY_SCOPE_NOTE` (`:1531`), because a live operator read
  `use-web-search-fetch: off` out of an unlabelled map and filed a packet claiming a
  *specialist's* web grant had failed (F21-16). The note also carries F21-14:
  `transition-to-done: human` is the raw transition, not a bar on `accept_completion`.

### 1.8 Tools

Claude gets an in-process SDK MCP server named `viberr`
(`app/server/tasks/operator-toolkit.server.ts`). **A withheld capability means the tool
is not built** — the model cannot reach it:

`get_task` (`:261`) · `read_default_branch_file` (`:289`, only with a checkout) ·
`post_comment` (`:343`) · `set_goal` (`:355`) · `flag_context_conflict` (`:373`) ·
`open_decision_packet` (`:412`) · `resolve_decision_packet` (`:511`) · `run_agent`
(`:538`) · `deliver_for_review` (`:582`) · `update_branch_from_base` (`:608`) ·
`transition_stage` (`:623`) · `accept_completion` (`:648`).

Codex emits a **structured plan** against `OPERATOR_PLAN_TOOLS`
(`operator-run.server.ts:1437`) — the same verb set minus the reads — narrowed by
`operatorPlanToolsFor(authority)` (`:1502`) through the identical three gates
(`OPERATOR_PLAN_TOOL_CAPABILITIES`, `:1478`). An operator with nothing granted falls
back to the full list **except** `deliver_for_review` and `update_branch_from_base`,
the two plan actions with effects outside Viberr.

Both backends deny filesystem writes and shell; the read half is the read-only
repository checkout `ensureOperatorRepoCheckout` (`:1054`) provisions under the run's
cwd (R19-1), described by `workspaceSection` (`:2728`).

### 1.9 The governed actions

Every action returns `OperatorActionResult` (`operator-actions.server.ts:161`) with
`outcome: done | recommended | denied | noop`. **The `denied`/`noop` split is
load-bearing**: `narrateRefusedActions` (`operator-run.server.ts:2292`) files a refused
plan step under "refused by its capability policy" vs "did not apply to the task's
current state" purely on this field, and emits a `policy` timeline event only for the
authority bucket (LV-03 — the activity feed reads `policy` as a governance signal).

| function | capability |
| --- | --- |
| `operatorPostComment` (`:1774`) · `operatorSetGoal` (`:1881`) · `operatorFlagContextConflict` (`:1818`) | `append-typed-events` |
| `operatorOpenPacket` (`:929`) · `operatorResolvePacket` (`:1110`) | `generate-packets` |
| `operatorDispatchAgent` (`:2113`) | `dispatch-agents` (`dispatchGate`) |
| `operatorDeliverForReview` (`:2285`) | `deliver-review-pr` (`deliverGate`) |
| `operatorTransitionStage` (`:2379`) | `stage-transitions` |
| `operatorAcceptCompletion` (`:2568`) | `completion-for-acceptance` |

**Comment guardrails.** `writeOperatorComment` (`:568`) enforces five per-project
guardrails for real — meaningful-comment, evidence-separation, operator-brevity,
no-duplicate-summary (compared against the last operator comment *inside* the write
lock), compression-threshold at the **configured** value (the settings row advertised
40 while the code hardcoded 60). A drop records `COMMENT_DROPPED_AUDIT_ACTION` and the
function returns a `CommentGuardrailResult` rather than `void` — the model used to be
told "Comment posted" for a comment nobody would ever see.

**Recommendations.** `addRecommendation` (`:721`) writes an Apply/Dismiss card, sets
`waiting = "human"`, notifies supervisors on a **new** card only, fans out `@mentions`
(NEW-4). Dedupe is per `(kind, profileId, toStageId)`, but a **changed**
`prompt`/`delivers`/`label` replaces the pending card in place and counts as new — the
2026-08-29 hunt found the operator narrating Y while Apply dispatched the stale X.

**Dispatch.** `operatorDispatchAgent` (`:2113`) replaced engage/run/prompt.
`resolveDeliversIntent` (`:2077`) is the shared posture rule: explicit hint wins → an
engaged profile keeps its shape → an unengaged profile delivers iff the task has no
deliverer *and* the profile holds repo-write. Two contradictory hints are refused as
`noop`: `delivers: true` on a profile with no repo-write; `delivers: false` aimed at
the *current* deliverer. Every selection writes `task.operator.agent_selected` listing
each candidate with `eligibleForStage`/`alreadyEngaged`/`chosen` (`:2029`).

**Transitions.** `operatorTransitionStage` (`:2379`) crosses an `auto` boundary
directly even when supervised (an `auto` edge declares "no approval needed"), and
performs a **rework** move directly when `isReworkMove` (`:2482`) holds — backward +
`validation === "failing"` — so a failed review re-drives itself. F19-26: a supervised
`transition_stage(<terminal>)` is **rerouted** to `operatorAcceptCompletion`, because
the old path filed a "Move the task to Done" card whose Apply ran a real PR merge under
a label that never said "accept" or "merge"; R19-6 made that reroute answer to the
acceptance capability rather than `stage-transitions`.

**Acceptance.** `operatorAcceptCompletion` (`:2568`) reads
`completionCapabilityRefusal` (`:2542`) **first, before any read, card or audit row**
(R19-6) — `off` and `human` are both hard refusals with different wording. Then
`acceptanceNoChangeCheck` runs *before* the shared `acceptanceRefusalFor` gate
(F28-L1), so a verified-empty completion is not refused "no review pull request". Full
autonomy + `completion-for-acceptance: direct` writes through `applyAcceptanceWrite`;
anything else files an `accept_completion` card whose copy keys on `noChangeApplies` so
it never promises a merge for a task with no PR. The operator **cannot merge** (a merge
needs a user identity), so it records the PR as `accepted` (merge pending). If
`applyAcceptanceWrite` returns `accepted: false`, a racing human acceptance won the
lock and the operator's audit row is skipped (U3/NFR16).

### 1.10 Decision packets — the ten kinds

`PACKET_OPTION_KINDS` — `app/schemas/task-file.schema.ts:128`, mirrored (and
drift-tested) in `docs/architecture/file-formats.md:206`. `resolvePacket` is
`task-actions.server.ts:5792`; the dispatch switch is `:5910`.

| kind | meaning | what resolution does |
| --- | --- | --- |
| `accept_completion` | Accept the work into Done and merge the PR | Arm `:5911`. Authority → disclosure → live no-change probe → `acceptanceRefusalReason` → `acceptancePrHeadCheck` → `attemptAcceptanceMerge` with a `beforeMerge` re-check of `packetIdentity` **and** the full refusal stack (P14-GV-05/B-WF1) → locked write to the terminal stage. Not re-queued |
| `request_edit` | Send back to the agent | `default:` arm `:6287`. `waiting: agent`, `readiness: ready`, packet cleared, re-queued; in `sentBackToAgent` so an Agent question routes to `askedBy` first |
| `block_on_policy` | "I fixed the policy/credential — unblock and re-run" | `:6125`. R20-1 turned this from a hold into a real unblock: `readiness: ready`, `waiting: agent`, re-queued. Never touches `validation` (B-WF2) |
| `hold_runtime_debug` | Freeze coordination while I inspect the session | `:6152`. `readiness: blocked`, `waiting: human`, packet cleared (so the board's Blocked filter still lists it), **not** re-queued |
| `redirect` | Re-engage with corrected guidance | `default:` arm, same as `request_edit` |
| `retry_other_backend` | Re-run the failed agent on the other backend | `:6200` + `:6661`. `startAgentRun` with `backendOverride` under `operatorAuthorized`. The switch **sticks** via the engagement's `pinnedBackend` (F27-B1). A failed start never un-resolves the packet — it appends a `blocked` note |
| `edit_goal` | A human refines the goal | `:6178`. **The only kind that keeps its packet open**: stamps `packet.awaiting = "goal_edit"`, `waiting: human`. Cleared by `updateTaskGoal` (`:585`) or `operatorSetGoal` (`:1913`) when the edit lands. A second confirm 409s (`:5852`) |
| `archive_task` | Archive as the disposition; `deleteBranch: true` also deletes the remote branch | `:6225` + `:6460`. Re-checks `approve-transition` in the arm; `setTaskArchived` (cancels pending schedules, clears recommendations); `deleteTaskRemoteBranch`; F20-24 then discards the **local** branch too unless the remote deletion was `refused`. **The product's only remote-branch deletion path** (ruling 17) |
| `discard_branch` | Delete the LOCAL, never-pushed workspace branch | `:6257` + `:6572`. Cleanup, not a disposition — the task stays on the board. Re-checks `approve-transition` (it destroys commits). `on_remote` refuses and points at the archive option. `fm.branch = null` only on `deleted` |
| `custom` | Free-form | `default:` arm. Also **synthetic**: a non-empty `input.custom` (≤4000 chars) ignores `optionIndex` and builds one at `:5837` |

Header fields (`taskPacketSchema`, `:500`): `id` (F10-09, `newId("pkt")`) · `type`
(`input | blocked`; `blocked` sets `readiness = "blocked"` on open and deliberately
does **not** touch `validation` — F7-VAL1) · `kind` (free text, but
`kind === "Agent question"` is load-bearing at `:6412`) · `from` (an actor-ref codec
string, not a display name — `operatorResolvePacket` refuses anything not
`"operator"`) · `title` · `body` · `observations` · `options` · `awaiting` (only value
`"goal_edit"`) · `askedBy` (R15-14, the agent profileId whose session resumes on
resolution).

### 1.11 Who opens a packet

**One packet at a time per task.** Every writer refuses on the pre-read *and* again
inside the locked write (B3).

| opener | file:line | trigger | kinds offered |
| --- | --- | --- | --- |
| `operatorOpenPacket` | `operator-actions.server.ts:929` | the operator's own decision | any of the ten |
| `open_decision_packet` tool | `operator-toolkit.server.ts:411` | Claude model call, via `operatorOpenPacketDisclosed` (`:230`, appends the R20-9 delegated-ask disclosure) | any |
| Codex plan `open_packet` | `operator-run.server.ts:2095` | plan step | `authoredPacketOptions` (`:1672`) else `defaultPacketOptions` (`:1712`) |
| `openAgentQuestionPacket` | `agent-toolkit.server.ts:187` | agent `ask_human`, gated by the `ask-human` grant | `custom` only |
| Codex outcome envelope | `task-actions.server.ts:2866` | agent question in the envelope | `custom` only; a held question becomes a `note` when a packet is open (P13-RT-06) |
| `openStuckLoopPacket` | `task-actions.server.ts:2221` | (a) an agent run **failed** `:3534`, (b) `noProgress`/depth-cap in the react loop `:3677`, (c) `OPERATOR_TRANSITION_CHAIN_CAP` in `transitionStage` `:4492` | `redirect` · `request_edit` · `hold_runtime_debug`, **plus** a recommended `retry_other_backend` when the failure kind is quota/auth/unavailable |
| `escalateFailedOperatorRun` | `operator-run.server.ts:2529` | the operator's OWN run errored | `defaultPacketOptions("blocked")`, body + a `Provider said` observation (R20-3/F20-4) |
| no-plan escalation | `operator-run.server.ts:2000` | Codex produced no parseable plan | `defaultPacketOptions("blocked")`; falls back to `writeOperatorNoPlanNote` (`:2358`) when `generate-packets` is withheld (G6) |
| `operatorUpdateBranchFromBase` | `github/update-branch-operator.server.ts:238` | merge/push conflict bringing the branch up to base | `conflictOptions` (`:97`): `redirect` (rec) · `custom` · `archive_task`, each with an explicit `ev` |
| **pr-diverged** | wake at `github-reconciler.server.ts:776`; doctrine at `operator-run.server.ts:3197` | GitHub reported closed / closed-at-terminal / merged / reopened | *model-authored*. Closed+active → a `custom` rework option + `archive_task` + `archive_task{deleteBranch}`. Merged → no packet, use `accept_completion`. Reopened → withdraw the moot packet |

`defaultPacketOptions(type)` (`operator-run.server.ts:1712`): `blocked` →
`block_on_policy` (rec) · `redirect` · `hold_runtime_debug`; `input` → `request_edit`
(rec) · `redirect` · `custom`. R20-1 rewrote every `blocked` label to say exactly what
will happen — the old "…and unblock" recorded a hold and re-accepted the same confirm
forever.

Boot recovery opens no packet directly; `recoverUnreactedAgentRuns` and
`recoverStrandedOperatorPlans` (`run-recovery.server.ts`) *replay* the effects that
may open one, each idempotency-marked and capped.

**Withdrawals.** `withdrawSupersededStuckPacket` (`task-actions.server.ts:2340`) — a
successful agent run moots a `blocked` packet with no `accept_completion` option
(joined on `profileId` when a `retry_other_backend` option names one).
`withdrawSupersededDeliveryPacket` (`:2434`, F29-7) — the same shape keyed on a
`discard_branch` option once delivery succeeded, deliberately leaving reject-recovery
packets (which use `archive_task`) alone. `operatorResolvePacket` (`:1110`) refuses as
`denied` when `packet.from !== "operator" || packet.askedBy` (B2) — the operator must
never silently withdraw an agent's question, which would leave the agent blocked on an
answer with no surface and the R15-14 resume never firing.

### 1.12 Resolution, forced acceptance, and the disclosure contract

**Who may resolve** (`resolvePacket:5866`): `accept_completion` skips the outer gate and
is guarded by `requireAcceptCompletion` (`:320`) instead; otherwise a live task owner
passes via `ownerException` (`:306` — requires a real `userId`, matching
`ownerUserId`, **and** a *current* `own-task` capability), else
`requireAction(…, "resolve-packet")` (`[admin, maintainer]`). Per-kind re-checks:
`archive_task` and `discard_branch` both re-assert `approve-transition` inside their
arms. A stranded contributor-owner uses `requestPacketMaintainerDecision` (`:6721`),
which notifies and audits `task.packet.escalated` but **never mutates the packet**.

**`packetIdentity(p)`** (`:5776`) — `id:<id>` when present, else a content fingerprint
over `{kind, title, from, awaiting, options[{kind,t,profileId,backend}]}` for
pre-F10-09 files. Checked at **three** points: snapshotted before any await (`:5868`),
re-compared inside `beforeMerge` right before the irreversible GitHub write (`:5999`),
and again inside the write lock (`:6335`). All three raise *"This decision was replaced
by a newer one."* A task already at `acceptsInto` when the lock is taken sets
`alreadyAccepted` and **skips the whole write, the audit row and the branch cleanup**
(U3) — the racing acceptance owns them.

Audit: `task.packet.resolved` (`:6360`, details `{optionKind, optionTitle,
packetKind}`) · `task.operator.packet_opened` · `task.agent.packet_opened` ·
`task.packet.withdrawn_superseded` · `task.packet.escalated` ·
`task.branch.discarded` / `.discard_refused` · `task.acceptance.forced`.
`markTaskPacketApprovalRead` (`notifications.server.ts:312`) runs on **every** settled
decision — including `edit_goal`, which keeps its packet open, because that is a made
decision too.

**Forced acceptance.** `forceAcceptCompletion` (`:8048`), gated on
`force-accept-completion` — `[admin]` only, **no owner exception**
(`app/shared/rbac.ts:88`). Order is deliberate: authority → already-Done early return
*without* an audit row ("don't record a 'forced' row for an override that overrode
nothing") → `forceIrreducibleRefusal` (`:6967`), the one gate force may **not** bypass
(a closed PR: *"force-accept exists for a wedged review gate, not for a pull request
GitHub has already closed"* — F19-25/R16-3) → disclosure assertion → compute
`bypassed` from the **pre-write** state → accept → audit `task.acceptance.forced`
`{ bypassed }` only if it actually accepted.

`force: true` replaces the refusal stack but **never** skips `acceptancePrHeadCheck`
(`:7788`): *"force bypasses missing/failed verdicts and stale packets, never a PR that
carries different content than was delivered (F15-15: that is how junk would merge with
a green review attached)."* The durable fact is
`frontmatter.acceptance: "forced"` (`task-file.schema.ts:662`), written in exactly one
place (`applyAcceptanceWrite:7614`) and read by `deriveValidation` (`:773`) to return
`"bypassed"`, rendered as a `risk`-toned pill. **A packet resolution can never produce
`acceptance: "forced"`** — only `forceAcceptCompletion` reaches it.

**The disclosure contract — read this carefully.** There is **no `AcceptDisclosure`
exception in the tree**. The pass-19 class of that name was lost in a two-session merge
(`app/shared/acceptance-disclosure.ts:11`), and the comment at
`decision-packet.tsx:131` referring to an `AcceptDisclosureProvider` context is stale —
that context never shipped. What ships is **`AcceptanceDisclosure`**, a *form-field
echo contract* (ruling 88 / F21-2), defined once and shared by both sides in
`app/shared/acceptance-disclosure.ts`:

```ts
interface AcceptanceDisclosure { pr: PrState | "none"; revision: string; verdict: Validation }
const ACCEPT_DISCLOSURE_FIELDS = { pr: "ackPr", revision: "ackRevision", verdict: "ackVerdict" };
```

The dialog builds it **once, from the rendered props** (`accept-confirm.tsx:254`) — so
the acknowledgment the server verifies is the disclosure the human actually read. The
server compares it against `acceptanceDisclosureOf(fm)` (`:7433`), derived from the
canonical file with `verdict` run through `deriveValidation` so it can never disagree
with the pill. `assertAcceptanceDisclosure` (`:7466`) is three-state:

| `ack` | meaning | result |
| --- | --- | --- |
| an object | the human confirmed | compare via `acceptanceDisclosureDrift`; drift → **409** `accept_disclosure_stale` |
| `null` | an HTTP door sent no echo (a bare POST) | **400** `accept_disclosure_missing` |
| `undefined` | an **in-process** caller with its own contract (full-autonomy operator, tests) | return immediately |

Five server call sites: `resolvePacket:5927` (`full`) and `:6092` (`in-lock`),
`applyAcceptanceWrite:7575` (`in-lock`), `acceptCompletion:7732` (`full`),
`forceAcceptCompletion:8097` (`full`). `scope: "in-lock"` skips the PR fact (the
acceptance's own merge may have moved `review → merged`) and compares only revision +
verdict. Crucially, **`skipInLockRecheck` does not relax the disclosure** (`:7570`):
*"force bypasses process GATES, and this is not a gate: it is the record of what the
human was shown."*

Six ceremony modes (`accept-confirm.tsx:50`): `accept` · `force` ·
`complete-merge` · `apply-recommendation` · `packet` · `stage-move`. `complete-merge`
is the only one that sends **no** disclosure (R16-6: the acceptance already happened).
A force adds two rows the ordinary accept never shows — **Skips** (enumerating every
stage between here and terminal, gated on `force && !atBoundary`, because force is the
only mode that jumps) and **Bypassing** (the same string the audit records; on
non-force modes the row reads **Blocked**, since "Bypassing" would promise an override
nobody has).

The packet UI intercepts rather than submits: `onResolve`
(`task-detail-page.tsx:463`) routes an `accept_completion` option into the ceremony
with `mode: "packet"`, using `acceptance.blockedReasonViaPacket` — because a packet
resolution evaluates the contract with `blockedPacket: false`: the open packet is what
this resolution *clears*, so it cannot also be the reason to refuse it.
`archive_task` and `discard_branch` get their own local confirms
(`PacketArchiveConfirm` `:143`, `PacketDiscardConfirm` `:288`) — nothing to disclose
about a merge, but a branch deletion that "cannot be undone" is named outright.

---

## 2. The controller

### 2.1 Identity

`kind: controller`, exactly one per instance (`CONTROLLER_PROFILE_ID`,
`app/server/controller/controller-profile.server.ts:39`). Profile template
`agents/profiles/controller.md`; doctrine body `agents/definitions/controller.md`, read
by `readControllerDefinition` (`:79`) with `FALLBACK_CONTROLLER_DEFINITION` (`:60`)
baked in so a hand-wiped store still refuses correctly instead of running promptless.
`resolveControllerConfig` (`:117`) degrades to defaults and reports
`profilePresent: false` rather than downing the surface. `saveControllerConfig`
(`:147`) is org-admin-gated by its caller, preserves the shipped frontmatter head, and
audits `org.controller.updated`.

- **No capability matrix** — its runtime authority is the asking user's, so a stored
  grant row would be a toggle with no effect (the P14-KM-14 class).
- **Not deployable to projects**; `readTemplate` resolves a controller-kind template as
  absent so the two-kind deployment world stays closed.
- **Claude only, enforced and disclosed** — the `read-github-api` decision: the toolkit
  is in-process, DB handles and sealed credentials never cross a process boundary, and
  Codex's single-shot plan executor cannot serve a conversation that reads mid-turn.

### 2.2 The authority model

`buildControllerToolkit(deps)` (`controller-toolkit.server.ts:168`) builds an SDK MCP
server `viberr_controller` per turn:

- Actor `{ userId, label: "<email> · via controller" }` (`:174`) — guards bind to the
  human, the audit row discloses the instrument.
- `orgAdmin()` (`:178`) resolves **live** per call, never snapshotted.
- `requireOrgAdmin` (`:182`) refuses *and* writes `controller.authority.denied` —
  P13-D-8 parity, so instance denials do not read cleaner than project ones.
- `requireVisible` (`:196`) routes through `assertProjectAction(db, "any-member", …,
  { allowArchived: true })` and converts **any** failure into the uniform
  `notVisible(slug)` sentence (`:159`): missing and forbidden read identically, so a
  probe cannot learn a project exists (R15-4).
- `run` / `runWith` (`:220`, `:243`) map a 401/403 `AppError` to
  `[denied] <the guard's own sentence>` and anything else to `[error] …`.
  `CONTROLLER_TOOLKIT_INSTRUCTIONS` (`:145`) tells the model a `[denied]` is final.

**Always-human stays human.** No tool for merge, acceptance, force-accept, packet
resolution, or a terminal-stage move; `move_task` (`:1004`) refuses a Done target out
loud and points at the task page — ruling 88's ceremony is what chat cannot
impersonate. **No deletes anywhere.** Secrets never travel through chat
(`save_mcp_server` takes no credential); the one exception is relaying a just-minted
single-use temp password, bounded by `pwreset_required`.

### 2.3 Tool surface

Instance (org-admin, except `create_project` which is any signed-in user per FR5, with
the creator seeded project admin): `whoami`, `list_users`, `create_user`,
`update_user`, `set_user_org_role`, KB/skill/MCP list+save, `test_mcp_server`,
`list_global_agents`, `save_global_agent`, `inspect_audit_log`,
`inspect_run_analytics`, `create_project`.

Project (RBAC matrix): `get_project`, `list_tasks`, `get_task`, `create_task`,
`move_task`, `comment_on_task`, `set_task_owner`, `run_agent_on_task`,
`get_github_state`, `update_project_settings`, `update_stages`,
`set_transition_boundary`, `invite_member`, `set_member_role`, `deploy_agent`,
`update_agent_deployment`.

Goals: `create_goal` (`:1525`), `list_goals`, `get_goal`, `update_goal` (`:1618`).

`run_agent_on_task` (`:1127`) is the operator seam: `canRunAgents` (maintainer+), then
either `runOperator({ trigger: "manual", humanComment, humanCommentBy })` — relaying
`refused: "open-packet"` / `"terminal-stage"` / `queued` honestly — or `startAgentRun`.

### 2.4 Conversations

`controller_conversations` + `controller_messages`
(`controller-conversations.server.ts`) — the notifications/sessions family; a
transcript is single-writer app collaboration state, not board truth.
`canAccessConversation` (`:105`) allows the owner and live-resolved org admins; project
members do **not** read each other's. `requireConversation` (`:128`) throws a 404-shape
so a non-owner cannot distinguish "not yours" from "never existed". `appendMessage`
(`:239`) allocates `seq` as `MAX+1` under the SQLite write lock behind a
`UNIQUE (conversation_id, seq)` index, derives the title from the first user message,
and publishes the owner-routed SSE `controller.updated`.

**One message = one run** — `runControllerTurn` (`controller-run.server.ts:121`):

1. Records the user message **first** — whether a run starts or queues is a scheduling
   fact, not a data one.
2. Refuses honestly *in-transcript* when `isBackendAvailable("claude")` is false.
3. Single-flight on `Symbol.for("viberr.controllerLease")` (`:67`) with a FIFO capped at
   `MAX_QUEUED_MESSAGES = 8`. A queue-full message gets its own refusal **in the
   transcript** — a toast is gone by the time anyone re-opens the thread.
4. `startTurnRun` (`:204`) resolves org MCP grants **once** (F21-3: prompt and mount
   from the same result), then starts or resumes a run with `kind: "controller"`,
   `projectSlug: ""`, `taskKey: <conversation id>` — a scope no task query matches.
   `disallowedTools = ["Read","Grep","Glob","WebFetch","WebSearch"]`: the controller's
   world is the product, not the disk.
5. Continuity: `latestTurnRun` (`:91`) is the resume anchor, plus a bounded
   `transcriptDigest` (`:559`; 30 messages / 24 000 chars, budgeted newest-first then
   restored chronologically) — the controller has no `task.md` to re-anchor on.
6. `settleTurn` (`:344`) records the reply, releases the lease, fires the next queued
   message, names a failure's cause (quota/auth/generic), and on a failed queued start
   says **how many** messages it dropped with it.

`buildControllerSystemPrompt` (`:590`) = doctrine + trusted-resource banner + skills +
KBs + a runtime block naming mounted **and unmounted** MCP servers + a conversation
block naming the asker, their live org role, the project binding, and the rule that
only this person's own messages authorize actions. `canReadControllerRunLog` (`:438`)
authorizes the run-log console by conversation ownership or live org-admin, never by
project membership.

### 2.5 Chained goals

> Naming note: the design doc's `advanceGoalForTask`
> (`planning/discovery-2026-08-30-controller/DESIGN.md:112`) **does not exist**. The
> shipped hook is `maybeReconcileGoalForTask` and the engine is `reconcileGoal`.

Canonical file `projects/<slug>/goals/<goal-id>.md`
(`app/server/files/goal-writer.server.ts`, schema `app/schemas/goal-file.schema.ts`).
Frontmatter: `id`, `title`, `status: active|paused|attention|completed|cancelled`,
`createdBy`, `createdByLabel`, `onFailure: pause|continue`,
`links[{index,title,goal,taskKey,status,note}]` with link status
`pending|active|done|failed|skipped`, `createdAt`, `updatedAt`. Body: `## Description`
plus a `## Timeline` of newest-first `- <ISO> · <text>` bullets (a *simpler* grammar
than the task timeline — a goal's history is single-writer app narration). Unknown
frontmatter keys round-trip. The back-reference is the task's
`goalRef: {goalId, linkIndex}` (`task-file.schema.ts:671`), projected to
`task_projections.goal_id` / `goal_link_index` so nothing joins through files at read
time.

**Authority** (`goal-actions.server.ts:39-65`):

- **Create** — the asking user's own `create-task` (`createGoal:117`, `requireAction`
  at `:125`). A chain is a promise of future task creation, gated where its effect is.
- **Advance** — nobody is present, so it runs under the recorded creator and
  **re-proves** their live `create-task` (`creatorMayCreateTasks:501`, with
  `silentDeny: true` — an unattended advance probing a lost authority is a pause, not
  an attempt to exceed). Lost authority parks the chain in `attention` and notifies
  (FR39's precedent).
- **Redirect** — `requireGoalAuthority` (`:237`): the creator themselves (membership +
  an explicit `requireProjectMutable`, because that arm bypasses the `requireAction`
  chokepoint that freezes an archived project) **or** a member holding `run-agents`.

**Lifecycle.** `createGoal` holds `withGoalsLock` across id minting → link 1's
`createTask` → the goal-file write; link 1's task is created *first* so a refusal
leaves no orphan file. `GOAL_MAX_LINKS = 20`.

`reconcileGoal` (`:631`) is **the convergent engine** — hooks and the runner both just
say "look at this goal now". It derives each linked task's state from the **canonical
file**, not the projection (archived → failed, terminal stage → done, missing → gone);
re-derives `done` only for a genuine re-opening; parks in `attention` on a failure when
`onFailure: pause`, or marks the link `skipped` and moves on when `continue`; completes
the goal when `allLinksSettled` and the status is not `attention` (audit
`goal.completed`); and starts the next link through `startLinkTask` (`:534`).

`startLinkTask` takes a **per-link** `withFileLock("goal-start:…")`, re-checks the
chain status *and* the link's mode inside it, and re-checks the status **again** under
the goal-file lock after `createTask` returns, abandoning the attach if a cancel/pause
committed in the window. `notifyCreator` (`:474`) emits notification kind `controller`
(`app/shared/mapping/notification.server.ts:25`).

Hooks: `maybeReconcileGoalForTask` (`:847`) fires from three task write paths —
transition (`task-actions.server.ts:4526`), archive (`:5760`), acceptance (`:7675`) —
plus `reconcileAllGoals` (`:884`) over
`goal_projections WHERE status IN ('active','attention')`, run once at boot and then by
`startGoalRunner` (`:921`) every `GOAL_TICK_MS = 60_000` (`boot.server.ts:678`).

Redirect ops (`UpdateGoalOp`, `:220`): `pause`, `resume`, `cancel`, `skip_link`,
`retry_link`, `edit_link`, `add_link`, `remove_pending_link`. The **project route
accepts only the first five** (`project.controller.tsx:98`); the other three are
controller-tool-only. Nothing deletes a goal; terminal chains stay readable.

Projection: `goal_projections` (`0001_baseline.sql:203`), rebuilt by `rebuildGoalFile`
(`rebuilder.server.ts:733`) with link statuses **re-derived against live task rows**
(`:811`), goals walked *after* tasks so they read fresh rows. One SSE event,
`goal.updated`, emitted only from that rebuilder — which is why `updateGoalFile`'s
no-op-write guard matters. Watcher path class at
`file-watch.service.server.ts:261`; the store doctor walks goal files
(`store-check.server.ts:220`).

### 2.6 Surfaces

- `/controller` (`app/routes/controller.tsx`) — every signed-in user; `?c=<id>` selects
  a conversation, `?all=1` is the org-admin everyone's-conversations view.
- `/projects/:slug/controller` (`app/routes/project.controller.tsx`) — the eighth
  `WORKSPACE_NAV` item (`app/features/shell/nav.ts:25`). `requireProjectMember` on
  **this** loader, not only the layout's, closing the F19-28 single-fetch `?_routes=`
  hole. Its `goal-op` intent drives `updateGoal`.
- `getControllerSurface` (`app/features/controller/controller-query.server.ts:48`)
  assembles conversations, transcript, `conversationTurnState`, and — on the project
  surface only — `listGoals`.
- `ControllerPage` (`controller-page.tsx:36`) renders the list, transcript, composer
  and the `GoalsPanel` (`:341`). `canRedirectGoals` is a *display* hint from the member
  role; the server re-checks per submit, so a creator below that tier still gets their
  own chain's controls honored. Task detail carries a goal chip linking back
  (`task-main-sections.tsx:193`).

---

## 3. Schedules — `run-operator` and `run-agent`

`app/server/tasks/schedule.server.ts`.

**There is no cron, no cadence, no recurrence.** Every entry is a **one-shot
occurrence** with an absolute `dueAt`; a fired occurrence is terminal, and there is no
"next run time" field. Canonical in `frontmatter.schedules`
(`task-file.schema.ts:607`), mirrored to `task_projections.schedules_json` so the
runner need not read every file.

`scheduleSchema` (`:305`) → `TaskSchedule`: `id` · **`action`** (not `kind`) from
`SCHEDULE_ACTION_TYPES = ["run-operator","run-agent"]` (`:289`) · `dueAt` · `profileId`
· `prompt` · `createdBy`/`createdByLabel`/`createdAt` · `status` from
`["pending","claimed","fired","failed","cancelled"]` (there is **no `enabled` flag** —
the on/off axis is `pending` vs `cancelled`) · `firedAt` · `claimedAt` · `retries`.
**No `backend`, no `autonomy`** — ruling R22 supersedes FR39's per-schedule pin
(`:311`); the entry pins nothing but identity and `.loose()` silently ignores those keys
in pre-ruling files. Parsed per row via `tolerantRows`, and again at read time by
`scheduleListSchema` (`schedule.server.ts:299`).

**Tick loop.** `startScheduleRunner` (`:788`) from `boot.server.ts:666`: a
`setInterval` at `SCHEDULE_TICK_MS = 60_000`, guarded by
`Symbol.for("viberr.scheduleRunner")` so an HMR reload cannot arm a second interval,
latched so a slow tick cannot stack, `unref`'d, and firing `fireDueSchedules` **once
immediately** as the missed-tick catch-up. `tasksWithUnresolvedSchedules` (`:280`) uses
`json_valid(...) AND EXISTS (SELECT … json_each …)` — B-WF5: it used to be a
`LIKE '%"status":"pending"%'` substring scan that depended on key order and that a
schedule *note* quoting the text could falsely satisfy.

**The claim protocol.** `pending → claimed` is written to the **file** under lock
*before* any run is enqueued and finalized to `fired` only after the enqueue returns; a
`claimed` row older than `CLAIM_LEASE_MS` is treated as crashed and re-driven.
`CLAIM_LEASE_MS = CLONE_TIMEOUT_MS + 5 * 60_000` (`:321`) is **derived**, so raising the
git-clone timeout cannot reintroduce the overlap. The drain re-stamps `claimedAt` as
each occurrence's own drive begins (`:567`), because with several due at once a later
one's *queue wait* alone could outlast the lease and the next tick would double-drive it.

**Dispatch.** `run-operator` (`:618`) calls `runOperator` with **only**
`{projectSlug, taskKey, trigger: "scheduled", dataRoot}` plus
`scheduleNote = prompt` — no backend, no autonomy, no human actor. The note reaches the
model through `scheduleContext` (`operator-run.server.ts:3289`): *"Honor that reason
first"* and *"A schedule firing is not new evidence by itself"*. B-WF3: it used to
arrive as a bare `manual` trigger, so the reason existed only in a timeline note the
turn never pointed at. `run-agent` (`:594`) calls `startAgentRun` under actor
`{ userId: "system", label: "schedule runner" }` with `operatorAuthorized: true`, and
the scheduler is the **dispatch-completion contract's triggerer** (§5). A `run-agent`
entry with a null `profileId` goes terminal `failed` — it used to fall through to the
**operator** arm under a claim note announcing an agent run.

**Baked into the run controls.** There is no scheduled-actions panel (removed in the
dispatch rework). `RUN_DELAYS = now | 5 | 60 | 360 | 1440` minutes
(`execution-profile.tsx:131`); `OperatorRunControl` (`:312`) and `AgentRunControl`
(`:456`) flip their label to **"Schedule"** and their icon to `clock` when a delay is
picked, and each renders its own `PendingSchedules` list (`:181`) with a cancel confirm
naming when the entry is due and who set it. `ExecutionProfile` splits at `:805` on
`s.action !== "run-agent"`. Route `project.task.tsx:983` / `:1038`, **RBAC
`run-agents`**, with `delayMinutes` clamped to 1 … 40 320 (28 days) and `prompt` to
4000 chars — a crafted `1e15` overflowed `Date` into a `RangeError` 500. The loader
shows only `status === "pending"`, so a `claimed` occurrence is invisible for up to the
lease duration.

**Guards.** Create-time refuses a past `dueAt`, a `run-agent` with an undeployed
profile, or a terminal-stage task. Fire-time mootness is decided **inside the file
lock** (`:453`): `projectFrozen || archived || stage === terminal`.
`projectArchivedFor` (`:350`) exists because the fire path runs under
`operatorAuthorized`, which skips `requireRunAgents` and with it the R6-3 archived
freeze — the same guard-short-circuit class as §6.2. F19-20 TOCTOU: `row.stage` is a
snapshot from the top of the tick, so the decision had to move into the locked claim.
Terminal refusal is three-layered (create → claim → `runOperator`'s own
`refused: "terminal-stage"`). A `run-agent` whose profile already has a live run is
left `pending` **silently**, spending no retry. `MAX_SCHEDULE_RETRIES = 3`; a 400
validation refusal goes terminal immediately rather than burning three strikes. Audit:
`task.schedule.created` / `.cancelled` / `.fired` (with
`outcome: claimed|skipped-done|skipped-archived`, plus a second row with
`refusedAtStart: true` when `runOperator` refuses after the claim note already said a
run was starting). A cancelled schedule leaves `firedAt` **null** (P11-75).

**Agents cannot schedule**: `CronCreate` / `CronDelete` / `CronList` /
`ScheduleWakeup` are denied builtins (`claude-runtime.server.ts:280`) — "scheduling is
viberr's job". Creation is human-only, through the route.

---

## 4. Insights and governance

One exported query: `getInsightsSummary(db, nowIso, filter?)` —
`app/server/insights/insights-query.server.ts:410`. `nowIso` is injected rather than
read from a clock so the window and the generated-at stamp are deterministic.
`WINDOW_DAYS = 30`, `TOP_N = 8`.

| group | fields | source | window |
| --- | --- | --- | --- |
| `InsightsTotals` (`:24`) | `runs`, `costedRuns`, `cost`, token counts, `turns` | `agent_runs` | all time |
| `outcomes` (`:90`) | the five run states + `successRate` | `agent_runs.state` | all time |
| `CountRow[]` ×4 (`:36`) | `byBackend`, `byKind`, `byProject`, `byModel` | `agent_runs` | all time, capped |
| `avgDurationMs` (`:105`) | `AVG(MAX(0, julianday diff × 86400000))` | finished runs | all time |
| `DailyPoint[]` (`:45`) | `{date, runs, cost}`, gap-filled to 30 points | `agent_runs` | 30 days |
| `OversightSummary` (`:63`) | see below | `task_projections`, `projects`, `audit_events` | **all time** |
| `backendQuota` (`:110`) | latest reading per backend | `instance_settings` | latest only |

`OversightSummary` (`oversightSummary:250`): **`clarity`** (of active tasks, how many
have `waiting !== "none"` or an owner) · **`traceability`** (of tasks with a delivery
footprint, how many have **both** branch and PR) · **`packetResolution`** (each
`*.packet_opened` paired with the task's next `task.packet.resolved`, plus a live
`openNow`) · **`timeToReview`** (created_at → the first `task.transition` whose
`details_json.to` is the project's `reviewId`) · **`longTimelines`**. Stage roles come
from `resolveStageRoles` — the same resolver every governed surface uses.

**The gate is one line**: `await requireRole(request, "admin")` —
`app/routes/insights.tsx:13`. That is the *instance* role, not project membership, and
the route passes **no filter**, so every row on the instance is aggregated regardless
of memberships; there is no membership join anywhere in the module. The home tile is
`aria-disabled` for members rather than clickable (`home-sections.tsx:435`) — a
member's click used to land on a 403.

**R15-4 does not reach insights.** `packetResolution.openNow` is an *instance-wide*
open-decision count; the member-scoped "waiting on me" counts are different metrics on
different surfaces (`home-query.server.ts:72`, `board-filters.ts:41`,
`notifications-page.tsx:56`). The one place `InsightsFilter` is used is the controller
tool `inspect_run_analytics` (`controller-toolkit.server.ts:736`), which calls
`requireOrgAdmin` **before** honoring `args.projectSlug`, so the filter can never
become a membership bypass.

### Honesty guarantees

1. **Cost is UNKNOWN, never zero.** Only the Claude result envelope carries a cost, so
   the group SQL (`:464`) and daily SQL (`:521`) deliberately omit `COALESCE`; NULL
   survives into `cost: number | null` and renders **"not reported"**
   (`insights-page.tsx:370`). `$0.00` on an all-Codex group is a claim the data cannot
   support.
2. **The headline discloses its own coverage** — `totals.costedRuns` exists only so it
   can say "N of M runs reported no cost" (`:84`).
3. **A NULL cost must not drop a busy group.** Cost-first ordering + `LIMIT 8` + SQLite
   sorting NULL last meant the busiest groups were the first dropped. The cap moved
   into JS with `floor(TOP_N/2)` slots reserved for the busiest-by-runs (`:445-486`).
4. **"Completion rate", not "Success rate"** (R26-3, `insights-page.tsx:98`) — it
   measures runs that ran to completion, not work accepted on review. F26-5 adds
   `running`/`queued` to the sub-label so counts reconcile with "Total runs".
5. **"Long timelines" must agree with the machinery it describes** — the *governance
   insights honesty* fix (commit `4e02c81`). It counted every task against a hard-coded
   40 while `compression-threshold` is a **per-project** guardrail that can also be
   switched off. `compressionThreshold` (`:227`) returns **null** when absent or off,
   and such a project contributes nothing (`:403`); the sub-label now reads "past
   *their project's* threshold".
6. **An unresolved or withdrawn packet contributes no duration** (`:311`) — honest, not
   a fabricated zero; still-open ones are reported separately as `openNow`.
7. **Excluded populations are disclosed**: "finished runs" on the duration card;
   negative durations clamped to 0 (F26-6) rather than `-600s`; `project_slug = ""`
   labelled `"controller (instance)"` rather than a blank bar (`:470`); a corrupt JSON
   row reads as its fallback rather than crashing an analytics loader.

**n/a de-emphasis** — `StatCard` (`:321`): *"an absent reading must not be the loudest
thing on the card; 'n/a' at full stat emphasis reads like a data point."*
**Null vs zero** — `clarity.pct`, `traceability.pct`, `successRate`, `avgDurationMs`
and the `avg`/`median` helpers all return **null** on an empty population. The one
deliberate real zero is the gap-filled daily point (`:538`): *"A real day keeps its
(possibly null) cost; a gap-filled quiet day is 0."* `totals.runs === 0`
short-circuits the whole dashboard to one empty state.

### Quota

`app/server/runtimes/backend-quota.server.ts` — not a probe, an **observation log**.
`rate_limit_event` envelopes are decoded at the one wire boundary
(`wire-format.server.ts:171`) with **nullable numbers on purpose**: *"a missing
utilization must read as 'not reported', never as a fabricated 0% that looks like a
fresh quota."* `recordBackendRateLimit` (`:55`) UPSERTs into `instance_settings` under
`backendRateLimit.<backend>` (latest wins, no history), called from exactly one place
(`run-sink.server.ts:353`) and **best-effort** — telemetry must never break the
run-line persist path. `latestBackendRateLimits` (`:82`) always returns a row per
backend with three tolerant fallbacks producing `reading: null`.

`BackendQuotaPanel` (`insights-page.tsx:219`) has **three honest states**: "no reading
yet" · "`<type>` · utilization not reported" (the provider's five-hour events often
omit it) · "`<pct>`% of `<type>`". A provider warning outranks the reset date — the
panel exists to warn *before* a run fails. `observedAt` rides in the `title` so a
weeks-old 91% is visibly stale, and both it and the reset date are hydration-gated
(SSR would bake the server's timezone in, and React never patches a text mismatch).
The family rule (R17-5, canonically `resources.health.ts:44`): **a never-checked thing
renders neutral, not alarming.**

Quota exhaustion still takes its **reactive** path independently: `RunFailureKind`
includes `"quota"`, `runFailureReason` matches
`/usage limit|quota|rate limit|too many requests|429/i` or the adapter's `error·quota`
tag, and the recovery packet offers `retry_other_backend`. Before pass 29 that failure
was the *only* quota signal.

---

## 5. Operator ↔ dispatch: the completion contract

Ruling 98's **dispatch-completion contract** has two halves: a dispatched run's report
must actually notify the human who dispatched it, and it must always hand back to the
operator.

**(a) cc-append — the guarantee half.** The prompt asks for the tags in the model's own
words (`specialist-run.server.ts:2553`), but guidance is not a guarantee. The pipeline
appends what is *missing*, **before the reply is stored**
(`task-actions.server.ts:3248`):

```ts
const hasHumanTag = input.dispatchedByUserId
  ? mentionNotifiesUser(db, replyText, input.dispatchedByUserId)
  : replyText.includes(`@${name}`);
const hasOperatorTag = /@operator\b/i.test(replyText);
if (missing.length > 0) replyText = `${replyText}\n\ncc ${missing.join(" ")}`;
```

"Already tagged?" is answered by the **same resolution ladder the fan-out delivers
with**, keyed on the dispatcher's user id — the old first-word substring check was
satisfied by `@Arda Other` when the dispatcher was `Arda Kaya`, so the guaranteed ping
vanished exactly when names collided.

Because the cc line varies with the *dispatch source* rather than with what the agent
said, **every agent-text-vs-agent-text comparison runs on the cc-stripped form**.
`stripCcLine` (`:1813`) drops any line matching `/^cc @/`, and it is applied on both
sides of the no-progress detector (`:3645`) and `duplicatedOwnCommentText` (`:1846`,
the F22-12 mid-run-repeat check). That helper returns the **matched text**, not a bool,
so a duplicate report can still fan out the tags it *adds* over the mid-run comment —
dropping the whole reply used to swallow the guaranteed ping.

**(b) always-react — the handback half.** `mustReact` (`:3656`) bypasses the react
heuristic for a manually/schedule-dispatched run:

```ts
const mustReact = !!input.dispatchedByName
  && finished.state === "finished"
  && currentDepth < OPERATOR_REACT_DEPTH_CAP;
```

The depth cap still binds — a runaway loop is a runaway loop whoever started it — and
only **this** hop is forced: runs the reacting operator then dispatches itself carry no
`dispatchedByName`, so the chain reverts to the heuristic one hop later. When neither
`shouldReact` nor `mustReact` holds, a verbatim repeat (`noProgress`) or a depth-capped
chain opens a stuck-loop packet, and `clearWaitingToHuman` **always** runs so the board
cannot read "agent working" forever with no agent running.

---

## 6. Gotchas

From code comments and `planning/discovery-2026-08-30-bug-sweep/RESOLVED.md`, whose own
conclusion is that the individual defects matter less than the classes.

### 6.1 Decide, await, then blind-write

A decision taken from a **pre-await snapshot** and committed with a wholesale key
assign. Confirmed instances:

- **The goal advance grew two tasks for one link** — the decision was made under the
  goal lock, but `createTask` ran after it was released and `link.taskKey` is the only
  durable record a start happened. Fixed by `startLinkTask`
  (`goal-actions.server.ts:534`), which serializes per link with an **in-process** lock
  (a field in the goal file would survive a crash mid-create and strand the link
  forever) and re-checks the chain status *again* under the goal-file lock at attach
  time (`:593`).
- **`createGoal` minted the same id twice** — the scan-based allocation released its
  lock before the file that reserves the id existed; the loser threw with its task
  already created and dispatched to an operator. Fixed by `withGoalsLock` spanning all
  three steps (`:157`).
- **The GitHub reconciler overwrote an acceptance that landed mid-pass** —
  unrecoverably, since only an acceptance writes `"accepted"` and the task is already
  Done.
- **The schedule drain measured its lease from the claim, not the drive.**

The fix shape is always the same: **re-check the decision inside the write lock, or
hold one lock across the whole sequence.** `operatorOpenPacket` (`:1038`),
`operatorResolvePacket` (`:1152`), `packetIdentity`'s three checkpoints, and
`reconcileGoal` all follow it.

### 6.2 A guard that short-circuits ahead of the chokepoint

The task-owner exception returned **before** `requireAction` — and with it before the
R6-3 archive freeze — so an owner could accept a completion (a real merge) and resolve
a decision packet on a read-only project. The goal-redirect **creator** arm had exactly
the same shape, which is why `requireGoalAuthority` (`goal-actions.server.ts:244`) now
calls `requireProjectMutable` explicitly in that arm; the `run-agents` arm gets it from
`requireAction` for free. The schedule fire path (§3) is the third instance, via
`operatorAuthorized`.

Sibling class: **a new caller reaching a branch documented as unreachable.** The
controller's `move_task` omitted `manual`, dropping an `auto` boundary to
`transitionStage`'s any-member arm whose own comment calls it unreachable from the UI —
a *viewer* could cross through the controller what they cannot cross on the board.
Fixed by always sending `manual: true` (`controller-toolkit.server.ts:1038`).

### 6.3 Goal-chain oscillation (attention → active → attention)

Round 1's un-park lifted `attention` on the mere **absence** of a failed link. But
`attention` is set for more than a failed link — losing the creator's `create-task`
parks a chain too. So a chain parked for *that* cause flipped
`attention → active → attention` on **every 60 s runner tick**, re-notifying the
creator and adding two history bullets each pass, forever. Fix
(`goal-actions.server.ts:667, 707, 731`): track `recoveredLink`, a link *this pass*
moved out of `failed`, and lift only the park whose cause the same pass watched
disappear — `if (recoveredLink && !anyFailedOpen && fm.status === "attention")`.
`paused` is a human's park and is never lifted here.

### 6.4 The controller 404 that rendered as a 500

`getControllerSurface` refused an unreadable conversation with an `AppError` from
inside two **loaders**, where only a thrown `Response` is understood by the root
boundary — so the deliberate 404 rendered as the generic "Something went wrong" page at
HTTP 500. Fix: `throw data("Conversation not found.", { status: 404 })`
(`controller-query.server.ts:79`).

### 6.5 Controller boot recovery cannot key on message order

`recoverControllerConversations` (`controller-run.server.ts:455`) has **two arms**,
because message order structurally cannot see the common case: a turn taken off the
FIFO always has the *previous* turn's reply sitting after its own user message, so "the
newest message is the user's" misses every queued turn a restart killed.

- Arm 1 (`:470`) drives off the **run** — a terminal `kind='controller'` run with no
  message carrying its id is exactly a turn whose `settleTurn` never ran. The note
  carries `runId`, which is what stops the next boot writing a second one.
- Arm 2 (`:505`) catches a message whose run never started at all, and reads **after**
  arm 1's notes have landed so a conversation arm 1 just answered cannot be noted twice.

Both skip a conversation whose lease is currently held.

### 6.6 Boot ordering around the operator sweep

The orphan sweep launched its operator re-invokes **detached**, and boot moved straight
on to the workspace reclaim — which `rmSync`s the very directories those drives were
cloning into. The sweep is now step 0 of `reconcileRestartedWork` and its re-invokes
are joined before the reclaim; the reclaim also asks the same active-run question the
periodic pass asks, because sequencing alone cannot establish its precondition (a
recovered completion *launches* a run and returns).

### 6.7 Whole-array tolerant parsing

One malformed row emptied an entire list, and because the diagnostic is only a warning
the file stayed writable, so the **next** write persisted the loss. Task `engagements`
(the delivery contract: the `delivers` owner and every required reviewer) and project
`guardrails` were the two lists F18 left on the whole-array path; the PR #248 review
found the siblings — `verdicts`, `schedules`, `recommendations`, `labels` now parse per
row.

### 6.8 Display re-deriving what the runtime decides

`capabilities.delivery` in `listDeployedSpecialists` advertised delivery from a scoped
grant alone, ignoring the headline gate the runtime enforces — so the operator's own
selection payload could name a deliverer that cannot deliver. Same class: the resource
delete-confirm counted grants from the specialist CRUD list while the delete rewrites
*every* profile file (including the controller's), and the notification surfaces
re-derived navigability instead of using the `href` the server had already resolved.

### 6.9 Stale names — do not code against them

**`AcceptDisclosure` does not exist** anywhere in the tree. The pass-19 class of that
name was lost in a two-session merge (`app/shared/acceptance-disclosure.ts:11`); the
shipped contract is `AcceptanceDisclosure` (§1.12), a form-field echo, not a thrown
error. The comment at `decision-packet.tsx:131` naming an `AcceptDisclosureProvider`
React context is stale — that context never shipped. So is
`DESIGN.md:112`'s `advanceGoalForTask`: the hook is `maybeReconcileGoalForTask` and the
engine is `reconcileGoal`. `file-formats.md:230`'s example still shows an `accept: true`
option marker that `packetOptionSchema` does not have — acceptance is gated solely on
`kind === "accept_completion"`.

### 6.10 Smaller sharp edges

- **`denied` vs `noop`** — a state conflict returned as `denied` tells the human the
  project's policy blocked work it never blocked, and writes a `policy` event the
  activity feed reads as a governance signal (`operator-actions.server.ts:161`).
- **A scheduled trigger in the newest-wins slot** — any later machine trigger overwrote
  it *and its note*, while the runner had already stamped the occurrence `fired`: a run
  FR39 promised, recorded everywhere as delivered, that never happened (`:398`).
- **`stageAtStart: null` is not "not applicable"** — the stranded backstop is off for
  that whole drive because a file read failed. It now says so (`:690`, B6). Likewise
  `runOperator` returning `null` rather than the literal `"queued"` callers were passing
  into run lookups (B10).
- **Two writers after a delivery** — exactly one runs: the R18-2 re-queue (full
  autonomy, newly opened PR) **or** the server-recorded "Move to review" card
  (operator-authorized supervised delivery). A human manual delivery gets neither
  (`task-actions.server.ts:5021-5060`).
- **Archiving a *completed* task must not retroactively fail its link** — the engine
  treats `done` as settled and never revisits it, so the projection would write a state
  the file can never agree with, and the panel would offer Retry/Skip the server then
  refuses (`rebuilder.server.ts:825`).
- **`retry_link` un-parked before creating the task** — it committed the un-park and the
  "retried" history *before* attempting the fresh task, leaving the chain active with a
  still-failed link until the next tick flapped it back. It now re-parks to `attention`
  in the catch (`goal-actions.server.ts:412`).
- **A goal description could forge its own history** — an unescaped `## Timeline` line
  closed the section and turned the rest into fake bullets (`goal-writer.server.ts:41`).
  The same file also silently destroyed unknown frontmatter keys on the first reconcile
  write, unlike the task and project writers.
- **Every reconcile rewrote the goal file**, so the 60 s runner churned each live goal
  forever (re-project + SSE fan-out to every open client). `updateGoalFile` now compares
  bytes with the old `updatedAt` in place and writes nothing on a no-op.
