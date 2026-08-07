# Pass 19 — ledger specs, batch 3 (UX19-2, UX19-3, N19-2, N19-3, N19-4)

Grounded 2026-08-06 against the worktree at `claude/viberr-app-inspection-4e5bf2`
(main @65063b8 + pass-19 markers). Every file:line below was read this session.

---

## UX19-2 — GitHub panel offers Force-accept + "Acceptance is blocked" while Current state says "Not acceptable yet — at In Progress, not Review"

**Status: CONFIRMED in code, still true.** Two adjacent side-column panels read the
acceptance gate from two different sources that disagree by construction on any
pre-boundary task with delivered-but-unreviewed work. And the button is live:
force-accept from In Progress really does jump the task to Done.

### Current code

**Panel 1 — `GithubTrace` force-accept row** (`app/features/task-detail/task-side-panels.tsx:59-86`).
Trigger is the projection column, with no stage/boundary test:

```tsx
const forceAcceptReason = isTerminal
  ? null
  : (task.blockReason ??
    (task.packet?.type === "blocked"
      ? "An open blocked decision is holding this task."
      : null));
```

and renders (`:72-84`):

```tsx
<p className="hint">
  Acceptance is blocked: {forceAcceptReason}
</p>
<button ... onClick={onForceAccept}>
  ...
  Force accept (override review gate)
</button>
```

`task.blockReason` = `task_projections.validation_block_reason`
(`app/shared/mapping/task.server.ts:304`), which is built by
`acceptanceBlockReason` in `app/server/projections/rebuilder.server.ts:294-324` —
a function that **deliberately omits the stage-boundary gate**:

> rebuilder.server.ts:290-292 — "The remaining gates there — archived, stage
> boundary, open blocked packet, conflicting PR — are per-reader state the
> consumers already filter on, so they stay out of this column."

So a task at **In Progress** with a delivered revision and no verdict projects
`"VC-1's delivered revision has no approving verdict yet — run a review for a
verdict, or an admin can force-accept."` — and `GithubTrace` renders it, plus the
button, for any admin. The only withdrawals today are terminal readiness
(`:59-60`, F18-13) — nothing checks the boundary.

**Panel 2 — `CurrentStatePanel` refusal** (`task-side-panels.tsx:540-579`) renders
`acceptance.blockedReason` from the live file
(`resolveAcceptanceAffordance` → `acceptanceRefusalReason`,
`app/server/tasks/task-actions.server.ts:4960-5011` / `:4734-4765`), where the
stage gate is checked **before** the verdict gate (`:4752`), producing:

> task-actions.server.ts:4693 — `` `${taskKey} is at ${stageName(project, fromStageId)}, not ${reviewName} — a completion can only be accepted from the boundary the workflow puts before ${stageName(project, terminalId)}. Move the task through the workflow first.` ``

rendered under **"Not acceptable yet."** (`task-side-panels.tsx:568-573`).

**The code even documents the contradiction against itself.** The stage gate's own
comment (`task-actions.server.ts:4687-4692`):

> "No force-accept suggestion here: the DG-2 override exists for a WEDGED
> acceptance (a verdict that can no longer be recorded, a stale blocked packet),
> and the task page only offers it for those. A task that simply has not reached
> the boundary yet is not wedged…"

— while `GithubTrace`'s own header comment (`task-side-panels.tsx:49-52`) claims
the opposite scope:

> "Surfaced for admins (onForceAccept present) regardless of branch/PR, so a
> no-branch pre-work wedge is still escapable."

### What Force accept actually does pre-Review (ledger question — verified)

`forceAcceptCompletion` (`task-actions.server.ts:5274-5328`) audits the bypassed
gate then calls `acceptCompletion(..., force: true)`. With `force`, the entire
`acceptanceRefusalReason` block — **including the stage gate** — is skipped
(`:5145-5157` `if (!input.force) { ... }`); only the PR-head containment check
still binds (`:5159-5171`, R15-1 gate 2 / F15-15). It then attempts the real
merge; an unmergeable result is tolerated under force (`:5220-5222`). So one
click from In Progress = task Done + PR merged (or merge-pending), skipping
Review entirely. The click does pass through the `AcceptConfirm` dialog
(`task-detail-page.tsx:461-463` routes to `setConfirmAccept("force")`), so R15-1's
confirm requirement holds on this path; the problem is the *offer*, not a missing
dialog.

### Root cause

