# Pass 20 — Fix specifications

Implementation-ready specs for the pass-20 owner rulings (R20-1…R20-4) and the smaller
dispositioned items. Every file/line anchor below was verified against the tree at
`HEAD b97ad02`. Line numbers are the pre-change anchors — read the surrounding comment
block before editing; several of them carry the rationale for the code being changed.

Binding conventions: [`docs/architecture/decisions.md`](../../docs/architecture/decisions.md).
Rulings cited by number are that file's numbering.

**Where a ruling left latitude, this document picks and justifies.** Nothing here is
"decide at implementation time". The four judgement calls are flagged **CHOICE** with the
rejected alternative and the convention that decided it.

---

## Spec 1 — R20-1: failure-packet recovery semantics (F20-5)

### 1.0 Current behavior, traced

| Concern | Where it lives today |
| --- | --- |
| The failure packet is opened | `escalateFailedOperatorRun`, `app/server/runtimes/operator-run.server.ts:2093-2145` (log line `"real operator run failed — escalating"` at `:2111`; `operatorOpenPacket` call at `:2117`) |
| Its options come from | `defaultPacketOptions("blocked")`, `app/server/runtimes/operator-run.server.ts:1363-1390` — three options: `block_on_policy` "Update the policy / credential and unblock" (recommended), `redirect`, `hold_runtime_debug` |
| Sibling failure packet ("Work stalled") | `openStuckLoopPacket`, `app/server/tasks/task-actions.server.ts:1544-1610`; SIGNAL observation at `:1578` |
| One-packet-at-a-time guard | `operatorOpenPacket`, `app/server/tasks/operator-actions.server.ts:891-898` |
| Confirm/resolve intent lands | route `case "resolve-packet"`, `app/routes/project.task.tsx:403-460` → `resolvePacket`, `app/server/tasks/task-actions.server.ts:4467-5027` |
| "hold on policy" decision text | `app/server/tasks/task-actions.server.ts:4696-4703` (`case "block_on_policy"`) |
| "hold for runtime debug" text | `app/server/tasks/task-actions.server.ts:4712-4719` |
| Packet cleared? | `clearPacket` local, `:4527`; applied at `:4842`. **`block_on_policy` and `hold_runtime_debug` never set it** — that is the repeat-confirm bug |
| Repeat-confirm refusal (already present for clearing kinds) | `:4485-4487` (pre-read) and `:4829-4840` (in-lock, incl. the identity check) |
| Operator re-queue after resolve | `:4889-4924` — fires only for `request_edit \| redirect \| custom` |
| Deep-nav to settings | `app/routes/project.task.tsx:455-458` (`navigateTo: /projects/<slug>/settings`) and its toast at `:428-429` |
| "Run operator" control | `OperatorRunControl`, `app/features/task-detail/execution-profile.tsx:596-678`; mounted at `:829-838`; submits `intent=run-operator` from `app/features/task-detail/task-main-sections.tsx:536`; server at `app/routes/project.task.tsx:740-796` |
| `runOperator` refusal precedent | `RunOperatorResult.refused`, `app/server/runtimes/operator-run.server.ts:178-185`; the terminal-stage refusal at `:903-958` |

### 1.1 Resolution semantics — every option resolves

In `resolvePacket` (`task-actions.server.ts`):

- `case "block_on_policy"` (`:4696-4711`): set `clearPacket = true`.
- `case "hold_runtime_debug"` (`:4712-4722`): set `clearPacket = true`.
- `case "edit_goal"` (`:4723-4744`) keeps its packet by design (it clears when the edited
  goal lands, `updateTaskGoal`). To satisfy R20-1's *"no further confirms accepted"*
  without breaking that contract, add a **pre-read refusal** immediately after the
  `option` lookup at `:4491`:

  ```ts
  // R20-1: a packet that has already recorded a decision accepts no second one.
  // `edit_goal` is the only kind that keeps its packet open (it clears when the
  // edited goal lands); the stamp is what makes it un-re-confirmable.
  if (packet.awaiting) {
    throw AppError.conflict(
      `This decision was already made on ${input.taskKey} — the packet is waiting for the edited goal. ` +
        `Save the goal to clear it.`,
    );
  }
  ```

  `AppError.conflict` is a 409 (`app/server/errors/`), which is the "409-style" the ruling
  asks for and matches the two existing already-resolved refusals verbatim in shape.

Consequence, no extra code: with `clearPacket` true for every non-`edit_goal` kind, a
second confirm hits the existing `:4485` ("This packet was already resolved.") or, if it
races inside the lock, `:4831`. **Do not add a third refusal path** — those two are the
contract and are already tested.

`stillAwaitingHuman` at `:4878-4882` collapses to `option.kind !== "edit_goal"`. Keep the
B-WF2 comment but rewrite it: holds no longer keep their packet, so the approval is
consumed on every settled decision.

### 1.2 The hold options: labels that say what happens

**CHOICE.** `block_on_policy`'s label ("…and unblock") and its recorded effect ("hold …
stays blocked") disagree. R20-1 requires the label to be true *and* requires a re-queue.
Two ways to reconcile: rename the label to "Hold", or make the effect match the label.
**Pick: make the effect match the label** — on a *failure* packet the whole point is that
the operator's run died and no coordination happened, so "I fixed the credential, carry
on" is the recovery the human actually means, and the re-queue R20-1 mandates only makes
sense against that reading. Renaming to "Hold" would produce an option that resolves the
packet, re-queues the operator, and claims to be a hold — a worse mismatch.

`case "block_on_policy"` (`:4696-4711`) becomes:

```ts
case "block_on_policy": {
  // R20-1: the label promises an UNBLOCK, so this records one. It used to
  // record "hold on policy … stays blocked", leave the packet open, and
  // re-accept the same confirm forever (F20-5).
  event = {
    occurredAt: now,
    type: "transition",
    actor: human,
    title: null,
    text:
      option.ev ??
      `**Decision:** policy / credential updated. ${key} is unblocked and the operator ` +
        `re-runs to re-check. If it is still blocked, a new decision packet is opened.`,
    toAgent: false,
    evidence: null,
  };
  mutate = (fm) => {
    fm.readiness = "ready";
    fm.waiting = "agent";
    // B-WF2 stands: `validation` has ONE writer (deriveValidation) — a policy
    // decision never touches review health.
  };
  clearPacket = true;
  break;
}
```

`defaultPacketOptions("blocked")` (`operator-run.server.ts:1371-1376`) becomes:

```ts
[
  {
    kind: "block_on_policy",
    title: "I've updated the policy / credential — unblock and re-run",
    detail: "Closes this decision and starts a fresh operator run. If it fails again you get a new decision packet.",
    recommended: true,
  },
  {
    kind: "redirect",
    title: "Redirect the specialist with new guidance",
    detail: "Closes this decision and re-runs the operator with your note as its steer.",
  },
  {
    kind: "hold_runtime_debug",
    title: "Hold — pause coordination while I inspect the session",
    detail: "Closes this decision and starts NO run. The task stays blocked and waiting on you; use Run operator when you are ready.",
  },
]
```

`hold_runtime_debug` keeps its `mutate` (`readiness = "blocked"`) and additionally sets
`fm.waiting = "human"` so the task stays on the board's "Blocked or waiting" filter
(ruling 36 / R16-2) now that the packet no longer holds that position. Its recorded text
(`:4718`) gains the same honesty: *"…coordination is paused and no operator run was
started — use **Run operator** on the task page when the inspection is done."*

### 1.3 The re-queue

**CHOICE.** Add a new trigger rather than reusing `"transition"`. The three send-back kinds
already re-queue with `trigger: "transition"` (`:4922`) — a lie: nothing moved stages, and
`turnInstruction` for `transition` narrates a stage move. `RunOperatorInput["trigger"]`
(`operator-run.server.ts:119-127`) is a documented vocabulary where each value shapes the
turn; a fourth meaning smuggled into `transition` is exactly the class of drift ruling 44
exists to stop.

1. Add `"packet-resolved"` to the `trigger` union at `operator-run.server.ts:119-127`
   with a doc line in the same block-comment style (`:102-118`):
   *"packet-resolved → PROCEED: a human just answered your decision packet. The decision
   and their note are in the turn instruction; act on it. Never re-open the packet you were
   just answered on — if the same condition still blocks you, say so in ONE typed event or
   open a packet that names the NEW information."*
