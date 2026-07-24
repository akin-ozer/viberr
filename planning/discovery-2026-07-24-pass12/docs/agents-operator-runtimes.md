# Agents, Operator, and Runtimes — canonical reference (pass 12, 2026-07-24)

Audience: implementation subagents with **zero other context**. Every claim was
re-verified against source on 2026-07-24 (main @ 0981cfa, post-PR-#87 + clean-sheet
seed PR #90). All paths repo-relative; line numbers from that snapshot, may drift a
few lines.

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

Two layers (`app/features/agents/agents-query.server.ts`, header + `parseDeploymentDefinition` :54):

1. **Org template files** — `${VIBERR_DATA_ROOT}/agents/profiles/<id>.md`
   (frontmatter: `kind: operator|specialist`, `name`, `role`, `backends`, `model`,
   `stages`, `spanAll`, `resources: {skills, mcps, kb}`, `desc`; markdown body = the
   long persona). CRUD in `app/server/org/gagents.server.ts` (specialists only — the
   `operator` template is a system profile, never listed (gagents.server.ts:129-130)
   and never deletable (:253-257)).
2. **Project deployments** — `project.md` frontmatter `agents:` array
   (`app/schemas/project-file.schema.ts:128-142`): `{profileId, capabilities:
   CapabilityGrant[], extras, definition?}`. `definition` is a loose per-field override
   (schema at project-file.schema.ts:85-121) carrying `persona` (long instructions),
   `model`, `effort`, `backends`, `stages`, `autonomy` (operator only), `resources`, etc.
   Project-created profiles have no template; their whole definition lives here.

`effectiveProfileView(deployment, dataRoot)` (agents-query.server.ts:158-238) merges
template ⊕ deployment override per field. Key outputs:
- `desc` — short scannable copy **the operator selects agents by** (D11)
  (:216-218: `def.desc ?? (template.desc || template.description)`).
- `definition` — `def.persona ?? template body` → becomes the run's system prompt (:219-223).
- `kind` — `"operator"` vs `"specialist"`; `autonomy` only meaningful for operator.
- Specialist grants are view-coerced `recommend→direct` (R7-5, :167-180) for display
  only; runtime policy reads raw `deployment.capabilities`.

`CapabilityGrant = {capabilityId, mode: "direct"|"recommend"|"human"|"off"}`
(project-file.schema.ts:69-76). `mode` semantics: `direct` = agent may do it;
`recommend` = operator-only mode (recommend instead of perform); `human` = reserved for
a human (deliberate human gate); `off` = withheld entirely.

Built-in catalog (product data, NOT demo data): `app/server/seed/agent-catalog.server.ts`
— `SEED_AGENT_PROFILES` (:79-158, operator + developer + reviewer),
`defaultAgentDeployments()` (:160), `BASE_AGENT_PROFILE_IDS` (:169-176),
`baseAgentDeployments()` (:177). Consumed by boot's `seedDefaultAgentAssets`
(`app/server/seed/default-assets.server.ts:97-114` — writes-if-absent the operator
definition `agents/definitions/operator.md`, the operator profile template, and
specialist profile templates whose BODY is the persona, F10-30; base templates get
`kb: []` so no dangling KB grants), `ensure-base-agents.server.ts`, and project
creation. The mock board dataset now lives ONLY in `test-support/demo-data.ts` +
`test-support/demo-seed.ts` (test fixture; e2e seeds it explicitly). The product seed
`app/server/seed/seed.server.ts` (`runSeed`) ships an empty board + env-configured
admin (`VIBERR_SEED_ADMIN_EMAIL`/`_PASSWORD`, default `admin@viberr.dev`).

## 2. Capability catalog & grant semantics (`app/shared/capabilities.ts`)

`UNIFIED_CAP_CATALOG` (capabilities.ts:33-75) is the single catalog. Each cap has
`kinds` (`operator` / `agent`), an editor `group` (null = matrix-only advisory),
`defaultMode` (seeded on profile creation AND used as the absent-grant default at
runtime), and `promotable`.

Operator caps: `assign-primary-specialist`, `summon-reviewers`, `generate-packets`,
`append-typed-events`, `stage-transitions` (default recommend),
`completion-for-acceptance` (default recommend, **non-promotable** — full autonomy never
promotes it to direct; see §6.2… gate() §5.1).

Agent caps that bind at runtime:
- **`execute-code-or-write-repo`** — the **master/headline gate**. When withheld
  (`human`/`off`), Claude runs lose `Edit/MultiEdit/Write/NotebookEdit` + `Bash(git
  commit:*)` (specialist-tool-policy.ts:56-59) and ALL delivery prompt steps are
  suppressed (`resolveDeliveryPermissions`, specialist-tool-policy.ts:110-129 — the
  headline gates `canBranch`/`canCommitPush`/`canOpenPr` regardless of the fine-grained
  grants; this was central bug F14/VIB-1). It ALSO gates the server-side Review push:
  `resolveDeliveryPushGrant` (task-actions.server.ts:2598-2619, P11-13) consults the
  DELIVERING profile's `canCommitPush`; a named-but-unresolvable deliverer →
  conservative deny; only a task with NO deliverer is permissive.
- Scoped delivery caps `create-task-branch`, `commit-push-branch`, `open-review-pr`
  map to git/gh deny rules (CAP_DENY_RULES, specialist-tool-policy.ts:30-69). Polarity
  is **safe-by-default**: only `human`/`off` (or ALWAYS_HUMAN membership) deny; absent /
  `direct` / `recommend` keep default tool access (isWithheld,
  specialist-tool-policy.ts:71-79).
- Collaboration caps `comment-on-task` (label now honestly "Post mid-run comments",
  P11-29 — it gates EXTRA Claude mid-run commentary, never the final report) and
  `ask-human` (both default `direct`), `report-validation-verdict` (default `off` —
  verdict/acceptance-veto power is **explicit-grant-only**, F10-14).
- `ALWAYS_HUMAN_CAPABILITY_IDS` (capabilities.ts:83-87): `merge-pull-request`,
  `transition-to-done`, `change-project-policy` — always treated as withheld for
  agents regardless of stored mode.

Enforcement honesty metadata: `ENFORCED_CAPABILITY_IDS` (:95-114, both backends,
server-side — includes `report-validation-verdict` + `ask-human` because the completion
pipeline gates them server-side), `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` (:117-126,
tool-deny caps + the mid-run `comment-on-task` tool — **advisory on Codex**, which
ignores `disallowedTools`), and `capabilityEnforcement(id)` → `both | claude-only |
advisory` (:131-139; ALWAYS_HUMAN checked first so merge-pull-request reads `both`).

**`normalizeDeliveryGrants`** (capabilities.ts:156-189): repairs the VIB-1 accidental
contradiction — if any scoped delivery cap is actionable (`direct`/`recommend`) but the
headline `execute-code-or-write-repo` is ABSENT or `off`, the headline is flipped/added
as `direct`. An **explicit `human` headline is respected** (deliberate human gate, never
silently flipped). Used by profile editors; runtime does not call it.

`coerceSpecialistCapabilityMode` (capabilities.ts:142-144): specialists have no
recommend mode; view-level coercion recommend→direct. BUT
`effectiveCollabMode(grants, capId)` (agent-outcome.server.ts:254-275) deliberately
treats a stored `recommend` **collaboration** grant as absent (falls to catalog
default), because pre-generic-agents seed data gave the delivering dev
`report-validation-verdict: recommend` decoratively — coercing it would arm
verdict-veto on live data.

Collaboration resolution: `resolveAgentCollab(grants)` → `{comment, ask, verdict}`
booleans (agent-outcome.server.ts:280-289). **One argument now** — the vestigial
`delivers` param was removed (P11-31). Explicit `direct|human|off` grant wins;
absent/recommend → catalog default (`comment`/`ask` default on, `verdict` default off;
there is NO implicit supporting-agent verdict).

## 3. Engagement model (task.md)

Schema: `app/schemas/task-file.schema.ts`.

`engagements[]` (task-file.schema.ts:~94-110, `engagementSchema`) replaced the old
`specialist` + `reviewers[]` slots (legacy keys absorbed on parse, never re-written —
`parseEngagements` :587+; migrated legacy reviewers get `verdictCapable:false`).
Each engagement:

```yaml
engagements:
  - profileId: dev        # identity (JOIN KEY — never the role string)
    backend: claude       # display/run snapshot, kept in step with the run backend
    role: Developer       # display snapshot at engage time
    delivers: true        # ≤1 per task — the workspace/branch/PR owner
    verdictCapable: false # engage-time snapshot of an explicit report-validation-verdict: direct grant
```

Invariants (parser-enforced with diagnostics):
- **profileId uniqueness** — duplicates dropped, first kept (:628-648;
  a dup corrupts run routing because `startAgentRun` resolves by first match).
- **single deliverer** — extra `delivers:true` entries demoted (:649-664).
  Helpers: `deliveringEngagement` / `supportingEngagements` (:112-123).

`delivers` gates: workspace write access (supporting runs are physically read-only,
§4.3), server-side single-flight (one live delivering run per task,
specialist-run.server.ts:534-551 + the `agent_runs` partial unique index
`idx_agent_runs__one_delivering` — now folded into the 0001 baseline (migration-squash
ruling) — with the friendly-409 fallback in run-service.server.ts:267-281), delivery
reconcile at completion (§4.6), and the prompt contract shape (§4.4).

`verdictCapable` (F10-15): snapshotted at engage time from
`resolveAgentCollab(caps).verdict` (assignSpecialist specialist-run.server.ts:269,
assignReviewer :382). A supporting engagement with `verdictCapable:true` is a
**REQUIRED reviewer**. The snapshot is authoritative at completion time for verdict
recording (task-actions.server.ts:1726-1735 — prefers the engagement snapshot over
live grants so a later undeploy can't strand an un-acceptable task); live grants are
the fallback only when no engagement row exists.

Engagement writes (all in specialist-run.server.ts):
- `assignSpecialist` (:221-304): the new deliverer **replaces** the old one (old
  deliverer dropped, not demoted); a prior supporting entry for the same profile is
  removed; clears matching `assign_specialist` recommendations (:276-278).
- `assignReviewer` (:323-414): appends `delivers:false`; idempotent against ANY existing
  engagement (including the deliverer — no dup profileIds, :350-361).
- `removeReviewer` (:429-476): supporting-only removal (:457-459).
- All three RBAC: admin|maintainer via `requireRunAgents`, or `ctx.operatorAuthorized`
  (operator bypasses human RBAC; its own capability policy gates upstream;
  `runtimeAuditActor` :1322-1332).
- Stage eligibility (F1): `assertStageEligible` on assign AND run
  (:243, :345, :608-610; `specialistEligibleForStage` :1405-1412 — spanAll or empty
  stages = unrestricted; `assertStageEligible` :1420-1430).

### 3.1 Revision-bound review model (F10-15/F10-32)

- `workRevision` (task-file.schema.ts:324-337): immutable identity of delivered work —
  `{id, headSha (full), treeSha, branch, createdAt, sourceProfileId}`. Minted
  server-side by the post-run workspace reconcile
  (`app/server/github/workspace-delivery.server.ts:~326-366`): after a **delivering**
  run finishes, `git rev-parse HEAD` / `HEAD^{tree}` in the workspace →
  `nextWorkRevision(current, …)` (task-file.schema.ts:475-503). Same tree (or same head
  when tree unavailable) = same review subject → **no** new revision, verdicts survive;
  different tree → new revision id → every prior verdict is automatically stale. That IS
  new-commit invalidation; there is no comment/stage-bounce heuristic anymore.
  **P11-72:** a run that produced ZERO commits (`origin/<default>..HEAD` empty) mints
  NO revision at all (workspace-delivery.server.ts:330-346) — no empty-diff review;
  `commits === null` (couldn't enumerate: shallow + offline) still mints.
- `verdicts[]` (task-file.schema.ts:341-355): `{profileId, revisionId, headSha, result:
  approve|request_changes, reason, at}` — one per (profileId, revisionId),
  last-write-wins (recordAgentCompletion task-actions.server.ts:1453-1477).
- `requiredReviewers(fm)` = supporting ∧ verdictCapable (task-file.schema.ts:408-411).
- `currentVerdicts(fm)` = verdicts bound to the current revision id (:413-420).
- **`deriveValidation(fm)`** (:426-444) recomputes the `validation` cache (`none` before
  any revision; `failing` if any required reviewer requests changes on the current
  revision; `healthy` when required reviewers exist and ALL approved it; else
  `changed`). `validation` is a DERIVED board pill, recomputed on verdict recording,
  revision minting (workspace-delivery.server.ts:375-383), and review-stage entry
  (task-actions.server.ts:2495-2497) — a bare stage re-entry can't launder `failing`.
- **`acceptanceBlockedReason(fm)`** (:450-468): null (acceptable) when there are no
  required reviewers AND no revision (planning tasks), or when all required reviewers
  approved the current revision; otherwise a human-readable reason. Enforced in BOTH
  acceptance paths: human `acceptCompletion` (task-actions.server.ts:3295-3298;
  `force` is the explicit override) and operator `operatorAcceptCompletion`
  (operator-actions.server.ts:1574-1579).

## 4. Agent runs (specialists / the generic agent)

Everything below is `app/server/tasks/specialist-run.server.ts` unless noted.

### 4.1 `startAgentRun` flow (:487-882)

Input: `{projectSlug, taskKey, profileId? (omitted → deliverer), directive?,
backendOverride? (D4 retry)}`. Steps, in order:

1. RBAC/audit actor (`runtimeAuditActor` :1322-1332 — operator context skips human check).
2. Find the engagement (profileId match or `deliveringEngagement`, :514-525); refuse if
   not engaged.
3. Delivering single-flight: refuse (409) if a `kind='primary'` run is queued/running
   (:534-551).
4. Resolve the **live** deployment (`resolveDeployedSpecialist` :164-192 — run follows
   the current profile, not the engage snapshot; undeployed → snapshot fallback).
   Backend precedence: `backendOverride` > live deployment > engagement snapshot
   (:569-572). Model/effort re-resolved for the actual run backend
   (`resolveRunModel`/`resolveRunEffort`, model-catalog.server.ts:185-232 — invalid /
   display-label models NEVER reach the SDK; cross-backend retry maps effort by rank).
5. `disallowedTools = resolveSpecialistDisallowedTools(capabilities)` (:592, Claude-only teeth).
6. Stage eligibility re-check at the run boundary (:608-610).
7. Build the **persona** (`buildSpecialistPersona` :887-945): profile `definition`
   body + each declared skill's `SKILL.md` body (via shared
   `app/server/files/skill-body.server.ts` `readSkillBody`, P11-36) + declared KB docs
   (global `KB_INJECTION_BUDGET = 24_000` chars across all KBs,
   `app/server/files/kb-injection.server.ts:46`), wrapped in a trusted-provenance
   banner (F7-RES4, :927-943) emitted ONLY when real resource content resolved.
   Missing skill files log a warning and are skipped (F12).
8. Resolve collaboration gates `collab = resolveAgentCollab(caps)` (:625) and mint an
   `outcomeKey` (:635, staging key for Claude `report_outcome`).
9. Best-effort clone (`cloneRepo` :1226-1294): `<taskDir>/workspace/<repoName>`, PAT
   from the project credential via `createGitHubClonePlan`; re-used clones get their
   origin re-sanitized (`githubRemoteSanitizationArgs`); workspace git identity
   `git config user.*` = profile id (F24, :1239-1248). Run cwd is ALWAYS an isolated
   workspace dir, never the task dir (:656-666).
10. Run env: `GIT_CEILING_DIRECTORIES=<taskDir>` (strict ancestor of cwd — blocks git
    walking up to a host repo, `workspaceRunEnv` :1186-1203) + `GIT_AUTHOR_*/
    GIT_COMMITTER_* = <profileId>/<profileId>@viberr.local` (:1216-1224). **No push
    credentials ever** — delivery is server-side (push-workspace.server on the Review
    transition, gated by `resolveDeliveryPushGrant`, §2).
11. Prompt (`buildAnalyzePrompt`, §4.4) + per-backend collaboration notes appended
    (:691-718).
12. Thread id: `primary-<rand>` for the deliverer, `r<index>-<rand>` for supporting
    (:724-731).
13. Transports (:740-758): Claude → `buildAgentToolkit` in-process MCP merged with
    declared org MCPs; Codex → `outputSchema: AGENT_OUTCOME_JSON_SCHEMA` **only when**
    `collab.verdict || collab.ask` (a plain developer report stays prose).
14. `startRun(...)` (:760-787) with kind `primary|reviewer`, model, effort, persona
    as `systemPrompt`, `agentName`/`agentProfileId` (log grouping), disallowedTools,
    mcpServers, outputSchema, workdir, env.
15. Post-start task write (:799-834): sync engagement.backend to the actual run backend;
    timeline "Started a … run" event; F10-31 policy note when the operator directive
    asked for push/PR (`directiveRequestsDelivery` :1065-1069 — recorded, not obeyed).
16. Audit `task.agent.run_started` (:837-855, ONE action id; `delivers` in details).
17. `markWaitingAgent` then **`registerAgentCompletion`** (:857-879) — the single
    canonical completion pipeline for EVERY start path (UI Run, @mention, operator
    prompt). `ctx.operatorRun` (present inside an operator react loop) is threaded so
    the chain continues at depth+1.

### 4.2 Resume path (@mention)

`commentToAgent` (task-actions.server.ts:751-980): resolves the mentioned agent
(`resolveMentionedAgent`, agent-reply.server.ts:145-263 — precedence `@operator` →
`@agent` (primary) → name/id/backend match; sessions match by **agent identity +
engagement kind**, never backend alone, `latestSessionRun` :117-133). If a resumable
session exists → `resumeRun` with `resolveResumeConfinement`
(specialist-run.server.ts:1091-1177) re-applying denylist, git-ceiling env, MCPs,
persona, a fresh `outcomeKey`+toolkit (Claude) or the outcome envelope schema (Codex,
F7) — fresh-vs-resume parity (XS-1/F7). No session → fresh engage+run routed by
engagement shape (reviewer mention never clobbers the primary, :896-945). Resumed runs
get `registerAgentCompletion` installed at task-actions.server.ts:955-970. `@operator`
routes to a governed operator run with the comment as `humanComment` (:807-824).

### 4.3 Read-only supporting runs (F10-12/F10-04)

A non-delivering run is physically read-only:
- Claude: `SUPPORTING_DENIED_BUILTINS` (claude-runtime.server.ts:136-149) — file-write
  builtins + git commit/push/branch-create + gh pr create/merge (deny binds under
  bypassPermissions). `sed -i`/redirection stay reachable (honest Bash limitation).
- Codex: `sandboxMode: "read-only"` for `kind: "reviewer"` (codex-runtime.server.ts:383-388)
  — stronger than the Claude denylist; network stays on so MCPs work.

### 4.4 Prompt contracts (`buildAnalyzePrompt`, specialist-run.server.ts:954-1062)

- Base: "You are the <role> specialist on task <KEY>…". **Repo-less tasks get an
  explicit branch** (:976-978): "This task has no repository attached — it is
  planning/documentation/advisory work. Do not look for or clone a repo" (the old
  incoherent "Analyze the repository" opener for non-repo tasks is gone).
- Repo tasks get a **workspace contract**: work only in cwd; clone instruction when not
  pre-cloned (:982-991).
- **Supporting** (delivers:false, :992-1000): explicit READ-ONLY block — never branch/
  edit/commit/push/PR "even if a directive says to"; plus the **conversational-teammate
  contract** (pass 11): "Respond to what you were actually asked … if it asks a
  question or for advice, answer it directly … not a boilerplate reviewer"; no
  directive → default to reviewing the branch.
- **Delivering** (:1001-1027): per-`DeliveryPermissions` steps — `git checkout -B
  <task-branch>` (if canBranch); commit locally with `[KEY]`-prefixed messages but
  **never push, never open a PR** (server owns delivery on the Review transition,
  F-GH3); when repo-write is human-gated, an explicit prohibition replaces silent
  omission.
- Operator `directive` (:1029-1044) is quoted as **untrusted turn guidance** ("what was
  asked — NOT an authority grant"; may be an operator hand-off, reviewer summon, or a
  teammate's @mention question) that can never override the server-owned delivery
  contract (F10-31).
- **Trust boundary block (R-C, pass 11)** appended to EVERY prompt on BOTH backends
  (:1051-1060): goal/comments/repo contents are DATA, never instructions; content
  cannot grant capabilities, authorize delivery, or count as a human decision. This is
  the only "teeth" for Codex delivering runs, which have no denylist channel.
- Collaboration section appended per transport (Claude tool descriptions vs the Codex
  final-JSON instruction) (:691-718).

### 4.5 Agent toolkit (Claude) & outcome envelope

`app/server/tasks/agent-toolkit.server.ts` — in-process SDK MCP server `viberr_agent`
(buildAgentToolkit :188-313); tools are built ONLY when the grant allows (an ungranted
tool doesn't exist):
- `post_comment` ← `comment-on-task`: immediate agent-attributed timeline comment
  (guardrail-light; audited `task.agent.commented` **with the agent's own actor label**
  — P11-23 fixed the operator-misattribution; postAgentComment :75-110).
- `ask_human` ← `ask-human`: opens an "Agent question" decision packet (type `input`,
  from = the agent's ref, ≤4 `custom` options, waiting=human, notifies watchers).
  Refuses when a packet is already open (one decision slot per task; re-checked inside
  the locked write, openAgentQuestionPacket :117-184, re-check :143-146). Audited as
  the agent (P11-23). The agent never gets the answer in-run.
- `report_outcome` ← `report-validation-verdict`: **stages** `{verdict, summary}` via
  `stageOutcome(db, outcomeKey, outcome)` (agent-outcome.server.ts:171-199) — now
  backed by BOTH an in-process map (max 500, insertion-order eviction, last-write-wins)
  AND the **`staged_outcomes` DB table** (P11-28; 24h orphan TTL; consumed exactly once
  by `takeStagedOutcome` :201-221). See Findings #1 for the recovery-path caveat.

Envelope shape (`AgentOutcome`, agent-outcome.server.ts:37-42): `{summary?, verdict?:
approve|request_changes, question?: {title, body?, options?}}`.
`AGENT_OUTCOME_JSON_SCHEMA` (:54-94) is the Codex `outputSchema` transport and MUST obey
OpenAI strict rules (every property in `required`, optionality via nullable types —
getting this wrong 400s the whole run). `parseAgentOutcomeJson` (:102-153) tolerantly
parses the Codex final reply (strips one fence; null when not an envelope).
`buildAgentQuestionPacket` (:296-326) is the shared packet shape for both transports.

### 4.6 Completion pipeline (`applyAgentCompletionEffects`, task-actions.server.ts:1650-2035)

Shared byte-for-byte by the live callback (`registerAgentCompletion` :1603-1642) and
boot recovery (`recoverUnreactedAgentRuns`, run-recovery.server.ts:181-303). Steps:

1. Resolve the envelope (:1697-1748): Claude staged outcome (via `outcomeKey` →
   `takeStagedOutcome(db, key)`) first, else parse the Codex reply JSON (raw JSON never
   becomes the timeline comment — `summary` does).
2. Verdict authority = engagement `verdictCapable` snapshot (:1726-1735; fallback: live
   grants). Verdict = envelope verdict, else **prose classifier fallback**
   `classifyReviewerVerdict` (:1351-1407 — explicit "Verdict:" line > strong
   request-changes phrases > negation-aware weak negatives > approve phrases). The
   regex NEVER runs without verdict authority (R1). A verdict-granted run with no
   determinable verdict logs loudly and leaves validation unchanged (fail-safe, F10,
   :1762-1778). **Question authority deliberately uses the LIVE `collab.ask` grant**
   (:1780-1788) — the snapshot/live asymmetry is now documented in-code as intentional
   (P11-26: a question is open-only, never blocks acceptance, so honoring a revoked
   grant is correct).
3. **`recordAgentCompletion`** (:1410-1600) — ONE atomic task-file write: reply comment
   + verdict event + question packet. Verdict binds to the CURRENT `workRevision`
   (skipped when none — "Approval noted", never a pass); `validation` recomputed via
   `deriveValidation`; event title derived from the RESOLVED validation (F7-REV3:
   "Review passed" only when healthy; else "Approval noted — rework still needed").
   Stale `accept_completion` recommendations dropped when not healthy (:1501-1506).
   Audits + watcher notifications for verdicts/questions.
4. Errored runs (state `error`, :1811-1897): typed `blocked` timeline event with a
   classified reason (`runFailureReason`, agent-reply.server.ts:376-406 — kinds
   quota/auth/unavailable/max_turns/unknown, read from the adapter's `·<kind>` tag
   suffix), a stuck/recovery packet whose first option is **`retry_other_backend`**
   (D4, :1865-1877) for backend-level failures, watcher notify, waiting→human, stop.
   The retry option is executed by `resolvePacket` via `startAgentRun{backendOverride}`
   (task-actions.server.ts:3224-3260) and the switch persists to the engagement.
5. Finished runs withdraw a superseded "work stalled" packet about the same agent
   (:1902-1910).
6. **Delivery reconcile** (:1918-1941) — delivering runs only:
   `reconcileWorkspaceDelivery` (workspace-delivery.server.ts:198-552) inspects the
   workspace git repo: links the real branch, commit cache (shallow-clone-aware),
   **mints the workRevision** (§3.1, incl. the P11-72 empty-diff skip), and best-effort
   links a PR via `gh` — idempotent, never throws (failures logged, F13).
7. **Operator react** (:1944-2035): `operatorShouldReactToReply` (:112-122) — finished
   + non-empty reply + reply differs from the agent's previous stored reply + depth <
   `OPERATOR_REACT_DEPTH_CAP = 4` (:90). React → `runOperator{trigger:"agent-reply",
   reactDepth+1, agentReply: <resolved prose reply>}` (handed directly in the prompt,
   never dependent on the timeline comment surviving). No-react + (verbatim repeat OR
   depth cap) → stuck-loop packet; ALWAYS `clearWaitingToHuman` (:2038-2056) when the
   chain terminates.

Actor refs: agents are `agent:<backend>/<profileId> (Role Snapshot)` — profileId is the
identity, role a display hint; unknown refs round-trip verbatim
(task-file.schema.ts:~935-968, D7).

## 5. Operator

Core files: `app/server/runtimes/operator-run.server.ts` (run lifecycle),
`app/server/tasks/operator-actions.server.ts` (capability-gated actions),
`app/server/tasks/operator-toolkit.server.ts` (Claude tools).

### 5.1 Authority & gating

`resolveOperatorAuthority` (operator-actions.server.ts:139-206): finds the project's
`kind === "operator"` deployment → `{policy: Map<capId, mode>, autonomy
(supervised|full, from deployment.definition.autonomy, overridable per run), backend,
model, effort, name, skills, kb, persona (P11-21 — the deployment's persona override,
null → shipped/baked), deployed}`. No deployment → inert defaults with
`deployed:false` (auto-invokes no-op). `operatorBackendFor` (:120-137, P11-76) is the
cheap UI read for the run-panel backend default.

`gate(authority, capId)` (:209-223) → `direct | recommend | deny`:
- `direct` → direct. `human`/`off`/absent → deny.
- `recommend` → `direct` under full autonomy **except `completion-for-acceptance`**,
  which stays `recommend` (owner ruling Q1: agent-close of a task requires an explicit
  `direct` grant, never an autonomy side-effect).

### 5.2 Triggers (when the operator fires)

`runOperator(db, input)` (operator-run.server.ts:265-362; `RunOperatorInput` :60-92 now
carries `transitionDepth`) with `trigger`:
- `create` — task creation (task-actions.server.ts:473 via `autoInvokeOperator`
  :556-585, which now threads `transitionDepth`).
- `transition` — **EVERY move to a non-Done stage, including the operator's own**
  (ADR-002 / P11-70 operator-stranding fix; task-actions.server.ts:2528-2573). An
  operator-authored transition threads `transitionDepth+1`
  (`nextTransitionChainDepth` :107-109; ctx shape :78-86); at
  **`OPERATOR_TRANSITION_CHAIN_CAP = 8`** (:103) the transition still lands but instead
  of another LLM run a stuck-loop packet opens (:2547-2562) — any human action or agent
  reply restarts the chain at 0. Packet resolutions that send work back
  (request_edit/redirect/custom) also fire `transition` (:3212-3218).
- `goal-updated` — goal edits (:550); the turn instruction tells it to withdraw a
  now-moot scope packet.
- `agent-reply` — the react loop (§4.6 step 7), with `agentReply` embedded (first
  4,000 chars, `agentReportBlock` operator-run.server.ts:1008-1013).
- `manual` — `@operator …` comments (task-actions.server.ts:807-824, with
  `humanComment`), the task-detail operator panel, boot recovery of orphaned runs
  (run-recovery.server.ts:126-144, crash-loop capped at 3 per 30-min window), and the
  schedule runner (schedule.server.ts — `run-operator` schedules on the task file,
  60s tick `SCHEDULE_TICK_MS` :36, claim→fire lifecycle with a 5-min claim lease
  :203, `startScheduleRunner` :416, F10-16; P11-75: cancel leaves `firedAt` null).

**Single-flight lease** (operator-run.server.ts:117-263): process-global per-task
lease held from entry through provider completion AND Codex plan execution; a trigger
arriving while held is QUEUED (newest wins) and fired exactly once on release; release
is idempotent per lease-token object (:176-205); a cross-boot DB-row backstop chains
the queued trigger onto the in-flight run's completion (:299-317). On final release
with nothing queued and no live run, waiting flips back to human
(`settleWaitingAfterOperator` :218-239). **New (pass 11): the operator drive itself
sets `waiting: agent` at start** (`markWaitingAgent`, :349-350) so the board reads
"working" during coordination, settled back on release.

### 5.3 Claude operator: toolkit run

`startRealOperatorRun` (operator-run.server.ts:786-853): `startRun` kind `operator`,
backend claude, `systemPrompt` REPLACES the Claude Code preset (coordinator, not coder),
`mcpServers = { viberr: <in-process SDK server> }`, `allowedTools` = exactly the built
`mcp__viberr__*` names. Errored runs escalate a blocked recovery packet
(`escalateFailedOperatorRun` :862-908, F-OP1, quota/auth-aware copy) — now ALSO wired
for errored Codex operator runs (:571).

Toolkit (`buildOperatorToolkit`, operator-toolkit.server.ts:71-360) — a tool is **not
even built** when its capability gates to deny:
- `get_task` (always, :86-95): full `operatorSnapshot` + its own policy/autonomy.
  Snapshot (operator-actions.server.ts:704-794) includes goal, stage graph
  (nextStages/stageIds/done/review/work ids resolved from the workflow graph),
  delivering + supporting engagements, `deployedSpecialists` (each
  `DeployedSpecialistView` + `eligibleForCurrentStage`), open-packet CONTENT, last 6
  timeline entries (1,500-char capped), autonomy + policy. The tool description
  instructs: draft an unspecified goal FIRST; **select agents by `desc` +
  `capabilities` (delivery/verdict/askHuman), never by name**.
- `post_comment`, `set_goal` ← `append-typed-events` (:97-130). `set_goal`
  (operator-actions.server.ts:822-890) fills only an UNSPECIFIED goal
  (placeholder/blank); refuses to overwrite real scope; fulfills an awaiting
  `goal_edit` packet.
- `open_decision_packet`, `resolve_decision_packet` ← `generate-packets` (:132-221).
  Packets (operator-actions.server.ts:464-581): typed options from
  `PACKET_OPTION_KINDS` (task-file.schema.ts:55-70: accept_completion, request_edit,
  block_on_policy, hold_runtime_debug, redirect, retry_other_backend, edit_goal,
  custom), exactly one recommended, stable `id`, blocked packets set
  `readiness=blocked` (NOT validation — F7-VAL1), waiting=human, watcher notifications.
  `operatorResolvePacket` withdraws a moot packet with a timeline reason (:591-643).
- `engage_agent {profileId, delivers}` / `run_agent {profileId?}` /
  `prompt_agent {profileId, prompt, delivers?}` ← gated per shape:
  delivers:true → `assign-primary-specialist`, delivers:false → `summon-reviewers`
  (tools offered if EITHER is non-deny; each call still gated,
  operator-toolkit.server.ts:225-309). Dispatchers (operator-actions.server.ts:
  operatorEngageAgent :1289-1317, operatorRunAgent :1344-1397,
  operatorPromptAgentGeneric :1399-1437): `resolveDeliversIntent` (:1322-1342 —
  explicit hint > how already engaged > deliverer-less default), a selection **audit
  trace** `task.operator.agent_selected` with the full candidate list
  (recordAgentSelectionTrace :1245-1287), then gate → `recommend` mode posts a
  one-click **recommendation card** and stops; `direct` performs: engage (idempotent),
  best-effort `ensureTaskBranch`, then `operatorPromptAgent`
  (task-actions.server.ts:2082-2155) — posts the `@handle …` prompting comment
  (to-agent tint, `withMention` :2159-2166) and calls `startAgentRun` with the
  directive, operator-authorized, `ctx.operatorRun` preserved so the react chain
  continues. **P11-22:** `run_agent {profileId: X, delivers:true}` where X is NOT the
  current deliverer is now REFUSED with a pointer to `engage_agent`
  (operator-actions.server.ts:1363-1382) — it no longer silently runs the wrong agent.
- `transition_stage` ← `stage-transitions` (:311-332). `auto` boundaries and rework
  moves bypass the recommend gate: a backward move on a `failing` task is performed
  **directly** (R7-4 rework routing, operator-actions.server.ts:1439-1486, isReworkMove
  :1505-1522, operatorBoundaryFor :1526-1541); `transitionStage` re-vets rework
  server-side (task-actions.server.ts:2382-2397) and FORBIDS an operator bare-move to
  Done (:2421-2430; a HUMAN manual move to Done routes through full `acceptCompletion`,
  :2407-2419).
- `accept_completion` ← `completion-for-acceptance` (:334-349; §5.5).

Recommendations (`addRecommendation`, operator-actions.server.ts:365-434): stored in
frontmatter `recommendations[]` (kinds: assign_specialist, assign_reviewer, transition,
run_specialist, run_reviewer, accept_completion — task-file.schema.ts:~136-153),
rendered as Apply/Dismiss cards (applied via `applyRecommendation`,
task-actions.server.ts:3450+), idempotent per (kind, target), waiting=human + watcher
notification on new ones.

Comment guardrails (writeOperatorComment, operator-actions.server.ts:259-357): the
meaningful-comment / evidence-separation / operator-brevity / no-duplicate-summary /
compression-threshold guardrails from project `guardrails[]` all enforce for real.
Human comments also trigger compaction (task-actions.server.ts:645-668).

### 5.4 Codex operator: structured plan

Codex can't mount in-process tools → `startCodexOperatorRun`
(operator-run.server.ts:520-589): `startRun` with `outputSchema: OPERATOR_PLAN_SCHEMA`
(:393-441 — strict-mode: additionalProperties:false, all properties required,
nullables for optionality). Plan = `{reasoning, actions[]}`, action tools:
post_comment, open_packet, resolve_packet, set_goal, engage_agent, run_agent,
prompt_agent, transition_stage, accept_completion (:372-389). **P11-27:** `open_packet`
actions may now AUTHOR their own `packetOptions` (2–4 × `{kind, title, recommended}`;
normalized by `authoredPacketOptions` :488-503 — filter-then-cap, exactly one
recommended); null → canned defaults keyed by type (`defaultPacketOptions` :505-518).
Per-option `detail` still can't be authored (schema has no field). On clean completion,
`executeCodexPlan` (:604-782) re-validates through a zod runtime mirror (:449-471 —
provider output is a trust boundary), repairs `\n` escapes, then executes each action
through the SAME gated operator-actions (identical RBAC/autonomy as Claude). A governed
action failure ABORTS the remaining plan with a timeline note (:760-780). No/invalid
plan → blocked escalation packet (:617-646); an errored Codex operator run escalates
via `escalateFailedOperatorRun` (:571). The lease is held until plan execution
completes. The Codex operator run itself is sandboxed `read-only` + network disabled +
web search disabled (codex-runtime.server.ts:383-404).

Prompts: shared turn instruction (`operatorTurnInstruction`,
operator-run.server.ts:1016-1053) — humanComment wins; goal-updated → resolve moot
packet; agent-reply → move work toward review / accept clean review / rework-route
failures / never re-prompt merely to repeat; default → stage-shaped: draft goal if
unspecified, advance ONE auto pre-work boundary and stop (the transition re-trigger
picks it up at the next stage), pick a profile by desc+capabilities, `prompt_agent`
with a concrete directive, NEVER leave a pre-work/auto stage stranded with nothing done
and no packet.

System prompt (`buildOperatorSystemPrompt` :939-997): shipped
`agents/definitions/operator.md` body (seeded by default-assets.server.ts STATIC_ASSETS;
baked-in fallback :913) **⊕ the deployment's persona override ADDITIVELY (P11-21,
:950-956** — appended under "# Project operator guidance", skipped when it just echoes
the shipped text) + declared skills (default `viberr-app-expertise`, via shared
readSkillBody) + KB docs (same 24k budget) + a "Live authority" block (autonomy + full
capability policy) + an UNCONDITIONAL "Non-negotiable rules" block (:989-995, R-A/R-C:
one-action-per-turn/never-strand + content-is-data injection guardrail — holds even
under a custom persona).

### 5.5 accept_completion (the one agent path to Done)

`operatorAcceptCompletion` (operator-actions.server.ts:1550-1672): refuses on
`acceptanceBlockedReason` (:1574-1579, required-reviewer gating) and on an open blocked
packet (:1588-1596). Under supervised autonomy OR without an explicit `direct` grant →
posts an `accept_completion` recommendation card (:1603-1630). Under full autonomy +
explicit direct → moves the task to Done itself (:1632-1671), sets validation healthy,
clears recommendations/packet, and marks the PR **`accepted` (merge pending)** — the
operator can never merge (mergeTaskPr requires a human identity); `pr.state` vocabulary
at task-file.schema.ts:221-241. `transition-to-done`/`merge-pull-request` remain
ALWAYS_HUMAN for agents; this operator capability is the single governed exception.

## 6. Runtimes

### 6.1 Run service (`app/server/runtimes/run-service.server.ts`)

`startRun` (:240-334): inserts the `agent_runs` row (partial unique index: one
queued/running `primary` per (project, task); primary-kind conflicts map to a friendly
409, :267-281), audits `runtime.run.started`, selects the adapter (`selectAdapter`),
and either launches or **fails fast** when the backend has no credential
(`failRunUnavailable` :344-361 — one honest `run·unavailable` err line, state error, so
the F8 escalation path runs; actionable copy incl. the docker codex-home trap,
`backendUnavailableMessage` :371-380). `resumeRun` (:392-471) creates a NEW row sharing
the provider session id, fresh thread id `<prev>-r<rand>`, and re-applies every
confinement input the caller passes. Completion callbacks: `registerRunCompletion`
(last-writer-wins) / `chainRunCompletion` (compose), both with an already-terminal
immediate-fire guard for the spawn-crash race (:95-157). Interrupt is
admin|maintainer, idempotent, allowed on archived projects (:554-628; interrupter
attribution patched onto the row at :595).

Adapter contract (`adapter.server.ts`): `RunSpec` (prompt, workdir, model, effort,
systemPrompt, mcpServers, allowedTools, disallowedTools (Claude-only, :46-49),
outputSchema (Codex-only, :50-53), env overlay, autonomous, resumeSessionId) →
callbacks `onLine` (raw envelope + projected display + facts) / `onExit`
(finished|error|interrupted from the STREAM, never exit codes). `RunHandle.interrupt()`
is now zero-arg (:91-96) — the old decorative `(byUserId, byLabel)` signature is gone
(attribution documented as service-side). Lines persist through `run-sink`
(raw .jsonl + DB) then SSE.

### 6.2 Registry & spawn env (`runtime-registry.server.ts`)

Availability = cheap credential presence, re-probed every call (self-healing,
`isBackendAvailable` :137-147):
claude — `ANTHROPIC_API_KEY` | `CLAUDE_CODE_OAUTH_TOKEN` | `VIBERR_CLAUDE_USE_CLI_AUTH=1`
(:108-115); codex — `CODEX_ACCESS_TOKEN` | `CODEX_API_KEY`/`OPENAI_API_KEY` |
`VIBERR_CODEX_USE_CLI_AUTH=1` **and** `$CODEX_HOME/auth.json` exists (F-DOCKER1,
:116-122, diagnostics :88-106). Overrides are sticky (tests, :164-166).

Both SDKs **REPLACE** the child process env with the `env` option (verified in the
bundled SDKs — F10-02). `filteredSpawnEnv` (:187-196) starts from process.env and
strips every credential-shaped var (`API_KEY|SECRET|TOKEN|PASSWORD|…` regex :182-185) +
DATABASE_URL/REDIS_URL/SSH_AUTH_SOCK/GPG_AGENT_INFO, keeping PATH/HOME/locale/proxy.
`claudeSpawnEnv` (:238-248) adds only `CLAUDE_CONFIG_DIR` (single resolver
`resolveClaudeConfigDir`, claude-config.server.ts:25-32 — explicit env > `~/.claude`
under CLI auth > `<dataRoot>/runtimes/claude-home`; session-export reads the same dir)
+ the selected Claude credential. `codexSpawnEnv` (:204-221) adds CODEX_HOME +
CODEX_ACCESS_TOKEN and deletes CODEX_API_KEY/OPENAI_API_KEY when subscription auth is
requested (no silent API billing). `createAdapters` (:251-295) ALWAYS passes both full
spawn envs. Per-run `spec.env` (git ceiling + git identity) overlays this base.

### 6.3 Claude adapter (`claude-runtime.server.ts`)

`query()` from the Agent SDK; streaming-input single message so `interrupt()` works
(:207-215); `resume: sessionId`; `permissionMode: bypassPermissions` when autonomous;
`maxTurns` runaway guard (default 2,000, `VIBERR_CLAUDE_MAX_TURNS`, :271-276; a capped
run emits a classified `run·error·max_turns` reason line :509-525 — cut-off, not
failure). Isolation: `settingSources: []`, `skills: []`, `plugins: []` — but ~16
first-party skills are compiled into the SDK binary and still appear in init
(docker-verified), so the **`Skill` tool is denied** instead. `BASE_DENIED_BUILTINS`
(:177-205) for EVERY run: Skill, the whole Task/subagent-spawn family
(Task/TaskCreate/…/Workflow — a denied-tools run must not spawn an unrestricted
subagent), Cron*/ScheduleWakeup/RemoteTrigger/Monitor, PushNotification/SendMessage,
DesignSync, Enter/ExitWorktree. Plus `OPERATOR_DENIED_BUILTINS` (:113-121,
Bash/Edit/MultiEdit/Write/NotebookEdit) for operator runs, `SUPPORTING_DENIED_BUILTINS`
(:136-149) for reviewer-kind runs, plus the per-profile capability denylist (deny
assembly :443-450). Deny wins under bypassPermissions; `allowedTools` merely
auto-approves. `mcp__*` tools are deliberately never denied (:168-175 rationale).

System-prompt strategy (:409-428): operator persona **replaces** the default
(coordinator); specialist persona is **appended** to the `claude_code` preset (keeps
the coding harness). Live usage accumulation from assistant messages (:455-490); final
`result` envelope is authoritative. Failures are classified in-memory
(quota/auth/unknown + spawn-crash EBADF/ENOENT, `classifyClaudeError` :278-320) into a
redaction-safe reason line tagged `run·error·<kind>` (:334-354). Model label mapping
`resolveClaudeModel` :96-105 (sonnet/opus/haiku aliases; dated ids pass through).

### 6.4 Codex adapter (`codex-runtime.server.ts`)

`Codex.startThread/resumeThread` + `thread.runStreamed(prompt, {signal,
outputSchema?})`. Sandbox (:383-388): operator/reviewer → `read-only`; autonomous
delivering → `danger-full-access`; else `workspace-write`. `approvalPolicy: "never"`
(:398). Operator additionally gets network + web-search disabled (:399-404). Config
(`codexConfigForRun` :133-168): `developer_instructions` = systemPrompt,
`allow_login_shell: false`, ChatGPT `apps` feature off, cross-run `memories` fully off,
`mcp_servers` = translated portable declarations, `shell_environment_policy: {inherit:
core}` + only GIT_CEILING_DIRECTORIES crossing into tool shells. **Ignores
`disallowedTools` entirely** (no such SDK channel) — capability tool-denial is
Claude-only/advisory here; the reviewer read-only sandbox is the Codex-side teeth.
Idle (inactivity) timeout 15 min default (`VIBERR_CODEX_IDLE_TIMEOUT_MS`, :173-177)
aborts a hung run to `error` (:268-301, distinguished from interrupt :455-460).
Failures classified in-memory before redaction (`classifyCodexFailure` :202-243); raw
stderr never persisted (`safeCodexError` :181-185, `emitAdapterFailure` :322-338).
Success = `turn.completed` seen with no top-level `turn.failed`/`error` (:471-476).

MCP translation (`codexMcpServers` :69-108): HTTP → `{url,
default_tools_approval_mode: "approve"}`; stdio → `{command, args}`; in-process
`type:"sdk"` servers skipped. **Credentials are deliberately dropped on Codex** —
the SDK serializes config into `--config` argv (ps-visible), so a credentialed org MCP
authenticates on Claude only (specialist-mcp.server.ts:24-31 docstring; the standing
codex-argv exposure the owner scoped out).

### 6.5 Skills / KB / MCP mounting per profile

- **Skills**: never SDK-discovered. Each declared skill's `SKILL.md` body is injected
  as system-prompt text via the ONE shared reader
  `app/server/files/skill-body.server.ts` (`readSkillBody`, P11-36 — specialists:
  buildSpecialistPersona; operator: buildOperatorSystemPrompt). Store path
  `${dataRoot}/skills/<name>/SKILL.md`.
- **KB**: declared KB folders injected as text (`app/server/files/kb-injection.server.ts`
  `readKbBody` :125-169): recursive walk with symlink/cycle/containment guards
  (:57-115, F10-18), all text-doc extensions (:36-43), global 24k-char budget shared
  across KBs, explicit truncation marker when clipped (:155-164).
- **MCPs**: profile `resources.mcps` names → org MCP registry
  (`resolveSpecialistMcpServers`, specialist-mcp.server.ts:32-69): HTTP →
  `{type:"http", url, headers.Authorization?}`; stdio → `{command, args,
  env.MCP_CREDENTIAL?}`; sealed credentials decrypted only at spawn time; the reserved
  name `viberr` is skipped (operator-only governance server); unknown names skipped.
  Merged with the Claude collaboration toolkit at run start.
- **Model/effort**: `model-catalog.server.ts` — curated catalogs (`curatedCatalog`
  :146; claude family aliases + live `supportedModels()` enhancement w/ TTL cache
  :244-365; codex hand-maintained gpt-5.6-sol/terra/luna + gpt-5.5). `resolveRunModel`
  (:185-199) guards every run against display-label placeholder models;
  `resolveRunEffort` (:201-232) maps effort tiers by rank across backends for D4
  retries. Claude adapter additionally maps labels via `resolveClaudeModel`
  (claude-runtime.server.ts:96-105).

### 6.6 Boot recovery (`run-recovery.server.ts`)

`finalizeOrphanedRuns` (:38-151): non-terminal rows at boot → `error`
(interrupted-by-restart) + operator re-invoke per task, crash-loop capped
(`RECOVERY_REINVOKE_CAP = 3` per 30-min window via audit rows, :19-20).
`recoverUnreactedAgentRuns` (:181-303): finished specialist runs on still-waiting=agent
tasks with no `task.agent.replied` audit → replay `applyAgentCompletionEffects` (same
reply/reconcile/verdict/react as a live callback), per-run replay cap via
`run.recovery.reply_replayed` audit rows. Recovery passes **no `outcomeKey`**
(:277-291) — so despite the `staged_outcomes` table (P11-28), a Claude verdict staged
before a full restart is NOT recovered structurally; the prose classifier is the
fallback (see Findings #1). Codex envelopes re-parse from the stored reply.

---

## Delta since pass 11 (doc of 2026-07-23)

Commits landed: `63cfe53` (round-2 review fixes on PR #87), `e306248` + `625eb71`
(clean-sheet seed), merges `b361ba5`/`0981cfa`. Net changes vs the pass-11 doc:

1. **Operator transition re-trigger is now chain-capped** (63cfe53). Every non-Done
   transition — including the operator's own — re-invokes the operator (P11-70);
   consecutive operator-authored transitions thread `transitionDepth`
   (RunOperatorInput → ctx.operatorRun → transitionStage, the reactDepth idiom) and
   **`OPERATOR_TRANSITION_CHAIN_CAP = 8`** (task-actions.server.ts:103) converts a
   runaway loop into a stuck-loop packet (:2547-2562). The pass-11 doc's "a NON-operator
   stage move" trigger description is obsolete.
2. **Clean-sheet seed** (e306248/625eb71): built-in agent catalog moved to
   `app/server/seed/agent-catalog.server.ts` (SEED_AGENT_PROFILES :79,
   defaultAgentDeployments :160, baseAgentDeployments :177); `demo-data.server.ts` /
   `demo-seed.server.ts` DELETED from app/server/seed — the mock dataset is now the
   test-only fixture `test-support/demo-data.ts` + `test-support/demo-seed.ts`; new
   `app/server/seed/seed.server.ts` (`runSeed`: templates + projection rescan +
   env-configured bootstrap admin `admin@viberr.dev`, nothing else; `--reset` wipes
   projects/profiles/transcripts/derived tables incl. `staged_outcomes`, keeps
   users/auth + runtime credential homes).
3. **Migrations re-squashed** (ruling): the one-delivering partial unique index now
   lives in `db/migrations/0001_baseline.sql` (:335-339); no 0002. `staged_outcomes`
   table at 0001_baseline.sql:352-356.
4. Session export split: run projections use the new cheap `transcriptExists(backend,
   sid)` probe (session-export.server.ts) instead of the full content-scanning locator
   (export-route-only now). `/api/auth/*` inverted to an `ALLOWED_AUTH_PATHS` allow-list
   (app/lib/auth.server.ts). Reconcile poller handle behind a `Symbol.for` global with
   the boot poll inside the idempotence guard (github/reconcile-poller.server.ts) —
   plus the 5-min GitHub PR-status poller from 582fd63. None of these change the
   agent/operator machinery contracts above.
5. Corrections to the pass-11 doc discovered during re-verification (these were already
   true at merge of PR #87 but the doc predated/missed them):
   - Staged outcomes are DB-backed (`staged_outcomes`, P11-28) — the doc's "in-memory
     map… lost on restart" is half-stale (see Findings #1 for what's still lost).
   - `resolveAgentCollab(grants)` — the `delivers` arg is gone (P11-31).
   - Agent toolkit audits attribute to the AGENT (P11-23), not "operator".
   - Operator deployment persona is CONSUMED at runtime (P11-21, additive merge) — the
     doc's Suspicious #2 is fixed.
   - Codex operator can author packet options (P11-27) — Suspicious #13 fixed
     (minus per-option `detail`).
   - `operatorRunAgent` refuses a delivering run naming a non-deliverer (P11-22) —
     Suspicious #12 fixed.
   - `RunHandle.interrupt()` signature is honest now — Suspicious #4 fixed.
   - Repo-less tasks get a coherent no-repo prompt — Suspicious #15 fixed.
   - `readSkillBody` deduplicated into skill-body.server (P11-36) — Suspicious #17
     half-fixed (OPERATOR_AUDIT_ACTOR is still defined twice).
   - Verdict-vs-question authority asymmetry is now documented in-code as deliberate
     (P11-26) — Suspicious #8 resolved-by-documentation.
   - New prompt-side hardening the doc lacked: the universal "Trust boundary" block +
     conversational supporting-agent contract (buildAnalyzePrompt), the operator
     "Non-negotiable rules" block, `resolveDeliveryPushGrant` (P11-13),
     no-commit → no-revision (P11-72), packet-resolution free-text note carried into
     the decision event (P11-71), operator drives set waiting=agent (markWaitingAgent
     in runOperator), `comment-on-task` relabeled "Post mid-run comments" (P11-29),
     `operatorBackendFor` (P11-76).

## Findings candidates (pass 12)

Everything below was verified in current source. Ordered by likely impact.

1. **`staged_outcomes` persistence is unreachable on the exact path it was built for.**
   The table's stated purpose (db/migrations/0001_baseline.sql:345-351 and
   agent-outcome.server.ts:158-165) is surviving "a restart between the run finishing
   and its completion callback firing… boot recovery reads the persisted row". But
   `takeStagedOutcome` is keyed by `outcomeKey`, which lives only in the in-process
   completion-callback closure (specialist-run.server.ts:635 → registerAgentCompletion
   input); `agent_runs` has NO outcome_key column (0001_baseline.sql:257-284) and
   `recoverUnreactedAgentRuns` passes no `outcomeKey`
   (run-recovery.server.ts:277-291), so `applyAgentCompletionEffects` skips staged
   lookup entirely (task-actions.server.ts:1738: `input.outcomeKey ? takeStagedOutcome…
   : null`). After a true restart a Claude reviewer's staged verdict still falls back
   to the prose regex; the DB row only helps same-process map misses (500-entry
   eviction, dev-HMR module reload). Fix shape: persist outcome_key on the run row (or
   key staging by runId) and have recovery pass it.
2. **Codex delivering agent still ignores ALL capability tool-denial** — a Codex
   `delivers:true` run is `danger-full-access` (codex-runtime.server.ts:383-388) and the
   SDK has no denylist channel, so `execute-code-or-write-repo: off/human` (and
   branch/push/PR withholds) bind only via the prompt on Codex (now at least the
   explicit Trust-boundary block, specialist-run.server.ts:1051-1060). Combined with
   `default_tools_approval_mode: "approve"` stamped on every translated MCP
   (codex-runtime.server.ts:83-104), a Codex delivering agent's MCPs are entirely
   ungoverned. Documented as claude-only/advisory (capabilities.ts:116-126) but remains
   the biggest enforcement asymmetry: the same grant config is hard on Claude, soft on
   Codex.
3. **Stale/security-misleading comment in the completion pipeline** —
   task-actions.server.ts:1702-1704 says an undeployed profile "falls back to the
   transition defaults (supporting → verdict on, delivering → verdict off)". F10-14
   removed that rule; actual behavior is catalog defaults (verdict OFF for everyone,
   agent-outcome.server.ts:239-275). A reader could conclude supporting agents get
   verdict power by default. Comment-only fix.
4. **Cross-boot lease-release race (no token)** — the DB-row backstop registers
   `chainRunCompletion(inflight.id, () => releaseOperatorLease(db, leaseKey))`
   WITHOUT a token (operator-run.server.ts:305-306), and `releaseOperatorLease` skips
   the stale-release guard when `token === undefined` (:183). If the cross-boot
   in-flight run finishes AFTER a new drive has meanwhile acquired the process lease
   (possible: run finishes → a fresh trigger acquires before the chained callback
   runs), the tokenless release evicts the new drive's lease and fires the queued
   trigger concurrently — the double-drive the token mechanism (adversarial-review
   #5/#7) exists to prevent. Narrow window, but the in-process path deliberately
   guards it while this path doesn't.
5. **`resolveResumeConfinement` catch branch is still nearly open**
   (specialist-run.server.ts:1174-1177) — for an undeployed profile it applies
   `resolveSpecialistDisallowedTools([])`, which denies only `Bash(gh pr merge:*)`
   (the sole ALWAYS_HUMAN cap with a deny rule). No persona, no MCPs, no envelope. A
   resumed run of an undeployed profile is close to unconfined at the tool level
   (workspace env/ceiling still applies). Unchanged since pass 11.
6. **Three stale doc-comments in the runtime layer** (unchanged since pass 11):
   (a) adapter.server.ts:50-53 — `RunSpec.outputSchema` described as "used by the
   structured-output operator" only; it is also the generic agent outcome envelope
   (specialist-run.server.ts:783). (b) codex-runtime.server.ts:342-357 — claims
   `deps.env` "is only set when CODEX_HOME is configured; with API-key auth it's
   undefined"; `createAdapters` ALWAYS passes a full `codexSpawnEnv`
   (runtime-registry.server.ts:260-292), so the process.env-snapshot fallback is dead
   in production wiring. (c) run-service.server.ts:209 — `disallowedTools` doc doesn't
   say Claude-only (adapter.server.ts:46-49 does).
7. **Operator snapshot still speaks the legacy vocabulary** —
   `OperatorTaskSnapshot.specialist`/`reviewers` (operator-actions.server.ts:668-669)
   while the toolkit prose says delivering/supporting; models see both namings. Also
   `deployedSpecialists` is the field name for what the docs call generic agents.
8. **`ask-human`/`comment-on-task` default to `direct`** (capabilities.ts:54-55) — a
   freshly created profile with zero grants can open decision packets
   (`resolveAgentCollab` gives ask=true on absent grant). Contrast
   `report-validation-verdict` default off with an explicit safety comment.
   `DeployedSpecialistView.capabilities.askHuman` therefore shows true for nearly
   every profile — weak as an operator selection signal
   (specialist-run.server.ts:1479).
9. **`directiveRequestsDelivery` is detection-only and regex-bounded**
   (specialist-run.server.ts:1065-1069, consumed :796-798) — it stamps a policy note;
   the directive text still enters the prompt verbatim (mitigated by the precedence
   prose + trust-boundary block, F10-31). The regex was broadened in pass 11 ("push
   the changes/code/work", "create a PR", "merge the branch") but still misses
   paraphrases like "publish the branch" / "raise a merge request".
10. **`AGENT_HANDLE_RE` vs profile-name mentions** — task-actions.server.ts:591: only
    `@agent|operator|codex|claude` set the to-agent tint in plain `appendComment`;
    named mentions rely on `commentToAgent`'s `forceToAgent` (:616, :776). Any route
    that calls `appendComment` directly with `@dev …` records a non-routed comment.
11. **Claude quota-failure copy says "coordinating model" for every run kind** —
    classifyClaudeError (claude-runtime.server.ts:298-304) emits "The coordinating
    model is over its usage quota" even when the failed run is a delivering
    specialist; the Codex classifier's copy (:218-224) is backend-generic. Cosmetic
    but misleads humans triaging a dev-run failure toward the operator.
12. **Codex authored packet options can't carry per-option `detail`** — the plan
    schema's packetOptions items are `{kind, title, recommended}` only
    (operator-run.server.ts:424-434), while the Claude tool takes a `detail` per
    option (operator-toolkit.server.ts:160). Minor residual of the fixed
    Suspicious #13; a Codex packet's options render title-only.
13. **`OPERATOR_AUDIT_ACTOR` still defined twice** — task-actions.server.ts:125 and
    operator-run.server.ts:58 (identical shape). Drift hazard only; the skill-reader
    duplicate from pass 11 was fixed (P11-36), this one wasn't.
14. **Partial-react replay gap remains** (pass-11 #19, sharpened): the
    `task.agent.replied` audit is the recovery idempotency key
    (recordAgentRepliedAudit, task-actions.server.ts:1436/1544-1552), so a run that
    posted its reply but crashed before reconcile/react is skipped by
    `recoverUnreactedAgentRuns` — there is no idempotent replay of just the
    reconcile/react tail. In-process callbacks are still the only live wiring
    (run-service.server.ts:60-67 documents it).
