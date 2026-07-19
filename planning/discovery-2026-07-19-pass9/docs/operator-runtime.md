# Operator runtime & orchestration — discovery pass 9 (2026-07-19)

Scope: the OPERATOR runtime — dispatch (Claude vs Codex vs scripted), the react
loop, the capability-gated toolkit, triage/set_goal, recommendations, snapshot
building, and stage transitions. Branch `main` @ `61adab1` (post generic-agents).

Primary files:
- `app/server/runtimes/operator-run.server.ts` — dispatch, lease, Codex plan, scripted drive, prompts
- `app/server/tasks/operator-actions.server.ts` — capability-gated mutations (the governance layer)
- `app/server/tasks/operator-toolkit.server.ts` — the in-process MCP tool surface for the Claude operator
- `app/server/tasks/task-actions.server.ts` — auto-invoke, react re-invocation, transitions, recommendations
- `app/server/tasks/specialist-run.server.ts` — `listDeployedSpecialists`, `DeployedSpecialistView`, stage eligibility
- `app/server/runtimes/runtime-registry.server.ts` — backend availability + simulated-runtime fail-closed gate
- `app/server/runtimes/run-recovery.server.ts` — boot recovery of dropped reactions
- `app/shared/workflow/stage-roles.ts` — structural stage-role resolution

---

## 1. Operator lifecycle

### Instantiation (one operator per task, on demand)
There is no long-lived operator process. An operator RUN is fired per trigger by
`runOperator(db, input)` (`operator-run.server.ts:279`). Entry points:

- **create** — `createTask` fires `autoInvokeOperator(...,"create")` fire-and-forget (`task-actions.server.ts:531`).
- **transition** — a NON-operator stage move onto a non-Done stage fires `autoInvokeOperator(...,"transition")` (`task-actions.server.ts:2541/2839/3352`). Operator-authored transitions are excluded to avoid recursion.
- **goal-updated** — a human goal edit fires `autoInvokeOperator(...,"goal-updated")` (`task-actions.server.ts:616`).
- **manual / @operator** — `commentToAgent` routes an `@operator` comment to `runOperator(trigger:"manual", humanComment)` (`task-actions.server.ts:906-915`). RBAC: only admin|maintainer trigger the run; a lower role still gets the comment recorded (`runtimeDenied:true`, no throw).
- **agent-reply (react)** — a finished specialist/reviewer run re-invokes the operator (§ react loop).
- **scheduled** — `schedule.server.ts:295` fires `runOperator(trigger:"manual")` for due schedule rows.
- **boot recovery** — `run-recovery.server.ts:150` re-invokes the operator after an orphan-finalize or a dropped reply callback.

`autoInvokeOperator` (`task-actions.server.ts:631`) is a no-op when the project
has no operator deployment: it calls `resolveOperatorAuthority(...).deployed` and
returns early if false. NOTE: it keys off the PROJECT's operator deployment, not
the task's `operator` frontmatter field (which is `null` while a task sits in
triage — see § triage), so the operator runs at create even though the task-file
`operator` field is null.

### Dispatch: Claude vs Codex vs scripted
`runOperator` resolves authority (backend/autonomy/model) via
`resolveOperatorAuthority` and branches (`operator-run.server.ts:380-404`):

1. **claude + credential present** → `startRealOperatorRun` (`:818`). A REAL
   tool-driven run: the SDK `query` is given `mcpServers` + `allowedTools` from
   `buildOperatorToolkit`; the model calls `mcp__viberr__*` tools in-process, so
   each call mutates the store and the board updates live during the run.
2. **codex + credential present** → `startCodexOperatorRun` (`:522`). Codex has
   no in-process MCP channel, so it runs a STRUCTURED-OUTPUT operator: the model
   emits a JSON decision plan constrained by `OPERATOR_PLAN_SCHEMA`
   (`:444`), which `executeCodexPlan` (`:606`) runs through the SAME
   capability-gated `operator-actions`. Codex operator threads set
   `networkAccessEnabled:false` + `webSearchMode:"disabled"` (`codex-runtime.server.ts:391`).
