# Owner decisions taken during pass 37

## D37-1 — A dependency hold is a HARD GATE, one spelling (2026-09-13)

*Context.* F37-2: `blockedBy` held nothing. Viberr wrote "Held until every entry is done;
Viberr releases it then" and 1.9 s later started a Codex run that designed and committed the
whole identity service onto a pushed branch cut from a `main` predating its dependency.

*Ruling.* A held task refuses **every** agent dispatch, at the same chokepoint and in the
same shape as the archived/terminal gate (ruling 177). No supporting-run carve-out, no
advisory mode. The words on the board become true.

*Accepted cost.* A held task can do no preparatory work at all — no reading, no drafting —
until its dependencies are satisfied and viberr releases it.

*Implementation note.* One gate in `startAgentRun`, beside the existing closure gate, with a
refusal sentence that names the unsatisfied entries; every door that dispatches goes through
it. The operator must not be woken to burn a paid turn restating the hold.

## D37-2 — MCP coverage uses a credential-free server (2026-09-13)

*Context.* The controller refused to provision an MCP server because every useful one needed
a token it may not accept in chat (correct behaviour — ruling: secrets never travel through
the controller conversation).

*Ruling.* Add a local, credential-free MCP server in Org settings, then have the controller
grant it to a profile. This exercises create → mark write tools (ruling 176) → grant → mount
→ enforce without a secret. The sealed-credential path is out of scope for this pass.

## 2026-09-13 · Owner: fix the environment, not the clone (ruling 196)

**Background I put to the owner.** The agents' container holds node, npm and git and
nothing else — no pnpm, no make, no Docker, no turbo, no psql — while the clone the
controller designed is a pnpm + turbo monorepo with a root Makefile and a Docker Compose
stack. 75 `command not found` lines, a root Makefile whose every target exits 127, a
required reviewer chartered to `make up` that can therefore never approve, and one Code
Reviewer verdict claiming a pnpm test run that never happened (F37-13, F37-14).

**Three options offered.** (a) Re-platform the clone onto what the host can run — npm
workspaces, node's own test runner, per-service SQLite, one node script starting every
service on its own port; keeps the whole product bar and every part of it executes.
(b) Keep pnpm/turbo/Docker and accept that nothing is ever executed here; verification
stays static review. (c) Add pnpm and make to the viberr image — unblocks installs, builds
and unit tests, but not Docker, so the Compose stack and a real Postgres still cannot run.

**Owner chose (c)**, and separately chose "add the cheap ones (make, pnpm, curl)" for the
viberr image question. Both answers point the same way: fix the environment, leave the
clone's design alone.

**Consequences I own and am carrying out.**

- `make`, `curl` and `pnpm@12.4.1` are in the image (ruling 196). Verified live on
  `/resources/health`: `make 4.4.1`, `pnpm 12.4.1`, `curl 8.14.1`, `docker null`.
- **Docker is still absent and is not coming.** So the Integration Verifier's charter —
  "Cold start … `make up`, everything healthy … Report `approve` only when the stack came
  up cold" — is still unsatisfiable, and SHOP-7 is still held by it. That is now a charter
  problem with a named owner (the controller wrote it) rather than an invisible one, and
  ruling 193's doctrine arm is what puts it in front of a human instead of looping the
  deliverer. I am telling the controller, with the measured inventory.
- The clone keeps `pnpm-lock.yaml` and `packageManager: pnpm@9.15.4` while the image ships
  pnpm 12. A repo pinning its own version reaches it with `npx pnpm@9.15.4`; the SHOP-6
  "Lockfile ownership" packet is now answerable either way, because a pnpm exists to run.

## The coordination card, when only some runs report a cost (F37-21 → ruling 201)

**Asked because the alternative was to pick a doctrine on the owner's behalf.** Ruling 190
suppressed the share when a side reported *nothing*, and I had recorded that as fixed. Going
back to ask *why* the live card was honest, the answer turned out to be an accident: the
delivery fleet is entirely Codex, so it reports nothing at all. The moment one delivery run
reports, ruling 190's test passes and the card divides by a denominator most runs never
entered.