2. Add the trigger to `autoInvokeOperator`'s union
   (`task-actions.server.ts:602`) plus two optional fields it forwards —
   `resolvedOption: { kind: PacketOptionKind; title: string; note?: string }`.
3. Thread it into the turn instruction: `turnInstruction`/`agentReportBlock` in
   `operator-run.server.ts:2507-2733` (the `OperatorTrigger` switch at `:2543` / `:2681` /
   `:2712`) gain a `packet-resolved` arm.
4. In `resolvePacket`, replace the `sentBackToAgent` gate (`:4889-4892`) with:

   ```ts
   // R20-1: EVERY settled decision hands the task back to the operator, not just
   // the three send-back kinds. The exceptions are the options that end the
   // task's coordination or start their own run.
   const NO_REQUEUE: PacketOptionKind[] = [
     "accept_completion",   // the task is Done
     "archive_task",        // the task left the board
     "edit_goal",           // the packet is still open, awaiting the goal
     "hold_runtime_debug",  // the human explicitly asked for no run (§1.2)
     "retry_other_backend", // starts a specialist run below; its completion re-invokes
     "discard_branch",      // §2.4 — cleanup only, no coordination change
   ];
   const requeue = !NO_REQUEUE.includes(option.kind);
   ```

   The R15-14 `answerAskingAgent` branch (`:4894-4923`) is unchanged and still runs FIRST
   for `request_edit | redirect | custom`; only its fallback (and the new kinds) use
   `autoInvokeOperator(..., "packet-resolved", …)`.

**Loop bound.** The re-queue is human-gated by construction (a human confirmed), and a
re-failure opens a NEW packet via `escalateFailedOperatorRun` → `operatorOpenPacket`, which
now succeeds because §1.1 cleared the old one. No new cap is needed: the existing
`OPERATOR_TRANSITION_CHAIN_CAP` covers machine chains and this chain always has a human in
it. Do **not** add a suppression heuristic — R20-1 explicitly wants the fresh decision
record.

### 1.4 Drop the deep-navigation

Delete the `navigateTo` block at `app/routes/project.task.tsx:455-458` and change the
`block_on_policy` toast at `:428-429` to
`"Unblocked · operator re-running to re-check"`.

**Rationale (CHOICE: drop, not "open settings in context").** The option no longer means
"go edit the policy" — it means "I already did; carry on". Teleporting off the task at the
exact moment a run starts hides the thing the human is waiting for. The precedent is
UX19-4 (`app/features/task-detail/decision-packet.tsx:319-355`): the app names a control
and leaves the reader where they are rather than moving them. Where the human still needs
settings, the option `detail` and the packet body should link by name; a route-level link
in the packet body is already supported (`renderInlineCode` passes text through, and the
timeline renderer handles markdown links).