3. **simulated-runtime permitted (tests only)** → `runScriptedOperatorDrive`
   (`:950`). Deterministic in-code drive that calls the same gated actions and
   streams a scripted narrative. Reachable ONLY inside the R7-2 gate
   (`simulatedRuntimePermitted`, `runtime-registry.server.ts:127`: `NODE_ENV==="test"`
   or `VIBERR_FORCE_SIMULATED_RUNTIME=1 && VIBERR_TEST_RUNTIME_OK=1`). Fail-closed:
   a stray force flag in prod/dev is inert.
4. **no credential, gate closed** → the REAL path runs anyway
   (`operator-run.server.ts:398-400`); `startRun` fails it fast as an honest
   error and the completion hook escalates a blocked recovery packet (F-OP1).
   No fabricated coordination.

Both real and codex return `mode:"real"`; only the scripted drive returns
`mode:"scripted"`.

### Single-flight lease (one operator per task at a time)
A process-level lease + queue (`operator-run.server.ts:148-219`) guards NFR16/B6.
The `agent_runs` row alone under-covers the window (scripted coordinates before
its row exists; codex executes its plan after the row is already `finished`), so
a `Symbol.for("viberr.operatorLease")` global map holds the lease from
`runOperator` entry until coordination truly ends (real: run completion; codex:
plan executed; scripted: drive returned). A trigger arriving while held is QUEUED
(newest wins — `pending` map, one slot) and fired once on release. The
release is idempotent per acquisition token (the lease-entry object), so a
double/stale release can't evict a successor's lease. A cross-boot backstop
(`:320`) coalesces a DB-row-in-flight case via `chainRunCompletion`.

On release with nothing queued, `settleWaitingAfterOperator` (`:232`) flips
`waiting:agent → human` if no run is still live (fire-and-forget, swallows
errors).

### React loop after specialist completions
The "prompt agent → read reply → propose next state change" loop:

1. When the operator prompts an agent (`operatorPromptSpecialist`/`Reviewer` →
   `operatorPromptAgent`, `task-actions.server.ts:2312`), the run is started with
   `opCtx` carrying `ctx.operatorRun = { backend, autonomy, reactDepth }` (set at
   `operator-run.server.ts:355`).
2. `startAgentRun` registers the canonical completion handler and forwards
   `ctx.operatorRun` (`specialist-run.server.ts:889-901`).
3. On completion, `applyAgentCompletionEffects` (`task-actions.server.ts:1919`)
   lands the reply/verdict atomically, reconciles delivery, then decides whether
   to react via `operatorShouldReactToReply` (`:118`).
4. If it should, it re-invokes `runOperator(trigger:"agent-reply", reactDepth+1,
   agentReply:<verbatim reply>)` (`:2247-2262`). The reply is passed DIRECTLY into
   the react prompt so the next directive never depends on the timeline comment
   surviving.

EVERY completion reacts — even a UI/@mention run with no `operatorRun` in ctx
starts a FRESH chain at depth 0 against the deployed operator
(`:2184-2188`).

### Depth cap / anti-runaway guardrails
`OPERATOR_REACT_DEPTH_CAP = 4` (`task-actions.server.ts:108`).
`operatorShouldReactToReply` returns false (no react) when:
- the run did not finish cleanly (`finishedState !== "finished"`), OR
- there is no report text, OR
- **no progress** — the agent repeated its previous reply verbatim (CTL-3 bug), OR
- `reactDepth` is undefined (no active operator run) or `>= 4`.

When react is skipped for **no-progress** or **depth-cap**, it opens a BLOCKED
"stuck loop" recovery packet (`openStuckLoopPacket`, `:1370`) with typed options,
then always flips `waiting` off `agent` via `clearWaitingToHuman` (`:2235`) so the
board never reads "agent working" forever. The chain also stops if no operator is
deployed any longer (`:2243`). Boot recovery has its own crash-loop backstop
(`RECOVERY_REINVOKE_CAP`, `run-recovery.server.ts:120`).

