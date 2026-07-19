# Agent runtime (generic non-operator agents) — pass-9 map

Scope: the uniform machinery that runs a *deployed specialist / reviewer / custom*
agent on a task. One dispatch path (`startAgentRun`), one completion path
(`applyAgentCompletionEffects`), two transports (Claude Agent SDK · Codex SDK).
Operator runtime is out of scope except where the agent path calls into it.

Anchors are `path:line`. All paths absolute under `/Users/akinozer/projects/viberr`.

Key files:
- `app/server/tasks/specialist-run.server.ts` — dispatch orchestrator (`startAgentRun`, persona, prompt, clone, resume-confinement).
- `app/server/tasks/agent-toolkit.server.ts` — Claude in-process collaboration tools.
- `app/server/tasks/agent-outcome.server.ts` — outcome envelope schema + parse + staging + collab-gate resolution.
- `app/server/tasks/task-actions.server.ts` — `applyAgentCompletionEffects`, `recordAgentCompletion`, `classifyReviewerVerdict`, `hasReworkSinceLastRejection`.
- `app/server/tasks/specialist-tool-policy.ts` — capability → `disallowedTools` (Claude only).
- `app/server/tasks/specialist-mcp.server.ts` — declared MCP names → runtime configs.
- `app/server/runtimes/run-service.server.ts` — `startRun`/`resumeRun`/`interruptRun`, live-handle registry, completion callbacks, R7-2 fail-fast.
- `app/server/runtimes/runtime-registry.server.ts` — adapter selection + credential detection + `codexSpawnEnv`.
- `app/server/runtimes/claude-runtime.server.ts` / `codex-runtime.server.ts` — the two real adapters.
- `app/server/runtimes/run-recovery.server.ts` — boot reconciliation of dropped completions.
- `app/shared/capabilities.ts` — unified capability catalog + enforcement scope.
- `app/server/files/kb-injection.server.ts` — KB reader + 24k budget.

---

## 1. Run lifecycle

Two layers: **dispatch** (`specialist-run.server.ts`, task-aware) and the generic
**run service** (`run-service.server.ts`, backend-aware).

### Dispatch — `startAgentRun` (specialist-run.server.ts:517)
The single dispatch path for every engaged agent (G1 merged the old
`startSpecialistRun`/`startReviewerRun` twins). Flow:

1. RBAC via `runtimeAuditActor` → `requireRunAgents` (admin|maintainer), unless
   `ctx.operatorAuthorized` (specialist-run.server.ts:1444).
2. Resolve engagement: `input.profileId` selects it, else `deliveringEngagement`
   (specialist-run.server.ts:544). `delivers` drives everything downstream.
3. **Single-flight guard** — only for `delivers` (specialist-run.server.ts:564):
   refuses a second `primary` run while one is `running|queued` (409 CONFLICT).
   Supporting/reviewer runs are NOT guarded — they clone read-only and run
   concurrently. NOTE: two runs of the *same* supporting profile are allowed
   (no per-profile dedupe).
4. Resolve the **live** deployment (`resolveDeployedSpecialist`,
   specialist-run.server.ts:186) — the run follows the current profile, not the
   engage-time snapshot. Backend = `backendOverride ?? resolved.backend ??
   engagement.backend` (specialist-run.server.ts:600). D4 cross-backend retry
   re-resolves model/effort (specialist-run.server.ts:628).
5. Stage eligibility re-checked at the run boundary (`assertStageEligible`,
   specialist-run.server.ts:639).
6. Build persona (`buildSpecialistPersona`, §2), collab gates
   (`resolveAgentCollab`, §4), agent actor ref, and an `outcomeKey` (`newId("oc")`,
   specialist-run.server.ts:666) staging key.
7. Best-effort `cloneRepo` **only when the backend is really available**
   (specialist-run.server.ts:676). cwd is always an isolated `workspace/…` dir,
   never the task dir; `GIT_CEILING_DIRECTORIES` pinned to the task dir
   (`workspaceRunEnv`, specialist-run.server.ts:1345).
8. Build analyze prompt + collab notes (§3/§4), resolve MCP servers + toolkit,
   decide `useEnvelopeSchema` (specialist-run.server.ts:801).
9. Hand off to `startRun` (run-service). Then update task.md (backend snapshot +
   timeline event), reproject, audit `task.agent.run_started`, `markWaitingAgent`,
   and register the completion handler (`registerAgentCompletion`,
   specialist-run.server.ts:889).

Returns `{ runId, backend, simulated, role }`.

