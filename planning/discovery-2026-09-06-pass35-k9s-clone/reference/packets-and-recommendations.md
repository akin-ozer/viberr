# Decision packets, recommendations, force-accept: code-verified reference

Pass 35 (k9s-clone observation), written 2026-09-06 against branch `pass35/k9s-clone-observation`.
Every claim below carries "verified in file:line" or a "docs claim, code disagrees" flag. Line
numbers are from this branch's tree. Docs consulted: `docs/domain/operator.md` §6,
`docs/domain/task-lifecycle.md` §9, `docs/architecture/file-formats.md` "Packet",
`docs/ui/surfaces.md` §4, `docs/architecture/decisions.md` rulings 7, 17, 20, 37, 59, 76, 77,
84, 85, 115, 123, 124, 130, 131, 136, 137, 138, 141, 147.

Abbreviations: OA = `app/server/tasks/operator-actions.server.ts`; TA =
`app/server/tasks/task-actions.server.ts`; OR = `app/server/runtimes/operator-run.server.ts`;
RFR = `app/server/tasks/run-failure-remedy.server.ts`; DP =
`app/features/task-detail/decision-packet.tsx`; ROUTE = `app/routes/project.task.tsx`.

## 1. The packet object (task.md `## Packet`)

### 1.1 Schema (verified in `app/schemas/task-file.schema.ts:577-642`)

| Field | Type | Notes |
|---|---|---|
| `id` | string, optional | `pkt_…` stamped by every writer (OA:1195, agent-outcome.server.ts:478); resolution re-checks it in-lock (F10-09) |
| `type` | `input` or `blocked` | `blocked` also writes `readiness: blocked` (OA:1231) |
| `kind` | free text pill label | Writers emit exactly three: `Decision required`, `Blocked decision` (OA:1197), `Agent question` (agent-outcome.server.ts:436, load-bearing: answer routing keys on it, TA:7317) |
| `from` | actor-ref string, default `operator` | Rendered as `Operator` or the agent's role name (`app/shared/mapping/task.server.ts:551-560`) |
| `title`, `body` | strings | body renders inline `code` spans only (DP:52-63) |
| `observations[]` | `{k, v, code}` | `k` is uppercased by CSS; underscores and camelCase split; a path-shaped key renders as `detail`; empty/`null` value renders `none` or `unassigned` (DP:83-107) |
| `options[]` | `{kind, t, d, rec, ev?, backend?, profileId?, deleteBranch?, goalDraft?}` | parsed per row: one bad option drops only itself with diagnostic `packet.invalid_option` (`app/server/files/task-file.server.ts:356-420`) |
| `awaiting` | only `goal_edit` | set when an `edit_goal` option is confirmed (TA:7250) |
| `decided` | `{optionIndex, at, byUserId}` | stamped beside `awaiting` (TA:7253-7257, ruling 138) |
| `askedBy` | profile id | set only on agent-question packets (agent-outcome.server.ts:495-497) |

- YAML shape in task.md: a `## Packet` section holding one fenced yaml block; the parser requires
  the closing fence to be at least as long as the opening one so a fence inside `body`/`d`/
  `goalDraft` cannot truncate it (verified in task-file.server.ts:365-373). Unparseable yaml =
  diagnostic `packet.invalid_yaml`, packet ignored; the next write then serialises the packet
  away (comment at task-file.server.ts:397-403). Sample in `docs/architecture/file-formats.md:297-360`
  matches the schema keys; its `kind: Completion report` label is illustrative only, no writer
  emits it (grep of `app/server`, only the three labels above).
- ONE packet per task. Every writer refuses on pre-read and re-checks inside the locked write
  (OA:1128-1133 and 1214-1216; agent-toolkit.server.ts:214-227; TA:3208).

### 1.2 PACKET_OPTION_KINDS (verified in `app/schemas/task-file.schema.ts:131-167`, 11 kinds)

| Kind | Meaning | What confirming does (`resolvePacket`, TA:6657-7855) | Extra authority re-check |
|---|---|---|---|
| `accept_completion` | accept the work into Done | full acceptance contract: `requireAcceptCompletion`, disclosure echo (`ack`), live no-change probe, `acceptanceRefusalReason` with `blockedPacket:false`, PR-head check, REAL merge (or "accepted, merge pending"), stage = terminal, `readiness: ready`, `waiting: none`, `recommendations: []`, packet cleared (TA:6790-6980). Not re-queued | admin, maintainer, or live task owner (TA:6793) |
| `request_edit` | send back to the agent side | default arm: `waiting: agent`, `readiness: ready`, packet cleared, operator re-queued with trigger `packet-resolved`; on an `Agent question` packet the asker's session is resumed first via `answerAskingAgent` (TA:7186-7205, 7306-7355) | none beyond resolver |
| `redirect` | same as request_edit with a steer | same default arm (TA:7186) | none |
| `custom` | free-text answer, or an agent-question choice | same default arm; a typed directive resolves as a synthetic `custom` option regardless of `optionIndex` (TA:6710-6723) | none (the only kind never gated) |
| `block_on_policy` | "re-run the operator" (label states what the human asserts) | `readiness: ready`, `waiting: agent`, packet cleared, re-queued; timeline = `ev` or `**Decision:** <t>. <key> is unblocked and the operator re-runs to re-check. If it is still blocked, a new decision packet is opened.` (TA:6981-7009) | none |
| `hold_runtime_debug` | pause coordination, start nothing | `readiness: blocked`, `waiting: human`, packet cleared, NOT re-queued; text `**Decision:** hold for runtime debug. … Use **Run operator** on the task page when the inspection is done.` (TA:7010-7034) | none |
| `retry_other_backend` | re-run the failed agent on `option.backend` | `waiting: agent`, `readiness: ready`, packet cleared, then `startAgentRun` with `backendOverride` (+ `profileId` when stamped) under operator authority; a start failure leaves a `blocked` note `The retry could not start: <msg>` (TA:7057-7080, 7806-7840). Default backend when absent = `claude` (TA:7811); authoring stamps the opposite of the last failed agent run (OA:992-1021) | none |
| `edit_goal` | a human refines the goal | packet STAYS OPEN, `awaiting: goal_edit` + `decided` stamped, `waiting: human`; clears when `updateTaskGoal` lands (TA:7035-7056, 7250-7257, 754-800 with note `**Packet resolved:** the requested goal edit landed.`). Not re-queued; `goal-updated` trigger re-invokes the operator | UI blocks on `update-goal` (DP:664-675); server: `updateTaskGoal` requires `update-goal` |
| `archive_task` | archive (R14-3), optionally delete the remote branch | `waiting: none`, packet cleared, then `setTaskArchived(true)`; with `deleteBranch` also `deleteTaskRemoteBranch` (refused while a PR is open on the branch) and `discardLocalTaskBranch`, each outcome as a policy-engine note (TA:7081-7125, 7370-7480) | `approve-transition` (TA:7104) |
| `discard_branch` | delete the LOCAL never-pushed branch | packet cleared, then `discardLocalTaskBranch`; note per outcome (`deleted`, `not_found`, `on_remote`, `no_workspace`); audit `task.branch.discarded` or `task.branch.discard_refused` (TA:7126-7156, 7487-7585) | `approve-transition` (TA:7133) |
| `resolve_remote_collision` | delete stale remote branch, close unowned PR, re-deliver | packet cleared, then `resolveRemoteBranchCollision` + `manualDeliverForReview`; outcomes `cleared_and_delivered`, `cleared_delivery_failed`, `own_pr_pushed`, `own_pr_current`, `own_pr_delivery_failed`, `own_pr_diverged`, `refused` (`app/shared/packet-server-outcome.ts:52-71`); one audit row `github.collision.resolved`; exactly one operator hand-off (TA:7597-7800) | `approve-transition` (TA:7164) |

- Timeline event per decision: type `transition` (or `blocked` for hold), text = `option.ev` when
  pre-authored, else `**Decision:** <t>. …`; the human's note is appended as a blockquote
  (TA:7259-7265). Audit row `task.packet.resolved` with `{optionKind, optionTitle, packetKind}`
  (TA:7269-7280). `heldAtStage` is cleared on every resolution (TA:7248).
- NO_REQUEUE kinds (TA:7289-7297): `accept_completion`, `archive_task`, `edit_goal`,
  `hold_runtime_debug`, `retry_other_backend`, `discard_branch`, `resolve_remote_collision`.
  Everything else fires `autoInvokeOperator(... "packet-resolved", {resolvedOption})`.

### 1.3 The 409 / 4xx shapes on resolve (verified in TA)

| Situation | Status | Exact message |
|---|---|---|
| no packet on the file (or cleared in the lock window) | 409 | `This packet was already resolved.` (TA:6702, 7228) |
| `awaiting: goal_edit` already stamped, any second confirm | 409 | `This decision was already made on <KEY>. The packet is waiting for the edited goal. Save the goal to clear it.` (TA:6737-6741) |
| packet replaced during the await (id mismatch) | 409 | `This decision was replaced by a newer one. Refresh the task and choose again.` (TA:7232-7234; also inside `beforeMerge`, 6892) |
| `optionIndex` out of range with no `custom` | 400 | `Unknown packet option.` (TA:6726) |
| custom directive > 4000 chars | 400 | `Custom directive is too long: 4,000 characters max.` (TA:6705-6708) |
| accept option hits a gate | 409 | the `acceptanceRefusalReason` sentence, e.g. `<KEY> is at <Stage>, not <Review>. A completion can only be accepted from the boundary the workflow puts before <Done>. Move the task through the workflow first.` (TA:7995-8004) |
| accept option with no `ack` fields | 4xx | refused by `assertAcceptanceDisclosure` (TA:6806-6811); ROUTE always sends `acceptanceAck(formData)` (ROUTE:590) |
| accept arm while another acceptance already closed the task | 200, write skipped | `alreadyAccepted` short-circuit, no audit row (TA:7218-7223) |
| non-owner contributor, non-accept option | 403 | `requireAction(... "resolve-packet", "resolve decision packets")` (TA:6775) |
| contributor-owner picks archive/discard/collision | 403 | `requireAction(... "approve-transition", ...)` inside the arm (TA:7104, 7133, 7164) |

Authority (TA:6756-6775): resolver = admin or maintainer (`resolve-packet`, `app/shared/rbac.ts:72`)
OR the task's current owner with contributor+ membership (`ownerException`). ROUTE `resolve-packet`
intent (ROUTE:562-631) posts `option` (index), `note` (2000 cap), `custom` (4000 cap) and the ack
fields.

Contributor-owner escalation: `requestPacketMaintainerDecision` (TA:7857-7970), intent
`request-maintainer-decision` (ROUTE:632-655). Notifies maintainers+admins with title
`Decision needs a maintainer: <packet title>`, writes a `note`, audits `task.packet.escalated`.
Refuses a caller who holds `resolve-packet` with 400 `You can resolve this decision yourself; there is no need to route it to a maintainer.` (TA:7882-7886). Toast `Sent to N maintainer(s) · they'll decide`.

## 2. Every server writer that AUTHORS a packet

All routes funnel through `operatorOpenPacket` (OA:1023-1296) except the agent-question writer.
Effects common to `operatorOpenPacket`: `waiting: human`; `readiness: blocked` iff type
`blocked`; timeline `blocked` event `**Blocked:** <title>. Opened a decision packet for the owner to resolve.` or `comment` event `**Decision packet:** <title>. Awaiting a human decision.` (OA:1232-1243); acceptance offers withdrawn (ruling 137, OA:1216); audit `task.operator.packet_opened` `{type}` (OA:1262); notification kind `packet`, title `Decision needed: <title>` or `Blocked, decision needed: <title>` (OA:1270-1283); tool result `Opened a blocking|decision packet with N option(s).` (OA:1288-1291).

Authoring refusals inside `operatorOpenPacket` (all `noop`, none `denied`, except the first):

