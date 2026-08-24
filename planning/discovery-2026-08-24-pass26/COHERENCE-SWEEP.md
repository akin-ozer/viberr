# Coherence + honesty sweep — pass 26

Scope: `git diff 6cff122..b5b3128` (PRs #206-#219 — task metadata/priority/labels/due-date,
run-concurrency cap, audit export, Insights, task-detail Details panel, new-task metadata
inputs). Method: read every touched file in the metadata/audit/insights/concurrency slices,
diffed against `git log`/`git diff` to confirm which surfaces were and weren't touched, and
traced each candidate finding end-to-end through source (not comments) before recording it.
All file:line citations are against the working tree at `b5b3128` unless noted.

Findings are ranked most-severe first. Six real findings; no fabricated ones.

---

## 1. HIGH / CONFIRMED — Labels are unsearchable on both the board filter and the global ⌘K palette

Labels shipped this pass as a first-class, editable, autocompleted per-task field (board
card chips, Details-panel chips, a dedicated `LabelInput` with a "type and press Enter" hint).
Neither of the app's two task-search surfaces indexes them:

- `app/features/board/board-filters.ts:116-155` — `SearchableTask`/`matchesSearch`'s haystack
  is `key, title, branch, owner.name, specialist, reviewers, operator.name`. No `labels`.
- `app/features/shell/command-search.server.ts:52-161` (the ⌘K palette, `/resources/search`,
  `app/routes/resources.search.ts`) — the task query only `SELECT`s and `LIKE`-matches
  `task_key, title, branch`. No `labels_json`.

Both files are **untouched** by this diff range — confirmed via `git log --oneline
6cff122..b5b3128 -- app/features/board/board-filters.ts app/features/shell/command-search.server.ts
app/routes/resources.search.ts` (zero commits, zero diff). The board-filters.ts doc comment
even names the split explicitly: `"Filter this board…"`, not a global search — the ⌘K palette
answers that" (board-page.tsx:1417-1420, R15-5). So the ONE surface the codebase itself
designates as "the global question" for exactly this kind of lookup still can't answer it for
labels.

**Scenario**: a maintainer tags a task `security`, then later types "security" into either the
board's filter box or ⌘K expecting to jump back to it (exactly the workflow the New-task
modal's own label autocomplete invites — "Labels already used across the board, offered as
New-task autocomplete"). Zero results from either surface. The label is fully functional as a
*display* field and *write* field, but dead as a *retrieval* key everywhere in the app.

**Severity**: HIGH — labels are the one new metadata axis the UI actively markets as a way to
find things later ("type and press Enter, optional"; per-project autocomplete vocabulary), and
that promise doesn't hold on either search surface.

---

## 2. HIGH / CONFIRMED — Audit-log export claims "the full audit log / every recorded fact" but silently truncates past 100,000 rows, with no signal anywhere

- `app/server/audit/audit-export.server.ts:14` — `AUDIT_EXPORT_MAX_ROWS = 100_000`.
- `app/server/audit/audit-export.server.ts:89-101` — `queryAuditEventsForExport` clamps to
  this cap and runs `ORDER BY occurred_at DESC, id DESC LIMIT ?` — i.e. past the cap it keeps
  the newest N rows and **silently drops the older ones**. No count-vs-total comparison, no
  truncation flag returned to any caller.
- `app/features/org-settings/org-settings-page.tsx:193-195` — the UI copy directly above the
  download buttons: *"Download the **full** audit log, or push it to an S3 bucket. Exports
  carry **every** recorded fact (actor, action, subject, details)."*
- `app/routes/org.settings.audit-export.ts:38-49` — the CSV/JSON download route calls
  `queryAuditEventsForExport(getDb(), filters)` with no limit override and streams the body
  with no row-count header, no `X-Total-Count`, nothing that would let a downloader detect
  truncation.
- `app/routes/org.settings.tsx:282-296` — the S3-push action path calls the *same* unbounded
  query (`queryAuditEventsForExport(db)`, no filters at all) and reports success
  unconditionally: `` `Exported ${rows.length} audit rows to S3 (${objectKey}).` `` — this
  message is indistinguishable whether `rows.length` is the true total or a silently truncated
  100,000.
