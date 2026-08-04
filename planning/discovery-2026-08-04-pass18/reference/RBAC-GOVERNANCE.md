# RBAC-GOVERNANCE — Viberr current state (pass 18)

Viberr has **two distinct permission systems** that never mix:

1. **Human RBAC** — what a *person* may do on a project, keyed by their project
   role. Source of truth: `app/shared/rbac.ts`.
2. **Agent capability policy** — what an *AI agent* (specialist/operator) may do
   at runtime, keyed by per-profile capability grants. Source of truth:
   `app/shared/capabilities.ts`.

Plus the **acceptance gate** (verdict-gated completion) that sits across both.
All anchors are current to `pass18/product-fixes`.

---

## 1. Human RBAC (`app/shared/rbac.ts`)

### 1.1 Roles

Two org roles: `admin` | `member` (stored on the `users` row; the sole org
authority — there is no better-auth membership plugin,
`project-authority.server.ts:144-153`).

Four project roles, a strict tier `viewer ⊂ contributor ⊂ maintainer ⊂ admin`
(`ROLE_RANK` `rbac.ts:31-36`). `contributor` was formerly `reviewer`; the rename
dropped a misleading label — review authority actually rides per-task ownership,
not the role (`project-file.schema.ts:18-24`).

### 1.2 `ACTION_ROLES` — the single source (`rbac.ts:61-94`)

`RBAC_DEFINITIONS` (:61-88) is one array of `{id, label, roles[]}`. The **server
guards consult it and the Policy/Profile permission tables render the same
object**, so enforcement and display can never drift (`policy-rbac.server.test.ts`
drives each guard per role to keep them bound). `ACTION_ROLES` is derived from it
(:92-94); `roleCan(role, action)` (:97-100) and `rolesForAction(action)`
(:103-105) are the accessors.

The 18 actions and their holding roles (A=admin M=maintainer C=contributor
V=viewer):

| Action | Roles |
| --- | --- |
| `view`, `comment` | A M C V (never role-narrowed — enforcement IS the membership gate) |
| `create-task`, `own-task` | A M C |
| `approve-transition`, `resolve-packet`, `accept-completion`, `update-goal`, `run-agents`, `reorder-board`, `reconcile-github`, `grant-github-scope`, `rescan-project` | A M |
| `release-any-ownership`, `manage-members`, `manage-agents`, `edit-policy` | A |
| `force-accept-completion` | A (narrowest — the audited escape hatch, §3) |

**Membership is the outer gate on every action** (R15-4, `rbac.ts:19-27`): a
project is visible only to its members (plus org admins via the D2 override); a
non-member gets the unknown-slug 404. `view`/`comment` never call `requireAction`
— their entire enforcement is that membership gate.

### 1.3 Authority resolution + the D2 org-admin override

`app/server/auth/project-authority.server.ts` is THE single resolution path
(pass-7 R7-1). `resolveProjectAuthority(db, project, actor, allowed, audit)`
(:167-231) owns three rules:

1. **Membership role** — the actor's live role from `project.md` members[] checked
   against `ACTION_ROLES`. Granted under the actor's own role (never marked an
   override).
2. **D2 org-admin emergency override** (:181-204) — an ORG admin whose membership
   role would be denied (non-member, or a member below tier) is granted
   project-admin-equivalent authority, and **every such grant on a governed
   mutation writes a `project.org_admin.override` audit row** (visible, never
   silent). An org admin whose own membership suffices is NOT an override (no
   row). Reads (`"any-member"`) do not audit the override (was per-page-load
   noise).
3. **Denial** (P13-D-8, :208-230) — every refusal writes a
   `project.authority.denied` row (NFR10), deduped per (actor, project, action)
   in a 60 s window (:95-119) so a polling client can't bury the deliberate probe.

Throwing wrappers: `requireProjectAuthority` (:238-255, canonical task-guard
403), `requireRunAgents` (:266-280, adds the archived read-only gate before the
tier check — F17), `canRunAgents` (non-throwing @mention sibling, silent-deny,
:284-300), `assertProjectAction` (slug-only config surfaces, reads project.md
fresh, :310-363). `requireProjectMutable` (:131-142) is the single R6-3
archived-read-only gate. `isOrgAdmin` reads `users.role` directly and excludes
disabled accounts (:147-153).

