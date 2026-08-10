# Pass 19 — DISPOSITION (authoritative close-out ledger)

**Purpose.** Every pass-19 backlog item, re-derived **from the tree** rather than from any
implementer's report, with one verdict each. §2 ("Not actually done") is the section the owner
reads to decide whether the pass may close.

**Tree audited.** Worktree `/Users/akinozer/projects/viberr/.claude/worktrees/viberr-app-inspection-2d6bfc`,
branch `claude/viberr-app-inspection-4e5bf2`, HEAD `10c45f2`.
**Suite state at audit time: 227 files / 3217 tests, all green** (`npx vitest run`).

**Working-tree caveat (read before trusting the counts).** The audit ran against a tree carrying
uncommitted work from a concurrent coverage agent: 8 modified `*.test.ts` files and one **untracked**
new file `app/features/policy/project-authority-routes.server.test.ts`. Those additions are
*additive coverage only* — every pinning test cited in §1 for a pass-19 item was verified to exist
in the **committed** HEAD (`git show HEAD:<file>`), except the extra route-level oracle scan for
F19-28/F19-30, which is the untracked file and would be lost if the working tree were discarded.
An earlier auditor observed a live canary at `task-actions.server.ts:227-231` (`ownerException` with
`ownerUserId === actor.userId` deleted); **it has been restored** — the line is present and correct
in the current tree.

**Method.** Four independent auditors each re-derived one range. The `runtime-rbac` range
(F19-2, F19-6, F19-15, F19-16, F19-18, F19-19, F19-20, F19-28, F19-29, F19-30, F19-38, F19-39,
R19-2, R19-3, R19-6) **returned nothing**, so it was re-derived from the tree directly by this
synthesis before any verdict was written for it. No item is marked DONE on an auditor's word alone
where that auditor was the only reader.

**Verdict tally.** 43 F-findings + 5 UX + 8 rulings + 7 notes + 9 coverage gaps + 6 canon/doc items.
**DONE: 55. PARTIAL: 4. NOT-DONE: 4. Ruled/retracted/not-a-bug: 6.**

---

## 1. Full ledger — every item, by ID

Anchors are `file:line` in the audited tree. "Pins it" is the test that goes red if the fix is reverted.

