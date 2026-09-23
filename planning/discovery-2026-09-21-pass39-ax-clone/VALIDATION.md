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


## 23. Rulings 405 and 406, confirmed by GitHub nine minutes after viberr refused

The AX-18 sequence is the cleanest before/after this pass produced, because GitHub settled
the question independently and viberr's own record shows both sides.

**17:07:29** the Surface Developer reports the conflict resolved:

> Resolved the only conflict in `internal/cli/render.go`, preserving AX-18 watch rendering
> and retaining AX-17's shared helpers/current get columns. Committed as `d44e874` on
> `ax-18` (parents `5ae0752`, `1d860bb`). `make gate` passed.

**17:07:51** the operator pushes it, then plans `transition_stage`. Refused.
**17:08:05** a second drive plans `transition_stage`. Refused, same sentence.
**17:08:30** a third drive reads the refusal and plans `update_branch_from_base`, the exact
remedy the refusal names. It succeeds and moves nothing — the branch is already current.
**17:08:32** viberr writes "treating that as a deliberate hold", stamps `heldAtStage`, and
pauses coordination.

What the file held at that moment:

```yaml
  mergeable: conflicting
  paths: { headSha: 5ae0752… }
  headSha: d44e874…
```

What GitHub said at **17:17**, asked directly:

```
PR16 mergeable=MERGEABLE state=CLEAN
```

So the conflict was gone before the first refusal, viberr refused on a verdict measured
against a superseded commit (ruling 405), and then blamed the operator for the consequence
(ruling 406). Releasing it took a human stage move:

```
AX-18 stage= review waiting= agent held= null
### 2026-09-22T17:17:02.144Z · transition · user:… (Arda)
**Transition:** moved AX-18 from Verify to Review.
```

Both fixes carry a canary that reproduces the original text verbatim.

## 24. Ruling 403's zero, measured rather than argued

Six Codex rollouts, read hours after the runs finished:

```
rollout-2026-09-22T16-47-16-…  last@428/429  token_count_after=[]
rollout-2026-09-22T16-42-53-…  last@340/341  token_count_after=[]
rollout-2026-09-22T16-45-51-…  last@410/411  token_count_after=[]
rollout-2026-09-22T16-40-01-…  last@524/525  token_count_after=[]
rollout-2026-09-22T16-41-56-…  last@278/279  token_count_after=[]
rollout-2026-09-22T16-37-52-…  last@297/298  token_count_after=[]
```

The compaction is the final line every time, so the post size is not late, it is absent.
Against that, the Claude CLI's own `compact_boundary` envelopes on the controller path DO
carry it — `post_tokens` 6371, 7507, 7279, 8284, never zero — which is why 2 of 84 notes on
this board had a figure and 82 did not.

## 25. Ruling 131's dependency floor, checked on the live board rather than in the test

AX-5 stores `readiness: input_required` with `blockedBy: [goal-3 link 2, goal-4 link 1]`.
Read as stored, its card would demand human input from a person who has nothing to give it.
The single caller of `deriveReadiness` passes `dependenciesListed`, and the floor (rank 3)
wins. Asked of the running app:

```
data-board-card="AX-5" … |AX-5|A|ax ssh: interactive shell into a live task|blocked|
```

Correct, and the surface says the true thing. No finding.

## 26. The RBAC surface, audited where a non-member probe would land

ax-clone carries all four project roles (2 admin, 1 maintainer, 1 contributor, 1 viewer).
Membership is the outer gate (R15-4), enforced by the layout loader for everything nested
under `projects/:slug` — so the interesting question is the routes that are NOT nested.
Every one of them gates for itself:

| route | guard |
|---|---|
| `projects/:slug/tasks/:key/attachments/:file` | `requireUser` + `requireProjectMember`, traversal-refusing resolver, `nosniff`, CSP `sandbox`, 50MB bound |
| `resources/run-log` | `requireUser` + `requireProjectMember` |
| `resources/session-export` | `requireUser` + `requireProjectMember` |
| `resources/controller` | `requireAuth` + CSRF + `scopeIsReachable` (any-member) |
| `resources/backend-login` | `requireUser`, keyed to the caller's own session |

No gap found. Recorded because the absence is the result.

## 27. The audit log, checked against decisions I made myself

Five human actions this afternoon, then the CSV export read back. Every one is there, with
the actor resolved and the option kind recorded — not just that a packet closed:

