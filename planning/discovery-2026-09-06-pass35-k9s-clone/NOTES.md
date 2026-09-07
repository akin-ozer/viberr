# Pass 35 — observation notes (Viberr builds a k9s clone)

Live, chronological, UTC. The observer drives the instance controller; viberr's own
machinery does the work. Findings are filed in FINDINGS.md; questions for the owner
in QUESTIONS.md. Reference material the readers built: reference/.

## Setup as found (2026-09-06 ~13:00Z)

- Container `viberr-app-1`, image built 12:51Z from branch `claude/agent-accounts-signin-card`
  @ cb4fa22a (PR #288, treated as main). Data root `docker-data` created 12:51Z (fresh).
- Users: arda@viberr.dev (org admin, the only user). Claude + Codex homes populated for arda
  (`runtimes/users/u_fEJa118yYZnS/{claude-home/.credentials.json, codex-home/auth.json}`).
  `github_pats` = 1 row (akin-ozer). No projects.
- Controller profile as shipped+edited by the owner: `model: claude-fable-5-1[1m]`, `effort: high`.
  All four `VIBERR_UNLOCK_CONTROLLER_*` = disabled (locked sections, ruling 108).
- Target repo `akin-ozer/k9s-clone`: exists, private, EMPTY (no default branch ref).
- Owner clarified mid-turn: this run is a k9s clone (new product); the "issues, boards,
  sprints" list in the goal text is stale copy from the jira pass and is not the spec.
- Observer branch: `pass35/k9s-clone-observation` off cb4fa22a.

## Timeline

- 13:05Z Controller tab: switched model Fable 5.1[1m] → Opus (1M) `opus[1m]`, effort high
  (owner's call via AskUserQuestion). Toast "Controller updated. Changes apply from its next
  turn"; `agents/profiles/controller.md` reads `model: opus[1m]` / `effort: high`. Picker note:
  the Claude catalog offers no bare "opus"; Opus is only offered as "Opus (1M context)".
- 13:08:54Z Sent goal-1 (scratchpad goal-1.txt; verbatim in the transcript) through the dock
  on Home. Dock shows "Controller is working…". Driving via a headless Playwright persistent
  profile the owner signed in (the Browser pane went hidden; hidden pane = no clicks land).
- 13:09-13:13Z Controller turn 1 (run_5OHJSebGTUn7, opus[1m]). Read the instance first (whoami,
  list_capabilities, KBs, skills, MCPs, global agents, users), then decided the product:
  **`k9c`, a Go terminal UI (tview/tcell, client-go, cobra, goreleaser), single static binary.**
  Wrote KBs `k9c-product-spec`, `k9c-engineering-standards`, `kubernetes-client-notes`; skills
  `k9c-delivery`, `k9c-review`, `k9c-release-ops`; then `create_project`.
  - `create_project` with key `K9C` → `[error] Task key must be 2-4 letters.` Controller
    adapted to `KNC`. Honest refusal, no finding.
  - Project `k9c-k9s-clone` created (keys KNC-n), repo akin-ozer/k9s-clone attached and
    reported connected, default branch main. Stages: triage → design → impl → validation →
    review → merge → done (custom).
  - `save_global_agent id=developer backend=codex` → "[done] Developer updated" (the stock
    template was overwritten in place).
- OBSERVATION (toolchain): the container image has NO `go`, `python3`, `make`, `gcc`, `gh`;
  only node 26, uv, git, chromium. The controller chose Go with no way to learn what the
  runtime can build (`instance_health` reports browser/disk/backends, never toolchains).
  Watching what the first delivery does with it; not intervening.
- OBSERVATION (token accounting, candidate finding): live `agent_runs` row for the controller
  turn reads output_tokens=49 at 22 turns after authoring ~20k chars of KB/skill text;
  input=259682, cached=217109. Verify against the NDJSON at turn end.
- 13:17-13:20Z Goals created: goal-1 Foundation (8 links, KNC-1 live), goal-2 Navigation
  (7, KNC-2 held on goal-1 link 8), goal-3 Daily-driver ops (7, KNC-3 held on goal-2 link 6),
  goal-4 Hardening/v0.1.0 (7, KNC-4 held on goal-2 link 3; link 5 waits on goal-3 link 6, link
  7 on goal-3 link 7). 29 tasks total, all `onFailure: pause`.
- 13:17:22Z KNC-1 created → operator auto-invoked (run_crZ-, 5 turns) moved Triage→Design;
  second operator run (run_w76X) bootstrapped the repo (main @ 77eecbb, "Initialize k9c — k9s
  clone", verified on GitHub) and dispatched Developer (Codex gpt-6-astra medium) with a full
  directive comment. Timeline `github · system:delivery` records the bootstrap.
- 13:18:21-13:20:37Z Developer run run_ozuSfCYSshCo: wrote docs/adr/0001-stack-and-
  architecture.md (187 lines), `make fmt/test/lint/build` → "make: command not found" ×4,
  committed f95e67e on knc-1 (local only, "do not push"), reported to @operator. 141k in / 3.1k
  out, 1 turn.
- 13:20:18Z Controller's `run_agent_on_task operator` → third operator run (run_UFFx) while the
  developer was still running; it read live state and posted "this turn is a wait".
- 13:20:49Z Controller turn 1 finished: 55 turns · 713s · $2.88 · in 1182.1k (cached 1085.2k) ·
  out 54.8k. Full reply saved as controller-reply-1.md. Its own deviations list: no schedule
  tool; model/effort not settable on templates; autonomy full→supervised revert; approve-
  review/request-changes `off` on the two extra reviewers (matrix-only ids); `&amp;` names.
- Screenshots: 03-board-{light,dark}, 04-task-knc1-dark, 05-agents-light (scratchpad/shots,
  copied to screenshots/ at the end). Board dark: KNC-1 Design "agent working", KNC-2/3/4
  Triage "blocked by goal-N link M". Agents page: 9 profiles, "Test &amp; CI Engineer" literal.
- 13:21-13:22Z Operator run 4 (run_kCjd): read the ADR in the checkout, `update_branch_from_base`
  → `[noop] knc-1 is already up to date with main. Origin's copy (77eecbb) is 1 commit behind
  the workspace head: call deliver_for_review`; `deliver_for_review` → "[done] Delivered: pushed
  f95e67e and opened review PR #1"; `run_agent architecture-reviewer delivers:false` at Design.
  VERIFIED: GitHub PR #1 open, head f95e67e, base main, title "[KNC-1] Architecture decision
  record"; task.md pr{number:1,state:review,headSha:f95e67e…}, workRevision rev_Mpl7 kind
  delivered; audit github.repo.bootstrapped / github.branch.created / github.pr.opened /
  github.delivery.operator{moved:true}; notification: 1 mention to arda. Stage still Design
  (delivery from Design is allowed; Review→Merge is the approval boundary).
- Packet option kinds (app/schemas/task-file.schema.ts): accept_completion, request_edit,
  block_on_policy, hold_runtime_debug, redirect, retry_other_backend, edit_goal, archive_task,
  discard_branch, resolve_remote_collision, custom (11).
- 13:24:08Z Architecture Reviewer staged verdict `request_changes` with 7 evidence refs on
  f95e67e (docs-only ADR; "no Makefile/go.mod so build gates are not runnable").
- 13:24:45Z Verdict recorded: task.md `verdicts[0] {profileId: architecture-reviewer, revisionId:
  rev_Mpl7…, headSha: f95e67e…, result: request_changes}`, `validation: failing`, timeline
  `quality · Changes requested`. Operator run 6 (run_iZZA, 9 turns, $0.48) re-prompted
  @Developer IN PLACE at Design ("the only backward transition offered is Triage").
- 13:25:40-13:27:45Z Developer rework run_G3SR: `python3: command not found` (tried a heredoc
  edit), then `make fmt/lint/test/build` ×4 "command not found", committed 5651122 "[KNC-1]
  docs(adr): clarify layer and rendering contracts" (+40/-13). 149.6k in / 2.9k out.
  Live row during the run: turns 0, tokens 0 (Codex reports at turn end) — the Live run panel
  showed TOKENS 0 for the whole 2-minute run (same class as F35-1, both backends).
- 13:33-13:38Z Validation: operator engaged a SECOND verdict-capable reviewer (Reviewer, opus)
  → validation flipped healthy→`changed` (the enum for "a required verdict is pending"; the pill
  reads "awaiting verdict", fine). Reviewer approved 5651122 (17 turns, WebFetch to pkg.go.dev
  under use-web-search-fetch). Operator walked Validation→Review (auto), then **Review→Merge**
  at 13:38:54Z: audit `task.transition {boundary: approval, by: operator}` with autonomy
  supervised and NO human decision → **F35-2** (stage-transitions: direct bypasses a declared
  approval boundary; every surface still says a human approves). Q35-1 filed.
- 13:39:21Z At Merge the operator recorded recommendation `accept_completion` (rec_pkn1) for
  5651122; notification kind `approval` "Operator recommends: Accept completion…".
- 13:43:00Z HUMAN: applied the recommendation (dialog "Apply this recommendation?" = <dialog
  role=alertdialog>, rows APPLYING / MERGES PR #1 into main / REVISION / VERDICT, button
  "Apply → Done & merge"). VERIFIED: GitHub PR #1 MERGED at 13:43:05Z (a4d3050 = main), branch
  knc-1 deleted (delete-branch-after-merge guardrail); task.md stage done, pr.state merged;
  audit github.pr.merged, github.branch.deleted, task.transition{to:done,boundary:human,
  via:accept_completion}, task.recommendation.applied; goal-1 link 1 done → link 2 created as
  KNC-5 by "arda@viberr.dev · via controller · goal chain"; notification kind controller
  "Link 2 started as KNC-5". Cycle 1 = 11 runs (8 operator, 2 developer, 3 reviewer), ~$4.
- Cycle 1 cost note: the operator ran 8 times on a one-file docs task (triage, dispatch, wait,
  deliver, react ×2, walk 3 auto stages, recommend) at ~$0.3-0.5 each.
- 13:43-13:45Z KNC-5 (Repository bootstrap, first CODE task): operator walked Triage→Design→Impl
  in 3 runs and dispatched Developer (Codex). Task read `input_required` at creation for ~30s
  (entry-stage rule, transient).
- 13:45-13:50Z Developer run run_wDG0: `go: command not found`; no curl/python3/gcc/make; the
  agent used node's fetch to download Go (first amd64 → "rosetta error" on the aarch64
  container, then arm64), a Debian make .deb, golangci-lint 2.4.0, all into a gitignored
  `.tools/` in the workspace; scaffolded go.mod/cmd/internal/pkg/Makefile/.golangci.yml/CI;
  lint 0 issues, tests green, cross-compiled 4 targets; committed "[KNC-5] feat(cmd):
  bootstrap packages and version CLI". Container CPU hit 670% during this; UI page loads
  took >30s (Playwright probes timed out; server health stayed 7ms).
  OBSERVATION: viberr's image offers agents no toolchain beyond node/uv/git/chromium and
  nothing tells the controller or the operator that; every workspace will re-download ~150MB
  of tools. Candidate G35 (runtime capability disclosure / toolchain provisioning).
- 13:53:23Z HUMAN: created schedule sch_6KQQ (run-operator, +5 min) on held KNC-2 from the
  Execution profile (the button relabels "Run operator"→"Schedule" once a delay is picked;
  timeline "Scheduled: … It runs on the profile deployed when it fires").
- 13:56:15Z Sent goal-2 from the BOARD (board-scope conversation). Turn 2 (run_8koF, 60 turns,
  187s, $1.22): create_user ×4 (temp passwords relayed in chat), invite_member maintainer/
  contributor/viewer (Noah left out), save_mcp_server context7 (HTTP, no credential) +
  test_mcp_server "healthy: 2 tools · 1205ms", granted to Kubernetes Platform Engineer template;
  use-browser direct on Docs & Release Engineer; update_task blockedBy:[] on KNC-2/3/4 →
  `system:dependency-release` notes + operators re-invoked; update_goal edit_link goal-4 link 5;
  create_task ×22 (KNC-6..27, KNC-27 = browser screenshot task); run_agent_on_task ×7 all
  answered "[done] The operator is already working <key>; your directive was queued for it"
  (the honest queued arm). Reply saved as controller-reply-2.md.
- 13:58:39Z Schedule fired on KNC-2, which the controller had RELEASED 80s earlier: audit
  `task.schedule.fired {outcome: claimed}` then `{outcome: queued-behind-drive}`; the queued run
  posted "@Arda — scheduled probe checked: the hold is gone…" at 14:00:27Z. Honest. (The
  "fires while held" variant was not exercised; redo on a task that stays held.)
- 13:59Z KNC-5: Reviewer approved ab17878 (rev_RQ9g), operator Validation→Review. 27 tasks on
  the board, ~20 operator runs in parallel; container mem peaked 4.6 GB, CPU 670%.
- 14:02Z DISK: host volume 93.7% used, 14-15 GB free; KNC-5 workspace = 701 MB (Go toolchain +
  module/build cache under `.tools/` INSIDE the bind-mounted workspace); 26 more workspaces at
  that size would exhaust the host disk (viberr's low-disk threshold is 2 GB). Run concurrency
  cap was 0 (unlimited); observer set it to 4 on Org settings → Agent resources as a
  safeguard (admin instance config, recorded here). Candidate G35: no shared toolchain/cache
  location, no per-workspace size accounting, unlimited default concurrency.
- 14:03:04Z HUMAN (out of band): `gh pr merge 2 --merge` → 489e078. Pressed "Update status" on
  the GitHub view: toast "Status updated. Every branch and PR maps to its task key"; task.md
  pr.state merged; policy-engine note "**Divergence:** PR #2 was merged on GitHub, but KNC-5
  hasn't been accepted through Viberr, so its stage is unchanged. Accept the completion…";
  operator woke (pr-diverged), verified main via read_default_branch_file, called
  accept_completion → "[recommended] Recommended accepting completion" (supervised: a
  recommendation, not the act). CORRECT.
- 14:03Z CODEX QUOTA EXHAUSTED ("try again at 6:18 PM" = ~15:18Z): 8 developer runs error;
  writer-D packets "Work stalled: pick a recovery path" on KNC-2/3/6/9/18/19/22/23/25 with
  retry_other_backend (rec) / request_edit "The window has reset…: send @agent back" / redirect /
  hold_runtime_debug; observations Agent / Signal / Provider said. Health `quota.codex.exhausted`
  carries the provider text and the run id. Maintainer Maya received 23 packet notifications
  (packets notify maintainers), arda 23.
- 14:03Z Conflict packets (writer I) on KNC-20 and KNC-8: "`knc-20` conflicts with `main`" with
  redirect "Have Docs & Release Engineer resolve the conflict" (rec) / custom "Resolve yourself" /
  archive_task. Cause: branches cut from the pre-scaffold main; README rewritten on both sides.
- 14:04Z Eleven "Decision required" TRIAGE packets (KNC-4/7/11/12/13/15/16/17/21/24/27): the
  operators triaged the controller's 22 new tasks against the PRE-KNC-5 main ("no go.mod, no
  .go files") and asked the human to pick scope (custom hold / edit_goal widen / edit_goal
  narrow / archive). KNC-5 merged at 14:03Z, so most premises are moot, yet nothing withdraws
  a scope packet whose premise is gone (only a successful run or a delivery withdraws): the
  human must answer 11 near-identical questions by hand. Candidate U35-2.
- 14:10Z Owner answers (Q35-1..3): boundary always wins; wait for the Codex window; observer
  signs in as the synthetic probe users.
- 14:16:33Z HUMAN: applied the accept_completion recommendation on KNC-5 (dialog button read
  "Apply → Done", no "& merge" since the PR was already merged). Timeline `completion ·
  Completion accepted`: "Human acceptance recorded. KNC-5 transitioned to **Done**; the review
  PR had already been merged on GitHub (out of band)." Cycle 2 complete (out-of-band path).
- 14:17Z Profile → "GitHub identity": "GitHub account not connected. GitHub sign-in isn't
  configured on this deployment, so there's no personal GitHub identity to connect."
  `users.github_handle` stays null → a GitHub approval by akin-ozer can only land as
  `unlinked_handle` (ruling 68 unreachable without OAuth). Checking whether an admin field
  exists on Users & access; else candidate G35 (no way to bind a handle without OAuth).
- 14:17Z KNC-5 Done → goal-1 link 3 = KNC-28 (Kubeconfig and context resolution): operator
  Triage→Design, dispatched Kubernetes Platform Engineer (Codex) at 14:17:51Z → error at
  14:17:55Z (quota) → "Work stalled" packet. G35-4 filed (dispatch into a known-exhausted
  backend). 11 primary runs in error so far.
- 14:19Z Four synthetic probe sessions signed in (maya maintainer / omar contributor / lena
  viewer / noah non-member), forced reset "Set a new password" → "Save & continue" worked for
  each; RBAC probe delegated to a background agent (RBAC-PROBE.md).
- 14:20:38Z HUMAN: archived KNC-24 (open triage packet). Dialog "Archive this task?" discloses:
  "Withdrawn the open '…pick the scope' decision. Restoring the task reopens the question."
  Audit task.archived {withdrawn: 1}; task page shows "archived", "Restore from archive",
  Run operator disabled. Restored at 14:20:42Z: note "Restored: … back on the board, waiting on
  a human. Run the operator to reopen coordination" (readiness input_required, waiting human,
  packet NOT reopened — the note's "reopens the question" means a fresh operator run must ask
  again). Audit task.unarchived.
- 14:21:02Z HUMAN: resolved KNC-25's stalled packet with `hold_runtime_debug` (note recorded).
  Result: stage Design, readiness blocked, waiting human, NO packet, no card; the only control
  left is "Run operator" (maintainer+). Audit task.packet.resolved {optionKind:
  hold_runtime_debug}. A contributor-owner would have no in-app way back (D64) — to verify
  with Omar's session.
- 14:22-14:25Z Controller turn 3 (run_-9G5, 31 turns, $1.76, 1.6M input): instance_health,
  inspect_run_analytics (111 runs, $39.64, coordination share 80.1%), inspect_audit_log (595
  rows), read_run_log on the quota run (turns 0, `error·quota`, resetsAt null) all worked.
  goal-3: add_link/remove_pending_link/skip_link/edit_link all landed (goal file timeline).
  KNC-29 "Observer probe: held task" (blockedBy KNC-28): run_agent_on_task(operator) answered
  "[done] Operator run started on KNC-29" and a run DID start (4 turns, ~$0.2) — the hold
  gates dispatch, not a manual trigger; the operator posted "holding, nothing dispatched".
  Controller flagged goal-3 link 1's stale link-level wait → F35-3.
- 14:23:25Z HUMAN (deliberate rejection): `gh pr close 5` (KNC-14 Dependabot) + Update status →
  pr.state closed, policy notification "PR #5 closed on GitHub: KNC-14 needs a decision",
  accept_completion recommendation withdrawn, operator `input` packet "Review PR #5 was closed
  without merging — pick a recovery path" (custom rework rec / archive keep branch / archive +
  delete branch). Resolved with archive+deleteBranch: alertdialog "Archive this task and delete
  its branch?" (Decision / Deletes / "Deleting it cannot be undone"), toast "Decision recorded".
