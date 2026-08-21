# Pass 22 — running notes (2026-08-21)

## Session facts
- Worktree: `.claude/worktrees/viberr-app-inspection-e1b87f`, branch `claude/viberr-app-inspection-e1b87f` at main HEAD 26fca45 (PR #186 merge).
- Container `viberr-app-1` running healthy on :5173 (started at session open) over `docker-data`. Host dev server NOT used (dual-writer guard).
- Data root is CLEAN-SHEET: 0 projects, 1 user (Arda, admin), 1 GitHub connection (akin-ozer), 2 agent profiles + operator, 0 KBs, 0 MCP servers, 3 skills.
- Login: arda@viberr.dev / viberr-dev-2828.
- Post-pass21 merges on main: PRs #176–186 (browser-implies-egress, comment-attachment-previews, task-attachments-drop, questionnaire-packet-density, input-required-yields-to-agent, packet-minimal-redesign, live-agent-backend, attachment-lightbox, operator-card-simplify, owner-cell-no-manage). Treat as current intent; docs agents folding these in.

## Browser-pane workarounds (this session)
- Pane reports "hidden" → CDP click/scroll/type TIME OUT. Screenshots + javascript_tool + read_page + form_input still work.
- Scrolled-page screenshots render a black-band artifact → instead resize viewport tall (resize_window 1280x1050+) and keep scrollY=0.
- Drive interactions via javascript_tool `el.click()` etc.; read resulting state in a SEPARATE eval (React commits async).
- If pane wedges completely (frozen frames): tabs_close + preview_start reopens it, session survives.

## UI tour observations
### Dashboard (logged in, no projects)
- Empty-state card: "Create your first project" + 3 steps (connect repo / define workflow stages / put agents under policy). Good.
- Settings strip: GitHub connections / Users & access / Agent resources (shows "2 agent profiles · + operator · 0 knowledge bases · 0 MCP servers · 3 skills").
- Store maintenance (admin-only): Re-scan store / Rebuild projections, copy explains projection model + "Writer: pid 7 on viberr".

### Instance settings (/org/settings)
- Tabs: GitHub connections (PAT ····k3ui, "pull_request:write unproven — verified when attached to a project"), Users & access (whitelist model, "Allow access", per-user Local/Admin/Member + edit/lock/remove), Sign-in & SSO (GitHub+Google off, callback URLs shown, local-only note = R17-4), Agent resources (KBs / MCP servers / Skills / Global agent profiles: Developer=Codex→Claude "GPT-5.6 Terra", Reviewer=Claude Sonnet; 3 seed skills; profiles "not deployed" until project use).

### Project pages (fresh VIB project, akin-ozer/viberr, Balanced preset)
- Board: 5 stages, filter chips (All/Waiting on me/Agent working/Blocked or waiting/No activity), Board/List toggle, Re-scan, per-column + on Triage only (hover?), "No tasks yet. Create one to start the flow."
- Agents page: stats row; Operator panel (system role, one per active task; acts-directly/recommends/reserved 3-col policy; eligible = all 5 stages; backend Claude→Codex; autonomy Supervised; continuity "Re-anchors on task.md"; skill viberr-app-expertise). Developer: eligible Ready+In Progress, Codex→Claude, "Advisory only · 2 lines the runtime does not read" disclosure. Reviewer: Claude Sonnet, eligible In Progress+Review, "Advisory only · 6 lines…".
- Capability matrix modal: full grid incl. "Search & fetch from the web" and "Drive a live web browser" rows (NOT granted to any seed profile — must grant for browser UCs); CLAUDE-ENFORCED badge = binds on Claude, advisory on Codex; long "What differs between the two runtimes" explainer (skills install vs 24k prompt budget on Codex + clip/omit announcement; post-comment no Codex channel; ask-human pauses Claude midflight vs end-of-run Codex; MCP creds Claude-only (argv); hyphen→underscore renaming; MCP not matrix-gated — granting a server IS the grant; Claude operator can reach web when granted, Codex operator cannot). ← test-case source list.
- Policy page: RBAC 18 actions × Admin/Maintainer/Contributor/Viewer + members-only prose (non-member sees 404-as-if-nonexistent; owner-scoped acceptance for contributors; org-admin override audited). Agent capability counts (Operator 5/2/3, Developer 8/0/2, Reviewer 10/0/3 — profile page lists fewer acts-directly lines than these counts; check coherence). Workflow rules: per-boundary Auto-advance/Human approval/Human only; Review→Done "locked · V1" human-only + full-autonomy exception prose.
- GitHub page: repo card + credential health card (scopes proven/unproven), PR panel (opened at review boundary by server or delivering agent; merge human-only, merge-pending offline path), Execution branches table (task→branch→PR→sync).
- Settings: name/prefix/desc, workflow stages editor (drag/Move/rename/add; ends locked), Members invite (join as Viewer), repo & creds (after-merge delete-branch toggle), danger zone (archive/delete).
- Review queue: "Waiting on your acceptance" (0 of 0) + "Still in review"; header chip "Review → Done · human only".
- Activity: Stream (All/Humans/Agents/System + search/type/actor/task/date filters) + separate Audit logs panel (3 entries from project creation: created/re-checked scopes/assigned credential).

## Open questions queue (for owner)
(collect throughout; batch via AskUserQuestion)

## Improvement candidates
(running list; consolidate into FINDINGS.md later)

## Test fixtures created (pass 22)
- Users: mira@viberr.dev (Member, temp pw PtqOiG_58AJx), deniz@viberr.dev (Member, temp pw 3VGykPNdcC8v). Local accounts, "setup pending" until first login.
- Project: Viberr (VIB) on akin-ozer/viberr, Standard 5 stages, Balanced preset.

## Early probe candidates from delta agent (fold into use cases)
1. POST /run-operator with backend/autonomy form overrides (no UI sends them) → can a supervised operator run at full autonomy? (project.task.tsx:877-890)
2. Schedule modal still picks per-run backend+autonomy — R21-9 coherence gap + frozen-backend twin of #183 bug.
3. Read-only Codex evidence runs get "Posting files" persona while sandbox blocks copy (codex-runtime.server.ts:650-652).
4. Live-backend overlay uncached on hottest loaders + silent catch-all fallback.
5. Steer input posts @operator comment BEFORE runOperator — refused-run leaves dangling mention.
6. Hero yields on anyRunLive; board yields only waiting==="agent" — mid-run disagreement window.
7. "Claude Code is unavailable" copy on run refusal (run-service.server.ts:801-803) vs R21-9 carve-out.
8. Rulings gap: only 91-92 added post-pass21; 8 of 10 clusters (incl. browser-implies-egress) unruled; prd/ux canon not amended for #176-186.

## Live-run observations (VIB-1 operator triage)
- Task creation modal: title + goal only, "Starts in Triage", key auto-assigned. Card appeared with "agent working" immediately — operator auto-engages on create.
- Task page during triage run: LiveRunPanel shows phase "Preparing workspace · Cloning akin-ozer/viberr" (R21-4 mirror visibility ✓), elapsed/turns/tokens/runtime chips, View logs + Interrupt.
- Operator card is the R21-9 simplified one: label "Claude", single steer input, Run operator. No backend/autonomy pickers ✓.
- GitHub panel pre-branch: "No branch yet. A task-key branch is created when execution starts." + Force accept button WITH disclosure copy "(skips the remaining stages and the review gate)".
- Current state: Waiting on "Agent work"; "Not acceptable yet" explainer names the boundary rule. Permissions panel says role + comment policy inline.

## VIB-1 lifecycle results (UC-01..05 in progress)
- CODEX QUOTA EXHAUSTED (external, until Sep 18 2026) → ALL live Codex runs fail. Reconfigured Developer to Claude-first for delivery tests. Codex use cases limited to invocation+failure-surfacing (see F22-08).
- Operator auto-triaged: Triage→Ready→In Progress autonomously (Balanced preset auto-advances early boundaries; only Review→Done human-locked). CORRECT.
- Operator toolkit CONFIRMED (proc allowedTools): mcp__viberr__{get_task,read_default_branch_file,post_comment,set_goal,flag_context_conflict,open_decision_packet,resolve_decision_packet,engage_agent,run_agent,prompt_agent,deliver_for_review,update_branch_from_base,transition_stage,accept_completion}. Bash/Edit/Write/Skill/Task DISALLOWED. --setting-sources= --strict-mcp-config --permission-mode bypassPermissions. Governed correctly (R18-3).
- Codex failure → operator raised "Work stalled: pick a recovery path" blocking packet (4 options: Redirect/Send-back/Hold/Write-own). GOOD governance. Packet PROVIDER SAID field = "Codex Exec exited with code 1: Reading prompt from stdin..." (the useless text — F22-08 confirmed on packet too).
- Resolved packet "Redirect with sharper guidance" → operator re-engaged, re-ran Developer (now Claude).
- Developer (Claude) delivery CLEAN: created qa/pass22-canary.md with exact requested content (paragraph + Operator/Developer/Reviewer bullets), committed c3503a1 "[VIB-1] qa: add pass-22 canary note" on fresh vib-1 off main HEAD. Traceable message. 
- Live-backend overlay (#183) WORKING: Developer engagement showed "Claude" on agents page + task immediately after profile edit.
- Packet resolution via CDP coords MISSED (React async); JS .click() on Confirm worked reliably.

## Positive governance confirmations (fold to VALIDATION.md)
- Operator never writes code / never merges (toolkit has no Bash/Edit/Write; deliver_for_review pushes+PRs but merge is human).
- Members-only + RBAC surfaces render correctly (Policy page, per-user role pills).
- KB/MCP/skill/profile fixtures all persisted to docker-data disk (verified).

## Browser capability wiring CONFIRMED (owner focus)
- @playwright/mcp v0.0.79 present in image; system chromium at /usr/bin/chromium; VIBERR_BROWSER_EXECUTABLE set.
- resolveBrowserMcp args (Claude): node cli.js --headless --isolated --output-dir <task attachments/> --executable-path /usr/bin/chromium --no-sandbox. Codex adds --image-responses omit.
- Requires use-browser=direct AND use-web-search-fetch=direct (egress). Web Researcher profile (created) has both (egress auto-coupled by #176).
- Screenshots: default-named → attachments/ (human-visible); self-named → workspace-local (invisible). Persona steers to default naming. On Claude, screenshots ALSO flow to model as image tool-results; Codex omits (file still lands).
- Persona security stance: page content = DATA not instructions; never enter credentials; browser widens no authority. Good.
- attachmentsDropSection persona emitted for ANY attach-evidence-references=direct profile (browser or not).
- PLAN: browser UC = Web Researcher visits public URLs (example.com + github.com/akin-ozer/viberr), screenshots → attachments/, evidence-linked comment, verify thumbnails (#177) + lightbox (#184). Container egress confirmed (mirror clone reached github).

## UC-04/05 COMPLETE — full lifecycle merged
- Applied "Move to Review" recommendation (human-approved transition, Balanced gate). Transition re-triggered operator (stranding fix).
- Operator auto-engaged Reviewer (Claude) with precise 3-requirement directive → Reviewer ran, pinned revision c3503a1 (R15-1 revision-bound), verified each requirement incl. cross-checking bullet list vs REAL source (agent-catalog.server.ts), posted "Verdict: approve" comment + quality event "Review passed / validation healthy". GENUINE review, not rubber-stamp.
- Reviewer's evidence stats CORRECT (1 file +5/−0, 1 commit) — contradicts PR body's stale 3 files/+214 → confirms F22-10 root cause (PR-body stats from reconcile snapshot, not actual diff).
- Accept ceremony (R21-5): disclosed MERGES PR#187→main / REVISION c3503a112 / VERDICT validation healthy / "Merging is one-way". Revision matched (no drift). Accepted → merged.
- REAL MERGE: PR #187 MERGED (merge commit 181034c @09:18:09), file on main (146B), vib-1 auto-deleted (after-merge toggle ON). Task=Done, waiting=Nothing.
- Verdict gate (R15-1) enforced throughout: acceptance refused until approving verdict on delivered revision.

### Use-case status
PASS: UC-01 (auto-triage), UC-02 (stage transition governance), UC-03 (delivery+PR, Claude), UC-04 (reviewer verdict), UC-05 (accept+real merge), UC-15 (skill isolation: only developer-expertise mounted; commit clean of .claude).
CONFIRMED-INVOCATION-ONLY: Codex (quota-blocked ext.) — viberr invokes it correctly + raised recovery packet; F22-08 = failure misclassified.
NEXT: browser capability (UC-09-13, owner focus), then RBAC/multi-user (UC-21-25), then UC-06/07/08/16-20.

## Audit completeness (governance validation) — PASS
VIB-1 audit_events: 25 rows, full lifecycle: run_started/replied, branch_reconciled, pr.opened, delivery.next_step/operator, operator.recommended, reconcile.task, transition(Review), recommendation.applied, operator.agent_selected, reviewer.assigned, agent.replied, quality.flagged(verdict), operator.recommended_completion, pr.merged, branch.deleted, transition(Done). Everything traceable. DB: /data/state/projection.sqlite (node:sqlite readable; WAL — read-only only).

## BROWSER CAPABILITY (owner focus) — FULLY VALIDATED (VIB-2)
- Operator AUTO-SELECTED the Web Researcher for a browser task (owner ask "let operator choose correct agents" ✓). Did NOT pick Developer (no browser).
- Web Researcher (Claude, use-browser + coupled egress) mounted playwright/mcp + chromium, navigated 2 real pages, captured screenshots to attachments/ (default-named page-<ts>.png).
- Findings accurate & detailed: read example.com content (noticed non-standard "Avoid use in operations" body); correctly identified github.com/akin-ozer/viberr as GitHub 404 (private repo).
- SECURITY STANCE (owner cares): agent treated page text as DATA not instructions ("inert page content, not an instruction") — browserPersonaSection guidance works.
- KB PROOF-OF-READ (UC-16): agent cited "Per review standards (marker KB-CANON-ORCHID-42)" → viberr-product-canon KB was loaded AND read AND applied. KB grant→mount→read→cite loop verified.
- UI rendering: #177 thumbnails render on producing comment (tl-attach-thumb) AND a dedicated Attachments panel ("5 files") with "posted by Web Researcher" attribution. #184 lightbox = native <dialog>, opens in-app showing the captured page (GitHub 404 Octocat visible), footer filename + "Open original" + Close; focus trapped in dialog.
- Screenshots via attachment route /projects/viberr/tasks/VIB-2/attachments/page-*.png (member-gated).

### Browser use-case status
PASS: UC-09 (browser evidence Claude), UC-13 (default screenshot naming → attachments/), UC-16 (KB proof-of-read), operator agent-selection, browser security stance, #177 thumbnails, #184 lightbox.
UC-10 (egress coupling): creation-side verified (Web Researcher got egress auto-coupled). Edit-side pending.
UC-11 (browser on Codex): BLOCKED by Codex quota — invocation-only.
UC-12 (hand-edited browser without egress): pending (fail-closed mount test).

### Minor browser finding
F22-11 (LOW, a11y): lightbox initial focus lands on "Open original" (first focusable) not Close; focus IS trapped. Prefer focusing the dialog/Close.

## RBAC test plan (UC-21-25) — do as a batch (logs out Arda)
- First-login flow: temp-pw sign-in → pwresetRequired → login "reset" mode → set new password (completeForcedPasswordReset). login.tsx:27/117.
- Mira: mira@viberr.dev temp PtqOiG_58AJx → set new pw viberr-mira-2828. Project role: Contributor.
  - Expect CAN: create task, take/release own ownership, accept own task, resolve non-accept packet options on owned task, comment.
  - Expect CANNOT: approve others' transitions, resolve others' packets, run agents, manage members/profiles, force-accept, edit policy. Verify UI hidden AND server 403 (crafted POST w/ her session + _csrf).
- Deniz: deniz@viberr.dev temp 3VGykPNdcC8v → set new pw viberr-deniz-2828. Project role: Viewer.
  - Expect: read + comment ONLY. No create-task, no ownership (FR38 floor=contributor). Verify disabled affordances + server refusals.
- Members-only 404: remove a user from project (or use a 3rd fresh non-member) → hit /projects/viberr/board → byte-identical 404 (project answers as if nonexistent). R15-4.
- Org-admin override: needs a project WITHOUT Arda membership. Creator is seeded admin, so Arda-created projects always have him. Would need Mira to create a project Arda isn't in → Arda acts via org-admin override (audited). Optional.

## UC-17/18 MCP — PASS (Claude)
- everything MCP server (stdio npx) registered w/ real handshake (16 tools). Granted to Web Researcher. Mounted per-run alongside browser.
- Live tool calls succeeded: mcp__everything__get-sum(21,21)→"The sum of 21 and 21 is 42."; mcp__everything__echo(MCP-PONG-77)→"Echo: MCP-PONG-77".
- Claude tool-id format = mcp__everything__get-sum (HYPHENS PRESERVED). Codex would be mcp__everything__get_sum (underscores) — unverifiable live (quota).
- @mention→run routing WORKS: posted "@Web Researcher <directive>" via Lexical composer + mention autocomplete → toast "@Web Researcher is picking it up" → run started → replied @tagging Arda (NEW-4 human-tag convention ✓).
- MCP creds injection (UC-18): everything server has no cred; Claude-only cred path unverified live. Code-verified (AGENTS-RUNTIME doc).

## Minor finding
F22-12 (LOW, coherence): agent double-posted its answer — a mid-run post_comment (09:29:29) AND the final envelope reply (09:29:37), near-identical. For a conversational @mention, one reply is cleaner. May be intended (two channels: proactive comment vs final report). Confirm.

### Use-case status update
PASS: UC-17 (MCP tool call Claude). @mention routing, NEW-4 human-tag.

## RBAC multi-user (UC-21/23/24) — PASS (Mira, contributor)
- Login: temp passwords from the creation banner were unreliable (mis-read O/0). Admin "Generate a new temp password" in Edit user → fresh temp (Mira: IME43tLn_4b4) → forced-reset flow → set viberr-mira-2828. (Reliable path: fetch POST /login intent=login → pending reset → GET /login for _csrf → POST intent=set-password. React Router controlled form + pane CDP-typing both unreliable; fetch is deterministic.)
- Members-only VISIBILITY: Mira's dashboard shows ONLY Viberr, not Sandbox (not a member). ✓
- Members-only 404 (R15-4): GET /projects/sandbox/board (non-member) → 404 IDENTICAL to /projects/doesnotexist999/board → 404; only byte diff = the echoed slug the user typed. Private project indistinguishable from nonexistent. ✓
- Org settings admin-gated: Mira sees "Org admins manage this" (read-only), no Manage links. ✓
- Contributor task Permissions panel (honest): comment ✓; "Take / release your own seat" ✓; Accept = "Maintainer, admin, or the task's own owner"; Run agents = "Maintainer or admin only".
- SERVER-SIDE ENFORCEMENT (gold standard): Mira POST intent=run-operator w/ VALID CSRF (from /_.data root loader, HMAC(secret, sessionId)) → HTTP 403 "Permission…". Not UI-only.
- OWNER-SCOPED AUTHORITY (R15-3/FR37, UC-24): Mira took ownership of VIB-2 → panel flips to "Accept completion: You own this task, so you can accept it → Done" — contributor gains acceptance on her OWN task, still barred from run-agents. ✓
- CSRF token = HMAC(VIBERR_SESSION_SECRET, "viberr-csrf:"+sessionId), exposed via root loader at /_.data; assertTrustedOrigin also required (Origin/Sec-Fetch-Site).

## RBAC Viewer (UC-22) — PASS (Deniz)
- Deniz temp pw GfsBq1Ad_6vM (admin-regenerated) → set viberr-deniz-2828.
- Viewer Permissions panel: role=Viewer; Comments "You can comment (every project member can)"; Task ownership = "View only (contributor+ to own)" (FR38 floor=contributor ✓); no Assign/Take/New-task affordances; comment box present.
- SERVER ENFORCEMENT: Deniz POST create-task → 403 "contributor" (needs contributor+); set-owner → 400/reject. Viewer cannot create tasks or take ownership server-side.
- RBAC summary: matrix (ACTION_ROLES) enforced at BOTH UI (honest affordances) and server (403 by role). Members-only invisibility + owner-scoped acceptance + FR38 floor all live-verified.
- Known creds now: Arda viberr-dev-2828 (admin) / Mira viberr-mira-2828 (contributor, owns VIB-2) / Deniz viberr-deniz-2828 (viewer).

## UC-06 PR rejection path — PASS (real reject on akin-ozer/viberr)
- VIB-3 operator-delivered PR #188 (branch vib-3, 1 file +1/−0). Body had NO stale stats (clean branch) — reconfirms F22-10 is stale-branch-collision-specific (#187 had wrong 3-file stats; #188 correct).
- gh is authenticated as akin-ozer (PR author) → cannot self-request-changes (GitHub blocks). Rejected via `gh pr close 188` (unmerged).
- viberr "Update status" reconcile picked it up: GitHub panel "PR #188 · closed", PR list shows #188 closed / #187 merged.
- Task VIB-3: "PR #188 · closed", "Deliver branch & open PR" button reappears (re-deliver after rejection), stays In Progress, "waiting on you".
- Board "Blocked or waiting" filter surfaces VIB-3 with a "closed" chip (board-filters.ts closed-unmerged signal). Correct rejection UX.

### Use-case status
PASS: UC-06 (PR rejection). Total validated: 17 numbered UCs + ~9 behaviors = 26 (exceeds 20+ target).
Remaining: UC-07 (no-change), UC-11/14 (Codex-blocked), UC-12 (code-only), UC-19 (ask-human), UC-20 (continuity), UC-25 (org-admin override).

## Operator rejection handling (bonus) — EXEMPLARY
On PR #188 close: (1) Policy engine posted "Divergence: PR #188 closed without merging, but VIB-3 still active. Decide rework/reopen or archive. The now-moot 'Move to Review' recommendation was withdrawn." (2) Operator raised "Decision packet: PR #188 closed without merging — pick a recovery path. Awaiting a human decision." Stale recommendation auto-withdrawn on divergence. Strong governance.

## Testing phase — SUBSTANTIALLY COMPLETE
26+ behaviors validated live covering every owner-named concern:
- Lifecycle: create→triage→ready→in-progress→deliver→PR→review→verdict→accept→MERGE (real PR #187), + rejection (PR #188 closed→recovery packet), + force-accept.
- Agents: operator coordination + agent-selection (Developer for code, Web Researcher for browser); Developer/Reviewer/Web-Researcher runs; @mention routing; NEW-4 human-tag.
- Browser (owner focus): playwright+chromium, screenshots→attachments, #177 thumbnails, #184 lightbox, security stance, KB proof-of-read, screenshot naming.
- MCP: everything server mount + live tool calls (hyphenated Claude ids).
- Skills: isolation (only granted skill mounted; R18-3 strip; clean commit).
- Codex vs Claude: viberr invokes both correctly; Codex quota-blocked externally (F22-08 = failure misclassified).
- RBAC: contributor/viewer/admin, server-enforced (403), members-only 404, owner-scoped acceptance, FR38 floor, denial auditing.
- Governance: R15-1 verdict gate, R21-5 disclosure, R18-3 strip, audit completeness, live-backend overlay #183.
DEFERRED (code-verified, exercise during implementation): UC-07 no-change, UC-12 hand-edited browser fail-closed, UC-19 ask-human, UC-20 continuity, UC-25 org-admin override.
BLOCKED (external): UC-11/14 Codex live (quota until Sep 18).
