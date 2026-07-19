# Viberr — RBAC & Canonical File Formats (pass-9 discovery)

Repo: `/Users/akinozer/projects/viberr` · branch `main` · scope (A) RBAC, (B) canonical
file formats + interpretation/projections. All anchors are `file:line` at the time of
writing. Written to be accurate and critical; a **Mocks / gaps / bugs** register closes
the doc.

---

## Part A — RBAC

### A1. The two role systems

Viberr has **two independent role systems** plus a third capability layer:

1. **Org roles** — `admin | member` (`app/shared/mapping/user.server.ts` `UserRole`;
   ordered in `app/server/auth/require-user.server.ts:146` `ROLE_ORDER`). Authoritative
   source is the better-auth membership; `users.role` is a derived cache
   (`authenticate` resolves via `resolveOrgRole`, `require-user.server.ts:83`).
2. **Project roles** — the 4-tier system in `app/schemas/project-file.schema.ts:23`
   `PROJECT_ROLES = ["admin","maintainer","contributor","viewer"]`. `contributor` was
   formerly `reviewer`; legacy files are coerced at parse time
   (`project-file.schema.ts:28` `coerceProjectRole`, applied via `memberSchema`
   preprocess at line 71) — no migration needed.
3. **Agent capability policy** — `{capabilityId, mode}` grants against
   `app/shared/capabilities.ts` (not a human role; governs what agents/operator may do).

Project role tier is strict: `viewer ⊂ contributor ⊂ maintainer ⊂ admin`
(`app/shared/rbac.ts:27` `ROLE_RANK`). Every action in the matrix is monotonic.

### A2. ACTION_ROLES — the single source (app/shared/rbac.ts)

`app/shared/rbac.ts:76` `ACTION_ROLES` is THE canonical `RbacAction → allowed-roles`
map. Both the server guards and the Policy page's `RBAC_TABLE`
(`rbac.ts:118`) render from the SAME object, so display and enforcement cannot drift
(`policy-rbac.server.test.ts` drives each guard per role). Helpers: `roleCan`
(`rbac.ts:100`, null role ⇒ false), `rolesForAction` (`rbac.ts:106`).

| RbacAction | Allowed roles | Notes |
|---|---|---|
| `view` | admin, maintainer, contributor, viewer | **app-wide, NOT gated by requireAction** — any authenticated user (FR4). Present only for display. |
| `comment` | admin, maintainer, contributor, viewer | **app-wide** — same as view; enforced as "authenticated", see A5. |
| `create-task` | admin, maintainer, contributor | contributor+ (Q5 tiering: viewer = read+comment only) |
| `own-task` | admin, maintainer, contributor | take/release **own** ownership |
| `approve-transition` | admin, maintainer | approval-boundary transitions + manual stage moves |
| `resolve-packet` | admin, maintainer | also dismiss recommendations; owner exception at call site |
| `accept-completion` | admin, maintainer | + task-owner exception (R6-2), see A4 |
| `run-agents` | admin, maintainer | assign/run specialist+reviewer, @mention trigger, run operator, interrupt, schedule |
| `reorder-board` | admin, maintainer | |
| `update-goal` | admin, maintainer | |
| `grant-github-scope` | admin, maintainer | |
| `reconcile-github` | admin, maintainer | |
| `rescan-project` | admin, maintainer | board re-scan (see gap in A8) |
| `release-any-ownership` | admin | release another member's ownership |
| `manage-members` | admin | member/role CRUD |
| `manage-agents` | admin | agent profile CRUD |
| `edit-policy` | admin | workflow boundaries, role assignment, project settings (`edit-settings` shares this tier — `rbac.ts:64`) |

### A3. Enforcement mechanism — one authority path

All authority resolves through `app/server/auth/project-authority.server.ts`
(pass-7 R7-1 consolidation). Key functions:

- `resolveProjectAuthority` (`project-authority.server.ts:114`) — non-throwing core.
  Grants under the member's OWN role when it satisfies `allowed`; otherwise an **org
  admin** is granted project-**admin**-equivalent authority as the **D2 emergency
  override** and every governed-mutation override writes a `project.org_admin.override`
  audit row (`:135`). Non-`"any-member"` audits only (a page-load `any-member` override
  is not audited — F7 noise fix, `:129`). Everyone else denied.
- `requireProjectAuthority` (`:160`) — throwing wrapper; canonical task-guard 403 copy.
- `requireRunAgents` / `canRunAgents` (`:186` / `:200`) — the `run-agents` gate,
  centralized so id+audit live once.
- `assertProjectAction` (`:220`) — slug-only guard for config surfaces + route gates;
  reads project.md fresh, applies the archived read-only gate (unless `allowArchived`),
  resolves against ACTION_ROLES.
- `requireProjectMutable` (`:77`) — the archived read-only gate (409). Refuses governed
  mutations on archived projects "until an admin restores it"; the doc comment claims it
  covers "tasks, comments, agent runs, policy, settings". **Agent runs actually bypass
  it — see A8/gap.**
- `isOrgAdmin` (`:94`) — better-auth membership authoritative; disabled users never
  qualify.

The task-mutation guard `requireAction`
(`app/server/tasks/task-actions.server.ts:324`) calls `requireProjectMutable` FIRST
(archived chokepoint) then `requireProjectAuthority`. So **every governed task mutation
that names an RbacAction is both archived-gated and role-gated**. Org-admin override
returns the EFFECTIVE role ("admin") for downstream branching.

Identity is always **by userId** (ruling 6); role comparisons never join by role string.

### A4. Task-owner exception (R6-2 / Q2)

