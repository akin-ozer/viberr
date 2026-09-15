# Pass 37 — Viberr builds a microservices Shopify clone

2026-09-13. Viberr's own controller was given one goal and built a commerce platform in
`akin-ozer/shopify-clone` through Viberr's own machinery. I drove the controller, watched
everything, and fixed what broke. I wrote none of the clone.

Read in this order:

| file | what it is |
|---|---|
| [`SETUP.md`](SETUP.md) | what the controller built for itself, unaided, in one turn |
| [`FINDINGS.md`](FINDINGS.md) | eighty-three findings — two withdrawn, each with its measurements kept |
| [`VERIFIED.md`](VERIFIED.md) | what held up under deliberate probing, and how it was probed |
| [`DECISIONS.md`](DECISIONS.md) | the owner decisions taken mid-pass |
| [`PLAN.md`](PLAN.md) | the implementation plan each fix commit follows |
| [`VALIDATION.md`](VALIDATION.md) | red-proof and live-proof for every fix |

Rulings **186–254** in `docs/architecture/decisions.md`. Fixes on
`pass37/shopify-clone-fixes`, PR akin-ozer/viberr#302.

## Day seven, in one paragraph

The seventh session began by finding the same defect in my own work. **F37-76**: ruling 245's
`FileLease` documented "released when the holder reaches a terminal stage" and nothing implemented
it — a comment asserting a mechanism, which is the shape this pass has confirmed more often than
any other, written by me, an hour after I shipped it. The controller read that contract, believed
it, and wrote it into the first real lease's own stored reason: "Lease releases when SHOP-11
merges." SHOP-11 merged; the lease stood.

Then the session's centre. **F37-77**: the Code Reviewer's checkout failed to provision, so viberr
told it — in viberr's own words, and ordered it to quote them verbatim — "this is a server-side
FAILURE, not something you can fix". It quoted them, returned `verdict: null`, and wrote "No
content verdict recorded". Viberr recorded `request_changes`, because the prose classifier matched
the word *failure* inside the sentence viberr composed. Delete that one word and the classifier
returns null: it was the entire verdict. The fabricated objection was the second in a row, so
ruling 237's counter raised a decision packet putting three options to a person — interrogate a
reviewer that never judged, force-accept past a verdict that did not exist, or rework again. The
operator read the reviewer's own report, said so on the task, and could not withdraw a packet the
policy engine had raised. **F37-78** was one layer down in the same incident: viberr told everyone
"No GitHub credential is attached to this project" about a project holding a working one, because
the supporting checkout's arm never fetches the token — and the operator believed it and wrote it
onto the task.

The rest of the day was the controller, which is what the owner asked to have inspected. **F37-79**:
a turn that ran 201 seconds for $4.11 showed `Controller is working…` and nothing else, while the
same page rendered the live tool call below it. **F37-80**: told "I want to lean on you rather than
clicking through task pages myself", the controller answered — twice, correctly — that it had no
tool for packet resolution and could not even see what was waiting. The owner kept the boundary and
made it navigable. **F37-81**, caught in flight *because* F37-79 had shipped an hour earlier and the
working row was showing the live tool call: the controller tagged an agent, briefed it at length,
and nothing was sent. **F37-82**: the standing corrections it wrote reached the operator cut off
mid-word at "fails in about thr". **F37-83**, raised by the controller itself and confirmed against
the run rows: four open packets promising a model the project no longer deployed.

The board ended the day at **23 done, 23 merged pull requests**, with nothing waiting on a human —
and with every specialist moved from a spent Codex window onto Claude opus, through the controller,
in one instruction.

## Day six, in one paragraph

By the end of the sixth session the board stood at **26 tasks, 16 done, 16 merged pull requests**
on `akin-ozer/shopify-clone`.

The sixth session was one family of defect, found three ways, and the last one was found by
pressing a button rather than reading code. **F37-65**: the Execution caption told every task on
this board that a full-autonomy run "can move the task and accept completion itself", while owner
ruling Q1 holds `completion-for-acceptance` at `recommend` whatever the autonomy — every acceptance
in the whole pass was a person pressing the button. **F37-66** and **F37-67**: two records that
described what did not happen — ruling 211(b)'s withdrawal note sat below the very early returns it
was written for, and the lost-completion note promised a boot replay that its own sibling write had
already excluded the run from. Running the recovery sweep instead of reading it found a third way
the promise was false, and a fourth.