Check `app/features/task-detail/task-detail-hooks.ts` for the `navigateTo` consumer and
remove the now-dead branch if `block_on_policy` was its only producer (grep
`navigateTo` — `edit_goal`'s `goalDraft` is a separate field and stays).

### 1.5 Refuse "Run operator" while a packet is open

**Server** (`app/server/runtimes/operator-run.server.ts`):

- Widen `RunOperatorResult.refused` (`:185`) to `"terminal-stage" | "open-packet"`, with a
  doc line in the same style.
- Immediately after the terminal-stage block (`:903-958`, i.e. before the single-flight
  lease check at `:966`), add:

  ```ts
  // R20-1 (F20-5): a HUMAN-pressed "Run operator" while a decision packet is
  // open is a paid no-op — coordination is paused by the packet, so the run
  // completes several turns and can take no action (live: 6 turns / $0.27,
  // only get_task). Refuse it and say why. Scoped to `manual` on purpose:
  // machine triggers legitimately run with a packet open — `pr-diverged`
  // recovery WITHDRAWS a moot packet (ruling 17), and `agent-reply` reacts to
  // a run that was already in flight.
  if ((input.trigger ?? "manual") === "manual") {
    const open = readTaskFile(taskRef({ dataRoot: input.dataRoot }, input.projectSlug, input.taskKey))
      ?.parsed.packet ?? null;
    if (open) {
      logger.info("manual operator run refused — a decision packet is open", {
        taskKey: input.taskKey, packet: open.title,
      });
      return { runId: null, queued: false, backend, autonomy: authority.autonomy, refused: "open-packet" };
    }
  }
  ```

  Read via the same `readTaskFile` + ref idiom the terminal-stage block uses (`:922-931`).
  No `settleWaitingAfterOperator` call here: the packet already owns `waiting: "human"`.

**Route** (`app/routes/project.task.tsx:740-796`): after the `runOperator` call at `:773`,

```ts
if (started.refused === "open-packet") {
  return {
    ok: true as const,
    intent,
    toast: "Operator not started — resolve the open decision on this task first.",
  };
}
```

Placed before the `backendLabel` computation so no run is claimed.

**UI** (`app/features/task-detail/execution-profile.tsx`): `OperatorRunControl` gains a
`blockedReason?: string` prop. It follows the *existing* P14 pattern at `:669-675` (a
`title` is unreachable on a disabled control, so the reason is rendered copy):

- `const off = busy || disabled || !!blockedReason;`
- the `title` becomes `blockedReason ?? (disabled ? "Task is closed…" : "Run the operator…")`
- the rendered `<span className="sub">` at `:673-675` renders `blockedReason` when set,
  else the existing closed copy.

`ExecutionProfile` (`:680-…`) takes and forwards `packetOpen: boolean`; the task page
passes `packetOpen={!!task.packet}` where it renders `ExecutionProfile`
(`app/features/task-detail/task-detail-page.tsx`, alongside the other `task.*` props).
Copy: **"Open decision — resolve it before running the operator."**

### 1.6 Events, audit, copy

- No new audit action. `task.packet.resolved` (`:4859-4871`) already carries
  `optionKind`/`optionTitle`/`packetKind` — that is the ONE decision record R20-1 wants,
  and §1.1 guarantees exactly one per packet.
- Timeline: one event per resolution, unchanged in shape; only the `block_on_policy` and
  `hold_runtime_debug` text changes (§1.2).
- Copy changed: three default option titles + details (`operator-run.server.ts:1371-1376`),
  two decision sentences (`task-actions.server.ts:4700`, `:4718`), two toasts
  (`project.task.tsx:428-431`), one new run-refusal toast, one new run-button subline.

### 1.7 Tests

| File | What to add / adjust |
| --- | --- |
| `app/server/tasks/task-governance.server.test.ts` | `:832` pins the old "hold on policy" sentence — **update to the new unblock text**. Add: resolving `block_on_policy` clears the packet, sets `readiness: "ready"` / `waiting: "agent"`, and a second `resolvePacket` with the same index throws 409 "already resolved". Add the same repeat-confirm assertion for `hold_runtime_debug`. Add: an `edit_goal`-stamped packet refuses a second resolve with the "waiting for the edited goal" 409. |
| `app/features/task-detail/task-detail-route.server.test.ts` | `:354` pins the old sentence — update. Add: the `block_on_policy` action result carries **no** `navigateTo` and the new toast. |
| `app/server/tasks/delivery-requeue.server.test.ts` | The `autoInvokeOperator` mocking recipe lives here (`:21-40`, `:120-135` for the two-await flush). Reuse it for a new case: resolving `block_on_policy` invokes `runOperator` with `trigger: "packet-resolved"`; resolving `hold_runtime_debug` invokes it **not at all**. |
| `app/server/runtimes/operator-run.server.test.ts` | `refused: "open-packet"` for `trigger: "manual"` with a packet open; **not** refused for `trigger: "pr-diverged"` / `"agent-reply"` with the same packet open (this is the canary that protects ruling 17's recovery path). |
| `app/features/task-detail/task-disposition.test.tsx` | `:385-386` already asserts the Run-operator button is disabled for the closed task — add the sibling case: a task with an open packet renders the button disabled **and** the "Open decision — resolve it before running the operator." copy. |

**Canary each**: revert `clearPacket = true` and the double-resolve test must go red;
revert the `manual` scoping and the `pr-diverged` test must go red.

---

## Spec 2 — R20-2: no-change acceptance auto-detect (F20-6)

### 2.0 Current behavior, traced

- `noChangeApplies(fm)` — `app/server/tasks/no-change-completion.server.ts:52-56`:
  `fm.noChanges === true && !fm.pr`. **This is the gate that never fires for VIB-2.**
- `probeNothingToDeliver` — `:74-217`. Live remote proof; bases `no_repo` / `no_branch`
  (`GET git/ref/heads/<branch>` 404) / `branch_empty` (compare `aheadBy === 0`). Returns
  `has_work` with the commit count when the branch carries commits (`:182-192`).
  **VIB-2's branch was never pushed, so this probe answers `no_branch` — the machinery
  already works; only the entry condition is wrong.**
- `acceptanceNoChangeCheck` — `:237-268`. Short-circuits on `!noChangeApplies(fm)` at
  `:250-252` ("the ordinary PR path pays NOTHING").
- `assertVerifiedNoChangeStillApplies` — `:276-287` (in-lock re-assert).
- `noChangeCompletionEvent` — `:295-350` (the one shared event).
- The refusal the human actually saw: `verdictGateReason`,
  `app/server/github/pr-human-approval.server.ts:301-321` — the sentence is at **`:320`**.
- The four Done writers, all of which already call the check:
  `resolvePacket` accept arm (`task-actions.server.ts:4576`), the shared
  `applyAcceptanceWrite` (`:5515`), `acceptCompletion` (`:5644`), and `completeTaskMerge`
  (`:5872`, head-check only — it merges a live PR, so no-change cannot apply).
- No-change `workRevision` minting already exists on the DELIVERY path:
  `resolveNoChangeBaseRevision` used at `task-actions.server.ts:3596-3599`, written at
  `:3645-3647`.

### 2.1 Widen the entry condition (auto-detect)

In `no-change-completion.server.ts`:

```ts
/** The task has no pull request to merge — the only shape a "no changes"
 *  outcome can have. R20-2: the ACCEPT path probes on this alone, not on the
 *  agent's `noChanges` flag, because an envelope that forgot the flag left the
 *  server refusing with advice that would open an EMPTY PR (F20-6, VIB-2). */
export function noChangeCandidate(fm: Pick<TaskFrontmatter, "pr">): boolean {
  return !fm.pr;
}
```

`AcceptanceNoChangeCheck` (`:220-229`) gains one field:

```ts
/** R20-2: the frontmatter did NOT claim `noChanges` — the server proved it by
 *  probing the branch. Drives the disclosure and the frontmatter repair. */
autoDetected: boolean;
```

`acceptanceNoChangeCheck` (`:237-268`) becomes:

```ts
const claimed = noChangeApplies(fm);            // fm.noChanges === true && !fm.pr
if (!claimed && !noChangeCandidate(fm)) {
  return { applies: false, refusal: null, verification: null, branch: null, autoDetected: false };
}
const probe = await probeNothingToDeliver(db, ctx, projectSlug, taskKey);
if (probe.status === "verified") {
  return {
    applies: true, refusal: null,
    verification: probe.verification, branch: probe.verification.branch,
    autoDetected: !claimed,
  };
}
// R20-2: an UNCLAIMED task that the probe could not clear is simply not a
// no-change acceptance. It must NOT inherit the claimed path's fail-closed
// refusal — that would turn every PR-less accept attempt into a GitHub-outage
// refusal. It falls through to the ordinary gates, which refuse it for the
// right reason (§2.2). A CLAIMED task keeps the R19-8 fail-closed refusal
// exactly as it is.
if (!claimed) {
  return {
    applies: false, refusal: null, verification: null,
    branch: fm.branch, autoDetected: false,
    probe: probe.status,               // "has_work" | "unverifiable"
    probeRefusal: probe.refusal,       // carried for §2.2's copy
  };
}
return { applies: true, refusal: probe.refusal, verification: null, branch: fm.branch, autoDetected: false };
```

(`probe` / `probeRefusal` are two new optional fields on `AcceptanceNoChangeCheck`.)

`assertVerifiedNoChangeStillApplies` (`:276-287`) must re-assert against the predicate the
check actually used, or an auto-detected acceptance always throws:

```ts
const stillApplies = check.autoDetected ? noChangeCandidate(fm) : noChangeApplies(fm);
if (stillApplies === check.applies) return;
```

The refusal sentence is unchanged — for the auto-detected case it fires exactly when a PR
appeared during the await, which is precisely the state that must refuse.

**Cost note for the code comment:** the ordinary PR path still pays nothing (a task with a
PR fails `noChangeCandidate`). What newly pays is a PR-less acceptance attempt: two GitHub
reads on a rare, human-initiated action. That is the trade R20-2 buys.

### 2.2 What happens when the branch HAS commits (unchanged refusal, better words)

The refusal stays a refusal — a branch with commits cannot close as "no changes". Only the
sentence improves. In `acceptanceRefusalReason`
(`task-actions.server.ts:5081-5112`), thread the check through:

```ts
function acceptanceRefusalReason(
  project: ProjectContext,
  fm: TaskFrontmatter,
  taskKey: string,
  opts: { blockedPacket: boolean; noChange?: AcceptanceNoChangeCheck },
): string | null {
```

and insert, immediately before the `verdictGateReason` line at `:5103`:

```ts
// R20-2 / F20-6: when the live probe already looked at the branch, ITS sentence
// wins — it names the branch and the commit count. `verdictGateReason`'s
// "deliver the branch & open the PR" is right for a branch with work and was
// catastrophically wrong for an EMPTY one (it advised opening an empty PR); the
// empty case no longer reaches here at all (§2.1 routes it), and the has-work
// case now says how many commits.
(opts.noChange?.probe === "has_work" ? opts.noChange.probeRefusal ?? null : null) ??
```

All four `acceptanceRefusalReason` call sites (`:4548`, `:4568` via `headCheck`, `:5525`,
and the in-lock re-check at `:4867`/`:5519`) pass the check they already computed. Leave
`verdictGateReason` (`pr-human-approval.server.ts:302-321`) **pure and unchanged** — it has
no I/O and must keep none; the composition happens one level up.

### 2.3 The acceptance ceremony in the auto-detected case

`AcceptConfirm` already has a no-change arm — `app/features/task-detail/accept-confirm.tsx:84`
(`noChanges = false` prop), `:109` (type), `:232-245` (the "Nothing — **completed with no
changes**" body). It is fed from `app/routes/project.task.tsx:228` (`fm.noChanges === true`)
→ `:309` → `task-detail-page.tsx:122/184/699`.

In the auto-detected case that flag is **false at render time**, so the dialog would
promise a merge. **CHOICE: add a third arm rather than probing in the loader.** A remote
probe on every task-page load is unaffordable and would make page load depend on GitHub;
the honest alternative costs nothing and states exactly what the server will do.

- `project.task.tsx:228` additionally derives
  `const noPullRequest = !taskFile?.parsed.frontmatter.pr;` and passes it through `:309`
  and `task-detail-page.tsx:699` as `noPullRequest`.
- `accept-confirm.tsx` renders, when `!noChanges && noPullRequest`:

  > **Nothing to merge yet.** This task has no review pull request. Accepting re-checks
  > `<branch>` on GitHub: if it carries no commits the task closes as **completed with no
  > changes**; if it carries work the acceptance is refused and says how many commits.

  Keep the verdict/divergence disclosures (ruling 42 / R19-5) rendering unchanged around it.
- When the acceptance succeeds via auto-detect, the recorded event is the existing shared
  `noChangeCompletionEvent` (`no-change-completion.server.ts:295-350`) — **no new event
  type**. Add one clause to its `no_branch`/`branch_empty` prose when
  `input.autoDetected === true` (new optional input):
  *"The completion did not claim this; the server verified it at acceptance."*
  That is the R20-2 disclosure, and it keeps ruling 62's "a record may only state what the
  server actually did".

### 2.4 The frontmatter repair, and workRevision / verdict binding (R19-8)

In the Done write of every writer that takes the no-change arm — the shared
`applyAcceptanceWrite` mutate (`task-actions.server.ts:5518-5560`) and the packet arm's
`mutate` (`:4671-4699`) — add, inside the existing mutate:

```ts
// R20-2: the outcome the server PROVED becomes the durable record. Without
// this the task closes as "no changes" while its frontmatter still says
// otherwise, and every later reader (the rebuilder, deriveValidation, the
// pill) re-derives the pre-acceptance answer.
if (noChange.applies && noChange.autoDetected) fm.noChanges = true;
```

**The verdict gate is NOT relaxed, and no revision is minted here.** Ruling 62 (R19-8) says
a no-change completion passes the same gate as every other acceptance, and its subject —
the base-anchored `workRevision` — is minted on the DELIVERY path
(`task-actions.server.ts:3596-3599`, `:3645-3647`), not at acceptance. Minting a subject
and accepting against it in the same click would let the acceptance manufacture the very
thing that is supposed to gate it. So:

- A task that has a `workRevision` (kind `verified` or otherwise) passes
  `verdictGateReason` through its existing PR-less arm (`pr-human-approval.server.ts:310-319`
  — the `fm.noChanges || fm.workRevision.kind === "verified"` clause). §2.4's frontmatter
  repair happens *inside* the Done write, i.e. after the gate, so it cannot self-satisfy it
  either. **A task whose reviewers have approved its verification revision accepts cleanly —
  this is the VIB-2 path.**
- A task with **no** `workRevision` at all has nothing for a verdict to bind to;
  `verdictGateReason` returns null (`:310`) and `acceptanceBlockedReason(fm)` (`:5101`)
  governs. Unchanged. The remedy remains what R19-8 built: run the delivery path, which
  mints the base revision and records "Nothing to deliver".
- Say this explicitly in the code comment, because the tempting bug is to mint here.

### 2.5 The branch discard must actually execute

**CHOICE: a new packet-option kind, `discard_branch`.** Alternatives rejected:
`archive_task` + `deleteBranch` (archiving is a *disposition* that removes the task from
the board — it is not "complete this task with no changes"), and dispatching on the
operator's English title (ruling 7 forbids it outright, and that is exactly why the option
was unexecutable). Ruling 17's constraint — "remote-branch deletion exists only as that
packet resolution" — is **not** violated: this kind deletes only a LOCAL, never-pushed
workspace branch and refuses the moment the branch exists on the remote.

**Schema** — `app/schemas/task-file.schema.ts:68-88`, add after `archive_task`:

```ts
// R20-2 (F20-6): discard the task's LOCAL, never-pushed workspace branch —
// cleanup, not a disposition: the task stays on the board and closes through
// the ordinary no-change acceptance. Refuses when the branch exists on the
// remote; remote deletion stays ruling 17's archive-packet path. Resolution
// enforces `approve-transition` (it destroys commits).
"discard_branch",
```

Update ruling 7's count in `decisions.md` (nine → ten) in the same change — ruling 44
requires the canon file to record it.

**Git mechanics** — new export in `app/server/github/push-workspace.server.ts` (it already
owns `findWorkspaceRepoDir` at `:378`, the `Exec` seam at `:131-148`, and the redaction
idiom):

```ts
export type DiscardBranchOutcome =
  | { status: "deleted"; branch: string; sha: string }
  | { status: "not_found"; branch: string }
  | { status: "on_remote"; branch: string }      // refuse — ruling 17
  | { status: "no_workspace"; branch: string }
  | { status: "failed"; branch: string; reason: string };  // git's redacted words (ruling 69)

export async function discardLocalTaskBranch(input: {
  projectSlug: string; taskKey: string; branch: string; defaultBranch: string;
  dataRoot?: string; exec?: Exec;
}): Promise<DiscardBranchOutcome>;
```

Sequence: `findWorkspaceRepoDir` → `no_workspace` if absent; `git rev-parse --verify
refs/heads/<branch>` → `not_found`; `git ls-remote --exit-code --heads origin <branch>` →
`on_remote` (exit 0 means it is pushed); `git rev-parse HEAD` on the branch (recorded in
the audit); `git checkout <defaultBranch>` when HEAD is on the branch; `git branch -D
<branch>`. Every failure carries `redactGitOutput(gitErrorText(err))`
(`app/server/secrets/git-output-redact.server.ts:77` / `:120`) — ruling 69.

**Resolution** — in `resolvePacket`, a new case beside `archive_task` (`:4763-…`):

```ts
case "discard_branch": {
  // Destroys commits, so the same tier archive-with-branch-deletion requires.
  requireAction(db, project, actor, "approve-transition", "discard this task's branch");
  event = {
    occurredAt: now, type: "transition", actor: human, title: null,
    text: option.ev ?? `**Decision:** ${option.t}. The task's local workspace branch is discarded.`,
    toAgent: false, evidence: null,
  };
  mutate = () => {};   // the frontmatter edit happens after the git work, below
  clearPacket = true;
  break;
}
```

and, after the resolution write (beside the `archive_task` block at `:4933-4978`):

```ts
if (option.kind === "discard_branch") {
  const outcome = await discardLocalTaskBranch({ ... });
  // Clear fm.branch only when it named the branch we really deleted.
  if (outcome.status === "deleted") {
    await updateTaskFile(..., (parsed) => {
      if (parsed.frontmatter.branch === outcome.branch) parsed.frontmatter.branch = null;
      parsed.timeline.unshift({ type: "note", ..., text:
        `Branch \`${outcome.branch}\` (\`${outcome.sha.slice(0, 12)}\`) was deleted from this task's ` +
        `workspace. It existed only there — nothing was pushed to GitHub, so nothing on the remote changed.` });
    });
    reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  } else { /* one honest timeline note per non-deleted status, same shape as :4950-4959 */ }
}
```

**Audit**: `recordAudit({ action: "task.branch.discarded", subjectKind: "task",
subjectId: taskKey, details: { branch, sha, basis: "local_only" } })` on `deleted`, and
`action: "task.branch.discard_refused"` with `{ branch, status }` otherwise. Best-effort
like the archive cleanup: a failed discard never un-resolves the packet.

**Confirm dialog**: `decision-packet.tsx` currently routes `archive_task` through
`PacketArchiveConfirm` (`:122-266`, raised at `:594-597`, rendered at `:617-630`). Add a
sibling `PacketDiscardConfirm` in the same file with the same local-dialog rationale
(UX19-9's comment at `:102-121` — one surface, so no shared provider). Its body states:
the branch name, the sha, that only the workspace copy is deleted, that nothing on GitHub
changes, and that this cannot be undone. Route it from the same `onClick` guard:
`if (selected?.kind === "archive_task" || selected?.kind === "discard_branch")`.
Add `canDiscardBranch` alongside `canArchive` (same `approve-transition` predicate) so the
option is blocked-with-reason for a lower tier, exactly like `archiveBlocked` at `:455`.

**Operator authoring**: add `discard_branch` to the `open_packet` guidance string at
`operator-run.server.ts:2703`, phrased so the model offers it only for a never-pushed
branch: *"`discard_branch` to delete the task's LOCAL workspace branch when nothing was
ever pushed — the human's confirm executes it."*

**No task-page control.** R20-2 offered "confirm-executes OR a task-page control"; pick
confirm-executes. It closes the exact hole F20-6 found (the operator's own option was
inert), needs no new surface, and keeps ruling 30's rule that a control must not name an
outcome its surface cannot promise.

### 2.6 Tests

| File | What to add |
| --- | --- |
| `app/server/tasks/no-change-completion.server.test.ts` | `noChangeCandidate`; `acceptanceNoChangeCheck` with `noChanges` **absent** + a 404 branch ref → `{applies:true, autoDetected:true, basis:"no_branch"}`; with commits ahead → `{applies:false, probe:"has_work"}` carrying the counted sentence; with GitHub unreachable and no flag → `{applies:false}` (no inherited refusal); with the flag set and GitHub unreachable → refusal, **unchanged** (this is the R19-8 canary). |
| `app/server/tasks/no-change-acceptance.server.test.ts` | End-to-end: a task with no PR, an empty branch, a healthy verdict on its verification revision accepts to Done with the shared "Completed — no changes" event; `fm.noChanges` is `true` afterwards; a task with 3 commits and no PR refuses with the counted sentence and stays put. |
| `app/server/tasks/task-governance.server.test.ts` | `discard_branch` resolution: 403 below `approve-transition`; `deleted` path clears `fm.branch`, writes the note + `task.branch.discarded`; `on_remote` refuses and writes the honest note; the packet resolves in every case. |
| `app/server/github/push-workspace.server.test.ts` | `discardLocalTaskBranch` against a real temp git repo (the module's tests already exercise `defaultExec`, `:148`): deleted / not_found / on_remote (with a bare remote) / failed-with-redacted-stderr. |
| `app/features/task-detail/accept-confirm.test.tsx` | The third arm renders for `noChanges=false, noPullRequest=true`, and does **not** claim a merge. |
| `app/features/task-detail/task-detail-components.test.tsx` | `discard_branch` option renders its confirm dialog before submitting, and is blocked-with-reason without `canDiscardBranch`. |
| `app/schemas/task-file.schema.test.ts` | `discard_branch` parses; an unknown kind still rejects. |

---

## Spec 3 — R20-3: provider error surfacing + model availability (F20-4)

### 3a. Extend ruling 69 to the Claude/Codex spawn/run error pipe

**Where the provider's words die today:**

| File:line | What it drops |
| --- | --- |
| `app/server/runtimes/codex-runtime.server.ts:311-315` | `safeCodexError` replaces the error with a bare `"Codex SDK/CLI execution failed."` for the logger |
| `:346-391` | `classifyCodexFailure` reads `raw` (up to 3 `cause` levels, `:359-371`) and returns only `{kind, message}`; the generic arm at `:386-390` is the sentence F20-4 quotes |
| `:466-486` | `emitAdapterFailure(message, kind)` persists that generic sentence as the terminal `err` line |
| `app/server/runtimes/claude-runtime.server.ts:393-441` | `classifyClaudeError`, same shape; sites `:495-514` (`settleError`) and `:760-782` (`is_error` result) |
| `app/server/tasks/agent-reply.server.ts:548-584` | `runFailureReason` returns that generic text as `.text` |
| `app/server/tasks/task-actions.server.ts:2372-2376` | clamps `.text` to **180** chars |
| `:2398` | builds `` `${backendLabel} run failed: ${failText}` `` — the double-generic sentence |
| `:1578` | `{ k: "Signal", v: input.reason }` — where it lands on the packet |
| `app/server/runtimes/operator-run.server.ts:2100-2110` | the operator's own escalation builds `detail` from `reason?.kind` and **drops `reason.text` entirely** |

**The change.** Ruling 69's argument transfers verbatim: the credential never lives in
argv (Codex gets it via `CodexOptions.apiKey`/env, Claude via `claudeSpawnEnv`), so a
value+shape scrub plus control-character stripping makes the text safe.
`redactGitOutput` (`app/server/secrets/git-output-redact.server.ts:77-113`) is already the
shared child-process scrubber and is already used for exactly this purpose by R19-17
(`resources.server.ts:869-874`).

1. **New shared helper**, `app/server/secrets/git-output-redact.server.ts`:

   ```ts
   /** R20-3: one redacted SENTENCE from a provider failure, for a packet line,
    *  a timeline block and a log field. `redactGitOutput` clamps to 8 lines /
    *  600 chars; a provider's own complaint is one sentence, and the consumers
    *  (packet observation, 240-char delivery-reason convention from ruling 69)
    *  want it shorter still. */
   export const PROVIDER_TEXT_CHARS = 240;
   export function redactProviderText(raw: unknown, token?: string | null): string;
   ```

   Implementation: coerce (walking `cause` like `classifyCodexFailure:359-371`),
   `redactGitOutput(text, { token })`, keep the LAST non-empty line, clamp to
   `PROVIDER_TEXT_CHARS` from the end (the verdict is at the tail — same reasoning as
   `:108-112`).

2. **Both classifiers** return a third field:
   - `classifyCodexFailure` (`codex-runtime.server.ts:346`) →
     `{ kind, message, providerText: redactProviderText(error) }`.
   - `classifyClaudeError` (`claude-runtime.server.ts:393`) → same. Its three
     early-return arms (`EBADF/EMFILE/ENFILE` `:398`, `ENOENT` `:405`, session-missing
     `:419`) carry `providerText: ""` — those messages already name the real cause.
3. **Both emitters** append it to the persisted `err` line's text, once, when it is
   non-empty and not already a substring of `message`:
   `` `${message}\n\nThe provider reported: ${providerText}` ``
   — `codex-runtime.server.ts:466-486` (`emitAdapterFailure` gains a third parameter, and
   both call sites `:616` / `:634` pass it), and `claude-runtime.server.ts:504-509` /
   `:776-781`. The `·<kind>` tag suffix is untouched: it is the routing signal and must not
   start depending on prose (the whole point of `agent-reply.server.ts:557-566`).
4. **`safeCodexError`** (`:311-315`): keep the class-only Error, but stop discarding the
   text — set `safe.message = redactProviderText(error) || "Codex SDK/CLI execution failed."`.
   Ruling 69 already settled that a scrubbed provider complaint is loggable.
5. **Raise the clamp** at `task-actions.server.ts:2372-2376` from 180 to
   `PROVIDER_TEXT_CHARS` (240) so the provider sentence survives into `reasonText`.
6. **The packet gets its own line, not just a longer SIGNAL.** `openStuckLoopPacket`
   (`:1544-1610`) gains an optional `providerText` input and, when present, a second
   observation after the Signal at `:1578`:
   `{ k: "Provider said", v: providerText, code: true }`.
   The failure branch at `:2368-2463` passes `failure?.providerText` — which means
   `runFailureReason` (`agent-reply.server.ts:548-584`) must return it. It parses the err
   line already; split on the `"\n\nThe provider reported: "` marker and return
   `{ kind, text, providerText }`. (Keep `text` as the human sentence so every existing
   caller is unaffected.)
7. **The timeline event** at `task-actions.server.ts:2401-2417` gains a fenced block in the
   R19-13 house style when `providerText` is present:

   ```
   What the provider reported:
   ```
   <providerText>
   ```
   ```
8. **The operator's own escalation** — `escalateFailedOperatorRun`
   (`operator-run.server.ts:2093-2145`): append `reason.providerText` to the packet `body`
   (`:2124-2128`) and add the same `{ k: "Provider said" }` observation via a new
   `observations` input on that `operatorOpenPacket` call. This is the exact packet F20-4
   photographed.

### 3b. Model availability

**CHOICE: mark-on-first-400, with no new probe.** R20-3 permits "probe at save or first
failure". Rejected probe-at-save because Codex — the backend that produced F20-4 — has no
list endpoint at all (stated at `model-catalog.server.ts:100-107`), so a save-time probe
would have to spawn a real billable one-token run on every profile save and would still
only prove that instant. Ruling 19 ("chips render proven verdicts only … `assumed` renders
as an honest 'unproven' line, never as a pseudo-check") decides it: a mark earned from a
REAL run is evidence; a synthetic tick is the pseudo-check that ruling bans. Claude already
gets a genuine live list via `supportedModels()` (`:414-436`), which is the real probe where
one exists.

**Storage** — `db/migrations/0001_baseline.sql` (the tree has exactly one migration; the
pre-prod squash convention holds). Add beside `org_mcp_servers` (`:256-276`):

```sql
-- R20-3 (F20-4): a model the PROVIDER refused for this deployment's account.
-- Org-level (unscoped, like org_mcp_servers): the credential is a deployment
-- fact, not a project one. Written only from a REAL run's failure; cleared by a
-- real run's success. Never written by a synthetic probe (ruling 19).
CREATE TABLE model_availability (
  backend    TEXT NOT NULL CHECK (backend IN ('claude','codex')),
  model      TEXT NOT NULL,
  reason     TEXT NOT NULL,        -- the provider's own redacted sentence
  marked_at  TEXT NOT NULL,
  run_id     TEXT,                 -- the run that proved it
  PRIMARY KEY (backend, model)
);
```

Presence of a row = unavailable. Absence = unknown-but-offered (honest: never "proven
available", which is the claim we cannot make).

**New module** `app/server/runtimes/model-availability.server.ts`:

```ts
export function markModelUnavailable(db, input: { backend: RealBackend; model: string; reason: string; runId?: string }): void;
export function clearModelMark(db, backend: RealBackend, model: string): void;
export function unavailableModels(db, backend: RealBackend): Map<string, { reason: string; markedAt: string }>;

