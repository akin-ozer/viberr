# S5-foundation — adversarial verification (pass 15, W5)

Method: read the diff of the S5-owned files only; re-ran every named proving
test against a **HEAD worktree** (old source + new tests) to check it really
fails on the old behavior; probed the acceptance predicate against the live
server-side acceptance gate with a throw-away test (removed); ran
`npm run typecheck` and the full vitest suite.

Gates:

- `npm run typecheck` → **EXIT 0** (`react-router typegen && tsc`, no output).
- `npx vitest run` (whole repo) → **205 files / 2369 tests passed**.
- S5's own 9 files → **94 passed**.
- Old-behavior replay (new tests on HEAD source) → **24 failed / 61 passed**,
  i.e. the load-bearing assertions do fail without the diff.

---

## Per-claim verdict

| id | verdict | evidence |
|----|---------|----------|
| B-FD1 | **CONFIRMED (with a HIGH operational gap — see G1)** | `app/server/db/data-root-lock.server.ts` (new, 240 lines): O_EXCL create, holder JSON `{pid,hostname,startedAt}`, `classifyLock` (`data-root-lock.server.ts:126-135`) refuses on a foreign host and on an unreadable lock, takes over a same-host dead pid; wired at `app/server/boot.server.ts:158` BEFORE `getDb()`; `VIBERR_FORCE_DATA_ROOT_LOCK` in `app/server/config/env.server.ts:78-84`. 9 tests; the module did not exist on HEAD so all of them fail there. |
| B-FD2 | **CONFIRMED as PARTIAL** (correctly declared) | Priority ladder at `app/server/tasks/mention-notify.server.ts:110-125`, ambiguity → nobody at `:118-122`, `notifyMentionedUsers` preserved at `:191-196`. On HEAD: "an ambiguous FIRST-NAME mention…" ✗, "…dashed form…" ✗, "an exact email local-part outranks…" ✗, "ambiguity is judged before the author exclusion" ✗, "resolveMentionTargets is pure…" ✗, "the non-delivery note…" ✗. **Overclaim:** "one person tagged twice … gets ONE notification" **passes on HEAD** (the old loop iterated users once) — it is a guard test, not a proving test. Note G4. |
| B-FD5 | **BROKEN** (mechanism lands; the predicate contradicts R15-1 — see G2) | Union at `app/server/projections/decisions.server.ts:119-135` + `:189-201`, dedupe via `seen` (`:141-146`), review stage resolved through `resolveStageRoles` (`:96-98`), owner/role parity with `resolveAcceptanceAffordance` (`task-actions.server.ts:4495-4498`). All three proving tests fail on HEAD. But the predicate omits the **R15-1 verdict gate**, so it counts tasks the server refuses to accept (proved live, G2). |
| B-FD6 | **CONFIRMED as PARTIAL** (correctly declared) | `notificationHref` at `app/server/projections/notifications.server.ts:97-116`; `href` folded in at `:172`. `/projects/<slug>` is a real route (`app/routes.ts:41-42` index child). Proving test fails on HEAD. UI still dead: `app/routes/notifications.tsx:106-107` is unchanged and ignores `href`. |
| B-FD7 | **CONFIRMED** (2 of the 4 named tests are controls) | `resolveTerminalState` at `app/server/runtimes/run-sink.server.ts:26-31`, applied at `:325` with `finishedAt` withheld on a keep (`:334`); `markDivergent` at `:188-230`, called from the `line` catch at `:307`. On HEAD: "does not overwrite … interrupted" ✗, "a second finalize never rewrites…" ✗, "marks the run's console as incomplete, once…" ✗. "finalizes normally from a live state" passes on HEAD (control). Honesty gap G5. |
| B-FD8 | **CONFIRMED as PARTIAL, but the module is 100% dead code today** | `applyCommentGuardrails` / `commentOutcomeMessage` / `COMMENT_DROPPED_AUDIT_ACTION` at `app/server/tasks/comment-guardrails.server.ts:82-180`. All 5 tests fail on HEAD (`is not a function`). `grep` over `app/**` finds **no non-test importer** — the live sequence is still inlined at `operator-actions.server.ts:305-341` and still reports "posted" unconditionally at `:898-907`. Semantics do match the live path (dedupe compares POST-trim text — `operator-actions.server.ts:337`), so H2 is a safe swap. |
| B-FD9 | **CONFIRMED as PARTIAL** (2 of the 4 named tests are controls) | Predicate flip at `app/server/tasks/timeline-compaction.server.ts:95` (`actor.kind !== "human"`), newest-agent-per-run keep at `:70-83`. On HEAD: "never folds a HUMAN comment" ✗, "folds an AGENT-reply flood…" ✗. "keeps ordering newest-first…" and "stays idempotent…" **pass on HEAD** — controls, not proofs. Stale rationale G6. |
| B-FD10 | **CONFIRMED** | `IDEMPOTENCY_AUDIT_ACTIONS` at `app/server/db/retention.server.ts:26-47`, `NOT IN` at `:71-77`. The two strings are exactly the two `NOT EXISTS` idempotency probes (`run-recovery.server.ts:208-214` `task.agent.replied`, `:363-367` `runtime.operator.plan_executed`); the two rolling-window counters are correctly left prunable. Proving test fails on HEAD (4 vs 2). Doc-contradiction G7. |

