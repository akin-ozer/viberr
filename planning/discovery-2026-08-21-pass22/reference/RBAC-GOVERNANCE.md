# RBAC-GOVERNANCE — Viberr current state (pass 21)

## Pass-22 revision (2026-08-21)

> Re-verified against `main @26fca45` (HEAD). Two waves landed after this
> doc's `ce2bc9e` baseline: pass 21's implementation (PR #175 → `d1bc4a2`,
> rulings 84–90) and PRs #176–186 (rulings 91–92). **Unchanged since
> `ce2bc9e`, byte-for-byte — §1 and its anchors hold verbatim:**
> `app/shared/rbac.ts` (still 18 actions), `project-authority.server.ts`,
> `require-project.server.ts`, `project-visibility.server.ts`,
> `project-file.schema.ts`, `capability-catalog.ts` (+ its test — the 13-cap
> toggleable set stands), `task-attachment.ts`, `agent-outcome.server.ts`,
> `specialist-mcp.server.ts`, `review-acceptance-authority.server.ts`.
>
> **Substantive changes this revision folds in below (marked "Pass-22"):**
>
> 1. **Ruling 88 (R21-5, pass 21)** — the acceptance ceremony's disclosure is
>    now a **SERVER invariant**: every HUMAN acceptance door requires an
>    `AcceptanceDisclosure` acknowledgment echoing what the dialog rendered
>    (PR state, delivered sha, verdict); a bare or stale POST is refused,
>    re-checked inside the write lock. New shared module
>    `app/shared/acceptance-disclosure.ts`. See §3.1/§3.7.
> 2. **Browser→egress coupling (PR #176, owner ruling 2026-08-20,
>    un-numbered)** — granting `use-browser: direct` now REPAIRS
>    `use-web-search-fetch` to `direct` at the save layer
>    (`repairBrowserEgressGrants` / `applyGrantCouplings`,
>    `capabilities.ts:475`, `:510`), and the editor pins the egress row while
>    the browser is Allowed. This **deliberately diverges from B-AG1** (there
>    is no enforceable withheld state here — the mount fails closed either
>    way). The mount-time egress pair (§2.6) stays as the backstop for
>    hand-edited files. `DeliveryGrantNotice`/`RepairedDeliveryGrants` were
>    renamed `GrantCouplingNotice` (with a `rule` field) / `RepairedGrants`;
>    profile-save results now carry `notices[]`.
> 3. **Ruling 92 (PR #185)** — the operator card's per-run backend/autonomy
>    dropdowns are GONE (the card shows the deployed profile's backend and
>    the configured autonomy; Run + an optional steer recorded as the human's
>    own `@operator` comment). §4.1's ceiling machinery is unchanged
>    server-side. Backend display label is "Claude", not "Claude Code"
>    (`agentBackendName`, `actor-ref.server.ts:122`).
> 4. **PR #186 (owner-cell-no-manage)** — the owned task's owner cell renders
>    the owner chip alone; the Manage popover (take-over / hand-off /
>    release) is removed. **No authority changed**: self-release for the
>    owner rides `own-task` on the Current-state Owner row, any release for
>    the `release-any-ownership` tier, and the unowned cell keeps "Assign me"
>    (contributor+, Q5 tiering). §1.2/§1.5 stand as written.
> 5. **F21-5 (pass 21)** — R19-11's credential-visibility rule was extracted
>    to `app/features/github/credential-visibility.server.ts`
>    (`credentialGrantHolder:40`, `withoutCredentialDetail:70`) because the
>    /settings route rendered the SAME CredentialCard **unredacted** for a
>    Viewer; both routes now pass through the one rule. §5 row updated.
> 6. **Ruling 85 (R21-2)** — a capability-gap packet must name the grant
>    remedy (the Agents surface) beside any workarounds; the operator still
>    edits no configuration (`change-project-policy` stays ALWAYS_HUMAN).
> 7. **PR #183 (live-agent-backend)** — capability/engagement DISPLAY reads
>    the LIVE deployment's backend over the engage-time snapshot
>    (`withLiveAgentBackends` `task.server.ts:369`;
>    `primaryRunBackend`/`deployedSpecialistBackends`
>    `agents-query.server.ts:383`/`:408`) — same display-mirrors-runtime
>    family as §2.5.
> 8. **PRs #177/#179/#184 (attachments)** — a new persona section
>    (`attachmentsDropSection`, `specialist-browser-mcp.server.ts:167`) tells
>    ANY profile granted `attach-evidence-references` about the attachments
>    drop; the workspace-confinement contract names it as its one exception;
>    Codex sandboxes gain `attachmentsWritableDir` only at workspace-write.
>    Serving stays member-only through the unchanged `task-attachment.ts`
>    route (§2.6 output governance holds).
>
> **Anchor drift at HEAD** (files that grew; symbols unmoved unless listed):
> `task-actions.server.ts` — `requireAnyMember:265`, `requireAction:278`,
> `ownerException:296`, `requireAcceptCompletion:310`,
> `requireDecisionAuthority:334`, `createTask:414`, `performDelivery:3703`,
> ownership copy `:3071-3073`, `setTaskArchived:4640`, `resolvePacket:4773`,
> `archive_task` case `:5171`, `discardLocalTaskBranch` calls `:5466`/`:5541`,
> `acceptanceStageBlockedReason:5772`, `acceptanceRefusalReason:5808`,
> `forceIrreducibleRefusal:5891`, `forceAcceptCompletion:6830`.
> `operator-actions.server.ts` — `OperatorAutonomy:103`, `readAutonomy:181`,
> `AUTONOMY_CLAMPED_AUDIT_ACTION:197`, `clampAutonomy:227`,
> `auditAutonomyClamp:249`, `operatorAutonomyFor:337`,
> `resolveOperatorAuthority:353`, `gate:446` (Q1 refusal `:461`),
> `deliverGate:476`, R19-6 reroute `:2610-2626`, refusal helper `:2717-2742`,
> `operatorAcceptCompletion:2764` (first-statement check `:2770`, the
> full-autonomy+grant re-check `:2825`).
> `capabilities.ts` — `repairDeliveryGrants:399`,
> `BROWSER_CAP_ID`/`WEB_EGRESS_CAP_ID` `:453-454`,
> `repairBrowserEgressGrants:475`, `applyGrantCouplings:510`,
> `normalizeDeliveryGrants:525`, `absentDeliverReviewPrMode:552` (everything
> at or before `SCOPED_DELIVERY_CAPABILITY_IDS:346` is unmoved).
> `agents-query.server.ts` — `ACCEPT_COMPLETION_CAP_ID:121`,
> `applyAutonomyCeiling:155`, `capabilitiesToActionLabels:180`.
> `accept-confirm.tsx` — mode union `:50-56` (still six modes),
> `skipsStages:218`, disclosure echo built `:254`, drift render `:375-388`.
> `specialist-run.server.ts` — withheld grants `:249`/`:1238`, mount `:1366`,
> persona append `:2015-2018`, "Browser not mounted" `:2021`, resume `:2461`.
> `task-file.schema.ts` — `acceptanceBlockedReason:672`,
> `closedPrBlockedReason:716`, `conflictingPrBlockedReason:737` unmoved;
> `PACKET_OPTION_KINDS:74-102` (still TEN kinds), `deleteBranch:408`.
> `pr-human-approval.server.ts:210`/`:306`, `rebuilder.server.ts:336-337`,
> `update-branch-operator.server.ts:76`, `no-change-completion.server.ts`
> (`:69`/`:79`/`:107`/`:280`/`:339`/`:361`) all unmoved.
> UI: `agents-page.tsx` `canManage:1249`; `settings-page.tsx`
> `canManageLifecycle:1483`, CredentialCard now rendered at `:1352` (F21-5);
> `github-view.tsx` `canSeeCredential` prop `:49`/`:64`, used `:79`/`:148`;
> `project.github.tsx` redaction call `:64`.
>
> §7 and §8 below are HISTORY (the pass-20→21 delta); read them as such.

> **Verified 2026-08-19 against `main @ce2bc9e`** (worktree
> `claude/viberr-app-inspection-1fe423`, identical to main). Every anchor below
> was re-read at that sha.
>
> **Why nearly every line number moved since the pass-20 copy of this doc.** That
> doc says it was verified at `b97ad02`, which is an *ancestor of pass 20's own
> implementation commits* — band 1 (`1483544`), bands 2-4, and the merge
> (`6c94f2c`) all landed after it, and then two lint-only commits (`54ffab8`
> installing the anti-slop oxlint plugin, `ce2bc9e` fixing 2,843 findings across
> 835 files) rewrote signatures and comment blocks throughout `app/`. So the
> pass-20 doc's anchors were stale *for pass-20 work* as well as for the lint
> pass, and three of its statements were substantively wrong. See §8.
>
> **Line numbers are the perishable part of this document.** The docblocks in the
> cited files are the durable record; if an anchor misses, grep the symbol name.

Viberr has **three permission systems that never mix**, plus one gate that sits
across them:

| System | Governs | Single source |
| --- | --- | --- |
| **Human RBAC** | what a *person* may do on a project, keyed by their project role | `app/shared/rbac.ts` |
| **Agent capability policy** | what an *AI agent* (specialist or operator) may do at runtime, keyed by per-profile capability grants | `app/shared/capabilities.ts` |
| **Operator autonomy** | whether the operator *performs* a governed action or only *recommends* it | `app/server/tasks/operator-actions.server.ts` |
| *(cross-cutting)* **Acceptance gate** | when a task may reach Done at all | `acceptanceBlockedReason` + `verdictGateReason` |

Never conflate them. A human's role never grants an agent anything; a capability
grant never lets an agent do what `ALWAYS_HUMAN` reserves; and autonomy is a
*ceiling* on capabilities, never a source of them.

---

## 1. Human RBAC (`app/shared/rbac.ts`) — Verified 2026-08-19

The whole module is 111 lines. Read it before changing anything here; its
docblock (`rbac.ts:3-27`) is normative.

### 1.1 Roles

**Two org roles: `admin` | `member`.** Stored on the `users` row —
`db/migrations/0001_baseline.sql:28` (`CHECK (role IN ('admin','member'))`) and
`:260` for the invite/seed table. `users.role` is the **sole** org authority:
there is no better-auth membership plugin. Read it only through
`isOrgAdmin(db, userId)` (`app/server/auth/project-authority.server.ts:152-159`),
which also excludes disabled accounts.

**Four project roles, a strict tier `viewer ⊂ contributor ⊂ maintainer ⊂
admin`.** The tuple is `PROJECT_ROLES` at
`app/schemas/project-file.schema.ts:23-24`, re-exported from `rbac.ts:29`;
`ROLE_RANK` at `rbac.ts:31-36`, `ROLE_LABEL` at `:38-43`. They are stored
per-project in `project.md` `members[].role`
(`project-file.schema.ts:65`) and mirrored in SQLite at
`0001_baseline.sql:69`.

**Rename history:** `contributor` was formerly `reviewer` (ruling 2's amendment,
`docs/architecture/decisions.md:143-147`). The rename dropped a misleading
label — review authority actually rides **per-task ownership**, not the role
(§1.5). Nothing in the tree should still say `reviewer` as a *project role*;
"reviewer" now only ever means a specialist engaged to review.

Every action in the matrix is **monotonic** (if a role holds it, every higher
role does too), so `ROLE_RANK` + a floor would suffice — the explicit role list
exists so the Policy page can render role columns directly (`rbac.ts:13-16`).

### 1.2 `ACTION_ROLES` — the single source (`rbac.ts:61-111`)

`RBAC_DEFINITIONS` (`rbac.ts:61-88`) is ONE array of `{id, label, roles[]}`.
**The server guards consult it and the Policy/Profile permission tables render
the same object**, so enforcement and display can never drift.
`RbacAction` is derived at `:90`; `ACTION_ROLES` (the `Map`) at `:92-96`;
`roleCan(role, action)` at `:99-102` (a null role — non-member — never holds
anything); `rolesForAction(action)` at `:105-111` (throws on an unknown id).

The **18 actions** (A=admin, M=maintainer, C=contributor, V=viewer):

| # | Action id | Label | Roles | rbac.ts |
| --- | --- | --- | --- | --- |
| 1 | `view` | View board, tasks & timelines | A M C V | `:62` |
| 2 | `comment` | Comment on tasks | A M C V | `:63` |
| 3 | `create-task` | Create tasks | A M C | `:64` |
| 4 | `own-task` | Take / release own task ownership | A M C | `:65` |
| 5 | `approve-transition` | Approve stage transitions | A M | `:66` |
| 6 | `resolve-packet` | Resolve decision packets | A M | `:67` |
| 7 | `accept-completion` | Accept completion → Done | A M | `:68` |
| 8 | `update-goal` | Edit the task goal | A M | `:69` |
| 9 | `run-agents` | Run agents | A M | `:70` |
| 10 | `reorder-board` | Reorder the board | A M | `:71` |
| 11 | `reconcile-github` | Reconcile GitHub state | A M | `:72` |
| 12 | `grant-github-scope` | Grant GitHub scope | A M | `:73` |
| 13 | `rescan-project` | Re-scan project files & projections | A M | `:74` |
| 14 | `release-any-ownership` | Release any task owner | A | `:75` |
| 15 | `manage-members` | Manage members & roles | A | `:76` |
| 16 | `manage-agents` | Manage agent profiles | A | `:77` |
| 17 | `edit-policy` | Edit workflow & policy | A | `:78` |
| 18 | `force-accept-completion` | Force-accept past the review gate | A | `:83` |

`view` and `comment` are the two rows **no role tier narrows** — every role holds
them, so their entire enforcement IS the membership gate (§1.3); they never call
`requireAction`. They used to carry an `appWide` flag that made the Policy page
draw one merged "Any signed-in user · membership not required" cell; post-R15-4
that sentence was simply false and the flag was deleted (`rbac.ts:50-60`).

`force-accept-completion` (#18) is deliberately narrower than
`accept-completion` — the audited DG-2 escape hatch, §3.2.

**The server chokepoint** is `requireAction(db, project, actor, action, what)`
(`app/server/tasks/task-actions.server.ts:267-282`): it applies the R6-3
archived-project freeze (`requireProjectMutable`) and then resolves authority
through `requireProjectAuthority` with `rolesForAction(action)`. There is also
`requireAnyMember` (`:252-265`) — the loosest gate, used on idempotent/no-op
paths — which routes through the same authority resolution as `"any-member"`.

### 1.3 Membership is the outer gate on every action (R15-4 / ruling 25)

A project is visible **only to its members** (plus org admins, as the audited D2
override); a non-member is refused with the **unknown-slug 404**, never a 403
(`rbac.ts:18-27`). Three enforcement points, all producing byte-identical copy
`No project at projects/<slug>.`:

1. **Reads** — the project layout loader, `app/routes/project.tsx:75` (missing
   project) and `:89-91` (non-member, no org-admin override). `memberRole` is
   read at `:80-81`; `orgAdminOverride` at `:88`; the effective role handed to
   every child surface at `:132`.
2. **Actions** — `requireVisibleProject(db, slug, actor, what)`
   (`app/routes/project-visibility.server.ts:28-43`). React Router runs a child
   route's ACTION without its parent's loader, so a POST reached the mutation for
   any authenticated user; commenting is deliberately role-free, so this gate was
   its ONLY authority. Archived projects stay reachable here
   (`allowArchived: true`) — the R6-3 read-only gate belongs to each mutation.
3. **Config views + run artifacts** — `requireProjectMember(request, slug, what)`
   (`app/server/auth/require-project.server.ts:33-60`). **F19-28**: it used to
   throw `assertProjectAction`'s own 403, which distinguished "exists but you are
   not a member" from "does not exist" — reachable directly because single-fetch
   honors a client-supplied `?_routes=` filter, so
   `GET /projects/<slug>/policy.data?_routes=…` runs the child loader alone and
   the layout's 404 never executes. Both modes now collapse into one 404
   (`projectNotFound`, `:81-93`), which also **declines to echo the slug** on the
   two run-addressed resource routes (`/resources/run-log`,
   `/resources/session-export`) where the slug came from the run row rather than
   from the requester. The check is positional, not `includes` — a project
   literally slugged `resources` would otherwise leak.

### 1.4 Authority resolution + the D2 org-admin override

`app/server/auth/project-authority.server.ts` is THE single resolution path
(pass-7 R7-1). `resolveProjectAuthority(db, project, actor, allowed, audit)`
(`:173-258`) owns three rules:

1. **Membership role** (`:180-186`) — the actor's live role from `project.md`
   `members[]` checked against the caller's allow-list (or `"any-member"`).
   Granted under the actor's own role, never marked an override.
2. **D2 org-admin emergency override** (`:187-231`) — an ORG admin whose
   membership role would be denied (non-member, or a member below tier) is
   granted project-admin-equivalent authority, and **every such grant writes a
   `project.org_admin.override` audit row** (`:217`). An org admin whose own
   membership suffices is NOT an override and writes no row.
   **F19-30**: the `"any-member"` gate used to be *exempt* from the override row
   ("every real mutation the override enables names a concrete `RbacAction`") —
   false, because **commenting** is a real, deliberately role-free mutation, so
   an org-admin non-member could write into a members-only project leaving no
   row at all. It is audited now; the page-load-noise complaint is answered by
   **collapsing repeats inside a 60 s window** (`:209-216`) keyed
   `ovr|userId|slug|what` — the caller's `what` is in the key, so a READ gate can
   never mask a WRITE gate. `RbacAction` gates are never collapsed.
3. **Denial** (P13-D-8 / NFR10, `:232-256`) — every refusal writes a
   `project.authority.denied` row, deduped per `deny|actor|project|action` in the
   same 60 s window (`shouldRecordOnce` `:108-124`, constants `:104-106`) so a
   polling client cannot bury a deliberate probe.

Throwing wrappers and siblings:

| Symbol | Line | Role |
| --- | --- | --- |
| `requireProjectMutable` | `:136-149` | the single R6-3 archived-project 409 |
| `isOrgAdmin` | `:152-159` | `users.role`, disabled accounts excluded |
| `requireProjectAuthority` | `:265-283` | canonical task-guard 403 |
| `requireRunAgents` | `:293-309` | adds the archived read-only gate before the tier check (F17) |
| `canRunAgents` | `:311-330` | non-throwing @mention sibling (`silentDeny`) |
| `assertProjectAction` | `:337-390` | slug-only config surfaces; re-reads `project.md` fresh |

### 1.5 The TASK-OWNER exception (R14-2, extended by ruling 22 / R15-3)

**This is not in the `ACTION_ROLES` table and the pass-20 doc omitted it. Do not
implement acceptance or packet resolution as "A|M only".**

`app/server/tasks/task-actions.server.ts`:

- `ownerException(project, actor, ownerUserId)` (`:284-296`) — true when the
  actor IS the task's owner **and** their live project role holds `own-task`
  (i.e. contributor or above; a viewer owner does not qualify).
- `requireAcceptCompletion` (`:299-308`) — owner exception, else
  `requireAction(..., "accept-completion")`.
- `requireDecisionAuthority` (`:310-333`) — owner exception, else
  `requireAction(..., "resolve-packet")`. Its docblock records the pass-14
  widening (P14-GV-01/GV-07): the pass-12 exception covered only packets +
  acceptance, so a contributor owner whose task carried an operator
  recommendation was counted "waiting on you" and then 403'd by
  `applyRecommendation` / `dismissRecommendation` — a dead-end inbox entry.

The owner clears the **outer** gate only. Each recommendation's INNER mutation
keeps its own cap (an owner applying "assign a specialist" still needs
`run-agents`), so this widens what an owner may *decide about their own task*,
never what they can make the machinery do. Ownership copy says it out loud:
"owner is the human reviewer and acceptance authority for this task"
(`task-actions.server.ts:3071-3073` at HEAD). *(Pass-22, PR #186: the owner
cell's Manage popover is gone from the UI; take/release still ride actions
#4/#14 on the Current-state Owner row — no change to this section's rules.)*

### 1.6 Archive semantics

- **Archived PROJECT (R6-3)** — read-only: every governed mutation refuses with
  a 409 through `requireProjectMutable`
  (`project-authority.server.ts:127-149`); reads, timelines and audit stay
  available. The single exemption is the restore action itself.
- **Archived TASK (R14-3, ruling context at `task-actions.server.ts:4465-4488`)**
  — `setTaskArchived` (`:4490+`) is a *disposition, not a delete*: the file and
  the whole timeline survive, the task leaves the board's default view and the
  review queue, its open packet and pending recommendations are withdrawn and
  recorded in the archive note, and it is reversible. **Authority mirrors the
  board-management tier: `approve-transition` (A|M)** — the same authority that
  moves a task between stages decides that it leaves the flow
  (`requireAction(..., "approve-transition", …)`, `:4495-4500`). A task inside an
  archived project cannot be archived, because `requireAction` applies R6-3
  first.
- **`archive_task` as a packet option** — a resolvable packet kind
  (`app/schemas/task-file.schema.ts:88-93`), optionally `deleteBranch: true`
  (`:405`), re-checking the same `approve-transition` authority inside the case
  (`task-actions.server.ts:4962-4970`) so packet resolution cannot silently widen
  R14-3. Remote-branch deletion exists ONLY as this packet resolution (ruling 17).

### 1.7 F18-6 — the last-live-admin guard (ghost-admin deadlock)

`removeMember` in
`app/features/project-settings/settings-actions.server.ts:840+`. When the target
member has `role === "admin"`, the guard counts only **live** admins: it reads
the target's `users.disabled` flag, computes `targetLive` (`:888`) and refuses
only when `targetLive && countLiveAdmins(...) <= 1` (`:889-892`;
`countLiveAdmins` imported from `./membership.server` at `:40`). A **ghost
admin** (its org account was deleted, so it is not live) is therefore always
removable — closing the deadlock where Settings→Members refused the removal
("…is the only admin — assign another admin in Policy first") while Policy
pointed circularly back at Members. A real last live admin stays protected. The
org-level sibling: `deleteOrgUser` uses `countActiveAdmins(db) <= 1` and
`pruneUserFromProjects` drops a deleted account from every project's membership
so no ghost is created in the first place (UI-29,
`app/server/org/org-users.server.ts`).

---

## 2. Agent capability policy (`app/shared/capabilities.ts`) — Verified 2026-08-19

Separate from human RBAC: what an AGENT may do at runtime. Grants are stored
per-deployment in `project.md` `agents[].capabilities[]` as
`{capabilityId, mode}` (`app/schemas/project-file.schema.ts:65-76`, `:131`).

### 2.1 Modes, the catalog, and the polarity that bites

`CapabilityMode` = `direct` | `recommend` | `human` | `off`
(`project-file.schema.ts:36`):

- `direct` — the agent performs it;
- `recommend` — the operator proposes, a human applies (**operator-only
  semantics**, see §2.4);
- `human` — reserved for a human;
- `off` — withheld entirely (the tool is not even offered).

`UNIFIED_CAP_CATALOG` (`capabilities.ts:33-137`) is the single catalog; each
entry carries `kinds` (`operator` | `agent`), an editor `group` (`null` =
matrix-only, no toggle), a `defaultMode`, and `promotable`
(`UnifiedCapabilityDef` `:13-22`, builder `cap()` `:24-31`).

**Critical polarity (P13-AP-06, `capabilities.ts:139-147`):** `capabilities: []`
does **NOT** mean "no powers" — the tool policy treats an *unspecified*
capability as **granted**, so every creation path persists explicit grants.
`defaultGrantsFor(kind)` (`:148-155`) grants everything at its catalog default;
`conservativeGrantsFor(kind)` (`:175-186`) is the org-template starting set that
WITHHOLDS the dangerous ones (`execute-code-or-write-repo`, the scoped delivery
trio, the verdict outcomes) because the org editor has no capability UI.

The runtime's own read of a grant is `effectiveCollabMode`
(`app/server/tasks/agent-outcome.server.ts:377+`): an explicit
`direct`/`human`/`off` is authoritative; `recommend` is NOT (it has no agent
runtime meaning and falls through to the catalog default — `off` for everything
but the `direct`-default caps). Callers: the collaboration gates
(`agent-outcome.server.ts:407-412`), the browser mount
(`specialist-browser-mcp.server.ts:106`, `:115`) and the run's disclosure flags
(`specialist-run.server.ts:2845-2850`).

### 2.2 `ALWAYS_HUMAN` — the structural locks

`ALWAYS_HUMAN_CAPABILITY_IDS` (`capabilities.ts:194-198`): **`merge-pull-request`,
`transition-to-done`, `change-project-policy`**. They are `human` mode in the
catalog with `promotable: false` (`:134-136`), and `capabilityEnforcement`
returns `"both"` for them — checked BEFORE the claude-only set so a cap that is
both is never mislabeled advisory (`:263-271`). No agent ever holds them in an
actionable mode. Done stays human-only except the one deliberate
`operatorAcceptCompletion` exception (§3.6).

### 2.3 Enforcement scope (honesty metadata)

`capabilityEnforcement(id)` (`:263-271`) → `both` | `claude-only` | `advisory`:

- **`ENFORCED_CAPABILITY_IDS`** (`:206-241`) — withholding actually constrains
  runtime on both backends: `create-task-branch`, `commit-push-branch`,
  `open-review-pr`, `merge-pull-request`, `execute-code-or-write-repo`,
  `assign-primary-specialist`, `summon-reviewers`, `generate-packets`,
  `append-typed-events`, `stage-transitions`, `completion-for-acceptance`,
  `deliver-review-pr`, `update-task-branch` (`:221`), `transition-to-done`,
  `change-project-policy`, `report-validation-verdict`, `ask-human`,
  `attach-evidence-references`, `use-web-search-fetch`, `use-browser` (`:240`).
- **`CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`** (`:250-258`) — enforced via Claude's
  tool denylist, advisory on Codex: `create-task-branch`, `commit-push-branch`,
  `open-review-pr`, `comment-on-task`.
- Everything else is advisory (persona guidance only).

The **toggleable** subset — the ids whose mode is genuinely consulted at runtime,
and therefore the only ones the capability-matrix modal offers — is **13**,
pinned exactly by `app/features/agents/capability-catalog.test.ts:40-66` with
the group order `Repository & execution` → `Collaboration` → `Reserved for
humans` (`:67-71`): 4 repo caps + 5 collaboration gates (`comment-on-task`,
`ask-human`, `report-validation-verdict`, `attach-evidence-references`,
`use-web-search-fetch`) + `use-browser` + the 3 always-human.

**Two capabilities post-date pass 19** and are still current:

- **`update-task-branch`** (`capabilities.ts:72-76`, N19-9 owner ruling) —
  bringing a task branch up to date with its base is an OPERATOR decision, like
  delivery. The server executes the merge+push; agents never rebase or
  force-push. An absent grant follows the DELIVERY gate (`updateBranchGate`,
  which lives in **`app/server/github/update-branch-operator.server.ts:76`**, not
  in `operator-actions.server.ts`), because the capability post-dates every
  deployment. `operator` kind, group `Permissions`.
- **`use-browser`** (`capabilities.ts:101-111`, R19-19 / ruling 75) — §2.6.

### 2.4 Delivery headline, scoped grants, verdict outcomes, specialist coercion

- **Headline gate.** `execute-code-or-write-repo` (`capabilities.ts:78`) gates
  the three scoped delivery caps `SCOPED_DELIVERY_CAPABILITY_IDS`
  (`:346-350`: `create-task-branch`, `commit-push-branch`, `open-review-pr`) in
  `specialist-tool-policy.resolveDeliveryPermissions`.
- **`repairDeliveryGrants`** (`:399-447` at HEAD) materializes an **ABSENT**
  headline to `direct` when scoped grants are actionable (the real editor
  artifact — a form that submits scoped grants and omits the headline; the
  shape that produced VIB-1). An **EXPLICIT** `off`/`human` headline is
  **respected** (B-AG1): the save layer only fills in what nobody set, never
  flips an admin's withholding; it returns a notice of kind `withheld` so the
  contradiction is *reported*, not resolved behind the admin's back.
  `normalizeDeliveryGrants` (`:525`) is the repair-detail-dropped wrapper.
  **Pass-22:** the notice types were generalized for the browser→egress
  coupling — `GrantCouplingNotice` (with `rule: "delivery-headline" |
  "browser-egress"`) / `RepairedGrants`, and `applyGrantCouplings` (`:510`)
  runs BOTH rules on every profile save (`agent-profile-actions.server.ts`),
  returning `notices[]`. Note the two rules' polarities differ **on purpose**:
  the delivery headline respects an explicit withholding (a real, enforceable
  state), while `repairBrowserEgressGrants` (`:475`) flips an explicit
  `use-web-search-fetch` withholding UP to `direct` under a `direct` browser,
  because that contradiction expresses no policy — the mount fails closed
  either way (`:456-474` documents the divergence).
- **Verdict outcomes.** `applyVerdictOutcomeGate` (`:300-319`): the three
  outcome caps (`VERDICT_OUTCOME_CAPABILITY_IDS` `:279-283` — `approve-review`,
  `request-changes`, `post-quality-flags`) render as granted only when
  `report-validation-verdict` is explicitly `direct`; otherwise they render `off`
  (F15-06 honesty). Same polarity as `effectiveCollabMode`.
- **R15-9 absent-delivery derivation.** `absentDeliverReviewPrMode(humanGatedBeforeWork)`
  (`:469-473`) derives the mode for a pre-R15-2 deployment from whether the
  project human-gates advancement, so the runtime gate (`deliverGate`) and the
  policy surface (`effectiveProfileView`) cannot drift (that drift was F15-20).
- **NEW since the pass-20 doc — `coerceSpecialistCapabilityMode`** (`:321-341`,
  **R20-6 / ruling 81**). A specialist acts **DIRECTLY or is WITHHELD**;
  `recommend` is dropped for the specialist kind. This function used to WIDEN a
  specialist `recommend` to `direct` at every call site, so a stored `recommend`
  was rendered, counted and enforced as `direct` — the seeded canonical
  `project.md` said "Move the task to Review: recommend" while every rendered
  surface said "Acts directly". Now a stray `recommend` (hand-edited
  `project.md`, hostile form post) normalizes **DOWN to `off`** — the safe
  direction — at both the write path and the display read, and the seed writes
  `direct` (`app/server/seed/agent-catalog.server.ts`).
  **Re-introducing a `recommend → direct` transform here is the F20-21
  regression.** The picker mirrors it: `SPECIALIST_CAP_MODES` offers three modes
  (`Allowed`/`Human-only`/`Off`) at
  `app/features/agents/capability-catalog.ts:149-153`, while
  `OPERATOR_CAP_MODES` (`:137-142`) keeps all four because `recommend` has real
  operator semantics.

### 2.5 The display MIRRORS the runtime gate (R20-7 / ruling 82) — NEW since pass 20

`capabilitiesToActionLabels(capabilities, extras, autonomy)` in
`app/features/agents/agents-query.server.ts:178-205+` is the ONE derivation every
capability surface renders (profile detail, capability matrix, policy counts).
It applies **two** gates in order: `applyVerdictOutcomeGate` (F15-06), then
`applyAutonomyCeiling` (`:153-165`, `ACCEPT_COMPLETION_CAP_ID` at `:119`).

The defect this closed (F20-9 / D1): an operator profile holding
`completion-for-acceptance: direct` on a project deployed **supervised** rendered
"Accept completion into Done" under ACTS DIRECTLY — authority the server refuses
(`operator-actions.server.ts:2674` also gates on `authority.autonomy !== "full"`).
The display now renders that row as RECOMMENDS ONLY under a supervised project.
The operator's configured autonomy is read at
`agents-query.server.ts:403-407` and passed at `:431-432`; `autonomy` is
`undefined` for a specialist, so the ceiling is a no-op there.

Also note the deliberate bucket split (NEW-3): `human` → `forbidden` ("Reserved
for humans"), `off` → its own `off` bucket ("withheld"). Conflating them made an
explicitly withheld capability read as a structural lock.

### 2.6 `use-browser` — the browser capability (R19-19 / ruling 75)

Ruling 75 gave agents a real headless browser and made it a **first-class
capability rather than an org-registry MCP row**. That distinction is the whole
governance story: registry MCPs sit outside capability policy (ruling 39 /
P13-KM-04 — granting the server IS the grant), and a browser is exactly the tool
that must not ride that gap, because it IS network egress, it executes page
JavaScript, and it feeds page content back into an agent that may hold repo-write.

**Catalog entry** — `capabilities.ts:101-111`: `kinds: ["agent"]`, group
`Collaboration`, **`defaultMode: "off"`**, promotable. Default-off for the same
reason `report-validation-verdict` is (`:112-114`). Under the polarity in §2.1,
*absence is withholding* for this cap.

**Enforcement is the MOUNT itself** —
`app/server/tasks/specialist-browser-mcp.server.ts`:

- `resolveBrowserMcp({grants, attachmentsDir, backend})` (`:100-142`) returns
  `{server, refused}`. It mounts nothing unless
  `effectiveCollabMode(grants, "use-browser") === "direct"` (`:106`).
- **The egress pair** (`:115-121`) — the mount *additionally* requires effective
  `use-web-search-fetch === "direct"`. A profile whose web egress was revoked
  must not re-acquire it one row down. The contradictory pair is **surfaced** (an
  `UnresolvedMcpGrant` riding the existing disclosure pipe, type imported at
  `:7`, field at `:63-69`), never mounted.
  **Pass-22 (PR #176, owner ruling 2026-08-20):** the pair is now also made
  *inexpressible at the save layer* — granting the browser repairs egress to
  `direct` (`repairBrowserEgressGrants`, §2.4) and the capability editor pins
  the egress row to Allowed while the browser is Allowed
  (`create-profile-modal.tsx:697-761`, reason in the accessible name). The
  earlier "surfaced, never resolved silently in either direction" stance was
  REVERSED here by the owner after a live incident (browser granted, egress
  off, every run honestly reporting "browser not mounted" against a matrix
  saying Allowed): unlike a withheld delivery headline, this contradiction
  enforces nothing. The mount gate stays as the backstop for hand-edited
  `project.md` files.
- A missing `@playwright/mcp` install refuses the same way, so "granted but not
  mounted" always carries a reason.
- This is `"both"`-backend enforcement in the strongest available shape: withheld
  ⇒ the server is never attached, the tool surface does not exist, no deny rule
  is needed (`capabilities.ts:237-240`).

**Containment the server config keeps** (`specialist-browser-mcp.server.ts:34-44`,
`:136-139`, deliberate and tested): `--isolated` (in-memory profile — no
cookies/storage surviving a run or leaking across tasks); **no**
`--allow-unrestricted-file-access`, so Playwright MCP blocks `file://` and
confines file access to the child's cwd (the run workspace) — the browser cannot
read the data root; `--output-dir` → the task's canonical `attachments/` dir;
`--image-responses omit` on Codex only. Injection stance is **prompt-level**
(owner decision (b)): page content is data, never instructions; never enter
credentials; *the browser widens no authority*.

**Run wiring** — `app/server/tasks/specialist-run.server.ts`: the mount resolves
from the SAME grants the collaboration gates use, and only for a real backend
(`:1241-1242`); an unresolvable deployment passes `withheldAgentGrants()`
(`:237`, `:1163-1166`). The persona section is appended **only when the server
actually mounted** (`browserPersonaSection`,
`specialist-browser-mcp.server.ts:157`); a granted-but-refused browser gets a
"Browser not mounted" section naming the reason instead
(`specialist-run.server.ts:1861`), and the refusal also joins the run-input
disclosure. **Resume re-mounts from the same grants** (`:2287`), so a resumed run
cannot lose or gain the browser the fresh run had. The server name
`viberr_browser` (`specialist-browser-mcp.server.ts:50`) joins
`viberr`/`viberr_agent` in `RESERVED_MCP_NAMES`
(`specialist-mcp.server.ts:84-89`, skipped at `:163`) so an org registry row can
never shadow or impersonate it.

**Output governance** — files land in `taskAttachmentsDir`
(`app/server/files/file-store-root.server.ts:87`, i.e.
`projects/<slug>/tasks/<KEY>/attachments/`) and are served by
`app/routes/task-attachment.ts`. Authorization is **project membership**
(`requireProjectMember`, `:3`, `:33`) — the same bar as `/resources/run-log`,
and org admins pass via the audited D2 override inside that same guard. Serving
is hostile to content smuggling: traversal violations collapse into a plain 404
(no oracle), `X-Content-Type-Options: nosniff` (`:63`) and
`Content-Security-Policy: sandbox; default-src 'none'` (`:67`) on every response,
only whitelisted types inline, and a 50 MB refusal bound
(`MAX_ATTACHMENT_BYTES` `:29`, checked `:49`).

> **Gotcha worth carrying forward** (`specialist-browser-mcp.server.ts:34-44`,
> verified live on Playwright MCP 0.0.79): a **default-named** screenshot saves
> into `--output-dir` (the attachments dir a human can see); an
> explicitly-`filename:`d one resolves against the **child's cwd** (the run
> workspace) instead, because the SDK's stdio config carries no `cwd`. The
> persona therefore steers agents to default naming and says outright that a
> self-named file stays workspace-local where no human sees it.

---

## 3. The acceptance gate (verdict-gated completion) — Verified 2026-08-19

### 3.1 The gate

Acceptance into Done is gated by the revision-bound review model. The gate is
`acceptanceBlockedReason(fm)` (`app/schemas/task-file.schema.ts:672`) plus the
closed-PR / conflicting-PR guards (`closedPrBlockedReason` `:716`,
`conflictingPrBlockedReason` `:737`) — one reason-or-null helper per condition,
composed server-side by `acceptanceRefusalReason`
(`app/server/tasks/task-actions.server.ts:5577`, which folds in
`acceptanceStageBlockedReason` `:5541`) and consulted at every writer that lands
`stage=done`. The projection mirrors the same composition:
`rebuilder.server.ts:336-337` chains `acceptanceBlockedReason` then
`verdictGateReason`.

A task with NO required reviewers and NO revision stays acceptable (planning
work); once a revision exists, **every required reviewer must approve THAT
revision and none may request changes** (R15-1 / ruling 20).

**Pass-22 — ruling 88 (R21-5) hardened the ceremony into a SERVER invariant.**
Pass 21 found R15-1 held client-architecturally only (one dialog, hoisted
fetchers) while the server accepted a bare POST. Now every HUMAN acceptance
door — all six ceremony modes plus the board dialog — requires an
`AcceptanceDisclosure` acknowledgment echoing the three facts the dialog
rendered (the PR state, the delivered revision sha, the verdict); the server
refuses an acceptance without one, refuses an echo that no longer matches the
live task (the task moved under the dialog), and re-compares inside the write
lock. ONE shared definition, `app/shared/acceptance-disclosure.ts`
(`acceptanceDisclosureFields:55`, `parseAcceptanceDisclosure:85`,
`acceptanceDisclosureDrift:137`); the dialog builds the echo from its own
rendered props (`accept-confirm.tsx:254`) and hands it to the caller through
`onConfirm(disclosure)` (`:173-177`). Operator acceptance (§3.6) is unchanged —
it carries its own disclosure contract (rulings 40, 77).

### 3.2 `force-accept-completion` — the audited escape hatch (DG-2)

- Server: `forceAcceptCompletion`
  (`app/server/tasks/task-actions.server.ts:6311-6324`) —
  `requireAction(..., "force-accept-completion", "force-accept past the review
  gate")`, then it records the exact bypassed reason to the audit log and accepts
  with `force: true`. Its docblock (`:6305-6310`) states the DG-2 rationale.
- Client predicate: `roleCan(myRole, "force-accept-completion") &&
  !acceptanceTerminallyBlocked` (`app/features/task-detail/task-detail-hooks.ts:167-169`).
  The affordance is **withdrawn** (not disabled) while a PR is closed unmerged —
  ruling 37: a closed PR is decided, not wedged.
- **R19-5 (ruling 59) — force MAY jump, but must SAY so.** A pass-19 implementer
  read F19-25 as "force-accept must not jump the workflow graph" and added a
  server 409 refusing an off-boundary force; **the owner REVERTED it.** Force
  exists to unstick a wedged board. The burden is HONESTY: the dialog
  **enumerates the stages being skipped**, by name, in order. What force does NOT
  bypass is unchanged and non-negotiable — `forceIrreducibleRefusal`
  (`task-actions.server.ts:5660`) keeps ruling 37's terminal GitHub fact (a
  closed, unmerged PR still refuses **server-side**, not merely by hiding the
  button) and ruling 20's PR-head containment check.

> `app/features/review/review-acceptance-authority.server.ts` answers a DIFFERENT
> question and is not force-accept's authority: `resolveAcceptanceAuthority`
> (`:29-47`) reports whether **the project's deployed OPERATOR** can accept
> (`deployed && autonomy === "full" && gate(...,"completion-for-acceptance") ===
> "direct"`), so the review queue can qualify its human-only-Done claim. Its
> docblock still cites `operator-actions.server.ts:229` / `:1632`, which are
> stale anchors — the real gate is `gate()` at `operator-actions.server.ts:443`
> and the acceptance check at `:2674`.

### 3.3 "Completed — no changes required" (R19-8 / ruling 62, tightened by R20-2 / ruling 77)

Ruling 43's "reviewer verdict optional" clause is **superseded**: the no-change
path passes the SAME verdict gate. It mints a `workRevision` anchored to the real
default-branch head (a verdict needs a subject), keeps the full ceremony, and
only loses the PR. The counterpart honesty rule: `defaultBranchEvidence.verified`
from push-workspace is required on **both** doors (`no_branch`, `no_commits`), so
a dirty tree, local commits on the default branch, an abandoned task branch or a
swallowed auto-commit failure all stay a genuine delivery failure.

Machinery: `app/server/tasks/no-change-completion.server.ts` —
`noChangeApplies` (`:69`), `noChangeCandidate` (`:79`), `probeNothingToDeliver`
(`:107`), **`acceptanceNoChangeCheck` (`:280`)** and
**`assertVerifiedNoChangeStillApplies` (`:339`)** (the in-lock re-proof), and the
shared timeline-event builder `noChangeCompletionEvent` (`:361`).

**R20-2 / ruling 77 (new since the pass-20 doc):** `accept_completion`
**re-verifies the ACTUAL branch state** — empty or missing routes into the
no-change acceptance path, *with disclosure*, regardless of the agent's
`noChanges` flag — and a new **`discard_branch`** packet kind deletes a
never-pushed LOCAL task branch on confirm (`discardLocalTaskBranch`, called at
`task-actions.server.ts:5466` and `:5541` at HEAD). It refuses an on-remote
branch; remote deletion stays ruling 17's archive-packet path. This makes ruling
7's packet-kind list **TEN**: `accept_completion`, `request_edit`,
`block_on_policy`, `hold_runtime_debug`, `redirect`, `retry_other_backend`,
`edit_goal`, `archive_task`, `discard_branch`, `custom`
(`app/schemas/task-file.schema.ts:74-101`).

### 3.4 A human's GitHub approval IS the verdict (R19-B / ruling 68)

Closes the asymmetry where a human's *disapproval* bound the gate (ruling 37)
while their *approval* was inert, forcing every acceptance on an agent-less
project to be an audited force-accept. Four things make it evidence rather than a
rubber stamp:

1. it is **bound to the delivered revision** — the approval's `commit_id` must
   equal the delivered head, checked on record AND on every read, so a
   re-delivery invalidates it;
2. the approver must be a **project member**, resolved through
   `users.github_handle` (`pr-human-approval.server.ts:105`, disabled accounts
   excluded);
3. it **fails closed** — no linked handle, two claimants, or a non-member ⇒ it
   does not count, and the reason is recorded;
4. it is **never silent** — the gate names the human, their handle and the commit.

`humanVerdictApproval` (`app/server/github/pr-human-approval.server.ts:210`) and
`verdictGateReason(fm, validation, taskKey)` (`:306`), threaded through the
rebuilder's acceptance-block derivation
(`app/server/projections/rebuilder.server.ts:16`, `:336-337`). Because it binds
to a *delivered* revision it cannot fire on a no-change verification revision —
it composes with rulings 20 and 62 rather than carving either out.

### 3.5 Related acceptance rules

- **R17-1 / ruling 42 revision drift** — accepting a PR head strictly AHEAD of
  the reviewed revision is allowed (containment, not identity), but the accept
  dialog surfaces the extra unreviewed commits (`pr.revisionDrift`, rendered
  `accept-confirm.tsx:333-346`) and the audit names the real merge head. A head
  that has DIVERGED (no longer contains the delivered commit) still refuses.
- **R16-1 / ruling 35 adoption** — adoption is the *stronger* claim than the
  gate: a pre-existing PR is adopted only if it is OPEN **and** its head sha IS
  the delivered revision. Name-matched anything else is a branch COLLISION.
- **R16-x out-of-band merge** — a PR merged/closed on GitHub outside the app is
  NOT auto-advanced; the reconciler notes the divergence and recommends.

### 3.6 `operatorAcceptCompletion` — the ONE agent exception to human-only Done

`app/server/tasks/operator-actions.server.ts:2613`. A `full`-autonomy operator
holding an explicit `completion-for-acceptance: direct` grant moves the task to
Done itself (owner ruling Q1). Both halves are required and re-checked at
`:2674` (`authority.autonomy !== "full" || gate(...) !== "direct"` ⇒ refuse).
The capability is `promotable: false` (`capabilities.ts:64`) and `gate()` refuses
to promote `recommend`→`direct` for exactly this id
(`operator-actions.server.ts:455-460`), so a silent agent-close can never fall
out of an autonomy setting alone.

Under **R16-6 / ruling 40** this does NOT merge: `merge-pull-request` stays
`ALWAYS_HUMAN`, so the operator records `pr.state: "accepted"` (**merge
pending**), moves the task to Done, and a human completes the real merge later
through the `complete-merge` ceremony mode (§3.7).

### 3.7 One ceremony, six modes (R15-1 consolidation)

`app/features/task-detail/accept-confirm.tsx` is **the one acceptance ceremony**.
`AcceptCeremonyMode` (`:38-44`) covers every writer that lands Done — rulings
12/14, never fork a mapping per surface. Its docblock (`:7-35`) is the
authoritative narrative.

| Mode | The path that raises it | Raised at |
| --- | --- | --- |
| `accept` | the ordinary Accept button | `task-detail-page.tsx:754` |
| `force` | admin force-accept (adds the `Skips` and `Bypassing` rows) | `task-detail-page.tsx:737` |
| `complete-merge` (F19-24) | the mandatory human half of a full-autonomy operator acceptance (R16-6) — it performs the real, irreversible merge | `task-detail-page.tsx:734` |
| `apply-recommendation` (F19-3/F19-26) | applying an operator recommendation whose TARGET is the terminal stage, whatever its `kind` says | `task-detail-page.tsx:474` |
| `packet` (F19-7) | resolving a decision packet's `accept_completion` option, whose "Confirm decision" button named no merge at all | `task-detail-page.tsx:422` |
| `stage-move` (F19-37) | the Current-state stage menu picking the LAST stage, which the server reads as an acceptance | `task-detail-page.tsx:521` |

The dialog states exactly what merges: PR number + state pill (rendered through
the one PR-state map, `prStatePill`, imported `:2`), the delivered revision sha,
the merge head when it has drifted ahead (R17-1, `:333-346`), the verdict —
**naming the human and commit when R19-B's GitHub approval cleared it**
(`verdictSatisfiedBy`, prop `:118-123`/`:156-157`, rendered `:352-361`) — the
target branch, and any bypassed refusal. The `Skips` row (`:373`) is
**force-only by construction** (`skipsStages = force && !atBoundary`, `:202`);
the `Bypassing`/`Blocked` label flips on the same predicate (`:391`). Two earlier
rounds got this wrong in opposite directions and the reasoning is preserved
in-file at `:184-201` — read it before touching that predicate.

Wired at `task-detail-page.tsx` (import, pending-state union — one variant per
path — and render; anchors moved at HEAD, grep `AcceptConfirm`). **Pass-22:**
each mode's confirm now also BUILDS the ruling-88 acknowledgment the server
requires (§3.1) — the six modes did not change, but a seventh surface that
lands Done without this dialog can no longer exist, because the server refuses
the bare POST it would send.

The **board** keeps its own narrower dialog, `AcceptOnBoardConfirm`
(`app/features/board/board-page.tsx:941` at HEAD, docblock above it explaining
what it deliberately discloses less of), state `pendingAccept` at `:1540`;
it too builds the ruling-88 acknowledgment (Pass-22). A board drag into the FINAL stage routes through `reorderTask` →
`acceptCompletion`, i.e. it attempts a real PR merge (R18-7 / ruling 53); the
keyboard Move menu reaches the same acceptance (`:1649-1656`). It also handles
the card that leaves the board while the confirm is open (`:1728-1740`) rather
than rendering a dialog about a task that no longer exists.

---

## 4. Operator autonomy — Verified 2026-08-19

`OperatorAutonomy` = `supervised` | `full`
(`app/server/tasks/operator-actions.server.ts:100`), read from the deployment
`definition.autonomy` via `readAutonomy` (`:178`) and resolved by
`resolveOperatorAuthority` (`:350`). Supervised: the operator RECOMMENDS at
governed boundaries (delivery, transitions, acceptance) and a human applies.
Full: it performs them and may accept completion to Done (§3.6).

Gates (`Gate = "direct" | "recommend" | "deny"`, the type at `:156` — note `off`
is the capability MODE name, not a gate outcome):

- **`gate(authority, capabilityId)`** (`:443-463`) — `!deployed ⇒ deny` (A4);
  `direct ⇒ direct`; `recommend ⇒ direct` only at full autonomy **except**
  `completion-for-acceptance`, which stays `recommend` (`:455-460`, owner ruling
  Q1); `human` and `off` both ⇒ `deny`.
- **`deliverGate(authority)`** (`:473-499`) — R15-2 delivery with the deliberate
  **absent-means-granted** polarity for deployments that predate the capability,
  falling back to `absentDeliverReviewPrMode(humanGatedBeforeWork)` (R15-9). It
  refuses outright when **no operator is deployed at all** (A4) — the hole that
  once let an operator-less project push a branch and open a PR, denied HERE
  rather than at the five call sites.
- **`updateBranchGate(authority)`** — same absent-means-granted polarity, defined
  in `app/server/github/update-branch-operator.server.ts:76`, consumed at
  `operator-toolkit.server.ts:466` and `operator-run.server.ts:1233`.

### 4.1 R19-A (ruling 67) — autonomy is a CEILING, not a pin

`resolveOperatorAuthority` used to return `overrides.autonomy ?? configured`
verbatim, so **any `run-agents` role (maintainer+) could launch one turn at
`full` on a project whose operator is deployed `supervised`** — promoting every
`recommend` capability to direct execution with no confirm, no distinct audit
row, only a toast. The Policy page presents operator autonomy as *project*
configuration (ruling 2); a per-run dropdown that silently outranks it makes that
page a lie.

The configured autonomy is now a ceiling the run is clamped to — `clampAutonomy`
(`:224-235`), applied at `:377-379` (undeployed ⇒ `supervised`) and `:419-421`
(the configured level). Choosing **less** autonomy for a single run stays allowed
and is not a clamp; omitting the override is not a clamp either. The clamp is
audited **only when it actually bites**, via the typed
`task.operator.autonomy_clamped` fact (`AUTONOMY_CLAMPED_AUDIT_ACTION` `:194`,
`auditAutonomyClamp` `:249` at HEAD). `operatorAutonomyFor` (`:337`) is the
shared read of a deployment's configured level; `OperatorAuthority` carries
`configuredAutonomy` and `autonomyClampedFrom` so callers can disclose it. The
**display** mirrors this ceiling — §2.5. **Pass-22 (ruling 92 / PR #185): the
per-run autonomy dropdown no longer exists.** The old sentence "the selector
offers exactly the options that will really run" is moot — the operator card
now *states* the deployed profile's backend and the project's configured
autonomy (full autonomy announces itself as a caption; supervised is the quiet
default) and offers only Run plus an optional steer, which is recorded as the
human's own `@operator` timeline comment and passed as the run's
`humanComment` (`execution-profile.tsx:469+`). The clamp machinery above stays
as the server-side invariant behind that surface.

### 4.2 R19-6 (ruling 60) — `off` is a HARD REFUSE on every route

With `completion-for-acceptance: off`, an operator that could not *recommend*
accepting a completion still produced an `accept_completion` card and a
`task.operator.recommended_completion` audit row **by rerouting through a plain
terminal-stage transition** (F19-26's target-not-kind hole). `off` is a withheld
capability, not a routing hint. The gate is checked **FIRST — before any read,
card or audit row — on every path that reaches the action**, including the
terminal-target reroute (`operator-actions.server.ts:2459-2466` for the reroute;
the refusal helper's docblock at `:2566-2600`; the acceptance path's
first-statement check at `:2619-2626`). `human` refuses the same way while saying
the decision is reserved for a human (`:2597`). The operator refuses **out loud**
and narrates it: a silent reroute is worse than a refusal, because the human sees
a card whose authority does not exist.

See AGENTS-RUNTIME.md for how autonomy drives the R18-2 post-delivery re-queue
and the R19-4 supervised-delivery next-step guarantee.

---

## 5. Human RBAC → UI honesty (what a denied role SEES) — Verified 2026-08-19

Enforcement was already correct for every role; passes 19-20 closed the surfaces
that disabled a control without saying why (a disabled control cannot explain
itself through `title` — no pointer event reaches it). This matters for RBAC
because the reader's model of the policy comes from these notes.

> **Pass-22:** `settings-page.tsx` and `agents-page.tsx` grew again (F21-5
> credential card on settings, R21-2 remedy copy, "Claude" labels), so the
> table's line anchors below drifted once more — verified at HEAD:
> `agents-page.tsx` `canManage` at `:1249`; `settings-page.tsx` Danger-zone
> `canManageLifecycle` at `:1483`. Grep the quoted copy for the rest; the
> RULES all re-verified unchanged. Also note PR #186: the owned task's owner
> cell dropped its Manage popover — a surface simplification, not an
> authority change (§1.5 and actions #4/#14 stand).

| Surface | Rule | Anchor (2026-08-19) |
| --- | --- | --- |
| Project Settings — Project panel | lock note naming the **Edit workflow & policy** grant *(project admin)*. **F20-16 rewrote this copy**: the old "Change project settings (project admin or maintainer)" invented a grant that does not exist and wrongly promised maintainers. | note `settings-page.tsx:114-131` |
| Project Settings — Stages panel | the same lock note, and the "drag to reorder / click to rename" how-to renders only for a reader who can act (LV-F2) | `settings-page.tsx:793-812` |
| Project Settings — Members panel | lock note naming **Manage members & roles** *(project admin)* | `settings-page.tsx:932-941` |
| Project Settings — Repository & credentials | lock note (UXA-3 + F20-16) naming **Edit workflow & policy**; gated on `canRepair` | note `settings-page.tsx:1235-1250`, `canRepair={canEditPolicy}` `:1664` |
| Project Settings — **Danger zone** | **Q-V1 owner ruling**: the section renders ONLY when `roleCan(myRole,"edit-policy")`. It used to render for every member with disabled buttons — honest, but it showed a read-only stakeholder a destructive surface. The in-panel deny note stays for in-between roles. | `canEditPolicy` `settings-page.tsx:1552`, gate `:1721`; in-panel `canManageLifecycle` `:1435`, deny note `:1450-1457` |
| **Project GitHub — credential card** | **R19-11 / ruling 65** — the card is **withdrawn, not disabled**, below `grant-github-scope`, **and the loader redacts the same fields** (a client-only gate leaves the token tail in the HTML). **Pass-22 (F21-5):** the rule was EXTRACTED to `app/features/github/credential-visibility.server.ts` after pass 21 found `/settings` rendering the SAME CredentialCard unredacted for a Viewer (`github_pat_••••42af` in the HTML) — both routes now pass through the one rule (rulings 12/14). | shared rule `credential-visibility.server.ts` (`credentialGrantHolder:40`, `withoutCredentialDetail:70`); client gate `github-view.tsx` (`canSeeCredential` prop `:49`/`:64`, consumed `:79`/`:148`); loaders `routes/project.github.tsx:64` and the settings route; settings render `settings-page.tsx:1352` |
| Agents page | read-only note naming the **Manage agents** grant (UXA-15) | `agents-page.tsx:1344` (`canManage = roleCan(myRole,"manage-agents")` at `:1137`) |
| Task comment composer | "Every project member can comment · @mentions route to agents" — was the false "Open to every registered user" (UXA-1); membership IS the gate (R15-4) | `timeline.tsx:435` |
| Topbar org-admin override pill | the D2 sentence is the element's **accessible name** so keyboard/AT/touch reach it (UXA-13); a `title` carries the same sentence for pointer users | `topbar.tsx:151-159` (`title` `:154`, `aria-label` `:155`) |

---

## 6. What binds these claims in the suite

- `app/features/policy/policy-rbac.server.test.ts` — drives each server guard per
  role, keeping `ACTION_ROLES` bound to enforcement AND to the Policy table.
- `app/features/agents/capability-catalog.test.ts:40-71` — pins the exact
  13-member toggleable set and the group order.
- `app/server/tasks/specialist-tool-policy.test.ts` — pins the **absence** of any
  `mcp__*` deny rule (ruling 39: granting an MCP server IS the grant).
- R19-11 additionally requires a **full-page render at Viewer asserting the
  credential card is ABSENT, canaried by removing the gate** — because pass 19's
  audit caught the Danger-zone half sitting on an owner ruling with no test that
  could fail. *An owner ruling whose guard cannot go red is a ruling that gets
  reverted in silence.*

---

## 7. Delta: pass 20 (as merged) → 2026-08-19

- **`rbac.ts`: no semantic change since pass 17.** The 18-row matrix, `ROLE_RANK`
  and the accessors are unchanged in substance; only formatting/line numbers
  moved (lint commit `ce2bc9e`).
- **`capabilities.ts`: `coerceSpecialistCapabilityMode` inverted** (R20-6 /
  ruling 81) — a specialist `recommend` now normalizes DOWN to `off` instead of
  UP to `direct`, and the seed writes `direct`. §2.4.
- **Capability DISPLAY gained the autonomy ceiling** (R20-7 / ruling 82) —
  `applyAutonomyCeiling` in `agents-query.server.ts`. §2.5.
- **Ruling 7's packet-kind list is TEN** — `discard_branch` (R20-2 / ruling 77)
  plus the accept-path branch re-verification. §3.3.
- **Recovery-packet resolution** (R20-1 / ruling 76) — confirming any recovery
  option RESOLVES the packet and re-queues the operator; a manual "Run operator"
  is refused (`refused: "open-packet"`) while a packet is open.
- **Everything documented for pass 20 still holds**: F19-30's audited
  `"any-member"` override, the 13-cap toggleable set, `use-browser` and its
  egress pair, the autonomy ceiling, the `off`-is-a-hard-refuse rule, the
  six-mode ceremony, R19-11's withdrawn credential card. Only anchors moved.

---

## 8. Corrections vs the pass-20 doc (`planning/discovery-2026-08-14-pass20/reference/RBAC-GOVERNANCE.md`)

**Substantive:**

1. **§5's Project-panel row named the wrong grant.** It said the lock note names
   "**Change project settings**". That string is exactly what **F20-16 deleted**
   as an invented grant that also wrongly promised maintainers; the note now names
   **Edit workflow & policy (project admin)** (`settings-page.tsx:114-131`). The
   Repo panel's note was rewritten the same way.
2. **The pass-20 doc omitted the TASK-OWNER exception entirely**, so its
   `ACTION_ROLES` table reads as "acceptance and packet resolution are A|M only".
   They are not: a live contributor-or-above **task owner** clears both outer
   gates (`ownerException` / `requireAcceptCompletion` /
   `requireDecisionAuthority`, `task-actions.server.ts:284-333`; R14-2 widened by
   ruling 22 / R15-3). New §1.5.
3. **Force-accept authority was attributed to the wrong module.** The pass-20 doc
   said "Authority is resolved in
   `app/features/review/review-acceptance-authority.server.ts`". That module
   answers whether the deployed **OPERATOR** may accept (the Q1 exception).
   Force-accept authority is `requireAction(..., "force-accept-completion")` in
   `forceAcceptCompletion` (`task-actions.server.ts:6311-6324`) plus the client
   predicate at `task-detail-hooks.ts:167-169`. New §3.2.
4. **Three post-doc rulings were missing** because the pass-20 doc was verified at
   `b97ad02`, an ancestor of pass 20's own implementation commits: **R20-6 /
   ruling 81** (specialist `recommend` → `off`, §2.4), **R20-7 / ruling 82**
   (display mirrors the autonomy gate, §2.5), and **R20-2 / ruling 77**
   (`discard_branch`, the tenth packet kind, and the accept-path branch
   re-verification, §3.3).
5. **`updateBranchGate` does not live in `operator-actions.server.ts`** — §4 of
   the pass-20 doc reads as if it sits beside `deliverGate`. It is defined in
   `app/server/github/update-branch-operator.server.ts:76`.
6. **The topbar D2 pill carries BOTH `title` and `aria-label`** (`topbar.tsx:154`
   and `:155`). The pass-20 doc's phrasing ("lives in `aria-label`, not a
   `title`") describes the fix's intent, not the shipped markup — the `title`
   was kept for pointer users; what changed is that the sentence is now also the
   accessible name.

**Anchors (every one below moved; the pass-20 value is in parentheses):**

7. `rbac.ts` — `roleCan` `:99-102` (`:97-100`), `rolesForAction` `:105-111`
   (`:103-105`); the §1.2 module range is `:61-111` (`:61-105`).
8. `project-authority.server.ts` — `requireProjectMutable` `:136` (`:131`),
   `isOrgAdmin` `:152` (`:147`), `resolveProjectAuthority` `:173` (`:169`),
   D2 branch `:187-231` (`:183-227`), denial `:232-256` (`:228-252`),
   `shouldRecordOnce` `:108` (`:103`), `requireProjectAuthority` `:265` (`:261`),
   `requireRunAgents` `:293` (`:289`), `canRunAgents` `:311` (`:307`),
   `assertProjectAction` `:337` (`:333`).
9. `capabilities.ts` — catalog range `:33-137` still holds, but
   `ALWAYS_HUMAN_CAPABILITY_IDS` `:194-198`, `ENFORCED_CAPABILITY_IDS`
   `:206-241`, `CLAUDE_ONLY_…` `:250-258`, `capabilityEnforcement` `:263-271`,
   `VERDICT_OUTCOME_CAPABILITY_IDS` `:279-283`, `applyVerdictOutcomeGate`
   `:300-319`, `SCOPED_DELIVERY_CAPABILITY_IDS` `:346-350`,
   `repairDeliveryGrants` `:390-438`, `absentDeliverReviewPrMode` `:469-473`
   (the pass-20 doc's `:324-328`, `:361-403`, `:434-438` are all off by ~20).
10. `task-file.schema.ts` — `acceptanceBlockedReason` `:672` (`:630`),
    `closedPrBlockedReason` `:716` (`:674`), `conflictingPrBlockedReason` `:737`
    (`:695`).
11. `task-actions.server.ts` — `acceptanceStageBlockedReason` `:5541` (`:5045`),
    `acceptanceRefusalReason` `:5577` (`:5081`), `forceIrreducibleRefusal`
    `:5660` (`:5155`).
12. `operator-actions.server.ts` — `OperatorAutonomy` `:100` (`:95`), `Gate`
    `:156` (`:151`), `readAutonomy` `:178` (`:177`), `clampAutonomy` `:224`
    (`:215`), `auditAutonomyClamp` `:246` (`:237`), `operatorAutonomyFor` `:334`
    (`:322`), `resolveOperatorAuthority` `:350` (`:338`), `gate` `:443` (`:434`),
    `deliverGate` `:473` (`:464`), `operatorAcceptCompletion` `:2613` (`:2519`),
    the Q1 promotion refusal `:455-460` (`:449`), the R19-6 checks `:2459`,
    `:2619`, `:2674` (`:2364`, `:2472`, `:2525`).
13. UI — `settings-page.tsx` every row (`:114`, `:793`, `:932`, `:1235`, `:1435`,
    `:1450`, `:1552`, `:1721` vs the pass-20 `:109`, `:776`, `:882`, `:1169`,
    `:1367`, `:1382`, `:1483`, `:1649`); `agents-page.tsx` `canManage` `:1137`
    (`:1059`) and the note `:1344` (`:1255`); `github-view.tsx` gate `:136-148`
    and `:471` (`:136-150`, `:445-453`); `routes/project.github.tsx` predicate
    `:95-102` (`:101`); `accept-confirm.tsx` mode union `:38-44`, `skipsStages`
    `:202` (`:164`), reasoning block `:184-201` (`:132-162`), `Skips` row `:373`
    (`:312-326`), verdict/`verdictSatisfiedBy` `:352-361` (`:292-305`);
    `task-detail-page.tsx` import `:9` (`:8`), state union `:63-72` (`:63-80`),
    render `:769` (`:696-707`); `board-page.tsx` `AcceptOnBoardConfirm` `:924`
    (`:824`), state `:1521` (`:1505`), keyboard move `:1649` (`:1620`), render
    `:2044` (`:1987`), left-the-board effect `:1728-1740` (`:1685-1691`).
14. `require-project.server.ts` — `requireProjectMember` `:33-60`,
    `projectNotFound` `:81-93` (`:81-89`). *(This file was NOT touched by the
    lint pass; only the tail shifted.)*
15. `specialist-browser-mcp.server.ts` — `resolveBrowserMcp` `:100-142`
    (`:93-142`), the `use-browser` check `:106` (`:99`), the egress pair
    `:115-121` (`:106-114`), argv `:136-139` (`:123-138`),
    `browserPersonaSection` `:157` (`:150-173`); `specialist-run.server.ts` mount
    `:1241` (`:1180-1195`), resume `:2287` (`:2187-2226`), "Browser not mounted"
    `:1861` (`:1775-1784`); `specialist-mcp.server.ts` `RESERVED_MCP_NAMES`
    `:84-89` (`:60-65`), skip `:163` (`:139`).

**Still true and re-verified** (listed so nobody re-audits them): the 18-action
matrix and its role sets; the membership-is-the-outer-gate rule and the
byte-identical 404 including the no-slug-echo on run-addressed resource routes;
the F19-30 audited `"any-member"` override with 60 s collapse keyed on `what`;
the `capabilities: []`-means-granted polarity; the three `ALWAYS_HUMAN` ids; the
13-member toggleable set and its group order; `use-browser`'s default-off,
egress-pair, `--isolated`/no-unrestricted-file-access containment, reserved MCP
name and member-only attachment serving; R19-A's ceiling with the typed clamp
fact; R19-6's hard refuse; R19-5's force-may-jump-but-must-say; R19-8's
no-change ceremony; R19-B's revision-bound, fail-closed GitHub approval; the
six-mode ceremony and the board's narrower dialog; R19-11's withdrawn +
redacted credential card.
