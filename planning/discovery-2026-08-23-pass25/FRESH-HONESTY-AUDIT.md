# Pass 25 — fresh honesty / silent-failure / count-coherence audit

Baseline: main `7cf113a` (PR #200 merged: pass-24's parity + coherence fixes).
Both `planning/discovery-2026-08-21-pass23/AREAS-TO-IMPROVE.md` and
`planning/discovery-2026-08-22-pass24/FINDINGS-MASTER.md` were read first;
nothing below duplicates an item recorded there (including the already-logged
`capability-matrix-modal.tsx:272-276` Codex-web-egress staleness, which is
excluded per the brief).

Method: read the full PR #200 diff (`git diff b4b7b3d..7cf113a`) file by file —
the exact set the brief names as the highest-value seam — tracing each fix to
every OTHER surface that reads the same data, and to the tests pass 24 itself
added (to see what behavior was pinned vs left unchecked). Two genuine, fully
verified NEW defects came out of that; both are regressions/gaps introduced
BY pass-24's own fixes, not pre-existing carried-forward items.

Severity: **HIGH** = user actively misled or work/data lost; **MEDIUM** =
confusing/wasteful/real gap w/ workaround; **LOW** = polish.

---

## Finding 1 — MEDIUM: D-1's archived-project fix zeroes the Review page's own counts, splitting it from the (unpatched) rail badge — a fresh badge/queue-parity regression

**Files / lines:**
- `app/server/projections/review-queue.server.ts:118-136` (the pass-24 D-1 fix)
- `app/routes/project.tsx:139-147` (the rail's independently-computed `reviewCount` — NOT patched)
- `app/features/shell/rail.tsx:72` (renders `reviewCount` unconditionally, no archived gate)
- `app/features/review/review-page.tsx:198, 238, 288, 296-302` (the page's own copy)
- `app/server/projections/review-queue.server.test.ts` (new pass-24 test, ~line 184-203) pins the exact zeroed shape

**Symptom:** Archive a project that still has a task sitting in its Review
stage (nothing prevents this — `setProjectArchived` in
`app/features/project-settings/settings-actions.server.ts:948-984` has no
task-state gate). On that project:
- The left rail still shows a nonzero **"Review N"** badge (unaffected by the
  fix — see root cause).
- Clicking it opens `/projects/:slug/review`, whose header now reads **"0
  tasks at the review boundary"**, "Waiting on your acceptance 0 of 0", and
  the "Still in review" panel says **"No review work in flight. A task an
  agent is actively revising in a review stage shows here until it reaches
  the boundary and moves to the queue above."** — literally false; the task
  is sitting in that exact stage right now, one click away on the Board,
  which still renders it under its real "Review" column
  (`board-query.server.ts`/`getBoard` is untouched by project-archived
  status — only the task-level `archived` flag hides a card).
- The page's own capability chip (`stageNames.review → stageNames.terminal`,
  built at `project.review.tsx:39-46` via a SEPARATE, unpatched
  `resolveStageRoles(project.stages, project.workflow)` call) still names the
  real review stage — so the page simultaneously asserts "the review stage is
  called 'Review'" and "0 tasks at the review boundary; no review work in
  flight."

**Root cause:** Pass-24's D-1 fix (correctly) needed the AGGREGATE "waiting
on me" surfaces (home, notifications, the board's per-task `waitingOnMe`
annotation via `project.tsx:107-114`'s union with `getReviewQueue(...).ready`)
to stop asserting an ARCHIVED project's review-stage task is
acceptance-ready, since the server refuses acceptance on an archived project.
The chosen fix nulls `reviewId` inside `getReviewQueue` itself whenever
`project.archived` is true:

```ts
const reviewId =
  project && !project.archived
    ? resolveStageRoles(project.stages, project.workflow).reviewId
    : null;
```

That is correct for the `ready` (actionable) list, but `getReviewQueue` is
the SAME function that produces `working` (the purely informational "still
in review" panel) and `total` (the page header count) — both go to zero too,
even though neither is actionable and neither needed to disappear. Meanwhile
the rail's own `reviewCount` badge in `app/routes/project.tsx:139-147` computes
its count independently and was never touched by the PR:

```ts
reviewCount: (() => {
  const reviewId = resolveStageRoles(board.project.stages, board.project.workflow).reviewId;
  return reviewId ? liveTasks.filter((t) => t.stage === reviewId).length : 0;
})(),
```

`liveTasks` filters only the TASK-level `archived` flag
(`app/features/board/board-filters.ts:105-107`, `isArchived(task) =>
task.archived === true`), never the PROJECT's. So the rail counts the
review-stage task; the dedicated Review page — reading the very same
`getReviewQueue` D-1 just patched — counts zero. This is the exact
badge/queue-parity defect class the codebase's own comment at
`project.tsx:37-52` documents fixing once already (pass-4 WI-1 / F19-9,
"the rail said 'Review 1' over a queue reading '0 tasks... and a supervisor
chasing the badge found nothing'") — reopened on the project-archived axis
by the very fix meant to close a different instance of it.

Pass-24's own new test (`review-queue.server.test.ts`, "D-1 (pass 24): an
ARCHIVED project has an EMPTY review queue") asserts
`{ ready: [], working: [], total: 0 }` for exactly this state and offers no
counterpart test on the rail's `reviewCount` or the Review page's
`working`/`total` display — the split was never caught because nothing
cross-checks the two derivations.

**Failure scenario:** An admin archives a project mid-review (e.g., closing
out old work but a task never made it through review). Later, browsing
Home → Archived → that project, they see "Review 1" in the rail, click it
expecting to find the stuck task, and read "0 tasks at the review boundary…
No review work in flight" — directly contradicted by the Board tab one click
away, which still shows the task under "Review". This is confusing/wasteful
rather than data-destructive (acceptance itself stays correctly refused
either way), hence MEDIUM, not HIGH.

**Fix direction:** Don't collapse the whole review boundary to null for an
archived project. Keep `reviewId` resolved unconditionally (so `working` and
`total` still reflect reality, matching the rail and the Board), and instead
gate ONLY the `ready` (actionable) list on `!project.archived` — e.g. `ready:
project?.archived ? [] : rows.filter(...)`. That keeps the informational
counts honest everywhere while still refusing to claim anything is
"waiting on your acceptance" on a read-only project. (Equivalently: patch the
rail's `reviewCount` to also drop to 0 for an archived project, and update
the Review page's copy to say "This project is archived — read-only" instead
of "no review work in flight" — but that direction throws away real
information the page can otherwise still honestly show.)

---

## Finding 2 — MEDIUM: the Codex operator's baked system-prompt SOP still asserts its cwd "holds task.md" after pass-24's B-1 fix moved it to an isolated scratch folder — a self-contradicting prompt

**Files / lines:**
- `app/server/seed/assets/operator.definition.md:12` (unedited by PR #200)
- `app/server/runtimes/operator-run.server.ts:2646-2650` (`workspaceSection`,
  the NEW Codex-only `isolatedWritableRoot` branch, pass-24 B-1)
- `app/server/runtimes/operator-run.server.ts:2737-2755` and `:2845` (prompt
  assembly — both blocks land in the SAME system prompt, definition first)

**Symptom:** For every Codex operator run (not Claude — see below), the
system prompt sent to the model contains two directly contradictory claims
about where its own working directory is:

1. From the "ALWAYS present" baked SOP (`operator.definition.md:12`, injected
   first as `parts[0]`, unconditionally, regardless of backend):

   > "Your working directory holds Viberr's own files for this task
   > (`task.md`, run logs) AND a read-only checkout of the project
   > repository."

2. From `workspaceSection(workspace, isolatedWritableRoot=true)`, injected
   later in the SAME prompt for a Codex operator only
   (`operator-run.server.ts:2646-2650`):

   > "Your working directory is a separate, empty scratch folder — your ONLY
   > writable area. Viberr's task store (including `task.md`) and the
   > repository checkout are READABLE but outside it: you can inspect them,
   > you cannot change them."

**Root cause:** Pass-24's B-1 fix (`app/server/runtimes/operator-run.server.ts`,
`ensureOperatorScratchDir` + the `startCodexOperatorRun` `workdir: scratchDir`
change) correctly re-rooted the Codex operator's writable cwd at a sibling
`.operator-scratch/` folder so `task.md` and the deliverer checkout stay
outside its `workspace-write` sandbox — closing the "Codex operator can `sed`
its own governance file" hole B-1 documents. The fix threaded a new
`isolatedWritableRoot` flag through `buildOperatorSystemPrompt` →
`workspaceSection` to describe the NEW cwd correctly for Codex while leaving
Claude's (unchanged, cwd-is-the-task-folder) description alone. That part is
correctly backend-conditional. But the STATIC "ALWAYS present" operator
definition text — `operator.definition.md`, the "core operating manual" per
the comment at `operator-run.server.ts:2737-2738`, which the same B-3 fix in
this PR already edited once (removing the "you have no shell" claim, see
`PRIOR_SHIPPED_HASHES` in `default-assets.server.ts`) — was not revisited for
this specific sentence. It still describes the pre-B-1 reality (cwd == task
folder) for BOTH backends, so it now silently disagrees with the
Codex-specific `workspaceSection` block that follows it in the same prompt.

(Claude is unaffected: `isolatedWritableRoot` defaults to `false` for the
Claude path, so its `workspaceSection` text still says "your working
directory is this TASK's own folder… it holds `task.md`", which agrees with
`operator.definition.md`. The contradiction is Codex-only.)

**Failure scenario:** A Codex operator, asked by a human ("where are you
running from?" or when self-describing its environment in a comment/packet),
has two conflicting facts in its own context about whether its cwd contains
`task.md`. Best case it silently resolves the ambiguity in favor of the more
specific/recent `workspaceSection` text and nothing user-visible happens;
worst case it repeats the SOP's stale claim back to a human on the timeline
("my working directory holds task.md…"), which is now false for a Codex run —
a small, agent-authored, but genuine dishonesty about the operator's own
environment. It could also waste a turn if the model tries a literal
`./task.md` shell read expecting it in cwd (the scratch dir is empty) instead
of using `get_task`. The B-1 sandbox boundary itself is unaffected by this —
the write restriction holds regardless of what the prompt claims — so this is
a documentation/prompt-consistency defect, not a governance bypass.

**Fix direction:** Make `operator.definition.md`'s working-directory sentence
backend-neutral (defer entirely to the dynamically-built workspace section,
the way the B-3 edit already did for the default-branch-read sentence one
paragraph below it), e.g.: "Your run's system prompt describes your exact
working directory and what it does and does not hold — some backends keep
`task.md` and the repository checkout inside it, others keep them outside as
read-only. Trust that description, not an assumption." Bump
`PRIOR_SHIPPED_HASHES` for the new outgoing hash exactly as B-3 already did
for its own edit to the same file.

---

## Verified during this pass, no new finding

- A-1/A-2 (operator capability materialization, `agents-query.server.ts`):
  traced `operatorGrants`/`absentMode` all the way through `AgentProfileView
  .capabilities` into the editor's `seedCaps` (`create-profile-modal.tsx:149-186`,
  untouched by PR #200 but reads the fixed view) — the single-writer fix
  genuinely propagates to the matrix, profile detail, policy counts, and the
  editor seed with no gap. New operator profiles are never created from
  scratch through this modal (`isOperator = initial?.kind === "operator"`,
  requires an existing deployment), so the flat-catalog-default seed path for
  a brand-new profile never applies to `update-task-branch`.
- B-1 (Codex operator scratch-dir isolation): confirmed the single call site
  (`startCodexOperatorRun`), no resume path for the operator exists (queued
  triggers always call `runOperator` fresh), no `attachmentsWritableDir` is
  set for the operator (so `additionalDirectories` never widens the sandbox
  back), and `reclaimTerminalTaskWorkspaces`/`listTaskDirs` don't choke on the
  new `.operator-scratch/` subfolder (dot-prefix is already excluded at the
  TASK-dir level, and this sits one level deeper, inside a task dir).
- B-2 (Codex operator web-search grant): `networkAccessEnabled=false` stays
  unconditional (correct — MCP/workspace tooling never needed the OS
  sandbox's network) while `webSearchMode` now follows `webSearchWithheld`
  for BOTH operator and specialist, matching the matrix.
- B-4 (MCP pre-flight credential): confirmed `backend` is threaded through
  every call site, including the resume path
  (`task-actions.server.ts:1304-1311`, always supplies a concrete backend).
- C-2/C-5 (queued @operator fire-failure) and C-3 (reply write/finalize
  split): both timeline-note + `settleWaitingAfterOperator`/finalize-isolation
  fixes read correctly; `finalizeReply` is synchronous and its own `try/catch`
  never re-invokes `writeReply`.
- C-4 (verdict-missing note): the new `atReviewStage` + `!question` gate
  correctly narrows the note to genuine review-stage completions.
- C-7 (`reconcileSummaryFailed`): `status !== "ok"` correctly includes
  `no_pat_configured`/`no_repo_configured` — reachable only for a project that
  already had a branched task (so a working credential existed once),
  matching the alert copy's "expired, revoked, or missing repository access."
- D-2 (policy governed-only counts): `GOVERNED_CAP_LABELS` (`group !== null`)
  matches the profile-detail's own governed/advisory partition.
- D-3 (notifications decision count): now sources from the same
  `decisionsRequiring` as Home, which already excludes archived projects.
- D-4/D-5/A-3/E-1/E-2: re-derived independently from the diff and confirmed
  each matches its FINDINGS-MASTER.md description with no loose end.
- B-6 (`executeCodexPlan` narrated skips): the new `skippedMalformed` refusals
  correctly land in the `refused` array and reach `narrateRefusedActions`,
  which buckets them as "did not apply to the task's current state" (a plain
  `note`, not a `policy` event) rather than dropping them.
- The `.operator-scratch/` directories are never reclaimed (no caller ever
  `rmSync`s them) — real but LOW-severity disk accumulation, already covered
  by the existing carried-forward C9 ("storage has no visibility anywhere"),
  not reported again as a distinct finding.