/** The provider sentences that mean "this account cannot use this model" — as
 *  opposed to quota, auth, or a crash. Anchored on the live F20-4 text:
 *  400 invalid_request_error "The 'gpt-5.6-sol' model is not supported when
 *  using Codex with a ChatGPT account." */
export const MODEL_UNSUPPORTED_RE =
  /model is not supported|model .*(?:does not exist|not found|unavailable)|unknown model|invalid model/i;

/** Called from the two run-failure choke points. No-op unless the provider text
 *  matches and names a model we actually asked for. */
export function noteModelAvailabilityFromFailure(
  db, input: { runId: string; backend: RealBackend; model: string | null; providerText: string },
): void;
```

**Wiring:**
- Failure: `task-actions.server.ts:2368-2463` (specialist/reviewer) and
  `operator-run.server.ts:2093-2145` (operator) — both already hold the run row and the
  classified failure; call `noteModelAvailabilityFromFailure` with the run's `model`
  (column `agent_runs.model`, set at `startRun` — `operator-run.server.ts:1436`).
- Clearing: the success branch — `task-actions.server.ts` `if (finished.state ===
  "finished")` at `:2469` and the operator's `chainRunCompletion` non-error arm
  (`operator-run.server.ts:2062-2068`) — call `clearModelMark(db, backend, run.model)`.
  A model that just ran is available, whatever a stale row says. **This is the re-probe:
  no separate mechanism.**

**Catalog rendering** — `model-catalog.server.ts`:
- `CatalogModel` (`:42-51`) gains
  `unavailable?: { reason: string; markedAt: string }`.
- `getModelCatalog` (`:450-482`) gains an optional `db` in `CatalogDeps`; after building
  the catalog (curated or live), stamp each model from `unavailableModels(db, backend)`.
  The SQL read is per-request and the in-process `LIVE_TTL_MS` cache
  (`:461-465`) is **not** allowed to carry the mark — apply the stamp *after*
  `cloneCatalog`, so a mark that changes takes effect on the next page load with no cache
  invalidation. State that in the comment; it is why no `resetModelCatalogCache()` call is
  needed.
- `app/routes/resources.model-catalog.ts:19-25`: pass the db (`getDb()` the way sibling
  resource routes do).
- `isKnownModel` / `resolveRunModel` (`:207-232`) are **unchanged**: they validate *ids*,
  not availability. Silently substituting a different model for a marked one would be the
  exact dishonesty P13-RT-07's comment (`:187-206`) describes.

**Profile editor** — `app/features/agents/create-profile-modal.tsx`:
- Mirror the field on the client `CatalogModel` (`:58-65`).
- The `<option>` map at `:404-408`:
  `disabled={!!m.unavailable}` and label
  `` {m.displayName}{m.unavailable ? " — unavailable on this deployment" : ""} ``.
- The already-present "preserve a seeded value not in the catalog" branch (`:398-404`) keeps
  a stored-but-marked model selectable so an existing profile is never silently rewritten.
- The description slot at `:409-413` renders the provider's sentence for a marked selection:
  *"The provider refused this model for this deployment's account: `<reason>` (recorded
  \<relative time\>). It clears automatically the next time a run on it succeeds."*
- The default-picker effect at `:983-990` must not auto-select a marked model: prefer the
  first unmarked model, falling back to `catalog.defaultModel`.

**Agents page badge** — `app/features/agents/agents-query.server.ts:303` already computes
`modelKnown`; add `modelUnavailable: unavailableModels(db, primaryBackend).has(model)` and
render it beside the existing unknown-model badge in `agents-page.tsx`.

### 3c. Tests

| File | What to add |
| --- | --- |
| `app/server/secrets/git-output-redact.server.test.ts` | `redactProviderText`: keeps the provider sentence, strips a token by value and by shape, clamps to 240 from the tail, returns `""` for empty. |
| `app/server/runtimes/codex-runtime.server.test.ts` | `:508` and `:742` pin the exact generic sentences — **update** to assert the sentence **plus** `"The provider reported: …"` carrying the 400 text; add a case whose raw error contains a token-shaped string and assert it is `[redacted]` in the persisted line. |
| `app/server/runtimes/claude-runtime.server.test.ts` | Same two assertions for `settleError` and the `is_error`-result path (`:585` already builds a classifiable error). |
| `app/server/tasks/agent-reply.server.test.ts` | `runFailureReason` (`:676-710`) returns `providerText` split off the marker, and `.text` unchanged for callers. |
| `app/server/tasks/task-actions.server.test.ts` / `task-governance.server.test.ts` | The stalled-work packet carries a `Provider said` observation and the fenced timeline block; the 240 clamp is exercised by an over-long provider sentence. |
| `app/server/runtimes/operator-run.server.test.ts` | The operator's own failure packet body names the provider sentence (the F20-4 repro, as a unit test). |
| **new** `app/server/runtimes/model-availability.server.test.ts` | `MODEL_UNSUPPORTED_RE` matches the live F20-4 sentence and does **not** match quota/auth text; mark → `unavailableModels` → clear-on-success round trip. |
| `app/server/runtimes/model-catalog.server.test.ts` | A marked model is stamped in both the curated and the live-enhanced catalog; the mark survives `cloneCatalog`; the TTL cache does not freeze it. |
| `app/features/agents/model-catalog-route.server.test.ts` | The route payload carries `unavailable`. |
| `app/features/agents/agents-page.test.tsx` | The picker disables a marked model, keeps a stored marked model selectable, and shows the provider's reason. |

---

## Spec 4 — R20-4: npx first-run warm-up (N20-2)

### 4.0 Current behavior, traced

- `discoverStdioMcpTools` — `app/server/org/resources.server.ts:811-…`; timeout default
  20 s at `:826`; the timer arm at `:898-909` sets `installing: true` **only** when
  `INSTALLING_RE` (`:896-897`) matches the captured stderr. `npx -y` printed nothing
  matching, so the row said `unreachable · timed out after 20s`.
- `StdioDiscovery` shape — `:774-782`.
- The two `warmable` consumers — `saveMcpServer` at `:1279-1282` (+ the start at
  `:1347-1353`) and `testMcpServer` at `:1406-1417`.
- Warm-up runner — `app/server/org/mcp-warmup.server.ts`: `WARMUP_CAP_MS` 15 min (`:35`),
  in-process `inFlight` set (`:38`), `markWarming` (`:50-54`), settle writes (`:83-108`),
  boot reaper `reapStaleWarmups` (`:129-145`, wired in `app/server/boot.server.ts`).
- Row columns — `db/migrations/0001_baseline.sql:256-276` (`warming_since` `:269`,
  `last_error` `:273`). **There is no record of a prior success**, which is why
  "first-ever" needs a definition.
- UI — `app/features/org-settings/resource-rows.tsx:183` / `:200` / `:218-225` / `:257`;
  polling in `resources-panel.tsx:103-113`.

### 4.1 Define "first-ever" (new columns)

Add to `org_mcp_servers` in `db/migrations/0001_baseline.sql`:

```sql
  -- R20-4: when this server first answered a probe successfully. NULL means it
  -- has never worked here — which is what makes a timeout on an npx/uvx-style
  -- command a plausible first-run INSTALL rather than a broken server.
  first_success_at TEXT,
  -- R20-4: how many times the HEURISTIC (stderr said nothing install-y, but the
  -- command is an installer and the row has never succeeded) armed a background
  -- warm-up. Capped at 1 so a command that times out on EVERY probe still
  -- settles to `unreachable` instead of re-downloading forever — the terminal
  -- condition R19-17c's honesty depends on.
  heuristic_warmups INTEGER NOT NULL DEFAULT 0,
