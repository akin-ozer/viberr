---
stepsCompleted:
  - 1
  - 2
  - 3
  - 4
  - 5
  - 6
  - 7
  - 8
inputDocuments:
  - /Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/prd.md
  - /Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/ux-design-specification.md
  - /Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/product-brief-viberr.md
  - /Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/product-brief-viberr-distillate.md
workflowType: 'architecture'
project_name: 'viberr'
user_name: 'akin-ozer'
date: '2026-04-01T16:08:07+0300'
lastStep: 8
status: 'complete'
completedAt: '2026-04-01T18:52:57+0300'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements:**
The requirements define a governed AI delivery platform whose source of truth is the file system. Architecturally, the system should treat task and project files as authoritative state that may be modified directly by humans or agents. The application should observe those files, parse them, reconcile them with external facts such as GitHub state and runtime metadata, and project a usable supervision UI from current file reality.

The 48 functional requirements cluster into seven capability areas:

1. Workspace access and collaboration
2. Project governance and policy
3. Task records and lifecycle
4. Agent orchestration and continuity
5. Oversight and human governance
6. GitHub delivery and traceability
7. Integrity, audit, and recovery

The key architectural implication is that the system should not gatekeep state changes through an app-controlled write path. Instead, it should be designed around file observation, tolerant parsing, state projection, and inconsistency detection.

**Non-Functional Requirements:**
The most important non-functional requirements remain:

- fast board and task rendering, with timely shared-state propagation
- strict secret isolation
- separate human RBAC and agent policy
- durable auditability
- idempotent external actions
- safe behavior under runtime-history loss
- clear branch and repository integrity signaling

These requirements imply the architecture must preserve a strong distinction between:

- authoritative file state
- derived application projections
- external system facts such as GitHub, review, and runtime status

**Scale & Complexity:**
The project remains high architectural complexity because it combines:

- multi-user collaboration
- file-native canonical state
- persistent agent execution
- GitHub-coupled delivery
- policy and governance controls
- recovery from partial or missing runtime context

- Primary domain: governed AI delivery and workflow orchestration web application
- Complexity level: high
- Estimated architectural components: 10-14 major modules or subsystems

### Technical Constraints & Dependencies

Known constraints and dependencies include:

- V1 execution backends are Codex and Claude Code only.
- GitHub is the only V1 execution and review integration.
- State is always whatever the files currently say.
- Humans and agents may both modify task and project files directly.
- The app must reflect file truth rather than override it.
- Runtime history is helpful but non-authoritative.
- If provider-side memory disappears, an agent can restart from the task file.
- If required context or referenced files are missing, the system should request human intervention rather than introduce a complex recovery subsystem.
- Single-repo-per-task remains a V1 boundary.
- UX should optimize for operational legibility, not "certainty restoration."

### Cross-Cutting Concerns Identified

The concerns that cut across the architecture are:

- file observation and change reconciliation
- tolerant parsing and schema validation without state gatekeeping
- durable projections and indexes derived from file truth
- audit trail generation from file changes and consequential actions
- human RBAC and agent policy enforcement on system actions, not on raw file existence
- GitHub synchronization integrity and branch-health visibility
- runtime re-entry from task files when chat history disappears
- explicit missing-context handling
- inconsistency detection between files, repository state, and runtime references
- timeline readability and low-noise summarization

### Interpretation and Projection Model

The revised architecture should be framed as four cooperating layers:

- file corpus: the actual project and task files on disk
- interpretation layer: tolerant parsers and schema checkers
- projection layer: indexes, board views, task summaries, and search materializations
- diagnostics layer: missing-input and inconsistency findings

The app may write files when it acts, but those writes are not more authoritative than direct human or agent edits. Every view should be re-derivable from current files plus current external facts.

### Simplified Task Readiness States

Task readiness state should remain separate from workflow stage.

Recommended readiness states:

- `ready`: the task has sufficient context and no known hard stop
- `input_required`: a human must provide missing context, files, decisions, or artifacts
- `inconsistency_risk_detected`: current files or external references may not agree and need review
- `blocked`: a hard stop prevents safe or valid progress

Signals such as branch health, assigned agent, review linkage, waiting target, and memory availability should be modeled as secondary signals rather than replacing the core readiness state.

### Provenance and Runtime Signals

The system should preserve observational provenance so users can understand how file changes affected interpreted state over time. This provenance explains how the system interpreted file changes, but it does not outrank the files themselves.

Runtime-memory loss should be treated as a secondary execution signal, not a primary workflow state. If the task file still contains sufficient context, work can continue. If missing context now matters, the task should move to `input_required`.

## Starter Template Evaluation

### Primary Technology Domain

Full-stack web application with a React-based desktop-first interface and a Node-compatible server runtime.

This is based on the product requirements:

- multi-user authenticated web application
- file-authoritative management plane
- real-time or near-real-time shared state visibility
- GitHub integration and long-lived execution context
- on-premises and self-hosted deployment expectations

### Starter Options Considered

- **Next.js official starter via `create-next-app`:** a credible React full-stack option with strong self-hosting support and a mature CLI. It remains a viable alternative, but it introduces more framework-managed rendering and caching behavior than this file-authoritative architecture necessarily wants at the starting point.
- **React Router framework starter via `create-react-router`:** a strong fit for a React application that needs an explicit Node-capable runtime, official deployment templates, and server-rendered deployment support without forcing a database or more opinionated application model.
- **Vite React TypeScript starter via `create-vite`:** an excellent low-level baseline, but too bare for Viberr's full-stack starting point. Choosing it would mean assembling routing, server runtime, deployment structure, and framework conventions too early.

