# Admin run-concurrency cap (queue + drain) — how it works

Shipped in commit `df9ceaa` ("Add admin run-concurrency cap with queue + drain").
This doc traces the feature exactly as implemented in the current tree (df9ceaa
is an ancestor of HEAD on this branch, so line numbers below match the working
tree). It is written for an implementation agent with no other context — it
describes the mechanism as coded, and ends with a "Known correctness defects"
section that is load-bearing: **the headline defect (bypass) means the gate
does not do what the rest of this doc describes for most real traffic.** Read
that section before changing anything here.

## 1. The setting

- Table: `db/migrations/0001_baseline.sql:952-956` — `instance_settings(key TEXT
  PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)`. Generic
  key/value JSON store for instance-wide (single-deployment) admin config, no
  FK, distinct from `user_prefs` (per-user) and `project.md` (per-project).
- Typed reader/writer: `app/server/settings/instance-settings.server.ts`.
  - Generic `getSetting`/`setSetting` helpers (lines 22-48) do the JSON
    encode/decode + zod validation; a corrupt or missing row is *tolerant* —
    `getSetting` returns `null` and the caller's `??` default applies (line
    32-33, "a corrupt row falls back to the caller's default").
  - `MAX_CONCURRENT_RUNS_KEY = "maxConcurrentRuns"` (line 55).
  - `MAX_CONCURRENT_RUNS_CEILING = 64` (line 58) — upper bound.
  - `getMaxConcurrentRuns(db): number` (line 68) — returns the stored value or
    `0` if unset. **0 means unlimited** (the historical/pre-feature behavior,
    so an untouched deployment is unaffected).
  - `setMaxConcurrentRuns(db, value): number` (line 74) — throws
    `Error("Concurrency cap must be a number.")` if `!Number.isFinite(value)`
    (never silently disables the gate on a bad write); otherwise clamps with
    `Math.max(0, Math.min(64, Math.floor(value)))` and returns the *applied*
    (clamped) value. A fractional input is silently floored; a value above 64
    is silently clamped to 64; a negative value is clamped to 0.
- No caching — every `getMaxConcurrentRuns` call is a fresh `SELECT`, so a
  change is visible to the very next admission/drain check with no
  invalidation to worry about.
- Persistence: this is a real SQLite row, so **the cap value survives a
  restart** (unlike the queue itself — see §6).

## 2. Who can change it

- Route: `app/routes/org.settings.tsx`, intent `"set-concurrency"`
  (`action`, line 235-248).
- `action()` calls `await requireRoleAuth(request, "admin")` **once, at the
  top, before the intent switch** (line 187) — this is the same gate every
  other org-settings mutation goes through, not something bespoke to this
  intent. `loader()` separately calls `requireRole(request, "admin")` (line
  103). Both are server-side; there is no client-only gate.
  `app/routes/org.settings.concurrency.test.ts` pins a non-admin org member
  getting refused (`status !== 200`) and the cap being unchanged after.
- Server-side validation *before* the setter: `raw = Number(field(...))`; if
  `!Number.isFinite(raw) || raw < 0`, the action returns
  `fail("Enter a whole number (0 = unlimited).")` (lines 236-239) — a
  non-numeric or negative field value never reaches `setMaxConcurrentRuns` at
  all. A value that passes this (e.g. `3.9`, or `999`) is then clamped inside
  `setMaxConcurrentRuns` itself (§1).
- On success: `setMaxConcurrentRuns(db, raw)` then **`drainRunQueue(db)`**
  (line 243) — a raised (or lifted, `0`) cap immediately tries to promote
  anything parked in the queue, rather than waiting for the next run to exit.
  Toast copy is computed from the *applied* value, not the raw input.
- UI control: `app/features/org-settings/org-settings-page.tsx`,
  `RunConcurrencyControl` (line 321-onward), rendered from `OrgSettingsPage`
  at line 163, right above `StorageLine`. A number input (`min={0}`, no
  `max` — the ceiling is enforced server-side only, so typing `999` and
  saving round-trips to `64` after the loader re-seeds the field). The Save
  button is disabled unless the parsed value is a non-negative integer AND
  differs from the current cap (`dirty`, lines ~340-345). This is UX-only;
  the server re-validates independently (previous bullet).

## 3. The live-run ground truth

