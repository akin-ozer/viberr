# The Operator subsystem — reference

Audience: engineers/agents implementing against or modifying the operator, with no prior context.
Every non-obvious claim below is cited `file:line` against `pass26-fixes` (≈ `origin/main`). Read the
cited code, not just this summary, before changing it.

**Core files:**
- `app/server/runtimes/operator-run.server.ts` (3,344 lines) — lifecycle, lease/queue, workspace,
  system+turn prompt construction, Codex plan schema + executor.
- `app/server/tasks/operator-actions.server.ts` (2,945 lines) — authority resolution, the
  `OperatorTaskSnapshot`, every capability-gated mutation (`operatorX`), acceptance.
- `app/server/tasks/operator-toolkit.server.ts` (727 lines) — the Claude in-process MCP tool
  surface (`buildOperatorToolkit`), wrapping the same `operatorX` functions.
- `app/server/tasks/operator-repo-read.server.ts` — the anchored default-branch read tool.
- `app/server/github/update-branch-operator.server.ts` — the `update_branch_from_base` capability.

**Naming note:** `operator-prompt-mention.server.ts` and `operator-kb-injection.server.ts` (named in
the task brief) are **test-only** files that exercise functions living in `operator-run.server.ts`
(`buildOperatorSystemPrompt`, `buildOperatorTurnPrompt`, `buildCodexOperatorPrompt`,
`authoredPacketOptions`). The KB-body loader itself is a shared leaf module,
`app/server/files/kb-injection.server.ts`, used by both operator and specialist runtimes.

---

## 1. Lifecycle

### Triggers

`RunOperatorInput.trigger` (`operator-run.server.ts:160-169`): `create | transition | agent-reply |
goal-updated | pr-diverged | delivered | packet-resolved | scheduled | manual`.

| trigger | fired from |
|---|---|
| `create` | `createTask` (`task-actions.server.ts:433`) → `autoInvokeOperator` at `:532` |
| `goal-updated` | `updateTaskGoal` (`:542`) → `:611` |
| `transition` | `transitionStage` (`:3940`) → `:4249`; carries `transitionFromName/ToName/ByHuman` |
| `delivered` | `performDelivery` (`:4449`) → `:4784`, fires after a full-autonomy delivery (R18-2) |
| `packet-resolved` | `resolvePacket` (`:5519`) → `:6123`; carries `resolvedOption {kind,title,note}` |
| `pr-diverged` | `github-reconciler.server.ts:751-757` — out-of-band PR close/merge/reopen |
| `agent-reply` | `applyAgentCompletionEffects` (`task-actions.server.ts:2882`) → `:3452-3468` |
| `scheduled` | `schedule.server.ts:456-481`; carries `scheduleNote` |
| `manual` | (a) `project.task.tsx:920-965` "Run operator" button (RBAC `run-agents`); (b) `commentToAgent` (`:1250`) → `:1364-1366` for `@operator …`; (c) `run-recovery.server.ts:152-156` boot re-invoke, capped `RECOVERY_REINVOKE_CAP=3` (`:19`) |

`agent-reply` is the **react loop**: when a specialist/reviewer the operator prompted finishes, its
full reply rides as `agentReply` (not the timeline comment — see §2) and the operator proposes the next
move instead of re-prompting, gated by `operatorShouldReactToReply` (`task-actions.server.ts:189-199`:
must have finished cleanly, reply must differ from the previous one, `reactDepth <
OPERATOR_REACT_DEPTH_CAP=4` at `:167`). A repeated-verbatim reply or a depth-capped chain opens a
stuck-loop packet instead of looping forever.

Two refusals are returned, not thrown (`RunOperatorResult.refused`, `:224-237`, checked at
`:1166-1220`): **`"terminal-stage"`** (`scheduled` only — FR39/F19-20, re-checked at fire time, not
just claim time) and **`"open-packet"`** (`manual` only — R20-1/F20-5: a human pressing "Run operator"
while a decision packet is open is refused outright rather than burning turns doing nothing).

### Authority: backend, model, autonomy

`resolveOperatorAuthority` (`operator-actions.server.ts:353-443`) reads the project's `agents:`
deployment with `kind === "operator"`. No deployment ⇒ `deployed: false`, empty policy, autonomy
forced `supervised` — `gate()` then denies everything (A4, `:452`).

