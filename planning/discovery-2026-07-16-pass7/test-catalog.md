# Live test catalog — pass 7 (2026-07-16)

Fixture: arda=org-admin/project-admin · elif=maintainer · murat=contributor (playground:
project-admin, creator) · selin=viewer · deniz=org member, NOT a viberr member.
All test users password `viberr-test-2828` (temp-password + forced-reset flow exercised).
Projects: `viberr` (VIB, akin-ozer/viberr, PAT-connected) · `playground` (PLG, repo-less).

| # | Case | Verdict | Evidence |
|---|---|---|---|
| TC-1 | Self-serve project creation by plain org member (murat) | **PASS** | `playground` created repo-less; creator seeded project-admin; operator auto-deployed |
| TC-2 | Org user provisioning: local accounts, one-time temp password, forced reset at first sign-in | **PASS** | 4 users via Allow-access modal (GitHub/Google/Local switcher); temp pw shown once; set-password gate enforced (curl flow 302→reset→home 200) |
| TC-2b | Project membership: invite (joins viewer), set-role via Policy | **PASS** | invite intent ×3 → viewers; set-role elif→maintainer, murat→contributor; project.md updated live |
| TC-3 | RBAC probe matrix (API, per role) | **PASS** | viewer/non-member create-task 403; contributor update-goal 403 / maintainer 200; contributor manual transition 403; contributor reorder 403; viewer own-take 403 / contributor 200; maintainer release-other 403 / admin 200; comment app-wide: viewer 200, NON-MEMBER 200 (FR4) |
| TC-8 | Operator triage honesty: well-scoped task auto-advances; vague task held | **PASS** | VIB-2 (well-scoped): triage→ready→In Progress + codex Developer assigned + branch minted in <30s. PLG-1 ("make things better somehow"): held at triage, readiness=input_required, waiting=human, high-quality input packet (3 typed options, 1 recommended) |
| TC-18 | Decision packet lifecycle: open → owner resolves → operator re-engages | **PASS (partial — resolution by project-admin)** | PLG-1 packet resolved (option 0 request_edit) + goal updated → readiness=ready, waiting=agent, operator re-invoked automatically |

| TC-9 | Approval boundary In Progress→Review via operator recommendation + maintainer apply | **PASS** | Operator posted transition recommendation (waiting=human); elif applied it via apply-recommendation → stage=review; R5 seam re-executed under approve-transition RBAC |
| TC-12/13 | Reviewer verdict cycle: request-changes → validation=failing → rejection sticks → human rework loop | **PASS (flow) + found F7-REV1/F7-FLOW1** | Claude reviewer legitimately rejected PR #29 (caught a real doc inaccuracy); quality event + failing validation recorded; validation stayed failing through backward transition; operator escalated a 3-option packet (override marked not-recommended) |
| TC-18b | Blocked packet resolution by maintainer + manual backward transition | **PASS** | elif resolved option 0 + moved Review→In Progress; operator auto-re-prompted the dev |
| TC-20a | Agent-side delivery: codex dev committed, pushed, opened PR #29 itself | **PASS** | `[VIB-2]` commit prefix, branch `vib-2-add-testing-quickstart-doc`, PR linked in timeline + github card |
| TC-25a | Real MCP server registration + probe (stdio JSON-RPC) | **PASS** | notes-fixture registered via UI; probe handshake → tools_count=1, up=1 |
| TC-26a | KB + custom skill created via UI; attached to new profile | **PASS** | docs-style skill (disk+DB), testing-conventions KB, Docs Writer profile (claude/sonnet/high, impl-only, docs-style+KB+MCP attached) |
| TC-2c | Profile create/edit modal: grants + resources persist; ALWAYS_HUMAN pre-locked | **PASS w/ note** | merge/transition-done/change-policy locked to Human in modal; create-tick race note (see findings) |

| TC-16 | Operator routing (D3): docs task → Docs Writer over Developer; stage-eligibility hard filter respected | **PASS** | VIB-3: operator advanced to In Progress FIRST (Docs Writer is impl-only), then deployed Docs Writer; VIB-2 kept Developer for code-shaped work |
| TC-25b | MCP end-to-end INSIDE a real run | **PASS** | @mention resume on VIB-3: agent called `mcp__notes-fixture__get_viberr_release_notes`, fixture string round-tripped verbatim into its reply comment |
| TC-26b/27 | KB injection + org-skill isolation in a real run | **PASS (org-level)** | Docs Writer's report contains both DOCS-STYLE-MARKER-P7 (skill) and KB-MARKER-P7 (KB); persona carries only the declared skill. Known dev-only host-session slash-command leak (F13) visible in this environment — documented, not an app bug |
| TC-30a | @mention resume re-anchors + confinement re-threads | **PASS** | VIB-3 docs-writer resume run answered the probe without touching files |
| TC-7 | Org-admin read/act asymmetry (pre-D2 baseline) | **PASS (documents current)** | deniz as org-admin: sees project on home, board read 200 (app-wide), Policy page 403, create-task 403 — exactly the asymmetry D2/R7-1 will change |
| TC-10 | Drag Review→Done = acceptance (R6-4), repo-less honest copy | **PASS** | PLG-1: murat's board drag recorded "Completion accepted … (no linked pull request)", waiting=none, stage=done |
| TC-13b | Failed-review rework: dev re-delivers, validation stays failing until re-review | **PASS so far** | VIB-2: rework commit eecbbe2 pushed to PR #29; validation still `failing`; re-review recommendation applied → reviewer re-engaged |
| TC-12b | PLG-1 approve path: reviewer verdict healthy → quality event → accept rec | **PASS** | validation=healthy; quality "Review passed"; operator recommended accept |

