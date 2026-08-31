---
stepsCompleted:
  - step-01-init
  - step-02-discovery
  - step-02b-vision
  - step-02c-executive-summary
  - step-03-success
  - step-04-journeys
  - step-05-domain
  - step-06-innovation
  - step-07-project-type
  - step-08-scoping
  - step-09-functional
  - step-10-nonfunctional
  - step-11-polish
# The input documents (product brief, its distillate, and the 2026-03-29 brainstorming
# session) were consumed into this PRD at drafting time; their _bmad-output copies were
# deleted in the pre-pass-13 cleanup. This document is self-standing.
inputDocuments: []
workflowType: 'prd'
documentCounts:
  briefCount: 1
  researchCount: 1
  brainstormingCount: 1
  projectDocsCount: 0
classification:
  projectType: web_app
  domain: developer_productivity
  complexity: medium
  projectContext: greenfield
---

# Product Requirements Document - Viberr

**Author:** akin-ozer
**Date:** 2026-03-30 (scope simplified 2026-06-08; reviewer & commenting amendments 2026-07-04; live-use amendments 2026-07-25; delivery, acceptance & visibility rulings 2026-07-28)

## Executive Summary

Viberr is a multi-user web application for governed AI software delivery, built for small AI-forward engineering teams that want persistent coding agents to do real delivery work while engineers keep control of flow, review, and acceptance. It closes a coordination gap: coding agents are improving fast, but task systems remain human-native and give multi-agent work no durable operating layer.

Viberr makes the task the canonical operating contract between humans, agents, and GitHub execution. Each task carries state, execution context, timeline, decisions, and evidence in one readable file. A dedicated operator agent manages each active task, specialist agent threads do the stage work, and humans govern through policy, comments, decisions, and explicit acceptance of completion.

V1 targets GitHub-backed delivery for small teams through a familiar board/task interface that behaves differently underneath: agents are the native workers, engineers govern the flow, and review stays human-authorized.

**What makes it different.** Viberr is agent-native in both action and responsibility. In Jira-like tools humans are the default workers and AI helps at the edges; in Viberr agents own task execution while engineers govern movement, approvals, and quality boundaries. Persistent agent work can't be governed through scattered chats, branches, and status labels — so Viberr provides a durable coordination layer: canonical task contracts, a dedicated operator agent per task, persistent specialist threads, and PR-backed review tied directly to task progression.

## Project Classification

- **Project Type:** Web application (single-page, authenticated, desktop-first)
- **Domain:** Developer productivity / governed AI delivery
- **Complexity:** Medium
- **Project Context:** Greenfield

## Success Criteria

**User success.** A small team can understand the state of agent-driven work without leaving Viberr or rebuilding context from other tools. For any active task, a user can quickly see the current stage, current owner, whether it's waiting on a human or an agent, the latest decision or blocker, and the linked branch/PR. The "aha" moment is supervising several persistent specialist agents across a complex project through one governed surface, instead of piecing state together from chat logs, branches, and notes.

**Business success.** Teams move real delivery work through Viberr, keep using it across many tasks, and treat it as the authoritative coordination layer for agent execution rather than a side dashboard. The strongest signal is repeated use on complex tasks where multiple agents, human decisions, and GitHub review must stay aligned.

**Technical success.** The task contract stays durable, readable, and authoritative as agent activity accumulates. Operator and specialist threads resume safely because agents re-anchor on the canonical task file, and runtime-history failures degrade gracefully instead of breaking delivery. GitHub state (branch, commits, PR) stays clearly reflected in the task and board, and multi-user collaboration stays stable without ambiguous ownership or noisy timeline collapse.

**Measurable outcomes:**

- At least 90% of active tasks show an unambiguous current owner, waiting state, and latest decision packet.
- At least 90% of executed tasks keep direct traceability between task key, branch, commits, and PR.
- Teams move an implementation task from execution start to review-ready PR faster than with their current human-native workflow.
- Blocked tasks reach a human decision quickly because operator packets are concise and actionable.
- Task readability stays acceptable on long-running tasks, with low friction from duplicated summaries or raw validation spam.

## Product Scope

**MVP.** Prove that a small team can govern persistent coding-agent work through a multi-user web interface: file-native management plane, canonical task records, rule-driven workflow, separate human RBAC and agent policy, a dedicated operator agent per task, a delivering-engagement-plus-supporting-engagements model, Codex/Claude Code backends, single-repo GitHub execution, branch and PR traceability, typed important events, and a board/task UI built for operator supervision. *(Amended 2026-08-06, pass 19 — vocabulary; this read "a primary-specialist-plus-consultants model". See FR14.)*

**Growth (post-MVP).** Richer reusable agent profiles, stronger policy tooling, analytics on agent throughput and governance load, deeper review/validation workflows, better multi-user collaboration ergonomics, and task-graph + subtask orchestration.

**Vision.** Viberr becomes the governed delivery layer for engineering organizations working with agents at scale: tasks as durable machine-readable contracts, operator agents as trusted coordinators, specialist threads as reusable expert memory, and delivery shifting from engineer-centered workflow management to agent-centered execution under human governance.

## User Journeys

