# Task lifecycle, actions & RBAC/capability model

Reference doc, pass 27 (2026-08-24): how a task moves through stages, how human
actions are authorized, and how human RBAC and agent capability policy are
enforced. Every non-obvious claim is cited `file:line` against `pass26-fixes`
(≈ `origin/main`) — read the implementation, not just the quoted docblocks.
Three systems stay deliberately separate (orchestrator ruling 2,
`docs/architecture/decisions.md:137`): **org roles** (`admin|member`),
**project roles** (`admin|maintainer|contributor|viewer`), and **agent
capability policy** (`direct|recommend|human|off` per profile). None is derived
from another.

---

## 1. Task file anatomy

Canonical shape: `app/schemas/task-file.schema.ts`. A task is a directory
(`task.md`) parsed tolerantly — a bad field never drops the task, it falls back
with a `FileDiagnostic` (`parseTaskFrontmatter`, :1091-1346). The frontmatter
fields and what each drives:

| Field | Drives |
|---|---|
| `key`, `title`, `stage` | identity + board column (`stage` is a project-defined id, not a literal) |
| `readiness` (`READINESS_VALUES`, :25-31) | `ready\|input_required\|inconsistency_risk_detected\|blocked` — the 4-value canonical enum; `"accepted"` is a **display-only** derived state, never stored (module docblock, :19-21) |
| `waiting` (:33-34) | `human\|agent\|none` — who the board says the task is waiting on |
| `ownerUserId` | the human owner seat (§4) |
| `engagements[]` | every agent engaged on the task (below) |
| `operator` | `{assignedAtStageId}` — set once, when the task first leaves the entry stage (ruling 16) |
| `recommendations[]` | operator one-click action cards (`RECOMMENDATION_KINDS`, :222-243: `assign_specialist\|assign_reviewer\|transition\|run_specialist\|run_reviewer\|accept_completion\|delivery`) |
| `schedules[]` | governed future operator re-runs (O-3), lifecycle `pending→claimed→fired\|failed\|cancelled` (:270-281) |
| `priority`, `labels`, `dueDate`, `urgent` | lightweight triage metadata (§2) |
| `archived` | R14-3 terminal disposition — frozen, off the default board/queue, restorable |
| `validation` | **derived cache only** — `deriveValidation` is its one writer (:592-594, :677-728) |
| `workRevision`, `verdicts[]` | the F10-15 review-state model (§7) |
| `branch`, `pr`, `github` | delivery/GitHub cache, written by the reconciler, not by hand |
| `noChanges`, `acceptance` | the "Completed — no changes" flag (R17-2/R19-8) and the force-accept durable fact (N20-14) — both §7 |
| `boardRank` | sparse drag-order rank; `null` falls back to the task-key number |

**Engagements** (`engagementSchema`, :180-195) replaced the old
`specialist` + `reviewers[]` slots (generic-agents plan G1): one list, each row
`{profileId, backend, role, delivers, verdictCapable}`. Invariants enforced by
the parser, not convention: **at most one** engagement carries `delivers: true`
— the workspace/branch/PR owner — `parseEngagements` (:1000-1083) demotes every
extra claimant with a diagnostic and dedupes by `profileId`, keeping the first
occurrence (:1050-1081, since `startAgentRun` resolves by first match).
`deliveringEngagement(fm)`/`supportingEngagements(fm)` (:198-209) are the two
accessors every caller uses instead of re-filtering by hand. `verdictCapable` is
a **snapshot, not a live lookup**: whether the profile held an explicit
`report-validation-verdict: direct` grant *at engage time* (:187-191).
`requiredReviewers(fm)` (:659-661) — the reviewers acceptance waits on — is
exactly the supporting engagements with this flag true; there is no implicit
default (F10-14, `agent-outcome.server.ts:372-379`). Legacy files
(`specialist:`/`reviewers:`/the older `consultants:` alias) absorb into
`engagements` on read, never round-tripped as unknown keys (:993-998, :1339).

**Metadata** (pass 25, coherence-fixed pass 26 — see §2 and §8) is `priority`
(`PRIORITY_VALUES = low|normal|high|urgent`, :46), `labels: string[]`, and
`dueDate: YYYY-MM-DD | null`. `urgent: boolean` is a **derived mirror** of
`priority === "urgent"` (F26-16) kept in lock-step everywhere it is written —
never an independent input — so every older surface that reads bare `urgent`
(the board highlight, the "blocked or waiting" filter) stays correct without
being rewritten for the graded scale.

---

## 2. Creation & metadata

