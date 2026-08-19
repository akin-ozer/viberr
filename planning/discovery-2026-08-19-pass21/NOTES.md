# Pass 21 — discovery notes (2026-08-19)

Live target: production-image container `viberr-app-1` (built 2026-08-19 18:54 +03 from current main = pass-20 merge + anti-slop lint commits), fresh docker-data (clean-sheet seed + owner-seeded viberr project VIB → akin-ozer/viberr, 1 GitHub connection, 2 agent profiles + operator, 3 skills, 0 KBs, 0 MCPs).

Driving the UI via the persistent playwright driver on :8787 (Browser pane wedged 0x0 again, same as pass 20). Screenshots in scratchpad/shots/.

## Format
- `OBS-n` observation (maybe fine, verify/ask)
- `F21-n` defect finding (confirmed)
- `Q-n` owner question

## Findings / observations

### OBS-1 — Operator flags the browser-capability gap but not the product's own remedy
VIB-1 ("take screenshot of the login page"): the operator's input-required packet correctly detects both specialists have `browser: false` and offers 3 scopes (playwright script / manual one-off / write-goal-myself). But the product HAS a grantable `use-browser` capability (R19-19); the packet never mentions "grant browser to an agent profile and let it capture live". If the operator can't recommend org-level config changes by design, fine — but then the capability-gap fact line could link the human at the Agent resources surface. Verify design intent; candidate finding.

### OBS-2 — "Force accept" offered on a Triage task with no branch/no work
VIB-1 GitHub card shows "Force accept (skips the remaining stages and the review gate)" while the Current state rail says "Not acceptable yet… move through the workflow first". Force-accept on a task with zero agent work and no branch — what does it produce? (pass-20 added acceptance:"forced" durable fact + empty-branch auto-detect). Verify behavior + whether offering it here is intended (admin-only affordance is fine, but copy sits oddly next to "Not acceptable yet").

### OBS-3 — Driver renders app in light theme; container serves current main
Light theme looks coherent on task detail. Sweep both themes for the contrast gate later.

### F21-1 (HIGH, from doc agent, repro'd vs baseline SQL) — validation CHECK constraint missing 'bypassed'
`0001_baseline.sql:88` CHECKs validation IN ('healthy','changed','failing','none') but `rebuilder.server.ts:409` binds `deriveValidation(fm)` which returns `"bypassed"` for `acceptance:"forced"` tasks (`task-file.schema.ts:656`). Force-accepted task ⇒ reprojection THROWS. All existing bypassed tests use hand-built projection rows, never the real SQLite write. Fix: widen the CHECK + re-baseline. Live-verify via UC-11.

### F21-2 (from doc agent) — acceptance ceremony has NO server-side guard
AcceptDisclosure (pass-19 session B) was lost in the merge; shipped mechanism is client-only AcceptConfirm/PendingAccept ceremony. A direct POST accepts without any disclosure. R15-1 family holds only client-architecturally. Also R20-9 delegated-ask disclosure is prompt-level only. Candidates for a server-side invariant.

### F21-3 (from doc agent) — operator MCP mounts not pre-flighted
In-code TODO at operator-run.server.ts:2268; specialists got F20-10 pre-flight, operator didn't. Plus: two operator denylists are unguarded duplicate literals with no pinning test.

### F21-4 (from doc agent, minor) — test-store.ts:27 comment says "selin → reviewer" while code seeds contributor (:76).

### OBS-4 — operator card "Stage transitions: recommends only" vs auto boundaries
Supervised operator MOVED Triage→Ready and Ready→In Progress directly; `get_task` shows those boundaries as `"auto"`. Deliberate per-boundary policy (workflow rules), but the operator capability card flatly lists "Stage transitions" under RECOMMENDS ONLY — display is a simplification that contradicts observed behavior. Candidate copy fix ("Stage transitions across gated boundaries") or per-boundary display.

### OBS-5 — engagement vocabulary: "engaged … as a reviewer" vs "supporting"
Timeline says "Engaged Web Verifier (Live verification, Claude Code) as a reviewer"; the log-stream header says "Web Verifier · supporting". Web Verifier has verdict=Off, so "reviewer" is misleading; check the engagement-kind vocabulary for coherence.

### UC-1 PASSED (core browser capability)
Web Verifier (new profile, Claude, browser+web on, no repo caps) — operator withdrew its stale packet as moot after goal edit (noticed the new profile: "capability gap is also resolved"), engaged Web Verifier, agent drove chromium in-container (`browser_take_screenshot`), PNG (+page snapshot .yml) landed in task attachments via default naming, comment linkifies to member-only route `/projects/viberr/tasks/VIB-1/attachments/…`, report accurate, run: 11 turns/30s/$0.26. Evidence PNG verified = real login page.