```

**First-ever** = the row does not exist yet (the `saveMcpServer` insert path probes before
inserting) **or** `first_success_at IS NULL`.

Set `first_success_at` on every success write, idempotently:
`SET ... first_success_at = COALESCE(first_success_at, ?)` at
`resources.server.ts:1388-1393`, `:1305-1315` (the update-with-probe path), and
`mcp-warmup.server.ts:86-91`. The insert at `:1333-1337` sets it to `now` when
`disc.kind === "up"`, else NULL.

### 4.2 Recognize an installer command

New export in `resources.server.ts`, beside `splitMcpCommand` (`:793-801`):

```ts
/** R20-4: package-manager runners that FETCH on first use. `uvx` announces
 *  itself on stderr and is already handled by INSTALLING_RE; `npx`/`bunx`/the
 *  `dlx` family are silent while npm resolves, which is exactly the N20-2 gap.
 *  Matched on argv — never on the raw string — so `my-server --npx-mode` is not
 *  a false positive. Exported for its test. */
export function isFirstRunInstallerCommand(argv: string[]): boolean {
  const bin = (argv[0] ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const next = (argv[1] ?? "").toLowerCase();
  if (["npx", "bunx", "uvx", "pipx"].includes(bin)) return true;
  if (["pnpm", "yarn", "bun"].includes(bin) && (next === "dlx" || next === "x")) return true;
  if (bin === "uv" && next === "tool") return true;
  return false;
}
```

`StdioDiscovery`'s `down` arm (`:774-782`) gains:

```ts
/** R20-4: the TIMEOUT fired on a command that fetches on first use, but the
 *  command printed nothing install-y. Only the CALLER can decide whether this
 *  is a first run (it holds the row), so the probe reports the shape and
 *  stays DB-free. */
firstRunInstaller?: boolean;
```

set in the timer arm (`:898-909`):

```ts
const installing = INSTALLING_RE.test(stderr);
const firstRunInstaller = !installing && isFirstRunInstallerCommand(parts);
finish({
  kind: "down",
  ...(installing ? { installing: true } : {}),
  ...(firstRunInstaller ? { firstRunInstaller: true } : {}),
  reason: withDetail(
    installing
      ? `still installing after ${Math.round(timeoutMs / 1000)}s — the first run of this command fetches its dependencies`
      : firstRunInstaller
        ? `no response in ${Math.round(timeoutMs / 1000)}s — \`${parts[0]}\` fetches its package on first use, so this is probably still downloading`
        : `timed out after ${Math.round(timeoutMs / 1000)}s`,
  ),
});
```

### 4.3 Arm the warm-up

Both consumers compute `warmable` the same way. In `saveMcpServer` (`:1279-1282`):

```ts
// R19-18 (evidence): the command SAID it was installing — always warmable.
// R20-4 (heuristic): it said nothing, but it is an npx/bunx-style command and
// this row has never succeeded here. Armed at most ONCE per row (below), so a
// server that never works still settles to `unreachable`.
const priorRow = input.id ? getMcpServer(db, input.id) : null;
const firstEver = !priorRow || priorRow.firstSuccessAt === null;
const warmable =
  disc.kind === "down" &&
  (disc.installing === true ||
    (disc.firstRunInstaller === true && firstEver && (priorRow?.heuristicWarmups ?? 0) < 1));
```

Same expression in `testMcpServer` (`:1409-1417`) against the `existing` row it already
reads at `:1362`.

`startMcpWarmup` (`mcp-warmup.server.ts:62-70`) gains
`options.heuristic?: boolean`; when set it also runs
`UPDATE org_mcp_servers SET heuristic_warmups = heuristic_warmups + 1 WHERE id = ?`
in the same statement batch as `markWarming`.

Extend `McpRow`/`McpView` (`resources.server.ts:550-580`) with `firstSuccessAt` /
`heuristicWarmups` and add both columns to `MCP_SQL`.

### 4.4 The terminal condition (keeping R19-17c honest)

A server whose command genuinely never answers now goes:

1. save → 20 s probe times out, no install-y stderr, `npx` command, `first_success_at` NULL,
   `heuristic_warmups = 0` → **heuristic warm-up armed** (`heuristic_warmups → 1`), row shows
   installing, page polls.
2. 15 min later `discoverStdioMcpTools` times out again → `mcp-warmup.server.ts:98-103`
   writes `up = 0`, `last_error = "timed out after 900s — …"`, `warming_since = NULL`.
   `first_success_at` stays NULL, `heuristic_warmups` stays 1.
3. Every later probe/retest: `firstEver` is still true but `heuristicWarmups >= 1`, so the
   heuristic does **not** re-arm. The row reads `unreachable · <reason>`, permanently, which
   is exactly what R19-17c requires.
4. The **evidence-based** path is untouched: if the command later prints "downloading",
   `disc.installing === true` re-arms regardless of the counter. That branch is not a guess,
   so it is not capped.

`reapStaleWarmups` (`:129-145`) additionally rolls the counter back for the rows it reaps:
`heuristic_warmups = MAX(0, heuristic_warmups - 1)`. A warm-up killed by a container restart
never got its 15 minutes, so it is not a spent attempt — and the reaper's existing
"retest to start it again" message would otherwise be a lie.

### 4.5 UI copy

**CHOICE: one copy for both bases.** `resource-rows.tsx:200` / `:218-225` currently says
"installing on first use — finishing in the background". The heuristic case is an inference,
not a report, so the claim is softened for both — the reader can act on neither distinction:

- `:200` (title) → `"first run of this command — finishing in the background"`
- `:218-219` (subline) → `"first run — installing in the background"`

Everything else (`:206` unreachable, `:257` the `last_error` block gated on
`warmingSince === null`) is unchanged; the polling in `resources-panel.tsx:113` already keys
on `warmingSince` and needs no change.

### 4.6 Tests

| File | What to add |
| --- | --- |
| `app/server/org/resources.server.test.ts` | `isFirstRunInstallerCommand` table (`npx`, `bunx`, `uvx`, `pnpm dlx`, `yarn dlx`, `uv tool run` → true; `node server.js`, `my-npx-tool` → false). Using the `spawnImpl` seam at `:703`: a fake that never writes and never exits → the timeout arm returns `firstRunInstaller: true` with the new reason for an `npx` command, and plain `timed out after 20s` for `node`. |
| `app/server/org/mcp-warmup.server.test.ts` | `startMcpWarmup({heuristic:true})` bumps `heuristic_warmups`; a settled `up` warm-up stamps `first_success_at`; `reapStaleWarmups` rolls the counter back. |
| `app/server/org/resources.server.test.ts` (integration) | **The terminal-condition test, which is the point of the spec**: register an always-timing-out `npx` server → first save arms a warm-up; force the warm-up to settle `down`; a second `testMcpServer` does **not** arm one and the row reads `unreachable`. Canary: remove the `heuristicWarmups < 1` clause and it must go red. |
| `app/features/org-settings/org-settings-page.test.tsx` | The warming row's new copy. |

---

## Spec 5 — smaller dispositioned items

### 5a. N20-4 — the PR body's "Viberr task" link is relative

`composePrBody` lives at `app/server/github/pr-open.server.ts:42`; the task URL is built at
`:82-91` and falls back to a **relative** `/projects/…` path when both `appOrigin` and
`BETTER_AUTH_URL` are unset. Its only production call site (`:268-282`) receives `ctx` from
`performDelivery` (`app/server/tasks/task-actions.server.ts:3429`), whose `dataCtx`
(`:3436`) carries **only** `dataRoot` — `appOrigin` is never threaded, and delivery also
runs off-request from background operator runs, so the origin cannot come from a request.
The app has no shared origin helper: `BETTER_AUTH_URL` (`app/server/config/env.server.ts:38-44`)
and R19-16's request-derived `callbackOrigin` (`app/routes/org.settings.tsx:83-93`) are
independent. **Fix:** add `appOrigin(): string | null` to `env.server.ts` next to the
`BETTER_AUTH_URL` reader — trimmed, trailing-slash-stripped, `null` when unset or not
`http(s)` — and have `composePrBody` call it directly instead of taking the origin through
`ctx` (the delivery path has no request to derive one from, so a parameter would just move
the `null` around). When it returns `null`, **omit the link entirely** and write the plain
store-relative key instead (`Viberr task VIB-2`): a link that 404s on github.com is worse
than no link, and ruling 3 already makes the store-relative path the honest fallback. Add a
one-line `logger.debug` naming `BETTER_AUTH_URL` so the deployment fix is discoverable.
**Evidence lines** (`latestEvidenceLines`, `:70-80`) stay plain text — `app/routes/task-attachment.tsx`
is `requireProjectMember`, so an absolute attachment link would 302 every non-member reader
into a login page; linkifying them would advertise a door most readers cannot open (ruling
65 / R19-11's withdraw-don't-tease posture). Tests: `app/server/github/pr-open.server.test.ts:86-90`
pins the current relative fallback and must be rewritten to assert the no-link fallback;
`:95-120` covers the absolute case and needs only the new env seam.

### 5b. F20-2 — defunct chromium/crashpad children under pid 1

Boot never probes a browser: the eight zombies come from three fire-and-forget boot chains —
`finalizeOrphanedRuns` (`app/server/boot.server.ts:345`), `reconcileRestartedWork` (`:361`)
and `startScheduleRunner` (`:367`) — reaching specialist runs that mount the R19-19
Playwright MCP server (`app/server/tasks/specialist-browser-mcp.server.ts`). Two leaks, both
real: (1) the only `spawn()` in `app/server` — the MCP probe at
`app/server/org/resources.server.ts:764-772` — is killed at `:880` with a bare
`child.kill()`, which signals the direct child only and orphans its grandchildren; (2) SDK
aborts (`codex-runtime.server.ts:415`, `:439`, `:647`; the Claude idle timeout at
`claude-runtime.server.ts:483-492`) tear down the CLI subprocess and leave the
`@playwright/mcp` node process plus its chromium tree (~6-9 helpers — matching the count
observed) parented to pid 1, where node-as-init never reaps them. **Fix, both halves.**
Process-group teardown at `resources.server.ts:764-772`/`:875-885`: spawn with
`detached: true` and kill with `process.kill(-child.pid, "SIGTERM")` inside a try/catch,
falling back to `child.kill()` when the pid is gone (the `McpChild` interface at `:739-746`
gains an optional `pid`). Belt-and-braces for everything the app does not spawn itself:
`init: true` as a sibling key under the `app` service (`compose.yml:2-12`, beside
`hostname: viberr`), mirrored in `compose.e2e.yml:33` — the entrypoint's exec chain is
docker-init compatible, so this is a one-line change per file and it reaps every orphan
regardless of which SDK dropped it.
Tests: `app/server/org/resources.server.test.ts:703` exercises the `spawnImpl` seam — assert
the teardown calls the group kill when a pid is present and falls back otherwise, and
**record in the test's comment that the fake models no grandchildren**, so nobody reads a
green test as proof the real leak is closed (only the compose `init` is that proof).

### 5c. VIB-2 nit — "awaiting verdict" survives a force-accept

The string is `VALIDATION_DISPLAY.changed = "awaiting verdict"` (`app/ui/pill.tsx:96`),
computed by `deriveValidation` (`app/schemas/task-file.schema.ts:579-617`, returning
`"changed"` at `:616`). Force-accept records **only** an audit row —
`task.acceptance.forced`, `app/server/tasks/task-actions.server.ts:5808-5817` — so no
frontmatter, projection or `TaskSummary` field carries the fact, and
`applyAcceptanceWrite` (`:5550`) recomputes validation straight back to `"changed"`.
**Fix:** make the override a durable frontmatter fact. Add
`acceptance: "forced" | null` to `TaskFrontmatter` (schema `:579`-adjacent), written by the
accept path when `input.force === true`; give `deriveValidation` an escape at `:615` beside
F19-27's existing `noChanges` one (`if (fm.acceptance === "forced") return "bypassed"`); add
`bypassed: "accepted · gate bypassed"` to `VALIDATION_DISPLAY` (`pill.tsx:96`) with the
`risk`-toned kind (it is an override, not a clean pass); thread the field through
`rebuilder.server.ts:507` into the projection and `app/shared/mapping/task.server.ts` into
`TaskSummary`. The precedent for a display-suppressing frontmatter fact is exactly
F19-27/UXO-1 (`board-page.tsx:230`, `task-main-sections.tsx:180`). Tests:
`app/schemas/task-file.schema.test.ts:103`/`:120` for the new `deriveValidation` arm,
`app/features/board/board-page.test.tsx:167` and `:709-729` for the card chip,
`app/features/task-detail/task-detail-components.test.tsx:1995-2023` for the detail pill.

### 5d. F20-1 / F20-3 — data-root resilience (minimal, scoped to a side project)

**The spin point cannot be pinned from code reading, and this spec does not guess it.**
What was ruled out by reading: `writeFileAtomic` (`app/server/files/atomic-file.server.ts`)
has no retry — it throws, and already names ENOSPC; `withFileLock`
(`app/server/files/file-mutex.server.ts`) is a bare `navigator.locks.request` with no loop;
`createProjectFile` / `updateProjectFile` / `repairStaleProjectRead`
(`app/server/files/project-writer.server.ts:75-144`) are single-pass; `rebuildPath`
(`app/server/projections/rebuilder.server.ts:618-647`) is wrapped in try/catch and records
provenance on error; the chokidar re-arm (`app/server/files/file-watch.service.server.ts:237-290`)
is generation-guarded, single-pending, `unref`ed and gated on a five-code transient set, so it
cannot busy-spin. The only unbounded `while` on a `createProject` path-adjacent surface is
`app/server/org/store-files.server.ts:799` (`while (existsSync(...))`), which would spin
forever if a ghost inode answered `existsSync` true for every candidate name — a real
candidate, but that loop is on the KB-import path, not `create-project`.

**Spec the experiment, then the fix.** Under a throwaway data root, monkey-patch
`node:fs` in a test-only harness to throw `ESTALE` (then `EIO`) from `statSync`,
`existsSync`, `mkdirSync`, `writeFileSync` and `renameSync` for paths under that root, and
drive `createProject` (`app/features/home/project-create.server.ts:189`, whose
`createProjectFile` write is at `:299-302`) to
completion with a wall-clock guard. Run it as a **new** `app/features/home/project-create.server.test.ts`
case (or a `scripts/` probe if the harness is too invasive for the suite) with the fault
injected one syscall at a time, and record which one fails to terminate. `existsSync`
returning **true** under a dead inode is the highest-prior hypothesis precisely because it
is the one error mode that produces a *silent* wrong answer rather than a throw, and it is
also the likeliest explanation of F20-3's half-seeded org (a seed step that skipped its work
because `existsSync` said "already there").

**The fix, once the spin point is named** (and the shape to build regardless): every
data-root write path fails the ACTION with a typed `AppError`, and the server keeps serving.
Concretely — (i) any `while (existsSync(...))` collision loop gets a hard bound (32
attempts) and throws `AppError` naming the directory when it is exceeded; (ii)
`writeFileAtomic` (`atomic-file.server.ts:15-35`) grows an `ESTALE`/`EIO` arm beside its
ENOSPC arm with a sentence naming the data root as unreachable; (iii) an action-level
watchdog — the finding asks for one and it is the cheapest general insurance: wrap the
mutating server actions' entry points in a `Promise.race` against a 30 s timer that throws
`AppError` with "the action did not complete in 30s — the data root may be unreachable".
Deliberately **not** in scope (viberr-scope: side project): a health-checked mount, a
self-healing remount, or per-syscall retry policy. Tests: the fault-injection harness above,
asserting the action rejects with a typed error and a subsequent `/resources/health` request
still answers.

---

## Where a ruling sits awkwardly against existing conventions

1. **R20-1's "ANY recovery option … re-queues the operator" vs. `hold_runtime_debug`.**
   A hold whose whole purpose is to freeze coordination cannot also start a run. §1.3 makes
   it the one documented non-re-queue; it still resolves the packet and refuses repeat
   confirms, which is the half of R20-1 that F20-5 was actually about. Flag for the owner.
2. **R20-2's discard needs a tenth packet-option kind**, which edits ruling 7's stated count
   (nine) and brushes ruling 17's "remote-branch deletion exists only as the archive packet
   resolution". §2.5 argues the local/remote distinction and refuses on-remote branches, but
   the ruling-7 count and ruling-17 wording both need the ruling-44 promotion into
   `decisions.md` in the same change, or the next pass re-files this as a violation.
3. **R20-3's "validate model availability" vs. ruling 19's proven-verdicts-only.**
   A save-time probe would render an unproven tick. §3b takes the mark-on-real-failure
   half and explicitly does **not** claim "available" for anything — absence of a mark
   means "not disproven", never "proven". If the owner wanted a genuine save-time probe for
   Codex, it costs a billable spawn per save and should be ruled on separately.
