# Viberr — RBAC & Governance Reference (pass 17, CURRENT STATE)

**Status:** written 2026-08-04 against `main` @ `8541a32` (the merge of PR #125, `pass16/product-fixes`),
working tree clean. Every claim is code-confirmed; `path:line` refs are the proof.

**Why this file exists.** `planning/discovery-2026-08-04/RBAC-GOVERNANCE.md` was written at commit
`b557060`/`2442945` — *before* the three pass-16 implementation waves (`5e03c6e`, `53b796d`,
`71fa506`) and the follow-up `0955ac9`. Those waves closed most of its §7 backlog and split
`task-detail-page.tsx` into four files, so a large fraction of its line refs and several of its
statements are now wrong. This document is the corrected replacement. Read §0 first if you already
know the pass-16 doc; read from §1 if you do not.

**The design in one sentence:** *matrix-as-source* — one object (`RBAC_DEFINITIONS` in
`app/shared/rbac.ts`) is consulted by every server guard, rendered by every permission table, and
now **pinned by a hand-written expectation table** so a tier cannot move as a side effect of a
refactor. Adding an action means adding a row there and a row in the test — never a hardcoded role
literal.

**Ruling provenance.** R16-1..R16-7 live in `planning/discovery-2026-08-04/FINDINGS.md`. They are
**not** yet in `docs/architecture/decisions.md`, whose numbered list stops at R15-15
(`docs/architecture/decisions.md:276`). Anything below that cites an R16 ruling cites it because
the code comment names it.

---

## 0. Delta from the pass-16 doc

### 0.1 What did NOT change (pass-16 refs still good)

These files are **byte-identical** to the tree the pass-16 doc was written against, so its line refs
for them remain valid:

`app/server/auth/project-authority.server.ts`, `app/routes/project-visibility.server.ts`,
`app/server/auth/require-project.server.ts`, `app/server/auth/require-user.server.ts`,
`app/server/auth/seed-admin.server.ts`, `app/lib/auth.server.ts`,
`app/schemas/project-file.schema.ts`, `app/schemas/task-file.schema.ts`,
`app/shared/capabilities.ts`, `app/shared/workflow/stage-roles.ts`,
`app/shared/workflow/stage-eligibility.ts`, `app/features/policy/policy-actions.server.ts`,
`app/features/project-settings/settings-actions.server.ts`,
`app/features/agents/agent-profile-actions.server.ts`,
`app/server/projections/decisions.server.ts`, `app/features/shell/command-search.server.ts`,
`app/routes/resources.events.ts`, `test-support/test-store.ts`.

**The action matrix itself is unchanged** — still 18 actions, still the same role tiers. Nothing was
added, removed, widened or narrowed. What changed is how it is stored, displayed, pinned and
enforced at the edges.

### 0.2 Corrections

| # | Pass-16 said | Current truth | Ref |
|---|---|---|---|
| 1 | `appWide: true` marks `view`/`comment` (§2.2, §3.3, §7.1, §7.13) | **`appWide` no longer exists.** E1 was fixed by deleting the concept, not editing the sentence. `RBAC_DEFINITIONS` rows carry only `{id,label,roles}`; `RbacRow` has no `appWide`; the Policy page renders all 18 rows identically; the Profile page has nothing left to ignore. The one merged "Any signed-in user · membership not required" cell is gone. | `app/shared/rbac.ts:61-88`, `app/features/policy/policy-data.ts:24-37`, `policy-page.tsx:184-207` |
| 2 | Acceptance chain order = archived → stage → reviewers → verdict → packet → closed-PR → conflicting (§5.2) | **R16-3 reordered it.** `closedPrBlockedReason` is now **second**, right after the archived-task check, so a terminal GitHub fact outranks every process gate. | `app/server/tasks/task-actions.server.ts:4638-4669` |
| 3 | Force-accept bypasses everything but `acceptancePrHeadMismatch` (§3.6) | Still true for *gates*, but the **affordance is now withheld entirely while the PR is closed** (R16-3). New server predicate `acceptanceTerminallyBlocked(fm) = fm.pr?.state === "closed"`, surfaced as `AcceptanceAffordance.terminallyBlocked`, and the UI ANDs it into `canForceAccept`. | `task-actions.server.ts:4682-4684`, `:4846-4848`, `:4913`; `app/features/task-detail/task-detail-hooks.ts:127-129` |
| 4 | "`acceptancePrHeadMismatch` is the ONE gate force can NEVER bypass" | The docstring was true; the enforcement was not (finding A2). The head gate now lives **inside `applyAcceptanceWrite`**, the one Done write every path shares, and `completeTaskMerge` gained its own — so `operatorAcceptCompletion` is covered without editing the operator, and `skipInLockRecheck` (force) does not relax it. | `task-actions.server.ts:4936-4961`, `:5252-5258`, `:4963` (`assertVerifiedHeadStillApplies`) |
| 5 | Four route actions leak existence with a 403 (§7.3) | **Closed (E2).** All six project-scoped route actions now call `requireVisibleProject` before their inner guards. | board `:31`, agents `:106`, settings `:64`, github `:48`, policy `:43`, task `:103`/`:312` |
| 6 | `getReviewQueue`'s unscoped fallback returns `true` for everything (§7.16) | **Closed (E5).** `viewerUserId` is now a **required** field with no default `opts`; the `if (viewerUserId === undefined) return true` line is gone; an unknown id resolves to `viewerRole = null` → no acceptance authority. | `app/server/projections/review-queue.server.ts:28-34`, `:82-86`, `:163-168` |
| 7 | Notifications and Home answer "waiting on you" differently, nothing binds them (§7.17) | **Resolved in code (E6).** Both call one `indexDecisionInbox`, which makes the mine/override split once. The *policy* is unchanged (override is governance, not an inbox) but it is now structurally impossible to answer two ways. | `app/server/projections/notifications.server.ts:139-167`, `:207`; `app/features/home/home-query.server.ts:107-112` |
| 8 | CSRF passes when a request carries neither `Origin` nor `Sec-Fetch-Site` "by design" (§7.10) | **Reversed (A7): it now fails closed**, and `Referer` is checked too. | `app/server/auth/csrf.server.ts:47-55`, `:79-93` |
| 9 | Four hardcoded role literals in the UI are drift hazards (§7.4) | **All four replaced by action ids (E3).** `canCreate` → `create-task`; `canEditGoal` → `update-goal` (was `run-agents`); release-other-owner → `release-any-ownership`; settings panels → `edit-policy` / `manage-members`. A grep for a project-role literal used as a capability gate now returns **zero** non-test hits. | `project.board.tsx:105`; `task-detail-page.tsx:181`; `task-side-panels.tsx:395-398`, `execution-profile.tsx:100-103`; `settings-page.tsx:1379-1381` |
| 10 | Settings' `isAdmin = myRole === "admin"` drives three panels; "no single action names all three" | The shortcut was wrong, not just unpinned: the servers check **`edit-policy`** for identity/stages/repo and **`manage-members`** for members. Two different grants, both admin *today*. | `settings-page.tsx:1370-1381` vs `settings-actions.server.ts:113/375/612/665` |
| 11 | Decision-packet reason sits in a `title` on a `disabled` button, so it never opens (§7.15) | **Closed (E4).** Role refusals are `aria-disabled` + a refusing click handler + visible `.deny-note` bound by `aria-describedby`; `title` is gone. Only `busy`/"no options" stay genuinely `disabled`. | `decision-packet.tsx:23`, `:299-304`, `:307-331` |
| 12 | Policy page's boundary radios are disabled with no visible reason (§7.14) | **Closed.** Both policy denials are now disabled **with** a visible reason. | `policy-page.tsx:434-440` + `:474` |
| 13 | `setOwner`'s docblock claims all four roles hold `own-task` (§7.5) | **Corrected in place**, and the docblock now records that the code always refused viewers. | `task-actions.server.ts:2798-2809` |
| 14 | 8 matrix actions have no per-role test driver (§6.3, E7) | **Closed.** All eight are driven; and a *second*, hand-written `EXPECTED_TIERS` table now pins the matrix itself — the old tests derived their expectation from the map they guarded, so widening a tier passed silently. | `policy-rbac.server.test.ts:304-413`, `:698-742` |
| 15 | §3.3's UI inventory line refs | **All stale.** `task-detail-page.tsx` went 1761 → 538 lines; the RBAC flags now live across `task-detail-page.tsx`, `task-detail-hooks.ts`, `task-main-sections.tsx` and `task-side-panels.tsx`. §3.4 below is the re-derived inventory. | — |
| 16 | Task Permissions panel hardcodes `{ k: "Comments", v: "Every registered user" }` (§7.6) | **Closed.** The panel moved to `task-side-panels.tsx:241-340` and every row now reads `roleCan`. | `task-side-panels.tsx:275-307` |
| 17 | (not covered) | **New: R16-1 PR adoption.** A pre-existing PR becomes a task's PR only if it is OPEN *and* its head sha **is** the delivered revision. One rule, three call sites. This is record-integrity for the acceptance gate — a foreign merged PR used to bind by branch name. | `app/server/github/pr-adoption.server.ts:46-61`; sites `pr-open.server.ts:238`, `workspace-delivery.server.ts:476`, `github-reconciler.server.ts:291` |
| 18 | (not covered) | **New: A4 undeployed-operator gate.** `gate()` and `deliverGate()` now return `"deny"` when `!authority.deployed`; an undeployed operator could previously push a branch and open a PR. | `operator-actions.server.ts:277`, `:314` |
| 19 | (not covered) | **New: R16-6 "Done means two things".** Merge stays human-only, so a full-autonomy task reaches the done stage with its PR open (`pr.state: "accepted"`). The board card now draws merge-pending and closed PRs via the shared `prStatePill`. | `app/features/board/board-page.tsx:281-307`; `app/features/github/github-pills.ts:47-52` |
| 20 | (not covered) | **New: R16-5 MCP stays outside the capability matrix.** The decision is now explicit in the UI disclosure and pinned by a test asserting the **absence** of an `mcp__*` deny rule. | `capability-matrix-modal.tsx:229-244`; `specialist-tool-policy.test.ts:290-343` |

**Still open / still true** (carried forward into §8): the org-admin override reaches
`force-accept-completion`; `resolveAcceptanceAffordance` is a second implementation of the
role+owner predicate; two different sources feed `memberRoles` (file vs projection); `appendComment`
has no authorization of its own; `runsVisible`'s false branch is unreachable dead code; the
`test-support/test-store.ts:26` "selin → reviewer" comment; and a **newly identified** stale
docblock at `app/server/auth/require-project.server.ts:10-12`.

---

## 1. The role model

### 1.1 Two independent role systems

| System | Values | Stored in | Type source |
|---|---|---|---|
| **Org role** | `admin`, `member` | `users.role` (SQLite) | `UserRole` — `app/shared/mapping/user.server.ts` |
| **Project role** | `admin`, `maintainer`, `contributor`, `viewer` | `projects/<slug>/project.md` frontmatter `members[]` (canonical) → projected into `project_members` | `PROJECT_ROLES` / `ProjectRole` — `app/schemas/project-file.schema.ts:23-24` |

They are orthogonal: an org `member` can be a project `admin`; an org `admin` can be a non-member of
a project and reaches it only through the audited D2 override (§3.5).

- Org-role DDL: `db/migrations/0001_baseline.sql:28`.
- Org-role hierarchy: `app/server/auth/require-user.server.ts:174-182` (`ROLE_ORDER = { member: 1, admin: 2 }`, `roleSatisfies`).
- Project-role DDL (projection): `db/migrations/0001_baseline.sql:66-71`, PK `(project_slug, user_id)`.
- Project-role rank: `app/shared/rbac.ts:31-36` — `viewer 0 < contributor 1 < maintainer 2 < admin 3`.
- Project-role labels: `app/shared/rbac.ts:38-43`.

### 1.2 `reviewer` → `contributor`

`app/schemas/project-file.schema.ts:18-22` records the rename: it dropped a misleading label (review
authority rides per-task ownership and per-task engagements, not the role) while keeping the tier's
one real power — creating tasks — above read-only `viewer`.

Consequences a future agent must not re-invent:
- Review authority is **not** a project role. It is (a) a task-file **engagement** with
  `verdictCapable: true` (agents, §5.4) and (b) the human tier `accept-completion` plus the
  task-owner exception (§5.6).
- The string `reviewer` survives only as an *engagement* concept (`assignReviewer`,
  `supportingEngagements`) and in a stale fixture comment (`test-support/test-store.ts:26`, §8.1).

### 1.3 Membership storage — the file is canonical

`project.md` frontmatter is the source of truth; the `project_members` row is a projection.

- Member schema: `app/schemas/project-file.schema.ts:63-68` — `{ userId, role: enum(PROJECT_ROLES) }`, `.loose()`.
- **No session-cached role anywhere.** Every authority check re-reads the file or a freshly loaded
  `ProjectContext`; stated at `app/features/policy/policy-actions.server.ts:85-88` ("enforced on the
  next action").
- Guard input shape: `AuthorityProject { slug, memberRoles: Map<userId, ProjectRole>, archived }` —
  `app/server/auth/project-authority.server.ts:45-53`. Slug-only callers use `assertProjectAction`,
  which builds the map from the file itself (`:337-343`).
- `runAgentsAuthority()` builds the same shape from the **projection** for the run paths
  (`app/routes/project.task.tsx:284-300`), as does `review-queue.server.ts:146-154`. See §8.4.

### 1.4 Members-only projects (R15-4), and the E2 closure

Projects are **members-only**; a non-member gets a 404 byte-identical to an unknown slug (WI-13
secrecy beats FR4's old app-wide read).

- Layout chokepoint: `app/routes/project.tsx:62-76` — the refusal runs **before** any viewer-scoped
  projection work. `orgAdminOverride = memberRole === null && user.role === "admin"` at `:73`;
  `myRole = memberRole ?? (orgAdminOverride ? "admin" : null)` at `:110`.
- Per-loader gate (single-fetch `?_routes=` bypass): `app/routes/project.task.tsx:103-108`.
- **Action-side gate:** `app/routes/project-visibility.server.ts:28-44` — `requireVisibleProject()`
  resolves through `assertProjectAction(db, "any-member", …, { allowArchived: true })` and converts
  **any** `AppError` into `throw data("No project at projects/<slug>.", { status: 404 })`.
  A 403 would confirm existence.

  **All six project-scoped route actions now call it** (the pass-16 §7.3 asymmetry is closed):

  | Route action | Call | Placement |
  |---|---|---|
  | `app/routes/project.board.tsx` | `:31` | after `requireFormAction` `:24`, **outside** the `try` |
  | `app/routes/project.agents.tsx` | `:106` | after `:100`, outside the try |
  | `app/routes/project.settings.tsx` | `:64` | after `:57`, outside the try |
  | `app/routes/project.github.tsx` | `:48` | after `:43`, outside the try |
  | `app/routes/project.policy.tsx` | `:43` | pre-existing (R15-4) |
  | `app/routes/project.task.tsx` | `:103` (loader) / `:312` (action) | |

  Route-level tests: `app/routes/project.board.server.test.ts:63-105`,
  `app/routes/project-visibility-actions.server.test.ts:36-90` (agents/settings/github),
  `app/routes/project-visibility.server.test.ts:35-104` (task/policy). Note the board test's `:95`
  case: a member *below* the required tier still gets the honest 403 — 404 is for non-members only.
- Config-surface READ gate: `app/server/auth/require-project.server.ts:20-45` — `requireProjectMember()`
  (`"any-member"`, `allowArchived: true`) converts the AppError into a real **403 Response** (not a
  404 — this is a loader for a member-only surface, reached only after the layout already 404'd a
  non-member). Callers: `project.activity.tsx:40`, `project.review.tsx:28`, `project.agents.tsx:40`,
  `project.policy.tsx:29`, `project.settings.tsx:47`, `project.github.tsx:33`,
  `resources.run-log.ts:69`, `resources.session-export.ts:44`.
- Home scoping: `app/features/home/home-query.server.ts:114` (org admins see every project) and
  `:118-125` (everyone else filtered by `project_members`).
- SSE scoping: `app/routes/resources.events.ts:100-136`.
- ⌘K scoping: `app/features/shell/command-search.server.ts:62-63` — one scope,
  `listHomeProjectsForUser`. Role affects nothing in ⌘K; membership affects everything.

### 1.5 env-admin / `admin@viberr.dev`

There is **no promotion path**; the bootstrap fires only on an *empty* `users` table
(`app/server/auth/seed-admin.server.ts:41`). Email default `:19`, generated password `:44-45`,
`insertUser(role:"admin", pwresetRequired: generated)` `:48-58`, better-auth identity `:60-65`,
audit `org.user.created {bootstrap:true}` `:67-73`, one-time `warn` log for a *generated* password
`:75-82`. Env vars `VIBERR_SEED_ADMIN_EMAIL` / `VIBERR_SEED_ADMIN_PASSWORD`
(`app/server/config/env.server.ts:91-96`) — **not** `VIBERR_ADMIN_EMAIL`. Boot call
`app/server/boot.server.ts:217-220`.

---

## 2. `ACTION_ROLES` — the single source

**File: `app/shared/rbac.ts` (105 lines — read it whole before editing anything here).**

```
RBAC_DEFINITIONS  (rbac.ts:61-88)    → the rows: { id, label, roles[] }
RbacAction        (rbac.ts:90)       → the union of ids (derived, never hand-written)
ACTION_ROLES      (rbac.ts:92-94)    → Object.fromEntries(id → roles)
roleCan(role,a)   (rbac.ts:97-100)   → null/undefined role ⇒ false, always
rolesForAction(a) (rbac.ts:103-105)  → the allow-list guards pass to the authority resolver
```

### 2.1 The full action matrix (18 actions, unchanged this pass)

`A` = admin, `M` = maintainer, `C` = contributor, `V` = viewer.

| # | Action id | Label (rendered on Policy + Profile) | A | M | C | V | Tier notes |
|---|---|---|:-:|:-:|:-:|:-:|---|
| 1 | `view` | View board, tasks & timelines | ✓ | ✓ | ✓ | ✓ | No role tier narrows it; **no guard calls `requireAction("view")`** — its entire enforcement IS the membership gate (§1.4) |
| 2 | `comment` | Comment on tasks | ✓ | ✓ | ✓ | ✓ | Same. `appendComment` has no role check at all (`task-actions.server.ts:759`, only `requireProjectMutable`) |
| 3 | `create-task` | Create tasks | ✓ | ✓ | ✓ | — | contributor floor |
| 4 | `own-task` | Take / release own task ownership | ✓ | ✓ | ✓ | — | contributor floor; also the **owner-exception predicate** (§5.6) |
| 5 | `approve-transition` | Approve stage transitions | ✓ | ✓ | — | — | maintainer floor; also gates **task archive/restore** (R14-3) |
| 6 | `resolve-packet` | Resolve decision packets | ✓ | ✓ | — | — | maintainer floor; also apply/dismiss recommendation |
| 7 | `accept-completion` | Accept completion → Done | ✓ | ✓ | — | — | maintainer floor; owner exception widens it per-task (R6-2) |
| 8 | `update-goal` | Edit the task goal | ✓ | ✓ | — | — | maintainer floor |
| 9 | `run-agents` | Run agents | ✓ | ✓ | — | — | maintainer floor; assign/run/interrupt/schedule + manual delivery |
| 10 | `reorder-board` | Reorder the board | ✓ | ✓ | — | — | pinned to the same tier as `approve-transition` by test (`policy-rbac.server.test.ts:576-589`) |
| 11 | `reconcile-github` | Reconcile GitHub state | ✓ | ✓ | — | — | R8-4 raised it from contributor+ |
| 12 | `grant-github-scope` | Grant GitHub scope | ✓ | ✓ | — | — | also set/clear the project credential |
| 13 | `rescan-project` | Re-scan project files & projections | ✓ | ✓ | — | — | project-scoped only (F20) |
| 14 | `release-any-ownership` | Release any task owner | ✓ | — | — | — | admin only |
| 15 | `manage-members` | Manage members & roles | ✓ | — | — | — | admin only |
| 16 | `manage-agents` | Manage agent profiles | ✓ | — | — | — | admin only |
| 17 | `edit-policy` | Edit workflow & policy | ✓ | — | — | — | admin only; identity/stages/repo/archive/delete + boundary changes |
| 18 | `force-accept-completion` | Force-accept past the review gate | ✓ | — | — | — | admin only, **DG-2** audited escape hatch (`rbac.ts:79-83`) |

"admin only" means *project admin **or** any org admin via the audited D2 override* — see §8.2.

### 2.2 `appWide` is gone

The flag used to make the Policy page draw one merged **"Any signed-in user · membership not
required"** cell for `view`/`comment`. Post-R15-4 that sentence was simply false, and the flag
existed only to render it — so E1 was fixed by **deleting the concept**:

- `app/shared/rbac.ts:50-60` records the removal and the reason.
- `app/features/policy/policy-data.ts:24-37` — `RbacRow` is `{ action, grant }`; nothing else.
- `app/features/policy/policy-page.tsx:184-207` — all 18 rows render identically.
- Membership scope is stated **once**, under the table, where it applies to every row
  (`policy-page.tsx:211-231`, quoted in §3.4).
- `grep -rn "appWide" app/` now returns exactly one hit: the historical comment at `rbac.ts:55`.

### 2.3 The matrix is pinned twice

`app/features/policy/policy-rbac.server.test.ts` binds two different things:

1. **Call sites ↔ matrix** — `assertMatchesMatrix` (`:121-162`) derives its expectation from
   `rolesForAction(action)`, i.e. the same map the guards read. This catches a guard that stops
   consulting the matrix. It **cannot** catch a change to the matrix.
2. **Matrix ↔ governance** (new this pass, `:698-742`) — a hand-written
   `EXPECTED_TIERS: Record<RbacAction, ProjectRole[]>` at `:709-728`, asserted by deep equality at
   `:730-735`, plus a key-set assertion at `:737-741` so a new action cannot slip in untiered. The
   rationale at `:699-708`: *"a role tier is a governance decision, so it should never move as a
   side effect of a refactor."* Editing `ACTION_ROLES` now requires editing this table too.

**Monotonicity invariant.** Every set is a *rank floor* — if a role holds an action, every higher
role does. Derived from `RBAC_DEFINITIONS` so a new row is covered the day it lands:
`policy-rbac.server.test.ts:193-211`.

### 2.4 Archive semantics (two different archives)

| Kind | Flag | Authority | Effect |
|---|---|---|---|
| **Project archive** (R6-3) | `project.md` frontmatter `archived` | `edit-policy` (admin) — `settings-actions.server.ts:741` | **Read-only freeze.** `requireProjectMutable` (`project-authority.server.ts:131-142`) throws **409** `"This project is archived (read-only) — restore it before you …"` on every governed mutation. Reads and audit stay open. |
| **Task archive** (R14-3) | task frontmatter `archived` | `approve-transition` (maintainer+) — `task-actions.server.ts:3906` | A **disposition**, not a delete: file + timeline survive, the task leaves the board default view and the review queue, the open packet and pending recommendations are withdrawn, reversible. |

Project-archive gate **placement** matters — it produces a **409, not a 403**, even for an admin:

- `requireAction` calls `requireProjectMutable` *before* the role check — `task-actions.server.ts:313`.
- `assertProjectAction` likewise, unless `allowArchived` — `project-authority.server.ts:329-336`.
- `requireRunAgents` likewise (F17) — `project-authority.server.ts:266-280`; `canRunAgents` returns
  `false` outright on an archived project.
- `appendComment` calls it explicitly because commenting is not role-gated —
  `task-actions.server.ts:776`.
- Exemptions passing `allowArchived: true`: project restore (`settings-actions.server.ts:746`
  — `allowArchived: !input.archived`), project delete (`:790`), and every route READ gate.
- Pinned by `policy-rbac.server.test.ts:415-442` (R8-5): an admin is refused `grant-github-scope`
  and `reconcile-github` on an archived project with `/archived/i`, and the same call with
  `allowArchived: true` does not throw. (The status is 409, set at `project-authority.server.ts:138`;
  the test matches the message.)

---

## 3. Enforcement paths

### 3.1 The one authority resolver

**`app/server/auth/project-authority.server.ts` is the only place membership + role are resolved.**
Unchanged this pass; `:9-34` states the contract.

```
resolveProjectAuthority(db, project, actor, allowed, audit) : AuthorityDecision   :167-231   (non-throwing)
requireProjectAuthority(...)                                : ProjectAuthority    :238-255   (throws 403)
requireRunAgents(db, project, actor, what)                  : ProjectAuthority    :266-280   (archived gate + run-agents)
canRunAgents(db, project, actor, what)                      : boolean             :284-300   (silentDeny)
assertProjectAction(db, action|"any-member", slug, actor, …)                      :310-363   (reads project.md fresh)
requireProjectMutable(project, what)                                             :131-142   (R6-3 409)
isOrgAdmin(db, userId)                                                           :147-153   (users.role, disabled = 0)
```

Decision order in `resolveProjectAuthority`:
1. `memberRole` satisfies `allowed` (or `allowed === "any-member"`) → **allow under their own role**,
   `isOrgAdminOverride: false` (`:174-180`).
2. else `isOrgAdmin` → **allow as `role: "admin"`, `isOrgAdminOverride: true`**, and audit
   `project.org_admin.override` unless the action is `"any-member"` (`:181-204`).
3. else **deny**, audit `project.authority.denied` unless `silentDeny` (`:205-230`).

403 copy (`:249-254`): non-member → `Only project members can ${what}.`; below-tier member →
`Your project role (${memberRole}) cannot ${what}.` `assertProjectAction`'s copy is config-surface
shaped (`:356-362`): `Only project ${label} can ${what}.`

**Denial-audit dedupe:** identical `(actor, project, action)` denials collapse inside a 60 s window,
keyed per `DatabaseSync` handle, max 500 tracked — `:95-119`. Polled resource routes would otherwise
write a row per poll.

### 3.2 The task-mutation guard

`app/server/tasks/task-actions.server.ts`

- `requireAction(db, project, actor, action, what)` — `:303-318`. Archived gate first, then
  `requireProjectAuthority(…, rolesForAction(action))`. Returns the **effective** role.
- `requireAnyMember(...)` — `:290-300`.
- `ownerException(project, actor, ownerUserId)` — `:321-332`: the live owner **who also holds
  `own-task`**. A demoted viewer-owner does not qualify.
- `requireAcceptCompletion(...)` — `:335-344`: owner exception, else `accept-completion` (R6-2).
- `requireDecisionAuthority(...)` — `:359-368`: owner exception, else `resolve-packet` (R14-2,
  rationale in the docblock at `:346-358`).

Every governed mutation and its action id:

| Function (`task-actions.server.ts` unless noted) | Line | Action |
|---|---|---|
| `createTask` | `:438` / guard `:445` | `create-task` |
| `updateTaskGoal` | `:530` / `:537` | `update-goal` |
| `appendComment` | `:759` / `:776` | *(none — archived gate only; see §8.3)* |
| `setOwner` | `:2810` / `:2817` | `own-task`; hand-off additionally needs owner **or** `release-any-ownership` (`:2835`), and the target must hold `own-task` (`:2839`) |
| `releaseOwner` | `:2907` | own seat → `own-task` (`:2929`); someone else's seat → `release-any-ownership` (`:2932`); no-owner no-op → `any-member` (`:2922`) |
| `transitionStage` | `:2971`, guard block `:3060-3102` | see §5.1 |
| `manualDeliverForReview` | `:3593` | owner exception (`:3602`), else `run-agents` (`:3607`) — R15-2 safety net b |
| `reorderTask` | `:3793` / `:3811` | `reorder-board` |
| `setTaskArchived` | `:3899` / `:3906` | `approve-transition` (R14-3) |
| `resolvePacket` | `:4021`, guard `:4061-4073` | `resolve-packet`, **except** the `accept_completion` option, which is deliberately *not* gated here and routes to `requireAcceptCompletion` inside the case (`:4087`); `archive_task` re-checks `approve-transition` inside its case (`:4309`) |
| `acceptCompletion` (private) | `:5004` / `:5014` | `requireAcceptCompletion` |
| `forceAcceptCompletion` | `:5156` / `:5163` | `force-accept-completion` |
| `completeTaskMerge` | `:5213` / `:5228` | `requireAcceptCompletion` (+ its own PR-head gate at `:5252-5258`) |
| `applyRecommendation` | `:5293` / `:5312` | `resolve-packet` via `requireDecisionAuthority`; inner mutation keeps its own tier (`:5334-5342`, `:5403`) |
| `dismissRecommendation` | `:5468` / `:5482` | `resolve-packet` via `requireDecisionAuthority` |
| `assignSpecialist` / `assignReviewer` / `startAgentRun` | `specialist-run.server.ts:284`, `:421`, `:589` → `runtimeAuditActor:1749` → `requireRuntimeRole:1767` | `run-agents` |
| `removeReviewer` | `specialist-run.server.ts:531` / `:537` | `run-agents` |
| run interrupt | `app/server/runtimes/run-service.server.ts:872-877` | `run-agents` (via `requireRunAgents`) |
| @mention agent trigger | `task-actions.server.ts:1411` → `canRunAgents` | `run-agents`, **silent deny** (comment kept, run skipped) |

### 3.3 Config surfaces (all via `assertProjectAction`)

| Surface | Ref | Action |
|---|---|---|
| Project identity / repo / stages | `settings-actions.server.ts:113`, `:177`, `:267`, `:375`, `:412`, `:467`, `:544` | `edit-policy` |
| Project archive / restore | `settings-actions.server.ts:741` (+ `allowArchived: !input.archived` `:746`) | `edit-policy` |
| Project delete | `settings-actions.server.ts:785` (+ `allowArchived: true` `:790`) | `edit-policy` |
| Membership invite / remove | `settings-actions.server.ts:612`, `:665` | `manage-members` |
| Member role change | `policy-actions.server.ts:101` (via `requirePolicyAction` `:50-65`) | `manage-members` |
| Workflow boundary change | `policy-actions.server.ts:185` | `edit-policy` |
| Agent profile CRUD | `agent-profile-actions.server.ts:118-120` | `manage-agents` |
| Board rescan | `app/routes/project.board.tsx:86` (scoped to `params.slug`, F20) | `rescan-project` |
| GitHub reconcile | `app/routes/project.github.tsx:61` | `reconcile-github` |
| GitHub credential grant / set / clear | `project.github.tsx:65`, `:70`; `project.settings.tsx:171`, `:178` | `grant-github-scope` |
| Route READ gate (all config surfaces) | `require-project.server.ts:30-37` | `"any-member"` → 403 |
| Route ACTION visibility gate | `project-visibility.server.ts:35` | `"any-member"` → 404 |

**Org-level (not project RBAC):** `requireRole(request, "admin")` at `app/routes/org.settings.tsx:71`
(loader) and `requireRoleAuth(request, "admin")` at `:104` (action); global rescan and
rebuild-projections check `ctx.user.role !== "admin"` inline at `app/routes/_index.tsx:97` and
`:129`. **Project creation is deliberately self-serve for any signed-in user** —
`app/routes/_index.tsx:159-165` ("Org role is intentionally NOT consulted here"), creator seeded as
project admin.

### 3.4 UI capability reflection ("RBAC honesty")

Rule of the codebase: the UI consults **the same action id** the server enforces, via `roleCan` —
never a role literal. 44 non-test `roleCan` call sites across 15 files.

**A grep for a project-role literal used as a capability gate now returns zero non-test hits.** The
literals that remain are a different axis or a different job:
- **Org-role** (`user.role === "admin"`) — legitimate: `project.tsx:73` (D2 override),
  `project.task.tsx:141` (`runsVisible`), `:214` (`canDeliver`), `resources.events.ts:111`,
  `_index.tsx:61/97/129`, `org.settings.tsx:86/155/164`, home + org-settings surfaces.
- **Last-admin invariants** mirroring an explicit server guard — `policy-page.tsx:75`
  (server: `policy-actions.server.ts:127`), `settings-page.tsx:806`/`:809`
  (server: `settings-actions.server.ts:689`), `membership.server.ts:92`.
- **Display fallback** — `task-side-panels.tsx:264` (`const role = myRole || "viewer"` labels the
  "Your role" row; every value beside it goes through `roleCan`).
- **Comment-only survivors** documenting removed literals: `execution-profile.tsx:98`,
  `task-side-panels.tsx:393`, `project.board.tsx:103`, `settings-page.tsx:1259`, `:1371`.

Legend: **H** = hidden when denied; **D+** = disabled/aria-disabled **with visible reason text**;
**D−** = disabled with only a `title` (or nothing); **N/A** = data filter or copy.

| UI site | Flag @ line | Action id | Denied | Render sites |
|---|---|---|:-:|---|
| `app/routes/project.board.tsx` | `canCreate` `:105` | `create-task` | H | `board-page.tsx:420`, `:809` |
| " | `canTransition` `:110-113` | `reorder-board` | H | `board-page.tsx:228`, `:238`, `:340`, `:499-505` |
| " | `canRescan` `:116` | `rescan-project` | H | `board-page.tsx:798` |
| `app/routes/project.task.tsx` | `canDeliver` `:212-216` | `run-agents` ∥ org-admin ∥ owner+`own-task` | H | `task-side-panels.tsx:197-211` |
| `task-detail-page.tsx` | `canRunAgents` `:175` | `run-agents` | H | `:383` schedules, `:397` execution |
| " | `canOwn` `:176` | `own-task` | N/A (feeds `isOwner` `:187-188`) | — |
| " | `canEditGoal` `:181` | **`update-goal`** (was `run-agents`) | H / D+ | `:341` hero, `:368` packet |
| " | `canResolvePacket` `:189` | `run-agents` ∥ owner | H | `:363` |
| " | `canDecideOwned` `:195` | `run-agents` ∥ owner | H | `:364`, `:377` |
| " | `canArchiveViaPacket` `:201-204` | `approve-transition` | D+ | `:369` |
| `task-detail-hooks.ts` | `canInterrupt` `:72` | `run-agents` | H | `task-detail-page.tsx:353` |
| " | `onRetryBackend` `:89-105` | `run-agents` | H (prop omitted) | `task-detail-page.tsx:409` |
| " | `canMerge` / `onCompleteMerge` `:108-117` | `accept-completion` | H | `task-side-panels.tsx:212-223` |
| " | `canForceAccept` `:127-129` | `force-accept-completion` **&& !terminallyBlocked** | H | `task-side-panels.tsx:58-77`, `:88`, `:224` |
| `task-side-panels.tsx` `CurrentStatePanel` | `canTransition` `:390` | `approve-transition` | H | `:432-449` stage menu, `:569-586` archive block |
| " | `canOwn` `:391` | `own-task` | H | `:477`, `:493-508` |
| " | `canReleaseAnyOwner` `:395-398` | **`release-any-ownership`** (was `myRole === "admin"`) | H | `:477` |
| " | acceptance button | server-resolved (§5.5) | **D+** | button `:527-539`, visible `.deny-note` `:540-562` |
| `task-side-panels.tsx` `PolicyPanel` (task Permissions) | `:241-340` | `comment` `:276`, `own-task`/`release-any-ownership` `:283-284`, `accept-completion` + owner `:292-294`, `run-agents` `:301` | N/A | pure copy — no hardcoded strings left |
| `execution-profile.tsx` | `canOwn` `:96` | `own-task` | H with a sentence | `:109-122`, `:143-145`, `:161` |
| " | `canManageOthersOwnership` `:100-103` | `release-any-ownership` | H | `:127`, `:209-225` |
| " | hand-off candidates `:132-139` | `roleCan(m.role,"own-task")` `:137` | N/A | `:176-191` |
| `release-confirm.tsx` | `:51-57` | `own-task` `:53` | N/A | filter |
| `decision-packet.tsx` | `blockReason` `:137-143` | props ← `run-agents`/`accept-completion`/`update-goal`/`approve-transition` (`:83-102`) | **D+** | reason `:299-304`, Confirm `:307-331` (`aria-disabled` `:316` + `aria-describedby` `:317`), radios `:214-272` |
| `policy-page.tsx` | `canSetRole` `:538` | `manage-members` | **D+** | radios `:160`, note `:107-115` |
| " | `canEditPolicy` `:539` | `edit-policy` | **D+** | radios `:474`, note `:434-440` |
| `settings-page.tsx` | `canEditPolicy` `:1379` | `edit-policy` | **D−** | ProjectPanel `:101`,`:115`,`:129`; StagesPanel `:562`,`:591`; branch cleanup `:1124` |
| " | `canManageMembers` `:1380` | **`manage-members`** | H | `:867`, `:886` |
| " | `canGrant` `:1381` | `grant-github-scope` | H | `:1151`, `credential-card.tsx:224` |
| " | `canManageLifecycle` `:1263` | `edit-policy` | **D+** | `:1303`, `:1322` + `.deny-note` `:1278-1285` |
| `agents-page.tsx` | `canManage` `:1034`, `canDelete` `:606` | `manage-agents` | H | `:1204`, `:1217`, `:1273`, `:1295`, `:1301`, `:650-664` |
| `github-view.tsx` | `canReconcile` `:341` | `reconcile-github` | H (+ handler early-return `:343`) | `:450-460` |
| " | `canGrant` `:360` | `grant-github-scope` | H | `:372-383`, `:397-415` |
| `profile-page.tsx` | `ProfileAccess` `:438-499` | reads `RBAC_ROWS` | N/A | `:462-475` |
| `review-page.tsx` / `review-helpers.ts` | — | none (server-resolved) | N/A | copy only; queue performs zero mutations |

**Policy page permission table** — `policy-page.tsx:170-231`. Rows come from `RBAC_ROWS`
(`policy-data.ts:29-37`, derived from `RBAC_DEFINITIONS`); nothing is restated. Header columns are
`${ROLE_LABEL[r]} · ${counts[r]}` over **live** members only. The footnote (`:211-231`) is where
membership scope is now stated once, for every row:

> Rules that reach beyond project roles: **this project is members-only** — the table above says
> what a member may do, and someone who is not a member is not merely refused: every page and every
> action, comments included, answers as if the project did not exist, so even its existence stays
> private; **contributors and above** may **take or release their own task ownership** (viewers are
> read + comment only; the owner is the task's human reviewer and acceptance authority, scoped to
> that task — a contributor who owns a task **may accept its completion** even though the table
> reserves that column for maintainers); **admins may release any owner** — recorded in the audit
> trail; and **org admins hold emergency project-admin authority on every project** — even without
> membership — with every override recorded in the audit trail as *org-admin override*.

**Profile page** — `profile-page.tsx:438-499`, importing the same `RBAC_ROWS` (`:12`). It renders
every row uniformly; there is no longer an `appWide` distinction to lose. Its footnote (`:480-497`)
does **not** carry the members-only / owner-exception / org-admin paragraph — the one remaining copy
asymmetry between the two RBAC tables.

**Remaining D− surface (the whole of it):** `settings-page.tsx:101`, `:115`, `:129` (ProjectPanel
inputs), `:562` (stage rename), `:591` (stage remove), `:1124` (branch-cleanup checkbox). These are
the only places where an RBAC refusal is still silent to a sighted keyboard user; the `title`s that
exist there describe *lockedness*, not authority.

**Server-side gate with no UI counterpart (correct direction):** `commentToAgent` silently downgrades
an `@agent` mention to a plain comment for a below-tier commenter; the composer is never gated and
the honesty lives in the toast — `app/routes/project.task.tsx:332-333`
`"Comment posted · your role can't trigger agent runs"`.

### 3.5 D2 org-admin emergency override

An org admin whose *membership* role would be denied (non-member, or a member below tier) is granted
project-admin-equivalent authority, and **every such grant is audited**.

- Grant + audit: `project-authority.server.ts:181-204` → `recordAudit({ action: "project.org_admin.override", details: { action, what, projectSlug, memberRole } })`.
- **Not** audited for `"any-member"` (route READs) — `:182-188`; otherwise an org-admin non-member
  wrote a row per page load (F7 audit noise). The override *flag* is still returned so the UI can
  show the honest pill.
- An org admin acting within a sufficient membership role is **not** an override (no row) —
  `policy-rbac.server.test.ts:525-545`.
- UI: `app/routes/project.tsx:73` computes `orgAdminOverride`, `:110` sets `myRole = "admin"` for the
  shell, and the topbar shows an override pill.
- Every action in the matrix is driven as an org-admin non-member by `assertMatchesMatrix`
  (`policy-rbac.server.test.ts:146-161`) and must both **allow** and **write exactly one row**;
  the `"any-member"` read path must write **zero** (`:505-524`).

### 3.6 Member-scoped decision counts (R8-3 / R14-2 / E6)

**`app/server/projections/decisions.server.ts`** — `decisionsRequiring(db, userId, opts)` `:80-84`
(unchanged this pass):
- `:163` `canGovern = roleCan(role, "resolve-packet")`.
- `:169` `ownerCanAct = ownerUserId === userId && roleCan(role, "own-task")` (R14-2).
- `:171-179` classification: `mine` when either holds; else `overrideEligible` when the viewer is an
  org admin (reachable only through the audited D2 override); else nothing.
- Acceptance-ready rows are unioned in from `task_projections` (`:131-146`) so an acceptance with no
  packet still counts; the row must sit at the review stage (`:201`).

**`indexDecisionInbox`** (new, E6) — `app/server/projections/notifications.server.ts:148-167`.
One `decisionsRequiring` call at `:152` produces `{ waitingOnYou, waitingBySlug, overrideBySlug }`.
Exactly two callers: `notifications.server.ts:207` (takes `waitingOnYou` only — an org admin's
override reach is governance, not a personal inbox; stated at `:132-137`) and
`home-query.server.ts:107` (takes both, keeping `waiting` and `overrideWaiting` as separate
counters at `:108-112`, rendered side by side at `app/features/home/project-cards.tsx:137-151`).
The *policy* is unchanged from pass 16; what changed is that the split is now made once and cannot
be answered two ways.

**`app/server/projections/review-queue.server.ts`** — `getReviewQueue(db, slug, { viewerUserId, dataRoot })`
`:82-86`. **`viewerUserId` is required and `opts` has no default** (E5):
- `:155-156` `viewerCanGovern = roleCan(viewerRole, "resolve-packet")`, `viewerCanOwn = roleCan(viewerRole, "own-task")`; `viewerRole` is `null` for an unknown/non-member id (`:146-154`).
- `:163-168` `canAccept(key)`: maintainer+ → true; else owner-of-that-task with `own-task`.
- `:174-178` `isReady` additionally requires `waiting === "human"`, no `blockReason`, and
  `pr.state !== "closed"`.
- Rationale for the fail-closed change at `:28-34`: *"an authorization question whose default answer
  was 'yes, anyone'."*

**The board/rail union (UI-48)** — `app/routes/project.tsx:92-99`: `waitingOnMe` is the union of
`decisionsRequiring(...).mine` and `getReviewQueue(...).ready`, derived into *fresh* task objects at
`:100-108` so one viewer's annotation can never leak into another's board.

**Home** — `home-query.server.ts:114` (org admins see every project), `:118-125` (member filter),
`:107-112` (counters). Note the non-viewer-scoped fallback `listHomeProjects` (`:135-258`) computes a
project-global `waiting` in SQL and hardcodes `overrideWaiting: 0` (`:250`); its predicate is
packet-or-recommendation only and omits the acceptance-ready class, so a caller using it directly
gets a *different, lower* number than the viewer-scoped path.

### 3.7 Admin force-accept (DG-2), and R16-3

`forceAcceptCompletion` — `app/server/tasks/task-actions.server.ts:5156-5210`:
1. `requireAction(…, "force-accept-completion", "force-accept past the review gate")` (`:5163-5169`).
2. Already-Done → return, **no misleading audit row** (`:5174-5180`).
3. Re-derives the exact gate being bypassed with the **same** `acceptanceRefusalReason` helper the
   gate uses, so the audit can never name a stale reason (`:5185-5193`).
4. `recordAudit({ action: "task.acceptance.forced", details: { bypassed } })` (`:5194-5202`).
5. Delegates to `acceptCompletion(..., { force: true })` (`:5203-5208`), which sets
   `skipInLockRecheck` on the shared Done write.

**What force-accept can and cannot bypass.** It bypasses the required-reviewer gate, the R15-1
verdict gate, blocked packets, the graph-position gate and the conflicting-PR gate. It can **never**
bypass the PR-head check — and since A2 that is structural, not documentary: `applyAcceptanceWrite`
runs `acceptancePrHeadCheck` **before** the lock and re-asserts the verified `(PR, revision)` pair
**inside** it, and `skipInLockRecheck` explicitly does not relax it
(`task-actions.server.ts:4936-4963`). `completeTaskMerge` — the fourth Done writer, the one the
merge-pending nudge sends humans at — now runs the same check at `:5252-5258`.

**R16-3: the affordance is withheld while the PR is closed.** A PR closed unmerged is not a wedged
gate, it is a decision; forcing past it would move the task to Done over a rejection and stamp
`pr.state: "accepted"` on a PR GitHub already closed.

- Server predicate: `acceptanceTerminallyBlocked(fm) = fm.pr?.state === "closed"` —
  `task-actions.server.ts:4682-4684`, deliberately separate from the refusal *sentence* so the two
  cannot disagree. Surfaced on `AcceptanceAffordance.terminallyBlocked` (`:4846-4848`, set `:4913`).
- UI: `canForceAccept = roleCan(myRole, "force-accept-completion") && !acceptanceTerminallyBlocked`
  — `task-detail-hooks.ts:127-129`; `onForceAccept` is `undefined` otherwise (`:130-138`), the prop
  is conditionally spread (`task-detail-page.tsx:453-455`), and the row renders only when
  `forceAcceptReason && onForceAccept` (`task-side-panels.tsx:58-77`). For a non-admin **and** for a
  closed PR the control is **structurally absent**, not disabled.
- Rail copy switches frame: `"Acceptance is closed."` vs `"Not acceptable yet."`, plus a pointer at
  the recovery packet — `task-side-panels.tsx:546-559`.
- The review queue no longer advertises force-accept on a closed-PR row either:
  `review-helpers.ts:63` returns the PR-state subline before `blockReason`, and
  `rebuilder.server.ts:306-307` hoists `closedPrBlockedReason` above the verdict gate in the
  projected `validation_block_reason`.
- Confirm dialog: `task-detail-page.tsx` → `app/features/task-detail/accept-confirm.tsx` — force
  mode adds a **"Bypassing"** row naming the exact refusal (`:103-108`), the foot hint *"Admin
  override — the bypassed gate is recorded to the audit log."* (`:113-114`) and a `btn danger`.
- Tests: `policy-rbac.server.test.ts:213-225`;
  `app/server/tasks/acceptance-closed-pr.server.test.ts:306-314` (the ordering canary);
  `app/features/task-detail/task-detail-components.test.tsx` ("shows NO force-accept control for a
  non-admin").

---

## 4. Agent capability policy — a *separate* layer

Agent authority is **not** `ACTION_ROLES`. It is the capability catalog in `app/shared/capabilities.ts`
(`UNIFIED_CAP_CATALOG`, `:33-105`, 27 capabilities), stored per agent deployment as
`{ capabilityId, mode }` with `mode ∈ direct | recommend | human | off`
(`app/schemas/project-file.schema.ts:35`, grant schema `:69-76`, deployment field `:131`).
`off` means the capability is withheld entirely (the tool is not even offered); `human` means
reserved for a human. **Neither file changed this pass** — the catalog's last change was pass 15.

### 4.1 ALWAYS_HUMAN — three structural locks

`app/shared/capabilities.ts:162-166`:

```ts
ALWAYS_HUMAN_CAPABILITY_IDS = ["merge-pull-request", "transition-to-done", "change-project-policy"]
```

| Layer | Ref | Behavior |
|---|---|---|
| **Write** (profile save) | `agent-profile-actions.server.ts:184-185` (edit), `:239-240` (create), `:429-431` (deploy from library) | Whatever the form submits, `mode = "human"`. Invariant stated at `:154-158`. |
| **Runtime** (tool policy) | `app/server/tasks/specialist-tool-policy.ts:141` | `isWithheld()` returns `true` unconditionally, **before** the mode lookup → a stored `direct` cannot unlock it; mapped tools land in `disallowedTools` (e.g. `Bash(gh pr merge:*)` `:65`). |
| **Metadata** | `capabilities.ts:230` | `capabilityEnforcement()` checks ALWAYS_HUMAN **before** the claude-only set so `merge-pull-request` is never mislabeled "advisory on Codex". |
| **Display** | `app/features/policy/policy-data.ts:65-77` | `ALWAYS_HUMAN_ROWS` are built by mapping the server invariant list — never hard-coded UI strings. |

**The one honest exception, still accurate.** `transition-to-done` carries an exception string
(`policy-data.ts:73-76`); `merge-pull-request` and `change-project-policy` carry `exception: null`.
An operator at **full** autonomy holding an explicit `completion-for-acceptance: direct` grant closes
the task itself:
- `gate()` refuses to promote `recommend → direct` for that one id —
  `app/server/tasks/operator-actions.server.ts:286`.
- `operatorAcceptCompletion` falls back to a recommendation unless both conditions hold —
  `operator-actions.server.ts:2005`.
- Read model for the disclosure copy: `app/features/review/review-acceptance-authority.server.ts:29-46`
  (fails closed on an unreadable project file). Prose: `policy-page.tsx:494-508`,
  `review-page.tsx:142-151`.

**R16-6 confirms merge stays human-only.** The consequence — a full-autonomy task reaches the done
stage with its PR still open, so "Done" means two things by preset — is now *drawn* rather than
hidden: `prStatePill` (`app/features/github/github-pills.ts:47-52`) maps `accepted → "merge pending"`
and `closed → "closed"`, and the board card renders it for exactly those two states
(`board-page.tsx:281-307`; `merged` and `review` stay silent). Same mapping on task detail
(`task-side-panels.tsx:119-123`) and the GitHub view (`github-view.tsx:162`, `:246`).

### 4.2 Specialist cap

Specialists have no `recommend` mode: `coerceSpecialistCapabilityMode(mode) = mode === "recommend" ? "direct" : mode`
— `capabilities.ts:280-282`. Applied at:

| Site | Context |
|---|---|
| `agent-profile-actions.server.ts:182` | edit path |
| `agent-profile-actions.server.ts:252` | create path |
| `agent-profile-actions.server.ts:431` | deploy-from-library |
| `app/features/agents/agents-query.server.ts:285` | read side (`effectiveProfileView`) |
| `app/server/tasks/specialist-run.server.ts:1908` | `listDeployedSpecialists` |

**Exception:** `report-validation-verdict` is **explicit-`direct`-only** and must NOT run through the
coercion — anything other than `direct` persists `off` (`agent-profile-actions.server.ts:175-180`
edit, `:247-251` create). The runtime twin is `effectiveCollabMode`
(`app/server/tasks/agent-outcome.server.ts:300-321`), where `recommend` falls through to the catalog
default (`off`): coercing it would silently arm verdict-veto power on a delivering developer.

### 4.3 Polarity rules a future agent will trip on

- **`capabilities: []` is not "no powers."** An unspecified capability reads as GRANTED at the tool
  layer, which is why every creation path materializes explicit grants — `capabilities.ts:110-123`,
  conservative variant `:143-154`, create-path loop `agent-profile-actions.server.ts:220-258`,
  explicit-off list `app/features/agents/capability-catalog.ts:90-95`.
- **`applyVerdictOutcomeGate`** (`capabilities.ts:263-277`): a verdict outcome (`approve-review`,
  `request-changes`, `post-quality-flags`) renders as not-granted unless
  `report-validation-verdict === "direct"` (`:271`).
- **`repairDeliveryGrants`** (`capabilities.ts:324-366`, scoped ids `:287-291`): an **absent**
  `execute-code-or-write-repo` headline is materialized `direct` when scoped delivery grants are
  actionable; an **explicit** `off` is respected and reported (B-AG1, `:341-353`).
- **The master gate at the enforcement layer never overturns an explicit withholding.**
  `specialist-tool-policy.ts:127-135` repairs only an *absent* headline (`if (modes.has("execute-code-or-write-repo")) return modes;`),
  with the reason at `:118-125`; `resolveDeliveryPermissions` (`:194-213`) then gates all three
  scoped steps behind it:
  ```ts
  const repoWriteWithheld = isWithheld(modeById, "execute-code-or-write-repo");
  canBranch:     !repoWriteWithheld && !isWithheld(modeById, "create-task-branch"),
  canCommitPush: !repoWriteWithheld && !isWithheld(modeById, "commit-push-branch"),
  canOpenPr:     !repoWriteWithheld && !isWithheld(modeById, "open-review-pr"),
  ```
  Absence-is-withholding is enumerated in `GRANT_REQUIRED_CAPABILITY_IDS` (`:102-109`).
- **`absentDeliverReviewPrMode`** (`capabilities.ts:397-401`): an absent `deliver-review-pr` grant
  resolves to `recommend` on a human-gated-before-work project, else `direct` (R15-9).

### 4.4 MCP stays outside the matrix (R16-5)

Viberr cannot know what a third-party tool does, so it does not pretend to bound one: **granting a
server IS the grant.** An agent whose `execute-code-or-write-repo` is withheld still gets whatever a
granted server's tools can do.

- **User-facing disclosure:** `app/features/agents/capability-matrix-modal.tsx:229-244` — names the
  consequence explicitly ("A server whose tools write files or run commands gives an agent those
  powers even when *Execute code / write to the repo* is withheld — granting a server IS the grant").
- **Run-side disclosure:** `specialist-run.server.ts:1165-1182` — the system prompt states the one
  rule Viberr *can* enforce (never merge, close a task, or change policy via an MCP tool).
- **The test that makes the gap a decision instead of an oversight:**
  `app/server/tasks/specialist-tool-policy.test.ts:290-343` pins the **absence** of an `mcp__*` deny
  rule, including a cross-product over every mode × the six grant-required capabilities. Rationale at
  `:299-303`: the "obvious fix" would silently revoke every read-only MCP server an operator granted
  on purpose.

### 4.5 Operator authority requires a deployment (A4)

`gate(authority, capabilityId)` returns `"deny"` when `!authority.deployed`
(`operator-actions.server.ts:277`), and `deliverGate` does the same **before** its absent-means-granted
fallback (`:314`). Without this, a project with no operator deployed carried an empty policy, `policy.has`
was false, and the R15-9 fallback resolved to `direct` — an undeployed operator could push a branch and
open a PR. Denied there rather than at the call sites because four of the five `runOperator` entry
points never check `authority.deployed`.

---

## 5. Governance flows

### 5.1 Who transitions stages

`transitionStage` — `app/server/tasks/task-actions.server.ts:2971`, guard block `:3036-3102`:

| Path | Guard |
|---|---|
| Terminal stage reached without `operatorAuthorized` | routed into the full `acceptCompletion` contract (`:3040-3057`) — never a bare transition |
| `ctx.operatorAuthorized` | human RBAC skipped (the operator's capability policy gates upstream); terminal stage explicitly refused: *"The operator reaches Done only by accepting completion, not a bare transition."* (`:3060-3069`) |
| `input.manual` (board/task dropdown) | `approve-transition` — forward, backward or off-graph alike (`:3078`); **R15-3**: `recommendationAuthorized` (owner clicked Apply) relaxes it to the archived-freeze check only (`:3075-3076`) |
| declared `auto` boundary crossed by a human | `requireAnyMember` (`:3083`) — unreachable from the UI, which always sends `manual: true` |
| declared `approval` boundary | `approve-transition` (`:3090`), same R15-3 relaxation (`:3085-3088`) |
| declared `human` boundary (review→done, locked in V1) | `requireAcceptCompletion` — maintainer+ **or** the task owner (R6-2) (`:3095-3101`) |

**Stage roles are derived, never hardcoded** — `app/shared/workflow/stage-roles.ts:41-68`:
`entryId = stages[0]`, `terminalId = stages[len-1]`, `reviewId` = the stage with a workflow edge into
terminal (fallback `stages[len-2]`), `workId` = the stage with an edge into review. Nothing in the
app may test `stage === "done"` (`:3-23`). Locked stages are entry and terminal —
`stageLockReason` `:31-39` ("it's the entry point" / "human acceptance stays terminal"), consumed by
`settings-page.tsx:640`, `:720` and `settings-actions.server.ts:485`.

**Boundary policy edits:** `setTransitionBoundary` (`app/features/policy/policy-actions.server.ts:179-235`)
requires `edit-policy` (`:185`, the first statement in the body) and **hard-rejects** `rule.locked`
**or** any non-`human` boundary into the last stage (`:208-212`) with
`"Completion is human-authorized in V1 — this boundary can't be delegated"` (`:170-171`).

### 5.2 Stage-role eligibility (agents, R14-1)

A distinct layer from human transitions: which *agent profile* may work a given stage.

- `app/shared/workflow/stage-eligibility.ts:136-147` — `stageEligible(spec, stageId, stages, workflow)`.
  Three resolution steps, most specific first (`:14-24`): **literal id** → **structural role**
  (`entry | ready | work | review | terminal`, alias table `:34-55`, per-board role sets
  `boardStageRoles` `:69-102`) → **meaningless declaration** (nothing resolves on this board ⇒
  unrestricted, `:145`). `spanAll` and an empty `stages` list are unrestricted too (`:142-143`).
- Enforcement: `assertStageEligible` — `app/server/tasks/specialist-run.server.ts:1860-1877`, called
  from `assignSpecialist` (`:306`), `assignReviewer` (`:443`) and `startAgentRun` (`:724`). It throws
  a validation error naming the resolved scope; the Agents UI's "N of M stages" promise is what it
  makes real.
- The failure it exists to prevent: a profile declaring `impl` deployed onto a `todo/doing/done`
  board matched nothing and became eligible for zero stages, leaving a task no agent could work
  (P14-WL-01).

### 5.3 Delivery gating (R15-2)

Delivery = push the task branch + open the review PR. **Agents never push**; the server executes the
mechanics (`performDelivery`, `task-actions.server.ts:3332`).

Three authorized entry points:
1. **Operator tool** `deliver_for_review` — gated by `deliverGate` (`operator-actions.server.ts:301-330`),
   which now denies an undeployed operator (§4.5) and otherwise resolves `deliver-review-pr`
   (absent → `absentDeliverReviewPrMode`).
2. **Applied `delivery` recommendation** — the human's Apply click.
3. **Manual button** — `manualDeliverForReview` (`:3593-3635`): owner exception (`:3602`), else
   `run-agents` (`:3607`); audited as `github.delivery.manual`.

Independently, the *delivering agent's* push grant is re-resolved from its capability profile:
`resolveDeliveryPushGrant` (`:3273-3294`) → `resolveDeliveryPermissions(...).canCommitPush`, with a
conservative **deny** when the profile can no longer be resolved (`:3290-3293`). This is where the
`execute-code-or-write-repo` master gate reaches delivery.

`DeliveryOutcome` (`:3300-3318`) names every failure: `push_conflict` (non-fast-forward remote — no
PR opened over stale content), `grant_withheld`, `push_failed`, `nothing_to_review`, `failed`.
**A3:** every non-`pushed` push status now has its own refusal and its own timeline event
(`:3418-3455`); `no_commits` maps to `nothing_to_review`, the rest to `failed`, and none of them fall
through to `openTaskPr` any more.

UI affordance mirror: `app/routes/project.task.tsx:212-216`
`canDeliver = roleCan(myProjectRole, "run-agents") || user.role === "admin" || (owner && roleCan(myProjectRole, "own-task"))`.

**R16-1 — PR adoption.** A pull request Viberr did not just open becomes a task's PR only if it is
**OPEN** *and* its head sha **is** the delivered revision — identity, not containment, deliberately
stricter than the acceptance gate (which tolerates a commit on top of the delivery).
`decidePrAdoption` — `app/server/github/pr-adoption.server.ts:46-61`; refusal vocabulary `:32-40`
(`not_open | no_revision | head_unknown | head_mismatch`); one shared collision sentence
`prAdoptionRefusalNote` `:89+`. Three call sites, one rule: `pr-open.server.ts:238`,
`workspace-delivery.server.ts:476`, `github-reconciler.server.ts:291`. This is a governance concern,
not just a GitHub one: a foreign merged PR bound by branch name gave a task a green "merged" badge
for work never delivered, and (with A2 unfixed) an operator could have accepted it.

### 5.4 Who reviews — revision-bound, engage-time-snapshotted verdicts

Review authority is per-task, carried on **engagements** in the task file
(`app/schemas/task-file.schema.ts`, unchanged this pass):

- `engagementSchema` — `:107-121`: `{ profileId, backend, role, delivers (default false, :113), verdictCapable (default false, :119) }`, `.loose()`.
- **At most one engagement has `delivers: true`** (the workspace/branch/PR owner) — stated `:102-103`,
  enforced by a demotion loop at `:818-833` that writes a `multiple_deliverers` diagnostic.
- `deliveringEngagement` `:125-129`, `supportingEngagements` `:132-136`,
  `requiredReviewers` `:511-513` (`!delivers && verdictCapable`).
- **`verdictCapable` is an engage-time snapshot** of the profile's `report-validation-verdict` grant —
  `specialist-run.server.ts:364` (delivering) and `:484` (supporting), via
  `resolveAgentCollab(...).verdict` (`agent-outcome.server.ts:326-337`).
- **Verdict *recording* reads the same snapshot**, not the live grant —
  `task-actions.server.ts:2265-2274`; the live grant survives only as a legacy fallback for an
  engagement that predates the field. Reason (`:2257-2264`): a required reviewer whose live grant was
  later removed could otherwise approve but never record, leaving the task permanently un-acceptable.
- **Verdicts bind to the current work revision**: `currentVerdicts` `:516-523`; recording
  `task-actions.server.ts:1894-1920` (last-write-wins per profile per revision).
- `deriveValidation` `:529-547`: `failing` if any required reviewer requested changes on the current
  revision; `healthy` when every required reviewer approved it; `changed` while pending; `none`
  before delivery. It is the **single writer** of the `validation` cache field
  (`task-file.schema.ts:475-477`).

### 5.5 The acceptance gate chain

`acceptanceRefusalReason(project, fm, taskKey, { blockedPacket })` —
`task-actions.server.ts:4638-4669`, **in this order**:

1. `archivedTaskBlockedReason` (`task-file.schema.ts:629-635`) — R14-3.
2. **`closedPrBlockedReason`** (`task-file.schema.ts:589-595`) — **R16-3, moved here from position 6.**
   A PR closed unmerged is a rejection; running a review is not the path, and neither is
   force-accept. The rationale is written into the code at `:4647-4654`, naming the live H10 failure
   where the rail said "no approving verdict yet — … or an admin can force-accept" beside a packet
   that said the PR was gone.
3. `acceptanceStageBlockedReason` (`:4577-4602`) — acceptance may only be exercised **from** the
   review stage or a stage with a declared edge into terminal. Deliberately does **not** mention
   force-accept (`:4595-4600`): a task that has not reached the boundary is not wedged.
4. `acceptanceBlockedReason` (`task-file.schema.ts:553-571`) — every required reviewer must have
   approved the current revision; none may have requested changes (F10-15).
5. `verdictGateReason` (`:4615-4627`, **R15-1**) — delivered work (`workRevision` set) needs a PR
   *and* `deriveValidation === "healthy"`. Work with no revision stays acceptable (planning /
   non-repo tasks).
6. open blocked packet.
7. `conflictingPrBlockedReason` (`task-file.schema.ts:610-618`) — a conflicting PR cannot be merged,
   so it cannot be accepted.

Plus the live GitHub check (R15-1 gate 2 / F15-15): the PR head must **contain** the delivered
revision. `AcceptancePrHeadCheck` `:4696-4701`, `acceptancePrHeadCheck` `:4716`,
`assertVerifiedHeadStillApplies` `:4737`, thin refusal-only wrapper `acceptancePrHeadMismatch`
`:4755`. Returns `null` when unverifiable (offline, no PR, already merged). As of A2 it runs at
**four** call sites — the packet `accept_completion` path (`:4118`), `applyAcceptanceWrite`'s own
fallback (`:4960`), `acceptCompletion` (`:5053`, threaded into the write so the shared path pays for
one read) and `completeTaskMerge` (`:5252`) — and is re-asserted under the write lock
(`assertVerifiedHeadStillApplies`, `:4963`), where `skipInLockRecheck` does not reach it.

The **projection** mirror must track the same order: `acceptanceBlockReason` in
`app/server/projections/rebuilder.server.ts:294-321` hoists `closedPrBlockedReason` to first
(`:306-307`), and writes into `task_projections.validation_block_reason` (`:472`), which the review
queue reads as `blockReason` (`app/shared/mapping/task.server.ts:295`).

`resolveAcceptanceAffordance` (`task-actions.server.ts:4864-4915`) is the DB-free read both the task
page and the review queue use: `hasAuthority = roleCan(role, "accept-completion") || (owner && roleCan(role, "own-task"))`
(`:4888-4890`); archived project → no acceptance from any role (`:4892`); already-terminal → nothing
to accept (`:4900-4902`); `terminallyBlocked` (`:4913`).

The operator reuses the identical gate: `operatorAcceptCompletion`
(`app/server/tasks/operator-actions.server.ts:1960+`) calls `acceptanceRefusalFor` (`:1993`) before
**both** branches, then recommends unless `autonomy === "full"` **and**
`gate(authority, "completion-for-acceptance") === "direct"` (`:2005`), and writes through the shared
`applyAcceptanceWrite` (`:2043`).

### 5.6 Owner authority (R6-2 / R14-2 / R15-3)

`ownerException` (`task-actions.server.ts:321-332`) = live owner **and** holds `own-task`
(contributor+). It widens exactly three outer gates:

| Gate | Helper | Ref |
|---|---|---|
| Acceptance (and merge completion) | `requireAcceptCompletion` | `:335-344`, used at `:3095`, `:4087`, `:5014`, `:5228` |
| Packet / recommendation decisions | `requireDecisionAuthority` | `:359-368` |
| Manual delivery | inline | `:3602-3614` |

**It never widens the inner mutation.** `applyRecommendation` computes
`asCoordination(needed) = ownerApplied && !roleCan(actorRole, needed)` (`:5339-5340`) and, when true,
re-runs the inner mutation as `OPERATOR_TASK_ACTOR` with `operatorAuthorized: true` (`:5341-5342`,
`:5403`) — *"the packet is the human decision; the execution is coordination machinery"*.

The `archive_task` packet option is the deliberate counter-example: it re-checks `approve-transition`
*inside* the case (`:4300-4318`), so a contributor-owner gets an honest 403 rather than a silent
widening of R14-3.

### 5.7 Decision packets

- `resolvePacket` `:4021`; the guard block `:4061-4073` has three branches: `accept_completion` is
  **not** gated on `resolve-packet` at all (it would block a contributor-owner before the owner check
  runs) and routes to `requireAcceptCompletion` inside its case (`:4087`); an owner skips the
  maintainer gate; everyone else needs `resolve-packet`.
- `ownerException` here additionally requires **current** contributor+ membership
  (adversarial-review #8): a user removed from the project who still holds a stale `ownerUserId`
  must not resolve packets (`:4058-4063`).
- Packet identity/dedupe: `packetIdentity` `:4005-4019`, snapshotted before any await (`:4050`).
- UI mirror: `task-detail-page.tsx:189` (`canResolvePacket`), `:195` (`canDecideOwned`),
  `:201-204` (`canArchiveViaPacket` → `approve-transition`).

### 5.8 Secondary assignments

Supporting engagements (the old "reviewers"):
- Add: `assignReviewer` (`specialist-run.server.ts:421`) — `run-agents` + `assertStageEligible` (`:443`).
- Remove: `removeReviewer` (`:531`, guard `:537`) — `run-agents`.
- Run: `startAgentRun({ profileId })` (`:589`) — `run-agents`; omitting `profileId` runs the
  delivering engagement.
- Only supporting engagements with `verdictCapable` become **required reviewers** and gate acceptance
  (§5.4).
- Route intents: `assign-reviewer`, `run-reviewer`, `remove-reviewer` — `app/routes/project.task.tsx`.

---

## 6. Test matrix

### 6.1 The canonical fixture

`test-support/test-store.ts:73-79` — one project `viberr-core` (slug at `:81`), five users:

| Fixture | Org role | Project role | Line |
|---|---|---|---|
| `store.users.arda` | `admin` | `admin` | `:74` |
| `store.users.murat` | `member` | `maintainer` | `:75` |
| `store.users.selin` | `member` | `contributor` | `:76` |
| `store.users.elif` | `member` | `viewer` | `:77` |
| `store.users.deniz` | `member` | *(non-member)* | `:78` |
| `u_orgadmin` (created in-test) | `admin` | *(non-member)* — the D2 subject | `policy-rbac.server.test.ts:79-102` |

The D2 subject is created in the test rather than taken from the fixture precisely because `arda` is
org admin *and* project admin and would never exercise the override.

⚠ The file-header comment at `test-support/test-store.ts:26` still says "selin → reviewer" — a role
that does not exist in `ProjectRole`. Cite line 76, not the comment.

### 6.2 Expected outcome per (action, role)

`ALLOW` = the guard let the call through (it either succeeded or failed with a **non-403** downstream
error). `DENY` = 403. That is exactly the classifier `guardAllowed()` uses
(`policy-rbac.server.test.ts:69-77`), which is what lets a driver pass a deliberately-invalid payload
(`recId: "nope"`, `profileId: "does-not-exist"`, `form: {}`) and still read the gate cleanly.

| Action id | admin | maintainer | contributor | viewer | non-member | org-admin non-member |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `view` | ALLOW | ALLOW | ALLOW | ALLOW | DENY (404 at the route, R15-4) | ALLOW, no audit row |
| `comment` | ALLOW | ALLOW | ALLOW | ALLOW | DENY (404, refused before a byte is written) | ALLOW, no audit row |
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

Plus the per-task widenings that this table cannot express: a **contributor owner** ALLOWs
`accept-completion`, `resolve-packet` and manual delivery on *their own* task (§5.6), asserted
directly at `policy-rbac.server.test.ts:317-342`.

### 6.3 Drivers — the E7 gap is closed

| Action | Driver | Line |
|---|---|---|
| `force-accept-completion` | `forceAcceptCompletion` | `:213` |
| `create-task` | `createTask` | `:226` |
| `own-task` | `setOwner({ targetUserId: self })` | `:233` |
| `approve-transition` | `transitionStage({ manual: true })` + `resetTaskStage("impl")` | `:239` |
| `update-goal` | `updateTaskGoal` | `:250` |
| `reorder-board` | `reorderTask` | `:256` |
| `resolve-packet` | `dismissRecommendation` / `applyRecommendation` (the latter also pins that authorization precedes the task read — F20) | `:262`, `:268` |
| `run-agents` | `assignSpecialist` | `:279` |
| `rescan-project` | `assertProjectAction` | `:285` |
| `reconcile-github` | `assertProjectAction` | `:291` |
| **`accept-completion`** | `completeTaskMerge` (on an *unowned* task so R6-2 cannot mask the tier) | `:304` |
| **`grant-github-scope`** | `assertProjectAction` | `:343` |
| **`release-any-ownership`** | `releaseOwner` against a *foreign* owner, with `resetTaskOwner(deniz)` | `:356` |
| **`manage-members`** | `inviteMember` | `:373` |
| **`manage-agents`** | `createAgentProfile({ form: {} })` | `:389` |
| **`edit-policy`** | `updateProjectIdentity` | `:399` |
| **`view` / `comment`** | *not* through `assertMatchesMatrix` — they are not `RbacAction`s at the guard layer (it takes the `"any-member"` sentinel). Driven as membership per role instead: `visibilityGate` `:664`, `commentAs` `:682` (a viewer may comment; a non-member's comment never reaches the file, asserted at `:694`) | `:600-696` |

### 6.4 Additional invariants asserted

| Invariant | Ref |
|---|---|
| `ROLE_RANK` strictly monotonic | `:187-191` |
| Every `ACTION_ROLES` set is a rank floor (derived from `RBAC_DEFINITIONS`) | `:193-211` |
| **The matrix equals the hand-written governance table** | `:730-735` |
| **No action exists without a governance decision** (key-set equality) | `:737-741` |
| Ownership hand-off target must hold `own-task` (a viewer target is rejected) | `:444-464` |
| Archived project → refusal before the role check, even for an admin | `:415-442` |
| Override audits exactly once per governed mutation | `:146-161`, `:472-504` |
| `"any-member"` reads audit **zero** rows | `:505-524` |
| Org admin within a sufficient membership role is **not** an override | `:525-545` |
| A plain org member who is a non-member stays denied | `:546-566` |
| `reorder-board ⊆ approve-transition` (a drag must not 403 after the visible gate passed) | `:576-589` |

### 6.5 Non-RBAC gates to test alongside

- **Archived project** (409, all roles) and **archived task** (`archivedTaskBlockedReason`).
- **CSRF**: every form action must reject a missing/invalid `_csrf` with 403, **and** a request with
  no origin signal at all (`csrf.server.test.ts:114-122`).
- **R15-4 secrecy**: a non-member must get **404**, not 403 — on the layout loader, on
  `?_routes=routes/project.task` single-fetch, and on **all six** route actions
  (`project.board.server.test.ts`, `project-visibility-actions.server.test.ts`,
  `project-visibility.server.test.ts`).
- **Auth allow-list**: `/api/auth/update-user` and `/api/auth/forget-password` must 404
  (`app/lib/auth.server.test.ts:82-97`).
- **R16-3 ordering canary**: `app/server/tasks/acceptance-closed-pr.server.test.ts:306-314`.

---

## 7. Adjacent surfaces (auth / CSRF) — one change

`app/lib/auth.server.ts`, `app/server/auth/require-user.server.ts` and
`app/server/auth/seed-admin.server.ts` are **unchanged**; §4 of the pass-16 doc is still accurate for
better-auth integration, the six-entry `ALLOWED_AUTH_PATHS` allow-list
(`app/lib/auth.server.ts:53-60`, enforced `:218`), session handling, the disabled-user hard-signout
(`require-user.server.ts:88-91`), and the org-role gate (`requireRole` `:201-208`, `requireRoleAuth`
`:215-221`).

**The one change is CSRF (A7).** `app/server/auth/csrf.server.ts`:
- `CSRF_FIELD_NAME = "_csrf"` `:17`; derivation (not storage)
  `HMAC-SHA256(VIBERR_SESSION_SECRET, "viberr-csrf:" + sessionId).digest("base64url")` `:20-24`.
- `assertTrustedOrigin` `:57-94` now: rejects a non-`same-origin`/`none` `Sec-Fetch-Site` (`:58-65`),
  an unparseable request URL (`:66-71`), `Origin: null` (`:73`), a mismatched `Origin` (`:74-76`),
  and — **new** — a mismatched or unparseable `Referer` when one is present (`:79-90`).
- **New, and the reversal of a documented pass-16 fact:** a request carrying *none* of the three
  signals now **fails closed** — `:91-93`
  `if (!secFetchSite && !origin && !referer) throw forbidden("Request origin could not be verified.");`
  Reason at `:47-55`: nothing in the app is such a caller, so the concession "bought nothing and
  turned a defense-in-depth layer into a header any attacker can simply omit."
- Token check `assertCsrfWithSecret` `:97-122`: origin first (`:103`), then `X-Csrf-Token` header
  else the `_csrf` field, then `timingSafeEqual` with a length pre-check.
- **The wrapper every project action uses:** `app/server/auth/form-action.server.ts:7-19` —
  `requireAuth → getDb → request.formData() → assertCsrf`. Seven callers: `_index.tsx:72`,
  `project.board.tsx:24`, `project.task.tsx:305`, `project.policy.tsx:39`, `project.settings.tsx:57`,
  `project.agents.tsx:100`, `project.github.tsx:43`. **Any new form action must go through this or it
  has no CSRF.** Direct `assertCsrf` callers: `logout.tsx:15`, `login.tsx:122`, `org.settings.tsx:108`,
  `app/features/shell/csrf-result.server.ts:25`. Direct `assertTrustedOrigin`: `login.tsx:57` (the
  sessionless login POST).

---

## 8. Known asymmetries and suspicious spots (current)

Each item is an observation with a path ref, not a prescribed fix. The pass-16 §7 items not repeated
here were closed — see §0.2.

**8.1 Two stale docblocks that contradict enforcement.**
- `test-support/test-store.ts:26` — "selin → reviewer"; `reviewer` is not a `ProjectRole` and the
  fixture writes `contributor` (`:76`). Every consumer, including `policy-rbac.server.test.ts:111`,
  reads `contributor`.
- **`app/server/auth/require-project.server.ts:10-12`** (newly identified) — "FR4 keeps the board,
  task detail, and timelines readable app-wide (anyone may comment on any task)". R15-4 superseded
  this; `app/shared/rbac.ts:50-60` and the `view + comment` suite
  (`policy-rbac.server.test.ts:600-696`) both say the opposite. This is the same class of defect E1
  fixed on the Policy page, surviving in a server comment.
- Minor: `app/features/review/review-acceptance-authority.server.ts:14-15` cites
  `operator-actions.server.ts:229` / `:1632`; the real lines are `:286` and `:2005`.

**8.2 The org-admin override reaches *everything*, including `force-accept-completion`.**
`project-authority.server.ts:181-204` grants `role: "admin"` for any action when the member role
falls short, so the DG-2 escape hatch is available to any org admin on any project without a
membership. The binding test asserts this as correct (`policy-rbac.server.test.ts:213-225` +
`:146-161`). Not a bug — but "admin only" in §2.1 means *project admin **or** any org admin*.

**8.3 `appendComment` has no authorization of its own.**
`task-actions.server.ts:759-776` performs only the archived-project check. Its entire access control
is the caller's `requireVisibleProject` (`project.task.tsx:312`). Any future comment entry point that
forgets that call is unauthenticated-by-membership. Related: `commentToAgent` routes the @mention run
through `canRunAgents` with `silentDeny: true` (`:1411`), so a lower-role commenter's mention is
recorded and the run silently skipped — deliberate, easy to misread as a bug.

**8.4 Two sources for `memberRoles` (file vs projection).**
`assertProjectAction` reads `project.md` fresh (`project-authority.server.ts:337-343`);
`runAgentsAuthority` reads the `project_members` projection (`project.task.tsx:284-300`), as does
`review-queue.server.ts:146-154`. A projection lag would make the run-agents gate and the
config-surface gate disagree. `RU #8` (quoted at `project.task.tsx:287-289`) flags the shape-drift
risk; the *source* difference is still flagged nowhere.

**8.5 `resolveAcceptanceAffordance` is a second implementation of the acceptance predicate.**
`task-actions.server.ts:4861-4863` — "A pure READ … never calls the audited authority path." Correct
for a loader (no denial rows on every page load), but it duplicates `roleCan(role,"accept-completion") || (owner && roleCan(role,"own-task"))`
rather than calling `resolveProjectAuthority`, and can drift from `requireAcceptCompletion`.

**8.6 `runsVisible`'s false branch is unreachable dead code.**
`app/routes/project.task.tsx:141` computes `runsVisible = runsMembership.has(user.id) || user.role === "admin"`,
but `requireVisibleProject` at `:103-108` has already guaranteed the viewer is a member **or** an org
admin. The withheld-projection branch (`:150-164`) and its UI counterpart
(`task-detail-page.tsx:420-432`, "Raw agent output … limited to project members.") can never render.

**8.7 The two RBAC tables carry different footnotes.**
`policy-page.tsx:211-231` states members-only + owner exception + org-admin override;
`profile-page.tsx:480-497` states only "Your role is assigned by an admin and enforced on every
action." Nothing false is shown, but a member reading their own profile does not learn the three
rules that reach beyond the table.

**8.8 Six controls still refuse silently (the whole D− surface).**
`settings-page.tsx:101`, `:115`, `:129`, `:562`, `:591`, `:1124`. Every other RBAC refusal in the app
is either hidden or disabled with visible text. The codebase already states the rule —
`task-side-panels.tsx:541-542`: *"The reason has to be TEXT, not a `title`: a disabled control gets no
pointer events, so a tooltip on it never opens."*

**8.9 `listHomeProjects` answers "waiting" differently from `listHomeProjectsForUser`.**
`home-query.server.ts:135-258` computes a project-global count in SQL, hardcodes `overrideWaiting: 0`
(`:250`), and its predicate omits the acceptance-ready class the viewer-scoped path unions in. It is
documented as the fallback that `listHomeProjectsForUser` overwrites (`:246-249`), but a direct caller
would silently get a lower number.

**8.10 `resolvePacket`'s guard has three branches and one of them is a deliberate no-op.**
`task-actions.server.ts:4064-4067` — the `accept_completion` option intentionally passes the outer
guard so `requireAcceptCompletion` inside the case can apply the R6-2 owner exception. The empty
`if` branch is load-bearing; a "cleanup" that folds it into the `else` would 403 every
contributor-owner accepting from a packet.

**8.11 R16-1 does not un-adopt a PR bound before the rule existed.**
`github-reconciler.server.ts:288` treats a discovery matching the cached number as an owned link and
keeps its live facts — right in general (a task's own PR moves its head), but a task polluted before
the rule still carries the foreign PR in its `task.md`. Recovery exists (the operator raises the
branch-collision packet; `archive_task(+deleteBranch)`), and no new task can be polluted; a self-heal
would need its own rule about when Viberr may drop a PR reference it once wrote.
