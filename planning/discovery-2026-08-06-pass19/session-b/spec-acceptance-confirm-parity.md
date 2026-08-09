# Implementation spec — every acceptance writer routes through one confirm (F19-3, F19-7, F19-14, F19-10, +F19-22)

## 1. Goal

Make **one** component (`AcceptConfirm`) and **one** disclosure computation serve every human-facing path that reaches an acceptance/completion writer, closing ruling 20 (R15-1) and ruling 53 (R18-7) for the writers pass-18 missed. This closes **F19-3** (recommendation Apply merges with no dialog at all), **F19-7** (packet `accept_completion` merges from a disclosure-free "Confirm decision"), **F19-14** (the dialog prints the raw PR-state token instead of the canonical `prStatePill` label/kind), **F19-10** (the "Complete merge" gate is stricter than the server gate it fronts), and one path this cluster's enumeration uncovered — **F19-22 (new)**: the task-detail *Current state → Stage* dropdown moves a task into the terminal stage with no confirm, which `transitionStage` routes straight into `acceptCompletion` (a real merge).

---

## 2. Current behavior

### 2.1 The one dialog that exists

`app/features/task-detail/accept-confirm.tsx:17-42` — props today:

```tsx
export function AcceptConfirm({
  task, workRevisionSha, noChanges = false, defaultBranch,
  force = false, blockedReason, busy, onCancel, onConfirm,
}: { task: TaskDetail; workRevisionSha: string | null; noChanges?: boolean;
     defaultBranch: string; force?: boolean; blockedReason: string | null;
     busy: boolean; onCancel: () => void; onConfirm: () => void; })
```

Its "Merges" row, `:78-83` (this is F19-14):

```tsx
{task.pr ? (
  <>
    <Pill kind="neutral" sm>
      PR #{task.pr.number} · {task.pr.state}
    </Pill>{" "}
    into <span className="mono">{defaultBranch}</span>
  </>
) : noChanges ? ( … ) : ( … )}
```

`task.pr.state` is the raw `PR_STATE_VALUES` member (`review | merged | closed | accepted`). The canonical mapper is `prStatePill` in `app/features/github/github-pills.ts:47-52`:

```ts
export function prStatePill(state: string): PillView {
  if (state === "merged") return { kind: "done", label: "merged" };
  if (state === "closed") return { kind: "risk", label: "closed" };
  if (state === "accepted") return { kind: "input", label: "merge pending" };
  return { kind: "info", label: "in review" };
}
```

Every sibling surface uses it: `task-side-panels.tsx:128-132`, `board-page.tsx:304-306`, `review-page.tsx:63-67`, `github-view.tsx:161,252`. `archive-confirm.tsx:80-88` bypasses it the same way (`PR #{task.pr.number} {task.pr.state}`, `kind="neutral"`).

### 2.2 The only two wired entry points

`app/features/task-detail/task-detail-page.tsx:236-249`:

```tsx
  const [confirmAccept, setConfirmAccept] = useState<null | "accept" | "force">(null);
  const acceptFetcher = useFetcher<ActionResult>();
  useActionFeedback(acceptFetcher);
  const acceptBusy = acceptFetcher.state !== "idle";
  const submitAccept = () => {
    if (acceptBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "accept-completion");
    acceptFetcher.submit(fd, { method: "post" });
  };
```

and the render, `:491-516`, opened from `CurrentStatePanel`'s `onAccept` (`:479`) and `GithubTrace`'s `onForceAccept` (`:461-463`).

### 2.3 F19-3 — recommendation Apply, no dialog at all

`app/features/task-detail/operator-recommendations.tsx:99-110` renders the Apply button, calling `onApply(r.id)` directly. The handler is `task-main-sections.tsx:267-274`:

```tsx
  const onApplyRec = (recId: string) => {
    if (recBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "apply-recommendation");
    fd.set("recId", recId);
    recFetcher.submit(fd, { method: "post" });
  };
```

`routes/project.task.tsx:672-685` → `applyRecommendation`, whose `accept_completion` branch is `task-actions.server.ts:5549-5558`:

```ts
  } else if (rec.kind === "accept_completion") {
    await acceptCompletion(db, { projectSlug: input.projectSlug, taskKey: input.taskKey }, actor, ctx);
```

One click = merge + Done. Live-reproduced on VC-1 / PR #147.

### 2.4 F19-7 — packet resolve, confirm STEP but no DISCLOSURE

`decision-packet.tsx:306-340`: the "Confirm decision" button calls `onResolve(sel, note)`. The page's handler, `task-detail-page.tsx:327-335`:

```tsx
  const onResolve = (optionIndex: number, note = "") => {
    if (resolveBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "resolve-packet");
    fd.set("option", String(optionIndex));
    if (note.trim()) fd.set("note", note);
    resolveFetcher.submit(fd, { method: "post" });
  };
```

`resolvePacket`'s `accept_completion` case (`task-actions.server.ts:4170-4258`) runs `requireAcceptCompletion`, `acceptanceRefusalReason(..., { blockedPacket: false })`, `acceptancePrHeadCheck`, then `attemptAcceptanceMerge`. Note the **`blockedPacket: false`** — the packet being open is not a refusal on this path.

### 2.5 F19-22 (new) — task-detail Stage dropdown

`task-side-panels.tsx:413-419`:

```tsx
  const onTransition = (toStageId: string) => {
    if (transitionBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "transition");
    fd.set("to", toStageId);
    transitionFetcher.submit(fd, { method: "post" });
  };
```

fed by `<StageMenu stages={task.stages} … onSelect={onTransition} />` (`:446-451`) — `task.stages` includes the terminal stage. `routes/project.task.tsx:554-576` passes `manual: true` to `transitionStage`, whose `task-actions.server.ts:3073-3085` reads:

```ts
  if (!ctx.operatorAuthorized && input.toStageId === lastStageId && lastStageId !== undefined) {
    await acceptCompletion(db, { projectSlug: input.projectSlug, taskKey: input.taskKey }, actor, ctx);
    return summaryOrThrow(db, input.projectSlug, input.taskKey);
  }
```

Identical writer to the Accept button; zero confirmation. This is the fourth of ruling 53's "three of five lacked it" that was never counted.

### 2.6 F19-10 — Complete merge gate

`task-detail-hooks.ts:114-125`:

```ts
  // Complete the real merge of an accepted (merge-pending) PR (S2).
  // admin|maintainer only; server re-checks.
  const canMerge = roleCan(myRole as ProjectRole | null, "accept-completion");
  const onCompleteMerge = canMerge ? () => { … fd.set("intent", "complete-merge"); … } : undefined;
```

The server, `completeTaskMerge` at `task-actions.server.ts:5346-5352`, calls `requireAcceptCompletion(db, project, actor, existing.parsed.frontmatter.ownerUserId, "complete a PR merge")`, which short-circuits on `ownerException` (`:335-344`, `:321-332`: owner + `own-task`). `resolveAcceptanceAffordance` already computes exactly that predicate at `:4984-4986`:

```ts
  const hasAuthority =
    roleCan(role, "accept-completion") ||
    (fm.ownerUserId === input.viewerUserId && roleCan(role, "own-task"));
```

and preserves it through both early returns (`:4988`, `:4996-4998` — including the terminal-stage return, which is precisely the state a merge-pending task is in). `GithubTrace` renders the button only when the prop exists (`task-side-panels.tsx:221-232`).

---

## 3. Design

**One component, one disclosure object, one dialog per surface, a discriminated `via` for provenance.**

