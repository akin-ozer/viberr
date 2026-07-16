# Viberr Role-Bindings / RBAC Inventory (main HEAD 8d285bc, 2026-07-16)

Complete current-state map of the role-bindings system, produced for the pass-7 rework.
Three INDEPENDENT authorization surfaces coexist and must not be conflated:

- **Project roles** (`admin | maintainer | contributor | viewer`) — ACTION_ROLES / `requireAction`.
- **Org roles** (`admin | member`) — better-auth membership, `requireRole`.
- **Agent capability grants** (`direct | recommend | human | off`) — per-profile, separate surface.

## 1. `app/shared/rbac.ts` — single source of truth

Roles defined in `app/schemas/project-file.schema.ts:23` (`PROJECT_ROLES`); legacy `reviewer`
coerces → `contributor` at parse (`coerceProjectRole`, :28-30).

`ROLE_RANK` (rbac.ts:27-32): viewer 0 < contributor 1 < maintainer 2 < admin 3.
`ACTION_ROLES` (rbac.ts:75-95), verbatim:

| RbacAction | admin | maintainer | contributor | viewer |
|---|:-:|:-:|:-:|:-:|
| view | ✓ | ✓ | ✓ | ✓ |
| comment | ✓ | ✓ | ✓ | ✓ |
| create-task | ✓ | ✓ | ✓ | — |
| own-task | ✓ | ✓ | ✓ | — |
| reconcile-github | ✓ | ✓ | ✓ | — |
| approve-transition | ✓ | ✓ | — | — |
| resolve-packet | ✓ | ✓ | — | — |
| accept-completion | ✓ | ✓ | — | — |
| run-agents | ✓ | ✓ | — | — |
| reorder-board | ✓ | ✓ | — | — |
| update-goal | ✓ | ✓ | — | — |
| grant-github-scope | ✓ | ✓ | — | — |
| release-any-ownership | ✓ | — | — | — |
| manage-members | ✓ | — | — | — |
| manage-agents | ✓ | — | — | — |
| edit-policy | ✓ | — | — | — |

