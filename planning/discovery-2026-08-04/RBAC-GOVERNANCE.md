# Viberr — RBAC & Governance Reference

**Status:** written 2026-08-04 against `main` @ `2442945`. Every claim below is code-confirmed;
`path:line` refs are the proof. Where a planning ruling (R6-3, R7-1, R8-x, R14-x, R15-x, D2, DG-2,
P13-D-8 …) is named, it is named *because the code comment names it* — the rulings themselves live in
`planning/discovery-*` and `docs/architecture/decisions.md` and are not restated here beyond what the
code confirms.

**Read this first if you are about to touch authorization.** The design is *matrix-as-source*: one
object (`RBAC_DEFINITIONS` in `app/shared/rbac.ts`) is consulted by every server guard **and**
rendered by the Policy page, and a binding test drives the real guards per role. Adding an action
means adding a row there — never a hardcoded role literal.

---

## 1. The role model

### 1.1 Two independent role systems

| System | Values | Stored in | Type source |
|---|---|---|---|
| **Org role** | `admin`, `member` | `users.role` (SQLite) | `UserRole` — `app/shared/mapping/user.server.ts` |
| **Project role** | `admin`, `maintainer`, `contributor`, `viewer` | `projects/<slug>/project.md` frontmatter `members[]` (canonical) → projected into `project_members` | `PROJECT_ROLES` / `ProjectRole` — `app/schemas/project-file.schema.ts:23-24` |

They are orthogonal: an org `member` can be a project `admin`; an org `admin` can be a non-member of
a project (and then reaches it only through the audited D2 override, §3.4).

- Org-role DDL: `db/migrations/0001_baseline.sql:28` — `role TEXT NOT NULL CHECK (role IN ('admin','member'))`.
- Org-role hierarchy: `app/server/auth/require-user.server.ts:174-182` (`ROLE_ORDER = { member: 1, admin: 2 }`, `roleSatisfies`).
- Project-role DDL (projection): `db/migrations/0001_baseline.sql:66-71` — `project_members(project_slug, user_id, role CHECK (role IN ('admin','maintainer','contributor','viewer')))`, PK `(project_slug, user_id)`.
- Project-role rank: `app/shared/rbac.ts:27-32` — `viewer 0 < contributor 1 < maintainer 2 < admin 3`.
- Project-role display labels: `app/shared/rbac.ts:34-39`.

### 1.2 `reviewer` → `contributor` rename

`app/schemas/project-file.schema.ts:18-22` records the history verbatim:

> `contributor` was formerly named `reviewer`; the rename dropped a misleading label (review authority
> actually rides per-task ownership, not the role) while keeping the tier's one real power — creating
> tasks — above read-only `viewer`.

Consequences a future agent must not re-invent:
- Review authority is **not** a project role. It is (a) a task-file **engagement** with
  `verdictCapable: true` (agents), and (b) the human acceptance tier `accept-completion` +
  the task-owner exception. See §5.
- The literal string `reviewer` survives only as an *engagement* concept
  (`assignReviewer`, `supportingEngagements`) and in the old test-store doc comment
  `test-support/test-store.ts:26` ("selin → reviewer") which now writes `contributor`
  (`test-support/test-store.ts:76`). Stale comment, not stale code.

### 1.3 Membership storage — the file is canonical

`project.md` frontmatter is the source of truth; the DB row is a projection.

- Member schema: `app/schemas/project-file.schema.ts:63-68` — `{ userId: string, role: enum(PROJECT_ROLES) }`, `.loose()`.
- Live reads: **every** authority check re-reads the file (`readProjectFile`) or a freshly loaded
  `ProjectContext` — there is no session-cached role. Stated at
  `app/features/policy/policy-actions.server.ts:85-88`: "permission checks always parse project.md,
  so the change is 'enforced on the next action' with no session-cached role anywhere."
- Guard input shape: `AuthorityProject { slug, memberRoles: Map<userId, ProjectRole>, archived }` —
  `app/server/auth/project-authority.server.ts:45-53`. Slug-only callers use `assertProjectAction`,
  which builds the map itself from the file (`:337-343`).
- `runAgentsAuthority()` builds the same shape from the *projection* for the run paths —
  `app/routes/project.task.tsx:284-300`.

### 1.4 Members-only projects (R15-4)

