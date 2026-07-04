---
title: "Product Brief Distillate: viberr"
type: llm-distillate
source: "product-brief-viberr.md"
created: "2026-03-29T21:14:48Z"
purpose: "Token-efficient context for downstream PRD creation"
---

# Product Brief Distillate: Viberr

## Positioning

- Viberr should be framed as a **governed AI delivery tool**, not as a generic GitHub-native control plane.
- The initial buyer/user wedge is a **small AI-forward engineering team** already using Codex or Claude Code and GitHub, but lacking a reliable governance model.
- Core promise: let agents do meaningful delivery work without losing review discipline, acceptance control, or legible task state.

## Core Product Model

- Viberr projects are **Jira-like management spaces** independent of code repositories.
- The management plane is **file-native** and lives in Viberr’s own local filesystem store.
- Code repositories are **execution targets attached per task**, not the home of project governance artifacts.
- A task is a **durable operational contract**, not a human ticket with AI notes attached.

## Canonical Task Artifact

- Preferred V1 task model: **single canonical markdown file** in a stable task directory such as `tasks/VIB-142/task.md`.
- Task file should stay small; oversized tasks are treated as a **quality problem** that should trigger splitting or subtask spawning.
- Full-file loading is a feature for agents because context fidelity matters more than micro-optimizing retrieval.
- Task file should function as the **inter-agent communication bus**.
- Human and agent comments should be one **unified conversation timeline**.
- Important typed events should live **inline in the timeline with event markers**, not in separate files.
- Typed important events for V1:
  - `task-quality-flagged`
  - `stage-transition-requested`
  - `blocked-decision`
  - `completion-report`
  - `subtask-spawned`
  - `policy-violation`
- Related files/commits should be stored as **lightweight references plus stage-grouped summaries**, not full diffs or full file copies.
- Validation/test evidence is **optional at creation** and can become required later by stage or test agent.

## Suggested Task Sections

- Identity
- Purpose / goal
- Current state
- Execution context
- Workflow history
- Conversation timeline
- Related files / commits
- Subtasks / spawned tasks
- Human decisions
- Configuration / runtime context
- Optional later-stage sections:
  - success criteria
  - validation evidence
  - test scenarios

## Workflow Model

- Workflow core should be a **rule-driven state machine**, not a simple pipeline.
- Rules define hard boundaries; agents interpret context within those boundaries.
- One primary specialist owner at a time; other persistent specialists remain available as consultants.
- A dedicated **operator agent thread** exists for every task and acts as task manager/chief of staff.
- Official state changes are **human-authorized** even when agents recommend them.
- Transition to `done` is **always manual by a human**.
- PR-backed review model:
  - PR opens at `review` stage
  - `done` means accepted/merged completion, not PR creation

## Operator Agent Responsibilities

- Watch task timeline and typed events
- Recommend next state transition
- Recommend assignment/execution profile
- Prepare human decision packets
- Decide when specialist agents should be consulted
- Propose subtasks
- Summarize task progress
- Detect task-quality issues
- Maintain task consistency/structure
- Trigger specialist agent runs through the app

## Agent / Runtime Model

- Hard stop: execution is backed only by **Codex** or **Claude Code** in V1.
- Every agent run is a real provider-backed CLI run with:
  - non-interactive execution
  - resumability
  - persistent chat history
  - runtime identity
- Persistent agent threads should survive stage changes and loop-backs.
- Re-engaging a specialist:
  - operator writes a short **summon note** in the task
  - specialist re-reads the updated task file
  - operator should not carry heavy recap burden in prompt/context
- Private runtime history is supplemental memory; public task file is the operational record.
- Humans can intervene directly in provider-native threads for debugging.
- Direct CLI interventions are treated as **out-of-band debug sessions**; no automatic sync back is required.
- If a human wants system behavior to change based on that debug session, they should comment in the task.

## Write Model

- Split write model:
  - agents can append timeline comments, typed events, and lightweight execution references directly
  - official control fields are mediated
- Key rationale: prevent race conditions and conflicting writes when multiple persistent agent threads exist.

## Assignment Model

- Assignment should be **constrained dynamic assignment**:
  - workflow rules narrow the eligible set
  - operator agent chooses the concrete execution profile within that set
- Execution profile includes:
  - current agent
  - skills
  - MCPs
  - knowledge-base folders
- Operator agent should receive **full task context** when assigning.
- Assignment output should include a **short rationale**, not full internal scoring.

## GitHub Execution Model

