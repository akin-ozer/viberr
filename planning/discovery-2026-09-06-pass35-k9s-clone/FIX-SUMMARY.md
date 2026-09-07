# Pass 35 — what shipped

Branch `pass35/fixes-laneA`, based on `pass35/k9s-clone-observation` @ `8d02c45e` (which is
treated as main for this pass). 45 commits, two of them merges (lane B, and the base branch
brought forward). The plan is [`PLAN.md`](PLAN.md), the owner's answers are
[`QUESTIONS.md`](QUESTIONS.md) and they are binding; the live evidence is
[`VALIDATION.md`](VALIDATION.md) with its shots indexed in [`SCREENSHOTS.md`](SCREENSHOTS.md).

**Gates on the final tree** (`065b3fbe`), run in order:

| Gate | Result |
|---|---|
| `npm run lint` | clean, 0 diagnostics (oxlint 1.79.0 prints nothing when clean; a deliberate probe file proved it was actually reading `app/`). Delta against `pass35/k9s-clone-observation`: none, since the branch is at zero. |
| `npm run typecheck` | clean (`react-router typegen && tsc`, exit 0) |
| `npm test` | **353 files, 6172 passed, 2 skipped, 0 failed** (60.6 s) |
| `npm run build` | clean; the two `INEFFECTIVE_DYNAMIC_IMPORT` warnings are pre-existing on the base branch |

No gate fallout needed fixing, so there is no `[pass35] gate:` commit from this closing pass.
The clock-dependent failure four implementers reported as pre-existing red
(`profile-route.server.test.ts`, ruling 130(d)) is fixed in `25bdadcb`: its fixture pinned a
quota reset to a wall-clock instant that the day caught up with, and it now derives the instant
from `Date.now()`. `npm run e2e` was NOT run: it needs Docker, which this lane does not have.

## Commits since `pass35/k9s-clone-observation`