`GithubTrace` keys the force-accept affordance off `validation_block_reason`, a
column that intentionally carries only the **revision** dimension of the gate.
"blocked on this revision" is conflated with "wedged at the acceptance boundary".
The panel never sees the boundary predicate the Current state panel renders, so
the two panels are structurally free to disagree — and do, on every
delivered-not-yet-reviewed pre-boundary task viewed by an admin.

### Owner decision needed (two in-code intents conflict)

- **Option A — withdraw pre-boundary** (matches `acceptanceStageBlockedReason`'s
  comment and the R16-3 "withdraw, don't disable" precedent): render the
  force-accept row only when `acceptance.atBoundary` is true (plus the existing
  terminal withdrawals). A pre-boundary blocked-packet wedge keeps its escape via
  packet resolution/dismissal (R14-2 lets the owner/admin dismiss any packet).
  Consequence: admins lose the current (undocumented) skip-the-workflow-entirely
  accept; they'd move the task to the boundary first (transitions are theirs
  anyway).
- **Option B — keep the pre-boundary hatch, make it honest** (matches the DG-2
  comment in `task-side-panels.tsx:49-52`): keep rendering pre-boundary, but the
  sentence must be `acceptance.blockedReason` (the full refusal, stage gate
  first) instead of the projection column, and the button label/title must name
  the skip ("Force accept — skips the remaining stages and the review gate").
  Both panels then quote the same reason and the affordance stops contradicting
  "Not acceptable yet".

Either way the **sentence source must unify**: the row should quote
`acceptance.blockedReason` (live, full-order refusal) rather than
`task.blockReason`, so the two panels can never name different gates again.

### Change sketch (Option A shown; B differs only in the render predicate)

`task-detail-page.tsx:456-467` — thread the affordance in:

```tsx
<GithubTrace
  task={task}
  acceptance={acceptance}          // NEW
  ...
/>
```

`task-side-panels.tsx` `GithubTrace`:

```tsx
// BEFORE
const forceAcceptReason = isTerminal ? null : (task.blockReason ?? ...packet fallback);

// AFTER (Option A)
const forceAcceptReason =
  isTerminal || !acceptance.atBoundary || acceptance.terminallyBlocked
    ? null
    : (acceptance.blockedReason ??
      (task.packet?.type === "blocked"
        ? "An open blocked decision is holding this task."
        : null));
```

