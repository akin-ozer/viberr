# Lens 2 — one fact, several surfaces: do they agree? (pass 38 sweep)

2026-09-18. Read-only code sweep against HEAD `b161beae` on `pass38/airbnb-clone-fixes`.
`docker-data/` was not touched, so every "reachable" claim below is a code path, not a
measured board; the one live number I lean on (the shopify project storing `slate`/`amber`
stage colours) comes from the pass brief and is marked as such. While I read,
`app/server/runtimes/run-service.server.ts` shifted by ~39 lines under a concurrent
session's uncommitted edit (+45 lines), so for that file I quote the sentence and give the
line as read at the time.

Method, per the brief: for each fact, every renderer with the SOURCE it reads; two readers of
one fact with different sources or logic = a candidate; then construct the disagreeing state,
say how it is reached, and try to refute it. Nine candidates survived, three of them on the
same panel (the Agent-logs pill and its footer read one `RunView` through two different gates).
Eight facts were refuted by a single writer or a single gate; those are listed with what
killed them, because the refutations are the map of what is already safe.

## Table

| # | fact | surfaces (file:line) | source each reads | the disagreeing state | reachable? | refuted? | sev |
|---|---|---|---|---|---|---|---|
| C1 | A dispatched run is working vs parked behind the cap | board card wait tag `agent working` + pulsing dot (`board-page.tsx:296-303`); task hero / readiness pill `agent working` (`pill.tsx:90`, via `task.server.ts:651-655`); Current-state panel `Agent work` (`task-side-panels.tsx:925-926`); operator `get_task` → `waiting: "agent"`; vs timeline `Queued … Nothing is streaming yet` (`specialist-run.server.ts:318-342`); console `queued: waiting for a runtime slot` (`runs-panels.tsx:648-652`); exec-profile engagement row `queued` (`execution-profile.tsx:42-49`); home card "agents running" counts `state = 'running'` only (`home-query.server.ts:212-228`) | first group: `task.md` `waiting`, written by `markWaitingAgent` (`task-actions.server.ts:5526-5540`) unconditionally after `startRun` returned (`specialist-run.server.ts:2301`, `operator-run.server.ts:1859`); second group: the run row's `state`/`startRun` `outcome` | cap full → `outcome: "queued"`, row `queued`, `started_at: null`, and `waiting: "agent"` written anyway | yes — the exact state ruling 311 met live for 11 min on SHOP-55; `markWaitingAgent` never reads `outcome` | no. Its own docstring says "when a provider run is put in flight" | MEDIUM |
| C2 | Why an operator/controller run ended (`unavailable`) | Agent-logs pill `backend unavailable` (`runs-helpers.ts:55-57`) vs footer of the same panel `stream ended on a continuity error; see the blocked packet` (`runs-panels.tsx:728`) | one `RunView.failureKind`; the footer's `unavailable` arm sits behind `backendUnavailable`, which is gated on `kind === "primary" \|\| "reviewer"` (`runs-panels.tsx:606-609`) | any operator or controller run refused at start by `failRunUnavailable` (`run-service`: `tag: "run·unavailable"`, reached via `if (!credential.ok) return refuse(…)`) | yes — the refusal path is kind-agnostic; ruling 130(a)'s own comment: "four of pass 34's six live refusals were operator runs"; controller pages render this panel (`controller-page.tsx:299`) and a controller turn has no packet at all | no. Test at `runs-panels.test.tsx:183` pins the sentence only for an unclassified fixture | MEDIUM |
| C3 | Why a run ended (`max_budget`) | pill `cut off · spending cap` (`runs-helpers.ts:58-61`) vs footer `stream ended on a continuity error; see the blocked packet` (`runs-panels.tsx:703-728`, no `max_budget` arm); timeline `… reached the instance's spending cap … CUT OFF mid-work, which is not a task failure` (`task-actions.server.ts:5027-5032`) | same `failureKind`; the footer only branches on quota/auth/overloaded/backendUnavailable | every `max_budget` run (and `max_turns`, `idle_timeout`, `session_missing` get the same footer with a "continuity error" pill) | yes — ruling 175's class exists for it | no. `runs-helpers.test.ts:97-100` asserts the PILL is "not 'continuity error'" and never reads the footer beside it | MEDIUM |
| C4 | Whether an interrupted thread is resumable | footer `interrupted by <name>; the thread stays resumable` (`runs-panels.tsx:659`) vs (a) closure note `Interrupted by acceptance … interrupted so a closed task spends nothing more` (`task-actions.server.ts:13006-13010`) + ruling 177's closed-task refusal at every door; (b) human-interrupt note `before <backend> reported a session, so there is no thread to resume` (`run-service`, ruling 207(g)) | footer: row `interrupted_by` only; the row cannot say closure (`RunInterruptedReason = "restart"`, `runtime-types.ts:30`; `stopRunProcess` stamps `interruptedBy: actorUserId` for both a Stop click and a closure; the closure cause lives only in audit details) and the footer ignores `session_id` | (a) accept / force-accept / archive a task with a live run (`task-actions.server.ts:12979-12990`); (b) Stop a run before its first session event | yes, both | no. `runs-panels.test.tsx:922` pins the sentence | MEDIUM |
| C5 | Whether a hold will ever release | run control + `run_agent`/resume/deliver refusals: `… Viberr releases it when every entry is done` (`dependencies.ts:171-181`, rendered before the click at `execution-profile.tsx:691-694`, answered at `specialist-run.server.ts:1164`, `:4377`, `task-actions.server.ts:7019`, `:9586`) vs the release engine's own note on the same task: `<X> can never complete. This task stays held; edit what it waits on …` (`dependencies.server.ts:760`) which also sets `waiting = "human"` (`:764`) | `holdRefusal` gets `blockedBy.map(e => e.label)` — the names, `e.state` dropped; the note reads `deadDependencies` (`failed`/`missing`/`cancelled`) | a held task whose entry is archived, cancelled or missing | yes — the archive hook and the convergent sweep write the note (`dependencies.server.ts:737-777`); the control has `e.state` in hand and discards it | no | MEDIUM |
| C6 | Stage colour a controller stored | `create_project` schema `color: z.string().optional()` (`controller-toolkit.server.ts:1330`) → stored verbatim `s.color?.trim()` (`project-create.server.ts:581-585`); file schema `color: z.string().default("var(--muted)")` (`project-file.schema.ts:46`); ruling 15 says "hex or `var(--*)`"; renderers: board column dot + card (`board-page.tsx:971`, `:1123`), home meter `color-mix(in srgb, ${s.color}, transparent 82%)` and `background: s.color` (`project-cards.tsx:66`, `:88`), task hero (`task-main-sections.tsx:205`), side panel (`task-side-panels.tsx:871`), settings dot (`settings-page.tsx:687`) | the file says the stage HAS a colour; every renderer hands it to CSS | a value that is not a CSS colour: `slate` and `amber` are Tailwind names, not CSS named colours (CSS has `slategray`/`slateblue`, no `slate`; no `amber`) → `background` dropped, `color-mix()` invalid and dropped: six surfaces draw nothing | per the brief the shopify project stored exactly these (not verified here). No writer validates: `update_stages` has no colour argument at all (`controller-toolkit.server.ts:2751-2760`); the settings page shows the dot and offers no editor; defaults are hex (`#a5a8b5`, `#00b473`, `project-create.server.ts:534-543`) | no | MEDIUM (no false sentence; a silent blank) |
| C7 | Unread notifications | bell badge and `aria-label` print `unread` (`top-bell.tsx:187-199`) vs popover head prints `shownUnread = unread + orphaned unread rows` (`top-bell.tsx:43-44`, `:140`) | `countUnreadNotifications` excludes rows whose project is gone (`notifications.server.ts:280-292`); the popover adds them back from the 100-row list | an unread notification whose project was deleted: badge `2`, head `3 unread` (or no badge, head `1 unread` + Mark all read) | yes — F18-1's own case | half by design (F19-25 wanted Mark-all-read offered); the badge was left on the other number | LOW |
| C8 | Is the other backend usable now | profile card `usage window spent · reopens <t>` (`agent-accounts-panel.tsx:707-714`), `/resources/health` `quota[]`, `instance_health`, Insights — all `latestBackendRateLimits` (`backend-quota.server.ts:592-616`) vs dispatch + `retry_other_backend` option "Retry … on Codex now" — `backendDispatchHold` (`:655-678`) through `ownerHasOther` (`run-failure-remedy.server.ts:177-183`) | display keeps an exhaustion 24 h past a prose-derived `resetsAt` (`QUOTA_RESET_GRACE_MS`, `:549`) and 6 h undated (`:561`); the hold has no grace and 30 min undated (`UNDATED_HOLD_MS`, `:653`; `if (until <= nowMs) return null;` `:673`) | undated exhaustion 31 min old, or prose `resetsAt` passed < 24 h ago: card says spent (reopen instant in the past), packet offers a retry now | yes — every Codex spawn-time refusal is prose-derived | yes, as a bug: deliberate and documented (`:637-640` "SHOWING a spent window too long is cheap and holding a dispatch too long is not"); the card prints the past instant, so a reader can tell | LOW |
| C9 | Run state as the controller reads it | `list_runs`/`read_run_log` rows carry `state` only (`controller-ops-mcp.server.ts:249-262`, `:552-563`) vs the console pill `interrupted · by a restart` / `refused · quota` (`runs-helpers.ts:42-70`) | reply: `row.state`; console: `interrupted_reason`, `interrupted_by`, the terminal line's `failure.kind` | `state: "interrupted"` with no reason; `state: "error"` with no class | always | omission, not contradiction: the class rides `read_run_log`'s `display.failure` and the controller can read it | LOW |

