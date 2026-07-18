# Pass-8 MASTER STATUS & implementation-readiness (2026-07-18)

Single consolidated index over the 17 pass-8 discovery/verification docs in this folder. Purpose: one
prioritized, actionable view of what's DONE (with evidence) and what's OPEN, for the implementation
phase + the external (gpt-5.6) code review. Branch `pass8-decision-counts-rbac-divergence-2026-07-18`
= **PR #36**, 29 commits. Suite: 1317 unit / 132 files green · typecheck clean · 13 e2e green.

## HOW WE GOT HERE (phase status)
- **Discovery + docs**: DONE (this folder; `code-map`, `product-canon-digest`, `rbac-audit`,
  `decision-count-trace`, `findings`, `owner-rulings`, `test-catalog`, + `fresh-discovery-2026-07-18`
  = a fresh critical walk of all 13 surfaces).
- **20+ live test cases on the viberr repo**: DONE across prior sessions — 20 VIB tasks (VIB-1…22) +
  **50 PRs** on akin-ozer/viberr (mix of merged small-file deliveries and rejected probes), per
  `test-catalog` / `phase2-test-log`. Re-validated live this session (VIB-22 end-to-end delivery+reject).
- **Implementation**: IN PROGRESS on PR #36 — every owner ruling + finding below is implemented.

## DONE THIS PASS (implemented + verified) — evidence in the named doc
1. **W1 member-scoped decision counts** (`decisions.server.ts` + 6 adoption sites). Live-verified
   cross-role (contributor 1 vs maintainer 15). — `implementation-plan`, `cross-role-ui-walkthrough`.
2. **W2/W3 RBAC + capability honesty** (total Policy table, app-wide view/comment rows, read-only
   Style-Reviewer affordance, reconcile-github→maintainer+, archived credential freeze). — Policy page.