**`createTask`** (`app/server/tasks/task-actions.server.ts:433-539`): gated
`requireAction(..., "create-task", ...)` — admin/maintainer/contributor, not
viewer (`app/shared/rbac.ts:64`). Validation: title ≥ 3 chars (:443-445); an
unknown `priority` throws (:446-448); **R19-14** — every task is created at the
project's **entry stage only** (`project.stages[0]`); an explicit `stageId` that
disagrees throws (:449-460), and creating straight into a single-stage project's
done stage is refused (:462-466). `normalizeCreateDueDate` (:405-412) applies the
same `isValidDueDate` rule the edit path uses. The written frontmatter sets
`readiness: "input_required"`, `waiting: "human"`, `operator: null` (R19-14: a
triage-stage task has no operator yet), `urgent` derived from `priority`
(:475-506). After the file write: `rebuildPath` on `project.md` (the key counter
changed too), `reprojectTask`, an audit row, and a fire-and-forget
`autoInvokeOperator(..., "create")` (:513-532) — best-effort; a failure here
never fails the create, it leaves a timeline note instead (:885-919).

**`updateTaskGoal`** (:542-614): gated `update-goal` — admin/maintainer only
(`rbac.ts:74`; a contributor owner does **not** get this one — the goal is the
reviewable acceptance contract, distinct from metadata). Editing the goal
**re-anchors every downstream agent**: it clears an `awaiting: "goal_edit"`
packet if one is open (unblocking `readiness` if it was `blocked`, :566-582),
writes a `"note"` timeline event, and **re-invokes the operator**
(`autoInvokeOperator(..., "goal-updated")`, :611) so it reads the amended goal on
its next turn.

**`setTaskMetadata`** (:638-752) is deliberately the opposite shape. Gated
`edit-task-meta` — admin/maintainer/contributor (`rbac.ts:70`, wider than
`update-goal`: metadata is scheduling, not the acceptance contract). It is a
**partial patch** — a caller supplies only the axes it touches (:655-676), each
validated independently before any write (a bad due date fails the whole edit,
never a half-applied one). Two guards worth the file:line:

- **Archived-task freeze** (:686-690, `F26-13`): an archived task's metadata is
  frozen; this check was lost when the metadata editor moved into the Details
  panel and was restored fail-closed pass 26, independent of whatever a client
  renders.
- **No-op short-circuit** (:692-703): if every provided axis already equals its
  target value, the function returns without writing — mirrors
  `updateTaskGoal`'s equality guard.

The doc comment states the contract precisely (:625-637): metadata "changes NO
gate and NO agent's instructions" — the function writes the frontmatter,
reprojects, audits, **and stops**. Unlike `updateTaskGoal` there is **no
`autoInvokeOperator` call anywhere in this function** — a priority/label/due-date
edit alone never wakes the operator. See §8 finding 1 for the live consequence.

**Archived-task freeze**, generally: `requireProjectMutable` (R6-3,
`app/server/auth/project-authority.server.ts:136-147`) is the single
implementation every mutation funnels through — `requireAction` calls it first,
before the role check (:292), so an archived project 409s before RBAC is even
evaluated. `appendComment` (role-free) calls it explicitly (:972) since it never
calls `requireAction` at all.

---

## 3. Stage transitions

**The workflow graph** lives in `project.md`: `stages: StageDef[]` (ordered,
`{id, name, color}`, `project-file.schema.ts:40-48`) and `workflow:
WorkflowBoundary[]` (`{from, to, boundary, by, locked}`, :50-60), `boundary` one
of `auto | approval | human` (`BOUNDARY_VALUES`, :28-29). Four structural roles
are **derived from position**, never hard-coded literals
(`app/shared/workflow/stage-roles.ts:1-29`): `entry`=`stages[0]`,
`terminal`=`stages[len-1]`, `review`=the stage with an edge *into* terminal,
`work`=the stage with an edge into review — `resolveStageRoles` (:41-68) is the
one resolver every caller shares, which is what lets stages be freely
renamed/reordered per project without breaking acceptance/delivery logic. The
review→terminal edge is **forced `human`** whenever the chain is authored or
repaired (`createdRule`, `app/shared/workflow/transitions.ts:86-101`) — V1's
human-acceptance invariant is structural, not a preset convention.
`humanGatesPreWorkAdvance` (`stage-roles.ts:97-104`) reads whether a project
runs the "strict" preset straight off the graph (every pre-terminal boundary
non-`auto`) rather than a stored flag, so it works for projects created before
the preset existed (R15-9).

