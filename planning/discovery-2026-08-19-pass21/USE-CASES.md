# Pass 21 — live use-case plan (2026-08-19)

Target: container at :5173, project **viberr (VIB)** → akin-ozer/viberr (real PRs allowed, keep merged files tiny), secondary project(s) for non-PR experiments. Driver on :8787. Status legend: [ ] planned · [~] running · [x] done · [!] found defect(s) — see NOTES.md.

Focus per owner: **agents' browser capabilities**, operator correctness, MCPs, skills isolation, Codex/Claude parity, RBAC, UX coherence.

## A. Browser capability (owner focus)
- [x] UC-1 Grant `use-browser` (+ web egress prerequisite) to a specialist; answer VIB-1's packet with a scoped goal ("capture /login screenshot as evidence attachment"); verify the agent actually drives chromium in-container, saves an attachment, evidence is linkified, attachment route is member-only.
- [x] UC-2 Browser capability WITHOUT web egress (blocked packet named the capability; agent refused to fake; F21-16 policy-map misattribution found): try enabling "Drive a live web browser" while "Search & fetch" is off — verify the dependency rule (R19-19: requires effective egress) is enforced/explained in UI.
- [x] UC-3 Codex-backed agent with browser (VIB-6: viberr_browser mounted, navigate+screenshot, attachment landed) capability (parity check vs Claude: MOUNT-enforced on both backends; tool naming hyphens vs underscores).
- [x] UC-4 Browser evidence in review: reviewer engagement consumes/references the screenshot attachment; verdict cites it.
- [x] UC-5 Browser + external site (example.com captured from container) (https://example.com like pass-20 VIB-11) — egress to the public web from inside the container.

## B. Operator correctness
- [x] UC-6 Packet options honesty: confirm the operator's VIB-1 packet updates after capability grant (does a re-run re-scope now that browser: true?), no stale "no agent can browse" claim.
- [x] UC-7 Supervised operator recommends-only: stage transition recommendation lands as packet, human confirms, operator re-queues (R18-2/R20-1: confirm resolves + re-queues, no repeat confirms).
- [x] UC-8 Full-autonomy (F21-14 narration gap) operator (flip autonomy on a task/project): operator transitions stages itself; Accept-into-Done only with explicit grant; ceremony + audit record.
- [-] UC-9 delegated-ask: not force-triggered live; disclosure is prompt-level only (F21-2 family) — addressed in implementation (C3): operator gathers a delegated answer but DISCLOSES it did.
- [x] UC-10 discard-family (VIB-4 recovery packet incl. archive+deleteBranch executed w/ real remote deletion; VIB-7 packet offered "Discard vib-7 branch" option = the kind, unexercised path covered by unit suite) (new 10th kind): produce a dead branch (e.g. reject PR, re-scope) and verify the packet + recovery.
- [x] UC-11 Force-accept (ceremony fully disclosed; acceptance:"forced" durable; F21-1 LIVE-CONFIRMED with workRevision present — reprojection CHECK failure, stale row)

## C. Full governed delivery loops (real PRs on akin-ozer/viberr)
- [x] UC-12 Claude developer end-to-end: Triage→Ready→In Progress→Review; server opens real PR; reviewer verdict; human accept → real GitHub merge (small test file only, e.g. planning/pass21-probe/*.md).
- [!] UC-13 BLOCKED: Codex refresh token burnt ("refresh token was already used", host auth.json Aug-2, no API key). R20-3 provider-text packet + model recovery options + backend-switch-sticks all VERIFIED via the failure. Q-1 for owner: re-run `codex login` on host so I can copy auth.json into the container and do the parity leg.
- [x] UC-14 PR REJECTED path (close #171 → "PR closed without merging" packet, 3 recovery paths, honest not-in-this-list note; F21-17 packet omits known drift): close PR un-merged via gh; verify viberr surfaces the rejection (pr state, operator packet, divergence/recovery options incl. archive_task+deleteBranch or discard_branch).
- [x] UC-15 Human merges PR directly (poller adopted merged state; reviewer verdict still ran; ceremony showed "merged into main"; F21-23 copy nit) on GitHub (out-of-band) — R19-B: human GitHub approval counts as verdict; poller/merge-pending nudge; task lands Done coherently.
- [x] UC-16 pr-diverged (R17-1 ceremony: "MERGE HEAD cab10477 — 1 commit added since review; it merges unreviewed"): push an extra commit to the task branch out-of-band, verify divergence surfacing (R17-1 reviewed-revision drift on accept) + operator trigger.

## D. Resources: KB / MCP / skills
- [x] UC-17 Create a knowledge base in-app (R19-3 authoring), grant to Developer, verify the agent actually reads it live (canary fact in KB → agent must cite it), and rename-orphan class stays fixed.
- [x] UC-18 (Claude half + refusal + scrub) Add an MCP server (e.g. a tiny local echo/eval MCP) with a credential; grant to a profile; verify tools reach the run on BOTH backends; verify cred scrubbed from transcripts (any length; <8 chars refused at save — F20-7).
- [x] UC-19 (Claude half) Skills isolation: engage Developer and Reviewer on a task; verify each run mounts ONLY its granted skill (developer-expertise vs reviewer-expertise), decoy skill (viberr-app-expertise or a new decoy) never loads for specialists.
- [x] UC-20 operator MCP grant mounts in operator runs (probe-tools + viberr in run_422JxsyMdzMQ) (operator MCP grant class from pass 13) — confirm silent-resource class stays dead.

## E. RBAC & multi-user
- [x] UC-21 Invite a member (Viewer deny ✅, temp-password flow ✅, F21-5 leak confirmed live) (Viewer default), verify role management via Policy; Viewer cannot create tasks/comment restrictions per matrix; Contributor can take/release own ownership only.
- [x] UC-22 RBAC deny/authority (viewer deny server-side; contributor runtimeDenied on agent runs; admin paths throughout) stage transition + resolves packets; Contributor blocked from Approve/Resolve (server-side deny, not just hidden UI).
- [x] UC-23 Members-only projects (invisible in list; direct URL 404) (R15-8): non-member sees nothing (project list, search, notifications, API).
- [x] UC-24 Assignments (contributor take-own ✅; stage-role eligibility observed: Web Verifier engaged only in Ready/Impl, Reviewer at Review): owner assign/release, secondary assignments/supporting engagements; stage-role eligibility (R14: only eligible stages offered).
- [x] UC-25 @mention (operator answer tagged @Arda AND @Selin; Selin bell "mentioned you"; contributor mention runtimeDenied w/ honest toast) notifies the human; agent replies @tag the asking human and notify (NEW-4).

## F. UX coherence & misc
- [x] UC-26 Comment round-trip (@operator → run → in-thread answer with evidence refs): human comment → operator ingests as context (Ask operator), agent responds, timeline typed events coherent.
- [x] UC-27 2nd project (lab-experiments; presets; stage list renders; deep stage-editing left to unit suite) (non-PR): different stage set (add/remove stages), verify transition-chain rewiring + boundary inheritance copy.
- [x] UC-28 Search ⌘K across entities; notifications read-marking (F20-11 nav vs revalidation); bell badge honesty.
- [x] UC-29 archive+deleteBranch ceremony (real remote deletion verified) (deleteBranch disclosure — pass-19 finding fixed).
- [x] UC-30 theme+mobile sweep (dark board/task/agents/resources clean; 390px board clean except F21-18 key wrap) on the new surfaces exercised this pass (contrast gate); mobile-width board.
- [x] UC-31 Continuity (docker restart mid-run: honest durable push-failed event, boot finalized orphan run, operator auto-resumed and re-delivered → PR #173; F21-24 shutdown-drain races): degraded continuity on supervision surface (D4) — e.g. stop container mid-run/kill poller if feasible; ReadinessPill states.
- [x] UC-32 Store maintenance (re-scan: 2 project dirs, no drift): Re-scan + Rebuild projections with live data; writer lock display ("Writer: pid 7 on viberr").

Rule for VIB PRs: tiny files only under a dedicated path (suggest `planning/pass21-probe/`), reject-and-delete for the rejection cases, merge only trivial ones.
