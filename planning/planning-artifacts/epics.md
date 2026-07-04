---
stepsCompleted: [1, 2, 3, 4]
inputDocuments:
  - "/Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/prd.md"
  - "/Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/architecture.md"
  - "/Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/ux-design-specification.md"
  - "/Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/product-brief-viberr.md"
  - "/Users/akinozer/projects/viberr/docs/plans/2026-04-01-viberr-figma-design-consolidation.md"
  - "https://www.figma.com/design/QuwgAdFjg86lxm0womTFWN/Viberr-Signal-Console-Unified-Design"
---

# Viberr - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for Viberr, decomposing the requirements from the PRD, UX Design, Architecture requirements, product brief, and active Figma design inputs into implementable stories.

The wireframe specification was intentionally excluded from this extraction pass per user direction. The active design authority for epic planning is the UX specification plus the consolidated Figma file and design note.

## Requirements Inventory

### Functional Requirements

FR1: Team members can sign in to Viberr and access shared workspaces.
FR2: Admin users can manage team membership and human roles.
FR3: The system can enforce project and task permissions based on human roles.
FR4: Users can collaborate in the same project with shared visibility into task state changes.
FR5: Users can comment on tasks and address instructions or questions to specific agents or teammates.
FR6: Admin users can create and configure governed delivery projects.
FR7: Admin users can define workflow stages, allowed transitions, and approval boundaries for a project.
FR8: Admin users can define a default GitHub repository for a project and allow task-level overrides.
FR9: Admin users can define separate human access policies and agent capability policies for each project.
FR10: Admin users can define reusable agent profiles and customize them for a project.
FR11: Admin users can define each agent profile's eligible stages, permitted actions, permitted context resources, and supported execution backend.
FR12: The system can maintain projects and task records in a file-native management store that remains inspectable outside the application.
FR13: Users and authorized agents can create tasks within a project.
FR14: The system can recognize and reconcile task files that are created or edited directly in the management store.
FR15: Each task can maintain a canonical operating record containing identity, goal, state, execution context, timeline, decisions, and execution references.
FR16: Tasks can move through project-defined workflow stages under governed transition rules.
FR17: Each task can have one primary specialist owner and additional consultant specialists.
FR18: Agents can flag low-quality or underspecified tasks and request human clarification before execution proceeds.
FR19: Tasks can capture typed important events alongside conversational updates in a single chronology.
FR20: Agents can propose subtasks and humans can approve them before those subtasks become active.
FR21: Tasks can record validation outcomes, linked evidence references, concise related change summaries, and compressed historical context while preserving continuity.
FR22: The system can maintain a dedicated operator agent for each active task.
FR23: The system can execute approved agent profiles against tasks through supported coding-agent backends.
FR24: Operator agents can recommend assignments, stage transitions, and human decisions based on task context and project policy.
FR25: Operator agents can trigger specialist agent work and re-engage consultant specialists when needed.
FR26: Specialist agents can execute stage work and append outcomes, blockers, and evidence to the task record.
FR27: Persistent agent threads can be resumed across stages and later consultations on the same task.
FR28: Reactivated agents can continue work from the current canonical task state even when prior runtime history is unavailable.
FR29: Authorized users can access an agent's native runtime session for deeper debugging or intervention when needed.
FR30: Users can view tasks on a board organized by workflow stage.
FR31: Users can see each task's current stage, assigned agent, waiting state, and validation status from the board.
FR32: Users can open a task detail view that prioritizes current state, execution profile, latest decision packet, and ongoing timeline.
FR33: The system can generate structured blocking and decision packets for human review when agent work requires intervention.
FR34: Human users can approve, reject, or redirect consequential task changes, including stage advancement, subtask activation, and completion.
FR35: Only human users can transition a task to done.
FR36: The system can distinguish whether a task is waiting on a human or waiting on an agent.
FR37: Users can review current task progress without needing raw provider logs or raw validation output.
FR38: The system can authenticate to GitHub and access authorized repositories for task execution.
FR39: Each task can attach to one GitHub repository in V1, inheriting the project default unless overridden.
FR40: The system can create and manage task-linked execution branches using the task key.
FR41: The system can open and associate commits, changed file references, and review-stage pull requests with the originating task.
FR42: The system can synchronize task branches with the target repository at governed workflow boundaries.
FR43: The system can prevent execution-critical progression when branch health is unresolved.
FR44: Users can view branch health and pull request status alongside task state.
FR45: The system can preserve an auditable history of human decisions, agent actions, workflow changes, and policy-relevant events.
FR46: The system can isolate secrets and credentials from task-visible artifacts, comments, and audit records.
FR47: The system can record task quality issues and policy violations as first-class events.
FR48: Users can trigger manual project re-scan and state reconciliation when automated change detection misses updates.

### NonFunctional Requirements

