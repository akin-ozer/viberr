# Pass 19 — discovery notes (2026-08-06)

Scope: full product pass. Phase 1 discovery (code + docs + UI tour), Phase 2 live use
(20+ use cases, PR-based tests against github.com/akin-ozer/viberr in a NEW project),
Phase 3 implementation of every finding, live-validated.

App under test: production compose container `viberr-app-1` on :5173, data root
`docker-data/` (host dev server must stay OFF — dual-writer WAL hazard).

Reference docs: planning/discovery-2026-08-06-pass19/reference/ (refreshed from pass 18
against main @65063b8). Intent distillation: INTENT.md.

## Owner rulings (pass 19, gathered live — promote to docs/architecture/decisions.md)

- **R19-1 — first-class no-change acceptance.** A task that verifiably has nothing to deliver
  must reach "Completed — no changes" WITHOUT faking a delivery. When a reviewer approves and
  there is nothing to deliver, acceptance closes it to Done with the no-change completion event
  and its own confirm dialog. Extends R17-2 (ruling 43) to the shape it was named for. Closes F19-21.
- **R19-2 — the repository wins; a knowledge base is context.** The repo's own docs are
  authoritative for how its files look; KBs supply background the repo cannot give. Agents are told
  this in the run prompt, and a KB-vs-repo conflict is surfaced as a typed event, never silently
  resolved. Closes Q19-2.
- **R19-3 — reviewer inheritance stays KBs only.** R18-1's reason was shared *conventions*, which
  KBs carry; skills are role instructions and a reviewer inheriting the developer's skill blurs the
  roles. The docstring claiming a skills widening is stale and is corrected. Closes F19-2.
- **R19-4 — the operator gets a read-only repository view.** Scoping must be grounded in the real
  repo, so the operator can list/read the default branch during triage. Costs a shallow fetch per
  task; makes packets concrete instead of invented. Closes Q19-1 + F19-4.

## Implementation status (branch `pass19/product-fixes`)

| Cluster | Findings | Commit | State |
|---------|----------|--------|-------|
| Copy / a11y / vocabulary | UX19-1, F19-11, F19-5, F19-12 | `1836f00` | ✅ committed, canaried (+ vocabulary lint) |
| Archived-task honesty | F19-8, F19-9, F19-13 | `57b04e9` | ✅ committed, canaried (server guard + UI) |
| Q-V1 test gap | N19-5 | `17472d5` | ✅ committed, canaried |
| Acceptance confirm parity | F19-3, F19-7, F19-14, F19-10, **F19-22** | `e8bed15` | ✅ committed, canaried. F19-22 (Stage dropdown → terminal stage) was found DURING this cluster: a third undisclosed acceptance path. |
| Failure diagnostics + reliability | F19-6, F19-18, F19-19, F19-20 | `f668b07` | ✅ committed, 18 canaries. Live-confirmed: the run log now carries `fatal: could not read Username…` where it used to carry nothing. |
| Docs canon + rulings promotion | F19-17, N19-2/3/4, R19-1..4 | `f668b07`+ | ✅ committed. Rulings 55–58 promoted; 9 further false doc claims found and fixed in the sweep. |
| No-change acceptance (R19-1) | F19-21 | `2891044` | ✅ committed, canaried |
| Skill-mount race + runtime disclosure | F19-15, F19-16, F19-2/R19-3 | `5ef217e` | ✅ committed, canaried |
| Delivery leaves an actionable step | F19-1 | `5ef217e` | ✅ committed, canaried (9 tests) |
| Acceptance dialog layout | **F19-23** | `(this commit)` | ✅ Found during LIVE verification of F19-3: the `.obs` label column was a fixed 92px and the new "RECOMMENDATION" label — the first one wider than it — printed over the value beside it. `minmax(92px, max-content)` keeps the shared alignment and lets the widest label size the column. Canaried. |
| Test hermeticity | **N19-6** | `ed6a6c5` | ✅ committed. Found during verification: the suite made real network clones and flaked under load. |
| Two-surface acceptance | UX19-2 (UX19-3 retracted) | `2044e02` | ✅ committed, canaried. Fixed a third latent defect: force-accept was offered on a terminally blocked (closed-PR) task, which R16-3 forbids in prose. |
| Operator repo view + KB precedence | F19-4, Q19-1, Q19-2 (R19-4, R19-2) | `e990eb0` | ✅ committed, canaried |
| UX coherence audit (24 findings) | 6 dimensions, 2 skeptics each | `fe11c0a` | ✅ committed, all canaried |
| No-change validation cache | **F19-27** | `732fd47` | ✅ committed, canaried. **Live-caught by running the R19-1 use case end to end for the first time** — VC-9 sat in Done pilled "accepted" while its card claimed "awaiting verdict". Two halves: `deriveValidation` reports `none` for a no-change completion (placed last, so a real approve/request-changes still wins — the existing suite caught an earlier version erasing an approval), and both `performDelivery` sites that set `noChanges` now recompute the cache the projection actually reads. |

