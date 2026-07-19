# Pass 10 remediation implementation plan

Date: 2026-07-19

Status: proposed; decision-gated; no implementation has started

Evidence base: the complete pass-10 dossier, current source and tests, and the later disposable live-run observations described below

## 1. Outcome and scope

This plan turns all 37 pass-10 findings into a dependency-ordered remediation program. It is intentionally stricter than a conventional backlog:

- P0 runtime containment and server-owned delivery are release stop-lines, not incremental polish.
- Every finding has one and only one primary wave in the ownership ledger below.
- A wave closes only after its automated and live acceptance gates pass and its rollback path is rehearsed.
- Canonical file state remains authoritative. SQLite remains a projection, coordination, and runtime store; it must not silently become the sole product truth.
- Existing unsafe behavior is disabled when a safe implementation is unavailable. There is no fallback to host execution, ambient credentials, prompt-only policy, or UI-only authorization.

This document names implementation areas and likely files. It does not authorize product-code, production-data, GitHub, or live-UI changes by itself.

## 2. Release stop-line and exit definition

Do not call pass 10 remediated, enable autonomous specialist delivery, or run another real-repository acceptance exercise until all of the following are true:

1. The decisions in Wave 0 are signed and reflected in CANON.md and DECISIONS.md.
2. The test process is proven credential-sterile and deterministic.
3. Specialists execute in an enforceable isolation boundary with per-run environment and network allowlists.
4. Only the server can commit, push, open a pull request, or merge; every delivery action is bound to one authorized delivering engagement and a server-recomputed manifest.
5. Concurrent starts cannot create two delivery slots, and concurrent runs do not share mutable workspaces.
6. Verdicts bind to stable work revisions; comments or stage changes never count as rework.
7. Sensitive run artifacts have route-level authorization independent of general task visibility.
8. Resource resolution cannot escape its configured roots through names, traversal, symlinks, or recursion.
9. RBAC, product copy, visible controls, and keyboard behavior agree with server behavior.
10. A disposable end-to-end run passes, leaves its source tree clean, and verifiably removes remote test branches and artifacts.
11. CI, migration, monitoring, retention, backup, rollback, and operating documentation are in force.

Until item 3 and item 4 pass, the safe operating mode is:

- specialist run creation disabled or restricted to a non-mutating, isolated preview;
- push, pull-request creation, merge, and branch deletion disabled through specialist pathways;
- no backend adapter receives inherited process environment;
- no live acceptance against the Viberr product repository.

## 3. Dependency order

The critical path is:

    Wave 0 decisions ─┐
                      ├─> Wave 2 containment/delivery ─> Wave 3 state integrity ─┐
    Wave 1 test trust ┘                                      │                  ├─> Wave 5 product/UI
                                                             └─> Wave 4 authority/privacy ┘
                                                                                       │
                                                                                       v
                                                                             Wave 6 live acceptance
                                                                                       │
                                                                                       v
                                                                             Wave 7 release/operations

Wave 0 and Wave 1 can run in parallel. After Wave 2, Wave 3 and Wave 4 can run in parallel only where they do not both edit canonical task schemas or migrations. Wave 5 consumes server-derived policy and state; it must not invent those rules in the client. Wave 7 documentation and CI scaffolding may begin earlier, but the wave cannot close until Wave 6 evidence exists.

## 4. Authoritative finding ownership ledger

Only this table assigns primary wave ownership. Later discussion may describe cross-wave dependencies, but does not reassign a finding.

| Primary wave | Finding | Primary remediation outcome |
| --- | --- | --- |
| Wave 0 — decisions and stop-line | F10-15 | Sign a durable multi-review aggregation rule before review-state implementation. |
| Wave 0 — decisions and stop-line | F10-24 | Resolve repository/autonomy semantics and make creation promises match the supported model. |
| Wave 1 — trustworthy tests | F10-10 | Make every automated test fail closed against ambient backend credentials. |
| Wave 2 — P0 runtime containment and delivery allowlists | F10-01 | Replace specialist processes as a purported boundary with enforceable per-run isolation. |
| Wave 2 — P0 runtime containment and delivery allowlists | F10-02 | Construct minimal backend environments from an allowlist; never pass the full server environment. |
| Wave 2 — P0 runtime containment and delivery allowlists | F10-03 | Enforce capabilities at server and sandbox boundaries and present only guarantees that are real. |
| Wave 2 — P0 runtime containment and delivery allowlists | F10-12 | Prevent supporting reviewers from becoming an undeclared delivery path. |
| Wave 2 — P0 runtime containment and delivery allowlists | F10-31 | Derive every operator/specialist instruction from the same typed server-owned delivery contract. |
| Wave 3 — P1 concurrency and state integrity | F10-04 | Give every run a distinct immutable input and mutable workspace boundary. |
| Wave 3 — P1 concurrency and state integrity | F10-05 | Reserve the one delivering slot atomically in durable storage. |
| Wave 3 — P1 concurrency and state integrity | F10-08 | Make watcher retry lifecycle-owned, bounded, observable, and cancellable. |
| Wave 3 — P1 concurrency and state integrity | F10-09 | Resolve only a stable packet and option identity under canonical-file compare-and-swap. |
| Wave 3 — P1 concurrency and state integrity | F10-16 | Persist schedule claims and enqueue intent before a schedule can be considered fired. |
| Wave 3 — P1 concurrency and state integrity | F10-36 | Keep runtime workspaces outside the Vite source watch graph and bound development watcher scope. |
| Wave 4 — P1 authority and privacy | F10-06 | Decide and enforce separate authorization for task summaries, raw logs, transcripts, and event streams. |
| Wave 4 — P1 authority and privacy | F10-07 | Migrate legacy verdict modes explicitly and stop editor round-trips from widening authority. |
| Wave 4 — P1 authority and privacy | F10-14 | Make verdict authority explicit, visible, auditable, and revision-bound. |
| Wave 4 — P1 authority and privacy | F10-17 | Preserve rolling-session renewal headers on document and data responses. |
| Wave 4 — P1 authority and privacy | F10-18 | Resolve skill and knowledge resources beneath approved roots with traversal and symlink containment. |
| Wave 4 — P1 authority and privacy | F10-32 | Replace comment/stage heuristics with immutable work-revision identity before a rejection can be cleared. |
| Wave 4 — P1 authority and privacy | F10-33 | Make project discovery, task detail, logs, exports, and events follow one explicit per-surface authorization matrix. |
| Wave 5 — P2 product truth, RBAC, UI, and accessibility | F10-11 | Define review readiness from actual current-revision acceptance prerequisites. |
| Wave 5 — P2 product truth, RBAC, UI, and accessibility | F10-13 | Offer only server-valid owner/reviewer choices and explain ineligible choices consistently. |
| Wave 5 — P2 product truth, RBAC, UI, and accessibility | F10-19 | Make activity entries scannable summaries with deliberate access to full reports. |
| Wave 5 — P2 product truth, RBAC, UI, and accessibility | F10-20 | Separate profile identity, task role, engagement kind, and backend in live-run presentation. |
| Wave 5 — P2 product truth, RBAC, UI, and accessibility | F10-21 | Label operator/specialist/resource counts truthfully and expose ephemeral or degraded resource health. |
| Wave 5 — P2 product truth, RBAC, UI, and accessibility | F10-22 | Render fixed-stage and destructive controls with their real availability and policy. |
| Wave 5 — P2 product truth, RBAC, UI, and accessibility | F10-25 | Provide a complete keyboard and assistive-technology equivalent for board and custom-menu actions. |
| Wave 5 — P2 product truth, RBAC, UI, and accessibility | F10-27 | Repair login composition and responsive balance at desktop sizes. |
| Wave 5 — P2 product truth, RBAC, UI, and accessibility | F10-28 | Show GitHub freshness, last successful sync, failure, and manual-refresh limits honestly. |
| Wave 5 — P2 product truth, RBAC, UI, and accessibility | F10-30 | Remove the parallel non-operator built-in definition source and use one generic profile model. |
| Wave 5 — P2 product truth, RBAC, UI, and accessibility | F10-34 | Hide or truthfully disable destructive controls for viewers while retaining server denial. |
| Wave 5 — P2 product truth, RBAC, UI, and accessibility | F10-35 | Persist deterministic candidate selection, fallbacks, and routing rationale. |
| Wave 5 — P2 product truth, RBAC, UI, and accessibility | F10-37 | Make active-run elapsed rendering deterministic across SSR and hydration. |
| Wave 7 — CI, operations, and docs | F10-23 | Bring product, environment, OAuth, simulation, canonical-state, and date documentation back to truth. |
| Wave 7 — CI, operations, and docs | F10-26 | Add reliable end-to-end, accessibility, visual, lint, and coverage gates and replace stale assertions. |
| Wave 7 — CI, operations, and docs | F10-29 | Define and implement retention, backup, restore, and storage-limit policy. |

