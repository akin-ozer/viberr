# Pass 35 — fix validation (live)

Branch `pass35/fixes-laneA` at the merged tree, validated on 2026-09-07 against a dev server
started on a SCRATCH data root (`.../scratchpad/validate-root`, seeded with `npm run seed:demo`)
on port 5175. The live instance on 5173 and its docker-data were never touched. The browser work
was driven by headless Playwright (chromium) signed in as `arda@viberr.dev` (org admin), one
saved `storageState` reused for every run; `elif@viberr.dev` signed in once, for her own profile.

No provider credential is connected on this instance, so nothing that needs a real Claude or
Codex turn (a streaming run, an operator decision) could be exercised end to end. Those halves
are validated by a targeted probe against the shipped code, named as such below.

Defects found are in the last section: two were fixed here, each with a test that goes red
without the fix, and one is recorded as an observation for the owner.

---

## 1. Surfaces a person sees

### U35-2 task page reading order (desktop and mobile)

`/projects/viberr-core/tasks/VIB-142`, an open completion-report packet.

Desktop 1440x1100, computed style and page geometry read from the live DOM:

```
css {"head":{"gridColumn":"1/-1","gridRow":"1/auto","order":"0"},
     "main":{"gridColumn":"1/auto","gridRow":"2/auto","order":"0"},
     "side":{"gridColumn":"2/auto","gridRow":"2/auto","order":"0"}}
.detail-head        y=76   x=256   (h 797)
.detail-head h1     y=105  x=256
.detail-head .packet y=301 x=256
.detail-main        y=889  x=256
.detail-side        y=889  x=1076
```

The head spans both columns on row 1 and carries the title and the open packet; the two columns
follow on row 2; `order` is 0 everywhere, so placement is still by grid cell (the app.css gate's
rule). Mobile 390x844: every region resolves to `grid-column: 1; grid-row: auto`, and the stack
reads key, title, stage pills, file path, goal, Edit, then the packet card, then current state.
Screenshots `task-page-{desktop,mobile}-{light,dark}`.

### F35-12 / ruling 162 the acceptance dialog and its refusal sentence

With the reviewer's approving verdict on the current revision, `Accept completion → Done` opens
the ceremony, which discloses the acceptance-time base refresh:

```
Accept this completion?
VIB-142 · Attach execution workspace to task runtime
DECISION   Accept completion
MERGES     PR #318 · in review into main
BRANCH     vib-142-attach-workspace is brought up to date with main first. If the base has
           moved, that merge commit is pushed to the branch and becomes the merge head.
REVISION   a91f7c200000
VERDICT    validation healthy
WITHDRAWS  the open decision "Accept completion, or send back for one fix?" ...
```

With `pr.mergeable: conflicting` on the same task, the one gate function speaks the same
sentence on both surfaces, and the control is refused rather than offered:

```
task page:      Not acceptable yet. VIB-142's review PR #318 conflicts with the base branch.
                GitHub can't merge it, so it can't be accepted. Rebase the branch and
                re-review, or archive the task.
review queue:   VIB-142's review PR #318 conflicts with the base branch. GitHub can't merge it,
                so it can't be accepted. Rebase the branch and re-review, or archive the task.
```

Screenshots `accept-dialog-desktop-{light,dark}`, `acceptance-refusal-conflict-desktop-{light,dark}`.

### U35-5 review queue

`/projects/viberr-core/review` on the demo board (`Review` is the stage before Done, and VIB-160
sits at `In Progress` with a `request_changes` verdict on its current revision):

```
Review queue
3 in review · 1 waiting on your acceptance

Waiting on your acceptance                                   1 of 3
  VIB-142  Completion report: Accept completion, or send back for one fix?   waiting on you  Review

Still in review                                              2
  VIB-145  VIB-145's delivered revision has no approving verdict yet. Run a review for a
           verdict, approve the pull request on GitHub, or an admin can force-accept.
  VIB-160  Review in progress at In Progress · changes requested
```

The off-boundary row names its own stage; the header counts both halves; the rail badge is the
queue's own total (3). Screenshots `review-queue-{desktop,mobile}-{light,dark}`.

