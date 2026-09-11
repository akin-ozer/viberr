# Pass 36 — surface coverage checklist (final form 17:50Z; the last two cycles still landing)

Status: `done (evidence)` · `partial (what is missing)` · `not exercised (why)`. Evidence =
task key, run id, audit action, screenshot index (SCREENSHOTS.md) or NOTES timestamp.

| Item | Status | Evidence |
|---|---|---|
| Controller dock: instance, board and task scopes; thread list; viberr_ops | done | instance scope on Home (goal-1/2/3/5/6 sent 14:17Z…16:34Z), board scope (goal-4 turn 15:25Z, thread cnv_rIINtSmyVmOr), task scope (HLC-1 dock panel, shot 168-line note); controller read `instance_health`/`whoami`/`read_store_doc` through viberr_ops (14:18Z) |
| Controller sets up project: custom stages + boundaries | done | 14:20:39Z `create_project`: 6 stages, approval boundary agent-review→merge-approval, human-locked merge-approval→shipped; project.md verified |
| Controller creates KBs, skills, agent profiles, grants | done (skills garbled: F36-2; KB id gap: U36-4) | 2 KBs (3 docs), 2 skills, 3 templates, 4 deployments with grants; audit 14:22-14:25Z |
| Controller creates MCP servers | done | context7 saved + tested healthy 14:24Z; `context7.query-docs` calls in developer logs (e.g. run_ZxH743JPSsxh, run_UHsNuh7WiqN4) |
| Controller attaches repo; empty repo bootstrap | done | `create_project` attached akin-ozer/headlamp-clone; `github.repo.bootstrapped` ad3180d 14:28:33Z |
| Controller creates schedules (ruling 153) | done | sch_oAcOhgCmHRy8 fired 15:30:14Z `skipped-done`; sch_q4u8bMUpDtay fired 17:00:14Z `skipped-done` on shipped HLC-1 (copy says "Done": U36-9) |
| Controller creates chained goals; advance / pause / resume / edit / add / skip / retry | done | goal-1..5 (32 links); advance on ship ×5 (HLC-10, 11, 13, 14, 15 created by the chain); pause/resume by hand on goal-5 (15:25Z); `edit_link` + `add_link` (turn 4); `retry_link` after archiving HLC-4 → HLC-12 (16:33Z); `skip_link` goal-1 link 8 (16:34Z); failed-link notification to the owner (16:30Z) |
| Models: controller opus high; everything else Codex gpt-5.6-luna max | done; reviewer moved to Claude at 14:57Z (owner Q36-3, forced by F36-1/F36-3) | controller.md, project.md, run rows `gpt-5.6-luna`; every surface accepted `max` (tool text says xhigh: U36-5) |
| Operator triage + agent selection | done | Codex operator plans on every task; `task.operator.agent_selected`; Frontend Developer picked for HLC-14, Server Developer elsewhere |
| Engagements (delivering + supporting) + human secondary assignment | done | operator-made engagements on every task; human Run-an-agent engaged Frontend Developer as supporting beside the live deliverer (HLC-11 16:27Z, run_Rmq0Vo5ELab-, own workspace `support/frontend-developer`); audit action misnamed (U36-11) |
| Required reviewer + revision-bound verdicts | done | every verdict carries Reviewed-Revision; HLC-10 3 rounds, HLC-13 2, HLC-3/HLC-14 rework rounds; `validation` follows the verdict on the CURRENT revision; required-ness is emergent (G36-3, owner Q36-5 → ruling 178) |
| Work-revision drift: natural + post-approval fixture | done | natural: reworks void the prior verdict (`validation: changed`) every time; fixture: hlc-7 64daccb at Merge Approval → `pr.revisionDrift {authored: 1}` silent, no re-review path (F36-7, ruling 179) |
| Delivery: push, PR open, PR head move, base refresh, conflict | done | PRs #1..#14 opened by Viberr; head moves on rework (PR #8 ×2, #10, #12, #13); `update_branch_from_base` before delivery; real conflicts on HLC-3/HLC-14 → `blocked` conflict packet → `redirect` to the deliverer → resolved and re-delivered (17:25-17:36Z) |
| Approval boundary (human), ruling 151 | done | every cycle: operator recommends "Move to Merge Approval", a human applies (`boundary: approval`); the operator never crossed it |
| Accept completion + real merge from Viberr | done ×8 | PRs #1, #6, #4, #8, #9, #10, #11, #14 merged from the accept dialog (MERGES/BRANCH/REVISION/VERDICT rows); branch deleted; task shipped; completion event copy says "Done" (U36-9) |
| Merge out of band with gh → reconciler | planned for PR #12 (HLC-3) when approved | — |
| Reject a PR on GitHub → recovery packet (ruling 160) | done ×2 | PR #2 (HLC-8) → archive + delete branch; PR #3 (HLC-7) → packet naming the drift → adoption of hand PR #6 |
| PR adoption | done | HLC-7 15:13:32Z `github.pr.adopted {source: reconciler}` |
| Branch collision | done | ruling-122 suffix `hlc-10-0c88` (silent: U36-6); stray PR #7 → collision note (no inbox: U36-7) → operator `blocked` packet → "Clear the branch collision?" dialog → PR #7 closed, PR #8 opened, block lifted (15:41Z) |
| Scope violation (PAT scope / 403) | not exercised (owner Q36-4) | pass-35 code map + unit tests only |
| Reconciler: poll, Update status, freshness chip | done | 5-min poller rows, "Update status" button 15:03:32Z, GitHub page freshness; keeps polling shipped/archived tasks (F36-5 sub-item) |
| Decision packets: kinds provoked | done: `blocked` (failed run, sandbox, conflict, collision), `input` (edit_goal, scope), `hold_runtime_debug`, `retry_other_backend`, `archive_task` (+deleteBranch), `resolve_remote_collision`, `redirect`, `custom` offered, `block_on_policy` offered; not provoked: `request_edit`, `move_stage`/`force_accept` as packet options (force-accept exercised from the card) | audit `task.packet.opened/resolved`; shots 21, 22, 43, 48, 73 |
| Recommendations | done | transition + accept_completion (ruling 152 fold) on every cycle; Viberr-authored next-step card while failing/pending (F36-6 ×3: HLC-8, HLC-3, HLC-14) |
| Schedules: human-created + controller-created | done | human 15:22:13Z `claimed`; controller's two `skipped-done` |
| Mentions + notifications | done | `mention` (controller @Arda; agents "@Arda … @operator" after every supporting run), `quality`, `approval`, `ownership`, `dependency` (17:07Z release ×2 to owner + maintainer), `controller` (goal progress, failed link), failed-run alert; human @mention of an INELIGIBLE agent → "Mention not started" note (15:52Z); of an ELIGIBLE agent → run started (16:57Z); @operator on an ARCHIVED task → run started (F36-4) |
| Browser capability | done | HLC-14 Frontend Developer: `viberr_browser.browser_resize/navigate/snapshot/take_screenshot/console_messages` against its own `start:fake` server; screenshot attached to the task (17:24Z, shot 75) |
| Attachments (agent-posted, viewer, download) | done | evidence files on HLC-1/10/11/13/14; viewer + download (shots 39-41); no human upload door by design |
| RBAC: viewer / contributor / maintainer / admin + non-member | done | rbac.mjs 14 GET + 13 POST doors per role; non-member 404 everywhere (RBAC-PROBE.md) |
| Archive + restore | done | archive via button (HLC-4), via packet (HLC-9 ×2, HLC-8 with deleteBranch); restore HLC-9 (packet NOT reopened: U36-1) |
| Audit page, via-controller disclosure; Activity page | done | shots 19, 56; every controller write labelled "· via controller" |
| Insights | done | shots 15, 33, 67; honest counts (restart-interrupted, no-cost Codex rows) |
| Guardrails | done | Policy page 15:17Z; project.md guardrails[] + audit |
| Force-accept | done | HLC-9 15:23Z: Skips/Bypassing rows, `task.acceptance.forced`; live run continued and re-invoked the operator on the shipped task (F36-5) |
| Dependencies: set by hand, release on ship, goal-link waits | done | HLC-3 "Edit what it waits on" (15:46Z); release of HLC-3 + HLC-12 when HLC-13 shipped (17:07Z): notes, notifications, operator wake within 3s |
| Light/dark/desktop/mobile screenshots of changed surfaces | done (120 shots, 79 indexed entries) | SCREENSHOTS.md; dark/mobile variants on board, task, packets, insights, controller |
| Files-are-truth sweeps | done | 9/9, 10/10, 13/13 on every sweep; one transient mismatch during a write cleared on the next sweep |
| 25+ tasks, 8+ cycles ending in a merged PR | 16 tasks, 8 merged cycles (+2 in flight) | the brief's "expect 25+" is the controller's plan size (32 links); the cycle floor is met |
| Restart recovery / credential loss | done | 14:46Z recreate: 4 runs `interrupted/restart`, operators re-fired, no timeline note (U36-8); HLC-9 owner without Codex → failed-run packet (14:37Z) |
| The clone runs: cluster connection, lists, detail + logs + events, namespace switch, YAML, search | partial | server half merged (kubeconfig/cluster endpoints, generic resource API with Secret masking, YAML route, search API, fake-kube `start:fake`); logs API and the app shell in review; resource tables/detail views/UI namespace switch are later goal links, not reached |