NFR1: The board view should load and render an active project with up to 200 visible task cards in 2 seconds or less under normal operating conditions.
NFR2: A task detail view should load its current state, latest decision packet, and recent timeline context in 2 seconds or less for at least 95% of requests under normal operating conditions.
NFR3: User-initiated actions that change governed task state, such as approval, reassignment, or transition decisions, should reflect in the UI in 3 seconds or less for at least 95% of requests.
NFR4: Shared task-state updates within an active project should become visible to other connected users within 5 seconds under normal operating conditions.
NFR5: Timeline rendering for long-lived tasks should remain usable without requiring the client to load the full raw execution history at once.
NFR6: All authenticated application traffic and external service traffic must be encrypted in transit.
NFR7: Repository credentials, provider credentials, tokens, and secrets must never be written to task-visible timelines, comments, audit views, or general application logs.
NFR8: The system must enforce separate permission boundaries for human users and agent profiles on every governed action.
NFR9: The system must apply least-privilege access for GitHub and runtime-provider credentials based on project policy and active task context.
NFR10: Security-relevant actions, including policy changes, credential failures, unauthorized action attempts, and human approval actions, must be recorded in audit records.
NFR11: The system should maintain task-state consistency across application restarts without losing canonical task history or official workflow state.
NFR12: If an agent runtime history is unavailable, the system must allow task continuation from canonical task state without requiring manual reconstruction from external tools.
NFR13: Sync, rebase, branch-health, or PR-linkage failures must surface as explicit task-visible blocking conditions rather than silent background failures.
NFR14: No task may advance through execution-critical workflow transitions while its associated branch state is conflicted, unresolved, or unknown.
NFR15: Manual reconciliation and project re-scan operations must be available and complete without corrupting canonical task state.
NFR16: A single V1 deployment should support at least 25 concurrently active human users without breaching the defined performance thresholds.
NFR17: A single V1 deployment should support at least 50 active projects and 5,000 total task records without loss of task integrity or audit history.
NFR18: Growth in historical task volume should not materially degrade the responsiveness of current board and task views when normal archival, compression, or summarization rules are in effect.
NFR19: GitHub integration failures must be surfaced to users with task-relevant context within 10 seconds of detection.
NFR20: Task-linked branch, commit, and PR references must remain uniquely traceable to the originating task key.
NFR21: The system must preserve idempotent behavior for external execution actions so that retries do not create duplicate official task transitions, duplicate branch records, or duplicate PR associations.
NFR22: Supported coding-agent runtime integrations must preserve agent identity continuity across resumed task work, or fail explicitly when continuity cannot be maintained.
NFR23: The system must preserve a durable audit trail of human approvals, workflow transitions, assignment changes, policy-relevant events, and agent-generated important events for every task.
NFR24: Audit records must allow an authorized user to reconstruct who initiated a consequential action, when it occurred, and which task or project state changed as a result.
NFR25: Audit and task-history records must remain available after normal application restarts, resynchronization events, and runtime failures.

### Additional Requirements

- Use a four-layer model of file corpus, interpretation layer, projection layer, and diagnostics layer so every view remains re-derivable from current files plus current external facts.
- Treat files as the only authoritative business state; humans and agents may both modify them directly, and app writes do not outrank direct edits.
- Keep workflow stage separate from readiness state.
- Standardize canonical readiness states as `ready`, `input_required`, `inconsistency_risk_detected`, and `blocked`.
- Model waiting target, assigned agent, branch health, review linkage, and runtime-memory availability as secondary signals rather than replacing readiness state.
- Treat runtime-memory loss as a secondary execution signal; if missing context matters, move the task to `input_required`.
- Initialize the application with the React Router Node.js starter and Docker-friendly runtime baseline.
- Use SQLite 3.52.0 in production for projections, diagnostics, provenance, session/auth metadata, and execution metadata, while keeping files as business truth.
- Use SQL-first migrations checked into source control and keep projection schema evolution decoupled from markdown file evolution.
- Use Zod 4 at parse and action boundaries with tolerant parsing that emits diagnostics and readiness changes instead of dropping malformed input.
- Do not use a distributed cache; only allow local reconstructable caches and infra/web caching that does not hide authoritative state changes.
- Use OAuth-first human login with Google and GitHub providers.
- Use cookie-only sessions with small stable claims only; do not store dynamic authorization or execution metadata in the cookie.
- Keep human RBAC and agent capability policy as separate authorization systems.
- Use GitHub OAuth only for user identity and require user-provided fine-grained PATs for repository execution access.
- Encrypt PATs and other credentials at rest and surface PAT scope, expiry, org approval, revocation, and repo mismatch diagnostics before execution fails.
- Enforce secure cookies, CSRF protection, and action-level authorization on all state-changing flows.
- Use React Router loaders/actions as the default app interface and add explicit JSON endpoints only when automation or runtime coordination requires them.
- Use SSE for server-to-client state propagation with replay-safe reconnect and revalidation behavior.
- Prefer route-local loader/action state and narrow React context; avoid a heavy global client store unless a proven cross-route need emerges.
- Organize the product by operational surfaces: board supervision, task detail, project policy/admin, org admin, and auth/session.
- Optimize long timelines and dense boards with virtualization or progressive disclosure.
- Target single-node Docker deployment for production with self-hosted and on-prem operation as first-class requirements.
- Use GitHub Actions for CI/CD covering typecheck, lint, tests, migration checks, and build integrity.
- Validate environment configuration at startup and fail fast on missing or malformed required configuration.
- Emit structured JSON logs with request/job correlation and track projection rebuilds, parse diagnostics, auth events, PAT validation, and GitHub sync failures.

### UX Design Requirements