**The background given.** Cost is a Claude-only observation — `costUsd` comes off the Claude
result envelope, the Codex envelope carries tokens and no price. Live census at the time:

```
operator    codex    137 runs   0 costed    3.4M tokens
primary     codex     40 runs   0 costed   90.5M tokens
reviewer    codex     32 runs   0 costed   41.6M tokens
controller  claude     6 runs   6 costed    9.1M tokens   $13.38
```

209 of 215 runs, 94% of the tokens, outside the figure. Add one Claude deliverer and the card
reads **27%** off 6 of 142 coordination runs where the truth is likely north of 90%.

**Four options offered.** (a) Suppress the percentage unless every run on both sides
reported, and name the silent population by count and backend. (b) The same, plus a token
share alongside — the unit both backends report. (c) Keep the percentage and state the counts
in the sub-text. (d) Leave ruling 190 as it stands and record the partial case as accepted.

**Owner chose (b).** The reasoning I had put behind (a) holds — with both sides partly silent
the visible ratio is not even a bound — and (b) answers the objection that (a) leaves an
ordinary instance with a permanently blank card. The token share is a different question,
labelled as such on its face.

**Consequences I own and have carried out.** Ruling 201. The dollar share is null unless
every run reported; the card names the gap from per-side counts (`169 of 215 runs report no
cost (169 on Codex)`) instead of the old hedge "reported by cost-reporting runs", which names
no quantity and reads as "all". A second card carries coordination's share of tokens, with
ruling 190's test applied at the token level and F35-1's excluded rows disclosed rather than
suppressed on. Ruling 190's `unobserved` enum is gone — it could not express "partly" — and
its distinction between *reported nothing* and *never ran* still decides both cards. Four
canaries proven red, including one that was vacuous on its first writing: the fixture only
stranded a delivery row, so dropping the numerator's `usage_final` guard changed nothing.

## What to do about a reviewer that finds something NEW every round (→ ruling 210)

**Asked because the doctrine only ever addressed the other half.** Ruling 193 escalates when a
reviewer's objection SURVIVES a rework, and ruling 204 (today) fixed the counter that detects
it. Neither says anything about a reviewer whose objection is answered every round and who
returns a different, equally valid one next time — which costs exactly as many rounds.

**The background given.** It has happened twice on this board:

| task | rounds | shape |
|---|---|---|
| SHOP-6 | **7** | broke only when I stepped in as owner and told the reviewer to name the defect CLASS, not instances |
| SHOP-10 | **5** and counting | five request_changes from `code-reviewer`, each on a different revision, each finding real issues |

Every round is correct on its own terms: the reviewer is doing its job, the deliverer is fixing
real things, and the work is materially better. And nobody has ever asked the reviewer what
ELSE it would block on.

**Four options offered.** (a) Make reviewers certify completeness — a `request_changes` must
name everything the reviewer would block on across its owned surface, and say so. (b) Surface
the round count to the owner, gate nothing. (c) Cap the rounds with a decision packet at N.
(d) Leave it: this is review working.

**Owner chose (a).** It is the only one that attacks the cause rather than the symptom, and it
is what unstuck SHOP-6 by hand.

**Consequences I own and have carried out.** Ruling 210, in two places, because a rule an agent
is never told is not a rule:

- **The reviewer's own contract** (`report_outcome`'s instruction): a `request_changes` is a
  COMPLETE list, not the first thing you found; sweep the whole owned surface, name every
  change you would block on including the unverified ones marked as such, and state that this
  is the complete set for this revision. With a deliberate escape hatch — if something is
  genuinely new (the rework introduced it, or it was unreachable until an earlier blocker
  cleared), say that and why — so the rule cannot push a reviewer into hiding a late finding.