**`transitionStage`** (`task-actions.server.ts:3940-4296`) is the single mutator:
idempotent no-op if already at the target (:3980-3983); target must be a real
project stage (:3987-3991); **archived-move guard** (F19-8, :3993-4005) —
`archivedTaskMoveBlockedReason` refuses moving an archived task at all (409, a
state conflict) — closes a gap where a card could be dragged between columns
while every surface called the task abandoned. Boundary lookup (:4007-4009)
plus two narrowly-vetted off-graph escapes: `input.manual` (board/task
dropdown, any direction, admin/maintainer or an owner-applied recommendation)
and `input.rework` (operator-only backward move, only when
`ctx.operatorAuthorized` **and** `validation === "failing"`, :4010-4021 — R7-4
routing so a rejected task returns to the developer with no human in the
loop). **Moving into the terminal stage is routed to full acceptance**
(:4039-4055): a human's manual move onto `lastStageId` calls `acceptCompletion`
under the hood rather than a bare stage write, so a Done task can never carry
an unmerged PR and no completion record.

RBAC per boundary, evaluated after the terminal-stage special case:
`ctx.operatorAuthorized` + terminal target → **refused outright** (:4062-4065,
"the operator reaches Done only by accepting completion, not a bare
transition" — its stage authority is capability-gated upstream, §6, never
RBAC-checked here); `input.manual` → `approve-transition`, **unless**
`input.recommendationAuthorized` (set only by `applyRecommendation` after its
own owner-authority gate, R15-3, :4072-4076 — then only the archived-freeze
applies); `boundary === "auto"` crossed by a human (unreachable from the UI,
which always sends `manual: true`) → the loosest gate, `requireAnyMember`
(:4079-4080, see §8 finding 5); `boundary === "approval"` → `approve-transition`
with the same recommendation relaxation (:4081-4088); `boundary === "human"`
(review→done, locked) → `requireAcceptCompletion` — admin/maintainer **or**
the live task owner (R6-2, :4089-4099).

**In-lock idempotency re-check (U3/NFR16)** (:4113-4183): the fast read above
runs outside the lock (a guess, not a decision) — a double-submit could
otherwise write two timeline entries and two audit rows for one click. The
write re-derives the current stage under the lock and 409s if the task moved
somewhere *other* than the expected `fromStageId` mid-flight (:4138-4143).

Side effects on a real move: audit row (:4198-4208); clears "approval"
notifications (:4211); **operator re-invoke** — any move onto a non-Done stage
hands off to the operator (`autoInvokeOperator(..., "transition", chainDepth)`,
:4249-4266) through a **consecutive-transition depth cap**
(`OPERATOR_TRANSITION_CHAIN_CAP = 8`, :180) that opens a stuck-loop packet
instead of looping unboundedly (:4230-4247); entering the **review** stage with
**no live PR** fires a typed `github` announcement, never silence (:4277-4293
— delivery is an operator *decision*, not a stage side-effect, R15-2/ruling
21).

