# Verified drift: main 81dafe3 → 8d285bc (2026-07-16)

Section-by-section verification of `../discovery-2026-07-16/architecture.md` against current
main. Verdicts: ACCURATE / DRIFTED / WRONG, with the corrected facts. Produced by a code-reading
subagent this pass; spot-claims carry file:line.

## Per-section verdicts

- **§1 Boot — DRIFTED.** Step 10 `registerSeededLiveFromData` no longer exists; boot now calls
  `finalizeOrphanedRuns(db)` (boot.server.ts:133; run-recovery.server.ts:27): real orphaned
  running/queued runs → `error(interrupted-by-restart)` + operator re-invoke; seeded/simulated
  runs → `finished` (R6-5). `recoverUnreactedAgentRuns` remains (boot.server.ts:146).
  §1.2's "codex-home NOT in DATA_ROOT_SUBDIRS" is fixed — it IS now (file-store-root.server.ts:34).
- **§2 Routes — ACCURATE.**
- **§3 Server modules — DRIFTED (additions):** `github/push-workspace.server.ts`
  (`pushWorkspaceBranch`); `run-recovery.server.ts` exports `finalizeOrphanedRuns`;
  `project-role-guard.server.ts` carries an inline archived gate.
- **§4 DB schema — DRIFTED (materially).** Single `db/migrations/0001_baseline.sql` now (squash
  d7b81e2). The 0005 mock scope-violation is NO LONGER seeded into every DB — moved to
  `runDemoSeed` (demo-seed.server.ts:261-273), demo-only. `agent_runs` has NO failure_reason
  column — A3 persists the classified reason as a terminal `err` LOG LINE, not a column.
- **§5 Scripts — DRIFTED.** `gen-better-auth-schema.ts` emits `db/better-auth-reference.sql`
  (reference dump), not a migration.
- **§6 RBAC — ACCURATE + addition:** `requireAcceptCompletion` (task-actions.server.ts:369) owner
  exception (R6-2) at 4 accept sites (transition human-boundary :2238, resolvePacket
  accept option :2656, acceptCompletion :2838, completeTaskMerge :2944).
- **§7 Runtime lifecycle — DRIFTED.** Review boundary now: `openReviewPrBestEffort`
  (task-actions.server.ts:2373) → `pushWorkspaceBranch` (PAT/askpass push of workspace commits)
  → `openTaskPr`; empty-diff surfaces a timeline event + notification (:2408-2442).
  `applyAgentCompletionEffects` now at :1583. Error path posts typed blocked event using
  `runFailureReason` (:1629-1631).
- **§8 SSE — ACCURATE.** **§10 Auth — ACCURATE.**
- **§9 GitHub — DRIFTED (minor):** PAT-path operations now include the push-workspace bridge.
- **§11 — MOSTLY ACCURATE.** Health codex availability is stricter: under
  `VIBERR_CODEX_USE_CLI_AUTH`, requires `$CODEX_HOME/auth.json` (runtime-registry.server.ts:73-100).
- **§12 Docker/codex — DRIFTED (partially fixed).** Root-cause 3 (presence-only credential check)
  FIXED (auth.json validation); codex-home subdir FIXED. Sandbox/Landlock analysis still open.
- **§13 Suspicious list — DRIFTED:** item 1 (migration mock violation) closed; item 6 closed;
  item 11 (seed-resumer) neutered but still wired (see findings F7-VEST1). Items
  2,3,4,5,7,8,9,10,12,13 still hold.

## Org-admin override (ruling D2): definitively NOT implemented

No org-admin path can mutate a non-member project. `requireMemberRole`
(task-actions.server.ts:321-335) and `assertProjectAction` (project-role-guard.server.ts:44-59)
resolve authority ONLY from project.md members[]; `rbac.ts` has no org-role escape hatch;
`requireRole("admin")` gates only /org surfaces. Org-admins DO read all (home cards, SSE scopes)
— read visibility exceeds actionability (asymmetry).

## Fresh observations (this pass)

- `seed-resumer.server.ts` vestigial-but-wired: still called from routes/project.task.tsx:47,91;
  boot finalizer retires seeded runs so the drip can effectively never fire post-boot.
- `runFailureReason` classification is regex-on-log-text; codex's redaction means codex failures
  classify as `unknown` → generic escalation copy. A3's classified terminal err line was added to
  the claude adapter only.
- `finalizeOrphanedRuns` re-invokes the operator with trigger:"manual" for every real orphan on
  EVERY boot — no backoff/attempt cap (crash-loop amplification risk).
- Baseline SQL has cosmetic `CREATE TABLE "agent_runs"` quoting inconsistency.