- `23b2c587` S1: live output tokens are an estimate until the provider's total lands (F35-1)
- `03640899` S2: coordination lane beside the run cap (G35-5(b), ruling 152(b))
- `bcf981a6` S4: operator and task actions (F35-2 boundary always wins, G35-5(a) one-turn walks and the acceptance fold, U35-3 force record, F35-5 mention trace, F35-6 goal save, F35-8 hold lift)
- `d38db32d` S3: quota hold and reset parse (G35-4, G35-5(c), U35-11 a local TLS or connection failure is this deployment's network path)
- `05fc839a` S15: one acceptance gate read everywhere, the rework route back to review, the acceptance-time base refresh (F35-12, F35-13, G35-5(d)(e); rulings 162 and 163)
- `52b37073` S13: agent paths are absolute, delivery refuses the store layout, completion names a stray attachments folder (F35-10; ruling 159)
- `5a5dcbbf` S14: a PR closed without merging is a person's decision (F35-11; ruling 160)
- `6f67866a` S17: a revision is delivered once it leaves the workspace (G35-6, U35-8; ruling 161)
- `b8eae563` S5: controller toolkit and dock (G35-1, G35-2, U35-1, F35-4, U35-4, F35-7; rulings 153, 156, 157)
- `221b42b8` S11: no process but the server opens a live root's `projection.sqlite` (F35-9; ruling 158)
- `f105de01` S6: task page layout and draft (U35-2, F35-6 client, F35-8 display; ruling 157)
- `aab462d7` S12: a restart is a reason, not an actor (U35-7; ruling 158 addendum)
- `cda2ca5a` S7: users and GitHub handle (G35-3; ruling 154)
- `7963d686` S8: goal link wait mirror (F35-3; ruling 155)
- `bd70e235` S10: review queue keys on review work, not one stage (U35-5)
- `34a9afe6` merge lane B
- `3b695955` gate: integration fallout in three tests (the `liveAgentRuns` rename in a held-dispatch test, the baseline column count now that both lanes add one, the insights reset-hour regex)
- `992bd6b3` gate: ruling 151 from the plan's text (S9 landed in neither lane) and the README ruling count
- `16f54fcf` merge `pass35/k9s-clone-observation` into the fix branch
- `876f6fb8` S18: an option title is a promise the resolution keeps (F35-14; ruling 164)
- `221d87b0` review: the closed-PR block is answerable, and says so on the control (ruling 160; ruling 161 foreign head)
- `f41411ec` accept ceremony: a board drop is not dead-ended, and the dialog discloses the base refresh
- `a82d5b9e` acceptance gate: a discarded revision is read through `activeWorkRevision` (ruling 161(b))
- `295a74d2` review queue: the acceptance half is the graph's boundary, and an off-boundary row keeps its live PR facts
- `9f3b291d` verdict-stage: only a task at or past the review stage returns for a re-verdict (F35-13)
- `f1840654` store-layout guard: the tree is read NUL-delimited, so a quoted path cannot pass (ruling 159(b))
- `287af760` base refresh: the second push door refuses the store layout too (ruling 159(b))
- `95d82086` token honesty holds after a run ends: the estimate keeps its mark and the card names what it leaves out (F35-1 review)
- `efacc706` the store healer backfills what a DEFAULT would misdescribe, and a reader's copy is pinned to one moment (F35-1, ruling 158 review)
- `e90ca56a` task actions: a hold is not a re-send, a resume is a dispatch, and a move the drive made has a follow-up
- `cf75d7cc` the hold costs one retry, one turn's step and nothing a person already answered (holds-dispatch cluster review)
- `54a99855` the promise guard reads the option's own act: delivery idioms pass, a `move_stage` title cannot name another stage
- `49cd48a5` ruling 85 under ruling 164: the capability remedy is named in the packet, never offered as an option
- `d12ca353` the acceptance-stage move reads the pull request, not the whole acceptance gate
- `641ac909` a `force_accept` ceremony does not name the packet it resolves as the gate it bypasses
- `f3f67b7b` the coordination lane returns a borrowed cap slot, and its sentence prints the lane
- `6d747908` a reader copies whenever the writer lock is there at all: its staleness is another namespace's question (ruling 158 review)
- `3f96d96b` `scripts.md` describes the backup's read as it ships: a copy under `state/tmp/`, not a read-only connection
- `bef3567e` the Policy page's closing note says the shipped boundary rule (ruling 151)
- `6f7df8db` `deploy_agent`'s description promises the template's effort, and the view is pinned (ruling 153)
- `73dd06af` a GitHub handle counts for one account at every writer, not just the admin door (ruling 154)
- `89a4c4af` the send door answers the sentence the engine would, and its post-turn arm has a test (U35-4)
- `2112dd98` an active link cannot be made to wait on a later link of its own chain (ruling 155)
- `25bdadcb` ledger: fix validation (live pass on a scratch root; two defects found and fixed)
- `065b3fbe` S9: ruling drift notes and the shipped-behaviour pass

## By subsystem

**Runtime token accounting and Insights.** A Claude run's live output tokens were the
`message_start` placeholder (usually 2) and a Codex run's were 0 until the turn ended, so the
strip's Tokens column lied for the whole life of a run. The adapter now estimates output from
the streamed content it can see (text, thinking and `tool_use` input, four characters to the
token), the sink folds estimates by max and lets any non-empty provider usage replace them, and
the projection marks an estimate `~n` until `usage_final` lands. Insights leaves estimate-only
rows out of its token sums and the card names how many it left out. Proven by
`run-projection.server.test.ts` "F35-1: tokens are marked estimated until the provider's total
lands" (four cases) and `insights-query.server.test.ts` "F35-1: token totals leave out rows whose
provider total has not landed"; the post-run half by `95d82086`'s tests that a finished row keeps
its mark rather than silently printing an estimate as exact.

**Run admission and the coordination lane (ruling 152(b)).** The concurrency cap counted every
run, so an operator turn could take the last build slot and a decision could park behind the
builds it was about. Coordination now has its own lane derived from the cap
(`coordinationLane`: one slot per four, minimum one); the cap bounds delivery runs, the instance
holds at most cap plus lane, and a borrowed cap slot goes back to a parked build once
coordination holds its whole lane. Proven by `run-concurrency.server.test.ts` "run concurrency
cap — the coordination lane (ruling 152)" (six cases, including the freed slot promoting the
parked operator ahead of the parked build) and `instance-settings.server.test.ts`'s derivation
table; the org-settings sentence by `org-settings-page.test.tsx` "a positive cap names the
coordination lane under the field".

