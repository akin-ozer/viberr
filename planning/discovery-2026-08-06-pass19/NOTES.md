# Pass 19 — discovery notes (2026-08-06)

Scope: full product pass. Phase 1 discovery (code + docs + UI tour), Phase 2 live use
(20+ use cases, PR-based tests against github.com/akin-ozer/viberr in a NEW project),
Phase 3 implementation of every finding, live-validated.

App under test: production compose container `viberr-app-1` on :5173, data root
`docker-data/` (host dev server must stay OFF — dual-writer WAL hazard).

Reference docs: planning/discovery-2026-08-06-pass19/reference/ (refreshed from pass 18
against main @65063b8). Intent distillation: INTENT.md.

## Finding ledger

IDs: F19-nn (defects), UX19-nn (UX/coherence), Q19-nn (owner questions), N19-nn (notes/ideas).
Every entry gets a disposition before implementation phase closes: FIXED / RULED / RETRACTED / NOT-A-BUG.

| ID | Area | Summary | Disposition |
|----|------|---------|-------------|
| UX19-1 | task detail | Permissions panel rendered copy cites internal ruling id ("the owner authority R6-2 adds") — internal jargon in end-user copy (task-side-panels.tsx:328) | |
| F19-1 | operator | NARROWED after 3 live runs: whether a delivered task gets an actionable next step is left to the operator MODEL. VC-4/VC-5 recorded a "Move to Review" recommendation; **VC-1 recorded none** and narrated the false "The task will move to Review; no further action needed" — leaving the task `waiting:human` with no recommendation, no packet and no chip. R18-2 skips the auto re-queue at Supervised deliberately, so nothing server-side guarantees an actionable surface after delivery. Fix belongs server-side (delivery must leave a recommendation/packet, or the UI must surface "delivered, awaiting your Move to Review"), not in persona wording. | |
| UX19-2 | task detail | GitHub panel shows "Acceptance is blocked … an admin can force-accept" + Force-accept button while Current state says "Not acceptable yet — at In Progress, not Review". Two adjacent panels give contradictory acceptance affordances at impl stage. Verify what Force accept actually does pre-Review. | |
| F19-2 | specialist-run | `deliveringContextGrants`/`withDeliveringGrants` docstring says grants were "widened to SKILLS by LV-F3" but both call sites union `kb` only — reviewer does NOT inherit deliverer skills. Either honest-docstring fix or complete the widening (needs decision: R18-1 said KBs; skills widening intended?) | |
| UX19-3 | review queue | Queue card shows "validation healthy · your acceptance" under "Waiting on your acceptance (1 of 1)" while the task page says "Acceptance is blocked: no approving verdict yet". Opposite affordances on two surfaces at the same instant (reviewer still running). "validation healthy" chip semantics vs "awaiting verdict" hero pill. | |
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

## Live-session findings (2026-08-06 afternoon, ultracode run)

| ID | Sev | Area | Summary | Disposition |
|----|-----|------|---------|-------------|
| F19-22 | MED | github/honesty | **The "Synced" freshness cue reports the last CHANGING reconcile, not the last successful one.** `latestTaskReconcileAt`/`latestProjectReconcileAt` read `MAX(observed_at)` from `provenance WHERE action='github.reconcile'`, but DG-3 (github-reconciler.server.ts:579-581, `if (changed \|\| !ctx.skipUnchangedProvenance)`) deliberately skips the row on unchanged POLLER ticks to bound table growth. So a healthy task whose GitHub state is stable drifts to "Synced 1h ago / 3h ago / yesterday" while the poller verifies it every 5 min. LIVE-PROVEN: task panel read "Synced 1h ago" at 12:42Z with `audit_events` showing successful `github.reconcile.task` passes at 12:07/12:12/12:21/12:26/12:31/12:36/12:42 and the last provenance row at 12:01:55. The cell's own tooltip says "a background poller refreshes it every 5 minutes" — the panel contradicts itself. Same defect on the project GitHub page's "Updated Nm ago". FIX (keep DG-3): derive "last checked" from the per-tick audit row (bounded by FR33 90-day retention) and keep provenance for real changes → render both honestly ("Checked 2m ago · last change 40m ago"). | |
| UX19-4 | LOW | packet/coherence | The closed-PR recovery packet enumerates recovery paths (rework / archive / archive+delete / "reopening the PR on GitHub is also a valid path") but omits the **one-click in-app path the very same screen offers** — the GitHub panel's primary "Deliver branch & open PR" sits directly above the packet. A human reading the packet is told to go to GitHub while the app can do it in place. Decide: name the in-app re-delivery in the packet body, or explain why re-delivery is not a recovery path here. | |
| F19-3 | **HIGH — LIVE-CONFIRMED, worse than filed** | acceptance | Applying an `accept_completion` recommendation merges + closes with **no dialog at all**. Live chain (VC-4, 16:01:39Z): reviewer approved revision `81894e7`; I pushed `a4c790c` out-of-band; the **proper** side-panel path opened a fully R17-1-compliant dialog (MERGES `PR #150` into main / REVISION `81894e7c20ee` / MERGE HEAD `a4c790ce63ef` — "1 commit added since review; they merge unreviewed" in warning tone / VERDICT validation healthy / "Not yet"). I cancelled, then clicked **Apply** on the operator's rec: `dialogCount:0`, task → Done, PR **merged for real** (`bde64bb`), branch deleted — the unreviewed-drift warning shown nowhere before the act. The drift IS disclosed **after** the fact (completion timeline event names `a4c790ce63ef`), so the gap is precisely R15-1's pre-decision confirmation: one click merges unreviewed code and the human learns afterwards. Same family as F19-7 (packet path). | |
| F19-23 | LOW | copy | Completion event pluralization: "**1 commit were added** to the PR head (`a4c790ce63ef`) after the review". Singular/plural not switched (task-actions completion text). Live in VC-4's timeline. | |
| N19-6 | — | method | **RETRACTED hypothesis, recorded as a class.** I observed the closed-PR packet re-appear after a clean heal (reopen 11:27Z → note 11:36Z → packet withdrawn + fresh rec 11:40Z → divergence again 12:01:55Z) and hypothesised a stale-reconcile write loop. GitHub's own event log refuted it: `closed 11:10Z · reopened 11:27Z · closed 12:00:35Z` — a THIRD-PARTY close outside the app, 80s before the reconcile that reported it. The app was correct on every tick. Class: **the environment is not static during a live pass — always read the external system's event log before filing a state-machine bug.** | RETRACTED |

