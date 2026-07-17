# Viberr RBAC Code Audit (main, 2026-07-17)

Read-only audit for the owner's role-bindings rework. Every claim is cross-checked
against source. Line numbers are HEAD as read on 2026-07-17.

**Structural note vs the pass-7 inventory:** `app/server/org/project-role-guard.server.ts`
**no longer exists** — `assertProjectAction` was consolidated into
`app/server/auth/project-authority.server.ts` (R7-1). Several pass-7 seams are now
closed (see §6). All line cites below are to the *current* files.

---

## 1. Roles

### Project roles
- Definition: `app/schemas/project-file.schema.ts:23` — `PROJECT_ROLES = ["admin","maintainer","contributor","viewer"]`; type `ProjectRole` at `:24`.
- Legacy coercion: `coerceProjectRole` (`:28-30`) maps the retired `reviewer` → `contributor`; applied in `memberSchema.role` via `z.preprocess` (`:71`).
- Rank scale: `ROLE_RANK` (`app/shared/rbac.ts:27-32`) — `viewer 0 < contributor 1 < maintainer 2 < admin 3`. Labels: `ROLE_LABEL` (`rbac.ts:34-39`).
- **Single rank scale now.** The pass-7 "second scale" in `profile-query.server.ts` is gone (no rank map remains there). `rbac.ts:27-32` is the only `Record<ProjectRole, number>` in the app source.

### Org roles
- Two values: `admin | member`. Resolved by `resolveOrgRole` (`app/server/auth/identity.server.ts:150-162`) from better-auth membership in the default org `org_viberr` (`identity.server.ts:24`); `users.role` is the derived-cache fallback.
- Org-admin test used by authority: `isOrgAdmin` (`project-authority.server.ts:94-101`) — disabled users never qualify.

### Agent capability grants (`direct | recommend | human | off`)
- Independent surface, not part of the project-role matrix. Out of scope for this audit except where it bypasses RBAC (operator authority, §3).

---

## 2. Authoritative action → role matrix (from `ACTION_ROLES`, `rbac.ts:76-97`)

Enforced minimum role per `RbacAction` (`rbac.ts:42-63`). All actions are monotonic
(a rank floor). No action is specialist-capped here — the ALWAYS_HUMAN / specialist
cap lives entirely on the *agent capability* surface (`capabilities.ts`), not on the
human project-role matrix. The one human-only invariant that shows up in these guards
is the **review→done "human" boundary** (locked in `setTransitionBoundary`,
`policy-actions.server.ts:213`), enforced via `requireAcceptCompletion`.

| RbacAction | Min role (floor) | rbac.ts line | Enforced at | In Policy UI table? |
|---|---|---|---|---|
| `view` | app-wide* | 77 | not via requireAction (app-wide read) | Yes (row shows A,M,C,V) |
| `comment` | app-wide* | 78 | `appendComment` archived-gate only, no membership | Yes (row shows A,M,C,V) |
| `create-task` | contributor | 80 | `task-actions:448` | Yes |
| `own-task` | contributor | 81 | `task-actions:2082` (+hand-off inline 2100-2108) | Yes |
| `reconcile-github` | contributor | 82 | `project.github.tsx:61` | **No** |
| `approve-transition` | maintainer | 84 | `task-actions:2363,2369` | Yes |
| `resolve-packet` | maintainer | 85 | `task-actions:2781,3370` (+owner exc.) | Yes |
| `accept-completion` | maintainer | 86 | `requireAcceptCompletion task-actions:362-371` (+owner exc.) | Yes |
| `run-agents` | maintainer | 87 | `hasRuntimeRole:1099`, specialist-run:1570, run-service:585, project.task:428 | Yes (folded w/ reorder) |
| `reorder-board` | maintainer | 88 | `task-actions:2653` | **Only implied** (shares "Run agents & reorder the board" row) |
| `update-goal` | maintainer | 89 | `task-actions:546` | Yes |
| `grant-github-scope` | maintainer | 90 | `project.github.tsx:65,71`; `project.settings.tsx:142,150` | **No** |
| `rescan-project` | maintainer | 91 | `project.board.tsx:80` | Yes |
| `release-any-ownership` | admin | 93 | `task-actions:2218` (+inline roleCan 2100) | Yes |
| `manage-members` | admin | 94 | `policy-actions:103` (setMemberRole); `settings-actions:353,403` (invite/remove) | Yes |
| `manage-agents` | admin | 95 | `agent-profile-actions:105` | **No** |
| `edit-policy` | admin | 96 | `policy-actions:188`; `settings-actions:121,172,205,240,295,465,501,545` | Yes ("Edit workflow & policy") |

