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

| Cluster | Findings | Owner | State |
|---------|----------|-------|-------|
| Copy / a11y / vocabulary | UX19-1, F19-11, F19-5, F19-12 | me | ✅ committed `1836f00` (+ vocabulary lint, canaried) |
| Archived-task honesty | F19-8, F19-9, F19-13 | me | ✅ committed `57b04e9` (server guard + UI, canaried) |
| Acceptance confirm parity | F19-3, F19-7, F19-14, F19-10 | agent A | ▶ in flight (spec-acceptance-confirm-parity.md) |
| No-change acceptance (R19-1) | F19-21 | agent B | ▶ in flight (spec-no-change-acceptance.md) |
| Failure diagnostics + reliability | F19-6, F19-18, F19-19, F19-20 | agent D | ▶ in flight (spec-failure-diagnostics.md) |
| Docs canon + rulings promotion | F19-17, N19-2/3/4, R19-1..4 | agent E | ▶ in flight |
| Skill-mount race + runtime disclosure | F19-15, F19-16, R19-3 | — | ⏸ queued (spec-skill-mount-race.md; shares specialist-run.server.ts with D) |
| Operator repo view (R19-4) + KB precedence (R19-2) | F19-4, Q19-1, Q19-2 | — | ⏸ queued (spec-operator-repo-view.md; shares operator-actions with B) |
| Delivery leaves an actionable step | F19-1 | — | ⏸ queued |
| Reviewer-KB docstring (R19-3) | F19-2 | — | ⏸ folded into skill-mount cluster |
| Two-surface acceptance contradictions | UX19-2, UX19-3 | — | ⏸ queued (re-check after A lands) |
| Q-V1 test gap | N19-5 | — | ⏸ queued |

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
