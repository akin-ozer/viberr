# Pass 37 — validation record

Every fix proved twice: a test made to go **red** by breaking its own source, and the rebuilt
image driven live against the real bug that motivated it.

Gates on `pass37/shopify-clone-fixes`: `npm run lint` clean, `npm run typecheck` clean,
`npm test` **6483 passed / 363 files**.

---

## Ruling 186 — the dependency hold gate

**Red proof.** Replaced `existing.parsed.frontmatter.blockedBy` with an empty list in
`startAgentRun`:

```
× refuses the dispatch, and starts no process
× names what it waits on, so the refusal is actionable
× refuses an AUTO-ENGAGING dispatch too — the hold is not a posture question
AssertionError: promise resolved "{ runId: 'run_XFLQsUbmFcLC', …(3) }" instead of rejecting
```

The failure text *is* the live bug: a dispatch succeeding on a held task. The fourth test
(release → dispatch works again) stayed green, as it should.

UI half: setting `held` to `false` in `execution-profile.tsx` turned
"the AGENT run control is disabled on a held task" red (`expected false to be true`).

**Live proof.** Rebuilt image, real held task, real HTTP door:

```
SHOP-3 state: blocked  blockedBy=["goal-1 link 5"]
POST intent=run-agent profileId=backend-engineer  ->  HTTP 400
  "SHOP-3 waits on goal-1 link 5 and Viberr is holding it, so running an agent on it is
   refused. Viberr releases it when every entry is done; to release it sooner, change what
   it waits on."
runs started on SHOP-3: 0
```

Task page: the header carries a `goal-1 link 5` lock chip beside the `blocked` pill, and the
Run control is `disabled` rendering that same sentence (asserted in the live DOM:
`runDisabled: true`, `sentencePresent: true`). Before this change the identical request
started a real, billable Codex run.

---

## Ruling 187 — the phantom commit, and the stale sync pill

**Red proof.** Restored the old carve-out (keep `existingCommits` unfiltered):

```
× drops it from the cache instead of keeping it as 'honestly recorded'
× says the work is LOST, naming the sha and the branch
AssertionError: expected [ { sha: '3aad6ff', …(1) } ] to deeply equal []
```

Again the live symptom exactly. The third test — an unprefixed commit that IS on the branch
survives and announces nothing — stayed green in both directions, proving the carve-out's real
purpose is intact.

**A defect in my own fix, found by self-review and fixed.** The first version treated the
remote's commit list as authoritative whenever the compare succeeded. But `getBranchCompare`
reads the payload *tolerantly* and reports `droppedCommits` when GitHub sends entries it
cannot decode, and GitHub's compare caps its list besides. On a short list a genuinely pushed
commit would look absent — and announcing **that** as lost work is a worse lie than the one
the rule fixes: it tells a person their work is gone while it sits on the branch. The rule now
requires `compare.droppedCommits === 0`, and an incomplete list falls back to the old
conservative behaviour: keep the cache, announce nothing. Pinned by its own test, red when the
guard is removed (`expected [] to deeply equal [ { sha: '3aad6ff', … } ]` — the cached commit
wrongly dropped).

For F37-9, removing `syncChanged` from the write condition turned
"writes a row when the verdict flips" red (`expected [ 'synced' ] to deeply equal [ 'synced',
'behind_main' ]`), while "stays quiet while the verdict holds" stayed green — the bounded-growth
guarantee is tested, not assumed.

**Live — and this is where the live system corrected me.** The first implementation caught the
original phantom on its first reconcile after restart, unprompted, and announced:

> **Work lost:** commit `3aad6ff` was recorded for `shop-2` but is not on it …

Right answer, wrong mechanism. Within the hour the same rule fired on SHOP-7's `522e640` —
**seconds before Viberr pushed it** — because the reconcile landed in the window between an
agent committing in its workspace and delivery pushing. At reconcile time the two cases are
identical: neither commit is on the remote, neither carries `pushedAt`. The remedy is now the
one my own plan had specified before I departed from it — stamp `pushed`, render it, declare
nothing lost. Recorded in full in `FINDINGS.md` F37-8.

Live proof of the corrected version: `pushed: true` stamps are landing on SHOP-6's three and
SHOP-7's seven commits, the GitHub page renders no spurious "not pushed", and SHOP-1 — Done
and not reconciled since the change — correctly carries **no stamp at all**, which is the
"unjudged" state rendering as neither answer.

**One consequence I have to own:** the first implementation *dropped* SHOP-2's phantom from
the canonical record before I reverted the mechanism, so `commits: []` there is the wrong
version's edit and the corrected code cannot restore what it removed. The commit itself was
genuinely gone, so nothing recoverable was lost — but the record was mutated by a rule that no
longer exists, and that is worth stating rather than quietly leaving.

And the same GitHub page row, before and after:

| | commits | sync |
|---|---|---|
| old image | **1 commit** (a sha on no branch) | **synced** (measured before PR #1 merged) |
| new image | — | **behind main** |

Both halves of the lie are gone from the surface a person reads.

---

## Ruling 188 — the controller reads

**Red proof.** Four breaks, four reds, one per finding:

```
× F37-3: get_project resolves declared stages onto THIS board …   (emit raw stages)
× F37-5: get_task answers the acceptance gate's own verdict …     (restore blockReason)
× F37-6: list_mcp_servers reports ruling 176's marking …          (drop writeTools)
× F37-7: save_mcp_server can mark write tools …                   (ignore the parameter)
```

F37-4's vocabulary test goes red naming the exact tool: `edit_file: expected false to be true`.

The create-default test is the interesting one — it pins a decision I first got **wrong**. I
had `saveMcpServer` auto-mark a create from the heuristic; an existing test
("a probe keeps the tool names it listed, and the marks start unreviewed") caught it, and it
was right to: pre-marking asserts a review nobody performed. The behaviour was backed out and
the test now pins the correct contract — suggest, never mark; `writeToolsReviewed` stays
false; a deliberate `[]` is an answer and stops the suggestion.

---

## Ruling 189 — a decision joins the contract

**Red proof.** Disabled the goal append:

```
× writes a CUSTOM directive into the goal, so every re-anchor reads it
× writes a CHOSEN option into the goal too, title and description
AssertionError: expected 'Test goal.' to contain 'Mock-only, behind a PaymentProvider port'
```

The two guard tests (an ending resolution, and `edit_goal`'s still-open packet) stayed green.

**Live proof** is the finding itself: SHOP-7 ran the whole loop on the old image — answered,
acted on, rejected against the stale goal, reverted to "a neutral, unresolved comparison",
re-asked. The amendment is what breaks that cycle; the loop is reproduced in
`FINDINGS.md` F37-10 with timestamps.

**A second defect in my own fix, found by watching it work.** The first version appended
*every* resolution, so SHOP-7's goal promptly collected two blocks: the provider decision
(contract) and "Work stalled: pick a recovery path → Redirect with sharper guidance" (not).
A recovery choice decides what happens *next*, not what the work *is*, and letting process
accumulate in the very text every future run re-anchors on is the noise the ruling exists to
prevent. Recovery kinds are now excluded — `request_edit`, `redirect`, `retry_other_backend`,
`hold_runtime_debug`, `archive_task`, `discard_branch`, `resolve_remote_collision`,
`move_stage` — while a typed **custom directive always binds**, whatever packet it was typed
on, because a person wrote it. Both arms pinned; the exclusion goes red when removed
(`expected 'Test goal.\n\n---\n\n**Decision — 202…' to be 'Test goal.'`).

The fixture moved from `redirect` to `custom` options in the same change, which is what a real
agent question carries — SHOP-7's live packet offered Stripe / Adyen / Mock-only as `custom`,
and my first fixture had quietly got that wrong.

**Stated precisely, because it would be easy to overclaim here:** SHOP-7's goal still carries
two decision blocks after the rebuild. Both were written by the *old* image; the exclusion
prevents new ones and does not rewrite text already committed to a task file — pre-prod
licenses schema changes, not retroactive edits to a person's record. The proof for the
exclusion is therefore the unit tests, which go red when it is removed, not a live
observation I do not have.

---

## Boot recovery, incidentally

Recreating the container mid-run exercised it:

> **Restart:** the run `run_19PtdepIDG3L` (agent) was still running when the server stopped;
> it is recorded as interrupted by the restart, and the operator is re-invoked.

Correct, and honest about what happened.

---

## Ruling 189 — live, on the task that produced the finding

SHOP-7 still carried its open packet when the rebuilt image came up, so the fix could be
proved against the original bug rather than a reconstruction. Resolving it with the
`Mock-only` option appended this to the task's **goal** — the contract every fresh run
re-anchors on, and the exact place the answer was missing before:

```
---

**Decision — 2026-09-13, Arda answered “Arda: choose the payment provider”:**

Mock-only — Deterministic non-monetary integration now; no live checkout until a later
real-provider decision and implementation.

This decision is part of the task's contract from here on. Where anything above contradicts
it, the decision wins — it was made by the person the question was put to, and it is not an
agent overstepping.
```

The goal above it is untouched, so the original brief still reads as written and the decision
sits under it with the precedence spelled out. A reviewer re-anchoring on this file now finds
the answer in the contract instead of finding the deliverable contradicting it.

**An unplanned second benefit.** The Codex session expired again on the re-engage — the same
provider fact as before (`no rollout found for thread id … (code -32600)`), and viberr again
reported it honestly and opened a recovery packet. Before ruling 189 that fallback was weak:
a fresh run "re-anchors on this task file", and the task file did not carry the human's
answer. Now it does. The two mechanisms compose — an expired transcript costs a round trip
instead of the decision.

## Ruling 190 — live, on the instance's own Insights page

Before (screenshotted, dark, desktop):

> **100%** · Coordination overhead
> *operator and controller runs spent $4.34 of $4.34 reported by cost-reporting runs*

After the rebuild, the same card, same instance, both themes and both widths:

> **n/a** · Coordination overhead
> *operator and controller runs spent $7.90; no delivery run reported a cost, so there is
> no share to take*

The dollar figure that IS real survived the fix and moved with the instance ($4.34 → $7.90 as
the controller kept working). The share is gone because nothing measured it. Light and dark
both render the `n/a` value in the muted `.stat-val.na` treatment the other unmeasured stats
use, and the mobile grid (375×812) wraps the longer sub-text without clipping.

## Ruling 191 — live, and the verdict text changed

The probe, read off `/resources/health` on the rebuilt image before ruling 196 landed:

```json
{"node":"26.8.2","npm":"11.19.1","git":"2.47.3","python3":null,"go":null,
 "make":null,"docker":null,"pnpm":null,"yarn":null,"curl":null,
 "codexCli":"0.153.4","claudeAgentSdk":"0.3.261"}
```

Exactly the absences I had measured by hand with `command -v` inside the container, now
reported by the product's own probe — and, for the first time, carried into every specialist,
operator and controller prompt.

**The behaviour changed on the next real verdict.** The Integration Verifier's verdict
BEFORE ruling 191 opened with the failure and left the reader to infer its nature:

> Mandatory Step 1 failed: `make up` returned `/bin/bash: line 1: make: command not found`
> (127) … Steps 2–5 could not run because the checkout has no services or compose stack.

The first verdict AFTER it separates the two explicitly, in the reviewer's own words:

> The Integration Verifier gate cannot pass: cold start failed at `make up` with exit 127
> … **This is an environment/repository-baseline blocker, not a discovered document-scope
> defect.**

That sentence is the inversion the fix was aimed at. It also shows the limit of ruling 191
on its own: the reviewer still (correctly) returns `request_changes`, because its charter
says approve only from a stack it brought up — which is what ruling 193 and ruling 196 are
for.

## Ruling 196 — live

`/resources/health` on the rebuilt image:

```json
"make":"4.4.1", "pnpm":"12.4.1", "curl":"8.14.1", "docker":null
```

Docker null is the ruling working, not a gap: it is the one the owner and I deliberately
left out, and every run is now told so in the same paragraph.

## Ruling 189 — a second live proof, and the narrowing held

SHOP-6's "Lockfile ownership" packet, answered with a typed custom directive, appended a
`**Decision — 2026-09-13, Arda answered "Lockfile ownership":**` block to the task's goal —
the second task this pass where a human's answer joined the contract instead of scrolling
away in the timeline.

Minutes later the same task threw a `Work stalled: pick a recovery path` packet (its Codex
session had expired), and I resolved it with **Redirect with sharper guidance**. The goal
still carries exactly **one** decision block. That is `PROCESS_ONLY_OPTION_KINDS` doing its
job live: a recovery choice decides what happens next, not what the work IS, and ruling 189's
first draft — which appended every resolution — would have put "Work stalled: pick a recovery
path → Redirect with sharper guidance" into the contract of a task about shared packages.

## Ruling 195 — the finding and the fix, both live

Found by disbelieving the board: SHOP-6 read `readiness: ready, waiting: agent` with **zero**
runs in 75 minutes while ten tasks waited behind it. Pressing the page's own **Run operator**
answered why — *"Operator not started · resolve the open decision to continue"* — and the
audit showed viberr had recorded a boot re-invoke for it (`run.recovery.reinvoked · SHOP-6 ·
{"attempt":1}`) that started nothing. The refusal skipped its settle on an invariant the
product does not hold, so the board kept claiming an agent was working on a task whose every
door was shut.

Fixed, proven red (`expected 'agent' to be 'human'`), and the same task then moved: packet
resolved → operator re-engaged → `run_ogTTIx` started within seconds.

## Ruling 191, second order — the controller repaired a defect in its own design

The prompt change is the mechanism; this is the effect, and it is the strongest evidence in
the pass. With the measured inventory in its own system prompt for the first time, the
controller went and rewrote the Integration Verifier profile it had written that morning —
the required reviewer whose charter no revision could satisfy. Its new opening:

> You are a gate, not a wall. **A gate that can never open is not a quality control — it is a
> defect in the charter, and you must not become one.**
>
> ## The environment you verify in — measured, not assumed
>
> The runner contains exactly: node 26.8.2, npm 11.19.1, git 2.47.3, make 4.4.1, pnpm 12.4.1,
> curl 8.14.1. There is NO docker, no docker compose, no psql … and there never will be.

And it redefined what integration *means* here rather than lowering the bar:

> Integration here means **real separate OS processes talking over real TCP**, not containers:
> `make up` starts each service as a Node child process on its own port and polls
> `GET /health`. Each service owns one SQLite file … Tracing is NDJSON spans …
> That is a genuine integration surface. Separate processes, real serialisation, real network
> errors, real partial failure. Verify it as such.

It added a scope rule ("a task that delivers a document verifies as a document … **Approve
it**"), and a rule that reads as a direct answer to the ten rounds it caused:

> **An environment limitation is never a reason to request changes.** If a check cannot run
> because the tool is not installed on this host, the deliverable did not fail — the check
> did. … `request_changes` is reserved for a defect in the delivered work … Never for
> `command not found`.

Then it posted the accountability note on the task itself: *"@Arda @integration-verifier
@code-reviewer The charter that made this task unpassable has been rewritten. Recording it
here because it is the reason for the last ten rounds."*

Nothing about the model changed. What changed is that a fact the server had measured since
ruling 182 — and kept behind an opt-in tool nobody called — is now in front of the agent that
writes the contracts everyone else is judged against. Rulings 193 and 196 cover the two cases
this does not: a reviewer that fails twice anyway, and the tools that were cheap to ship.

## Ruling 187's negative stamp — observed true, never observed false, and that is the expected state

Every commit on every branch in the record carries `pushed: true`, stamped from the remote
compare, and the GitHub page shows no "not pushed" marker anywhere. `pushed: false` has not
occurred since the fix landed, and a watcher looking for one across a full delivery cycle
found none. That is what the field is for: it marks an abnormality — a commit the record
claims and the remote does not have — and the one live instance of that abnormality is the
SHOP-2 phantom that produced the ruling in the first place. The false arm is covered by
`github-reconciler.server.test.ts`; claiming a live sighting of it would mean manufacturing a
phantom on a real branch, which buys a screenshot and costs the record's integrity.

## Gates at the end of day two

`npm run lint` clean · `npm run typecheck` clean · **6518 tests / 363 files** green ·
**70/70 e2e** on the production image with all eleven rulings in it (37.3s), including the
WCAG 2.2 AA sweep over every surface in both themes.

## Ruling 199 — live, and measurable to the row

Before the deploy, read straight out of the Codex CLI's own state database:

```
threads: 140   resumable: 2   broken: 138
```

The 2 were the runs still in flight. Every other conversation the instance had ever held
pointed at a run home Viberr had deleted.

The boot line from the rebuilt image:

```
"re-pointed Codex rollout paths left behind by removed run homes","threads":138
```

…followed, seconds later, by the settle half doing its job on the two runs the restart had
just interrupted:

```
"codex rollout paths re-pointed at the shared home","runId":"run_4y_Y-1Fyeq9N","threads":1
"codex rollout paths re-pointed at the shared home","runId":"run_irmD7e-f0HGa","threads":1
```

After:

```
threads: 140   resumable: 140   broken: 0   still under a run home: 0
```

Both halves of the ruling exercised on the same boot, on real data, and the number that
matters went from **2 of 140** to **140 of 140**.

## Ruling 198 — exercised on the same restart

The two interrupted runs were under the cap (the 30-minute window had rolled), so both tasks
were re-invoked and both notes read "…and the operator is re-invoked to decide what to do
next" — which is now a true sentence because the decision is taken before the note is written
rather than after. The capped arm is covered by its own test, proved red by putting the
promise back; forcing it live again would mean restarting five times in half an hour to
manufacture a stall I had already measured once.

## Ruling 190's symmetric form — live

The card on the rebuilt image, with the instance's spend now at $13.38:

> **n/a** · Coordination overhead
> *operator and controller runs spent $13.38; no delivery run reported a cost, so there is no
> share to take*

## Ruling 196 — still true after four rebuilds

`/resources/health`: `make 4.4.1`, `pnpm 12.4.1`, `curl 8.14.1`, `docker null`, `python3 null`.

## Ruling 193 — the calibration half, live on a task that SHOULD keep reworking

SHOP-7 gave the loop the arm exists for. SHOP-6 gave the opposite case, unprompted, and it is
the more important of the two: an arm that fires on a count rather than on a reason would have
broken a healthy review cycle.

Its Code Reviewer reached **`consecutiveRequestChanges = 6`** — six successive delivered
revisions, every one `request_changes`, three times past the threshold the doctrine names. And
every round is legitimate. The sixth verdict ran the whole suite first:

> …all requested validation commands passed (exit 0), including frozen install and recursive
> tests. **However:** [`packages/db/src/migrations.ts:150`] silently discards rollback
> failures. If rollback fails, the caller receives only the migration error and cannot know the
> database state is uncertain. … A direct failure-path probe confirmed the migration
> transaction returns only the primary error when rollback fails.

Three real defects in the delivered work, each fixable by the deliverer, found by a reviewer
that wrote a probe to prove one of them. The operator's response, with the count in front of it:

> **Transition:** operator moved SHOP-6 from Review to Build.
> @Platform Architect, rework the delivered revision using the reviewer's findings: in
> `packages/db/src/migrations.ts`, preserve the primary migration error while surfacing the
> cleanup failure…

No packet, no escalation — the rework the situation calls for. That is the arm working as
written: it asks whether the deliverable can satisfy the objection AT ALL, and a run of six
honest rounds answers yes and passes straight through. A threshold that escalated on the number
alone would have interrupted the best review cycle on the board.

## The pass reviewing itself — 136 agents against my own diff

Rulings 186–199 were written by me, tested by me, and proved red by me. That is the same
person marking their own homework, and another model reviews this afterwards, so I ran an
adversarial pass over my own work before they did: 12 clusters (one per ruling), each reading
the real `git diff 655b67ea..HEAD` and the ruling's own paragraph, hunting correctness,
regression, vacuous tests and honesty. Every finding then went to **three diverse skeptics**
— correctness, regression-risk, test-reality — each prompted to REFUTE it and to default to
"refuted" when unsure. Majority refute kills a finding.

```
clusters 12 · agents 136 · raw findings 41 · survived verification 7 · errors 0
```

**All seven were in the FIXES. None was in the original twenty findings.** That asymmetry is
the useful part: the diagnosis held up and the treatment did not, which is the opposite of
what I would have guessed.

What they were, and what each cost had it shipped:

| | defect | what it would have done |
|---|---|---|
| 187(b) | `compare` is an AHEAD-only list, so a merged branch answers empty; the carve-out stamped every cached commit `pushed: false` | the record announcing origin lacks commits sitting in `main` — this ruling's own prohibited lie, inverted |
| 192(b) | the retry carried the failed task's text over an `edit_link` made on that failed link | the one correction the tool advertises there, discarded without a word |
| 194 | `taskKey !== null` on a link that always has one | **the entire ruling was dead code** |
| 194 | its test built a null-key failed link the product cannot produce | the canary "went red" while the arm never ran |
| 192 | `liveGoal` compared against `link.goal` where the task was built from `link.goal \|\| link.title` | permanent false drift on every title-only link |
| 192 | the rename clause fired on a RESENT title | history claiming a rename that never happened |
| 198 | "Nothing further happens on its own" | `recoverUnreactedAgentRuns` can still run an `agent-reply` turn on that task in the same boot |
| 199 | a comment promising a log line, and no log line | a vendor schema change disables the repair in silence |

**Two of the seven were vacuous tests I had personally "proved red".** That is the lesson I
would carry out of this pass above any individual ruling: *a canary is only evidence when the
state it constructs is one the product can actually reach.* Ruling 194's test proved that
deleting the arm changed the output — on a state `reconcileGoal` never produces. Both the fix
and its proof were fiction, and nothing in my own process caught it.

The seven are fixed as **ruling 200**, each with a canary re-proved against a reachable state,
and one of them — 187(b) — reproduced first as a failing test before the fix went in:

```
- "pushed": true
+ "pushed": false
```

Refuted findings are recorded too rather than quietly dropped: 34 of 41, including several
plausible-sounding ones about ruling 186's dispatch gate and ruling 193's `open_packet`
naming that did not survive being asked to demonstrate themselves.

---

## Ruling 213 — proved on the shape that produced it

`settleAbandonedWaits` has two behaviour tests in
[`run-recovery.server.test.ts`](../../app/server/runtimes/run-recovery.server.test.ts), and the
fixture is deliberately the shape **no other boot pass selects**: a `finished` primary run that
already replied, on a task still at `waiting: agent`. If any of the three existing passes could
have repaired this, the test would be measuring them instead.

Both canaries were run, and both went red:

```
# NOT EXISTS -> EXISTS  (the sweep stops seeing tasks with no live run)
AssertionError: expected +0 to be 1
AssertionError: expected 1 to be +0     <- and the live-run test inverts, proving the
                                           clause is what separates the two cases

# title "Left waiting on an absent agent" -> "Restart note"
AssertionError: the record must say why a run started: expected undefined to be truthy
```

The ordering assertion lives in `boot.server.test.ts`: the sweep must be the **fourth** step of
`reconcileRestartedWork`, after the three run-keyed passes, so a run they can still repair is
repaired by its owner and never double-handled.

One correction worth recording, because it is the same class of error as the vacuous canaries
above. My first version of the behaviour test asserted `waiting` was no longer `agent`, with the
comment *"this store deploys no operator, so the re-invoke cannot run."* The premise was false —
the log said `operator run started (real)` — so the assertion was measuring a fallback that never
fired, and it failed for a reason that had nothing to do with the fix. The test now asserts what
actually happens: the note is written and an operator run exists.

Gates after 211-213: `oxlint` clean, `tsc --noEmit` clean, **363 files / 6570 tests passed**,
`build` green.

### …and then proved live, on the deploy that shipped it

The deploy of 211-213 landed on a board that was already carrying the bug **twice**. Before the
restart, held stable across three checks a minute apart:

```
t=20s  live runs=0  waiting=agent: SHOP-4, SHOP-16
t=40s  live runs=0  waiting=agent: SHOP-4, SHOP-16
t=60s  live runs=0  waiting=agent: SHOP-4, SHOP-16
```

Two tasks claiming an agent, zero runs in `running` or `queued`, nothing moving. After
`docker compose up -d`:

```
{"msg":"settling tasks the restart left waiting on an absent agent","tasks":2}
```

Both task files now carry the note, and both got a fresh operator run (`run_Eynh52` on SHOP-4,
`run_t5E8Qk` on SHOP-16). SHOP-4's operator then did the thing no human had been offered: it read
the reviewer's `request_changes` and dispatched the Frontend Engineer to rework the storefront on
the revision that was rejected. Work that had been frozen for roughly twenty minutes resumed
without anybody guessing that a comment would wake it.

---

## Ruling 214 — the doctrine and the record, both canaried

Two independent canaries, both proved red before the fix went in.

**The doctrine.** `operator-run.server.test.ts` asserts the arm names the dispatch and says why
a comment cannot work. Restoring "Ask the reviewer which, in ONE comment":

```
AssertionError: expected 'You are operating VIB-6, "Improve the…'
  to contain '`run_agent` THE REVIEWER with `delive…'
```

**The record.** `operator-actions.server.test.ts` posts an operator comment tagging a deployed
reviewer and asserts the disclosure — and asserts, in the same test, that the tag really did
start nothing (`listRunsForTask` is empty), because that is the fact the sentence exists to
report. Disabling the disclosure:

```
AssertionError: expected '@Reviewer name everything you would s…'
  to contain 'is an agent, and an operator comment …'
```

A prompt-string test alone would have been the weaker half of this: it proves the words are
there, not that the claim behind them holds. The pairing is deliberate — if anyone later wires
mention-delivery into operator comments, the behaviour test goes red and the doctrine's new
sentence stops being true in the same commit.

Gates: `oxlint` clean, `tsc --noEmit` clean, **363 files / 6572 tests passed**, `build` green.

---

## Ruling 215 — two canaries, because there are two ways to lose the fact

The defect needs both a producer and a consumer, so both are pinned.

**The wiring** (`boot.server.test.ts`): step 1's mock reports it took `shop/SHOP-4`, and the
chain must hand that set to step 4. Dropping the third argument at the call site:

```
AssertionError: expected "vi.fn()" to be called with arguments: [ {}, {}, Set{ 'shop/SHOP-4' } ]
```

**The sweep** (`run-recovery.server.test.ts`): a task at `waiting: agent` whose only run is
`interrupted` — the exact board `finalizeOrphanedRuns` leaves behind — must settle to 0 and
write no note when that task is in the withheld set. Removing the filter:

```
AssertionError: expected 1 to be +0
```

This one is worth naming plainly: the bug was mine, in the fix I had validated live four hours
earlier, and the live validation was real. Two tasks had been stranded for over a minute with
zero live runs and the sweep settled them correctly. What that deploy could not show me is the
case it did not contain — a run still live at the stop — and the very next deploy did. The
lesson is not "validate live", which I did; it is that a live proof covers the state the board
happened to be in, and the state it was not in is still untested.

Gates: `oxlint` clean, `tsc --noEmit` clean, **363 files / 6574 tests passed**, `build` green.

### Ruling 215, proved live on the very next deploy — the same shape, the opposite outcome

The bug appeared on a deploy that caught two tasks with live runs. The fix was deployed onto
the same board in the same state, deliberately: `run_mAzC9x` (SHOP-16 primary) and
`run_MVGtqk` (SHOP-4 reviewer) both `running`, both tasks at `waiting: agent`.

Note counts in the task files, before and after:

| task | "Interrupted by a restart" | "Left waiting on an absent agent" |
|---|---|---|
| SHOP-4 | 5 → **6** | 2 → **2** |
| SHOP-16 | 3 → **4** | 2 → **2** |

The orphan sweep took both tasks and said so; the board sweep added nothing. On the previous
deploy, from the identical starting state, both counts rose. Each task then got exactly one
operator re-invoke (`run_g1x6UM`, `run_VOGPEB`) instead of two, and both resumed their
interrupted work — the reviewer restarted on PR #9's delivered revision, the infrastructure
engineer resumed SHOP-16.

---

## Ruling 216 — the lift, and the thing that must NOT lift it

Four tests, two of them about restraint.

`task-actions.server.test.ts` proves the unit: a task with `heldAtStage: "review"` is cleared by
a person, the note names them, and — the detail worth asserting — it names the stage **as the
board names it**, "the hold recorded at Review no longer stands", not by its id. A second test
proves it finds nothing and writes nothing when no hold stands, so the note can never appear
without a hold behind it.

`operator-run.server.test.ts` proves the wiring twice over: a person's `manual` run with an
`actor` clears it; a `scheduled` run leaves `heldAtStage: "impl"` exactly where it was and writes
no note. That second one is the whole of V18 in one assertion — an hourly schedule re-arming the
nudge is the bug the marker exists to prevent, and a fix that lifted it "when work starts" would
have quietly restored it.

Canaries, both red:

```
# drop the liftStageHoldForPerson call in runOperator
AssertionError: expected 'impl' to be null
# return true without clearing the marker
AssertionError: expected 'review' to be null
```

---

## Ruling 217 — canaried on a real broken store, not on the latch

The temptation here was to test the latch by calling `recordProjectionFault` and asserting health
degrades. That proves the plumbing and nothing about the seam that actually failed. So the
behaviour test in `rebuilder.server.test.ts` produces a **genuinely failing rebuild** using the
crash technique F28-D3 already established — `ALTER TABLE task_events RENAME TO task_events_gone`
— and drives it through `rebuildPath`, the same entry point the watcher and `reprojectTask` use.

One detail that would have made it vacuous: the task file has to CHANGE between the two rebuilds.
Without a new comment in the timeline the second rebuild short-circuits as "unchanged", never
reaches the write, never throws, and the test passes against code with no latch at all. The test
writes a second event for exactly that reason, and says so in a comment.

Three canaries, three reds:

```
# no recordProjectionFault in the catch
AssertionError: expected null not to be null
# no clear on a rebuild that wrote
AssertionError: expected { Object (at, sourcePath, ...) } to be null
# no degraded.push("projections")
AssertionError: expected 'ok' to be 'degraded'
```

The health test asserts the other half of the live reading: that `projections` (the row counts)
still answers happily with the fault standing, because that is exactly why counting rows was
never enough.

Gates: `oxlint` clean, `tsc --noEmit` clean, **363 files / 6581 tests passed**, `build` green.

### Rulings 214 and 216, proved live on SHOP-10 — the same task, the same question, 46 minutes apart

SHOP-10 is where both were found, and after the deploy both were exercised on it in one press of
Run operator. Its timeline now carries the before and the after within twenty lines of each
other:

```
19:11:57 · comment · operator
    @Code Reviewer, before another rework run, name everything you would still block on …
19:11:57 · note · system:policy-engine
    the operator held it twice in a row without advancing, dispatching, or opening a packet
    — treating that as a deliberate hold. Coordination is paused here …

  ── ruling 216 ──
19:57:21 · note · system:policy-engine · Hold lifted
    Arda started an operator run, so the hold recorded at Build no longer stands.

  ── ruling 214 ──
19:57:51 · comment · operator
    to: agent
    @Code Reviewer, before any further rework, name everything you would still block on …
19:58:12 · agent · operator
    Started a Codex run for the Code Reviewer agent — streaming to the agent logs.
```

The two questions are nearly word for word the same. Everything that differs is mechanism: the
first was a `post_comment` that reached nobody and was scored as inaction 49 milliseconds later;
the second carries `to: agent` because it rode a `run_agent`, and twenty-one seconds after it a
reviewer was actually reading it. `heldAtStage` is `null`, `waiting` is `agent`, and the five
tasks declaring `blockedBy: SHOP-10` are behind a task that is moving again.

The hold note also names the stage the way the board does — "the hold recorded at **Build**" —
which is what the unit test pinned rather than the stage id it is stored under.

---

## Ruling 218 — the retry is proved by NOT touching the file again

The retry test in `file-watch.service.server.test.ts` is built around the one condition that
makes the defect real: **after the failure, nothing writes the file again.** A test that
re-saved the task would pass against code with no retry at all, because the watcher would simply
rebuild on the new change. So the sequence is:

1. project a task with a one-comment timeline through a live watcher;
2. take `task_events` out from under the store (a transient write failure's shape) and save a
   second comment — the rebuild fails and the latch catches it, and the projection is now one
   comment behind its file;
3. put `task_events` back and **touch nothing**;
4. wait for the projection to reach two comments on its own.

```
# scheduleRetry deleted from rebuildFile
Error: timed out waiting for: the retry to heal the stale projection
```

It is asserted on `task_events` rather than on the `waiting` column deliberately: `rebuildTaskFile`
upserts `task_projections` BEFORE it rewrites the events (F28-D3's own finding), so a failure in
the events rewrite leaves `waiting` already correct and the timeline stale. Asserting the column
that happens to be written first would have measured nothing.

The per-file half is canaried twice — once in the rebuilder against two real files where one
fails and the other succeeds, once at the health body — because 217's version passed its own
tests while holding a single slot.

Gates: `oxlint` clean, `tsc --noEmit` clean, **363 files / 6584 tests passed**, `build` green.

---

## Ruling 219 — the only interesting case is when BOTH writes fail

The test breaks the store for the rebuild *and* for the note about the rebuild
(`ALTER TABLE task_events RENAME …` plus `ALTER TABLE provenance RENAME …`), because a store
that can still write the provenance row was never the one that hurt anybody — the catch
"worked" for every fault except the one it was written for.

```
# the inner try removed
AssertionError: expected [Function] to not throw an error
  but 'Error: no such table: provenance' was thrown
```

The test also asserts the caller still LEARNS about the failure — `projectionFaultCount()` is 1
— so "does not throw" is never confused with "says nothing".

Gates: `oxlint` clean, `tsc --noEmit` clean, **363 files / 6585 tests passed**, `build` green.

### Ruling 215, measured on a board carrying both shapes at once

The deploy of 218/219 landed on three tasks at `waiting: agent`: two with live run rows
(SHOP-10, SHOP-16) and one genuinely abandoned (SHOP-4, stranded since its `resolvePacket`
threw — F37-39). The boot log separates them by name:

```
{"msg":"settling tasks the restart left waiting on an absent agent","tasks":1,"claimedByOrphanSweep":2}
```

and each task got exactly one note, the right one:

| task | note |
|---|---|
| SHOP-10 | "the run `run_Zd07Hng1u3Zd` (operator) was still running when the server stopped" |
| SHOP-16 | "the run `run_m6CFAq3Oo2UW` (agent) was still running when the server stopped" |
| SHOP-4 | "this task was waiting on an agent, and **no run was live** when the server came back" |

Before ruling 215 all three would have carried both sentences and been driven twice.

---

## Ruling 220 — three cases, three assertions, and one deliberate silence

`org-settings-page.test.tsx` renders an MCP row for each state a server can be in and reads the
WHOLE row, not a fragment, so an assertion cannot pass on a matched substring elsewhere:

- unreviewed with write-looking tools → "3 tools look like a write and nothing is withheld: not reviewed"
- reviewed with nothing marked → "reviewed: none of its 3 write-looking tools is withheld"
- gated → ruling 176's original sentence, unchanged
- a read-only server → the row says nothing about writes at all (`not.toMatch(/write/i)`)

That last one is asserted on purpose. The easy version of this fix warns on every server, and a
row that alarms on everything is a row nobody reads — so "quiet when there is nothing to say" is
part of the behaviour, not an omission from it.

```
# the unreviewed case rendered "" again (the old behaviour)
AssertionError: expected 'github-mcpHTTP · https://mcp.internal…'
  to contain '3 tools look like a write and nothing…'
```

Gates: `oxlint` clean, `tsc --noEmit` clean, **363 files / 6588 tests passed**, `build` green.

---

## Ruling 221 — canaried on both sides of one shared constant, and on the restraint

The classification and the sentence a human reads live in different modules, so each pins its
own half, and they meet at one exported constant rather than at a duplicated regex:

```
# the classifier arm removed
AssertionError: expected 'unknown' to be 'session_missing'
# the remedy branch removed
AssertionError: expected 'The provider session this run tried t…'
  to contain 'session store on this host could not …'
```

The `unknown` in that first line is worth noting: it is what the live failure actually
classified as, and `unknown`'s sentence is the credential one — the same fallthrough F37-32
found for a DNS failure, reached by a different road.

A third test pins the restraint rather than the behaviour: the clone this pass is building runs
on `node:sqlite`, so a run whose agent hits `file is not a database` **in its own work** must not
be reported as a session failure. That is why the pattern is anchored on the store's nouns
(`thread history database`, `thread_history*.sqlite`) instead of on the error string alone — and
without that test, the cheap version of this fix would quietly misreport every future migration
bug in the clone as a broken agent session.

Gates: `oxlint` clean, `tsc --noEmit` clean, **363 files / 6592 tests passed**, `build` green.

---

## Ruling 222 — one assertion, and the fallback named in it

The test opens a real question packet as a real agent and reads the owner's inbox:

```
# notice.from removed
AssertionError: expected { kind: 'agent', name: 'Operator' }
  to match object { kind: 'agent', …(1) }
```

The canary output is the finding itself: the object the test gets back with the fix removed is
exactly what the owner saw on screen. The test also asserts the owner was notified AT ALL before
asserting who from, so "attributed correctly" can never pass by silently delivering nothing.

Gates: `oxlint` clean, `tsc --noEmit` clean, **363 files / 6593 tests passed**, `build` green.

---

## Ruling 223 — the canary that was wrong, and the fact pinned so it cannot be wrong again

This fix has two tests because the defect had two halves: a predicate that could not match, and
a fixture asserting a fact about GitHub that is false.

**The gate** (`delivery-decision.server.test.ts`). The fixture's commit read is now GitHub's real
answer — `422` with `No commit found for SHA: <sha>` — instead of the invented `404` carrying
that same sentence. With the 422 arm removed:

```
AssertionError: promise resolved "{ projectSlug: 'viberr-core', …(42) }" instead of rejecting
```

That resolution IS the live event: the acceptance succeeds, the task goes Done, and the merge
lands on a PR head nobody reviewed.

**The fact** (`github-client.server.test.ts`). A separate unit test states what the API does,
so the next person does not have to rediscover it from a merged-wrong-revision incident:

- `422 "No commit found for SHA: …"` → missing, **and** `isMissingRefAnswer` must still say
  false for the same input — the assertion that keeps the two predicates from being merged
  "for tidiness" later;
- `404` and the empty-repository `409` → still missing;
- `422 "Validation Failed"`, a `403`, and any successful answer → **not** missing.

The last group is the one that matters for restraint: 422 is GitHub's answer to a great many
things, and a predicate that read every 422 as a vanished ref would turn unrelated API failures
into false "the revision is not on GitHub" refusals across the product.

Gates: `oxlint` clean, `tsc --noEmit` clean, **363 files / 6596 tests passed**, `build` green.

---

## Ruling 224 — four restraint tests for one new option

The option is easy; not offering it wrongly is the part worth testing. Six tests across two
files:

**The offer** (`run-failure-remedy.server.test.ts`) — the wait is first, recommended, carries the
instant, names an *operator* resume, and carries no `profileId`; exactly one option is
recommended and neither the cross-backend retry nor the send-back is it. Then three restraints:
no wait when the window has **no dated reopening**, none when the window has **already
reopened**, and none for an **auth** failure carrying a reset instant — waiting fixes nothing
about a rejected credential.

**The resolution** (`task-governance.server.test.ts`) — confirming clears the packet, lifts the
block it held down, settles `waiting: human`, and writes exactly one `run-operator` schedule due
**after** the provider's instant with a prompt that says why it exists. A second test drives the
failure path on an archived task (a closed task refuses a schedule, ruling 177): the decision
still stands, no schedule is written, and the timeline says *"was **not** scheduled to resume …
run it yourself"* rather than leaving a promise nothing will keep.

```
# the wait arm removed
AssertionError: expected { kind: 'request_edit', …(5) } to match object { kind: 'wait_for_window', …(3) }
# the schedule effect removed
AssertionError: expected [] to have a length of 1 but got +0
AssertionError: expected false to be true          ← and the disclosure note is gone too
```

The doc-sync test caught the count in `file-formats.md` on the same commit, which is the
mechanism working: a new packet-option kind cannot land without the reference enumerating it.

Gates: `oxlint` clean, `tsc --noEmit` clean, **363 files / 6602 tests passed**, `build` green.

### Ruling 224 took three passes to stop being inert, and only deploying it showed that

Worth recording as a method note, because the tests were green after each one.

1. **The specialist builder.** Tests passed, canaries red. Deployed, re-triggered the stall — and
   the regenerated packet was the OPERATOR's, built by a different function the change never
   touched, still recommending "the window has reset" three hours early.
2. **The operator builder.** Tests passed, canary red. Deployed, re-triggered — and the packet
   still carried no wait at all, and no date in its title either.
3. **The instant itself.** `RunFailureFacts.resetsAt` comes from a machine `rate_limit_event`
   sent *during* a run. Codex refuses at spawn time and sends none, so on the one failure that
   stalls a board the facts are empty — while `/resources/health` was rendering
   `exhausted.resetsAt: 1789352820`, parsed by the quota store out of the provider's sentence.
   The option now reads that store when the facts are silent.

```
# the store read removed
AssertionError: expected { kind: 'request_edit', …(5) } to match object { kind: 'wait_for_window', …(1) }
```

Each step's tests were honest about what they covered and each step was still inert in
production. What closed it was deploying and provoking the real failure again — three times.

Gates: `oxlint` clean, `tsc --noEmit` clean, **363 files / 6605 tests passed**, `build` green.

### …and a fourth pass, because answering the decision re-created it

Deploying the third fix finally produced the option on the live packet, worded as intended:

> **Wait for the window and pick the task back up automatically (Sep 14, 2026 · 02:27 UTC)**
> *(recommended)* — Closes this decision and schedules an operator run for just after
> Sep 14, 2026 · 02:27 UTC, on the same account and the same model. Nothing runs until then and
> the board says so. No account, model or project policy changes.

Taking it wrote the schedule correctly — `run-operator`, `dueAt: 2026-09-14T02:28:00.000Z`, one
minute past the provider's instant — and then, **seven seconds later**, opened a brand new packet
asking the same question. Resolving a packet re-queues the operator by default; that re-queue was
refused by the quota the decision exists to wait out, and its failure opened a fresh packet. The
decision re-created itself.

`wait_for_window` now joins `NO_REQUEUE`. The canary for it took two attempts, and the first one
is worth recording as a near-miss: asserting "no run row was created" in a store that deploys no
operator passes against code with no NO_REQUEUE entry at all, and asserting "not called" after
the harness's 5 ms `flush()` passes for the same reason. The test now settles a full second —
long enough that the sibling `block_on_policy` test on the same harness sees its own call — so
the absence is real:

```
# wait_for_window removed from NO_REQUEUE
AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times
```

Gates: `oxlint` clean, `tsc --noEmit` clean, **363 files / 6606 tests passed**, `build` green.

### Ruling 224, live, on the stall that produced it

All four tasks the Codex window stopped are now waiting on a schedule instead of on a human
being awake:

| task | packet | waiting | scheduled |
|---|---|---|---|
| SHOP-3 | cleared | human | `run-operator` · 2026-09-14T02:28:00Z |
| SHOP-11 | cleared | human | `run-operator` · 2026-09-14T02:28:00Z |
| SHOP-12 | cleared | human | `run-operator` · 2026-09-14T02:28:00Z |
| SHOP-18 | cleared | human | `run-operator` · 2026-09-14T02:28:00Z |

Each timeline records the decision in viberr's own words — *"wait for the Codex window to reopen
(Sep 14, 2026 · 02:27 UTC). An operator run is scheduled to pick the task back up on the same
account. No account or project policy was changed."* — followed by the schedule note. The board
says `waiting: human`, which is true: nothing is running and nothing is pretending to.

Before the ruling the same four tasks had three exits: change the deployment's model policy,
assert a window had reset three hours early, or come back at 02:27 and press four buttons.

### …and the window actually reopened

`2026-09-14T02:28:19Z`, unattended, with nobody awake for it:

```
{"msg":"scheduled actions fired","fired":5,"skipped":0}
{"msg":"operator run started (codex structured output)","taskKey":"SHOP-3","runId":"run_VN9wvi3QS3KL","autonomy":"full"}
{"msg":"operator run started (codex structured output)","taskKey":"SHOP-11","runId":"run_t3Enau3IcMhU","autonomy":"full"}
{"msg":"operator run started (codex structured output)","taskKey":"SHOP-12","runId":"run_qTzDE-avMHdO","autonomy":"full"}
{"msg":"operator run started (codex structured output)","taskKey":"SHOP-18","runId":"run_IQMCy-HU5cA1","autonomy":"full"}
{"msg":"operator run queued — one already in flight (process lease)","taskKey":"SHOP-18","trigger":"scheduled"}
```

19 seconds after the due instant (the runner ticks at 60s), all four `pending` occurrences went
`fired` with `firedAt` stamped, all four tasks flipped `waiting: human → agent`, and the board's
subtitle fell from **"5 waiting on a human"** to **"2 waiting on a human"** — the two that
really are. SHOP-18's SECOND occurrence did not double-run: it queued behind the first on the
process lease, and when it reached the front it read the board and declined to duplicate the
handoff — *"The scheduled re-check found the delivering Frontend Engineer run still in flight
for the review-requested rework; wait for its report and do not duplicate the handoff."*

Within a minute SHOP-18's operator had dispatched the Frontend Engineer for the rework the Code
Reviewer asked for. Three hours of board time were recovered by a mechanism viberr already had
and had never offered.

The whole arc is on one timeline, in order, with no gaps:

```
23:27:21  blocked  agent    Codex refused the agent run: over usage limit
23:27:21  blocked  operator Work stalled: pick a recovery path
00:14:32  transition        Decision: Redirect with sharper guidance
00:14:39  blocked  operator Operator run failed: pick a recovery path
00:14:57  transition        Decision: wait for the Codex window to reopen (02:27 UTC)
00:14:57  note     human    Scheduled: an operator re-run at 2026-09-14T02:28:00.000Z
02:28:19  note     system:schedule-runner  Scheduled action starting
```

Files are truth, and the record is testable: every line above is in `task.md`, and the two
`fired`/`firedAt` stamps in the frontmatter agree with the container log to the millisecond.

### Rulings 225 and 226, re-reviewed against themselves before they ever deployed

Four defects in tonight's own work, none of which any test caught. Every one came from reading
the code back and asking what it would do on a case I had not imagined while writing it. They
are recorded because the ratio matters: **six hours of writing, four self-inflicted bugs, zero
found by a green suite.**

**1. Ruling 225 promised a resume the schedule runner refuses.** The predicate required no
packet, no recommendation and no acceptable completion — and said nothing about `blockedBy`. A
task that waits on other work is held (ruling 131(d)), and the runner refuses its occurrence in
those exact words: *"waits on other work (…) — no operator run was started; Viberr releases the
task when every entry is done."* So a held task with a pending occurrence would have had a card
reading "resumes Sep 14 · 02:28" over a schedule that was never going to fire. **This ruling's
own lie, reintroduced by this ruling.** All 41 canaries were green over that hole.

**2. Ruling 225 would have invented a claim on a task making none.** It keyed on
`waiting !== "agent"`, which includes `"none"` — and `"none"` renders no wait tag at all. There
was nothing to correct there, so deriving over it would have added a promise where the board had
been silent. Narrowed to `waiting === "human"`, the one stored value that says the false
sentence.

**3. Ruling 226's packet did not reach the board.** `updateTaskFile` writes the file and nothing
else; every other writer in that module reprojects after it. Without that call the decision the
person was being told about in the same breath would not appear until the file watcher happened
to notice it.

**4. Ruling 226's recommended option re-created the packet it answered.** "Try the check again"
had to be a `custom`, and a `custom` resolution sends the task back to the agent side and
re-queues the operator — which re-runs the head gate, refuses again, and opens the same packet
again. That is ruling 224's fourth half, which cost four deploys to find in September, reappearing
in a packet written the same night by the person who wrote the ruling about it.

The fix was to delete the option rather than add machinery: the packet never sets
`readiness: blocked`, so it does not refuse the acceptance, which means **pressing Accept again
IS the re-check** — the body says so, and a successful acceptance withdraws the packet by itself.
Two options remain and both do exactly what they say.

Each fix has its own canary, each proven red by reverting the guard it tests.

### Rulings 225–228 deployed, 03:32 UTC — and the schema change the store needed

I had been holding the deploy because five Codex runs were in flight and a restart kills them.
Then the container restarted **on its own** at 03:30 (clean exit 0, Docker's restart policy), and
the cost I had been avoiding became a measurement instead of a guess:

```
finalized non-terminal runs at boot: total 5
```

Five runs interrupted, five operators re-invoked, every reviewer re-dispatched within seconds,
and each task carrying the honest note — *"the run … was still running when the server stopped;
it is recorded as interrupted by the restart, and the operator is re-invoked to decide what to
do next."* The board absorbed it in about ten seconds. So the deploy went ahead immediately
afterwards, and cost the same again.

**The schema change.** Ruling 225's `waiting: "schedule"` needs the store's CHECK to admit it,
and migrations are squashed and forward-only — editing the baseline changes what a FRESH
`projection.sqlite` gets and nothing else, which is F21-1's whole point. The live root was
rebuilt in place with the app stopped (one writer per data root, ever), preserving `audit_events`,
which is not derived from markdown and could not be recreated by a rescan:

```
rows 20 -> 20
indexes recreated: 1
CHECK widened
integrity: {"integrity_check":"ok"}
```

**The boot then checked my own work.** Ruling 225 added `task_projections.waiting` to
`projectionCheckGaps` — the probe that reads the DDL SQLite itself stored and names any value the
code declares that the live root refuses. The boot integrity line came back with no gaps, which
is the widening confirmed by the mechanism the same ruling extended.

```
projection rescan complete   projects=1 tasks=20 changed=0 unchanged=28 removed=0 errors=0
finalized non-terminal runs at boot: total 5
boot integrity check … dataRootDirsOk=true migrationsApplied=1 projections={projects:1,tasks:20}
viberr server booted
```

All four rulings verified present in the running image by grepping the built server for a
sentence each one introduced.

**Exactly what is and is not live, checked rather than assumed.** The image was finalized at
`03:30:19Z`, and two refinements were committed after it. Rather than reason from timestamps I
grepped the running build for strings unique to each:

| change | committed | in the running image |
|---|---|---|
| rulings 225–228, core | before the build | **yes** (four sentences, one per ruling) |
| 225 amended — `waiting: human` exactly, `blockedBy` empty | 08:25 local | **yes** |
| 226 amended — two options, not three | 08:28 local | **yes** (`"Press Accept again to re-run the check"` present; `"Try the check again"` gone) |
| 227 — door refusal attributed to the policy engine | 08:31 local | no |
| 225 amended again — archived guard | 08:36 local | no |

Neither missing piece is reachable by anything on the board right now: no archived task holds a
pending occurrence, and the attribution one only changes which system name a door-refusal note
carries. Both go out with the next deploy. Saying "all four rulings are deployed" was true; it
would have been sloppy to leave it at that while two refinements sat behind the image.

**One casualty, handled honestly.** SHOP-18's operator was mid-run and its Codex process died
with `SIGBUS`. Viberr raised a decision packet quoting the provider verbatim — *"Codex Exec
exited with signal SIGBUS:"* — with three options and "Re-run the operator now" recommended.
Taking it restarted coordination, and within seconds all five tasks were working again. The
product's account of what my deploy did to it was accurate in every particular.

### A fifth self-inflicted bug, and the question that would have found all three

An hour after the first two, a third instance of the same hole in ruling 225: an **archived**
task with a pending occurrence would also have shown "resumes Sep 14 · 02:28". The schedule
runner refuses an archived task with its own dedicated outcome — `skipped-archived`, kept
distinct from `skipped-done` precisely so the note does not tell an archived task it was
"already Done" — so the card would have named a time for a run nothing intended to start.

R14-3 archiving removes a task from every view except the Archived filter. That filter still
draws the card, and the card still draws this tag, so the usual defence ("every consumer filters
`archived = 0`") does not apply to this particular surface.

**Three holes, one question.** I found the first two by re-reading my predicate and imagining
cases. The right question was available the whole time and is not imaginative at all:

> *What states does the schedule runner refuse?*

It answers itself in its own vocabulary — `skipped-held`, `skipped-archived`, `skipped-done` —
and each one is exactly a state where a resume time would be a lie. Asked that way the three
exclusions fall out together instead of one per hour, which is now written into the ruling as
the general rule: **a derived promise is bounded by what the mechanism behind it will actually
do, and the way to find its edges is to read that mechanism's refusals rather than to imagine
the cases.**

Held for the next deploy rather than restarting the board again for one guard that no live task
currently reaches.

### Ruling 229 — the baseline, captured before the fix went live

The claim is that `already_current` returning `noop` is what produced the flood of "plan was not
carried out in full" notes. That is falsifiable by counting, so the count was taken before the
deploy rather than argued for after it.

At **04:02:34 UTC**, across all 22 tasks:

```
"The operator's plan was not carried out in full"            58
  …of which update_branch_from_base "already up to date"     52
  …leaving refusals a human should actually read              6
```

It was 57/51 twenty minutes earlier, so the rate is roughly one new instance every two minutes
with seven tasks running — SHOP-18 produced one at 04:02, between the fix being written and
committed.

If ruling 229 is right, the second number stops growing while the first keeps pace with the
sixth. If it keeps climbing, the diagnosis was wrong and the note is coming from somewhere else.

### Ruling 227, proven live eight minutes after it deployed — and not by me trying to

At 04:12:08 I posted an `@operator` comment on SHOP-11 while its decision packet was still open,
to put the owner's instructions on the record before resolving. The door refused the trigger, as
it should. **And it said so:**

```
### 2026-09-14T04:12:08.405Z · note · system:policy-engine

An @operator turn was refused: a decision packet is open on SHOP-11 ("Resolve Verify blocker:
out-of-scope baseline findings") and coordination is paused until it is resolved — no run was
started, so nothing on this task has been acted on. Resolve it, then run the operator again.
```

Every detail of the ruling is in that one line: the door wording with no mention of a queue it
never reached, the consequence stated plainly ("nothing on this task has been acted on"), and the
`policy-engine` actor rather than `operator-lease`. Eleven hours earlier the identical action on
SHOP-2 produced nothing at all — that was F37-46, and it cost me a comment I believed had been
delivered.

I did not stage this. I was doing something else, made the same move a user makes, and the fix
caught it.

### F37-50, proven in viberr's own words in the same second

The packet option I then resolved read *"**Hold** SHOP-11 while gateway routing, tracing, and
stack-test work lands… then rerun Verify."* Its kind is `block_on_policy`. The transition it
wrote, 150ms before the note above:

> **Decision:** Fund the missing baseline separately. **SHOP-11 is unblocked** and the operator
> re-runs to re-check.

Option says hold; record says unblocked; frontmatter agreed (`readiness: ready`,
`waiting: agent`). No inference needed — the product wrote both halves itself, one after the
other, on one timeline.

### Ruling 229, live — the count that could have falsified it did not move

Baseline taken before the deploy, at 04:02:34 UTC: **58** "plan was not carried out in full"
notes, **52** of them `update_branch_from_base` "already up to date", growing at roughly one
every two minutes with seven tasks running.

Ten minutes after the deploy, at 04:13:59, with five to seven tasks running throughout:

```
total = 58      already-up-to-date = 52      (baseline 58 / 52)
```

Unchanged. Not because the condition stopped occurring — there are 106 `github`
"already up to date" events on this board and SHOP-22 produced a fresh one at 04:13:41, which is
the single-instance proof:

```
04:13:48 · transition · operator     (Design → Build)
04:13:48 · github     · operator     (Opened PR #17 for review)
04:13:41 · github     · operator     `shop-22` is already up to date with `main`. Origin's copy…
04:12:11 · comment    · agent:codex/infrastructure-engineer
```

The `github` event is there, doing its job. The note that used to follow every one of them is
not. The operator made the speculative call viberr's own tool description asks for, the branch
was current, and the record now says so once instead of twice — the second time under a headline
announcing a failure.

Had the number climbed, the diagnosis was wrong and the monitor would have said so in those
words. It did not climb.

**Final reading at 05:04 UTC, an hour after the fix: still 58 / 52.** The monitor armed to shout
"RULING 229 FALSIFIED" ran its full window and never fired.

The honest shape of that evidence: roughly forty of those sixty minutes had five to seven tasks
running, and the board went idle at 04:44 when the quota stalled everything until 07:28. So the
hour is not sixty minutes of pressure. What carries the claim is the earlier window — where the
rate had been about one new note every two minutes and became zero — plus the single instance
watched directly at 04:13:41, where SHOP-22's `github` "already up to date" event was followed by
a PR-opened event and a transition, and by no refusal note at all.

### Ruling 230 — red-proved in both halves, and a third path found by the canary

The fix has two independent halves, each proved by reverting only itself:

| reverted | test that went red |
|---|---|
| `block_on_dependencies` removed from `NO_REQUEUE` | the no-requeue assertion (a run fired) |
| the post-write `setTaskDependencies` effect removed | the `blockedBy` assertion (the hold was never written) |

Two authoring refusals have their own canary: an option naming nothing to wait on, and a
`blockedBy` on any other kind. Both refuse by name and write no packet.

**The third path was found by the canary hitting it first.** My first version of the main test
used `VIB-2` as the dependency without seeding it, and the run came back with the hold unwritten
and this in the log:

```
block_on_dependencies resolution could not record the hold
  err: AppError: VIB-2 is not a task in this project.
       at validateDependencyRefs (dependencies.server.ts:185)
```

Which is correct on both counts, and I had not planned for either. `setTaskDependencies`
validates the refs — a hold on a task that does not exist releases on nothing — and the
best-effort narration I had written fired and kept the human's decision standing. That path now
has a test of its own: the packet still clears, `blockedBy` stays empty, the timeline says
"was **not** recorded as waiting on … set what it waits on from the task page", and no run starts,
because a failed side effect must not turn "do not run" into a dispatch.

Writing the failure path before knowing it was reachable was luck. The canary is what turned it
into something known to work.

### The third vacuous canary of the pass, and what caught it

Ruling 231's test passed the first time I wrote it — **with the bug restored.** Reverting the fix
changed nothing, which is the only reason I looked at the test instead of believing it.

The cause: the override the ruling is about lives on `input.operatorRun`, and the test had set it
on `ctx`. So the react block's `if (input.operatorRun)` never fired, the chain took the
undeployed branch, and the run came back on `claude` whether the fix was present or not. A test
that cannot fail is not evidence of anything.

That makes three this pass:

| canary | how it was vacuous | how it was caught |
|---|---|---|
| `NO_REQUEUE` run-row assertion | asserted against a store with `agents: []`, so no run could ever start | red-proof |
| `NO_REQUEUE` "not called" after `flush()` | 5ms settle, faster than the re-queue it was watching for | red-proof, plus a sibling test as the control |
| ruling 231's react backend | the override set on the wrong object | red-proof |

None was found by reading the test. All three were found by breaking the source and watching the
test stay green — which is the whole reason the rule is "prove it red", not "write a test".

### Rulings 224 and 225, both proved live on a second quota exhaustion

At **04:37 UTC** the Codex window went again — reopening 07:28 — and six tasks stalled inside a
minute: SHOP-2, SHOP-3, SHOP-12, SHOP-18, SHOP-21, SHOP-22. This time both rulings were deployed,
so the whole path ran on real data with nobody steering it.

**Ruling 224, unprompted.** Every packet came up with `wait_for_window` RECOMMENDED, carrying the
provider's own instant:

```yaml
- kind: wait_for_window
  t: Wait for the window and pick @integration-verifier back up automatically (Sep 14, 2026 · 07:28 UTC)
  rec: true
  dueAt: 2026-09-14T07:28:00.000Z
- kind: retry_other_backend
  t: Retry @integration-verifier on Claude now
  rec: false
- kind: request_edit
  t: "The window has reset …, or the Codex account changed: send @integration-verifier back"
  rec: false
```

The option that permanently moves the task off its model policy, and the one that asks a human to
assert a reset three hours early, are both demoted. Taking the recommendation on each wrote a
`run-operator` schedule for 07:29.

**Ruling 225, on the board.** Before: *"21 tasks · **5 waiting on a human** in this project."*
After resolving them: *"21 tasks · **1 waiting on a human**"* — and the cards say when instead of
who:

> SHOP-18 · Browse, collections and product detail · #16 · validation failing · 🕐 **resumes 12:29**

The task page agrees, in the rail that used to say "a human":

> **Waiting on** — a schedule · Sep 14 · 07:29

### And the live board found what reading had not

The one card still reading "waiting on a human" was **SHOP-21** — no packet, no recommendations,
not blocked, not archived, a schedule pending for 07:29, and the board's own "Waiting on me"
tally reading **zero**. So the card named a person while the product agreed nobody was needed.
The F37-45 lie, surviving the ruling written to remove it.

The cause is exact: `acceptanceRefusal === null` is not "a human could accept this". The STAGE
gate is the one acceptance refusal `acceptanceBlockReason` deliberately omits, because it turns
on the workflow graph rather than the task file. SHOP-21 was at Build with nothing delivered —
no refusal to report, and nothing acceptable either, because the only thing refusing it was never
asked. Fixed by asking `isAtAcceptanceBoundary` as well, which is what the board already asks for
`atAcceptanceBoundary`, from the same graph.

**Three amendments to ruling 225 now, and they arrived in increasing order of usefulness**: two
from re-reading the predicate, one from reading the mechanism's own refusals, and this one from
looking at the board it was written for. Six hours after shipping, the surface still had the
answer that the source did not.

### The last mile of ruling 225 — and a guard I failed to use that describes my own failure

After the stage-gate amendment deployed, SHOP-21's rail **still** read "a human". The boot rescan
explained why in one number:

```
projection rescan complete   projects=1 tasks=22 changed=0 unchanged=30 errors=0
```

`changed=0`. No task file had changed, so the content-hash short-circuit skipped every rebuild —
and the rows kept the answers the OLD derivation had written. The ruling was live in the code and
absent from the board.

Viberr has a mechanism for exactly this, and its doc describes my mistake before I made it:

> The boot rescan is a content-hash short-circuit: an unchanged `task.md` is never re-projected,
> which is exactly right for offline drift and **exactly wrong for a derivation change** — the
> rows written under the old rule keep the old shape forever, on every existing instance, with no
> migration to say so… This stamp makes a derivation change self-applying.

`PROJECTION_DERIVATION_VERSION`. Ruling 225 derives a fourth `waiting` value from unchanged file
content, which is the textbook case, and I shipped it three times — the ruling and two
amendments — without bumping the stamp. Bumped to 4, and the boot did the rest:

```
boot rebuilt every projection for a derivation change   from=3 to=4
  projects=1 tasks=22 changed=30 unchanged=0 errors=0
```

**The board, finally:**

| moment | header | SHOP-21's card |
|---|---|---|
| quota stall, before any decision | 5 waiting on a human | waiting on a human |
| after resolving six `wait_for_window` packets | 1 waiting on a human | waiting on a human |
| after the stage-gate amendment + the stamp | **0 waiting on a human** | **🕐 resumes 12:29** |

Six tasks holding on a clock, every card naming the clock, and a count that means only work a
person can actually do — which is what the owner asked for when they chose "its own resting
state", nine hours earlier.

**What this cost to learn:** ruling 225 needed four corrections after shipping — `blockedBy`,
`waiting: "human"` exactly, archived, the stage gate — plus a derivation stamp. Three of the five
came from looking at the running board rather than at the code, and the fifth came from a file
whose opening paragraph is a description of the mistake.

---

## Ruling 234 — the audit browse, measured on the same table that produced F37-52

Deployed 06:40Z. The instance was idle (the Codex window had stalled every task until
07:28Z), so nothing but the fix changed between the two readings.

**The default view.**

| | before | after |
|---|---|---|
| `github.reconcile.task` rows | 91 of 150 (61%) | **0** |
| window the 150 rows span | 09:18 to 10:11 — **53 min** | 09:04 to 11:40 — **2h 36m** |

What fills the window now is the record: 7 `task.operator.packet_opened`, 7
`task.packet.resolved`, 9 `task.transition`, 13 `task.agent.replied`, 6 `task.schedule.created`.
Before, those were the rows the heartbeat was pushing out.

**The "Org-scoped" toggle.**

| | before | after |
|---|---|---|
| rows | 2 | **100** |
| reach | 09:45 to 09:46 | back to **yesterday 11:04** |
| sign-ins visible | 0 | **11** |
| user administration | 0 | 6 `org.user.created`, 5 forced password resets |
| credential changes | 0 | 1 `github.pat.created`, 1 `org.connection.created`, 2 `profile.backend.connected` |
| policy changes | 0 | 1 `org.mcp.tool_policy.changed`, 3 `org.mcp.added` |

**The single check worth keeping.** Filtering the org-scoped view for `pat` used to answer
"No events match this filter." It now answers:

```
Yesterday · 11:07   arda@viberr.dev   github.pat.created   org   pat_esbY7-6IenWI
```

Who created the instance's GitHub credential, when, and which one. That row has existed on file
since yesterday and had never been readable in the app.

**What was deliberately NOT hidden.** `projection.rescan` is 34 of those 100 rows and sits at the
top of the org-scoped list, which is untidy. It is not a heartbeat: it fires on boot and on an
explicit Re-scan, so its volume here is an artifact of this session restarting the container all
day, not of how the product runs. Hiding it would be tuning the audit log to my own workflow, and
a restart is a fact an admin may legitimately want. The hidden list stays one action long.

**And the other feed was already right, which is the argument for ruling 234's shape.** The
project Activity page reads audit rows through an ALLOW-list (`AUDIT_ACTION_KINDS`, then
`action IN (...)`), and `github.reconcile.task` appears in it zero times — only the project-wide
`github.reconcile.project` does. So the rest of the product already treated the per-task heartbeat
as a freshness fact rather than a browsable event, surfaced as "last checked" on the GitHub panel
and nowhere else. The org audit browse was the single place that selected everything and hoped the
window would sort it out. Ruling 234 does not introduce a policy; it brings the last surface in
line with one the app had already settled.

---

## The 07:29Z window, and what it actually proved

All six `run-operator` schedules fired at **07:29:38Z**. Six operator runs, then six specialist
dispatches, inside ninety seconds.

**Ruling 225 — the complete lifecycle, live.** The board went from six `resumes 12:29` clock tags
to **zero**, each replaced by an `agent working` pill, with the header still reading "0 waiting on
a human" throughout. So the derived `waiting: schedule` held for the whole nine-hour hold, cleared
the moment the schedule fired, and handed straight to `agent` without ever inventing a human
demand. That is human to schedule to agent across a real stall, not a fixture.

**Ruling 231 — partial, and the missing half is named.** Every one of the six operator runs
started on `claude` / `opus[1m]`:

```
07:29:30  SHOP-2   operator  claude  opus[1m]     running
07:29:30  SHOP-3   operator  claude  opus[1m]     running
07:29:31  SHOP-12  operator  claude  opus[1m]     running
07:29:31  SHOP-18  operator  claude  opus[1m]     running
07:29:32  SHOP-21  operator  claude  opus[1m]     running
07:29:32  SHOP-22  operator  claude  opus[1m]     running
```

This is worth recording but it is **not** ruling 231's proof: these are SCHEDULED runs, and R22
already made a schedule resolve the live deployment at fire time. Ruling 231 is about the REACT
chain, where the backend used to be carried forward as an override. The proof needs an operator
run triggered by an agent REPLY, which is still pending: the six specialists dispatched at
07:30-07:33 are on Codex and have not reported yet. Watching for it.

**Ruling 232 — no live proof yet, and the zero is vacuous.** Zero new mention notifications since
the 06:55 baseline (still 49, newest 03:55:48Z), and the operators wrote six fresh directives in
that window. But the two I read carry bare "Arda", not "@Arda":

```
SHOP-3   "...the shared-surface check for Arda's 2026-09-13 decision on this task..."
SHOP-22  "...the canonical value Arda decided on 2026-09-14 ("Adopt SHOP-2/3 value")..."
```

`findMentionSpans` requires a literal `@`, so neither would have notified under the OLD code
either. A zero produced by input that could never have fired is not evidence, and counting it as
such would be the fourth vacuous canary of this pass. Ruling 232 stands on its unit canaries
(remove the gate, two tests fail by name; drop the `audience` at the call site, the
`operatorPromptAgent` test fails alone) until a directive carrying a real `@handle` appears.

**The model policy is holding on both sides.** Operators on `claude`/`opus[1m]` at high effort;
every specialist dispatched in this window (Integration Verifier x3, Code Reviewer, Infrastructure
Engineer, Frontend Engineer) started on Codex. Controller opus high, operator opus high after the
owner's change, everything else luna max, exactly as set.

### Ruling 231's live proof is unobtainable on this board, and the reason matters

The react chain arrived. SHOP-18's Frontend Engineer replied at 07:35:24Z and the operator was
re-invoked immediately, on `claude` / `opus[1m]`:

```
07:29:30  note      schedule-runner    scheduled operator re-run for SHOP-18
07:30:59  comment   operator           to: agent  @Frontend Engineer: your 04:32 run was cut off...
07:31:01  agent     operator           Started a Codex run for the Frontend Engineer agent
07:35:24  comment   agent:codex/frontend-engineer   No storefront correction is warranted...
07:35:24  REACT     operator           backend=claude  model=opus[1m]      <- run_eCkJAm
```

That is a genuine react, and it is consistent with ruling 231. **It is not evidence for it.**

The bug was `reactBackend = input.operatorRun.backend` - the chain carried the backend of the
drive that prompted the agent, as an override that beat the live deployment. Here the operator
that prompted the Frontend Engineer at 07:30:59 was ITSELF the claude run from 07:29:31. So
`input.operatorRun.backend` was `claude`, the live deployment is `claude`, and the old code and
the new code produce the same answer. Nothing about this run could have come out differently.

Falsifying it needs a chain whose PROMPTING operator ran on Codex while the deployment reads
Claude - exactly the 04:31:44Z configuration that produced F37-51. That configuration no longer
exists: the owner set the operator to `opus[1m]` high, so every chain on this board now starts on
Claude. The precondition for the bug was removed by the same change that made the fix matter.

Manufacturing it would mean flipping the operator profile back to Codex mid-flight, which
contradicts a direct instruction from the owner, so it was not done. Ruling 231 rests on its unit
canary - and that canary is the one that PASSED with the bug restored the first time it was
written, because the override lives on `input.operatorRun` and the test had set it on `ctx`. It
only became a test of the fix once it could fail without it.

Recorded rather than quietly counted: predicting a live proof and then finding the proof
structurally unavailable is the kind of thing that otherwise turns into a green tick nobody earned.

### Ruling 232's dangerous half IS proven live, by the packet answer at 07:41

I answered SHOP-18's decision packet through the real UI, taking the operator's recommended
option and naming SHOP-21 in the note. What came back, in one operator turn:

```
07:41:19  transition  Arda    Decision: Fix both on `main` in a separate shared-surface task...
07:41:29  note        operator  Waits on SHOP-21 (added SHOP-21). Held until every entry is
                                done; Viberr releases it then.
07:41:36  comment     operator  @Arda - recorded: **SHOP-18 waits on SHOP-21** ...
07:41:36  MENTION NOTIFICATION DELIVERED
```

That comment is `toAgent: false` and contains `@Arda`, and it **notified**. This is the half of
ruling 232 that actually matters, and the half a unit test is worst at proving: the gate does not
OVER-suppress. The owner's decision rested on the operator having "a separate human-directed
comment path"; that path demonstrably still reaches a person after the change. Had the gate been
keyed on the inferred flag rather than the declared audience, or applied one writer too wide, this
is exactly where it would have gone silent - and the failure would have been invisible, because a
notification that never arrives leaves no trace.

Still unproven live: a `toAgent: true` directive carrying a real `@handle` and producing no row.
No directive since the deploy has carried one. That half remains on its unit canaries, and the
ledger keeps saying so.

**Ruling 233's untouched branch, also live.** The quote reads:

```
mentioned you - "@Arda - recorded: **SHOP-18 waits on SHOP-21** ("Re-land the SHOP-17 content...
```

`@Arda` is at character 0, so the head window already covered the mention and ruling 233 left it
byte-for-byte alone - no leading ellipsis, no re-windowing. The common case is unchanged, which is
what the ruling promised and what a windowing change most easily breaks.

### The packet kept its own promise, end to end

The option's text was a commitment: *"Confirm with that task's key in your note and I will record
the wait with `set_dependencies` - Viberr then holds SHOP-18 on the board and releases it
automatically when that task is done."* Measured against the file afterwards:

```
stage: build     readiness: ready     waiting: none     blockedBy: [SHOP-21]
```

Recorded within seventeen seconds of the decision, with the operator quoting my note back and the
dependency note spelling the release rule. SHOP-21 is chartered for exactly the two defects
("lockfile repair and manifest-derived stack test") and its Infrastructure Engineer run is live,
so the automatic release (ruling 131(e)) is now armed against a real blocker rather than a
fixture. Watching for it.

Worth naming: the operator VERIFIED the Frontend Engineer's claim itself against `origin/main`
before asking, named the convention in play (shared surface #5, which it noted "has already
stopped four tasks with the same question"), said why it was asking rather than acting (path
ownership, no missing capability), and offered a third option whose own description admits it
"does NOT unblock SHOP-18 on its own". That is a decision packet written for someone deciding.

---

## Ruling 235, proven on the task that produced the finding

Deployed at 08:02Z and tested against SHOP-2's real unpushed head, which was still sitting there.
One minute, start to finish:

```
08:03:34  Accept pressed        409 refused: "SHOP-2's delivered revision `ea5f2ff` is not on
                                GitHub: PR #13's head is `913ce9d`..."   <- toast, as before
08:03:34  github event          "Acceptance refused: the reviewed revision is not on the
                                pull request"                            <- NEW: the record
08:03:34  audit                 task.acceptance.head_unpushed            <- NEW
08:03:34  runtime.run.started   operator, trigger head-unpushed          <- NEW: the hand-off
08:03:46  github.workspace.branch_reconciled
08:03:57  operator comment      "@Arda The refused acceptance is unblocked. PR #13's head was
                                `913ce9d`, one commit behind the revision the reviewers judged;
                                I pushed the delivered revision..."
08:03:59  github event          "Pushed `ea5f2ff` to **PR #13** for review (was `913ce9d`)."
08:04:33  Accept pressed        MERGED at ea5f2ff; SHOP-2 -> Done
```

Twenty-five seconds from the refusal to the delivery that fixes it. The same sequence an hour
earlier produced: refusal, nothing recorded, operator re-runs, operator files the SAME acceptance
recommendation, human presses Accept again, refused again.

**The part that matters most is what merged.** PR #13 merged at `ea5f2ff` - the revision both
required reviewers were pinned to - not at `913ce9d`, the head the PR had been carrying. That is
the exact failure this gate exists to prevent, and the one that happened for real on SHOP-17
(ruling 223: two reviewers approved `1f99f68`, it was never pushed, and PR #12 merged at
`9104562`). Here the gate refused, the refusal became durable, the operator acted on it, and the
merge landed the reviewed code.

Nine canaries across this session, each red on only its own tests. For ruling 235 specifically:
dropping `liveHeadSha` from the definite branch (the original defect) fails both tests; skipping
the recorder fails both; dropping the idempotence guard fails only the twice-pressed one.

### The contrast that shows ruling 235 was the odd one out

Immediately after SHOP-2 merged, accepting SHOP-12 hit a DIFFERENT gate: SHOP-2's merge had moved
`main`, so PR #14 now conflicted. That path already did everything the head gate did not:

```
toast            "SHOP-12's review PR #14 conflicts with the base branch. GitHub can't merge
                  it, so it can't be accepted. Rebase the branch and re-review, or archive."
timeline event   "The acceptance-time refresh found `shop-12` in CONFLICT with `main` in
                  pnpm-lock.yaml, scripts/stack.test.mjs. The merge was aborted, the branch is
                  untouched..."                          <- names the conflicting FILES
audit            github.branch_update.acceptance
review queue     the row's status line IS the conflict sentence
"Waiting on your acceptance"   1 of 6 - SHOP-12 excluded from the acceptable set
```

So the conflict refusal is durable, file-level specific, and visible on the surface a human scans,
while the head refusal reached only a toast. Same ceremony, same button, two gates, opposite
treatment - which is what made F37-55 a defect rather than a design choice.

It also started **no** operator run, and that is correct rather than a second gap: viberr's own
operator persona says *"A CONFLICT is not yours to settle"* and *"never propose forcing the
branch"*. A conflict is a human's to resolve; an unpushed branch is the operator's to push. Ruling
235 hands off only the second.

**And ruling 235 stayed silent on the clean path.** SHOP-12's delivered revision `f2d481aab5ab`
matched PR #14's head exactly, so the head gate passed and wrote nothing: zero `Acceptance
refused` notes, zero `task.acceptance.head_unpushed` rows. The new recorder fires on the mismatch
it was written for and adds no noise to a healthy acceptance.

---

## Ruling 236, live on the board that produced it

Deployed, then one reconcile tick fetched every open PR's changed paths. The queue now renders
four collision chips, and they are symmetric and correct against the real diffs:

```
SHOP-3   collides with SHOP-11, SHOP-12 and 1 more   (SHOP-21)
         Shared files: pnpm-lock.yaml, scripts/stack.test.mjs
SHOP-11  collides with SHOP-3, SHOP-12               Shared files: pnpm-lock.yaml
SHOP-12  collides with SHOP-3, SHOP-11 and 1 more    Shared files: pnpm-lock.yaml,
                                                     scripts/stack.test.mjs
SHOP-21  collides with SHOP-3, SHOP-12               Shared files: scripts/stack.test.mjs
```

Checked against the fetched lists: SHOP-3's PR #11 really does change `pnpm-lock.yaml` and
`scripts/stack.test.mjs` alongside its 15 owned `services/inventory/**` files. Every chip names
only tasks whose diffs genuinely intersect, and every intersection is reported from both sides.

This is precisely the information that did not exist when I merged SHOP-2 and put four PRs into
conflict in one minute.

**A copy defect caught on the live render and fixed.** The first deployment's tooltip read *"put
SHOP-11, SHOP-12, SHOP-21 into conflict: both change pnpm-lock.yaml…"* - "both" is true of one
collision and false of every board that actually needs the chip. It now reads *"…into conflict.
Shared files: …"*, which is correct at any count, and the test pins it: the three-collision case
asserts the tooltip does NOT contain "both change". Restoring the old wording fails two tests.

Fourteen canaries across the session, four of them for this ruling: ignore the head pin and the
skip test fails; report a failed files call as an empty list and the absent-key test fails; drop
`partial` and the floor test fails; compute the intersection one-way and the symmetry test fails.

---

## Ruling 236 used for a real decision, on its first day

Three packets were answered and SHOP-22 came back approved on a clean host, which put it at the
acceptance boundary with both required reviewers on the current revision and PR #17 mergeable.
Eight rows were in the queue. The chips said:

```
SHOP-22   (no chip)
SHOP-3    collides with SHOP-11, SHOP-12 and 1 more   pnpm-lock.yaml, scripts/stack.test.mjs
SHOP-11   collides with SHOP-3, SHOP-12               pnpm-lock.yaml
SHOP-12   collides with SHOP-3, SHOP-11 and 1 more    pnpm-lock.yaml, scripts/stack.test.mjs
SHOP-21   collides with SHOP-3, SHOP-12               scripts/stack.test.mjs
SHOP-5    (no chip)      SHOP-18   (no chip)      SHOP-23   (no chip)
```

So the queue answered the question a person actually has at that moment - *which of these is safe
to merge right now* - without being asked, and without ordering anything. SHOP-22 was the safe one.
It merged at 11:18:45Z; **eleven merged PRs**.

The acceptance also exercised the base refresh honestly: *"Accepting the completion brought
`shop-22` up to date with `main` (12 commits merged in, merge commit `2d07f0c`; the push published
it, so origin now carries the workspace head)"*, then the merge, then the branch delete. Three
separate github events, each naming what it did.

### The three packets, and what answering them proved

- **SHOP-22** asked me to clear stray SHOP-12 processes and re-run the verifier. I checked the
  container first: ports already free, the strays had died with a restart. Answered with that
  fact rather than the assumption, and said that if the failure reproduced on a clean host it
  would be a real defect rather than contention. It did not reproduce - the Integration Verifier
  approved with *"the clean cold start and real HTTP health journey passed without nudging"*. The
  contention reading was right, and the packet's own recommended option was right.
- **SHOP-21** asked who resolves its conflict with `main`. Answered: the Infrastructure Engineer,
  because SHOP-21 owns `scripts/stack.test.mjs` by charter and the conflict is on that file plus
  the lockfile. It has since committed the merge: *"Retained the existing 512-line
  manifest-derived implementation and resolved `origin/main`..."*.
- **SHOP-23** asked whether to widen its owned paths so the auth wiring can exist at all. Answered
  yes, minimally, naming the two surfaces. Viberr recorded the decision and put the packet into
  `awaiting: goal_edit` with *"Waiting for the edited goal; the packet clears as soon as it
  lands"* - ruling 138 doing exactly what it says.

### The chip made a falsifiable claim about the future, and it was right

The absence of a chip on SHOP-22 was a prediction: merging it puts nothing new into conflict.
Checked against GitHub after the merge landed, once every `UNKNOWN` had resolved:

```
                        chip said        after merging SHOP-22
PR #20  shop-5          no collision     MERGEABLE
PR #19  shop-23         no collision     MERGEABLE
PR #16  shop-18         no collision     MERGEABLE
PR #18  shop-21         (already conflicting)   CONFLICTING
PR #15  shop-11         (already conflicting)   CONFLICTING
PR #14  shop-12         (already conflicting)   CONFLICTING
PR #11  shop-3          (already conflicting)   CONFLICTING
```

**Zero newly-conflicted pull requests.** Every PR the chip called clean stayed clean, and the four
it named as already colliding with each other were untouched by this merge because SHOP-22's diff
shares no path with them.

Set against the merge that produced the finding: accepting SHOP-2 flipped four of six open PRs to
CONFLICTING within a minute, with nothing on any surface having said it would. The difference
between those two merges is the whole point of the ruling - not that one was lucky, but that the
queue could tell them apart beforehand and did.

**Second merge, second correct prediction.** SHOP-21's chip named SHOP-3 and SHOP-12 as its
collisions. After PR #18 merged, both were still CONFLICTING (they already were, so the merge
worsened nothing), SHOP-11 unchanged, and SHOP-5, SHOP-23 and SHOP-18 all MERGEABLE - SHOP-18
having just rebased across 20 commits of `main`. Again **zero newly-conflicted pull requests**, and
again the chip had named exactly the PRs sharing paths with the one being merged.

Two merges since the ruling shipped, both anticipated correctly: the one with no chip broke
nothing, and the one whose chip named two already-conflicting PRs added no new damage.

## Ruling 237 — the deadlock packet · RED-PROVEN, LIVE PENDING

Six tests, each broken at the source to confirm it fails for the reason it claims.

| canary (source broken) | test that went red |
|---|---|
| `rounds < REVIEW_DEADLOCK_ROUNDS` → `rounds < 1` | packet opens on the FIRST objection; per-reviewer and reset tests also fail |
| per-reviewer count → `verdicts.filter(request_changes).length` | two reviewers objecting once each raise a packet |
| `&& !parsed.packet` removed from the escalation guard | the deadlock packet clobbers an unrelated open one |
| `profileId: option.profileId` dropped from the dispatch | the resolution starts `dev` — the DELIVERER — with a prompt telling it not to review |
| both authoring refusals stubbed to `find(() => false)` | a `question_reviewer` naming no reviewer, and one naming a stranger, both author successfully |

The dispatch canary is the one worth naming: with the profile gone, the resolution started the
delivering engineer, because `startAgentRun` falls back to the primary. A card that said "Ask
integration-verifier what else it would block on" would have run the deliverer instead. That is
what the authoring refusal exists for, and why the option is a real kind and not a `custom`.

**Live proof is pending by design.** The escalation fires on a verdict WRITE, so the two tasks
already sitting at two consecutive objections when it deployed (SHOP-11, SHOP-18) did not get a
packet retroactively — correct, and it self-heals on the next objection. A watcher is running
against `audit_events` for the first `task.review.deadlock` row.

## Ruling 238 — a re-review follows a base refresh · RED-PROVEN, LIVE-EVIDENCED

Six tests. The two guards, canaried:

| canary | test that went red |
|---|---|
| `drift.authored !== 0` dropped from the condition | a drift with authored commits re-pins onto unreviewed work |
| `drift.headSha !== prHeadSha` dropped | a drift measured against an older head re-pins onto commits nobody classified |

The checkout test is real git, not a string: it builds a two-commit repo, pins the supporting
checkout at the second commit with `rePinned` set, and asserts both that `HEAD` moved and that
`B.md` — the file the refresh brought — is now present in the tree. That file's presence is the
whole ruling: before it, the reviewer could not see the fix it had asked for.

**The live case is the finding itself.** SHOP-18, verified at both shas before any override:

```
b7c4c90:scripts/stack.test.mjs   readExpectedServices  0   ← the defect, as reviewed
aaf5e38:scripts/stack.test.mjs   readExpectedServices  3   ← fixed, at the PR head
b7c4c90:apps/storefront          tree c41a09e6…            ← identical, so the review still stood
aaf5e38:apps/storefront          tree c41a09e6…
```

Force-accepted as admin at 12:50:33Z with that verification recorded on the decision; PR #16
merged; SHOP-18 Done. The ceremony named both shas and the base-refresh split before I confirmed,
which is what made the check possible at all — and is the reason the override is defensible rather
than a guess.

### Ruling 237, reviewed adversarially against itself

Writing a packet directly rather than through `operatorOpenPacket` means carrying that door's
guards by hand. Two were candidates; one was a real defect and one was not, and the difference was
only visible by trying to break the test.

- **Ruling 177's closure guard — MISSING, now fixed.** A reviewer run that finishes after its task
  was accepted, force-accepted or archived still records its verdict (ruling 177's own arm says so
  in as many words: "its report is on the record; no coordination follows"). The escalation would
  have opened a decision packet on a shipped task — precisely the packet F36-5 found live and
  `operatorOpenPacket` refuses by name. Canaried: stub the closure clause to `true` and the test
  reads `expected { id: 'pkt_…' } to be null` on a Done task.
- **Ruling 137's offer withdrawal — NOT needed, and the test proved it.** I wrote the withdrawal
  first, and its canary would not go red. The reason is that a `request_changes` always derives
  `validation: "failing"` and the verdict block's own filter three lines later already drops every
  `accept_completion` card. The withdrawal was dead code writing a second "the offer was withdrawn"
  line for one disappearance, so it came out. The test stayed, re-aimed at the coupling that
  actually holds: canary `r.kind !== "accept_completion"` in the filter and it reads
  `expected [ 'rec_accept' ] to not include 'rec_accept'`.

The second is the more useful record. A test that cannot go red is not a weak test, it is a
statement that the code under it does nothing.
