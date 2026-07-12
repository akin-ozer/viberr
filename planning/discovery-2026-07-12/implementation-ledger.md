# Implementation ledger — pass 3 (2026-07-12)

Branch `viberr-rolebindings-pass3` off `main` @7c064cd. Every item validated by
typecheck + `npm test` (1136 green) + `npm run e2e` (13 golden paths) + live browser/API.
No migrations; existing project.md files keep their stored grants (orphaned prune ids are
ignored at runtime).

## Role-bindings rework (the deferred phase)

| Item | What shipped | Validated |
|------|--------------|-----------|
| R1 · matrix-as-runtime-source (D2/D5) | New `app/shared/rbac.ts` = ONE `ACTION_ROLES` map; the Policy table (`RBAC_TABLE`) and every server guard (`requireAction`) consume it. Migrated ~12 call sites in task-actions off inline role lists. | RBAC unit tests + live 4-user probe |
| R1 · guard consolidation | 3 duplicated `requireProjectAdmin` copies now delegate to ONE `assertProjectAction` (`app/server/auth/project-role-guard.server.ts`); runtime-role helpers use `roleCan(role,"run-agents")` | typecheck + tests |
| Q5 · clean tiering (owner ruling) | Viewer = read + comment only. Ownership (take/release/hand-off target) + owner-packet-resolve moved to contributor+. UI: Assign-me hidden for viewers, all task-detail role checks use `roleCan`. | Live: selin(viewer) take-ownership 200→**403**; ownership matrix row → viewer dash |
| R2 · full D9 SSE membership | `resources.events.ts`: explicit `project:`/`task:` scope now requires membership (org-admin bypass); foreign-only → 403. | Live: non-member `scope=project:…` 200→**403**; +2 unit tests |
| R4 · read-surface gating (owner ruling) | `project.review.tsx` + `project.activity.tsx` loaders → `requireProjectMember`. | Live: non-member review/activity 200→**403** |
| R3 · capability prune | Removed `edit-other-task-branch`, `open-or-merge-pr`, `compress-timelines`, `owner-reassignment` from catalog + seeds + modal + operator editor. | Live: modal 18→17 rows, `edit-other-task-branch` gone |
| S3 · honest labeling (owner ruling) | `capabilityEnforcement()` → both/claude-only/advisory; matrix marks tool-denial caps "CLAUDE-ENFORCED · advisory on Codex". | Live: badges + legend rendered |

## Findings

| # | Fix | Validated |
|---|-----|-----------|
| F11 (HIGH) | Removed the `edit-other-task-branch` deny rule whose broad `Bash(git checkout:*)` defeated the granted create-task-branch (deny wins under bypassPermissions). | **Live: PR #13 delivered by a Claude specialist under the default `edit-other-task-branch: human` config** — the exact config that blocked delivery before. Host checkout stayed isolated. |
| F8/F12 | Errored (non-simulated) runs now post a typed `blocked` event (quota/auth/unknown), open a recovery packet, notify watchers, clear waiting — no more silent revert. `runFailureReason()` classifier. | +1 completion test (Codex quota surfaces a blocked event) |
| F1 | Agent stage eligibility WIRED (owner ruling): DeployedSpecialistView/ResolvedSpecialist carry stages/spanAll; assign/run reject an ineligible specialist; operator pickers filter by current stage; get_task snapshot annotates eligibility; fixed the false picker comments. | +1 rejection test; assign test moves to a dev-eligible stage first |
| F10 (MED) | Fresh instance (0 connections) self-serves its first project: server requires a repo owner only when a repo NAME is given; UI offers a manual owner or a repo-less project instead of a hard-disabled Create. | +2 project-create tests |
| F2 (MED) | `deleteProject` deletes the project's app-owned notifications (no orphan 404 dead-ends). | code |
| F3 (LOW) | Theme boot script reads the authoritative `viberr_theme` cookie so the ErrorBoundary keeps the session theme. | code |
| F4 (LOW) | Task Permissions rail renders from the matrix per the viewer's role (dropped the misleading "owner reviews & accepts / human-owner-only" copy). | Live: rail reads honestly |
| F6 (LOW) | "Grant scope" hidden in the no-credential state. | code |
| S3 labeling | (above) | Live |
| Doc drift D2 | Fixed `operator-run.server.ts` header (Codex = structured-plan run, not always scripted). | code |

## Also closed in follow-up commits
- F5 (org connections copy), F9 (KB budget now a GLOBAL cap across all declared KBs), R6
  ("Edit the task goal" added as a displayed RBAC row), F13 (see addendum below).

## Deliberately NOT changed
- Doc-drift D1/D3/D4/D5/D6 are app-reference wording notes — the CODE is correct; a docs refresh,
  not behavior.
- F7 (drip-run elapsed) is a demo-SEED cosmetic only — no product-logic surface; left as-is.
- Existing project.md capability grants for pruned ids (selftest-4 etc.) are orphaned-but-ignored;
  re-seeding is unnecessary and the owner allowed breaking, but new projects get the clean catalog.

