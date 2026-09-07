# Pass 35 — screenshot index

All captured with a headless Playwright profile signed in as arda (admin) unless the name says
`rbac-<role>`; `-light`/`-dark` name the theme (`html[data-theme]`), `-mobile` is a 390 px
viewport. Times in the file names' order follow NOTES.md.

| file | surface | moment |
|---|---|---|
| home-light-desktop, home-dark-desktop, home-dark-mobile | Home, empty instance | before the goal |
| 01-controller-tab-after-save | Org settings → Controller | model switched to Opus (1M) high |
| 02-dock-goal-sent | Dock on Home, goal-1 sent | 13:08Z |
| 03-board-light/dark | Board with 4 tasks | 13:19Z |
| 04-task-knc1-dark, 06-task-knc1-tall-light | KNC-1 task page during the first Codex run / reviewer run | 13:20Z, 13:23Z |
| 05-agents-light | Agents page, 9 profiles ("Test &amp; CI Engineer" literal) | 13:19Z |
| 07-github-light | Project GitHub view, PR #1 in review, PAT scopes | 13:27Z |
| 08-activity-dark | Activity stream + audit column ("via the controller") | 13:27Z |
| 09-insights-light, 44-insights-2h-dark | Insights at 10 runs and at 117 runs | 13:28Z, 14:35Z |
| 10-notifications-dark, 26-notifications-packets-light | Notifications page | 13:28Z, 14:06Z |
| 11-review-queue-light, 45-review-queue-dark | Review queue | 13:28Z, 14:37Z |
| 12-controller-page-dark, 32-controller-mobile-light | Project controller page + Goals panel | 13:28Z, 14:21Z |
| 13-task-knc1-merge-rec-light | KNC-1 at Merge with the accept_completion recommendation | 13:41Z |
| 14-policy-dark | Policy page (RBAC matrix + agent capability) | 13:41Z |
| 15-accept-dialog-KNC-1, 16-after-accept-KNC-1 | "Apply this recommendation?" dialog, then Done | 13:43Z |
| 17-board-after-cycle1-light, 18-task-knc1-done-dark | Board and KNC-1 after cycle 1 | 13:43Z |
| 19-knc2-schedule | KNC-2 with the human-created schedule | 13:53Z |
| 20-dock-goal-2-sent, 34-dock-goal-3-sent | Dock on the board, turns 2 and 3 | 13:56Z, 14:22Z |
| 21-concurrency-cap | Agent resources: cap set to 4 | 14:02Z |
| 22-github-after-oob-merge | GitHub view after the out-of-band merge of PR #2 | 14:03Z |
| 23-board-27-light/dark/mobile-dark | Board with 27 tasks, 21 waiting on a human | 14:04Z |
| 24-knc6-stalled-packet-light, 31-knc6-packet-mobile-dark, 35-KNC-6-mobile-full | "Work stalled" packet (Codex quota); mobile reading order (U35-2) | 14:06Z, 14:21Z |
| 25-knc11-scope-packet-dark | Triage-scope "Decision required" packet | 14:06Z |
| 27-archive-dialog-KNC-24, 28-archived-KNC-24 | Archive dialog with packet withdrawal disclosure; archived page | 14:20Z |
| 29-goal-paused | Goals panel after Pause | 14:21Z |
| 30-knc25-held | KNC-25 after hold_runtime_debug | 14:21Z |
| 33-agents-mobile-dark | Agents page, mobile | 14:21Z |
| 36-knc14-archive-delete | KNC-14 after archive + delete branch | 14:25Z |
| 37-run-agent-KNC-24, 49-run-agent-refusal-KNC-24 | Human Run-an-agent of an ineligible agent; the refusal toast | 14:35Z, 14:41Z |
| 38-KNC-4-edit-goal-open, 39-KNC-4-after-reload | edit_goal resolution: prefilled editor; "Decision made" after reload | 14:28Z |
| 40-force-accept-dialog-KNC-10, 41-force-accepted-KNC-10 | Force-accept ceremony and result | 14:28Z |
| 42-knc27-custom | KNC-27 after the custom directive | 14:28Z |
| 43-new-task | Board after creating KNC-30 by hand | 14:37Z |
| 46-github-view-light | GitHub view with PRs #6 adopted, #7 unowned | 14:37Z |
| 47-dock-task-scope | Dock bound to KNC-6 (task scope) with the reply | 14:36Z |
| 48-knc8-adopted-light | KNC-8 with adopted PR #6 | 14:38Z |
| 50-mention-KNC-24 | Human @mention comment recorded with no run (F35-5) | 14:41Z |
| 51/52-guardrails | Policy → Guardrails after the edits | 14:42Z |
| rbac-viewer/contributor/maintainer/admin-knc9, rbac-noah-404, rbac-noah-dock | RBAC probe per role; non-member 404 | 14:26-14:40Z |
| 53-dock-goal-4-sent | Dock, turn 4 (delivery to Claude) | 14:47Z |
| 55-agents-live-light | Agents → Live tab during the Claude delivery phase | 14:59Z |
| 56-board-claude-phase-light | Board, 29 tasks, deliveries in flight | 14:59Z |
| 57-knc30-collision, 58-collision-dialog-KNC-30, 59-knc30-after-collision-light | Branch-collision packet, the "Clear the branch collision?" dialog, KNC-30 with PR #11 | 15:13-15:20Z |
| 60-knc25-blocked-and-working | Board card reading "blocked" and "agent working" at once (F35-8) | 15:23Z |
| 61-agent-detail-k8s-engineer | Agents page detail: "MCP servers None", no divergence marker (F35-7) | 15:27Z |
| 62-review-queue-after-outage-light | Review queue empty while 8 PRs are under review (U35-5) | 18:37Z |
| 63-insights-after-outage-dark | Insights after the Claude outage: 245 runs, $125.53, 35 errors | 18:38Z |
| 64-knc-13-after-restart | KNC-13 after the 18:40Z restart: queued primary shows "agent working", operator log explains the recovery, no interruption event on the timeline | 18:48Z |
| 65-knc-13-interrupted-run-pill | KNC-13 Agent logs: the thread pill says "queued" over the interrupted run's output, session none; the Engaged agents card says "running…" | 18:55Z |
| 66-insights-after-restart-dark | Insights 18:56Z: 307 runs, 58 error, 0 stopped (the 23 restart-finalized runs count as errors), $149.59, coordination 55%; Codex quota row still "usage limit reached" 38 min after the window it names passed | 18:56Z |
| 67-knc-28-after-drift | GitHub page after Update status with the drift fixture on knc-28 (row "5 commits #13 synced") | 19:03Z |
| 68-knc-28-drift-task-light | KNC-28 task page after the drift: Validation, "validation healthy", PR #13 in review, commits card lists the 5 task-key commits and not the foreign head; no drift note anywhere on the page | 19:04Z |
| 69-review-queue-drift-light | Review queue still empty (U35-5): the drifted, approved task sits at Validation, which the queue does not see | 19:04Z |
| 70-knc-28-drift-packet-light | KNC-28 blocked packet "PR #13 head diverged from the reviewed revision — 1 unreviewed commit would merge" with its observations and three costed options (R17-1) | 19:14Z |
| 71-knc-28-drift-resolved | After choosing "Restore PR #13's head to the reviewed revision" | 19:14Z |
| 72-knc-28-after-restore | GitHub page after the head was restored to e2ed104 and Update status pressed | 19:15Z |
| 74-review-queue-knc-30-light | Review queue with KNC-30 at Merge in "Waiting on your acceptance" (the queue only ever sees Merge on this board) | 19:32Z |
| 77-review-queue-two-rows-dark | Review queue (dark) with KNC-18 and KNC-19 waiting on acceptance | 19:38Z |
| 78-knc-18-after-gh-merge | GitHub page after PR #9 was merged out of band | 19:38Z |
| 79-knc-21-archived | KNC-21 archived with branch deletion from the discard-refusal packet | 19:40Z |
| 81-knc-8-accept-409 | KNC-8 after the first accept answered 409: GitHub card "merged", recommendation still pending, sidebar "Accept completion → Done", and a "Deliver branch & open PR" button on a merged branch | 19:42Z |
| 83-knc-6-accept-dialog-drift | KNC-6 accept dialog: "MERGE HEAD 7efa168 · base refreshed · 1 merge commit · 2 base commits · 0 authored commits since review"; no conflict mentioned | 19:50Z |
| 84-knc-6-accept-409 | After the click: toast "review PR #16 conflicts with the base branch… Rebase the branch and re-review, or archive"; the recommendation card still offers Apply, the GitHub card still says "in review" | 19:51Z |
| 108-knc-27-browser-capture-github-404 | KNC-27: the Docs & Release Engineer's own headless-Chromium capture (browser capability) of GitHub's 404 for the private repo, posted as a task attachment | 21:12Z |
| 96-agent-accounts-after-auth-loss | Profile → Agent accounts right after the API key swap | 20:40Z |
| 111-insights-final-light | Insights at the close of observation (light) | 22:01Z |
| 112-insights-final-dark | Insights at the close (dark) | 22:01Z |
| 113-board-final-light | Board at the close, desktop light | 22:01Z |
| 114-board-final-dark | Board at the close, desktop dark | 22:01Z |
| 115-board-final-mobile-light | Board at the close, 390px mobile | 22:01Z |
| 116-review-queue-final-light | Review queue at the close (Merge-stage rows only, U35-5) | 22:01Z |
| 117-github-page-final-dark | GitHub page at the close: per-branch sync rows, PR states | 22:01Z |
| 118-activity-final-light | Activity feed at the close | 22:01Z |