## Owner rulings (pass 19, asked 2026-08-06 — binding)

- **R19-1** (closes Q19-1, extends F19-4): the operator gets a **FULL read-only clone** of the
  project repo before execution (triage/scoping) — not just a summary. Packets must ground in
  the real repo. Persona fix alone rejected.
- **R19-2** (closes Q19-2): **repo-documented conventions outrank KB guidance on conflict**;
  KBs supplement. A stated precedence rule is injected with every KB grant.
- **R19-3** (closes F19-2): reviewer inheritance stays **KBs only** — R18-1 stands as ruled;
  fix the lying docstring in specialist-run.server.ts (`withDeliveringGrants`).
- **R19-4** (closes F19-1): after a **supervised** delivery the server GUARANTEES an actionable
  next step — `performDelivery` ensures a "Move to Review" recommendation (or equivalent packet)
  exists when the operator recorded none. Narration can no longer strand the task.

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
| UC-06 | Reject path: close PR externally → recovery packet surfaces in viberr | ○ |
| UC-07 | Merge PR externally via gh → adoption/reconcile behavior (DG-1 guard) | ○ |
| UC-08 | Underspecified task → triage quality gate flags, input_required + packet | ○ |
| UC-09 | @operator / @Developer comments; agent @tags human back + notification | ○ |
| UC-10 | Ownership: assign me; contributor-owner accepts own task (R6-2); admin release | ○ |
| UC-11 | Second/third user; RBAC per role; members-only invisibility | ○ |
| UC-12 | Operator recommends impl→review; human applies rec (R15-3) | ○ |
| UC-13 | KB: create, grant to developer; reviewer KB inheritance (R18-1) | ○ |
| UC-14 | MCP: add server, grant; tools reach Claude run; Codex naming/no-auth delta | ○ |
| UC-15 | Skills: granted skill loads (R18-5); decoy skill NOT loaded | ○ |
| UC-16 | Backend parity: same work Claude vs Codex developer | ○ |
| UC-17 | Full autonomy + completion grant → done (merge pending), human merges (R16-6) | ○ |
| UC-18 | Scheduled operator re-run fires (FR39); cancellable; terminal guard | ○ |
| UC-19 | Force-accept past missing verdict; divergence surfaced (R17-1) | ○ |
| UC-20 | "Completed — no changes" outcome (R17-2) | ○ |
| UC-21 | Blocker → decision packet; resolve via UI options | ○ |
| UC-22 | Archive task (+deleteBranch); archived drops live pills | ○ |
| UC-23 | Hand-edit task.md in store → Re-scan reconciles (FR10) | ○ |
| UC-24 | Search/⌘K + notifications drawer + unread badge | ○ |
| UC-25 | Push commit after review → revision drift surfaced on accept (R17-1) | ○ |
| UC-26 | Org-admin override on non-member project (audit trail) | ○ |
| UC-27 | Interrupt operator mid-run; manual re-run | ○ |
| UC-28 | Branch collision with foreign remote branch → human-gated packet (R18-4) | ○ |