### 1.4 F18-6 — last-live-admin guard (the ghost-admin deadlock fix)

`removeMember` in `app/features/project-settings/settings-actions.server.ts:654-725`.
When the target member has `role === "admin"` the guard now counts only **live**
admins: it reads the target's `users.disabled` flag (:697-700), computes
`targetLive`, and refuses only when `targetLive && countLiveAdmins(...) <= 1`
(:701-706). A **ghost admin** (its org account was deleted, so it's not counted
live) is therefore always removable — closing the deadlock where Settings→Members
refused the removal ("…is the only admin — assign another admin in Policy first")
while Policy pointed circularly back to Members. A real last live admin stays
protected. Recovery no longer needs hand-editing `project.md`. The org-level
sibling — `deleteOrgUser` uses `countActiveAdmins(db) <= 1` (`org-users.server.ts:370-377`)
and `pruneUserFromProjects` (:322-349) drops the deleted account from every
project's membership so no ghost is created in the first place (UI-29).

---

## 2. Agent capability policy (`app/shared/capabilities.ts`)

Separate from human RBAC: what an AGENT may do at runtime. Grants are stored
per-deployment in `project.md` `agents[].capabilities[]` as `{capabilityId, mode}`
(project-file.schema.ts:69-76).

### 2.1 Modes and the catalog