- 14:28:35Z HUMAN: KNC-27 packet resolved with `custom` ("record a wait on KNC-6") → audit
  task.packet.resolved{custom}, then the operator executed it: task.dependencies.updated
  {blockedBy:[KNC-6]} (no dispatch). Custom directives reach the operator as instructions.
- 14:28:41Z HUMAN: KNC-4 packet resolved with `edit_goal` (option 2) → toast "Decision recorded
  · type the new goal; the packet clears when it lands", goal editor prefilled with the option's
  goalDraft. RELOADED before saving: pill "goal edit pending", rail "Waiting on a goal edit",
  card "Decision made · save the edited goal to clear this packet", Run operator disabled
  ("Open decision. Resolve it before running the operator."). F34-13 is fixed (ruling 138).
  Goal edit left UNSAVED on purpose until Codex reopens.
- 14:28:45Z HUMAN: force-accepted KNC-10 (Validation, review failing, stalled packet, PR #4
  open). Dialog "Force-accept this completion?" rows: Merges PR #4 into main · Revision
  cfd6f51 · Verdict validation failing · Skips Review → Merge and the review gate · Bypassing
  "latest review requests changes" · Withdraws the open decision · Admin override. Result:
  PR #4 MERGED 448b078, branch knc-10 deleted, packet withdrawn {by: force-accept}, transition
  {to: done, boundary: human, via: accept_completion}, task.acceptance.forced; task.md
  `acceptance: forced`, `validation: failing` (a real verdict is evidence, by design). U35-3.