Then **F37-68**, the one worth the session. Ruling 237's escalation fired on SHOP-5, I picked its
recommended option, and viberr wrote the decision onto the task's contract, cleared the packet, and
refused to carry it out: the task was held, and ruling 186 refuses every agent dispatch on a held
task. The person's chosen option bought nothing and there was no packet left to choose again from.
`force_accept`'s own arm, in the same file, had already written the rule it broke. The owner chose
to QUEUE rather than refuse (ruling 241), so the hold stays absolute and the intent survives it.

Three more came out of that one. **F37-70**, found by adversarially reviewing ruling 241 an hour
after shipping it: the drain lived only in `announceRelease`, and the operator's own
`set_dependencies` clear — the door ruling 240 names as the remedy for a wrong hold — announces
nothing, so the queued question would have sat forever under a wait panel promising it would be put
when the wait cleared. F37-68's shape inside F37-68's fix. **F37-69**: ruling 237 forbids a verdict
on its escalation question *in a prompt*, which is the construction ruling 186 refused; live on
SHOP-25 the reviewer answered the question perfectly and verdicted anyway, 8ms later, on an
untouched revision, taking the deadlock count from 2 to 3 (ruling 242 now counts a round by the
deliverer having run). And **F37-71**: the notifications inbox demanded an acceptance the server
refuses, because UX19-3's gate was wired into one of two sibling queries in the same function.

The day also verified more than it fixed: the clone RUNS from a clean clone in one command, five
services healthy, and its own `/ready` names exactly the three services the board says are still in
open PRs.

## Day five, in one paragraph

The fifth session found the two halves of one story, and the second half cost a governance
override to escape. **F37-57**: ruling 210 held that a second consecutive `request_changes` from
one reviewer is the point to stop reworking and ask — and wrote that as a paragraph in the
operator's turn instruction. Ruling 204 gave it a counter that read the deadlock correctly. Live on
SHOP-5 the counter read 3, the paragraph was in the prompt, and the operator moved Review to Build
46 seconds after the third verdict and re-dispatched the deliverer 16 seconds later, having asked
nobody anything. The same construction ruling 186 refused six sessions earlier. **F37-58** is why
the deadlocks happen: a verdict binds to a work revision, a base refresh mints no new revision and
is correctly reported as not-unreviewed, and `pinSupportCheckout` detaches every re-review at the
reviewed revision — so a reviewer blocked on a defect in the BASE re-reads the base that still has
it, forever. SHOP-18 hit exactly that, and the only way out was an admin force-accept, which I
performed after checking at both shas that the fix was real and the deliverable untouched. The
owner took escalate-not-gate for the first (ruling 237) and automatic re-pin on base-only drift for
the second (ruling 238).

## Day four, in one paragraph

The fourth session's findings came from the same habit as the third, aimed at surfaces nobody
reads until they need them. The org audit browse existed specifically to show sign-ins, PAT
changes and user administration in the app, and **could not show any of them**: a poller heartbeat
written unconditionally once per delivered task per tick filled 61% of its 150-row window, so
"Org-scoped" returned two `projection.rescan` rows against 96 such events on file, including the
instance's only `github.pat.created` (**F37-52**). A mention notification quoted the first 240
characters of the comment, which in 39 of 49 cases excluded the very handle it was sent for
(**F37-53**). Pressing Accept on a task whose reviewers had approved a revision the pull request
never carried refused correctly and told **one browser's toast and nothing else** — no audit row,
no timeline event — so the operator, the only actor allowed to push, re-filed the same acceptance
recommendation it had just been refused (**F37-55**). Insights counted a task sitting exactly ON
the compression threshold as one the fold was managing, when the fold's own rule is `<=`
(**F37-54**). And the record had been quietly inventing the owner's gender, two incompatible ways
in one project (**F37-56**). The owner also took a design call on merge collisions, which became
ruling 236: merging one task had put four of six open pull requests into CONFLICT inside a minute,
all on two shared files, with the queue listing them as six independent rows throughout.