Versions and maintenance status were verified from official documentation and release material on 2026-04-01 rather than assumed from memory.

### Selected Starter: React Router Node.js with Docker Template

**Rationale for Selection:**
React Router is the best fit for Viberr's current architectural direction.

It keeps the frontend in React, which matches the UX and design-system direction already implied by the UX specification. It supports server rendering, static rendering, and pre-rendering without forcing those decisions too early. Its official Docker-ready Node template is a strong match for Viberr's self-hosted and on-premises expectations.

Most importantly, it is more explicit and less magic-heavy than alternatives that encourage framework-managed state and cache behavior. That makes it a better foundation for a system where files remain the only authoritative state.

Next.js remains a credible alternative, but it is less aligned with the explicit, file-observant model. Vite remains too low-level for this project's starting point.

### Initialization Command

```bash
npx create-react-router@latest --template remix-run/react-router-templates/default
```

**Architectural Decisions Provided by Starter:**

**Language & Runtime:**
React Router framework mode on a Node-capable runtime with TypeScript-oriented conventions and first-class route type generation.

**Styling Solution:**
The official Node.js with Docker template includes Tailwind CSS.

**Build Tooling:**
Official React Router CLI and framework build flow, with server-rendered deployment support and Docker-ready startup conventions.

**Testing Framework:**
The official starter documentation does not advertise a bundled testing stack as a core starter decision. Testing should therefore be added intentionally in early implementation rather than assumed from the scaffold.

**Code Organization:**
Framework conventions center around files such as `root.tsx`, `routes.ts`, and `react-router.config.ts`, plus route-module structure that works well with explicit application boundaries. The current upstream starter may provide client/server entry files and Tailwind/PostCSS wiring implicitly; Viberr keeps explicit compatibility files in-repo so those runtime boundaries remain visible and stable for later stories.

**Development Experience:**
Strong React development ergonomics, framework conventions instead of ad hoc setup, SSR and static rendering flexibility, Tailwind-ready UI scaffolding, and an official Docker deployment path.

### Starter Commitments vs Early Implementation Stories

The starter decision should lock in only these baseline commitments:

- React plus TypeScript
- a Node-capable full-stack runtime
- a self-hostable deployment path
- explicit routing and server entry points
- no forced database-centered application model

Early implementation stories should then add:

- authentication
- real-time update plumbing
- file watching and indexing
- GitHub integration
- testing infrastructure

This keeps scaffold convenience separate from actual product architecture.

**Note:** Project initialization using this command should be the first implementation story.

## Core Architectural Decisions

### Decision Priority Analysis

**Critical Decisions (Block Implementation):**

- File system is the only authoritative business state.
- Production projection and interpretation store: SQLite 3.52.0.
- Validation boundary: Zod 4 schema validation with tolerant parsing and explicit diagnostics.
- Human authentication: OAuth-first with Google and GitHub.
- App sessions: cookie-only sessions.
- GitHub execution access: fine-grained PATs only, separate from login identity.
- Primary app interface: React Router loaders/actions.
- Live update channel: Server-Sent Events (SSE).
- Deployment target: single-node Docker deployment.

**Important Decisions (Shape Architecture):**

- Projection schema is relational and query-oriented, not a mirror of markdown structure.
- No distributed cache; only local process caches and infra/web caches.
- Migrations are SQL-first and explicit.
- Observational provenance is persisted separately from source files.
- Frontend state stays route-local by default; no heavy global store.
- UI code organization is feature-oriented and surface-oriented around board, task, policy, admin, and auth concerns.
- Logging is structured JSON with correlation identifiers.
- Environment configuration is typed and explicit.

**Deferred Decisions (Post-MVP or implementation detail):**

- Dedicated search engine beyond SQLite capabilities
- WebSockets or duplex realtime channels
- Horizontal scaling strategy
- External job queue or worker separation
- Alternate database engine beyond SQLite
- Auth library abstraction choice, if a lightweight custom OAuth integration remains sufficient

### Data Architecture

**Primary state model:**

- Authoritative business state lives only in files.
- Humans and agents may both modify files directly.
- The app observes, parses, projects, and diagnoses; it does not outrank file truth.

**Projection and interpretation store:**

- SQLite 3.52.0 is the production projection, interpretation, and provenance database.
- SQLite is intentional for production as well as MVP because Viberr is not targeting horizontal scale.
- SQLite stores durable projections, diagnostics, observational provenance, session/auth metadata, and execution metadata.
- SQLite is not the primary source of business truth.

**Data modeling approach:**

- Use a relational projection schema optimized for board views, task detail lookup, provenance, diagnostics, auth/session metadata, and search materialization.
- Keep source-file identifiers and external references first-class in the schema.
- Do not attempt to duplicate every markdown nuance 1:1 in normalized tables; store what supports queryability and provenance.

**Validation strategy:**

- Use Zod 4 at parse and action boundaries.
- Parsing should be tolerant: malformed or incomplete files should produce diagnostics and readiness-state changes, not silent drops.
- Validation errors should map to `input_required`, `inconsistency_risk_detected`, or `blocked` based on severity.

**Migration approach:**

- SQL-first migrations, explicit and checked into source control.
- Projection schema evolution should stay decoupled from markdown file evolution.

**Caching strategy:**

- No distributed cache.
- Local in-process caches are allowed for parsed files, projections, and derived views.
- Infra/web caches are acceptable where they do not hide authoritative state changes.
- All caches must be disposable and fully reconstructable from files plus external facts.

### Authentication & Security

**Authentication method:**

- OAuth-first human login.
- Initial providers: Google and GitHub.

