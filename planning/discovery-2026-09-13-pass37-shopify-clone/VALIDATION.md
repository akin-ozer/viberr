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