`CapabilityMode` = `direct` | `recommend` | `human` | `off`
(`project-file.schema.ts:35`): `direct` = the agent performs it; `recommend` =
the operator proposes, a human applies; `human` = reserved for a human; `off` =
withheld entirely (the tool isn't even offered). `UNIFIED_CAP_CATALOG`
(`capabilities.ts:33-105`) is the single catalog, each entry tagged with `kinds`
(`operator` | `agent`), an editor `group` (`null` = matrix-only, no toggle), a
`defaultMode`, and `promotable`.

**Critical polarity (P13-AP-06, :107-123):** `capabilities: []` does NOT mean "no
powers" — the tool policy treats an *unspecified* capability as **granted**, so
every creation path persists explicit grants. `defaultGrantsFor(kind)`
(:116-123) grants everything at its default; `conservativeGrantsFor(kind)`
(:143-154) is the org-template starting set that WITHHOLDS the dangerous ones
(`execute-code-or-write-repo`, scoped delivery, verdict outcomes) because the
org editor has no capability UI.

### 2.2 ALWAYS_HUMAN — the structural locks

`ALWAYS_HUMAN_CAPABILITY_IDS` (:162-166): **`merge-pull-request`,
`transition-to-done`, `change-project-policy`**. These are `human` mode in the
catalog with `promotable: false`, and `capabilityEnforcement` returns `"both"`
for them (enforced on Claude AND Codex, checked before the claude-only set so a
cap that is both is never mislabeled advisory, :226-234). No agent ever holds
them in an actionable mode. Done stays human-only except the one deliberate
`operatorAcceptCompletion` exception (below).

### 2.3 Enforcement scope (honesty metadata)

`capabilityEnforcement(id)` (:226-234) → `both` | `claude-only` | `advisory`:

- `ENFORCED_CAPABILITY_IDS` (:174-204) — withholding actually constrains runtime
  on both backends (branch/commit/PR/merge caps, operator coordination caps,
  `deliver-review-pr`, `report-validation-verdict`, `ask-human`,
  `attach-evidence-references`, `use-web-search-fetch`).
- `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` (:213-221) — enforced via Claude's tool
  denylist, advisory on Codex (`create-task-branch`, `commit-push-branch`,
  `open-review-pr`, `comment-on-task`).
- Everything else is advisory (persona guidance only).

### 2.4 The delivery headline + scoped grants

`execute-code-or-write-repo` is the headline gate over the three scoped delivery
caps `SCOPED_DELIVERY_CAPABILITY_IDS` (:287-291: create-task-branch,
commit-push-branch, open-review-pr). `repairDeliveryGrants` (:324-366) materializes
an ABSENT headline to `direct` when scoped grants are actionable (the editor
artifact), but an EXPLICIT `off`/`human` headline is **respected** (B-AG1: the
save layer only fills in what nobody set, never flips an admin's withholding).
`applyVerdictOutcomeGate` (:263-277): the three verdict-outcome caps
(`approve-review`, `request-changes`, `post-quality-flags`, :242-246) render as
granted only when `report-validation-verdict` is explicitly `direct` — else off
(F15-06 honesty). `absentDeliverReviewPrMode(humanGatedBeforeWork)` (:397-401)
derives the mode for a pre-R15-2 deployment from whether the project human-gates
advancement, so the runtime gate and policy surface can't drift (R15-9).

---

## 3. The acceptance gate (verdict-gated completion)

Acceptance into Done is gated by the revision-bound review model
(DOMAIN-MODEL.md §2.3). The gate is `acceptanceBlockedReason(fm)`
(`task-file.schema.ts:575-593`) plus the closed-PR / conflicting-PR / archived
guards — one reason-or-null helper per condition, consulted at every writer that
lands `stage=done` (accept, resolvePacket's inlined accept, operatorAcceptCompletion).
A task with NO required reviewers and NO revision stays acceptable (planning
work); once a revision exists, every required reviewer must approve THAT revision
and none may request changes.

- **`accept-completion`** (A M) is the normal path.
- **`force-accept-completion`** (A only, `rbac.ts:79-83`) is the audited escape
  hatch (DG-2): it BYPASSES the verdict gate for a stuck task (e.g. a required
  reviewer that can no longer record a verdict). Stricter than plain accept.
  Because it bypasses (never satisfies) the gate, `task.blockReason` persists
  after Done — which is why **F18-13** now suppresses the force-accept control on
  a terminal task (UI-INVENTORY.md).
- **R17-1 revision drift** — accepting a PR head strictly ahead of the reviewed
  revision is allowed but the accept dialog surfaces the extra unreviewed commits
  (`pr.revisionDrift`, DOMAIN-MODEL.md §2.4).
- **R16-x out-of-band merge** — a PR merged/closed on GitHub outside the app is
  NOT auto-advanced; the reconciler notes the divergence and recommends, stage
  unchanged.
- **`operatorAcceptCompletion`** (`operator-actions.server.ts:1966`) is the ONE
  deliberate exception to human-only-Done: a `full`-autonomy operator holding an
  explicit `completion-for-acceptance: direct` grant moves the task to Done
  itself (owner ruling Q1; the cap is `promotable:false` so raising autonomy
  never silently grants it, `capabilities.ts:40-48`).

Force-accept authority is resolved in
`app/features/review/review-acceptance-authority.server.ts`.

---

## 4. Operator autonomy

`OperatorAutonomy` = `supervised` | `full` (`operator-actions.server.ts:82`),
read from the deployment `definition.autonomy` via `readAutonomy` (:149-152) and
resolved by `resolveOperatorAuthority` (:195-269). Supervised: the operator
RECOMMENDS at governed boundaries (delivery, transitions, acceptance) and a human
applies. Full: it performs them and may accept completion to Done. `gate` /
`deliverGate` (:272-313) map a capability grant + autonomy to a `direct` |
`recommend` | `off` decision. See AGENTS-RUNTIME.md for how autonomy drives the
R18-2 post-delivery re-queue.

---

## 5. Pass-18 delta

- **F18-6** (`643ca81`) — last-admin guard counts ACTIVE members only; a ghost
  admin is removable (settings-actions.server.ts:689-706).
- No change to `rbac.ts`, `capabilities.ts`, or `project-authority.server.ts`
  themselves this pass — the ACTION_ROLES map, ALWAYS_HUMAN set, and D2 override
  are exactly as pass 17 documented (verified against the tree). The acceptance
  gate honesty fix (F18-13) is a UI suppression, not a policy change (the gate
  helpers are unchanged).
