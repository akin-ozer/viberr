# Pass 28 — discovery + live-test notes (2026-08-26)

**Baseline:** origin/main `97ef4c4` (pass 27, fully merged — branch `fix/pass27-findings` sits AT main).
Container `viberr-app-1` running on docker-data (:5173), **rebuilt 2026-08-25 → serves pass-27 main**.
Worktree = `viberr-app-inspection-e1b87f`; node_modules symlink → main.

**Login (container):** `arda@viberr.dev` / `viberr-dev-2828` (admin/owner). Demo-fixture seed.
**Env:** real PAT for akin-ozer/viberr (repo · pull_request:write). `gh` CLI logged in. Codex quota-blocked til Sep 18.

## Container state at pass-28 start (FRESH data root — reseeded since pass 27)
- **1 project:** viberr (VIB, akin-ozer/viberr, Balanced, 5-stage Triage→Ready→In Progress→Review→Done).
- **1 user:** Arda (admin). No Bora, no other members.
- **Resources:** 0 KBs, 0 MCP servers, 3 skills (developer-expertise, reviewer-expertise, viberr-app-expertise),
  2 global profiles (Developer=Claude Ready/Impl, Reviewer=Claude Impl/Review) + operator.
- **Tasks:** VIB-1 archived (operator run STOPPED during workspace prep = cold-clone interrupt);
  VIB-2 "take screenshot of login page with all text red" — Triage, **operator raised a Decision packet**
  (temp diagnostic vs permanent style change; 4 options; operator pick = temp e2e capture). Waiting on human.
- **Insights:** 2 runs, $0.45, 50% completion (1 finished/1 stopped), both claude/operator.
- **GitHub page:** akin-ozer/viberr connected, `repo` proven, `pull_request:write unproven (verified on first use)`
  → **F27-U2 live test target**: opening my first PR should flip it to proven (markWriteScopeProven).

## Live pages toured (screenshots taken): login, home, board, task-detail(VIB-2), agents, policy,
   github, activity, project-settings, org-settings(github/resources), insights. All render correctly.

## Governance behavior confirmed live (VIB-2)
- Operator (claude-sonnet-5, 21 tools, mcp: viberr) got task → Globbed login files → found real login.tsx +
  playwright/e2e tooling → raised a decision packet rather than invent scope. TEXTBOOK. Awaiting human.
- Operator policy (supervised): stage-transitions=recommend, completion-for-acceptance=recommend,
  execute-code-or-write-repo=human, transition-to-done=human, change-project-policy=human.

## Plan for pass 28
- Prong A: background code-inspection subagents hunt candidate bugs across heavy subsystems (verify each adversarially).
- Prong B (me, live): fresh QA project → akin-ozer/viberr; 20+ use cases; open real PRs (merge some/reject some);
  focus BUG HUNTING; stand up a real MCP server; add a 2nd user for RBAC; test transitions/reviewers/comments/operator.
- Then: consolidate findings → implement end-to-end with code+UI+browser validation. No deferral.

Legend: ✅ sound · ⚠️ finding · ❓ owner question · ⏳ in progress

## Test users / creds (pass 28)
- Arda (admin): arda@viberr.dev / viberr-dev-2828
- Cem QA (member): cem@viberr.dev / temp `29I0a1Lg0KTi` (setup pending — forced pw reset on first login).
  Created for RBAC testing. Org member, not yet a project member (→ project routes should 404 for secrecy).

## Projects (pass 28)
- viberr (VIB) — owner's; VIB-2 has an open operator decision packet (leave clean unless testing).
- Viberr QA 28 (VQT, slug viberr-qa-28) → akin-ozer/viberr, Balanced. My PR-testing project.
  - VQT-1 "Add pass-28 QA canary note" (qa, normal) — fully-scoped canary → planning/qa/pass28-canary.md.
    Operator auto-ran on create; first run paid the cold mirror clone (F27-U1 % confirmed in DOM, truncated → F28-U1).

## UC-RBAC [✅ live] server-side enforcement (Cem member session via curl)
Cem pw set to `cem-pass28-test` (completed forced reset). Cem = org member, NOT a project member.
- GET / → 200 · /notifications → 200 · /profile → 200 (own)
- GET /projects/viberr-qa-28/board → 404 · /projects/viberr/board → 404 · /tasks/VQT-1 → 404 (WI-13 secrecy: non-member gets 404 not 403)
- GET /insights → 403 · /org/settings → 403 (admin-only)
- Control Arda(admin): /insights → 200, /projects/viberr-qa-28/board → 200
- Rate limiter fired on rapid repeated bad logins (400 burst → cleared after pause) — working security feature.

