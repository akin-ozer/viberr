# Pass 29 — Implementation record (2026-08-27)

Branch: `fix/pass29-findings` off `origin/main` @ e789ce7.
Gates after implementation: **typecheck clean · full suite 288 files / 4477 tests green · oxlint = 25 (unchanged baseline, none in changed files)**.

Six findings confirmed during the testing phase, all fixed. Four are in the user's focus area (agent browser capability).

## F2 [browser] — chromium binary pre-flight in `resolveBrowserMcp`
`app/server/tasks/specialist-browser-mcp.server.ts`
- Added an `existsSync(VIBERR_BROWSER_EXECUTABLE)` check before building the mount. A pinned-but-absent binary is now a disclosed `UnresolvedMcpGrant` refusal (same channel as a withheld egress / missing @playwright/mcp), instead of failing deep inside the run's first browser tool call.
- Tests: `specialist-browser-mcp.server.test.ts` — new refusal test + fixed the existing `--executable-path` passthrough test (it used a fake `/usr/bin/chromium` that the new check correctly refuses; now uses `process.execPath`).

## F3 — operator `accept_completion` tool-description drift
`app/server/tasks/operator-toolkit.server.ts:688`
- The full-autonomy clause claimed "the real merge is completed when GitHub is reachable" — false: `operatorAcceptCompletion` always records `prState: "accepted"` (merge pending); the operator can never merge (`mergeTaskPr` needs a human userId). Rewrote the full-autonomy clause to say so ("you do NOT merge … a human merges the accepted PR afterward; never tell anyone the PR was merged") and moved the accurate "merges when GitHub reachable" wording to the supervised (human-applied) path.

## F4 [browser] — Codex screenshot-invisibility disclosed at grant time
`app/features/agents/create-profile-modal.tsx`
- Added a `cap-mnote` on the "Drive a live web browser" row when `backend === "codex"`: "On Codex, screenshots are not returned to the model…". The asymmetry was disclosed on the capability-matrix modal + run persona but NOT where the admin actually ticks the grant. Reuses the existing `.cap-mnote` class (no new CSS).
- **Browser-validated** on the hermetic :5174 (worktree code): note renders on the Codex Developer editor's browser row, absent on Claude. Screenshot captured.

## F5 [browser] — browser-runtime health signal
`app/server/tasks/specialist-browser-mcp.server.ts` (new `browserRuntimeStatus()`) + `app/routes/resources.health.ts`
- `/resources/health` now reports `browser: { status: "ready" | "unavailable", reason? }`, backed by a helper that mirrors `resolveBrowserMcp`'s gates (CLI present + pinned executable on disk). Informational, NOT a `degraded` fault — same R17-5 stance as `backends` (a deployment that never grants the browser is correct). Makes a broken chromium visible before a run is spent, complementing F2's clean per-run refusal.
- Tests: `resources.health.test.ts` — ready + unavailable(never-degraded) cases.

## F6 [browser] — pin the load-bearing screenshot contract
`app/server/tasks/specialist-browser-mcp.server.test.ts`
- Tests pinning `browserPersonaSection`: both backends always instruct a filename-less screenshot (the whole default-name→attachments strategy) + point at the attachments dir; Codex gets the "not visible to you" note, Claude does not. Plus `browserRuntimeStatus` unit tests. (A real Playwright-MCP-child e2e belongs in the Playwright e2e suite, not vitest; these pin the contract the persona strategy depends on.)

## F7 — stale delivery-conflict packet superseded on successful delivery
`app/server/tasks/task-actions.server.ts` (new `withdrawSupersededDeliveryPacket`, called in `performDelivery`'s success path)
- After a push-conflict blocked packet, if the human clears the branch and re-delivers via the GitHub panel, the push+PR succeed but the human-owned packet ("…no PR opened") persisted, contradicting the live "PR #N · in review" panel; the operator couldn't clear it. Now a successful delivery supersedes the packet (readiness floor lifts, timeline note, audit row), scoped by the `discard_branch` option that marks the branch/delivery-conflict family — a reject-recovery packet (`archive_task`) is deliberately left alone.
- Tests: `delivery-decision.server.test.ts` — supersede-on-success + leave-reject-recovery-alone.

## Live testing that produced these (see NOTES.md / TEST-PLAN.md)
Real runs on the container (docker-data, :5173) against `akin-ozer/viberr`: browser cap end-to-end (real screenshot→attachment→evidence→member-only serving), operator agent selection, KB/MCP/skill loading (seeded token + real echo-MCP + skill fence), Claude/Codex parity + Codex-quota recovery, delivery→review→accept→**merge PR #233**, reject→recovery→**branch-deleted PR #234**, RBAC, acceptance disclosure, branch-collision, P8 isolation, R18-1 KB inheritance.

## Cleanup
- Removed the `qa-tester@viberr.dev` RBAC test user + its VQP viewer membership (docker-data).
- Left as intended test artifacts: the VQP project + VQP-1/2/3 tasks, the Web QA profile, the Pass29 KB, the qa-echo MCP, and the merged 1-line `docs/qa/pass29-codex.md` (a permitted small test file). Offered to the owner for removal.