### F21-5 (from doc agent) — project Viewer still sees credential health on /settings
`settings-query.server.ts:81` ships full ProjectCredentialHealth to every member; `settings-page.tsx:1317` renders CredentialCard unconditionally (label + masked tail + scope verdicts in HTML for Viewers). The same leak was closed on /github (Q-V1) but not here; `settings-page.test.tsx:1191-1196` pins the wrong behavior. Live-verify with the Viewer user in UC-21.

### F21-6 — "Engaged … as a reviewer" copy wrong for verdict-incapable supporting agents
`specialist-run.server.ts:850` + `operator-actions.server.ts:1839-1850` emit "as a reviewer" for EVERY non-delivering engagement; schema distinguishes supporting vs requiredReviewers (`!delivers && verdictCapable`, task-file.schema.ts:590). Web Verifier (verdict=Off) was announced "as a reviewer" but renders as "SUPPORTING AGENTS" in execution-profile. Copy should branch on verdictCapable. (OBS-5 promoted.)

### F21-7 (HIGH, lint-commit audit) — drifted check-runs payload ⇒ false green CI pill persisted to task.md
`pr-linker.server.ts:120-136` per-entry `.catch({})` inside array `.catch(undefined)`: `{total_count:3, check_runs:[null,"x"]}` → `{total:3,passing:0,failing:0,pending:0}` → `mapPrChecks` (task.server.ts:215-220, only guards total<=0) → checksPill "3 checks passing" (github-pills.ts:76) → reconciler persists (`github-reconciler.server.ts:497`). Violates the invariant both consumers state in their own comments + decisions.md 84-86. No drifted-payload test exists.

### F21-8 (MED, lint-commit audit) — one malformed commit silently empties the commit list
`branch-sync.server.ts:65-76`: strict per-entry sha inside array-level `.catch(undefined)` → whole array drops while ahead/behind survive; task.md then shows divergence next to "no task commits"; repoFootprintTasks + deliveredWorkEvidence lose the task.

### F21-9 (MED, lint-commit audit) — github-client "never throws" contract broken
`github-client.server.ts:262` schema.parse throws; strict uncatchable fields at pr-linker:85-87, pr-open:153-156, branch-sync:196. Human Reconcile button can 500 (`github-actions.server.ts:58-64` no try/catch); reconciler Promise.all aborts whole project pass; ZodError after POST /pulls leaves PR open with no task.md record (retry re-adopts by head-sha only).

### F21-10 (LOW batch, lint-commit audit) — wire-format `kind: .catch("update")` relabels unknown Codex file-change verbs; `takeStagedOutcome` can throw past its consumed-once DELETE (agent-outcome.server.ts:326-335); `rolesForAction` throws bare Error not AppError (rbac.ts:109); `storeIcon` `in`-check walks prototype chain contradicting its own comment+test (icon.tsx:57). (schedule.server.ts .catch(null) currently unreachable.)

### F21-11 (MED-HIGH, catch-site audit) — drifted PAT permissions block silently upgrades to "valid"
`pat-validator.server.ts:104-121,259-260`: five strict optional booleans inside block-level `.catch(undefined)`; one non-boolean named key (e.g. triage:"yes") voids the block → repoWriteOk null → `source:"assumed"` → status "valid" where old code said `insufficient_scope`. Sibling `settings-actions.server.ts:53-57` shows the intended per-field tolerance. Fix: per-field catches + keep proven-read-only rejection; add diagnostic.

### F21-12 (LOW batch, catch-site audit) — store-files GitHub import: one malformed tree entry drops the whole listing with wrong message "No importable files found" (store-files.server.ts:599-616,738-751); codex base-features table `.catch({})` empties deployment-supplied features (test-seam only, codex-runtime.server.ts:101-104); resource-references write path lost its Array.isArray guard (latent, resource-references.server.ts:156-158).

