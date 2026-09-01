# 03 — OPERATOR and CONTROLLER

*Pass 32, re-verified against main @ `68b5480e` (2026-09-01). Every path:line below was
resolved against the current tree; the pass-31 copy
(`planning/discovery-2026-08-31-pass31/docs/03-operator-controller.md`) predates PRs
#253, #254, #257, #258/#259, #260, #261, #262–#264 and its line numbers are stale.*

Two coordination agents sit above the specialists that do the work.

- **Operator** — coordinates **one task**. Deployed per project, holds a capability
  policy, woken by events on that task.
- **Controller** (ruling 99) — coordinates **the instance**. Exactly one per
  deployment, conversational, holds *no authority of its own*: every tool call runs
  under the asking human's live permissions.

The controller sits *above* operators and never replaces them — it briefs, triggers
and steers them, and each chained-goal task gets its own operator.

Sources: `docs/architecture/decisions.md:1334-1422` (ruling 99), `:1423` (100),
`:1433` (101), `:1469` (104), `:1519` (106), `:1552` (107), `:1606` (108);
`planning/discovery-2026-08-30-controller/DESIGN.md`;
`planning/discovery-2026-08-30-bug-sweep/RESOLVED.md`.

**What changed in this domain since pass 31** (detail in the sections that follow):
one-nudge stranded resume with a durable `heldAtStage` marker; an **eleventh** packet
kind `resolve_remote_collision` plus an authoring-coherence guard on `discard_branch`;
`orgResources` and `unownedPr` in the operator snapshot; per-recipient T13 notification
dedupe; a typed `StuckLoopEscalation`; **operator narration is stored verbatim** and the
`operator-brevity` guardrail is gone (ruling 104); the controller's refusal machinery
extracted to `controller-tool-guards.server.ts`; a **second, built-in controller MCP**
`viberr_ops` (ruling 107); **deployment locks** on the controller's grant/instruction
sections (ruling 108); the operator is **read-only on Codex** again (ruling 101); and a
coordination-overhead insight that counts operator **and** controller spend.

---

## 1. The operator

### 1.1 Authority

`resolveOperatorAuthority(ctx, projectSlug, overrides)` —
`app/server/tasks/operator-actions.server.ts:362`. Reads the project's `agents:`
deployment whose profile `kind === "operator"`, returns `OperatorAuthority` (`:110`):
`policy` (capabilityId → `direct|recommend|human|off`), `autonomy`,
`configuredAutonomy`, `autonomyClampedFrom`, `backend`/`model`/`effort`, `name`,
`skills`/`kb`/`mcps`/`persona`, `deployed`, `humanGatedBeforeWork` (derived from the
workflow graph, not a stored preset).

**R19-A ceiling.** `clampAutonomy(requested, ceiling)` (`:236`) — a run may sit at or
below the deployment's configured autonomy, never above. A clamp that *bites* writes
`AUTONOMY_CLAMPED_AUDIT_ACTION = "task.operator.autonomy_clamped"` (`:206`) via
`auditAutonomyClamp` (`:258`), and **only** when the caller passed a `db`: loader paths
resolve authority as a pure read, and a read must not write audit rows
(`runOperator` supplies `db` deliberately — `operator-run.server.ts:1273`).

**Absent-grant polarity is now centralized (F31-C2).** `absentPolarityGate` (`:466`)
lives *inside* `gate()` (`:493`), so every consumer resolves the four
absent-means-derived capabilities identically instead of only the callers that knew to
reach for a dedicated gate:

| capability | absent resolves to | `absentPolarityGate` line |
| --- | --- | --- |
| `deliver-review-pr` | `absentDeliverReviewPrMode(humanGatedBeforeWork)` (R15-9) | `:472` |
| `dispatch-agents` | `direct` (ruling 98(b) — pre-rework deployments store only the retired assign/summon ids) | `:476` |
| `update-task-branch` | whatever `deliverGate` resolves to (delivery's sibling) | `:480` |
| `use-web-search-fetch` | `direct` (catalog default; only an explicit off/human withholds) | `:484` |

The three named gates survive as documented fronts:

| gate | line | rule |
| --- | --- | --- |
| `gate(authority, id)` | `:493` | not deployed → deny (A4, first line); absent → `absentPolarityGate`; `direct`→direct; `recommend`→direct **only** under full autonomy, *except* `completion-for-acceptance` (owner ruling Q1); `human`/`off`→deny |
| `deliverGate` | `:529` | `deliver-review-pr`. Explicit stored mode → `gate`; absent → the governance-derived mode. Undeployed still denies — before A4 an undeployed operator could push a branch and open a PR |
| `dispatchGate` | `:575` | now a one-line front over `gate(authority, "dispatch-agents")` |
| `updateBranchGate` | `app/server/github/update-branch-operator.server.ts:75` | `update-task-branch`, delivery-derived when absent |

### 1.2 What wakes it — the triggers

`RunOperatorInput.trigger` (`app/server/runtimes/operator-run.server.ts:160`) is a
closed union of nine values and decides the turn doctrine:

| trigger | posture | fired from |
| --- | --- | --- |
| `create` | COORDINATE | `createTask` (`task-actions.server.ts:557`) |
| `transition` | COORDINATE | every stage move (`:4652`) + the stranded backstop (`operator-run.server.ts:903`) |
| `goal-updated` | re-scope | `updateTaskGoal` (`:639`) |
| `agent-reply` | REACT | the specialist completion pipeline (`:3855`) |
| `pr-diverged` | RECOVER | `github-reconciler.server.ts:834` (typed wake `OperatorWake`, `:87`) |
| `delivered` | PROCEED | a full-autonomy delivery that opened a NEW PR (`:5200`) |
| `packet-resolved` | PROCEED | `resolvePacket` when no asking agent absorbed it (`:6615`) |
| `scheduled` | RE-CHECK | the schedule runner (`schedule.server.ts:631`) |
| `manual` | COORDINATE | Run-operator button + `@operator` comment (`task-actions.server.ts:1430` and the task route), boot recovery (`run-recovery.server.ts:170`), stranded Codex-plan recovery (`operator-run.server.ts:2055`), the controller (`controller-toolkit.server.ts:1086`) |

`autoInvokeOperator` (`task-actions.server.ts:868`) is the shared fire-and-forget seam:
dynamic-imported to avoid a module cycle, a no-op when no operator is deployed (`:894`),
and — after C1 (pass 23) — it writes an honest timeline note if the handoff *throws*
before a run row exists (`:925`), because a throw used to stop coordination in silence.
Its `trigger` parameter is narrowed to six values (`:874-880`); `manual`, `scheduled`
and `agent-reply` are passed straight to `runOperator` by their own callers.

### 1.3 Fire-time refusals

`runOperator` (`:1259`) returns `{ runId: null, queued: false, refused }` for two cases:

- **`"terminal-stage"`** (`:1295`) — FR39/F19-20. A `scheduled` re-run never fires on a
  terminal stage, checked **where the run starts**, not only where the occurrence was
  claimed (the drain is sequential and a queued trigger has no mootness re-check).
  Calls `settleWaitingAfterOperator` (`:1315`) so the refusal cannot strand
  `waiting: agent`.
- **`"open-packet"`** (`:1338`) — R20-1/F20-5. A **human-pressed** Run operator while a
  packet is open is a paid no-op (live: 6 turns, $0.27, only `get_task`). Scoped to
  `manual`: `pr-diverged` legitimately withdraws a moot packet, `agent-reply` reacts to
  a run already in flight.

### 1.4 Single-flight lease and the trigger queue

One drive per task, on `Symbol.for("viberr.operatorLease")` (`:346`) so an HMR reload
keeps it. Held from `runOperator` entry through provider completion **and**, on Codex,
through structured-plan execution — the `agent_runs` row alone under-covers both
(`:318-341`). The lease entry (`OperatorLeaseEntry`, `:295`) carries `runId`, `backend`,
`autonomy`, the task ref, `transitionDepth`, `stageAtStart` and — new this pass —
`strandedResume` (`:315`).

`queueOperatorTrigger` (`:399`) coalesces **per kind**:

- machine triggers → `PendingTriggers.latest`, newest-wins (the operator re-reads the
  whole task anyway);
- **reason-carrying** triggers → `carried`, an ordered FIFO capped at
  `MAX_PENDING_CARRIED_TRIGGERS = 8` (`:386`), drained oldest-first *ahead* of the
  machine slot. Two qualify: a human `@operator …` comment, and a `scheduled` re-check
  (its note is the reason the run exists, and the runner already stamped the occurrence
  `fired`). Consecutive comments from the **same author** merge into one turn (`:415`).
- **V13 (pass 31): two accounting fields survive a newest-wins overwrite** (`:436-453`).
  `strandedResume` is carried forward (`:446`) — losing it un-marks the eventual drive,
  so a second stranding would re-arm a nudge instead of recording the hold — and the
  deeper `transitionDepth` wins (`:450`), or the chain cap resets mid-chain.
- Anything pushed off the back gets `noteDroppedOperatorTurn` (`:467`) with kind-aware
  copy — never a bare `logger.warn`.

Cross-boot: `inFlightOperatorRun` (`:260`) flags a `restartOrphan` (row created before
`PROCESS_START_MS`, `:257`). Such a row has no completion callback behind it, so
`runOperator` finalizes it and drives now rather than chaining onto a dead callback (B10).

### 1.5 Loop caps, the stranded backstop, and the one-nudge hold

| cap | value | where |
| --- | --- | --- |
| `OPERATOR_REACT_DEPTH_CAP` | 4 | `task-actions.server.ts:175` |
| `OPERATOR_TRANSITION_CHAIN_CAP` | 8 | `task-actions.server.ts:188` |
| `RECOVERY_REINVOKE_CAP` | 3 / 30 min | `run-recovery.server.ts:19` |

`nextTransitionChainDepth` (`:192`) restarts at 0 for a human move, increments for an
operator move; the cap opens a stuck-loop packet instead of looping.

`maybeResumeStrandedOperator` (`operator-run.server.ts:695`) is the settle-time backstop
for `operatorLeftTaskStranded` (`:672`) — not archived, no packet, no pending
recommendation, current stage has an outbound `auto` boundary. It refuses to fire in six
situations, in order:

1. `stageAtStart === undefined` (`:711`) — a key-derived fallback ref may not judge a
   drive it cannot see the start of.
2. `stageAtStart === null` (`:717`) — a **failed file read**, not "not applicable"; it
   now says so loudly (B6).
3. no `runId` (`:733`) — a ref that cannot name its own drive does not get to judge it.
4. the run is not `finished` (`:747`).
5. the drive **moved the stage** (`:762`) — the transition's own re-trigger owns the
   follow-up.
6. **a durable hold already stands** (`:778-787`, V18): `frontmatter.heldAtStage ===
   frontmatter.stage`.

**F31-11 — one nudge per settle** (`:790-830`). A drive that *was itself* the stranded
resume (`ref.strandedResume`) and still ends stranded is a **deliberate hold**: the
settle stamps `frontmatter.heldAtStage = frontmatter.stage`, appends one
`policy-engine` note ("this stage auto-advances, but the operator held it twice in a
row…"), reprojects and stops. Before this, a goal that directed holding an `auto` stage
looped paid drives to the chain cap and every later trigger re-armed a fresh burst
(measured: fourteen drives on one no-op task).

The marker is durable in `task.md` and is cleared by every human re-litigation:
`createTask` seeds it null (`task-actions.server.ts:502`), `updateTaskGoal` clears it
(`:590`), `transitionStage` clears it (`:4548`), `resolvePacket` clears it (`:6522`) and
`applyAcceptanceWrite` clears it (`:7882`). The turn instruction reads
`strandedResume` too (`operator-run.server.ts:3414`) and tells the nudged drive to
either advance or **record** the hold with a packet.

Beyond the hold, the chain cap still bites at `depth >= OPERATOR_TRANSITION_CHAIN_CAP`
(`:836`, B4 — the same `>=` the transition side uses) and leaves a note.

`settleWaitingAfterOperator` (`:921`) is the fire-and-forget wrapper: no live run →
`maybeResumeStrandedOperator` → else `clearWaitingToHuman`.

### 1.6 The turn instruction

`operatorTurnDoctrine(snapshot, trigger, humanComment, humanCommentBy, transition,
scheduleNote, resolvedOption, strandedResume)` (`:3261`) → the trigger-specific
doctrine; `operatorTurnInstruction` (`:3451`) appends
`CAPABILITY_GAP_REMEDY_INSTRUCTION` (`:3184`). `buildOperatorTurnPrompt` (`:3493`) for
Claude, `buildCodexOperatorPrompt` (`:3458`) for Codex.

`CAPABILITY_GAP_REMEDY_INSTRUCTION` now carries **two** rules: ruling 85 (a packet must
name the grantable capability, not only workarounds) and **F31-3** (`:3193-3197`) — a
resource named in `orgResources` but under no `deployedSpecialists[].resources` is
*"exists, not granted here"*, never *"does not exist"*; only a name absent from
`orgResources` too may be described as non-existent.

Notable arms: `pr-diverged` force-feeds `driftInstruction(snapshot)` (`:3244`) so a
recovery packet cannot omit unreviewed commits (F21-17); `triageQualityGate` (`:3208`)
fires only at the entry stage; `scheduleContext` (`:3398`) carries the human's note
("Honor that reason first" / "A schedule firing is not new evidence by itself");
`resumeContext` (`:3414`) is the one-nudge disclosure. The default arm states that
**`liveRuns` is the only proof a run is in flight** — `waiting` is a display flag and a
directive comment is not a running agent (`:3432`). The delivery bullet (`:3435`) now
teaches `resolve_remote_collision` on a `push_conflict` and forbids offering
`discard_branch` for that shape.

### 1.7 The snapshot — `get_task`

`operatorSnapshot` (`operator-actions.server.ts:1684`) → `OperatorTaskSnapshot`
(`:1323`). Each of these fields closed a live blindness:

- `previousStage` (`:1341`) — durable `previousStageId`; "arrived back from Review"
  reads as rework for the same builder.
- `validation` (`:1347`) — `deriveValidation(fm)`, the derived review outcome (F27-O5).
- `reworkStages` (`:1373`) — R7-4. The forward-only graph never lists earlier stages, so
  an operator reading only `nextStages` concluded it could not send failed work back.
  Non-empty only while validation is `failing`.
- `pr.revisionDrift` (`:1443`) — the same fact the acceptance ceremony discloses (R17-1).
- **`unownedPr` (`:1475`, set at `:1852`)** — NEW (pass 31 V19). The R15-15 branch-name
  collision the reconciler recorded as `github.unownedPr`. Without it the operator was
  structurally blind at the exact moment it must author a `resolve_remote_collision`
  packet, and had to guess the PR number from timeline prose.
- `noChanges` (`:1490`) — `noChangeApplies(fm)` (`no-change-completion.server.ts:69`), R19-8.
- `liveRuns` (`:1499`) — queued/running rows.
- `recommendations.pending` + `.declined` (`:1409`); the latter reads
  `task.recommendation.dismissed` audit rows (`declinedRecommendations`, `:1587`),
  bounded to `MAX_SNAPSHOT_RECOMMENDATIONS = 5` (`:1547`) with labels capped at
  `RECOMMENDATION_LABEL_CAP = 160` (`:1549`).
- `operatorPolicy` (`:1521`, built at `:1874`) — labelled `scope: "operator"` and
  carrying `OPERATOR_POLICY_SCOPE_NOTE` (`:1638`), because a live operator read
  `use-web-search-fetch: off` out of an unlabelled map and filed a packet claiming a
  *specialist's* web grant had failed (F21-16).
- **`orgResources` (`:1540`, built at `:1883-1887`)** — NEW (F31-3). The instance
  catalog **names only** for KBs, skills and MCP servers, read through
  `listKnowledgeBaseNames` / `listSkillNames` / `listMcpServerNames`
  (`~/server/org/resources.server`, imported at `:100-102`). V12 made these
  **names-only** readers deliberately: `get_task` must not tree-scan resource folders or
  read `SKILL.md` bodies.

### 1.8 Tools

Claude gets an in-process SDK MCP server named `viberr`
(`app/server/tasks/operator-toolkit.server.ts:661`), with
`OPERATOR_TOOLKIT_INSTRUCTIONS` at `:160`. **A withheld capability means the tool is not
built** — the model cannot reach it.

| tool | line | built when |
| --- | --- | --- |
| `get_task` | `:261` | always |
| `read_default_branch_file` | `:289` | only with a repo checkout (`deps.workspace`, `:285`) |
| `post_comment` | `:343` | `gate("append-typed-events") !== deny` (`:340`) |
| `set_goal` | `:355` | same gate |
| `flag_context_conflict` | `:373` | same gate |
| `open_decision_packet` | `:412` | `gate("generate-packets") !== deny` (`:409`) |
| `resolve_decision_packet` | `:513` | same gate |
| `run_agent` | `:540` | `dispatchGate !== deny` (`:537`) |
| `deliver_for_review` | `:584` | `deliverGate !== deny` (`:581`) |
| `update_branch_from_base` | `:610` | `updateBranchGate !== deny` (`:607`) |
| `transition_stage` | `:625` | `gate("stage-transitions") !== deny` (`:622`) |
| `accept_completion` | `:650` | `gate("completion-for-acceptance") !== deny` (`:647`) |

Ruling 104 lives in the `post_comment` description: *"Post a concise operator comment …
Keep it short."* (`:344`) — brevity is now **guidance only**; nothing truncates the
record (§1.9).

`open_decision_packet`'s `kind` enum description (`:436-439`) teaches
`resolve_remote_collision` at the point of use and forbids `discard_branch` for a
collision. Both authoring paths write through `operatorOpenPacketDisclosed` (`:226`),
which appends the R20-9 delegated-ask disclosure from the run's `consultedProfileIds`
ledger (`noteConsultedProfile`, `:192`).

Codex emits a **structured plan** against `OPERATOR_PLAN_TOOLS`
(`operator-run.server.ts:1535`, **ten** verbs — the same set minus the reads), narrowed
by `operatorPlanToolsFor(authority)` (`:1600`) through the identical gates
(`OPERATOR_PLAN_TOOL_CAPABILITIES`, `:1576`). An operator with nothing granted falls
back to the full list **except** `deliver_for_review` and `update_branch_from_base`
(`:1636`), the two plan actions with effects outside Viberr. The plan's
`packetOptions[].kind` enum is `[...PACKET_OPTION_KINDS]` (`:1678`) and the runtime
mirror re-validates it (`:1735`), so the Codex leg can author all eleven kinds; the
executor's `open_packet` arm routes through the same disclosed writer (`:2211`).

Both backends deny filesystem writes and shell: `operatorDisallowedTools` (`:1249`)
re-exports `OPERATOR_READ_ONLY_DENIED_TOOLS` from `claude-runtime.server` (`:1246`) and
adds `WebFetch`/`WebSearch` when `operatorWebWithheld` (`:2710`). **Ruling 101 restored
the Codex half**: `resolveCodexSandboxMode` (`codex-runtime.server.ts:377`) returns
`"read-only"` for `spec.kind === "operator"` on its first line (`:380`) — the operator
"is coordination machinery, not an agent with a write assignment". The read half is the
read-only checkout `ensureOperatorRepoCheckout` (`:1151`) provisions under the run's cwd
(R19-1), described by `workspaceSection` (`:2831`) inside
`buildOperatorSystemPrompt` (`:2918`).

### 1.9 The governed actions

Every action returns `OperatorActionResult` (`operator-actions.server.ts:165`) with
`outcome: done | recommended | denied | noop` and an optional `notifiedUserIds`
(`:181`, new this pass — who the action's own watcher notification actually reached,
so a caller owing a fallback notice can dedupe per recipient; see T13 in §5).
**The `denied`/`noop` split is load-bearing**: `narrateRefusedActions`
(`operator-run.server.ts:2394`) files a refused plan step under "refused by its
capability policy" vs "did not apply to the task's current state" purely on this field,
and emits a `policy` timeline event only for the authority bucket (LV-03).

| function | line | capability | audit row |
| --- | --- | --- | --- |
| `operatorPostComment` | `:1894` | `append-typed-events` | `task.operator.commented` / `task.comment.dropped` (via `writeOperatorComment`) |
| `operatorFlagContextConflict` | `:1938` | `append-typed-events` | `task.operator.context_conflict` (`:1971`) |
| `operatorSetGoal` | `:2001` | `append-typed-events` | `task.goal.updated` (`:2061`) |
| `operatorOpenPacket` | `:987` | `generate-packets` | `task.operator.packet_opened` (`:1154`) |
| `operatorResolvePacket` | `:1195` | `generate-packets` | `task.operator.packet_withdrawn` (`:1266`) |
| `operatorDispatchAgent` | `:2233` | `dispatch-agents` (`dispatchGate`) | `task.operator.agent_selected` (`:2170`) + `startAgentRun`'s own |
| `operatorDeliverForReview` | `:2405` | `deliver-review-pr` (`deliverGate`) | `github.delivery.operator` (`:2464`) |
| `operatorUpdateBranchFromBase` | `github/update-branch-operator.server.ts:158` | `update-task-branch` (`updateBranchGate`) | `github.branch_update.operator` (`:207`) |
| `operatorTransitionStage` | `:2503` | `stage-transitions` | via `transitionStage` (`task.transition`) |
| `operatorAcceptCompletion` | `:2692` | `completion-for-acceptance` | `task.operator.recommended_completion` (`:2791`) / `task.operator.accepted_completion` (`:2862`) |

**Comment guardrails — FOUR now, not five (ruling 104).** `writeOperatorComment`
(`:623`) enforces meaningful-comment, evidence-separation, no-duplicate-summary
(compared against the last operator comment *inside* the write lock, `:678-686`) and
compression-threshold at the **configured** value (`:687-707`).
`enforceOperatorBrevity` and `OPERATOR_BREVITY_MAX_CHARS` were deleted:
`comment-guardrails.server.ts:21-26` states the rule — *"There is deliberately NO length
cap on operator narration (owner ruling 2026-08-31)"* — and `CommentTrim` narrows to the
single value `"evidence-separation"` (`:71`). `DEFAULT_GUARDRAILS`
(`app/shared/workflow/templates.ts:93`) carries four rows and `:88` records why there is
no fifth. A drop records `COMMENT_DROPPED_AUDIT_ACTION = "task.comment.dropped"`
(`comment-guardrails.server.ts:151`) through `recordCommentDrop` (`:755`) and the
function returns a `CommentGuardrailResult`, so the model is never told "Comment posted"
for a comment nobody will see (`commentOutcomeMessage`, `:130`).

Two ruling-104 follow-throughs matter:

- **B-FD8b — the @mention fan-out scans the PRE-trim text.** `notifyMentionedUsers` is
  called with the caller's original `text` (`:715`), not the stored post-trim form, so a
  handle inside a fenced block that evidence-separation cut away still notifies.
- **The fence balance moved.** `withAmbiguityDisclosure`
  (`mention-notify.server.ts:195`) now closes an unbalanced ``` fence before appending
  the S5-G3 note (`:205-206`) — *"This was done by the operator-brevity truncation until
  ruling 104 removed it; the append site is the one place a tail is added to author
  text, so it owns the check."*

**Recommendations.** `addRecommendation` (`:779`) writes an Apply/Dismiss card, sets
`waiting = "human"`, notifies supervisors on a **new** card only, fans out `@mentions`
(NEW-4). Dedupe is per `(kind, profileId, toStageId)`, but a **changed**
`prompt`/`delivers`/`label` replaces the pending card in place and counts as new.

**Dispatch.** `operatorDispatchAgent` (`:2233`) replaced engage/run/prompt.
`resolveDeliversIntent` (`:2197`) is the shared posture rule: explicit hint wins → an
engaged profile keeps its shape → an unengaged profile delivers iff the task has no
deliverer *and* the profile holds repo-write. Two contradictory hints are refused as
`noop`. Every selection writes `task.operator.agent_selected` listing each candidate
with `eligibleForStage`/`alreadyEngaged`/`chosen` (`recordAgentSelectionTrace`, `:2149`).

**Transitions.** `operatorTransitionStage` (`:2503`) crosses an `auto` boundary directly
even when supervised, and performs a **rework** move directly when `isReworkMove`
(`:2606`) holds — backward + `validation === "failing"`. F19-26: a supervised
`transition_stage(<terminal>)` is **rerouted** to `operatorAcceptCompletion`; R19-6 made
that reroute answer to the acceptance capability rather than `stage-transitions`.

**Acceptance.** `operatorAcceptCompletion` (`:2692`) reads
`completionCapabilityRefusal` (`:2666`) **first, before any read, card or audit row**
(`:2705-2708`, R19-6). It resolves the terminal stage through `resolveStageRoles`
(`:2718`, B-WF4), returns `noop` when already Done, then runs `acceptanceNoChangeCheck`
*before* the shared `acceptanceRefusalFor` gate (`:2742-2754`, F28-L1) so a
verified-empty completion is not refused "no review pull request". Full autonomy +
`completion-for-acceptance: direct` writes through `applyAcceptanceWrite`
(`task-actions.server.ts:7769`); anything else files an `accept_completion` card. The
operator **cannot merge** (a merge needs a user identity), so it records the PR as
`accepted` (merge pending).

### 1.10 Decision packets — the ELEVEN kinds

`PACKET_OPTION_KINDS` — `app/schemas/task-file.schema.ts:129-165`, mirrored (and
drift-tested by `app/shared/docs/file-formats-sync.test.ts`) in
`docs/architecture/file-formats.md`. `resolvePacket` is
`task-actions.server.ts:5943`; the dispatch switch opens at `:6060`.

| kind | schema | meaning | what resolution does |
| --- | --- | --- | --- |
| `accept_completion` | `:130` | Accept the work into Done and merge the PR | Arm `:6061`. `requireAcceptCompletion` → disclosure (`:6078`) → live no-change probe (`:6095`) → `acceptanceRefusalReason` → `acceptancePrHeadCheck` (`:6118`) → `attemptAcceptanceMerge` with a `beforeMerge` re-check of `packetIdentity` **and** the full refusal stack (`:6152-6175`, P14-GV-05/B-WF1) → locked write to the terminal stage. Not re-queued |
| `request_edit` | `:131` | Send back to the agent | `default:` arm `:6462`. `waiting: agent`, `readiness: ready`, packet cleared, re-queued; in `sentBackToAgent` (`:6588`) so an Agent question routes to `askedBy` first |
| `block_on_policy` | `:132` | "I fixed the policy/credential — unblock and re-run" | `:6266`. R20-1 turned this from a hold into a real unblock: `readiness: ready`, `waiting: agent`, re-queued. Never touches `validation` (B-WF2) |
| `hold_runtime_debug` | `:133` | Freeze coordination while I inspect the session | `:6303`. `readiness: blocked`, `waiting: human`, packet cleared (so the board's Blocked filter still lists it), **not** re-queued |
| `redirect` | `:134` | Re-engage with corrected guidance | `default:` arm, same as `request_edit` |
| `retry_other_backend` | `:137` | Re-run the failed agent on the other backend | `:6349` + `:6902`. `startAgentRun` with `backendOverride` under `operatorAuthorized`. The switch **sticks** via the engagement's `pinnedBackend` (F27-B1). A failed start never un-resolves the packet — it appends a `blocked` note (`:6918`) |
| `edit_goal` | `:141` | A human refines the goal | `:6328`. **The only kind that keeps its packet open**: stamps `packet.awaiting = "goal_edit"` (`:6525`), `waiting: human`. Cleared by `updateTaskGoal` (`:567`) or `operatorSetGoal`. A second confirm 409s (`:6023`) |
| `archive_task` | `:147` | Archive as the disposition; `deleteBranch: true` also deletes the remote branch | `:6374` + `:6637`. Re-checks `approve-transition` in the arm (`:6382`); `setTaskArchived` (`:5802`); `deleteTaskRemoteBranch`; F20-24 then discards the **local** branch too unless the remote deletion was `refused` (`:6707`). **The product's only remote-branch deletion path** (ruling 17) |
| `discard_branch` | `:154` | Delete the LOCAL, never-pushed workspace branch | `:6406` + `:6748`. Cleanup, not a disposition. Re-checks `approve-transition`. `on_remote` refuses and points at the archive option (`:6788`). `fm.branch = null` only on `deleted` |
| **`resolve_remote_collision`** | `:164` | **NEW (F31-6).** An unrelated remote branch (usually with an unowned PR) squats on this task's branch name, so the delivery push conflicts | `:6438` + `:6841`. Re-checks `approve-transition` (`:6443`). After the resolution write: `resolveRemoteBranchCollision` closes the recorded unowned PR and deletes the stale remote ref (best-effort), then `manualDeliverForReview` re-delivers (`:6865`). **V11**: a successful re-delivery lifts `readiness: blocked → ready` (`:6893`), because nothing in the delivery path writes readiness and the push-conflict packet held it down. Every degradation lands as one plain-words timeline note. Not re-queued |
| `custom` | `:165` | Free-form | `default:` arm. Also **synthetic**: a non-empty `input.custom` (≤4000 chars) ignores `optionIndex` and builds one at `:5990` |

Header fields (`taskPacketSchema`, `:510`): `id` (F10-09, `newId("pkt")`) · `type`
(`input | blocked`; `blocked` sets `readiness = "blocked"` on open and deliberately does
**not** touch `validation` — F7-VAL1, `operator-actions.server.ts:1136-1145`) · `kind`
(free text, but the literal is extracted: `AGENT_QUESTION_PACKET_KIND = "Agent question"`,
`agent-outcome.server.ts:435`, load-bearing at `task-actions.server.ts:6595`) · `from`
(an actor-ref codec string, not a display name) · `title` · `body` · `observations` ·
`options` · `awaiting` (only value `"goal_edit"`) · `askedBy` (R15-14, the agent
profileId whose session resumes on resolution, stamped at `agent-outcome.server.ts:475`).

`packetOptionSchema` (`:487`) carries `kind`/`t`/`d`/`rec` plus the optional
`ev`/`backend`/`profileId`/`deleteBranch`. **C5 (pass 31)**: options parse **per row** —
one malformed option drops with a diagnostic instead of voiding the whole open decision
(the old whole-packet-null arm was the durable-loss shape).

### 1.11 Who opens a packet

**One packet at a time per task.** Every writer refuses on the pre-read *and* again
inside the locked write (B3).

| opener | file:line | trigger | kinds offered |
| --- | --- | --- | --- |
| `operatorOpenPacket` | `operator-actions.server.ts:987` | the operator's own decision | any of the eleven |
| `open_decision_packet` tool | `operator-toolkit.server.ts:412` | Claude model call, via `operatorOpenPacketDisclosed` (`:226`) | any |
| Codex plan `open_packet` | `operator-run.server.ts:2198` | plan step, also via the disclosed writer (`:2211`) | `authoredPacketOptions` (`:1770`) else `defaultPacketOptions` (`:1810`) |
| `openAgentQuestionPacket` | `agent-toolkit.server.ts:187` | agent `ask_human`, gated by the `ask-human` grant (call site `:325`) | `custom` only, via `buildAgentQuestionPacket` (`agent-outcome.server.ts:440`) |
| Codex outcome envelope | `task-actions.server.ts:2923` | agent question in the envelope | `custom` only; a held question becomes a `note` when a packet is open (P13-RT-06) |
| `openStuckLoopPacket` | `task-actions.server.ts:2263` | (a) an agent run **failed** `:3656`, (b) `noProgress`/depth-cap in the react loop `:3824`, (c) `OPERATOR_TRANSITION_CHAIN_CAP` in `transitionStage` `:4643` | `redirect` · `request_edit` · `hold_runtime_debug`, **plus** a recommended `retry_other_backend` when the failure kind is quota/auth/unavailable |
| `escalateFailedOperatorRun` | `operator-run.server.ts:2632` | the operator's OWN run errored | `defaultPacketOptions("blocked")`, body + a `Provider said` observation (R20-3/F20-4) |
| no-plan escalation | `operator-run.server.ts:2102` | Codex produced no parseable plan | `defaultPacketOptions("blocked")`; falls back to `writeOperatorNoPlanNote` (`:2460`) when `generate-packets` is withheld (G6) |
| `operatorUpdateBranchFromBase` | `github/update-branch-operator.server.ts:158` | merge/push conflict bringing the branch up to base | `conflictOptions` (`:95`, applied `:260`): `redirect` (rec) · `custom` · `archive_task`, each with an explicit `ev` |
| **pr-diverged** | wake at `github-reconciler.server.ts:834`; doctrine at `operator-run.server.ts:3261` | GitHub reported closed / closed-at-terminal / merged / reopened | *model-authored*. Closed+active → a `custom` rework option + `archive_task` + `archive_task{deleteBranch}`. Merged → no packet, use `accept_completion`. Reopened → withdraw the moot packet |

**`StuckLoopEscalation`** (`task-actions.server.ts:2248`) is a typed three-state result,
new this pass: `{status:"opened", notifiedUserIds}` · `{status:"already_open"}` ·
`{status:"failed"}`. It exists so the T13 caller can tell "the packet notified these
people" from "nobody was notified for THIS event" (§5).

`defaultPacketOptions(type)` (`operator-run.server.ts:1810`): `blocked` →
`block_on_policy` (rec) · `redirect` · `hold_runtime_debug`; `input` → `request_edit`
(rec) · `redirect` · `custom`.

**Authoring coherence (F31-6, `operator-actions.server.ts:1024-1050`).** Offering
`discard_branch` on a task with `workRevision !== null` **or** an occupied branch name
(`fm.pr !== null || fm.github?.unownedPr != null`) is refused as `noop` with copy that
names `resolve_remote_collision` as the fitting verb. Live-caught: an operator authored
*"delete the conflicting REMOTE branch and push this task's commit fresh"* onto a
`discard_branch` option — confirming it would have destroyed the delivery it promised to
push.

**Withdrawals.** `withdrawSupersededStuckPacket` (`task-actions.server.ts:2388`) — a
successful agent run moots a `blocked` packet with no `accept_completion` option (call
site `:3705`). `withdrawSupersededDeliveryPacket` (`:2485`, call site `:5162`) — the
same shape once delivery succeeded, and **V10 widened its key** (`:2499`) to match
`discard_branch` **or** `resolve_remote_collision`: F31-6 refuses `discard_branch`
authoring exactly when work stands on the branch, so post-F31-6 conflict packets carry
the collision verb and keying on `discard_branch` alone would have reopened F29-7.
Reject-recovery packets (which use `archive_task`) are deliberately left alone.
`operatorResolvePacket` (`:1195`) refuses as `denied` when
`packet.from !== "operator" || packet.askedBy` (B2, `:1221`) — the operator must never
silently withdraw an agent's question; both halves are re-checked inside the lock, plus
the F10-09 id (`:1239-1240`).

### 1.12 Resolution, forced acceptance, and the disclosure contract

**Who may resolve** (`resolvePacket:6030-6056`): `accept_completion` skips the outer gate
and is guarded by `requireAcceptCompletion` (`:322`) instead; otherwise a live task owner
passes via `ownerException` (`:308` — requires a real `userId`, matching `ownerUserId`,
**and** a *current* `own-task` capability), else
`requireAction(…, "resolve-packet")` (`[admin, maintainer]`). Per-kind re-checks:
`archive_task` (`:6382`), `discard_branch` (`:6414`) and `resolve_remote_collision`
(`:6443`) each re-assert `approve-transition` inside their arms. A stranded
contributor-owner uses `requestPacketMaintainerDecision` (`:6975`), which notifies and
audits `task.packet.escalated` but **never mutates the packet**.

**`packetIdentity(p)`** (`:5927`) — `id:<id>` when present, else a content fingerprint
for pre-F10-09 files. Checked at **three** points: snapshotted before any await
(`:6019`), re-compared inside `beforeMerge` right before the irreversible GitHub write
(`:6162`), and again inside the write lock (`:6513`). All three raise *"This decision was
replaced by a newer one."* A task already at `acceptsInto` when the lock is taken sets
`alreadyAccepted` and **skips the whole write, the audit row and the branch cleanup**
(`:6497`, U3).

Audit: `task.packet.resolved` (`:6538`, details `{optionKind, optionTitle, packetKind}`)
· `task.operator.packet_opened` · `task.operator.packet_withdrawn` ·
`task.agent.packet_opened` · `task.packet.withdrawn_superseded` · `task.packet.escalated`
· `task.branch.discarded` / `.discard_refused` (`:6809`) · `task.acceptance.forced`.
`markTaskPacketApprovalRead` (`app/server/projections/notifications.server.ts:312`) runs
on **every** settled decision (`:6567`) — including `edit_goal`, which keeps its packet
open, because that is a made decision too.

`NO_REQUEUE` (`:6570`) is now **seven** kinds: `accept_completion`, `archive_task`,
`edit_goal`, `hold_runtime_debug`, `retry_other_backend`, `discard_branch` and
`resolve_remote_collision` (`:6574` — "the re-delivery's own machinery owns the
follow-up").

**Forced acceptance.** `forceAcceptCompletion` (`:8305`), gated on
`force-accept-completion` — `[admin]` only, **no owner exception** (`app/shared/rbac.ts`).
Order is deliberate: authority → already-Done early return *without* an audit row
(`:8330`) → `forceIrreducibleRefusal` (`:7221`, called `:8346`), the one gate force may
**not** bypass (a closed PR) → disclosure assertion (`:8354`) → compute `bypassed` from
the **pre-write** state → accept → audit `task.acceptance.forced` `{bypassed}` only if it
actually accepted. `force: true` never skips `acceptancePrHeadCheck` (`:7276`, called
`:8462`). The durable fact is `frontmatter.acceptance: "forced"`
(`task-file.schema.ts:684`), written in exactly one place (`:7870`) and read by
`deriveValidation` (`:747`, `:795`) to return `"bypassed"`. **A packet resolution can
never produce `acceptance: "forced"`.**

**The disclosure contract.** There is **no `AcceptDisclosure` exception in the tree**;
the pass-19 class of that name was lost in a two-session merge
(`app/shared/acceptance-disclosure.ts:11`). What ships is **`AcceptanceDisclosure`**, a
*form-field echo contract* (ruling 88 / F21-2), defined once and shared by both sides:

```ts
interface AcceptanceDisclosure { pr: PrState | "none"; revision: string; verdict: Validation }  // :35
const ACCEPT_DISCLOSURE_FIELDS = { pr: "ackPr", revision: "ackRevision", verdict: "ackVerdict" }; // :48
```

The dialog builds it **once, from the rendered props** (`accept-confirm.tsx`), and the
server compares it against `acceptanceDisclosureOf(fm)` (`task-actions.server.ts:7687`)
with `verdict` run through `deriveValidation`. `assertAcceptanceDisclosure` (`:7720`) is
three-state:

| `ack` | meaning | result |
| --- | --- | --- |
| an object | the human confirmed | compare via `acceptanceDisclosureDrift` (`acceptance-disclosure.ts:137`); drift → **409** `accept_disclosure_stale` |
| `null` | an HTTP door sent no echo (a bare POST) | **400** `accept_disclosure_missing` (`:7732`) |
| `undefined` | an **in-process** caller with its own contract (full-autonomy operator, tests) | return immediately (`:7726`) |

Five server call sites: `resolvePacket:6078` (`full`) and `:6243` (`in-lock`),
`applyAcceptanceWrite:7829` (`in-lock`), `acceptCompletion:7989` (`full`),
`forceAcceptCompletion:8354` (`full`). `scope: "in-lock"` skips the PR fact. Crucially,
**`skipInLockRecheck` does not relax the disclosure** (`:7823-7827`): *"force bypasses
process GATES, and this is not a gate: it is the record of what the human was shown."*

Six ceremony modes (`accept-confirm.tsx:50-56`): `accept` · `force` · `complete-merge` ·
`apply-recommendation` · `packet` · `stage-move`. `complete-merge` is the only one that
sends **no** disclosure (R16-6).

The packet UI intercepts rather than submits: `onResolve` (`task-detail-page.tsx:464`)
routes an `accept_completion` option into the ceremony with `mode: "packet"` (`:469`),
using `acceptance.blockedReasonViaPacket` (`:882`) — a packet resolution evaluates the
contract with `blockedPacket: false`.

**Three destructive confirms, one shell (V15).** `decision-packet.tsx` now has a shared
`PacketDestructiveConfirm` (`:140`) and three local ceremonies built on it:
`PacketArchiveConfirm` (`:245`), `PacketDiscardConfirm` (`:368`) and — new —
`PacketCollisionConfirm` (`:431`), which spells out what is deleted, kept and closed,
including the unowned PR number (`TaskSummary.unownedPr`, `app/shared/mapping/task.server.ts`).
`CONFIRM_FIRST_KINDS` (`:607`) is exactly those three kinds.

**One tier table (V16).** `PACKET_TIER_GATES` (`:536`) is a
`Map<PacketOptionKind, PacketTierGate>` with five rows — `accept_completion`,
`edit_goal`, `archive_task`, `discard_branch`, `resolve_remote_collision` — each naming
the grant, the card-level `denyNote` and the per-option `{title, note}` treatment. It
replaced six separate `o.kind === "…"` chains, and the comment at `:523-534` records why:
`resolve_remote_collision` shipped inert and hover-titled with **no** description clause,
so the one reason a keyboard or touch user can reach said nothing at all.
Consulted from every site through `gateFor` (`:762`).

---

## 2. The controller

### 2.1 Identity

`kind: controller`, exactly one per instance (`CONTROLLER_PROFILE_ID`,
`app/server/controller/controller-profile.server.ts:39`). Profile template
`agents/profiles/controller.md` (shipped: model `sonnet`, effort `high`, skills
`controller-guide`, kb `controller-handbook`); doctrine body
`agents/definitions/controller.md`, read by `readControllerDefinition` (`:139`) with
`FALLBACK_CONTROLLER_DEFINITION` (`:120`) baked in so a hand-wiped store still refuses
correctly instead of running promptless. `resolveControllerConfig` (`:171`) degrades to
defaults and reports `profilePresent: false` rather than downing the surface.
`saveControllerConfig` (`:203`) is org-admin-gated by its caller
(`app/routes/org.settings.tsx:201`, `requireRoleAuth(request, "admin")`), preserves the
shipped frontmatter head (`:284-287`), and audits `org.controller.updated` (`:290`).

- **No capability matrix** — its runtime authority is the asking user's, so a stored
  grant row would be a toggle with no effect (the P14-KM-14 class).
- **Not deployable to projects**; `readTemplate` resolves a controller-kind template as
  absent, and `saveGlobalAgentProfile` (`app/server/org/gagents.server.ts:216`) refuses
  any id whose stored `kind !== "specialist"` (`:237`) and conflicts on the existing
  `controller` file when creating (`:277`) — so the global-agent tool is not a door into
  the controller's own profile.
- **Claude only, enforced and disclosed** — `startTurnRun` hardcodes
  `backend: "claude"` (`controller-run.server.ts:333`) and
  `resolveRunModel("claude", config.model)` (`:334`); the settings panel fixes the model
  catalog to Claude for the same reason (`controller-admin-panel.tsx:247-259`).
- **`effort` is now a first-class profile key** (ruling 106):
  `AgentProfileFrontmatter.effort` (`agent-profile-file.server.ts:53`) is
  `z.string().optional().catch(undefined)` — deliberately **tolerant**, because a strict
  `z.string()` made a hand-edited `effort: null` fail the whole profile parse, after
  which `resolveControllerConfig` read "profile missing" and `saveControllerConfig`
  refused to repair it. Blank removes the key (`controller-profile.server.ts:272-274`).

### 2.2 The authority model — one shared voice

**New this pass (ruling 107):** the refusal machinery moved out of the toolkit into
`app/server/controller/controller-tool-guards.server.ts`, because the controller now
mounts **two** in-process servers and they must refuse identically.

`controllerToolGuards(db, user, dataRoot)` (`:79`) returns `ControllerToolGuards`
(`:56`):

- `actor` (`:84`) — `{ userId, label: "<email> · via controller" }`: guards bind to the
  human, the audit row discloses the instrument.
- `orgAdmin()` (`:87`) resolves **live** per call, never snapshotted.
- `requireOrgAdmin` (`:89`) refuses *and* writes `controller.authority.denied` (`:91`) —
  P13-D-8 parity, so instance denials do not read cleaner than project ones.
- `requireVisible` (`:101`) routes through
  `assertProjectAction(db, "any-member", …, { allowArchived: true })` and converts
  **any** failure into a `NotVisibleError` carrying the uniform `notVisible(slug)`
  sentence (`:48`): missing and forbidden read identically (R15-4). The project-side
  denial audit (`project.authority.denied`) is still written inside
  `resolveProjectAuthority` (`project-authority.server.ts:232`).
- `run` / `runWith` (`:112`, `:136`) map a 401/403 `AppError` to
  `[denied] <the guard's own sentence>`, a `NotVisibleError` to its own message, and
  anything else to `[error] …`.
- `json` (`:150`) — `JSON.stringify(value, null, 1)`.

`CONTROLLER_TOOLKIT_INSTRUCTIONS` (`controller-toolkit.server.ts:144`) tells the model a
`[denied]` is final and that nothing there deletes, merges, accepts completions, resolves
packets or moves a task into its final stage.

**Always-human stays human.** No tool for merge, acceptance, force-accept, packet
resolution, or a terminal-stage move; `move_task` (`:929`) refuses a Done target out loud
and points at the task page (`:943-949`) — ruling 88's ceremony is what chat cannot
impersonate. **No deletes anywhere.** Secrets never travel through chat
(`save_mcp_server` takes no credential). `move_task` always sends `manual: true`
(`:963`), so a viewer cannot cross through the controller an `auto` boundary they cannot
cross on the board; `comment_on_task` calls `requireProjectMutable` explicitly (`:990`)
because commenting names no `RbacAction` and so never reaches the R6-3 archive freeze.

Ruling 100 confirmed two asymmetries as **intended**: the controller applies
policy/workflow edits with no confirm ceremony, and org admins read project-scoped
transcripts for projects they are not members of.

### 2.3 Tool surface — `viberr_controller` (25 tools)

`buildControllerToolkit(deps)` (`controller-toolkit.server.ts:153`) builds an SDK MCP
server named `viberr_controller` (`:1633`) per turn. Every tool below, with its guard:

**Instance scope**

| tool | line | guard | audit |
| --- | --- | --- | --- |
| `whoami` | `:190` | none (self-description) | — |
| `list_users` | `:220` | `requireOrgAdmin` `:224` | — |
| `create_user` | `:241` | `requireOrgAdmin` `:249` | the action's own |
| `update_user` | `:266` | `requireOrgAdmin` `:291` | the action's own |
| `set_user_org_role` | `:331` | `requireOrgAdmin` `:338` | the action's own |
| `list_knowledge_bases` | `:352` | `requireOrgAdmin` `:356` | — |
| `save_knowledge_base` | `:373` | `requireOrgAdmin` `:394` | the action's own |
| `list_skills` | `:421` | `requireOrgAdmin` `:425` | — |
| `save_skill` | `:440` | `requireOrgAdmin` `:449` | the action's own |
| `list_mcp_servers` | `:469` | `requireOrgAdmin` `:473` | — |
| `save_mcp_server` | `:493` | `requireOrgAdmin` `:503` | the action's own |
| `test_mcp_server` | `:529` | `requireOrgAdmin` `:533` | — |
| `list_global_agents` | `:543` | `requireOrgAdmin` `:547` | — |
| `save_global_agent` | `:565` | `requireOrgAdmin` `:590` | `org.agent_profile.updated` / `.created` |
| `inspect_audit_log` | `:616` | `requireOrgAdmin` `:635` | — |
| `inspect_run_analytics` | `:664` | `requireOrgAdmin` `:668` **before** honoring `args.projectSlug`, so the `InsightsFilter` can never become a membership bypass | — |
| `create_project` | `:691` | any signed-in user (FR5), creator seeded project admin | the action's own |

**Project scope** (RBAC matrix; every one starts with `requireVisible`)

| tool | line | `requireVisible` | extra |
| --- | --- | --- | --- |
| `get_project` | `:765` | `:770` | — |
| `list_tasks` | `:822` | `:831` | — |
| `get_task` | `:859` | `:868` | — |
| `create_task` | `:888` | `:911` | `createTask`'s own `create-task` gate |
| `move_task` | `:929` | `:938` | terminal-target refusal `:943`; `manual: true` `:963` |
| `comment_on_task` | `:974` | `:983` | `requireProjectMutable` `:990` |
| `set_task_owner` | `:1011` | `:1022` | the action's own |
| `run_agent_on_task` | `:1052` | `:1065` | `canRunAgents` (maintainer+) `:1075` |
| `get_github_state` | `:1130` | `:1135` | — |
| `update_project_settings` | `:1165` | `:1176` | the action's own |
| `update_stages` | `:1199` | `:1217` | the action's own |
| `set_transition_boundary` | `:1263` | `:1274` | the action's own |
| `invite_member` | `:1290` | `:1299` | the action's own |
| `set_member_role` | `:1319` | `:1329` | the action's own |
| `deploy_agent` | `:1349` | `:1357` | the action's own |
| `update_agent_deployment` | `:1372` | `:1396` | the action's own |

**Goals**: `create_goal` (`:1450`, `requireVisible` `:1481`), `list_goals` (`:1499`),
`get_goal` (`:1526`), `update_goal` (`:1541`, all eight ops).

`run_agent_on_task` (`:1052`) is the operator seam: `canRunAgents` (maintainer+, `:1075`),
then either `runOperator({ trigger: "manual", humanComment, humanCommentBy, actor })`
(`:1083-1092`) — relaying `refused: "open-packet"` / `"terminal-stage"` / `queued`
honestly (`:1094-1104`) — or `startAgentRun` (`:1113`).

### 2.4 `viberr_ops` — the built-in diagnostics MCP (ruling 107, NEW)

`app/server/controller/controller-ops-mcp.server.ts`. Mount key
`CONTROLLER_OPS_MCP_NAME = "viberr_ops"` (`:75`), instructions at `:77`, built by
`buildControllerOpsMcp(deps)` (`:127`) using the **same** `controllerToolGuards`
(`:130-131`). READ-ONLY by construction: nothing here writes, deletes or starts anything.

| tool | line | guard | audit |
| --- | --- | --- | --- |
| `instance_health` | `:163` | **none for the reading** — it is what `/resources/health` already serves unauthenticated (`app/routes/resources.health.ts:8-10`); the credential **detail** sentence is org-admin-only via `backendCredential(backend, orgAdmin())` (`:117`), because `backendCredentialHealth` names the deployment's config directory | none (read) |
| `read_run_log` | `:200` | `requireRunVisible` (`:149`): a `kind: "controller"` run goes through `canReadControllerRunLog` (`controller-conversations.server.ts:125`) — conversation ownership or live org admin; every other run through `requireVisible(row.project_slug)`. **A missing run, a forbidden project and a forbidden conversation all answer `notVisibleRun(runId)` (`:104`)**, so a probe cannot walk run ids | none (read) |
| `read_store_doc` | `:329` | `requireOrgAdmin("read store documents")` (`:339`), like the store browser it comes from | denial only (`controller.authority.denied`) |

**Bounded paging (the ruling-107 review).** `DEFAULT_LOG_LINES = 200`,
`MAX_LOG_LINES = 500` (`:98-99`), clamped on **every** path (`:247`). `since` together
with `before` is refused rather than letting one silently win (`:239-246`). Forward mode
slices tool-side (`:272`) because `getRunLog` ignores `limit` in that direction **by
design** (the console's live tail is bounded by its own cursor). The reply relays
`run.{id,kind,state,backend,model,agent,project,task,startedAt,finishedAt,turns,logLines}`
and `page.{firstSeq,lastSeq,olderExist,newerExist,next}` computed against
`runLineStats(db, runId)` (`run-store.server.ts:351`) — deliberately **not** `getRunLog`'s
own `headSeq`/`oldestSeq`/`hasMore`, which are page-local cursors a model with no second
source would read as facts about the run (`:275-284`).

**Not removable by construction.** `buildControllerMounts`
(`controller-run.server.ts:150`) attaches both in-process servers on every turn with no
config read and no grant row (`:161-173`), and org grants land **last** but can never
shadow either, because the *resolver* refuses a reserved name.
`RESERVED_MCP_NAMES` now lives in ONE list — `app/shared/mcp-reserved.ts:29` (both the
underscore and hyphen spellings of `viberr`, `viberr_agent`, `viberr_browser`,
`viberr_controller`, `viberr_ops`) — read by the writer (`saveMcpServer`), the picker
(`buildResourceCatalog`) **and** the runtime resolver
(`specialist-mcp.server.ts:138`, `:142`, `:175`). The resolver's private copy had fallen
two rulings behind, so a row carrying `viberr_controller` written straight into SQLite or
restored from a backup resolved normally and, mounting last, replaced the built-in server
under its own key.

The settings tab discloses it as a **pinned chip that is not a control**
(`controller-admin-panel.tsx:376-384`) — a span, never a disabled button, because a
disabled control is a toggle that does nothing and its `title` would never open.

### 2.5 Conversations and the turn engine

`controller_conversations` + `controller_messages`
(`db/migrations/0001_baseline.sql:423`, `:439`; module
`controller-conversations.server.ts`). `canAccessConversation` (`:105`) allows the owner
and **live-resolved** org admins; project members do **not** read each other's.
`requireConversation` (`:148`) throws a 404-shape so a non-owner cannot distinguish "not
yours" from "never existed". `appendMessage` (`:259`) allocates `seq` as `MAX+1` under the
SQLite write lock behind a `UNIQUE (conversation_id, seq)` index, derives the title from
the first user message (`deriveTitle`, `:312`), and publishes the owner-routed SSE
`controller.updated` (`publishConversationUpdated`, `:318`).

**One message = one run** — `runControllerTurn` (`controller-run.server.ts:180`):

1. Records the user message **first** (`:199`) — whether a run starts or queues is a
   scheduling fact, not a data one. Only the **owner** may speak (`:190-197`).
2. Refuses honestly *in-transcript* when `isBackendAvailable("claude")` is false (`:206`).
3. Single-flight on `Symbol.for("viberr.controllerLease")` (`:68`) with a FIFO capped at
   `MAX_QUEUED_MESSAGES = 8` (`:100`). A queue-full message gets its own refusal **in the
   transcript** (`:228`) — a toast is gone by the time anyone re-opens the thread.
4. `startTurnRun` (`:263`) resolves org MCP grants **once** (`:275-280`, F21-3: prompt and
   mount from the same result), builds the mounts (`:282`), then starts or resumes a run
   with `kind: "controller"`, `projectSlug: ""`, `taskKey: <conversation id>` — a scope no
   task query matches (`:344-345`).
   `disallowedTools = ["Read","Grep","Glob","WebFetch","WebSearch"]` (`:301`): the
   controller's world is the product, not the disk. `effort` rides into both the resume
   (`:325`) and the start (`:348`) — ruling 106 made the run honor what nothing could
   previously set.
5. Continuity: `latestTurnRun` (`:92`) is the resume anchor, plus a bounded
   `transcriptDigest` (`:595`; `CONTEXT_MESSAGES = 30` / `CONTEXT_CHARS = 24_000`,
   budgeted newest-first then restored chronologically) — the controller has no `task.md`
   to re-anchor on.
6. `settleTurn` (`:395`) records the reply, releases the lease, fires the next queued
   message, names a failure's cause (quota/auth/generic, `:413-425`), and on a failed
   queued start says **how many** messages it dropped with it (`:454-462`).

`buildControllerSystemPrompt` (`:626`) = doctrine + trusted-resource banner (`:646`) +
skills + KBs + a runtime block (`:657`) + a conversation block (`:681`). Two ruling-107
corrections live in the runtime block: the MCP arms say **"org"** MCP servers in both
directions (`:666-668`) — the flat negation used to sit one line above the built-in
diagnostics sentence, telling the model in consecutive breaths that it had no MCP servers
and that it had one — and the `viberr_ops` disclosure (`:674-677`) is true on every turn
**by construction**, because the mount reads no config.

`canReadControllerRunLog` (`controller-conversations.server.ts:125`) moved here from the
run engine (ruling 107) so the ops server can ask it without an import cycle; the run-log
route and the session export ask the same function.

**Boot recovery** — `recoverControllerConversations` (`:491`) has **two arms**, because
message order structurally cannot see the common case (a turn taken off the FIFO always
has the previous turn's reply after its own user message):

- Arm 1 (`:506`) drives off the **run** — a terminal `kind='controller'` run with no
  message carrying its id is exactly a turn whose `settleTurn` never ran. The note
  carries `runId` (`:528`), which is what stops the next boot writing a second one.
- Arm 2 (`:541`) catches a message whose run never started at all, and reads **after**
  arm 1's notes have landed.

Both skip a conversation whose lease is currently held (`:522`, `:554`). Called from
`boot.server.ts:682`.

### 2.6 Deployment locks on the controller's configuration (ruling 108, NEW)

`ControllerSectionLocks` (`controller-profile.server.ts:49`) — `true` = locked — covers
four sections: `skills`, `kb`, `mcps`, `instructions`. Model and effort are deliberately
**not** sections (`:45-47`): picking the tier is day-to-day admin work; rewriting what the
controller *is* operates above the org.

`CONTROLLER_UNLOCK_ENV` (`:58`) maps section → `VIBERR_UNLOCK_CONTROLLER_{SKILLS,KB,MCPS,
INSTRUCTIONS}`; `CONTROLLER_SECTION_LABEL` (`:67`) gives the human names shared by the
refusal and the panel note; `CONTROLLER_UNLOCK_VALUE = "enabled"` (`:77`). `unlockFlag`
(`:78`) lower-cases and trims, so `disabled`, unset **or a typo** all keep the section
locked — it fails safe (closed). `controllerSectionLocks(env = getEnv())` (`:84`) takes a
`Pick<Env, …>` so the schema keys are pinned by the type; the four keys are declared at
`app/server/config/env.server.ts:173-176`, documented in `.env.example:187-190`, and
defaulted to `disabled` in `compose.yml:52-55`.

**Enforcement is server-side in `saveControllerConfig`** (`:203`), not in the route, so
every save path is bound (`:219-220`; `ctx.locks` exists for tests only):

- `resolveGrant(section, stored)` (`:234`) — unlocked writes the input as given; locked
  writes the **stored list verbatim** (order and duplicates included), so no save can
  perturb the on-disk grants. Only a **non-empty** input that differs as a *set*
  (`sameSet`, `:222`) is refused (`:239-241`).
- Blank keeps: an empty list under a lock is "keep the stored value" — which is exactly
  what the panel posts for a locked section, and what makes a model/effort-only save
  succeed under a lock.
- Instructions: `definitionInput` blank keeps the current doctrine (`:254-255`); under a
  lock a non-blank body that differs from the stored doctrine is refused (`:256-259`),
  and a locked save **never rewrites the doctrine file** (`writeDefinition = false`,
  `:260`).
- The refusal sentence names the section and its variable (`:227-229`):
  *"The controller's <label> are locked on this deployment. Set `<VAR>=enabled` in the app
  environment and restart to edit them."*
- The audit row's `definitionEdited` is honest: `writeDefinition`, not "a body was
  posted" (`:301-303`).

**Panel side** — `app/features/org-settings/controller-admin-panel.tsx`. The loader
supplies `controllerLocks: controllerSectionLocks()` (`app/routes/org.settings.tsx:129`).
Client mirrors of the server constants are drift-pinned by test:
`CONTROLLER_UNLOCK_ENV_VIEW` (`:70`), `CONTROLLER_UNLOCK_VALUE_VIEW` (`:79`),
`SECTION_LABEL` (`:83`). A locked `GrantChips` group (`:104`) renders **granted-only,
read-only spans** (`:132-134`, `:155-163`) rather than disabled buttons — the
granted/ungranted distinction a screen reader would lose does not exist under a lock, so
`aria-pressed` is not needed and the F19-5 regression is avoided; a dangling grant is
still **disclosed** as a non-removable red chip (`:181-190`). The lock note (`:310-336`)
lists the locked sections and their `VAR=enabled` variables and states the boundary
honestly. The doctrine textarea goes `readonly` with a muted resting look, and the labels
carry an `Icon name="lock"` sized by a `.lbl-lock` rule.

`save()` (`:277-288`) posts **blank** for every locked section — which is what stops a
stale grant/doctrine copy the panel is still holding from being posted back as a change
(review finding #2: a page loaded before the doctrine file changed used to make the next
model-only save fail with a spurious instructions-lock refusal). Under a lock the
P13-KM-01 KB display-name repair (`:233-235`) runs for **display only**, because the
payload is now lock-aware and the repair can no longer become a write.

`viberr_ops` is **not a section**: it stays mounted and non-removable under every flag
combination.

**Scope (owner, narrow reading).** The lock covers the controller *settings tab* only.
Deleting or renaming a resource on the Agent resources tab still prunes the controller's
grant (the shared `resource-references` rewrite), and editing a granted skill's or KB's
file contents still changes what the controller loads as trusted context. The panel note
and `decisions.md:1634-1645` state that boundary rather than imply a containment the
ruling does not provide.

### 2.7 Chained goals

> Naming note: the design doc's `advanceGoalForTask`
> (`planning/discovery-2026-08-30-controller/DESIGN.md:112`) **does not exist**. The
> shipped hook is `maybeReconcileGoalForTask` and the engine is `reconcileGoal`.

Canonical file `projects/<slug>/goals/<goal-id>.md`
(`app/server/files/goal-writer.server.ts`, schema `app/schemas/goal-file.schema.ts`).
Frontmatter: `id`, `title`, `status: active|paused|attention|completed|cancelled`,
`createdBy`, `createdByLabel`, `onFailure: pause|continue`,
`links[{index,title,goal,taskKey,status,note}]` with link status
`pending|active|done|failed|skipped`, `createdAt`, `updatedAt`. Body: `## Description`
plus a `## Timeline` of newest-first `- <ISO> · <text>` bullets. Unknown frontmatter keys
round-trip. The back-reference is the task's `goalRef: {goalId, linkIndex}`
(`task-file.schema.ts:693`), projected to `task_projections.goal_id` / `goal_link_index`.

**Authority** (`app/server/tasks/goal-actions.server.ts:39-65`):

- **Create** — the asking user's own `create-task` (`createGoal:117`, `requireAction` at
  `:126`). A chain is a promise of future task creation, gated where its effect is.
- **Advance** — nobody is present, so it runs under the recorded creator and
  **re-proves** their live `create-task` (`creatorMayCreateTasks:501`, with
  `silentDeny: true`). Lost authority parks the chain in `attention` and notifies.
- **Redirect** — `requireGoalAuthority` (`:237`): the creator themselves (membership + an
  explicit `requireProjectMutable` at `:247`, because that arm bypasses the
  `requireAction` chokepoint that freezes an archived project) **or** a member holding
  `run-agents` (`:257`).

**Lifecycle.** `createGoal` holds `withGoalsLock` (`:156`) across id minting → link 1's
`createTask` → the goal-file write; link 1's task is created *first* so a refusal leaves
no orphan file. `GOAL_MAX_LINKS = 20` (`:67`).

`reconcileGoal` (`:631`) is **the convergent engine** — hooks and the runner both just
say "look at this goal now". It derives each linked task's state from the **canonical
file**, not the projection; parks in `attention` on a failure when `onFailure: pause`
(`:716`), or marks the link `skipped` and moves on when `continue`; completes the goal
when `allLinksSettled`; and starts the next link through `startLinkTask` (`:534`) /
`startLinkTaskLocked` (`:548`). `notifyCreator` (`:474`) emits notification kind
`controller`.

Hooks: `maybeReconcileGoalForTask` (`:847`) fires from three task write paths —
transition, archive, acceptance — plus `reconcileAllGoals` (`:884`) over
`goal_projections WHERE status IN ('active','attention')`, run once at boot and then by
`startGoalRunner` (`:921`) every `GOAL_TICK_MS = 60_000` (`:912`; `boot.server.ts:680`).

Redirect ops (`UpdateGoalOp`, `:220`): `pause`, `resume`, `cancel`, `skip_link`,
`retry_link`, `edit_link`, `add_link`, `remove_pending_link`. The **project route accepts
only the first five** (`app/routes/project.controller.tsx:98-117`, everything else
`400 "Unknown goal action."`); the other three are controller-tool-only
(`controller-toolkit.server.ts:1549-1557`). Nothing deletes a goal.

Projection: `goal_projections` (`db/migrations/0001_baseline.sql:203`), rebuilt by
`rebuildGoalFile` (`app/server/projections/rebuilder.server.ts:733`) with link statuses
re-derived against live task rows, goals walked *after* tasks. Watcher path class at
`app/server/files/file-watch.service.server.ts:260-266` (plus the goals-dir prune at
`:222-228`); the store doctor walks goal files (`app/server/files/store-check.server.ts:220`).

### 2.8 Surfaces

- `/controller` (`app/routes/controller.tsx`) — every signed-in user (`requireUser`,
  `:26`); `?c=<id>` selects a conversation, `?all=1` is the org-admin
  everyone's-conversations view (`:34-35`).
- `/projects/:slug/controller` (`app/routes/project.controller.tsx`) — the eighth
  `WORKSPACE_NAV` item (`app/features/shell/nav.ts:25`). `requireProjectMember` on
  **this** loader (`:31`), not only the layout's, closing the F19-28 single-fetch
  `?_routes=` hole. Its `goal-op` intent (`:93`) drives `updateGoal` (`:120`).
- `getControllerSurface` (`app/features/controller/controller-query.server.ts:48`)
  assembles conversations, transcript, `conversationTurnState` (`:101`) and — on the
  project surface only — `listGoals` (`:103`). An unreadable conversation throws
  `data(…, { status: 404 })` (`:79`), not an `AppError`, because only a thrown `Response`
  is understood by the root boundary from inside a loader (§3.4).
- `ControllerPage` (`app/features/controller/controller-page.tsx:36`) renders the list
  (`:140`), transcript (`:199`), composer (`:255`) and the `GoalsPanel` (`:341`).
  `canRedirectGoals` is a *display* hint from the member role; the server re-checks per
  submit. Task detail carries a goal chip linking back
  (`app/features/task-detail/task-main-sections.tsx:196`).
- `/org/settings` → the Controller tab (`ControllerAdminPanel`), admin-only end to end:
  loader `requireRole(request, "admin")` (`app/routes/org.settings.tsx:109`), action
  `requireRoleAuth(request, "admin")` (`:201`), `controller-save` intent at `:427`.

---

## 3. Schedules — `run-operator` and `run-agent`

`app/server/tasks/schedule.server.ts`.

**There is no cron, no cadence, no recurrence.** Every entry is a **one-shot occurrence**
with an absolute `dueAt`; a fired occurrence is terminal. Canonical in
`frontmatter.schedules`, mirrored to `task_projections.schedules_json`.

`scheduleSchema` → `TaskSchedule`: `id` · **`action`** (not `kind`) from
`SCHEDULE_ACTION_TYPES = ["run-operator","run-agent"]` · `dueAt` · `profileId` · `prompt`
· `createdBy`/`createdByLabel`/`createdAt` · `status` from
`["pending","claimed","fired","failed","cancelled"]` (there is **no `enabled` flag** — the
on/off axis is `pending` vs `cancelled`) · `firedAt` · `claimedAt` · `retries`.
**No `backend`, no `autonomy`** — ruling R22 supersedes FR39's per-schedule pin; the entry
pins nothing but identity and `.loose()` silently ignores those keys in pre-ruling files.
Parsed per row at read time by `scheduleListSchema` (`schedule.server.ts:299`) —
`z.array(scheduleSchema.nullable().catch(null))` filtered, so one malformed row cannot
empty the list.

**Tick loop.** `startScheduleRunner` (`:791`) from `boot.server.ts:668`: a `setInterval`
at `SCHEDULE_TICK_MS = 60_000` (`:48`, `:815`), guarded by
`Symbol.for("viberr.scheduleRunner")` (`:776`) so an HMR reload cannot arm a second
interval, latched so a slow tick cannot stack, `unref`'d, and firing `fireDueSchedules`
(`:335`) **once immediately** (`:797`) as the missed-tick catch-up.
`tasksWithUnresolvedSchedules` (`:280`) uses `json_valid(...) AND EXISTS (SELECT … json_each …)`
— B-WF5: it used to be a `LIKE '%"status":"pending"%'` substring scan.

**The claim protocol.** `pending → claimed` is written to the **file** under lock
(`:445-478`) *before* any run is enqueued and finalized to `fired` only after the enqueue
returns; a `claimed` row older than the lease is treated as crashed and re-driven.
`claimLeaseMs()` (`:322`) is **derived** — `cloneTimeoutMs() + 5 * 60_000` — and is a
**function** (V19) so it follows the now-lazy env read of the clone ceiling. The drain
re-stamps `claimedAt` as each occurrence's own drive begins (`:571-578`), because with
several due at once a later one's *queue wait* alone could outlast the lease.

**Dispatch.** `run-operator` (`:622`) calls `runOperator` with **only**
`{projectSlug, taskKey, trigger: "scheduled", dataRoot}` plus `scheduleNote = prompt`
(`:636`) — no backend, no autonomy, no human actor. The note reaches the model through
`scheduleContext` (`operator-run.server.ts:3398`). `run-agent` (`:603`) calls
`startAgentRun` under actor `{ userId: "system", label: "schedule runner" }` with
`operatorAuthorized: true` (`:617-618`), and the scheduler is the dispatch-completion
contract's triggerer (§5). A `run-agent` entry with a null `profileId` goes terminal
`failed` (`:591-596`) — it used to fall through to the **operator** arm.

**Baked into the run controls.** There is no scheduled-actions panel.
`RUN_DELAYS = now | 5 | 60 | 360 | 1440` minutes
(`app/features/task-detail/execution-profile.tsx`); `OperatorRunControl` and
`AgentRunControl` flip their label to **"Schedule"** and their icon to `clock` when a
delay is picked, and each renders its own `PendingSchedules` list. RBAC `run-agents`,
with `delayMinutes` clamped to 1 … 40 320 (28 days) and `prompt` to 4000 chars. The loader
shows only `status === "pending"`, so a `claimed` occurrence is invisible for up to the
lease duration.

**Guards.** Create-time (`scheduleTaskAction`, `:131`) refuses a past `dueAt`, a
`run-agent` with an undeployed profile, or a terminal-stage task. A `run-agent` whose
profile already has a live run is left `pending` **silently** this tick (`:425-434`),
spending no retry. Fire-time mootness is decided **inside the file lock** (`:456-461`):
`projectFrozen || archived || stage === terminal`. `projectArchivedFor` (`:354`) exists
because the fire path runs under `operatorAuthorized`, which skips `requireRunAgents` and
with it the R6-3 archived freeze. Terminal refusal is three-layered (create → claim →
`runOperator`'s own `refused: "terminal-stage"`). `MAX_SCHEDULE_RETRIES = 3` (`:327`); a
400 validation refusal goes terminal immediately (`:645-650`) and a 409 single-flight
conflict defers without spending a retry (`:653-655`). Audit:
`task.schedule.created` / `.cancelled` / `.fired` (with
`outcome: claimed|skipped-done|skipped-archived`, plus a second row with
`refusedAtStart: true` when `runOperator` refuses after the claim note already said a run
was starting). A cancelled schedule leaves `firedAt` **null** (P11-75).

**Agents cannot schedule**: `CronCreate` / `CronDelete` / `CronList` / `ScheduleWakeup`
are denied builtins (`claude-runtime.server.ts`) — "scheduling is viberr's job". Creation
is human-only, through the route.

---

## 4. Insights and governance

One exported query: `getInsightsSummary(db, nowIso, filter?)` —
`app/server/insights/insights-query.server.ts:434`. `nowIso` is injected rather than read
from a clock so the window and the generated-at stamp are deterministic.
`WINDOW_DAYS = 30` (`:21`), `TOP_N = 8` (`:22`).

| group | fields | source | window |
| --- | --- | --- | --- |
| `InsightsTotals` (`:24`) | `runs`, `costedRuns`, `cost`, token counts, `turns` | `agent_runs` | all time |
| `outcomes` (`:107`) | the five run states + `successRate` | `agent_runs.state` | all time |
| `CountRow[]` ×4 (`:36`) | `byBackend`, `byKind`, `byProject`, `byModel` | `agent_runs` | all time, capped |
| `avgDurationMs` (`:121`) | `AVG(MAX(0, julianday diff × 86400000))` | finished runs | all time |
| `DailyPoint[]` (`:45`) | `{date, runs, cost}`, gap-filled to 30 points | `agent_runs` | 30 days |
| `OversightSummary` (`:63`) | see below | `task_projections`, `projects`, `audit_events`, `agent_runs` | **all time** |
| `backendQuota` (`:127`) | latest reading per backend | `instance_settings` | latest only |

`OversightSummary` (`oversightSummary:270`): **`clarity`** · **`traceability`** ·
**`packetResolution`** (each `*.packet_opened` paired with the task's next
`task.packet.resolved`, plus a live `openNow`) · **`timeToReview`** ·
**`longTimelines`** (a project whose `compression-threshold` guardrail is absent or off
contributes none — `compressionThreshold`, `:247`) · and, **new this pass**,
**`coordination`** (`:89-101`, F31-D6).

**Coordination overhead (F31-D6).** `coordination: { coordinationCostUsd, totalCostUsd,
share }` — the COORDINATION runs' share of all reported run spend in scope. Coordination
is `operator` **+** `controller` (RunKind): both are machinery that decides what the
working agents do rather than doing the work, and counting only the operator understated
the overhead by every controller turn on the instance (live pass 31 measured 63% with no
number saying so). Derived from the same cost column the totals card sums — runs that
reported no cost contribute to neither side, and with zero reported spend the share is
`null`, never a fake 0%. Folded into the totals query (a third aggregate was deleted) and
passed into `oversightSummary` (`:606`).

**The gate is one line**: `await requireRole(request, "admin")` —
`app/routes/insights.tsx:17`. That is the *instance* role, and the route passes **no
filter**, so every row on the instance is aggregated regardless of memberships.

**R15-4 does not reach insights.** The one place `InsightsFilter` (`:162`) is used is the
controller tool `inspect_run_analytics` (`controller-toolkit.server.ts:664`), which calls
`requireOrgAdmin` (`:668`) **before** honoring `args.projectSlug`.

### Honesty guarantees

1. **Cost is UNKNOWN, never zero** — the group and daily SQL deliberately omit `COALESCE`;
   NULL survives into `cost: number | null` and renders "not reported".
2. **The headline discloses its own coverage** — `totals.costedRuns` (`:26`).
3. **A NULL cost must not drop a busy group** — the cap moved into JS with
   `floor(TOP_N/2)` slots reserved for the busiest-by-runs (`:525-530`).
4. **"Completion rate", not "Success rate"** (R26-3).
5. **"Long timelines" agrees with the machinery it describes** — per-project threshold,
   `null` when absent or off (`:247`).
6. **An unresolved or withdrawn packet contributes no duration**; still-open ones are
   reported separately as `openNow`.
7. **Excluded populations are disclosed**; `project_slug = ""` is labelled
   "controller (instance)" rather than a blank bar.
8. **Null vs zero** — every pct/avg/median returns null on an empty population; the one
   deliberate real zero is the gap-filled daily point.

### Quota

`app/server/runtimes/backend-quota.server.ts` — not a probe, an **observation log**.
`rate_limit_event` envelopes are decoded at the one wire boundary with **nullable numbers
on purpose**. `recordBackendRateLimit` UPSERTs into `instance_settings` under
`backendRateLimit.<backend>` — **V14** rewired it through the shared instance-settings
accessors (`app/server/settings/instance-settings.server.ts`) instead of hand-rolled SQL.
**V4**: a transient 429 no longer persists as "usage limit reached" (a provider-wording
gate + TTL + newer-reading-wins panel); **V9**: prose reset times parse as UTC with a 24 h
expiry grace and render date-only. `BackendQuotaPanel` keeps its three honest states, and
the family rule (R17-5) holds: **a never-checked thing renders neutral, not alarming.**

`instance_health` (§2.4) reports availability from `backendCredentialHealth` — a
different, live question from this observation log.

---

## 5. Operator ↔ dispatch: the completion contract

Ruling 98's **dispatch-completion contract** has two halves: a dispatched run's report
must actually notify the human who dispatched it, and it must always hand back to the
operator.

**(a) cc-append — the guarantee half.** The prompt asks for the tags in the model's own
words (`specialist-run.server.ts`), but guidance is not a guarantee. The pipeline appends
what is *missing*, **before the reply is stored** (`task-actions.server.ts:3302-3315`):

```ts
const hasHumanTag = input.dispatchedByUserId
  ? mentionNotifiesUser(db, replyText, input.dispatchedByUserId)
  : replyText.includes(`@${name}`);
const hasOperatorTag = /@operator\b/i.test(replyText);
if (missing.length > 0) replyText = `${replyText}\n\ncc ${missing.join(" ")}`;
```

"Already tagged?" is answered by the **same resolution ladder the fan-out delivers with**,
keyed on the dispatcher's user id — the old first-word substring check was satisfied by
`@Arda Other` when the dispatcher was `Arda Kaya`.

Because the cc line varies with the *dispatch source*, **every agent-text-vs-agent-text
comparison runs on the cc-stripped form**. `stripCcLine` (`:1824`) drops any line matching
`/^cc @/`, applied on both sides of the no-progress detector (`:3808-3812`) and
`duplicatedOwnCommentText` (`:1853`, the F22-12 mid-run-repeat check). That helper returns
the **matched text**, not a bool.

**(b) always-react — the handback half.** `mustReact` (`:3803`) bypasses the react
heuristic for a manually/schedule-dispatched run:

```ts
const mustReact =
  !!input.dispatchedByName &&
  finished.state === "finished" &&
  currentDepth < OPERATOR_REACT_DEPTH_CAP;
```

The depth cap still binds and only **this** hop is forced. When neither `shouldReact` nor
`mustReact` holds, a verbatim repeat (`noProgress`) or a depth-capped chain opens a
stuck-loop packet (`:3823`), and `clearWaitingToHuman` **always** runs (`:3839`) so the
board cannot read "agent working" forever.

**(c) T13 — one notification per failure, PER RECIPIENT (new).** A failed agent run used
to put two near-identical rows in every supervisor's queue: the actionable `packet` row
from `openStuckLoopPacket` → `operatorOpenPacket` → `notifyTaskWatchers`, and a shorter
`quality` row that cannot be acted on. The dedupe (`:3661-3691`) is **per recipient**,
not global, because `packet` and `quality` are independent routing categories: a watcher
who silenced packets but kept quality would otherwise get **nothing** about the failed
run. `StuckLoopEscalation.notifiedUserIds` reports exactly who the packet row reached, and
that list becomes `failureNotice.exceptUserIds` (`:3689`) only when
`escalation.status === "opened"` — an `already_open` or `failed` escalation still fans the
quality row to every watcher, because that earlier packet's notification may have been
about something else entirely.

---

## 6. Gotchas

### 6.1 Decide, await, then blind-write

A decision taken from a **pre-await snapshot** and committed with a wholesale key assign.
Confirmed instances: the goal advance grew two tasks for one link (fixed by
`startLinkTask`, `goal-actions.server.ts:534`, an in-process per-link lock plus a re-check
under the goal-file lock at attach time); `createGoal` minted the same id twice (fixed by
`withGoalsLock` spanning all three steps, `:156`); the GitHub reconciler overwrote an
acceptance that landed mid-pass; the schedule drain measured its lease from the claim, not
the drive. The fix shape is always the same: **re-check the decision inside the write
lock, or hold one lock across the whole sequence.** `operatorOpenPacket:1119`,
`operatorResolvePacket:1233`, `packetIdentity`'s three checkpoints, and `reconcileGoal`
all follow it.

### 6.2 A guard that short-circuits ahead of the chokepoint

The task-owner exception returned **before** `requireAction` — and with it before the R6-3
archive freeze. The goal-redirect **creator** arm had the same shape, which is why
`requireGoalAuthority` calls `requireProjectMutable` explicitly in that arm
(`goal-actions.server.ts:247`); the `run-agents` arm gets it from `requireAction` for
free. The schedule fire path (§3) is the third instance, via `operatorAuthorized`. The
controller's `comment_on_task` is the fourth: commenting names no `RbacAction`, so it
guards `requireProjectMutable` itself (`controller-toolkit.server.ts:990`).

Sibling class: **a new caller reaching a branch documented as unreachable.** The
controller's `move_task` omitted `manual`, dropping an `auto` boundary to
`transitionStage`'s any-member arm — a *viewer* could cross through the controller what
they cannot cross on the board. Fixed by always sending `manual: true`
(`controller-toolkit.server.ts:963`).

### 6.3 Goal-chain oscillation (attention → active → attention)

Lifting `attention` on the mere **absence** of a failed link flipped a chain parked for a
*different* cause (a lost creator authority) back and forth on every 60 s tick. Fix
(`goal-actions.server.ts:668`, `:707`, `:715`, `:731`): track `recoveredLink`, a link
*this pass* moved out of `failed`, and lift only the park whose cause the same pass
watched disappear — `if (recoveredLink && !anyFailedOpen && fm.status === "attention")`.
`paused` is a human's park and is never lifted here.

### 6.4 The controller 404 that rendered as a 500

`getControllerSurface` refused an unreadable conversation with an `AppError` from inside
two **loaders**, where only a thrown `Response` is understood by the root boundary. Fix:
`throw data("Conversation not found.", { status: 404 })`
(`app/features/controller/controller-query.server.ts:79`).

### 6.5 Controller boot recovery cannot key on message order

Two arms — see §2.5. Arm 1 drives off the **run** and carries `runId` so the next boot
cannot double-note; arm 2 reads **after** arm 1's notes have landed.

### 6.6 Boot ordering around the operator sweep

The orphan sweep launched its operator re-invokes **detached**, and boot moved straight on
to the workspace reclaim — which `rmSync`s the very directories those drives were cloning
into. The sweep is now step 0 of `reconcileRestartedWork` and its re-invokes are joined
before the reclaim.

### 6.7 Whole-array tolerant parsing

One malformed row emptied an entire list, and because the diagnostic is only a warning the
file stayed writable, so the **next** write persisted the loss. Task `engagements`,
project `guardrails`, `verdicts`, `schedules`, `recommendations`, `labels` — and, as of
C5 (pass 31), **packet `options`** — all parse per row through the shared `tolerantRowsOf`
(V17, `app/schemas/file-diagnostics.ts`).

### 6.8 Display re-deriving what the runtime decides

`capabilities.delivery` in `listDeployedSpecialists` advertised delivery from a scoped
grant alone, ignoring the headline gate the runtime enforces. Same class: the resource
delete-confirm counted grants from the specialist CRUD list while the delete rewrites
*every* profile file (including the controller's), and the notification surfaces
re-derived navigability instead of using the `href` the server had already resolved.

### 6.9 Stale names — do not code against them

**`AcceptDisclosure` does not exist** anywhere in the tree; the shipped contract is
`AcceptanceDisclosure` (§1.12), a form-field echo, not a thrown error. C8 (pass 31) fixed
the stale comment that named a never-shipped `AcceptDisclosureProvider` React context — it
now names the real shared ceremony, `AcceptConfirm`
(`app/features/task-detail/decision-packet.tsx:236-239`), and the ghost-named
`pr-divergence-operator` test file was renamed `pr-divergence-wake`. Still stale:
`DESIGN.md:112`'s `advanceGoalForTask` (the hook is `maybeReconcileGoalForTask`, the
engine `reconcileGoal`).

### 6.10 Smaller sharp edges

- **`denied` vs `noop`** — a state conflict returned as `denied` tells the human the
  project's policy blocked work it never blocked, and writes a `policy` event the activity
  feed reads as a governance signal (`operator-actions.server.ts:165-188`).
- **A scheduled trigger in the newest-wins slot** — any later machine trigger overwrote it
  *and its note*, while the runner had already stamped the occurrence `fired`
  (`operator-run.server.ts:406-410`). Same class as V13's `strandedResume`/`transitionDepth`
  carry-forward (`:436-453`).
- **`stageAtStart: null` is not "not applicable"** (`:717`, B6). Likewise `runOperator`
  returning `null` rather than the literal `"queued"` (B10, `:217-227`).
- **Two writers after a delivery** — exactly one runs: the R18-2 re-queue (full autonomy,
  newly opened PR, `task-actions.server.ts:5197-5207`) **or** the server-recorded "Move to
  review" card (operator-authorized supervised delivery, `:5209`). A human manual delivery
  gets neither.
- **Archiving a *completed* task must not retroactively fail its link** — the engine
  treats `done` as settled and never revisits it
  (`app/server/projections/rebuilder.server.ts:827`).
- **`retry_link` un-parked before creating the task** — it now re-parks to `attention` in
  the catch (`goal-actions.server.ts`).
- **A goal description could forge its own history** — an unescaped `## Timeline` line
  closed the section and turned the rest into fake bullets
  (`app/server/files/goal-writer.server.ts:38-45`).
- **Every reconcile rewrote the goal file**, so the 60 s runner churned each live goal
  forever. `updateGoalFile` now compares bytes with the old `updatedAt` in place.
- **A canary can pass against a page-local floor.** The ruling-107 run-bounds lock passed
  until a test walked the older cursor all the way to seq 0 — no arm had ever fetched the
  page that starts at the run's first line, so `olderExist` was never asked the only
  question `minSeq` answers (`controller-ops-mcp.server.test.ts:452-464`).

---

## Findings for the pass-32 ledger

Nothing below was fixed. Each item: what · where · why it matters · confidence.

**F32-OC-1 — a controller comment's audit row cannot be traced to the person who asked
for it. CONFIRMED (high).**
`comment_on_task` (`app/server/controller/controller-toolkit.server.ts:974`) calls
`postAgentComment` (`app/server/tasks/agent-toolkit.server.ts:114`), whose audit row is
written as `actor: { userId: null, label: encodeActorRef({ kind: "controller" }) }`
(`agent-toolkit.server.ts:144-152`). Every *other* controller mutation binds the audit to
the human through the shared `actor` (`controller-tool-guards.server.ts:84`,
`"<email> · via controller"`). So the one controller tool that writes into a task timeline
is the one whose `audit_events` row carries no `user_id` and no email — an actor-filtered
audit view will not show it under the person who caused it, and the only trace of who
asked is the prose footer the tool appends to the comment body
(`controller-toolkit.server.ts:996`). P11-23 deliberately attributed *mid-run agent*
comments to the agent; the controller path inherited that rule without meaning to. Why it
matters: ruling 99's whole premise is "guards bind to the human, the audit row discloses
the instrument", and this row discloses only the instrument.

**F32-OC-2 — `read_run_log` asserts `olderExist: false` on an empty page, which is false
whenever the caller overshoots. CONFIRMED (medium-high).**
`app/server/controller/controller-ops-mcp.server.ts:281-313`: `firstSeq`/`lastSeq` are
null for an empty page, so `olderExist` and `newerExist` both compute to `false` and
`next.older` / `next.newer` are both `null`. A model that calls
`read_run_log({runId, since: <past the end>})` — or `before: <at or below minSeq>` — is
told, positively, that no older lines exist and is handed no cursor to page back with,
even though `run.logLines` says the run has thousands. The code comment at `:299-301`
claims `logLines` prevents an empty page reading as "this run logged nothing", but it does
not address `olderExist`. The behavior is pinned as intended by the test at
`controller-ops-mcp.server.test.ts:503-514` (which asserts both `next` cursors are null),
so this is a deliberate shape with a dishonest field rather than an oversight — but the
field still states a falsehood a model has no second source to check.

**F32-OC-3 — the controller settings panel can say "none granted" for skills while every
turn injects `controller-guide`. CONFIRMED (medium).**
`resolveControllerConfig` (`app/server/controller/controller-profile.server.ts:178`) reads
`fm?.resources.skills ?? ["controller-guide"]`, but `resources.skills` is
`z.array(z.string()).default([])` (`app/server/files/agent-profile-file.server.ts:76`), so
the `??` fires **only** when the whole profile is missing — an existing profile with an
empty skills list yields `config.skills === []`. The panel then renders no granted chip at all — literally the words "none granted" on the
locked branch (`controller-admin-panel.tsx:196`) — while `buildControllerSystemPrompt`
(`controller-run.server.ts:633-636`) substitutes `["controller-guide"]` at run time and
the page prints the banner *"The skills and knowledge bases below were attached to the
controller profile by an org admin"* (`:648-652`) for a skill nobody attached. Under a
ruling-108 skills lock the admin cannot even correct it. Reachable only after someone
clears the skills grant while the section is unlocked, so severity is low; the honesty
class (display re-deriving what the runtime decides, §6.8) is the point.

**F32-OC-4 — `resolve_remote_collision` silently does nothing when the resolver has no
`userId`. CONFIRMED-as-latent (medium).**
`app/server/tasks/task-actions.server.ts:6846`: the whole remedy is guarded by
`if (option.kind === "resolve_remote_collision" && actor.userId)`. With a null-`userId`
actor the packet still resolves, `clearPacket` still fires, `task.packet.resolved` is
still audited with `optionKind: "resolve_remote_collision"` — and nothing is closed,
deleted, re-delivered, or noted on the timeline. `archive_task`'s `deleteBranch` arm has
the same shape (`:6651`) but at least still archives. Today the arm's own
`requireAction(…, "approve-transition")` (`:6443`) should refuse a system actor before
this point, so it is unreachable in practice; it is listed because the failure mode is
"the audit says the remedy ran and the remote is untouched", which is the exact class
ruling 17 and F31-6 exist to prevent.

**F32-OC-5 — `viberr_ops` reads leave no audit trail at all. OBSERVATION (medium
confidence that it is intended, flagged as a gap).**
`read_store_doc` (`controller-ops-mcp.server.ts:329`) hands an org admin the full text of
any KB or skill document, and `read_run_log` (`:200`) hands out a run's raw log lines.
Neither writes an audit row on success; only the *denial* path does
(`controller-tool-guards.server.ts:91`). That matches the product's general "reads are not
audited" posture, but these two are the first tools that let a *model* enumerate store
documents and run logs on a person's behalf, and ruling 107 explicitly grounds its
read-only design on "the toolkit is where changes are audited" — which leaves reads with
no record anywhere. Worth an owner decision rather than a fix.

**F32-OC-6 — stale comment: "the Codex plan schema advertised all nine regardless of
policy". CONFIRMED (high, cosmetic).**
`app/server/runtimes/operator-run.server.ts:1573`. `OPERATOR_PLAN_TOOLS` (`:1535`) has
**ten** entries (`flag_context_conflict` was added in pass 25). The paragraph below it
(`:1626-1637`) also duplicates its own delivery rationale twice in consecutive sentences.
Drift in a load-bearing doc comment, no behavioral effect.

**F32-OC-7 — the anti-noise guardrails have no in-app surface at all. OBSERVATION
(high confidence on the fact, low on whether it is a defect).**
`DEFAULT_GUARDRAILS` (`app/shared/workflow/templates.ts:93`) seeds four rows into
`project.md`, `guardrailOn` / `guardrailValue`
(`app/server/tasks/comment-guardrails.server.ts:161`, `:176`) read them per project, and
the PRD lists them as a mitigation for its #1 adoption risk (`design/prd.md:154`, `:188`).
But a repo-wide search for a guardrail control in `app/features` and `app/routes` finds
none — the only way to turn one off or to change `compression-threshold`'s value is to
hand-edit the canonical file. Pass-31's doc described "the settings row" for the
compression threshold; no such row exists in the current tree. Consequence: a project
inheriting the pre-ruling-104 `operator-brevity` row (now inert) has no way to see or
remove it either, and the "per-project guardrail" framing in `decisions.md:1469-1481` and
the PRD promises a knob the product does not expose.

**F32-OC-8 — `saveControllerConfig`'s lock refusal cannot be reached by clearing a
section. OBSERVATION (high confidence, likely intended, undocumented).**
`app/server/controller/controller-profile.server.ts:239`: a locked section refuses only a
**non-empty** input that differs as a set; an empty input always means "keep". That is
what makes the panel's blank-post work, but it also means there is no input a scripted
caller can send that expresses "clear the grants" and gets an honest refusal — clearing is
silently interpreted as keeping. The refusal sentence (`:228`) is never shown for that
intent. `decisions.md:1617-1622` describes the identical-round-trip rule but not the
clear-reads-as-keep consequence.
