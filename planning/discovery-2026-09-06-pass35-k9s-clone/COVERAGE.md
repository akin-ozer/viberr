# Pass 35 — surface coverage checklist

Status: `todo` · `in progress` · `done (evidence)` · `blocked (why)`. Evidence = task key,
run id, audit action, screenshot name or NOTES timestamp.

| Item | Status | Evidence |
|---|---|---|
| Controller dock: open, send goal, thread list, full page; instance + board scopes; viberr_ops diagnostics | done | 02-dock-goal-sent, controller-reply-1..3.md, 12-controller-page-dark |
| Controller sets up project: custom stages + boundaries | done | project.md stages triage…done; approval boundary review→merge; locked merge→done |
| Controller creates KBs, skills, agent profiles, grants | done | 3 KBs, 3 skills, 8 templates, 9 deployments; audit 13:11-13:16Z |
| Controller creates MCP servers | done (context7 HTTP registered + tested) but the grant landed on the template only and no run mounted it → F35-7 | run_inputs of run_NwHKLc8Olcsf |
| Controller attaches repo | done | create_project attached akin-ozer/k9s-clone, connected |
| Controller creates schedules | blocked → G35-1 (no tool) | controller-reply-1.md |
| Controller creates chained goals | done | goal-1..4 (29 links) |
| Models: delivery astra medium, reviewers/operator/controller opus high | done until 14:03Z (Codex quota); delivery switched to claude/opus/high at 14:48Z by owner decision (Q35-6); backend-switch tool path exercised | project.md deployments; run rows model column |
| Empty repo bootstrap | done | audit github.repo.bootstrapped 77eecbb; GitHub main verified |
| Operator triage + agent selection | done | audit task.operator.agent_selected KNC-1 (developer, architecture-reviewer) |
| Engagements (delivering + supporting) | done | KNC-1 engagements developer delivers, architecture-reviewer verdictCapable |
| Secondary assignment by a human (assign a second agent from the task page) | done | KNC-8 15:06:42Z: Security & Dependency Auditor engaged as reviewer (verdictCapable), audit task.reviewer.assigned + task.agent.run_started |
| Required reviewers + verdicts bound to revisions | done | verdicts[0] rev_Mpl7 request_changes; second verdict on rev_glHT |
| Work-revision drift (commits after review) | natural drift done (KNC-1 rework after request_changes staled the verdict, validation `changed`); base refresh done (KNC-2 `baseRefreshes`, 6 commits merged in); post-approval push fixture pending an approve on an open PR | NOTES 13:28Z, 15:08Z |
| Delivery: push, PR open, PR head move | done | PR #1, "Pushed 5651122 to PR #1 (was f95e67e)" |
| Review→Merge approval boundary (human approval) | done → F35-2 (operator crossed it alone) | audit 13:38:54Z |
| Accept completion + real merge from viberr | done | KNC-1 PR #1 merged a4d3050, 13:43:05Z |
| Merge out of band with gh → reconciler divergence note | done | KNC-5: gh merge 489e078 → Divergence note 14:03:14Z → operator recommendation → accepted 14:16:33Z "already been merged (out of band)" |
| Reject a PR (close on GitHub) → rework/archive path | done twice | KNC-14: gh pr close 5 → policy notif + `input` packet (rework / archive / archive+deleteBranch) → resolved archive+delete 14:26Z | KNC-23: PR #10 closed under a running delivery → replaced silently by PR #26 (F35-11); PR #26 closed with no delivery in flight → R8-6 divergence note + notifications 19:35:26Z; recovery packet pending |
| Let a PR diverge after review (push commits after approve) → drift disclosure | fixture done 19:03:32Z on knc-28 (PR #13, approved rev e2ed104 → head 242f120); `pr.revisionDrift {authored: 1}` in task.md; task page silent (screenshot 68); operator opened the R17-1 packet at 19:13:27Z naming the unreviewed commit and three costed paths (screenshot 70); head restored, drift cleared 19:15Z | NOTES 19:03Z, 19:13Z |
| PR adoption (open a PR by hand on the task branch with same head) | done | KNC-8: #3 closed, #6 adopted by the reconciler 14:35:51Z |
| Branch collision (unowned PR / foreign branch on the task's name) | done end to end (fixture → unownedPr → delivery packet → dialog → cleared_and_delivered → PR #11) | KNC-30 15:11-15:14Z |
| Scope violation (PAT without a scope, or 403) | todo (needs a PAT change: owner) | |
| Reconciler: poll, Update status button, freshness chip | in progress | audit github.reconcile.task 13:21:40 |
| Decision packets: accept_completion | todo | |
| Decision packets: request_edit / redirect / custom | custom ×8, redirect ×4, retry_other_backend ×11, request_edit ×15 (Claude send-backs 18:33Z + the auditor's fix-both), edit_goal ×7, hold ×1, archive ×1, collision ×1, agent question ×1 | audit task.packet.resolved |
| Decision packets: block_on_policy | done (7 "Operator run failed" packets after the Claude window ran out, resolved 18:33Z) | KNC-2/7/9/12/15/17/28 |
| Decision packets: hold_runtime_debug / retry_other_backend | hold done (KNC-25 14:21:02Z); retry_other_backend deliberately NOT used (owner: wait) | KNC-25 |
| Decision packets: edit_goal | done end to end on KNC-4/7/17 (F35-6: draft lost on reload, no-op save reports 'Goal updated') | 14:28Z-14:58Z |
| Decision packets: archive_task / discard_branch / resolve_remote_collision | archive_task done (KNC-14); resolve_remote_collision done (KNC-30); discard_branch: fixture on knc-21 produced a collision packet WITHOUT the discard kind; a direct request for it was refused by F31-6 because the agent's report had registered a revision (G35-6); archive+deleteBranch used instead (U35-8) | |
| Recommendations (operator recommend mode) | done | rec_pkn1 accept_completion applied 13:43Z |
| Schedules (human-created on the task page) | done (fired → claimed, queued-behind-drive) | sch_6KQQ, audit task.schedule.fired 13:58:39Z |
| Mentions + notifications (agent @human, human @agent, controller kind) | done: agent→human mention notif 13:21Z; controller kind (goal link started); packet/approval/quality/policy/dependency kinds observed; human→agent mention silently refused at an ineligible stage (F35-5) | notifications table, 10/26 screenshots |
| Browser capability (an agent screenshots something) | done: KNC-6 Docs & Release Engineer rendered README.md with a GFM renderer and screenshotted it through the browser MCP (page-2026-09-06T18-49-45-609Z.png posted on the timeline, served from the attachments route); KNC-27 dedicated probe done 21:12Z: headless-Chromium capture of GitHub's 404 (private repo) posted as an attachment, agent question packet raised, static audit accepted (NOTES 21:12Z, screenshot 108) | |
| Attachments (upload on a comment, viewer, download) | todo | |
| RBAC: viewer / contributor / maintainer / admin + non-member probe | done: 88 probes, 0 role violations, 21 project.authority.denied rows (dedupe D-25c), non-member 404 shape uniform; F35-4/U35-4 low | RBAC-PROBE.md, rbac-*.png |
| Archive + restore | done | KNC-24 14:20:38Z/14:20:42Z, audit task.archived{withdrawn:1}/task.unarchived |
| Audit page, via-controller disclosure | done (Activity audit column renders "Arda (via the controller)"; inspect_audit_log via controller) | 08-activity-dark, controller-reply-3.md |
| Insights | done | 09-insights-light |
| Guardrails (ruling 112 card) | done (threshold 40→5 via Apply; No duplicate summaries off; project.md guardrails[]) | 14:49Z |
| Force-accept | done | KNC-10 14:28:52Z: dialog rows, PR #4 merged, packet withdrawn by force-accept, task.acceptance.forced (U35-3) |
| Chained goal advance (link done → next task created), pause/resume/skip/retry | advance done (KNC-1→KNC-5→KNC-28); pause/resume done (goal-4 14:21Z); skip_link/add_link/remove_pending_link/edit_link done via controller (goal-3 14:22Z); retry todo | goal-3.md/goal-4.md timelines |
| blockedBy release engine | done (controller cleared waits → dependency-release notes → operators re-invoked) | KNC-2 timeline 13:57:18Z |
| Light/dark/desktop/mobile screenshots of every changed surface | in progress | shots/ |
| Files-are-truth checks after each event | done per event + a 30/30 hash/stage sweep at 14:55Z + re-scan 0 changed | NOTES |
| Full cycles ending in a merged PR (target 8) | 8 done: #1 (viberr accept), #2 (gh merge → divergence → accept), #4 (force-accept), #11 (viberr), #12 (viberr), #9 (gh → accept), #6 (gh → 409 on a stale page → accept), #15 (viberr) | NOTES 19:32Z, 19:38Z, 19:41Z |
| Restart recovery (process crash mid-run) | observed once (SIGBUS 18:40Z): 23 runs finalized, operators re-fired, partial workspaces picked up by the operators; U35-7 on the labels | NOTES 18:40Z |
| Restart recovery, credential loss, network loss | restart 18:40Z (SIGBUS, F35-9/U35-7); API key exhaustion 20:38Z (auth packets, owner swapped the key and clicked the re-run options); GitHub unreachable 21:27Z and TLS failures 21:41Z (honest packets, U35-11 on the attribution) | NOTES 18:40Z, 20:38Z, 21:33Z, 21:54Z |
| Post-review rework routing | F35-13: four tasks stranded at Merge after conflict reworks; the human stage picker is the only way out; the operator learned to recommend it by the third occurrence | NOTES 20:22Z–21:13Z |
| Final state | 15 merged / 5 closed / 10 open PRs; 33 tasks; rescan 0 changed; 33/33 consistent; final screenshots 111–118 | NOTES 22:01Z |