**Journey 1 — Arda governs agent-driven delivery (primary success path).** Arda is a senior engineer on a small AI-forward team already using Codex and Claude Code ad hoc. Once work spans many tasks and contributors, he loses track of which agent owns what, what's blocked, and whether branch/PR state still matches reality. He opens Viberr to a familiar board, but each card shows current stage, assigned agent, waiting state, and validation status. Opening an active task, the top shows current state, execution profile, and the latest decision packet; the timeline tells a compact story — operator assigned the developer specialist, work advanced on branch `VIB-142`, the change summary ties commits and files back to the task. The win: he supervises several persistent agent threads across a complex project without losing the thread, commenting only where guidance or acceptance is needed.

**Journey 2 — Arda intervenes on a drifted task (primary edge case).** A task stays active but its board signal flips to waiting-on-human with unhealthy validation, and the latest event is a typed blocking packet, not vague chatter. The packet is concise: what was observed, what changed, the branch or validation issue, recommended options, and the decision required. Arda picks a recovery path and comments to clarify a changed requirement that invalidated the previous direction. The operator updates the flow, re-engages the right specialist with a summon note, and the specialist re-anchors on the canonical task file before acting again. Failure becomes governable, visible, and recoverable rather than opaque.

**Journey 3 — Elif configures a governed project (admin / operations).** Elif owns the workflow but doesn't monitor every task. She creates a project and configures the rule-driven workflow: stages, allowed transitions, default repo, and the conditions under which agent recommendations may advance or must stop for human review. She configures human RBAC and the agent capability matrix separately, because governing people and governing agents aren't the same problem. Setting up agent profiles, she decides which specialists are eligible for implementation, testing, and review, what skills/MCPs/knowledge bases each may load, and which agent actions are allowed in the project. Her work is front-loaded into project design and pays back in predictable behavior and lower coordination chaos.

**Journey 4 — Murat investigates a continuity failure (support / troubleshooting).** Murat is the escalation point when things look inconsistent. He's called into a task where a specialist's provider-side history is unavailable and the team fears it's unrecoverable. Opening the task, he sees the operator already surfaced a continuity warning and recorded that the specialist was rehydrated from the canonical task file rather than its private runtime history; the timeline shows the last meaningful actions, the latest branch references, and the moment continuity degraded. He confirms the task file holds enough context to continue safely. If he needs deeper debugging he drops into the provider-native thread, but that's a debug session, not the primary record; anything that should affect the task he brings back as a task comment. Runtime-history failure degrades gracefully instead of destroying trust.

**Capabilities these journeys imply:**

- **Board supervision:** cards expose stage, owner, waiting state, and validation status for fast triage.
- **Operator-first task detail:** current state, execution profile, and latest packet dominate the page.
- **Canonical task contract:** authoritative, readable, and compact across long-lived multi-agent work.
- **Governed intervention:** blocked tasks produce structured, actionable decision packets.
- **Rule-driven workflow and policy:** configurable stage rules, approval boundaries, repo defaults, and agent capability matrices.
- **Persistent but recoverable continuity:** threads persist across stages; the system recovers from missing runtime history.
- **GitHub-linked execution:** branches, commits, and PR state stay tied to task truth.
- **Multi-user governance:** distinct personas get different surfaces, from daily supervision to policy admin to deep troubleshooting.

## Domain-Specific Requirements

**Auditability.** Viberr isn't in a heavily regulated industry but operates in a governance-sensitive delivery domain. It must preserve reliable auditability of task progression, agent actions, human decisions, and repository-linked events: teams should be able to reconstruct who changed what, who approved what, and which human or agent action caused a transition.

**Security and secrets.**

- Agent execution must not expose repository, provider, or other secrets in task timelines, comments, logs, or generated evidence.
- Operational task context must be separated from sensitive runtime secrets and credentials.
- Secret access is scoped to the minimum required for the active task and agent profile.

**Permission boundaries between humans and agents.**

- Human and agent permissions stay distinct and enforceable.
- The system defines which actions agents may perform directly, which they may only recommend, and which are reserved for humans.
- Governance-critical transitions — especially task completion — stay explicitly human-authorized, with one narrow, deliberate exception: a project configured for full operator autonomy may additionally grant its operator the completion-for-acceptance capability in `direct` mode, and that operator then accepts and closes tasks itself. The grant is explicit and audited, never implied by raising autonomy, and it is disclosed in the UI wherever the human-only claim would otherwise be made. Every other path to `done` remains human. (Owner ruling Q1; recorded here 2026-07-25.)

**Runtime continuity.**

- Persistent agent histories are useful but never the sole source of truth.
- Any reactivated agent re-anchors on the canonical task artifact before acting.
- If provider-side history is unavailable or corrupted, the system degrades gracefully from the canonical task file and current execution context.

**GitHub integration.**

- Authenticated access to repositories, branch creation, commit association, PR creation, and review-state awareness.
- One GitHub repository per project; every task in it executes against that repository.
- Repo-linked execution context reflected back into the task artifact compactly.
- Branch and PR status stay visible alongside task state.

**Risk mitigations.**

- *Agents overreach their authority* → explicit agent capability policy, separate human RBAC, and human-authorized state changes.
- *Secrets leak into task artifacts or logs* → strict secret isolation, sanitized logging, and clear separation of runtime credentials from shared task state.
- *Audit trail is incomplete or ambiguous* → typed important events, durable task history, operator-mediated summaries, and direct task↔branch↔commit↔PR traceability.
- *Persistent agent memory becomes stale or unsafe* → canonical re-anchor rule and graceful recovery from missing provider-side history.

## Differentiators & Validation

**Why it's a new operating model, not "kanban with AI":**

