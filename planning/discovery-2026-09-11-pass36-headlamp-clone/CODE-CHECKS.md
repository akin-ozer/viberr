# Pass 36 — code checks for the observed candidates

Read-only verification against `main` at `e0953f7f` (2026-09-11). Every line number below
was read, not inferred. Rulings cited from `docs/architecture/decisions.md` (R17-1 at
:450, 98 at :1419, 122 at :2137, 132 at :2421, 133 at :2453, 158 at :3119, 160 at :3225,
162 at :3319, 163 at :3356).

---

## A. Viberr-authored next step ignores the validation state — CONFIRMED

**Path.** The operator's `deliver_for_review` calls `performDelivery` with
`operatorAuthorized: true` (`app/server/tasks/operator-actions.server.ts:2932-2943`). Inside
`performDelivery` (`app/server/tasks/task-actions.server.ts`):

- `moved = result.created || push.status === "pushed"` (:6250). A re-delivery with nothing
  to push is `up_to_date`, so `moved` is false.
- The ruling-163 delivery door `returnChangedRevisionToReview` runs only `if (moved)`
  (:6265-6267) — skipped.
- Supervised + `ctx.operatorAuthorized` → `recordDeliveredNextStep` (:6281-6289), unconditionally.

`recordDeliveredNextStep` (:6716-6810) checks exactly: project archived (:6725), a structural
review stage exists (:6726-6727), task exists (:6728-6729), task archived (:6731), stage index
strictly before the review index (:6734-6736), a declared workflow edge `stage → review`
(:6740), and `alreadyActionable` (:6741; :6817-6820 = open packet or any non-`delivery`
recommendation). It never reads `validation`, `verdicts`, or `workRevision`. The card is
`kind: "transition", toStageId: reviewStageId` (:6751-6757) with the "Recorded by Viberr …
not the operator agent's judgement" detail (:6744-6748).

**Why it says "Merge Approval".** `reviewStageIdOf` (:311-313) is `resolveStageRoles(...).reviewId`
(`app/shared/workflow/stage-roles.ts:43-56`): the stage with a workflow edge INTO the terminal
stage — on this board that is Merge Approval, not Agent Review. So a task sitting at Agent
Review with `validation: failing` is "strictly before the review stage" and gets a card that
moves it past the stage where its reviewer works.

**Would applying it be refused?** No — it lands.

- `applyRecommendation` (:10660) `transition` arm (:10758-10787): a declared edge means
  `manual` stays unset; it calls `transitionStage(db, move, actor, ctx)` (:10787).
- `transitionStage` (:5059) gates: unknown stage (:5120), archived task (:5131-5139),
  boundary/manual/rework (:5141-5178), RBAC tiers (:5180-5260). Nothing reads validation or
  `mergeReadinessRefusal`.
- Ruling 162's `mergeStageEntryRefusal` lives only in `operator-actions.server.ts:3366-3387`
  and is called only by the operator's own `transition_stage` (:3093). It reads
  `mergeReadinessRefusal` (`task-actions.server.ts:9116-9129`), whose two gates are "unpushed
  delivered revision" and "conflicting PR" — `validation: failing` is not one of them, by the
  ruling's own text ("the MOVE … reads the pull-request half ALONE").
- Ruling 163's three doors (operator rework move on `changed`, conflict-packet redirect,
  delivery that moved the head) do not include a human applying a transition card.

**Root cause.** The F19-1 card was designed for the shipped 4-stage board where "the stage
before the structural review stage" is the work stage. On a board with a verdict stage
between work and the acceptance boundary, "strictly before the review stage" includes the
verdict stage, and the writer has no notion of a failing verdict, so it proposes the one
move ruling 163 exists to reverse.

**Fix.** `recordDeliveredNextStep` (`task-actions.server.ts:6716`): return early when
`deriveValidation(fm) === "failing"` (a rejected revision's honest next step is rework, not
Merge), and when `verdictStageOf(ctx, projectSlug, project, fm)` is null while a required
reviewer is eligible at the current stage (a verdict can be given HERE; the card should not
move the task). Keep the writer as the single home; do not add a validation gate to
`transitionStage` or `mergeStageEntryRefusal` without a ruling, since 162 pins that gate to
the PR half alone.

**Test.** `app/server/tasks/delivery-actionable.server.test.ts` → `describe("F19-1 — a
successful delivery leaves an actionable next step")` (:448): red = a task at the verdict
stage with `validation: failing` and a reused PR gets no `transition` card.

---

## B. Archive dialog promises "Restoring the task reopens the question" — CONFIRMED

