# Task lifecycle

> How a task is born, moves, waits, gets reviewed, is delivered and is closed;
> and which server invariants hold at each step. Source of truth:
> `app/server/tasks/task-actions.server.ts`, `app/schemas/task-file.schema.ts`,
> `app/shared/workflow/*`, `app/shared/rbac.ts`. File fields are in
> [file-formats.md](../architecture/file-formats.md). Verified against `main`
> @ `68b5480` (2026-09-01).

## 1. The shape of every governed mutation

Every write to a task lives in `app/server/tasks/*.server.ts` and follows one order:

```
loadProjectContext(ctx, slug)                      # stages, workflow, members, archived, from project.md
requireAction(db, project, actor, "<rbac action>") # archive freeze, then the role check
readTaskFile(...)                                  # pre-checks (fast path)
await updateTaskFile(ref, mutate)                  # per-file mutex, read-modify-write, atomic tmp+rename
reprojectTask(db, ctx, slug, key)                  # synchronous rebuild of that one file → SSE
recordAudit(db, { action, actor, ... })            # secret-free details
```

Rules that follow from it:

- **Files first.** Projections are never written without file backing.
- **Archived projects are read-only** for every governed mutation
  (`requireProjectMutable`, 409 `conflict`).
- **Membership is the outer gate.** A non-member gets the unknown-slug 404 on reads
  (layout loader) and on actions (`requireVisibleProject`, called outside the try
  block so it never turns into a 403 that would confirm the project exists).
- **In-lock re-checks, not pre-checks.** The state checks outside the lock are fast
  paths; `transitionStage`, `resolvePacket` and the acceptance writers re-run the
  decision inside the lock, so two submits of one human act produce one event and
  one audit row (NFR16).
- **In-process authority flags never come from a request.** `operatorAuthorized`,
  `recommendationAuthorized` and `rework` are set only by server code.
- **A hard-stop file is never written.** A `task.md` that parsed only with fallback
  defaults is projected as `blocked` and refused for writes (`file_not_trusted`); fix
  the file or restore it.

## 2. Who may do what

`app/shared/rbac.ts` is the one table both the guards and the Policy page read.
Roles are a strict tier: `viewer ⊂ contributor ⊂ maintainer ⊂ admin`.

| Action id | admin | maintainer | contributor | viewer |
|---|---|---|---|---|
| `view`, `comment` | ✓ | ✓ | ✓ | ✓ |
| `create-task`, `own-task`, `edit-task-meta` | ✓ | ✓ | ✓ | |
| `approve-transition`, `resolve-packet`, `accept-completion`, `update-goal`, `run-agents`, `reorder-board`, `reconcile-github`, `grant-github-scope`, `rescan-project` | ✓ | ✓ | | |
| `release-any-ownership`, `manage-members`, `manage-agents`, `edit-policy`, `force-accept-completion` | ✓ | | | |

Three deliberate short-circuits, each re-asserting the archive freeze first: the live
task **owner** (contributor or above) may accept their own task and govern any open
decision on it (packets and recommendations, including transition recommendations
their role could not authorize from the stage menu); the loosest gate
`requireAnyMember` covers idempotent paths; and an **org admin** passes any project
gate as an audited emergency override (`project.org_admin.override`, deduped per
minute). Denials are audited as `project.authority.denied`.

## 3. Creation

`createTask` (`create-task`; the `create-task` intent on the board, the controller's
`create_task`, goal-chain advancement) refuses any stage but the **entry stage**
(ruling 70). It allocates the key from `project.md` `nextTaskNumber` under the
project mutex, writes `task.md` with `readiness: input_required`, `waiting: human`,
the goal (or the placeholder "Goal to be refined at the triage quality gate."),
optional `priority | labels | dueDate`, optional `goalRef`, then auto-invokes the
operator with the `create` trigger. Priority is `low | normal | high | urgent`
(`urgent` also sets the legacy boolean the board highlights), labels are at most 12
of 32 characters, due date is a plain `YYYY-MM-DD`. `edit-task-meta` grooms these
later without touching any gate.

The **triage quality gate is behavioral** (ruling 89): the operator flags an
underspecified goal with an `input` packet at triage; there is no mechanical block on
moving a task past an open packet. `input_required` set at creation clears when the
task leaves the entry stage.

## 4. Stages and the workflow graph

