# Critical code audit #2 — least-covered subsystems

Branch: `pass8-decision-counts-rbac-divergence-2026-07-18`
Scope: SSE/live-updates, boot + run-recovery, codex adapter, operator toolkit/run,
notifications projection. Read-only. Skeptical, no-false-positive pass.

**Headline: these subsystems are genuinely hardened.** Seven prior passes plus the
adversarial-review series left very little. The operator's Done/merge invariants,
the single-flight lease, the SSE broker, and the boot crash-loop cap are all
correctly implemented and defended in depth. Two genuine gaps below (1 MED, 1 LOW),
then the verification notes proving the rest is clean.

---

## MED-1 — Boot reply-recovery has NO crash-loop cap (asymmetric with `finalizeOrphanedRuns`)

- **File:** `app/server/runtimes/run-recovery.server.ts:191` (`recoverUnreactedAgentRuns`)
  together with `app/server/tasks/task-actions.server.ts:1220-1241` (`postAgentReplyComment`)
  and `:1687` / `:1898` (`applyAgentCompletionEffects` → `runOperator`).
- **What's wrong:** `finalizeOrphanedRuns` guards its operator re-invoke with
  `RECOVERY_REINVOKE_CAP` (3 per task per 30-min window) — the audit row is written
  *before* the fire, so a crash loop is bounded. The **sibling** boot-recovery path,
  `recoverUnreactedAgentRuns`, has **no such cap**. Its only cross-boot idempotency is
  the `task.agent.replied` audit row (the `NOT EXISTS` clause at `run-recovery.server.ts:205-208`).
  That row is written **inside `postAgentReplyComment`'s `.then()`**, *after*
  `updateTaskFile` succeeds (`task-actions.server.ts:1220-1233`). `updateTaskFile`'s
  rejection is swallowed by the internal `.catch` (`:1235`) and **never re-thrown**, so
  `applyAgentCompletionEffects` proceeds past the reply (`:1693`) to the operator
  re-invoke (`:1898`) even though the idempotency audit was never recorded.
- **Failure scenario:** A real specialist/reviewer run finished, task still
  `waiting=agent`, reply callback dropped by a restart. On boot, recovery runs; the
  task file's write persistently fails (disk pressure, a permission issue, or a
  frontmatter that fails re-serialization). Result each boot: reply not posted → audit
  not written → operator re-invoked anyway → **next boot re-selects the same run and
  re-invokes again, unbounded.** The react *depth* cap does not help: boot recovery
  passes no `operatorRun`, so `currentDepth` resets to 0 every boot
  (`task-actions.server.ts:1838-1842`).
- **Trigger is narrow** (needs a *persistent* `updateTaskFile` failure — the common case
  recovers exactly once and is fine), which is why this is MED not HIGH. But it is a
  real, uncapped operator-reinvoke path, exactly the class the audit asked about, and
  the fix is cheap.
- **Suggested fix:** give this path the same backstop as the finalize path — record a
  `run.recovery.*` audit row (or reuse the reply-recovery attempt count) *before*
  calling `applyAgentCompletionEffects`, and skip re-recovery once a per-run attempt
  cap is exceeded within the window. Alternatively, write the `task.agent.replied`
  audit unconditionally (even when the timeline write fails) so idempotency no longer
  depends on the file write.

## LOW-1 — `violation.updated` never reaches a `user`-only page, so the global rail badge goes stale there

- **File:** `app/server/events/event-publisher.server.ts:127-141` (routes
  `violation.updated` by `{projectSlug, taskKey?}`), `app/routes/notifications.tsx:50`
  (subscribes `[sseScopes.user()]` only), vs. the intent documented in
  `app/server/events/projection-events.server.ts:37-44` ("rail badge … revalidate on it").
- **What's wrong:** `violation.updated` is routed purely by project/task, never by
  `userId` and never `broadcast`. The policy-violation **rail badge is global** (shell,
  every page). It only refreshes when the *current route's* `useLiveUpdates` fires. Home
  (`[user, allProjects]`), Project (`[project, task, user]`), and GitHub view
  (`[project, user]`) all carry a project-matching scope, so they update. The
  **Notifications route subscribes to `user` only**, which no `violation.updated` route
  matches — so opening/resolving a scope violation while sitting on Notifications does
  **not** live-update the rail badge (no `projection.rebuilt` broadcast fallback fires
  for violations either).
- **Failure scenario:** User is on the Notifications page; a reviewer/reconciler opens a
  scope violation elsewhere. The rail badge count stays stale until the user navigates.
  Cosmetic; violations are infrequent.
- **Suggested fix:** either add `broadcast: true` to the `violation.updated` route (the
  badge is org-wide anyway), or have the global shell subscribe a scope that receives it.

---

## Verified CLEAN (with evidence) — do not re-audit these

**Operator cannot reach Done or merge under any autonomy.**
- Bare stage move into the terminal stage is refused for the operator at the *shared*
  `transitionStage` (`task-actions.server.ts:2361-2370`, `forbidden(...)`), independent
  of the operator-actions gate. Done is reachable *only* via `operatorAcceptCompletion`,
  and only when `autonomy === "full"` **and** `gate(completion-for-acceptance) === "direct"`
  (`operator-actions.server.ts:1338`). `gate()` deliberately does **not** promote
  `recommend`→`direct` for `completion-for-acceptance` under full autonomy
  (`operator-actions.server.ts:199`), and the toolkit only builds `accept_completion`
  when that capability isn't `deny` (`operator-toolkit.server.ts:344`).
