# Pass 38 — findings

Viberr builds an Airbnb clone in `akin-ozer/airbnb-clone` through its own controller.
Each finding: what was observed live, how often it had ALREADY been wrong on this
instance before it was believed, the refutation attempt, the fix, and the red-proof
(the test was made to fail by breaking the source, then restored).

Candidates that died, and what killed them, are in `CANDIDATES.md`.

## F38-1 — The tool manifest told the controller a `select:` shape its own names cannot satisfy (LOW; ruling 347)

**Observed** 2026-09-18 02:02:30Z, the first turn of the new conversation: the controller's
first two ToolSearch calls were `select:whoami,list_capabilities,…` and
`select:instance_health,list_mcp_servers,…`, both answered "No matching deferred tools
found"; the third guessed `select:mcp__viberr_controller__whoami,…` and worked.

**Why it did that.** Ruling 297's manifest (`tool-manifest.server.ts`) lists `- ${t.name}: …`
— the bare registry name — and says the description is "one ToolSearch away
(`select:<name>`)". The SDK mounts a server tool as `mcp__<server>__<name>`, and ToolSearch
answers to nothing else. Followed literally, the instruction fails every time.

**Measured** over `run_log_lines` before the fix: 40 controller runs used ToolSearch, **8 of
them wasted their opening calls on the bare-name miss (14 misses)**; 2 of 12 reviewer runs
too. The other runs learned the prefix from the per-turn deferred-name reminder, which is
the incremental list ruling 297 was written to replace.

**Refutation tried.** Is the miss caused by something else — a tool genuinely absent? No:
every missed name was on the manifest, and the same names succeeded one turn later with
the prefix. Is the cost real? Two turns and ~3 s per affected run; nothing lost, nothing
false is said to a person. So LOW, and fixed because the fix is one line and the
instruction was viberr's own, not the model's guess.

**Fix.** The manifest lists the mounted name (`mcp__viberr_controller__whoami`) and the
hint says `select:` takes the full name exactly as listed. `mountedToolName` is exported
so the toolkit's allow-list and the manifest cannot spell the prefix differently.

**Red-proof.** `tool-manifest.server.test.ts`: with the line restored to `${t.name}`, three
tests fail (the new one and the two that read a line by its name); restored, five pass.

## F38-2 — The live-run step named a finished tool as the thing the run was doing (LOW-MEDIUM; ruling 348)

**Observed** 2026-09-18 02:10:31Z → 02:12:33Z: the controller's live row read
`Working · mcp__viberr_controller__get_github_state · {"projectSlug":…}` for two minutes after
that call had answered, while the Agent-logs console one panel down logged thinking lines. I
misread it as a hung tool on the first turn of the pass (`list_mcp_servers`, 72 s).

**Why.** Ruling 250 (F37-79) put the step on the working row, read off the last TOOL line, and
`lastStep` sticks until the next tool line. Nothing reacted to the tool's result.

**Measured** over the 40 controller turns before the fix (`run_log_lines`, tool_result → next
tool_use gaps): **76 stretches longer than 20 s on 26 of the 40 runs, 3,198 s (53 min) in all,
the longest 138 s.** Each one a finished call displayed as current.

**Refutation tried.** Is the row honest anyway because "Working" is true? The row's DETAIL
names a specific tool with its arguments as the current act; a person reads it as "it is
running get_github_state now". The console (same page) contradicts it. Same shape as ruling
311's "Started … streaming" for a queued run: a durable surface saying "in progress" about
something that is not. Kept: LOW-MEDIUM (false sentence, misled a person; no action taken on
it beyond mine).

**Fix.** Both adapters mark the step answered on the result line (`composing · <tool> · <input>
answered`); Codex's succeeding MCP call, which projects no completion row, carries a
`toolAnswered` fact instead; the service's phase throttle writes a suppressed step when its
window closes (trailing flush) and never onto a settled row.

**Red-proof.** `adapter.server.test.ts` (3 cases), `claude-runtime.server.test.ts` (1),
`codex-runtime.server.test.ts` (2): with the answered branches returning null, 6 fail.
`run-service.server.test.ts`: with the deferred write removed, the throttle test fails. All
restored green (227 across the five files).

## F38-3 — A run parked behind the concurrency cap read "agent working" on the board, the hero and the rail (MEDIUM; ruling 349)

**Found by** the lens-2 sweep (`LENS2-SURFACE-AGREEMENT-SWEEP.md` C1), then verified in code:
`markWaitingAgent` (`task-actions.server.ts`) is called after `startRun` returns whatever the
outcome, and `WaitTag` / `ReadinessPill` / the Current-state rail render `waiting === "agent"`
as work in flight. The console and the timeline say "queued … Nothing is streaming yet".

**Measured** on this instance before the fix: **129 "Queued a … run" timeline events across 33
tasks** — 129 stretches in which the board card pulsed "agent working" about a run that had
not started.

**Refutation tried.** Does the board revalidate away from the lie quickly? No: nothing on the
card changes until the run is promoted, which on a saturated instance is minutes (ruling 311's
live case was 11 minutes). Is "agent working" defensible because the task IS on an agent? The
pulsing dot and the word "working" claim streaming work; the product's own sibling surfaces
disagree on the same page. Ruling 311's twin, so MEDIUM.

