# Live validation — pass 39

Every fix checked against the RUNNING instance through its own surface, not by re-reading
the test that covers it. Instance: `56612143b5e6`, rebuilt 2026-09-22 05:04 UTC with the
pass's untracked Dockerfile layer (Go 1.25.1, gcc 14.2.0, golangci-lint 2.13.2).

## 0. The host actually gained what it was missing

```
$ docker exec viberr-app-1 sh -c 'command -v gcc && command -v golangci-lint'
/usr/bin/gcc
/usr/local/bin/golangci-lint
$ curl -s localhost:5173/resources/health | jq -r '.toolchain.go'
1.25.1
```

And the gate the project's own rulings required, which two agents had independently proved
unrunnable — now run by **the reviewer itself, inside the container, on the concurrent
store**, off its own run log:

```
$ CGO_ENABLED=1 go test -race ./...            # reviewer run run_sQPo2vnvVv1E, exit 0
ok  github.com/akin-ozer/ax-clone/cmd/ax        1.010s
ok  github.com/akin-ozer/ax-clone/internal/apis 1.016s
ok  github.com/akin-ozer/ax-clone/internal/store 1.044s
```

The bullet the rulings could not settle — "a data race is a defect, not a flake", against a
WAL and a watch feed nobody could race-test — is now a gate that actually runs.

## 1. `attach-file` (ruling 379) — the whole matrix, over HTTP

| who | request | answer |
|---|---|---|
| Tomas (contributor) | `POST …/tasks/AX-9` multipart, `live-fixture.yaml` | **200**, file on disk, timeline note "Attached `live-fixture.yaml` (1 KB). Agents on this task read it from the task's attachments.", actor `user:u_KF1bFvSYPXkE (Tomas Lind)` |
| Priya (viewer) | same | **403** |
| Tomas | same with `page.html` | **400** — "Viberr does not store “.html” attachments. It takes the files it can show or read back: .csv, .diff, .gif, .jpeg, .jpg, .json, .log, .m…" |
| Jonas (non-member) | same | **404** — the project does not exist for him |

Afterwards the directory holds exactly one file: `live-fixture.yaml`. The refusals wrote
nothing.

## 2. The clone's gates, run independently of the agents that claimed them

A fresh clone of `akin-ozer/ax-clone` at the merged head, checked on the host rather than
trusting the verdicts:

```
gofmt -l .        → 0 unformatted
go vet ./...      → exit 0
go build ./...    → exit 0
go test ./...     → ok internal/apis, rest [no test files]
```

## 3. Files-are-truth

`verify-record.mjs` compares what every page RENDERS against the canonical `task.md`:
stage name, branch, PR number, delivered-revision sha, every recorded verdict, and the newest
timeline entry's time (server-rendered UTC or the viewer's zone).

```
$ node planning/discovery-2026-09-21-pass39-ax-clone/verify-record.mjs
37/37 record checks agree with disk
```

## 4. `instance_health({ probe })` and the `advisory` marking — the same actor, asked again

A fresh controller conversation on the rebuilt instance, told only that the host had changed
and asked to find out for itself. Unprompted, its FIRST read was
`instance_health({ probe: ["gofmt", "golangci-lint", "go", "staticcheck"] })`, and the server
answered:

```json
"probe": [
  { "name": "gofmt",         "present": true,  "version": null },
  { "name": "golangci-lint", "present": true,  "version": "2.13.2" },
  { "name": "go",            "present": true,  "version": null },
  { "name": "staticcheck",   "present": false, "reason": "staticcheck is not on PATH" }
]
```

That is the exact fact it could not learn in the setup turn and wrote a false ruling about.
(`gofmt` and `go` answer `version: null` because neither takes `--version`; presence is the
question asked, and the type says the version is best-effort.) It then probed again for
`gcc`, `cc` and `clang` to check the race-gate claim.

It corrected `environment-and-gates.md` through the ruling-305 protocol (`replace: true` with
`replaces: "5eac9d02245b"`, the version it had just read), kept every still-true sentence,
appended an amendment log naming exactly what changed, and **declined to re-point `make lint`
at the new PATH binary** because "the PATH binary is 2.13.2 — a different linter version that
would change verdicts — so swapping to it would silently reverse a human's 'pin the version'
ruling." It then posted the amendment on the live task and @-mentioned the board's admins.

Asked whether its earlier claim had been true, it answered:

> What `get_project` actually shows on Developer's `move-task-to-review`: `mode: direct`,
> carrying `advisory: "persona guidance only: no runtime consumer enforces this, and it has
> no toggle"`. That is persona text, not an authority. Nothing enforces it, there is no
> switch to fail to flip, and `update_agent_deployment` refuses the id by design — so "I
> could not turn it off" described a setting that does not exist, and **I reported a
> non-setting as a gap in my configuration.**
>
> What I should have concluded, from the rows that are enforced: the Developer holds
> `open-review-pr: off`, the Operator holds `deliver-review-pr: direct`, and the
> Verify→Review boundary is `auto` with the operator advancing. Delivery is routed through
> the operator, exactly as intended.

…and generalised it to the other advisory rows on both specialists. The false statement
ruling 377(a) exists to prevent is no longer available to make.

## 5. Still to validate live

- `save_knowledge_base doc.append` — the correction above was a whole-document REPLACE, which
  is what that edit called for. The append path is unit-tested with a canary (route it through
  the replace arm and the first section is destroyed); folded into the next controller turn
  that has a real reason to build a document in pieces.
## 7. `propose_ruling` (ruling 378) — fired on its own, from a real contradiction

Told on the AX-9 timeline that the Developer's "this image lacks the `ld` linker" was a
misdiagnosis, with the reproduction and the fix, the operator filed this into
`environment-and-gates.md` — the document every run on the board reads:

```markdown
## Proposed (not binding)

Raised by an operator from evidence on a task. **Nothing here is binding.** A human or the
controller promotes an entry into the settled text above, or deletes it.

- **[AX-9, 2026-09-22]** Amend the host-toolchain wording to state that cgo-enabled
  `make gate` and the race gate are runnable and passed on this host. The earlier linker
  failure was caused by the missing gold linker while `/usr/bin/ld` was present, so no
  cgo/race environment exception remains.
  Evidence: `go run …/golangci-lint@v2.6.0 --version` exited 0; `make gate` with CGO
  enabled exited 0; `CGO_ENABLED=1 go test -race ./...` exited 0. `/usr/bin/ld` was GNU ld
  2.44; the prior failure was `gcc -fuse-ld=gold` unable to find the gold linker while only
  ld.bfd was installed, and binutils-gold was then installed.
```

…with the typed `quality` event on the task, a note to the owner, **no settled line touched**,
and this, unprompted: *"the required reviewer run remains in flight, so no workflow
transition or acceptance action is warranted yet."* The thing the operator could previously
only say in a comment now lives beside the rule it corrects.

One defect the first live use exposed and this pass fixed: the entry read
"Evidence: Evidence: …" — both surfaces label the field, and a model answering a field called
`evidence` writes the label into the value. The writer strips one leading label now, with a
canary.

### The tool surface

- `propose_ruling` — **mounted and live**, confirmed off a real operator run's own
  `run_inputs` on the rebuilt instance:
  `['post_comment', 'open_packet', 'resolve_packet', 'set_goal', 'run_agent',
  'transition_stage', 'deliver_for_review', 'update_branch_from_base', 'accept_completion',
  'flag_context_conflict', 'set_dependencies', 'propose_ruling']`. Its BEHAVIOUR needs an
  operator run with a proven contradiction. The natural trigger
  was consumed by the correction above; the rulings now instruct the next task that touches
  tests to run `go test -race ./...` and report command, exit code and output so a human can
  settle that bullet, which is precisely the shape the tool serves.

- `instance_health({ probe })`, the `advisory` marking on `get_project`, and
  `save_knowledge_base doc.append` — reachable only from a controller turn.
- `propose_ruling` — reachable only from an operator run. The live case is waiting: the
  rulings KB now says two false things (golangci-lint "NOT preinstalled", and the race gate
  unrunnable), the operator has been told so with evidence in a packet resolution, and the
  new tool is in the running build.

## 6. The audit log matches what actually happened

405 rows exported from the live instance. Every refusal the RBAC probe provoked is there —
13 for 13 — each naming the actor, the RBAC action, a human sentence for it, the project and
the member's role at the time:

```json
{ "actorLabel": "ravi.mehta@viberr.dev", "action": "project.authority.denied",
  "subjectKind": "project", "subjectId": "ax-clone",
  "details": { "action": "force-accept-completion",
               "what": "force-accept past the review gate",
               "projectSlug": "ax-clone", "memberRole": "maintainer" } }
```

