# Viberr full-product discovery — 2026-07-10

Working notes for the discovery pass (UI walkthrough + code map). Consolidated docs will live
alongside this file. Prior context: `planning/operator-verification-2026-07-09.md` (all items
implemented per memory), RBAC model finalized 2026-07 (2 org roles, 4 project roles).

## Open product questions for Akın

- [ ] Advisor agent: user suspects redundant with operator — investigate what "advisor" actually is in the app, then ask.

## UI walkthrough log

### Home (/)
- Greeting header, run/decision counts, Pinned vs Everything else sections, New project, grid/list toggle.
- Projects: Deploy Pipeline (DEP, stub), Viberr Core (VIB, 10 tasks), Billing Service (BIL, stub), cc-devops-skills (CCD, 9 tasks).
- OK so far.

## Findings (mocks / unwired / wrong / poor)

(running list; severity: P0 broken-promise, P1 functional gap, P2 poorly implemented, P3 cosmetic)

- **P1 — resolvePacket re-invoke silently fails (CCD-8 evidence).** Packet resolved 2026-07-09T20:28:24 with a redirect-ish option ("Choose JSON… operator re-engages specialist"); task left `waiting: agent`, `operator: null`, no specialist, and agent_runs shows NO run after 20:27:29. Code at `task-actions.server.ts:2157-2163` does `void autoInvokeOperator(...)` for request_edit/redirect/custom — either it threw and was swallowed, or no-op'd. Repro in phase 3 (test #10) and fix: don't swallow; surface failures; ensure stranded waiting:agent-with-no-run is impossible.
- **P1 — operator single-flight lease has a race (CCD-6 evidence).** Two operator runs started 20:41:07.410 and 20:41:08.494 (1.1s apart), BOTH ran, spawned 2 reviewer runs + 2 reaction runs → duplicate blocked packets + duplicate notifications in inbox. `inFlightOperatorRun` (operator-run.server.ts:93) is check-then-insert TOCTOU. Needs an atomic claim (unique index / INSERT-first).
- **P1 — duplicate packet content**: CCD-6 got two near-identical blocked packets (only latest survives in task.md; both notifications persist). Fall-out of the lease race, plus no-duplicate-summary guardrail didn't catch packet-level duplication.
- **P2 — skills have two sources of truth.** `org_skills` table (4 seed rows: conventional-commits, terraform-review, api-design, changelog-writer) drives org-settings UI; disk `data/skills/` has 9 dirs incl. the 5 the agents actually load (developer/reviewer/tester-expertise, domain-advisor, viberr-app-expertise) — invisible in org UI. buildResourceCatalog scans disk, so pickers vs org page disagree.
- **P3 — seed notifications point at phantom tasks** (DEP-31, BIL-9) → graceful "Task not found" page. Seed-data inconsistency only.
- **P3 — org GitHub connection seed row** "akin-ozer/ PAT ····0000 · not validated" — dead placeholder, harmless but looks broken.
- **P2 — RES_CATALOG fallback still live** in `create-profile-modal.tsx:683` (`resourceCatalog ?? RES_CATALOG`) + hardcoded default-resource selections in `capability-catalog.ts:207-216`. Wired path uses real catalog, but the mock constant remains reachable.
- **P3 — login OAuth buttons fake a ~900ms "Checking whitelist…" spinner** when provider unconfigured (login.tsx:303-341) — theater.
- **P3 — profile notification prefs**: email channel + nudge hours persist in schema but no UI renders them (notification-prefs.ts:23-42); only "app" toggle shown.
- **P3 — app/features/auth/ is an empty leftover dir.**
- **P2 — `scheduleOperatorRun` legacy path** (run-service.server.ts:510): quality-gate-owner-assign path always streams a SIMULATED narration even when a real backend exists (unlike main runOperator). Phase-5 stand-in still wired via setOwner.
- **P2 — dead export** `getDataRootForRuns` (run-service.server.ts:569), zero callers.
- **CCD-9 operator posted 2 comments in 2s** ("Plan:" + "Recommendation:") — operator-brevity guardrail doesn't stop plan-narration noise. Judgement call, revisit in phase 3.
- **P1 — Advisor replies can be misclassified as review verdicts.** Advisor (consultant) is engaged via the reviewer machinery (`assign_reviewer`/`startReviewerRun` → run kind "reviewer"); `recordReviewerVerdict` fires on `input.kind === "reviewer"` (task-actions.server.ts:1336), so advisory guidance containing "request changes"-like phrasing flips task `validation`. Consultants were folded into reviewers in migration 0011; the profile distinction survives only as display copy.
- **Advisor structural facts (for the product question):** operator has NO dedicated consult tool — only prompt_reviewer; zero real Advisor runs so far (all real reviewer runs used the reviewer profile); Advisor's unique caps: comment-with-guidance, flag-underspecified-tasks, read-task-repo (all also achievable by operator+packets or reviewer).

## Improvement ideas

## Test-case ideas for phase 3 (target 20+)

1. Operator picks correct specialist for a coding task (claude engine).
2. Same task shape but codex engine — parity check.
3. Task with underspecified goal → operator should flag input_required / ask for clarification, not run.
4. Stage transition gating: agent recommend vs direct mode; human approval boundary respected.
5. Human-only done: operator/specialist must never transition to done.
6. Reviewer flow: owner takes ownership, reviews, rejects → task goes back; verdict → validation state.
7. Secondary/consultant assignment: add consultant, verify it participates and timeline shows it.
8. RBAC: viewer cannot create task; contributor can. (UI + API)
9. RBAC: non-member commenting is allowed but labeled (FR4).
10. Packet flow: blocked task → operator opens decision packet → resolve → redirect re-invokes operator.
11. Skills: agent with skill X loads only skill X (check run log/system prompt), not unrelated skills.
12. KB injection: profile with KB dir gets KB docs in prompt.
13. MCP: profile with org MCP server gets mcpServers in run config.
14. Capability off/human: specialist denied push/PR bash commands.
15. Notifications: governance decision fans out to owner+admins+maintainers.
16. Watchers: commenting/watching a task subscribes to notifications?
17. Timeline compaction on long task.
18. Board rescan permission gating.
19. GitHub: branch on work start, PR on review (dead PAT — check degrade path).
20. Concurrent operator triggers coalesce (single-flight lease).
21. Malformed task file → diagnostics surface, no crash.
22. Task created via file edit directly → watcher picks it up.
