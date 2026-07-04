---
stepsCompleted: [1, 2, 3, 4]
inputDocuments: []
session_topic: 'A multi-agent, file-native Kanban web app that orchestrates Codex-style execution through task files, workflow files, agent assignments, and git-aware metadata.'
session_goals: 'Create the product and strengthen it through brainstorming, with focus on the product concept, workflow model, agent orchestration, and differentiators.'
selected_approach: 'ai-recommended'
techniques_used: ['First Principles Thinking', 'Morphological Analysis', 'Reverse Brainstorming']
ideas_generated: []
context_file: ''
workflow_completed: true
---

# Brainstorming Session Results

**Facilitator:** akin-ozer
**Date:** 2026-03-29

## Session Overview

**Topic:** A multi-agent, file-native Kanban web app that orchestrates Codex-style execution through task files, workflow files, agent assignments, and git-aware metadata.
**Goals:** Create the product and strengthen it through brainstorming, with focus on the product concept, workflow model, agent orchestration, and differentiators.

### Session Setup

The session is framed around a product-building goal rather than abstract ideation. The core challenge is designing a system where tasks are durable files, agents participate at each workflow stage, and the web app acts as an operational control plane over git-aware execution and review.

## Technique Selection

**Approach:** AI-Recommended Techniques
**Analysis Context:** Multi-agent, file-native Kanban product with focus on product concept, workflow model, agent orchestration, and differentiators.

**Recommended Techniques:**

- **First Principles Thinking:** Strip the concept back to core truths so the product is driven by real advantages rather than inherited assumptions.
- **Morphological Analysis:** Systematically explore design dimensions such as task identity, state machine, agent routing, git linkage, metadata enrichment, and permissions.
- **Reverse Brainstorming:** Pressure-test the product by exploring how it could become noisy, brittle, slow, or bureaucratic.

**AI Rationale:** This sequence fits a strategic product-design problem with many interacting system choices. It starts by clarifying the irreducible product value, then expands the option space deliberately, and finally exposes the hidden failure modes before they calcify into architecture.

## Technique Execution Results

**First Principles Thinking:**

- **Interactive Focus:** Clarifying whether the product is fundamentally file-native, agent-native, or a hybrid.
- **Key Breakthroughs:** The core value is not merely "tasks as files" but an agent-native task management system where autonomous agents operate natively across stages and humans primarily configure, observe, and intervene.