1. `AcceptConfirm` takes a single `disclosure: AcceptDisclosure` object (`{ task, workRevisionSha, noChanges, defaultBranch }`) instead of four loose props, plus the mode-dependent `blockedReason`, plus an optional `via` that names the control the human actually pressed. The page computes `acceptDisclosure` **once** and hands the same object to every consumer, so no call site can assemble a different set of facts.
2. The PR chip inside it becomes `prStatePill(task.pr.state)` for **both** `kind` and `label` (F19-14). Same one-line fix in `archive-confirm.tsx` — the audit's correction names it as the only other bypass, and leaving it re-opens the class next pass.
3. The page owns a discriminated `pendingAccept` union covering `accept | force | stage | packet`, and renders exactly **one** `<AcceptConfirm>`. `RecommendationsSection` renders the second and last instance, because it owns the recommendation fetcher (pass-16 split); it receives the same `acceptDisclosure` object, so the disclosure is still computed once.
4. **The packet path opens `AcceptConfirm`; it does not grow disclosure inline.** Defense: (a) `DecisionPacket` renders 9 option kinds from operator-authored freeform text — merge facts inline would have to be conditionally hidden for the other 8 and would become a second implementation of the disclosure living inside a card whose content the operator writes; (b) the packet's radiogroup + "Confirm decision" is a *selection* step, not a statement of consequences — it has no "Not yet", no PR number, no one-way warning, and its own accessible name promises only "Confirm decision"; (c) ruling 20's requirement is one dialog stating what merges, on every path — routing here gives byte-identical copy on all five human paths and one test surface. The cost is a third click on the app's most irreversible action, which is the intended cost.
5. **F19-10** stops asking `roleCan(myRole, "accept-completion")` and starts asking the server-resolved `acceptance.hasAuthority` — literally the same predicate `requireAcceptCompletion` runs, including the archived-project and terminal-stage cases (both preserve `hasAuthority`). Rejected alternative: recomputing `roleCan(...) || (isOwner && canOwn)` client-side in `useRunControls`. That is a third copy of an authority rule the server already ships to this page, and it is exactly how `task-detail-hooks.ts:116` drifted in the first place (E3: ask for the action the SERVER enforces).
6. **Packet-mode `blockedReason` gets its own server field.** The loader's `acceptance.blockedReason` is computed *with* `blockedPacket: true` (`:5001-5003`), but `resolvePacket` refuses with `blockedPacket: false` (`:4188-4193`). Reusing the existing string would print "Bypassing: an open blocked decision…" for a resolution the server will not refuse — an honesty failure in the opposite direction. `AcceptanceAffordance` gains `blockedReasonViaPacket`, computed by the same `acceptanceRefusalReason` call the packet writer makes. Rejected alternative: suppressing the "Bypassing" row on the packet path — that hides real missing signals (missing verdict, conflicting PR) that R15-1 exists to name.
7. **Board drag / board keyboard menu stay on `AcceptOnBoardConfirm`** (`board-page.tsx:543-586`). Rejected unification: the board loader ships no `workRevision.headSha`, no `defaultBranch` and no per-task `AcceptanceAffordance`; wiring those into a 100-card list to satisfy component identity would cost a per-task file read per card. Pass 18 chose an honest thin dialog that ends with "Open {taskKey} to see the pull request, revision and verdict first." That remains the right trade and is left untouched.
8. **"Complete merge" gets no dialog** (only the gate fix). It is not an acceptance writer: the acceptance is already recorded and the stage is already terminal; it finishes a merge that either passed one of the five confirms or was authorized by an explicit `completion-for-acceptance: direct` policy grant (ruling 40). Decisively: the button lives *inside* `GithubTrace`, which renders the PR number, canonical state pill, branch, diff and commit list within ~100px of it — the disclosure a dialog would restate is already on screen, which is not true of the rec card or the packet card.

---

## 4. Changes

### C1 — `app/features/task-detail/accept-confirm.tsx`

**Anchor: file header + `AcceptConfirm` signature, current `:1-4` and `:17-42`.**

Add the import and two exported types; convert the props.

```tsx
// after (imports, line 1-4)
import type { TaskDetail } from "~/server/projections/task-query.server";
import { prStatePill } from "~/features/github/github-pills";
import { Icon } from "~/ui/icon";
import { Pill, ValidationPill } from "~/ui/pill";
import { useDialog } from "~/ui/use-dialog";

/**
 * The facts EVERY acceptance confirm states, assembled once by the task-detail
 * loader/page and handed unchanged to each entry point (F19-3/F19-7). One
 * object, so no acceptance surface can drift into disclosing a different set.
 */
export interface AcceptDisclosure {
  task: TaskDetail;
  /** The delivered revision's head sha (task file), or null before delivery. */
  workRevisionSha: string | null;
  /** R17-2: a verified no-change completion — the branch is empty, no PR. */
  noChanges: boolean;
  /** The merge target — the project's default branch. */
  defaultBranch: string;
}

/** Which control the human pressed — named in the dialog, because the merge is
 *  the same act whether it arrives as a stage move, a recommendation or a
 *  packet decision (R15-1 / ruling 53). */
export type AcceptVia =
  | { kind: "recommendation"; title: string }
  | { kind: "decision"; title: string }
  | { kind: "stage" };
```

```tsx
// before (:17-42) — four loose disclosure props
export function AcceptConfirm({
  task, workRevisionSha, noChanges = false, defaultBranch,
  force = false, blockedReason, busy, onCancel, onConfirm,
}: { task: TaskDetail; workRevisionSha: string | null; noChanges?: boolean;
     defaultBranch: string; force?: boolean; blockedReason: string | null;
     busy: boolean; onCancel: () => void; onConfirm: () => void; }) {
  const { ref: panelRef, close } = useDialog(onCancel);

// after
export function AcceptConfirm({
  disclosure,
  force = false,
  via,
  blockedReason,
  busy,
  onCancel,
  onConfirm,
}: {
  disclosure: AcceptDisclosure;
  /** True when this confirms the audited admin FORCE-accept (DG-2). */
  force?: boolean;
  /** The entry point, when it is not the Current-state Accept button. */
  via?: AcceptVia;
  /** The refusal this acceptance would carry past (null for a clean accept). */
  blockedReason: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { task, workRevisionSha, noChanges, defaultBranch } = disclosure;
  const { ref: panelRef, close } = useDialog(onCancel);
```

**Anchor: the "Merges" row, current `:78-83` (F19-14).**