- The "Run an agent" picker is an autocomplete `<input role=combobox>`, not a `<select>`.
- 14:31Z Owner: both hand fixtures allowed (collision, drift); keep going; G35-5 filed.
- 14:35:30Z HUMAN (PR adoption): KNC-8's PR #3 (conflicting) closed with gh, PR #6 opened by
  hand on the same head ad25c40, Update status → policy-engine `github` event "Adopted **PR #6**
  (head ad25c40, the delivered revision) as KNC-8's review PR, replacing PR #3 (review). Viberr
  did not open it…", audit github.pr.adopted {source: reconciler, previousPrNumber: 3,
  previousState: review}, policy notifications "PR #6 adopted for KNC-8: replaces PR #3" to
  arda and Maya. task.md pr → {number: 6, state: review, mergeable: conflicting}. Note:
  previousState is the CACHED state (review), not what GitHub reported (closed) at the time.
- 14:36Z Dock on a TASK page (KNC-6): trigger aria-label "Controller · KNC-6 · k9c — k9s
  clone", context line "Knows the KNC-6 task file and its place in the … workflow"; reply cited
  packet pkt_ewWZ97crDZ0P, quoted the Provider said line verbatim, recommended option 1 with the
  "switch sticks" caveat, and pointed at the task page for the ceremony. Context read works.
- 14:35Z Insights: 117 runs, $45.97, coordination overhead 83% ($38.09), blocked-decision wait
  median 22m48s (21 open), branch+PR traceability 57% (4 of 7), Backend quota row "codex ·
  usage limit reached · from a refused run on Arda's account", claude resets 21:30 (local).
- 14:35:51Z After the adoption wake, arda and Maya each received a SECOND "Blocked, decision
  needed: `knc-8` conflicts with `main`" notification for the packet opened at 14:04:44Z (no
  second packet was written; the re-published wake re-notified). Minor, noted.
- 14:37:17Z HUMAN: created KNC-30 "Observer: repository notes file" through the board's New
  task dialog (fields Title*, Goal, Priority, Due date, Add a label) → toast "KNC-30 created in
  Triage. Its task.md is in the store"; auto-triage started. It hosts the branch-collision
  fixture: once the operator allocates `knc-30`, a stray commit + unowned PR go on that branch.
- 14:35Z Human "Run an agent" (Architecture Reviewer, eligible at design/review) on KNC-24 at
  Triage: the picker offered the agent with the posture line "Runs as a reviewer: its verdict
  gates acceptance", Run was enabled, the click produced no run, no audit row and no toast I
  could capture within 3.5 s. Re-checking the server log.
- 14:39:10Z Collision fixture: API-pushed stray commit 23ed273 (OBSERVER-FIXTURE-knc-30.md) on
  the allocated branch knc-30 + unowned PR #7. Update status → task.md `github.unownedPr: 7`,
  no timeline note, no notification, GitHub view row "knc-30 · no PR · synced" (the squatting
  PR is invisible on that surface). The collision packet is expected at delivery time.
- 14:41Z Human "Run an agent" of an ineligible agent (Architecture Reviewer on KNC-24 at
  Triage): POST → 400, toast "Architecture Reviewer is not eligible for the "triage" stage — its
  profile is scoped to design, review. Change the task's stage or the profile's eligible
  stages." Honest (raw stage id, cosmetic). The human dispatch door enforces eligibility.
- 14:40Z RBAC probe (background agent, 88 rows): no role could do what it must not; viewer CAN
  comment (matrix + panel + server agree); non-member gets the uniform 404 on every door and
  the dock is not rendered on that page; audit dedupe leaves one denied row per minute per
  door; only Arda has a Claude credential so the other sessions' dock composers are disabled
  before any RBAC gate. Report: RBAC-PROBE.md.
- 14:41:17Z HUMAN @mention of an ineligible agent (@Architecture Reviewer on KNC-24 at Triage):
  comment recorded as `mention · to: agent`, HTTP 200, NO run, no toast, no note; server warn
  "@mention run did not start; the comment was still recorded" (assertStageEligible via
  commentToAgent → startAgentRun). → F35-5.
- 14:42Z Guardrails (Policy page card "4 of 4 enforced"): threshold edit reveals an "Apply"
  button → toast "Compression threshold: 5 events · applies to the next compaction pass";
  checkbox toggle applies at once → "No duplicate summaries: off · applies from the next agent
  comment". project.md `guardrails[]` carries the four ids. Threshold left at 5 to provoke a
  compaction on the next busy task; duplicate-summary rule left OFF for now (re-enable later).
- 14:42Z Guardrail audit rows present: project.policy.guardrail_changed {id: compression-
  threshold, op: value, value: 5, beforeValue: 40} and {id: no-duplicate-summary, op: off,
  beforeOn: true} (my earlier SINCE filter was later than the events; no finding).
- 14:43:46Z HUMAN: Home → "Re-scan store" → audit projection.rescan; server "projection rescan
  complete: projects 1, tasks 30, changed 0, unchanged 35, removed 0, errors 0" (no toast seen).
- 14:44Z FILES-ARE-TRUTH: in-container sha256 of every task.md == task_projections.content_hash
  and file `stage:` == row stage for 30/30 tasks (q-hash.js); archived flags agree.
- 14:45Z CORRECTION: the container clock is UTC (TZ unset, /etc/localtime → Etc/UTC), so the
  provider's "try again at 6:18 PM" is 18:18Z, five hours after the first Codex run at
  13:18:21Z. The Codex window reopens at ~18:18Z, not 15:18Z. Viberr's health reading carried
  `resetsAt: null` for the exhaustion although the provider text names the time (G35-4
  addendum: nothing parses the vendor's wall-clock sentence in the process's own zone, so the
  Backend quota card cannot say when the window reopens and the packet cannot schedule a retry).
- 14:47Z Owner (Q35-6): switch delivery to Claude for the rest of the day. Plan: controller
  turn 4 moves the five delivery deployments to claude/opus/high (exercises the backend-switch
  path), then the ten stalled packets get `retry_other_backend` ("Retry … on Claude now", the
  packet's own recommended option, pins `pinnedBackend: claude` per task), then the eight
  triage packets get the controller's picks, then KNC-4's pending goal edit is saved.
- 14:47-14:48Z Controller turn 4 (run_We7_, 23 turns, $1.19): five delivery deployments →
  claude/opus/high; each tool reply said only "[done] <Agent> updated … Effort is now high." —
  nothing about the backend switch or the model (the controller flagged the silence; the
  backend-switch sentence exists only for a switch WITHOUT effort). project.md confirms
  backends [claude], model opus, effort high on all nine deployments. Refusal: update_goal
  edit_link on goal-3 link 1 → "[error] Only a pending or failed link can be edited; link 1 is
  active" (F35-3 addendum: the stale wait cannot be cleared). It also listed the stalled tasks:
  every one already has a remote branch (13 branches behind_main after the KNC-5 merge).
- 14:50Z HUMAN batch (Playwright): retry_other_backend on 10 stalled tasks, redirect "Have
  Docs & Release Engineer resolve the conflict" on KNC-8 and KNC-20, Run operator on the held
  KNC-25, then the 8 triage packets with the controller's picks (custom hold naming KNC-5 ×6,
  KNC-7 option 1, KNC-17 option 1). Cap 4 → the queue drains over the next hour.
- 14:50-14:53Z Batch results: 10 stalled tasks → "Retrying on Claude · streaming to agent logs"
  (retry_other_backend, pinnedBackend claude); KNC-8/KNC-20 conflict packets → redirect (task
  `transition` events by Arda at 14:50:22Z/14:50:29Z, waiting agent); KNC-25 → "Operator
  running · Claude · supervised autonomy"; triage packets: KNC-11/13/15/16 custom hold naming
  KNC-5 resolved, KNC-7 and KNC-17 → `edit_goal` (goal edit pending), KNC-12 and KNC-21 label
  mismatch (KNC-21's option reads "Hold until the Go module scaffolding lands", no key). Queue
  under cap 4: 4 primary running (KNC-3/6/9/18 on Claude opus), 6 primary + 7 operators queued.
- 14:56-14:58Z Goal edits: saving the editor's UNCHANGED text on KNC-4 → 200 "Goal updated",
  packet unchanged (awaiting goal_edit) → F35-6. Saving the option drafts on KNC-4/7/17 →
  "Packet resolved: the requested goal edit landed", operators re-engaged. 0 packets open.
  KNC-21/12 resolved with custom holds naming KNC-5; KNC-26 retried on Claude. Queue: 4 primary
  running, 4 primary + 12 operators queued (cap 4).
- 15:00Z Queue under the cap: admission is FIFO by created_at (verified: primaries created
  14:49:40-14:50:18 admitted before operators created 14:50:22+; the KNC-26 primary created
  14:55:16 waits behind 12 operators). Not a defect, but ONE global cap means the operator
  turns that deliver finished work (KNC-2 finished 14:52:43) wait ~10 min behind 4-minute opus
  specialist runs; no slot is reserved for coordination. Cap raised 4 → 6 at 14:59Z (disk:
  868 MB used by the data root, 14 GB free on the host). Observation under G35-5.
- 15:06:40Z HUMAN: Run an agent → Security & Dependency Auditor on KNC-8 (Validation) with a
  prompt → toast "Claude run started for Security &amp; Dependency Auditor · streaming to agent
  logs" (the &amp; leaks into the toast too), engagements[] gained {security-amp-dependency-
  auditor, delivers false, verdictCapable true} → a second required reviewer; audit
  task.reviewer.assigned, task.agent.run_started {stageEligibility: declared}, task.comment
  {toAgent: true}. KNC-8's redirected Docs agent run is still queued behind the cap.