---

## The 3 most dangerous gaps

### G1 (HIGH, B-FD1) — the writer lock is never released on SIGTERM/SIGINT, so `docker compose down && up` bricks the boot

`acquireDataRootLock` releases via `process.once("exit", release)`
(`data-root-lock.server.ts:222`). The app's only signal handler
(`app/server/events/sse-broker.server.ts:158-166`) closes sockets, closes the
DB and then **re-raises the signal** — the default action terminates the
process and Node's `exit` event never fires. Proved with a minimal repro:
the shutdown handler ran, the process died with code 143, the `exit` listener
never ran.

Consequences on the user's documented deployment:

- `compose.yml` pins no `hostname:`, so every **recreated** container gets a
  new hostname. `docker compose stop/down` leaves `docker-data/state/writer.lock`
  holding the dead container's hostname; the next `up` sees a *different host*,
  which `classifyLock` (`:131`) deliberately refuses — and it cannot probe it.
  The app then **never boots again** until someone deletes the file inside the
  volume or sets `VIBERR_FORCE_DATA_ROOT_LOCK=1`. (A `restart: unless-stopped`
  restart of the *same* container survives: same hostname, pid 1 == self → the
  self-reclaim branch at `:129`.)
- Host dev: Ctrl-C leaves a lock; normally the pid is gone → stale → fine, but
  a recycled pid (routine on macOS) makes `npm run dev` refuse to start with
  "Held by pid N … Stop that process first."
- The refusal is thrown from module scope in `app/entry.server.tsx:21`, so what
  the operator actually sees is an SSR module-init crash, not the carefully
  written `refusalMessage` on stdout.

Fix: register the release in the existing SIGINT/SIGTERM `shutdown` (before the
re-raise) — the same place P13-D-43 put `shutdownDatabase()` — and catch
`DataRootLockedError` at the boot call site to print `error.message` and
`process.exit(1)` cleanly. Optionally pin `hostname: viberr` in `compose.yml`
so a recreated container can probe its predecessor at all.

### G2 (HIGH, B-FD5) — the new `acceptance` decision ignores R15-1, so Home and the bell promise a decision the server refuses

Proved live (throw-away test, since removed): a review-stage task with
`waiting: human`, a `workRevision`, an open PR and **no verdict-capable
engagement** yields

```
DECISIONS:  [{"taskKey":"VIB-900","kind":"acceptance","stage":"review"}]
AFFORDANCE: {"hasAuthority":true,"atBoundary":true,"canAccept":false,
             "blockedReason":"VIB-900's delivered revision has no approving verdict yet …"}
```

Root cause: `decisions.server.ts:129` gates on `validation_block_reason`, and
the rebuilder projects that column from `acceptanceBlockedReason(fm)` **only**
(`app/server/projections/rebuilder.server.ts:421`). This pass's R15-1 gate
lives in `verdictGateReason` (`task-actions.server.ts:4310-4322`) and in
`acceptanceRefusalReason` (`:4346`), neither of which is projected — so a
delivered-but-unverdicted task reads as "acceptance-ready". `getReviewQueue`'s
`isReady` has the identical hole (`review-queue.server.ts:145-150`), which is
why "predicate parity" reproduced it; B-FD5 propagates it from one queue into
**Home's per-project count and the notifications inbox**, i.e. exactly the
dead-end inbox entry R14-2/P14-LV-06 exist to abolish, and in direct tension
with ruling **R15-1** ("acceptance REQUIRES a healthy verdict").

Fix (one line each, both cheap): project the verdict gate into
`validation_block_reason` alongside `acceptanceBlockedReason`, **or** add
`AND (pr_json IS NOT NULL OR json_extract(fm…) …)` — cleanest is to extend the
projection so the review queue is fixed at the same time. Add a test with a
delivered revision and zero verdict-capable engagements asserting
`decisionsRequiring(...).mine` is empty.