| Precondition | Message |
|---|---|
| `generate-packets` gate is `deny` | `The operator cannot open decision packets in this project.` (OA:1029-1035, outcome `denied`) |
| empty title / no options | `A packet needs a title.` / `A packet needs at least one option.` (OA:1037-1043) |
| unknown kind | `Unknown packet option kind "<k>". Valid kinds: …` (OA:1044-1052) |
| `discard_branch` offered while `workRevision !== null` or `pr !== null` or `github.unownedPr` set | `discard_branch only fits a LOCAL, never-pushed branch with no delivered revision — …` (OA:1067-1087) |
| `accept_completion` offered off the boundary (stage != stages[len-2]) or `validation !== "healthy"` | `accept_completion only fits a task AT the acceptance boundary with a healthy verdict — … Only a human admin can force-accept from here.` (OA:1094-1117, ruling 115) |
| a packet already open | `A decision packet is already open on <KEY> ("<title>"). Answer from it, or withdraw it with resolve_decision_packet if it is moot, before opening another.` (OA:1128-1133) |
| `goalDraft` on a non-`edit_goal` option | `goalDraft only fits an edit_goal option — "<title>" is <kind>. …` (OA:1140-1148) |
| lost the in-lock race | `Another decision packet was opened on <KEY> first; this one was not written.` (OA:1246-1250) |

Note: the boundary check for `accept_completion` uses the positional second-to-last stage
(OA:1099-1101), while every acceptance gate uses `resolveStageRoles` / declared edges
(TA:7971-8005). On a board whose review stage is not positionally second-to-last these disagree
(candidate finding, code-vs-code, not docs).

### 2.1 Writer table

| # | Writer | Precondition | type | title | options | Live recipe |
|---|---|---|---|---|---|---|
| A | Operator's own decision, Claude toolkit tool `open_decision_packet` (`operator-toolkit.server.ts:411-520`) or Codex plan tool `open_packet` (OR:2462-2490); body gets the R20-9 consultation disclosure appended (`operatorOpenPacketDisclosed`, operator-toolkit:227-238) | the model decides; gate `generate-packets` != deny | model's choice | model's | model-authored 2-4, or `defaultPacketOptions(type)` on Codex when null (OR:2047-2085: blocked = `block_on_policy` "Re-run the operator now" rec, `redirect` "Redirect the specialist with new guidance", `hold_runtime_debug`) | Create a task with the placeholder goal (`Goal to be refined at the triage quality gate.`, TA:476) or an ambiguous goal; the triage prompt says to `open_decision_packet` or `set_goal` (OR:3735-3737). Or comment `@operator ask me before pushing` |
| B | Agent `ask_human` tool (`agent-toolkit.server.ts:320-372` → `openAgentQuestionPacket` 202-262) | specialist granted the ask capability (`collab.ask`), no packet open | `input` | the agent's question | `custom` per choice (max 4, first `rec`), else one `custom` "Answer the question" (agent-outcome.server.ts:440-500) | Give the deliverer a goal with a genuine fork ("choose Go or Rust for the k9s clone") and grant the ask capability; tool result `[refused] A decision is already open on this task — …` when one is open. Audit `task.agent.packet_opened`; timeline `**Question for a human:** <title>` |
| C | Codex completion envelope question (TA:3205-3230) | Codex specialist returned a question in its envelope, no packet open | `input` | question title | as B | same as B on a Codex-backed agent; if a packet is already open the question is only recorded as a timeline note (`questionDeferred`, TA:3231) |
| D | Failed specialist run → `openStuckLoopPacket` (TA:3850-3980, 2525-2626) | agent run ends `error` with `runFailureReason` kind quota/auth/unavailable/overloaded/max_turns/idle_timeout/session_missing/unknown | `blocked` | `Work stalled: pick a recovery path` | classified backend failure (quota/auth/unavailable/overloaded): `describeRunFailure` specialist set (RFR:236-297): `retry_other_backend` "Retry @handle on <Other> now" (rec, only when the task owner has the other backend connected), `request_edit` "The window has reset (…), or the Claude account changed: send @handle back to continue" (rec when no retry), `redirect` "Redirect with sharper guidance"; always appended: `hold_runtime_debug` "Hold for runtime debugging". Other kinds: stock set `redirect` (rec), `request_edit` "Send back for another attempt", hold | Provoke by exhausting the owner's Claude window, or disconnecting the owner's backend on Profile → Agent accounts then running the agent (`unavailable`). Observations: `Agent`, `Signal`, `Provider said` (code) |
| E | No-progress react or react-depth cap (TA:4128-4160) | agent reply byte-equals its previous reply (after stripping the cc line), or 4 react cycles (`OPERATOR_REACT_DEPTH_CAP = 4`, TA:207) without a boundary | `blocked` | `Work stalled: pick a recovery path` | stock set (D) | Ask the agent to "report exactly what you reported last time"; or let operator↔agent ping-pong 4 times |
| F | Transition chain cap (TA:5074-5100) | operator makes 8 consecutive stage moves with no agent run or human action (`OPERATOR_TRANSITION_CHAIN_CAP = 8`, TA:220) | `blocked` | same | stock set; observation `Agent: @operator` | Full-autonomy operator on a board with a cycle of auto boundaries |
| G | Failed operator run → `escalateFailedOperatorRun` (OR:2925-3010) | the operator's own run ends in error | `blocked` | `Operator run failed: pick a recovery path` | `describeRunFailure` operator set (RFR:191-234): quota → `block_on_policy` "The usage window has reset (<label>), or I switched the Claude account: re-run" (rec); auth → `block_on_policy` "I connected a different Claude account or an API key on Profile → Agent accounts: re-run" (rec); else `block_on_policy` "Re-run the operator now" (rec); plus `redirect` "Redirect the work with new guidance", `hold_runtime_debug` "Hold: pause coordination while I inspect the session" | Same as D but on the operator's backend (the operator bills the task owner, ruling 127). Body = reason + `No coordination was performed.` + remedy + `What the provider reported: …`; observations `Window reopens`, `Provider said` |
| H | Codex operator produced no parseable plan (OR:2358-2395) | Codex operator reply empty or not a valid JSON plan | `blocked` | `Operator turn produced no actionable plan` | `defaultPacketOptions("blocked")` | Codex-backed operator; if `generate-packets` is withheld the fallback is a note (`writeOperatorNoPlanNote`) |
| I | Branch update conflict / push conflict via operator tool `update_branch_from_base` (`app/server/github/update-branch-operator.server.ts:420-470`) | merge of base into the task branch conflicts, or the publish push is non-fast-forward | `blocked` | `` `<branch>` conflicts with `<base>` `` or `` `<branch>` diverged from its remote `` | `conflictOptions` (166-224): `redirect` "Have <Deliverer> resolve the conflict" (rec, only when a deployed repo-write deliverer exists), `custom` "Resolve `<branch>` yourself", `archive_task` "Archive the task: the work is superseded"; with no deliverer: by-hand rec + archive | Push a conflicting commit to `main` on akin-ozer/k9s-clone touching the same file the agent edited, then ask `@operator bring the branch up to date` |
| J | Delivery push conflict / branch-key collision | NOT server-authored. `performDelivery` returns `push_conflict` (TA:5396-5408); the operator tool result tells the model to author a packet with `resolve_remote_collision` or `archive_task` (OA:2749-2760; prompt OR:3787) | model's | model's | model's | Pre-create a remote branch named after the task key (`<key lowercased>`) in akin-ozer/k9s-clone with a stray commit (and optionally a PR) before the first delivery; watch whether the operator opens the packet and offers `resolve_remote_collision`, not `discard_branch` (authoring refuses that, OA:1067) |
| K | Closed PR recovery (`pr-diverged` trigger) | NOT server-authored: the reconciler wakes the operator (`github-reconciler.server.ts:940-955`) and the turn instruction demands ONE `input` packet: `custom` (rework), `archive_task`, `archive_task` + `deleteBranch` (OR:3673-3686); merged out-of-band → no packet, `accept_completion` instead; reopened → `resolve_decision_packet` | `input` | model's | as instructed | Close the review PR on GitHub without merging; the poller (5 min) or Re-check on the project GitHub view triggers it. Also: merge the PR by hand on GitHub and watch for the acceptance path |
| L | Scope violation (ruling 144) | NOT a packet: `flagScopeViolation` writes a policy violation + `Delivery push refused: workflow scope` event (TA:5414-5445); the operator tool result says do not retry (OA:2761-2770) | n/a | n/a | n/a | Have the agent add a `.github/workflows/*.yml` with a classic token lacking `workflow` scope |
| M | Dependency hold (ruling 131) | NOT a packet: `set_dependencies` / `blockedBy` floors readiness at `blocked`, `waiting: none` unless something is pending, note titled `Dependencies updated` (`dependencies.server.ts:290-320`); operator `create`/`transition`/`scheduled` triggers refused `blocked-by` (OR:285, 1495-1503) | n/a | n/a | n/a | Comment `@operator this waits on <OTHER-KEY>`; the prompt forbids a hold packet for this (operator-toolkit:523-545) |

Docs claim, code disagrees (minor): `docs/domain/operator.md` §6 says the failed-run leaf supplies
options "when the failure is `quota | auth | unavailable`"; code also classifies `overloaded`
(TA:3961-3965, RFR:246-248, OR `describeRunFailure` case at RFR:150-159).

### 2.2 Automatic packet withdrawals (no human click)

| Withdrawer | Condition | Record |
|---|---|---|
| `withdrawSupersededStuckPacket` (TA:2659-2735) | a specialist run completes successfully while a `blocked` packet without `accept_completion` stands; `retry_other_backend` packets must match by `profileId` or the delivering agent | `readiness: ready` if blocked; timeline `**Packet withdrawn:** "<title>" is moot. The <role> agent run completed successfully after it was opened.`; audit `task.packet.withdrawn_superseded` |
| `withdrawSupersededDeliveryPacket` (TA:2766-2828) | a delivery opens a PR while the packet carries `resolve_remote_collision` (any type) or is `blocked` with `discard_branch` | `**Packet withdrawn:** "<title>" is moot — delivery succeeded and a review pull request now stands for this task.`; same audit |
| `updateTaskGoal` (TA:776-795) | packet `awaiting: goal_edit` | `**Packet resolved:** the requested goal edit landed.`; readiness lifted if the packet was `blocked` |
| `setTaskArchived(true)` (TA:6559-6575) | any packet | packet, recommendations and pending schedules all dropped; no dedicated packet note (the archive note says `Archived: …`) |
| `applyAcceptanceWrite` (TA:8836-8900) | acceptance (incl. force) while a packet is open | policy-engine note `Withdrew the open decision "<title>" — this acceptance closed the task, so the decision was never answered.`; audit `task.packet.withdrawn` |
| Operator tool `resolve_decision_packet` → `operatorResolvePacket` (OA:1298-1382) | operator-raised packet only; refuses `from !== "operator"` or `askedBy` set with `The open packet "<title>" was raised by <from>, not by you. Only a human can resolve an agent's question. …` (outcome `denied`) | `transition` event `**Packet withdrawn:** <title>. <reason>` (default reason `The input it asked for has since been provided.`); audit `task.operator.packet_withdrawn` |

Observation hooks: the delivery door does NOT touch a closed-PR recovery packet
(`recordDeliveredNextStep` returns early via `alreadyActionable`, TA:6232-6236); the packet card
prints a body note about it when an `archive_task`+`deleteBranch` option is present (DP:428-481, 1050-1063).

## 3. Readiness and waiting while a packet is open

- Stored enums: `readiness` in `ready | input_required | inconsistency_risk_detected | blocked`,
  `waiting` in `human | agent | none` (`app/schemas/task-file.schema.ts:28-36`).
- Opening: every writer sets `waiting: human`; only type `blocked` sets `readiness: blocked`
  (OA:1229-1232; agent question leaves readiness untouched, agent-toolkit:229).