UX-DR1: Implement a desktop-first supervision experience where the board is the primary attention-routing surface and the task detail view is the primary decision surface.
UX-DR2: Support three responsive capability modes: full supervision on desktop, reduced supervision on tablet/smaller desktop widths, and review-first mode on mobile.
UX-DR3: Keep the task-detail top section focused on current state, execution profile, latest decision or diagnostic packet, and decision-relevant execution truth before timeline depth or raw evidence.
UX-DR4: Make board scanning answer "what needs me now?" quickly through compact high-signal task cards that keep stage, readiness/waiting cues, assignment, and urgency visible without opening the task.
UX-DR5: Use packet-first interaction design for consequential moments so blocking, transition, completion, and continuity decisions are framed as compact structured packets before raw history.
UX-DR6: Place approve, redirect, request-clarification, comment, and reassignment actions near the decision context they affect rather than separating action from evidence.
UX-DR7: Keep supporting evidence, logs, validation detail, and deep technical context progressively disclosed rather than embedded in the primary task-decision surface.
UX-DR8: Standardize state semantics across board, task, packet, and recovery surfaces around the architecture's readiness model (`ready`, `input_required`, `inconsistency_risk_detected`, `blocked`) plus explicit secondary signals for waiting target, continuity degradation, review state, and GitHub execution health.
UX-DR9: Implement a reusable Task Status Card component for board and queue contexts with keyboard focusability, non-color-only state cues, compact/expanded variants, and support for assignment plus latest packet cues.
UX-DR10: Implement a reusable Decision Packet component with packet type, severity, observed issue, impact summary, recommended options, confidence/risk framing, and accessible decision actions.
UX-DR11: Implement a reusable Execution Truth Strip component that keeps branch status, PR linkage, validation state, runtime continuity, and latest sync health visible next to task state.
UX-DR12: Implement a reusable Mixed Timeline Item component that unifies human comments, agent comments, and typed important events in one readable chronology with expandable detail and linked evidence.
UX-DR13: Implement a reusable Continuity Recovery Panel that explains what is known, what is missing, what remains authoritative, and which safe recovery or escalation paths are available.
UX-DR14: Implement shared semantic product patterns for waiting state, execution profile, packet severity, and task health/readiness so the same product meaning renders consistently across multiple surfaces.
UX-DR15: Provide design-system foundation primitives for buttons, icon buttons, search and text inputs, text areas, select/combobox/filter controls, tabs, segmented controls, breadcrumbs, dialogs, drawers, popovers, tooltips, cards, panels, tables, list containers, badges, labels, status chips, command surfaces, and layout primitives.
UX-DR16: Implement the visual language from the active design set using calm operational neutrals, blue active emphasis, green ready/healthy signaling, amber warning/risk signaling, and restrained red/coral blocked or degraded signaling, with meaning never carried by color alone.
UX-DR17: Implement a scan-first typography system using IBM Plex Sans for primary UI text and IBM Plex Mono for task keys, branches, commits, agent identities, and other code-adjacent metadata.
UX-DR18: Use an 8px spacing system with 4px sub-steps, a 12-column major layout grid, compact board density, and structured task layouts that separate current state, packet, timeline, and supporting evidence.
UX-DR19: Preserve layout stability during loading and refresh with skeletons or known-shape placeholders preferred over disruptive full-page spinners.
UX-DR20: Use inline feedback as the primary confirmation for consequential task-state, waiting-state, assignment, and governance changes, and reserve toasts for brief non-critical acknowledgements only.
UX-DR21: Keep project-level navigation stable across board, queue, review, and settings, and preserve enough board context when entering and leaving tasks that filters, recent focus, and queue position do not reset unnecessarily.
UX-DR22: Keep supporting evidence secondary and progressively disclosed so the base page context already contains consequential blocked, degraded, or recovery truth without requiring modals or overlays.
UX-DR23: Make search and filtering fast, compact, and composable, with defaults oriented around `needs me`, `blocked`, `waiting on human`, and degraded continuity conditions.
UX-DR24: Meet WCAG 2.2 AA for core workflows, including visible keyboard focus, semantic HTML/ARIA support, non-color-only state meaning, accessible status announcements, and readable recovery guidance.
UX-DR25: Test board, task, review, and settings flows across breakpoint ranges and current Chromium, Safari, and Firefox desktop browsers, and validate core flows with keyboard-only and screen-reader usage using VoiceOver and NVDA at minimum.
UX-DR26: Implement the active Figma screen set as the initial product surface inventory: Foundations, Supervision Board, Task Detail Decision Packet view, Task Detail Diagnostic Console view, Project Policy & Rules, and Continuity Recovery.
UX-DR27: Implement the local design tokens and Figma-backed component baseline from the consolidated design file, including color, space, and radius variable collections plus core text styles.
UX-DR28: Include the Figma-backed standalone primitives already defined in the active design file: `Button/Primary`, `Button/Ghost`, `StatusChip/Ready`, `StatusChip/Drifted`, `StatusChip/Blocked`, `SidebarItem/Default`, `SidebarItem/Active`, and `TaskCard/Base`, while aligning final state labels with the canonical readiness model where naming differs.

### FR Coverage Map

FR1: Epic 1 - Workspace Access and Governed Project Setup
FR2: Epic 1 - Workspace Access and Governed Project Setup
FR3: Epic 1 - Workspace Access and Governed Project Setup
FR4: Epic 2 - File-Native Task Management and Shared Supervision
FR5: Epic 2 - File-Native Task Management and Shared Supervision
FR6: Epic 1 - Workspace Access and Governed Project Setup
FR7: Epic 1 - Workspace Access and Governed Project Setup
FR8: Epic 1 - Workspace Access and Governed Project Setup
FR9: Epic 1 - Workspace Access and Governed Project Setup
FR10: Epic 1 - Workspace Access and Governed Project Setup
FR11: Epic 1 - Workspace Access and Governed Project Setup
FR12: Epic 2 - File-Native Task Management and Shared Supervision
FR13: Epic 2 - File-Native Task Management and Shared Supervision
FR14: Epic 2 - File-Native Task Management and Shared Supervision
FR15: Epic 2 - File-Native Task Management and Shared Supervision
FR16: Epic 2 - File-Native Task Management and Shared Supervision
FR17: Epic 3 - Governed Agent Execution and Human Steering
FR18: Epic 3 - Governed Agent Execution and Human Steering
FR19: Epic 2 - File-Native Task Management and Shared Supervision
FR20: Epic 2 - File-Native Task Management and Shared Supervision
FR21: Epic 2 - File-Native Task Management and Shared Supervision
FR22: Epic 3 - Governed Agent Execution and Human Steering
FR23: Epic 3 - Governed Agent Execution and Human Steering
FR24: Epic 3 - Governed Agent Execution and Human Steering
FR25: Epic 3 - Governed Agent Execution and Human Steering
FR26: Epic 3 - Governed Agent Execution and Human Steering
FR27: Epic 3 - Governed Agent Execution and Human Steering
FR28: Epic 3 - Governed Agent Execution and Human Steering
FR29: Epic 3 - Governed Agent Execution and Human Steering
FR30: Epic 2 - File-Native Task Management and Shared Supervision
FR31: Epic 2 - File-Native Task Management and Shared Supervision
FR32: Epic 3 - Governed Agent Execution and Human Steering
FR33: Epic 3 - Governed Agent Execution and Human Steering
FR34: Epic 3 - Governed Agent Execution and Human Steering
FR35: Epic 3 - Governed Agent Execution and Human Steering
FR36: Epic 2 - File-Native Task Management and Shared Supervision
FR37: Epic 2 - File-Native Task Management and Shared Supervision
FR38: Epic 1 - Workspace Access and Governed Project Setup
FR39: Epic 4 - GitHub-Linked Delivery and Execution Traceability
FR40: Epic 4 - GitHub-Linked Delivery and Execution Traceability
FR41: Epic 4 - GitHub-Linked Delivery and Execution Traceability
FR42: Epic 4 - GitHub-Linked Delivery and Execution Traceability
FR43: Epic 4 - GitHub-Linked Delivery and Execution Traceability
FR44: Epic 4 - GitHub-Linked Delivery and Execution Traceability
FR45: Epic 5 - Auditability, Diagnostics, and Recovery
FR46: Epic 5 - Auditability, Diagnostics, and Recovery
FR47: Epic 5 - Auditability, Diagnostics, and Recovery
FR48: Epic 5 - Auditability, Diagnostics, and Recovery