`app/server/runtimes/run-service.server.ts` keeps one process-global
`ServiceState` (`Symbol.for("viberr.runService")` on `globalThis`, line 127-142
— genuinely process-global, not per-request; this whole codebase's operating
assumption is one process per data root, see
`docker-data-dual-writer-hazard` project notes):

```ts
interface ServiceState {
  handles: Map<string, RunHandle>;   // one entry per LIVE adapter
  adapters: AdapterSet;
  completions: Map<string, RunCompletionCallback>;
  pending: PendingRun[];             // FIFO of parked runs (this feature)
  draining?: boolean;                // reentrancy guard (this feature)
}
```

`state.handles` is the cap's ground truth: an entry is added **only** once a
run's adapter process/stream has actually started (`launch()`,
`run-service.server.ts:1393`, guarded by an `exited` flag so a
synchronously-crashing adapter never gets a stale handle — see the
`fireIfAlreadyTerminal`/F-SPAWN2 comment at lines 144-179 for the related
crash-race this guard also protects). There is deliberately no separate
counter — "no counter to leak" per the commit message — so `handles.size` can
never drift from reality *for runs that actually go through the gate* (the
caveat in §7 is exactly that many runs don't).

`runConcurrencySnapshot(db)` (`run-service.server.ts:1255-1262`) is the
read-only view: `{ cap: getMaxConcurrentRuns(db), live: state.handles.size,
queued: state.pending.length }`. This is what the org-settings loader calls
(`org.settings.tsx:113`) to feed the admin control. **It is a point-in-time
loader snapshot, not a live/SSE feed** — it only refreshes on navigation or
after a fetcher action revalidates the loader (e.g. after Save).

## 4. The dispatch gate: `admitRun`

`app/server/runtimes/run-service.server.ts:1198-1212`:

```ts
function admitRun(db: DatabaseSync, runId: string, launchThunk: () => void): void {
  const state = getState();
  const cap = getMaxConcurrentRuns(db);
  if (cap === 0 || state.handles.size < cap) {
    launchThunk();
    return;
  }
  state.pending.push({ runId, launch: launchThunk });
  logger.info("run queued behind the concurrency cap", { ... });
}
```

- `cap === 0` ⇒ always launch immediately (gate off).
- Otherwise, launch immediately iff `handles.size < cap` — i.e. a cap of `N`
  allows *at most* `N` concurrently live adapters; the arithmetic itself has
  no off-by-one (the new run isn't counted until `launch()` actually adds its
  handle, so admitting at `handles.size === cap - 1` brings the total to
  exactly `cap`, never `cap + 1`).
- Otherwise the run is **parked**: its DB row was already inserted as
  `state: "queued"` by `startRun` (see next paragraph) and its launch
  *closure* (`launchThunk`, which closes over `db`, the built `RunSpec`, and
  the selected adapter) sits in `state.pending`, an **in-process, in-memory
  array — nothing about a parked run is written beyond the row already being
  `queued`.**

`admitRun` is called from exactly one place: `startRun`
(`run-service.server.ts:786-797`):

```ts
const launchThunk = () => launch(db, spec, selection.adapter, launchOpts);
if (reservation) {
  launchThunk();               // <-- bypasses admitRun entirely
} else {
  admitRun(db, runId, launchThunk);
}
```

Earlier in the same function, the row's initial state is chosen the same way
(`run-service.server.ts:671`): `state: reservation ? "running" : "queued"`.
So a non-reserved run is inserted `queued` and then either launched
immediately (flips to `running` inside `launch()`'s `sink.markRunning`,
line 1287) or stays `queued` in the DB while its thunk waits in
`state.pending`. **`"queued"` is not a new DB state this feature invented** —
it already existed in the `agent_runs.state` CHECK constraint
(`db/migrations/0001_baseline.sql:402-403`) as a brief pre-launch value; this
feature is what gives it a potentially long lifetime.

`launch()` itself (`run-service.server.ts:1265-1394`) is not reachable except
through this one `startRun` call site (verified — no other caller invokes it),
so the gate/bypass fork above is the only place admission is decided.

## 5. `reservation`: the bypass — read this before assuming the cap works

A **reservation** (`ReserveRunInput`/`RunReservation`,
`run-service.server.ts:314-473`) is a pre-existing mechanism (R21-4/OBS-8,
predates this commit) that writes a run's DB row as `running` *before* its
adapter exists, so the task page can show a live "Preparing workspace" strip
during a multi-minute repo clone instead of looking dead. `reserveRun()`
upserts the row with `state: "running"` directly (line 412) — it never touches
`state.handles` or `state.pending`.

This feature's design explicitly special-cases reservations: `startRun`
(`run-service.server.ts:787-792`, comment) —

> A RESERVED run already rendered "Preparing workspace" as a `running` row and
> committed its slot — it bypasses the gate rather than being demoted back to
> `queued` ... **Every other run (operator, reviewer, resume-less start) is
> admitted under the cap**: launched now if a slot is free, else parked in
> `queued` until one frees.

That comment's claim ("reviewer ... admitted under the cap") is **false** for
the actual caller wiring — see §7. The two reservation call sites are:

- `app/server/tasks/specialist-run.server.ts:1320` — inside
  `dispatchAgentRun` (the body of the exported `startAgentRun`, the **single
  dispatch function used for every specialist run in the product**: manual
  "Run" clicks from `app/routes/project.task.tsx:819,854`, operator-triggered
  specialist starts (`operatorRunSpecialist`,
  `app/server/tasks/operator-actions.server.ts:1920`, and a second site at
  line 2017), backend-retry (`app/server/tasks/task-actions.server.ts:6346`),
  and fresh (no prior session) `@mention` starts
  (`app/server/tasks/task-actions.server.ts:1526,1554`)). This call is
  **unconditional** — `pending.reservation = reserveRun(db, {..., kind:
  delivers ? "primary" : "reviewer", ...})` runs for both the delivering
  engagement (`delivers === true`) and every supporting/reviewer engagement
  (`delivers === false`), and regardless of whether a real clone is even
  needed (`realBackend`/`repo` only change the *label text* passed to
  `reserveRun`, not whether it's called — see lines 1289-1335).
- `app/server/tasks/specialist-run.server.ts:1719` —
  `if (pending.reservation) runInput.reservation = pending.reservation;`
  right before the eventual `startRun(db, runInput)` call. Since the
  reservation above is unconditional, this is unconditional in practice too
  (it is `null` only if `reserveRun` itself failed to write, e.g. a DB error —
  see its catch block at `run-service.server.ts:417-423`, a "prepare
  invisibly" fallback that is the *only* way a specialist dispatch ends up
  actually gated).
- `app/server/runtimes/operator-run.server.ts:1337-1358` — the operator's own
  coordination drive. Here the reservation **is conditional**:
  `const reservation = cloning ? reserveRun(db, {...}) : null;` where
  `cloning` is `pendingOperatorClone(...)` (truthy only when the task's repo
  mirror needs building/refreshing). `start.reservation` is threaded through
  to the eventual `startRun` call at lines 1800 and 2422
  (`if (start.reservation) spec.reservation = start.reservation;`). So the
  operator's *own* run is gated by the cap in the common case (mirror already
  warm) and only bypasses it on the rarer cold-clone path — the asymmetry
  with the specialist path (which reserves unconditionally, clone or not) is
  itself a sign the specialist path's unconditional call is not a deliberate
  mirror of this pattern.

Net effect: `startRun`'s `if (reservation) launchThunk(); else
admitRun(...)` fork (§4) is reached with a live `reservation` for essentially
every specialist run (primary AND reviewer) regardless of cap, for the
operator's own run whenever a clone is pending, and is reached *without* a
reservation (so it's actually gated) only for: (a) `resumeRun` — the
`@mention`-reply-to-an-existing-session path
(`app/server/tasks/task-actions.server.ts:1499`, the only caller of
`resumeRun`), which never sets `.reservation` on its `StartRunInput`
(`run-service.server.ts:1116-1182`); and (b) the operator's own drive when no
clone is pending. See the "Known correctness defects" section for the
empirical proof and severity.

## 6. The queue and the drain trigger

`state.pending: PendingRun[]` (`{ runId, launch: () => void }`,
`run-service.server.ts:118-122`) is a plain array used as a FIFO via
`.push()` (`admitRun`) / `.shift()` (`drainRunQueue`) — **in-process memory
only, not persisted**. The only durable trace of a parked run is its DB row
sitting at `state: "queued"`.

`drainRunQueue(db)` (`run-service.server.ts:1222-1241`):

```ts
export function drainRunQueue(db: DatabaseSync): void {
  const state = getState();
  if (state.draining) return;        // reentrancy guard, see below
  state.draining = true;
  try {
    for (;;) {
      const cap = getMaxConcurrentRuns(db);
      if (cap !== 0 && state.handles.size >= cap) return;
      const next = state.pending.shift();
      if (!next) return;
      const row = getRun(db, next.runId);
      if (!row || row.state !== "queued") continue;  // dropped while waiting
      next.launch();
    }
  } finally {
    state.draining = false;
  }
}
```

- Re-reads the cap on **every loop iteration**, so an admin lowering the cap
  mid-drain (via the settings action, which calls `drainRunQueue` right after
  `setMaxConcurrentRuns`) is honored immediately, and a cap raise with several
  runs parked promotes all of them that fit in one pass (pinned by the
  shipped test "cap increase is honored on the next drain (multiple
  promotions)", `run-concurrency.server.test.ts:598-617`).
- **Drop-while-queued semantics**: a pending entry whose DB row is no longer
  `"queued"` (because it was interrupted — see §7 — or otherwise finalized
  while waiting) is silently skipped (`continue`), never launched. The stale
  entry isn't proactively removed from `state.pending` when the interrupt
  happens; it just gets skipped whenever the FIFO reaches it. This does not
  block later valid entries — the loop keeps going.
- **Reentrancy guard** (`state.draining`): a promoted run can exit
  *synchronously* inside its own `launch()` call (a spawn-time crash — the
  same F-SPAWN2 class handled elsewhere in this file), which fires `onExit`
  during `next.launch()`, which calls `drainRunQueue` again. The nested call
  sees `state.draining === true` and returns immediately; the *outer* loop's
  next iteration correctly re-reads `handles.size` (unaffected, since a
  synchronously-crashed run's handle is never set — `launch()`'s
  `if (!exited) state.handles.set(...)`, line 1393) and continues. Verified
  correct by tracing both the sync-crash and the normal (async exit, guard
  already released by the time onExit fires later) cases.

Two triggers call `drainRunQueue`:

1. **Every run's `onExit`**, inside `launch()`
   (`run-service.server.ts:1344-1364`) — `state.handles.delete(spec.runId)`
   then `drainRunQueue(db)` *before* the run's completion callback fires (so
   a chain of queued runs keeps flowing even if that callback throws), wrapped
   in its own try/catch (logs `"run queue drain failed"` on error rather than
   propagating). This fires for **every** run that had a live handle,
   reservation-bypassed or not — a reserved run finishing still drains the
   queue normally.
2. **The `set-concurrency` route action**, after applying a new cap
   (`org.settings.tsx:243`) — handles the "admin raised the cap" case without
   waiting for a run to finish.

There is no other trigger. A run that never gets a handle and never finishes
(stuck forever with no onExit) would not itself drain anything — but nothing
in the gate depends on that run's exit *except* whatever is behind it in the
FIFO, which is the ordinary "an earlier run is still working" case, not a
leak.

## 7. Interrupt interaction

`interruptRun` (`run-service.server.ts:1410-1484`) branches on whether the
target run has a live handle (`state.handles.get(runId)`, line 1445):

- **Has a handle** (actually running): `handle.interrupt()` + delete the
  handle. The adapter's `onExit` (triggered by the interrupt) is what stamps
  `state: "interrupted"` and — critically — is what calls `drainRunQueue` via
  `launch()`'s `onExit` wiring (§6, trigger 1). `interruptRun` itself does not
  call `drainRunQueue`.
- **No handle** (queued, or already gone e.g. post-restart): writes
  `state: "interrupted"` directly (lines 1455-1461) and publishes the SSE
  state change. **This is the "drop a queued run" path** — it does not touch
  `state.pending` at all; the stale entry is left for `drainRunQueue` to skip
  over later (§6, "drop-while-queued").

This is why interrupting a *queued* run doesn't need to trigger a drain
itself: it never held a slot, so nothing is freed. Pinned by
`run-concurrency.server.test.ts`'s "drops a run interrupted WHILE queued" and
"drains the oldest queued run when a live run finishes" tests.

RBAC: `interruptRun` requires `admin|maintainer` via `requireRunAgents`
(project authority, not the org-admin gate `set-concurrency` uses) — this
predates the feature and is unchanged by it.

## 8. Boot / crash recovery

`app/server/runtimes/run-recovery.server.ts`, `finalizeOrphanedRuns(db)`
(lines 61-172), called from `app/server/boot.server.ts:614` on every boot,
before the reply-recovery reconciler:

```sql
SELECT id, project_slug, task_key, kind FROM agent_runs
 WHERE state IN ('running', 'queued')
```

Both non-terminal states are swept together — a fresh boot has **no** live
handle for anything (the whole `ServiceState`, including `pending`, is
recreated empty in a new process), so a `queued` row (parked behind the cap,
whose *launch closure* lived only in the dead process's memory) is exactly as
orphaned as a `running` row with a dead adapter. Every orphan is patched to
`state: "error", interruptedBy: "restart"` (lines 83-87), and the operator is
re-invoked (fire-and-forget, capped at `RECOVERY_REINVOKE_CAP = 3` re-invokes
per task per 30-minute rolling window to prevent a crash-loop, lines 100-145)
for each affected task so it can decide whether to re-run the specialist.

Net behavior for this feature specifically:
- **The cap value survives a restart** (real SQL row, §1).
- **A parked/`queued` run does NOT survive a restart as queued.** It becomes a
  clean terminal `error`, is never silently lost (it's visible on the task
  timeline/run log as an error) and is never double-fired (finalizing to
  `error` happens once, idempotently — "a second boot finds nothing
  non-terminal", line 59 docstring, since the `WHERE state IN (...)` predicate
  finds nothing left after the first pass). This looks like a deliberate,
  reasonable design choice, not a bug: you cannot resume an in-memory launch
  closure across a process boundary, so finalizing-and-letting-the-operator-
  reconsider is the honest option. Confirmed idempotent by inspection of the
  `WHERE` clause and the boot-order comment at `boot.server.ts:609-612`.

## 9. Shipped tests

- `app/server/runtimes/run-concurrency.server.test.ts` — gate unit tests
  (park past cap, drain-on-exit promotes oldest, drop-while-queued,
  multi-promotion on cap raise). **Calls `startRun` directly** with no
  `reservation` field — it exercises the `admitRun` gate correctly, but does
  **not** exercise the actual product dispatch path (`startAgentRun` /
  `dispatchAgentRun`), which is where the bypass in §5 lives. This is why the
  suite is green despite the defect below.
- `app/server/settings/instance-settings.server.test.ts` — round-trip, clamp,
  non-finite-throws.
- `app/routes/org.settings.concurrency.test.ts` — route action: admin sets
  the cap and it persists; `0` lifts it; a bad value is refused without
  changing the stored cap; a non-admin is refused. Does not start any actual
  runs, so it cannot see the gate/bypass interaction either.
- `app/features/org-settings/org-settings-page.test.tsx` — UI: cap/live/queued
  copy renders, "unlimited" phrasing at `cap: 0`, the Save button posts
  `set-concurrency` with the typed value. Pure presentation test against a
  hand-supplied `runConcurrency` prop — doesn't touch run-service.

---

## Known correctness defects

See the separate bug-candidates report for full detail, confidence, and
severity ranking. Summary for anyone about to touch this code:

**The cap is not enforced for the overwhelming majority of real dispatches.**
`dispatchAgentRun` (`app/server/tasks/specialist-run.server.ts:1320`)
unconditionally reserves every specialist run — delivering *and*
reviewer/supporting alike — before calling `startRun`, and a reservation
skips `admitRun` entirely (`run-service.server.ts:793-797`). This was
empirically reproduced against the real dispatch path (`assignSpecialist` /
`assignReviewer` + `startAgentRun`, the same functions the "Run" button and
the operator use): with the cap set to 1, two delivering runs on different
tasks both end up `running` simultaneously (`live: 2, queued: 0`), and
separately a reviewer run started alongside an already-live delivering run on
the *same* task also launches immediately instead of queuing — directly
contradicting the in-code comment at `run-service.server.ts:787-792` that
claims reviewer runs are gated. Only comment-triggered *resumes* of an
already-existing session (`resumeRun`, single caller
`task-actions.server.ts:1499`) and the operator's own drive when no repo
clone is pending are actually subject to the cap.
