# Pass 34 — findings ledger (Viberr builds a Jira clone)

Ids: `F34-*` defect · `U34-*` UX/coherence · `D34-*` doc/canon · `G34-*` gap ·
`Q34-*` question for the owner. Status: `open` → `confirmed` / `refuted` → `fixed`.
Only findings that make Viberr lie, lose work, block a path with no way out, or make a
real person do something absurd get an `F`; cosmetic items are not filed.

| id | area | severity | status | one line |
|---|---|---|---|---|
| F34-1 | run failure classification / controller | high | confirmed (two provider sentences missed) | A Claude 403 `oauth_org_not_allowed` ("Your organization has disabled Claude subscription access for Claude Code") is classified `run·error·unknown` ("Review the runtime configuration"), and the controller's failure note tells the person to "Say it again to retry" — a retry that fails identically. The SDK envelope carried `error: oauth_org_not_allowed`, `api_error_status: 403`, `terminal_reason: api_error`; the kind should be `auth` and the remedy is the person's own Profile → Agent accounts (a different account or an API key). |
| F34-2 | controller toolkit / grants | high | confirmed (grants landed only by the model's brute-force guessing at 09:21Z; the controller itself could never confirm them) | `update_agent_deployment` accepts capability ids that do not exist (`branch`, `commit`, `push`, `open_pr`, `verdict`, `browser`), drops them silently and answers `[done] <agent> updated`. The controller then told the person all four new agents hold "branch/commit/push/PR direct" (and the reviewer a verdict, the tester a browser) — on disk every one of those grants is `off`. No read tool exposes capability ids, so the model cannot discover the real names either. Same class as F33-8 (grant keys), one tool over. |
| G34-2 | GitHub scopes | high | confirmed | A classic PAT without the `workflow` scope cannot push a branch that adds `.github/workflows/*.yml` — GitHub rejects the push ("refusing to allow a Personal Access Token to create or update workflow … without `workflow` scope"). Viberr's required scopes are exactly `repo` + `pull_request:write` (2026-07-25 ruling), the attach-time probe never checks `workflow`, and the failure opens no scope violation and no chip: it reached the person only as the operator's `block_on_policy` packet after the JC-6 scaffold (which includes CI, as the controller's own KB demands) had been stranded twice for other reasons. The first attempt never even pushed (F34-11), so the true cause surfaced 25 minutes late. |
| G34-3 | controller toolkit | medium | confirmed | `create_task` takes no owner, due date or urgent flag, so the controller creates the task under the caller and patches it afterwards (`update_task {dueDate}`, `set_task_owner`). Ruling 127 makes the owner the credential principal and triage starts on creation: JC-15's first operator run started on Arda's Claude credential 1.2 s after creation, 3.6 s before the handoff to Omar landed. A task meant to run on Omar's account, and to be refused if he has none, ran once on the creator's. |
| G34-1 | controller toolkit | medium | confirmed | The toolkit has no way to set an agent's or the operator's **effort** (`save_global_agent` has no model/effort/grants at all; `update_agent_deployment` has model but not effort). The controller reported it honestly ("there is no effort setting anywhere … exposed to me"). The owner's standing rule is fable at max, so every controller-built deployment runs at the template default `high`. |
| F34-4 | delivery / empty repository | high | confirmed | Delivering into an EMPTY repository: the push succeeds (GitHub silently makes the task branch `jc-1` the repository's default branch), the PR open fails because the base `main` does not exist, and Viberr reports **"GitHub was unreachable (network error). Fix the repository/credential settings"** on the tool result, the timeline, the audit and the task page; the operator dutifully opens a "Restore GitHub connectivity" packet. GitHub was reachable throughout. No surface names the real cause and no path exists to create `main`: Viberr can never bootstrap an empty repo. Folds F34-3 (the silent `default_branch_missing` at dispatch). |
| F34-3 | delivery / branch allocation | high | confirmed (folded into F34-4) | On an EMPTY repository (no default-branch ref) the pre-dispatch branch allocation fails with the typed `default_branch_missing` and every caller swallows it: no audit row, no timeline note, `branch: null`, the deliverer is told `branch: ""`. Nothing on any surface says the repo cannot take a task branch yet. Filed pending the delivery attempt. |
| F34-11 | operator delivery with an existing PR | high | confirmed (twice) | `operatorDeliverForReview` treats a cached open `pr.state` as "nothing to deliver" and never pushes. Live chain on JC-3 (11:33–11:45Z): the deliverer resolved the base conflict locally (385047c) and wrote "over to you to push 385047c … PR #10's head is still 6004958"; the operator called `deliver_for_review` → "nothing to deliver, PR #10 open for review", read "No push was pending", and ran JC Reviewer on the LOCAL revision; the verdict and the accept card bound to 385047c; GitHub's PR #10 head stayed 60049586 (CONFLICTING/DIRTY); the accept dialog refused with "conflicts with the base branch … Rebase the branch and re-review, or archive the task" — the wrong remedy for a branch that is resolved and merely unpushed. `update_branch_from_base` reported `already_current` for the local branch twice. The human "Deliver branch & open PR" button is hidden while a PR is recorded, so no surface can push. Earlier form: #7/#9 had to be closed by hand for the same reason. |
| F34-10 | packets / collision resolution | medium | confirmed | A SUCCESSFUL `resolve_remote_collision` (branch deleted, unowned PR #8 closed, PR #9 opened) leaves the task `readiness: ready · waiting: human` with no packet, no recommendation and no operator re-queue — the same stranding F33-4 fixed for the refusal arm, now on the success arm. The person is told a human is awaited and nothing says what. (JC-8, 10:22:45Z.) And the REFUSE arm strands too when the refusal is "PR still open on the branch": JC-6 at 10:33:06Z was left `readiness: blocked · waiting: human` with no packet and no operator re-queue — F33-4's fix did not reach this refusal. |
| F34-8 | schedules | medium | confirmed | A scheduled operator run that fires while a decision packet is open is recorded as `status: fired` with a timeline note "Scheduled action starting: running the scheduled operator re-run …", then the queued trigger is re-fired as `manual` and refused by the open-packet rule ("manual operator run refused — a decision packet is open") — server log only. Nothing on the task says the run never happened; the person reads "fired" and "starting" and waits for a report that will never come. (JC-2, 10:02:47Z.) |
| F34-9 | PR adoption / record | medium | confirmed | The reconciler adopted a human-opened PR (#6, same head as the delivered revision) after the task's own PR (#5) was closed: `task.md` `pr:` switched from #5 to #6 with NO timeline event and NO audit row naming the adoption — the timeline still reads "Opened PR #5 for review". Files-are-truth: the record cannot explain how the task came to reference a PR it never opened. (JC-4, 10:05:19Z.) |
| F34-7 | model resolution | medium | confirmed (code) | The Claude catalog offers `opus[1m]` ("Opus (1M context)") and the profile/run row store it, but `resolveClaudeModel` maps any string containing `opus`/`sonnet`/`haiku` to the bare alias, so the `[1m]` context variant is dropped before the SDK sees it. Live: the JC-2 operator run row says `model=opus[1m]`; the process got `opus`. Only the dated-id path (`claude-fable-5[1m]`) passes the suffix through. The person picked a 1M-context model and is told they run one. |
| F34-6 | workspaces / delivery | high | confirmed | A task's delivering workspace is cloned ONCE (here by the operator's first triage at 09:00Z, when the repository was empty) and every later run REUSES it without refreshing from the project mirror; agents hold no credential so they cannot fetch either. At 09:28Z the mirror already carried `main`, `jc-2`…`jc-5` (all at `d2e0fb0`), the operator read `main` through the mirror and told the spec writers "main is bootstrapped", and the spec writers found ZERO commits in their checkouts and committed **unrelated root commits** on `jc-2`/`jc-5` (JC-3/JC-4 still empty). Two sources of truth in one task: the operator's anchored read and the deliverer's checkout disagree. |
| F34-5 | agents page / live tab | medium | confirmed | The Agents **Live** tab labelled the stock Developer "delivering · **working**" on JC-1 and counted it among "5 agent threads in a working state" at 09:30Z, when the Developer's run had finished at 09:11Z and only the OPERATOR was live on JC-1. `agent-deployments.server.ts` `primaryStatus(waiting)` returns `working` whenever the task's `waiting === "agent"` — a display flag the docs themselves say is not proof ("`liveRuns` is the only proof a run is in flight", ruling 91's family). Any operator turn on a task with a delivering engagement shows that specialist as working. |
| F34-12 | recovery packet defaults | high | confirmed | The generic "blocked" packet the operator opens when its own run dies uses a fixed recommended option titled "I've updated the policy / credential — unblock and re-run" (`defaultPacketOptions`, `operator-run.server.ts:1855`). On a quota failure nothing about policy or credential is wrong, but confirming the recommended option records "policy/credential updated" as the human's statement: the JC-6 operator told the JC Developer the workflow-scope block was lifted, the Developer restored `.github/workflows/ci.yml` "now that the delivery token carries workflow scope", the push was rejected for the same missing scope, and the owner's explicit "ship without CI" decision (Q34-10) was undone by a packet label. |
| F34-13 | edit_goal packet after reload | medium | confirmed | Confirming an `edit_goal` option records the decision, stamps `packet.awaiting: goal_edit` and opens the goal editor in the SAME page session only. Navigate away or reload and the card renders exactly as before ("Awaiting a human decision", every option selectable, "Confirm decision" live); confirming again is refused with a 409 that only a transient toast shows; the card, the readiness pill ("input required") and the sidebar never say "decision made — save the edited goal to clear it". The way out (the goal's Edit button) is undiscoverable from the packet. `awaiting` is not rendered anywhere in `app/features/task-detail`. |
| F34-14 | revision drift / acceptance disclosure | high | confirmed | The acceptance dialog, the review-queue subline and the permanent completion record count a base refresh as unreviewed work: after the operator merged `main` into the approved branch (JC-3, JC-8: `github.branch_update.operator {commits: 4}`), the reconciler's compare `reviewedSha...head` reports `aheadBy: 5` and the person reads "5 commits added since review; they merge unreviewed" — 4 of them are main's own already-merged JC-4 commits and the 5th is the merge commit. The operator's own drift read of the same state said `null` ("the base merge shipped no unreviewed authored work"), so Viberr contradicts itself at the one ceremony that must be honest, and JC-8's timeline now permanently says "5 commits were added to the PR head after the review, outside the reviewed revision". |
| F34-15 | stale accept card | medium | confirmed | An "Accept completion and move JC-3 to Done · The review is clean and the work meets the goal" card stays on the task page after the deliverer commits a NEW revision (1215ab44, no verdict) and after the operator opens a blocked conflict packet on top of it. Only a reviewer verdict with non-healthy validation, a stage move, archive or acceptance drops it (`task-actions.server.ts` 2976/4754/6055/6452/8199); a new work revision and a packet do not. The dialog behind Apply refuses ("BLOCKED · awaiting verdict") and the review queue says "0 waiting on your acceptance", so nothing merges — but the task page shows a maintainer a green "review is clean" offer that is false. |
| F34-16 | conflict packet vs stage eligibility | high | confirmed | Viberr's built-in "branch conflicts with main" packet recommends "Have the delivering agent resolve the conflict" with no check that the deliverer can run at the task's stage. On JC-3 (Review) the JC Spec Writer is scoped to Backlog + Design, so the human's recorded decision could not execute: `prompt_agent` was refused by `assertStageEligible`, the operator had no rework stage to route through, and a SECOND packet asked the human to widen the profile's stages or walk the task back to Design "then forward through QA and Review again with no new work to do". Meanwhile a human @mention of the same agent at the same stage DID run it (11:18Z — `resumeRun` has no stage check; only `assignSpecialist`, `assignReviewer` and `dispatchAgentRun` do), so the product enforces eligibility for the operator and not for the person. |
| U34-4 | activity page / audit column | medium | confirmed | The Activity page's audit column renders `arda@viberr.dev · via controller` rows as "Arda updated agent profile JC QA Tester" — identical to the rows the same person wrote by hand in the Agents UI two minutes later. The instrument disclosure the audit row carries (ruling 99: "audit rows disclose the instrument") is dropped by the compacted rendering, so a reader cannot tell the controller's twelve blind grant writes from the owner's four deliberate ones. |
| U34-5 | controller toolkit | low | confirmed | `invite_member`'s description says "new members join as contributor"; the audit rows say `project.member.invited {role: viewer}` for all three invites. The controller caught the mismatch from the tool result and corrected the roles with `set_member_role`; a model that trusted the description would leave a maintainer as a viewer. |
| U34-6 | collision copy | low | confirmed | The branch-collision note asserts a cause ("a task key is reused … only reaches a task whose branch was recorded before ruling 122") that does not hold when an unowned PR appears on a branch AFTER Viberr allocated it; the remedy it names is right, the explanation is not. |
| U34-7 | run environment | medium | confirmed | The agent's shell inherits Viberr's own process env: `NODE_ENV=production` and `PORT=5173` (the container's) were visible inside the JC-6 Developer run (`env` probe at 10:21Z/10:23Z) and broke `vitest` and `next start` until the agent unset them — every JavaScript project's tooling will trip on the host app's NODE_ENV/PORT. `filteredSpawnEnv` strips credential-shaped keys and the vendor homes but passes the server's runtime settings through. |
| U34-8 | packet collision dialog copy | medium | confirmed | When the operator authors `resolve_remote_collision` on a task with NO recorded unowned PR (JC-6, `unownedPr: null` — it used the option as the only way to push stranded commits), the "Packet collision dialog" still calls the task's OWN branch and PR "the stale branch jc-6 on GitHub, the unrelated one squatting on this task's branch name" and promises "the real review PR opens" — F33-3's copy defect in a new doorway: the dialog describes a collision that does not exist and the person confirms the deletion of their own PR under that description. |
| U34-1 | run console | low | open | The same failed run's console prints `result · success · 1 turns` one line above `run·error·unknown`: the SDK result envelope says `subtype: success` with `is_error: true`, and the wire projector trusts the subtype. |
| U34-2 | task page hydration | low | confirmed (2 sightings) | React error #418 (`args[]=text`, a text-content hydration mismatch) on the task detail page: once as Arda during the live run at ~10:3xZ, once as Maya on JC-4 at 11:07Z while an accept_completion card was showing. The page recovers by client re-render, so nothing is lost, but the console error is real and the pass-8 hydration fixes (absolute-UTC first-pass grouping) do not cover whatever text this is. |
| U34-3 | agents page / profile editor | medium | confirmed (code, 2026-09-04) | The Agent profile modal is a FULL-form submit and the save is last-write-wins on the whole governed grant set: `updateAgentProfile` rebuilds `deployment.capabilities` from the submitted form inside the writer callback (`app/features/agents/agent-profile-actions.server.ts:665-672`), the modal seeds its `caps` once at open time (`create-profile-modal.tsx:279-310`), and the `update-profile` intent (`app/routes/project.agents.tsx:205-227`) carries nothing that says which version the editor read. A modal opened before a concurrent write and saved after it silently reverts every grant that write changed, and still reports "Profile updated" and audits a successful save. Noticed live at 09:12Z while the controller was writing the same deployments (NOTES 09:12Z; the id was reserved there and is filed now, because pass 34's A32-A34 make the controller's writes land for real). |
| U34-9 | insights copy | low | note only | "Branch & PR traceability · 7 of 8 delivered tasks carry branch + PR" counts every task with any footprint (revision, branch OR PR) as "delivered"; JC-7 had only its allocated branch and had never delivered. The definition is documented in `OversightSummary.traceability`; the rendered label is what lies. |
| U34-10 | edit_goal draft | low | confirmed | Confirming an `edit_goal` option prefills the goal editor with the option's title + detail verbatim (`goalDraft`). When the operator authored the option as a proposal ("Rewrite the goal to match search.md exactly: …", JC-9) that is a usable draft; when it authored it as an instruction ("Confirming opens the goal editor: replace … I deliver straight after", JC-6) the person is handed an instruction as the goal. The operator prompt never says the detail becomes the draft. |
| U34-11 | ownership handoff | medium | confirmed | Handing a task to another person (`set_task_owner` via the controller; the same path as the task page's hand-off) writes the audit row and the `assign` timeline event but sends the new owner NO notification. Under ruling 127 the new owner is the credential principal and the acceptance authority; Omar learned he owned JC-15 only from the failure packet that his missing Claude credential produced 2 minutes later (that packet DID notify him). |
| D34-1 | docs / runbook | medium | confirmed | `docs/operations` runbook (~line 197) tells an operator to read the projection DB from the host with `sqlite3` while the container runs. Doing exactly that during this pass (host `sqlite3` polling over VirtioFS) preceded the container's SIGBUS crash at 09:12:46Z (exit 135); the memory file `docker-data-dual-writer-hazard` and ruling F18-5 already say one process per data root. The runbook must say "never read the live DB from the host; use `docker exec … node -e` with `readOnly: true`" and show that command. |

## Detail

### F34-1 — a per-person auth refusal is "unknown" and the remedy offered is a retry

Run `run_s2xLJ0-4tkwT` (controller, `claude-fable-5[1m]`, 08:00:02Z). Raw NDJSON:
the assistant line carries `"error":"oauth_org_not_allowed"`, `"is_api_error_message":true`;
the result line `"is_error":true`, `"api_error_status":403`, `"terminal_reason":"api_error"`,
`"subtype":"success"`. Display: `run·error·unknown` with the generic sentence. Transcript
note: "I could not finish this turn: the run did not complete. The provider reported: …
Say it again to retry."

Why it matters: ruling 127 made the credential the PERSON's; the one remedy is on their
Profile. The Agent accounts panel keeps saying `connected · verified Sep 3` (the probe is
presence-only by design), so nothing in the product tells the person their connected
account cannot run Claude Code. A task-run failure of this kind would open the stuck-loop
packet WITHOUT `retry_other_backend` (offered only for `quota | auth | unavailable`).

Root cause (`app/server/runtimes/claude-runtime.server.ts`, `classifyClaudeError`): the
classifier regex-matches the provider SENTENCE only (`unauthor|forbidden|…|\b401\b|\b403\b|
authenticat…`). The sentence here contains none of those words; the structured facts
the SDK put beside it — `api_error_status: 403`, `error: "oauth_org_not_allowed"`,
`terminal_reason: "api_error"` — are never read. Status: **confirmed**.

**Second form observed live (10:47Z):** the five-hour session limit killed six runs at once. Each run log carries a structured `meta · rate_limit_event` line (`rate limit · five_hour at ?`) right before the failure, so the runtime has the signal and still says `run·error·unknown`; the reset time is not parsed (`at ?`). The provider banner "You've hit your session limit · resets 11am (UTC)" was posted verbatim as an agent **comment attributed to the specialist** (JC-7 spec writer, JC-8 QA tester; audit `task.agent.replied`), and the specialist-failure packet recommends "Redirect with sharper guidance" / "Review the runtime configuration.." (double period) as if the agent had done something wrong. The operator-failure packet recommends "I've updated the policy / credential — unblock and re-run" when nothing about policy or credential was wrong. Remedy the person actually had: wait until the reset or switch account (Q34-7). See NOTES 10:47Z.

### F34-2 — `update_agent_deployment` accepts anything and says "done"

Root cause: `app/features/agents/agent-profile-actions.server.ts` `caps: z.record(z.string(),
modeSchema)` and `grantsFor` iterates the CATALOG defaults, reading `caps[id] ?? def` — a key
that is not a catalog id is never looked at. The controller tool builds `caps` from the stored
grants plus `args.capabilities` verbatim and passes it on; nothing between the model and the
writer names the unknown id. The tool also declares no `effort`, and an `effort: "max"`
argument the model tried later was stripped by the schema with the same `[done]`.

What it cost live (09:05Z–09:12Z, one controller turn): the model, told by the human which
Agents-page labels were off, could not find the ids from any read (`get_project` lists agents
without grants, `list_global_agents` lists resource grants only), so it (1) read the audit log,
(2) read four run logs through `viberr_ops` looking for id vocabulary, (3) spent TWO
"verification pass" operator runs on JC-1 because the operator's `get_task` snapshot exposes
resolved flags (`delivery/verdict/browser/effort`), (4) tried the flag names as ids, and
finally (5) SHOTGUNNED ten guessed slugs per call. Four guesses matched
(`execute-code-or-write-repo`, `commit-push-branch`, `open-review-pr`,
`report-validation-verdict`), two did not (`create-task-branch` was guessed as
`create-task-key-branch`; `use-browser` as `drive-a-live-web-browser`/`use-live-browser`), so
the QA tester still cannot drive a browser and no jc-* agent may create its branch, while the
tool answered `[done]` twelve times.

Fix shape: validate `capabilityId` against `UNIFIED_CAP_CATALOG` (specialist ids for
specialists, operator ids for the operator) and refuse unknown ids BY NAME listing the valid
ones (the F33-8 pattern); reject unknown arguments; add `effort` (catalog-clamped); and make
`get_project` (or a new read) return each deployment's resolved grants so the model can read
before it writes.

### F34-4 — an empty repository turns into "GitHub was unreachable"

Sequence on JC-1 (09:13:50Z operator, 09:14:02Z operator retry, 09:17:28Z the human's own
**Deliver branch & open PR** press — three identical outcomes):

1. Pre-dispatch `ensureTaskBranch` → `GET git/ref/heads/main` 404 → typed
   `default_branch_missing` → swallowed by `ensureTaskBranchBestEffort` (no audit, no
   timeline, `branch: null`, `run·inputs branch: ""`). (F34-3)
2. `pushWorkspaceBranch` pushes `HEAD:refs/heads/jc-1` — succeeds (`pushed workspace branch
   to origin … commitsUnknown: true`). GitHub, receiving the first ref of an empty
   repository, makes **`jc-1` the repository default branch**. Nothing pushes `main`; the
   Developer's local `main` (the bootstrap root commit) stays in the workspace forever.
3. `openTaskPr`: the live compare `main...jc-1` 404s (falls back silently), then
   `POST /pulls {head: jc-1, base: main}` → **422 `{"resource":"PullRequest","field":"base",
   "code":"invalid"}`** — GitHub sends no `message` on that error row, so the 422 arm's
   `reasons` is empty, `detail` is the bare "Validation Failed", neither regex matches, and
   the residual arm returns `status: "network_unavailable"`.
4. `performDelivery` renders `network_unavailable` as **"GitHub was unreachable (network
   error)"** and appends "Fix the repository/credential settings, then deliver again." to the
   timeline; the audit row is `github.delivery.operator {status: failed}`; the operator
   opens a blocked packet titled "Delivery blocked — GitHub unreachable (2 attempts)" whose
   recommended option is "Restore GitHub connectivity, then resolve — I re-deliver" and whose
   alternative is "Hold runtime to debug GitHub access". Meanwhile the reconciler wrote
   `github.reconcile.task {sync: synced}` at 09:12:48Z, 09:17:36Z and 09:17:48Z — GitHub
   answered every one of them.

Three lies at once: the cause (network — it is a missing base branch), the remedy
(credential settings — nothing is wrong with them), and the state (the packet says
"nothing pushed" while `jc-1` is on GitHub and is now the default branch). And there is no
path out: no surface can create `main`, the project keeps `defaultBranch: main`, and every
future task will fail the same way until a human pushes to the repository by hand — the
one thing this exercise forbids.

Fix shape (product): (a) map the 422 `base invalid` (and the pre-dispatch
`default_branch_missing`) to a typed `default_branch_missing` delivery outcome with an
honest sentence; (b) make `ensureTaskBranchBestEffort` record a timeline/audit line when the
base is missing; (c) bootstrap the default branch when it does not exist — either create
the default branch from the pushed task head through the Git Data API (an orphan initial
commit Viberr authors, e.g. `README.md` naming the project) BEFORE creating the task ref,
or, at delivery time on a repo with no default ref, treat the first delivery as the
bootstrap and disclose it. Recorded as an owner question (Q34-2).

### F34-1 addendum — the session-limit refusal is also "unknown"

09:40:28Z–09:40:42Z three operator runs (JC-2, JC-3, JC-4) ended with the provider sentence
**"You've hit your session limit · resets 11:50am (UTC)"** and every one was classified
`run·error·unknown` ("Review the runtime configuration") — `classifyClaudeError`'s quota
regex is `usage limit|quota|rate limit|too many requests|\b429\b`, and "session limit" is
none of those. Consequences seen live: each task got the generic "Operator run failed — pick
a recovery path" packet (`block_on_policy` / `redirect` / `hold_runtime_debug`) instead of the
quota story; `backendQuotaExhausted.claude` was NOT recorded (only the separate
`rate_limit_event` envelope flipped `backendRateLimit.claude` to `rejected`), so Insights does
not say "usage limit reached … resets 11:50" and nothing tells the person that every Claude
run will fail for the next two hours. A quota refusal that the product cannot name is a
person told to "review the runtime configuration" three times in fourteen seconds.

### F34-5 — second reading (10:14Z)

Live tab rows vs `agent_runs.state = running`:

| row on the Live tab | reality |
|---|---|
| JC Spec Writer · JC-4 · delivering · **working** | no run; the spec writer finished 09:59Z |
| JC Reviewer · JC-4 · supporting · **anchored · on call** | RUNNING since 10:09Z (the required reviewer) |
| JC Developer · JC-5 · delivering · **working** | no run; finished 10:07Z (an operator is live) |
| JC Spec Writer · JC-3 / JC-8 · working; JC Developer · JC-6 · working | correct |

`primaryStatus` reads the task's `waiting`, and `reviewer` engagements are hard-coded
"anchored · on call" (the module comment says so) — a supporting run that IS live is shown
idle while a deliverer that is NOT live is shown working. The counts card above the table
("agent threads in a working state") inherits both errors.

### F34-11 — detail

`operatorDeliverForReview` (operator-actions.server.ts ~2483-2495) reads `task.md`'s cached
`pr.state` and answers `noop` for anything not `closed`/`merged` — before `performDelivery`
would push. Two consequences seen live:

1. New local commits on a branch with an open PR are never pushed (JC-6: the whole
   scaffold; JC-8: the CONTRIBUTING.md implementation; JC-5: the reviewer-requested rework).
   The task page hides **Deliver branch & open PR** once a PR exists, so the human has no
   push either. The operator's only packet options were `resolve_remote_collision` (which
   then refuses because the PR is open — F34-10's refuse-arm stranding) or holding.
2. The pre-check trusts the CACHE: after the PR was closed on GitHub, the operator still
   answered "PR #9 is already open for review" until a reconcile rewrote `pr.state` — so the
   workaround itself (close the PR, re-deliver) needs a manual Update status first.

Fix shape: delivery must compare the local head with the PR head (or `origin/<branch>`) and
push when the branch is ahead, reusing the open PR (GitHub updates it on push); the noop is
right only when nothing is ahead. The human control should be offered whenever the local
branch is ahead of the remote, PR or no PR. The pre-check should consult the live PR state
(or at least treat a cached `review` as advisory).


**Live chain (11:33–11:45Z, JC-3):** conflict packet resolved → JC Spec Writer merged main and resolved `docs/specs/README.md` locally (385047c) and said so ("over to you to push") → operator: `update_branch_from_base` = `already_current` (local), `deliver_for_review` = "nothing to deliver, PR #10 open for review" (no push) → JC Reviewer approved 385047c from the support workspace → operator posted accept_completion "The review is clean" → Maya's accept dialog: REVISION 385047c · BLOCKED "JC-3's review PR #10 conflicts with the base branch … Rebase the branch and re-review, or archive the task" (`task-actions.server.ts:5814`) — GitHub's head is still 60049586. Every Viberr surface believed the work was delivered; only GitHub knew it was not. The verdict binding (F15-15's fix) is to the workspace revision, so it cannot notice that the PR head differs.

**Fix direction:** `deliver_for_review` with an existing open PR must compare the workspace head with the PR head and PUSH when they differ (then say "pushed 385047c to PR #10"); the accept gate must distinguish "PR head ≠ delivered revision (unpushed)" from a genuine merge conflict and offer "push the delivered revision"; the human Deliver button must stay available for that case; `update_branch_from_base` must report the REMOTE state too.

### F34-12 · The failure packet's default option asserts a fact the human did not state

**Seen:** 10:47Z six runs died on the provider's five-hour limit; each operator opened the generic blocked packet whose recommended option reads "I've updated the policy / credential — unblock and re-run" (the only sensible choice once the window reset). On JC-6 the operator's next run read that resolution as a credential change: its notification to the Developer said "@Arda resolved the decision packet: policy/credential updated, JC-6 unblocked. The only credential that ever blocked this task is the delivery token's missing GitHub workflow scope"; the Developer restored `.github/workflows/ci.yml` (commit be3e4fd, message "now that the delivery token carries workflow scope"); the operator's base-merge push was rejected again (`refusing to allow a Personal Access Token to create or update workflow … without workflow scope`, audit `github.branch_update.operator {status: update_failed}`), and a second packet opened ("JC-6 still blocked — delivery token lacks GitHub workflow scope") whose honest cost line says "this is the third time the file moves".

**Why it matters:** the packet is the human's recorded statement. A default label that says "I've updated the credential" on a failure that had nothing to do with credentials makes the person assert something false with the recommended click, and every downstream agent is entitled to believe it. Here it reverted an owner decision and burned a Developer run plus an operator run.

**Root cause:** `defaultPacketOptions("blocked")` in `app/server/runtimes/operator-run.server.ts` is failure-agnostic; the operator-run-failed path never tailors the options to the classified cause (and F34-1 means the cause is `unknown` anyway). The resolution text the operator receives ("policy/credential updated") is derived from the option title.

**Fix direction (with F34-1):** classify quota/auth refusals; on a quota failure the packet's recommended option must be "The window has reset (or I switched account) — re-run" with the reset time, and the resolution text must say that, not "credential updated". Keep "I've updated the policy / credential" only for `policy`/`credential` classifications.

### F34-13 · An edit_goal decision is invisible after a reload

**Seen:** JC-9 (11:12Z). Confirmed "Align JC-9 to the merged spec" (kind `edit_goal`). Audit `task.packet.resolved`, timeline "Waiting for the edited goal; the packet clears as soon as it lands", `packet.awaiting: goal_edit`. The goal editor opened prefilled — then the page was left. On reload: the card said "Decision required … Awaiting a human decision", all three options were selectable with the operator pick pre-selected, "Confirm decision" was live; clicking it produced a 409 ("This decision was already made on JC-9. The packet is waiting for the edited goal") that surfaces only as a toast (`useActionFeedback`), the readiness pill still said "input required", and nothing pointed at the goal's Edit button. Saving the goal through that button cleared the packet (`updateTaskGoal`), so the mechanism works; the surface hides it.

**Root cause:** `packet.awaiting` is written by `resolveDecisionPacket` (`task-actions.server.ts` ~6726) and honoured by `updateTaskGoal` and the operator (`operator-actions.server.ts:2065`), but no task-detail component reads it: `DecisionPacket` renders every packet as undecided, and the goal editor opens only from the in-memory `resolveFetcher` result (`task-detail-page.tsx:243-258`).

**Fix direction:** render an `awaiting: goal_edit` packet as decided (option locked, "Decision made — save the edited goal to clear this" with a button that opens the goal editor prefilled with the chosen option's deliverable), and make the readiness pill say "goal edit pending".


### F34-14 · Base-refresh commits are reported as unreviewed drift

**Seen:** JC-3 (11:16:55Z) and JC-8 (11:11:13Z): the operator's `update_branch_from_base` merged 4 commits from `main` (PR #6's JC-4 work + its merge) into the task branch, creating one merge commit each (`60049586`, `cf97e5d2`). The reviewer's approve verdict is pinned to the delivered revision (`6548677`, `c3efdbe`). The reconciler then set `pr.revisionDrift = {aheadBy: 5}`; the accept dialog showed "MERGE HEAD 60049586cfc4 · 5 commits added since review; they merge unreviewed", the review queue would show the same, and JC-8's acceptance wrote "5 commits were added to the PR head (cf97e5d2a6e4) after the review, outside the reviewed revision" into the timeline. The JC-3 operator, reading the same task through its tool, reported "`revisionDrift` re-reads as null afterward, so the base merge shipped no unreviewed authored work and the approve verdict pinned to 6548677c still stands" — and recommended acceptance without mentioning drift. Screenshots 61–62.

**Why it matters:** the maintainer is told that five unreviewed commits will merge when zero authored commits did; a careful maintainer sends the work back for a second review of a merge commit, a trusting one learns to ignore the disclosure — which is exactly the disclosure that must never be ignored (R17-1). The JC-4 operator avoided refreshing for this very reason ("that would put a merge commit on the approved head and create unreviewed drift"), so operators are already routing around the metric.

**Root cause:** `github-reconciler.server.ts` ~464–486 measures drift with GitHub's `compare(reviewedSha...head).ahead_by`, which counts every commit reachable from the head and not from the reviewed sha — including everything a base merge brings in from `main`. The operator's tool reads `fm.pr.revisionDrift` at a different moment (before the reconciler's next pass), which is why the two disagreed.

**Fix direction:** define drift as *authored* commits since the reviewed revision: commits in `reviewedSha..head` that are not reachable from the base branch and are not merge commits whose tree equals the merge of their parents (a conflict-resolving merge counts). Report base refreshes separately ("base refreshed · 1 merge commit · 0 authored commits since review"). Give the operator's read and the ceremony the same function, and make the completion record use the same words.


### F34-15 · The accept-completion card outlives the revision it was written for

**Seen:** JC-3, 11:17–11:24Z. Operator posts accept_completion at 11:17:23 (verdict approve on 6548677). Maya's comment sends the spec writer back; it commits 1215ab44 (11:19:22, `workRevision` moves, validation `changed`). The operator's base refresh then conflicts and opens a blocked packet (11:22:5x). Through all of it the card stands (`recommendations: [accept_completion]`), rendered above the packet with its "review is clean" copy (screenshot 64). Clicking Apply opens the dialog, which correctly says "VERDICT awaiting verdict · BLOCKED Waiting on 1 required reviewer approval of the current revision"; the review queue correctly counts 0 waiting on acceptance.

**Root cause:** the accept card is dropped when a verdict lands with `validation !== "healthy"` (`applyAgentOutcome`, ~2976), on a stage move (4754), on archive (6055) and on acceptance (6452/8199). The two events that actually invalidated it here — a new delivered revision on the task's own branch, and a blocked packet — leave `recommendations` untouched.

**Fix direction:** whenever `workRevision.headSha` changes or a packet opens, filter out `accept_completion` (and any `transition` to Done) with a timeline note "offer withdrawn: revision changed / task blocked". Render any remaining card against the revision it was made for ("for revision 6548677 · superseded") rather than as a live offer.


### F34-16 · A built-in packet recommends what the dispatcher will refuse; the mention path ignores the same rule

**Seen:** JC-3 at Review, 11:22–11:26Z. Base refresh conflicted on `docs/specs/README.md`; the fixed conflict packet (`update_branch_from_base` failure) offered "Have the delivering agent resolve the conflict" (recommended, with the pre-written evidence line "the delivering agent resolves the conflict … in its own workspace"), "Resolve `jc-3` yourself", "Archive". The owner picked the recommendation. The operator executed it: `task.operator.agent_selected jc-spec-writer`, then `prompt_agent` refused — "JC Spec Writer is not eligible for the review stage - its profile is scoped to backlog, spec-design. Change the task's stage or the profile's eligible stages." Its options to route around were empty (`reworkStages: []`, `nextStages: [Done]`), so it opened "Your decision can't execute — the delivering agent isn't eligible at Review" with: add Review to the profile (rec) / move JC-3 back to Design. Four minutes earlier Maya's comment "@JC Spec Writer …" had resumed that exact agent on that exact task at Review and it committed 1215ab44 — the mention path resumes a prior session through `resumeRun` with confinement but no `assertStageEligible`.

**Why it matters:** the person's decision is recorded and then cannot happen; the cheapest remedy Viberr offers is a permanent configuration change (widen a profile's stages) to fix a two-line merge; the alternative walks a reviewed task backwards through two boundaries. And the eligibility promise ("N of M stages", made real by F1) is enforced against the operator but not against a human mention, so the same agent both can and cannot act at Review depending on who asks.

**Root cause:** (1) the conflict packet's options are static (`branch-sync` / operator-actions conflict path) and never consult `specialistEligibleForStage(deliverer, stage)`; (2) rework routing only knows stages the board's workflow offers backwards from the current stage; (3) `resumeRun` (run-service) is reachable from the mention path without the stage check that `dispatchAgentRun` applies.

**Fix direction (owner question Q34-13):** decide whether an already-engaged deliverer may always be prompted on its own branch regardless of stage (eligibility gates *engagement*, not *rework*). If yes: exempt the engaged deliverer in `assertStageEligible` for prompt/resume on its own task and make the mention path consistent; if no: the conflict packet must compute executability and offer only reachable options (and the mention path must refuse the same way).

**Second instance (16:11Z, JC-6 at QA):** the same conflict packet, same recommended option; JC Developer is Implementation-only, so the operator — rather than open another "can't execute" packet — SUBSTITUTED the stock `developer` profile ("declares only the Implementation stage and is not eligible at QA, and no rework transition back to Implementation is offered"), engaged it with `delivers: true`, and it resolved the conflict and committed on the deliverer's branch (3ce8ef0, author jc-developer identity of the stock profile). The owner's "every agent runs on fable" constraint was silently broken by an eligibility wall: the stock Developer runs `opus[1m]`. Six minutes later the operator also engaged the JC QA Tester with `delivers: true` ("may codify Playwright specs on jc-6"), and it committed `e2e/home.spec.ts` (70284d6) on the same branch — a QA profile writing product code on the delivering branch because the controller had granted it full delivery capabilities at deploy time (F34-2's blind grants). Ruling 98 allows a capability-derived delivering posture, so the second part is by design; the substitution is F34-16's cost made concrete.


### U34-3 · A profile save reverts a write it never saw

**Noticed:** 09:12Z, while the controller's turn was writing capability grants on the same four
`jc-*` deployments the owner was editing in the Agents UI. I opened the Agent profile modal, saw
that saving it would re-submit every capability row as it stood when the modal opened, cancelled,
and reserved the id in NOTES rather than filing it, because no user had been bitten yet.

**Confirmed against the code, 2026-09-04.** `updateAgentProfile`
(`app/features/agents/agent-profile-actions.server.ts:625-672`) rebuilds the governed grant set from
the submitted form inside the `updateProjectFile` callback:

```
const saved = grantsFor(form.caps, governedDefaults, { specialist: !isOperator });
deployment.capabilities = [...saved.grants, ...preserved];   // :668-672
```

`preserved` (`:665-667`) is only the capabilities OUTSIDE the modal's set, so every governed grant
comes from the form. The modal seeds `caps` once, at open time, from `initial.capabilities`
(`create-profile-modal.tsx:279-310`), and the route's `update-profile` intent
(`app/routes/project.agents.tsx:205-227`) carries no version of the record the editor read. The
per-file mutex makes the write atomic; it does not make it aware.

**Why it matters:** the losing write is silent on every surface. The save answers
`Profile "<name>" updated · changes apply from the next run`, the audit records a successful
profile update, and the reverted grants read as though nobody ever set them — the same class of
invisible loss as F34-2's `[done]` on a grant that never landed, one door over. Pass 34 raises the
odds rather than lowering them: A32-A34 make `update_agent_deployment` land capability, model and
effort writes for real, so a person editing a deployment while the controller writes it is now an
ordinary sequence rather than a curiosity.

**Fix:** B5 — a `deploymentFingerprint` of the record the editor read, submitted with the save and
compared against the freshly parsed deployment inside the writer, refusing a stale save by name.
