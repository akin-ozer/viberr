# MERGED-DISPOSITION — pass 19 (merged tree)

**CLOSED — every finding is FIXED / RULED / NOT-A-BUG / RETRACTED; 0 OPEN. Two caveats only: one fix is unpinned (R19-A schedule-time autonomy clamp), one is comment-only (F19-43); three code-complete gaps (G19-c/-d/-h) lack a *live runbook* but not product or unit coverage.**

- **Tree:** HEAD `846a4f4` (`claude/viberr-app-inspection-4e5bf2`), 20+ commits past the stale `DISPOSITION.md` (`10c45f2`). That earlier ledger is **superseded** for every range below.
- **Method:** five auditors re-derived every finding from the merged tree — code read, pinning tests run green (1000+ tests across the relevant files). This file records the merged-tree truth; where a ruling/DISPOSITION citation was stale (module renamed/relocated/deleted in the merge) the entry cites the *real* identifier on the tree.
- **Rule applied:** a stale-doc claim is not evidence. Every FIXED/RULED row below is backed by merged-tree code **and** a test that was run green, except the two explicitly called out in §3.

---

## 1. Master disposition table (every finding id)

### Acceptance-disclosure family (the six-writer headline)

| id | disposition | evidence (file:line + pinning test) |
|----|-------------|--------------------------------------|
| **F19-3** | FIXED | `task-detail-page.tsx:428-436` `recReachesAcceptance`→`setConfirmAccept({mode:"apply-recommendation"})`. Pin: `task-disposition.test.tsx:453` (canary: submit straight from onApplyRec). |
| **F19-7** | FIXED | `task-detail-page.tsx:392-405` packet `kind==="accept_completion"`→`mode:"packet"`. Pin: `task-disposition.test.tsx:543` + describe `:1040-1135`. |
| **F19-10** | FIXED | `task-detail-hooks.ts:140` `canMerge = acceptanceHasAuthority` (server-authorized owner). Pin: `task-disposition.test.tsx:647`. |
| **F19-24** | FIXED | `task-detail-page.tsx:639-641` GithubTrace `onCompleteMerge`→`mode:"complete-merge"`. Pin: `task-disposition.test.tsx:405` (canary). |
| **F19-25** | FIXED | Server terminal guard `task-actions.server.ts:5194` `forceIrreducibleRefusal` (closed-PR), all force paths. Pin: `acceptance-closed-pr.server.test.ts:481` (pass-13 test **inverted** to assert refusal). |
| **F19-26** | FIXED (both arms) | Server reroute `operator-actions.server.ts:2352-2376`; client gates on **target** `task-detail-page.tsx:80-90`. Pins: `operator-actions.server.test.ts:1074` + `task-disposition.test.tsx:486`. |
| **F19-37** | FIXED (sixth writer) | `task-detail-page.tsx:467-480` move-to-terminal→`mode:"stage-move"`, wired StageMenu `task-side-panels.tsx:544`. Pin: `task-disposition.test.tsx:578` + negative `:612`. (= Session-B's original **F19-22**, Stage-dropdown→terminal.) |
| **UX19-2** | FIXED | GithubTrace consumes `acceptance` not `task.blockReason` (`task-side-panels.tsx:43-46,105`). Pin: `task-disposition.test.tsx:257` (both panels quote one server sentence). |
| **UX19-3** | FIXED | `review-queue.server.ts:217-239` `gateBlockedByKey`; `rebuilder.server.ts:435` one derivation feeds column + gate. Pins: `review-queue.server.test.ts:634` + `rebuilder.server.test.ts:555`. |

### No-change completion

| id | disposition | evidence |
|----|-------------|----------|
| **F19-21** | FIXED | `no-change-completion.server.ts` module + gate `task-actions.server.ts:3576` `verifiedNoChange = push.defaultBranchEvidence?.verified===true`. Pins: `task-actions.server.test.ts:1509` + `no-change-acceptance.server.test.ts:573` (fail-closed arms). |
| **F19-27** (board pills) | FIXED | `shared/mapping/task.server.ts:139,357` `atAcceptanceBoundary`; `board-page.tsx:781-887`. Pin: `board-page.test.tsx:843,920,1012` (20 cases, server precedence). |
| **F19-27** (deriveValidation `none`) | FIXED | `task-file.schema.ts:579` `if (fm.noChanges && required.length===0) return "none"` (last; approve/request_changes still win). Pin: `task-file.schema.test.ts:103`. |

### Runtime / RBAC / secrets

| id | disposition | evidence |
|----|-------------|----------|
| **F19-2** | FIXED (via R19-3) | Docstring corrected `specialist-run.server.ts:288-291` ("SKILLS ARE DELIBERATELY NOT INHERITED"); KB-only union `:292`. Pins: `specialist-run.server.test.ts:1954,2501` + source-scan canary `skill-mount.server.test.ts:236-237`. |
| **F19-6** | FIXED | Redacted git output on both clone paths (`specialist-run.server.ts:2297/2333/2406`, `operator-run.server.ts:828-830`, `git-clone-auth.server.ts:267`). Pins: `git-output-redact.server.test.ts` + `operator-run.server.test.ts:2285`. |
| **F19-15** | FIXED | Per-process `MOUNT_MARK` surgical strip `skill-mount.server.ts:95-198` (a 2nd run never unmounts a live run's skills; forged marks stripped). Pins: `skill-mount.server.test.ts:103,172,535`; `specialist-run.server.test.ts:2193`. |
| **F19-16** | FIXED | `capability-matrix-modal.tsx:203-217` discloses Claude-native vs Codex-clipped, numbers from `SKILL_INJECTION_BUDGET`. Pin: `agents-page.test.tsx:705` ("24,000-character budget" + "clipped"). |
| **F19-18** | FIXED | `push-workspace.server.ts:662,696` redact git stderr. Pins: `push-workspace.server.test.ts:434,471` (+ canary `:479`). |
| **F19-19** | FIXED | `github-reconciler.server.ts:164` `withTaskReconcileLock` per-task serializer. Pins: `github-reconciler.server.test.ts:481,683,722`. |
| **F19-20** | FIXED | `schedule.server.ts:334,367,420,456` mootness from canonical file under the claim lock. Pins: `schedule.server.test.ts:386,431,535,556`. |
| **F19-28** | FIXED | `require-project.server.ts:33-89` collapses child-loader 403 into byte-identical unknown-slug 404. Pins: `agents-route.server.test.ts:128` + oracle scan `project-authority-routes.server.test.ts` (untracked — see §5). |
| **F19-29** | FIXED (canon) | FR5 amended in **both** `prd.md:213` copies (self-serve creation, creator-seeded-admin). Pin: `workspace-routes.server.test.ts:648`. |
| **F19-30** | FIXED | `project-authority.server.ts:184-226` — org-admin "any-member" override now audited (rate-collapsed, not exempt). Pins: `project-authority.server.test.ts:193` + `policy-rbac.server.test.ts:1413`. |

### UI coherence / a11y / copy

| id | disposition | evidence |
|----|-------------|----------|
| **F19-5** | FIXED | `create-profile-modal.tsx:802` `aria-pressed` on grant chips. Pin: `agents-page.test.tsx:954`. |
| **F19-8** | FIXED (client) | `board-page.tsx:216-225` archived card inert; drag/StageMenu suppressed. Pins: `board-page.test.tsx:667,769`. Server half = **F19-38**. |
| **F19-9** | FIXED | `project.tsx:131` `liveTasks` filters archived from counts. Pin: `project.server.test.ts` badge-parity. |
| **F19-11** | FIXED | `execution-profile.tsx:999` "Unowned — any contributor or above…"; 3rd site `task-actions.server.ts:2934`. Pin: `execution-profile.test.tsx:85` (bound to `rolesForAction`). |
| **F19-12** | FIXED | Zero non-comment "primary specialist" in rendered copy (`mention-suggestions.server.ts:69`, `specialist-run.server.ts:669`, `capabilities.ts:51`, `agent-reply.server.ts:216` → "delivering agent"). Capability *id* `assign-primary-specialist` kept deliberately (`capabilities.ts:44`). Pins: `copy-ban.test.ts:943`, `retired-vocabulary.test.tsx:53`, `agents-page.test.tsx:672`, `agents-route.server.test.ts:168,183`. |
| **F19-13** | FIXED | ListView renders shared `StateSignals`. Pin: `board-page.test.tsx:608`. |
| **F19-14** | FIXED | `accept-confirm.tsx:178,228` `prStatePill(pr.state)` → `PR #{n} · {label}`. Pins: `task-disposition.test.tsx:180,438`. |
| **F19-22** (GitHub freshness) | FIXED | `github-view.tsx:534` `Checked ${x} · ${changeLabel}`, two-row split. Pins: `github-view.test.tsx:941` + `audit-query.server.test.ts`. |
| **F19-31** | FIXED | `review-page.tsx:123` agent-vs-human wait tag; subline `review-helpers.ts:112`. Pin: `review-page.test.tsx:95`. |
| **F19-32** | FIXED | `review-queue.server.ts:157` `state: t.pr.state` (coercion gone). Pin: `review-page.test.tsx:195` (`toBe("PR #420 · merge pending")`). |
| **F19-33** | FIXED | Hoisted style consts removed; scanner gate `app.css.test.ts:1190` `hoistedStyleSites()`. (Debt: one-off `REDELIVER_NOTE_STYLE` `decision-packet.tsx:32` — a single-property hoist the gate deliberately ignores; not a regression.) |
| **F19-34** | FIXED | `github-view.tsx:553` "accepting a completion **on its task page** merges…". Pin: `github-view.test.tsx` (+ `not.toContain("review queue")`). |
| **F19-35** | FIXED | `create-profile-modal.tsx:589,757` `aria-expanded` on both `cap-mghead`. Pin: `agents-page.test.tsx:1000` (universal quantifier). |
| **F19-36** | FIXED | `archive-confirm.tsx:39,91` `prStatePill`. Pin: `task-disposition.test.tsx:909` (`toBe("PR #147 · merge pending")` — exact). |
| **F19-38** | FIXED (server half of F19-8) | `task-actions.server.ts:4241` refuses the WHOLE reorder of an archived card. Pin: `acceptance-graph.server.test.ts:775`. |
| **F19-39** | FIXED | Copy-ban extended to the second human-read surface (`AppError` message `task-actions.server.ts:3052`). Pins: `copy-ban.test.ts:781` + `operator-actions.server.test.ts:1176`. |
| **F19-40** | FIXED (spoof-guard) | End-anchored recognizer `activity-page.tsx:129/183` (`…recorded per audit policy on$`). Pins: `activity-page.test.tsx:404/435/445-450` (hostile display names). |
| **F19-41** | FIXED | Force-accept audit copy `activity-feed.server.ts`. Pin: `activity-feed.server.test.ts` (commit `ad6086a`). |
| **F19-42** | FIXED | `app.css:246` `.btn.full { white-space: normal }`; consumer `task-side-panels.tsx:129`. Dual-pinned: `app.css.test.ts:1159` + `task-disposition.test.tsx:338→373`. |
| **F19-43** | FIXED (comment-only) | Duplicated verbatim comment removed; the two remaining `B-WF2` lines are distinct. **No test** — see §3. |
| **F19-23** (Session-B) | FIXED | `.obs` label overlap → `app.css:1092` `minmax(92px, max-content) 1fr`. Pin: `app.css.test.ts:1102` (canary restores `92px 1fr`). |

### UX-coherence cluster (the 24 defects) + client UX findings

| id | disposition | evidence |
|----|-------------|----------|
| **UX #1** notif "completion report" fall-through | FIXED | `notification-meta.ts:71-84` → `{kind:"input",label:"decision required"}`. Pin: `notifications-page.test.tsx:191-204` (canary; no completion checkmark). |
| **UX19-9** (UX #10 archive_task branch-delete) | FIXED | `decision-packet.tsx:103-259` names branch, "cannot be undone", "Not yet". Pin: `task-disposition.test.tsx:1213` (canary `:1282`) + `task-detail-components.test.tsx:1563`. |
| **UXV19-1** (UX #2 review-queue label) | FIXED | `review-page.tsx:40` `capabilityById("completion-for-acceptance")?.label`. Pin: `review-page.test.tsx:347` (canary). |
| **remaining 21 of the 24** | FIXED (spot-verified) | operator-recommendations.tsx:53-58; runs-helpers.ts:61; execution-profile.tsx:59-104/126/143; command-search.server.ts:66; project.tsx:155; new-project-modal.tsx:171; notifications-page.tsx:208; users-panel.tsx:317 (`role="alert"`); settings-page.tsx:63; create-profile-modal.tsx:136/267/589. All committed. |
| **UX19-1** | FIXED | `task-side-panels.tsx:431` "…authority that comes with owning this task"; ruling ids in comments only. Pin: `task-detail-components.test.tsx:1386` (+ `not.toMatch(/\bR\d{1,2}-\d+\b/)`). |
| **UX19-4** | FIXED | `decision-packet.tsx:40` `DELIVER_LABEL`, gated `canResolve && branchDiscardOffered` (`:519`). Pin: `task-detail-components.test.tsx:1637`. |
| **UX19-5 / R19-7** | FIXED (RULED, ruling 61) | `activity-page.tsx:205` `compactAuditEntries` + `:301` `CompactedSessions` (`aria-expanded`). Pins: `activity-page.test.tsx:327` (flood→3-row + expansion). |
| **UX19-6** | FIXED | `viberr-app-expertise.skill.md:3` reworded ("governed" gone); allowlist entry removed so `copy-ban.test.ts` now HOLDS the description (commit `b1f08a5`). |

### Rulings (decisions.md 55–68 + R19-13/ruling 69)

| id | disposition | evidence |
|----|-------------|----------|
| **R19-1** (dec. 55) | RULED + implemented | `operator-run.server.ts:718-851` `ensureOperatorRepoCheckout`, wired `:1075`. Pins: `operator-run.server.test.ts:2041,2182` (+ failed-clone/no-repo arms). *(Ruling text's `operatorWorkspaceView` is a doc nit.)* |
| **R19-2** (dec. 56) | RULED + implemented | `kb-injection.server.ts:343` `KB_PRECEDENCE_NOTE`, gated on non-empty KB (`specialist-run.server.ts:1638`, `operator-run.server.ts:2354`). Pins: `specialist-run.server.test.ts:1558,1833,2007`; `operator-kb-injection.server.test.ts:56,83`. |
| **R19-3** (dec. 57) | RULED + implemented | KB-only inheritance (= F19-2). `specialist-run.server.ts:288-291`. Pins as F19-2. |
| **R19-4** (dec. 58) | RULED + implemented | Folded into `recordDeliveredNextStep` `task-actions.server.ts:4000`, called `:3766` only under `operatorAuthorized===true` + supervised; full-autonomy re-queue unchanged (`:3747`). Pins: `delivery-requeue.server.test.ts:192,268`. *(Ruling's `ensureDeliveredNextStep` was deleted in the merge.)* |
| **R19-5** (dec. 59, ruling 59) | RULED + implemented | Off-boundary force honesty via `task-side-panels.tsx:118-142` + `accept-confirm.tsx:163-172,306-326` (enumerates skipped stages). Pin: `task-disposition.test.tsx:719` (7 cases). |
| **R19-6** (dec. 60) | RULED + implemented | `operator-actions.server.ts:2495` `completionCapabilityRefusal` checked FIRST (`:2534`), before card/audit. Pins: `operator-actions.server.test.ts:1117,1365`. |
| **R19-7** (dec. 61) | RULED + implemented | = UX19-5 above. |
| **R19-8** (dec. 62) | RULED + implemented | No-change keeps the verdict gate (only no-PR arm bypasses `verdictGateReason`). Pins: `task-actions.server.test.ts:1628,1665`; full `no-change-acceptance.server.test.ts:285-573`. |
| **R19-9** (dec. 63) | RULED | `prd.md:266` Responsiveness amended — NFR1–4 numeric targets struck, NFR5 kept; `design/prd.md` byte-synced. Pin: `prd-sync.test.ts`. (Owner call G19-g demanded, recorded.) |
| **R19-10** (dec. 64) | RULED + BUILT | D18 `continuity-recovery.tsx` wired `task-detail-page.tsx:518`; D19 board roving tab stop `board-page.tsx:1748`. Pins: `continuity-recovery.test.tsx` + `board-page.test.tsx:1209`. |
| **R19-11** (dec. 65) | RULED + implemented | Viewer PAT gate: render `github-view.tsx:79` `canSeeCredential`; loader redaction `project.github.tsx:63-65`. Pins: `github-view.test.tsx:425,789` + `github-route.server.test.ts:604`. |
| **R19-12** (dec. 66) | RULED + implemented | Systematic AA contrast sweep `app.css.test.ts:1765` (>400 pairs, both themes) + width contract `:2199` (`hiddenControls()` vs JSX). Both canaried. |
| **R19-A** (dec. 67) | RULED + implemented | Per-run autonomy is a **ceiling**: `operator-actions.server.ts:214/236/321` `clampAutonomy`/`auditAutonomyClamp`/`operatorAutonomyFor`. Pins: `operator-actions.server.test.ts:186,304`. **Schedule-time call site unpinned — see §3.** |
| **R19-B** (dec. 68) | RULED + implemented | Member's GitHub PR approval counts as the approving verdict: `pr-human-approval.server.ts` (re-binds to current `workRevision`, fails closed). Rendered `accept-confirm.tsx:296-304`, `task-side-panels.tsx:701`. Pin: `pr-human-approval.server.test.ts:113,316`. |
| **R19-13** (dec. 69) | RULED + implemented | ONE `git-output-redact.server.ts` `redactGitOutput` at every choke (specialist/operator run, push-workspace, update-branch, git-clone-auth). Pin: whole `git-output-redact.server.test.ts` (8 canaried cases). *(Merge consolidated B's `git-stderr-redact`; commit `040f669`.)* |

### Gap-hunt (G19-x)

| id | disposition | evidence |
|----|-------------|----------|
| **G19-a** | RULED (R19-12) + BUILT | Contrast + width gates executable & green in `app.css.test.ts:1765/2199/2333`. |
| **G19-b** | RULED (R19-10) + BUILT | Board roving tab stop + arrow traversal `board-page.tsx:154-176,388-440`; `board-page.test.tsx:1201+`; e2e fixed `7886492`. |
| **G19-c** | FIXED (code+test) | `session-export.server.ts` + `resources.session-export.ts`; `session-export.server.test.ts` + `run-artifact-routes.server.test.ts:114,128`. **Live FR23 runbook not written — see §4.** |
| **G19-d** | FIXED (code+test) | In-flight guard `settings-actions.server.ts` (re-counts `task_projections`, throws). Pin: `settings-actions.server.test.ts`. **Live runbook not written — see §4.** |
| **G19-e** | RULED (R19-10) + BUILT | `continuity-recovery.tsx` (16 KB) wired `task-detail-page.tsx:518`; `continuity-recovery.test.tsx`. |
| **G19-f** | FIXED | Retention `ops/maintenance.server.ts:124`→`applyRetention` (`retention.server.ts:66`), boot call `boot.server.ts:122` now pinned `boot.server.test.ts:187`. |
| **G19-g** | RULED (R19-9) | = R19-9 PRD responsiveness amendment. |
| **G19-h** | FIXED (code+test) | `answerAskingAgent` `task-actions.server.ts:526`, routed before operator fallback `:4901` on `packet.askedBy`. Pin: `agent-reply.server.test.ts:1026` (canary `:1052`). **ruling-33 resume live-exercise not written — see §4.** |

### Notes (N19-x) + misc

| id | disposition | evidence |
|----|-------------|----------|
| **F19-17** | FIXED (doc) | `docs/operations/runbook.md:131-138` — fictional `sessions` sweep → better-auth `session` table / 30-day rolling. Pin: `migration-runner.server.test.ts:68` (`not.toContain("sessions")`). |
| **N19-1** | NOT-A-BUG (downgraded) | Repo field stays free text; post-hoc honesty real via `repo-access-check.server.ts`→`github-pills.ts`. No code owed. |
| **N19-2** | FIXED (doc) | `ux-design-specification.md:394-396` Roobert→Manrope. Pin: `app.css.test.ts:260`. |
| **N19-3** | FIXED + pinned | `docs/architecture/file-formats.md:198-221` (nine packet kinds incl. `archive_task`). NEW gate `file-formats-sync.test.ts:83` mirrors `PACKET_OPTION_KINDS`. |
| **N19-4** | FIXED (doc) | `ux-design-specification.md:363-366` radii corrected, unported tokens marked. Pin: `app.css.test.ts:111`. |
| **N19-5** | FIXED (both halves) | Danger-zone gate `settings-page.tsx:1649` `{canEditPolicy && …}`, pinned by full-page render `settings-page.test.tsx:1095-1175`; PAT half under R19-11. |
| **N19-6** | RETRACTED | Third-party GitHub close refuted the stale-reconcile hypothesis (`NOTES.md:73`); kept as a method class. Hermeticity closed by `ed6a6c5`. |
| **dead-path** (RecommendationsSection) | RESOLVED — deleted | Component gone from `task-main-sections.tsx`; only a warning comment `:28-34`. Repo-wide: zero export, zero `apply-recommendation` submit outside that comment. |
| **UC-14** (MCP probe, Claude hyphens vs Codex underscores) | EVIDENCE (live, historical) | Preserved in `USE-CASES-MERGED.md:24`, `UI-TOUR.md:76`. Not re-runnable here (no container); capability disclosed by F19-16. No code gap. |
| **UC-15** (skill-decoy) | FIXED / hardened to unit test | `specialist-run.server.test.ts:2292-2365` (decoy `kubernetes-rollback`+SENTINEL absent from persona); `operator-kb-injection.server.test.ts:128-161` for operator. |

---

## 2. OPEN — must implement

**None.** No genuinely-unimplemented product item survives on the merged tree. Every finding above is FIXED (code + green test), RULED + implemented, NOT-A-BUG, or RETRACTED.

---

## 3. Unpinned fixes (FIXED in code, but no test fails if the fix is reverted)

1. **R19-A — schedule-time autonomy clamp** — `app/server/tasks/schedule.server.ts:150` clamps a scheduled operator run's autonomy to the project ceiling (`clampAutonomy(input.autonomy, operatorAutonomyFor(...))`). **Verified unpinned:** `app/server/tasks/schedule.server.test.ts` schedules with `autonomy:"full"` (`:202`) but never asserts the persisted `s.autonomy`; grep confirms no `autonomy` value assertion anywhere in the file. Swapping `clampAutonomy(...)` → `input.autonomy` leaves the whole suite green. The *run-time* clamp is pinned (`operator-actions.server.test.ts:186,304`); only this schedule-time call site is not. **Fix:** add a `schedule.server.test.ts` case on a **supervised-operator** project asserting a requested `full` persists as `supervised` (this is Session-B use-case #39, "scheduled runs fire unattended" — the worse half).
2. **F19-43 — duplicate-comment removal** — `app/server/tasks/task-actions.server.ts`. Comment-only cleanup; there is no executable change to pin. Recorded here for completeness; no test is warranted.

---

## 4. Caveats — code-complete, live runbook never authored (not OPEN product)

These three are code-complete and **unit-pinned**; the only gap is a *live-exercise runbook* (a verification-method doc), not product or coverage. Surface to the owner only if the "nothing deferred" bar extends to live runbooks; otherwise each needs one line ("won't runbook") or a runbook authored.

- **G19-c** — FR23 session-export live runbook (code: `session-export.server.ts`; test: `session-export.server.test.ts`).
- **G19-d** — FR6 in-flight project-settings-change live runbook (code: `settings-actions.server.ts`; test: `settings-actions.server.test.ts`).
- **G19-h** — ruling-33 asked-agent resume live-exercise runbook (code: `task-actions.server.ts:526`; test: `agent-reply.server.test.ts:1026`).

---

## 5. Hygiene caveat (not OPEN, not unpinned)

- `app/features/policy/project-authority-routes.server.test.ts` (additive oracle coverage for F19-28 / F19-30) is **present and green but uncommitted** (`git status` shows it untracked). It would be lost if the working tree were discarded. F19-28/F19-30 also have tracked pins, so coverage does not depend on it — but commit it before the pass closes to keep the oracle. `retired-vocabulary.test.tsx` (pins F19-12) is likewise untracked on this worktree.

---

*Supersedes `planning/discovery-2026-08-06-pass19/DISPOSITION.md` for every range it covers. That ledger predates commits `5a7d659`, `2296bce`, `1836f00`, `17472d5`, `7886492`, `b1f08a5`, `040f669`, PR #154, and rulings R19-9..R19-13/R19-A/R19-B; its §2 PARTIAL/OPEN/NOT-DONE flags (§2.1 F19-12, §2.2 N19-5, §2.4 thin-pins, §2.6/2.7 G19-a/b/e, §2.8 dead-path) are all closed on tree `846a4f4`.*

## Closing note (caveats resolved, 2026-08-09)
The two caveats above are now closed:
- **Unpinned R19-A schedule-time clamp** → PINNED by `schedule.server.test.ts` "clamps the scheduled
  autonomy to the project's operator ceiling (R19-A)" (canaried: neuter the clamp → "expected 'full'
  to be 'supervised'"). 3626 tests green.
- **G19-c / G19-d / G19-h live runbooks** → authored (`runbooks/G19-c-native-session-reach.md`,
  `runbooks/G19-d-stage-editor-inflight.md`, `runbooks/G19-h-askedby-resume.md`). The code was
  already implemented + unit-pinned; these add the live-exercise recipe.
- **F19-43** stays comment-only (no executable change to pin — correct).

**Final state: 0 OPEN, 0 unpinned, 0 caveats. Every pass-19 finding across BOTH sessions is
implemented + test-pinned, ruled, or not-a-bug. PR #157 CI green.**
