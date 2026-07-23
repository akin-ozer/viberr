# Agents, Operator, and Runtimes — canonical reference (pass 11, 2026-07-23)

Audience: implementation subagents with **zero other context**. Everything here was
verified against source on 2026-07-23 (main, post-PR-#84). All paths are repo-relative;
line numbers are from that snapshot and may drift a few lines.

Mental model in one paragraph: Viberr is a file-canonical task board
(`tasks/<KEY>/task.md` + `projects/<slug>/project.md` are truth; SQLite holds
projections). Every non-operator agent is **ONE uniform machinery** — a "specialist"
profile (persona + skills/KB/MCP resources + capability grants) engaged on a task via
`engagements[]`. Behavior differences come ONLY from profile data + capability grants,
never from code paths keyed on agent type. The **operator** is a separate coordinator
profile that never writes code: it drives a task between stages with governance tools
(Claude, in-process MCP) or a structured JSON plan (Codex). Real work runs on two
backends via official SDKs: `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk`.

---

## 1. Profile & deployment data model

Two layers (`app/features/agents/agents-query.server.ts:23-36`):

1. **Org template files** — `${VIBERR_DATA_ROOT}/agents/profiles/<id>.md`
   (frontmatter: `kind: operator|specialist`, `name`, `role`, `backends`, `model`,
   `stages`, `spanAll`, `resources: {skills, mcps, kb}`, `desc`; markdown body = the
   long persona). CRUD in `app/server/org/gagents.server.ts` (specialists only — the
   `operator` template is a system profile, never listed/deletable there,
   gagents.server.ts:116-133, 253-258).
2. **Project deployments** — `project.md` frontmatter `agents:` array
   (`app/schemas/project-file.schema.ts:128-142`): `{profileId, capabilities:
   CapabilityGrant[], extras, definition?}`. `definition` is a loose per-field override
   (schema at project-file.schema.ts:85-121) carrying `persona` (long instructions),
   `model`, `effort`, `backends`, `stages`, `autonomy` (operator only), `resources`, etc.
   Project-created profiles have no template; their whole definition lives here.

`effectiveProfileView(deployment, dataRoot)` (agents-query.server.ts:158-236) merges
template ⊕ deployment override per field. Key outputs:
- `desc` — short scannable copy **the operator selects agents by** (D11).
- `definition` — `def.persona ?? template body` → becomes the run's system prompt.
- `kind` — `"operator"` vs `"specialist"`; `autonomy` only meaningful for operator.
- Specialist grants are view-coerced `recommend→direct` (R7-5) for display only;
  runtime policy reads raw `deployment.capabilities`.

`CapabilityGrant = {capabilityId, mode: "direct"|"recommend"|"human"|"off"}`
(project-file.schema.ts:69-76). `mode` semantics: `direct` = agent may do it;
`recommend` = operator-only mode (recommend instead of perform); `human` = reserved for
a human (deliberate human gate); `off` = withheld entirely.

## 2. Capability catalog & grant semantics (`app/shared/capabilities.ts`)

`UNIFIED_CAP_CATALOG` (capabilities.ts:33-71) is the single catalog. Each cap has
`kinds` (`operator` / `agent`), an editor `group` (null = matrix-only advisory),
`defaultMode` (seeded on profile creation AND used as the absent-grant default at
runtime), and `promotable`.

Operator caps: `assign-primary-specialist`, `summon-reviewers`, `generate-packets`,
`append-typed-events`, `stage-transitions` (default recommend),
`completion-for-acceptance` (default recommend, **non-promotable** — full autonomy never
promotes it to direct; see §6.2).

Agent caps that bind at runtime:
- **`execute-code-or-write-repo`** — the **master/headline gate**. When withheld
  (`human`/`off`), Claude runs lose `Edit/MultiEdit/Write/NotebookEdit` + `Bash(git
  commit:*)` (specialist-tool-policy.ts:56-59) and ALL delivery prompt steps are
  suppressed (`resolveDeliveryPermissions`, specialist-tool-policy.ts:110-129 — the
  headline gates `canBranch`/`canCommitPush`/`canOpenPr` regardless of the fine-grained
  grants; this was central bug F14/VIB-1).
- Scoped delivery caps `create-task-branch`, `commit-push-branch`, `open-review-pr`
  map to git/gh deny rules (specialist-tool-policy.ts:30-69). Polarity is
  **safe-by-default**: only `human`/`off` (or ALWAYS_HUMAN membership) deny; absent /
  `direct` / `recommend` keep default tool access (isWithheld,
  specialist-tool-policy.ts:71-79).
- Collaboration caps `comment-on-task`, `ask-human` (both default `direct`),
  `report-validation-verdict` (default `off` — verdict/acceptance-veto power is
  **explicit-grant-only**, F10-14).
- `ALWAYS_HUMAN_CAPABILITY_IDS` (capabilities.ts:79-83): `merge-pull-request`,
  `transition-to-done`, `change-project-policy` — always treated as withheld for
  agents regardless of stored mode.

Enforcement honesty metadata: `ENFORCED_CAPABILITY_IDS` (both backends, server-side —
includes `report-validation-verdict` + `ask-human` because the completion pipeline gates
them server-side), `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` (tool-deny caps + the mid-run
`comment-on-task` tool — **advisory on Codex**, which ignores `disallowedTools`), and
`capabilityEnforcement(id)` → `both | claude-only | advisory` (capabilities.ts:91-135).

**`normalizeDeliveryGrants`** (capabilities.ts:152-185): repairs the VIB-1 accidental
contradiction — if any scoped delivery cap is actionable (`direct`/`recommend`) but the
headline `execute-code-or-write-repo` is ABSENT or `off`, the headline is flipped/added
as `direct`. An **explicit `human` headline is respected** (deliberate human gate, never
silently flipped). Used by profile editors; runtime does not call it.

`coerceSpecialistCapabilityMode` (capabilities.ts:138-140): specialists have no
recommend mode; view-level coercion recommend→direct. BUT
`effectiveCollabMode` (agent-outcome.server.ts:212-234) deliberately treats a stored
`recommend` **collaboration** grant as absent (falls to catalog default), because
pre-generic-agents seed data gave the delivering dev `report-validation-verdict:
recommend` decoratively — coercing it would arm verdict-veto on live data.

Collaboration resolution: `resolveAgentCollab(grants, delivers)` →
`{comment, ask, verdict}` booleans (agent-outcome.server.ts:237-248). Explicit
`direct|human|off` grant wins; absent/recommend → catalog default (`comment`/`ask`
default on, `verdict` default off; there is NO implicit supporting-agent verdict).

## 3. Engagement model (task.md)

Schema: `app/schemas/task-file.schema.ts`.

`engagements[]` (task-file.schema.ts:94-109) replaced the old `specialist` +
`reviewers[]` slots (legacy keys absorbed on parse, never re-written —
`parseEngagements` task-file.schema.ts:587-666). Each engagement:

```yaml
engagements:
  - profileId: dev        # identity (JOIN KEY — never the role string)
    backend: claude       # display/run snapshot, kept in step with the run backend
    role: Developer       # display snapshot at engage time
    delivers: true        # ≤1 per task — the workspace/branch/PR owner
    verdictCapable: false # engage-time snapshot of an explicit report-validation-verdict: direct grant
```

Invariants (parser-enforced with diagnostics):
- **profileId uniqueness** — duplicates dropped, first kept (task-file.schema.ts:628-647;
  a dup corrupts run routing because `startAgentRun` resolves by first match).
- **single deliverer** — extra `delivers:true` entries demoted (task-file.schema.ts:648-665).
  Helpers: `deliveringEngagement` / `supportingEngagements` (task-file.schema.ts:111-123).

`delivers` gates: workspace write access (supporting runs are physically read-only,
§4.3), server-side single-flight (one live delivering run per task,
specialist-run.server.ts:531-554 + the `agent_runs` unique constraint fallback,
run-service.server.ts:267-281), delivery reconcile at completion (§4.6), and the
prompt contract shape (§4.4).

`verdictCapable` (F10-15): snapshotted at engage time from
`resolveAgentCollab(caps, delivers).verdict`
(assignSpecialist specialist-run.server.ts:272, assignReviewer :385). A supporting
engagement with `verdictCapable:true` is a **REQUIRED reviewer**. The snapshot is
authoritative at completion time for verdict recording (task-actions.server.ts:1692-1708
— prefers the engagement snapshot over live grants so a later undeploy can't strand an
un-acceptable task); live grants are the fallback only when no engagement row exists.

Engagement writes:
- `assignSpecialist` (specialist-run.server.ts:224-307): the new deliverer **replaces**
  the old one (old deliverer dropped, not demoted); a prior supporting entry for the
  same profile is removed; clears matching `assign_specialist` recommendations.
- `assignReviewer` (:326-417): appends `delivers:false`; idempotent against ANY existing
  engagement (including the deliverer — no dup profileIds).
- `removeReviewer` (:432-479): supporting-only removal.
- All three RBAC: admin|maintainer via `requireRunAgents`, or `ctx.operatorAuthorized`
  (operator bypasses human RBAC; its own capability policy gates upstream).
- Stage eligibility (F1): `assertStageEligible` on assign AND run
  (specialist-run.server.ts:246,348,611; `specialistEligibleForStage` :1414-1421 —
  spanAll or empty stages = unrestricted).

### 3.1 Revision-bound review model (F10-15/F10-32)

- `workRevision` (task-file.schema.ts:324-337): immutable identity of delivered work —
  `{id, headSha (full), treeSha, branch, createdAt, sourceProfileId}`. Minted
  server-side by the post-run workspace reconcile
  (`app/server/github/workspace-delivery.server.ts:326-356`): after a **delivering**
  run finishes, `git rev-parse HEAD` / `HEAD^{tree}` in the workspace →
  `nextWorkRevision(current, …)` (task-file.schema.ts:475-503). Same tree (or same head
  when tree unavailable) = same review subject → **no** new revision, verdicts survive;
  different tree → new revision id → every prior verdict is automatically stale. That IS
  new-commit invalidation; there is no comment/stage-bounce heuristic anymore.
- `verdicts[]` (task-file.schema.ts:342-355): `{profileId, revisionId, headSha, result:
  approve|request_changes, reason, at}` — one per (profileId, revisionId),
  last-write-wins (recordAgentCompletion task-actions.server.ts:1432-1450).
- `requiredReviewers(fm)` = supporting ∧ verdictCapable (task-file.schema.ts:408-410).
- `currentVerdicts(fm)` = verdicts bound to the current revision id (:413-420).
- **`deriveValidation(fm)`** (:426-444) recomputes the `validation` cache (`none` before
  any revision; `failing` if any required reviewer requests changes on the current
  revision; `healthy` when required reviewers exist and ALL approved it; else
  `changed`). `validation` is a DERIVED board pill, recomputed on verdict recording,
  revision minting (workspace-delivery.server.ts:365-374), and review-stage entry
  (task-actions.server.ts:~2455-2461) — a bare stage re-entry can't launder `failing`.
- **`acceptanceBlockedReason(fm)`** (:450-468): null (acceptable) when there are no
  required reviewers AND no revision (planning tasks), or when all required reviewers
  approved the current revision; otherwise a human-readable reason. Enforced in BOTH
  acceptance paths: human `acceptCompletion` (task-actions.server.ts:2841) and operator
  `operatorAcceptCompletion` (operator-actions.server.ts:1519-1524).

## 4. Agent runs (specialists / the generic agent)

Everything below is `app/server/tasks/specialist-run.server.ts` unless noted.

### 4.1 `startAgentRun` flow (:490-885)

Input: `{projectSlug, taskKey, profileId? (omitted → deliverer), directive?,
backendOverride? (D4 retry)}`. Steps, in order:

1. RBAC/audit actor (`runtimeAuditActor` — operator context skips human check, :1331).
2. Find the engagement (profileId match or `deliveringEngagement`); refuse if not engaged.
3. Delivering single-flight: refuse (409) if a `kind='primary'` run is queued/running
   (:537-554).
4. Resolve the **live** deployment (`resolveDeployedSpecialist` :167-195 — run follows
   the current profile, not the engage snapshot; undeployed → snapshot fallback).
   Backend precedence: `backendOverride` > live deployment > engagement snapshot.
   Model/effort re-resolved for the actual run backend
   (`resolveRunModel`/`resolveRunEffort`, model-catalog.server.ts:185-232 — invalid /
   display-label models NEVER reach the SDK; cross-backend retry maps effort by rank).
5. `disallowedTools = resolveSpecialistDisallowedTools(capabilities)` (Claude-only teeth).
6. Stage eligibility re-check at the run boundary (:611-613).
7. Build the **persona** (`buildSpecialistPersona` :913-971): profile `definition`
   body + each declared skill's `SKILL.md` body + declared KB docs (global
   `KB_INJECTION_BUDGET = 24,000` chars across all KBs,
   `app/server/files/kb-injection.server.ts:46`), wrapped in a trusted-provenance
   banner (F7-RES4) so agents don't mistake attached skills for prompt injection.
   Missing skill files log a warning and are skipped (F12).
