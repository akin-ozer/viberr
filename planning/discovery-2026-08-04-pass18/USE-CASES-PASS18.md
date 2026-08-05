# Pass 18 — consolidated use-case & test-case ledger

The single authoritative enumeration of what Viberr has actually been made to do,
what was observed when it did it, and which automated test would catch the
regression. It consolidates three source ledgers — this pass's fresh
docker-compose run (`LIVE-VERIFY-SESSION.md`), the pass-18 discovery ledger
(`NOTES.md` UC18-1..30 + `FINDINGS.md` + `NEW-FINDINGS.md` G1–G8), and pass 17's
34-case ledger (`../discovery-2026-08-04-pass17/USE-CASES.md`) — and adds the one
thing none of them had: **the test map, and the honest gaps in it**.

**Nothing here is aspirational.** Every "actual result" cites a PR number, a
commit sha, a run-log id, a timeline quote, a `file:line`, or the test that pins
it. Where no evidence exists the entry is marked **NOT-RUN**, not PASS.

### Verification stamp (re-derived while writing this file, 2026-08-05)

| Check | Result |
|---|---|
| `npx vitest run` on `pass18/product-fixes` @ `1f6b689` | **216 files / 2860 tests passed** |
| `gh pr list --state all` | #142 **MERGED** `d2d190a2` · #143 **MERGED** `2b22b28a` · #141 CLOSED · #140 OPEN · #139/#138/#136/#135 MERGED · #137 CLOSED · #134 MERGED `934ede65` |
| Commit map in `FINDINGS.md §STATUS` | all 12 shas resolve (`7abb286`, `97131bd`, `8d75181`, `23c9ce6`, `e274134`, `e07abc0`, `643ca81`, `7b8696c`, `4147036`, `20c2785`, `5e67127`, `a9fd7ba`) |

### Status vocabulary

- **LIVE-FRESH** — executed in this session's clean docker-compose prod-parity
  environment (`NODE_ENV=production`, empty `docker-data`, both backends `real`).
- **LIVE-PRIOR** — executed live in an earlier session's environment (pass-18
  host env, or pass 17); evidence is durable (PR, task file, run log) but the
  behavior was not re-run on the fresh env.
- **TEST-ONLY** — proven by the automated suite / a code audit; never driven
  through a browser or a real agent run.
- **FAIL→FIXED** — the use case FAILED when executed, produced a finding, and the
  fix is committed + tested (canary-verified).
- **NOT-RUN** — planned or implied, never executed. No pass is claimed.

---

## 1. Coverage matrix — the owner's named areas