- Display derivation (`app/shared/mapping/task.server.ts:516-535`): `agent_working` when
  `waiting: agent` and readiness ready/input_required; `goal_edit_pending` when
  `packet.awaiting === "goal_edit"` and waiting != agent; `input_required` when readiness `ready`,
  waiting `human`, packet type `input`; else the stored value. Pill labels: `ready`,
  `input required`, `inconsistency risk`, `blocked`, `accepted`, `merged`, `agent working`,
  `goal edit pending` (`app/ui/pill.tsx:71-80`).
- Acceptance gate while a `blocked` packet is open and readiness is `blocked`:
  `This task has an open blocked decision. Resolve the operator's packet before accepting it.`
  (TA:8054-8057); the packet's own `accept_completion` arm evaluates with `blockedPacket:false`
  (TA:6824-6830), and the page names `blockedReasonViaPacket` in that dialog (task-detail-page.tsx:918-925).
- An `input` packet does NOT block acceptance (the gate keys on `readiness === "blocked" && packet.type === "blocked"`, TA:8460-8462).
- Decisions inbox counts any task with `packet_json` non-empty or `recommendation_count > 0`,
  non-archived, non-terminal (`app/server/projections/decisions.server.ts:117-131`).

## 4. Manual and scheduled runs refused while a packet is open

| Door | Behaviour | Exact copy |
|---|---|---|
| Task page "Run operator" (execution-profile.tsx:974-978) | button rendered `aria`-off with sub copy | `Open decision. Resolve it before running the operator.` |
| ROUTE `run-operator` (ROUTE:969-1051), `runOperator` guard (OR:1508-1533, `PACKET_REFUSED_TRIGGERS = manual, scheduled`) | `refused: "open-packet"`, no run, steer comment NOT written | toast `Operator not started · resolve the open decision to continue` |
| `@operator` mention comment (`commentToAgent`, ROUTE:491) | comment posts, run refused | toast `Comment posted · resolve the open decision to continue` |
| Controller `run_agent_on_task` with the operator (`controller-toolkit.server.ts:1435`) | denied | `[denied] The operator is not run while a decision packet is open. Answer the packet first.` |
| Scheduled `run-operator` occurrence (ruling 141; `schedule.server.ts:656`) | retired, outcome `skipped-packet`, no retry spent | note `**Scheduled action skipped:** … a decision packet is open on <KEY> ("<title>") and coordination is paused until it is resolved — no run was started, and the occurrence spends no retry.` (OR:706-730) |
| Queued human turn drained behind a live drive that left a packet | note by `operator-lease` | `A queued @operator turn was refused when it reached the front of the queue: <cause> — no run was started. Resolve it, then run the operator again.` (OR:722-724) |
| Machine triggers `pr-diverged`, `agent-reply`, `transition`, `packet-resolved`, `goal-updated`, `delivered`, `dependencies-released`, `create` | NOT refused by the packet guard (OR:1508 comment; ruling 141) | n/a |

`autoInvokeOperator` also refuses `terminal-stage` (`Comment posted · reopen the task to run the operator`) and `blocked-by` (ROUTE:491-494; OR:282).

## 5. What the task page renders

### 5.1 Decision packet card (DP:770-1374)

| Element | Copy / attribute |
|---|---|
| card class | `packet blocked` or `packet input`; `data-decided=""` on a decided edit_goal packet (DP:899) |
| pill | packet `kind` text, tinted by type; `from <shield> <Operator or agent role>` |
| options | `role="radiogroup"` `aria-label="Decision options"`; each `role="radio"`; keys 1-9 jump; rec tag `operator pick` when `from === "Operator"`, else `recommended` (DP:1004-1013); `deletes branch` pill on `archive_task`+`deleteBranch` (DP:995-1001) |
| custom choice | `Write your own directive` / `Answer in your own words. The operator (and the asking agent, if one raised this) re-engages with exactly what you type.`; textarea label `Your directive*` hint `resolves this decision · handed to the operator`; empty submit → `role="alert"` `Write the directive first.` (ruling 147, DP:1040-1049, 1218-1230) |
| note | label `Note for the operator`, hint `optional · recorded on the decision`, hidden while custom is selected (DP:1070-1090) |
| deny notes (`.deny-note`) | selected option above tier: `Accepting completion is reserved for maintainers and this task's owner.` / `Editing the goal is reserved for maintainers and admins.` / `Archiving is reserved for maintainers and admins.` / `Discarding the branch is reserved for maintainers and admins.` / `Clearing a branch collision is reserved for maintainers and admins.` (DP:653-720); cannot resolve at all: `You can't resolve this decision: a maintainer, an admin, or this task's owner can. You can still comment or ask the operator below.` (DP:1100-1107); every option above tier: `Every listed option needs maintainer or admin authority. …` + button `Send to a maintainer` (DP:1112-1135, shown only for owner && !run-agents, task-detail-page.tsx:493) |
| actions | `Ask operator` (ghost, inserts `@operator` into the composer, open to everyone); `Confirm decision` (primary, `aria-label="Confirm decision: <option t>"`, `aria-disabled` + dimmed while a tier gate blocks; real `disabled` only while busy) (DP:1138-1213) |
| decided edit_goal state | options disabled, chosen one tagged `chosen`; note `Decision made · save the edited goal to clear this packet`; buttons `Ask operator` and `Edit the goal` (only when `canEditGoal`) (DP:896-960) |
| closed-PR hint | `Not in this list: the GitHub panel on this page still offers **Deliver branch & open PR**. … Delivering does not resolve this packet, and the archive option that deletes the branch ends that path.` (DP:1050-1063) |

Authority flags passed by the page (task-detail-page.tsx:268-295, 724-733): `canResolve = run-agents || isOwner`; `canResolveCompletion = canDecideOwned` (same set); `canEditGoal = update-goal`; `canArchive = canDiscardBranch = approve-transition`.

Confirm-first ceremonies (DP:728-732, `CONFIRM_FIRST_KINDS`), all `role="alertdialog"` with `Not yet` + a `btn danger` commit:

| Kind | `data-screen-label` | heading | commit label | rows |
|---|---|---|---|---|
| `archive_task` | `Packet archive dialog` (DP:353) | `Archive this task?` or `Archive this task and delete its branch?` | `Archive <KEY>` or `Archive & delete <branch>` | Decision, Deletes (warn, if deleteBranch), Branch kept (own open PR #N, warns deletion will be refused), After, Withdrawn (`the open "<title>" decision and N pending operator recommendation(s). Restoring the task reopens the question.`) |
| `discard_branch` | `Packet discard dialog` (DP:447) | `Discard this task's workspace branch?` | `Discard <branch>` | Decision, Deletes (local branch, warn), GitHub (`Nothing on GitHub changes: this branch was never pushed. (If it had been, the discard is refused and the archive option is the path.)`) |
| `resolve_remote_collision` | `Packet collision dialog` (DP:588) | `Clear the branch collision?` (unowned PR recorded) or `Delete this task's remote branch?` (none recorded) | `Clear collision & redeliver` or `Delete branch & redeliver` | Decision, Deletes (warn; names `#<unownedPr>`), No deletion (own open PR), Keeps (`This task's local delivery …`) |
| `accept_completion` | `Accept completion dialog` (accept-confirm.tsx:281), mode `packet` (task-detail-page.tsx:465-478) | ordinary acceptance heading | `Accept …` primary | Merges, Revision, Merge head (drift), Verdict, Blocked (= `blockedReasonViaPacket`), Withdraws (not on the packet path) |

Resolve toasts (ROUTE:601-618): `Completion accepted · <KEY> moved to Done`; `Unblocked · the operator re-runs to re-check`; `Held for runtime debug · the session is recorded per audit policy`; `Retrying on Claude|Codex · streaming to agent logs` or `Decision recorded, but the retry could NOT start. The reason is on the timeline`; `Decision recorded · type the new goal; the packet clears when it lands` (and the goal editor opens prefilled with `goalDraftForOption`); else `Decision recorded: <t>`.

### 5.2 Side rail and GitHub panel
- Rail `Waiting on` row reads `a goal edit` for a decided edit_goal packet (ruling 138; task-side-panels.tsx:916-931).
- Force-accept row lives in the GitHub panel (task-side-panels.tsx:173-205), see §7.

## 6. Recommendations

### 6.1 Object and writer
- `RECOMMENDATION_KINDS = transition | run_agent | accept_completion | delivery`; fields
  `id, kind, profileId?, prompt?, delivers?, toStageId?, label, detail, forHeadSha?`
  (`app/schemas/task-file.schema.ts:249-300`). Several may be pending at once.
- ONE writer, `addRecommendation` (OA:807-926): dedupes on `(kind, profileId, toStageId)`; a
  changed `prompt`/`delivers`/`label`/`forHeadSha` updates the card in place and counts as new;
  sets `waiting: human`; timeline `comment` by operator `**Recommendation:** <label>. <reasoning>`;
  audit `task.operator.recommended` `{kind}`; new cards notify kind `approval`, title
  `Operator recommends: <label>`.
- The `recommend` mode: capability gate returns `recommend` (`gate`, OA:510-545) under SUPERVISED
  autonomy or a stored `recommend` grant; the four operator actions then write cards instead of acting:

| Action | Card | Verified |
|---|---|---|
| `transition_stage` | `transition` to `toStageId` | OA:2783-2860 (call at 2834) |
| `run_agent` | `run_agent` with `profileId`, `prompt`, `delivers` | OA:2473-2648 (call at 2559) |
| `deliver_for_review` | `delivery`, label `Deliver the branch & open the review PR` or `` Push `<sha7>` to PR #N `` (OA:2676-2705); noop `PR #N already carries the delivered revision …; there is nothing to deliver.` |
| `accept_completion` | `accept_completion`, label `Accept completion and move <KEY> to <Done>` or `Complete <KEY> with no changes and move it to <Done>`, `forHeadSha` = `workRevision.headSha`, audit `task.operator.recommended_completion` (OA:3040-3092) |

- `accept_completion` card preconditions (OA:2972-3040): capability `completion-for-acceptance`
  not off/human (else `denied` with `Accepting completion is not permitted for the operator here: … a maintainer accepts it on the task page.`); task not Done; `acceptanceRefusalFor` returns null (so no card is ever authored that acceptance would refuse). Written when autonomy != full OR the grant is `recommend`. Under full+direct the operator accepts itself (PR recorded `accepted`, merge pending; audit `task.operator.accepted_completion`).
- Server-authored card without the operator: `recordDeliveredNextStep` (TA:6133-6232) after a
  supervised delivery when the task is before the review stage with a declared edge and nothing
  actionable exists: `transition` card `Move the task to <Review>`, detail starts `Recorded by Viberr when the delivery landed; this is not the operator agent's judgement. …`, note by system `delivery`, audit `github.delivery.next_step`, notification from `Delivery`.

### 6.2 Withdrawal (ruling 137, `app/server/tasks/task-mutation.server.ts:362-500`)
- `withdrawAcceptanceOffers` removes every `accept_completion` card on all causes, and
  `transition`-to-terminal cards on the `packet` and `stage_move` causes. Callers: every packet
  writer (OA:1216, agent-toolkit:233, TA:3214), stage move away from the boundary (TA:5008),
  new revision delivered (`workspace-delivery.server.ts:523`).
- Record: note titled `Recommendation withdrawn`: `Withdrew the offer(s) "<label>": <cause>. [N recommendation(s) still stand.] The operator re-recommends acceptance on its next turn if the offer still holds.` Cause text: `` a new revision `<sha7>` was delivered, so the offer no longer describes the work under review `` / `a decision packet opened ("<title>"), so the task is waiting on a human decision first` / `the task moved to **<Stage>**, away from the acceptance boundary`. Audit `task.recommendation.withdrawn` `{cause, removed[], surviving}`.
- Also consumed: acceptance clears all cards (TA:6966); archive clears all (TA:6561); any stage
  move prunes pending transition cards (docs task-lifecycle §9; TA:5008 `alsoStale`).
- Dismissal: `dismissRecommendation` (TA:9706-9790): timeline `transition` titled
  `Recommendation declined`, text `**Decision:** "<label>" was declined. The operator's recommendation was not applied; do not re-propose it unless something material about the task changes.`; audit `task.recommendation.dismissed`; missing id is a no-op (toast `Recommendation dismissed`).

### 6.3 Apply (TA:9499-9690)
- Authority: `requireDecisionAuthority` = admin/maintainer or the task owner (R14-2, R15-3). When the
  owner lacks the inner tier, `run_agent` runs as `OPERATOR_TASK_ACTOR` with `operatorAuthorized`,
  and `transition` passes `recommendationAuthorized` (TA:9560-9575, 9611).
- Arms: `run_agent` → `startAgentRun` with the card's `prompt`/`delivers`, `triggeredByName`;
  `transition` → `transitionStage` (`manual: true` when the edge is undeclared; `ack` rides through
  and matters only onto the terminal stage); `delivery` → `performDelivery`, failure keeps the card
  and 409s `Delivery did not complete: <msg>`; `accept_completion` → `acceptCompletion` with `ack`.
- Missing id: 409 `That recommendation is no longer available. It may have been resolved, dismissed, or replaced by a newer one. Refresh to see the current recommendations.`
- After success: card removed, bell read (`approval`), audit `task.recommendation.applied` `{kind, label}`. Toast `Applied · <label>` or `Applied · <delivery toast>` (ROUTE:929-956).

### 6.4 UI (`app/features/task-detail/operator-recommendations.tsx`)
- Panel `Operator recommendations`, pill `N pending`; kind labels `Run agent` (+ ` · delivering` / ` · supporting`), `Stage`, `Completion` (+ `for revision <sha7>`), `Delivery`; `Directive: "<prompt>"` line when it differs from detail.
- Buttons `Apply` (title `Apply the operator's recommendation (asks before merging)` on completion) and `Dismiss` (title `Dismiss without acting`), rendered only when `canApply` = `canDecideOwned` (run-agents OR owner; task-detail-page.tsx:289, 771). The panel comment says "admin|maintainer" but the page passes the owner-inclusive flag; the server allows the owner, so no mismatch.
- Apply on `accept_completion` or a terminal-target `transition` opens `Accept completion dialog` in mode `apply-recommendation` before submitting (task-detail-page.tsx:930-935).
- Dismiss opens `ConfirmDialog` `data-screen-label="Dismiss recommendation dialog"`, title `Dismiss this recommendation?`, body `<label> is withdrawn without acting on it. The dismissal is recorded on the timeline; the operator may raise it again on its next run.`, button `Dismiss recommendation` (primary tone) (task-detail-page.tsx:993-1010).

## 7. Force-accept

| Aspect | Verified |
|---|---|
| Who | project role with `force-accept-completion` = admin only (`app/shared/rbac.ts:88`); UI: `canForceAccept = roleCan(force-accept-completion) && !acceptanceTerminallyBlocked` (task-detail-hooks.ts:185-189) |
| When the button shows (task-side-panels.tsx:141-175) | not terminal (`accepted`/`merged`), not terminally blocked (PR `closed`, or archived per ruling 123), AND `wedgedOrDelivering` = has `branch` or `pr` or `workRevisionSha` or an open `blocked` packet (ruling 124), AND (`acceptance.blockedReason` non-null OR an open blocked packet) |
| Button label | `Force accept (skips the remaining stages and the review gate)` off-boundary, else `Force accept (override review gate)`; class `btn ghost sm full danger`; title `Admin override: accept <KEY> into Done from here, skipping the remaining stages AND the review gate, and merge. Audited.` |
| Ceremony | `Accept completion dialog`, mode `force`: heading `Force-accept this completion?`; rows Merges, Revision, Merge head, Verdict, `Skips` (warn: `<Stage → Stage>, and the review gate: <KEY> goes straight to <Done> and the pull request merges.`), `Bypassing` (= `task.blockReason ?? acceptance.blockedReason ?? "An open blocked decision is holding this task."`), `Withdraws` (open packet title); foot hint `Admin override. The bypassed gate is recorded to the audit log.`; buttons `Not yet` and danger `Force-accept <KEY>` (accept-confirm.tsx:89-93, 225-230, 418-470, 480-491; task-detail-page.tsx:905-913) |
| Server (`forceAcceptCompletion`, TA:9288-9384) | `requireAction("force-accept-completion")`; already Done → silent return; `forceIrreducibleRefusal` (closed unmerged PR; archived task) → 409 BEFORE any audit; `assertAcceptanceDisclosure` (missing ack → refused, no forced row); `bypassed` computed from `acceptanceRefusalReason` before the write, falling back to `an open blocked decision packet` or `no gate (already acceptable)`; then `acceptCompletion({force:true})` |
| Records | audit `task.acceptance.forced` `{bypassed}` only after `accepted` (TA:9370-9380); the acceptance write stores `acceptance: "forced"` so validation derives `bypassed` (schema:39-45); open packet withdrawn with the policy-engine note + `task.packet.withdrawn` (TA:8845-8895); completion timeline event from `acceptCompletion` |
| Toast | `Force-accepted <KEY> · moved to Done (review gate overridden)` (ROUTE:742-757) |
| Ceiling | not bypassable: closed unmerged PR (ruling 37/R16-3), archived task (ruling 123), PR head must still contain the delivered revision (comment TA:8840-8850, ruling 20) |

## 8. The `accept_completion` card lifecycle (when it appears / disappears)

- Appears: an operator turn calls `accept_completion` under supervised autonomy or a `recommend`
  grant, at the boundary with a healthy verdict and no refusal (§6.1). Triggers that lead there:
  `agent-reply` from a reviewer with a clean verdict (OR:3652-3656), `delivered` with a passed
  review, `pr-diverged` merged out-of-band (OR:3691-3695).
- Disappears: a new revision is delivered (`revision` cause); ANY packet opens (`packet` cause,
  including an agent question); the task moves away from the review stage (`stage_move`); the
  card is applied or dismissed; acceptance (any door); archive. Each leaves the
  `Recommendation withdrawn` note except apply/dismiss/acceptance/archive, which have their own.
- The direct human `Accept completion` control does not need the card: `resolveAcceptanceAffordance`
  (TA:8427-8497) renders it whenever `hasAuthority && atBoundary && blockedReason === null`.

## 9. Operator-side identifiers the observer will see

| Surface | Identifiers |
|---|---|
| Claude operator MCP server `viberr` tools touching decisions | `open_decision_packet` (args `packetType`, `title`, `body?`, `observations?[{k,v,code?}]`, `options[{kind,title,detail?,recommended?,backend?,profileId?,deleteBranch?,goalDraft?}]`), `resolve_decision_packet` (`reason`), `set_dependencies` (`blockedBy[]`, `reason?`), `accept_completion`, `deliver_for_review`, `update_branch_from_base`, `run_agent`, `transition_stage`, `post_comment`, `set_goal`, `flag_context_conflict`, `get_task` (operator-toolkit.server.ts:411-600; gates: packets and dependencies on `generate-packets`) |
| Codex operator plan tools | `post_comment, open_packet, resolve_packet, set_goal, run_agent, transition_stage, deliver_for_review, update_branch_from_base, accept_completion, flag_context_conflict, set_dependencies` with fields `packetType`, `text` (= title), `reason` (= body), `packetOptions[]` (OR:1741-1900) |
| Operator triggers | `create, transition, agent-reply, goal-updated, pr-diverged, delivered, packet-resolved, dependencies-released, scheduled, manual` (OR:179-190) |
| `packet-resolved` instruction | `A human just answered your decision packet: **<title>** — the human added: "<note>" [Viberr then performed that option's own steps and reports …: <serverOutcomeSentence>]. The packet is now resolved. … Assume NOTHING about credentials or policy beyond what the decision itself says … Do NOT re-open the packet you were just answered on …` (OR:3707-3725) |
| Prompt tail | `NEVER end your turn leaving the task at a pre-work or auto stage with nothing done and no packet: either advance the boundary, hand off to a specialist, or open_decision_packet …` (OR:3789) |
| Controller (`viberr_controller`) | has NO tool that opens or resolves packets, applies recommendations, accepts or force-accepts; `update_task` can edit the goal (which clears an awaiting edit_goal packet) and `blockedBy`; `get_task` reports the open packet (controller-toolkit.server.ts:151-181, 1020, 1253-1300) |
| Audit actions | `task.operator.packet_opened`, `task.agent.packet_opened`, `task.operator.packet_withdrawn`, `task.packet.withdrawn_superseded`, `task.packet.withdrawn`, `task.packet.resolved`, `task.packet.escalated`, `task.operator.recommended`, `task.operator.recommended_completion`, `task.operator.accepted_completion`, `task.recommendation.applied`, `task.recommendation.dismissed`, `task.recommendation.withdrawn`, `github.delivery.next_step`, `github.collision.resolved`, `task.branch.discarded`, `task.branch.discard_refused`, `task.acceptance.forced`, `task.dependencies.updated` |
| Notification kinds | `packet` (`Decision needed: …`, `Blocked, decision needed: …`, `Decision needs a maintainer: …`), `approval` (`Operator recommends: …`, `Next step recorded: …`), `quality` (`<role> run failed …`) |
| Tables | `task_projections.packet_json`, `task_projections.recommendation_count` (decisions.server.ts:117-125); `agent_runs` (backend/profile for retry defaults, OA:1000-1006) |

## 10. Live recipes, ordered by ease, for the k9s-clone pass

1. Input packet from triage: create a task with the default goal text; expect `Decision required` with an `edit_goal` option carrying `goalDraft`; confirm it, reload, check the decided render, then save the goal and check the `Packet resolved` note and readiness.
2. Second packet refused: with a packet open, comment `@operator open another decision about X`; expect the operator's tool result refusal quoted in its comment, no replacement.
3. Manual run refusal: with a packet open press Run operator (button should be off with `Open decision. Resolve it before running the operator.`); craft the POST or schedule a run to see the `skipped-packet` note.
4. Agent question: grant the deliverer `ask_human`; goal with a fork; expect `Agent question` from the agent role, options `custom`, rec tag `recommended` (not `operator pick`); answer with a custom directive; verify the agent resumes (R15-14) and the operator also runs.
5. Push conflict / collision: pre-create the remote branch under the task key with a stray commit before delivery; expect the operator's packet with `resolve_remote_collision`; confirm through `Packet collision dialog`; check the one hand-off and the `github.collision.resolved` audit.
6. Base conflict: commit to `main` on GitHub touching the agent's file; ask `@operator update the branch from main`; expect the conflict packet (I) with `Have <Deliverer> resolve the conflict` recommended only if the deliverer holds repo-write.
7. Closed PR: close the review PR on GitHub; after reconcile expect the rework/archive packet (K); then reopen the PR and verify the operator withdraws it (`resolve_decision_packet`).
8. Acceptance card: after a clean reviewer verdict under supervised autonomy expect `Completion` card `for revision <sha7>`; deliver a new revision and expect `Recommendation withdrawn`; open any packet and expect the same.
9. Force-accept: as admin on a wedged task (blocked packet or failing verdict) use the GitHub panel row; verify `Skips` and `Bypassing` rows, the `task.acceptance.forced.bypassed` value, and that an open packet is withdrawn with the note.
10. Failed run packets (D, G): hardest to provoke honestly; disconnecting the owner's backend on Profile → Agent accounts then running yields `unavailable`; check that the packet body names the person and Profile → Agent accounts, and that a `hold_runtime_debug` confirm leaves the task `blocked` with no packet and only Run operator as the way back.

## 11. Drift candidates and code-vs-code inconsistencies noted while verifying

- docs/domain/operator.md §6: failed-run leaf option set described for `quota | auth | unavailable`; code also `overloaded` (see §2.1).
- docs/architecture/file-formats.md packet sample uses `kind: Completion report`; no writer emits it (labels are `Decision required`, `Blocked decision`, `Agent question`). Illustrative, but an observer grepping for the label will find nothing.
- docs/domain/operator.md table says `archive_task` with `deleteBranch` is "the product's only remote-branch deletion besides collision resolution"; code has three callers of `deleteTaskRemoteBranch` (that packet, the post-merge `delete-branch-after-merge` guardrail, the collision remedy), as ruling 17's own correction note already says.
- Code-vs-code: `operatorOpenPacket`'s `accept_completion` boundary check is positional (`stages[len-2]`, OA:1099) while acceptance gates use resolved stage roles and declared edges (TA:7971-8005). Differs only on boards whose review stage is not second-to-last.
- Code-vs-code: `resolvePacket` defaults `retry_other_backend` to `claude` when `option.backend` is absent (TA:7811); authoring always stamps one now (OA:1174-1184), so this only bites hand-edited task.md.
- UI comment in operator-recommendations.tsx says Apply/Dismiss are "admin|maintainer"; the page passes the owner-inclusive flag and the server admits the owner. Comment stale, behaviour consistent.
- `hold_runtime_debug` ends with `readiness: blocked`, `waiting: human`, no packet, no card: the board's blocked filter lists it, and the only exit is Run operator or an `@operator` comment (TA:7010-7034). Worth watching for the "no way out" class if the observer is not an admin/maintainer (contributor-owner cannot run the operator).

## Gap fill: Operator toolkit, triage behaviour and agent selection

Written 2026-09-06 against branch `pass35/k9s-clone-observation`. Extra abbreviations for this
section: TK = `app/server/tasks/operator-toolkit.server.ts`; SR =
`app/server/tasks/specialist-run.server.ts`; SEED = `app/server/seed/agent-catalog.server.ts`;
TPL = `app/shared/workflow/templates.ts`. Docs consulted: `docs/domain/operator.md` §1-§5,
`docs/domain/task-lifecycle.md` §3-§5, `docs/domain/agents-and-runtime.md` §4.1/§4.4,
`docs/architecture/decisions.md` rulings 98, 133. Em-dashes below appear only inside verbatim
app strings.

### 12.1 How the toolkit is built and gated

- The Claude operator gets an in-process MCP server named `viberr` (TK:696-701); tool names the
  model sees are `mcp__viberr__<name>` (TK:251). A capability in `off`/`human` mode means the tool is
  NOT BUILT (TK:341, 410, 573, 617, 643, 658, 683). `allowedTools` only auto-approves; confinement is
  the deny list `OPERATOR_READ_ONLY_DENIED_TOOLS = Bash, Edit, MultiEdit, Write, NotebookEdit`
  (`app/server/runtimes/claude-runtime.server.ts:256-264`) plus `WebFetch`/`WebSearch` when
  `use-web-search-fetch` is withheld (OR:1399-1407).
- Server instructions (TK:161-167): "Viberr coordination tools. You are the task operator. … You never
  write code: you cannot edit, create or commit files in the repository checkout, and the file-writing
  and shell tools are withheld from this run — delivery is a decision you make and the server
  executes. READING the task's repository checkout is expected of you …".
- The Codex operator cannot call tools; it returns a JSON plan over `OPERATOR_PLAN_TOOLS =
  post_comment, open_packet, resolve_packet, set_goal, run_agent, transition_stage,
  deliver_for_review, update_branch_from_base, accept_completion, flag_context_conflict,
  set_dependencies` (OR:1739-1772), narrowed by the same gates (OR:1784-1849); the executor
  `executeCodexPlan` calls the SAME action functions (OR:2330-2640). Plan step fields: `tool`,
  `profileId`, `delivers`, `toStageId`, `packetType`, `text`, `reason`, `kbSource`, `repoSource`,
  `blockedBy`, `packetOptions[]` (OR:1875-1926). A withheld-everything Codex operator still gets the
  full list minus delivery/update-branch, and every step is then refused visibly (OR:1832-1848).

`gate(authority, capabilityId)` (OA:510-536), verified:

| Input | Result |
|---|---|
| `authority.deployed === false` (no operator deployment on the project, OA:401-426) | `deny` for everything |
| capability absent from the stored policy and in the absent-polarity table (OA:483-507) | `deliver-review-pr` → `absentDeliverReviewPrMode(humanGatedBeforeWork)` = `recommend` when every pre-terminal boundary is non-`auto`, else `direct` (`app/shared/capabilities.ts:630-633`, `stage-roles.ts:97-104`); `dispatch-agents` → `direct`; `update-task-branch` → whatever `deliverGate` gives; `use-web-search-fetch` → `direct` |
| stored `direct` | `direct` |
| stored `recommend` | `direct` under autonomy `full`, else `recommend`; EXCEPT `completion-for-acceptance`, which stays `recommend` under full autonomy (OA:525-533) |
| stored `human` or `off`, or absent and not in the table | `deny` |

`dispatchGate` = `gate(authority, "dispatch-agents")` (OA:592-596). Autonomy is a ceiling: a per-run
request above the configured level is clamped and audited `task.operator.autonomy_clamped` with
`{requested, ranAt, configured}` (OA:223, 253-294).

Seeded operator grants (SEED:89-116, catalog labels): direct = `Select & run agents`
(`dispatch-agents`), `Generate decision & blocking packets` (`generate-packets`), `Append typed
important events` (`append-typed-events`), `Deliver the branch & open the review PR`
(`deliver-review-pr`); recommend = `Stage transitions`, `Accept completion into Done`; forbidden =
`Execute code or write to the repo`, `Transition a task to Done`, `Change project policy`. Consequence
for the pass: on a Standard/balanced project the SUPERVISED operator dispatches agents and delivers
DIRECTLY (no card), recommends only stage moves across `approval` boundaries and acceptance.

### 12.2 Tool table (Claude names; Codex plan verb in parentheses when different)

| Tool | Params (zod) | Gate | Mode behaviour | Refusal / result sentences (verbatim) | Audit |
|---|---|---|---|---|---|
| `get_task` | none | always (TK:260-275) | returns `operatorSnapshot` JSON | n/a | none |
| `read_default_branch_file` | `path` | always, but only built when the run has a checkout (`deps.workspace`, TK:286-330) | reads `origin/<default>` | `[absent] \`<path>\` does NOT exist on \`<branch>\`.` / `[unavailable] \`<path>\` could not be read from \`<branch>\`: <reason>. Say so rather than substituting a read of the checkout — that tree is on the task branch.` / `[found] \`<path>\` on \`origin/<branch>\`, just refreshed from GitHub:` or `… as of this task's checkout (the refresh from GitHub did not run — treat it as slightly stale)`; `[truncated at <DEFAULT_BRANCH_READ_MAX_BYTES> characters]` | none |
| `post_comment` | `text` | `append-typed-events` (TK:341) | writes a `comment` event, actor `operator`, `toAgent: false`, through the guardrails (OA:640-770) | denied: `The operator cannot post events in this project.` (OA:2041); empty: `Empty comment ignored.`; a guardrail drop returns `noop` with the drop message (OA:2056-2058) | `task.operator.commented` `{}` (OA:754); drops audited by `recordCommentDrop` |
| `set_goal` | `goal`, `reason?` | `append-typed-events` (OA:2203) | WRITES `parsed.goal` immediately; if a packet is `awaiting: goal_edit` it is cleared and a `blocked` readiness lifted to `ready` (OA:2226-2238); timeline `note` titled `Goal drafted`: `The operator drafted the task goal: <reason>. Downstream agents re-anchor on the new goal.` or `The operator drafted the task goal from the request. …` (OA:2239-2251) | denied: `The operator cannot draft the goal in this project.`; `A goal of at least 3 characters is required.`; already specified (goal not blank and not `DEFAULT_GOAL`): `The goal is already specified. Open an edit_goal packet to propose a change instead of overwriting it.` (OA:2215-2221); `Goal unchanged.`; done: `Task goal drafted.` | `task.goal.updated` `{by: "operator"}` (OA:2257-2265); NOT a `goal-updated` operator trigger (the doctrine says so: "nothing re-invokes you for your own `set_goal`", OR:3753) |
| `flag_context_conflict` | `kbSource`, `repoSource`, `detail` | `append-typed-events` (OA:2092) | typed `quality` event + watcher notification kind `quality` titled `CONTEXT_CONFLICT_TITLE` (OA:2098-2131) | missing a side: `A conflict needs BOTH sources named: the knowledge-base document and the repository file it disagrees with.`; done: `Recorded: \`<repoSource>\` wins; a human will settle it.` | `task.operator.context_conflict` `{kbSource, repoSource}` (OA:2109-2117) |
| `open_decision_packet` (`open_packet`) | `packetType` (`input`/`blocked`), `title`, `body?`, `observations?[{k,v,code?}]`, `options[{kind,title,detail?,recommended?,backend?,profileId?,deleteBranch?,goalDraft?}]` | `generate-packets` (TK:410) | see §1-§2; the shared writer appends the R20-9 disclosure `_Disclosure: before opening this, the operator prompted <names> on this task — this decision is being raised with you by the operator, not by that agent._` whenever a `run_agent` in the SAME run returned `done` (TK:193-238) | denied: `The operator cannot open decision packets in this project.`; `A packet needs a title.`; `A packet needs at least one option.`; `Unknown packet option kind "<kind>". Valid kinds: …` (OA:1031-1050); second packet refused as `noop` (§2) | `task.operator.packet_opened` (OA:1260) |
| `set_dependencies` | `blockedBy[]` (FULL list, `[]` clears), `reason?` | `generate-packets` (OA:2157) | `setTaskDependencies` under `operatorAuthorized` | denied: `The operator cannot record what a task waits on in this project (the generate-packets grant is withheld).`; unchanged: `Unchanged: <KEY> already waits on <list>.` / `Unchanged: <KEY> waits on nothing.`; done: `Recorded: <KEY> waits on <list>. Viberr holds it and releases it when every entry is done.[ Reason: …]` / `Recorded: <KEY> no longer waits on other work.`; a validator 400 comes back as `noop` with the validator's sentence (OA:2186-2192) | `task.dependencies.updated` (via `setTaskDependencies`) |
| `resolve_decision_packet` (`resolve_packet`) | `reason` | `generate-packets` | withdraws the operator's OWN open packet | denied: `The operator cannot manage decision packets in this project.`; `No open decision packet to resolve.`; agent-raised packet: denied (OA:1326-1330); race: `The open packet on <KEY> changed before it could be withdrawn; nothing was removed.`; done: `Withdrew the packet "<title>".` | `task.operator.packet_withdrawn` (OA:1370) |
| `run_agent` | `profileId`, `prompt?`, `delivers?`, `reason?` | `dispatch-agents` via `dispatchGate` (TK:573, OA:2490) | see §12.3 | see §12.3 | `task.operator.agent_selected` (direct arm only, OA:2583) + `task.operator.recommended {kind:"run_agent"}` (recommend arm) |
| `deliver_for_review` | `reason?` | `deliver-review-pr` via `deliverGate` (TK:617) | direct → `performDelivery`; recommend → `delivery` card `Deliver the branch & open the review PR` or `Push \`<sha7>\` to PR #N` (OA:2678-2700) | denied: `Delivering the branch & opening the review PR is not permitted for the operator here.`; recommend-arm noop: `PR #N already carries the delivered revision \`<sha7>\`; there is nothing to deliver.` | `github.delivery.*` rows (§9), `task.operator.recommended {kind:"delivery"}` |
| `update_branch_from_base` | none | `update-task-branch` via `updateBranchGate` (TK:643) | server merge + push; conflict → blocking packet | see `update-branch-operator.server.ts` (§2.1 row I) | `github.branch_update.operator` |
| `transition_stage` | `toStageId`, `reason?` | `stage-transitions` (OA:2789) | see §12.5 | denied: `Stage transitions are not permitted for the operator here.`; recommended: `Recommended moving the task to <Stage name>.`; done: `Moved <KEY> to <stageId>.` (OA:2846, 2853) | `task.transition {from, to, boundary, by:"operator"}` (TA:5028-5045); card path `task.operator.recommended {kind:"transition"}` |
| `accept_completion` | none | `completion-for-acceptance` (TK:683; withheld or `human` = tool not built; full autonomy never promotes `recommend`) | direct (full autonomy + `direct`) → Done, `pr.state: accepted`; otherwise `accept_completion` card | hard refusal: `Accepting completion is not permitted for the operator here: that capability is reserved for a human here|that capability is withheld from the operator here, so I am not recommending it either. <KEY> stays where it is; a maintainer accepts it on the task page.` (OA:2946-2963); `<KEY> is already Done.` | `task.operator.accepted_completion` / `task.operator.recommended_completion` |

Every tool result reaches the model as one text block `[<outcome>] <message>` with `outcome ∈ done |
recommended | denied | noop` (TK:127-129). On Codex, `denied` steps are narrated as "refused by its
capability policy" and `noop` steps as state refusals by `narrateRefusedActions` (OR:2470-2490,
2648-2735); a throwing step aborts the rest of the plan with the operator note `**Coordination
stopped:** the \`<tool>\` step failed (<message>). The remaining plan was not executed.` (OR:2603-2625).