## Epic List

### Epic 1: Workspace Access and Governed Project Setup
Admins and team members can sign in, manage workspace access, configure governed projects, define workflow policy, define agent profiles, and prepare project-level repository settings so Viberr is usable as a governed delivery workspace from day one.
**FRs covered:** FR1, FR2, FR3, FR6, FR7, FR8, FR9, FR10, FR11, FR38

### Epic 2: File-Native Task Management and Shared Supervision
Teams can create and collaborate on canonical file-native tasks, reconcile direct file edits, and use board and task views to understand current task state, readiness, and collaboration context without relying on raw logs.
**FRs covered:** FR4, FR5, FR12, FR13, FR14, FR15, FR16, FR19, FR20, FR21, FR30, FR31, FR36, FR37

### Epic 3: Governed Agent Execution and Human Steering
Tasks can be owned by operator and specialist agents, run through governed execution, generate intervention packets, request clarification, resume from canonical task state, and require explicit human approval for consequential decisions and final completion.
**FRs covered:** FR17, FR18, FR22, FR23, FR24, FR25, FR26, FR27, FR28, FR29, FR32, FR33, FR34, FR35

### Epic 4: GitHub-Linked Delivery and Execution Traceability
Task execution can attach to a repository, create governed task branches, link commits and pull requests back to the task, synchronize at workflow boundaries, and surface branch and pull request health as part of operational truth.
**FRs covered:** FR39, FR40, FR41, FR42, FR43, FR44

### Epic 5: Auditability, Diagnostics, and Recovery
Users can trust Viberr under stress because the system preserves audit history, isolates secrets, records policy or quality issues, and supports manual re-scan and reconciliation when file, runtime, or repository state needs recovery.
**FRs covered:** FR45, FR46, FR47, FR48

## Epic 1: Workspace Access and Governed Project Setup

Admins and team members can sign in, manage workspace access, configure governed projects, define workflow policy, define agent profiles, and prepare project-level repository settings so Viberr is usable as a governed delivery workspace from day one.

### Story 1.1: Initialize Viberr Baseline Runtime, Environment, and CI Scaffold

As a developer,
I want Viberr scaffolded from the approved React Router starter and wired with typed environment handling plus baseline CI validation,
So that the team starts from the approved runtime and operational foundation before feature work begins.

**FRs implemented:** None (foundational prerequisite for Epic 1)

**Acceptance Criteria:**

**Given** the implementation repo is being initialized
**When** the approved starter command is run
**Then** Viberr is scaffolded from `npx create-react-router@latest --template remix-run/react-router-templates/default`
**And** the resulting project uses the validated React Router Node.js baseline.

**Given** the starter project has been created
**When** baseline configuration is added
**Then** required environment variables are defined through a typed environment module
**And** the app fails clearly when required configuration is missing or invalid.

**Given** the baseline project is initialized
**When** the repository automation baseline is added
**Then** a GitHub Actions workflow validates install and build success on the default branch
**And** the workflow remains minimal enough to support later stories without prebuilding business features.

**Given** the baseline scaffold is complete
**When** the app is run and built
**Then** local startup and production build both succeed
**And** the project is ready for the remaining Epic 1 stories.

### Story 1.2: OAuth Workspace Sign-In

As a team member,
I want to sign in with Google or GitHub,
So that I can securely access Viberr workspaces I belong to.

**FRs implemented:** FR1

**Acceptance Criteria:**

**Given** an unauthenticated user on the sign-in screen
**When** they choose Google or GitHub and complete a valid OAuth flow
**Then** Viberr creates a cookie-only session with compact stable claims
**And** the user lands in an authorized workspace entry flow.

**Given** a user who authenticates successfully but is not a member of any workspace
**When** the callback completes
**Then** Viberr does not grant workspace access
**And** instead shows a clear authorized-but-no-access state.

**Given** an invalid, expired, or cancelled OAuth callback
**When** sign-in fails
**Then** Viberr shows an inline error state and creates no usable session
**And** records the auth failure as a security-relevant event.

**Given** an authenticated session
**When** any state-changing auth-adjacent action is attempted
**Then** the flow uses secure cookie handling
**And** baseline CSRF protection is enforced.

### Story 1.3: Team Membership and Human Role Management

As an admin,
I want to add team members and assign human roles,
So that workspace and project access is governed correctly.

**FRs implemented:** FR2, FR3

**Acceptance Criteria:**

**Given** an admin viewing workspace membership
**When** they add or update a member's role
**Then** the membership list reflects the change
**And** the affected user's authorized access changes accordingly.

**Given** a non-admin user
**When** they attempt to manage team membership or human roles
**Then** Viberr blocks the action
**And** returns an authorized-but-forbidden result without exposing admin controls.

**Given** a project or task action protected by role rules
**When** a user without the required human role attempts it
**Then** the action is denied consistently at the server boundary
**And** no protected change is applied.

**Given** a membership or role change
**When** it is saved
**Then** Viberr records an audit event identifying who made the change and when it happened
**And** captures what changed.

### Story 1.4: Governed Project Creation and Workflow Rule Setup

As an admin,
I want to create a governed delivery project with workflow stages and transition rules,
So that task progression follows explicit policy instead of ad hoc decisions.

**FRs implemented:** FR6, FR7

**Acceptance Criteria:**

**Given** an admin creating a new project
**When** they provide the required project metadata and save it
**Then** Viberr creates the project
**And** makes it available in the workspace.

**Given** a project admin editing workflow configuration
**When** they define stages, allowed transitions, and approval boundaries
**Then** Viberr stores the governed workflow definition
**And** exposes it through the project settings surface.