`ownerException` (`task-actions.server.ts:348`): the task's human OWNER — whatever their
tier — holds review/acceptance authority for THAT task **only if they still hold LIVE
`own-task` membership** (contributor+). A demoted viewer-owner or a removed member with a
stale `ownerUserId` never qualifies (adversarial-review #8). Used by:
- `requireAcceptCompletion` (`:372`) — maintainer+ OR owner accepts completion.
- `resolvePacket` (`:3128`) — owner OR maintainer+ resolves a packet; the
  `accept_completion` option is re-gated by `requireAcceptCompletion` (owner allowed,
  but a standing `failing` validation is refused, `:3164`).

### A5. Every mutating route/action and its RBAC check

Route pattern: each action does `requireAuth` (or `requireUser`) → `assertCsrf` →
delegate to a server mutation that enforces RBAC internally. CSRF is double-submit keyed
on the better-auth session id (`app/server/auth/csrf.server.ts`).

**Task actions — `app/routes/project.task.tsx:141`** (requireAuth + CSRF; RBAC inside
each mutation). Loader (`:74`) uses `requireUser` only — task detail is **app-wide
readable** (FR4), confirming non-members can read/comment.

| Intent | Mutation | RBAC enforced |
|---|---|---|
| `comment` | `appendComment` (`task-actions:678`) | **app-wide** (any authenticated). Only `requireProjectMutable` archived gate (`:698`) — no role check. |
| `update-goal` | `updateTaskGoal` (`:549`) | `requireAction("update-goal")` |
| `resolve-packet` | `resolvePacket` (`:3100`) | owner-exception OR `resolve-packet`; `accept_completion` → `requireAcceptCompletion` |
| `owner-take` / `owner-assign` | `setOwner` (`:2433`) | `requireAction("own-task")`; hand-off needs current-owner or `release-any-ownership`; target must hold `own-task` (`:2458`) |
| `owner-release` | `releaseOwner` (`:2551`) | self ⇒ `own-task`; other ⇒ `release-any-ownership`; no-owner idempotent path ⇒ `requireAnyMember` |
| `transition` | `transitionStage` (`:2625`) | per boundary: manual⇒`approve-transition`, auto⇒`requireAnyMember`, approval⇒`approve-transition`, human/into-final⇒`requireAcceptCompletion` |
| `run-interrupt` | `interruptRun` (`run-service.server.ts:582`) | `requireRunAgents` (`:597`) |
| `assign-specialist` | `assignSpecialist` (`specialist-run.server.ts:243`) | `runtimeAuditActor`→`requireRuntimeRole`→`requireRunAgents` |
| `run-specialist` | `startAgentRun` (`:517`) | same runtime gate |
| `assign-reviewer` | `assignReviewer` (`:339`) | same runtime gate |
| `run-reviewer` | `startAgentRun` (profileId) | same runtime gate |
| `remove-reviewer` | `removeReviewer` (`:438`) | `requireRuntimeRole` (`:509`) |
| `apply-recommendation` | `applyRecommendation` (`:3606`) | **no top-level check**; RBAC delegated to the underlying governed mutation (assign/run/transition/accept). See gap in A8. |
| `dismiss-recommendation` | `dismissRecommendation` (`:3705`) | `requireAction("resolve-packet")` |
| `run-operator` | `requireRunAgents` inline (`project.task.tsx:435`) then `runOperator` | run-agents; operator's own capability policy governs the run |
| `schedule-action` / `cancel-schedule` | `requireRunAgents` inline (`:473` / `:506`) then schedule fns | run-agents |
| `complete-merge` | `completeTaskMerge` (`:3539`) | `requireAcceptCompletion` |

**Board — `app/routes/project.board.tsx:21`**: `create-task`→`createTask`
(`requireAction("create-task")`); `reorder`→`reorderTask` (`requireAction("reorder-board")`);
`rescan`→`assertProjectAction("rescan-project")` (`:80`). See A8 rescan-scope gap.

**Policy — `app/routes/project.policy.tsx:36`**: `set-role`→`setMemberRole`
(`policy-actions.server.ts:97`, `manage-members` + **last-admin guard** `:132`);
`set-boundary`→`setTransitionBoundary` (`:182`, `edit-policy`; review→done + any
non-human-into-final boundary hard-rejected `:173`). Loader gate `requireProjectMember`
(any-member).

**Agents — `app/routes/project.agents.tsx:59`**: create/update/delete profile →
`agent-profile-actions.server.ts` all guard `manage-agents`
(`requireProjectAction` `:100` → `assertProjectAction("manage-agents")`). ALWAYS_HUMAN
coercion applied on persist (`grantsFor` `:153`, `:163`).

**Settings — `app/routes/project.settings.tsx:53`**: delegates to
`settings-actions.server.ts` — identity/stages/repo/archive/delete guard `edit-policy`
(`:121`,`:172`,`:465`,`:504`,`:548`); membership CRUD guards `manage-members`
(`:353`,`:406`). GitHub credential intents guard `grant-github-scope`
(`project.settings.tsx:143`,`:150`).

**GitHub — `app/routes/project.github.tsx:40`**: every intent →
`assertProjectAction(action, …)` (`:56`) with the action mapped per-intent
(`grant-github-scope` / `reconcile-github`).

**Org — `app/routes/org.settings.tsx:99`**: `requireRoleAuth("admin")` (`:102`) —
**org admin** for connections/users/domains/resources. `org.users.tsx` is a redirect.

**Home — `app/routes/_index.tsx:52`**: `pin`/`view` (self prefs, any auth);
`rescan`/`rebuild-projections` gated `ctx.user.role === "admin"` (org admin, `:80`/`:95`);
`create-project`→`createProject` — **intentionally self-serve for any signed-in user**
(`:107`, creator seeded as project admin).

**Instance/self**: `notifications.read.tsx`, `prefs.theme.tsx`, `profile.tsx`,
`_index` prefs — `requireAuth` + CSRF, act on the caller's own data only.

### A6. Specialist tool confinement (capability enforcement, not human RBAC)

`app/server/tasks/specialist-tool-policy.ts` maps withheld capabilities to Claude Agent
SDK `disallowedTools` (deny wins under bypassPermissions). Polarity is safe-by-default:
a capability is denied only when `mode ∈ {human, off}` or it is ALWAYS_HUMAN
(`isWithheld` `:71`). Rules (`CAP_DENY_RULES` `:30`): `create-task-branch` (all
`-b/-B/-c/-C` variants), `commit-push-branch`, `open-review-pr`, `merge-pull-request`,
`execute-code-or-write-repo` (removes Edit/Write/MultiEdit/NotebookEdit + `git commit`).
Honest scoping: **Codex ignores the denylist entirely** (`capabilities.ts:180`
`CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`), and **shell-level writes (`sed -i`, redirection)
remain reachable** because Bash is kept for validation (`:54` comment). `resolveResumeConfinement`
re-applies confinement on @mention resume (`specialist-run.server.ts:1265`) — a fix for
the XS-1 unconfined-resume bug.

### A7. ALWAYS_HUMAN + operator authority

`ALWAYS_HUMAN_CAPABILITY_IDS` (`capabilities.ts:119`) = `merge-pull-request`,
`transition-to-done`, `change-project-policy`. Never grantable to an agent in an
actionable mode. Enforced at **grant-persist** (`agent-profile-actions.server.ts:163`
coerces to `human`), at the **workflow layer** (review→done locked), and at the
**operator path**.

**Operator authority is the principal RBAC-bypass surface.** The operator toolkit builds
`opCtx = {...ctx, operatorAuthorized: true}` (`operator-actions.server.ts:231`), and the
shared mutations **skip human RBAC** when `operatorAuthorized` is set
(`task-actions.server.ts:91` doc, e.g. `transitionStage:2708`, `resolvePacket:3129`).
This is safe **only** because:
- `operatorAuthorized` is set **exclusively** by the in-process operator toolkit — never
  from a route (routes omit `ctx`, defaulting to `{}`; form data cannot inject it).
- Operator actions are gated upstream by `gate(authority, capabilityId)`
  (`operator-actions.server.ts:192`): `direct`⇒allow, `recommend`⇒card (promoted to
  `direct` under full autonomy EXCEPT `completion-for-acceptance` which stays
  `recommend`, `:201`), `human`/`off`⇒deny.
- The operator **cannot reach Done via a bare transition** — `transitionStage` refuses
  `operatorAuthorized && toStageId === lastStageId` (`:2713`); Done is reachable only via
  `operatorAcceptCompletion` under **full autonomy** + explicit `completion-for-acceptance`
  = direct (`:1558`), which additionally refuses a standing `failing`/blocked packet.

Enforced-vs-advisory honesty is codified in `capabilityEnforcement`
(`capabilities.ts:194`): ALWAYS_HUMAN ⇒ `both`; Claude-tool caps ⇒ `claude-only`;
operator-gate/structural ⇒ `both`; rest ⇒ `advisory`.

### A8. Where RBAC can be bypassed / is inconsistent

See the closing register; the concrete findings are: the archived read-only gate is not
applied to agent-runtime actions ([RBAC]); `applyRecommendation` runs its rec-lookup and
can throw a validation error before any authz ([POOR]); the board `rescan` authorizes on
one project but reprojects the whole instance ([POOR]); Codex specialists are advisory-only
([POOR], documented]; an `auto` boundary is crossable by a `viewer` member via
`requireAnyMember` ([POOR], edge]).

