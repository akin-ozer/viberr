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

**Live proof — the fix caught the original bug on its first reconcile after restart**, with no
prompting from me:

> **Work lost:** commit `3aad6ff` was recorded for `shop-2` but is not on it. It was committed
> inside a run's workspace and never delivered, and that workspace is gone, so the change it
> held is not recoverable. SHOP-2's goal is unchanged — run it again to redo the work.

`task.md` now reads `commits: []`, and the announcement is **idempotent**: one `Work lost`
event on SHOP-2 across the four reconcile passes that have run since, because the drop
persists into the cache the next pass reads. And the same GitHub page row, before and after:

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