**Path.** Two dialogs still carry the sentence:
`app/features/task-detail/archive-confirm.tsx:110-111` (the Archive button's confirm) and
`app/features/task-detail/decision-packet.tsx:413` (`PacketArchiveConfirm`, the
`archive_task` option's confirm, reached from `resolvePacket`'s `archive_task` arm
`task-actions.server.ts:8277-8283`).

`setTaskArchived` (`task-actions.server.ts:7217`): archiving sets `waiting = "none"`,
`recommendations = []`, `packet = null` and cancels pending schedules (:7277-7295). Restoring
sets only `waiting = "human"` (:7296-7300) and writes the "Restored … waiting on a human. Run
the operator to reopen coordination" note (:7268-7272). The server's OWN archive note was
already corrected under F20-25 to "Restoring the task brings it back to a human, who can run
the operator to reopen the decision" (:7251-7259) — the comment at :7251-7256 explains the
packet's options are discarded, so restore cannot re-open the same decision. No code path
re-opens a withdrawn packet on restore (`task.unarchived` audit at :7308 carries no packet).

**Root cause.** F20-25 fixed the server note and the dialog copy was left behind; the
dialogs and the server now make opposite promises about the same act.

**Fix.** Replace the sentence at `archive-confirm.tsx:111` and `decision-packet.tsx:413`
with the server note's wording ("Restoring brings the task back to a human; run the operator
to reopen the decision"). Copy only; no server change.

**Test.** `app/features/task-detail/task-disposition.test.tsx` → `describe("R14-3: the task
archive")` (:1340), beside `it("C14: the Withdrawn row names its scope …")` (:1354); and
`describe("UX19-9: a packet archive_task option states what it destroys")` (:1638) for the
packet dialog.

---

## C. Closed-PR recovery paragraph on a branchless INPUT packet — CONFIRMED

**Path.** `app/features/task-detail/decision-packet.tsx:927-929`:

```ts
const branchDiscardOffered = p.options.some(
  (o) => o.kind === "archive_task" && o.deleteBranch === true,
);
```

rendered at :1285 (`canResolve && branchDiscardOffered`). It keys on the OPTION LIST alone.
The docblock (:900-926) rests on an assumption — "the operator only authors it when the task
HAS a branch" — that nothing enforces: `operatorOpenPacket` copies `deleteBranch` through
(`operator-actions.server.ts:1316`) without reading `fm.branch`, and the instruction text
(:1135, :1264) invites the option on any archive-shaped packet. The card already receives
the facts it needs: `archiveDisclosure` (:788; interface :110-140 with `branch`, `openPr`,
`foreignHead`, `unownedPr`), populated by `task-detail-page.tsx:721-735` with
`branch: task.branch`.

**Root cause.** An option-shape proxy stands in for the task fact (a closed PR on a real
branch) the paragraph describes.

**Fix.** `decision-packet.tsx:927`: `branchDiscardOffered && archiveDisclosure?.branch !== null`
(no branch → no Deliver refusal to explain). Optionally, `operatorOpenPacket`
(`operator-actions.server.ts:1316`): strip or refuse `deleteBranch` when the task has no
`branch`, so the option cannot promise to delete nothing.

**Test.** `app/features/task-detail/task-detail-components.test.tsx` → `describe("UX19-4: the
recovery packet names the in-app re-delivery path")` (:2261): red = same packet with
`archiveDisclosure.branch = null` renders no "Not in this list" paragraph.

---

## D. Operator's own `post_comment` re-invokes the operator — REFUTED (as a comment→wake path)

**Path.** `post_comment` (`app/server/tasks/operator-toolkit.server.ts:341-352`) →
`operatorPostComment` (`operator-actions.server.ts:2226-2253`) → `writeOperatorComment`
(:664-786): guardrails, timeline append, reproject, `notifyMentionedUsers` (:753-759), audit
`task.operator.commented` (:773). No `runOperator`, `autoInvokeOperator` or `commentToAgent`
call exists in `operator-actions.server.ts` (the only hit is a comment at :575). The human
`@operator` door (`task-actions.server.ts:1731-1741`) is not reachable from the tool.

**What the `runtime.run.started` after it is.** The comment is typically the drive's last tool
call; the next run is the turn-end machinery in `app/server/runtimes/operator-run.server.ts`:
`operatorLeftTaskStranded` (:832-850 — no packet, no recommendation, no `blockedBy`, and an
`auto` outbound boundary OR the drive's own move landed here) → `maybeResumeStrandedOperator`
(:862) fires `runOperator({ trigger: "transition", strandedResume: true })` (:1091-1097).
It is bounded: one nudge per stage, a nudge that ends where it started records
`heldAtStage` with a "deliberate hold" note (:994-1010), chain cap 8 (:1043). The operator's
own `transition_stage` re-trigger is the other source. Both are documented as intended:
`docs/domain/operator.md:139-160` (stranded drive → one resume nudge → deliberate hold) and
:167 ("re-invoked only when its turn ends at a stage that still needs work").

**Verdict.** Not a loop by construction; the comment is coincident, not causal. To confirm on
the live audit, read the `runtime.run.started` details (`run-service.server.ts:903`) for
`trigger: "transition"` + the "deliberate hold" note; more than two consecutive starts on one
stage with no move would be a real defect against the caps at :994 and :1043.

**Fix.** None required. If the pairing misleads readers, the activity feed could label a
stranded-resume start distinctly (`app/server/projections/activity-feed.server.ts:470`).

**Test (if pursued).** `operator-run.server.test.ts` → `describe("stranded auto-stage
resume")` (:1343) / `describe("settle-time resume (integration)")` (:1418).

---

## E. `retry_other_backend`: sticky backend + silent model fallback — PARTLY

**(1) Resolve arm.** `task-actions.server.ts:7787-7809` writes the transition event
("Re-running on Claude with a fresh context", :7800), `waiting = "agent"`, clears the packet;
:8808-8818 calls `startAgentRun({ backendOverride: target })` (:8816).

**(2) Persistence.** `app/server/tasks/specialist-run.server.ts:1461-1465`:
`backend = backendOverride ?? engagement.pinnedBackend ?? resolved.backend ?? snapshot`;
at :2170-2180 the engagement row gets `engaged.backend = backend` (:2171) and
`engaged.pinnedBackend = input.backendOverride` (:2179). F27-B1 (owner ruling 2026-08-24) says
the pin STICKS over the live profile — comment :2173-2178, documented in
`docs/domain/agents-and-runtime.md:643-645` and `task-lifecycle.md:273-295`. The operator's
next `run_agent` on that profile therefore runs on Claude. **Intended.**

**(3) Model.** On the cross-backend branch (:1492-1500) the stored model is never consulted:
`model = resolveRunModel(backend, undefined)` (:1500) = `defaultModelFor(backend)`
(`app/server/runtimes/model-catalog.server.ts:355-361`). `gpt-5.6-luna` → `sonnet`.

**(4) Disclosure.** The timeline says "Started a Claude run for the … agent (switched from
Codex)" (:2181-2186) — backend only, no model. The F21-13 first-line notice
(`run-service.server.ts:1770-1789`) fires only when `foreignModelBackend(input.backend,
input.model)` detects a foreign id (:831-845, :1022) — but specialist-run already swapped the
model to the default BEFORE building the spec, so run-service sees a valid model and writes
neither the notice nor the `run·model_substituted` warn. The run row's `model` column (the
Agent-logs header) is the only place `sonnet` is visible; no timeline, notification or
packet-resolution text names it.

**Verdict.** Stickiness intended and documented; the model fallback is undisclosed
(PARTLY).

**Fix.** `specialist-run.server.ts` dispatch, the switched-backend event (:2181-2186): when
`backend !== resolved.backend`, append "on `<model>` — the profile's `<resolved.model>` is a
<other> model" and thread a `notice` so F21-13's log line fires (pass the ORIGINAL profile
model to `startRun` and let run-service's :831 branch do the swap, instead of pre-swapping at
:1500).