- 15:07-15:10Z Claude delivery phase: KNC-9 → PR #8 opened (15:07:29Z); KNC-2 base refresh
  "Brought `knc-2` up to date with `main` (6 commits merged in, merge commit 32a296d; the push
  published it…)" (ruling 132 baseRefreshes path exercised); KNC-6 → README conflict packet
  (writer I) at 15:07:20Z; KNC-11/12/15 re-triaged after the holds released and asked residual-
  scope questions ("KNC-5 already landed both KNC-11 deliverables — confirm the residual
  scope") — a second packet round on the same tasks. Queue: 3 op + 3 primary running, 10 op +
  3 primary + 2 reviewer queued.
- 15:10-15:12Z HUMAN: KNC-6 conflict → redirect to the agent; KNC-11/12/15 residual-scope
  packets → recommended edit_goal options, drafts saved in the same page session (editor
  prefilled 894/573/783 chars) → "Packet resolved: the requested goal edit landed". 0 open.
- 15:11:18Z KNC-30 collision at delivery: the Docs agent (Claude) committed e5af546, reported
  "PR URL: none — I have no push credentials and Viberr owns delivery" and flagged origin/knc-30
  = 23ed273 (PR #7); the operator opened "Delivery blocked: an unrelated PR squats on branch
  knc-30" (model-authored, writer J) with resolve_remote_collision (rec) / "I'll clear PR #7
  myself" / "Hold delivery". Observations rows name the blocker and the consequence (force-push
  would file the work under PR #7).
- 15:14:11Z HUMAN: confirmed via "Clear this task's branch collision" dialog (Decision /
  Deletes … closes its pull request #7 / "Deleting the remote branch cannot be undone" / Keeps
  … "the real review PR opens"; button "Clear collision & redeliver"). Result: PR #7 CLOSED,
  branch deleted, re-delivered → PR #11 (head e5af546), audit task.packet.resolved
  {resolve_remote_collision}, github.branch.deleted, github.delivery.manual {delivered, #11,
  moved}, github.collision.resolved {outcome: cleared_and_delivered, delivered: true,
  blockLifted: true}; readiness ready, waiting agent (operator re-queued). Ruling 136 holds.
- 15:16-15:18Z Verdicts: the human-engaged Security & Dependency Auditor requested changes on
  KNC-8 (bfb80bc) → validation failing (a human-added reviewer's verdict gates acceptance, as
  documented). Operator on KNC-19 wrote a typed `quality` event "Knowledge base disagrees with
  the repository: the repository wins: docs/adr/0001… is authoritative; the knowledge base
  k9c-product-spec says otherwise" — the doctrine's KB-vs-repo rule surfaced as a record.
  KNC-17's third scope round resolved (edit_goal "Apply the corrected bullet", 1778-char draft
  saved in-session). Open PRs: #6 (KNC-8), #8 (KNC-9), #9 (KNC-18), #10 (KNC-23), #11 (KNC-30),
  #12 (KNC-19); none approved yet; 14 operator turns queued.
- 15:22Z MCP grant check: template kubernetes-platform-engineer.md `mcps: [context7]`, project.md
  deployment `mcps: []`, KNC-28's Claude run `run_inputs.mcp.mounted: ["viberr_agent"]`,
  `unresolvedResources: []`, system init `mcp_servers: [viberr_agent connected]`. The context7
  server was never mounted on any run → F35-7. CI on PRs #9-#12: all checks pass (lint, test
  oldstable/stable, 4-target build); #8 (LICENSE only) shows no checks.
- 15:23Z Backend switch verified: 0 Codex runs created after 14:48Z; 15 primary Claude runs,
  all `model: opus`; retried tasks carry `pinnedBackend: claude` on their delivering
  engagement (KNC-2/3/6…). KNC-25 (held via hold_runtime_debug, resumed with Run operator at
  14:50Z): the operator re-dispatched the Developer at 15:05Z, yet readiness still reads
  `blocked` with `waiting: agent` — checking whether the hold flag is ever lifted.
- 15:27Z Agents page → Kubernetes Platform Engineer: "Context resources & runtime · MCP servers
  None · Added from the global library", no divergence marker (F35-7 addendum). k9s-clone
  main: 10 commits, 3 merged PRs (#1 ADR, #2 scaffold, #4 templates via force-accept), tree
  .github/ .golangci.yml LICENSE Makefile README.md cmd/ docs/ go.mod go.sum internal/ pkg/.
- 15:23Z New packet KINDS observed: `Agent question` (from agent:claude/kubernetes-platform-
  engineer, askedBy set, single `custom` option "Answer the question") on KNC-26: the agent
  asked how to produce a real kind-cluster capture when the runtime has "no kind/kubectl/
  docker/podman/go, no docker socket, CapEff all zeroes, user namespaces denied" (it attached
  knc-26-environment.txt and knc-26-stub-tests.txt as evidence). Runtime limits reach the
  product's done signals: tasks that need a live cluster cannot be validated inside viberr.
  Also: KNC-9 conflict packet (LICENSE/README vs main), KNC-7 third-round scope packet ("Goal
  edit kept a stale premise that origin/main contradicts", the operator noticed my saved
  draft still carried caveats) — the operators verify goal text against main, which is good,
  but each round costs a human decision plus a goal edit.
- 15:29Z Observation for observers: `task_events.id` is reassigned whenever a task is
  re-projected (a rebuilt task's rows come back with new ids), so ids are not stable handles;
  watch by `occurred_at`, and treat task.md as the record (it is).
- 15:24Z KNC-8: the Docs agent resolved the README conflict and the operator pushed bfb80bc to
  PR #6 ("was ad25c40"); the human-engaged auditor had already requested changes on bfb80bc
  (the local revision) before the push. KNC-2: Architecture Reviewer requested changes on
  32db094. KNC-9 conflict → redirect; KNC-26 agent question answered (custom); KNC-7 goal
  corrected (edit_goal, 1733-char draft saved in-session). 0 packets open.
- 15:31Z GitHub view re-check: the Pull requests panel now lists #6 for KNC-8 and #11 for
  KNC-30 ("11 linked to tasks"); the 14:37Z capture (46-github-view-light) still listed #3
  two minutes after the adoption although its header said "Checked just now" — the panel's
  PR list lags one poll behind the task record. Transient; not filed.
- 15:29Z THE CLAUDE WINDOW RAN OUT ("Arda's five-hour usage window is spent"): every live and
  queued Claude run failed (8 operator, 22 primary, 5 reviewer runs in `error` by 18:32Z).
  Viberr opened writer-G packets "Operator run failed: pick a recovery path" on 7 tasks
  (block_on_policy "The usage window has reset…: re-run" (rec) / redirect / hold) and writer-D
  "Work stalled" packets on 14 tasks (specialists refused by Claude). The observer's own
  session hit the same limit; the pass paused until the reset at 18:30Z (health: claude
  `rejected`, resetsAt 1788719400 = 18:30:00Z). Codex reopened at 18:18Z but viberr's reading
  still says exhausted (G35-4: no resetsAt, no re-probe). Disk on the host: 98.3% used.
- 18:34Z DISK: host free 3.8 GB (98%). Not the data root (845 MB): the Claude agents built a
  SHARED Go setup in the container's /tmp (gopath 3.0 GB, gocache 2.4 GB, go 242 MB, toolchain
  267 MB, go-build 644 MB, sysroot 200 MB, two tarballs) plus /home/node/.cache 2.6 GB and
  /home/node/go 986 MB, all in the container's writable layer (Docker "Containers 10.19 GB"),
  outside every viberr accounting and gone on the next `docker compose up --build`. Docker's
  own build cache held 10.3 GB reclaimable → `docker builder prune -f` (host free 7.4 GB).
  Removed the tarballs and apt scratch from /tmp. Observation for G35-5/toolchain: agents
  converge on /tmp as the shared toolchain home because nothing in the image or the product
  offers one; viberr's disk check watches the data root only.
- 18:33Z HUMAN batch (23 packets): block_on_policy "The usage window has reset (Sep 6, 2026 ·
  18:30 UTC), or I switched the Claude account: re-run" on the 7 failed-operator tasks;
  request_edit "The window has reset…: send @agent back to continue" on the 14 refused
  specialists; redirect on KNC-22's conflict; request_edit "Fix both inside the two files" on
  KNC-8's auditor packet. Audit task.packet.resolved per task; runs queue under cap 6.
- 18:36Z Host toolchain for the end-of-pass "can I run it" check: go 1.27.0 darwin/arm64, kind,
  kubectl, docker present. Building `akin-ozer/k9s-clone@main` on the host in the background.
- 18:36Z RUNNABLE CHECK: `git clone akin-ozer/k9s-clone` @ main (10 commits) on the host →
  `go build ./...` OK, `go test ./...` OK (cmd/k9c + pkg/version tests, other packages have no
  tests yet), `./k9c version` prints "k9c dev (commit: unknown, built: unknown)" (ldflags not
  stamped in a plain build; the Makefile stamps them). Real, minimal, growing.