**Five near-misses, caught before filing, all the same shape**: assume a mechanism, measure
against the assumption, get a signal. The mention "lie" was a 240-char clip my regex had searched
instead of the comment. The "missing packet" was a `## Packet` section my `awk` never reached. The
"process leak" was transient teardown that a second reading showed gone. "Accept does nothing" was
a refusal toast that had already dismissed before I sampled the DOM — caught only because the
network log still held the 409, and that one led directly to F37-55. The "broken evidence chain"
was a link viberr never made: an `EvidenceRow` is documented as *"A REFERENCE, never a dump"* and
its backing is the run log, which still held the claim.

## Day three, in one paragraph

The third day's findings came from one habit: **read a sentence viberr shows a human, then
check whether the mechanism can keep it.** Viberr's own turn doctrine told the operator to put
a question to a reviewer "in ONE comment" — and a comment reaches no agent, so the question was
never read, and viberr's stall detector then scored the asking as inaction and paused a task six
others were waiting behind (**F37-34**). The note it wrote there says "run the operator manually
when the hold should end"; running the operator manually was the one remedy on its list that did
not end it (**F37-36**). A restart that landed one second after a transition left a task
claiming an agent nobody could see, because all three boot recoveries key on a RUN and the
damage was keyed on a TASK (**F37-33**) — and the fix's own first deploy then wrote a second,
false restart note beside the true one (**F37-35**), which is the pass's cleanest lesson about
live proof: it covers the state the board happened to be in, never the one it was not.

Then the store broke underneath everything, and that turned out to be the richest seam of the
pass. For twelve minutes every projection rebuild failed, every task page 500ed and a run sat
`running` with no process — while `/resources/health` answered `{"ok":true,"status":"ok",
"degraded":[]}`, honestly, because the row COUNTS still read fine (**F37-37**). Ninety seconds
after that was repaired, one transient `disk I/O error` left a card reading "waiting on you"
against a file that said `waiting: agent`, and nothing on earth would ever have retried it
(**F37-38**) — the latch I had shipped two hours earlier said the instance was healthy, because
a different file had rebuilt in between. And the reason a task had been stranded at all was a
catch that wrote its "this failed" note to the store that had just failed, so `rebuildPath` threw
after all and took `resolvePacket`'s operator re-invoke with it (**F37-39**). The store's
corruption was my own doing — the host `sqlite3` CLI against a live container's database over
VirtioFS — and every one of those four findings is about what viberr did with it, not how it got
there.

## Day two, in one paragraph

The second day's findings all came from one root the first day had walked past: **the
container every agent runs in holds `node`, `npm` and `git` and nothing else**, while the
clone the controller designed is a pnpm + turbo monorepo with a root `Makefile` and a Docker
Compose stack. Viberr had measured that since ruling 182 and kept the reading behind an
opt-in tool the controller never called — which omitted `make`, `docker` and every package
manager but npm anyway (**F37-13**). Downstream of it: a required reviewer chartered to
`make up` a stack that cannot exist, ten rework rounds on a one-file document because the
turn doctrine has exactly one answer to a request-changes (**F37-14**), and a Code Reviewer
verdict claiming a pnpm validation run that never happened. Alongside, three more from
disbelieving what the product showed me: a coordination-overhead metric reading **100%** off
a denominator delivery never entered (**F37-12**), a task reading "agent working" with **zero
runs in 75 minutes** while ten tasks waited behind it (**F37-17**), and the controller
refusing — correctly — to edit an agent template because Viberr would not show it what it was
about to overwrite (**F37-18**). The owner chose to fix the environment rather than
re-platform the clone, so `make`, `curl` and a pinned `pnpm` are in the image and Docker
deliberately is not.

Then two more, both from disbelieving a surface a second time. A guard doing its job in
silence — the boot re-invoke cap — left SHOP-7 reading "agent working" with **no run for two
hours**, under a timeline note promising a turn the code had already decided not to take
(**F37-19**). And the one I nearly filed as an environment quirk: all three of the pass's run
errors said "the agent's stored Codex session no longer exists", so I went and found the file.
**138 of 140** Codex threads on the instance pointed at a per-run home Viberr deletes at
settle, while **138 of 138** of their transcripts sat intact in the shared directory one path
segment away — every conversation the instance had ever held, unresumable, and reported as the
provider's fault (**F37-20**). The boot after the fix re-pointed all 138; the instance went
from 2 of 140 resumable to 140 of 140.

## The one-paragraph version

