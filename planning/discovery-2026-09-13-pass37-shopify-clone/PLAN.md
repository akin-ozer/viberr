# Pass 37 — implementation plan

Branch `pass37/shopify-clone-fixes` on `akin-ozer/viberr`. Every item below names the
finding, the exact code, the change, and **the test that must be able to go red** — proved by
breaking the source, not by assertion.

Pre-prod rules apply: no migrations, no backwards compatibility, break things freely, tests
included.

## Proposed rulings

Numbers continue from 185.

- **186** — A dependency hold is a hard gate on dispatch (owner decision D37-1, F37-2).
- **187** — The canonical record distinguishes a pushed commit from a workspace commit, and
  never renders the second as the first (F37-8).
- **188** — A controller read returns what the equivalent human surface renders (F37-3, F37-5,
  F37-6, F37-7).
- **189** — A person's decision joins the task's contract, not just its timeline (F37-10).
- **190** — A share whose complement was never observed is not a measurement (F37-12).
- **191** — Everyone who plans against the shell is told what the shell contains (F37-13).
- **192** — A retry rebuilds from the task, not the link's frozen copy (F37-15, amends 155).
- **193** — A reviewer that cannot pass is a decision, not a defect (F37-14).
- **194** — A retry that starts nothing says so (F37-16).
- **195** — A refusal always leaves `waiting` honest, the packet arm included (F37-17).
- **196** — The image ships `make`, `curl` and a pinned `pnpm`; Docker stays out (owner
  decision D37-3, answering F37-13's other half).
- **197** — A template's persona is readable, and the tool says which omissions are safe
  (F37-18, completes F33-7).

### Day two — how these were sequenced

The day-two rulings are not independent items; they are one root and its consequences, and
they were fixed in that order deliberately:

1. **191 first** — put the measured inventory in front of the planner and the agents. Nothing
   else can be judged while the people making the decisions cannot see the environment.
2. **196 second**, once the owner had chosen (D37-3) — close the part of the gap that is cheap
   to close, and leave Docker's absence explicit rather than accidental.
3. **193 third** — because 191 and 196 together still leave a reviewer that legitimately
   cannot pass, and the doctrine had no answer for that but another rework.
4. **190, 192, 194, 195, 197** — the independent honesty defects found alongside, each with
   its own red-proof.

Two of them were self-review catches on my own fixes, recorded rather than quietly amended:
**190** shipped guarding one side of a symmetric problem, and **191**'s advice paragraph was
two hardcoded sentences that both went stale or false under 196.

---

## C1 — The dependency hold becomes real  ·  F37-2  ·  ruling 186  ·  HIGH

**Owner's decision (D37-1):** hard gate, one spelling. A held task refuses **every** agent
dispatch, exactly as the archived/terminal gate does. No supporting-run carve-out.

### C1.1 Gate the dispatch

`app/server/tasks/specialist-run.server.ts`, in `startAgentRun`, immediately after the
ruling-177 closure block (~line 1215):

```ts
{
  const held = existing.parsed.frontmatter.blockedBy;
  if (held.length > 0) {
    throw AppError.validation(holdRefusal(input.taskKey, held, "running an agent on it"));
  }
}
```

`holdRefusal` is new and shared — put it beside `closureRefusal` so the two refusals read
alike and no door can drift. Sentence shape:

> SHOP-2 waits on goal-1 link 5 and Viberr is holding it, so running an agent on it is
> refused. Viberr releases it when every entry it waits on is done, or change what it waits
> on with Edit what it waits on.

Every door reaches this: the operator's `run_agent`, the controller's `run_agent`, the task
page's Run-an-agent control.

### C1.2 Make the pre-click surfaces say the same thing

Mirror U36-10's pattern for the closure gate: the task page's Run-an-agent control must be
disabled with this same sentence, so the words before the click match the server's answer.
`app/features/task-detail/execution-profile.tsx` already does this for stage ineligibility
(`stageIneligibilitySentence`) — add the hold beside it.

### C1.3 Stop the operator burning turns

`HELD_TRIGGERS` in `app/server/runtimes/operator-run.server.ts:290` is
`{create, transition, scheduled}`. With C1.1 in place a reactive turn can no longer dispatch,
so its only remaining useful act on a held task is answering a human. Narrow the exception to
exactly that: keep `agent-reply`, a human comment and a resolved packet driving; refuse
`pr-diverged` and `goal-edit` the way `create` is refused. The held doctrine text stays (it
is still right for the answering turn) but stops being load-bearing.

### Tests — each must go red when the source is broken

1. `app/server/tasks/specialist-run.server.test.ts` — "ruling 186: a held task refuses an
   agent dispatch". Build a task through the real writers, `setDependencies` it onto an
   unfinished entry, `installFakeRuntime()`, call `startAgentRun`, assert it rejects with
   status 400 **and** `startedRunSpecs()` is empty. *Red when:* the gate block is deleted.
2. Same file — "the refusal names the entries it waits on", asserting the entry string
   appears in the message. *Red when:* `holdRefusal` is replaced by a generic sentence.
3. Same file — "a released task dispatches again": satisfy the dependency, let
   `releaseDependents` clear it, assert the dispatch now succeeds. *Red when:* the gate reads
   a stale list rather than the live file.
4. `app/server/controller/controller-toolkit.server.test.ts` — the controller's `run_agent`
   takes the same refusal. *Red when:* the gate is put in a route instead of the chokepoint.
5. `app/features/task-detail/execution-profile.test.tsx` — the control renders disabled with
   the server's sentence. *Red when:* C1.2 is skipped.

---

## C2 — A workspace commit is never rendered as a repository commit  ·  F37-8  ·  ruling 187  ·  HIGH

**The defect.** `task.md` records `github.commits[].sha` for a commit that lives only in a
run's workspace clone. The clone is disposed; the record is not. The GitHub page then renders
"1 commit" and the board shows a branch with work on it.

### C2.1 Give a recorded commit a standing

Extend the `github.commits[]` entry in `app/schemas/task-file.schema.ts` with
`standing: "pushed" | "workspace"`. The vocabulary already exists in
`app/server/tasks/workspace-refresh.server.ts` (`"unpushed" | "ahead" | "in_sync" | "diverged"`)
— reuse its derivation rather than inventing a second one. Pre-prod: no migration, change the
schema and the writers together; a file without the key parses as `"workspace"` (the
conservative reading, since a pushed commit is always confirmable and an unconfirmed one must
never claim to be pushed).

### C2.2 The reconciler is the confirmer

`app/server/github/github-reconciler.server.ts` already fetches the branch's real commits. On
each reconcile: mark an entry `pushed` when the remote has that sha; when the remote does not
have it **and no workspace holds it**, drop it and write a typed timeline event saying so —
the work is gone and the record must say the word:

> The commit `3aad6ff` recorded for `shop-2` is on no branch and in no workspace. It was
> committed in a run's workspace and never delivered; that workspace is gone, so the change
> it held is lost. The task's goal is unchanged and can be run again.

### C2.3 Every renderer states which kind it counts

- GitHub page branch table (`app/features/github/*`): "1 commit" becomes "1 commit ·
  not pushed" for a workspace standing; a lost entry renders as "no commits".
- Board card and task page: a branch whose only commits are `workspace` does not read as
  delivered work.
- `insights-query.server.ts` already counts this correctly (traceability) — leave it, and
  cite it in the code comment as the surface that got it right first.

### Tests

1. `app/server/github/github-reconciler.server.test.ts` — "ruling 187: a recorded commit the
   remote does not have, with no workspace holding it, is dropped and announced". Use
   `fakeGithubFetch` to answer a branch whose commit list lacks the sha. Assert the entry is
   gone from `task.md`, a typed timeline event exists, and its text names the sha and the
   branch. *Red when:* the drop is removed, or the event is not written.
2. Same file — "a commit the remote HAS is marked pushed". *Red when:* the standing is
   hard-coded.
3. `app/shared/mapping/task.server.test.ts` — a summary built from a workspace-only commit
   list reports no delivered commits. *Red when:* the mapping ignores standing.
4. `app/features/github/github-page.test.tsx` — the branch row renders the unpushed wording.
   *Red when:* C2.3 is skipped.

---

## C3 — A controller read returns what the human surface renders  ·  F37-3, F37-5, F37-6, F37-7  ·  ruling 188  ·  MED

One family, one ruling, four call sites. All in
`app/server/controller/controller-toolkit.server.ts`.

### C3.1 `get_project` reports resolved eligible stages (F37-3)

`assembleAgentRoster` returns `stages: def?.stages ?? template?.stages ?? []` — the raw
declaration. Emit the board-resolved list through the **shared**
`resolveDeclaredStages(declared, stages, workflow)` that `agents-page.tsx`,
`execution-profile.tsx` and the dispatch gate already use, and keep the raw list beside it as
`declaredStages` so a remap is visible rather than silent.

*Test:* `controller-toolkit.server.test.ts` — a profile declaring `ready`/`impl` on a board
with neither reports the resolved board stages and flags the remap. *Red when:* the raw list
is emitted.

### C3.2 `get_task` stops leaking a stage-filtered column (F37-5)

`validation_block_reason` is documented as stage-unaware because "every consumer filters rows
… on the resolved review stage before it ever looks at this column". `get_task` does not.
Replace the raw `blockReason` with a resolved `acceptance: { canAccept, reason }` computed
through the same precedence `boardAcceptRefusal` uses (`atAcceptanceBoundary` first).

*Test:* a Design-stage task with a required-reviewer gate pending reports the stage reason,
not the Review-stage sentence, and never the word "force-accept". *Red when:* the precedence
is reordered or the raw column is restored.

### C3.3 `list_mcp_servers` reports the write-tool marking (F37-6)

Add `writeTools: string[]` plus the derived sentence the Org settings row shows ("N write
tools withheld from read-only runs"). State ruling 176's enforcement in the tool description
so a model granting a server knows what the marking does.

*Test:* a server with marked tools reports them. *Red when:* the field is dropped.

### C3.4 `save_mcp_server` can govern what it creates (F37-7)

Add `writeTools?: string[]`. On **create** with the parameter absent, apply the same
`looksLikeWriteTool` default the editor pre-ticks, so a controller-created server is no less
governed than a human-created one. Return the resolved marking in the reply. Keep the update
sentinel (`undefined` = leave unchanged) exactly as it is.

*Test:* a server created through the controller with no `writeTools` lands with the heuristic
default, and one created with an explicit list lands with that list; an update omitting the
field preserves the existing marking. *Red when:* the default is dropped (the created row
comes back with a null policy — the exact live symptom).

---

## C4 — The sync pill cannot go stale when `main` moves  ·  F37-9  ·  MED

`github-reconciler.server.ts:897`: `changed` compares only `fm.pr` and `fm.github`, so a
`sync` flip persists nothing and the poller (`skipUnchangedProvenance: true`) writes no
provenance row. The UI reads provenance. Fix: treat a changed compare verdict as a reason to
refresh the sync fields — update the existing observation row rather than appending one, so
the "grow unboundedly" concern the current comment names is untouched.

*Test:* `github-reconciler.server.test.ts` — reconcile a branch as `synced`, move the base so
the next reconcile measures `behind_main` with no task-file change, assert the surface the
pill reads now says `behind_main`. *Red when:* the sync refresh is removed.

---

## C5 — The write-tool heuristic learns the common mutation verbs  ·  F37-4  ·  LOW

`WRITE_VERBS` in `app/shared/mcp-tools.ts` is seven words and misses `edit_file` and
`move_file` on a stock filesystem MCP server. Add at least `edit`, `move`, `rename`, `patch`,
`append`, `put`, `insert`, `upsert`, `replace`, `set`, `drop`, `truncate`. The word-splitting
around it is already correct and stays.

*Test:* `app/shared/mcp-tools.test.ts` has positive/negative tables — extend the positive one
with the real names from this pass (`edit_file`, `move_file`, `renameFile`, `patch_document`)
and keep a negative guard so `moved_at` / `settings` do not match. *Red when:* the new verbs
are removed.

---

## C6 — WITHDRAWN  ·  F37-1

Not implemented, deliberately. `log-noise.ts` already collapses telemetry in the console and
says it is doing so, and the stored row is what `{ } raw` exists to show. Measured over the
whole pass, telemetry is 13% of rows and 1.5% of bytes — not the flood one early turn
suggested. Dropping the rows would break a documented honesty contract to save 70 KB.

## C7 — The operator can see how far its branch is behind the base  ·  F37-11  ·  LOW

Added after the plan was written, when 8 of the pass's 9 "plan was not carried out in full"
notes turned out to be one step. `baseBehindBy` on the operator's snapshot, read through
`createReconcileBehindByLookup` — the same lookup the GitHub page's sync pill uses. The
call-when-unsure posture is deliberately unchanged; `null` is explicitly not a reason to skip
the call. Tested for all three readings (absent / behind / level), red-proved by pinning the
field to null.

## Validation for every item

- `npm run lint && npm run typecheck && npm test && npm run build` green.
- Each test proved red by breaking its source, then green again — recorded in `VALIDATION.md`
  with the exact break used.
- The live app rebuilt from this branch and re-driven through the UI for C1, C2 and C4, with
  screenshots.
- Docs updated in the same change: `docs/architecture/decisions.md` (rulings 186-188),
  `docs/domain/task-lifecycle.md` (the hold gate), `docs/domain/github-delivery.md` (commit
  standing, the sync pill), `docs/domain/controller-and-goals.md` (the four tool changes).

---

# Session four — items D1-D6

Found and fixed in sequence rather than planned up front, because each came out of driving the
live board. Same discipline as C1-C7: a test proved red by breaking the source, then the live app
re-driven through the UI. Red-proofs and live-proofs in `VALIDATION.md`.

## D1 — A directive handed to an agent stops notifying people  ·  F37-53  ·  ruling 232 (owner)

The gate lives at the ONE fan-out seam (`audience: "agent"` on `NotifyMentionsInput`), not at the
call site, so a future declared-agent writer inherits it. Boundary drawn deliberately and stated in
the ruling: `appendComment` DERIVES its `toAgent` from the presence of an agent handle, so the gate
is for writers that DECLARE the audience — today `operatorPromptAgent` alone. A blanket reading
would have dropped the human half of "@dev implement the endpoint, @Bora look at the schema first".
Second half, implied by the owner's own words ("the operator should use its human-directed path"):
the persona now says which path is which, in the shipped asset and the fallback.
*Canaries:* remove the gate (two tests by name); drop the `audience` at the call site (the
`operatorPromptAgent` test alone); delete the persona sentence (assertion + drift check).

## D2 — A mention notification quotes the mention  ·  F37-53  ·  ruling 233

`resolveMentionTargets` now returns the handle-to-user map it always computed and threw away, and
the quote is windowed on the first span resolving to THAT recipient. The head window is kept when
it already covers the mention, so the common case is unchanged byte for byte.
*Canary:* force `quoteAround` to take the head.

## D3 — The in-app audit browse reaches the class it exists for  ·  F37-52  ·  ruling 234

Two halves. The unconditional per-tick reconcile heartbeat is excluded from the BROWSE only — table,
retention sweep, export and `latestTaskReconcileCheckAt` untouched, so F19-22's guarantee holds. And
"Org-scoped" became its own SQL query instead of a client-side filter over whatever the unscoped
window returned. The loader fetches both windows so the toggle stays instant.
*Canaries:* stop hiding the heartbeat; ignore `orgOnly` in SQL; filter one list in the UI again.

## D4 — A refused acceptance is recorded and handed to the operator  ·  F37-55  ·  ruling 235

The known-mismatch branch now carries `liveHeadSha`, which is the one missing field that had made
`refuseUnverifiedHead`'s recorder skip silently. Not a packet — a known mismatch is not a decision —
but a timeline event, a `task.acceptance.head_unpushed` audit row with its own `auditText` sentence,
and a `head-unpushed` operator hand-off whose turn instruction names the delivery and forbids
re-filing the recommendation. Idempotent by note text.
*Canaries:* drop `liveHeadSha` (the original defect); skip the recorder; drop the idempotence guard;
delete the `auditText` case.

## D5 — The review queue names colliding pull requests  ·  ruling 236 (owner)

`pr.paths` records the changed paths pinned to the head they were read at; the pin is what makes the
fetch nearly free. A failed read leaves the key ABSENT (the same convention as `checks`/`review`/
`mergeable`) so a GitHub hiccup keeps the cached list rather than erasing every chip. Capped with
`truncated` carried to the surface, because a clipped list can only MISS a collision. The
intersection is server-side and symmetric.
*Canaries:* ignore the head pin; report a failed files call as an empty list; drop `partial`;
compute the intersection one-way; render a count instead of names.

## D6 — Two small honesty fixes  ·  F37-54, F37-56

`longTimelines` takes its boundary from `compactTimelineEvents` itself (`>`, not `>=`), and the test
asserts the real rule on both lengths rather than restating a number. And the agent personas say to
write "they" unless a person has stated otherwise, because the record had been inventing the owner's
gender two incompatible ways in one project.
*Canaries:* restore `>=`; delete the pronoun sentence.

## D7 — The second objection reaches a person  ·  ruling 237 (owner: escalate, not gate)  ·  F37-57

`reviewDeadlockOf` reads ruling 204's per-reviewer count inside the verdict's own locked write, and
`buildReviewDeadlockPacket` is a PURE builder so the objection and the escalation land together or
not at all. Written by the POLICY ENGINE (`from: policy-engine`), not through `operatorOpenPacket`,
for ruling 226's reason — that door checks the OPERATOR's `generate-packets` grant and this is not
the operator's judgement — which means carrying that door's guards by hand: ruling 177's closure
check is the one that was missed first time. `question_reviewer` is the 17th packet kind and its
resolution STARTS the named reviewer; authoring refuses one naming no reviewer or naming the
deliverer. The completion that raises the packet does NOT then run its own operator react, because
`agent-reply` is a machine trigger and ruling 195 exempts those from the open-packet refusal.
*Canaries:* drop the threshold; count every verdict instead of one reviewer's; drop the packet-slot
guard; drop `profileId` from the dispatch (it starts the DELIVERER); stub either authoring refusal;
stub the closure clause (a packet on a Done task); delete the react-suppression arm (a second
operator run appears); move the timeline unshift back inside the verdict block (an inversion the
`timeline.out_of_order` diagnostic reads).
*Do NOT re-add:* `withdrawAcceptanceOffers` in the escalation. It withdraws nothing — a
`request_changes` always derives `validation: "failing"` and the verdict block's own filter already
drops every `accept_completion` card. Its canary would not go red, which is the proof.

## D8 — A re-review follows a base refresh  ·  ruling 238 (owner)  ·  F37-58

`reviewSubjectSha` moves the review subject to the PR head when the drift is base-refresh ONLY, and
`pinSupportCheckout` takes a `ReviewSubject` so the disclosure names BOTH shas and the refresh
between them. One authored commit anywhere in the drift keeps ruling 179's pin; so does a drift
measured against a different head, because such a measurement classifies none of the commits on
this one. The verdict still binds to the reviewed revision: the revision is the deliverable's
identity, which the refresh did not change.
*Canaries:* drop `authored !== 0`; drop the `drift.headSha !== prHeadSha` guard. The checkout test
is real git and asserts the refresh-brought file is present in the tree, which is the whole ruling.

## D9 — One rulings KB per project  ·  ruling 239 (owner)

`project.md` carries `rulingsKb`; `withProjectRulings` appends it (never prepends — the injection
budget is spent in order) and dedupes it into all three KB lists: specialists, the operator's
resolved authority, and the controller while its conversation is scoped to the project. The
controller sets it with `set_project_rulings_kb`, refusing a directory no KB occupies.
*Canaries:* prepend instead of append; drop the dedup; drop the store check; drop the parser field
(it writes and reads back `undefined`); stub the controller condition to `false` (scoped prompt
loses it) and remove it entirely (an instance-scoped prompt gains another project's rules).
*Test lesson worth keeping:* the first controller test asserted three source substrings and passed
with the condition stubbed out. Source assertions pin a call SITE; they do not test behaviour.

## Not items, recorded so they are not re-opened

- **The clarity metric** (`waiting !== none || owner != null`) looks vacuous because every task here
  has an owner, but ownership CAN be released to null (`task.ownership.admin_released`), so it can
  genuinely drop. Left alone.
- **The `readiness` difference** between file and projection on six tasks is ruling 131's dependency
  floor working, with `stored_readiness` preserved beside it. Left alone.
- **Attachments are overwritable by filename.** Real, but no evidence row references one: an
  `EvidenceRow` is `{label, add, del}`, documented as "A REFERENCE, never a dump", and its backing is
  the run log, which still holds the older claims. Left alone.