## Use-case ledger (to build during phase 2)
UC-1 ✅ full loop: packet → goal edit → packet auto-withdrawn as moot (operator cited the new browser-capable profile) → auto Triage→Ready → Web Verifier engaged (supporting) → browser capture + attachment + accurate report → operator recommends In Progress→Review (gated, human applies) → operator re-queues (R20-1 ✅) → Reviewer auto-engaged at boundary, validation healthy → "Complete with no changes" recommendation → ceremony dialog disclosed MERGES: nothing / REVISION ce2bc9e4c204 / VERDICT healthy → Done · accepted. UC-6 ✅ (packet honesty), UC-7 ✅ (recommend→apply→re-queue).
PRD-alignment doc adds: U1 HIGH (linter vs architecture canon, lint red on clean tree, unreviewed 387-file rewrite), U3 HIGH (transition/accept double-submit race — stage check outside file lock, NFR16), U4 (R20-9 missing from decisions.md while cited in prompt+test), U5/G4 (triage quality gate promised in New-task placeholder, unimplemented), G5 (FR28 onPhase dead — Live-run rows blank), U6 (Safari/Firefox declared unrun), U7 (D2 order:-1 leaves SR/focus order inverted), U8 (BETTER_AUTH_URL http downgrades cookie), U11 (attach-evidence grants nothing on Claude without verdict), U12 (two "specialist" strings vs vocabulary ruling).

### UC-12 PASSED (full governed delivery, real merge)
VIB-2: create→operator triage (auto Triage→Ready→In Progress)→Codex dead (refresh token burnt)→blocked packet with PROVIDER SAID verbatim (R20-3 ✅) + 4 recovery options→human picked "Retry on Claude Code"→switch STUCK (Developer now Claude)→agent committed 1 file→pushed vib-2→PR #170 opened→honest system nudge ("not the operator agent\'s judgement")→Review→Reviewer verdict healthy→accept ceremony (MERGES PR #170 · REVISION 1b11d401 · VERDICT healthy)→REAL merge 16:47:39Z→Done·merged. PR contained exactly planning/pass21-probe/README.md.

### F20-7 refusal verified live: 7-char MCP cred → "That credential is too short — enter at least 8 characters, or leave it blank."; MCP name probe_tools normalized to probe-tools at save.

### Q-1 (owner) — Codex re-auth needed for parity legs
Container+host auth.json identical (Aug-2), refresh chain burnt by earlier passes, auth_mode=chatgpt, no API key. UC-3/13 + Codex halves of UC-18/19 blocked until owner runs `codex login` on the host; then I copy auth.json into /data/runtimes/codex-home/.

### OBS-6 — stale-session SSE clients retry 401 forever
Owner\'s old browser session (previous data root, task VIB-5) hammers /resources/events with 401 every ~2s indefinitely. Client could back off/redirect to login on 401.

## Sweep progress
- [x] Login (dark, screenshot)
- [x] Dashboard (dark + aria)
- [x] Board (aria, shot 01)
- [x] Task detail VIB-1 (light, shot 02-vib1) — packet, rails
- [ ] Review queue, Agents, Policy, GitHub, Activity, Settings (project)
- [ ] Org settings: connections / users / resources (profiles, KB, MCP, skills)
- [ ] Notifications, search ⌘K, account menu, KB editor, diagnostics

### F21-13 — profile editor lets Save race the backend-switch model reload → cross-backend model persisted
Repro: Edit Developer (backend Codex/model gpt-5.6-terra) → click "Claude Code" → model select shows "loading available models…" → Save is enabled and succeeds → project.md now has `backends:[claude]` + `model: gpt-5.6-terra`. Editor must disable Save (or remap model) until the backend's model list resolves; server should reject a model id foreign to the backend. Runtime behavior with the incoherent pair: observed in VIB-3 (see below).

### OBS-7 — forked profile card still labeled "Global base"
After the resource-grant fork, Developer's detail header shows scope "Global base" while Web Verifier (created in-project) shows "Created in viberr". The fork warning promises "keeps its own copy and stops tracking the global" — the label doesn't reflect fork state. Check scope semantics/copy.

### OBS-8 — pre-run phase (task-repo clone) is invisible on the task page
VIB-3's create-trigger operator run spent 3+ min inside `git clone --depth 1` (repo is 113M+) BEFORE "operator run started" — during that window the task shows "input required · agent working", empty timeline, "hasn't started its operator loop", no live-run panel; a queued manual trigger says nothing in UI. Everything looks stalled with zero feedback. Related to G5/FR28 (onPhase dead). Candidate: surface a "preparing workspace (cloning repo…)" phase row.

### OBS-9 — every task workspace re-clones the full repo (113M+ each)
VIB-1/2/3 each hold their own ~113M clone under tasks/<key>/workspace. A local `--reference`/mirror cache per project would cut clone time (the VIB-3 stall) and disk. Product question for owner.

