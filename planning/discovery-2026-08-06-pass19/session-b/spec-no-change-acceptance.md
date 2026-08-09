# R19-1 — first-class "Completed — no changes" acceptance (closes F19-21)

## 1. Goal

A task that verifiably has nothing to deliver must reach **Completed — no changes** through the acceptance ceremony, never through a faked delivery or a "Manually mark Done" packet option. This spec (a) lets a reviewer's approval bind on a task with no delivered revision by minting a **verification revision** pinned to the default-branch head, (b) adds a live, **fail-closed** `acceptanceNoChangeCheck` that every Done writer runs before closing a `noChanges` task, (c) gives the outcome its own completion event (`Completed — no changes`) and its own confirm-dialog wording on task detail and the board, and (d) makes the operator's existing `accept_completion` reach the outcome without `deliver_for_review`. Closes F19-21; implements owner ruling R19-1, extending ruling 43 (R17-2).

---

## 2. Current behavior

### 2a. `noChanges` has exactly one producer: a delivery ATTEMPT

`app/server/tasks/task-actions.server.ts:3477-3491` (inside `performDelivery`, the `push.status !== "pushed"` branch):

```ts
        // R17-2 (F17-L9): `no_commits` is a verified empty branch — mark the task
        // a no-change completion so acceptance can close it to Done cleanly. The
        // other push outcomes are genuine failures and must NOT set the flag.
        push.status === "no_commits"
          ? (fm) => {
              fm.noChanges = true;
            }
          : undefined,
      );
      // "Nothing to review" is the honest bucket for an empty branch; the rest
      // are failures to deliver at all.
      return push.status === "no_commits"
        ? { status: "nothing_to_review", message }
        : { status: "failed", message };
```

`app/server/tasks/task-actions.server.ts:3604-3624` (the `openTaskPr` → `nothing_to_review` branch):

```ts
    if (result.status === "nothing_to_review") {
      const message =
        "No review pull request could be opened — the execution branch has no " +
        "commits ahead of the default branch. …";
      await surfaceDeliveryEvent(
        db, ctx, projectSlug, taskKey,
        "Review has no PR",
        message,
        (fm) => {
          fm.noChanges = true;
        },
      );
      return { status: "nothing_to_review", message };
    }
```

The only clearer is `task-actions.server.ts:3540-3548` (a later delivery opened a real PR). No other writer sets or clears it. A task that never had a branch can therefore never carry the flag.

### 2b. The reviewer's verdict cannot bind with no revision

`app/server/tasks/task-actions.server.ts:1944-1972` inside `recordAgentCompletion`:

```ts
        const rev = parsed.frontmatter.workRevision;
        const reviewerProfileId =
          actorRef.kind === "agent" ? actorRef.profileId : null;
        if (rev && reviewerProfileId) {
          parsed.frontmatter.verdicts = [ … ];
        }
        validation = deriveValidation(parsed.frontmatter);
        parsed.frontmatter.validation = validation;
        if (verdict === "request_changes") { … }
        else if (!rev || !reviewerProfileId) {
          // Approve with nothing to bind to — no delivered revision yet. Record
          // the prose but never claim a pass.
          title = "Approval noted";
          summary = `${roleDisplay} approved, but there is no delivered revision to bind the verdict to yet.`;
        }
```

This is the live VC-5 sentence. No verdict object is written, so `deriveValidation` stays `"none"`.

### 2c. The acceptance gate then refuses

`app/schemas/task-file.schema.ts:581-587`:

```ts
export function acceptanceBlockedReason(fm: ReviewState): string | null {
  const required = requiredReviewers(fm);
  if (!fm.workRevision) {
    return required.length > 0
      ? "No reviewed revision yet — nothing for the required reviewers to approve."
      : null;
  }
```

That string is exactly what `operatorAcceptCompletion` returned as `[noop]` (it calls `acceptanceRefusalFor` at `app/server/tasks/operator-actions.server.ts:2049-2055`, which funnels through `acceptanceRefusalReason`, `task-actions.server.ts:4734-4765`, whose 4th gate is `acceptanceBlockedReason(fm)` at `:4754`).

The verdict gate itself is already no-change-aware but is never reached (`task-actions.server.ts:4707-4723`):

```ts
function verdictGateReason(fm: TaskFrontmatter, taskKey: string): string | null {
  if (!fm.workRevision) return null;
  if (!fm.pr) {
    // R17-2 (F17-L9): unless the branch is verified empty …
    if (fm.noChanges) return null;
    return `${taskKey} has delivered work but no review pull request — deliver the branch & open the PR before accepting.`;
  }
```

Its projection mirror is `app/server/projections/rebuilder.server.ts:313-321`.

### 2d. `noChanges` is claimed, never re-verified, and the flag is the ONLY evidence

Three completion-event writers each hand-roll the no-change sentence off the raw flag:

- `task-actions.server.ts:5234-5237` (`acceptCompletion`):
  ```ts
      (!hasPr
        ? existing.parsed.frontmatter.noChanges
          ? `Human acceptance recorded — **completed with no changes required**. ${input.taskKey} transitioned to **Done**; the goal was already satisfied, so nothing was delivered or merged.`
          : `Human acceptance recorded. ${input.taskKey} transitioned to **Done** (no linked pull request).`
  ```
- `task-actions.server.ts:4270-4273` (`resolvePacket`, `accept_completion`) — same shape, `"Task"` instead of the key.
- `operator-actions.server.ts:2113-2117` (`operatorAcceptCompletion`, full autonomy).

All three use `title: "Completion accepted"`. Nothing re-reads GitHub: the only live acceptance probe is `acceptancePrHeadCheck` (`task-actions.server.ts:4812-4825`), which returns immediately for a task with no PR (`acceptancePrHeadMismatch:4862` → `if (!pr || !rev || pr.state === "merged") return null`). A `noChanges` flag set weeks ago closes the task even if a branch with commits now exists.

### 2e. UI

`app/features/task-detail/accept-confirm.tsx:85-92`:

```tsx
              ) : noChanges ? (
                <>
                  Nothing — <strong>completed with no changes</strong>. The
                  branch is empty, so there is no pull request to merge.
                </>
              ) : (
```

