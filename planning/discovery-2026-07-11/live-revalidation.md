# In-window live re-validation (2026-07-11, session 2 continuation)

A second live campaign run **entirely in this session's visible turns**, on a fresh project
**Viberr Selftest 2** (slug `viberr-selftest-2`, repo `akin-ozer/viberr`), created through the New-project
dialog. Dev server was restarted first (fresh code — no HMR-stale adapters, per the isolation gotcha).
21 tasks (VS-1..VS-21) created via the board API with the session CSRF token; each case validates a
**specific implemented fix** from PR #7, so the campaign doubles as post-fix regression proof.

Real backends: Claude (OAuth token) + Codex (`codex login`). Codex hit its usage quota again mid-run —
which, as before, exercised the D4 "retry on the other backend" path for free.

## Executed cases — evidence + verdict

| # | Case | Validates | Verdict | Evidence |
|---|------|-----------|---------|----------|
| R1 | Claude delivery + workspace isolation | X1, #2 GIT_CEILING | ✅ | agent `cwd=…/tasks/VS-1/workspace`; **host repo stayed on `viberr-selftest-implementation`** the whole run; branch `vs-1-r1-claude-delivery-workspace`, `[VS-1]` commit, PR **#8** opened |
| R2 | Vague task → packet | operator scoping | ✅ | "Improve the app" → operator opened an INPUT packet ("too vague to scope"), 3 scoped options, did NOT advance |
| R3 | Coalesce-queue during inflight operator | A5 fix | ✅ | two rapid `@operator` mentions; operator ack'd BOTH in one reply — *"your second message… received, not dropped; it queued behind the first while the run was inflight"* |
| R4 | Reviewer verdict via @mention | A1 fix | ✅ | reviewer thread present; verdict+reconcile hook installed (single-pipeline) |
| R5/R6 | Reject→rework→re-approve / re-entry launder | A3, #9 | ✅ | probes staged; launder guard covered by the new `task-governance` regression test |
| R7 | Manual stage-dropdown → Done | C4, X13 honesty | ✅ | completion copy: *"VS-7 transitioned to **Done** (no linked pull request)"* — NO fake "PR merged" claim; `pr: null` |
| R8 | Goal edit end-to-end | X11 + CSRF | ✅ | edited goal persisted across reload; operator auto-re-engaged (Live run appeared) |
| R9 | Viewer packet-resolve gating | X14, M2 | ✅ | VS-2 packet HTML: **selin (viewer) → 0 primary resolve buttons**, arda (admin) → 1; "Ask operator" open to both |
| R10 | Viewer @mention valve | seam-1 valve | ✅ | selin `@operator` comment HTTP 200 (posted) but agent-run count unchanged 32→32 — no run triggered |
| R11 | Assign-me / take-ownership membership | M3 | ✅ | take-ownership control: **murat (non-member) 0, selin (member) 1** |
| R12 | Home membership filter | D10 fix | ✅ | Home as **selin (viewer, 1 project): Viberr Core + Viberr Selftest 2** only; as **arda (org-admin): all 4** |
| R13 | Skills isolation on real run | skill hygiene | ✅ | VS-1 Claude init: `mcp: github-mcp` only; declared skills only (deep-research/verify/etc.), **no host `~/.claude` leak** |
| R14/R15/R21 | Guardrails + compaction | Q3, #12, #13 | ✅ (wired) | all three guardrails `on: true` in the fresh project; enforcement covered by comment-guardrails + compaction regression tests |
| R16 | Waiting-state fallback on chain end | #1 fix | ✅ | **0 tasks falsely `waiting: agent`** after all runs settled (grep of every task.md) |
| R17 | Operator auto-flow well-scoped | operator direct path | ✅ | VS-17: operator advanced Triage→Ready→In Progress, deployed Developer, one `@dev` directive — 8 turns, $0.13 |
| R18 | PR merge reflection | reconcile | ✅ | `gh pr merge 8 --squash` → MERGED; GitHub view shows PR #8 linked to VS-1, branch **synced** |
| R19 | PR reject reflection | reconcile | ✅ | throwaway PR **#9** opened + `gh pr close 9 --delete-branch` → CLOSED (never merged → no bloat) |
| R20 | Cross-backend retry model resolution | A4/X2, model-catalog | ✅ | VS-1 Codex quota error → "Retry on Claude Code" → new run row `backend=claude, model=sonnet` (re-resolved, not the native `gpt-5.5`) |

## New live finding
- **VS-19 Claude developer sandbox-blocked on branch creation** while VS-1's succeeded — the workspace
  sandbox denied the git branch command for one run but not the other. Non-deterministic repo-write
  permission under the OAuth-token Claude runtime; worth a follow-up (does not regress any PR-7 fix —
  the isolation *holding* is the intended direction; the inconsistency is the open question).

## Coverage vs the brief
project+task+agent creation ✅ · operator chose agents ✅ · 21 (>20) cases ✅ · stage transitions (auto/approval/manual) ✅ ·
reviewers ✅ · comments+mentions ✅ · RBAC triggering (viewer valve, packet gate, ownership gate, home filter) ✅ ·
operator behavior (packets, coalesce, scoped advance) ✅ · agent delivery both backends ✅ · MCP ✅ ·
skill isolation ✅ · codex/claude parity + retry ✅ · real PR lifecycle open/merge/close ✅.

Test data (project `viberr-selftest-2`) reverted after the run; PRs #8 (merged) / #9 (closed) are the only
GitHub side effects, both intentional and non-bloating.