**Test.** `specialist-run.server.test.ts` → `describe("engagement uniqueness
(adversarial-review)")` (:391) hosts the F27-B1 pin test at :485; add the disclosure case
beside it. `run-failure-remedy.server.test.ts:159` covers the packet's option text.

---

## F. `@operator` on an ARCHIVED task starts a run; the button refuses — CONFIRMED

**Mention door.** `commentToAgent` (`task-actions.server.ts:1575`): `appendComment` (:1241)
guards only `requireProjectMutable` (archived PROJECT); the `@operator` branch (:1731-1741)
calls `runOperator({ trigger: "manual", actor })` and handles only `result.refused`
(:1747-1757). No `archived` read.

**`runOperator` refusals** (`operator-run.server.ts`): `terminal-stage` (:1470-1514) is scoped
to `trigger === "scheduled"` — the comment at :1484-1487 explicitly admits "an `@operator`
question about finished work"; `blocked-by` (:1523-1549); `open-packet` (:1551-1573). The
only `archived` reads in the module are the stranded backstop (:846) and doctrine prose.
The `liftHoldForRun` path (`docs/domain/operator.md:108-118`) also runs for a manual actor run.

**Button.** `task-detail-page.tsx:309-312` `taskClosed = accepted || merged || archived` →
`execution-profile.tsx` `disabled` → copy :492-497 ("Task closed. Reopen it to run the
operator. Mentioning `@operator` in a comment still runs it"); the N20-17 comment says the
copy was added to DISCLOSE the inconsistency, not close it.

**Pattern to copy.** `app/server/tasks/schedule.server.ts:451-475`: `mootNow = projectFrozen ||
archived || terminal` → occurrence retired `fired`, "Scheduled action skipped: … has been
archived" note, audit outcome `skipped-archived`.

**Root cause.** Archive (R14-3) was added after the mention door; the door's refusals were
written for packets/holds/Done, and "archived" was disclosed in copy rather than gated.

**Fix.** `operator-run.server.ts` `runOperator`: beside the open-packet check (:1551), refuse
`manual` + actor (human) triggers when `readTaskFile(...).frontmatter.archived === true` with a
new `refused: "archived"` (union at :283); `commentToAgent`'s existing refusal branch (:1747)
then writes the F35-5 "Mention not started" note; delete the second sentence at
`execution-profile.tsx:496-497`. Leave `pr-diverged`/`agent-reply` machine triggers alone.

**Test.** `task-actions.server.test.ts` → `describe("F35-5: an @mention whose run did not
start leaves a note and an audit row")` (:4600); refusal shape from
`operator-run.server.test.ts` → `describe("ruling 131(d): a held task refuses the coordinating
triggers at no cost")` (:2822).

---

## G. Post-review AUTHORED drift is silent and escapes ruling 163 — CONFIRMED

**Reconciler** (`app/server/github/github-reconciler.server.ts`): the drift block (:504-560)
classifies `reviewedSha...head` via `classifyRevisionDrift` (:537-548) and stores it as
`owned.revisionDrift` (:613-615). It never compares against `cachedPr.revisionDrift` for a
transition, writes no note, no `notifyTaskWatchers`, no wake. The wake predicate (:1062-1068)
is `mergedButNotDone || closedButActive || acceptedClosedExternally || prJustReopened ||
prReplacedLive` → `"pr-diverged"`; the notification (:1027-1058) keys on
`divergenceText ?? acceptedClosedText ?? reopenedText`. `revisionDrift` is in neither.

**Why 163 does not fire.** All three doors key on the WORK revision:
`returnChangedRevisionToReview` (`task-actions.server.ts:6581-6634`) requires
`deriveValidation(fm)` ∈ {changed, failing} (:6593-6594) and only runs when the delivery
`moved` the head (:6265-6267); the operator's rework move requires `validation === "changed"`
(:5150-5160). `deriveValidation` (`app/schemas/task-file.schema.ts:1044+`) reads
`currentVerdicts`, which filters `fm.verdicts` by `v.revisionId === activeWorkRevision(...).id`.
A foreign push moves `pr.headSha`, never `workRevision`, so the approve verdict stays bound
and `validation` stays `healthy`. Ruling 163's text ("a revision that changes after a
verdict") was implemented as "the task's work revision", and R17-1 (:450-461, amended by 132
:2421) deliberately keeps acceptance containment-based — drift is "surfaced", never blocking —
so the `accept_completion` recommendation and gate stay applicable
(`mergeReadinessRefusal` :9116-9129 reads unpushed | conflicting only).

**Commits list.** `taskCommits` (`branch-sync.server.ts:348-358`) keeps only commits whose
message starts with `[<key>]`; the reconciler applies it at :719-724 and the page renders
`task.commits` (`task-side-panels.tsx:383-390`). A foreign commit without the prefix is
dropped from the list by design (F31-1), so the one fact that would show the drift is filtered out.

**Reviewer at Merge Approval.** `specialist-run.server.ts:4049` — stage eligibility fences NEW
engagements (ruling 133); a required reviewer declared for Agent Review cannot be summoned
there.

**Fix.** Reconciler drift block (:537-548 / :613-615): compute `authoredDriftIsNew =
revisionDrift?.authored > 0 && (cachedPr?.revisionDrift?.headSha !== pr.headSha)`; on it,
append a policy-engine note printing `describeRevisionDrift` (`app/shared/revision-drift.ts`),
`notifyTaskWatchers({ kind: "policy", title: "PR #N: N commits added since review" })`, and
add it to the wake predicate at :1062. The automatic move back needs an owner re-ruling of
163 (it was ruled on the work revision); until then the operator wake + `verdictStageFor`
rework route (`operator-actions.server.ts` rework move) is the honest path.

**Test.** `github-reconciler.server.test.ts` → `describe("ruling 132: drift is classified,
not counted")` (:3190) for note/notify; `pr-divergence-wake.server.test.ts` →
`describe("pr-diverged wakes the operator")` (:165) for the wake.

---

## H. SKILL.md body accepted with literal `\n` and zero newlines — CONFIRMED

**Writers, none validating the body.**

1. Controller `save_skill` (`app/server/controller/controller-toolkit.server.ts:589-615`):
   passes `args.body ?? ""` straight to `saveSkill` (:601-610).