- The cap's own doc comment claims the gap is covered: *"The UI states the cap."*
  (`audit-export.server.ts:13-14`) — **false**. Grepped the entirety of
  `org-settings-page.tsx` for `100,000`/`100000`/`AUDIT_EXPORT`/`cap` — zero matches. The cap
  is stated nowhere a user can see it.

**Scenario**: an org running long enough to accumulate >100,000 audit rows (very plausible —
audit events fire for nearly every governed action: task creates, every metadata edit, every
run lifecycle transition, logins, RBAC changes, etc.) has an admin click "Download CSV" for a
compliance review or incident investigation. The file downloads without error, the toast (for
the S3 path) says "Exported 100000 audit rows" as an unqualified success, and the oldest
records — potentially the ones under investigation — are silently missing. Nothing in the
product tells the admin this happened.

**Severity**: HIGH — this is the textbook case the brief calls out: unconditional "every…"
copy, directly contradicted by a silent cap, on a compliance-facing feature where silent data
loss is the worst-case outcome.

---

## 3. MEDIUM / CONFIRMED — Editing a task's metadata is no longer blocked on archived tasks (regression introduced mid-range), and the server enforces no such guard either

Sequence within this same diff range:

- `42a793e` "Add lightweight task metadata" put the editor in the hero, gated
  `{canEditMeta && !archived && <TaskMetaEditor task={task} />}` (pre-move
  `task-main-sections.tsx`, confirmed via `git show 84fba42 -- app/features/task-detail/task-main-sections.tsx`,
  which shows this exact line being deleted).