(`acceptance.terminallyBlocked` folds in R16-3's closed-PR withdrawal, which today
rides on the projection's gate ordering rather than an explicit check here.)

### Test plan

- `app/features/task-detail/task-disposition.test.tsx` (force-accept withdrawal
  cases already live here — F18-13): add
  1. task at a pre-boundary stage, `blockReason` non-null, admin viewer,
     `acceptance.atBoundary: false` → no "Force accept" button, no
     "Acceptance is blocked" hint;
  2. same task at the review boundary (`atBoundary: true`, blockedReason =
     verdict gate) → row renders, and the hint text equals
     `acceptance.blockedReason` (not the projection string).
- Server side (`app/server/tasks/acceptance-graph.server.test.ts`): pin the
  verified behavior explicitly — `forceAcceptCompletion` from a pre-boundary
  stage succeeds and audits `bypassed` = the stage-gate sentence (Option A keeps
  the server capability; only the UI offer narrows. If the owner instead wants
  the server to refuse pre-boundary force, that is a THIRD option and needs its
  own ruling — today's audit comment `:5299-5301` explicitly names the graph
  gate as force-bypassable).
- **Canary:** revert the `GithubTrace` predicate change → test 1 fails (button
  renders pre-boundary).

---

## UX19-3 — Review queue says "validation healthy · your acceptance" while the task page says acceptance is blocked

**Status: CONFIRMED as a structural class; the exact live instant is
over-determined.** Code holds three distinct mechanisms that let the queue and
the task page assert opposite acceptance affordances at once. Any of them
produces the observed shape; fixing the class fixes all three.

### Current code — the three divergence mechanisms

**(1) The chip and the gate in ONE projection row come from different
computations.** `rebuildTaskFile` projects the row
(`app/server/projections/rebuilder.server.ts:434-474`):

- `validation` column ← **`fm.validation`** (`:474`) — the *cached* frontmatter
  field;
- `validation_block_reason` column ← `acceptanceBlockReason(fm)` (`:294-324`),
  which calls **`deriveValidation(fm)` fresh** (`:320`).

So one rebuild can emit `validation = "healthy"` (stale cache → chip
"validation healthy", `app/ui/pill.tsx:91`) next to a block reason of
"…no approving verdict yet" (fresh derivation). Both the queue chip
(`review-page.tsx:70 <ValidationPill value={t.validation} …>`) and the task
hero pill (`task-main-sections.tsx:174 <ValidationPill value={task.validation}>`)
render the cached column — but every acceptance *gate* derives fresh.

**(2) The cache has writers that skip the recompute.** `fm.validation`'s contract
is "ONE writer (deriveValidation, F10-15)" (`task-actions.server.ts:4324`,
`:5094`), and verdict recording (`:1963-1964`), delivery
(`workspace-delivery.server.ts:376-385`), acceptance (`:5096`) all honour it.
But **`assignReviewer`** pushes a `verdictCapable` engagement — an input of
`deriveValidation` via `requiredReviewers` (`task-file.schema.ts:539-541`) —
without recomputing (`app/server/tasks/specialist-run.server.ts:519-536`), and
**`removeReviewer`** drops one the same way (`:600-608`). Concrete stale pair:
reviewer approves (cache → "healthy"), reviewer is then removed → derived
becomes "changed" ("no approving verdict yet" gate re-arms) while the cached
column — and therefore the chip on *both* surfaces — still says
"validation healthy".

**(3) The queue's "Waiting on your acceptance" predicate under-checks the gate.**
`isReady` (`app/server/projections/review-queue.server.ts:181-185`):

```ts
const isReady = (r: ReviewQueueRow): boolean =>
  r.waiting === "human" &&
  canAccept(r.key) &&
  r.blockReason === null &&
  r.pr?.state !== "closed";
```

but the projected `blockReason` column *deliberately omits* the open-blocked-packet
and conflicting-PR gates (rebuilder comment `:289-292`), and `isReady` re-checks
neither. `acceptanceRefusalReason` enforces both
(`task-actions.server.ts:4759-4763`). A review-stage task with an open blocked
packet (packets set `waiting = "human"` — `operator-actions.server.ts:561,795`)
or a `mergeable: "conflicting"` PR sits under **"Waiting on your acceptance"**
while the task page refuses the accept. The rebuilder's "consumers already
filter on" claim is true for archived (filtered upstream) and stage (the queue
lists only review-stage tasks) but **false for these two** — they are task facts
available in the same `fm` at rebuild time, not per-reader state.

(The literal same-instant screenshotted pair also involves the two routes'
independent loader snapshots between SSE revalidations — not fixable and not the
target; the fix target is that the surfaces are structurally *allowed* to
disagree given one consistent store state.)

### Root cause

One acceptance gate, three readers at three freshness levels: the display chip
trusts a cache with non-recomputing writers; the queue trusts a projection
column that intentionally carries only part of the gate; the task page derives
the full gate live. R15-1's rule — every proposer and writer reads the same gate
— was applied to the *writers* (P14-LV-02) but not to the *read models*.

### Change sketch

1. **Project the derived value** — `rebuilder.server.ts`: hoist
   `const derived = deriveValidation(fm)` in `rebuildTaskFile`, pass it into
   `acceptanceBlockReason`, and write it to the `validation` column instead of
   `fm.validation` (`:474`). Chip and gate then always derive from the same `fm`
   snapshot; a lying `validation:` line in a hand-edited task.md also stops
   propagating (tolerant-parsing convention).
2. **Fix the cache writers** (files are canonical truth — the file's own
   `validation:` line must not lie): in `assignReviewer` and `removeReviewer`'s
   `updateTaskFile` callbacks, after mutating `engagements`, add
   `parsed.frontmatter.validation = deriveValidation(parsed.frontmatter);`
   (`specialist-run.server.ts:522-529` and `:603-605`).
3. **Complete the projected gate** — extend `acceptanceBlockReason` to mirror
   `acceptanceRefusalReason` minus archived+stage only: after the existing gates,
   add the open-blocked-packet reason (rebuilder has the parsed file; pass
   `blockedPacket: fm.readiness === "blocked" && parsed.packet?.type === "blocked"`)
   and `conflictingPrBlockedReason(fm, fm.key)`
   (`task-file.schema.ts:617-623` sibling, already exported from the schema
   module). Consumers tighten automatically: review-queue `isReady`
   (`review-queue.server.ts:184`) and `decisionsRequiring`'s acceptance inbox
   (`decisions.server.ts:137`) both read this column — both currently
   over-promise for the same two cases.

No UI change needed: `review-page.tsx` and `task-main-sections.tsx` keep
rendering `t.validation` — its value becomes trustworthy.

### Test plan