### F35-14 / ruling 164 the packet ceremonies, including the two new option kinds

A packet carrying `force_accept` and `move_stage` renders both as ordinary options (screenshots
`packet-new-option-kinds-desktop-{light,dark}`, `-mobile-light`).

`move_stage` resolved live on VIB-145 (Review → In Progress). The task file after the click:

```
stage: impl
previousStageId: review

### 2026-09-07T16:16:54.531Z · transition · user:u_X3aA9Zxbwncm (Arda Kaya)
**Transition:** moved VIB-145 from Review to In Progress.

### 2026-09-07T16:16:54.522Z · transition · user:u_X3aA9Zxbwncm (Arda Kaya)
**Decision:** Send the task back to In Progress.
```

The option's title is a promise the resolution keeps: the decision and the move are one act, on
the stage picker's own path, with the transition event.

`force_accept` resolved live on VIB-160 (at In Progress, validation failing, a request_changes
verdict, an open blocked packet). The ceremony:

```
Force-accept this completion?
VIB-160 · Rehydrate specialist from canonical file
DECISION    Accept it as an admin without a fresh verdict
MERGES      No linked pull request. The task closes without a merge.
VERDICT     validation failing
SKIPS       Review, and the review gate: VIB-160 goes straight to Done.
BYPASSING   VIB-160 is at In Progress, not Review. A completion can only be accepted from the
            boundary the workflow puts before Done. Move the task through the workflow first.
Admin override. The bypassed gate is recorded to the audit log.
```

and the audit row it wrote (U35-3: every gate, not the first one):

```json
{"occurred_at":"2026-09-07T16:20:51.438Z","actor_label":"arda@viberr.dev",
 "action":"task.acceptance.forced","subject_id":"VIB-160",
 "details_json":{"bypassedGates":[
   "VIB-160 is at In Progress, not Review. A completion can only be accepted from the boundary the workflow puts before Done. Move the task through the workflow first.",
   "This task's latest review requests changes on the current revision. Rework and re-review before accepting.",
   "VIB-160 has delivered work but no review pull request. Deliver the branch & open the PR before accepting."],
  "skippedStages":["review"],"validation":"failing","withdrawnPacket":null}}
```

The task landed at Done. Screenshots `packet-force-accept-ceremony-desktop-{light,dark}`,
`-mobile-light`, `packet-accept-ceremony-desktop-{light,dark}`.

### U35-7 + F35-1 the Insights cards

Seven fixture runs plus one operator run the instance started and failed for itself (no Claude
credential). Two of the fixtures were stopped by a restart (one of them never started), one by a
person, and one row carries a live estimate (`usage_final = 0`):

```
8       Total runs
$0.64   Total cost              5 of 8 runs reported no cost
15.7K   Output tokens           403.0K in (240.0K cached) · 2 of 8 runs report no provider token total
29%     Completion rate         2 finished · 2 error · 4 stopped (3 by a restart, 1 never started)
```

- The stopped count names the restart's toll and the never-started share (U35-7), and the two
  restart-stopped runs are NOT in the error count.
- 29% = 2 finished / 7 terminal-and-started: the never-started run is out of the denominator.
- Token totals exclude every `usage_final = 0` row: 240000+120000+8000+30000+5000 = 403000 in,
  9400+5200+120+900+60 = 15680 out — the estimating rows' 64000/2100 are left out, and the card
  says how many rows that is (F35-1).

Screenshots `insights-desktop-{light,dark}`, `insights-mobile-{light,dark}`.

### G35-5(b) / ruling 152(b) the org-settings concurrency control

`/org/settings`, cap saved as 5 through the field:

```
Run concurrency · capped at 5 · 0 runs live
Max at once [5] Save    0 = unlimited
Cap 5: up to 5 agent runs at once, plus 2 slots for operator and controller turns so a
decision is not stuck behind the builds it is about.
```

The sentence prints the lane the server derived (`max(1, ceil(5/4)) = 2`), not a rule. A typed
`-1` is refused in place: "Enter a whole number (0 = unlimited)." and nothing is saved.
Screenshots `org-settings-concurrency-desktop-{light,dark}`, `-mobile-light`.

