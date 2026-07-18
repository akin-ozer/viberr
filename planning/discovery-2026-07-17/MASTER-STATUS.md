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
All are MINOR/polish; the core product is mature and wired (fresh-discovery verdict: no mocks found).

### P1 — worth doing
- **[RUNTIME] Residual SDK-bundled-tool leak.** Same SDK-binary channel that leaked `Skill` also
  exposes `CronCreate/Delete/List`, `Monitor`, `RemoteTrigger`, `ScheduleWakeup`, `Workflow`,
  `Task`(→subagents), `ToolSearch`, `DesignSync`, `Enter/ExitWorktree`, `PushNotification`,
  `SendMessage` in every run. Inert (0 uses observed) but not isolated. Fix: extend
  `BASE_DENIED_BUILTINS` with the clearly-unneeded orchestration tools (keep Bash/Read/Write/Edit/
  Grep/Glob/WebFetch/WebSearch/mcp__*), verify in the container. *(Owner deferred once in favor of the
  discovery pass — pick back up on request.)* — `agent-runtime-verification` §residual.
- **[TEST-INFRA] notes-fixture MCP is non-portable + stale-green health.** Points at a session-scoped
  `/private/tmp/…/<sid>/scratchpad/notes-mcp-server.mjs` that no longer exists, but the resources UI
  shows it GREEN ("checked 11h ago"). Fix: (a) bundle a self-contained notes MCP under the data root so
  a fresh install has a live one; (b) re-verify MCP health on the resources-page load (or render a
  stale-check badge) so a dead server never shows green. — `fresh-discovery-2026-07-18` §resources.

### P2 — cosmetic / coherence
- **[GITHUB] PAT expiry not surfaced** — connection shows "expires —"; surface the real expiry or
  "unknown". — `fresh-discovery-2026-07-18` §connections.
- **[NOTIFS] Superseded recommendation notifications not dimmed** — a "ready for review" recommendation
  notification stays as-is after the PR is rejected + a divergence fires. Dim/annotate superseded
  recommendation notifications against live packet/rec state. — `fresh-discovery-2026-07-18` §notifs.

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
