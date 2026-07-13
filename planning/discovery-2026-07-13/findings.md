# Findings — pre-fix evidence and current resolution targets

The prose in each finding preserves the observed pre-fix defect. F01–F41's `Status` records the
completed evidence pass that preceded the independent adversarial review and is mirrored by
`implementation-ledger.md`; it is not a new release claim for the later hardening tree. `Validated
(automated contract)` means the provider-dependent behavior was proven by tests while that pass's
live health had no provider run signal. Credential-dependent GitHub limits are called out
separately. The post-review resolution addendum near the end records the newer final local gate and
keeps remote publication as a separate fact.

## P0 — delivery, integrity, and lifecycle

### F01 — real specialist work lacks a reliable authenticated push path

Status: implemented and regression-validated; credentialed in-app delivery unverified by explicit
non-binding of the host GitHub credential.

The stored PAT is available to a temporary clone askpass helper, then removed before the agent
starts. The specialist is still instructed to push and open a PR. The production image has git but
not gh. A locally committed workspace can therefore look reviewable and even accepted without a
remote branch containing the work.

Evidence: app/server/github/git-clone-auth.server.ts:53;
app/server/tasks/specialist-run.server.ts:1029; Dockerfile:34;
app/server/github/workspace-delivery.server.ts:30.

Required outcome: scoped run-long Git auth or a server-owned push/PR path; verify remote head SHA
and non-empty PR diff before repository-bound acceptance.

### F02 — user/member lifecycle leaves ghost roles and owners

Status: validated under D1/D2 through regression and the final four-role browser matrix.

Org disable/delete and project member removal do not reconcile canonical project membership, sole
project-admin status, task ownerUserId, or open owner/acceptance work. Projects and tasks can be
stranded behind deleted identities.

Binding target: contributor owners receive task-scoped acceptance; organization admins have
audited emergency project-admin authority. Identity cleanup must preserve or explicitly transfer
the task-scoped authority and cannot strand a project.

Evidence: app/server/org/org-users.server.ts:313; app/server/auth/user-admin.server.ts:146;
app/features/project-settings/settings-actions.server.ts:395.

### F03 — project delete/recreate can inherit old operational state

Status: validated under D8 through canonical purge regression and the clean final projection.

Deletion removes the canonical directory and notifications, while runs/logs, PAT bindings, scope
violations, and provenance survive rebuild. Reusing a slug can attach old state to a new project.

Evidence: app/features/project-settings/settings-actions.server.ts:531;
app/server/projections/rebuild.server.ts:23.

### F04 — visible stages and workflow graph diverge

Status: validated under D10 through settings/policy regression and final UI evidence.

Add/reorder stage mutates the ordered stage list but not workflow edges. New columns are invisible
to operator routing; reordered columns do not reorder the governed graph.

Evidence: app/features/project-settings/settings-actions.server.ts:201,291.

### F05 — operator lease recovery can release a successor

Status: validated by the exact-token controlled race test and final full suite.

Pre-fix behavior: the boot-recovery completion chain released without the old lease token, so a late
completion could release a newer operator lease. The recovery path now installs and releases an
exact token; a regression proves a stale predecessor cannot evict the recovered successor and active
triggers still coalesce.

Evidence: app/server/runtimes/operator-run.server.ts:237.

### F06 — operator failure escalation can still be silent when packet authority is denied

Status: validated by capability-independent recovery regression.

Failure handling relies on operatorOpenPacket. If generate-packets is denied, no unconditional
durable task event and notification is guaranteed.

Evidence: app/server/runtimes/operator-run.server.ts:730.

### F07 — test/runtime teardown leaks background work

Status: validated; the final 1,318-test suite completed without the baseline watcher/post-close
failure, and Compose watcher health stayed true.

The baseline unit run produced repeated simulated run writes and completion callbacks after test
databases were closed, auto-operator work against already-removed projects, and file-watch EMFILE
re-arm loops. Three file-watch tests failed; 1182/1185 passed.

Required outcome: explicit lifecycle ownership/cancellation for watchers, timers, and chained
completion effects. Tests must fail on unexpected post-test errors rather than log them.

## P1 — core product correctness

### F08 — timezone-dependent SSR causes hydration failures