The operator's OWN run does NOT re-invoke itself — `startRealOperatorRun`'s
completion hook only releases the lease and escalates on error (`:868-877`); react
fires only on specialist/reviewer completions. This is what bounds the loop.

---

## 2. Toolkit

Two surfaces run the SAME `operator-actions` layer:
- Claude: MCP tools from `buildOperatorToolkit` (`operator-toolkit.server.ts:71`).
- Codex: plan actions dispatched by `executeCodexPlan` (`operator-run.server.ts:670-791`).

`gate(authority, capabilityId)` (`operator-actions.server.ts:192`) resolves each
capability to `direct | recommend | deny`:
- `direct` mode → **direct**.
- `recommend` mode → **direct** under FULL autonomy, else **recommend** — EXCEPT
  `completion-for-acceptance`, which stays **recommend** even at full autonomy
  (owner ruling Q1: the human-only-Done exception requires an EXPLICIT `direct`).
- `human` / `off` (or absent) → **deny**. A denied capability's tool is not even
  built (`operator-toolkit.server.ts`) — confinement, not just refusal.

| Tool (Claude) / plan action (Codex) | Capability gate | Action class | Action fn |
|---|---|---|---|
| `get_task` | — (always, read-only) | direct read | `operatorSnapshot` |
| `post_comment` | `append-typed-events` | direct | `operatorPostComment` |
| `set_goal` | `append-typed-events` | direct | `operatorSetGoal` |
| `open_decision_packet` | `generate-packets` | direct | `operatorOpenPacket` |
| `resolve_decision_packet` | `generate-packets` | direct | `operatorResolvePacket` |
| `engage_agent` | `assign-primary-specialist` (delivers) / `summon-reviewers` (supporting) | direct **or recommend** | `operatorEngageAgent` |
| `run_agent` | same, by `delivers` | direct **or recommend** | `operatorRunAgent` |
| `prompt_agent` | same, by `delivers` | direct **or recommend** | `operatorPromptAgentGeneric` |
| `transition_stage` | `stage-transitions` | direct **or recommend** (auto/rework bypass) | `operatorTransitionStage` |
| `accept_completion` | `completion-for-acceptance` | recommend (supervised) / **direct only at FULL** | `operatorAcceptCompletion` |

Codex-only extra plan tools + LEGACY ALIASES (`OPERATOR_PLAN_TOOLS`,
`operator-run.server.ts:415`): `assign_specialist/run_specialist/prompt_specialist`
and `assign_reviewer/run_reviewer/prompt_reviewer` — dispatched to the same generic
handlers with `delivers` implied by the name (`:698-760`). These exist for
pre-generic stored plans / model drift.

The operator's confinement in the Claude runtime is a DENYLIST, not the
allowlist: `allowedTools` only auto-approves; `disallowedTools` is the real gate
(`claude-runtime.server.ts:405-420`). `OPERATOR_DENIED_BUILTINS` = Bash/Edit/
MultiEdit/Write/NotebookEdit; `BASE_DENIED_BUILTINS` = Skill + the Task
subagent family. Read/Grep/Glob are NOT denied — so the operator genuinely may
read files/search to inform a decision (consistent with its system prompt),
while it truly cannot write code or spawn ungoverned subagents.

### set_goal at triage
`operatorSetGoal` (`operator-actions.server.ts:829`) closes the triage-gate gap
where the operator could OFFER "accept operator-drafted scope" but had no way to
write the goal. Safety: it fills ONLY an unspecified goal (empty or `DEFAULT_GOAL
= "Goal to be refined at the triage quality gate."`, `task-actions.server.ts:434`);
it REFUSES to overwrite an already-specified goal (`:846-853`) — a real goal
change stays a human `edit_goal` packet. It also fulfils + clears a pending
`awaiting:"goal_edit"` packet, mirroring `updateTaskGoal`. Both turn prompts
(Claude `buildOperatorTurnPrompt:1426`, Codex `buildCodexOperatorPrompt:1326`)
inject a "GOAL IS UNSPECIFIED → set_goal FIRST" step, gated by
`goalIsUnspecified` (`:1294`).