### G35-3 / ruling 154 the GitHub handle

An org admin linked `elif-demir` to Elif's LOCAL account from Users & access. Stored and audited:

```
users:        ('elif@viberr.dev', 'elif-demir', 'local')
audit_events: 2026-09-07T16:25:08.172Z arda@viberr.dev org.user.github_handle.set
              u_Dp6eLLwVKMs_ {"handle":"elif-demir","previous":null}
```

The same handle typed on a second account (as `Elif-Demir`) is refused on the normalized form,
in the modal and as a toast, and Murat's row stayed `null`:

```
@elif-demir is already linked to Elif Demir.
```

Signed in as Elif, her own profile card says what the link does:

```
GitHub identity
Workspace identity  elif@viberr.dev
GitHub account      @elif-demir · linked by an org admin
An org admin linked your GitHub handle, so your approvals on review pull requests count as
the review verdict.
```

Screenshots `org-users-github-handle-desktop-{light,dark}`,
`org-users-github-handle-duplicate-refusal-desktop-light`,
`profile-github-handle-desktop-{light,dark}`, `-mobile-light`.

### F35-7 / ruling 156 the agents page divergence marker

The project's developer deployment was given a grant list that differs from its template
(`release-notes` added here, `api-contracts` dropped). The Developer card:

```
Global base · grants differ from the template
Context resources & runtime                          [Use the template's grants]
SKILLS            Differs from the template: release-notes is granted here, not on the template.
                  developer-expertise   release-notes (MISSING)
KNOWLEDGE BASES   Differs from the template: api-contracts is granted there, not here.
                  architecture-notes
```

Pressing the button (org admin only) REPLACED the copy's lists with the template's — skills back
to `developer-expertise`, knowledge bases back to `architecture-notes, api-contracts`, the marker
gone — with the toast:

```
"Developer" now carries the template's grants · changes apply from the next run
```

Screenshots `agents-template-divergence-desktop-{light,dark}`, `-mobile-light`.

### F35-11 / ruling 160 the closed-PR block (client half)

VIB-145 with `pr.state: closed` and an unanswered closure by `elif-demir`:

```
Acceptance is closed. VIB-145's review PR was closed on GitHub without merging, so it can't be
accepted. Rework and reopen the PR, or archive the task. The decision on this task carries the
recovery paths.

PR #311 was closed without merging by elif-demir. A closed pull request is a person's decision
about the task, so Viberr opens no new pull request for this branch until the closed-PR decision
is answered. Reopening PR #311 on GitHub lifts the block too.
```

`Deliver branch & open PR` is disabled and `aria-describedby="deliver-closed-refusal"`. Stamping
`closure.answered` returns the control: `disabled: false`, `aria-describedby: null`. Screenshots
`closed-pr-block-desktop-{light,dark}`.

---

## 2. Server-only behaviour

### U35-7 boot recovery (live, on the running server)

A run row was left `state: running` with no live process, and the server was restarted. Boot
recovery rewrote it as a restart, not as a person's act, and re-invoked the operator:

```
run_fx_live  VIB-166  primary  interrupted  interrupted_reason=restart  interrupted_by=NULL
audit:       2026-09-07T16:09:xx system run.recovery.reinvoked viberr-core VIB-166
task page:   Developer · delivering      interrupted · by a restart
             interrupted by a restart; the operator was re-invoked
```

### F35-1 token accounting (probe against the shipped runtime, sink and projection)

One assistant envelope carrying a 4000-character text block whose `message_start` placeholder is
`output_tokens: 2`, then a result with the provider's own 640:

```
live envelope usage:   {"input_tokens":1004,"cached_input_tokens":900,"output_tokens":1000,"outputEstimated":true}
result envelope usage: {"input_tokens":1004,"cached_input_tokens":900,"output_tokens":640,"outputEstimated":false}
row while streaming:   {"output_tokens":1000,"usage_final":0}  projection {"tokens":2004,"tokensEstimated":true}
row after the result:  {"output_tokens":640,"usage_final":1}   projection {"tokens":1644,"tokensEstimated":false}
```

