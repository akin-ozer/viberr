# Claude Code vs Codex — runtime parity (pass 13, 2026-07-24)

Scope: everything Viberr promises about an agent run, checked on both backends.
Every claim below was re-verified against `main @ c7abebf` (post PR #94). Line
numbers are from that snapshot and may drift a few lines.

Prior art re-verified: `planning/discovery-2026-07-24-pass12/docs/agents-operator-runtimes.md`
and its findings ledger. **AO-1 (staged-outcome restart) is genuinely fixed** —
`agent_runs.outcome_key` exists (`db/migrations/0001_baseline.sql:284-288`), is
written by `registerAgentCompletion`
(`app/server/tasks/task-actions.server.ts:1650-1656`) and is re-supplied by
recovery (`app/server/runtimes/run-recovery.server.ts:181-190, 286-289`).
**AO-2 (cross-boot lease drain) is genuinely fixed** — the tokenless release was
replaced by `drainPendingAfterInFlight`, which bails when a live successor holds
the lease (`app/server/runtimes/operator-run.server.ts:218-237, 338`).
**AO-3 / AO-5#5** are fixed (`resolveUndeployedDisallowedTools`,
`app/server/tasks/specialist-tool-policy.ts:106-110`).
**AO-4 remains open by owner ruling** — but see F13-02 for a mechanism the ruling
predates.

---

## (a) Side-by-side parity table

Legend — **Enforced?**: `code` = server/SDK actually blocks it · `prompt` = only
the prompt says so · `n/a` = no such thing on that backend.
**Disclosed?**: is the difference visible to a user in the product UI.

### 1. Prompt assembly

| Feature | Claude | Codex | Enforced? | Disclosed? |
|---|---|---|---|---|
| Persona = profile body (`definition`) | ✅ `buildSpecialistPersona` → `systemPrompt` | ✅ same string → `developer_instructions` | code | n/a (same) |
| Persona delivery mode | **APPENDED to the `claude_code` preset** (`claude-runtime.server.ts:421-431`) → agent also gets Claude Code's full coding harness prompt | persona **only** (`codex-runtime.server.ts:141`) | code | ❌ **no** |
| Operator persona delivery | **REPLACES** the preset (`kind === "operator"`, :422) | same string as `developer_instructions` | code | n/a |
| Skills — only the profile's declared skills load | ✅ one shared reader, `skill-body.server.ts:10-30`, path-contained via `skillDirPath`→`resolveStoreSegment`; SDK discovery off (`skills: []`, `settingSources: []`, `plugins: []`, `claude-runtime.server.ts:402-404`) **and** the `Skill` tool denied (`:178`) so the ~16 binary-compiled SDK skills are uninvokable | ✅ same reader/same string; no SDK skill concept | code | n/a |
| Ambient repo instructions (`CLAUDE.md` / `AGENTS.md`) | **not loaded** (`settingSources: []`) | **loaded by the CLI** — Viberr never sets `project_doc_max_bytes = 0`; `codexConfigForRun` (`codex-runtime.server.ts:133-168`) sets no doc key | ❌ asymmetric | ❌ **no** — see F13-04 |
| Ambient tool surfaces | plugins `[]`, settings `[]` | `features.apps: false`, `memories.*: false` (`:145-157`) | code | n/a |
| KB injection | ✅ `readKbBody`, 24 000-char global budget (`kb-injection.server.ts:44`, `specialist-run.server.ts:919-927`) | ✅ identical | code | n/a |
| Trusted-resource provenance banner | ✅ (`specialist-run.server.ts:928-944`) | ✅ same string | code | n/a |
| Task/goal/workspace contract prompt | ✅ `buildAnalyzePrompt` (`:955-1063`) | ✅ same function | code | n/a |
| Supporting read-only contract in prompt | ✅ (`:993-1001`) | ✅ same | prompt (+ code on both, see §2) | ✅ matrix modal |
| Delivery contract (branch/commit, never push) | ✅ (`:1002-1028`) | ✅ same | prompt on Codex, prompt+denylist on Claude | ✅ matrix modal |
| Operator directive quoted as untrusted | ✅ (`:1030-1046`) | ✅ same | prompt | ❌ |
| Trust-boundary block (R-C) on a **fresh** run | ✅ (`:1052-1061`) | ✅ same | prompt | ❌ |
| Trust-boundary block on a **resumed** (@mention) run | ❌ **absent** — the turn prompt is `specialistReplyDirective` (`task-actions.server.ts:742-755`); persona is re-applied but carries no contract | ❌ **absent** | — | ❌ — see F13-05 |
| Collaboration guidance | tool list, per granted tool (`specialist-run.server.ts:693-708`) | one "final message must be JSON" line, only when verdict∨ask (`:709-716`) | prompt | ❌ |
| Operator turn prompt | "call `get_task` first" — snapshot fetched live (`operator-run.server.ts:1127-1140`) | full snapshot JSON inlined (`:1105-1124`) | code | n/a (deliberate) |
| Operator "Non-negotiable rules" + live policy block | ✅ (`operator-run.server.ts:1023-1036`) | ✅ same builder | code | n/a |

### 2. Tool policy / capability enforcement

