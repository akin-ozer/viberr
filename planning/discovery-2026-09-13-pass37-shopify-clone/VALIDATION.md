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
