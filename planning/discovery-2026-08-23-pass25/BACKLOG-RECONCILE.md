# Pass 25 — pass-23 backlog reconciliation (against current main `7cf113a`)

Verified item-by-item against the CURRENT tree by sonnet audit sub-agents (A-series; B/C-series) + my own
spot checks. D/E-series audit stalled (watchdog) — I cover those inline during implementation (mostly polish/tests).
Every claim traced to the real UI-consuming code path, not symbol presence (pass-24 lesson: fixes can be inert).

## Section A (honesty/coherence) — ALL FIXED
A1 (HIGH, capability display materialization) FIXED across all 4 surfaces (`effectiveProfileView` materializes every
absent catalog cap at its runtime-effective mode; matrix/detail/policy all render the same `view.actions`; cross-check
test `agents-query.server.test.ts:309-352`). A2 (KB delete disclosure + project-grant count) FIXED. A3 (remove-member
task release) FIXED — real `releaseTasksOwnedBy` in every project + honest dialog copy. A4 (connection removal sync
disclosure) FIXED (`boundProjects` count). A5 (delete-project audit claim) FIXED. A6 (Done-boundary unconditional copy)
FIXED loc1 (Permissions panel now conditional on `operatorCanAccept`); loc2 MOOT (org template modal can't edit the
operator, so flat copy is correct). A7 (run-operator toast on refusal) FIXED. A8 (@mention run-fail partial success)
FIXED (`commentToAgent` returns `runNotStarted`, comment preserved). A9 (PR-head unverifiable disclosure) FIXED
(`evaluateAcceptancePrHead` → verified/unverifiable/not-applicable; timeline note discloses unverifiable). A10 (review
footer "merges" absolute) FIXED ("when there is one").
- A9 optional enhancement (not required): surface the unverifiable-head signal in the pre-accept confirm dialog too,
  not only the post-hoc timeline note.

## Section B/C — mixed
- **B1** (editor per-cap enforcement scope) **FIXED** — `create-profile-modal.tsx` imports `capabilityEnforcement`,
  renders "advisory on Codex"/"inert on Codex" badges. (Also confirmed live.)
- **B2** (backend quota pre-run signal) **OPEN — needs owner ruling.** Deliberate: quota/auth never marked as
  availability. Only post-hoc recovery packet. **Live-reproduced this pass on VQ-2** (Codex over quota → assigned →
  failed → recovery packet). Fix direction: short-TTL transient `kind:"quota"` + `expiresAt` parsed from provider
  sentence, surfaced in the run-control slot. → see QUESTIONS.
- **C1** (autoInvokeOperator swallow) **FIXED** — catch writes a timeline note + inner try/catch.
- **C2** (queued @operator drop/fire-fail) **FIXED** both parts (noteDroppedOperatorTurn / noteQueuedTriggerFireFailed
  + settleWaitingAfterOperator).
- **C3** (agent reply vanish / retry double-post) **FIXED** — writeReply retried once, finalizeReply separated.
- **C4** (completion-effects crash) **FIXED** — rewired to the async `.catch` seam (registerAgentCompletion →
  applyAgentCompletionEffects().catch → noteCompletionEffectsLost sets waiting:human + continuity event).
- **C5** (verdict-granted reviewer no-verdict note) **PARTIAL — still OPEN.** Narrowed to review-stage + !question, but
  a conversational `@Reviewer` reply while the task sits at review stage STILL fires the false "acceptance stays gated,
  re-run the review" note (no per-run intent flag distinguishes a validation run from a conversational aside). Fix:
  thread a `reviewRun`/intent flag into `applyAgentCompletionEffects` and gate the note on it, not just stage.
  (`task-actions.server.ts:2866-2903`.)
- **C6** (MCP registry read failure erases disclosure) **FIXED** — every requested name lands in `unresolved`.
- **C7** (reconcile-poller failure invisible) **FIXED** — `reconcileSummaryFailed(summary)` on the resolved summary +
  noteReconcileFailure; test pins it.
- **C8** (attachments 100-file silent truncation) **OPEN.** `task-attachments.server.ts:35,64` LIST_CAP=100 slice, no
  total; panel renders array length, no "N more". Fix: return `{entries,total}`, render "showing 100 of N".
- **C9** (workspace reclaim boot-only + no storage visibility) **FIXED** — periodic maintenance every 6h + 5-min
  disk-pressure check; StorageLine in Instance settings. (Also confirmed live.)
- **C10 residue (9 sub-items):** only C10.6 (schedule runner Symbol.for + boot-catch log) FIXED. **STILL OPEN (8):**
  1. `notifyTaskWatchers` recipient-resolution failure → logger.error + return [], watchers silently get nothing
     (`task-mutation.server.ts:144-171`).
  2. Post-run delivery reconcile double-swallowed; both callers ignore `.status` (`workspace-delivery.server.ts:635-650`;
     callers `task-actions.server.ts:3088-3097, 4407-4434`).
  3. Empty-branch cleanup after no-change acceptance: refusal→note, THROW→warn only, branch persists silently
     (`task-actions.server.ts:7296-7345`).
  4. Stuck-loop escalation failing/refused → log only, task stays `waiting:human` with no card
     (`task-actions.server.ts:1953-2033`).
  5. `.git/info/exclude` write failure → warn only; mounted skill files could leak into a delivered PR
     (`skill-mount.server.ts:324-350`).
  7. Audit writes fail open (logger.error only) — deliberate, likely leave (`audit-recorder.server.ts:61-89`).
  8. Stale shipped `operator.md` divergence → boot-console warn only, no in-app surface
     (`default-assets.server.ts:338-372`).
  9. Run reservation write failure → warn + return null (deliberate degraded, likely leave)
     (`run-service.server.ts:359-395`).

## Section D/E — audit stalled; my quick reads
- **D1** (slow first-clone honest label) **FIXED** (live-confirmed).
- **D2** (org settings vs instance settings naming) — nav reportedly now "Instance settings"; VERIFY the user-menu
  entry + all call sites agree (I'll check during impl).
- **D3** (board New task no-op on stage-less project) — VERIFY.
- **D4** (org profile empty-state "model" field the org editor lacks) — VERIFY.
- **D5** (model-catalog fetch failure deadlocks Save) — VERIFY.
- **D6** ("1 profiles" pluralization) — VERIFY.
- **E1-E9** (test coverage gaps) — treat as the test-hardening backlog; re-derive during impl.

## Net still-actionable from pass-23 backlog (excluding deliberate)
C5 (partial), C8, C10.1-.5, C10.8; B2 (owner ruling). Plus D2-D6/E-series to verify. Plus pass-25 NEW: F25-1, F25-2, F25-3.
