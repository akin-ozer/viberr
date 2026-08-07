# Pass 19 — FINDINGS (authoritative backlog)

Every item gets a disposition before the pass closes: **FIXED** / **RULED** / **RETRACTED** /
**NOT-A-BUG** / **DEFERRED-BY-OWNER**. Sources: live use-case campaign (NOTES.md), the
3-dimension audit workflow with per-finding skeptic verification (wf_c98d2a52-7e3), and the
grounding specs (`ledger-specs-{1,2,3}.md`). Runbooks for the live campaign: `runbooks/`.

## Owner rulings this pass (binding)

| # | Ruling |
|---|--------|
| R19-1 | The operator gets a **FULL read-only clone** of the project repo before execution (triage/scoping). Packets must ground in the real repo; a summary-only view and a persona-only fix were both rejected. Closes Q19-1, extends F19-4. |
| R19-2 | **Repo-documented conventions outrank KB guidance on conflict**; KBs supplement. A stated precedence rule ships with every KB injection. Closes Q19-2. |
| R19-3 | Reviewer inheritance stays **KBs only** (R18-1 stands). Fix the docstring in `specialist-run.server.ts` that claims a skills widening which does not exist. Closes F19-2. |
| R19-4 | After a **supervised** delivery the server **guarantees an actionable next step** — `performDelivery` ensures a "Move to Review" recommendation (or equivalent packet) when the operator recorded none. Closes F19-1. |

## Severity summary

| Sev | Count | IDs |
|-----|-------|-----|
| HIGH | 8 | F19-3, F19-7, F19-8, F19-15, F19-18, F19-24, F19-25, F19-28 |
| MED | 15 | F19-2, F19-6, F19-9, F19-10, F19-11, F19-12, F19-16, F19-17, F19-19, F19-20, F19-22, F19-26, F19-27, F19-29, F19-31, F19-32, F19-33 |
| LOW | 9 | F19-5, F19-13, F19-14, F19-23, F19-30, F19-34, F19-35, F19-36, UX19-4 |
| UX/coherence | 4 | UX19-1, UX19-2, UX19-3, UX19-4 |
| Notes/docs | 6 | N19-1..N19-6 |

## The acceptance-writer matrix (the pass's headline)

Five distinct code paths end in "task Done + real GitHub merge". Ruling 20 (R15-1) says **every**
accept shows a confirm dialog; ruling 42 (R17-1) says the divergence between the reviewed revision
and the actual merge head **must be surfaced**. Current state:

| Path | Confirm dialog | Drift disclosed pre-act | Finding |
|------|----------------|--------------------------|---------|
| Task-page **Accept completion → Done** | ✅ full (PR, revision, merge head, "N commits added since review", verdict) | ✅ | — (verified live) |
| Task-page **Force accept** | ✅ | ✅ | F19-25 (no server-side terminal guard; skips the STAGE gate entirely — In Progress → Done + merge) |
| **Board** drag / Move menu into final stage | ✅ exists (R18-7) but discloses nothing | ❌ | F19-27 |
| Operator **recommendation → Apply** | ❌ none | ❌ | **F19-3** (live-proven: one click merged an unreviewed head) |
| Decision-packet **accept_completion** option | ❌ none | ❌ | **F19-7** |
| Side-panel **Complete merge** (mandatory half of every full-autonomy acceptance, R16-6) | ❌ none | ❌ | **F19-24** |

A sixth route exists: a supervised operator can recommend a plain **transition to the terminal
stage**, whose Apply runs the full acceptance + merge under a label that never says "accept" or
"merge" (**F19-26**). Consequence for the fix: **gate on the recommendation's TARGET, not its kind.**

## New findings from the audit workflow (skeptic-verified)

### F19-24 — HIGH · acceptance-gates · `app/features/task-detail/task-side-panels.tsx:226` · CONFIRMED

