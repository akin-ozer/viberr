# Task lifecycle, RBAC, collaboration and governance surfaces (code-verified reference)

Pass 35 (k9s-clone observation). Branch `pass35/k9s-clone-observation` at `cb4fa22a`. Every claim below
is marked `verified in <file>:<line>` (line numbers are from this tree) or flagged as docs/code drift.
Docs read first: `docs/domain/task-lifecycle.md`, `docs/domain/auth-and-rbac.md`, `docs/domain/operator.md`
(all stamped "verified against main @ 68b5480, 2026-09-01"). Where they disagree with code, code wins and
the item is listed under "Drift candidates" at the end.

Conventions: "stage id" is the `stages[].id` string in `project.md` (`triage`, `impl`, ...); "stage label"
is `stages[].name` ("Triage", "In Progress"). Error sentences are quoted verbatim from the code.

---

## 1. Routes, guards and screen labels

| Route | File | Guard | `data-screen-label` |
|---|---|---|---|
| `/` | `app/routes/_index.tsx` | signed in | `Home · project selection` |
| `/projects/:slug` (layout) | `app/routes/project.tsx` | member or org admin; else 404 | |
| `/projects/:slug/board` | `project.board.tsx` | layout | `Board` |
| `/projects/:slug/review` | `project.review.tsx` | `requireProjectMember` (loader re-gates, own 404) | `Review queue` |
| `/projects/:slug/tasks/:key` | `project.task.tsx` | layout + `requireVisibleProject` on actions | `Task <KEY>`, `Task detail · not found` |
| `/projects/:slug/activity` | `project.activity.tsx` | `requireProjectMember` (loader re-gates) | `Activity` |
| `/projects/:slug/policy` | `project.policy.tsx` | layout; actions `manage-members` / `edit-policy` | `Policy` |
| `/projects/:slug/settings` | `project.settings.tsx` | layout; actions `edit-policy` / `manage-members` | `Settings` |
| `/projects/:slug/agents` | `project.agents.tsx` | layout | `Agents`, `Agent profile modal`, `Capability matrix modal` |
| `/projects/:slug/github` | `project.github.tsx` | layout | `GitHub` |
| `/projects/:slug/tasks/:key/attachments/:file` | `task-attachment.ts` | `requireUser` + `requireProjectMember` | (raw bytes) |
| `/notifications` | `notifications.tsx` | signed in | `Notifications` (popover: `Notifications popover`) |
| `/insights` | `insights.tsx` | org admin | `Insights` |
| `/org/settings` | `org.settings.tsx` | org admin | `Settings · Users & access` etc. |
| `/org/settings/audit-export` | `org.settings.audit-export.ts` | org admin | |
| `/profile` | `profile.tsx` | signed in | `Profile & preferences` |

Verified in `app/routes.ts:4-94` (route table), screen labels by grep over `app/**` (`data-screen-label=`).
Other labels present: `Accept completion dialog`, `Archive task dialog`, `Release ownership dialog`,
`Attachment lightbox`, `Command palette`, `Controller dock`, `New project modal`, `Empty state`,
`All projects`, `Archived projects`, `Pinned projects`, `Project card · <name>`, `Project row · <name>`.

**Non-member 404 shape.** The layout loader and `requireVisibleProject` throw the identical body
`No project at projects/<slug>.` with status 404 for a non-member AND for an unknown slug; the action-side
guard catches the 403 `AppError` and rethrows that 404 so a 403 never confirms the project exists.
Verified in `app/routes/project-visibility.server.ts:28-44`, `app/routes/project.tsx:77,92`,
`app/server/auth/require-project.server.ts:86-87` (`named ? "No project at projects/<slug>." : "Not found."`).
An org admin passes as the audited override (`project.org_admin.override`, deduped per minute per docs;
resolver `resolveProjectAuthority` in `app/server/auth/project-authority.server.ts`). A denial writes
`project.authority.denied`.

**Archived project = read-only.** `requireProjectMutable` throws 409:
`This project is archived (read-only) — restore it before you <what>.`
Verified in `app/server/auth/project-authority.server.ts:136-147`. Every `requireAction` call runs it
first (`task-actions.server.ts:322-338`).

---

## 2. Project creation blueprints

`createProject` in `app/features/home/project-create.server.ts` (intent `create-project` on `/`,
`_index.tsx:173`; any signed-in user, org role NOT consulted, `_index.tsx:177-178`).

| Input | Rule | Verified |
|---|---|---|
| `name` | >= 2 chars: `A project name of at least 2 characters is required.`; slug = `slugifyProjectName(name)`, must contain letters/digits; duplicate slug refused `A project at projects/<slug> already exists.` | `project-create.server.ts:305-331` |
| `key` (task prefix) | 2-4 letters: `Task key must be 2-4 letters.`; `GOAL` reserved (`isReservedTaskPrefix`, `RESERVED_TASK_PREFIX_REFUSAL`) | `:309-311` |
| owner + `repoName` | REQUIRED: `A GitHub repository is required. Pick a GitHub connection and a repository name. Add a PAT in Instance settings → GitHub connections first.` | `:318-321` |
| `policy` | `strict \| balanced \| auto` (type `PolicyPreset`) | `:38` |
| `stages?` | ordered `{name, color?}[]`, entry first, terminal last, "2..8 stages" per the interface comment; ids minted from names; replaces the Standard template | `:244-246` |
| `members?` | `{email, role}[]`, every email must already be a Viberr user | `:250-253` |
| description | defaults to the preset blurb | `:243` |

Effects of the preset (real governance, not copy):
- `strict`: every pre-work `auto` boundary (not into the last stage) becomes `approval` with
  `by: "Human approval (strict policy) before work advances"`; operator's `deliver-review-pr` set to
  `recommend`. Verified `:53-100`.
- `balanced`: template as is. `:58`.
- `auto`: operator gets `completion-for-acceptance: direct` and `definition.autonomy: "full"`. `:101-118`.
- Every preset: creator seated as project `admin` (`:95-96`), `guardrails: DEFAULT_GUARDRAILS` (`:105`),
  the boundary into the terminal stage stays `human` + `locked` (`presetWorkflow` never touches it).
- Description phrase stored: `Custom <N>-stage workflow · ` or `Standard 5-stage workflow · ` (`:69-71`).
- Repo probe: read-only repo (permissions.push === false) is refused at creation; a probe failure is
  surfaced as `repoWarning`, not silent (`:123-215`).

Audit: `project.created` (writer in `project-create.server.ts`, listed in the audit action set).

Docs claim (task-lifecycle §4) "three policy presets strict / balanced / autonomous": code id is `auto`.
Cosmetic; the UI label may say Autonomous.

---

## 3. Stages, ids vs labels, boundaries

Standard template (`GOVERNED_TEMPLATE`, id `governed-5`, label `Standard · 5 stages`):

| id | name | color |
|---|---|---|
| `triage` | Triage | #a5a8b5 |
| `ready` | Ready | #187574 |
| `impl` | In Progress | #7b61ff |
| `review` | Review | #5b76fe |
| `done` | Done | #00b473 |

Workflow chain: `triage→ready auto`, `ready→impl auto`, `impl→review approval`, `review→done human locked`.
Verified in `app/shared/workflow/templates.ts:34-77`. `by` strings shipped verbatim into every new
project.md (`"Operator, once the goal is scoped. Flags underspecified tasks instead."`,
`"Operator, when a delivering agent is assigned"`, `"Operator transition request, with evidence attached"`,
`"Human acceptance of the completion report"`).

Boundary enum: `BOUNDARY_VALUES = ["auto","approval","human"]` (`app/schemas/project-file.schema.ts:29`);
`strictestBoundary` ranks auto < approval < human (`transitions.ts:44-55`). Rule authored into the
terminal stage is forced `human` and `locked` (`transitions.ts:82-99`); removing a stage merges neighbours
with the STRICTER boundary (`rejoinChainAroundStage`, `:172-183`); adding one inherits the replaced edge
(`spliceStageIntoChain`, `:118-162`, default `approval` when nothing to inherit).

Structural roles (`resolveStageRoles`, `stage-roles.ts:41`): entry = first, terminal = last, review = stage
with an edge into terminal, work = stage with an edge into review. `humanGatesPreWorkAdvance` (`:97`) is
how the operator reads "strict" off the graph (no preset is stored).

Agent stage eligibility (`stage-eligibility.ts:136-145`): `spanAll` or empty declaration = unrestricted;
literal id on this board; else declared-id alias (`todo`,`backlog` → entry; `impl`,`doing`,`wip` → work;
`review`,`qa`,`verify` → review; `:36-50`); a declaration naming nothing on this board = unrestricted.
The refusal sentence uses the RAW stage id, not the label:
`<Agent> is not eligible for the "<stageId>" stage — its profile is scoped to <ids>. Change the task's stage or the profile's eligible stages.`
Verified `app/server/tasks/specialist-run.server.ts:3683-3694`. Candidate finding: a person on a custom
board sees ids like `impl` where every other surface shows "In Progress".

Policy page (`project.policy.tsx`): intents `set-role` (`manage-members`), `set-boundary` and
`set-guardrail` (`edit-policy`) (`:60-85`). `setTransitionBoundary` refuses `Unknown boundary.` and, for a
locked row or any non-human boundary into the last stage, 403
`Completion is human-authorized in V1, so this boundary can't be delegated`
(`app/features/policy/policy-actions.server.ts:185-226`); audit `project.policy.boundary_changed`.
Ruling 125: a role that cannot edit sees values as text, no disabled controls.

Settings page stage editor (`project.settings.tsx:101-150`): `save-project`, `rename-stage`, `add-stage`,
`remove-stage`, `reorder-stages`, `invite`, `remove-member`, `repair-repo`, `set-branch-cleanup`,
`grant-scope`, `set-credential`/`clear-credential`, `archive-project`, `delete-project` (confirmName).
`addStage`: `Stage name is required.`; server-minted id; inserted BEFORE the terminal stage
(`settings-actions.server.ts:505-530`); audit `project.stage.added {id,name}`. Other stage audits:
`project.stage.renamed|removed|reordered`, `project.settings.updated`, `project.repo.updated`,
`project.archived|unarchived|deleted`.

---

## 4. RBAC

### 4.1 Project roles (`app/shared/rbac.ts:61-88`, single source for guards AND the Policy table)

`ROLE_RANK viewer 0 < contributor 1 < maintainer 2 < admin 3`; labels `Admin/Maintainer/Contributor/Viewer`.

| Action id | Label | A | M | C | V |
|---|---|---|---|---|---|
| `view` | View board, tasks & timelines | x | x | x | x |
| `comment` | Comment on tasks | x | x | x | x |
| `create-task` | Create tasks | x | x | x | |
| `own-task` | Take / release own task ownership | x | x | x | |
| `edit-task-meta` | Edit task priority, labels & due date | x | x | x | |
| `approve-transition` | Approve stage transitions | x | x | | |
| `resolve-packet` | Resolve decision packets | x | x | | |
| `accept-completion` | Accept completion → Done | x | x | | |
| `update-goal` | Edit the task goal | x | x | | |
| `run-agents` | Run agents | x | x | | |
| `reorder-board` | Reorder the board | x | x | | |
| `reconcile-github` | Reconcile GitHub state | x | x | | |
| `grant-github-scope` | Grant GitHub scope | x | x | | |
| `rescan-project` | Re-scan project files & projections | x | x | | |
| `release-any-ownership` | Release any task owner | x | | | |
| `manage-members` | Manage members & roles | x | | | |
| `manage-agents` | Manage agent profiles | x | | | |
| `edit-policy` | Edit workflow & policy | x | | | |
| `force-accept-completion` | Force-accept past the review gate | x | | | |

`view`/`comment` never call `requireAction`; their whole enforcement is membership (`rbac.ts:18-26`).

### 4.2 Guards (`app/server/tasks/task-actions.server.ts`)

| Guard | Rule | Line |
|---|---|---|
| `requireAction(db, project, actor, action, what)` | archive freeze, then `rolesForAction` via `requireProjectAuthority` | 322-338 |
| `requireAnyMember` | any live member (idempotent paths); org admin passes as override | 309-320 |
| `ownerException` | actor is the live `ownerUserId` AND holds `own-task` | 340-352 |
| `requireAcceptCompletion` | freeze, then owner exception, else `accept-completion` | 354-367 |
| `requireDecisionAuthority` | freeze, then owner exception, else `resolve-packet` | 384-398 |
| `requireOwnable(target)` | target must be a member holding `own-task`: `Ownership can only be handed to a project member who can own tasks (contributor or above).` | 526-534 |
| `hasRuntimeRole` (mention runs) | `canRunAgents` = `run-agents` tier | 2010-2034 |

### 4.3 Org roles

`users.role` is `admin | member` (CHECK). Org admin reaches `/org/settings`, `/insights`, Home
`rescan` and `rebuild-projections` (`_index.tsx:106-160`), and passes any project gate as the audited
override. Any signed-in user may create a project and becomes its project admin (`project-create.server.ts:95`).
Docs auth-and-rbac §3 verified against `_index.tsx` and `rbac.ts` comments; the CHECK claim is the docs'
own note (§8) and not re-read here.

### 4.4 What each role can do, per surface (derived from the table + guards)

| Surface / act | viewer | contributor | maintainer | admin |
|---|---|---|---|---|
| Open board/task/activity/review/policy/agents/github pages | yes (member) | yes | yes | yes |
| Comment, @mention a human | yes | yes | yes | yes |
| @mention an agent/operator to START a run | comment recorded, run NOT started (`runtimeDenied`, `task-actions.server.ts:1630-1645`) | same | run starts | run starts |
| Create task (board `create-task`) | no (`canCreate = roleCan(myRole,"create-task")`, `project.board.tsx:156`) | yes | yes | yes |
| Take an OPEN owner seat / release own seat | no | yes | yes | yes |
| Take over an OCCUPIED seat | no | no: `This task already has an owner. Taking it over needs completion-acceptance authority (maintainer or admin); ask them to reassign it.` (`:4444-4455`) | yes | yes |
| Hand off to another member | no | only if current owner (`Only the current owner or a project admin can hand off ownership.`, `:4459-4461`) | only if current owner | yes |
| Release someone else's seat | no | no | no | yes (`release-any-ownership`, `:4586`) |
| Edit priority/labels/due/blockedBy (`set-task-metadata`, `set-task-dependencies`) | no | yes | yes | yes |
| Edit goal (`update-goal`) | no | no (`Editing the goal is reserved for maintainers and admins.`, `decision-packet.tsx:632`) | yes | yes |
| Manual stage move (`transition`, `manual:true`) | no | no | yes | yes |
| Move across an `auto` boundary without `manual` | any member, but the UI always sends `manual:true` (`:4863-4872`) | | | |
| Resolve packet / apply or dismiss recommendation | no | only as OWNER of that task | yes | yes |
| `request-maintainer-decision` | | owner who lacks `resolve-packet` (refused otherwise, `:7857-7900`) | | |
| Accept completion (button, drop into Done, packet `accept_completion`) | no | only as OWNER (`Accepting completion is reserved for maintainers and this task's owner.`, `decision-packet.tsx:624`) | yes | yes |
| Force-accept | no | no | no | yes |
| Run agent / run operator / schedule / release agent (`run-agents`) | no | no | yes | yes |
| Deliver for review (`deliver-review`) | no | owner (docs §10) | yes | yes |
| Reorder board, rescan project | no | no | yes | yes |
| Archive / restore task (`approve-transition`) | no | no | yes | yes |
| Invite/remove members, set roles | no | no | no | yes |
| Edit stages, boundaries, guardrails, repo, archive project | no | no | no | yes |

Member invite: `inviteMember` (`manage-members`), role defaults to `viewer`, unknown role refused
`Unknown project role.`, duplicate `<email> is already a member`, audit `project.member.invited {email, role}`
(`app/features/project-settings/settings-actions.server.ts:802-861`). Removal refuses self
(`You can't remove yourself from <project>`), protects the last live admin, calls `releaseTasksOwnedBy`
(`:887-939`). Removing an org account also releases (`app/server/org/org-users.server.ts:371`).

---

## 5. Task creation

`createTask` (`task-actions.server.ts:535-750`), gate `create-task`. Doors: board intent `create-task`
(`project.board.tsx:63-90`, form fields `title`, `goal`, `priority`, `labels` (comma list), `dueDate`);
controller `create_task`; goal-chain advancement (`goal-actions.server.ts:256,735`).

| Field | Rule | Line |
|---|---|---|
| `title` | trimmed, >= 3 chars: `A title of at least 3 characters is required.` | 545-548 |
| `goal` | optional; default `Goal to be refined at the triage quality gate.` (`DEFAULT_GOAL`) | 476, 690 |
| `stageId` | must equal the entry stage: `New tasks start at <EntryName>, the triage gate where a goal is refined. Move the task through the workflow after it is created.`; single-stage board: `New tasks cannot be created in the done stage.` | 556-575 |
| `priority` | `low \| normal \| high \| urgent`, default `normal`; `urgent` boolean mirror derived | 549-551, 655-664 |
| `labels` | `normalizeTaskLabels`: trim, collapse spaces, max 32 chars each, dedupe case-insensitive, max 12 (`MAX_TASK_LABELS=12`, `MAX_LABEL_LENGTH=32`) | schema `:67-86` |
| `dueDate` | `YYYY-MM-DD` or `Due date must be a calendar date (YYYY-MM-DD); got "<x>".`; checked BEFORE key allocation | 481-489, 579 |
| `ownerUserId` | named seat, checked by `requireOwnable` BEFORE allocation; refused for operator-created: `A named owner is seated by a person; an operator-created task starts unowned.`; unknown id `No Viberr user with that id.` | 585-600 |
| `blockedBy` | validated by `validateDependencyRefs` BEFORE allocation | 604-607 |

Birth state: `readiness: input_required`, `waiting: human` (or `none` when `blockedBy` non-empty),
`operator: null`, `validation: "none"`, `engagements/recommendations/schedules: []`, `archived: false`
(`:618-664`). Seat: `creator | named | none` (none only for `OPERATOR_TASK_ACTOR`/operator-authorized,
`:565-568`). Timeline `assign` event text for the creator:
`Took task ownership by creating the task. Agent runs on this task use the owner's own Claude and Codex accounts, and the owner is its human reviewer and acceptance authority.`
(`:679-681`); named: `Seated <Name> as owner at creation. ...` (`:670-673`). Held birth adds a `note`
"Waits on other work": `Created waiting on <list>. Held until every entry is done; Viberr releases it then.`
(`:684-696`). Audit `task.created {title, stage, ownerUserId, seat, notified?}` (`:713-734`); operator
auto-invoked with trigger `create` (`:741`). Key = `<PREFIX>-<n>` from `project.md nextTaskNumber`.

---

## 6. Readiness, waiting, validation (one derivation home each)

- Stored readiness enum: `ready | input_required | inconsistency_risk_detected | blocked`
  (`task-file.schema.ts:28-33`). Derivation `deriveReadiness` (`app/server/interpretation/readiness-policy.server.ts:39-66`):
  floors = worst diagnostic effect + `blocked` when `blockedBy` non-empty; a floor only ever WORSENS the
  stored value. "accepted" = task at the last stage (`isAcceptedDisplayState`, `:73-79`).
- Display readiness `deriveDisplayReadiness(readiness, waiting, packet)` (`app/shared/mapping/task.server.ts:514-535`):
  `agent_working` when `waiting === "agent"` and readiness is `ready|input_required`; `goal_edit_pending`
  when `packet.awaiting === "goal_edit"` and not waiting on agent; `input_required` when
  `ready + waiting human + packet.type input`; else the stored value. Board also uses `merged`.
- Waiting: `human | agent | none` (`:36`). Display flag only; `liveRuns` is the proof of a run.
- Validation: `healthy | changed | failing | none | bypassed` (`:45`). `deriveValidation` (`:914-960`):
  no `workRevision` → `none`; any required reviewer `request_changes` on the CURRENT revision → `failing`;
  all required reviewers approved → `healthy`; `acceptance === "forced"` → `bypassed`; `noChanges` with
  zero required reviewers → `none`; else `changed`. Required reviewers = engagements with
  `!delivers && verdictCapable` (`:900`). Recomputed on every engagement roster change
  (`specialist-run.server.ts:977,1097`).

Board card wait tag: `waiting on you` / `waiting on a human` / `agent working`; owner cell `unassigned`
at entry vs `awaiting owner` once `task.operator` is set (ruling 114; `board-page.tsx:226-236,511`).
Board filter ids: `human` ("Waiting on me", member-scoped), `agent`, `quiet`, `continuity`, `risk`
("Blocked or waiting": readiness blocked/input_required/risk, failing validation, urgent, rejected PR),
`archived` (`board-filters.ts:39-94`).

---

## 7. Ownership and hand-off

`setOwner` (`task-actions.server.ts:4391-4552`), gate `own-task` then:
- archived task: `<KEY> is archived — restore it before changing its owner.` (`:4413-4417`)
- terminal stage without `release-any-ownership`: `<KEY> is closed — move it back to an open stage before changing its owner (an admin can still reassign it for the record).` (`:4424-4434`, ruling 118)
- takeover / hand-off rules: section 4.4.
- Timeline `assign` texts: `Took task ownership. The owner is the human reviewer and acceptance authority for this task.`;
  `Took over task ownership from **<Name>**. ...`; `Handed task ownership to **<Name>**. They hold review & acceptance for this task now.` (`:4472-4479`)
- Notifications (ruling 140b): `notifyOwnerSeatChange` to the new owner (`handed_off`) and the displaced
  owner (`taken_over`); audit `task.ownership.taken | task.ownership.handed_off` with
  `previousOwnerUserId, newOwnerUserId, notified?, notifiedDisplaced?` (`:4497-4532`).
- The operator is NOT auto-invoked on a seat change (`:4535-4545`).

`releaseOwner` (`:4554-4658`): self needs `own-task`; other needs `release-any-ownership`; texts
`Released task ownership. Review & acceptance stall until another member takes the seat.` /
`Released **<Name>** from task ownership (admin). The seat is open to any contributor or above.`;
audit `task.ownership.released | task.ownership.admin_released {previousOwnerUserId, forced}`; admin
release notifies the released person (`admin_released`).
`releaseTasksOwnedBy` (`:4660-4718`): system actor `membership`, skips archived tasks, audit
`task.ownership.released_on_removal`, text `**<Name>** was removed from the project, releasing task ownership. ...`.

UI: `Assign me` shown only when `canOwn && !archived && (!closed || canReleaseAnyOwner)`; `Release ownership`
/ `Release <First> (admin)` (`task-side-panels.tsx:869-1035`); hand-off picker submits intent `owner-assign`
with `userId` (`task-detail-page.tsx:408-410`).

**Credential principal consequence (ruling 127).** Every run bills the OWNER's own backend account
(`resolveTaskRunPrincipal`); an unowned task or an owner without that backend gets an honest `error` run
with `principalRefusalMessage` and the constant `No agent process was started.`
(`app/server/runtimes/run-principal.server.ts:27,64`, `run-service.server.ts:1030,1105`). A hand-off changes
the principal from the next run; a resume after a hand-off takes the continuity-reset path
(`task-actions.server.ts:1766-1775`). Ownership notification kind `ownership`.

---

## 8. Engagements, assignment, mentions, reviewers, verdicts

### 8.1 Engagement record (`task-file.schema.ts:196-234`)
`{ profileId, backend: codex|claude, role, delivers (default false), verdictCapable (default false), pinnedBackend? }`.
At most one `delivers: true` (`deliveringEngagement`); the rest are `supportingEngagements`.
`verdictCapable` is snapshotted AT ENGAGE TIME from an explicit `report-validation-verdict: direct` grant
(`resolveAgentCollab`, `agent-outcome.server.ts:372-418`; a `recommend` grant counts as ABSENT). The
catalog default for `report-validation-verdict` is `off` (`app/shared/capabilities.ts:133`).