```tsx
// before
{task.pr ? (
  <>
    <Pill kind="neutral" sm>
      PR #{task.pr.number} · {task.pr.state}
    </Pill>{" "}
    into <span className="mono">{defaultBranch}</span>
  </>
) : …

// after — F19-14: the canonical PR-state mapping (ruling 12/14), same as the
// GitHub bar behind this dialog. The raw enum member printed "review" where
// every other surface says "in review", and the hardcoded neutral tone drew a
// CLOSED-unmerged PR as informational chrome in the dialog that merges it.
{task.pr ? (
  <>
    <Pill kind={prStatePill(task.pr.state).kind} sm>
      PR #{task.pr.number} · {prStatePill(task.pr.state).label}
    </Pill>{" "}
    into <span className="mono">{defaultBranch}</span>
  </>
) : …
```

**Anchor: new `via` row, inserted immediately after the "Merges" `.obs` div closes (current `:94`), before the "Revision" row.**

```tsx
{via && (
  <div className="obs">
    <span className="k">
      {via.kind === "recommendation"
        ? "Recommendation"
        : via.kind === "decision"
          ? "Decision"
          : "Stage move"}
    </span>
    <span>
      {via.kind === "stage" ? (
        <>
          Moving this task into <strong>{terminalName}</strong> is an
          acceptance, not a plain stage move.
        </>
      ) : (
        <>
          “{via.title}” — confirming it accepts the completion.
        </>
      )}
    </span>
  </div>
)}
```

(`terminalName` already exists at `:44-45` and is computed before the return.)

### C2 — `app/features/task-detail/archive-confirm.tsx`

**Anchor: the "Now" row PR chip, current `:80-88`.**

```tsx
// before
<Pill kind="neutral" sm>
  PR #{task.pr.number} {task.pr.state}
</Pill>
// after
<Pill kind={prStatePill(task.pr.state).kind} sm>
  PR #{task.pr.number} · {prStatePill(task.pr.state).label}
</Pill>
```

Add `import { prStatePill } from "~/features/github/github-pills";`.

### C3 — `app/server/tasks/task-actions.server.ts` — `AcceptanceAffordance` gains the packet-mode refusal

**Anchor: `interface AcceptanceAffordance`, current `:4933-4945`.** Add after `blockedReason`:

```ts
  /** F19-7: the refusal a PACKET `accept_completion` resolution would hit.
   *  `resolvePacket` refuses with `blockedPacket: false` — the open packet IS
   *  what the resolution clears, so it cannot also be the reason to refuse it.
   *  The packet's confirm dialog must name THIS, never `blockedReason`, or it
   *  reports a bypass the server will not perform. */
  blockedReasonViaPacket: string | null;
```

**Anchor: `resolveAcceptanceAffordance`, the `denied` literal `:4967-4973` and the return `:5004-5010`.**

```ts
// denied literal — add
  blockedReasonViaPacket: null,

// return — add, alongside the existing blockedReason
  blockedReasonViaPacket: acceptanceRefusalReason(project, fm, input.taskKey, {
    blockedPacket: false,
  }),
```

### C4 — `app/features/task-detail/task-detail-hooks.ts` — F19-10

**Anchor: `useRunControls` params `:55-68` and `:114-125`.**

```ts
// before (params)
export function useRunControls({
  csrf, runtime, myRole, canRunAgents, acceptanceTerminallyBlocked,
}: { csrf: string; runtime: RunView[]; myRole: string | null;
     canRunAgents: boolean; acceptanceTerminallyBlocked: boolean; }) {

// after — add one param
  /** F19-10: `completeTaskMerge` authorizes maintainer+ OR this task's live
   *  contributor-owner (`requireAcceptCompletion` → `ownerException`, R6-2).
   *  This is `acceptance.hasAuthority`, the SAME predicate resolved server-side
   *  — never a client re-derivation of the matrix (E3). */
  mergeAuthority,
  …
  mergeAuthority: boolean;
```

```ts
// before (:114-117)
  // Complete the real merge of an accepted (merge-pending) PR (S2).
  // admin|maintainer only; server re-checks.
  const canMerge = roleCan(myRole as ProjectRole | null, "accept-completion");
  const onCompleteMerge = canMerge ? …

// after
  // Complete the real merge of an accepted (merge-pending) PR (S2).
  // F19-10: this asked `accept-completion` (admin|maintainer) while the server
  // it calls carries the owner exception, so a contributor-owner was sent the
  // merge-pending nudge pointing at a button that never rendered for them.
  const onCompleteMerge = mergeAuthority ? …
```

`roleCan` / `ProjectRole` stay imported — still used by `canInterrupt` and `canForceAccept`.

### C5 — `app/features/task-detail/task-detail-page.tsx`