Status: validated by UTC/browser hydration regression, 19/19 Playwright, and clean final browser
logs.

Production Docker renders in UTC while the browser is Europe/Istanbul. Notification, activity,
timeline, home, and profile components format local clock/day text during server render and again
during hydration. /notifications emits React error #418; its native overlay becomes visually
unreliable after hydration.

Evidence: app/features/notifications/notifications-page.tsx:111-123,162;
notifications-page-helpers.ts:26-31; notification-item.tsx:24-34;
app/shared/dates/format.ts:28-59; use-dialog.ts:22-67; Dockerfile/compose have no shared TZ.

### F09 — personalized queues are actually project-wide

Status: validated under D1 by multi-role regression and Admin/Contributor-owner/Viewer/org-admin
browser evidence.

- Board Waiting on me checks only waiting=human and receives no user.
- Home active runs counts waiting=agent tasks, not running run rows.
- Home decisions waiting on you counts every packet in visible projects.
- Review calls every human-waiting task your acceptance, including roles that cannot accept.

Binding target: user-personal copy is reserved for work the current user can act on. This includes
maintainer+ acceptance work and task-scoped acceptance for a contributor owner. Other human work is
labelled project-wide, not mine/yours.

Evidence: board-filters.ts:16-23; home-query.server.ts:126-149; home-page.tsx:805-820;
project.review.tsx:20-42; review-page.tsx:80-95.

### F10 — review queue collapses distinct states and overpromises merge

Status: validated for state/copy semantics; credentialed in-app freshness remains unverified because
no GitHub credential was bound.

review+waiting:none is labelled agent working; closed PRs collapse into review; copy says acceptance
always merges even though the contract supports accepted/merge-pending. The VIB-142 task packet also
says Accept completion will merge while the same screen reports no working credential.

Evidence: review-queue.server.ts:15-18,70-87; review-page.tsx:44-53,124-133;
github-view.tsx:220-226.

### F11 — role-bound UI exposes actions known to fail

Status: validated by cross-role screenshots and route/component regression.

Examples: viewer sees GitHub Reconcile; owner handoff lists viewers; stale copy says any member may
own; all users see admin Org Settings links; nonmembers see protected project rail destinations.

Evidence: github-view.tsx:330-368,448-458; execution-profile.tsx:104-110,667-682;
home-page.tsx:1028-1102; rail.tsx:45-65; shared/rbac.ts.

### F12 — profile combines a role from one project with a link to another

Status: validated; Murat's VDV Contributor and Viberr Core Maintainer contexts render independently.

The profile displays the highest role across all memberships but links Policy/Settings to a
separately chosen first project. It can promise admin grants in a viewer project context.

Evidence: profile-query.server.ts:51-60,140-147; profile-page.tsx:357-417,771-775.

### F13 — project invite is immediate provisioning with false delivery copy

Status: validated as truthful Grant access behavior; unusable provisioning is rejected when OAuth
is unconfigured.

The action creates a passwordless user and viewer membership but returns Invite sent. There is no
mail delivery. This can create an unusable account when OAuth is absent.

Evidence: project-settings/settings-actions.server.ts:341-345,376-392.

### F14 — MCP credential references and probe are not functional

Status: validated under D4 by focused secret/handshake tests and a real healthy DeepWiki probe
(three tools, 1,477 ms, Claude+Codex, API Specialist attachment).

secret references are not resolved into HTTP headers or stdio env. HTTP test treats any response,
including auth failure, as reachability and does not perform initialize/tools-list. Stdio argument
parsing does not preserve quoting.

Evidence: specialist-mcp.server.ts:17-22; org/resources.server.ts:570-607;
org-settings/resources-panel.tsx:139-147,209-226.

### F15 — global profiles cannot be deployed into projects

Status: validated by governed deployment regression and final Agents/resources evidence.

Org settings can create a global profile and claims it is deployable, but project Agents only makes
new inline profiles. There is no attach-existing-template action.

### F16 — global resource dependencies ignore project-inline agents

Status: validated under D9 by inline/template dependency regression.

Used-by counts scan global templates only. Rename/delete can silently strand inline deployed
agents that reference a KB, skill, or MCP.

Evidence: org-settings/resources-panel.tsx:948 and resource mutation services.

