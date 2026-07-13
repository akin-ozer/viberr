# Current-state reference

## Product model

Viberr is an agent-native delivery workspace. Agents execute scoped work; humans supervise flow,
review evidence, resolve decisions, and accept completion. The task markdown file is the canonical
operating contract. SQLite is a rebuildable projection except for app-owned identity, session,
secret, audit, notification, preference, and runtime records.

The central mutation path is:

project.md or task.md write → incremental projection → audit → notifications/SSE

The default workflow is Triage → Ready → In Progress → Review → Done. Projects may define custom
stages. Workflow boundaries are auto, approval, or human. A move into the terminal stage must use the
acceptance contract from the governed Review stage. A direct stage-transition capability may cross
nonterminal controlled boundaries; terminal acceptance is separate and requires validation to be
exactly `healthy`.

## Runtime and agent model

- Baseline roster: Operator, Developer, Reviewer.
- One primary specialist plus multiple reviewers per task. Each reviewer has a stable isolated
  workspace namespace.
- Eligible stages are a hard constraint at assignment and run time.
- Operator actions are direct, recommend, human, or off.
- Supervised operators generate applyable recommendations instead of crossing controlled steps.
- A real run failure must leave a durable blocked event, recovery choice, notification, and
  waiting-on-human state.
- Specialist resume must preserve persona, disallowed tools, Git ceiling, skills, KBs, MCPs, model,
  and effort.
- Claude and Codex should present the same Viberr lifecycle even when provider controls differ;
  differences must be disclosed, not hidden.
- A reviewer result governs state only through exactly one structured `VIBERR_REVIEW_VERDICT` JSON
  marker from a non-simulated run. Any rejection returns the task to implementation; every assigned
  reviewer must approve the current evidence round.
- Hard stage/deployment/capability/MCP/backend constraints remove impossible routing candidates
  within the current project. The operator receives project candidate skill/KB/MCP/backend facts
  plus organization-wide current workload and observed-cost context, makes the final intelligent
  choice without a static score, and persists its reason to timeline and audit. One exact routing
  intent id follows the selected/recommended binding and any launched run as `sourceIntentId`.
- Automatic create/transition triggers use a durable coalescing dispatcher with bounded concurrency
  and hourly cost. Ordinary triggers and completion-source reactions occupy independent slots, and
  dispatch ownership plus operator effects are checkpointed so restart recovery neither loses nor
  repeats applied work. Placeholder goals stay input-required without a paid turn.
- Every asynchronous run, trigger, dispatch and completion effect carries the task incarnation it
  was created for. Project archive/delete revokes admission, stops providers, waits for exit and
  completion-effect acknowledgement, and makes old pending work inert before changing canonical
  project state. A project or task recreated under the same slug/key is therefore a new identity.
- Project lifecycle admission reads canonical `project.md`, never a potentially lagging projection.
  If archive/delete teardown fails, admission reopens only for the byte-identical active project;
  restore reopens immediately after its canonical write, before projection and audit converge.
- On boot, canonical archived projects recreate the in-memory completion-effect revocation fence
  before PR-open, merge, acceptance, routing or agent-run recovery. Archived intent rows are retained
  but deferred: they cause no GitHub request and no task-file mutation until explicit restore.
- Run completion is a monotonic durable pipeline: reply, delivery, evidence, verdict and operator
  reaction are separately checkpointed. Boot recovery resumes only unapplied phases against the
  persisted run context; simulated output remains history-only and cannot enter governance.
- The active-effect admission/drain registry is process-local. The supported deployment therefore
  has one server-writer process (the current Docker Compose topology). A future multi-replica
  deployment must replace that registry with a durable/distributed lifecycle lease before it can
  claim the same archive/delete race guarantees.

## Durable exact-intent recovery

SQLite runtime records are not merely projections when they own an in-flight
cross-boundary operation. The fresh schema journals the exact target and
original attribution before the operation can cross a canonical-file or remote
GitHub boundary:

| Intent | Exact binding | Recovery rule |
| --- | --- | --- |
| Task acceptance/completion | project, task key, task `createdAt` incarnation, immutable evidence fingerprint, Done stage, actor/authority and exact PR/head when applicable | Converge only that incarnation and evidence occurrence. Acceptance-audit lookup includes incarnation. A merged request is never merged again; a repo-less full-autonomy completion retains explicit operator authority. |
| GitHub merge | task incarnation, normalized repository, default/base branch, PR number, full reviewed head, original accepter/authority | Stage before PUT and repeat the complete immutable target in the final merge callback; retry/boot restores local facts and attribution for the same remote merge occurrence. |
| Review-to-PR handoff and PR open | Before Review commits: task incarnation, Review stage/revision, repository, base and branch. Before any adopted/cached/listed PR write or POST: that handoff plus full head, title/body and original actor/authority. | Boot promotes only a handoff whose exact Review occurrence committed. Cached/listed adoption is intent-backed. An ambiguous POST is observation/manual-reconciliation only and never blindly retried; an observed PR is never posted again. |
| Operator routing | task incarnation, operation/purpose, profile/backend, selected or recommended disposition, reason and complete candidate context | Assignment, recommendation, rationale and run must carry the same `sourceIntentId`. A pending request rebuilds current context and cancels on drift; boot makes a second routing pass after orphan-run recovery. |
| Project archive/restore | exact from/to archived state, canonical marker, teardown counts and original actor/authority | Boot converges projection and deterministic audit only when `project.md` contains that intent's marker and target state; otherwise it cancels the uncommitted row. Canonical archives restore their revocation fence before any retained intent can run. |
| Ownership cleanup | batch id, every task incarnation/owner, reason and original actor/override authority, plus a marker committed with the exact access change | Stage seats while access is unchanged, atomically commit role/member state and batch marker, then release tasks. Pre-commit authority/target conflict cancels without changing seats or audits; retry/boot never clears a replacement task or newer owner. |

Project deletion remains a canonical-directory commit followed by durable
tombstone convergence. Deletion purges every project-keyed operational and
intent row so reuse of the slug starts as a new identity. Deterministic audit
and timeline ids make each recovery idempotent without collapsing a later
occurrence.

## GitHub delivery contract

The intended chain is task-key branch → task-key commits → task-linked review PR → human acceptance
and merge. Markdown remains canonical; GitHub is the execution surface. A missing credential must
degrade honestly. A repository task remains in Review when acceptance is recorded but merge is pending; only
a real merge moves it to Done. A healthy repo-less task may finish directly. The automatic Review
transition first journals a lightweight PR handoff, closing the crash window before the asynchronous
GitHub work can begin. PR creation/adoption, merge and acceptance are separately journaled because
each can cross a remote/canonical split. All repository identity comparisons use normalized
repository/base/branch plus the full head SHA; the final merge callback repeats that target, and
short SHAs or same-key tasks from a different `createdAt` incarnation are never equivalent.

## Role model

Organization roles are admin and member. Better Auth organization membership is the authoritative
org-role source; the legacy users role is derived.

Project roles are admin, maintainer, contributor, viewer, stored in project.md.

| Action floor | Actions |
| --- | --- |
| Authenticated app user | view boards/tasks, comment |
| Contributor+ | create task, own/release own task, reconcile GitHub; a current contributor+ owner may resolve and accept that owned task |
| Maintainer+ | approve transitions, resolve packets, accept completion across project tasks, run agents, reorder board, update goal, grant GitHub scope |
| Project admin | release any owner, manage members/agents/policy |

Organization admins have visible, audited emergency project-admin authority even without an
explicit project membership.

Contributor-owner acceptance and organization-admin override are commit-time
authority, not stale loader grants. Governed mutations re-read the enabled user,
Better Auth organization role, canonical project role and exact task ownership
at the canonical/irreversible boundary. If authority changed while work was in
flight, the mutation stops; if it proceeds, timeline and audit record the
authority actually used at that boundary.

Board and task detail are organization-wide readable for authenticated users. Review, Agents,
Policy, GitHub, Activity, and Settings require project membership, except that organization admins
may enter under their visible emergency override. Agent mentions are recorded for all authenticated
users, but only maintainer+ or an org-admin override can trigger a runtime.

Archived projects remain readable history through direct routes. Every project mutation and new run
is rejected, active runs stop, and Settings exposes Restore as the only mutation.

## Route inventory

| Surface | Route |
| --- | --- |
| Login/reset | /login |
| Home/projects | / and /projects redirect |
| Org settings | /org/settings?tab=connections, users, resources |
| Profile overlay | /profile |
| Notifications overlay | /notifications |
| Board | /projects/:slug/board |
| Review queue | /projects/:slug/review |
| Agents | /projects/:slug/agents |
| Policy | /projects/:slug/policy |
| GitHub | /projects/:slug/github |
| Activity | /projects/:slug/activity |
| Project settings | /projects/:slug/settings |
| Task workspace | /projects/:slug/tasks/:key |

Resource routes provide auth, notification-read, theme, SSE events, run-log tail, health, model
catalog, and session export. Business mutations are session- and CSRF-protected React Router form
actions, not a public REST API.

## Source map for implementation agents