8. Resolve collaboration gates `collab = resolveAgentCollab(caps, delivers)` and mint an
   `outcomeKey` (staging key for Claude `report_outcome`).
9. Best-effort clone (`cloneRepo` :1235-1303): `<taskDir>/workspace/<repoName>`, PAT
   from the project credential via `createGitHubClonePlan`; re-used clones get their
   origin re-sanitized; identity `git config user.*` = profile id (F24). Run cwd is
   ALWAYS an isolated workspace dir, never the task dir.
10. Run env: `GIT_CEILING_DIRECTORIES=<taskDir>` (strict ancestor of cwd — blocks git
    walking up to a host repo, :1195-1212) + `GIT_AUTHOR_*/GIT_COMMITTER_* =
    <profileId>/<profileId>@viberr.local` (:1221-1233). **No push credentials ever**
    — delivery is server-side (push-workspace.server on the Review transition).
11. Prompt (`buildAnalyzePrompt`, §4.4) + per-backend collaboration notes appended.
12. Thread id: `primary-<rand>` for the deliverer, `r<index>-<rand>` for supporting.
13. Transports: Claude → `buildAgentToolkit` in-process MCP merged with declared org
    MCPs; Codex → `outputSchema: AGENT_OUTCOME_JSON_SCHEMA` **only when**
    `collab.verdict || collab.ask` (a plain developer report stays prose) (:743-762).
