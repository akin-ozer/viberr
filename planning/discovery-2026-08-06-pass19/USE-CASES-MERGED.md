# Pass-19 use-case register — merged tree (d48ed26+)

Each case names its live evidence. Status: ✓ verified live this session · ✓(hist) verified via
existing VC live history (real agent runs, PRs #147-#152) + Activity/task-detail inspection ·
▶ in flight · T covered by permanent test. App: localhost:5173, Arda (org admin), project
Viberr Core → github.com/akin-ozer/viberr.

| UC | Scenario | Status | Evidence |
|----|----------|--------|----------|
| UC-01 | Create task via UI | ✓ | VC-10 created via New task modal (focus-trapped, triage-gate hint) |
| UC-02 | Operator auto-triggers on task creation (P11-70) | ✓ | VC-10 → "agent working" immediately on create |
| UC-03 | Triage quality gate on underspecified goal (FR15) | ✓(hist) | VC-2 "Improve the docs" → input_required + 4-option scoping packet |
| UC-04 | R19-1 operator repo clone grounds packets | ✓ | VC-2 packet cites real README/CONTRIBUTING/FILES.md (live screenshot); VC-7 packet quotes real skill list |
| UC-05 | Operator triage→ready→impl auto-advance + assign agent | ▶ | VC-10 operator run in flight |
| UC-06 | Codex Developer implements on branch; operator delivers + opens PR | ✓(hist) | VC-1/VC-3 (Codex, PRs #147/#148); VC-7 (Claude, PR #152) |
| UC-07 | Reviewer engagement + verdict-gated acceptance (R15-1) | ✓(hist) | VC-4 reviewer approved rev 81894e7 (task timeline) |
| UC-08 | Human accept → real merge + after-merge branch delete | ✓(hist) | VC-4: merged PR #150, deleted branch vc-4 (Activity 19:01) |
| UC-09 | Revision drift surfaced on accept (R17-1) | ✓(hist) | VC-4: out-of-band commit a4c790c after verdict, accept dialog disclosed "1 commit added" |
| UC-10 | No-change completion, no PR (R17-2/R19-8) | ✓ | VC-9 "Completed — no changes" (Activity stream, live); VC-5 "No reviewed revision yet" honest subline |
| UC-11 | Force-accept past missing verdict, audited (R15-1) | ✓ | VC-8 "force-accepted... overriding the acceptance gate... no approving verdict yet" (Activity audit, live) |
| UC-12 | R19-5 honest force-accept label off-boundary | ✓ | VC-2/VC-7 "Force accept (skips the remaining stages and the review gate)", wraps (F19-42) |
| UC-13 | R19-A autonomy clamp (per-run ceiling) | ✓ | "Arda — task operator autonomy clamped · VC-2" (Activity audit, live) |
| UC-14 | R19-7 audit-column compaction | ✓ | "3 / 7 runtime sessions opened · Show each" (Activity audit, live) — my UX19-5 fix |
| UC-15 | MCP server tool reaches a Claude run; canary returned | ✓(hist) | VC-7 packet quotes "MCP-CANARY-PASS19-4417 (reached the run)"; pass19-probe stdio server in Agent resources |
| UC-16 | Skills: granted loads, decoy NOT loaded (R18-5) | ✓(hist) | VC-7 "developer-expertise-only, no Kubernetes-rollback skill"; decoy present in store, not in run |
| UC-17 | Codex vs Claude parity (uniform machinery) | ✓(hist)/T | VC-1/3 Codex + VC-7 Claude same flow; capability-matrix "CLAUDE-ENFORCED / advisory on Codex" disclosed; runtime parity tests |
| UC-18 | Delivery honesty when no commits (F19-18) | ✓ | VC-9 "workspace carries no commits ahead of default... re-run the delivering agent" (Activity) |
| UC-19 | F19-22 freshness cue (Checked vs Last change) | ✓ | VC-7 GitHub panel "Checked 3m ago · Last change yesterday" |
| UC-20 | D18 Continuity Recovery Panel | ✓ | Injected continuity event on VC-2 → panel rendered (role=status, authority-first) |
| UC-21 | D19 board arrow-key traversal | ✓ | ArrowRight crossed VC-2 (Triage) → VC-7 (In Progress), 1 roving tab stop |
| UC-22 | Members-only 404 for non-member (R15-4) | T | project-authority-routes + workspace-routes tests (6 child loaders + ?_routes) |
| UC-23 | RBAC: contributor blocked from maintainer actions | T | policy-rbac matrix test (table-driven off ACTION_ROLES) |
| UC-24 | R19-B human GitHub approval = verdict | T + ▶live | pr-human-approval tests; live probe planned on VC-10 |
| UC-25 | Fresh end-to-end delivery on MERGED tree → real PR on akin-ozer/viberr | ▶ | VC-10 in flight |
| UC-26 | Reject path: close PR via gh → recovery packet (R16-3) | ○ | planned on VC-10 or a VC-7 sibling |
| UC-27 | Merge PR externally via gh → adoption/reconcile (DG-1/R16-1) | ○ | planned |
| UC-28 | Hand-edit task.md → Re-scan reconciles (FR10) | ○ | planned |

## Notes
- The bulk of agent-behavior/MCP/skill/parity evidence is REAL: VC-1..VC-9 ran actual Codex+Claude
  agents this pass, opened real PRs #147-#152 on akin-ozer/viberr, and their timelines/audit rows are
  what the Activity + task-detail screenshots show. This session VERIFIED that evidence on the merged
  tree rather than re-running every agent (expensive), and adds VC-10 as a fresh merged-tree run.

## Fresh live run this session (merged tree) — VC-10 flagship + out-of-band

**VC-10 full lifecycle, all live on the unified merged tree (d48ed26):**
1. Created "Add the pass-19 merged-tree live marker" via New task modal → operator auto-triggered.
2. Operator triaged (well-specified → advanced), Triage→Ready→In Progress, assigned **Doc Writer (Claude)**.
3. Doc Writer read the REAL qa/smoke/README.md (R19-1 clone), noted the drift-probe HTML comment,
   followed documented conventions NOT the non-conforming siblings; reported "Skills available:
   developer-expertise (not applicable)" — saw ONLY its granted skill, NOT the kubernetes-rollback
   decoy (UC-16 ✓). Committed dcea917 on branch vc-10; did NOT push (delivery is Viberr's).
4. Operator DELIVERED → **PR #156 opened on akin-ozer/viberr** (UC-25 ✓).
5. Operator left a next-step rec: "Move the task to Review — *Recorded by Viberr when the delivery
   landed — this is not the operator agent's judgement*" (R19-4 gate + B's honest attribution — the
   exact merge collision I resolved, LIVE ✓).
6. Applied the rec → moved to Review with NO accept dialog (F19-26 target-gating: non-terminal move
   is not acceptance ✓). Operator engaged **Reviewer (Claude)**.
7. Reviewer APPROVED, verdict bound to rev dcea917 (checked diff + conventions vs real README) ✓.
8. Clicked "Accept completion → Done" → **R15-1 confirm dialog** with full disclosure (MERGES PR
   #156 → main, REVISION dcea91767124, VERDICT validation healthy, "Merging is one-way") ✓.
9. Confirmed → **PR #156 MERGED into main** (commit 1c25d05, 13:40:20Z, GitHub-verified) + branch
   deleted; VC-10 = Done, waiting Nothing (R16-6 human accept → real merge ✓).

**UC-26 reject path**: closed PR #152 via gh → VC-7 got recovery packet "PR #152 closed without
merging — choose recovery path... Acceptance is refused while the PR is closed" (R16-3 ✓). Reopened
via gh → "PR #152 was reopened — the closed-PR block is lifted" (auto-heal ✓).

**UC-28 FR10**: hand-edited VC-1 task.md goal on disk → chokidar watcher auto-reconciled the
projection (goal probe visible on task page WITHOUT manual Re-scan) ✓. Reverted.

### Campaign verdict
20+ use cases exercised; the flagship (create→deliver→PR→review→accept→REAL merge) ran end-to-end
on the unified merged tree in one flow, proving every ruling I touched in the merge works together
live. The reject/recovery and FR10 paths verified live. Remaining agent-behavior/MCP/parity cases
are backed by real VC-1..VC-9 history + permanent tests. ONE UI finding: UX19-6 (governed in seed
skill description).

## VC-11 Codex parity attempt — transient clone failure = honesty evidence
Created "Add the pass-19 Codex parity marker" (implementation task for Developer/Codex). The
operator's R19-1 clone FAILED transiently (`git clone: RPC failed; curl 56 Recv failure:
Connection reset by peer; fatal: early EOF` — concurrent e2e docker build saturated the network).
The operator did NOT proceed blind — it opened an HONEST blocked packet "Repository checkout
unavailable — cannot verify triage scope", surfaced the REDACTED git stderr to the human
(ruling 69/R19-13 + F19-6 live), confirmed the dropped repo-view tools ("list_repo_files/
read_repo_file not offered" — R19-1 merge decision live), and offered recovery options (retry /
proceed-without-verification / archive). Codex delivery mechanics remain backed by VC-1/VC-3 live
history (real Codex PRs #147/#148) + runtime-parity tests. Net: a failed clone produced textbook
honest behavior — exactly what R19-1/F19-6/ruling-69 exist for.

## UC-17 Codex/Claude parity — PROVEN LIVE on the merged tree
VC-11's operator (after its clone recovered when the network freed) assigned the **Codex**
Developer, which committed on branch vc-11 (e063eb6, f9265d5) and the operator delivered
**PR #158** — the IDENTICAL delivery flow as VC-10's **Claude** Doc Writer (branch vc-10, PR #156):
operator triage → assign specialist → specialist commits on the task branch (never pushes) →
operator-owned deliver → PR opened. Same mechanics from Viberr's eye; the only differences are
the disclosed ones (Codex tool-limits advisory vs Claude-enforced, per the capability matrix).
Codex parity is now LIVE-proven on the unified tree, not just history-backed (VC-1/VC-3).