### 12.3 `run_agent` in full (OA:2473-2618, SR:1184-2225)

Argument semantics (TK:576-611): "Pass a concrete `prompt` when handing off work — it is posted as
your comment and becomes the run's directive; omit it only to re-run an agent against the task as it
stands. `delivers: true` explicitly hands delivery to this profile (reassigning the current
deliverer)." Codex mirror: `text` = prompt, `delivers` nullable (OR:2500-2517).

Order of checks and outcomes:

| Step | Condition | Outcome / sentence |
|---|---|---|
| 1 | `dispatchGate === "deny"` | denied: `Dispatching agents is not permitted for the operator here.` (OA:2491-2496) |
| 2 | profile not in `listDeployedSpecialists` | noop: `No deployed agent "<id>" to run. Pick a profile from get_task's deployedSpecialists.` (OA:2498-2503) |
| 3 | prompt names an org MCP the profile lacks | prompt gets appended `(Note from Viberr: <Agent> holds no MCP grant for \`<name>\` on this project, so those tools will not be available to it — any evidence from them is already on the task timeline. Do not hunt for them.)` (OA:2313-2334) |
| 4 | `delivers: true` and `capabilities.delivery === false` | noop: `<Agent> holds no repo-write grant, so it cannot own delivery. Run it as a supporting agent (omit \`delivers\`), or a human grants "Execute code or write to the repo" on the project's Agents surface.` (OA:2510-2518) |
| 5 | `delivers: false` aimed at the current deliverer | noop: `<Agent> IS the delivering agent on this task — its runs deliver. Omit \`delivers\` to run it, or hand delivery to another repo-write profile first (\`delivers: true\` on that profile).` (OA:2529-2537) |
| 6 | posture resolved by `resolveDeliversIntent` (OA:2437-2456): explicit hint wins; the current deliverer stays delivering; an already-engaged profile keeps its shape; an UNENGAGED profile delivers iff the task has no deliverer AND `capabilities.delivery` | `as` = `the delivering agent` / `a reviewer` (verdict grant) / `a supporting agent` (OA:2283-2291, 2545-2547) |
| 7 | gate `recommend` | ONE `run_agent` card `Run <Agent>` with `profileId`, `prompt`, explicit `delivers`; detail = `reason ?? prompt ?? "<Agent> fits what the current stage needs; a maintainer starts the run."`; result `Recommended running <Agent> as <as>.` (OA:2549-2573). Apply dispatches with `triggeredByName` = the applying human (TA:9570-9595) |
| 8 | gate `direct` | audit `task.operator.agent_selected` FIRST (OA:2583, details below); if delivering, `ensureTaskBranchBestEffort` (OA:2584-2588) |
| 9a | prompt given | `operatorPromptAgent`: posts an operator `comment` with `toAgent: true` whose text is `@<Agent name> <prompt>` (mention prepended unless the prompt already starts with `@`, TA:4356-4364), fans out human @mentions, then `startAgentRun({directive})`; result `Prompted @<Agent> (<as>) and started its run.` (OA:2589-2606, TA:4261-4351) |
| 9b | no prompt | `startAgentRun` bare; result `Started a Claude|Codex run for <Agent> (<as>).` (OA:2607-2617) |
| 10 | `startAgentRun` throws after the comment was posted | policy-engine `note`: `**Note:** the prompt above did NOT start a run: <message> The directive needs to be re-sent once the blocker is resolved.` (TA:4318-4333); the tool call itself throws (the model sees an error, not a `[noop]`) |

