# S3-operator — adversarial verification (2026-07-29)

Scope: only the files S3 owns (`operator-run.server.{ts,test.ts}`,
`seed/assets/operator.definition.md`, `seed/default-assets.server.{ts,test.ts}`,
`tasks/schedule.server.{ts,test.ts}`, `handbacks/S3-operator.md`). Sibling-owned
files were read for evidence, never judged.

Method: read the full diff; located every claimed behavior at file:line; replayed
all 15 new tests against a detached-HEAD worktree carrying the NEW test files and
the OLD production code (to prove "fails on old"); ran the owned suites, the
three surrounding directories, and the whole repo suite; probed the SQLite
JSON/LIKE difference directly; hashed the live `data/` and `docker-data/` stores
against the baked hash list.

## Gate tails

- `npx tsc --noEmit` → **0 errors, repo-wide** (the 4 sibling errors S3 reported
  are gone; nothing to attribute).
- `npx vitest run app/server/runtimes/operator-run.server.test.ts
  app/server/seed/default-assets.server.test.ts
  app/server/tasks/schedule.server.test.ts` → **3 files / 54 tests passed**.
- `npx vitest run app/server/seed app/server/runtimes app/server/tasks` →
  **48 files / 771 passed** (no collateral damage in the directories whose
  subjects S3 changed).
- `npx vitest run` (full) → **206 files / 2371 passed**.
- Old-code replay (HEAD worktree + new tests) → **15 failed / 39 passed**; every
  one of the ledger's "fails on old" tests failed, and only those.

## Per-claim verdicts

### F15-14 (HIGH) — CONFIRMED (advisory-only; see Gap 2)

- `triageQualityGate()` at `app/server/runtimes/operator-run.server.ts:1692`,
  spliced into the shared turn instruction at `:1806`, so both prompt builders
  carry it (`buildCodexOperatorPrompt` :1826, `buildOperatorTurnPrompt` :1857).
- Stage scoping is honest: entry = `snapshot.stageIds[0]` (:1693), which is the
  same value `resolveStageRoles` calls `entryId`
  (`app/shared/workflow/stage-roles.ts:45`), so this is NOT a positional
  regression against B-WF4's one-resolver ruling — it agrees with the resolver.
