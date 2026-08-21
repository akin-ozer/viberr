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
- Human authentication: email + password is the shipped default and a first-class path; Google and GitHub OAuth are optional and off unless configured.
- App sessions: server-side session rows keyed by an opaque cookie.
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

*Revised 2026-07-25 — this section originally specified OAuth-first login, which is not what shipped and would mislead anyone extending auth.*

- **Local credentials (email + password) are the shipped default and a first-class path**, not a fallback. A self-hosted instance must be usable with no external identity provider configured, so the bootstrap admin and every user created in-app authenticate this way. Password policy is shared client/server from one module.
- OAuth with Google and GitHub is **optional and disabled unless its environment variables are present** — the login buttons stay inert without them. Sign-in through either provider is whitelist-based: it succeeds only for an email that already has a non-disabled user row, plus (for Google) domains on the org allowlist, which provision on first login. There is no self-signup on any path.
- Auth is implemented on `better-auth` behind a Viberr bridge; do not hand-roll a second credential or session path beside it.

**Session model:**

- Sessions are **server-side rows in SQLite**; the cookie carries only an opaque token. This is not a divergence from the original intent — the data architecture below already contemplated a session table, and an opaque token satisfies the "no dynamic authorization or execution metadata in the cookie" rule absolutely rather than by discipline.
- Nothing but the token belongs in the cookie. Authorization is resolved per request from the session row and project membership, never read from a client-held claim.
- Expired sessions are swept at boot and daily.

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
  - review queue
  - project settings & policy
  - org settings
  - agents & context resources
  - GitHub delivery
  - runtime/run inspection
  - app shell (rail, topbar, notifications)
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
- CI covers lint, typecheck, tests, build integrity, and an end-to-end suite. Migration integrity is covered transitively: the migration-runner test applies the real baseline and asserts idempotency and constraints, and the unit suite runs in CI.
- **There IS a linter, and it is a gate: oxlint with the vendored 15-rule `anti-slop` plugin** (`.oxlintrc.json`, `tools/oxlint/anti-slop/`), run as `npm run lint` and required in the `verify` CI job. There is still no formatter, and adding one remains a non-goal. *(Reversed 2026-08-19, pass 21 — ruling 86 / R21-3. The original entry, recorded 2026-07-25, read "There is no linter or formatter, and adding one is a deliberate non-goal", on the reasoning that a linter would produce a mechanical diff across the whole tree for no behavioral gain. The linter landed anyway in commits `54ffab8`/`ce2bc9e` and this sentence was left standing, which is the drift U1 was filed for. The old reasoning was not baseless: the adopting rewrite touched 387 files and introduced four behavioral regressions — F21-7/8/9/11, all fixed in pass 21 — so a mechanical tree-wide change is now held to the same review bar as behavior.)* The anti-drift rules in this document are enforced by typecheck, tests, lint, and review — see Pattern Enforcement.

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

**Implementation Sequence** (historical build order — step 3 predates the 2026-07-25
Authentication revision above; the shipped default is email+password via better-auth with
OAuth optional, see §Authentication):

1. Initialize the React Router starter and lock runtime/tooling baseline.
2. Implement typed environment configuration and secret handling.
3. Build cookie-session OAuth login with Google and GitHub.
4. Add encrypted fine-grained PAT storage and validation flow.
5. Implement SQLite projection schema, SQL migrations, and provenance model.
6. Implement file observation, tolerant parsing, diagnostics, and readiness-state derivation.
7. Build loader/action-based board and task surfaces against projections.
8. Add SSE-based live update propagation.
9. Add GitHub sync/execution integration.
10. Add structured logging, provenance recording, and operational diagnostics. (Provenance is internal — it backs GitHub freshness and rebuild diagnostics. No user-facing provenance view ships in V1.)

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
- Primary top-level app surfaces: board supervision, task detail, review queue, project settings & policy, org settings, agents & context resources, GitHub delivery, runtime inspection, activity/audit, notifications, profile, and the app shell. Sign-in is a route, not a feature folder — see the directory structure.
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