Projects are **members-only**; a non-member gets a 404 byte-identical to an unknown slug (WI-13
secrecy beats FR4's app-wide read).

- Layout chokepoint: `app/routes/project.tsx:40-46` (doc), `:62-76` (the refusal). The refusal runs
  **before** any viewer-scoped projection work.
- Per-loader gate (single-fetch `?_routes=` bypass): `app/routes/project.task.tsx:97-109`.
- Action-side gate: `app/routes/project-visibility.server.ts:28-44` — `requireVisibleProject()`
  resolves through `assertProjectAction(db, "any-member", …, { allowArchived: true })` and converts
  **any** `AppError` into `throw data("No project at projects/<slug>.", { status: 404 })`, never the
  guard's own 403 (a 403 would confirm existence).
- Config-surface loaders: `app/server/auth/require-project.server.ts:20-45` — `requireProjectMember()`
  (`"any-member"`, `allowArchived: true`) converts the AppError into a real 403 Response.
  Callers: `project.activity.tsx:40`, `project.review.tsx:28`, `project.agents.tsx:39`,
  `project.policy.tsx:29`, `project.settings.tsx:46`, `project.github.tsx:31`,
  `resources.run-log.ts:69`, `resources.session-export.ts:44`.
- Home scoping: `app/features/home/home-query.server.ts:119` (org admins see every project) and
  `:122-130` (everyone else filtered by `project_members`).
- SSE scoping: `app/routes/resources.events.ts:100-136` — org admins may name any scope; a non-admin's
  `projects` firehose is expanded to their member projects, explicit foreign `project:`/`task:` scopes
  are dropped, and an all-foreign request 403s.
- ⌘K search scoping: `app/features/shell/command-search.server.ts:1-17,63-64` — reuses
  `listHomeProjectsForUser`, "so the palette can never surface a task, branch or agent belonging to a
  project whose existence the viewer must not learn."

**Important:** the `rbac.ts` header comment at `app/shared/rbac.ts:17-22` still says view/comment are
"app-wide … member or not". The corrected statement is `app/shared/rbac.ts:46-54`. See §7.1.

### 1.5 env-admin / `admin@viberr.dev`

There is **no promotion path**. The bootstrap only fires on an *empty* `users` table.

- `app/server/auth/seed-admin.server.ts:19` — `DEFAULT_SEED_ADMIN_EMAIL = "admin@viberr.dev"`.
- `:37-91` `seedInitialAdmin(db, { email?, password? })`:
  - `:41` `if (countUsers(db) > 0) return { created: false };` ← the whole story.
  - `:43` email defaults to `admin@viberr.dev`, lower-cased.
  - `:44-45` password from env, else `randomBytes(12).toString("base64url")`.
  - `:48-58` `insertUser(role: "admin", pwresetRequired: generated, idp: "local")`.
  - `:60-65` `provisionIdentity` writes the better-auth `user` + credential `account` rows.
  - `:67-73` audits `org.user.created` with `{ bootstrap: true }`.
  - `:75-84` a **generated** password is logged once at `warn` ("VIBERR BOOTSTRAP ADMIN — …"); an
    env-supplied one is never logged.
- Env vars: `VIBERR_SEED_ADMIN_EMAIL` / `VIBERR_SEED_ADMIN_PASSWORD` —
  `app/server/config/env.server.ts:91-96` (both optional). **Not** `VIBERR_ADMIN_EMAIL`.
- Boot call: `app/server/boot.server.ts:217-220`.
- Seed CLI recovery branch (P11-01): `app/server/seed/seed.server.ts:144-170` re-hashes an admin whose
  stored credential fails `isBetterAuthPasswordHash`; dev default password
  `app/server/seed/seed-credentials.ts:12` — `SEED_DEFAULT_PASSWORD = "viberr-dev-2828"`.
- `--reset` never drops auth tables: `app/server/seed/seed.server.ts:76-94,102`.

---

## 2. `ACTION_ROLES` — the single source

**File: `app/shared/rbac.ts` (100 lines — read it whole before editing anything here).**

```
RBAC_DEFINITIONS  (rbac.ts:55-83)   → the rows: { id, label, roles[], appWide? }
ACTION_ROLES      (rbac.ts:87-89)   → Object.fromEntries(id → roles)
RbacAction        (rbac.ts:85)      → the union of ids (derived, never hand-written)
roleCan(role,a)   (rbac.ts:92-95)   → null/undefined role ⇒ false, always
rolesForAction(a) (rbac.ts:98-100)  → the allow-list guards pass to the authority resolver
```

### 2.1 The full action matrix (as of 2026-08-04)

18 actions. `A` = admin, `M` = maintainer, `C` = contributor, `V` = viewer.

| # | Action id | Label (rendered on Policy) | A | M | C | V | Tier notes |
|---|---|---|:-:|:-:|:-:|:-:|---|
| 1 | `view` | View board, tasks & timelines | ✓ | ✓ | ✓ | ✓ | `appWide: true` — **not role-gated**; still membership-gated since R15-4 (`rbac.ts:46-54`). No guard calls `requireAction("view")`. |
| 2 | `comment` | Comment on tasks | ✓ | ✓ | ✓ | ✓ | `appWide: true`. Enforcement is "member of a visible project" (`requireVisibleProject`) + the archived freeze — `appendComment` has **no** role check (`task-actions.server.ts:748-771`). |
| 3 | `create-task` | Create tasks | ✓ | ✓ | ✓ | — | contributor floor |
| 4 | `own-task` | Take / release own task ownership | ✓ | ✓ | ✓ | — | contributor floor; also the **owner-exception predicate** (`ownerException`, §5.3) |
| 5 | `approve-transition` | Approve stage transitions | ✓ | ✓ | — | — | maintainer floor; also gates **task archive/restore** (R14-3) |
| 6 | `resolve-packet` | Resolve decision packets | ✓ | ✓ | — | — | maintainer floor; also apply/dismiss recommendation |
| 7 | `accept-completion` | Accept completion → Done | ✓ | ✓ | — | — | maintainer floor; owner exception widens it per-task |
| 8 | `update-goal` | Edit the task goal | ✓ | ✓ | — | — | maintainer floor |
| 9 | `run-agents` | Run agents | ✓ | ✓ | — | — | maintainer floor; assign/run/interrupt/schedule + manual delivery |
| 10 | `reorder-board` | Reorder the board | ✓ | ✓ | — | — | maintainer floor; pinned to the same tier as `approve-transition` by a test (`policy-rbac.server.test.ts:440-453`) |
| 11 | `reconcile-github` | Reconcile GitHub state | ✓ | ✓ | — | — | maintainer floor (R8-4 raised it from contributor+) |
| 12 | `grant-github-scope` | Grant GitHub scope | ✓ | ✓ | — | — | maintainer floor; also set/clear the project credential |
| 13 | `rescan-project` | Re-scan project files & projections | ✓ | ✓ | — | — | maintainer floor; project-scoped only (F20) |
| 14 | `release-any-ownership` | Release any task owner | ✓ | — | — | — | admin only |
| 15 | `manage-members` | Manage members & roles | ✓ | — | — | — | admin only |
| 16 | `manage-agents` | Manage agent profiles | ✓ | — | — | — | admin only |
| 17 | `edit-policy` | Edit workflow & policy | ✓ | — | — | — | admin only; identity/stages/repo/archive/delete + boundary changes |
| 18 | `force-accept-completion` | Force-accept past the review gate | ✓ | — | — | — | admin only, **DG-2** audited escape hatch (`rbac.ts:73-77`) |

**Monotonicity invariant.** Every set is a *rank floor* — if a role holds an action, every higher role
does. Asserted for **all** rows, derived from `RBAC_DEFINITIONS` so a new row is covered the day it
lands: `app/features/policy/policy-rbac.server.test.ts:175-193`.

### 2.2 `appWide`

`appWide: true` means **not role-gated** (every project role holds it, viewer included). Since R15-4 it
does *not* mean "membership not required" — `app/shared/rbac.ts:46-54`. The Policy table renders those
two rows as app-wide rather than as role columns: `app/features/policy/policy-data.ts:22-25,27-36`.

### 2.3 Archive semantics (two different archives)

| Kind | Flag | Authority | Effect |
|---|---|---|---|
| **Project archive** (R6-3) | `project.md` frontmatter `archived` | `edit-policy` (admin) — `settings-actions.server.ts:732-748` | **Read-only freeze.** `requireProjectMutable` (`project-authority.server.ts:131-142`) throws 409 `"This project is archived (read-only) — restore it before you …"` on *every* governed mutation. Reads and audit stay open. |
| **Task archive** (R14-3) | task frontmatter `archived` | `approve-transition` (maintainer+) — `task-actions.server.ts:3823-3835` | A **disposition**, not a delete: file + timeline survive, task leaves the board default view and the review queue, open packet + pending recommendations are withdrawn, reversible. |

Project-archive gate placement (this ordering matters — it produces a **409, not a 403**, even for an
admin):
- `requireAction` calls `requireProjectMutable` *before* the role check — `task-actions.server.ts:303-317`.
- `assertProjectAction` likewise, unless `allowArchived` — `project-authority.server.ts:329-336`.
- `requireRunAgents` likewise (F17) — `project-authority.server.ts:266-280`; `canRunAgents` returns
  `false` outright on an archived project (`:291`).
- `appendComment` calls it explicitly because commenting is not role-gated —
  `task-actions.server.ts:766-770`.
- Exemptions that pass `allowArchived: true`: project restore (`setProjectArchived` with
  `allowArchived: !input.archived`, `settings-actions.server.ts:745-747`), project delete
  (`settings-actions.server.ts:788-790`), and every route READ gate.
- Pinned by test: `policy-rbac.server.test.ts:279-306` (R8-5 — admin gets `/archived/i` on
  `grant-github-scope` and `reconcile-github`).

### 2.4 Specialist-cap and ALWAYS_HUMAN (agent capability policy — a *separate* layer)

Agent authority is **not** `ACTION_ROLES`. It is the capability catalog in `app/shared/capabilities.ts`
(`UNIFIED_CAP_CATALOG`, `:33-105`), stored per agent deployment as `{ capabilityId, mode }` with
`mode ∈ direct | recommend | human | off` (`project-file.schema.ts:34`).

**ALWAYS_HUMAN** — three structural locks that no agent may ever hold in an actionable mode:

`app/shared/capabilities.ts:160-166`
```
ALWAYS_HUMAN_CAPABILITY_IDS = ["merge-pull-request", "transition-to-done", "change-project-policy"]
```

Enforcement points:
| Layer | Ref | Behavior |
|---|---|---|
| **Write** (profile save) | `app/features/agents/agent-profile-actions.server.ts:149,185` and `:239` | Whatever the form submits, `mode = "human"`. "no write path can persist an always-human grant an agent could act on" (`:153-158`). |
| **Runtime** (tool policy) | `app/server/tasks/specialist-tool-policy.ts:45,141` | `isWithheld()` returns `true` unconditionally for these ids → the mapped tools land in `disallowedTools`. |
| **Metadata** | `app/shared/capabilities.ts:226-234` | `capabilityEnforcement()` checks ALWAYS_HUMAN **before** the claude-only set so `merge-pull-request` is never mislabeled "advisory on Codex". |
| **Display** | `app/features/policy/policy-data.ts:64-76` | Rendered from the server invariant list, with the one honest exception noted (`transition-to-done` is reachable by an operator at **full** autonomy holding an explicit `completion-for-acceptance: direct` — `capabilities.ts:40-48`). |

**Specialist cap** — specialists have no `recommend` mode:
`app/shared/capabilities.ts:279-282` `coerceSpecialistCapabilityMode(mode) = mode === "recommend" ? "direct" : mode`.
Applied at `agents-query.server.ts:285`, `agent-profile-actions.server.ts:182,252,431`,
`specialist-run.server.ts:1888`. Exception: `report-validation-verdict` is **explicit-`direct`-only** and
must NOT run through the specialist coercion (`agent-profile-actions.server.ts:172-179`) — anything
other than `direct` persists `off`.

Other polarity rules a future agent will trip on:
- `capabilities: []` is **not** "no powers" — an unspecified capability reads as GRANTED at the tool
  layer, which is why every creation path materializes explicit grants
  (`capabilities.ts:107-123`, `agent-profile-actions.server.ts:200-262`).
- `applyVerdictOutcomeGate` (`capabilities.ts:263-277`): a verdict outcome (`approve-review`,
  `request-changes`, `post-quality-flags`) renders as not-granted unless
  `report-validation-verdict === "direct"`.
- `repairDeliveryGrants` (`capabilities.ts:324-366`): an **absent** `execute-code-or-write-repo`
  headline is materialized `direct` when scoped delivery grants are actionable; an **explicit** `off`
  is respected and reported (B-AG1). The enforcement layer never overturns an explicit withholding —
  `specialist-tool-policy.ts:117-134`.
- `absentDeliverReviewPrMode(humanGatedBeforeWork)` (`capabilities.ts:397-401`): an absent
  `deliver-review-pr` grant resolves to `recommend` on a human-gated-before-work project, else `direct`
  (R15-9).

---

## 3. Enforcement paths

### 3.1 The one authority resolver

**`app/server/auth/project-authority.server.ts` is the only place membership + role are resolved.**
`:9-34` states the contract: membership role vs `ACTION_ROLES`, the D2 org-admin override, and the
P13-D-8 denial audit.

```
resolveProjectAuthority(db, project, actor, allowed, audit) : AuthorityDecision   :167-231   (non-throwing)
requireProjectAuthority(...)                                : ProjectAuthority    :238-255   (throws 403)
requireRunAgents(db, project, actor, what)                  : ProjectAuthority    :266-280   (archived gate + run-agents)
canRunAgents(db, project, actor, what)                      : boolean             :284-300   (silentDeny)
assertProjectAction(db, action|"any-member", slug, actor, …) :310-363   (reads project.md fresh)
requireProjectMutable(project, what)                        :131-142   (R6-3 409)
isOrgAdmin(db, userId)                                      :147-153   (users.role, disabled = 0)
```

Decision order in `resolveProjectAuthority`:
1. `memberRole` satisfies `allowed` (or `allowed === "any-member"`) → **allow under their own role**, `isOrgAdminOverride: false` (`:174-180`).
2. else `isOrgAdmin` → **allow as `role: "admin"`, `isOrgAdminOverride: true`**, and audit
   `project.org_admin.override` unless the action is `"any-member"` (`:181-204`).
3. else **deny**, audit `project.authority.denied` unless `silentDeny` (`:206-230`).

403 copy (`:249-254`): non-member → `Only project members can ${what}.`; below-tier member →
`Your project role (${memberRole}) cannot ${what}.`
`assertProjectAction`'s copy is config-surface shaped (`:356-362`): `Only project ${label} can ${what}.`
where `label` is `"members"` / `"admins"` / `"members with the right role"`.

**Denial audit dedupe:** identical `(actor, project, action)` denials collapse inside a 60 s window,
keyed per `DatabaseSync` handle, max 500 tracked — `:95-119`. Reason: polled resource routes
(run-log, session-export) would otherwise write a row per poll.

### 3.2 The task-mutation guard

`app/server/tasks/task-actions.server.ts`
- `requireAction(db, project, actor, action, what)` — `:303-317`. Archived gate first, then
  `requireProjectAuthority(…, rolesForAction(action))`. Returns the **effective** role.
- `requireAnyMember(...)` — `:290-300`.
- `ownerException(project, actor, ownerUserId)` — `:319-330`: the live owner **who also holds
  `own-task`**. A demoted viewer-owner does not qualify.
- `requireAcceptCompletion(...)` — `:332-343`: owner exception, else `accept-completion` (R6-2).
- `requireDecisionAuthority(...)` — `:345-370`: owner exception, else `resolve-packet` (R14-2).

Every governed mutation and its action id:

| Function (`task-actions.server.ts` unless noted) | Line | Action |
|---|---|---|
| `createTask` | `:445` | `create-task` |
| `updateTaskGoal` | `:537` | `update-goal` |
| `appendComment` | `:766` | *(none — archived gate only)* |
| `setOwner` | `:2795` | `own-task`; hand-off additionally needs owner **or** `release-any-ownership` (`:2813`), and the target must hold `own-task` (`:2817`) |
| `releaseOwner` | `:2907` / `:2910` | own seat → `own-task`; someone else's seat → `release-any-ownership`; no-owner no-op → `any-member` (`:2900`) |
| `transitionStage` | `:3056` / `:3068` | manual move → `approve-transition`; declared `approval` boundary → `approve-transition`; `auto` boundary crossed by a human → any-member (`:3060`); `human` boundary → `requireAcceptCompletion`; terminal stage reached non-manually → routed into `acceptCompletion` (`:3024-3035`) |
| `manualDeliverForReview` | `:3531` | owner exception, else `run-agents` (R15-2 safety net b) |
| `reorderTask` | `:3735` | `reorder-board` |
| `setTaskArchived` | `:3830` | `approve-transition` (R14-3) |
| `resolvePacket` | `:3996` | `resolve-packet` (via `requireDecisionAuthority`); the `archive_task` option re-checks `approve-transition` inside the case (`:4230`) |
| `forceAcceptCompletion` | `:4980` | `force-accept-completion` |
| `completeTaskMerge` | `:5043` | `requireAcceptCompletion` |
| `applyRecommendation` | `:5118` | `resolve-packet` via `requireDecisionAuthority`; inner mutation keeps its own tier (`:5143-5148`) |
| `dismissRecommendation` | `:5286` | `resolve-packet` via `requireDecisionAuthority` |
| `assignSpecialist` / `assignReviewer` / `startAgentRun` | `specialist-run.server.ts:281,418,586` → `runtimeAuditActor:1729-1739` → `requireRuntimeRole:1747-1780` | `run-agents` |
| `removeReviewer` | `specialist-run.server.ts:534` | `run-agents` |
| run interrupt | `app/server/runtimes/run-service.server.ts:816` | `run-agents` |
| @mention agent trigger | `task-actions.server.ts:1394` → `canRunAgents` | `run-agents`, **silent deny** (comment kept, run skipped) |

Config surfaces (all via `assertProjectAction`):

| Surface | Ref | Action |
|---|---|---|
| Project identity / stages / repo / archive / delete | `app/features/project-settings/settings-actions.server.ts:73-85` | `edit-policy` |
| Membership CRUD (invite/remove) | `settings-actions.server.ts:612,662` | `manage-members` |
| Member role change | `app/features/policy/policy-actions.server.ts:96-105` | `manage-members` |
| Workflow boundary change | `policy-actions.server.ts:185` | `edit-policy` |
| Agent profile CRUD | `app/features/agents/agent-profile-actions.server.ts:111-125` | `manage-agents` |
| Board rescan | `app/routes/project.board.tsx:78` | `rescan-project` (scoped to `params.slug`, F20) |
| GitHub reconcile | `app/routes/project.github.tsx:53` | `reconcile-github` |
| GitHub credential grant/set/clear | `app/routes/project.github.tsx:57,63`, `project.settings.tsx:165,172` | `grant-github-scope` |
| Route READ gate (all config surfaces) | `app/server/auth/require-project.server.ts:30-37` | `"any-member"` |
| Route ACTION visibility gate | `app/routes/project-visibility.server.ts:35` | `"any-member"` → 404 |

Org-level (not project RBAC): `requireRole(request, "admin")` at `app/routes/org.settings.tsx:71`
(loader) and `requireRoleAuth(request, "admin")` at `:104` (action); global rescan / rebuild-projections
inline org-admin checks at `app/routes/_index.tsx:96-103,125-133`. **Project creation is deliberately
self-serve for any signed-in user** — `app/routes/_index.tsx:155-160` ("Org role is intentionally NOT
consulted here"), creator seeded as project admin.

### 3.3 UI capability reflection ("RBAC honesty")

Rule of the codebase: the UI must consult **the same action id** the server enforces via `roleCan`,
never a role literal. Two live comments state it: `app/routes/project.board.tsx:95-98` (UI-58) and
`app/features/task-detail/task-detail-page.tsx:330-331` ("no aspirational copy that the server would
403").

**No client-only gate exists** — every UI capability flag traces to a server guard. The full call-site
inventory (H = hidden when denied; D+ = disabled **with visible text**; D− = disabled with only a
`title`; N/A = data filter, not a control):

| UI site | Action | Denied | Server counterpart |
|---|---|:-:|---|
| `app/routes/project.board.tsx:99-102` `canTransition` | `reorder-board` | H (`board-page.tsx:224,234,309,485-493`) | `task-actions.server.ts:3735` |
| `app/routes/project.board.tsx:105` `canRescan` | `rescan-project` | H (`board-page.tsx:770-780`) | `project.board.tsx:78` |
| `app/routes/project.task.tsx:213-216` `canDeliver` | `run-agents` ∥ owner+`own-task` ∥ org admin | H (`task-detail-page.tsx:1679`, `GithubTrace:258-273`) | `task-actions.server.ts:3517-3538` |
| `app/features/policy/policy-page.tsx:525` `canSetRole` | `manage-members` | **D+** (`:160` disabled + note `:107-115`) | `policy-actions.server.ts:98-105` |
| `app/features/policy/policy-page.tsx:526` `canEditPolicy` | `edit-policy` | **D−** (`:461`, no visible reason) | `policy-actions.server.ts:185` |
| `app/features/project-settings/settings-page.tsx:919` `canManageLifecycle` | `edit-policy` | **D+** (`:959,:978` + `.deny-note` `:934-941`) | `settings-actions.server.ts:741,785` |
| `app/features/project-settings/settings-page.tsx:1033` `canGrant` | `grant-github-scope` | **D−** (`:823`) | `project.settings.tsx:165,172` |
| `app/features/agents/agents-page.tsx:933` `canManage` | `manage-agents` | H (`:1103,1116,1171,1192,1198`, `:528,568-583`) | `agent-profile-actions.server.ts:117-120` |
| `app/features/github/github-view.tsx:370` `canReconcile` | `reconcile-github` | H + handler early-return `:372` | `project.github.tsx:56` |
| `app/features/github/github-view.tsx:389` `canGrant` | `grant-github-scope` | H (`:408-419,:433`) | `project.github.tsx:60,66` |
| `task-detail-page.tsx:337/346/355` | `own-task`/`accept-completion`/`run-agents` | N/A — permission-panel copy | — |
| `task-detail-page.tsx:965` `canTransition` | `approve-transition` | H (stage chip `:1000-1019`; archive block `:1127-1145`) | `task-actions.server.ts:3056,3068,3830` |
| `task-detail-page.tsx:966` `canOwn` | `own-task` | H (`:1047,:1063`) | `task-actions.server.ts:2795,2907` |
| `task-detail-page.tsx:1177` `canInterrupt` | `run-agents` | H | `run-service.server.ts:801-828` |
| `task-detail-page.tsx:1213` `canMerge` | `accept-completion` | H (`GithubTrace:274`) | `task-actions.server.ts:5043` |
| `task-detail-page.tsx:1225-1228` `canForceAccept` | `force-accept-completion` | H (prop undefined ⇒ structurally absent) | `task-actions.server.ts:4980-4986` |
| `task-detail-page.tsx:1409` `canRunAgents` | `run-agents` | H (execution `:900`; schedules `:664,:708`; goal Edit `:583`) | run guards / `:537` |
| `task-detail-page.tsx:1418` `canResolvePacket` = `canRunAgents ‖ isOwner` | `resolve-packet` + owner | H (`decision-packet.tsx:247,284`) | `task-actions.server.ts:367,3996` |
| `task-detail-page.tsx:1424` `canDecideOwned` | acceptance + owner | **D−** for the `accept_completion` option (`decision-packet.tsx:276-305`); H for Apply/Dismiss (`operator-recommendations.tsx:95-117`) | `task-actions.server.ts:343,4723-4724` |
| `task-detail-page.tsx:1430-1433` `canArchiveViaPacket` | `approve-transition` | D− radio (`decision-packet.tsx:183-206`, `aria-disabled` so the title *does* open) + D− Confirm | `task-actions.server.ts:4230-4238` |
| `execution-profile.tsx:96` `canOwn` | `own-task` | **H with a sentence** — "Unowned — a contributor or above can take it" (`:132`); owned ⇒ control `null` (`:154-156`) | `task-actions.server.ts:2907` |
| `execution-profile.tsx:148`, `release-confirm.tsx:53` | `own-task` | N/A — filters hand-off candidates so a viewer is never offered | `task-actions.server.ts:2817` |

Best-in-class honesty to imitate: `execution-profile.tsx:131-133` (hidden control replaced by a
sentence naming the required tier), `settings-page.tsx:934-941`, `policy-page.tsx:107-115`,
`task-detail-page.tsx:1111-1120` ("The reason has to be TEXT, not a `title`").

**Policy page permission table** — `app/features/policy/policy-page.tsx:171-231`. Rows come from
`RBAC_ROWS` (`app/features/policy/policy-data.ts:27-36`, derived from `RBAC_DEFINITIONS`); nothing is
restated. Header columns are `${ROLE_LABEL[r]} · ${counts[r]}` over **live** members only
(`:66-69`, LV-04/UI-29). An `appWide` row renders as one merged `colSpan={ROLE_IDS.length}` cell
(`:187-193`); every other row renders check / `—` per role (`:196-204`). Member-role radios are gated
on `canSetRole` (`:160`) with a visible lock note (`:107-115`); the workflow-boundary radios use the
*separate* `canEditPolicy` (`:526,593`) because `set-role` and `set-boundary` are different matrix rows
(`:519-524`). A client-side last-admin mirror at `:75-80` is explicitly labelled UX sugar. **The
app-wide cell copy is stale — see §7.14.**

**Profile page permission table** — `app/features/profile/profile-page.tsx:438-500`, importing the same
`RBAC_ROWS` (`:12`, doc `:22-27` "never restated"). It ignores `appWide` (`:462-475`), so `view` and
`comment` render as ordinary four-check rows; nothing false is shown, but the app-wide distinction is
lost. Role resolution is server-side and validated against `ROLE_IDS`
(`app/features/profile/profile-query.server.ts:4,85`).

**Task-page permission panel** — `task-detail-page.tsx:327-362` renders per-row copy straight off
`roleCan(r, …)`, including the owner exception on acceptance (`:346-350`).

**Non-RBAC visibility gate on the same page:** `runsVisible`
(`app/routes/project.task.tsx:141`) keys on **membership**, not project role; denied ⇒ the agent-logs
panel is replaced by an explanatory panel (`task-detail-page.tsx:1643-1655`) and no SSE stream is
opened (`:1502-1504`). See §7.2 — this branch is now unreachable.

**Server-side gate with no UI counterpart (correct direction):** `commentToAgent` silently downgrades an
`@agent` mention to a plain comment for a below-tier commenter; the composer is never gated and the
honesty lives in the toast — `app/routes/project.task.tsx:332-333`
`"Comment posted · your role can't trigger agent runs"`.

### 3.4 D2 org-admin emergency override

An org admin whose *membership* role would be denied (non-member, or a member below tier) is granted
project-admin-equivalent authority, and **every such grant is audited**.

- Grant + audit: `project-authority.server.ts:181-204` → `recordAudit({ action: "project.org_admin.override", details: { action, what, projectSlug, memberRole } })`.
- **Not** audited for `"any-member"` (route READs) — `:182-188`, otherwise an org-admin non-member
  wrote a row per page load (F7 audit noise). The override *flag* is still returned so the UI can show
  the honest pill.
- An org admin acting within a sufficient membership role is **not** an override (no row) —
  pinned at `policy-rbac.server.test.ts:389-408`.
- UI: `app/routes/project.tsx:66-76` computes `orgAdminOverride = memberRole === null && user.role === "admin"`,
  sets `myRole = "admin"` for the shell, and the topbar shows an override pill.
- Every action in the matrix is driven as an org-admin non-member by
  `policy-rbac.server.test.ts:135-149` and must both **allow** and **write a row**.

### 3.5 Member-scoped decision counts (R8-3 / R14-2)

Two projections answer "does this need *me*", both keyed off `ACTION_ROLES` rather than a project-wide
enum.

**`app/server/projections/decisions.server.ts`** — `decisionsRequiring(db, userId, opts)`:
- `:163` `canGovern = roleCan(role, "resolve-packet")` — maintainer+ can act on any open decision.
- `:169` `ownerCanAct = ownerUserId === userId && roleCan(role, "own-task")` — R14-2, the owner governs
  every open decision on their own task.
- `:170-181` classification: `mine` when either holds; else `overrideEligible` when the viewer is an
  org admin (reachable only through the audited D2 override); else nothing.
- Acceptance-ready rows are unioned in from `task_projections` (`:130-146`) so an acceptance with no
  packet still counts.

**`app/server/projections/review-queue.server.ts`** — `getReviewQueue(db, slug, { viewerUserId })`:
- `:131-132` `viewerCanGovern = roleCan(viewerRole, "resolve-packet")`, `viewerCanOwn = roleCan(viewerRole, "own-task")`.
- `:139-144` `canAccept(key)`: unscoped → true; maintainer+ → true; else owner-of-that-task with
  `own-task`.
- `:150-155` `isReady` additionally requires `waiting === "human"`, no `blockReason`, and
  `pr.state !== "closed"`.

**The board/rail union (UI-48)** — `app/routes/project.tsx:88-105`: `waitingOnMe` is the union of
`decisionsRequiring(...).mine` and `getReviewQueue(...).ready`, derived into *fresh* task objects so one
viewer's annotation can never leak into another's board.

**Home cards** — `app/features/home/home-query.server.ts:104-118`: `waiting` (personal) and
`overrideWaiting` (org-admin-override-only) are separate counters per project.

### 3.6 Admin force-accept (DG-2)

`forceAcceptCompletion` — `app/server/tasks/task-actions.server.ts:4973-5027`:
1. `requireAction(…, "force-accept-completion", "force-accept past the review gate")` (`:4980-4986`).
2. Already-Done → return, **no misleading audit row** (`:4990-4996`).
3. Re-derives the exact gate being bypassed with the **same** `acceptanceRefusalReason` helper the gate
   uses, so the audit can never name a stale reason (`:4997-5008`).
4. `recordAudit({ action: "task.acceptance.forced", details: { bypassed } })` (`:5009-5017`).
5. Delegates to `acceptCompletion(..., { force: true })` (`:5018-5023`), which sets
   `skipInLockRecheck` (`:4953`).

**What force-accept can and cannot bypass:** it bypasses the required-reviewer gate, the R15-1 verdict
gate, blocked packets, the graph-position gate and the conflicting-PR gate. It can **never** bypass the
PR-head-mismatch check — `acceptancePrHeadMismatch` is documented as "the ONE acceptance gate
force-accept can NEVER bypass" (`task-actions.server.ts:4586-4592`).

Route: `app/routes/project.task.tsx:483-492` (intent `force-accept`, after `requireVisibleProject` at
`:312`); toast `"Force-accepted {key} — moved to Done (review gate overridden)"`.

UI flow (the affordance is **structurally absent** for a non-admin — `onForceAccept` is `undefined`,
not a disabled button):
1. `task-detail-page.tsx:1225-1237` — `canForceAccept = roleCan(myRole, "force-accept-completion")`.
2. `:1676-1678` — the prop is spread onto `GithubTrace` only when defined, and opens a confirm rather
   than submitting.
3. `GithubTrace:99-128` — reason derivation `:103-107`; the row renders **only** when
   `forceAcceptReason && onForceAccept` (`:109`); visible text `"Acceptance is blocked: {reason}"`
   (`:113-115`) then a ghost button *"Force accept (override review gate)"* whose `title` says
   "Admin override … Audited." Rendered in **both** the no-PR empty panel (`:139`) and the normal panel
   (`:287`) so a pre-work wedge is still escapable (`:99-102`).
4. Confirm dialog `task-detail-page.tsx:1706-1730` → `app/features/task-detail/accept-confirm.tsx`:
   force mode adds a **"Bypassing"** row naming the exact refusal (`:103-108`), the foot hint
   *"Admin override — the bypassed gate is recorded to the audit log."* (`:113-114`) and a `btn danger`
   (`:125-132`). The dialog always states PR → target branch, delivered revision sha and verdict
   (`:73-102`).

Copy that *points at* the hatch: `task-actions.server.ts:4547` and
`app/server/projections/rebuilder.server.ts:306` ("… or an admin can force-accept."). The
not-at-the-boundary refusal deliberately does **not** mention it (`task-actions.server.ts:4514-4522`).
Activity-feed rendering: `app/server/projections/activity-feed.server.ts:268-269`.
Tests: `policy-rbac.server.test.ts:195-206`,
`app/features/task-detail/task-detail-components.test.tsx:825-880` ("shows NO force-accept control for
a non-admin").

---

## 4. Auth

### 4.1 better-auth integration

- Sole config: `app/lib/auth.server.ts` (`buildAuthOptions` `:112-314`, `createAuth` `:316-318`,
  `getAuth()` singleton `:332-368` keyed to the current `DatabaseSync` handle).
- **No better-auth plugins are registered.** Adapter is raw `node:sqlite` — `:139` `database: deps.db`.
- Secret: `:344` `env.BETTER_AUTH_SECRET ?? env.VIBERR_SESSION_SECRET`. Cookie prefix `:312`
  `advanced: { cookiePrefix: "viberr" }` → cookie `viberr.session_token`.
- Sessions: `:247-250` `expiresIn` 30 d, `updateAge` 1 d (rolling).
- Password hooks: `:159-162` delegate to `app/server/auth/password.server.ts`.
- `databaseHooks` `:271-311`: `user.create.before` (whitelist gate), `user.create.after`
  (`applyOAuthUser`), `account.create.after` (`linkOAuth`).
- Social providers `:113-135` (github scopes `read:user`,`user:email`; google offline+consent), wired
  only when env creds exist (`:349-362`). Account linking `:259-267`.
- Tables owned by better-auth: `user`, `session`, `account`, `verification` —
  `db/migrations/0001_baseline.sql:298-301` (indexes `:345-347`). The app's canonical profile/RBAC row
  is the separate `users` table (`:23-34`). **Identity invariant:** better-auth `user.id` === `users.id`
  (`app/lib/auth.server.ts:22-24`, `app/server/auth/identity.server.ts:8-11`).
  `verification` is created but never read/written by app code.
- Mount: `app/routes.ts:11-13` `route("api/auth/*", "routes/api.auth.$.ts")`;
  `app/routes/api.auth.$.ts:11-17` forwards both loader and action to `getAuth().handler(request)`.
  Base path `app/lib/auth.server.ts:35` `AUTH_BASE_PATH = "/api/auth"`.

### 4.2 The `/api/auth` splat allow-list (P11-02)

`app/lib/auth.server.ts:53-60` — verbatim:

```ts
export const ALLOWED_AUTH_PATHS = new Set<string>([
  "/sign-in/email",   // app login form
  "/sign-in/social",  // OAuth start (login page buttons)
  "/callback/:id",    // OAuth provider redirect back
  "/error",           // Better Auth's OAuth-failure landing page
  "/get-session",     // session resolution (require-user, on every request)
  "/sign-out",        // logout route
]);
```

Enforced in the `before` `createAuthMiddleware` — `:218-220`:
`if (!ALLOWED_AUTH_PATHS.has(ctx.path)) throw new APIError("NOT_FOUND", { message: "Not found." });`

**Why an allow-list, not a deny-list** (`:37-52`): the splat exposes every built-in better-auth
endpoint. `/change-password` would bypass the app's audited, session-revoking flow; `/update-user`
would write better-auth's `user.name` only and split-brain the canonical `users` row. Enumerating the
blocked set rots as better-auth adds endpoints; enumerating the driven set cannot. Entries are the
**declared** endpoint paths (params un-substituted — hence the literal `/callback/:id`), and the list
must cover server-side `auth.api.*` calls too (`get-session`, `sign-out`).

Pinned by `app/lib/auth.server.test.ts:59-71` (exact six), with live 404 assertions for `/update-user`
(`:82-89`) and `/forget-password` (`:91-97`).

Same middleware also carries the login/social rate limits (`:221-230`, `:236-244`) precisely because a
direct `POST /api/auth/sign-in/email` bypasses the app's login action; better-auth's own IP-keyed
limiter is disabled per-path at `:184,191` (shared-bucket denial-of-login).

**Sign-up is closed three ways:** no route in `app/routes.ts`; `disableSignUp: true`
(`app/lib/auth.server.ts:144-148`); `/sign-up/email` absent from the allow-list. Identities arrive via
the seed admin, org-users invite/whitelist, or the OAuth provisioning hook
(`app/server/auth/oauth-provision.server.ts:68-88`, where the Google **domain allowlist** is
Google-only and the provider is threaded explicitly via `oauthProviderOf`, failing closed on `null`).

### 4.3 Session handling

`app/server/auth/require-user.server.ts`
- `authenticateWithHeaders` `:77-101` — `getAuth().api.getSession({ headers, returnHeaders: true })`;
  `returnHeaders` exists so the rolling-session `Set-Cookie` reaches the browser (F10-17; forwarded at
  `app/root.tsx:63,76-89`).
- `authenticate` `:114-118`, `requireAuth` `:154-164`, `requireUser` `:167-172`.
- **Disabled/vanished user** `:87-91`: the better-auth `session` row is deleted on the spot and the
  request reads as signed out. Admin disable also calls `revokeUserSessions`
  (`app/server/auth/user-admin.server.ts:153-161`; `identity.server.ts:138-145`).
- **Unauthenticated → redirect**, not 401: `loginRedirect` `:128-146` builds
  `/login?returnTo=…`, stripping React-Router single-fetch `.data` suffixes and `_routes`;
  `safeReturnTo` `:121-126` rejects `//` and `/\`. The SSE route is the exception — JSON 401,
  `app/routes/resources.events.ts:62-69`. `resources.health.ts:10` is unauthenticated by design.
- **Forced password reset:** `pwreset_required` redirects everything to `/login` unless the caller
  passes `allowPendingPasswordReset` (`:148-162`; used by `app/routes/login.tsx:121`).
- **Org role gate:** `requireRole` `:201-208` / `requireRoleAuth` `:215-222` → 403 JSON
  `{ error: { code: "forbidden", message: "This area requires the admin role." } }` (`:184-198`).
- `AuthContext` `:37-45`: `sessionId` is "safe to log, keys the CSRF token"; `sessionToken` is
  "logout only. Never log."

### 4.4 CSRF — the `_csrf` convention

`app/server/auth/csrf.server.ts`
- `:15` `CSRF_FIELD_NAME = "_csrf"`.
- **Derivation, not storage** — `:18-22`
  `HMAC-SHA256(VIBERR_SESSION_SECRET, "viberr-csrf:" + sessionId).digest("base64url")`. Deterministic
  per session; nothing is persisted. Wrapper `getCsrfToken(sessionId)` `:25-27`.
  (Note the CSRF secret is `VIBERR_SESSION_SECRET`, *not* `BETTER_AUTH_SECRET`.)
- **Into the page:** root loader `app/root.tsx:73` `csrf: auth ? getCsrfToken(auth.sessionId) : null`;
  `<CsrfInput />` at `app/ui/csrf-input.tsx:10-17`. Programmatic fetchers do `fd.set("_csrf", csrf)`
  (~50 sites across `app/features/**`).
- **Validation** `:72-97`: `assertTrustedOrigin` first, then `X-Csrf-Token` header else the `_csrf`
  field, then `timingSafeEqual` with a length pre-check.
- **Origin check** `:46-69`: rejects `Sec-Fetch-Site` other than `same-origin`/`none`, cross-origin
  `Origin`, and `Origin: null`. Requests with **neither** header (curl, server-to-server) pass — the
  token is the backstop (`:41-45`).
- **Failure** `:29-38` → thrown `Response` 403 `{ error: { code: "forbidden", message } }`;
  messages `"Missing CSRF token."` / `"Invalid CSRF token."` / `"Cross-site request rejected."` /
  `"Cross-origin request rejected."` / `"Opaque-origin request rejected."`.
- **The wrapper every project action uses:** `app/server/auth/form-action.server.ts:7-19`
  `requireFormAction(request)` = `requireAuth` → `getDb` → `request.formData()` → `assertCsrf` →
  `{ auth, db, formData, actor, intent }`. Callers: `_index.tsx:72`, `project.agents.tsx:88`,
  `project.board.tsx:23`, `project.github.tsx:42`, `project.policy.tsx:39`, `project.settings.tsx:56`,
  `project.task.tsx:305`. **Any new form action must go through this or it has no CSRF.**
- **Exceptions:** `/api/auth/*` has no app CSRF (better-auth's own Origin/trustedOrigins check —
  `app/routes/api.auth.$.ts:8-9`); the login action uses `assertTrustedOrigin` only, since there is no
  session yet (`app/routes/login.tsx:57`), while its `set-password` intent does assert full CSRF
  (`:122`); fetcher-shaped failures are converted to a returned `{ ok:false }` 403 by
  `app/features/shell/csrf-result.server.ts:19-40` (UI-32) — used by `notifications.read.tsx:31` and
  `prefs.theme.tsx:26`.

### 4.5 Legacy scrypt — fully removed

Current hashing is 100 % better-auth: `app/server/auth/password.server.ts` (24 lines) re-exports
`hashPassword` from `better-auth/crypto` and wraps `verifyPassword` in a total try/catch
(`:10-20`) so a legacy hash yields `false` (→ 401) instead of an unhandled 500 on the splat.

The only remaining accommodation is a **detector**, not a verifier:
`app/server/auth/identity.server.ts:111-122` `isBetterAuthPasswordHash(hash)` =
`/^[0-9a-f]+:[0-9a-f]+$/i`. The pre-better-auth shape was `scrypt$N$r$p$salt$key`; the seed uses the
detector to re-hash such a credential back into a working state
(`app/server/seed/seed.server.ts:144-170`, P11-01). History: the hand-rolled `scryptSync`
implementation lived in `password.server.ts` up to `0d4e8d4`; `745e19d` removed the hand-rolled
sessions/OAuth; `cf49bd1` replaced the scrypt implementation with the better-auth wrapper — no
dual-verify/migrate-on-login shim was ever added.

Stale "scrypt" comments remain at `app/server/auth/identity.server.ts:32,36` and
`app/features/profile/profile-actions.server.ts:117` (see §7).

---

## 5. Governance flows

### 5.1 Who transitions stages

`transitionStage` — `app/server/tasks/task-actions.server.ts:2949+`, guard block `:3036-3080`:

| Path | Guard |
|---|---|
| Terminal stage reached without `operatorAuthorized` | routed into the full `acceptCompletion` contract (`:3024-3035`) — never a bare transition |
| `ctx.operatorAuthorized` | human RBAC skipped (operator's capability policy gates upstream); terminal stage explicitly refused: *"The operator reaches Done only by accepting completion, not a bare transition."* (`:3037-3046`) |
| `input.manual` (board/task dropdown) | `approve-transition` — forward, backward, or off-graph alike (`:3056`); **R15-3**: `recommendationAuthorized` (owner clicked Apply) relaxes it to the archived-freeze check only (`:3053-3055`) |
| declared `auto` boundary crossed by a human | `requireAnyMember` (`:3060`) — unreachable from the UI, which always sends `manual: true` |
| declared `approval` boundary | `approve-transition` (`:3068`), same R15-3 relaxation (`:3063-3067`) |
| declared `human` boundary (review→done, locked in V1) | `requireAcceptCompletion` — maintainer+ **or** the task owner (R6-2) (`:3071-3079`) |

Stage roles are **derived**, never hardcoded: `app/shared/workflow/stage-roles.ts:39-67`
(`entry` = index 0, `terminal` = last, `review` = the stage with an edge into terminal, `work` = the
stage with an edge into review). Nothing in the app may test `stage === "done"` (`:5-11`).

Boundary policy edits: `setTransitionBoundary` (`app/features/policy/policy-actions.server.ts:179-234`)
requires `edit-policy` and **hard-rejects** `rule.locked` or any non-`human` boundary into the final
stage (`:210-212`) with `"Completion is human-authorized in V1 — this boundary can't be delegated"`
(`:170-171`). Stage add/remove/rename own the transition chain
(`settings-actions.server.ts:37-47`, `app/shared/workflow/transitions.ts`); locked stages are the entry
and terminal (`stage-roles.ts:30-37`).

### 5.2 Who reviews — verdict-gated acceptance

Review authority is per-task, carried on **engagements** in the task file:

- `engagementSchema` — `app/schemas/task-file.schema.ts:107-122`: `{ profileId, role, backend, delivers, verdictCapable, … }`. At most one engagement has `delivers: true` (the workspace/branch/PR owner) — `:100-106`, demotion enforced at `:820-833`.
- `deliveringEngagement` `:128`, `supportingEngagements` `:135`, `requiredReviewers` `:510-512`
  (`!delivers && verdictCapable`).
- `verdictCapable` is an **engage-time snapshot** of the profile's `report-validation-verdict` grant —
  `specialist-run.server.ts:361,481`. Verdict *recording* must read the same snapshot, or a live-grant
  read would let a removed grant leave a task permanently unacceptable
  (`task-actions.server.ts:2240-2257`).
- Verdicts bind to the **current work revision**: `currentVerdicts` `:514-522`; recording
  `task-actions.server.ts:1894-1920` (last-write-wins per profile per revision).
- `deriveValidation` `:527-545`: `failing` if any required reviewer requested changes on the current
  revision; `healthy` when every required reviewer approved it; `changed` while pending; `none` before
  delivery.

**The acceptance gate chain** — `acceptanceRefusalReason(project, fm, taskKey, { blockedPacket })`,
`task-actions.server.ts:4559-4581`, in order:
1. `archivedTaskBlockedReason` (R14-3)
2. `acceptanceStageBlockedReason` (`:4498-4523`) — acceptance may only be exercised **from** the review
   stage or a stage with a declared edge into terminal. Deliberately does not mention force-accept.
3. `acceptanceBlockedReason` (`app/schemas/task-file.schema.ts:553-569`) — every required reviewer must
   have approved the current revision; none may have requested changes.
4. `verdictGateReason` (`task-actions.server.ts:4526-4548`, **R15-1**) — delivered work (`workRevision`
   set) needs a PR *and* `deriveValidation === "healthy"`. Work with no revision stays acceptable
   (planning / non-repo tasks).
5. open blocked packet
6. `closedPrBlockedReason` (`task-file.schema.ts:586-591`) — a PR closed unmerged on GitHub is a
   rejection.
7. `conflictingPrBlockedReason` — a conflicting PR cannot be merged, so it cannot be accepted.

Plus the live GitHub check `acceptancePrHeadMismatch` (`task-actions.server.ts:4586-4643`, R15-1 gate 2
/ F15-15): the PR head must *contain* the delivered revision. Returns `null` when unverifiable
(offline, no PR, already merged). **Force-accept can never bypass this one.**

`resolveAcceptanceAffordance` (`task-actions.server.ts:4699-4749`) is the DB-free read both the task
page and the review queue use: `hasAuthority = roleCan(role, "accept-completion") || (owner && roleCan(role,"own-task"))`
(`:4722-4724`), archived project → no acceptance from any role, already-terminal → nothing to accept.

The operator reuses the identical gate: `operatorAcceptCompletion`
(`app/server/tasks/operator-actions.server.ts:1804-1849`) calls `acceptanceRefusalFor` before **both**
branches, then recommends unless `autonomy === "full"` **and**
`gate(authority, "completion-for-acceptance") === "direct"`.

### 5.3 Owner authority (R6-2 / R14-2 / R15-3)

`ownerException` (`task-actions.server.ts:319-330`) = live owner **and** holds `own-task`
(contributor+). It widens exactly three outer gates:

| Gate | Helper | Ref |
|---|---|---|
| Acceptance (and merge completion) | `requireAcceptCompletion` | `:332-343`, used at `:3071`, `:5043` |
| Packet / recommendation decisions | `requireDecisionAuthority` | `:345-370` (R14-2 rationale in the docblock) |
| Manual delivery | inline | `:3525-3540` |

**It never widens the inner mutation.** `applyRecommendation` (`:5097-5200+`) computes
`asCoordination(needed) = ownerApplied && !roleCan(actorRole, needed)` (`:5143-5144`) and, when true,
re-runs the inner mutation as `OPERATOR_TASK_ACTOR` with `operatorAuthorized: true` (`:5145-5148`) —
"the packet is the human decision; the execution is coordination machinery". The `archive_task` packet
option is the counter-example: it re-checks `approve-transition` *inside* the case
(`:4223-4235`), so a contributor-owner gets an honest 403 rather than a silent widening of R14-3.

### 5.4 Owner packet authority (decision packets)

- `resolvePacket` `:3945+` → `requireDecisionAuthority` at `:3996`.
- Per-option re-checks inside the switch: `archive_task` → `approve-transition` (`:4230`);
  `accept_completion` re-checks its own gate (noted at `:4224-4229`).
- Packet identity/dedupe: `packetIdentity` `:3929-3943`.
- UI mirror: `task-detail-page.tsx:1409-1434` — `canResolvePacket = canRunAgents || isOwner`,
  `canDecideOwned = canRunAgents || isOwner`, `canArchiveViaPacket = roleCan(myRole, "approve-transition")`.

### 5.5 Delivery gates (R15-2)

Delivery = push the task branch + open the review PR. **Agents never push**; the server executes the
mechanics (`performDelivery`, `task-actions.server.ts:3310+`).

Three authorized entry points:
1. **Operator tool** `deliver_for_review` — gated by the `deliver-review-pr` capability
   (`capabilities.ts:49-55`; enforced set `:186-188`; absent-grant resolution
   `absentDeliverReviewPrMode` `:397-401`).
2. **Applied `delivery` recommendation** — the human's Apply click.
3. **Manual button** — `manualDeliverForReview` (`:3517-3556`): owner exception, else `run-agents`;
   audited as `github.delivery.manual` with the honest outcome.

Independently, the *delivering agent's* push grant is re-resolved from its capability profile:
`resolveDeliveryPushGrant` (`:3251-3272`) → `resolveDeliveryPermissions(...).canCommitPush`, with a
conservative **deny** when the profile can no longer be resolved. `DeliveryOutcome`
(`:3278-3296`) names every failure: `push_conflict` (non-fast-forward remote — no PR opened over stale
content), `grant_withheld`, `push_failed`, `nothing_to_review`, `failed`.

UI affordance mirror: `app/routes/project.task.tsx:207-216`
`canDeliver = roleCan(myProjectRole, "run-agents") || user.role === "admin" || (owner && roleCan(myProjectRole, "own-task"))`.

### 5.6 Secondary assignments

Yes — they exist as **supporting engagements** (the old "reviewers"):
- Add: `assignReviewer` (`specialist-run.server.ts:418+`) — `run-agents`, plus `assertStageEligible`.
- Remove: `removeReviewer` (`:528-545`) — `run-agents`.
- Run: `startAgentRun({ profileId })` (`:586+`) — `run-agents`; omitting `profileId` runs the
  delivering engagement.
- Only supporting engagements with `verdictCapable` become **required reviewers** and gate acceptance
  (§5.2).
- Route intents: `assign-reviewer`, `run-reviewer`, `remove-reviewer` —
  `app/routes/project.task.tsx:610,625,644`.

### 5.7 ⌘K palette gating (R15-5)

It is a **search/jump palette, not a command palette** — there are zero per-entry role gates, because
no entry mutates anything.

- Key handler: `app/features/shell/topbar.tsx:66-76` — `(metaKey || ctrlKey) && key === "k"`, global
  `window` listener, no role condition. Trigger button `:156-172`; mount `:175`.
- Component: `app/features/shell/command-palette.tsx` — four hit kinds only (`GROUP_LABEL:19-24`:
  project / task / branch / agent); every row is a navigation target (`go():72-78` → `navigate(hit.href)`).
- Gating is **visibility-scoped, server-side, once**: `app/routes/resources.search.ts:14-24`
  (`requireUser` only; doc `:8-13` — the route deliberately carries no project guard because there is
  no slug in the request) → `app/features/shell/command-search.server.ts:62-63`
  `listHomeProjectsForUser(db, viewer)` is the single scope; `:83-96` binds the task/branch scan to
  `project_slug IN (…)`; `:136-153` scopes agents to the same slugs; `COMMAND_GROUP_LIMIT = 6` (`:34`).
- **Consequence:** an admin and a viewer of the same project get *identical* palette results. Role
  affects nothing in ⌘K; membership affects everything.
- **If a future change adds a mutating command to the palette, it must gate on `roleCan` and the server
  action must still re-check** — nothing in the search path performs an RBAC check today.

---

## 6. Appendix — test matrix (mechanically generable)

### 6.1 The canonical fixture

`test-support/test-store.ts:73-78` — one project `viberr-core`, five users:

| Fixture | Org role | Project role |
|---|---|---|
| `store.users.arda` | `admin` | `admin` |
| `store.users.murat` | `member` | `maintainer` |
| `store.users.selin` | `member` | `contributor` |
| `store.users.elif` | `member` | `viewer` |
| `store.users.deniz` | `member` | *(non-member)* |
| *(create in-test)* | `admin` | *(non-member)* — the D2 override subject (`policy-rbac.server.test.ts:75-84`) |

### 6.2 Expected outcome per (action, role)

`ALLOW` = the guard let the call through (it either succeeded or failed with a **non-403** downstream
error). `DENY` = 403. This is exactly the classifier `guardAllowed()` uses
(`policy-rbac.server.test.ts:62-71`).

| Action id | admin | maintainer | contributor | viewer | non-member | org-admin non-member |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `view` | ALLOW | ALLOW | ALLOW | ALLOW | DENY (404, R15-4) | ALLOW |
| `comment` | ALLOW | ALLOW | ALLOW | ALLOW | DENY (404, R15-4) | ALLOW |
| `create-task` | ALLOW | ALLOW | ALLOW | DENY | DENY | ALLOW + override row |
| `own-task` | ALLOW | ALLOW | ALLOW | DENY | DENY | ALLOW + override row |
| `approve-transition` | ALLOW | ALLOW | DENY | DENY | DENY | ALLOW + override row |
| `resolve-packet` | ALLOW | ALLOW | DENY | DENY | DENY | ALLOW + override row |
| `accept-completion` | ALLOW | ALLOW | DENY | DENY | DENY | ALLOW + override row |
| `update-goal` | ALLOW | ALLOW | DENY | DENY | DENY | ALLOW + override row |
| `run-agents` | ALLOW | ALLOW | DENY | DENY | DENY | ALLOW + override row |
| `reorder-board` | ALLOW | ALLOW | DENY | DENY | DENY | ALLOW + override row |
| `reconcile-github` | ALLOW | ALLOW | DENY | DENY | DENY | ALLOW + override row |
| `grant-github-scope` | ALLOW | ALLOW | DENY | DENY | DENY | ALLOW + override row |
| `rescan-project` | ALLOW | ALLOW | DENY | DENY | DENY | ALLOW + override row |
| `release-any-ownership` | ALLOW | DENY | DENY | DENY | DENY | ALLOW + override row |
| `manage-members` | ALLOW | DENY | DENY | DENY | DENY | ALLOW + override row |
| `manage-agents` | ALLOW | DENY | DENY | DENY | DENY | ALLOW + override row |
| `edit-policy` | ALLOW | DENY | DENY | DENY | DENY | ALLOW + override row |
| `force-accept-completion` | ALLOW | DENY | DENY | DENY | DENY | ALLOW + override row |

The table is **derivable** — do not hand-maintain it. `rolesForAction(action).includes(role)` is the
expectation; `assertMatchesMatrix()` (`policy-rbac.server.test.ts:113-150`) already generates all six
columns for a given driver function.

### 6.3 Driver per action (existing coverage)

| Action | Driver used by the binding test | Ref |
|---|---|---|
| `force-accept-completion` | `forceAcceptCompletion(...)` | `:195-206` |
| `create-task` | `createTask(...)` | `:208-213` |
| `own-task` | `setOwner({ targetUserId: actor.userId })` | `:215-219` |
| `approve-transition` | `transitionStage({ toStageId: "ready", manual: true })` + `resetTaskStage("impl")` | `:221-230` |
| `update-goal` | `updateTaskGoal(...)` | `:232-236` |
| `reorder-board` | `reorderTask(...)` | `:238-242` |
| `resolve-packet` | `dismissRecommendation(recId:"nope")` and `applyRecommendation(recId:"nope")` | `:244-259` |
| `run-agents` | `assignSpecialist(profileId:"does-not-exist")` | `:261-265` |
| `rescan-project` | `assertProjectAction(...)` | `:267-271` |
| `reconcile-github` | `assertProjectAction(...)` | `:273-277` |

**Gaps a test author should fill** (no `assertMatchesMatrix` driver today):
`view`, `comment`, `accept-completion`, `grant-github-scope`, `release-any-ownership`,
`manage-members`, `manage-agents`, `edit-policy`. The last four are exercised for the **override** path
only (`:336-368`), not per-role. Suggested drivers: `acceptCompletion` (reset the task to the review
stage between actors), `assertProjectAction(db,"grant-github-scope",…)`, `releaseOwner` with a foreign
owner, `inviteMember` / `setMemberRole`, `createAgentProfile`, `updateProjectIdentity`.

### 6.4 Additional invariants worth asserting

| Invariant | Existing ref |
|---|---|
| `ROLE_RANK` strictly monotonic | `:169-174` |
| Every `ACTION_ROLES` set is a rank floor (derived from `RBAC_DEFINITIONS`) | `:175-193` |
| Ownership hand-off target must hold `own-task` (a viewer target is rejected) | `:308-330` |
| Archived project → 409 before the role check, even for an admin | `:279-306` |
| Override audits exactly once per governed mutation; `"any-member"` reads audit **zero** rows | `:336-368`, `:369-388` |
| Org admin acting within a sufficient membership role is **not** an override | `:389-408` |
| `reorder-board ⊆ approve-transition` (a drag must not 403 after the visible gate passed) | `:440-453` |

### 6.5 Non-RBAC gates to test alongside

- **Archived project** (409, all roles) and **archived task** (`archivedTaskBlockedReason`).
- **CSRF**: every form action must reject a missing/invalid `_csrf` with 403 (`csrf.server.ts:89,96`).
- **R15-4 secrecy**: a non-member must get **404**, not 403 — on the layout loader, on
  `?_routes=routes/project.task` single-fetch, and on the task/policy actions.
- **Auth allow-list**: `/api/auth/update-user` and `/api/auth/forget-password` must 404
  (`app/lib/auth.server.test.ts:82-97`).

---

## 7. Known asymmetries and suspicious spots

Each item is an observation with a path ref, not a prescribed fix.

**7.1 `rbac.ts` contradicts itself about app-wide reads.**
`app/shared/rbac.ts:17-22` still says view/comment are held by "any *authenticated* user, member or
not", and that "the guards for those do NOT call requireAction". `app/shared/rbac.ts:46-54` — 30 lines
lower, added for R15-4 — says the opposite: projects are members-only and view/comment "reach exactly
as far as the project does". The second block is what the code does.

**7.2 `runsVisible` is dead code and its comment is now false.**
`app/routes/project.task.tsx:125-141` computes `runsVisible = runsMembership.has(user.id) || user.role === "admin"`
and says "the task page is READABLE app-wide by design". Since R15-4 the same loader 404s a non-member
at `:103-109`, so the `false` branch (`:148-156`, the redacted run projection) is unreachable, as is
the `runsVisible={false}` UI path (`:250-251`, `:827`).

**7.3 Four route actions leak project existence with a 403 where two others give 404.**
`requireVisibleProject` was added to the task action (`project.task.tsx:308-312`) and the policy action
(`project.policy.tsx:40-43`) precisely because React Router runs a child action without its parent's
loader. The same argument applies to `project.board.tsx:23` (create-task / reorder / rescan),
`project.agents.tsx:88`, `project.settings.tsx:56` and `project.github.tsx:42`, none of which call it —
their inner guards deny correctly, but with a 403 whose copy confirms the project exists.

**7.4 Hardcoded project-role literals / wrong action ids in the UI (drift hazards).**
The codebase's own rule (UI-58, `project.board.tsx:95-98`) is "consult the action id, not the literal".
Remaining offenders — all behavior-equivalent **today**, all silent breakage the day a tier changes:
- `app/routes/project.board.tsx:94` — `canCreate = layout.myRole !== null && layout.myRole !== "viewer"`
  instead of `roleCan(myRole, "create-task")`. The very comment three lines below calls the literal "a
  standing drift hazard"; this one line was missed. Controls hidden at `board-page.tsx:389,781`.
- `app/features/task-detail/task-detail-page.tsx:1564` and `:1591` — `canEditGoal={canRunAgents}`. The
  server enforces **`update-goal`** (`task-actions.server.ts:537`), not `run-agents`. Both are `[A,M]`
  today. The same substitution reaches `decision-packet.tsx:281` (`goalBlocked`).
- `app/features/task-detail/task-detail-page.tsx:1047` (and `:327`,
  `app/features/task-detail/execution-profile.tsx:92`) — release-other-owner gated on
  `myRole === "admin"` instead of `roleCan(r, "release-any-ownership")`.
- `app/features/project-settings/settings-page.tsx:1032` — `isAdmin = myRole === "admin"` drives
  `ProjectPanel` (`:1071`), `StagesPanel` (`:1082`) **and** `MembersPanel` (`:1121`). The comment
  `:1025-1031` defends the shortcut ("no single action names all three"), but `MembersPanel` maps
  cleanly to `manage-members` (`settings-actions.server.ts:612,665`) and could use `roleCan`.

**7.5 Stale doc comment on `setOwner`.**
`app/server/tasks/task-actions.server.ts:2782-2787` says "any project member may take (all four roles
hold the 'Take / release task ownership' grant)". `own-task` is `[admin, maintainer, contributor]` —
viewers are excluded, and the code itself enforces that two lines later (`:2795-2801`), plus the
hand-off target check at `:2817-2821` and the test at `policy-rbac.server.test.ts:309-332`.

**7.6 The task page's permission panel says comments are open to everyone.**
`app/features/task-detail/task-detail-page.tsx:334` renders `{ k: "Comments", v: "Every registered user" }`
as a fixed string while every other row is derived from `roleCan`. Post-R15-4 the honest scope is
"every member of this project (plus org admins via the override)".

**7.7 `appendComment` has no authorization of its own.**
`task-actions.server.ts:748-771` performs only the archived-project check. Its entire access control is
the caller's `requireVisibleProject` (`project.task.tsx:312`). Any future comment entry point that
forgets that call is unauthenticated-by-membership. Related: `commentToAgent` (`:1029+`) routes the
@mention run through `canRunAgents` with `silentDeny: true` (`:1394`), so a lower-role commenter's
mention is recorded and the run is silently skipped — deliberate (`project-authority.server.ts:293-299`)
but easy to misread as a bug.

**7.8 `verification` table exists but is never used.**
`db/migrations/0001_baseline.sql:301` creates it; no app code reads or writes it. There is no
email-verification or password-reset-token flow — consistent with `/forget-password` being 404'd by the
allow-list, and with the login page's inert "Forgot password?" copy (`app/routes/login.tsx:522-528`).

**7.9 Stale "scrypt" comments.**
`app/server/auth/identity.server.ts:32,36` and `app/features/profile/profile-actions.server.ts:117`
still describe scrypt hashing; the implementation is better-auth's `<saltHex>:<keyHex>`
(`app/server/auth/password.server.ts:1-8`). Only `identity.server.ts:111-122` legitimately mentions the
legacy shape, as a detector.

**7.10 CSRF passes when a request carries neither `Origin` nor `Sec-Fetch-Site`.**
`app/server/auth/csrf.server.ts:41-45,46-69` — by design (curl / server-to-server), with the
double-submit token as the backstop. Worth knowing before writing a test that assumes origin checking
is absolute.

**7.11 The org-admin override reaches *everything*, including `force-accept-completion`.**
`project-authority.server.ts:181-204` grants `role: "admin"` for any action when the member role falls
short. The audited escape hatch (DG-2) is therefore available to any org admin on any project without a
membership, which the binding test asserts as correct behavior
(`policy-rbac.server.test.ts:195-206` + `:134-149`). Not a bug — but it means "admin-only" in §2.1 means
*project admin **or** any org admin*.

**7.12 `resolveAcceptanceAffordance` deliberately skips the audited path.**
`task-actions.server.ts:4697-4698` — "A pure READ … never calls the audited authority path." It
duplicates the role+owner predicate rather than calling `resolveProjectAuthority`. Correct for a loader
(no denial rows on every page load), but it is a second implementation of the same rule and can drift
from `requireAcceptCompletion`.

**7.13 The Policy page's permission table is factually wrong about enforcement — the single-source
design's one live failure.**
`app/features/policy/policy-page.tsx:192` renders the `view`/`comment` rows as
**"Any signed-in user · membership not required"**, and the footnote `:212-231` (the phrase at `:218`)
says every registered
user may read boards/tasks and comment on any task **"member or not"**. `app/shared/rbac.ts:49-53`
explicitly retracts exactly that sentence ("Since R15-4 it does NOT mean 'membership not required'"),
and enforcement agrees with `rbac.ts`: `app/routes/project.tsx:73-76` throws the unknown-slug 404 for a
non-member, and `app/routes/project-visibility.server.ts:35-41` does the same on the action side before
the `comment` case runs (`project.task.tsx:312` → `:316`). This is the only place in the codebase where
the rendered policy contradicts the enforced one — the exact drift the matrix-as-source design exists
to prevent. Related, milder: the Profile page ignores `appWide` entirely
(`app/features/profile/profile-page.tsx:462-475`), so those rows render as ordinary four-check rows.

**7.14 "Disabled with a reason" is applied inconsistently within the same file.**
`app/features/policy/policy-page.tsx` gets it right for member radios (`:107-115`, a visible note naming
the grant — the P14-LV-08 fix) and wrong for the workflow-boundary radios (`:461`, disabled with no
visible reason). Same split in `app/features/project-settings/settings-page.tsx`: the Danger Zone has a
`.deny-note` (`:934-941`), the credential panel does not (`:823`).

**7.15 A `title` on a `disabled` button is dead copy.**
`app/features/task-detail/decision-packet.tsx:289-305` puts the reason a blocked `accept_completion` /
`edit_goal` / `archive_task` cannot be confirmed into a `title` on a `disabled` button — disabled
elements receive no pointer events, so the tooltip never opens. The option **radios** at `:183-206` use
`aria-disabled` (not `disabled`), so *their* titles do work. The codebase already knows this rule:
`app/features/task-detail/task-detail-page.tsx:1112-1113` — "The reason has to be TEXT, not a `title`".

**7.16 `getReviewQueue`'s unscoped fallback returns `true` for everything.**
`app/server/projections/review-queue.server.ts:140` — `if (opts.viewerUserId === undefined) return true;`
Documented as preserving test/non-scoped behavior (`:14-24`), but it means any future caller that omits
`viewerUserId` silently gets an unfiltered "ready for acceptance" list.

**7.17 Notifications deliberately exclude the org-admin override; Home does not.**
`app/server/projections/notifications.server.ts:153-171` computes `waitingOnYou` from
`decisionsRequiring(...).mine` only — org-admin `overrideEligible` decisions never raise a
notification — while `app/features/home/home-query.server.ts:106-117` surfaces them as a separate
`overrideWaiting` counter. Consistent with "override is governance, not a personal inbox", but the two
surfaces answer "waiting on you" differently and nothing binds them.

**7.18 Two sources for `memberRoles` (file vs projection).**
`assertProjectAction` reads `project.md` fresh (`project-authority.server.ts:337-343`);
`runAgentsAuthority` reads the `project_members` projection (`project.task.tsx:284-300`), as does
`review-queue.server.ts:121-130`. A projection lag would make the run-agents gate and the config-surface
gate disagree. `RU #8` (quoted at `project.task.tsx:287-289`) already flags the shape-drift risk; the
*source* difference is not flagged anywhere.
