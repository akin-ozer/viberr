# Pass 34 — validation plan

Every fix is re-proven the way its defect was found: in the running app, not only in vitest.
`unit` steps are the canaried tests that ship with the change. `live` steps run against the
container on the `docker-data` root (port 5173) with the real `akin-ozer/jira-clone` project,
which is handed to the fix phase in this state: 16 tasks, 5 merged cycles, 8 open PRs, 224 runs,
0 runs in flight, 11 non-done tasks all waiting on humans. Named live subjects:

| task | state at hand-off |
|---|---|
| JC-5 | stranded at QA; PR #4 **closed**; workspace head `a34a596` is rework that was never pushed |
| JC-6 | QA→Review card pending; open PR **#13**; `ci.yml` dropped by hand under Q34-10 |
| JC-7, JC-9 | held on the goal-1 foundation (links 2, 3 and 4), one as `waiting: human`, one behind a standing `blocked` packet |
| JC-10, JC-12 | blocked packets open |
| JC-11, JC-13, JC-14 | reviewer-approved, open PRs **#19**, **#18**, **#15** |
| JC-15 | input packet open; the task whose owner was handed to Omar after its first run had already billed the creator |
| JC-16 | chain-created and holding |
| goal chains 1-5 | goal-1 is the foundation; goal-3 and goal-5 link 2 wait on it |

Before any live step: apply the additive projection column
(`ALTER TABLE task_projections ADD COLUMN blocked_by_json TEXT NOT NULL DEFAULT '[]'`), restart,
and confirm the boot integrity line reports no `projectionMissingColumns`. Never a re-baseline
(the same file holds users, sessions and sealed PATs), never a host-side write while the
container runs (D34-1).

## Order of the live pass

Sixteen tasks carry every live step and several steps CONSUME the state another one proves, so
the pass has one order and it is this. The rule: a step that destroys a subject's state runs
after every step that reads it, and where two steps need mutually exclusive states of the same
task the later one runs on a scratch task created for it (`JC-17` onward) rather than on the
contested one. A step not named below shares no subject and runs whenever.

