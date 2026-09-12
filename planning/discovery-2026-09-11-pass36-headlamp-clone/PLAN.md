# Pass 36 — implementation plan (DRAFT 16:02Z; Q36-8..11 answered 16:19Z, all option (a); final after the last cycles)

Scope: every confirmed row in FINDINGS.md (F36-1..9, U36-1..8, G36-1..4, D36-1) plus the
owner's design answers (Q36-5 required-reviewer rule, Q36-7 operator resources). Preprod
rules from the brief: no migrations, no backwards compatibility, break freely; every fix
lands with a test that goes red against the unfixed source (prove it by reverting the source
hunk once and running the test); nothing deferred. One branch of `akin-ozer/viberr`
(`pass36/headlamp-clone-fixes`), one PR, no Claude attribution. After the merge: rebuild the
image, restart the container on the same data root, re-run the live checks listed per item,
then put the Code Reviewer back on `gpt-5.6-luna`/`max` and run one full HLC cycle to prove
F36-1/F36-3 are gone.

Rulings to add to `docs/architecture/decisions.md` (numbering continues from 176; text drafted
in the item that introduces it; Q36 answers may change 179/181):

| # | one line |
|---|---|
| 177 | A task that is terminal (its stage has no outbound edge) or archived refuses every coordination door — operator run (any trigger), specialist run, dispatch-completion wake, plan execution, packet authoring, schedule fire, reconciler polling — with one shared predicate and one refusal shape; acceptance and force-accept end the task's live runs and say so on the timeline (Q36-8, answered: interrupt). |
| 178 | A project declares required reviewers per review stage in `project.md` (`policy.requiredReviewers`); the acceptance gate, the review queue, the operator snapshot and the controller read the same rule; a task is not acceptable while a required reviewer has no current verdict on the PR head (Q36-5). |
| 179 | Ruling 163 applies to the pull-request head as well as the work revision: a PR head that moves after the latest verdict voids that verdict; Viberr returns the task to the verdict stage, notes and notifies, and the reviewer re-reviews the new head (Q36-9, answered a). |
| 180 | Claude skills mount outside the task checkout (a sibling plugin directory handed to the SDK as a local plugin); nothing Viberr writes for a run lives inside the tree the project's tools scan. |
| 181 | Every Codex run gets a private `CODEX_HOME` seeded from the person's home (auth copied in and back, sessions and skills shared, `CODEX_SQLITE_HOME` shared) so concurrent runs of one person never share the CLI's exec-helper directory (Q36-11, answered a). |
| 182 | The Codex sandbox is probed once per process (`workspace-write` on a trivial command); `healthSnapshot`/`instance_health` report it with the toolchain, and a sandboxed dispatch refuses with a named remedy when the probe failed instead of letting the model report an environment failure as a verdict. Deployment doc: seccomp. |
| 183 | A SKILL.md body is validated at every writer (frontmatter parses, real newlines); a JSON-escaped body is refused by name, never rewritten. |

## Clusters

Order chosen so each cluster's tests run green before the next starts; items name the
file(s), the change, the red-then-green test home (from CODE-CHECKS), and the live check.

### Cluster 1 — closed tasks stay closed (F36-4, F36-5, U36-1, U36-8; ruling 177)

1.1 `app/server/tasks/task-closure.server.ts` (new): `taskClosure(fm, project) → { closed:
    false } | { closed: true, why: "terminal" | "archived", stageId }` from the same
    stage-roles source the schedule runner's `mootNow` uses (`schedule.server.ts:451-475`);
    replace that inline predicate with it.
1.2 `operator-run.server.ts` `runOperator`: refuse EVERY trigger on a closed task with
    `refused: "closed"` (union at :283 gains it; the `scheduled`-only `terminal-stage` branch at
    :1470-1514 collapses into it). `commentToAgent` (`task-actions.server.ts:1747`) already
    writes the F35-5 "Mention not started" note on refusal; the copy at
    `execution-profile.tsx:496-497` ("Mentioning @operator … still runs it") is deleted.
