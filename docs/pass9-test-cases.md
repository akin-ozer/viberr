# Pass 9 — Phase-2 test-case suite (akin-ozer/viberr)

Dedicated enumeration of the Phase-2 use/test cases exercised across the whole app before the
implementation phase. Each case names its **dimension**, **method** (LIVE = real agents/UI/GitHub
against akin-ozer/viberr, or AUTO = automated regression), **result**, and **evidence**.

The pure-logic invariants behind the LIVE cases are pinned in `app/server/pass9-usecases.server.test.ts`
(+ the per-fix suites: `capabilities.test.ts`, `project-authority.server.test.ts`,
`project-file.schema.test.ts`, `pr-linker.server.test.ts`, `agent-reply.server.test.ts`).

Legend: ✅ pass · ⚠️ found an issue (→ fix). Full running notes: `planning/discovery-2026-07-19-pass9/TEST-LOG.md`.

| TC | Dimension | What it validates | Method | Result |
|----|-----------|-------------------|--------|--------|
| TC-01 | operator agent-selection | Operator picks a docs agent (Docs Writer, Claude) for a docs task, not the Developer | LIVE (VIB-3) | ✅ |
| TC-02 | operator agent-selection | Operator picks the Codex Developer for a code task | LIVE (VIB-4) | ✅ |
| TC-03 | operator selection breadth | Among 5 specialists, operator picks Test Author for a test-only task | LIVE (VIB-6) | ✅ |
| TC-04 | delivery (Claude) | Claude specialist creates the task branch + commits | LIVE (VIB-3 @3285bc8) | ✅ |
| TC-05 | delivery (Codex) | Codex specialist creates the task branch + commits | LIVE (VIB-4/5/6) | ✅ |
| TC-06 | GitHub PR open | Move-to-Review pushes the branch + opens a real PR on akin-ozer/viberr | LIVE (PR #71/#72) | ✅ |
| TC-07 | engagements / secondary | Operator auto-summons a reviewer; exactly one engagement `delivers:true` | LIVE (VIB-3) + AUTO | ✅ |
| TC-08 | reviewer verdict grant | report-validation-verdict resolves verdict-capable; a delivering dev cannot flip validation | AUTO (TC-08) | ✅ |
| TC-09 | verdict → gating | request_changes→failing / approve→healthy; ambiguous→null (never silently healthy) | AUTO (TC-09) + LIVE | ✅ |
| TC-10 | acceptance + merge | Human acceptance merges the review PR via the app → Done | LIVE (PR #71 merged) | ✅ |
| TC-11 | PR reject / divergence | Reject a PR via `gh` → reconcile surfaces a divergence event + notification + withdraws the accept rec | LIVE (PR #72) | ✅ |
| TC-12 | comments / @mention / resume | @mention routes to an agent; the Codex agent RESUMES its session and replies (F7) | LIVE (VIB-4) | ✅ |
| TC-13 | stage transitions (triage) | Underspecified goal is flagged at triage (stays triage, asks a human) — no auto-advance | LIVE (VIB-7) | ✅ |
| TC-14 | secondary/multiple reviewers | Two verdict-capable reviewers engaged on one task; single-deliverer invariant holds | LIVE (VIB-6) | ✅ |
| TC-15 | RBAC — Viewer | A Viewer sees no mutating actions; a forged mutating POST → 403 | LIVE (Deniz) | ✅ |
| TC-16 | RBAC — Contributor | A Contributor can create tasks but cannot rescan (middle tier) | LIVE (Deniz) | ✅ |
| TC-17 | RBAC — archived | Archived projects block agent runtime (assign/run/@mention); interrupt still allowed | AUTO (F17) | ✅ |
| TC-18 | skills loaded correctly | Only declared skills injected; the SDK Skill tool is DENIED (no unrelated skills invokable) | LIVE (run init) + code | ✅ |
| TC-19 | agent toolkit / MCP wiring | Each agent gets exactly its capability-gated toolkit (reviewer: ask_human/post_comment/report_outcome) | LIVE (run init) | ✅ |
| TC-20 | codex/claude parity | Both commit as `<profileId>@viberr.local`; repo-write caps labeled Claude-enforced/Codex-advisory honestly | LIVE (F24) + AUTO (TC-20) | ✅ |
| TC-21 | delivery capability model | A deliverer always holds the headline repo-write cap (master gate); contradictions repaired | AUTO (TC-21) + LIVE | ✅ |
| TC-22 | tolerant parse / ACL | One malformed `members[]` row drops only itself, never the whole ACL | AUTO (F18) | ✅ |
| TC-23 | delivery/github edge | A reused/force-pushed branch does NOT link a stale merged PR — opens a fresh one | AUTO (F26) + LIVE | ✅ (⚠️→fixed) |
| TC-24 | MCP server | Add an org MCP server: recorded, reachability probed honestly, credential encrypted (no plaintext) | LIVE | ✅ |
| TC-25 | auth | First login with an admin-issued temp password forces a password reset | LIVE (Deniz) | ✅ |
| TC-26 | home resource counts | Agent-resources tile counts skills/KB from the disk-union list, not the empty projection | LIVE (F5) + code | ✅ |

## Test PRs opened on akin-ozer/viberr (per the brief — small files only)
- **PR #71** `[VIB-3] CONTRIBUTING.md` — **MERGED via the app** (acceptance → real merge). Small, useful doc.
- **PR #72** `[VIB-4] scripts/env-check.ts` — **rejected via `gh` (closed unmerged)** → divergence surfaced in Viberr.
- (VIB-5/VIB-6 delivered locally; VIB-6 surfaced the F26 stale-PR-link bug, now fixed.)

## Issues found in testing → all fixed on `fix/pass9-delivery-capability-parity` (PR #73)
F14 (delivery master-gate), F24 (commit-identity parity), F7 (Codex envelope on resume), F22 (phantom
run strip), F5 (home skill count), F26 (stale PR link on branch reuse), plus F15/F10/F17/F18/F12/F13/F21.