"Complete merge" performs the real, irreversible GitHub merge on a bare click: no confirm dialog, no disclosure of PR/merge-head/drift — the only acceptance-family writer with zero ceremony. task-detail-page.tsx:460 passes onCompleteMerge straight through while the adjacent onForceAccept (line 461-463) is wrapped in setConfirmAccept — the omission is visible in the same expression. task-detail-hooks.ts:117-125 submits intent "complete-merge" immediately; server (task-actions.server.ts:5331-5409) is the R16-6 "human merges later" half of EVERY full-autonomy operator acceptance, and its own comment (5365-5369) calls it "a Done writer too — it finishes the acceptance by performing the irreversible merge". The head gate accepts an AHEAD head (4883-4885), and neither the button, the path, nor mergeTaskPr's event (github-reconciler.server.ts:962) surfaces revisionDrift — so commits pushed after the operator accepted merge unreviewed with the divergence shown nowhere on this path. Distinct from F19-10 (which is about the affordance being hidden from the contributor-owner).

**Skeptic corrections:** Precisions, not refutations: (1) "the only acceptance-family writer with zero ceremony" is inaccurate — F19-3's recommendation-Apply also merges on a single unconfirmed click; this is the THIRD un-ceremonied acceptance writer and the only one not yet in the pass-19 ledger. (2) INTENT §4 does not contain the literal phrase "no bare click for one-way writes"; the actual §4 Feedback text is "toasts... must never be the sole record of a consequential event" / "No optimistic UI for governed state" — cite rulings 20/40/42/53 as the hard canon instead. (3) Tighten "no disclosure" slightly: the button has a hover title ("Run the real GitHub merge for this accepted PR") naming the action generically — still no PR number, merge target, drift, or confirm step. (4) The path is not gate-free server-side (RBAC via requireAcceptCompletion, pr.state==="accepted" check, head CONTAINMENT gate that still refuses a truly diverged head) — the defect is precisely the missing confirm dialog + missing AHEAD-drift disclosure, not an ungated merge. Anchor line 226 (onClick) is correct; the affordance block is 221-232. Severity HIGH is consistent with the sibling F19-7 (HIGH) and arguably stronger since this path is mandatory for every full-autonomy operator acceptance (R16-6) and merges post-acceptance drift shown nowhere.

### F19-25 — HIGH · acceptance-gates · `app/server/tasks/task-actions.server.ts:5274` · CONFIRMED

forceAcceptCompletion has NO server-side terminal-fact guard: it never consults acceptanceTerminallyBlocked, so it force-accepts a task whose PR is CLOSED unmerged — force:true skips acceptanceRefusalReason (closedPrBlockedReason) at 5145, skips the unmergeable refusal at 5220 (GitHub 405 on merging a closed PR → kind "unmergeable" → proceeds), and applyAcceptanceWrite stamps stage=done + pr.state "accepted" (5251/5254, skipInLockRecheck) — exactly the write ruling 37 names as the harm ("moves the task to Done over a rejection and stamps pr.state: accepted on a PR GitHub has already closed"). The withdrawal is client-only (task-detail-hooks.ts:135-137), and a pass-13 test (acceptance-closed-pr.server.test.ts:469-483, "the admin override still works") still PINS the pre-R16-3 behavior, so any future fix will be fought by the suite.

**Skeptic corrections:** Claim is accurate as filed (file/lines/severity all correct). One precision note: a closed-PR merge attempt may classify as "unmergeable" (405 → not_mergeable) or degrade to "pending" depending on mergeTaskPr's result — but both branches proceed under force and stamp pr.state "accepted", so the harm is identical either way.

### F19-26 — MED · acceptance-gates · `app/server/tasks/operator-actions.server.ts:1930` · CONFIRMED