- `app/server/projections/rebuilder.server.test.ts`: write a task file whose
  frontmatter says `validation: healthy` but carries zero verdicts on the
  current revision → projected `validation` column must be `changed` (canary:
  reverting change 1 projects `healthy`).
- `app/server/tasks/specialist-run.server.test.ts` (reviewer lifecycle tests
  live here): after `removeReviewer` drops the sole approving reviewer, the
  task file's `validation:` line reads `changed`, not `healthy` (canary:
  reverting change 2).
- `app/server/projections/review-queue.server.test.ts`: (a) review-stage task,
  `waiting: human`, open `blocked` packet, no delivered revision → row in
  `working`, NOT `ready`; (b) same with open PR `mergeable: "conflicting"` →
  NOT `ready` (canaries: reverting change 3 puts both in `ready`).
- `app/server/projections/decisions.server.test.ts`: blocked-packet task no
  longer emits an acceptance decision row (the packet's own decision row
  remains).

---

## N19-2 — ux-design-spec's typography supersede-note claims Roobert PRO shipped; the app ships Manrope

**Status: CONFIRMED, still true.** The ruling-44 failure mode: the *correction
note itself* is stale.

### Current text

`planning/planning-artifacts/ux-design-specification.md:373`:

> "**Superseded — the named typefaces are advisory and the build did not take
> them.** The shipped stack comes from `design/design-system.html`: Roobert PRO
> Medium for display, Noto Sans for body, JetBrains Mono for the
> technical/reference role. …"

The app (`app/app.css:59-64`):

```css
/* P16-UI-04: this was the Roobert-first stack from design/design-system.html,
   … Manrope is what ships (bundled @fontsource/manrope
   500/600/700/800); it is declared here now and nowhere else. */
--font-display: "Manrope", "Avenir Next", system-ui, sans-serif;
```

Body (Noto Sans) and mono (JetBrains Mono) match; only the display family claim
is false, and it has been false since P16-UI-04 resolved the Roobert/Manrope
override in favour of Manrope (2026-08-04).

### Root cause

The note was written against `design/design-system.html` (which does declare
Roobert first — `design/design-system.html:29`) instead of against `app/app.css`,
the file the note itself should treat as shipped truth. Nothing pins canon prose
to the token file, so the note survived pass 18's doc re-read.

### Change sketch

Replace the middle sentence of the `:373` note (dated, per the canon rule):

> **Superseded — the named typefaces are advisory and the build did not take
> them.** The shipped stack is `app/app.css` `:root`: **Manrope** for display
> (bundled `@fontsource/manrope` 500/600/700/800), Noto Sans for body, JetBrains
> Mono for the technical/reference role. *(Corrected 2026-08-06: this note
> previously named Roobert PRO Medium for display — that was
> `design/design-system.html`'s stack, which the build overrode; see P16-UI-04
> in `app/app.css`.)* The mono-used-intentionally rule and the scan-first
> hierarchy above are honoured; only the family names changed.

### Test plan

New `app/shared/docs/ux-spec-sync.test.ts` (pattern: `prd-sync.test.ts`, the one
existing docs-pin): parse `--font-display` from `app/app.css`, assert its first
family name ("Manrope") appears in the ux-spec's typography supersede note, and
assert the false claim string `"Roobert PRO Medium for display"` is absent.
**Canary:** revert the doc edit → both assertions fail.

---

## N19-3 — file-formats.md still says "The 8 kinds"; `PACKET_OPTION_KINDS` has 9

**Status: CONFIRMED, still true.**

### Current text

`docs/architecture/file-formats.md:205-209` (the packet-options YAML comment
block):

```yaml
  - kind: accept_completion       # STABLE kind (ruling 7). The 8 kinds:
    t: Accept completion          #   accept_completion | request_edit |
    d: Mark task done …           #   block_on_policy | hold_runtime_debug |
    rec: true                     #   redirect | retry_other_backend |
    accept: true                  #   edit_goal | custom
```

Source of truth `app/schemas/task-file.schema.ts:68-88` lists **nine**, including
`archive_task` (`:86`, added with R14-3). `docs/architecture/decisions.md`
ruling 7 was already corrected to nine on 2026-08-05 (its text names
`archive_task` at decisions.md:156) — file-formats.md is the straggler, and
INTENT.md §6 already flags it as a ruling-44 candidate.

### Root cause

The 2026-08-05 ruling-7 correction updated `decisions.md` but not the sibling
enumeration in `file-formats.md`; no test ties either doc to
`PACKET_OPTION_KINDS`.

