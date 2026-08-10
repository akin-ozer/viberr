# Pass-19 ledger specs — batch 1 (operator / delivery / acceptance entries)

Grounded 2026-08-06 against the worktree at `main`-descendant `claude/viberr-app-inspection-4e5bf2`.
Entries: F19-1, F19-2, F19-3, F19-4, plus the two other non-audit delivery/acceptance ledger rows
F19-6 and F19-21. (F19-7/F19-18 and the other audit-workflow rows are spec'd by
`audit-workflow-result.json` and are only cross-referenced here.)

All line numbers verified in the current tree.

---

## F19-1 — supervised delivery can strand a task with no actionable next step (R19-4)

**Status: CONFIRMED in code.** The stranding VC-1 hit live is structural, not a persona bug.

### Current code

1. `app/server/tasks/task-actions.server.ts:3549-3575` — `performDelivery`, PR-opened success
   branch. The R18-2 block re-queues the operator **only under full autonomy** and documents the
   supervised gap explicitly:

   ```
   // trigger. SUPERVISED keeps the human in the loop — the "Opened PR" event is on the
   // timeline (writePrToTask) and the human drives the next move, so we do NOT
   // re-trigger.
   if (result.created) {
     ...
     if (autonomy === "full") {
       void autoInvokeOperator(db, ctx, projectSlug, taskKey, "delivered", ...);
     }
   }
   ```

   Nothing on the supervised arm guarantees a recommendation/packet exists.