---

## Part B — Canonical file formats + interpretation/projections

### B1. Task file — `task.md`

Format (`app/server/files/task-file.server.ts:23` header): YAML frontmatter +
`## Goal` prose + `## Packet` (one fenced ```yaml block) + `## Timeline` (typed events,
**newest first**) + preserved unknown `## Sections`.

**Frontmatter schema** — `app/schemas/task-file.schema.ts:291` `taskFrontmatterSchema`:

- `key` `/^[A-Za-z]+-\d+$/`, `title`, `stage`, `readiness` (4-value enum `:25`
  `READINESS_VALUES` — `ready|input_required|inconsistency_risk_detected|blocked`;
  "accepted" is derived display-only, never stored), `waiting`
  (`human|agent|none` `:33`), `ownerUserId` (nullable).
- **`engagements`** (`:299`, array of `engagementSchema` `:95`) — the G1 uniform
  replacement for the former `specialist` + `reviewers[]`. Each engagement:
  `{profileId, backend(codex|claude), role, delivers:boolean=false}`. **Invariant: ≤1
  `delivers:true`** (the single workspace/branch/PR owner). Helpers `deliveringEngagement`
  (`:107`), `supportingEngagements` (`:114`).
- `operator` (`operatorRefSchema` `:122`, `{assignedAtStageId}` nullable),
  `recommendations` (`:150`, 6 kinds `:131`), `schedules` (`:179`, `run-operator` O-3),
  `urgent`, `validation` (`healthy|changed|failing|none` `:36`), `branch`, `repo`
  (task-level override), `pr` (`prRefSchema` `:209`; `state` tolerant-`.catch("review")`
  `:214`; PR_STATE `review|merged|closed|accepted` `:206`), `github`
  (`githubCacheSchema` `:222` — projection cache, not human truth), `createdAt`,
  `updatedAt`, `boardRank` (sparse rank for drag-reorder; null ⇒ falls back to key number).