### Change sketch

`file-formats.md:205-209` comment block becomes:

```yaml
  - kind: accept_completion       # STABLE kind (ruling 7). The 9 kinds:
    t: Accept completion          #   accept_completion | request_edit |
    d: Mark task done …           #   block_on_policy | hold_runtime_debug |
    rec: true                     #   redirect | retry_other_backend |
    accept: true                  #   edit_goal | archive_task | custom
                                  # (acceptance path marker — human-only)
```

(plus, if §2 prose elsewhere in the file counts kinds, the same count fix — the
grep this session found only the `:205` instance).

### Test plan

New `app/shared/docs/file-formats-sync.test.ts` (same pattern): read
`docs/architecture/file-formats.md`, assert every literal in
`PACKET_OPTION_KINDS` appears in it, and assert the phrase
`` `The ${PACKET_OPTION_KINDS.length} kinds` `` appears (so the next kind added
breaks the doc test, not just the doc). **Canary:** revert the doc edit →
`archive_task`-presence and count assertions fail.

---

## N19-4 — design-system radius/token drift: DS doc says card 18 / panel 28 / canvas 44 and defines `--pink`/`--dark-red`/`--radius-large`; the app ships 16/22 and none of those tokens

**Status: CONFIRMED, still true.**

### Current facts

`design/design-system.html` (the DS-doc deliverable):

```css
--pink: #fde0f0;            /* :26 */
--dark-red: #e3c5c5;        /* :28 */
--radius-button: 8px;       /* :33 */
--radius-card: 18px;        /* :34 */
--radius-panel: 28px;       /* :35 */
--radius-large: 44px;       /* :36 */
```

`app/app.css:76-79` (the single shipped token source):

```css
--radius-button: 8px;
--radius-chip: 999px;
--radius-card: 16px;
--radius-panel: 22px;
```

`--pink`, `--dark-red`, `--radius-large` appear nowhere in `app.css` (grep this
session: zero hits). A `var(--x)` not defined in `:root` is a bug by the design
language's own rule, so anyone porting a surface from the DS doc verbatim ships
a defect; anyone "fixing" radii back to 18/28/44 regresses the app.

### Root cause + the decision the ledger asked for

The canon rule (INTENT header) already decides the direction: the app is right,
the doc gets a dated correction — this is **not** an owner decision. The only
real choice is *where* the note lives:

- **Recommended: a dated supersede-note in
  `planning/planning-artifacts/ux-design-specification.md`**, alongside the two
  existing notes of exactly this shape (`:348` palette, `:373` typography), in
  the design-system-foundation section (§ near `:247`). Precedent: the mocks in
  `design/` are archived build inputs and are never edited (the sole exception,
  `design/prd.md`, is a byte-identical mirror by explicit ruling 27/52).
  `INTENT.md` §7 records the same drift for pass-19 readers, but INTENT is a
  pass artifact, not canon.
- Rejected: editing `design/design-system.html` to match shipped — rewriting a
  historical deliverable erases what the build diverged *from* and has no
  precedent.

### Change sketch

Add after the spacing supersede-note (`ux-design-specification.md:381`), one new
note:

> **Superseded — the DS-doc token values drifted from the shipped tokens
> (recorded 2026-08-06).** `design/design-system.html` declares
> `--radius-card: 18px`, `--radius-panel: 28px`, `--radius-large: 44px`, and the
> pastel tokens `--pink` / `--dark-red`; `app/app.css` `:root` — the single
> source of shipped tokens — ships `--radius-card: 16px`,
> `--radius-panel: 22px`, adds `--radius-chip`, and defines no canvas/large
> radius and no `--pink`/`--dark-red` at all. When porting anything from the DS
> doc, take token *names and roles* from it but values and existence from
> `app.css`; a `var()` that `app.css` does not define is a bug
> (`app.css.test.ts`).

### Test plan

Extend the `ux-spec-sync.test.ts` proposed under N19-2: parse
`--radius-card`/`--radius-panel` values out of `app/app.css` and assert the ux
spec's DS-drift note quotes those exact values (so a future radius change breaks
the note's pin, forcing a re-date — ruling-44 mechanics made executable). Assert
`app/app.css` still contains no `--pink`, `--dark-red`, or `--radius-large`
definitions (guards against someone "completing" the DS doc's token set instead
of correcting the doc). **Canary:** revert the doc edit → note-presence
assertion fails; add `--pink` to `app.css` → orphan-token assertion fails.