\* `view`/`comment` are granted to all four roles in the map **only so the Policy
table can render them** (`rbac.ts:18-22`, `41-63`). Their real enforcement is
"any authenticated user, member or not" — the guards do **not** call `requireAction`.

**UI-vs-enforcement drift flags** (`RBAC_TABLE`, `rbac.ts:115-129`):
- **4 enforced actions are absent from the Policy table**: `reconcile-github`,
  `grant-github-scope`, `manage-agents`, and `reorder-board` (the last is silently
  folded into the `run-agents` row and only renders correctly because both are
  coincidentally `[A,M]`). An admin editing the matrix on the Policy page never sees
  these four rows, yet they are enforced.
- `view`/`comment` rows show role columns (implying "≥viewer-member required") but
  are actually app-wide including non-members — the table over-states the requirement.
- Every *displayed* row is derived from `ACTION_ROLES` (`RBAC_TABLE` reads the same
  object), so for the rows that ARE shown, display cannot drift from enforcement.

---

## 3. The org-admin override (D2) — now implemented

**Where authority is granted:** `resolveProjectAuthority` (`project-authority.server.ts:114-153`).
A member whose live role satisfies `allowed` is granted under their **own** role
(`:122-127`, `isOrgAdminOverride:false`). Otherwise, if `isOrgAdmin` (`:128`), the actor
is granted **project-admin-equivalent** authority (`role:"admin", isOrgAdminOverride:true`, `:150`).

**Which actions it covers:** every guard routes through this one resolver, so the
override covers **all** governed mutations and reads:
- task mutations via `requireAction` → `requireProjectAuthority` (`task-actions:314-329`);
- config surfaces via `assertProjectAction` (`project-authority.server.ts:185-238`) —
  settings, policy, agents, github;
- runtime triggers via `requireProjectAuthority` (specialist-run:1570, run-service:585, project.task:428, hasRuntimeRole:1099);
- the route membership read-gate `requireProjectMember` → `assertProjectAction("any-member")` (`require-project.server.ts:30-37`).

**Where the audit event is written:** inside `resolveProjectAuthority` (`:135-149`),
action `project.org_admin.override` (registered `app/server/audit/audit-actions.ts:88`),
with details `{action, what, projectSlug, memberRole}`.

**Read vs mutate asymmetry (intentional, but note it):** the override is audited **only
for concrete `RbacAction`s**. When `audit.action === "any-member"` (`:135`) — i.e. the
config-surface READ gate and a couple of idempotent no-op paths — the grant is made
**without** an audit row (comment `:129-134` cites F7-pass7 audit-noise: an org-admin
non-member opening a Policy page would otherwise write a row per page load). Net effect:
an org-admin non-member's **reads** of Policy/Settings/Agents/GitHub are silent
overrides; every real **mutation** they perform is audited. This is deliberate but means
"org admin browsed this project's config" is not in the audit trail.

**Surfaces that do NOT route through the override resolver** (they grant org-admin reads
by a *separate* path, so they honor org-admin but never via the D2 code/audit): Home
cards and cross-scope SSE (per pass-7 inventory `home-query.server.ts`,
`resources.events.ts`). Board and task-detail reads are app-wide anyway (FR4), so no
override is needed there.

---

## 4. Inconsistencies / smells to rule on

**(a) `reconcile-github` (contributor+) vs `rescan-project` (maintainer+) — they really differ.**
`ACTION_ROLES["reconcile-github"] = [A,M,C]` (`rbac.ts:82`), enforced at
`project.github.tsx:61`. `ACTION_ROLES["rescan-project"] = [A,M]` (`rbac.ts:91`),
enforced at `project.board.tsx:80`. Both are "re-sync projections from a source of
truth," yet the *more* privileged tier is attached to the **purely-local** rebuild
(rescan reads the local file store) while the tier that reaches out to **external
GitHub** (reconcile) is available to contributors. This is inverted from an
intuitive blast-radius ordering and is the clearest tier mismatch to rule on.
*Candidate:* align them, or justify why local rescan is maintainer-only (it can mask
projection drift) while GitHub reconcile is contributor.