### 8.2 How a human assigns a second agent
There is ONE manual door: task page intent `run-agent` with `profileId`, optional `prompt` (<= 4000 chars:
`Keep the run prompt under 4000 characters.`), optional `backend` override (`project.task.tsx:861-913`),
gate `run-agents`. The picker is `AgentSelect` (aria-label `Choose an agent to run`, listbox
`Deployed agents`, empty `No deployed agent matches.`; `agent-select.tsx:209-239`) inside the Execution
profile panel; the button reads `Run` or `Schedule` when a delay is picked (`execution-profile.tsx:678`).
Posture is derived by `startAgentRun` (`specialist-run.server.ts:1240-1300`): unengaged + task has no
deliverer + profile holds `execute-code-or-write-repo` → `assignSpecialist` (delivering); otherwise
`assignReviewer` (supporting). Explicit delivery hint on a no-repo-write profile refuses:
`<Name> holds no repo-write grant, so it cannot own delivery. Run it as a supporting agent, or grant "Execute code or write to the repo" on the Agents page.`
Undeployed: `"<id>" is not deployed on this project. Deploy it on the Agents page first.` The panel
explains the posture before the click: `Runs as a supporting agent (already engaged).` /
`(no repo write).` / `(another agent owns delivery).` (`execution-profile.tsx:625-632`). A prompt is also
recorded as the human's own comment `@<AgentName> <prompt>` AFTER the start (`project.task.tsx:895-907`).
Toast: `Claude|Codex run started for <Name> · streaming to agent logs`.

`assignReviewer` (`specialist-run.server.ts:894-1000`): `assertStageEligible` (new-engagement rule),
idempotent if already engaged in ANY capacity, timeline `agent` event
`Engaged **<Name>** (<role>, <Backend>) as a reviewer.` or `... as a supporting agent.` (by `verdictCapable`),
clears a matching pending `run_agent` recommendation, recomputes `validation`, audit
`task.reviewer.assigned {profileId, backend, role}`. `assignSpecialist` (`:719-`) refuses swapping the
deliverer while its `primary` run is live; audit `task.specialist.assigned` or `task.delivery.handoff` (`:836`).

`release-agent` intent → `removeReviewer` (`:1029-1120`): gate `run-agents`; refuses on archived
(`<KEY> is archived — restore it before releasing an agent from it.`) and terminal
(`<KEY> is closed — move it back to an open stage before releasing an agent from it.`) with NO admin escape;
delivering engagement is never releasable (filter keeps `delivers`); event `Released reviewer **<Name>** from the task.`;
audit `task.reviewer.removed`. Panel withholds the ✕ on closed tasks (`execution-profile.tsx:815-825`).

### 8.3 @mention starting a run (`commentToAgent`, `task-actions.server.ts:1485-1985`)
Order: resolve target → `appendComment` (always recorded) → if no target: `@claude`/`@codex` ambiguous across
two profiles writes a system `note` and audit `task.comment.unrouted {ambiguousBackendHandle, candidates}`;
`@agent` with no deliverer writes the note
`**Note:** `@agent` addresses the task's delivering agent, and no agent delivers this task yet — the comment reached no agent. Run one from the Execution profile (a repo-write agent's first run makes it the deliverer), or mention a deployed agent by name.`
and audit `task.comment.unrouted {reservedHandle:"agent", reason:"no-delivering-agent"}` (`:1520-1594`).
Then `hasRuntimeRole` (contributor/viewer: `runtimeDenied: true`, no throw). `@operator` → `runOperator`
trigger `manual`; refusals `open-packet | terminal-stage | blocked-by` surface as `operatorRefused`
(`:1655-1699`). A named agent: same-profile live run refuses 409
`This agent already has a run in progress on this task — it will see the comment when it next re-anchors, or mention it again once the run finishes.`
(`:1745-1755`); with a prior session → `assertResumeEligible` (ruling 133: deliverer resumes at any stage;
supporting agent stage-scoped via `runEligibilityFor`, `specialist-run.server.ts:3731-3778`) then `resumeRun`;
without → `startAgentRun` (fresh, auto-engage). Any start failure returns `runNotStarted: <userMessage>` so
the route toasts "comment posted, run not started" instead of an error (`:1957-1975`).
**Stage-check gap (candidate):** an UNDEPLOYED profile with a surviving session skips the stage check entirely
(`assertResumeEligible` returns on resolve failure, `:3764-3769`), and `assertResumeEligible` is only applied
on the resume branch; the fresh branch relies on `startAgentRun`'s own check (`:1491-1512`).

### 8.4 Verdicts and work revisions
`workRevision {id, headSha, treeSha, branch, createdAt, sourceProfileId, kind: delivered|verified}`;
`verdicts[] {profileId, revisionId, headSha, result: approve|request_changes, reason, at}`
(`task-file.schema.ts:653-700`). Verdicts on an older `revisionId` are stale (`currentVerdicts`, `:904-912`).
A reviewer's structured `report_outcome` verdict or, as fallback, `classifyReviewerVerdict(text)` regex
ladder ("verdict: pass/approve/lgtm" vs "request changes", negation-aware; `task-actions.server.ts:2830-2895`).
Quality notification to watchers after a verdict (`kind: "quality"`, `:3340-3350`). A verified no-change
task mints a `kind: "verified"` revision at verdict time (`:3082`). Human GitHub approval counts when
`commit_id` equals the delivered head and the login maps to exactly one enabled user via
`users.github_handle`; two users with the handle → `ambiguous_handle`, fails closed
(`app/server/github/pr-human-approval.server.ts:23-110`). Work-revision drift sentence: `describeRevisionDrift`
(`app/shared/revision-drift.ts`; ruling 132: authored commits only, base refresh reported separately).

---

## 9. Transitions, acceptance, force-accept

`transitionStage` (`task-actions.server.ts:4720-5060`):
1. Same stage: idempotent but still gated (`approve-transition` unless recommendation-authorized) (`:4767-4781`).
2. Unknown target: `Unknown stage <id> for this project.` (`:4785-4789`).
3. Archived task → 409 (`archivedTaskMoveBlockedReason`, `:4797-4805`).
4. No boundary and not `manual`/rework: `No allowed transition from <From> to <To>.` (`:4820-4828`).
5. Human move into the LAST stage → `acceptCompletion` with the `ack` echo (`:4836-4852`).
6. Operator to last stage: 403 `The operator reaches Done only by accepting completion, not a bare transition.` (`:4854-4861`).
7. `manual` → `approve-transition`; `auto` → any member; `approval` → `approve-transition`; `human` →
   `requireAcceptCompletion` (`:4862-4898`). `recommendationAuthorized` (set only by `applyRecommendation`)
   skips the tier but not the archive freeze.
8. In-lock re-read: moved elsewhere → 409 `<KEY> moved to <Stage> while this change was being applied. It is no longer at <From>. Refresh the task and try again.` (`:4980-4987`).
9. Writes `previousStageId`, clears `heldAtStage`, terminal → `waiting: none`, leaving entry sets
   `operator: {assignedAtStageId}` and clears `input_required` (`:4990-5015`). Event text
   `**Transition:** moved <KEY> from <From> to <To>.` (operator: `... operator moved ...`). Audit action
   `task.transition` (`:5036`, also `:9170`), NOT `task.transitioned` (docs drift). Ruling 137: a move away
   from the review stage withdraws acceptance offers.

Task page intent `transition` sends `to` + `manual: true`, and adds the disclosure `ack` only when `to` is
the last stage (`project.task.tsx:804-825`). The board's drop/Move menu reuses `AcceptConfirm`
(`board-page.tsx:67-71`).

Acceptance affordance (`resolveAcceptanceAffordance`, `:8427-8497`): `hasAuthority` = `accept-completion`
role OR owner with `own-task`; denied outright on an archived project, a terminal task (nothing to accept),
and an archived task (`terminallyBlocked: true`, offer WITHDRAWN, ruling 123); `atBoundary` from
`acceptanceStageBlockedReason`; `canAccept = hasAuthority && atBoundary && blockedReason === null`;
`verdictSatisfiedBy` names a human GitHub approval.

`forceAcceptCompletion` (`:9288-9382`): gate `force-accept-completion` (admin, NO owner exception); already
Done → no-op without audit; `forceIrreducibleRefusal` (closed unmerged PR, archived task) → 409 BEFORE any
audit; disclosure echo asserted; `bypassed` computed before the write; audit `task.acceptance.forced {bypassed}`
only when the write happened. UI offer (`task-side-panels.tsx:136-200`, ruling 124): rendered only for a
non-terminal, not terminally-blocked task that has a branch, PR, delivered revision, OR an open `blocked`
packet; label `Force accept (skips the remaining stages and the review gate)` off-boundary, else
`Force accept (override review gate)`; class `btn ghost sm full danger` (ruling 149). The dialog enumerates
the skipped stages by name in a `Skips` row (`accept-confirm.tsx:224-233,418-420`).

---

## 10. Packets and recommendations (task side; see operator reference for authoring)

Packet: `{id?, type: input|blocked, kind, from, title, body, observations[], options[], awaiting?: goal_edit, decided?, askedBy?}`;
option kinds: `accept_completion, request_edit, block_on_policy, hold_runtime_debug, redirect, retry_other_backend, edit_goal, archive_task, discard_branch, resolve_remote_collision, custom`
(`task-file.schema.ts:131-168, 578-640`). `resolvePacket` (`task-actions.server.ts:6657-`): no packet →
409 `This packet was already resolved.`; unknown option `Unknown packet option.`; replaced packet → 409
`This decision was replaced by a newer one.` (docs); `accept_completion` → `requireAcceptCompletion`; others
→ owner exception or `resolve-packet`; `archive_task`/`discard_branch`/`resolve_remote_collision`
additionally need `approve-transition` (docs §6, code comment `:6740-6760`). Escalation intent
`request-maintainer-decision` (`requestPacketMaintainerDecision`, `:7857-7970`): notifies watchers with
`packet` kind title `Decision needs a maintainer: <title>`, audit `task.packet.escalated`, packet untouched.
Notification on `packet` (kind `packet`, `ptype input|blocked`) marks read for every user on resolution
(`markTaskPacketApprovalRead`).

Recommendations: kinds `transition | run_agent | accept_completion | delivery`, fields
`{id, kind, profileId?, prompt?, delivers?, toStageId?, label, detail, forHeadSha?}` (`:247-298`).
`applyRecommendation` / `dismissRecommendation` gate `requireDecisionAuthority`; missing id → 409
`That recommendation is no longer available. It may have been resolved, dismissed, or replaced by a newer one. Refresh to see the current recommendations.`
(`:9499-9560`). Audits `task.recommendation.applied | task.recommendation.dismissed | task.recommendation.withdrawn`;
declined title `Recommendation declined` (`:9692-9699`). The approval notification for a new card:
`kind: "approval"`; the delivery next-step card notifies with title `Next step recorded: <label>` from
`{kind:"system", name:"Delivery"}` (`:6205-6216`).

---

## 11. Schedules

Schema `schedules[] {id, action: run-operator|run-agent, dueAt, profileId|null, prompt, createdBy, createdByLabel, createdAt, status: pending|claimed|fired|failed|cancelled, firedAt, claimedAt, retries}`
(`task-file.schema.ts:307-364`). Creation: intent `schedule-action` (`project.task.tsx:1052`) and the run
controls' when-picker `in 5 min | in 1 hour | in 6 hours | in 24 hours` (values 5/60/360/1440 minutes,
`execution-profile.tsx:153-156`; button label switches `Run operator`/`Run` → `Schedule`).
`scheduleTaskAction` (`schedule.server.ts:131-215`, caller gate `run-agents`): `Invalid schedule time.`,
`Schedule a time in the future.`, `Pick which agent the scheduled run should start.`,
`"<id>" is not deployed on this project.`, `That task is already Done — nothing to schedule.`; timeline
`**Scheduled:** an operator re-run|a **<Agent>** run for **<KEY>** at <ISO> — <prompt>. It runs on the profile deployed when it fires.`;
audit `task.schedule.created {scheduleId, dueAt, action, profileId}`. Cancel: intent `cancel-schedule`,
audit `task.schedule.cancelled`. Runner tick `SCHEDULE_TICK_MS = 60_000` (`:48`); claim lease =
clone timeout + 5 min (`:322-323`); fires audit `task.schedule.fired {outcome}`.
Fire-time outcomes (`:451-800`): `skipped-done` (`**Scheduled action skipped:** <KEY> is already Done — the scheduled run is moot.`),
`skipped-archived` (task or project archived), `skipped-held` (`... waits on other work (<list>) — no operator run was started; Viberr releases the task when every entry is done.`),
`skipped-packet` (`... a decision packet is open on <KEY> ("<title>") and coordination is paused until it is resolved — no operator run was started, and the occurrence spends no retry.`),
`queued-behind-drive`, and terminal `failed` for an uncurable refusal (undeployed profile, stage-ineligible
new engagement, missing profileId). **While a packet is open**: a `run-operator` occurrence is retired
`fired` with `skipped-packet` (ruling 141); a `run-agent` occurrence STANDS and fires (ruling 131d only
refuses operator triggers; `:548-560`). Archiving a task cancels `pending|claimed` entries (`:6558-6570`).

---

## 12. Dependencies and chained goals (task side)

`blockedBy: string[]` on task.md, grammar `JC-6` or `goal-1 link 3` (`task-file.schema.ts:786-800`).
ONE writer `setTaskDependencies` (`app/server/tasks/dependencies.server.ts:257-345`, gate `edit-task-meta`,
task-page intent `set-task-dependencies`, controller `update_task`, operator `set_dependencies`).
Validator sentences (`:163-200`): `"<text>" is not a task key or a goal link. <hint>`;
`<ref>: a task cannot wait on itself.`; `<ref> is not a task in this project.`;
`<ref> is archived; a task cannot wait on abandoned work.`; `<goal> is not a goal in this project.`;
`<goal> has no link <n> (it has <k>).`; cycle refusal. Note title `Dependencies updated`, audit
`task.dependencies.updated`. Release engine: `releaseTask` = `clearDependencies` + `announceRelease`
(note `Dependencies released`, stored `blocked` lifted to `ready`, audit `task.dependencies.released`,
notification kind `dependency` titled `<KEY> can move again`, operator trigger `dependencies-released`;
`:349-475`); `maybeReleaseDependents` fires from transition, archive/restore, acceptance; `releaseDueDependents`
from the goal runner tick (`:508-527`). Dead wait: `noteDeadDependency` writes ONE note titled
`Waiting on work that cannot complete`, notifies `<KEY> waits on archived work`, sets `waiting: human`
(`:529-598`). Removing a goal link while something waits on it or a later index is refused naming the
holders (`goal-actions.server.ts:334-360, 529`).

Task page: hero chip per entry, `Blocked by` details row with editor (`task-side-panels.tsx:599-628`),
Current-state row `Other work: <labels>` with a title listing `<label> · <state>` (`:945-952`), run control
hold note (`execution-profile.tsx:980`). Goal chip: `<goalId> · link <n>` rendered when `task.goalRef` is set
(`task-main-sections.tsx:211-217`). Chain progress notifies the goal creator with kind `controller`
(`goal-actions.server.ts:619-635`); link start text `Link <n> (<title>) started as <KEY>, waiting on <list>.`
(`:748`); `Goal completed: every link is settled.` (`:923`). Audits `goal.created | goal.updated | goal.completed`.

---

## 13. Mentions and notifications

Mention grammar (`app/ui/mention-spans.ts`): `@` at start or after whitespace; known names longest-first
(multi-word display names allowed) with a boundary after; fallback single token `[A-Za-z][\w-]*`;
reserved handles `operator, agent, claude, codex` always known (`:35-40`). Server reserved set also
includes `controller` (`mention-notify.server.ts:63`). Human resolution ladder per handle: email local-part,
then full-name keys, then first name; >1 match = ambiguous (nobody notified); exactly one non-member =
`nonMembers` (nobody notified) (`:116-160`). Notes written beside the comment:
`_@x matches more than one person here, so nobody was notified — mention the full name ("@First Last") or the email handle._`
and `_@x is not a member of this project, so nobody was notified — add them to the project first, or mention a member._`
(`:169-189`). The picker (`getMentionables`, `mention-suggestions.server.ts:121-`) offers project members and
the project's deployed specialists (handle = profile id) plus `operator` ("Operator") and `agent`
("Delivering agent"); `@claude`/`@codex` offered only while exactly one profile on that backend is deployed.
Comment audit `task.comment {toAgent}`; `comment` timeline event; body lines that look like file structure
are escaped (docs §7).

Notification kinds (single source `app/shared/mapping/notification.server.ts:17-34`, CHECK in
`db/migrations/0001_baseline.sql:265`): `packet, approval, mention, quality, policy, controller, dependency, ownership`.
Pref categories (`app/features/profile/notification-prefs.ts:16-75`): `packets, approvals, mentions, policy, quality, controller, dependencies, ownership`;
all ON by default, opt-out, enforced inside `createNotification` (a silenced category writes no row).

| Kind | Fired by (verified sites) | Recipients |
|---|---|---|
| `packet` | operator/agent packet open (`operator-actions.server.ts:1207,1273`, `agent-toolkit.server.ts:224`), stuck-loop/failure escalation (`task-actions.server.ts:3008`), maintainer escalation (`:7923`) | watchers |
| `approval` | new recommendation (`operator-actions.server.ts:916`), agent question (`task-actions.server.ts:3316-3326`), delivery next step (`:6205-6216`), agent toolkit (`agent-toolkit.server.ts:276`) | watchers |
| `mention` | every comment writer via `notifyMentionedUsers` (`:1300-1315`) | the tagged members, excluding the author |
| `quality` | verdict recorded (`:3340-3350`), failed run notice `<role> run failed. <reason>` (`:3996-4010`), operator quality flag (`operator-actions.server.ts:2125`, audit `task.quality.flagged`) | watchers |
| `policy` | scope violation (`scope-flag.server.ts:143`), reconciler/poller PR facts (`github-reconciler.server.ts:886,917`, `reconcile-poller.server.ts:106,172`), delivery refusal (`task-actions.server.ts:6083`) | watchers |
| `controller` | controller reply (`controller-run.server.ts:429`), goal progress (`goal-actions.server.ts:631`) | the asker / goal creator |
| `dependency` | release and dead-wait (`dependencies.server.ts:404-406, 590-592`) | watchers |
| `ownership` | `notifyOwnerSeatChange` | the one person whose seat changed |

Watchers = project admins + maintainers + the task owner, minus `exceptUserId(s)`
(`notifyTaskWatchers`, `task-mutation.server.ts:260-320`); recipient resolution failure logs and notifies
NOBODY (deliberate fail-open, `:276-299`).

Notifications page (`notifications.tsx`, `notifications-page.tsx`): loader limit `NOTIF_PAGE_LIMIT = 200`
(+1 to detect truncation); sections `Waiting on you` (packet/approval rows whose decision is still live:
`liveWaitingOnYou` = open packet / pending recommendation and task not terminal,
`notification.server.ts:101-114`) and `Everything else`; filters `All | Unread`; actions
`POST /notifications/read` intents `read` (ids) and `read-all`; toast `All notifications marked read`.
`decisionCount` hint: `<n> decision(s) is/are waiting on you. Switch to "All" to see it/them.` Opening a
task page sets `read_at` on ALL of the viewer's unread rows for that task (`markTaskNotificationsSeen`,
`notifications.server.ts:431-452`, called from `project.task.tsx:192`).

---

## 14. Attachments and the browser capability

Store: `<task dir>/attachments/`; writers are the browser MCP `--output-dir` and the agent evidence tool
(`app/server/files/task-attachments.server.ts:9-16`); `listTaskAttachments` caps at 100 (panel comment
`attachments-panel.tsx:37`). Serving route `GET /projects/:slug/tasks/:key/attachments/:file`
(`task-attachment.ts`): member-only, traversal-refusing resolver → plain 404; > 50 MB → 413
`Attachment too large to serve.`; headers `x-content-type-options: nosniff`,
`content-security-policy: sandbox; default-src 'none'`; inline only for the whitelist
`.png .jpg .jpeg .webp .gif .pdf .txt .log .md .json .yaml/.yml .csv` (`task-attachments.server.ts:221-237`);
`?download=1` forces `attachment` disposition (ruling 105, `task-attachment.ts:54-66`). Viewer:
`Attachment lightbox` dialog; text kinds `TEXT_VIEW_RE = /\.(txt|log|md|json|ya?ml|csv)$/i` open read-only
with a Download button; large text shows `Showing the first part of a large file. Download it for the rest.`
(`attachment-lightbox.tsx:43,191,213`). Empty panel copy: `No attachments yet. A browser-capable agent on this task saves the ... the next time such an agent runs and produces evidence.` (`attachments-panel.tsx:64-66`).

Prune (ruling 105): `isBrowserWorkingArtifact` = machine-stamped `page-….yml` / `console-….log`;
`pruneBrowserWorkingArtifacts` deletes them at run completion unless the run cited the exact filename
(`citedIn`: reply text, evidence rows); screenshots/PDFs (`VISUAL_EVIDENCE_RE`) never pruned
(`task-attachments.server.ts:151-207`). Files a run posted ride on its timeline event as `attachments`.

Capability `use-browser` ("Drive a live web browser", group Collaboration, default `off`,
`app/shared/capabilities.ts:113`, `BROWSER_CAP_ID :518`); granting it implies `use-web-search-fetch`
(`rule: "browser-egress"`, sentence `"Search & fetch from the web" was granted to match "Drive a live web browser": the browser is web egress and cannot mount without it.`, `:544-568`).
Runtime prompt (`specialist-browser-mcp.server.ts:265-287`): call `browser_take_screenshot` WITHOUT a
`filename` (default-named shots land in `attachments/`; a named one resolves against the child cwd and is
NOT collected); cite the exact filename in evidence references; on Codex a screenshot does not return as an
image to the model (`:257-260`).

---

## 15. Archive and restore

`setTaskArchived` (`task-actions.server.ts:6500-6640`), gate `approve-transition`, task-page intents
`archive-task` / `restore-task`. Idempotent toasts `<KEY> is already archived.` / `<KEY> is not archived.`.
Archive: `waiting: none`, `recommendations: []`, `packet: null`, pending/claimed schedules → `cancelled`;
note `**Archived:** <KEY> was archived. It leaves the board and the review queue, and its record is kept.`
plus, when anything was withdrawn, ` <list> was/were withdrawn. Restoring the task brings it back to a human, who can run the operator to reopen the decision.`;
audit `task.archived {stage, withdrawn?}`; toast `<KEY> archived. Find it under Archived on the board.`;
then `noteDeadDependency` on dependents (section 12) and goal reconcile. Restore: `waiting: human`, note
`**Restored:** <KEY> was restored from the archive and is back on the board, waiting on a human. Run the operator to reopen coordination, or move the task on yourself.`,
audit `task.unarchived`, toast `<KEY> restored to <Stage>.`, dependents re-swept.
Effects elsewhere: archived task cannot be moved (409), owner seat frozen for everyone, reviewers cannot
be released, force-accept withdrawn and refused (ruling 123), leaves board default view and review queue.
Packet `archive_task` with `deleteBranch: true` also deletes the remote branch after re-confirming PR state
(docs §12; `github.branch.deleted`).

---

## 16. Audit

Table `audit_events(id, occurred_at, actor_user_id, actor_label, action, subject_kind, subject_id, project_slug, task_key, details_json)`
verified `db/migrations/0001_baseline.sql:37-48`. Writer `recordAudit` (`app/server/audit/audit-recorder.server.ts`).
Controller-driven human label = `<email> · via controller` (`encodeControllerInstrument`,
`app/shared/mapping/actor.server.ts:160-183`); Activity renders `<Name> (via the controller)`
(`auditActorDisplay`, `activity-feed.server.ts:595-602`); org Audit log keeps the raw label.