### F17 — capability omission is not fail-closed and modes are collapsed in UI

Status: validated by capability/routing regression and final Policy evidence.

The runtime withholds only explicit human/off grants, so omitted entries can gain capability. The
view model collapses human and off, reconstructs forbidden as human, and leaves advisory/both
enforcement visually ambiguous.

Evidence: agents-query.server.ts:82-102; capability-matrix-modal.tsx:23-37,145-160.

### F18 — real GitHub delivery and product copy exceed supported hosts/identity

Status: validated by client/profile tests and final github.com/account copy.

GitHub Enterprise helpers do not configure API/clone hosts; production uses github.com. Profile
copy promises GitHub audit attribution but actions audit workspace identity, and Disconnect does
not unlink the Better Auth account.

Evidence: github-client.server.ts:215 and API base construction; profile-page.tsx:519-529;
profile-actions.server.ts:159-188.

## P2 — runtime truth and UX

### F19 — real adapters do not emit phase/step

Status: validated by adapter/runtime contract tests. Final health had no real-provider run signal, so
no live Claude/Codex execution claim is added.

The callback exists, but real Claude/Codex runs leave phase/step empty. Demo rows imply a feature
the real backend does not provide.

### F20 — run-log tail can race and duplicate lines

Status: validated by serialized burst/stale-response regression.

Multiple append events can fetch from the same cursor before state advances. There is no per-run
in-flight serialization or sequence dedupe.

Evidence: app/features/runtime/use-run-log-stream.ts:95-136.

### F21 — Claude account-managed skills/subagents leak into clean runs

Status: validated under D5 by strict runtime-envelope regression; no final real Claude run signal.

Empty settingSources/skills/plugins does not suppress account-managed tools under OAuth-token auth.
Unit tests only inspect builder options. Codex explicitly disables more ambient features.

### F22 — Codex/Claude enforcement is materially unequal

Status: validated with backend-specific hard exclusions and disclosure.

Claude receives disallowedTools; Codex cannot enforce the same tool deny list and may use ambient
Git tooling. App-mediated structural guards remain, but backend choice is not equivalent.

### F23 — Codex operator still lacks an explicitly isolated empty workdir

Status: validated by isolated-workdir regression in the final full suite.

### F24 — feedback toasts and notification mutations can show false success

Status: validated by typed feedback/action-completion regression and final clean Notifications UI.

The global toast always uses a success glyph even for server errors. Mark-all-read announces
success before response and ignores fetcher failure.

Evidence: ui/toast.tsx:51-59; routes/notifications.tsx:69-75; shell/top-bell.tsx:50-56.

### F25 — OAuth rejection flash has no writer

Status: validated by callback/flash/loader regression and truthful provider-unconfigured UI.

Login reads/clears viberr_login_flash, but the OAuth whitelist rejection flow never writes it.

Evidence: auth/login-flash.server.ts:20-48; routes/login.tsx:38-63.

### F26 — Agents view/profile selection is not URL state

Status: validated by URL-state regression and Playwright Back/Forward coverage.

profile is read once; clicks, Profiles/Live, back/forward, and reload do not preserve the selected
state.

Evidence: agents-page.tsx:566-579,658-675,713-770.

### F27 — no truthful SSE connection state, navigation pending state, or small-screen shell

Status: validated by SSE/navigation/drawer regression and final desktop plus 390×844 screenshots.

SSE retries silently; no stale/reconnecting UI exists. Route transitions have no global pending
state. The 232px project rail never collapses on phone widths.

Evidence: live-updates/sse-client.ts:74-105; app.css:94-113,2270-2283.

### F28 — health reports credential presence, not provider validity

Status: validated; final health reports both backends configured but `unknown`, with no run signal.

Health can say a backend is real/available while its token is expired or unusable. Runtime failure
is the first real validation.

### F29 — archive is only a Home filter

Status: validated under D6 through live archive/read-only/Restore on Viberr Live Six.

Direct routes and mutations remain available for an archived project.

### F30 — permanent seeded running rows misstate live work

Status: validated under D14 by running-count regression and final Home/Agents evidence.

Home says three runs active from yesterday. They are seeded/demo rows, not verified running
provider work.

### F31 — manual terminal jump can bypass workflow history and launder unknown validation