Design notes baked into the file (rbac.ts:3-23): monotonic tiers (every action is a rank floor);
`view`/`comment` are app-wide (FR4) — in the map only for Policy-table rendering, enforced as
"authenticated" not "member"; project settings ride `edit-policy` (no separate `edit-settings`).
Helpers: `roleCan` (:98-101, null→false), `rolesForAction` (:104-106), `RBAC_TABLE` (:113-126,
display rows pulled from ACTION_ROLES so display can't drift).

## 2. Server guards and every call site

Two idioms, both re-read project.md fresh: **action-id** (`requireAction`,
`assertProjectAction`) and **role-list** (`requireProjectRole`/`requireMemberRole`).

### requireAction — task-actions.server.ts:344-355
(archive gate → `requireMemberRole(project, actor, rolesForAction(action))`)

| Call site | Function | action |
|---|---|---|
| :458 | createTask | create-task |
| :556 | updateTaskGoal | update-goal |
| :1967 | setOwner (take/hand off) | own-task |
| :2097 | releaseOwner (self) | own-task |
| :2100 | releaseOwner (other) | release-any-ownership |
| :2228 | transitionStage (manual) | approve-transition |
| :2234 | transitionStage (approval boundary) | approve-transition |
| :2517 | reorderTask | reorder-board |
| :2641 | resolvePacket (non-accept, non-owner) | resolve-packet |
| :3104 | dismissRecommendation | resolve-packet |
| :380 | requireAcceptCompletion fallback | accept-completion |

`requireMemberRole "any-member"`: releaseOwner idempotent path (:2090); transitionStage `auto`
boundary crossed by human (:2232 — UI always sends manual:true, so effectively unreachable).

**Owner exceptions:**
- `requireAcceptCompletion` (:369-381): task's human owner w/ live `own-task` (contributor+) may
  accept its own completion (R6-2). 4 call sites: :2238 (human boundary transition), :2656
  (resolvePacket accept option), :2838 (acceptCompletion), :2944 (completeTaskMerge).
- SEPARATE inline owner exception in resolvePacket for non-completion options (:2628-2642) (Q2).
- setOwner hand-off (:1982-1990): hardcoded `actorRole !== "admin"` + target-must-hold-own-task.

### assertProjectAction — project-role-guard.server.ts:15-61
(fresh project.md read + own inline archived gate :36-43 + rolesForAction check)

| Wrapper | action | Operations |
|---|---|---|
| settings-actions.server.ts:94 `requireProjectAdmin` | edit-policy | identity, stages ×4, repo-override, archive/restore (:499, restore allowArchived), delete (:541 allowArchived), **inviteMember (:355), removeMember (:403)** |
| agent-profile-actions.server.ts:101 `requireProjectAdmin` | manage-agents | profile create/update/delete (:198,:270,:348) |
| policy-actions.server.ts:67 `requirePolicyAction` | manage-members (setMemberRole :102) / edit-policy (setTransitionBoundary :186) | |

### requireProjectRole — task-actions.server.ts:229-240
- require-project.server.ts:29 → `requireProjectMember` (route read guard, allowArchived,
  "any-member"); loaders: activity :40, settings :56, github :31, review :26, policy :27, agents :33.
- **project.board.tsx:83 — board rescan hardcodes `["admin","maintainer"]`** (no RbacAction).

### requireRole (org) — require-user.server.ts:173-194
Only org.settings.tsx:69 (loader) and :102 (action).

### run-agents inline re-checks (roleCan, not requireAction)
- task-actions.server.ts:1074-1087 `hasRuntimeRole` → @mention trigger (:866; lower role's
  comment recorded, run silently skipped `runtimeDenied:true`).
- specialist-run.server.ts:1405-1416 (assign/startSpecialistRun).
- run-service.server.ts:516-527 (interruptRun).
- project.task.tsx:425-438 (run-operator intent).

### github inline re-checks
project.github.tsx:52-83 (reconcile→reconcile-github :63; grant-scope/set-credential/
clear-credential→grant-github-scope :69,:77); project.settings.tsx:152,163 (credential changes).

## 3. requireProjectMutable — archive read-only gate

task-actions.server.ts:191-200 (409 "This project is archived (read-only)…"). Hooks: inside
requireAction (:353); inside requireProjectRole unless allowArchived (:238); EXPLICITLY in the
comment path (:669-672). PARALLEL second implementation in assertProjectAction
(project-role-guard.server.ts:36-43), duplicated message string. Exempt: all reads, restore
(settings-actions.server.ts:505), delete (:547). Locked by archive-readonly.server.test.ts.

## 4. Org roles

`resolveOrgRole` (identity.server.ts:150-162): better-auth member.role in default org
`org_viberr` is authoritative; users.role is derived cache. `authenticate` overwrites session
role every request (require-user.server.ts:83-88).

Org-admins READ all: home cards (home-query.server.ts:75-92), SSE any scope
(resources.events.ts:104-131). Org-admins CANNOT mutate non-member projects — **no override
anywhere** (D2 unimplemented). Asymmetry: org-admin sees a project on Home + SSE but gets 403
opening its Policy/Settings/Agents/GitHub pages (requireProjectMember is membership-only).

## 5. Project membership

members[] in project.md frontmatter (project-file.schema.ts:187) → ProjectContext.memberRoles
(task-actions.server.ts:154,178). memberSchema (:68-74) loose + role coercion; invalid array →
[] tolerant fallback (:380-386). Creator seeded project-admin (project-create.server.ts:148,:234).
- Add: inviteMember (settings-actions.server.ts:349-395) — creates whitelist user row if unknown
  email (:365-371), joins as viewer (:382); invite IS membership. Guard edit-policy.
- Role change: setMemberRole (policy-actions.server.ts:96-167) — last-admin guard (:130-140).
  Guard manage-members.
- Remove: removeMember (settings-actions.server.ts:397-453) — no self-remove (:410), last-admin
  guard (:426-435). Guard edit-policy.

## 6. UI gating

roleCan in task-detail-page.tsx (own-task :207,:606,:788; accept-completion :216,:841;
run-agents :223,:787,:815; approve-transition :605); execution-profile.tsx:64 (own-task).
Policy page: policy-data.ts (PROJECT_CAP_MATRIX = RBAC_TABLE :33-36; RBAC_ROWS derived :39-44).
policy-page.tsx: grant table :146-163 (live member counts :140), exceptions note :165-179
(app-wide comment, owner take/release, owner-accept verbatim, admin release-any), operator
full-autonomy exception :379.

## 7. Agent capability grants (separate surface)

CAP_CATALOG (capabilities.ts:29-62, 26 ids); pruned ids :63-68; ALWAYS_HUMAN (:72-76)
merge-pull-request/transition-to-done/change-project-policy; ENFORCED (:96-110);
CLAUDE_ONLY_ENFORCED (:128-133); capabilityEnforcement (:138-146, always-human before
claude-only). Modes (project-file.schema.ts:41); grants in agentDeploymentSchema (:130-144).
Edited via agent-profile-actions.server.ts (manage-agents): grantsFor (:141-158, ALWAYS_HUMAN
coerced :149, `off` persisted :150-154); createModalGrants (:170-180, no permissive defaults).
Modal catalog: capability-catalog.ts (specialist :48-80; operator :87-120; prune note :37-47).
Operator profile never deletable (agent-profile-actions.server.ts:364-368).
specialist-tool-policy.ts: CAP_DENY_RULES (:30-69); isWithheld (:71-79, safe-by-default);
resolveSpecialistDisallowedTools (:85-96); resolveDeliveryPermissions (:110-119). Claude-only.
Operator gate() (operator-actions.server.ts:189-203): direct|recommend|deny; full autonomy
promotes recommend→direct EXCEPT completion-for-acceptance (Q1). Consulted at
operator-actions :458,702,723,762,791,934,1018,1082,1191; operator-toolkit :98,113,183,238,295,322.

## 8. Tests that pin behavior

- policy-rbac.server.test.ts — THE binding test: every guard × every role + non-member vs
  rolesForAction (:87-109,146-192); ROLE_RANK monotonic (:121-125); every ACTION_ROLES set is a
  rank floor (:127-144); hand-off target must hold own-task (:194-214).
- task-governance.server.test.ts — owner exceptions + boundaries (:80,:98,:111,:127,:144
  viewer-owner cannot accept, :239,:267,:292,:307,:368,:428).
- archive-readonly.server.test.ts — 409s + reads-open + restore unfreezes.
- capabilities.test.ts, specialist-tool-policy.test.ts (merge always denied :18; F11 no blanket
  checkout deny :56), policy-route.server.test.ts (:62,:115,:170,:201,:243),
  policy-page.test.tsx (:44,:74,:93).

## 9. Seams and oddities (rework targets)

1. **Hardcoded role literal**: board rescan (project.board.tsx:83-88) gates on
   `["admin","maintainer"]` directly, not an action id.
2. **Two ROLE_RANK scales**: rbac.ts:27-32 (0-3) and profile-query.server.ts:63-68 (1-4).
3. **run-agents re-implemented inline 5+ places** (hasRuntimeRole, specialist-run,
   run-service, project.task, github/settings blocks) — membership-lookup boilerplate duplicated.
4. **Member management split**: role change→manage-members but invite/remove→edit-policy;
   all settings mutations collapse onto edit-policy.
5. **Owner-exception logic copy-pasted in two shapes** (+ hardcoded third check in setOwner).
6. **Two parallel archived gates** with duplicated 409 strings (+ hand-applied comment path).
7. **Role-list idiom paths have no RbacAction** (auto-boundary, rescan) — invisible to Policy
   table and binding test.
8. **Monotonicity is a hard assumption** (test-asserted invariant).
9. **view/comment display-vs-enforcement asymmetry**: table shows role-gated ✓s; actually
   app-wide; comment path checks NO membership at all (:669-677).
10. **ALWAYS_HUMAN enforced at 3 layers + workflow Done lock** (4 places to keep in sync).
11. **Org-admin read/act asymmetry** (sees all, can act on none) — D2 unimplemented.
12. **requireProjectAdmin naming misleading** (3 thin wrappers around assertProjectAction whose
    tier is whatever ACTION_ROLES says).