The live figure is an estimate of the streamed text (4000/4), never the placeholder; a result
BELOW the estimate replaces it and flips the row final; the projection marks the estimate for as
long as it is one. The Insights half of the same fix is witnessed live in section 1.

### G35-5(b) the coordination lane (probe against `run-service`)

Cap 5, five delivery runs live, then three operator turns and a sixth build:

```
five builds:      running,running,running,running,running
operator turns:   running,running,queued | sixth build: queued
snapshot:         {"cap":5,"lane":2,"live":7,"queued":2}
after one operator turn ends — op3: running | sixth build: queued | {"cap":5,"lane":2,"live":7,"queued":1}
```

Coordination is admitted up to `cap + lane` with `lane = max(1, ceil(cap/4))`, and a freed lane
slot promotes the parked coordination run before the parked build.

### G35-4 quota parse and dispatch hold (probe against `backend-quota`)

```
parseQuotaResetAt("You've hit your usage limit. Try again at 6:18 PM.", "2026-09-06T14:03:00Z")
  = {"at":1788707880,"precision":"clock"}   (= 2026-09-06 18:18 in the process zone)
hold before the reset:      {"until":1788707880000,"providerText":"Try again at 6:18 PM.","observedAt":"2026-09-06T14:03:00.000Z"}
hold after the reset:       null
hold for another account:   null
hold on the other backend:  null
```

The time-only phrase resolves in the process zone (never `Date.UTC`), the hold ends at the
instant the provider named, and it is scoped to the account the refusal was about (ruling 146)
and to that backend alone.

### F35-10 / ruling 159 the delivery guards

Both push doors refuse a tree carrying the store layout, and the read is NUL-delimited so a
quoted path cannot pass:

```
✓ ruling 159: refuses a revision whose tree holds projects/<slug>/tasks/..., names the path, and runs no push
✓ ruling 159: a stray folder the agent left UNCOMMITTED is caught after the delivery auto-commit
✓ ruling 159: a stray file whose NAME is non-ASCII is seen too (git would quote it)
✓ ruling 159: a clean tree pushes as before, and an unreadable tree is not a measurement
✓ ruling 159(b): refuses a branch carrying the store layout, names the paths and pushes nothing   (the base-refresh door)
```

### F35-9 / ruling 158 the store readers, against the LIVE server's root

Both read-only CLIs were run while the dev server held the writer lock. Each copies the file and
its WAL and says so:

```
$ npm run keys -- status
Read from a copy of the database: state/writer.lock names a holder for this data root
(pid 54404 on Akins-MacBook-Air.local), and only the app itself may open the live file.

$ npm run backup
- state/projection.sqlite — ... (a consistent point-in-time copy, WAL included; read from a
  copy of the file and its WAL taken while state/writer.lock named a holder, so the live
  database was never opened)
```

A copy-first reader loop then ran for five minutes against the same live root, alternating
`keys status` and `backup` and probing the server after each pass:

```
16:33:15 iter=1   keys_copy_line=1 backup_copy_line=1 health=200 tasks=12 reader_snapshots_left=0
16:35:45 iter=334 keys_copy_line=1 backup_copy_line=1 health=200 tasks=12 reader_snapshots_left=0
16:38:15 iter=669 keys_copy_line=1 backup_copy_line=1 health=200 tasks=12 reader_snapshots_left=0
LOOP DONE at 16:38:15

(669 passes, 5 minutes; every line in the log is identical apart from the clock and the counter,
so the summary above is the whole record.)
```

Every iteration took the copy path, every health probe answered 200 with the projection intact,
no reader snapshot was left behind under `state/tmp/`, and the server stayed up for the whole
window (669 passes).

### F35-11 / ruling 160 the delivery refusal (server half)

The GitHub half of ruling 160 (a live `openTaskPr` answering `closed_by_human` and the reconciler
raising the packet) needs a real repository and PAT, which this scratch instance has none of. The
client half is witnessed live above; the server half rests on its committed tests
(`pr-open.server.test.ts`, `github-reconciler.server.test.ts`), each carrying the canary the
implementer recorded.

---

## 3. Defects found in validation

