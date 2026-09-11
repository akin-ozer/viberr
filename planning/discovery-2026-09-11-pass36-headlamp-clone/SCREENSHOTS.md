# Pass 36 — screenshot index

Captured with headless Playwright signed in as arda (org admin) unless the name says
`rbac-<role>`; `-light`/`-dark` name the theme (`viberr_theme` cookie → `html[data-theme]`),
`-mobile` is a 390 px viewport, `-tall` a full-page capture. Order follows NOTES.md.

| file | surface | moment |
|---|---|---|
| 00-home-light, 00-home-dark, 00-home-mobile-dark | Home, empty instance | before the goal, 14:16Z |
| 01-controller-page-live-dark | /controller with the Live run panel (turn 1 working, TOKENS ~183k, opus[1m]) | 14:22Z |
| 02-board-light, 02-board-dark, 02-board-mobile-dark | Board: HLC-1 Building "agent working", HLC-2/3/4 Intake blocked | 14:29Z |
| 03-dock-reply-1-dark | Dock on Home with the controller's turn-1 report | 14:32Z |
| 04-agents-light, 04-agents-dark | Agents page: operator + 3 profiles, eligible stages, capability policy | 14:32Z |
| 05-policy-light | Policy page: boundaries incl. approval + locked human | 14:32Z |
| 06-project-controller-goals-dark, -mobile-dark | Project controller page with the Goals panel (5 chains, waits) | 14:32Z |
| 07-github-light | Project GitHub view after bootstrap | 14:32Z |
| 08-org-resources-light | Org settings → Agent resources (2 KBs, context7, 2 new skills) | 14:33Z |
| 09-board-8-tasks-dark | Board with 8 tasks, four developers working | 14:37Z |
| 10-task-hlc1-building-dark | HLC-1 task page during the scaffold build (tall) | 14:37Z |
| 11-hlc9-held-dark | HLC-9 after `hold_runtime_debug`: blocked, waiting on a human, no packet | 14:40Z |
| 12-hlc6-review-light | HLC-6 at Agent Review with PR #1 (tall) | 14:41Z |
| 13-review-queue-light | Review queue: "2 in review", HLC-6 and HLC-8 awaiting verdict | 14:41Z |
| 14-hlc6-after-restart-dark | HLC-6 after the container recreate: rework directive, run 2 of 3 resumed (tall) | 14:47Z |
| 15-insights-light | Insights after the restart: 48 runs, "4 stopped (4 by a restart)" | 14:47Z |
| 16-notifications-light | Notifications: quality "Changes requested" rows, the HLC-9 failed-run alert, the controller mention | 14:47Z |
| 17-hlc9-live-operator-dark | HLC-9 after the hand-off and Run operator: Live run panel, Codex luna | 14:49Z |
| 18-hlc6-mobile-dark | HLC-6 on a 390 px viewport: title and status first, "validation failing" pill (tall) | 14:49Z |
| 19-activity-dark | Activity page with audit column ("via the controller") | 14:49Z |
| 20-hlc8-rec-while-failing-light | HLC-8: Viberr next-step recommendation while validation failing | 14:50Z |
| 21-hlc9-input-packet-dark | HLC-9 input packet (edit_goal options, misplaced closed-PR note) | 14:51Z |
| 22-hlc9-blocked-archive-packet-light | HLC-9 blocked packet: archive (rec) / edit_goal / retry_other_backend | 14:58Z |
| 23-hlc6-approval-rec-light | HLC-6 with the approval-boundary recommendation | 15:00Z |
| 24-review-queue-approval-dark | Review queue with HLC-6/HLC-8 approved, HLC-1 failing | 15:00Z |
| 25-hlc6-shipped-dark | HLC-6 shipped after the merge | 15:02Z |
| 26-board-cycle1-light, -mobile-light | Board after cycle 1 | 15:02Z |
| 27-hlc8-rejected-packet-light | HLC-8 after PR #2 closed: divergence note + recovery packet (tall) | 15:04Z |
| 28-hlc9-archived-light | HLC-9 archived | 15:05Z |
| 29-hlc7-drift-task-page-light | HLC-7 with authored drift recorded but invisible on the page (tall) | 15:08Z |
| 30-hlc7-accept-dialog-drift-dark | HLC-7 accept dialog with the Merge head warn row | 15:10Z |
| 31-github-view-rejections-light | GitHub view: #1 merged, #2/#3 closed, #4 in review (tall) | 15:12Z |
| 32-board-cycle2-dark | Board after cycle 2 | 15:15Z |
| 33-insights-2-merges-dark | Insights: 103 runs, $8.35, 95% completion | 15:15Z |
| 34-policy-4-members-light, -dark | Policy page: 4 members, RBAC table, guardrails, workflow rules | 15:17Z |
| 35-notifications-kinds-dark | Notifications with policy / approval / ownership / quality / mention kinds (tall) | 15:18Z |
| 36-board-cycle3-light | Board after cycle 3 (HLC-1 shipped, HLC-10 building) | 15:20Z |
| 37-goals-panel-after-link1-dark | Project controller page, Goals panel with goal-1 link 1 done | 15:20Z |
| 38-hlc10-collision-light | HLC-10 with the branch-collision panel row and note (tall) | 15:21Z |
| 39-hlc9-schedule-fired-dark | HLC-9 Execution profile after the human schedule fired | 15:22Z |
| 40-hlc9-force-accepted-live-run-dark | HLC-9 force-accepted (Shipped) with a developer run still live | 15:24Z |
| 41-home-3-shipped-light, -dark, -mobile-dark | Home after three merges | 15:26Z |