### engage / run / prompt (post generic-agents)
Generic-agents phase 3 collapsed six kind-tools into three
(`operator-actions.server.ts:1271-1389`). `delivers:true` → the delivering
builder (owns branch/PR, at most one per task, gated by
`assign-primary-specialist`); `delivers:false` → a supporting engagement (e.g.
verdict-capable review, gated by `summon-reviewers`).
`resolveDeliversIntent` (`:1303`) resolves an omitted `delivers`: explicit hint
wins; an already-engaged profile keeps its shape; an unengaged profile delivers
iff the task has no deliverer yet.

`prompt_agent` (the primary "hand the task to an agent" action):
`operatorPromptSpecialist` (`:1105`) — if direct: assigns the profile as primary
if it isn't already, best-effort creates the task-key branch
(`ensureTaskBranchBestEffort`, swallows failures, `:1054`), builds a stage-aware
default directive from the task's title+goal when none given (`:1164`), posts an
`@handle …` prompt comment (routed to-agent), and starts the run with that
directive. `operatorPromptReviewer` (`:1191`) is symmetric (engages idempotently,
default "review against the goal" directive). Under `recommend` both post a
recommendation card and stop.

### How the operator SELECTS a profile (traced)
The snapshot DOES carry `desc` + `capabilities` per profile. `operatorSnapshot`
sets `deployedSpecialists` from `listDeployedSpecialists`
(`operator-actions.server.ts:762`), and `DeployedSpecialistView`
(`specialist-run.server.ts:1489`) includes:
- `desc` — the short profile description (`view.desc`), explicitly "WHAT THE
  OPERATOR SELECTS BY" (`:1498`);
- `capabilities.delivery` — any repo-write grant in `direct` mode
  (`execute-code-or-write-repo` / `commit-push-branch` / `create-task-branch`, `:1592`);
- `capabilities.verdict` — EXPLICIT `report-validation-verdict` grant only (`:1600`);
- `capabilities.askHuman` — `ask-human` in direct mode;
- `resources`, `stages`, `spanAll`, plus `eligibleForCurrentStage`
  (`operator-actions.server.ts:762-765`).

Both the `get_task` tool description (`operator-toolkit.server.ts:89`) and the
Codex decision prompt (`operator-run.server.ts:1345-1347`) instruct: select by
`desc` + `capabilities`, "never by guessing from names." So this is genuinely
wired — the model receives the fields it's told to select on.

---

## 3. Recommendations

### Production
Under `recommend` gate resolution, a supervised operator does NOT perform the
action — `addRecommendation` (`operator-actions.server.ts:348`) pushes a structured
`Recommendation` (`kind`, `label`, `detail`, optional `profileId`/`toStageId`)
into `frontmatter.recommendations`, sets `waiting:"human"`, posts a
`**Recommendation:** …` comment, reprojects, audits `task.operator.recommended`,
and — on a NEW rec only — fires an `approval` notification to task watchers
(`:403`). Idempotent per `(kind, profileId, toStageId)` (`:366`).

Recommendation kinds produced: `assign_specialist`, `assign_reviewer`,
`run_specialist`, `run_reviewer`, `transition`, `accept_completion`.

### Applied / cleared
`applyRecommendation` (`task-actions.server.ts:3606`) — a human accepts; it runs
the SAME governed mutation the manual affordance uses (so RBAC + events are
identical), dispatching by `rec.kind` (assign/run via `specialist-run`, transition
via `transitionStage`, `accept_completion` via `acceptCompletion`), then removes
the rec by id. RBAC is enforced inside each mutation (admin|maintainer).
`dismissRecommendation` (`:3705`) removes it without acting (gated by
`resolve-packet`, admin|maintainer). Recs are also auto-cleared as stale:
`transitionStage` drops `transition` recs (`:2803`); `acceptCompletion` /
full-autonomy accept drop `transition`+`accept_completion`
(`:3512`, `operator-actions.server.ts:1599`); specialist/reviewer starts and the
GitHub reconciler prune stale ones too.