**(b) `comment` performs NO project-membership check — it is any-signed-in-user, app-wide.**
`appendComment` (`task-actions.server.ts:668-693`) only calls
`requireProjectMutable(...)` (archived gate, `:688`) — there is **no** membership or
role check. The route confirms it: `project.task.tsx:135` gates the comment action with
`requireAuth(request)` only, never `requireProjectMember`. The mention fan-out even
queries **all** users (`:750-752`). This is intended (FR4 doc, `rbac.ts:18-22`), but the
Policy table renders `comment` with role columns as if membership mattered. *Candidate:*
either scope comment to members (breaking FR4) or make the table honestly mark
`view`/`comment` as "any authenticated user" rather than role-gated.

**(c) `manage-members` now covers all of invite / remove / role-change — the pass-7 split is CLOSED.**
`inviteMember` (`settings-actions.server.ts:353`) and `removeMember` (`:403`) both use
`manage-members`; `setMemberRole` (`policy-actions.server.ts:103`) uses `manage-members`.
No membership CRUD rides `edit-policy` anymore. All three are admin-tier today. What
still rides `edit-policy`: identity, stages, repo-override, archive/restore, delete
(`settings-actions:121,172,205,240,295,465,501,545`) and `setTransitionBoundary`
(`policy-actions:188`). *No rework needed for the split itself*; the remaining question
is whether `manage-members` and `edit-policy` should ever diverge from admin — they are
separate action ids precisely so they *can* (`policy-actions.server.ts:64-67`), but
today both are `[A]`.

**(d) Duplicated owner-exception logic — three shapes.**
One helper, `ownerException` (`task-actions.server.ts:338-349`), is reused by
`requireAcceptCompletion` (`:362-371`) and the inline packet check
(`resolvePacket:2770-2782`). But `setOwner` hand-off has a **separate, hardcoded**
owner/authority check: `roleCan(actorRole, "release-any-ownership")` +
`roleCan(targetRole, "own-task")` (`:2100-2108`) rather than reusing the helper. So the
"who counts as the owner / who may override the owner" rule exists in two idioms.
*Candidate:* fold the hand-off check into a shared predicate.

**(e) Remaining hardcoded role arrays — effectively none in guards.**
The pass-7 board-rescan literal `["admin","maintainer"]` is gone; it now uses
`assertProjectAction(db,"rescan-project",...)` (`project.board.tsx:80`). Remaining
literal role comparisons are all *derived-role* branches, not authorization floors:
`roleCan(actorRole,"release-any-ownership")` (`task-actions:2100`) and
`roleCan(targetRole,"own-task")` (`:2104`) both consult `ACTION_ROLES` via `roleCan`, so
they are single-sourced. No raw `["admin",...]` authorization array survives in the
server guards. *Low priority.*

**(f) Viewer's exact capabilities — near-zero, and identical to a non-member except one thing.**
`viewer` appears in `ACTION_ROLES` only under `view` and `comment` (`rbac.ts:77-78`),
both of which are app-wide (non-members get them too). So project-membership as a
**viewer** grants **no task/board mutation capability whatsoever**. The *only* concrete
thing a viewer-member can do that a non-member cannot: pass the config-surface route gate
`requireProjectMember` (`any-member`, `require-project.server.ts:20-37`) and thus open the
Policy / Settings / Agents / GitHub **read** pages. *Candidate to rule on:* is "read-only
access to config/health surfaces" the intended and sufficient definition of viewer, or
should viewer collapse into "non-member who was explicitly added for visibility"?

**(g) `run-agents` re-checked inline in 4 places — no hardcoded arrays, but duplicated plumbing.**
`hasRuntimeRole` (`task-actions:1099-1122`), `specialist-run.server.ts:1570-1580`,
`run-service.server.ts:585-593`, `project.task.tsx:428-438`. All now delegate to
`requireProjectAuthority`/`resolveProjectAuthority` with `rolesForAction("run-agents")`,
so the *tier* is single-sourced — but each site re-reads `project.md`, rebuilds the
`memberRoles` map, and constructs the actor. `hasRuntimeRole` additionally is
**non-throwing** (a lower role's comment is still recorded, run silently skipped,
`runtimeDenied:true` at `commentToAgent:882`), which is a deliberate UX divergence from
the throwing sites. *Candidate:* one `requireRuntimeRole(db, ctx, slug, actor)` helper.