**Human-gated vs agent-recommendable**: the operator's `stage-transitions`
capability defaults to `recommend` (`capabilities.ts:55`) — under `recommend`
it can only *propose* a `transition` card (§6's `gate()`), never move the task
itself. A human (or the owning task's owner, R15-3) applies it through
`applyRecommendation`, which re-derives whether the move is a declared edge or
an off-graph manual move (:7985-7994) and threads
`recommendationAuthorized`/`ack` into `transitionStage`.

---

## 4. Ownership

**FR37** (`planning/planning-artifacts/prd.md:209`): a task's live owner is its
reviewer/acceptance authority, scoped to *that task only* — no rights over other
tasks or project config. **FR38** (`prd.md:210`, corrected pass 22 to match the
code): any **contributor or above** may take/release ownership self-service;
admins may additionally release anyone. `own-task` is floored at contributor in
`ACTION_ROLES` (`rbac.ts:65`) — a viewer, read+comment only, cannot self-assign
the seat that carries acceptance authority.

**`setOwner`** (`task-actions.server.ts:3673-3784`), gated `own-task`:

- **Taking an *open* seat**, or re-taking your own — stays at the `own-task`
  floor (contributor+).
- **Taking over an *occupied* seat** (claiming a task another member owns) is
  gated on the taker **already holding `accept-completion` authority**
  (:3703-3712) — admin/maintainer. This closed a real HIGH-severity escalation
  (pass 25): ownership carries the `requireAcceptCompletion`/
  `requireDecisionAuthority` owner exception, so a bare contributor seizing an
  occupied seat used to acquire accept-completion + resolve-packet authority on
  that task their role never independently grants. A maintainer/admin takeover
  escalates nothing (they already hold it) — the gate asks "does the actor
  already have this power," not "is the actor an admin."
- **Handing off to someone else** (`!isTake`): the caller must be the current
  owner **or** hold `release-any-ownership` (admin-only, `rbac.ts:80`), and the
  *target* must be able to hold the seat (`roleCan(targetRole, "own-task")`,
  :3713-3727) — a hand-off to a viewer or a non-member is refused.

**`releaseOwner`** (:3790-3855): releasing your **own** seat needs `own-task`;
releasing **someone else's** needs `release-any-ownership` (admin-only,
:3809-3816) — the timeline event copy names which case fired.

**`releaseTasksOwnedBy`** (:3880-3935, pass-23 A3): when a member is removed
from a project (or their org account is deleted), every **non-archived** task
they owned has its `ownerUserId` cleared (never re-assigned) with a `system`
actor event — best-effort per task, re-checked against the live file inside the
lock so a task re-owned between the projection read and the write is skipped.
Archived tasks are deliberately left alone (off every active surface, so a ghost
owner there blocks nothing).

**The owner exception** is not one function but a repeated pattern:
`ownerException` (:300-311) — live owner, contributor+ role — backs
`requireAcceptCompletion` (:314-323, R6-2) and `requireDecisionAuthority`
(:338-347, R14-2, widened from acceptance-only to *any* open decision on the
owned task — resolving packets, applying/dismissing recommendations). The
widening is deliberately narrow in a second dimension: it clears the **outer**
decision gate only — each recommendation's **inner** governed mutation still
enforces its own capability (an owner who applies "assign a specialist" is still
stopped by `run-agents` if they lack it, :330-336).

**R15-3** (owner ruling, `applyRecommendation:7918-7937`): the task owner's
Apply click authorizes **any** operator recommendation on their own task,
*including* a stage move their role could not authorize from the dropdown — "the
click IS the authorization" (FR37 spirit). When the owner lacks the *inner*
tier the recommendation's execution needs (e.g. `run-agents` to start a run),
the execution runs **as the operator** instead (`asCoordination`,
:7932-7937 — `runActor = OPERATOR_TASK_ACTOR`, `runCtx.operatorAuthorized =
true`) — "the packet is the human decision; the execution is coordination
machinery," the same seam `resolvePacket`'s `retry_other_backend` uses.

---

## 5. RBAC

**Org roles**: `member | admin` (`UserRole`,
`app/server/auth/require-user.server.ts:174-182`, `ROLE_ORDER` strict
hierarchy). `requireRole(request, "admin")` / `requireRoleAuth` (:201-222) gate
whole routes (org settings, user admin) — unrelated to project roles.

**Project roles**: `admin | maintainer | contributor | viewer`
(`PROJECT_ROLES`, `app/schemas/project-file.schema.ts:23-24`), a strict tier
(`ROLE_RANK`, `rbac.ts:31-36`: viewer ⊂ contributor ⊂ maintainer ⊂ admin — every
action is monotonic). Membership is per-project, stored in `project.md`'s
`members[]`.

**`ACTION_ROLES`** (`rbac.ts:61-93`) is *the* single source both enforcement and
the Policy page's permission table read (`RBAC_DEFINITIONS`; `ACTION_ROLES` is
built from it, :97-101):

| Action | Roles | Action | Roles |
|---|---|---|---|
| `view`, `comment` | all four (membership *is* the gate — see below) | `run-agents`, `reorder-board` | admin, maintainer |
| `create-task`, `own-task`, `edit-task-meta` | admin, maintainer, contributor | `reconcile-github`, `grant-github-scope`, `rescan-project` | admin, maintainer |
| `approve-transition`, `resolve-packet`, `accept-completion`, `update-goal` | admin, maintainer | `release-any-ownership`, `manage-members`, `manage-agents`, `edit-policy` | admin only |
| | | `force-accept-completion` | admin only |

`view`/`comment` are the two actions **no tier narrows** — every role holds
them, so their entire enforcement *is* the membership gate; they never call
`requireAction` at all (`rbac.ts:22-26`; confirmed live: `appendComment`,
`task-actions.server.ts:944-946`, calls only `requireProjectMutable`, never
`requireAction`).

**Enforcement chokepoint**: `resolveProjectAuthority`
(`project-authority.server.ts:173-258`) is the *one* implementation every guard
funnels through — `requireAction` (tasks), `assertProjectAction` (config
surfaces), `requireRunAgents`/`canRunAgents` (runtime triggers), and the route
membership gate all resolve through it. Two audited effects live here, not at
the call sites:

- **D2 org-admin emergency override**: a member whose own role is denied — or a
  non-member — is granted **project-admin-equivalent** authority if they hold
  the *org* `admin` role, and **every** such grant writes a
  `project.org_admin.override` audit row (:208-229) naming the action. F19-30
  closed a real gap: the `"any-member"` gate used to be exempted from this row
  ("just reads"), but `appendComment` reaches authorization *only* through
  `"any-member"` — an org-admin non-member could comment into a members-only
  project with zero override trail. Repeats collapse to one row per 60s window,
  keyed by the caller's `what` so a write intent can never hide behind a read's
  key (:208-214).
