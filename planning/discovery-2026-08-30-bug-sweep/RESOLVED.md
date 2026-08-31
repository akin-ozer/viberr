# Bug sweep 2026-08-30 — the full confirmed backlog, resolved

The 24-scenario sweep produced 51 raw findings; 40 survived two-lens adversarial
verification. All 40 are now fixed on `bug-sweep/2026-08-30`, each with a
regression test that was watched failing against the unfixed tree before the fix
landed. This file replaces REMAINING.md, which listed the 19 that were still
open after the first pass.

## What the sweep was actually finding

The individual defects matter less than the classes they belong to. Five recur:

**Decide, await, then blind-write.** A decision taken from a pre-await snapshot
and written with a wholesale key assign. The goal advance grew two tasks for one
link; `createGoal` minted one id twice; the GitHub reconciler overwrote an
acceptance that landed mid-pass; the schedule drain measured a lease from the
claim rather than from the drive. The fix shape is always the same: re-check the
decision inside the write lock, or hold one lock across the whole sequence.

**Whole-array tolerant parsing.** One malformed row empties a list, and because
the diagnostic is only a warning the file stays writable, so the next write
persists the loss. F18 moved four project lists to per-entry parsing; `guardrails`
and task `engagements` were missed, and `engagements` carries the delivery
contract.

**A guard that short-circuits ahead of the chokepoint.** The task-owner exception
returned before `requireAction`, and with it before the archive freeze — so an
owner could accept a completion (a real merge) on a read-only project.

**A new caller reaching a branch documented as unreachable.** The controller's
`move_task` omitted `manual`, landing in the any-member `auto` arm whose own
comment says the UI can never reach it.

**Display re-deriving what the runtime decides.** `capabilities.delivery`
ignored the repo-write headline gate; the resource delete-confirm counted
templates from the specialist CRUD list while the delete rewrote every profile
file; the notification surfaces re-derived navigability instead of using the
`href` the server had already resolved.

## Two things worth remembering about the method

Verifiers read the WORKING TREE. Fixing while verification is still running makes
agents refute their colleagues' true findings ("the code state it describes is
already gone"). Six of the first seven refutations were exactly that. Judge those
by the canary, not by the verdict.

Canary every test, and check that the canary fails for the RIGHT reason. Three
tests in this pass initially passed against the unfixed code: one asserted
`init?.status ?? status` where `AppError` also carries a `status`; one compared
`indexOf` values where an absent entry yields -1; one used fixtures whose two
derivations happened to agree. A test that cannot fail is worse than no test.
