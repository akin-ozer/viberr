# Pass 23 — live-validation log

Context: pass 22's F1–F4 merged to `main` (merge `6003d0d`). Container `viberr-app-1`
rebuilt from main, **fresh data root** (boot self-heal created a new
`projection.sqlite`; env admin = `arda@viberr.dev`). This pass live-validates the
merged features on a real merged-main container and hunts for new bugs.

## Environment ground truth
- Container up healthy on :5173, `VIBERR_DATA_ROOT=/data`, build 0.19.0.
- Boot log: `sqlite ready migrationsApplied:["0001_baseline.sql"] migrationsAlreadyApplied:0`
  → fresh DB; `boot integrity check dataRootDirsOk:true` → **F1 self-heal healthy boot**. ✅
- `runtime backend detection backend:claude available:true` / `codex available:true`
  at `/resources/health` → **F3 model-availability computed**. ✅
- Owner re-added GitHub connection `akin-ozer` (default, PAT valid: fine-grained,
  repo + pull_request:write, login akin-ozer).

## Feature validation status
| Feature | What | Status |
|---|---|---|
| F1 | boot DB self-heal | ✅ clean healthy boot on fresh data root (logs) |
| F2 | seed Developer → Claude | ✅ Developer profile seeds `Claude · Ready · In Progress` (Instance settings → Agent resources) |
| F3 | model-availability run-control signal | ✅ health computes both backends available; run-control live check pending during a run |
| F4 | github_read (read-github-api) | ✅ LIVE PASS on VIB-1 → PR #192 merged; repo-scoped, rate-limit surfaced, audit token-free (details below) |

## Project & task setup
- Project **Viberr (VIB)** → `akin-ozer/viberr`, Standard 5-stage, Balanced policy.
- Developer profile forked for Viberr: backend pinned **Claude**, Sonnet/High,
  capability **read-github-api = Allowed** (COLLABORATION 3 Allowed).
- **VIB-1** "Recap the 3 most recently merged PRs" — goal requires `github_read`
  to list merged PRs and write `docs/recent-merges.md`, then open a review PR.
  (Small, non-bloating deliverable; exercises F4 + full delivery flow.)

## Live run observations

### VIB-1 operator (run_kJLEzRpXb-5e, claude-sonnet-5)
- First-clone of `akin-ozer/viberr` took ~2 min (bare mirror 129 MB — heavy history
  from 22 passes of committed planning/evidence docs). One-time; mirror is reused.
  NOTE: "Preparing workspace" shows for the whole clone with no progress detail — a
  minor UX gap on first-task-per-project (looks stalled for minutes). Candidate note.
- Rate-limit event at run start: `status: allowed_warning, seven_day utilization
  0.52, isUsingOverage` → real quota in use; keep agent runs economical this pass.
- Operator loaded MCP `viberr` (21 tools), read the task via `mcp__viberr__get_task`,
  globbed the workspace to scope. Coordinating; the Developer will call github_read.
- Container build confirmed to contain F4 (`github_read`/`runAgentGithubRead`) in
  specialist-run.server, agent-outcome.server, capabilities bundles.

### ✅ UC-04 F4 github_read — LIVE PASS (flagship)
Operator selected+assigned the Developer (`task.operator.agent_selected chosen:developer
delivers:true`), created branch `vib-1` from main, started the Implementation run
(run_p8-2gIuuYX8W, claude). The Developer then:
1. Loaded **only** `developer-expertise` skill (not reviewer/unrelated) — UC-20 ✅.
2. ToolSearch-selected `mcp__viberr_agent__github_read` (in-process Claude MCP tool).
3. Called `github_read {path:"pulls?state=closed&sort=updated&direction=desc&per_page=10"}`
   → tool **normalized repo-relative → `/repos/akin-ozer/viberr/pulls?...`**, returned
   `[done] GET /repos/akin-ozer/viberr/pulls?... — GitHub rate limit remaining: 4963`
   + real PR JSON. Second paginated call (page=2) → remaining 4962.
4. Audit row `task.agent.github_read` records the **normalized path + ok:true, NO token**
   → token-stays-server-side confirmed; audit honesty confirmed.
Repo-relative path handling, rate-limit surfacing, Claude-only in-process mount, and
scope-prepend all behave exactly as designed. **F4 validated end-to-end on real merged main.**