- **P13-D-8 denial audit**: every *refusal* writes a `project.authority.denied`
  row (:232-256) — NFR10's "unauthorized action attempts," previously the one
  audited category with no row anywhere. `silentDeny` (:82-86) is the sole
  exception: `canRunAgents`'s @mention path, where a lower-role commenter's
  mention is kept and only the run is skipped — a UI-designed behavior, not a
  probe.

**`requireProjectMutable`** (R6-3, :136-147) is the single archived-read-only
implementation; `requireAction` calls it *before* the role check (:292), so an
archived project's mutation attempts 409 regardless of the actor's role.

**`requireVisibleProject`** (R15-4, `app/routes/project-visibility.server.ts:28-45`)
is the action-side twin of the layout loader's read gate — React Router runs a
child route's `action` **without** its parent's `loader`, so a raw POST to a
task route reached the mutation for any authenticated user before this
existed. It resolves through the same `assertProjectAction(..., "any-member",
{allowArchived: true})` and re-throws the loader's byte-identical 404 instead
of the guard's own 403 — a non-member can never distinguish "no such project"
from "not your project." Verified live: both `project.board.tsx:53` and
`project.task.tsx:126,425` call it exactly once, at the top of their
loader/action, before any dispatch.

**Where enforcement is deliberately absent, not a gap**: `view`/`comment`;
`canRunAgents`'s silent @mention skip; `resolvePacket`'s `accept_completion` arm
and `manualDeliverForReview`'s owner branch, both of which defer entirely to
the owner-exception functions rather than calling `requireAction` first
(double-gating would block a contributor-owner before the owner check runs,
:5609-5612, :4912-4915).

---

## 6. Human vs agent boundary

Agent capability policy is a **separate system** from project RBAC — it governs
what a *running agent* may do, keyed per `AgentDeployment.capabilities:
CapabilityGrant[]` (`project-file.schema.ts:128-142`), never derived from any
human's role. Catalog: `UNIFIED_CAP_CATALOG`
(`app/shared/capabilities.ts:33-154`), one row per capability with `kinds`
(`operator`/`agent`), a UI `group`, a `defaultMode`, and `promotable`.

**`ALWAYS_HUMAN_CAPABILITY_IDS`** (:211-215): `merge-pull-request`,
`transition-to-done`, `change-project-policy`. These can **never** be persisted
in an actionable mode for an agent — `agent-profile-actions.server.ts:301`
coerces to `human` server-side on every save, whatever the submitted form said.
`capabilityEnforcement(id)` (:288-296) reports these as enforced on **both**
backends unconditionally — an agent never holds them in *any* actionable mode to
begin with.

**Enforcement honesty tiers** (`capabilityEnforcement`, :285-296):

| Scope | Meaning | Examples |
|---|---|---|
| `both` | binds on Claude *and* Codex | `execute-code-or-write-repo`-family is **not** here (see below); `use-web-search-fetch`, `use-browser`, `report-validation-verdict`, `ask-human`, the 3 always-human ids |
| `claude-only` | real tool-denial on Claude; **advisory** on Codex | `create-task-branch`, `commit-push-branch`, `open-review-pr`, `execute-code-or-write-repo`, `comment-on-task`, `read-github-api` (:270-283) |
| `advisory` | no runtime consumer at all | persona-guidance ids (`run-unit-integration-validation`, `approve-review`, …) |

The repo-write family moved to Claude-only in **R22** (2026-08-21,
`decisions.md:1018`): removing Codex's OS-level read-only sandbox ("viberr
itself is the sandbox") means a write-withheld Codex run is no longer
kernel-enforced — the **server-owned delivery gate**
(`resolveDeliveryPushGrant`, `task-actions.server.ts:4298-4310`) is the real
Codex boundary now, not the run's own tool access. Web egress stays enforced on
both backends (`webSearchMode: "disabled"` on Codex, :249-253).