1.3 `applyAgentCompletionEffects` (`task-actions.server.ts:4408-4420`): on a closed task the
    completion is recorded on the timeline ("completed after the task closed; not
    coordinated") and NO operator wake fires (`mustReact` yields to closure).
1.4 `operatorOpenPacket` (`operator-actions.server.ts:1072`) and the Codex plan executor's
    `open_packet`/`transition_stage`/`run_agent` arms (`operator-run.server.ts:2553-2578`):
    refuse on a closed task with the same shape (belt for 1.2's braces).
1.5 Specialist dispatch (`specialist-run.server.ts` archived-only gate): read `taskClosure`.
1.6 Acceptance + force-accept (`task-actions.server.ts:10077`, `:10441`): interrupt the task's
    live runs (`interruptRun`, run-service:1890), append one policy note naming each run, audit
    `task.acceptance.interrupted_runs` (Q36-8: interrupt).
1.7 Reconciler predicate (`github-reconciler.server.ts:1255-1287`): skip closed tasks, not
    only `archived OR pr merged`.
1.8 U36-1 copy: `archive-confirm.tsx:111`, `decision-packet.tsx:413` → the server note's
    wording ("Restoring brings the task back to a human; run the operator to reopen the
    decision").
1.9 U36-8: `run-recovery.server.ts:137-150` appends one policy note per task for runs it
    interrupts at boot ("Interrupted by a restart: … the operator is re-invoked").
Tests (red first): `operator-run.server.test.ts` ("ruling 131(d)…" neighbourhood) — closed
task refuses `manual`/`agent-reply`/`pr-diverged`; `task-actions.server.test.ts` ("F35-5…")
— @operator on an archived task leaves the note and starts no run; new
`task-closure.server.test.ts`; `task-actions.server.test.ts` completion effects — no wake on a
shipped task; acceptance test — live run interrupted + note; `github-reconciler.server.test.ts`
— shipped task not polled; `task-disposition.test.tsx` copy; `run-recovery.server.test.ts`
("finalizeOrphanedRuns (F-RUN1)") — note appended.
Live: force-accept a fixture task with a live run → run interrupted, note; @operator on an
archived task → "Mention not started"; restart the container → interrupted-run notes.

### Cluster 2 — the review gate tells the truth (F36-6, F36-7, G36-3; rulings 178, 179)

2.1 F36-6 `recordDeliveredNextStep` (`task-actions.server.ts:6716`): the Viberr-authored
    `transition` card is written ONLY when the delivered revision is verdict-clean
    (`deriveValidation(fm) === "healthy"`, or `none` on a board with no reviewer eligible at
    the current stage); `failing` (HLC-8, HLC-14) and `changed`/pending (HLC-3 17:34Z,
    HLC-14 17:36Z) get no card, and the audit row `github.delivery.next_step` records
    `{withheld: "verdict-pending" | "verdict-failing"}` so the silence is explainable. A card
    already recorded is withdrawn when a later verdict turns the revision `failing`.
2.2 Ruling 178: `project.md` gains `policy.requiredReviewers: [{ stageId, profileId }]`;
    schema in `app/schemas/project-file.schema.ts`; `mergeReadinessRefusal`
    (`task-actions.server.ts:9116`) and the review-queue predicate refuse acceptance while a
    required reviewer lacks a current verdict on the PR head; the operator snapshot lists the
    rule; controller tool `set_required_reviewers` (+ `describe_project` shows it); Policy page
    renders it; project settings form edits it.
2.3 Ruling 179 (F36-7): reconciler drift block (`github-reconciler.server.ts:537-548,
    613-615`): when the PR head moved past the last verdict's `headSha` with authored commits,
    void the verdict (`validation → changed` on the PR half), append a policy note with
    `describeRevisionDrift`, `notifyTaskWatchers`, wake the operator (`pr-diverged`), and move
    the task to the verdict stage through the existing rework route; `taskCommits`
    (`branch-sync.server.ts:348`) keeps foreign commits in a separate "not this task's" list
    the Commits card renders.
Tests: `delivery-actionable.server.test.ts` ("F19-1 …") — failing validation gets no card;
`github-reconciler.server.test.ts` ("ruling 132 …") — authored drift voids + notes + notifies;
`pr-divergence-wake.server.test.ts` — wake; new `required-reviewers.server.test.ts` —
acceptance refused without the required verdict, allowed with it; `controller-toolkit.server.test.ts`
— the new tool round-trips to `project.md`.
Live: push an observer commit on an approved PR at Merge Approval → task returns to Agent
Review, note + notification, reviewer re-runs; accept a task whose required reviewer never
ran → refused with the rule's name.

### Cluster 3 — Codex runtime (F36-1, F36-3, G36-4, D36-1; rulings 181, 182)

3.1 `compose.yml` seccomp (done) + `docs/operations/deployment.md` paragraph + runbook entry
    for "bwrap: No permissions to create a new namespace".
3.2 Ruling 181: `backend-credentials.server.ts:910-951` `runCredentialFor` → per-run home
    builder in `user-homes.server.ts` (`prepareCodexRunHome(userId, runId)` / `finishCodexRunHome`):
    copy `auth.json`, `config.toml`; symlink `sessions/`, `skills/`, `memories/`; set
    `CODEX_SQLITE_HOME` to the shared home; on finish copy `auth.json` back when its bytes
    changed (per-person lock), delete the run dir. Resume (`codex-runtime.server.ts:576/636`)
    reads sessions through the symlink.
3.3 Ruling 182: `app/server/ops/toolchain.server.ts` (new, memoized): versions of node, npm,
    git, python3, go, the Codex and Claude CLIs, plus `codexSandbox: { ok, detail }` from a
    one-time `workspace-write` probe; `healthSnapshot` appends `toolchain` LAST; `instance_health`
    inherits; `resolveCodexSandboxMode` callers refuse a sandboxed dispatch when the probe
    failed, with a packet/note naming the remedy.
Tests: `user-homes.server.test.ts` (new cases) — two run homes never share `tmp`; auth
write-back; `health-snapshot.server.test.ts` + `controller-ops-mcp.server.test.ts` — toolchain
field; `codex-runtime.server.test.ts` — refusal when the probe failed. Canary INSIDE the image:
two concurrent sandboxed `codex exec` on one person, both complete.
Live: Code Reviewer back on luna/max, one full HLC cycle with reviewer + developer + operator
concurrent, no helper loss.

### Cluster 4 — resources and the controller (F36-2, U36-3, U36-4, U36-5, G36-1, G36-2; ruling 183)

4.1 F36-2: `skill-body.server.ts` `assertSkillBodyWellFormed(body)`; called from `saveSkill`
    (`resources.server.ts` before :2288) and `writeStoreFiles` (`store-files.server.ts:326`);
    refusal names the remedy.
4.2 U36-4: `saveKnowledgeBase` resolves `disk:<dir>` to the existing row; the create reply
    (`controller-toolkit.server.ts:559`) names `saved.kb.id`.
4.3 U36-3: `update_agent_deployment` reply lists every field it changed (backend, model,
    effort, autonomy, stages, grants, resources); `project.agent_profile.updated` audit carries
    model + effort (ruling 139 parity).
4.4 U36-5: the three effort descriptions read from `CODEX_EFFORTS`/`CLAUDE_EFFORTS`.
4.5 G36-1: `update_agent_deployment` gains `skills`/`mcps`/`kbs` (omitted = unchanged, `[]` =
    clear, grant keys validated as in `save_global_agent:803`) for every kind.
4.6 G36-2: covered by 3.3.
Tests: `resources.server.test.ts` ("skills", KBs), `controller-toolkit.server.test.ts`
("update_agent_deployment carries the record it read (B5)", "save_global_agent: grants …"),
`store-files.server.test.ts`.
Live: controller saves a skill with an escaped body → refused; grants the operator a KB
through the dock → project.md shows it.

### Cluster 5 — disclosure (F36-8, U36-6, U36-7, F36-9; ruling 180)

5.1 F36-8: `specialist-run.server.ts:1492-1500` passes the profile's model through to
    run-service so the F21-13 substitution notice fires; the switched-backend timeline event
    (:2181-2186) names the model and that later runs stay on the pinned backend; the
    `retry_other_backend` option text says both.
5.2 U36-6: `ensureTaskBranch` (`branch-sync.server.ts:593`) audits `{canonical, suffixed}` and
    appends the ruling-122 note naming the taken name.
5.3 U36-7: reconciler collision (`github-reconciler.server.ts:937`) notifies watchers and wakes
    the operator; the collision-clear timeline names the closed PR.
5.4 Ruling 180 (F36-9): `skill-mount.server.ts` mounts to `<workspace>/../.viberr-plugins/<run>/`
    as a local plugin (`plugins: [{ type: "local", path }]` at `claude-runtime.server.ts:1322`,
    skill names `plugin:skill`); `writeCatalogSettings`, `CLAUDE_MD_EXCLUDES` and the
    `.git/info/exclude` write are retired. Canary inside the image: a skill mounted this way is
    listed and invoked by the SDK.
Tests: `specialist-run.server.test.ts` (F27-B1 neighbourhood) — disclosure; `branch-sync.server.test.ts`
(ruling 122 case) — audit + note; `github-reconciler.server.test.ts` + `pr-divergence-wake.server.test.ts`
— collision notify/wake; `skill-mount.server.test.ts` — nothing written under the checkout.
Live: reviewer's `npm run check` passes untouched in the agent workspace.

### Cluster 6 — U36-2, U36-10 picker eligibility, small copy, audit vocabulary

6.2 U36-11: `specialist-run.server.ts:1006` audits `task.engagement.added {posture: delivering|reviewer|supporting}` (rename; consumers: activity feed, insights, audit page labels); U36-9: the completion event names the terminal stage (`terminalName`) instead of "Done".

6.0 U36-10 (Q36-10 a): `execution-profile.tsx` Run-an-agent — the loader carries each
    profile's stage eligibility for THIS task (the ruling-133 predicate from
    `specialist-run.server.ts:4049`, exposed once server-side); the Run button is disabled with
    the refusal inline and the posture line never claims delivery for a stage-excluded profile.
    Test: `execution-profile.test.tsx` — ineligible profile renders the reason and a disabled Run.
6.1 `decision-packet.tsx:927` `branchDiscardOffered && archiveDisclosure?.branch !== null`;
    `operatorOpenPacket:1316` strips `deleteBranch` on a branchless task.
Tests: `task-detail-components.test.tsx` ("UX19-4 …").

## Gates and delivery

1. Per cluster: red test(s) shown failing against reverted source (kept in the PR description
   as a table: test → hunk reverted → failure line), then green.
2. `npm run lint && npm run typecheck && npm test`; `npm run e2e` with the compose container
   stopped (ruling 158: one process per data root) and restarted after.
3. Docs: `decisions.md` rulings 177-183, `deployment.md`, `runbook.md`, `operator.md`
   (closure doors), `agents-and-runtime.md` (per-run Codex home, plugin mount), controller docs
   (new tool, resources params).
4. PR `pass36/headlamp-clone-fixes` → main; no Claude trailer; CI billing-blocked is expected.
5. Rebuild image, `docker compose up -d --build`, restart on the same data root; live
   re-validation per cluster; reviewers back on luna/max; one full cycle; ledger SUMMARY.md.
6. Another model reviews the PR (owner's step).