## The candidates, ranked

### C1 — the board says "agent working" for a run the cap is holding (ruling 311's twin, one surface over)

Ruling 311 fixed the timeline sentence and left `waiting`. Both dispatch paths write it after
`startRun` has already answered which of three things happened:

```ts
// specialist-run.server.ts:2300-2301
  // The board reads "agent working" while the run is in flight.
  await markWaitingAgent(db, ctx, input.projectSlug, input.taskKey);
```
```ts
// task-actions.server.ts:5524-5536
/** Set `waiting: agent` when a provider run is put in flight, so the
 *  board reads "working" (not "waiting on human") while the agent runs. */
export async function markWaitingAgent(…) {
    …
      parsed.frontmatter.waiting = "agent";
```

`markWaitingAgent` takes no `outcome`; `operator-run.server.ts:1859` calls it the same way.
Then every reader of `waiting` says the run is working:

```tsx
// board-page.tsx:296-303
function WaitTag({ task }: { task: TaskSummary }) {
  if (task.waiting === "agent") {
    return (
      <span className="wait-tag agent">
        <span className="working" />
        agent working
```
```ts
// task.server.ts:651-655 (deriveDisplayReadiness)
  if (
    waiting === "agent" &&
    (readiness === "ready" || readiness === "input_required")
  ) {
    return "agent_working";
```

