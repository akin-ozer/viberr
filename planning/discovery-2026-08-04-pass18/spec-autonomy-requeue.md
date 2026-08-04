# Spec — R18-2 / F18-10: a full-autonomy delivery re-queues the operator

**Owner ruling:** R18-2 — *"After the server opens a review PR, re-trigger the queued
operator (at minimum when the task's operator autonomy is `full`) so it proceeds to
engage the reviewer / recommend the next step without a human nudge. Delivery is not a
stage transition, so the existing chain-retrigger never fired — the fix restores the
'never strand `waiting:human` with no packet' invariant (R-A) to the post-delivery
moment."*  Resolves **F18-10** (full-autonomy strands after delivery).

**Status:** SPEC ONLY. No source changed. All anchors are against the tree at merge
`934ede6` (unchanged this pass).

---

## 0. TL;DR of the decision

- **Seam:** the tail of `performDelivery`, inside the single `result.status === "ok"`
  branch where a review PR was just opened — `app/server/tasks/task-actions.server.ts:3512`.
  This is the one choke point that all three delivery callers (operator tool, manual
  button, applied recommendation) flow through.
- **Trigger:** the existing `autoInvokeOperator(...)` (same module, `task-actions.server.ts:687`),
  which resolves authority, no-ops when no operator is deployed, and calls
  `runOperator`. We add a new trigger value **`"delivered"`**. This is the exact
  mirror of how `transitionStage` re-triggers after a stage move (`task-actions.server.ts:3215`).
- **Gate:** `autonomy === "full"`, read from `ctx.operatorRun?.autonomy` (operator-authored
  delivery) with a fallback to `resolveOperatorAuthority(ctx, projectSlug).autonomy` (the
  deployment default, for human-initiated delivery).
- **Loop guard (I7):** fire only on a **newly opened** PR (`result.created === true`);
  thread `nextTransitionChainDepth(ctx)` so the operator-authored chain shares
  `OPERATOR_TRANSITION_CHAIN_CAP` (=8); the re-triggered run can never re-deliver
  (`operatorDeliverForReview` no-ops on a live PR), and the settle path is mutually
  exclusive with the stranded-resume backstop (below), so there is no double-drive.

---

## 1. Why the task strands today (root cause)

`performDelivery` (`task-actions.server.ts:3332`) pushes the branch and opens the
review PR, but **opening a PR is not a stage transition**. The only structural operator
re-trigger after a state change is R-A / P11-70, wired into `transitionStage`:

`app/server/tasks/task-actions.server.ts:3196-3233`
```ts
  if (input.toStageId !== lastStageId) {
    const chainDepth = nextTransitionChainDepth(ctx);
    if (chainDepth >= OPERATOR_TRANSITION_CHAIN_CAP) {
      ...openStuckLoopPacket(...);
    } else {
      void autoInvokeOperator(
        db, ctx, input.projectSlug, input.taskKey, "transition", chainDepth,
        { fromName: ..., toName: ..., byHuman: ... },
      );
    }
  }
```

There is a *second* backstop, `maybeResumeStrandedOperator` (`operator-run.server.ts:437`),
but it only fires when the task is left at a stage with an **`auto` outbound boundary**
(`operatorLeftTaskStranded`, `operator-run.server.ts:414-427`). After delivery the task
sits at a Review-role stage whose outbound boundary is `approval`/`human`, so
`operatorLeftTaskStranded` returns `false` and that backstop never fires either.

Net effect (live-caught F18-10): under full autonomy the operator delivers (opens the
PR) and ends its turn; nothing re-queues it; the task sits `waiting:human` with empty
`recommendations`, no packet, no card.

---

## 2. The exact re-trigger machinery to mirror

### 2.1 `autoInvokeOperator` — the enqueue seam (same module as `performDelivery`)

`app/server/tasks/task-actions.server.ts:687-728`
```ts
export async function autoInvokeOperator(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  trigger: "create" | "transition" | "goal-updated" | "pr-diverged",   // ← extend
  transitionDepth?: number,
  transition?: { fromName: string; toName: string; byHuman: string | null },
): Promise<void> {
  try {
    const { resolveOperatorAuthority } = await import("./operator-actions.server");
    const authority = resolveOperatorAuthority(ctx, projectSlug);
    if (!authority.deployed) return;                    // no operator → no-op
    const { runOperator } = await import("~/server/runtimes/operator-run.server");
    await runOperator(db, {
      projectSlug, taskKey, trigger,
      ...(transitionDepth !== undefined ? { transitionDepth } : {}),
      ...(transition ? { transitionFromName: ..., transitionToName: ..., transitionByHuman: ... } : {}),
      dataRoot: ctx.dataRoot,
    });
  } catch (error) { logger.error("auto operator invocation failed", ...); }
}
```

Key properties we rely on:
- It **self-guards on `authority.deployed`** — safe to call unconditionally when an
  operator may or may not be deployed.
- It reaches `runOperator` through a **dynamic import** of
  `~/server/runtimes/operator-run.server` — which is the mockable seam for the test
  (see §6), even though `autoInvokeOperator` itself is same-module as `performDelivery`.

### 2.2 `runOperator` — single-flight lease + queue (idempotency / I7)

`app/server/runtimes/operator-run.server.ts:683-719`. When a trigger arrives while a
drive holds the per-task process lease, it is **queued** (machine triggers are
newest-wins) and fired exactly once when the current drive releases the lease:

```ts
  const heldByProcess = lease.held.get(leaseKey);
  if (heldByProcess) {
    queueOperatorTrigger(leaseKey, input);            // newest-wins machine trigger
    return { runId: heldByProcess.runId, queued: true, ... };
  }
```

This is precisely the *"queued operator"* R18-2 names: when the operator delivers via
its own tool mid-run, our `runOperator("delivered")` call is queued behind that very
drive and fires on release.

### 2.3 Settle path is mutually exclusive with the stranded backstop

`releaseOperatorLease` (`operator-run.server.ts:339-368`): if a queued trigger exists it
fires it and **returns** — `settleWaitingAfterOperator` (and therefore
`maybeResumeStrandedOperator`, `operator-run.server.ts:600`) runs only when the queue is
empty. So the queued `"delivered"` trigger and the stranded-resume backstop can never
both fire for the same drive → no double-drive.

### 2.4 The chain-depth cap (runaway backstop)

`nextTransitionChainDepth(ctx)` (`task-actions.server.ts:126-130`):
```ts
export function nextTransitionChainDepth(ctx: TaskMutationContext): number {
  return ctx.operatorAuthorized ? (ctx.operatorRun?.transitionDepth ?? 0) + 1 : 0;
}
```
Operator-authored delivery → `ctx.operatorAuthorized === true` (set by
`operatorDeliverForReview`, `operator-actions.server.ts:1809-1815`) and
`ctx.operatorRun` present → threads depth+1. Human-initiated delivery → returns 0 (fresh
chain). `runOperator` re-threads it, and any transition the re-triggered run makes shares
the same `OPERATOR_TRANSITION_CHAIN_CAP` (=8, `task-actions.server.ts:124`).

---

## 3. Autonomy: where the fact lives

`OperatorAutonomy = "supervised" | "full"` (`operator-actions.server.ts:82`).

Two sources, in priority order:

1. **`ctx.operatorRun?.autonomy`** — the autonomy of the operator run that is delivering
   *right now*. Set at drive start (`operator-run.server.ts:786-793`) and carried on the
   ctx into `operatorDeliverForReview` → `performDelivery`
   (`operator-actions.server.ts:1809`, which spreads `{ ...ctx, operatorAuthorized: true }`).
   This honors a one-off full-autonomy run started from the task panel over a supervised
   deployment.
2. **`resolveOperatorAuthority(ctx, projectSlug).autonomy`** — the deployment default,
   read from `definition.autonomy` via `readAutonomy` (`operator-actions.server.ts:149-152,
   254`). This is the value for **human-initiated** delivery (manual button / applied
   recommendation), where there is no `ctx.operatorRun`.

If no operator is deployed, `resolveOperatorAuthority` returns
`autonomy: "supervised"`, `deployed: false` (`operator-actions.server.ts:217-232`), so the
gate fails closed — and `autoInvokeOperator` would no-op anyway.

**Supervised is deliberately NOT re-triggered** (see §5).

---

## 4. The change (before / after)

### 4.1 `performDelivery` — insert the gated re-trigger

`app/server/tasks/task-actions.server.ts` — inside the `if (result.status === "ok")`
branch. **Before** (`3512-3529`):

```ts
    if (result.status === "ok") {
      // R17-2: a real PR now stands for review — clear any stale no-change flag
      // from an earlier empty-branch attempt (a later delivery produced commits).
      const cur = readTaskFile(taskRef(ctx, projectSlug, taskKey));
      if (cur?.parsed.frontmatter.noChanges) {
        await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
          delete parsed.frontmatter.noChanges;
        });
        reprojectTask(db, ctx, projectSlug, taskKey);
      }
      return {
        status: "delivered",
        prNumber: result.prNumber,
        url: result.url,
        created: result.created,
        pushStatus: push.status,
      };
    }
```

**After** (insert the block between the `noChanges` clear and the `return`):

```ts
    if (result.status === "ok") {
      // R17-2: a real PR now stands for review — clear any stale no-change flag
      // from an earlier empty-branch attempt (a later delivery produced commits).
      const cur = readTaskFile(taskRef(ctx, projectSlug, taskKey));
      if (cur?.parsed.frontmatter.noChanges) {
        await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
          delete parsed.frontmatter.noChanges;
        });
        reprojectTask(db, ctx, projectSlug, taskKey);
      }
      // R18-2 (F18-10): opening the review PR is delivery, NOT a stage transition, so
      // the P11-70 every-transition re-trigger (and the auto-boundary stranded backstop)
      // never fires here — an autonomous task would sit `waiting:human` with no packet,
      // recommendation, or card. Under FULL autonomy the operator must proceed on its own
      // (engage the reviewer / recommend the next step): re-queue it with a `delivered`
      // trigger. SUPERVISED keeps the human in the loop — the "Opened PR" event is on the
      // timeline (writePrToTask) and the human drives the next move, so we do NOT
      // re-trigger. Only a NEWLY opened PR counts (`result.created`); a reuse changed
      // nothing, and the operator's own deliver tool already no-ops on a live PR, so this
      // never loops. Fire-and-forget and depth-capped, exactly like the transition
      // re-trigger; `autoInvokeOperator` is itself a no-op when no operator is deployed.
      if (result.created) {
        const { resolveOperatorAuthority } = await import("./operator-actions.server");
        const autonomy =
          ctx.operatorRun?.autonomy ??
          resolveOperatorAuthority(ctx, projectSlug).autonomy;
        if (autonomy === "full") {
          void autoInvokeOperator(
            db,
            ctx,
            projectSlug,
            taskKey,
            "delivered",
            nextTransitionChainDepth(ctx),
          );
        }
      }
      return {
        status: "delivered",
        prNumber: result.prNumber,
        url: result.url,
        created: result.created,
        pushStatus: push.status,
      };
    }
```

Notes:
- `void` (fire-and-forget) mirrors `transitionStage`'s `void autoInvokeOperator(...)`
  (`task-actions.server.ts:3215`): the re-trigger must never block or fail the delivery.
- `resolveOperatorAuthority` is dynamically imported to avoid the module cycle — the same
  idiom already used in this file at `task-actions.server.ts:2505`. `autoInvokeOperator`
  and `nextTransitionChainDepth` are same-module, no import needed.

### 4.2 `autoInvokeOperator` — widen the trigger union

`app/server/tasks/task-actions.server.ts:692`

Before:
```ts
  trigger: "create" | "transition" | "goal-updated" | "pr-diverged",
```
After:
```ts
  trigger: "create" | "transition" | "goal-updated" | "pr-diverged" | "delivered",
```

### 4.3 `RunOperatorInput.trigger` — add the value

`app/server/runtimes/operator-run.server.ts:93-100`

Before:
```ts
  trigger?:
    | "create"
    | "transition"
    | "agent-reply"
    | "goal-updated"
    | "pr-diverged"
    | "scheduled"
    | "manual";
```
After — add `| "delivered"`. This is the ONLY type edit needed downstream:
`OperatorTrigger = NonNullable<RunOperatorInput["trigger"]>` (`operator-run.server.ts:2044`)
picks it up automatically, and `agentReportBlock` / `transitionContextOf` already return
empty for non-matching triggers (`operator-run.server.ts:2054-2068`), so `"delivered"`
needs no handling there.

Add a doc line to the JSDoc block above the union:
```ts
   *   delivered → PROCEED: the server just opened the review PR (a full-autonomy
   *     delivery). Not a transition, so this is the seam that keeps an autonomous task
   *     moving — engage the reviewer / recommend the next step from the live snapshot.
```

### 4.4 `operatorTurnInstruction` — a focused `delivered` branch

`app/server/runtimes/operator-run.server.ts` — add before the generic `moveContext`
block (i.e. alongside the other `if (trigger === ...)` guards, after the `pr-diverged`
block ends at `2172`):

```ts
  if (trigger === "delivered") {
    const prNo = snapshot.pr ? `#${snapshot.pr.number}` : "the review PR";
    return (
      `The review pull request ${prNo} was just opened for this task's delivered work — ` +
      "delivery is DONE, do not deliver again. Take the ONE next coordination step from the " +
      "live snapshot: if no reviewer is engaged and the stage calls for review, engage a " +
      "verdict-capable profile with `prompt_agent` (`delivers: false`); if a review has " +
      "already passed, `accept_completion` per policy; if a stage move is needed to reach " +
      "review, `transition_stage`. If the reviewer's run is already IN FLIGHT (`liveRuns`), " +
      "do nothing and stop — you are re-invoked when it reports."
    );
  }