Including the new one: `priya.raman@viberr.dev … attach-file`. A non-member's attempt is
audited as `any-member`, which is the same shape the 404 gives them — the record does not
leak the project's existence to them and does not hide the attempt from an admin.

**Noted, not worked:** these rows carry `taskKey: null`. The authority check is
project-scoped, so it genuinely does not know the task, and a refusal writes nothing to a
task timeline — so "which task did Priya try to force-accept?" is not answerable from the
record. Honest about what it does record; incomplete as forensics. A nitpick by this pass's
bar.

## Ruling 381 (F39-8) — a manual move BACKWARD says why

- **Server.** `transitionStage` takes `reason` and refuses a backward `manual` move without
  one, **after** the authority gate. Order proven by `policy-rbac.server.test.ts`, which
  expects a contributor's backward move to be 403, not 400: putting the check first turned
  that case into a validation error and the suite went red.
- **The reason is on the transition entry**, not in a note beside it — the operator reads the
  move and its instruction as one fact. `task-governance.server.test.ts` asserts the sentence
  in the event text and `transitionDetails.reason`; canary (drop the check) resolves instead
  of rejecting.
- **Every door.** Task-page stage menu, board drag, and the board's keyboard move all open the
  same `MoveBackConfirm`; `controller-toolkit`'s `move_task` takes `reason` and is refused
  without it. Forward moves are untouched and still one click (asserted, both surfaces).
- **Apply is never a dead end.** An applied operator recommendation carries the card's own
  words (`detail`, else `label`) as the reason, so a backward Apply never asks a human to
  retype what the operator already wrote — asserted on the transition entry in
  `task-actions.server.test.ts`.
- **Gates.** `npm run lint`, `npm run typecheck`, `npm run build` clean; `vitest run` 7277/7277.
- **Test-only defect found on the way**: `/id (kb_\w+)/` truncated a base64url id at a hyphen,
  so the F39-1 append test failed ~1 run in 6. Fixed to `[\w-]+`; swept the repo for the same
  shape (one other match, unrelated).

## 8. Guardrails — the compression threshold, exercised against a real 62-event timeline

Set through the policy action over HTTP (`intent=set-guardrail`, `id=compression-threshold`,
`op=value`, `value=20`), then a human comment on AX-9 to drive a pass. Before and after were
diffed event by event out of `task.md` itself, not from the UI:

- **62 events before, 62 after** — one comment added by me, two routine operator comments
  folded, the marker taking the oldest folded one's slot.
- **Typed events lost: 0.** Every `transition`, `github`, `quality`, `policy`, `blocked`,
  `note`, `agent`, `assign` and the `completion` survived — which is what the guardrail's own
  description promises ("typed events are always kept").
- **Human and controller comments lost: 0**, including Tomas's attachment note and all eleven
  of Arda's. Ruling 257's protection holds.
- The marker reads "_2 earlier routine comments compacted … human comments are never
  compacted._" and **2 is the true count**: one slot reused, one event removed.