### D35-V1 (FIXED) The acceptance ceremony claimed a withdrawal the record denies

**Seen.** The force ceremony opened from a `force_accept` packet option on VIB-160 printed:

```
WITHDRAWS  the open decision "Continuity degraded, pick a recovery path". It closes unanswered
           with the task; a timeline note and an audit row record the withdrawal.
```

and the `task.acceptance.forced` row written by that same click recorded `withdrawnPacket: null`.
Both are right about their own half: `forceAcceptDisclosure` reads the packet AFTER the packet
path has cleared it, and a packet resolution ANSWERS the decision (`resolvePacket`'s own comment:
"the open packet IS what this call resolves"). The screen said the opposite of the record, on the
ceremony ruling 164 requires to be the button's own disclosure. The same row rode the plain
`accept_completion` option too.

This is the class commit `641ac909` fixed one row higher ("a force_accept ceremony does not name
the packet it resolves as the gate it bypasses"); the sibling row was left exposed.

**Fix.** `app/features/task-detail/task-detail-page.tsx`: `openPacketTitle` is null when the
ceremony is a packet resolution (`confirmAccept.mode === "packet"`, force or not). The direct
doors (Accept, Force accept, an applied recommendation, a stage move) keep the row, which is the
only warning a person gets that a standing decision dies with the acceptance.

**Test that goes red.** `app/features/task-detail/task-disposition.test.tsx`, "ruling 164: a
packet resolution withdraws nothing, so the ceremony claims no withdrawal" — the force ceremony
and the packet accept ceremony carry no Withdraws row, the direct Accept door still does.
Reverting the source file:

```
AssertionError: expected 'Force-accept this completion?VIB-151 …' not to contain 'Withdraws'
```

**Verified live after the fix**: the packet accept ceremony on VIB-142 and the force ceremony on
VIB-166 print no Withdraws row, while the Accept button's own dialog on VIB-142 still does.


### D35-V2 (FIXED) A ruling-130(d) test asserted a fact with a shelf life

**Seen.** The full suite on the validated tree fails one test that the merge run (2026-09-06) saw
green:

```
FAIL app/features/profile/profile-route.server.test.ts >
     ruling 130(d): the loader attaches the viewer's OWN last refusal and never another person's
AssertionError: expected null to deeply equal { kind: 'quota', …(5) }
```

The shipped code is right: `latestBackendRateLimits` drops an exhaustion whose reset has passed,
and the fixture pinned `resetsAt` to `2026-09-07T11:50:00Z` (epoch 1788781800). The test passed
until 11:50Z on the day its literals named and fails after it, on any tree. Same class as the
Insights reading-row regex the merge had to loosen for a date coincidence.

**Fix.** `app/features/profile/profile-route.server.test.ts`: the refusal fixture's instants are
relative to `Date.now()` (observed minutes ago, reset an hour out) and the assertions derive from
the same values, so the test states the rule instead of a calendar.

**Proof it still tests the ruling.** Reverting the source (`ownRefusal` without its
`credentialUserId === userId` filter, the canary the test names):

```
AssertionError: expected [ { kind: 'credential', …(5) }, …(1) ] to deeply equal [ null, null ]
```

and the committed version of the test file fails today against the unmodified source, which is
the defect itself:

```
AssertionError: expected null to deeply equal { kind: 'quota', …(5) }
```

### D35-V3 (observation, not fixed) A packet replaced under an open card keeps the old selection index

**Seen.** Resolving a `move_stage` option re-triggered the operator, which failed (no credential)
and opened a NEW packet on the same task. The card is not remounted, so `sel` (initialised once,
from the recommended option) kept the index chosen for the previous packet: the new packet
rendered option 2 selected instead of its own recommended option 1.

Nothing is hidden — the highlighted option, the confirm's `aria-label` and the resolution all
name the same option, so a person confirms what they see — but the selection is not the new
packet's recommendation and was never chosen for that question.

Pre-existing (a mount-only `useState` initialiser), not a pass-35 regression, and re-seeding a
selection under a person's cursor is a behaviour question rather than a bug fix, so it is
recorded here for the owner rather than changed.
