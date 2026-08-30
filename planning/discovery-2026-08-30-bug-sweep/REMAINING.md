# Bug sweep 2026-08-30 — findings NOT addressed in this pass

A 24-scenario hunt with two-lens adversarial verification produced 51 raw
findings; 40 survived refutation. This pass fixed 21 of those 40 (every HIGH),
plus 9 more that the verifiers refuted only BECAUSE the fix had already landed
in the working tree while they were reading it.

The 19 below are real and confirmed, and were left for a later pass. They are
ordered as the sweep reported them; none is HIGH.

## [MEDIUM] A queued controller turn orphaned by a restart gets no recovery note (boot heuristic keys on the last message)

`app/server/controller/controller-run.server.ts:441`

`recoverControllerConversations` only notices an interrupted turn when the conversation's MAX(seq) message is authored by 'user', but a turn started from the FIFO queue always has a controller reply sitting after its user message, so a restart during a queued turn leaves that message permanently unanswered with no note anywhere.

**Failure:** Owner sends "A" (seq 1) → run A starts. While A is running the owner sends "B" (seq 2) → appended and pushed onto `entry.queue`; the action returns ok. Run A finishes → settleTurn appends reply A (seq 3, author 'controller') → shifts B → run B starts. The container is restarted (deploy, `restart: unless-stopped` bounce, or the crash-visibility `process.exit`) while run B is in flight. On boot, `finalizeOrphanedRuns` stamps run B `error` and `continue`s because kind === 'controller'; `recoverControllerConversations` evaluates MAX(seq) = 3, author 'controller', so the conversation is not selected and no note is written. In-process leases are gone, so `conversationTurnState` reports `{working:f

**Suggested fix:** Drive the recovery off the RUNS, not off message order: also select conversations that have an `agent_runs` row with `kind='controller' AND project_slug='' AND task_key = c.id` in a terminal state (`error`/`interrupted`) for which no `controller_messages` row carries `run_id = <that run id>` — settleTurn is the only writer of a run-linked controller message, so its absence is exactly "this turn's settle never ran". Keep the existing last-message-is-user arm for a message whose run never started,

---

## [LOW] A queued turn that fails to start discards every remaining queued message

`app/server/controller/controller-run.server.ts:387`

When `settleTurn` cannot start the next queued turn it appends one generic note and deletes the whole lease, throwing away every other message still in the FIFO — those messages are already in the transcript and will never run, never get a reply, and (because the last message is now the controller's note) will not be picked up by boot recovery either.

**Failure:** Owner sends A (running) then B, C, D (queued). Run A finishes; settleTurn appends reply A, shifts B, and `startTurnRun` throws because an org stdio MCP grant fails its `verifyStdioMcpMountsForRun` pre-flight (or the data volume is full and `mkdirSync` on the controller scratch dir fails). The catch appends one note about "the queued turn" and deletes the lease. C and D are gone from memory while still sitting in the transcript: no run, no reply, and no boot recovery, since the newest message is now the controller's note rather than a user message.

**Suggested fix:** On a queued-start failure, drain the rest of `entry.queue` explicitly — append one controller message naming each dropped message (or a single note that lists how many follow-ups were dropped) — before `map.delete(conversationId)`; alternatively keep the lease and attempt the next queued message rather than abandoning the whole FIFO on one start failure.

---

## [MEDIUM] Boot's orphan operator re-invokes run concurrently with the workspace reclaim that assumes nothing holds a working tree

`app/server/runtimes/run-recovery.server.ts:151`

`finalizeOrphanedRuns` launches its operator re-invokes fire-and-forget, and boot immediately proceeds to `reconcileRestartedWork`, whose third step `rmSync`s `<taskDir>/workspace` for every terminal-stage task — so a recovery drive can be cloning into exactly the directory the reclaim is deleting, breaking the invariant the reclaim's own docstring asserts.

**Failure:** A task sits in its project's terminal stage (the operator ran `accept_completion`, or a maintainer moved it manually) while a supporting run is still `running`; the process is then killed. On the next boot `finalizeOrphanedRuns` finalizes that row and, because the crash-loop count is under `RECOVERY_REINVOKE_CAP`, schedules `runOperator(..., trigger: "manual")` for the task on a detached promise. Boot continues; `reconcileRestartedWork` finishes steps 1-2 and calls `reclaimTerminalTaskWorkspaces`, which sees that task in the terminal stage and `rmSync`s `<taskDir>/workspace` while the recovery drive's `cloneWorkspaceRepo` is writing into it. The clone's own guard (operator-run.server.ts:1063

**Suggested fix:** Make the orphan re-invoke joinable and sequence it with the rest of boot recovery: have `finalizeOrphanedRuns` return the promise (or expose the `toReinvoke` list) and `await` it inside `reconcileRestartedWork` before step 3, the same way P14-RT-09 sequenced the reply reconciler ahead of the reclaim. Alternatively give `reclaimTerminalTaskWorkspaces` the active-run guard the periodic maintenance pass already has, so it skips any task with a non-terminal run row or a recovery drive in flight.

---

## [MEDIUM] Packet-resolved acceptance skips the OBS-11 empty-branch cleanup and its disclosure

`app/server/tasks/task-actions.server.ts:5969`

`resolvePacket`'s `accept_completion` arm is a fourth writer to Done that does not go through `applyAcceptanceWrite`/`acceptCompletion`, so a no-change completion resolved from a decision packet never runs `emptyBranchDisposition`/`deleteTaskRemoteBranch` and never appends `emptyBranchNote` — reproducing verbatim the OBS-11 harm the cleanup was written to fix.

**Failure:** Task VIB-9 has `branch: "viberr/vib-9"` pushed to the remote, no PR, and nothing ahead of `main`. The operator opens a decision packet whose recommended option is `kind: "accept_completion"`. A maintainer confirms it. `acceptanceNoChangeCheck` returns `applies: true` with `verification.basis: "branch_empty", branch: "viberr/vib-9"` — the exact shape `emptyBranchDisposition` classifies as `{ kind: "delete" }` on the human path. The packet arm writes Done with the "Completed with no changes" event, and the empty branch stays on GitHub forever with no timeline sentence saying so. Confirming the SAME task through the Accept button or an `accept_completion` recommendation card deletes it — two ac

**Suggested fix:** Hoist the disposition/cleanup out of `acceptCompletion` into a helper the packet arm also calls: compute `emptyBranchDisposition(db, existing.parsed.frontmatter, noChange, input.projectSlug)` before building `event`, append `emptyBranchNote(...)` to the no-change event text, and run the same best-effort `deleteTaskRemoteBranch` block after the resolution write when the disposition is `{ kind: "delete" }`. Better still, route the packet arm's Done write through `applyAcceptanceWrite` so a fifth w

---

## [LOW] Packet-resolved acceptance writes the terminal stage without recording previousStageId

`app/server/tasks/task-actions.server.ts:6015`

Ruling 98 requires every stage write to record where the task came from, and `transitionStage` (line 4335) and `applyAcceptanceWrite` (line 7522) both do — but `resolvePacket`'s `accept_completion` mutate sets `fm.stage = doneStageId` and leaves `previousStageId` naming a stage two hops back, so the operator snapshot reports a false "arrived from".

**Failure:** VIB-3 moves impl → review (`transitionStage` stamps `previousStageId: "impl"`). The operator opens an acceptance packet; a maintainer confirms the `accept_completion` option. The task lands on Done with `previousStageId` still `"impl"`. Any later operator turn on that task (an @mention comment, a scheduled run, or a reopen that re-reads the snapshot before the next `transitionStage` overwrites the field) is told the task "arrived from In Progress" when it arrived from Review — the exact false "arrived from" the ruling-98 comment on line 7519 names, on the one acceptance door that was not fixed.

**Suggested fix:** Add the same two lines to the packet arm's mutate, immediately before `fm.stage = doneStageId`: ```ts         if (fm.stage !== doneStageId) fm.previousStageId = fm.stage; ``` The durable fix is to have this arm delegate its Done write to `applyAcceptanceWrite`, which already owns the field.

---

## [LOW] TokenBucketLimiter's MAX_TRACKED_KEYS does not bound the bucket map, and prune() runs O(n) per new key

`app/server/auth/rate-limit.server.ts:54`

`MAX_TRACKED_KEYS` is advisory only: `prune()` deletes just fully-refilled buckets and the new bucket is inserted regardless, so an unauthenticated caller varying the `email` half of the key keeps the map above the threshold indefinitely and makes every subsequent new key pay a full O(n) scan.

**Failure:** An unauthenticated attacker POSTs `/api/auth/sign-in/email` with a fresh address each time (`a1@x.com`, `a2@x.com`, …) at R requests/second. Every request creates a new bucket; none is prunable for 90s, so the map settles at ~90·R entries and stays above 10,000 for any R > ~111/s. From then on every request takes the `!bucket` branch, calls `prune()`, and scans the whole map — ~90·R iterations per request, i.e. ~90·R² map iterations per second (at R=1000 that is ~90M iterations/s on the single Node event loop, plus tens of MB of live Map entries). The login throttle — the app's own anti-brute-force control — becomes the lever that stalls request handling for every signed-in user.

**Suggested fix:** Make the cap real: after `prune()`, if `this.buckets.size >= MAX_TRACKED_KEYS`, evict the oldest entries (a Map preserves insertion order, so deleting from the front works) or refuse the new key by returning `false`. Also rate-limit how often `prune()` may run (e.g. at most once per second via a `lastPrunedAt` timestamp) so it cannot be triggered on every insert.

---

## [MEDIUM] notificationHref (B-FD6) is computed but no surface consumes it, so project-scoped rows are dead clicks

`app/features/shell/top-bell.tsx:110`

`listNotifications` resolves a destination for every row (`href`), including `/projects/<slug>` for a row that names a project but no task, but both consumers ignore `href` and re-derive navigability as `projectSlug && taskKey` — so project-scoped notifications render as live-looking clickable controls that navigate nowhere, exactly the defect B-FD6 says it fixed.

**Failure:** A project's GitHub PAT expires. After three consecutive failed poll passes `noteReconcileFailure` writes "GitHub sync is failing for this project" to each project admin/maintainer with `project_slug` set and `task_key` NULL. In the bell popover the row renders as a normal `<button>` (targetMissing is false, so no `aria-disabled`, no explanatory `title`); clicking it marks it read and navigates nowhere — the admin cannot reach the project from the alert telling them to fix its credential. On `/notifications` the same row shows a focusable "key" button labelled "Viberr Core · " (trailing separator, empty task key) whose `onOpen` is a no-op. The same happens for every "Goal completed: every lin

**Suggested fix:** Thread `href` through `NotificationView`/`NotificationPageItem` and have both `openItem` implementations navigate to `n.href` when it is non-null and render the row as non-clickable (`aria-disabled` + title) when it is null; label the key button from the href's target (project name alone when there is no task key) instead of concatenating an empty `taskKey`.

---

## [LOW] "Mark read" button announces the literal string "null" for every title-less notification

`app/features/notifications/notifications-page.tsx:204`

The inbox stream's per-row "Mark read" control builds its accessible name by string-concatenating `n.title`, which is NULL for every kind except packet/approval, so a screen reader announces `Mark “null” read`.

**Failure:** User A comments "@arda please review" on a task. Arda opens /notifications; the mention row is unread, so `NtfStream` renders its "Mark read" button with `aria-label="Mark “null” read"`. A screen-reader user hears the word "null" as the notification's identity; there is no other accessible name for the control.

**Suggested fix:** Use the same fallback the row body already uses — `n.title || plainText(n.text)` (the `notification-item.tsx:65` rule) — or drop the quoted subject entirely when `title` is null.

---

## [MEDIUM] Codex runs carry no cost, so the cost-ordered breakdown reports them as $0.00 and can truncate them out of the TOP_N entirely

`app/server/insights/insights-query.server.ts:416`

`total_cost_usd` is only ever written from the Claude `result` envelope, so every Codex run row is NULL; `COALESCE(SUM(total_cost_usd), 0)` turns "cost unobservable" into "$0.00", and because the breakdown is ordered cost-first and capped at 8, Codex-only groups sort last and can be dropped from the breakdown no matter how many runs they have.

**Failure:** An instance runs 9 projects; 8 deliver on Claude (each with some non-zero spend) and the 9th — the busiest, 400 Codex runs — delivers on Codex. `byProject` orders by cost DESC, so the eight Claude projects occupy all 8 TOP_N slots and the busiest project is absent from "By project" entirely. On the two-row "By backend" card the same instance reads `codex · 400 runs · $0.00`, and the "Total cost" headline reports only the Claude spend while the page's own subtitle claims "Analytics across every agent run on this instance" — a supervisor comparing backends concludes Codex is free.

**Suggested fix:** Keep cost NULL-aware end to end: select `SUM(total_cost_usd)` (no COALESCE) plus a `count(total_cost_usd) AS costed_runs`, carry `cost: number | null` on `CountRow`, and have `fmtCost` render an absent cost as a de-emphasized "not reported" (the same three-state honesty `BackendQuotaPanel` already uses for utilization) rather than "$0.00". For the cap, order by `cost DESC NULLS LAST, runs DESC` only after guaranteeing the top run-count groups survive — e.g. union the top-N-by-cost with the top-N

---

## [LOW] "Long timelines" ignores each project's actual compression-threshold guardrail (and whether it is on at all)

`app/server/insights/insights-query.server.ts:149`

`longTimelines` compares every task's `event_count` against a hard-coded 40, but `compression-threshold` is a per-project guardrail with a configurable value that can also be switched off — so the card counts tasks against a threshold their project does not use, and claims the compression machinery is managing tasks in projects where it is disabled.

**Failure:** Project A sets `compression-threshold` to `value: 10`; Project B turns it `on: false`. A task in A with 25 timeline events is being actively compacted but contributes 0 to "Long timelines", while every task in B with 45+ events is counted as a record "the readability machinery is actively managing" even though nothing is compacting them. Scoped to a single project via the controller's `inspect_run_analytics` (controller-toolkit.server.ts:742), where the correct threshold is unambiguous, the number is still computed from 40.

**Suggested fix:** Add `guardrails_json` to the `govProjectSchema` SELECT already issued at insights-query.server.ts:231-238, parse each project's `compression-threshold` entry, and count a task only when its project has the guardrail `on`, using that project's `value` (falling back to 40 when absent) instead of the module constant.

---

## [MEDIUM] assignSpecialist is the only roster writer that skips the deriveValidation recompute, so a delivery hand-off leaves a stale `validation:` in task.md

`app/server/tasks/specialist-run.server.ts:749`

`assignSpecialist` rewrites `engagements[]` (which is an input to `requiredReviewers`) without recomputing the derived `validation` cache, so promoting a verdict-capable supporting engagement to deliverer leaves the canonical task file asserting a review state that no longer derives — the exact UX19-3 mechanism-2 bug that `assignReviewer` and `removeReviewer` each fix inline.

**Failure:** VIB-1 sits at Review. Deliverer = `dev`. `qa` is engaged as supporting with `verdictCapable: true` and has recorded `request_changes` on the current revision, so the file carries `validation: failing` (correct). The operator decides `qa` should now own the fix and calls `run_agent(profileId: "qa", delivers: true)`. `assignSpecialist` writes engagements = [qa(delivers:true)] (dev dropped), so `requiredReviewers` is now empty and `deriveValidation` would return `changed` — but the file still says `validation: failing`. Every subsequent run's canonical anchor now tells the agent "validation: failing" (contradicting the same operator snapshot's `validation: deriveValidation(fm)` = `changed`), an

**Suggested fix:** Add `parsed.frontmatter.validation = deriveValidation(parsed.frontmatter);` inside assignSpecialist's `updateTaskFile` callback, immediately after the `engagements` assignment — the same line assignReviewer (921) and removeReviewer (1000) already carry.

---

## [MEDIUM] The dispatch-completion cc-append defeats the F22-12 self-duplicate suppression, double-posting the agent's report

`app/server/tasks/task-actions.server.ts:3194`

Ruling 98(c)'s mechanical cc line is appended to `replyText` before `recordAgentCompletion`, but the F22-12 duplicate check compares the reply against this run's own mid-run comments by EXACT text — so the appended `cc @Name @operator` makes a verbatim-repeated report no longer match, and the same finding lands on the timeline twice (with a second mention fan-out).

**Failure:** A maintainer dispatches a Claude agent holding `comment-on-task` via the task page's run-agent control (`triggeredByName` set). Mid-run the agent calls `post_comment` with its finding "Root cause: the projection overlay never runs for this row." and then repeats exactly that text as its final message, without tagging anyone. At completion `hasHumanTag`/`hasOperatorTag` are both false, so `replyText` becomes "Root cause: ...\n\ncc @Arda Kaya @operator". `duplicatesOwnCommentThisRun` compares that against the stored mid-run comment text, does not match, `duplicate` is false, and the identical finding is posted a second time — and `notifyMentionedUsers` fires again on it, so anyone tagged insid

**Suggested fix:** Strip the appended cc line before the duplicate comparison — either add the cc-stripped form to `candidates` in `prepareAgentReplyEvent`, or reuse the existing `stripCcLine` helper (line 3579) on both sides of `duplicatesOwnCommentThisRun`'s comparison, so the F22-12 dedupe keys on the agent's own prose rather than on the pipeline's bookkeeping.

---

## [LOW] A delivery hand-off through assignSpecialist silently drops the engagement's F27-B1 `pinnedBackend`

`app/server/tasks/specialist-run.server.ts:724`

`assignSpecialist` rebuilds the promoted profile's engagement row from a bare `{profileId, backend, role}` ref, so a `pinnedBackend` recorded on that profile's existing supporting engagement (a deliberate retry-on-other-backend switch that ruling F27-B1 says must STICK) is discarded and the next run reverts to the live profile's backend.

**Failure:** Claude is quota-failing. A `retry_other_backend` packet for the supporting reviewer `qa` is resolved to Codex, so `qa`'s engagement gets `pinnedBackend: "codex"` and its later runs correctly go to Codex. The operator then hands delivery to `qa` with `run_agent(profileId: "qa", delivers: true)`; `dispatchAgentRun`'s hand-off branch calls `assignSpecialist`, which rewrites `qa`'s row from the bare `ref` and drops `pinnedBackend`. The very next dispatch resolves `backend = resolved?.backend` = the profile's Claude — the backend the retry existed to escape — and fails on quota again, with no record that a pin was ever in force.

**Suggested fix:** Carry the existing row's durable fields forward when promoting: look up `parsed.frontmatter.engagements.find(e => e.profileId === ref.profileId)` inside the update callback and spread it under the new `{...ref, delivers: true, verdictCapable}` (at minimum preserving `pinnedBackend`), instead of discarding it with the filter.

---

## [MEDIUM] A queued scheduled operator trigger is overwritten by any later machine trigger while the occurrence is recorded `fired`

`app/server/tasks/schedule.server.ts:667`

When a scheduled operator re-run fires while a drive holds the lease, `runOperator` returns `queued: true` and the schedule runner finalizes the occurrence as `fired`; but the queued slot for machine triggers is newest-wins, so any transition/agent-reply trigger raised during that same drive overwrites the scheduled trigger and its `scheduleNote` — the run FR39 promised never happens, while the file, the audit row and the timeline all say it did.

**Failure:** A maintainer schedules an operator re-run on VIB-1 for +30 min with the note "re-check the flaky test before we ship". At fire time an operator drive is already in flight (a multi-minute agent-reply react). `fireDueSchedules` claims the occurrence, writes "**Scheduled action starting:** … — re-check the flaky test before we ship", audits `outcome: "claimed"`, calls `runOperator({trigger:"scheduled", scheduleNote})`, gets `queued: true`, and stamps the occurrence `fired` with a `firedAt`. Still inside that live drive the operator calls `transition_stage`, whose re-trigger calls `runOperator({trigger:"transition"})`, which sets `queue.latest = transitionInput` — discarding the scheduled input.

**Suggested fix:** Do not let a `scheduled` trigger be silently overwritten: either keep scheduled triggers in an ordered queue alongside human `@operator` comments (they carry input that exists nowhere else in the run's input, the same reason human comments are queued), or, when `queue.latest` is replaced, merge the displaced trigger's `scheduleNote` into the surviving one. Failing that, do not finalize the occurrence to `fired` on a `queued: true` result — leave it pending (as the `deferredConflict` arm already 

---

## [MEDIUM] Resource delete-confirm says "Nothing grants it" for resources granted by the controller or operator template

`app/features/org-settings/resources-panel.tsx:151`

The template-grant count behind the irreversible resource-delete confirmation is computed from `gagents`, which `listGlobalAgentProfiles` restricts to `kind === "specialist"`, while `updateResourceReferences` drops grants from EVERY profile file including `controller.md` and `operator.md` — so the three resources the shipped store attaches to those two profiles read as unused right before the delete strips them.

**Failure:** An org admin opens Settings -> Agent resources on a stock install and clicks delete on the `controller-handbook` knowledge base (or the `controller-guide` / `viberr-app-expertise` skills). `usedBy("kbs", "controller-handbook")` is 0 because `gagents` excludes the controller template, and `projectGrantsFor("kbs", "controller-handbook")` is 0 because the controller is never deployed into a project. The confirm reads "Permanently deletes the folder and its N files. This cannot be undone. Nothing grants it." The admin proceeds. `deleteKnowledgeBase` `rmSync`s the folder and `updateResourceReferences("kb", "controller-handbook", null)` strips the grant out of `controller.md`. Every subsequent con

**Suggested fix:** Compute the template-grant count server-side over the same file set `rewriteTemplates` walks, rather than over the specialist-only `gagents` list. Add a `countTemplateGrants(kind, slug, dataRoot)` to `resource-references.server.ts` (the read-only twin of `rewriteTemplates`, mirroring the existing `countProjectDeploymentGrants`), surface it as `templateGrants` alongside `projectGrants` in `getOrgSettingsView`, and have `usedBy` in the confirm read that instead of `gagents`. The panel's per-row "N

---

## [LOW] The agent resource picker lists symlinked KB/skill folders that org settings hides and every run refuses

`app/server/org/resource-catalog.server.ts:97`

`buildResourceCatalog`'s `dirNames` uses `statSync`, which dereferences symlinks, while `resources.server.ts`'s `subDirNames` was deliberately switched to a non-dereferencing check for exactly this reason — so a symlinked `data/kb/<dir>` or `data/skills/<name>` is offered as a grantable resource in the profile picker even though it is invisible in org settings and provably resolves to nothing at run time.

**Failure:** A store gains a symlinked top-level resource folder out of band — e.g. an operator relocates a large knowledge base with `ln -s /mnt/docs data/kb/handbook`, which is exactly the shape P14-RV-02 / C5 assume is possible. Settings -> Agent resources does not list `handbook` at all (`subDirNames` skips it), so nobody can inspect, re-index or delete it there. The project agents page still offers `handbook` in the Knowledge bases group of the profile picker, an admin grants it, and every UI shows the grant attached — while `readKbBodyDetailed` returns `{ body: "", unresolved: { reason: "its store folder is a symlink …" } }` for every run. That is the silent-resource class (a grant that resolves to

**Suggested fix:** Replace `resource-catalog.server.ts`'s private `dirNames` with the non-dereferencing form — `readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())` — or, better, export `subDirNames` from `resources.server.ts` and call it here so the picker and the org-settings listings can never disagree about what is a resource again.

---

## [MEDIUM] Boot's workspace reclaim runs unguarded and concurrently with the runs boot itself starts

`app/server/boot.server.ts:632`

`reconcileRestartedWork` is fire-and-forget, and its third step deletes terminal-stage task workspaces with no `activeRunCount` guard — but step 1 of the same chain LAUNCHES operator drives that clone exactly those directories, so the reclaim can `rmSync` a working tree out from under a live run.

**Failure:** A human @-mentions an agent on a task already accepted into Done (`waiting: 'agent'`, terminal stage, workspace present). The process is restarted while that run is in flight. On the next boot `recoverUnreactedAgentRuns` selects the row (its SELECT filters on `t.waiting = 'agent'` and does not exclude terminal stages), posts the reply and re-invokes the operator with trigger `agent-reply` — a trigger `runOperator` explicitly permits on a terminal task — which clones `tasks/<KEY>/workspace/<repo>` and returns as soon as the drive is launched. `recoverStrandedOperatorPlans` then returns and step 3 runs: the task is in the terminal stage, so `rmSync(workspace, { recursive: true, force: true })`

**Suggested fix:** Gate the boot reclaim the same way the periodic pass is gated: in `reconcileRestartedWork`, skip step 3 when `activeRunCount(db) > 0` (or route it through `runMaintenancePass(db, { reason: "boot-reclaim", reclaimWorkspaces: true })` so the single guard applies), and/or await `reconcileRestartedWork` before starting the schedule/goal/poller runners so the documented ordering is real.

---

## [MEDIUM] Shared fetcher lets a row "Mark read" abort an in-flight "Mark all read" and then toast its success

`app/routes/notifications.tsx:79`

`markAllRead` and `markRead` share ONE `useFetcher`, so a row click while mark-all is in flight aborts the mark-all request; React Router discards the aborted result without ever delivering it, so `wantAllRead.current` is never cleared and the *row* read's result fires the handler, pushing "All notifications marked read" for an action that was cancelled.

**Failure:** Bell shows 12 unread. User clicks "Mark all read", then (before the POST settles — rows still render unread because the loader has not revalidated, so `markRead`'s `!item.unread` guard passes) clicks one row's "Mark read". The mark-all request is aborted mid-flight and its result is dropped; only that one row is reliably marked. The page then pushes the success toast "All notifications marked read" while the header still reports ~11 unread and the "Mark all read" button is still there. If the aborted mark-all had failed server-side (e.g. a 403), its `{ok:false, error}` branch is unreachable — the user is told it worked either way.

**Suggested fix:** Give mark-all-read its own `useFetcher` (the task-detail page already applies this rule — see the R14-3 comment on `archiveFetcher` in `app/features/task-detail/task-detail-page.tsx:233`: "its own fetcher — an archive/restore must not be able to strand or be stranded by an ownership submission sharing one fetcher"). Alternatively, stop scoping the toast with a submit-time ref and carry the intent in the result the action returns, so the handler can only speak for the submission that actually set

---

## [LOW] Notifications stream buckets by month/day only, merging same-day rows from different years into one header

`app/features/notifications/notifications-page.tsx:151`

`NtfStream` derives its day sections from a `Set` of month/day-only labels and then re-scans the whole list per label, so two notifications from the same calendar day in different YEARS collapse into a single "Mar 30" section and are rendered interleaved out of chronological order.

**Failure:** A low-traffic instance whose 200 most-recent notifications span more than a year. A notification from 2025-03-30 and several from 2026-03-30 all produce the label "Mar 30", so the single "Mar 30" section contains rows a year apart, and the year-old row is drawn inside the recent block rather than at the bottom of the stream — the reader has no way to tell them apart (the row's own stamp is `formatClock`, time-only).

**Suggested fix:** Group the way the activity page does — walk the newest-first list once and start a new section whenever the label changes (`groupByDay` in `app/features/activity/feed-helpers.ts`), so a repeated label produces a second section — or key/bucket on the absolute date (the ISO `YYYY-MM-DD`, or `formatCalendarDate`) and render `formatDayBucket` only as the visible label.

---