**Anchor: import line `:8`.**

```tsx
import { AcceptConfirm, type AcceptDisclosure } from "./accept-confirm";
```

**Anchor: `:236-249` — replace the two-mode state with the union + the shared disclosure.**

```tsx
// after
  /** R15-1 / ruling 53: EVERY acceptance entry point on this page opens the
   *  same dialog with the same disclosure. The union says which control was
   *  pressed and carries what that control needs to commit afterwards. */
  type PendingAccept =
    | { kind: "accept" }
    | { kind: "force" }
    /** F19-22: the Current-state stage dropdown targeting the terminal stage —
     *  `transitionStage` routes that into `acceptCompletion` (a real merge). */
    | { kind: "stage" }
    /** F19-7: a packet option whose kind is `accept_completion`. */
    | { kind: "packet"; optionIndex: number; note: string; title: string };
  const [pendingAccept, setPendingAccept] = useState<PendingAccept | null>(null);
  /** The ONE place acceptance disclosure is assembled (F19-3/F19-7). */
  const acceptDisclosure: AcceptDisclosure = {
    task,
    workRevisionSha,
    noChanges,
    defaultBranch,
  };
  const acceptFetcher = useFetcher<ActionResult>();
  useActionFeedback(acceptFetcher);
  const acceptBusy = acceptFetcher.state !== "idle";
  const submitAccept = () => { …unchanged… };
```

**Anchor: `:327-335` — `onResolve` intercepts `accept_completion`.**

```tsx
// after
  /** Submit a packet resolution. Split from `onResolve` so the confirmed
   *  acceptance path can reach it after the dialog. */
  const submitResolve = (optionIndex: number, note: string) => {
    if (resolveBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "resolve-packet");
    fd.set("option", String(optionIndex));
    if (note.trim()) fd.set("note", note);
    resolveFetcher.submit(fd, { method: "post" });
  };
  const onResolve = (optionIndex: number, note = "") => {
    // F19-7: resolving an `accept_completion` option MERGES the review PR — the
    // same irreversible write the Accept button performs. The card's
    // select-then-"Confirm decision" is a selection step, not a statement of
    // consequences: it names no PR, no revision, no verdict, no target, and
    // offers no "Not yet". Route it through the one dialog (ruling 20).
    const option = task.packet?.options[optionIndex];
    if (option?.kind === "accept_completion") {
      setPendingAccept({ kind: "packet", optionIndex, note, title: option.t });
      return;
    }
    submitResolve(optionIndex, note);
  };
```

**Anchor: `:383-386` — `RecommendationsSection` gets the shared disclosure.**

```tsx
  <RecommendationsSection
    recommendations={recommendations}
    canApply={canDecideOwned}
    disclosure={acceptDisclosure}
    blockedReason={acceptance.blockedReason}
  />
```

**Anchor: `:468-482` — `CurrentStatePanel` gains the stage-move interception hook.**

```tsx
  <CurrentStatePanel
    …unchanged…
    onAccept={() => setPendingAccept({ kind: "accept" })}
    // F19-22: picking the terminal stage from this panel's dropdown is an
    // acceptance, not a move — it must ask the same question.
    onAcceptViaStage={() => setPendingAccept({ kind: "stage" })}
    …
  />
```

and `:461-463` becomes `onForceAccept: () => setPendingAccept({ kind: "force" })`.

**Anchor: `:491-516` — the single dialog.**

```tsx
{pendingAccept && (
  <AcceptConfirm
    disclosure={acceptDisclosure}
    force={pendingAccept.kind === "force"}
    {...(pendingAccept.kind === "packet"
      ? { via: { kind: "decision" as const, title: pendingAccept.title } }
      : pendingAccept.kind === "stage"
        ? { via: { kind: "stage" as const } }
        : {})}
    blockedReason={
      pendingAccept.kind === "force"
        ? (task.blockReason ??
           acceptance.blockedReason ??
           (task.packet?.type === "blocked"
             ? "An open blocked decision is holding this task."
             : null))
        : pendingAccept.kind === "packet"
          // The packet writer refuses with `blockedPacket: false` — reporting
          // the open packet as a bypassed signal here would claim a refusal
          // the server does not make.
          ? acceptance.blockedReasonViaPacket
          : acceptance.blockedReason
    }
    busy={acceptBusy || runBusy || resolveBusy}
    onCancel={() => setPendingAccept(null)}
    onConfirm={() => {
      const p = pendingAccept;
      setPendingAccept(null);
      if (p.kind === "force") onForceAccept?.();
      else if (p.kind === "packet") submitResolve(p.optionIndex, p.note);
      // "stage" commits through the dedicated acceptance intent, which the
      // route implements as exactly the manual terminal transition the stage
      // menu would have posted (routes/project.task.tsx:431-459).
      else submitAccept();
    }}
  />
)}
```