`pill.tsx:90` labels that `"agent working"`, so the task hero says it too, and the
Current-state rail says `Agent work` (`task-side-panels.tsx:925-926`). Beside them, on the
same task page, the exec-profile engagement row prints `"queued"` (`liveAgentRunLabel`,
`execution-profile.tsx:42-49`, reading the run row), the console footer prints
`queued: waiting for a runtime slot; output appears once it starts`, and the timeline entry
written two lines earlier by the same dispatch prints `Queued a Claude run … Nothing is
streaming yet.` The home card's "agents running" counts `agent_runs.state = 'running'`
(`home-query.server.ts:220-226`) and does not count it. The operator's `get_task` snapshot
carries `waiting: "agent"` with no run row beside it (`OperatorTaskSnapshot` has no run
fields), so the actor ruling 311 caught relaying "already in flight" now has the same false
fact from a second source.

Refutation attempt: is there a single writer that corrects it? Only the completion effects
reset `waiting`, and a queued run has none until it runs. `noteRunStarted` (ruling 311's
"other half") writes the promotion onto the timeline and nothing onto `waiting`, which was
already wrong. Not refuted. Severity MEDIUM: no one acts wrongly (the correct action while
queued is to wait), but a board of pulsing dots over a full cap is a false picture of load,
and the operator snapshot carries it.

### C2 — one panel, two classes: "backend unavailable" over "continuity error"

`runStatePill` and the footer read the same `RunView`. The pill:

```ts
// runs-helpers.ts:55-57
  if (run.state === "error" && run.failureKind === "unavailable") {
    return { kind: "blocked", label: "backend unavailable" };
```

The footer's only arm for that class is behind a gate on the run's KIND:

```ts
// runs-panels.tsx:606-609
  const backendUnavailable =
    (cur!.kind === "primary" || cur!.kind === "reviewer") &&
    cur!.state === "error" &&
    !!cur!.failedBackendUnavailable;
```