**Session model:**

- Cookie-only sessions.
- Session payload must remain intentionally small because cookie size is constrained.
- Only stable, compact claims should live in the cookie. Dynamic authorization or execution metadata should not.

**Authorization patterns:**

- Human RBAC and agent capability policy remain separate systems.
- Authorization checks happen on system actions, not on raw file existence.

**GitHub security model:**

- GitHub OAuth is only for user identity.
- Repository execution access uses user-provided fine-grained PATs only.
- PATs are separate credentials, not derived from login sessions.

**Secret handling:**

- PATs and other credentials must be encrypted at rest.
- Secrets must never be written to task or project files, user-visible projections, or logs.
- PAT scope and expiry should be validated and surfaced to users before task execution fails.
- PAT diagnostics must explicitly handle insufficient scope, missing org approval, expired tokens, revoked access, and repo mismatch.

**API security strategy:**

- Secure cookies, CSRF protection for state-changing flows, and action-level authorization are baseline.
- All sensitive server-side actions must be auditable.

### API & Communication Patterns

**Primary app interface:**

- React Router loaders/actions are the default interface for first-party product flows.

**Programmatic/API surface:**

- Add explicit JSON endpoints only where automation, agent-runtime coordination, or external tooling genuinely needs them.
- Avoid building a broad public REST surface by default.

**Realtime communication:**

- Use Server-Sent Events (SSE) for server-to-client state propagation.
- SSE fits Viberr's primary need: notifying clients that file, projection, or external state changed.
- Clients must tolerate reconnects, replay-safe revalidation, and non-durable transport interruptions without duplicate side effects.

**Error handling standards:**

- Use typed structured errors with stable machine codes and human-readable messages.
- Error states should map cleanly to readiness states and diagnostics.

**Rate limiting strategy:**

- Apply targeted limits to auth flows, PAT validation, and expensive sync/projection rebuild operations.
- Broad product-wide rate limiting can remain minimal in MVP.

### Frontend Architecture

**State management approach:**

- Prefer route-local loader/action state and narrowly-scoped React context.
- Do not introduce a heavy global client store unless a proven cross-route need appears.

**Component architecture:**

- Organize code by product surface:
  - board supervision
  - task detail
  - project policy/admin
  - org admin
  - auth/session
- Shared design-system primitives remain thin and reusable.

**Routing strategy:**

- Follow React Router framework conventions from the starter.
- Keep route hierarchy aligned with operational surfaces, not arbitrary UI nesting.

**Performance strategy:**

- Virtualize or progressively disclose long timelines and dense board surfaces.
- Optimize for desktop-first supervision and stable rerender boundaries under live updates.

**Bundle and rendering approach:**

- Keep framework defaults from the starter unless profiling proves a problem.
- Avoid premature client-side state inflation or aggressive hydration complexity.

### Infrastructure & Deployment

**Hosting strategy:**

- Single-node Docker deployment is the primary production target.
- On-prem and self-hosted deployment should be first-class, not an afterthought.

**CI/CD pipeline approach:**

- GitHub Actions for CI/CD.
- CI should cover typecheck, lint, tests, migration checks, and build integrity.

**Environment configuration:**

- Typed environment configuration with explicit validation at startup.
- Fail fast on missing or malformed required secrets/configuration.

**Monitoring and logging:**

- Structured JSON logs with request/job correlation identifiers.
- Track projection rebuilds, file-parse diagnostics, auth events, PAT validation outcomes, and GitHub sync failures.

**Scaling strategy:**

- No horizontal scaling target in MVP or initial production.
- If scale pressure appears later, scale projections and workers first, not file authority.

### Decision Impact Analysis

**Implementation Sequence:**

1. Initialize the React Router starter and lock runtime/tooling baseline.
2. Implement typed environment configuration and secret handling.
3. Build cookie-session OAuth login with Google and GitHub.
4. Add encrypted fine-grained PAT storage and validation flow.
5. Implement SQLite projection schema, SQL migrations, and provenance model.
6. Implement file observation, tolerant parsing, diagnostics, and readiness-state derivation.
7. Build loader/action-based board and task surfaces against projections.
8. Add SSE-based live update propagation.
9. Add GitHub sync/execution integration.
10. Add structured logging, provenance views, and operational diagnostics.

**Cross-Component Dependencies:**

- OAuth, cookie sessions, and PAT handling shape both auth flows and GitHub execution flows.
- SQLite schema decisions affect projections, provenance, diagnostics, and operational views.
- SSE depends on projection freshness and stable event emission boundaries.
- File parsing and validation directly drive readiness states, diagnostics, and board rendering.
- Structured error codes and readiness states must stay aligned across backend, SSE updates, and UI surfaces.

## Implementation Patterns & Consistency Rules

### Pattern Categories Defined

**Critical Conflict Points Identified:**
16 areas where AI agents could make different choices and create drift: database naming, projection schema modeling, route/data naming, file naming, TypeScript symbol naming, test placement, JSON shape conventions, error shapes, timestamp formats, SSE event naming, readiness-state derivation, loading-state handling, retry behavior, logging structure, validation boundaries, and secret-handling behavior.

### Naming Patterns

**Database Naming Conventions:**

- Tables use plural `snake_case`: `tasks`, `task_projections`, `projection_runs`
- Columns use `snake_case`: `task_id`, `readiness_state`, `updated_at`
- Foreign keys use `<entity>_id`: `task_id`, `project_id`
- Index names use `idx_<table>__<column_list>`: `idx_tasks__project_id_updated_at`
- Unique constraints use `uq_<table>__<column_list>`

**API Naming Conventions:**