**Given** an invalid workflow rule set such as conflicting transitions or incomplete required configuration
**When** the admin attempts to save
**Then** Viberr prevents the save
**And** shows field-level or rule-level validation in context.

**Given** the project settings UI
**When** an admin navigates and edits workflow rules
**Then** the screen follows the structured Project Policy and Rules pattern
**And** supports accessible labels, keyboard use, and stable inline feedback.

### Story 1.5: Project Repository Access and Fine-Grained PAT Validation

As an admin,
I want to configure a project's default GitHub repository and validate a fine-grained PAT,
So that Viberr is ready for governed repository-backed execution.

**FRs implemented:** FR8, FR38

**Acceptance Criteria:**

**Given** a governed project
**When** an admin selects and saves a default GitHub repository
**Then** the project stores that repository as the default execution target
**And** preserves support for later task-level overrides.

**Given** a user-provided fine-grained PAT
**When** the admin validates it
**Then** Viberr checks repository match, scope sufficiency, expiry, revocation status, and required org approval
**And** only allows it to be used when validation succeeds.

**Given** a PAT validation failure
**When** Viberr detects missing scope, missing org approval, expiry, revoked access, or repo mismatch
**Then** the UI shows explicit diagnostics describing the actual issue
**And** avoids a generic failure state.

**Given** a valid PAT is saved
**When** Viberr persists it
**Then** the token is encrypted at rest
**And** it is never written into task-visible artifacts, user-visible projections, or general logs.

### Story 1.6: Reusable Agent Profiles and Project Capability Policy

As an admin,
I want to define reusable agent profiles and project-specific capability policies,
So that human permissions and agent execution boundaries are governed separately.

**FRs implemented:** FR9, FR10, FR11

**Acceptance Criteria:**

**Given** an admin creating an agent profile
**When** they define supported backend, eligible stages, permitted actions, and allowed context resources
**Then** Viberr saves a reusable profile
**And** it can be applied to projects.

**Given** a project admin customizing policy
**When** they assign or constrain agent profiles for a project
**Then** Viberr stores project-specific agent capability policy
**And** keeps it separate from human RBAC.

**Given** an invalid profile or policy configuration such as unsupported backend selection or missing required execution permissions
**When** the admin attempts to save
**Then** Viberr blocks the save
**And** explains the issue in context.

**Given** a non-admin user
**When** they attempt to create or change agent capability policy
**Then** Viberr denies the action
**And** records the attempted protected change appropriately.

## Epic 2: File-Native Task Management and Shared Supervision

Teams can create and collaborate on canonical file-native tasks, reconcile direct file edits, and use board and task views to understand current task state, readiness, and collaboration context without relying on raw logs.

### Story 2.1: Canonical Task Creation and File-Backed Records

As a user,
I want to create tasks as canonical file-backed operating records,
So that task truth remains inspectable both inside and outside Viberr.

**FRs implemented:** FR12, FR13, FR15

**Acceptance Criteria:**

**Given** an authorized user in a project
**When** they create a task with the required fields
**Then** Viberr creates a per-task directory and canonical task file in the file-native management store
**And** the task appears in the project.

**Given** a newly created task
**When** its canonical record is initialized
**Then** it includes identity, goal, workflow stage, readiness state, execution-context placeholders, chronology scaffolding, decision scaffolding, and execution-reference placeholders
**And** remains readable as the authoritative task artifact.

**Given** a user without permission to create tasks in the project
**When** they attempt task creation
**Then** Viberr blocks the action
**And** no canonical task file is created.

**Given** a created task
**When** a user inspects the management store outside the application
**Then** the task record is readable
**And** it remains the authoritative source for task business state.

### Story 2.2: File Reconciliation and Readiness Projection

As a supervisor,
I want Viberr to reconcile direct task-file edits and derive current readiness and waiting signals,
So that the app stays aligned with file truth instead of stale app state.

**FRs implemented:** FR14, FR15, FR36

**Acceptance Criteria:**

**Given** a task file is created or edited directly in the management store
**When** detection or reconciliation runs
**Then** Viberr updates its projections from the current file contents
**And** does not preserve stale in-app state.

**Given** a malformed or incomplete task file
**When** Viberr interprets it
**Then** the system emits diagnostics and maps the issue to `input_required`, `inconsistency_risk_detected`, or `blocked` based on severity
**And** does not silently drop the task.

**Given** task files include waiting target, assigned agent metadata, validation summaries, or evidence references
**When** projections are rebuilt
**Then** those values become available as secondary signals for board and task detail views
**And** remain traceable back to current file state.

**Given** a task file changes in a way that affects governed state
**When** projections refresh
**Then** board and task surfaces reflect the updated readiness and waiting semantics consistently
**And** users see the current interpreted state rather than cached assumptions.

### Story 2.3: Supervision Board with Search and High-Signal Task Cards

As a supervisor,
I want a stage-organized board with high-signal task cards and compact filters,
So that I can scan active work and identify what needs attention quickly.

**FRs implemented:** FR30, FR31, FR36

**Acceptance Criteria:**

**Given** a project board loads
**When** tasks are rendered
**Then** they are grouped by workflow stage
**And** each card shows task key, title, stage, readiness state, waiting state, assigned execution profile if present, and validation or status cues.

**Given** a user applies search or filters such as `needs me`, `blocked`, `waiting on human`, or degraded continuity-related conditions
**When** results update
**Then** the board narrows the visible set
**And** preserves supervision context.

**Given** the board renders from the active design set
**When** the supervision surface is displayed
**Then** it follows the Figma-backed board language with Task Status Card patterns, local tokens, and state cues aligned to the canonical readiness model
**And** avoids relying on color alone.

**Given** desktop, tablet, or narrow layouts
**When** the board renders
**Then** it follows the defined full-supervision, reduced-supervision, and review-first modes
**And** remains keyboard accessible.

**Given** board data is loading or refreshing
**When** the page shape is already known
**Then** Viberr uses stable skeleton or placeholder patterns
**And** avoids disruptive full-page loading states.

### Story 2.4: Task Detail Current-State Workspace

As a teammate,
I want a task detail workspace centered on current state and concise task truth,
So that I can understand progress without reading raw logs.