- **The operator's turn doctrine**, beside ruling 193's arm: when the same reviewer returns a
  DIFFERENT objection each round and the earlier findings were actually fixed, ask which of the
  three it is, in one comment, and require "name everything you would still block on across
  your owned surface, now" BEFORE the next rework.

Cost accepted: reviews get slower and more expensive per round. The round count is the
expensive thing, and a reviewer can still miss something honestly — which is what the escape
hatch is for.

## Night of 2026-09-14 — five owner decisions

Taken with the background in front of the owner, in the order asked.

| # | question | decision |
|---|---|---|
| 1 | A task resting on a clock still said "waiting on a human". What should it read? | **Its own resting state** — drops out of every "waiting on you / human" count so those counts mean only work a person can do now → ruling 225 |
| 2 | When viberr cannot verify the PR head it is about to merge, should it still merge? | **Refuse and open a packet** naming both SHAs — "unreviewed code reached main" is the one outcome the review gate exists to prevent → ruling 226 |
| 3 | SHOP-2 was the deliberate drift. Which recovery path? | **Rebase and re-review** through viberr's own path, not force-accept, not archive |
| 4 | 20 tasks against a 25+ bar. Push for breadth? | **Let the chains run** — tasks the controller opened itself are better evidence than tasks I asked for |
| 5 | The controller refused an MCP grant it could not make safe. How to fix the granularity? | **Question returned, not answered**: *"why does it want the whole kb MCP — there were specialized ones, maybe"*. It didn't. The finding was withdrawn. |

Decision 5 is the one worth keeping in view. I had built a MEDIUM finding on an MCP grant
model, and the owner's one-line question dismantled its premise: viberr's native per-KB grants
are the specialized path, they were already held by every profile in question, and the
controller had said so in the first paragraph of its own refusal — a paragraph I had read and
not weighed. Two further claims in that finding also failed on inspection: the org-settings copy
I accused of overclaiming says "withheld from read-only runs", which is exactly the binding
condition, and the enforcement the controller declined to assert does exist and is on its
surface. Withdrawn the same hour, and re-filed in VERIFIED.md as correct behaviour.

Decisions 1 and 2 each turned into a ruling the same night, and each ruling then needed
amending two or three times from re-reading rather than from failing tests — recorded in
VALIDATION.md, because the ratio (five self-inflicted bugs, zero caught by a green suite of
6,632) is the more useful number.

## 2026-09-14 04:19 UTC — the owner moves the OPERATOR to opus high

> "Change operator to opus high"

This overrides the pass's opening model policy, which put the controller on opus high and
**every other agent, operator included, on luna max**. Applied through the Agents page: the
operator profile's backend switched Codex → Claude, which repopulated the model list, then
`opus[1m]` with effort `high`. Confirmed in `project.md`:

```yaml
kind: operator
name: Operator
backends:
  - claude
model: opus[1m]
effort: high
```

**Two consequences worth having on the record.**

*Cost.* The operator is by far the most-run agent on this instance — 355 of 648 runs at the time
of the change, against 100 primary, 88 reviewer and 10 controller. The controller's ten
`opus[1m]` runs had cost $19.23; every other run on the board reported no cost, being Codex. So
this moves the dominant run kind from a subscription backend onto a metered one, and the
instance's daily cost with it. The owner was told before the next cycle rather than after the
next invoice.

*Enforcement gets stronger.* Ruling 185 removed the OS sandbox from Codex runs, which made
repo-write withholding **advisory** there — the prompt omits the delivery steps and the
server-owned gate is the real boundary. On Claude the tool layer binds it outright. So the
operator's withheld capabilities stop being advisory the moment this took effect, and the Agents
page drops the "· advisory on Codex" note from that row.

*And it raises the price of a restart.* Every deploy in this session re-invoked the operator on
each affected task — five, five and seven times respectively. Those were free. From 04:19 they
are not, which is why the image carrying rulings 227, 225's archived guard and 230 is built and
waiting for a lull rather than going out immediately behind four Verify-stage runs that are
bringing stacks up cold.
