# Discovery Pass 9 — Findings, TODOs, Questions (2026-07-19)

Owner-authored goal: fresh critical inspection of the whole app post generic-agents merge (main @ 61adab1).
Focus: find mocks / unwired / poorly-implemented parts; heavy testing of AGENTS; then implement fixes end-to-end.

Environment: docker `viberr-app-1` on :5173, real backends (claude=OAuth, codex=CLI auth).
Live data root = `docker-data/` — project `viberr` (repo akin-ozer/viberr), tasks VIB-1, VIB-2.

Legend: `[BUG]` broken/incorrect · `[MOCK]` unwired/placeholder · `[POOR]` works but weak · `[Q]` product question for owner · `[TEST]` test case to run · `[DONE]` resolved.

---

## Findings

### F1 [BUG?] VIB-1 stuck "Review blocked — no commits" while VIB-2 succeeded
- VIB-1 (created 09:00, before container rebuild at 09:23) hit the pre-fix delivery bug:
  developer/codex run left uncommitted working-tree changes, branch VIB-1 had 0 commits ahead,
  Viberr couldn't open a PR. Operator raised a `blocked` packet.
- VIB-2 (created 09:25, after rebuild) worked — developer committed, operator recommending Review.
- Commit `0d12bb6 fix(delivery): the system commits the agent's uncommitted changes before pushing`
  is the fix. So VIB-1 is a stale pre-fix artifact, not necessarily a live bug — but worth
  confirming the fix holds under fresh runs and that the blocked task can be recovered cleanly.

### F2 [BUG/PARITY] Codex developer run declines to commit citing "workspace contract prohibits it"
- VIB-1 timeline (verified in UI): the Codex developer implemented files (scripts/list-files.ts +
  test + package.json script + README), validation passed, BUT "Delivery: no commit, push, or PR
  was created because the human-gated workspace contract explicitly prohibited it."
- Yet the `developer` profile GRANTS `commit-push-branch: direct` and `open-review-pr: direct`.
  So there is a contradiction between the capability grant and what the Codex agent believed/did.
- This is exactly the "codex and claude code work the same from viberr's eye" concern. Codex
  (running under its SDK sandbox / workspace-write?) apparently treats committing as prohibited.
  The 0d12bb6 fix ("system commits agent's uncommitted changes before pushing") papers over it by
  having VIBERR commit — but then the developer persona claiming it "commits with traceable
  messages" is misleading, and the agent's own reasoning ("prohibited") is a red flag.
- MUST TEST: fresh Codex delivery vs fresh Claude delivery — does Claude commit itself? Does the
  Viberr-side commit produce a sensible commit message/author? Is the branch clean afterward?
- Central to phase-2 testing (codex/claude parity) and likely phase-3 implementation.

### F3 [OBS] Operator packet generation is REAL (prior "no packets" gap resolved)
- VIB-1 operator (Claude opus, mcp:viberr, 16 tools) ran get_task → open_decision_packet, producing
  a structured blocked packet with 3 typed recovery options rendered as a radiogroup + Confirm/Ask.
  The earlier discovery finding "operator generates no packets" is fixed. Good.

### F4 [OBS] Task workspace UI still uses pre-generic-agents labels (deferred, per plan.md)
- Execution profile panel shows "Primary specialist" / "Reviewers (None engaged) / Add reviewer"
  rather than a unified engagements list. plan.md explicitly deferred these wire-name/label renames
  to a design-language pass. Confirm whether owner wants this done in phase 3 (Q for owner).

### F5 [BUG] Home "Agent resources" tile shows "0 skills" but 3 skills are registered
- Home page (`/`) Agent-resources settings tile reads: "0 knowledge bases · 0 MCP · 0 skills".
- Org settings → Agent resources actually lists 3 skills: developer-expertise, reviewer-expertise,
  viberr-app-expertise. KB=0 and MCP=0 are correct (none registered; the operator's `viberr` MCP
  is a built-in server, not an org resource). So the skills count on the home tile is wrong.
- Root cause likely in the home loader's resource-count aggregation. Verify in code (routes/_index).

### F6 [POOR] Review queue lists a blocked, PR-less task under "Waiting on your acceptance"
- VIB-1 is at Review but blocked with no PR. Accepting a completion "merges the review PR"; VIB-1
  has none, so acceptance would fail / degrade. The queue should distinguish "blocked — needs a
  decision" from "genuinely acceptable". Low severity but confusing.

### F7..F13 [from agent-runtime code map] — see docs/agent-runtime.md
- **F7 [POOR/PARITY] Resumed Codex agents lose the outcome envelope.** `resumeRun` never passes
  `outputSchema`, so a re-invoked (@mention) Codex reviewer falls back to the prose regex and
  `ask_human` can't fire. Fresh Codex runs get the schema. Real Claude-vs-Codex parity break.
