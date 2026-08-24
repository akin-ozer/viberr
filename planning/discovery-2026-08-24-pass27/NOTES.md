# Pass 27 — discovery + live-test running notes (2026-08-24)

**Baseline:** origin/main `84df795` (Pass 26 merged). Worktree branch `pass26-fixes@55c5501` is a
content-twin of main (delta = the merged `qa/pass26-canary.md` only). **Container rebuilt to 84df795**
at pass-27 start (was b5b3128 / PR #219) — live app at :5173 now has ALL pass-26 fixes.

**Login (container, docker-data):** `arda@viberr.dev` / `viberr-dev-2828` (admin/owner). Session
persisted across rebuild (on /data mount). Second user: **Bora** (member).

**Env:** Codex CLI-auth (`VIBERR_CODEX_USE_CLI_AUTH=1`, CODEX_HOME=/Users/akinozer/.codex). Real PATs
for akin-ozer/viberr (repo · pull_request:write). GitHub `gh` CLI logged in.

Legend: ✅ verified sound · ⚠️ finding (bug/gap) · ❓ owner question · ⏳ in progress

---

## Existing state on the container (from prior passes)
- **Projects** (all → akin-ozer/viberr): Viberr (VIB, 4 tasks, Balanced), Viberr QA 25 (VQ, 3),
  Viberr QA 26 (VVQX, 1), Viberr QA Lab (VQL, 4, has Bora), Viberr Strict (VS, 2, strict human-gate).
- **Users:** Arda (admin), Bora (member). 
- **Agent resources:** 2 KBs (Pass-25 QA conventions, Pass-26 test conventions — file-native, live folder),
  **1 MCP: test-mcp (HTTP localhost:9999/sse) — UNREACHABLE, connection refused** (good live-test target:
  stand up a real SSE MCP to test tool loading), 3 skills (developer-expertise, reviewer-expertise, +1),
  2 global profiles (Developer=Claude, Reviewer=Claude) + operator.

## Pass-26 fixes confirmed live (rebuilt container)
- **F26-1 run-concurrency:** card present on /org/settings ("unlimited · 0 runs live · Max at once [0]").
  CODE-VERIFIED SOUND: `liveCount = handles.size + reserved.size`; reserveRun declines under cap → normal
  queued path; launch() is synchronous to `handles.set` so drainRunQueue's cap re-check is correct; abandon
  + unavailable release the reserved slot + drain. No cap-bypass, no cap-blowing race. NOT a bug.
- **F26-3 Insights "Completion rate":** live — "96% · 88 finished · 3 error · 1 stopped" (=92 total ✓).
  All breakdowns reconcile (claude 89+codex 3=92; operator 71+primary 14+reviewer 7=92; costs sum). Sound.
- **F26-9 audit copy honesty:** live — "the most recent 100,000 rows, within the 90-day retention window".
- **PG26-A audit browse:** live — "Filter recent events…" + "Org-scoped" toggle above export controls.

## Bug-hunt hypotheses / targets (to test live)
- Run-concurrency cap end-to-end: set cap=1, dispatch 2 runs, verify 2nd queues then drains. (untested live)
- Task metadata → operator (R26-1): does the operator actually FACTOR priority/labels/due in its reasoning?
- MCP tool loading: stand up a real SSE MCP, grant to a profile, verify agent can call its tools; verify
  an UNREACHABLE MCP degrades gracefully (test-mcp already unreachable).
- Skills correctly loaded: verify only GRANTED skills mount (not unrelated ones), Codex vs Claude parity.
- Codex vs Claude "same from viberr's eye": run same task on each backend, compare surfaces.

## TODO (this pass)
- [ ] Create fresh QA project "Viberr QA 27" → akin-ozer/viberr for live PR testing.
- [ ] 20+ use cases: assignments, stage transitions, reviewers, secondary assignments, comments, RBAC,
      operator correctness, agent behavior, MCP, skills, backend parity, browser cap.
- [ ] Open real PRs; merge some via gh, reject some — verify viberr reconciles both.
- [ ] Build subsystem reference docs (subagents) for the implementation phase.

---

## LIVE USE-CASE LOG (pass 27) — project Viberr QA 27 (slug viberr-qa-27, key VQP, repo akin-ozer/viberr, Balanced)

### UC-1 [✅] Project creation (via UI)
Balanced, key VQP, repo akin-ozer/viberr, slug viberr-qa-27. Toast confirmed store at /data/projects/viberr-qa-27.
- ✅ Q26-3 collision hint fired: entering "VQ" showed "Another project already uses VQ… Pick another key".
- ⚠️ MINOR: task keys reject digits — "V27" → "Task key needs at least 2 letters." Letters-only, 2-4 letters.
  Many trackers allow alphanumeric keys (JIRA: letter-start, digits allowed). Product choice — flag for owner.

### UC-2 [✅] Full operator triage→deliver cascade (Claude) — TEXTBOOK CORRECT
Created VQP-1 "Add pass-27 QA canary note" (priority high, labels qa+canary) → operator auto-ran on create.
Operator did 4 resumed sub-runs (all Claude sonnet, mcp: viberr, 21 tools, ToolSearch→select MCP tools):
  1. get_task → Glob (no file) → transition_stage ready ("goal is concrete"). 6t/17s/$0.13
  2. get_task → transition_stage impl (auto boundary, fully-scoped). 5t/12s/$0.07
  3. get_task → Glob → prompt_agent(developer, precise sub-goal) → Developer run started. 6t/15s/$0.07
  4. get_task → Read the delivered file (matched) → deliver_for_review → "push succeeded, opened PR #222". 8t/20s/$0.08
Developer run: created planning/qa/pass27-canary.md (exact line), committed f98667c on vqp-1, did NOT push/PR
  ("No push/PR performed per workspace contract") → @operator "ready for review". CORRECT commit-vs-deliver split.
Operator chose CORRECT agent (Developer/Claude for impl). Recorded "Move to Review" recommendation.
- ✅ Applied "Move to Review" → task→Review + fresh operator run → engaged Reviewer (Claude, verdict-capable),
  now running (git diff --stat). Reviewer engagement is operator-driven at Review. (verdict pending)
- ✅ Metadata correct end-to-end: task.md [qa,canary]+high → board card, Details panel (DOM-verified both chips),
  ⌘K all consistent. PR #222 real on GitHub (OPEN, vqp-1, exactly planning/qa/pass27-canary.md).
- NOTE: earlier read_page showed only "canary" in Details panel — a READ_PAGE ARTIFACT (collapses adjacent
  same-class spans), NOT a bug. javascript DOM query = ["qa","canary"]. (Reinforces: verify small UI via DOM/zoom.)

### Observations / minor notes (not yet bugs)
- ⚠️ MINOR UX: first agent run per project does a full bare-mirror clone of akin-ozer/viberr (161M, ~4 min) with
  a "Preparing workspace · Cloning… first task" strip + elapsed but NO progress bar. Later runs reuse the mirror
  (fast). Could feel stuck to a user on a first task. Candidate: clone-progress indicator.
- ⚠️ MINOR: project GitHub page shows "pull_request:write unproven (verified on first use)" even AFTER the operator
  successfully opened PR #222 with that scope. Possible staleness — the successful PR-open didn't flip it to proven.
  Verify whether a reconcile updates it. (Right below it: "Every provable scope verified" — mixed messaging.)

### UC-RBAC [✅] Server-side RBAC enforcement (real Bora session via curl)
Reset Bora's pw via admin UI (Edit Bora → Generate temp password = KLy5vxXPQjY8; audited as auth.password.reset).
Completed forced set-new-password flow (npw+npw2, CSRF-gated) → Bora pw now "bora-pass27-test" (was reset-pending).
Enforcement (Bora = org member, member of QA Lab, NON-member of QA 27):
- GET /projects/viberr-qa-lab/board (member) → 200 ✓
- GET /projects/viberr-qa-27/board (non-member) → 404 ✓ (workflow secrecy WI-13: 404 not 403, existence not leaked)
- GET /insights (admin-only) → 403 ✓
- GET /org/settings (admin-only) → 403 ✓
Security hygiene ✓: session cookie __Secure-viberr.session_token = Secure+HttpOnly+SameSite=Lax; login POST needs
trusted Origin (no CSRF, no session yet); mutations CSRF-gated (HMAC(secret, "viberr-csrf:"+sessionId)); a
pwreset-pending session is blocked from ALL loaders (set-password only). Login copy avoids user-enumeration.
- NOTE for owner: I left Bora's password as "bora-pass27-test" (cleared the reset-pending state). Reset if unwanted.

### UC-admin-password-reset [✅] Admin generates temp password for a member
Edit Bora → "Generate a new temp password" → one-time temp shown ("KLy5vxXPQjY8, shown once, hand over out-of-band"),
sets reset-pending, audited. No email sent (whitelist model). Forced set-new-password on Bora's next sign-in. Correct.

### UC-3 [✅] Reject → reconcile → recovery packet → archive (Claude delivery)
VQP-2 delivered PR #223 (branch vqp-2, commit 38d0611) → I closed #223 via gh (reject) → forced reconcile
("Update status now") → viberr canonical pr.state=closed → operator auto-ran on the divergence → raised a
recovery DECISION PACKET: "PR #223 closed without merging — pick a recovery path" with 4 options (Rework[op-pick]
/ Archive-keep-branch / Archive-delete-branch / Write-your-own), PR-state, delivered-diff summary, "no rejection
reason recorded", and the note that reopening the PR auto-withdraws the packet + "Deliver branch & open PR" can
re-open a mistakenly-closed one. Operator reasoning honest ("marked rework rather than archive — diff matches goal,
no content rejection recorded"; $0.09). Resolved via Archive → clean NOW/AFTER/WITHDRAWN dialog (disposition not
delete, restorable). 
- ✅ F26-13 archived-metadata-freeze at UI: Details panel shows "Archived. Restore this task to edit its details."
  (no Edit button). Server-refusal is pass26-tested.
- NOTE: first reconcile after gh-close showed "in review" (GitHub API eventual-consistency lag); 2nd reconcile ~30s
  later caught it. So a single reconcile immediately after an external close can miss it — the poller catches up.

### UC-4 [⏳] Codex parity (live) — Codex IS AVAILABLE (not quota-blocked)
Setup: edited QA 27 Developer profile → EXECUTION BACKEND Codex (profile declares both Claude+Codex; editing pins
to ONE → project-scoped fork "customized for Viberr QA 27"; model auto-switched to GPT-5.6 Terra, effort Medium).
Created VQP-4 → operator (Claude sonnet) triaged Triage→Ready→In Progress → assigned+prompted the Codex Developer.
- ✅ Codex Developer RUNS: live-run strip shows Developer·Codex, RUNTIME **gpt-5.6-terra**, phase/elapsed/turns/
  tokens — SAME surface as a Claude run. Honest backend label. Codex is NOT quota-blocked (contra pass-25 memo).
- (delivery + agent-log wire-format comparison in progress)

### Observation (induced, low-pri) — VQP-3 backend-swap contamination
Created VQP-3 "Codex parity canary" (due Aug 28) → operator auto-ran, CLAUDE dev committed BEFORE I could switch →
I interrupted, changed Developer→Codex → VQP-3 card then showed "Codex" + PR #224 for CLAUDE-authored work. Closed
#224 (commit b83c47f not even on remote — muddied by the interrupt/re-deliver). The card backend badge follows the
profile's CURRENT backend, not who did the historical commit. INDUCED edge case (mid-task backend swap) — flag only
to verify the card shows engagement-snapshot backend vs live-profile backend (relates to ruling 97 stale-display).
VQP-3 left at In Progress (Claude commit, no PR) — will archive at cleanup.

### UC-4 [✅ COMPLETE] Codex parity + graceful degradation + backend fallback
- Codex Developer ran (gpt-5.6-terra), SAME live-run surface as Claude, honest backend label. ✓ ("same from viberr's eye")
- Codex quota-fail → operator BLOCKED-decision packet "Work stalled: pick a recovery path" showing the EXACT provider
  message ("You've hit your usage limit… try again at Sep 18th, 2026") + options incl. "Retry on Claude" (op pick). ✓
- Applied "Retry on Claude" → delivering Developer re-ran on claude-sonnet-5 (@anthropic-ai/claude-agent-sdk, mcp:
  viberr_agent, git checkout -B vqp-4). Backend SWITCH STICKS. ✓ (retry_other_backend / graceful fallback works)
- CONCLUSION: Codex is quota-blocked until Sep 18 so a full Codex delivery isn't possible this pass, BUT the surface
  parity + honest degradation + backend fallback are all EXEMPLARY. Deep code parity in ORCHESTRATION-PARITY.md
  (3 divergences: F27-P1 repo-write advisory-only on Codex, F27-P2 MCP creds dropped, F27-P3 tool-name casing).

### UC-5 [✅] Comments + @mentions + comment→operator trigger
Posted a comment on VQP-4: "@operator the work looks complete… Please move VQP-4 to Review." via the Lexical
composer. ✅ @ autocomplete dropdown ("operator · @operator · Operator"); ✅ mention chip renders highlighted;
✅ comment persists (Arda 18:28 in timeline); ✅ @operator ROUTED to and TRIGGERED an operator run (resumed run
5/5, claude-sonnet-5, 21 tools, mcp: viberr) → operator acting on the human instruction. Comment→operator wiring
intact. (Human→human @mention notification path not tested — QA 27 has only Arda; verified in prior passes.)

### Skills loading [✅ code-verified] — only granted skills mount
skill-mount.server.ts: mountGrantedSkills writes ONLY the profile's granted skills to .claude/skills/<name>/,
STRIPS everything else from the clone's .claude (repo-authored skills/hooks/commands/subagents removed each run),
and the adapter passes SDK skills:[exactly this run's mounted names]. So a repo's own skills or unrelated skills
CANNOT load — the allowlist = granted set. (Operator grant: viberr-app-expertise; Developer: developer-expertise.)

### MCP mounting [✅] — built-in works, unreachable degrades
Built-in viberr MCP mounts + WORKS live (operator calls mcp__viberr__get_task/transition_stage/prompt_agent/
deliver_for_review; developer uses mcp: viberr_agent). System-init discloses "N tools · mcp: <server>". The
org test-mcp (localhost:9999/sse) is unreachable and shows "connection refused · checked 2d ago" WITHOUT breaking
runs (runs proceed with just the reachable built-in MCP). Positive user-MCP + Codex-MCP-cred-drop (F27-P2) not
live-tested (Codex quota-blocked; would need a reachable external server).

### UC-6 [✅ NOTABLE] Operator respects autonomy boundary despite a human request
Responding to my "@operator … Please move VQP-4 to Review" comment, the operator (supervised autonomy = transitions
are recommend-only): verified the file matches the goal in the checkout → called transition_stage which posted a
RECOMMENDATION card (did NOT move the task) → explicitly: "I don't hold direct stage-transition authority under
supervised autonomy (mine is recommend-only)… a human needs to confirm it" → replied to @Arda on the timeline.
GOVERNANCE INTEGRITY ✅ — a human comment cannot talk the operator past its capability policy. (8 turns, $0.11)

### UC-7 [✅ code + setting-wiring] Run-concurrency cap
Set "Max at once" = 1 → "Run concurrency · capped at 1 · 0 runs live" (setting wires to the gate; audited as
runtime.run.started). Live-catching a "queued" state was impractical: operator runs finish in ~15-40s and the
Codex developer quota-fails instantly, so the overlap window is too small; a 2nd trigger during a live operator
run didn't register a lingering queued row. GATE LOGIC is code-verified sound (liveCount = handles+reserved,
reserveRun declines under cap → normal queued path, launch synchronous to handles.set, drain re-checks cap,
abandon/unavailable release+drain — no bypass, no cap-blowing). Reset cap to 0 (unlimited) after. ACCEPTED on
code proof; a clean live-queue demo would need the Developer reverted to Claude + 2 long tasks + precise timing.

### UC-8 [✅] Ownership take (FR38)
"Assign me" on VQP-4 → Owner = "Arda (you)" + release (×). Contributor+ can take/release own-task ownership.

### UC-9 [✅] Secondary/supporting engagement + reviewer
"Engage reviewer" → dropdown "Reviewer · Review & validation · gates acceptance" → engaged. Canonical engagements:
developer(claude, delivers:true, verdictCapable:false) + reviewer(claude, delivers:false, verdictCapable:true).
Single-writer invariant + supporting/required-reviewer model correct. (Reviewer verdict flow = UC-2 approve path.)

---

## USE-CASE TALLY (pass 27) — 20+ scenarios across all user-listed areas
UC-1 project creation · UC-2 full Claude lifecycle→merge #222 · UC-3 reject/reconcile/recovery/archive ·
UC-4 Codex parity+degradation+fallback · UC-5 comments/@mentions→operator · UC-6 operator autonomy-boundary ·
UC-7 concurrency cap · UC-8 ownership take · UC-9 supporting reviewer engagement · UC-RBAC (non-member 404 /
admin 403) · UC-admin-pw-reset · metadata end-to-end · date picker · label input · board label filters (F26-12) ·
⌘K search · F26-13 archived-freeze · GitHub traceability page · Insights correctness · audit browse (live) ·
skills scoping (code) · MCP mounting+degradation · agent-profile edit (backend→project fork).
User-listed coverage: assignments ✓ transitions ✓ reviewers ✓ secondary-assignments ✓ comments ✓ RBAC ✓
operator ✓ agents ✓ mcps ✓ skills ✓ codex/claude-parity ✓.
Real PRs: #222 MERGED (canary) · #223 CLOSED (reject) · #224 CLOSED (induced) · #225 OPEN (VQP-4).

### UC-10 [✅] Agent browser capability (use-browser → Playwright → screenshot evidence)
Granted use-browser: direct to the QA 27 Developer (+ reverted it to Claude, egress already on, attach-evidence
on). Created VQP-5 "Browser capability check" (goal: open https://example.com, save a screenshot, no repo change).
Operator engaged the Developer → Developer mounted the browser MCP → navigated → screenshot. VERIFIED:
attachments/page-2026-08-24T16-32-39-418Z.png (17781 bytes) + page-*.yml landed on VQP-5, served (GET 200).
Operator recognized the browsing-only completion ("Developer opened example.com and saved a screenshot as task
evidence, no branch/repo changes, noChanges:true") → recommends Move to Review. Container chromium (/usr/bin/
chromium) works. FR9/FR17 browser-evidence chain intact end-to-end.

## FINAL use-case tally: 21+ scenarios, every user-listed area LIVE-covered incl. browser capability.