- `84fba42` "Move task metadata to a 'Details' side panel" (PR #208, still inside this range)
  relocated the editor into `TaskDetailsPanel` (`app/features/task-detail/task-side-panels.tsx:375-503`).
  The new component's props are `{ task, canEdit, labelSuggestions }` — **no `archived` prop at
  all** — and its "Edit details" button is gated purely on `canEdit`
  (`task-side-panels.tsx:500-503`, `{canEdit && (<button ... onClick={startEdit}>Edit details</button>)}`).
- The call site, `app/features/task-detail/task-detail-page.tsx:676-679`, passes
  `canEdit={canEditMeta}` with no `archived` — unlike its sibling panels on the same page,
  which *do* receive `archived={archived}` (e.g. `CurrentStatePanel` at line 664).
- Server-side, `setTaskMetadata` (`app/server/tasks/task-actions.server.ts:638-733`) has no
  archived guard either — compare to `archivedTaskBlockedReason`/`archivedTaskMoveBlockedReason`
  (`app/schemas/task-file.schema.ts`), which exist precisely to block acceptance/stage-moves on
  archived tasks and are not invoked here.

**Scenario**: a task is archived (R14-3: "abandoned work, kept for the record" — explicitly a
terminal, out-of-flow disposition). A contributor with `edit-task-meta` opens the archived
task's page, clicks "Edit details" in the Details panel (fully available, no warning), and
changes priority/labels/due-date. The write succeeds — the archived task's historical record is
silently mutated after the fact, something the feature explicitly forbade less than a day
earlier in the same PR sequence.

**Caveat**: the codebase is not internally consistent on this rule even before this regression —
the pre-existing goal editor (`task-main-sections.tsx:269`, `{canEditGoal && (...)}`) has *never*
excluded archived tasks, at either the UI or server layer. So this finding is a regression
relative to metadata's own prior (in-range) behavior, not a violation of a universally-enforced
app rule. Still worth flagging because it was a deliberate `!archived` check that got dropped
silently as a side effect of a refactor, with no comment acknowledging the behavior change.

**Severity**: MEDIUM — real, confirmed, but low blast radius (requires `edit-task-meta` +
archived + intent to backdate metadata) and the goal-edit precedent means the app's overall
"archived = immutable" story was already inconsistent.

---

## 4. MEDIUM / CONFIRMED — The review queue never shows priority, labels, or due-date

`app/features/review/review-page.tsx` has **zero** diff in this range (confirmed via
`git log`/`git diff 6cff122..b5b3128 -- app/features/review/review-page.tsx` — empty). Its row
renderer, `RQRow` (`review-page.tsx:48-`), already carries a dense set of contextual pills —
PR state, validation, a staleness ("no activity · …") pill, a continuity-degraded pill, and a
"waiting on you/a human/agent working" tag — explicitly because, per that same file's own
comment: *"the acceptance boundary is where a forgotten task costs the most — a completion
report nobody answered blocks the merge and the branch behind it"* (review-page.tsx:100-105).
Priority and due-date are exactly the kind of triage signal that comment is arguing for, but
neither renders anywhere in the row.

**Scenario**: a task marked `priority: urgent` with a due date yesterday sits in the review
queue next to a routine task. Both rows render identically apart from title/PR/validation state
— the reviewer has no way to tell, from the queue itself, that one is overdue-and-urgent without
opening it. The board (a *less* decision-critical surface) now flags this with a red pill and a
card-level highlight; the review queue (the *more* decision-critical surface, by its own
in-file reasoning) does not.

**Severity**: MEDIUM — not a regression (the queue never had this), but a direct hit on hunt
area 1 ("the review queue row... should agree about a task") and an ironic one given the file's
own stated design philosophy.

---

## 5. LOW-MEDIUM / CONFIRMED — Label-autocomplete vocabulary disagrees between the New-task modal and the Details panel (and a test's own doc comment asserts they agree)

- Details panel: `app/routes/project.task.tsx` loader calls `listProjectLabels(db, params.slug)`
  (`app/server/projections/board-query.server.ts:270-289`), which explicitly filters
  `WHERE project_slug = ? AND archived = 0` — archived-task labels are excluded from the
  vocabulary by design.
- New-task modal: `app/features/board/board-page.tsx:1801-1806` computes `labelSuggestions`
  **client-side** from `allTasks` (`= columns.flatMap(...) + orphanTasks`, line 1794-1796).
  `columns`/`orphanTasks` come from the loader's `getBoard()`, which calls
  `listProjectTasks(db, slug, { includeArchived: true })`
  (`app/server/projections/board-query.server.ts:315`) and hides archived tasks **client-side
  only** — the R14-3 comment right there says so explicitly: *"the BOARD loads archived tasks
  and hides them client-side, because its 'Archived' chip is the only way back to them."*
  `board-page.tsx` never filters `allTasks` by `archived` before deriving `labelSuggestions`.
- `project.board.tsx` (the board's route/loader) never imports or calls `listProjectLabels` at
  all — confirmed via grep. The New-task modal's suggestion list and the Details panel's
  suggestion list are two independently-computed sets with different archived-inclusion rules.

This directly contradicts the new test file's own docstring:
`app/server/projections/project-labels.server.test.ts:12-13` — *"`listProjectLabels` is the
label-autocomplete source **shared by the board's New-task modal and the task-detail Details
panel**."* That claim is false for the New-task modal; only the Details panel actually calls it.

**Scenario**: a task was tagged `spike-2024` and later archived. Opening the New-task modal on
the same board offers `spike-2024` as an autocomplete suggestion (drawn from `allTasks`,
archived included); opening any *existing* task's Details panel and starting to type
`spike-2024` gets no such suggestion (drawn from `listProjectLabels`, archived excluded). Same
project, two different "what labels exist here" answers.

**Severity**: LOW-MEDIUM — cosmetic (autocomplete only; a user can always type the label
manually and it will still normalize/dedupe identically via `normalizeTaskLabels` either way),
but a clean, confirmed two-surfaces-disagree bug, and the test suite's own documentation asserts
the opposite of what the code does.

---

## 6. LOW / PLAUSIBLE (dormant — no live caller triggers it today) — `createTask`'s back-compat `urgent` parameter can desync from `priority`

`app/server/tasks/task-actions.server.ts:495`:

```ts
urgent: input.priority === "urgent" || (input.urgent ?? false),
```

The schema's own contract (`app/schemas/task-file.schema.ts:44-46`) states `urgent` must stay
"kept in lock-step with `priority === 'urgent'`" (also literally the wording of hunt item 4).
This line does NOT enforce that: passing `{ priority: "high", urgent: true }` yields
`urgent: true` with `priority: "high"` — a task that lights the board's `.urgent` highlight
class and the "Blocked or waiting" filter's urgent clause
(`board-filters.ts:89`/`board-page.tsx:508`) while its own priority pill reads "high", not
"urgent."

`setTaskMetadata` (the edit path) does **not** have this problem — it correctly derives
`f.urgent = patch.priority === "urgent"` unconditionally (`task-actions.server.ts:711-713`), no
back-compat OR.

**Reachability check**: grepped every caller of `createTask` — the only one is
`app/routes/project.board.tsx`'s `create-task` action, which never reads or forwards an
`urgent` form field (there is none in `NewTaskModal`), so `input.urgent` is always `undefined`
there today. Also grepped for any MCP/agent-facing tool that could set `urgent`/`priority`
directly — none exists; task creation is human-only. So this is not currently exploitable
through any UI path — it is a latent defect in an exported, still-public, "for back-compat"
parameter of `CreateTaskInput`, not a live symptom.

**Severity**: LOW — real contract violation, directly on-topic for the explicit hunt question,
but dormant; flagging so it doesn't reappear if a future caller (import script, future bulk-
create API, etc.) legitimately uses the `urgent` back-compat field.

---

## Areas checked and found coherent (no finding)

- `DueDatePill`/`PriorityFlag`/`LabelChips`/`hasVisibleMeta` (`app/ui/task-meta.tsx`) are the
  single shared renderers for board card and Details panel — overdue-ness in particular is
  computed by exactly one function (`isOverdue`), called from exactly one component
  (`DueDatePill`), used identically on both surfaces (confirmed no other `isOverdue`/`todayISO`
  call sites exist). Board vs. hero overdue display cannot disagree by construction.
- The projection round-trip for `priority`/`labels`/`dueDate` (`rebuilder.server.ts`'s INSERT +
  `ON CONFLICT DO UPDATE`, `0001_baseline.sql`'s column defaults, `parseTaskFrontmatter`'s
  tolerant per-field parsing with clean defaults) is complete and consistent; a pre-pass-25
  task.md with none of these keys parses to `priority: "normal", labels: [], dueDate: null`
  with no spurious diagnostics, matching the "all default cleanly when absent" comment.
  `parseTaskLabels` (`app/shared/mapping/task.server.ts`) self-catches malformed
  `labels_json` and returns `[]` rather than throwing.
  `project-labels.server.test.ts` positively verifies the archived-exclusion behavior it claims
  for `listProjectLabels` itself (only its "shared by the New-task modal" framing is wrong — see
  finding 5).
- `setTaskMetadata`'s own derived-urgent write (the edit path, as opposed to create) is correct
  and unconditional — see finding 6's contrast.
- Insights (`insights-query.server.ts`, `insights-page.tsx`): admin-gated
  (`requireRole(request, "admin")`), the one absolute claim in its copy ("Analytics across every
  agent run on this instance") is backed by an uncapped totals query; the breakdown cards
  (top-8-by-runs) make no completeness claim and realistically never truncate for
  backend/kind (small fixed enums), so no honesty gap despite the `TOP_N = 8` cap.
- `s3-config.server.ts`/`s3-put.server.ts`: secret-decrypt failure and HTTP failure both
  surface as an explicit, actionable `fail(...)` result to the caller — no swallowed error.
- Run-concurrency cap/drain (`run-service.server.ts`): `admitRun`/`drainRunQueue`/
  `runConcurrencySnapshot` are well covered by `run-concurrency.server.test.ts` (5 targeted
  tests including cap-raise-mid-drain and interrupt-while-queued); the "dropped, never springs
  to life" guard (re-checking the DB row's state before promoting) is real and tested. One doc
  imprecision noted but not filed as a finding: `drainRunQueue`'s comment says it runs "after an
  interrupt," but `interruptRun` never calls it directly — the promotion instead rides the same
  run's eventual (possibly async) `onExit`. The end behavior is correct and test-covered; only
  the mechanism description is imprecise, which didn't clear the bar for a standalone finding.