**(h) GitHub / credential mutations bypass the R6-3 archived read-only gate.**
`reconcile`, `grant-scope`, `set-credential`, `clear-credential` all pass
`allowArchived: true` (`project.github.tsx:55-57`, `project.settings.tsx:142-143,150-151`),
so an archived (read-only) project can still have its GitHub credential rotated/cleared
and be reconciled — while every task mutation, comment, and policy edit is frozen. The
inline comments call this "unchanged from the pre-consolidation check," i.e. it was never
reconsidered, not affirmatively decided. *Candidate:* decide whether credential
mutation on an archived project is intended (it changes stored secrets on a frozen project).

**(i) Org-admin config **reads** are unaudited overrides (see §3).**
`resolveProjectAuthority:135` skips the audit row for the `any-member` read gate. Ruling
needed only if "org admin viewed a non-member project's config" should be traceable.

**(j) `RBAC_TABLE` omits 4 enforced actions (see §2).**
`reconcile-github`, `grant-github-scope`, `manage-agents`, `reorder-board` are enforced
but not rendered on the Policy page; `reorder-board`'s tier is silently assumed equal to
`run-agents`. *Candidate:* render every `RbacAction` (or explicitly mark the hidden ones).

---

## 5. Proposed rework decisions (owner to approve)

1. **Reconcile the github/rescan tier inversion (smell a).** Either raise
   `reconcile-github` to maintainer+ (`[A,M]`) to match `rescan-project`, or lower
   `rescan-project` to contributor+ (`[A,M,C]`). Recommendation: make both maintainer+ —
   both re-derive canonical state and can mask/relabel drift. *Tradeoff:* contributors
   lose the ability to self-serve a GitHub reconcile.

2. **Make the Policy table total (smell j).** Drive `RBAC_TABLE` off *all* `RbacAction`
   ids (add `reconcile-github`, `grant-github-scope`, `manage-agents`; give
   `reorder-board` its own row). *Tradeoff:* a longer table; but display can never again
   silently omit an enforced action.

3. **Mark `view`/`comment` honestly in the table (smell b).** Render them as "Any signed-in
   user (app-wide)" instead of role-checked columns, so the UI stops implying membership is
   required. *Tradeoff:* the table stops being a clean 4-column grid; needs a footnote/row style.

4. **Extract one `requireRuntimeRole` helper (smell g).** Collapse the 4 inline
   `run-agents` checks into a single helper that owns the project-load + map-build +
   authority call, with a `{ throwOnDeny }` flag to preserve the non-throwing @mention
   path. *Tradeoff:* one more indirection; but removes 4 copies of membership plumbing.

5. **Share the owner predicate (smell d).** Replace the hardcoded hand-off checks in
   `setOwner` (`:2100-2108`) with the same `ownerException`/`roleCan` predicates the accept
   and packet paths use. *Tradeoff:* minor; pure de-duplication, behavior-preserving.

6. **Decide archived-project credential policy (smell h).** Either drop `allowArchived`
   from the github/credential guards (freeze secrets on archived projects, consistent with
   R6-3) or document that credential hygiene is intentionally exempt. Recommendation: freeze
   them — an archived project shouldn't accept secret rotation. *Tradeoff:* an admin must
   restore before rotating a credential on an archived project.

7. **Confirm viewer's definition (smell f).** Ratify "viewer = member with read access to
   config/health surfaces and nothing else," or remove the viewer role and treat those users
   as non-members with explicit read-share. Recommendation: keep viewer as-is and document it.
   *Tradeoff:* keeping it means the role's only power is opening config read pages, which is
   easy to misread as "can edit."

8. **Ratify the org-admin read-audit gap (smell i / §3).** Decide whether org-admin config
   **reads** should leave a lightweight audit trail (e.g. a rate-limited/session-deduped row)
   rather than nothing. *Tradeoff:* re-introduces some of the F7 audit noise the current code
   deliberately removed; keep the noise low with per-session dedup.

9. **(Optional) Split `manage-members` from `edit-policy` in practice, or fold back.** They
   are already distinct action ids but both `[A]`. Decide if any project should be able to let
   maintainers manage members (set `manage-members` to `[A,M]`) — the plumbing already supports
   it (`policy-actions.server.ts:64-67`). *Tradeoff:* delegating membership to maintainers
   widens who can change the member set; leave at `[A]` if that's undesirable.

10. **Keep monotonicity as an explicit, tested invariant.** Every `ACTION_ROLES` set is a rank
    floor and `policy-rbac.server.test.ts` asserts it. Any rework that introduces a
    non-monotonic grant (e.g. an action a maintainer holds but an admin does not) must update
    that test deliberately. *Tradeoff:* none — this is a guardrail to preserve, called out so a
    reworker doesn't break it silently.