- Explicit JSON endpoints use plural resource nouns where applicable: `/api/tasks`, `/api/projects`
- Query parameters use `camelCase` because they map directly to TypeScript request/response code: `projectId`, `readinessState`
- Route params use React Router conventions and are named in `camelCase`: `:taskId`
- Headers use standard HTTP naming; do not invent custom header formats unless required

**Code Naming Conventions:**

- React components, types, and classes: `PascalCase`
- Variables, functions, hooks, loader/action helpers: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- General files and directories: `kebab-case`
- Route module files preserve React Router framework-required names and conventions
- Do not mix `snake_case` and `camelCase` in TypeScript code except when mapping database fields through centralized mapping logic

### Structure Patterns

**Project Organization:**

- Organize product code by surface/feature, not by generic type buckets
- Primary top-level app surfaces:
  - board supervision
  - task detail
  - project policy/admin
  - org admin
  - auth/session
- Shared utilities go in purpose-specific shared modules, not scattered feature folders
- Server-only logic for files, projections, GitHub, auth, diagnostics, and interpretation policy must stay out of UI modules
- Do not create generic dumping-ground modules such as `utils.ts` or `helpers.ts` at feature roots

**File Structure Patterns:**

- Tests are co-located using `*.test.ts` / `*.test.tsx`
- Route modules may split test files by concern when needed, but test naming must remain explicit rather than ad hoc
- Shared schemas/codecs live in shared schema modules and are reused rather than redefined
- Static assets stay organized by product surface or design-system purpose, not by ad hoc contributor preference
- Configuration is centralized and typed; no feature-specific env parsing

### Format Patterns

**API Response Formats:**

- For dedicated JSON endpoints, success responses use:
  - `{ data, meta? }`
- Error responses use:
  - `{ error: { code, message, details? } }`
- Use proper HTTP status codes; do not encode failure as `200` with ad hoc flags
- React Router route loaders may return route-shaped data directly, but dedicated JSON endpoints must follow the shared envelope

**Data Exchange Formats:**

- TypeScript and JSON fields use `camelCase`
- Database fields use `snake_case`
- Mapping between them must be centralized, not implemented ad hoc in each feature
- Timestamps use UTC ISO 8601 strings at boundaries and in files
- Booleans remain booleans, never `0/1` in API shapes
- Null remains explicit `null`; do not replace with magic empty strings or sentinels
- Readiness states use the canonical values only:
  - `ready`
  - `input_required`
  - `inconsistency_risk_detected`
  - `blocked`

### Communication Patterns

**Event System Patterns:**

- SSE event names use lowercase dot-separated names:
  - `task.updated`
  - `task.readiness-changed`
  - `projection.rebuilt`
  - `auth.session-expired`
- Event payloads use:
  - `{ type, entityId, occurredAt, data }`
- SSE payloads should carry compact facts and references, not giant denormalized business objects
- Event names should describe facts, not commands
- Version event payloads by additive evolution, not frequent shape churn

**State Management Patterns:**

- Authoritative state always comes from files and server-derived projections
- Client state is for ephemeral UI concerns only
- No optimistic updates for authoritative task state unless the action is explicitly designed to be reversible and replay-safe
- Route-local state and narrowly-scoped context are preferred over global stores
- Readiness-state derivation, diagnostics severity, PAT validation interpretation, and projection freshness logic must live in shared server policy modules
- Do not duplicate interpretation logic in multiple UI components or feature modules

### Process Patterns

**Error Handling Patterns:**

- Use typed application errors with stable machine-readable codes
- Show concise user-facing messages; keep technical detail in logs/diagnostics
- Never expose raw stack traces or secret-bearing error details to users
- Distinguish between:
  - user-correctable issues
  - inconsistency diagnostics
  - infrastructure or external-service failures

**Loading State Patterns:**

- Use React Router navigation/fetcher pending state as the default loading mechanism
- Keep loading state local to the route/action scope when possible
- Long-running operations should surface progress as explicit server-derived status, not indefinite spinners
- Realtime refreshes should preserve screen stability and avoid jarring full-page resets

**Retry and Recovery Patterns:**

- Automatic retries are allowed for safe reads and reconnects
- Mutating operations require explicit idempotency protection before retrying
- SSE reconnects must trigger safe revalidation without duplicate side effects
- Missing context should move the task toward diagnostics or `input_required`, not ad hoc fallback behavior
- Tolerant parsing must still emit explicit diagnostics; silent parse fallback is forbidden

### Enforcement Guidelines

**All AI Agents MUST:**

- Treat files as the only authoritative business state
- Reuse shared schemas, mapping logic, readiness-state logic, diagnostics rules, and response/error formats instead of inventing local variants
- Follow the naming and structure conventions even when another style would also work technically

**Pattern Enforcement:**

- Enforce through linting, typechecking, tests, and review against this architecture document
- Pattern violations should be called out in task history and code review notes
- Shared conventions should be updated in one place first, then applied in code

### Pattern Examples

**Good Examples:**

- `task-projection-service.ts` exports `rebuildTaskProjection`
- SQLite table `task_projections` with column `readiness_state`
- JSON endpoint success response:
  - `{ "data": { "taskId": "VIB-142", "readinessState": "ready" } }`
- SSE event:
  - `task.readiness-changed`
- Co-located test:
  - `task-projection-service.test.ts`

**Anti-Patterns:**

- Mixing `taskId`, `task_id`, and `TaskID` in TypeScript code
- Returning `{ success: true, result: ... }` from one endpoint and raw objects from another
- Deriving readiness state independently in multiple UI components
- Storing dynamic auth or execution metadata in cookie sessions
- Using optimistic UI to show task state changes before authoritative projection refresh
- Treating SQLite rows as the canonical source of task truth instead of files
- Hiding parse failure with silent best-effort fallback behavior