and the fall-through (`runs-panels.tsx:728`) is
`"stream ended on a continuity error; see the blocked packet"`. The pass-34 comment above
it says the KIND gate was added so the "isn't connected" retry clause is not appended to
operator runs — but the gate was put on the whole arm, so an operator or controller run
refused for `unavailable` gets the unclassified sentence. The refusal path is kind-agnostic:
`startRun` does `if (!credential.ok) return refuse(credential.message)` and
`failRunUnavailable` writes `tag: "run·unavailable"`, which the projection classifies
(`run-projection.server.ts:202-207`). The controller page renders this panel
(`controller-page.tsx:299`); a controller turn has no task and therefore no "blocked packet"
to see. Ruling 130(a) defines "continuity error" as "only an unclassified" failure. Not
refuted; the test at `runs-panels.test.tsx:183` pins the sentence for a run with no class.

### C3 — "cut off · spending cap" over "continuity error; see the blocked packet"

Same panel, same mechanism, different class. The footer branches on
`quota` / `auth` / `overloaded` / `backendUnavailable` (`runs-panels.tsx:703-728`) and has
no arm for `max_budget`, `max_turns`, `idle_timeout` or `session_missing`. For `max_budget`
the pill says `cut off · spending cap` (`runs-helpers.ts:58-61`, ruling 175) and the
timeline says `… reached the instance's spending cap … and was CUT OFF mid-work, which is
not a task failure` (`task-actions.server.ts:5027-5032`); the footer beneath the pill says
`stream ended on a continuity error`. `runs-helpers.test.ts:97` — "a run the spending cap
stopped reads 'cut off · spending cap', not 'continuity error'" — asserts the pill and never
the footer of the same fixture: ruling 329's shape (the test checks half the panel). A stuck
packet IS opened for these kinds (`openStuckLoopPacket`, `task-actions.server.ts:5107-5130`,
stock options), so "see the blocked packet" is the true half.

### C4 — "the thread stays resumable" on a thread that is not

```ts
// runs-panels.tsx:658-659
            cur!.interruptedBy
            ? `interrupted by ${cur!.interruptedBy.label.split(" ")[0]}; the thread stays resumable`
```

(a) Closure. `interruptRunOnClosure` (run-service) calls `stopRunProcess(db, run, input,
closure.byUserId, SYSTEM_ACTOR, { reason: "task-closed", … })`, which stamps
`interruptedBy: actorUserId` on both arms; the closure cause goes only into the audit
details. `RunInterruptedReason` is `"restart"` alone (`runtime-types.ts:30`), so the row
cannot carry "closed". The caller writes the truth one panel away:

```ts
// task-actions.server.ts:13006-13010
      title: "Interrupted by acceptance",
      text:
        `**Closed task:** … ${…} still live when ${taskKey} was ${verb}; ` +
        `… interrupted so a closed task spends nothing more, ` +
```

and ruling 177 refuses every re-run door on a closed task. The footer promises the one thing
the task refuses. This is ruling 338's shape exactly: the row state is identical for a Stop
click and a closure, and the panel asserts the Stop-click meaning.

(b) No session. Ruling 207(g) made the interrupt NOTE conditional:
`run.session_id ? "… The thread stays resumable; re-run the agent to continue." : "… before
<backend> reported a session, so there is no thread to resume."` The footer reads
`interruptedBy` only and says "stays resumable" for both. Reachable by pressing Stop during
`Preparing workspace`. `runs-panels.test.tsx:922` pins the footer sentence.

### C5 — a promise the same task's timeline says will never be kept

```ts
// dependencies.ts:176-180
    `${taskKey} waits on ${joinDependencyEntries(entries)} and Viberr is holding it, ` +
    `so ${verb} is refused. Viberr releases it when every entry is done; ` +
    `to release it sooner, change what it waits on.`
```

The run control renders it before the click from `blockedBy.map((e) => e.label)`
(`execution-profile.tsx:691-694`) — `DependencyRender.state` is right there and dropped —
and four server doors answer with it. The release engine, reading the states, writes on the
same task (`dependencies.server.ts:760-764`):

`` `${spelled} can never complete. This task stays held; edit what it waits on (remove the entry or point it elsewhere) to release it.` `` and `parsed.frontmatter.waiting = "human";`

