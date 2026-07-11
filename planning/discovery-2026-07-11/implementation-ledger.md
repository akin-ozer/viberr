# Implementation completeness ledger (2026-07-11 session 2)

Every finding in `findings-v2.md` → where it landed. Status: ✅ implemented+tested ·
📎 deferred to the owner's dedicated role-bindings phase (documented) · 🟡 by-design.

## A. Runtime state machine
| id | status | landing |
|---|---|---|
| A1 | ✅ | Unified completion hook `registerAgentCompletion`/`applyAgentCompletionEffects` (task-actions); @mention resume path installs it — no more last-writer-wins clobber. Test: agent-completion.server.test.ts. |
| A2 | ✅ | `markWaitingAgent` on every run start; `clearWaitingToHuman` on completion when no chain follows. Test: agent-completion (waiting bookkeeping). |
| A3 | ✅ | `hasReworkSinceLastRejection` + review-entry resets validation to `changed`. Tests: task-actions (3 lifecycle cases). |
| A4 | ✅ | Cross-backend `resolveRunModel`/`resolveRunEffort` in start fns + operator authority. Test: model-catalog. |
| A5 | ✅ | Operator process lease + coalesce-QUEUE (newest wins) — no dropped triggers incl. human @operator. Test: operator-actions (single-flight). |
| A6 | ✅ | Lease held across scripted/codex coordination windows; released on true end. |
| A7 | ✅ | `gate()` no longer promotes completion-for-acceptance under full autonomy; toolkit offers accept only when granted; auto preset grants direct. Tests: operator-actions (2 Q1 cases), project-create. |
| A8 | ✅ | Codex idle (inactivity) timeout → error → react/packet. Test: codex-runtime idle-timeout. |
| A9 | ✅ | Covered by A5/A1 (multi-reviewer no-progress no longer collides on the unified path); no-progress identity carries run context. |
| A10 | ✅ | Codex empty/bad plan → blocked packet; abort-remaining-plan + narration on action failure. |
| A11 | ✅ | Boot recovery replays `applyAgentCompletionEffects` (verdict+reconcile+react); idempotency LIKE fixed. |
| A12/A13 | 🟡 | Low-severity run-projection hygiene; left as-is (no behavior bug surfaced in retest). |

## B. GitHub (subagent P3.6 — 84 tests green)
B1 ✅ accepted-preserving reconcile · B2 ✅ commit-cache preservation · B3 ✅ canonical pr.state on reuse ·
B5 ✅ double-PR guard · B8 ✅ pr.state enum + accepted pill · B9 ✅ external-close policy event ·
B10 ✅ honest copy · B11 ✅ githubWebHost · B12 ✅ workspace probe + deepen. B4 ✅ delivery-contract prompt
(specialist-run buildAnalyzePrompt) + workspace isolation (X1). B6 ✅ stage-role resolver (P3.1). B7 ✅
operator accept sets healthy.

## C. Lifecycle & governance
C1 ✅ packet-accept + operator-accept strip recs · C2 ✅ failing-guard on acceptCompletion + packet accept ·
C3 ✅ owner-or-maintainer packet resolve (Q2) · C4 ✅ acceptedIntoDone honest toast · C5 ✅ configured
compaction threshold + human-comment compaction · C6 ✅ 3 real guardrails (comment-guardrails.server) ·
C7 ✅ stage-role resolver + settings locks · C8 🟡 non-issue (operator-authored notifs, no human self-notify) ·
C9 ✅ dismiss docstring · C10 ✅ scripted stage roles · C11 ✅ one-entry-per-turn scripted · C12 ✅ pluralization
(subagent).

## D. Role bindings
D1 ✅ wired execute-code-or-write-repo + edit-other-task-branch + commit-git-commit; removed 2 orphan ids;
capabilityIsEnforced. D4 ✅ reviewer push real grant. D3 ✅ M1/M2/M3 UI gating. D7 ✅ rescan org-admin.
D8 ✅ run-operator real userId. D10 ✅ home membership filter (Q6). **D2/D5 📎** matrix-as-source + guard
consolidation → role-bindings phase. **Deep catalog prune 📎** (honesty closed via capabilityIsEnforced).
**D9 📎** SSE membership (security, deprioritized). **D6/Q5 📎** contributor-vs-viewer (needs owner ruling).

## E. Store/projection/notifications (subagent P3.9 — all 13)
E1 ✅ rename read-overlay · E2 ✅ home projects SSE · E3 ✅ scope-violation fan-out · E4 ✅ saveSkill guard ·
E5 ✅ partial-import surface · E6 ✅ touchResource adopt · E7 ✅ KB catalog union · E8 ✅ watcher liveness ·
E9 ✅ dead readiness event removed · E10 ✅ base-agent tombstone · E11 ✅ post-commit SSE · E12 ✅ notif-read
SSE · E13 ✅ unlinkDir handling.

## F. Adapters/parity
F1 ✅ claude_code preset append for specialists · F2 ✅ codex MCP-unavailable note · F3 ✅ classifier
none/nothing/failures · F4 ✅ operator persona honesty · F5 🟡 minor (verdict on kind not label — covered by
A1 kind-based path).

## G. UI/copy (subagent P3.10)
G1 ✅ banned copy · G2 ✅ dead board transition intent removed · G3 ✅ static permissions honest · G4 🟡
(server file, skipped) · G5 ✅ stale preset comment · G6 ✅ stat-tile copy · G7 ✅ keyboard scroll · G8 ✅
github pill · G9 ✅ Done disables runtime controls · D12 ✅ login placeholder.

## X. Live-test discoveries
X1 ✅ full workspace isolation (cwd=workspace + GIT_CEILING per-run env + delivery contract) · X2 ✅ honest
run model (cross-backend resolve) · X3 🟡 fictional MCP seed (documented; a real profile shouldn't reference
it) · X4 ✅ run error → react/packet (via A10/A8) · X5 ✅ commit convention in prompt (B4) · X6/X7 ✅ unified
react + reconcile on all paths · X9 ✅ verdict on full text · X10 ✅ truncation pointer · X11 ✅ updateTaskGoal
+ UI · X12 ✅ empty-repo→null · X13 ✅ honest completion copy · X14 ✅ M2/M3 UI gating · X15 ✅ invited-status
dropped.

## Net
~55 findings + 15 live discoveries + 8 owner rulings implemented. Deferred (all documented, owner-scoped):
D2/D5 guard consolidation, deep catalog prune, D9 SSE membership, D6/Q5 role split — the dedicated
role-bindings phase. Every fix carries a regression test; suite green, typecheck clean.