3. **W4 GitHub↔task divergence** — typed "Divergence:" event + notify on out-of-band merge/close of a
   non-terminal task; no auto-advance; idempotent. Live-verified (PR #50 rejected → event). —
   `live-delivery-w4-verification`.
4. **Adversarial-review defects A–D** (owner over-count, override drop, review-queue mis-scope +
   "agent working" mislabel, stale docs) — fixed + independently re-verified + live cross-role. —
   `diff-adversarial-review`.
5. **MED-1 reply-recovery crash-loop cap**; **LOW-1 rejected** (false positive). — `critical-audit-2`.
6. **run-agents authority centralization** (`requireRunAgents`/`canRunAgents`). — `implementation-plan`.
7. **SKILL LEAK fix** (docker-verified real-in-prod): `BASE_DENIED_BUILTINS=["Skill"]` denies the
   SDK-bundled Skill tool on every run. — `agent-runtime-verification`.
8. **Runtime re-verification from real artifacts**: operator agent-selection correct; docs-style skill
   loaded+applied (36-run marker) + isolated (0 codex); notes MCP worked; Codex/Claude parity. —
   `agent-runtime-verification`.

## OPEN ITEMS (prioritized) — the actual implementation-phase backlog
All were MINOR/polish; the core product is mature and wired (fresh-discovery verdict: no mocks found).
**RESOLVED 2026-07-18 (owner: "close everything P1+P2, but first check the tools make sense"):**

### P1 — DONE
- **[RUNTIME] Async subagent-task family leaked past the singular `Task` deny → FIXED + live-verified
  in docker (2026-07-18).** The fresh 20-task suite re-run in the **production container** surfaced
  `TaskCreate/TaskGet/TaskList/TaskOutput/TaskStop/TaskUpdate` still present in a real operator init
  (under `bypassPermissions` these can spawn an unrestricted subagent → bypass). Added the whole
  family to `BASE_DENIED_BUILTINS`; a fresh `up --build` operator run dropped 25→19 tools, family
  gone, ToolSearch + `mcp__viberr__*` intact. Also confirmed there: **Codex executes** once
  `auth.json` is placed in `codex-home` (the earlier "codex-fails-at-exec" was the honest
  availability-gate, not a bug). See `fresh-20-task-suite-docker-2026-07-18.md`.
- **[RUNTIME] Residual SDK-bundled-tool leak → FIXED (commit 775c10b), selectively.** Owner's caution
  paid off: `ToolSearch` is NOT inert — **137 real calls** load the operator's deferred `mcp__viberr__*`
  governance tools; denying it would break the operator, so it is KEPT. Denied the rest (`Task`,
  `Workflow`, `Cron*`, `ScheduleWakeup`, `RemoteTrigger`, `Monitor`, `Push/SendMessage`, `DesignSync`,
  `Enter/ExitWorktree`) — 0-use, Claude-only (no Codex analog → parity), and bypass concerns viberr
  owns. Coding/web/mcp tools kept. Docker-verified: operator keeps ToolSearch + loads mcp__viberr__* +
  runs clean; denied tools gone. Codex needs no change. See `plan-bundled-tool-isolation.md`.
  (Cron / "scheduled action on a not-yet-Done task": correct form is a future governed
  `mcp__viberr__schedule_*` capability that works for both backends — noted, not built.)
- **[MCP] Stale MCP health shows fresh-green → FIXED (commit after 775c10b).** The health MODEL was
  already sound (real stdio spawn+handshake, on-demand retest, staleness timestamp); the only issue was
  an `up` dot for an hours-old check over-implying "healthy now". Now: a >1h-old check renders AMBER
  ("stale, retest"). Live-verified on the dev notes-fixture (12h → amber). *(The notes-fixture itself
  pointing at a temp scratchpad is DEV TEST DATA, not a product bug — a fresh seed has 0 MCPs.)*

### P2 — NON-ISSUES (verified) + one owner product-question
- **[GITHUB] PAT expiry → NON-ISSUE.** The app ALREADY fetches expiry from GitHub's
  `github-authentication-token-expiration` header (`github-client.server.ts`), stores it
  (`pat-validator`), and renders it (`connections-panel.tsx:235`). "expires —" is the honest display for
  a classic no-expiry PAT / unknown. No change needed.
- **[NOTIFS] Superseded recommendation notifications → NON-ISSUE at the notification level.**
  `notifications.server.ts` ALREADY reconciles against live state via `decisionsRequiring` — a
  resolved/applied/Done decision drops out of "Waiting on you" (F7-NOTIF1). VIB-22's "Move to Review"
  rec is genuinely STILL PENDING (never applied/dismissed), so its notification is correct.
  → **OWNER DECISION 2026-07-18: divergence dismisses the moot rec → IMPLEMENTED.** `reconcileTask`
  now withdraws pending `transition` recs on any divergence, and `accept_completion` recs on a CLOSED
  (not merged) divergence; assign_/run_ recs and (on a merge) accept_completion survive. The divergence
  event names the withdrawn rec. +2 tests; live-verified (VIB-22 "Move to Review" card withdrawn on
  reconcile after PR #50 closed). Stage still never auto-advances.

### Considered & DECLINED (not deferrals — documented rationale)
- rbac-audit §5 #4/#5 owner-predicate / run-agents helper folding — already single-sourced; folding
  would conflate distinct rules. — `implementation-plan` final status.
- W5 codex failure-label refinement — the generic label is the honest fallback under codex redaction.

## STALE NOTES TO RETIRE
- `operator-runtime-gaps` (2026-07-09) original claim "GitHub delivery is dead code / operator
  generates no packets" — decisively false now (live PRs + live packets/recs). The memory is already
  annotated as fixed; the index line is the only stale surface.

## VERDICT
PR #36 implements every owner ruling (R8-1…R8-7), every finding (D1–D5, F7-*, A–D), the critical-audit
MED-1, and the docker-verified skill-leak. Remaining backlog = 2 P1 polish items + 2 P2 cosmetics. The
app is implementation-ready; the logic is tested across the whole app (unit + e2e + live + cross-role +
docker-standalone). Ready for the external review / merge decision, with the P1 items as the clear
next implementation targets if pursued.