A supervised operator calling transition_stage with the TERMINAL stage produces a plain "Move the task to Done" transition recommendation (recommend branch 1930-1944 has no terminal guard; only the direct branch is stopped by transitionStage's operator check at task-actions.server.ts:3092-3096, and the tool wiring at operator-run.server.ts:1473-1483 passes any toStageId). A human Apply on that card runs the FULL acceptance + real PR merge (applyRecommendation transition branch 5506-5533 → transitionStage 3073-3084 → acceptCompletion) with no confirm dialog AND a label/reason ("The work is ready to advance to Done") that never mentions accepting or merging. This is a third rec kind reaching acceptance that F19-3's fix (scoped to the accept_completion rec) will not cover — the fixer must gate on the rec's TARGET, not its kind.

**Skeptic corrections:** File/line anchors in the claim are accurate as stated (operator-actions.server.ts:1930-1944 recommend branch; task-actions.server.ts:3073-3084 human-terminal route into acceptCompletion, :3092-3096 operator-only guard, :5506-5533 apply transition branch; operator-run.server.ts:1473-1483 wiring; operator-actions.server.ts:977 snapshot comment). Severity MED is right — exploitation requires the supervised model to disregard the transition_stage tool description, but no server-side structure prevents it. One precision: the silent merge only occurs on a task already satisfying the acceptance gates (verdict + PR-head + healthy validation); otherwise Apply surfaces a refusal error — still dialog-less, but not a merge.

### F19-27 — MED · acceptance-gates · `app/features/board/board-page.tsx:543` · CONFIRMED

The board's acceptance confirm (AcceptOnBoardConfirm, 543-586) omits every ruling-42-required disclosure — no PR number, no actual merge head, no "N commits added since review" warning, no verdict — receiving only taskKey+stageName, on a card whose own TaskSummary ALREADY carries the full pr: PrRef including revisionDrift.headSha/aheadBy and validation (shared/mapping/task.server.ts:311/127; the card itself renders task.pr.state at 303 and ValidationPill at 331). The dialog's own rationale comment (540-541: "The board doesn't hold the PR/verdict detail") is factually wrong, so the pass-18 tradeoff rests on a false premise. Ruling 42 requires the drift warning on "the accept dialog" — board acceptance runs the identical full contract (R18-7), so a drifted PR accepted from the board merges with the divergence never shown pre-merge.

**Skeptic corrections:** File/line/severity accurate as claimed (board-page.tsx:543, MED). Minor precision: the board summary lacks workRevisionSha and defaultBranch (task-detail loader data), so the dialog could not replicate AcceptConfirm's "Revision" row or merge-target without loader changes — but all ruling-42 drift disclosures (PR number, revisionDrift.headSha, aheadBy, validation verdict) are already client-side. Also cite task.server.ts:311 as the `pr` field assignment in mapTaskProjectionRow (prChecks/prReview derive at 312-313).

### F19-28 — HIGH · rbac-capability · `app/server/auth/require-project.server.ts:41` · CONFIRMED

Six project-surface loaders (project.activity.tsx:40, project.review.tsx:28, project.agents.tsx:40, project.policy.tsx:29, project.github.tsx:33, project.settings.tsx:47) answer a signed-in non-member with requireProjectMember's 403 ('Only project members can view …') instead of the byte-identical unknown-slug 404, creating a project-existence oracle that ruling 25 forbids. The task-detail loader was already fixed for exactly this (project.task.tsx:97-108 documents that single-fetch honors a client-supplied ?_routes= filter, running a child loader ALONE so the layout's 404 chokepoint never executes, and concludes 'the gate has to live on every loader that serves project content'); the six config-surface siblings were not, and require-project.server.ts's docblock still justifies the 403 with the pre-R15-4 'board readable app-wide' FR4 reading. workspace-routes.server.test.ts:92 pins the 404 invariant only on the layout loader, so no test catches the child-loader path.

