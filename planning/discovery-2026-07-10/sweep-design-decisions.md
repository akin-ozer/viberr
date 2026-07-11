# Product-design decisions from the hands-on sweep (2026-07-11, owner via AskUserQuestion)

Four new product-judgment calls surfaced by actually running 22 tasks across the app. Owner decided;
implementing all four with validation.

## D1 — Merge Tester into Reviewer (like Advisor→Operator)
Tester and Reviewer overlapped (both "validate work" — run suites, post verdict, comment). Collapse to
ONE quality specialist **Reviewer** that reviews the diff AND authors/runs tests, giving a single
verdict. Roster becomes **Operator + Developer + Reviewer**. Remove the tester profile, definition,
tester-expertise skill references from deployments; fold test-authoring capabilities into Reviewer.

## D2 — Auto-advance the pre-work boundary only
`triage → ready` becomes **`auto`** (operator advances once scope is clear). `impl → review` stays
**`approval`** (human gate before code enters review). `review → done` stays **`human`/locked**.
Applies to GOVERNED_TEMPLATE (the 5-stage default) + every project built from it. Lightweight template's
`todo → doing` is already `auto`.

## D3 — Accept completion: never claim a merge that didn't happen
When a human accepts completion but the real GitHub merge can't run (no PAT / not mergeable), record the
PR as **"accepted, merge pending"** (a distinct state), NOT a false `merged`. Surface a clear note.
A real successful merge still flips to `merged`. Keeps task↔GitHub truth honest (NFR15).

## D4 — One-click "retry on the other backend"
On a backend availability/quota error (e.g. Codex quota hit), surface an affordance to re-run the same
specialist on the OTHER backend (Claude↔Codex) instead of stalling. Human-in-the-loop (one click), not
silent auto-failover. The operator also gets this as a recovery option.

---

## Implementation + verification (2026-07-11) — all four DONE
Full suite **1019 tests pass**, typecheck clean, seed pristine.

- **D1 verified live:** Agents page shows **3 profiles** (Operator, Developer, Reviewer); Reviewer is
  "Review & validation" and does both. Tester profile/definition/skill deleted; `classifyRole` folds
  test/valid/qa → reviewer; reviewer's simulated report + skill now cover testing. Seed counts
  `agentProfiles: 3`. 10 test files updated by subagent (122 green).
- **D2 verified live:** Policy page shows "Triage → Ready · Auto-advance"; a fresh well-scoped task
  (VIB-169) was auto-advanced by the operator straight to In Progress with zero human approval clicks
  for the pre-work boundaries. Operator definition gates on scope (vague → packet, not auto-advance).
  impl→review stays approval; review→done stays human/locked. Governance + operator-actions tests
  updated.
- **D3 verified live:** accepting VIB-142 → Done, but the PR is recorded **"accepted"** (pill
  "accepted · merge pending"), and the completion event reads "the review PR is **accepted, merge
  pending** (no reachable GitHub merge)" — never a false "merged". New `PrCacheState "accepted"` +
  pill. All three accept paths (packet-resolve, applyRecommendation, operator full-autonomy) fixed to
  attempt the real merge and only claim "merged" when it truly happened.
- **D4 done (unit-verified):** run projection flags a backend-availability/quota failure
  (`failedBackendUnavailable` + `altBackend`) from the error log tail; the Agent-logs panel shows a
  "Retry on <other backend>" button that re-runs the specialist with a `backend` override
  (`startSpecialistRun`/`startReviewerRun` gained `backendOverride`). Genuine task failures are NOT
  flagged. (A live codex-quota error can't be forced on demand; covered by 3 new projection tests +
  the pill test.)