| Capability (agent) | Claude | Codex | Enforced? | Disclosed? |
|---|---|---|---|---|
| `execute-code-or-write-repo` withheld | `Edit/MultiEdit/Write/NotebookEdit` + `Bash(git commit:*)` denied (`specialist-tool-policy.ts:56-59`); prompt steps suppressed (`:124-143`) | **nothing** — delivering runs still get `danger-full-access` (`codex-runtime.server.ts:384-389`), no denylist channel | claude-only | ✅ matrix modal ("Claude-enforced") |
| `create-task-branch` / `commit-push-branch` / `open-review-pr` withheld | git/gh deny rules (`specialist-tool-policy.ts:35-47`) | **nothing** | claude-only | ✅ matrix modal |
| `merge-pull-request` / `transition-to-done` / `change-project-policy` | ALWAYS_HUMAN + deny rule | server-side only (no agent path exists) | both | ✅ |
| Supporting (non-delivering) run is read-only | tool denylist `SUPPORTING_DENIED_BUILTINS` (`claude-runtime.server.ts:136-149`); `sed -i`/redirection still reachable | **`sandboxMode: "read-only"`** (`codex-runtime.server.ts:384-386`) — strictly stronger | code both | ✅ matrix modal |
| Server-side delivery push gate | `resolveDeliveryPushGrant` (task-actions) | same | both | ✅ |
| `comment-on-task` (mid-run comment) | `post_comment` MCP tool, built only when granted (`agent-toolkit.server.ts:208-233`) | **no channel at all** — inert | claude-only | ✅ matrix modal (flagged "Claude-enforced") |
| `ask-human` | `ask_human` tool **mid-run**, opens the packet immediately, refuses when a packet is open and tells the model (`agent-toolkit.server.ts:235-288`) | `question` field on the **final** envelope, opened at completion, silently dropped when a packet is open (`task-actions.server.ts:1545-1562`) | both (gate), timing/feedback differ | ❌ timing not disclosed |
| `report-validation-verdict` | `report_outcome` tool stages `{verdict, summary}` (`agent-toolkit.server.ts:290-315`) | `verdict` field on the final envelope | both (gate) | ❌ |
| Withheld capability attempted | Claude: the tool/command does not exist in context → hard refusal | Codex: succeeds; only the prompt objects | asymmetric | ✅ matrix modal (generic) |
| Base built-in denylist (Task/Cron/Skill/Workflow/…) | ✅ `BASE_DENIED_BUILTINS` (`claude-runtime.server.ts:177-205`) | n/a — Codex has none of these | code | n/a |
| Declared org MCP servers | mounted with decrypted credentials (`specialist-mcp.server.ts`) | mounted **without credentials** and with `default_tools_approval_mode: "approve"` (`codex-runtime.server.ts:69-108`) | asymmetric | ❌ **only a docstring** |
| In-process governance MCP (`viberr_agent` / `viberr`) | ✅ SDK MCP server | ❌ `type: "sdk"` skipped (`codex-runtime.server.ts:72`) | code | ❌ |
| Operator repo mutation | `OPERATOR_DENIED_BUILTINS` (Bash/Edit/Write/…) but **Read/Grep/Glob/WebFetch/WebSearch remain** | `read-only` + `networkAccessEnabled:false` + `webSearchMode:"disabled"` (`codex-runtime.server.ts:400-405`) | code both, **Codex strictly stricter** | ❌ |
| Operator action gating | tool **not built** when the capability gates to `deny` (`operator-toolkit.server.ts:97-349`) — the model can't attempt it | all 9 tools always in the plan schema (`operator-run.server.ts:404-421`); a denied action returns `{outcome:"denied"}` which `executeCodexPlan` **ignores** (`:702-799`) | code both, but Codex denials are silent | ❌ — see F13-03 |

### 3. Outcome parity

| Feature | Claude | Codex | Enforced? | Disclosed? |
|---|---|---|---|---|
| Envelope transport | staged mid-run via `report_outcome` → `staged_outcomes` + in-proc map (`agent-outcome.server.ts:171-221`) | `outputSchema: AGENT_OUTCOME_JSON_SCHEMA` on the final reply (`:54-94`), parsed tolerantly (`:102-153`) | code | n/a |
| Envelope armed when… | `collab.verdict` (tool built per-grant) | `collab.verdict ‖ collab.ask` (`specialist-run.server.ts:758-759`) | code | n/a |
| Envelope on resume | fresh `outcomeKey` + toolkit (`specialist-run.server.ts:1147-1163`) | schema re-armed (`:1164-1169`) | code | n/a |
| Verdict authority | engagement `verdictCapable` snapshot, live grants as fallback (`task-actions.server.ts:1758-1768`) | identical | both | ✅ |
| No-envelope fallback | prose classifier `classifyReviewerVerdict` (`:1373-1430`), only with authority | identical | both | ❌ |
| Restart recovery of a staged verdict | ✅ via persisted `outcome_key` (AO-1 fixed) | ✅ re-parses the stored reply | code | n/a |
| Raw envelope JSON never becomes the comment | n/a (staged separately) | ✅ `replyText = summary` (`task-actions.server.ts:1773-1780`) | code | n/a |
| Reply text extraction | last `assistant` text line | last `agent_message` text line — same function (`agent-reply.server.ts:280-296`) | code | n/a |
| Reply fallback when no text line | last `result` line → posts `"success · 3 turns · 12s · $0.02"` as the agent's report | last `turn.completed` line → posts `"in 4.1k (cached 2.0k) · out 0.3k tokens"` | shared bug | ❌ — F13-09 |
| Question packet audit actor | the **agent** (`agent-toolkit.server.ts:176-185`) | **`OPERATOR_AUDIT_ACTOR`** (`task-actions.server.ts:1575-1583`) | asymmetric | ❌ — F13-06 |
| `@tag` in the agent's **final report** notifies the tagged human | ❌ **no fan-out** on the finished path | ❌ same | broken on both | ❌ — F13-01 |
| `@tag` in a **mid-run** comment notifies | ✅ (`agent-toolkit.server.ts:116-123`) | ❌ (no mid-run channel) | claude-only | ❌ |