**Backend quota holds (ruling 152(c)).** A dispatch aimed at a backend the instance already knew
was spent burned a provider call and a turn. The exhaustion record now holds the dispatch,
scoped to the account it would bill (ruling 146), read at every door through one
`assertDispatchNotHeld` ahead of the MCP pre-flight; the provider's time-only sentence ("try
again at 6:18 PM") is resolved in the process's own zone; the hold writes a timeline note, an
audit row and a `run-agent` schedule at the reopen instant, and costs no packet and no operator
turn. `cf75d7cc` made the window cost ONE retry per profile (a repeat dispatch reuses the pending
occurrence), made `operatorDispatchAgent` answer `noop` instead of throwing (a throw aborted the
rest of a paid Codex plan), and let the quota packet option that says the window has reset retire
the record. Proven by `backend-quota.server.test.ts` (eight cases, including the next-day roll and
the principal scoping) and `specialist-run.server.test.ts`'s four hold cases.

**Operator authority and boundaries (ruling 151).** A declared `approval` boundary was crossed
outright by an operator holding `stage-transitions: direct`. `transitionStage` now enforces the
declaration for any operator-authorized caller: `auto` is the only boundary a direct grant
crosses, `approval` always files a recommendation, `human` is refused with a sentence, and the
terminal stage stays reachable only through acceptance. Proven by
`operator-actions.server.test.ts` "ruling 151: full autonomy RECOMMENDS an approval boundary
instead of crossing it" and its explicit-grant sibling, plus `task-actions.server.test.ts`
"an operator-authorized move across an approval boundary is refused, whatever the caller". The
copy that told people otherwise is pinned too: `bef3567e` rewrote the Policy page's closing note,
which nothing had asserted.

**Controller toolkit, template grants and the dock.** The controller gained
`schedule_task_action` and `cancel_task_schedule` at the task page's own tier, `save_global_agent`
gained a template's default model and effort, and `deploy_agent` takes the template's effort when
no override is given (ruling 153). Display names are decoded once and ids derive from the decoded
text, so `Test &amp; CI Engineer` stops being stored as markup (U35-1). A template save now names
every project copy whose grants have drifted and offers the propagation, org-admin only, which
REPLACES the copy's three lists and records `project.agent_profile.resources_synced` (ruling 156).
Proven by `controller-toolkit.server.test.ts`'s schedule cases (bounds, label, audit, `[noop]`
cancel), `template-propagation.server.test.ts` (eight cases over `resourceDrift`,
`listTemplateResourceDrift` and `propagateTemplateResources`) and `agents-page.test.tsx`'s drift
sentences and gated button. The dock's unavailable view no longer leaks a project's display name
to a non-member (F35-4), and its send door answers 409 with the engine's own sentence and creates
no thread without a Claude credential (U35-4, tested in `89a4c4af`).

**Task page layout and the goal draft.** On a phone the page stacked four metadata panels above
the title and the open packet. The page is three regions in reading order now, the head spanning
both columns on desktop, with no `order` anywhere (U35-2). A decided `edit_goal` packet composes
ONE `packet.goalDraft` in `mapPacket`, printed on the decided card and opened by both the card's
and the hero's Edit, so the draft survives a reload (F35-6). Proven by `task-disposition.test.tsx`
"U7 / U35-2: ... puts the title and the open packet first, current state next, the timeline last
in the DOM" and `task.server.test.ts` "F35-6: a decided edit_goal packet carries the ONE goal
draft every editor door opens with".

