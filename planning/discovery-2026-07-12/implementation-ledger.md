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

## Deliberately NOT changed
- Doc-drift D1/D3/D4/D5/D6 are app-reference wording notes — the CODE is correct; will fold into
  a docs refresh, not behavior.
- F5/F7/F9 (copy/seed-cosmetic) — low value; F9 (per-KB budget) left as documented behavior.
- Existing project.md capability grants for pruned ids (selftest-4 etc.) are orphaned-but-ignored;
  re-seeding is unnecessary and the owner allowed breaking, but new projects get the clean catalog.

## Git
Commits on `viberr-rolebindings-pass3`: role-bindings core → capabilities/F11 → F1 → F8 → findings.
Live test PRs on akin-ozer/viberr: **#12 merged**, **#11 + #13 closed** (F11 proof).
