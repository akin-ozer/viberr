# W3 handbacks — governance & delivery

Requests for changes OUTSIDE W3's ownership list, in the order they matter.
Everything here is written so it can be applied without re-deriving anything.

---

## 1. R14-3 archive — the projection column + the three filters (BLOCKED, needs a lead decision)

**Status:** the archive SHIPS server-side (`setTaskArchived` in
`app/server/tasks/task-actions.server.ts`, RBAC `approve-transition`, timeline note,
audit `task.archived`/`task.unarchived`, withdraws the open packet + recommendations,
restorable, acceptance refused while archived). What is NOT done is hiding archived
tasks from the **board's default view** and the **review queue** — because every read
model reads `task_projections`, and that table has no `archived` column.

**Why I did not just add it.** The column has to come from `db/migrations/0001_baseline.sql`
(the squashed pre-prod baseline, per the standing ruling). The dev DB at
`docker-data/state/projection.sqlite` already records `0001_baseline.sql` as applied, so
editing the baseline does NOT reach it — the next task write would hit
`no such column: archived` and the running app (the one used for live re-verification)
would break. Re-baselining wipes user ids and therefore every project membership. That is
a call for the lead, not a subagent, and it is why this is a handback rather than an edit.

**Two ways to land it:**

- **(a) baseline + re-baseline the dev DB** — edit `0001_baseline.sql`, then wipe and
  rebuild `docker-data/state/projection.sqlite`. Costs the dev users/PATs/runs.
- **(b) one additive migration** `db/migrations/0002_task_archived.sql` containing
  `ALTER TABLE task_projections ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;` — applies
  itself at boot to the dev DB and to fresh stores, nothing is lost, and it can be squashed
  into the baseline at PR time. (This is a schema change, not a compatibility shim.)

**Then, four small edits:**

1. `app/server/projections/rebuilder.server.ts` — add `archived` to the INSERT column list,
   to the `ON CONFLICT … DO UPDATE SET` list (`archived = excluded.archived`), and
   `fm.archived ? 1 : 0` to the bound values (next to `fm.urgent ? 1 : 0`).
2. `app/shared/mapping/task.server.ts` — carry `archived: row.archived === 1` onto
   `TaskSummary` (and `archived: number` onto `TaskProjectionRow`).
3. `app/server/projections/board-query.server.ts` — `listProjectTasks(db, slug, opts?: { includeArchived?: boolean })`
   filtering `WHERE … AND archived = 0` unless asked, and `getBoard` passing the flag
   through so W4 can render an "Archived" view. Everything downstream (review queue, board
   columns) inherits the filter, because both go through `listProjectTasks`.
4. `app/server/projections/decisions.server.ts` (**W3-owned — say the word and I'll do it
   in a follow-up**) — add `AND archived = 0` to the open-decision query. Note the archive
   action already withdraws the packet + recommendations, so an archived task drops out of
   the inbox today; this is belt-and-braces for tasks archived by a file edit.

