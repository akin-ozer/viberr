# G-B-foundation — adversarial verification (2026-07-29)

Scope: only the files this stream claims —
`app/server/boot.server.{ts,test.ts}`, `app/server/db/data-root-lock.server.{ts,test.ts}`,
`app/server/events/sse-broker.server.{ts,test.ts}`,
`app/server/projections/rebuilder.server.ts`,
`app/server/projections/{decisions,review-queue}.server.{ts,test.ts}`, `compose.yml`.
Sibling-owned files (`task-actions.server.ts`, `review-helpers.ts`,
`task-detail-page.tsx`, `Dockerfile`, `scripts/docker-entrypoint.sh`) were READ as
evidence, never judged.

Method: read the whole diff; located every claimed behavior at file:line; ran each
named proving test; then REVERTED each repair in place (perl in-place edit), re-ran
the named test, captured the failure, and restored the file byte-for-byte from a
pre-edit copy (`diff -q` clean afterwards, `git diff --stat` back to the original
51/49/40/14/39 line counts). Two extra behavioral probes were run in a throwaway
test file (`app/server/projections/zz-verify-tmp.test.ts`, deleted after the run).
Also empirically tested npm's SIGTERM forwarding (the container's pid-1 chain).

## Gate tails

- `npx tsc --noEmit` (via `react-router typegen && tsc` equivalent) → **1 error,
  and it is NOT this stream's**:
  `app/server/runtimes/operator-run.server.ts(256,62): error TS18048:
  'input.humanComment' is possibly 'undefined'.` No error in any G-B file.
- `npx vitest run app/server/boot.server.test.ts app/server/db/data-root-lock.server.test.ts
  app/server/events/sse-broker.server.test.ts app/server/projections/decisions.server.test.ts
  app/server/projections/review-queue.server.test.ts`
  → **5 files / 71 tests passed** (475 ms).
- `npx vitest run` (full repo) → **206 files / 2410 tests passed** (27 s). The
  projection change is global; nothing downstream broke.

## Per-claim verdicts

### S5-G1 part 1 — release inside the shutdown handler → **CONFIRMED**

- Held-lock publication + release: `app/server/db/data-root-lock.server.ts:101-129`
  (`Symbol.for("viberr.dataRootLock")`, `heldDataRootLock()`, `releaseDataRootLock()`),
  tracking at `:257` / `:273-279`, un-tracking inside `release()` at `:262-265`
  (`process.off("exit", release)` + slot clear guarded by `heldDataRootLock() === lock`,
  so a released lock cannot clobber a newer one — as claimed).
- Sequence exported at `app/server/events/sse-broker.server.ts:343-347`
  (`closeAllSseConnections()` → `shutdownDatabase()` → `releaseDataRootLock()`),
  called from the handler at `:151-155` with the re-raise left in the handler.
- Canary A (deleted `releaseDataRootLock()` from `runProcessShutdown`):
  `AssertionError: expected true to be false` at
  `sse-broker.server.test.ts:425 expect(existsSync(lock.path)).toBe(false)` — exactly
  the claimed output. Restored.
- Canary B (dropped `heldLockSlot()[HELD_LOCK_KEY] = lock`): **2** files failed —
  `data-root-lock.server.test.ts:134 expect(heldDataRootLock()).toBe(lock)`
  (`Received: null`) and the sse-broker test again. Restored.
- Ordering is safe: both earlier steps are throw-proof (`shutdownDatabase`
  swallows checkpoint/close errors, `sqlite.server.ts:91-105`; `dropConnection`
  wraps `onClose`, `sse-broker.server.ts:192-196`), so the release is reached.
  There is still no `try/finally` — see Gap 4.

### S5-G1 part 2 — readable refusal instead of an SSR stack → **CONFIRMED**

- `takeDataRootWriterLock` at `boot.server.ts:149-166`; injected io type at `:128`;
  production io (`process.stderr.write` / `process.exit`) at `:133`; boot call at
  `:203`, still before `getDb()` (`:208`) — the "before anything opens the DB"
  invariant holds. Non-`DataRootLockedError` still rethrows (`:163`).
- `entry.server.tsx:21` still `await bootServer()` at module scope, untouched —
  the claim's reasoning checks out (the catch has to be at the call site).
- Canary C (re-throw instead of print/exit): `AssertionError: expected [Function]
  to not throw an error but 'DataRootLockedError: Refusing to boot…' was thrown`
  at `boot.server.test.ts:103` — matches the claim verbatim. Restored.
