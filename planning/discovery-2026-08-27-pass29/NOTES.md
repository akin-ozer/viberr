# Pass 29 — Discovery notes (2026-08-27)

Branch: `fix/pass29-findings` off `origin/main` @ e789ce7.
Live surface: docker container `viberr-app-1` on :5173 (docker-data volume, real creds, both backends real).
Login: arda@viberr.dev (admin). Instance is lived-in: 1 project (`viberr` → akin-ozer/viberr), 1 task (VIB-1 in Review, PR #232 open), 0 KBs / 3 skills / 2 specialist profiles + operator.

Docs being built by subagents in this folder: DOC-product-intent.md, DOC-codebase-map.md, DOC-agent-runtime.md, DOC-browser-capability.md, DOC-mcp-kb-skills.md, DOC-rbac-delivery-events.md.

---

## Open questions for the owner (raise, don't block)

- **OQ1 — PR #232 / VIB-1.** A real, unmerged 14-file feature (adds a Frontend/Design specialist profile + a repo-grounded "Repo conventions" KB, wired into seeds). It's in Review waiting on a human. It is NOT on main. Merging it contradicts the "only small files for testing" guidance, and it looks like a genuine owner decision. Plan: leave it untouched; ask whether to accept/reject/ignore. My live tests will use a SEPARATE new project against akin-ozer/viberr.

---

## RESOLVED / verified-by-design (not fixing)

- **F1 — DROPPED (by design).** `agents-query.server.ts:130-140` deliberately maps `mode:human` → `forbidden` → "Reserved for humans", with an explicit NEW-3 comment distinguishing `human` ("reserved for a human") from `off` ("withheld"). Operator/`execute-code`=human faithfully means "operator defers code execution to a human/deliverer." Cross-profile differences (developer=Acts directly, operator=Reserved, reviewer=Not granted for the same row) are informative per-column semantics, not an inconsistency. The old-project Reviewer/`commit-push`=red came from Arda's manual grant, not the seed. No change.

## Candidate findings (verify in code before fixing)

- **F1 — Capability matrix: "Reserved for humans" overloaded.** [SUPERSEDED — see RESOLVED above] The matrix renders per-profile `mode:human` grants on NON-ALWAYS_HUMAN actions with the same red "Reserved for humans" state used for the true ALWAYS_HUMAN trio.
  - Operator / "Execute code or write to the repo" → "Reserved for humans" (but Reviewer, also without the grant, shows "Not granted").
  - Reviewer / "Commit & push to the branch" → "Reserved for humans" (but Operator shows "Not granted").
  - Effect: red state reads as "this action is globally human-only" when it actually means "this profile holds the cap at mode:human." Inconsistent rendering for two agents that both simply lack the grant. Verify: capability-matrix render component + seed profile grant modes (agent-catalog.server.ts). Decide whether the seed profiles should even carry `mode:human` on caps like commit-push/execute-code, or whether the matrix should collapse human-mode-on-non-reserved to "Not granted"/"Recommends".

- **F2 — Browser cap: chromium binary existence never verified (browser focus).** `resolveBrowserMcp` (specialist-browser-mcp.server.ts) checks only that the `@playwright/mcp` CLI script is on disk, not that the chromium binary exists. A broken/missing chromium install fails silently deep inside a run instead of surfacing a clean refusal like every other gate in this subsystem. Also: NO e2e coverage of the real Playwright MCP child process. (from browser-cap doc agent — verify + design a clean pre-flight refusal.)

## Observations (not necessarily bugs)

- No built-in profile grants `use-browser` (Drive a live web browser) or github_read (Read GitHub repo & PR data) by default. To exercise the browser capability I must create/edit a profile granting `use-browser` (+ egress, which the cap is coupled to).
- Capability matrix modal does not wheel-scroll in the Browser pane (had to read via JS). Minor; possibly a pane quirk, not the app.
- Full capability matrix (Operator / Developer / Reviewer) captured — see raw JS dump in session; delivery caps concentrated on Operator (assign/summon/packets/deliver/transitions-recommend/accept-recommend), implementation on Developer, review/verdict on Reviewer.

## UI surfaces surveyed (live :5173, docker-data)

- **Dashboard** `/` — greeting, project grid/list, "N decisions waiting", Settings summary cards (GitHub connections, Users & access, Agent resources), Insights link. Org settings at `/org/settings?tab={connections,users,resources}` + `/insights`.
- **Project nav** `/projects/viberr/{board,review,agents,policy,github,activity,settings}`.
- **Board** — 5 stages Triage/Ready/In Progress/Review/Done; filter chips (All / Waiting on me / Agent working / Blocked / No activity); Board/List toggle; Re-scan; New task.
- **Task detail** — richest page: PR/branch/diff/commits panel; Current state (stage/waiting-on/owner); Accept completion → Done + Archive; Details (priority/labels/due); Permissions ("V1 rules") explaining the viewer's grants; Goal; **Operator recommendations (Apply/Dismiss cards)**; Execution profile (Operator / Delivering agent / Reviewing agents / Human owner, each Run-able); **Agent logs** stream viewer (SDK session id, raw NDJSON, follow/history, load-older).
- **Agents** — Profiles / Live / **Capability matrix** / Add from library / New profile; per-profile eligible stages + capability policy; "customized for viberr" = project-diverged from org template.
- **Policy** — two panes: Human access (RBAC 4-role grid) + Agent capability (per-profile direct/recommend/human counts) + ALWAYS RESERVED FOR HUMANS trio.
- **GitHub** — repo/connection/scope-health (repo + pull_request:write proven), linked PRs, execution branches. Real akin-ozer connection (PAT tail ····k3ui).
- **Activity** — Stream (Humans/Agents/System, typed events) + Audit logs (policy & access). Operator's VIB-1 reasoning visible here.
- **Instance settings → Agent resources** — Knowledge bases (0), MCP servers (0), Skills (3: developer/reviewer/viberr-app-expertise), Global agent profiles (Developer, Reviewer). KB "New" modal: name→`store://kb/<slug>/`, Empty/From-files, on-change/manual re-index; "every run loads the live folder either way."
- Not yet exercised (will do in testing): New project flow, New task composer, MCP add modal, profile create/edit modal + grant UI, Insights page, Review queue.

## More candidate findings / observations

- **Operator honesty (good, not a bug):** On VIB-1 the operator disclosed `npm run lint` is still red (25 anti-slop errors) yet still recommends Accept — deviation-from-acceptance-signal disclosure working as designed. Also correctly stated it cannot self-create profiles/KBs (no write tool; execute-code mode=human).
- **F1 reframed:** Operator carries `execute-code:human`, Reviewer carries `commit-push:human` (→ Reviewer "4 human" on Policy). These are deliberate seed grants. The smell is the *label*: "Reserved for humans" is shown identically for (a) the global ALWAYS_HUMAN trio and (b) a single profile's `mode:human` on a non-reserved cap, AND renders inconsistently across profiles (Operator commit-push="Not granted" vs Reviewer commit-push="Reserved for humans"; Reviewer execute-code="Not granted" vs Operator execute-code="Reserved for humans"). Decide: is a per-profile human-mode grant on a non-ALWAYS_HUMAN cap meaningful, and should the matrix distinguish it from the true reserved trio?
- Org has 0 KBs / 0 MCPs — clean slate for the create-KB / add-MCP use cases. The 4 demo SKILL_SEEDS (conventional-commits, terraform-review, api-design, changelog-writer) are NOT present on this volume; only the 3 agent-expertise skills are.

---

## LIVE RESULTS (executed use cases)

### UC1 / UC8 / UC14 — Browser capability end-to-end (FOCUS) — PASS ✅
Task VQP-1 "Screenshot example.com as evidence" on VQP (Balanced). Fully autonomous, correct:
- **UC1** operator auto-invoked at create (cloned a bare repo mirror first — one-time per-project cost, clone-% progress shown; F27-U1).
- **UC8** operator SELECTED the right agent: engaged **Web QA** (the browser specialist) as a *supporting* agent (task forbids repo writes), @mentioned it with precise instructions, started its run. Free-form selection reasoning worked.
- **UC14** Web QA (Claude/Sonnet) drove real chromium via Playwright MCP → screenshot WITHOUT filename → saved to `attachments/page-…Z.png` (real 1280×720 PNG, valid magic) + a11y snapshot `.yml`; reported H1 "Example Domain"; no branch/PR.
  - Timeline renders the screenshot as a clickable thumbnail; evidence filename + `.yml` linkified ("by Web QA"); Attachments panel present.
  - Member serving: **200 image/png**, 17781 bytes, `CSP: sandbox; default-src 'none'`, `x-content-type-options: nosniff`.
  - Anonymous serving: **302 → /login** (member-only, requireUser first). Traversal path also 302 (auth-gate-first).
- Under Balanced, operator then RECOMMENDS "Move to Review" (Apply/Dismiss); acceptance correctly blocked ("VQP-1 is at In Progress, not Review").
- Container verified browser-ready: `/usr/bin/chromium` (Chromium 151), `VIBERR_BROWSER_EXECUTABLE` set, `@playwright/mcp` 0.0.79.

⚠️ **Rate limit:** operator run logged `seven_day utilization 0.91` (account near its 7-day cap). Be economical with real Claude runs.

## Confirmed browser-focus findings (for implementation phase)

- **F2 (confirmed latent) — no chromium-binary pre-flight in `resolveBrowserMcp`.** Only `@playwright/mcp` CLI script is checked; `VIBERR_BROWSER_EXECUTABLE` existence/executability is NOT. A broken chromium install would fail deep in the run, not as a clean disclosed refusal like the egress gate. Fix: add a pre-flight stat/executable check → `UnresolvedMcpGrant` refusal with a human-readable reason. (specialist-browser-mcp.server.ts ~:124-150)
- **F4 (browser doc #6) — Codex screenshot-invisibility not disclosed in the profile editor at grant time.** The `--image-responses omit` asymmetry (Codex can't see screenshots) is disclosed in the capability-matrix modal + persona, but NOT when an admin ticks "Drive a live web browser" on a Codex-pinned profile. Fix: a small inline note in the CapabilityGrants browser row when backend===codex.
- **F5 (browser doc #2) — no health/degraded signal for browser infra.** Unlike Codex-auth/model availability, a broken/missing chromium looks identical in the UI to a healthy one until a run is spent. Consider a boot/health probe + `browserUnavailable` on the deployed-specialist view.
- **F6 (browser doc #3) — no e2e/integration test spawns a real Playwright MCP child.** The default-name-vs-filename output-dir behavior (the whole persona strategy) is unpinned folklore. Add a test that drives the real cli.js.

## F3 (from agent-runtime doc) — operator `accept_completion` tool description drift (verifying)
The operator's own accept tool description reportedly claims a merge "is completed when GitHub is reachable" — false for the operator's path (mergeTaskPr requires a human userId; operator acceptance is always "accepted, merge pending"). Verify exact string + fix.

## F3 — CONFIRMED (operator accept_completion tool-description drift)
- Tool desc (`app/server/tasks/operator-toolkit.server.ts:688`): "Under FULL autonomy … **the real merge is completed when GitHub is reachable**, otherwise it is left 'merge pending'…"
- Actual behavior (`app/server/tasks/operator-actions.server.ts:2806 operatorAcceptCompletion`): ALWAYS `prState: "accepted"` (:2939) and writes "**accepted, merge pending** (a human merges it)" (:2956). Comment at :2920 confirms mergeTaskPr requires a human userId → operator can never merge.
- The full-autonomy clause is copied from the HUMAN/supervised path (where "merges when GitHub reachable" IS correct because a human applies the card). Under full autonomy it's false and risks the operator narrating a merge that never happens (which the same description warns against).
- **Fix:** rewrite the FULL-autonomy clause to state the operator's acceptance always records "accepted, merge pending" (a human merges later), independent of GitHub reachability. Keep the supervised clause as-is.

### UC17 / UC19-setup — Codex parity + failure handling — PASS ✅ (Codex quota-blocked)
- **Codex is quota-blocked until Sep 18, 2026** (provider: "You've hit your usage limit… try again at Sep 18th, 2026 5:20 PM"). Auth is valid (health codex:real) but the account limit is hit — so no live Codex execution is possible this pass.
- Viberr handles it uniformly & honestly (parity from viberr's eye):
  - Operator assigned the Codex Developer, created branch `vqp-2`, and started the run like any Claude run.
  - **Run-inputs disclosure** proved correct assembly: "delivering engagement · persona 11157 chars · prompt 5704 chars · **1 skill · 1 knowledge base · 1 MCP server**" — the granted skill (developer-expertise, injected into the 11k persona since Codex has no native skill channel), KB (pass29-qa-handbook) and MCP (qa-echo) all reached the Codex run.
  - On failure it raised a **"Work stalled: pick a recovery path" blocked packet** disclosing the provider quota text, with recovery options: **Retry on Claude** (operator pick), Redirect with sharper guidance, Send back for another attempt, Hold for runtime debugging, Write your own directive.
- **Retry on Claude** (F27-B1 pinnedBackend): confirming it switched the engagement to `backend: claude` AND set `pinnedBackend: claude` (sticks for later runs on this task), then started a Claude delivery run. retry_other_backend works.
- NOTE for owner: a true live Codex vs Claude behavioral A/B (tool-name underscores, unauthenticated MCP, advisory repo-write) is NOT possible until Codex quota resets Sep 18. Verified structurally (run-inputs, config assembly) + via code. Claude side runs live below.

## F7 — CONFIRMED (stale delivery-conflict packet not superseded by a successful direct delivery)
Repro: a delivery-push-conflict blocked packet is open (remote branch held unrelated commits). Human clears the remote branch out-of-band and clicks the GitHub panel's **"Deliver branch & open PR"** button. Result: the push+PR succeed (PR #233 opens, panel shows "PR #233 · in review"), BUT:
- Task stays `stage: impl, readiness: blocked, waiting: human`.
- The blocked packet still displays "Delivery push conflict … **no PR opened**" — directly contradicting the "PR #233 · in review" panel on the same page.
- Re-running the operator does NOT reconcile it (operator can't resolve a human-owned packet; it left recommendations: []).
Effect: contradictory UI; the task is stuck blocked until the human manually resolves the now-stale packet.
**Fix idea:** when a delivery succeeds and a PR is recorded for the task, auto-resolve/supersede any open `blocked` delivery-conflict packet for that task (and clear the readiness floor), or have the operator's reconcile detect PR-open and close the packet. At minimum the packet's "no PR opened" text should not persist once a PR exists.
Files: task-actions delivery path (deliver_for_review / direct deliver) + operator reconcile; packet lifecycle. (browser panel "Deliver branch & open PR" → server delivery action.)

### UC9 / UC18 / UC19 — KB load + skill fence + MCP tool call (Claude) — PASS ✅
From VQP-2 Claude developer run (run_enKz891dvwma) logs:
- **Run-inputs disclosure:** "delivering engagement · persona 6810 chars · prompt 4951 chars · 1 skill · 1 knowledge base · 2 MCP servers". init: "claude-sonnet-5 · 14 tools · mcp: qa-echo, viberr_agent · cwd …/workspace/viberr".
- **UC18 skill fence:** SDK invoked Skill tool with EXACTLY `developer-expertise` (the only grant) → "Launching skill: developer-expertise", base dir `…/workspace/viberr/.claude/skills/developer-expertise`. NO unrelated skills (reviewer-expertise / viberr-app-expertise / the coding-assistant's own bundled design skills) present. Two-layer fence (skill-mount copies only granted folders + SDK skills:[exact]) confirmed.
- **UC19 MCP:** Claude tool name `mcp__qa-echo__qa_echo` (server hyphen preserved, `__` separator). Called with `codex-mcp-works` → `QA-ECHO: codex-mcp-works`. Live tool call ✓. Only qa-echo + internal viberr_agent MCPs mounted (no extraneous servers).
- **UC9 KB:** developer quoted `PASS29-KB-TOKEN: NARWHAL-3141-VIBERR` verbatim (unique seeded token) → KB genuinely loaded and read.
- **Architecture (F-GH3):** the developer commits locally and does NOT push/open PR ("Per the workspace contract, I did not push or open"); viberr's SERVER owns push+PR on delivery. Codex tool-name underscore vs Claude hyphen divergence unverifiable live (Codex quota-blocked) but documented.

### UC11 (again) + UC12 — reviewer verdict + accept + REAL merge — PASS ✅
- VQP-2 moved to Review → Reviewer (Claude, supporting engagement) ran in an ISOLATED support clone `…/workspace/support/reviewer/viberr` (P8 per-engagement workspace isolation confirmed).
- Reviewer had "1 skill · 1 knowledge base · 1 MCP server". It **inherited the deliverer's KB** (R18-1) → legitimately quoted `PASS29-KB-TOKEN: NARWHAL-3141-VIBERR`; it did NOT inherit the deliverer's MCP (qa-echo absent, only internal viberr_agent) → correctly noted qa_echo wasn't in its toolset and cross-checked the developer's result against the echo server source. Honest, no confabulation. (KB inherited, MCP not — sensible.)
- Verdict: approve, revision-bound; validation → healthy.
- **Accept disclosure (with PR):** "MERGES: PR #233 · in review → into main", REVISION 21d348c, VERDICT healthy, "Merging is one-way." (vs VQP-1's "Nothing merges").
- Accept → Done & merge: **PR #233 MERGED** (mergeCommit 725bf5c, mergedAt 10:00:56Z), VQP-2 → Done, task.md pr.state: merged, timeline "review PR was merged", file `docs/qa/pass29-codex.md` (35 bytes) now on main. Small file, no bloat.

### Branch-collision + retry-on-Claude + operator recovery — PASS ✅ (bonus)
- Codex delivery quota-failed → operator raised "Work stalled" blocked packet → **Retry on Claude** set `pinnedBackend: claude` (F27-B1) and re-ran on Claude.
- Claude delivery hit a real branch collision (remote `vqp-2` held a closed pass-27 PR #223's commits) → viberr REFUSED to force-push/open-PR over stale content, raised a "Delivery push conflict" blocked packet with safe options (delete/rename branch → retry / new branch / deliberate force-push). Correct R18 behavior. Cleared stale branch via gh → redelivered → PR #233 opened cleanly. See F7 for the stale-packet coherence gap.

### UC13 — Reject flow (external PR close → recovery → branch deleted) — PASS ✅
- VQP-3 delivered PR #234 (Claude, clean — pre-cleared stale vqp-3 branch). Closed #234 via `gh pr close` (maintainer reject).
- Viberr GitHub page still cached "in review"; **"Update status"** reconciled → `pr.state: closed`, `waiting: agent`.
- Operator auto-ran → raised **input packet "PR #234 closed without merging — choose recovery path"** with options: Rework and reopen (rec), Archive keep branch, Archive & delete branch.
- Applied **Archive & delete branch** → proper destructive confirmation ("Deleting it cannot be undone; restoring the task does not bring the branch back") → task archived (record/timeline/audit kept), **remote vqp-3 branch deleted (404)**, local workspace branch discarded. Full reject→recovery→branch-deleted verified.

### UC15 (browser egress refusal) + F3 autonomy — verifying in code below

### UC6 — RBAC — verified (code + live plumbing + Users&Access flow)
- Chokepoint `resolveProjectAuthority` (app/server/auth/project-authority.server.ts): live role from project.md members[] vs single-source ACTION_ROLES; org-admin override audited (`project.org_admin.override`); DENY writes an audit row (NFR10).
- ACTION_ROLES tiers viewer(0)⊂contributor(1)⊂maintainer(2)⊂admin(3): comment=[A,M,C,V]; create-task=[A,M,C]; accept-completion & run-agents=[A,M]; force-accept=[A].
- Live: created `qa-tester@viberr.dev` (Member, temp password, setup-pending) via Allow-access; added as VQP **viewer** (project_members projection updated). Non-member/no-session → /login redirect. (Full curl viewer-denial blocked by Secure-cookie-over-http + setup-pending mechanics, not viberr RBAC.)
- CLEANUP TODO: remove qa-tester test user + its VQP viewer membership at end.

### UC4 — ownership take/release — verified (UI + panel)
- Task pages show "Assign me" (take) + owner controls; Permissions panel (V1 rules) for admin: "Task ownership: Take / release · you can release anyone". Ownership changes audited. (Full lifecycle seen across VQP-1/2/3.)

### UC21/UC22 — autonomy ceiling — verified (config + code)
- completion-for-acceptance grant exists (operator, mode recommend under Balanced); would be `direct` under Autonomous → operator can accept→Done itself (disclosed). But operator NEVER merges (F3: mergeTaskPr needs human userId → always "accepted, merge pending"). Autonomy is per-project preset (Strict/Balanced/Autonomous), not run-picked (rulings 92/94/97). New-project modal discloses the exception.

---

## FINDINGS BACKLOG for implementation (all CONFIRMED)
- **F2** [browser] resolveBrowserMcp: no chromium-binary existsSync check → silent deep failure. FIX: pre-flight stat + disclosed refusal. (specialist-browser-mcp.server.ts ~:133)
- **F3** operator accept_completion tool description falsely claims full-autonomy merge "completed when GitHub is reachable" — operator never merges. FIX: correct the full-autonomy clause. (operator-toolkit.server.ts:688)
- **F4** [browser] Codex screenshot-invisibility not disclosed in the profile editor at grant time. FIX: inline note in CapabilityGrants browser row when backend===codex. (create-profile-modal.tsx)
- **F5** [browser] no health/degraded signal for browser infra (unlike Codex-auth/model). FIX: boot/health chromium probe → browserUnavailable on deployed-specialist view (complements F2).
- **F6** [browser] no e2e/unit test drives the real Playwright child / pins default-name-vs-filename output-dir behavior. FIX: add test(s).
- **F7** stale delivery-conflict blocked packet not superseded by a successful direct "Deliver branch & open PR"; contradictory "no PR opened" vs "PR #NNN in review"; operator can't clear a human-owned packet. FIX: auto-resolve/supersede the packet when a PR is recorded.