- **Packet** (`taskPacketSchema` `:270`): `type(input|blocked)`, `kind`, `from`,
  `title`, `body`, `observations[]`, `options[]` (`packetOptionSchema` `:249`, stable
  `kind` enum `:56` — dispatch on kind, never English title), `awaiting?("goal_edit")`.
- **Recommendations** (`:150`) and **github recommendations `github` cache** are frontmatter,
  not projections; recommendations are read directly from the task file in the route
  loader (`project.task.tsx:109`).

**Timeline event** (`TaskFileEvent`, `task-file.schema.ts:764`): `{occurredAt, type,
actor, title, text, toAgent, evidence}`. 9 event types (`:41`).

### B2. Project file — `project.md`

`app/schemas/project-file.schema.ts:175` `projectFrontmatterSchema`: `name`, `slug`
`/^[a-z0-9][a-z0-9-]*$/`, `archived?` (optional; tolerant parse fills concrete `false`),
`repo` (nullable default), `defaultBranch`, `taskPrefix` `/^[A-Za-z]+$/`,
`nextTaskNumber` (atomic per-project counter), `stages[]` (`stageSchema` `:46`),
`workflow[]` (`workflowBoundarySchema` `:56`, boundary `auto|approval|human` `:34`,
`locked`), **`members[]`** (`memberSchema` `:68` — `{userId, role}` with legacy
`reviewer→contributor` preprocess), `agents[]` (`agentDeploymentSchema` `:135` —
`{profileId, capabilities[], extras[], definition?}`; capability grant `:76`
`{capabilityId, mode(direct|recommend|human|off)}`), `credentialPolicy` (non-secret; PAT
lives AES-encrypted in SQLite, never in files), `guardrails[]` (`:162`).

### B3. Tolerant parsing (the contract)

Contract (`task-file.schema.ts:13`): unknown frontmatter fields are **preserved**
(returned separately, re-written verbatim by the serializer); missing/invalid fields
produce structured `FileDiagnostic`s + a safe fallback — **the parser never throws and
never drops the task**. `tolerant<T>` (`:355`) is the per-field workhorse. `key`/`slug`
have directory-name fallbacks (`:494` / `:290`); a `key`/`stage` mismatch or missing
value emits a diagnostic. A missing/invalid `stage` falls back to a **blank marker** (not
a fabricated `triage`) so the projection buckets the card as "unknown stage" and floors
readiness (`:541`).

**Legacy engagement decode** — `parseEngagements` (`:397`): when `engagements` is absent,
`specialist` → the delivering engagement (`delivers:true`), `reviewers[]`/`consultants[]`
→ supporting engagements. Each legacy ref validated **independently** so one bad reviewer
never drops the specialist. Legacy keys are **absorbed, not preserved** as unknown
(`:682`), so the next write emits `engagements` only. Defense-in-depth: profileId dedup
(first wins + diagnostic `:441`) and multi-deliverer demotion (first delivering wins,
extras demoted with diagnostic `:461`).

