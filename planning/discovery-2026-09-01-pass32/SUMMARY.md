# Pass 32 — Discovery + live-use summary (2026-09-01, in progress)

## What this pass did (so far)
Fresh docker-data instance (owner re-baselined 08:39). Eight opus/max doc-refresh agents rewrote the
seven pass-31 reference docs against main @ 68b5480e and added a PR-by-PR digest of #253-#264
(docs/00..07), each ending in a findings section (~55 code/doc findings). Fixtures built from zero
through the UI: 3 QA users (temp-password gate), KB `pass32-conventions` (marker rule), stdio MCP
`qa-echo`, global profile Docs Writer (Codex) forked in viberr with repo-write, project Sandbox
(containerless, Autonomous). Live campaign: see NOTES.md ledger.

## Live results so far
GOOD:
- Governed loop end to end on viberr TWICE (VIB-1 Docs Writer→Claude after Codex auth failure;
  VIB-2 Developer after a custom-directive hand-off): triage → auto transitions → correct agent pick
  by description → KB marker + REAL MCP call proven in transcripts → delivery → reviewer verdict bound
  to head sha with evidence → recommendation → human acceptance ceremony → merge → after-merge
  branch deletion. PRs #265 and #266 merged (small files under qa/pass32/).
- resolve_remote_collision ceremony (pass-31 F6 fix) executed live: closed stale PR #255, deleted the
  stale branch, redelivered as PR #265.
- Agent honesty: Developer without grants raised an ask-human packet instead of inventing the MCP
  output; a RESUMED run picked up newly granted MCP/KB mounts.
- Chained goal (2 links) + a browser-evidence task completed fully autonomously on Sandbox, incl.
  no-change acceptance under full autonomy and ruling-105 prune (only the cited screenshot kept).
- Controller: accurate instance summary, honest no-tool refusal, stage rename under the asker's
  authority with a "· via controller" audit row.
- Temp-password gate, audit CSV/JSON export, session export, ⌘K palette, hand-edit propagation of
  project.md, per-recipient notifications, notification-routing toggle persistence.
- RBAC probe matrix (61/65 exact; every withdrawn control absent from the DOM; 404 bodies identical;
  denial audit deduped; owner exception exact) — planning/…/RBAC-PROBES.md, rerunnable.
- Ops: rebuild projections (counts identical), concurrency cap queue + drain by interrupt and by cap
  reset, interrupt attributed in audit, scheduled operator run (pending), force-accept ceremony
  from Triage with `acceptance: forced`, stage add/remove re-wiring, task archive/restore.

BUGS (ranked, details in IMPROVEMENTS.md):
1. F32-1 disk-free readout ~274× too large on virtiofs (statfs bsize≠frsize) — the controller told
   the owner "1 TiB free" while the Mac had 3.7 GB.
2. F32-5 markdown `%zz` attachment link throws mid-render → task page error boundary.
3. F32-7 resolve_remote_collision on a supervised project strands the task (no re-queue, no
   next-step recommendation) — NO_REQUEUE assumption wrong for the manual redelivery path.
4. C02-R2/R3 Codex parity carve-out (owner ruled: read-only cwd + writable attachments) and
   attachmentsWritableDir dropped on resume.
5. F32-2 KB re-index has no SSE; F32-4/F32-9 credential refusal + quota exhaustion invisible to
   health/instance_health (controller misinformed the admin twice).
6. C01-A1 packet observations whole-array parse (durable loss class), C01-A3 audit-exports not
   backed up, C05-A host path in unauthenticated health, C05-B/D collision remedy ordering + 403.
7. D32-5 segmented control selected+hover text invisible (measured white-on-white).
8. F32-8 operator briefs promise tools the target agent does not hold (30 wasted turns per review).
9. F32-10 same-stage transition answers 200 "Moved" for any role before the guard (RBAC probe D1).
10. F32-11 force-accept closes an open packet silently (no ceremony row, no event, no audit).

## Owner decisions this pass
Batch 1 (23:05): collision cleanup approved; Codex re-login done by owner; parity = read-only cwd +
writable attachments; viberr_ops reads audited.

## External constraints
Codex account over quota until 2026-09-18 (credential itself proven good). Claude 5-hour window hit
94% at 23:47 (resets ~00:50); agent-run-heavy use cases paused until then.

## Implementation status (2026-09-02)
Branch `pass32/implementation` → PR #269 (clusters A–F in one PR, per-cluster commits). Every
ledger item is dispositioned in IMPROVEMENTS.md (FIXED with a lock, DECIDED-NO-CHANGE with the
ruling, or VERIFIED-NOT-A-DEFECT with the evidence). Guardrails card = ruling 112 landed. A
projection derivation-version stamp (`instance_settings.projection.derivationVersion`) forces one
full rebuild at boot when a derived column's rule changes (first use: D32-14 actor refs).
Gates: lint 0, tsc clean, vitest 300+ files / 4900+ tests green; CI verify + e2e green on the
push before the last two commits (re-running). Live: container rebuilt from the branch, the
Guardrails toggle round-tripped (file, projection, audit, toast), the boot log shows the forced
derivation rebuild, the Stream and Audit actor filters name every actor once.
Review round: an opus max-effort adversarial review of the E/F diff found 14 issues (3 already
fixed mid-review); the 11 live ones are fixed with locks in 565b71eb (see IMPROVEMENTS.md). The
CI `verify` red on the first two E-pushes was an unhandled rejection from un-awaited test callers
of the now-async `interruptRun`; fixed by reordering the function and a per-file await sweep.
Gates at 565b71eb: lint 0, tsc clean, vitest 302 files / 4917 tests.
