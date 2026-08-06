# RBAC-GOVERNANCE — Viberr current state (pass 19)

> Verified against main @65063b8 on 2026-08-06 (pass 19).

Viberr has **two distinct permission systems** that never mix:

1. **Human RBAC** — what a *person* may do on a project, keyed by their project
   role. Source of truth: `app/shared/rbac.ts`.
2. **Agent capability policy** — what an *AI agent* (specialist/operator) may do
   at runtime, keyed by per-profile capability grants. Source of truth:
   `app/shared/capabilities.ts`.

Plus the **acceptance gate** (verdict-gated completion) that sits across both.
All anchors re-verified against `main @65063b8`. **Neither `rbac.ts` nor
`capabilities.ts` nor `project-authority.server.ts` changed between pass 18 and
pass 19** — the only governance-adjacent movement is UI (§6).

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

`removeMember` in `app/features/project-settings/settings-actions.server.ts:654`.
When the target member has `role === "admin"` the guard now counts only **live**
admins: it reads the target's `users.disabled` flag, computes `targetLive` (:700),
and refuses only when `targetLive && countLiveAdmins(...) <= 1` (:701-702;
`countLiveAdmins` imported from `./membership.server`, :31). A **ghost admin**
(its org account was deleted, so it's not counted live) is therefore always
removable — closing the deadlock where Settings→Members refused the removal
("…is the only admin — assign another admin in Policy first") while Policy
pointed circularly back to Members. A real last live admin stays protected.
Recovery no longer needs hand-editing `project.md`. The org-level sibling —
`deleteOrgUser` uses `countActiveAdmins(db) <= 1` (`org-users.server.ts:370-377`)
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
- **`operatorAcceptCompletion`** (`operator-actions.server.ts:2017`) is the ONE
  deliberate exception to human-only-Done: a `full`-autonomy operator holding an
  explicit `completion-for-acceptance: direct` grant moves the task to Done
  itself (owner ruling Q1; the cap is `promotable:false` so raising autonomy
  never silently grants it, `capabilities.ts:40-48`, and `gate` refuses to
  promote `recommend`→`direct` for exactly this id, `operator-actions.server.ts:289`).
- **B1 (pass 19, `7ee2864`)** — acceptance is now confirmed on EVERY human path.
  A board drag (or keyboard Move) into the FINAL stage routes through
  `reorderTask` → `acceptCompletion`, i.e. it attempts a real PR merge. Both
  board paths now raise `AcceptOnBoardConfirm` (`board-page.tsx:543`, state at
  :1090, render at :1419) before posting, matching task detail's long-standing
  "Merging is one-way" dialog (ruling 20 / FR27).

Force-accept authority is resolved in
`app/features/review/review-acceptance-authority.server.ts`.

---

## 4. Operator autonomy

`OperatorAutonomy` = `supervised` | `full` (`operator-actions.server.ts:84`),
read from the deployment `definition.autonomy` via `readAutonomy` (:151) and
resolved by `resolveOperatorAuthority` (:197). Supervised: the operator
RECOMMENDS at governed boundaries (delivery, transitions, acceptance) and a human
applies. Full: it performs them and may accept completion to Done. `gate` (:274)
and `deliverGate` (:304) map a capability grant + autonomy to a
`Gate = "direct" | "recommend" | "deny"` decision (the type is at :125 — the
pass-18 doc said the third value was `off`, which is the capability MODE name,
not the gate outcome). See AGENTS-RUNTIME.md for how autonomy drives the R18-2
post-delivery re-queue.

---

## 5. Human RBAC → UI honesty (what a denied role SEES)

Enforcement was already correct for every role; pass 19 closed the surfaces that
disabled a control without saying why (a disabled control cannot explain itself
through `title`). This matters for RBAC because the reader's model of the policy
comes from these notes:

| Surface | Rule | Anchor |
| --- | --- | --- |
| Project Settings — Project / Stages / Members panels | lock note naming the missing grant; the Stages "drag to reorder / click to rename" how-to now renders only for a reader who can act (LV-F2, `2301612`) | `settings-page.tsx:91`, `:758`, `:868` |
| Project Settings — RepoPanel | same lock note (UXA-3, `3eba761`) | `settings-page.tsx:1121` |
| Project Settings — **Danger zone** | **Q-V1 owner ruling** (`0efe0d7`): renders ONLY when `roleCan(myRole,"edit-policy")`. It used to render for every member with disabled buttons + a deny note — honest, but it showed a read-only stakeholder a destructive surface and named archive/delete as if they were on the table. The in-panel deny note stays for in-between roles. | `settings-page.tsx:1437` (`canEditPolicy`), gate at `:1603` |
| Agents page | read-only note naming the **Manage agents** grant (UXA-15, `6ba5c77`); previously New profile / Add from library / Edit / Delete simply vanished with no explanation | `agents-page.tsx:1230-1240` (`canManage` at :1034) |
| Task comment composer | "Every project member can comment" — was the false "Open to every registered user" (UXA-1, `7ee2864`); membership IS the gate (R15-4) | `timeline.tsx:370` |
| Topbar org-admin override pill | the D2 sentence moved from a `title` on a non-focusable span into `aria-label`, so keyboard/AT/touch reach it (UXA-13, `2098289`) | `topbar.tsx:145-158` |

**NOT implemented, recorded honestly** (`0efe0d7` commit body): the PAT half of
Q-V1. A viewer's Settings HTML still carries the GitHub connection tail;
`settings-page` holds only `credential.source` booleans, so the tail renders from
another component. Left with an exact next step rather than a guessed fix.

---

## 6. Delta (pass 18 + pass 19)

- **F18-6** (`643ca81`) — last-admin guard counts ACTIVE members only; a ghost
  admin is removable (`settings-actions.server.ts:690-706`).
- **Q-V1** (`0efe0d7`) — Danger zone hidden from members without `edit-policy`
  (§5). A visibility change, not an authority change: the server guards are
  untouched.
- **B1** (`7ee2864`) — board acceptances confirm before posting (§3).
- No change to `rbac.ts`, `capabilities.ts`, or `project-authority.server.ts` in
  either pass — the 18-row `ACTION_ROLES` map, the ALWAYS_HUMAN set, and the D2
  override are exactly as pass 17 documented (each re-verified against the tree:
  `RBAC_DEFINITIONS` :61, `ACTION_ROLES` :92, `roleCan` :97, `rolesForAction`
  :103, `ROLE_RANK` :31; `UNIFIED_CAP_CATALOG` :33, `ALWAYS_HUMAN_CAPABILITY_IDS`
  :162, `capabilityEnforcement` :226, `SCOPED_DELIVERY_CAPABILITY_IDS` :287,
  `repairDeliveryGrants` :324; `resolveProjectAuthority` :167,
  `requireProjectAuthority` :238, `requireRunAgents` :266, `canRunAgents` :284,
  `assertProjectAction` :310, `requireProjectMutable` :131, `isOrgAdmin` :147).
- The acceptance-gate honesty fix (F18-13) is a UI suppression, not a policy
  change (the gate helpers are unchanged).