**[Core #1]**: Closed-Loop Task Contract
_Concept_: A task becomes a durable operational contract that agents can interpret, act on, and enrich with evidence over time. The task is not just a description of work; it is the shared execution surface between workflow rules, code activity, and agent decisions.
_Novelty_: This shifts task management from human-readable planning artifacts to machine-operable records that accumulate execution context.

**[Foundation #2]**: Agent-Native Task Operating System
_Concept_: The product should be designed first for autonomous agents working tasks through specialized stages, with humans acting more like product owners and system operators than direct executors. Files remain important because they make the system durable, inspectable, and repo-native, but the real product value is that the workflow is native to agent operation.
_Novelty_: Existing tools are human-native and optionally AI-assisted; this model inverts that and treats humans as governors of an AI-native delivery system.

**[Control #3]**: Policy-Bounded Autonomy
_Concept_: Agents should handle the operational loop by default: create or spawn tasks, validate quality, open worktrees or branches, update task files, attach execution evidence, and comment on progress. Humans remain available to override, edit files directly, change assignments, and decide on consequential transitions such as rerouting stuck work or accepting completion.
_Novelty_: This is not a fully autonomous black box and not a human-driven board with AI helpers; it is a governed autonomy model where agents execute by default inside explicit policy boundaries.

**[Control #4]**: File-Level Human Override
_Concept_: Because the task system is file-native, humans can always intervene directly by editing task files, comments, workflow definitions, and assignments. Agents then re-validate and continue from the updated state rather than treating manual intervention as out-of-band.
_Novelty_: Human override happens inside the same source of truth as agent execution, instead of through side-channel admin tools or hidden database state.

**[Governance #5]**: Quality-First Blocking Is A Feature
_Concept_: The system does not need to optimize for uninterrupted autonomous flow. It is acceptable, and often desirable, for work to pause when ambiguity, risk, weak evidence, or low task quality require human evaluation or corrective guidance. Human comments are not exceptions to the system; they are part of the designed control loop.
_Novelty_: Most automation products treat blocking as failure. This model treats deliberate blocking as a quality mechanism inside an agent-managed delivery system.

**[Interface #6]**: Structured Intervention Packet
_Concept_: When an agent needs human input, it should produce a consistent intervention packet rather than an ad hoc comment. The packet should include why the agent is blocked, what it observed, what it changed so far, recommended options, the exact decision needed, confidence level, risk level, tests or validations run, and missing context or contradictions.
_Novelty_: This turns agent-to-human interaction from informal commentary into a standard review artifact that can be rendered well in the UI, audited later, and potentially reasoned over by other agents.

**[Interface #7]**: Dual-Layer Communication
_Concept_: Agent communication should exist in two layers at once: conversational comments for natural collaboration and typed event records for important workflow moments. The system should not force every interaction into a rigid schema, but it should require structure when the comment represents a consequential state in the task lifecycle.
_Novelty_: This avoids the usual tradeoff between chatty but ambiguous timelines and rigid but unnatural workflow forms.

**[Interface #8]**: Typed Important Events Only
_Concept_: Important events such as blocking requests, quality flags, completion reports, or transition requests should use typed schemas, while ordinary progress notes and discussion remain conversational. This preserves agent expressiveness while giving the platform enough structure to drive UI behavior, filtering, auditability, and automation.
_Novelty_: The system becomes semantically aware at key moments without turning the entire product into a form engine.

**[Contract #10]**: Governance Event Spine
_Concept_: V1 typed events should be limited to task-quality-flagged, stage-transition-requested, blocked-decision, completion-report, subtask-spawned, and policy-violation. These are the moments where the system must preserve durable semantics because governance, workflow state, or task graph shape is changing.
_Novelty_: This gives the product a minimal but powerful semantic backbone instead of over-typing every interaction in the timeline.

**[UX #11]**: Operator-First Task Screen
_Concept_: On the task page, the most visually prominent element should be the task's current state and assigned agent, with the latest blocking or decision packet immediately beneath it. The interface should prioritize what the system is doing now and what human attention is needed now, rather than leading with a long description or generic activity feed.
_Novelty_: This makes the product feel like an operations console for governed agent work rather than a traditional backlog detail page.

**[UX #12]**: Triage-Oriented Board Card
_Concept_: A board card should expose just enough live execution state for a human to decide whether attention is needed without opening the task. V1 should emphasize current stage, whether the task is waiting on a human or an agent, the assigned agent, and validation status.
_Novelty_: The board becomes a triage surface for supervising agent work, not merely a visual grouping of tickets.

**First Principles Transition Note:**

- **Key Ideas Generated:** Agent-native task operating system, governed autonomy, quality-first blocking, structured intervention packets, typed important events, operator-first task page, triage-oriented board.
- **Creative Breakthroughs:** The strongest shift was treating humans as governors inside an agent-managed delivery system rather than as primary workers in a traditional board.
- **User Creative Contributions:** You clarified that autonomous agents are native actors, continuous human evaluation is expected, and blocking is a quality feature rather than a failure state.
- **Partial Technique Completion:** First principles produced a stable product thesis and governance model, so the session is moving to Morphological Analysis to explore concrete design combinations.

**Morphological Analysis:**

**[Morph #13]**: Single-File Task
_Concept_: Each task is one markdown or yaml file with frontmatter for state and metadata plus appended conversational and typed event sections. It is simple to discover, simple to load, and easy for both humans and agents to edit.
_Novelty_: Retrieval is straightforward because the whole task is local and canonical, but long-running tasks may become heavy and harder to render efficiently.

**[Morph #14]**: Task Folder Ledger
_Concept_: Each task is a folder with separated files for narrative, state, comments, events, and evidence. This keeps artifacts tidy and composable as execution grows.
_Novelty_: It improves structural separation but introduces artifact discovery risk for agents and makes the UI depend on reconstructing context across files.

**[Morph #15]**: Event-Sourced Task
_Concept_: The task is fundamentally an append-only event stream, with current state computed from those events and human-readable views generated as projections. This is highly auditable and deeply machine-native.
_Novelty_: It fits governed automation well but increases operational and UI complexity significantly.

**[Morph #16]**: Dual-Layer Task
_Concept_: Each task has a human-readable canonical file plus structured sidecar files for typed events, validations, and evidence. The UI renders them as a unified task experience.
_Novelty_: This aligns with conversational plus typed communication, but still depends on agents reliably discovering related artifacts.

**[Morph #17]**: Retrieval-First Task Canonical
_Concept_: The main task file remains the canonical entry point and always contains the minimum complete execution context an agent needs to continue safely. Additional files may exist for typed events, evidence, or large artifacts, but they must be referenced through an explicit manifest or embedded index so discovery is deterministic.
_Novelty_: This treats agent retrieval reliability as a first-class product requirement rather than an implementation detail.

**[Morph #18]**: Compiled Execution Snapshot
_Concept_: Even if task data is physically distributed, the system can generate a compiled task snapshot for agents and UI consumption that flattens current state, key comments, typed events, evidence summaries, and links to detailed artifacts into one predictable view.
_Novelty_: This decouples authoring/storage structure from execution/rendering structure and reduces the risk that agents miss critical context.

**[Morph #19]**: Small-Task Discipline
_Concept_: Task files are expected to stay small because the system is built around agile-sized work items. If a task grows too large or accumulates too much context, that is treated as a task-quality problem that should trigger clarification, splitting, or subtask spawning rather than a reason to complicate the storage model.
_Novelty_: This shifts scalability from a storage concern to a governance concern and keeps the canonical task artifact simple.

**[Morph #20]**: Canonical Markdown Task
_Concept_: The preferred task artifact can remain a single markdown file with a strict template, stable header blocks, and internal structure optimized for both human readability and deterministic agent loading. Performance can be handled in the app layer through lazy loading, internal caching, and efficient rendering instead of by fragmenting the source of truth.
_Novelty_: This treats full-file context loading as a feature for agents, not a liability, while preserving a straightforward file-native experience for humans.

**[Morph #21]**: Task Bloat Is A Quality Signal
_Concept_: Oversized tasks should be treated as task-quality failures that trigger clarification, splitting, or subtask spawning, not as a reason to fragment the storage model. The system should preserve small, context-rich tasks rather than normalize oversized work items.
_Novelty_: Scalability pressure is absorbed by governance and task hygiene instead of by weakening the canonical task artifact.

**[Morph #22]**: Task File As Operating Contract
_Concept_: The canonical task file should contain structured sections for identity, purpose and goal, current state, assigned execution context, workflow history, comments, typed events, related files and commits, subtasks, human decisions, and configuration or runtime context. The task file is not just a note; it is the operational contract agents and humans both act against.
_Novelty_: One readable artifact carries both planning context and execution state without needing external reconstruction.

**[Morph #23]**: Execution Context Is Part Of Assignment
_Concept_: Assignment should include not only the current agent but also the relevant skills, MCPs, and knowledge-base folders that can be loaded on demand. This turns assignment from a simple owner field into a declarative execution profile.
_Novelty_: The task itself can specify the minimum specialized capability set required at each stage instead of assuming every agent loads the whole world.

**[Morph #24]**: Unified Conversation Timeline
_Concept_: Human comments and agent comments should live in one conversation timeline, distinguished by author type and metadata rather than split into separate sections. Typed events remain separate because they represent consequential workflow semantics, but ordinary collaboration should read as one coherent dialogue.
_Novelty_: This preserves natural collaboration while avoiding fragmented timelines or duplicated discussion surfaces.

**[Morph #25]**: Stage-Conditional Validation And Success Criteria
_Concept_: Success criteria, validation evidence, or test scenarios do not need to be mandatory at task creation. They can remain optional until a later stage, where policy, human review, or a test agent can request, generate, or enforce them as needed.
_Novelty_: This avoids over-specifying simple tasks upfront while still allowing rigorous validation when a task reaches test, review, or completion boundaries.

**[Morph #26]**: Rule-Driven State Machine Core
_Concept_: Project workflow should be defined as a rule-driven state machine rather than a simple ordered pipeline. The project definition needs to express stages, allowed transitions, assignment logic, gating rules, escalation conditions, and governance behavior as executable policy.
_Novelty_: This makes the workflow file the real operational brain of the project instead of just a visual board configuration.

**[Morph #27]**: Rules As Boundaries, Agents As Interpreters
_Concept_: Workflow behavior should combine declarative rules with agent recommendations. The project definition sets the hard boundaries and governance conditions, while agents interpret task context and propose or execute the best action within those limits.
_Novelty_: This avoids both brittle fully declarative workflow engines and unconstrained agent-driven orchestration.

**[Morph #28]**: Constrained Dynamic Assignment
_Concept_: Assignment should combine rule-selected eligibility with operator-agent recommendation. Workflow rules narrow the valid agent profiles and execution context for a stage, then an operator agent recommends the best concrete assignment of agent, skills, MCPs, and knowledge-base folders from within that allowed set.
_Novelty_: This turns assignment into a policy-constrained matching problem instead of a fixed owner field or a free-form agent guess.

**[Morph #29]**: Context-Complete Assignment Input
_Concept_: Because the task is kept as a single canonical file, the operator agent can receive the full task context by default when making assignment decisions. The system does not need to aggressively trim inputs at recommendation time; it can rely on the task artifact itself as the complete decision surface.
_Novelty_: This treats rich task context as an advantage for assignment quality rather than as a retrieval burden that must be minimized.

**[Morph #30]**: Explainable Assignment Recommendation
_Concept_: Assignment output should include the selected execution profile plus a short rationale that explains the main factors behind the choice. This gives humans enough signal to review or override assignments without drowning them in internal scoring details.
_Novelty_: Assignment becomes inspectable and governable without becoming noisy or over-formalized.

**[Morph #31]**: Inline Timeline With Event Markers
_Concept_: Typed events should live inside the same chronological conversation timeline as human and agent comments, but with explicit event markers and required structured fields for important events. The task remains one readable narrative stream while still containing semantically meaningful governance artifacts.
_Novelty_: This preserves the natural feeling of a single evolving task story without splitting operational events into a detached section.

**[Morph #32]**: Stage-Grouped Change Summaries
_Concept_: Related files and commits should be stored as lightweight agent-appended references inside the task, supplemented by grouped summaries at meaningful workflow stages. The task should contain paths, names, commit IDs, and brief change summaries rather than full diffs or file contents.
_Novelty_: This preserves the audit trail and stage-level reasoning without bloating the canonical task artifact.

**[Morph #33]**: Hard-Bound Runtime Providers
_Concept_: Agent execution should be backed by real CLI runtimes, with each run using either Claude Code or Codex depending on application configuration. "Agent" is not just a label in the workflow; it is a concrete non-interactive runtime invocation with a provider, run identity, resumability, and persisted chat history.
_Novelty_: This grounds the product in actual execution backends instead of treating agents as abstract personas detached from tool reality.

**[Morph #34]**: Persistent Agent Threads Across Stages
_Concept_: Each agent profile should keep its own chat history and run identity even as tasks move across stages or loop backward. That allows later-stage participants to re-engage earlier specialists, preserve reasoning continuity, and ask follow-up questions in the context of the original execution thread.
_Novelty_: The system does not just assign roles at each stage; it preserves long-lived expert threads that can be revisited as the task evolves.

**[Morph #35]**: Shared Canonical Task Through Linked Workspaces
_Concept_: If each agent run has its own folder and runtime context, the canonical task file can still remain shared by linking it into each agent workspace, allowing all participants to read the same live task artifact while keeping their provider-specific histories and local execution context separate.
_Novelty_: This separates runtime isolation from task-truth fragmentation and allows per-agent context continuity without duplicating the task record.

**[Morph #36]**: Recommended Spawn, Human Confirmed
_Concept_: Agents should be able to recommend subtasks when decomposition is needed, but a human confirms before those subtasks become active task files. This keeps decomposition visible and intentional without requiring humans to invent every new task themselves.
_Novelty_: It preserves governance over task graph growth while still letting agents do the cognitive work of identifying missing work items.

**[Morph #37]**: Split Write Model
_Concept_: Agents should be allowed to append directly to the task timeline with conversational comments, typed events, and lightweight execution references, while official control fields such as current stage, assignment, waiting status, subtask graph, and policy state are updated through a mediated path. Agents can request these state changes, but the system applies them only after rules, policy, and any required human approval are satisfied.
_Novelty_: This preserves the speed and naturalness of collaborative updates while protecting the canonical task truth from race conditions and conflicting agent writes.

**[Morph #38]**: Task-Dedicated Operator Thread
_Concept_: Every task should have its own dedicated persistent operator agent with an independent chat history and runtime identity, just like specialist agents. The app triggers this operator thread to observe task evolution, interpret agent outputs, prepare recommendations, and maintain continuity of reasoning about the task as a whole.
_Novelty_: Mediation is not a generic backend function or a stateless coordinator; it is a long-lived per-task intelligence layer with memory of the task's full lifecycle.

**[Morph #39]**: Human-Authorized State Changes
_Concept_: Even when the operator agent mediates workflow logic and recommends transitions, humans remain the authority for official state changes. The operator agent prepares the case and recommendations, and the app records the final state only after human approval or intervention according to governance rules.
_Novelty_: This keeps the system agent-managed but explicitly human-governed at consequential state boundaries.

**[Morph #40]**: Operator Agent As Task Manager
_Concept_: The task-dedicated operator agent should watch the task timeline and typed events, recommend next state transitions, recommend assignment and execution profiles, prepare human decision packets, decide when specialist agents should be consulted, propose subtasks, summarize task progress, detect task-quality issues, maintain task consistency and structure, and trigger specialist agent runs through the app.
_Novelty_: Each task gets a persistent coordinating intelligence that behaves more like a task manager or chief of staff than a passive workflow parser.

**[Morph #41]**: Primary Owner With Persistent Consultants
_Concept_: A task should have one primary active specialist owner at a time, while other persistent specialist threads remain available for consultation, review, or re-engagement as the task evolves. This preserves clear execution responsibility without losing continuity from previous specialist involvement.
_Novelty_: The system supports longitudinal multi-agent collaboration without turning every task into an unbounded parallel swarm.

**[Morph #42]**: Summon-Note Re-Engagement
_Concept_: When the operator agent re-engages a specialist, it should add a short comment to the task explaining why that specialist is being called back and what question or issue needs attention. The specialist then reads the updated canonical task file, including the shared timeline, and reconstructs context from there rather than relying on a heavy explicit recap payload from the operator.
_Novelty_: This keeps the operator agent lightweight while using the task file itself as the durable context-transfer medium between persistent agent threads.

**[Morph #43]**: Task File As Inter-Agent Bus
_Concept_: Agents should coordinate primarily through the canonical task timeline, using comments, typed events, and summon notes as the shared communication surface. The task file becomes the durable bus through which persistent agent threads collaborate over time.
_Novelty_: Coordination becomes visible, inspectable, and replayable instead of being hidden inside opaque orchestration state.

**[Morph #44]**: Private Runtime Memory, Public Outcome Trail
_Concept_: Each specialist and operator agent keeps its own private provider-side run history for continuity and optional direct human intervention through Codex or Claude Code, but only conclusions, evidence, questions, and actionable commentary are written back into the shared task file. Raw internal reasoning is not copied into the task.
_Novelty_: This preserves agent continuity and manual recoverability without polluting the canonical task record with noisy private deliberation.

**[Morph #45]**: Dual Human Access To Agents
_Concept_: Humans should be able to interact with agents in two ways: indirectly through tagged comments in the task timeline and directly by entering the agent's own Codex or Claude Code thread when deeper manual intervention is needed. The task file remains the shared coordination layer, while provider-native chats remain available for specialist-level troubleshooting or clarification.
_Novelty_: The product supports both governed in-app collaboration and low-level expert intervention without collapsing them into one interface.

**[Morph #46]**: Out-Of-Band Debug Sessions
_Concept_: Direct human intervention inside an agent's private Codex or Claude Code thread can be treated as a debugging or troubleshooting session and does not need automatic synchronization back into the task file. If the human wants the shared system to react to findings from that session, they can comment on the task and guide the relevant agents there.
_Novelty_: This preserves the task file as the intentional coordination surface without forcing every low-level debugging interaction into the canonical workflow record.

**[Governance #47]**: Separate Human RBAC And Agent Policy
_Concept_: Human permissions and agent operational policy should be modeled separately. One layer governs human roles, approvals, and project authority, while another governs agent capabilities, stage eligibility, trigger rights, and workflow constraints.
_Novelty_: This distinguishes organizational governance from machine-operational governance instead of forcing them into one mixed permission model.

**[Governance #48]**: Project-Scoped Agent Capability Matrix
_Concept_: Agent policy should define which profiles exist, which stages they are eligible for, which skills, MCPs, and knowledge bases they may load, which runtime provider they use, whether they may enter a project, comment on tasks, request transitions, create/delete/update tasks, and change task-level execution context such as assigned agents or loaded capability packs.
_Novelty_: Agent permissions become a project-scoped operational contract rather than a loose collection of role labels.

**[Governance #49]**: Classic Object RBAC For Humans
_Concept_: Human governance should still use conventional RBAC concepts for objects like projects, tasks, workflow files, policy files, and approvals. This human permission layer stays separate from the agent capability matrix but complements it at the project boundary.
_Novelty_: The system combines familiar object-level human governance with a distinct agent-operational permission model instead of trying to force one abstraction to cover both.

**[Governance #50]**: Global Profiles With Project Customization
_Concept_: Agent profiles should start from global base definitions, but projects must be able to clone and customize them locally. This allows a common capability vocabulary across the system while still letting each project tailor stage eligibility, runtime provider, loaded context packs, and allowed actions to its own workflow.
_Novelty_: The platform gains reusable agent archetypes without forcing every project into one uniform operational model.

**[Morph #51]**: Hybrid Task Workspace Plus Agent Runtime Folders
_Concept_: Each task should have one canonical code workspace or worktree, while each participating agent maintains its own runtime folder for provider-specific chat history, local metadata, and execution context. Agents on the same task share the task workspace for code interaction but keep independent runtime memory outside it.
_Novelty_: This separates task-scoped code isolation from agent-scoped runtime continuity and avoids multiplying code workspaces unnecessarily.

**[Morph #52]**: Task Home On Creation, Code Workspace On Runtime
_Concept_: A task should get its own durable filesystem home immediately at creation for the canonical task file and related metadata, but the actual project code workspace or worktree should only be created when the task reaches runtime execution. This avoids stale code checkouts while preserving file-native task identity from day one.
_Novelty_: The system separates the task's durable home from its executable code environment, reducing staleness without weakening the file-native model.

**[Morph #53]**: Fresh Execution Checkout
_Concept_: When a task enters active execution, the system should create or refresh its code workspace at that time so agents operate on a current project state rather than a stale checkout created long before implementation started.
_Novelty_: Execution environments become time-appropriate snapshots while task artifacts remain durable across the full lifecycle.

**[Morph #54]**: Project Key Plus Sequence
_Concept_: Task identity should use a stable project key and numeric sequence, such as `VIB-142`, with any human-readable slug treated as secondary decoration rather than canonical identity.
_Novelty_: This gives the system familiar, stable, and compact references that work well across comments, UI, filenames, and agent communication.

**[Morph #55]**: Task Home Directory
_Concept_: Each task should live in its own directory, such as `tasks/VIB-142/task.md`, with the directory created either by the app during UI-driven task creation or manually by a human when creating tasks by hand. The key remains the stable path anchor, and the task directory becomes the durable filesystem home for the task artifact.
_Novelty_: This keeps task identity stable, supports manual repo-native workflows, and leaves room for task-local artifacts without forcing path churn on stage changes.

## Concept Correction

The management project in this product is Jira-like and independent of the code repositories being worked on. Task files, workflow definitions, human RBAC, and agent policy belong to the Viberr management domain, not inside the managed code repository itself. A task is attached to a target git repository when it is managed for execution, and that task then gets its own execution branch based on the ticket identity.

**[Architecture #56]**: Management Plane Separate From Code Repositories
_Concept_: Projects, task files, workflow rules, human RBAC, and agent policy should live in Viberr's own management layer rather than being colocated inside the code repository under execution. The managed repo is an external execution target, not the canonical home of project governance artifacts.
_Novelty_: This preserves the file-native task operating model while avoiding the false assumption that organizational workflow state must live inside the same repo as the code being changed.

**[Architecture #57]**: Task-To-Repo Attachment
_Concept_: A task belongs to a Jira-like management project but is attached to a specific git repository when it enters execution-oriented work. The repo attachment becomes part of the task's execution context and determines where branches, commits, validations, and pull requests occur.
_Novelty_: Tasks remain stable workflow artifacts even though their execution target is an external repository selected per task.

**[Workflow #58]**: Ticket-Named Execution Branch
_Concept_: When a task begins implementation, the system should create a dedicated branch in the attached repository using the task key as the branch anchor. Agents work and commit on that task branch rather than sharing long-lived feature branches.
_Novelty_: Task identity becomes the stable connective tissue between management state, code execution, commit history, and pull request flow.

**[Workflow #59]**: Operator-Opened Pull Request At Review
_Concept_: When a task reaches the review stage, the task-dedicated operator agent should prepare and open the pull request against the target repository. The done stage should represent accepted or merged completion rather than the moment the PR is first created.
_Novelty_: This aligns the task workflow with GitHub-native review reality by making the PR itself part of the review phase instead of a post-completion afterthought.

**[Platform #60]**: GitHub-Native Integration And Authentication
_Concept_: The system should be GitHub-native, with authentication and repository access treated as first-class platform concerns. Tasks, branches, commits, validations, and PRs all depend on durable GitHub integration rather than generic VCS abstractions in V1.
_Novelty_: This narrows the execution surface intentionally so the product can deliver a coherent repo-attached workflow instead of spreading across weak multi-provider abstractions too early.

**[Platform #61]**: Single-Repo Task Attachment For V1
_Concept_: In V1, each task should attach to exactly one GitHub repository as its execution target. Multi-repo work should be decomposed into separate tasks or subtasks rather than normalized inside one task record.
_Novelty_: This keeps branch strategy, PR flow, execution context, and governance simpler while still supporting cross-repo work through explicit decomposition.

**[Platform #62]**: Project Default Repo With Task Override
_Concept_: Each management project should define a default GitHub repository, and tasks inherit that repo unless explicitly overridden. This keeps common-case task creation lightweight while still allowing exceptions when a task needs to execute against a different target repository.
_Novelty_: Repo attachment becomes a project-level defaulting rule rather than a mandatory per-task choice or a late-stage surprise.

**[Workflow #63]**: Task-Key Branch Naming
_Concept_: Execution branches should use the task key directly as the branch name, such as `VIB-142`. This keeps the mapping between task, branch, commits, and pull request maximally direct and easy to reason about.
_Novelty_: The branch name becomes the simplest possible repository-native expression of task identity without extra namespace or slug churn.

**[Workflow #64]**: Bracketed PR Title
_Concept_: Pull requests should use a bracketed task key followed by the task title, such as `[VIB-142] Improve operator transition handling`. This keeps GitHub-native readability while making the task identity immediately visible in repository views and automation hooks.
_Novelty_: The PR title stays human-friendly without sacrificing the canonical link back to the task operating record.

**[Workflow #65]**: Sync On Stage Boundaries
_Concept_: Active task branches should sync with the target repository's mainline at meaningful workflow boundaries such as before testing, before review, or before opening the pull request. This keeps execution branches reasonably fresh without introducing constant rebasing noise during normal stage work.
_Novelty_: Branch freshness becomes a governed workflow behavior instead of a continuous background mutation or a purely manual maintenance chore.

**[Workflow #66]**: Bracketed Task-Key Commits
_Concept_: Commits on task branches should use a bracketed task key prefix, such as `[VIB-142] Implement transition review packet`. This keeps repository history directly traceable back to the task operating record with the same visual convention used for pull requests.
_Novelty_: Commit history becomes consistently task-addressable across git and the management plane without requiring extra metadata systems.

**[Workflow #67]**: PR-Backed Review Stage
_Concept_: The review stage should be backed by a live GitHub pull request, with done representing accepted or merged completion after review outcomes are resolved. This gives the stage model a clean external artifact and avoids ambiguity about whether review is pre-PR or inside GitHub.
_Novelty_: The workflow uses GitHub PRs as the canonical review surface instead of treating repository review as a separate post-workflow event.

**[Workflow #68]**: Human-Only Done Transition
_Concept_: Transitioning a task into `done` should always require an explicit human decision, regardless of merge status or agent recommendations. Agents and the operator thread can prepare completion reports and recommend closure, but final acceptance remains a human governance act.
_Novelty_: Completion is treated as a governed acceptance decision, not merely as an automated consequence of repository state.

**[Architecture #69]**: Local Filesystem Management Store
_Concept_: Viberr projects, tasks, workflow files, RBAC, and agent policy should live in a local app-managed filesystem store rather than in a database or dedicated git repo. The structure should stay explicit and portable so it can be backed up, copied, inspected, and edited directly when needed.
_Novelty_: The management plane remains truly file-native and operationally simple, with backup handled through ordinary filesystem mechanisms instead of secondary platform dependencies.

**[Architecture #70]**: Hybrid Watchers Plus Manual Re-Scan
_Concept_: The app should watch the local management store for normal file changes but also provide explicit manual re-scan and rebuild actions for recovery, consistency checks, and cases where file watchers miss updates. This supports both app-driven and manual file editing without assuming perfect watcher behavior.
_Novelty_: The management plane feels live and reactive in normal operation while still remaining debuggable and recoverable when filesystem events are imperfect.

**[Architecture #71]**: Separated Domains Under One Root
_Concept_: The local management store should use one root directory with clearly separated domains such as projects, agents, runtimes, cache, authentication, and logs. This keeps the overall system inspectable and recoverable while avoiding the noise of a single flat directory.
_Novelty_: Operational state remains file-native and local, but with a deliberate topology that supports debugging, backup, and future growth without obscuring where different concerns live.

**Reverse Brainstorming:**

**[Risk #72]**: Timeline Noise Collapse
_Concept_: Users stop trusting the system if the canonical task file becomes hard to read because comments, event markers, and status chatter grow too quickly. The task then stops functioning as a usable operating contract and starts feeling like noisy machine exhaust.
_Novelty_: The failure is not lack of information but loss of legibility caused by overproduction of coordination artifacts.

**[Risk #73]**: Talkative But Ineffective Agents
_Concept_: Users lose confidence if agents produce many comments, recommendations, or reports but fail to move work forward reliably. The product then feels like process theater: lots of visible AI activity with too little real operational progress.
_Novelty_: The danger is not silent failure but convincingly articulate underperformance.

**[Risk #74]**: Micro-Step Commentary Spam
_Concept_: Timeline legibility collapses if agents comment on every tiny action instead of only on meaningful state changes, decisions, or progress boundaries. The task becomes a scrolling log stream rather than an operating record.
_Novelty_: Excessive transparency destroys usability by overwhelming the canonical artifact with low-value narration.

**[Risk #75]**: Operator Narration Bloat
_Concept_: The operator agent becomes a source of noise if it narrates too much of what it is thinking or doing rather than acting as a concise task manager. This is especially dangerous because the operator thread is long-lived and appears throughout the lifecycle.
_Novelty_: The very component meant to preserve coherence can become the biggest source of clutter.

**[Risk #76]**: Duplicate Summary Inflation
_Concept_: Repeating overlapping summaries at every stage transition or handoff causes the task file to grow with redundant content that adds little decision value. The file becomes padded with echoes instead of insights.
_Novelty_: The system degrades not through missing context but through repetitive context inflation.

**[Risk #77]**: No Context Compression
_Concept_: If older context is never compressed, summarized, or made skimmable, long-lived tasks become progressively harder for both humans and agents to use effectively. The canonical artifact remains complete but ceases to be operationally efficient.
_Novelty_: Fidelity without compression turns into friction.

**[Risk #78]**: Raw Validation Chatter Pollution
_Concept_: Inline raw validation logs or test chatter can drown out actual decisions, outcomes, and next actions when mixed directly into the main task narrative. Evidence becomes noise instead of support.
_Novelty_: The product mistakes exhaust for insight.

**[Risk #79]**: Commentary Over Progress Incentives
_Concept_: If the system implicitly rewards agents for producing comments, reports, or recommendations rather than advancing task state or producing actionable outputs, the workflow fills with performative activity. Users see motion without throughput.
_Novelty_: The platform accidentally optimizes for visible AI behavior instead of delivery.

**[Risk #80]**: Operator Deferral Spiral
_Concept_: The operator agent can become a bottleneck if it repeatedly defers decisions, asks for more specialist input, or punts choices back to humans instead of making clear recommendations. The task then stalls behind a coordinator that coordinates too much and decides too little.
_Novelty_: The orchestration layer fails by becoming indecisive rather than by being wrong.

**[Risk #81]**: Approval Fatigue
_Concept_: If too many transitions require human approval regardless of risk or stage semantics, the system becomes governance-heavy to the point of losing its agent-native advantage. Humans become workflow clerks again.
_Novelty_: The product defeats its own premise by reintroducing constant manual gating.

**[Guardrail #82]**: Meaningful-Comment Rule
_Concept_: Agents should comment only at meaningful progress boundaries, decisions, blockers, or explicit requests. Tiny implementation steps and low-value narration should stay out of the canonical timeline.
_Novelty_: The task file remains an operating record rather than a live debug console.

**[Guardrail #83]**: Operator Brevity Rule
_Concept_: Operator-agent comments must stay concise and purpose-driven rather than narrating internal coordination thought. The operator thread should be the cleanest voice in the system, not the loudest.
_Novelty_: The component responsible for coherence is explicitly constrained to preserve legibility.

**[Guardrail #84]**: No Duplicate Summary Rule
_Concept_: Stage summaries should supersede or update earlier summaries rather than restating overlapping context again and again. The system should avoid summary inflation across handoffs.
_Novelty_: Context stays cumulative without becoming repetitive.

**[Guardrail #85]**: Compression Threshold Rule
_Concept_: Once a task crosses a defined length or timeline threshold, older context should be compacted into concise recaps so the task remains skimmable for both humans and agents. Full history can remain available, but the active task view should privilege usable context over raw accumulation.
_Novelty_: Completeness and operational readability are balanced through explicit compression behavior.

**[Guardrail #86]**: Evidence Separation Rule
_Concept_: Raw validation logs, test chatter, and similar exhaust should stay referenced, linked, or collapsible, while the main timeline contains only outcomes, implications, and next actions. Evidence supports decisions without drowning them.
_Novelty_: The product preserves evidence fidelity without letting machine exhaust dominate the canonical task narrative.

**[Risk #87]**: Memory Drift Against Canonical Task
_Concept_: Persistent specialist or operator threads can become dangerous if their private runtime memory drifts from the current canonical task file. An agent may resume with outdated assumptions, stale plans, or obsolete constraints unless it explicitly re-anchors on the latest task state.
_Novelty_: The failure comes from remembered context being too trusted rather than from not enough context being available.

**[Risk #88]**: Runtime History Fragility
_Concept_: Provider-side chat histories can become corrupted, unavailable, or inconsistent with the task lifecycle, undermining the continuity benefits of persistent agent threads. If those histories fail without a recovery model, the system may lose part of its specialist memory unexpectedly.
_Novelty_: The product depends on persistent runtime continuity, so runtime-history fragility becomes a platform risk rather than a peripheral operational detail.

**[Guardrail #89]**: Canonical Re-Anchor Rule
_Concept_: Any persistent agent reactivated on a task must re-read the current canonical task file before acting. Private runtime history is supplemental continuity, but the task file remains the authoritative source of current task truth.
_Novelty_: Persistent memory becomes a helpful accelerator rather than a competing source of authority.

**[Guardrail #90]**: Continuity Degradation Path
_Concept_: If a provider-side runtime history is missing, corrupted, or unusable, the system should degrade gracefully by rehydrating the agent from the canonical task file and execution context instead of treating the task as unrecoverable. Private histories are valuable but not required for the system to continue operating.
_Novelty_: Persistent agent continuity becomes resilient rather than brittle because the shared task artifact remains sufficient for recovery.

**[Risk #91]**: Silent Dirty Branch State
_Concept_: Trust breaks quickly if sync or rebase failures leave a task branch in a dirty, conflicted, or ambiguous state without the task clearly signaling that problem. Agents may continue acting on an unhealthy execution branch while humans believe the task is still in a normal state.
_Novelty_: Repository state drift becomes dangerous when workflow truth fails to reflect execution reality.

**[Workflow #64]**: Conventional Ticketed PR Title
_Concept_: Pull request titles should use a conventional format such as `feat(VIB-142): Task title`. This keeps the task identity visible while making the PR feel native to existing git and repository conventions.
_Novelty_: PR titles become both task-linked and convention-friendly, bridging the management plane and the GitHub review surface cleanly.

**[Morph #55]**: Directory-Per-Task Pathing
_Concept_: Each task should live under its own directory such as `tasks/VIB-142/task.md`, using the stable task key as the directory name and a fixed canonical filename for the task artifact. This aligns naturally with the idea of each task having a durable home and later supporting additional local files if needed.
_Novelty_: The task path remains stable and readable without tying identity to mutable stage or slug information.

## Idea Organization and Prioritization

### Organized Themes

**Theme 1: Agent-Native Delivery**

- Viberr is an agent-native task operating system, not a human-native board with AI helpers.
- Humans govern, configure, review, and accept; agents are the native workers.
- Blocking is acceptable when it improves quality and decision clarity.

**Theme 2: Canonical Task Contract**

- The task is a single canonical markdown artifact in a stable task home directory.
- The task file is the shared inter-agent bus and the authoritative operating contract.
- Important events are typed inline in the timeline; everyday collaboration remains conversational.

**Theme 3: Governed Orchestration**

- Each task gets a dedicated persistent operator thread.
- Each stage has one primary specialist owner plus persistent consultants.
- Agents can append comments and event requests directly, but official state changes remain human-authorized.

**Theme 4: GitHub-Native Execution**

- Viberr projects are independent from code repositories.
- Each task attaches to a single GitHub repo in V1, typically inherited from a project default repo.
- Execution uses a task-key branch, PR-backed review, and a human-only `done` transition.

**Theme 5: File-Native Management Plane**

- Management data lives in a local filesystem store with separated domains under one root.
- The app uses file watchers plus manual re-scan.
- Human RBAC and agent policy are modeled separately.

**Theme 6: Anti-Bureaucracy Guardrails**

- Meaningful-comment rule
- Operator brevity rule
- No duplicate summary rule
- Compression threshold rule
- Evidence separation rule

### Breakthrough Concepts

- **Task-Dedicated Operator Thread:** a persistent coordinator per task.
- **Task File As Inter-Agent Bus:** the task artifact is the durable coordination medium across threads.
- **Project-Key Execution Identity:** task key links task, branch, commits, and PR.
- **Human-Authorized State Changes:** agents run the flow, but humans approve consequential official transitions.

### Concise Product Blueprint

**Positioning**

Viberr is a GitHub-native, agent-native task operating system for software delivery. It manages Jira-like projects in its own file-native management plane while attaching tasks to GitHub repositories for execution.

**Core Model**

- **Management Project:** workflow, default repo, human RBAC, and agent policy.
- **Task:** canonical markdown file in a stable task directory such as `tasks/VIB-142/task.md`.
- **Operator Agent:** dedicated persistent coordinator for one task.
- **Specialist Agents:** persistent Codex or Claude Code threads used as primary owners or consultants.
- **Repo Attachment:** one GitHub repo per task in V1.

**Core Workflow**

1. A task is created in Viberr’s management plane.
2. The operator agent validates task quality and recommends assignment.
3. When execution starts, the task attaches to its repo and gets a fresh code workspace.
4. A specialist agent works on branch `VIB-142` and writes bracketed task-key commits.
5. The operator prepares review by opening a GitHub PR at the `review` stage.
6. A human explicitly decides when the task transitions to `done`.

**Canonical Task File**

Must-have sections:

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

Optional or stage-conditional:

- Success criteria
- Validation evidence
- Test scenarios

### MVP Outline

**V1 Scope**

1. Local filesystem management store with clear root domains:
   - `projects/`
   - `agents/`
   - `runtimes/`
   - `cache/`
   - `auth/`
   - `logs/`
2. Single canonical markdown task format in per-task directories.
3. Rule-driven workflow file with stage rules, allowed transitions, assignment constraints, and approval rules.
4. Separate human RBAC and project-scoped agent capability policy.
5. Dedicated operator thread per task.
6. One primary specialist owner plus persistent consultant specialists.
7. Codex/Claude Code provider-backed runs with separate runtime histories.
8. GitHub-native integration:
   - authentication
   - project default repo with task override
   - one repo per task
   - branch name = task key
   - bracketed task-key commits
   - PR-backed review stage
9. Board card signals:
   - current stage
   - waiting on human / waiting on agent
   - assigned agent
   - validation status
10. Task page hierarchy:
   - current state and assigned execution profile first
   - latest blocking/decision packet second
   - unified timeline below
11. Typed important events:
   - `task-quality-flagged`
   - `stage-transition-requested`
   - `blocked-decision`
   - `completion-report`
   - `subtask-spawned`
   - `policy-violation`

**Out of V1**

- Multi-repo tasks
- Full VCS abstraction beyond GitHub
- Mandatory up-front success criteria for every task
- Typing every comment and interaction
- Automatic transition to `done`

### Actionable Next Steps

1. Write a short product brief from this blueprint.
2. Define the canonical task markdown schema and a concrete example task.
3. Define the workflow schema and one example project workflow.
4. Define the human RBAC file and the agent policy file.
5. Design the board card and task detail UI around the chosen information hierarchy.
6. Specify the runtime orchestration contract for Codex and Claude Code runs.
7. Specify GitHub integration flows for repo attachment, branch creation, sync boundaries, and PR opening.

## Session Summary and Insights

**Key Achievements**

- The concept was sharpened from “Cline-like kanban” into an agent-native governed delivery system.
- The core task model, workflow model, agent model, and GitHub model were made concrete.
- The highest-risk failure modes were translated into strong anti-noise and reliability guardrails.

**Most Important Insight**

The product works only if the canonical task remains a compact, readable, authoritative contract shared by humans, operator agents, specialist agents, and GitHub execution. Most good design decisions in this session reinforce that principle.
