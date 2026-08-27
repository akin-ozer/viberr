# Viberr AI-Agent Runtime — How Runs Execute and How the Operator Chooses Agents

Discovery pass 29 (2026-08-27). Read-only documentation of the server-side machinery that runs
Claude Code and OpenAI Codex against GitHub repos inside Viberr, and the "operator" agent that
triages tasks and dispatches them. Every claim below is grounded in a `file:line` citation against
the code in this worktree (`app/`); citations were captured by direct reads plus two parallel
research passes, cross-verified where they overlapped.

Audience: an agent (or engineer) who needs to understand or modify the runtime without re-deriving
it from scratch.

---

## 0. Mental model, in one paragraph

A **run** is one provider process (Claude Code or Codex) executing one prompt against one working
directory, tracked as an `agent_runs` row plus a raw `.jsonl` transcript
(`app/server/runtimes/run-store.server.ts`). Runs are started by `startRun`
(`app/server/runtimes/run-service.server.ts:639`), which resolves an adapter for the requested
**backend**, admits the run under a concurrency cap, and streams provider output through a shared
**wire-format** normalizer into DB rows + live SSE. The **operator** is itself a run (`kind:
"operator"`) — a persistent coordinating agent, backed by either Claude or Codex, that reads a task
snapshot through an in-process governance toolkit and decides (as an LLM, not a scoring function)
which deployed **agent profile** to **engage** as the task's **engagement**, then runs it. A profile
carries **capability grants** that are compiled into concrete tool denylists/MCP mounts/prompt
permissions per run — this is what actually confines what an agent can do, not the persona prompt.
Certain actions (merging a PR, moving a task to Done as an agent, changing project policy) are
**always human**, structurally, regardless of any grant or autonomy setting.

---

## 1. Run lifecycle

### 1.1 Create → reserve (optional) → admit (concurrency cap) → launch → stream → finalize