### 4. Model / effort / config

| Feature | Claude | Codex | Enforced? | Disclosed? |
|---|---|---|---|---|
| Catalog source | curated 3 aliases **+ live `supportedModels()`** when a credential exists (`model-catalog.server.ts:365-398`) | curated only, 4 hand-maintained ids (`:98-138`) | code | ❌ ("live" not labelled in the picker) |
| Run-time model validator | `isKnownModel` — **curated only** (`:172-175`) | curated only | code | partly |
| Profile pins a model the validator doesn't know | silently substituted with `sonnet` (`resolveRunModel`, `:185-191`); agents page shows a warning badge (`agents-page.tsx:383-387`) | same substitution, but the picker only ever offers curated ids so it can't happen | code | ✅ badge — but see F13-07 |
| Effort validation | **none** — `spec.effort` passed raw to the SDK (`claude-runtime.server.ts:375`) | `resolveCodexReasoningEffort` closed union, unknown → dropped (`codex-runtime.server.ts:111-124`) | asymmetric | ❌ — F13-08 |
| `resolveRunEffort` applied | only on the cross-backend D4 retry (`specialist-run.server.ts:601-604`); the normal path uses the stored value verbatim (`:599-600`) | same | — | ❌ |
| Availability probe | `ANTHROPIC_API_KEY ‖ CLAUDE_CODE_OAUTH_TOKEN ‖ VIBERR_CLAUDE_USE_CLI_AUTH` (`runtime-registry.server.ts:109-114`) | token/key **or** opt-in **and** `$CODEX_HOME/auth.json` exists (`:116-122`) | code | ✅ backend chips disabled in the profile modal (`create-profile-modal.tsx:207-238`) |
| Unavailable-backend run | fail-fast `run·unavailable` + escalation packet (`run-service.server.ts:346-363`) | same, with codex-home-specific copy (`:377-381`) | code | ✅ |
| Spawn env | `claudeSpawnEnv` — filtered process.env + `CLAUDE_CONFIG_DIR` + the credential (`runtime-registry.server.ts:238-248`) | `codexSpawnEnv` — filtered + `CODEX_HOME` + token, API keys deleted under subscription auth (`:204-221`) | code | n/a |
| Per-run env reaches the model's **shell** | ✅ whole process env (`claude-runtime.server.ts:409-411`) → `GIT_AUTHOR_*`/`GIT_COMMITTER_*` bind | ❌ `shell_environment_policy.inherit: "core"` + only `GIT_CEILING_DIRECTORIES` set (`codex-runtime.server.ts:162-166`) → **git identity env does not reach the tool shell** | asymmetric | ❌ — F13-10 |
| Runaway guard | `maxTurns` 2 000 (`claude-runtime.server.ts:271-276`), classified `run·error·max_turns` | none (Codex has no turn cap) | asymmetric | ❌ |
| Hang guard | **none** | 15-min idle abort → `error` (`codex-runtime.server.ts:170-177, 275-301`) | asymmetric | ❌ — F13-11 |
| Failure classification | `classifyClaudeError` quota/auth/unknown + spawn-crash codes (`:278-323`) | `classifyCodexFailure` quota/auth/unknown (`:202-243`) | code | ✅ packet copy |
| `retry_other_backend` recovery option | offered for quota/auth/unavailable (`task-actions.server.ts:1891-1912`) | same | code | ✅ |
| Cost reporting | `total_cost_usd` from the `result` envelope (`wire-format.server.ts:135`) | none | asymmetric (vendor) | ✅ RunView exposes no cost field |
| Tool-call log fidelity | `tool_use` line with name + input (`wire-format.server.ts:112-118`) | `command_execution` line, but `mcp_tool_call` degrades to a `meta` line (`:252-256`) | asymmetric | ❌ |

### 5. Session / transcript / resume