**FRs implemented:** FR21, FR37

**Acceptance Criteria:**

**Given** a task detail view opens
**When** the page loads
**Then** current state, execution profile slot, readiness and waiting signals, latest summary or current intervention status, and decision-relevant execution truth appear before deeper history and evidence areas
**And** the page prioritizes current understanding over raw chronology.

**Given** the task record contains validation outcomes, evidence references, related change summaries, or compressed historical context
**When** the task detail view renders
**Then** Viberr presents concise summaries with progressive disclosure
**And** does not require raw provider logs or raw validation output for normal review.

**Given** the task detail follows the active design set
**When** it renders
**Then** it uses the operator-first hierarchy from the current-state and diagnostic task surfaces
**And** keeps current truth above deeper context even before packet-specific behavior is available.

**Given** a user moves from board to task and back
**When** they return to the board
**Then** filters and recent supervision context are preserved
**And** the board does not reset unnecessarily.

**Given** normal operating conditions
**When** a task detail page loads
**Then** current state, latest summary context, and a bounded recent chronology slice load within the defined performance target for at least 95 percent of requests
**And** older history remains available through progressive disclosure.

### Story 2.5: Comments, Important Events, and Shared State Visibility

As a teammate,
I want to comment, address agents or collaborators, and see important events reflected across the project,
So that collaboration and state changes stay in one shared chronology.

**FRs implemented:** FR4, FR5, FR19

**Acceptance Criteria:**

**Given** a user posts a task comment and optionally addresses a specific teammate or agent
**When** the comment is saved
**Then** it is appended to the task chronology with addressed-participant metadata preserved
**And** it becomes visible in the task detail view.

**Given** typed important events exist in the task record
**When** the task chronology renders
**Then** human comments, agent comments, and important events appear together in one mixed timeline
**And** each item is clearly typed and expandable.

**Given** two users are connected to the same project
**When** comments or visible task state change
**Then** board and task views reflect the updated shared state within 5 seconds under normal operating conditions
**And** updates remain replay-safe under reconnects.

**Given** consequential collaboration updates occur
**When** the UI confirms them
**Then** Viberr uses inline feedback near the affected surface
**And** provides accessible announcements where appropriate.

### Story 2.6: Governed Stage Changes and Subtask Approval

As a supervisor,
I want to move tasks through allowed stages and approve proposed subtasks before activation,
So that file-native task work remains governed.

**FRs implemented:** FR16, FR20

**Acceptance Criteria:**

**Given** a task is in a project-defined workflow
**When** an authorized user selects an allowed next stage
**Then** the task file and projection update to the new stage
**And** the board and task views reflect the change.

**Given** a user attempts a disallowed stage transition
**When** they submit the action
**Then** Viberr blocks the transition
**And** explains which governed rule prevents it.

**Given** a proposed subtask exists in the task record
**When** an authorized human approves it
**Then** the subtask becomes active according to project rules
**And** when they reject it, it remains inactive with the decision recorded.

**Given** a stage transition or subtask decision completes
**When** the task history updates
**Then** the chronology captures who made the decision, when it happened, and which task state changed as a result
**And** the resulting state is visible in both task and board surfaces.

## Epic 3: Governed Agent Execution and Human Steering

Tasks can be owned by operator and specialist agents, run through governed execution, generate intervention packets, request clarification, resume from canonical task state, and require explicit human approval for consequential decisions and final completion.

### Story 3.1: Dedicated Operator and Task Ownership Model

As a supervisor,
I want each active task to have a dedicated operator and explicit specialist ownership,
So that agent execution is coordinated through a clear governed model.

**FRs implemented:** FR17, FR22

**Acceptance Criteria:**

**Given** a task becomes active
**When** Viberr prepares it for governed execution
**Then** the system establishes a dedicated operator agent context for that task
**And** records it in task-visible state.

**Given** a task needs specialist participation
**When** ownership is configured
**Then** Viberr supports one primary specialist owner and additional consultant specialists on the same task
**And** keeps those roles distinct.

**Given** task ownership is visible in the UI
**When** a user opens the board or task detail
**Then** the assigned operator, primary specialist, and consultant roles are shown with clear execution-profile semantics
**And** the user can identify who currently owns the work.

**Given** ownership changes occur
**When** they are applied
**Then** the task chronology records who initiated the change, when it happened, and what assignment state changed
**And** the updated ownership becomes visible on the task.

### Story 3.2: Operator Recommendations and Clarification Packets

As a supervisor,
I want the operator to recommend assignments, transitions, and clarification needs through structured packets,
So that I can steer agent work without reconstructing context manually.

**FRs implemented:** FR18, FR24, FR32, FR33

**Acceptance Criteria:**

**Given** a task has sufficient current context
**When** the operator evaluates it against project policy
**Then** the operator can recommend assignment changes, stage transitions, or human decisions based on current task state
**And** those recommendations are grounded in the task record.

**Given** a task is low-quality or underspecified
**When** the operator or a specialist detects the issue
**Then** Viberr flags the condition and generates a structured clarification or blocking packet
**And** unsafe execution does not continue silently.

**Given** a packet is rendered in task detail
**When** a user reviews it
**Then** the packet shows the observed issue, impact summary, recommended options, and next-action area in labeled sections visible without expanding supporting evidence
**And** raw evidence remains secondary and progressively disclosed.

**Given** a task has an active blocking or decision packet
**When** task detail renders
**Then** the packet appears above the ongoing chronology and supporting evidence
**And** it becomes the primary intervention surface for the current task state.

**Given** a packet is generated
**When** the task chronology updates
**Then** the packet becomes part of the canonical task narrative
**And** it is visible as the current intervention surface.

### Story 3.3: Human Steering for Consequential Decisions

As a human reviewer,
I want to approve, reject, or redirect consequential agent-driven changes,
So that governed work only advances under explicit human control.

**FRs implemented:** FR34, FR35

**Acceptance Criteria:**

**Given** a consequential change is proposed
**When** a human reviews the decision packet
**Then** they can approve, reject, or redirect the proposed change from the task surface
**And** the chosen action is recorded.