- **Agent-native project management** — agents are the native workers; humans govern the flow. This changes the responsibility model of delivery, not just the interface.
- **Canonical task as operating contract** — the task itself is the durable contract between humans, persistent agent threads, and GitHub execution, rather than a planning artifact pointing elsewhere.
- **Persistent operator-and-specialist threads** — a task-dedicated operator plus persistent specialists that can be re-engaged over time, materially different from stateless automations or isolated agent chats.
- **Governed AI delivery through a familiar surface** — a familiar multi-user task UI over a fundamentally different operating model, adoptable by teams already used to Jira-like coordination.

**Market gap.** Today's alternatives are weak in three ways: human-native task tools where AI is peripheral; coding-agent CLIs and chats with no durable team coordination layer; and brittle, opaque internal automations. Viberr sits in the gap as the governed coordination layer for persistent agent-driven delivery — not a GitHub-review replacement or a generic AI assistant. The opportunity exists because companies increasingly want AI to build more of the codebase while senior engineers retain review and acceptance authority, yet current tooling still assumes an engineer-centered pipeline.

**Validate through workflow behavior, not feature availability:**

- Small AI-forward teams can supervise multiple persistent agent threads across real tasks without losing clarity.
- Users understand task state, blockers, ownership, and repo execution faster than with Jira-like tools plus scattered agent sessions.
- Governed intervention feels useful rather than bureaucratic, especially when a task is blocked.
- The operator-agent model improves coordination instead of adding another noisy layer.

The strongest early signal is repeated use on complex tasks where multiple agents, human approvals, and GitHub review must stay aligned. The main risks — timeline noise, operator verbosity, process theater, and memory drift — are mitigated by the anti-noise guardrails (below) and by keeping the canonical task as the single source of truth.

## Web App Requirements

- **Type:** single-page web app optimized for multi-user team workflows and agent-governance interactions — an internal operational workspace, not a public/marketing surface. SEO and crawlability are not requirements; on-premises, authenticated deployment is assumed and should inform architecture, configuration, and session handling.
- **Architecture:** prioritize fast transitions between board supervision and task intervention, and dense-timeline rendering without overwhelming the user. Near-real-time updates matter because multiple humans and multiple agent threads change task state concurrently; the platform also retains explicit recovery actions such as manual re-scan and rebuild.
- **Browser matrix:** current Chromium-based browsers. Mobile and legacy browsers are not V1 targets. (History: the matrix declared current Safari and current Firefox desktop through 2026-08-31, but neither was ever exercised here, automated or manual, in any pass — recorded 2026-08-19. The owner struck them on 2026-08-31 so the declaration matches what is verified; re-adding an engine means adding a Playwright project that actually runs it.)
- **Responsive:** desktop-first; common laptop resolutions fully support board supervision, task detail, and multi-panel workflows. Narrower viewports get the **same surface, reflowed** — multi-column layouts collapse to one column, the board's columns narrow, and secondary topbar chrome hides — not a reduced review-first mode. Every action available at desktop width, including destructive and governance actions, remains available and is expected to be used with care. (V1 planned a review-first mode below 768px; it was never built, desktop-first is the declared browser context, and the intent was retired 2026-07-25 rather than left as an instruction to build it.)
- **Performance:** board and task views feel immediate under typical small-team use; task detail stays fast on long histories via compact rendering and progressive disclosure; state updates appear quickly enough to trust Viberr as a live shared surface.
- **Accessibility:** core workflows meet a WCAG 2.2 AA baseline in V1, with light and dark mode; broader accessibility work outside core workflows may phase after MVP.

## Project Scoping & Phased Development

**MVP approach.** Problem-solving MVP with real workflow utility: prove in live use that a small AI-forward team can govern persistent agent-driven delivery through a multi-user interface, with the task as the canonical contract and GitHub as the execution surface. Prove the operating model, not every future platform idea.

**Resourcing.** A lean but strong team: 2 strong full-stack/product engineers (or 1 full-stack product engineer plus 1 systems/integration engineer), with product and UX owned by the founding team or technical lead. Workflow integrity, GitHub integration, agent-runtime orchestration, and task readability all have to be right at once — this is not a one-engineer weekend prototype if the goal is real delivery usage.

**MVP feature set (Phase 1):**

- Multi-user authenticated web app
- Local file-native management store
- Canonical task files in stable task directories
- Rule-driven workflow with explicit stage transitions and approval boundaries
- Dedicated operator agent per task
- One delivering engagement plus persistent supporting engagements, with the task's human owner tracked separately *(Amended 2026-08-06, pass 19 — vocabulary; this read "Primary specialist plus persistent consultant specialists". See FR14.)*
- Codex / Claude Code backed non-interactive runs
- Separate human RBAC and project-scoped agent capability policy
- One GitHub repo per project; every task executes against it
- Task-key branch creation and commit traceability
- PR-backed review stage; human-only transition to `done`, except for a full-autonomy operator holding an explicit completion-for-acceptance grant
- Board cards with current stage, waiting state, assigned agent, and validation status
- Task detail page with current state, execution profile, latest decision packet, and unified timeline
- Typed important events for quality flags, transition requests, blocked decisions, completion reports, and policy violations
- Branch and PR status visibility
- Anti-noise guardrails: meaningful-comment, no-duplicate-summary, compression-threshold, evidence-separation *(operator narration is stored verbatim and collapses view-side in the timeline; the write-time operator-brevity cap was removed by owner ruling 2026-08-31)*
- Agent web capabilities behind per-profile grants: search/fetch egress and a governed headless browser; agent file evidence posted on the task thread via the attachments drop *(added 2026-08-21, pass 22 — shipped 2026-08-14/20 under rulings 75 and 96; see FR9/FR17)*