2. `app/server/tasks/operator-actions.server.ts:1860-1888` — `operatorDeliverForReview` with a
   `direct` deliver gate calls `performDelivery` and returns
   `outcome: "done", message: "Delivered: … opened review PR #N."` — a tool RESULT, not a task
   artifact. Whether a "Move to Review" card follows is left entirely to the model's next tool
   call (VC-4/VC-5 recorded one; VC-1 recorded none and narrated a false "no further action
   needed").

3. `app/server/runtimes/operator-run.server.ts:419-432` — the settle-time stranded predicate
   `operatorLeftTaskStranded` only fires for **auto-boundary** stages:

   ```
   return workflow.some((w) => w.from === task.stage && w.boundary === "auto");
   ```

   In Progress → Review is `approval` under the Balanced preset, so a delivered-but-
   unrecommended task settles through `clearWaitingToHuman` (operator-run.server.ts:590-619)
   into `waiting: human` with no card, packet, or chip.

### Root cause

Delivery is not a transition (R18-2's own premise), so none of the existing backstops
(transition re-trigger, auto-stage stranded resume) covers the post-delivery moment; at
supervised autonomy the actionable-next-step invariant rests entirely on the operator MODEL
remembering to record a recommendation after its deliver tool returns.

### Fix (R19-4 — binding)

In `performDelivery`'s success branch, make the R18-2 block two-armed. When the outcome is
`delivered` and the delivery is operator-authorized (`ctx.operatorAuthorized === true`):

- `autonomy === "full"` → existing `autoInvokeOperator(…, "delivered", …)` (unchanged,
  still `result.created`-gated).
- otherwise (supervised operator delivery) → ensure an actionable next step **now**, via a new
  exported helper in `operator-actions.server.ts` (dynamic import, same pattern as line 3561):

```ts
// operator-actions.server.ts (new export)
export async function ensureDeliveredNextStep(
  db, ctx, projectSlug, taskKey, prNumber: number,
): Promise<void> {
  const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  if (!file || file.parsed.packet) return;          // an open packet IS the next step
  const project = loadProjectContext(ctx, projectSlug);
  const reviewId = reviewStageIdOf(project);        // task-actions.server.ts:211 (export or re-derive)
  const stage = file.parsed.frontmatter.stage;
  if (!reviewId || stage === reviewId || stage === terminalStageIdOf(project)) return;
  if (!project.workflow.some((w) => w.from === stage && w.to === reviewId)) return;
  await addRecommendation(db, ctx, projectSlug, taskKey,
    { kind: "transition", toStageId: reviewId, label: `Move to ${stageName(project, reviewId)}` },
    `Review PR #${prNumber} is open. Moving the task to ${stageName(project, reviewId)} starts the review.`,
  );
}
```

Why this shape is safe with zero staleness risk:

- `addRecommendation` is already idempotent per `(kind, profileId, toStageId)`
  (operator-actions.server.ts:551-556) — if the operator ALSO records "Move to Review" later
  in the same run (the VC-4/VC-5 behavior), the second write dedupes.
- Any stage move prunes all pending `transition` recommendations
  (task-actions.server.ts:3176-3180), and acceptance consumes all recommendations
  (task-actions.server.ts:4298-4300) — the synthesized card can never outlive its moment.
- `addRecommendation` sets `waiting: "human"` + notifies watchers — exactly the "delivered,
  awaiting your Move to Review" surface the finding asked for.
- Keyed on `ctx.operatorAuthorized`, so the human manual-delivery button and the human-applied
  `delivery` recommendation (both reach `performDelivery` without the flag —
  task-actions.server.ts:5539, project.task.tsx `deliver-review`) are untouched: a human who
  just clicked Deliver is present and does not need a card.
- Apply it on `status === "delivered"` regardless of `created` (unlike the full-autonomy
  re-queue): the helper is idempotent, and a supervised re-delivery that reuses a PR still
  deserves the guarantee. No loop risk — nothing here re-invokes the operator.

Copy note: the recommendation `detail` is rendered — keep "govern*" out (copy-ban,
`app/features/copy-ban.test.ts`).

### Test plan

`app/server/tasks/delivery-requeue.server.test.ts` (the existing R18-2 suite, describe at :134):

- **Update test B** (":155 supervised does NOT re-trigger, and still delivers") — it must now also
  assert: after a supervised operator-authorized delivery, the task file carries exactly one
  `transition` recommendation targeting the review stage, and `waiting === "human"`.
- New: supervised delivery when the operator ALREADY recorded the same transition rec → still
  exactly one card (dedupe).
- New: supervised delivery with an open packet → no recommendation added.
- New: human-actor delivery (no `operatorAuthorized`) → no recommendation added.
- New: no workflow edge from current stage to review stage → no recommendation, no throw.
- **Canary:** revert the `performDelivery` arm → updated test B fails (no recommendation found).
- Live: re-run the VC-1 shape (supervised operator, deliver via tool, model records nothing) —
  task page must show the "Move to Review" card.

---

## F19-2 — `deliveringContextGrants` docstring claims a skills widening that does not exist (R19-3)

**Status: CONFIRMED in code.** The docstring lies; the code is what R18-1/R19-3 want.

### Current code

`app/server/tasks/specialist-run.server.ts:261-270`:

```
/**
 * R18-1 (widened to SKILLS by LV-F3): the context grants the task's DELIVERING
 * engagement used, so a reviewer can judge the work against the same
 * conventions. ...
 */