`app/features/home/home-query.server.ts` counts tasks straight from `task_projections`
(W4's file) — same `archived = 0` predicate there.

---

## 2. GV-03 — stale "Lightweight (todo/doing/done)" prose in live code

Three doc comments describe a preset deleted in pass 13. None of the three files is mine.

- `app/shared/workflow/stage-roles.ts:8` — "A board carried over from the deleted 3-stage
  preset is `todo / doing / done`" reads as though such boards ship. Suggested: *"Stages are
  per-project and freely renamed/reordered, so NOTHING in the app may hard-code the literal
  ids `triage` / `ready` / `review` / `done` — a customized board can be anything."*
- `app/server/projections/review-queue.server.ts:14` — "on a Lightweight board
  (`todo/doing/done`) the review role is `doing`, and a literal-"review" filter left this
  queue permanently empty (pass-4 WI-1)". Suggested: keep the WI-1 lesson, drop the preset:
  *"on a board whose review stage is not literally named `review`, a literal-id filter left
  this queue permanently empty while the rail showed a count (pass-4 WI-1)."*
- `app/routes/project.review.tsx:37` — same substitution.

---

## 3. LV-02 tail — the operator must not PROPOSE or PERFORM acceptance off-boundary

W3 closed both human writers (`acceptCompletion`, `resolvePacket`) with one shared gate.
The operator's own writer and its recommendation live in
`app/server/tasks/operator-actions.server.ts` (not mine). I exported the entry point they
need:

```ts
import { acceptanceRefusalFor } from "~/server/tasks/task-actions.server";
```

- `operatorAcceptCompletion` (:1593, the full-autonomy direct-Done branch at :1666-1690) —
  add alongside the three gates it already re-checks:
  ```ts
  const refusal = acceptanceRefusalFor({ projectSlug, taskKey }, ctx);
  if (refusal) throw AppError.conflict(refusal);
  ```
- `addRecommendation` (:387-463) — refuse to record a `accept_completion` recommendation
  when `acceptanceRefusalFor(...)` is non-null, and narrate the refusal instead. This is the
  half of LV-02 that produced the live defect: the operator offered "Accept completion" on a
  **Triage** task with no branch, no PR and no reviewer, and the card rendered as a normal
  one-click action. The server now refuses the click; the card should never appear.

---

## 4. LV-06 + R14-2 + R14-3 — the task-page UI (W4)

Server side is ready; these are renders.

- **Acceptance affordance (LV-06).** `resolveAcceptanceAffordance({ projectSlug, taskKey,
  viewerUserId }, ctx)` (exported from `task-actions.server.ts`) returns
  `{ hasAuthority, atBoundary, blockedReason, canAccept }`. Add it to the
  `app/routes/project.task.tsx` loader and render an explicit **Accept completion** control
  when `canAccept`; when `hasAuthority && atBoundary && blockedReason`, render it disabled
  with `blockedReason` as the reason. Wire it to the existing `transition` intent targeting
  the terminal stage (that path IS acceptance — `transitionStage` reroutes a human move to
  the terminal stage into `acceptCompletion`), or add an `accept` intent that calls it
  directly. Today the page only offers acceptance when an operator recommendation happens to
  exist, which is exactly the live mismatch: the queue said "Waiting on your acceptance
  (1 of 1)" and the task page offered nothing.
- **Owner decision authority (R14-2).** `task-detail-page.tsx:1375` gates Apply/Dismiss on
  `canApply = canRunAgents` and `:890` hides the stage menu on `canTransition`. The server
  now admits the task's owner (contributor+) at `applyRecommendation`,
  `dismissRecommendation` and `resolvePacket`, and `decisionsRequiring` counts those rows as
  theirs — so the owner must see Apply/Dismiss on their own task. Also fix the two false
  copy strings the doc caught: the execution-profile row telling a contributor-owner
  "Maintainer or admin only" (`:306-310`) and the comment claiming `accept_completion` packet
  options 409 for owners (`:1243-1247`).
- **Archive (R14-3).** New intent on `app/routes/project.task.tsx`:
  ```ts
  case "archive": {
    const { toast } = await setTaskArchived(
      db, { projectSlug, taskKey, archived: form.get("archived") === "true" }, actor,
    );
    return { ok: true as const, intent, toast };
  }
  ```
  (`setTaskArchived` is exported from `task-actions.server.ts` and returns the toast copy.)
  Render **Archive task** for maintainer+ (and **Restore** on an archived task), plus an
  archived banner on the task page. On the board (W4), add the "Archived" view once §1 lands
  — the copy in `closedPrBlockedReason` ("Rework and reopen the PR, or archive the task")
  finally points at something real.

---

## 5. LV-07 — surfacing the conflict in the UI + the queue row (W4 / unowned projections)

`pr.mergeable` (`"clean" | "conflicting" | "unknown"`, absent = never read) is now written
by the reconciler and by `mergeTaskPr`'s pre-merge check, and it rides inside `pr_json`, so
`TaskSummary.pr` already carries it with no projection work.

- **Task card / GitHub page** (W4): render `pr.mergeable === "conflicting"` as a real
  state next to the PR pill — "conflicts with `main`". The GitHub page currently shows only
  the compare-derived "behind main", which is why a conflicting PR was indistinguishable
  from a credential outage.
- `app/server/projections/review-queue.server.ts` (unowned): pass `mergeable` through when
  it builds the row —
  ```ts
  pr: t.pr ? { number: t.pr.number, state: …, ...(t.pr.mergeable ? { mergeable: t.pr.mergeable } : {}) } : null,
  ```
  `ReviewRowView` already accepts it and `reviewRowSub` already renders it (P14-LV-05).
- Same file, `isReady` (:147): it promises acceptance from `blockReason` alone, which is
  projected from `acceptanceBlockedReason` only — so a conflicting or archived task can
  still be listed under "Waiting on your acceptance" and then 409 on click. Either add
  `r.pr?.mergeable !== "conflicting"` to `isReady`, or (better) call
  `resolveAcceptanceAffordance` per row so the queue and the task page can never disagree
  again.

---

## 6. GV-10 — replacing the delivering specialist mid-run (W2's file)

`assignSpecialist` (`app/server/tasks/specialist-run.server.ts:257-340`) has no live-run
check and no hand-off audit distinct from `task.specialist.assigned`; the OLD run still
reconciles delivery under the replaced profile while the file names a new deliverer.
Requested:

1. Before replacing a `delivers: true` engagement, look up live runs for the task
   (`listRunsForTask` / the same single-flight query `startAgentRun` uses at :570-587). If
   the outgoing deliverer has a queued/running primary run, either refuse with a 409 naming
   the run ("interrupt it first"), or accept and interrupt it — the owner-visible behavior
   should be one of the two, not silence.
2. Audit the swap as its own action (e.g. `task.delivery.handoff`) with
   `{ fromProfileId, toProfileId, liveRunId }`, and append a timeline `note` so "who owned
   this revision" reads correctly later.

---

## 7. FYI — files W3 touched that are adjacent to other streams

- `app/schemas/task-file.schema.ts` (owned): added `PR_MERGEABLE_VALUES` + `pr.mergeable`,
  `conflictingPrBlockedReason`, `archivedTaskBlockedReason`.
- `app/server/projections/decisions.server.ts` (owned): the owner exception is now "any open
  decision on your own task"; the `recommendation_kinds` column is no longer read by this
  module (still projected, still in the DDL).
- `planning/planning-artifacts/prd.md`: FR37's stale "Partly implemented" annotation
  replaced with a dated amendment recording the shipped owner acceptance AND the R14-2
  widening. No other PRD line touched.