- Enforce through typechecking, tests, lint, and review against this architecture document. The linter (see CI/CD above) machine-checks the `anti-slop` implementation-pattern rules only — none of the naming, module-boundary or dumping-ground rules in this document is expressible in it, so for those a reviewer is still the only gate and pattern violations must actually be called out *(amended 2026-08-19, pass 21 — ruling 86 / R21-3; the sentence used to read "There is no linter … a reviewer is the only gate", which stopped being true when oxlint landed)*
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

This tree is **descriptive, regenerated from the filesystem** (last resynced 2026-07-25;
spot-corrected 2026-08-06, pass 19, and again 2026-08-19, pass 21 — the deltas are marked
inline and the promise below is exactly why they had to be fixed rather than left).
It is not a wish list: a directory that is not here does not exist, and a directory here
that you cannot find is a bug in this document, not a gap to fill. Tests are co-located
with their modules and elided below except where the file count matters.

```text
viberr/
├── README.md
├── CONTRIBUTING.md
├── package.json
├── tsconfig.json
├── react-router.config.ts
├── vite.config.ts
├── vitest.config.ts            # unit suite: app/ + db/ only (scripts/ deliberately excluded)
├── playwright.config.ts        # ONE browser project: chromium, plus a `setup` login fixture
│                               # (2026-08-19 — see the browser-matrix note)
├── doctor.config.ts            # react-doctor ignore list; manually invoked, not a gate
├── .oxlintrc.json              # the ONLY lint config; loads the anti-slop plugin (2026-08-19)
├── skills-lock.json
├── .env.example
├── .dockerignore
├── .gitignore
├── .nvmrc
├── Dockerfile
├── compose.yml
├── compose.e2e.yml             # production-image e2e stack (2026-08-03 modernization)
├── qa/                         # fixtures/notes agents produced during live QA passes
├── test-artifacts/             # captured command output from live validation passes (2026-08-19)
├── tools/
│   └── oxlint/anti-slop/       # the vendored 15-rule lint plugin (2026-08-19, ruling 86);
│                               # itself excluded from linting by .oxlintrc.json
├── .github/
│   └── workflows/
│       └── ci.yml              # two jobs: verify (lint/typecheck/test/build) + e2e
├── docs/
│   ├── architecture/
│   │   ├── decisions.md        # binding conventions + the numbered orchestrator rulings
│   │   └── file-formats.md     # canonical project.md / task.md / agent-profile format
│   ├── operations/
│   │   ├── deployment.md
│   │   └── runbook.md
│   ├── testing.md
│   ├── testing-quickstart.md
│   └── contributing-quickstart.md
├── db/
│   └── migrations/
│       └── 0001_baseline.sql   # squashed while pre-production; forward-only after first deploy
├── scripts/
│   ├── seed.ts                 # product baseline — clean sheet, no demo board data
│   ├── seed-demo.ts            # the mock dataset the route + e2e suites are written against
│   ├── rescan.ts
│   ├── e2e.ts                  # drives compose.e2e.yml: production image, named volume
│   ├── docker-entrypoint.sh
│   └── measure-routes.mjs
├── public/
│   └── favicon.svg
├── e2e/                        # Playwright specs + auth setup / teardown
├── test-support/               # app/db/store/runtime/github fakes + the demo fixture
└── app/
    ├── app.css                 # the ported viberr.css design system + marked additions
    ├── root.tsx
    ├── routes.ts
    ├── entry.client.tsx
    ├── entry.server.tsx
    ├── routes/                 # 26 thin route modules (was 25 before /resources/search)
    │   ├── _index.tsx          # home (project list)
    │   ├── login.tsx  logout.tsx  api.auth.$.ts     # api.auth.$ is better-auth's splat
    │   ├── projects.tsx  project.tsx  project._index.tsx
    │   ├── project.board.tsx  project.review.tsx  project.agents.tsx
    │   ├── project.policy.tsx  project.github.tsx  project.activity.tsx
    │   ├── project.settings.tsx  project.task.tsx
    │   ├── org.settings.tsx  profile.tsx  notifications.tsx  notifications.read.tsx
    │   ├── prefs.theme.tsx
    │   └── resources.{events,health,run-log,search,session-export,model-catalog}.ts
    │                           # resources.search backs the ⌘K palette (R15-5)
    ├── ui/                     # reusable primitives + shared hooks
    │   ├── icon.tsx  pill.tsx  avatar.tsx  identity.tsx  toggle.tsx
    │   ├── rich-text.tsx  markdown.tsx  mention-spans.ts  initials.ts
    │   ├── toast.tsx  page-overlay.tsx  stage-menu.tsx  skip-link.tsx  csrf-input.tsx
    │   ├── local-time.tsx  roving-radio.ts
    │   └── use-{dialog,dismiss,action-toast,fetcher-result,relative-time,shortcut-hint}.ts
    ├── lib/
    │   └── auth.server.ts      # the better-auth instance + its Viberr bridge
    ├── features/               # 16 product surfaces; no auth/ — login is a route
    │   ├── activity/           # audit + activity feed
    │   ├── agents/             # profiles, capability matrix, deployment
    │   ├── board/              # board-page + pure filter predicates
    │   ├── github/             # repo/PR view, credential card, pills, actions
    │   ├── home/               # project list + project creation
    │   ├── kb-browser/         # knowledge-base / skill store browser
    │   ├── live-updates/       # SSE client hook + event types
    │   ├── notifications/
    │   ├── org-settings/       # users, connections, org resources
    │   ├── policy/             # workflow boundaries + RBAC/capability display
    │   ├── profile/
    │   ├── project-settings/   # stages, repo, membership
    │   ├── review/             # the review queue
    │   ├── runtime/            # run panels, log stream, run state mapping
    │   ├── shell/              # rail, topbar, bell, user menu, nav mapping
    │   └── task-detail/        # the deepest surface: packet, timeline, execution profile
    ├── schemas/
    │   ├── task-file.schema.ts       # the largest contract: frontmatter, packets, events
    │   ├── project-file.schema.ts
    │   ├── sse-event.schema.ts
    │   ├── github-pat.schema.ts
    │   └── file-diagnostics.ts
    ├── server/
    │   ├── boot.server.ts      # the one startup sequence (dirs, migrations, seed admin,
    │   │                       # recovery, retention, schedule runner, reconcile poller)
    │   ├── audit/              # audit-recorder
    │   ├── auth/               # csrf, login, identity, password, oauth provisioning,
    │   │                       # project authority, route guards, user store/admin
    │   ├── config/             # env.server.ts — the ONLY place env is parsed
    │   ├── db/                 # sqlite, migration runner, transaction, retention
    │   ├── errors/             # AppError + stable machine codes
    │   ├── events/             # sse-broker, event-publisher, projection-events
    │   ├── files/              # store root, watchers, atomic writes, per-file mutex,
    │   │                       # frontmatter, task/project/agent-profile readers+writers,
    │   │                       # KB + skill body injection
    │   ├── github/             # client, repo access, branch sync, PR linker/open,
    │   │                       # reconciler, reconcile poller, workspace delivery, scope flags
    │   ├── interpretation/     # readiness-policy, diagnostics-policy, freshness-policy
    │   ├── logging/            # logger.server.ts
    │   ├── provenance/         # the ONLY writer/reader of the provenance table
    │   ├── org/                # org users, connections, resources (KB/skills/MCP),
    │   │                       # global agents, store files, org seed
    │   ├── prefs/  theme/      # user preferences; theme cookie
    │   ├── projections/        # rebuilder, rescan, rebuild, board/task queries,
    │   │                       # activity feed, decisions, notifications, review queue,
    │   │                       # policy violations, agent deployments
    │   ├── runtimes/           # Claude + Codex adapters, registry, run service/store/
    │   │                       # sink/events/projection/recovery, wire format,
    │   │                       # session export, model catalog
    │   ├── secrets/            # secret-box (AES-256-GCM), PAT store + validator
    │   ├── seed/               # product seed, agent catalog, shipped agent assets
    │   └── tasks/              # the governed-mutation core (largest server module):
    │                           # task actions, operator actions + toolkit, agent toolkit,
    │                           # specialist run + MCP + tool policy, agent reply/outcome,
    │                           # comment guardrails, mentions, schedules, compaction,
    │                           # git clone auth
    └── shared/                 # client-safe cross-surface code
        ├── rbac.ts             # THE project-role grant table (guards + Policy page)
        ├── capabilities.ts     # THE agent capability catalog + always-human invariants
        ├── freshness.ts        # THE staleness thresholds (server door: interpretation/)
        ├── docs/               # prd-sync.test.ts — pins design/prd.md to canon (R18-6)
        ├── auth/  dates/  ids/  mapping/  text/  workflow/
```