## Fix validation (2026-09-07, `screenshots/fixes/`)

Captured after the fixes landed, on a scratch data root seeded with `npm run seed:demo` and a dev
server on port 5175 (never the live instance). Headless Playwright signed in as arda (org admin),
except the profile shots, which are Elif's own page. `-desktop` is 1440x1100, `-mobile` is
390x844, `-light`/`-dark` name the theme. The evidence each one belongs to is in VALIDATION.md.

| file | surface | what it shows |
|---|---|---|
| task-page-desktop-light, task-page-desktop-dark | VIB-142 task page | U35-2: title and the open packet span both columns on row 1, the two panel columns follow |
| task-page-mobile-light, task-page-mobile-dark | VIB-142 task page, 390px | U35-2: key, title, pills, goal, then the packet, before any metadata panel |
| accept-dialog-desktop-light, accept-dialog-desktop-dark | Accept button ceremony | ruling 162: the branch is brought up to date with the base first, disclosed before the click |
| packet-accept-ceremony-desktop-light, packet-accept-ceremony-desktop-dark | accept_completion packet option | the same ceremony reached through the packet, with no withdrawal claimed (D35-V1) |
| acceptance-refusal-conflict-desktop-light, acceptance-refusal-conflict-desktop-dark | VIB-142 with a conflicting PR | F35-12: the acceptance is refused, not offered, in the gate's own sentence |
| review-queue-desktop-light, review-queue-desktop-dark | Review queue | U35-5: "3 in review · 1 waiting on your acceptance", an off-boundary row naming its stage |
| review-queue-mobile-light, review-queue-mobile-dark | Review queue, 390px | the same two halves stacked |
| packet-new-option-kinds-desktop-light, packet-new-option-kinds-desktop-dark, packet-new-option-kinds-mobile-light | VIB-145 packet | ruling 164: force_accept and move_stage offered as ordinary options |
| packet-force-accept-ceremony-desktop-light, packet-force-accept-ceremony-desktop-dark, packet-force-accept-ceremony-mobile-light | force_accept resolution | ruling 164 + U35-3: the force form names the skipped stages and the bypassed gate |
| insights-desktop-light, insights-desktop-dark, insights-mobile-light, insights-mobile-dark | Insights | U35-7 "4 stopped (3 by a restart, 1 never started)"; F35-1 "2 of 8 runs report no provider token total" |
| org-settings-concurrency-desktop-light, org-settings-concurrency-desktop-dark, org-settings-concurrency-mobile-light | Instance settings | ruling 152(b): cap 5 plus 2 coordination slots, in the sentence under the field |
| org-users-github-handle-desktop-light, org-users-github-handle-desktop-dark | Users & access, Edit user | ruling 154: an org admin links a GitHub handle to a local account |
| org-users-github-handle-duplicate-refusal-desktop-light | the same modal, second account | ruling 154: "@elif-demir is already linked to Elif Demir." |
| profile-github-handle-desktop-light, profile-github-handle-desktop-dark, profile-github-handle-mobile-light | Elif's Profile, GitHub identity | ruling 154: "@elif-demir · linked by an org admin", and what the link does |
| agents-template-divergence-desktop-light, agents-template-divergence-desktop-dark, agents-template-divergence-mobile-light | Project Agents, Developer | ruling 156: "grants differ from the template", the per-list difference, and the org-admin button |
| closed-pr-block-desktop-light, closed-pr-block-desktop-dark | VIB-145 GitHub card | ruling 160: the closure names its closer and the Deliver control is refused while it stands |