plus a `Revision` row (`:95-104`) that prints `workRevisionSha` as "the delivered revision", a footer hint (`:142`) and a button label `Accept → {terminalName}` (`:157`). The dialog names nothing that was verified.

Prop plumbing: `app/routes/project.task.tsx:203-209, 266-268, 865-867` → `app/features/task-detail/task-detail-page.tsx:80-81, 127-129, 493-495`.

Board acceptance (`app/features/board/board-page.tsx:543-586`, used at `:1418-1429`) states unconditionally: *"Viberr merges the review pull request when GitHub is reachable … Merging is one-way."*

Review queue: `ReviewQueueRow` (`app/server/projections/review-queue.server.ts:43-75`) carries no no-change signal, so `reviewRowSub` (`app/features/review/review-helpers.ts:58-86`) falls through to `t.latestEventText`.

### 2f. Operator blindness

`operatorSnapshot` (`app/server/tasks/operator-actions.server.ts:961-1023`, returned `:1060-1147`) exposes `pr`, `branch`, `liveRuns` — nothing about a no-change outcome. The `accept_completion` tool description (`app/server/tasks/operator-toolkit.server.ts:396-401`) only describes the PR/merge shape.

### 2g. Supporting facts verified for the design

- `getProjectGithubContext` (`app/server/github/github-context.server.ts:45-77`) returns `{status:"ok", client, repo, defaultBranch}` | `{status:"no_repo_configured"}` | `{status:"no_pat_configured", repo}`.
- `taskBranchName(taskKey)` = `taskKey.toLowerCase()` (`app/server/github/branch-sync.server.ts:38-40`).
- Ref probe idiom: `GET /repos/${repo}/git/ref/${encodeRefPath(\`heads/${branch}\`)}` with a 404 = missing ref (`branch-sync.server.ts:205-217`).
- `getBranchCompare(client, repo, base, head)` (`branch-sync.server.ts:72-121`) → `{status:"ok", compare:{aheadBy,…}}` | `missing_ref` | `forbidden` | `rate_limited` | `auth_failed` | `network_unavailable`.
- `nextWorkRevision` (`app/schemas/task-file.schema.ts:670-698`) compares `treeSha` when both are non-null, else `headSha`.
- `applyAcceptanceWrite` (`task-actions.server.ts:5054-5113`) is the shared Done write for `acceptCompletion` and `operatorAcceptCompletion`; `resolvePacket` still writes inline (`:4283-4308` + `:4447`).
- `task_projections` DDL: `db/migrations/0001_baseline.sql:72-112` (migrations stay squashed pre-prod); the upsert is `rebuilder.server.ts:429-500`; the row type + mapper are `app/shared/mapping/task.server.ts:28-60` and `:285-325`; `TaskSummary` is `:100-140`; board/detail read via `SELECT *` (`board-query.server.ts:163`).

---

## 3. Design

**What makes "nothing to deliver" verifiable.** A live read of the remote, performed at the moment of acceptance, that must AFFIRMATIVELY establish one of three bases:

| basis | how it is established |
|---|---|
| `no_repo` | the project has no GitHub repository configured — there is no place for work to exist |
| `no_branch` | `GET git/ref/heads/<task branch>` 404s — no branch was ever created |
| `branch_empty` | the branch exists and `compare(default…branch).ahead_by === 0` |

Anything else — no credential, HTTP error, network failure, rate limit, `ahead_by > 0` — is a **refusal**. The check **fails closed**: "unverifiable" is never "verified". A branch carrying commits produces the explicit refusal `"<key>'s branch \`vc-5\` carries 3 commit(s) ahead of \`main\` — it cannot be completed as 'no changes'."`, which is precisely the property F19-21 demands.