- **Backend**: `overrides.backend ?? deploymentBackend(view)` — `codex` if declared, else `claude`
  (`:302-306`, one function shared with the UI's backend-picker default).
- **Model**: `resolveRunModel` when the run backend matches the declared one, else `defaultModelFor`
  (`:415-418`) — avoids handing Codex a Claude model id on an overridden backend.
- **Autonomy (R19-A)**: the deployment's configured autonomy is a **ceiling**, never a pin —
  `clampAutonomy` (`:227-236`) returns the lesser of requested/ceiling. A bite is audited as
  `task.operator.autonomy_clamped` (`:197`) **only when `overrides.db` is supplied**, i.e. only on a
  run path — pure reads (review page, acceptance-authority probe) stay silent.

### Workspace

The operator's repo view is the **same checkout** the delivering specialist uses:
`<taskDir>/workspace/<repoName>` (`operator-run.server.ts:942-965`). `ensureOperatorRepoCheckout`
(`:1026-1095`) never touches an **existing** checkout (re-stripping mid-run is the F19-15 hazard); a
fresh clone goes through the project's mirror cache and never throws — failure degrades to
`{kind:"unavailable", sentence}` so a clone failure makes the run "blind," never stranded. Because the
checkout is shared, once the deliverer commits it stands on the **task branch**, not the default branch
(F21-21) — the prompt and the dedicated `read_default_branch_file` tool exist specifically to stop the
operator reading its own deliverer's commit and calling it an out-of-band merge (live case VIB-7).

Writable-root posture differs by backend (pass-24 B-1): **Claude**'s cwd is the task folder, with
`Bash/Edit/MultiEdit/Write/NotebookEdit` removed from context via `OPERATOR_READ_ONLY_DENIED_TOOLS`
(`claude-runtime.server.ts:200-208`, applied for `kind:"operator"` at `:778`) — a deny list, not a
prompt instruction. **Codex** has no such deny channel (`workspace-write`, network off), so its cwd is
a separate empty scratch folder, `<taskDir>/.operator-scratch` (`:983-990`), a *sibling* of `task.md`
so the store and checkout stay readable but outside the one writable root. Web egress is denied on both
when `use-web-search-fetch` is withheld (`:1120-1128`).

### Single-flight lease + trigger queue

One drive per task, enforced by a process-global lease map (`:281-351`, survives Vite HMR). A trigger
arriving mid-drive is **queued, never dropped**: machine triggers coalesce newest-wins
(`queueOperatorTrigger`, `:382-417`); a human `@operator …` comment queues FIFO, capped at
`MAX_PENDING_HUMAN_TRIGGERS=8` (`:369`, oldest dropped past the cap with a best-effort timeline note,
`:426-463`); consecutive comments from the same author merge into one turn. `releaseOperatorLease`
(`:495-525`) is idempotent per acquisition token, so a stale release can never evict a successor's
lease or double-fire the queue. A **cross-boot backstop**: a DB row left `queued`/`running` by a dead
process (`created_at < PROCESS_START_MS`, `:247-278`) is finalized `error`/`restart` before the new
trigger drives, rather than queuing behind a completion callback that will never fire.

### Dispatch

`runOperator` (`:1130-1378`) resolves authority + workspace once, then branches to
`startCodexOperatorRun` (`:1717-1837`, structured plan) or `startRealOperatorRun` (`:2344-2470`, live
MCP calls). Both reserve a run row before a slow clone (`reserveRun`, R21-4) so the task page shows
something during a multi-minute first clone — **this reservation now correctly counts against the
run-concurrency cap** (`liveCount = handles.size + reserved.size`, `run-service.server.ts:1236-1238`;
F26-1, this pass — previously a reservation bypassed `admitRun` entirely).

---

## 2. What the operator SEES

### The snapshot

`OperatorTaskSnapshot` (`operator-actions.server.ts:1197-1362`), built by `operatorSnapshot()`
(`:1505-1670`), is the **one** payload both backends read: Claude's `get_task` tool returns it verbatim
(`operator-toolkit.server.ts:262-277`); Codex gets it JSON-embedded in the prompt
(`buildCodexOperatorPrompt`, `operator-run.server.ts:3296-3299`).

**Included:**
- `key, title, goal`.
- **`priority, labels, dueDate`** — `fm.priority/labels/dueDate` verbatim (`:1544-1546`). **R26-1**:
  advisory triage metadata added specifically for the operator (not the delivering/reviewing agents).
- `stage, stageName, readiness, waiting`; `owner` as **display name only** (never id/email, `:1533-1537`).
- `specialist`/`reviewers[]` — `profileId, role, backend` only.
- `nextStages[], stageIds[], doneStageId, reviewStageId, workStageId` — graph-derived via
  `resolveStageRoles`, not positional.
- `deployedSpecialists[]` + `eligibleForCurrentStage` + `capabilities.web` — the last is a
  specialist's *own* resolved web grant, added after a live bug (F21-16, VIB-5) where the operator
  quoted its own withheld web-egress row as proof a specialist's grant "didn't take effect."
- `openPacket` + `packet` — type/title/body/**option titles only**, no `kind`/backend/profileId.
- `recentTimeline` — **last 6 timeline events only** (`:1595-1605`), any type, text capped at 1,500
  chars. Not a comment feed — a short rolling window over the whole typed-event stream.
- `recommendations.pending[]` (≤5, label capped 160 chars) and `.declined[]` (≤5, read from
  `task.recommendation.dismissed` **audit rows**, bounded by 90-day retention, `:1408-1446`).
- `pr` — `number/state/title` + `revisionDrift {aheadBy, headSha}` only when `aheadBy > 0` (F21-17).
- `branch`, `repo`, `noChanges` (R19-8's "nothing to deliver" shape).
- `liveRuns[]` — **only** `agent_runs` rows in `state IN ('queued','running')`. Documented as "the ONLY
  truth a run is in flight" (`:1328-1333`) — `waiting` and a directive comment are not proof.
- `autonomy` (this run's clamped level); `operatorPolicy {scope:"operator", note, capabilities}` — the
  operator's **own** grants, explicitly labelled after the same F21-16 misread bug.

**Excluded** (checked against the full `TaskFrontmatter` schema, `app/schemas/task-file.schema.ts:
562-634`, vs. the snapshot interface):
- **`validation`/`verdicts[]`** — no structured review-verdict field exists on the snapshot at all;
  whatever the operator infers about a review's pass/fail has to come from `recentTimeline` prose.
- `workRevision`, `schedules[]`, `acceptance:"forced"`, `github` cache, `createdAt/updatedAt`,
  `boardRank`, `urgent` (redundant with `priority`).
- Full comment history (only last 6 events); agent run **logs/transcripts** (`liveRuns` is state-only —
  the one exception is `agent-reply`'s `agentReply` field, full text capped at 4,000 chars,
  `agentReportBlock` `:3001-3006`, a prompt-only injection for that one trigger, not part of the
  reusable snapshot).

### System prompt

`buildOperatorSystemPrompt` (`:2765-2973`), assembled additively: shipped `operator.md` persona +
optional project persona **appended** (never replacing, `:2787-2793`) → declared skills/KBs framed as
"trusted, not injection" (`:2846-2856`) → actual backend/model + **actually-mounted** MCP names, never
the grant list (`:2867-2879`) → workspace section (§1, `:2678-2762`) → MCP-governance + unresolved/
unhealthy disclosure → missing-resource disclosure (`:2932-2942`) → `# Live authority` (autonomy + full
policy map, `:2949-2957`) → **`# Triage signals (advisory)`**, R26-1, verbatim:

> "…Let a `high`/`urgent` priority or a near/overdue `dueDate` inform how you sequence work and how you
> word what you recommend to a human … They change no gate and grant no authority: never treat them as
> a human decision or a reason to skip a boundary." (`:2961-2964`)

→ `# Non-negotiable rules`, appended **unconditionally** regardless of custom persona (`:2967-2971`).

### Turn instruction

`operatorTurnDoctrine` (`:3103-3267`), wrapped by `operatorTurnInstruction` which always appends the
capability-gap remedy paragraph (ruling 85 — name the Agents-page fix, not just workarounds,
`:3031-3038`). Notable: a direct `@operator` address short-circuits to "respond to exactly this"
(`:3112-3130`); `pr-diverged` carries the F21-17 drift fact as a **required** packet observation
(`:3086-3100`); `triageQualityGate` (`:3050-3072`) fires only at the entry stage and blocks
`transition_stage` until the goal is judged "concrete." Claude gets a short text prompt pointing at
`get_task` (`:3319-3344`); Codex gets the full JSON snapshot inline plus "select by id, never by name"
(`:3286-3316`).

---

## 3. What the operator can DO

### Claude — live tool calls

`buildOperatorToolkit` (`operator-toolkit.server.ts:243-727`) builds an in-process MCP server. A
withheld capability means **the tool is never built** — not refused at call time, absent entirely:

| tool | gate |
|---|---|
| `get_task` | always (read-only) |
| `read_default_branch_file` | only when a checkout exists (`:288-332`) |
| `post_comment`, `set_goal`, `flag_context_conflict` | `append-typed-events` (`:343-410`) |
| `open_decision_packet`, `resolve_decision_packet` | `generate-packets` (`:412-533`) |
| `engage_agent`, `run_agent`, `prompt_agent` | `assign-primary-specialist` OR `summon-reviewers` (`:537-613`) |
| `deliver_for_review` | `deliverGate()`, absent-means-**granted** (`:618-639`) |
| `update_branch_from_base` | `updateBranchGate()`, falls back to `deliverGate` (`:644-657`) |
| `transition_stage` | `stage-transitions` (`:659-678`) |
| `accept_completion` | `completion-for-acceptance`; withheld ⇒ absent even at full autonomy (`:684-695`) |

`allowedTools` auto-approves these `mcp__viberr__*` names — **not** the security boundary
(`bypassPermissions` removes nothing from context). The real fence is the built-in-tool deny list plus
never building a repo-write tool at all (`:53-60`).

### Codex — structured plan, executed server-side

One JSON object `{reasoning, actions[]}` (`buildOperatorPlanSchema`, `operator-run.server.ts:
1499-1572`) over `OPERATOR_PLAN_TOOLS` (`:1396-1426`, the same 12 actions as Claude, minus
`get_task`/`read_default_branch_file`, plus `resolve_packet`). `operatorPlanToolsFor` (`:1466-1497`)
filters to what policy grants; when nothing is granted it falls back to the full list minus delivery
actions (a JSON-Schema `enum` cannot be empty; this way refusals are narrated instead of an empty
option set). `executeCodexPlan` (`:1921-2214`) runs each action **in order** through the same gated
`operatorX` functions Claude's tools call. A thrown error **aborts the remaining plan**
(`:2191-2211`) — already-applied actions are **not** rolled back. Every denied/noop result is narrated
afterward, split into "refused by policy" vs. "did not apply to current state" (`narrateRefusedActions`,
`:2242-2299`) — misblame class LV-03: a state conflict reported as a policy refusal falsely accuses the
project's governance. A no-plan/unparseable turn escalates to a blocked packet, or a bare note if
`generate-packets` is itself withheld (`:1947-1987`).

### Direct vs. recommend vs. deny

`gate(authority, capabilityId)` (`operator-actions.server.ts:446-465`): `off`/`human` ⇒ `deny`;
`direct` ⇒ `direct`; `recommend` ⇒ `recommend`, **promoted to `direct` under full autonomy** — except
`completion-for-acceptance`, which stays `recommend` at full autonomy unless *explicitly* `direct`
(owner ruling Q1). Two capabilities use **absent-means-granted** polarity, since they postdate most
deployments: `deliverGate` (`deliver-review-pr`, `:476-502`) and `updateBranchGate` (falls back to
`deliverGate`, `update-branch-operator.server.ts:76-82`) — both still hard-deny an **undeployed**
operator (A4), so an empty policy map can't push branches by accident.

Every action returns `OperatorActionResult {outcome: done|recommended|denied|noop, message}`
(`:161-177`): `denied` = authority refusal, `noop` = the task's **state** ruled it out — this split is
what keeps refusal narration from blaming a project's policy for something it never blocked.

---

## 4. Acceptance & completion

The human-only-Done invariant has one exception: `operatorAcceptCompletion`
(`operator-actions.server.ts:2776-2945`) performs the move itself **only** when `autonomy === "full"`
**and** `gate(…, "completion-for-acceptance") === "direct"` (`:2837`). Everything else — supervised, or
`recommend` even under full autonomy — posts a recommendation card and performs nothing (`:2827-2872`).

- `completionCapabilityRefusal` (`:2750-2767`) runs **first**: a withheld grant is a hard, out-loud
  refusal, no card, no audit row. R19-6: this used to sit inside the direct/recommend branch, so a
  withheld grant fell into "recommend" and produced a real card anyway.
- **F19-26 reroute**: a `recommend`-gated `transition_stage` whose target **is** the terminal stage
  redirects to `operatorAcceptCompletion` (`:2611-2635, 2587-2658`) instead of filing a plain "move to
  Done" card whose Apply would perform a real PR merge under a label that never says "accept."
- **One shared refusal gate** for humans and the operator: `acceptanceRefusalReason`
  (`task-actions.server.ts:6554-6594`) — archived → closed-PR (R16-3, a terminal GitHub fact outranks
  every process gate) → stage position → required-reviewer verdicts (F10-15) → no-change work-refusal →
  `verdictGateReason` (R15-1; R19-B lets a human's GitHub approval satisfy it) → open-blocked-packet →
  conflicting PR. The operator reaches it via `acceptanceRefusalFor` (`:6837-6859`, called at
  `operator-actions.server.ts:2820-2825`) — explicitly "ONE shared gate," replacing drifted per-surface
  copies.
- **"Completed — no changes" (R19-8)**: `noChangeApplies` is only the candidate test; acceptance
  re-verifies **live** at accept time and **fails closed** — a stale flag never rides a branch that has
  since gained commits into Done. The operator's full-autonomy path calls the same live check
  (`:2886-2892`) with no force override of its own.
- **The Done-write**: `applyAcceptanceWrite` (`task-actions.server.ts:7178-…`) is the one shared writer
  for every path. Inside the write lock: already-Done idempotent bail (U3 — prevents a double-accept
  race; the operator reports "already Done" rather than crediting itself with someone else's move,
  `operator-actions.server.ts:2932-2934`), re-verified head/no-change/disclosure, and a re-run of
  `acceptanceRefusalReason` unless this is a **human-only** force-accept (which still cannot bypass a
  closed PR, R19-5/F19-25 — the operator has no force equivalent).
- The operator never claims a false "merged": full-autonomy acceptance records the PR "accepted, merge
  pending" (`:2874-2877`) — a real merge needs a human GitHub identity.

---

## 5. Recommendation/packet application

A `recommend`-gated action calls `addRecommendation` (`operator-actions.server.ts:699-783`): appends a
`Recommendation` to `fm.recommendations` (deduped on kind+profileId+toStageId), sets
`waiting:"human"`, and notifies watchers **only on a genuinely new** card (a re-issued identical one
does not re-ping).

**Applying is authorizing (FR37/R15-3)**: `applyRecommendation` (`task-actions.server.ts:7866-8055`)
lets the task **owner** apply any operator recommendation on their own task without the underlying RBAC
tier (e.g. `run-agents`) — the Apply click substitutes for it, executing as `OPERATOR_TASK_ACTOR`/
`operatorAuthorized:true` ("coordination machinery," `asCoordination()`, `:7932-7937`). A `transition`
card targeting an off-graph stage applies with `manual:true`; one targeting the terminal stage carries
the ruling-88 acceptance-disclosure ack (`:7996-8001`). Applied cards are removed from
`fm.recommendations` and audited as `task.recommendation.applied`.

**Dismissal is the durable "no"**: `dismissRecommendation` (`:8077-8159`) removes the card and writes a
typed timeline event titled `"Recommendation declined"` directly on `task.md` — this is what
`operatorSnapshot.recommendations.declined` re-reads next run (via the `task.recommendation.dismissed`
audit action, `operator-actions.server.ts:1408-1446`), specifically to stop a supervised loop from
spinning (propose → decline → re-propose).

**Withdrawal**: `operatorResolvePacket` (`:1057-1138`), gated `generate-packets`, enforces **B3** (one
open packet at a time, re-checked *inside* the write lock at `:982-985` so a racing writer can't
silently replace a packet mid-answer) and **B2** (the operator may withdraw only a packet **it** raised
— `packet.from !== "operator" || packet.askedBy` refuses, `:1083-1090`; only a human resolves an
agent's own question). The `pr-diverged` doctrine explicitly tells the model to call this when a closed
PR reopens (`operator-run.server.ts:3184-3188`) — nothing withdraws it automatically.

---

## 6. Known-subtle areas / bug-hunt targets

1. **R26-1 has zero test coverage — verified by direct search.** `"Triage signals (advisory)"`
   (`operator-run.server.ts:2962`) appears in no `.test.ts` file; `operatorSnapshot`'s
   `priority`/`labels`/`dueDate` (`operator-actions.server.ts:1544-1546`) are only asserted at their
   default values. This pass's own `NOTES.md` independently flags the same gap as untested live. A
   regression dropping these fields from the snapshot or prompt would pass the full suite.

2. **`update-task-branch: recommend` is a dead-end refusal, not a card** — unlike every other
   `recommend`-gated capability. `operatorUpdateBranchFromBase` (`update-branch-operator.server.ts:
   175-184`) returns `denied` and tells the operator to open its own packet instead of filing an
   applyable recommendation. Deliberate per the comment, but an asymmetry easy to assume is uniform.

3. **The stranded-resume safety net can go permanently dark for one drive with only a log line.**
   `readStageAtStart` (`operator-run.server.ts:864-889`) returns `null` on any read failure at drive
   start; `maybeResumeStrandedOperator` treats `null` as "disabled for this whole drive" (`:669-675`).
   A task that then dead-ends at an `auto` stage with no packet has nothing resume it.

4. **The stranded-resume vs. transition-re-trigger race is mitigated, not eliminated.**
   `maybeResumeStrandedOperator` (`:646-789`) guards via `stage !== stageAtStart`, but the comment at
   `:701-707` documents a **live occurrence** of double-driving from this exact race — the re-trigger is
   fire-and-forget async with no synchronization point the guard can wait on.

5. **A partially-executed Codex plan is not transactional.** `executeCodexPlan` aborts the remaining
   plan on a thrown step (`:2191-2211`) but does not undo already-applied steps — e.g. a transition then
   a failed `accept_completion` leaves the task moved-but-not-accepted. Every new plan-tool must itself
   tolerate being the last action to run in an otherwise-applied plan; there is no rollback to lean on.

6. **A stale `run_agent(profileId=X)` step silently no-ops instead of adapting.**
   `operatorRunAgent` (`operator-actions.server.ts:2369-2422`) refuses as a `noop` (P11-22
   single-deliverer invariant) when a plan names a profile that is no longer the current deliverer,
   rather than re-targeting — easy to miss in a longer refusal list, and compounds with #5.

7. **The human-comment overflow-drop path is itself best-effort.** Past `MAX_PENDING_HUMAN_TRIGGERS=8`
   the oldest queued `@operator` comment is dropped and `noteDroppedOperatorTurn` records it
   (`operator-run.server.ts:401-463`) — but that note-writer only logs on its own failure. An 8-message
   backlog plus a note-write failure leaves a dropped human question with zero server-side trace,
   contradicting the module's stated "never silently drop" guarantee.

8. **`operatorAuthorized`/`ctx.operatorRun` are trust-sensitive fields enforced only by a comment.**
   `TaskMutationContext.operatorAuthorized` (`app/server/tasks/task-mutation.server.ts:50-65`) skips
   human RBAC and is set via `opCtx()` roughly 7+ times across `server/tasks/*.ts`
   (`operator-actions.server.ts:527-529`). The interface comment says "routes must never set this" —
   currently true (verified by grep across `app/routes`, `app/features`), but nothing but that comment
   stops a future handler from copy-pasting the spread and silently bypassing RBAC.

9. **The snapshot has no structured review-verdict field.** `validation`/`verdicts[]` exist on
   `TaskFrontmatter` (`app/schemas/task-file.schema.ts:595,599`) but not on `OperatorTaskSnapshot`
   (`operator-actions.server.ts:1197-1362`). The turn doctrine's "if review requests changes…" language
   assumes the operator can tell — in practice it has to infer that from 6 capped `recentTimeline`
   entries, not a boolean.

10. **The two-tier "don't re-propose a decline" memory has a compounding-expiry gap.** The durable
    record is a `task.md` timeline event; the snapshot-visible record is a 90-day-bounded audit read
    (`declinedRecommendations`, `:1408-1446`) *and* the timeline copy is capped to the last 6 events. A
    task revived after both caps lapse shows no signal a recommendation was ever declined. Intentional
    two-tier design (`:1399-1406`); the compounding case does not appear tested.

11. **(Context, not new risk) F26-1 directly touches the operator's own clone-reservation path** — worth
    re-verifying whenever `reserveRun`/`admitRun` change. `runOperator` calls `reserveRun` for its own
    workspace clone (`:1336-1358`); it is now uniformly gated (`run-service.server.ts:1236-1238`) and a
    parallel pass-27 live pass independently marked it sound. Flagged only because it is the newest,
    least-baked code in the path this document describes.