| Feature | Claude | Codex | Enforced? | Disclosed? |
|---|---|---|---|---|
| Session id capture | `system·init.session_id` (`wire-format.server.ts:95`) | `thread.started.thread_id` + `thread.id` (`:187`, `codex-runtime.server.ts:450`) | code | n/a |
| Resume | `options.resume` (`claude-runtime.server.ts:406`) | `resumeThread` (`:407-409`) | code | n/a |
| Resume re-applies confinement | denylist + env + MCPs + persona + toolkit (`specialist-run.server.ts:1096-1186`) | denylist is a no-op; env + persona + envelope schema re-applied | claude-only for tools | ❌ |
| Resume after a **backend switch** | resumes the **old** backend's session (`latestSessionRun` doesn't filter backend, `agent-reply.server.ts:117-133`) — contradicting the in-code claim at `:193-197` | same | bug | ❌ — F13-12 |
| Transcript location | `$CLAUDE_CONFIG_DIR/projects/*/<sid>.jsonl` (`session-export.server.ts:74-88`) | `$CODEX_HOME/sessions/**/rollout-*<sid>*.jsonl` (`:93-117`) + content-scan fallback (`:121-149`) | code | n/a |
| `exportable` probe | filename match | filename match only — a transcript findable **only** by content scan shows no Export link (documented conservative miss, `:157-166`) | code | ⚠️ partial |
| Resume-elsewhere bundle | cwd-encoded install path + `claude --resume` (`:304-327`) | `sessions/imported/` + `codex resume` (`:293-303`) | code | ✅ script prints both |
| Boot recovery of orphaned runs | ✅ `finalizeOrphanedRuns` (`run-recovery.server.ts:37-151`) | ✅ same | code | n/a |
| Boot recovery of un-reacted finished runs | ✅ incl. staged outcome via `outcome_key` | ✅ envelope re-parsed | code | n/a |

---

## (b) Verified code map

```
adapter contract              app/server/runtimes/adapter.server.ts:13-59 (RunSpec)
  disallowedTools  Claude-only  :46-49
  outputSchema     Codex-only   :50-54
run service        run-service.server.ts:242-336 startRun · :346-363 failRunUnavailable
                   :394-473 resumeRun · :476-540 launch · :556-630 interruptRun
                   autonomous defaults TRUE for every run  :318
registry           runtime-registry.server.ts:108-122 hasCredential · :137-147 probe
                   :187-196 filteredSpawnEnv · :204-221 codexSpawnEnv · :238-248 claudeSpawnEnv
claude adapter     claude-runtime.server.ts
                   :96-105  resolveClaudeModel (aliases + dated ids; else undefined)
                   :113-121 OPERATOR_DENIED_BUILTINS
                   :136-149 SUPPORTING_DENIED_BUILTINS
                   :177-205 BASE_DENIED_BUILTINS
                   :271-276 maxTurns · :368-405 options · :421-431 systemPrompt strategy
                   :446-453 deny assembly · :512-528 max_turns classified line
codex adapter      codex-runtime.server.ts
                   :69-108  codexMcpServers (credentials dropped, approve mode)
                   :111-124 resolveCodexReasoningEffort
                   :133-168 codexConfigForRun (developer_instructions, apps/memories off,
                            shell_environment_policy inherit:core + GIT_CEILING only)
                   :170-177,275-301 idle timeout · :384-406 sandbox/thread options
generic agent run  app/server/tasks/specialist-run.server.ts
                   :488-883 startAgentRun · :570-605 backend/model/effort
                   :593 disallowedTools · :616-622 persona · :626 collab · :636 outcomeKey
                   :693-719 per-transport collab notes · :741-759 transports
                   :888-946 buildSpecialistPersona · :955-1063 buildAnalyzePrompt
                   :1096-1186 resolveResumeConfinement · :1213-1232 git identity
tool policy        app/server/tasks/specialist-tool-policy.ts:30-69 CAP_DENY_RULES
                   :85-96 resolveSpecialistDisallowedTools · :106-110 undeployed
                   :124-143 resolveDeliveryPermissions
toolkit (Claude)   app/server/tasks/agent-toolkit.server.ts:202-327 (tool built only if granted)
outcome envelope   app/server/tasks/agent-outcome.server.ts:54-94 schema · :102-153 parse
                   :171-221 stage/take · :254-289 grant resolution
completion         app/server/tasks/task-actions.server.ts:1432-1620 recordAgentCompletion
                   :1650-1656 outcome_key persist · :1678-2035 applyAgentCompletionEffects
                   :1758-1768 verdict authority · :1771-1780 envelope resolve
                   :1821 question authority · :1891-1912 retry_other_backend
operator           app/server/runtimes/operator-run.server.ts:404-474 plan schema
                   :559-629 startCodexOperatorRun · :644-822 executeCodexPlan
                   :826-894 startRealOperatorRun · :980-1038 buildOperatorSystemPrompt
                   :1105-1124 / :1127-1140 the two turn prompts
                   app/server/tasks/operator-actions.server.ts:209-223 gate
                   app/server/tasks/operator-toolkit.server.ts:71-360 (gated tool build)
model catalog      app/server/runtimes/model-catalog.server.ts:56-138 curated
                   :172-191 isKnownModel/resolveRunModel · :201-232 resolveRunEffort
                   :365-398 getModelCatalog (live claude only)
                   route: app/routes/resources.model-catalog.ts
sessions           app/server/runtimes/session-export.server.ts:74-153 locate
                   :171-191 transcriptExists · :243-262 buildResumeScript
recovery           app/server/runtimes/run-recovery.server.ts:37-151, 181-303
wire format        app/server/runtimes/wire-format.server.ts:83-172 claude · :184-262 codex
capability honesty app/shared/capabilities.ts:95-139
UI disclosure      app/features/agents/capability-matrix-modal.tsx:86-95,120-126,156-172
                   app/features/agents/agents-page.tsx:382-388 (unknown-model badge)
```