### Codex plan enum + scripted fallback
- **Codex structured plan** is the PRIMARY codex path: `OPERATOR_PLAN_SCHEMA`
  (`operator-run.server.ts:444`) constrains the model to `{reasoning, actions[]}`
  where each action's `tool` is one of `OPERATOR_PLAN_TOOLS`. It is re-validated
  at runtime by a Zod strict mirror (`operatorPlanRuntimeSchema:494`) — a
  trust-boundary re-parse, not just schema-constrained. `executeCodexPlan`
  posts `reasoning` as the one turn comment, de-dupes redundant `post_comment`
  actions (`:664-677`), and runs each action through the gated actions; a
  governed-action failure ABORTS the rest of the plan and narrates why
  (`:792-812`). An unparseable/empty plan opens a blocked recovery packet
  (`:622-648`). Codex packets get `defaultPacketOptions` (`:507`) since the flat
  schema can't author rich per-option packets.
- **Scripted fallback** (`runScriptedOperatorDrive`, test-only) picks agents
  CAPABILITY-FIRST: `pickSpecialist` (`:1162`) prefers
  `delivery && !verdict` → `delivery` → role regex `/develop|implement/` →
  non-verdict/non-review → first; `pickReviewer` (`:1181`) prefers `verdict` →
  role regex `/review/` → first. Role heuristics are last-resort tie-breakers
  only (generic-agents D11 — no hardcoded ids).

---

## 4. Triage → ready → impl → review → done

Stages are per-project and freely renamed; nothing hard-codes literal ids. The
four structural roles resolve from the workflow GRAPH via `resolveStageRoles`
(`stage-roles.ts:33`): `entry` = first stage, `terminal` = last (human-only
Done), `review` = the stage with an edge INTO terminal, `work` = the stage with
an edge into review. The snapshot exposes `doneStageId`/`reviewStageId`/
`workStageId` (`operator-actions.server.ts:759-761`), so custom/lightweight boards
classify correctly (not positionally).

### Boundary types
`BOUNDARY_VALUES = ["auto","approval","human"]` plus a separate `locked:boolean`
flag (`project-file.schema.ts:34-63`; review→done is locked). `transitionStage`
(`task-actions.server.ts:2625`) enforces per boundary:
- `auto` → any project member (or, for the operator, crossed directly even when
  `stage-transitions` is `recommend`, so a pre-work stage doesn't strand on a
  recommendation nobody needs to approve — `operator-actions.server.ts:1415`).
- `approval` → admin|maintainer (`approve-transition`).
- `human` → acceptance authority (admin|maintainer, or the task owner R6-2).

### Operator's role per stage
- **triage → ready** (pre-work): the operator advances via `transition_stage`;
  the coordinate loop only advances pre-work stages, then STOPS to prompt at the
  work stage. If the goal is unspecified it must `set_goal` (or open an
  `edit_goal` packet) first.
- **impl (work stage)**: the operator `prompt_agent(delivers:true)` — assign +
  prompt + run the delivering builder, then STOP and wait for the react.
- **impl → review**: on the delivering agent's reply, the react turn proposes a
  `transition_stage` toward review (or recommends it under supervised). Entering
  the review stage resets stale validation to `changed` and opens a PR
  (best-effort, FR31).
- **review**: `prompt_agent(delivers:false)` — engage + prompt + run a
  verdict-capable reviewer. Its verdict gates acceptance.