Ledger check: 37 distinct IDs, spanning F10-01 through F10-37, with no duplicate primary assignment.

## 5. Program-wide prerequisites and ownership

### Prerequisites

Before implementation begins:

- Freeze the current pass-10 dossier as the baseline and link each change to its primary ledger row.
- Inventory canonical stores, SQLite projections, run JSONL/transcript locations, provider-session material, project workspaces, skills, knowledge bases, and GitHub credentials without printing secrets.
- Capture a scrubbed schema and migration backup from a representative non-production data root.
- Establish a dedicated disposable repository, disposable data root, disposable provider sessions, and test-only identities for Wave 6.
- Define a common audit-event envelope: actor, action, organization, project, task, engagement, run, work revision, resource, decision source, result, timestamp, and correlation ID as applicable.
- Add feature switches that can disable new run creation and delivery globally. A switch may stop unsafe functionality; it may not re-enable the old unsafe path.

### Role-based owners

Names are assigned during kickoff; these roles are accountable:

- Product authority owner: Wave 0 decisions, copy truth, acceptance semantics.
- Security/platform owner: isolation, credentials, egress, filesystem and resource containment.
- Runtime/delivery owner: adapters, run lifecycle, workspaces, delivery manifest, GitHub actions.
- Canonical-state owner: task/profile schemas, file writers, projections, migrations, compare-and-swap.
- Auth/privacy owner: route authorization, session renewal, export audit, event filtering.
- Product UI/accessibility owner: RBAC presentation, board/menu behavior, activity and run terminology.
- QA/release owner: sterile harness, regression matrix, disposable live evidence, release signoff.
- Operations/documentation owner: CI, observability, backup/restore, retention, runbooks.

### Parallel-work boundaries

- One canonical-state owner controls app/schemas/task-file.schema.ts, app/server/files/task-file.server.ts, related migrations, and compatibility readers during Waves 3 and 4. Other lanes consume a versioned contract.
- One runtime interface owner freezes the sandbox request/result and delivery-manifest types before the isolation and GitHub-delivery sub-lanes split.
- The auth lane can proceed independently after Wave 0 privacy decisions, except for shared run/task lookup contracts.
- UI work waits for server-provided eligibility, readiness, authorization, and selection-rationale fields. Client code must not duplicate policy.
- Documentation can draft in parallel, but claims about behavior are merged only after the corresponding acceptance evidence passes.

## 6. Wave 0 — decisions and stop-line

### Objective

Turn unresolved product semantics into signed, testable rules. This wave changes no runtime behavior by itself, but blocks any implementation whose correctness depends on those rules.

### Required decision records

Record each choice, rationale, owner, effective schema version, compatibility treatment, telemetry impact, and reconsideration trigger in planning/discovery-2026-07-19-pass10/DECISIONS.md and reconcile planning/discovery-2026-07-19-pass10/CANON.md.

1. Completion in full autonomy.
   - Decide whether a human acceptance action is ever required.
   - Recommended safe baseline: automated delivery may advance only when all current-revision machine gates and required explicit verdicts pass; a product-defined acceptance authority remains required wherever policy says so.
   - Specify what happens with zero reviewers, unavailable reviewers, and non-repository work.

2. Verdict authority.
   - Decide explicit-only versus implicit authority for supporting engagements.
   - Recommended safe baseline: no verdict authority is inferred from supporting status, profile role text, name, or historical behavior. It must be an explicit profile/task grant.
   - Define direct, recommend-only, human-only, and off as lossless stored values.

3. Multi-review aggregation.
   - Define the required reviewer set for each work revision and whether pass means unanimous, quorum, or policy expression.
   - Recommended safe baseline: unanimous pass from the snapshotted required reviewer set for the current revision; any current-revision request-changes blocks acceptance.
   - Define reviewer addition/removal, abstention, timeout, unavailable reviewer, superseded run, and human override behavior.

4. Read and privacy model.
   - Decide separately for task summary, comments, activity, discovery, project event stream, redacted run log, raw run log, provider transcript, session export, and audit data.
   - Recommended safe baseline: app-wide task summary/comment visibility may remain if intentionally chosen; raw logs and provider-session exports require project membership plus an explicit sensitive-artifact action, and event streams apply the same row-level filter as their destination pages.
   - Decide whether an unauthorized sensitive ID returns 404 to avoid an existence oracle.

5. Supporting-run mutation.
   - Decide whether supporting engagements are strictly read-only or may produce an isolated patch artifact.
   - Recommended safe baseline: read-only. If mutation is later enabled, its output is non-deliverable until explicitly adopted into a new delivering revision by the server.

6. Operator routing.
   - Define eligible candidates, availability/workload, backend health, capability fit, cost/latency hints, and the rationale that must be stored and shown.
   - Recommended safe baseline: the operator returns a structured considered-candidate set and reason; ambiguity between materially equivalent candidates creates a human packet instead of silently selecting the first profile.

7. Repository-optional projects.
   - Decide whether a repository is mandatory for autonomous implementation and what a work revision means without Git.
   - Recommended safe baseline: a repository is optional only for planning/non-delivery projects with an explicit immutable artifact hash. Commit/push/PR claims and repo-backed acceptance remain unavailable.

### Stop-line checklist

- Product authority and security owners sign all seven records.
- Every record has examples for ordinary, failure, and migration cases.
- No profile migration, review-state schema, route matrix, operator-selection contract, or project-creation copy merges while its decision is open.
- README, CANON, DECISIONS, and the implementation issue set use identical terms.

### Acceptance

Automated:

- Add decision-contract fixtures that can later drive table tests for aggregation, privacy, routing, and project types.
- A documentation check fails if a required decision is still marked unresolved when its dependent feature flag is enabled.

Live:

- Product, security, runtime, auth, and QA owners walk one repository-backed task and one planning-only task through every chosen state on paper.
- The walkthrough explicitly covers a nonmember, viewer, member, admin, operator, delivering profile, supporting profile, and multiple reviewers.

### Rollback

Decisions are versioned, not overwritten. Reversal requires a new record, migration impact analysis, and an explicit treatment of prior verdicts, exports, and audit events. A reversal cannot silently reinterpret historical data.

## 7. Wave 1 — trustworthy tests

### Objective

Make the harness prove that unit, integration, and browser tests cannot select a real provider or use credentials inherited from the developer machine or CI host.

### Implementation areas

- test-support/setup-env.ts
- test-support/test-app.ts
- vitest.config.ts
- playwright.config.ts
- app/server/runtimes/run-service.server.ts and its tests
- app/server/runtimes/runtime-registry.server.ts and its tests
- app/server/runtimes/claude-runtime.server.test.ts
- app/server/runtimes/codex-runtime.server.test.ts
- app/server/files/file-watch.service.server.test.ts
- package.json test scripts

### Work