### UC-17/18/19 (Claude halves) PASSED + F21-13 addendum
VIB-3 probe: KB canary cited exactly (chartreuse-pelican-42, read live), MCP echo exact ("Echo: viberr-pass21-echo-check"), skills isolation clean (only developer-expertise mounted; 0 mentions of the other two). Transcript forensics: cred "pass21-secret-cred-9988" 0 occurrences ✅ (F20-7 scrub family), Claude MCP dialect mcp__probe-tools__echo ✅. F21-13 addendum: with backends:[claude]+model:gpt-5.6-terra the run SILENTLY used claude-sonnet-5 — graceful but silent; the substitution should be surfaced (or the save rejected).

## Pass-21 owner rulings (2026-08-19, to be promoted to decisions.md in implementation)
- **R21-1** Codex re-authed on host mid-pass; fresh auth.json copied into container → run the Codex parity legs.
- **R21-2** Capability-gap packets SHOULD point at the product's config remedy (grant the capability on a profile; reference the Agent resources surface). Operator still never changes config itself.
- **R21-3** Anti-slop lint is ADOPTED fully: fix the 4 regressions (F21-7/8/9/11) + the 26 remaining findings, amend architecture.md with a ruling, add `npm run lint` to CI as a required gate.
- **R21-4** Build BOTH: per-project git mirror/reference cache for task workspace clones AND a visible pre-run phase ("preparing workspace / cloning") on the task page — wire FR28 onPhase (fixes G5 too).

### UC-8 PASSED (runtime) + F21-14 — operator narrates inability, then accepts 60s later
Full autonomy + explicit accept grant: operator moved VIB-3 through Review and recorded "Operator acceptance under full-autonomy policy — completed with no changes" (empty vib-3 branch re-checked at acceptance, R20-2 ✅). BUT one minute earlier the same operator posted "I can't accept completion myself… transition-to-done: human … needs you" — misreading its own policy map (completion-for-acceptance: direct + full autonomy IS the sanctioned path per ruling; transition-to-done:human is the raw-transition row). Fix: operator manual/policy-map wording must state the acceptance exception explicitly (and the timeline pair reads as self-contradiction to humans). Also: full-autonomy operator initially deferred to a human dismissal of a stale recommendation (respectful, good), resumed after explicit @operator go-ahead.

### UC-22 partial PASSED — Viewer server-side deny is real: create-task POST with valid CSRF → 403 "Your project role (viewer)…"; New task button hidden; CSRF fails closed (403 missing/invalid token first).

### F21-16 — get_task policy payload doesn't say WHOSE policy it is; operator misattributed
VIB-5: after the human fixed the Web Verifier grants (profile = web+browser direct, verified in project.md), the operator generated "Web egress grant did not take effect" quoting `use-web-search-fetch: off` — that row is the OPERATOR's own policy (get_task.policy is operator-scope), not the specialist's. A fresh specialist run mounted viberr_browser fine. Fix: label the policy map ("your capabilities"), and/or expose specialist grants distinctly in get_task; operator manual note.

### F21-17 — PR-closed recovery packet omits known branch drift
VIB-4: the packet said "review before closure was clean (Approve)" and offered "Rework and resubmit", never mentioning the unreviewed out-of-band commit cab10477 the reconciler had already seen (the accept ceremony DID disclose it). Recovery packet should carry the drift fact.

### UC-2/5/14/16/23/29/32 outcomes — see USE-CASES.md; highlights: blocked-capability packet honest; example.com browsed from container; R17-1 drift line in ceremony verbatim; archive+deleteBranch really deleted remote vib-4; members-only 404 for non-member; re-scan clean.

### OBS-12 — autonomy semantics: rows are authoritative; "Supervised" only ceilings acceptance
With stage-transitions:direct (left over from a racy test edit), a Supervised operator transitions approval boundaries DIRECTLY, and the card correctly lists "Stage transitions" under ACTS DIRECTLY while "Accept completion into Done" stays ceiling-clamped to RECOMMENDS ONLY. Display=runtime ✅ (no F20-9 recurrence). But the autonomy toggle's help copy "supervised recommends at approval boundaries" oversells what Supervised guarantees when rows are customized — copy nuance, same family as OBS-4/F21-14. NOTE: operator deployment rows in this test org now deliberately differ from seed (stage-transitions/completion-for-acceptance = direct).

### F21-18 (cosmetic) — task-key chip wraps mid-key ("VIB-\n6") on 390px board cards.