```

Rationale for a dedicated branch over falling through to the generic instruction: the
generic block still tells the operator *"DELIVERY … is YOUR decision … Deliver when …"*
(`operator-run.server.ts:2212`), which would invite a wasted `deliver_for_review` call.
`operatorDeliverForReview` no-ops on a live PR (`operator-actions.server.ts:1779-1788`),
so it is *safe* either way, but the focused instruction avoids the wasted turn action.
(Acceptable minimal alternative: skip §4.4 entirely and let `"delivered"` fall through to
the generic stage rules — the no-op guard still prevents a re-deliver. §4.4 is the
recommended, cleaner form.)

---

## 5. Supervised behavior (what "does not strand" means here)

Under supervised autonomy the fix intentionally does **nothing extra**, and that is
correct, not a strand:

- Supervised delivery is human-initiated — either the **manual** "Deliver branch & open
  PR" button (`manualDeliverForReview`, `task-actions.server.ts:3621`) or a human applying
  the operator's **`delivery` recommendation** (`applyRecommendation`,
  `task-actions.server.ts:5479`). (`operatorDeliverForReview` under supervised does not
  reach `performDelivery` at all — `deliverGate` returns `"recommend"` and it posts a
  recommendation card instead, `operator-actions.server.ts:1789-1803`.)
- The delivery writes a human-visible **"Opened PR" `github` timeline event**
  (`writePrToTask`, `pr-open.server.ts:378-411`) and settles `waiting:human`. The human is
  the driver under supervised autonomy, so waiting on them is the *intended* resting state.
- **No recommendation is auto-generated by this fix** — that would require an operator run
  we are deliberately not queuing. The correct supervised contract is: *the delivery event
  is surfaced and the human decides the next move.*

So the supervised assertion in the test (§6) is: **`runOperator` is NOT called**, and the
delivery still returns `"delivered"`.

---

## 6. Test plan

New file: **`app/server/tasks/delivery-requeue.server.test.ts`** (the seam is
`performDelivery` in `task-actions.server.ts`; a dedicated file keeps the module-level
`vi.mock`s from disturbing the existing delivery/operator suites). Model the harness on
`app/server/tasks/operator-actions.server.test.ts` (store setup, `deployRoster`,
`baseTaskFrontmatter`) and the mock-and-assert pattern on
`app/server/github/pr-divergence-operator.server.test.ts`.

### 6.1 Mocks (module-level, hoisted)

```ts
// The re-trigger reaches runOperator via autoInvokeOperator's dynamic import — mock the
// downstream module (autoInvokeOperator is same-module as performDelivery, so mocking
// task-actions would NOT intercept the internal call). Keep every other export real so
// resetOperatorLeasesForTests etc. still work.
vi.mock("~/server/runtimes/operator-run.server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("~/server/runtimes/operator-run.server")>();
  return {
    ...mod,
    runOperator: vi.fn(async () => ({
      runId: null, queued: true, backend: "claude" as const, autonomy: "full" as const,
    })),
  };
});
import { runOperator } from "~/server/runtimes/operator-run.server";
const runOp = vi.mocked(runOperator);