**Notes on shape, so the next change stays inside it:**

- There is no `app/features/auth/`. Sign-in is one route (`app/routes/login.tsx`) over
  `app/server/auth/` and `app/lib/auth.server.ts`. Do not create one.
- `app/server/tasks/` is where governed task mutation lives, and `task-actions.server.ts`
  inside it is by far the largest module in the tree. It is a known concentration, not a
  precedent: new governed behavior belongs in a sibling module in the same directory.
- `app/server/provenance/` is a recorder plus a query module and nothing else. Every write
  to and read from the `provenance` table goes through it — the table previously had two
  duplicated writers and three ad hoc readers, one of them a raw prepared statement inside
  a route loader. There is no user-facing provenance view and none is planned for V1; the
  data backs GitHub freshness and rebuild diagnostics.
- There is no `eslint.config.js`, `prettier.config.cjs`, `tailwind.config.ts` or
  `postcss.config.mjs`. None has ever existed here. Lint config is `.oxlintrc.json` alone,
  and its one plugin is the vendored `tools/oxlint/anti-slop/` — do not add a second lint
  or formatter toolchain beside it *(amended 2026-08-19, pass 21 — ruling 86 / R21-3; this
  bullet used to close with "(see the CI/CD decision)", the no-linter decision that ruling
  reversed)*.