## Project Structure & Boundaries

### Complete Project Directory Structure

```text
viberr/
├── README.md
├── package.json
├── tsconfig.json
├── react-router.config.ts
├── vite.config.ts
├── tailwind.config.ts          # compatibility file; Tailwind v4 uses the Vite plugin baseline
├── postcss.config.mjs          # compatibility file; retained for project convention visibility
├── eslint.config.js
├── prettier.config.cjs
├── .env.example
├── .gitignore
├── Dockerfile
├── compose.yml
├── .github/
│   └── workflows/
│       └── ci.yml
├── docs/
│   ├── architecture/
│   │   └── decisions.md
│   └── operations/
│       ├── deployment.md
│       └── pat-management.md
├── db/
│   └── migrations/
│       ├── 0001_projection_schema.sql
│       ├── 0002_auth_metadata.sql
│       └── 0003_provenance_and_diagnostics.sql
├── scripts/
│   ├── run-migrations.ts
│   ├── rebuild-projections.ts
│   ├── verify-env.ts
│   └── smoke-check.ts
├── public/
│   ├── favicon.ico
│   └── assets/
│       └── logos/
├── e2e/
│   ├── auth-login.spec.ts
│   ├── board-live-updates.spec.ts
│   └── task-detail-readiness.spec.ts
├── test-support/
│   ├── factories/
│   │   ├── project-file.factory.ts
│   │   ├── task-file.factory.ts
│   │   └── projection.factory.ts
│   ├── fixtures/
│   │   ├── sample-project/
│   │   └── sample-task/
│   └── helpers/
│       ├── sqlite-test-db.ts
│       └── file-store-test-root.ts
└── app/
    ├── app.css
    ├── root.tsx
    ├── routes.ts
    ├── entry.client.tsx        # explicit compatibility entry file
    ├── entry.server.tsx        # explicit compatibility entry file
    ├── routes/
    │   ├── _index.tsx
    │   ├── login.tsx
    │   ├── auth.callback.google.tsx
    │   ├── auth.callback.github.tsx
    │   ├── logout.tsx
    │   ├── projects.$projectId.board.tsx
    │   ├── projects.$projectId.queue.tsx
    │   ├── projects.$projectId.settings.tsx
    │   ├── projects.$projectId.tasks.$taskId.tsx
    │   ├── projects.$projectId.tasks.$taskId.activity.tsx
    │   ├── projects.$projectId.tasks.$taskId.files.tsx
    │   ├── admin.org.users.tsx
    │   ├── admin.org.agents.tsx
    │   ├── admin.org.policies.tsx
    │   ├── resources.events.ts
    │   ├── resources.health.ts
    │   └── api.tasks.$taskId.comment.ts
    ├── ui/
    │   ├── button.tsx
    │   ├── badge.tsx
    │   ├── dialog.tsx
    │   ├── input.tsx
    │   ├── panel.tsx
    │   └── table.tsx
    ├── features/
    │   ├── auth/
    │   │   ├── login-view.tsx
    │   │   ├── oauth-provider-buttons.tsx
    │   │   ├── session-banner.tsx
    │   │   ├── auth.shared.ts
    │   │   └── auth.shared.test.ts
    │   ├── board/
    │   │   ├── board-page.tsx
    │   │   ├── board-filters.tsx
    │   │   ├── task-card.tsx
    │   │   ├── board.loader.server.ts
    │   │   └── board.loader.server.test.ts
    │   ├── task-detail/
    │   │   ├── task-detail-page.tsx
    │   │   ├── task-readiness-badge.tsx
    │   │   ├── decision-panel.tsx
    │   │   ├── activity-timeline.tsx
    │   │   ├── execution-truth-strip.tsx
    │   │   ├── task-detail.loader.server.ts
    │   │   └── task-detail.loader.server.test.ts
    │   ├── project-admin/
    │   │   ├── project-settings-page.tsx
    │   │   ├── workflow-rules-editor.tsx
    │   │   ├── agent-policy-editor.tsx
    │   │   ├── project-admin.loader.server.ts
    │   │   └── project-admin.loader.server.test.ts
    │   ├── org-admin/
    │   │   ├── user-management-page.tsx
    │   │   ├── agent-catalog-page.tsx
    │   │   ├── org-policy-page.tsx
    │   │   ├── org-admin.loader.server.ts
    │   │   └── org-admin.loader.server.test.ts
    │   └── live-updates/
    │       ├── sse-client.ts
    │       ├── sse-hooks.ts
    │       ├── event-types.ts
    │       └── sse-client.test.ts
    ├── schemas/
    │   ├── task-file.schema.ts
    │   ├── project-file.schema.ts
    │   ├── api-error.schema.ts
    │   ├── sse-event.schema.ts
    │   ├── auth.schema.ts
    │   └── github-pat.schema.ts
    ├── server/
    │   ├── config/
    │   │   ├── env.server.ts
    │   │   └── env.server.test.ts
    │   ├── db/
    │   │   ├── sqlite.server.ts
    │   │   ├── query-runner.server.ts
    │   │   └── migration-runner.server.ts
    │   ├── files/
    │   │   ├── file-store-root.server.ts
    │   │   ├── file-watch.service.server.ts
    │   │   ├── project-file-reader.server.ts
    │   │   ├── task-file-reader.server.ts
    │   │   ├── project-file-reader.server.test.ts
    │   │   └── task-file-reader.server.test.ts
    │   ├── interpretation/
    │   │   ├── readiness-policy.server.ts
    │   │   ├── diagnostics-policy.server.ts
    │   │   ├── pat-diagnostics-policy.server.ts
    │   │   ├── projection-freshness-policy.server.ts
    │   │   ├── readiness-policy.server.test.ts
    │   │   └── diagnostics-policy.server.test.ts
    │   ├── projections/
    │   │   ├── projection-rebuilder.server.ts
    │   │   ├── task-projection-repository.server.ts
    │   │   ├── board-query.server.ts
    │   │   ├── task-query.server.ts
    │   │   ├── projection-rebuilder.server.test.ts
    │   │   └── task-query.server.test.ts
    │   ├── provenance/
    │   │   ├── provenance-recorder.server.ts
    │   │   ├── provenance-query.server.ts
    │   │   └── provenance-recorder.server.test.ts
    │   ├── auth/
    │   │   ├── session-cookie.server.ts
    │   │   ├── oauth-google.server.ts
    │   │   ├── oauth-github.server.ts
    │   │   ├── csrf.server.ts
    │   │   ├── session-cookie.server.test.ts
    │   │   └── oauth-github.server.test.ts
    │   ├── secrets/
    │   │   ├── secret-box.server.ts
    │   │   ├── pat-store.server.ts
    │   │   ├── pat-validator.server.ts
    │   │   ├── pat-store.server.test.ts
    │   │   └── pat-validator.server.test.ts
    │   ├── github/
    │   │   ├── github-client.server.ts
    │   │   ├── repo-access-check.server.ts
    │   │   ├── branch-sync.server.ts
    │   │   ├── pr-linker.server.ts
    │   │   └── branch-sync.server.test.ts
    │   ├── runtimes/
    │   │   ├── codex-runtime.server.ts
    │   │   ├── claude-runtime.server.ts
    │   │   ├── runtime-registry.server.ts
    │   │   └── runtime-registry.server.test.ts
    │   ├── events/
    │   │   ├── sse-broker.server.ts
    │   │   ├── event-publisher.server.ts
    │   │   └── event-publisher.server.test.ts
    │   ├── errors/
    │   │   ├── app-error.server.ts
    │   │   ├── error-codes.ts
    │   │   └── error-response.server.ts
    │   └── logging/
    │       ├── logger.server.ts
    │       ├── request-context.server.ts
    │       └── logger.server.test.ts
    └── shared/
        ├── dates/
        │   ├── iso-date.ts
        │   └── iso-date.test.ts
        ├── ids/
        │   ├── task-key.ts
        │   └── task-key.test.ts
        └── mapping/
            ├── db-to-api.ts
            ├── file-to-projection.ts
            └── file-to-projection.test.ts
```