// Drive performDelivery straight to `result.status === "ok"` without git/GitHub:
vi.mock("~/server/github/push-workspace.server", () => ({
  pushWorkspaceBranch: vi.fn(async () => ({ status: "pushed", branch: "vib-1-work" })),
}));
vi.mock("~/server/github/pr-open.server", () => ({
  openTaskPr: vi.fn(async () => ({ status: "ok", prNumber: 7, created: true, url: "http://x/pull/7" })),
}));
```

(Leave the delivering-engagement OFF the task so the post-push `reconcileWorkspaceDelivery`
block is skipped — `deliveringEngagement(fm)` is null, `task-actions.server.ts:3473-3489`.)

`beforeEach`: `resetOperatorLeasesForTests()`; `runOp.mockClear()`.

### 6.2 Deployment helpers

Reuse `deployRoster` but parameterize the operator definition's autonomy:
```ts
function deployOperator(autonomy: "full" | "supervised") {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...file.parsed.frontmatter,
    agents: [{
      profileId: "operator", capabilities: [{ capabilityId: "deliver-review-pr", mode: "direct" }],
      extras: [],
      definition: { kind: "operator", name: "Operator", backends: ["claude"], model: "sonnet", autonomy },
    }] as never,
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}
```
Confirm `resolveOperatorAuthority(...).autonomy` reads it: it flows through
`readAutonomy(definition)` (`operator-actions.server.ts:149-152, 254`).

### 6.3 Cases

**A. full-autonomy delivery enqueues exactly one follow-up operator run.**
```ts
deployOperator("full");
seedTask("impl");                 // no delivering engagement, no pr in fm
await performDelivery(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", OPERATOR_TASK_ACTOR);
await eventually(() => {          // autoInvokeOperator is fire-and-forget (void)
  expect(runOp).toHaveBeenCalledTimes(1);
});
const call = runOp.mock.calls[0]![1];
expect(call).toMatchObject({ projectSlug: store.slug, taskKey: "VIB-1", trigger: "delivered" });
```

**B. supervised delivery does NOT re-trigger, and still delivers.**
```ts
deployOperator("supervised");
seedTask("impl");
const outcome = await manualDeliverForReview(
  store.db, { projectSlug: store.slug, taskKey: "VIB-1" },
  { userId: store.users.arda.id, label: "arda@viberr.test" }, { dataRoot: store.dataRoot },
);
expect(outcome.status).toBe("delivered");
await new Promise((r) => setTimeout(r, 5));   // let any stray microtask flush
expect(runOp).not.toHaveBeenCalled();
```

**C. reuse (created:false) does not re-trigger even under full autonomy.**
Override the `openTaskPr` mock for this case to return `{ status: "ok", ..., created: false }`;
`deployOperator("full")`; assert `runOp` not called. (Guards the loop-prevention gate.)

**D. no operator deployed → no re-trigger, delivery still ok.**
Deploy a roster WITHOUT an operator; full path unreachable, `autoInvokeOperator` no-ops.
Assert `runOp` not called and `outcome.status === "delivered"`.

**E. (integration, optional but recommended) operator-authored full-autonomy delivery
queues behind its own drive.** In `operator-actions.server.test.ts` style with the real
runtime, drive an operator run that calls `deliver_for_review`; assert an operator
`agent_runs` row is created/queued for the follow-up. This exercises `ctx.operatorRun.autonomy`
as the gate source and the `queueOperatorTrigger` path (lease held → queued → fires on
release). Heavier; A–D cover the unit contract.

Use the `eventually(...)` helper already defined in `operator-run.server.test.ts:104-116`.

### 6.4 Canary (per house rule: revert the fix, watch the test fail)

Temporarily delete the §4.1 `if (result.created) { … }` block → case **A** must fail
(`runOp` never called). Restore.

---

## 7. Idempotency / traceability invariants checklist (I7)

| Risk | Guard |
| --- | --- |
| Re-trigger loops (deliver → operator → deliver → …) | `operatorDeliverForReview` no-ops on a live PR (`operator-actions.server.ts:1779-1788`); the re-triggered run never re-delivers. |
| Double-drive at settle (queued trigger + stranded backstop) | `releaseOperatorLease` fires the queued trigger and returns; `maybeResumeStrandedOperator` runs only on an empty queue (`operator-run.server.ts:348-356, 596-600`). |
| Runaway operator-authored chain | `nextTransitionChainDepth(ctx)` threaded; shared `OPERATOR_TRANSITION_CHAIN_CAP` (=8). |
| Duplicate on PR reuse / repeated manual delivery | gated on `result.created === true` only. |
| Firing with no operator | `autoInvokeOperator` returns early on `!authority.deployed`; gate also fails since not-deployed autonomy defaults `"supervised"`. |
| Redundant re-trigger if operator already engaged the reviewer in-turn | harmless — the re-triggered run sees `liveRuns` and stops (turn instruction §4.4 / generic rule `operator-run.server.ts:2209`). |

---

## 8. File / anchor index

- Seam: `app/server/tasks/task-actions.server.ts:3512` (inside `performDelivery`, `:3332`).
- Enqueue fn: `app/server/tasks/task-actions.server.ts:687` (`autoInvokeOperator`); its
  trigger union to widen at `:692`.
- Mirror call site: `app/server/tasks/task-actions.server.ts:3215` (transition re-trigger).
- Depth helper / cap: `app/server/tasks/task-actions.server.ts:126-130`, `:124`.
- Autonomy type + resolver: `app/server/tasks/operator-actions.server.ts:82`, `:149-152`,
  `:195-269`.
- Operator-authored delivery path: `app/server/tasks/operator-actions.server.ts:1762-1853`
  (gate `:1768`, live-PR no-op `:1779-1788`, `performDelivery` call `:1809`).
- Human delivery paths: `manualDeliverForReview` `:3621`; `applyRecommendation` delivery
  branch `:5479`.
- Trigger type + turn instruction: `app/server/runtimes/operator-run.server.ts:93-100`
  (union), `:2044` (`OperatorTrigger`), `:2097-2216` (`operatorTurnInstruction`; insert
  after `:2172`).
- Lease / queue / settle: `app/server/runtimes/operator-run.server.ts:683-719` (queue),
  `:339-368` (release), `:437-506` (stranded backstop), `:585-613` (settle).
- "Opened PR" human-visible event (supervised): `app/server/github/pr-open.server.ts:378-411`.
- Test models: `app/server/github/pr-divergence-operator.server.test.ts` (mock+assert the
  re-trigger); `app/server/tasks/operator-actions.server.test.ts:66-135` (store/roster
  harness); `app/server/runtimes/operator-run.server.test.ts:104-116` (`eventually`).