**Entry point.** `startRun(db, input: StartRunInput)` —
`app/server/runtimes/run-service.server.ts:639`. Callers: `specialist-run.server.ts` (specialist /
reviewer dispatch), `operator-run.server.ts` (the operator's own run), `agent-reply.server.ts`
(resumed @mention threads via `resumeRun`).

**Reservation (R21-4, optional).** Before a potentially slow workspace clone, a caller can call
`reserveRun(db, input: ReserveRunInput)` — `run-service.server.ts:406-507` — which:
- Checks the concurrency cap itself (`liveCount(state) >= cap` → returns `null`, degrading to the
  normal queued path with no live "Preparing…" strip — `:419-421`).
- Writes an `agent_runs` row **already in `running` state** with `phase: "Preparing workspace"`
  (`RUN_PHASE.preparing`, `adapter.server.ts:186`) so the task page shows something live during a
  multi-minute cold clone (measured 3–12 min on a 113 MB repo, `:332-336`).
- Adds the run id to `state.reserved` — a `Set<string>` that **counts against the concurrency cap**
  from the moment of reservation, before any provider process exists (`:100-101`, `:1236-1238`,
  see §7.1 for why this matters).
- Returns a `RunReservation` handle with `.phase(phase, step)` to update the live strip and
  `.abandon(reason)` to release the slot and finalize the row as `error` if preparation throws.

`startRun` then **adopts** a reservation whole (`reservation ? runRow.state = "running" : "queued"`,
`:702-710`), re-validating with `assertRunReservationLive` (`:388-398`) that nothing else (e.g. a
human's Stop click landing during the clone) has already claimed the row — see the C4-opres gotcha
in §7.2.

**Admission (concurrency cap).** A **non-reserved** run is admitted by `admitRun(db, runId,
launchThunk)` — `:1252-1266` — which reads `getMaxConcurrentRuns(db)`
(`app/server/settings/instance-settings.server.ts:68-70`, 0 = unlimited) and either launches
immediately or parks the launch thunk in `state.pending` (FIFO). `drainRunQueue(db)`
(`run-service.server.ts:1276-1295`) promotes the oldest still-`queued` pending run whenever a slot
frees (called from every run's `onExit`, from `interruptRun`, and from a reservation's
`.abandon()`). The live count is `handles.size + reserved.size` (`liveCount`, `:1236-1238`) — see
§7.1.

**Launch.** `launch(db, spec, adapter, opts)` — `:1321-1450` — creates a `RunSink`
(`createRunSink`, `run-sink.server.ts:178`), marks the row `running`, optionally writes a
model-substitution disclosure line first (F21-13, see §1.2), then calls `adapter.start(spec, {
onLine, onPhase, onExit })`. The returned `RunHandle` is stored in `state.handles` **only if** the
adapter did not already exit synchronously (`:1444-1449` — guards the F-SPAWN2 crash race, see
§7.3).

**Streaming.** Each backend adapter (`claude-runtime.server.ts`, `codex-runtime.server.ts`) drives
`onLine` per provider event; `run-sink.server.ts`'s `line()` (`:340-408`) does, in order: (0) redact
secrets (`createLineRedactor`, `:143-176`, built once per run from `process.env`), (1) append the
raw envelope to the canonical `.jsonl` (`appendRawLine`), (2) insert the projected display row into
`run_log_lines`, (3) fold usage/turns/cost facts into the `agent_runs` row, (4) publish
`run.log-appended` — **strictly after** persistence, so an SSE subscriber can always fetch the line
it was told about (`run-sink.server.ts:92-93`).

**Finalize.** `sink.finalize(exit: RunExit)` — `:410-449` — resolves the terminal state via
`resolveTerminalState(current, desired)` (`:48-53`), which **never demotes** an already-terminal
row (B-FD7: a human's `interrupted` stamp always wins over a racing adapter's own `finished`/`error`
exit — see §7.2). `launch`'s `onExit` then deletes the handle, calls `drainRunQueue`, and fires any
registered one-shot completion callback (`registerRunCompletion` / `chainRunCompletion`,
`:199-231`) — this is how `task-actions.server.ts` posts an agent's reply comment and re-engages the
operator once a run ends, without `run-service` importing task logic (kept decoupled by design,
`:104-114`).

**Interrupt.** `interruptRun(db, input, actor)` — `:1466-1552` — RBAC `run-agents` (admin|
maintainer, `app/shared/rbac.ts:75`). Idempotent (`already-terminal` outcome for a non-live run).
If a live handle exists, `handle.interrupt()` is called and the adapter's own `onExit` stamps
`interrupted`; if no handle exists (post-restart, or the run is still only `reserved`), the state is
written directly and, critically, `state.reserved.delete(runId)` releases a **reserved** run's slot
immediately (F28-R1, `:1525-1536`) — otherwise an interrupted-during-clone run would starve the cap
for up to the clone timeout.

**Boot-time recovery** (`app/server/runtimes/run-recovery.server.ts`), run from `boot.server.ts:614`:
- `finalizeOrphanedRuns(db)` (`:61-172`) — every `running`/`queued` row at boot has no live process
  behind it by definition; each becomes `error` (`interruptedBy: "restart"`), and the operator is
  re-invoked (`trigger: "manual"`) for each affected task, capped by a crash-loop backstop
  (`RECOVERY_REINVOKE_CAP = 3` per task per 30-minute window, `:19-20`, `:97-145`).
- `recoverUnreactedAgentRuns(db, ctx)` (`:202-337`) — replays a finished specialist/reviewer run's
  dropped completion callback (reply-post + operator react) when the in-process callback was lost to
  a restart between "finished" and "callback fires" (NFR17/B9), same crash-loop cap.
- A third arm (referenced at `:339+`, "stranded CODEX operator plans", P14-RT-08) recovers a
  finished Codex operator run whose structured plan never got executed because the process died
  between "run finished" and "plan applied".

### 1.2 Model / effort resolution and disclosure

`startRun` resolves the run's actual model via `foreignModelBackend` / `defaultModelFor`
(`model-catalog.server.ts`) — if a stored model id belongs to the *other* backend (e.g. a Codex
model id on a profile now running on Claude), it substitutes that backend's default **and writes a
disclosure line** as the first line of the run log (`MODEL_SUBSTITUTED_TAG = "run·model_substituted"`,
`run-service.server.ts:625`, `:660-684`) rather than silently mis-labeling the run (F21-13). Effort
is normalized per-backend the same way (`resolveRunEffort`, `:773-781`) so a Codex `"minimal"` tier
saved on a profile never reaches Claude's effort union.

### 1.3 Reads

`listRunsForTask` / `getRunLog` (`:1557-1630`) serve the task page's bounded, paginated view —
`RunLogWindow` bounds the initial ship to `RUN_LOG_WINDOW_LINES = 400` /
`RUN_LOG_WINDOW_BYTES = 384 KiB` (`run-projection.server.ts:62-63`), with backward `loadOlder()`
paging for history beyond that window (P13-D-11).

---

## 2. The two backends: Claude vs Codex

Both backends implement the same `RuntimeAdapter` interface (`app/server/runtimes/adapter.server.ts:234-238`):
`start(spec: RunSpec, cb: RunCallbacks): RunHandle`. `run-service.server.ts` is the **only** caller
of either adapter — from Viberr's perspective the two are meant to be interchangeable, and mostly
are, but there are real, documented asymmetries.

### 2.1 Claude (`claude-runtime.server.ts`)

- SDK: `@anthropic-ai/claude-agent-sdk`, `query()` → async generator of `SDKMessage` (`:17-35`).
- **Interrupt** uses `Query.interrupt()`, which only works in *streaming-input* mode — so every
  prompt is fed as a one-message async iterable (`singlePrompt`, `:337-344`), not a plain string.
- **Resume**: `options.resume = <session_id>`.
- **Autonomy**: `permissionMode: spec.autonomous ? "bypassPermissions" : "default"` (`:674`) — a
  server run is never left waiting on an interactive approval.
- **Tool confinement is real and structural**: `disallowedTools` (deny) always wins even under
  `bypassPermissions` (`:759-783`). Three deny lists compose per run kind:
  - `BASE_DENIED_BUILTINS` (`:264-298`) — every run, always: the whole `Task*`/subagent-spawn
    family (orchestration is the operator's job), `Skill` (unless the run mounted granted skills),
    Cron/Workflow/PushNotification/SendMessage/EnterWorktree/etc. — first-party SDK tools with no
    Codex analog or that bypass something Viberr already owns.
  - `OPERATOR_READ_ONLY_DENIED_TOOLS` (`:200-208`) — operator runs only: `Bash`, `Edit`,
    `MultiEdit`, `Write`, `NotebookEdit`. The **single source** for this list — it used to be
    duplicated in `operator-run.server.ts` as an unguarded second literal (F21-3).
  - `SUPPORTING_DENIED_BUILTINS` (`:223-236`) — `kind: "reviewer"` runs only: file-write built-ins
    plus `git commit`/`push`/branch-create/`gh pr create`/`gh pr merge` — a reviewer is physically
    unable to mutate the shared workspace or reach the remote (F10-12).
  - Plus the capability-derived `disallowedTools` from `resolveSpecialistDisallowedTools` (§4.3).
- **Skills**: native SDK mechanism. `settingSources: nativeSkills.length ? ["project"] : []` +
  `skills: [<granted names>]` (`:697-710`) — a run with no granted skills gets `settingSources: []`
  and the bare `Skill` tool denied (the SDK still compiles ~16 first-party skills into its binary
  regardless of `skills: []`, verified live — `:685-696`).
- **MCP**: `strictMcpConfig: true` (R18-3) — only servers Viberr explicitly passes in `mcpServers`
  reach the run; a repo's own `.mcp.json` / host user config / plugin MCP are ignored.
- **Credential (MCP)**: `resolveSpecialistMcpServersDetailed` injects the decrypted org-MCP token as
  `headers.Authorization` (HTTP) or `env.MCP_CREDENTIAL` (stdio) — real, because Claude's `env`
  merge is in-process (`specialist-mcp.server.ts:29-32`, `:206`).
- **Idle timeout**: 15 min default (`VIBERR_CLAUDE_IDLE_TIMEOUT_MS`, `:172-177`) — Claude had *no*
  timer at all before P13-RT-11; `maxTurns` bounds turn count, not wall-clock/idle time.
- **Turn cap**: `VIBERR_CLAUDE_MAX_TURNS`, default 2000 (`:455-460`) — a runaway guard, not a work
  budget (the old hard 50 cut off a real delivery at turn 51).
- **Governance/collaboration toolkit** (`viberr_agent` MCP, in-process): `post_comment`,
  `ask_human`, `report_outcome` — mounted for **every** Claude specialist/reviewer run whose
  profile holds the matching grant (`agent-toolkit.server.ts:45-69`); the operator's own equivalent
  toolkit is the separate `viberr` MCP server (§3.4).

### 2.2 Codex (`codex-runtime.server.ts`)

- SDK: `@openai/codex-sdk` v0.146.0 (pinned + tested, `:26-64`). `codex.startThread(...)` /
  `resumeThread(...)`, then `thread.runStreamed(prompt, { signal })` → async generator of
  `ThreadEvent`s.
- **Interrupt** uses a plain `AbortController` on `TurnOptions.signal`.
- **Resume**: `codex.resumeThread(sessionId, ...)`.
- **Sandbox, not a tool denylist**: `resolveCodexSandboxMode(spec)` (`:368-383`) picks
  `danger-full-access` only for a fully-autonomous **delivering** run with web egress intact;
  everything else (operator, reviewer, any egress-withheld run) gets `workspace-write`. **R22
  (owner ruling) removed the OS-level read-only sandbox** — "Viberr itself is the sandbox": the
  container plus the server-owned delivery gate (push/open-PR/merge/Done are all server actions no
  agent tool can reach) are the real boundary now. Consequence: **Claude enforces repo-write
  withholding via tool denylist (real); Codex's equivalent is advisory only** —
  `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` in `app/shared/capabilities.ts:270-283` names exactly this
  set (`execute-code-or-write-repo`, `create-task-branch`, `commit-push-branch`, `open-review-pr`,
  plus `comment-on-task` and `read-github-api`, which simply have no Codex tool at all).
- **No denylist channel of any kind** — Codex has no per-tool deny. Web-egress withholding is
  instead enforced via `threadOptions.webSearchMode = "disabled"` (`:721-728`), which **does** bind
  on both backends (`ENFORCED_CAPABILITY_IDS` includes `use-web-search-fetch`,
  `capabilities.ts:249-253`).
- **Skills**: the CLI's whole skills channel is severed outright (`skills.include_instructions:
  false`, `skills.bundled.enabled: false`, `codexConfigForRun`, `:293-306`) — verified the CLI
  re-installs 5 bundled `.system` skills into *any* home otherwise. Instead, granted skills/KB text
  ride the **prompt** as plain text (asymmetric by design vs Claude's native mount — documented, not
  hidden).
- **MCP config, not runtime tool policy**: `codexMcpServers` translates the portable HTTP/stdio
  declarations into `--config mcp_servers.*` TOML overrides. The CLI **merges** config into whatever
  `$CODEX_HOME/config.toml` already declares — it does not replace it — so isolation depends on
  giving every run an **app-owned `CODEX_HOME`** (`resolveCodexHome`/`prepareCodexHome`,
  `codex-config.server.ts`), never the operator's personal `~/.codex`.
- **Credential (MCP), deliberately NOT carried**: `specialist-mcp.server.ts` decrypts an org-MCP
  token for Claude but never for Codex — Codex passes config as `--config key=value` **argv**, which
  is visible in `ps auxww` on the host; a literal secret there is a real leak. So a credentialed org
  MCP **authenticates on Claude, connects unauthenticated on Codex** — an honest, disclosed
  limitation (`codex-runtime.server.ts:160-168`), not a silent drop.
- **Tool naming asymmetry (disclosed, unfixable here)**: the two CLIs derive different MCP tool
  prefixes from the same declared server name — Claude mounts `mcp__everything-http__echo`, Codex
  **lowercases hyphens to underscores**: `mcp__everything_http__echo` (`:141-148`). A
  persona/skill/directive that names a tool literally works on one backend and not the other; there
  is no fix inside Viberr (the transform is inside the Codex binary).
- **Structured output**: `outputSchema` (Codex-only channel) constrains the *final* reply to a JSON
  shape — used both for the operator's decision plan (§3) and for every specialist/reviewer's
  `report_outcome` envelope (§5.3), because Codex has no in-process tool-call channel to stage an
  envelope mid-run the way Claude's `report_outcome` tool does.
- **Idle timeout**: same 15 min default, `VIBERR_CODEX_IDLE_TIMEOUT_MS` (`:388-392`).
- **Env replacement**: the Codex SDK replaces the child env wholesale — `shell_environment_policy:
  {inherit: "core", set: {...}}` (`:274-280`) is the *only* channel that reaches the model's own
  shell commands (distinct from the CLI's own process env, which carries subscription auth). Per-run
  git identity (`GIT_AUTHOR_NAME` etc.) must be threaded through this table explicitly — it does
  **not** automatically follow from `spec.env` the way it does on Claude (P13-RT-10 gotcha, see §7).

### 2.3 Uniformity summary

| Aspect | Claude | Codex |
|---|---|---|
| Tool restriction | Real deny-list, binds under bypass | No deny channel; sandbox mode only |
| Repo-write withholding | Enforced (tool denylist) | **Advisory only** since R22 |
| Web-egress withholding | Enforced (WebFetch/WebSearch denied) | Enforced (`webSearchMode: disabled`) |
| Skills | Native mount, per-skill filter | Prompt-text injection; native channel severed |
| Org-MCP credential | Real (header/env) | **Never sent** (argv-leak risk) |
| MCP tool prefix | `mcp__name__tool` | `mcp__name_with_underscores__tool` |
| Collaboration toolkit | In-process MCP tool calls, mid-run | `outputSchema` on final reply only |
| Verdict/outcome transport | `report_outcome` tool (staged) | `outputSchema`-constrained JSON |
| Governance for the operator | Live tool calls | Structured plan, executed server-side after the run |
| Idle timeout | 15 min (env-overridable) | 15 min (env-overridable) |
| Turn cap | 2000 (env-overridable) | none (Codex has no turn concept) |

So: **not uniform**, deliberately and disclosedly. The product's stance (per code comments) is that
the *server-owned* boundary (single-flight delivery, the delivery gate, ALWAYS_HUMAN capabilities)
is the real enforcement layer that both backends share; Claude's tool denylist is a second,
stronger layer that Codex cannot offer since R22 removed its OS sandbox.

---

## 3. The operator

### 3.1 What triggers an operator run

Single entry point: `runOperator(db, input: RunOperatorInput)` —
`app/server/runtimes/operator-run.server.ts:1135`. `input.trigger` is one of `create | transition |
agent-reply | goal-updated | pr-diverged | delivered | packet-resolved | scheduled | manual`
(`:161-170`, each documented inline with exactly what it should do — "COORDINATE" vs "REACT" vs
"RE-CHECK" vs "RECOVER" vs "PROCEED").

| Trigger | Fired from | Cause |
|---|---|---|
| `create` | `task-actions.server.ts:532` | Task created |
| `goal-updated` | `task-actions.server.ts:611` | Goal edited |
| `transition` | `task-actions.server.ts:4252` | Stage moved |
| `delivered` | `task-actions.server.ts:4787` | Full-autonomy operator just opened a **new** review PR |
| `packet-resolved` | `task-actions.server.ts:6131` | Human resolved a decision packet |
| `pr-diverged` | `github-reconciler.server.ts:751-757` | GitHub PR closed/merged/reopened out-of-band |
| `agent-reply` | `task-actions.server.ts:3455-3471` | A prompted agent's run just finished (the "react" loop) |
| `manual` | `task-actions.server.ts:1359-1369` (`@operator` comment), the Run-operator button, `run-recovery.server.ts:152` (crash recovery) | Human or recovery |
| `scheduled` | `schedule.server.ts:481` | A human-scheduled re-run fired |

Refusals baked into `runOperator` itself: a `scheduled` trigger on a terminal stage is refused
(`refused: "terminal-stage"`, F19-20); a `manual` trigger while a decision packet is open is refused
(`refused: "open-packet"`, R20-1) — machine triggers are exempt (a `pr-diverged` recovery may need
to withdraw the very packet that's open). Concurrency is one drive per task at a time via a
process-local lease plus a DB single-flight backstop; concurrent triggers coalesce (machine triggers
= newest wins, human triggers = queued oldest-first).

### 3.2 What the operator reads before deciding

- **`get_task` tool** → `operatorSnapshot` (`operator-actions.server.ts`, interface
  `OperatorTaskSnapshot`) — stage/readiness/waiting, goal, owner, the delivering engagement +
  reviewers with their own verdicts, allowed `nextStages`, **`deployedSpecialists[]`** (each with
  `desc`, resolved `capabilities: {delivery, verdict, askHuman, browser, web}`, and
  `eligibleForCurrentStage`), any open decision packet, recent timeline, the review `pr` (state +
  `revisionDrift`), `branch`/`repo`, `noChanges`, and its **own** `operatorPolicy` + autonomy. The
  tool description explicitly warns the two capability scopes are not interchangeable ("never quote
  a row of yours as evidence about an agent").
- **A real, read-only repo checkout**, provisioned once per drive by `ensureOperatorRepoCheckout`
  (`operator-run.server.ts:1027`, R19-1 ruling) — before this the operator reasoned about a repo it
  had never seen.
- **`read_default_branch_file` tool** (`operator-toolkit.server.ts:290-332`, backed by
  `operator-repo-read.server.ts`) — reads a path from the project's **bare mirror** default branch
  via `git show <ref>:<path>`, distinct from the working checkout (which may already be on the task
  branch).
- **Its own persona**: `readOperatorDefinition` (`definitions/operator.md`, overridable per-project
  by `definition.persona`) plus a Viberr app-expertise skill, and any granted skills/KB/org MCPs from
  its own deployment's `resources`.

### 3.3 How the operator selects a worker profile

**This is an LLM decision, not a scoring/matching algorithm.** There is no ranking function
anywhere in the codebase. The `get_task` tool's own description instructs the model directly:
*"SELECT agents by each profile's `desc` (its purpose) and `capabilities` … never by guessing from
names"* (`operator-toolkit.server.ts:265`). The `engage_agent` tool takes a bare `profileId` string
(`:545`: *"The agent profile id to engage (from get_task's deployedSpecialists)"*) — the model reads
the roster's `desc` + capability flags and picks by reasoning over free text, then calls the tool
with its choice. `run_agent` and `prompt_agent` (`:565-612`) work the same way; `prompt_agent` is the
combined "engage (if needed) → post an addressed prompt comment → start the run with that prompt as
directive" convenience the operator uses when a stage needs an agent moving.

What **is** deterministic around that free-form choice:
- **Stage eligibility** is a hard gate: `assertStageEligible` (`specialist-run.server.ts:694-698`,
  `:853-857`) throws if the operator (or a human) tries to engage/run a profile whose declared
  `stages`/`spanAll` doesn't cover the task's current stage.
- **Capability gates on the operator's own tools** decide whether `engage_agent`/`run_agent`/
  `prompt_agent` even exist in its toolkit at all (`assign-primary-specialist` /
  `summon-reviewers`), and whether the chosen action executes directly or is downgraded to a
  recommendation card (see §3.5 — this is the autonomy ceiling, applied uniformly to every operator
  action, not just agent selection).

### 3.4 Operator toolkit — exact tool list

In-process MCP server named **`viberr`** (`operator-toolkit.server.ts:698`), Claude Agent SDK
`createSdkMcpServer`, offered conditionally per capability gate:

| Tool | Gate (`gate(authority, id)`) | Line |
|---|---|---|
| `get_task` | always available (read-only) | `:264` |
| `read_default_branch_file` | only when a workspace checkout exists | `:292` |
| `post_comment`, `set_goal`, `flag_context_conflict` | `append-typed-events` | `:346`, `:358`, `:376` |
| `open_decision_packet`, `resolve_decision_packet` | `generate-packets` | `:416`, `:514` |
| `engage_agent`, `run_agent`, `prompt_agent` | `assign-primary-specialist` **or** `summon-reviewers` | `:542`, `:567`, `:585` |
| `deliver_for_review` | `deliver-review-pr` (absent = granted, R15-2) | `:621` |
| `update_branch_from_base` | `update-task-branch` | `:647` |
| `transition_stage` | `stage-transitions` | `:662` |
| `accept_completion` | `completion-for-acceptance` | `:687` |

`allowedTools` here is an **auto-approve list, not a restriction** (P14-KM-12) — real confinement is
that an ungranted tool is simply never *built* into the toolkit, plus the Claude
`OPERATOR_READ_ONLY_DENIED_TOOLS` deny-list (§2.1) that stops the operator from using ordinary
coding built-ins regardless.

**Codex parity**: `operatorPlanToolsFor` filters `OPERATOR_PLAN_TOOLS` by the exact same gates,
`buildOperatorPlanSchema` builds a structured-output JSON schema mirroring the tool set, and
`executeCodexPlan` (`operator-run.server.ts:1935`) runs the emitted plan through the **identical**
gated `operator-actions.server.ts` functions the Claude tool calls use — so both backends honor the
same RBAC and autonomy; Codex just plans-then-executes in one shot instead of calling tools live
mid-run (`:112-129`).

### 3.5 Packet/decision generation and the autonomy ceiling

**How decisions get written**: every operator write funnels through `updateTaskFile` (file-lock
protected) → `reproject` → `recordAudit`. The three shapes:
- **Comments** — `writeOperatorComment` (`operator-actions.server.ts:548`): runs the same anti-noise
  guardrails as human/agent comments (§6.2), writes a `comment` timeline event.
- **Recommendation cards** (what a *supervised* operator does instead of acting directly) —
  `addRecommendation` (`:701`): pushes a `Recommendation`, sets `waiting: "human"`.
- **Decision/blocking packets** — `operatorOpenPacket` (`:878`): one open packet at a time
  (`:923-930` refuses a second); `packetType: "blocked"` also sets `readiness: "blocked"`. Wrapped by
  `operatorOpenPacketDisclosed` (`operator-toolkit.server.ts:229`) which appends a disclosure when
  the packet follows a `prompt_agent` delegation earlier in the same turn (ruling 84/R20-9 — "never
  hide that you asked an agent before escalating to a human").

**The gate mechanism** — `gate(authority: OperatorAuthority, capabilityId: string): Gate` where
`Gate = "deny" | "recommend" | "direct"` (`operator-actions.server.ts:448-468`):
```
no operator deployed              → "deny"
mode === "direct"                 → "direct"
mode === "recommend"              → "recommend" under supervised autonomy,
                                     promoted to "direct" under FULL autonomy —
                                     EXCEPT "completion-for-acceptance", which
                                     stays "recommend" unless EXPLICITLY "direct"
                                     (owner ruling Q1: full autonomy alone must
                                     never silently auto-close a task to Done)
mode === "human" | "off"          → "deny"
```
This one function is what turns a capability grant + the project's `autonomy: "supervised" | "full"`
setting (`project-file.schema.ts:106`) into "operator does it itself" vs "operator posts a card" vs
"operator can't even try." It is applied uniformly to every operator action — agent
engagement/dispatch, packet generation, stage transitions, delivery, branch updates, and acceptance
alike.

**Autonomy ceiling — what the operator can never do itself.** `ALWAYS_HUMAN_CAPABILITY_IDS`
(`app/shared/capabilities.ts:211-215`): `merge-pull-request`, `transition-to-done`,
`change-project-policy` — mode `"human"`, `promotable: false`, enforced on **both** backends
(`capabilityEnforcement()` returns `"both"`, `:288-296`). These are *agent*-kind capabilities: no
specialist/reviewer profile can ever hold them in an actionable mode, period — enforced redundantly
at the tool-denylist layer (`specialist-tool-policy.ts:47,137`), the profile-editor save path
(server-side coercion back to `human` regardless of what's submitted), and the Policy page render.

The operator itself has a **separate**, operator-kind capability, `completion-for-acceptance`, which
*is* the one deliberate exception to "a task only reaches Done by human action" (owner ruling Q1):
under `autonomy: "full"` **and** an explicit `direct` grant, `operatorAcceptCompletion`
(`operator-actions.server.ts:2806`) moves the task to its terminal stage itself. But the
ALWAYS_HUMAN **merge** invariant holds absolutely even here: `operatorAcceptCompletion` never calls
the real GitHub merge — it stamps `prState: "accepted"` (never `"merged"`) and leaves the PR
"merge pending" for a human, because `mergeTaskPr` (`github-reconciler.server.ts`) **requires a
non-null `actor.userId`** in its own type signature — there is no code path by which an
agent/operator actor can satisfy it. A background poller
(`nudgeMergePendingTasks`, `reconcile-poller.server.ts:58`) nags project watchers about the dangling
merge until a human finishes it (via the "Complete merge" button or on GitHub directly).

> **Flagged inconsistency**: the `accept_completion` tool's own description, which the operator LLM
> reads and may repeat back to a human, says *"the real merge is completed when GitHub is
> reachable, otherwise it is left 'merge pending'"* (`operator-toolkit.server.ts:688`). Per the code
> above, the **operator's** full-autonomy accept path never attempts a real merge under any
> condition — that sentence is only true of the separate *human* acceptance path
> (`attemptAcceptanceMerge`, `task-actions.server.ts`). A model could narrate "I merged it" (or
> promise the merge will happen automatically) when it never will, without a human completing it.

### 3.6 Operator backend

Configurable per project deployment, overridable per run. `deploymentBackend()`
(`operator-actions.server.ts:304-308`) reads the first backend in the operator's deployment
`backends[]` (default `claude`); `RunOperatorInput.backend` can override it for one turn (e.g. a
manual retry). `runOperator` dispatches on it directly:
`backend === "codex" ? startCodexOperatorRun(...) : startRealOperatorRun(...)`
(`operator-run.server.ts:1382-1384`). Per-run autonomy overrides are clamped to the project's
configured ceiling and audited when the clamp actually bites (R19-A).

---

## 4. Engagements, profiles, and capabilities

### 4.1 The three layers of the data model

1. **Org-level profile (template)** — `agentProfileFrontmatterSchema`
   (`app/server/files/agent-profile-file.server.ts:27-68`): `id`, `kind: "operator"|"specialist"`,
   `name`, `role`, `desc` (the short text the operator selects by), `backends: ("codex"|"claude")[]`,
   `model`, `stages[]`/`spanAll`, `capabilities: {capabilityId, mode}[]`, `resources:
   {skills[], mcps[], kb[]}`. Markdown body = the long persona.
2. **Project-level deployment** — `agentDeploymentSchema`
   (`app/schemas/project-file.schema.ts:128-142`): `profileId`, its own `capabilities:
   CapabilityGrant[]` (`:69-76`, `{capabilityId, mode}` — this is the **live, per-project policy**
   that actually governs runs), optional `definition` override (`.loose()`, can override almost any
   template field including `autonomy: "supervised"|"full"` for an operator deployment).
3. **Task-level engagement** — `engagementSchema` (`app/schemas/task-file.schema.ts:184-207`):
   ```ts
   {
     profileId: string;
     backend: "codex" | "claude";
     role: string;                    // display snapshot at engage time
     delivers: boolean;                // exactly one true per task
     verdictCapable: boolean;          // ENGAGE-TIME snapshot (§4.5)
     pinnedBackend?: "codex"|"claude"|null;   // §4.6
   }
   ```

`CapabilityMode = "direct" | "recommend" | "human" | "off"`
(`project-file.schema.ts:35-36`). For a **specialist**, `recommend` is coerced down to `off`
wherever it is read or written (`coerceSpecialistCapabilityMode`,
`app/shared/capabilities.ts:362-366`) — `recommend` is an operator-only concept with no agent
runtime meaning (F20-21/R20-6).

### 4.2 Full capability catalog

Single source of truth: `UNIFIED_CAP_CATALOG`, `app/shared/capabilities.ts:33-154`.

**Operator coordination:**

| id | label | default | gates |
|---|---|---|---|
| `assign-primary-specialist` | Assign the delivering agent | direct | `engage_agent`/`prompt_agent` with `delivers:true` |
| `summon-reviewers` | Summon reviewer specialists | direct | supporting engagements |
| `generate-packets` | Generate decision & blocking packets | direct | `open_decision_packet`/`resolve_decision_packet` |
| `append-typed-events` | Append typed important events | direct | `post_comment`/`set_goal`/`flag_context_conflict` |
| `stage-transitions` | Stage transitions | **recommend**, non-promotable | `transition_stage` |
| `completion-for-acceptance` | Accept completion into Done | **recommend**, non-promotable | `accept_completion` — the sole full-autonomy Done exception |
| `deliver-review-pr` | Deliver the branch & open the review PR | direct (absent = granted) | `deliver_for_review` |
| `update-task-branch` | Bring the task branch up to date | direct (absent follows delivery gate) | `update_branch_from_base` |

**Agent repo/execution (Claude tool-denylist, advisory-only on Codex since R22):**

| id | label | default | Claude deny |
|---|---|---|---|
| `execute-code-or-write-repo` | Execute code or write to the repo | direct | `Edit`/`MultiEdit`/`Write`/`NotebookEdit`/`git commit` — the headline grant |
| `create-task-branch` | Create the task-key branch | direct | `git checkout -b/-B`, `git switch -c/-C` |
| `commit-push-branch` | Commit & push to the branch | direct | `git push`, `git commit` |
| `open-review-pr` | Open the review pull request | direct | `gh pr create` |

**Agent collaboration:**

| id | label | default | notes |
|---|---|---|---|
| `comment-on-task` | Post mid-run comments | direct | Claude-only tool (`post_comment`); Codex final reply always posts regardless |
| `ask-human` | Ask the human a question | direct | gates `ask_human` |
| `use-web-search-fetch` | Search & fetch from the web | direct | both backends enforce (WebFetch/WebSearch deny · `webSearchMode:"disabled"`) |
| `use-browser` | Drive a live web browser | **off** | mounts/withholds the `viberr_browser` Playwright MCP entirely; requires effective `use-web-search-fetch` too |
| `read-github-api` | Read GitHub repository & PR data | **off**, non-promotable | Claude-only in-process tool; PAT never crosses to the agent |
| `report-validation-verdict` | Report a validation verdict | **off** | gates verdict recording + required-reviewer status (§5) |
| `attach-evidence-references` | Attach evidence references | direct | gates the `evidence` field on `report_outcome` |

**Advisory / matrix-only** (`group: null`, no runtime consumer, agent-kind): `run-unit-integration-validation`,
`move-task-to-review`, `read-repo-diff`, `run-validation-suites`, `post-quality-flags`,
`approve-review`, `request-changes`, `author-test-cases`, `read-task-repo`,
`flag-underspecified-tasks`.

**Always-human (structural, agent-kind, mode `"human"`, non-promotable):** `merge-pull-request`,
`transition-to-done`, `change-project-policy` — see §3.5.

`GRANT_REQUIRED_CAPABILITY_IDS` (`capabilities.ts:393-400`) is the polarity switch: for
`execute-code-or-write-repo`, `create-task-branch`, `commit-push-branch`, `open-review-pr`,
`merge-pull-request`, `report-validation-verdict` — **absence means withheld**. Every other
capability (notably `use-web-search-fetch`) is permissive-by-default: an absent grant leaves it
granted. This polarity fix (P14-LV-01) closed a real hole: a hand-authored/imported profile with
`capabilities: []` used to read as "full repo-write + both verdict outcomes", not "nothing granted"
(live proof cited in `specialist-tool-policy.ts:33-40`: the seeded `org-docs-writer` template).

### 4.3 Grants → runtime toolkit: the resolver functions

- **`specialistGrantModes(grants)`** — `app/server/tasks/specialist-tool-policy.ts:119-131` — the
  canonical grants→mode map. Repairs *only* an absent `execute-code-or-write-repo` headline when a
  scoped delivery grant (branch/push/PR) is actionable; an **explicit** `off` headline is never
  overturned.
- **`resolveSpecialistDisallowedTools(grants)`** — `:147-158` — walks `CAP_DENY_RULES` (`:49-97`)
  against `isWithheld()` (`:133-141`) to build the Claude `disallowedTools` array passed into
  `RunSpec.disallowedTools`.
- **`resolveDeliveryPermissions(grants)`** — `:190-209` — the **prompt-facing mirror**
  (`{canBranch, canCommitPush, canOpenPr}`) so the run's own instructions never contradict what the
  tool layer denies (fixes XS-4: the agent used to be told "commit and push" while the tool layer
  silently blocked it, producing a confused "blocked commit" report).
- **`resolveAgentCollab(grants)` / `effectiveCollabMode(grants, id)`** —
  `app/server/tasks/agent-outcome.server.ts:381-419` — the permissive-default resolver for
  `comment`/`ask`/`verdict`/`evidence`/`githubRead`.
- **`resolveBrowserMcp(...)`** — `app/server/tasks/specialist-browser-mcp.server.ts` — mounts the
  browser MCP only when `use-browser` is explicit `direct` **and** effective `use-web-search-fetch`
  is also `direct` (a revoked egress grant cannot be re-acquired one row down via the browser).
- `run-service.server.ts`'s `repoWriteWithheldFromDenylist` / `webSearchWithheldFromDenylist`
  (`:540-563`) then **derive** `spec.repoWriteWithheld` / `spec.webSearchWithheld` from the same
  `disallowedTools` array — one source of truth feeding both the Claude deny-list and the Codex
  sandbox-mode/`webSearchMode` decision, so the two backends cannot silently drift on what a grant
  means (P13-RT-02).

### 4.4 Scoped vs full repo-write — the display/runtime divergence is fixed

"Scoped" = the three fine-grained delivery grants held individually
(`SCOPED_DELIVERY_CAPABILITY_IDS`, `capabilities.ts:371-375`: `create-task-branch`,
`commit-push-branch`, `open-review-pr`). "Full"/headline = `execute-code-or-write-repo` itself,
which additionally gates the file-write tools and `git commit`. The historical F27-L2 bug (capability
matrix showed "Not granted" for repo-write while the runtime actually granted it via the scoped
grants) is **fixed in current code**: the capability-matrix display
(`app/features/agents/agents-query.server.ts` — routes through `specialistGrantModes()`, the exact
function the runtime enforcement uses) and the save-time repair (`repairDeliveryGrants`,
`app/shared/capabilities.ts:449-499`, which materializes the headline `direct` when scoped grants
are actionable and the headline was never explicitly set) both consult the same resolver now — no
second source of truth to drift.

### 4.5 `verdictCapable`

Set **once, at engage time**, as a snapshot of whether the profile held an *explicit*
`report-validation-verdict: direct` grant (`resolveAgentCollab(specialist.capabilities).verdict`,
`specialist-run.server.ts:755` for the delivering engagement, `:888` for a reviewer). Deliberately
explicit-only (F10-14): a supporting engagement with no explicit grant is **not** an implicit
reviewer. `requiredReviewers(fm)` (`app/schemas/task-file.schema.ts:672-675`) filters engagements to
`!delivers && verdictCapable` — this is the set whose approval the acceptance gate (§5) waits on.
Verdict **recording** deliberately reads this same engagement-time snapshot rather than a fresh live
grant lookup (`task-actions.server.ts:2988-3005`) — a required reviewer whose live grant is later
revoked can still have its verdict recorded (an intentional, audited trade-off: see §7 for the
stranding edge case this creates).

### 4.6 `pinnedBackend` (per-engagement)

Set only by a deliberate `retry_other_backend` recovery after a quota/auth/unavailable failure —
never by a plain profile edit. Resolution priority is stated identically in three places
(`specialist-run.server.ts:1173-1182`, `task-actions.server.ts:3271-3273`,
`agent-reply.server.ts:337-338`):

```
backendOverride (an explicit D4 retry-this-run override)
  ?? engagement.pinnedBackend (a prior retry that STICKS, F27-B1)
  ?? resolvedLiveDeployment.backend (the profile's CURRENT backend)
  ?? engagement.backend (the engage-time snapshot, for an undeployed profile)
```

So a plain admin edit to a profile's backend still takes effect on the very next run (the pin is
`null`/absent by default) — but once a retry pins a backend, every later dispatch of **that
engagement** (operator prompt, `@agent` generic resume, by-name `@profile-name` mention) follows the
pin instead of reverting, confirmed threaded through display surfaces too
(`app/shared/mapping/task.server.ts:374,403`, `app/server/projections/agent-deployments.server.ts:110`).
A user's explicit `@claude`/`@codex` handle in a comment still overrides the pin — the pin only
resolves an *unqualified* mention/prompt.

---

## 5. Reviewer model

### 5.1 Engaging a reviewer / what triggers a review run

There is **no mechanical "PR opened → auto-review" hook**. Engaging and dispatching a reviewer are
**operator decisions**, gated by `summon-reviewers`, through three entry points in
`operator-actions.server.ts`: `operatorAssignReviewer` (engage only, idempotent),
`operatorRunReviewer` (start its run), and `operatorPromptReviewer` (engage-then-prompt-then-run in
one call — its own docstring: *"Used when a task reaches the review stage"*). Mechanically,
`assignReviewer` (`specialist-run.server.ts:831-948`) appends an `Engagement` with `delivers:
false` and the `verdictCapable` snapshot (§4.5), and immediately recomputes
`frontmatter.validation = deriveValidation(...)` so the required-reviewer set never goes stale
(UX19-3).

### 5.2 `workRevision` — revision-bound review

`workRevisionSchema` (`app/schemas/task-file.schema.ts:523-548`) mints an immutable `{id, headSha,
treeSha, branch, createdAt, sourceProfileId, kind: "delivered"|"verified"}` **every time delivered
work changes** (a new commit head/tree). `reviewVerdictSchema` (`:553-566`) binds a verdict to
`revisionId`, not to the task generally. `currentVerdicts(fm)` (`:676-684`) filters
`fm.verdicts` to `v.revisionId === fm.workRevision.id` — a verdict on an old revision is simply
excluded from every later derivation, automatically, with **no comment/stage-bounce heuristic**
(this replaced the old F10-32 heuristic entirely). Old verdict rows are kept (historical record),
just no longer counted.

`deriveValidation(fm)` (`:690-741`) is the **single writer** of the derived `validation` cache:
`failing` if any required reviewer requested changes on the current revision; `healthy` if every
required reviewer approved it; `bypassed` if a human force-accepted past the gate
(N20-14/§5c); `none` before any delivery (or a verified no-change completion with no required
reviewers); `changed` otherwise (revision under review, verdicts pending).

**Verdict with nothing to bind to**: if a verdict-capable non-delivering agent approves before any
delivery exists, `task-actions.server.ts` runs a live `probeNothingToDeliver` check and, if
confirmed, mints a synthetic `workRevision` of `kind: "verified"` pinned to the base branch's head —
so the verdict has something real to bind to (R19-8/F19-21, fixing a dead-end where a task with
nothing to deliver could never satisfy the review gate at all).

### 5.3 Verdict schema and transport

Values: `"approve" | "request_changes"` only (`REVIEW_VERDICT_RESULTS`,
`task-file.schema.ts:550`) — no separate "reject"; a PR closed unmerged on GitHub is a distinct,
terminal fact tracked via `pr.state`, not a verdict value (R16-3: "outranks every process gate").

`AgentOutcome` (`agent-outcome.server.ts:46-56`) is the uniform envelope: `{summary?, verdict?,
question?, evidence?}`. Two transports:
- **Claude**: the in-process `report_outcome` toolkit tool stages the envelope mid-run
  (`stageOutcome`/`takeStagedOutcome`, backed by an in-memory map **and** the `staged_outcomes`
  table for restart-safety).
- **Codex**: `outputSchema = AGENT_OUTCOME_JSON_SCHEMA` (`:68-130`) constrains the *final* reply —
  every property must appear in `required` with optional fields expressed as nullable (OpenAI's
  strict structured-output rule); `parseAgentOutcomeJson` tolerantly parses it back, stripping a
  code fence if present.

Fallback: an agent with the verdict grant that emits no envelope verdict falls back to
`classifyReviewerVerdict`'s prose regex (`task-actions.server.ts:2326-2344`) — gated on
`verdictAuthorized`, never run for an ungranted agent. A documented Codex-only asymmetry: Codex's
`outputSchema` has no per-agent conditional, so it can technically emit a `verdict` even without the
grant — the completion pipeline explicitly **discards** an ungranted Codex verdict server-side and
logs it (`task-actions.server.ts:~3035-3049`); Claude has no equivalent gap since the tool itself
isn't mounted when ungranted.

### 5.4 Human GitHub approval as verdict (R19-B)

`app/server/github/pr-human-approval.server.ts` implements this, confirmed live in current code:
- `humanVerdictApproval(fm)` re-checks the approval's `commit_id` against the current
  `workRevision.headSha` **on every read**, not from when it was recorded — a re-delivery
  invalidates it instantly.
- The approver must resolve to a Viberr project member via `users.github_handle`.
- Fails **closed**: an approval that can't be confidently mapped (no linked handle, ambiguous,
  non-member) does not count, and the reason is surfaced rather than silent.
- `verdictGateReason` (`:306-360`) is the **one** shared R15-1 gate consulted by both the runtime
  acceptance path and the projection — it clears on `validation ∈ {healthy, failing}` **or** a
  qualifying human approval, closing the asymmetry that a human's *disapproval* (closing the PR)
  already bound the gate while their *approval* used to be inert ("a status pill, not the merge
  gate").

### 5.5 Merge / acceptance — human-only, triple-enforced

The real merge, `mergeTaskPr` (`github-reconciler.server.ts`, `PUT
/repos/{repo}/pulls/{n}/merge`), takes an `actor: AuditActor & {userId: string}` — `userId` is
**required by the type itself**, not optional. Its only caller,
`attemptAcceptanceMerge`(`task-actions.server.ts`), refuses before even importing the merge module
when `!actor.userId`. Combined with `ALWAYS_HUMAN_CAPABILITY_IDS` (tool-layer deny) and the
profile-editor's server-side coercion (§3.5/§4.2), merge is refused at **three independent layers** —
capability policy, a hard type constraint on the merge function, and the tool denylist. An operator
under full autonomy can move a task to Done (`completion-for-acceptance`, the one exception), but
that path stamps `prState: "accepted"`, never `"merged"` — a background poller reminds a human the
merge is still pending.

---

## 6. Notifications, guardrails, and run output/log UI surfacing

### 6.1 Notifications — event-driven, one standing "rule": per-user category toggles

`NOTIFICATION_KINDS` (`app/shared/mapping/notification.server.ts:17-24`) is a fixed, closed catalog:
`packet | approval | mention | quality | policy`. There is **no** "run finished"/"run failed" kind —
a run's completion surfaces live via SSE (`run.state-changed`) to whoever has the task page open;
someone not watching gets no async notification unless the run's outcome also produces a
`quality`/`packet`/`mention` event. Single insert funnel: `createNotification`
(`app/server/projections/notifications.server.ts:54-95`), gated by
`isNotifKindEnabled(db, userId, kind)` — opt-out model (default ON; a prefs-read failure also
defaults to delivering, never silently drops a governance notification). This per-user,
per-category toggle is the **only** standing-rule concept — no filters, forwarding rules, or
digests.

Fan-out mechanisms:
- **@mentions** (`app/server/tasks/mention-notify.server.ts`) — a priority ladder (exact email
  local-part → exact full name → unique first name); a genuine tie routes to **nobody** rather than
  guessing, disclosed on the timeline for machine authors (who can't retag themselves) via
  `withAmbiguityDisclosure`. Reserved handles (`agent|operator|codex|claude`) never route to a
  person.
- **Task-watcher fan-out** (`notifyTaskWatchers`, `app/server/tasks/task-mutation.server.ts:144-206`)
  — every admin/maintainer project member + the task owner, minus an optional excluded actor. Fails
  **open** on a recipient-resolution error (logs + returns `[]`) rather than blocking the mutation
  that already committed (C10.1).
- **Decision inbox** (`decisionsRequiring`/`indexDecisionInbox`,
  `notifications.server.ts:147-175`) — the "waiting on you" read model shared by the inbox and Home
  cards; deliberately excludes the org-admin override bucket from a personal "mine" count.
- Read-state is monotonic (no mark-unread); `markTaskNotificationsSeen` is gated on a genuine
  top-level navigation (`Sec-Fetch-Mode: navigate`), not a background revalidation — fixes F20-11,
  where a backgrounded tab's revalidation used to silently mark "Blocked" packets as seen.

### 6.2 Comment guardrails (`app/server/tasks/comment-guardrails.server.ts`)

Three real, non-decorative, project-configurable guardrails (owner ruling Q3):
1. **`meaningful-comment`** → `isMeaninglessComment` — drops trivial chatter ("ok", "done", "👍",
   "+1", etc., under 60 chars) before it reaches the timeline.
2. **`operator-brevity`** → `enforceOperatorBrevity` — hard caps operator narration at
   `OPERATOR_BREVITY_MAX_CHARS = 1000`, closing an unbalanced code fence at the truncation point so
   the trim marker never renders as code.
3. **`evidence-separation`** → `separateEvidence` — replaces fenced blocks longer than
   `EVIDENCE_MAX_FENCE_LINES = 12` lines with a 3-line head + "N more lines in the agent logs" —
   full output stays only in the run transcript.

`applyCommentGuardrails` runs them in order (meaningless-check first) and returns an honest
`CommentGuardrailResult` so a model is never told "posted" when its comment was dropped or deduped —
a documented fixed bug (B-FD8). Subtlety: the **@mention fan-out runs on the pre-trim text**
(B-FD8b) so a handle sitting past the brevity cutoff still notifies even though it won't appear in
the persisted (trimmed) comment — deliberate, but an easy footgun for a future caller.

### 6.3 Run output pipeline: adapter → wire-format → sink → SSE → UI

1. **Adapter** drives `onPhase(phase, step)` with the shared vocabulary
   `RUN_PHASE = {preparing, starting, working, finishing}` (`adapter.server.ts:185-190`) — identical
   on both backends so the live strip reads the same regardless of which one ran. `preparing` is
   emitted by the **pipeline itself**, before any adapter exists, to cover a multi-minute cold clone.
2. **Wire-format** (`wire-format.server.ts`) — `projectEnvelope(backend, raw, occurredAt)` is the
   **only** JSON-decoding boundary for provider envelopes; every field carries a zod `.catch()`
   fallback so a newer SDK's added field/type never throws — an unrecognized envelope renders as a
   raw `meta` line rather than being dropped.
3. **Run sink** (`run-sink.server.ts`) persists (raw `.jsonl` append, `run_log_lines` DB row, folded
   usage facts) **then** publishes `run.log-appended` — never the reverse.
4. **SSE broker** (`app/server/events/sse-broker.server.ts`) — in-process pub/sub with per-connection
   scope filtering (`project:<slug>`, `task:<slug>/<key>`, `projects` firehose, `user`) and a
   256-event ring buffer for reconnect replay; `run.log-appended`/`run.state-changed` publish
   **directly** to the broker (`run-events.server.ts`), bypassing the general projection-event
   emitter (which would imply a full projection rebuild per line — wrong for a chatty stream).
5. **Client** (`app/features/runtime/use-run-log-stream.ts`) opens its **own** dedicated
   `EventSource` per task scope rather than going through the generic `useLiveUpdates` revalidation
   (which would refetch the whole task loader per log line). On `run.log-appended` it fetches only
   the delta since its tracked cursor; on `run.state-changed` it revalidates the loader once
   (lifecycle stays loader-owned). A 20s safety-interval revalidation self-heals a missed terminal
   event while any run is shown active (F22).

### 6.4 Raw vs. display; disk vs. DB

- **DB**: `run_log_lines` stores both `raw_json` and `display_json` per `(run_id, seq)`.
- **Disk (canonical truth)**: an append-only `.jsonl` per run at
  `${VIBERR_DATA_ROOT}/runtimes/<backend>/<runId>.jsonl` — explicitly the fallback of record: if the
  DB write fails or the DB drains mid-run (graceful shutdown), "the raw `.jsonl` still holds the
  full stream" and boot finalization recovers the run's terminal state.
- **Provider session transcripts** are a *third*, separate thing: Claude's own
  `$CLAUDE_CONFIG_DIR/projects/.../<sid>.jsonl`, Codex's own
  `<codex run home>/sessions/YYYY/MM/DD/rollout-....jsonl` — used only for the session-export/resume
  probe (§7), not Viberr's own truth file.
- **Loader windowing**: `RUN_LOG_WINDOW_LINES = 400` / `RUN_LOG_WINDOW_BYTES = 384 KiB`
  (`run-projection.server.ts:62-63`) bounds what a task-detail load ships; a measured 420-line task
  was ~928 KB and was being re-shipped whole on every revalidation before this. Older history pages
  backward via `loadOlder()`, never truncated permanently.

---

## 7. GOTCHAS & INVARIANTS

Rules an implementer must not break, each with the failure mode it prevents.

1. **Reserved runs count against the concurrency cap.** `liveCount = handles.size + reserved.size`
   (`run-service.server.ts:1236-1238`). A reservation is granted **under** the cap
   (`reserveRun`, `:419-421`) and released only on adoption (`startRun`, moves reserved→handles
   atomically) or `.abandon()`/interrupt (`:1525-1536`). **Do not** compute "live runs" from
   `handles.size` alone — before this fix (F26-1), every specialist dispatch (which always reserves)
   bypassed the cap entirely during its multi-minute clone window.

2. **A run's first terminal state wins — precedence, not ordering** (`resolveTerminalState`,
   `run-sink.server.ts:48-53`, B-FD7). `finalize()` must never blindly overwrite `state`; a human's
   `interrupted` stamp (written by a *different* code path — the no-live-handle branch of
   `interruptRun`) must survive a slower adapter's own `finished`/`error` exit landing afterward.

3. **A reservation can be revived by a race unless re-checked.** `reserveRun` writes a `running` row
   *before* any provider process exists; that row is interruptible from the instant it renders.
   `assertRunReservationLive` (`:388-398`) is checked once in preparation and **again immediately
   before adoption** in `startRun` — skipping either check lets a human's Stop click during
   preparation be silently undone by the later adoption upsert (C4-opres).

4. **A synchronously-exiting adapter must not get a stale handle.** `launch()` sets `state.handles`
   only if `exited` is still false after `adapter.start()` returns (`:1444-1449`) — a spawn-time
   crash (F-SPAWN2) fires `onExit` *during* `start()`, before the caller can register a completion
   callback; `fireIfAlreadyTerminal` (`:166-191`) is the fallback that still fires it by checking
   "no handle + terminal state" as a reliable proxy for "already finalized."

5. **Capability display and runtime enforcement must read the same resolver.** The historical F27-L2
   bug (matrix showed "Not granted" for repo-write while the runtime granted it via scoped grants)
   is exactly this class of bug — display and enforcement drifted because they used different
   derivations. `specialistGrantModes()` is now the one function both `agents-query.server.ts` and
   `specialist-tool-policy.ts` call.

6. **`disallowedTools` derivation must be backend-agnostic even though only one backend enforces
   it.** `repoWriteWithheldFromDenylist`/`webSearchWithheldFromDenylist`
   (`run-service.server.ts:540-563`) compute the withheld-flag from the **same** `disallowedTools`
   array for every run, Claude or Codex — so the matrix, the Claude deny-list, and the Codex
   sandbox-mode decision can never carry three different opinions about one grant.

7. **Workspace isolation is per-engagement, not per-task, for supporting runs** (P8, pass 25). A
   *supporting* engagement gets its own checkout at
   `workspace/support/<profileId>/<repo>`, re-cloned fresh on every dispatch
   (`specialist-run.server.ts:2895-2899`); the **delivering** engagement uses the shared canonical
   `workspace/<repo>`. Two overlapping runs of the *same* supporting engagement are refused
   (`:1140-1156`) precisely because that re-clone would yank the first run's tree out from under it
   — different supporting engagements are fine, they map to separate directories.

8. **Task-file event-sourcing writes the content hash LAST** (F28-D3,
   `app/server/projections/rebuilder.server.ts:608-613`, `:684-689`). A sentinel hash (`""`, never a
   real sha256) is written before the `task_events` rewrite; the real `content_hash` is a final
   `UPDATE` after events + diagnostics have landed. A crash between the two leaves the hash
   unmatched, so the **next** rebuild re-runs instead of short-circuiting "unchanged" on a
   half-written (torn) projection. This is the general shape to follow anywhere a multi-statement
   projection needs crash-consistency: hash-as-commit-marker, written after the data, not before.

9. **Activity-feed ordering uses `occurred_at DESC, id ASC`**, not the append-only idiom's `id DESC`
   (F28-D1, `app/server/projections/activity-feed.server.ts:172-183`) — because `task_events` is
   rebuilt wholesale per task with the newest event inserted *first* (smallest id = newest), the
   opposite of a true append-only table. Using the generic tie-break here silently reversed
   same-timestamp event order versus the task page.

10. **MCP credentials never reach Codex's process args.** Claude gets a decrypted org-MCP token as
    `headers.Authorization`/`env.MCP_CREDENTIAL` (in-process env merge); Codex's SDK serializes
    config as `--config key=value` **argv**, so the same secret would be visible via `ps auxww` on
    the host — it is deliberately dropped for Codex (`codex-runtime.server.ts:160-168`), which
    connects unauthenticated instead of leaking. Never "fix" this by threading the token through
    Codex's config path.

11. **A resumed run must re-apply the full confinement set, not a subset** (the XS-1/F7
    fresh-vs-resume-parity class). `carryResumeOptions` (`run-service.server.ts:1123-1136`) exists
    specifically because earlier code silently dropped `disallowedTools`/`skills`/`allowedTools`/
    `outputSchema` on resume while carrying the prompt — a resumed specialist ran unconfined, or a
    resumed Codex reviewer silently lost its verdict envelope. Any new per-run option added to
    `StartRunInput` needs a matching line in `ResumeRunInput`/`carryResumeOptions`, or it will
    silently vanish on every @mention resume.

12. **`verdictCapable` is a snapshot, not a live lookup — by design, with a known edge case.**
    Recording a verdict trusts the engagement-time snapshot so a required reviewer whose live grant
    was later revoked can still have its approval recorded (`task-actions.server.ts:2988-3005`).
    The flip side: the required-reviewer *set* and the verdict-*recording* gate can transiently
    disagree if a grant changes mid-flight; the documented escape hatch is an admin
    `force-accept-completion` (audited, DG-2), not a silent auto-resolution.

13. **Merge requires a human `userId` by the type system, not just by policy.** `mergeTaskPr`'s
    `actor` parameter type is `AuditActor & {userId: string}` — not optional. Even if every
    capability check were somehow bypassed, there is no code path that can construct a valid call
    with a null actor. Treat this as the actual backstop, not the capability grant, if you're
    auditing "can an agent ever merge."

14. **The operator's own `accept_completion` tool description overstates what it does** (§3.5) — a
    live discrepancy between a prompt string the LLM trusts and the actual code path. If touching
    either `operator-toolkit.server.ts:688` or `operatorAcceptCompletion`, fix both together or the
    drift reappears.

15. **`git identity` env does not automatically follow `spec.env` on Codex** the way it does on
    Claude (P13-RT-10). Codex's `shell_environment_policy.set` table
    (`codex-runtime.server.ts:218-239`) must explicitly name every key that should reach the model's
    shell — `GIT_AUTHOR_NAME`/`_EMAIL`/`GIT_COMMITTER_*`/`GIT_CEILING_DIRECTORIES` are the current
    set. A new per-run env promise added on the Claude side needs a matching entry in
    `SHELL_EXPORTED_ENV_KEYS` or it silently never reaches a Codex agent's own `git commit`.

16. **Boot recovery has a crash-loop backstop, twice, independently.**
    `RECOVERY_REINVOKE_CAP = 3` per task per 30-minute window gates both the orphan-run operator
    re-invoke and the dropped-reply replay (`run-recovery.server.ts:19-20`) — each records its own
    audit row *before* attempting the costly work, specifically so the *next* boot's count is
    accurate even if this attempt crashes the process again.

---

## Appendix: key files

| Area | File |
|---|---|
| Run service (start/resume/interrupt/queue) | `app/server/runtimes/run-service.server.ts` |
| Adapter interface + RunSpec | `app/server/runtimes/adapter.server.ts` |
| Claude adapter | `app/server/runtimes/claude-runtime.server.ts` |
| Codex adapter | `app/server/runtimes/codex-runtime.server.ts` |
| Backend availability/registry | `app/server/runtimes/runtime-registry.server.ts` |
| Wire-format normalizer | `app/server/runtimes/wire-format.server.ts` |
| Run persistence sink | `app/server/runtimes/run-sink.server.ts` |
| Run DB rows (raw + projected) | `app/server/runtimes/run-store.server.ts` |
| Run log windowing/grouping for UI | `app/server/runtimes/run-projection.server.ts` |
| Boot / crash-loop recovery | `app/server/runtimes/run-recovery.server.ts` |
| Model/effort catalog | `app/server/runtimes/model-catalog.server.ts` |
| Claude skill mounting | `app/server/runtimes/skill-mount.server.ts` |
| Operator run orchestration (both backends) | `app/server/runtimes/operator-run.server.ts` |
| Operator gated actions (engage/run/packet/accept/deliver) | `app/server/tasks/operator-actions.server.ts` |
| Operator MCP toolkit (tool list) | `app/server/tasks/operator-toolkit.server.ts` |
| Operator repo-read tool | `app/server/tasks/operator-repo-read.server.ts` |
| Specialist dispatch (assign/run/clone) | `app/server/tasks/specialist-run.server.ts` |
| Capability → tool-policy resolver | `app/server/tasks/specialist-tool-policy.ts` |
| Capability catalog (single source) | `app/shared/capabilities.ts` |
| Per-kind capability editor views | `app/features/agents/capability-catalog.ts` |
| Agent collaboration toolkit (post_comment/ask_human/report_outcome) | `app/server/tasks/agent-toolkit.server.ts` |
| Outcome envelope schema (both backends) | `app/server/tasks/agent-outcome.server.ts` |
| Org-MCP resolution + credential handling | `app/server/tasks/specialist-mcp.server.ts` |
| Browser-capability MCP | `app/server/tasks/specialist-browser-mcp.server.ts` |
| Task-file schema (engagements, workRevision, verdicts, packets) | `app/schemas/task-file.schema.ts` |
| Project-file schema (deployments, capability grants) | `app/schemas/project-file.schema.ts` |
| Human-role RBAC (viewer/contributor/maintainer/admin) | `app/shared/rbac.ts` |
| Human GitHub-approval-as-verdict | `app/server/github/pr-human-approval.server.ts` |
| Real PR merge | `app/server/github/github-reconciler.server.ts` |
| GitHub divergence poller | `app/server/github/reconcile-poller.server.ts` |
| Comment guardrails | `app/server/tasks/comment-guardrails.server.ts` |
| Notification creation/fan-out | `app/server/projections/notifications.server.ts` |
| @mention resolution | `app/server/tasks/mention-notify.server.ts` |
| Task-watcher notification fan-out | `app/server/tasks/task-mutation.server.ts` |
| SSE broker | `app/server/events/sse-broker.server.ts` |
| Low-frequency projection-event → SSE | `app/server/events/event-publisher.server.ts` |
| Run-specific SSE publish | `app/server/runtimes/run-events.server.ts` |
| Client run-log stream hook | `app/features/runtime/use-run-log-stream.ts` |
| Torn-write-safe projection rebuild (hash-last) | `app/server/projections/rebuilder.server.ts` |
| Same-timestamp activity ordering | `app/server/projections/activity-feed.server.ts` |