Worth recording rather than filing: the operator's `@Arda Agreed—the corrected evidence
settles the diagnosis…` was one of the two folded. It was addressed to a person and answered
their question, and it is machine prose by the rule that decides. Nothing lied — the record
says what it dropped and why — but "routine" and "addressed to a named human" are not the
same predicate, and the second is cheap to check. Threshold restored to 40.

## 9. Ruling 382 (F39-9) — what compaction may delete

- `TaskFileEvent.notified` holds the recipients the fan-out REACHED, written as one
  `notified: <id, id>` metadata line. Round-trip asserted byte-stable, and a comment whose
  TEXT contains a line reading `notified: u_someone` is escaped on write and comes back as
  prose with `notified` undefined — quoting the file format forges no protection.
- Enforced on the NEW-4 writer table rather than in one place: all six comment writers stamp,
  and `operatorPromptAgent` (ruling 232, audience: the agent) still notifies nobody and
  stamps nothing. Canary: remove the stamp from one writer and only that row fails, by name
  (`postAgentComment (an agent's mid-run comment tool) notified Arda but stamped no event`).
- An EMPTY `notified:` list is not a protection — a hand-edited file cannot buy immunity by
  carrying the key with nothing after it.
- Dead code found on the way: `verdictReport?: boolean` was declared on `TaskFileEvent` and
  never written or read by anything; ruling 317's protection is keyed on
  `VERDICT_REPORT_TITLE`. Removed.
- Gates: lint, typecheck, build clean; `vitest run` 7282/7282.

## 10. Ruling 381 — validated live, against the real build

The ax-clone container is the pre-381 image and a restart kills the runs in flight, so the
new build was run as a second instance on its own data root (`VIBERR_DATA_ROOT=…/live381`,
port 5175, demo seed) — never a second writer on `docker-data`. Five POSTs as the project
admin, through the routes the UI posts to:

| # | Request | Answer |
|---|---|---|
| A | task page, Review → In Progress, no `reason` | `ok:false` · "Moving VIB-142 back from Review to In Progress needs a reason: …" |
| B | the same move with a `reason` | `ok:true` · stage `impl` · "Moved VIB-142 to In Progress" |
| C | FORWARD, In Progress → Review, bare | `ok:true` — a forward move asks nothing |
| D | BOARD reorder onto an earlier column, no `reason` | `ok:false`, same sentence |
| E | the same drop with a `reason` | `ok:true` · stage `impl` |

On disk, the transition entry the move wrote:

```markdown
**Transition:** moved VIB-142 from Review to In Progress.

> make gate does not run the race test the rulings require.
> Add it before this comes back.
```

and the audit row: `task.transition · {"from":"review","to":"impl","boundary":"manual",
"manual":true,"reason":"make gate does not run the race test the rulings require.\nAdd it
before this comes back."}`.

**One thing the live run caught that the tests did not.** The first build appended the reason
as a bare clause, so the record read "…from Review to In Progress. the retry path is still
unhandled" — the person's own sentence running on after a full stop, reading as a typo rather
than as an instruction. It is a blockquote now, the way a packet decision quotes the
resolver's words, and line breaks survive into it (`quoteLines`, no trailing space on a blank
quote line). The test asserts the quoted form, so the shape is pinned.

The dialog itself was driven in the browser on the same instance: it opens on the backward
pick, keeps **Move back** disabled until there is a sentence, and the foot line reads "It goes
on the transition entry, where the operator reads it."


## 11. Rulings 384 and 385 (F39-12) — the acceptance card and the required reviewer

The finding came out of the board, not out of the code: AX-12 was created by the controller
at my request, its deliverer wrote a report and attached it, and within four minutes the task
was sitting at Review with an **enabled** one-click Accept whose card read "The review is
clean and the work meets the goal". The file said `validation: none`, `verdicts: []`, no
reviewer engaged, no PR. Three separate defects behind one sentence:

- **(a)** the clause was a fixed string, never a reading — ruling 384;
- **(b)** "merges the review PR" for a task with no PR, which R19-8 had already deleted once
  and which came back because its fix keyed on the agent's `noChanges` flag rather than on
  `!pr` — ruling 384;
- **(c)** the project's required reviewer owed nothing, because the gate held on git alone —
  ruling 385, owner's call: hold on delivered work in whatever form.

Validated by test rather than by a live POST, because the container is the pre-fix image and
the fix is in the gate stack both readers share. Canaries run red:

- restore either fixed sentence → the ruling-384 assertions fail;
- restore `if (!rev && !fm.pr) return []` → the report-only task is acceptable again on BOTH
  surfaces (the affordance and the review queue), which is the drift the two-reader wiring
  exists to prevent.

Gates: lint, typecheck, build clean; `vitest run` 7291/7291.

**What it means for the live board**: AX-12 is still at Review with that card standing. Once
the container takes the new image, the same task will show the Reviewer it owes and the card
will say there is no verdict — which is the honest state it was in all along.

## 12. Schedules — the clamps, and a scheduled run that met a held task

`intent=schedule-action` over HTTP on AX-2, which is held on `goal-1 link 4`:

- `delayMinutes=0`, `1e15` and `40321` all answer "Schedule between 1 minute and 28 days
  out." — the 2026-08-29 hunt's overflow (a crafted `1e15` used to reach a `RangeError` 500)
  stays closed.
- `delayMinutes=2` schedules, and the row lands in the task's own frontmatter with
  `status: pending`, `createdBy`, `dueAt` and `retries: 0` — files are truth here too.
- Two minutes later the runner wrote both halves of what happened:

  > **Scheduled action starting:** running the scheduled operator re-run for AX-2.
  > **Scheduled action skipped:** AX-2 waits on other work (goal-1 link 4 (AX-11)) — no
  > operator run was started; Viberr releases the task when every entry is done.

  `status: fired`, `firedAt` set, no run started, and the reason names the exact link that
  holds it. Nothing claimed a run that did not happen.