So a person on a task whose dependency was archived reads, on one page: a note saying
"can never complete … edit what it waits on", a Waiting-on rail saying "a human", and a Run
button saying "Viberr releases it when every entry is done". `dependenciesSatisfied`
(`projections/dependencies.server.ts:170-172`) is `every(e => e.state === "done")`, so the
button's promise is structurally unreachable for a `failed`/`missing`/`cancelled` entry. Not
refuted. The write-time note at `dependencies.server.ts:323` ("Held until every entry is
done; Viberr releases it then") has the same shape when a dead ref is accepted at write
time (whether `validateDependencyRefs` refuses an archived key at write: unverified).

### C6 — a colour the file holds and no surface can draw

Ruling 15: "hex or `var(--*)` colors both accepted". The controller's schema accepts any
string and says nothing about the format:

```ts
// controller-toolkit.server.ts:1330
          .array(z.strictObject({ name: z.string(), color: z.string().optional() }))
```
```ts
// project-create.server.ts:581-585
        color:
          s.color?.trim() ||
          (isTerminal ? DONE_STAGE_COLOR : CUSTOM_STAGE_COLORS[i % CUSTOM_STAGE_COLORS.length]!),
```

`project-file.schema.ts:46` (`color: z.string().default("var(--muted)")`) validates nothing
on read either. Every renderer hands the string to CSS (`board-page.tsx:971`
`style={{ background: stage.color }}`; `project-cards.tsx:66`
`` background: `color-mix(in srgb, ${s.color}, transparent 82%)` ``; `:88`; `:1123`;
`task-main-sections.tsx:205`; `task-side-panels.tsx:871`; `settings-page.tsx:687`). `slate`
and `amber` are not CSS `<named-color>` values, so the browser discards the declaration; the
home meter's `color-mix()` becomes an invalid value and the whole segment background is
dropped. Six surfaces silently disagree with the file. No later writer can fix it: the
settings page has no colour editor and `update_stages` (`controller-toolkit.server.ts:2751`)
takes `op`/`stageId`/`name` only. The fix is one regex at the tool and the schema
(`/^#[0-9a-f]{3,8}$/i` or `/^var\(--[\w-]+\)$/`) with a description that names the format —
ruling 15 already states the contract.

## Refuted, and what killed each

- **Build stamp (fact 8).** One source, `getBuildInfo()` (`build-info.server.ts:106-120`),
  read by `healthSnapshot` (`health-snapshot.server.ts:12`, `:201`), the boot log
  (`boot.server.ts`) and `npm run deploy`, which reads `/resources/health` back and refuses
  success unless `serving.revision === sha.slice(0, 12)` (`scripts/deploy.ts:121-162`). No
  file under `app/features` or `app/routes` imports it: there is no UI footer to disagree.
- **Required reviewers and verdicts per revision (fact 5).** One gate,
  `requiredReviewerRefusals` (`required-reviewers.server.ts:116-135`, bound to
  `activeWorkRevision(fm.workRevision).id`), read by `acceptanceRefusalReasons`
  (`task-actions.server.ts:11670`), the projection's `acceptanceBlockReason`
  (`rebuilder.server.ts:392`, first refusal only, by documented design), the operator snapshot
  (`operator-actions.server.ts:2664` via `acceptanceRefusalFor`) and the controller's `get_task`
  (`controller-toolkit.server.ts:1631`). `consecutiveRequestChanges` is one schema function
  (`task-file.schema.ts:327`) for all three readers. The stage-move gate
  (`verdict-stage.ts:80-88`) reads the engaged set only — by design (ruling 178 "ADDS a
  reviewer"), and the operator's tool description says which gate governs which move.
- **PR state and reviewed revision vs head (fact 3).** The reconciler is the only writer of
  `pr.state` / `pr.headSha` / `pr.revisionDrift` / `pr.unpushedRevision`
  (`github-reconciler.server.ts:529-650`, `:949-954`), and ruling 179(a) has it mint the moved
  head as an `external` revision and re-derive `validation` in the same pass, so the readiness
  pill, the PR card, the review queue (`review-queue.server.ts:282`), the accept dialog
  (`accept-confirm.tsx:268`) and the operator's `revisionDriftSentence`
  (`operator-actions.server.ts:2636-2640`) all read one cached record. The board card shows no
  drift chip (`board-page.tsx:402-431`): an omission, not a claim.
- **Backend / model / effort (fact 2).** Every surface resolves through `resolveRunModel`
  (`model-catalog.server.ts:385-391`): the roster's `modelLabel` is the RESOLVED model
  (`agents-query.server.ts:485-493`), the dispatch (`operator-actions.server.ts:515-518`;
  `specialist-run.server.ts:1385`) and so the run row. `get_project.agents[]` reads the same
  roster (`controller-toolkit.server.ts:1443-1475`). A switch is disclosed twice, by one
  computation: `runDispatchLine`'s `(switched from X)` (`specialist-run.server.ts:335`) and the
  run log's first line (`MODEL_SUBSTITUTED_TAG`, run-service). `"orchestration runtime"` is
  rejected by `isKnownModel` (`model-catalog.server.ts:293-310`) and never reaches a row; the
  Agents page prints the "Orchestration runtime" chip only for a profile with NO backends
  (`agents-page.tsx:1085-1099`), and the seeded operator has two. Profile backend vs
  engagement backend (F27-B1 pin) are two facts, each labelled (`execution-profile.tsx:900`).
- **Quota / credential state (fact 6).** `/resources/health` `quota[]` and `instance_health`
  are one `healthSnapshot` (`health-snapshot.server.ts:174`, `:202`;
  `controller-ops-mcp.server.ts:311-330`); the profile card reads the same store
  (`profile-query.server.ts:239`); `retry_other_backend` and `operatorOpenPacket`'s guard both
  read `backendDispatchHold` (ruling 326). Only the display-vs-hold grace differs — C8, by
  design.
- **Counts (fact 7).** "N public repo(s)" is labelled as the GitHub account's public count
  (`connections-panel.tsx:272-277`, from `connections.server.ts:151 repos: row.repos_count`) —
  a reader can still take it for reach, but the label is true: LOW wording at most.
  `instance_health.runs` (`liveCount = handles.size + reserved.size`, run-service; `queued` =
  the two lane queues) against `list_runs` live (DB `state IN ('queued','running')`): every DB
  `running` row is a handle or a reservation and every DB `queued` row is in a lane
  (`admitRun`), and the controller's FIFO queues MESSAGES, not run rows
  (`controller-run.server.ts:157`, `:326`), so the two reconcile; ruling 302 added `total` for
  the clipped case. `get_project.stages[].tasks`, the home meter and the board all exclude
  archived rows by the same rule.
- **Attachments (fact 9).** The panel prints `attachments.length` and, when the 100-row cap
  truncates, `Showing the most recent N of {total} files` from `countTaskAttachments`
  (`attachments-panel.tsx:36-41`, `:77-89`), which the loader wires (`project.task.tsx:60`,
  `:405`). Pass 37 measured 90/90 (`VERIFIED.md:1207`).
- **Restart-interrupted runs (fact 1, the 338/310(b) family).** The recovery note
  (`run-recovery.server.ts:344-366`) splits ran/never-started off `started_at`, the capped
  notification (`:144-148`) repeats the note's decision word for word, and the console footer
  defers to the record (`runs-panels.tsx:687`). Agree.
- **Hold on the board card (fact 4).** `readinessYields` (`board-page.tsx:762-771`) hides a
  `blocked` pill under "waiting on you" on the documented assumption that "a dependency hold
  leaves `waiting` at 'none'" (`:755-756`); a held task with `waiting: "human"` exists (the
  dead-dependency note sets it, `dependencies.server.ts:764`; ruling 131(d) allows a packet on
  a held task) and then the card names only the human. `list_tasks.waitsOn`, the Details chips
  and the operator's held doctrine still name the hold. An omission by ruling 168(a)'s design;
  LOW, not a finding.

## What to fix first

C1 (pass `outcome` into `markWaitingAgent`, or write `waiting` only on `started`/promotion,
which `noteRunStarted` already has a hook for) and the three console lines C2–C4, which are
one file: route the footer's class arms off `failureKind` for every kind and every run kind,
and make "stays resumable" conditional on `sid` the way ruling 207(g)'s note already is —
the closure case needs a row fact (`interrupted_reason: "closed"`), which 338 judged "more
than the lie is worth" for recovery but is one enum value here. C5 is one line: pass the
entries with their states and let `holdRefusal` say "can never complete" when any is dead.
C6 is a regex.