**Users and the GitHub handle (ruling 154).** `users.github_handle` had one writer, GitHub OAuth,
so on a deployment that signs in locally every GitHub approval landed as `unlinked_handle` and
the refusal pointed at a profile card offering nothing to connect: ruling 68 was unreachable. An
org admin now links a handle for a local or Google account from the Edit-user modal, through the
one shared normalizer the OAuth provisioning also uses, unique among enabled accounts and
audited. `73dd06af` carried the same uniqueness to every writer: a GitHub sign-in takes a handle
an admin linked elsewhere and clears the loser with a reason, and enabling an account whose
handle was linked elsewhere while it was disabled is refused naming the holder. Proven by
`org-users.server.test.ts` "ruling 154: an org admin links a GitHub handle" (four cases) and
`pr-human-approval.server.test.ts`'s rewritten refusal assertion.

**Goal links (ruling 155).** Clearing a task's `blockedBy` left the goal link's declared wait in
place, so the Goals panel printed "waits on" for a task that was running and the controller read
a stale record. `mirrorLinkWait` now writes `links[].blockedBy` from `setTaskDependencies` (the
unchanged short-circuit included, so a drifted record heals) and from `releaseTask`, with a goal
timeline line naming the task and who changed it; `edit_link` on an active link forwards
`blockedBy` alone and refuses a title or goal by naming the task. `2112dd98` closed the sibling:
an active link cannot be made to wait on a later link of its own chain. Proven by
`dependencies.server.test.ts` "ruling 155: an active link's wait mirrors its task's list" and
`goal-actions.server.test.ts` "edit_link on an active link edits its wait through the task".

**Review queue (U35-5).** The queue keyed on one stage, so on a custom board the review stages
were invisible. The working half now lists every non-archived, non-terminal task at the resolved
review stage, with a PR open for review, or with a required reviewer's verdict missing or
`request_changes` on the current revision; the ready half stays the acceptance boundary, and the
rail badge is the queue's own total. `295a74d2` fixed the boundary read (it is the graph's, not a
name match) and kept an off-boundary row's live PR facts. Proven by
`review-queue.server.test.ts` "U35-5: review work before the boundary is listed on a custom
board" (four cases on a seven-stage board) and `review-page.test.tsx`'s header count.