- `docs/operations/pat-management.md` was prescribed and never written. PAT setup lives in
  the README's GitHub section and PAT triage in the runbook, so it was dropped from this
  tree rather than left as a phantom.
- Migrations are squashed into a single baseline while the product is pre-production. That
  is deliberate and time-boxed: after the first real deployment, migrations become additive
  and forward-only.

### Runtime Data Root

The file-authoritative management plane should not live inside the source repository. It should be a mounted writable data root, for example:

The shipped layout, created at boot from `DATA_ROOT_SUBDIRS`:

```text
/var/lib/viberr/
├── projects/                # authoritative/shared
│   └── <project-slug>/
│       ├── project.md
│       └── tasks/
│           └── VIB-142/
│               ├── task.md
│               └── workspace/        # the agent's git clone — NOT canonical
├── agents/                  # system-managed
│   └── profiles/            # org-level agent profile templates (*.md)
├── runtimes/                # system-managed
│   ├── claude-home/         # SDK session home + raw NDJSON run logs
│   └── codex-home/          # ditto; may hold auth.json (a live credential)
├── kb/<dir>/                # knowledge-base folders (granted BY DIRECTORY)
├── skills/<slug>/           # skill folders
└── state/
    ├── projection.sqlite
    └── writer.lock          # the single-writer lock: ONE app process per data
                             # root, ever (B-FD1 / F18-5). Never delete it while
                             # a process is running — see docs/operations/deployment.md
```