### UC-3/13/18/19 Codex halves PASSED
VIB-6 (Codex Web Verifier): viberr_browser mounted on Codex, browser_navigate + browser_take_screenshot called, PNG+yml attachments landed; probe-tools echo called ("codex-parity-echo-check") — server name appears hyphenated on Codex too; cred 0 occurrences. VIB-4 (Codex Developer): KB canary in file+transcript, skill isolation clean, real PR #171 (1 file). Backend parity: CONFIRMED for browser/MCP/KB/skills/cred hygiene/delivery.

### UC-25/26 PASSED — @operator comment → run → answer tags BOTH @Arda and @Selin (noticed the original asker in-thread); Selin's bell shows "mentioned you"; contributor mention correctly runtimeDenied with honest toast ("your role can't trigger agent runs"); closed-task copy could mention the role requirement.

### OBS-13 — acceptance branch re-check can read a stale same-name branch
VIB-5 never created a branch (agent had no repo caps), yet acceptance reported "Branch vib-5 carries no commits ahead of main, re-checked" — that vib-5 is a LEFTOVER from a previous data-root pass. Harmless here (it was at/behind main) but the re-check attributed a foreign branch to this task; with a stale DIVERGED branch the copy would mislead (branch-collision rules 34/35 cover execution, not this acceptance read).

### F21-21 (M/H) — operator misreads the shared task workspace as "the default branch" → FALSE out-of-band-merge accusation
VIB-7: Developer committed row on vib-7 (workspace now checked out on vib-7). Operator then `Read ./workspace/viberr/planning/pass21-probe/README.md`, saw the row, and generated a BLOCKING packet claiming "the repository's DEFAULT branch already contains that exact row … landed outside the governed pipeline" — false (main verified row-free via GitHub API). There is exactly ONE clone per task (tasks/<key>/workspace/viberr); the "read-only view for the operator" is that same dir and reflects the task branch after specialist commits. Fix: anchor operator repo reads to origin/main (git show origin/main:path or a separate operator clone kept on main) + prompt wording; blocked a healthy flow with a trust-eroding accusation.

### UC-15 PASSED + F21-23 (L)
Out-of-band gh merge of PR #172: poller adopted merged state ("state: merged" in task.md), reviewer verdict still ran (approve, rigorous evidence incl. rev-parse match), operator recommended acceptance, ceremony showed "MERGES: PR #172 · merged into main" — it KNOWS it's merged, but the button still reads "Apply → Done & merge" and footer "Merging is one-way" (copy should adapt: nothing merges, already merged by a human). Task → Done.
### UC-20 PASSED — operator run mounted granted probe-tools MCP (run_422JxsyMdzMQ: probe-tools + viberr). Pass-13 silent-grant class stays dead; only F21-3 (no pre-flight) remains.

### UC-31 PASSED + F21-24 (M) — graceful-shutdown drain races
docker restart mid-Codex-run: SIGTERM closed sqlite, but (a) an incoming request LAZILY REOPENED it ("sqlite ready" mid-shutdown — undermines the close and the single-writer story), (b) the in-flight run pipeline kept a STALE handle → ~10× "run line persist failed"/"run divergence marker could not be persisted" (those lines lost), (c) push failed with an HONEST durable task event ("could not be pushed — database is not open… Fix the push, then deliver again"). BOOT: lock acquired cleanly, offline-drift rescan (1 changed), "finalized non-terminal runs at boot: 1", 1.68GB done-task workspaces reclaimed, operator AUTO-RESUMED VIB-8 in 2s and re-delivered → PR #173. Fix targets: shutdown must stop accepting lazy reopen + run pipelines should buffer/flush-or-drop cleanly instead of per-line error spray. (F20-8 reclaim not exercised — graceful stop released the lock; kill -9 variant already covered pass 20.)

### UC-11 DONE — F21-1 LIVE-CONFIRMED + precondition sharpened + force-accept ceremony verified
Force-accept at Triage w/ no work: fully-disclosed ceremony (MERGES nothing / no revision / SKIPS list / BYPASSING copy / audit note) → Done, acceptance:"forced", validation stays "none" (deriveValidation returns none when !workRevision — the forced→bypassed arm sits BELOW that guard). With workRevision synthesized on the forced task file (legit canonical state): watcher reprojection FAILED live — "CHECK constraint failed: validation IN ('healthy','changed','failing','none')", action:"error", row STALE. So the real-world trigger is force-accepting a task that HAS delivered work (the common case!). Fix: widen CHECK + re-baseline + real-write test with acceptance:forced+workRevision. File restored after repro.