**Read-only database readers (ruling 158).** A second connection to a live root's
`projection.sqlite` maps the WAL index the server has memory-mapped, and over VirtioFS that
killed the server with SIGBUS twice. `openDatabaseReadOnly` now asks only whether
`state/writer.lock` is THERE: with a lock file at all it copies the database and its `-wal` to
`state/tmp/reader-<pid>/`, opens the copy, and removes the directory on close; only a root with no
lock is opened in place. `6d747908` made that presence-only on purpose (the boot's staleness tests
are pid-namespace-local and `compose.yml` pins one hostname, so a second container's reader would
call a live holder stale). `npm run backup` and `npm run keys -- status` read through the handle
and say which way they read. Proven by `sqlite.server.test.ts` "openDatabaseReadOnly (ruling 158)"
(five cases including the sweep of a dead reader's directory), `data-root-lock.server.test.ts`
"judgeDataRootLock", and `runbook-db-read.test.ts`, which pins both operations pages against ever
showing a `sqlite3` or `DatabaseSync(` open of the live file.

**Run recovery and restarts (ruling 158 addendum).** Boot recovery wrote orphaned runs as
`state: error` with the literal `"restart"` in `interrupted_by`, so the projection looked
"restart" up as a user, the pill read "continuity error" and Insights counted 23 failures of
which 17 had never executed a turn. Recovery and the operator drive's orphan sweep now write
`interrupted` with a new `agent_runs.interrupted_reason` (baseline edit, no migration);
`interrupted_by` is a user id or null and a person who interrupted a run the restart then
finalized keeps their id beside the reason. Insights keeps such runs out of the error count and
drops never-started interrupted runs from the completion denominator, naming both on the card.
Proven by `run-recovery.server.test.ts` "flips a running run to interrupted with
interrupted_reason=restart and no interrupter" plus "keeps the person who interrupted a run the
restart then finalized", and `runs-panels.test.tsx` "a run interrupted by a restart".

**Delivery and the store layout (ruling 159).** An agent told its attachments folder was
"reachable from your working directory" created `projects/<slug>/tasks/<key>/attachments` inside
the clone, committed it, and the delivery pushed Viberr's store layout into the customer's
repository. Every path handed to an agent is absolute now and says it is outside the checkout and
never committed; `pushWorkspaceBranch` reads HEAD's tree after the delivery auto-commit and
refuses a branch that carries the layout, and the completion pipeline posts a `policy` line
naming a stray folder it found. `f1840654` made the tree read NUL-delimited, because git quotes a
path holding a non-ASCII byte and an accented screenshot inside the stray folder read as an empty
tree; `287af760` put the same read on the second push door, the acceptance-time base refresh.
Proven by `push-workspace.server.test.ts` "ruling 159: refuses a revision whose tree holds
projects/<slug>/tasks/..., names the path, and runs no push", its uncommitted-folder sibling, and
the quoted-path case added with the `-z` read.

**A pull request closed without merging (ruling 160).** The owner closed PR #10 with a rejection
comment; twenty-five seconds later a delivery opened PR #26 over the same branch and nothing
named the person's decision. `openTaskPr` now splits the terminal cases: merged keeps DG-1, a
cached `closed` whose closure nobody answered refuses `closed_by_human` before GitHub is asked,
and a live cache GitHub reports closed is handed to the reconciler first. The reconciler stays the
one writer of `pr.closure`, the R8-6 note, the inbox alert and the `pr-diverged` wake, and fires
them the pass the RECORD is written. `221d87b0` made the block answerable: resolving any packet
while the PR stands closed stamps `closure.answered`, creating the record when none exists, and
the Deliver control says so. Proven by `pr-open.server.test.ts` "ruling 160: a cached
closed-unmerged PR with no answered closure refuses a fresh PR (closed_by_human)" and its
answered-closure companion, plus `pr-divergence-wake.server.test.ts`'s single-fire case.

**Revision departure and the remote (ruling 161).** A completion report registered a
`workRevision` fourteen minutes before the delivery push was refused, and ruling 77's gate then
refused `discard_branch` on exactly the branch the discard exists for. The gate reads
`revisionLeftWorkspace` now (`pr`, `github.unownedPr`, or `workRevision.pushedAt`, which the
delivery push stamps; `github.commits` is not evidence, because the workspace reconcile writes it
from the local clone), a confirmed discard retires the revision in the same write, and every
reader that means "the revision under review" goes through `activeWorkRevision` (`a82d5b9e`
closed the acceptance gates, the last reader still reading the raw record). The remote's own
facts are disclosed as `github.foreignHead` before the archive ceremony deletes a branch. Proven
by `task-file.schema.test.ts` "ruling 161 (pass 35, G35-6)" (four cases) and
`task-governance.server.test.ts`'s retirement and two-sha rows.

**The acceptance gate, the base refresh and the rework route (rulings 162 and 163).** A
conflicting PR was recommended for acceptance, offered on the task page, then refused at the
button. The GitHub-fact half of the gate is one function now (`mergeReadinessRefusal`), reaching
the operator as `get_task`'s `notAcceptableReason` beside `pr.mergeable` and the task page as a
keyed alert over a disabled confirm; the base refresh happens once, at acceptance time, in the
same ceremony as the merge. A revision that changes after a verdict returns to the review stage
through three doors, where "the review stage" is where the task's required reviewers can actually
run. `9f3b291d` put a floor under that scan (only a task at or past the structural review stage
moves, or a delivery at a mid-board stage walked the task back to Implementation), `d12ca353`
stopped three shipped texts keying the MOVE into the acceptance stage on `notAcceptableReason`
(whose first gate is "not at the boundary yet", whose own remedy is that move), and `f41411ec`
un-dead-ended a board drop onto the boundary and disclosed the refresh in the dialog. Proven by
`task-actions.server.test.ts` "pass 35 S15: rulings 162 and 163 at the merge stage" (seven cases,
including `[refresh, merge]` in order and the conflicting refresh refusing with the gate's own
sentence) and `operator-actions.server.test.ts`'s five-case sibling.

**An option title is a promise (ruling 164).** A packet option is resolved by its `kind` and never
by its title, so `custom` "Force-accept as admin without a fresh verdict" recorded a decision that
did nothing, and `redirect` "Move KNC-16 back to Review" moved nothing. Two new kinds make the
promise keepable (`force_accept` runs the task page's own `forceAcceptCompletion`; `move_stage`
runs `transitionStage({ manual: true })`), both performing their act AFTER the resolution write,
and a guard at the authoring door refuses a send-back option whose words promise an act its kind
cannot perform. `54a99855` taught the guard to read the act rather than the vocabulary (delivery
idioms pass, the ruling-163 rework redirect is exempt, a `move_stage` title naming another stage
is refused, and `force_accept` is refused on a closed-unmerged PR), and `49cd48a5` removed the
older ruling-85 sentence that told the operator to do the very thing the new guard refuses.
Proven by `packet-options.test.ts`'s guard table and the `resolvePacket` kind-matrix tests for the
two new kinds; the persona and toolkit halves by `operator-parity.server.test.ts`.

**Rulings and drift (this commit, `065b3fbe`).** Rulings 151 to 164 were written by the slices
that shipped them; this pass read each against the tree, corrected the five that had drifted
(152(c), 160(d), 162, 163, 164), added the file citations 162 and 163 lacked, moved 158 to 164
from after the Route map section into the ruling list where 151 to 157 sit, and recorded the five
documentation drifts the discovery read named (D14, D22, D40, D88, D97) as one dated note.
`docs/README.md` says 164 rulings.

## Rulings recorded by this pass

| # | Ruling |
|---|---|
| 151 | Boundary always wins: a declared `approval` boundary always routes to a recommendation, a `human` boundary is refused, and the terminal stage stays reachable only through acceptance. |
| 152 | Coordination cost is a product cost: (a) one turn may cross consecutive `auto` boundaries, (b) coordination has its own lane beside the cap, (c) no dispatch starts on a backend the instance knows is spent. |
| 153 | Controller parity for schedules and template defaults, and names stored as the person meant them. |
| 154 | An org admin may link a GitHub handle; every writer keeps it unique, and a person cannot set their own. |
| 155 | An active link's wait is its task's list (amends 131(c)). |
| 156 | A template edit says where it did not land; propagation replaces the copy's grant lists and is org-admin only. |
| 157 | A hold ends when someone starts work; the display never says blocked and agent working at once. |
| 158 | No process but the server opens a live root's `projection.sqlite`; every other reader copies first. Addendum: a restart is a reason, not an actor. |
| 159 | Every path Viberr hands an agent is absolute, and a delivery that would publish the store's layout is refused. |
| 160 | A pull request closed without merging is a human decision about the task; no fresh PR until a person has answered. |
| 161 | A revision is delivered once it has left the workspace; the discard retires it, and the remote's own head is disclosed. |
| 162 | The acceptance gate's verdict is computed once and read everywhere; the base refresh happens once, at acceptance time (amends 132). |
| 163 | A revision that changes after a verdict returns the task to the review stage. |
| 164 | An option title is a promise the resolution keeps. |

Ruling 85 was amended in passing (`49cd48a5`): the capability remedy is named in the packet's body
and observations, never offered as an option, which is what ruling 164's own guard enforces.

## Open issues

**Not run in this lane**

- `npm run e2e` (needs Docker). The specs the plan flags as touched are 01 (the Done-stage drop
  the acceptance blocker fix restores), 03, 04, 06, 07 and 08; the task page's DOM order and the
  packet's full-width placement changed, as did the org-settings Agent resources tab and the
  dock's unavailable label.
- Live GitHub. No credential in this lane, so the closed-PR arms, both store-layout push doors as
  a real push, the acceptance-time base refresh against a real remote, and the archive ceremony's
  foreign-head delete are unit-covered only. Everything else was driven live on a scratch data
  root; see `VALIDATION.md`.
- A live provider turn. No Claude or Codex credential is connected on the validation instance, so
  the token estimate, the quota hold and the operator's own turns were validated by probe against
  the shipped code rather than by a streaming run.

**Behaviour left for the owner**

- **Closed-PR recovery on a deployment with no operator.** Ruling 160's in-app door is answering a
  packet, and the packet is model-authored. The block is always ANSWERABLE now (`resolvePacket`
  creates the closure record when none exists), but with no operator deployed and no `ask_human`
  packet the only exits are reopening the PR on GitHub or archiving the task. Widening it, for
  example a confirmed Deliver ceremony that stamps `closure.answered`, is a change to ruling 160's
  door and would contradict the disabled-control fix in the same cluster; not taken unilaterally.
- **A PR whose head already carried the store layout can still be merged by an acceptance.** The
  layout is on origin, and merging is a human decision about GitHub content. Ruling 159(b) refuses
  publishing, not accepting.
- **Terminal-estimate rows in Insights.** `InsightsTotals.tokenlessRuns` gives the page the count
  either way; whether the estimates belong INSIDE the token sums rather than named beside them is
  the plan's exclusion rule, not a code defect.
- **A packet replaced under an open card keeps the previous packet's selection index** instead of
  the new packet's recommended option (pre-existing; re-seeding a selection under a person's
  cursor is a behaviour question).