**Skeptic corrections:** Fix location is app/server/auth/require-project.server.ts:40 (the `throw data(error.userMessage, { status: error.status })` that propagates the 403), with the six call sites at app/routes/project.activity.tsx:40, project.review.tsx:28, project.agents.tsx:40, project.policy.tsx:29, project.github.tsx:33, project.settings.tsx:47. Severity HIGH confirmed. Two precision corrections to the claim's wording, neither of which weakens it: (a) The claim says the child-loader path leaks against a "byte-identical unknown-slug 404" reading "Project X not found." Two distinct 404 copies actually exist: the layout loader and `requireVisibleProject` emit `No project at projects/<slug>.`, while `assertProjectAction` (reached through `requireProjectMember`) emits `Project <slug> not found.` for a missing project.md. On the child-loader path an unknown slug therefore yields 404 "Project X not found." and a non-member yields 403 "Only project members can view the review queue." The load-bearing oracle is the 403-vs-404 STATUS difference plus the copy shape difference — not a mismatch against the layout's string. A correct fix must both convert to 404 AND unify the copy with `No project at projects/<slug>.`, or the child loaders will still be distinguishable from the layout/action paths. (b) The scope is wider than six routes. `requireProjectMember` also gates two resource routes that serve project content outside the layout entirely, so they were never covered by the chokepoint at all and leak the same 403: app/routes/resources.run-log.ts:69 ("view raw run logs") and app/routes/resources.session-export.ts:44 ("export the provider session"). Those take a run id and resolve `run.project_slug`, so the oracle there is per-run rather than per-slug, but the same 403-vs-404 divergence applies and any fix at require-project.server.ts:40 should be evaluated against them.

### F19-29 — MED · rbac-capability · `app/routes/_index.tsx:176` · CONFIRMED

Project creation is deliberately self-serve for ANY signed-in org member ('Org role is intentionally NOT consulted here', pinned by workspace-routes.server.test.ts:576), but canon FR5 (planning/planning-artifacts/prd.md:213) still reads 'Admin users can create and configure governed delivery projects' with no dated amendment, and decisions.md records no ruling — the decision exists only as a code comment and a test.

**Skeptic corrections:** Anchors are accurate (_index.tsx:176 comment, test :576, prd.md:213, INTENT.md §3 row line 97, ruling 44 at INTENT.md:310). One refinement: this is pass-18's unresolved open question QN-2 (GAP-ANALYSIS.md:102/:428) resurfacing, not a first discovery — which strengthens the finding (the divergence has now survived two passes with no canon record). MED severity is consistent with pass-18's own classification ("deviation, needs a ruling"). Cheapest close per pass-18: either amend FR5 with a dated clause recording self-serve creation + creator-seeded-admin, or gate creation — recorded in decisions.md per ruling 44.

### F19-30 — LOW · rbac-capability · `app/server/auth/project-authority.server.ts:188` · PLAUSIBLE

The org-admin override audit row is skipped for every '"any-member"' gate, justified in-comment as covering only config-surface route READs and 'a couple of idempotent no-op paths' plus the claim 'Every real governed mutation the override enables names a concrete RbacAction and IS audited' — but commenting is a real, visible mutation that is deliberately role-free (appendComment never calls requireAction; its only authority IS the any-member gate via requireVisibleProject), so an org-admin non-member writing a comment into a members-only project produces no project.org_admin.override row, contradicting the file's own D2 invariant ('EVERY such grant … leaves a row', lines 24-25).

### F19-31 — MED · ux-coherence · `app/features/review/review-page.tsx:84` · CONFIRMED

A review-stage row with waiting === "none" renders the pulsing "agent working" wait tag (and the subline "Agent working — the packet arrives at the boundary", review-helpers.ts:85) because the RQRow's wait-tag else-branch collapses "agent" and "none" — the board's WaitTag renders NOTHING for waiting "none" (board-page.tsx:147), so the same stored waiting value claims live agent work on one surface and silence on another.

**Skeptic corrections:** Anchor the finding at app/features/review/review-page.tsx:83-88 (the else-branch wait tag) — the subline at review-helpers.ts:85 is a narrower sub-case requiring no packet, no PR and no timeline event. Fixture cite is review-queue.server.test.ts:82-88 (assertions 122-126), not 80-87. Severity MED stands.

### F19-32 — MED · ux-coherence · `app/server/projections/review-queue.server.ts:132` · CONFIRMED

The review-queue row coerces pr.state "accepted" (merge pending, first-class since R16-6) into "review" via the catch-all `: ("review" as const)`, and ReviewRowView narrows the type to "review" | "merged" | "closed" (review-helpers.ts:12) — so prStatePill's amber "merge pending" branch is structurally unreachable on the queue even though review-page.tsx:63 calls the one canonical map.

