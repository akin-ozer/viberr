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
  choice without a static score, and persists its reason to timeline and audit.
- Automatic create/transition triggers use a durable coalescing dispatcher with bounded concurrency
  and hourly cost. Placeholder goals stay input-required without a paid turn.

## GitHub delivery contract

The intended chain is task-key branch → task-key commits → task-linked review PR → human acceptance
and merge. Markdown remains canonical; GitHub is the execution surface. A missing credential must
degrade honestly. A repository task remains in Review when acceptance is recorded but merge is pending; only
a real merge moves it to Done. A healthy repo-less task may finish directly.

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
- Org resources: app/server/org and app/features/org-settings
- Board/task/agent/policy UI: app/features
- Seed/demo state: scripts/seed.ts and app/server/seed
- Docker runtime: compose.yml and Dockerfile

## Final verified deployment state

- The production Docker Compose image is healthy at `http://127.0.0.1:5173`; Compose resolves
  `BETTER_AUTH_URL` to that origin and final logs have no warning/error.
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
- Typecheck, the 1,318-test Vitest suite, production build, and 19-case Playwright suite pass. Final
  browser logs after the evidence cutoff contain no warning/error.

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
summarized above and detailed in `test-results.md` and `browser-walkthrough.md`.