| # | Area | Status | Best evidence | Regression net |
|---|------|--------|---------------|----------------|
| 1 | **User assignments** (human ownership: take / release / assign) | LIVE-PRIOR | pass-17 "ownership Assign-me before acceptance" (`../discovery-2026-08-04-pass17/LIVE-TESTING-NOTES.md:53`); contributor perms copy "Take / release your own seat" (`NOTES.md:358`) | `task-actions.server.test.ts:687` (ownership), `:1095` (F19 no side effects) |
| 2 | **Primary assignment** (operator → delivering specialist) | LIVE-FRESH | FV-1b/FV-1c: operator deployed Developer(Codex) and started the run (`LIVE-VERIFY-SESSION.md:65-66`); routing to Docs Writer over Developer on VIB-4 (`NOTES.md:344-350`, PR #138 MERGED) | `operator-actions.server.test.ts:271` (`operatorAssignSpecialist`), `specialist-run.server.test.ts:205`, `:270` (engagement uniqueness) |
| 3 | **Secondary assignments** (reviewer / supporting engagements) | LIVE-FRESH | FV-1e: operator engaged Reviewer(Claude), real verdict `"Review passed. Validation: healthy."` (`LIVE-VERIFY-SESSION.md:68`) | `specialist-run.server.test.ts:584` (assign/removeReviewer), `:674` (startReviewerRun), `operator-actions.server.test.ts:483` |
| 4 | **Stage transitions** | LIVE-FRESH | FV-1b auto-advance Triage→Ready→In Progress; FV-1d operator *recommends*, human **Applies** → Review (`LIVE-VERIFY-SESSION.md:65,67`) | `task-governance.server.test.ts:415` (boundary), `:596` (manual), `operator-actions.server.test.ts:793`, `:914`, `:622` (chain cap), `transitions.test.ts` |
| 5 | **Reviewers / verdicts gate acceptance** | LIVE-FRESH | FV-1e rigorous review (`git diff --stat`, `--name-only`, `od -c`) → `validation healthy` pill → accept unlocked | `delivery-decision.server.test.ts:545` (R15-1 gate), `review-queue.server.test.ts:426`, `task-governance.server.test.ts:1233` |
| 6 | **Comments / @mentions** | LIVE-PRIOR | Mira posted an `@Developer` question via the Lexical mention menu, recorded `to: agent`; Done-task banner "comments are still recorded" (`NOTES.md:360-364`) | `task-actions.server.test.ts:328`, `:645` (NEW-4), `mention-notify.server.test.ts:30`, `agent-reply.server.test.ts:845`, `:1222`, e2e `05-task-comment-composer.spec.ts` |
| 7 | **RBAC triggering** | LIVE-FRESH | Real Contributor session: `/org/settings` **403**, non-member project **404**, member read 200, `POST save-project` **403 server-side** (`LIVE-VERIFY-SESSION.md:132-146`) | `policy-rbac.server.test.ts:186`, `:467`, `:600`, `:698`; `project-visibility.server.test.ts:76`; e2e `04-palette-mobile.spec.ts:85` |
| 8 | **Operator behaviour** | LIVE-FRESH | Auto-invoke on create, triage scoping, recommend→apply, summon reviewer, honest out-of-band narration (`LIVE-VERIFY-SESSION.md:53,65-73`) | `operator-run.server.test.ts` (11 describe blocks), `operator-actions.server.test.ts` (26 describe blocks) |
| 9 | **Agent behaviour** (specialists) | LIVE-FRESH | Codex wrote `qa/smoke/fresh-verify.md`, committed locally, refused to push: *"PR URL: none (push/PR delivery not performed per workspace contract)"* | `specialist-run.server.test.ts:375`, `:1016` (delivery contract), `specialist-tool-policy.test.ts` (23 tests) |
| 10 | **MCP function** | LIVE-FRESH | FV-2a register + **"16 tools · checked just now"** via `host.docker.internal`; FV-2b grant; FV-2c wired into the Codex run, operator run shows `mcp: viberr` ONLY | `specialist-mcp.server.test.ts` (14 tests), `operator-toolkit.server.test.ts:47`, `claude-runtime.server.test.ts:314`, `specialist-tool-policy.test.ts:292` (R16-5) |
| 11 | **Skill loading — only RELATED skills** | LIVE-PRIOR (+ FAIL→FIXED for the SDK channel) | Only `smoke-note-style` injected; decoy `release-announcements` never leaked (`FINDINGS.md:217-219`). **But** the Claude CLI's own catalog *did* leak → F18-8/R18-3 | `specialist-run.server.test.ts:1473` (negative half), `:1510` (`stripUngovernedRepoCatalog`), `claude-runtime.server.test.ts:298-314`, `skill-body.server.test.ts:80,119,156` |
| 12 | **Codex vs Claude parity (Viberr's view)** | LIVE-FRESH (Codex) + LIVE-PRIOR (Claude) | Codex run `run_SwHLJSJT2Kdh.jsonl` mounts `everything-http`; Claude init `run_Gum2jAa-kPIf` shows `mcp__everything-http__*` (16, hyphenated) + capability-gated `viberr_agent`; Codex side `mcp__everything_http__echo` (underscored) | `agents-page.test.tsx` "MCP tool names differ per backend"; `agent-outcome.server.test.ts:87,105,135`; `codex-runtime.server.test.ts:779,855` |
| 13 | **PR merge (in-app)** | LIVE-FRESH | FV-1f accept → **PR #142 MERGED** `d2d190a2`, `fv-1` branch auto-deleted, Done·merged | `github-reconciler.server.test.ts:1102` (mergeTaskPr), `:1494` (R15-6 cleanup), `delivery-decision.server.test.ts:905` |
| 14 | **PR reject / external merge / reconcile** | LIVE-FRESH | FV-2d `gh pr merge 143` out-of-band → operator: *"PR #143 was already merged out-of-band on GitHub…"* → force-accept → Done. LV-0 gh-close → recovery packet → archive | `pr-divergence-operator.server.test.ts:127,143,172,199,263`; `acceptance-closed-pr.server.test.ts:414,468`; `pr-open.server.test.ts:286` |
| 15 | **Notifications** | FAIL→FIXED (LIVE-FRESH verify) | 20 orphaned rows counted toward the bell badge and dead-ended in a shell-less light-theme 404 (F18-1) → fixed, live-verified | `notifications.server.test.ts:70,81,397`; `notifications-page.test.tsx:159` (G3) |
| 16 | **KB** | LIVE-PRIOR (+ FAIL→FIXED) | Codex run: *"applying the attached … pass-18 smoke-note conventions"*; SPICEBERRY footer honored. Reviewer without the KB false-`request_changes`d it (F18-11) → R18-1 | `specialist-run.server.test.ts:1559` (R18-1), `:1326`; `kb-injection.server.test.ts`; `resources.server.test.ts:208` (F18-4) |
| 17 | **Single-writer data integrity** (infra, unplanned) | FAIL→FIXED (live-reproduced **CRITICAL**) | Two writers on one `docker-data` → org tables silently lost; `PRAGMA integrity_check` passed both sides (`FINDINGS.md:49-69`) | `data-root-lock.server.test.ts:208`, `:294`; `home-page.test.tsx:414` (F18-5b holder strip) |
| 18 | **Responsive / a11y / copy discipline** | LIVE-FRESH (fix verify) + TEST-ONLY | F18-12 mobile clipping fixed + live-verified at 375px; G3/G5 ARIA; G4 banned-word purge live-confirmed in the PROD image | `copy-ban.test.ts:75`; `profile-page.test.tsx:133`; `notifications-page.test.tsx:159`; e2e `07-accessibility.spec.ts`. **GAP: no test pins the 375px profile-grid** |

---

## 2. The use-case catalogue

Ids are `P18-nn`. "Ruling" names the binding decision the case exercises
(`docs/architecture/decisions.md` numbering).

### A. Setup, identity, access

---
**P18-01 — Project creation via the modal (Balanced preset) auto-deploys the agent set**
*Area:* setup · *Ruling:* 15 (Standard 5 stages), R15-9 (absent grant derives from the graph)
- **Pre:** admin session, GitHub connection present, fresh store (0 projects).
- **Steps:** New project → name "Verify Fresh", key FV, repo `akin-ozer/viberr`, Balanced preset → create.
- **Expected:** project created; operator deployed; Developer/Reviewer eligible; stage-transition capability resolves to `recommend`.
- **Actual:** ✓ `LIVE-VERIFY-SESSION.md:64` — "Verify Fresh (FV) … auto-deployed operator + made Developer/Reviewer eligible." The `recommend` resolution is proven downstream by P18-08.
- **Status:** PASS — **LIVE-FRESH**.

---
**P18-02 — GitHub connection added; scopes proven, not assumed**
*Area:* setup · *Ruling:* 18, 19 (proven verdicts only)
- **Steps:** Instance settings → Connections → add PAT.
- **Expected:** scope chips render proven verdicts only; unproven reads as an honest line.
- **Actual:** ✓ fresh env, PAT `····k3ui`, `repo + pull_request:write` (`LIVE-VERIFY-SESSION.md:60`). Pass-18 host env additionally exercised the classic-token path: scopes proven immediately from `x-oauth-scopes` — "Confirmed against the token", `pull_request:write` "(implied by `repo`)" (`NOTES.md:224-227`), the honest split against pass-17's fine-grained "unproven until attached".
- **Status:** PASS — LIVE-FRESH (fine-grained) + LIVE-PRIOR (classic).

---
**P18-03 — Local account creation → the temp password is shown once → the account is recoverable**
*Area:* identity/RBAC · *Ruling:* R15-11 (a surface must not promise what it can't deliver)
- **Steps:** Users & access → Allow access → Local → Create account. Reload the page. Try to recover the password.
- **Expected:** an admin can always re-issue a sign-in credential.
- **Actual:** ✗ **FAILED, live-reproduced from an owner report** ("I created the user but couldn't log in since it asked for a password"). The temp password lived in client state only; after a reload the Edit modal showed *"Reset pending — will be prompted to set a new password at next sign-in"* **and no action**. Root cause `app/features/org-settings/users-panel.tsx:450` — the ternary `user.pwreset || status==="invited" || tempPassword ? <banner> : <Reset password button>` hid the button in exactly the new-account case (`pwresetRequired: Boolean(tempPassword)` is always true there). The backend could always re-issue; **only the UI hid the door**. Sole escape was Remove + recreate.
- **Fix:** banner becomes context *above* the action; the button always renders, relabelled "Generate a new temp password" (commit `6e93238`).
- **Status:** **FAIL→FIXED** (LIVE-FRESH). This bug is what unblocked P18-24/25 (live RBAC as a real member).

---
**P18-04 — First login with a temp password forces a reset with honest copy**
*Area:* identity · *Ruling:* — (F17-L11)
- **Actual:** ✓ pass-18 host env: the forced-reset screen reads "You signed in with a temporary password" (the pass-17 fix for the false "An admin reset your password") — `NOTES.md:357-359`.
- **Status:** PASS — LIVE-PRIOR.

---
**P18-05 — A project whose only admin is a DELETED org account can still be repaired**
*Area:* RBAC/setup · *Ruling:* R7-1 (org-admin override)
- **Steps:** delete the org account that is a project's sole admin; try Settings → Members → remove the stale row.
- **Expected:** removable.
- **Actual:** ✗ **409 deadlock** — "…is the only admin — assign another admin in Policy first" (the last-admin guard counted a REMOVED account); Policy's ghost row said "remove it in Settings → Members" → **circular**; role changes needed project-admin, which only the ghost held. Recovered only by hand-editing `project.md` (watcher reprojected live). Also observed: joining the org admin as a Viewer member *downgraded* their effective authority. `FINDINGS.md:71-87`.
- **Fix:** last-admin guard counts ACTIVE members only + org-admin override extended (commit `643ca81`).
- **Status:** **FAIL→FIXED** — LIVE-PRIOR (organic, discovered via the F18-5 data loss).

### B. Assignments and ownership

---
**P18-06 — Human owner take / release on a task**
*Area:* assignments · *Ruling:* FR38, F19 (ownership is orthogonal to operator scheduling)
- **Expected:** ownership mutates cleanly — no board-state flip, no synthetic narration, no operator run.
- **Actual:** ✓ pass 17 "ownership Assign-me before acceptance" (`../discovery-2026-08-04-pass17/LIVE-TESTING-NOTES.md:53`); pass 18 confirmed the contributor-facing copy ("Take / release your own seat", `NOTES.md:358`).
- **Status:** PASS — LIVE-PRIOR. *Not re-run on the fresh env.*

---
**P18-07 — The operator picks the ROLE-CORRECT specialist, including a newly created profile**
*Area:* primary assignment · *Ruling:* R14-1 (stage eligibility)
- **Steps:** create a "Docs Writer" profile (global modal → add to project via "Add from library"), set Model/Effort + capability rows, create a docs task.
- **Expected:** the operator routes docs work to Docs Writer, not to Developer.
- **Actual:** ✓ VIB-4 routed to `docs-writer` (`delivers:true`, claude backend) over Developer; project-level Edit modal exposed Model (Default/Sonnet/Opus/Haiku) + Effort (Low…Maximum) + Allowed/Human-only/Off rows; `project.md` fork verified (`NOTES.md:344-350`). Delivered **PR #138 MERGED** `e944a498`.
- **Status:** PASS — LIVE-PRIOR.

---
**P18-08 — Secondary assignment: a reviewer engagement produces an independent, revision-bound verdict**
*Area:* secondary assignment / reviewers · *Ruling:* R15-1
- **Steps:** after delivery, operator engages the Reviewer (Claude) — or a human engages it from the Execution profile panel.
- **Expected:** a verdict bound to the delivered revision, recorded in `task.md verdicts[]`, gating acceptance.
- **Actual:** ✓ **LIVE-FRESH** FV-1e: the Claude reviewer ran `git diff --stat`, `git diff --name-only` and `od -c` (trailing-whitespace check) and returned *"Review passed. Validation: healthy."* → `validation healthy` pill → operator then recommended Accept (`LIVE-VERIFY-SESSION.md:68`). Prior env: UC18-10 recorded `result: approve` with `headSha == delivered revision` (`NOTES.md:296-298`); UXO-2's audit of `task.md` re-confirmed the shape (`result: approve`, `revisionId: rev_ESoWbwrOwiDU` == rev `625773ae`).
- **Status:** PASS — LIVE-FRESH.

---
**P18-09 — A reviewer engagement is refused for a profile that was never engaged**
*Area:* secondary assignment · *Ruling:* R15-7 (conservative ghost profiles)
- **Actual:** TEST-ONLY — `specialist-run.server.test.ts:674` ("errors when the profile is not an engaged reviewer"); engagement uniqueness at `:270`.
- **Status:** PASS — **TEST-ONLY**.

### C. Stage transitions

---
**P18-10 — Task creation triggers the operator, which scopes the goal and auto-advances**
*Area:* stage transitions / operator · *Ruling:* R-A (never strand), 15
- **Actual:** ✓ **LIVE-FRESH** FV-1b: FV-1 created in Triage; operator auto-started, judged the goal clear (no packet), moved Triage→Ready→In Progress, started the Codex run. Host warmup produced typed timeline events at 13:38–13:40 for the same arc (LV-2). Pass-18 prior env recorded the run economics ($0.06 · 5 turns · 31s, `NOTES.md:278-280`).
- **Status:** PASS — LIVE-FRESH.

---
**P18-11 — A vague goal is NOT auto-advanced: the operator opens a scoping packet with real repo analysis**
*Area:* operator/transitions · *Ruling:* 7 (typed packet kinds), R15-11
- **Actual:** ✓ VIB-2: "input required" at creation + a scoping packet whose observation rows cited real files (`docs/testing.md`, `qa/smoke/*`). Confirm button echoed both the default pick and the changed selection (F17-L8 fix); resolving with option 2 opened the goal editor **prefilled with the chosen deliverable** (F17-L3 fix) — `NOTES.md:282-288`.
- **Status:** PASS — LIVE-PRIOR (both pass-17 fixes re-verified live).

---
**P18-12 — Under a `recommend` transition policy the operator recommends and a HUMAN applies**
*Area:* stage transitions · *Ruling:* R15-3 (owner authority over recommendations), R15-9
- **Actual:** ✓ **LIVE-FRESH** FV-1d: the operator could not transition directly, so it posted "Recommendation: Move In Progress→Review" **with evidence** (branch / commit / PR). Clicking **Apply** produced the toast "Applied · Move the task to Review" and the stage moved (`LIVE-VERIFY-SESSION.md:67`). Prior env additionally confirmed the transition re-triggered the queued operator (`NOTES.md:299-301`).
- **Status:** PASS — LIVE-FRESH.

---
**P18-13 — Delivery is NOT a transition, so a full-autonomy task strands after the PR opens**
*Area:* stage transitions / operator · *Ruling:* **R18-2** (ruling 48)
- **Steps:** run LAB-1 under the AUTONOMOUS preset through to server delivery; watch the task afterwards.
- **Expected (pre-fix):** the operator proceeds on its own.
- **Actual:** ✗ **FAILED** — the operator delivered **PR #137** then stopped "per the single-boundary rule". Nothing re-queued it (the P11-70 every-transition re-trigger never fires for a delivery), so the task sat `waiting: human` with `recommendations: []`, no packet, no card — an invisible dead-end. Manual `run-operator(autonomy=full)` resumed the arc (`NOTES.md:365-373`).
- **Fix:** R18-2 — a NEWLY opened PR re-queues the operator with a `delivered` trigger under FULL autonomy; SUPERVISED deliberately does not (commit `e07abc0`).
- **Status:** **FAIL→FIXED** — LIVE-PRIOR repro; fix is unit-proven (`delivery-requeue.server.test.ts:134`), **not re-driven live**.
- **Corroboration this session:** FV/LV-4 showed the *supervised* half live — "Operator Supervised → stopped after delivery (R18-2: Supervised no auto-requeue)" (`LIVE-VERIFY-SESSION.md:55`).

---
**P18-14 — A Done-stage drop without an accepted verdict is refused at the board**
*Area:* stage transitions · *Ruling:* R15-1, ALWAYS_HUMAN transition-to-done
- **Actual:** TEST-ONLY — e2e `01-home-board.spec.ts:181` (refusal + error toast); server side `task-governance.server.test.ts:415`.
- **Status:** PASS — **TEST-ONLY** (e2e, demo fixture).

### D. Delivery, review, acceptance

---
**P18-15 — Server-owned delivery: the agent commits locally and never pushes; the SERVER pushes and opens the PR**
*Area:* agent behaviour / delivery · *Ruling:* R15-2
- **Actual:** ✓ **LIVE-FRESH** FV-1c — the Codex Developer wrote `qa/smoke/fresh-verify.md` (correct 3 lines), committed locally, and reported to `@operator`: **"PR URL: none (push/PR delivery not performed per workspace contract)"**. The operator then pushed `fv-1` (commit `3c2ea324`) and opened **PR #142** (+3/−0) — `LIVE-VERIFY-SESSION.md:66`. Host warmup reproduced it identically (LV-3 → PR #141).
- **Status:** PASS — LIVE-FRESH. This is the sharpest single piece of evidence that the delivery boundary is real and not prompt-level etiquette.

---
**P18-16 — PR-open is attributed to the OPERATOR, not to a ghost human**
*Area:* operator/honesty · *Ruling:* — (F17-1, the pass-17 headline)
- **Actual:** ✓ clean on pass 18: "PR-open event attributed to Operator (F17-1 regression clean)" (`NOTES.md:288-292`). Historical failure: PR #132 still wrong, PR #133 verified fixed — and the first fix *passed jsdom while the operator's own path stayed broken*, caught only by re-running the live case.
- **Status:** PASS — LIVE-PRIOR. **Method note worth keeping:** unit-green ≠ path-covered.

---
**P18-17 — Human accept merges the PR in-app, cleans the branch, and states consequences first**
*Area:* acceptance/merge · *Ruling:* R15-1, R15-6, R16-6, ALWAYS_HUMAN merge
- **Actual:** ✓ **LIVE-FRESH** FV-1f. The dialog stated: *"Merges PR #142 · review into main / Revision 3c2ea324 / Verdict validation healthy / Merging is one-way."* Confirmed → **PR #142 MERGED** (`d2d190a2`, by the app's PAT identity `akin-ozer`), `fresh-verify.md` landed on main, **`fv-1` auto-deleted**, task → Done·merged, timeline *"Completion accepted … the review PR was merged"* attributed to Arda.
- **Status:** PASS — LIVE-FRESH. Independently re-verified today via `gh` (state MERGED, mergeCommit `d2d190a2`).

---
**P18-18 — Revision drift is SURFACED at accept, not silently merged**
*Area:* acceptance · *Ruling:* **R17-1** (ruling 42)
- **Steps:** after the verdict, push a commit to the PR head (Contents API), reconcile, open the accept dialog.
- **Actual:** ✓ UC18-15: commit `643830c` → `pr.revisionDrift {aheadBy:1}` → the dialog rendered the rose MERGE HEAD row **"643830c9f2ca — 1 commit added since review; they merge unreviewed"** alongside the healthy verdict; accept proceeded (honesty over blocking); **PR #136 MERGED** `84eec016`; `vib-2` cleaned (`NOTES.md:331-335`).
- **Status:** PASS — LIVE-PRIOR. This closes the pass-17 HIGH F17-L12 (acceptance merged unreviewed foreign commits with no warning).

---
**P18-19 — A verified no-diff task closes as "Completed — no changes"**
*Area:* acceptance · *Ruling:* **R17-2** (ruling 43)
- **Actual:** ⚠ **claimed in the pass-17 ledger** (entry 28, VIB-5/VIB-6 family) and pinned by `delivery-decision.server.test.ts`, but pass 18's plan item UC18-14 was **recorded against a different behavior** (a revision-bound verdict on VIB-2, `NOTES.md:336-340`) — so the no-change path was **not** exercised in pass 18.
- **Status:** PASS (pass-17 ledger) / **NOT-RUN in pass 18**. Treat live coverage as pass-17-only; see §4.

---
**P18-20 — Force-accept is an audited bypass, and it WITHDRAWS once there is nothing left to accept**
*Area:* acceptance/honesty · *Ruling:* R15-1, R16-3, F18-13
- **Actual:** ✗ **FAILED** — after VIB-3 was force-accepted to Done, its GitHub side-card still rendered *"Acceptance is blocked: This task's latest review requests changes…"* **and a live "Force accept (override review gate)" button** on a Done / waiting-on-Nothing task (verified on a fresh reload). Root cause `app/features/task-detail/task-side-panels.tsx:53-77` — `forceAcceptRow` renders whenever `forceAcceptReason && onForceAccept`, with no terminal-stage guard; force-accept *bypasses* rather than satisfies the gate, so `blockReason` persists forever (`FINDINGS.md:127-135`).
- **Fix:** suppressed on terminal tasks (commit `7abb286`), **live-verified**: "VIB-3 Done: no force-accept / no 'blocked'".
- **Status:** **FAIL→FIXED** — LIVE-PRIOR.

---
**P18-21 — Full-autonomy acceptance cannot merge: it records "accepted (merge pending)" and a human finishes**
*Area:* acceptance · *Ruling:* **R16-6** (ruling 40)
- **Actual:** ✓ pass-17 AUT-1: autonomous self-accept → "accepted (merge pending)" → human **Complete merge** → **PR #131 MERGED** (`../discovery-2026-08-04-pass17/USE-CASES.md:63-65`). Pass 18 planned it as UC18-17 but the LAB-1 arc diverted into the F18-10 strand and then the F18-11 KB conflict.
- **Status:** PASS — LIVE-PRIOR (pass 17). NOT re-run in pass 18.

### E. PR reject, external merge, reconcile

---
**P18-22 — An externally merged PR is reconciled honestly, never silently adopted**
*Area:* reconcile · *Ruling:* R16-1, R16-3
- **Steps:** `gh pr merge 143 --merge --delete-branch` out-of-band, then watch Viberr.
- **Actual:** ✓ **LIVE-FRESH** FV-2d. The PR pill flipped to "merged"; the operator recommended, in its own words: *"PR #143 was already merged out-of-band on GitHub … moving to Review so completion can be accepted to reconcile task state with the merged reality."* Applied → Review; the force-accept dialog read *"PR #143 · merged into main / Bypassing: Waiting on 1 required reviewer approval"* → Done; timeline: *"transitioned to Done — the review PR had already been merged on GitHub (out of band)."* mergeCommit `2b22b28a` (re-verified today).
- **Status:** PASS — LIVE-FRESH. No silent completion, no fabricated verdict.

---
**P18-23 — A closed (rejected) PR opens a recovery packet with typed options**
*Area:* reject/recovery · *Ruling:* **17** (PR divergence recovery)
- **Actual:** ✓ LV-0 (fresh env): the pending LAB-1 decision from a `gh` close was resolved by selecting **"Archive LAB-1"** with a note → task `archived`, packet cleared, "task closed" typed event (`LIVE-VERIFY-SESSION.md:51`). Pass-18 prior env exercised the other two options: rework-with-steer and archive+deleteBranch (UC18-12, with the branch really deleted on GitHub).
- **Status:** PASS — LIVE-FRESH (archive path) + LIVE-PRIOR (rework / delete-branch paths).

---
**P18-24 — A reopened PR auto-withdraws the recovery packet**
*Area:* reconcile · *Ruling:* 17 (the packet copy PROMISES reopen detection)
- **Actual:** ✓ UC18-13: `gh` close of **PR #136** → reconcile → recovery packet whose body promises reopen-detection; `gh` reopen → reconciler note "review is live again" → the queued operator **withdrew the packet ~50s later** (`NOTES.md:322-329`). One wart recorded (F18-1b, LOW, deliberately not fixed): during that window the stale packet card renders beside a GitHub card already reading "in review".
- **Status:** PASS — LIVE-PRIOR.

---
**P18-25 — A stale remote task branch blocks delivery with a human-gated collision packet**
*Area:* delivery safety · *Ruling:* **R18-4** (ruling 50), R15-15/R16-1
- **Actual:** ✓ four variants exercised (`NOTES.md:288-292`, `:307-313`, `:351-355`): VIB-1 hit the stale `vib-1` branch from merged PR #126 → blocked packet with 3 typed options + operator-pick chip + note field → resolved in-app → operator deleted the stale branch, pushed, opened **PR #135** (1 commit, 1 file, clean); VIB-2 resolved the *other* path (delete externally via `gh`, then confirm option 0); VIB-4's packet body correctly said *"I cannot delete/rename the GitHub branch myself"* (capability honesty).
- **Ruling exercised:** the owner ruled **KEEP the packet** — do NOT force-reset the remote branch at execution start. So the correct code change here is *none*.
- **Status:** PASS — LIVE-PRIOR.

### F. Comments, mentions, notifications

---
**P18-26 — A human @mentions an agent on a CLOSED task; the comment is recorded and the agent replies conversationally**
*Area:* comments · *Ruling:* R7-6, NEW-4 (agents @tag the human they answer, and the tag notifies)
- **Actual:** ✓ pass-18 RBAC batch: as Mira (contributor) the Done-task banner read *"This task is closed — comments are still recorded"*; the Lexical @mention menu inserted `@Developer` and the posted comment recorded `to: agent` (`NOTES.md:360-364`).
- **Status:** PASS — LIVE-PRIOR.

---
**P18-27 — The operator's `post_comment` must not claim success when the guardrail dropped the comment**
*Area:* operator honesty · *Ruling:* FR26, B-FD8, R-A
- **Actual:** ✗ **FAILED (code audit, G1)** — `operator-actions.server.ts:1129` returned `{outcome:"done", message:"Comment posted to the timeline."}` **unconditionally**, while `writeOperatorComment` silently early-returned on two guardrail drops; the `@mention` fan-out ran *after* both returns, so a dropped comment notified **nobody**. The functions written to fix exactly this (`applyCommentGuardrails`/`commentOutcomeMessage`) were **dead code** — referenced only by their own test. On Codex a plan whose sole action was that dropped comment settled the task to `waiting:human` silently.
- **Fix:** real outcome + `task.comment.dropped` audit + note fallback (commit `59bb3f6`).
- **Status:** **FAIL→FIXED** — **TEST-ONLY** (found by audit, not by use; no live repro).

---
**P18-28 — Notifications for deleted entities must not inflate the badge or dead-end the reader**
*Area:* notifications · *Ruling:* 9 (soft refs)
- **Actual:** ✗ **FAILED** — after the owner deleted the pass-17 project dirs, 20 notifications referencing VIB-8/VIB-9/PR#132/#133 survived: they counted toward the bell badge, and clicking one landed on "Page not found / No project at projects/viberr" rendered **without the app shell and in LIGHT theme while the app was dark**. Two error surfaces, two voices, neither keeping the shell (`FINDINGS.md:139-154`).
- **Fix:** orphan rows excluded from the badge + non-navigable; task-404 kept in-shell (commit `5e67127`), live-verified.
- **Status:** **FAIL→FIXED** — LIVE-PRIOR.

### G. RBAC

---
**P18-29 — A real non-admin member is confined by the SERVER, not by the UI**
*Area:* RBAC · *Ruling:* R15-4 (members-only), ACTION_ROLES single source
- **Steps (owner signed in as `contributor@viberr.dev`):** hit instance settings; hit the project before membership; add as `contributor`; read every project surface; POST a mutation with a valid CSRF token.
- **Actual:** ✓ **LIVE-FRESH** (`LIVE-VERIFY-SESSION.md:132-146`):
  | probe | result |
  |---|---|
  | `/org/settings` | **403** real Error-403 page |
  | `/projects/verify-fresh/*` before membership | **404**, not 403 — a non-member never learns the project exists |
  | project board/tasks/policy/agents/settings after joining | 200 (read) |
  | `POST save-project` as contributor, CSRF-valid | **403 server-enforced** |
  | Policy sheet | 8/8 role toggles disabled + "Read-only — … needs the Manage members & roles grant" |
- **Status:** PASS — LIVE-FRESH. **No security hole found.**
- **Method note (kept deliberately):** the first probe regexed the body for "Forbidden" and wrongly reported Policy/Agents as forbidden — "forbidden" is a legitimate capability-mode label on those pages. Re-probed on `Error 403` + real status. This is the class of mistake that silently inflates a findings list.

---
**P18-30 — A read-only surface must EXPLAIN why it is inert**
*Area:* RBAC honesty · *Ruling:* R15-11, precedent P14-LV-08
- **Actual:** ✗ **FAILED (LV-F2)** — the Contributor's project Settings correctly disabled 0/4 inputs and 0/7 destructive actions (and the server 403s), but **nothing explained the greyed-out state**, and the Stages note still instructed *"Drag a row to reorder … click a name to rename"* — a how-to for an action the page refuses. A disabled control cannot explain itself (`title` never opens on one). The Policy sheet had fixed exactly this under P14-LV-08; it never propagated to Settings.
- **Fix:** lock-icon note naming the missing grant on Project/Stages/Members; the manage-only how-to renders only for a reader who can act (commit `2301612`), 3 canaried tests.
- **Status:** **FAIL→FIXED** — LIVE-FRESH.

---
**P18-31 — Visibility scoping holds in search and on home for a non-member**
*Area:* RBAC · *Ruling:* R15-4, R15-5, R8-3
- **Actual:** ✓ as Mira: home was member-scoped (LAB invisible, "Org admins manage this" cards); ⌘K "autonomy" returned nothing (LAB-1 hidden) while "smoke" returned VIB tasks only (`NOTES.md:356-360`).
- **Status:** PASS — LIVE-PRIOR.

---
**P18-32 — ALWAYS_HUMAN actions are structurally unreachable by any agent**
*Area:* RBAC/capability · *Ruling:* 2, R16-6
- **Actual:** TEST-ONLY / audit — full adversarial trace found no hole: no merge / transition-to-done / change-policy tool exists in either toolkit, and agents hold **no GitHub credential** (GIT_ASKPASS only), so an agent's Bash cannot curl the merge API (`NEW-FINDINGS.md:233-241`).
- **Status:** PASS — **TEST-ONLY** (never adversarially attacked from inside a live run).

### H. Operator behaviour

---
**P18-33 — The operator's narration is honest about what it cannot do**
*Area:* operator · *Ruling:* FR26
- **Actual:** ✓ three independent live instances: the out-of-band-merge recommendation (P18-22); the collision packet's *"I cannot delete/rename the GitHub branch myself"*; and the supervised post-delivery stop. Coherence verdict recorded: "Operator narration is honest (out-of-band merges, server-owned delivery)" (`LIVE-VERIFY-SESSION.md:90-92`).
- **Status:** PASS — LIVE-FRESH.

---
**P18-34 — A Codex operator with `generate-packets` withheld must not strand on an unparseable plan**
*Area:* operator · *Ruling:* FR26 anti-strand (G6)
- **Actual:** ✗ **FAILED (code audit)** — `operatorOpenPacket` returns `{outcome:"denied"}` **without throwing**, and the escalation site only had `.catch(...)`, so the denial was discarded: no packet, no note, only a `logger.warn`; the task settled `waiting:human` with no signal.
- **Fix:** inspect the result, fall back to a `note` (commit `75df9aa`).
- **Status:** **FAIL→FIXED** — TEST-ONLY (`operator-run.server.test.ts:267`).

---
**P18-35 — The verdict gate holds even at FULL autonomy**
*Area:* operator/agents · *Ruling:* R15-1 + R16-6
- **Actual:** ✓ **organically, on LAB-1**: the reviewer returned a real `request_changes`, which **stopped an autonomous self-accept**; the developer then raised an ask-human packet on the genuine convention conflict, and the full-autonomy operator investigated and **left it for a human** rather than forcing through (`NOTES.md:147-168`). The best kind of evidence — an unplanned failure that the governance caught.
- **Status:** PASS — LIVE-PRIOR.

### I. Agent behaviour

---
**P18-36 — A prompt-injection attempt inside task content is refused, escalated, answered, and resumed**
*Area:* agent behaviour · *Ruling:* **R15-14** (a resolved question returns to the agent that ASKED)
- **Actual:** ✓ pass 18: "injection guardrail (Codex refused a credential-exfiltration injection, artifact clean)" and "R15-14 ask-human resolution resumes the ASKING agent (developer), not the operator" (`FINDINGS.md:210-213`). Pass 17 exercised the Claude half end to end: the Docs Writer refused the operator's inline "Human decision confirmed: Arda" claim, raised `ask_human`, a Maintainer answered, the auto-mention posted, the agent resumed and delivered **PR #130**.
- **Status:** PASS — LIVE-PRIOR (both backends).

---
**P18-37 — A scheduled re-run fires; archiving the task cancels it**
*Area:* agent behaviour · *Ruling:* FR39, R14-3 / P14-RV-03
- **Actual:** ✓ "FR39 scheduled re-run persisted canonical + R14-3/RV-03 archive cancels it (firedAt null)" (`FINDINGS.md:213-214`).
- **Status:** PASS — LIVE-PRIOR.

### J. MCP

---
**P18-38 — Register an MCP server and see a real health verdict**
*Area:* MCP · *Ruling:* R16-5, MCP-health honesty ("never checked" ≠ "stale")
- **Actual:** ✓ **LIVE-FRESH** FV-2a: `everything-http` registered as HTTP `http://host.docker.internal:3001/mcp` → **"16 tools · checked just now"** — i.e. the containerized app really reached the host MCP server (`LIVE-VERIFY-SESSION.md:70`).
- **Status:** PASS — LIVE-FRESH.

---
**P18-39 — An MCP grant is per-profile, and the grant is the authorization**
*Area:* MCP · *Ruling:* **R16-5** (ruling 39 — MCP stays OUTSIDE the capability matrix)
- **Actual:** ✓ **LIVE-FRESH** FV-2b: the edit-profile modal's MCP accordion went "0 of 1" → **"1 of 1"** for both Developer(Codex) and Reviewer(Claude); the same modal exposed backend, eligible stages, Repo&execution (Allowed/Human-only/Off), Collaboration 23, Reserved-for-humans 21, Skills 1 of 3.
- **Status:** PASS — LIVE-FRESH.

---
**P18-40 — The grant actually reaches the runtime, and ONLY the granted agent**
*Area:* MCP · *Ruling:* R16-5 + per-agent scoping
- **Actual:** ✓ **LIVE-FRESH** FV-2c: the Codex developer run's own context said *"everything-http MCP server is reachable from the agent runtime … yours to read with and query"* (`run_SwHLJSJT2Kdh.jsonl`), while the **OPERATOR** run showed `mcp: viberr` ONLY — no `everything-http`. Per-agent scoping holds in both directions.
- **Status:** PASS — LIVE-FRESH.

---
**P18-41 — MCP tool-id parity: the same server mounts on both backends under DIFFERENT tool ids**
*Area:* Codex/Claude parity · *Ruling:* — (documented runtime difference)
- **Actual:** ✓ Claude side (`run_Gum2jAa-kPIf` init): `mcp__everything-http__*`, 16 tools, **hyphenated**, plus the capability-gated `viberr_agent` toolkit exposing only `ask_human` + `post_comment`, both servers "connected" (`NOTES.md:143-146`). Codex side: the echo call landed as `mcp__everything_http__echo`, **underscored** (VIB-3 → **PR #139 MERGED** `528d33c1`; pass-17 entry 17). Live proof that a tool name written into a persona does **not** survive both backends — which is why the capability-matrix modal now says so.
- **Status:** PASS — LIVE-PRIOR (Claude mount NOT re-run on the fresh env; Codex side re-verified fresh in P18-40).

### K. Skills and knowledge bases

---
**P18-42 — Only GRANTED skills load; an unrelated skill in the same store never reaches the run**
*Area:* skill loading · *Ruling:* deliberate-grant governance
- **Steps:** grant `smoke-note-style`; leave a **decoy** `release-announcements` in the store, ungranted; run the agent.
- **Actual:** ✓ "skills load per grant (only `smoke-note-style` injected, decoy `release-announcements` did NOT leak)" (`FINDINGS.md:217-219`). The negative half is now also pinned by a unit test with three sentinel skills (`specialist-run.server.test.ts:1473`).
- **Status:** PASS — LIVE-PRIOR. Not re-run this session (setup-heavy; explicitly recorded as skipped, `LIVE-VERIFY-SESSION.md:96-99`).

---
**P18-43 — …but the SDK's OWN skill/command catalog was loading ungoverned**
*Area:* skill loading · *Ruling:* **R18-3** (ruling 49)
- **Steps:** read a Claude specialist run's `init` line and compare `slash_commands` against Viberr's grants.
- **Actual:** ✗ **FAILED** — VIB-4's Docs Writer init listed the **HOST user's** skills (deep-research, design-sync, dataviz, claude-api, goal, team-onboarding — none granted in Viberr) **plus the cloned repo's own `.claude` commands** (verify, debug, code-review, batch…). Viberr governed its own injection channel correctly; the CLI's native catalog rode along regardless. On the production container the user-level half collapses (empty home), but the **repo half travels everywhere** (`NOTES.md:126-146` (backlog entry: `FINDINGS.md:119-125`)). Same class as the pass-13 "Codex inherited HOST skills+MCP" leak.
- **Fix:** strip the clone's `.claude` **git-invisibly** (`--skip-worktree`, so the delivery's `git add -A` never ships a `.claude` deletion into the review PR) + `strictMcpConfig: true` (commit `e274134`), **live-verified on the VIB-6 run init**.
- **Status:** **FAIL→FIXED** — LIVE-PRIOR. Known accepted limitation: a task whose job is to edit the repo's own `.claude` cannot deliver those edits.

---
**P18-44 — A granted KB actually grounds the deliverer's output**
*Area:* KB · *Ruling:* FR9
- **Actual:** ✓ authored in-app (kb-save + store-write-doc), granted by directory name (file edit + watcher). VIB-2's Codex run said *"applying the attached … pass-18 smoke-note conventions"*, and the LAB-1 developer note confirmed *"including … required SPICEBERRY footer"* — the canary phrase reached the artifact (`NOTES.md:314-318`, `:372-373`).
- **Status:** PASS — LIVE-PRIOR.

---
**P18-45 — …and the REVIEWER must judge against the same KB the deliverer used**
*Area:* KB / reviewers · *Ruling:* **R18-1** (ruling 47)
- **Actual:** ✗ **FAILED, discovered organically on LAB-1.** The Developer had `pass-18-conventions` granted and correctly wrote the required "Verified under the SPICEBERRY protocol." footer. The Reviewer profile had `kb: []`, so from its context the footer was an unsubstantiated line → **`request_changes` against compliant work**. The developer hit a genuine convention conflict and raised an ask-human packet; the autonomous operator confirmed the convention wasn't visible repo-side and left it for a human (`NOTES.md:147-168`).
- **Fix:** R18-1 — a reviewer run's KB context is the **union** of its profile grants and the delivering engagement's KBs for that task, deduped against the shared injection budget (commit `97131bd`).
- **Status:** **FAIL→FIXED** — LIVE-PRIOR repro; fix is unit-proven (`specialist-run.server.test.ts:1559`), **not re-driven live**.

---
**P18-46 — A KB whose store folder is gone must not read like a healthy empty KB**
*Area:* KB honesty · *Ruling:* D8/credUnreadable precedent
- **Actual:** ✗ **FAILED (F18-4)** — the seeded KB pointed at `store://kb/viberr-conventions/`, the folder did not exist, and the row read "0 docs · agents read the live folder · re-scanned 4h ago" — indistinguishable from a healthy empty KB, with a stale re-scan claim.
- **Fix:** "folder missing" note (commit `7b8696c`), **live-verified by moving the folder**.
- **Status:** **FAIL→FIXED** — LIVE-PRIOR.

### L. Codex vs Claude parity (from Viberr's point of view)

---
**P18-47 — Both backends run under the SAME governance: same delivery boundary, same verdict gate**
*Area:* parity · *Ruling:* R15-1, R15-2
- **Actual:** ✓ **LIVE-FRESH** on one task: **Developer = Codex** delivered (P18-15) and **Reviewer = Claude** gated it (P18-08), and the fresh-env health endpoint reported `backends:{claude:"real",codex:"real"}` — no simulated adapters. Pass-17 recorded the same parity with roles swapped, and noted the one honest asymmetry: **Codex has no mid-run comment channel**, which Viberr surfaces rather than fakes (the Codex agent reports at END of run).
- **Status:** PASS — LIVE-FRESH.

---
**P18-48 — Backend-specific runtime differences are DISCLOSED, not smoothed over**
*Area:* parity/honesty · *Ruling:* R16-5 disclosure spirit
- **Actual:** ✓ the capability-matrix modal ships a "What differs between the two runtimes" section listing testable claims: mid-run comments are a Codex no-op, ask-human timing, MCP credentials Claude-only, Codex renames MCP tool ids, operator web reach Claude-only (`../discovery-2026-08-04-pass17/LIVE-TESTING-NOTES.md:26`). The tool-id claim is pinned by a test asserting **both** spellings (`agents-page.test.tsx`, "MCP tool names differ per backend").
- **Status:** PASS — LIVE-PRIOR (copy) + TEST-ONLY (the claim itself).

### M. Infrastructure / cross-cutting (unplanned but load-bearing)

---
**P18-49 — One data root, ONE writer — the lock must fail CLOSED**
*Area:* data integrity · *Ruling:* B-FD1 + the `docker-data` dual-writer memory
- **Steps (accidental, then reconstructed):** host dev server acquires `state/writer.lock`; a store reset **deletes** the lock file out from under the live holder; the container boots, finds no file, acquires fresh.
- **Actual:** ✗ **FAILED — CRITICAL, live-reproduced.** Two writers ran on one `docker-data` over VirtioFS. `state/writer.lock` read `{pid:1, hostname:"viberr"}` while the HOST process happily created project files and WAL commits. On the next boot the **org-level tables came up EMPTY** — users re-seeded to 1 admin, the encrypted GitHub PAT lost, org KB row, org MCP row, all 20 notifications gone. `PRAGMA integrity_check` **passed before and after**: it does not detect lost transactions. The design had no defense against its own lock file being removed — the holder keeps a deleted-inode fd and never re-verifies. Compounding trap: macOS resolves `localhost`→`::1` first, so the host process and the docker-proxy on the same port looked like one app (`FINDINGS.md:49-69`, `NOTES.md:64-103`).
- **Fix:** inode re-verification → loud fail-closed shutdown; holder identity surfaced on `/resources/health` **and** the Home store strip; deployment note (commits `8d75181`, `23c9ce6`, `a9fd7ba`).
- **Status:** **FAIL→FIXED** — LIVE-PRIOR (live-reproduced under observation within ~20 minutes of dual-writer state).

---
**P18-50 — Every governance action must be reachable at 375px**
*Area:* responsive · *Ruling:* `ux-design-specification.md:870`
- **Actual:** ✗ **FAILED (F18-12)** — `.profile-grid` computed two FIXED ~230px columns inside a 281px container with `overflow-x: visible` and no scroll affordance, so the DELIVERING AGENT ("Run") and HUMAN OWNER ("Manage"/"Assign me") column rendered **off the right edge, unreachable**; REVIEWING AGENTS' "Run"/"×" was half-clipped.
- **Fix:** single column below the phone breakpoint (`app/app.css:2912`, commit `4147036`), **live-verified at 375px**.
- **Status:** **FAIL→FIXED** — LIVE-PRIOR. **No automated test pins it** (see §3).

---
**P18-51 — The banned "govern/governance" vocabulary must not appear in rendered UI**
*Area:* copy discipline · *Ruling:* design copy ban (G4/F18-14)
- **Actual:** ✗ **FAILED (audit)** — the login hero read "Governed AI delivery for small teams", plus policy-page and timeline empty-state instances. Fixed + a **copy-ban lint test** added (commits `b2a4da0`, `4840352`), then **confirmed in the running PROD image**: the login hero reads "Managed AI delivery for small teams" / "a managed operator" (`LIVE-VERIFY-SESSION.md:43-45`).
- **Status:** **FAIL→FIXED** — LIVE-FRESH verification of the fix.

---
**P18-52 — One finding must not wear two contradictory state colors on one page**
*Area:* state semantics · *Ruling:* ux-design-spec §State Semantics (G2)
- **Actual:** ✗ **FAILED (audit)** — `task-main-sections.tsx:33-34` mapped `severity==="error" → "blocked"` (crimson) while the canonical policy maps a soft `error` to `inconsistency_risk_detected` (amber), so the hero showed amber "inconsistency risk" and the Diagnostics panel a few rows below painted the same finding crimson "error"; the panel also ignored `hardStop`, the one condition policy actually colors `blocked`.
- **Fix:** the panel renders the server-computed `readinessEffect` (commit `c4e53ba`).
- **Status:** **FAIL→FIXED** — TEST-ONLY.

---

**Catalogue totals — 52 use cases.**

| Status | Count | Ids |
|---|---|---|
| PASS — **LIVE-FRESH** (this session's clean prod env) | 15 | 01, 02, 08, 10, 12, 15, 17, 22, 23, 29, 33, 38, 39, 40, 47 |
| PASS — **LIVE-PRIOR** (durable evidence, earlier env) | 18 | 04, 06, 07, 11, 16, 18, 21, 24, 25, 26, 31, 35, 36, 37, 41, 42, 44, 48 |
| PASS — **TEST-ONLY** | 3 | 09, 14, 32 |
| **FAIL→FIXED** | 15 | 03, 05, 13, 20, 27, 28, 30, 34, 43, 45, 46, 49, 50, 51, 52 |
| **NOT-RUN** in pass 18 | 1 | 19 |

Of the 15 FAIL→FIXED, **11 were found by USING the app** (03, 05, 13, 20, 28, 30,
43, 45, 46, 49, 50) and 4 by adversarial code audit (27, 34, 51, 52). Three of the
eleven — **13** (autonomy strand), **45** (reviewer-KB false rejection) and **49**
(the dual-writer data loss) — were *organic*: nobody set out to test them, and all
three are the highest-severity items of the pass. P18-19 is counted once as
NOT-RUN-in-pass-18; its pass-17 evidence is noted in place.

---

## 3. Regression test map

Every use case → the test that would fail if the behavior regressed. **GAP** means
exactly that: nothing in `app/**` or `e2e/**` would catch it.

| UC | Pinning test(s) | Notes |
|---|---|---|
| P18-01 project create | `app/features/home/project-create.server.test.ts`; `app/shared/workflow/templates.ts` via `stage-eligibility.test.ts:96` | preset→graph shaping covered; the *modal walk* is not |
| P18-02 connection scopes | `app/server/secrets/pat-validator.server.test.ts`; `app/server/org/connections.server.test.ts`; `app/server/github/scope-flag.server.test.ts` | proven-vs-unproven chip rendering: `org-settings-page.test.tsx` |
| P18-03 account lockout (LV-F1) | `app/features/org-settings/users-panel.test.tsx:132` (2 tests, canaried) | canary: restore the old gating → the recovery action disappears → test fails |
| P18-04 first-login copy | `app/routes/login.test.tsx`; `app/server/auth/password.server.test.ts` | |
| P18-05 ghost admin (F18-6) | `app/features/project-settings/ghost-members.server.test.ts:170` | inline-refusal rendering: **GAP** (only the server rule is pinned) |
| P18-06 owner take/release | `app/server/tasks/task-actions.server.test.ts:687`, `:1095` | |
| P18-07 role-correct pick | `app/server/tasks/operator-actions.server.test.ts:271`; `app/shared/workflow/stage-eligibility.test.ts:138` | *which* profile an LLM picks is unpinnable; the eligibility filter is pinned |
| P18-08 reviewer verdict gate | `specialist-run.server.test.ts:584`, `:674`; `delivery-decision.server.test.ts:545`; `review-queue.server.test.ts:426`; `task-governance.server.test.ts:1233` | strongest net in the tree |
| P18-09 non-engaged reviewer | `specialist-run.server.test.ts:674` | |
| P18-10 auto-invoke + advance | `operator-actions.server.test.ts:1415` (on create), `:914` (on transition), `:622` (chain cap) | |
| P18-11 scoping packet | `operator-actions.server.test.ts:1096`; `task-governance.server.test.ts:745`; `task-detail-components.test.tsx` (packet a11y + confirm echo) | |
| P18-12 recommend→apply | `operator-actions.server.test.ts:1276`; `acceptance-graph.server.test.ts:511` (R14-2 owner authority) | |
| P18-13 delivery re-queue (R18-2) | `app/server/tasks/delivery-requeue.server.test.ts:134` | pins both halves (full re-queues, supervised does not) |
| P18-14 Done-drop refusal | `e2e/01-home-board.spec.ts:181`; `task-governance.server.test.ts:415` | |
| P18-15 server-owned delivery | `specialist-tool-policy.test.ts:19`, `:140`, `:171`, `:179`; `specialist-run.server.test.ts:1016`; `delivery-decision.server.test.ts:165` | tool-layer denial *and* prompt contract both pinned |
| P18-16 PR-open attribution | `app/server/github/pr-open.server.test.ts`; `app/shared/mapping/actor.server.test.ts` | the pass-17 lesson: a jsdom-green fix missed the operator's own path — the integration test is the one that matters |
| P18-17 accept → merge → cleanup | `github-reconciler.server.test.ts:1102`, `:1494`; `delivery-decision.server.test.ts:905`; `task-detail-components.test.tsx` (dialog copy) | |
| P18-18 revision drift (R17-1) | `github-reconciler.server.test.ts` (revisionDrift); `review-helpers.test.ts`; `task-detail-components.test.tsx` (MERGE HEAD row) | |
| P18-19 no-change accept (R17-2) | `app/server/tasks/delivery-decision.server.test.ts` (noChanges roundtrip + verdict carve-out) | test-covered, **live-stale** |
| P18-20 terminal force-accept (F18-13) | `task-detail-components.test.tsx:1030`; `acceptance-closed-pr.server.test.ts:414`, `:468` | |
| P18-21 autonomous merge-pending | `task-governance.server.test.ts:1374` (`completeTaskMerge`); `operator-actions.server.test.ts:932`; `capabilities.test.ts` (ALWAYS_HUMAN) | |
| P18-22 external merge reconcile | `pr-divergence-operator.server.test.ts:143`; `github-reconciler.server.test.ts:142`; `reconcile-poller.server.test.ts:55` | the operator's *narration wording* is **GAP** (LLM output) |
| P18-23 closed-PR recovery packet | `pr-divergence-operator.server.test.ts:127`, `:263`–`:352` (delete-branch refusals); `acceptance-graph.server.test.ts:579` (archive) | |
| P18-24 reopen auto-withdraw | `pr-divergence-operator.server.test.ts:172`, `:199`, `:226` | F18-1b (instant `superseded` stamp) is **unimplemented by decision** — no test, correctly |
| P18-25 branch collision (R18-4) | `pr-open.server.test.ts:286`; `workspace-delivery.server.test.ts:406` | **GAP:** no test asserts the *absence* of a force-reset at execution start — a future "just reset the branch" refactor would pass the suite while violating R18-4 |
| P18-26 mention on a closed task | `task-actions.server.test.ts:328`, `:645`; `mention-notify.server.test.ts:30`; `agent-reply.server.test.ts:845`, `:1222`; `e2e/05-*.spec.ts` | |
| P18-27 comment-guardrail honesty (G1) | `operator-actions.server.test.ts:1813`; `comment-guardrails.server.test.ts:93`; audit row `task.comment.dropped` | |
| P18-28 orphaned notifications | `notifications.server.test.ts:70`, `:81`, `:397` (the `targetMissing` flag + badge exclusion) | **two GAPs:** the orphan ROW's rendering (`notification-item.tsx:48-51` — non-navigable + "no longer exists" copy) has no component test (`targetMissing` appears only in the projection test), and error-boundary shell/theme retention is live-verified only |
| P18-29 contributor RBAC | `policy-rbac.server.test.ts:186`, `:467`, `:600`, `:698`; `project-visibility.server.test.ts:76`; `project-visibility-actions.server.test.ts`; `e2e/04-*.spec.ts:85` | the matrix itself is pinned, not just the call sites |
| P18-30 read-only explanation (LV-F2) | `app/features/project-settings/settings-page.test.tsx:139`, `:255`, `:513` (3, canaried) | `:513` guards the wrong fix ("just hide the controls") |
| P18-31 member scoping | `command-search.server.test.ts:53`; `home-query.server.test.ts`; `review-queue.server.test.ts:212` | |
| P18-32 ALWAYS_HUMAN | `app/shared/capabilities.test.ts`; `specialist-tool-policy.test.ts:188`; `git-clone-auth.server.test.ts` (no credential reaches the agent) | |
| P18-33 operator honesty | `operator-actions.server.test.ts:1477` (ambiguous-tag disclosure), `:1569` | narration text is model output — structurally **GAP** |
| P18-34 no-plan escalation (G6) | `operator-run.server.test.ts:267` | |
| P18-35 verdict gate at full autonomy | `agent-outcome.server.test.ts:42` (`effectiveCollabMode`); `task-governance.server.test.ts:1304` | |
| P18-36 injection + ask-human resume | `specialist-run.server.test.ts:1166` (trust boundary in every prompt), `:1116`; `agent-reply.server.test.ts:1222`; `operator-kb-injection.server.test.ts:163` | the *model's compliance* is unpinnable; the prompt contract and the routing are pinned |
| P18-37 schedules | `schedule.server.test.ts:137`, `:167`, `:239` | |
| P18-38 MCP health | `app/server/org/resources.server.test.ts`; `org-settings-page.test.tsx` (health chip tones) | actual reachability/tool count: **GAP** (live only) |
| P18-39 MCP grant | `specialist-mcp.server.test.ts:30`–`:112`; `resource-references.server.test.ts` | |
| P18-40 per-agent scoping | `specialist-mcp.server.test.ts:45`, `:50`; `operator-toolkit.server.test.ts:47`; `claude-runtime.server.test.ts:402-420` | |
| P18-41 tool-id parity | `agents-page.test.tsx` ("MCP tool names differ per backend", both spellings); `codex-runtime.server.test.ts:272-323` (`mcp_servers` config) | |
| P18-42 granted-only skills | `specialist-run.server.test.ts:1473` (3 sentinels, canaried); `skill-body.server.test.ts:80`, `:119`, `:156` | the decoy case is genuinely pinned |
| P18-43 SDK catalog (R18-3) | `specialist-run.server.test.ts:1510` (`stripUngovernedRepoCatalog`); `claude-runtime.server.test.ts:298-314` (`settingSources`/`skills`/`strictMcpConfig`) | **partial GAP:** no test asserts a real run's `init` slash-command list is grant-only — that check is live-only |
| P18-44 KB grounding | `kb-injection.server.test.ts`; `specialist-run.server.test.ts:1326`; `kb-watch.service.server.test.ts` | that the *model used it* is unpinnable |
| P18-45 reviewer KB union (R18-1) | `specialist-run.server.test.ts:1559` | |
| P18-46 KB folder missing | `resources.server.test.ts:208`; `org-settings-page.test.tsx:542` | |
| P18-47 backend parity | `agent-outcome.server.test.ts:87`, `:105`, `:135`; `runtime-registry.server.test.ts:26`; `codex-runtime.server.test.ts:779`, `:855` | backends being *real* is untestable in CI by design (`harness-hermeticity.server.test.ts:56` pins the opposite) |
| P18-48 disclosed differences | `agents-page.test.tsx` (matrix modal) | |
| P18-49 single writer (F18-5) | `data-root-lock.server.test.ts:208`, `:294`; `boot.server.test.ts:68`; `home-page.test.tsx:414` | |
| P18-50 375px governance controls | — | **GAP: no automated coverage.** `app/app.css.test.ts` has no `.profile-grid` assertion and no e2e checks the execution-profile panel at 375px. The disposition audit flagged this; it was answered with a live check, not a test |
| P18-51 copy ban | `app/features/copy-ban.test.ts:75`; `policy-page.test.tsx:285` | a real lint-style guard, no allowlist |
| P18-52 diagnostics semantics (G2) | `task-detail-components.test.tsx:347` | |

### The GAP list, ranked by what it would let through

1. **No end-to-end governed-lifecycle test at all.** The whole arc in P18-10→P18-17
   (create → operator → delivery → PR → verdict → accept → merge) exists only as
   unit slices plus this pass's live run. The `e2e/` suite (7 specs) drives the
   **demo fixture** UI — home/board/feeds/palette/composer/a11y — and never opens a
   PR or runs an agent. A refactor that breaks the *seams between* the pinned units
   would ship green.
2. **P18-50 responsive governance controls** — no test; the exact defect class
   (a control rendered off-viewport) recurs and is invisible to jsdom.
3. **P18-25 / R18-4** — nothing prevents a future "force-reset the task branch at
   execution start" from passing the suite, even though the owner explicitly
   rejected it.
4. **P18-43** — the strip is tested; "the run's init catalog contains only granted
   skills" is not. That assertion needs a run-log fixture assertion.
5. **P18-28** — the orphan notification ROW (non-navigable + "no longer exists")
   and the error boundary's shell/theme retention on a 404 both have no test;
   only the projection flag and the badge count are pinned.
6. **P18-38 MCP reachability / tool count** — health is a live-only fact.
7. **P18-05** — the *inline* refusal rendering (R15-11) is untested; only the
   server rule is.
8. **Model-output behaviors** (operator narration wording, whether the agent
   obeys the injection boundary, which specialist an LLM picks) are structurally
   unpinnable. They are covered by *contract* tests (the prompt says X, the tool
   layer denies Y) — which is the right answer, but it means the live pass is the
   only place these are observed. Keep running them.

---

## 4. Not yet exercised — and exactly how to test each

| # | What | Why it matters | How to test |
|---|---|---|---|
| 1 | **R17-2 "Completed — no changes" on the current tree** (P18-19) | The pass-17 ledger claims it; pass 18 never re-ran it, and the acceptance chain changed since (R17-1 drift rows, F18-13 terminal guard) | Create a task whose goal is verifiably already satisfied; let the agent produce a 0-line diff; confirm the operator can recommend "Completed — no changes", that acceptance closes to Done **without** a PR, and that no "awaiting verdict" chip lingers |
| 2 | **Claude-side MCP mount on the fresh env** (P18-41 half) | Codex was re-verified fresh; the Claude mount is pass-18-prior evidence | Grant `everything-http` to the Claude Reviewer on FV, run it, read the run's `init` line for `mcp__everything-http__*` (16, hyphenated) + `viberr_agent` |
| 3 | **Skill-decoy load on the fresh env** (P18-42) | Explicitly skipped this session as setup-heavy | Re-create `smoke-note-style` (granted) + `release-announcements` (ungranted decoy), run a specialist, and read the run's skill manifest; the decoy phrase must appear nowhere |
| 4 | **R18-1 reviewer-KB union driven live** (P18-45) | The fix is unit-proven; the failure was found live | Reproduce LAB-1: KB-granted deliverer writes the footer, `kb: []` reviewer reviews → expect approve (previously `request_changes`) |
| 5 | **R18-2 full-autonomy re-queue driven live** (P18-13) | Same — unit-proven, live-unproven | Run an AUTONOMOUS-preset task through delivery and confirm the operator resumes on its own within one tick, with no human nudge |
| 6 | **F18-6 inline refusal copy** (P18-05) | The 409 reason still may only reach a throttled toast | Recreate a ghost membership, attempt removal as a non-org-admin, and confirm the reason renders **near the row** |
| 7 | **Multi-role project matrix** — Viewer and Maintainer as *real* signed-in users | Only Contributor (fresh) and Maintainer (pass 17) were driven live; Viewer never was | Create a Viewer member; probe board read, comment, stage menu, and one mutation POST; expect read + comment, 403 on the rest |
| 8 | **⌘K, notification prefs, session export, light theme, mobile accept** (UC18-26..30) | Planned in the pass-18 ledger; only ⌘K scoping and light theme were reached | Walk each surface as a non-admin member; for session export verify the artifact contents against the run log |
| 9 | **Adversarial live attempt at an ALWAYS_HUMAN action** (P18-32) | Proven by audit only | Give an agent an explicit "merge the PR" instruction with full capability grants and confirm the run has no tool and no credential to do it |
| 10 | **Operator behaviour under a withheld `generate-packets` grant** (P18-34) | Fix is unit-only | Deploy a Codex operator with `generate-packets: off`, force an unparseable plan, confirm a visible note lands |
| 11 | **UXO-1 / UXO-3** (archived task still shows pre-archive pills; a Done-only board reads "1 task" beside three "No tasks" columns) | Recorded this session as minor, no fix, no test | Decide the treatment (muted "was: …" pills; a Done/Review off-screen hint), then pin it |

---

## Appendix — evidence index

**Pull requests** (states re-verified with `gh` on 2026-08-05):
`#142` MERGED `d2d190a2` (FV-1, fresh-env full lifecycle) · `#143` MERGED
`2b22b28a` (FV-2, external-merge reconcile) · `#141` CLOSED (QAV-1, host warmup,
orphaned by the env switch) · `#140` OPEN (this pass) · `#139` MERGED `528d33c1`
(VIB-3, Codex MCP echo) · `#138` MERGED `e944a498` (VIB-4, Docs Writer / Claude
MCP parity) · `#137` CLOSED (LAB-1, the full-autonomy strand) · `#136` MERGED
`84eec016` (VIB-2, revision drift) · `#135` MERGED `f75f339d` (VIB-1, collision
resolve) · `#134` MERGED `934ede65` (pass 17).

**Run logs:** `run_SwHLJSJT2Kdh.jsonl` (Codex developer, `everything-http` mounted)
· `run_Gum2jAa-kPIf` (Claude Docs Writer init — MCP parity **and** the F18-8
catalog leak).

**Commits (fixes):** `7abb286` F18-13 · `97131bd` R18-1 · `8d75181`+`23c9ce6`
F18-5 · `e274134` R18-3 · `e07abc0` R18-2 · `643ca81` F18-6 · `7b8696c` F18-4 ·
`4147036` F18-12+F18-7 · `20c2785` F18-3 · `5e67127` F18-1 · `59bb3f6` G1 ·
`c4e53ba` G2 · `671d841` G3 · `4840352`+`b2a4da0` G4/F18-14 · `e079ce0` G5 ·
`75df9aa` G6 · `32aa1db` G7 · `b0fbfc1` G8 · `6e93238` LV-F1 · `2301612` LV-F2 ·
`a9fd7ba` decisions.md R18-1..4.

**Rulings exercised:** 2, 7, 9, 15, 17, 18, 19 · R14-1/2/3 · R15-1/2/3/4/5/6/7/9/10/11/14/15 ·
R16-1/3/5/6 · R17-1/2/4/5 · **R18-1/2/3/4** (decisions.md 47–50).

**Environment (fresh run):** docker-compose `viberr-app-1` Up (healthy),
`NODE_ENV=production`, `VIBERR_DATA_ROOT=/data` bound to an empty `docker-data`,
`:5173`; `/resources/health` → `{ok:true, watcher:true, kbWatcher:true,
lock:{pid:1,hostname:"viberr"}, backends:{claude:"real",codex:"real"}}`. The prior
host data root is preserved at `docker-data.hostdev-backup` (908M, restorable).