- The control test (`VIBERR_FORCE_DATA_ROOT_LOCK=1`) really acquires and then
  releases the lock, so it also exercises the new tracking path.

### S5-G1 part 3 — `hostname: viberr` for stable container identity → **CONFIRMED-BUT-DANGEROUS**

- `compose.yml:10` is the only change in that file. The mechanism is real:
  `classifyLock` (`data-root-lock.server.ts:161-172`) refuses ANY foreign-host
  lock (`:170`), so an unpinned recreated container could never reclaim.
- BUT the reclaim rides on `:169` — `holder.hostname === self.hostname &&
  holder.pid === self.pid` returns `"stale"` **without probing liveness at all**.
  Pinning the hostname turns the pid into the only identity, and container pids
  are a tiny, deterministic, per-namespace space. Two consequences:
  1. **False-stale (the dangerous one):** two containers built from this compose
     file over the same `./docker-data` (a second `--project-name`, a
     `docker compose run app …` that boots the server, a stale container left
     running) both call themselves `viberr` and both allocate the same pid to the
     server process — the newcomer classifies a **live** lock as `stale` and takes
     it over silently. That is precisely the dual-writer corruption this module
     exists to forbid, and before the pin it was refused (`held`, different host).
     Evidence: `data-root-lock.server.ts:169` + the existing test
     "re-entrant boot of the SAME pid reclaims its own lock".
  2. **Refuse-forever (benign but noisy):** if the leftover pid is instead alive as
     an unrelated process in the new container, `:171` says `held` and the boot
     refuses until someone deletes the file or sets the force env. The claim's
     "probe pid 1" is inexact — with `ENTRYPOINT sh … exec npm run start`
     (`Dockerfile`/`scripts/docker-entrypoint.sh`), pid 1 is npm and the server is
     a child, so the reclaim depends on pid determinism, not on pid 1.
  No test covers either; `compose.yml` is untestable here. Flagged, not fixed.

### S5-G2 (HIGH, R15-1 vs the inbox) → **CONFIRMED**

- Single projection point: `rebuilder.server.ts:293-307` (`acceptanceBlockReason`),
  used at `:458`; `decisions.server.ts` and `review-queue.server.ts` are
  comment-only in this respect (verified in the diff), and
  `task_projections` has exactly one writer (`rebuilder.server.ts:415`), so the
  column cannot be written by a second, un-gated path.
- Order matches `acceptanceRefusalReason` (`task-actions.server.ts:4420-4437`):
  `acceptanceBlockedReason` first, then the R15-1 verdict gate; the R15-1 body is
  semantically identical to `verdictGateReason` (`task-actions.server.ts:4391-4403`),
  including both message strings. `failing` deliberately falls through in both,
  and that is sound: `deriveValidation` returns `"failing"` only when a REQUIRED
  reviewer requested changes (`task-file.schema.ts:528`), which
  `acceptanceBlockedReason` has already named (`:554`). No hole.
- The omitted gates (archived / stage / blocked packet / closed-unmerged PR /
  conflicting PR) are omissions, never additions, so the column can only
  under-block relative to the server — and each consumer filters them
  (`review-queue.server.ts:150-158`, `decisions.server.ts:135-146`). One live
  consequence of the omission is a real signal loss — see Gap 3.
- Canary D (`acceptanceBlockReason` → `acceptanceBlockedReason` at `:458`):
  **4 failures**, exactly the claimed set —
  `expected [ Array(1) ] to have a length of +0 but got 1` (×2, decisions
  `:360`, `:372`) and `expected [ 'VIB-6' ] to not include 'VIB-6'` /
  `'VIB-5'` (review-queue `:425`, `:434`). Restored.
- R15-1 satisfaction: the ruling's "human acceptance REQUIRES a healthy verdict;
  force-accept is the only bypass" is now the same predicate on both the write
  path and the two read models. Force-accept genuinely bypasses it
  (`forceAcceptCompletion` → `acceptCompletion(force: true)`,
  `task-actions.server.ts:4828-4880`), so the projected message's
  "an admin can force-accept" is TRUE, not a dead end — and the admin
  force-accept row on the task page reads this very column
  (`task-detail-page.tsx:104`), so the escape hatch now appears for this class.

### S5-G2 secondary (archived project) → **CONFIRMED**

- `decisions.server.ts:105` — `listProjects(db).filter((p) => !p.archived)`.
  It really does drop all three kinds: the packet/recommendation loop bails on the
  missing `stagesBySlug` entry (`:185-186`) and the acceptance loop bails on the
  `reviewIdBySlug` lookup returning `undefined` (`:201`).