- Route table: app/routes.ts
- Shared RBAC and action floors: app/shared/rbac.ts
- Project/task schemas: app/schemas/project-file.schema.ts and task-file.schema.ts
- Canonical file mutation: app/server/tasks/task-actions.server.ts and app/server/files
- Projection rebuild/query: app/server/projections
- Auth/org identity: app/lib/auth.server.ts and app/server/auth
- Operator/specialists: app/server/runtimes and app/server/tasks/operator-*.server.ts,
  specialist-*.server.ts
- GitHub delivery: app/server/github
- Durable acceptance convergence: app/server/tasks/task-completion-recovery.server.ts
- Durable routing decisions: app/server/tasks/operator-actions.server.ts
- Project lifecycle and deletion recovery: app/server/projects/project-lifecycle.server.ts and
  project-operational-state.server.ts
- Ownership cleanup recovery: app/server/tasks/ownership-cleanup.server.ts
- Boot recovery order: app/server/boot.server.ts
- Org resources: app/server/org and app/features/org-settings
- Board/task/agent/policy UI: app/features
- Seed/demo state: scripts/seed.ts and app/server/seed
- Docker runtime: compose.yml and Dockerfile

## Post-review release state

The exact-intent and commit-boundary hardening described above completed one
consistent local release gate:

- Vitest passed 158 files/1,565 tests in 30.25 seconds; typecheck, production
  build and whitespace checks passed; the independent focused verifier passed
  197/197 risky-contract tests.
- Playwright passed 19/19 in 22.1 seconds.
- A fresh Compose data root seeded 3 projects/12 tasks. Its immediate rescan was
  0 changed/15 unchanged/0 removed/0 errors in 3 ms; health and integrity were
  OK, the watcher was active, and application logs contained 0 warnings/errors.
- The signed-in production browser walkthrough covered Home, Board, VIB-142,
  Review, Agents, Policy, GitHub, Activity, Settings and organization
  Users/Resources with 0 console warnings/errors. The 12 new captures live in
  `screenshots/post-review/`.
- Publication target is existing draft PR #23 on
  `codex/full-pass-2026-07-13`; remote push/check evidence is recorded only
  after publication.

## Earlier verified deployment state (before adversarial-review remediation)

- The canonical local Docker Compose browser origin is `http://localhost:5173`; the
  `127.0.0.1` alias redirects to it so Better Auth and OAuth form posts keep one trusted origin.
  The facts in this section belong to the earlier completed pass, not the
  post-review hardening gate.
- Health reports `ok: true`, 5 projects, 38 tasks, watcher active, integrity `ok: true`, and
  `recoveryRequired: false`.
- Claude and Codex are both configured. Their status is `unknown` with no recent run signal, which
  deliberately avoids treating credential presence as verified backend health.
- A second Compose container forced a projection rescan of 5 projects/38 tasks: 43 changed, zero
  errors in 172 ms, with integrity still healthy afterward.
- The organization contains the 24-case Viberr Deep Validation project. In its final role fixture,
  Elif is project Admin, Murat is Contributor and VDV-11 owner, Selin is Viewer, and Arda enters as
  a nonmember organization Admin through the visible emergency override. Murat is separately a
  Viberr Core Maintainer; that role never leaks into the selected VDV context.
- Viberr Live Six was archived to readable, mutation-free history and then restored.
- DeepWiki is a healthy real HTTP MCP resource with three tools, Claude+Codex support, and an API
  Specialist attachment.
- Typecheck, the 1,318-test Vitest suite, production build, and 19-case Playwright suite passed on
  that earlier tree. Its browser logs after that pass's evidence cutoff contained no warning/error.

## Pre-fix verified baseline

The facts below are preserved from the first Docker campaign and explain the findings. They are not
post-fix validation and must not be used as release proof.

- Docker Compose image builds successfully.
- Health: ok=true; projections 4 projects/14 tasks; watcher=true; Claude=real; Codex=real.
- Typecheck passes.
- Unit suite was not clean: 1182 passed, 3 watcher tests failed under an EMFILE re-arm loop, with
  additional simulated-run callbacks writing after their test database closed.
- Browser production build emitted React hydration error #418 on notification direct navigation due
  to server UTC versus browser-local clock rendering.
- The first production campaign created Viberr Deep Validation with four project roles, seven agent
  profiles, and 24 independent tasks. Task creation launched 24 real Triage operator runs; the live
  evidence is recorded in test-results.md and F34-F40.

These baseline facts explain the findings only. They are not reused as final proof, and individual
VDV tasks that remained blocked/stale are not relabelled as successful live runs. Final evidence is
preserved in `test-results.md` and `browser-walkthrough.md`; the newer post-review gate is recorded
separately above.
