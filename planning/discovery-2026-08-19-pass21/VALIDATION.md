# Pass 21 — validation record (living; finalize at end)

Gates per band: `npx react-router typegen && npx tsc --noEmit` clean + full `npx vitest run` green. Final: lint clean (ruling 86), container rebuilt from worktree, live re-verification, screenshot sweep.

## Checklist (fill as validated)
- [x] Band 0+1 gate (C0-CANON, C0-BASELINE, C1-GH, C2-ACTIONS, C3-OPERATOR, C3B-RUNTIME): typegen+tsc clean, FULL SUITE 261 files / 3991 tests green (pre-pass baseline was 3890). Band 2 (C4/C5/C2b) in flight.
- [x] Band-2 gate: tsc clean + FULL SUITE 262 files / 4040 tests green (baseline 3890; +150 new pinned regressions). All 9 clusters (C0-CANON/C0-BASELINE/C1-GH/C2/C3/C3B/C4/C5/C2b) reported red→green canaries per finding (recorded in their reports).
- [x] Adversarial disposition audit: 40 verdicts — 21 CONFIRMED_FIXED (F21-7/22/16/14, U3, F21-8/11, C2b-resolve/operator, R21-4a, F21-13srv+ui, U11, F21-3, U6, F21-5, U7, U8, OBS-4/6, F21-4), 19 PARTIAL with concrete follow-ups → Band 3 (FB3-GH/RUNTIME/OPERATOR/ACCEPT/POLISH/CANON). No REFUTED.
- [ ] F21-1 live: rebuild container (fresh /data/state) → force-accept flow with workRevision → reprojection OK, row validation='bypassed', board renders "gate bypassed" arm
- [x] F21-1 unit: CHECK widened in db/migrations/0001_baseline.sql; real-write rebuilder test (28/28) canaried red→green with exact production CHECK error; all 21 baseline CHECKs audited vs enums (only validation lagged; kb refresh CHECK is a safe superset — recorded). Live half pending container rebuild.
- [x] F21-7/8/9/11/22 unit (C1-GH): unknown-bucket check-runs accounting (exact live payload persists {unknown:3}, renders grey); commit list per-entry tolerance + droppedCommits provenance; github-client kind:'decode' + pr-open salvage + per-task reconciler boundary + wrapped Reconcile action; PAT per-field catches (exact finding table reproduced); commits log honest. 442 tests in area (+21 new), 5 canaries red→green.
- [x] U3 unit (C2): in-lock re-check on transitions (no-op/409/write) + acceptance; force-accept audit row only after success. Canaried (3 reds). Live half pending.
- [x] F21-2 unit (C2): ruling-88 ack (three-state), accept_disclosure_missing 400 / accept_disclosure_stale 409, enforced pre-merge + in-lock, client echoes rendered rows; 7 canary reds. RESIDUAL: apply-recommendation/resolve-packet/board doors omit ack (own pins) — extend in C2b. Live half pending.
- [ ] F21-21 live: repeat the VIB-7 shape (dev commit → operator run) → no false out-of-band claim; operator reads origin/main content correctly
- [ ] R21-4 live: new task shows "preparing workspace (cloning…)" phase; clone uses mirror (second task clone ≪ first); live-run rows show phases
- [ ] F21-13 live: backend switch cannot save foreign model; substitution surfaced if forced
- [ ] F21-5 live: Selin (viewer? now contributor — use a fresh viewer or demote) sees NO credential card on /settings
- [x] C3-OPERATOR unit: F21-21 (read_default_branch_file tool + workspace-is-task-branch prompt/manual; no separate clone existed, Bash denylisted), F21-16 (operatorPolicy scope+note+specialist web flag), F21-14 (acceptance exception stated), F21-17 (revisionDrift folded into closed-PR arms), F21-3 (operator MCP pre-flight + single denylist + pinning tests), R20-9 MECHANICAL (auto-appended consult disclosure), R21-2 gap-remedy instruction, F21-6 verdict-aware copy. 1197 tests, 6 canaries red→green. LIVE copy verification still pending fresh loop.
- [ ] F21-16/17/14/OBS-4/F21-6 copy: verify in UI/packets on a fresh loop (live half)
- [ ] OBS-11 live: no-changes acceptance deletes empty branch (setting on)
- [ ] F21-24: shutdown drain — restart container mid-run → no lazy reopen, single warning not spray
- [ ] Lint: npx oxlint → 0 findings; CI workflow carries lint job
- [ ] Theme + mobile screenshot sweep of changed surfaces
- [ ] decisions.md rulings 84-88 appended; architecture.md amendments in place
- [ ] Disposition audit: every FINDINGS.md row has fixed/held/wontfix + evidence (pass-16 lesson: run this even when clusters claim done)
- [x] decisions.md rulings 84-88 appended (84=R20-9 promotion, 85=R21-2, 86=R21-3, 87=R21-4, 88=R21-5 acceptance disclosure); architecture.md/prd.md/ux-spec/FILES.md/CONTRIBUTING/README/testing docs amended; prd-sync test green. (Dup of earlier checkbox — this one is DONE.)
- [ ] WRAP: full FILES.md regen from git ls-files at pass end (stale by ~1006 files, pre-existing)
- [ ] C2b residuals: ack on apply-recommendation + resolve-packet + board accept doors; resolvePacket accept arm in-lock no-op; operatorAcceptCompletion honors {accepted}; FILES.md row for acceptance-disclosure.ts
- [x] Band-3 gate (FB3-GH/RUNTIME/OPERATOR/ACCEPT/POLISH/CANON + workspace-delivery U12 one-liner): typegen+tsc clean, full suite exit 0 ×2 consecutive (FB3-RUNTIME's closing run recorded 264 files / 4082 tests). All 19 audit PARTIALs addressed; canaries per cluster.
- [~] C6-LINT running: 26 findings → 0 + ci.yml lint step (behavior-preserving mandate, F21-7-class warning given).

## Live validation on the rebuilt container (old data root kept — owner's PAT preserved)
- [x] F21-1 boot drift WARN fired verbatim on the lagging root (refuses:["bypassed"], impact+remedy+cost); live-validation CAUGHT the missing-column variant (work_revision_sha absent on old roots → every INSERT would fail) → new projectionMissingColumns check + WARN arm + additive-ALTER remedy note + unit test; this root healed via additive ALTER (users/PAT untouched). Fresh roots get the widened CHECK from birth (unit-pinned).
- [x] R21-4a live: VIB-10 task page showed "Preparing workspace / Cloning akin-ozer/viberr" as a live-run row with elapsed counting (shot 38).
- [x] R21-4b live: per-project bare mirror created at projects/viberr/.repo-mirror/akin-ozer__viberr.git (56M, refs/heads only).
- [x] F21-5 live: Selin demoted to Viewer → /settings shows repo binding but NO credential label/tail/scopes; restored to Contributor after.
- [x] OBS-7 live: Developer header reads "Global base · customized for viberr".
- [x] F21-18 live: all board key chips single-line at 390px (computed white-space: nowrap).
- [x] F21-21 live rerun (VIB-10, the exact VIB-7 shape): no false out-of-band claim; loop clean.
- [x] F21-22 live: operator-deliver push logged commits: 1.
- [x] F21-6 live: verdict-capable Reviewer engagement logged "as a reviewer" (supporting arm unit-pinned).
- [x] Ruling 88 live: bare accept POST → 400 "needs the confirmation dialog… no record of what was shown"; ceremony accept then merged PR #174 (Done, branch auto-deleted).
- [x] Full governed loop on the pass-21 build: VIB-10 create → phases visible → mirror-backed clone → Codex dev commit → PR #174 → reviewer approve → ceremony accept → REAL merge 20:58:03Z.
- [x] Final gates: typegen+tsc clean; full suite 4082 green ×2; oxlint 0; lint first in CI verify.
- [x] Rulings 89/90 (owner, 2026-08-20): triage gate stays behavioral — placeholder reworded and LIVE-VERIFIED post-rebuild ("…get flagged by the operator at triage"); FILES.md deleted per ruling 90 (git ls-files + architecture tree are the index). Gates re-run: board/docs/copy-ban 159 tests green, tsc 0, oxlint 0.
- [x] Post-merge live round trip: @operator on closed VIB-10 answered with exact task-record facts (PR #174 merged, no revisionDrift, human acceptance) and tagged the asker.
- [x] Post-fix UI re-inspection: agents-page subtitle defers to per-card provenance; Web Verifier "Created in viberr" vs Developer "Global base · customized for viberr"; "agent threads in a working state" (U12) — all live.