Stages are per project. Nothing hard-codes `triage`/`done`; `resolveStageRoles`
derives `entry` (first), `terminal` (last), `review` (the stage with an edge into
terminal) and `work` (the stage with an edge into review). `workflow` is a chain over
the stage order, one rule per consecutive pair, maintained by the stage editor
(`spliceStageIntoChain`, `rejoinChainAroundStage`, `realignChainToStages`): adding a
stage inherits the replaced edge's boundary, removing one merges neighbours with the
**stricter** boundary, a rule into terminal is always `human` and `locked`.

The Standard template: `Triage → Ready → In Progress → Review → Done` with boundaries
`auto, auto, approval, human`. Project creation offers three policy presets that
shape the graph and the operator deployment: **strict** (every pre-work `auto`
becomes `approval`; operator supervised), **balanced** (the template as is),
**autonomous** (operator at `full`). The preset is not stored; its effect is readable
off the graph (`humanGatesPreWorkAdvance`, ruling 28).

Agent stage eligibility resolves in three steps (`stageEligible`): a literal id on
this board; else the structural role the declared id names (`todo`, `backlog` →
entry; `impl`, `doing`, `wip` → work; `review`, `qa`, `verify` → review; …); else a
declaration that names nothing on this board is treated as unrestricted.

## 5. Transitions

`transitionStage(db, input, actor, ctx)`, in order:

1. Same stage → idempotent return. Unknown target → validation error.
2. Archived task → 409 (an archived card cannot be dragged column to column).
3. A **human moving a task into the terminal stage is accepting completion**: the call
   routes through `acceptCompletion` (real merge attempt, `completion` event, packet
   and recommendations cleared), never a bare move. The board drop and the keyboard
   Move menu raise the same confirmation as the task page (ruling 53).
4. Authority: `manual` (board menu, any stage) → `approve-transition`; an `auto`
   boundary → any member; `approval` → `approve-transition`; `human` →
   `requireAcceptCompletion`. Operator authority skips human RBAC but is forbidden a
   bare move to terminal; a supervised operator recommends instead of moving, except
   across `auto` boundaries and on a backward rework move while validation is
   `failing`.
5. Inside the file lock the stage is re-read: already there → write nothing; moved
   elsewhere → 409, because every guard above judged `fromStageId`.
6. On success: `previousStageId = fromStageId` (the durable "came back from Review"
   fact the operator weighs, ruling 98); terminal → `waiting = none`; leaving the
   entry stage attaches the operator and clears the triage gate; `task.transitioned`
   audit and a `transition` timeline event; the operator is re-triggered
   (`transition`); goal chains reconcile.

## 6. The three signals on a card

- **Readiness** (stored, 4 values): `ready | input_required |
  inconsistency_risk_detected | blocked`. The projection stores the derived value:
  diagnostics floor it (warning → `input_required`, error →
  `inconsistency_risk_detected`, hard stop → `blocked`); a `blocked` packet sets it to
  `blocked`; recovery options lift it back to `ready`. Surfaces render the derived
  display value `agent_working` instead of readiness while `waiting === "agent"`
  (`deriveDisplayReadiness`, ruling 91), and "accepted" for terminal-stage tasks.
- **Waiting**: `human | agent | none`. Raising a packet or a recommendation flips it
  to `human`; dispatching an agent sets `agent`; terminal forces `none`. It is a
  display flag: `liveRuns` is the only proof a run is in flight.
- **Validation** (derived cache): `none` before any revision; `failing` when a
  required reviewer requested changes on the current revision; `healthy` when every
  required reviewer approved it; `bypassed` after a force-accept; `none` for a
  verified no-change task with no required reviewer; otherwise `changed`. Never
  hand-edit it; the projection re-derives it from `workRevision`, `verdicts`,
  `engagements`, `noChanges` and `acceptance`.

## 7. Ownership, comments, mentions

- `owner-take` / `owner-assign` / `owner-release` (`own-task`, contributor+;
  takeover of another owner needs the acceptance tier; `release-any-ownership` is
  admin). Ownership changes are `assign` timeline events; admin releases are audited.
  Removing a member releases their tasks.