**Phase 2 (post-MVP):** richer agent-profile templates; analytics on throughput, governance load, and task health; deeper validation/testing workflows; stronger small-team collaboration ergonomics; task-graph and subtask orchestration; better reporting and audit exports; refined runtime management and recovery tooling.

**Phase 3 (expansion):** broader organizational rollout for larger groups; more advanced policy and governance models; deeper planning-through-delivery lifecycle coverage; additional execution backends or ecosystem integrations if strategically justified; enterprise-grade deployment, administration, and scale.

**Risk mitigation.**

- *Technical* — the riskiest area is the intersection of persistent agent orchestration, canonical task state, and GitHub-linked execution. Keep the task as the source of truth, keep typed events minimal and meaningful, and surface branch/runtime inconsistency clearly.
- *Market* — teams may call the idea compelling but not change behavior. Target small AI-forward teams already feeling the pain, and make the MVP strong enough to run real delivery work, not just demos.
- *Resource* — building too much platform surface before proving the workflow. Keep V1 to one repo per task, GitHub only, small-team collaboration, and the minimum governance needed to make agent-native delivery trustworthy.

## Functional Requirements

### Workspace Access & Collaboration

- FR1: Team members can sign in to Viberr and access shared workspaces.
- FR2: Admin users can manage team membership and human roles, and the system enforces project and task permissions based on those roles.
- FR3: Users can collaborate in the same project with shared visibility into task state changes.
- FR4: Users can comment on tasks, addressing instructions or questions to specific agents or teammates in one unified timeline. *(Amended 2026-07-04)* Commenting is app-wide: every registered user may comment on any task, including tasks in projects they are not a member of, and non-member comments are visibly labeled as such. *(Amended 2026-07-28 — owner ruling R15-4.)* Projects are members-only surfaces: a user who is not a member of a project cannot open its board or tasks at all — the routes behave as if the project does not exist, because workflow secrecy (WI-13) wins. "App-wide" therefore means across the projects the user can see; within that visibility, cross-project commenting and its labeling stand as written.
- FR37 *(added 2026-07-04, revised)*: Each task can have one human owner who acts as its reviewer and acceptance authority; owner rights are scoped to that task only — they may comment, review, and accept or reject that task's boundaries, but gain no rights over other tasks or project configuration. A task may be unowned until a member takes it. Extends FR14/FR27. *(Amended 2026-07-25 — the "partly implemented" annotation was itself stale, and the requirement is now WIDER than it was written.)* The acceptance-authority clause ships: a task's live owner (contributor or above) accepts its completion at every acceptance writer, alongside the project's admins and maintainers. Owner ruling R14-2 then widened it — the owner governs **any** open decision on their own task, not only acceptance: resolving decision packets, applying the recommendations whose underlying action they hold, and dismissing any recommendation. The scoping clause is unchanged and is what keeps the widening safe: the authority is over that task's decisions only, and each decision's inner action keeps its own capability gate (an owner who is not a maintainer still cannot run agents or edit project policy). This closes the dead-end where the decisions inbox counted an owned task as "waiting on you" and every action on it returned 403. *(Amended 2026-07-28 — owner ruling R15-3.)* The widening now covers stage-transition recommendations too: a task's owner may apply or dismiss **any** operator recommendation on their own task, including a move the owner's own role could not authorize from the stage menu. The Apply click IS the authorization for that one recommended move — it does not grant the underlying action anywhere else, and every other capability gate still applies.
- FR38 *(added 2026-07-04, revised)*: Any contributor or above assigned to the project can take or release task ownership (self-service, no admin involvement); project admins can additionally release any owner. Ownership changes are recorded as typed events in the task timeline, and admin releases also land in the audit trail. Extends FR2/FR16. *(Amended 2026-08-21, pass 22 — this read "Any member", while the code has always floored `own-task` at **contributor** (`app/shared/rbac.ts` — take/release own task ownership: admin, maintainer, contributor; viewers excluded). The owner confirmed the code is right: ownership carries reviewer and acceptance authority over the task (FR37), which a read-only viewer must not self-assign. The requirement is corrected to match, not the code widened.)*

### Project Governance & Policy