**Residuals worth a later pass**

- The delivery auto-commit (`git add -A`) still commits a stray store-layout folder BEFORE the
  ruling-159 read, so after a refusal the local branch carries it as a commit. Nothing publishes
  it any more (both push doors refuse), but the branch stays blocked for delivery and for base
  refresh until a person removes the folder, which is what both refusal sentences say.
- `CLOSED_PR_DELIVERY_REFUSAL` (client) is a hand-kept pair with `closedByHumanDeliveryText`
  (server, in a `.server` module). The codebase's existing precedent, `DIVERGED_PUSH_REFUSAL`,
  does the same thing; a shared module for the pair would stop them drifting.
- The reader's copy-retry give-up arm (a writer resetting the WAL through all three attempts) has
  no deterministic in-process test: nothing runs between two synchronous `copyFileSync` calls, so
  the race cannot be interleaved without a test-only hook in production code. The identity
  semantics around it are pinned.
- A goal file hand-edited to drift (link active, task list differs) heals only on the next
  task-list write or release; the goal runner tick does not sweep for drift.
- Existing data roots: the boot healer adds `usage_final` defaulting to 0, so historical
  `agent_runs` rows read as estimate-only and are excluded from the Insights token sums. Pre-
  production, so no migration; a one-off `UPDATE agent_runs SET usage_final = 1 WHERE state IN
  ('finished','error','interrupted')` on the live root restores them if the owner wants them
  counted.
- The Insights backend-quota card keeps its 24-hour grace for a `clock`-precision exhaustion, so a
  time-only window can still show on the card up to a day past its reset. The HOLD trusts the
  instant, by design.
- Propagation on a definition-less deployment is a no-op (it already resolves the template live)
  and records no audit row; the roster never offers the button for one, so only a hand-built POST
  reaches that arm.
