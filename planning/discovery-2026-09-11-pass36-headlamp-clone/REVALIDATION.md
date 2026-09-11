# Pass 36 — live re-validation checklist (run after the image rebuild)

Preconditions: branch `pass36/headlamp-clone-fixes` gates green (`npm run lint && npm run
typecheck && npm test`; `npm run e2e` with the compose container stopped); image rebuilt
(`docker compose build app`), container recreated (`docker compose up -d`), boot healthy on
the SAME data root `docker-data/` (ruling 158: one process per data root). Every task in
headlamp-clone is shipped or at Intake, goals paused, no live run — so the restart
interrupts nothing and the boot recovery has nothing to note (ruling 177(c) is proven by a
second restart with a live fixture run, item 1.4).

| # | item | how | expected | evidence |
|---|---|---|---|---|
| 1.1 | ruling 177 — @operator on an archived task | comment "@operator …" on archived HLC-4 | comment recorded, "Mention not started" note quoting "HLC-4 is archived — restore it before running the operator on it.", no run row, toast "reopen the task to run the operator" | task.md, audit `task.comment.unrouted`, no `runtime.run.started` | 
| 1.2 | ruling 177 — force-accept with a live run | create fixture task via the controller ("observer fixture: closure probe"), Run an agent (Server Developer, a long directive), force-accept from the card while it runs | run row `interrupted` with `interrupted_by` = arda, audit `runtime.run.interrupted {reason: task-closed, cause: force-accept}`, `task.acceptance.interrupted_runs`, note "Interrupted by acceptance"; NO operator run afterwards; task.md `waiting: none`, no packet | task.md, audit, run rows |
| 1.3 | ruling 177 — schedule + reconciler on a shipped task | schedule an operator run on shipped HLC-15 (task page schedule form) and watch the 5-min poller | schedule fires `skipped-done` naming "Shipped"; no `github.reconcile.task` rows for shipped tasks under the budgeted poll | audit |
| 1.4 | ruling 177(c) — restart note | start a fixture run, `docker compose restart app` | task timeline "Interrupted by a restart" naming the run; Insights honest | task.md |
| 2.1 | F36-6 — no card on a failing/pending verdict | fixture task through Building → delivery with the Claude reviewer engaged; then request-changes | no "Move the task to Merge Approval" card while pending or failing; audit `github.delivery.next_step {withheld}` | task.md, audit |
| 2.2 | ruling 178 — required reviewer rule | controller `set_required_reviewers` (Code Reviewer at Agent Review); Policy page shows it; accept a task whose reviewer never ran | acceptance refused with the rule's sentence; queue `canAccept` false; operator snapshot lists the rule | screenshots, task page refusal |
| 2.3 | ruling 179 — authored drift after approve | approve a fixture PR, push an observer commit to its head at Merge Approval, "Update status" | external revision minted, validation `changed`, "Revision moved after review" note, `policy` notification, operator woke, task back at Agent Review, Commits card "not this task's" | task.md, inbox, screenshots |
| 3.1 | ruling 181 — per-run CODEX_HOME | run a Codex operator turn + a Codex reviewer concurrently (reviewer back on luna/max) | each run's `CODEX_HOME` = `codex-home/runs/<runId>`; both finish; no `codex-linux-sandbox` ENOENT; `auth.json` write-back intact | run logs, `docker exec ls` |
| 3.2 | ruling 182 — toolchain + sandbox in instance_health | controller `instance_health` | `toolchain` field with versions and `codexSandbox.ok: true` | controller reply |
| 3.3 | Cluster 3 — full HLC cycle on luna/max reviewer | resume goal-4, let HLC-16 or a fixture run Building → review → accept | request-changes/approve by the Codex reviewer with a real gate run; no sandbox failure | run logs |
| 4.1 | ruling 183 — escaped skill body refused | controller `save_skill` with `\n` escapes | `[error] … the body arrived JSON-escaped; send real newlines` and no file written | reply, store |
| 4.2 | G36-1 — operator KB grant via controller | controller `update_agent_deployment {profileId: operator, kbs: [...]}` | project.md operator deployment `resources.kb` updated; reply lists the change | project.md |
| 4.3 | U36-3/U36-4/U36-5 | controller replies | `update_agent_deployment` lists old → new; `save_knowledge_base` create names the id; effort descriptions list `max` | replies |
| 5.1 | ruling 180 — skill mount outside the checkout | Claude reviewer run | `npm run check` passes in the agent workspace; no `.claude/` under the checkout; plugin dir beside the workspace during the run, gone after | run log, `docker exec ls` |
| 5.2 | U36-6/U36-7 | new task whose canonical branch is taken; stray PR on a task branch | timeline "Branch … allocated: … spoken for (ruling 122)" + audit detail; collision notification in the inbox + operator woke on the next tick | task.md, inbox |
| 5.3 | F36-8 | packet `retry_other_backend` on a failed Codex run | timeline names the model the retry ran on and that later runs stay on Claude | task.md |
| 6.1 | U36-10 | pick the Code Reviewer on an Intake task | Run disabled with the refusal sentence before the click; no delivering posture | screenshot |
| 6.2 | U36-9/U36-2/U36-11 | accept a fixture; archive-packet on a branchless task; engage a supporting agent | completion event says "**Shipped**"; no recovery paragraph; audit `task.engagement.added {posture: supporting}` | task.md, audit |
| 7 | screenshots | every changed surface light/dark/desktop/mobile | SCREENSHOTS.md rows 90+ | shots/ |