1. At test-process bootstrap, explicitly delete or replace all known provider, GitHub, MCP, and auth-selection variables. Do not use nullish assignment, which preserves ambient values.
2. Make fake runtime adapters dependency-injected and mandatory in ordinary tests. Backend availability flags alone are insufficient if production adapters were already constructed.
3. Add one explicit opt-in live-test mode that requires a separate command, disposable target declaration, credential-presence confirmation without value disclosure, and a unique run namespace.
4. Add canary adapters that fail immediately if an SDK, external executable, network connector, or production data root is reached during an ordinary test.
5. Make environment-mutating tests use a scoped helper that restores every changed key even after failure.
6. Repair watcher tests so teardown owns and cancels retry work; do not merely lengthen timeouts.
7. Separate deterministic simulated E2E from disposable live acceptance in naming, configuration, output, and CI permissions.

### Automated gate

- Run the full test command from a shell populated with realistic fake provider and GitHub credential names; no production adapter is constructed and all tests pass.
- Run the same suite with no relevant environment variables; results are identical.
- A deliberate attempt to instantiate Claude, Codex, GitHub, or a connector from an ordinary test fails with a clear harness error before network/process access.
- All Vitest tests pass, including the four current watcher failures under simulated EMFILE.
- Test logs contain no secret values and no unredacted environment dump.
- Browser tests use an isolated data root and simulated/fake runtime unless the explicit live command is used.

### Live gate

- In a disposable environment, demonstrate that the ordinary test command cannot see a planted sentinel credential, while the separately authorized live command can access only its named test credential.

### Rollback

The safe rollback is to disable tests that require an unavailable fake, never to restore ambient credential access. Preserve a previous deterministic fake adapter behind a test-only interface until replacement coverage is complete.

### Ownership and parallelization

QA owns bootstrap and canaries; runtime owners expose injection seams. This work can proceed alongside Wave 0, but Wave 2 does not close until the sterile harness exercises its failure cases.

## 8. Wave 2 — P0 runtime containment and server-side delivery allowlists

### Objective

Make specialist code execution untrusted by construction. The specialist may generate work, but it cannot escape its per-run boundary, reach sibling state, inherit server secrets, or deliver changes. Delivery is a separate server operation governed by an exact manifest and capability decision.

### Implementation areas

- Dockerfile
- compose.yml
- scripts/docker-entrypoint.sh
- a new sandbox runner under app/server/runtimes/
- app/server/runtimes/runtime-registry.server.ts
- app/server/runtimes/claude-runtime.server.ts
- app/server/runtimes/codex-runtime.server.ts
- app/server/runtimes/run-service.server.ts
- app/server/tasks/specialist-run.server.ts
- app/server/tasks/specialist-tool-policy.ts
- app/server/github/workspace-delivery.server.ts
- app/server/github/push-workspace.server.ts
- app/server/github/pr-open.server.ts
- app/server/github/branch-sync.server.ts
- corresponding runtime, task, and GitHub tests
- app/server/audit/ or the existing audit-event writer

### Containment contract

Create a backend-neutral sandbox request/result contract with these minimum guarantees:

- one disposable OS/container boundary per run, running as a non-root UID;
- a read-only base image and immutable input snapshot;
- exactly one writable per-run workspace and temp directory;
- no mount of the app data root, SQLite files, server checkout, provider configuration directory, sibling workspace, Docker socket, host SSH agent, or host home;
- no-new-privileges plus platform-appropriate syscall, process, file-descriptor, CPU, memory, disk, and wall-time limits;
- bounded stdout/stderr and artifact size, structured termination reason, and guaranteed process-tree kill;
- default-deny network. Any declared MCP or network resource receives only its specific destination through a proxy or broker, never general egress;
- a minimal environment built from an explicit allowlist for both Claude and Codex. It begins empty and adds only runtime necessities, per-run paths, non-secret locale settings, and the narrow credential/broker reference required for that backend;
- provider session material is per-run and inaccessible to other runs. Exportable results are copied out by the server after termination;
- fail-closed startup: if the boundary, limits, broker, or workspace cannot be established, the run does not start.

Host processes, GIT_CEILING_DIRECTORIES, prompts, tool denylists, bypassPermissions settings, and danger-full-access settings are not security boundaries. They may be defense in depth only after containment exists.

### Capability enforcement

Replace descriptive capability promises with a server-side decision for each privileged operation:

- read repository snapshot;
- produce a patch candidate;
- use a declared resource;
- request a decision packet;
- create a delivery intent;
- commit;
- push;
- open/update pull request;
- merge;
- export session material.

The decision input includes the canonical profile grant, task engagement kind, current delivering engagement, run ID, project repository, declared resource, autonomy/verdict mode, and current work revision. Absent, malformed, stale, or contradictory state denies the operation and creates an audit event. The UI and prompts display only capabilities that this decision layer can actually enforce.

### Server-owned delivery protocol

1. A successful isolated run returns a candidate artifact; it does not receive GitHub credentials or a network path to GitHub.
2. The server verifies that the run belongs to the current delivering engagement and that its immutable input base still matches the task/repository state.
3. The server computes the Git diff itself and creates a delivery intent containing at least organization, project, task, engagement, profile, run, repository, base SHA, candidate tree/head SHA, exact changed paths and hashes, delivery action, and expiry.
4. A policy allowlist rejects paths outside the repository, .git internals, escaping symlinks, undeclared submodules, oversized/binary outputs where not allowed, secret-like files, and any path or operation outside the task/profile grant.
5. Commit staging uses the verified manifest, never a workspace-wide add. Immediately before commit and push, hashes and authorization are recomputed and compared.
6. Only the server credential broker performs commit signing, push, pull-request creation, merge, or cleanup. Credentials never enter the sandbox or prompt.
7. Supporting engagements cannot create a delivery intent. If the signed Wave 0 decision permits a supporting patch, it is stored as a non-deliverable review artifact and must be explicitly adopted by a delivering run into a new work revision.
8. All delivery transitions are idempotent and audit-linked to the work revision introduced in Wave 4.

### Operator directive precedence

The live run showed an operator contradicting the server-owned delivery contract and pressuring a specialist to push. Correct this at two layers:

- The immutable server execution contract is a distinct highest-priority input and is placed after or otherwise cannot be overridden by operator-generated content. Operator text is untrusted quoted task context, not a system instruction.
- The server rejects or rewrites operator plans that request commit, push, PR, merge, credential access, policy bypass, or undeclared resources; it records the attempted contradiction.
- Even a successful prompt injection remains harmless because the sandbox has no GitHub route or credential and the delivery service rejects unauthorized manifests.

### Automated gate

- Plant sentinel secrets in the server environment, host home, app data root, sibling workspace, and another run. Both backends prove they cannot read them.
- Attempt direct network access, DNS escape, localhost access, Docker-socket access, process escape, symlink traversal, fork/file-descriptor exhaustion, oversized output, and timeout. The sandbox contains and classifies each attempt.
- Assert adapter environments against a positive allowlist; a new inherited variable fails the test.
- Submit malicious operator text that says to ignore the server contract and push. The specialist cannot push, and the server records a denied delivery attempt.
- Prove a supporting run cannot commit, push, open a PR, or mutate the delivering workspace even when its prompt asks it to.
- Mutate a candidate workspace between manifest creation and delivery; delivery fails compare-and-swap.
- Add an unlisted file after manifest creation; it is neither staged nor silently included.
- Revoke a capability or replace the delivering engagement between run completion and delivery; delivery fails.
- Run Claude and Codex parity tests for environment, filesystem, egress, limits, cancellation, and result collection.
- Existing legitimate server-owned commit/push/PR tests pass using fakes and exact manifests.

### Live gate

Using only the Wave 6 disposable repository:

- run a deliberately adversarial specialist prompt and operator directive;
- show that the run has no usable GitHub credential or direct GitHub egress;
- let the server deliver one exact allowlisted file;
- verify the resulting commit tree contains exactly the manifest;
- prove a supporting reviewer can report but cannot deliver;
- capture scrubbed sandbox, policy-decision, manifest, and GitHub audit records.

### Migration and rollout

- Introduce a sandbox protocol version and delivery-manifest version.
- Existing queued/running host-based runs are cancelled and require explicit restart; they are not silently resumed in the new boundary.
- Existing workspaces are quarantined read-only until scanned. They are never fed to the new delivery service without a fresh server diff and authorization.
- Roll out disabled, then isolated preview, then server-delivery in the disposable environment, then production.
- If the new boundary fails, disable specialist runs. Do not fall back to host execution.
- If delivery v2 fails, retain the candidate artifact and require human recovery; do not fall back to workspace-wide staging or agent push.

### Ownership and parallelization

Security/platform owns the boundary and credential broker. Runtime owns backend parity. Delivery owns manifest/GitHub actions. They may split after the sandbox and manifest interfaces are frozen; security signs both before live testing.

## 9. Wave 3 — P1 concurrency and state integrity

### Objective

Make every run, delivery slot, schedule, watcher, and decision packet durable under races, replacement, crash, and retry.

### Implementation areas

- app/server/runtimes/run-service.server.ts
- app/server/runtimes/run-store.server.ts
- app/server/tasks/specialist-run.server.ts
- app/server/runtimes/operator-run.server.ts
- app/server/files/file-watch.service.server.ts
- vite.config.ts and development data-root configuration
- app/server/tasks/schedule.server.ts
- decision-packet actions and app/features/task-detail/decision-packet.tsx
- app/schemas/task-file.schema.ts
- app/server/files/task-file.server.ts
- db/migrations/ with new numbered additive migrations; never edit 0001_baseline.sql
- associated race, crash-recovery, and migration tests

### Work

#### Atomic delivery-slot reservation

- Reserve a queued delivering run in one SQLite transaction before profile resolution, cloning, adapter startup, or other asynchronous setup.
- Enforce at the database layer with a partial unique invariant for one active delivering slot per project/task across queued and running states. Do not rely only on a preflight query.
- Store engagement kind explicitly on the run row; do not infer delivering status from profile name, role text, or run kind.
- On setup failure, transition the reserved row durably to failed/cancelled with a reason.
- Return the already-active run identity for duplicate/idempotent requests and a conflict for a genuinely different request.

#### Per-run workspace and immutable input

- Allocate a unique workspace ID and directory only after reservation.
- Create each run from an immutable base snapshot; never share a mutable checkout.
- Supporting runs receive their own read-only snapshot or isolated copy. Their lifecycle cannot delete or alter a delivering workspace.
- Store workspace ID, base SHA/artifact hash, sandbox protocol, and cleanup state with the run.
- Reap abandoned workspaces only after durable run-state reconciliation and audit.

#### Durable operator coordination

- Replace process-local operator leases with a database-backed lease or idempotent job claim that has owner, expiry, heartbeat, and recovery semantics.
- Make retry safe: the same task/event does not produce duplicate operator work or duplicate specialist starts.

#### Watcher lifecycle

- Represent watcher state with one owned controller: generation, active watcher, retry timer, attempt count, last error, and health.
- On EMFILE or another transient failure, close once, perform a bounded rescan, and retry with capped exponential backoff and jitter.
- Stop/test teardown cancels the active watcher and any retry timer even if the cached handle was cleared.
- Reject stale retry callbacks by generation.
- Expose healthy, degraded/retrying, and stopped state with metrics; avoid an unbounded error loop.

#### Development-server watch boundary

- Default development runtime data and task workspaces outside the application source root.
- Resolve the configured data root and exclude it—especially every task `workspace/`—from Vite's watch graph as defense in depth when a developer deliberately places data beneath the checkout.
- Ensure nested workspace repositories and `tsconfig.json` files cannot become Vite source inputs, clear the app's TypeScript cache, or trigger HMR/full reloads.
- Keep this separate from Viberr's projection watcher pruning; both watcher scopes require independent tests and bounded descriptor accounting.

#### Decision-packet identity

- Give every packet and option stable IDs plus a content revision/fingerprint.
- The client submits packet ID, option ID, and expected task-file revision, never an array index.
- Under the canonical task-file lock, verify that the same unresolved packet, option, and expected revision still exist before any side effect.
- Persist resolution intent/idempotency before a remote merge or other non-transactional action; finalize the file state after success and recover safely after a crash.
- A replacement packet makes an old request stale and harmless.

#### Schedule claim/outbox

- Replace pending/fired-only behavior with a durable claim state such as pending, claimed, enqueued, completed/failed, and cancelled.
- Claim compare-and-swap includes schedule version, occurrence, worker, lease, and idempotency key.
- Persist an operator-run/outbox reference before marking the occurrence enqueued or fired.
- Recover expired claims and retry enqueue without duplicating work.
- Record terminal failure visibly; never lose a schedule because detached async work threw.

### Automated gate

- Fire 50 concurrent delivering-start requests for one task; exactly one active delivering row and one workspace exist.
- Start supporting runs concurrently; each has a distinct workspace and none can mutate another.
- Kill the process after reservation, after clone, after adapter start, and during cleanup; restart reconciles each state without a duplicate slot.
- Simulate two application instances competing for operator and schedule work; claims remain single and recoverable.
- Exercise EMFILE repeatedly, stop during backoff, restart with a new generation, and assert no leaked handles/timers or post-teardown errors.
- Create and churn a nested task-workspace clone while the dev server runs; assert zero application HMR/full reloads or nested-`tsconfig` cache resets and bounded descriptors.
- Replace a packet between page render and submit; the stale option produces a conflict and no merge/file mutation.
- Kill around packet remote-side effects and recover from the persisted intent without duplication.
- Crash after schedule claim and before/after enqueue; exactly one linked operator run results.
- Migration tests upgrade a copy of the baseline database and are idempotent.

### Live gate

- In the disposable environment, race two browser/API delivering starts and show one run identity.
- Run one deliverer and multiple supporters simultaneously and compare workspace IDs and file trees.
- Force-kill a worker with a claimed schedule, then restart and show recovered single execution.
- Replace a visible packet from a second session before submitting the first; show a stale-state message and no side effect.
- Create a disposable task workspace during development and show that its checkout/update produces no Vite reload or source-cache invalidation.

### Migration and rollback

- Add new columns/indexes in numbered migrations after first scanning for violating active rows.
- Resolve any existing duplicate active deliverers by disabling new starts and requiring an operator-approved reconciliation report; do not silently choose a winner.
- Backfill explicit engagement kind and workspace IDs where evidence is deterministic; mark uncertain legacy rows unknown/closed.
- Additive migrations remain readable by the compatibility layer during rollout. Rollback means disabling new claims/starts and using the compatible reader, not dropping indexes or discarding state.
- Canonical task schema readers accept the previous packet form during a bounded transition; writers emit only stable IDs after migration.

### Ownership and parallelization

Runtime owns run reservation/workspaces, canonical-state owns packet and schedule file contracts, operations owns watcher health. Database migration numbering and task-schema edits are serialized through the canonical-state owner.

## 10. Wave 4 — P1 authority, privacy, verdict migration, rework revisions, resource paths, and session renewal

### Objective

Make authority explicit at storage, route, and audit boundaries. Bind review to real delivered work, preserve verdict modes without widening, contain resource paths, and make authentication renewal actually reach clients.

### Implementation areas