**Suite: 3051 tests / 225 files green, `tsc --noEmit` clean.**

Findings that CHANGED under scrutiny (recorded because the correction is the point):
- **F19-1 narrowed** — first filed as "the operator never recommends after delivery". Three live runs showed VC-4/VC-5 *did* recommend and VC-1 did not: the real defect was that the guarantee rested on the model, so the fix is server-side.
- **UX19-3 retracted** — my two screenshots were taken at different instants, not the same one. Verified in code that the divergence I claimed cannot occur.
- **KB-grant "bug" retracted mid-session** — the Doc Writer profile lost its KB because I double-clicked the chip (React state is async; the second read was stale), not because the modal drops grants.

## Phase A–D: live verification round 2 (post-implementation)

The first sweep under-executed the use-case phase. This round closed it.

| UC | Scenario | Result |
|----|----------|--------|
| UC-14 | **MCP end-to-end** — registered a real stdio MCP server (`pass19-probe`) through the UI; the save ran a real handshake ("1 tools · checked just now"); granted it to the Claude Doc Writer; VC-7's run called `mcp__pass19-probe__viberr-pass19-probe` and returned the exact canary `MCP-CANARY-PASS19-4417`. | ✓ works end-to-end |
| UC-15 | **Skill routing / decoy** — an ungranted decoy skill (`kubernetes-rollback`, canary `SECRET-CANARY-KUBE-7788`) was in the store the whole time. VC-7's agent reported it can see ONLY `developer-expertise` and explicitly no Kubernetes skill; the decoy canary appears nowhere in the run. | ✓ only granted skills load |
| UC-11 | **RBAC contributor tier** — provisioned Elif through the real admin flow (incl. the forced set-a-new-password gate), then probed writes as a contributor member: comment 200, owner-take 200; transition / accept-completion / update-goal / assign-specialist / run-specialist / archive-task / schedule-action / force-accept / run-operator ALL **403**, and the task file was unchanged after. | ✓ boundary holds server-side |
| UC-11b | **Non-admin org settings** — `/org/settings` → 403 for a member. | ✓ |
| — | **LV-F1 re-verified** — a pending password reset still exposes "Generate a new temp password". | ✓ |
| — | **R19-2 conflict surfacing in the wild** — unprompted, VC-7's agent flagged that `qa/smoke/pass19-kb-marker.md` (written by the KB-driven VC-3 run) does not conform to the repo's own README format. Exactly the behaviour ruling 56 asks for. | ✓ |

## Phase D: visual coherence sweep (1440x900, live app, post-fix)

Screenshots taken of every principal surface. Each pass-19 fix re-confirmed in the running UI, not
just in tests:

| Surface | What the screenshot shows |
|---------|---------------------------|
| Home | Greeting + honest status line ("All quiet — no agent runs right now. **3 decisions** waiting on you"), project card with stage-distribution bar + member avatars, Settings hub whose counts match the store exactly (1 KB · 1 MCP server · 4 skills), admin store strip naming the live writer pid. |
| Board | 8 tasks across 5 columns. **"waiting on you" vs "waiting on a human" is a real distinction, not drift** — header reads "4 waiting on a human decision", chip reads "Waiting on me · 3"; the 4th (VC-5) is unowned and shows "awaiting owner". Merged tasks carry `merged` + `validation healthy`; PR numbers and branches on every card. |
| Task detail (VC-7) | **F19-1 fix live**: the recommendation reads "Move the task to Review — *Recorded by Viberr when the delivery landed — this is not the operator agent's judgement.* Review pull request #152 is open while VC-7 is still on In Progress, and nothing had proposed a next step." Honest attribution, evidence, and both Apply/Dismiss. **UX19-2 fix live**: the GitHub panel no longer offers Force accept at In Progress while Current state says "Not acceptable yet". |
| Review queue | **UX19-3 fix live**: VC-5 sits under **Still in review** (not "Waiting on your acceptance"), subline "No reviewed revision yet — nothing for the required reviewers to approve", chip `no validation`, tag "waiting on a human"; header "0 waiting on your acceptance". Previously it sat under "Waiting on your acceptance · 1 of 1" wearing a green "validation healthy" chip while the task page said acceptance was blocked. |
| Agents · Live | "Live · 6" counts ENGAGEMENTS (persistent threads), disambiguated by the Status column ("packet open", "anchored · on call") and the tile "0 specialists in a working state". Coherent with the product's persistent-thread model — not a defect. |

Also verified live this round: the stale writer-lock was taken over cleanly on restart (F18-5 machinery),
and the chokidar watcher reconciled a hand-edit to `task.md` within seconds with no manual re-scan (FR10).

## Phase C round 2: the rejection loop, end to end (live, unassisted)

VC-7 produced the pass's best evidence that the model works as designed — none of it scripted by me:

1. Doc Writer delivered `qa/smoke/pass19-mcp-probe.md` and opened PR #152.
2. I applied the delivery recommendation → Review.
3. The **Reviewer returned `request_changes`** — and its reasoning is the point: it refused to approve
   a claim it could not independently verify. "The canary's and skill-list's authenticity cannot be
   verified from anything available to me… I have no access to that MCP server myself, the commit
   carries no transcript or tool-call log… plausibility isn't proof." It even grepped the repo to
   confirm no Kubernetes material exists, and called that "mildly reassuring" but insufficient.
4. **The operator then re-engaged the deliverer on its own**, which re-called the MCP tool and
   committed strengthened evidence (03b0193, now naming the tool and the argument used), and the
   operator recorded a fresh recommendation asking the Reviewer to re-check.

The verdict gate held throughout: the task returned to `awaiting verdict`, and acceptance stayed shut.

**N19-7 (observation, not filed as a defect).** A reviewer engaged at the review boundary reviews the
DIFF. A task whose acceptance criterion is about *what happened during a run* (a tool was really
called, a skill was really absent) is therefore not reviewable from the reviewer's evidence surface —
the delivering agent's self-report is in the timeline, but the reviewer correctly declined to treat a
self-report as proof. This is arguably right (an agent vouching for itself is not evidence), but it
means "prove a runtime fact" is a task shape Viberr cannot currently close through review. Worth an
owner decision: either such tasks are out of scope for agent review, or the run's own tool-call
evidence needs to become citable evidence a reviewer can read.

## Phase C round 3: the remaining use cases

| UC | Scenario | Result |
|----|----------|--------|
| UC-07 | **External merge → reconcile.** Merged PR #153 with `gh` behind Viberr's back, then reconciled. Viberr wrote a typed divergence note ("PR #153 was merged on GitHub, but VC-8 hasn't been accepted through Viberr — its stage is unchanged"), **withdrew the now-moot recommendation**, and the operator recorded an accurate replacement. | ✓ |
| UC-18 | **Scheduled re-run (FR39).** Created a +60m operator re-run: written canonically into `task.md` (survives a rebuild), carrying backend, autonomy, creator and note. Cancelled it: `status: cancelled` with the record RETAINED for audit, not deleted. | ✓ |
| UC-19 | **Force-accept past a missing verdict.** VC-8 at Review with no verdict → force-accept closed it to Done AND wrote `task.acceptance.forced` naming the exact gate bypassed in `details_json`. (My first audit query found nothing because I used a `created_at` column that does not exist — the column is `occurred_at`. Not a defect; recorded because I nearly filed it as one.) | ✓ |
| UC-22 | **Archive + the new guard.** Archived VC-5 → `waiting: none`; then attempted a transition on the archived task → **409**, stage unchanged. The pass-19 archived-move guard holds server-side. | ✓ |
| UC-23 | **Hand-edit the store (FR10).** Edited `task.md`'s title outside the app; the chokidar watcher reconciled the projection within seconds with no manual re-scan, and the board rendered the new title. Explicit re-scan also 200s. | ✓ |
| UC-24 | **⌘K search.** Returns task hits for admin and member; returns **zero** hits for a non-member (see below). | ✓ |
| UC-09 | **@mention → notification.** "@Elif …" from Arda landed in Elif's inbox as "Arda · mentioned you" with the quoted text, project·task context, and a Mark read action. | ✓ |
| UC-06 | **Reject path.** Closed PR #149 unmerged on GitHub → divergence note + recovery packet in Viberr. | ✓ |
| — | **R15-4 secrecy, exhaustively.** Provisioned a genuine NON-member (Murat) through the real admin flow. All 8 project routes → **404**; ⌘K search → **0 hits**; home never names the project; a comment POST → **404**. The project is invisible, not merely refused. | ✓ |