- `appendComment` (any member) writes a `comment` event, applies mention routing and
  fans out `mention` notifications. **Mentions stay inside the project** (pass 33, F33-9):
  the picker offers project members only, and a handle that resolves to exactly one real
  user who is NOT a member notifies nobody and is reported to the author as a visible
  non-delivery, beside the ambiguity note it already had. Before that, tagging a
  non-member wrote them an inbox row naming the project, the task and the comment — and
  the link then served them the members-only 404, which is ruling 25 read backwards. `@operator` queues an operator turn carrying the
  comment as its steer; `@<agent name>`, `@claude` or `@codex` resumes that agent's
  session (auto-engaging a deployed but unengaged agent, ruling 98) and the reply
  posts back as a comment tagging the human. Mentions use one grammar shared by the
  composer and the server (`app/ui/mention-spans.ts`).
- Comment bodies are escaped so that a line that would read as file structure
  (`## `, `### `, `title:`, `to:`, `evidence:`) cannot forge a section or an event.

## 8. Engagements, dispatch and verdicts

`engagements[]` is written by the dispatch (ruling 98). Running a deployed but
unengaged profile engages it: **delivering** iff the task has no deliverer and the
profile holds repo-write (`execute-code-or-write-repo` granted), **supporting**
otherwise. At most one engagement delivers; it owns the workspace, branch and PR.
A supporting engagement snapshotted with `verdictCapable: true` (an explicit
`report-validation-verdict: direct` grant at engage time) is a **required reviewer**.
`release-agent` removes a supporting engagement; a delivery hand-off routes through
`assignSpecialist`. **A closed task's seats are frozen** (pass 33, F33-10): `removeReviewer`
refuses on a terminal or archived task and both panels withhold the ✕. Ruling 118 froze the
owner seat there; the engagement seat earns it harder, because `validation` is derived from
the required-reviewer set — releasing the approving reviewer of a merged, accepted task
re-derived `healthy` → `changed` and left the board, the hero and the review queue calling a
closed task never-validated while its own timeline said otherwise. Unlike the owner seat,
this freeze has no admin escape: an admin reassigning an owner is bookkeeping, an admin
releasing a reviewer restates history.