- app/shared/rbac.ts
- app/server/auth/require-user.server.ts and tests
- app/root.tsx and route header composition
- app/routes/project.task.tsx
- app/routes/resources.run-log.ts
- app/routes/resources.session-export.ts
- app/features/task-detail/runs-panels.tsx
- app/server/runtimes/run-store.server.ts
- app/server/runtimes/session-export.server.ts
- app/server/tasks/agent-outcome.server.ts
- task transition/action modules and review projections
- app/schemas/task-file.schema.ts
- app/server/files/task-file.server.ts
- app/features/agents/agents-query.server.ts
- app/features/agents/create-profile-modal.tsx and profile actions
- app/server/files/kb-injection.server.ts
- app/server/runtimes/operator-run.server.ts
- app/server/org/resource-catalog.server.ts
- app/server/org/store-files.server.ts
- app/server/tasks/specialist-mcp.server.ts
- new numbered DB/file-schema migrations and all related tests

### Route-level authorization and privacy

1. Expand RBAC into separate actions for task summary, task comments, activity/discovery, project events, redacted run log, raw run log, provider session view/export, and audit access according to Wave 0.
2. For a run artifact route, load the minimum run locator, authorize its organization/project/task and sensitivity, and only then read or stream content.
3. Use a shared requireRunArtifactAccess-style guard. Apply it independently to run-log streaming, transcript/session export, and any resume endpoint.
4. Filter SSE/project events with the same authorization model; navigation visibility is not an access control.
5. Use the signed 404/403 policy consistently so sensitive IDs do not become an existence oracle.
6. Redact secrets and high-risk provider material before any lower-sensitivity log view. Session exports are immutable, watermarked with scope/actor/time, rate-limited, and audited.
7. Server response remains authoritative. The UI hides or disables raw/export controls based on returned capabilities, but a handcrafted request is still denied.

The live evidence is an explicit regression fixture: a nonmember could open a task directly, read raw logs, and export a provider session while the project configuration route returned 403. After remediation, each surface must independently match the signed matrix; preserving broad task visibility must not imply raw-log or transcript access.

### Explicit verdict-mode migration

- Define one versioned enum with exact persisted meanings for direct, recommend-only, human-only, and off.
- Inventory organization profiles and project deployments before migration. Produce a dry-run report showing legacy absent/recommend values and the proposed mapping.
- The migration follows the signed decision and is idempotent. Ambiguous records become review-required; they are not silently upgraded to direct verdict authority.
- Preserve the original raw value and migration audit until owners confirm the result.
- Profile editors load and save the exact stored mode. Merely opening and saving an unrelated field cannot change verdict or repository authority.
- Store verdict authority separately from repository mutation/delivery capability and engagement kind.

### True work-revision and review model

Replace the scalar/heuristic model with a durable revision-bound model:

- A work revision has a stable ID, task ID, source delivering engagement/profile/run, immutable artifact identity, base/head/tree SHA for Git work or signed artifact hash for approved non-repo work, creation time, and supersession link.
- Only the server delivery service or approved artifact-ingest service can create a revision. A comment, deliverer message, stage bounce, assignment change, or elapsed time cannot.
- Each verdict records profile, run, explicit authority mode, revision ID, pass/request-changes result, reason/evidence, and timestamp.
- The required reviewer set and aggregation-policy version are snapshotted for the revision according to Wave 0.
- A request-changes verdict blocks only its revision. A genuine new revision makes all prior verdicts stale; it does not convert them to pass.
- Acceptance is derived from the current revision, exact current-revision verdict set, policy aggregation, required human boundary, delivery/PR state, and unresolved blocking packets.
- Legacy scalar validation remains, if needed, as a read-only derived projection during compatibility. No code writes it as the source of truth.
- Migration does not synthesize approval from historical comments or stage transitions. Legacy approved/failed values become explicitly legacy/unverified unless deterministic revision evidence and the signed policy justify a binding conversion.
- Every transition explains which revision and which policy allowed or blocked it.

This removes the current “any newer deliverer comment or transition equals rework” heuristic and supports more than one reviewer without last-write-wins behavior.

### Resource path containment

Create one shared resolver for skills, knowledge bases, store files, and declared MCP resources:

- validate identifiers against a strict grammar; reject separators, dot segments, absolute paths, encoded traversal, NULs, and platform variants;
- join beneath a configured root, lstat each component, resolve realpath, and prove the final target remains beneath the real root;
- reject or explicitly constrain symlinks; never recursively follow an escaping symlink;
- track visited device/inode or canonical path to prevent cycles;
- enforce maximum depth, file count, per-file bytes, and total bytes;
- distinguish missing, invalid, degraded, oversized, and denied instead of silently returning empty content;
- validate references on profile save and resolve them again at run time to prevent time-of-check/time-of-use replacement;
- pass only resolved read-only artifacts into the sandbox.

### Rolling-session renewal

- Use the installed authentication library’s supported response/header mode to capture renewal Set-Cookie headers.
- Thread those headers through root document responses, loaders/actions, redirects, and streaming/data routes without overwriting other Set-Cookie or cache headers.
- Centralize header merging and test multiple Set-Cookie values.
- Keep sensitive exports non-cacheable and ensure renewal does not accidentally make them public-cacheable.

### Automated gate

- Table-test every role and nonmember against every route/action in the signed privacy matrix, including direct URL/API/SSE access.
- Use real run IDs from another project to prove raw log and export denial and the chosen non-disclosure response.
- Confirm export audit, watermark/scope metadata, rate limit, redaction, and no shared caching.
- Round-trip every verdict mode through profile editors without mutation; ambiguous legacy fixtures require confirmation.
- Race migration/reload and prove profile authority cannot widen.
- Create two reviewers, pass/fail combinations, reviewer changes, new work revisions, and stale verdicts; aggregation matches the decision record.
- Show that comments and stage changes do not create a revision or clear request-changes.
- Test repository SHA changes and non-repo artifact hashes; stale delivery cannot bind a verdict to new work.
- Fuzz resource names and construct traversal, absolute path, encoded path, symlink, loop, deep tree, oversized tree, and TOCTOU fixtures across every consumer.
- Advance an authenticated session beyond updateAge; document, data, redirect, and stream-related responses preserve the expected renewal cookie without losing existing headers.

### Live gate

- Repeat the observed nonmember scenario against each task/log/export/config/SSE surface and record the signed expected status and visible UI.
- As viewer/member/admin, attempt direct export requests rather than relying on hidden buttons.
- Run a two-reviewer task through fail, prose-only “rework,” actual new delivered revision, stale verdict, fresh verdicts, and acceptance.
- Use a disposable resource root with an escaping symlink and show save-time and run-time rejection.
- Keep a session active across the renewal threshold and show that it remains authenticated with a renewed cookie.

### Migration and rollback

- Version task/profile schemas and use tolerant readers plus new-format writers during a bounded dual-read window.
- Back up every canonical file before batch migration and emit a per-file manifest/hash.
- Make verdict migration dry-run-first and idempotent. Uncertain cases are quarantined for owner review.
- Add DB columns/tables only through numbered migrations. Rebuild projections from canonical files and compare counts/hashes.
- Rollback for review v2 disables acceptance transitions, retains all new revision/verdict records, and returns to a read-only compatibility view; it does not reinterpret them as the legacy scalar.
- Rollback for tighter privacy requires a new signed policy decision, not an emergency UI toggle. A technical incident may disable exports entirely.
- Rollback for resource resolution means resource unavailable, never unchecked path fallback.

### Ownership and parallelization

Auth/privacy owns route guards and renewal. Canonical-state owns revision/verdict schemas and migration. Security owns the shared resolver. Profile UI may begin after the verdict enum and migration contract freeze. Changes to task schema remain serialized with Wave 3.

## 11. Wave 5 — P2 product truth, RBAC, UI, and accessibility

### Objective

Make every label, choice, enabled state, navigation path, and interaction reflect server truth. The UI consumes explicit eligibility and state reasons; it does not guess.

### Implementation areas