**Given** a packet proposes stage advancement, subtask activation, or task completion
**When** a human acts on it
**Then** Viberr records the decision and updates the task state accordingly
**And** the resulting waiting state is recalculated.

**Given** a non-human actor attempts to finalize a human-only consequential decision
**When** the action is submitted
**Then** Viberr blocks the action
**And** preserves the current governed state.

**Given** a consequential decision is made
**When** the UI updates
**Then** inline feedback and task-state changes make it obvious what changed
**And** whether the task is now waiting on a human or an agent.

### Story 3.4: Specialist Execution Runs and Outcome Recording

As a supervisor,
I want approved specialist agents to execute stage work and write back meaningful outcomes,
So that implementation progress is visible in the task record.

**FRs implemented:** FR23, FR25, FR26

**Acceptance Criteria:**

**Given** a task has an approved agent profile and sufficient context
**When** the operator triggers specialist work
**Then** Viberr starts a run using a supported coding-agent backend for that task
**And** associates the run with the task's governed execution record.

**Given** a specialist run completes or reaches a meaningful boundary
**When** the outcome is recorded
**Then** the task chronology captures outcomes, blockers, evidence references, and concise related-change summaries
**And** keeps the task record readable.

**Given** a specialist run fails or encounters a governed stop condition
**When** Viberr records the result
**Then** the task shows a visible blocking or warning state
**And** the failure is not silent.

**Given** an execution action is retried
**When** Viberr processes the retry
**Then** it preserves idempotent official task behavior
**And** avoids duplicate transitions or duplicate official records.

### Story 3.5: Persistent Thread Resume and Consultant Re-Engagement

As a supervisor,
I want operator and specialist threads to resume across stages and later consultations,
So that task continuity survives long-running governed work.

**FRs implemented:** FR25, FR27

**Acceptance Criteria:**

**Given** an operator or specialist previously worked on a task
**When** that same agent is re-engaged in a later stage or consultation
**Then** Viberr resumes the persistent agent thread associated with that task when runtime continuity is available
**And** restores the relevant task context.

**Given** consultant specialists are needed again
**When** the operator re-engages them
**Then** Viberr preserves the distinction between the primary owner and consultant roles
**And** reuses the task's continuity context.

**Given** resumed work continues on the same task
**When** new actions are appended
**Then** the chronology preserves continuity
**And** does not fragment the task into unrelated execution records.

**Given** runtime continuity cannot be maintained
**When** resume is attempted
**Then** Viberr fails explicitly and surfaces the continuity problem to the task
**And** does not pretend the thread resumed normally.

### Story 3.6: Runtime Session Access and Canonical-State Continuation

As an authorized user,
I want to inspect native runtime sessions and continue work from canonical task state when runtime history is missing,
So that the task remains governable during debugging and continuity failures.

**FRs implemented:** FR28, FR29

**Acceptance Criteria:**

**Given** a user is authorized to inspect execution internals
**When** they request runtime access for a task
**Then** Viberr provides access to the agent's native runtime session for debugging or intervention
**And** keeps that access governed by authorization rules.

**Given** prior runtime history is unavailable
**When** Viberr attempts to continue the task
**Then** the system re-anchors execution on the canonical task state
**And** does not require manual reconstruction from external tools.

**Given** canonical task state is sufficient for safe continuation
**When** a continuation path is approved
**Then** Viberr resumes governed work
**And** records that the continuation came from canonical-state re-entry.

**Given** canonical state is not sufficient because required context or artifacts are missing
**When** continuity is evaluated
**Then** Viberr surfaces the issue as `input_required` or another appropriate blocked condition with explicit recovery guidance
**And** prevents unsafe continuation.

## Epic 4: GitHub-Linked Delivery and Execution Traceability

Task execution can attach to a repository, create governed task branches, link commits and pull requests back to the task, synchronize at workflow boundaries, and surface branch and pull request health as part of operational truth.

### Story 4.1: Task Repository Attachment and Execution Context

As a supervisor,
I want each task to resolve to a single GitHub repository for execution,
So that repository-backed delivery has an explicit governed target.

**FRs implemented:** FR39

**Acceptance Criteria:**

**Given** a project has a default repository configured
**When** a new task enters repository-backed execution
**Then** Viberr resolves the task to that project default unless a task-level override is explicitly set
**And** only one repository is active for the task in V1.

**Given** an authorized user sets a task-level repository override
**When** the override is valid
**Then** the task uses that repository as its single V1 execution target
**And** the override becomes visible in task execution context.

**Given** a repository attachment is present
**When** the task detail renders
**Then** Viberr shows the active repository in the execution-truth area
**And** users can identify which repository governs delivery.

**Given** a user attempts to attach multiple repositories to one task in V1
**When** the action is submitted
**Then** Viberr blocks the configuration
**And** explains the single-repo constraint.

### Story 4.2: Task-Key Branch Creation and Governed Sync

As a supervisor,
I want Viberr to create task-linked execution branches and synchronize them at governed boundaries,
So that code execution stays traceable to the task lifecycle.

**FRs implemented:** FR40, FR42

**Acceptance Criteria:**

**Given** a task begins repository-backed execution
**When** branch setup runs
**Then** Viberr creates or resolves a task-linked branch using the task key naming rule
**And** stores that branch as part of task execution context.

**Given** a governed workflow boundary requires synchronization
**When** Viberr performs sync or rebase behavior
**Then** it records the operation against the task's execution context
**And** preserves a traceable history of the sync action.

**Given** branch sync or rebase succeeds
**When** the task updates
**Then** the current branch status is visible in the execution-truth surface
**And** the task remains eligible for governed progression subject to policy.

**Given** sync, rebase, or branch-health evaluation fails
**When** Viberr detects the failure
**Then** the task enters an explicit blocking or risk condition
**And** the problem is not hidden in the background.

### Story 4.3: Commit and Pull Request Traceability

As a reviewer,
I want commits, changed files, and pull requests linked back to the originating task,
So that delivery review stays traceable to task intent.

**FRs implemented:** FR41

**Acceptance Criteria:**

**Given** repository-backed work produces commits
**When** Viberr associates them to the task
**Then** commit references remain uniquely traceable to the originating task key
**And** they are visible from the task context.