- The full-autonomy accept sets `pr.state="accepted"` (merge pending) and **never merges**
  (`operator-actions.server.ts:1367-1395`). `mergeTaskPr` is only reached from the human
  `acceptCompletion` paths (`task-actions.server.ts:2829`, `:3144`), gated by
  `requireAcceptCompletion` (admin|maintainer|owner). No operator-authorized path touches it.
- Flagged (`validation="failing"`) and open-blocked-packet tasks are refused even under
  full autonomy (`operator-actions.server.ts:1309`, `:1323`).

**Single-flight operator lease is released on every path.**
- Real/codex runs release via `chainRunCompletion`/`registerRunCompletion`; the scripted
  path releases in a `finally`; a synchronous throw hits the outer `catch`
  (`operator-run.server.ts:379-403`). Release is idempotent-per-token
  (`releaseOperatorLease` compares the captured lease object, `:189-218`), so double-release
  can't evict a successor. The spawn-crash race (run finalizes before the callback attaches)
  is covered by `fireIfAlreadyTerminal` (`run-service.server.ts:100-137`), and both operator
  completion registrations pass `db` so it engages.

**Boot crash-loop cap is correctly enforced (the finalize path).**
- `RECOVERY_REINVOKE_CAP=3` / 30-min rolling window, counted per `(project, task)` from
  `run.recovery.reinvoked` audit rows written **before** the fire
  (`run-recovery.server.ts:97-141`). Sim vs real is classified by the `simulated` column;
  simulated orphans go `finished` with no re-invoke, real orphans go `error` and re-invoke
  (`:70-86`). One re-invoke per task per boot (Map-deduped). Correct.

**Codex adapter — the documented gaps are honestly surfaced, failures are not swallowed.**
- argv/env secret exposure: MCP credentials (`headers.Authorization` / `env.MCP_CREDENTIAL`)
  are **deliberately not** carried onto codex config, because the codex SDK passes config as
  `--config key=value` argv visible in `ps` (`codex-runtime.server.ts:74-88`). Scoped-out,
  documented, and the credential simply doesn't cross.
- Capability tool-confinement is **advisory** on codex: the adapter references
  `spec.disallowedTools`/`allowedTools` **zero** times (confirmed) — codex specialists run
  `danger-full-access`. This is **honestly surfaced in the UI**
  (`capability-matrix-modal.tsx:156`: "On Codex it is advisory only — the Codex SDK ignores
  tool allow/deny lists (S3)") and in the code. Not a silent failure. (Operators additionally
  get `read-only` + no network + no web-search on codex — `codex-runtime.server.ts:375-396`.)
- Failures are classified in-memory before redaction, the class rides the display tag, raw
  stderr is never logged/persisted (`:180-242`, `:314-338`), idle-timeout settles `error`
  (→ react/stuck-packet), and a failed operator run escalates a blocked recovery packet
  (`operator-run.server.ts:846`). Nothing is swallowed.

**SSE / live-updates.**
- Every projection mutation emits (`rebuilder.server.ts` project/task updated+removed,
  `notifications.server.ts` created+read, `policy-violations.server.ts` violation.updated);
  high-frequency `run.log-appended`/`run.state-changed` publish straight to the broker
  (`run-events.server.ts`). The publisher covers every `ProjectionEvent` variant; the client
  revalidates on any non-control event, so no emitted type is unhandled.
- Membership scoping is enforced server-side (`resources.events.ts:104-131`): non-admins get
  the `projects` firehose expanded to their member projects and named foreign scopes dropped.
- Reconnect replay math (`sse-broker.server.ts:263-285`) is correct (buffer-window `covered`
  check + resync fallback, handles restart-reset ids). Disconnect cleanup is leak-free:
  `dropConnection` clears the heartbeat, deletes the registry entry, is idempotent via
  `conn.closed`, and both `request.signal` abort and stream `cancel()` route to it.
  Backpressure caps the queue and drops on overflow.

**Notifications projection.**
- All five kinds (`packet`, `approval`, `mention`, `quality`, `policy`) are BOTH emitted at
  runtime (via `notifyTaskWatchers` → `createNotification`, from operator packets/recs, task
  mentions, run failures, and github/scope-flag) AND rendered in `notification-meta.ts:24-53`.
  No dead kind either direction.
- `waitingOnYou` is member-scoped through the single-source `decisionsRequiring`
  (`notifications.server.ts:134-146`), the same helper Home's counter uses
  (`decisions.server.ts`) — they cannot diverge. Prefs gating defaults to *deliver* on any
  lookup error (never silently drops a governance notification).

**Grep sweep (TODO/FIXME/HACK/placeholder/mock/stub/hardcoded/for-now/temporary).**
- No live defects. Nearly all hits are seed/demo code documenting faithful reproduction of the
  design mock (intentional), or comments documenting a *past* removal (e.g.
  `operator-actions.server.ts:299` "the code hardcoded 60" documents the compaction-threshold
  fix; `task-actions.server.ts:2109` documents using the ACTION_ROLES map instead of a literal).