- app/server/projections/review-queue.server.ts
- review queue route/page and tests
- app/features/task-detail/execution-profile.tsx
- task detail route/actions and runs panels
- app/features/agents/agents-page.tsx
- app/features/agents/agents-query.server.ts
- app/features/activity/activity-page.tsx
- app/features/activity/feed-helpers.ts
- app/server/projections/activity-feed.server.ts
- app/features/project-settings/settings-page.tsx
- app/features/project-settings/settings-actions.server.ts
- org resources/home count projections and pages
- board page, task-card/list, stage-menu, and associated tests
- login route/page/styles and responsive tests
- app/features/runtime/runs-helpers.ts and app/features/runtime/runs-panels.tsx
- GitHub status/sync projections and pages
- app/server/files/agent-profile-file.server.ts
- app/server/seed/default-assets.server.ts and non-operator definition assets
- app/shared/rbac.ts
- relevant route, component, Playwright, axe, and visual tests

### Work

#### Review readiness and acceptance

- Return a server-derived readiness object, not a waiting-equals-human shortcut.
- Include current work revision, required/current verdict summary, unresolved blocking packets, delivery/PR requirement, acceptance authority, blockers, and allowed action.
- Classify “needs work,” “awaiting reviewer,” “awaiting delivery/PR,” and “ready for your acceptance” separately.
- All page copy names the actual actor and boundary; a failing or stale review is never presented as ready.

#### Valid owner/reviewer/run choices

- Server returns candidate records with eligible boolean and a localized reason.
- Exclude or explain current deliverer, already-engaged profile, missing capability, unavailable backend, insufficient RBAC, archived account, and invalid owner role.
- Reviewer add and owner handoff actions revalidate the same rule transactionally.
- Success messages are based on actual state transition, not optimistic assumptions.
- Run buttons are disabled per engagement/run conflict. A delivering run need not disable an otherwise allowed isolated supporting run.

#### Operator selection truth

- Store and show selected profile, eligible candidates considered, capability fit, availability/workload signal, cost/latency class if adopted, and human-readable rationale.
- Remove first-match/first-array fallback for generic profiles. If no candidate qualifies, show the blockers. If equivalent candidates require a product choice, create a decision packet.
- Keep internal primary/reviewer identifiers out of user-facing copy; use Delivering and Supporting only for engagement.

The live generic-selection ambiguity becomes a regression scenario: equivalent generic specialists must produce a deterministic documented rule or a visible human choice, never an unexplained array-order winner.

#### Run and activity terminology

- In live-run tables, separate Profile, Task role, Engagement, Backend, State, and Started/updated time.
- Project profile name from the engagement snapshot so history remains intelligible after a profile changes.
- Summarize activity entries to actor, action, object, state/result, and time. Collapse long reports behind a deliberate details control or stable run/report link.
- Preserve search/filter context and accessible focus when opening/closing details.

#### Counts, resources, and GitHub freshness

- Label operator, specialist profile, deployed profile, and total separately; do not compare unlike counts.
- Show resource source, persistence class, last successful validation, current health, and restart expectations.
- Treat the temporary notes-fixture MCP as ephemeral test evidence, not durable configuration.
- Show GitHub last attempted sync, last successful sync, data-as-of time, error/degraded state, and what manual refresh can and cannot update.

#### Real control states and RBAC

- Fixed-stage controls are actually disabled or absent, include the reason, cannot receive an active destructive style, and remain server-guarded.
- Archive/Delete and other destructive controls are hidden or disabled for unauthorized viewers according to the signed design, with an accessible explanation where useful.
- Direct handcrafted submissions remain denied.

The observed viewer page with enabled Archive and Delete buttons is a required visual and interaction regression: viewer controls must not look actionable, open a confirmation, or submit.

#### Board and menu accessibility

- Add a keyboard-equivalent move action to every card in board and list views.
- Use native buttons where possible. Custom menus implement roving focus, Arrow Up/Down, Home/End, Enter/Space, Escape, focus return, outside-click handling, and correct ARIA relationships.
- Announce move result and errors through a polite live region; preserve focus at the moved card or a documented equivalent.
- Drag remains an enhancement, not the sole operation.
- Verify 200% zoom/reflow, mobile widths, touch targets, visible focus, contrast, reduced motion, screen-reader names, and no keyboard trap.

#### Login composition

- Rebalance desktop layout so the authenticated product identity and sign-in action form one intentional composition rather than an empty field.
- Preserve mobile simplicity, reading order, focus order, contrast, and reduced motion.

#### SSR-stable live timing

- Make the initial elapsed value identical in server output and client hydration, using a loader-provided render timestamp or a stable placeholder contract.
- Start wall-clock ticking only after hydration; a second boundary between response generation and hydration cannot change the initial text.
- Preserve focus and selected-run state when the first client tick lands, and keep server/client clock skew behavior explicit.

#### One generic profile source

- Fold non-operator profile definition content into the canonical generic profile/deployment model.
- Keep only behavior that is explicitly operator-specific in an operator-owned source.
- Remove runtime lookup precedence that can override a generic profile with a parallel built-in definition.
- Migrate existing definitions with dry-run/backup/report and prove editor round-trip stability.

#### Project creation truth

- After the Wave 0 repository decision, update project-creation copy, validation, and capability preview to state exactly which workflows are available with and without a repository.
- Do not advertise autonomous implementation, commit, PR, or merge where the selected project type cannot support it.

### Automated gate

- Review-queue table tests cover no revision, stale/failing/passing verdicts, multiple reviewers, open packets, delivery/PR state, and each acceptance authority.
- Candidate-list and action tests use identical eligibility fixtures and cover stale submissions.
- Generic profiles with equivalent attributes never select by input order; rationale/decision packet is stable.
- Run-table tests assert separate profile/role/engagement/backend values.
- Activity tests cap collapsed text and expose a stable accessible detail path.
- Viewer/nonadmin settings tests assert disabled/hidden semantics, no dialog, no request, and server denial.
- Board/menu keyboard tests cover the full key contract, focus return, announcements, reduced motion, and list-view parity.
- Axe scans have no serious/critical violations on login, board, task, review queue, agents, activity, and settings.
- Responsive visual tests cover agreed mobile, tablet, and desktop widths, including the login composition.
- Server-render and hydrate an active run with fake clocks on opposite sides of a second boundary; assert identical initial markup, no hydration warning, preserved focus, and correct later ticks.
- Profile migration proves non-operator behavior comes from one canonical source.

### Live gate

- Repeat the viewer Archive/Delete scenario and record keyboard, pointer, and direct-request results.
- With generic specialist profiles, show the routing rationale or ambiguity packet before a run starts.
- As each role, inspect reviewer/owner choices and attempt a stale submission.
- Complete a task move without pointer input in both board and list views using VoiceOver or an equivalent screen reader.
- Compare activity, run table, counts/resources, GitHub freshness, review queue, and project creation promises against server records.
- Open an active-run page through SSR, wait across hydration and several ticks, and confirm no subtree regeneration, focus loss, or hydration error is logged.

### Migration and rollback

- Ship server fields before consuming UI, with compatibility defaults that fail closed.
- Keep old labels only as read aliases during a short transition; do not write internal primary/reviewer terminology into new user-facing data.
- Preserve generic-definition backups and migration hashes. If migration fails, disable affected profile execution rather than restore ambiguous precedence.
- UI rollback may restore prior layout, but cannot restore misleading enabled controls or bypass server eligibility.

### Ownership and parallelization

Product UI can split into review/task, agents/activity, settings/RBAC, and accessibility lanes after server contracts freeze. One design-language owner reconciles terminology and disabled-state patterns. Accessibility review is required in every lane, not deferred to the end.

## 12. Wave 6 — disposable live acceptance

### Objective

Prove the integrated system with controlled real processes and GitHub behavior without risking the product repository or leaving debris. This wave owns no primary finding; it is the cross-cutting acceptance gate for Waves 1–5.

### Entry criteria