### RunSpec (adapter.server.ts:14 · StartRunInput run-service.server.ts:195)
Carries: `runId, projectSlug, taskKey, threadId, role, kind ("primary"|"reviewer"|
"operator"), backend, model, effort?, prompt, workdir, resumeSessionId?, autonomous,
systemPrompt? (persona), mcpServers?, allowedTools?, disallowedTools?, outputSchema?,
env? (git-ceiling overlay)`. `kind` is `delivers ? "primary" : "reviewer"`
(specialist-run.server.ts:811) — the run row no longer stores the human "kind"
literal.

### run-service `startRun` (run-service.server.ts:269)
- Thread id defaulted per kind (`DEFAULT_THREAD`, run-service.server.ts:250); the
  dispatch layer overrides with `primary-<8>` / `r<idx>-<8>` (specialist-run.server.ts:773).
- Selects adapter (`selectAdapter`, runtime-registry.server.ts:358): `real` /
  `simulated` (gated) / `unavailable`.
- Inserts `queued` row (`upsertRun`), audits `runtime.run.started`.
- `unavailable` → `failRunUnavailable` (run-service.server.ts:370): writes ONE
  honest server-authored `err` line + finalizes `error` through the normal sink,
  so completion callbacks fire via the already-terminal path. **No fabricated
  stream.** (R7-2.)
- Otherwise `launch` (run-service.server.ts:498): wires the sink, calls
  `adapter.start`, tracks the live `RunHandle` unless it exited synchronously.

### Live-handle registry + completion callbacks (run-service.server.ts:56)
Process-global (`Symbol.for("viberr.runService")`), maps `runId → RunHandle` and
`runId → RunCompletionCallback`. `onExit` finalizes the sink, deletes the handle,
fires+consumes the one-shot callback. `fireIfAlreadyTerminal`
(run-service.server.ts:101) handles the spawn-crash race (run finalized before the
callback was attached). **CAVEAT (documented):** callbacks live only in this
process — a restart mid-run drops the callback; `run-recovery` re-runs the effects
at boot for `waiting=agent` finished runs (§6).

### Session resume — `resumeRun` (run-service.server.ts:419)
Creates a NEW run row sharing the provider `session_id`, with a fresh derived
thread id (`<prev>-r<6>`, run-service.server.ts:463) to satisfy the
`unique(project, task, thread)` constraint. Re-applies `disallowedTools`, `env`,
`mcpServers`, `systemPrompt` (XS-1 confinement parity). **It does NOT accept or
pass `outputSchema`** (see gap G2). Interrupt: `interruptRun`
(run-service.server.ts:582), admin|maintainer, idempotent no-op on a
non-running run.

---

## 2. Persona / instructions

`buildSpecialistPersona` (specialist-run.server.ts:953) assembles, in order:

1. **Definition** = `readAgentDefinition(profileId)` — a shipped
   `agents/definitions/<id>.md` body (specialist-run.server.ts:910), OR the
   passed `definition` (the profile's own persona `body`, D6). The shipped file
   **overrides** the profile body when both exist (specialist-run.server.ts:964).
2. Each declared **skill body** (§3).
3. Each declared **KB doc** under a global 24k budget (§3).
4. A **trusted-provenance banner** (specialist-run.server.ts:997) — emitted ONLY
   when ≥1 resource actually resolved. Tells the agent the attached skills/KBs are
   admin configuration, not prompt-injection (agents live-refused injected skills
   without it).

Profile `body`/persona reaches the runtime via `effectiveProfileView.definition`
(agents-query.server.ts:221): `def.persona` (deployment override) → template
`description` → "". That flows into `ResolvedSpecialist.definition`
(specialist-run.server.ts:164) → persona.

**Transport into the run** (RunSpec.systemPrompt):
- Claude: `systemPrompt` becomes an **append** to the `claude_code` preset for
  non-operator kinds (claude-runtime.server.ts:390), so the coding harness is
  kept and the persona layered on top. (Operator replaces the preset.)
- Codex: `systemPrompt` → `config.developer_instructions`
  (codex-runtime.server.ts:140). Codex has no system-prompt channel per se; this
  is the supported equivalent.

Budget: the 24k `KB_INJECTION_BUDGET` (kb-injection.server.ts:40) is a **global**
cap across ALL of an agent's declared KBs (specialist-run.server.ts:981), so N KBs
can't blow the window with N×24k. Skills have **no** length budget.

---

## 3. Skills / MCP / KB loading — concretely

### Skills (does the agent get the RIGHT skills and ONLY them?)
- The agent's declared skill NAMES come from `resources.skills`
  (agents-query.server.ts:230): `def.resources.skills ?? template.resources.skills ?? []`.
- `buildSpecialistPersona` iterates **exactly** `input.skills` and reads each via
  `readSkillBody(name)` = `<dataRoot>/skills/<name>/SKILL.md`
  (specialist-run.server.ts:929). Only declared names are read; there is no fuzzy
  match. A name the store doesn't ship injects nothing (silent skip).
- On the Claude SDK side, isolation is doubled: `skills: []` +
  `settingSources: []` + `plugins: []` (claude-runtime.server.ts:371) AND
  `"Skill"` is in `BASE_DENIED_BUILTINS` (claude-runtime.server.ts:149). The SDK
  binary compiles in ~16 first-party skills that `skills: []` does **not** strip
  (docker-verified, claude-runtime.server.ts:362) — they stay listed in the init
  but the `Skill` tool deny makes them **uninvokable**.
- **Verdict on the owner's concern:** the declared-skill injection is clean —
  only the profile's exact skills reach the run, as prompt text. Unrelated skills
  cannot be *invoked* (Skill tool denied). Two caveats: (a) isolation of the SDK's
  bundled skills relies on the deny holding, not on removal (gap G6); (b) a
  mistyped declared skill is dropped silently with no persona-visible warning
  (gap G7). `skills-lock.json` at the repo root is unrelated — it is viberr's own
  dev-repo skill-sync lockfile (`.agents/skills`), NOT a runtime input; no code
  reads it.

### MCP servers
- `resolveSpecialistMcpServers` (specialist-mcp.server.ts:32) maps declared
  `resources.mcps` names → runtime configs from the org registry
  (`listMcpServers`). `viberr` is skipped (operator's in-process server). Unknown
  names skipped. HTTP → `{type:"http", url, headers?:{Authorization: Bearer}}`;
  stdio → `{command, args, env?:{MCP_CREDENTIAL}}`.
- Credentials are decrypted **only here** at spawn time (specialist-mcp.server.ts:50).
- Claude: merged with the toolkit under `mergedMcpServers`
  (specialist-run.server.ts:797) and passed to `options.mcpServers` verbatim
  (claude-runtime.server.ts:401).
- Codex: `codexMcpServers` (codex-runtime.server.ts:68) translates only the
  portable HTTP/stdio subset into `config.mcp_servers`; the in-process
  `{type:"sdk"}` toolkit server is skipped; **credentials are deliberately
  dropped** (argv-exposure, gap G4).

### KB
`readKbBody` (kb-injection.server.ts:92) walks the whole `data/kb/<name>/` tree,
matches `.md/.markdown/.mdx/.txt/.rst/.text`, deterministic sort, per-run char
budget with an explicit truncation marker when clipped. An unresolved KB injects
nothing (kb-injection.server.ts:99).

---

## 4. Agent toolkit (Claude in-process MCP)

`buildAgentToolkit` (agent-toolkit.server.ts:184) builds a
`createSdkMcpServer({name:"viberr_agent"})` whose handlers close over the DB +
task ctx and write with the **agent's own actor ref** (D8). Each tool is added
**only** when its capability gate is on; if none, returns `null` (no server
mounted). Gates come from `resolveAgentCollab` (agent-outcome.server.ts:235):

- `post_comment` (agent-toolkit.server.ts:191) — gate `collab.comment`
  (`comment-on-task`, direct). Immediate agent-authored timeline comment via
  `postAgentComment`; audited `task.agent.commented`.
- `ask_human` (agent-toolkit.server.ts:217) — gate `collab.ask` (`ask-human`).
  Opens a decision packet via `openAgentQuestionPacket`; refuses if a packet is
  already open (one decision/task). Answer is NOT returned in-run.
- `report_outcome` (agent-toolkit.server.ts:272) — gate `collab.verdict`
  (`report-validation-verdict`). Does NOT write immediately — it **stages** the
  envelope (`stageOutcome(outcomeKey, …)`, agent-outcome.server.ts:163) to be
  recorded atomically with the reply at completion.

**Attribution nuance:** timeline events carry `actor = agentRef` (correct), but
the audit-row actor is `OPERATOR_AUDIT_ACTOR` with the agent ref only in
`details.actorRef` (agent-toolkit.server.ts:100,159). See gap G8.

---

## 5. Codex transport (envelope)

Codex cannot mount the in-process toolkit (the SDK serializes MCP config into
`--config` argv and ignores tool policy). Instead the **outcome envelope** is
imposed on the FINAL reply via `outputSchema`:

- `AGENT_OUTCOME_JSON_SCHEMA` (agent-outcome.server.ts:52): `{summary, verdict?,
  question?}`. Must satisfy OpenAI strict mode — every property in `required`,
  optionals expressed as nullable types (`["string","null"]`, `enum:[…,null]`),
  never omission (fixed in commit 24065ed; an invalid schema 400s every
  envelope-mounted Codex run).
- Applied only when `useEnvelopeSchema` = `codex && realBackend &&
  (collab.verdict || collab.ask)` (specialist-run.server.ts:801) — a plain
  developer's report stays natural prose.
- Server side: `codexConfigForRun` passes `outputSchema` to
  `thread.runStreamed(prompt, {outputSchema})` (codex-runtime.server.ts:404,408).
- Completion side: `parseAgentOutcomeJson` (agent-outcome.server.ts:100) tolerantly
  parses (strips one code-fence), returns null on non-envelope prose.
- **Capability-enforcement asymmetry:** `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`
  (capabilities.ts:180) — `create-task-branch, commit-push-branch, open-review-pr,
  execute-code-or-write-repo, comment-on-task` bind on Claude's `disallowedTools`
  only. On Codex they are advisory prompt-text (`capabilityEnforcement` →
  `claude-only`, capabilities.ts:194). The *collaboration verdict/ask* gates
  (`report-validation-verdict`, `ask-human`) and the operator/structural caps
  enforce on BOTH backends because they gate server-side completion recording,
  not the SDK.

---

## 6. Outcome / envelope / verdict recording

### Resolution (applyAgentCompletionEffects, task-actions.server.ts:1919)
The universal completion effects, shared by the live callback and boot recovery.
Order:

1. Build the agent `actorRef` (legacy runs fall back to a role slug,
   task-actions.server.ts:1944). Read `fullText` (full reply) + `prevReply` (must
   predate this run — excludes this run's own mid-run `post_comment`).
2. Re-resolve grants from the **live deployment** at completion time
   (task-actions.server.ts:1980) → `resolveAgentCollab`. Undeployed → transition
   defaults (supporting → verdict on, delivering → verdict off).
3. **One envelope per run** (task-actions.server.ts:1995): Claude staged outcome
   (`takeStagedOutcome(outcomeKey)`) FIRST; else, on Codex, `parseAgentOutcomeJson`
   of the stored full text. When a Codex envelope parses, `replyText` becomes
   `envelope.summary` so the raw JSON never becomes the timeline comment.
4. If `finished`: resolve `verdict` = `collab.verdict ? (envelope.verdict ??
   classifyReviewerVerdict(replyText)) : null` (task-actions.server.ts:2010).
   `question = collab.ask ? envelope.question : null`. → `recordAgentCompletion`.
   If not finished (interrupt): only `postAgentReplyComment`.

### classifyReviewerVerdict (task-actions.server.ts:1538) — the regex fallback
Pure heuristic English classifier. **Used only when the agent HAS the verdict
grant AND no structured envelope verdict resolved** (task-actions.server.ts:2011).
That means: Claude reviewers that skipped `report_outcome`; resumed Codex agents
(no schema, see G2); recovered runs (staged map lost). It is conservative —
explicit "Verdict: …" line wins, negation-aware weak-negative scan, returns null
on ambiguity (no validation change). R1 invariant: it **never** runs on an agent
without the grant, so a developer's "tests pass" can't flip validation.

### recordAgentCompletion (task-actions.server.ts:1661) — the atomic write
ONE `updateTaskFile` write lands: the reply comment + a typed `quality` event
(attributed to the agent) + the ask-human packet. `request_changes` → validation
`failing`; `approve` clears a standing `failing` ONLY when
`hasReworkSinceLastRejection` (task-actions.server.ts:1623) is true, else records
"Approval noted — rework still needed" and stays failing (F7-REV3). There is **no
separate `recordAgentVerdict` function** — verdict recording is inline here.
A failing verdict drops any stale `accept_completion` recommendation.

### Rework detection (hasReworkSinceLastRejection, task-actions.server.ts:1623)
Newest-first walk: is there a delivering-specialist reply or a stage `transition`
newer than the most recent failing `quality` event? Matches the developer by
IDENTITY (`deliveringEngagement` profileId/backend), falling back to a role regex
when no delivering engagement is known.

### Error / no-progress / stuck-loop
- `state === "error"` & not simulated (task-actions.server.ts:2044): posts a typed
  `blocked` event (classified by `runFailureReason` → quota/auth/unavailable/
  max_turns/unknown), opens a stuck-loop recovery packet with a D4
  `retry_other_backend` option, notifies watchers, flips waiting→human. Returns
  early (no reconcile/verdict/react).
- Success withdraws a stale "work stalled" packet
  (`withdrawSupersededStuckPacket`, task-actions.server.ts:1459).
- Delivery reconcile: primary + finished + real only (task-actions.server.ts:2156),
  errors swallowed (`.catch(()=>{})`, G11).
- React: `operatorShouldReactToReply` gates re-invoking the operator; no-progress
  repeat or depth-cap opens a stuck-loop packet and always flips waiting→human
  (task-actions.server.ts:2199-2236).

### Boot recovery (run-recovery.server.ts:202)
`recoverUnreactedAgentRuns` re-runs `applyAgentCompletionEffects` for
`simulated=0`, `finished`, `waiting=agent` runs with no `task.agent.replied`
audit. Crash-loop backstop caps replays per run. Recovery passes **no `outcomeKey`
and `workdir: null`** (run-recovery.server.ts:298) — staged Claude verdicts are
gone (→ prose fallback), delivery reconcile has no workdir.

---

## 7. Codex vs Claude parity — every divergence

| Concern | Claude | Codex |
|---|---|---|
| System prompt | append to `claude_code` preset (claude-runtime:390) | `developer_instructions` (codex-runtime:140) |
| Collaboration tools | in-process MCP toolkit: `post_comment`/`ask_human`/`report_outcome` (agent-toolkit) | none mid-run; final-reply `outputSchema` envelope only (verdict/ask) |
| Mid-run comment | yes (`post_comment`) | **no** — only the final reply posts (capabilities.ts:185) |
| Verdict transport | staged tool call → atomic completion | envelope `verdict` field, parsed from final JSON |
| Verdict on resume | staged (resolveResumeConfinement rebuilds toolkit + outcomeKey, specialist-run:1305) | **lost** — no schema on resume (G2) → prose regex |
| Tool confinement | `disallowedTools` binds even under bypassPermissions (specialist-tool-policy) | **advisory prompt-text only** — SDK ignores deny lists (G3) |
| MCP credentials | attached (headers/env) | **dropped** — connects unauthenticated (G4, codex-runtime:68) |
| Autonomy mode | `permissionMode: bypassPermissions` (claude-runtime:349) | `sandboxMode: danger-full-access` (codex-runtime:375) |
| Turn cap | `VIBERR_CLAUDE_MAX_TURNS` default 2000; `error_max_turns` classified (claude-runtime:243,479) | none — **idle timeout** 15min instead (codex-runtime:172); hung run else stays running forever |
| Cost | `total_cost_usd` in result | tokens only, no dollar cost (codex-runtime:28) |
| Model resolution | `resolveClaudeModel` → sonnet/opus/haiku aliases (claude-runtime:95) | `spec.model` passed through; `resolveCodexReasoningEffort` union-guarded |
| Env handling | SDK MERGES into process.env → base + overlay (runtime-registry:281) | SDK REPLACES child env → must hand a FULL env (runtime-registry:270; codex-runtime:349) |
| Operator restriction | deny mutation built-ins | `sandboxMode: read-only` + no network/websearch (codex-runtime:375,391) |
| Failure classify | `classifyClaudeError` quota/auth/unknown (claude-runtime:250) | `classifyCodexFailure` + idle-timeout class (codex-runtime:201) |
| Skills isolation | `skills:[]`+`Skill` deny (bundled skills only suppressed) | `features.apps:false`, `memories:*:false` (codex-runtime:144) |

---

## Mocks / gaps / bugs

- **[MOCK] Simulated agent transcript + canned reports** — `simulatedFinalReport`
  (specialist-run.server.ts:1103) and `buildAnalyzeScript`
  (specialist-run.server.ts:1141) fabricate a whole agent stream incl. hardcoded
  "Verdict: **approve**". Gated behind the R7-2 `simulatedRuntimePermitted` test
  gate (runtime-registry.server.ts:127), unreachable in prod/dev. Risk: if the
  gate ever regresses, fake approvals stream as if real.
- **[POOR] G2 — resumed Codex agent loses the outcome envelope.**
  `resumeRun` (run-service.server.ts:419) has no `outputSchema` param and
  `resolveResumeConfinement` (specialist-run.server.ts:1265) builds a schema for
  neither backend for Codex. A resumed (@mention) Codex reviewer/ask agent runs
  WITHOUT the structured envelope → verdict falls to the fragile prose regex and
  `ask_human` cannot fire. Fresh Codex runs get the schema. Real parity gap.
- **[POOR] G3 — Codex tool confinement is advisory only.** `disallowedTools`
  binds on Claude alone (specialist-tool-policy.ts:19; capabilities.ts:180). A
  Codex specialist whose `execute-code-or-write-repo` / branch / push is *withheld*
  can still do it — enforcement is prompt text. Push is mostly moot (delivery is
  server-side), but file-write/commit denial is unenforced on Codex.
- **[POOR] G4 — Codex MCP credentials silently dropped.** `codexMcpServers`
  (codex-runtime.server.ts:68) strips the Authorization/`MCP_CREDENTIAL` that
  `resolveSpecialistMcpServers` attached (argv exposure). A credentialed org MCP
  connects **unauthenticated** on Codex → different tool behavior vs Claude.
  Documented, but a live behavioral fork.
- **[POOR] G6 — bundled Claude skills are suppressed, not removed.**
  `skills: []` does not empty the SDK's ~16 compiled-in skills
  (claude-runtime.server.ts:362); isolation relies entirely on the `Skill` tool
  being in `BASE_DENIED_BUILTINS` (claude-runtime.server.ts:149). If that deny
  regresses, unrelated bundled skills become invokable — directly relevant to the
  owner's "no unrelated skills" concern.
- **[POOR] G7 — silent skill/KB drop.** `readSkillBody`
  (specialist-run.server.ts:929) and `readKbBody` (kb-injection.server.ts:99)
  return "" for a missing/mistyped declared resource with no persona-visible
  warning. An agent can run believing it has a skill it never received. (KB at
  least emits a truncation marker when *clipped*, but not when *absent*.)
- **[POOR] G-traversal — no path guard on skill/KB names.** `readSkillBody` /
  `readKbBody` / `skillDirPath` / `kbDirPath` join the raw declared name into a
  path (specialist-run.server.ts:931, kb-injection.server.ts:98). A crafted name
  (`../../…`) could read outside the store. Admin-controlled config → low
  exploitability, but unguarded.
- **[POOR] G8 — audit attribution mismatch.** Agent toolkit + completion audits
  use `OPERATOR_AUDIT_ACTOR` as the row actor with the agent ref only in details
  (agent-toolkit.server.ts:100,159; task-actions.server.ts:1798,1820). Timeline
  attribution is correct; the audit trail attributes agent actions to the
  operator system actor.
- **[POOR] G-staged-loss — staged Claude verdicts lost on restart.** `staged`
  map is in-process (agent-outcome.server.ts:160). A `report_outcome` staged
  before a crash is gone; recovery re-runs without `outcomeKey`
  (run-recovery.server.ts:298) → prose regex reclassification. Documented.
- **[POOR] G10 — verdict regex is inherently fragile.**
  `classifyReviewerVerdict` (task-actions.server.ts:1538) is the fallback verdict
  source for a large slice of runs (any verdict-granted run without an envelope).
  A clearly-rejecting prose review the regex misses → validation silently stays
  `healthy`. Conservative-by-design but a correctness cliff.
- **[POOR] G11 — swallowed error paths.** Delivery reconcile
  (task-actions.server.ts:2170 `.catch(()=>{})`), reply-comment write
  (task-actions.server.ts:1293), toolkit handlers (agent-toolkit.server.ts:205,
  260), stuck-packet/superseded-withdraw (task-actions.server.ts:1434,1525) all
  log-and-swallow. A failed reconcile means the agent's committed branch/PR may
  never surface on the task with no user-facing signal.
- **[MINOR] Single-flight covers only delivering runs** (specialist-run.server.ts:564)
  — two concurrent runs of the same supporting reviewer profile are allowed (both
  read-only clones; low risk).
- **[MINOR] `projectOne` interrupt-return fallback** (run-service.server.ts:686):
  when the interrupted run's thread isn't found in the projection it falls back to
  `[...][0]!` (an arbitrary/first run) and the `!` throws if there are zero rows.
  Edge-case fidelity/robustness issue in the interrupt result only.
- **[MINOR] Completion callbacks are process-local** (run-service.server.ts:71) —
  a restart mid-run drops the reply callback; recovered at boot only for
  `waiting=agent` finished runs (run-recovery.server.ts). Documented tradeoff.