**Packet parse** (`parseTaskPacket` `:693`): a salvageable block parses; an invalid one
returns `null` + a `packet.invalid` error (packet ignored, task kept).

### B4. Actor-ref codec — `agent:<backend>/<profileId>`, never-null decode

`app/server/files/actor-ref.server.ts`. Variants (`:3`): `user:<id> (Name)`,
`agent:<backend>/<profileId> (Role)`, `operator`, `system:<id>`, and `unknown`.

- **Encode** (`:70`): agent refs run `roleToSlug(profileId)` (`:36`
  lowercase+whitespace→`-`). In practice profile ids are already lowercase slugs
  (`agent-profile-actions.server.ts:230` `slugifyProfileId` → `slugify` `slugify.ts:8`),
  so this is idempotent — but it is **lossy for any non-slug id** (uppercase base64url
  from `newId` would be corrupted). Latent fragility, not a live bug. Display hints are
  sanitized so they never contain `·` or newlines (`:66`).
- **Decode** (`decodeActorRef` `:94`): **TOTAL — never returns null**. Regexes at `:28`
  (`HUMAN_RE`), `:32` (`AGENT_RE` = `agent:(codex|claude)/(\S+)( (role))?`), `:33`
  (`SYSTEM_RE`). An unrecognized ref → `{kind:"unknown", raw}` and re-encodes verbatim
  (`:86`). This closes the **VIB-12** class where a role-slug ref containing `&` failed a
  strict decoder, returned null, and **silently dropped the event** on the next
  read-modify-write. Legacy `agent:<backend>/<role-slug>` refs decode with the slug as
  `profileId` + null `roleHint`; `agentRoleDisplay` (`:57`) renders them exactly as before.

The timeline parser keeps unknown-author events (`task-file.server.ts:148`), but a
**malformed heading (missing separators) or unparseable timestamp still drops the event**
(`parseEventBlock` returns null, `:117` / `:132`) — a residual tolerant-drop path.

### B5. Interpretation / readiness derivation

`app/server/interpretation/readiness-policy.server.ts` is the ONLY place readiness is
derived. `deriveReadiness` (`:36`): stored readiness is respected unless diagnostics
impose a **worse** floor (never improves). `diagnostics-policy.server.ts:20`
`READINESS_RANK` + `worstReadinessEffect` (`:41`): info⇒none, warning⇒`input_required`,
error⇒`inconsistency_risk_detected`, hardStop⇒`blocked`. `referenceDiagnostics` (`:58`)
adds a project-context `reference.unknown_stage` warning. "accepted" is a display state
(`isAcceptedDisplayState` `:55`) = task in the project's final stage; never stored.

### B6. Projection materialization into SQLite

`app/server/projections/rebuilder.server.ts` projects files → SQLite tables
(`projects`, `project_members`, `task_projections`, `task_events`, `diagnostics`,
`provenance`).

- `rebuildTaskFile` (`:287`): content-hash short-circuit (`:330` — skip when unchanged
  unless `force`); parse → `referenceDiagnostics` (needs the already-projected project
  row for stage ids, `:341`) → `deriveReadiness` → upsert `task_projections` (`:368`).
  **Engagements are flattened back to the legacy projection shape**: the delivering
  engagement → `specialist_json`, supporting engagements → `reviewers_json` (`:413`).
  A missing task file with an existing row is pruned (`:302`) + emits `task.removed`.
- `rebuildProjectFile` (`:157`): upserts `projects`, replaces `project_members`
  (`:232` DELETE + INSERT OR REPLACE), and normally cascades a task re-projection.
- `provenance` (`recordProvenance` `:88`) records `{source_path, content_hash,
  observed_at, action, details}` for every project/removed/error/rescan; `diagnostics`
  are replaced per source_path (`replaceDiagnostics` `:109`).