**Skeptic corrections:** File/line/severity stand: review-queue.server.ts:132 (the catch-all `: ("review" as const)`), MED. Two refinements: (a) the failure scenario needs NO workflow re-wiring — a maintainer's manual stage-dropdown move or board drag out of Done (transitionStage manual:true) reaches the state directly, making it easier to hit than claimed; (b) the one-mapping canon violated is ruling 12 (prStatePill is the single PR-state→pill map), not ruling 1, which covers the readiness enum — ruling 40 remains the primary violation and is accurate as cited.

### F19-33 — MED · ux-coherence · `app/features/github/github-view.tsx:37` · CONFIRMED

Three files (github-view.tsx:37-41, policy-page.tsx:44, project-settings/settings-page.tsx:53-54) hoist inline-style constants — PANEL_COUNT_STYLE = { fontSize: ".76rem", color: "var(--faint)" } byte-duplicates the shared `.fine` utility (app.css:230) that seven other surfaces use as `className="right sub fine"` (review-page.tsx:169, agents-page.tsx:373, activity-page.tsx:149, notifications-page.tsx:57 …), and the two POL_NOTE_STYLE copies have already drifted (marginTop .8rem in settings vs .9rem in github-view).

**Skeptic corrections:** Minor count fix: the claim says "eight sites styled by these constants"; the actual count is 11 usages — PANEL_COUNT_STYLE at github-view.tsx:145,231, policy-page.tsx:90,264,393, settings-page.tsx:716,861 (7) plus POL_NOTE_STYLE at github-view.tsx:207,317 and settings-page.tsx:762,951 (4). Also the POL_NOTE drift is three-way, not two-way: .8rem (settings) vs .9rem (github-view) vs the sheet's own `.pol-note.after` at .85rem (app.css:3844), which github-view.tsx already uses at line 152. File/line anchors and MED/token-discipline severity are otherwise accurate.

### F19-34 — LOW · ux-coherence · `app/features/github/github-view.tsx:210` · PLAUSIBLE

The Pull-requests panel footer states "accepting a completion in the review queue merges its PR" — but the review queue is a read-only triage list that performs zero mutations (review-queue.server.ts:40, review-page.tsx header comment); acceptance lives on the task page with its evidence, which is the whole point of R15-11's "Review"-not-"Accept" row label.

### F19-35 — LOW · ux-coherence · `app/features/agents/create-profile-modal.tsx:535` · PLAUSIBLE

The collapsible capability-group and context-resource group header buttons (`cap-mghead`, lines 535-537 and 658-660) carry their expanded/collapsed state only via the `open` CSS class — the file contains zero aria-expanded, so a screen-reader user cannot tell whether activating the header revealed or hid the grant chips beneath it.

### F19-36 — LOW · ux-coherence · `app/features/task-detail/archive-confirm.tsx:85` · PLAUSIBLE

The archive confirm renders the raw internal PR state token — `PR #{task.pr.number} {task.pr.state}` prints "PR #12 accepted" or "PR #12 review" instead of the canonical prStatePill labels ("merge pending", "in review") — the identical defect F19-14 pinned at accept-confirm.tsx:81, at a second site the ledger does not name.

## Coverage gaps the critic flagged (no audit + no runbook)

| Gap | Area | Decision needed |
|-----|------|-----------------|
| G19-a | Responsive contract (no width-gated controls) + both-themes WCAG 2.2 AA | Build a check, or accept as asserted-not-verified |
| G19-b | D19 board keyboard traversal (arrow keys across lanes) | Ship or record as deliberate debt |
| G19-c | FR23 reach agent's native runtime session | Runbook + verify the export path works |
| G19-d | FR6 stage-editor mutation while tasks are in flight | Runbook (re-wire with live tasks) |
| G19-e | FR17/D18 continuity compaction + Recovery Panel | Still unshipped (pass-18 partial) |
| G19-f | FR33 90-day retention pass at boot | Verify it runs; F19-17 says a sibling doc claim is fictional |
| G19-g | NFR1–5 perf targets (D17) | Asserted, never measured — needs a harness or an explicit "won't measure" ruling |
| G19-h | Ruling 33 (resolved question resumes the ASKING agent via `askedBy`) | No runbook pins the resume |
| G19-i | FR5 canon drift: self-serve project creation vs "Admin users can create" | Needs a dated ruling-44 amendment (F19-29) |