---

## (c) Findings candidates

### F13-01 — HIGH · an agent's final report never notifies the humans it @tags (both backends)

`recordAgentCompletion` (`app/server/tasks/task-actions.server.ts:1432-1620`) is
the path every **finished** agent run takes. It writes the reply comment inside
`updateTaskFile` (:1533) and then audits (:1565-1573), notifies for the question
(:1574-1594) and for the verdict (:1596-1614) — but **never calls
`notifyMentionedUsers`**. The only three agent-side call sites are
`postAgentReplyComment` (:1167 — the *interrupted/errored* path),
`agent-toolkit.server.ts:116` (Claude mid-run comment) and the two
operator writers (`operator-actions.server.ts:339,425`).

Failure scenario: the operator prompts `@dev` on behalf of Arda; the dev finishes
and replies "@Arda I changed X, please confirm Y". The comment lands on the
timeline; **Arda gets no notification**. Interrupt the same run and the tag *does*
notify — the promise (NEW-4, memory `agents-tag-humans-2026-07-24`) only holds on
the failure path. The specialist prompt explicitly instructs the agent to tag the
commenter (`specialistReplyDirective`, :748-754), so this is the common case.

Parity angle: the one place it *does* work for a successful run is Claude's
mid-run `post_comment` — which has no Codex analog at all, so on Codex an agent
tag **never** notifies anyone.

Fix: call `notifyMentionedUsers` in `recordAgentCompletion` after the write, with
the same `createActorResolver`/`agentNamesByProfile` shape as :1167, guarded on
`prepared.status === "event"`.

### F13-02 — HIGH · the Codex read-only sandbox is never used to enforce a withheld repo-write grant

`sandboxMode` is chosen purely from `spec.kind` + `spec.autonomous`
(`app/server/runtimes/codex-runtime.server.ts:384-389`), and `spec.autonomous` is
unconditionally `true` for every agent run (`run-service.server.ts:318`;
`startAgentRun` never passes it). So a Codex **delivering** agent whose
`execute-code-or-write-repo` is `off`/`human` runs at `danger-full-access` —
exactly as unconstrained as a fully-granted one.