14. `startRun(...)` (run-service) with kind `primary|reviewer`, model, effort, persona
    as `systemPrompt`, `agentName`/`agentProfileId` (log grouping), disallowedTools,
    mcpServers, outputSchema, workdir, env.
15. Post-start task write: sync engagement.backend to the actual run backend; timeline
    "Started a … run" event; F10-31 policy note when the operator directive asked for
    push/PR (`directiveRequestsDelivery` :1073-1077 — recorded, not obeyed).
16. Audit `task.agent.run_started` (ONE action id; `delivers` in details).
17. `markWaitingAgent` then **`registerAgentCompletion`** — the single canonical
    completion pipeline for EVERY start path (UI Run, @mention, operator prompt).
    `ctx.operatorRun` (present inside an operator react loop) is threaded so the chain
    continues at depth+1.

### 4.2 Resume path (@mention)

`commentToAgent` (task-actions.server.ts:724-953): resolves the mentioned agent
(`resolveMentionedAgent`, agent-reply.server.ts:145-263 — precedence `@operator` →
`@agent` (primary) → name/id/backend match; sessions match by **agent identity +
engagement kind**, never backend alone). If a resumable session exists →
`resumeRun` with `resolveResumeConfinement` (specialist-run.server.ts:1099-1187)
re-applying denylist, git-ceiling env, MCPs, persona, a fresh `outcomeKey`+toolkit
(Claude) or the outcome envelope schema (Codex, F7) — fresh-vs-resume parity (XS-1/F7).
No session → fresh engage+run routed by engagement shape (reviewer mention never
clobbers the primary). Resumed runs get `registerAgentCompletion` installed at
task-actions.server.ts:928-943.

### 4.3 Read-only supporting runs (F10-12/F10-04)

A non-delivering run is physically read-only:
- Claude: `SUPPORTING_DENIED_BUILTINS` (claude-runtime.server.ts:135-148) — file-write
  builtins + git commit/push/branch-create + gh pr create/merge (deny binds under
  bypassPermissions). `sed -i`/redirection stay reachable (honest Bash limitation).
- Codex: `sandboxMode: "read-only"` for `kind: "reviewer"` (codex-runtime.server.ts:382-387)
  — stronger than the Claude denylist; network stays on so MCPs work.

### 4.4 Prompt contracts (`buildAnalyzePrompt`, specialist-run.server.ts:980-1070)

- Base: "You are the <role> specialist on task <KEY>… analyze and report".
- Repo tasks get a **workspace contract**: work only in cwd; clone instruction when not
  pre-cloned.
- **Supporting** (delivers:false): explicit READ-ONLY block — never branch/edit/
  commit/push/PR "even if a directive says to"; report approve/request-changes with
  file/line refs (prompt must match enforcement, XS-4).
- **Delivering**: per-`DeliveryPermissions` steps — `git checkout -B <task-branch>`
  (if canBranch); commit locally with `[KEY]`-prefixed messages but **never push, never
  open a PR** (server owns delivery on the Review transition, F-GH3); when repo-write is
  human-gated, an explicit prohibition replaces silent omission.
- Operator `directive` is quoted as **untrusted task guidance** that can never override
  the server-owned delivery contract (F10-31).
- Collaboration section appended per transport (Claude tool descriptions vs the Codex
  final-JSON instruction) (specialist-run.server.ts:694-721).

### 4.5 Agent toolkit (Claude) & outcome envelope