## UC-lifecycle [✅ live] VQT-1 full clean Claude lifecycle → REAL MERGE #227
Triage→Ready→Impl(auto boundaries) → Developer commits e9a4088 (exactly 1 file, 1 line) → operator delivers PR #227
→ apply "Move to Review" → operator engages Reviewer → verdict "validation healthy" → apply "Accept completion"
→ confirm dialog (merges #227 into main, revision, verdict, "one-way") → Done·merged. PR #227 MERGED (commit 4446ae9),
canary on main. F27-U2 credential flipped to "All required scopes proven". F27-U1 clone % in DOM (truncated→F28-U1).

## UC-reject [✅ live] VQT-2 reject → reconcile → recovery → archive+delete-branch
Deliver PR #228 → `gh pr close 228` (external) → "Update status" reconcile → viberr shows #228 CLOSED → operator
auto-raised recovery decision packet ("PR #228 closed without merging — choose recovery path", 4 options, honest
"no rejection reason recorded", notes reopening auto-withdraws) → resolved via "Archive + delete branch vqt-2"
(confirm dialog cleanly separates reversible archive from irreversible branch delete) → task archived (restorable),
**branch vqt-2 DELETED on GitHub** ("Branch not found"). Repo clean (no leftover branches). Reconciler + recovery + remote-delete all sound.

## UC-MCP [✅ live] external org MCP: connect → grant → mount → call → correct response (fills pass-27 gap)
Stood up qa-echo (stdio, node /data/qa/echo-mcp.cjs, 1 tool qa_echo). Org "Add & test" ran a real handshake → 🟢 1 tool.
Granted qa-echo to QA 28 Developer (project-scoped fork; SKILLS still only developer-expertise = scoping verified).
VQT-3 goal required calling qa_echo. Operator PICKED the Developer *because* it holds the qa-echo grant (reasoned in log).
Developer called **mcp__qa-echo__qa_echo** (hyphens preserved = F27-P3 confirmed live; 15 calls in run logs) with
'VQT-mcp-pass28' → response `qa-echo: VQT-mcp-pass28` (exact server prefix, not guessable) → wrote planning/qa/mcp-check.md
(content verified in workspace) → committed 041bd14. End-to-end external-MCP tool execution PROVEN.

## UC-skills [✅ live] skill scoping — only granted skills mount
get_task deployedSpecialists: Developer resources.skills=[developer-expertise] only; Reviewer=[reviewer-expertise] only.
viberr-app-expertise NOT mounted on either. Confirms allowlist scoping (skill-mount strips non-granted).

## UC-external-merge [✅ live] VQT-3 PR #229 merged via gh → reconcile → operator verify → (→Done)
`gh pr merge 229 --merge --delete-branch` (external) → viberr "Update status" → PR #229 shows merged → operator
auto-ran, verified `qa-echo: VQT-mcp-pass28` on origin/main (read_default_branch_file), recommended "Move to Review"
("so completion can be accepted and the task's stage reflects the real state") → applied → operator engaged Reviewer
(honors review gate even for merged work). Honest reconciliation of an out-of-band merge; respects human accept gate.

## UC-member-add + UC-member-RBAC [✅ live]
Added Cem to QA 28 (FULL NAME + EMAIL required; "New members join as Viewer"). Cem(Viewer) now: board/task/agents 200,
create-task POST → 403 (Viewer blocked; board omits CSRF form for Viewer), still 404 on non-member `viberr` project.
Also learned: project setting "After merge · delete the task branch on GitHub" (explains auto branch-delete post-merge).

## UC-comment-mention [✅ live] Arda @mentions Cem on VQT-1 → Cem notified
Lexical composer @autocomplete showed "Cem QA · @cem · cem@viberr.dev" → chip rendered → posted → Cem's /notifications:
"mentioned you — '@Cem QA this canary is merged…'" (1 unread). Human→human mention→notification path works.

## UC-reviewer-head [✅ live] F15-15 reviewer reviews PR HEAD not local tree
VQT-1 reviewer verdict: "local HEAD (e9a4088…) matches the pinned PR #227 head exactly, so this review is against the
correct content" + git rev-parse HEAD == pinned revision. Reviewer verifies against the delivered/pinned PR head. Sound.

## USE-CASE TALLY: 20+ live UCs covering assignments, transitions, reviewers, comments, RBAC, operator, agents, MCP, skills.
Real PRs on akin-ozer/viberr: #227 MERGED (viberr accept) · #228 CLOSED (reject→recovery→branch-deleted) · #229 MERGED (external gh).