- Skips when entry == work or terminal (:1695).
- Shipped doctrine paragraph: `app/server/seed/assets/operator.definition.md:13`.
- Old-code replay: all 4 named tests failed on HEAD
  ("expected … to contain 'TRIAGE QUALITY GATE'", "expected … to contain
  'triage quality gate'").
- The vague goal is *specified*, so `goalIsUnspecified` never fired — the test
  snapshot reproduces that exactly (`goal: "The documentation could be
  improved…"`), which is the real live shape.

### B-OP1 (HIGH) — CONFIRMED (coverage is narrower than the finding; see Gap 3)

- Refresh logic `default-assets.server.ts:300-320`; manifest at `:113`;
  `PRIOR_SHIPPED_HASHES` at `:127`; `shippedCopyIsUnedited` at `:182`.
- Independently regenerated the hash lists from `git log --follow` over
  `app/server/seed/assets/`: **operator.profile.md (6/6), viberr-app-expertise
  (8/8), developer-expertise (2/2), reviewer-expertise (3/3) match exactly.**
  operator.definition.md: my 13 reproduced hashes are all present; the baked list
  has **one extra I could not reproduce in this checkout**
  (`ef9e653a6bd7e19fa78a34a0dfdc48c26cbc0cdba8c83493ad9789642cb289b4`) — see
  minor notes.
- Live-store check (the reason the finding exists):
  - `docker-data/agents/definitions/operator.md` = `da9cf466…` → **in the list →
    will refresh.** Claim confirmed against the real store.
  - `docker-data/agents/profiles/operator.md` = `cc78f1eb…` → in the list, shipped
    is `ffd61e77…` → will refresh.
  - `data/agents/definitions/operator.md` = `1582deb1…` → unrecognized →
    preserved (S3 disclosed this; fails safe).
  - `docker-data/agents/profiles/{developer,reviewer}.md` = `94974165…` /
    `28c12cc4…` — I generated the current templates in a scratch store and they
    hash **identically**, so today's store is current and will be adopted into the
    manifest. The gap below is latent, not live.
- Boot order claim verified: `boot.server.ts:163` runs `seedDefaultAgentAssets()`
  after `acquireDataRootLock` and before `getDb()`, the event publisher and the
  watchers. `state/` is not reached by `scanStoreTree` (only `kbDirPath` /
  `skillDirPath` / explicit abs dirs — `org/resources.server.ts:187,457,1204`) and
  the projections watcher only watches `projects/`
  (`files/file-watch.service.server.ts:114`). Both claims hold.

### B-OP2 (HIGH) — CONFIRMED (behavior change is real; see Gap 1 for the cost)

- `PendingTriggers` + `queueOperatorTrigger` (:235) + `takePendingTrigger` (:260),
  cap 8 (:232), wired into both queue points (:588, :604) and both drains
  (:293, :325).
- No trigger can be lost by the multi-registration of `chainRunCompletion`
  (:605-606): `drainPendingAfterInFlight` early-returns while the lease is held
  (:324) and `runOperator` sets the lease with no `await` between the held-check
  and `lease.held.set` (:585 → :636), so a duplicate drain is a no-op and the
  remainder drains on release.
- Old-code replay: both tests failed on HEAD (the queued question's text was
  simply absent from the next prompt) — the drop is reproduced, the fix removes it.

### B-OP3 (MED) — CONFIRMED

- `executeStrandedCodexPlan` now reads the real starting stage before executing
  (`operator-run.server.ts:1072`), matching the live-drive token (:632).
- The backstop's own double-drive guards still hold: it needs a *finished* run
  (:400), the stage must be unchanged (:425), and the task must be stranded at an
  `auto` boundary with no packet/recommendation (:368-371), bounded by
  `OPERATOR_TRANSITION_CHAIN_CAP` (:441).
- Old-code replay: `expected [ { id: 'run_prev_boot' } ] to have a length of 2` —
  HEAD fired no resume.

### B-WF3 (MED) — CONFIRMED

- `scheduled` trigger + `scheduleNote` on the input (:95-104), threaded into both
  starters (:944, :1423) and into the turn (:1791-1799).
- Producer side is the real path, not a stub: `schedule.server.ts:376`
  (`note: s.note ?? ""`) → `:405` (`trigger: "scheduled"`, `scheduleNote`).
- Old-code replay: the end-to-end schedule test failed on HEAD
  ("expected 'You are operating VIB-1…' to contain 'SCHEDULED re-check'").
- No other `runOperator` caller needs the trigger: the five production callers are
  task-actions (`create`/`goal-updated`/`transition`/`manual`+humanComment/
  `agent-reply`), schedule (`scheduled`), run-recovery, and the two internal
  drains. Nothing switches on the trigger string in a way "scheduled" breaks
  (`OperatorTrigger` is derived from the input union at :1656).

### B-WF5 (LOW) — CONFIRMED, and the deviation note is honest

- `tasksWithUnresolvedSchedules` at `schedule.server.ts:228`, used at `:260`.
- I ran the two predicates against node:sqlite directly. Compact JSON: both
  select it. Pretty-printed JSON: **old LIKE misses it, new `json_each` selects
  it.** So the shipped test does encode a genuine behavioral difference, not just
  a new-export failure. S3's claim that the LIKE could not false-positive on a
  *note* is also correct — a note containing `"status":"pending"` serializes with
  backslashes and cannot match.
- Header comment now describes the claim→finalize flow (:32-36), which matches
  the code (`CLAIM_LEASE_MS` at :241).

### B-OP4 (LOW) — CONFIRMED, and the offer is NOT one the server refuses

I specifically chased "leaves an offer the server refuses":
- `custom` is a real kind (`app/schemas/task-file.schema.ts:81`).
- Resolution accepts it: it falls to the switch default
  (`task-actions.server.ts:4085-4096` — `waiting: agent`, `readiness: ready`,
  packet cleared) and is explicitly one of the three "sent back to the agent"
  kinds that re-invoke the operator (`:4152-4156`).
- The resolver's note is captured and rendered on the timeline event
  (`:4120-4126`), and the packet card has the note field
  (`features/task-detail/decision-packet.tsx:253-262,306`), so the option's
  `detail` copy ("your note becomes the operator's instruction") is truthful in
  the weak sense (the note lands where the operator reads it); it is not a
  guaranteed directive.
- `detail` survives into the file shape as `d` (`operator-actions.server.ts:551`).
- Old-code replay: `expected [ 'request_edit', 'redirect' ] to include 'custom'`.

### B-OP5 (LOW) — HANDBACK ACCURATE

Both copies of the resolution live in the non-owned file, exactly as described:
`operator-actions.server.ts:135-152` (`operatorBackendFor`) and `:190-196`
(`deploymentBackend` inside `resolveOperatorAuthority`) — byte-identical
expression, duplicated `effectiveProfileView(...).kind === "operator"` lookup,
same `"claude"` fallback. The suggested tying test is the right one.

### Ruling compliance (FINDINGS §D)

No conflict found. R15-1 (verdict-gated acceptance): the new fallback option set
adds `custom`, never `accept_completion`, so no bypass is offered. R15-2
(delivery is the operator's decision): the triage gate is entry-stage-only and
restricts `transition_stage`, not `deliver_for_review`. R15-3 / R15-4 / R15-5 /
R15-6 / R15-7 / R15-8: untouched by this stream. The gate's prose also matches the
shipped workflow promise (`app/shared/workflow/templates.ts:47`: "Operator, once
the goal is scoped — flags underspecified tasks instead").

No fix in this stream overrides an explicit admin decision *by design*; the one
theoretical path is B-OP1 (an admin who deliberately pins an older shipped
doctrine byte-for-byte gets it silently upgraded) — covered in Gap 3.

## The 3 most dangerous gaps

**Gap 1 (MED-HIGH) — B-OP2's serial drain meets unconditional packet
replacement.** `operatorOpenPacket` writes `parsed.packet = packet` with no
"a packet is already open" guard (`app/server/tasks/operator-actions.server.ts:577`).
Before this fix, N human comments arriving during a drive collapsed into ONE
follow-up drive. Now up to 8 (`operator-run.server.ts:232`) fire back-to-back,
each a full governed turn: two queued questions that each warrant a decision can
open two packets, and the second silently replaces the first (new packet id → the
human resolving the first from an open tab gets "This decision was replaced by a
newer one", `task-actions.server.ts:4106`). It also multiplies billable runs and
governed actions N×. The humanComment turn branch (:1717-1728) has no
"an open packet may already cover this" clause — the `pr-diverged` branch has
exactly that clause (:1762), so the pattern exists and was not applied here.
Cheapest mitigation: add that sentence to the humanComment branch, and/or coalesce
consecutive queued comments from the same author into one turn.

**Gap 2 (MED) — F15-14 is closed at HIGH with prompt text only; nothing on the
server refuses the move, and the gate is missing from the goal-edit turn.**
`transitionStage` still accepts triage→ready with a vague goal; the only
server-side notion of "underspecified" remains the placeholder check
`goalIsUnspecified` (:1801). The New-task dialog and the shipped workflow copy
both promise flagging, so the promise is still unenforced — a model that ignores
the paragraph reproduces F15-14 verbatim and no test can catch it. Worse for the
most likely repeat: the gate lives only on the generic path, so the
`goal-updated` turn (:1729-1733) — literally the turn after a human edits a vague
goal — carries no gate at all. S3 disclosed this as deviation 3; I rate it the
second-most dangerous gap rather than a caveat, because F15-14's own ledger row
says "consider a server-side nudge" and the row is now marked DONE.

**Gap 3 (MED) — B-OP1's refresh is silent, non-atomic, and its legacy coverage
has three holes.** (a) `agents/profiles/developer.md` and `reviewer.md` have NO
`PRIOR_SHIPPED_HASHES` entries, and since F10-30 the specialist PERSONA lives in
that body — a store seeded before the 2026-07-18 `kbGrants` change (which alters
those bytes) can never converge; today's `docker-data` happens to be current so
this is latent, not live. (b) The host `data/` store hashes `1582deb1…`,
recognized by nothing, so the machine this was found on keeps the stale doctrine.
(c) The list needs a manual append on every future asset edit — one forgotten
append silently restores the whole finding class, and no test can detect it
(the shipped test asserts one specific historical hash, not "HEAD's version is
listed"). Additionally, the refresh writes are invisible: `logger.info` only
(`default-assets.server.ts:315`), no audit row, no timeline/notification, and a
plain `writeFileSync` (not the atomic temp+rename used elsewhere) — so an admin
who reverted their edit to a shipped version byte-for-byte is overwritten with no
record anywhere in the app. Suggested minimum: a test asserting
`assetHash(currentContent)`'s PREDECESSOR (i.e. HEAD's blob for each asset) is in
the list, plus an audit row on refresh.

## Minor notes (not blocking)

1. `operator-run.server.ts:580` still says the queue is "newest wins" — the
   interface doc above (:167-177) was updated, this inline copy was not.
2. One baked hash for `agents/definitions/operator.md`
   (`ef9e653a…`) is not reproducible from `git log --follow` in this checkout
   (14 baked vs 13 reproduced). Almost certainly a real historical blob from a
   rename/branch path, but an unverifiable entry in this list is a standing
   licence to overwrite whatever matches it — worth confirming provenance.
3. Two-stage custom board edge: `triageQualityGate` skips work/terminal but not
   `reviewStageId`. On a `[todo, done]` board `workStageId` is null and the entry
   stage IS the review stage, so the gate rides along on every turn there. Only
   the 5-stage Governed template ships (`app/shared/workflow/templates.ts`), so
   this needs a hand-built board to hit.
4. B-OP3 side effect worth knowing: every cross-boot stranded-plan recovery whose
   plan changes nothing now fires a fresh operator run at boot, and
   `transitionDepth` resets to 0 per boot — a task that genuinely cannot advance
   re-burns up to CAP runs after each restart.
5. `PRIOR_SHIPPED_HASHES` / `assetHash` / `shippedCopyIsUnedited` /
   `tasksWithUnresolvedSchedules` are exported purely for the tests; three of the
   "fails on old" proofs are therefore missing-export failures rather than
   behavioral ones. I re-proved B-WF5's behavioral difference directly against
   node:sqlite (see above), so this is a note, not a defect.