2. Org-settings `skill-save` action (`app/routes/org.settings.tsx:621-633`): same call.
3. `saveSkill` (`app/server/org/resources.server.ts:2192-2292`): validates name length
   (:2215), summary length (:2216-2217), the 256 KB truncation round-trip (:2247-2259), the
   symlink containment (:2264-2266), and name clashes — then
   `writeFileSync(path.join(dir, "SKILL.md"), body)` verbatim (:2288).
4. Store upload / GitHub import `writeStoreFiles` (`app/server/org/store-files.server.ts:282`):
   type-collision pre-flight (:299, :308), then `writeFileSync(abs, file.data)` (:320); the
   `SKILL.md` branch at :326 only shapes the toast.

**Mount.** Claude: `mountOneSkill` (`app/server/runtimes/skill-mount.server.ts:561-630`) copies
the folder, `splitFrontmatter` (:598), `skillFrontmatterSchema` (:599), rewrites the file with
normalized frontmatter (:611-620); `skillDescription` (:673-690) takes the body's "first line"
— with a one-line body that is the whole escaped text, clipped at 400 chars. Codex: prompt-text
injection (`codex-runtime.server.ts:334-342`, `readSkillBody` `skill-body.server.ts:203-208`),
so the model reads the escaped text as-is.

**Root cause.** Every writer treats the body as opaque bytes; the store's only guards are
containment and truncation.

**Fix.** One function `assertSkillBodyWellFormed(body)` in `app/server/files/skill-body.server.ts`
(already the SKILL.md containment/reading home), called from `saveSkill` before :2288 (covers
both the tool and the action) and from `writeStoreFiles` under the :326 `SKILL.md` branch.
Shape: refuse when `body.includes("\\n") && !body.includes("\n")` (or a `\\n` count above a
small threshold with zero real newlines) and when `splitFrontmatter` throws; the refusal names
the remedy ("the body arrived JSON-escaped; send real newlines"). Refuse, never rewrite.

**Test.** `app/server/org/resources.server.test.ts` → `describe("skills")` (:342);
`controller-toolkit.server.test.ts` beside `describe("save_global_agent: grants are store
keys …")` (:1029).

---

## I. Suffixed branch allocation never names the taken canonical name — CONFIRMED

**Path.** `app/server/github/branch-sync.server.ts`: `allocateTaskBranchName` (:157-170)
returns `{ status: "ok", branch, suffixed }`; `ensureTaskBranch` (:539) takes only
`branch = allocated.branch` (:593) — `suffixed` is dropped and the canonical name is never
captured (`probeBranchNameTaken` :90-125 returns `{ kind: "taken" }` with no reason).
Persist: `patchTaskFrontmatter(taskRef, { branch })` (:728-733). Audit
`github.branch.created` with `details: { repo, from }` only (:736-746). No timeline note
anywhere on the path; `ensureTaskBranchBestEffort` (:403-470) discloses only failures.

**Root cause.** Ruling 122(b) specified persistence ("to `task.md` `branch:`") and said
nothing about disclosure, so the allocator was built silent.

**Fix.** `ensureTaskBranch` after :593: when `allocated.suffixed`, add `canonical:
taskBranchName(taskKey), suffixed: true` to the audit `details` (:745) and
`appendTimelineEvent` a policy-engine note: "Branch `hlc-10-0c88` allocated: `hlc-10` is
already spoken for on GitHub (a ref or a past pull request), ruling 122." Optionally return
the `taken` reason from `probeBranchNameTaken` (:105, :125) to name which.

**Test.** `branch-sync.server.test.ts` → `describe("ensureTaskBranch")` (:191), `it("ruling
122: takes a suffixed name when a past pull request used the canonical one")` (:242): assert
the audit detail and the note.

---

## J. Branch collision notifies nobody and wakes no operator — CONFIRMED

**Path.** `github-reconciler.server.ts`: `unownedPr` (:485), `unownedPrIsNew` (:747-748),
`collisionNote` via `prAdoptionRefusalNote` (:753-762); written as a timeline note only
(:928-937). `notifyTaskWatchers` is called for PR adoption (:1003-1024) and for the
divergence trio (:1034-1056, keyed on `divergenceText ?? acceptedClosedText ?? reopenedText`);
the wake (:1062-1081) is keyed on the five PR-transition flags. Neither includes the
collision. Ruling 122(d)/50 keeps the collision PACKET as the backstop, but the packet is
operator-authored (`operator-actions.server.ts:1135`) and only on the operator's next turn —
which nothing schedules.

**Fix.** At :937, after the note: `notifyTaskWatchers({ kind: "policy", title: "Branch name
collision on KEY: PR #N is not this task's", text: collisionNote })` guarded by
`!ctx.suppressDivergenceNotice`; add `(unownedPrIsNew && collisionNote)` to the wake predicate
at :1062 so the ruling-50 packet actually gets authored.

**Test.** `github-reconciler.server.test.ts` → `describe("reconcileTask")`, beside `it("F31-1:
a colliding branch's footprint is never recorded as this task's stats")`; wake in
`pr-divergence-wake.server.test.ts` → `describe("pr-diverged wakes the operator")` (:165).

---

## K. Codex runtime — code map (no verdict)

**(1) Spawn env / CODEX_HOME.** `runCredentialFor` (`app/server/runtimes/backend-credentials.server.ts:910-951`):
`homeDir = ensureUserBackendHome(userId, backend)` (:927) =
`<dataRoot>/runtimes/users/<userId>/codex-home` (`user-homes.server.ts:15`, :71-100);
`env.CODEX_HOME = homeDir` (:928-930). A `login` row adds nothing — the binary reads
`auth.json` from the home (:932-934; `codexLoginCredentialPath` :107-109); a pasted key rides
as `CODEX_API_KEY` / `CODEX_ACCESS_TOKEN` (:935-940). `runtime-registry.server.ts:71`
`RUNTIME_HOME_ENV_RE` strips ambient homes; `codex-runtime.server.ts:900-922` merges
`deps.env` + `spec.env` into `codexOptions.env` (the SDK replaces the child env wholesale).
`config.toml` is layered per leaf key by `codexConfigForRun` (:326, :410), never rewritten.

Per-run home is not a drop-in: the CLI writes token refreshes back to `$CODEX_HOME/auth.json`
and rollouts to `$CODEX_HOME/sessions`, and `resumeRun` depends on those sessions (:576, :636).
A per-run directory seeded from the person's home would have to copy `auth.json` back after
the run (last-writer-wins across concurrent runs of one person) and keep `sessions/` shared
or symlinked. The live shared home is why `ensureUserBackendHome` exists.