| time | task | audit row | option kind |
|---|---|---|---|
| 17:02:59 | AX-21 | `task.packet.resolved` · arda@viberr.dev | `custom` (agent-authored ask-human options) |
| 17:03:28 | AX-18 | `task.packet.resolved` · arda@viberr.dev | `redirect` |
| 17:03:50 | AX-20 | `task.packet.resolved` · arda@viberr.dev | `question_reviewer` |
| 17:31:03 | AX-18 | `task.packet.resolved` · arda@viberr.dev | `question_reviewer` |

AX-23's acceptance is not a packet resolution and is recorded as its own chain, in order:

```
17:16:37  github.branch_update.acceptance  ax-23   {"status":"already_current"}
17:16:40  github.pr.merged                 #17     arda@viberr.dev
17:16:41  task.transition                  AX-23   {"to":"done","boundary":"human","via":"accept_completion"}
```

And the manual release of AX-18's stranded hold carries `"manual":true`, distinguishing it
from the operator's own `auto` transitions, which carry no user id at all. 2,219 rows total.

## 28. Custom stages and boundaries, and the sentence that resolves itself

`project.md` declares six stages and five transitions, four `auto` and `review → done`
`boundary: human, locked: true`. The Policy page renders exactly that — "6 stages · 5
transition rules", Review → Done as "Human decision · locked · V1" — and then does the thing
this pass has been rewarding everywhere else: instead of stating the general rule and
leaving the reader to apply it, it resolves it against this project's live configuration.

> By default a human accepts completion … The one exception is an operator running at full
> autonomy with **Accept completion into Done** set to **Direct** … **On this project: the
> operator (Operator) runs at full autonomy without the Direct accept grant, so the exception
> is not active**: every task still needs a human to accept completion into Done.

The RBAC table does the same with its own exceptions — it says maintainer-and-above may
accept, then states plainly that a contributor who OWNS a task may accept it and resolve the
non-acceptance options on its packets. A table that quietly contradicted its own footnote is
the shape ruling 310 was about; this one names it. No finding.

## 29. Disposition audit — all 34 findings, before claiming anything is finished

Pass 16's lesson ("run this before any 'fixed everything' claim") applied to this pass. The
audit matched each `F39-*` heading against the rulings that cite it, then checked the
leftovers in code rather than trusting the write-up:

- **30 of 34** are cited by a numbered ruling (377–408).
- **F39-2** (the model picker offers no plain `opus`) carries an explicit non-fix
  disposition: *"Noted, not blocking: `opus[1m]` was set for the controller and runs."*
- **F39-1, F39-3, F39-10** were fixed without a numbered ruling, which is why the heading
  match missed them. Verified in code, not in the write-up:
  - `instance_health({ probe })` ships, with *"PROBE BEFORE YOU PROMISE A GATE: a gate
    command whose binary you never checked is a promise every task on the board inherits
    and quietly fails"* in the tool description.
  - `save_knowledge_base` takes `doc.append: true`, described as the way to build a long
    document a section at a time.
  - The `update-task-branch` boundary refusal returns `noop`, so the record stops blaming a
    capability policy that refused nothing.

One defect found BY the audit: the `doc.append` description cited **F39-1** for the
7,356-byte failure that is actually **F39-3**. A wrong cross-reference in a tool description
is read by every controller run; fixed.

Nothing is outstanding.

## 30. The deploy, and ruling 407 confirmed on the running build

Deployed `7f972b2b` at 19:34 UTC, carrying rulings 403-412. `/resources/health` reports
`status ok · revision 7f972b2b`, matching HEAD.

Before the fix, /insights read:

> **Branch & PR traceability · 95%** — 18 of 19 delivered tasks carry branch + PR — **AX-12**

After, on the same board and the same data:

> **Branch & PR traceability · 100%** — 19 of 19 delivered tasks carry branch + PR

AX-12 still has no PR and never will; it is no longer counted as owing one.

Ruling 395's fix is visible on the same page and still holding: the prompt-cache table reads
`not reported` for the Codex run kinds rather than `0.000`.

## 31. Ruling 396's lease panel, used for the collision it exists to prevent