A delivering run's reconcile mints a **work revision** (`{id, headSha, treeSha,
branch, kind: delivered}`); a new head with a different tree mints a new revision and
stales every prior verdict. A reviewer's `report_outcome` records a **verdict**
(`approve | request_changes`) bound to a revision id. A project member's GitHub
approval on the PR, whose `commit_id` equals the delivered head and whose login maps
to a member through `users.github_handle`, counts as an approving verdict (ruling 68);
anything ambiguous fails closed with the reason recorded.

## 9. Packets, recommendations, schedules

- One open **decision packet** per task (see [operator.md §6](operator.md#6-decision-packets)
  for the kinds and their effects). Resolvers: the owner, `resolve-packet` holders,
  and for `accept_completion` the acceptance tier. `edit_goal` is the only kind that
  keeps its packet open until the goal is saved.
- **Recommendations** are the supervised operator's pending cards (`transition`,
  `run_agent`, `accept_completion`, `delivery`). `applyRecommendation` passes
  `recommendationAuthorized` into the inner mutation, whose own capability gate still
  applies; the owner may apply or dismiss any card on their own task. Any stage move
  prunes pending transition cards; acceptance consumes every card.
- **Schedules** live in `task.md` `schedules[]`: `run-operator` (optional steer) or
  `run-agent` (a profile id and prompt; the profile must be deployed when the entry is
  created). Creating one needs `run-agents`. Each run control carries a when-picker
  (now, 5m, 1h, 6h, 24h). The runner ticks every 60 seconds, claims an occurrence
  before enqueuing (`pending → claimed → fired | failed`, `cancelled` by a human),
  never fires on a terminal or archived task, and resolves the **live** deployment at
  fire time (ruling 94). A fire-time refusal no retry can cure (profile undeployed,
  stage-ineligible) is a terminal `failed` with the reason on the timeline.

## 10. Delivery

Delivery (push the task branch, open the review PR) is an operator decision executed
by the server (ruling 21); humans trigger it with the `deliver-review` intent
(`run-agents` or the owner). `performDelivery` pushes the workspace branch
(auto-committing a dirty tree, refusing a non-fast-forward as a `push_conflict`),
detects a verified empty branch as a no-change outcome, opens or adopts the PR
(adoption only when the PR is open **and** its head is the delivered revision;
anything else is a branch collision), records `github.pr.opened`, and either re-queues
a full-autonomy operator (`delivered`) or ensures a supervised operator left a
"Move to Review" recommendation. Entering the review stage with no PR writes a typed
event, never silence. Details in [github-delivery.md](github-delivery.md).

## 11. Acceptance and the endings

Every writer to the terminal stage goes through one contract:

1. **Authority**: `accept-completion` (admin, maintainer) or the live owner;
   `force-accept-completion` is admin-only with no owner exception.
2. **Disclosure echo** (ruling 88): the client sends back the three facts it showed
   (`ackPr`, `ackRevision`, `ackVerdict`). A bare POST is refused with
   `accept_disclosure_missing`; an echo that no longer matches the task is refused with
   `accept_disclosure_stale`. In-process callers (the full-autonomy operator) carry
   their own contract.
3. **Terminal GitHub fact first**: a closed, unmerged PR refuses acceptance and
   withdraws force-accept entirely (ruling 37); a conflicting PR refuses.
4. **Verdict gate**: every required reviewer must have approved the current revision
   and none may request changes (ruling 20). Force-accept bypasses this and is
   audited `task.acceptance.forced` with what it bypassed, records `acceptance: forced`
   and enumerates the stages it skips. Force never bypasses two facts: a closed unmerged
   PR (ruling 37) and, since ruling 123, an **archived** task — restore it first. Both are
   `forceIrreducibleRefusal`, and on an archived task the affordance is withdrawn rather
   than disabled. The offer itself appears only once the task has something to accept — a
   branch, a PR or a delivered revision — or is demonstrably wedged by an open `blocked`
   packet (ruling 124).
5. **PR head containment**: the PR head must contain the delivered commit. A head
   ahead of the reviewed revision is accepted with a disclosed divergence ("N commits
   added since review", ruling 42); a diverged head refuses. Force never bypasses
   this.
6. **Live no-change probe**: a branch with no commits or no branch at all routes into
   the **Completed, no changes** ending (still verdict-gated, ruling 62); `noChanges`
   is re-verified against the remote inside the lock so a branch that gained commits
   cannot ride a stale flag into Done.
7. **Write**: stage → terminal, `waiting: none`, packet and recommendations cleared,
   pending schedules cancelled, a `completion` event, then the merge. A **human**
   acceptance triggers a real async merge (`github.pr.merged`, or `github.pr.merge_refused`);
   a full-autonomy **operator** acceptance records `pr.state: accepted` and leaves the
   merge to a human (`complete-merge` intent) because `merge-pull-request` is always
   human (ruling 40). After a successful merge the `delete-branch-after-merge`
   guardrail (default on) deletes the remote task branch.

Post-acceptance: the task workspace is reclaimed once no run is live, goal chains
reconcile, and the board renders "accepted".

## 12. Archive and restore

`archive-task` (`approve-transition`) is a terminal disposition, not a delete: the
file, its timeline and audit rows survive; the card leaves the board's default view
and the review queue; the open packet and pending recommendations are withdrawn;
pending schedules are cancelled; `restore-task` brings it back. Archiving through a
`pr-diverged` recovery packet may also delete the remote branch. An archived task
cannot be moved.

## 13. Timeline and noise control

`## Timeline` in `task.md` is newest-first, `### <UTC ISO> · <type> · <actor ref>`,
with the eleven types in `TIMELINE_EVENT_TYPES`. `policy` is reserved for genuine
violations and refusals; neutral system remarks are `note`; `continuity` marks a
resumed session whose provider transcript was gone. The projection serves a bounded
newest-first slice and the page asks for older events on demand (NFR5). The
compaction guardrail collapses old routine comments into one marker once the
configured threshold is passed, keeping every typed governance event.

Files a run posted ride on its event as `attachments`, and the attachments panel lists
the whole directory. What a human sees there is not everything the run wrote: at
completion the browser MCP's machine-stamped working artifacts are pruned unless the
run cited the exact filename, and what survives opens in an in-app card with Download
(ruling 105 — [ui/surfaces.md §5](../ui/surfaces.md#5-copy-rules-that-tests-enforce),
retention in
[architecture/data-model.md §5](../architecture/data-model.md#5-retention-and-growth)).

## 14. Notifications a task produces

Kinds: `packet` (a decision waits, `ptype` `input | blocked`), `approval` (a stage
approval or acceptance waits), `mention`, `quality`, `policy` (a violation or
refusal), and `controller` (goal progress). Recipients are the task owner plus
project admins and maintainers, honouring each person's routing toggles. Loading a
task page marks all of the viewer's unread notifications for that task read
(ruling 71); the bell and inbox mark-read explicitly.