**`specialist-tool-policy.ts`** turns a capability grant into an actual Claude
`disallowedTools` list: `CAP_DENY_RULES` (:49-97) maps each repo-mutating
capability to the Bash/tool specifiers it denies — `create-task-branch`→`git
checkout -b/-B`/`switch -c/-C`; `commit-push-branch`→`git push`/`git commit`;
`open-review-pr`→`gh pr create`; `merge-pull-request`→`gh pr merge`;
`execute-code-or-write-repo`→`Edit`/`MultiEdit`/`Write`/`NotebookEdit`/`git
commit` (real teeth, :68-78); `use-web-search-fetch`→`WebFetch`/`WebSearch`.
Deny rules bind even under `bypassPermissions` (:16-18) — genuine enforcement.
`resolveDeliveryPermissions` (:188-207) keeps the run's own prompt in sync
(XS-4) — instructing `git commit` while denying the tool produced confused,
failing runs before this existed (live, VIB-1). `grantModes` (:119-129)
repairs exactly one absence: a profile with **no** explicit
`execute-code-or-write-repo` entry but an actionable scoped delivery grant is
treated as holding it at `direct` — an *explicit* `off`/`human` is **never**
overturned (:110-118). `report-validation-verdict` is explicit-only with no
implicit default (F10-14) — the runtime mechanism behind `verdictCapable`'s
"snapshot, never live-derived" rule (§1).

**MCP grants sit outside the capability matrix** (R16-5/ruling 39,
`decisions.md:347-356`; PRD/NFR8 amendment, `prd.md:279`): granting a profile
an MCP server **is** the whole authorization for its tools, whatever they do —
a withheld `execute-code-or-write-repo` does **not** bound a granted server's
write tools. A stated honesty boundary, not an oversight (Viberr will not
pretend to bound a third-party tool it does not define), pinned by the
deliberate **absence** of any `mcp__*` deny rule
(`specialist-tool-policy.test.ts:290-292`) and disclosed in
`capability-matrix-modal.tsx:230`.

**Operator autonomy × capability mode** — `gate(authority, capabilityId)`
(`operator-actions.server.ts:446-466`): `off`/`human` → `deny`; `direct` →
`direct`; `recommend` → promoted to `direct` **only** when
`authority.autonomy === "full"`, **except** `completion-for-acceptance`, which
stays `recommend` regardless of autonomy (:456-462) — the human-only-Done
invariant's one deliberate agent exception requires an **explicit** `direct`
grant (owner ruling Q1), never a silent full-autonomy promotion. `R19-A` makes
the deployment's configured autonomy a hard **ceiling** a run override can
only narrow (`decisions.md:608`). Two capabilities need the opposite
polarity — absent reads as *granted*, since they postdate live deployments
(`deliver-review-pr`/R15-2, `update-task-branch`/N19-9) — each needing its own
bespoke resolver (`deliverGate`, :476; `updateBranchGate`,
`update-branch-operator.server.ts:76`) because generic `gate()` defaults an
absent entry to `"off"` (:453; §8 finding 4).

Even at full autonomy with an explicit `completion-for-acceptance: direct`
grant, the operator can only ever stamp `pr.state = "accepted"` (merge
**pending**), never `"merged"` (`operatorAcceptCompletion:2895-2921`,
`prState: "accepted"` hard-coded) — a real merge needs a human user identity
(`mergeTaskPr` takes `{userId, label}`). See §7's merge-pending-vs-real-merge
subsection for the human-side follow-up (`completeTaskMerge`).

---

## 7. Acceptance mechanics

**R15-1 — verdict-gated acceptance.** `deriveValidation`
(`task-file.schema.ts:677-728`) is the *one* writer of the `validation` cache,
recomputed on every relevant write, never hand-set. It binds verdicts to the
**current** `workRevision.id` only (`currentVerdicts`, :664-671) — a new
delivered head mints a new revision id, staling every prior verdict
automatically (F10-32: no comment/stage-bounce heuristic). Priority order
inside `deriveValidation`: `"none"` (no revision yet) → `"failing"` (any
required reviewer requested changes on the current revision) → `"healthy"`
(every required reviewer approved it) → `"none"` (a verified no-change
completion with zero required reviewers, R19-8) → `"bypassed"`
(`acceptance === "forced"`, N20-14 — placed *after* the real-verdict arms so a
genuine approval/rejection is never erased by the bypass fact) → `"changed"`
(fallback: a revision under review, verdicts still pending).

**`acceptanceRefusalReason`** (`task-actions.server.ts:6554-6594`) is the *one*
gate every writer to Done shares (P14-LV-02 — three writers had each grown
their own subset before this consolidation). Order matters and is asserted by
tests (`rebuilder.server.test.ts:900`): (1) `archivedTaskBlockedReason` — R14-3,
out of the flow entirely; (2) `closedPrBlockedReason` — **R16-3**, a terminal
GitHub fact (PR closed unmerged) outranks every process gate below it, because
no process fix helps; (3) `acceptanceStageBlockedReason` (:6518-6543) — the
task must be at the workflow's review boundary; (4) `acceptanceBlockedReason`
(`task-file.schema.ts:741-767`) — F10-15 verdict gate on the current revision;
(5) the live no-change **has-work** probe refusal (R20-2/F20-6) — auto-detected,
names the branch and commit count instead of the generic "deliver the branch"
advice, which used to be catastrophically wrong for an *empty* branch (it
advised opening an empty PR); (6) `verdictGateReason` — R19-B, a human's GitHub
PR approval can also satisfy the gate (`humanVerdictSentence`, :6979-6982,
rendered so the accepting human sees *whose* judgement they stand on); (7) the
open **blocked packet** check; (8) `conflictingPrBlockedReason` — P14-LV-07,
GitHub reports the PR unmergeable.