Secondary, same predicate (MEDIUM): an **archived project** still yields
acceptance decisions — proved, `ARCHIVED: [{"taskKey":"VIB-901","kind":"acceptance"}]` —
because `listProjects` (`board-query.server.ts:80-85`) does not filter
`archived`, and only task-level `archived = 0` is checked. R6-3 makes an
archived project read-only, so `resolveAcceptanceAffordance` returns denied.
The packet path had the same exposure before this pass; the union widens it.

### G3 (MEDIUM, B-FD2) — ambiguous tags from AGENTS and the OPERATOR now notify nobody, silently

The ladder drops an ambiguous handle for every caller, but the non-delivery
note is planned only for human comments (handback H3,
`task-actions.server.ts:741`). The other five call sites —
`operator-actions.server.ts:369` / `:455`, `task-actions.server.ts:1389` /
`:1874` / `:2525`, `agent-toolkit.server.ts:121` — keep the `string[]` shape
and drop `ambiguous` on the floor. Old behavior notified *both* Ardas (noisy
but the right person was reached); new behavior reaches **nobody, with no
trace anywhere**. That is a partial regression of the NEW-4 convention
("agents+operator must @tag the human they answer AND the tag must notify"),
and the operator is explicitly instructed to tag by handle
(`operator-run.server.ts:1784`). Either notify all candidates for machine
authors, or record the ambiguity (log + `task.comment.dropped`-style detail) so
it is not silent. Worth folding into H3 rather than shipping as-is.

---

## Smaller findings

- **G4 — two ledger rows name control tests as proofs.** B-FD2's "one person
  tagged twice … ONE notification" and B-FD9's "keeps ordering newest-first" /
  "stays idempotent with agent replies" all **pass on HEAD**. The claims still
  hold on their other named tests; only the ledger wording overstates.
- **G5 — `markDivergent`'s message can lie.** `appendRawLine` is inside the same
  `try` (`run-sink.server.ts:267`), so a *raw-file* failure also triggers the
  marker, whose text says "the run's raw .jsonl transcript … holds the full
  stream" (`:196`) — false in exactly that branch, and it then appends the
  marker to the failing file. Distinguish the two failures, or soften the copy.
- **G6 — stale rationale in the compaction header.**
  `timeline-compaction.server.ts:24` justifies keeping the newest agent reply by
  `hasReworkSinceLastRejection`, **which no longer exists** — that heuristic was
  replaced by the revision-bound model (`task-file.schema.ts:401-407`). The
  behavior is still defensible; the reason given for it is not.
- **G7 — B-FD10 contradicts FR33 and the runbook.** `design/prd.md:257` and
  `docs/operations/runbook.md:104,113` state audit rows are hard-deleted at 90
  days, which is now false for two actions. No handback covers it; add a doc
  amendment (C-D class) so the canon stays honest — this pass already carries
  R15-8 for exactly this kind of drift.
- **G8 — the exemption is coupled by duplicated string literals.**
  `IDEMPOTENCY_AUDIT_ACTIONS` re-types `"task.agent.replied"` /
  `"runtime.operator.plan_executed"`, whose originals are module-private consts
  in `run-recovery.server.ts:21-29`. Renaming either silently re-arms the
  reprocessing hazard. Export the constants and import them, or pin them with a
  test.
- **G9 — undeclared file edit.** `app/features/shell/workspace-routes.server.test.ts:240-256`
  was rewritten by this stream (the UI-48 assertion inverted to expect
  `kind: "acceptance"`). Correct and necessary, but it is not in the declared
  ownership list or the deviations, and a sibling stream is editing the same
  file (the R15-4 block above it).
- **G10 — two existing notification fixtures were adjusted** (`waiting: "agent"`,
  `notifications.server.test.ts:269,291`). Verified the original intent
  ("resolution takes the row out of the waiting bucket") is preserved rather
  than weakened; the F7-NOTIF1 coverage now holds only for agent-waiting tasks,
  which is honest under B-FD5.
- **No ruling violations found beyond G2.** R15-3/R15-4/R15-6/R15-7 are
  untouched by these files; the acceptance authority mirrors
  `requireAcceptCompletion`'s owner exception (`task-actions.server.ts:328-338`)
  exactly, so the role dimension offers nothing the server refuses.
- **`.env.example` + `state/`**: benign. `state` is already a declared data-root
  subdir (`file-store-root.server.ts:36`) and is outside the file watcher's
  tree, so `writer.lock` triggers no rescans.