This was ruled "prompt-only, accepted" as AO-4, but that ruling was framed around
"Codex has no denylist channel". It does have a stronger channel, and Viberr
already uses it for supporting runs (`:384-386`, "a read-only Codex sandbox
PHYSICALLY blocks writes — this is stronger than Claude's tool denylist"). The
same mechanism maps cleanly onto the headline gate.

Failure scenario: an admin sets a Codex analyst profile to
`execute-code-or-write-repo: human` ("it may read and report, humans write"), the
matrix modal shows "Claude-enforced", the operator engages it as the deliverer on
a repo task, and the agent rewrites files in the workspace. The Review transition
then pushes them (the server-side push gate consults the *delivering* profile's
`canCommitPush`, so it denies — but the workspace is already mutated and the next
delivering run inherits a dirty tree).

Fix: thread a `repoWriteWithheld` boolean on `RunSpec` (computed from
`resolveDeliveryPermissions` in `startAgentRun` and `resolveResumeConfinement`)
and select `"read-only"` in the Codex adapter when it is set. Do **not** reuse
`spec.autonomous` — it also drives Claude's `permissionMode`, and flipping it to
`"default"` would hang a server run on an approval nobody can answer.

### F13-03 — MED · a denied Codex operator action is a silent no-op

Every governed operator action returns `{outcome: "denied" | "recommended" |
"noop" | "done", message}` (e.g. `operator-actions.server.ts:487-492`,
`:917-922`, `:956-958`, `:1462-1465`). The Claude toolkit surfaces that string
back to the model (`operator-toolkit.server.ts:67`, `textResult(\`[${r.outcome}]
${r.message}\`)`) — and, more importantly, a denied capability's tool **is never
built**, so the model can't reach it. `executeCodexPlan`
(`operator-run.server.ts:702-799`) **discards every return value**, and the plan
schema always advertises all nine tools (`:404-421`) regardless of policy.

Failure scenario: a project sets the operator's `generate-packets: off` and
`stage-transitions: off`. The Codex operator emits a two-action plan
(`open_packet` + `transition_stage`). Both are denied. Because
`plan.actions.length !== 0`, the `reasoning` is *not* posted either (`:699-701`).
Net result: an LLM run was billed, the lease was taken and released, the board
flips back to "waiting on you", and **nothing at all appears on the timeline** —
indistinguishable from the operator deciding to do nothing.

Fix: collect non-`done`/`recommended` outcomes in `executeCodexPlan` and post one
timeline note ("`transition_stage` was not permitted for the operator here"), the
same way the abort path already narrates a thrown action (`:810-818`). Optionally
filter `OPERATOR_PLAN_TOOLS` down to the non-denied set per run so the model isn't
invited to propose them.

### F13-04 — MED · Codex runs ingest the repo's `AGENTS.md`; Claude runs ingest nothing equivalent

`codexConfigForRun` (`app/server/runtimes/codex-runtime.server.ts:133-168`) sets
`developer_instructions`, `allow_login_shell`, `features.apps`, `memories.*`,
`mcp_servers`, `shell_environment_policy` — and nothing about project docs. The
Codex CLI's default `project_doc_max_bytes` (32 KiB) is therefore in effect, so
the `AGENTS.md` of the repo checked out into
`<taskDir>/workspace/<repo>` (and any `$CODEX_HOME/AGENTS.md`) is merged into the
run's instructions. Grep confirms the key appears nowhere in the repo. The Claude
side deliberately closes the equivalent channel: `settingSources: []`,
`plugins: []`, `skills: []`, `Skill` denied (`claude-runtime.server.ts:177-205,
402-404`), so a repo's `CLAUDE.md` never loads.

Verification level: **verified by absence of configuration**, not by executing a
Codex run — the CLI behavior is external. Worth a live confirmation before fixing.

Failure scenario: Viberr's own hermeticity promise ("a run must see exactly the
agent's declared resources", `claude-runtime.server.ts:386-390`) is false on
Codex. Worse, it is a prompt-injection ingress the trust-boundary block explicitly
tries to close: an `AGENTS.md` committed to a task's repo is loaded as
*instructions*, not as data, and it arrives at a higher trust tier than the
repository contents the prompt calls untrusted.

Fix: add `project_doc_max_bytes: 0` to `codexConfigForRun` (after `base` so a
deployment override can't re-open it, alongside `allow_login_shell: false`), or
make it an explicit, disclosed profile option.

### F13-05 — MED · resumed runs lose the delivery contract and the trust boundary

`resolveResumeConfinement` (`app/server/tasks/specialist-run.server.ts:1096-1186`)
re-applies persona, MCPs, denylist, env and the outcome transport — but the
resumed **turn prompt** is `specialistReplyDirective`
(`task-actions.server.ts:742-755`), which contains no workspace contract, no
supporting read-only block, no delivery prohibition and no trust-boundary block.
`buildAnalyzePrompt`'s guarantees hold only on fresh runs.

On Claude this is backstopped by `disallowedTools` (re-applied) and, for
supporting runs, `SUPPORTING_DENIED_BUILTINS` (`resumeRun` carries
`kind: prev.kind`, `run-service.server.ts:447`). On Codex the supporting sandbox
still binds, but a **resumed delivering Codex run has no contract in the turn
prompt and no tool-layer teeth** — only whatever survives in the session history.
That is precisely the configuration the R-C guardrail was written for.

Failure scenario: a human comments "@dev the reviewer approved — go ahead and push
it and open the PR". On a fresh run the prompt's precedence clause and trust
boundary defeat this. On a resume there is neither; a Codex deliverer at
`danger-full-access` may well comply, and the workspace has no push credential
only by luck of `cloneRepo` (`:1279-1288`) — `gh` on the host PATH may still be
authenticated.

Fix: append the trust-boundary paragraph (and, for a delivering engagement, the
"never push / never open a PR" line) to `specialistReplyDirective`, or have the
resume path reuse `buildAnalyzePrompt`'s contract sections with the comment as the
directive.

### F13-06 — MED · the Codex question packet is audited as the operator, not the agent

`openAgentQuestionPacket` (Claude transport) records
`task.agent.packet_opened` with `actor: {userId: null, label:
encodeActorRef(actorRef)}` — the P11-23 fix
(`app/server/tasks/agent-toolkit.server.ts:176-185`). The Codex transport records
the *same action id* with `actor: OPERATOR_AUDIT_ACTOR`
(`app/server/tasks/task-actions.server.ts:1575-1583`); the agent identity isn't
even in `details`.

Failure scenario: an actor-filtered audit view attributes every Codex agent's
question to the operator — the exact misreporting P11-23 fixed, surviving on the
other transport. Also blocks "which agent asks the most questions" analytics.

Fix: pass the agent's `actorRef` into `recordAgentCompletion` (it already has it,
:1446) and use `{userId: null, label: encodeActorRef(actorRef)}` plus
`details.actorRef`.

Related, same site: when a packet is already open the Codex question is dropped
silently (`:1545`, `if (question && !parsed.packet)`), whereas the Claude tool
returns `"[refused] A decision is already open … mention your question there
instead"` so the model folds it into its report. The Codex agent's question is
lost with no timeline trace. Add a one-line note to the reply event, or surface it
in the run log.

### F13-07 — MED · the Claude model picker offers ids the run-time validator rejects

`getModelCatalog("claude")` returns the **live** `supportedModels()` list when a
credential is present (`app/server/runtimes/model-catalog.server.ts:365-398`), and
`/resources/model-catalog` serves that straight to the profile modal, which stores
the chosen `value` (`create-profile-modal.tsx:813-847`). `resolveRunModel` then
validates against the **curated** list only — three aliases,
`sonnet|opus|haiku` (`:172-191`) — and silently substitutes `sonnet` for anything
else. Codex is curated-only, so the drift is Claude-specific.

Failure scenario: an account whose live list includes a dated id or a newer family
row (`ModelInfo.value` is documented as "Model identifier to use in API calls",
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1192-1200`). An admin picks
it, saves, and every run silently executes on Sonnet. It *is* flagged after the
fact by the agents-page badge (`agents-page.tsx:383-387`) — but the picker offered
the value, so the badge reads as a bug, and nothing warns at save time.

Fix: either validate a stored model against the **same** catalog the picker used
(cache the live list server-side and consult it in `isKnownModel`), or reject the
value at save time in `agent-profile-actions.server.ts:253,334` so the picker and
the validator can never disagree. Note `resolveClaudeModel`
(`claude-runtime.server.ts:96-105`) already passes dated `claude-*` ids through —
the gate that drops them is `isKnownModel`, one layer up.

### F13-08 — MED · effort is validated on Codex, unvalidated on Claude, and never re-validated on the normal path

`startAgentRun` uses the stored effort verbatim when the run backend equals the
profile's backend (`app/server/tasks/specialist-run.server.ts:598-600`);
`resolveRunEffort` runs **only** on the D4 cross-backend retry (:601-604). The same
holds for the operator (`operator-actions.server.ts:197`) and for the resume path
(`agent-reply.server.ts` `target.effort` → `resumeRun`). The Codex adapter then
narrows through a closed union and drops anything unknown
(`codex-runtime.server.ts:111-124`); the Claude adapter passes the raw string
(`claude-runtime.server.ts:375`) into an SDK option typed
`'low'|'medium'|'high'|'xhigh'|'max' | number` (`sdk.d.ts:1613-1624`).

Failure scenario: a profile is created on Codex with `effort: "minimal"`, then its
`backends` is edited to `["claude"]` without re-opening the effort picker (the
modal only refetches the catalog on backend change; the stored value can survive).
Every Claude run then ships `effort: "minimal"`, which is not in the Claude union.
Best case the CLI ignores it; worst case the run 400s and the human sees a generic
`run·error·unknown`.

Fix: run `resolveRunEffort(backend, effort)` unconditionally on all three paths,
and mirror the Codex guard with a `resolveClaudeEffort` narrowing in the adapter.

### F13-09 — LOW · runtime statistics are posted as the agent's report when it emits no text

`extractFullReplyText` falls back to the last `result`-kind line when no
`assistant`/`agent_message` line exists
(`app/server/tasks/agent-reply.server.ts:290-295`). On Claude that line's text is
`"success · 3 turns · 12s · $0.02"`; on Codex it is
`"in 4.1k (cached 2.0k) · out 0.3k tokens"` (`wire-format.server.ts:140-142`,
`:200-201`). That string becomes the timeline comment, the no-progress comparison
key, and the prose-classifier input for a verdict-capable agent.

Failure scenario: a run that only edits files and exits produces a timeline
comment reading `success · 7 turns · 214s · $0.31`. Worse, two consecutive such
runs on Codex can produce byte-identical text, tripping the "verbatim repeat"
stuck-loop detector (`task-actions.server.ts` operator react) for the wrong reason.

Fix: return `null` from the fallback (the caller already handles "no reply") or tag
it explicitly (`"(no report — see the agent logs)"`).

### F13-10 — LOW · the unified git identity (F24) does not reach a Codex agent's shell

`agentGitIdentityEnv` (`app/server/tasks/specialist-run.server.ts:1213-1232`)
promises "these override any `git config` the agent sets … so from Viberr's eye
codex and claude are indistinguishable in the git history". On Claude that holds —
`spec.env` is merged into the whole child env (`claude-runtime.server.ts:409-411`).
On Codex the model's shell gets `shell_environment_policy: {inherit: "core"}` with
only `GIT_CEILING_DIRECTORIES` explicitly `set`
(`codex-runtime.server.ts:162-166`), so `GIT_AUTHOR_*`/`GIT_COMMITTER_*` are
stripped before any `git commit` the agent runs.

The identity still usually lands via the repo-local `git config user.*` written at
clone (`specialist-run.server.ts:1247-1256`), so this is a weakened guarantee, not
a broken one — but the *stated* mechanism (env beats config) is Claude-only.

Failure scenario: a Codex agent that runs `git config user.email …` or
`git commit --author=…` wins; the same agent on Claude cannot. Also, a clone that
failed `setIdentity` (the catch at :1252) leaves a Codex run committing under the
host's global git identity.

Fix: add `GIT_AUTHOR_NAME/EMAIL` + `GIT_COMMITTER_NAME/EMAIL` to
`shell_environment_policy.set` next to the git ceiling, or correct the docstring.

### F13-11 — LOW/MED · Claude runs have no hang guard; Codex runs do

The Codex adapter arms a 15-minute inactivity timer that aborts a stalled run to
`error` (`app/server/runtimes/codex-runtime.server.ts:170-177, 275-301`), with the
rationale spelled out at :268-274: "without this it stays `running` forever,
waiting=agent, invisible to recovery". The Claude adapter has **no timer of any
kind** — `maxTurns` (`claude-runtime.server.ts:271-276`) bounds turns, not
wall-clock or idle time, and a `for await` over a stalled SDK stream never settles.
`run-service` has no watchdog either (`grep setTimeout` finds none).

Failure scenario: the Claude SDK stream stalls (network partition mid-tool-call,
a hung stdio MCP `npx …`). The run stays `running`, the task stays `waiting:
agent`, the delivering single-flight (`specialist-run.server.ts:535-552` + the
partial unique index) refuses every subsequent delivering run on that task, and the
board shows an "agent working" badge forever. `finalizeOrphanedRuns` only clears it
on the **next process restart**.

Fix: give the Claude adapter the same idle-timer shape (arm on each yielded
message, abort via `queryHandle.interrupt()` / an `AbortController`, settle
`error` with a distinct classified tag), behind `VIBERR_CLAUDE_IDLE_TIMEOUT_MS`.

### F13-12 — MED · an @mention after a backend switch resumes the dead backend's session

`latestSessionRun` (`app/server/tasks/agent-reply.server.ts:117-133`) matches on
`agent_profile_id` + `kind` only — **not** `backend`. The comment right above the
`@agent` branch claims the opposite: "Sessions never match across backends, so the
first reply after a switch starts a fresh run (fresh context) instead of resuming
the dead backend's session" (`:193-197`). `resumeRun` then takes the backend from
the **prior run row** (`run-service.server.ts:435,448`) while the model comes from
the caller (`:452`) — the agent's *current* profile (`task-actions.server.ts:891`).

Failure scenario: Claude quota is exhausted, so an admin switches the `dev` profile
to Codex. A human comments `@dev please continue`. Viberr resumes the old **Claude**
session with `model: "gpt-5.6-sol"`. `resolveClaudeModel` doesn't recognize it and
returns `undefined` (`claude-runtime.server.ts:96-105`), so the run silently uses
the subscription default model, on the backend the admin just moved away from, and
fails on the same quota. The run row records `backend: claude, model:
gpt-5.6-sol` — a combination that never existed. The engagement's `backend` field
is only re-synced by `startAgentRun` (`specialist-run.server.ts:806-811`), which
the resume path skips, so the UI keeps saying Codex.

Fix: filter `latestSessionRun` on the resolved target backend (making the existing
comment true), which naturally routes a post-switch mention to a fresh run.

### F13-13 — LOW · the operator's declared MCP resources are silently ignored on both backends

`resolveOperatorAuthority` reads `skills` and `kb` off the operator profile
(`app/server/tasks/operator-actions.server.ts:194-206`) but never `mcps`, and
neither `startRealOperatorRun` (`operator-run.server.ts:851-869`, `mcpServers:
toolkit.mcpServers` only) nor `startCodexOperatorRun` (`:577-594`, no `mcpServers`
at all) wires them. The agent editor still offers the MCP picker for an operator
profile. Consistent across backends, so not a parity break — but a decorative
resource that the Agents surface presents as configured.

Fix: either merge `resolveSpecialistMcpServers(db, view.resources.mcps)` into the
operator run (Claude) / config (Codex), or hide/disable the MCP picker for
`kind: operator` and say why.

### F13-14 — LOW · disclosure gaps for legitimate, deliberate differences

These are correct-by-design but invisible to the user; each is a one-line UI/doc fix.

1. **Claude specialists get the `claude_code` preset system prompt on top of the
   persona; Codex specialists get the persona alone** (`claude-runtime.server.ts:421-431`
   vs `codex-runtime.server.ts:141`). This is the single largest behavioral
   difference between the two backends for the same profile, and nothing in the UI
   mentions it.
2. **`comment-on-task` is structurally impossible on Codex** — the matrix modal
   flags it "Claude-enforced", which reads as "withholding is advisory" rather than
   "granting does nothing".
3. **`ask-human` fires mid-run on Claude and only at completion on Codex** — a
   Codex agent's blocking question arrives after it has already finished working
   around the blocker.
4. **Credentialed org MCPs authenticate on Claude only** (`codex-runtime.server.ts:74-82`)
   — documented in a docstring; the MCP admin surface shows no per-backend caveat.
   Related: `default_tools_approval_mode: "approve"` is stamped on every translated
   Codex MCP (`:86, :102`), so a Codex agent's MCP tool calls are ungoverned.
5. **The Codex operator cannot reach the network or the web; the Claude operator
   can** (`WebFetch`/`WebSearch` are deliberately not in `OPERATOR_DENIED_BUILTINS`,
   `claude-runtime.server.ts:113-121`, vs `networkAccessEnabled:false` +
   `webSearchMode:"disabled"`, `codex-runtime.server.ts:400-405`). The Claude
   operator therefore has a URL-fetch injection ingress the Codex one does not.
6. **Codex MCP tool calls log as a dim `meta` line** while Claude tool calls log
   with name + input (`wire-format.server.ts:252-256` vs `:112-118`) — the run panel
   is materially less useful for debugging a Codex MCP interaction.
7. **`resolveRunModel`/`isKnownModel` treat the Codex list as authoritative** even
   though the docstring calls it "a best-effort snapshot"
   (`model-catalog.server.ts:92-95, 169-175`): when OpenAI retires `gpt-5.5`, every
   profile pinned to it silently runs on `gpt-5.6-sol` with only the agents-page
   badge as a signal.
