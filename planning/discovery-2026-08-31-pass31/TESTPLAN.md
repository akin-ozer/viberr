# Pass 31 — Test cases to build (draft during discovery; finalize with updated knowledge)

Target: new automated tests delivered via PR(s) on akin-ozer/viberr (small files only).
Grounding: docs/06-testing-verification.md (harness), docs/01..05 (behavior).

## T1. Packet option coherence (from F6)
Unit: open_decision_packet rejects (or normalizes) a `discard_branch` option when the task
has an undelivered local revision AND a remote collision context (unownedPr set) — asserts
the new resolve-remote-collision verb is offered instead. Plus: PacketDiscardConfirm copy
matches actual mutation for every option kind that carries a ceremony.

## T2. Delivery stats provenance (from F1)
Unit on the reconciler/delivery: task frontmatter github.changed must be derived from the
delivered revision only; a remote branch with foreign commits must not leak files/add/del
into the task record or the completion-report evidence lines. Repro fixture: remote branch
same name, unrelated history; deliver local revision; assert stats == local diff.

## T3. Branch-collision path (regression lock for what works)
Integration: stale remote branch + unowned PR → policy-engine note emitted, delivery
refused non-fast-forward, operator packet raised with push_conflict evidence. (Lock the
good behavior seen live 2026-08-31.)

## T4. RBAC action-level denials
Route tests: for each ACTION_ROLES row, a session with each role hits the action's route;
assert allow/deny matrix, incl. contributor-owner acceptance exception and viewer
read+comment only. Visibility: non-member 404 body identical to bogus-slug 404.

## T5. KB grant → injection
Unit: run assembly injects granted KBs only (docs-writer: kb=[pass31-qa-conventions],
skills=[]); assert injected context contains KB doc content and NO skill bodies; assert
shared-budget omission marker surfaces when over budget (C6).

## T6. MCP mount parity claude/codex
Unit: same profile on both backends mounts same MCP list; Codex leg drops credentials
(unauthenticated mount), Claude leg gets viberr toolkit; denied tools list includes
Bash(gh pr merge:*) on both.

## T7. Sticky backend switch
Unit: recovery-packet "Retry on Claude" sets engagement pinnedBackend=claude; subsequent
dispatch resolution order backendOverride ?? pinnedBackend ?? live ?? snapshot honors it.

## T8. Operator relay fidelity (from F1b) — behavioral guard
Where feasible: relay comment assembly should not inject unverified existence claims;
at minimum lock that the directive text from a resolved packet reaches the specialist
prompt verbatim (it did — lock it).

## T9. Goal chain lifecycle
Integration: createGoal 2 links → link1 task created+active, link2 pending; on link1
accepted → link2 task created; cancel goal → pending links never start; pause holds.

## T10. Autonomous accept-into-done
Integration: full-autonomy operator with Accept-into-Done Direct closes a passing task;
refuses failing-validation; audited. Supervised operator cannot.

## T11. Concurrency cap honesty
Integration: cap=1, two dispatches → second queues (reserveRun respects admitRun), UI
count matches; raise cap → drain. (Regression on pass-26 F26 cosmetic-cap bug.)

## T12. Stale-branch display (UI) (from F1)
UI/jsdom: GitHub card with unownedPr set renders collision framing, not foreign
diff-stats-as-task-work; after remote branch deletion + Update status, stats refresh.

## T13. Notification dedupe (from UC-16 nit)
Unit: one failed specialist run produces ONE user-facing notification (short+long forms
collapse), not two rows.

## T14. Temp-password lifecycle
Route: allow-access creates account with setup-pending; login with temp forces
set-password gate; generate-new-temp replaces old (old stops working immediately).

## T15. Insights vs run truth
After N live runs: insights aggregates (cost/tokens/counts) equal sums over agent_runs
rows; generated-at honesty.

## T16. Notification routing toggles
Unit: with a category disabled in user prefs (e.g. decision packets), the corresponding
notifier skips that user while others still receive; re-enable restores. (UI persistence
verified live; routing assertion needs the unit layer.)

## T17. Scheduled trigger lifecycle
Unit/integration: schedule run-operator T+5m → schedules frontmatter entry with creator;
fire consumes the entry exactly once (claim protocol), starts run with kind scheduled
trigger; cancel-schedule removes without firing.

## T18. Stage add/remove re-wiring
Unit: add stage between review/done → chain hops review→new (human default) and new→done
inherits LOCKED acceptance boundary; remove reverses. (Verified live; lock as regression.)

## T19. Operator no-progress loop (from F11)
Unit: two consecutive operator runs whose only effect is a reworded status comment on an
otherwise-unchanged task (same stage/packet/runs/recommendations/goal) must NOT re-arm a
third react; canonical-state compare, not comment-text compare. Also: the operator prompt
must carry the firing trigger kind (create/manual/scheduled/packet-resolved/...) and a
run fired by a pending schedule is distinguishable from an ordinary react.

(more added as testing proceeds)