`startAgentRun` refusals the operator can hit (thrown `AppError`, SR): archived: `<KEY> is archived —
restore it before running an agent on it.` (SR:1229-1233); undeployed: `"<id>" is not deployed on this
project. Deploy it on the Agents page first.` (SR:1252-1256); hand-off without repo-write (both doors):
`<Name> holds no repo-write grant, so it cannot own delivery. Run it as a supporting agent, or grant
"Execute code or write to the repo" on the Agents page.` (SR:1263-1269, 1319-1327); replacing a
deliverer whose run is live: `<KEY>'s current deliverer has a run in flight (<runId>). Interrupt it
first, then assign <Name> — replacing the deliverer mid-run leaves that run delivering under a profile
the task no longer names.` (SR:760-766); second delivering run: 409 `A delivering agent run is already
in progress on this task — wait for it to finish or interrupt it before starting another.`
(SR:1370-1383); same supporting engagement twice: 409 `This agent already has a run in progress on
this task — wait for it to finish or interrupt it before starting another.` (SR:1401-1413); stage
eligibility (ruling 133, `runEligibilityFor` SR:3731-3742, sentence SR:3690-3701): `<Name> is not
eligible for the "<stageId>" stage — its profile is scoped to <resolved stage ids>. Change the task's
stage or the profile's eligible stages.` The sentence prints the stage ID (`review`), not the name.
The engaged deliverer passes at every stage with `why: "engaged-deliverer"`; a supporting engagement
and an unengaged profile are judged by their declared stages. There is NO per-turn dispatch count cap
in `operatorDispatchAgent`; the only loop bounds are `OPERATOR_REACT_DEPTH_CAP = 4` (TA:207) and
`OPERATOR_TRANSITION_CHAIN_CAP = 8` (TA:5077-5094) plus the single-flight 409s above.

Engagement side effects (SR:719-1000): first delivering dispatch writes `engagements[]`
`{profileId, backend, role, delivers: true, verdictCapable}` and the `agent` event `Deployed **<Name>**
(<role>, <Claude|Codex>) as the delivering agent.` (audit `task.specialist.assigned`); a hand-off writes
`Delivery handed off from **<oldProfileId>** to **<Name>** (<role>, <backend>).` (audit
`task.delivery.handoff`); a supporting dispatch writes `Engaged **<Name>** (<role>, <backend>) as a
reviewer|a supporting agent` (audit `task.reviewer.assigned`). Then the run itself writes `Started a
<Claude|Codex> run for the <role> agent — streaming to the agent logs.` (SR:2126-2131), a `policy` event
`The operator directive asked the specialist to push or open/merge a pull request. …` when the prompt
matches `directiveRequestsDelivery` (SR:2134-2146), sets `waiting: agent` (SR:2185), and audits
`task.agent.run_started` (below).

Seeded specialists the operator chooses between (SEED:120-198): `developer` (name `Developer`, role
`Implementation`, stages `["ready","impl"]`, delivery + browser + web + askHuman, model `sonnet`,
backend claude) and `reviewer` (name `Reviewer`, role `Review & validation`, stages `["impl","review"]`,
verdict + askHuman, `commit-push-branch: human`, no delivery). Standard template stages
`triage → ready → impl → review → done` with boundaries `auto, auto, approval, human` (TPL:40-78).
So on a default board: at `ready` only Developer is newly engageable; at `review` the Reviewer is newly
engageable and the Developer runs only as the engaged deliverer (`engaged-deliverer`); a Reviewer
`delivers: true` is refused at step 4.

### 12.4 The roster the operator sees (`get_task` → `operatorSnapshot`, OA:1811-2027)

Top-level keys: `key, title, goal, priority, labels, dueDate, blockedBy[], stage, stageName,
previousStage{id,name}|null, readiness, waiting, validation, owner, specialist{profileId,role,backend}|null,
reviewers[{profileId,role,backend,verdict}], nextStages[{id,name,boundary}], reworkStages[{id,name}]
(non-empty only while `validation === "failing"`, OA:1842-1848), stageIds[], doneStageId, reviewStageId,
workStageId, deployedSpecialists[], openPacket, packet{type,title,body,options[titles],awaiting}|null,
recentTimeline[6]{type,actor,text≤1500}, recommendations{pending[≤5],declined[]}, pr{number,state,title,
revisionDrift,revisionDriftSentence,headSha,unpushedRevision,unpushedRevisionSentence}|null, branch,
unownedPr, repo, noChanges, liveRuns[{kind,profileId,state}] (from `agent_runs` state IN queued|running,
OA:1995-2010), autonomy, operatorPolicy{scope:"operator", note, capabilities{id:mode}},
orgResources{kbs,skills,mcps}`.

Each `deployedSpecialists[]` entry (SR:3606-3650 + OA:1907-1927): `id, name, role, backend, model,
effort, desc, capabilities{delivery, verdict, askHuman, browser, web}, resources{skills,mcps,kb},
stages[], spanAll, modelUnavailable?, eligibleForCurrentStage, engagedAsDeliverer`. The tool
description tells the model to "SELECT agents by each profile's `desc` (its purpose) and
`capabilities` … never by guessing from names" (TK:263). Neither prompt builder renders a separate
roster block: Claude receives only `You are operating <KEY>, "<title>", at stage "<name>".\nGoal:
<goal>\n\nCall \`get_task\` first; its live state and offered tools are authoritative.` (OR:3923-3924);
Codex receives the whole snapshot JSON under `# Task snapshot` (OR:3886-3888). `OPERATOR_POLICY_SCOPE_NOTE`
(OA:1765-1774) rides both the snapshot and the system prompt.

System prompt blocks, in order (OR:3236-3444): shipped definition
`app/server/seed/assets/operator.definition.md` (+ `# Project operator guidance` when the persona
differs); `# Attached resources (trusted — configured for you)` + skill/KB bodies; `# Your runtime` =
`You are running on the **Claude|Codex** backend, model \`<model>\`, reasoning effort \`<effort>\`.`
+ `Attached MCP servers: …` or `No MCP servers are attached to you.` (OR:3338-3350); `# Your workspace`
(OR:3149-3234: `A read-only checkout of **<repo>** is at \`./<relativeDir>/\`. …` or `NO checkout of
**<repo>** is available on this run. <sentence>`); MCP governance / unhealthy / unresolved / missing
resource blocks; `# Live authority — YOUR OWN capability policy` with `Autonomy: **<level>**.` and one
`- <id>: <mode>` line per stored grant (absent-polarity capabilities are NOT listed, OR:3265-3267);
`# Triage signals (advisory)`; `# Non-negotiable rules`.

### 12.5 `transition_stage` (OA:2783-2854)

| Case | Behaviour |
|---|---|
| gate `deny` | `Stage transitions are not permitted for the operator here.` |
| gate `recommend` and target is the terminal stage | rerouted to `operatorAcceptCompletion` (OA:2824-2831): acceptance gates and the `completion-for-acceptance` refusal answer, never a "Move to Done" card |
| gate `recommend`, boundary `approval`/`human`, not rework | card `transition` `Move the task to <Name>` with detail `reason ?? "The work is ready to advance to <Name>."`; sets `waiting: human`; result `Recommended moving the task to <Name>.` (OA:2832-2847) |
| boundary `auto` (any gate but deny) | performed directly even under supervised autonomy (OA:2793-2799) |
| rework move: target index < current index AND `validation === "failing"` (OA:2886-2903) | performed directly with `rework: true`; the off-graph edge is re-validated inside `transitionStage` |
| performed | `transitionStage` under `operatorAuthorized`: writes `previousStageId = from`, `heldAtStage = null`, on leaving the entry stage `operator = {assignedAtStageId: <to>}` when null and readiness `input_required → ready` (TA:4966-4992); audit `task.transition {from, to, boundary, by: "operator"}` (TA:5028-5045); fires `autoInvokeOperator(..., "transition", {transitionDepth, transition:{fromName,toName,byHuman:null}})` unless the target is the last stage (TA:5095-5115) |