function deliveringContextGrants(
```

Both call sites union **KBs only**:

- fresh reviewer run, :787-796 — `kb = withDeliveringGrants(kb, () => deliveringContextGrants(…, (profileId) => resolveDeployedSpecialist(…).kb))`
- resume/@mention reviewer, :1674-1684 — same, `resolveDeployedSpecialist(…).kb`.

Skills never flow through it: the fresh run mounts the reviewer's OWN `skills` (:867-874), the
resume path mounts `resolved.skills` (:1690-1697). `grep -rn "LV-F3"` hits exactly one line in
the whole repo — the docstring itself. There is no commit-visible skills union anywhere.

### Root cause

A pass-18-era docstring edit ("LV-F3") described an intended widening that was either never
implemented or implemented and reverted, leaving the comment as the only trace. Classic
ruling-54 class: prose asserting behavior nobody re-verified.

### Fix (R19-3 — binding: KBs only, R18-1 stands)

Docstring-only change at :261-263, plus a pin so the claim can't silently come back:

```
/**
 * R18-1 (KBs ONLY — R19-3): the KB grants the task's DELIVERING engagement
 * used, so a reviewer judges the work against the same conventions. Skills are
 * deliberately NOT inherited (a prior docstring claimed an "LV-F3" skills
 * widening that never shipped; R19-3 ruled the inheritance stays KBs).
 */
```

Mirror the same correction in the R18-1 comment block at :775-786 if wording there implies more
than KBs (currently it says "knowledge-base conventions" — already accurate, leave it).

### Test plan

`app/server/tasks/specialist-run.server.test.ts`, inside the existing
`describe("R18-1 — a reviewer inherits the delivering engagement's KBs")` (:1586), using the
existing `deployKbPair`/`lastRunSpec` harness extended with a skills field:

- New pin: deploy deliverer with `skills: ["deliverer-only-skill"]` (write the skill body under
  the store's skills dir), reviewer with `skills: []`; run the reviewer; assert the captured
  run spec's `systemPrompt`/`skills` does **NOT** contain `deliverer-only-skill`, while the KB
  sentinel inheritance assertions keep passing.
- **Canary:** implement the "widening" (union skills in the two call sites) → the new pin fails.

---

## F19-3 — applying the operator's `accept_completion` recommendation merges with NO confirm dialog (violates R15-1 / ruling 20)

**Status: CONFIRMED in code.** Live-reproduced on VC-1 (single Apply click → Done + merged).

### Current code

The Apply click submits immediately, no dialog anywhere on the path:

1. `app/features/task-detail/task-main-sections.tsx:267-274` — `RecommendationsSection`:

   ```ts
   const onApplyRec = (recId: string) => {
     if (recBusy) return;
     const fd = new FormData();
     ...
     fd.set("intent", "apply-recommendation");
     fd.set("recId", recId);
     recFetcher.submit(fd, { method: "post" });
   };
   ```

   (`operator-recommendations.tsx:101-110` — the Apply button calls `onApply(r.id)` directly.)

2. `app/routes/project.task.tsx:672-685` — `apply-recommendation` → `applyRecommendation`.

3. `app/server/tasks/task-actions.server.ts:5549-5558` — the `accept_completion` branch calls
   `acceptCompletion(...)` — a real human acceptance, i.e. a real async PR **merge** (R16-6).

Contrast: the direct accept button routes through `AcceptConfirm`
(`task-detail-page.tsx:479` `onAccept={() => setConfirmAccept("accept")}`, dialog at :491-516),
and the board got `AcceptOnBoardConfirm` in pass 18 (R18-7/B1, `board-page.tsx:543-586`, whose
header comment says "Ruling 20 / FR27 want the dialog on EVERY acceptance path"). The rec-Apply
path is one of the two acceptance writers that missed it (the other, the packet
`accept_completion` option at `decision-packet.tsx:329`, is F19-7 — spec'd in
`audit-workflow-result.json`; fix them in the same wave so "every accept confirms" is finally
true).

### Root cause

Pass-15's R15-1 confirm work covered `submitAccept`/force-accept; pass-18's B1 covered the
board. The recommendation card was added by a different pass (operator accept-recommendation,
operator-actions.server.ts:2062-2089) and its Apply was wired as a generic one-click like the
other rec kinds — nobody re-classified it as an acceptance writer.

### Fix

Reuse the existing `AcceptConfirm` — the task-detail page already owns every input it needs
(`task`, `workRevisionSha`, `noChanges`, `defaultBranch`, `acceptance.blockedReason`).

- `task-detail-page.tsx`: widen the confirm state (:237) from
  `null | "accept" | "force"` to `null | { mode: "accept" | "force"; recId?: string }` (or an
  equivalent third variant). `onConfirm` (:509-514): when `recId` is present, submit
  `apply-recommendation` with that `recId` (a small `submitApplyRec(recId)` lifted beside
  `submitAccept`); otherwise the existing `submitAccept()` / `onForceAccept()`.
- `RecommendationsSection` (task-main-sections.tsx): accept a new optional prop
  `onConfirmAcceptCompletion?: (recId: string) => void`; in `onApplyRec`, when the rec kind is
  `accept_completion` and the prop is present, call it instead of submitting. (The section
  already receives `recommendations`, so it knows the kind for the clicked id.) All other rec
  kinds keep one-click Apply — they are not acceptance writers.
- Keep routing the confirmed action through `apply-recommendation` (NOT `accept-completion`):
  it preserves the `task.recommendation.applied` audit row, the R15-3/R14-2 owner-authority
  seam (task-actions.server.ts:5449-5468), and the card-clearing at :5563-5568. (Note
  `acceptCompletion` itself also clears all recs at :4298-4300, but the audit row + owner seam
  only exist on the apply path.)
- `AcceptConfirm` needs no changes; pass `force={false}`, `blockedReason={acceptance.blockedReason}`.

### Test plan

`app/features/task-detail/task-disposition.test.tsx` (the acceptance-affordance suite, describe
at :138) or `task-detail-components.test.tsx`:

- Render the page fixture with a pending `accept_completion` recommendation + linked PR; click
  Apply → assert the `role="alertdialog"` accept dialog appears (with "PR #N" and the merge
  copy) and **no** `apply-recommendation` submission has fired yet.
- Click the dialog's confirm → assert exactly one `apply-recommendation` submission carrying the
  rec id; click "Not yet" instead → no submission.
- A `transition`-kind rec still applies one-click (no dialog regression).
- **Canary:** revert the `task-detail-page`/`task-main-sections` wiring → test 1 fails
  (submission fires immediately, dialog absent).
- Live: replay UC-05 (VC-1 shape) — Apply must now interpose the dialog before the merge.

---

## F19-4 — the operator's workspace holds only task.md; packets describe the store folder as "the repo" (R19-1)

**Status: CONFIRMED in code.**

### Current code

1. `app/server/runtimes/run-service.server.ts:356-357` — every run's default cwd:

   ```ts
   const workdir =
     input.workdir ?? taskDir(input.projectSlug, input.taskKey, input.dataRoot);
   ```

   Both operator start paths (`startRealOperatorRun` :1718-1742, `startCodexOperatorRun`
   :1138-1157 in operator-run.server.ts) call `startRun` with **no `workdir`** → the operator's
   cwd is the canonical store folder `projects/<slug>/tasks/<KEY>/`, which at triage contains
   exactly `task.md`.

2. The operator CAN read a checkout if one exists: `OPERATOR_DENIED_BUILTINS`
   (claude-runtime.server.ts:178-186) denies only `Bash/Edit/MultiEdit/Write/NotebookEdit` —
   `Read`/`Grep`/`Glob` survive. And the specialist clone lives **under the operator's cwd**:
   `taskWorkspaceRoot` = `<taskDir>/workspace` (specialist-run.server.ts:1592-1598), clone at
   `<taskDir>/workspace/<repo-name>` (:1606-1615). So post-execution the operator already sees
   the repo; **pre-execution (triage/scoping) nothing ever creates it** — exactly the VC-2/VC-4
   window where the model described the bare store folder as "Repo contents visible to
   operator: only task.md — no docs/ or README found".

3. Neither the shipped operator definition (`app/server/seed/assets/operator.definition.md`)
   nor `buildOperatorSystemPrompt` (operator-run.server.ts:1922-2093) ever tells the model
   where its cwd points or where a checkout would live — the confabulation had nothing to
   contradict it.

### Root cause

The operator was designed as a pure coordinator (toolkit instructions: "never write code or
touch the repository", operator-toolkit.server.ts:412), so no one provisioned it a working
tree; its cwd landing on the store folder is a `startRun` default, not a decision. R19-1 rules
the other way: packets must ground in the real repo, full read-only clone, persona fix alone
rejected.

### Fix (R19-1 — binding)

**(a) Ensure a checkout before the operator run starts.** New export in
`specialist-run.server.ts` next to `cloneRepo`:

```ts
/** R19-1: provision the task workspace checkout for a coordinator (operator)
 *  run. Clone ONLY when the checkout does not exist yet; an existing dir is
 *  returned untouched — the delivering engagement owns it (single-writer), and
 *  touching it live is the F19-15 strip hazard. No identity is stamped. */
export async function ensureTaskWorkspaceCheckout(
  db, ctx, input: { projectSlug: string; taskKey: string },
): Promise<{ dir: string | null; failureSentence: string | null }>
```

Implementation: derive `repo` via `projectRepo`; `taskCloneDir` existing + has `.git/HEAD` →
return it as-is (do NOT run `cloneRepo`'s reuse arm — that re-sanitizes the remote and
re-strips `.claude`, which is F19-15's mid-run hazard); missing → call `cloneRepo` **without
`identity`** (it already does askpass-env credentials, `--depth 1`, R18-3
`stripUngovernedRepoCatalog`, partial-clone cleanup — :1828-1926) and map its
`failure.sentence` through.

Call it in `runOperator` (operator-run.server.ts:688) once, before branching into
`startRealOperatorRun` / `startCodexOperatorRun`, threading the result into both. Best-effort:
a clone failure must not block the drive (the operator can still coordinate), but it must be
NAMED in the prompt (below). Codex operator needs no cwd change either — its read-only sandbox
sits on the same taskDir.

**(b) Tell the model the truth about its workspace.** `buildOperatorSystemPrompt` gains a
parameter `workspace: { repo: string; dir: string } | { failure: string } | null` and emits a
`# Your workspace` section:

- checkout present: "Your working directory is the task's canonical folder (`task.md` lives
  here). A read-only checkout of `<owner/repo>` is at `workspace/<name>/` — ground every claim
  about the repository (files, docs, conventions) in that checkout. You cannot push, commit,
  or edit it."