| TC-19a | Q1 negative: full-autonomy operator WITHOUT completion-for-acceptance:direct must not accept | **PASS** | PLG-3 stayed in review; operator only (re-)recommended acceptance; server deduped the identical rec card (timeline shows 2 comments — noise noted) |
| TC-19b | Q1 positive: explicit direct grant → full-autonomy operator accepts itself | **PASS** | PLG-3 → Done, timeline "Operator accepted completion under **full-autonomy** policy" |
| TC-35 | Project delete purge | **PASS** | scratch project: files + projections gone after delete-project (confirmName guard) |
| TC-11 | Stage-eligibility deny at assign boundary | **PASS** | assign docs-writer (impl-only) on Done-stage VIB-1 → 400, specialist unchanged |
| TC-33 | Files-are-truth: on-disk task.md edit reprojected by watcher | **PASS** | VIB-3 title edit visible in task_projections ~2s later |
| TC-34 | Crashed run → error → operator escalation packet | **PASS w/ gaps** | PLG-2 codex SIGKILL → run error → "Work stalled — pick a recovery path" packet; GAPS: no D4 retry-on-other-backend option for unknown-class failures; generic auth-flavored codex copy for a crash (F7-RUN1 evidence) |
| TC-21/22 | External PR close via gh + Reconcile adoption | **PASS** | PR #30 closed via gh → reconcile → task pr.state=closed |
| TC-23 | Accept w/o credential → accepted (merge-pending) → re-credential → complete-merge | **PASS + found F7-GH5** | VIB-2: honest merge-pending copy; draft-PR merge refusal honest; after gh pr ready → complete-merge → MERGED (GitHub confirms) |
| TC-28 | Claude capability enforcement mid-run (commit-push=human) | **PASS** | VIB-4: git commit DENIED at tool layer under bypassPermissions; agent staged + paused honestly; operator opened commit-denied packet |
| TC-4 | R6-2 owner-exception accept | **PASS (RBAC layer) / blocked by F7-VAL1 (state layer)** | non-owner contributor 403; owner contributor passed authz but hit 409 from the blocked-packet validation=failing bug (repro kept) |
| TC-5 | Q2 owner-resolve of packet | **PASS** | murat (contributor owner) resolved VIB-4's packet (200) |
| TC-14 | Multi-reviewer / secondary assignment | **PARTIAL — found F7-REV2** | style-reviewer assigned + ran on VIB-5; unclear verdict language → no quality event → operator re-ran reviewer ×3 (loop; watching guard) |

| TC-15 | Remove reviewer mid-cycle | **PASS** | style-reviewer removed from VIB-5; reviewers[] emptied; loop stopped |
| TC-30b | Interrupt a running run (human, run-agents) | **PASS w/ finding** | run-interrupt → state=interrupted + interrupted_by recorded; BUT the interrupted reviewer's partial reply still went through verdict classification (flipped validation to failing — see F7-REV2/F7-REV3 notes) |
| TC-22b | External merge via gh + Reconcile adoption of MERGED | **PASS** | PR #31 squash-merged externally; reconcile → pr.state=merged in task.md |
| TC-31 | Archive read-only (R6-3) + restore | **PASS** | archived: create-task 409, comment 409, reads 200; restore: mutations work again |
| TC-32 | SSE liveness (implicit, observed all session) | **PASS (observed)** | agents-page live counters, bell badge, review-queue rail counts all updated without reloads across ~20 runs |

## Phase-2 wrap (13:15)

26+ distinct cases recorded above; ≥20 requirement met. PR lifecycle shapes all exercised on
akin-ozer/viberr: agent-opened PR (#29, #30, #31), app merge via accept (#26 this morning by
owner, #29 via merge-pending→complete-merge), external close + reconcile (#30), external
squash-merge + reconcile (#31), draft-PR merge refusal (#29). Merged files kept tiny + useful
(docs/testing-quickstart.md, planning/README.md, docs/project-file-inventory.md).
Regression fixtures preserved for phase 3: **VIB-4** (F7-VAL1 blocked-packet validation
brick + F7-PKT1 dispute packet) and **VIB-5** (F7-REV2/3 misclassified interrupt verdict,
"Review passed / Validation: failing" self-contradictory quality event, wedged failing with
merged PR). Uncovered-but-carried: F-PARITY1 (codex live usage, cosmetic), empty-diff
re-verify (pass-6 unit-tested), Landlock/compose (F-DOCKER2, environment-bound).

Timeline note: the @dev mention on VIB-5 at 13:10 did NOT produce a primary resume run
(reviewer ran instead) — investigate mention-resume routing when a reviewer chain is active
(phase-3 debug note, fold into F7-OP1 guard work).

## Notes / observations along the way

- Comments are accepted on a Done task (VIB-1 probes) — no closed-task comment gate. Product
  question, minor.
- The RBAC probes left benign timeline events on VIB-1 (ownership take/release, 2 probe comments).
- Board create-task defaults stage to triage; operator crossed BOTH auto boundaries
  (triage→ready, ready→impl) in one turn once a specialist was assigned — matches Policy copy.