Operational ownership rules:

- `projects/` is the only authoritative shared business state writable by humans and agents. *(Amended 2026-08-21, pass 22 — this bullet used to end "`attachments/` was specified here and never implemented; do not write to it", which had been flatly false since 2026-08-14.)* **`attachments/` is real** (ruling 75 / R19-19): each task owns `projects/<slug>/tasks/<KEY>/attachments/` (`taskAttachmentsDir` in `app/server/files/file-store-root.server.ts`), written by the browser MCP's `--output-dir` (default-named screenshots) and by the general agent evidence drop (#179 / ruling 96 — any run granted `attach-evidence-references` may copy files there, and they post on its reply), served member-only via `app/routes/task-attachment.ts` and rendered as timeline thumbnails with an in-app lightbox. There is no retention machinery — the files ride with the task directory. Like `workspace/`, it is excluded from the file watcher and carries no projection rows of its own.
- *(Added 2026-08-21, pass 22.)* `projects/<slug>/.repo-mirror/<owner>__<repo>.git` is the per-project bare mirror cache behind task workspace clones (ruling 87 / R21-4, `app/server/tasks/repo-mirror.server.ts`): fetched from GitHub before each workspace clone, then cloned FROM locally (hardlinked object store), so a workspace survives the mirror's deletion. Disposable derived state, never canonical, ignored by the watcher like `workspace/`.
- **`<taskDir>/workspace/<repo>` is a full git clone**, created the first time an agent runs on that task. It is deliberately inside the task directory — the agent's `GIT_CEILING` confinement depends on that placement — and it is deliberately excluded from the file watcher and from projection. It is disposable working state, never a communication channel, and never read as truth. Sizing note: this is 11–16 MB per task that has ever run an agent.
- `agents/` and `runtimes/` are system-managed working state and should not be used as ad hoc communication buses. `runtimes/codex-home/auth.json`, when present, is a live credential — any backup of the data root must be treated as a secret.
- **`state/projection.sqlite` must never be treated as canonical truth *for tasks and projects*, and must never be hand-edited — but it is not a cache.** It is the *only* home of every non-rebuildable app-management row: users and their credentials, sessions, the audit trail, notifications, AES-sealed PATs, org resources, agent run history and staged outcomes. None of that exists in the Markdown. The projection tables inside the same file *are* derived and rebuild from `projects/`; the distinction is per-table, not per-file. Restoring `projects/` without this database re-mints user ids that the surviving files still reference, orphaning every membership and task owner. *(Corrected 2026-07-25; the original text called the whole file non-canonical, which read as "disposable".)*
- There is **no `cache/`, `auth/` or `logs/` directory** — all three were prescribed and then removed on purpose (P11-56). Application logs are structured JSON on stdout; encrypted secrets live in SQLite; there is no disk cache layer.

### Architectural Boundaries

**API Boundaries:**

- First-party app flows use React Router loaders/actions.
- `resources.events.ts` is the SSE boundary for live updates.
- Dedicated JSON endpoints exist only for narrow automation needs, such as comment append or controlled task actions.
- Narrow JSON/action routes in `app/routes/` must delegate immediately into feature/server modules rather than accumulate business logic locally.
- OAuth callbacks are served by better-auth's own router behind the splat route
  `app/routes/api.auth.$.ts`, at `/api/auth/callback/<provider>`. *(Corrected 2026-08-06,
  pass 19 — this line prescribed `app/routes/auth.callback.*.tsx`, which the better-auth
  migration replaced; no such route exists or should be created. The splat's allow-list of
  reachable better-auth paths lives in `app/lib/auth.server.ts`.)*

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
- `server/interpretation/` owns shared policy logic for readiness, diagnostics, and freshness. **PAT validity is the documented exception** and belongs to `server/secrets/pat-validator.server.ts` — see the cross-cutting map below, which the build followed. (A staleness rule the *client* also evaluates keeps its threshold in `app/shared/freshness.ts`, because a `.server.ts` module cannot enter the client bundle; `interpretation/` is the server-side door onto the same definitions. One definition, two importers — never a second constant.)
- `server/projections/` owns SQLite materialization and query paths.
- `server/github/` owns GitHub API operations only.
- `server/runtimes/` owns Codex/Claude execution adapters only.
- `server/tasks/` owns governed task mutation — every write to `task.md` that carries authorization, audit and typed-event consequences.
- `server/events/` owns SSE publication only.