**Given** changed-file references are available from execution or repository state
**When** task context is refreshed
**Then** those references are attached to the task's execution record
**And** support later review without requiring raw provider output.

**Given** a review-stage pull request is created or linked
**When** the task detail renders
**Then** Viberr shows the pull request association and relevant review status in the execution-truth area
**And** the task remains linked to its review artifact.

**Given** a retry or duplicate callback occurs around commit or pull request linkage
**When** Viberr processes it
**Then** the system preserves idempotent task linkage
**And** avoids duplicate official associations.

### Story 4.4: Branch Health and Pull Request Status as Governed Blocking Signals

As a supervisor,
I want branch health and pull request status surfaced as decision-relevant task truth,
So that execution-critical progression is blocked when repository reality is unsafe.

**FRs implemented:** FR43, FR44

**Acceptance Criteria:**

**Given** a task has an associated branch or pull request
**When** Viberr evaluates current execution truth
**Then** branch health and pull request status appear alongside task state in board and task surfaces where relevant
**And** users can assess delivery risk without leaving the product.

**Given** branch health is conflicted, unresolved, unknown, or otherwise unsafe
**When** a user or agent attempts execution-critical progression
**Then** Viberr blocks that progression
**And** preserves the task in a governed blocking or risk state.

**Given** GitHub integration failures affect branch or pull request visibility
**When** the failure is detected
**Then** Viberr surfaces task-relevant diagnostics within the defined time window
**And** does not leave status ambiguous.

**Given** branch or pull request health changes
**When** connected users view the project
**Then** the affected execution-truth signals propagate to relevant task views through the normal live-update path
**And** the updated state becomes visible without manual page reconstruction.

## Epic 5: Auditability, Diagnostics, and Recovery

Users can trust Viberr under stress because the system preserves audit history, isolates secrets, records policy or quality issues, and supports manual re-scan and reconciliation when file, runtime, or repository state needs recovery.

### Story 5.1: Durable Audit History for Governed Actions

As an authorized user,
I want a durable audit trail of consequential human and agent actions,
So that I can reconstruct how task and project state changed.

**FRs implemented:** FR45

**Acceptance Criteria:**

**Given** a consequential action occurs such as approval, transition, assignment change, policy change, or important agent event
**When** Viberr records it
**Then** the action is written to durable audit history associated with the relevant task or project
**And** it remains queryable as part of governed history.

**Given** an authorized user inspects audit history
**When** they view a recorded event
**Then** they can identify who initiated it, when it occurred, and what state changed as a result
**And** the event remains attributable.

**Given** the application restarts or resynchronization occurs
**When** audit history is queried afterward
**Then** previously recorded audit events remain available
**And** the audit record stays intact.

**Given** a user lacks permission to access audit-sensitive history
**When** they attempt to view it
**Then** Viberr restricts access according to authorization rules
**And** does not expose protected audit content.

### Story 5.2: Secret Isolation and Safe Diagnostics

As an operator of the system,
I want credentials isolated from task-visible state and user-facing diagnostics,
So that security-sensitive information never leaks through normal product use.

**FRs implemented:** FR46

**Acceptance Criteria:**

**Given** Viberr handles repository credentials, provider credentials, PATs, or other secrets
**When** those values are stored or processed
**Then** they remain isolated from task files, comments, audit views, and general logs
**And** no task-visible artifact contains the secret material.

**Given** a diagnostic or integration failure occurs
**When** Viberr renders it to a user
**Then** the message explains the actionable problem without exposing raw secret values or sensitive credential payloads
**And** the user can still understand what to do next.

**Given** structured logs are emitted for security-relevant or integration-related events
**When** they are written
**Then** they include correlation value and event meaning
**And** they do not leak secret content.

**Given** a secret-handling regression would expose sensitive data to a task-visible surface
**When** the unsafe write path is attempted
**Then** Viberr blocks or sanitizes it before persistence
**And** preserves safe system state.

### Story 5.3: Policy Violations, Quality Issues, and Diagnostic Surfaces

As a supervisor,
I want policy violations and task quality issues surfaced as first-class diagnostic events,
So that risky or inconsistent work is visible and actionable.

**FRs implemented:** FR47

**Acceptance Criteria:**

**Given** a policy violation, low-quality task condition, or execution inconsistency is detected
**When** Viberr records it
**Then** it is stored as a first-class event rather than buried in freeform commentary
**And** it is available to task interpretation and review surfaces.

**Given** a task has active diagnostic findings
**When** users view the board or task detail
**Then** the task shows visible risk or blocked cues consistent with the canonical readiness model
**And** the issue is not hidden behind secondary logs.

**Given** diagnostic details are opened
**When** the user reviews them
**Then** Viberr presents what is known, what is inconsistent, and what action is needed before safe continuation
**And** keeps low-level evidence secondary.

**Given** a diagnostic condition is resolved
**When** task state is recalculated
**Then** the corresponding cues and recovery guidance update to reflect the new interpreted state
**And** the task no longer shows stale diagnostic meaning.

### Story 5.4: Manual Project Re-Scan and Recovery Reconciliation

As a support or admin user,
I want to trigger manual project re-scan and recovery reconciliation,
So that Viberr can recover safely when automated detection or runtime continuity is incomplete.

**FRs implemented:** FR48

**Acceptance Criteria:**

**Given** automated change detection misses updates or users suspect projection drift
**When** an authorized user triggers manual project re-scan
**Then** Viberr reinterprets current files and refreshes projections without corrupting canonical task state
**And** the recovery action is recorded.

**Given** runtime continuity, branch state, or repository linkage is incomplete
**When** reconciliation runs
**Then** Viberr updates task-visible diagnostics and recovery status from current file and external facts
**And** current interpreted state replaces stale assumptions.

**Given** a task is in degraded continuity or recovery review
**When** the task detail renders
**Then** Viberr presents a continuity-recovery-oriented explanation of what is known, what is missing, and which next steps are safe
**And** keeps authoritative task truth ahead of low-level failure detail.

**Given** reconciliation changes the interpreted task state
**When** processing completes
**Then** board and task surfaces reflect the updated reality
**And** the recovery action is recorded in audit history.