Status: validated under D7/D11 by the 152-test terminal/reviewer run, broader 165-test focused run,
Playwright, and owner UI evidence.

Pre-fix behavior: a maintainer could jump from any stage to terminal through acceptance; only
explicit failing validation blocked, and acceptance then fabricated healthy validation. Current
behavior requires Review, exactly healthy validation, every assigned reviewer approval, and a real
merge before a repository task reaches Done. Accepted-but-unmerged work remains Review.

### F32 — reviewer workspace and verdict contracts are under-specified

Status: validated under D15 by strict fingerprint/race/cycle regression and final VDV-8 evidence.

Pre-fix behavior: multiple reviewers shared one workspace and verdict was inferred from prose.
Reviewers now receive stable isolated workspaces; only one strict non-simulated structured marker
counts. Any rejection returns to implementation, a new evidence round invalidates old verdicts, and
every assigned reviewer must approve before acceptance.

### F33 — operator routing lacks the context required for an intelligent choice

Status: validated under D3. Project-specific hard eligibility feeds the operator candidate set;
organization-wide workload/cost plus skill/KB/MCP/backend context informs the operator's persisted,
no-static-score decision.

Stage and capability eligibility should hard-filter impossible candidates, but the operator must
make the final choice using accurate candidate metadata: declared skill/KB/MCP fit, backend
availability, active/recent workload, and cost. Current selection mainly favors the default
Developer and does not expose the complete comparison context or persist an explanation.

Binding target: enrich the operator's candidate context and decision/audit output; do not replace
the operator with a simplistic static scoring rule.

### F34 — new-project templates restore capabilities the current product contract removed

Status: validated by project-create/catalog regression and the fresh VDV project.

The freshly created Viberr Deep Validation project restored advisory capability entries that the
latest product ruling removed as fake: Developer received `report-validation-verdict`; Reviewer
received `approve-review` and `request-changes`. These entries are written to canonical project.md,
so a new project starts with a stale capability contract even though the UI and runtime cannot make
those names truthful enforcement boundaries.

Evidence: docker-data/projects/viberr-deep-validation/project.md; fresh-project creation through the
production UI.

Required outcome: the project template and capability catalog must share one current source of truth.
New project files must contain only supported capability IDs and modes.

### F35 — creating Triage tasks immediately fans out real operator runs

Status: validated with durable bounded dispatch, coalescing, hourly observed-cost limits, and boot
recovery regression.

Creating the 24 VDV tasks in a short interval launched 24 real Claude operator runs immediately,
including tasks deliberately created as `readiness: input_required`. All 24 initial operator runs
finished, with no queueing or visible cost/concurrency guard. This contradicts the prior validation
assumption that automatic operator invocation starts outside Triage and makes bulk task setup itself
an expensive execution trigger.

Evidence: 24 initial operator rows in docker-data/state/projection.sqlite, started between
2026-07-12T21:36:49Z and 21:42:04Z; Docker logs reported `operator run started (real)` for every task.

Required outcome: define and enforce the creation/Triage trigger contract, make the trigger visible,
and apply queue/concurrency/cost controls. An `input_required` task must not silently become an
implementation run merely because it was created.

### F36 — operator readiness commentary and stage mutations contradict each other

Status: validated by structured readiness/recommendation/authority regression.

For VDV-2 the operator recorded that the task was in Triage with `readiness=input_required`, that no
specialist could act, and that it was *recommending* advancement. It then directly wrote
Triage → Ready → In Progress and started a primary specialist while the project capability matrix
sets `stage-transitions` to `recommend`. Similar direct Triage advancement appears across the live
campaign. The canonical record therefore cannot explain whether readiness was resolved, a
recommendation was applied, or a policy boundary was bypassed.

Evidence: docker-data/projects/viberr-deep-validation/tasks/VDV-2/task.md timeline and
docker-data/projects/viberr-deep-validation/project.md operator capability modes.

Required outcome: readiness and transition authority must be evaluated atomically. A recommendation
must remain a recommendation until an authorized actor applies it, and a direct transition must
record the authority and the readiness change that made it legal.

### F37 — the operator may invent repository work instead of asking for missing intent

Status: validated by missing/placeholder-intent regression.