- The rationale is validated by the sibling code it cites:
  `resolveAcceptanceAffordance` denies outright on `project.archived`
  (`task-actions.server.ts:~4581`), so nothing in an archived project was
  actionable. No human decision is overridden — R6-3 is the standing ruling.
- Canary E (removed the filter): `AssertionError: expected [ { …(4) }, { …(4) } ]
  to have a length of +0 but got 2` at `decisions.server.test.ts:386` — matches.
  Restored.
- Scoping to this reader (not `listProjects` itself) is correct; the other four
  callers are untouched.

## The 3 most dangerous remaining gaps

1. **`hostname: viberr` can convert a REFUSAL into a silent live-lock takeover**
   (`compose.yml:10` + `data-root-lock.server.ts:169`). Same-host **and** same-pid
   short-circuits to `"stale"` with no liveness probe, and pinning the hostname
   makes "same host" trivially true for every container from this file. Two
   simultaneous containers over one `./docker-data` (second project name,
   `docker compose run`, an orphan container) will very likely land the server on
   the same pid and take each other's lock — the exact dual-writer corruption
   B-FD1 exists to prevent, and it is now *easier* than before the pin. A safer
   identity would combine the pinned hostname with something per-boot the new
   process can compare (boot id / `/proc/1/stat` start time / a container-id file),
   or keep the same-pid short-circuit behind an explicit `isAlive` probe.

2. **The shutdown handler is armed LAZILY, so the repair may never run.**
   Registration lives inside `getState()` (`sse-broker.server.ts:150-157`), whose
   only call sites are `publishSseEvent`, `connectSseClient`,
   `closeAllSseConnections` and `getSseBrokerStats`. `bootServer` never calls any
   of them (`startEventPublisher` only subscribes), so on a warm store where the
   boot rescan emits nothing and no client has connected yet, a `docker compose
   stop` runs NO handler: no WAL checkpoint and no lock release — the very state
   G1 part 1 was written to end. One eager `getState()` (or an explicit
   `registerProcessSignalHandlers()`) in `bootServer` would close it. Related and
   unproven end-to-end: nothing in this pass exercises the container signal path
   (`sh → npm run start → node`); npm *does* forward SIGTERM on this machine
   (verified with a scratch package: child printed `CHILD GOT SIGTERM`), but that
   was never verified against `node:26-slim` inside the container.

3. **The new block reason MASKS the closed-PR rejection on the review queue.**
   `reviewRowSub` returns `blockReason` before the live PR state
   (`app/features/review/review-helpers.ts:52` vs `:36-44`). Probed live: a task
   with a PR `closed` unmerged and no verdicts now renders
   `"VIB-900's delivered revision has no approving verdict yet — run a review for a
   verdict, or an admin can force-accept."` instead of `"PR #90 was closed on
   GitHub without merging — rework and reopen it, or archive the task."` The row
   still correctly stays out of `ready`, but the human is now told to run a review
   on work GitHub already rejected — the wrong next action, and the rejection fact
   disappears from the queue entirely. (`review-helpers.ts` is not this stream's
   file; the trigger is.) Same probe also confirmed the honest-but-harsh corollary:
   a PR **merged out of band** with no verdict is no longer `ready` and now needs
   an admin force-accept — consistent with the server, but a new wedge worth an
   owner note.

## Secondary notes (not blocking)

4. `runProcessShutdown` has no `try/finally` around the first two steps
   (`sse-broker.server.ts:343-347`). Today both are throw-proof, so this is a
   latent coupling, not a live bug: any future throw in `closeAllSseConnections`
   or `shutdownDatabase` strands the lock again.
5. The R15-1 verdict body is DUPLICATED, not shared:
   `rebuilder.server.ts:293-307` vs `task-actions.server.ts:4391-4403`, including
   both message strings. The header comment says "must move with it", but nothing
   enforces it (`verdictGateReason` is un-exported). A drift here is silent and
   re-opens exactly F15-19's read/write mismatch — export and reuse it.
6. `process.exit(1)` under `restart: unless-stopped` (`compose.yml`) turns a held
   root into a restart LOOP that re-prints the refusal forever. Correct behavior,
   but the operator sees flapping rather than one stopped container; worth a line
   in the deployment runbook.
7. Coverage honesty: parts 1 and 2 are proven by unit tests only; nothing in this
   pass proves the end-to-end `docker compose stop` → lock gone → `up` boots. That
   is the one live proof the ledger cannot currently claim.