### 12.6 Per-trigger instruction text (OR:3594-3771, both backends via `operatorTurnInstruction`)

Every turn ends with `CAPABILITY_GAP_REMEDY_INSTRUCTION` (OR:3502-3514: "If what the task needs is a
CAPABILITY no deployed agent declares … name the product's own remedy: the capability is grantable on
an agent profile from the project's Agents surface (Agents → the profile → its capability matrix) …").
Precedence inside `operatorTurnDoctrine`: a human comment wins over everything; then a non-empty
`blockedBy` (held doctrine, except on `dependencies-released`); then the trigger arm.

| Trigger (fired by) | Instruction (verbatim head) |
|---|---|
| any with `humanComment` (`@operator …` comment → `runOperator({trigger:"manual", humanComment, humanCommentBy})`, TA:1628-1645) | `A human (<name>) addressed you directly: "<text>" Respond from the live task state, then take only the coordination action it warrants — ONE reply that answers everything quoted above, not one per message. If no action is needed, leave one concise reply.` + (packet open) ` A decision packet is ALREADY OPEN on this task and may already cover what they are asking: answer from it. \`open_decision_packet\` is REFUSED while it stands (B3) …` + ` Address them by name in the reply you post — tag them "@<name>" so they are notified.` (OR:3605-3628) |
| held (`blockedBy` non-empty) | `This task WAITS ON OTHER WORK and Viberr is holding it: <label (state)>, …. While the list is non-empty: do NOT advance the stage, do NOT dispatch delivery work (no \`run_agent\` for a deliverer, no \`deliver_for_review\`), and do NOT open a decision packet about the wait; …` (OR:3829-3837). Fire-time: `create`, `transition`, `scheduled` are refused `blocked-by` before a run exists (OR:286) |
| `goal-updated` (`updateTaskGoal`, TA:826) | `The goal was edited. If it now supplies the input requested by the open packet, resolve that packet as moot. Continue the current stage using the new goal. If it is still not actionable, state the missing input once; do not open a duplicate packet. ` + triage gate (OR:3641-3649) |
| `agent-reply` (completion pipeline, TA:4176-4185; the report is embedded as `# Agent report` in a ```text fence, first 4,000 chars, OR:3472-3477) | `React to the report above. When the deliverer reports completed, committed work that is plausibly reviewable, deliver it with \`deliver_for_review\` (push + review PR — YOUR decision, see the stage rules) and move the task toward review; accept a clean review through \`accept_completion\`. Rework on a task whose PR is already open is delivered the same way: \`deliver_for_review\` pushes the new revision to that PR. If review requests changes, move back to the work stage and \`run_agent\` the delivering profile with the concrete findings as its prompt. Re-prompt the same profile only when its work is incomplete, never merely to repeat the report.` (OR:3650-3657). NOTE: no stage rule and no triage gate are appended to this arm |
| `pr-diverged` | four arms by `pr.state` (closed at terminal / closed / merged / live again), each starting `GitHub reports …` (OR:3658-3700; §2.1 row K) |
| `packet-resolved` | `A human just answered your decision packet: **<title>**[ — the human added: "<note>"][ Viberr then performed that option's own steps and reports, in its own words and not the person's: <sentence>]. The packet is now resolved. Act on that decision from the live snapshot and take the ONE coordination step it warrants Assume NOTHING about credentials or policy …` + triage gate (OR:3702-3725; note the missing full stop before `Assume`, verbatim) |
| `dependencies-released` | `The work this task waited on has landed: <who> cleared the wait on <entries>|<entries> is done. Viberr released the task … The base branch has CHANGED since the hold: any specialist you dispatch must start from a fresh read of it (say so in the prompt) …` + triage gate + stage rule (OR:3840-3854, 3727-3729) |
| `delivered` (full-autonomy delivery that opened/moved the PR) | `The review pull request #N was just opened for this task's delivered work — delivery is DONE, do not deliver again. Take the ONE next coordination step from the live snapshot: if no reviewer is engaged and the stage calls for review, \`run_agent\` a verdict-capable profile with a review prompt (\`delivers: false\`); if a review has already passed, \`accept_completion\` per policy; if a stage move is needed to reach review, \`transition_stage\`. If the reviewer's run is already IN FLIGHT (\`liveRuns\`), do nothing and stop — you are re-invoked when it reports.` (OR:3731-3744) |
| `create` (TA:744), `transition` (TA:5097), `scheduled`, `manual` without a comment | `<resumeContext><scheduleContext><moveContext><scope><triageQualityGate><stageRule>` (OR:3749-3770): resume = `You are re-invoked ONCE because your previous run ended with this auto-advance stage idle: … record the hold so it is a decision instead of a stall: \`open_decision_packet\` asking the human to confirm the hold …`; schedule = `This run fired from a SCHEDULED re-check a human set earlier, for this stated reason: "<note>". Honor that reason first …` or `… with no stated reason. Re-read the live state and continue the stage below. `; move = `A human (<name>) moved this task from "<From>" to "<To>". Their reason should be in the newest timeline entries … If you cannot tell WHY the task moved, ask them in ONE comment — tag "@<name>" so they are notified — and stop. Never guess a rework direction. ` or `You moved this task from "<From>" to "<To>" — continue coordinating at the new stage. `; scope (goal blank or `DEFAULT_GOAL`, OR:3448-3451) = `The goal is unspecified. First use \`set_goal\` to add concrete scope and acceptance criteria, or request genuinely missing scope with one decision packet. Drafting the goal is SETUP, not this turn's action — after \`set_goal\`, continue with the stage rule below in the SAME run; nothing re-invokes you for your own \`set_goal\`. ` |

Triage quality gate (OR:3526-3548), emitted only when `stage === stageIds[0]` and that stage is neither
the work nor the done stage: `TRIAGE QUALITY GATE — this is the first stage, so scoping is this turn's
job and no forward transition happens until the goal survives it. A goal is CONCRETE only when it names
a deliverable (what changes, and where) AND the signal that proves it done. "The documentation could be
improved. Make it better." is a wish, not a goal: no file, no change, no acceptance criteria. While the
goal is that vague you MUST NOT \`transition_stage\` forward: either \`set_goal\` with real scope when
the task text, comments, and repository make it unambiguous, or \`open_decision_packet\` (type "input")
proposing 2–4 concrete scopes for the human to choose between. Reading the repository is not scoping —
a scope you invented is the failure this gate exists to stop. If the goal IS concrete, say why in the
transition \`reason\`: name the deliverable and the acceptance signal. If you cannot write that
sentence, it is not concrete. If the goal DELEGATED a clarifying question to the delivering agent …
you may gather that answer yourself with an \`open_decision_packet\` (type "input") … but SAY SO in the
packet body …`. The seeded persona adds the stronger form: "READ THE REPOSITORY CHECKOUT FIRST with
`Read`, `Grep`, and `Glob`, so every option you write names a path that exists"
(`operator.definition.md` line 23). The gate is BEHAVIOURAL only: nothing in `transitionStage` refuses
a forward move on a vague goal (docs/domain/task-lifecycle.md:95-97, verified: no goal check in
TA:4940-5000).

Stage rule (OR:3774-3791), verbatim bullets the observer should grade against: `You are at stage
"<Name>", arrived from "<Prev>". Choose which agent to run from what THIS stage needs and where the task
just came from …`; `- Pre-work stage with an \`auto\` outbound boundary (e.g. Triage → Ready, Ready → In
Progress): advance it with \`transition_stage\`. …`; `- Work stage with no deliverer engaged yet: choose
the delivering profile by description and capabilities and hand off with \`run_agent\` and a concrete
prompt (its repo-write grant makes it the deliverer); a supporting review run passes \`delivers:
false\`.`; `- Work stage where the deliverer's run is IN FLIGHT — \`liveRuns\` in the snapshot is the
ONLY proof of that …: do nothing and stop`; `- Work stage where the deliverer already reported and its
report is still the LATEST word …: do nothing and stop.`; `- Work stage where a human steer, rework
decision, or request-changes arrived AFTER the deliverer's last report …: the deliverer owes NEW work —
\`run_agent\` the delivering profile with that steer as its prompt, quoting it. …`; `- DELIVERY (push
the branch + open the review PR) is YOUR decision, made with \`deliver_for_review\` …`; `- A directive
you sent earlier that never became a run is an UNDELIVERED hand-off — the timeline says so ("did NOT
start a run") … re-send the prompt yourself`; tail: `Take exactly one such action and stop. NEVER end
your turn leaving the task at a pre-work or \`auto\` stage with nothing done and no packet: either
advance the boundary, hand off to a specialist, or \`open_decision_packet\` when a human must scope or
unblock it. A pre-work stage that needs no human input must never be left waiting on a human.`

### 12.7 Triage walk-through (Standard board, seeded operator, supervised)

| Input | Expected correct turn | On-disk proof |
|---|---|---|
| New task, goal left blank → stored as `DEFAULT_GOAL = "Goal to be refined at the triage quality gate."` (TA:476, 672); `readiness: input_required`, `waiting: human`, `operator: null`, `previousStageId: null`, `heldAtStage: null` (TA:620-649); `create` trigger (TA:744) | Turn text = scope sentence + triage gate + stage rule. Correct: (a) read the checkout, (b) EITHER `set_goal` (only if title + repo make scope unambiguous) THEN `transition_stage(ready)` in the same run with a reason naming deliverable + acceptance signal, OR `open_decision_packet(input)` with 2-4 scope options (`edit_goal` + `goalDraft`, or `custom`). Wrong: a forward transition with the placeholder goal; a packet whose options only workaround a missing capability; ending with nothing done and no packet (then the stranded backstop fires once, §12.8) | `set_goal`: task.md `goal` replaced, `Goal drafted` note, audit `task.goal.updated {by:"operator"}`; packet: `task.operator.packet_opened`, `packet_json` (§9); transition: `task.transition {from:"triage", to:"ready", boundary:"auto", by:"operator"}`, task.md `operator.assignedAtStageId: ready`, `readiness: ready`, `previousStageId: triage`; the operator's own transition re-invokes it with `transition` (TA:5097) |
| New task with a concrete goal ("Scaffold the k9s clone: … `go build ./...` passes") | No `set_goal` (it would return `The goal is already specified …`); `transition_stage(ready, reason)`, one auto boundary, stop; re-invoked at `ready` → `transition_stage(impl)` (second auto boundary) → re-invoked at `impl` → `run_agent(developer, prompt)` | Two `task.transition` rows `by: "operator"`, then `task.operator.agent_selected`, `task.specialist.assigned`, `task.agent.run_started {delivers:true, stageEligibility:"declared"}`; `agent_runs.kind = 'primary'` |
| Goal edited by a human while an `edit_goal` packet awaits | `updateTaskGoal` clears the packet and fires `goal-updated` (TA:826); operator continues the stage; a still-vague edit must not buy a transition (triage gate re-appended) | `Packet resolved` note (§1), then the transition or a new packet |
| Task at `impl`, deliverer reported "done, committed" | `agent-reply` arm: `update_branch_from_base` (persona) → `deliver_for_review` (direct on seed) → `transition_stage(review)` = a `Move the task to Review` CARD (approval boundary, recommend) | `github.delivery.*`, `task.operator.recommended {kind:"transition"}`, `recommendation_count = 1`, `waiting: human`, timeline `**Recommendation:** Move the task to Review. <reason>`, notification `Operator recommends: Move the task to Review` |
| Task at `review` (human applied the card) | `transition` trigger with `byHuman: <name>`; stage rule → `run_agent(reviewer, "review …", delivers:false)`; `Reviewer` engages as `a reviewer` (verdict grant) | `Engaged **Reviewer** (Review & validation, Claude) as a reviewer`, `task.reviewer.assigned`, `task.agent.run_started {delivers:false, stageEligibility:"declared"}`, `agent_runs.kind = 'reviewer'` |
| Reviewer requests changes (`validation: failing`) | `agent-reply` arm: `transition_stage(impl)` is a REWORK move performed directly (`reworkStages` lists `triage, ready, impl`), then `run_agent(developer, findings)`; Developer at `impl` is `declared`; had the operator re-prompted at `review` it would pass as `engaged-deliverer` | `task.transition {from:"review", to:"impl", boundary:"manual", by:"operator"}` (an off-graph edge records boundary `manual`, TA:5031), `previousStageId: review`, then the run rows |

What the operator writes to task.md itself: `goal` (set_goal), `packet` (open/withdraw), `blockedBy`
(set_dependencies), `recommendations[]` + `waiting: human` (any recommend arm), `timeline[]` comments
(`actor.kind: operator`, `toAgent: true` for hand-offs). It never writes `operator`, `heldAtStage`,
`previousStageId` or `engagements[]` directly: those are written by `transitionStage` (TA:4966-4979),
the stranded settle (OR:962) and the dispatch (SR:719-1000) respectively.

### 12.8 Deliberate holds, stranded settle and loop caps

- Stranded predicate `operatorLeftTaskStranded` (OR:815-832): not archived, no packet, no
  recommendation, `blockedBy` empty, and the current stage has an outbound `auto` boundary.
- `maybeResumeStrandedOperator` (OR:843-1000) re-invokes ONCE with `strandedResume: true` after a
  cleanly `finished` drive that left the stage unchanged. If a `heldAtStage === stage` marker already
  stands it stays quiet (OR:936-944). If the nudged drive strands again it writes `heldAtStage = stage`
  and the policy-engine note `**Note:** this stage auto-advances, but the operator held it twice in a row
  without advancing, dispatching, or opening a packet — treating that as a deliberate hold. Coordination
  is paused here: run the operator manually when the hold should end, adjust the goal, or loosen the
  boundary in Policy → Workflow rules.` (OR:949-990). Any real transition (TA:4969), a packet resolution
  (TA:7251) and a goal edit (TA:777) clear `heldAtStage`; an emptied `blockedBy` clears it too
  (`dependencies.server.ts:301, 353`).
- React chain: `operatorShouldReactToReply` (TA:229-239) reacts only when the run `finished`, the reply
  is non-empty, differs from the previous stored reply (cc line stripped, TA:2076-2084) and
  `reactDepth < 4`. Otherwise `openStuckLoopPacket` (TA:2525-2600): `blocked` packet `Work stalled: pick
  a recovery path`, body `<reason> Coordination is paused until a human chooses how to proceed.`,
  observations `Agent: @<handle>`, `Signal: <reason>`; reasons `The agent repeated its previous report
  verbatim, with no forward progress.` or `The coordination loop hit its 4-cycle depth cap without
  reaching a boundary.`; options `Redirect with sharper guidance` (recommended), `Send back for another
  attempt`, `Hold for runtime debugging`. Transition chain cap 8 opens the same packet with reason
  `The operator made 8 consecutive stage transitions with no agent run or human action in between,
  which is a coordination loop.` (TA:5077-5094).
- Fire-time refusals (OR:282-289): `open-packet` for `manual` and `scheduled`; `blocked-by` for
  `create`, `transition`, `scheduled`; `terminal-stage`. `autoInvokeOperator` that THROWS before a run
  row exists writes the note `The operator could not be started automatically (<message>). Coordination
  is paused for this task; run the operator manually when you're ready.` (TA:1119-1125).

### 12.9 Dispatch-completion contract (ruling 98(c)): cc-append and always-react

| Half | Mechanism | Verified |
|---|---|---|
| Arming | `startAgentRun({triggeredByName, triggeredByUserId})` is set by: an `@<agent>` comment (`triggeredByName: commenterName`, TA:1876-1882), Apply on a `run_agent` card (`userName(db, actor.userId)`, TA:9584-9588), a schedule (`schedule.server.ts:381-383`), the manual Run control. The OPERATOR's own `run_agent` passes NO `triggeredByName` (OA:2589-2613, SR:1857) | SR:1170-1182, 2213-2218 |
| Persistence | `registerAgentCompletion` patches `dispatchedByName`/`dispatchedByUserId` onto the run row so a restart keeps the contract | TA:3410-3416 |
| Guidance half | the agent prompt gets `## Reporting back\nThis run was dispatched by <name>. Close your final report by tagging "@<name>" (so they are notified) and "@operator" (so the coordinator picks your results up).` | SR:2766-2775 |
| cc-append | before the reply is stored: if the dispatcher is not notified by the reply's mentions (resolved through the mention ladder by user id) and/or `@operator` is absent, append `\n\ncc @<name> @operator` (only the missing ones) | TA:3600-3624 |
| always-react | `mustReact = dispatchedByName && state === "finished" && reactDepth < 4` bypasses the no-progress heuristic for THIS hop only; the operator then runs with `trigger: "agent-reply"` and the reply embedded | TA:4130-4133, 4176-4185 |
| Operator-dispatched runs | react through the ordinary heuristic (`ctx.operatorRun` carries `reactDepth`, OR:1620-1627); a verbatim-repeated report ends in the stuck-loop packet, not a react | TA:4074-4160 |

Timeline text the contract leaves: the agent's stored reply comment ends with the literal line
`cc @<Name> @operator` (or just the missing handle); no separate note is written. The operator's
`agent-reply` turn then posts whatever it decides (its own comment, a card, a packet or a hand-off).

### 12.10 On-disk proof rows

Tables: `audit_events(id, occurred_at, actor_user_id, actor_label, action, subject_kind, subject_id,
project_slug, task_key, details_json)` (`app/server/audit/audit-recorder.server.ts:65-79`);
`agent_runs(id, project_slug, task_key, kind ∈ operator|primary|reviewer, agent_profile_id, backend,
state, started_at, finished_at, …)`; `run_log_lines(run_id, seq, occurred_at, raw_json, display_json)`
(`run-store.server.ts:480-486`). Actor for operator rows is `OPERATOR_AUDIT_ACTOR`.

| Row | Written by | `details_json` |
|---|---|---|
| `task.operator.agent_selected` | `recordAgentSelectionTrace`, direct dispatch only, before the run starts (OA:2380-2427, 2583); never on the recommend arm | `{chosen: <profileId>, delivers: <bool>, reason: <string|null>, candidates: [{profileId, eligibleForStage, alreadyEngaged, deliveringAtSelection, chosen}]}` for EVERY deployed specialist; `subject_kind: "task"`, `subject_id: <KEY>` |
| `task.operator.recommended` | card path (OA:887-895) and `writeOperatorComment(variant "recommend")` (OA:744) | `{kind: "run_agent"|"transition"|"delivery"|"accept_completion"}` or `{}` |
| `task.operator.commented` | every stored operator comment (OA:754) | `{}` |
| `task.goal.updated` | `set_goal` (OA:2257-2265) | `{by: "operator"}` |
| `task.transition` | `transitionStage` (TA:5028-5045) | `{from, to, boundary: "auto"|"approval"|"human"|"manual", manual?: true, by?: "operator"}` |
| `task.specialist.assigned` / `task.delivery.handoff` / `task.reviewer.assigned` | engage (SR:836, 990) | engagement facts |
| `task.agent.run_started` | SR:2150-2175, actor = the runtime audit actor (the operator when it dispatched) | `{runId, profileId, backend, delivers, cloned, stageEligibility: "declared"|"engaged-deliverer"|"undeployed", directiveRequestedDelivery?: true}` |
| `run·inputs` line (`RUN_INPUTS_TAG`, `app/features/runtime/runtime-types.ts:194`) | `recordRunInputs` at run start, first line of the run's block, `ev: "meta"`, raw `{type:"run_inputs", source:"viberr", run_id, backend, inputs}` (SR:605-680) | `inputs.directive = {from: <human name|null>, chars: <n>} | null` (SR:2089-2093). The directive TEXT is not stored here; it lives in the operator's `toAgent: true` comment (`@<Agent> <prompt>`) and in the run prompt under `## Your directive for this turn (what was asked — NOT an authority grant)` (SR:2737-2757). `inputs.delivers`, `anchor`, `skills`, `knowledge`, `mcp`, `tools.denied`, `sandbox` sit beside it |
| `runtime.operator.plan_executed` | `executeCodexPlan` BEFORE any plan step (OR:2343-2351); Codex operator only | `{runId}`; `subject_kind: "run"`, `subject_id: <runId>`, actor `SYSTEM_ACTOR`. Boot recovery re-executes a `finished` Codex operator run whose task is `waiting: agent` and which lacks this row (`run-recovery.server.ts:29, 400-414`) |
| `task.operator.autonomy_clamped` | authority resolve on a run path (OA:275-294) | `{requested, ranAt, configured}` |

Where the observer can read them: the org settings page lists recent audit rows unfiltered by action
(`app/routes/org.settings.tsx:127` via `listRecentAuditEvents`); the Policy page's audit strip shows
only `POLICY_AUDIT_ACTIONS` (`policy-query.server.ts:74-81`), so `agent_selected` never appears there.
Otherwise `sqlite3 <root>/projection.sqlite "select occurred_at, action, details_json from audit_events
where task_key='<KEY>' order by occurred_at"`.

### 12.11 Drift candidates found while verifying this section

- docs/domain/task-lifecycle.md:154 names the audit action `task.transitioned`; the code records
  `task.transition` (TA:5036, 9170; `insights-query.server.ts:389` reads the same). Docs wrong.
- docs/domain/operator.md §5 says `set_goal` "drafts for a human to save"; the code writes the goal
  into task.md immediately (OA:2226-2252) with no human save step. Docs wrong; the `Goal drafted`
  note is the only human-facing trace.
- docs/domain/agents-and-runtime.md §4.1 says "a second deliverer is refused"; the code auto-engages a
  repo-write profile dispatched while a deliverer exists as SUPPORTING (OA:2455, SR:1258-1260) and
  honours `delivers: true` as a hand-off, refusing only while the current deliverer's run is live
  (SR:755-766). Docs overstate.
- Prompt-vs-policy: the `run_agent` tool description promises "Supervised → ONE run-agent
  recommendation card; full autonomy → runs directly" (TK:577), but the gate is the `dispatch-agents`
  MODE, which the seed ships `direct`, so a supervised operator dispatches directly. A model that
  believes the description may narrate "I have recommended running X" after it already started the run.
  Worth listening for in operator comments.
- Prompt inconsistency: the stage rule says "Rework on a task whose PR is already open …" and the
  seeded persona says "Sending the task back is a workflow choice"; both fine. But the `agent-reply` arm
  carries NO stage rule and NO triage gate (OR:3650-3657), so an agent report that lands while the task
  still sits at the entry stage (possible via a human `@developer` mention at triage on a `spanAll`
  profile) gets no scoping doctrine at all. Edge case, seeded profiles are not `spanAll`.
- The `packet-resolved` instruction lacks a full stop between "…warrants" and "Assume NOTHING…"
  (OR:3720-3721). Cosmetic; quoted verbatim above so the observer does not treat it as a corruption.
- docs/domain/operator.md §3 says `manual` is also fired by the controller's `run_agent_on_task`:
  verified in `app/server/controller/controller-toolkit.server.ts:1391, 1426` (`trigger: "manual"`,
  the operator arm of that tool). Not drift; recorded because the existing §9 cites the controller
  toolkit under `app/server/tasks/`, which is the wrong directory (it is `app/server/controller/`).