VDV-2 asked to exercise a lifecycle; it did not specify a product change. The operator instructed
API Specialist to choose “a small, concrete, verifiable change” itself. It also selected the
API-specific Claude profile for a provider-oriented generic lifecycle case without an API fit. This
turns a governance test into arbitrary repository mutation and demonstrates the missing routing
context in F33.

Evidence: docker-data/projects/viberr-deep-validation/tasks/VDV-2/task.md, operator comment at
2026-07-12T21:42:47Z and specialist assignment.

Required outcome: agents must not invent product scope. Missing implementation intent opens a
decision packet or remains in Triage; routing rationale must explain role/resource fit before a
specialist starts.

### F38 — checkout/auth failure falls through to an unproductive specialist session

Status: validated with preflight/recovery regression; authenticated live checkout remains unverified
because no application credential was bound.

The VDV-2 private-repository clone failed before specialist work, but the runtime fell back to an
empty task workspace and still launched Claude. The specialist then spent 33 turns probing GitHub,
network access, alternate repositories, and missing tools (`gh`, curl/wget/Python were unavailable)
before reporting the credential blocker. Several other real specialist runs followed the same
empty-workspace fallback pattern.

Evidence: VDV-2 primary run in docker-data/state/projection.sqlite (33 turns, interrupted); canonical
VDV-2 blocker report; Docker clone exit-128/fallback logs.

Required outcome: checkout and required-tool prerequisites are a structured preflight. A known
private-repository auth failure must fail fast into one durable recovery packet/notification, without
starting a model in an empty workspace to rediscover the infrastructure failure.

### F39 — “operator active” does not mean an operator run is active

Status: validated by lifecycle-state regression and final Agents copy.

The VDV-2 task UI displayed `operator active` after its initial operator run had finished. The label
appears to conflate an assigned/deployed operator with a currently running operator session, which is
especially misleading beside the Live Run panel.

Evidence: VDV-2 browser capture after the operator row had `state=finished` and `finished_at` set in
docker-data/state/projection.sqlite.

Required outcome: distinguish operator configured/engaged, queued, running, finished, and failed.
Only a live run may be called active.

### F40 — interrupt success is announced before the live view converges

Status: validated by exact-run acknowledgement/runtime/UI/route regression.

Interrupting VDV-2 produced `Run interrupted — the thread stays resumable`, but roughly 700 ms later
the task still showed the run as running and retained the Interrupt action. The database later
settled correctly to `state=interrupted`, with Arda as `interrupted_by` and a finish timestamp. The
problem observed is premature success/stale UI, not a proven failure to interrupt the provider.

Evidence: VDV-2 browser capture immediately after interrupt and its primary run row in
docker-data/state/projection.sqlite.

Required outcome: expose an interrupting/pending state and announce success only after the selected
run reaches a terminal acknowledgement; stream or revalidate the exact run row deterministically.

### F41 — the live projection database became malformed during the high-write campaign

Status: validated by recovery/integrity regression, clean isolated write stress, final healthy
Compose integrity, and a second-container 5-project/38-task forced rescan with zero errors.

During concurrent operator/specialist log ingestion, the VDV-6 task route began returning
`SQLITE_CORRUPT` from `listRunLines`. Integrity checking found malformed b-trees for
`run_log_lines`, `task_events`, `notifications`, and `task_projections`, plus inconsistent indexes.
Canonical project/task files remained readable. A `.recover` copy passed integrity and retained
identity, membership, audit, run, and 2,220 run-log rows; boot then rebuilt all 5 projects and 38
tasks from canonical files. The original database, WAL, SHM, checkpointed image, and recovered copy
are preserved under `/tmp/viberr-corruption-2026-07-13` for this run.

The incident happened while the app was writing through Docker Desktop and the test harness was
also issuing read-only host-side sqlite queries against the bind-mounted WAL database. Cross-boundary
WAL access is therefore a plausible test-induced contributor. It is not yet honest to call this an
app-only corruption bug. All further live inspection uses application APIs/browser state, or an
offline database after the container stops.

Required outcome: reproduce high-rate run-log writes in an isolated single-process/container test,
add startup/health integrity detection and an operator-visible recovery path, and document that a
live WAL database must not be opened from both sides of a Docker Desktop bind mount. If corruption
reproduces without the host reader, fix the write lifecycle before any release claim.

