# Implementation ledger — pass 6 (2026-07-16)

Branch: `pass6-implementation-2026-07-16` (off main @ 81dafe3). Every item below must land
with tests + a validation note (code / UI screenshot / browser). No deferrals. Breaking
changes and test rewrites allowed. Order is by risk: correctness spine first, then rulings,
then polish.

Legend: [ ] todo · [~] in progress · [x] done+validated.

## A · Agent-spawn correctness (the reason nothing ran)

- [x] **A1 (F-SPAWN1) — watcher fd explosion.** Prune the watch tree below the task dir so
  chokidar never opens fds for `workspace/` clones. DONE in file-watch.service.server.ts
  (`shouldPruneSubtree`); fds 11,342→541, operator+specialist runs work.
  - [ ] A1-test: regression test that the watcher ignores `tasks/<KEY>/workspace/**` and still
    projects task.md/project.md. Add to file-watch.service.server.test.ts.
- [ ] **A2 (F-SPAWN2) — silent instant-failure race.** `chainRunCompletion` must fire the
  callback immediately if the run is ALREADY terminal at attach time (run-service). Then a
  spawn-time crash escalates a packet like a normal failure. Test: attach after terminal →
  callback runs once.
- [ ] **A3 (F-SPAWN3) — persist + surface the crash reason.** Add an error-reason column to
  agent_runs (or a run_error row) capturing classification (spawn/quota/auth/crash) + short
  message; render it in the run panel and feed runFailureReason. Migration allowed.
- [ ] **A4 (F-RUN1) — boot finalizer for orphaned `running` runs.** On boot, any real
  (simulated=0) run left `running`/`queued` with no live in-proc registration → mark `error`
  (reason: interrupted-by-restart) and let the operator escalate. Extends run-recovery.
- [ ] **A5 (F-SPAWN4) — Better Auth baseURL.** Set from env(PORT)/BETTER_AUTH_URL to kill the
  boot warning.

## B · GitHub governed-delivery spine (the chain that stops at "no PR")

- [ ] **B1 (F-GH3) — push the workspace branch before opening the review PR.** At the review
  boundary, when task.md carries reconciled local commits but the remote branch has no diff
  (or is behind), PUSH the workspace branch via the project PAT (system_delivery authority)
  then open the PR. If still empty-diff, raise a packet — not a swallowed
  `nothing_to_review` log. Touch: workspace-delivery.server.ts (add a push step) +
  pr-open.server.ts / task-actions openReviewPrBestEffort. Live-verify on viberr-test-lab.
- [ ] **B2 (F-GH4, ruling needed→defaulted) — acceptance with no PR.** When commits exist but
  no PR/merge is possible, acceptance should surface it (packet/confirm), not silently reach
  Done "(no linked pull request)". Default to: block auto-accept, raise a "no PR to merge —
  push blocked?" packet; keep an explicit admin override. (Owner may soften later.)
- [ ] **B3 (deferred-cluster re-check) — mergeTaskPr headSha/merge path on main.** VERIFIED
  live: mergeTaskPr merged PR #24 for real. Confirm no headSha deadlock remains; add a test
  for merge-after-external-reopen.
- [ ] **B4 (F-GH1 setup, done) — org connection + project credential.** DONE for
  viberr-test-lab in testing; ensure the create-project flow + org settings UI both bind
  cleanly (already exercised). No code change expected; keep as validation.

## C · Role bindings (owner rulings R6-2..R6-4)

- [ ] **C1 (R6-2 / F-RBAC1) — owner-exception accept-completion.** The task's human owner
  (contributor+) may accept its own completion. Add the owner exception at the
  accept-completion call sites (task-actions.server.ts:2527, :2701, :2796, and the packet
  path :2527) mirroring the resolve-packet owner exception; keep ACTION_ROLES row maintainer+
  and render the exception rule honestly on the Policy page. Tests: contributor-owner accepts;
  contributor-non-owner denied; viewer-owner denied.