**Force-accept (DG-2)** — `forceAcceptCompletion` (:7664-7757), gated
`force-accept-completion` (admin-only, `rbac.ts:88`). Bypasses every gate above
**except** `forceIrreducibleRefusal` (:6637-6649) — a closed PR, R16-3's
terminal fact: "force-accept exists to bypass a wedged *process* gate, not a
settled GitHub state it cannot change." **R19-5** (`decisions.md:572-584`)
explicitly *reverted* a later attempt to also refuse an off-boundary force —
force **may** skip remaining stages and the review gate; the burden is
**honesty** (the confirm dialog enumerates what's skipped), not a server wall.
The audit row (`task.acceptance.forced`) names the exact bypassed reason,
computed from the *same* `acceptanceRefusalReason` so it can never drift
(:7723-7731). Force never bypasses the PR-head-containment check below — that
gate guards an irreversible merge, not a process state.

**A2 — PR-head must contain the delivered revision** (F15-15,
`acceptancePrHeadCheck`:6692-6707, `evaluateAcceptancePrHead`:6760-6827): a live
GitHub read comparing the PR's actual head sha against `workRevision.headSha`
(identical, or `ahead`/`identical` per `compare`). **The one gate every Done
writer runs, force included** — previously two of the four writers skipped it,
so a full-autonomy operator accept followed by a human "Complete merge" could
merge a stale-head PR. `verified`/`unverifiable`/`not-applicable` are tracked
distinctly (:6661-6677) so an unreachable-GitHub accept discloses the
containment check *did not run* rather than reading identical to a verified one
(:7311-7320).

**Acceptance disclosure ceremony** (R21-5/ruling 88, `decisions.md:947-971`):
every human acceptance — normal or forced — carries an
`ack: AcceptanceDisclosure | null | undefined` with three meanings
(`assertAcceptanceDisclosure`, :7129-7159): an **object** is the echo to verify
against the live task (`acceptanceDisclosureOf`, :7096-7104:
`{pr, revision, verdict}`); explicit **`null`** means a disclosure-bearing door
got a bare request — refused (`ACCEPT_DISCLOSURE_MISSING`, 400,
`error-codes.ts:19`); **omitted** means an in-process caller carries its own
disclosure contract. A stale echo is refused as hard as a missing one
(`ACCEPT_DISCLOSURE_STALE`, 409, :22). Checked twice: after the authority gate
and before any merge (`acceptCompletion:7379-7384`), and again **inside the
write lock** against what is actually being closed
(`applyAcceptanceWrite:7238-7243`) — force does not relax this; it bypasses
process gates, and this is a record of what the human saw, not a gate.

**`applyAcceptanceWrite`** (:7178-7329) is the single Done-write core every
path shares: direct `acceptCompletion`, the packet `accept_completion` arm,
`applyRecommendation`'s `accept_completion` case, and
`operatorAcceptCompletion`. Re-verifies the PR-head check, the no-change check,
and (unless `skipInLockRecheck` — the audited force path) the *entire* refusal
chain **inside** the lock (B-WF1) — including a U3/NFR16 idempotent-double-submit
guard (:7229) so two concurrent accepts of one task write exactly one
completion event and one audit row. Never downgrades an already-`merged` PR to
`accepted` (:7290-7293, F15-13).

**Merge-pending vs real merge**: `acceptCompletion`
(:7339-7656) attempts a **real** `mergeTaskPr` when a PR + reachable GitHub
exist; a refused merge (conflict, moved head) **blocks** acceptance rather than
closing the task (P14-LV-07); an *unreachable* merge still records `"accepted"`
(merge pending) with the true cause, never a false `"merged"` (NFR15).
**`completeTaskMerge`** (:7760-7864) is the human-only follow-up for a
merge-pending PR — same `requireAcceptCompletion` (admin/maintainer or owner)
authority, re-runs the A2 head-check, and is idempotent against a PR a human
already merged out-of-band on GitHub (F21-23: returns a no-op success rather
than a stale 409).

**"Completed — no changes"** (R17-2/ruling 43, hardened R19-8/ruling 62,
`app/server/tasks/no-change-completion.server.ts`): `noChangeApplies(fm)` =
`fm.noChanges === true && !fm.pr`. The flag alone is never trusted at accept
time — closing a task is irreversible, so a **live, fail-closed** re-probe of
the remote branch runs at the moment of acceptance (`acceptanceNoChangeCheck`),
re-verified once more inside the write lock. A reviewer approving a task with
**nothing to deliver** mints a synthetic `workRevision` of `kind: "verified"`
pinned to the default branch's head (`recordAgentCompletion:2509-2554`) so the
verdict has a real subject to bind to — this ended a verification-only task's
approval dead-ending on "no reviewed revision yet" (F19-21, live VC-5).
Acceptance disposes of the empty branch it verified against
(`emptyBranchDisposition`, :7045-7062): deletes it only if the task's **own**
recorded `branch` matches (never a same-name stranger, OBS-13) and the
project's delete-on-merge policy is on.

**There is no first-class "reject" action.** Rejection is expressed three ways:
a reviewer's `request_changes` verdict (drives `validation: "failing"`, §above);
a PR a human closed on GitHub without merging (`closedPrBlockedReason`, a
terminal fact — see gate 2 above, and R16-3's force-withdrawal); or the
`archive_task` packet-option kind (`PACKET_OPTION_KINDS`,
`task-file.schema.ts:146`, resolved under `approve-transition` authority,
optionally `deleteBranch: true` to discard the remote branch too).

The ceremony's one dialog (`app/features/task-detail/accept-confirm.tsx`) is
hoisted at both `task-detail-page.tsx` and `board-page.tsx` so no child
component can submit around it — every acceptance fetcher lives at the page
level.

---

## 8. Bug-hunt targets

1. **Metadata reaches the operator's tool result but never wakes it.**
   `setTaskMetadata` (`task-actions.server.ts:638-752`, docblock :625-637) never
   calls `autoInvokeOperator`; R26-1 exposed `priority`/`labels`/`dueDate` in
   `operatorSnapshot` (`operator-actions.server.ts:1544-1546`), but nothing
   mechanically prioritizes an urgent/overdue task in the operator's own
   scheduling — pass 27's own open question (`NOTES.md:38`). Live-check: mark a
   task urgent+overdue and diff the operator's next action against an identical
   normal task.
2. **Twin hand-maintained acceptance-gate implementations.**
   `acceptanceRefusalReason` (`task-actions.server.ts:6554-6594`) and
   `acceptanceBlockReason` (`rebuilder.server.ts:312-346`, feeding
   `validation_block_reason`) are separate bodies that must stay in the same
   order by hand (rebuilder docblock admits it, :282-310); spot-check tests
   (`rebuilder.server.test.ts:900`) pin some orderings but not full lockstep —
   the same class R20-7 already found for a different display/runtime pair.
3. **Capability-matrix display vs runtime repair asymmetry** for
   `execute-code-or-write-repo`: the runtime repair (`grantModes`,
   `specialist-tool-policy.ts:119-129`) infers the headline grant from an
   actionable scoped grant when absent; the display layer
   (`effectiveProfileView`, `agents-query.server.ts:277-402`) has its own,
   independent absent-grant logic that never calls `grantModes`. A profile
   written outside the save path's `grantsFor` (hand-edited `project.md`, a
   pre-persisted-grants deployment — the live scenario
   `specialist-tool-policy.ts:33-40` documents) can show "withheld" on the
   matrix while the runtime grants it anyway.
4. **`gate()`'s off-default polarity is a trap for the next
   "absent-means-granted" capability.** `operator-actions.server.ts:453`
   defaults an absent grant to `off` — the opposite of what
   `deliver-review-pr`/`update-task-branch` need; both work only because each
   has a bespoke resolver (`deliverGate`, `updateBranchGate`, §6) a caller must
   remember to use instead of plain `gate()`. Nothing enforces that a third such
   capability gets one.
5. **`transitionStage`'s loosest RBAC branch is untested by any UI flow.**
   The "auto boundary crossed by a human" path (:4079-4080, bare
   `requireAnyMember`) is safe only because the UI always sends `manual: true`;
   reachable purely via API/script. Check: can it be used as a side-door around
   an `approval` boundary gating the same stage pair from a different
   predecessor, since the lookup is purely `{from, to}`?
6. **The §4 ownership-takeover fix (`setOwner:3703-3712`) is the same shape as
   #3 — a seat/grant silently carrying more authority than the direct RBAC
   check implies — closed once (pass 25), not closed as a class.** Worth
   enumerating every non-RBAC mechanism (ownership, engagement, capability
   grant) that confers governed authority and testing each for "escalate by
   acquiring the mechanism, not the role."