Task/collab audit action names present in code (grep of non-test `action: "..."`, 2026-09-06):
`task.created task.goal.updated task.metadata.updated task.dependencies.updated task.dependencies.released task.comment task.comment.dropped task.comment.unrouted task.transition task.ownership.taken task.ownership.handed_off task.ownership.released task.ownership.admin_released task.ownership.released_on_removal task.specialist.assigned task.delivery.handoff task.reviewer.assigned task.reviewer.removed task.agent.run_started task.agent.replied task.agent.commented task.agent.packet_opened task.agent.github_read task.operator.commented task.operator.packet_opened task.operator.packet_withdrawn task.operator.recommended task.operator.recommended_completion task.operator.agent_selected task.operator.context_conflict task.operator.accepted_completion task.packet.resolved task.packet.escalated task.packet.withdrawn task.packet.withdrawn_superseded task.recommendation.applied task.recommendation.dismissed task.recommendation.withdrawn task.quality.flagged task.schedule.created task.schedule.cancelled task.schedule.fired task.acceptance.forced task.archived task.unarchived task.branch.discarded task.branch.discard_refused`
Project/org/github families: `project.created project.archived project.unarchived project.deleted project.settings.updated project.repo.updated project.member.invited project.member.removed project.member.role_changed project.stage.added|renamed|removed|reordered project.policy.boundary_changed project.policy.guardrail_changed project.agent_profile.created|updated|deleted|deployed project.operator.autonomy_changed project.org_admin.override project.authority.denied goal.created goal.updated goal.completed github.* runtime.run.started runtime.run.interrupted runtime.operator.plan_executed run.recovery.* controller.authority.denied controller.ops.read profile.backend.* org.* auth.* projection.rescan projection.rebuild`.
Total distinct `action:` literals found: 174 (docs say "about 145").

Org settings Audit log: newest 150 by default, max 500 (`audit-browse.server.ts:29-30`); export
`GET /org/settings/audit-export?format=csv|json&project=&action=&actor=&since=&until=` (docs, not re-read).

---

## 17. Activity page (`/projects/:slug/activity`)

Loader (`project.activity.tsx:39-125`): stream (task events) + audit panel, limits via `?stream=` /
`?audit=` (`clampFeedLimit`), filters `q`, `kind`, `actor`, `task`, `from`, `to`; `auditActors` list for
a pick-not-guess actor filter. The audit panel shows ONLY the actions in `AUDIT_ACTION_KINDS`
(`activity-feed.server.ts:245-286`): every `project.*` policy/member/stage/settings/agent-profile/created/
archived/deleted row, `github.reconcile.project`, `github.credential.assigned|cleared|revalidated`,
`github.pr.merge_refused` (kind `blockedact`), `task.ownership.admin_released`, `task.operator.autonomy_clamped`,
`runtime.run.started|interrupted`, `task.acceptance.forced`, `project.org_admin.override` (kind `audit`),
`project.authority.denied` (kind `blockedact`). Everything else (comments, transitions, packets, schedules)
appears as timeline events in the stream, not in the audit panel. Kind vocabulary: `change | audit | blockedact`.
Scope violations render as `Project credential is missing <scope>. Flagged by the policy engine[ on ...]`.

---

## 18. Insights (`/insights`, org admin)

`getInsightsSummary` (`app/server/insights/insights-query.server.ts:444-620`), one aggregate over `agent_runs`
with optional project filter; window 30 days. Cards (`insights-page.tsx`):

| Card | Definition |
|---|---|
| Total runs / Total cost / Output tokens / Turns | `count(*)`, `sum(total_cost_usd)`, tokens, turns over runs |
| Completion rate (label; field `successRate`) | `finished / (finished + error + interrupted)` |
| Avg run time | `AVG(finished_at - started_at)` |
| By backend / By run kind / By project / By model | `GROUP BY` counts + cost, top 8 for model |
| Runs · last 30 days | daily chart, zero-filled |
| Delivery oversight: Owner & state clarity | active (non-archived, non-terminal) tasks with `waiting !== none OR owner_user_id != null` / active tasks (`:331`) |
| Branch & PR traceability | over tasks with a delivered `work_revision_sha` or recorded PR: those with branch AND PR; subtitle `<n> of <m> delivered tasks carry branch + PR` (ruling 143) |
| Blocked-decision wait | `task.operator.packet_opened | task.agent.packet_opened` → next `task.packet.resolved` per task; avg/median; `openNow` = live unresolved packets on active tasks |
| Time to review-ready | task `created_at` → first `task.transition` whose `details.to` is the project's review-role stage (`:385-412`) |
| Long timelines | tasks whose `event_count` passed their own project's `compression-threshold` value |
| Coordination overhead | operator + controller run cost / total cost (`:456-480`) |
| Backend quota | latest quota readings with `credentialLabel` (ruling 130d) |

Docs (auth-and-rbac §6) say "success rate"; the rendered label is `Completion rate` (R26-3).

---

## 19. Guardrails

Rows live in `project.md guardrails[] {id, desc, on, value?, unit?}` (`project-file.schema.ts:156-165`).
Defaults ON for every project (`templates.ts:97-102`): `meaningful-comment`, `no-duplicate-summary`,
`compression-threshold` (value 40, unit `events`), `evidence-separation`. Labels (`guardrail-labels.ts:9-16`):
`Meaningful comments`, `No duplicate summaries`, `Compression threshold`, `Evidence separation`,
`Delete the task branch after merge` (`delete-branch-after-merge`, owned by Settings → GitHub, inert on Policy).
Enforcement (`comment-guardrails.server.ts`): meaningless regex
`^(?:ok(?:ay)?|done|ack(?:nowledged)?|got it|on it|will do|working(?: on it)?|no update(?:s)?|still working|in progress|thanks?|noted|👍|\+1)[.!\s]*$`
(`:31`); evidence fences over `EVIDENCE_MAX_FENCE_LINES = 12` are trimmed with
`_(evidence trimmed by the evidence-separation guardrail — <n> more lines in the agent logs)_` (`:41-62`);
duplicate = byte-identical to the author's previous comment. Tool result sentences:
`NOT posted — the meaningful-comment guardrail dropped it as status chatter. Nothing was added to the timeline; say something substantive or stay silent.` /
`NOT posted — identical to your previous comment (no-duplicate-summary guardrail). Nothing was added to the timeline.` (`:135-141`);
audit `task.comment.dropped`. Compaction also runs on HUMAN comments (`appendComment`, `:1215-1250`).
Ruling 112 card (Policy → Guardrails, `setGuardrail`, gate `edit-policy`): toggle per enforced row, number
field for the `unit` row (`<Label> needs a whole number above zero.`), inert rows for `delete-branch-after-merge`
and unknown ids ("nothing reads this", removable), a missing enforced row renders OFF `not in project.md`
and turning it on writes the shipped row; a value on a missing row keeps it OFF; refusals
`Unknown guardrail action.`, `Which guardrail?`, `No guardrail named <id> on this project.`,
`<Label> has no numeric setting.`; audit `project.policy.guardrail_changed` (`policy-actions.server.ts:304-420`).

---

## 20. Review queue (`/projects/:slug/review`)

`getReviewQueue(db, slug, {viewerUserId})` (`app/server/projections/review-queue.server.ts:127-300`):
rows are non-archived tasks at the review-role stage; split `ready` ("Waiting on your acceptance", viewer
has acceptance authority AND `acceptanceBlockReason === null` AND not blocked-packet) vs `working`
("Still in review"). A closed-unmerged PR is named first in the block reason. Rows carry `revisionDrift`,
`unpushedRevision`, `goalEditPending` sublines. `resolveAcceptanceAuthority` adds
`operatorCanAccept` (operator deployed, `autonomy full`, `completion-for-acceptance direct`) so the page can
say the operator closes tasks itself (`review-acceptance-authority.server.ts:29-47`).

---

## 21. Home page (`/`)

`listHomeProjectsForUser` (`home-query.server.ts:106-135`): org admins see every project; members see
theirs (`project_members`). Card fields: per-stage counts (archived tasks excluded), `waiting` = decisions
THIS viewer can act on (`indexDecisionInbox` / `decisionsRequiring`: `mine` vs `overrideEligible`;
kinds `packet | recommendation | acceptance`; archived projects excluded; `decisions.server.ts:55-115`),
running-run count, `updated_at`. Sections: Pinned, active grid, Archived projects lifted out; prefs intents
`pin`, `view`; org-admin-only `rescan`, `rebuild-projections` (cooldown-guarded); `create-project`.
`New project modal` label. Total waiting summed over active projects (`home-page.tsx:227`).

---

## 22. Drift candidates (docs vs code, or copy vs behaviour)

1. `docs/domain/task-lifecycle.md` §5 names the transition audit row `task.transitioned`; code writes
   `task.transition` (`task-actions.server.ts:5036,9170`; Insights reads `task.transition`). Doc error.
2. Stage-eligibility refusal prints the raw stage ID (`"impl"`), not the stage label
   (`specialist-run.server.ts:3691`). Every other surface shows labels. Candidate UX finding on custom boards.
3. `docs/domain/auth-and-rbac.md` §5 says "about 145 distinct strings"; grep finds 174 `action:` literals.
4. `docs/domain/auth-and-rbac.md` §6 "success rate"; the card is labelled `Completion rate` (R26-3).
5. `docs/domain/task-lifecycle.md` §4 calls the third preset "autonomous"; code id is `auto`.
6. `assertResumeEligible` skips the stage check when the mentioned profile is UNDEPLOYED but still has a
   provider session (`specialist-run.server.ts:3764-3769`): an undeployed agent can be resumed by @mention at
   any stage. Docs say "a profile that is not engaged at all ... is judged by the new-engagement rule".
7. `run-agent` records the human's prompt as a comment `@<Name> <prompt>` AFTER the run starts
   (`project.task.tsx:895-907`); the run's directive therefore predates its own timeline record by one write.
8. Docs §14 say a task-page load "marks read" (verified) but the helper is named `...Seen`; no drift, note only.

---

## 23. Open questions (not verified in this pass)

- The exact `resolvePacket` sentences for `archive_task` / `discard_branch` authority (`approve-transition`)
  were read from comments and docs, not the throw sites (`task-actions.server.ts:6740-6800`).
- Audit export route parameters and the 100 000-row cap (docs only).
- Whether the Policy page renders the "3:1" member-role table for viewers as text (ruling 125) was not
  re-read in `policy-page.tsx`.
- The `Files · <title>` and `Store strip` screen labels belong to the org store, out of scope.
- Controller-side `create_task` `owner` parameter and `update_task` fields belong to the controller reference.

---

## Gap fill: Guardrail provocation and what compression-threshold actually does

Verified 2026-09-06 against `app/server/tasks/comment-guardrails.server.ts` (whole file, 190 lines),
`task-actions.server.ts` (appendComment 1178-1290, prepareAgentReplyEvent 2130-2196,
postAgentReplyComment 2242-2420, completion 3560-3625, react 4108-4195), `operator-actions.server.ts`
(writeOperatorComment 641-783, operatorPostComment 2033-2059), `timeline-compaction.server.ts` (whole),
`agent-toolkit.server.ts` (postAgentComment 116-175, post_comment tool 294-316),
`controller-toolkit.server.ts` (comment_on_task 1169-1206), `insights-query.server.ts` (191, 255-262,
319-322, 436-439), `policy-actions.server.ts` (setGuardrail 304-425), `policy-page.tsx` (Guardrails 690-880).
Corrections to §19 above are listed in G.1 at the end; the code wins.

### G.1 Who reads each guardrail id at runtime (consumer matrix)

`guardrailOn(ctx, slug, id)` = row present with `on === true` in `project.md guardrails[]`
(`comment-guardrails.server.ts:158-172`); `guardrailValue` = that row's `value` when `> 0`, else `null`
(`:175-190`). Every read is a fresh `readProjectFile` at write time (no cache; a Policy toggle applies to
the next write).