- [ ] **C2 (R6-3 / F-RBAC2) — archived = read-only enforced.** Block governed mutations on an
  archived project server-side (a single guard in the mutation entry points / loadProjectContext
  → throw if archived, except restore). Add an archived banner + disabled actions in the UI.
  Tests: mutation on archived project 403s; restore still works; read still works.
- [ ] **C3 (R6-4 / F-RBAC3) — board drag Review→Done = acceptance.** Ensure a human dragging a
  Review task into Done runs the SAME acceptance path (merge attempt / merge-pending + audit)
  as the Review-queue Accept button — one semantic, two surfaces. Verify current board
  transition handler; wire it through acceptCompletion if it doesn't already. Live-verify drag.
- [ ] **C4 (F-RBAC4) — org-admin emergency project override (R6 D2 prior).** Confirm/implement
  org-admin can override project policy in an emergency; if absent, add with audit.

## D · Demo-run honesty (R6-5)

- [ ] **D1 (R6-5 / F-RUN1b) — stop animating seeded runs + exclude simulated from rollups.**
  Remove the boot `registerSeededLiveFromData` re-animation; exclude simulated=1 runs from
  "runs active", Agents→Live rollups, and decision counters. Viberr Core goes quiet unless
  real agents run. Update home-query / agents-query / any run rollup. Tests + UI screenshot.

## E · Docker / codex-under-compose (F-DOCKER1..3)

- [ ] **E1 (F-DOCKER1) — codex auth under compose.** Create/populate CODEX_HOME in the image
  (add `runtimes/codex-home` to DATA_ROOT_SUBDIRS; document the auth.json/CODEX_ACCESS_TOKEN
  mount) AND make adapter selection validate usable auth: if VIBERR_CODEX_USE_CLI_AUTH=1 but
  no auth.json/token is present, fail fast with an actionable packet instead of a redacted
  line. runtime-registry.server.ts + compose.yml + README.
- [ ] **E2 (F-DOCKER2) — codex sandbox on Linux.** Ensure `codex-linux-sandbox`/Landlock is
  available in-container (or degrade explicitly with a clear reason). Verify in a container
  build if feasible; otherwise document + guard.
- [ ] **E3 (F-DOCKER3) — classify codex failures.** Split the single redacted "Codex execution
  failed" into auth/config/sandbox/quota reasons (feeds A3's run-error surfacing).

## F · Resources parity (lower risk, still no-defer)

- [ ] **F1 (F-RES1) — MCP end-to-end.** Verify an agent run can actually call a reachable MCP
  server's tool (log shows the call); keep the seeded fake `docs-search` honest (unreachable).
  If the seed should ship a working example, replace it.
- [ ] **F2 (F-RES2 / T30) — KB re-scan real.** Confirm re-scan re-indexes from real files with
  an honest count/timestamp (no fake toast).
- [ ] **F3 (T27) — custom specialist stage-gating.** A profile eligible only in some stages
  can't be assigned/run elsewhere (assign AND run enforcement). Test + live.
- [ ] **F4 (T28) — skill isolation.** A run loads only its declared skills, not unrelated org
  skills. Verify from a real run log.

## G · Polish (F-ENV2, F-PARITY1, F-UI1)

- [ ] **G1 (F-ENV2) — migration numbering gap** 0006→0008: document or renumber (no data
  migration needed; note in a comment/README to avoid re-diagnosis).
- [ ] **G2 (F-PARITY1) — codex Live panel usage** honesty ("usage at completion" label or
  stream if available).
- [ ] **G3 (F-UI1) — packet resolve action-bar text overlap** fix.

## Validation gates (must pass before "done")

1. `npm test` green (rewrite tests as needed — allowed).
2. `npm run typecheck` clean.
3. Live re-run on viberr-test-lab: vague-goal→packet, scoped→assign→run→push→PR→review→
   accept→MERGE, reject path, archived read-only, contributor-owner accept, drag-to-Done.
4. UI screenshots for each user-visible change.
5. Every findings.md item OPEN→FIXED/RULED; every ledger box checked.