| 42 | 42-hlc9-shipped-with-packet-light | HLC-9 Shipped + accepted with an OPEN "Decision required" packet from the operator (F36-5) |
| 43 | 43-hlc10-collision-packet-{light,dark,mobile} | HLC-10 Blocked decision "Resolve remote branch collision before delivery"; GitHub card "Collision PR #7 holds this branch name but is not this task's review PR" |
| 44 | 44-hlc10-collision-confirm-clicked | Confirm decision → dialog "Clear the branch collision?" (dark; DECISION/DELETES/KEEPS rows) |
| 45 | 45-hlc10-collision-dialog-light | same dialog, light |
| 46 | 46-hlc10-after-collision-clear-light | after "Clear collision & redeliver": Agent Review, operator live run panel (RUNTIME gpt-5.6-luna) |
| 47 | 47-review-queue-hlc10-pending-light | Review queue: HLC-10 "Review in progress at Agent Review · PR #8 · awaiting verdict" |
| 48 | 48-hlc9-packet-archive-dialog-light | packet archive_task dialog: WITHDRAWN row "Restoring the task reopens the question" (U36-1) |
| 49 | 49-hlc9-after-packet-archive-light | HLC-9 archived from the packet: "Restore from archive", execution profile "task closed" |
| 50 | 50-hlc3-blocked-by-hlc10-light(-form) | HLC-3 "Edit what it waits on" inline form; blocked by HLC-10 |
| 51 | 51-hlc10-rework-after-request-changes-light | HLC-10 back at Building after request-changes, validation failing, rework developer live |
| 52 | 52-hlc2-run-reviewer-ineligible(-before), 52b-* | Run-an-agent with a stage-ineligible reviewer: enabled button, posture "Runs as the delivering agent", 400 toast after click |
| 53 | 53-hlc2-mention-ineligible-reviewer | "Mention not started" policy note after @Code Reviewer on an Intake task |
| 54 | 54-hlc10-changed-revision-rereview-dark | HLC-10 at Agent Review on the reworked revision 75aac0e, validation changed, reviewer re-running |
| 55 | 55-board-mid-run-{light,mobile-dark} | Board with 8 tasks (HLC-9 archived), HLC-10 in Agent Review |
| 56 | 56-activity-collision-rows-light, 56-github-page-light | Activity feed with the collision rows; GitHub page (4 PRs linked, closed ones absent) |
| 57 | 57-hlc10-approved-rec-move-to-merge-approval-light | HLC-10 approved at Agent Review, "Move the task to Merge Approval" recommendation with Apply/Dismiss |
| 58 | 58-hlc10-apply-move-to-merge-approval-after | Merge Approval + accept recommendation; Archive dialog opened by mistake shows WITHDRAWN "1 pending operator recommendation. Restoring the task reopens the question." (U36-1) |
| 59 | 59-hlc10-accept-dialog, -after | Accept completion dialog (MERGES/BRANCH/REVISION/VERDICT rows) and the shipped page |
| 60 | 60-hlc11-created-light | HLC-11 created by the goal chain (link 3) |
| 61 | 61-hlc11-secondary-frontend-run(-before), 61-hlc11-two-live-runs-light | Run-an-agent with Frontend Developer as a supporting agent; two live runs on one task |
| 63 | 63-hlc4-archive-goal-link-dialog, -after | Archive dialog on a goal-link task (WITHDRAWN: nothing to withdraw); archived |
| 64 | 64-goals-panel-goal4-attention-light | Project controller page, Goals panel with goal-4 in attention after link 1 failed |
| 65 | 65-hlc11-apply-move-to-merge-approval-after | HLC-11 at Merge Approval after applying the transition card |
| 66 | 66-hlc11-accept-dialog, -after | HLC-11 accept dialog and shipped page (PR #9 merged) |
| 67 | 67-insights-5-merged-{light,dark} | Insights at 144 runs / $21.57 reported (Codex runs report no cost) |
| 68 | 68-board-5-merged-light, -archived-filter-light | Board after five merges; archived filter (HLC-4, HLC-8, HLC-9) |
| 69 | 69-hlc13-mention-frontend | HLC-13: human @mention of the ELIGIBLE Frontend Developer at Building → run started (16:57Z) |
| 70 | 70-hlc13-apply-after, 70-hlc13-accept-dialog, 70-hlc13-accept-after | HLC-13 transition card applied; accept dialog (PR #10, revision, verdict rows); shipped (17:07Z, releases HLC-3 + HLC-12) |
| 71 | 71-board-three-in-flight-light, -mobile-light, 71-hlc14-frontend-task-light | Board with HLC-3, HLC-12, HLC-14 in flight; HLC-14 (web app shell) task page with the Frontend Developer delivering |
| 72 | 72-hlc12-apply-after, 72-hlc12-accept-dialog, 72-hlc12-accept-after | HLC-12 (YAML route) applied → accept dialog (PR #11) → shipped |
| 73 | 73-hlc3-conflict-packet-light | HLC-3 `blocked` packet: PR #12 has merge conflicts with main; options redirect / archive / custom |
| 74 | 74-hlc3-conflict-redirect-before, -after | The conflict packet resolved with "Redirect the deliverer" → developer re-run with the conflict brief |
| 75 | 75-hlc14-attachments-browser-evidence-light, 75-clone-pods-page-by-frontend-developer | HLC-14 attachments card with the browser-capability screenshot; the clone's pods page as the Frontend Developer captured it against `start:fake` |
| 76 | 76-hlc14-conflict-redirect-before, -after | HLC-14's own conflict packet (PR #13) resolved the same way |
| 77 | 77-hlc3-next-step-card-while-review-pending-light | F36-6: the Viberr-authored "Move the task to Merge Approval" card standing while HLC-3's re-review is pending (17:34Z) |
| 78 | 78-hlc15-apply-after, 78-hlc15-accept-dialog, 78-hlc15-accept-after | HLC-15 (search API) applied → accept dialog (PR #14) → shipped |
| 79 | 79-hlc14-failing-verdict-with-move-card-light | F36-6 again: HLC-14 `validation: failing` (request-changes) with the move card still offered (17:36Z) |
| 80 | 80-github-update-status-after-gh-merge | U36-12: GitHub page after the out-of-band `gh pr merge 13` + "Update status" — divergence note, `pr.state: merged`, stage unchanged (18:13Z) |
| 82 | 82-hlc14-stage-menu-move-menu, -after | The stage menu crossing the approval boundary by hand (the only door left after the reconciler withdrew the card) |
| 83 | 83-hlc14-accept-already-merged-dialog, -after | Accepting HLC-14 on the already-merged path: dialog says the PR is merged, no merge performed; shipped |
| 84 | 84-hlc3-apply-after | HLC-3 at Merge Approval after the fourth-round approval was applied |
| 85 | 85-hlc3-conflict-at-merge-approval-before, -after | HLC-3's second conflict packet at Merge Approval (main moved under PR #12) and its redirect |
| 86 | 86-hlc3-apply-after, 86-hlc3-accept-dialog, 86-hlc3-accept-after | HLC-3 (logs API) applied again → accept dialog (PR #12, revision 607665b) → shipped (18:44Z, the tenth merge) |