### Runtime Data Root

The file-authoritative management plane should not live inside the source repository. It should be a mounted writable data root, for example:

```text
/var/lib/viberr/
├── projects/                # authoritative/shared
│   └── <project-slug>/
│       ├── project.md
│       └── tasks/
│           └── VIB-142/
│               ├── task.md
│               └── attachments/
├── agents/                  # system-managed
│   ├── profiles/
│   └── assignments/
├── runtimes/                # system-managed
│   ├── codex/
│   └── claude/
├── state/                   # durable-derived
│   └── projection.sqlite
├── cache/                   # disposable
│   ├── parsed-files/
│   └── search/
├── auth/                    # secret
│   └── encrypted-secrets/
└── logs/                    # diagnostic
    ├── app/
    └── audit/
```

Operational ownership rules:

- `projects/` is the only authoritative shared business state writable by humans and agents.
- `agents/` and `runtimes/` are system-managed working state and should not be used as ad hoc communication buses.
- `state/projection.sqlite` is app-owned durable interpretation state and must never be treated as canonical truth or hand-edited by agents.
- `cache/` is disposable and fully rebuildable.
- `auth/` contains encrypted secrets only.
- `logs/` is diagnostic output only and must not be used as workflow state.

### Architectural Boundaries

**API Boundaries:**

- First-party app flows use React Router loaders/actions.
- `resources.events.ts` is the SSE boundary for live updates.
- Dedicated JSON endpoints exist only for narrow automation needs, such as comment append or controlled task actions.
- Narrow JSON/action routes in `app/routes/` must delegate immediately into feature/server modules rather than accumulate business logic locally.
- OAuth callbacks are isolated to `app/routes/auth.callback.*.tsx`.

**Component Boundaries:**

- Route modules stay thin and delegate to feature loaders/components.
- `app/ui/` holds reusable primitives only.
- `app/ui/` may not import from `app/features/`.
- `app/features/` owns surface-specific UI and route-facing orchestration.
- `app/server/` owns all server-only logic and may not be imported into client-only modules.
- `app/shared/` contains only narrow, stable cross-surface code and must not become a spillover zone for feature-specific logic.

**Service Boundaries:**

- `server/files/` owns direct file-system reads/watch roots.
- File watchers target authoritative project/task files and relevant managed state roots, not the entire data root indiscriminately.
- `server/interpretation/` owns shared policy logic for readiness, diagnostics, PAT validity, and freshness.
- `server/projections/` owns SQLite materialization and query paths.
- `server/github/` owns GitHub API operations only.
- `server/runtimes/` owns Codex/Claude execution adapters only.
- `server/events/` owns SSE publication only.

**Data Boundaries:**

- Files in `/var/lib/viberr/projects` are canonical truth.
- SQLite in `/var/lib/viberr/state/projection.sqlite` is durable interpretation/projection state.
- `db/migrations/` applies only to projection/interpreter schema, never to primary business truth.
- PATs and encrypted secrets remain in `/var/lib/viberr/auth`, never in task files or logs.
- Caches under `/var/lib/viberr/cache` are disposable.