| id | Read by (verified) | NOT read by (verified: no `guardrailOn`/id string in the path) |
|---|---|---|
| `meaningful-comment` | `writeOperatorComment` (`operator-actions.server.ts:663-671`, operator `post_comment` + recommendation prose); `prepareAgentReplyEvent` (`task-actions.server.ts:2143-2150`, a run's FINAL reply) | `appendComment` (human comments, `:1178-1290`); `postAgentComment` (agent mid-run `post_comment` tool AND controller `comment_on_task`, `agent-toolkit.server.ts:116-175`, comment at `:116` says "guardrail-light"); `narrateRefusedActions`; every typed-event writer |
| `evidence-separation` | `operator-actions.server.ts:666`; `task-actions.server.ts:2152-2154` | same three as above |
| `no-duplicate-summary` | ONLY `writeOperatorComment` (`operator-actions.server.ts:689-699`): inside the write lock, finds the NEWEST `type: comment` event with `actor.kind === "operator"` anywhere in the timeline (any age, includes a `Compacted` marker) and drops when `text.trim()` equal | the agent-reply path: its dedup (`duplicatedOwnCommentText`, `task-actions.server.ts:2103-2130`) is NOT gated on this id, is always on, and compares only against comments by the SAME actor with `occurredAt >= run.started_at` (this run's own mid-run `post_comment`), cc line stripped (`stripCcLine`, `:2068-2084`); human comments; mid-run/controller comments. Grep of `app/server` for `noDuplicate|no-duplicate-summary`: the `applyCommentGuardrails.noDuplicate` option exists (`comment-guardrails.server.ts:106,121`) but no caller passes it |
| `compression-threshold` | `appendComment` (`task-actions.server.ts:1219-1222,1253-1266`, HUMAN comment write incl. `@operator` steer and the `run-agent` prompt echo); `postAgentReplyComment` (`:2319-2338`, agent FINAL reply or its attachments note); `writeOperatorComment` (`operator-actions.server.ts:690-691,709-719`); Insights `compressionThreshold` (`insights-query.server.ts:255-262`) for the `Long timelines` card only | `postAgentComment` (mid-run agent comments and controller `comment_on_task` never trigger a compaction pass); transitions, packets, notes, policy events, schedules; prompt budgeting (grep `compression-threshold|compressionThreshold|guardrailValue(` over `app/server` returns only the sites in this row: no prompt/context reader) |

Bottom line: the four rows are fully enforced on exactly ONE writer (the operator's `post_comment`),
partly enforced on a run's final reply (meaningful + evidence; dedup by a different rule), and not at all
on human, mid-run agent, or controller comments (compaction excepted for human comments).

### G.2 What compaction actually does (`compactTimelineEvents`, `timeline-compaction.server.ts:54-113`)

| Fact | Verified |
|---|---|
| Trigger | only inside the three comment writes above, in the SAME `updateTaskFile` call that unshifts the new comment; `compactOn` must be true; options = `{threshold: value, keepRecent: min(24, max(4, floor(value/2)))}` when `guardrailValue` is a number, else `DEFAULT_COMPACTION = {threshold: 40, keepRecent: 24}` (`:43-46`; used when the row is ON but has no usable `value`) |
| Fires when | `events.length > threshold` (strict `>`, `:58`); value 40 → 41+ events, keepRecent 20; value 10 → 11+, keepRecent 5; value 5 → 6+, keepRecent 4 |
| What folds | in the region older than the `keepRecent` newest events, each run of CONSECUTIVE "routine comments": `type === "comment" && title !== "Compacted" && !toAgent && actor.kind !== "human"` (`:94-101`). Inside a run the NEWEST `actor.kind === "agent"` event is kept verbatim (`:78`); a run whose foldable remainder is `<= 1` event is left as is (`:80-82`) |
| Never folds | human comments (B-FD9); any `toAgent: true` comment (the `@<Agent> <prompt>` echo of `run-agent`, the `@operator <steer>` echo, any human `@agent` mention); every non-comment type (transition, packet, blocked, quality, completion, github, assign, agent, note, policy, continuity); an existing marker |
| Marker written | `{type: "comment", actor: {kind: "operator"}, title: "Compacted", text: "_<N> earlier routine comments compacted to keep the task readable — human comments are never compacted._", toAgent: false, evidence: null, occurredAt: <newest folded comment's time>}` (`:65-73`); `COMPACTION_TITLE = "Compacted"` (`:30`) |
| File change | `task.md` `## Timeline` rewritten in place (the folded events are DELETED from the canonical file, only the count survives); no separate timeline event, no audit row, no notification, no log line. Returns the same array (no write) when nothing shrank (`:112`) |
| Projection | `tasks.event_count = parsed.timeline.length` after compaction (`rebuilder.server.ts:623`), so a successful pass LOWERS the count |
| UI | the marker is a comment: task timeline renders it as a `comment-card` under actor `Operator` (`actor.server.ts:114`); the `title` is NOT shown for comments (`timeline.tsx:246-264` shows `ev.title` only on non-comment types), so the reader sees just the italic sentence. Activity stream folds it as `**Compacted.** _<N> earlier ..._` (`activity-feed.server.ts:24-26`) |
| Insights `Long timelines` | `tasks.filter(t => threshold != null && t.event_count >= threshold)` (`insights-query.server.ts:436-439`) over ALL projected tasks (archived NOT excluded here, unlike the clarity/packet cards at `:326,382`); `threshold` = row on with `value > 0` → value; on without value → 40; off/absent → `null` (task never counted). Sub-label `tasks past their project's compression threshold` (`insights-page.tsx:203-206`). Because compaction lowers `event_count`, the card mostly counts tasks compaction CANNOT shrink (human/typed/toAgent heavy) plus tasks with no comment write since the threshold was lowered |

### G.3 Provoking each guardrail: recipes

Preconditions common to all agent recipes: a deployed Claude profile eligible at the task's stage; for the
mid-run tool the profile must grant `comment-on-task` (`capabilities.ts:90`; `collab.comment` =
`effectiveCollabMode(grants,"comment-on-task") === "direct"`, `agent-outcome.server.ts:411`; Codex never
mounts the tool). The task page `run-agent` intent takes `profileId` + `prompt` (≤ 4000 chars, else
`Keep the run prompt under 4000 characters.`, `project.task.tsx:861-907`); the controller equivalent is
`run_agent_on_task {projectSlug?, taskKey?, agent: "<profileId>"|"operator", prompt?}`
(`controller-toolkit.server.ts:1394-1399`).

#### R1 `meaningful-comment` on a run's FINAL reply (prompt: `Reply with exactly the word ok and nothing else.`)

| Dispatch door | `triggeredByName` stamped? | Outcome |
|---|---|---|
| task page `run-agent` | yes (`project.task.tsx:880-884`) | NOT dropped. At completion the cc line is appended BEFORE guardrails: `replyText = "ok\n\ncc @<Name> @operator"` (`task-actions.server.ts:3612-3624`, only tags missing from the text are added); `CHATTER_RE` is end-anchored (`[.!\s]*$`) so the reply posts verbatim as `ok` + cc line |
| human `@<agent>` mention comment | yes (`task-actions.server.ts:1880,1946`) | same, not dropped |
| controller `run_agent_on_task` with a profile id | yes (`controller-toolkit.server.ts:1453-1459`) | same, not dropped |
| schedule `run-agent` | yes when `createdByLabel` (`schedule.server.ts:626`) | same |
| `applyRecommendation` run_agent | yes (`task-actions.server.ts:9587`) | same |
| OPERATOR dispatch (`dispatch_agent` tool, react-loop dispatch) | no (comment at `task-actions.server.ts:4128-4131`) | the ONLY door where a bare `ok` reaches the check and is dropped |

Prompt variants do not help: asking for `ok @<Name> @operator` skips the cc append but still fails
`CHATTER_RE` (extra tokens after `ok`). The `> 60 chars` short-circuit (`isMeaninglessComment`, `:36`) is
irrelevant here. So from every human-driven door the final-reply guardrail is UNREACHABLE (candidate
finding, G.5 #2).

When it DOES fire (operator-dispatched run replying `ok`):
- timeline: no event (unless the run saved attachments: a `note` by the agent `Saved 1 file to this task's attachments during the run.` / `Saved <n> files ...`, `task-actions.server.ts:2300-2312`);
- log: `agent reply dropped by the meaningful-comment guardrail` (`:2281-2285`);
- audit: `task.agent.replied` actor `OPERATOR_AUDIT_ACTOR`, `details {runId, droppedByGuardrail: "meaningful-comment"}` (`:2213-2228`);
- no tool result (a final reply is not a tool call) and no notification;
- the operator's react input still receives the RAW reply (`reactInput.agentReply = replyText`, `:4193`), so the operator reads `ok` although the timeline never shows it (not live-verified; open question).

#### R2 `meaningful-comment` on the agent's MID-RUN `post_comment` (prompt: `Call the post_comment tool with the text "ok" and nothing else, then finish.`)

- Posts. `postAgentComment` runs no guardrail (`agent-toolkit.server.ts:116-175`); tool result
  `[done] Comment posted to the task timeline.` (`:307`); timeline gets an agent comment `ok`; audit
  `task.agent.commented {actorRef}` under the agent's own label (`:158-166`). The `templates.ts:93` row
  description `Status chatter is rejected before it reaches the timeline.` is false for this door
  (candidate finding, G.5 #3).
- Controller `comment_on_task` appends `\n\n_Posted by the controller for <Name>._`
  (`controller-toolkit.server.ts:1195`) then calls the same `postAgentComment` with `actorRef {kind:
  "controller"}` and `auditActor` = the asking human (`:1196-1202`): never chatter-shaped, never checked,
  result `[done] Comment posted on <KEY>.`.

#### R3 `meaningful-comment` on the OPERATOR (the only door where the drop sentence is shown to a model)

Steer the operator from the task page (`@operator` steer input; recorded as `@operator <steer>`
`toAgent`, `project.task.tsx:1005-1027`) or controller `run_agent_on_task {agent: "operator", prompt}`
with: `Call post_comment with exactly the text "ok" and nothing else, then end your turn.`
- Claude operator: tool result `[noop] NOT posted — the meaningful-comment guardrail dropped it as status chatter. Nothing was added to the timeline; say something substantive or stay silent.` (`operator-toolkit.server.ts:127-129` wraps `[<outcome>] <message>`; message `comment-guardrails.server.ts:136-138`; outcome `noop`, `operator-actions.server.ts:2055-2057`).
- Codex operator (plan executor): the step lands in `refused` kind `state` (`operator-run.server.ts:2416-2428,2454-2459`) and a `note` by the operator is written directly (not through the gate): `**The operator's plan was not carried out in full.** This step did not apply to the task's current state:` + `- \`post_comment\` — NOT posted — the meaningful-comment guardrail ...` + `What it intended:` + the quoted reasoning (`:2670-2712`). Caveat: a Codex plan with NO actions posts its `reasoning` through `operatorPostComment` (`:2410-2412`), so `ok` as reasoning is also dropped.
- audit: `task.comment.dropped` actor `OPERATOR_AUDIT_ACTOR`, `details {reason: "meaningless", variant: "comment"|"recommend"}` (`operator-actions.server.ts:765-783`); log `operator comment dropped by the meaningful-comment guardrail`; no timeline event, no notification.
- Whether a steered operator obeys the literal instruction is model behaviour (its prompt tells it to narrate); expect to retry.

#### R4 `no-duplicate-summary` (operator only; prompt: `Call post_comment twice, both times with exactly the text "Coordination check: nothing has changed since the last update." Then end your turn.`)

- First call: `[done] Comment posted to the timeline.`; second: `[noop] NOT posted — identical to your previous comment (no-duplicate-summary guardrail). Nothing was added to the timeline.` (`comment-guardrails.server.ts:139-141`); audit `task.comment.dropped {reason: "duplicate", variant}`; `suppressed` detected INSIDE the write lock, the comparison target is the newest operator-authored comment in the whole timeline (`operator-actions.server.ts:692-699`), so an operator repeating a narration from a previous turn/day is dropped too, and a `Compacted` marker counts as "the previous operator comment" (a second compaction marker text would be deduped; harmless).
- The text must survive R3 first (not chatter, `> 60` chars or non-matching).
- Toggle OFF proof: Policy → Guardrails → checkbox `No duplicate summaries guardrail` → toast `No duplicate summaries: off · applies from the next agent comment`; second identical operator comment then posts.

#### R4b Agent final-reply dedup (NOT a guardrail; always on)

Prompt on a Claude profile with `comment-on-task`: `Call post_comment with the text "Build verified: all 12 tests pass on the k9s-clone branch." Then end your turn with exactly that same sentence as your final message and nothing else.`
- mid-run comment posts (`task.agent.commented`); final reply: `stripCcLine` removes the appended `cc @...` line, text matches the run's own comment → reply not posted; log `agent reply deduped — duplicate of the agent's own mid-run comment`; audit `task.agent.replied {runId, deduped: "duplicate-of-own-comment"}` (`task-actions.server.ts:2224-2227`); the cc-line handles the mid-run comment lacked are still notified (`:2966-2985`). Toggling `no-duplicate-summary` changes nothing here.

#### R5 `evidence-separation` (prompt: `Reply with a fenced code block (three backticks, language "text") containing exactly 20 lines numbered 1 to 20, followed by one sentence: "Log above."`)

- Requires both fences at line start (`/^```([^\n]*)\n([\s\S]*?)^```/gm`, `comment-guardrails.server.ts:56`) and `> 12` body lines (`EVIDENCE_MAX_FENCE_LINES = 12`, `:41`).
- Stored comment: first 3 lines + closing fence + `_(evidence trimmed by the evidence-separation guardrail — 17 more lines in the agent logs)_` (`:60-62`). Applies to the agent FINAL reply (`task-actions.server.ts:2152-2154`) and operator `post_comment`; NOT to human, mid-run `post_comment`, or controller comments (a 20-line fence via the mid-run tool lands whole).
- Operator tool result: `[done] Comment posted to the timeline, TRIMMED by evidence-separation — the full text is only in the agent logs.` (`:142-144`). Agent final reply: no sentence anywhere (not a tool), no audit, no log line; the full text is in the run's log lines (`assistant` text) only. `@mentions` inside the trimmed region still notify (`mentionSourceText` = pre-trim, `task-actions.server.ts:2193,2360-2370`).
- Note a >1200-char reply is stored FULL (`extractFullReplyText`, `agent-reply.server.ts:467-476`; `MAX_REPLY_CHARS = 1200` only truncates previews, `:444,514-525`).

#### R6 `compression-threshold` (make the timeline actually compact)

1. Policy → Guardrails (`data-screen-label="Policy"`, gate `edit-policy`): row `Compression threshold`, number input `aria-label="Compression threshold value (events)"` (id `guard-compression-threshold`, `min=1 step=1`), button `Apply` (enabled only when the draft differs). Set `5` → toast `Compression threshold: 5 events · applies to the next compaction pass` (`policy-actions.server.ts:404-410`); audit `project.policy.guardrail_changed {id, label, op: "value", value: 5, beforeOn, ...}`; `project.md` now carries `- id: compression-threshold` ... `on: true` / `value: 5` / `unit: events` (`<dataRoot>/projects/<slug>/project.md`, `docs/operations/configuration.md:215`), reprojected to `projects.guardrails_json`.
   - Invalid draft (`0`, `-1`, `2.5`, blank): client `role="alert"` `Compression threshold needs a whole number above zero.` (`policy-page.tsx:832-838`), server same sentence (`policy-actions.server.ts:329-333`). Value while OFF: `Compression threshold: 5 events · saved; the guardrail is off, so it applies once you turn it on`. No-ops: `Compression threshold is already 40 events · nothing changed` / `... is already on · nothing changed` (`:390-400`). Remove on a default: `Compression threshold is one of the enforced guardrails: turn it off, it cannot be removed.` (`:322-326`); the GitHub row: `Delete the task branch after merge is managed on Settings → GitHub, not here.` (`:318-321`).
2. Build ≥ 6 events with ≥ 2 CONSECUTIVE routine machine comments in the older region. With value 5: `keepRecent = max(4, floor(5/2)) = 4`. Example on a fresh task (already has `task.created`-era events: check `event_count` on the projection): steer the operator to post 3 DISTINCT substantive comments (`Coordination note 1: ...`, `2`, `3`; each must pass R3/R4), then post ONE human comment (`Checked the plan.`) which runs the pass from `appendComment`.
3. Expect: `task.md` rewritten; the 4 newest events kept; older consecutive operator comments folded into one `Operator` comment `_2 earlier routine comments compacted to keep the task readable — human comments are never compacted._` (the newest agent reply in a run of agent comments stays; the human's own comment and any `toAgent` comment stay); `event_count` drops; NO audit row, NO event, NO toast, NO notification. The observer sees it only by re-reading the timeline (older events vanish) or `task.md`.
4. Non-triggers to verify: a mid-run agent `post_comment` or controller `comment_on_task` flood never compacts, however long (only a later human/operator/final-reply write does); a timeline of 40 typed events plus human comments never shrinks (nothing foldable) yet counts on Insights.
5. OFF proof: checkbox `Compression threshold guardrail` → `Compression threshold: off · applies from the next agent comment`; with the row off a 65-comment operator flood plus a human comment compacts nothing (`task-actions.server.test.ts:824-846` pins this).

### G.4 Human comments and the guardrails (direct answer)

- Human comments are NEVER dropped or trimmed: `appendComment` (`task-actions.server.ts:1178-1290`) validates only non-empty text (`Comment text is required.`) and runs none of `isMeaninglessComment` / `separateEvidence` / the duplicate compare. A human `ok`, twice, posts twice (audit `task.comment {toAgent}` each). The Lexical composer only refuses an all-whitespace draft (`comment-composer.tsx:49,228`).
- Human comments are never compacted either (`timeline-compaction.server.ts:99-101`); the only guardrail effect a human write has is TRIGGERING a compaction pass over machine comments.
- Controller comments (`comment_on_task`) are `actor {kind: "controller"}`, guardrail-free, and ARE foldable by compaction (`actor.kind !== "human"`), footer included.

### G.5 Where a drop is visible, and drift candidates

Visibility: a dropped/deduped comment leaves nothing on the timeline (by design), nothing in the Activity
page's audit panel (`AUDIT_ACTION_KINDS` lists no `task.comment.dropped`, `task.agent.replied` or
`task.agent.commented`; `activity-feed.server.ts:33-40`), and only a row in `/org/settings` → `Audit log`
(org admin; newest 150, text filter over `action / actorLabel / subjectId / projectSlug`; NO details column,
`audit-browse.server.ts:13,16-24`) or the CSV/JSON export. So a `task.agent.replied` row with
`droppedByGuardrail` is indistinguishable from a normal one in the in-app browse, and a project member has
no surface at all that says "the agent's reply was dropped".

Drift candidates (docs vs code, or copy vs behaviour):
1. `docs/domain/agents-and-runtime.md:701` and `docs/validation/2026-09-01-doc-validation.md:249` say the module fallback is `60 / keep 24`; code `DEFAULT_COMPACTION = {threshold: 40, keepRecent: 24}` (`timeline-compaction.server.ts:43-46`, V11-6). Docs stale. Also undocumented: at the default value 40 the effective `keepRecent` is 20, not 24 (the formula in every call site).
2. The final-reply `meaningful-comment` check is unreachable from every human dispatch door because the dispatch-completion cc line (`task-actions.server.ts:3612-3624`) is appended BEFORE the check; only operator-dispatched runs can be dropped. Not stated anywhere in docs.
3. `templates.ts:93` (`Status chatter is rejected before it reaches the timeline.`, rendered on the Policy card as the row's `desc`) and `docs/domain/agents-and-runtime.md` §9 promise rejection that the agent mid-run `post_comment` and controller `comment_on_task` bypass entirely (`agent-toolkit.server.ts:116` "guardrail-light").
4. `no-duplicate-summary` (`templates.ts:94` "A summary that restates an earlier one is dropped") governs only operator comments; agent replies dedup by a run-bounded rule that ignores the toggle. §19 above ("duplicate = byte-identical to the author's previous comment") is imprecise: operator = newest operator comment anywhere; agent = own comments since run start; human = never.
5. Compaction fires at `event_count > threshold` while Insights counts `event_count >= threshold`: a task sitting at exactly the threshold is "past its compression threshold" on Insights but never compacted.
6. Insights `Long timelines` includes archived tasks (`insights-query.server.ts:436-439` filters `tasks`, not `active`), unlike the sibling cards.
7. Toggle toast `<Label>: on|off · applies from the next agent comment` (`policy-actions.server.ts:410`) names "agent comment" for all four rows, but the mid-run agent comment is the one writer none of them touch; `meaningful-comment`/`evidence-separation` apply from the next operator comment or agent FINAL reply, `no-duplicate-summary` from the next operator comment only.
8. Compaction deletes machine prose from canonical `task.md` with no event, audit row, or log line; the operator's react input still gets a dropped reply's raw text (`:4193`). Both are silent state changes an observer can only detect by diffing.
9. `docs/domain/agents-and-runtime.md:698` "Dropped comments audit `task.comment.dropped`": true for operator drops only; agent-reply drops audit `task.agent.replied {droppedByGuardrail|deduped}` instead (`comment-guardrails.server.ts:148-155` documents the split).

Open questions (not verified live): whether a steered operator will follow a literal "post ok" instruction;
whether the operator, reacting to a dropped `ok` reply it can still read, narrates a reply humans never saw;
whether the Policy card's `desc` column renders the `templates.ts` sentence verbatim (read from `g.desc`,
`policy-page.tsx:775`, source `project.md` row `desc`, which older projects may carry differently).

---

## Gap fill: Goal-chain advance engine: what completes a link, next-link creation, onFailure, link blockedBy, runner tick

Code-verified 2026-09-06 on `pass35/k9s-clone-observation`. Sources: `app/server/tasks/goal-actions.server.ts`
(engine, 1216 lines), `app/server/files/goal-writer.server.ts` (file I/O, history bullets),
`app/schemas/goal-file.schema.ts`, `app/server/projections/rebuilder.server.ts:735-921` (`goal_projections`),
`app/server/tasks/dependencies.server.ts` (release engine), `app/server/projections/dependencies.server.ts`
(read-time resolution), `app/server/tasks/task-actions.server.ts` (hooks), `app/server/controller/controller-toolkit.server.ts:1866-2081`
(tools), `app/routes/project.controller.tsx:150-186` (`goal-op`), `app/features/controller/controller-page.tsx:545-712`
(Goals panel). Docs read first: `docs/domain/controller-and-goals.md` §7-8, `docs/architecture/decisions.md`
rulings 99(e) and 131, `docs/architecture/file-formats.md` §2b.

### 24.1 Identifiers (all verified)

| Thing | Value | Verified in |
|---|---|---|
| Goal file | `<dataRoot>/projects/<slug>/goals/goal-<n>.md` | `file-store-root.server.ts:104-115` (`goalsDir`, `goalFilePath`) |
| Goal id mint | `goal-<max+1>` by directory scan, under `withGoalsLock` (`withFileLock("goals:<goalsDir>")`) | `goal-writer.server.ts:222-241` |
| Goal statuses | `active`, `paused`, `attention`, `completed`, `cancelled` | `goal-file.schema.ts:33-39` |
| Link statuses | `pending`, `active`, `done`, `failed`, `skipped` | `goal-file.schema.ts:42-48` |
| `onFailure` | `pause` (default), `continue` | `goal-file.schema.ts:51`, `goal-actions.server.ts:238` |
| Frontmatter keys (write order) | `id, title, status, createdBy, createdByLabel, onFailure, links, createdAt, updatedAt` | `goal-file.schema.ts:97-107` |
| Link keys | `index, title, goal, taskKey, status, note, blockedBy` | `goal-file.schema.ts:54-74` |
| Body | `## Description` then `## Timeline` of `- <UTC ISO> · <text>` bullets, NEWEST FIRST (`unshift`) | `goal-writer.server.ts:37-39,288-293` |
| `GOAL_MAX_LINKS` | 20 | `goal-actions.server.ts:72` |
| Runner interval | `GOAL_TICK_MS = 60_000`, plus one immediate tick at boot; timer `unref`'d; singleton `Symbol.for("viberr.goalRunner")` | `goal-actions.server.ts:1060-1104`, `boot.server.ts:753` |
| Projection table | `goal_projections (project_slug, goal_id PK; title, status CHECK, created_by, created_by_label, on_failure CHECK, links_json, description, current_index, links_total, links_done, created_at, updated_at, source_path, content_hash, parsed_at)` | `db/migrations/0001_baseline.sql:211-233` |
| Task back-reference | `task.md` frontmatter `goalRef: {goalId, linkIndex}`; `task_projections.goal_id`, `goal_link_index` | `task-file.schema.ts:858`, `rebuilder.server.ts:540,627-628` |
| Audit actions | `goal.created` (actor = asking user), `goal.updated {op, message}` (actor = caller), `goal.completed` (actor `{userId: null, label: "goal-runner"}`); chain-created task rows: `task.created` with actor label `<createdByLabel> · goal chain` | `goal-actions.server.ts:270-277,551-558,923-931`, `task-actions.server.ts:731-739` |
| Notification | kind `controller`, `title: "<goalId> · <goal title>"`, `from: {kind:"agent", name:"Controller"}`, to `createdBy` only; pref category `controller` ("Controller updates"); off category = row never written | `goal-actions.server.ts:621-643`, `notification-prefs.ts:66-75,113-117` |
| SSE | `goal.updated {projectSlug, goalId}` (project-routed) on every projection write; the goal file writer skips no-op writes so the runner does not fan out a minute-ly event | `rebuilder.server.ts:913-918`, `goal-writer.server.ts:254-303` |
| Dependency grammar | `K9S-6` (task key) or `goal-1 link 3`; `GOAL` is a reserved task prefix | `app/shared/dependencies.ts:18-24,45-95` |
| Dependency audit | `task.dependencies.updated {blockedBy, added, removed}`, `task.dependencies.released {entries, clearedBy}` | `dependencies.server.ts:321-331,393-401` |
| Dependency notification | kind `dependency`, pref category `dependencies` ("Dependency releases"); recipients = project admins + maintainers + task owner | `dependencies.server.ts:402-406`, `task-mutation.server.ts:265-276` |
| Operator triggers touched | `create` (refused while held), `dependencies-released` (the release turn), `scheduled` (retired `skipped-held`) | `operator-run.server.ts:286,1481-1502`, `schedule.server.ts:731-735,778-779` |

### 24.2 What completes a link (the ONLY completion signal)

`reconcileGoal` (`goal-actions.server.ts:772-960`) derives every linked task's state from the CANONICAL `task.md`
(`readTaskFile`, never the projection; comment at 797):

| Task file state | Derived `taskState` | Effect on a link that is not `skipped` | History bullet written |
|---|---|---|---|
| file missing | `gone` | link `failed`, `note: "Task <key> is missing from the store."` | `Link N (<title>) failed: Task <key> is missing from the store.` |
| `archived: true` | `failed` | link `failed`, `note: "Task <key> was archived."` | `Link N (<title>) failed: Task <key> was archived.` |
| `isTerminalStage(stage, project.stages)` | `done` | link `done` | `Link N (<title>) completed by <key>.` |
| anything else | `open` | a stored `done` reverts to `active` (task pulled back out of the last stage); a stored `failed` reverts to `active` (task restored) | `Link N (<title>) reopened: <key> left the final stage.` / `Link N (<title>) recovered: <key> is on the board again.` |

- So: a link is complete when its task's `stage` is the project's TERMINAL stage id, however it got there. Acceptance
  is the usual route (acceptance moves the task to the terminal stage), but a plain human transition into the last
  column, a force-accept, or an operator move all count identically. No verdict, PR, or merge is consulted
  (verified: `taskState` closure at 796-805 reads only `archived` and `stage`).
- Archive = failed, restore = recovered. Archiving a task whose link is already `done` is bookkeeping: the engine
  skips `done` links unless the task is `open` again (825-838), and the projection keeps `done` for an archived task
  (`rebuilder.server.ts:844-852`).
- `skipped` is never re-derived (823).
- Docs claim (controller-and-goals §7.1) "archived → failed unless done; terminal stage → done; a stored done/failed
  whose task is open again → active": matches both the engine and `rebuildGoalFile:835-864`.

### 24.3 The three hooks plus the tick (who calls `reconcileGoal`)

| Caller | Where | Fire-and-forget? | Also runs the dependency release engine? |
|---|---|---|---|
| Stage transition | `transitionStage`, `task-actions.server.ts:5119-5128` | yes (`void (async…)().catch(() => {})`) | yes, `maybeReleaseDependents(db, ctx, slug)` at 5128 |
| Archive / restore | `setTaskArchived`, `task-actions.server.ts:6618-6626` (after `noteDeadDependency` on archive, 6603-6614) | yes | yes at 6626 |
| Acceptance | `applyAcceptanceWrite`, `task-actions.server.ts:8907-8916`, only when `accepted` | yes | yes at 8915 |
| `updateGoal` after `resume`, `skip_link`, `add_link` (`advanceAfter`) | `goal-actions.server.ts:604-605` | awaited | no (the tick or the next task hook does it) |
| Runner tick | `goalRunnerTick` = `reconcileAllGoals` (SQL: `status IN ('active','attention')` on `goal_projections`) then `releaseDueDependents` (every `projects.archived = 0`) | awaited, non-overlapping (`running` flag) | yes |

- `maybeReconcileGoalForTask` (995-1022) reads the task file's `goalRef.goalId`; a task with no `goalRef` is a no-op.
  A goal in `completed` or `cancelled` returns immediately at 788-794: NOTHING ever revisits a terminal chain.
- Hooks are fire-and-forget: the HTTP response to the acceptance/transition returns BEFORE the next link's task
  exists. Observer: wait for the `goal.updated` SSE or reload; the next task normally appears within one event loop
  turn, at worst within 60 s from the tick.
- The tick only walks `active | attention` chains: a `paused` chain is never touched until `resume`.

### 24.4 One reconcile pass, in order (`goal-actions.server.ts:813-914`)

1. Per link with a `taskKey`: derive and record as in 24.2; remember the first NEWLY failed link (`failedLink`) and
   whether a link moved OUT of `failed` this pass (`recoveredLink`).
2. `anyFailedOpen = links.some(status === "failed")`. If true AND `onFailure === "pause"` AND status `active`:
   status becomes `attention`; bullet `Chain paused (attention): a link failed.`; notification text
   `Link N failed. The chain is paused for your decision: retry it, skip it, or cancel the goal.` when the failure
   was seen THIS pass, else `A link failed. The chain is paused for your decision.` (863-871).
3. If `recoveredLink && !anyFailedOpen && status === "attention"`: status back to `active`; bullet
   `Chain resumed: the failed link is live again.` (879-882). Only the park whose cause this pass watched disappear
   is lifted (an authority park is not, comment 868-878).
4. If `allLinksSettled` (every link `done|skipped`, at least one link) and status is not `attention`: status
   `completed`, bullet `Every link is settled. Goal completed.`, audit `goal.completed`, notification
   `Goal completed: every link is settled.` (884-888, 921-931). Note: a `paused` chain whose last link completes
   is marked `completed` too (the guard is only `!== "attention"`).
5. Else if status `active`: `currentLinkIndex` = first link not `done|skipped`.
   - current link `failed` and `onFailure: continue`: link becomes `skipped`, `note` = `<old note> Chain continues past it (onFailure: continue).`,
     bullet `Link N failed and was skipped (onFailure: continue).`; then either completes the goal or targets the next
     link that has no task (890-906).
   - current link `pending` with no `taskKey`: it is the start target (907-910).
6. The history bullets of the pass are joined with spaces into ONE timeline line (914).
7. Start target: re-prove the creator's LIVE `create-task` via `resolveProjectAuthority(..., silentDeny: true)`
   (`creatorMayCreateTasks`, 648-660). Lost authority: status `attention`, bullet
   `Chain paused (attention): <createdByLabel> no longer holds task creation in this project, so the next link could not start.`,
   notification `The chain could not advance: you no longer hold task creation in this project. Ask a project admin to restore it, then resume the goal.` (936-950).
8. `startLinkTask(..., mode: "advance")` under an in-process lock `goal-start:<slug>:<goalId>:<index>` (681-693).
   Inside (`startLinkTaskLocked`, 695-772): re-read the file; return null unless status `active`, link `pending`
   and `taskKey === null`; `createTask` with `goalRef`, title = link title, goal text below, `blockedBy` = the
   link's declared list; then under the goal-FILE lock re-check `active` again, write `taskKey`, `status: active`,
   `note: null`, bullet `Link N (<title>) started as <KEY>` + (`, waiting on <a, b>` when declared) + `.`;
   notification `Link N started as <KEY>.` with the task key attached. If the chain went non-active during the
   `createTask` await, the task EXISTS with a `goalRef` but no link claims it (logged
   `goal link start abandoned: chain no longer active`, 753-761): an orphan task that the goal chip still points at.
9. `createTask` throwing (any reason, e.g. the link's `blockedBy` names a task archived since the declaration):
   status `attention`, bullet `Chain paused (attention): creating the next link's task failed (<error.message>).`,
   notification `The chain could not advance: creating the next link's task failed. Resume the goal to retry.` (965-982).
10. `rebuildGoalFile` at the end of every pass (987): projection + `goal.updated` SSE.

Idempotency: `updateGoalFile` serialises with the OLD `updatedAt`, compares to the raw file, and writes NOTHING when
the substance is unchanged (`goal-writer.server.ts:295-303`); a reconcile with nothing to do leaves the file byte-identical
(test `goal-actions.server.test.ts:541`).

### 24.5 The next link's task, exactly

| Field | Value | Verified |
|---|---|---|
| Actor (audit `task.created`, timeline assign event) | `{userId: <goal createdBy>, label: "<createdByLabel or createdBy> · goal chain"}` | `goal-actions.server.ts:957-961` |
| `createTask` gate | `requireAction(... "create-task")` on THAT actor, so the creator must still be contributor/maintainer/admin (`rbac.ts:64`); a denial throws into step 9 above | `task-actions.server.ts` createTask + `goal-actions.server.ts:936` |
| Title | link `title` | 723 |
| `## Goal` | `Part of goal <id> (<goal title>), link <n> of <links.length>.` + (` The previous link was carried by <prevKey> (<prev status>).` when the previous link had a task) + blank line + link `goal` (or the title when the link goal is empty) | `linkGoalText`, 111-123 |
| Stage | the project's ENTRY stage (creation into any other stage is refused: `New tasks start at <Stage>, the triage gate where a goal is refined. ...`) | `task-actions.server.ts:557-563` |
| Owner seat | the goal CREATOR (`seat: "creator"`; the chain actor is a human user id, not the operator placeholder), so the creator's own Claude/Codex accounts bill every run on every link (ruling 127) | `task-actions.server.ts:568-598,628` |
| Timeline at birth | `assign` event `Took task ownership by creating the task. ...` authored by the creator; plus, when held, a `note` titled `Waits on other work`: `Created waiting on <a, b>. Held until every entry is done; Viberr releases it then.` | 673-702 |
| `waiting` | `none` when `blockedBy` non-empty, else `human` | 628 |
| `goalRef` | `{goalId, linkIndex}` | 664 |
| Operator | `autoInvokeOperator(..., "create")` fire-and-forget; no-op when the project has no operator deployed; REFUSED at fire time with `refused: "blocked-by"` (no run, no cost, no timeline note) when `blockedBy` is non-empty | `task-actions.server.ts:744`, `operator-run.server.ts:1481-1502`, `noteQueuedTriggerRefused:688` |

Link 1 is created INSIDE `createGoal` (`goal-actions.server.ts:245-258`) before the goal file exists, under the ASKING
user's actor (via the controller: label `<email> · via controller`, `actor-ref.server.ts:137`), so a refused first task
leaves no goal file. Link 1 gets NO `Link 1 started as …` notification and no per-link bullet: the file's first bullet
is `Goal created with N links by <label>.` (`goal-writer.server.ts:246-260`) and the audit is `goal.created
{title, links, firstTask}`. Docs claim (controller-and-goals §8) notifications for "started"; code: only links >= 2
and retries notify a start.

### 24.6 Goal statuses, what each blocks, and how it is left

| Status | Set by | Advance engine | Tick walks it | Exit |
|---|---|---|---|---|
| `active` | creation; `resume`; `skip_link`/`retry_link` from `attention`; auto-recover (24.4 step 3) | runs | yes | any op |
| `paused` | `pause` op only (a human's park) | a task-hook pass still records done/failed links and (step 4) can mark the chain `completed`; it never starts a task | no (only `active`,`attention`) | `resume`, `cancel` |
| `attention` | machine park: failed link with `onFailure: pause`; creator lost `create-task`; `createTask` threw; retry could not start | records, never starts; a `pending` next link is NOT started while parked | yes (so re-parks/recoveries land within a minute) | `retry_link`/`skip_link` (both flip `attention` to `active`), `resume`, `cancel` |
| `completed` | engine only | early return forever | no | none: every op answers `409 Goal <id> is completed.` |
| `cancelled` | `cancel` op | early return forever | no | none: `409 Goal <id> is cancelled.` |

- Tasks are NEVER touched by a goal status change: cancelling or pausing a chain leaves the active link's task open
  on the board, its operator running (verified: the `cancel`/`pause` cases at 406-432 write only the goal file).
- The projection re-derives LINK statuses on every rebuild but never the GOAL status (`rebuildGoalFile` copies `fm.status`,
  873-881): a `completed` chain whose done task is dragged back out of the last column shows `completed` with an
  `active` link and `current_index` non-null; the engine will not revisit it.

### 24.7 `update_goal` ops: gate, precondition, exact message, refusal, bullet

Gate (`requireGoalAuthority`, 306-329): the creator (any membership + project mutable, refusal
`Only project members can redirect a goal chain.`) OR a holder of `run-agents` (admin/maintainer; `requireAction`
sentence). Every op first: unknown goal `404 Goal <id> not found.`; terminal chain `409 Goal <id> is <status>.`.
Audit `goal.updated {op, message}` is written for EVERY op including no-ops (551-558). Bullets are prefixed by the
UTC timestamp; `by` = `actor.label` (the controller path: `<email> · via controller`).

| op | Precondition / refusal (exact) | `message` (page toast / tool reply) | History bullet |
|---|---|---|---|
| `pause` | already paused: message `Goal <id> is already paused.` (no bullet) | `Goal <id> paused.` | `Paused by <by>.` |
| `resume` | already active: `Goal <id> is already active.` | `Goal <id> resumed.` then `reconcileGoal` | `Resumed by <by>.` |
| `cancel {reason?}` | none | `Goal <id> cancelled. Its record stays readable.` | `Cancelled by <by>` + (`: <reason>`) + `.` |
| `skip_link {index, reason?}` | `No link N.` (400); `Link N is already <done|skipped>.` (409); active WITH task: `Link N is being worked by <KEY>. Archive or finish that task first, or retry the link after it fails.` (409). Allowed on `pending` (no task) and `failed`. `attention` flips to `active`; reconcile follows | `Link N skipped.` | `Link N (<title>) skipped by <by>` + (`: <reason>`) + `.`; `note` = reason when given |
| `retry_link {index}` | `No link N.`; not failed: `Only a failed link can be retried; link N is <status>.` (409). `attention` flips to `active`; then `startLinkTask(mode: "retry")` under the PRESENT caller's actor (the caller needs live `create-task`) | `Link N queued for retry.` | `Link N (<title>) retried by <by>.` then, on success, `Link N (<title>) started as <KEY>.`; on failure the chain re-parks: `Retry could not start link N's task (<err>); parked for redirect.` + notification `A link retry could not start its task. Resume or redirect the goal to try again.` |
| `edit_link {index, title?, goal?, blockedBy?}` | `No link N.`; not pending/failed: `Only a pending or failed link can be edited; link N is <status>.` (409). Blank title/goal are ignored (keep). `blockedBy` absent = keep; `[]` = clear; list = validated (24.9) | `Link N updated` + (`; waits on <a, b>` or `; waits on nothing` when `blockedBy` was passed) + `.` | `Link N edited by <by>` + same clause + `.` |
| `add_link {title, goal, blockedBy?}` | `A goal chain carries at most 20 links.` (400); `Give the link a title.` (400). Index = highest existing + 1. Reconcile follows (starts it at once if it became the current link of an active chain) | `Link <count> added.` | `Link <count> (<title>) added by <by>.` |
| `remove_pending_link {index}` | `Only a pending link with no task can be removed from the chain.` (409); any waiter on a link at or after it: `Link N cannot be removed: removing it renumbers the links after it, and <holders> wait(s) on a link at or after N. Re-point or clear those waits first, then remove the link.` (409). Holders = this goal's own later links (`link M`), other goals' links (`goal-X link M`, read from `goal_projections`), and tasks (`task_projections.blocked_by_json LIKE %goalId%`). Later links are RE-INDEXED (`i + 1`) | `Link removed; the chain now has N link(s).` | `Pending link N (<title>) removed by <by>.` |

Tool vs page exposure: the controller tool `update_goal` exposes all eight ops and replies
`[done] <message> Goal <id> is <status>` + (` on <activeTaskKey>`) + `.` (toolkit 2069-2077). The page intent
`goal-op` accepts only `pause | resume | cancel | skip_link | retry_link` (else `400 Unknown goal action.`) and
toasts `result.message` ONLY, not the post-op status (`project.controller.tsx:150-186`). The Goals panel renders
Retry/Skip only on a `failed` link, Resume when `paused|attention`, else Pause, plus `Cancel goal`; no controls at all on
`completed|cancelled`; controls need `run-agents` or org admin (`canRedirectGoals`, `project.controller.tsx:106-108`),
so a contributor CREATOR sees none although the server would accept their ops (docs §7.4 say the same).
Retry/Skip visibility is judged on the PROJECTION's reconciled link status, the server on the FILE's: after a task is
archived they agree once the archive hook's reconcile lands; between an out-of-band archive and the next tick the
buttons show while the server may still say `Only a failed link can be retried; link N is active.`

### 24.8 `onFailure` in practice

| Event | `pause` (default) | `continue` |
|---|---|---|
| Link task archived (or file gone) | link `failed`; chain `attention`; creator notified; nothing advances | link `failed` then, in the SAME pass (step 5), `skipped` with note `Task <key> was archived. Chain continues past it (onFailure: continue).`; next link's task created at once; no notification about the failure, only `Link N+1 started as …` |
| Only remaining link fails | `attention` (never completes while a link is `failed`) | `completed` (all settled) |
| Failed task restored from the archive | link back to `active`, chain auto-`active` (24.4 step 3) | the link is already `skipped`; the restored task is orphaned from the chain (skipped never re-derives); the chain has moved on |

`onFailure` is set only at `create_goal` (`goalInput.onFailure`, toolkit 1915); no op edits it afterwards.

### 24.9 Link `blockedBy` (declared wait): validation, inheritance, release

Validation at declaration (`validateLinkWait`, 133-171; called from `createGoal`, `edit_link`, `add_link`):
- Own-chain references (`goal-<this> link M`): `<ref>: a link cannot wait on itself.`; `<goalId> has no link M (it has N).`;
  `<ref>: a link cannot wait on a LATER link of its own chain (the chain runs in order).`
- Everything else goes through `validateDependencyRefs` (`dependencies.server.ts:162-203`) with
  `self = {kind:"goal", goal, link}`: `"<text>" is not a task key or a goal link. a task key like JC-6, or a goal link like goal-1 link 3`;
  `<ref>: a task cannot wait on itself.`; `<KEY> is not a task in this project.`; `<KEY> is archived; a task cannot wait on abandoned work.`;
  `<goal> is not a goal in this project.` (the sibling goal must already be PROJECTED: a goal created in the same
  controller turn is fine, the toolkit awaits `createGoal` which rebuilds); `<goal> has no link M (it has N).`;
  `<ref> (<KEY>) is archived; a task cannot wait on abandoned work.`; cycle:
  `Waiting on <ref> would close a cycle: <self> waits on <a> waits on <b> ...` (walks stored task lists AND declared
  goal-link lists, `edgesOf`, 106-118).
- Stored canonical: task keys upper-cased, goal ids lower-cased, de-duplicated (`app/shared/dependencies.ts:72-90`).

Inheritance at start (24.5): the link's list is passed to `createTask`, which re-validates with `self: null` BEFORE
allocating a key (`task-actions.server.ts:605-609`); a wait that died since the declaration parks the chain with the
validator's sentence inside `Chain paused (attention): creating the next link's task failed (<sentence>).`

Read-time state of an entry (`projections/dependencies.server.ts:96-160`), never cached:

| Entry | State |
|---|---|
| task key: row missing / archived / terminal stage / else | `missing` / `failed` / `done` / `open` |
| `goal-X link M`, goal row or link absent | `missing` |
| link has `taskKey` | that task's state (label `goal-X link M (<KEY>)`) |
| link without task: status `done|skipped` / `failed` / `pending|active` | `done` / `failed` / `open` |

The goal's OWN status is not consulted: a `pending` link of a `cancelled` or `paused` goal reads `open` forever, so a
task waiting on it is neither released nor dead-noted (see drift 24.12-3).

Release (`releaseDependents`, `dependencies.server.ts:477-500`, per project, from the three hooks and the tick):
1. `noteDeadDependency(null)`: every held task with a `failed|missing` entry gets ONE `note`
   (actor `system:dependency-release`, title `Waiting on work that cannot complete`, text
   `<labels> can never complete. This task stays held; edit what it waits on (remove the entry or point it elsewhere) to release it.`),
   `waiting: human`, notification kind `dependency` titled `<KEY> waits on archived work`. Idempotent by exact text.
2. `releaseTask` per held task (`listHeldTasks`: `blocked_by_json != '[]' AND archived = 0`): a held task already at the
   terminal stage has its list cleared silently (no note, no run); otherwise, when every entry is `done`:
   `clearDependencies` (list `[]`, `heldAtStage: null`, stored `readiness: blocked` lifted to `ready`), then
   `announceRelease`: note titled `Dependencies released`,
   `Released: everything this task waited on is done (<list>). The task can move again; the base branch has changed since the hold, so the work re-reads it before continuing.`
   (`toAgent: true`), audit `task.dependencies.released`, notification `<KEY> can move again`, then
   `autoInvokeOperator(..., "dependencies-released")` whose doctrine opens
   `The work this task waited on has landed: <list> is done. Viberr released the task ...` (`operator-run.server.ts:3839-3852`).
   A human emptying the list is the same release with `clearedBy`: `Released: <label> cleared the wait on <list>. The task can move again; the base branch may have changed since the hold.`

Cross-goal wait, end to end (goal-2 link 1 waits on `goal-1 link 3`): goal-2's task K9S-7 is born held (24.5) and its
`create` trigger is refused; goal-1 link 3's task K9S-3 reaches the last stage; the acceptance hook fires
`reconcileGoal(goal-1)` (link 3 `done`, link 4 started) AND `maybeReleaseDependents(project)`, which resolves
`goal-1 link 3 (K9S-3)` = `done`, clears K9S-7's list, writes the release note, and re-invokes K9S-7's operator with
`dependencies-released`. Order between the two fire-and-forget calls is not guaranteed; both converge and the tick repeats
both within 60 s. Docs (ruling 131(e), controller-and-goals §7.3): match.

Held-task operator behaviour (verified `operator-run.server.ts:286,1481-1502,3638,3829-3836`): `create`, `transition`,
`scheduled` refused with `refused: "blocked-by"`; `manual`, `goal-updated`, `agent-reply`, `packet-resolved` and
mentions still run under `heldDoctrine` (`This task WAITS ON OTHER WORK and Viberr is holding it: <entries>. ...
Ending this turn with nothing else done is correct here.`); a scheduled `run-operator` occurrence writes
`**Scheduled action skipped:** <KEY> waits on other work (<list>) — no operator run was started; Viberr releases the task when every entry is done.`
and audits `task.schedule.fired {outcome: "skipped-held", refusedAtStart: true}`.

### 24.10 What each surface shows

- Task hero: chip `<goalId> · link <n>` linking to `/projects/<slug>/controller` (`task-main-sections.tsx:208-219`);
  each `blockedBy` entry as a neutral pill, `failed` rendered as the word `archived`, `done`/`missing` as themselves
  (`task-main-sections.tsx:223-238`, `task-side-panels.tsx:610`).
- Controller page (`data-screen-label="Controller"`, section `aria-label="Goal chains"`, heading `Goals`): per goal
  `<id>` mono + title + status pill (`active|paused|attention|completed|cancelled`); per link a pill
  (`pending|active|done|failed|skipped`), title, `waits on <list>` (`data-link-wait`), task-key link to `../tasks/<KEY>`,
  the `note` in small text. Empty state: `No goal chains yet. Ask the controller to plan one: it decomposes an outcome into an ordered chain of tasks and advances it as each link completes.`
  The list comes from `goal_projections` (`listGoals`), history is NOT shown on the page (`history: []` at 1212);
  `get_goal` (file read) is the only surface that prints the timeline bullets.
- Controller context block per turn: `goal chains:` then `- <id> · <title> · <status> · link <i> of <n>` (max
  `BOARD_CONTEXT_GOALS = 20`), and per task `goal chain <id> link <n>` (`controller-context.server.ts:279,362-370`).
- `list_goals` returns `{id,title,status,createdBy(label),currentLink,links[{index,title,status,taskKey,blockedBy}]}`
  from the projection; `get_goal` returns the full `GoalView` from the file including `history[{occurredAt,text}]`.

### 24.11 Verification recipe per link advance (R7 + goal file diff)

Before driving link N to Done, snapshot: `cat data/projects/<slug>/goals/goal-<g>.md` and note `updatedAt`, link N's
`status`, link N+1's `taskKey: null`, and the top timeline bullet. Then, after the acceptance/transition/archive:

1. Goal file (canonical): link N `status: done` (or `failed` + `note`), link N+1 `taskKey: <KEY>`, `status: active`;
   `updatedAt` bumped; new bullets, newest first, expected in this order (two writes, so two timestamps):
   `Link N+1 (<title>) started as <KEY>.` above `Link N (<title>) completed by <oldKey>.`
   (with `onFailure: continue` after an archive: `Link N+1 ... started ...` above
   `Link N (...) failed: Task <oldKey> was archived. Link N failed and was skipped (onFailure: continue).` on one line).
   On the last link: `Every link is settled. Goal completed.` and `status: completed`.
2. New task file `data/projects/<slug>/tasks/<KEY>/task.md`: `goalRef: {goalId, linkIndex: N+1}`, `stage` = entry
   stage id, `ownerUserId` = goal creator, `## Goal` starts `Part of goal goal-<g> (...), link N+1 of L. The previous link was carried by <oldKey> (done).`,
   `blockedBy` = the link's declared list (and the `Waits on other work` note when non-empty).
3. `goal_projections`: `status`, `links_json` (reconciled), `current_index = N+1`, `links_done = N` (+ skipped),
   `content_hash` changed; `task_projections` row for `<KEY>` with `goal_id`, `goal_link_index`.
4. Audit (R7): `task.created` actor label `<createdByLabel> · goal chain`, subject `<KEY>`, details
   `{title, stage, ownerUserId, seat: "creator"}`; on the last link `goal.completed` by `goal-runner`; any op:
   `goal.updated {op, message}`. No audit row is written for an ordinary advance itself (only the task creation).
5. Notifications for the creator (kind `controller`): `Link N+1 started as <KEY>.` (with task link); on a park the
   `attention` text; on completion `Goal completed: every link is settled.` Link 1 never gets a start notification.
6. Operator: `<KEY>` gets a `create` operator run unless held (then no run at all and `waiting: none`; the first run
   arrives as `dependencies-released` once the wait clears, with its `Dependencies released` note above it).
7. Timing: hook-driven, so within seconds; if the file shows the advance only after up to 60 s, the hook did not fire
   (out-of-band edit or a hook exception logged `goal reconcile failed`) and the tick caught it.
8. Cross-goal wait: on the waited-on link's completion, the dependent task's file loses its `blockedBy`, gains the
   `Dependencies released` note and `task.dependencies.released` audit, and its goal's link stays `active` (a release
   changes no link status).

### 24.12 Drift candidates found in this gap (code wins)

1. `resume` on an `attention` chain whose link is still `failed` (`onFailure: pause`) is a no-op that lies: `updateGoal`
   sets `active`, reconciles, and the pass re-parks to `attention` with a FRESH creator notification
   (`A link failed. The chain is paused for your decision.`) and a fresh bullet; the page toast still says
   `Goal <id> resumed.` (the route toasts `message` only), the tool reply says `... resumed. Goal <id> is attention.`
   The Goals panel offers `Resume` as the primary button on every `attention` card (`controller-page.tsx:681-689`).
   Every press adds a `Resumed by` + `Chain paused` bullet pair and a notification. The only real exits are Retry/Skip.
2. `retry_link` on a `paused` chain records `Link N (<title>) retried by <by>.` and toasts `Link N queued for retry.`
   but starts nothing: `startLinkTaskLocked` returns null when `fm.status !== "active"` (line 716) and the retry case
   only lifts `attention` (462); no error, so no re-park either. The link stays `failed` and nobody is told.
3. A dependency on a `pending` link of a `cancelled` (or `paused`) goal reads `open` forever
   (`projections/dependencies.server.ts:150-159` never reads the goal status), so the dependent task is neither
   released nor dead-noted; the comment at `dependencies.server.ts:481-486` claims the sweep now notices "a cancelled
   goal". Only a REMOVED link (entry `missing`) or a `failed` link is noticed.
4. `rebuildGoalFile` re-derives link statuses but never the goal status: a `completed` goal whose done task is moved
   back out of the last column shows `completed` + link `active` + `current_index` set; the engine early-returns on
   `completed` so the file is never corrected (`goal-actions.server.ts:788-794`, `rebuilder.server.ts:853-860`).
5. A `paused` chain can still be marked `completed` by the tick? No: the tick only walks `active|attention`, but the
   task HOOKS call `reconcileGoal` regardless of status, and step 4's guard is only `!== "attention"`, so accepting a
   paused chain's last link completes the goal while it is "paused". Cosmetic, but "paused ... nothing advances until
   resumed" (schema comment, docs §7.1) is not strictly true.
6. Docs (controller-and-goals §8) say the `controller` notification fires for "started, attention, completed"; link 1's
   start (inside `createGoal`) sends nothing. Low.
7. Docs §7.4 list `skip_link` under "per-failed-link"; the server also skips a `pending` link with no task (the page
   never offers it, the tool does). Not a defect, an undocumented exit.
8. `startLinkTaskLocked` abandon path (751-760): a task created for a link during a concurrent `cancel`/`pause` keeps
   its `goalRef` and hero chip but no link ever claims it; the goal card shows the link still `pending`. Rare race.
9. Retry/Skip buttons are judged on the projection, the op on the file; between an out-of-band archive and the
   reconcile that follows, the panel can offer `Retry` and the server answer
   `Only a failed link can be retried; link N is active.` Window is one hook or at most one tick.
10. `remove_pending_link` refusal names holders as `link M` (own chain) and `goal-X link M` (sibling) and bare task
    keys; the docs do not mention that a sibling goal's not-yet-started link blocks removal (test at
    `goal-actions.server.test.ts:1113`). Not drift, undocumented.

### 24.13 Open questions (not verified here)

- Whether `notifyTaskWatchers` for `dependency` notifications de-duplicates when the owner is also a maintainer (one row
  or two); recipients are a `Set` of user ids (`task-mutation.server.ts:265-276`), so one row is expected.
- The operator's `set_dependencies` tool refusal sentences were not read (operator-actions.server.ts); the validator is
  shared so the sentences in 24.9 should be identical.
- Whether the acceptance path's `autoInvokeOperator` and the goal hook race such that the NEW link's `create` run can
  start before the goal file records `taskKey` (the run reads `task.md`, which already carries `goalRef`, so the run is
  correct either way; only the goal file lags by one write).
- The controller-run turn's handling of a `[done]` reply for `create_goal` when link 1's `create` trigger was refused
  (`blocked-by`): the reply does not mention the hold; `get_goal` history does (`... started as ..., waiting on ...`
  appears only for links >= 2; link 1's held state is on the TASK's `Waits on other work` note, not in the goal file).

---

## Gap fill: Four-role + non-member live probe recipe (users, sessions, expected refusals, on-disk proof)

Everything below is verified against the working tree of `pass35/k9s-clone-observation` (HEAD `cb4fa22a`).
Verbatim app strings keep their own punctuation (some contain an em-dash; that is the app's copy, not prose).

### 25.1 Identities to mint (five sign-ins, one non-member)

| Slot | Suggested email | Org role | Project role on the k9s project | Purpose |
|---|---|---|---|---|
| A | the operator's own admin (seed default `arda@viberr.dev` / `viberr-dev-2828`, `test-support/demo-seed.ts:84`, `app/server/seed/seed-credentials.ts:12`) | admin | admin (creator) | mints users, force-accepts, reads audit |
| M | `probe.maintainer@viberr.dev` | member | maintainer | run agents, resolve packets, archive, refused force-accept |
| C1 | `probe.owner@viberr.dev` | member | contributor, OWNER of the probe task | owner-exception paths |
| C2 | `probe.contrib@viberr.dev` | member | contributor, NOT owner | non-owner 403s |
| V | `probe.viewer@viberr.dev` | member | viewer | read + comment only |
| N | `probe.nobody@viberr.dev` | member | none | every door must answer as if the project did not exist |

Keep A on an org-admin account that IS a project member: an org admin who is NOT a member passes every gate as
the D2 override and writes `project.org_admin.override` rows instead of denials (`project-authority.server.ts:187-231`),
which would muddy the denial proof.

### 25.2 Minting: three doors, one forced-reset flow

| Door | Exact call | What comes back | Audit |
|---|---|---|---|
| Controller (instance scope, `/controller` or the dock) | tool `create_user` `{name, email, role: "admin" \| "member"}`; gate `requireOrgAdmin("create users")` (`controller-toolkit.server.ts:335-358`) | `[done] <email> created (org <role>). Temporary password (single use, must be changed at first sign in): <pw>` | `org.user.created {..., passwordless:false}` (`user-admin.server.ts:100-107`), actor label `<admin email> · via controller` |
| Controller, project scope | tool `invite_member` `{projectSlug?, name, email, role?}`; `requireVisible(slug,"manage this project's members")` then `inviteMember` → `manage-members` (`controller-toolkit.server.ts:1628-1664`, `settings-actions.server.ts:802-870`) | unknown email: `[done] Added <email>, who joins as <Role>. Set their sign-in password in Users & access. Temporary password (single use, must be changed at first sign in): <pw>`; known email: `[done] Added <email>, who joins as <Role>`; duplicate: `[error] <email> is already a member` (409 is not 403, so `[error]`) | `org.user.created` (only when minted, org role always `member`) + `project.member.invited {email, role}` |
| Org settings UI `/org/settings?tab=users` | POST intent `invite-local` fields `name`, `email`, `role` (`admin` else `member`), `_csrf` (`org.settings.tsx:425-439`) | card text `Temp sign-in password: <code> (shown once, hand it over out-of-band).` (`users-panel.tsx:471-477`); toast `Account created — temp sign-in password ready for <email>` (`org-users.server.ts:221`) | `org.user.created` |
| Project settings UI `/projects/<slug>/settings` | POST intent `invite` fields `name`, `email`, `_csrf` only (`project.settings.tsx:153-159`) | ALWAYS viewer: the form has no `role` field | `project.member.invited {role:"viewer"}` |
| Policy page role change | POST `/projects/<slug>/policy` intent `set-role` fields `userId`, `role`, `_csrf` (`project.policy.tsx:60-70`) → `setMemberRole` (`policy-actions.server.ts:100-175`) | toast `<Full name> is now <Role> · enforced on the next action`; last admin: 409 `<Project> needs at least one admin. Promote someone else first`; unknown: 404 `That user is not a member of this project.`; bad role: 400 `Unknown project role.` | `project.member.role_changed {from, to, targetUserId}` |
| Controller `set_member_role` `{projectSlug?, email, role}` | same guard chain; unknown email: `[error] No Viberr user with the email <email>.` (`controller-toolkit.server.ts:1667-1694`) | `[done] <toast>.` | same row |

Temp password facts (verified):
- 12 chars, `randomBytes(9).toString("base64url")` (`password.server.ts:22-24`); `users.pwreset_required = 1` whenever a temp password is given (`user-admin.server.ts:85`).
- Sign-in with it: `POST /login` intent `login` fields `email`, `password` (no `_csrf`; the login action runs only `assertTrustedOrigin`, `login.tsx:78`). Success with `pwreset_required` set → 302 to `/login` (or `/login?returnTo=<encoded>`) (`login.tsx:134-140`).
- Every other page then bounces to `/login?returnTo=<path>` until the reset completes (`require-user.server.ts:163-169`).
- Reset screen: `data-screen-label="Login · set new password"`, h1 `Set a new password`, sub `You signed in with a temporary password. Choose your own to continue.`, button `Save & continue`; POST intent `set-password` fields `npw`, `npw2`, `_csrf`, optional `returnTo` (`login.tsx:207-298`). Refusals (400): `New password needs at least 8 characters.` (field `npw`), `Passwords don't match.` (field `npw2`); `MIN_PASSWORD_LENGTH = 8` (`app/shared/auth/password-policy.ts`).
- Completion keeps the current session, clears the flag, audits `auth.password.forced_reset_completed`, leaves other sessions alive by design (`login.server.ts:147-176`).
- The owner performs every password entry (temp and new); the observer never types a credential.

DRIFT (candidate finding): the controller reply says the temporary password is "single use" and the tool description says "it works once". Code never marks a temp password consumed: `loginWithCredentials` (`login.server.ts:64-138`) has no used flag and `completeForcedPasswordReset` is the only thing that replaces the credential. Until the person finishes `set-password`, the same temp password signs in again from any browser. "Single use" is only true after the reset completes. Probe: sign in twice with the temp password before completing the reset; the second sign-in also succeeds.

### 25.3 Holding five sessions without tripping the throttle

- Throttle: 10 tokens per `email|ip`, full refill over 15 minutes, continuous (`rate-limit.server.ts:136-139`); ip is the literal `local` unless `VIBERR_TRUST_PROXY` is set (`:199-204`). The key carries the email, so five different accounts never share a bucket; only repeated failures on ONE email exhaust it. A pre-check failure (unknown email, disabled, passwordless) spends a token in the app (`login.server.ts:96-101`); a real password check spends one in the better-auth hook (`auth.server.ts:265-272`); success resets the bucket (`login.server.ts:131`).
- Refusal copy (400, whole-form): `Too many sign-in attempts. Wait a few minutes and try again.` (`login.tsx:111`); audit `auth.login.rate_limited {email}`. Wrong password: `Wrong password. Ask an admin to reset it if you're locked out.`; unknown/passwordless: `No local account for that email. Ask an admin to create one, or sign in with GitHub / Google if you're whitelisted.`; disabled: `This account is disabled. Ask an admin to re-enable it.` Audit `auth.login.failure {email, reason}`.
- Session cookie `viberr.session_token` (`auth.server.ts:33,386`), 30-day. Sign in each identity ONCE, then reuse the cookie.
- Playwright pattern (the repo's own, `e2e/auth.setup.ts`): per identity, `page.goto("/login")`, `waitForLoadState("networkidle")` (pre-hydration fills are wiped), fill `input[name="email"]` / `input[name="password"]`, click `button[type="submit"]`, `waitForURL("/")`, then `context.storageState({ path: "<scratch>/.auth/<slot>.json" })`. For a temp-password account the first submit lands on `/login` in reset mode; complete `#npw` / `#npw2` + `Save & continue` (owner types) before saving state. Later contexts: `browser.newContext({ storageState })`. Playwright is loaded via `createRequire(<project>/package.json)` when the Browser pane is hidden (memory: pass-34/35 traps). Five contexts in one Chromium are fine; the throttle is per email.
- HTTP-only probes from a stored state: read `_csrf` from the page (`<input name="_csrf">`, rendered by `CsrfInput`) and send `Origin`/`Sec-Fetch-Site: same-origin`; a POST with none of Origin/Referer/Sec-Fetch-Site is refused (docs auth §1 CSRF; `csrf.server.ts`). `page.request.post` inside the context carries the cookie and origin.

### 25.4 Role × act → door → expected result → audit row

Refusal shapes: task/board/settings/policy actions return `{ ok:false, error:<userMessage> }` with the AppError status (`form-action.server.ts:20-29`); the canonical 403 copy is `Only project members can <what>.` / `Your project role (<role>) cannot <what>.` (`project-authority.server.ts:276-281`) or, on config surfaces, `Only project <label> can <what>.` (`:383-389`). Every 403 through `resolveProjectAuthority` writes `project.authority.denied` with `details {action, what, projectSlug, memberRole}` unless deduped (same `user|slug|action` inside 60 s, `:235-256`) or `silentDeny` (only `canRunAgents`).

| # | Act | Door (fields incl. `_csrf`) | V | C2 (contrib, not owner) | C1 (contrib, owner) | M | A |
|---|---|---|---|---|---|---|---|
| 1 | Open board / task / activity / review / policy / agents / github / settings / controller page | GET | 200 for all members (`requireProjectMember`, any-member) | 200 | 200 | 200 | 200 |
| 2 | Comment, @mention a human | task POST `intent=comment`, `text` | 200 toast `Comment posted`; audit `task.comment {toAgent:false}` | same | same | same | same |
| 3 | `@<Agent name>` or `@operator` in a comment | same door | 200, toast `Comment posted · your role can't trigger agent runs`, `runtimeDenied:true`; comment IS on the timeline; audit `task.comment {toAgent:true}` and NO `project.authority.denied` (`silentDeny`, `task-actions.server.ts:1613-1625`, `project-authority.server.ts:311-327`) | same | same | run starts, toast `Comment posted · @<Name> is picking it up` | same as M |
| 4 | Create task | board POST `intent=create-task`, `title`, `goal`, `stage?`, `priority?`, `labels?`, `dueDate?` | 403 `Your project role (viewer) cannot create tasks.`; audit denied `{action:"create-task", what:"create tasks", memberRole:"viewer"}`; UI hides the button (`canCreate`) | 200 `{ok, key, stageName}`; audit `task.created` | 200 | 200 | 200 |
| 5 | Take the OPEN owner seat | task POST `intent=owner-take` (no target field; server uses the session user) | 403 `Your project role (viewer) cannot ...` via `own-task` (`:4402`) | 200 | n/a | 200 | 200 |
| 6 | Take over an OCCUPIED seat | same | 403 (own-task) | 403 `This task already has an owner. Taking it over needs completion-acceptance authority (maintainer or admin); ask them to reassign it.` (`:4447-4455`); NOT a `resolveProjectAuthority` throw, so NO denied row | idempotent 200 | 200 (supervisory takeover) | 200 |
| 7 | Hand off to another member | `intent=owner-assign`, `userId` | 403 (own-task) | 403 `Only the current owner or a project admin can hand off ownership.` (`:4463`), no denied row | 200 if target is contributor+; viewer target: `Ownership can only be handed to a project member who can own tasks (contributor or above).` | 403 unless M is the owner (same sentence) | 200 (`release-any-ownership`) |
| 8 | Release someone else's seat | `intent=owner-release` | 403 | 403 (`own-task` gate then owner check, `:4576`) | 200 (own seat) | 403 | 200; timeline `Released **<Name>** from task ownership (admin). The seat is open to any contributor or above.` |
| 9 | Edit priority / labels / due | `intent=set-task-metadata`, `priority`, `labels`, `dueDate` | 403 `Your project role (viewer) cannot edit task metadata.`; denied `{action:"edit-task-meta"}` | 200; audit `task.metadata.updated` | 200 | 200 | 200 |
| 10 | Edit goal | `intent=update-goal`, `goal` | 403 `... cannot edit the task goal.`; denied `{action:"update-goal"}` | 403 same sentence with `(contributor)`; UI deny-note `Editing the goal is reserved for maintainers and admins.` (`decision-packet.tsx:632`) | 403 (owner exception does NOT cover goal) | 200; audit `task.goal.updated` | 200 |
| 11 | Manual stage move | `intent=transition`, `to` (UI sends `manual:true`) | 403 `... cannot change the task stage.`; denied `{action:"approve-transition", what:"change the task stage"}` (`:4869`) | 403 same | 403 same | 200; audit `task.transition` | 200 |
| 12 | Resolve an ordinary packet option | `intent=resolve-packet`, `option` (index), `note?`, `custom?` | 403 `Your project role (viewer) cannot resolve decision packets.`; denied `{action:"resolve-packet", what:"resolve decision packets"}` (`:6755`) | 403 same sentence, `(contributor)` | 200 toast `Decision recorded: <option title>`; audit `task.packet.resolved` | 200 | 200 |
| 13 | Pick `archive_task` on a packet | same door, the option whose kind is `archive_task` | 403 (outer gate, row 12) | 403 (outer gate) | 403 `Your project role (contributor) cannot archive this task.` (inner re-check, `:7099-7113`; with `deleteBranch` the what is `archive this task and delete its branch`); denied `{action:"approve-transition"}`; UI blocks the option with a reason instead (`canArchiveViaPacket`, `task-detail-page.tsx:295`) | 200 | 200 |
| 14 | Route a stranded packet up | `intent=request-maintainer-decision`, `note?` | 403 `... cannot resolve decision packets.` (`:7889`) | 403 same | 200 toast `Sent to <n> maintainer(s) · they'll decide`; timeline `<email> owns <KEY> but every option on this decision ("<title>") needs maintainer authority, so they asked a maintainer or admin to make the call.`; audit `task.packet.escalated {packetKind, notified}` | 400 `You can resolve this decision yourself; there is no need to route it to a maintainer.` (`:7880-7884`) | 400 same |
| 15 | Accept completion (button / drop into Done / packet `accept_completion`) | `intent=accept-completion` + the acceptance disclosure fields (`parseAcceptanceDisclosure`, `project.task.tsx:420-424`) | 403 `... cannot accept completion into Done.` (`requireAcceptCompletion`, `:4891`, `:6779`) | 403 same | 200 (owner exception) or the gate's own 409 refusal | 200 | 200 |
| 16 | Force-accept | `intent=force-accept` + disclosure fields | 403 `Your project role (viewer) cannot force-accept past the review gate.`; denied `{action:"force-accept-completion", what:"force-accept past the review gate"}` (`:9303-9309`) | 403 `(contributor)` | 403 `(contributor)`; the owner exception does NOT apply | 403 `Your project role (maintainer) cannot force-accept past the review gate.`; UI never offers the row (`roleCan(myRole,"force-accept-completion")`, `task-detail-hooks.ts:187`) | 200 toast `Force-accepted <KEY> · moved to Done (review gate overridden)`; audit `task.acceptance.forced` (`:9371`); refused with 409 when the PR is closed (`... Force-accept cannot override that: it exists for a wedged review gate, not for a pull request GitHub has already closed.`) or the task is archived (`... restore the task first, then accept it. ...`) (`:8110-8133`) |
| 17 | Run an agent / operator | `intent=run-agent`, `profileId`, `prompt?`, `backend?`; `intent=run-operator` | 403 `... cannot <what>`; denied `{action:"run-agents"}` | 403 | 403 (owner exception does not cover runs) | 200 toast `Claude run started for <Name> · streaming to agent logs` | 200 |
| 18 | Deliver for review by hand | `intent=deliver-review` | 403 `... cannot deliver the branch & open the review PR.` (`:5929-5934`) | 403 | 200 (owner exception, `:5924`); audit `github.delivery.manual` | 200 | 200 |
| 19 | Archive / restore task | `intent=archive-task` / `restore-task` | 403 `... cannot archive this task.`; denied `{action:"approve-transition", what:"archive this task"}` (`:6511-6516`) | 403 | 403 | 200; audit `task.archived` / `task.unarchived` (`:6589`) | 200 |
| 20 | Reorder board / rescan | board `intent=reorder` / `rescan` | 403 (`reorder-board` `:6397`, `rescan-project`) | 403 | 403 | 200 | 200 |
| 21 | Invite / remove / set role | settings `intent=invite` / `remove-member`; policy `intent=set-role` | 403 `Only project admins can manage members & roles.` (config-surface label, `project-authority.server.ts:383-389`); denied `{action:"manage-members", what:"manage members & roles"}` | 403 same | 403 | 403 same (maintainer is NOT enough) | 200 |
| 22 | Edit stages / boundaries / guardrails / repo / archive project | settings + policy intents (`add-stage`, `set-boundary`, `set-guardrail`, `repair-repo`, `archive-project`, ...) | 403 `Only project admins can <what>.`; denied `{action:"edit-policy"}` | 403 | 403 | 403 | 200 |
| 23 | Controller `run_agent_on_task` | dock/`/controller` message that makes the tool fire | `[denied] Running agents needs the maintainer role (or project admin) in this project.` (`controller-toolkit.server.ts:1415-1417`); NO audit row (`canRunAgents` is `silentDeny`) | same | same | `[done] Operator run started on <KEY>.` or the specialist equivalent | same |
| 24 | Controller `create_task` / `move_task` / `update_task` / `set_task_owner` | tool call | `[denied] Your project role (viewer) cannot create tasks.` etc. (inner `requireAction` surfaces through `run`, `controller-tool-guards.server.ts:105-113`); denied row with actor label `<email> · via controller` | per the matrix | per the matrix | ok | ok |
| 25 | Controller `create_user` / `list_users` / `update_user` / `inspect_audit_log` (instance scope) | tool call | `[denied] Only org admins can create users. Your org role is member.` (what varies: `list users`, `inspect the audit log`); audit `controller.authority.denied {scope:"instance", what}` (`controller-tool-guards.server.ts:90-99`) | same | same | same | `[done] ...` |
| 26 | `/org/settings`, `/insights`, `/org/settings/audit-export` | GET | thrown 403 Response body `{"error":{"code":"forbidden","message":"This area requires the admin role."}}` (`require-user.server.ts:191-204`); root boundary title `Error 403` | same | same | same | 200 |

Dedupe traps when proving rows 4-22: the denial key is `deny|<userId>|<slug>|<action>` with NO `what`, so two different doors that share an action id (e.g. `approve-transition` from a stage move and from Archive) inside one minute leave ONE row. Space same-action probes more than 60 s apart or accept one row per action per user per minute. The org-admin override key DOES include `what` (`project-authority.server.ts:212`).

### 25.5 Non-member (N) on every door

| Door | Exact request | Expected answer | Proof |
|---|---|---|---|
| Workspace pages `/projects/<slug>`, `/board`, `/tasks/<key>`, `/activity`, `/review`, `/policy`, `/agents`, `/github`, `/settings`, `/controller` | GET | 404, body string `No project at projects/<slug>.` (layout `project.tsx:77,92`; child loaders via `requireProjectMember`, `require-project.server.ts:81-88`); page: title `Page not found`, detail = that sentence, button `Back to home` (`root.tsx:190-230`). Must be byte-identical to a made-up slug. | `project.authority.denied {action:"any-member", memberRole:null, what:"view this project's policy"}` etc. (one row per minute per user per slug for ALL any-member doors, see dedupe) |
| Single-fetch bypass | GET `/projects/<slug>/policy.data?_routes=routes/project.policy` | still 404 with the same body (the F19-28 hole is closed by the per-loader guard) | same |
| Task page actions | POST `/projects/<slug>/tasks/<key>` any intent | thrown 404 `No project at projects/<slug>.` BEFORE the intent switch (`requireVisibleProject`, `project.task.tsx:464`); never a 403 | same |
| Board / settings / policy actions | POST `/projects/<slug>/board` `intent=create-task`; POST `/settings` `intent=invite`; POST `/policy` `intent=set-role` | 404 same body (`project.board.tsx:60`, `project.settings.tsx` action, `project-visibility.server.ts:28-46`) | same |
| Attachment | GET `/projects/<slug>/tasks/<key>/attachments/<file>` | 404 `No project at projects/<slug>.` (`task-attachment.ts:33`; the path names the slug so it is echoed) | denied `{what:"view task attachments"}` |
| Run log | GET `/resources/run-log?runId=<project run id>` | 404 body `Not found.` (bare, the slug is NOT echoed, `require-project.server.ts:70-88`); missing param → 400 `{"error":{"code":<VALIDATION_FAILED>,"message":"runId is required."}}`; unknown id → 404 `{"error":{"code":"not_found","message":"Run <id> not found."}}`; another person's CONTROLLER run → the same JSON 404 (`resources.run-log.ts:80-89`, owner or org admin only) | denied `{what:"view raw run logs"}` |
| Session export | GET `/resources/session-export?run=<id>` | 404 `Not found.` for a project run; `Run not found.` for a foreign controller run (`resources.session-export.ts:41-56`) | denied `{what:"export the provider session"}` |
| Controller dock, GET | GET `/resources/controller?project=<slug>[&task=<key>]` | 200 `{view:{unavailable:true, scope:{contextLine:"Not available here: this project or task is not open to you."}, conversation:null, messages:[], threads:[]}}` (`resources.controller.ts:85-101`, `controller-dock-query.server.ts:215-240`); rendered body (section `aria-label="Controller unavailable here"`): `The controller has nothing to work with here: this project or task is not open to you, or it no longer exists. Everything else on the page still works.` (`controller-dock.tsx:505-511`) | denied `{what:"talk to the controller about this project"}` |
| Controller dock, POST | POST `/resources/controller` `intent=send`, `text`, `project`, `task?`, `conversationId` (`new` for a fresh thread), `surface?`, `_csrf` | 404 `{ok:false, error:"That project or task is not open to you."}` (`:114-119`); a thread id from another scope → 404 `{ok:false, error:"Conversation not found."}` | same |
| Controller tools naming the slug (`get_project`, `list_tasks`, `get_task`, `create_task`, `move_task`, `comment_on_task`, `set_task_owner`, `update_task`, `run_agent_on_task`, `get_github_state`, `update_project_settings`, `update_stages`, `set_transition_boundary`, `invite_member`, `set_member_role`, `deploy_agent`, `update_agent_deployment`) | message in `/controller` (instance scope) that names the project | `[denied] No project "<slug>" is visible to you.` (`controller-tool-guards.server.ts:50,101-110`), identical for a slug that does not exist | denied row per tool `what` (`read this project`, `read this project's tasks`, `read this task`, `create tasks`, `move tasks`, `comment on this task`, `change task ownership`, `edit this task`, `run agents`, `read this project's GitHub state`, `edit this project's stages`, `manage this project's members`; `controller-toolkit.server.ts:911-1667`), collapsed to one per minute |
| Ops MCP `read_run_log` on a project run | controller message | `[denied] No run "<id>" is visible to you.` (`controller-ops-mcp.server.ts:113`) | denied `{what:...}` from its guard |
| Home `/` and `/projects` | GET | the project is absent from every list (members-only lists) | none |
| Dock on the 404 page itself | open `/projects/<slug>` as N, look at the dock | the root Layout renders `ControllerDock` whenever the root loader supplied `csrf` (`root.tsx:169`) and the ErrorBoundary is inside that Layout; the dock derives `project=<slug>` from the workspace match params (`controller-dock-context.ts:81-95`), so expect the `Not available here` panel on the 404 page. Not proven live; see open questions. | as above |

### 25.6 On-disk proof (SQL, read-only)

Run against the app's projection DB (the data root's sqlite; NEVER the container's DB from the host, and never while the app writes to `./data` from a second process). Use the app's own surfaces first (Activity page, Org settings → Audit log, controller `inspect_audit_log` as A) and the SQL as the tiebreaker.

```sql
-- roles as projected from project.md (project_members is a projection of members[]; 0001_baseline.sql:66-71)
SELECT pm.user_id, u.email, u.role AS org_role, pm.role AS project_role, u.pwreset_required, u.disabled
FROM project_members pm JOIN users u ON u.id = pm.user_id
WHERE pm.project_slug = '<slug>' ORDER BY pm.role, u.email;

-- N must be absent above and present here
SELECT id, email, role, pwreset_required FROM users WHERE email LIKE 'probe.%';

-- every denial on the project (audit_events: id, occurred_at, actor_user_id, actor_label, action, subject_kind, subject_id, project_slug, task_key, details_json; 0001_baseline.sql:37-48)
SELECT occurred_at, actor_label, json_extract(details_json,'$.action') AS rbac_action,
       json_extract(details_json,'$.what') AS what, json_extract(details_json,'$.memberRole') AS member_role
FROM audit_events WHERE action = 'project.authority.denied' AND project_slug = '<slug>'
ORDER BY occurred_at DESC;

-- org-admin overrides (should be EMPTY when A is a member; one row per action, any-member collapsed per minute)
SELECT occurred_at, actor_label, details_json FROM audit_events
WHERE action = 'project.org_admin.override' AND project_slug = '<slug>' ORDER BY occurred_at DESC;

-- instance-scope controller denials (rows 25): no project_slug
SELECT occurred_at, actor_label, details_json FROM audit_events
WHERE action = 'controller.authority.denied' ORDER BY occurred_at DESC;

-- the positive rows each role should have left
SELECT occurred_at, actor_label, action, task_key, details_json FROM audit_events
WHERE project_slug = '<slug>' AND action IN (
  'task.comment','task.created','task.metadata.updated','task.goal.updated','task.transition',
  'task.packet.resolved','task.packet.escalated','task.archived','task.unarchived',
  'task.acceptance.forced','github.delivery.manual','runtime.run.started',
  'project.member.invited','project.member.role_changed')
ORDER BY occurred_at DESC;

-- sign-in trail for the minted accounts (userless rows carry the email as actor_label)
SELECT occurred_at, actor_label, action, details_json FROM audit_events
WHERE action IN ('org.user.created','auth.login.success','auth.login.failure','auth.login.rate_limited',
                 'auth.password.forced_reset_completed')
  AND (actor_label LIKE 'probe.%' OR json_extract(details_json,'$.email') LIKE 'probe.%')
ORDER BY occurred_at DESC;
```

Controller-driven writes are audited under the person with `actor_label = '<email> · via controller'` (`actor.server.ts:169-171`); the Activity page renders it as `<name> (via the controller)`, the org Audit log and `inspect_audit_log` keep the raw label (docs auth §5, verified in `controller-tool-guards.server.ts:82`).

### 25.7 Order of play (minimises throttle, dedupe and pollution)

1. As A in the dock (instance scope): `create_user` ×5 (M, C1, C2, V, N; all `role: "member"`). Copy each reply; the temp password appears nowhere else.
2. As A in the project dock: `invite_member` for M, C1, C2, V with explicit `role` (proves C4 one-write seating; check ONE `project.member.invited` row each with the named role). Do NOT invite N.
3. Owner signs each of M, C1, C2, V, N in once (temp password → `Login · set new password` → new password), save storage state per slot. Optional drift probe first: sign the same temp password in twice before the reset (25.2 DRIFT).
4. As A: create the probe task; as C1: `owner-take` (row 5) so C1 is the owner.
5. Run rows 1-22 per role, N last, spacing same-action probes over 60 s or accepting the dedupe.
6. Read the Activity page as V (member read), the org Audit log as A, then the SQL.

### 25.8 Drift and open questions raised by this section

Drift candidates:
- D-25a: "single use" temporary password is not enforced before the reset completes (25.2).
- D-25b: the project Settings invite form (`intent=invite`) has no `role` field, so the UI can only seat viewers; docs auth §3 says invites "join in the seat the inviter names". True through the controller and `inviteMember`, false on the Settings surface, which then needs a second write on Policy (the very cost C4 removed).
- D-25c: the denial dedupe key omits `what`, so one `project.authority.denied` row per minute stands for every any-member door a non-member touched (pages, attachments, run-log, dock); the row's `what` names only the FIRST door. The override key does carry `what`. Docs auth §3 say "repeats collapsed per minute" for the override only.

Open questions (not verified live in this pass):
- Whether `useMatches` inside the root ErrorBoundary still carries the `routes/project` match with `params.slug`, i.e. whether the dock really shows `Not available here` on the 404 page or falls back to instance scope.
- What the root boundary prints for the 403 JSON body of `/org/settings` (`thrownMessage.parse(error.data)` on a parsed object).
- The exact ordering of `[denied]` vs a validation `[error]` when `create_task` is called by V with an empty title (which guard fires first).
- `ERROR_CODES.VALIDATION_FAILED`'s literal string in the run-log 400 body.

---

## Gap fill: Notifications: agent-question kind and the controller-reply claim need one verified table

Method: fresh `grep -rn 'createNotification(|notifyTaskWatchers(|notifyMentionedUsers(|notifyOwnerSeatChange('` over
`app/server` and `app/features`, non-test, on this tree (2026-09-06); every site below was read in context. This
section SUPERSEDES the §13 kind table (which cited `agent-toolkit.server.ts:224` and `operator-actions.server.ts:1207`,
neither of which is a notification call) and resolves the disagreement with `record-verification.md` §10/§16.3 and
`packets-and-recommendations.md` §9.

### 26.1 The four contested claims, resolved

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| (a) | Claude `ask_human` notifies kind `packet` | WRONG. Kind is **`approval`** | `agent-toolkit.server.ts:271-280`: `notifyTaskWatchers(db, {kind: "approval", title: \`${role} asks: ${packet.title}\`, text: packet.body \|\| "An engaged agent needs a human decision."})`. Tool at `:320-372` → `openAgentQuestionPacket` `:202-282`. The packet it writes IS a packet (`type: "input"`, `kind: "Agent question"`, `agent-outcome.server.ts:435,452-470`), but the notification row's `kind` column is `approval`, `ptype` null, no `from` (defaults to Operator, see 26.5) |
| (b) | Codex envelope `question` notifies kind `packet` | WRONG. Kind is **`approval`** | `task-actions.server.ts:3316-3326` inside `recordAgentCompletion` (`:2929-`): `kind: "approval"`, title `\`${roleDisplay} asks: ${question!.title.trim()}\``, text `question!.body ?? "An engaged agent needs a human decision."`. Packet written at `:3210-3230`; held question (packet already open) writes only a `note` `**Question held (a decision is already open):** <title>` (`:3239-3252`) and NO notification |
| (c) | Every controller reply raises a `controller` notification (`controller-run.server.ts:429`) | WRONG. **No notification exists for a controller reply** | `controller-run.server.ts:427-431` is `StartRunInput { role: "Controller", kind: "controller", backend: "claude", projectSlug: "", taskKey: conversation.id }` for `startRun`, i.e. the `agent_runs.kind` value (CHECK `operator\|primary\|reviewer\|controller`, `0001_baseline.sql:533`). `grep -rn 'createNotification\|notifyTaskWatchers\|notifyMentionedUsers' app/server/controller/` → no hits. A reply is `appendMessage` (`controller-conversations.server.ts:383`, INSERT into `controller_messages` with `author = 'controller'`) which calls `publishConversationUpdated` (`:445-458`) → SSE `controller.updated {conversationId, userId}` routed to the conversation owner only. The ONLY writer of notification kind `controller` is `notifyCreator` in `goal-actions.server.ts:621-641` (goal chain progress, recipient `fm.createdBy`) |
| (d) | Who writes `Next step recorded:` | `recordDeliveredNextStep` (`task-actions.server.ts:6133-6225`) | Timeline `note` from `{kind: "system", systemId: "delivery"}` text `Next step recorded: **${label}**. ${detail}` (`:6186`); audit `github.delivery.next_step` (`:6097`, details `{kind: "transition", toStageId, prNumber}`); notification kind **`approval`**, `ptype: "input"`, title `Next step recorded: ${label}`, text = detail, `from: {kind: "system", name: "Delivery"}` (`:6207-6218`). `label` = `Move the task to ${reviewName}` (`:6161`); detail begins `Recorded by Viberr when the delivery landed; this is not the operator agent's judgement. Review pull request #N is open while KEY is still on <stage>, and nothing had proposed a next step. Apply it to move the task to <review>, or dismiss it if the work is not ready for review.` (`:6162-6166`). Fires only when the delivered task sits below the review stage with nothing actionable (`alreadyActionable`, `:6158`) |

Docs status: `docs/domain/controller-and-goals.md:512-513` and `:532-534` already state (c) correctly ("created only for
goal progress", "a controller conversation reply notification describes something never created"). The stale wording
lives in `0001_baseline.sql:258-259`, `app/shared/mapping/notification.server.ts:22-23` ("a controller conversation
reply, or chained-goal progress"), `notification-prefs.ts:22` and the profile copy `Replies from the controller and
progress on goal chains you defined.` (`notification-prefs.ts:116`). The profile toggle therefore promises a delivery
that never happens.

### 26.2 Every producer, from the grep (non-test)

Legend: W = watchers (`notifyTaskWatchers`: project admins + maintainers + task owner, minus `exceptUserId(s)`,
`task-mutation.server.ts:260-322`; default `from` = `OPERATOR_NOTIFY_FROM` `{kind: "agent", name: "Operator"}` `:138`);
M = unambiguously @mentioned MEMBERS of the project (`fanOutMentions`, `mention-notify.server.ts:388-414`); S = one seat
holder (`notifyOwnerSeatChange`, `task-mutation.server.ts:218-256`, never the actor); D = direct `createNotification`.

| Site | Kind | ptype | Title | Text | from | To |
|---|---|---|---|---|---|---|
| `operator-actions.server.ts:1268-1283` `operatorOpenPacket` | `packet` | `input`/`blocked` = `packetType` | `Decision needed: <title>` / `Blocked, decision needed: <title>` | `packet.body \|\| title` | Operator | W |
| `task-actions.server.ts:7925-7940` `requestPacketMaintainerDecision` (route intent `request-maintainer-decision`, `project.task.tsx:632`) | `packet` | `blocked` if packet.type blocked else `input` | `Decision needs a maintainer: <packet.title>` | `<ownerLabel> owns KEY but every option on this decision ("<title>") needs maintainer authority, so they asked a maintainer or admin to make the call.` + quoted note | human asker | W minus asker; audit `task.packet.escalated {packetKind, notified}` |
| `task-actions.server.ts:3875-3900` failed-run stuck-loop escalation → `openStuckLoopPacket` (`:2525`) → `operatorOpenPacket` | `packet` | `blocked` | `Blocked, decision needed: Work stalled: pick a recovery path` (`:2596`) | `<reason> <remedy> Coordination is paused until a human chooses how to proceed.` | Operator | W (ids returned as `escalation.notifiedUserIds`) |
| `operator-actions.server.ts:911-923` new operator recommendation (`wasNew` only) | `approval` | `input` | `Operator recommends: <rec.label>` | reasoning | Operator | W |
| `agent-toolkit.server.ts:271-280` Claude `ask_human` | `approval` | null | `<Role> asks: <title>` (`role` = `agentRoleDisplay(actorRef)` = `roleHint ?? slugToRole(profileId)`, `actor-ref.server.ts:57-62`; `"Agent"` for non-agent refs) | `packet.body \|\| "An engaged agent needs a human decision."` | Operator (defaulted) | W |
| `task-actions.server.ts:3316-3326` Codex envelope `question` | `approval` | null | `<roleDisplay> asks: <title>` (`roleDisplay` `:3002-3003`) | `question.body ?? "An engaged agent needs a human decision."` | Operator (defaulted) | W |
| `task-actions.server.ts:6207-6218` `recordDeliveredNextStep` | `approval` | `input` | `Next step recorded: Move the task to <review stage>` | detail (26.1 d) | `{system, "Delivery"}` | W |
| `task-actions.server.ts:1279-1292` human `addComment` | `mention` | null | null | `mentioned you — “<clip 240>”` (`mention-notify.server.ts:67-72,404`) | human `{kind: "human", userId, name, initials, tone}` | M minus author (`excludeUserId`) |
| `task-actions.server.ts:2362-2374` `postAgentReplyComment` (interrupted/errored reply) | `mention` | | | same | agent (own name via `agentNamesByProfile`) | M (no author exclusion) |
| `task-actions.server.ts:2978-2988` deduped reply: only handles ADDED over the duplicated comment (`skipUserIds`) | `mention` | | | same | agent | M minus already-pinged |
| `task-actions.server.ts:3263-3274` finished agent reply (`postsReplyEvent`) | `mention` | | | same | agent | M |
| `task-actions.server.ts:4308-4314` operator dispatch directive comment | `mention` | | | same | Operator | M |
| `operator-actions.server.ts:735-741` operator comment/recommend text; `:898-903` recommendation reasoning | `mention` | | | same | Operator | M |
| `agent-toolkit.server.ts:171-178` `postAgentComment` (Claude `post_comment` AND controller `comment_on_task`, `controller-toolkit.server.ts:1195-1203` with `actorRef {kind: "controller"}` and trailer `_Posted by the controller for <name>._`) | `mention` | | | same | agent / controller render | M, NO exclusion: a controller comment that tags the asker notifies the asker about their own words |
| `task-actions.server.ts:3347-3350` verdict recorded | `quality` | null | `Changes requested` / `Approval noted` / `Review passed` / `Approval noted, rework still needed` (`:3123-3147`) | summary sentence, e.g. `<Role> approved the work on revision <sha>.` | Operator (defaulted) | W; audit `task.quality.flagged` |
| `task-actions.server.ts:3996-4013` failed run notice (T13 dedupe) | `quality` | null | null | classified (`quota`/`auth`/`overloaded`): `<input.role> run failed. <described.reason>`; else `<input.role> run failed: <reason>.` (`input.role` = the engagement role string, `applyAgentCompletionEffects` `:3449-3461`) | Operator | W minus `escalation.notifiedUserIds` when the packet row landed (`:4010-4012`) |
| `operator-actions.server.ts:2120-2131` context conflict | `quality` | null | `Knowledge base disagrees with the repository` (`:1384-1385`) | event text | Operator | W; audit `task.operator.context_conflict` |
| `scope-flag.server.ts:138-147` new scope violation | `policy` | null | null | `input.detail` | `{system, "Policy engine"}` | W |
| `github-reconciler.server.ts:881-895` PR adoption | `policy` | null | `PR #N adopted for KEY` / `PR #N adopted for KEY: replaces PR #M` | `prAdoptionText` | Policy engine | W |
| `github-reconciler.server.ts:912-930` divergence | `policy` | null | `PR #N merged on GitHub: accept KEY` / `PR #N closed on GitHub: KEY needs a decision` / `Accepted PR #N closed on GitHub: KEY's merge can't complete` / `PR #N live again on GitHub: KEY resumes` | divergence text | Policy engine | W (skipped under `ctx.suppressDivergenceNotice`) |
| `reconcile-poller.server.ts:90-110` accepted-but-open nudge (deduped by identical title per task) | `policy` | null | `PR #N accepted: merge to finish KEY` | `KEY was accepted into Done, but PR #N is still open on GitHub. Merge it to finish delivery. (…)` | Policy engine | W |
| `reconcile-poller.server.ts:160-178` `noteReconcileFailure` after 3 consecutive failures, id `ntf_ghsync_<slug>_<userId>` | `policy` | null | `GitHub sync is failing for this project` | `Viberr has been unable to reach GitHub for this project's repository across N checks. …` | Policy engine | D: project admins + maintainers, `projectSlug` only (no task, so href = board) |
| `task-actions.server.ts:6081-6085` `surfaceDeliveryEvent` | `policy` | null | one of `Review reached with no PR yet`, `Delivery withheld by policy`, `Delivery push conflicted`, `Delivery push refused: workflow scope`, `Delivery push failed`, `Delivery blocked by a branch collision`, `Review has no PR`, `Review PR could not be opened` (`:5148,5385,5402,5442,5458,5817,5839,5888`) | one-sentence summary (timeline gets the fenced git detail, `:6062-6066`) | Operator (defaulted) | W |
| `goal-actions.server.ts:629-637` `notifyCreator` | `controller` | null | `<goalId> · <goal title>` | `Link N started as KEY.` (`:762-768`, taskKey set) / `Link N failed. The chain is paused for your decision: retry it, skip it, or cancel the goal.` (`:866-869`) / `Goal completed: every link is settled.` (`:923`) / `The chain could not advance: you no longer hold task creation in this project. Ask a project admin to restore it, then resume the goal.` (`:943-947`) / `The chain could not advance: creating the next link's task failed. Resume the goal to retry.` (`:978-983`) / `A link retry could not start its task. Resume or redirect the goal to try again.` (`:593-598`) | `{kind: "agent", name: "Controller"}` | D: `fm.createdBy` only |
| `dependencies.server.ts:404-407` `announceRelease` | `dependency` | null | `KEY can move again` | `Released: everything this task waited on is done (<list>). The task can move again; the base branch has changed since the hold, so the work re-reads it before continuing.` or `Released: <who> cleared the wait on <list>. …` (`:380-382`) | Operator (defaulted) | W; audit `task.dependencies.released` |
| `dependencies.server.ts:590-593` dead wait | `dependency` | null | `KEY waits on archived work` | `<X> can never complete. This task stays held; edit what it waits on (remove the entry or point it elsewhere) to release it.` | Operator (defaulted) | W; timeline note title `Waiting on work that cannot complete` (`:529`) |
| `task-mutation.server.ts:231-243` via `task-actions.server.ts:722` (create with named owner), `:4504` (`setOwner` hand-off, recipient = new owner), `:4513` (displaced owner on takeover), `:4612` (`releaseOwner`, admin release) | `ownership` | null | `<actor> handed you KEY` / `<actor> created KEY with you as owner` / `<actor> took over KEY` / `<actor> released you from KEY` (`:180-205`) | `You own KEY now. The owner is this task's human reviewer and acceptance authority, and every agent run on it uses the owner's own Claude and Codex accounts.` etc. | human actor | S; audit details `notified` / `notifiedDisplaced` = `{userId}` or `{skipped: "silenced"\|"failed"}`; self acts notify nobody |

Not producers (checked): `operator-actions.server.ts:1207` (inside the packet write), `agent-toolkit.server.ts:224`
(inside `updateTaskFile` of the question packet), `controller-run.server.ts:429` (run row kind), every
`controller_messages` write (`controller-run.server.ts:233,252,281,577,616,710,742`).

### 26.3 Kind → profile category (verified `notification-prefs.ts:16-75`, gate `notifications.server.ts:54-66`)

| kind | category id | Profile label (`PROFILE_NTF`, `:83-129`) | Copy |
|---|---|---|---|
| `packet` | `packets` | Decision packets for you | Blocked decisions and completion reports waiting on your acceptance. |
| `approval` | `approvals` | Approval requests | Operator transition requests at boundaries you can approve. |
| `mention` | `mentions` | Mentions & replies | Comments addressed to you in task timelines. |
| `policy` | `policy` | Policy events | Violations and blocked agent actions on tasks you can see. |
| `quality` | `quality` | Quality flags | Specialist flags on tasks where you own review or acceptance. |
| `controller` | `controller` | Controller updates | Replies from the controller and progress on goal chains you defined. |
| `dependency` | `dependencies` | Dependency releases | A task you own or supervise was released from the work it waited on, or that work can no longer complete. |
| `ownership` | `ownership` | Ownership changes | A task's owner seat was handed to you or taken from you; the owner's accounts run its agents and accept its completion. |

- Storage: `user_prefs (user_id, key='notifs', value_json)` (`profile-query.server.ts:54`, `0001_baseline.sql:278-284`);
  missing/invalid JSON = every category ON (`mergeNotifPrefs`, `notification-prefs.ts:176-179`).
- Toggle: `POST /profile` intent `set-notif`, fields `category=<id>`, `on=1|0` (`profile.tsx:112-119`);
  unknown id → `Unknown notification category.` (`profile-actions.server.ts:98-100`).
- Gate: `isNotifKindEnabled` (`profile-query.server.ts:257-263`) consulted inside `createNotification`; OFF → returns
  null, NO row, no SSE. A prefs read error delivers anyway (`:60-64`). `bypassPrefs` is seed-only.
- Copy mismatch worth watching: `approvals` says "Operator transition requests" but the category also carries every
  agent question (`<Role> asks: …`) and the delivery next-step card; a person who silences "Approval requests" to
  quiet the operator also silences agents asking them questions. `packets` says "completion reports" but no writer
  emits a completion-report notification (only `Decision needed` / `Blocked, decision needed` / `Decision needs a
  maintainer`).

### 26.4 Where a row surfaces

- Row insert emits `emitProjectionEvent({type: "notification.created", userId, occurredAt})`
  (`notifications.server.ts:89-93`) → `event-publisher.server.ts:115-127` → SSE frame routed ONLY to that user's
  `scope=user` connections: `id: <n>\nevent: notification.created\ndata: {"type":"notification.created","entityId":"<userId>","occurredAt":"…","data":{"userId":"<userId>"}}\n\n`
  (`sse-broker.server.ts:180`, schema `sse-event.schema.ts:108-113`). Mark-read emits `notification.read` the same
  way (`notifications.server.ts:301`). Endpoint `GET /resources/events?scope=user` (`resources.events.ts:22-30`).
- `listNotifications` (`notifications.server.ts:185-240`) is read by `/notifications` (limit 201), the project layout,
  palette shell and Home (limit 100). `waitingOnYou` = kind `packet`/`approval` AND the task is in
  `indexDecisionInbox(userId).waitingOnYou` (`:156-181` → `decisionsRequiring`, `decisions.server.ts:84-`): any open
  packet OR pending recommendation on a non-archived task the viewer may govern (maintainer+ or task owner; the org-admin
  override bucket is excluded). So an agent-question `approval` row DOES land in "Waiting on you" for the owner or a
  maintainer (the task carries a packet), and the `mapNotificationRow` `liveWaitingOnYou` branch that checks
  `recommendation_count` for `approval` (`notification.server.ts:101-114`) is overwritten at `:230-236` and has no other
  caller.
- Pill on a "Waiting on you" card: `approval` → `approval`; `packet` → `decision required` / `blocked decision`
  (`notification-meta.ts:78-100`). Icon: packet `hand`/`alert`, approval `arrow`, mention `message`, quality `flag`,
  controller `cpu`, dependency `lock`, ownership `user`, policy `alert` (`:24-49`).
- href: project+task → task page; project only → board; neither → not clickable; project deleted → `targetMissing`
  (`:100-109`, `:227-236`). Bell count excludes rows whose project is gone (`countUnreadNotifications`, `:276-`).
- Opening a task marks every unread row of that viewer for that task read (`markTaskNotificationsSeen`, §13).

### 26.5 Probe recipe per kind (R5 = `record-verification.md` R5 query; run as the recipient)

Pre-step for every probe: recipient's profile has the category ON (default); recipient is a project admin/maintainer or
the task owner (W kinds), and holds an open `scope=user` SSE stream if you want to see the frame (DevTools → Network →
`resources/events` → EventStream; expect `event: notification.created`).

```js
// R5 (record-verification.md:461): notifications for a user by email
show(q(`SELECT n.occurred_at, n.kind, n.ptype, n.title, substr(n.text,1,160) AS text,
  n.project_slug, n.task_key, n.read_at, json_extract(n.actor_json,'$.name') AS from_name
  FROM notifications n JOIN users u ON u.id = n.user_id
  WHERE u.email = ? ORDER BY n.occurred_at DESC LIMIT 50`, "you@example.com"));
```

| Kind | Trigger | Expect (R5 row) | Expect (UI) |
|---|---|---|---|
| `packet` | Give the operator a goal it must scope (or let a run fail: quota/auth/turn cap) | `kind=packet ptype=input\|blocked title='Decision needed: …'` or `'Blocked, decision needed: Work stalled: pick a recovery path'`, `from_name=Operator` | "Waiting on you" card, pill `decision required`/`blocked decision` |
| `packet` (escalation) | As a contributor-OWNER open the task with a packet whose options all need maintainer tier; submit `request-maintainer-decision` with a note | `title='Decision needs a maintainer: <title>'`, `from_name=<owner>`; owner has NO row; audit `task.packet.escalated {notified: N}` | maintainers see the card; owner sees the note on the timeline |
| `approval` (agent question, Claude) | Deploy a Claude deliverer with `ask-human` granted (`collab.ask` = `effectiveCollabMode(grants,"ask-human") === "direct"`, `agent-outcome.server.ts:412`); goal with a real fork ("choose Go or Rust for the k9s clone; ask before starting") | `kind=approval ptype=NULL title='<Role> asks: <question>' from_name=Operator`; packet on task `kind='Agent question'`; audit `task.agent.packet_opened {title, actorRef}`; timeline `blocked` `**Question for a human:** <q>` | card in "Waiting on you" with pill `approval` (not `decision required`); the `from` chip says Operator although the agent asked |
| `approval` (agent question, Codex) | Same with a Codex profile: the envelope `question {title, body, options}` | same row shape; if a packet is already open: NO row, timeline note `**Question held (a decision is already open):** <q>` | |
| `approval` (recommendation) | Let the operator recommend (or drive a task into the review stage with a PR) | `title='Operator recommends: <label>' ptype=input` | |
| `approval` (next step) | Deliver a task while it is still below the review stage with nothing actionable | `title='Next step recorded: Move the task to <review>' ptype=input from_name=Delivery`; audit `github.delivery.next_step` | |
| `mention` | Comment `@<recipient name>` as another member; or have the controller `comment_on_task` a text tagging the asker | `kind=mention text='mentioned you — “…”'`; author of a HUMAN comment never gets one; the controller-posted comment DOES notify the asker if it tags them | "Everything else" stream |
| `quality` | Reviewer verdict; or a failed run | `title='Review passed'\|'Changes requested'…` / title NULL text `'<role> run failed. …'` | |
| `policy` | Agent writes outside scope; or close/merge the review PR on GitHub and wait for the 5-min reconcile; or deliver with a token lacking `workflow` scope | title per 26.2 row, `from_name='Policy engine'` (reconciler/scope) or Operator (delivery surface) | row links to the task |
| `controller` | Create a goal chain via the dock (`create_goal`) as user X; let link 1 start | `kind=controller title='<goalId> · <title>' text='Link 1 started as KEY.' from_name=Controller`, user X only | icon `cpu` |
| `controller` (negative) | Send any dock message; wait for the reply | NO new row for the reply; `controller_messages` gains an `author='controller'` row; SSE `controller.updated` only | the dock updates without a bell change |
| `dependency` | Task B `blockedBy: [A]`; move A to Done (or clear B's list by hand) | `kind=dependency title='B can move again' text='Released: …'`; audit `task.dependencies.released` | |
| `dependency` (dead) | Archive A while B waits on it | `title='B waits on archived work'` | |
| `ownership` | `owner-assign` a task to someone else; take a seat someone holds; admin `owner-release` | recipient row `title='<actor> handed you KEY'` / displaced `'<actor> took over KEY'` / `'<actor> released you from KEY'`; audit `task.ownership.handed_off\|taken\|admin_released {notified, notifiedDisplaced}` | self-take / self-release: no row |

Silencing proof: on `/profile` turn a category off, repeat its trigger, expect NO row (R5) and no SSE frame; the
`ownership` audit row then reads `notified: {skipped: "silenced"}` (only that kind reports it).

### 26.6 Drift candidates raised by this section

- D-26a: the `controller` kind's own comments, the migration comment (`0001_baseline.sql:258-259`), the mapping
  comment (`notification.server.ts:22-23`) and the PROFILE copy `Replies from the controller and progress on goal chains
  you defined.` promise a controller-reply notification that no code path writes. Docs `controller-and-goals.md:532-534`
  already record it; the profile toggle still lies to the person reading it.
- D-26b: agent questions (both backends) notify kind `approval` while their packet is a `packet` on the task. Effects:
  the card's pill reads `approval` (vs `decision required` for an operator packet of the same type), the routing toggle
  that silences them is "Approval requests · Operator transition requests", and the `packets` toggle copy ("Decision
  packets for you") does not cover them. `packets-and-recommendations.md` §9 and `record-verification.md` §10 (`packet`
  via `agent-toolkit:224`) are wrong; §13 above listed it under BOTH kinds.
- D-26c: both agent-question notifications omit `from`, so the row's actor chip is `Operator` (`OPERATOR_NOTIFY_FROM`
  default, `task-mutation.server.ts:313`) while the title says `<Role> asks:`; the packet on the task page names the
  agent. Same defaulting puts "Operator" on verdict rows (`:3347`), delivery surface rows (`:6081`) and dependency rows
  (`:404,:590`), none of which the operator wrote.
- D-26d: Codex path text uses `question.body ?? …` (`:3324`): a present-but-empty body yields an empty notification text;
  the Claude path uses `||` (`agent-toolkit.server.ts:278`). Minor, backend-asymmetric.
- D-26e: `postAgentComment` passes no `excludeUserId` (`agent-toolkit.server.ts:171-178`), so a controller
  `comment_on_task` that tags the asking human notifies the asker about the comment posted on their own behalf.
- D-26f: `packets` category copy says "completion reports waiting on your acceptance"; no writer emits a
  completion-report notification (acceptance offers are recommendations → `approval`, ruling 137), and the
  `notification-meta.ts:88-97` comment records the same historical mislabel being removed from the pill.
- D-26g: the `task.packet.escalated` row for a maintainer escalation is kind `packet` but its `ptype` follows the
  underlying packet, so a blocked packet escalated by its owner renders the `blocked decision` pill on the maintainer's
  card although the maintainer is not blocked by a runtime failure. Cosmetic; note only.

### 26.7 Open questions (not verified live)

- Whether `agentRoleDisplay` yields the profile's display role (e.g. `Developer`) or the slug-derived role for a
  deployed profile without `roleHint`, i.e. the exact `<Role> asks:` prefix an observer will see.
- Whether the "Waiting on you" panel de-duplicates an agent-question `approval` row against an earlier `packet` row
  for the same task (helpers say one card per task, `notifications-page-helpers.ts:38-46`; which row wins was not read).
- Whether the profile page renders the category toggle order exactly as `PROFILE_NTF` (assumed).
- Whether `input.role` in the failed-run notice is the profile role name or the engagement role word (`delivering` /
  `reviewing`); the type is `string` (`task-actions.server.ts:3457`) and the value was not traced to its writer.

---

## Gap fill: Attachments without a browser: how an agent files evidence, the evidence tool, and the browser MCP proof

Extends §14. Everything below was read from code on `pass35/k9s-clone-observation` (2026-09-06); docs line
refs quoted from `docs/architecture/decisions.md` rulings 75(d), 96, 105, 109. Three separate mechanisms
share the word "evidence"; keep them apart:

| Mechanism | What it is | Produces a file? | Gate |
|---|---|---|---|
| Attachments drop | a plain directory the run may write; whatever lands there during the run is stamped on the run's timeline event | yes (the agent copies/writes files) | `attach-evidence-references` effective `direct` AND real backend |
| `report_outcome.evidence` (Claude) / envelope `evidence` (Codex) | up to 8 REFERENCE rows `{label, add, del}` rendered on the outcome event; never a file | no | same grant (field declared only when held) |
| Browser MCP `--output-dir` | Playwright MCP writes default-named screenshots/PDFs/snapshots/console dumps into the same directory | yes (tool side effect) | `use-browser` explicit `direct` + effective `use-web-search-fetch` `direct` + package + executable |

### G1. The grant and who holds it

- Catalog row: `cap("attach-evidence-references", "Attach evidence references", ["agent"], "Collaboration")`,
  verified `app/shared/capabilities.ts:140`; `cap()` default args are `defaultMode = "direct"`, `promotable = true`
  (`:24-31`), so the catalog default is ON. Enforcement scope "both" (id in `ENFORCED_CAPABILITY_IDS`, `:246-248`).
- Runtime gate: `collab.evidence = effectiveCollabMode(grants, "attach-evidence-references") === "direct"`
  (`app/server/tasks/agent-outcome.server.ts:415-416`). An ABSENT grant (or a `recommend` one) falls to the
  catalog default `direct` (`:381-402`); an explicit `off`/`human` withholds.
- The one exception: a deployment whose grant list is EMPTY runs fully withheld, evidence included
  (`deploymentGrants` `specialist-run.server.ts:258-268` -> `withheldAgentGrants()` `app/features/agents/capability-catalog.ts:89-94`).
- Seeded profiles (`app/server/seed/agent-catalog.server.ts`): **Developer** `:161` grants the browser pair
  ("Drive a live web browser", "Search & fetch from the web") and does NOT name "Attach evidence references",
  so on the seed it holds evidence by catalog default (`direct`). **Reviewer** `:187` names "Attach evidence
  references" explicitly and has NO browser grant. So on the k9s pass: the Developer is the browser + drop
  agent, the Reviewer is the drop-only (no browser) agent.

### G2. What the evidence grant does at run start (`collab.evidence && realBackend`)

All four sites verified in `app/server/tasks/specialist-run.server.ts`:

1. `mkdirSync(attachmentsDir, { recursive: true })` before the process spawns (`:1745-1747`), so a plain
   `cp` can never fail on a missing path. `attachmentsDir = taskAttachmentsDir(slug, key, dataRoot)` =
   `<dataRoot>/projects/<slug>/tasks/<KEY>/attachments` (`app/server/files/file-store-root.server.ts:95-100`).
2. Persona section "Posting files on the task thread" (`:1774-1776` builds it, `:2500-2502` appends it,
   text in `app/server/tasks/specialist-browser-mcp.server.ts:231-245`). Emitted for ANY evidence-granted
   profile on BOTH backends (Codex receives the persona as `developer_instructions`,
   `codex-runtime.server.ts:379`). Exact text (with `<REL>` substituted):

   > To put a file in front of the humans on this task, copy it into `<REL>` (a real directory reachable from
   > your working directory) during your run. Every file that appears there is posted on your reply on the task
   > page, and images render inline. Cite the exact filename in your reply and evidence references. Use it for
   > things humans need to SEE — screenshots, captures, small reports; code and large artifacts belong in the
   > repository and the pull request, not here. The browser tool's own machine-stamped working files
   > (page-….yml snapshots, console-….log dumps) are cleaned up after your run UNLESS you cite the exact
   > filename — cite one only when a human genuinely needs to read it.

3. Workspace-contract exception line inside "## Workspace contract (follow exactly)" (`:1835-1839`,
   `:2634-2639`), only when a repo is attached:

   > - One deliberate exception: you may COPY files INTO the task's attachments folder, `<REL>` — that is how a
   > file is posted on the task thread (see "Posting files on the task thread"). Everything else outside the
   > working directory stays off-limits.

4. Codex sandbox widening: `runInput.attachmentsWritableDir = attachmentsDir` (`:2041-2043`) ->
   `threadOptions.additionalDirectories = [dir]` when the sandbox is `workspace-write`
   (`app/server/runtimes/codex-runtime.server.ts:864-866`). Re-armed on resume (`:3141-3147`, `:3178`;
   `run-service.server.ts:1376-1377`; `task-actions.server.ts:1846-1847`).

**What `<REL>` actually is (candidate finding).** `<REL> = storeRelativePath(attachmentsDir, dataRoot)`
(`:1770`, `:1836`), i.e. relative to the DATA ROOT: `projects/<slug>/tasks/<KEY>/attachments`
(`file-store-root.server.ts:207-210`). It is neither absolute nor cwd-relative. The child cwd is
`<taskDir>/workspace/<repoName>` for the delivering engagement and
`<taskDir>/workspace/support/<profileId>/<repoName>` for a supporting one (`:1676-1685`, `:2862-2867`,
`:2905-2913`), so the path that RESOLVES from cwd is `../../attachments` (deliverer) or
`../../../../attachments` (supporter). The prompt calls it "a real directory reachable from your working
directory" while handing a path that does not resolve from there; `app/ui/markdown.tsx:150-156` records that
live agents wrote `../../attachments/page-….png` (they inferred it). Observe: does the k9s Developer find the
directory on its first attempt, or does it `find` / `ls ..` around, create `projects/…` INSIDE the repo
checkout (which would then ride `git add -A` into the PR), or refuse?

### G3. The reference channel (`report_outcome` / envelope `evidence`)

Claude (`app/server/tasks/agent-toolkit.server.ts`):
- `report_outcome` mounts when `collab.verdict || collab.evidence` (`:385`). Field set per grant pair
  (`:454-481`): verdict+evidence -> `{summary?, verdict, evidence?}`; verdict only -> `{summary?, verdict}`;
  evidence only -> `{summary?, evidence?}` with description `REPORT_EVIDENCE_ONLY_DESCRIPTION` (`:95-96`):
  "Report your structured OUTCOME for this task: the evidence REFERENCES for what you checked or produced, plus
  a one-paragraph summary. Call it exactly once, at the END of your work, right before your final report. It
  is recorded together with your final report when you finish. You do NOT judge the work — this task's verdict
  is someone else's."
- `evidence` items: `label` ("What this cites: a suite, a file, a check — e.g. 'unit/policy_gate_test' or
  'app/server/tasks/task-actions.server.ts'."), `add?` ("Short signed count, e.g. '+14' or '3 passed'."),
  `del?` ("Short signed count, e.g. '−4' or '0 failed'."); array description "Up to 8 evidence REFERENCES for
  what you checked or produced — short citations, never raw output (that stays in the run logs). They render
  as rows on your outcome event and carry into the review PR body." (`:406-428`).
- Return text: `[staged] <Verdict 'x'>[ with ]<N evidence reference(s)> will be recorded with your final
  report. Finish with your full findings.` (`:439-445`); staged via `stageOutcome` into the `staged_outcomes`
  table keyed by `agent_runs.outcome_key` (`agent-outcome.server.ts:249-307`).
- Prompt lines under `## Collaboration` (`specialist-run.server.ts:1907-1921`): with verdict, "`report_outcome`
  — REQUIRED at the end of your review: report `approve` or `request_changes` … plus `evidence` — short
  REFERENCES …"; evidence-only, "`report_outcome` — at the end of your work, report `evidence`: … You do NOT
  judge the work; there is no verdict on this tool for you."

Codex (`agent-outcome.server.ts:68-100`, `specialist-run.server.ts:1923-1945`, `:1986-1994`):
- The outcome envelope `outputSchema` mounts when `collab.verdict || collab.ask || collab.evidence`;
  `required: ["summary", "verdict", "question", "evidence"]`, `evidence: array|null` of
  `{label: string, add: string|null, del: string|null}`. Prompt line: `- Your FINAL message must be the
  structured outcome JSON: {"summary": "<your full report, markdown>"[, "verdict": …][, "question": …],
  "evidence": [{"label", "add", "del"}] (short REFERENCES to what you checked — a suite, a file, a check —
  never raw output)}.` Envelope `evidence` is read through `normalizeEvidenceRows` (`:230-235`).
- Consequence for the k9s Developer on Codex: it holds evidence by default, so its FINAL reply is
  schema-constrained JSON even though it has no verdict and no ask. Observe whether the summary degrades
  to a stub.

Normalisation, both backends (`app/schemas/task-file.schema.ts:1743-1801`): max 8 rows
(`EVIDENCE_MAX_ROWS`), label 200 chars, count cells 16 chars, newlines flattened, ` · ` stripped from counts,
empty count -> `—` (`EVIDENCE_EMPTY_COLUMN`); serialised as one line each `- <label> · <add> · <del>` under
`evidence:`. Completion merges `[...agentRows (only if collab.evidence), ...deliveredWorkEvidence(fm)]`
(`task-actions.server.ts:3748-3765`); a withheld grant silently drops the agent's rows and keeps the
server-derived delivery rows.

Where rows land (one event only, `task-actions.server.ts:3160-3206`): on the `quality` verdict event when
there is a verdict; else on the reply `comment`; else, when the reply was suppressed (guardrail or duplicate),
on a producing `note` whose text is "Recorded this run's evidence." (or the Saved-N-files sentence when files
exist). Rows render on the event; label tokens that name a REAL attachment become links to the serving route
(`app/features/task-detail/timeline.tsx:128-133`). Rows never create files and never appear in
`attachments/`.

### G4. Collection at run end (`applyAgentCompletionEffects`, `task-actions.server.ts`)

1. Window: `attachmentNamesSince(slug, key, run.started_at)` = every regular non-dotfile in `attachments/`
   whose mtime >= `agent_runs.started_at`, newest first, UNCAPPED (`:3497-3512`;
   `task-attachments.server.ts:108-138`). No `started_at` -> nothing claimed. It is an mtime window, not a
   writer log: a file YOU copy in while the run is live is attributed to the agent; a file the agent copies
   with `cp -p` (mtime preserved, older than run start) is never claimed: it sits in the panel with no
   "added by" line and rides no event.
2. Prune only when `finished.state === "finished" && siblingLiveRuns === 0` (`:3669-3677`); siblings =
   other `agent_runs` rows on the task in `('queued','running')` (`:3644-3652`). `citationCorpus` = reply
   text + full reply text + `JSON.stringify(evidence)` + question title/body + every timeline `text` since run
   start (`:3657-3667`). `pruneBrowserWorkingArtifacts` unlinks names matching
   `/^[a-z][a-z0-9_]*-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\./` that are NOT `.png/.jpg/.jpeg/.webp/.gif/.pdf`
   and are not a substring of the corpus (`task-attachments.server.ts:146-208`); ENOENT counts as pruned,
   any other unlink error keeps the name listed. Log lines only (no audit row): `pruned uncited browser
   working artifacts` and `browser working-artifact prune skipped — sibling run live` (`:3679-3691`).
   **Candidate finding**: with a sibling live the prune is skipped and the sibling later prunes only ITS
   window (files with mtime >= its own start), so working artifacts written before the sibling started are
   never pruned by anyone (comment `:3638-3641` calls this by design).
3. Kept names -> `sanitizeEventAttachmentNames`: max 20 (`EVENT_ATTACHMENTS_MAX`), 200 chars, no `/` `\` or
   control chars, trimmed-equal, deduped (`task-file.schema.ts:1803-1840`). A run that keeps > 20 files lists
   only 20 on its event; the panel still lists the directory.
4. Stamping (`attachments:` block on ONE event): finished run -> `recordAgentCompletion(..., attachments)`
   (`:3757-3765`): verdict `quality` event if verdict, else the reply, else the producing `note`
   "Saved 1 file to this task's attachments during the run." / "Saved N files to this task's attachments
   during the run." (`:3177-3191`). Non-finished run (`error`, `interrupted`) ->
   `postAgentReplyComment(..., attachments)` (`:3834-3841`) with the same note fallback (`:2300-2313`);
   NO prune ran, so working artifacts of an interrupted run stay forever.
5. Projection: `task_events.attachments_json` (`app/shared/mapping/task-event.server.ts:26,78-79`);
   `attachmentProducers` reads the newest claiming event per name for the panel's "added by <actor> · <time>"
   (`app/server/projections/task-query.server.ts:161-190`). Audit: `task.agent.replied` (`:2216`) covers the
   reply; there is no attachment-specific audit action.

### G5. Browser MCP proof (`app/server/tasks/specialist-browser-mcp.server.ts`)

- Name `BROWSER_MCP_NAME = "viberr_browser"` (`:51`). Mount order in `resolveBrowserMcp` (`:148-213`):
  `use-browser` not explicit `direct` -> nothing (no refusal); egress not effective `direct` -> refused
  "the profile grants a browser but withholds web egress (use-web-search-fetch) — the browser is not mounted;
  grant egress or withhold the browser"; no `@playwright/mcp` cli -> "the @playwright/mcp package is not
  installed in this deployment"; `VIBERR_BROWSER_EXECUTABLE` set but absent -> "the pinned browser executable
  (VIBERR_BROWSER_EXECUTABLE=<path>) is not on disk — chromium is not installed in this deployment; the browser
  is not mounted (rebuild the image or install chromium)". Refusal name is `viberr_browser (use-browser)`.
- Args: `node <cli.js> --headless --isolated --output-dir <attachmentsDir> [--image-responses omit (codex)]
  [--executable-path <exe> --no-sandbox]` (`:197-212`); no `env`, no `cwd` in the stdio config.
- Merge precedence org < browser < toolkit (`specialist-run.server.ts:1982-1985`); `mountedMcps =
  Object.keys(mergedMcpServers)` (`:2074`).
- **Proof on the run console**: the first `meta` line tagged `run·inputs` (`RUN_INPUTS_TAG`,
  `app/features/runtime/runtime-types.ts:194`; written by `recordRunInputs` `:637-700` into `run_log_lines`
  and the raw `.jsonl` as `{"type":"run_inputs","source":"viberr",...}`). Expanded rows
  (`app/features/runtime/runs-helpers.ts:155-275`): `workspace` = `<cwd> · checkout of <repo>`;
  `mcp` = `mounted: viberr_browser, viberr_agent` (Claude) or `mounted: viberr_browser` (Codex) or
  `mounted: none`; a refused browser rides `unresolvedResources` (`specialist-run.server.ts:1794`) and shows
  on the `missing` row as `granted, but their content never reached this run: viberr_browser (use-browser)
  (<reason>)`; `tools` = `viberr tools: post_comment, ask_human, report_outcome` + denied list; `sandbox`
  (Codex only) = `<mode>` or `<mode> · repo-write is withheld but evidence is granted, and Codex's sandbox
  cannot express read-only-except-attachments — so on Codex this run keeps workspace-write and the withholding
  is advisory; the server-owned delivery gate is the real boundary` (`specialist-tool-policy.ts:213`). Summary
  line: `Run inputs — delivering engagement · … · N MCP server(s) · …`.
  **Candidate finding**: `resolvedResourceInputs` lists `report_outcome` only when `toolkit.verdict`
  (`specialist-run.server.ts:540-546`) and never lists `github_read`; a Claude evidence-only profile (the
  seeded Developer) mounts `report_outcome` (`agent-toolkit:385`) but its `tools` row reads
  `viberr tools: post_comment, ask_human`.
- Persona proof: mounted -> section "# Browser (viberr_browser)" (`:262-288`) with "Screenshots: call
  `browser_take_screenshot` WITHOUT a `filename` argument. Default-named screenshots save into `<REL>` …";
  refused -> "# Browser not mounted … Your profile grants `use-browser`, but <reason>. Do not claim or attempt
  browser tools; report the gap if the task needed them." (`specialist-run.server.ts:2509-2515`). Codex adds
  "On this Codex runtime a screenshot does NOT return to you as an image".
- Playwright MCP 0.0.79 (`package.json:35`; tool names verified in
  `node_modules/@playwright/mcp/node_modules/playwright-core/lib/coreBundle.js`): tool ids are `browser_*`;
  the ones an observer will see: `browser_navigate`, `browser_snapshot`, `browser_take_screenshot`,
  `browser_pdf_save`, `browser_console_messages`, `browser_network_requests`, `browser_click`, `browser_type`,
  `browser_wait_for`, `browser_tabs`, `browser_close` (full list: 78 tools incl. `browser_evaluate`,
  `browser_run_code_unsafe`, `browser_file_upload`, `browser_start_video`). On Claude they surface as
  `mcp__viberr_browser__browser_*` tool calls in the console; Claude's `system·init` line also names the
  servers.
- Default names: `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`
  (`coreBundle.js:64835-64837`) -> `page-2026-09-06T14-03-22-118Z.png`; screenshot description says
  "Defaults to `page-{timestamp}.{png|jpeg|webp}` if not specified" (`:65027`); PDF `page-<stamp>.pdf`
  (`:66863`); aria snapshot files `page-<stamp>.yml` (`:65394`); console dumps prefix `console`, ext `log`
  (`:63870`). All match `MCP_STAMPED_NAME_RE`. A default name resolves against `--output-dir`
  (`outputFile` `:64713-64719`); a caller-supplied `filename` resolves through `workspaceFile` against the
  client workspace = child cwd (`:65204-65216`, `:64700-64703`) and is NOT collected.

### G6. Recipes: producing an attachment on purpose

**A. Codex Developer files `evidence.txt` (no browser involved).**
1. Precondition: the deployed Developer's grant list is non-empty and has no explicit `off` on "Attach
   evidence references" (seed: absent = direct). Backend Codex.
2. Task goal or a human `@Developer` directive: "After validating, write `evidence.txt` (what you ran, exit
   codes) and copy it into the task's attachments folder named in your prompt under 'Posting files on the
   task thread'. Cite `evidence.txt` in your final summary."
3. Expected proof: run·inputs `sandbox` = `workspace-write` (Developer holds repo-write, so no advisory
   note; the note appears only for repo-write-withheld + evidence profiles); the agent's transcript shows a
   `cp`/write to `../../attachments/evidence.txt` (or a detour; see G2 candidate); on disk
   `<data>/projects/<slug>/tasks/<KEY>/attachments/evidence.txt` (container: `/data/projects/...`) with
   mtime >= `agent_runs.started_at`; `task.md` newest event carries `attachments:` / `- evidence.txt`; the
   timeline event shows a `tl-attach-chip` "evidence.txt"; panel "Attachments · 1 file" with "by Developer ·
   <time>"; click -> `Attachment lightbox` (`data-screen-label`, aria-label `Attachment evidence.txt`) read-only
   text viewer with Download (`?download=1`) and Open original; route serves `text/plain; charset=utf-8`
   inline with `content-security-policy: sandbox; default-src 'none'`.
4. Failure shapes to log: file written into the checkout (shows in the PR diff instead); file named with a
   subdirectory (`evidence/notes.txt` -> event drops it, panel never lists it); `cp -p` (no producer line);
   final reply not JSON (envelope parse falls back; evidence rows lost) or a stub summary.

**B. Claude Developer screenshots the GitHub repo page.**
1. Precondition: backend Claude; `use-browser` + `use-web-search-fetch` both `direct` (seed Developer);
   `/resources/health` `browser.available: true` (`browserRuntimeStatus` `:112-135`).
2. Directive: "Open https://github.com/akin-ozer/k9s-clone in your browser and take one screenshot of the
   repository page WITHOUT a filename; cite the generated filename in your report."
3. Expected proof: run·inputs `mcp` row `mounted: viberr_browser, viberr_agent`; console tool calls
   `mcp__viberr_browser__browser_navigate` then `mcp__viberr_browser__browser_take_screenshot`; tool result
   text names `page-<stamp>.png`; during the run `ls attachments/` shows the png plus zero or more
   `page-<stamp>.yml` snapshots (and `console-<stamp>.log` if console was read to file); after completion
   only the png (and any cited yml) remain; the reply event renders the png inline as `tl-attach-thumb` and
   the panel grid shows it with "added by Developer · <time>"; the lightbox shows the picture with Download.
4. If the agent passes `filename:`, the file lands in the checkout cwd, is never collected, and can ride
   `git add -A` into the PR: a legitimate finding only if the prompt sentence was present and ignored.

**C. Proving a prune deliberately.**
1. Run B and keep a shell on `attachments/` with `ls -la --time-style=full-iso` before the run ends (or
   `watch`). Note every `page-…yml`.
2. Variant C1 (uncited): the reply does not mention the yml -> after completion it is gone; server log has
   `pruned uncited browser working artifacts` with the names; the event's `attachments:` lists only the png.
3. Variant C2 (cited): directive adds "quote the exact snapshot filename (`page-….yml`) in your report" ->
   the yml survives, is listed on the event, opens in the text viewer (`.yml` is in `INLINE_TYPES` and
   `TEXT_VIEW_RE`).
4. Variant C3 (sibling live): start a second run on the same task (e.g. `@Reviewer`) before B finishes ->
   log `browser working-artifact prune skipped — sibling run live`, ymls stay; when the sibling finishes it
   prunes only files with mtime >= ITS `started_at`, so B's earlier ymls persist (G4 candidate).
5. Variant C4 (interrupted): press Stop mid-run -> `finished.state` is not `finished`, no prune, note
   "Saved N files to this task's attachments during the run." or the reply carries them.
6. A pruned file's stale link: the lightbox probes once; 404 -> "This attachment could not be loaded." and
   Download is dropped (`attachment-lightbox.tsx:216-260`).

### G7. Visibility rules the observer must not mistake for bugs

- Panel and list ship only when `runsVisible` (project member or org admin, `project.task.tsx:227`,
  `:312-319`); non-members get `[]` and the route re-checks membership (`task-attachment.ts:32-33`).
- Panel empty state renders ONLY when a deployed specialist has `capabilities.browser`
  (`task-detail-page.tsx:836-838`, `attachments-panel.tsx:55-69`) and its copy says "A browser-capable agent
  on this task saves the screenshots and files it captures here". **Candidate finding**: a task whose only
  evidence-granted agent is browser-less (seed Reviewer alone) shows no panel at all until a file lands, and
  the copy contradicts ruling 96 (any evidence-granted run may post files).
- Panel lists the DIRECTORY newest-first, capped at 100 with `Showing the most recent 100 of N files. Older
  ones aren't listed here.` (`attachments-panel.tsx:87-92`); events list at most 20 names each.
- Markdown links an agent writes as `../../attachments/<name>`, `attachments/<name>` or a bare `<name>` are
  rewritten to the serving route only when the task actually has that file (`markdown.tsx:148-162`).

### G8. Drift and gaps found while filling this section

- docs: `docs/domain/task-lifecycle.md` puts the attachments paragraph in §13 "Timeline and noise control"
  (`:453-459`), not §14 (§14 is Notifications); the checklist's "§14" pointer is stale.
- docs: ruling 96 cites `specialist-browser-mcp.server.ts:167` and `specialist-run.server.ts:1403,1653,2014`;
  the code is at `:231-245` and `:1745,1835,2041` (line drift only).
- docs vs code (candidate): ruling 96 / the persona say the drop is "a real directory reachable from your
  working directory"; the path given is data-root-relative (G2).
- code vs disclosure (candidate): run·inputs `tools.toolkit` omits `report_outcome` for evidence-only Claude
  profiles and always omits `github_read` (G5).
- code (candidate): sibling-live prune skip is never reconciled (G4).
- copy vs ruling (candidate): attachments empty state is browser-gated and browser-worded (G7).
- record-verification §12 lists the Claude toolkit only; the Codex envelope `evidence` field and the drop
  directory are the non-browser paths this section adds.