**Anchor: `:292-298` — `useRunControls` call.**

```tsx
  } = useRunControls({
    csrf, runtime, myRole, canRunAgents,
    acceptanceTerminallyBlocked: acceptance.terminallyBlocked,
    mergeAuthority: acceptance.hasAuthority,
  });
```

### C6 — `app/features/task-detail/task-main-sections.tsx` — F19-3

**Anchor: imports `:12-22`.** Add `import { useState } from "react"` (already imported at `:1`), and:

```tsx
import { AcceptConfirm, type AcceptDisclosure } from "./accept-confirm";
```

**Anchor: `RecommendationsSection`, `:253-293`.**

```tsx
// after
export function RecommendationsSection({
  recommendations,
  canApply,
  disclosure,
  blockedReason,
}: {
  recommendations: RecommendationView[];
  canApply: boolean;
  /** The page's ONE acceptance disclosure (F19-3) — never re-assembled here. */
  disclosure: AcceptDisclosure;
  blockedReason: string | null;
}) {
  const csrf = useCsrfToken();
  const recFetcher = useFetcher<ActionResult>();
  useActionFeedback(recFetcher);
  const recBusy = recFetcher.state !== "idle";
  /** F19-3: an `accept_completion` recommendation waits here for the confirm. */
  const [pendingAccept, setPendingAccept] = useState<RecommendationView | null>(null);

  const submitApply = (recId: string) => {
    if (recBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "apply-recommendation");
    fd.set("recId", recId);
    recFetcher.submit(fd, { method: "post" });
  };
  // F19-3 (live-reproduced, VC-1): applying an `accept_completion`
  // recommendation runs `acceptCompletion` — it merged PR #147 and moved the
  // task to Done on ONE click, with no dialog at all. Ruling 20 wants the
  // dialog on every accept; ruling 53 already closed the board's two paths.
  const onApplyRec = (recId: string) => {
    if (recBusy) return;
    const rec = recommendations.find((r) => r.id === recId);
    if (rec?.kind === "accept_completion") {
      setPendingAccept(rec);
      return;
    }
    submitApply(recId);
  };
  const onDismissRec = (recId: string) => { …unchanged… };

  return (
    <>
      <OperatorRecommendations
        recommendations={recommendations}
        canApply={canApply}
        busy={recBusy}
        onApply={onApplyRec}
        onDismiss={onDismissRec}
      />
      {pendingAccept && (
        <AcceptConfirm
          disclosure={disclosure}
          via={{ kind: "recommendation", title: pendingAccept.label }}
          blockedReason={blockedReason}
          busy={recBusy}
          onCancel={() => setPendingAccept(null)}
          onConfirm={() => {
            const rec = pendingAccept;
            setPendingAccept(null);
            submitApply(rec.id);
          }}
        />
      )}
    </>
  );
}
```

Note `OperatorRecommendations` returns `null` when the list is empty (`operator-recommendations.tsx:69`), so the fragment stays inert on tasks with no recommendations.

### C7 — `app/features/task-detail/task-side-panels.tsx` — F19-22 + `Complete merge` copy

**Anchor: `CurrentStatePanel` params `:358-372` and prop types `:388-390`.** Add:

```tsx
  onAcceptViaStage,
…
  /** F19-22: the stage dropdown targeting the TERMINAL stage is an acceptance
   *  (`transitionStage` → `acceptCompletion`, a real merge) — hand it to the
   *  page so it opens the same confirm the Accept button does. */
  onAcceptViaStage: () => void;
```

**Anchor: `onTransition`, `:413-419`.**

```tsx
// after
  const terminalStageId =
    task.stages.length > 0 ? task.stages[task.stages.length - 1]!.id : null;
  const onTransition = (toStageId: string) => {
    if (transitionBusy) return;
    // F19-22: a manual move INTO the final stage is not a move — the server
    // routes it through the full acceptance contract (task-actions.server.ts
    // :3073-3085). Ruling 53 gave the board's drag and Move menu this dialog;
    // this dropdown is the same writer and was missed.
    if (toStageId === terminalStageId) {
      onAcceptViaStage();
      return;
    }
    const fd = new FormData();
    …unchanged…
  };
```

**Anchor: `GithubTrace` "Complete merge" `title`, `:227`.** The tooltip stays factually right; update the neighbouring stale comment only if one is added. No markup change — the button already renders purely on `onCompleteMerge` being defined, which C4 widens.

---

## 5. Tests

All in `app/features/task-detail/task-disposition.test.tsx` (jsdom, already hosts `renderPage` + `findButton`), except T8.

