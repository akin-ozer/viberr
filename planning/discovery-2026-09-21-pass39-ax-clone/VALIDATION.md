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