## Git
Commits on `viberr-rolebindings-pass3`: role-bindings core → capabilities/F11 → F1 → F8 → findings.
Live test PRs on akin-ozer/viberr: **#12 merged**, **#11 + #13 closed** (F11 proof).

## Addendum: F13 closed to root cause (2026-07-12)
Investigated the host-plugin/skill leak to conclusion. Added `plugins: []` as a third empty
isolation lever in `claude-runtime.server.ts` (alongside settingSources/skills). Empirically
re-ran a Claude specialist and confirmed the residual leak is **process-level inheritance**, not a
config-dir/plugin channel: the leaked entries include the PARENT Claude session's own SDK tools
(CronCreate, Monitor, Workflow, SendMessage, ScheduleWakeup…), present ONLY because viberr's dev
server was spawned from inside an active Claude Code/Desktop session. No SDK option can override a
parent's injected process environment. In a standalone deployment (systemd/Docker, pristine
CLAUDE_CONFIG_DIR, no Claude parent) there is nothing to inherit — the declared-resources-only
guarantee holds. Declared skills (developer-expertise etc.) DO load correctly in every case. The
app-reference's absolute "no host plugins leak" wording is corrected to state this precise boundary.

## Addendum 2: adversarial self-review round (2026-07-12)
Ran 3 parallel adversarial reviewers over the full diff (RBAC / capability+runtime / UI) before the
external code review. UI review: clean. The other two found 4 real defects the tests missed — all
fixed, all with new regression tests (suite 1136 → 1153):
1. **MEDIUM (labeling)** — `merge-pull-request` was in `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`, so the
   capability matrix badged it "advisory on Codex" — understating a structural ALWAYS_HUMAN cap.
   `capabilityEnforcement` now checks ALWAYS_HUMAN first → "both" (no badge). Verified live (merge row
   has no badge; branch/push rows still do).
2. **LOW-MED (F1)** — stage eligibility was enforced only at ASSIGN; a re-prompt of an already-assigned
   specialist could run at an ineligible stage. `assertStageEligible` now also fires in
   startSpecialistRun/startReviewerRun (the run boundary).
3. **LOW (seed)** — the operator SEED ASSET (`operator.profile.md`) still granted the pruned
   `compress-timelines`/`owner-reassignment` (raw kebab labels on the card). Removed from the asset +
   the skill-doc prose.
4. **MEDIUM (test gap)** — rbac.ts/policy-data.ts comments promised a `policy-rbac.server.test.ts`
   that drove the guards per role, but it didn't exist. Written: it drives every canonical guard as
   admin/maintainer/contributor/viewer/non-member and asserts the outcome matches ACTION_ROLES +
   proves each set is a monotonic rank-floor. Plus `capabilities.test.ts` (enforcement classification
   + prune + merge-label regression) and an F1 run-boundary rejection test.

Reviewer LOW/informational notes NOT changed (all fail-safe / by-design): releaseOwner 404-vs-403
ordering (board is app-wide readable — no new leak), demoted-viewer-owner can't self-release
(fail-closed; admin releases), policy module gating members under `edit-policy` (both admin today).

## Addendum 3: exhaustive multi-agent review workflow (2026-07-12)
Ran a Workflow: 6 dimension finders (rbac-authz, capability-system, runtime-operator, test-coverage,
ui-behavioral, consistency-honesty) → a 3-skeptic adversarial panel per candidate (majority-refute
kills) → synthesis. 25 agents, 6 candidates, **5 confirmed / 1 rejected**. All 5 fixed (suite 1153 →
1156):
1. **MEDIUM (real regression from my own F1 run-boundary fix)** — the SCRIPTED operator drive
   re-prompted an already-engaged reviewer/specialist without an eligibility filter; if that agent's
   profile was now stage-ineligible, assertStageEligible threw and the outer catch posted "Operator
   halted on an error", permanently stalling the task. Fixed: coordinate() now filters engaged
   reviewers by `eligibleForCurrentStage` and only re-runs the assigned specialist if eligible (else
   falls back to an eligible pick) — it SKIPS the ineligible agent instead of halting. + regression test.
2/3. **MEDIUM (test gaps)** — hand-off-to-a-viewer rejection and reviewer stage-eligibility were
   enforced but untested. Added both (policy-rbac + specialist-run).
4/5. **LOW (UI/server mismatch)** — a contributor who owned a task then got demoted to viewer still
   saw the Release-ownership button and packet-resolve options (identity-gated), which now 403.
   Gated both on `own-task` (canOwn) so the UI matches the server. Also strengthened the F8 test to
   assert the recovery packet opens + watchers are notified (deploying an operator so the full path runs).

Rejected by the panel (1): a claimed issue that didn't reproduce. The workflow caught a regression
my earlier 3-reviewer manual pass and the whole suite had missed — the value of the adversarial net.
