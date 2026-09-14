# Pass 37 — Viberr builds a microservices Shopify clone

2026-09-13. Viberr's own controller was given one goal and built a commerce platform in
`akin-ozer/shopify-clone` through Viberr's own machinery. I drove the controller, watched
everything, and fixed what broke. I wrote none of the clone.

Read in this order:

| file | what it is |
|---|---|
| [`SETUP.md`](SETUP.md) | what the controller built for itself, unaided, in one turn |
| [`FINDINGS.md`](FINDINGS.md) | fifty-one findings — two withdrawn, each with its measurements kept |
| [`VERIFIED.md`](VERIFIED.md) | what held up under deliberate probing, and how it was probed |
| [`DECISIONS.md`](DECISIONS.md) | the owner decisions taken mid-pass |
| [`PLAN.md`](PLAN.md) | the implementation plan each fix commit follows |
| [`VALIDATION.md`](VALIDATION.md) | red-proof and live-proof for every fix |

Rulings **186–228** in `docs/architecture/decisions.md`. Fixes on
`pass37/shopify-clone-fixes`, PR akin-ozer/viberr#302.

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
