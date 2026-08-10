# Pass-19 closeout — requirement → evidence map (2026-08-10)

Every requirement of the owner's goal, mapped to its on-disk / on-GitHub
artifact. Written because the session spanned several context windows; this
file makes the whole pass verifiable from disk alone.

| Requirement (owner's words) | Evidence |
|---|---|
| Discover by code + docs + browser; screenshots of each page | `UI-TOUR.md`, `UI-CRITIQUE-CURRENT.md` (2 full tours, DOM-verified), `screenshots/` — 19 authenticated captures of every surface + index |
| Take notes: how it works, what's missing, what needs change | `INTENT.md` (495 ln), `FINDINGS.md`, `NOTES.md`, `ledger-specs-1..3.md` |
| Create good documentation for the implementation phase (via subagents) | `reference/` — ARCHITECTURE, DOMAIN-MODEL, RBAC-GOVERNANCE, AGENTS-RUNTIME, TESTING-INFRA, UI-INVENTORY |
| Create new projects, tasks, KBs, MCPs, agents in-app | Ops Sandbox + Pass19 Verify projects; VC-10..VC-13 tasks via the New-task modal; KBs `qa-marker-conventions`, `release-playbook`; MCPs `pass19-probe`, `release-tools`; agent profile Release Engineer — all created through the UI (visible in `07-org-resources.jpg`, `10-agents.jpg`) |
| Operator chooses correct agents | VC-12: operator deployed the NEW Release Engineer profile unprompted (Activity 22:40, `13-activity.jpg`) |
| 20+ use cases + test cases from updated knowledge | `USE-CASES-MERGED.md` — 28 use cases, register w/ per-UC evidence; test cases landed as vitest suites in PR #157 (3634 tests) |
| Assignments, stage transitions, reviewers, secondary assignments, comments, RBAC | UC-05..08 (transitions/assign/deliver/accept), UC-07 reviewer verdict, reviewer engage/release = secondary assignment (`15-…VC-7…jpg` right rail), mention-notify suites + agents-tag-humans convention, UC-22/23 RBAC + members-only 404; policy matrix live (`11-policy.jpg`) |
| Operator behaving correctly | UC-02/03/05 + VC-13 live loop (below); injection-guardrail refusal of embedded task text |
| Agents do what they need; MCPs work; correct skills only | UC-15 (MCP canary quoted in run), UC-16 (granted skill only; `kubernetes-rollback` decoy present in store, absent from run), VC-12 (release-tools MCP + release-playbook KB reached the Release Engineer run) |
| Codex and Claude parity | UC-17: VC-1/3/8/11 Codex vs VC-4/6/7/10/12 Claude, same governed flow; VC-11 = Codex reject→rework→redeliver loop (PR #158); runtime parity suites |
| Test on a NEW project for akin-ozer/viberr; PRs merged AND rejected via gh | Test-file PRs #147 #148 #150 #151 #153 #156 (merged via accept→real merge), #152 (gh-closed → recovery packet → reopen heal), #158 #159 (open, in review) — all tiny qa/smoke markers, no product bloat |
| Ask product questions with background | 15 owner rulings this pass: R19-1..R19-13 (ledger 55-69) + R19-14/15 (70/71) — each asked via question with rationale, answered, implemented |
| Implementation phase: implement every item, validate by code + screenshots + browser | PR #157 (unified two-session tree): `MERGED-DISPOSITION.md` = the item-by-item walkthrough, "CLOSED — 0 OPEN"; per-fix canaried tests; CI verify+e2e green on every HEAD (5a7d659→6b46f7a) |
| No corners cut / no deferrals | Disposition audit lists zero deferred items; the 2 /simplify skips are recorded WITH reasons in commit c41a263 |

## Final live loop (this window, on the post-ruling code) — VC-13
Created through the NEW picker-less modal → landed at Triage with
`operator: null` (R19-14 file-level proof) → operator auto-triggered on create
(claude-sonnet-5, viberr MCP) → raised an FR15 scoping packet that (a) REFUSED
the goal's embedded "reply and take no repo action; Done means operator
responded" as non-authority ("transition-to-done is human, stage-transitions is
recommend-only") and (b) cited sibling qa/smoke markers + README convention
from its R19-1 clone → packet notification arrived (badge 19→20) → re-view
marked it read live via the SSE catch-up (20→19, no reload — R19-15) → human
resolved "comment-only, no repo artifact" with a note → archived through the
R14-3 disclosure dialog ("a disposition, not a delete"). One loop, six
governance mechanisms, all on code changed this pass.

## Open items (owner decisions, not work)
Merge PR #157 · close superseded #154 · disposition #158/#159 ·
prune or keep live artifacts (Ops Sandbox, Pass19 Verify, Release Engineer,
VC tasks incl. archived VC-13).