**(2) Sandbox mode.** `resolveCodexSandboxMode` (`codex-runtime.server.ts:474-502`): operator
→ `read-only` (:477); evidence carve-out → `workspace-write` (:483); full-power → `danger-full-access`
(:499); else `workspace-write` (:501); applied at :936-940. A pre-flight probe belongs beside
the existing resume pre-flight (:576): a once-per-process `probeCodexSandbox()` that runs the
CLI in `workspace-write` on a trivial command and caches the verdict, read at :936 to refuse
with a named remedy and surfaced through `healthSnapshot` (see L).

**(3) Deployment.** `compose.yml:18-28`: `security_opt: [seccomp=unconfined]` with the F36-1
comment (bwrap needs `unshare(CLONE_NEWUSER)`; Docker's default profile refuses it to the
non-root user; Chromium gets `--no-sandbox` at `Dockerfile:64`). `docs/operations/deployment.md`
has NO mention of seccomp, bwrap or the sandbox (grep empty): add a "Codex sandbox (seccomp)"
paragraph under `## What runs` (:12) or beside `## Agent accounts are per person` (:89), and
a runbook entry (`docs/operations/runbook.md`) for the "bwrap: No permissions to create a new
namespace" symptom.

---

## L. `instance_health` reports no toolchain — code map

`healthSnapshot` (`app/server/ops/health-snapshot.server.ts:93-140+`) is synchronous; KEY
ORDER is part of the wire contract — new fields go at the END (:85-88). Its only cached probe
is disk: `cachedDataRootSpace` (`disk-space.server.ts:203-220`, 5 s TTL). The route
(`app/routes/resources.health.ts:72-91`) computes per request with no HTTP caching; the MCP
tool (`controller-ops-mcp.server.ts:209-258`) spreads the same snapshot (:227, :234).

**Where a probe goes.** New `app/server/ops/toolchain.server.ts` exporting
`cachedToolchain()` — memoized once per process (versions cannot change while the process
lives; `execFileSync` of `node --version`, `npm --version`, `git --version`, `python3 --version`,
`go version`, plus the pinned `codex`/`claude` CLI versions), appended as the LAST
`HealthSnapshot` field `toolchain`. `instance_health` inherits it through the spread.

**Test.** `health-snapshot.server.test.ts` → `describe("healthSnapshot and the quota
principal")` (:15); `controller-ops-mcp.server.test.ts` → `describe("instance_health:
aggregates, open to any signed-in person")` (:321).

---

## M. Controller cannot grant KBs/skills/MCPs to the operator deployment — CONFIRMED

**Path.** `update_agent_deployment` (`controller-toolkit.server.ts:1995-2130`): schema params
are `projectSlug, profileId, capabilities, backend, model, effort, stages, autonomy` — no
resources. The handler builds the form with `resources: view.resources` carried through
unchanged (:2099) and calls `updateAgentProfile` (:2108-2113), whose form schema already
accepts `resources` (`app/features/agents/agent-profile-actions.server.ts:236`, written at
:494 and :837 `definition.resources = form.resources`). `save_global_agent` (:734-760) says
outright "the operator [is a] system profile this tool cannot touch" (:735). The modal renders
`ResourcePicker` unconditionally (`create-profile-modal.tsx:1597-1601`; `isOperator` gates
only the capability catalogs :1319-1324), so a person can grant the operator resources and the
controller cannot.

**Minimal change.** Add optional `skills`, `mcps`, `kbs` arrays to `update_agent_deployment`
with `save_global_agent`'s semantics (:761-770: omitted = unchanged, `[]` = clear, grantKey
never id), validate against the store as :803 does, and merge into `resources` at :2099.

**Test.** `controller-toolkit.server.test.ts` → beside `describe("update_agent_deployment
carries the record it read (B5)")` (:1637), modeled on `describe("save_global_agent: grants
are store keys …")` (:1029).

---

## N. Boot recovery interrupts runs with no timeline event — CONFIRMED