| ID | Verdict | Evidence anchor | Pinning test |
|----|---------|-----------------|--------------|
| **F19-1** | DONE | `app/server/tasks/operator-actions.server.ts:1834` `ensureDeliveredNextStep`, called `task-actions.server.ts:3686` under `operatorAuthorized === true` | `delivery-requeue.server.test.ts:192` (+ E–I at :268–380) — drives real `performDelivery`, asserts `fm.recommendations[0]` |
| **F19-2** | DONE (via R19-3) | `specialist-run.server.ts:273-280` — docstring corrected; the "widened to SKILLS by LV-F3" claim removed, absence documented | `specialist-run.server.test.ts:1892` "SKILLS are NOT inherited" + `:2611` native-channel pair (canary note refreshed in the working tree) |
| **F19-3** | DONE | `task-detail-page.tsx:427` `recReachesAcceptance(rec, terminalStageId)` → `setConfirmAccept({mode:"apply-recommendation"})`; submit lifted to `:412` | `task-disposition.test.tsx:396` — `submitted` empty on click, then confirmed click posts `apply-recommendation` |
| **F19-4** | DONE (via R19-1) | `operator-run.server.ts:768` `ensureOperatorRepoCheckout`; prompt block `:2215`; wired `:1057` | `operator-run.server.test.ts:2174` clones a **real** git origin, asserts `README.md`/`docs/guide.md` on disk; `:2277` failed-clone arm; `:2303` no-repo arm |
| **F19-5** | DONE | `create-profile-modal.tsx:703` `aria-pressed` on every resource grant chip (incl. the `missing` ghost chip); propagated to `agent-template-modal.tsx:75,324,348,372` | `agents-page.test.tsx:938` — asserts `true`/`false` present, pins the dangling-grant case |
| **F19-6** | DONE | New credential-safe channel `app/server/tasks/git-stderr-redact.server.ts`; consumed `specialist-run.server.ts:1880,2102,2193`, `operator-run.server.ts:824` (scrub-by-value, token never in argv/URL) | `git-stderr-redact.server.test.ts` (whole file) + the clone-failure arms in `specialist-run.server.test.ts` |
| **F19-7** | DONE | `task-detail-page.tsx:391` — `option?.kind === "accept_completion"` → `setConfirmAccept({mode:"packet"})` | `task-disposition.test.tsx:487` + negative at `:510` (every other option kind stays one-click). Fixture uses the **production** key `t` (`task-file.schema.ts:380`) |
| **F19-8** | DONE (UI half; server half = F19-38) | `board-page.tsx:177` StateSignals returns null when archived; `:367` ArchivedPill; `:332` drag disabled; `:409` StageMenu suppressed | `board-page.test.tsx:660` "an archived card is inert and honest" — 6 cases incl. list view + a live-card control |
| **F19-9** | DONE | `app/routes/project.tsx:126` `liveTasks = tasks.filter((t) => !isArchived(t))` feeding `taskCount` (:133) / `reviewCount` (:140) | `project.server.test.ts:84` — real loader + rebuild, badge parity with `getReviewQueue().total`; `:134` keeps ruling-16 "Done still counts" |
| **F19-10** | DONE | `task-detail-hooks.ts:140` `const canMerge = acceptanceHasAuthority` (was `roleCan(...)`); server returns `{...denied, hasAuthority}` past the terminal early return, `task-actions.server.ts:5168` | `task-disposition.test.tsx:613` (contributor-owner gets it, still confirms) + `delivery-decision.server.test.ts:855` |
| **F19-11** | DONE | `execution-profile.tsx:810` "Unowned — a contributor or above can take it"; third instance fixed at `task-actions.server.ts:2845` | `execution-profile.test.tsx:82` — and `:83` binds the copy to `rolesForAction("own-task")`, not a fixture |
| **F19-12** | **PARTIAL** | Only the rec label + tool message landed: `operator-actions.server.ts:1288` `Engage ${name} as the delivering agent` | `operator-actions.server.test.ts:306` — scoped to *this* writer only. **Three rendered surfaces still say "primary specialist" and three tests pin them old — see §2.1** |
| **F19-13** | DONE | `board-page.tsx:591` `<StateSignals task={t} />` inside `ListView` | `board-page.test.tsx:601` — merge-pending, closed, failing checks, changes-requested, **and** the silences in both views |
| **F19-14** | DONE | `accept-confirm.tsx:168` `prPill = prStatePill(pr.state)`, rendered `:217-219` | `task-disposition.test.tsx:381` — `toContain("merge pending")` / `not.toContain("PR #147 · accepted")` (negative includes the ` · ` separator) |
| **F19-15** | DONE | `specialist-run.server.ts:894` mount takes a **lease** on the shared per-task `.claude` catalog; `:1750` same lease on the resume path; `:1902` lease module; `:2132` no re-strip while a live run holds it; `:2026` honest degradation to prompt injection | `specialist-run.server.test.ts:2193` "a second run never unmounts a live run's skills" (+ the module-state leak guard at `:140`) |
| **F19-16** | DONE | `capability-matrix-modal.tsx:203-215` — the Claude-native vs Codex-clipped asymmetry disclosed in prose, numbers sourced from `SKILL_INJECTION_BUDGET` | `agents-page.test.tsx:689` (F19-16 / ruling 51 case) |
| **F19-17** | DONE (doc) | `docs/operations/runbook.md:92-97` — corrected to better-auth's singular `session` table, dated "*Corrected 2026-08-06, pass 19*" | `migration-runner.server.test.ts:68` `expect(tables).not.toContain("sessions")` |
| **F19-18** | DONE | `push-workspace.server.ts:95` redacted `stderrExcerpt` on `push_failed`; `:391` hoisted so the outer catch scrubs too; `:626` residual bucket; `:671` "unexpected error" arm; consumed `task-actions.server.ts:3433`/`:3862` | `push-workspace.server.test.ts:428,465,489` (names git's reason / PAT never leaks / silent push says so) + `task-actions.server.test.ts:1397` |
| **F19-19** | DONE | `github-reconciler.server.ts:157` per-task reconcile serializer (`:201` prevents re-announcing a divergence, `:721` keyed by data root) | `github-reconciler.server.test.ts:479` "two OVERLAPPING passes announce the divergence once, and notify once" |
| **F19-20** | DONE | `schedule.server.ts:352` mootness decided from the **canonical file under the lock** (not the projection), `:410` row/retirement can never disagree, `:446` refused-at-fire-time state; `operator-run.server.ts:891` FR39 guard | `schedule.server.test.ts:386,431` + `operator-run.server.test.ts:1698,1713,1726` (incl. the queued-behind-a-live-drive re-check) |
| **F19-21** | DONE | `task-actions.server.ts:3506` `verifiedNoChange` gated on `push.defaultBranchEvidence?.verified === true`; `:3566` mints `fm.workRevision = baseRevision`; dialog copy `accept-confirm.tsx:236` | `task-actions.server.test.ts:1468` — 11 cases incl. 6 negative-evidence cases (dirty tree / local commits / abandoned branch / unknown history / missing evidence) + `accept-confirm.test.tsx:76` |
| **F19-22** | DONE | `github-view.tsx:488` `Checked X · last change Y`; `task-side-panels.tsx:208-237` two rows; loaders wire `latestTaskReconcileCheckAt` (`project.task.tsx:276`) and `reconcileCheckView` (`project.github.tsx:51`) | `audit-query.server.test.ts:122` drives the **real reconciler** twice against a quiet repo (12:00 vs 12:42) + `task-detail-components.test.tsx:1224` (rows addressed by label) |
| **F19-23** | DONE | `task-actions.server.ts:5212` `${n === 1 ? "1 commit was" : \`${n} commits were\`}` | `task-actions.server.test.ts:1771` — singular, plural, and the no-drift empty-string case |
| **F19-24** | DONE | `task-detail-page.tsx:607` — `GithubTrace` receives `() => setConfirmAccept({mode:"complete-merge"})`, not the submitter; button `task-side-panels.tsx:314` | `task-disposition.test.tsx:348` — `submitted` empty on click; dialog names PR #147, `main`, merge head `cccccccccccc`, "2 commits added since review" |
| **F19-25** | DONE | `task-actions.server.ts:4942` `forceIrreducibleRefusal`, called `:5271` (in-lock), `:5347` (force branch), `:5503` (`forceAcceptCompletion`) | `acceptance-closed-pr.server.test.ts:468` — the pass-13 "admin override still works" test was **inverted**, not left: refuses, no Done, no `accepted` stamp, **no** `task.acceptance.forced` row |
| **F19-26** | DONE (both arms) | Server `operator-actions.server.ts:2014` reroutes a terminal-target `recommend` into `operatorAcceptCompletion`; client `task-detail-page.tsx:79-89` gates on **target**, not kind | `operator-actions.server.test.ts:927` (card is `accept_completion`, no "ready to advance") + `task-disposition.test.tsx:429` |
| **F19-27** | DONE | `board-page.tsx:746-789` — Merges (`prStatePill`), Merge head (`drift.headSha`/`aheadBy`), Verdict (`ValidationPill`), Blocked (precedence chain); new projection `shared/mapping/task.server.ts:357 atAcceptanceBoundary` | `board-page.test.tsx:756,833,925` — 20 cases incl. server precedence order and singular/plural |
| **F19-28** | DONE | `require-project.server.ts:16` — the child-loader 403 collapsed into the **unknown-slug 404 with unified copy**; all six loaders annotated (`project.activity.tsx:36`, `.settings:47`, `.github:39`, `.review:24`, `.agents:40`, `.policy:29`); the two resource routes the skeptic added are covered too | `agents-route.server.test.ts:128`; `run-artifact-routes.server.test.ts:90,120,181` (body must not name the project); `workspace-routes.server.test.ts:128`. Plus an **untracked** structural oracle scan at `project-authority-routes.server.test.ts:326` |
| **F19-29** | DONE (canon) | `planning/planning-artifacts/prd.md:213` FR5 amended, dated, ruling-44 style: self-serve creation + creator-seeded-admin | `workspace-routes.server.test.ts:647` — drives the real action as a non-admin org member |
| **F19-30** | DONE | `project-authority.server.ts:184` — the `"any-member"` gate is **rate-collapsed, not exempt**; D2 invariant restored (`:27`, `:94`, `:164`) | `project-authority.server.test.ts:193` (committed) + `policy-rbac.server.test.ts:1413` + the untracked `project-authority-routes.server.test.ts:161` comment-path case |
| **F19-31** | DONE | `review-page.tsx:90-95` — `t.waiting === "agent" ? … : null`; subline `review-helpers.ts:106` "At the review boundary — no agent is running…" | `review-page.test.tsx:165` — `.wait-tag` is null, exact subline, row keeps its "Review" action |
| **F19-32** | DONE | `review-queue.server.ts:143` `state: t.pr.state` (catch-all `: ("review" as const)` gone); consumed `review-page.tsx:69-76`, `review-helpers.ts:59` | `review-queue.server.test.ts:571` (pass-through, no new coercion) + `review-page.test.tsx:190` (amber "PR #420 · merge pending") |
| **F19-33** | DONE | All three hoisted style consts gone — `github-view.tsx:37-44`, `policy-page.tsx:44-50`, `settings-page.tsx:53-61` now use `className="right sub fine"` / `"pol-note after last"` | `app.css.test.ts:1162` "hoisting is not an escape hatch" — scans **hoisted** `style={NAME}` sites (`hoistedStyleSites()`, :955) and self-checks its scanner at `:1169`; render assertions in `github-view.test.tsx:467,537`, `policy-page.test.tsx:352`, `settings-page.test.tsx:533` |
| **F19-34** | DONE | `github-view.tsx:216-221` — "accepting a completion **on its task page** merges its PR…" | `github-view.test.tsx:454` — verbatim new sentence AND `not.toContain("review queue")` |
| **F19-35** | DONE | `create-profile-modal.tsx:543,668` — `aria-expanded={open}` on both `cap-mghead` headers | `agents-page.test.tsx:984` — universal quantifier over **every** `.cap-mghead`, agreement with the `open` class before and after toggling |
| **F19-36** | DONE (weakly pinned) | `archive-confirm.tsx:85-92` `PR #{n} · {prPill.label}` | `task-disposition.test.tsx:852`. **Flag:** the negative asserts `not.toContain("PR #147 accepted")` while the render separator is ` · `, so only the positive `toContain("merge pending")` truly binds |
| **F19-37** | DONE | `task-detail-page.tsx:463-476` — a stage move to the terminal stage opens `mode:"stage-move"`; wired to the Current-state `StageMenu` at `:628` → `task-side-panels.tsx:542` | `task-disposition.test.tsx:521` ("Moving to Done accepts this completion", `submitted` empty, confirmed click posts `transition`/`to:done`) + `:555` (any other stage still one-click) |
| **F19-38** | DONE | `task-actions.server.ts:2952` (`transitionStage`) and `:4032` (`reorderTask`) refuse an archived task — the whole reorder, not just the cross-stage half; rationale `:2887` | `acceptance-graph.server.test.ts:719` "an archived task cannot be moved on the board" |
| **F19-39** | DONE (and hardened twice) | `copy-ban.test.ts` widened from a **call-shape** scan to a **literal** scan over every pure-TS root, plus `app/schemas/**`, `app/ui/**`, and a self-coverage check that fails when a new top-level dir/TSX escapes both halves; symptom string fixed at `task-actions.server.ts:2987` | `copy-ban.test.ts` (whole file) + `operator-actions.server.test.ts:1029` |
| **F19-40** | DONE | `activity-page.tsx:182-183` — end-anchored `/\bopened the .+ runtime session — recorded per audit policy on$/` | `activity-page.test.tsx:430` — derives `AUDIT_ACTION_KINDS` from the **projection source file** and replays 3 hostile display names through every audit template; `:481` end-to-end |
| **F19-41** | DONE | `activity-feed.server.ts:280` `…force-accepted the completion, overriding the acceptance gate (${reason})`, `reason = bypassed.split(" — ")[0]` (:279) | `activity-feed.server.test.ts:244` — fixture at `:259` is now byte-identical to the production sentence (`task-actions.server.ts:4857`); `:285` asserts the remediation clause is dropped |
| **F19-42** | DONE (rule pinned, consumer not) | `app/app.css:246` `.btn.full { white-space: normal; text-align: center; line-height: 1.25 }`; consumer `task-side-panels.tsx:124` `className="btn ghost sm full"` | `app.css.test.ts:1138`. **Canaried** by a mutated-sheet run: stripping `white-space: normal` fails the assertion. **Flag:** nothing asserts the force-accept button still carries `full` |
| **F19-43** | DONE | Committed `10c45f2`; one `B-WF2` comment block remains at `task-actions.server.ts:4631` (was duplicated verbatim) | none (comment dedup; none warranted) |
| **G19-a** | **STILL OPEN (partial)** | Contrast pinned for named pairs only: `app.css.test.ts:429,441,482,502,231,768`; breakpoints `:802-859`; touch reachability `:861-895` | those tests — no systematic AA sweep, no "no width-gated controls" contract, **no decision recorded either way** |
| **G19-b** | **STILL OPEN (accepted as debt, unruled)** | `board-page.tsx` — the file's only `onKeyDown` is `:907` (Enter in the new-task dialog); no Arrow handling | none. Recorded as D19 in `INTENT.md:379` |
| **G19-c** | **PARTIAL** | Affordance reachable `runs-panels.tsx:308` → `/resources/session-export?run=…`; server `session-export.server.ts` | `run-artifact-routes.server.test.ts:114,128`; `session-export.server.test.ts`. **No runbook; never exercised live** |
| **G19-d** | **PARTIAL** | Server guard real, not client-only: `settings-actions.server.ts:470-487` re-counts `task_projections`, throws `Move N tasks out of X first`; chain re-join `:494` | `settings-actions.server.test.ts:170,193,228,256`. **No runbook; never re-wired live** |
| **G19-e** | **STILL OPEN** | `grep -rn "Recovery Panel\|RecoveryPanel" app/` → **zero hits**. Only pass-18's partial: warning-toned typed event + `timeline-compaction.server.ts` | `run-service.server.test.ts:757-760` (the partial only). `INTENT.md:376` records D18 as unshipped |
| **G19-f** | CLOSED (verified, unpinned at the call site) | `retention.server.ts:22` `AUDIT_RETENTION_DAYS = 90`; called `boot.server.ts:286` `applyRetention(db)` in a try/catch — matches `prd.md:257` | `retention.server.test.ts:16` (behaviour). **Flag: nothing asserts *boot* calls it** — deleting `boot.server.ts:286` breaks no test |
| **G19-g** | **STILL OPEN, no decision** | No harness anywhere; `decisions.md` has no measurement ruling | none. `INTENT.md:374` D17 still reads "asserted, not verified" |
| **G19-h** | **PARTIAL** | Shipped: `task-actions.server.ts:4663-4676` routes to `answerAskingAgent` before the operator fallback | `agent-reply.server.test.ts:1020-1046` (explicit canary); `operator-actions.server.test.ts:1961`; `agent-toolkit.server.test.ts:125`. **The gap asked for a runbook — still absent** |
| **G19-i** | CLOSED | FR5 amendment, `prd.md:213` | `workspace-routes.server.test.ts:647` |
| **N19-1** | NOT-A-BUG (downgraded) | Repo field still free text `new-project-modal.tsx:230-239`; post-hoc honesty real: `repo-access-check.server.ts:64` → `github-pills.ts:128` | `github-pills.test.ts:53`; `pat-validator.server.test.ts:160`. CAMPAIGN UC-02 downgraded it to a nice-to-have |
| **N19-2** | DONE (doc) | `ux-design-specification.md:385-387` — corrected to Manrope, dated | `app.css.test.ts:260` (`--font-display` declared once, matches `/Manrope/`); fact at `app.css:64` |
| **N19-3** | DONE (doc) | `docs/architecture/file-formats.md:193-196,215` — nine packet-option kinds incl. `archive_task` | none for the doc; source of truth `PACKET_OPTION_KINDS` (`task-file.schema.ts:68`) has exactly 9. **Link unpinned — see §2.4** |
| **N19-4** | DONE (doc) | `ux-design-specification.md:354-357` — card 18→16, panel 28→22, `--radius-large`/`--pink`/`--dark-red` marked "not ported" | `app.css.test.ts:111` (every `var(--x)` resolves, no allowlist); `app.css:77-79` |
| **N19-5** | **NOT-DONE (both halves)** | Gate live at `settings-page.tsx:1611` `{canEditPolicy && (<DangerZone …`; PAT half absent | **none that binds** — `settings-page.test.tsx:849-892` renders `<DangerZone>` directly; the only full-page render (`:933`) is `myRole="admin"`. Deleting `canEditPolicy &&` fails nothing. See §2.2 |
| **N19-6** | RETRACTED | `NOTES.md:63` — third-party GitHub close (12:00:35Z) refuted the stale-reconcile-loop hypothesis; recorded as a method class in `FINDINGS.md:190` | n/a |
| **N19-7** | NOT-A-BUG | `vite.config.ts` carries no `server.fs.allow` change | n/a — worktree-only dev artifact, correctly left alone |
| **R19-1** (ruling 55) | RULED + implemented | `decisions.md:484`; `operator-run.server.ts:733,768` | F19-4's suite. **Nit: the ruling text cites `operatorWorkspaceView`, an identifier that does not exist** (`ensureOperatorRepoCheckout` / `OperatorWorkspaceView` do) |
| **R19-2** (ruling 56) | RULED + implemented | `kb-injection.server.ts:343` `KB_PRECEDENCE_NOTE` — one constant, pushed once, **before** bodies, gated on `kbSet.parts.length > 0` at `specialist-run.server.ts:1320` and `operator-run.server.ts:2322` | `operator-kb-injection.server.test.ts:70`; `specialist-run.server.test.ts:1903` |
| **R19-3** (ruling 57) | RULED + implemented | `specialist-run.server.ts:273-275` — corrected docstring; inheritance stays KB-only | `specialist-run.server.test.ts:1892` + `:2611` (pins the **absence**, as ruled) |
| **R19-4** (ruling 58) | RULED + implemented | see F19-1 | see F19-1 — "(or equivalent packet)" is honoured as the open-packet skip |
| **R19-5** (ruling 59) | RULED + implemented | `decisions.md:559`. Server deliberately does **not** refuse off-boundary (`task-actions.server.ts:5500-5507`); honesty carried by `task-side-panels.tsx:135` label + `accept-confirm.tsx:294-308` "Skips" row | `acceptance-graph.server.test.ts:330` (admin can still force-accept off-boundary, audit names Triage) + `task-disposition.test.tsx:662` |
| **R19-6** (ruling 60) | RULED + implemented | `operator-actions.server.ts:2172` — "FIRST, before any read, card or audit row"; an `off` capability is a hard refuse on every route | `operator-actions.server.test.ts:993` |
| **R19-7** (ruling 61) | RULED + implemented | `activity-page.tsx:205` `compactAuditEntries()` (pure, order-preserving, `AUDIT_COMPACT_MIN = 2`), `:301` `CompactedSessions` with `aria-expanded`, wired `:382-384` | `activity-page.test.tsx:379` — recognizer read from the projection source; `:585` live 8-row flood → 3 rows; `:609` expansion restores all rows |
| **R19-8** (ruling 62) | RULED + implemented | `decisions.md:596`. No-change keeps the ceremony: `verdictGateReason` bypasses **only** in the no-PR arm (`task-actions.server.ts:4846-4851`); required-reviewer gate runs first (`:4888`). Evidence source `push-workspace.server.ts:74-94,465,592` | `task-actions.server.test.ts:1795` (both directions of the `!fm.pr` guard) + the "still refuses while the required reviewer has not approved" case |
| **UX19-1** | DONE | `task-side-panels.tsx:424-428` — "…plus **the authority that comes with owning this task**"; ruling id kept only in code comments (`:355`, `:419`) | `task-detail-components.test.tsx:1361` — asserts the new phrase and `not.toMatch(/\bR\d{1,2}-\d+\b/)` across all four project roles |
| **UX19-2** | DONE | `task-side-panels.tsx:105` reads `acceptance.blockedReason` (was `task.blockReason`); `:113` `skipsStages = !acceptance.atBoundary` drives the honest label at `:135` | `task-detail-components.test.tsx:1016,1051`; `task-disposition.test.tsx:238` asserts both panels quote the identical sentence |
| **UX19-3** | DONE (see §5 adjudication) | `review-queue.server.ts:199-210` `gateBlockedByKey` (open blocked packet OR `conflictingPrBlockedReason`) consumed by `isReady` `:217-222`; the deeper mechanisms also closed — `rebuilder.server.ts:419` one derivation feeds both the `validation` column and the gate; `specialist-run.server.ts:545,627` recompute on roster change | `review-queue.server.test.ts:631`; `rebuilder.server.test.ts:467`; `decisions.server.test.ts:408`; `specialist-run.server.test.ts:665` |
| **UX19-4** | DONE | `decision-packet.tsx:331-343` — body note naming `DELIVER_LABEL` (:39), gated on `canResolve && branchDiscardOffered` (:168) | `task-detail-components.test.tsx:1633` — renders `GithubTrace` beside the packet and asserts the panel really renders a button whose text is exactly `DELIVER_LABEL`; plus silence + no-authority cases |
| **UX19-5** | RULED → DONE via R19-7 | see R19-7 | see R19-7 |
| **FR5 amendment** | DONE | `prd.md:213`, dated `*(Amended 2026-08-06, pass 19 — F19-29, promoted under ruling 44…)*` | `workspace-routes.server.test.ts:647`. Behaviour binds; the prose does not. No numbered `decisions.md` entry (FRs live in the PRD) — worth an owner nod |
| **prd byte-sync** | DONE | Both copies `md5 801d613445e9699c1760177568025c59` | `app/shared/docs/prd-sync.test.ts:29` — byte-identical assertion with per-line divergence report |
| **decisions.md 55–62** | DONE | `:484` (55) … `:596` (62); numbering scan contiguous `1..62`, no gaps, no duplicates | n/a (canon doc); each ruling's code re-derived in the R19-* rows above |
| **runbook session sweep** | DONE | see F19-17 | `migration-runner.server.test.ts:68` |
| **file-formats "nine kinds"** | DONE (unpinned) | see N19-3 | — |
| **ux-spec typeface + radius** | DONE | see N19-2 / N19-4 | `app.css.test.ts:260` / `:111` |

---

## 2. Not actually done

**This section is not empty.** Four items are PARTIAL and four are NOT-DONE or STILL-OPEN with no
decision. Most severe first. Nothing here is a shipped fix that silently fails; the severity is
"a claimed close that the tree does not support".

### 2.1 F19-12 — PARTIAL (MED) · retired "primary specialist" vocabulary still rendered
The fix landed only at the anchor the ledger named (`operator-actions.server.ts:1288`). The
finding's own text names *"rec labels, @-mention picker, timeline events"* — two of those three are
untouched, and **three tests actively pin the old strings**, so the next fixer will be fought by the
suite. Re-derived by grep: 22 non-test occurrences of "primary specialist" remain under `app/`.
Remaining work, exactly:
- `app/server/tasks/mention-suggestions.server.ts:64` — `{ handle: "agent", label: "Primary specialist" }`, rendered as the picker subline via `mention-autocomplete.ts:56`. Un-pin `mention-composer.test.tsx:42`, `mention-autocomplete.test.ts:27`, `mention-suggestions.server.test.ts:106`.
- `app/server/tasks/specialist-run.server.ts:402` — deploy **timeline event**: `` `Deployed **${name}** (…) as the primary specialist.` ``. Un-pin `specialist-run.server.test.ts:246`.
- `app/shared/capabilities.ts:35` — `cap("assign-primary-specialist", "Assign the primary specialist", …)`; the **label** is rendered on the agents page, the capability-matrix modal and the policy page. Un-pin `agents-page.test.tsx:656`, `agents-route.server.test.ts:164`. (The capability **id** may stay — it is not rendered — but the id/label split must be deliberate, not accidental.)
- `app/server/tasks/agent-reply.server.ts:215` — agent reply copy: *"or @agent for this task's primary specialist"*.

### 2.2 N19-5 — NOT-DONE, both halves (owner-ruled behaviour is revertible in silence)
The Q-V1 danger-zone render gate is live at `settings-page.tsx:1611` but has **no test that can
fail**. Verified directly: `settings-page.test.tsx` renders `<DangerZone>` as a component at
`:849-892` (bypassing the gate entirely), and the only full-page render, `:933`, hardcodes
`myRole="admin"`. Deleting `canEditPolicy &&` keeps the suite green. This is trap #1 — a test that
cannot fail — sitting on an owner ruling.
Remaining work: (a) render `<SettingsPage myRole="viewer" …>` (and one non-lifecycle member role)
and assert the "Danger zone" heading is **absent**, with a canary run proving it goes red when the
gate is removed; (b) the Q-V1 **PAT half** is still unimplemented and its next step is recorded only
in a pass-19 reference doc — it needs either implementation or an owner deferral recorded in
`decisions.md`.

### 2.3 G19-g — STILL OPEN with no decision (the only gap that demanded an explicit owner call)
NFR1–5 have no harness and no "won't measure" ruling. The gap's own table row offered two branches
and neither was taken; `INTENT.md:374` (D17) still reads "asserted, not verified". It will resurface
verbatim next pass. Remaining work: one line in `decisions.md` either way.

### 2.4 Four "done" items whose pin does not reach the thing that would break
These are DONE in code and would survive a normal review, but the guard is thinner than it reads.
Each is a one-line fix.
- **F19-42** — `app.css.test.ts:1138` binds the `.btn.full` *rule* (canaried: mutating the sheet fails it) but **nothing asserts the force-accept button carries `full`**. Changing `task-side-panels.tsx:124`'s className re-opens the exact live defect with every test green.
- **F19-36** — `task-disposition.test.tsx:867` asserts `not.toContain("PR #147 accepted")` while the component renders `PR #147 · accepted`; a regression to the raw token slips that assertion. Only the positive `toContain("merge pending")` binds.
- **G19-f** — `boot.server.ts:286` `applyRetention(db)` is untested; `boot.server.test.ts` never mentions retention. The gap was closed by a read, not a gate.
- **N19-3** — `file-formats.md`'s "nine" is not pinned against `PACKET_OPTION_KINDS` (`task-file.schema.ts:68`). That absence is exactly how the count went stale the first time.

### 2.5 G19-c / G19-d / G19-h — PARTIAL (code-complete, never exercised live)
All three are implemented and unit-covered with real server guards; all three lack the **runbook**
their gap row asked for, so none has been run against a live app this pass. Remaining work is a
runbook + one live execution each: FR23 native-session export, FR6 stage edit with tasks in flight,
ruling-33 `askedBy` resume.

### 2.6 G19-a — PARTIAL (verification covers named cases only)
Contrast is pinned for enumerated pairs and breakpoint discipline for enumerated patterns; there is
no systematic both-theme AA sweep and no general "no width-gated controls" contract check. Neither
branch of the gap's own choice ("build a check, or accept as asserted-not-verified") was recorded.

### 2.7 G19-b / G19-e — STILL OPEN, documented as debt but never ruled
- **G19-b** — board arrow-key traversal does not exist (`board-page.tsx`'s only `onKeyDown` is the new-task dialog's Enter). Recorded as D19 in `INTENT.md:379`; no ruling converts "unshipped" into "deliberate".
- **G19-e** — D18's Recovery Panel does not exist in the tree at all (zero grep hits). Only pass-18's `continuity` typed event and `timeline-compaction.server.ts` partial. `INTENT.md:376` is honest about this.

### 2.8 Live re-entry hazard: the pre-fix F19-3 path is still in the tree
`app/features/task-detail/task-main-sections.tsx:253-293` exports `RecommendationsSection`, which
submits `intent: "apply-recommendation"` with **no ceremony** (`:271`) — the exact code F19-3 fixed.
`git show 5a277d7` removed its render and its import but left the component. Repo-wide importers:
**zero**, so it is not a live defect and is not counted as PARTIAL. It is one import away from
reintroducing a HIGH, and no test covers it. Recommend deletion before the pass closes.

---

## 3. Deliberately not done

| Item | Disposition | Reason |
|------|-------------|--------|
| **N19-1** (free-text repo field) | NOT-A-BUG / downgraded | The connection knows its repos, but post-hoc honesty already exists (`repo-access-check.server.ts:64` → `github-pills.ts:128`). CAMPAIGN UC-02 downgraded "fail fast at creation" to a nice-to-have. No code landed — correct per that disposition. |
| **N19-6** (reconcile write-loop) | RETRACTED | GitHub's own event log refuted it (`closed 11:10Z · reopened 11:27Z · closed 12:00:35Z` — a third-party close 80s before the reconcile that reported it). The app was correct on every tick. Kept as a method class: read the external system's event log before filing a state-machine bug. |
| **N19-7** (font 403s) | NOT-A-BUG | Worktree-only dev artifact — `node_modules` resolves outside the worktree root, so Vite's `server.fs.allow` refuses. Main and the container are unaffected. Recorded so a future pass does not re-file it. |
| **R19-5** — server does not refuse off-boundary force-accept | RULED | The owner ruled honesty over refusal: force-accept **may** skip stages and the review gate provided it says so. An implementer's 409 was reverted deliberately; the "Skips" row enumerates the stages. Only the F19-25 closed-PR terminal guard is a hard refusal. |
| **R19-3** — reviewer does not inherit deliverer skills | RULED | R18-1 stands: inheritance is KBs only. The "widened to SKILLS by LV-F3" docstring described a widening that never shipped. The test now pins the **absence** — do not "restore" it. |
| **R19-8** — no-change acceptance keeps the verdict gate | RULED | Ruling 43's "reviewer verdict optional" clause is **superseded**. `verdictGateReason` bypasses only in the no-PR arm; the required-reviewer gate still runs first. |
| **UX19-3's live-instant claim** | Partially retracted (see §5) | The exact screenshotted instant was over-determined and is not the target; the structural class was confirmed and fixed. |

---

## 4. Coverage gaps still open

| Gap | Status | What remains |
|-----|--------|--------------|
| **G19-a** responsive + both-theme WCAG 2.2 AA | **still open (partial)** | Named-pair contrast + breakpoint/touch checks exist; no systematic sweep, no "no width-gated controls" contract, **no decision recorded** either way |
| **G19-b** board keyboard traversal (D19) | **still open** — documented as debt (`INTENT.md:379`), **never ruled** | Ship arrow-key traversal, or convert D19 into a numbered ruling |
| **G19-c** FR23 native runtime session | **partial** | Code + RBAC covered; write the runbook and exercise the export once live |
| **G19-d** FR6 stage edit in flight | **partial** | Server guard real and unit-pinned; no runbook, never re-wired with live tasks |
| **G19-e** FR17/D18 continuity + Recovery Panel | **still open** | Panel does not exist (zero grep hits); only pass-18's typed `continuity` event |
| **G19-f** FR33 retention at boot | **covered, with a thin pin** | Behaviour tested; add an assertion that **boot** calls `applyRetention` (`boot.server.ts:286` is currently deletable in silence) |
| **G19-g** NFR1–5 perf (D17) | **still open, no decision** | Harness **or** an explicit "won't measure" ruling. Neither exists. Highest-priority gap for the owner |
| **G19-h** ruling 33 `askedBy` resume | **partial** | Unit-covered with an explicit canary; the gap asked for a **runbook** — still absent |
| **G19-i** FR5 canon drift | **covered** | Dated ruling-44-style amendment in canon **and** mirror; behaviour pinned |
| *(added)* **acceptance-writer matrix in FINDINGS.md** | **still open (doc)** | `FINDINGS.md:33-44` still prints ❌ for four writers under "Current state". The shipped state lives only in the commit message and `decisions.md`. A future pass reading the matrix would re-file fixed work |
| *(added)* **F19-33 residual loophole** | **accepted as debt** | The gate bans a hoisted object that *restates a whole utility rule*; a one-off hoisted literal still passes (`decision-packet.tsx:31 REDELIVER_NOTE_STYLE`, added by the UX19-4 fix) |
| *(added)* **`app.css.test.ts:1127-1137` docblock/describe mismatch** | **accepted as debt** | An F19-33 docblock sits directly above `describe("…(F19-42)")` — same class as the F19-43 duplicate-comment defect: a reader cannot tell which comment is authoritative |
| *(added)* **ruling 55 citation nit** | **still open (doc)** | `decisions.md:484` names `operatorWorkspaceView`; no such identifier exists (`ensureOperatorRepoCheckout` / `OperatorWorkspaceView` do) |
| *(added)* **board dialog cannot name a no-change disposition** | **accepted as debt (self-declared)** | `board-page.tsx:632-638`: `noChanges` is task-file frontmatter and `mapTaskProjectionRow` never projects it, so a verify-only task accepted from the board falls into the "No linked pull request" branch and never names R19-8's outcome |

---

## 5. Method note

**What this audit caught that the implementers' own reports did not.**

1. **A range with no auditor is a range with no verdict.** The `runtime-rbac` auditor returned
   nothing. Fifteen items (F19-2, -6, -15, -16, -18, -19, -20, -28, -29, -30, -38, -39 and rulings
   R19-2/3/6) would have been carried into the close-out on the implementers' say-so. They were
   re-derived here from the tree and all are genuinely DONE — but that outcome was not knowable
   before the re-derivation, and a silent range must never be scored as a clean one.
2. **"Done" and "pinned" are different verdicts.** Four items (§2.4) are correct in code while their
   test binds something adjacent: a CSS rule but not the className that uses it; a positive
   assertion carrying a negative that cannot fire; a behaviour but not the boot call site; a doc
   count with no link to its schema. An implementer's report says "test added"; only a re-derivation
   asks *what does the test go red on*. F19-42's gate was canaried by mutating `app.css` — the rule
   binds, the consumer does not.
3. **A test that cannot fail reads exactly like one that can.** N19-5 has two danger-zone tests and
   an owner ruling, and the gate is still deletable in silence, because both tests render the
   component rather than the page that gates it.
4. **The fix can leave its own predecessor in the tree.** F19-3's pre-fix path still exists as an
   exported, unimported, untested component (§2.8). The commit removed the *call*, not the *code*.
5. **A backlog document can outlive its own truth.** `FINDINGS.md`'s acceptance-writer matrix still
   shows four ❌ that shipped. The shipped state is recorded only in a commit message.

**Auditor disagreements, adjudicated by reading the tree.**

- **UX19-3 — "retracted" vs "shipped".** The cross-session memory note records UX19-3 as
  *retracted* ("my two screenshots were different instants"); this tree's `FINDINGS.md:246` records
  it as live-verified fixed, and the ui-coherence auditor flagged the contradiction rather than
  resolving it. **Adjudication: both are right about different claims, and the item is DONE.**
  `ledger-specs-3.md:178-181` states the disposition explicitly: *"CONFIRMED as a structural class;
  the exact live instant is over-determined"*, and its closing parenthetical says the same-instant
  screenshot pair "is not fixable and not the target". What was retracted is the *screenshot as
  evidence*; what was confirmed and fixed is a three-mechanism class — a stale `fm.validation` cache
  vs a fresh derivation (`rebuilder.server.ts:419` now feeds both from one derivation),
  `assignReviewer`/`removeReviewer` skipping the recompute (`specialist-run.server.ts:545,627`), and
  the queue's `isReady` under-checking the server gate (`review-queue.server.ts:199-222`). All three
  have their own pinning tests (`rebuilder.server.test.ts:467`, `specialist-run.server.test.ts:665`,
  `review-queue.server.test.ts:631`, `decisions.server.test.ts:408`). It is a real gate-parity
  tightening, and it reverses no `INTENT.md` §6 deliberate divergence.
- **Live canary at `task-actions.server.ts:227-231`.** The rulings auditor saw `ownerException` with
  `ownerUserId === actor.userId` deleted mid-audit and asked that it be confirmed restored.
  **Verified: restored** — the guard is present in the current tree and the full suite is green.
- **No other item drew conflicting verdicts.** Where auditors overlapped (F19-25/R19-5, F19-26/R19-6,
  F19-29/FR5, F19-8/F19-38) they agreed, and the tree agrees with them.

**Bottom line for the close decision.** No shipped fix in this pass is broken, unreachable, or
faked, and the suite is green at 3217 tests. But the pass cannot be recorded as *complete*: F19-12
is one third done with the suite defending the other two thirds, N19-5 is an owner ruling with no
enforceable guard, and G19-g is a gap whose own row demanded a decision that was never made.