**Fix.** The loaders read the run row once per project (`liveRunStateByTask`) and
`withLiveRun` (mapping) derives `agent_queued` from `agent_working` while the run is parked;
the card, the pill and the rail say "agent queued" without a pulse and name the cause.

**Red-proof.** Loader test (`project.server.test.ts`): with the annotation dropped, red.
Mapping test: with `withLiveRun` returning the display state unchanged, red (and the loader
test with it). Board test: with the queued branch unreachable, red. Restored: 233 green.

## F38-4 — The Agent-logs footer contradicted the pill above it for four failure classes and two interrupt cases (MEDIUM; ruling 350)

**Found by** the lens-2 sweep (C2, C3, C4), verified in `runs-panels.tsx`: the `unavailable`
class arm was kind-gated, four classes had no arm, and "the thread stays resumable" was printed
for every person-interrupt.

**Measured** on this instance: 1 operator drive carried `run·unavailable` (footer: "continuity
error; see the blocked packet"); 2 of 2 person-interrupted runs were closure interrupts
(footer: "stays resumable" about a task ruling 177 closes to re-runs); 0 spending-cap /
turn-cap / idle cut-offs so far (latent arms).

**Refutation tried.** Is the footer's fall-through "continuity error" defensible as a generic
word? Ruling 130(a) defines it as "only an unclassified" failure, and the pill on the same bar
names the class. Is "resumable" true in the Stop-click case? Yes — and the row cannot tell a
Stop click from a closure, which is exactly ruling 338's rule: say only what the row holds.

**Fix.** The class describes the run whatever its kind; arms for `max_budget`, `max_turns`,
`idle_timeout`, `session_missing`; the interrupt sentence reads `sid`; the unclassified
sentence points non-specialists at the error line.

**Red-proof.** Four new tests; each fails on its own canary (kind gate restored, `sid` ignored,
one unclassified sentence, `max_budget` arm dropped). Restored: 94 green across the panel and
helper files.

## F38-5 — The controller's guide told it to push tasks forward with a route that starts nothing (LOW; ruling 351)

**Found by** the lens-1 sweep (#14). The guide's "prefer `comment_on_task` with a clear @operator
directive" contradicts the tool's own description ("a comment starts no run", ruling 252) and
the code. **Measured:** 4 of 21 controller comments on the live shopify board were @operator
directives. **Refutation tried:** does anything read the comment? Only a later run that happens to
read the timeline; nothing is dispatched by it. Kept LOW: nothing false was told to a person, but
the product's own instruction sent its agent through a dead door. **Fix:** the sentence, plus the
outgoing hash in `PRIOR_SHIPPED_HASHES` so the live store converges at boot. **Red-proof:** the
seed-asset tests pin the hash list shape (16 green); the sentence is prose, pinned by review.

## F38-6 — The project door stored stage colours no surface can draw (LOW; ruling 352)

**Found by** the lens-2 sweep (C6); **verified live**: on the shopify board the Triage and Review
column dots compute to `rgba(0, 0, 0, 0)` — `slate` and `amber` are not CSS colours — while the
four other stages draw. **Measured:** 2 of 6 stages on the one controller-created board before
this pass; the airbnb board was created with hex values and draws all six. **Refutation tried:**
is a missing dot cosmetic? Yes, which is why it is LOW; it is kept because the tool accepted a
value the product could never render and no later door could fix it. **Fix:** refuse at the
door, naming the value and the accepted forms; the tool's description says so up front.
**Red-proof:** with `isCssStageColor` returning true, the new test fails; restored, 134 green.

## F38-7 — The lease gate measured the push, not the branch (LOW-MEDIUM; ruling 353, amends 245)

**Found by** the lens-1 sweep (#15), verified in `push-workspace.server.ts`: `changedFilesForPush`
lists `remoteHead..HEAD`, so a leased path pushed before the lease was declared is never
re-examined; the acceptance merge reads no lease. **Measured:** 0 refusals ever on this instance
(one lease was ever declared before this pass, and it was the holder's own); on the airbnb board
the controller declares leases mid-flight and said it will move them chain by chain, which is
exactly the ordering the delta read misses. **Refutation tried:** is a delta read what GitHub
enforces anyway? For the `workflow` scope, yes (ruling 144); a lease is about ownership of a
file until merge, and ownership is not a property of one push. Kept LOW-MEDIUM: the
enforcement claim the controller repeated to me ("another task's push touching those is refused
before it reaches GitHub") is true only for the first push. **Fix:** the gate measures
`merge-base(origin/<default>, HEAD)..HEAD --no-merges`. **Red-proof:** with the delta read
restored, the new test fails; 57 green restored.

## F38-8 — Two packet arms consumed the decision before the hold refused it (LOW-MEDIUM; ruling 354)

**Found by** the lens-1 sweep (#2), verified in `resolvePacket`: `retry_other_backend` and
`resolve_remote_collision` met the hold only in the act after the resolution write (ruling
241's shape, fixed there for `question_reviewer` only). **Measured:** 0 blockedBy-held
resolutions of either arm on this instance; the one live "The retry could not start" (SHOP-37)
was a quota hold that scheduled the run, so the person lost nothing there. **Refutation tried:**
can a packet with these options exist on a held task? Yes: the controller re-plans `blockedBy`
on live tasks (it did so twice last pass), and a failure packet raised before the re-plan
outlives it. Kept LOW-MEDIUM: reachable, destructive on one arm, latent so far. **Fix:** both
arms read the hold before the write and refuse with the hold sentence; the packet stays open.
**Red-proof:** with the guards disabled both new tests fail; restored, 117 green.

## F38-9 — The hold refusal promised a release the release engine says can never come (LOW-MEDIUM; ruling 355)

**Found by** the lens-2 sweep (C5), verified: `holdRefusal` reads labels only; the release
engine writes "can never complete … edit what it waits on" for a failed/missing/cancelled
entry on the same task. **Measured:** 0 dead-entry notes on this instance so far; reachable on
any board of chained goals (an archived link, a cancelled goal). **Refutation tried:** is the
promise merely optimistic rather than false? `dependenciesSatisfied` requires every entry
`done`; a dead entry never becomes done; the sentence says Viberr will release it. False.
Kept LOW-MEDIUM (latent; a person told to wait for something that cannot happen). **Fix:** the
sentence reads the entry states — on the Run control before the click and at every server
door through one resolver. **Red-proof:** the shared, client and server tests each fail on
their own canary (ignore `dead`; drop the client argument; pass `[]` from the server door).

## F38-10 — The hold sentence named done entries as still waited on (LOW; ruling 356)

**Found by** lens 2 on the live BNB-3 page after BNB-11 merged: the Run-an-agent control read
"BNB-3 waits on goal-2 link 1 (BNB-2), goal-2 link 4 and BNB-11 and Viberr is holding it" while
the Blocked-by rail ten lines above marked two of the three "done". A hold releases as a whole,
so `blockedBy` keeps a done entry until every entry is done, and five surfaces printed the bare
labels: the refusal at every door (the controller's `run_agent_on_task` too), the run control's
note, the hero's "Waiting on · Other work" line and the two skipped-schedule notes.
**Measured:** 2 of the 6 held tasks on this instance (BNB-3, BNB-4) render a done entry as waited
on right now; 0 of the 10 refusals rendered to agents so far named a done entry (each had a single
open entry at the time). Three tests pinned the flattening with a fixture whose JC-3 was `done`
(execution-profile ×2, side-panels ×1). **Refutation tried:** is "waits on BNB-11" true because
the stored list still holds it? The list is the mechanism; the sentence is addressed to a person
or an agent deciding what to do next, and it sends them to a finished task — and the operator's
own prompt already renders the states per entry ("goal-1 link 2 (JC-3) (open), JC-6 (archived,
can never complete)"), so the product knows the split and says it on one surface only. Kept LOW:
nothing lost; one surface contradicts another on the same page and at the controller door.
**Fix:** one shared `holdEntriesSentence` (what still holds the task, then the done ones as done)
feeds the refusal, the note, the hero line and both skipped-schedule notes; the server doors pass
resolved entries. **Red-proof:** dropping the done split fails 8 tests across the shared, client
and server layers; handing the server door all-open states fails the two door tests.

## F38-11 — The operator paid a whole turn to learn what it had just done (LOW-MEDIUM; ruling 357)

**Found by** watching BNB-13's delivery live: one drive refreshed the branch, delivered PR #9,
moved Design → Build → Review and engaged the code reviewer; 0.1 s after it ended a second
operator drive started, called `get_task`, wrote "the required reviewer's run is already in
flight" and ended (13 s, $0.15). The app log named the cause: "operator lease released — firing
the queued trigger … trigger: delivered". **Measured:** 330 of the 1,399 finished operator drives
on this instance ended within 2 turns and 30 s, every one of them calling nothing but `get_task`
(114 calls, 0 mutations), 109 minutes of drive time, $18.49; 148 deliveries were made inside an
operator drive, 140 of which the same drive followed with a transition or a dispatch (the queued
turn was waste) and 8 of which the drive stopped after (the queued turn did the move); 11 of the
12 queued triggers fired since the container's boot were `delivered`; at 06:52:17 a real
coordination drive parked behind the concurrency cap while such a no-op held the lane.
**Refutation tried:** is the second drive the react chain working as designed? Ruling 152(a)
already settled that a live drive's own move queues no turn "because the turn continues on its
own", and the delivery tool's reply names the PR — the same drive moved the task 140 times out
of 148. Is dropping it safe, then? Not simply: the 8 stopped drives were rescued by it, and
ruling 202 makes a delivery count as progress, so the stranded backstop would not nudge them;
only the 15-minute sweep (ruling 330) would. **Fix:** ruling 152(a)'s shape for deliveries with
the rescue kept — stamps on the drive, judged at its lease release. **Red-proof:** four canaries
(drop the live-drive arm at the delivery; drop the follow-up from the lease release; drop the
transition stamp; drop the dispatch stamp), each failing exactly its own test.