## Live-observed additions (session 2)

### UX19-5 — MED · activity/audit noise · `app/features/activity/activity-page.tsx` (audit column)

The Audit logs column ("policy & access · all actors") is flooded by one repeating event:
8 of the 9 rows visible on a 1440px viewport read "operator opened the <role> runtime session —
recorded per audit policy on VC-4". Genuine policy/access events (credential assigned, scopes
re-checked, project created, role changes) are pushed below the fold by routine agent-session
bookkeeping. Violates the "calm over chatter / suppress noise" experience principle and defeats
the column's stated purpose. Options: (a) collapse consecutive runtime-session rows into one
"N runtime sessions opened" row (the compaction pattern already exists for timelines), (b) demote
runtime-session-open out of the policy & access column into the agent stream, (c) filter chip.
Needs an owner call on which — the event itself is required by audit policy, so it must not be
dropped, only re-homed or compacted.

### F19-23 — LIVE-CONFIRMED (was LOW, unverified)

"1 commit **were** added to the PR head (`a4c790ce63ef`) after the review" renders in BOTH the
task timeline and the Activity stream. Singular/plural is not switched in the completion event
text (task-actions.server.ts completion writer).

### UC-25 — PASS (live, this session)

The full revision-drift path ran end to end on VC-4: re-delivery opened PR #150, the Claude
Reviewer approved revision `81894e7`, an out-of-band commit `a4c790c` landed on the branch after
the verdict, and the human accept dialog disclosed the divergence before merging. Merge + branch
delete both recorded with the real merge head. **R17-1 works.** The only defect on the path is
F19-23's grammar.

## Session-2 owner rulings (binding)

| # | Ruling |
|---|--------|
| R19-5 | **Force-accept MAY skip remaining stages AND the review gate — but must say so.** The affordance is labeled honestly ("skips the remaining stages and the review gate") and its confirm dialog ENUMERATES the stages being skipped. The server does NOT refuse off-boundary (an implementer's 409 was reverted). The F19-25 closed-PR terminal guard stays: force-accept still refuses over a PR GitHub has closed unmerged. |
| R19-6 | **A capability set to `off` is a hard refuse by every route** — no recommendation card, no audit row. The operator refuses out loud (and narrates it) rather than silently rerouting. Closes the leak where `completion-for-acceptance: off` still produced an `accept_completion` card + `task.operator.recommended_completion` audit row via the terminal-transition reroute. |
| R19-7 | **The Activity audit column compacts consecutive runtime-session-open rows** into one expandable "N runtime sessions opened" row, reusing the existing timeline compaction pattern. The event stays recorded; it just stops burying credential/role/policy events. Closes UX19-5. |

### F19-37 — HIGH · acceptance · `app/features/task-detail/task-side-panels.tsx:448` · CONFIRMED (empirically, by cluster A's verifier)

**The SIXTH un-ceremonied acceptance writer, found inside the file the acceptance-ceremony fix
was landing in.** The Current-state panel's `StageMenu` submits `intent: "transition"` for ANY
stage with no confirm; the server treats a human transition into the last stage as acceptance —
`task-actions.server.ts:3070-3084` calls `acceptCompletion(...)` (the real merge) with the in-code
comment *"A HUMAN manually moving a task INTO the final stage IS accepting completion"*. The
BOARD's identical StageMenu was already wrapped by ruling 53/R18-7, so after wave 1 the task page
was the **only** surface left where moving a card to Done merges silently. Proven with a throwaway
test through the existing render harness (task at Review, admin → no accept dialog, `submitted[0]
=== {intent:"transition", to:"done"}`).

**Method note:** the acceptance-writer matrix in this file listed five writers; the sixth was found
only because the verifier probed a path the finding list did not name. A ledger is a floor, not a
ceiling.
