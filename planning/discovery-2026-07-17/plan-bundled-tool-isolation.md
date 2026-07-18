# Plan: SDK bundled-tool isolation — which tools fit viberr, and Codex/Claude parity (2026-07-18)

Owner asked (good instinct): before denying the residual SDK-bundled tools, check whether any of them
actually MAKE SENSE for viberr's model (e.g. Cron for a not-yet-Done task), and whether a capability
can be replicated for BOTH Codex and Claude. This plan answers that, then proposes a SELECTIVE fix.

## The two facts that drive the answer

### 1. Parity: viberr is backend-agnostic; real capabilities go through MCP, not backend tools
- A Claude run's toolset is the Claude Agent SDK's ~29 built-ins (Bash/Read/Write/Edit + Cron/Monitor/
  Workflow/Task/Skill/…). A Codex run's toolset is the Codex CLI's (shell/exec/apply_patch) with
  `dedicated_tools: false` and NO Cron/Monitor/Workflow/Task/Skill analog (codex-runtime.server.ts).
- Viberr's design principle is "Codex and Claude work the same from viberr's eye." It already achieves
  that for real capabilities by threading its MCP servers to BOTH backends (`mcp__viberr__*` governance
  tools for the operator; `codexMcpServers()` mirrors `mcpServers` for codex).
- => Any capability we WANT agents to have must be a **viberr MCP tool** (works identically on both
  backends), NOT a Claude-only built-in. Allowing a Claude built-in that Codex lacks BREAKS parity by
  construction. So the parity question answers itself: the Claude built-ins below can't be "replicated
  for both" as-is — the parity-correct form of any of them is a viberr MCP tool.

### 2. Governance: these built-ins would bypass viberr's own subsystems
Viberr already OWNS the concerns these tools cover: the operator orchestrates (specialists/reviewers),
`notifyTaskWatchers` fans out notifications, the runtime manages the isolated workspace clone, and the
capability policy gates every governed action. A raw `PushNotification`/`SendMessage`/`Task`(subagent)/
`Workflow`/worktree tool would let an agent act OUTSIDE that governance.

## Per-tool verdict (empirical: invocation counts across all real claude runs)

| Tool(s) | Uses | Fits viberr? | Verdict |
| --- | --- | --- | --- |
| **ToolSearch** | **137** | YES — loads the deferred `mcp__viberr__*` governance tools (operator's core) | **KEEP (essential)** |
| `mcp__viberr__*`, `mcp__notes-fixture__*` | many | YES — the governed + org-MCP channel (both backends) | KEEP |
| Bash, Read, Write, Edit, MultiEdit, Glob, Grep | core | YES — the coding toolset (specialists do real work) | KEEP |
| NotebookEdit | 0 | plausibly (a coding specialist) | KEEP (coding tool) |
| WebFetch, WebSearch | 0 | plausibly (research); backend-neutral capability | KEEP |
| ReportFindings, TaskCreate/Get/List/Output/Stop/Update | 0 | agent self-todo/output; benign self-management | KEEP (conservative) |
| **Skill** | 0 | NO — viberr injects skills as prompt TEXT | **DENY (done, commit 51f29f5)** |
| **Task** (subagent spawner) | 0 | NO — spawns UNGOVERNED subagents (already denied for operator) | **DENY** |
| **CronCreate/Delete/List, ScheduleWakeup, RemoteTrigger, Monitor** | 0 | NO — scheduling/async is viberr's job, Claude-only (no codex analog) | **DENY** |
| **Workflow** | 0 | NO — orchestration is the OPERATOR's job; a self-orchestrating agent bypasses governance | **DENY** |
| **PushNotification, SendMessage** | 0 | NO — notifications are `notifyTaskWatchers`' job | **DENY** |
| **DesignSync, EnterWorktree, ExitWorktree** | 0 | NO — viberr manages the workspace clone; design-sync is an unrelated plugin | **DENY** |

## The Cron / "not-yet-Done recurring task" question specifically
The instinct is reasonable — a non-terminal task COULD want a recurring/scheduled action (e.g. "re-check
this deploy every hour until it's green"). But the Claude `Cron`/`ScheduleWakeup` tools are the WRONG
vehicle: (a) Claude-only → breaks parity; (b) they schedule inside the SDK's ephemeral run — a viberr
run ends at delivery, so a cron scheduled there has nowhere to live; (c) it would fire OUTSIDE the
operator's coordination + capability gate. If viberr genuinely wants scheduled/recurring task actions,
the RIGHT design is a **viberr-level scheduler** (an app cron that re-invokes the operator on a task on
a schedule), exposed as a governed `mcp__viberr__schedule_*` capability + a capability-policy toggle,
identical for both backends. That's a real FUTURE FEATURE (noted in MASTER-STATUS backlog), not a
reason to un-deny the Claude Cron tool. Denying Cron now loses nothing and keeps the door open to do it
right later.

## Implementation plan (selective — NOT "deny everything")
1. Extend `BASE_DENIED_BUILTINS` (claude-runtime.server.ts) from `["Skill"]` to also deny:
   `Task`, `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`, `RemoteTrigger`, `Monitor`,
   `Workflow`, `PushNotification`, `SendMessage`, `DesignSync`, `EnterWorktree`, `ExitWorktree`.
   Explicitly DO NOT deny `ToolSearch` (breaks MCP tool loading), the coding tools, web tools, or the
   `mcp__*` channel. (Operator already denies `Task`; the base list makes it uniform + adds the rest.)
2. Note in the constant WHY each is denied (parity + governance), and that ToolSearch is deliberately
   kept.
3. Update the claude-runtime denylist test to assert the new set (and that ToolSearch is NOT denied).
4. Verify live in the standalone Docker container: an operator run must still expose ToolSearch + load
   `mcp__viberr__*` (operator still works), and must NOT expose Cron/Monitor/Workflow/Task/etc.
5. Codex side needs no change — it never had these tools (`dedicated_tools: false`); this brings Claude
   to parity with Codex.