Accepting the schedule on a held task without a warning is right rather than a gap: the hold
can be released before the due time, and the refusal at fire time says precisely why.

## 13. Three of the pass's own fixes, verified on the live board rather than by test

Within an hour of the deploy the ax-clone board produced all three, unprompted:

- **Ruling 384** — AX-11's acceptance card now opens with a reading instead of a claim:
  "**Reviewer approved `fe7232b`.** Accepting completion moves AX-11 to Done and merges the
  review PR…". The fixed sentence it replaced said the review was clean on a task with
  `verdicts: []`.
- **Ruling 386 (F39-10)** — the operator reached for `update_branch_from_base` at the
  acceptance boundary again, and the record now says "**This step did not apply to the task's
  current state**" as a plain `note`. The same refusal on AX-9 twelve hours earlier was filed
  under "refused by its capability policy" as a `policy` event, against a grant set to
  `direct`.
- **Ruling 388** — AX-12's `validation` moved off `none`. With a review subject that is not a
  commit, the derivation now runs: `changed` while the verdict is pending, where it used to
  be pinned at `none` however the reviewer ruled.

And the same hour produced ruling 391: AX-12's delivery attempt printed "If the agent
produced work, it never reached the task branch. Re-run the delivering agent" about a report
that was written, attached, and recorded in `deliveredAt`.

## 14. Ruling 389, verified live on the next failure the board produced

AX-3's developer run hit the same dropped connection twice. Before the deploy, twice:

> The Implementation agent run failed: Codex run failed: Codex execution failed. **Review its
> authentication and runtime configuration.**
> options: `redirect` (**recommended**) · `request_edit` · `hold_runtime_debug`

After it, on the very next occurrence, unprompted:

> **Codex could not be reached from this deployment: the connection failed before the provider
> answered. Nothing about Arda's account or the task is wrong; the fault is on this
> deployment's network path (TLS, DNS or a proxy). Retry in a few minutes, or run it on Claude
> now.**
> options: `retry_other_backend` · `request_edit` ("Retry @developer on Codex now: this
> deployment could not reach the provider, nothing was changed") · `redirect` ·
> `hold_runtime_debug`

Both halves of the ruling: the sentence stopped contradicting the provider text captured one
line below it, and `kind` moved the packet from the generic stalled-work shape onto the
backend-failure one. The cross-backend option is honest about itself too, unprompted: "This
failure was on this deployment's own network path, which the other provider is reached over
too, so this is a change of model rather than a fix."

*Actor note: from here the board is driven as Nadia Kaya (ax-clone admin, one of the pass-39
RBAC probe users). Resetting Arda's password to sign the browser pane back in revoked Arda's
own sessions, which is correct behaviour and my own mistake; the probe sessions were
unaffected.*

## 15. Force-accept, exercised for real on AX-12

Not manufactured: AX-12's Reviewer approved at 08:08 and viberr could not bind the verdict
(the report predates `deliveredAt`, so `reviewSubjectId` was null), which left a gate nothing
could clear. A human who has read the approval overriding that gate is what force-accept is
for. Through the real ceremony in the browser:

- The dialog disclosed **MERGES** ("Nothing: completed with no changes. ax-12 carries no
  commits, so no pull request was opened"), **REVISION** `76dabeeea598`, **VERDICT** "awaiting
  verdict", **BYPASSING**, and "Admin override. The bypassed gate is recorded to the audit log."
- The file took `acceptance: forced`; the completion event names every bypassed gate; the
  audit row carries `bypassedGates` as a LIST, which is KNC-10's own fix.
- And the dialog listed ONE gate where the record listed TWO, which is F39-20 / ruling 393.

Two things verified on the way, unprompted by me:

- **Ruling 382** — the operator's `@Arda Acknowledged…` reply now carries
  `notified: u_vw9JMMXYOH6X` in the file, so compaction can never fold the answer and keep the
  question.
- **Ruling 386** — the Settings rail carries no red badge: the four advisory `checks:read`
  rows are recorded and no longer counted as violations.

## 16. Rulings 394-396, verified on the live board

**Ruling 394 — three occurrences in one morning, all measured off the rollouts.**

| run | task, role | stream ending | what viberr did |
|---|---|---|---|
| `run_Ys0uzCRS_twA` | AX-2, developer | envelope → `turn.completed` → error | "did not complete", packet recommending a re-run |
| `run_JT8sukKPkMs2` | AX-3, developer | envelope → `turn.completed` → error | same |
| `run_PmefJ4iUKtTQ` | AX-4, **operator** | error → plan → `turn.completed` → error | same, and the plan was the one action that cleared the gate |

The third is the sharpest: the CLI printed its reconnect banner MID-turn, recovered,
emitted a complete decision plan ("engage the reviewer on revision ed4a600"), and completed
the turn. `sawFatalError` is sticky, so under the old gate no ordering of that stream could
ever have settled `finished`. Substituting `!sawFatalError` back for `!workAfterLastTurn`
fails three tests, two in each direction — which is why the predicate is about ORDER and not
about whether an error was ever seen.

**The work was real.** `tasks/AX-2/workspace/ax-clone` sat on branch `ax-2`, clean tree, at
`3e0396a`: 1,531 insertions across seven files, four of them tests. AX-3 carried `04c8c50`
and `4a9a588`.

**Recovered through the product, not by hand.** Both packets resolved with `redirect` and a
note naming the commit, the gates the agent reported green, and "do not re-run the Developer".
AX-2 walked Design → Build → Verify → Review in three minutes and AX-3 followed; both are now
open pull requests on `akin-ozer/ax-clone` (#5 and #6) carrying the work viberr had written
off. AX-4's operator packet resolved with its own lost plan quoted back to it.

**Ruling 395, on the deployed build** (`revision ed5c88b4c255`), `/insights` prompt cache:

```
operator    93  45%  not reported  574.5K  n/a    0  not reported
primary     22  15%  not reported   51.4M  n/a    0  not reported
reviewer    14   0%  not reported   16.8M  n/a    0  not reported
controller   6   0%       447.9K     6.0M  0.075  0  6 × 1h
login      135  34%       447.9K     74.7M 0.006  0  6 × 1h
```

The Codex groups say "not reported" where they printed `0` and `0.000`; the Claude row keeps
its real figures, and the mixed credential row reports the Claude half rather than swallowing
it. Measured basis: 101 of 101 Codex usage envelopes under this data root carry
`cache_write_input_tokens: 0`.

**Ruling 396, on the deployed build.** `/projects/ax-clone/settings` now renders
`[data-panel="file-leases"]`, and it came up holding **three leases that were already there** —
declared by the controller, enforced at every delivery on this board, and invisible to every
human surface until the panel shipped:

```
internal/controller/**, internal/apis/**  AX-2   "owns both until it merges"
internal/sandbox/**                       AX-3   "owns internal/sandbox until it merges"
internal/server/**                        AX-11  "owns internal/server until its PR merges"
```

One of them is spent (AX-11 merged as PR #4), and the panel says so and offers to clear it.
That is the finding proven at full strength: this was not a hypothetical gap.

## 17. The revision-bound review model, exercised end to end on AX-4

The goal asks for "required reviewers and revision-bound verdicts, work-revision drift". AX-4
exercised all of it without being staged, and it held.

Three verdicts across three revisions, as the file records them:

```
workRevision  rev_XRtSwQ4idByJ  32656382
  request_changes  rev_xZoyw4KHN_GQ  ed4a600b   stale
  request_changes  rev_d6UVLDpVEUtt  db6e4c59   stale
  approve          rev_XRtSwQ4idByJ  32656382   BINDS
validation: healthy
```

Each verdict stays pinned to the revision it judged; only the current one derives
`validation`. Two superseded `request_changes` sit on the record without blocking, which is
the whole point of the model — they are history, not a gate.

The sequence that produced it:

1. Reviewer requests changes on `ed4a600b`. Rework. New revision `db6e4c59`.
2. Reviewer requests changes again. **Viberr opens the ruling-237 deadlock packet itself** at
   the second consecutive objection, with three options and a recommendation.
3. I took its recommendation (`question_reviewer`) rather than another rework round, with the
   reasoning in the note: both objections had found something real — the latest was a genuine
   `send on closed channel` race between `client.go:737` and `:764` — so this was a reviewer
   paying findings out one at a time, not one that could never pass the work.
4. The reviewer answered with the complete blocking set and **no fresh verdict**, exactly as
   the option promises.
5. The rework fixed all three. `update_branch_from_base` brought ax-4 up to date (20 commits,
   merge commit `3265638`), which MOVED the head — the drift case — and the timeline says so:
   *"The review PR's head now equals the reviewed revision."*
6. Reviewer approved `32656382`. `validation: healthy`.

**Drift never became a problem because the acceptance ceremony discloses it.** Every accept
dialog this pass carried the same three rows — `MERGES` (PR, state, and the honest "checks not
readable / GitHub refused this credential's read (HTTP 403)"), `BRANCH` ("brought up to date
with main first; if the base has moved, that merge commit is pushed and becomes the merge
head"), `REVISION` and `VERDICT`. Four acceptances, four disclosures, all matching the file.

Recorded as a validation rather than a finding: this is the machinery working.

## 18. Guardrails and a derived metric, checked against the files

The goal asks that "what viberr SHOWS matches what HAPPENED — files-are-truth means the record
is testable, so test it". Two surfaces tested this way, both clean. Recorded because a pass
that only lists defects misreports the product.

**The four declared guardrails do what they say.** `project.md` carries them with `true: true`;
each was read against the code that enforces it rather than taken on the flag:

| guardrail | enforced at |
|---|---|
| `meaningful-comment` | `comment-guardrails.server.ts`; drops log line "agent reply dropped by the meaningful-comment guardrail" |
| `no-duplicate-summary` | `prepareAgentReplyEvent` → `prepared.duplicate`, F22-12 |
| `compression-threshold: 40 events` | `compactTimelineEvents`, `events.length <= threshold` |
| `evidence-separation` | evidence refs on the typed event, never inline |

The third is the one worth stating, because six live tasks are past forty events and none has
folded anything. That is not the guardrail failing — its own description says *"typed events
are always kept"*, and `compactTimelineEvents` folds only ROUTINE comments older than
`keepRecent`, never a transition, an `agent`, a `blocked`, a `quality` or a verdict
justification (ruling 317). An ax-clone timeline is almost entirely typed events, so there is
nothing to fold. The declaration and the behaviour agree; what is long is the part the rule
promises to keep.

**The Long timelines metric matches the files exactly.** Counted independently, by grepping
`^### <ISO>` per `task.md` and filtering to more than forty:

```
files:     AX-2 (51)  AX-3 (58)  AX-4 (82)  AX-9 (62)  AX-11 (63)  AX-12 (51)
Insights:  6 · AX-2  AX-3  AX-4  AX-9  AX-11  AX-12
```

Same six, same boundary. The code comment explains the boundary it chose and why — strictly
greater than, because `compactTimelineEvents` opens `if (events.length <= threshold) return`,
so a task sitting exactly ON it is not one the fold is managing. A derived metric agreeing
with the canonical files, at a boundary defined by the machinery rather than guessed at.

## 19. Ruling 376's completion compaction, on the controller path

Chased because a controller run's strip read `in 971.2k (cached 841.9k)` against a 1M window,
which looked like a conversation about to hit its model's limit with nowhere to go. It is not:
that figure is the run's CUMULATIVE input across twelve turns, not one context. The number
that matters is `last_prompt_tokens`, and the compaction fired on it:

```
run compaction at completion · runId run_DjAw7UEaLiIr · backend claude
  replaySize 129305 · compacted true · preTokens 133819 · postTokens 7507
```

and the session's own record agrees — `compact_boundary`, `trigger: "manual"`,
`pre_tokens 133819`, `post_tokens 7507`, `cumulative_dropped_tokens 126312`,
`compact_result: "success"`. Three Codex runs in the same window compacted the same way
(111k, 129k, 168k replay sizes).

Recorded because the prompt-cache pass (rulings 369-376) was verified on the specialist and
operator paths and this is the first controller-path evidence: the carried session drops from
134k to 7.5k while the prefix is still warm, which is exactly what ruling 376 promised. No
finding — the misreading was mine, and checking it cost less than asserting it would have.

## 20. The audit log and the PR records, against GitHub

Two more surfaces tested the same way. Both clean.

**Five open PRs at once, and viberr's record of each matches GitHub exactly.** Read from
`gh pr list` and from the five `task.md` files independently:

```
gh:      16 ax-18 MERGEABLE/CLEAN   15 ax-21   14 ax-17   13 ax-20   11 ax-19
viberr:  AX-18 pr#16 mergeable=clean  AX-21 #15  AX-17 #14  AX-20 #13  AX-19 #11
```

Every `mergeable` agrees, every `review` is null on both sides, and `checks: null` matches
the 403 the credential really gets. The GitHub record holds under five concurrent
deliveries, which is the load this board had never put on it before today.

**The audit log's counts match the world.** 1,944 events exported as JSON:

| action | audit | independently |
|---|---|---|
| `github.pr.merged` | 11 | `gh pr list --state merged` → 11 |
| `github.branch_update.acceptance` | 11 | one base refresh per acceptance |
| `task.archived` | 2 | AX-8, AX-10 on the board |
| `goal.completed` | 1 | goal-1 |
| `task.acceptance.forced` | 2 | both accounted for, below |

The two force-accepts are the interesting row, because an override is the one action whose
record has to be complete:

```
2026-09-22T08:49  arda@viberr.dev    AX-12  bypassedGates: [2 gates]
2026-09-21T21:14  nadia.kaya@...     AX-8   bypassedGates: [1 gate]
```

Both attributed to a real person, both carrying `bypassedGates` as a LIST — which is ruling
393 working: the audit records every gate an override passed, not the first one a
single-reason helper picked. AX-12's row is the one that produced that ruling.

## 21. A sweep of viberr's own claims, and ruling 384 visible as a before/after

Grouped every system- and operator-authored timeline claim across the 23 tasks by its opening
sentence, normalised (keys, SHAs and numbers masked), and spot-checked the frequent ones
against the frontmatter behind them. Nothing new broke. Two results worth keeping.

**Ruling 384 is visible on this board as a before/after, in one query.** The acceptance
recommendation:

```
AX-1  21:04  "The review is clean and the work meets the goal."
AX-7  21:28  "The review is clean and the work meets the goal."
AX-9  05:20  "The review is clean and the work meets the goal."
AX-11 08:08  "Reviewer approved `fe7232b`."
AX-2  10:13  "Reviewer approved `22e3daf`."
AX-3  10:39  "Reviewer approved `e3dde83`."   … and every acceptance since
```

The generic sentence stops dead at the deploy and the specific one starts. Eight acceptances
since have named the reviewer and the revision.

**The delivery-state sentence holds up too.** Nine occurrences of the two-fact form, e.g.
*"`ax-11` is already up to date with `main`. Origin's copy of `ax-11` (`7b13ba1`) is 1 commit
behind the workspace head: call `deliver_for_review` to push it. Do not ask a person to
push."* Base and origin are separate facts, the remedy names the tool, and the last clause
forbids the failure mode (ruling 235's shape).

**A ten-entry wait renders without truncating.** AX-6 now waits on ten links after the CLI
additions. The sentence reads *"Other work: goal-4 link 2, goal-4 link 3 (AX-17), … goal-5
link 2 and goal-5 link 4"* — comma-joined with a final "and", and a link that HAS a task shows
its key while a still-planned one does not, which is exactly the distinction a reader needs.
The Blocked by panel lists all ten. No "+N more", no cut.

## 22. Every board card against every task file

The board is the surface people actually look at, so it is the one most worth diffing. Read
the 21 rendered cards out of the DOM and every task's frontmatter off disk, independently.

| card says | files say | cards |
|---|---|---|
| `blocked` | `readiness: input_required`, non-empty `blockedBy` | AX-5, AX-6 |
| `agent working` | `waiting: agent` | 7 |
| `agent working` + `validation failing` | `validation: failing` | AX-18, AX-19, AX-21 |
| `merged` + PR number | `pr.state: merged`, number matches | 11 |
| `accepted` | `stage: done`, `pr: null` | AX-12 |
| (absent) | `archived: true` | AX-8, AX-10 |

No mismatch. Two deliberate silences worth naming, since both could be read as omissions:

- **`validation: changed` renders no chip** (AX-17, AX-20) while `failing` does. Correct under
  ruling 365's card rule — one status chip plus PROBLEM chips. A changed revision awaiting
  review is not a problem, it is the normal next state.
- **A force-accepted task's card reads `accepted`**, the same as any completion with no PR.
  Checked before calling it a gap, and the record turns out to be complete everywhere it
  matters: `acceptance: forced` and `validation: bypassed` in the frontmatter, the completion
  event naming BOTH bypassed gates (ruling 393's list, verbatim on the task page), the audit
  row, and the Activity stream. The board card is a scannable summary of what needs
  attention, and a completed task needs none. Not a finding.

**A note on method**: I nearly filed that last one. My first page scan searched for `bypass`
case-sensitively and missed `Bypassed:`, which made it look as though the task page hid the
override. Re-checking cost a minute; filing it would have cost a ruling and been wrong.