**Helper changes first** (required by several tests):
- `ACCEPTANCE` const at `:70-76` gains `blockedReasonViaPacket: null` (tsc gate — the literal is typed `AcceptanceAffordance`).
- `renderPage` gains optional `recommendations?: RecommendationView[]` and `workRevisionSha?: string | null`, passed through to `<TaskDetailPage>`.

**T1 — `describe("F19-3: applying an accept_completion recommendation asks first")` → `it("opens the shared confirm naming the PR, revision and target — nothing submits until it is confirmed")`.**
Render with `myRole: "admin"`, `task: { pr: { number: 147, state: "review", title: "…" } }`, `workRevisionSha: "abcdef1234567890"`, `recommendations: [{ id: "r1", kind: "accept_completion", label: "Accept the completion and close it", detail: "" }]`. Click Apply → assert `submitted` is empty, the `dialog[data-screen-label="Accept completion dialog"]` exists, its text contains `PR #147`, `main`, `abcdef123456`, and `Accept the completion and close it`. Click `Accept → Done & merge` → `submitted[0].intent === "apply-recommendation"` and `submitted[0].recId === "r1"`.
**CANARY:** in C6, make `onApplyRec` call `submitApply(recId)` unconditionally → the `toHaveLength(0)` assertion fails (and the dialog query returns null).

**T2 — same describe → `it("a non-acceptance recommendation still applies in one click")`.**
`recommendations: [{ id: "r2", kind: "transition", toStageId: "review", label: "Move to Review", detail: "" }]`; click Apply → one submission immediately, no dialog.
**CANARY:** drop the `rec?.kind === "accept_completion"` condition (always confirm) → this fails on `toHaveLength(1)`.

**T3 — `describe("F19-7: a packet accept_completion option discloses the merge")` → `it("Confirm decision opens the acceptance dialog, then resolves the packet")`.**
Render with `task.packet` = `{ type: "input", kind: "input required", from: "Operator", title: "…", body: "…", observations: [], options: [{ kind: "accept_completion", t: "Accept the completion and close it", d: "…", rec: true }] }` and `pr: { number: 147, state: "review" }`. Click "Confirm decision" → assert nothing submitted, the accept dialog is present, and it contains `PR #147`, `in review`, `main`, `Merging is one-way`, and a `Not yet` button. Click `Accept → Done & merge` → `submitted[0]` = `{ intent: "resolve-packet", option: "0" }`.
**CANARY:** revert `onResolve` in C5 to call `submitResolve` directly → fails on the empty-`submitted` assertion.

**T4 — same describe → `it("a non-acceptance option still resolves from the card in one step")`.**
Options `[{ kind: "request_edit", … }]` → one click, one submission, no dialog.
**CANARY:** make the page intercept every option kind → fails.

**T5 — same describe → `it("names the packet-path refusal, not the open-packet one (blockedReasonViaPacket)")`.**
`acceptance: { blockedReason: "An open blocked decision is holding this task.", blockedReasonViaPacket: "No approving verdict on the delivered revision yet." }`, packet option `accept_completion`. Open the dialog; assert the text contains the verdict refusal and **not** "open blocked decision".
**CANARY:** pass `acceptance.blockedReason` for the packet branch in C5 → fails.

**T6 — `describe("F19-22: the stage dropdown's terminal move is an acceptance")` → `it("opens the confirm instead of posting a bare transition")`.**
`myRole: "admin"`. Open the `StageMenu` from Current state, pick "Done" → assert `submitted` empty and the accept dialog present; confirm → `submitted[0].intent === "accept-completion"`. Second assertion in the same test: picking "Triage" posts `{ intent: "transition", to: "triage" }` immediately with no dialog.
**CANARY:** remove the `toStageId === terminalStageId` branch in C7 → the first half fails with a `transition` submission.

**T7 — `describe("F19-10: Complete merge follows the server's authority")`.**
- `it("renders for the contributor-owner the server authorizes")`: `myRole: "contributor"`, `meId: "u-selin"`, `task: { owner: {kind:"human", userId:"u-selin", …}, pr: { number: 147, state: "accepted" } }`, `acceptance: { hasAuthority: true }` → the "Complete merge" button exists; clicking it submits `intent: "complete-merge"`.
- `it("stays hidden when the viewer holds no acceptance authority")`: same task, `myRole: "viewer"`, `acceptance: { hasAuthority: false }` → no such button.
**CANARY:** restore `const canMerge = roleCan(myRole, "accept-completion")` in C4 → the first case fails (contributor has no `accept-completion` row in `ACTION_ROLES`).