The panel renders on the deployed build ("0 leases · No file leases. Every task may change
any file its work needs."). Added the real one: `internal/sandbox/**` and
`internal/runtime/**`, held by AX-20, because AX-20 is rewriting the sandbox stdout/stderr
lifetime and both AX-21 and AX-5 are waiting on that fix landing. Saved, and the file says:

```yaml
fileLeases:
  - paths:
      - internal/sandbox/**
      - internal/runtime/**
    taskKey: AX-20
    reason: AX-20 is rewriting the sandbox stdout/stderr lifetime and its adoption path; AX-21 and AX-5 both wait on that fix landing.
```

The whitespace-separated glob line split as designed, the holder picker wrote the task key,
and the reason is stored for the refusal to quote. This is the lease the improvement point
above says nothing proposes: it took a human noticing, which is the point being made.

## 32. Ruling 225 on the live board: a clock is not a person

Five tasks carry `waiting: human` in their files. The board header reads:

> 22 tasks · **1 waiting on a human in this project**

That is correct, and the cards say why. Four of the five rest on a scheduled operator
pick-up after the Codex usage window reopens, and viberr derives `schedule` for exactly that
shape (ruling 225: `waiting: human` in the file, no packet, no recommendation, nothing a
human could accept, and a pending occurrence that will pick the task back up on its own):

```
AX-18  review   waiting on a human
AX-19  verify   resumes 23:13
AX-20  review   resumes 23:13
AX-22  review   resumes 23:13
AX-24  review   resumes 23:13
```

Only AX-18 genuinely owes a person anything, and it is the one the header counts. A board
that counted the file's value would have demanded attention on four tasks that are resting
by design.

## 33. The visual sweep, dark and light, phone and desktop

Board, task detail and the controller conversation, at 375x812 and at the pane's desktop
width, in both colour schemes. No layout breakage: the board's filter chips wrap, cards keep
their pill rows, the task hero's stage/status/goal chips stay on one line, and the
controller's long prose with inline code spans wraps cleanly at phone width.

Two things the sweep surfaced that reading the files would not have:

- The `blocked` pill renders on AX-5 and AX-6 at phone width, which is ruling 131's
  dependency floor (validated in section 25) reaching the smallest surface.
- AX-24's goal body carries the controller's ownership fence verbatim, and it names the
  tasks that hold the other side: *"`internal/controller`, `internal/runtime`,
  `internal/sandbox` and `internal/store` are core-owned AND are being actively rewritten
  right now on AX-19 and AX-20 — read them freely, write nothing in them."* That is the
  cross-task awareness the controller has and the operator does not.

AX-24 still reads "link 2 of 8" in its frozen header: it was created at 19:12, and ruling
404 deployed at 19:34. Correct by design (no migration); the next chain task will carry the
new form, and that is the live check to make when the board resumes.

## 34. Schedules held across the pause, and ruling 413 verified in the prompt itself

The Codex usage window reopened at 20:12 UTC. All four tasks that carried a scheduled
`run-operator` picked themselves up at **20:13**, unattended, across a container restart in
between:

```
[20:13:25] AX-19:verify/agent  AX-20:review/agent  AX-22:review/agent  AX-24:review/agent
```

One packet answer set all four (ruling 326's cross-task resolution), the schedule survived
two redeploys because it lives in the task file, and nothing was run against the rate-limited
account in the meantime.

**Ruling 413, read out of the operator's own run input** rather than asserted:

```json
"collisions": [
  { "taskKey": "AX-18", "prNumber": 16, "paths": ["internal/cli/render.go"], "partial": false },
  { "taskKey": "AX-19", "prNumber": 11, "paths": ["docs/manifests.md", "internal/apis/types.go"], "partial": false },
  { "taskKey": "AX-20", ... }
]
```

The shared files are named individually, so a directive can say which file another task is
holding. Two of the four resumed runs carry no `collisions` key at all, which is the absent
case working: no open review PR, or nothing overlapping.

Before this, the same fact existed only on the human review queue, and every cross-task
correlation on the board was done by a person.

## 35. Ruling 396's whole loop: settings panel to agent prompt

Section 31 got the lease into `project.md`. The claim still untested was the other half —
that "every agent on this project is told which paths are leased before it starts". Read out
of the first agent run dispatched after the window reopened (AX-22's, at 20:14 UTC):

```
### Files another task owns right now (ruling 245)
Do NOT change these. They are leased until their holder merges, and a delivery that
touches one is refused before it reaches GitHub.
- `internal/sandbox/**`, `internal/runtime/**` → **AX-20** — AX-20 is rewriting the
  sandbox stdout/stderr lifetime and its adoption path; AX-21 and AX-5 both wait on
  that fix landing.
```

Human types it in settings → `project.md` holds it → the delivery guard enforces it → and
the agent is told, with the reason quoted verbatim, before it starts. That is the complete
loop ruling 396 was written for, and the part that was rendered by nothing when this pass
began.

Note what the agent receiving it is: AX-22's Gateway work, which has no business in
`internal/sandbox` at all. The injection is unconditional rather than targeted, which is the
right call here: an agent that learns the boundary before it reaches for the file never
spends the run finding out.

## 36. Ruling 403 verified live, and the same record exposing ruling 414

The first compaction on the post-403 build, AX-24's reviewer at 20:21:29 UTC, left this on
the timeline:

```
20:21:29.527  Context compacted at the end of the run: Viberr summarized Reviewer's
              conversation from 140k to a summary while its prompt cache was still warm ...
20:21:29.530  Context compacted: the provider summarized Reviewer's conversation from 140k
              to a summary (auto). ...
```

**Ruling 403 does what it was coded to do:** "to a summary", never "to 0k tokens" again.

**And the same pair is F39-40 on the live build.** Two notes 3 ms apart for one compaction,
the second a provider "(auto)" compaction that never happened. The rollout
(`rollout-2026-09-22T20-13-30-01a0cac0-…`) says what really happened:

```
290  compacted
291  event_msg thread_settings_applied
292  event_msg token_count input=0 total=9894   <- the size, measured
293  event_msg item_completed ContextCompaction
```

So "a summary" was not the honest answer either: the size was 9,894 tokens, in the file, 13
ms after the marker. Ruling 403's null rendered a phantom's missing figure truthfully; ruling
414 removes the phantom. After ruling 414 deploys, the same rollout shape must produce ONE
note reading "from 140k to 10k tokens". That is the next live check.

Board-wide, measured by replaying the pre-414 parser over the 69 rollouts that compacted on
2026-09-22: every one of the 70 compactions came out as a sized event plus a sizeless
phantom, and the task files hold 140 compaction notes for them.

## 37. Ruling 410 verified live on Codex (AX-24)

The operator's own round-two duty, on a board that runs every operator on Codex:

```
20:35:13  reviewer: request-changes on 78e764c            (round two)
20:35:39  operator -> @Reviewer "Review the current AX-24 revision again without
          requesting rework first. Because this is your second consecutive
          request-changes verdict, enumerate every issue that would still block ..."
20:45:51  reviewer: request-changes on 78e764c, the complete list (the answer)
20:46:19  operator -> @Surface Developer "Rework AX-24 against the reviewer's complete
          blocking set ..."
20:54:44  pushed 952e62e
21:08:13  reviewer: request-changes on 952e62e -> packet "3 times running"
```

Exactly the sequence ruling 410 prescribes: the question at two, one rework against the whole
answer, a person at three. No human decision was spent on round two. The duty reached the
operator through the skill; the agent-reply turn instruction still said "move back and
rework" and was corrected (ruling 416(b)'s note). The round-three packet itself recommended
the question again, which is ruling 416(b).

## 38. The owner's model switch: GPT-6 Luna and Opus 5.5, verified at every layer

Deployed `faa3d417` at 21:54 UTC (the owner's call to kill AX-20's in-flight review rather
than wait). `/resources/health` reported `revision: faa3d417256e`; the container carries
`codex-cli 0.156.0` and `2.1.280 (Claude Code)`.

**The account's model list, by client version.** The first Codex run on the new build wrote its
own `models_cache.json` (the run's private CODEX_HOME, ruling 181):

```
fetched_at 2026-09-22T21:54:51Z  client 0.156.0
  gpt-6-astra, gpt-6-sol, gpt-6-luna [low..max], gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5
```

The shared home's cache, fetched by 0.153.4 at 21:07, lists no `gpt-6-sol` or `gpt-6-luna`.
That is `minimal_client_version: 0.155.0` doing exactly what it says.

**The switch went through the controller**, one instruction. It read its own standing rule,
listed the global agents, checked `instance_health` for the SDK versions, then:
`save_global_agent` x3 (developer, reviewer, surface-developer), `update_agent_deployment` x4
(operator, developer, reviewer, surface-developer), and `save_knowledge_base` replacing the
standing rule with a version guard (`replaces: 131f7d50ffb4`). It read `get_project` back to
confirm, flagged the one run that had started on the old model, and changed nothing else.
On disk: all seven profiles `model: gpt-6-luna`, `effort: max`; Rule 1 of the standing rules
now names gpt-6-luna and Opus 5.5 and says gpt-5.6-luna must not be deployed or templated.

**Opus 5.5, with no setting changed.** The controller's own run (`run_mAefMwf38FA-`) opened
with `model: claude-opus-5-5[1m]`, `claude_code_version: 2.1.280`: the stored `opus[1m]`
alias now resolves to 5.5. The Controller tab's description changed with it, from "Opus 5 with
1M context" before the deploy to "Opus 5.5 with 1M context" after. Every controller turn this
pass before 21:54 ran on `claude-opus-5[1m]`.

**GPT-6 Luna in the rollouts themselves** (`turn_context.model`): the AX-20 operator at
21:58:41, the AX-20 reviewer it re-dispatched, and the AX-19, AX-22 and AX-24 operators, all
`gpt-6-luna` / `max`. The one exception is the AX-20 review boot recovery restarted at 21:55:26,
a minute before the switch, on `gpt-5.6-luna`; it was interrupted from the task page and the
operator re-dispatched it on the new model.

The controller noticed one more thing and said so rather than guessing: a fixed line in its own
context still read "Opus 5 ... claude-opus-5[1m]". Its prompt is recorded on the session's
first request and replayed until compaction (ruling 373's `snapshot`), so the model identity
the CLI wrote at the start of the conversation outlives a model change. It trusted the SDK's
session start record over that line, which is the right call; noted, not worked, since the
next completion compaction re-renders it.

## 39. Ruling 415 verified live: the decision the operator lost is now in its prompt

AX-19's operator turn at 21:59:41 UTC (read out of its rollout):

```
humanDecisions: 5
  21:59:40 Arda | Let the rework continue ...        | Rework ONCE against exactly the four blockers ...
  19:34:20 Arda | wait for the Codex window ...      | Wait for the window. Not retrying on Claude ...
  19:27:09 Arda | answered with a custom directive   | Round five, and my round-four instruction was not honoured ...
  18:48:39 Arda | answered with a custom directive   | Round four, and the pattern has changed ...
  17:41:28 Arda | Let the rework continue ...        | Rework, not another question. I asked this reviewer ...
timelineOlder: "111 older entries are not shown, newest first. This turn cannot fetch them.
  What in them still binds you is carried in this snapshot: `humanDecisions` ..."
```

The round-five words that the 20:13 turn never saw are there, and the window note no longer
sends a Codex plan to a tool. The operator's plan: `run_agent developer` with the four blockers
of the new decision, exactly as bounded.

Packets resolved through the task pages this hour: AX-19 (round 6), AX-22 (round 4) and AX-24
(round 3), each "Let the rework continue" with a note that bounds the one rework to the
reviewer's own complete list. AX-18 accepted: PR #16 merged at 21:45:52 UTC (`acfaaf3`).

## 40. Rulings 414 and 417 verified live (2026-09-22 22:08-22:15 UTC, build `faa3d417`)

**Ruling 414: one Codex compaction is one record, with its measured size.** The first three
completion compactions on the new build, read from the task files and, independently, from the
audit export (`/org/settings/audit-export?format=json&project=ax-clone&since=2026-09-22T21:54:00Z`):

| task | timeline note (the only one for that run) | audit row `task.agent.compaction` |
|---|---|---|
| AX-20 reviewer | "from 116k to 8k tokens" 22:08:37.979 | `trigger: completion, preTokens: 116475, postTokens: 8248` |
| AX-19 developer | (same shape) 22:13:51 | `trigger: completion, preTokens: 118844, postTokens: 8885` |
| AX-22 developer | "from 103k to 9k tokens" 22:14:46.817 | `trigger: completion, preTokens: 103142, postTokens: 8916` |

One note per run, no "(auto)" twin, one audit row per run, and every size is a measured
figure. Before 414 each of these would have been two notes and two rows, one of them a
compaction that never happened.

**Ruling 417: the operator leases files itself.** Two operators used `lease_files`
unprompted within five minutes:

- AX-24, 22:11:38: leased exactly `internal/cli/cli.go`, `internal/cli/cli_test.go`,
  `internal/client/client.go` ("AX-24's open PR overlaps AX-21 on these paths ... hold only the
  shared paths until merge"). The three paths are the ones `collisions` named. It did not lease
  a tree.
- AX-19, 22:15:25: leased `docs/manifests.md`. AX-22, which also changes it, got the policy
  note "Files leased by another task: AX-19 now holds `docs/manifests.md` (leased by its
  operator: ...)" on its own timeline.

`project.md` `fileLeases` holds both, and the audit has two `project.file_leases.updated` rows
with `by: operator` and the holder. The next AX-21 delivery that touches `internal/cli/cli.go`
is the first chance to see a lease refuse a push.

## 41. Rulings 419, 420 and 421 on the live instance (build `da626a22`, deployed 22:59 UTC)

**Before the deploy, an isolated preview.** A production build served from a COPY of the data
root (`projects/`, `state/`, `agents/`, `kb/`, `skills/`; no `runtimes/`, no writer lock) on
port 5174, with a different `VIBERR_SECRET_ENCRYPTION_KEY` so no sealed PAT or pasted key could
decrypt, and the dev credential variables blanked. It could not reach GitHub or bill a run: the
page showed "Claude not connected". The session cookie is shared across ports, so the owner's
sign-in carried over. Production mode was needed because better-auth names the cookie
`__Secure-viberr.session_token` there. Layout bugs the preview caught before any user did: the
phone switcher overflowed the head (a select's min-content is its longest option), fixed with
`min-width: 0` and `flex: 1 1 0`.

**Ruling 419, measured live** (`/projects/ax-clone/controller`, 6 chains, 3 conversations):

| | before | after |
|---|---|---|
| desktop 1440×900: Conversations panel top | 4,419px | 141px |
| desktop: page scroll height | 4,700px (10,876 at 840px) | 1,393px |
| desktop: rail | scrolls with the page, 4,539px | sticky, 760px, own scroll (3,645px) |
| phone 375×812: page scroll height | 18,234px | 5,253px |
| phone: lands at | the transcript's end, header scrolled off | the top; composer at y=667 |
| phone: horizontal scroll | none | none (375 = 375) |
| phone: reply text column | 234px | 263px |
| console role label | "Controller · supporting" | "Controller" |
| finished-turn footer | "thread can be re-engaged" | "send a message to continue the conversation" |
| settled chains | full link lists (goal-1 479px) | folded: "4 of 4 done" |

The Cancel goal dialog on goal-4 (opened in the preview, closed with "Keep it running", nothing
posted) read: "A cancelled chain cannot be resumed, and none of its 2 unstarted links will ever
start. … goal-6 link 1, goal-6 link 2, goal-6 link 3 and goal-6 link 5 wait on those unstarted
links and would wait forever unless their waits are changed."

**Ruling 420, live:** the Goals rail reads "waits on goal-4 link 2 (AX-24), goal-4 link 5
(AX-21), goal-4 link 6, goal-4 link 7, goal-5 link 1 (AX-5), goal-5 link 2, goal-5 link 4,
goal-4 link 3 (AX-17, done), goal-4 link 4 (AX-18, done) and goal-4 link 8 (AX-23, done)".
Before: "… goal-5 link 2 and goal-5 link 4 (goal-4 link 3 (AX-17), … are done)".

**Ruling 421, the first operator turn after the deploy used it.** AX-20's reviewer run was
killed by the deploy. The re-invoked operator's first turn (23:00:34) dispatched the reviewer
with "If changes remain, name the complete set of blockers on this revision, including anything
you would otherwise defer to a later round", flagged `completeness: true`. The task file shows:

```
  - profileId: reviewer
    ...
    question:
      kind: completeness
      runId: run_-CyaNrs8trRb
      at: 2026-09-22T23:00:36.276Z
```

The verdict that run returns is the second half of the check.

## 42. Ruling 421 end to end, and ruling 422 live (builds `da626a22` and `594d3766`)

**Ruling 421, all three open review loops.** After the 22:59 deploy the operators flagged their
next review dispatches with `completeness: true` without being asked: AX-20 (23:00:36,
`run_-CyaNrs8trRb`), AX-22 (23:09, `run_Mq5ulEtFW_jq`) and AX-24 (23:09, `run_uKj-cBg1rwD4`), each
stamped on the reviewer's engagement. All three reviewers answered with `request_changes`, and
each verdict carries `answers: completeness`. The three packets raised at 23:11-23:19 (AX-20
round 6, AX-22 round 7, AX-24 round 6) all read:

> This objection is @Reviewer's answer to the completeness question: the run that returned it was
> asked for everything @Reviewer would still block on, on `c5001a3`, and this is the list. Asking
> again would get the same list. The move it leaves is one rework against exactly this verdict.

The recommended (pre-selected) option on each is "Rework once against this verdict". "Ask
Reviewer what else it would block on" is unrecommended, with "It was asked this with its review
of `c5001a3` and answered; asking again repeats that." Before 421, four packets in 45 minutes
recommended the question.

**Ruling 422: the developer that refused now reads.** Deployed at 23:23 with no run in flight
(all three tasks were waiting on my decisions, so the deploy cost nothing). The first runs on
the new build:

- AX-20 developer (`rollout-…T23-24-56`), the same role whose 22:13 report said "the
  workspace-only filesystem boundary prevented access": its contract now reads "- Read-only
  exception: the knowledge-base folder `/data/kb/ax-clone-rulings` is yours to READ …", and its
  first commands are `cat /data/kb/ax-clone-rulings/architecture.md && cat
  /data/kb/ax-clone-rulings/environment-and-gates.md`.
- AX-24 surface developer (`…T23-25-31`): `cat …/surface-contract.md && cat …/architecture.md`.
- Operator runs (`.operator-scratch`) carry no workspace contract, and so no exception, as intended.

**Ruling 419(f) and (h), live:** the transcript labels my messages "Arda", not the address, and
all six chains carry "About this chain".

## 43. Rulings 425 and 427 on the live instance (build `c46f3ceb`, deployed 00:26 UTC 2026-09-23)

Deployed with every live task waiting on me (AX-20 round 7, AX-22 round 9, AX-21 held), so no
run was cut.

**Ruling 427, the never-pushed probe.** Before the deploy, AX-20's `pr` read
`headSha: c5001a3, unpushedRevision: null` while `workRevision.headSha` was `7ce74b2` and the
workspace branch held `7ce74b2` on top of `c5001a3`. Probed from the host the same hour:
`GET /compare/7ce74b2…c5001a3` answered 404 and `GET /commits/7ce74b2…` answered **422 "No
commit found for SHA"**. First reconcile on the new build:

```
"unpushedRevision": {"revisionSha": "7ce74b2f81ab…", "prHeadSha": "c5001a34935f…", "relation": "unknown"}
```

**Ruling 425, the Goals rail.** Read from the live DOM right after the deploy:

```
held | AX-6 | End-to-end test harness covering every n… | waits on 6 · 4 done
pending |  | Failure semantics and admission hardening | waits on 4
done | AX-14 | Documentation: manifest reference and a … |
held | AX-5 | ax ssh: interactive shell into a live task | waits on 1 · 1 done
active | AX-22 | Gateway data path: actually proxy model traffic |
```

AX-6 and AX-5 read "held", no longer "active" (renamed "blocked" at 00:40 to match the board card's
word for the same tasks). AX-22 reads "active" because it has no wait. Each
wait is a count. Layout was checked before the deploy in a production preview (copy of the data)
at 1440×900 and 375×812, light and dark: at 1440 the rail gives the list 258px and the rows
stack; at 375 there is no horizontal overflow.

**U39-7 live:** the packet note box reads "e.g. anything the operator should also know" on the
AX-20 and AX-22 deadlock packets.

## 44. Ruling 424 on the live board, and the AX-20 base problem that led to 429

**424, first operator turns on the new build (00:27).** Both operators ran on reports that before
the deploy had drawn a refused `update_branch_from_base` (AX-20 three times, AX-22 three times).
Neither planned one. AX-20's directive said instead: "The delivered revision `7ce74b2` is not yet on
PR #13; include this fix in your committed work so the operator can deliver the updated revision
before the next review." That is 427's record, read from the snapshot.

**Why 429 exists (00:41 to 00:59).** AX-20's developer asked for main (AX-19's
WorkspaceController) to build the regression the owner asked for. The operator had no door. The
refresh was refused at Review (162/424), and the move back to Verify was refused at 00:47 with
"rework needs a failing verdict or a revision that changed after one; this task has neither". The
task's `validation` was `changed`. The controller, asked by the owner, moved AX-20 back as the
owner's move at 00:57:02. The operator refreshed at 00:57:32 ("29 commits merged in, merge commit
`b0ad2f0`"), and the developer was dispatched at 00:59:46. With 429 the operator does that itself at
Review, and the refusal says where the re-verdict is given. (429 is verified by tests; it was not
yet deployed at this point.)

## 45. AX-20 merged, and the chain released everything it held (01:15 to 01:17 UTC)

The reviewer approved `e166b1b` at 01:15:11, the WorkspaceController-backed regression included.
The operator recommended acceptance at 01:15:28. I accepted at 01:16. The ceremony merged PR #13
at 01:16:13 and deleted `ax-20`. Within 70 seconds the board went from 3 live tasks to 5, with no
person involved:

```
[04:15:51] [3 live] AX-20:review/human AX-21:verify/none AX-22:review/agent
[04:16:21] [4 live] AX-5:triage/agent AX-21:verify/agent AX-22:review/agent AX-26:triage/agent
[04:17:21] [5 live] AX-5:design/agent AX-21:verify/agent AX-22:review/agent AX-26:design/agent AX-27:triage/agent
```

The rulings behind that: AX-21's and AX-5's holds released (131(e)). goal-3 link 4 ("Suspend and
resume", AX-26) and goal-4 link 7 ("ax describe", AX-27) started once their waits cleared (398).
Each new task's operator advanced its auto boundaries on its own.

## 46. The 02:17 deploy (build `9b5bef86`, rulings 429-436 and U39-9 to U39-25)

The board never went quiet (six live tasks, four with an agent running), so I deployed into it
and watched the restart path instead. Every in-flight task's working tree survives a restart
(`reclaimTerminalTaskWorkspaces` touches Done tasks only), so the cost was four interrupted runs,
not lost work.

- **Served build.** `npm run deploy` read back "serving 0.19.0 @ 9b5bef860853 (env) built
  2026-09-23T02:17:12.419Z".
- **Boot recovery (ruling 177).** AX-21 and AX-28 got "Interrupted by a restart" notes naming
  the runs (`run_WkHvyu4Oz_En` reviewer, `run_OI-7E7uwlbCp`), and all four operators were
  re-invoked at 02:17:25.
- **Ruling 433's plan schema is accepted by the provider.** The re-invoked Codex operators'
  plans executed within twenty seconds: AX-30 at 02:17:41 ("Implement the Core half of AX-30 …
  stop before changing `cmd/ax` or `internal/cli`") and AX-29 at 02:17:45. A strict-schema
  violation would have failed every Codex operator run with `invalid_json_schema`.
- **U39-24, the reader's zone.** The controller's first post-deploy answer quoted "PR #13 at
  04:16" and "PR #20 (AX-26) … at 04:54", which are 01:16 and 01:54 UTC in Istanbul, the zone
  the page prints. Before the deploy the same conversation had quoted bare UTC clocks.
- **U39-25, the inputs headline.** The same conversation's two turns, before and after:
  "Run inputs — supporting engagement · NO canonical anchor · … · 0 MCP servers" (05:06:26) and
  "Run inputs — controller turn · persona 39488 chars · prompt 9718 chars · 1 skill · 2
  knowledge bases · 2 MCP servers" (05:23:39).
- **Ruling 436, paged reads.** Asked to check §9 of the rulings against `executor.go` (57,835
  characters) and `local.go` (55,216), which it could not open before, the controller "read both
  files to the end", corrected three places where §9 contradicted the code (where the execution
  record lives, what a workload that finished during a restart reports, and where the signal
  result comes from), and found a real gap: a signal that hits only the command, SIGXCPU from
  the CPU-time limit among them, is reported as `ExitNonZero` 152 rather than
  `SignalTerminated`. I asked it to open the follow-up task.
- **Ruling 434 was not exercised, and its text was wrong.** "Send back for another attempt" on
  AX-5's stall packet went through the operator, whose dispatch always starts a fresh, anchored
  run (`01a0cc0e…`, a 3,127-character anchor), and the Developer confirmed its commit at
  02:19:36. Only an @mention or an answered question resumes a session. The ruling and F39-56
  now say so; the fix stands for those two paths and for the honest class.
- **Not yet seen live:** 430 (a plan stopping at a decision), 431 (a lease quoted from the live
  list), 432 (a stall withdrawn while a conflict stays), 435 (a stale conflict hidden from the
  snapshot). Each needs its situation to recur.