The controller set itself up well — a six-stage board, two knowledge bases, five skills, six
agent profiles all on Codex `gpt-5.6-luna`/`max` (the operator included, which is the part I
expected to fail), required reviewers at two stages, and 31 tasks across 5 goal chains with an
anti-collision design of its own invention: four named hot spots made *additive* so two agents
never edit the same line. Then it ran, and what broke was not the coordination it designed but
the machinery underneath. **A hold that held nothing** let an agent commit a whole service to a
task Viberr had just called held. **A commit that existed nowhere** stayed in the canonical
record after its workspace was disposed, rendered as "1 commit · synced". **Four controller
reads** returned less-resolved data than the UI, one of which made the controller refuse a
grant that was safe. And **a decision I was asked for and gave** was overruled by the stale
goal text, reverted by the agent, and asked again.

## What it built

Real work, not a demo. On `main` and in flight: a pnpm + Turborepo monorepo pinned to Node 22,
`packages/contracts` with branded id types and money as integer minor units, `packages/http`
with a circuit breaker (closed/open/half-open, injectable clock), `packages/db` with a
migration runner and a Testcontainers harness, `packages/testing` with a contract-test harness.
PR #1 merged after a real request-changes round — the reviewer caught `--passWithNoTests`
faking a test suite, and a root export pointing at `src/index.ts` that Node 22 cannot load.

**Where it stands at the end of day three:** 17 tasks across 7 chained goals, 6 through the
whole six-stage board to Done, **6 merged pull requests** and 2 closed on purpose — one a
deliberate rejection, one a branch collision against a pre-existing ref. On `main`: the
monorepo, the shared packages, the frozen cross-service contracts, the local process-supervisor
stack with per-service SQLite and `make up`, the payment provider integration, and a CI pipeline
whose job matrix is derived at runtime from `pnpm -r list --json` so adding a workspace needs no
workflow edit. In flight: the storefront (PR #9) and the service template (PR #8), the latter
the critical path with six tasks declaring `blockedBy: SHOP-10` behind it.

Nothing in that repository was written by me. Every commit, branch and pull request went through
viberr's own delivery; every merge went through the human acceptance gate on its task page.

## How the findings were found

By using it, not by reading it. Every finding came from a real run on a real repository:

- F37-2 and F37-8 came from watching SHOP-2 commit a service while the board said "blocked".
- F37-3, F37-6 and F37-7 the **controller found itself**, when I asked it to compare its own
  report against what actually happened. Its refusal to assert an enforcement it could not
  observe — "if Viberr enforces that marking, it does so somewhere I cannot read, and I won't
  assert that it does" — is the finding, stated by the thing the finding is about.
- F37-10 came from deliberately building a task whose goal forbade the agent to decide, then
  answering the packet it raised and watching the answer get erased.
- F37-1 was found, reported, and then **withdrawn** when the measurement contradicted the
  first impression. It is kept because a withdrawn finding is worth as much to the next reader.

## Things worth knowing next time

- **The controller is a genuinely good reviewer of its own instance.** Asking it to compare
  its report against the store surfaced three findings I had not seen. Ask it that early.
- **`sqlite3 -readonly` over the live WAL gives transient empty reads.** Two "findings" of
  mine were my own tooling; both dissolved on a second read. Never report a state change from
  a single read-only snapshot (and ruling 158 says not to open that file at all — copy first).
- **Truncated run ids silently match nothing.** `/tmp/obs runs` prints 14 chars; querying
  `run_log_lines` with that prefix and `=` returns zero rows and looks exactly like a stuck
  run. Use `LIKE 'run_x%'`.
- **A held task is the cheapest place to find dispatch bugs**, because everything that should
  not happen is enumerable.
- **Ship an observability fix and the next defect walks into it.** Ruling 250 put the live tool
  call on the controller's working row at 03:5x; F37-81 was caught at 04:0x by reading that row
  while the controller wrote a comment tagging an agent. The fix found the bug.
- **Disbelieve the agent's own report of what it wrote, then read the file.** The controller said
  its standing corrections were in the rulings KB. True. What a run RECEIVED was half of rule one.
- **Read the rendered surface, not the frontmatter.** SHOP-30's file says `waiting: human` with no
  packet and no recommendation, which reads as a dead end. The task page renders it as "Waiting on
  **a schedule · Sep 19 · 14:37**". That near-miss died in one screenshot; it would have been the
  pass's sixteenth.