## Post-review resolution addendum

The independent review found a shared failure mode beneath several otherwise
separate features: a process could cross a remote or canonical boundary, crash
before its local side effects converged, and leave retry code to infer identity
or attribution from mutable current state. The corrected design is exact-intent
recovery. These rows describe resolutions validated by the new final local
release gate.

| Review area | Resolution | State |
| --- | --- | --- |
| Human and full-autonomy completion | A completion intent binds task incarnation, evidence fingerprint, Done stage, original actor/authority and pinned PR/head when present. Repo-less full autonomy has explicit non-human attribution. Boot/retry resumes phases without repeating completed GitHub work. | validated on final tree |
| Irreversible merge | A pre-PUT merge intent pins normalized repository, PR, full reviewed head, task incarnation and original accepter/authority. Local merge facts converge under the original occurrence even when a later request performs recovery. | validated on final tree |
| PR creation ambiguity | A pre-POST PR-open intent pins repository, base, branch, full head, task incarnation, title/body and original actor/authority. Once POST is ambiguous, recovery is observation/manual-reconciliation only and never blindly reposts, including after empty or failed observation. | validated on final tree |
| Intelligent routing provenance | One routing intent id follows exact candidate context and choice through primary/reviewer assignment or recommendation, timeline/audit rationale and launched run `sourceIntentId`. Later unrelated work and human fallback cannot satisfy it. | validated on final tree |
| Archive/restore split commit | A lifecycle intent plus canonical `project.md` marker proves whether the exact archive/restore edge committed. Boot converges projection and deterministic original-actor audit only from that proof; otherwise it cancels the row. | validated on final tree |
| Ownership cleanup split commit | Exact owner-seat intents are staged while access is unchanged; the authorized member/role mutation atomically commits its batch marker; only then are task owners released. Pre-commit revocation/conflict leaves access, seats and audits unchanged, and retry/boot refuses a replacement task or newer owner. | validated on final tree |
| Actor/authority races | The current enabled user, Better Auth organization role, canonical project role and exact task ownership are rechecked at the actual mutation/launch/merge boundary. Contributor-owner acceptance and org-admin emergency authority are audited as the grant used to commit. | validated on final tree |
| Occurrence dedupe | Delivery uses the complete SHA in structured provenance, while delivery/merge/completion/routing records bind task incarnation. Deterministic ids dedupe a retry of one occurrence without collapsing later same-key work. | validated on final tree |

Security hardening remains deliberately outside this campaign, as requested by
the owner; it is not silently reclassified as resolved here.

### Post-review evidence

- Vitest: 158 files/1,565 tests in 30.25 seconds; typecheck/build/whitespace clean; independent
  focused recovery verifier 197/197.
- Playwright: 19/19 in 22.1 seconds.
- Fresh Docker: 3 projects/12 tasks; rescan 0 changed/15 unchanged/0 removed/0 errors in 3 ms;
  health/integrity OK; watcher active; 0 application warnings/errors.
- Signed-in browser: all critical project/organization routes reviewed, 12 new screenshots captured,
  and 0 console warnings/errors.
- Publication: implementation commit `0c8c758` was pushed to draft PR #23; GitHub Actions `verify`
  passed in 5m51s (run 29258036588).

## Documentation drift (reconciled)

- README previously called older planning artifacts authoritative.
- README previously listed MCP secrets as future work despite implemented encrypted explicit
  mappings and real MCP handshakes.
- Original PRD role, consultant, project-creation, and human-only Done claims are superseded.
- Prior pass-4 validation says all cases pass while explicitly deferring MCP secret injection and
  documenting skill leakage. The current dossier keeps that record historical and replaces it with
  final regression, Docker/API, real MCP, role, archive, responsive, and browser-log evidence.
- The 24 VDV task outcomes remain baseline/exploratory evidence where blocked or stale. They are not
  rewritten into post-fix live successes.
- Credential-dependent GitHub reconcile/delivery remains explicitly unverified in-app because the
  logged-in host credential was not imported without owner confirmation; tests and external GitHub
  truth are documented separately.
- References to “final” counts and screenshots elsewhere in F01–F41 describe the earlier completed
  pass. The separate post-review gate above is the authoritative evidence for the hardened tree.