**Data Boundaries:**

- Files under `<data root>/projects/` are canonical truth for projects and tasks.
- `state/projection.sqlite` holds two different kinds of table and they must not be conflated: derived projections, which rebuild from files, and primary app-management state (users, sessions, audit, notifications, encrypted PATs, org resources, run history), which exists nowhere else. Rebuild operations touch only the first kind.
- `db/migrations/` applies only to that database, never to primary business truth in files.
- PATs and encrypted secrets are AES-256-GCM sealed **in SQLite**, with the key from the environment. They never appear in task or project files, in logs, in SSE payloads, or in error messages. *(The prescribed on-disk `auth/` secret directory does not exist and was removed on purpose; the security rule it carried is unchanged and is enforced.)*

### Requirements to Structure Mapping

**FR Category Mapping** *(resynced 2026-07-25 to the shipped module names)***:**

- Workspace access & collaboration → `app/routes/login.tsx`, `app/lib/auth.server.ts`, `app/server/auth`, `app/features/org-settings`
- Project governance & policy → `app/features/project-settings`, `app/features/policy`, `app/shared/rbac.ts`, `app/shared/capabilities.ts`, `app/server/interpretation`, `app/server/projections`
- Task records & lifecycle → `app/server/files`, `app/server/tasks`, `app/server/interpretation`, `app/features/task-detail`
- Agent orchestration & continuity → `app/server/runtimes`, `app/server/tasks`, `app/server/events`
- Oversight views & human governance → `app/features/board`, `app/features/review`, `app/features/task-detail`, `app/features/live-updates`
- GitHub delivery & traceability → `app/server/github`, `app/server/secrets`, `app/features/github`, `app/features/task-detail`
- Integrity, audit & recovery → `app/server/audit`, `app/server/logging`, `app/server/errors`, `app/server/projections`, `app/server/interpretation`

**Subsystem Mapping.** Four subsystems the PRD mandates were absent from this document
entirely, which is how they ended up with no named home. They are:

- **Decision & blocking packets** (FR26, FR27) — the packet shape is in `app/schemas/task-file.schema.ts` (stable option `kind`s, never English titles); generation and resolution are in `app/server/tasks/`; the surfaces are `app/features/task-detail/decision-packet.tsx` and `app/features/review/`.
- **The operator agent** (FR18, FR20, FR26) — `app/server/tasks/operator-actions.server.ts` plus `operator-toolkit.server.ts` (the tool surface it is allowed to act through) and `app/server/runtimes/operator-run.server.ts`. The operator re-anchors on a fresh task snapshot every turn; it does not rely on provider-side history.
- **Specialist execution** (FR19, FR21, FR22) — `app/server/tasks/specialist-run.server.ts`, `agent-toolkit.server.ts`, `agent-reply.server.ts`, `specialist-tool-policy.ts`, over the adapters in `app/server/runtimes/`.
- **Context resources: knowledge bases, skills, and MCP servers** (FR9) — the org-level catalog and store are `app/server/org/`, injection into a run is `app/server/files/kb-injection.server.ts` and `skill-body.server.ts`, MCP wiring is `app/server/tasks/specialist-mcp.server.ts`, and the browsing surface is `app/features/kb-browser/`. A grant resolves **by store directory**, never by display name.