*Rejected alternative:* trusting the stored `fm.noChanges` flag (today's behavior). The flag records a check that happened at some past delivery attempt; the product's honesty rule ("a surface must never claim something the server did not do") makes a stale claim unacceptable for an irreversible stage close. The check is cheap because it only runs when `noChanges && !pr` — the normal PR path pays nothing.

*Rejected alternative:* making the check non-bypassable like `acceptancePrHeadCheck`. The head gate is absolute because it guards an irreversible **merge**. The no-change path merges nothing, so `force` (the audited admin override, DG-2) may bypass it — and when it does, the completion event says the re-check did not run rather than claiming a verification that never happened.

**How the reviewer's verdict binds.** The task mints a **verification revision** — a `workRevision` with `kind: "verified"`, `headSha` = the default-branch head at review time, `branch: null`, `sourceProfileId: null` — at the moment a verdict-capable reviewer approves a task that has nothing to deliver. The existing verdict machinery then works unchanged: the verdict binds by `revisionId`, `deriveValidation` returns `healthy`, `acceptanceBlockedReason` returns null, and `verdictGateReason`'s existing `!fm.pr && fm.noChanges` escape clears the last gate. The reviewer's verdict names the base sha, exactly as the ruling's design question proposes.

*Rejected alternative:* a separate verdict shape for no-change tasks. It would duplicate `requiredReviewers`, `currentVerdicts`, `deriveValidation`, the new-revision staleness rule and the `validation_block_reason` projection — five places where a second review model would drift from the first. `kind` on the one revision type costs a discriminator and two call-site branches.

*Rejected alternative:* skipping the reviewer gate entirely under a narrower condition (`noChanges → acceptance always allowed`). That drops the reviewer's judgment on the floor: R19-1 says the outcome is reached *because* a reviewer approved, and a second required reviewer that has not approved must still hold the task.

**Why the mint happens at verdict time and not earlier.** Minting when the task enters review would be speculative (work may still land). Minting at accept time is too late — `canAccept` is false, so no acceptance affordance ever renders. Verdict time is the one moment where a human-meaningful judgment exists and there is still a human gate after it.

**The mid-run hazard, and its guard.** A reviewer approving while a developer is still working must NOT mint (the branch does not exist *yet*, which is not the same as *never*). The mint therefore requires `deliveringEngagement(fm) === null && fm.branch === null && !fm.pr && !fm.workRevision` — nobody is engaged to deliver, and no branch was ever linked. If a delivery lands later anyway, `nextWorkRevision` mints a new revision (different tree), which staleness-expires the verification verdict, and `openTaskPr` clears `noChanges` (`task-actions.server.ts:3540-3548`) — the state self-heals.

**Which completion event fires.** A distinct `type: "completion"` event titled **`Completed — no changes`** (the merge path keeps `Completion accepted`), whose text names the basis and the sha and never uses the word "merged". One shared builder replaces the three hand-rolled copies at `:5234`, `:4270` and `operator-actions:2113`.

**Operator reachability.** No new recommendation kind. The existing `accept_completion` recommendation now *clears its gate*, so a supervised operator posts the card and a full-autonomy operator closes the task — neither needs `deliver_for_review`. Two honesty fixes ride along: the recommendation's `detail` must not promise a merge for a no-change task, and `operatorSnapshot` gains a `noChange` field so the operator can see the shape instead of opening a "how do we close this out?" packet.

---

## 4. Changes

### 1. `app/schemas/task-file.schema.ts` — discriminate the revision kind

Anchor: `workRevisionSchema`, currently line 438-450.

```ts
// after `sourceProfileId: z.string().nullable().default(null),` (:448)
    /** R19-1: what this revision IS. `delivered` — a commit a delivering run
     *  produced (the only kind before pass 19). `verified` — a VERIFICATION
     *  revision: the default-branch head a reviewer judged on a task that has
     *  nothing to deliver, so the verdict has a subject to bind to and names the
     *  base sha it was given. A verification revision is never "delivered work"
     *  and never carries a task branch (`branch: null`). */
    kind: z.enum(["delivered", "verified"]).default("delivered"),
```

Anchor: the `noChanges` doc comment, lines 510-517 — widen it (two producers now):

```ts
  // R17-2 / R19-1: this task completes with NOTHING to deliver. Two producers:
  // a delivery attempt that found the branch empty (performDelivery), and a
  // reviewer approving a task that never needed a branch (recordAgentCompletion,
  // which also mints the `kind: "verified"` revision). The flag is a CLAIM;
  // `acceptanceNoChangeCheck` re-verifies it live before any Done write.
  noChanges: z.boolean().optional(),
```

Anchor: `acceptanceBlockedReason`, lines 581-587 — **no code change**; it starts returning `null` for these tasks because `workRevision` is now non-null and the verdict is bound. Add a comment pointing at R19-1 so a future reader knows why.

### 2. `app/server/tasks/no-change-completion.server.ts` — NEW module

The whole no-change contract in one file (probe + accept-time gate + event builder), so a fifth Done writer cannot ship without it.

```ts
import type { DatabaseSync } from "node:sqlite";
import type { FileActorRef, TaskFileEvent, TaskFrontmatter } from "~/schemas/task-file.schema";

/** What a passing verification established. */
export interface NoChangeVerification {
  basis: "no_repo" | "no_branch" | "branch_empty";
  /** The default branch checked against (null only for `no_repo`). */
  baseBranch: string | null;
  /** The default-branch head sha at check time (null for `no_repo`). */
  baseSha: string | null;
  /** The task branch that was probed (null for `no_repo`). */
  branch: string | null;
}

export type NoChangeProbe =
  | { status: "verified"; verification: NoChangeVerification }
  | { status: "has_work"; refusal: string }
  | { status: "unverifiable"; refusal: string };

/** Is this acceptance a no-change completion at all? Pure, sync, no I/O. */
export function noChangeApplies(fm: Pick<TaskFrontmatter, "noChanges" | "pr">): boolean {
  return fm.noChanges === true && !fm.pr;
}

/**
 * R19-1 — the LIVE proof that a task has nothing to deliver. Fails CLOSED:
 * only `no_repo` / a missing branch / a branch 0 commits ahead verify. A
 * credential we do not have, an HTTP error, a rate limit or a network failure
 * are refusals, because "we could not look" is not "there is nothing there".
 */
export async function probeNothingToDeliver(
  db: DatabaseSync,
  ctx: { dataRoot?: string },
  projectSlug: string,
  taskKey: string,
): Promise<NoChangeProbe> { … }
```

Probe body (order matters):

1. `readTaskFile` → `branch = fm.branch ?? taskBranchName(taskKey)` (dynamic `await import("~/server/github/branch-sync.server")`).
2. `const gh = getProjectGithubContext(db, projectSlug)` (dynamic import, matching `acceptancePrHeadMismatch:4863-4867`).
   - `no_repo_configured` → `verified`, `{ basis:"no_repo", baseBranch:null, baseSha:null, branch:null }`.
   - `no_pat_configured` → `unverifiable`, refusal: ``${taskKey} could not be closed as "no changes" — this project has no GitHub credential, so `${branch}` could not be checked on the remote. Add a credential and accept again (an admin can force-accept, which records that the check did not run).``
3. `GET /repos/${gh.repo}/git/ref/${encodeRefPath(\`heads/${branch}\`)}`
   - HTTP 404 → resolve the base: `GET …/git/ref/heads/${gh.defaultBranch}`. On ok → `verified` `{basis:"no_branch", baseBranch:gh.defaultBranch, baseSha:object.sha, branch}`. On anything else → `unverifiable` (`… the default branch \`main\` could not be read`).
   - non-ok, non-404 → `unverifiable` (`GitHub could not be reached (…)`).
   - ok → step 4.
4. `getBranchCompare(gh.client, gh.repo, gh.defaultBranch, branch)`
   - `ok` && `compare.aheadBy === 0` → `verified` `{basis:"branch_empty", baseBranch, baseSha: (the base ref sha read in the same pass), branch}`.
   - `ok` && `aheadBy > 0` → `has_work`, refusal: ``${taskKey}'s branch \`${branch}\` carries ${aheadBy} commit(s) ahead of \`${gh.defaultBranch}\` — it cannot be completed as "no changes". Deliver the branch & open the review PR, or archive the task.``
   - anything else → `unverifiable`.
5. Wrap in `try/catch` → `unverifiable` (never throw into an acceptance path).

```ts
export interface AcceptanceNoChangeCheck {
  /** True when this acceptance closes a no-change completion. */
  applies: boolean;
  /** The refusal sentence, or null. Always null when `!applies`. */
  refusal: string | null;
  /** What was verified; null when refused or not applicable. */
  verification: NoChangeVerification | null;
  /** The probed branch — re-asserted in-lock (A2 pattern). */
  branch: string | null;
}

/**
 * The accept-time gate, shaped exactly like `acceptancePrHeadCheck`: a live read
 * that cannot run inside the write lock, pinned to the state it verified so the
 * Done writer can re-assert it under the lock.
 */
export async function acceptanceNoChangeCheck(
  db: DatabaseSync,
  ctx: { dataRoot?: string },
  projectSlug: string,
  taskKey: string,
): Promise<AcceptanceNoChangeCheck>;

/** In-lock half: the state must still be the state that was verified. */
export function assertVerifiedNoChangeStillApplies(
  fm: TaskFrontmatter,
  check: AcceptanceNoChangeCheck,
  taskKey: string,
): void;   // throws AppError.conflict when noChangeApplies(fm) !== check.applies

/** The ONE "Completed — no changes" completion event (all three writers). */
export function noChangeCompletionEvent(input: {
  taskKey: string;
  actor: FileActorRef;
  occurredAt: string;
  by: "human" | "operator";
  /** null ⇒ the acceptance was FORCED past an unverifiable check. */
  verification: NoChangeVerification | null;
}): TaskFileEvent;
```

`noChangeCompletionEvent` text (title always `"Completed — no changes"`, `type: "completion"`, `toAgent:false`, `evidence:null`):

| verification | text |
|---|---|
| `no_branch` | ``{Human acceptance\|Operator acceptance under **full-autonomy** policy} recorded — **VC-5 completed with no changes**. Nothing was delivered and nothing was merged: no `vc-5` branch exists on the remote, checked against `main` at `abc1234def56` when this was accepted.`` |
| `branch_empty` | ``… branch `vc-5` carries no commits ahead of `main` (re-checked at acceptance), so there was no pull request to merge.`` |
| `no_repo` | ``… this project has no GitHub repository, so there was nothing to deliver or merge.`` |
| `null` (forced) | ``Admin force-accept recorded — **VC-5 closed as "no changes"**. The remote re-check could NOT be performed, so nothing verified the branch state; nothing was merged.`` |

### 3. `app/server/tasks/task-actions.server.ts` — mint the verification revision

Anchor: `recordAgentCompletion`, between `prepareAgentReplyEvent` (line 1906-1912) and `updateTaskFile` (line 1937).

```ts
  // R19-1: a verdict-capable reviewer approving a task that has NOTHING to
  // deliver had nothing to bind to — the verdict was dropped and acceptance
  // dead-ended on "No reviewed revision yet" (F19-21, live VC-5). Mint a
  // VERIFICATION revision pinned to the default-branch head so the verdict binds
  // and names the base sha it judged. Preconditions are deliberately narrow: no
  // delivering engagement, no branch, no PR, no revision — a reviewer approving
  // while a developer is mid-run must not mark the task "no changes".
  let noChangeMint: NoChangeVerification | null = null;
  if (verdict === "approve" && actorRef.kind === "agent") {
    const pre = readTaskFile(taskRef(ctx, projectSlug, taskKey))?.parsed.frontmatter;
    if (
      pre &&
      !pre.workRevision &&
      !pre.pr &&
      pre.branch === null &&
      deliveringEngagement(pre) === null &&
      pre.engagements.some(
        (e) => e.profileId === actorRef.profileId && !e.delivers && e.verdictCapable,
      )
    ) {
      const probe = await probeNothingToDeliver(db, ctx, projectSlug, taskKey);
      if (probe.status === "verified") noChangeMint = probe.verification;
    }
  }
```

Inside the `updateTaskFile` updater, immediately before `const rev = parsed.frontmatter.workRevision;` (current line 1944):

```ts
        // In-lock re-check: a delivery could have landed during the probe.
        if (
          noChangeMint &&
          !parsed.frontmatter.workRevision &&
          !parsed.frontmatter.pr &&
          parsed.frontmatter.branch === null &&
          deliveringEngagement(parsed.frontmatter) === null
        ) {
          parsed.frontmatter.workRevision = {
            id: newId("rev"),
            headSha: noChangeMint.baseSha ?? `${projectSlug}:no-repo`,
            treeSha: null,
            branch: null,
            createdAt: new Date().toISOString(),
            sourceProfileId: null,
            kind: "verified",
          };
          parsed.frontmatter.noChanges = true;
        } else {
          noChangeMint = null; // nothing was minted — keep the copy honest
        }
```

(For `basis:"no_repo"` there is no sha to pin; the probe returns `baseSha:null` and the mint is skipped in that case — restrict the mint to `noChangeMint.baseSha !== null` and let a repo-less project keep today's already-acceptable path, where `acceptanceBlockedReason` only fires if a required reviewer exists. **Decision: require `baseSha !== null` for the mint**; drop the `?? \`${projectSlug}:no-repo\`` fallback above — a synthesized sha would be a fabricated fact.)

Then the copy branch at lines 1968-1972:

```ts
        } else if (!rev || !reviewerProfileId) {
          title = "Approval noted";
          summary = `${roleDisplay} approved, but there is no delivered revision to bind the verdict to yet.`;
        } else if (validation === "healthy") {
-          title = "Review passed";
-          summary = `${roleDisplay} approved the work.`;
+          title = "Review passed";
+          summary = noChangeMint
+            ? `${roleDisplay} approved: there is nothing to deliver — no \`${noChangeMint.branch}\` branch exists on the remote, verified against \`${noChangeMint.baseBranch}\` at \`${noChangeMint.baseSha!.slice(0, 12)}\`. Accepting completes this task with no changes.`
+            : `${roleDisplay} approved the work.`;
        } else {
```

New imports in this file: `newId` from `~/shared/ids/new-id.server`, and `probeNothingToDeliver`, `acceptanceNoChangeCheck`, `assertVerifiedNoChangeStillApplies`, `noChangeApplies`, `noChangeCompletionEvent`, `type AcceptanceNoChangeCheck`, `type NoChangeVerification` from `./no-change-completion.server`. `deliveringEngagement` is already imported (used at `:3501`).

### 4. `task-actions.server.ts` — `verdictGateReason` never calls a verification revision "delivered work"

Anchor: lines 4711-4717.

```ts
   if (!fm.pr) {
-    if (fm.noChanges) return null;
+    // R17-2 / R19-1: a verified empty branch, or a VERIFICATION revision (a
+    // reviewer judged the base sha because there was nothing to deliver).
+    if (fm.noChanges || fm.workRevision.kind === "verified") return null;
     return `${taskKey} has delivered work but no review pull request — deliver the branch & open the PR before accepting.`;
   }
```

Mirror in `app/server/projections/rebuilder.server.ts:314-320` (same two lines, `fm.key` instead of `taskKey`).

### 5. `task-actions.server.ts` — `acceptCompletion` runs the check and uses the shared event

Anchor: `acceptCompletion`, after the `headCheck` block (lines 5165-5171).

```ts
  // R19-1: a `noChanges` task closes WITHOUT a merge, so the claim must be
  // re-proved live at the moment of acceptance — a stale flag must never close a
  // task whose branch has since gained commits (F19-21). Fails closed. `force`
  // may bypass it (nothing merges, unlike the head gate) and the completion
  // event then says the check did not run.
  const noChange = await acceptanceNoChangeCheck(db, ctx, input.projectSlug, input.taskKey);
  if (noChange.refusal && !input.force) throw AppError.conflict(noChange.refusal);
```

Anchor: the event literal, lines 5228-5246 — replace the `!hasPr && noChanges` arm:

```ts
  const event: TaskFileEvent = noChange.applies
    ? noChangeCompletionEvent({
        taskKey: input.taskKey,
        actor: humanActorRef(db, actor),
        occurredAt: new Date().toISOString(),
        by: "human",
        verification: noChange.verification,
      })
    : { …unchanged existing literal, with the `noChanges` ternary at :5235-5237 deleted… };
```

Thread it into the write (lines 5247-5255): add `noChangeCheck: noChange,` next to `headCheck`.

### 6. `task-actions.server.ts` — `applyAcceptanceWrite` enforces for every caller

Anchor: `applyAcceptanceWrite`, input type at lines 5057-5067 and body at 5069-5088.

```ts
     headCheck?: AcceptancePrHeadCheck;
+    /** R19-1: the no-change verification (re-read when absent; `skipInLockRecheck`
+     *  — the audited force override — bypasses its refusal, never the head gate). */
+    noChangeCheck?: AcceptanceNoChangeCheck;
   },
 ): Promise<void> {
   const project = loadProjectContext(ctx, input.projectSlug);
   const headCheck = input.headCheck ?? (await acceptancePrHeadCheck(…));
   if (headCheck.refusal) throw AppError.conflict(headCheck.refusal);
+  const noChange =
+    input.noChangeCheck ??
+    (await acceptanceNoChangeCheck(db, ctx, input.projectSlug, input.taskKey));
+  if (noChange.refusal && !input.skipInLockRecheck) {
+    throw AppError.conflict(noChange.refusal);
+  }
   await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
     assertVerifiedHeadStillApplies(parsed.frontmatter, headCheck, input.taskKey);
+    assertVerifiedNoChangeStillApplies(parsed.frontmatter, noChange, input.taskKey);
```

### 7. `task-actions.server.ts` — `resolvePacket`'s inlined accept

Anchor: after the `headCheck` block, lines 4204-4210.

```ts
      if (headCheck.refusal) throw AppError.conflict(headCheck.refusal);
+      const noChange = await acceptanceNoChangeCheck(db, ctx, input.projectSlug, input.taskKey);
+      if (noChange.refusal) throw AppError.conflict(noChange.refusal);
```

Anchor: the event literal, lines 4264-4282 — same swap as §5 (`by: "human"`, `actor: human`); delete the `noChanges` ternary at `:4271-4273`. Anchor: the `mutate` closure at lines 4283-4292 — add after `assertVerifiedHeadStillApplies(...)`:

```ts
        assertVerifiedNoChangeStillApplies(fm, noChange, input.taskKey);
```

### 8. `app/server/tasks/operator-actions.server.ts` — full-autonomy accept + honest card

Anchor: `operatorAcceptCompletion`, lines 2099-2122.

```ts
   const hasPr = !!file.parsed.frontmatter.pr;
+  // R19-1: the operator closes a no-change task through the same live re-check.
+  const noChange = await acceptanceNoChangeCheck(db, ctx, input.projectSlug, input.taskKey);
+  if (noChange.refusal) return { outcome: "noop", message: noChange.refusal };
   const driftNote = revisionDriftNote(file.parsed.frontmatter);
   await applyAcceptanceWrite(db, ctx, {
     …,
+    noChangeCheck: noChange,
-    event: { … the three-way ternary … },
+    event: noChange.applies
+      ? noChangeCompletionEvent({
+          taskKey: input.taskKey,
+          actor: { kind: "operator" },
+          occurredAt: new Date().toISOString(),
+          by: "operator",
+          verification: noChange.verification,
+        })
+      : { …existing literal with the `noChanges` arm at :2115-2117 deleted… },
   });
```

Anchor: the recommend branch, lines 2062-2075 — the `detail` string currently promises a merge:

```ts
    const doneName = stageNameOf(ctx, input.projectSlug, doneStageId);
+   const noChange = noChangeApplies(file.parsed.frontmatter);
    await addRecommendation(db, ctx, …, {
        kind: "accept_completion",
        toStageId: doneStageId,
-       label: `Accept completion — move ${input.taskKey} to ${doneName}`,
+       label: noChange
+         ? `Complete ${input.taskKey} with no changes — move it to ${doneName}`
+         : `Accept completion — move ${input.taskKey} to ${doneName}`,
      },
-     `The review is clean and the work meets the goal. Accepting completion moves ${input.taskKey} to ${doneName} and merges the review PR when GitHub is reachable — otherwise it records the PR as accepted (merge pending).`,
+     noChange
+       ? `The review is clean and there is nothing to deliver — no branch carries work for ${input.taskKey}. Accepting moves it to ${doneName} as **completed with no changes**; nothing is merged, and the branch state is re-checked when you confirm.`
+       : `The review is clean and the work meets the goal. Accepting completion moves ${input.taskKey} to ${doneName} and merges the review PR when GitHub is reachable — otherwise it records the PR as accepted (merge pending).`,
    );
```

Anchor: `OperatorTaskSnapshot`, after `branch` (interface line 1008, value line 1126):

```ts
  /** R19-1: this task is a no-change completion — nothing was delivered and
   *  there is nothing to merge. Accept it with `accept_completion`; do NOT call
   *  `deliver_for_review` and do NOT open a packet asking how to close it out. */
  noChanges: boolean;
```
value: `noChanges: noChangeApplies(fm),`

### 9. `app/server/tasks/operator-toolkit.server.ts` — tool description

Anchor: `accept_completion` description, line 399. Append:

> ` A task with NOTHING to deliver (get_task \`noChanges: true\` — no branch, no PR) is accepted as **completed with no changes**: nothing is merged, and the server re-checks the remote branch state before closing. Never call deliver_for_review for such a task and never open a decision packet asking a human how to close it out.`

### 10. `app/server/tasks/specialist-run.server.ts` — do not pin a verification revision as a review subject

Anchor: lines 907-913.

```ts
   const reviewSubject =
-    !delivers && existing.parsed.frontmatter.workRevision
+    !delivers &&
+    existing.parsed.frontmatter.workRevision &&
+    // R19-1: a VERIFICATION revision is the base-branch head, not delivered
+    // work — pinning it would tell a re-run reviewer to "judge the delivered
+    // revision <base sha>", which delivers nothing.
+    existing.parsed.frontmatter.workRevision.kind !== "verified"
       ? { headSha: …, prNumber: … }
       : null;
```

### 11. Projection: carry the outcome kind

- `db/migrations/0001_baseline.sql:92` — after `validation_block_reason TEXT,`:
  ```sql
  -- R19-1: the "Completed — no changes" outcome kind, NULL for every ordinary
  -- task. 'verified' = a reviewer approved with nothing to deliver (no branch);
  -- 'empty_branch' = a delivery attempt found the branch 0 commits ahead.
  no_change TEXT CHECK (no_change IN ('verified', 'empty_branch')),
  ```
- `app/server/projections/rebuilder.server.ts:429-500` — add `no_change` to the column list, one `?` to the VALUES list (32 → 33), `no_change = excluded.no_change` to the DO UPDATE list, and the value after `acceptanceBlockReason(fm)` (line 474):
  ```ts
    fm.noChanges
      ? fm.workRevision?.kind === "verified" ? "verified" : "empty_branch"
      : null,
  ```
- `app/shared/mapping/task.server.ts:39` — `no_change: "verified" | "empty_branch" | null;` on `TaskProjectionRow`; `:120` — `noChange: "verified" | "empty_branch" | null;` on `TaskSummary`; `:304` — `noChange: row.no_change,`.

### 12. `app/routes/project.task.tsx` — drop the file-read prop

Anchor: lines 203-209 and 266-268 and 865-867. Delete `const noChanges = …` (:207) and the `noChanges,` loader field (:267) and the `noChanges={loaderData.noChanges}` prop (:866). The dialog reads `task.noChange` from the projection instead — one source, no drift between the projection row and the file read in the same loader.

### 13. `app/features/task-detail/task-detail-page.tsx`

Delete `noChanges = false,` (:81), the prop type (:127-129) and `noChanges={noChanges}` (:495). `AcceptConfirm` already receives `task`.

### 14. `app/features/task-detail/accept-confirm.tsx` — the no-change confirm

Replace the `noChanges` prop (`:20`, `:33-34`) with reads of `task.noChange`, and branch the dialog:

```tsx
  const noChange = task.noChange;           // "verified" | "empty_branch" | null
  const terminalName = …;                   // unchanged
```

- Heading (`:59`): `{force ? "Force-accept this completion?" : noChange ? "Complete this task with no changes?" : "Accept this completion?"}`
- `aria-label` (`:50`): `(force ? "Force-accept " : noChange ? "Complete " : "Accept ") + task.key`
- `Merges` row (`:85-89`) →
  ```tsx
              ) : noChange ? (
                <>
                  Nothing — <strong>completed with no changes</strong>. There is
                  no pull request, and nothing is written to{" "}
                  <span className="mono">{defaultBranch}</span>.
                </>
              ) : (
  ```
- Replace the `Revision` row (`:95-104`) when `noChange` is set with a `Verified` row:
  ```tsx
          {noChange ? (
            <div className="obs">
              <span className="k">Verified</span>
              <span>
                {noChange === "verified" ? (
                  <>
                    No branch for <span className="mono">{task.key}</span> exists
                    on the remote — checked against{" "}
                    <span className="mono">{defaultBranch}</span>
                    {workRevisionSha ? (
                      <> at <span className="mono">{workRevisionSha.slice(0, 12)}</span></>
                    ) : null}
                    .
                  </>
                ) : (
                  <>
                    Branch <span className="mono">{task.branch ?? task.key.toLowerCase()}</span>{" "}
                    carries no commits ahead of{" "}
                    <span className="mono">{defaultBranch}</span>.
                  </>
                )}
              </span>
            </div>
          ) : ( …the existing Revision row… )}
  ```
- Footer hint (`:137-143`): add a `noChange` arm before the `task.pr` arm — `"Nothing merges. The branch state is re-checked when you confirm — if commits have appeared since, the acceptance is refused."`
- Confirm button label (`:155-157`): `noChange ? \`Complete ${task.key} — no changes\` : \`Accept → ${terminalName}${task.pr ? " & merge" : ""}\``

### 15. `app/features/board/board-page.tsx` — the board's acceptance confirm

Anchor: `AcceptOnBoardConfirm` (`:543-586`) — add a `noChange: boolean` prop and branch the `mh-sub` (`:566-570`) and the footer fine print (`:576-578`):

```tsx
          {noChange ? (
            <>Moving {taskKey} into {stageName} completes it with <strong>no changes</strong> —
            nothing is delivered and nothing is merged. Viberr re-checks the branch state before
            closing it.</>
          ) : ( …the existing merge sentence… )}
```

Call site (`:1418-1429`): `noChange={allTasks.find((t) => t.key === pendingAccept.taskKey)?.noChange != null}`.

### 16. `app/server/projections/review-queue.server.ts` + `app/features/review/review-helpers.ts`

- `ReviewQueueRow` (`:43-75`): add `noChange: "verified" | "empty_branch" | null;` and map it at `:141` (`noChange: t.noChange,`).
- `ReviewRowView` (`review-helpers.ts:4-24`): same field.
- `reviewRowSub` (`:58-86`): insert after the `t.blockReason` arm (`:75`) and before the packet arm:
  ```ts
    // R19-1: a task with nothing to deliver has no PR and no packet, so the
    // subline used to fall through to the newest timeline note. Name the outcome
    // the acceptance will actually perform.
    if (t.noChange) {
      return t.noChange === "verified"
        ? "Nothing to deliver — no branch was created. Accepting completes it with no changes; nothing merges."
        : "The branch carries no commits ahead of the default branch. Accepting completes it with no changes; nothing merges.";
    }
  ```

---

## 5. Tests

### `app/server/tasks/no-change-completion.server.test.ts` (NEW)

Harness: `createTestDbContext` + `setupTestStore` + `writeTask`/`baseTaskFrontmatter` (as `acceptance-closed-pr.server.test.ts:1-32`), with `vi.mock("~/server/github/github-context.server")` returning a fake `client.request` (the pattern at `delivery-decision.server.test.ts:58-63, 936-947`).

| describe / it | asserts | CANARY |
|---|---|---|
| `probeNothingToDeliver` → *"a missing task branch verifies against the default-branch head"* | `status:"verified"`, `basis:"no_branch"`, `baseSha` = the sha the `heads/main` ref returned, `branch:"vib-1"` | make the `heads/<branch>` 404 arm return `unverifiable` — the probe stops verifying |
| *"a branch AHEAD of the default branch is NOT a no-change task"* | `status:"has_work"`, refusal contains `` `vib-1` `` and `3 commit` | delete the `aheadBy > 0` arm so every existing branch verifies |
| *"an unreachable GitHub fails CLOSED"* (`request` → `{ok:false, kind:"network"}`) | `status:"unverifiable"`, refusal names the credential/reachability, **never** `verified` | return `{status:"verified"}` in the catch/network arm |
| *"a missing credential fails CLOSED"* (`no_pat_configured`) | `unverifiable` | treat `no_pat_configured` like `no_repo_configured` |
| *"a project with no repository has nothing to deliver"* (`no_repo_configured`) | `verified`, `basis:"no_repo"`, `baseSha:null` | make `no_repo_configured` unverifiable — this also breaks the pre-existing R17-2 test at `acceptance-closed-pr.server.test.ts:253`, which is the point |
| `acceptanceNoChangeCheck` → *"does not touch GitHub for an ordinary task"* (task with a PR) | `applies:false`, `refusal:null`, and the `request` spy was never called | drop the `noChangeApplies` early return |

### `app/server/tasks/no-change-acceptance.server.test.ts` (NEW) — the R19-1 end-to-end

| it | asserts | CANARY |
|---|---|---|
| *"R19-1: a reviewer approving a task with nothing to deliver mints a verification revision and binds the verdict"* — drive `recordAgentCompletion` with `verdict:"approve"` for a `verdictCapable` non-delivering engagement on a task with `workRevision:null, branch:null, pr:null` and no deliverer | `fm.workRevision.kind === "verified"`, `headSha` = the mocked base sha, `branch === null`; `fm.verdicts[0].revisionId === fm.workRevision.id`; `fm.validation === "healthy"`; `fm.noChanges === true`; the `quality` event title is `"Review passed"` and its text contains ``` `main` ``` and the 12-char sha | remove the mint block — the event reverts to `"Approval noted"` and `validation` stays `"none"` (this is the live VC-5 state) |
| *"R19-1: a reviewer approving while a deliverer is engaged mints nothing"* (same, but one engagement has `delivers:true`) | no `workRevision`, `noChanges` falsy, title `"Approval noted"` | drop the `deliveringEngagement(pre) === null` precondition |
| *"R19-1: acceptance closes it to Done with the no-change completion event and merges nothing"* — `acceptCompletion` as a maintainer | `stage === doneStageId`; `pr === null`; the newest `completion` event's **title** is `"Completed — no changes"`; its text contains `no changes` and the base sha and does **not** match `/merged/`; `mergeTaskPr` was not called | delete the `noChange.applies` arm from the event builder — the title falls back to `"Completion accepted"` |
| *"R19-1 fails closed: a branch that gained commits refuses the acceptance"* — seed `noChanges:true` + a verification revision, mock the ref as present and compare `ahead_by: 2` | `acceptCompletion` rejects with 409 whose message names the branch and `2 commit`; `stage` unchanged; no completion event | remove the `acceptanceNoChangeCheck` call from `acceptCompletion` **and** from `applyAcceptanceWrite` (both must be neutered — that is the point of the two-layer guard) |
| *"R19-1: an unverifiable remote refuses, and force-accept says the check did not run"* — network failure | plain `acceptCompletion` 409s; `forceAcceptCompletion` reaches Done and the completion text contains `could NOT be performed`; `task.acceptance.forced` audit recorded | make `skipInLockRecheck` also skip the honesty branch (pass a non-null `verification` when forced) — the event would claim a verification |
| *"R19-1: the packet path runs the same check"* — an `accept_completion` packet on the same fixture with `ahead_by: 2` | `resolvePacket` rejects 409 with the same sentence | remove the check from `resolvePacket` |
| *"R19-1: the operator reaches the outcome without deliver_for_review"* — supervised operator | `outcome:"recommended"`; the recommendation `label` matches `/no changes/` and its `detail` does **not** contain `merges the review PR` | restore the old single `detail` string |
| *"R19-1: full autonomy closes it with the no-change event"* | `stage === "done"`, completion title `"Completed — no changes"` | delete the operator's `noChange.applies` arm |
| *"F19-21 regression: the old dead end"* — the exact VC-5 fixture (reviewer engaged, verdict approve) then `operatorAcceptCompletion` | `outcome !== "noop"` and the message does **not** contain `No reviewed revision yet` | revert §3 (the mint) — the noop sentence returns verbatim |

### `app/server/projections/rebuilder.server.test.ts`

*"R19-1: a verification revision projects a null block reason and a `no_change` kind"* — write a task with `workRevision.kind:"verified"`, an approving verdict, `noChanges:true`; assert `validation_block_reason IS NULL` and `no_change === "verified"`; and a delivered-empty-branch task projects `"empty_branch"`.
**CANARY:** remove `|| fm.workRevision.kind === "verified"` from `acceptanceBlockReason` *and* the `no_change` value expression → both assertions fail.

### `app/features/task-detail/task-detail-components.test.tsx`

New `describe("AcceptConfirm — R19-1 'Completed — no changes'")` (add `import { AcceptConfirm } from "./accept-confirm";`):

- *"names what was verified and promises no merge (verified kind)"* — `task.noChange === "verified"`, `workRevisionSha` set: the `Merges` row contains `completed with no changes`; a `Verified` row exists containing `main` and the 12-char sha; the heading is `Complete this task with no changes?`; the confirm button text contains `no changes`; the foot hint does **not** contain `Merging is one-way`.
- *"names the empty branch (empty_branch kind)"* — the `Verified` row contains the branch name and `no commits ahead`.
- *"an ordinary PR acceptance is unchanged"* — `task.pr` set, `noChange: null`: the button reads `Accept → Done & merge` and no `Verified` row is rendered.

**CANARY:** revert `accept-confirm.tsx` to the single `noChanges` sentence → the `Verified`-row and heading assertions fail while the PR test still passes.

### `app/features/review/review-helpers.test.ts`

*"R19-1: a no-change row names the outcome instead of the newest timeline note"* — a row with `noChange:"verified"`, `blockReason:null`, `pr:null`, `latestEventText:"**Validation:** healthy. …"`: `reviewRowSub` returns the `Nothing to deliver …` sentence.
**CANARY:** delete the `t.noChange` arm → the subline falls back to the stripped timeline text.

### `app/features/board/board-page.test.tsx`

*"R19-1: the board confirm does not promise a merge for a no-change task"* — a card whose `noChange` is `"verified"` dragged/moved into Done: the dialog text contains `no changes` and not `merges the review pull request`.
**CANARY:** drop the `noChange` prop from the call site → the merge sentence renders.

### Already-covered by existing suites (must stay green, no edits expected)

`app/features/copy-ban.test.ts` (no banned term is introduced), `app/server/tasks/acceptance-closed-pr.server.test.ts:253` (its project has `repo: null` → `no_repo` verifies), `app/server/tasks/delivery-decision.server.test.ts:316-320` (the delivery-side `noChanges` producer is untouched).

---

## 6. Risks / call sites

**Type changes that `tsc` will surface (every one must be updated):**
- `WorkRevision` gains `kind` (defaulted, so existing task.md files parse unchanged, but every **literal** in tests that constructs a `WorkRevision` object typed as `WorkRevision` must add it — `z.infer` makes it required on the output type). Known literals: `acceptance-closed-pr.server.test.ts:270-277, 310-317`, `delivery-decision.server.test.ts` (`revision()` helper), `agent-completion.server.test.ts`, `workspace-delivery.server.ts:357-364` (add `kind: "delivered"`), plus any `test-support` fixture builder. Grep `treeSha:` to find them all.
- `TaskSummary.noChange` is required → every hand-built `TaskSummary`/`TaskDetail` fixture in jsdom tests needs `noChange: null`. Grep `displayReadiness:` in `*.test.tsx` for the fixture builders.
- `ReviewQueueRow.noChange` / `ReviewRowView.noChange` → `review-page.test.tsx` and `review-route.server.test.ts` fixtures.
- `OperatorTaskSnapshot.noChanges` → `operatorSnapshot` assertions in `acceptance-closed-pr.server.test.ts` (it imports `operatorSnapshot`).
- Deleting the `noChanges` prop from `TaskDetailPage`/`AcceptConfirm` breaks any test passing it — grep `noChanges={`.

**Projection rebuild.** The new `no_change` column goes into `db/migrations/0001_baseline.sql` (migrations stay squashed pre-prod, pass-11 ruling). Any existing dev/`docker-data` database predates it: the store is file-canonical, so the recovery is a baseline re-init + `rebuildAll` — note in the pass log that `docker-data` needs re-baselining before the live canary, and that re-baselining wipes user ids (known fact from pass 11).

**Behavior changes that are deliberate, not regressions:**
- A `noChanges` task can no longer be accepted while GitHub is unreachable or uncredentialed. Force-accept remains the exit and the event says the check did not run. Ruling 43's "verified empty diff" precondition is what makes this correct; state it in the ruling promotion.
- A repo-less project verifies trivially (`no_repo`) — this keeps the existing "planning / non-repo work stays acceptable" behavior (`verdictGateReason:4704`) and keeps `acceptance-closed-pr.server.test.ts:253` green.
- A task with **two** required reviewers where only one approved still blocks — `acceptanceBlockedReason`'s missing-approval arm is untouched. That is intended.

**Not in scope (record, do not silently widen):** a task with **no** required reviewer at all still closes through the plain "Done (no linked pull request)" event — R19-1 is scoped to "when a reviewer approves". If the owner later wants a human to declare "no changes" without a reviewer, that is a new packet/tool, not a widening of this mint.

**Adjacent findings this touches — coordinate:**
- **F19-3 / F19-7** (rec-Apply and packet-option acceptance ship no confirm dialog) are a different cluster, but both will need the no-change dialog variant once they gain their dialogs. `decision-packet.tsx:329` and the recommendation Apply path should reuse `task.noChange` the same way; flag it to that cluster rather than duplicating copy.
- **F19-1** (delivery leaves no actionable next step) overlaps at the recommendation layer only; no shared code.

**Docs to update:**
- `docs/architecture/decisions.md` — add ruling **55. R19-1 (2026-08-06)** stating: the outcome is reached by reviewer approval + a live fail-closed remote check; the verification revision is the binding mechanism; force-accept may bypass the check because nothing merges, and the event must then say so. Amend ruling **43** (`:367-374`) with `Amended by ruling 55 (2026-08-06): …` per ruling 44's canon rule, and strike its "(on this pass's implementation backlog)" tail.
- `docs/architecture/file-formats.md:159-165` — add `kind: verified` to the `workRevision` block and document `noChanges:` (currently absent from the frontmatter sample entirely) plus a bullet under `:249` explaining that a verification revision is not delivered work.
- `planning/discovery-2026-08-06-pass19/NOTES.md` — disposition F19-21 as FIXED and mark UC-20 ✓ after the live canary (create a verification-only task on the running app, let the reviewer approve, confirm the dialog, accept, then re-run with a pushed commit on the task branch to prove the refusal).