# Phase 4 implementation progress — 2026-07-10/11

> **Status:** this is the phase-4 (37-finding + D1–D4) implementation LOG. Work continued past it —
> S1/S2/S3 (shipped-build critical pass) and H1–H4 + the verdict classifier (adversarial hunt). The
> single authoritative "everything, final" map is `completeness-ledger.md`; the test→finding map is
> `test-catalog.md`. Final gates: 1029 tests green, typecheck clean.

## Landed (code + targeted tests green)

### Wave 1 (small isolated) — all DONE
- #8 binary NUL bytes in rebuilder.server.ts + use-live-updates.ts → escaped, files greppable again.
- #10/#14 dead-code pruned (listAuditEvents+migrate ~20 tests to a test-support helper, DEFAULT_HOME_PREFS, countRunLines, getDataRootForRuns, deploymentCountsByProfile; getSseBrokerStats kept test-only).
- #19 login fake "Checking whitelist…" spinner removed; #21 empty app/features/auth/ deleted.
- #22 invite-domain duplicate → real 409 inline error (no mock modal-stays-open).
- #23 literal `\n` normalization (new model-prose.server.ts) wired into operator tool boundary + codex plan.
- #26 403 error boundary now shows the server's denial message (root.tsx reads error.data).

### Wave 3 (mine) — DONE
- **Runtime isolation cluster (#32/#34/#35/#36):** new claude-config.server.ts (single config-dir resolver, used by adapter + session-export → #32 fixed); createAdapters spreads process.env so PATH/HOME survive (stdio MCP spawns work → #36) + always sets CLAUDE_CONFIG_DIR; claude adapter sets `settingSources: []` on every run (no host ~/.claude skill/agent/command leak → #35/#24/#27-skills) and denies Bash/Edit/Write/NotebookEdit/Task for operator runs (#34). Tests: claude-runtime.server.test.ts (11 pass).
- **Advisor removal (decision A):** deleted the consultant profile block + helper + assets (consultant.definition.md, domain-advisor.skill.md) + default-assets imports + RES_CATALOG entry + 3 orphaned Advisory caps (comment-with-guidance, write-to-repository, any-stage-transition); seed tasks/timeline reassigned Advisor→Reviewer; skill prose updated. 13 test files updated by subagent (consultant tests green). data/ stale copies deleted (regenerated on re-seed).
- **Operator behavior (E, #15, #24, codex-dup):** operator.md SOP rewritten — act-then-narrate ONE comment/turn, cross `auto` boundaries directly (assign specialist + advance), never recommend an auto boundary; operatorTransitionStage crosses `auto` boundaries directly even under supervised recommend (new operatorBoundaryFor helper); codex plan execution dedups reasoning-vs-post_comment echoes. operator.definition.md asset synced. Tests: operator-actions (36 pass) incl. new auto-boundary case.
- **#5 RES_DEFAULTS** emptied (new profiles pre-grant no resources; capability-catalog.test.ts updated).
- **#29 default guardrails:** new DEFAULT_GUARDRAILS in templates.ts, applied to create-project path + seed stub projects (were guardrails:[] — anti-noise features were dead on every real project).
- **#17 seed hygiene:** seedStubTasks writes real DEP-31 (completion packet) + BIL-9 (transition request) into their stub projects so cross-project notifications navigate for real; stub projects now deploy base agents. Seed tests updated (tasks 10→12, events 32→36).
- **#1/#30 lease:** re-examined — single-process synchronous better-sqlite3 makes the inflight-check→row-insert path atomic (no await between); live-verified. No lock needed.

## In flight (background jobs — awaiting completion)
- **Wave 2** (3 agents): #2 surface autoInvokeOperator failures, #4 notif-pref filtering + #6 runtime quality notifications, #9 delete scheduleOperatorRun (→ real operator), #20 drop dead email/nudge schema · #7 skills/KB disk-truth + #11 MCP tool discovery + #12 user disable UI + #13 credential rotate/clear · #37 create-profile caps defaults + #28 empty-definition placeholder + #27 fallback stage.
- **Delivery reconciliation (#31):** reconcileWorkspaceDelivery — capture agent-side branch/PR into task.md after specialist runs.

## LIVE VERIFICATION (2026-07-11, fresh seed + real backends)
All green. Full suite **1010 tests pass**, typecheck clean.
- **#31 delivery reconciliation (P0):** ✅ AA-1 — Codex Developer opened real PR #10 + branch AA-1; task.md frontmatter now carries `branch: AA-1` + `pr: {number:10, state:open}` (was null pre-fix). Verified for the OPERATOR-driven path (the one that matters).
- **#35 skills isolation:** ✅ `skills: []` + `settingSources: []` — a fresh operator introspection reports its system prompt contains ONLY `viberr-app-expertise` (+ architecture-notes KB); "deep-research / dataviz / blog: none appear anywhere in my context." (settingSources alone did NOT filter plugin skills — `skills: []` was the missing piece.)
- **#34 operator confinement:** ✅ operator run init envelope has Bash/Edit/Write denied (`Bash in tools == False`).
- **#32 session export:** ✅ `GET /resources/session-export?run=<real claude run>` → 200 (was 404).
- **operator one-entry-per-turn (E/#15):** ✅ impl-stage timeline shows distinct real actions (deploy → transition → prompt), no duplicate plan comments; definition further tightened so a tool-written entry counts as the narration.
- **#24 auto-boundary:** ✅ operator crossed Ready→In Progress itself under supervised (assigned Developer + moved) instead of stalling on a recommendation.
- **#4 notification filtering:** ✅ after setting approvals=off, the operator's later "Move to Review" recommendation created NO notification (only the pre-toggle one exists).
- **#17 stub tasks:** ✅ DEP-31 renders as a real task with its completion packet.
- **#7 disk-truth skills:** ✅ org resources lists all 8 disk skills incl. developer/reviewer/tester/viberr-app-expertise; no domain-advisor.
- **#29 guardrails + Advisor removal:** ✅ new project ships all 5 guardrails, deploys operator/developer/reviewer/tester only; Agents page shows 4 profiles, no Advisor.

## Adversarial self-review (4 dimensions × find→verify) — 7 confirmed bugs, ALL FIXED
Ran a multi-agent review of the phase-4 diff; every finding was independently verify-passed, then fixed with a regression test. Final: **1015 tests pass, typecheck clean.**
1. **BUG — workspace-delivery PR-state ping-pong:** used gh's raw `open` vs canonical `review` → clobbered server-set state + duplicate events every reconcile. Fixed: `mapGhStateToCache` (OPEN→review). Tests: no-ping-pong + heal-once.
2. **BUG — workspace-delivery commit-cache wipe:** commit `git log` gated on `effectiveBranch` (fm.branch fallback) not `validBranch`, so a clone left on the default branch overwrote real cached commits with `[]`. Fixed: gate on `validBranch`. Test: default-branch no-wipe.
3. **BUG — path traversal via `disk:` ids:** `diskNameFromId` returned unsanitized names → `disk:../../etc` could escape the store on delete/rename. Fixed: reject separators/dot-segments. Test: 4 evil ids rejected.
4. **correctness — `normalizeEscapedNewlines` mangled Windows paths:** single `\n` in `C:\node` converted to a newline. Fixed: 2+ runs always convert; a single `\n` converts only when NOT followed by a word char. Tests: `\node`/`\network` preserved, `\n\n` still converts.
5. **correctness — BIL-9 seed notification promised a "Ready→In Progress" gate** absent from billing-service's lightweight stages. Fixed: "To do → In progress" (verified live).
6. **quality — stale MCP tools_count** when a server is edited stdio→HTTP. Fixed: HTTP update clears the count.
7. **quality — `seed --reset` non-pristine:** seeded notifications routed through the live pref filter. Fixed: `bypassPrefs` on fixture inserts. Verified: reseed → clean, deterministic counts.

## Completeness audit (2026-07-11) — every finding accounted for
Cross-checked all 37 findings + owner decisions against the code (grep signatures + behavioral
verification). Result: **every item is implemented or is a documented, honest decision — nothing
silently dropped or deferred.**
- Findings #1–#37: implemented (code signature present) and, for the behavioral ones, live-verified
  in the 22-task test-harbor sweep (see test-sweep-results.md).
- #33 (codex tool-confinement): a genuine SDK limitation — the Codex SDK ignores allowed/disallowed
  tools — AND explicitly deprioritized ("don't focus on security"). Documented, not fixed by design.
- #18 (seed connection shows "not validated"): KEPT as honest behavior. The seeded connection holds a
  placeholder token that genuinely can't be validated; faking a "validated" pill would mislead an
  admin into thinking real GitHub calls will work. Correct as-is.
- One NEW issue found during the sweep and fixed: the board silently hid unstaged/malformed tasks (a
  corner the #27 fix opened) → now an "unstaged task" banner surfaces them. Board filters test green.

Final gates: **1015 tests pass, typecheck clean, seed pristine.** 8 bugs found by adversarial review +
1 by the sweep, all fixed with regression tests.

## Known residual (security — user-deprioritized)
- The CLI's raw init envelope still lists 34 slash-commands / host subagent types, but the MODEL'S CONTEXT is clean (skills:[] hides them from the model's listing per SDK docs — "context filter, not a sandbox"). Files remain reachable via Read/Bash for a determined run; the operator has Bash denied anyway. Codex specialists inherit the machine env + their own bundled skills (codex SDK ignores these options) — accepted, side-project scope.

## Must-do in consolidation (discovered during parallel work) — DONE
- **Delivery reconciliation for the OPERATOR path.** The delivery agent wired reconcileWorkspaceDelivery into startSpecialistRun/startReviewerRun's default reply hook, but operatorPromptAgent (task-actions.server.ts) re-registers its OWN completion callback (last-writer-wins), so operator-driven specialist runs (the main flow, e.g. ATL-3) won't reconcile. → In operatorPromptAgent's registerRunCompletion hook, also call reconcileWorkspaceDelivery (best-effort) after postAgentReplyComment. Requires editing task-actions.server.ts AFTER wave 2 lands.
- **3 tsc errors flagged** (verify/fix): resources.server.ts (wave-2 B, likely mid-edit), claude-runtime.server.test.ts (my isolation test — check the type of the captured options), demo-data.server.ts (my Advisor removal — check for a now-unused import or type).

## Consolidation checklist (after all jobs land)
1. `npm run typecheck` → fix cross-cutting type breaks.
2. `npm test` (full vitest) → fix failures. Known to reconcile: task-detail-route.server.test.ts 2 tests from #9 scheduleOperatorRun removal (setOwner now runs real operator).
3. Delete atlas-api + fstore-probe test dirs; wipe stale generated data/ agent+skill+project files; `npm run seed -- --reset` → pristine canonical store from corrected code; `npm run rescan`.
4. Restart dev server; confirm `/resources/health` backends real.
5. Live-verify each fix in the browser + via API:
   - Advisor gone from Agents/Policy/org-settings; only 4 specialist profiles.
   - New project ships DEFAULT_GUARDRAILS (Policy → guardrails on).
   - DEP-31 / BIL-9 notifications navigate to real tasks.
   - Operator run: ONE comment per turn; ready-stage auto-advances (assign + move) instead of stalling; codex operator no duplicate comments.
   - Run init envelope: settingSources isolation (no user skills), operator denied Bash/Edit/Write, MCP `everything` connects (status connected, not failed).
   - Session export returns a transcript for a real run (not 404).
   - Notification prefs actually filter; runtime quality notification appears on a reviewer request-changes.
   - Agent-side PR reconciled into task.md branch/pr.
   - RBAC unchanged (viewer can't create, non-member comment labeled, boundary gating) — regression check.
6. `/code-review` on the diff; address findings.