- **F8 [POOR/PARITY] Codex tool confinement is advisory only.** `disallowedTools` binds on Claude
  only (claude-runtime.server.ts:149); a Codex specialist can ignore a withheld
  `execute-code-or-write-repo`/branch/push grant. Capability gating is not enforced on Codex.
- **F9 [POOR/PARITY] Codex MCP credentials silently dropped** (argv-exposure avoidance) — credentialed
  org MCP servers connect UNAUTHENTICATED on Codex. Claude gets them authed.
- **F10 [POOR] `classifyReviewerVerdict` regex fragility.** It's the fallback verdict source for a
  large slice of runs (verdict-granted run w/o envelope: Claude reviewer skipping `report_outcome`,
  ALL resumed Codex, all recovered runs). A clearly-rejecting prose review it misses leaves
  validation silently `healthy` → could let a rejected task be accepted. Central bug class.
- **F11 [MOCK] `simulatedFinalReport`/`buildAnalyzeScript`** fabricate a full transcript incl. a
  hardcoded "approve" verdict — gated behind the R7-2 test gate; unreachable in prod/dev unless the
  gate regresses. Confirm the gate is airtight.
- **F12 [POOR] Skill-loading caveats.** Injection path is correct (exactly `resources.skills`, no
  fuzzy match, Skill tool denied). BUT (a) SDK's ~16 bundled skills only SUPPRESSED by the tool-deny,
  not removed — deny regression re-exposes them; (b) a mistyped declared skill is SILENTLY dropped
  (no persona-visible warning). `skills-lock.json` is a red herring (dev-repo skill-sync, not runtime).
- **F13 [POOR] Swallowed errors + audit mismatch.** delivery reconcile `.catch(()=>{})`
  (task-actions.server.ts:2170), reply-comment write, toolkit handlers all swallow; agent actions
  audited under the OPERATOR system actor (attribution mismatch); staged-verdict loss on restart;
  no path-traversal guard on skill/KB names.

### F14..F16 [from delivery-github code map] — see docs/delivery-github.md
- **F14 [BUG — VIB-1 ROOT CAUSE] The "no commits" hole is still reachable for non-repo-write agents.**
  `pushWorkspaceBranch` (push-workspace.server.ts:160-212) does the 0d12bb6 auto-commit, but the
  guard `branch === defaultBranch → no_branch` at :156 runs BEFORE it. An agent whose repo-write
  grant is withheld (`canBranch=false`, specialist-tool-policy.ts:124) is NEVER told to
  `git checkout -B <branch>` (specialist-run.server.ts:1066), so HEAD stays on the default branch;
  at Review the push bails `no_branch`, edits are abandoned, `openTaskPr`→422→"nothing to review".
  EXACTLY VIB-1. NOTE: the seed `developer` profile has `execute-code-or-write-repo: off` yet
  `create-task-branch: direct` / `commit-push-branch: direct` — MUST verify whether `canBranch`
  keys on the wrong (general) capability and thus overrides the specific branch grant. Likely THE
  central bug. Also fires for any agent that ignores the checkout instruction (prompt is guidance,
  not enforcement).
- **F15 [BUG — SAFETY] `git add -A` over the whole working tree** (push-workspace.server.ts:177) with
  no path filter / no `.gitignore` guarantee → build artifacts, unignored deps, scratch/log files,
  or a stray secret get committed into the PR (author `Viberr Delivery <delivery@viberr.local>`).
  Workspace is REUSED across runs, so leftovers accumulate. Real correctness+security risk.
- **F16 [POOR] Delivery robustness gaps.** Fire-and-forget log-only delivery failures at Review (no
  packet/notification on push/PR failure); no server-side checkout; ahead-count ref inconsistency
  between push vs reconcile (may relate to lowercase `vib-1` vs uppercase `VIB-1` branch refs);
  fine-grained PAT write scopes only "assumed". GitHub client itself is entirely real (no stubs),
  tokens AES-256-GCM, merge via real REST API, divergence surfaced — those are solid.

---

## TODOs (to implement in phase 3)

(none yet)

---

## F14 — full root cause (the central bug)
- `execute-code-or-write-repo` (UNIFIED_CAP_CATALOG, default `direct`) is a MASTER GATE: tool-policy
  `resolveDeliveryPermissions` (specialist-tool-policy.ts:122-127) makes `repoWriteWithheld` veto
  `canBranch`/`canCommitPush`/`canOpenPr` regardless of the scoped grants. The XS-4 comment cites the
  original VIB-1 and argues prompt+enforcement must tell the same story.
- `isWithheld` treats an ABSENT cap as *not* withheld, but explicit `mode:"off"` as withheld.
- Seed developer (demo-data.server.ts:242-247) grants create-branch/commit-push/open-PR `direct` but
  OMITS execute-code-or-write-repo → absent → canBranch=TRUE (works by luck of omission).