| phase | order | why it is this order |
|---|---|---|
| L0 | the projection `ALTER`, restart, boot integrity line (above) | every dependency step reads `blocked_by_json`; nothing else may run first |
| L1 · scratch repos | V1 → V2 → V3 | touches no jira-clone state, and V2's observed GitHub answers are recorded in A1's module comment before A1 is final, so this phase runs before the code it validates is frozen |
| L2 · JC-5 | V6 → V30 → V29 → V28 → V26 (JC-5 leg) → V32 → V56 | V6 is read-only (it asserts HEAD unchanged). V30 and V29 both need `a34a596` still UNPUSHED, and V28 is the step that pushes it. V26's `up_to_date` needs origin to already carry that head, so it follows V28. V32 clears the branch and re-delivers, destroying every precondition above it; V56 then reads the note V32 leaves |
| L3 · JC-6 | V57 → V22 → V35 → V25 → V26 (JC-6 leg) → V27 → V33 → V47 → V48 → V21 | V57 opens the confirm and never presses it; V22's two refusals write nothing. V35's first withdrawal commits the new revision V25 then pushes to PR #13, and V26's idempotent second call follows that push. V27 re-runs the same delivery with the operator switched to full autonomy, then back. V33 needs a BEHIND remote again, so it takes a fresh local commit after V27. V47 grants `workflow` on the connection, which V48 then depends on. V21's two runs move the head last, when nothing above still reads it |
| L4 · dependencies | V12 → V13 → V46 → V63 → V14 → V16 → V17 → V5 → V15 | V46 needs JC-7 still held and branch-only. V63 writes its waits on JC-16 and a scratch task, never on JC-9, so V14's "exactly one reactive turn" is not spent first. V5 dispatches JC-9's deliverer only AFTER V14 for the same reason (a held task's manual run still answers, ruling 131(d)). V15 merges JC-3, JC-4 and JC-6 — which requires L3 to be finished — and releases JC-7 and JC-9, ending the phase |
| L5 · one subject each | V7 → V8 → V9 → V10 → V11 → V55; V18 → V34; V31 → V19 → V20; V23; V24; V36 → V37; V38 → V39 → V40; V41 → V42 → V64; V43; V44; V45; V50; V51; V52; V53; V58; V59; V66 | V55 reads the console of V7's refused run. V18 reads JC-11 before V34 closes its PR #19, and V51 owns JC-14's PR #15 so V34 never takes it. V31 records the unpushed revision on JC-13 that V19 then pushes. V23 and V50 take scratch tasks (V23 needs a task with NO delivering engagement; V50 needs a project whose credential is broken on purpose) |
| L6 · vitest | V4, V49, V54, V60, V61, V62, V65 and every other unit row | run at any point, and again in full after the live pass. V65 has a dev-server half: it runs on a scratch data root, never against `docker-data` while the container holds it (the writer lock refuses anyway, D34-1) |

## Band A — owner-ruled behaviour

| # | proves | how | expected |
|---|---|---|---|
| V1 | ruling 128: an empty repository is bootstrapped, not misreported | live — attach a scratch EMPTY GitHub repository to a new project and create one task that delivers | `main` is created by Viberr (`github.repo.bootstrapped` audit row, one `github` timeline line naming the initial commit), the task branch is cut from it, the PR opens; no surface ever says "GitHub was unreachable" |
| V2 | ruling 128: the observed GitHub answers are what the fakes encode | live — before merge, against that same scratch repository: `GET /git/ref/heads/main` (404 vs 409), `GET /branches` (`[]`), `PUT /contents` with `branch:`, `PATCH /repos {default_branch}` | each answer is recorded verbatim in the module comment; any divergence changes the code, not the test |
| V3 | ruling 128: a repository whose only ref is a task branch is repaired | live — push a task branch to a second empty repository by hand, then deliver | `main` is created at that branch's first commit, the repository default is restored, and the timeline says so |
| V4 | ruling 128: the pre-push gate splits by evidence | unit — `task-actions.server.test.ts` | `bootstrap_failed` refuses the push and says the base could not be created; a `network_unavailable` PROBE pushes anyway and never claims the base is missing |
| V5 | ruling 129: a reused unborn checkout is fast-forwarded | live — JC-9's workspace (cloned when the repo was empty): dispatch its deliverer | the run's `run·inputs` line reports `fast_forwarded`, the prompt carries "`origin/main` is at `<sha7>`", and the agent's first `git log` shows the base commits |
| V6 | ruling 129: a task branch is fetched, never moved, and an unrelated history is NAMED | live — JC-5's workspace (its branch holds an unrelated root commit) | the refresh reports `unrelated`, the workspace contract tells the agent its branch shares no history with `origin/main`, and HEAD is unchanged |
| V7 | ruling 130(a): a provider refusal is classified from the envelope | live — connect a Claude API key with no access (or reproduce the org refusal) on a throwaway member, run a task they own | the run console shows `run·error·auth` (not `unknown`), the result line reads `error · api 403 · api_error`, the banner is an `err` line and NOT an agent comment |
| V8 | ruling 130(b): the packet names the person's own remedy | same run | the operator's recovery packet recommends "I connected a different Claude account or an API key…", the body names that person and Profile → Agent accounts, and no option says "policy / credential updated" |
| V9 | ruling 130(a): every run kind's footer consumes the class | live — the same failure on an OPERATOR run | the Agent-logs footer says the backend could not run it, not "stream ended on a continuity error" |
| V10 | ruling 130(d): the refusal is recorded against the account it billed | live — Insights as an org admin, then that person's Profile | Insights names the account and the reset instant with the hour; the Agent-accounts card carries the refusal pill; `curl /resources/health` carries NO person id or name |
| V11 | ruling 130(c): the controller answers with a remedy, not a retry | live — send the controller a message while that credential is refused | the transcript note names the account remedy and does not say "Say it again to retry" |
| V12 | ruling 131: a hold becomes a watched wait | live — JC-7: Details → Blocked by → `goal-1 link 2, goal-1 link 3, goal-1 link 4` | the list is written, `waiting` goes `none`, the board card and hero show the neutral "blocked by …" chip with every state in its title, and the readiness pill reads `blocked` |
| V13 | ruling 131(d): a held task costs nothing | live — JC-7: let the operator's scheduled and transition triggers fire | no operator run starts; a due schedule is retired with "Scheduled action skipped"; the stranded backstop never nudges; a manual run still answers and its prompt carries "THIS TASK WAITS ON OTHER WORK" and NOT "NEVER end your turn" |
| V14 | ruling 131(b): the operator records a wait instead of a packet | live — JC-9: resolve the standing packet with its recommended option | exactly one reactive turn runs, it reads the recorded wait and stops; no new hold packet is opened |
| V15 | ruling 131(e): Viberr releases the task itself | live — merge goal-1's links 2 to 4 (JC-3, JC-4, JC-6) | JC-7 and JC-9 clear their lists, lift the stored `blocked`, write the release note naming the three entries, notify their owners with a `dependency` row, and re-invoke the operator with `dependencies-released` |
| V16 | ruling 131(c): a chain-created task is born held | live — declare `blockedBy` on a goal-3 link through the controller, then let the chain reach it | the created task carries the list, is born `waiting: none`, and its `create` trigger is refused |
| V17 | ruling 131(b): a cycle is refused at declaration | live — declare goal-3 link 2 waiting on goal-5 link 2 and the reverse | the second declaration is refused by name with the cycle sentence, before either task exists |
| V18 | ruling 132: a base refresh is not unreviewed work | live — JC-11 (open PR #19): run `update_branch_from_base` from the operator, then open the accept dialog | the tool result and the merge-head row both read "base refreshed · 1 merge commit · N base commits · 0 authored commits since review"; nothing says "unreviewed"; `task.md` gains a `baseRefreshes` row with the merge sha |
| V19 | ruling 132: an authored commit still reads as drift | live — JC-13 (open PR #18): push one authored commit after the approval | every surface says "1 authored commit since review merges unreviewed", and the completion record says the same after acceptance |
| V20 | ruling 132: the operator and the ceremony agree | same runs | the operator's `get_task` drift and the accept dialog print the identical sentence |
| V21 | ruling 133: the engaged deliverer runs at any stage | live — JC-6 at Review with its deliverer scoped elsewhere: press Run, then @mention the same agent | both start; `task.agent.run_started` carries `stageEligibility: "engaged-deliverer"` only where the exemption was needed |
| V22 | ruling 133: a supporting engagement stays scoped, on both doors | live — @mention JC-6's QA tester at a stage its profile does not declare, and dispatch it | the comment posts with "run did not start: … A supporting engagement runs only at the stages its profile declares", and the dispatch gives the same sentence |
| V23 | ruling 133(b): the conflict packet offers only what can execute | live — provoke a base conflict on a task with NO delivering engagement | the packet recommends resolving by hand, names why in the body and in a "Delivering agent" observation, and the branch-update audit row carries `resolver: "none"` |
| V24 | ruling 133(c): the Agents surface states the rule | live — the Eligible stages panel for one restricted profile and one `spanAll` profile | the restricted panel carries both sentences; the `spanAll` panel carries the first and NOT the scoping clause, and never contradicts the "eligible everywhere" note |
| V25 | ruling 134(a): rework reaches the open PR | live — JC-6 (open PR #13) with a new local commit: the operator's `deliver_for_review` | the push moves PR #13's head, the timeline says "Pushed `<sha7>` to **PR #13** (was `<old7>`)", and the tool result names what moved; a second call answers "PR #13 already carries `<sha7>`" |
| V26 | ruling 134(a): the authenticated remote read works for real | same step, plus JC-5 | `ls-remote` runs under the askpass env on a private repository; `up_to_date` is reached without a push, and the run log carries no credential text |
| V27 | ruling 134(b): a moved head re-queues once | live — the same delivery under full autonomy | exactly one operator run with the `delivered` trigger; a subsequent `up_to_date` delivery starts none |
| V28 | ruling 134(c): a person can push, and is not offered a control that refuses | live — JC-5's task page (PR #4 closed, rework unpushed), then a diverged branch | JC-5 offers `Push a34a596 to PR #N` (or the Deliver control, PR #4 being closed) and pushing works; the diverged case shows the Unpushed row and a DISABLED control naming the refusal |
| V29 | ruling 134(c): the branch tool stops saying "nothing to do" | live — `update_branch_from_base` on JC-5 twice | the answer names the remote as behind by N and points at `deliver_for_review`; exactly ONE timeline event lands across the two calls |
| V30 | ruling 135: acceptance says "deliver", never "rebase" | live — JC-5: open the accept dialog while the revision is unpushed | the refusal names the unpushed revision and PR head, outranking the conflict sentence; the review queue keeps the row out of "Waiting on your acceptance" |
| V31 | ruling 135: the record reaches the page from a real reconcile | live — deliver a new revision on JC-13's branch (PR #18 open) and reload | `pr.unpushedRevision` appears in `task.md` within the run, not on the five-minute poll, and the page reads it |
| V32 | ruling 136(a): the collision ceremony ends with one hand-off | live — resolve a `resolve_remote_collision` packet on JC-5 | the branch is cleared, the work re-delivered, ONE operator run follows, and its prompt renders Viberr's outcome sentence separately from the human's note |
| V33 | ruling 136(b): a refusal that finds no collision does the work | live — the same option on JC-6, whose "collision" is its own open PR #13 | for a behind remote the block lifts and the delivery runs; the note never claims a stranger's branch was deleted |
| V34 | ruling 136(c): a cached open PR is re-confirmed | live — close a PR on GitHub, then within seconds confirm the collision packet | the delete proceeds, a fresh PR opens, ONE operator run follows and NO "needs a decision" notification is sent |
| V35 | ruling 137: an acceptance offer does not outlive its revision | live — JC-6: with the QA→Review accept card pending, commit a new revision, then open a packet | the card is withdrawn each time with a "Recommendation withdrawn" note naming the cause; a surviving `run_agent` card keeps its unread approval bell |
| V36 | ruling 138: a decided `edit_goal` packet reads as decided | live — JC-15's input packet: confirm the `edit_goal` option, then RELOAD | the card renders locked with "Decision made", one "Edit the goal" control opens the editor prefilled, the pill reads "goal edit pending", and the rail says a goal edit is owed |
| V37 | ruling 138: the draft is the goal, not an instruction | live — have the operator author an `edit_goal` option with `goalDraft` | the editor opens with the goal text; an option without `goalDraft` still prefills title + detail; `goalDraft` on another kind is refused |
| V38 | ruling 139: a bad grant is refused by name | live — ask the controller to grant `push`, then `commit-push-branch`, then a bogus stage | the first two answer `[error]` naming the id and listing the valid ones, and `project.md` is byte-identical; the real id answers `[done]` and the matrix shows it |
| V39 | ruling 139: the reads exist and match the roster | live — `list_capabilities` and `get_project` from the controller | the ids, the modes and the ABSENT-grant mode per kind are returned; `get_project`'s grants equal what the Agents page renders for the same deployment, including after a write in the same session |
| V40 | ruling 139: effort is settable and refused by name | live — set the four `jc-*` deployments to effort `max` through the controller, then try `max` on a Codex backend | the first lands and the Agents card shows it; the second answers `[error]` listing Codex's tiers |
| V41 | ruling 140(a): a named owner is seated before the first run | live — create a task through the controller with `owner:` another member | the first operator run's principal is that member (refused honestly if they have no credential); the audit says `seat: "named"`; `owner: none` is refused by name |
| V42 | ruling 140(b): the seat change is told | same step, plus a hand-off on JC-15 | the new owner holds one `ownership` notification naming the seat's meaning; the audit records whether they were told and why not when silenced |
| V43 | ruling 141: a scheduled re-run does not run into a packet | live — JC-10 or JC-12 (blocked packets open): schedule an operator re-run five minutes out | the occurrence is retired `fired` with "Scheduled action skipped", two audit rows (newest `skipped-packet`), no run, and no retry spent |
| V44 | ruling 141: a queued refusal is not silent | live — queue a scheduled trigger behind a live drive that then opens a packet | the task carries the drain-time note, and the occurrence is retired the same way |
| V45 | ruling 142: the agent's shell is clean | live — run an agent on JC-16 with an `env` probe in its prompt | `NODE_ENV` and `PORT` are absent, `VIBERR_*` declared knobs are absent, PATH/HOME/UV caches survive, and `npm test` behaves as in a plain shell |
| V46 | ruling 143: Insights counts delivered work | live — the Insights card with JC-7 held and branch-only | the denominator excludes JC-7; the subline reads truthfully |
| V47 | ruling 144: the workflow scope is disclosed and enforced | live — restore `ci.yml` on JC-6's branch and deliver with the current classic PAT | the push is refused BEFORE GitHub with the named remedy, a `workflow` violation opens on the task with the Grant / Re-check control named, and the credential card carries the advisory; after granting `workflow` and re-checking, the violation resolves and the push succeeds |
| V48 | ruling 144: an already-pushed workflow file does not block | live — a branch whose `ci.yml` is already on origin and whose new commit touches nothing under `.github/` | the push proceeds |
| V49 | every Band A ruling's unit half | unit — the canaried tests listed per item in TODO.md | each goes red on its stated canary and green with the fix |
| V63 | ruling 131(b), the OPERATOR leg: an operator records the wait itself, on BOTH backends (A13) | live — JC-16 under the Claude operator and a scratch task under a Codex-pinned operator: prompt each to record what its task waits on, then resume the Codex run so its persisted plan replays | each turn calls `set_dependencies` instead of opening a packet: the list lands in `task.md`, `task.dependencies.updated` is audited with `added`/`removed`, the tool answers `[done]` (an unchanged list `[noop]`, a bad reference the VALIDATOR's own sentence as a `noop`, never `denied`), the resumed Codex plan replays the step without re-asking, and neither task gains a hold packet. With `generate-packets` off the tool is not built on Claude and not offered in the Codex plan enum. The seeded `operator.definition.md` in the store carries the new sentence after an upgrade in place (its outgoing sha256 is in `PRIOR_SHIPPED_HASHES` first) |
| V64 | ruling 145: a delivery hand-off is decided by whoever the owner's Q34-14 answer names (A21) | live — on a task whose deliverer is engaged, have the operator call `run_agent {profileId: <another repo-write profile>, delivers: true}`, once under `full` autonomy and once under `recommend` | **answer (a)**: no hand-off runs; a `run_agent` card carries `delivers: true`, a maintainer's Apply performs it through `assignSpecialist` (the NEW deliverer's stage eligibility enforced, the hand-off event on the timeline), the `recommend` arm's own label and reason say a hand-off is being proposed, and the CURRENT deliverer's own `delivers: true` still runs directly. **Answer (b)**: the call is refused by name and nothing is engaged; the Execution profile's new human hand-off control performs the switch instead, recording the same hand-off event and audit row and refusing a profile that is not eligible at the task's stage. Whichever answer lands is the row that runs; the other is deleted with A21's unused half |

## Band B — correctness defects

| # | proves | how | expected |
|---|---|---|---|
| V50 | F34-3: a failed branch preparation is disclosed, once | live — break the project credential, then dispatch three delivering runs on one task | the FIRST dispatch writes one `github` timeline line and one `github.branch.prepare_failed` row; the next two write neither and only log; a missing credential or repository writes nothing at all |
| V51 | F34-9: an adoption is recorded | live — close JC-14's PR #15 and open a new PR by hand on the same head, then Update status | `task.md` switches to the new number, the timeline says "Adopted **PR #N**" naming the head and the PR it replaces, `github.pr.adopted` is in the audit log, and the notification title does NOT claim the PR is "live again" |
| V52 | F34-5: the Agents Live tab states what runs are doing | live — the Agents page with one run in flight and several idle engagements | only the engagement with a running row says working or coordinating and pulses; a queued run reads "queued"; a delivering engagement on an agent-waiting task with no run reads "on call"; the stat counts runs in flight |
| V53 | F34-7: a 1M-context model runs as itself | live — pin one `jc-*` deployment to `opus[1m]` and run a task | the run row and the SDK both carry `opus[1m]`; the Agents card labels it from the live catalog and does not flag it unknown on a cold process; reopening the editor does not rewrite the stored value |
| V66 | U34-3: a stale profile editor cannot silently revert a concurrent write | live — open the Agent profile modal on one deployment, change one capability on it from elsewhere (the controller's `update_agent_deployment`, or a second tab), then press Save in the first modal | the save is REFUSED by name ("This profile changed while the editor was open"), `project.md` still carries the other write byte for byte, no audit row is written for the refused save, and reopening the modal shows the current grants and saves cleanly; the controller tool's own read-modify-write in one turn is never refused by its own fingerprint |
| V54 | Band B unit halves | unit — `branch-sync.server.test.ts`, `github-reconciler.server.test.ts`, `pr-open.server.test.ts`, `agent-deployments.server.test.ts`, `agents-page.test.tsx`, `retired-vocabulary.test.tsx`, `claude-runtime.server.test.ts`, `model-catalog.server.test.ts`, `agents-route.server.test.ts` | each canary listed in TODO.md turns its case red |

## Band C — UI, copy, environment and docs

| # | proves | how | expected |
|---|---|---|---|
| V55 | U34-1: the console labels an error run as an error | live — the refused run from V7 | the result line reads `result · error · api 403 · api_error · 1 turns` |
| V56 | U34-6: the collision note explains both shapes | live — the note on JC-5 or JC-8 | it names both a PR opened after allocation and a pre-ruling-122 branch, asserts neither, keeps the "Branch name collision:" opening, and carries no em or en dash |
| V57 | U34-8: the collision dialog describes the right branch | live — open the confirm on JC-6 (`unownedPr: null`, PR #13 open) | the heading and rows describe THIS task's branch, never "squatting" or "the unrelated one", and a warn row says the delete is refused while PR #13 is open; the archive + deleteBranch dialog says the same |
| V58 | U34-5: an invite lands where it was aimed | live — invite a member as `maintainer` through the controller | one `project.member.invited` row with `role: "maintainer"`, no follow-up `role_changed`, and the reply names Maintainer; an unknown role answers `[error] Unknown project role.` with `project.md` untouched |
| V59 | U34-4: the Activity column keeps the instrument | live — make one change through the controller dock and the same change by hand, then read Activity | the two rows read differently (`<Name> (via the controller)` vs `<Name>`), the actor filter still lists one option for that person, and searching "via the controller" finds only the first |
| V60 | C6: the first pass is deterministic | unit — the promoted `hydration-determinism.test.tsx` with the UTC-midnight pair and re-imported modules | the two renders are byte-identical and `onRecoverableError` collected nothing; the item's canary (restoring `now`) fails the midnight pair. The four unguarded `formatCalendarDate` call sites render their UTC first pass in the same run |
| V65 | U34-2: the task page hydrates clean when hydration is INTERRUPTED | unit — `hydration-determinism.test.tsx`'s interrupted case (hydrate inside `startTransition`, exactly as `entry.client.tsx:5-12` does, and dispatch a discrete run-log update between the `hydrateRoot` call and the flush) over the two live shapes: a running run with a streaming console, and an `accept_completion` card at the acceptance boundary · plus the dev-server repro of the same two shapes | `onRecoverableError` collects nothing and no `#418` reaches the console; the dev-server run (unminified React, which prints the server and client text verbatim) shows no "Text content did not match" pair. Whatever text node the probe names is fixed at its source in this pass with its own canary, and the ledger row moves to `fixed` (C8) |
| V61 | D34-1: the runbook cannot lead an operator into the dual-writer hazard | unit + read — `runbook-db-read.test.ts` over `runbook.md` and `deployment.md` | no `sqlite3` invocation on the live projection file without `mode=ro`, the in-container read-only form appears first, and every in-container backup carries an explicit `--out` under the mounted root |
| V62 | the rendered copy gates, each over the roots it actually walks | unit — `app/features/copy-ban.test.ts`, `app.css.test.ts`, `file-formats-sync.test.ts`, `prd-sync.test.ts` | the DASH half (`copy-ban.test.ts:940-978`, `BANNED_DASH`, empty `DASH_ALLOW`) walks `app/features`, `app/routes`, `app/ui`, the four top-level render files and `app/server/seed/assets/**`, so A13's operator persona and A14's controller assets are gated for dashes and `app/server/**` is NOT; the `govern*` half (`:783`, `LITERAL_ROOTS`) walks `app/server`, `app/schemas`, `app/shared`, `app/lib` and `app/routes.ts` as LITERALS, which is what gates this pass's new server sentences (A6's `run-failure-remedy.server.ts`, A13's persona-adjacent strings, A20's packet options, A27's ceremony note). No new CSS outside the appended section; `blockedBy` and `baseRefreshes` appear in file-formats §2 |

## Gates

`npm run lint` (0 errors; the 2 pre-existing `require-yield` warnings in
`claude-runtime.server.test.ts` are the accepted baseline) · `npm run typecheck` ·
`npm test` (whole suite; the baseline delta on `main` is ONE deterministic failure,
`app/routes/resources.backend-login.test.ts:130`, environment-dependent, plus one
`controller-dock.test.tsx` flake) · `npm run build` · `npm run e2e` (Docker; the container must
not run against `docker-data` at the same time as a host dev server, and the writer lock refuses
anyway).

`npm run typecheck` is the repo's gate and a bare `tsc` is NOT a substitute: `package.json`
defines it as `react-router typegen && tsc`, `.react-router/` is gitignored (`.gitignore:14`)
while `tsconfig.json` includes `.react-router/types/**/*` and sets
`rootDirs: [".", "./.react-router/types"]`, and every route imports `./+types/<route>`
(`app/routes/_index.tsx:2`, `controller.tsx:3`, `insights.tsx:1`). Without the typegen step
`tsc` checks whatever generation happens to be on disk, which is stale for exactly the route
and loader changes this pass makes (A9's `set-task-dependencies` intent, A10's run control,
A24's push control).

The seeded-asset edits in A13, A19, A23, A26 and A14 each require the OUTGOING sha256 in
`PRIOR_SHIPPED_HASHES` before the file is rewritten, or the shipped-asset gate goes red and every
existing store stays on the old text.

## Canary rule

Every test added this pass must be shown red without its fix. A test that cannot go red is not a
gate — ruling 65's lesson, pass 32's ("a test that reads `git show HEAD:<file>` goes vacuous once
the change is committed; assert the MECHANISM"), and this pass's own three additions:

1. **A canary that only a deliberate hardcode can trip is not a canary.** Assert a value the
   mechanism computes (`remoteHeadBefore`, `stageEligibility`, `whenUngranted`), never a field that
   is constant by construction.
2. **A canary that is a typecheck error is not a canary.** `satisfies Record<…>` tables and required
   interface fields fail `npm run typecheck`, not `npm test`; pick an edit that a green typecheck
   still allows (A30's `deriveDisplayReadiness` branch, not the `READINESS_DISPLAY` row).
3. **A fixture the test hand-builds proves nothing about the projection that must fill it.** Where a
   surface depends on a recorded fact (A24's push control, A25's queue row, A33's `get_project`),
   one case must drive the record end to end through the real writer.