## Phase E: the UX coherence pass (24 findings)

A second adversarial Workflow audited SIX end-user dimensions across every surface — vocabulary,
state semantics, affordance honesty, empty/error/first-run states, navigation, and a11y/responsive —
with **two independent skeptics per finding** (a refuter and a reachability checker). 34 candidates →
**24 confirmed, 10 rejected**. All 24 implemented, each with a test that fails without the fix and a
canary proving it. Committed as `fe11c0a`. Full detail per finding: `ux-audit-result.json`.

The three that mattered most, all live-reproduced:

- **The notifications inbox pilled EVERY decision packet "completion report"** — by fall-through, not
  by type — and gave it a completion checkmark. A scoping question therefore arrived looking like
  something to accept, contradicting its own row title ("Decision needed: …") and the same packet's
  pill on the task page. Verified fixed live: it now reads `decision required` in the input tone.
- **An `archive_task` packet option deleted the remote branch from a generic "Confirm decision"** with
  no disclosure — the same family as the acceptance-disclosure defects this pass already closed, on
  the one other irreversible act in the product. It now names the branch, says the deletion cannot be
  undone, lists what the archive withdraws, and offers "Not yet".
- **The Review queue rendered a capability label that was deliberately retired** ("Completion for
  human acceptance" — retired because it read as a guarantee it does not make) and then told the
  reader to go find it on Policy, where it is called something else. A test was PINNING the stale
  string. The label now comes from the capability catalog by id, so the two surfaces cannot drift again.

Cross-file patches the cluster agents could not make themselves (all applied and verified here):
the bell popover carried the identical "caught up while unread rows are on screen" defect as the
notifications page; `home-page` now tells a member who can add a PAT instead of linking them into a
403; the delete-profile toast and the operator's own recommendation detail both still used retired
vocabulary or promised behaviour ruling 26 makes false.

One test correction worth recording: wiring `archiveDisclosure` into the page made the confirm name
the REAL branch (`vib-151`) where the un-wired fallback said "the branch". The test had been written
against the fallback, so the wiring "broke" it — the fix was to assert the better behaviour, not to
restore the worse one.

**Suite after: 3048 tests / 225 files green, `tsc --noEmit` clean.**

> **The consolidated, numbered use-case register is [`USE-CASES.md`](USE-CASES.md)** — 36 cases, each
> run against the live app with its evidence artefact named. The per-round sections below are the
> working log that produced it.

## Finding ledger

IDs: F19-nn (defects), UX19-nn (UX/coherence), Q19-nn (owner questions), N19-nn (notes/ideas).
Every entry gets a disposition before implementation phase closes: FIXED / RULED / RETRACTED / NOT-A-BUG.

| ID | Area | Summary | Disposition |
|----|------|---------|-------------|
| UX19-1 | task detail | Permissions panel rendered copy cites internal ruling id ("the owner authority R6-2 adds") — internal jargon in end-user copy (task-side-panels.tsx:328) | |
| F19-1 | operator | NARROWED after 3 live runs: whether a delivered task gets an actionable next step is left to the operator MODEL. VC-4/VC-5 recorded a "Move to Review" recommendation; **VC-1 recorded none** and narrated the false "The task will move to Review; no further action needed" — leaving the task `waiting:human` with no recommendation, no packet and no chip. R18-2 skips the auto re-queue at Supervised deliberately, so nothing server-side guarantees an actionable surface after delivery. Fix belongs server-side (delivery must leave a recommendation/packet, or the UI must surface "delivered, awaiting your Move to Review"), not in persona wording. | |
| UX19-2 | task detail | GitHub panel shows "Acceptance is blocked … an admin can force-accept" + Force-accept button while Current state says "Not acceptable yet — at In Progress, not Review". Two adjacent panels give contradictory acceptance affordances at impl stage. Verify what Force accept actually does pre-Review. | |
| F19-2 | specialist-run | `deliveringContextGrants`/`withDeliveringGrants` docstring says grants were "widened to SKILLS by LV-F3" but both call sites union `kb` only — reviewer does NOT inherit deliverer skills. Either honest-docstring fix or complete the widening (needs decision: R18-1 said KBs; skills widening intended?) | |
| UX19-3 | review queue | **RETRACTED — my artifact, not a bug.** I claimed the queue and the task page contradicted each other "at the same instant". They did not: the task-page capture ("Acceptance is blocked: no approving verdict yet") was taken at ~22:58 while the reviewer was still running, and the queue capture ("validation healthy · your acceptance") after the verdict landed at 23:01:38. Each surface was correct at its own instant. Verified in code that no divergence is possible: `listReviewQueue` includes ONLY tasks at the review stage (`review-queue.server.ts:95-97`), so the stage gate cannot differ, and its `isReady` reads `validation_block_reason` — the same projection whose producer `acceptanceBlockReason` (`rebuilder.server.ts:294`) mirrors the server's `verdictGateReason` gate-for-gate, including the identical `validation === "healthy"` clearance. | RETRACTED |
| N19-5 | tests | Q-V1 (danger-zone hidden for non-lifecycle members) shipped with no test; Q-V1 "PAT half" explicitly unimplemented (see pass19 UI-INVENTORY rough edges). | |
| F19-3 | acceptance | Applying the operator's `accept_completion` recommendation merges + closes with NO confirmation dialog — violates R15-1 ("Every accept — including force — shows a confirm dialog stating what merges and any missing signals"). Board-drag got its confirm in pass-18 (B1); the rec-Apply path was missed. Live-repro: VC-1, single Apply click → Done+merged instantly. | |
| F19-4 | operator context | At triage the operator's workspace holds only task.md (no repo clone) and it labeled that view "Repo contents visible to operator: only task.md — no docs/ or README found" in a packet — false about the actual repo (has README/docs). Persona should forbid describing the task workspace as the repository; consider giving get_task a real repo summary (default-branch top-level listing) for scoping. | |
| Q19-1 | product | Should the operator get read-only repo visibility pre-execution (triage/scoping) so packets ground in the real repo? Today its packets invent options blind (VC-2 offered "Add/rewrite README" for a repo that has one). | |
| F19-6 | delivery/ops | Specialist workspace clone failed with `git exit 128` (VC-3, Codex Developer, hadCredential:true) while the same repo clones fine from the shell. `cloneFailureLogDetails` drops `stderr`/`message` for credential safety, so NOTHING says why — operator opened an honest blocked packet but no human can act on it either. Need a redacted-stderr channel (token value is in askpass env, never in argv/URL, so scrubbing the known token string is sufficient) surfaced in the run log + packet. | |
Audit-workflow confirmed findings (2-skeptic verified; full detail in audit-workflow-result.json — treat that file as the spec for each):

| ID | Sev | Area | Summary |
|----|-----|------|---------|
| F19-7 | HIGH | acceptance | Packet `accept_completion` option merges the PR from "Confirm decision" with NO merge disclosure (no PR#/sha/verdict/target, no "Not yet") — decision-packet.tsx:329; same family as F19-3 (rec-Apply). Together: 2 of the acceptance writers skip the R15-1 dialog. |
| F19-8 | HIGH | board | Archived board cards keep live readiness/validation pills + working Move controls under the "abandoned work" banner (board-page.tsx:257); UXO-1 removed exactly this from TaskHero. transitionStage/reorderTask have no archived guard. |
| F19-9 | MED | nav | Rail Board/Review badges count archived tasks; board header + review queue exclude them (project.tsx:116). |
| F19-10 | MED | acceptance | "Complete merge" affordance hidden from the contributor-owner the server authorizes (task-detail-hooks.ts:116) — merge-pending strands unless a maintainer visits. |
| F19-11 | MED | copy | Execution profile: "open to any project member" vs sibling "contributor+ to own" (execution-profile.tsx:802). |
| F19-12 | MED | vocab | Retired "primary specialist" vocabulary still rendered (rec labels, @-mention picker, timeline events; operator-actions.server.ts:1280) — D9/Q17-5 said engagement vocabulary. |
| F19-13 | LOW | board | List view drops merge-pending/closed-PR pills the card view carries (board-page.tsx:512) — H10 re-opened in one of two views. |
| F19-14 | LOW | copy | Accept dialog prints raw internal PR state token not the canonical pill label (accept-confirm.tsx:81). |
| F19-15 | HIGH | runtime | Any second run on a task strips the `.claude` catalog out from under a LIVE Claude run — silently unmounts its granted skills mid-run (specialist-run.server.ts:1868, R18-3 strip vs R18-5 mount interaction). |
| F19-16 | MED | runtime | R18-5 Claude-native vs Codex-clipped skills asymmetry disclosed nowhere in UI (capability-matrix-modal.tsx:197 has the section for exactly this). |
| F19-17 | MED | docs | runbook.md:92 claims session sweep "at boot and daily" from a `sessions` table; neither exists. |
| F19-18 | HIGH | delivery | Failed delivery push records its reason NOWHERE (push-workspace.server.ts:401) — same shape as F19-6 clone diagnostics. |
| F19-19 | MED | reconcile | Overlapping reconcile passes duplicate divergence note + watcher notifications (github-reconciler.server.ts:403) — NFR16 idempotency. |
| F19-20 | MED | schedules | Scheduled operator re-run can fire on a task that reached Done mid-tick (schedule.server.ts:309) — FR39 says never on terminal. |

(Audit dimensions "acceptance-gates" and "rbac-capability" finders stalled — acceptance covered by ux-coherence + live tests; RBAC covered by live probes (viewer/contributor/non-member) — re-verify RBAC writers during phase 3 review.)

| F19-21 | acceptance | **R17-2's "Completed — no changes" is unreachable for a task that never needed a branch.** `fm.noChanges` is set ONLY inside `performDelivery` (task-actions.server.ts:3482 `no_commits`, :3621 "Review has no PR") — i.e. only after a delivery ATTEMPT. Live repro (VC-5, verification-only task): reviewer approved on main, no branch was ever created, `accept_completion` returned `[noop] No reviewed revision yet — nothing for the required reviewers to approve`, and the operator had to open a decision packet asking a human "how to close out?", whose recommended option is "Manually mark Done" — bypassing the acceptance ceremony that R17-2 exists to preserve. A verify-only/no-op task is exactly the shape R17-2 named; it must be able to reach the no-change completion without faking a delivery. | |
| Q19-2 | product | When an org knowledge base and the repo's OWN documented conventions conflict, which wins? Live: `qa/smoke/README.md` documents an H1+bullet pass-note format; my KB documented a different one. The Codex Developer (KB granted) followed the KB; the Claude Doc Writer (KB not granted) followed the repo README and explicitly flagged the two KB-shaped files as non-conforming. Both behaved reasonably — but the product gives agents no precedence rule, so two agents on one repo produce divergent house styles. | |
| F19-5 | a11y | Context-resource grant chips (skills/MCP/KB) in create/edit-profile modal lack `aria-pressed` — screen readers can't tell granted from not. Same file's backend (:243), autonomy (:304), stage (:430) chips all have it; the resource chips at create-profile-modal.tsx:678-696 were missed by G5/UXA-4. | |

## UI tour log

Setup: docker-data was near-fresh (1 user Arda/admin, 1 connection akin-ozer w/ 3 repos,
2 specialist profiles + operator, 3 skills, 0 KB/MCP, 0 projects). Container stopped;
host dev server on :5173 against docker-data (writer-lock handover clean: strip shows
"Writer: pid 93770 on Akins-MacBook-Air.local").

- **Login**: local-first form (R17-4 visible), SSO footnote when unconfigured. Copy honest. ✓
- **Home**: greeting + "All quiet" status line, project grid/list, Settings hub (3 cards),
  admin store-maintenance strip w/ writer identity. ✓
- **Instance settings** (org/settings, 3 tabs): connections (PAT masked, "unproven —
  verified when attached to a project" honesty chip), users (whitelist-model copy),
  agent resources (KB/MCP/Skills/Global profiles). ✓
- **New project dialog**: name→auto key, connection chip, free-text repo field,
  workflow preset (Standard·5), policy presets (Strict/Balanced/Autonomous) with
  completion-disclosure copy, footer shows created store path. Created "Viberr Core"
  (VC) → akin-ozer/viberr, Balanced.
  - **N19-1**: repo field is free text; connection knows its repos (3) — no
    autocomplete/validation until submit. Check what an invalid repo does.
- **Board (empty)**: 5 stage columns, filter chips (All/Waiting on me/Agent working/
  Blocked or waiting), Re-scan, New task, Board/List toggle. ✓
- **Agents page**: stat tiles, Operator/Developer/Reviewer profiles w/ eligible stages,
  3-tier capability policy, context resources, backend order, autonomy, continuity;
  Capability matrix dialog incl. "What differs between the two runtimes" (Codex vs
  Claude honesty: MCP naming, mid-run comments, unauth MCP on Codex, matrix-not-gating-MCP). ✓
- **Policy page**: RBAC action×role table (4 roles), members-only prose, agent capability
  summary (5/2/3 etc.), ALWAYS_HUMAN list, workflow rules per transition
  (Auto/Human approval/Human only; Review→Done locked V1 + full-autonomy exception copy). ✓
- **GitHub page (empty)**: repo card, credential health (scope chips), PR/branch tables
  with honest empty copy ("merging stays reserved for humans…"). ✓
- **Activity (fresh)**: stream (All/Humans/Agents/System) + separate Audit logs section
  (project created / credential assigned / scopes re-checked). ✓
- **Settings**: name/prefix/description, stage editor (drag/move/rename, re-wire copy),
  members+invite (default Viewer), repo+creds (After merge: delete branch), danger zone. ✓
- **Review queue (empty)**: two sections (Waiting on your acceptance / Still in review),
  honest gate copy. ✓

Doc-ledger candidates from INTENT.md distillation (verify in phase 3):
- **N19-2** ux-design-spec still claims Roobert PRO; app ships Manrope (ruling-44 failure mode).
- **N19-3** docs/architecture/file-formats.md says "8 kinds" of packet option; there are 9 (archive_task).
- **N19-4** design-system radius/token drift: documented card 18/panel 28/canvas 44 vs shipped 16/22,
  and `--pink`/`--dark-red`/`--radius-large` documented but never defined. Decide: fix docs (canon rule).

## Use-case ledger

Status: ▶ running · ✓ pass · ✗ finding filed · ○ pending

| UC | Scenario | Status |
|----|----------|--------|
| UC-01 | Create project (Balanced preset, akin-ozer/viberr) | ✓ |
| UC-02 | Task via UI → operator auto-triage, auto-advance ×2, deploys Developer | ✓ |
| UC-03 | Codex developer implements on task branch; operator delivers + opens PR | ✓ (PR #147) |
| UC-04 | Reviewer engagement at review boundary; verdict-gated acceptance | ✓ (pinned-revision approve) |
| UC-05 | Human acceptance → real merge + after-merge branch delete | ✓ via rec-Apply; ✗ F19-3 no confirm dialog |
| UC-06 | Reject path: close PR externally → recovery packet surfaces in viberr | ✓ (VC-4/PR149: divergence note, moot rec withdrawn, packet; self-withdrew on external reopen) |
| UC-07 | Merge PR externally via gh → adoption/reconcile behavior (DG-1 guard) | ○ phase-3 validation |
| UC-08 | Underspecified task → triage quality gate flags, input_required + packet | ✓ (VC-2, 4-option packet w/ operator pick + edit_goal) |
| UC-09 | @operator / @Developer comments; agent @tags human back + notification | ✓ partial (operator↔agent mentions + notify observed; human-initiated @operator question pending) |
| UC-10 | Ownership: assign me; contributor-owner accepts own task (R6-2); admin release | ✓ partial (Elif contributor self-take VC-4; admin release + owner-accept pending) |
| UC-11 | Second/third user; RBAC per role; members-only invisibility | ✓ (non-member 404 all routes; viewer 403-except-comment; contributor take-ownership) |
| UC-12 | Operator recommends impl→review; human applies rec (R15-3) | ✓ (VC-5) |
| UC-13 | KB: create, grant to developer; reviewer KB inheritance (R18-1) | ✓ (Marker-Convention v3 emitted by dev, verified byte-level by reviewer) |
| UC-14 | MCP: add server, grant; tools reach Claude run; Codex naming/no-auth delta | ○ phase-3 validation |
| UC-15 | Skills: granted skill loads (R18-5); decoy skill NOT loaded | ✓ (kubernetes-rollback decoy never surfaced; dev named only its grants) |
| UC-16 | Backend parity: same work Claude vs Codex developer | ✓ (Doc Writer/Claude delivered VC-4 same envelope as Codex VC-1/3; operator picked it for a docs task) |
| UC-17 | Full autonomy + completion grant → done (merge pending), human merges (R16-6) | ○ phase-3 validation |
| UC-18 | Scheduled operator re-run fires (FR39); cancellable; terminal guard | ○ phase-3 validation (also validates F19-20 fix) |
| UC-19 | Force-accept past missing verdict; divergence surfaced (R17-1) | ○ phase-3 validation (also validates F19-3/7 dialogs) |
| UC-20 | "Completed — no changes" outcome (R17-2→R19-1) | ✗ F19-21 filed; re-run after R19-1 lands |
| UC-21 | Blocker → decision packet; resolve via UI options | ✓ (VC-3 blocked packet resolved via retry option; VC-2 edit_goal resolve pending) |
| UC-22 | Archive task (+deleteBranch); archived drops live pills | ○ phase-3 validation (also validates F19-8) |
| UC-23 | Hand-edit task.md in store → Re-scan reconciles (FR10) | ○ phase-3 validation |
| UC-24 | Search/⌘K + notifications drawer + unread badge | ○ phase-3 validation |
| UC-25 | Push commit after review → revision drift surfaced on accept (R17-1) | ○ phase-3 validation |
| UC-26 | Org-admin override on non-member project (audit trail) | ○ phase-3 validation |
| UC-27 | Interrupt operator mid-run; manual re-run | ○ phase-3 validation |
| UC-28 | Branch collision with foreign remote branch → human-gated packet (R18-4) | ○ phase-3 validation |

## Open owner questions from round 2/3 (nothing blocked on them)

- **N19-7 — the reviewer's evidence surface.** *(Sharpened 2026-08-08.)* The raw
  evidence surface EXISTS and I nearly filed that it did not: `EvidenceRow` is deliberately a CITATION
  (`{label, add, del}`) and the `evidence-separation` guardrail strips raw output from prose and points
  at the run logs — which the UI renders in full (VC-7's MCP tool call AND its result were both visible
  there). So the gap is narrower than first written: a REVIEWER reviews the diff and has no way to read
  or cite the delivering run's log, so the proof sits in the app unreachable by the one actor who needs
  it. The fix is not "build an evidence surface" — it is "let a reviewer cite the delivering run's log". A reviewer reviews the DIFF. A task whose acceptance
  criterion is a *runtime* fact (a tool really was called; a skill really was absent) is therefore not
  reviewable: VC-7's Reviewer correctly refused to treat the delivering agent's self-report as proof.
  Either such tasks are out of scope for agent review, or a run's own tool-call evidence needs to
  become citable evidence a reviewer can read. Recorded, not fixed — it needs your call.
- **F19-26 — an org-admin override on a non-member project is audited as an ordinary action.** The
  Policy page promises "every override recorded in the audit trail as org-admin override", and
  `project.org_admin.override` exists and is enforced for guarded MUTATIONS. But the `"any-member"`
  gate is deliberately exempt (auditing it once wrote a row per page load — F7-pass7 audit noise), and
  **commenting rides that gate**. Live: a non-member org admin commented on Viberr Core and the audit
  row is an ordinary `task.comment`, indistinguishable from a member's. The exemption's own comment
  says it covers "config-surface route READ plus a couple of idempotent no-op paths" — a comment is
  neither. Narrow fix: audit the override for `any-member` MUTATIONS while keeping reads exempt.
  Left for your ruling because the fix trades audit completeness against the noise that motivated the
  exemption.