- App create/edit path (`agent-profile-actions.server.ts` grantsFromCaps :140-169 / createModalGrants
  :180-196) PERSISTS every governed cap explicitly incl. `off`. So an app-created/edited developer that
  doesn't toggle "Execute code or write to the repo" ON gets execute-code-or-write-repo:`off` →
  canBranch=FALSE → CANNOT DELIVER (VIB-1). The docker `viberr` project's developer has it explicitly
  `off` — reproducing the failure. No validation warns about the contradictory config
  (scoped delivery direct + headline off).
- FIX depends on intended semantics (see owner Q1). Likely: seed/default-grant execute-code-or-write-repo
  `direct` for deliverers + validate/repair contradictory configs; OR make scoped caps independently
  sufficient (drop the veto). Either way, verify with a fresh live delivery in phase 2.

### F17..F20 [from operator + rbac/fileformats code maps]
- **F17 [RBAC] Archived read-only gate misses agent-runtime actions** — assign/run/interrupt/schedule/
  run-operator skip `requireProjectMutable`, so agents can run on ARCHIVED projects (contradicts the
  gate's own doc). Medium.
- **F18 [POOR] Whole-array tolerant-parse fallback wipes the list on one bad entry** — one invalid
  `members[]` row in project.md → `[]`, silently stripping every member's role (ACL integrity). Same
  for stages/workflow/agents. Contrast per-entry `parseEngagements`. Medium.
- **F19 [POOR] operator legacy dead code + stale docs** — `operatorSchedulesOnOwner`
  (task-actions.server.ts:2409) only fires on seed `**Quality gate:**` events (dead for real tasks),
  writes hardcoded synthetic narration, comment cites "Phase-8" as future; stale "capability-checked in
  Phase 8" doc on transitionStage (already done). `run_agent` starts a prompt-less run & can throw when
  no deliverer engaged. Codex plan `text` field overloaded; Codex dup-comment suppression workaround.
- **F20 [POOR] board rescan authorizes 1 project but reprojects whole instance; applyRecommendation
  reads/throws before authz; lossy roleToSlug on encode; malformed-heading timeline drops.**

### F26 [BUG-edge, found in Round-2 testing] Reused branch links a STALE merged/closed PR instead of opening a fresh one
- Live: VIB-6 (a fresh test task) force-pushed branch `vib-6` with a NEW commit (281737d), but Viberr
  LINKED the pass-8 **merged PR #35** ("Add pass-8 smoke-test note doc") — so the reviewer was pointed
  at a wrong, already-merged PR instead of a fresh PR for the actual delivery.
- Root cause: `findPrForBranch` (pr-linker.server.ts:108) queries `state:"all"` (:120) and takes the
  NEWEST PR of ANY state (:144) — so a branch whose only PR is merged/closed links that stale PR.
- Scope: only reachable when a task branch is REUSED (same `vib-N` as a prior task with a merged PR).
  Normal monotonic `nextTaskNumber` prevents branch reuse; my test hit it because docker-data's
  `nextTaskNumber` collided VIB-6 with pass-8's VIB-6.
- **FIXED** (pr-linker.server.ts): when the newest PR for a branch is terminal (`state:"closed"` —
  merged or closed), `findPrForBranch` now fetches the branch's current HEAD and links the PR ONLY if
  its head SHA still matches (the legitimate accepted / merged-out-of-band divergence case); if the
  branch has advanced past it, returns `none` so `openTaskPr` opens a fresh PR. Fail-safe: if the
  branch head can't be read (head branch auto-deleted on merge), falls through to the old behavior.
  +2 unit tests (stale→none, matching-head→found). Found live in Round-2 testing (VIB-6/PR#35).

### F21 [DOC] README "Known gaps" is stale — 3 of 9 already closed in code
- #5 stub tasks (DEP-31/BIL-9, not BIL-7) ARE seeded; #6 home GitHub tile reads real connections store;
  #7 MCP-credentials UI IS built (sealed AES-256-GCM); #1 profile email/nudge prefs were removed (not
  "schema-only"). Fix the README in phase 3 (safe doc change).

## Owner rulings (2026-07-19)

- **Q1 → "Headline = master switch".** `execute-code-or-write-repo` STAYS the master gate. Fix:
  seed/default-grant it `direct` for deliverers (the developer) + validate/repair contradictory
  configs (scoped delivery direct + headline off must never silently ship). Keep XS-4 prompt/enforce
  consistency.
- **Q2 → "Fix the clearly-fixable".** Implement Codex envelope-on-resume (F7). Leave Codex
  tool-enforcement asymmetry (F8) and Codex MCP-auth (F9) as HONEST "claude-only" documented labels —
  do NOT build a Codex sandbox. Make sure the UI/labels state the asymmetry truthfully.
- **Q3 → "Do it now".** Rename the task-page execution-profile labels + wire intents from
  Primary-specialist/Reviewers to the unified engagements model in THIS pass (undo the plan.md defer).

## Questions for owner (answered above)

---

## Test cases run (phase 2)

(none yet)