- clone failed / no repo: "No repository checkout is available this run(: <sentence>). Never
  describe your working directory or the task folder as the repository — say the checkout is
  unavailable instead."

The second sentence is the persona half the finding asked for, and it is stated in BOTH arms so
the confabulation class is closed even when the clone fails.

**(c) Depth note.** `cloneRepo` is `--depth 1` of the default branch — that satisfies R19-1's
"full read-only clone" for scoping (full tree, single revision). If the owner meant full
history, drop `--depth 1` for the operator path only — not assumed here.

Interactions: watcher-safe (`shouldIgnoreWatchPath` already excludes workspace clones,
file-watch.service.server.ts:214-225 / F-SPAWN1). Specialist fresh-run reuse path
(:1858-1869) handles a pre-existing operator-made clone identically to today's second-run
reuse. Coordinate with the F19-15 fix — (a) deliberately never touches an existing dir for
this reason.

### Test plan

- `app/server/tasks/specialist-run.server.test.ts`: `ensureTaskWorkspaceCheckout` — clones when
  missing (fake git via the existing clone-test seams), returns existing dir untouched
  (mtime/marker file unchanged — the no-touch pin), returns `failureSentence` on failure,
  `dir: null` on a repo-less project.
- `app/server/runtimes/operator-run.server.test.ts`: a real-operator start captures a
  systemPrompt containing `# Your workspace` + the checkout path when the clone succeeded; the
  failure arm contains "Never describe your working directory … as the repository"; a
  repo-less project gets the no-checkout arm and no clone attempt.