**Cross-Cutting Concerns:**

- Readiness-state derivation → `app/server/interpretation/readiness-policy.server.ts`
- Diagnostics severity → `app/server/interpretation/diagnostics-policy.server.ts`
- Staleness/freshness thresholds → `app/shared/freshness.ts` (server door: `app/server/interpretation/freshness-policy.server.ts`)
- PAT validation → `app/server/secrets/pat-validator.server.ts`
- Project-role authorization → `app/shared/rbac.ts` (one table, rendered by the Policy page and consulted by the guards)
- Agent capability policy → `app/shared/capabilities.ts` (catalog + always-human invariants)
- File/projection mapping → `app/shared/mapping/*`
- Structured errors → `app/server/errors/*`
- Logging → `app/server/logging/*`

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

- CI runs two jobs: `verify` (lint → typecheck → unit/integration tests → production build) and `e2e` (Playwright against the production Docker image in an isolated Compose stack — never a dev server, owner policy 2026-08-02). Env validation and migration integrity are exercised inside the test suite. *(Amended 2026-08-19, pass 21: the lint step is new and required — ruling 86 / R21-3 — replacing "there is no lint step, by decision"; and the e2e job was described as running against "a real dev server", which `playwright.config.ts` and `scripts/e2e.ts` have not done since 2026-08-02.)*
- **Browser coverage is chromium, and only chromium.** `playwright.config.ts` declares exactly one BROWSER project (`chromium` / `devices["Desktop Chrome"]`) and CI installs that browser alone. Its only sibling project, `setup`, runs no specs of its own — it logs in once through the real `/login` UI and stores the session the chromium project then reuses, so it is a fixture, not a second browser. The PRD's browser matrix also names current Safari and current Firefox desktop; neither has ever been exercised here, automated or manual, in any pass. *(Recorded 2026-08-19, pass 21 — U6. Ruling 63 / R19-9's rule applies: a claim nothing measures is decoration. The matrix stands as declared support intent, but this document does not pretend it is verified — add a Playwright project or record a manual check before anyone says it is.)*
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
- Server-side sessions behind an opaque cookie align with both login paths (local credentials and optional OAuth) and keep authorization off the client entirely.
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

- Workspace access & collaboration: covered by auth, session, org settings, and role boundaries
- Project governance & policy: covered by project-settings and policy surfaces over the single RBAC and capability tables, plus interpretation/policy services
- Task records & lifecycle: covered by file readers/writers, schemas, projections, the governed-mutation core in `server/tasks`, and task-detail surfaces
- Agent orchestration & continuity: covered by runtime adapters, the operator and specialist run paths, SSE, and readiness/diagnostic policy
- Oversight & human governance: covered by board, review queue, task detail, and decision-packet structures
- GitHub delivery & traceability: covered by GitHub client, PAT store/validator, branch sync, PR linkage, the reconcile poller, and execution truth surfaces
- Integrity, audit & recovery: covered by the audit recorder, structured logging, typed errors, diagnostics, retention, and explicit runtime-data boundaries

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
The structure section is **descriptive of the built system**, resynced from the filesystem
on 2026-07-25. It was originally a pre-implementation prescription and drifted badly — it
prescribed a `features/auth/` that was never created and omitted six server modules
including the largest one — so it is now maintained the other way round: the tree is
generated from what exists, and a divergence is a doc bug to fix, not scope to build.

- root config/build files: listed as they exist, including the ones deliberately absent
- app route and feature surfaces: all 25 routes and 16 feature folders named
- server module boundaries: all 18 server directories named, with what each owns
- SQLite migration location defined
- test organization defined
- runtime data root: matches `DATA_ROOT_SUBDIRS`
- integration points mapped, including the four subsystems this document previously
  omitted (packets, operator, specialist execution, context resources)

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
- Clarified that the session cookie carries an opaque token only, with authorization resolved server-side per request
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