`app/server/tasks/agent-toolkit.server.ts` — in-process SDK MCP server `viberr_agent`;
tools are built ONLY when the grant allows (an ungranted tool doesn't exist):
- `post_comment` ← `comment-on-task`: immediate agent-attributed timeline comment
  (guardrail-light; audited `task.agent.commented`).
- `ask_human` ← `ask-human`: opens an "Agent question" decision packet (type `input`,
  from = the agent's ref, ≤4 `custom` options, waiting=human, notifies watchers).
  Refuses when a packet is already open (one decision slot per task; re-checked inside
  the locked write, agent-toolkit.server.ts:140-157). The agent never gets the answer
  in-run.
- `report_outcome` ← `report-validation-verdict`: **stages** `{verdict, summary}` in an
  in-memory map keyed by `outcomeKey` (agent-outcome.server.ts:161-179; max 500,
  last-write-wins, lost on restart) — recorded atomically with the reply at completion.

Envelope shape (`AgentOutcome`, agent-outcome.server.ts:36-41): `{summary?, verdict?:
approve|request_changes, question?: {title, body?, options?}}`.
`AGENT_OUTCOME_JSON_SCHEMA` (:53-93) is the Codex `outputSchema` transport and MUST obey
OpenAI strict rules (every property in `required`, optionality via nullable types —
getting this wrong 400s the whole run). `parseAgentOutcomeJson` (:101-152) tolerantly
parses the Codex final reply (strips one fence; null when not an envelope).

### 4.6 Completion pipeline (`applyAgentCompletionEffects`, task-actions.server.ts:1623-1998)

Shared byte-for-byte by the live callback (`registerAgentCompletion` :1576-1615) and
boot recovery (`recoverUnreactedAgentRuns`, run-recovery.server.ts:181-303). Steps:

1. Resolve the envelope: Claude staged outcome (via outcomeKey) first, else parse the
   Codex reply JSON (raw JSON never becomes the timeline comment — `summary` does).
2. Verdict authority = engagement `verdictCapable` snapshot (fallback: live grants).
   Verdict = envelope verdict, else **prose classifier fallback**
   `classifyReviewerVerdict` (:1324-1380 — explicit "Verdict:" line > strong
   request-changes phrases > negation-aware weak negatives > approve phrases). The
   regex NEVER runs without verdict authority (R1). A verdict-granted run with no
   determinable verdict logs loudly and leaves validation unchanged (fail-safe, F10).
   Question honored only when `collab.ask`.
3. **`recordAgentCompletion`** (:1383-1573) — ONE atomic task-file write: reply comment
   + verdict event + question packet. Verdict binds to the CURRENT `workRevision`
   (skipped when none — "Approval noted", never a pass); `validation` recomputed via
   `deriveValidation`; event title derived from the RESOLVED validation (F7-REV3:
   "Review passed" only when healthy; else "Approval noted — rework still needed").
   Stale `accept_completion` recommendations dropped when not healthy. Audits + watcher
   notifications for verdicts/questions.
4. Errored runs (state `error`): typed `blocked` timeline event with a classified
   reason (`runFailureReason`, agent-reply.server.ts:376-406 — kinds
   quota/auth/unavailable/max_turns/unknown, read from the adapter's `·<kind>` tag
   suffix), a stuck/recovery packet whose first option is **`retry_other_backend`**
   (D4) for backend-level failures, watcher notify, waiting→human, stop. The retry
   option is executed by `resolvePacket` via `startAgentRun{backendOverride}`
   (task-actions.server.ts:3042-3058) and the switch persists to the engagement.
5. Finished runs withdraw a superseded "work stalled" packet about the same agent.
6. **Delivery reconcile** — delivering runs only:
   `reconcileWorkspaceDelivery` (workspace-delivery.server.ts:198-543) inspects the
   workspace git repo: links the real branch, commit cache (shallow-clone-aware),
   **mints the workRevision** (§3.1), and best-effort links a PR via `gh` — idempotent,
   never throws.
7. **Operator react**: `operatorShouldReactToReply` (:89-99) — finished + non-empty
   reply + reply differs from the agent's previous stored reply + depth <
   `OPERATOR_REACT_DEPTH_CAP = 4`. React → `runOperator{trigger:"agent-reply",
   reactDepth+1, agentReply: <full reply>}` (reply handed directly in the prompt, never
   dependent on the timeline comment surviving). No-react + (verbatim repeat OR depth
   cap) → stuck-loop packet; ALWAYS `clearWaitingToHuman` when the chain terminates.

Actor refs: agents are `agent:<backend>/<profileId> (Role Snapshot)` — profileId is the
identity, role a display hint; unknown refs round-trip verbatim
(task-file.schema.ts:935-968, D7).

## 5. Operator

Core files: `app/server/runtimes/operator-run.server.ts` (run lifecycle),
`app/server/tasks/operator-actions.server.ts` (capability-gated actions),
`app/server/tasks/operator-toolkit.server.ts` (Claude tools).

### 5.1 Authority & gating

`resolveOperatorAuthority` (operator-actions.server.ts:110-172): finds the project's
`kind === "operator"` deployment → `{policy: Map<capId, mode>, autonomy
(supervised|full, from deployment.definition.autonomy, overridable per run), backend,
model, effort, name, skills, kb, deployed}`. No deployment → inert defaults with
`deployed:false` (auto-invokes no-op).

`gate(authority, capId)` (:175-189) → `direct | recommend | deny`:
- `direct` → direct. `human`/`off`/absent → deny.
- `recommend` → `direct` under full autonomy **except `completion-for-acceptance`**,
  which stays `recommend` (owner ruling Q1: agent-close of a task requires an explicit
  `direct` grant, never an autonomy side-effect).

### 5.2 Triggers (when the operator fires)

`runOperator(db, input)` with `trigger`:
- `create` — task creation (task-actions.server.ts:450 via `autoInvokeOperator` :533-558).
- `transition` — a NON-operator stage move to a non-Done stage
  (task-actions.server.ts:2501) and packet resolutions that send work back
  (request_edit/redirect/custom, :3030-3036).
- `goal-updated` — goal edits (:527); the turn instruction tells it to withdraw a
  now-moot scope packet.
- `agent-reply` — the react loop (§4.6 step 7), with `agentReply` embedded (first
  4,000 chars, operator-run.server.ts:940-945).
- `manual` — `@operator …` comments (task-actions.server.ts:780-797, with
  `humanComment`), the task-detail operator panel, boot recovery of orphaned runs
  (run-recovery.server.ts:126-144, crash-loop capped at 3 per 30-min window), and the
  schedule runner (schedule.server.ts:335-348 — `run-operator` schedules on the task
  file, 60s tick, claim→fire lifecycle with bounded retries, F10-16).

**Single-flight lease** (operator-run.server.ts:114-260): process-global per-task
lease held from entry through provider completion AND Codex plan execution; a trigger
arriving while held is QUEUED (newest wins) and fired exactly once on release;
release is idempotent per lease token; a cross-boot DB-row backstop chains the queued
trigger onto the in-flight run's completion. On final release with nothing queued and
no live run, waiting flips back to human (`settleWaitingAfterOperator` :215-236).

### 5.3 Claude operator: toolkit run

`startRealOperatorRun` (operator-run.server.ts:728-795): `startRun` kind `operator`,
backend claude, `systemPrompt` REPLACES the Claude Code preset (coordinator, not coder),
`mcpServers = { viberr: <in-process SDK server> }`, `allowedTools` = exactly the built
`mcp__viberr__*` names. Errored runs escalate a blocked recovery packet (F-OP1,
:804-850) with quota/auth-aware copy.

Toolkit (`buildOperatorToolkit`, operator-toolkit.server.ts:71-360) — a tool is **not
even built** when its capability gates to deny:
- `get_task` (always): full `operatorSnapshot` + its own policy/autonomy. Snapshot
  (operator-actions.server.ts:625-760) includes goal, stage graph
  (nextStages/stageIds/done/review/work ids resolved from the workflow graph),
  delivering + supporting engagements, `deployedSpecialists` (each
  `DeployedSpecialistView` + `eligibleForCurrentStage`), open-packet CONTENT, last 6
  timeline entries (1,500-char capped), autonomy + policy. The tool description
  instructs: draft an unspecified goal FIRST; **select agents by `desc` +
  `capabilities` (delivery/verdict/askHuman), never by name**.
- `post_comment`, `set_goal` ← `append-typed-events`. `set_goal` fills only an
  UNSPECIFIED goal (placeholder/blank); refuses to overwrite real scope
  (operator-actions.server.ts:788-856); fulfills an awaiting `goal_edit` packet.
- `open_decision_packet`, `resolve_decision_packet` ← `generate-packets`. Packets
  (operator-actions.server.ts:430-547): typed options from `PACKET_OPTION_KINDS`
  (task-file.schema.ts:55-70: accept_completion, request_edit, block_on_policy,
  hold_runtime_debug, redirect, retry_other_backend, edit_goal, custom), exactly one
  recommended, stable `id`, blocked packets set `readiness=blocked` (NOT
  validation — F7-VAL1), waiting=human, watcher notifications. `resolve` withdraws a
  moot packet with a timeline reason (:557-609).
- `engage_agent {profileId, delivers}` / `run_agent {profileId?}` /
  `prompt_agent {profileId, prompt, delivers?}` ← gated per shape:
  delivers:true → `assign-primary-specialist`, delivers:false → `summon-reviewers`
  (tools offered if EITHER is non-deny; each call still gated,
  operator-toolkit.server.ts:225-309). These are thin dispatchers
  (operator-actions.server.ts:1255-1382): `resolveDeliversIntent` (explicit hint > how
  already engaged > deliverer-less default), a selection **audit trace**
  `task.operator.agent_selected` with the full candidate list (:1211-1253), then
  gate → `recommend` mode posts a one-click **recommendation card** and stops;
  `direct` performs: engage (idempotent), best-effort `ensureTaskBranch`, then
  `operatorPromptAgent` (task-actions.server.ts:2047-2120) — posts the `@handle …`
  prompting comment (to-agent tint) and calls `startAgentRun` with the directive,
  operator-authorized, `ctx.operatorRun` preserved so the react chain continues.
- `transition_stage` ← `stage-transitions`. `auto` boundaries and rework moves bypass
  the recommend gate: a backward move on a `failing` task is performed **directly**
  (R7-4 rework routing, operator-actions.server.ts:1390-1431, isReworkMove :1450-1467).
- `accept_completion` ← `completion-for-acceptance` (§5.5).

Recommendations (`addRecommendation`, operator-actions.server.ts:331-400): stored in
frontmatter `recommendations[]` (kinds: assign_specialist, assign_reviewer, transition,
run_specialist, run_reviewer, accept_completion — task-file.schema.ts:136-153), rendered
as Apply/Dismiss cards (applied via `applyRecommendation`,
task-actions.server.ts:3268+), idempotent per (kind, target), waiting=human + watcher
notification on new ones.

Comment guardrails (writeOperatorComment, operator-actions.server.ts:225-323): the
meaningful-comment / evidence-separation / operator-brevity / no-duplicate-summary /
compression-threshold guardrails from project `guardrails[]` all enforce for real.

### 5.4 Codex operator: structured plan

Codex can't mount in-process tools → `startCodexOperatorRun`
(operator-run.server.ts:464-533): `startRun` with `outputSchema: OPERATOR_PLAN_SCHEMA`
(:387-418 — strict-mode: additionalProperties:false, all properties required,
nullables for optionality). Plan = `{reasoning, actions[]}`, action tools:
post_comment, open_packet, resolve_packet, set_goal, engage_agent, run_agent,
prompt_agent, transition_stage, accept_completion (:366-383). On clean completion,
`executeCodexPlan` (:548-724) re-validates through a zod runtime mirror (:426-441 —
provider output is a trust boundary), repairs `\n` escapes, then executes each action
through the SAME gated operator-actions (identical RBAC/autonomy as Claude). A governed
action failure ABORTS the remaining plan with a timeline note. No/invalid plan →
blocked escalation packet (:562-590). Codex packets get default option sets keyed by
type (:449-462) since the flat schema can't author rich options. The lease is held
until plan execution completes. The Codex operator run itself is sandboxed
`read-only` + network disabled + web search disabled (codex-runtime.server.ts:382-403).

Prompts: shared turn instruction (`operatorTurnInstruction`,
operator-run.server.ts:948-981) — humanComment wins; goal-updated → resolve moot
packet; agent-reply → move work toward review / accept clean review / rework-route
failures / never re-prompt merely to repeat; default → draft goal if unspecified,
advance auto pre-work transitions, pick a profile by desc+capabilities, `prompt_agent`
with a concrete directive, stop after the handoff.

System prompt (`buildOperatorSystemPrompt` :891-929): shipped
`agents/definitions/operator.md` body (seeded by
`app/server/seed/default-assets.server.ts:61`; baked-in fallback :855) + declared
skills (default `viberr-app-expertise`) + KB docs (same 24k budget) + a "Live
authority" block listing autonomy + full capability policy.

### 5.5 accept_completion (the one agent path to Done)

`operatorAcceptCompletion` (operator-actions.server.ts:1495-1617): refuses on
`acceptanceBlockedReason` (required-reviewer gating) and on an open blocked packet.
Under supervised autonomy OR without an explicit `direct` grant → posts an
`accept_completion` recommendation card. Under full autonomy + explicit direct →
moves the task to Done itself, sets validation healthy, clears recommendations/packet,
and marks the PR **`accepted` (merge pending)** — the operator can never merge
(mergeTaskPr requires a human identity); `pr.state` vocabulary at
task-file.schema.ts:226-241. `transition-to-done`/`merge-pull-request` remain
ALWAYS_HUMAN for agents; this operator capability is the single governed exception.

## 6. Runtimes

### 6.1 Run service (`app/server/runtimes/run-service.server.ts`)

`startRun` (:240-334): inserts the `agent_runs` row (unique (project, task, thread);
primary-kind conflicts map to a friendly 409), audits `runtime.run.started`, selects
the adapter (`selectAdapter`), and either launches or **fails fast** when the backend
has no credential (`failRunUnavailable` :344-361 — one honest `run·unavailable` err
line, state error, so the F8 escalation path runs; actionable copy incl. the docker
codex-home trap, :371-380). `resumeRun` (:392-471) creates a NEW row sharing the
provider session id, fresh thread id `<prev>-r<rand>`, and re-applies every confinement
input the caller passes. Completion callbacks: `registerRunCompletion` (last-writer-
wins) / `chainRunCompletion` (compose), both with an already-terminal immediate-fire
guard for the spawn-crash race (:95-157). Interrupt is admin|maintainer, idempotent,
allowed on archived projects (:554-628).

Adapter contract (`adapter.server.ts`): `RunSpec` (prompt, workdir, model, effort,
systemPrompt, mcpServers, allowedTools, disallowedTools (Claude-only), outputSchema
(Codex-only), env overlay, autonomous, resumeSessionId) → callbacks `onLine`
(raw envelope + projected display + facts) / `onExit` (finished|error|interrupted from
the STREAM, never exit codes). Lines persist through `run-sink` (raw .jsonl + DB) then
SSE.

### 6.2 Registry & spawn env (`runtime-registry.server.ts`)

Availability = cheap credential presence, re-probed every call (self-healing):
claude — `ANTHROPIC_API_KEY` | `CLAUDE_CODE_OAUTH_TOKEN` | `VIBERR_CLAUDE_USE_CLI_AUTH=1`;
codex — `CODEX_ACCESS_TOKEN` | `CODEX_API_KEY`/`OPENAI_API_KEY` |
`VIBERR_CODEX_USE_CLI_AUTH=1` **and** `$CODEX_HOME/auth.json` exists (F-DOCKER1).
Overrides are sticky (tests).

Both SDKs **REPLACE** the child process env with the `env` option (verified in the
bundled SDKs — F10-02). `filteredSpawnEnv` (:187-196) starts from process.env and
strips every credential-shaped var (`API_KEY|SECRET|TOKEN|PASSWORD|…` regex) +
DATABASE_URL/REDIS_URL/SSH_AUTH_SOCK/GPG_AGENT_INFO, keeping PATH/HOME/locale/proxy.
`claudeSpawnEnv` adds only `CLAUDE_CONFIG_DIR` (single resolver
`resolveClaudeConfigDir`, claude-config.server.ts:25-32 — explicit env > `~/.claude`
under CLI auth > `<dataRoot>/runtimes/claude-home`; session-export reads the same dir)
+ the selected Claude credential. `codexSpawnEnv` adds CODEX_HOME + CODEX_ACCESS_TOKEN
and deletes CODEX_API_KEY/OPENAI_API_KEY when subscription auth is requested (no silent
API billing). Per-run `spec.env` (git ceiling + git identity) overlays this base.

### 6.3 Claude adapter (`claude-runtime.server.ts`)

`query()` from the Agent SDK; streaming-input single message so `interrupt()` works;
`resume: sessionId`; `permissionMode: bypassPermissions` when autonomous;
`maxTurns` runaway guard (default 2,000, `VIBERR_CLAUDE_MAX_TURNS`; a capped run emits
a classified `max_turns` reason — cut-off, not failure). Isolation:
`settingSources: []`, `skills: []`, `plugins: []` — but ~16 first-party skills are
compiled into the SDK binary and still appear in init (docker-verified), so the
**`Skill` tool is denied** instead. `BASE_DENIED_BUILTINS` (:176-204) for EVERY run:
Skill, the whole Task/subagent-spawn family (TaskCreate/…/Workflow — a denied-tools run
must not spawn an unrestricted subagent), Cron*/ScheduleWakeup/RemoteTrigger/Monitor,
PushNotification/SendMessage, DesignSync, Enter/ExitWorktree. Plus
`OPERATOR_DENIED_BUILTINS` (Bash/Edit/MultiEdit/Write/NotebookEdit) for operator runs,
`SUPPORTING_DENIED_BUILTINS` for reviewer-kind runs, plus the per-profile capability
denylist. Deny wins under bypassPermissions; `allowedTools` merely auto-approves.

System-prompt strategy (:417-427): operator persona **replaces** the default
(coordinator); specialist persona is **appended** to the `claude_code` preset (keeps
the coding harness). Live usage accumulation from assistant messages; final `result`
envelope is authoritative. Failures are classified in-memory
(quota/auth/unknown + spawn-crash EBADF/ENOENT) into a redaction-safe reason line
tagged `run·error·<kind>` (:277-319).

### 6.4 Codex adapter (`codex-runtime.server.ts`)

`Codex.startThread/resumeThread` + `thread.runStreamed(prompt, {signal,
outputSchema?})`. Sandbox (:382-387): operator/reviewer → `read-only`; autonomous
delivering → `danger-full-access`; else `workspace-write`. `approvalPolicy: "never"`.
Operator additionally gets network + web-search disabled. Config
(`codexConfigForRun` :132-167): `developer_instructions` = systemPrompt,
`allow_login_shell: false`, ChatGPT `apps` feature off, cross-run `memories` fully off,
`mcp_servers` = translated portable declarations, `shell_environment_policy: {inherit:
core}` + only GIT_CEILING_DIRECTORIES crossing into tool shells. **Ignores
`disallowedTools` entirely** (no such SDK channel) — capability tool-denial is
Claude-only/advisory here; the reviewer read-only sandbox is the Codex-side teeth.
Idle (inactivity) timeout 15 min default (`VIBERR_CODEX_IDLE_TIMEOUT_MS`) aborts a
hung run to `error` (:171-176, 267-300). Failures classified in-memory before
redaction; raw stderr never persisted (:180-242). Success = `turn.completed` seen with
no top-level `turn.failed`/`error`.

MCP translation (`codexMcpServers` :68-107): HTTP → `{url,
default_tools_approval_mode: "approve"}`; stdio → `{command, args}`; in-process
`type:"sdk"` servers skipped. **Credentials are deliberately dropped on Codex** —
the SDK serializes config into `--config` argv (ps-visible), so a credentialed org MCP
authenticates on Claude only (specialist-mcp.server.ts:24-31 docstring; the standing
codex-argv exposure the owner scoped out).

### 6.5 Skills / KB / MCP mounting per profile

- **Skills**: never SDK-discovered. Each declared skill's `SKILL.md` body is injected
  as system-prompt text (specialists: buildSpecialistPersona; operator:
  buildOperatorSystemPrompt). Store path `${dataRoot}/skills/<name>/SKILL.md`.
- **KB**: declared KB folders injected as text, recursive walk, all text-doc
  extensions, global 24k-char budget shared across KBs
  (`app/server/files/kb-injection.server.ts`).
- **MCPs**: profile `resources.mcps` names → org MCP registry
  (`resolveSpecialistMcpServers`, specialist-mcp.server.ts:32-69): HTTP →
  `{type:"http", url, headers.Authorization?}`; stdio → `{command, args,
  env.MCP_CREDENTIAL?}`; sealed credentials decrypted only at spawn time; the reserved
  name `viberr` is skipped (operator-only governance server); unknown names skipped.
  Merged with the Claude collaboration toolkit at run start.
- **Model/effort**: `model-catalog.server.ts` — curated catalogs (claude family
  aliases sonnet/opus/haiku + live `supportedModels()` enhancement w/ 10-min TTL;
  codex hand-maintained gpt-5.6-sol/terra/luna + gpt-5.5). `resolveRunModel` guards
  every run against display-label placeholder models; `resolveRunEffort` maps effort
  tiers by rank across backends for D4 retries. Claude adapter additionally maps
  labels via `resolveClaudeModel` (claude-runtime.server.ts:95-104).

### 6.6 Boot recovery (`run-recovery.server.ts`)

`finalizeOrphanedRuns`: non-terminal rows at boot → `error` (interrupted-by-restart) +
operator re-invoke per task, crash-loop capped (3 per 30-min window via audit rows).
`recoverUnreactedAgentRuns`: finished specialist runs on still-waiting=agent tasks with
no `task.agent.replied` audit → replay `applyAgentCompletionEffects` (same reply/
reconcile/verdict/react as a live callback), same cap keyed per runId. Claude staged
outcomes are lost on restart (in-memory), but Codex envelopes re-parse from the stored
reply and Claude verdict-granted runs fall back to the prose classifier.

---

## Suspicious / gaps

Verified-suspicious items an implementer should know. "Documented" = the code
acknowledges it; still listed because a zero-context reader will trip on it.

1. **Codex delivering agent ignores ALL capability tool-denial** — a Codex
   `delivers:true` run is `danger-full-access` (codex-runtime.server.ts:382-387) and the
   SDK has no denylist channel, so `execute-code-or-write-repo: off/human` (and
   branch/push/PR withholds) bind only via the prompt on Codex. Documented as
   claude-only/advisory (capabilities.ts:112-122) but it is the biggest real
   enforcement asymmetry: the same grant config is hard on Claude, soft on Codex.
2. **Operator deployment persona is inert** — `buildOperatorSystemPrompt`
   (operator-run.server.ts:858-870) reads only the shipped store file
   `agents/definitions/operator.md` (or the baked fallback); the project deployment's
   `definition.persona` is never consulted (only `autonomy`, `model`, `effort`,
   `skills`, `kb` are, operator-actions.server.ts:140-171). Editing the operator's
   persona in the UI (if the UI allows it) changes nothing at runtime. Note the
   asymmetry with specialists, where F10-30 made the profile body the ONE persona
   source and removed `agents/definitions/<id>.md` — the operator still uses the
   removed mechanism.
3. **Stale doc comments that misdescribe behavior**:
   - `adapter.server.ts:50-53` — `RunSpec.outputSchema` says "used by the
     structured-output operator"; it is also the generic agent outcome envelope
     (specialist-run.server.ts:786).
   - `codex-runtime.server.ts:344-350` — claims `deps.env` "is only set when
     CODEX_HOME is configured; with API-key auth it's undefined"; `createAdapters`
     ALWAYS passes a full `codexSpawnEnv` (runtime-registry.server.ts:260-292), so the
     process.env-snapshot fallback branch is dead in production wiring.
   - `run-service.server.ts:209` — `disallowedTools` comment doesn't say Claude-only
     (adapter.server.ts:46-49 does).
4. **`RunHandle.interrupt(byUserId, byLabel)` signature is decorative** — declared
   with args (adapter.server.ts:91-95), both adapters implement `interrupt()` and drop
   them (claude-runtime.server.ts:540-547, codex-runtime.server.ts:488-499);
   `interruptRun` passes actor args that go nowhere (attribution is instead patched
   onto the row at run-service.server.ts:595). Harmless, but a trap for anyone adding
   a third adapter expecting the args to matter.
5. **Claude staged outcomes are process-memory only** — the `report_outcome` staging
   map (agent-outcome.server.ts:161-179) dies on restart; a Claude reviewer whose
   run finishes across a restart falls back to the prose regex (Codex re-parses its
   stored JSON reply). Documented; also its 500-entry eviction is insertion-order,
   not LRU.
6. **`comment-on-task` is unenforceable where it matters** — withholding it removes
   only the Claude mid-run `post_comment` tool; the final reply always posts on both
   backends via the completion pipeline, and Codex has no mid-run channel at all
   (agent-toolkit.server.ts:44-47). The capability reads like "may comment on the
   task" but actually means "may post EXTRA mid-run comments on Claude".
7. **`ask-human`/`comment-on-task` default to `direct`** (capabilities.ts:50-51) — a
   freshly created profile with zero grants can open decision packets
   (`resolveAgentCollab` gives ask=true on absent grant). Contrast
   `report-validation-verdict` default off with an explicit safety comment. Also
   `DeployedSpecialistView.capabilities.askHuman` therefore shows true for nearly
   every profile — weak as an operator selection signal
   (specialist-run.server.ts:1488).
8. **Verdict vs question authority use different sources at completion** — verdict
   authority prefers the engagement `verdictCapable` snapshot
   (task-actions.server.ts:1699-1708) but `question` uses live `collab.ask`
   (:1753). An agent whose ask-human grant was flipped off after engagement loses its
   question; one whose verdict grant was flipped off still records (deliberate for
   verdicts per the F10-15 comment; the asymmetry itself is undocumented).
9. **`effectiveCollabMode`'s `_delivers` parameter is vestigial** —
   (agent-outcome.server.ts:212-216) unused since F10-14 removed the
   supporting-defaults-to-verdict rule; callers still thread `delivers` everywhere.
   Same for `resolveAgentCollab`'s `delivers` arg. Cosmetic, but misleads readers into
   thinking delivers affects collab resolution.
10. **`resolveResumeConfinement` catch-branch claims "conservative settings" but is
    nearly open** (specialist-run.server.ts:1183-1186) — for an undeployed profile it
    applies `resolveSpecialistDisallowedTools([])`, which denies only
    `Bash(gh pr merge:*)` (the sole ALWAYS_HUMAN cap in CAP_DENY_RULES). No persona,
    no MCPs, no envelope. A resumed run of an undeployed profile is close to
    unconfined on the tool level (workspace env/ceiling still applies).
11. **Operator snapshot still speaks the legacy vocabulary** —
    `OperatorTaskSnapshot.specialist`/`reviewers` (operator-actions.server.ts:634-635)
    while the toolkit prose says delivering/supporting; models see both namings.
    Also `deployedSpecialists` is the field name for what the docs call generic agents.
12. **`operatorRunAgent` ignores `profileId` for delivering runs** — with
    delivers=true it calls `operatorRunSpecialist` (operator-actions.server.ts:1329),
    which always runs the CURRENT deliverer; a plan action `run_agent {profileId: X,
    delivers: true}` where X is not the deliverer silently runs the wrong agent
    instead of erroring. Codex plan execution also passes `delivers` there (operator-
    run.server.ts:645-655).
13. **Codex `open_packet` discards operator-authored options** — the flat plan schema
    can only carry a title/body; option sets are canned defaults
    (operator-run.server.ts:449-462). Documented, but a Codex-operator project never
    exercises `retry_other_backend`/`edit_goal`/`accept_completion` packet options
    from the operator's own reasoning.
14. **`AGENT_HANDLE_RE` vs profile-name mentions** — task-actions.server.ts:564: only
    `@agent|operator|codex|claude` set the to-agent tint in plain `appendComment`;
    named mentions rely on `commentToAgent`'s forceToAgent. Any route that calls
    `appendComment` directly with `@dev …` records a non-routed comment (check route
    wiring before relying on the tint).
15. **`buildAnalyzePrompt` for repo-less tasks** still opens with "Analyze the
    repository and report your findings" (specialist-run.server.ts:999-1003) even when
    `repo` is null and no workspace contract follows — mildly incoherent prompt for
    non-repo (planning/doc) tasks.
16. **`directiveRequestsDelivery` is detection-only** (specialist-run.server.ts:799,
    1073-1077) — it stamps a policy note; the directive text itself is still passed
    verbatim into the prompt (mitigated by the precedence prose, F10-31). Regex misses
    paraphrases ("publish the branch", "raise a merge request").
17. **Duplicate constants** — `OPERATOR_AUDIT_ACTOR` defined in both
    task-actions.server.ts:102 and operator-run.server.ts:60; skill-body readers
    (`readSkillBody`) duplicated in specialist-run.server.ts:890-910 and
    operator-run.server.ts:873-884. Drift hazard only.
18. **Mid-run agent comments audit as label "operator"** — `postAgentComment` audits
    `task.agent.commented` with `OPERATOR_AUDIT_ACTOR` (agent-toolkit.server.ts:98-106);
    the agent identity is only in details.actorRef. Audit-log filtering by actor will
    misattribute agent comments to the operator.
19. **In-process completion callbacks are the only live wiring** —
    run-service.server.ts:60-67 documents that a restart mid-run loses pending
    callbacks; boot recovery covers finished-but-unreacted runs and orphaned rows,
    but a run that finishes AND reacts partially (e.g. reconcile done, react lost) has
    no idempotent replay of just the react step (the `task.agent.replied` audit
    already exists, so recovery skips it).
20. **Codex `default_tools_approval_mode: "approve"`** is stamped on every translated
    MCP (codex-runtime.server.ts:83-104) — all MCP tools auto-approved on Codex with
    no per-tool policy; combined with (1), a Codex delivering agent's MCPs are
    entirely ungoverned. Claude-side MCP tools are likewise not in any denylist
    (`mcp__*` deliberately allowed, claude-runtime.server.ts:170-173).