- **Canary:** revert the `runOperator` wiring → the systemPrompt assertions fail.
- Live: fresh project + new task on akin-ozer/viberr, run operator at triage, ask it (via
  comment) what is in the repo — the packet/answer must name real top-level files (README,
  docs/), and the VC-2 "add a README" class of invented option must not reproduce.

---

## F19-6 — clone failure diagnostics: `git exit 128` with the WHY discarded

**Status: CONFIRMED in code.** (No pass-19 ruling needed — honesty fix; scrub design is
constrained by FR34/NFR7.)

### Current code

`app/server/tasks/git-clone-auth.server.ts:223-247`:

```
/**
 * Return an intentionally small, credential-safe description for logs.
 * `Error.message`, `stderr`, and `cmd` are deliberately ignored because child
 * process errors may echo command arguments or authentication diagnostics.
 */
export function cloneFailureLogDetails(error: unknown): CloneFailureLogDetails {
```

`CloneFailureLogDetails` (:183-187) carries only `reason/exitCode/signal`, so every downstream
surface — `logger.warn` (specialist-run.server.ts:1906-1913), the timeline note (:941-960 —
"**Workspace checkout failed:** …"), the agent prompt (:1425-1432), and hence the operator's
blocked packet — can only say "git exit 128". VC-3 live: hadCredential:true, same repo clones
from the shell, nobody could act.