- V1 is **single-repo per task**. Multi-repo work should be decomposed into tasks/subtasks.
- Each project has a **default GitHub repo** with task override.
- Task attaches to repo when execution starts.
- Task gets a fresh code workspace at runtime; do not pre-create stale code checkouts at task creation.
- Task branch should be named with the **task key only**, e.g. `VIB-142`.
- Commit format should be **bracketed task key**, e.g. `[VIB-142] message`.
- PR title should also keep bracketed task identity.
- Sync/rebase should happen at **stage boundaries**, not continuously.
- Operator opens PR at review stage.
- Review lives in GitHub PR; done is still manual human acceptance.

## Management Plane Storage

- Local filesystem management store preferred over database or git-backed management repo.
- Backups can be handled through normal filesystem mechanisms.
- Root layout should use separated domains such as:
  - `projects/`
  - `agents/`
  - `runtimes/`
  - `cache/`
  - `auth/`
  - `logs/`
- App should use **hybrid watchers plus manual re-scan** for robustness.

## Governance Model

- Separate **human RBAC** and **agent policy**.
- Human governance should use classic object RBAC over tasks, projects, workflows, approvals, and policy files.
- Agent policy should define per-project capability matrix, including:
  - which profiles exist
  - stage eligibility
  - allowed skills/MCPs/knowledge bases
  - provider choice
  - whether profile may enter project
  - whether profile may comment
  - whether profile may request transitions
  - whether profile may create/delete/update tasks
  - whether profile may change agents/skills/MCPs/knowledge bases on tasks
- Agent profiles should come from **global base definitions with project customization**.

## UX Signals

- Task page priority:
  - current state and assigned agent/profile most prominent
  - latest blocking/decision packet second
- Board card priority:
  - current stage
  - waiting on human / waiting on agent
  - assigned agent
  - validation status

## Hard Guardrails

- Meaningful-comment rule: agents comment only at meaningful progress boundaries, blockers, decisions, or explicit requests.
- Operator brevity rule: operator comments must be concise and purpose-driven.
- No duplicate summary rule: new summaries supersede older ones instead of restating them.
- Compression threshold rule: once task grows past threshold, older context is compacted into recaps.
- Evidence separation rule: raw validation/test chatter remains referenced or collapsible, not inline as primary narrative.
- Canonical re-anchor rule: any reactivated agent must re-read the canonical task before acting.
- Continuity degradation path: if runtime history fails, rehydrate from task file and current execution context.
- Branch health must be visible.
- Sync/rebase failure must become a typed blocking event.
- No execution-critical transition on unhealthy/dirty/conflicted branch.
- Operator should summarize branch recovery options instead of reporting failure passively.

## Rejected Ideas

- Managed repo as the home of workflow/task truth: rejected. Management plane is separate from code repos.
- Multi-repo tasks in V1: rejected.
- Separate sections for human comments and agent comments: rejected in favor of unified timeline.
- Fully autonomous transition to `done`: rejected.
- Forcing success criteria/test evidence at task creation for every task: rejected.
- Typing every comment and every interaction: rejected.
- Pure task-folder ledger / event-sourced task as V1 canonical model: rejected in favor of single markdown task.
- Full code worktree from task creation: rejected; create task home immediately, code workspace on runtime.
- Always-auto-sync branches: rejected.
- Never-sync branches: rejected.
- Hosted multi-tenant SaaS as primary V1 positioning: deprioritized; V1 can still be multi-user, but small-team wedge comes first.

## Technical Constraints And Preferences

- User explicitly wants only **Codex** and **Claude Code** as execution backends in V1.
- User mentioned likely use of symlinks and no need to support Windows as hosting environment.
- GitHub authentication is a first-class platform concern.
- Task branch, commits, PR, and task key should remain tightly linked for traceability.

## Open Questions

- Exact multi-user model in V1: shared local deployment, small-team networked setup, or something else.
- Precise task markdown schema and event marker syntax.
- Exact PR title convention to preserve alignment with chosen commit/task conventions.
- Exact approval matrix beyond “done is always manual.”
- How operator-agent mediation is implemented in code: deterministic app kernel, operator-prepared state change, or hybrid.

## Best Inputs For Downstream PRD

- The product is not “kanban plus AI”; it is a governed AI delivery tool.
- The strongest differentiators are the canonical task contract, the dedicated operator thread, and the human-authorized governance model.
- The biggest product risks are timeline noise, operator verbosity, process theater, memory drift, and silent GitHub branch-health failures.
- The product works only if the task remains compact, readable, and authoritative for humans and agents alike.