- **review → done**: ONLY via `accept_completion` (`operatorAcceptCompletion`,
  `:1504`). This is the single deliberate exception to human-only-Done: performed
  directly ONLY under FULL autonomy AND explicit `completion-for-acceptance:direct`;
  otherwise it posts an "accept completion → Done" recommendation card. Guards:
  refuses if `validation==="failing"` (`:1529`) or an open BLOCKED packet
  (`:1543`). A full-autonomy accept records the PR as `accepted` (merge pending) —
  never a false "merged", since a real merge needs a human identity.

### Operator rework routing (R7-4)
A BACKWARD move to an earlier stage on a task whose latest review is `failing` is
an off-graph transition the operator performs DIRECTLY (no human, no
recommendation) — `isReworkMove` (`operator-actions.server.ts:1458`) +
`transitionStage`'s vet (`task-actions.server.ts:2674`), so a failed review
re-drives itself back to the developer.

### Gated to humans
- Reaching the terminal/Done stage: the operator is forbidden a bare transition
  into `lastStageId` (`task-actions.server.ts:2713`); only `accept_completion`
  reaches Done, and only under full autonomy.
- Applying/dismissing recommendations and resolving packets: admin|maintainer.
- Any `human`-boundary or manual off-graph board move: admin|maintainer.

---

## 5. Snapshot / context