The redaction premise is verified: `createGitHubClonePlan` (:110-150) passes the token ONLY via
`ASKPASS_PASSWORD_ENV` env (:143-144) — never argv, never the URL (`githubRepositoryUrl`
builds the public https URL). So stderr can contain the token only if git itself echoed the
askpass response, which it does not; scrubbing the known token string is belt-and-braces.

### Fix

Extend the details, keep the fail-closed posture:

- `CloneFailureLogDetails` gains `stderrExcerpt?: string`.
- `cloneFailureLogDetails(error, opts?: { scrub?: readonly string[] })`: extract
  `error.stderr ?? error.message`, then sanitize: replace every occurrence of each `scrub`
  value (the PAT) with `***`, strip ANSI/control chars, collapse whitespace, drop any
  `x-access-token:[^@]*@` userinfo pattern (legacy-URL belt), cap at ~400 chars with an
  ellipsis. Empty after sanitizing → field omitted (today's behavior).
- `cloneRepo` (specialist-run.server.ts:1899-1913) passes `{ scrub: token ? [token] : [] }` —
  the token is already in scope (:1874). It flows automatically into the `logger.warn`, and
  `cloneFailureSentence` (git-clone-auth.server.ts:199-221) appends it on the `clone_failed`
  arm: `` … (git exit 128). git said: `<excerpt>`. <cred sentence> `` — which reaches the
  timeline note, the agent prompt, and the operator packet with zero further plumbing.
- F19-18 (push failure recorded nowhere, `push-workspace.server.ts:401`) is the same shape —
  its audit spec should reuse this sanitizer (export it, e.g. `sanitizeGitStderr`), not grow a
  second one.

### Test plan

`app/server/tasks/git-clone-auth.server.test.ts` (exists):

- stderr containing the scrub token → excerpt present, token replaced by `***`, sentence
  contains the excerpt.
- `x-access-token:SECRET@github.com` in stderr → userinfo scrubbed even when no scrub list.
- long/ANSI stderr → stripped + capped; ENOENT still `git_unavailable` with no excerpt;
  killed/signal still `clone_terminated`.
- **Canary:** revert the sanitizer wiring in `cloneRepo` → the sentence/excerpt assertions fail.
- Live: break the repo remote deliberately (bad repo name on the project), run a specialist —
  the timeline note must quote git's actual complaint with the credential absent.

---

## F19-21 — R17-2's "Completed — no changes" is unreachable without a delivery ATTEMPT

**Status: CONFIRMED in code.** Needs an owner decision (no R19-x ruling covers it).

### Current code

`fm.noChanges` has exactly two writers, both inside `performDelivery`:

- `task-actions.server.ts:3480-3484` — push outcome `no_commits` ("Nothing to deliver").
- `task-actions.server.ts:3604-3624` — PR-open outcome `nothing_to_review` ("Review has no PR").

Both require a delivery attempt that gets far enough to VERIFY an empty branch: a workspace
must exist and be on a task branch (`no_workspace`/`no_branch`/`no_repo` return as plain
failures at :3451-3491 and never set the flag). A verify-only task whose deliverer never
created commits or a branch — VC-5's exact shape — can never reach the flag.

Then the gate chain blocks acceptance anyway (`acceptanceRefusalReason`,
task-actions.server.ts:4740-4765): with a verdict-capable reviewer engaged and **no
`workRevision`**, `acceptanceBlockedReason` (`task-file.schema.ts:581-587`) fires first:

```ts
if (!fm.workRevision) {
  return required.length > 0
    ? "No reviewed revision yet — nothing for the required reviewers to approve."
    : null;
}
```

— the literal `[noop]` VC-5 got from `accept_completion` (surfaced via `acceptanceRefusalFor`,
operator-actions.server.ts:2049-2054). That arm has no `noChanges` awareness; `noChanges` is
only honored one gate later in `verdictGateReason` (task-actions.server.ts:4707-4716) and only
when a `workRevision` EXISTS with no PR. Reviewer verdicts can't help: with no revision they
record as unbound ("approved, but there is no delivered revision to bind the verdict to yet",
task-actions.server.ts:1969-1972) and `currentVerdicts` returns `[]` (schema :544-551). The
operator's only remaining exits are exactly the ones R17-2 (ruling 43) exists to forbid:
force-accept, archive, or a "Manually mark Done" packet.

### Root cause

R17-2 was implemented as a *delivery outcome annotation* (F17-L9 patched the two empty-branch
buckets) rather than as a first-class completion path; the verdict model (verdicts bind to a
revision id) has no representable "approved: nothing to change" state, so a no-branch task
cannot satisfy the required-reviewer gate even in principle.

### Decision needed (owner)

**How does a task that never needed a branch DECLARE the verified no-change outcome?** Options:

- **A. Auto-detect at operator accept:** when `operatorAcceptCompletion` (or human accept) runs
  on a task with no `workRevision`, no branch, and no workspace commits ahead of the default
  branch, the server verifies emptiness itself and proceeds as a no-change completion.
  Least ceremony; risk: "nothing was delivered" and "nothing needed delivering" are
  indistinguishable — a stalled task could be closed as a clean no-op.
- **B. Explicit declaration action:** a new governed action — operator tool + packet-option
  kind and/or a human affordance on the task page — "Complete with no changes required", which
  server-verifies emptiness (no workspace, or workspace with zero commits ahead), sets
  `noChanges`, and then routes through the NORMAL acceptance ceremony (confirm dialog already
  has the no-changes arm — `accept-confirm.tsx:85-89`). Keeps humans in the loop; adds a 10th
  packet-option kind (ruling 7 lists nine — needs a docs+schema amendment).
- **C. Reviewer-anchored:** a required reviewer's approve on a no-revision task counts as the
  verification. Weakest: today that verdict is recorded unbound, and re-purposing it changes
  verdict semantics everywhere.

**Mechanical substrate (needed under every option, spec it once decided):** mint a synthetic
no-change `workRevision` at declaration time — `headSha`/`treeSha` = the default branch head,
`branch` = default branch, alongside `noChanges: true`. Then verdicts bind normally
(reviewer can genuinely approve "the repo as it stands"), `deriveValidation` and
`acceptanceBlockedReason` work UNCHANGED, and `verdictGateReason`'s existing
`fm.noChanges → null` arm (:4715) admits the PR-less acceptance. Without the mint, option A/B
must also special-case the schema's no-revision arm — two gates growing `noChanges` awareness
vs one mint; the mint is strictly less gate surgery.

### Test plan (once ruled)

- `app/server/tasks/task-actions.server.test.ts` (or `acceptance-graph.server.test.ts`):
  a task with an engaged verdict-capable reviewer, no branch/workspace → declaration path sets
  `noChanges` + mints the revision; reviewer approve binds; `acceptCompletion` closes to Done
  with the "completed with no changes required" completion event (existing copy at :5236) and
  no merge attempt; the R17-2 clear-on-real-delivery (:3540-3548) still clears the flag when a
  later delivery opens a PR.
- Negative: a task WITH remote commits ahead must refuse the declaration.
- **Canary:** revert the declaration writer → the acceptance test reproduces VC-5's
  `No reviewed revision yet` refusal verbatim.
- Live: replay UC-20 (VC-5 shape) end-to-end to Done with the ceremony, no force-accept.

---

### Cross-references

- F19-7 (packet accept option, `decision-packet.tsx:329`) — same R15-1 family as F19-3; fix in
  the same wave; spec in `audit-workflow-result.json`.
- F19-18 (push-failure diagnostics, `push-workspace.server.ts:401`) — reuse F19-6's
  `sanitizeGitStderr`.
- F19-15 (`.claude` strip under a live run, `specialist-run.server.ts:1868`) — F19-4's
  `ensureTaskWorkspaceCheckout` deliberately never touches an existing checkout so it cannot
  widen that hazard.