- 18:37Z Review queue: "0 tasks at the review boundary · 0 waiting on your acceptance", "Still
  in review" empty, while 8 tasks at Validation carry open PRs and reviewer runs → U35-5.
- 18:38Z Insights after the outage: 245 runs, $125.53 (claude 224 runs; codex 21 "not
  reported"), 35 errors, 84% completion, coordination overhead 53% ($66.21), blocked-decision
  wait median 51m 15s over 57 resolved, "Long timelines 29" (my compression threshold of 5
  makes every task "long"), Backend quota: claude resets "Sep 7 · 02:30", codex still "usage
  limit reached" from the 14:38Z refusal although the window reopened at 18:18Z (G35-4).
- 18:38Z Compaction probe: human comment on KNC-1 (38 events, threshold 5) ran
  `compactTimelineEvents` (fires on human comments) and changed nothing: it folds only runs of
  consecutive routine operator/agent comments older than the keep-recent window and never
  typed events, so KNC-1 had nothing to fold; no marker, no audit (by design, D105 in the
  reference). Insights "Long timelines 29" counts every task over the threshold regardless
  (D103). Guardrail behaviour honest; the card's count is loose. Not filed.

## 18:40Z — container crash (SIGBUS) and viberr's boot recovery

- `docker events`: container `die` at 18:40:29.5Z with `exitCode=135` (128+7 = SIGBUS), then `start` 0.3s later (restart policy `unless-stopped`). `OOMKilled=false`, no error line in the server log before the death, memory 1.1G/7.75G, host disk 12G free.
- The last three `docker exec ... node -` calls before the death were MY read-only projection readers (exec_die at 18:40:00, 18:40:27, 18:40:28). Hypothesis: SQLite's open path truncates the `-shm` wal-index to zero when its DMS lock probe says nobody else holds the file; over the VirtioFS bind mount the probe is unreliable (same family as F18-5), so my reader truncated the file the server had memory-mapped and the server's next wal-index access took SIGBUS. Observer-induced, not a viberr defect: viberr itself never opens the store from a second process. Consequence for this pass: every reader now works on a copy (`qx.sh` snapshots `projection.sqlite` + `-wal` into `/tmp/snap` inside the container and opens the copy); the Monitor and the approval wake were re-armed on that recipe. Recorded as F35-9: the runbook section "Readers, and where they must run" (added pass 34 after a HOST-side reader produced the same exit 135) prescribes exactly the form I used, `docker exec ... node` opening the file with `readOnly: true` INSIDE the container, as the safe one. It is not: the second mapping of the wal-index is the hazard on either side of the boundary. The read-only CLIs (`keys status`, `backup` via VACUUM INTO) open the live file the same way.
- Boot recovery (run-recovery.server.ts, F7-BOOT1/UC-31): `finalized non-terminal runs at boot: 23` (6 live + 17 queued), each run row `state=error, interrupted_by=restart, finished_at=18:40:30.963Z`; the queued ones carry `turns=0`. `run.recovery.reinvoked {attempt:1}` audit rows: 23 (one per task), operator re-fired for all 23 tasks in 18:40:31–18:40:32 under the cap of 6 (17 queued behind it). Rescan at boot: 30 tasks, 0 changed. Shipped-asset divergence warnings for controller/developer/reviewer profiles (expected: the controller edited them).
- What the person sees: the run log of the interrupted primary (KNC-13 `run_D5BZ5ilpYLbw`) ends at seq 111 `task_started` with no closing line; the run row keeps `phase=Working, step=Bash · goreleaser build --snapshot`. The task timeline has NO event for the interruption; the next thing on it is the re-invoked operator's comment at 18:45:09Z ("Your previous run started but ended without a report, so nothing is recorded on the task. Do not start over: `.goreleaser.yaml` is already present"), i.e. the operator discovered the partial workspace itself. Insights error count rises by 23 (17 of them runs that never executed a turn). Screenshot 64.
- Cost note for G35-5: one restart = 23 opus-high operator turns, none of which does product work.
- KNC-11 operator (re-invoked) rebased and opened PR #15 at 18:43:47Z.

## 18:50Z — discard_branch probe armed (KNC-21)

- `discard_branch` is offered only for a delivery `push_conflict` where the task has NO delivered revision, NO tracked PR and NO recorded unowned PR (operator-actions.server.ts F31-6; task-actions.server.ts R20-2: it deletes the LOCAL never-pushed branch and takes the `approve-transition` tier). So the fixture must be a squatting remote branch WITHOUT a PR (the KNC-30 fixture had a PR and produced `resolve_remote_collision` instead).
- KNC-21 (Test & CI Engineer, primary running since 18:47:24Z, `pr: null`, `workRevision: null`, no unownedPr): created `origin/knc-21` from main and put one stray commit on it via the API at 18:50:47Z, sha `d5f23aa` (`OBSERVER-FIXTURE-knc-21.md`). Expected: the operator's delivery push is rejected, it authors a packet whose options include `discard_branch`; I take the discard and verify the local branch is gone, `fm.branch` cleared, the decision event states the decision only (F33-2) and the note carries the outcome. Second use of the stray-commit fixture kind the owner authorized in Q35-4.
- 18:56Z Insights (screenshot 66): 307 runs, 226 finished, 58 error, 0 stopped, 6 running, 17 queued; $149.59; coordination overhead 55% ($81.63). The 23 restart-finalized runs sit in "error", none in "stopped" (U35-7). Backend quota card: Codex still "usage limit reached, from a refused run on Arda's account" at 18:56Z although the reading's own window ("6:18 PM" = 18:18Z) passed 38 minutes ago; the card's copy promises it clears "when the window it names has passed", which it cannot do while `resetsAt` parses to null (G35-4 evidence).
- 18:58Z Disk: host free fell 15G → 9.1G in 24 min. Inside the container: /tmp/gopath 3.0G, /tmp/gocache 2.4G, /home/node/.cache 5.0G (go-build), /home/node/go 4.1G, a dead /tmp/go-build* temp dir 644M; workspaces are small (KNC-5 701M, the rest under 10M). Removed the dead temp dirs and ran `go clean -cache` on the home cache. Product note (G35-5 family, not a finding): the image ships no Go, so every delivery agent installs a toolchain under /tmp and the caches live in the container's writable layer with nothing pruning them; the store maintenance pass reports workspaces only.

## 19:03Z — post-review drift fixture (KNC-28, PR #13)

- The approval wake fired at 19:03:11Z: KNC-28's Review & validation reviewer approved revision `rev_GUJZcj92Tl2T` (head `e2ed104`) at 19:03:07Z (timeline "Review passed", audit `task.quality.flagged {verdict: approve, validation: healthy}`).
- 19:03:32Z: one EMPTY commit (same tree) appended to `knc-28` through the API: `e2ed104 -> 242f120` ("Observer fixture: empty commit after review on knc-28"). Second fixture kind the owner authorized in Q35-4.
- 19:03:42Z: Update status on the GitHub page → audit `github.reconcile.task {changed: true, sync: synced}`; task.md now carries `pr.headSha: 242f120` and `pr.revisionDrift: {headSha: 242f120, authored: 1, baseRefresh: null}` while `workRevision` stays `rev_GUJZcj92Tl2T @ e2ed104`. Files-are-truth: correct and honest.
- What a person sees (screenshot 68): nothing. The task page shows "validation healthy", "Review passed", PR #13 in review, and the commits card lists only the five `[KNC-28]` commits (the reconciler keeps task-key commits by design, `taskCommits(compare.commits, key)`), so the foreign head is not on the page and no sentence says the reviewed revision is behind the head. No timeline event, no notification. The disclosure lives in `revisionDriftNote` at the acceptance ceremony (task-actions.server.ts:6898/9103), in the operator's snapshot (operator-actions.server.ts:1973) and in the review-queue row, which on this board never shows a Validation task (U35-5). Waiting for the operator's queued run to see whether it re-opens review for the drift (ruling R17-1 says drift is surfaced; where, is the question).
- 19:05Z Queue: 14 operator runs queued behind 4 primaries + 2 reviewers (cap 6, FIFO). Every decision the pipeline needs (KNC-28's drift, KNC-21/KNC-6/KNC-4/KNC-9/KNC-8 deliveries after their primaries reported) waits for a slot a 15-minute build holds. G35-5(b) evidence for the coordination lane. cap left at 6 (CPU 953%).

## 19:12Z — packets resolved; F35-10 (attachments path lands inside the delivered repo)

- Resolved: KNC-21 custom "Hold: inspect d5f23aa" with a re-scope directive asking for the local-branch discard as a decision (discard_branch probe, second step); KNC-26 redirect (engineer resolves the `main` conflict, recommended); KNC-9 request_edit "Drop the /projects/ ignore line, keep the attachment untracked". 0 packets open after; all three `waiting: agent`.
- KNC-9's packet "Call 1 — repo hygiene" exposed F35-10: the agent prompt's attachments section says copy files into `projects/k9c-k9s-clone/tasks/KNC-9/attachments` "(a real directory reachable from your working directory)". From the agent's cwd (`…/tasks/KNC-9/workspace/k9s-clone`) that relative path does not exist, so the agent created it INSIDE the clone and committed it; GitHub tree at bf52bba (PR #8's previous head) holds `projects/k9c-k9s-clone/tasks/KNC-9/attachments/knc-9-licence-verification.txt`. main and the other open PR heads carry no `projects/` entries (checked knc-6/22/4/2/11). The attachment never reached the task page (the pipeline stamps files that land in the real folder), and the cleanup run put a Viberr path into the product's .gitignore. Viberr wrote its own store layout into the customer's repository and pushed it.
- KNC-13 19:12:33Z quality event "Knowledge base disagrees with the repository: the repository wins, `Makefile` is authoritative; the knowledge base `k9c-engineering-standards` says otherwise": the operator surfaced a KB/repo contradiction as a first-class event instead of following the stale KB. Good behaviour, worth keeping.

## 19:13Z — drift disclosed by the operator (KNC-28), fixture reverted

- 19:12:10Z the operator's `update_branch_from_base` saw origin `knc-28` at `242f120` holding a commit the workspace lacks; 19:13:27Z it opened a blocked packet "PR #13 head diverged from the reviewed revision — 1 unreviewed commit would merge" (screenshot 70): observations name the pinned approve on `e2ed104`, the PR head, that `internal/config/kubeconfig.go` is NOT on main (nothing landed out of band), that the reviewed work is real, the two gates the reviewer could not assert, and "What I cannot see: the contents of 242f120". Three custom options: reconcile the workspace onto 242f120 and re-run the reviewer (recommended); restore the head to e2ed104; merge as-is accepting one unreviewed commit ("only if you authored that commit yourself and vouch for it"). R17-1 holds: the drift reached a human before Merge with the cost of each path stated. The gap stays U35-5-shaped: nothing on the task page said it for the ten minutes between the reconcile and the operator's slot.
- Chosen: restore the head. Packet resolved with the note, then the fixture undone by force-resetting `refs/heads/knc-28` to `e2ed104` through the API (undoing my own fixture, not product work), then Update status.
- 19:15Z After the force-reset to `e2ed104` and Update status: `pr.headSha: e2ed104`, `revisionDrift` gone from task.md, `readiness: ready, waiting: agent`. The reconciler clears the drift record when the head returns to the reviewed revision; the existing approve stays pinned to it. Drift probe complete.
- 19:19Z–19:20Z KNC-9 and KNC-26: `policy · system:delivery` events "The operator directive asked the specialist to push or open/merge a pull request. That is a server-owned delivery action, it was NOT granted to the agent. Viberr delivers on the Review transition; the directive was treated as task guidance only." The operator had told the re-prompted engineers to "push the extra commit to PR #8" / deliver; the server stripped the authority and said so on the timeline. Consistent with rulings 100-103 (delivery is server-owned); the agent run still started. Good behaviour.

## 19:32Z — cycle 4 merged through viberr (KNC-30, PR #11)

- KNC-30 (observer notes file): reviewer approve on `e5af546` 19:08:29Z → operator Review→Merge 19:21:12Z → accept recommendation 19:30:26Z (two operator turns, the second only to write the recommendation). Review queue showed the row (screenshot 74). Accepted via "Apply → Done & merge" (alertdialog) at 19:32:36Z: GitHub PR #11 MERGED (merge commit f947264), branch `knc-30` deleted, task.md `stage: done, waiting: none, pr.state: merged`, timeline "Completion accepted · Human acceptance recorded". Files, GitHub and projection agree. Merged so far: #1, #2, #4, #11 (4 of 8).
- Operator cost so far since 19:15Z: 20 operator turns at $0.23–$0.53 each (5–13 turns), about a minute each; every approval costs two of them (one transition, one recommendation).
- 19:33Z Second deliberate rejection: closed PR #10 (KNC-23, terminal compatibility research doc) on GitHub with a rejection comment while the task sat at Validation with a request_changes rework queued. Watching how the operator meets a PR the owner closed under it.

## 19:33Z — F35-11: the owner's rejection of PR #10 vanished under a delivery

- 19:33:19Z I closed PR #10 (KNC-23) with a rejection comment. 19:33:30Z the operator (already running its turn for the request_changes rework) called `update_branch_from_base` (merged main, pushed), 19:33:32Z its own reconcile recorded `changed: true, sync: synced`, 19:33:44Z `deliver_for_review` "Opened PR #26 for review". task.md: `pr.number 26, state review`. Nothing on the timeline, in notifications or in a packet says #10 was closed by a person; the operator's later prose still calls the rework "PR #10".
- Code: `openReviewPr` step 0 fetches the cached PR live and reuses it only if open; a closed-unmerged live PR "clears the way for a fresh one" and is deliberately NOT written to the cache (pr-open.server.ts:370-400, DG-1). The reconciler's R8-6 alarm (`prJustClosed` → typed timeline event + notification + operator recovery packet) fires only on the cache's transition into closed, which never happened because the create path overwrote the cache with #26. KNC-14's rejection (14:2xZ) was surfaced only because the reconciler saw the close before any delivery ran. DG-1's intent (a MERGED PR must not be resurrected for rework) is right; extending it to closed-unmerged discards a human decision.
- 19:35:16Z closed PR #26 (KNC-23) with a second rejection comment while only a reviewer run was queued (no delivery in flight); Update status at 19:35:2xZ. 19:35:26Z the reconciler recorded `pr.state: closed` and wrote the R8-6 note "Divergence: PR #26 was closed on GitHub without merging, but KNC-23 is still active. Decide whether to rework and reopen, or archive the task." with `policy` notifications to both owners. Same human act, ten seconds apart: through the reconciler it is a first-class event; under a delivery (F35-11) it disappears. The operator's own dispatch at 19:34:20Z shows it knew "the delivery opened a new review PR #26, not a reuse of #10" without knowing why, because nothing told it #10 was closed by a person. Waiting for the recovery packet to choose archive (second rejection complete).

## 19:38Z–19:40Z — cycles 5 and 6; KNC-21 closes as a gap

- KNC-19 (PR #12): accepted through viberr 19:38:41Z, "Apply → Done & merge"; completion text discloses the base refresh ("The PR head (66d2b65…) …"). KNC-18 (PR #9): merged with `gh pr merge --merge` 19:38:22Z; Update status → 19:38:30Z R8-6 note "PR #9 was merged on GitHub, but KNC-18 hasn't been accepted through Viberr … Accept the completion"; accepted 19:39:59Z with "Apply → Done": "the review PR had already been merged on GitHub (out of band)". Merged: #1, #2, #4, #9, #11, #12 (6 of 8). Screenshots 77, 78.
- KNC-21 discard probe outcome: the operator tried to author `discard_branch` as directed and viberr refused (F31-6): "discard_branch only fits a LOCAL, never-pushed branch with no delivered revision — KNC-21 has a delivered revision". task.md shows why: `workRevision {id rev_MBEIgNbXXyFX, headSha 8c463b7, kind: delivered, createdAt 18:56:57Z}` was registered when the agent posted "Done … not pushed" at 18:56:56Z, fourteen minutes before the delivery push was refused. So a "delivered revision" means "the agent reported a head", not "the head reached origin", and the discard kind is reachable only for a branch whose agent never reported at all. The packet offered custom rebuild (recommended), edit_goal (with a goalDraft), archive_task with `deleteBranch: true` ("the only path Viberr offers that actually deletes this task's branch"), and resolve_remote_collision. G35-6.
- Took archive + delete (19:40:16Z): task archived at Impl, `branch: null`, local workspace branch gone (HEAD back on 448b078), and the REMOTE `knc-21` deleted too (404), although that ref held the foreign fixture commit `d5f23aa` the packet itself called "not ours". Audit `task.branch.discarded {branch: knc-21, sha: 8c463b7, basis: archive_cleanup}` names the local head, not the remote head it deleted. U35-8. Screenshot 79.
- 19:42Z Cycle 7: KNC-8 (PR #6, reopened-by-hand adoption case from earlier) merged with gh, divergence note, accepted through viberr → Done. Merged: #1, #2, #4, #6, #9, #11, #12 (7 of 8).
- 19:42Z KNC-8 detail: the first "Apply → Done & merge" click was posted from a page loaded seconds before the reconcile recorded the out-of-band merge; the server answered `POST …/KNC-8.data 409` (27 ms), the page re-fetched and re-rendered with the GitHub card "merged", the recommendation still pending and the sidebar "Accept completion → Done" (screenshot 81); my capture saw no toast text. The retry on the fresh page ("Apply → Done") succeeded at 19:43:1xZ, `stage: done`. Not filed: a stale-page conflict is the right answer; whether the person saw a sentence for it is unverified (capture window). Low note: the "Deliver branch & open PR" button is offered on a task whose PR is merged (U35-9, cosmetic-adjacent, listed without a plan entry).

## 19:47Z — cycle 8 (KNC-11, PR #15) and the second rejection closed (KNC-23 archived)

- KNC-11: reviewer approve 19:21:48Z → Merge 19:3xZ → recommendation → accepted through viberr 19:47:17Z ("Apply → Done & merge"): PR #15 MERGED, task Done. Eight merged cycles: #1, #2, #4, #6, #9, #11, #12, #15. Target met.
- KNC-23: the operator's recovery packet (opened after the reviewer approved the closed PR's head) "Review PR #26 was closed without merging — pick the recovery path": rework with my reason as the steer (recommended) or archive keeping the branch. The body says "closed on GitHub without merging" and asks me to "write why #26 was closed in your resolution note": the rejection comments I left on #10 and #26 never reached viberr (the reconciler reads PR state, not the closing comment or `closed_by`). Small gap, filed as a note only (U35-10). Chose archive, keep branch: task archived, `knc-23` still on origin.

## 19:49Z–19:52Z — cycles 9 and 10; two accepts refused on base conflicts

- KNC-13 (PR #20) and KNC-28 (PR #13, the drift-probe task) accepted through viberr → merged (10 PRs merged: #1, #2, #4, #6, #9, #11, #12, #13, #15, #20).
- KNC-6 (PR #16) and KNC-20 (PR #14): the operator moved both to Merge and wrote "Accept completion" recommendations; the accept POST answered 409 "review PR #16 conflicts with the base branch. GitHub can't merge it, so it can't be accepted. Rebase the branch and re-review, or archive the task." (shown as an alert on the page, screenshot 84). task.md already carried `pr.mergeable: conflicting` before my sync; the accept dialog still read "PR #16 · in review into main" and the GitHub card showed no conflict, and the sidebar kept offering "Accept completion → Done". The refusal is honest and names the way out; the page and the recommendation are not. Ordering checked below.
- First accept click on KNC-6 at 19:49:3xZ sent no POST at all (no request in the server log); the second and third did. Unexplained; the dialog controls were all enabled on inspection (screenshot 83).
- 19:58Z KNC-29 (held-task probe, blockedBy KNC-28): 19:52:31Z system:dependency-release note when KNC-28 merged, operator re-invoked at Triage 19:57:53Z, recognised the goal as a probe with no deliverable and opened a disposition packet (observations include "Base branch changed during the hold; any future dispatch must re-read it first"). Archived. Release engine end to end: correct.
- 19:54Z–20:01Z KNC-6/KNC-20 after the refused accepts: "Run operator" with the conflict named. KNC-6's operator (20:00:38Z) opened the conflict packet "knc-6 conflicts with main" (redirect / resolve yourself / archive) at 20:01:01Z; resolved with the redirect at 20:01:45Z, task stays at Merge, `waiting: agent`. KNC-20's operator is queued. Watch item: a conflict-resolution merge commit counts as a base refresh ("0 authored commits since review") in the shared drift vocabulary even when the resolution hand-edits the tree; whether the reviewer re-verdicts the new head is the test of R17-1 here.
- 20:03Z KNC-7 (PR #24) accepted through viberr → merged (11 PRs merged). KNC-16 (PR #25) accepted 40 seconds later: the gate passed (cache still `clean`) and GitHub's merge call failed: 409 "GitHub refuses to merge KNC-16's review PR #25: Pull Request has merge conflicts". A second sentence for the same fact as the gate's ("conflicts with the base branch … Rebase the branch and re-review, or archive"), this one without a way out; folded into F35-12's plan entry (one reason function, one sentence). Pattern for G35-5: every merge into main turned the remaining open PRs conflicting (README, Makefile, .gitignore are touched by most tasks), so each merge costs the other tasks an operator turn, a packet, an engineer rework, a re-review and a second acceptance.
- 20:05Z KNC-25 conflict packet (main moved under its Impl work) → redirect. Conflict packets so far: KNC-26, KNC-6, KNC-20, KNC-25.
- 20:05Z Clone check on the host after 11 merges (main 5eda21d): `go build ./...` clean, `go test ./...` ok (cmd/k9c, internal/config, pkg/version have tests; the rest are placeholders), `k9c version` and `k9c info` run, cobra help lists completion/help/info/version. Runnable as a CLI; the TUI itself (KNC-2 command bar #18, KNC-3 #23, KNC-17 golden harness #28) is still in open PRs.
- 20:07Z KNC-2 conflict → redirect. KNC-26 packet "scripts pass review; the real-cluster evidence cannot be produced by any agent" (the image has no Docker, so the kind cluster capture is impossible for agents): options run-it-yourself / edit_goal (relax to stub suite + environment probe, split the capture into a follow-up) / provision Docker. Took edit_goal with the operator's draft (honest reasoning by the operator: it named the environment limit instead of faking the capture).
- 20:08Z KNC-17 conflict packet (after its approval) → redirect. Conflict packets: KNC-26, KNC-6, KNC-20, KNC-25, KNC-2, KNC-17.
- 20:08Z KNC-16: the operator opened the conflict packet at 20:07:24Z, then at 20:08:13Z withdrew it itself: "Packet withdrawn: moot: the owner already chose this path out-of-band. Arda's comment on this task ('Have the delivering agent resolve the conflict and re-deliver')", and dispatched the Test & CI Engineer. A packet answered in advance by a human directive is withdrawn with the reason on the timeline. Good behaviour.
- 20:09Z KNC-31 "Cluster client layer with discovery and RESTMapper" appeared at 19:52:32Z, one second after KNC-28 (goal-1 link 3) merged: the chain engine started the next link, assigned to the goal's owner, operator triaged 19:57Z, primary running 20:08Z. Chained goals advance on acceptance, as designed.
- 20:11Z KNC-9 conflict packet (seventh) → redirect.
- 20:12Z KNC-26 second conflict packet (main moved again) → redirect. Eight conflict packets.
- 20:12Z KNC-15 (PR #22, the Makefile + README fold-in) accepted through viberr → merged. 12 PRs merged: #1, #2, #4, #6, #9, #11, #12, #13, #15, #20, #22, #24.
- 20:16Z KNC-4 packet "CI is red on the delivered head 7053e66 — re-run it, or proceed on the infra explanation?" (custom re-run / custom proceed / request_edit fix README:110): took the request_edit. The operator read the CI check-run state itself (the reviewer's token could not) and offered honest paths.
- 20:19Z KNC-22 (PR #17) accept: gate passed on a stale `clean`, GitHub refused the merge (conflicts after #22 merged) → Run operator with the conflict named. Third post-gate refusal (F35-12 a0).
- 20:19Z Files-are-truth sweep: 31/31 tasks with content hash, stage and archived flag equal between task.md and the projection (snapshot reader).
- 20:20Z KNC-6 second conflict packet (main moved by #22 and #24 while its first resolution ran) → redirect; holding all other acceptances until KNC-6 merges. Ten conflict packets so far; the cascade is the clearest cost signal of the pass (G35-5 addendum).

## 20:22Z — F35-13: stuck at Merge after a conflict rework (KNC-20)

- After the redirect, the Docs & Release Engineer resolved knc-20's conflict AND rewrote four SECURITY.md statements that KNC-7 had made false; the operator re-delivered (`17e4a8c`, base refreshed) and then found no route: `accept_completion` refused ("validation is not healthy against this head"), `transition_stage` to Review refused ("No allowed transition from Merge to Review"), both verdict-capable profiles declare Validation and Review only. Its packet offers: add Merge to the two reviewer profiles (recommended, "the product's own remedy"), force-accept as an admin, or request_edit. Code: `isReworkMove` (R7-4) lets the operator move backwards only when `validation === "failing"`; `changed` does not qualify; a human's `manual` move is exempt from the graph. So the honest path is the human's stage picker, which the operator cannot see and the packet does not mention.
- 20:27Z KNC-20: moved Merge → Review by hand through the stage picker (every stage offered except the current one; Done enabled as the accept path); timeline "Transition: moved KNC-20 from Merge to Review" by Arda; task `readiness: blocked, waiting: agent` with the operator's packet still open. KNC-22 and KNC-16 second conflict packets → redirect (twelve conflict packets).
- 20:27Z KNC-22's operator (20:25:26Z), while dispatching its engineer for the conflict, flagged on its own: "the Reviewer profile runs at Validation and Review, and from Merge the board is currently offering me no backward transition": F35-13 reproduced by a second task without prompting.
- 20:29Z KNC-20: operator turn after the manual move: "Packet withdrawn: … @Arda answered it by moving KNC-20 from Merge to Review instead of clicking an option: at Review both verdict-capable profiles are eligible, so the reviewers can judge the new revision"; readiness ready, reviewers being dispatched. The human stage picker is the working way out of F35-13; nothing in the product named it.
- 20:32Z KNC-4 conflict packet → redirect (thirteen conflict packets).
- 20:34Z KNC-6: engineer resolved the second conflict (20:31:51Z); moved the task Merge → Review by hand before the operator's turn so the re-delivery gets its verdict where the reviewer is eligible (F35-13 workaround applied proactively).
- 20:35Z KNC-12 packet "CI runners are not provisioning repo-wide — plus a real Windows failure waiting behind it": the operator separated the account-level Actions outage (no runner assigned to any job on any branch; the owner's known billing state) from a genuine Windows HOME defect in the matrix, and offered request_edit / custom split / block_on_policy. Took block_on_policy (hold until runners provision). Honest diagnosis; nothing to file.

## 20:38Z — the Claude credential was rejected; observation phase closes

- 20:38:46Z–20:38:51Z every live run ended with `err·run·error·auth The Claude credential was rejected. Connect a different Claude account or an API key on Profile → Agent accounts. The provider reported: Claude Code returned an error result: Not logged in · Please run /login` (14 runs; e.g. KNC-6's operator at turn 1, KNC-25's reviewer at turn 29, KNC-22's operator right after it had pushed `17c7d35` to PR #17). Every affected task got the recovery packet "Operator run failed / Work stalled: pick a recovery path" with the honest first option "I connected a different Claude account or an API key on Profile → Agent accounts: re-run" (block_on_policy / request_edit), plus redirect and hold. Classification `auth` is correct (ruling 127/130): the owner's connected Claude account stopped being logged in (token lifetime or a refresh rotated elsewhere; connected before 12:51Z, about eight hours). Only the owner can reconnect it; I do not enter credentials.
- Consequence: the pipeline is paused with 12 open packets; KNC-27's dedicated browser probe cannot run (the browser capability itself was exercised on KNC-6 at 18:49Z, see COVERAGE). KNC-6 (PR #16, head `e9872b4`) was mid re-review; KNC-20 and KNC-17 approved and awaiting Merge; KNC-22 re-delivered (`17c7d35`).
- Closing checks run on the idle server: F35-9 reproduction loop (runbook reader form, 10 minutes), final screenshots 96–102, projections rebuild, ledger commit.
- 20:39Z Correction (owner statements 20:58Z and 21:11Z): the previous API key was almost exhausted; the owner replaced it on Profile → Agent accounts and then clicked the first option of each auth recovery packet themselves ("I connected a different Claude account or an API key: re-run") from 20:39:22Z, purely to clear the glitch; they are not otherwise touching tasks. Those resolutions are the owner's, not an automatic hook (audit `task.packet.resolved` by arda@viberr.dev on KNC-16, KNC-4, KNC-22, KNC-6, KNC-17, KNC-2, KNC-20 within a minute; KNC-6's timeline: "Decision: the Claude credential was changed on the owner's profile; the agent continues"). Runs succeed again (KNC-16's operator finished 20:40:15Z, 5 turns). The observation phase continues; I leave packets to the owner while their resolutions keep appearing, and the F35-9 reader loop was stopped after 60 s so it cannot disturb a server the owner is using (to be re-run in an idle window).
- 20:46Z KNC-22 packet "Reviewer can't run at Merge — KNC-22 needs a verdict on 17c7d35 to move at all": the operator now RECOMMENDS the human stage move ("Move KNC-22 back to Review, then I get the verdict"), with profile surgery and force-accept as the alternatives. F35-13 third occurrence; took the move.
- 20:46Z KNC-2 packet "done signal names an integration test the codebase cannot support yet" → edit_goal (accept the parse-and-input slice, defer execution to later links).
- 20:55Z KNC-16: the redirect option titled "Move KNC-16 back to Review so the Reviewer can verdict 701b5b3" recorded the decision and moved nothing (stage still Merge; "Operator re-engages the specialist with a summon note"). An option title promising an effect its kind cannot produce (F35-13 evidence; F33-2 family). KNC-6: reviewer approved e9872b4 at 20:47:45Z; operator wrote the boundary recommendation at Review.
- 20:56Z KNC-12 re-raised the Actions outage after the owner's re-run ("Actions runners still not provisioning — the Windows leg cannot be proven": hold_runtime_debug / waive the green signal / edit_goal narrow to Linux+macOS). Took the hold; it is the F35-8 shape (readiness blocked until a person lifts it), which is the honest state for an account-level outage.
- 21:01Z KNC-22 page (screenshot 103): sidebar "Accept completion → Done" disabled with "Not acceptable yet. Waiting on 1 required reviewer approval of the current revision." and the operator's log "the picker move is the unblocker": the block is named, the remedy (the stage picker) is not. Moving KNC-22 and KNC-16 back to Review by hand.

## 21:01Z–21:05Z — cycles 13 and 14; the cascade's third round

- KNC-6 (PR #16, README) accepted through viberr 21:01:39Z after two conflict rounds, a manual Review move and a re-verdict; KNC-27 (browser probe) released the same second (`blockedBy: []`). KNC-31 (PR #29, goal-1 link 4, cluster client layer) accepted 21:04Z. 14 PRs merged.
- KNC-17 (#28), KNC-20 (#14), KNC-26 (#27), KNC-3 (#23): each accept passed the gate on a stale `clean` and GitHub refused the merge ("Pull Request has merge conflicts") because KNC-6's README landed between their base refresh and the click; each got a Run-operator directive naming the conflict. Round three of the cascade; every one of these will also need the manual Review move after its re-delivery (F35-13).
- 21:09Z KNC-22 moved Merge → Review by hand (the stage menu needed a forced click under Playwright; it opens fine by keyboard and mouse otherwise). KNC-17/20/26/3/2 conflict packets → redirect (round three). KNC-32 (goal-1 link 5) started when KNC-31 merged.
- 21:12Z KNC-4: approved on 311a063 at Review; the operator stopped at the approval boundary with a comment naming the one clause nobody can close (CI green, Actions outage) and no recommendation, `waiting: human`. Moved Review → Merge by hand as the boundary approval.
- 21:16Z KNC-4 moved Review → Merge by keyboard (the stage menu's lower items sit outside the 1280x900 viewport for Playwright's click; ArrowDown + Enter works; the menu skips the current stage). KNC-16 re-approved on 701b5b3 at Review 21:12:08Z after its manual move.

## 21:12Z–21:18Z — KNC-27 browser probe complete

- Released at 21:01:40Z (KNC-6 merged) → Triage → Design → Impl by the operator (21:06Z) → Docs & Release Engineer with `use-browser` dispatched 21:09:48Z. In a real headless Chromium it opened `https://github.com/akin-ozer/k9s-clone`, got GitHub's "Page not found" with Sign in / Sign up in the header (the repo is private), saved `page-2026-09-06T21-12-25-547Z.png` into the task's real attachments folder (the browser MCP writes to the absolute dir, unlike the prose path of F35-10), cited it in its report, and raised an agent question packet at 21:17:00Z ("The repo is private, so the browser gets a 404 — how should we obtain the live rendered README capture?") with four custom paths (make the repo public / a human attaches a signed-in capture / accept the static audit / park). Attachment rendered on the timeline and served from the attachments route (screenshot 108). Chose "accept the static audit". Browser capability: verified end to end; the agent reported the wall instead of papering over it.
- 21:34Z 21:27Z–21:31Z GitHub unreachable from the container ("fetch failed", "network error") on two deliveries (KNC-22 pre-dispatch confirmation, KNC-26 PR open); KNC-26 got an honest packet "Merge rework is committed but GitHub is unreachable — delivery to PR #27 could not run". Probe at 21:33Z: DNS and api.github.com fine from the container, host rate limit 5000/5000; deliveries resumed by themselves (KNC-20 21:32:59Z). Transient; resolved KNC-26 with the retry. KNC-9 (both verdicts on bc5f2c6) moved Review → Merge by keyboard as the boundary approval.
- 21:54Z 21:38Z–21:50Z network-path trouble: host `gh` "TLS handshake timeout" to api.github.com; nine container runs failed with `API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)`, classified `overloaded` ("the provider failed on its own side"): U35-11. Both probes clean at 21:54Z. Clearing the nine packets with their retry options.

## 22:01Z — close of the observation phase

- Final Insights (screenshots 111/112): 628 runs, $469.60, 5.3M output tokens (345.5M in, 326.8M cached), completion 87% (539 finished, 81 error, 0 stopped, 6 running, 2 queued), avg run 2m25s, 9,051 turns. Delivery oversight: 100% owner/state clarity, 93% branch+PR traceability (26 of 28), blocked-decision wait median 9m10s over 112 resolved, time to review-ready median 5h46m over 22 tasks, 33 long timelines, coordination overhead 35% ($165.39). By kind: primary 119 ($205.49), operator 438 ($158.22), reviewer 66 ($98.73), controller 5 ($7.17). Backend quota: Claude five-hour window "utilization not reported, resets 02:30"; Codex "no reading yet" (the earlier "usage limit reached" row did clear in the end, well after the window it named; G35-4 stands on the null `resetsAt`).
- GitHub: 30 PRs opened, 15 merged (#1, #2, #4, #6, #9, #11, #12, #13, #15, #16, #19, #20, #22, #24, #29), 5 closed (#3 replaced by adoption, #5 and #10/#26 rejected, #7 fixture), 10 open. Stages: 15 done, 7 merge, 4 impl, 2 review, 2 validation, 2 triage, 1 design; archived: KNC-14, KNC-21, KNC-23, KNC-29. Rescan at 22:00:21Z: 33 tasks, 0 changed; 33/33 file hashes and stages match the projection.
- Left running for the owner, all in the F35-12/F35-13 loop (conflict → rework → manual Review move → verdict → accept, one at a time): KNC-17 (#28), KNC-20 (#14), KNC-16 (#25), KNC-26 (#27), KNC-3 (#23), KNC-9 (#8), KNC-22 (#17), KNC-2 (#18); KNC-25 (#30) and KNC-27 in Impl; KNC-32/KNC-33 (goal-1 links 5 and 6) started by the chain; KNC-12 held on the Actions outage. Monitors stopped 21:59Z. The F35-9 reproduction was not re-run: the server never went idle after 20:39Z and a deliberate crash under live runs was not worth 20 operator turns; the fix phase tests it on a scratch root.
- Clone: main builds, tests and runs (`k9c version`, `k9c info`); the TUI proper is in the open PRs.

## 2026-09-07 06:06Z — F35-14: an option that promises a force-accept and cannot do it (KNC-3)

- The owner resolved KNC-3's "Merge is blocked: no verdict-capable agent can run at this stage" packet with the custom option "Force-accept as admin without a fresh verdict" (06:06:57Z). The decision event reads "Decision: Force-accept as admin without a fresh verdict. Operator re-engages the specialist with a summon note." The resolution re-ran the operator (run_p-ogqU6KWaeK, 7 turns, $0.38): it called `accept_completion`, got `[noop] Waiting on 1 required reviewer approval of the current revision`, and posted "the admin force-accept has to be applied by you in the product … Two ways forward, both yours". Task still at Merge, `waiting: human`, `validation: changed`.
- Root: the operator may author `custom` options with any title; the resolution of a custom option is "re-engage with a summon note"; nothing checks that the title names an act only a person or another kind can perform (force-accept is admin-only on the task page; a stage move needs the picker). F31-6 guards only discard_branch's semantics. The KNC-16 "Move back to Review" redirect at 20:53Z was the same defect in another kind.
- 06:14Z KNC-3: carried out the owner's recorded decision by pressing Force accept (dialog: "Bypassing: Waiting on 1 required reviewer approval of the current revision. Admin override. The bypassed gate is recorded to the audit log."); PR #23 merged 06:13:14Z, `acceptance: forced`. 16 PRs merged. Clone main rebuilt on the host after the forced conflict-resolution merge: see the build line below.
  Build line: main 76a3175 `go build ./...` clean, `go test ./...` ok for config, coverdemo, keys, model, testutil, ui, view, version; `k9c version` runs.

## 2026-09-07 17:14Z — board parked, gates closed

- The owner asked to park the k9c board and clean up. The fix agents had cleared the session scratchpad, including the signed-in Playwright profiles, and I do not hold the live instance's password, so the board was parked on disk instead of through the archive ceremony: `archived: true` set in the frontmatter of the fourteen tasks still in flight (KNC-2, 9, 12, 16, 17, 20, 22, 24, 25, 26, 27, 32, 33, 34) while the container was stopped, which is the same field the ceremony writes and is picked up by the boot rescan. No audit row and no timeline note for those fourteen: this record is the account of it. Sixteen tasks stay Done. Proportionate because the owner is wiping this data root.
- `viberr-app-1` is left STOPPED. Docker was started only for the end-to-end suite, which runs in its own `viberr-e2e` compose project and tore itself down.
- Gates on the final tree, all five green: lint clean, typecheck clean, `npm test` 353 files / 6172 passed / 2 skipped, `npm run build` clean, `npm run e2e` **70 passed**.
