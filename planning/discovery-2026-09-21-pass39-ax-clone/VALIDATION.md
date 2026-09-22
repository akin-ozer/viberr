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