**T8 — `app/features/task-detail/task-detail-components.test.tsx`, `describe("F19-14: the accept dialog speaks the product's PR vocabulary")` → `it("renders the canonical prStatePill label and tone, not the raw enum member")`.**
Render `<AcceptConfirm>` directly with `disclosure.task.pr = { number: 147, state: "review" }` → assert the pill text is `PR #147 · in review` and its class list contains `info`; re-render with `state: "closed"` → label `closed`, class contains `risk` (never `neutral`).
**CANARY:** revert the row to `{task.pr.state}` + `kind="neutral"` → both halves fail.

**T9 — extend `app/features/task-detail/task-disposition.test.tsx:154` (`"the confirm names the PR, revision, verdict state and target branch (R15-1)"`)** to assert `in review` rather than merely containing `PR #117` — same canary as T8, and it pins that the Accept-button path shares the fix.

Server-side: add to `app/server/tasks/acceptance-graph.server.test.ts` an assertion inside the existing `resolveAcceptanceAffordance` block that a task with an open BLOCKED packet and an otherwise clean gate returns `blockedReason !== null` **and** `blockedReasonViaPacket === null`.
**CANARY:** make `blockedReasonViaPacket` reuse `{ blockedPacket: true }` → fails.

---

## 6. Risks / call sites

- **`AcceptConfirm`'s props are a breaking change** (allowed — no back-compat). Call sites that must move: `task-detail-page.tsx:492` (rewritten in C5) and the new one in `task-main-sections.tsx`. `tsc` catches any other. `grep -rn "AcceptConfirm" app` currently shows only `task-detail-page.tsx:8,492` plus a prose mention in `app/ui/toast.tsx:127`.
- **`AcceptanceAffordance` gains a required field.** Non-test consumers: `routes/project.task.tsx:231` (constructed by `resolveAcceptanceAffordance`, no change needed), `task-detail-page.tsx:121`, `task-side-panels.tsx:381` (type-only). Object **literals** of the type must be updated: `task-disposition.test.tsx:70`. `acceptance-graph.server.test.ts`, `acceptance-closed-pr.server.test.ts` and `delivery-decision.server.test.ts:820` only read fields — safe.
- **`useRunControls` gains a required param.** Sole call site: `task-detail-page.tsx:292`. `roleCan`/`ProjectRole` imports stay in use.
- **`CurrentStatePanel` gains a required prop.** Sole call site: `task-detail-page.tsx:468`; `task-disposition.test.tsx` renders the whole page, so it is covered.
- **`RecommendationsSection` gains two required props.** Sole call site: `task-detail-page.tsx:383`.
- **`RecommendationsSection` now returns a fragment**, not `OperatorRecommendations` directly — verify no CSS selector depends on the recommendations panel being the direct child of `.detail-main` (`app/app.css`: the panel styles key off `.panel.op-recs`, not sibling position — confirm with a grep for `op-recs` before shipping).
- **No store, schema or projection change.** `AcceptanceAffordance` is loader-computed from the canonical task file; nothing to rebuild, no migration.
- **Copy ban:** none of the new strings contain "govern*" — `app/features/copy-ban.test.ts` stays green. Re-read the new `via` copy against it before committing.
- **Paths deliberately unchanged** (state them in the pass-19 ledger so they are not re-filed): board drag and board keyboard Move menu keep `AcceptOnBoardConfirm` (ruling 53, thin-by-design — the board loader has no revision/branch/affordance data); the review queue is read-only and links to the task (`review-page.tsx:45` comment already says why it is not labeled "Accept"); "Complete merge" gets the gate fix but no dialog (§3.8).
- **Autonomous operator acceptance is exempt, explicitly.** `operatorAcceptCompletion` (`app/server/tasks/operator-actions.server.ts:2018`) runs only when `authority.autonomy === "full"` **and** `gate(authority, "completion-for-acceptance") === "direct"` (`:2063`) — a policy a human configured in advance on the Agents/Policy page, which is where that consent lives. There is no human in the loop at execution time, so a modal has no one to ask; a dialog there would be a lie about who decided. Ruling 40 keeps `merge-pull-request` `ALWAYS_HUMAN`, so this path stops at `pr.state: "accepted"` (merge pending) and the human's later "Complete merge" click is the human touch — the one this spec makes visible to the contributor-owner (F19-10).
- **Docs to update:** append to `docs/architecture/decisions.md` ruling 53 an amendment note that the remedy was completed on pass 19 for the recommendation Apply, the packet `accept_completion` resolution and the task-detail stage dropdown (keeping the number, per the superseded-ruling rule); refresh `planning/discovery-2026-08-06-pass19/reference/UI-INVENTORY.md`'s acceptance section with the five confirmed human paths; mark F19-3, F19-7, F19-10, F19-14 FIXED in `NOTES.md` and file F19-22 there as FIXED with its origin (found while enumerating for this cluster).