- `rebuildPath` (`:518`): routes a path to task/project rebuild by regex; a rebuild
  failure is caught, logged, and recorded as a `provenance` `error` row (`:539`) — never
  throws to the caller.
- `rebuildAll` (`:552`): full rescan; when a project row changes it force-re-projects its
  tasks (`:603`) so stage-reference diagnostics / effective repo / guest flags never go
  stale behind the task-side hash short-circuit. Prunes rows whose files vanished
  (`:614`).
- Board/task queries read the projection back
  (`board-query.server.ts`, `task-query.server.ts`).

### B7. The file watcher

`app/server/files/file-watch.service.server.ts`: chokidar on `${dataRoot}/projects`,
250 ms trailing debounce per path (`:29`, `:95`). Only `project.md` / `task.md` schedule
a rebuild (`:181`); dotfiles + `*.tmp` (atomic-write staging) ignored (`:40`).
`shouldPruneSubtree` (`:57`) prunes anything at depth ≥5 and `workspace/` dirs — critical:
without it chokidar holds an fd per file in every historical workspace clone (~550/task),
exhausting fds past ~10 240 and killing `posix_spawn` (all agent runs die). `unlinkDir`
(E13) reconciles a vanished task/project dir (`:123`) because a recursive rm can outrun
per-file unlinks. On chokidar `error` (E8) the handle is cleared so
`isFileWatcherAlive`/`/resources/health` report the truth (`:192`), with self-healing
re-arm on transient FS-pressure codes (`:212`). HMR-safe via a global symbol (`:31`).

### B8. SSE event contract

`app/schemas/sse-event.schema.ts`: names are lowercase dot-separated facts (`:22`);
every payload is `{type, entityId, occurredAt, data}` with **compact references only**
(`sseEventSchema` discriminated union `:49`). `task.updated` carries only
`{projectSlug, taskKey, stage, readiness}` (nullable when the row can't be read back — the
publisher must not invent facts, `:57`). Runtime events (`run.log-appended`,
`run.state-changed`) are published straight to the broker (not the projection emitter)
with reference-only payloads. `stream.open`/`stream.resync` are broker control events.
The server zod-parses every event before it goes on the wire.

---

## Mocks / gaps / bugs

- **[RBAC] Archived read-only gate does NOT cover agent-runtime actions.**
  `requireProjectMutable` (`project-authority.server.ts:77`) documents that archived
  projects "refuse every governed mutation (tasks, comments, agent runs, policy,
  settings)", and `requireAction` enforces it for task mutations. But the runtime paths —
  `assignSpecialist`/`startAgentRun`/`assignReviewer`/`removeReviewer`
  (`specialist-run.server.ts`), `interruptRun` (`run-service.server.ts:582`),
  `runOperator`/`schedule-action` — resolve authority via `requireRunAgents` →
  `requireProjectAuthority`, which **never calls `requireProjectMutable`**. `grep` for
  `requireProjectMutable|archived` in specialist-run / run-service / operator-run returns
  nothing. Risk: an admin/maintainer (or org-admin override) can start agent runs, resume
  via @mention, interrupt, and schedule operator re-runs on an **archived** project —
  contradicting the archive invariant. Medium.

- **[POOR] Board `rescan` authorizes one project but reprojects the whole instance.**
  `project.board.tsx:80` checks `assertProjectAction("rescan-project", params.slug)`
  (maintainer+ of that ONE project) then calls `rescanProjections` →
  `rebuildAll` (`rescan.server.ts:14`, `rebuilder.server.ts:552`) which re-projects
  **every** project. The home-level equivalent is org-admin-gated (`_index.tsx:80`).
  Idempotent/non-destructive (rebuild from files), so low blast radius, but the authz
  scope (one project) ≠ effect scope (all projects). Low–medium.