**Path.** `finalizeOrphanedRuns` (`app/server/runtimes/run-recovery.server.ts:100-235`):
`patchRun(... state: "interrupted", interruptedReason: "restart")` (:137-143), audit
`run.recovery.reinvoked` (:193-204), `runOperator({ trigger: "manual" })` (:211-215). Its
imports (:1-7) hold no file writer; nothing appends to the task. Only controller conversations
get a note (`controller-run.server.ts:713`). Ruling 158 records the live shape ("boot recovery
interrupted 23 runs and re-fired 23 operator turns") with nothing on any task.

**Writer rule.** `docs/development/contributing.md:45-50`: never write canonical files
directly; use `updateTaskFile` / `appendTimelineEvent` / `patchTaskFrontmatter`, and every
governed action that is user-visible records a typed timeline event. Boot recovery runs in the
server process after it holds the writer lock (ruling 158: the server is the one writer), so
calling `appendTimelineEvent` from `~/server/files/task-writer.server` is inside the rules —
the reconciler imports it statically (:22); run-recovery should dynamic-import it like it does
`operator-run` (:210) to stay cycle-free.

**Fix.** In the orphan loop (:137-150), after `patchRun`, for non-controller runs: one
policy-engine `note` per task (dedupe through `realTasks`) — "**Interrupted by a restart:**
the <kind> run was still running when the server stopped; the operator is re-invoked to
decide what to do" — naming each run id, and mention the crash-loop cap when `capped`.

**Test.** `run-recovery.server.test.ts` → `describe("finalizeOrphanedRuns (F-RUN1)")` (:86).

---

## Summary

| Item | Verdict | Fix file (function) | Test file (describe) |
|---|---|---|---|
| A | CONFIRMED | `app/server/tasks/task-actions.server.ts` (`recordDeliveredNextStep`) | `delivery-actionable.server.test.ts` ("F19-1 — a successful delivery leaves an actionable next step") |
| B | CONFIRMED | `app/features/task-detail/archive-confirm.tsx:111`, `decision-packet.tsx:413` (copy) | `task-disposition.test.tsx` ("R14-3: the task archive"; "UX19-9 …") |
| C | CONFIRMED | `app/features/task-detail/decision-packet.tsx` (`branchDiscardOffered`) | `task-detail-components.test.tsx` ("UX19-4: the recovery packet names the in-app re-delivery path") |
| D | REFUTED | none (turn-end stranded resume, bounded) | `operator-run.server.test.ts` ("stranded auto-stage resume") |
| E | PARTLY | `app/server/tasks/specialist-run.server.ts` (dispatch event + notice) | `specialist-run.server.test.ts` ("engagement uniqueness (adversarial-review)", F27-B1 case) |
| F | CONFIRMED | `app/server/runtimes/operator-run.server.ts` (`runOperator`, new `refused: "archived"`) + `execution-profile.tsx` copy | `task-actions.server.test.ts` ("F35-5: an @mention whose run did not start …") |
| G | CONFIRMED | `app/server/github/github-reconciler.server.ts` (drift block + wake predicate) | `github-reconciler.server.test.ts` ("ruling 132 …"), `pr-divergence-wake.server.test.ts` |
| H | CONFIRMED | `app/server/files/skill-body.server.ts` (new `assertSkillBodyWellFormed`), called from `saveSkill` + `writeStoreFiles` | `resources.server.test.ts` ("skills") |
| I | CONFIRMED | `app/server/github/branch-sync.server.ts` (`ensureTaskBranch`) | `branch-sync.server.test.ts` ("ensureTaskBranch", ruling-122 case) |
| J | CONFIRMED | `app/server/github/github-reconciler.server.ts` (collision notify + wake) | `github-reconciler.server.test.ts` ("reconcileTask"), `pr-divergence-wake.server.test.ts` |
| K | map | `codex-runtime.server.ts` (`resolveCodexSandboxMode` probe), `deployment.md`/`runbook.md` | — |
| L | map | `app/server/ops/toolchain.server.ts` (new) + `healthSnapshot` tail field | `health-snapshot.server.test.ts`, `controller-ops-mcp.server.test.ts` |
| M | CONFIRMED | `app/server/controller/controller-toolkit.server.ts` (`update_agent_deployment` resources params) | `controller-toolkit.server.test.ts` ("update_agent_deployment carries the record it read (B5)") |
| N | CONFIRMED | `app/server/runtimes/run-recovery.server.ts` (`finalizeOrphanedRuns`, `appendTimelineEvent`) | `run-recovery.server.test.ts` ("finalizeOrphanedRuns (F-RUN1)") |

---

## O. F36-5 — a SHIPPED task keeps being coordinated — CONFIRMED

**(1) The wake: trigger `agent-reply`, issued from the completion effects.**
`registerAgentCompletion` (`app/server/tasks/task-actions.server.ts:3510`) registers the
callback at :3569, which runs `applyAgentCompletionEffects` (:3664). Step 2 is the workspace
reconcile — `reconcileWorkspaceDelivery`, :4268-4291, gated only on `input.delivers &&
finished.state === "finished"`. Step 4 is the wake: `trigger: "agent-reply"` (:4408),
`await runOperator(db, reactInput)` (:4420). The dispatch-completion contract is `mustReact`
(:4356-4360) — `!!input.dispatchedByName && finished.state === "finished" && currentDepth <
OPERATOR_REACT_DEPTH_CAP` — which BYPASSES the new-progress heuristic (:4349-4355: "a
manually/schedule-dispatched run's completion ALWAYS hands back to the operator"). Neither
step reads stage, `accepted` or `archived`.

**(2) `runOperator` refusals** (`app/server/runtimes/operator-run.server.ts`). Trigger union
at :181-191, ten values: `create | transition | agent-reply | goal-updated | pr-diverged |
delivered | packet-resolved | dependencies-released | scheduled | manual`. Refusal union at
:283 — `"terminal-stage" | "open-packet" | "blocked-by"`:

- `terminal-stage` :1488-1514 — guarded by `if (input.trigger === "scheduled")` (:1488).
  CONFIRMED scoped to one trigger; the comment at :1478-1487 states the choice ("every other
  trigger on a terminal task is legitimate").
- `blocked-by` :1524-1549, keyed on `HELD_TRIGGERS` = `create/transition/scheduled` (:287).
- `open-packet` :1557-1573, keyed on `PACKET_REFUSED_TRIGGERS` = `manual/scheduled` (:290).

`agent-reply` passes all three doors. No `archived` read on any of them.

**(3) Packet authoring reads no stage.** `operatorOpenPacket` (`operator-actions.server.ts:1072`)
gates: capability (:1078), title (:1086), option count/kind (:1088-1103), task exists
(:1103-1106), ruling-161 `discard_branch` coherence (:1126-1137), `accept_completion` /
`move_stage` coherence (:1153-1252 — these read `fm.stage` only to compare it against the
OPTION's target). The string `archived` appears once in the whole module, in a comment at
:3494. The Codex plan executor's `open_packet` arm (`operator-run.server.ts:2553-2578`) checks
only `a.text`. CONFIRMED: neither door refuses a terminal or archived task.

**(4) Acceptance does nothing about live runs.** `acceptCompletion` (`task-actions.server.ts:10077`)
→ RBAC (:10082), disclosure (:10118), no-change probe (:10134), gates or
`forceIrreducibleRefusal` (:10152-10168), PR-head check (:10173); `forceAcceptCompletion`
(:10441-10545) adds the `task.acceptance.forced` audit (:10525-10540). Across :9860-10560 there
is no `interruptRun`, no `listRunsForTaskRows`, no live-run read. The only `interruptRun`
callers are `project-settings/settings-actions.server.ts:1070-1076`, `routes/project.task.tsx:867`
and `controller/controller-run.server.ts:678-684`. CONFIRMED: acceptance neither interrupts,
fences, nor notes a running agent.

**(5) The reconciler skips archived-or-MERGED, not terminal-stage.**
`github-reconciler.server.ts:1255-1266`: `terminal` = `archived = 1 OR
json_extract(pr_json,'$.state') = 'merged'`, over `WHERE project_slug = ? AND branch IS NOT
NULL`; the budgeted filter is :1285-1287. The `closed` state is excluded on purpose (:1279-1284
— a closed PR can be reopened). A force-accepted task with no merged PR and a deleted branch is
`terminal = 0` forever, so the 5-minute budgeted poll keeps visiting it. CONFIRMED.

**Root cause.** "Closed" has three separate spellings and no shared door: the schedule runner's
`mootNow` (`schedule.server.ts:451-475`), the specialist door's ARCHIVED-only gate
(`specialist-run.server.ts:1246-1250`, deliberately stage-blind per ruling 133,
`docs/architecture/decisions.md:2451`) and `runOperator`'s `scheduled`-only terminal branch.
Acceptance closes the task's front doors and leaves every in-flight side door open.

**Fix.** One `closedTaskRefusal(fm, stages)` beside the existing `archivedTaskBlockedReason` /
`archivedTaskMoveBlockedReason` (`app/schemas/task-file.schema.ts:1200`, :1219) over
`isTerminalStage` (`app/shared/workflow/stage-roles.ts:107`), read by every COORDINATION door:
`runOperator` (:1488 — widen past `scheduled` for the machine wakes, keeping `manual`/`pr-diverged`
so a human question and a PR recovery still work), the dispatch-completion wake (:4356-4420 —
skip the wake and `clearWaitingToHuman` instead), the plan executor (:2543) and `operatorOpenPacket`
(:1103). Ruling 133 pins the RUN door to `archived` only, so the guard must gate coordination,
never the deliverer's own re-run. Reconciler: add the terminal-stage disjunct at :1258-1260,
keeping the `closed`-PR carve-out. Acceptance: in `acceptCompletion` after the write (:10035)
read `listRunsForTaskRows` and either `interruptRun` each live run with one typed timeline note,
or let them finish with their coordination discarded by the same guard — the second is cheaper
and matches boot recovery's shape (see N).

**Test.** `operator-run.server.test.ts` → `describe("runOperator — authority, ordering,
orphans")` (:2623), which holds `it("F19-20: the guard is scoped to \`scheduled\` — a human
trigger on a Done task still drives")` (:3110) — the case that must split into human-still-drives
vs machine-wake-refused; refusal shape from `describe("ruling 131(d): a held task refuses the
coordinating triggers at no cost")` (:2822). Packet door: `operator-actions.server.test.ts` →
`describe("operatorOpenPacket (decision/blocking packet generator)")` (:2309). Acceptance:
`task-actions.server.test.ts` → `describe("U35-3: the force-accept record names every bypassed
gate")` (:4526). Reconciler: `github-reconciler.server.test.ts` → `describe("reconcileProject
fan-out control")` (:2526).

---

## P. F36-9 — the Claude skill mount writes `.claude/` into the task checkout — CONFIRMED

**Where the mount lands.** `mountGrantedSkills` (`app/server/runtimes/skill-mount.server.ts:288`)
takes `workspaceDir` and refuses anything that is not a plain git checkout (:299-305). Callers
pass the CLONE: `specialist-run.server.ts:1767` (`workspaceDir: clone?.dir ?? null`) and :3377
(`taskCloneDir(...)` on resume). Inside: `stripUngovernedRepoCatalog(dir)` (:311),
`excludeCatalogFromDelivery(dir)` (:312), then `skillsRoot = path.join(dir, ".claude", "skills")`
(:314). `mountOneSkill` (:561) copies the whole store folder to `<dir>/.claude/skills/<name>`
(:582-597), rewrites a normalized `SKILL.md` (:612-626) and drops `.viberr-mount` (:100-101,
written :630). `writeCatalogSettings` (:415) then writes `<dir>/.claude/settings.json` holding
`claudeMdExcludes` (:391-397) — and a failed write EMPTIES `mounted` (:339-343), so the file is a
precondition, not a decoration.

**Who writes the exclude.** `excludeCatalogFromDelivery` (:517-554) appends `.claude/` to
`<dir>/.git/info/exclude` (:527-536), idempotently. Its own comment (:540-552) already records
that this is git-only and that a failed write leaves the catalog deliverable. So the files are
invisible to `git status` and fully visible to anything that walks the tree — CONFIRMED. (The
`prettier --check .` failure is a property of the repo under review, not of viberr; viberr itself
ships no prettier config. What is verified here is that real files land inside the checkout.)

**Why cwd today.** `claude-runtime.server.ts` passes `cwd: spec.workdir` (:1272),
`settingSources: nativeSkills.length ? ["project"] : []` (:1320), `skills: nativeSkills` (:1321),
`plugins: []` (:1322). `nativeSkillsOutcome` (:502-510) re-checks `ensureCatalogSettings(spec.workdir)`
at start and drops every skill when the file is gone. `settingSources: 'project'` is `.claude/settings.json`
RELATIVE TO CWD by definition (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2075-2085`;
`SettingSource = 'user' | 'project' | 'local'`, :8273) — it cannot be pointed elsewhere.

**Does the SDK support skills outside cwd? Yes — via `plugins`.** Read from `sdk.d.ts`:
- `additionalDirectories?: string[]` (:1402-1406) — "Additional directories Claude can access
  beyond the current working directory." Access, not skill discovery. No `--add-dir` option name
  exists on `Options`; the flag appears only in the `register_repo_root` control request (:4274),
  which requires "a strict subdirectory of cwd, or of a directory passed at launch via --add-dir
  / the SDK additionalDirectories option" and carries `reload_skills?: boolean` (:4276-4283).
- `plugins?: SdkPluginConfig[]` (:1855-1874) — "Plugins provide custom commands, agents, skills,
  and hooks"; `SdkPluginConfig = { type: 'local'; path: string; skipMcpDiscovery?: boolean }`
  (:4883-4896), path "Absolute or relative path to the plugin directory". A plugin root is the
  directory holding `.claude-plugin/` with a `plugin.json` manifest (:6578, :4316).
- `skills?: string[] | 'all'` (:2089-2108) — names match "the SKILL.md `name` / directory name,
  or `plugin:skill` for plugin-qualified skills", so plugin-carried skills stay filterable by
  the same option viberr already uses. No `pluginRoot` option exists.

**Codex writes nothing.** `codex-runtime.server.ts:325-345` states the asymmetry; :372-385 severs
the CLI's skills channel (`skills.include_instructions: false`, `skills.bundled.enabled: false`)
and :371 sets `project_doc_max_bytes: 0`. The module contains zero `writeFileSync` / `mkdirSync` /
`cpSync` calls, and `mountGrantedSkills` is called only under `backend === "claude"`
(`specialist-run.server.ts:1766`, :3375). CONFIRMED.

**Fix.** Mount to a SIBLING of the checkout — e.g. `<task dir>/skills-mount/<runId>/` shaped as a
local plugin (`.claude-plugin/plugin.json` + `skills/<name>/SKILL.md`) — and pass
`plugins: [{ type: "local", path: <abs>, skipMcpDiscovery: true }]` at
`claude-runtime.server.ts:1322` (viberr's own `ClaudeOptions.plugins` already exists, :130-134),
with `skills: ["<plugin>:<name>", …]` (:1321) and `settingSources: []` kept (:1320). Nothing then
lands in the checkout, so `writeCatalogSettings` (:415), `CLAUDE_MD_EXCLUDES` (:391-395),
`ensureCatalogSettings` (:502-510) and `excludeCatalogFromDelivery` (:517) all retire together —
the CLAUDE.md ingress they exist to close is never opened. `stripUngovernedRepoCatalog` (:311)
STAYS: the repo's own `.claude` must still be removed. The plugin manifest shape is not in the
`.d.ts`, so canary it INSIDE the image before relying on it (macOS-CLI trap).

**Test.** `skill-mount.server.test.ts` → `describe("mountGrantedSkills")` (:449) — red: the
checkout contains no `.claude` after a successful mount; `describe("ensureCatalogSettings")`
(:328) and `describe("stripUngovernedRepoCatalog (R18-3 / F18-8)")` (:63) for what survives.

---

## Q. U36-4 — `save_knowledge_base` create reply hides the id; `disk:<dir>` re-entry is refused — CONFIRMED

**How `disk:` ids resolve.** `DISK_ID_PREFIX = "disk:"` (`app/server/org/resources.server.ts:80`),
`diskId` (:83), `diskNameFromId` (:86-92, which also refuses a traversing name). `buildKb`
(:208-226) sets `id: row ? row.id : diskId(dir)` (:215), so a folder WITH a metadata row reports
its real `kb_…` id and a disk-only folder reports `disk:<dir>`. `listKnowledgeBases` (:244-259)
unions rows and disk dirs and maps each through `buildKb`, so `list_knowledge_bases` returns the
row id when a row exists — the `disk:` shape only ever comes back for folders with no row.

**Why an existing row's dir falls into the create path.** `saveKnowledgeBase` (:313):
`existing = SELECT … WHERE id = ?` (:330-332) — a `disk:<dir>` id matches no row, so `existing`
is `undefined`. `oldDir = diskNameFromId(input.id)` = `<dir>` (:333-338). `renamedFrom` is
`oldDir && dir !== oldDir` (:360) — null when the name still slugifies to the same folder. With
`existing` falsy the `if (existing)` update arm (:385-406) is skipped and control reaches the
create arm, whose first act is `clash = SELECT id … WHERE dir = ?` (:406-408) followed by
`if (clash) throw AppError.conflict(...A knowledge-base folder ${dir}/ already exists.)` (:409).
CONFIRMED: the `disk:` id was designed to ADOPT a row-less folder (:326-327, `adopted` at
:417-420), and the adoption path has no branch for "this folder already has a row".

**What the create reply returns.** `saveKnowledgeBase` returns
`toast: oldDir ? "<name> updated" : "<name> created. Folder ready at store://kb/<dir>/"`
(:428-433) — the folder, never `kb.id`. `controller-toolkit.server.ts:514-560` renders exactly
`[done] ${saved.toast}.${docNote}` (:559), discarding `saved.kb.id` even though it holds it (it
uses `saved.kb.id` nine lines earlier for `resolveStoreTarget`, :550). CONFIRMED: the controller is
told the folder and must guess the id, and the only id shape it can construct by hand —
`disk:<dir>` — is the one shape the folder no longer answers to.

**Fix.** Two halves, both small:
1. `controller-toolkit.server.ts:559` — carry the id: `` [done] ${saved.toast} (id `${saved.kb.id}`). ``
   Same for the update arm, so a reply is always re-enterable. `list_knowledge_bases` (:500-508)
   already returns `id`, so the two surfaces then agree.
2. `resources.server.ts` — resolve a `disk:<dir>` whose folder HAS a row to that row: after
   `oldDir` (:338), when `!existing && oldDir`, re-read `SELECT … WHERE dir = ?` and, on a hit,
   treat it as `existing` (an update of the row that owns the folder) instead of falling into
   the create arm. The conflict at :409 then fires only for its real case — a DIFFERENT KB
   already holding the target folder name.

**Test.** `resources.server.test.ts` → `describe("knowledge bases")` (:270) — red: saving with
`id: "disk:<dir>"` on a folder that already has a row updates it instead of throwing; the create
toast/ id contract sits in the same block (:271-280). Controller surface:
`controller-toolkit.server.test.ts` → `describe("instance scope: org-role gate on every
management tool")` (:271) holds the `save_knowledge_base` arm, or a new sibling describe next to
`describe("update_agent_deployment carries the record it read (B5)")` (:1637), which is the same
"the reply carries what the next call needs" shape.

---

## Summary (addendum)

| Item | Verdict | Fix file (function) | Test file (describe) |
|---|---|---|---|
| O | CONFIRMED | `app/server/runtimes/operator-run.server.ts` (`runOperator` terminal guard) + `task-actions.server.ts` (`applyAgentCompletionEffects` wake, `acceptCompletion` live runs) + `github-reconciler.server.ts` (queue predicate) | `operator-run.server.test.ts` ("runOperator — authority, ordering, orphans"), `task-actions.server.test.ts` ("U35-3 …"), `github-reconciler.server.test.ts` ("reconcileProject fan-out control") |
| P | CONFIRMED | `app/server/runtimes/skill-mount.server.ts` (`mountGrantedSkills` → sibling plugin dir) + `claude-runtime.server.ts:1320-1322` (`plugins`, `settingSources: []`) | `skill-mount.server.test.ts` ("mountGrantedSkills", "ensureCatalogSettings") |
| Q | CONFIRMED | `app/server/controller/controller-toolkit.server.ts:559` (reply carries the id) + `app/server/org/resources.server.ts` (`saveKnowledgeBase` disk-id resolution) | `resources.server.test.ts` ("knowledge bases"), `controller-toolkit.server.test.ts` ("instance scope: org-role gate on every management tool") |