`operatorSnapshot` (`operator-actions.server.ts:699`) — the read-only `get_task`
payload — contains: `key`, `title`, `goal`, `stage`/`stageName`, `readiness`,
`waiting`, `owner` (resolved name), `specialist` (the delivering engagement) +
`reviewers` (supporting engagements), `nextStages` (id/name/boundary),
`stageIds`, `doneStageId`/`reviewStageId`/`workStageId`, `deployedSpecialists`
(full `DeployedSpecialistView` + `eligibleForCurrentStage`), `openPacket` +
`packet` CONTENT (type/title/body/options — so the operator can judge a packet
moot), `recentTimeline` (last 6 events, each capped at 1500 chars so six entries
can't balloon the prompt, `:783`), `autonomy`, and `policy` (capabilityId→mode).

- **Claude**: `get_task` returns the snapshot JSON on demand; the system prompt
  is persona + declared skills + declared KB (global `KB_INJECTION_BUDGET`
  shared across all KBs) + a live "Your authority" block listing the policy and
  rules (`buildOperatorSystemPrompt:1237`). Persona = shipped
  `agents/definitions/operator.md` body, or `FALLBACK_OPERATOR_DEFINITION`
  (`:1201`) when absent (the file ships in `data/` and `docker-data/`).
- **Codex**: the whole snapshot is embedded as JSON in the turn prompt
  (`buildCodexOperatorPrompt:1299`), persona/skills via `developer_instructions`
  (`codex-runtime.server.ts:140`). The react prompt embeds the finished agent's
  report verbatim (first 4,000 chars) so directives can quote concrete findings.

Verdict on the prior "operator generates no packets" finding: RESOLVED. Packets
are genuinely produced from real agent work through `operatorOpenPacket`
(`:459`) on multiple live paths: (a) the Claude operator's `open_decision_packet`
tool, (b) `executeCodexPlan`'s `open_packet` action, (c) the no-plan/failed-run
escalations (`escalateFailedOperatorRun:894`, codex no-plan `:622`), and (d) the
completion-effects `openStuckLoopPacket` on a failed/stuck/depth-capped agent run
(`task-actions.server.ts:1370`, `2115`, `2220`). Each writes a real resolvable
FR26 packet with typed options + a watcher notification.

---

## Mocks / gaps / bugs

- **[POOR] Legacy `operatorSchedulesOnOwner` inline stand-in.**
  `task-actions.server.ts:2409` + `:2496`. Fires only when the newest operator
  timeline event text starts with `"**Quality gate:**"`, which is produced ONLY
  by seed/demo data (`demo-data.server.ts:560`) — the real operator runtime never
  emits it. So on real tasks this branch is dead. When it does fire (seeded
  tasks), it writes a HARDCODED synthetic operator `agent` narration event
  ("scheduling execution against the quality-gated scope") and flips
  `readiness/waiting`, then re-invokes the real operator. Its own comment still
  calls it "a documented stand-in until the Phase-8 operator runtime owns the
  reaction" — stale, since Phase 8 shipped. Risk: confusing dead/seed-coupled
  code path in the ownership flow; a fabricated operator narration on seeded
  boards.

- **[POOR] Stale doc comment on `transitionStage`.** `task-actions.server.ts:2620-2621`
  says human boundaries are enforced "by construction" and "agent-triggered
  transitions get capability-checked in Phase 8." Phase 8 is done —
  `operatorTransitionStage` gates via the `stage-transitions` capability today.
  The comment misdescribes current enforcement. Risk: misleads a reader/planner.

- **[POOR] `run_agent` is redundant and can start a silent, prompt-less run.**
  `operator-toolkit.server.ts:259` / `operatorRunAgent` (`operator-actions.server.ts:1325`).
  It starts a run for an engaged agent with NO directive, contradicting the
  design principle "trigger WITH a prompt, not silently" that `prompt_agent`
  enforces. With `delivers:true` and NO deliverer engaged,
  `resolveDeliversIntent` still returns true → `operatorRunSpecialist` →
  `startAgentRun` with no profileId, which will fail if nothing is engaged. Low
  risk (prompt_agent is the primary path) but the tool is an easy foot-gun.

- **[POOR] Codex plan `text` field is heavily overloaded across tools.**
  `operator-run.server.ts:467` — one flat `text` property carries the comment
  body, the agent prompt, the packet title, AND the drafted goal
  (`set_goal` reads `a.text` as the goal at `:783`). Model drift that misplaces
  `text` vs `reason` silently mis-routes content (e.g. a goal into a comment).
  Works under strict structured output, but fragile.

- **[POOR] Codex duplicate-comment suppression is a symptom workaround.**
  `operator-run.server.ts:664-677`. The code de-dupes because Codex "often ALSO
  emits redundant `post_comment` actions repeating [reasoning] almost verbatim
  (observed live: three near-identical comments in one turn)." Indicates weak
  control over the Codex operator's output; the guard hides the noise rather than
  fixing the plan quality.

- **[POOR] Task `operator` frontmatter field is decoupled from actual operator
  activity.** `task-actions.server.ts:492-495` sets `operator:null` while a task
  is in the entry (triage) stage; it's only set to `{assignedAtStageId}` on
  leaving triage (`:2762`). Yet `autoInvokeOperator` runs the operator at CREATE
  (keying off the project deployment, not this field). So a task can have an
  operator actively coordinating it while `frontmatter.operator === null`. Any
  consumer reading that field as "is an operator on this task?" is wrong during
  triage.

- **[POOR] Silent GitHub branch-creation failure in the hand-off.**
  `ensureTaskBranchBestEffort` (`operator-actions.server.ts:1054`) swallows all
  errors with no timeline note. Intended (coordination proceeds without a
  branch), but a misconfigured PAT/repo yields a specialist working with no
  task-key branch and zero operator-visible signal until delivery reconcile
  later fails. `settleWaitingAfterOperator` (`operator-run.server.ts:232`) and the
  delivery reconcile (`task-actions.server.ts:2170`) similarly swallow — acceptable
  but worth noting the operator surfaces nothing at hand-off time.

- **[Note, not a bug] Scripted operator drive is test-only.**
  `runScriptedOperatorDrive` (`operator-run.server.ts:950`) and its
  `pickSpecialist`/`pickReviewer` capability heuristics run ONLY inside the R7-2
  fail-closed gate (`simulatedRuntimePermitted`). In prod/dev with no credential,
  the REAL path runs and fails-fast + escalates — no fabricated coordination.
  Confirmed honest; flagging so planners don't mistake it for a live path.

- **[Note, verified good] Packet generation is REAL (prior finding resolved).**
  The pass-1 (2026-07-09) "operator generates no packets" finding no longer holds
  — see § 5. Multiple live paths write real FR26 packets from actual agent work
  and failures. No stubbed packet path found.