### Requirements to Structure Mapping

**FR Category Mapping:**

- Workspace access & collaboration → `app/features/auth`, `app/features/org-admin`, `app/server/auth`
- Project governance & policy → `app/features/project-admin`, `app/server/interpretation`, `app/server/projections`
- Task records & lifecycle → `app/server/files`, `app/server/interpretation`, `app/features/task-detail`
- Agent orchestration & continuity → `app/server/runtimes`, `app/server/events`, `app/server/provenance`
- Oversight views & human governance → `app/features/board`, `app/features/task-detail`, `app/features/live-updates`
- GitHub delivery & traceability → `app/server/github`, `app/server/secrets`, `app/features/task-detail`
- Integrity, audit & recovery → `app/server/provenance`, `app/server/logging`, `app/server/errors`, `app/server/interpretation`

**Cross-Cutting Concerns:**

- Readiness-state derivation → `app/server/interpretation/readiness-policy.server.ts`
- Diagnostics severity → `app/server/interpretation/diagnostics-policy.server.ts`
- PAT validation → `app/server/secrets/pat-validator.server.ts`
- File/projection mapping → `app/shared/mapping/file-to-projection.ts`
- Structured errors → `app/server/errors/*`
- Correlated logs → `app/server/logging/*`

### Integration Points

**Internal Communication:**

- Route loaders/actions call feature server loaders or server services.
- File changes flow through `server/files` into `server/interpretation`, then `server/projections`, then `server/events`.
- UI consumes projections through loaders and revalidates on SSE events.

**External Integrations:**

- Google OAuth → `server/auth/oauth-google.server.ts`
- GitHub OAuth login → `server/auth/oauth-github.server.ts`
- GitHub PAT-backed repo access → `server/github/*` + `server/secrets/*`
- Codex and Claude execution → `server/runtimes/*`

**Data Flow:**

- File edit or rescan
- Parse + validate with explicit diagnostics
- Derive readiness/freshness/diagnostic state
- Persist projection + provenance in SQLite
- Publish compact SSE event
- Client revalidates affected route data

### File Organization Patterns

**Configuration Files:**

- Root config files define tooling and build behavior.
- Environment parsing exists only in `app/server/config/env.server.ts`.
- SQL migrations live in `db/migrations/`.

**Source Organization:**

- `app/routes/` is the route boundary.
- `app/features/` is the product-surface boundary.
- `app/server/` is the server-only boundary.
- `app/shared/` is only for narrow, purpose-specific shared code.

**Test Organization:**

- Unit/integration tests are co-located with source modules.
- Browser E2E tests live in `e2e/`.
- Shared fixtures/factories live in `test-support/`.
- `test-support/helpers/` remains purpose-named support code, not a generic dumping ground.

**Asset Organization:**

- Public assets live in `public/assets/`.
- No feature should create its own ad hoc asset root.

### Development Workflow Integration

**Development Server Structure:**

- React Router dev server runs the app.
- Local writable runtime data root is mounted separately from source.
- File watching and explicit rescan commands both target the runtime data root.

**Build Process Structure:**

- CI runs env verification, typecheck, lint, tests, migrations, and production build.
- Docker image packages the app source; runtime state mounts in externally.

**Deployment Structure:**

- Single-node Docker container runs app + SSE + SQLite-backed projections.
- Runtime data root persists across deploys as a mounted volume.
- SQLite backup and restore operate at the mounted state directory layer, not through source control.

## Architecture Validation Results

### Coherence Validation ✅

**Decision Compatibility:**
The core decisions work together without contradiction:

- React Router framework mode, Node runtime, Docker deployment, and SSE form a coherent single-node operational model.
- File-authoritative business state aligns with SQLite as durable interpretation/projection state rather than primary truth.
- Cookie-only sessions align with OAuth-first login so long as session payloads remain intentionally small.
- Fine-grained PATs fit the GitHub integration model while preserving a clean separation between login identity and execution credentials.
- The no-distributed-cache decision is consistent with SQLite-in-production, single-node deployment, and rebuildable local caches.
- Zod-based tolerant parsing, readiness-state derivation, and explicit diagnostics reinforce the file-authoritative model rather than competing with it.

**Pattern Consistency:**
The implementation patterns support the architecture:

- Naming conventions are consistent across code, API, SSE, and SQLite boundaries.
- Centralized interpretation rules prevent readiness-state, diagnostics, and PAT-validation drift.
- SSE patterns align with the event-driven refresh model and avoid introducing a second source of truth.
- Error-handling, retry, and loading-state rules support the product's operational-legibility UX.
- Boundary rules for `app/ui`, `app/features`, `app/server`, and `app/shared` match the chosen stack and anti-drift goals.

**Structure Alignment:**
The project structure supports the architecture directly:

- The source repo and runtime data root are separated cleanly.
- Runtime data ownership is clear across authoritative, system-managed, durable-derived, disposable, secret, and diagnostic directories.
- Server-only capabilities are isolated from UI modules.
- Projection schema, provenance, diagnostics, auth, GitHub, and runtime adapters each have explicit homes.
- The structure makes the chosen implementation patterns enforceable rather than aspirational.

### Requirements Coverage Validation ✅

**Epic/Feature Coverage:**
No epics were loaded as separate artifacts, but the FR categories and user journeys are fully represented across the proposed surfaces and services:

- operator supervision surfaces
- task detail and decision flows
- project governance/admin surfaces
- organization admin/auth surfaces
- GitHub execution integration
- runtime orchestration and continuity handling
- diagnostics, provenance, and audit support

**Functional Requirements Coverage:**
All FR categories are architecturally covered:

- Workspace access & collaboration: covered by auth, session, org admin, and role boundaries
- Project governance & policy: covered by project-admin modules and interpretation/policy services
- Task records & lifecycle: covered by file readers, schemas, projections, and task-detail surfaces
- Agent orchestration & continuity: covered by runtime adapters, provenance, SSE, and readiness/diagnostic policy
- Oversight & human governance: covered by board, queue, task detail, and decision-panel structures
- GitHub delivery & traceability: covered by GitHub client, PAT store/validator, branch sync, PR linkage, and execution truth surfaces
- Integrity, audit & recovery: covered by provenance, structured logging, typed errors, diagnostics, and explicit runtime-data boundaries

**Non-Functional Requirements Coverage:**

- Performance: addressed through SQLite projections, local caches, SSE revalidation, and desktop-first rendering strategy
- Security: addressed through OAuth login, fine-grained PATs, encrypted secret storage, CSRF, secure cookies, and separation of login vs execution credentials
- Reliability & recovery: addressed through file authority, tolerant parsing, explicit diagnostics, rebuildable projections, and replay-safe SSE revalidation
- Scalability: addressed intentionally by constraining the system to a single-node model with SQLite in production
- Auditability: addressed through observational provenance, structured logs, and task/projection/event traceability
- Deployment/self-hosting: addressed through Docker-first single-node deployment and external runtime-data volume design

### Implementation Readiness Validation ✅

**Decision Completeness:**
The architecture now documents all implementation-blocking decisions:

- platform/runtime choice
- projection database strategy
- auth/session model
- GitHub credential model
- live-update transport
- validation approach
- cache model
- deployment target
- directory boundaries
- anti-drift implementation patterns

**Structure Completeness:**
The structure is specific enough for implementation:

- root config/build files defined
- app route and feature surfaces defined
- server module boundaries defined
- SQLite migration location defined
- test organization defined
- runtime data root defined
- integration points mapped

**Pattern Completeness:**
The highest-risk drift areas are covered:

- naming
- mapping boundaries
- readiness-state derivation
- diagnostics behavior
- SSE event shape
- error format
- test placement
- utility/module sprawl
- parse failure handling

### Gap Analysis Results

**Critical Gaps:**
- No critical architectural gaps identified.

**Important Gaps:**

- Exact OAuth implementation library is intentionally not fixed yet. This is an implementation choice within the documented auth boundary, not an architecture blocker.
- Exact PAT encryption primitive/key-management implementation is not named yet. The boundary and storage rules are defined; the concrete mechanism should be selected in the first auth/secrets implementation story.
- Long-running runtime orchestration semantics for Codex/Claude execution will need operational detail during implementation, especially cancellation, retries, and resume behavior. The architectural placement is already defined.

**Nice-to-Have Gaps:**

- Additional operational documentation for backups/restores of the runtime data root
- Supplementary examples for diagnostics payloads and SSE event payloads
- Search strategy beyond SQLite if product scale changes materially later

### Validation Issues Addressed

- Clarified SQLite as durable interpretation/projection state, not primary business truth
- Clarified cookie-only sessions must remain compact
- Clarified PAT failure diagnostics as first-class architecture behavior
- Clarified SSE as reconnect-safe and revalidation-oriented
- Clarified runtime-data ownership boundaries
- Clarified one-way dependency rules between shared UI primitives and feature modules
- Clarified that tolerant parsing must still emit explicit diagnostics

### Architecture Completeness Checklist

**✅ Requirements Analysis**

- [x] Project context thoroughly analyzed
- [x] Scale and complexity assessed
- [x] Technical constraints identified
- [x] Cross-cutting concerns mapped

**✅ Architectural Decisions**

- [x] Critical decisions documented with versions
- [x] Technology stack fully specified
- [x] Integration patterns defined
- [x] Performance considerations addressed

**✅ Implementation Patterns**

- [x] Naming conventions established
- [x] Structure patterns defined
- [x] Communication patterns specified
- [x] Process patterns documented

**✅ Project Structure**

- [x] Complete directory structure defined
- [x] Component boundaries established
- [x] Integration points mapped
- [x] Requirements to structure mapping complete

### Architecture Readiness Assessment

**Overall Status:** READY FOR IMPLEMENTATION

**Confidence Level:** High

**Key Strengths:**

- Strong internal alignment between product model and technical architecture
- Clear separation between authoritative file state and derived system state
- Good anti-drift rules for multi-agent implementation
- Deployment model is intentionally simple and operationally coherent
- Requirements map cleanly into concrete structures and boundaries

**Areas for Future Enhancement:**

- Operational playbooks for secret rotation, backup/restore, and runtime recovery
- More detailed runtime lifecycle docs once execution stories begin
- Search and scale evolution only if product usage proves the need
- Smoother PAT onboarding and org-approval guidance to reduce user friction

### Implementation Handoff

**AI Agent Guidelines:**

- Follow all architectural decisions exactly as documented
- Use implementation patterns consistently across all components
- Respect project structure and boundaries
- Refer to this document for all architectural questions

**First Implementation Priority:**
Initialize the scaffold first:

```bash
npx create-react-router@latest --template remix-run/react-router-templates/default
```

Then prove the architecture with one end-to-end slice covering:

1. typed env/config bootstrap
2. OAuth login with cookie session
3. PAT storage and validation
4. one file-to-projection rebuild path
5. one SSE-driven board refresh path