- **[POOR] `applyRecommendation` performs a file read + rec dispatch before any authz.**
  `applyRecommendation` (`task-actions.server.ts:3606`) has **no top-level RBAC guard**;
  it reads the task file, finds the rec, and either delegates to a governed mutation
  (which enforces RBAC) or throws `AppError.validation("This recommendation is
  malformed.")` (`:3673`) when `profileId`/`toStageId` is missing. A viewer/non-member
  hitting a malformed rec id gets a 422 validation error instead of a 403, a minor authz
  ordering / info-leak smell. Delegated paths are correctly gated. Low.

- **[POOR] Specialist tool confinement is Claude-only + shell-escapable (documented).**
  `capabilities.ts:180` — the branch/push/PR/write denylist binds only on Claude runs;
  Codex specialists treat these caps as advisory. `specialist-tool-policy.ts:54` — even
  on Claude, `execute-code-or-write-repo` withholding cannot stop `sed -i`/redirection
  because Bash stays available for validation. Honestly labeled via
  `capabilityEnforcement`, but it means "withheld repo-write" is not a hard guarantee.
  Known/accepted; flagging for the planner.

- **[POOR] Whole-array tolerant fallback drops the ENTIRE list on one bad entry — most
  serious for `members`.** In `parseProjectFrontmatter` (`project-file.schema.ts:385`)
  `members` is parsed as `z.array(memberSchema)` via `tolerant(..., [])`. If a **single**
  member row is invalid (e.g. an unknown `role` string that survives the
  reviewer→contributor coercion), the whole array fails zod and falls back to `[]` —
  **every member silently loses their role**, leaving the project with no members (only
  the org-admin override can then act). Same all-or-nothing shape applies to `stages`,
  `workflow`, `agents`, `guardrails`. Contrast `parseEngagements`
  (`task-file.schema.ts:397`), which validates each entry independently. This is a real
  ACL-integrity fragility. Medium.

- **[POOR] Malformed timeline heading / bad timestamp still drops the event.**
  `parseEventBlock` (`task-file.server.ts:101`) returns `null` (event dropped) on a
  heading missing its two `·` separators (`:117`) or an unparseable timestamp (`:132`).
  The never-null actor decode fixed the common VIB-12 drop, but a corrupt heading/time is
  still lost on read — and therefore permanently on the next read-modify-write. Narrow but
  a silent data-loss path. Low.

- **[POOR] `roleToSlug(profileId)` on actor-ref ENCODE is lossy for non-slug ids.**
  `actor-ref.server.ts:77` lowercases/whitespace-slugs the profileId when encoding an
  agent ref. Live profile ids are already slugs (idempotent), but any id containing
  uppercase (e.g. `newId` base64url) would round-trip to a different id and break the
  identity join. Latent, not currently triggered. Low.

- **[POOR] `auto` boundary is crossable by a `viewer`.** In `transitionStage`
  (`task-actions.server.ts:2722`) an `auto` boundary crossed by a human uses
  `requireAnyMember` — which admits `viewer`, despite Q5's "viewer = strictly read +
  comment". Mitigated in practice: the UI always sends `manual:true` (⇒
  `approve-transition`), and default governed workflows declare no `auto` boundaries into
  meaningful stages. Edge/by-spec but worth noting. Low.

- **[MOCK] Comment agent-routing is a hardcoded handle regex.**
  `AGENT_HANDLE_RE = /@(agent|operator|codex|claude)\b/i` (`task-actions.server.ts:662`,
  labeled "Mock routing rule") decides the routed-to-agent tint; named-agent mentions rely
  on `forceToAgent`. Functional but string-based rather than resolved against the
  engagement/profile set. Low.

- **[Note, not a bug] `operatorAuthorized` bypass is sound.** The human-RBAC skip
  (`task-actions.server.ts:91`) is reachable only from the in-process operator toolkit
  (`operator-actions.server.ts:231`); routes never pass `ctx`, so form data cannot inject
  it, and operator actions are independently gated by `gate()` + capability policy, with
  Done locked behind full-autonomy + explicit `completion-for-acceptance=direct`. No hole
  found — recorded so the planner knows the invariant to preserve.