- FR5: **[Amended — the head sentence below predates the 2026-08-06 amendment; read the amendment notes first.]** Admin users can create and configure governed delivery projects. *(Amended 2026-08-06, pass 19 — F19-29, promoted under ruling 44. The divergence below had survived two passes recorded only as a code comment and a test, which is exactly the failure mode ruling 44 exists to stop.)* **Creation is self-serve for any signed-in user; it is not admin-gated.** The `create-project` action consults no org role — its only guard is authentication — and the creator is seeded as the new project's **admin**, so the "and configure" half of this requirement holds from the moment the project exists. The omission is deliberate, not an oversight: the two neighbouring instance-maintenance intents on the same action (store re-scan, rebuild projections) each carry an explicit org-admin refusal, and this branch documents its own decision in place ("Org role is intentionally NOT consulted here", `app/routes/_index.tsx`). Pinned by `app/features/shell/workspace-routes.server.test.ts` — "any org MEMBER may create a project and is seeded its admin". Nothing downstream is widened: every configuration action still runs through the project-role matrix in `app/shared/rbac.ts`, and FR2/FR6–FR9's admin scoping is unchanged.
- FR6: Admin users can define workflow stages, allowed transitions, and approval boundaries for a project.
- FR7: Admin users can define the GitHub repository for a project. One project, one repository. *(Amended 2026-07-25 — the "and allow task-level overrides" clause was struck by owner ruling. The override was half-built: nothing ever wrote a task-level repo, the admin toggle that claimed to govern it enforced nothing, and a task pointing at another owner's repo would authenticate with the project's credential anyway. Rather than finish a feature nobody had asked for, the toggle and its copy were deleted.)*
- FR8: Admin users can define separate human access policies (RBAC) and agent capability policies for each project.
- FR9: Admin users can define reusable agent profiles (global base definitions with project customization), including each profile's eligible stages, permitted actions, permitted context resources (skills, MCPs, knowledge bases), permitted web reach — search/fetch egress and a real headless **browser** — and supported execution backend. *(Amended 2026-08-21, pass 22 — the browser is written in; it had shipped 2026-08-14 under owner ruling R19-19, `docs/architecture/decisions.md` ruling 75, and this document never recorded it: the largest post-pass-19 capability, previously undocumented here.)* `use-browser` is a first-class agent capability, default **off**, enforced on both backends by mounting or withholding a Viberr-owned Playwright MCP server per run; what the browser produces lands in the task's `attachments/` directory, member-only and citable as evidence. Granting the browser forces web egress on at every save path — the browser IS network egress (owner ruling #176, ruling 95); page content is data, never instructions, and the browser widens no other authority.

### Task Records & Lifecycle

- FR10: The system can maintain projects and task records in a file-native store that remains inspectable outside the application, and can recognize and reconcile task files that are created or edited directly in the store.
- FR11: **[Amended — the head sentence below predates the 2026-08-30 amendment; read the amendment notes first.]** Users can create tasks within a project. Agents cannot: task creation is a human act, and an agent that believes a task is needed routes it to a human through a decision packet. (The V1 clause "and authorized agents" was struck 2026-07-25 — it was never implemented on any layer, and task-graph and subtask orchestration is scoped post-MVP.) *(Amended 2026-08-30 — the controller, owner directive; `docs/architecture/decisions.md` ruling 99.)* The bar is on agents INVENTING tasks, and it stands. Two governed exceptions exist, both human-rooted: the instance controller creates a task as the INSTRUMENT of an authorized asking user (their conversational request is the human act, and the server enforces that user's own `create-task` on the call), and chained-goal advancement (FR41) creates each next link's task under the goal creator's re-proven live authority — the FR39 shape: unattended action that stays visible, cancellable, and audited, and that pauses rather than escalates when the recorded authority is gone.
- FR12: Each task can maintain a canonical operating record containing identity, goal, state, execution context, timeline, decisions, and execution references.
- FR13: Tasks can move through project-defined workflow stages under governed transition rules.
- FR14: **[Amended — the head sentence below predates the 2026-08-04 and 2026-08-29 amendments; read the amendment notes first.]** Each task can have one primary specialist and additional consultant specialists doing the execution work; the task's human owner (FR37) is tracked separately as its reviewer and acceptance authority. *(Amended 2026-08-04, pass 17 — vocabulary re-synced to the shipped model; direction D9 / Q17-5.)* The product no longer speaks of a "primary specialist" and "consultant specialists". Since the generic-agents work (2026-07-19) a task carries one uniform `engagements[]` list: **exactly one** engagement has `delivers: true` — the *delivering engagement*, sole owner of the workspace, branch and PR (the single-writer invariant) — and every other is a *supporting engagement*, read-only by default. A supporting engagement whose `verdictCapable` snapshot is true (taken from an explicit `report-validation-verdict: direct` grant at engage time) is a *required reviewer*, whose approval acceptance waits for. Read "one primary specialist" as the delivering engagement and "consultant specialists" as supporting engagements throughout; the human owner (FR37) is still tracked separately. Schema: `app/schemas/task-file.schema.ts`; see `docs/architecture/file-formats.md` §2. *(Amended 2026-08-29 — dynamic-dispatch rework, owner directive; `docs/architecture/decisions.md` ruling 98.)* The static pre-assignment of the delivering engagement and reviewers is retired: `engagements[]` is now written by the DISPATCH itself. The operator selects which deployed agent to run at each stage — weighing the current stage and the durable `previousStageId` fact — through one `run_agent` action (capability `dispatch-agents`, the collapsed assign/summon pair), and a human dispatches any deployed agent through one selector-plus-prompt control (`run-agent`). An unengaged profile engages on dispatch: delivering iff the task has no deliverer and the profile holds repo-write, supporting otherwise; an explicit delivery hand-off routes through the single-deliverer machinery. The single-writer invariant, the engage-time `verdictCapable` snapshot and the required-reviewer acceptance gate are unchanged. A dispatched run's report always tags the dispatching human and `@operator`, and its completion re-invokes the operator so coordination continues.
- FR15: Agents can flag low-quality or underspecified tasks and request human clarification before execution proceeds.
- FR16: Tasks can capture typed important events alongside conversational updates in a single chronology.
- FR17: Tasks can record validation outcomes, linked evidence references — including **files an agent posts on the task thread** — concise related change summaries, and compressed historical context while preserving continuity. *(Amended 2026-08-21, pass 22 — file evidence is written in; the attachments drop shipped under owner ask #179, `docs/architecture/decisions.md` ruling 96, and this document never recorded it: with the browser (FR9) one of the two largest post-pass-19 capabilities, previously undocumented here.)* Any run granted `attach-evidence-references` may copy files into the task's canonical `attachments/` directory during its run; whatever lands there is posted on the agent's reply, images rendering inline as timeline thumbnails with an in-app lightbox, served member-only. Browser screenshots are a special case of this general mechanic. Files humans need to SEE belong here; code and large artifacts still belong in the repository and the pull request.

### Agent Orchestration & Continuity

- FR18: The system can maintain a dedicated operator agent for each active task.
- FR19: The system can execute approved agent profiles against tasks through supported coding-agent backends (Codex / Claude Code).
- FR20: Operator agents can recommend assignments, stage transitions, and human decisions, and can trigger specialist work and re-engage consultant specialists when needed. *(Amended 2026-08-04, pass 17 — vocabulary; see FR14.)* "consultant specialists" here means supporting engagements in the shipped engagement model.
- FR21: Specialist agents can execute stage work and append outcomes, blockers, and evidence to the task record.
- FR22: Persistent agent threads can be resumed across stages and later consultations, and reactivated agents can continue from the current canonical task state even when prior runtime history is unavailable.
- FR23: Authorized users can access an agent's native runtime session for deeper debugging or intervention when needed.
- FR39 *(added 2026-07-25, recording shipped behavior)*: **[Amended — the head sentence below predates the 2026-08-21 and 2026-08-29 amendments; read the amendment notes first.]** Authorized users can schedule a future operator re-run on a task — "re-check this in 24 hours" — which a server-side runner fires when it comes due, without a human present at the moment of execution. Scheduling is itself a governed action: only a role that may run agents can create one, the scheduled entry is canonical in the task file so it survives a projection rebuild, and it never fires on a task that has reached a terminal stage. This is the one capability that lets an agent act with no human watching, so it must stay visible on the task, cancellable, and auditable. (Built under O-3; the ruling previously lived only in code comments and git history.) *(Amended 2026-08-21, pass 22 — owner ruling R22-schedule, `docs/architecture/decisions.md` ruling 94.)* The original clause "the run carries the backend and autonomy level chosen at schedule time" is struck: a scheduled entry pins **no** backend or autonomy, the schedule form offers no pickers, and the fired run resolves both from the **live deployed operator profile at fire time** (`runOperator` / `resolveOperatorAuthority`), clamped by the configured autonomy ceiling as any run is. For an unattended run set hours ahead, following the profile actually deployed when it fires matters more than freezing what was configured earlier — the frozen pin was the temporal twin of the stale-backend-display defect ruling 97 (#183) fixed, and this gives scheduled runs the same rule R21-9 gave the manual run control: the surface shows, it does not pick. (`app/server/tasks/schedule.server.ts`) *(Amended 2026-08-29 — dynamic-dispatch rework, ruling 98.)* Scheduling generalized from "operator re-run" to "a future run": `run-operator` (with an optional steer) or `run-agent` (a chosen deployed agent plus a prompt). The schedule surface is no longer a separate form — each run control carries a when-picker that turns Run into Schedule, and pending entries render under the control that scheduled them, still cancellable and auditable. The agent arm pins ONLY the profile identity; everything else resolves from the live deployment at fire time exactly as the R22-schedule clause above requires, the profile must be deployed when the entry is created, and a fire-time refusal that no retry can cure (profile undeployed since, stage-ineligible) retires the occurrence as a visible `failed` with the reason on the timeline.

- FR40 *(added 2026-08-30 — the controller; owner directive, `docs/architecture/decisions.md` ruling 99)*: The system maintains ONE instance-level conversational controller agent — machinery like the per-task operator, not a deployable specialist — that any signed-in user can address at the instance level (`/controller`) and inside any project they can see (`/projects/:slug/controller`). What it answers and what it applies is gated per tool call on THAT asking user's own live permission level, evaluated separately for the two scopes: instance management follows the org role (user administration, knowledge bases, skills, MCP connections, global agent templates, audit inspection, run analytics: org admin; creating a project, including a fully customized shape — stages, workflow boundaries, members, description — in one request: any signed-in user, FR5 parity, creator seeded admin), and board management follows the user's role in that project through the same RBAC matrix humans use (create tasks, move tasks short of Done, comment, assign owners, run agents, read GitHub state, manage deployments and policy per the existing tiers). The controller is never a privilege escalation channel: every action lands through the same governed, audited mutations humans already use, refusals are relayed out loud with their reason, nothing it offers deletes anything, and the always-human decisions (merge, acceptance, force-accept, packet resolution, the move into the terminal stage) have no controller tool at all — they stay on their own surfaces with their own confirmation ceremony. Only org admins modify the controller itself (its profile, resources, grants, and instructions); its conversations are owned by their user, readable back later by that user and org admins, and each turn is a real recorded run.
- FR41 *(added 2026-08-30 — chained goals; owner directive, ruling 99)*: Authorized users can define a GOAL — one outcome decomposed into an ordered chain of tasks inside a project — through the controller. The chain is canonical in the file store (`projects/<slug>/goals/<id>.md`), its tasks are created lazily (the first link at definition, each next link when the previous completes), each created task is a full ordinary task with its own operator, and the server advances the chain on real completion only. A failed link (its task archived) pauses the chain for humans by default (`attention`) or is skipped when the goal declares `onFailure: continue`; humans see the whole chain and redirect it — retry, skip, edit pending links, add links, pause, resume, cancel — on the project's Controller surface or conversationally. Goals are never deleted; completed and cancelled chains stay readable. Defining a chain requires the user's own `create-task` in the project; advancement re-proves the creator's live authority at every step.

### Oversight Views & Human Governance

- FR24: Users can view tasks on a board organized by workflow stage, with each card showing current stage, assigned agent, waiting state (human vs agent), and validation status.
- FR25: Users can open a task detail view that prioritizes current state, execution profile, and latest decision packet before the ongoing timeline.
- FR26: The system can generate structured blocking and decision packets for human review when agent work requires intervention.
- FR27: **[Amended — the head sentence below predates the 2026-07-28, 2026-08-04 and 2026-08-06 amendments; read the amendment notes first.]** Human users can approve, reject, or redirect consequential task changes (including stage advancement and completion). Transition to `done` is human by default and enforced server-side; the single exception is a project running its operator at full autonomy with an explicit `direct` completion-for-acceptance grant, in which case that operator accepts and closes the task itself (it still refuses a task with failing validation). Raising autonomy alone never confers this — the capability must be granted deliberately, and it is audited. *(Amended 2026-07-28 — owner ruling R15-1.)* Human acceptance is verdict-gated: accepting completion requires a review PR whose head carries the delivered revision and a healthy reviewer verdict on that revision, enforced at every acceptance writer. An explicit Force-accept is the only bypass for a missing or failing verdict — audited as such, and never a bypass for a PR head that does not match the delivered work. Every acceptance, gated or forced, passes through a confirmation dialog stating what will merge and naming any missing signals before the click counts. *(Amended 2026-08-04, pass 17 — owner ruling R16-6.)* "Done" means two different things depending on who accepted, and the difference is load-bearing: `merge-pull-request` is `ALWAYS_HUMAN`, so a full-autonomy operator acceptance does **not** perform the merge — it records the PR as `accepted` (**merge pending**), moves the task to `done`, and a human completes the actual merge afterward. Only a *human* acceptance triggers the real async merge. "That operator accepts and closes the task itself" above therefore means the operator reaches `done` with the merge still pending, never that the operator merges the PR. *(Amended 2026-08-06, pass 19 — owner rulings R17-2 and R19-1, recorded here for the first time; `docs/architecture/decisions.md` rulings 43 and 55.)* A third ending exists and no requirement recorded it: **"Completed — no changes"**. A task that verifiably has nothing to deliver — an empty diff against the base, or no branch at all because the work was verification only — closes to `done` through acceptance without a PR and without a merge, as its own timeline event and behind its own confirmation dialog. It is still acceptance, not a bypass: the reviewer approval and the owner/maintainer authority above are unchanged, and the "nothing to deliver" claim is re-verified against the live remote at the moment of the close, so a branch that has gained commits since cannot ride a stale flag into `done`. Force-accept and Archive were previously the only exits for a zero-diff task, and the refusal copy claimed "delivered work" for a task that had none.
- FR28: Users can review current task progress without needing raw provider logs or raw validation output.

### GitHub Delivery & Traceability

- FR29: The system can authenticate to GitHub and access authorized repositories for task execution.
- FR30: Each task executes against its project's repository. One repository per project in V1; there is no per-task override (see FR7).
- FR31: The system can create and manage task-key execution branches and associate commits, changed-file references, and review-stage pull requests with the originating task. *(Amended 2026-07-28 — owner ruling R15-2.)* Delivery — pushing the task branch and opening the review pull request — is an operator decision, not a side-effect bound to any fixed stage. The operator weighs the task's remaining stages and delivers when it judges the work plausibly ready for review; when unsure, it opens a decision packet asking whether to push and open the PR, and it may offer early delivery when later stages (such as QA) are not needed for the task. The server still executes the mechanics, a human can trigger delivery directly (audited), and specialist agents never push or open PRs themselves. Reaching a review stage with no PR is announced with a typed event, never silently.
- FR32: Users can view branch and pull request status alongside task state.

### Integrity, Audit & Recovery

- FR33: The system can preserve an auditable history of human decisions, agent actions, workflow changes, and policy-relevant events. *(Bounded 2026-07-25.)* Audit rows are retained for **90 days** and then hard-deleted by a retention pass that runs on every boot; before deleting, the pass appends the expiring rows verbatim to a JSONL export under the data root (`audit-exports/`), and an export failure skips that pass's purge rather than losing the rows (ruling 102, owner decision 2026-08-31 — this amended the original "no export path in V1" bound). Task-scoped history is additionally written to the canonical `task.md` and survives indefinitely. Org- and auth-scoped events have no file counterpart, so the export file is their only record past 90 days; the on-demand admin download (100k-row cap) remains for in-window snapshots.
- FR34: The system can isolate secrets and credentials from task-visible artifacts, comments, and audit records.
- FR35: The system can record task quality issues and policy violations as first-class events.
- FR36: Users can trigger manual project re-scan and state reconciliation when automated change detection misses updates.

## Non-Functional Requirements

### Responsiveness

*(Amended 2026-08-08, pass 19 — owner ruling R19-9; section renamed from "Performance". NFR1–NFR4 previously carried numeric targets: board render in 2 seconds or less at 200 cards, task detail in 2 seconds or less at p95, a state-changing action reflected in 3 seconds or less at p95, cross-user propagation within 5 seconds. **All four figures are struck.** Not one was ever measured: there is no performance harness, nothing in the product records a p95, and no test or check goes red when a figure is missed. The gap was carried across several passes as open question D17 — "asserted, not verified" — which is a long way of saying the numbers were decoration. A target nobody measures is a claim, not a requirement, and printing one here teaches the reader that this document's other numbers may be decorative too; that is the real cost, because the requirements around them — the secret-leak, audit, traceability, idempotency and continuity rules of NFR7, NFR10, NFR15, NFR16 and NFR17 — carry real guards in the code and deserve to be read as binding. The replacements below state what the product can honestly be held to. NFR5 survives verbatim because it is an architectural constraint the code honours, not a stopwatch reading. If a numeric latency budget is ever wanted, it arrives in the same change as the harness that measures it — never before it.)*

- NFR1: The board must stay usable as a supervision surface for a project's full task set. It renders every task the viewer is entitled to see; no control, filter, or state is hidden to save render time. The board is not virtualized and its query is unbounded, so a very large project is a known scaling limit to be measured and fixed when a real one exists — not a reason to silently truncate the board today.
- NFR2: Opening a task must surface its decision-relevant truth — current state, latest decision packet, execution truth — ahead of its depth. Timeline history, run logs, and supporting evidence load progressively behind that first answer (NFR5), so what it takes to get a useful task view does not grow with the task's age.
- NFR3: Every user-initiated action that changes task state must acknowledge itself in the UI: a pending affordance while it is in flight, then either the new state or a stated reason for the failure. No consequential action may complete or fail silently, and none may leave the user unable to tell which happened.
- NFR4: Shared task-state updates within an active project must reach other connected users without anyone pressing refresh. The mechanism is the server event stream, with a periodic reconciliation pass as the fallback for changes that originate outside the app; the requirement is that a second viewer converges on its own.
- NFR5: Timeline rendering for long-lived tasks should remain usable without requiring the client to load the full raw execution history at once. *(Retained 2026-08-08 under R19-9 as a behavioural requirement rather than a timing one — it is the one item in this section the code already enforces: the task loader serves a bounded newest-first timeline slice and a bounded run-log window, and the console pages backwards on demand. See `app/features/task-detail/timeline-slice.ts`, `app/routes/project.task.tsx` and `app/routes/resources.run-log.ts`.)*

### Security

- NFR6: All authenticated application traffic and external service traffic must be encrypted in transit.
- NFR7: Repository credentials, provider credentials, tokens, and secrets must never be written to task-visible timelines, comments, audit views, or general application logs.
- NFR8: The system must enforce separate permission boundaries for human users and agent profiles on every governed action. *(Amended 2026-08-14, pass 20 — owner ruling 39 / R16-5. MCP server grants sit OUTSIDE the capability matrix: granting a profile an MCP server is itself the authorization to use that server's tools, whatever they do, because Viberr will not pretend to bound a third-party tool it does not define. The consequence is deliberate, not a gap — an agent whose `execute-code-or-write-repo` capability is `off` can still reach the write tools of a granted MCP server. "Every governed action" therefore means every action Viberr itself defines and gates; a granted server's tools are authorized as a unit by the grant, and that boundary is disclosed in the capability-matrix UI and pinned by the absence of any `mcp__*` deny rule. This is the amendment note ruling 39 cites and that this line previously lacked; recorded here so a reader of the PRD alone does not get the opposite impression. D13.)*
- NFR9: The system must apply least-privilege access for GitHub and runtime-provider credentials based on project policy and active task context.
- NFR10: Security-relevant actions (policy changes, credential failures, unauthorized action attempts, and human approval actions) must be recorded in audit records.

### Reliability & Recovery

- NFR11: The system should maintain task-state consistency across application restarts without losing canonical task history or official workflow state.
- NFR12: If an agent runtime history is unavailable, the system must allow task continuation from canonical task state without requiring manual reconstruction from external tools.
- NFR13: Manual reconciliation and project re-scan operations must be available and complete without corrupting canonical task state.

### Integration Integrity

- NFR14: GitHub integration failures (including branch and PR status problems) must be surfaced to users with task-relevant context. *(Amended 2026-08-15, pass 20 — owner ruling 63 / R19-9 applied to the fifth number it missed. The original text required surfacing "within 10 seconds of detection"; that figure is struck. Nothing measures it — the only code citing NFR14 (`app/server/github/pr-open.server.ts`) implements the surfacing, not the budget, and no harness records a detection-to-surface latency — so it was exactly the unenforced number ruling 63 struck NFR1–NFR4 for. The surfacing requirement itself stands and is real: a GitHub failure reaches the task with task-relevant context and never fails silently. Only the stopwatch reading is dropped, under ruling 63's standing rule that a latency budget lands in the same change as the harness that measures it, never before it. D13.)*
- NFR15: Task-linked branch, commit, and PR references must remain uniquely traceable to the originating task key.
- NFR16: The system must preserve idempotent behavior for external execution actions so that retries do not create duplicate official task transitions, duplicate branch records, or duplicate PR associations.
- NFR17: Supported coding-agent runtime integrations must preserve agent-identity continuity across resumed task work, or fail explicitly when continuity cannot be maintained.

### Auditability

- NFR18: The system must preserve a durable audit trail of human approvals, workflow transitions, assignment changes, policy-relevant events, and agent-generated important events — enough for an authorized user to reconstruct who initiated a consequential action, when it occurred, and which task or project state changed — and must keep it available after application restarts, resynchronization events, and runtime failures. Durability here means across those events, not indefinitely: retention is bounded per FR33.