- Waves 0–5 automated gates pass.
- Specialist sandbox and delivery default to fail closed.
- A dedicated disposable repository, data root, provider identity/session, GitHub token/app, test organization/users, and cleanup identity are verified.
- The cleanup identity can list and delete its test branches through a non-interactive authorized path before any branch is created.
- A unique run prefix and artifact manifest are recorded.
- Backup/restore and emergency-disable switches have been rehearsed.

### Existing live-run debt

The prior live exercise recorded PR 76 adding an inert artifact and PR 77 removing it. The paired task records and audited checkout support a source-net-clean conclusion, but the remote commit objects were unavailable for independent local diff reconstruction. The remote topic branches still remain because the local `gh` authentication is invalid.

Therefore:

- record the source tree as **evidence-supported net-clean**, not independently reconstructed or environment-clean;
- record both remaining branches as open cleanup debt with repository, exact names, PR links, owner, and verification timestamp;
- reauthenticate through an approved GitHub identity or use an authorized server/API cleanup path, delete only those verified branches, and re-list remote refs;
- do not claim the prior exercise clean until the refs are absent;
- do not run a new live scenario until cleanup capability is proven.

### Scenario matrix

1. Runtime containment.
   - Plant non-secret sentinels in server env, sibling workspace, app data root, host home, and blocked network target.
   - Run both backends and verify denied access, bounded failure, cleanup, and no leak in logs/export.

2. Contradictory operator directive.
   - Have the operator direct a specialist to commit/push despite the immutable contract.
   - Verify selection rationale is recorded, the request is rejected/audited, the sandbox cannot push, and only server delivery proceeds.

3. Delivery allowlist.
   - Deliver one approved file and attempt an extra, escaping symlink, stale-base mutation, and revoked engagement.
   - Only the exact valid manifest reaches GitHub.

4. Supporting reviewer boundary.
   - Let a supporting run inspect and report.
   - Verify it cannot alter the delivery workspace or create commit/push/PR state.

5. Concurrency and recovery.
   - Race delivery starts, run supporters concurrently, kill a worker during setup, exercise a claimed schedule, inject EMFILE, submit a stale packet, and churn a nested task workspace while the dev server runs.
   - Verify single-flight, isolated workspaces, recovery, bounded watcher behavior, no Vite source reload/cache reset, and no stale side effects.

6. Review revisions.
   - Use two required reviewers. Record request-changes, a prose-only deliverer comment, a real server-delivered revision, stale old verdicts, new verdicts, and acceptance.
   - Verify aggregation and timeline/audit explain every transition.

7. Privacy and session.
   - Exercise nonmember, viewer, member, admin, and acceptance authority across direct task, config, activity, SSE, redacted/raw log, and session export.
   - Cross the session renewal age and verify renewal headers.

8. Resource containment.
   - Reference valid, missing, traversal, symlink, cycle, and oversized skill/knowledge fixtures.
   - Verify explicit health/errors and no root escape.

9. Product truth and accessibility.
   - Verify viewer destructive-control state, valid owner/reviewer lists, generic-selection rationale, truthful run/activity/count/resource/GitHub labels, login layout, hydration-stable live timing, keyboard task movement, menus, zoom, mobile, reduced motion, and screen reader flow.

10. GitHub cleanup.
    - Create only namespaced test branches/PRs.
    - Merge or close according to the scenario, remove all test artifacts from the default tree, delete the remote branches, and re-list refs.

### Evidence package

Store in a new dated planning run directory:

- test plan and immutable target manifest;
- scrubbed command/output log;
- run, engagement, workspace, revision, policy-decision, delivery-intent, commit, PR, and audit IDs;
- screenshots indexed by scenario and role;
- before/after repository tree SHA and exact diff;
- before/after remote branch listing;
- route authorization matrix results;
- provider/backend versions and sandbox protocol;
- cleanup checklist signed by QA and repository owner;
- no credentials, raw provider secrets, or sensitive transcript content.

### Exit criteria

- Every scenario passes on both supported backends where applicable.
- No unexpected file, branch, PR, session, process, workspace, schedule, or test user remains.
- Default tree matches the recorded clean SHA/content expectation.
- Remote branch absence is verified independently after cleanup.
- All failures have linked defects; no stop-line failure is waived.

### Rollback

On any containment, authorization, delivery, or cleanup failure, stop the exercise, disable new runs/delivery, preserve scrubbed evidence, revoke the disposable credential, and clean only items in the recorded manifest. Do not improvise deletion against an unresolved repository or broad path.

## 13. Wave 7 — CI, operations, retention, and documentation

### Objective

Turn the remediated behavior into a continuously enforced and operable contract.

### Implementation areas

- .github/workflows/ci.yml
- package.json
- vitest.config.ts
- playwright.config.ts
- e2e/, including e2e/03-ownership-comment.spec.ts
- test-support/
- README.md
- .env.example
- planning/README.md
- docs/architecture/file-formats.md
- docs/operations/deployment.md
- docs/operations/runbook.md
- relevant build/spec documents
- retention/backup configuration and services for run JSONL, session exports, audit events, notifications, workspaces, resources, SQLite, and canonical files

### CI gates

Create least-privilege jobs with pinned toolchain/dependencies:

- typecheck and production build;
- unit and integration tests with the Wave 1 credential canary;
- migration upgrade and projection-rebuild fixtures;
- concurrency/race and file-watcher fault tests;
- sandbox containment integration on an isolated Linux runner with no repository/provider secrets;
- simulated Playwright flows;
- accessibility scans using an agreed engine such as axe;
- stable targeted visual regression at agreed viewports;
- lint/format checks after selecting and pinning the project standard;
- coverage reporting with an initial measured baseline and ratcheting thresholds for security, auth, state, and delivery modules.

Replace the stale ownership E2E assertion with the signed revision/acceptance semantics. Do not turn a brittle historical phrase into the new contract.

Disposable live acceptance remains a separately authorized workflow and is not triggered for arbitrary pull requests. It receives only disposable credentials, requires an approved target manifest, and always runs cleanup/verification.

### Operations and observability

- Metrics/alerts: sandbox startup/escape-denial/limit failures, inherited-env assertion failures, delivery denials and manifest mismatches, duplicate-slot conflicts, orphan workspaces, lease recovery, schedule claim age, watcher retry state, stale packet conflicts, export denials/rate limits, resource containment failures, stale verdict attempts, GitHub freshness age, and cleanup debt.
- Structured logs use correlation IDs and redact tokens, cookies, prompts where sensitive, raw transcripts, and environment values.
- Runbook includes global run/delivery disable, credential revocation, orphan reconciliation, schedule recovery, watcher degradation, migration quarantine, projection rebuild, session-export incident, and GitHub cleanup.
- Health UI distinguishes unavailable, degraded, stale, and intentionally disabled.

### Retention, backup, and restore

Product/security/operations sign a data-class table for:

- canonical organization/project/task/profile/resource files;
- SQLite projections and coordination state;
- run records and JSONL logs;
- provider session material and exports;
- audit events;
- workspaces and candidate artifacts;
- notifications/activity projections;
- repository/PR metadata and cached GitHub status.

For each class define purpose, sensitivity, location, encryption, size/file limits, default retention, legal/incident hold, deletion authority, user-visible effect, backup inclusion, restore order, and verification.

Implementation requirements:

- bounded per-run output/workspace/session sizes and global high-water alerts;
- lifecycle deletion as an idempotent audited job with dry-run/report;
- canonical files plus required encryption keys/config backed up consistently;
- SQLite backup coordinated with canonical snapshots and explicitly treated as rebuildable where true;
- restore into a disposable root first, validate hashes/schema/projection counts, then rehearse service recovery;
- audit retention long enough for delivery and access investigations, with sensitive payload minimization;
- no deletion policy activated until backups and legal/product requirements are signed.

### Documentation truth pass

Update documentation only to verified behavior:

- remove production-simulation claims for the deleted/unsupported mode;
- describe actual OAuth/session setup and rolling renewal;
- state file-canonical versus SQLite responsibility precisely;
- document current environment variables and eliminate stale ones;
- describe operator-only special behavior and generic profiles;
- document sandbox, egress, capability, delivery-manifest, revision/verdict, privacy, retention, and cleanup contracts;
- state repository-optional limitations exactly;
- update dates/status without presenting a discovery snapshot as current implementation;
- distinguish simulated tests, disposable live acceptance, and production operations.

### Automated gate

- Every required CI job is branch-protecting and passes from a clean checkout with no provider/GitHub credential.
- A seeded stale assertion, serious axe violation, targeted visual change, lint error, migration failure, coverage drop, sandbox escape attempt, and ambient-credential attempt each fail the appropriate job.
- Backup creates a restorable encrypted test snapshot; restore into a new disposable root passes schema, hash, auth, and projection checks.
- Retention dry-run enumerates only eligible test artifacts; execution is idempotent and audited.
- Documentation links and named scripts/env variables are checked against the repository.

### Live gate

- Operations performs a timed disable/re-enable drill, orphan-run reconciliation, schedule recovery, credential revocation, and restore rehearsal in the disposable environment.
- QA attaches the Wave 6 evidence package to the release record.
- Product/security review current UI/help/docs against the signed decisions and observed behavior.

### Rollback

- CI gates may be quarantined only with an owner, linked defect, expiry, and stop-line assessment; containment/auth/delivery tests cannot be waived for release.
- A failed retention job stops and preserves its manifest; it never broadens the deletion target on retry.
- Restore reverts to the last verified backup and keeps the failed restore isolated for investigation.
- Documentation rollback cannot reintroduce a false security or autonomy promise.

### Ownership and parallelization

QA owns CI behavior, operations owns monitoring/backup/retention, and documentation owners reconcile verified product truth. Work may start early, but release signoff waits for Wave 6.

## 14. Cross-wave acceptance trace for later live findings and cleanup debt

| Finding / live observation | Decision or implementation response | Must-pass proof |
| --- | --- | --- |
| F10-31 — Operator contradicted server-owned delivery and pressured a specialist to push. | Wave 0 routing/directive rule; Wave 2 immutable execution contract, sandbox denial, directive validation, and server-only delivery. | Adversarial live prompt cannot reach GitHub; denied intent is audited; exact server manifest alone is delivered. |
| F10-32 — A comment or stage bounce currently counts as rework without a changed revision. | Wave 0 aggregation rule; Wave 4 immutable work revisions and revision-bound verdicts. | An unchanged commit plus comment/transition cannot clear rejection; a new delivered revision plus fresh required verdicts can. |
| F10-33 — A nonmember could directly read a task, raw logs, and session export while configuration returned 403. | Wave 0 privacy matrix; Wave 4 independent route/SSE authorization and sensitive-export audit. | Role-by-surface matrix passes by direct request, including real foreign run IDs and the chosen 403/404 policy. |
| F10-34 — A viewer saw enabled Archive and Delete controls. | Wave 5 server-provided permissions plus truthful disabled/hidden UI and retained server guards. | Viewer cannot activate by pointer/keyboard, sees correct semantics, opens no dialog, emits no request, and direct POST is denied. |
| F10-35 — Generic specialists were selected without a durable considered-candidate trace. | Wave 0 routing rule; Wave 5 considered-candidate rationale and ambiguity packet. | Reordering identical inputs cannot silently change selection; UI/audit shows rationale or asks for a choice. |
| F10-36 — Nested task workspaces triggered Vite reloads and nested-`tsconfig` cache resets. | Wave 3 externalized development data root plus resolved Vite watch exclusion and descriptor accounting. | Creating/updating a nested workspace emits no app HMR/full reload/cache reset and keeps watch handles bounded. |
| F10-37 — The live elapsed timer rendered different seconds on server and client. | Wave 5 deterministic initial time plus post-hydration ticking. | SSR/hydration across a second boundary produces identical markup, no hydration warning, preserved focus, and correct later ticks. |
| Cleanup debt — Records say PR 76 added an artifact and PR 77 removed it; the audited checkout is fixture-clean, but remote commit objects were unavailable and branches remain because `gh` auth is invalid. | Wave 6 records evidence-supported source cleanliness separately from remote cleanup and blocks a new run until an authorized cleanup path is proven. | Remote diffs/trees and exact prior refs are independently verified; refs are deleted and absent on a fresh listing; new live-run refs/artifacts are also absent. |

## 15. Release gate and rollback order

Release signoff requires one traceability record per ledger finding with:

- change/decision links;
- automated test names and results;
- live scenario/evidence where required;
- migration report;
- operational metric/alert;
- documentation link;
- owner and date.

If a post-release stop-line issue appears, use this order:

1. Disable new delivery.
2. Disable new specialist runs if containment, credential, or isolation is implicated.
3. Revoke/broker-rotate affected disposable or production credentials.
4. Preserve scrubbed audit and exact artifact manifests.
5. Stop affected exports/routes or acceptance transitions.
6. Reconcile durable runs, leases, schedules, revisions, branches, and workspaces from explicit IDs.
7. Restore canonical files/database only from a verified backup and rebuild projections.
8. Re-enable from isolated preview outward after the failed gate passes.

Unsafe legacy execution, broad environment inheritance, agent-held GitHub credentials, heuristic review state, and unchecked resource resolution are never rollback targets.

## 16. Forbidden shortcuts

- Do not treat a subprocess, prompt, GIT_CEILING_DIRECTORIES, tool denylist, bypassPermissions, or danger-full-access configuration as containment.
- Do not pass process.env or an environment spread into either backend.
- Do not put GitHub push/merge credentials or unrestricted network access inside a specialist sandbox.
- Do not let operator text override the immutable execution/delivery contract.
- Do not use git add -A or deliver files not present in a server-recomputed manifest.
- Do not infer delivery authority from profile name, role text, run kind, first-array position, or supporting status.
- Do not permit supporting runs to push or silently merge their workspace into the deliverer.
- Do not enforce single-flight with only check-then-insert application logic.
- Do not share mutable workspaces among concurrent runs.
- Do not mark a schedule fired before a durable linked enqueue/claim exists.
- Do not resolve a packet by array index or check identity only before acquiring the canonical lock.
- Do not let a comment or stage transition count as a new work revision.
- Do not use one scalar validation field or last-write-wins for multi-review authority.
- Do not turn absent or recommend-only verdict modes into direct authority during parsing or editor save.
- Do not assume app-wide task visibility grants raw log, transcript, export, audit, or SSE access.
- Do not rely on hidden buttons or navigation as authorization.
- Do not follow unchecked symlinks or silently convert invalid resources to empty content.
- Do not drop authentication renewal Set-Cookie headers while composing route headers.
- Do not offer a server-invalid reviewer, owner, stage action, or destructive control as enabled.
- Do not make drag-and-drop the only task-move mechanism.
- Do not run ordinary tests with ambient provider/GitHub credentials or a production data root.
- Do not run disposable acceptance against the Viberr product repository.
- Do not claim a GitHub exercise clean while its recorded branches or artifacts remain.
- Do not edit 0001_baseline.sql or destructively down-migrate canonical review history.
- Do not activate retention deletion before a signed policy, dry run, verified backup, and restore rehearsal.
- Do not weaken a containment, delivery, privacy, or migration gate merely to make CI green.
- Do not document planned behavior as shipped behavior.

## 17. Completion record

When all waves close, append—not overwrite—a completion section to the pass-10 dossier containing:

- signed decision versions;
- migration/schema versions;
- sandbox and delivery protocol versions;
- the 37-row traceability result;
- CI run and disposable acceptance evidence links;
- repository tree and remote-cleanup verification;
- backup/restore rehearsal result;
- residual risks with owners and due dates.

Pass 10 closes only when the completion record states no open P0/P1 stop-line and the remaining lower-priority risk is explicitly accepted by its named authority.
