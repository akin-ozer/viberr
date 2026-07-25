# The agent runtime — code map + findings (pass 14, 2026-07-25)

Scope: the whole agent runtime — run start funnel, both backend adapters, host
isolation, capability toolkit, lifecycle/recovery, question packets, mention
fan-out, Claude↔Codex parity. Verified against `main @ fa138e1` (post PR #101).
Every pass-13 claim was re-checked against current code; pass-13 fix status is
noted inline. Line numbers are from this snapshot.

Prior art: `planning/discovery-2026-07-24-pass13/docs/runtime-parity.md`. Of its
findings, **F13-01..F13-12 and most of F13-14 are genuinely fixed** (verified at
the code sites below). What remains open, plus new regressions found this pass,
is in the findings table at the end.

---

## 1. How a run starts, end to end

### 1.1 Assignment → engagement

- `assignSpecialist` (`app/server/tasks/specialist-run.server.ts:257-340`)
  writes the delivering engagement `{profileId, backend, role, delivers: true,
  verdictCapable}` into `task.md` frontmatter; it drops a prior supporting entry
  for the same profile so a profileId never appears twice (:295-310).
- `assignReviewer` (:359-450) appends a `delivers: false` engagement,
  idempotent across BOTH engagement shapes (:386-397). `verdictCapable` is
  snapshotted at engage time from `resolveAgentCollab(capabilities).verdict`
  (:418) — the completion pipeline later prefers this snapshot (§4.2).
- Stage eligibility (F1) is enforced at assign AND run time via
  `assertStageEligible` (:279, :644-646, :1497-1507) — but **not** on the
  undeployed-snapshot fallback (finding RT-01).

### 1.2 The one start funnel

`startAgentRun` (`specialist-run.server.ts:523-926`) is the single specialist
entry point for every path — UI "Run" button (`app/routes/project.task.tsx:473,
502`), operator `run_agent`/`prompt_agent`
(`app/server/tasks/operator-actions.server.ts:996,1062`), operator
`operatorPromptAgent` (`task-actions.server.ts:2461,2474`), packet resolutions
(`task-actions.server.ts:3604,3941,3949`), and the fresh-@mention branch of
`commentToAgent` (`task-actions.server.ts:1082,1100`). Steps, in order:

1. **Single-flight** for delivering runs: live-row check (:570-587) backed by
   the partial unique index `idx_agent_runs__one_delivering`
   (`db/migrations/0001_baseline.sql:342-344`); `startRun` translates the
   constraint race into a 409 (`run-service.server.ts:315-329`).
2. **Backend resolution** (:589-608): D4 `backendOverride` → live deployment
   (`resolveDeployedSpecialist` re-reads project.md, so a backend edit applies
   on the very next run) → engagement snapshot.
3. **Model/effort** (:612-640): same-backend runs use the profile's
   `resolveRunModel`-validated value (`toResolved`,
   :132-152 → `model-catalog.server.ts:210-216`); a cross-backend retry
   re-resolves both for the actual backend (:636-639). `startRun` then
   normalizes effort **unconditionally** for the run backend
   (`run-service.server.ts:360-368` → `resolveRunEffort`,
   `model-catalog.server.ts:226-257`, rank-mapped across the two tier scales) —
   F13-08 fixed; the adapters additionally narrow
   (`resolveClaudeEffort`, `claude-runtime.server.ts:120-131`;
   `resolveCodexReasoningEffort`, `codex-runtime.server.ts:125-138`).
4. **Persona** = profile `definition` + skill bodies + KB bodies under one
   24k global budget + trusted-provenance banner + MCP-governance rule
   (`buildSpecialistPersona`, :931-1010; `readKbBody`,
   `app/server/files/kb-injection.server.ts:126-201` — recursive walk, all text
   extensions, budget charges headings, honest truncation marker, warns on a
   missing/empty KB).
5. **Workspace**: `cloneRepo` (:1303-1371) clones into
   `<taskDir>/workspace/<repo>` with the project PAT via
   `createGitHubClonePlan`, sanitizes a legacy credentialed origin on reuse
   (:1332-1343), stamps the profile git identity (:1316-1325). cwd is always
   inside the workspace; `GIT_CEILING_DIRECTORIES=<taskDir>` (strict ancestor,
   :1263-1280) + `GIT_AUTHOR_*/GIT_COMMITTER_*` env (:1289-1301).
6. **Prompt** = `buildAnalyzePrompt` (:1019-1127): workspace contract,
   per-grant delivery steps (XS-4: prompt matches enforcement via
   `resolveDeliveryPermissions`), supporting read-only block, directive quoted
   as untrusted, trust-boundary block. Collab notes appended per transport
   (:728-755).
7. **Transports**: Claude → `buildAgentToolkit` in-process MCP + declared org
   MCPs merged (:777-793); Codex → `AGENT_OUTCOME_JSON_SCHEMA` outputSchema
   when `verdict ∨ ask ∨ evidence` (:799-802, P13-D-26).
8. `startRun` (`run-service.server.ts:288-396`): inserts the queued row, audits,
   builds the `RunSpec`, derives `repoWriteWithheld` from the denylist
   (`repoWriteWithheldFromDenylist`, :268-274 — Edit+Write+NotebookEdit all
   denied ⇒ withheld), fail-fasts `run·unavailable` when the backend has no
   credential (:389-423), else `launch` wires the sink + adapter (:694-758).
9. Engagement backend re-synced to what actually ran (:848-854); completion
   handler installed via `registerAgentCompletion` (:911-923) with the
   `outcomeKey` persisted onto the run row for boot recovery
   (`task-actions.server.ts:1918-1923`, AO-1).

### 1.3 Adapters

- **Claude** (`claude-runtime.server.ts:392-696`): official Agent SDK `query()`
  in streaming-input mode (interruptible), `bypassPermissions` when autonomous,
  `maxTurns` runaway guard (default 2000, :329-334), 15-min **idle guard**
  (:407-433, `VIBERR_CLAUDE_IDLE_TIMEOUT_MS`) — F13-11 fixed; classified
  redaction-safe failure lines with the kind riding the tag suffix
  (`run·error·quota|auth|session_missing|idle_timeout|max_turns`,
  :336-390, :435-488, :653-669).
- **Codex** (`codex-runtime.server.ts:376-620`): official Codex SDK
  `startThread/resumeThread` + `runStreamed`, `approvalPolicy: "never"`,
  AbortController interrupt, the same 15-min idle guard (:391-424), the same
  classified failure kinds incl. `session_missing` (:297-366), success gated on
  `turn.completed` with no top-level fatal (:589-593).
- **Operator runs** go through the same `startRun` funnel:
  `startRealOperatorRun` (Claude, tools) / `startCodexOperatorRun` (Codex,
  structured plan) — §3.3.

## 2. Host isolation

### 2.1 Claude

- SDK options close every channel: `settingSources: []`, `skills: []`,
  `plugins: []` (`claude-runtime.server.ts:515-534`); the ~16 binary-compiled
  SDK skills are made uninvokable by denying the `Skill` tool in
  `BASE_DENIED_BUILTINS` (:227-255), which also closes the whole subagent-spawn
  family (`Task*`), Workflow/Cron/Monitor/SendMessage/worktrees.
- Spawn env is **replaced**, not merged: `claudeSpawnEnv`
  (`runtime-registry.server.ts:255-265`) starts from `filteredSpawnEnv`
  (credential-shaped names + private runtime vars stripped, :199-213), then adds
  only `CLAUDE_CONFIG_DIR` + the selected credential.
- `CLAUDE_CONFIG_DIR`: app-owned `data/runtimes/claude-home` — EXCEPT under
  `VIBERR_CLAUDE_USE_CLI_AUTH`, where runs keep the human's real `~/.claude`
  so keychain auth resolves (`claude-config.server.ts:25-32`). Deliberate;
  isolation then rests entirely on the SDK options above (repo `CLAUDE.md`
  still never loads — it is a settings source).

### 2.2 Codex

Pass 13 rebuilt this and it is now genuinely strong:

- **App-owned CODEX_HOME** (`codex-config.server.ts:62-68`), because `--config`
  overrides merge per dotted leaf key into the home's `config.toml` — a host
  home leaks its MCP servers/skills/plugins/AGENTS.md into every run (verified
  against codex-cli 0.144.6, :17-44). `prepareCodexHome` (:109-159) mirrors the
  human's `auth.json` in (symlink, copy fallback) — CLI-auth mode only.
- **Config keys** (`codexConfigForRun`, `codex-runtime.server.ts:189-253`),
  enforced AFTER the base spread so a deployment override can't re-open them:
  `allow_login_shell: false`; `project_doc_max_bytes: 0` (F13-04 fixed — repo
  `AGENTS.md` never merges); `skills: { include_instructions: false, bundled:
  { enabled: false } }` — **structurally valid**: `bundled` is a struct in the
  CLI schema and a bare boolean makes the CLI refuse its config entirely
  (docstring :211-216; asserted in
  `codex-runtime.server.test.ts:765-780`, incl. a base-config override attempt
  at :798-799); `features.apps/plugins/hooks: false`; `memories.*: false`;
  `mcp_servers` replaced with only the run's declared set (:246);
  `shell_environment_policy.inherit: "core"` with an explicit `set` for
  `GIT_CEILING_DIRECTORIES` + the four git-identity vars (:154-169 — F13-10
  fixed).
- Spawn env: `codexSpawnEnv` (`runtime-registry.server.ts:221-238`) — filtered
  env + `CODEX_HOME`, API keys deleted under subscription auth.
- Residual gap: the auth mirror runs **once per process** (finding RT-05).

## 3. Capability toolkit and grants

### 3.1 Grants → tool policy

- `deploymentGrants` (`specialist-run.server.ts:168-178`): an **empty** stored
  grant list resolves to the fully-withheld set (AP-06) — but only when the
  deployment resolves at all (finding RT-01).
- `resolveSpecialistDisallowedTools`
  (`app/server/tasks/specialist-tool-policy.ts:94-105`): withheld
  (`human`/`off`/always-human) capabilities map to deny rules —
  branch (`git checkout -b/-B`, `switch -c/-C`), `commit-push-branch`
  (`git push`, `git commit`), `open-review-pr`, `merge-pull-request`,
  `execute-code-or-write-repo` (Edit/MultiEdit/Write/NotebookEdit +
  `git commit`), and since P13-LV-18 `use-web-search-fetch`
  (WebFetch/WebSearch) (:30-78). Polarity is safe-by-default: absent =
  granted.
- **Claude enforcement**: `disallowedTools` bind under bypassPermissions
  (`claude-runtime.server.ts:566-583`), layered with `BASE_DENIED_BUILTINS`
  (every run), `OPERATOR_DENIED_BUILTINS` (Bash/Edit/Write family, :163-171),
  `SUPPORTING_DENIED_BUILTINS` for `kind: "reviewer"` (:186-199).
- **Codex enforcement** (P13-RT-02, fixed): `resolveCodexSandboxMode`
  (`codex-runtime.server.ts:267-272`) — operator/reviewer → `read-only`;
  delivering run with `repoWriteWithheld` → `read-only`; else
  `danger-full-access`. The flag is derived backend-agnostically from the same
  denylist (`run-service.server.ts:256-274`), so the sandbox binds for exactly
  the profiles the matrix shows withheld. The fine-grained branch/push/PR
  denials and `use-web-search-fetch` remain Claude-only on Codex
  (`CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`,
  `app/shared/capabilities.ts:181-193`) — but that set now **wrongly still
  contains** `execute-code-or-write-repo` (finding RT-03), and web egress could
  use the existing `webSearchMode` channel (finding RT-06).
- Server-side backstops (both backends): delivery push gate
  (`resolveDeliveryPushGrant`, `task-actions.server.ts:2932`), verdict/ask/
  evidence gating in the completion pipeline (§4.2), ALWAYS_HUMAN set
  (`capabilities.ts:144-148`).

### 3.2 Injection points

- Org MCP servers: `resolveSpecialistMcpServers`
  (`app/server/tasks/specialist-mcp.server.ts:33-98`) — decrypted credential as
  HTTP `Authorization` header / stdio `MCP_CREDENTIAL` env, quote-aware argv
  split (KM-17), loud warn on an unresolvable name (KM-11). On Codex the
  translation drops credentials (argv exposure) and stamps
  `default_tools_approval_mode: "approve"` (`codex-runtime.server.ts:83-122`);
  `type: "sdk"` in-process servers are skipped. Both facts are now disclosed in
  the matrix modal (`capability-matrix-modal.tsx:210-218`).
- Skills/KB: injected as prompt text only — one reader each
  (`skill-body.server.ts`, `kb-injection.server.ts`), shared by operator and
  specialists.
- Agent toolkit (Claude only): `buildAgentToolkit`
  (`app/server/tasks/agent-toolkit.server.ts:207-374`) — `post_comment`
  (grant-gated, mid-run comment + mention fan-out :121-128), `ask_human`
  (mid-run packet, refusal message when one is open :279-282),
  `report_outcome` (stages verdict + grant-gated `evidence` field, P13-D-26).
  An ungranted capability's tool is never built.

### 3.3 The operator

- `OperatorAuthority` (`operator-actions.server.ts:71-98`): policy map,
  autonomy, backend/model/effort, skills, kb, **mcps** (KM-03), persona
  override, `deployed`. `gate()` (:222-236): absent grant = deny;
  `recommend` promotes to direct under full autonomy EXCEPT
  `completion-for-acceptance` (owner ruling Q1).
- System prompt (`operator-run.server.ts:1134-1192`): shipped definition +
  additive project persona + skills + KB (same 24k budget) + live policy block
  + unconditional non-negotiable rules (R-A/R-C).
- **Claude operator**: in-process `viberr` toolkit, tools built only for
  non-denied capabilities (`operator-toolkit.server.ts:72-351`);
  declared org MCPs mounted + allowlisted (:360-375, KM-03 fixed);
  `allowedTools` confinement; repo-mutation built-ins denied;
  web egress denial when withheld (`operator-run.server.ts:1006-1011`,
  P13-LV-18).
- **Codex operator**: structured plan constrained to
  `buildOperatorPlanSchema(operatorPlanToolsFor(authority))` — the schema now
  advertises only permitted tools (:458-471, P13-RT-03 fixed);
  `executeCodexPlan` (:695-911) runs the plan through the same gated actions,
  collects `denied`/`noop` outcomes and narrates them as a `policy` event even
  when `append-typed-events` is itself withheld (`narrateRefusedActions`,
  :923-962); a no-plan reply escalates a blocked packet (:707-737); a
  mid-plan throw aborts the remainder and narrates (:888-908). Sandbox:
  read-only + no network + web search disabled
  (`codex-runtime.server.ts:513-518`). Declared MCPs are **not** mounted on
  the Codex operator (finding RT-04).
- Failed operator runs escalate on BOTH backends now
  (`escalateFailedOperatorRun`, :1049-1095; Claude wiring :1023-1032).

## 4. Run lifecycle

### 4.1 Lease / drain / single-flight

- Operator: process lease + newest-wins pending queue
  (`operator-run.server.ts:144-300`), token-object idempotent release
  (:185-214), **cross-boot drain** `drainPendingAfterInFlight` (:223-242) that
  never evicts a live successor (AO-2 fixed, verified), waiting-flag settle on
  final release (:255-276) with the LV-20 terminal-stage → `none` rule
  (`clearWaitingToHuman`, `task-actions.server.ts:2357-2391`).
- Specialist: one delivering run per task (§1.2.1); supporting runs concurrent.

### 4.2 Outcomes: envelope + fallback

`applyAgentCompletionEffects` (`task-actions.server.ts:1947-2352`) is the one
completion path (live callback and boot recovery share it):

- Envelope resolution: Claude staged outcome via persisted `outcome_key`
  (`agent-outcome.server.ts:208-263`, `staged_outcomes` table
  `0001_baseline.sql:358`) → else Codex JSON reply parsed tolerantly
  (`parseAgentOutcomeJson`, :131-195; raw JSON never becomes the comment,
  `task-actions.server.ts:2039-2047`).
- Verdict authority: engagement `verdictCapable` snapshot first, live grants
  fallback (:2025-2034); prose classifier `classifyReviewerVerdict`
  (:1527-1583) only for verdict-authorized agents; a verdict-granted run with
  no determinable verdict leaves validation unchanged and warns (:2062-2077).
- Question: live `ask` grant (deliberate asymmetry, :2079-2087); evidence rows
  gated on `attach-evidence-references` + server-derived delivery rows
  (:2088-2096, `deliveredWorkEvidence` :1597-1624).
- Atomic write of reply + verdict + question in `recordAgentCompletion`
  (:1627-1888); a question colliding with an open packet becomes a visible
  "Question held" note (F13-06 second half — fixed, :1774-1794) and the packet
  audit is attributed to the **agent** (:1826-1844 — F13-06 fixed).
- Error runs: typed blocked event + classified copy + recovery packet with
  `retry_other_backend` for quota/auth/unavailable (:2114-2215); `max_turns`,
  `idle_timeout` and `session_missing` have their own honest copy (no
  retry-other-backend for session_missing — correct, the same backend fresh
  run is the fix).
- React loop: no-progress verbatim-repeat + depth cap → stuck packet
  (:2288-2325); otherwise the operator reacts with the reply embedded in the
  prompt (:2336-2351).

### 4.3 Restart / recovery

- `finalizeOrphanedRuns` (`run-recovery.server.ts:38-151`): orphans → `error`,
  operator re-invoked under a 3-per-30-min crash-loop cap.
- `recoverUnreactedAgentRuns` (:181-308): finished-but-unreacted
  primary/reviewer runs replay the full completion effects, re-supplying the
  persisted `outcome_key` (AO-1 — verified fixed), with its own replay cap.
  Operator runs are outside its filter (finding RT-08).
- Spawn-crash race covered: `fireIfAlreadyTerminal`
  (`run-service.server.ts:110-147`) fires a callback registered after a
  synchronous exit.

### 4.4 Session resume + continuity (new in pass 13, verified)

- `latestSessionRun` (`agent-reply.server.ts:153-175`) filters by profile +
  kind + **backend** (F13-12 fixed) and skips runs stamped `session_missing`
  (`runIdsWithMissingSession`, `run-store.server.ts:337-350`, json_extract on
  the tag — not spoofable by printed text).
- `resumeRun` (`run-service.server.ts:572-691`) **probes continuity first**
  (`probeSessionContinuity`, `session-export.server.ts:233-245` — uncached,
  three-valued present/missing/unknown). A dead transcript does NOT fail the
  turn: the dead run is stamped, a timeline note lands, and a fresh
  canonical-anchored run starts with the continuity preamble (:624-657).
  Confinement is re-applied on resume via `resolveResumeConfinement`
  (`specialist-run.server.ts:1160-1255`): denylist, env, MCPs, persona, fresh
  `outcomeKey`/toolkit on Claude, re-armed envelope on Codex; an undeployed
  profile resumes fully withheld (:1248-1254).
- Resumed turn prompt now carries the canonical anchor + trust boundary +
  delivery rule (`specialistReplyDirective`, `task-actions.server.ts:849-883`
  — F13-05 fixed).
- Transcript location/export: `session-export.server.ts:74-153` (app-owned
  homes + legacy login dir via `codexSessionRoots`), `transcriptExists` cached
  filename-only probe (:171-191), resume bundle script (:297-383).

### 4.5 Workspace reclaim (pass-13 addition — verified real)

`reclaimTerminalTaskWorkspaces`
(`app/server/tasks/workspace-retention.server.ts:85-123`) removes
`<taskDir>/workspace` for every task in its project's LAST stage; wired at boot
(`app/server/boot.server.ts:190`). Conservative (terminal stage only,
best-effort, idempotent) and honest about the clone being a cache. One ordering
caveat: it runs after *scheduling*, not after *completing*, the async reply
recovery (finding RT-09).

## 5. Question packets, mentions, fan-out

- `ask_human` (Claude, mid-run): `openAgentQuestionPacket`
  (`agent-toolkit.server.ts:136-203`) — one packet per task, re-checked inside
  the locked write, `waiting: "human"`, agent-attributed audit, watcher
  notification. Codex: `question` on the final envelope, opened at completion
  (§4.2), deferred visibly when a packet is open.
- Mention fan-out `notifyMentionedUsers`
  (`app/server/tasks/mention-notify.server.ts:57-94`): multi-word display names
  via the shared span-finder (LV-11), reserved agent handles never notify a
  person. Wired into **all four** agent-side writers: the finished-run path
  (`recordAgentCompletion`, `task-actions.server.ts:1798-1815` — F13-01 fixed,
  tested in `agent-completion-notify.server.test.ts`), the interrupted/errored
  path (`postAgentReplyComment`, :1318-1329), Claude mid-run comments
  (`agent-toolkit.server.ts:121-128`), and the operator writers. The reply
  directive and operator turn instruction both tell the model to tag the human
  (:873-876; `operator-run.server.ts:1217-1227`).
- Completion fan-out: verdicts notify via `notifyTaskWatchers(kind:"quality")`
  (:1876-1880), questions via `kind:"approval"` (:1845-1855), failures via
  `kind:"quality"` (:2204-2213).
- Gap: a **first-ever** @mention (no prior session) starts a fresh run that
  never receives the comment text at all (finding RT-02).

## 6. Claude ↔ Codex parity

### Deliberate, disclosed (matrix modal, `capability-matrix-modal.tsx:85-93,120-125,195-231`)

| Difference | Where |
|---|---|
| Claude persona rides the `claude_code` preset; Codex gets persona alone | `claude-runtime.server.ts:545-561` vs `codex-runtime.server.ts:197`; disclosed :198-201 |
| `comment-on-task` has no Codex channel | toolkit vs nothing; disclosed :202-205 |
| `ask-human` mid-run vs at completion | disclosed :206-209 (F13-14#3 fixed) |
| Org MCP credentials Claude-only; Codex mounts unauthenticated + approve-mode | `specialist-mcp.server.ts:25-31`, `codex-runtime.server.ts:88-103`; disclosed :210-213 |
| Codex lowercases MCP server hyphens → underscores in tool names | disclosed :214-219 (LV-15) |
| MCP tools ungated by the matrix — prompt-level rule on both | persona block `specialist-run.server.ts:991-1008`; disclosed :220-225 |
| Claude operator can reach the web when granted; Codex operator cannot | `operator-run.server.ts:1006-1011` vs `codex-runtime.server.ts:513-518`; disclosed :226-230 |
| Codex supporting/withheld runs get a *stronger* physical read-only sandbox | header copy :88-93 |
| Fine-grained branch/push/PR + web denials bind on Claude only | badge + `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` |
| Operator turn: Claude fetches live snapshot via `get_task`; Codex gets it inlined | `operator-run.server.ts:1259-1295` |
| Cost: Claude reports `$`; Codex tokens only | `wire-format.server.ts:135-142,196-208` |
| Runaway guard: Claude maxTurns; Codex none (idle guard on both now) | `claude-runtime.server.ts:329-334` |

### Accidental / residual differences found this pass

1. `execute-code-or-write-repo` is labeled Claude-only-enforced although the
   Codex sandbox now enforces it (RT-03).
2. Codex operator mounts no declared MCPs; Claude operator does (RT-04).
3. `use-web-search-fetch` withheld: enforced on Claude, unenforced on a Codex
   specialist even though `webSearchMode: "disabled"` exists and is used for
   the operator (RT-06).
4. Codex `mcp_tool_call`/`web_search` items log as empty `meta` lines; Claude
   logs tool name + input (RT-07).
5. Model catalog: Claude live `supportedModels()` + curated + dated-id pass-
   through, validator now agrees with the picker (F13-07 fixed,
   `model-catalog.server.ts:194-216, 314-324`); Codex remains a hand-curated
   4-id snapshot (`:96-138`) — retirement of an id silently re-routes to the
   default model with only the agents-page badge as signal (accepted, F13-14#7).
6. Idle-timeout env vars differ in access path (`getEnv()` vs raw
   `process.env`) — documented, benign
   (`codex-runtime.server.ts:277-281` vs `claude-runtime.server.ts:150-155`).
7. Claude CLI-auth keeps the real `~/.claude` as config dir; Codex always gets
   the app-owned home (`claude-config.server.ts:25-32` vs
   `codex-config.server.ts:62-68`) — isolation is SDK-options-based on Claude,
   filesystem-based on Codex.

---

## 7. Findings

| id | sev | headline | evidence | confidence |
|---|---|---|---|---|
| RT-01 | **HIGH** | A fresh run of an engaged-but-undeployed profile runs **fully unconfined**: `startAgentRun`'s snapshot fallback leaves `disallowedTools = []`, `resolveDeliveryPermissions([])` grants every delivery step in the prompt, `repoWriteWithheld` stays false (Codex ⇒ `danger-full-access`), and stage eligibility is skipped — while a *resumed* run of the same vanished profile is conservatively fully withheld (`resolveUndeployedDisallowedTools`). Undeploying a profile therefore *escalates* its next fresh run. | `specialist-run.server.ts:593-646` (catch → `resolved = null`, denylist only set `if (resolved)`; `:705` `resolveDeliveryPermissions(resolved?.capabilities ?? [])`) vs `:1248-1254`; reachable via `project.task.tsx:473,502` and packet resolutions `task-actions.server.ts:3604,3941` | High — code-path read end to end; `resolveUndeployedDisallowedTools` has exactly one caller (resume). Not live-reproduced. |
| RT-02 | **HIGH** | A **first-ever @mention** of an agent (no prior session on the task) starts a fresh run that never receives the comment: neither fresh branch of `commentToAgent` passes `directive: input.text`, so the agent gets the generic analyze prompt, is never told who asked or what, never tags the commenter (NEW-4 broken on this path), and may start delivering work when the human only asked a question. Resume and operator-prompt paths both thread the text. | `task-actions.server.ts:1059-1108` (`startAgentRun` called with no `directive` in both branches) vs the resumed path `:991-1000` and `operatorPromptAgent` `:2461-2479` | High on the code fact; behavioral impact inferred (not live-run). |
| RT-03 | MED | Stale enforcement honesty, in the *understating* direction: `execute-code-or-write-repo` is still in `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`, so the matrix row badge says "binds tools on Claude runs · advisory on Codex" — but since P13-RT-02 the Codex read-only sandbox physically enforces the withheld grant. The metadata contradicts the fix it sits next to. | `app/shared/capabilities.ts:181-193` vs `codex-runtime.server.ts:255-272` + `run-service.server.ts:256-274`; rendered `capability-matrix-modal.tsx:122-125,156-170` | High. |
| RT-04 | MED | The **Codex operator never mounts its declared MCP servers** — KM-03 wired them into the Claude toolkit only; `startCodexOperatorRun` passes no `mcpServers`, so `codexConfigForRun` writes `mcp_servers: {}` and the grant stays decorative on Codex (the CLI could otherwise call read tools mid-turn to inform its plan). The `OperatorAuthority.mcps` docstring reads as if the gap is closed everywhere. | `operator-run.server.ts:627-645` (no `mcpServers` in the `startRun` input) vs `operator-toolkit.server.ts:360-375`; `operator-actions.server.ts:84-91` | High. |
| RT-05 | MED | The codex-home **auth mirror is boot-time-only**: `prepareCodexHome` runs once inside `createAdapters`; on any deployment where the login dir ≠ run home (every non-container dev machine), an `auth.json` that lands after boot is never mirrored — yet the availability probe (live, re-probing, checks the *login* dir) reports Codex available and the unavailable-copy promises "the next run picks it up without a restart". Runs then fail auth against an empty run home. Copy-fallback mirrors (no symlink support) also never refresh after a mid-process re-login. | `runtime-registry.server.ts:268-317` (single call site :284), `codex-config.server.ts:94-159`, promise at `run-service.server.ts:433-441` | Med-high — code-verified; container unaffected (home == login dir there). |
| RT-06 | MED | `use-web-search-fetch` withheld is **unenforced on a Codex specialist** even though the enforcement channel exists and is already used: `threadOptions.webSearchMode: "disabled"` is set only for `kind === "operator"`. The same one-line mechanism the P13-RT-02 fix used for repo-write maps directly onto the withheld web grant (mirror of the F13-02 pattern). Disclosed as Claude-only, so honest — but needlessly weak. | `codex-runtime.server.ts:504-518` vs `specialist-tool-policy.ts:60-68`; `capabilities.ts:190-192` | High on the gap; medium on CLI default web-search behavior (not live-verified). |
| RT-07 | LOW | Codex `mcp_tool_call` / `web_search` items still project as dim `meta` lines with usually-empty text, so the run panel cannot show which MCP tool a Codex agent called or with what — Claude logs name + input. Also absent from the parity disclosure list. | `wire-format.server.ts:252-256` vs `:112-118` | High. |
| RT-08 | LOW | A restart in the window between a Codex operator run finishing and `executeCodexPlan` completing loses the whole coordination turn silently: the finished operator row is invisible to both recovery passes (orphan finalize wants `running/queued`; reply recovery filters `kind IN ('primary','reviewer')`), the in-process completion map is gone, and the task stays `waiting: agent` until some later trigger. Narrow window, but the failure is total and traceless. | `operator-run.server.ts:652-672`; `run-recovery.server.ts:45-49,187-200`; caveat comment `run-service.server.ts:74-82` | High on the mechanism; window is seconds. |
| RT-09 | LOW | Boot-ordering claim is false: `reclaimTerminalTaskWorkspaces` runs right after *scheduling* (`void … .catch`) the async `recoverUnreactedAgentRuns`, while its comment says it "runs after the recovery pass above so nothing in flight is touched" — a recovered run's delivery reconcile can race the `rmSync` of the same workspace for a terminal-stage task still marked waiting=agent. | `boot.server.ts:177-199`; `workspace-retention.server.ts:38-41` | High on ordering; low practical impact (needs terminal-stage + waiting=agent + unreplayed run). |
| RT-10 | LOW | A Claude run that ends with an `is_error` **result** (any subtype except `error_max_turns`) settles `error` with no classified terminal err line: the result line's tag is `result`/ev `result`, which `runFailureReason` never matches, so the packet copy degrades to the generic "run ended in an error" and loses the quota/auth `retry_other_backend` routing for result-shaped failures (thrown stream errors are classified fine). | `claude-runtime.server.ts:644-670`; `agent-reply.server.ts:445-478` | Medium — depends on which failures the SDK surfaces as `is_error` results vs throws. |
| RT-11 | LOW | `projectOne` (the `interruptRun` response view) matches the grouped `RunView` by `r.id === run.thread_id`, but a group's id is its *representative's* thread id — interrupting a non-representative run (e.g. an older resume while a newer row exists) falls through to `projectRunsForTask(...)[0]!`, returning an unrelated group's view (and would throw on an empty projection). | `run-service.server.ts:929-931`; grouping `run-projection.server.ts:224-243` | Medium — misbehavior window is small; response-shaping only. |
| RT-12 | LOW | Inconsistent stuck-packet @handles: `startAgentRun` derives the handle from the **role** (`agentHandleFor("Senior Developer")` → `@senior`) while `commentToAgent` uses the **name** (`target.name.toLowerCase()` → `@dev`, multi-word names produce non-tokenizable handles like `@docs writer`). The same agent is addressed differently depending on which path registered completion, and the packet's "Agent: @…" observation may name a handle that resolves to nothing. | `specialist-run.server.ts:1377-1380,921` vs `task-actions.server.ts:1131` | High on the inconsistency; cosmetic impact. |

### Pass-13 ledger cross-check (all re-verified against fa138e1)

- **Fixed**: F13-01 (`task-actions.server.ts:1798-1815`), F13-02
  (`codex-runtime.server.ts:267-272` + `run-service.server.ts:256-274`), F13-03
  (`operator-run.server.ts:458-471,753-765,923-962`), F13-04
  (`project_doc_max_bytes: 0`, `codex-runtime.server.ts:206`), F13-05
  (`task-actions.server.ts:861-882`), F13-06 (both halves,
  `:1826-1844,1774-1794`), F13-07 (`model-catalog.server.ts:194-216`), F13-08
  (`run-service.server.ts:360-368` + both adapter narrowings), F13-09
  (`agent-reply.server.ts:329-351` — result-line fallback removed), F13-10
  (`codex-runtime.server.ts:154-169`), F13-11 (`claude-runtime.server.ts:
  134-155,404-433`), F13-12 (`agent-reply.server.ts:162-175`), F13-13
  (Claude side, `operator-toolkit.server.ts:360-375` — Codex side is RT-04),
  F13-14 #1-#5 (matrix-modal notes :195-231).
- **Still open by design**: fine-grained branch/push/PR denials advisory on
  Codex (AO-4 ruling, disclosed); Codex curated model list (F13-14#7); F13-14#6
  log fidelity → RT-07.