**Data-accuracy check:** the developer paginated closed PRs, filtered by `merged_at`
(correctly excluding *rejected* closed PRs like #190/#188), and produced an accurate
7-line `docs/recent-merges.md` — the real 3 most-recent merges #191/#189/#187 with
correct timestamps. Committed `4f563e5` on branch `vib-1`, 1 file, 7 insertions. Small,
non-bloating deliverable. Developer did NOT self-open the PR (correct: server-owned
delivery pushes + opens the review PR on the operator's Review transition).

### ✅ UC-09 server-owned delivery + UC-23 transition gate
- Viberr opened **PR #192 · in review** on `akin-ozer/viberr` (branch vib-1, commit
  4f563e5) when the delivery landed — the operator did not merge or self-transition.
- The task surfaced an **Operator recommendation** "Move the task to Review" framed
  honestly: *"Recorded by Viberr when the delivery landed; this is not the operator
  agent's judgement."* → acceptance-disclosure honesty (R15-1 family) holds. ✅
- Human (Arda/admin) clicked **Apply** → task moved In Progress→Review; operator
  re-engaged to coordinate the review boundary. Human-gated boundary respected. ✅

### ✅ UC-10 + UC-22 reviewer auto-engaged
At Review, the operator autonomously **summoned the Reviewer** specialist (its direct
capability "Summon reviewer specialists") — `reviewers:[{profileId:reviewer,
backend:claude, delivers:false, verdictCapable:true}]`. A "Review & validation" run
executed (verdict-capable, supporting role distinct from the delivering Developer).
- Reviewer loaded **reviewer-expertise** (correct skill), verified diff scope (1 file,
  under cap), cross-checked PR data vs local git history, reported **verdict: approve**
  with 6 evidence refs. Correctly noted it lacks github_read (capability isolation:
  read-github-api granted only to Developer). ✅

### ✅ UC-11 accept → merge (real GitHub)
Human clicked **Accept completion → Done** → clear confirm dialog ("MERGES PR #192 into
main · REVISION 4f563e5 · VERDICT validation healthy · Merging is one-way"). Accepted →
task **Done**, PR **#192 MERGED** on GitHub (gh: state MERGED, mergedAt 2026-08-21T20:55:43Z,
1 file docs/recent-merges.md +7/-0). Full flagship flow proven end-to-end:
create→triage→assign→github_read→commit→server-opened PR→human-applied Review→
auto-summoned reviewer→approve→human accept→merge to main. **UC-07,08,09,10,11,20,22,23 PASS.**

### 🐛 BUG-1 found (see FINDINGS.md) — web egress "Off" in editor but ENABLED at runtime
The Reviewer used built-in WebFetch live despite use-web-search-fetch being absent
(editor shows "Off"). Enforcement leaves WebFetch/WebSearch available for an absent grant.
Security-disclosure + coherence defect. Owner design question in QUESTIONS.md Q1.

### ✅ UC-05 github_read scope enforcement — LIVE PROVEN (VIB-2)
Developer made two github_read calls, audit records both honestly:
- `/repos/akin-ozer/viberr/commits?per_page=3` → **ok:true** (in-repo allowed)
- `/repos/torvalds/linux/commits` → **ok:false** (cross-repo BLOCKED)
The sealed PAT never fetched the out-of-repo path; the agent got `[unavailable]`. The
merged live scope boundary matches the unit-tested guard exactly — cross-repo
exfiltration refused at the tool seam. (No scope_violations row: enforcement returns
[unavailable] at the tool boundary; that table tracks branch-scope, a separate mechanism.)

### ✅ UC-12 reject + UC-13 divergence/reconcile (VIB-2 → PR #193 closed via gh)
- Deliverable `docs/scope-probe.md` captured the verbatim tool refusal:
  `[unavailable] only this task's repository (akin-ozer/viberr) can be read`, and check-1
  listed real latest commits incl. the just-merged PR #192 merge commit.
- Rejected PR #193 via `gh pr close 193` (throwaway probe artifact). viberr did NOT
  auto-poll; the GitHub page "Update status" reconcile flipped #193 → **closed**
  ("Status updated. Every branch and PR maps to its task key").
- Task page then refused acceptance honestly: *"Acceptance is closed... its review PR
  was closed on GitHub without merging, so it can't be accepted. Rework and reopen the
  PR, or archive."* The **operator auto-raised a decision packet** "PR #193 closed
  without merging — choose recovery path" that is careful and honest: *"nothing on the
  timeline indicates the work itself was rejected outright, just the PR"* + recovery
  paths (Rework / Reopen-PR / Archive). No fabricated merit-rejection. Excellent
  acceptance-disclosure + divergence coherence.
- Resolved the recovery packet by choosing **Archive + delete branch vib-2** (human
  overriding the operator's "Rework" pick). Confirm dialog disclosed honestly:
  archive reversible, branch-delete irreversible, packet withdrawn on archive.
  Verified on GitHub: branch `vib-2` **deleted** (404), PR #193 **CLOSED**, task archived.
  **UC-12 reject + branch-deletion recovery path proven end-to-end.**

## Pass-23 scorecard (live)
PASS: F1, F2, F3(health+wiring), F4/UC-04, UC-05, UC-07, UC-08, UC-09, UC-10, UC-11,
UC-12, UC-13, UC-20, UC-22, UC-23. FOUND: BUG-1 (web-egress editor/runtime mismatch).
Remaining (cheaper, no Claude quota): UC-14/15/16/17 RBAC, UC-18 KB, UC-19 MCP, UC-25 sweep.
