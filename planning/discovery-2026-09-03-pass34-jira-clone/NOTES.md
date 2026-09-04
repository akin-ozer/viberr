# Pass 34 — observation notes (2026-09-03): Viberr builds a Jira clone

Running log of what happened while Viberr's own controller, operators and agents built
`akin-ozer/jira-clone`. I (the session) am the OBSERVER: I drive the controller, watch
every surface, and check that what Viberr shows matches what happened on disk, in the
projections, in the audit log and on GitHub. Findings with an id (`F34-*` defect,
`U34-*` UX, `D34-*` doc/canon, `Q34-*` owner question, `G34-*` gap) live in
[FINDINGS.md](FINDINGS.md). Owner questions with background live in
[QUESTIONS.md](QUESTIONS.md).

## Environment

- Container `viberr-app-1` on :5173, image built 2026-09-03T07:39:30Z from `main` @
  `2a098e89` (ruling 127 merged). Data root `docker-data/` (host bind → `/data`), FRESH
  at 10:39 local; one user `arda@viberr.dev` (org admin, `u_GM6HRspkfhMA`) with Claude
  connected via hosted login at 10:40, one GitHub connection `akin-ozer` (default).
  Controller profile pre-set by the owner to `model: claude-fable-5[1m]`, `effort: max`.
- `akin-ozer/jira-clone` is EMPTY (no branches, no commits, no PRs) at start.
- Observation harness: `scratchpad/driver.mjs` (Playwright 1.62.1, HTTP on :4998,
  contexts per user × viewport, light/dark via `emulateMedia`), plus the in-app Browser
  pane for cross-checks. Screenshots copied into `screenshots/` when they show something.

## Ground rules for this pass (from the owner)

- I never write jira-clone code and never push to that repo by hand.
- Everything Viberr cannot create, or creates broken, is a finding; no quiet hand-fixes.
- Every agent on fable; a surface that refuses fable is a finding.
- Reject a couple of jira-clone PRs, let one diverge after review; merge the rest with `gh`.
- Credentials are entered by the owner only.

## Timeline of the run

(UTC timestamps; local is UTC+3)

- 07:58Z signed in as `arda@viberr.dev` (driver + pane). Baseline screenshots `00-*`
  (Home empty state, light/dark/mobile; Profile with Claude "connected · verified";
  Instance settings). The owner's live model catalog for Claude lists `default`
  (Opus 5 1M), `opus[1m]`, `claude-fable-5[1m]` (Fable), `sonnet`, `haiku`.
  NOTE for later: `resolveClaudeModel("opus[1m]")` maps to bare `opus` (the `[1m]` is
  dropped silently) and a bare `fable` is not an alias at all (falls to the SDK default).
- 08:00Z sent the goal to the controller from the dock on Home (message recorded with
  surface `/`, "from Home" chip on the full page). Run `run_s2xLJ0-4tkwT` on
  `claude-fable-5[1m]` failed in 1.7 s: HTTP 403 `oauth_org_not_allowed` — the account
  connected in Viberr is `codex@hepapi.com` (Max 20x) and that org has Claude Code
  subscription access disabled. Classified `run·error·unknown`; the controller replied
  "Say it again to retry" (F34-1, U34-1). The Profile card still reads "connected ·
  verified" — the health probe is presence-only by design (ruling 127), so nothing in
  the product tells the person their account cannot run.
- Asked the owner (AskUserQuestion). Owner: enable Claude Code in the hepapi org and
  keep this account. Retrying the same request from the dock.
- 08:50:51Z retry sent from the dock (Home). Run `run_Lk5GsZnel_jn`, `resumed: true`
  on the same session `c0470ecd` (the SDK had created the session before the 403). It is
  working. Screenshots `02-*`: full page and dock, light/dark, "Controller is working…"
  line and the trigger's live-dot; at 1440×900 the dock header (name, scope pill,
  Threads / New / Open page / Close) is fully visible. In the Browser pane at 1280×720
  the panel's header row sits under the topbar (only the context line shows) — noted,
  not filed (cosmetic unless Close becomes unreachable; verify at 720 px later).
- Read ahead for the empty-repo path: `ensureTaskBranch` has a typed
  `default_branch_missing` arm (branch-sync.server.ts:479) — what the operator and the
  deliverer do with it is the thing to watch.
- 08:53:55Z–08:54:03Z the controller spent its first three tool calls on `ToolSearch`:
  in this Claude Code build (2.1.220) the MCP tool schemas are DEFERRED and the model has
  to fetch them by name before it can call them. Harmless, ~10 s per turn, but note that
  the doctrine and the skill never mention it; the model worked it out on its own.
- 08:55:55Z `create_project` → `jira-clone` (key JC, policy balanced) with the custom
  workflow Backlog → Spec/Design → Implementation → QA → Review → Done, boundaries
  auto·auto·auto·approval·human, and the controller's own stack decision in the
  description: Next.js 15 App Router + TypeScript strict, Prisma + PostgreSQL 16
  (docker-compose), Tailwind, Auth.js, Vitest + Playwright. `project.md` matches the call
  exactly (ids `backlog`, `spec-design`, `implementation`, `qa`, `review`, `done`;
  Review→Done `locked: true`). Audit: `github.credential.assigned`,
  `github.credential.revalidated` (valid), `project.created` (template custom, 6 stages).
  The GitHub page reads "connected · akin-ozer/jira-clone · default main" although the
  repository has no branch at all — GitHub's `default_branch` field says `main` for an
  empty repo, and nothing probes for a ref. Watch what the first delivery does with that.
- Boot backfill had ALREADY deployed the seeded Developer (sonnet, claude+codex) and
  Reviewer (sonnet) onto the new project (`ensureBaseAgentsDeployed` puts both into a
  project with no specialists). The controller's `list_global_agents` saw both. Screens
  `03-*` (board empty, GitHub, Policy, Settings).
- 08:56Z–09:01Z the controller's setup turn (40 turns, 618 s, $4.38, 46.5k output tokens):
  2 KBs (`jc-conventions`, `jc-product-brief`), 2 skills (`jc-nextjs-prisma-delivery`,
  `jc-playwright-qa`), 1 MCP server (`playwright-browser` = `npx @playwright/mcp@latest
  --headless --isolated`, probe found 24 tools), 4 global templates (`jc-spec-writer`,
  `jc-developer`, `jc-reviewer`, `jc-qa-tester`; templates store `model: ""` and every
  grant `off` — the tool cannot set model/effort/grants on a template), all four deployed,
  then `update_agent_deployment` ×4 with `model: claude-fable-5` (no `[1m]`) and
  INVENTED capability ids (`branch`, `commit`, `push`, `open_pr`, `verdict`, `browser`) —
  every call answered `[done]`; nothing but the model landed (**F34-2**). Operator set to
  full autonomy, then the controller read the governance notice ("performs
  approval-boundary transitions itself"), said so, and reverted to supervised — a good
  catch by the model, and the notice earned its keep. Five goals (5+6+5+5+5 = 26 links),
  five first-link tasks JC-1…JC-5; the controller dispatched `jc-spec-writer` on JC-1 and
  deliberately left JC-2…5 alone ("five agents racing to create main would collide").
  Honest about effort: "there is no effort setting anywhere … exposed to me" (**G34-1**).
  Its report claims "branch/commit/push/PR direct" for all four agents — false (F34-2).
- 08:59:33Z, 08:59:41Z, 08:59:47Z three `project.agent_profile.updated` audit rows by
  plain `arda@viberr.dev` (no "· via controller") on Operator, Developer, Reviewer, and
  those three deployments now carry `effort: max` — the OWNER editing in the UI while the
  controller worked (the four jc-* deployments stay at `effort: high`). To confirm with
  the owner; it is the one write this session did not make.
- 09:00Z every task's operator fired on `create`: JC-1's crossed backlog→spec-design
  (auto) and, re-triggered, saw the engaged spec writer and stopped ($0.35). JC-2…JC-5's
  each read the (non-existent) default branch and opened a **blocked** packet
  "prerequisite unmet — no main branch exists yet" (each ~$0.75–0.85). The spec writer on
  JC-1 is a SUPPORTING run (`delivers: false`, writes denied) because its repo-write
  grant is off (F34-2); the timeline got the honest policy line "the operator directive
  asked the specialist to push … NOT granted", and the agent itself said so in its first
  comment, then wrote the bootstrap files into `attachments/bootstrap-files.md` with
  `cat >` (Bash is not denied for supporting runs; only Edit/Write and git commit/push).
- 09:04:55Z the spec writer finished (supporting run, ~4.5 min): wrote `product.md`,
  `architecture.md`, `bootstrap-files.md` into the task's `attachments/` (Bash heredocs —
  the only write channel a supporting run keeps) and posted a long, honest comment:
  "this run was dispatched as a supporting agent … withholds git commit, git push, and
  PR creation … the done signal is not yet met", tagging `@Arda @operator`, with five
  evidence rows and three attachment rows. The notification inbox got the mention
  ("JC Spec Writer mentioned you") and the four blocked packets ("Waiting on you · 4
  decisions"); Home reads "1 run active across 1 project, 4 decisions waiting on you".
  The operator on JC-1 woke on `agent-reply` (run_JcvloknBsE5Q).
- 09:05Z sent the controller (instance thread, from Home) the grant correction, phrased
  from the Agents page's own labels ("Execute code or write to the repo", …) — the
  test is whether a model that has NO read of capability ids can map the UI names to
  catalog ids. Working.
- 09:05Z candidate U34-2: ONE `Minified React error #418` (hydration text mismatch) in
  the page console when JC-1 was loaded while the operator run was live (Live run strip:
  "Working · mcp__viberr__get_task · ELAPSED 00:34", "Last activity just now"). Three
  reloads of JC-1, JC-2, the board and Activity afterwards: clean. Time-dependent text
  during a live run is the suspect (elapsed counter or relative time); reproduce with a
  run in flight before filing.
- Mobile (390×844) screens `08-*`: board reflows to two visible columns with the
  filter chips stacked; the task page and the dock bottom sheet work. Cosmetic, NOT
  filed: on a mobile card the stage-move chevron control overlaps the readiness pill
  ("blo…" of "blocked" is hidden under it); on the mobile sheet the floating trigger
  sits over the sheet's third header button ("Open the full controller page").
- Attachment card (ruling 105) on JC-1: `architecture.md` opens in the monospace reader
  with Download / Open original / Close; the `.md` renders as source, not as markdown.
- 09:07:27Z the JC-1 operator (agent-reply, 10 turns, $1.29) read the three attachments
  and dispatched the STOCK `developer` as the delivering agent ("only deployed profile
  holding the delivery capability … eligible for the current stage"), with a precise
  verbatim-apply prompt: bootstrap commit on `main`, then branch
  `jc/JC-1-product-spec`, stop at local commits. Why the stock Developer is eligible at
  Spec/Design: its declared stages `ready, impl` resolve by ALIAS on this board —
  `ready` → the stage after entry when work is not adjacent (= Spec/Design), `impl` →
  the work role = the stage with an edge into Review (= **QA**, not Implementation).
  The alias table makes the stock Developer eligible at Spec/Design and QA but NOT at
  the stage literally named "Implementation". Quirk, honest on the profile page.
- Pre-dispatch branch allocation on JC-1 hit `default_branch_missing` (no `main` ref)
  and said NOTHING: `ensureTaskBranchBestEffort` swallows every typed result, so the
  audit has no `github.branch.*` row, the timeline no note, `task.md` `branch: null`,
  and the deliverer's `run·inputs` carries `branch: ""`. The agent's only branch name
  comes from the goal text ("jc/<task-key>-product-spec"). Candidate **F34-3** — file
  once the delivery attempt shows what a human sees.
- 09:08Z the controller's grant fix, second attempt: `capabilityId: "delivery"`,
  `"verdict"`, `"browser"` — read off the operator's `get_task` snapshot flags in the
  run log it inspected through `viberr_ops`. Same tool, same silent `[done]`.
- 09:10:46Z the controller's "verification pass" operator run on JC-1 (manual trigger
  while the Developer was live) posted an honest table read from `get_task`: every jc-*
  profile `delivery false · verdict false · browser false · effort high`, and flagged the
  reviewer/tester consequences. So the OPERATOR can read resolved grants, the CONTROLLER
  cannot — it had to spend an operator turn to learn what a `get_project` read should
  say (folds into F34-2). Its JC-2 attempt was refused: a packet is open there.
- 09:11:28Z the stock Developer finished JC-1 (~4 min): two local commits, `main` =
  root `d2e0fb0` (README, .gitignore, LICENSE, docs/specs/README.md) and `jc-1` =
  `06b70c5` (both specs), verified byte-identical with `cmp`, Mermaid parsed with
  mermaid@11 under jsdom; it put the spec commit on the contract's `jc-1`, not the
  goal's `jc/JC-1-product-spec`, and said so. The workspace reconcile minted work
  revision `rev_iLmVvwa4lEJV` (head `06b70c5`, branch `jc-1`), wrote `branch: jc-1`,
  audit `github.workspace.branch_reconciled {commits: 0}` (the `origin/main..HEAD`
  count cannot run without `origin/main`). Nothing is on GitHub yet: the repo still has
  no branch. Now the operator's delivery decision (run_-DwacO-vRt0Z).
- 09:11:42Z–09:11:50Z the controller shotgunned ten guessed capability slugs per
  `update_agent_deployment` call (after `delivery`/`verdict`/`browser` and an undeclared
  `effort: max` all answered `[done]`). Landed by luck: repo-write, commit/push, open-PR
  on writer/developer/tester and the verdict on the reviewer. Missed: `create-task-branch`
  (guessed `create-task-key-branch`) and `use-browser` (guessed `drive-a-live-web-browser`
  …). Effort stays `high`. Detail in FINDINGS F34-2.
- **09:12:46Z the container DIED with exit code 135 (SIGBUS)** and compose restarted it
  (`restart: unless-stopped`, RestartCount 1, no OOM). No app log line precedes the
  death. Prime suspect: ME — from 09:01Z two host-side monitors ran `sqlite3 -readonly`
  against `docker-data/state/projection.sqlite` every 5–8 s (plus ad-hoc queries), i.e.
  a HOST process mmap-ing the WAL `-shm` of a database the GUEST process writes, over
  the VirtioFS bind mount; a stale shared mapping in the guest is exactly what SIGBUS
  looks like. All host-side readers were stopped at 09:14Z and replaced by
  `docker exec … node:sqlite` (read-only, inside the guest). If the crash never recurs,
  that is the cause. NOTE the runbook's own diagnostics section (line ~197) tells an
  operator to run `sqlite3 "$VIBERR_DATA_ROOT/state/projection.sqlite"` on the host —
  on a Docker-Desktop deployment that is the same hazard (candidate D34-1).
  What Viberr did with the crash (all correct): boot finalized the 2 live runs as
  `error · interruptedBy: restart` (the controller's grant turn and the JC-1 operator's
  delivery turn), wrote the honest "interrupted by a server restart" line into the
  controller transcript, re-drove the JC-1 operator (`run.recovery.reinvoked attempt 1`,
  run_2YPx3YMrPtPI), skipped the workspace reclaim ("runs are in flight"), and took
  over the stale writer lock (bootId differs). Work on disk (both local commits) is
  intact.
- 09:13:50Z–09:14:31Z the re-driven JC-1 operator called `deliver_for_review` twice.
  Server log: `pushed workspace branch to origin {branch: jc-1, commitsUnknown: true}`
  then `review PR not opened {reason: network_unavailable}` — both times. GitHub now
  has ONE branch, `jc-1`, and because the repository was empty GitHub made it the
  repository's DEFAULT branch (`default_branch: "jc-1"`); `main` does not exist and
  nothing in Viberr will ever push it (delivery pushes the task branch only). The tool
  result, the timeline (`github · system:delivery`: "No pull request could be opened for
  JC-1: GitHub was unreachable (network error). Fix the repository/credential settings,
  then deliver again."), the audit (`github.delivery.operator {status: failed}`) and the
  operator's blocked packet ("Restore GitHub connectivity, then resolve — I re-deliver" /
  "Hold runtime to debug GitHub access") all say NETWORK. GitHub was reachable the whole
  time (the reconcile at 09:12:48Z succeeded, the push succeeded twice). **F34-4.**
- 09:17:28Z pressed **Deliver branch & open PR** on JC-1 as the human: same outcome,
  `github.delivery.manual {status: failed}` and the same "GitHub was unreachable" line
  on the timeline; the GitHub page's Update status right after reads "Checked just now",
  branch `jc-1`, `not compared`, 0 PRs. Probe of GitHub's own answer for the PR (fails by
  construction, creates nothing): 422 `{"resource":"PullRequest","field":"base","code":
  "invalid"}` — base `main` does not exist. F34-4 written up in FINDINGS.
- 09:19Z–09:21Z owner rulings (QUESTIONS Q34-2..4): Viberr will bootstrap `main`
  itself (fix phase); to unblock now I created `refs/heads/main` at the Developer's own
  root commit `d2e0fb0` through the GitHub API and switched the default branch back
  from `jc-1` to `main` (09:21Z). The owner confirmed the 08:59Z UI edits were theirs
  and asked for effort max on the jc-* deployments through the Agents UI.
- Hazard noticed while opening the profile editor: the modal is a FULL-form submit
  (name, role, backend, model, effort, stages, persona, every capability). Saving a
  modal opened BEFORE the controller's concurrent `update_agent_deployment` writes
  would re-submit the stale capability rows and silently revert them (last write wins
  on the whole record, no version check). I cancelled and will re-open fresh once the
  controller's turn ends. FILED as U34-3 (2026-09-04, confirmed against the code:
  `agent-profile-actions.server.ts:665-672`); the fix is TODO item B5.
- 09:22:36Z controller reply #3 (12 turns, $2.34): honest and sharp — it read the audit
  log to prove which grants landed, named the defect itself ("`update_agent_deployment`
  returns `[done]` even when a capabilityId doesn't exist — unknown ids are dropped
  silently"), marked its own earlier "all direct" report as wrong, reported the effort
  calls as "returned `[done]` and demonstrably changed nothing", and doubted the
  delivery failure ("Oddly, the project's GitHub state reads `connected` … may be
  transient runner egress"). Its final shotgun at 09:21Z did include the real ids
  (`create-task-branch`, `use-browser`), so on disk every jc-* grant is now right —
  which the controller could not see and reported as "unverified". Its only window into
  resolved grants is an operator run, and open packets refuse those.
- 09:23Z set effort max on the four jc-* deployments through the Agents UI editor
  (owner's answer Q34-4); one `409 Conflict` in the browser console during the four
  saves, to be identified.
- 09:22:52Z resolved JC-1's packet (option 1, no confirm dialog for a `custom` option;
  the decision is recorded as a `transition`-typed timeline event "Decision: … Operator
  re-engages the specialist with a summon note"); the operator re-queued
  (run_RWXBf3W0xKrX).
- 09:24Z Insights snapshot (`15-insights-*`): 17 runs · $17.67 · 157.1K output tokens ·
  completion 81% (13 finished, 3 error, 1 running) · coordination overhead **76%**
  (operator + controller $13.50 of $17.67) · "Branch & PR traceability 0 of 1 delivered
  tasks carry branch + PR" · blocked-decision wait median 8m22s, 4 open. By model:
  `claude-fable-5` 13 runs, `claude-fable-5[1m]` 4 (the controller).
- **09:25:39Z first real delivery**: the packet-resolved operator turn on JC-1 called
  `deliver_for_review` once → `[done] Delivered: push succeeded, opened review PR #1`.
  GitHub: PR #1 "[JC-1] Bootstrap repo + product & architecture spec", `jc-1` → `main`,
  +443/−0, 2 files, 1 commit (`06b70c5`); body = "**Viberr task:** JC-1" (no link:
  `BETTER_AUTH_URL` unset, as documented), the goal, change summary, evidence rows and
  the human-merge footer. The operator's reason text repeats the false premise it was
  given ("Arda restored GitHub connectivity") — the packet copy propagates the F34-4
  lie into the audit trail.
- 09:26:17Z–09:26:31Z resolved the four hold packets on JC-2…JC-5 (each option 1, all
  recorded as `transition`-typed "Decision:" events with the generic trailer "Operator
  re-engages the specialist with a summon note" — the trailer is wrong for a hold
  packet with no specialist, cosmetic). Four operator re-checks started in parallel.
- Method trap (Browser pane): `form_input` on the dock's textarea followed by a Send
  click IN THE SAME BATCH posts nothing on the first try (the React-controlled textarea
  has not committed the synthetic value yet, Send stays disabled); a second click in a
  later batch posts it. Verify every send against `controller_messages` before waiting.
- 09:30Z asked the controller (instance thread) to create four local users and seat
  three of them on Jira Clone (maintainer / contributor / viewer) plus one org member
  with no project membership — the RBAC probe set for later.
- 09:31:42Z controller created the four probe users (14 turns, $1.92): `create_user` ×4
  (org member each, temp passwords relayed in chat as the doctrine requires),
  `invite_member` ×3, then `set_member_role` for Maya → maintainer and Omar →
  contributor because `invite_member` seats everyone as **Viewer** while its own tool
  description promises contributor (the controller noticed and corrected; U34-5). It
  verified the roster with a fresh `get_project`. Its closing "board status" paragraph
  is STALE (still describes the JC-1 GitHub block and the four held packets): the
  instance-scope context block carries only the project list, and the model did not
  re-read the board — fine for a user-admin turn, but it shows the digest can lag.
- 09:31Z the Agents **Live** tab: "Developer · JC-1 · delivering · working" with no
  Developer run alive (F34-5).
- 09:36:23Z JC-5's spec writer finished: `docs/specs/testing.md` (313 lines) as a ROOT
  commit on `jc-5` — "this workspace's local checkout contained zero commits, and it has
  no GitHub credentials, so git fetch fails and I could not pull main". The mirror
  (`.repo-mirror/akin-ozer__jira-clone.git`) has `main` and `jc-2…jc-5` at `d2e0fb0`;
  the task workspaces were cloned by the operators' first triage at 09:00Z from an
  EMPTY repo and reused as-is at 09:28Z (`cloneRepo` reuse path: sanitize remote, set
  identity, strip catalog — no fetch). JC-2 did the same (root commit `f251897`); JC-3
  and JC-4 checkouts still have no commits. **F34-6.** The delivery of an unrelated
  history against `main` is next.
- 09:38:17Z the stock Reviewer approved JC-1 (validation `healthy`, verdict bound to
  `rev_iLmVvwa4lEJV`); 09:40:05Z the JC-1 operator left ONE recommendation (QA → Review
  is the approval boundary; supervised → recommends). JC-1 now waits on a human.
- 09:38:15Z JC-4's spec writer used `ask_human`: an "Agent question" packet titled
  "JC-4 workspace had an empty clone of the repo — how should the finished search spec
  reach a PR off the real main?", recommending "Reprovision this workspace with a
  working clone of main and resume me" — a correct diagnosis of F34-6 by the agent, and
  an option Viberr has no action for. JC-2, JC-3, JC-5 reached the same wall through
  their operators (`update_branch_from_base` → "refusing to merge unrelated histories"
  → blocked packets).
- **09:40:28Z–09:40:42Z QUOTA: three operator runs died with "You've hit your session
  limit · resets 11:50am (UTC)"**, classified `run·error·unknown` (F34-1 addendum). The
  owner's Claude account (Max 20x) is out of its 5-hour window until 11:50Z; every
  Claude run on the instance will refuse until then. `backendRateLimit.claude` reads
  `rejected` (from the rate_limit_event envelope) but `backendQuotaExhausted` was never
  written. Using the pause for run-free surfaces (workspace repair per Q34-6, RBAC
  probes, settings surfaces).
- Owner rulings Q34-5/Q34-6 (09:41Z): the F34-6 fix is "refresh on every reuse" (fetch
  the mirror's heads into origin/*; fast-forward an unborn or clean default-branch
  checkout; leave a diverged task branch to `update_branch_from_base`); the unblock now
  is a by-hand repair of the four workspaces (fetch + `rebase --onto origin/main --root`).
- 09:43Z manual unblock (Q34-6): in each of JC-2…JC-5's `workspace/jira-clone` I ran
  `git fetch <mirror> +refs/heads/*:refs/remotes/origin/*` and
  `git rebase --onto origin/main --root <task-branch>`; all four task branches now sit
  one commit above `d2e0fb0` (merge-base = main): JC-2 `f175a76`, JC-3 `2a12456`,
  JC-4 `2d912bc`, JC-5 `04e88a2`. No run was live. Nothing pushed. The agents' commits
  are preserved (rewritten shas). Deliveries can proceed once the Claude window resets.
- The failed-operator packet copy on JC-2 reads "Retry on the other backend, fix the
  credential, or redirect the task" for a quota refusal, and the Agent-logs footer calls
  it a "continuity error"; Insights' quota card reads "rejected · resets Sep 3, 2026"
  (from the rate-limit envelope) — the date without the hour the provider gave.
- 09:43:24Z–09:44:06Z the OWNER disconnected the exhausted `codex@hepapi.com` Claude
  login on Profile → Agent accounts and connected `realvega1534@gmail.com` (Max 20x)
  instead (audit `profile.backend.disconnected` → `login_started` → `connected`; the
  per-person home now holds the new account's sign-in). Owner suggestion, recorded as
  Q34-7: a quota-refusal packet should OFFER switching the account ("connect a different
  Claude account on your Profile and re-run"), instead of "fix the credential". Verifying
  that runs work on the new account by resolving JC-2's failed-operator packet with
  "I've updated the policy / credential — unblock and re-run" (the block_on_policy kind).
- 09:48:05Z–09:48:18Z the owner (plain actor) re-saved the stock Developer, Reviewer
  and Operator deployments: model now `opus[1m]` (Operator effort max). The JC-2
  operator started 09:48:31Z on the NEW account: run row `model=opus[1m]`, SDK init
  `claude-opus-5`, `credential_user_id` still `u_GM6HRspkfhMA` — so the switch of
  accounts took effect (the run got past init and read the task) and the person, not
  the account, is the principal. `resolveClaudeModel("opus[1m]")` → `opus`: the 1M
  variant is silently dropped on the alias path (**F34-7**). Asked the owner whether the
  Opus switch was deliberate.
- 09:48Z resolved JC-2's failed-operator packet with `block_on_policy` ("I've updated
  the policy / credential — unblock and re-run"): the packet cleared, the operator
  re-ran. This is the kind's intended use (ruling 76) and it worked as documented.
- RBAC probes (09:47Z–09:52Z; screenshots `20-*`). First sign-in with the controller's
  temp password lands on "Set a new password · You signed in with a temporary password"
  and `Save & continue` (forced reset works). **Vic (viewer)** on JC-1: no Apply/Dismiss,
  no Run operator, no agent picker, no Archive, no Assign me, no Edit details; the
  Permissions card reads "Comments: You can comment (every project member can) · Task
  ownership: View only (contributor+ to own) · Accept completion: Maintainer, admin, or
  the task's own owner · Run agents: Maintainer or admin only"; Settings renders
  "Read-only. Editing project settings needs the Edit workflow & policy grant (project
  admin)" with the values shown (ruling 125 holds). **Nadia (org member, non-member)**:
  board, task page and an attachment URL all answer "Page not found · No project at
  projects/jira-clone" (404 parity, ruling 25); `/insights` and `/org/settings` answer
  "Error 403 · This area requires the admin role"; `/controller` opens for her with
  "Claude not connected" and a disabled composer (ruling 127 — her own account, not the
  instance). **Maya (maintainer)**: Apply/Dismiss on the recommendation, "You can accept
  → Done", "You can run agents", no Force accept (admin-only).
- 09:51:28Z **Maya (maintainer) applied the operator's QA → Review recommendation** on
  JC-1 — the approval boundary crossed by a non-admin human through the recommendation
  card (`transition · user:u_WPoAjYJMk0rL (Maya Chen)`), operator re-triggered.
- 09:51Z JC-2 delivered from the repaired workspace: **PR #2 "[JC-2] Issues module
  spec"** (`jc-2` → `main`). The repair (Q34-6) worked; the operator's ordinary
  `deliver_for_review` path did the rest.
- Server-side RBAC probes (POSTs with a real CSRF token from Home): see next entry.
- **09:54:13Z FIRST FULL CYCLE.** Accepted JC-1 from the operator's `accept_completion`
  recommendation: the "Accept completion dialog" disclosed APPLYING / MERGES "PR #1 · in
  review into main" / REVISION 06b70c542894 / VERDICT "validation healthy" with "Not yet"
  and "Apply → Done & merge" (ruling 88 echo). Then, in order: `github.pr.merged` (merge
  commit `90cd96f9`), `github.branch.deleted jc-1` (guardrail on), `task.transition
  {to: done, via: accept_completion}`, `task.recommendation.applied`, and the goal
  reconciler created **JC-6 "Scaffold the app skeleton with CI"** (actor `arda@viberr.dev
  · via controller · goal chain`, owner seat = the creator) and started its operator;
  `goal-1.md` timeline: "Link 1 completed by JC-1 · Link 2 started as JC-6". GitHub
  agrees on every fact (PR MERGED at 09:54:13Z, `jc-1` gone, `main` moved). task.md:
  `stage: done · waiting: none · validation: healthy · pr.state: merged`. Files, GitHub,
  projections and UI all say the same thing.
- 09:55Z–09:56Z PRs **#3 "[JC-3] Boards & sprints spec"** and **#4 "[JC-5] Test
  strategy"** opened by the operators after the packet resolutions (JC-3 `block_on_policy`
  re-run; JC-5 custom directive). JC-4's spec writer RESUMED from the `ask_human` packet
  answer (option 1) — the asker-resume path (ruling 33) — and is re-delivering.
- Server-side RBAC (POSTs with the root-loader CSRF token in `X-Csrf-Token`): viewer
  `transition` → 403; contributor `run-operator` → 403; contributor `archive-task` →
  403; non-member `comment` → **404** (parity holds on writes too); viewer `comment` →
  400 (my field name; the viewer may comment per the matrix). UI hiding and server
  refusal agree for every probe.
- 09:57:21Z **schedule**: on JC-2 chose "in 5 min" on the Run-operator control with a
  steer → `schedules[]` entry `sch_67dreWuI7DAz` (`run-operator`, dueAt 10:02:21Z,
  createdBy Arda, status pending), toast "Scheduled · operator re-run in 5 min", a
  `note` on the timeline and a row under the control with **Cancel**. (My first attempt
  passed the value `5m`; the picker's values are minutes — `5`, `60`, `360`, `1440` —
  so it fell through to Now and queued a run with the steer as an `@operator` comment.)
- 09:56:57Z **mentions**: composer picker offered "Maya Chen · @maya · maya@viberr.dev"
  on `@May`; `@Nad` offered nobody (non-member); the posted comment got the
  policy-engine trailer "_@nadia is not a member of this project, so nobody was
  notified — add them to the project first, or mention a member._" (pass-33 F33-9 fix
  visible). Maya's inbox shows the mention AND the maintainers' "Decision needed" for
  JC-3's packet.
- 09:56:00Z/09:56:03Z out-of-band on GitHub with `gh`: **merged PR #2** (JC-2) and
  **closed PR #3** (JC-3, rejection). 09:57:31Z forced "Update status": the reconciler
  wrote both divergence notes exactly as documented — JC-2 "PR #2 was merged on GitHub,
  but JC-2 hasn't been accepted through Viberr … Accept the completion (or move it to
  Done)"; JC-3 "PR #3 was closed on GitHub without merging, but JC-3 is still active.
  Decide whether to rework and reopen, or archive the task." — and the GitHub page lists
  #1 merged, #2 merged, #3 closed, #4 in review, with `jc-3/jc-4/jc-5 behind main`.
  JC-3 already carried the operator's own "spec diverges from architecture.md" input
  packet (request_edit ×2, custom ×2) when the close landed — watching how the
  `pr-diverged` recovery packet coexists with an open packet.
- 09:59:18Z–09:59:33Z the JC-3 operator's `pr-diverged` turn: **withdrew its own
  open packet** ("Overtaken by events: PR #3 was closed on GitHub without merging, so
  none of this packet's four options are executable … the unanswered architecture.md
  divergence question is carried into it") and opened the recovery packet "PR #3 was
  closed without merging — pick a recovery path" with three options: rework on jc-3
  with the human's note as the steer (recommended), `archive_task` keeping the branch,
  `archive_task` + `deleteBranch: true` ("Irreversible"). Observations name the anchored
  `origin/main` read (spec absent), the branch content, the done signal, the carried-over
  divergences and goal-3's downstream. It also says reopening #3 on GitHub is equally
  valid and would withdraw the packet automatically. Exemplary rejection handling —
  the one-packet-per-task rule was honoured by replacing, not stacking.
- 10:01:58Z–10:02:00Z **guardrails** on the Policy page: switched "No duplicate
  summaries" off and set the compression threshold 40 → 25 (Apply). `project.md`
  `guardrails[]` updated; audit `project.policy.guardrail_changed` ×2 carrying
  `beforeOn/beforeValue`; the card reads "3 of 4 enforced guardrails on".
- 10:02:20Z **task-anchored dock** on JC-2 ("Controller · JC-2 · Jira Clone"): asked for
  priority high, labels spec+issues, due 2026-09-10 and the PR state → `update_task`
  wrote one metadata note ("Planning metadata changed: priority → high · labels → spec,
  issues · due 2026-09-10"), then `get_github_state` and `get_task`.
- 10:02:00Z PR **#5 "[JC-4] Search spec"** opened after the resumed spec writer
  (ask_human → answer → resume) re-delivered from the repaired workspace.
- 10:02:47Z the **schedule fired** on the runner's next tick (`task.schedule.fired
  {outcome: claimed}`, `scheduled actions fired {fired:1}`), status `fired`, and the
  operator was QUEUED behind the in-flight run ("operator run queued — one already in
  flight"). task.md shows `firedAt` set but `claimedAt: null` although the audit says
  `claimed` (cosmetic bookkeeping).
- 10:03:11Z the JC-2 operator's `pr-diverged` turn (started 09:56:21Z, BEFORE the
  09:57:32Z reconcile) opened a "Decision required" packet whose observations say
  "Viberr still records PR #2 as open in review … likeliest explanation is that PR #2
  was merged on GitHub — I have not confirmed that" — its start-of-turn snapshot was
  seven minutes stale by the time it wrote, while the controller's `get_github_state`
  in the same minute read "PR #2 merged". The hedge is honest; the mechanism (one
  snapshot per turn, no re-read before the packet) is a hazard to note, not a lie. It
  also reports "I tried to offer a direct accept and the server refused it: acceptance
  only fits a task at the stage before Done with a healthy verdict" — the server gate
  held against the operator. Options: walk to Review (rec), confirm on GitHub, archive.
  A merged PR with no in-app close-out is exactly the force-accept case (ruling 124:
  offered once the task has a PR).
- 10:04:39Z **PR adoption fixture** on JC-4 with `gh` (no push): closed Viberr's PR #5,
  opened PR #6 from the same head `974e70c` (= the delivered revision). 10:05:19Z forced
  reconcile → `task.md` `pr: {number: 6, state: review, title: "Search spec (re-opened
  by a human on the same head)", mergeable: clean}`, `unownedPr: null` — adopted by
  head sha (ruling 35). But no timeline line and no audit row say so (**F34-9**).
- The scheduled run (F34-8): "Scheduled action starting" on the timeline at 10:02:47Z,
  then the refusal lived only in the server log.
- 10:06:24Z **force-accept** on JC-2 (admin): dialog "Force-accept this completion?"
  disclosed MERGES "PR #2 · merged into main", REVISION f175a76, VERDICT "awaiting
  verdict", SKIPS "QA → Review, and the review gate", BYPASSING "no approving verdict
  yet …", WITHDRAWS the open decision, "Admin override. The bypassed gate is recorded
  to the audit log", Not yet / Force-accept JC-2. Result: `stage: done · validation:
  bypassed · acceptance: forced`, completion event "the review PR had already been
  merged on GitHub (out of band)", policy-engine note withdrawing the unanswered packet,
  goal-2 link 1 done → **JC-7 "Issue CRUD and detail page"** created. Files, board and
  audit agree. (My first confirm click hit a re-render and did nothing; the second
  open + click worked — the dialog does not survive a revalidation.)
- 10:08:14Z–10:08:20Z **board-scope dock** ("Controller · Jira Clone", message recorded
  with surface `/projects/jira-clone/board`): `update_stages rename` (Spec/Design →
  Design; id `spec-design` kept — ids never change, name follows), `set_transition_boundary`
  Implementation→QA auto → **approval** ("applies to future transitions"), `update_goal
  pause` then `resume` on goal-4 (goal timeline: "Paused by … · via controller",
  "Resumed by …"), `create_task` JC-8 (standalone, `goalRef: null`, priority low, owner =
  asker), `comment_on_task` on JC-7 tagging @maya (timeline `comment · controller` with
  the trailer "_Posted by the controller for Arda._"; Maya's inbox got a `mention` row).
  Audit: `project.stage.renamed`, `project.policy.boundary_changed`, `goal.updated` ×2,
  `task.created`, `task.agent.commented {actorRef: controller}` — every row
  "arda@viberr.dev · via controller". The controller's report quoted each tool's own
  sentence. All six verified against the files; nothing drifted.
- 10:11:18Z JC-7 (goal-2 link 2, "Issue CRUD and detail page") triage: the operator
  opened an input packet "JC-7 has its spec but no app to build on — pick the scope"
  (foundation first and wait / widen JC-7 via `edit_goal` / spec first) — a correct
  read of the cross-chain dependency the controller's goals created (goal-2 needs
  goal-1's scaffold+schema+auth). Answered option 1 (foundation first).
- 10:10:42Z JC-5's operator, after the Developer aligned the spec, recommended "Move
  the task to QA" — the Implementation → QA boundary I had just switched to
  **approval** through the controller took effect on the next transition (the
  recommendation card, not a direct move). Applied as Maya (maintainer).
- 10:13Z **collision fixture** (owner-approved, Q34-9): after Viberr allocated `jc-8`
  for the standalone JC-8 and dispatched the spec writer, I committed
  `FIXTURE-COLLISION.md` on `jc-8` through the GitHub contents API and opened an
  unowned PR from it — an OPEN PR on the task's own branch name whose head is not the
  task's revision. Viberr's delivery should now hit a non-fast-forward push
  (`push_conflict`) and/or an adoption refusal (`head_mismatch` → collision packet with
  `resolve_remote_collision`).
- 10:15:46Z JC-5 QA → Review approved as Maya from the operator's second recommendation
  card (a stage-move card applies with no confirm dialog; the acceptance card is the one
  with the ceremony). The operator had passed QA through ("docs-only, nothing to boot")
  and said so in the card's detail.
- 10:17:52Z the reconciler's 5-minute poll saw the fixture: JC-8 got `github.unownedPr:
  8` and the policy-engine note "**Branch name collision:** GitHub already has PR #8 on
  branch `jc-8`, but it is NOT JC-8's review PR: JC-8 has delivered no revision … Resolve
  it with a `resolve_remote_collision` decision … before delivering." The workspace
  reconcile after the spec writer finished recorded `branchLinked: false, commits: 1`.
  Copy nit (U34-6, not a lie about state): the note explains the collision as "a task
  key is reused (a new data root restarts keys at 1) … only reaches a task whose branch
  was recorded before [ruling 122]", which is not what happened — the branch WAS
  allocated under ruling 122 and the PR appeared afterwards (a teammate opening a PR on
  the task's branch would look exactly like this). Waiting for the operator's packet.
- 10:19Z JC-7's operator, having parked the task per my answer, read the repo and opened
  a SECOND input packet: "Two on-main specs disagree on the Issue contract — settle
  before the foundation migration" (architecture.md §3 vs issues.md define the Issue
  aggregate differently) with four options: `redirect` (one spec-writer pass to
  reconcile, no coding), record precedence only, hand to the foundation task, park.
  Chose the `redirect` — a real cross-chain conflict the controller's parallel spec
  chains produced, caught by the operator before a migration hard-codes it.
- 10:20:20Z **first in-app rejection by verdict**: the JC Reviewer (required reviewer,
  `verdictCapable: true`) returned `request_changes` on JC-4, bound to
  `rev_mwmmG0FkEpkx` / head `974e70c` (= PR #6's head): `validation: failing`, a
  `quality` event "Changes requested" with eight evidence rows (git diffs it ran, the
  route conflict `issues.md:513` vs `product.md:127`, the control-char scan, "psql+docker
  absent, SQL desk-checked only"), and a long verdict comment. The task page pill reads
  the failing validation. The operator now owns the rework routing (`reworkStages`).
- 10:20:18Z JC-3's rework landed as `6548677` on `jc-3` (conforming to architecture.md
  on all three points, per my steer), on top of a `merge main into jc-3` the operator
  made with `update_branch_from_base`; the operator will re-deliver — PR #3 is closed,
  so a fresh PR is expected.
- 10:21:52Z the JC-8 operator opened the **collision packet** ("Delivery blocked — the
  branch name `jc-8` is squatted by an unrelated PR #8"; recommended
  `resolve_remote_collision`; it deliberately ran neither deliver nor
  update_branch_from_base "both push to the remote name jc-8"). 10:22:39Z confirmed it
  through the "Packet collision dialog" (DECISION / DELETES "the stale branch jc-8 …
  closes its pull request #8 … cannot be undone" / KEEPS "this task's local delivery" /
  Not yet / **Clear collision & redeliver**). Ruling 110's fixed order ran exactly:
  `task.packet.resolved` → `github.branch.deleted jc-8` → `github.pr.closed_unowned #8`
  → push → `github.pr.opened #9` → `github.delivery.manual {delivered}`; GitHub agrees
  (#8 CLOSED, #9 OPEN "[JC-8] Add CONTRIBUTING.md…", `jc-8` = `a38b571`). Then: nothing.
  `waiting: human`, no packet, no card, no operator run (**F34-10**). Pressed Run
  operator by hand to unstrand it.
- 10:22:49Z PR **#10 "[JC-3] Boards & sprints spec"** opened — the reworked spec after
  the out-of-band rejection of #3 (rejection → rework → re-delivery loop closed).
- 10:23:46Z JC-4's operator turned the reviewer's request-changes into a packet "Which
  issue-detail route is canonical? (blocks the JC-4 revision)" with two `request_edit`
  options (align to issues.md's `/issues/[issueKey]` — recommended; or product.md's
  nested route) and one `custom` deferral. Chose the first: a `request_edit` resolution
  that should re-run the spec writer with the edit, mint a new revision, and stale the
  failing verdict → the second in-app rework loop (drift after a verdict is exactly what
  the owner asked to see: "let one diverge after review").
- 10:27:37Z **JC-6 scaffold hand-back** (JC Developer, 14 min, fable max): three commits
  on `jc-6` — Next.js 15.5 + React 19 + TS 5.9 + Tailwind 4 + ESLint 9 + Prettier +
  Vitest 4 + Playwright 1.62, `docker-compose.yml`, `.env.example`, CI workflow, README —
  with `pnpm lint/typecheck/test (7/7)/build/e2e (1/1)` all run inside the container and
  a `pnpm dev` smoke screenshot posted as `jc6-home.png` (the image attachment card
  works). Honest caveats in the comment: "this sandbox has no Docker, so `docker compose
  up -d db` did not execute" (the controller's Postgres-in-compose choice meets the
  container's limits for the first time — CI on the PR is where it will run), and
  "two sandbox quirks (`NODE_ENV=production`, `PORT=5173` exported globally) initially
  broke vitest and `next start`" — Viberr's own process env leaks into the agent's
  shell (U34-7). JC-6's operator is now delivering to PR #7.
- 10:30:33Z JC-4's spec writer revised the search spec per the `request_edit` steer
  and the workspace reconcile minted a NEW revision; the old `request_changes`
  verdict stays in `verdicts[]` bound to the old revision id and no longer counts →
  `validation: changed` (was `failing`). The revision-bound verdict model behaved as
  documented: rework after a verdict stales it, and the next review must re-verdict.
- 10:31:11Z **JC-6 wedged with the whole app local** (F34-11): the operator's
  `deliver_for_review` answered `noop — "PR #7 is already open for review; there is
  nothing to deliver."` (operator-actions.server.ts ~2488: an open `pr.state` short-
  circuits before any push), `update_branch_from_base` was a clean noop, PR #7 on GitHub
  still holds 2 commits (spec + merge) while local `jc-6` is 3 ahead; the task page shows
  the PR card with NO Deliver control. The operator's packet — an excellent diagnosis:
  "delivery short-circuits on 'PR is already open' instead of comparing commits" —
  could only offer `resolve_remote_collision` (close PR #7, delete `jc-6`, re-deliver) or
  hold. Taking the collision option because it is the one exit that pushes the work.
- 10:33:06Z the `resolve_remote_collision` on JC-6 REFUSED — "The branch collision
  was not cleared: PR #7 is still open on `jc-6`, and deleting the branch would silently
  close it. Close or merge the PR first. Nothing was re-delivered." (right: there was no
  collision) — and left JC-6 `readiness: blocked · waiting: human`, packet gone. The
  dialog had described the task's own PR as "the unrelated one squatting" (U34-8). To
  get the app commits out I closed PR #7 with `gh` (10:34Z); the reconciler's closed-PR
  divergence and the operator's recovery packet are the only remaining path to a fresh
  PR carrying the branch. Every implementation task in this workflow will need this
  dance until F34-11 is fixed.
- 10:35Z JC-8 hit F34-11 exactly as predicted ("JC-8 is implemented but unpushed — PR
  #9 still shows only the spec"; the operator's options include "Push jc-8 to origin"
  which nothing in the product can do, and "Close PR #9 and let Viberr re-deliver a
  fresh review PR"). Closed PR #9 with `gh` and resolved with that option.
- 10:36Z JC-6's `pr-diverged` recovery packet ("PR #7 closed without merging — pick a
  recovery path": rework + fresh PR / archive keep branch / archive + delete branch).
  Answered "rework" with a note saying no rework is needed and to deliver the branch as
  is. If the operator re-runs the Developer anyway, that is the cost of the F34-11 dance.
- 10:37:22Z JC-8's operator, after my "close #9 and re-deliver" answer: deliver was STILL
  a noop ("PR #9 is already open") because the pre-check reads task.md's cached
  `pr.state: review` — the human had closed #9 two minutes earlier and no reconcile had
  run. The operator posted an honest "half-blocked" comment instead of re-opening the
  packet. Forcing Update status, then the human Deliver control.
- 10:36:54Z **JC-6's push was REJECTED by GitHub** — `! [remote rejected] HEAD -> jc-6
  (refusing to allow a Personal Access Token to create or update workflow
  .github/workflows/ci.yml without workflow scope)`. The operator (after my "deliver as
  is" answer) delivered, saw `push_failed`, and opened an exemplary `blocked` packet:
  "Delivery blocked — GitHub token lacks `workflow` scope … This is new information and
  it explains the whole history" (it also correctly says closing/reopening a PR cannot
  fix a rejected push), options `block_on_policy` (add the scope, re-deliver) and
  `redirect` (drop ci.yml). So PR #7 never carried the app for TWO reasons stacked:
  F34-11 hid the push, and the push itself would have failed (G34-2). Asked the owner.
- 10:38:25Z JC-8 unwedged the F34-11 way: reconcile → `pr.state: closed` → the human
  **Deliver branch & open PR** control reappeared → **PR #11** with the full branch.
- 10:43Z owner's answer to Q34-10: ship the scaffold without CI. Resolved JC-6's
  packet with the `redirect` ("take ci.yml off the branch") plus a note; the operator
  will re-run the Developer. Applied three "Move to QA" approval cards as Maya
  (JC-4 after its second review came back `healthy`; JC-5; JC-8), answered JC-7's
  spec-writer `ask_human` (story-point domain + Done semantics) with the recommended
  option. Four spec-only tasks now sit at QA; the operator has been passing QA through
  for docs deliverables ("nothing to boot").
- 10:46:22Z first **JC QA Tester** run (supporting, on JC-8 at QA): `run·inputs` mounts
  THREE MCP servers — `playwright-browser` (the org server the controller registered),
  `viberr_browser` (the built-in browser capability the `use-browser` grant provides)
  and `viberr_agent` — 37 tools, two of them Playwright MCPs side by side. Viberr
  neither deduplicated nor warned that a granted org MCP duplicates the built-in browser
  (observation, not filed: the controller's choice, and both work).

## 10:47–10:48Z · Quota wave (six runs die at once; F34-1 live, second form)

The Claude account behind Arda's credential hit its five-hour window ("You've hit your
session limit · resets 11am (UTC)"). Within 25 seconds every live run died: operator runs on
JC-3/4/5/6 (6–26 turns each), the JC Spec Writer on JC-7 (22 turns, $4.13) and the first JC
QA Tester run on JC-8 (10 turns, $0.97). What Viberr did with it:

- Every run log carries a structured `meta · rate_limit_event · "rate limit · five_hour at ?"`
  line immediately before the failure, then `result · success · N turns`, then
  `run·error·unknown` — the runtime HAS the structured signal and still classifies the
  failure as unknown (see F34-1). The `at ?` shows the reset time is not parsed either.
- Operator-failure packets (JC-3/4/5/6) say "Retry on the other backend, fix the credential,
  or redirect the task" + "What the provider reported: …session limit · resets 11am (UTC)".
  The recommended option is "I've updated the policy / credential — unblock and re-run".
  Nothing was wrong with the policy or the credential; the person's actual remedy is
  "wait 12 minutes" or "switch account" (Q34-7).
- Specialist-failure packets (JC-7/8, "Work stalled: pick a recovery path") say
  "Claude run failed: The agent run did not complete. Review the runtime configuration.."
  (double period) and recommend "Redirect with sharper guidance" — as if the specialist had
  done something wrong. The provider text survives only as an observation row.
- The provider banner was posted VERBATIM as an agent comment attributed to the specialist:
  `comment · agent:claude/jc-spec-writer` → "You've hit your session limit · resets 11am (UTC)"
  and the same on JC-8 for the QA tester (audit `task.agent.replied`). A reader of the thread
  sees the spec writer "say" it hit a session limit.
- `diagnostics` and `model_availability` recorded nothing; no notification distinguished
  "quota" from any other failure.
- Screenshots 39–41 (JC-6 packet, light/dark/mobile).

Resolved at ~11:04Z (after the reset) with the recommended option on JC-3/4/5/6 and "Send back
for another attempt" on JC-7/8. The 22-turn spec-writer run on JC-7 is the one to watch: does
"try again from its last report" recover the $4 of work or start over?

## 11:04–11:08Z · Recovery, third merged cycle (JC-4), chain creates JC-9

- Resolving a packet in the UI = pick the option (radio card) + "Confirm decision". All six
  tasks went `ready · waiting: agent` and their operators re-ran within seconds; the first
  post-reset run produced assistant text at 11:05:02Z (the credential works again).
- JC-4's operator re-checked after the unblock, explicitly declined to re-open the packet
  ("operator-run failure, not a specialist capability gap"), confirmed `revisionDrift` null on
  the human-reopened PR #6 (the adoption fixture) and posted an **accept_completion** card.
  It deliberately did not refresh the branch from base "that would put a merge commit on the
  approved head and create unreviewed drift immediately before acceptance" — good.
- Maya (maintainer) applied the card. Acceptance dialog: APPLYING / MERGES "PR #6 · in review
  into main" / REVISION 38d377a894ff / VERDICT "validation healthy" / "Merging is one-way".
  Confirm = "Apply → Done & merge". Result, all consistent: task.md `stage: done`, `pr.state:
  merged`; GitHub PR #6 MERGED 11:08:06Z by akin-ozer (the PAT owner — the audit row says
  maya@viberr.dev, GitHub says akin-ozer; expected with a project PAT); branch jc-4 deleted;
  audit `github.pr.merged` → `github.branch.deleted` → `task.transition (via accept_completion)`
  → `task.recommendation.applied` → `task.created JC-9 "Full-text search backend"` attributed
  "arda@viberr.dev · via controller · goal chain" → operator run on JC-9 one second later.
  goal-4 link 1 done, link 2 = JC-9 active. Screenshots 45–47.
- Copy nit (not filed): the dialog's VERDICT row shows the validation state ("validation
  healthy"), not the verdict ("approve · JC Reviewer · 38d377a").
- Second React #418 hydration error (`args[]=text`) on a task page, this time as Maya on
  JC-4 while the accept card was showing — U34-2 now has two sightings.
- Insights (screens 43–44): "Backend quota: claude · five hour · utilization not reported ·
  resets Sep 3, 2026" — the quota surface exists and partly recorded the window, but the
  page's own copy says a "usage limit reached" row is derived from a refused run, and none
  appeared for six refused runs (F34-1, third symptom). "Branch & PR traceability 7 of 8
  delivered tasks" counted JC-7, which has never delivered (checking the metric).
- JC-5 QA→Review applied by Maya (plain transition, no dialog). Counts: 9 tasks, 3 done,
  3 merged PRs (#1, #2, #6), closed #5/#7/#9, open #4/#8/#10/#11.

## 11:09–11:12Z · Surfaces after the third cycle; RBAC re-probe

- Board (48–50), project Controller page with goal chains (53): goal-4 shows link 1 done
  (JC-4) and link 2 active (JC-9); the other chains unchanged. Consistent with the goal files.
- Review queue: "2 tasks at the review boundary · 0 waiting on your acceptance"; JC-3 and
  JC-5 both "Waiting on 1 required reviewer approval of the current revision · awaiting
  verdict · agent working" — true (JC Reviewer runs live on both).
- Notifications (52): Operator @mentions to Arda on JC-6 and JC-3, the controller's
  "Link 2 started as JC-9", the JC-5 re-check. No notification said "quota" during the wave —
  six blocked packets were six generic "decision waiting" rows (F34-1).
- JC-8 QA Tester (32 turns, $1.50) verified PR #11 at the pinned revision c3efdbe as a docs-only
  pass — "no app boot, no browser" — and reported PASS via `report_outcome`. Its engagement is
  `verdictCapable: false` (support role); the verdict stays with JC Reviewer. Consistent.
- RBAC re-probe (HTTP status by cookie): nadia (non-member) 404 on task JC-9 / project
  controller / activity, 403 on audit export and insights; vic (viewer) and omar
  (contributor) 200 on the task, project controller page and activity, 403 on audit export
  and insights (org-admin only). Viewer can READ the project controller page (goals +
  conversations list); sending is gated separately (ruling 103 asymmetries) — by design.

## 11:11–11:17Z · JC-9 scoping packet, JC-7 recovery, JC-6 undone by a packet label, JC-3 approved

- **JC-9** (chain-created "Full-text search backend"): the operator refused to advance it —
  the merged search spec patches tables that do not exist on `main` (no package.json, no
  prisma/), and the goal asks for status/assignee filters the merged spec forbids. Packet
  "JC-9 can't start as written — pick its scope" with three well-argued options (align to
  spec + hold behind the foundation [rec]; expand JC-9 to bootstrap the foundation; amend the
  specs). Cross-goal dependency (goal-4 link 2 needs goal-1 link 3) is not a thing Viberr
  models; the operator can only "hold" if a human names the task, and that task does not
  exist yet. → Q34-11 for the owner. Resolved with the recommended `edit_goal` option; see
  F34-13 for what the reload did. Goal saved through the Edit button with the dependency
  named; packet cleared; operator re-ran.
- **JC-7**: "Send back for another attempt" resumed the JC Spec Writer, which found the
  cut-off run's three edited-but-uncommitted files in the workspace, re-verified them line
  by line, committed (ecb09e6), merged main, and delivered PR #12 (5 files, +199 −82). The
  $4.13 of pre-quota work was NOT lost. Operator moved JC-7 to Design.
- **JC-6**: see F34-12. The Developer restored ci.yml citing "@Arda's decision" (my quota
  packet resolution), the push failed on `workflow` scope again, the operator opened an
  honest second packet ("third time the file moves"). Answered: ship without CI, drop
  ci.yml again, carry CI into a follow-up (Q34-10 stands). Screenshot 59.
- **JC-3**: JC Reviewer approved revision 6548677 (11:15:28Z); operator running toward an
  accept_completion card. Before accepting, Maya asks for a small spec change to exercise
  work-revision drift at acceptance.
- Counts: 9 tasks, 3 done, PRs merged #1/#2/#6, open #4/#10/#11/#12, closed #3/#5/#7/#8/#9.

## 11:17–11:22Z · Fourth merged cycle (JC-8), drift disclosure lies (F34-14), two dependency holds

- **JC-3 drift experiment:** Maya's comment "@JC Spec Writer … add one sentence … commit on
  jc-3" triggered the spec writer directly (audit `task.comment {toAgent: true}` → run
  resumed on the deliverer's session). It committed 1215ab44. Before that, the operator's
  post-verdict base refresh had already moved the head (60049586, merge of 4 main commits)
  and the operator still posted the accept card. Acceptance dialog now: REVISION 1215ab44 /
  MERGE HEAD 60049586 "5 commits added since review; they merge unreviewed" / VERDICT
  awaiting verdict / BLOCKED "Waiting on 1 required reviewer approval of the current
  revision" — verdict binding to revision WORKS (a new authored commit re-gates acceptance).
  The "5 commits" line is F34-14. Screenshot 61.
- **JC-8 accepted by Maya** (cycle 4): dialog "REVISION c3efdbe · MERGE HEAD cf97e5d2 · 5
  commits added since review; they merge unreviewed · VERDICT validation healthy". PR #11
  MERGED 11:20:59Z, branch deleted, task done, completion record carries the overstated
  drift sentence permanently. JC-8 was a self-standing controller task (no goal chain) so
  nothing followed. Screenshot 62.
- **Cross-goal dependency, twice more:** JC-7 (goal-2 link 2, Implementation) and JC-9
  (goal-4 link 2, Backlog) both opened "hold" packets: the foundation (goal-1 links 2–4) is
  not on main. JC-9's operator: "this was my last automatic nudge … nothing here can watch
  for it automatically". Confirmed both holds with notes naming goal-1's links. Three of the
  five chains now wait on goal-1, each hold a human decision that a human must re-resolve
  by hand when the foundation lands. → Q34-11. Screenshots 63-*.
- Counts: 9 tasks, 4 done (JC-1, JC-2, JC-4, JC-8), PRs merged #1/#2/#6/#11; open #4 (JC-5),
  #10 (JC-3), #12 (JC-7); JC-6 redelivering without CI; JC-5 reviewer still running.

## 11:22–11:26Z · Owner rulings on dependencies and drift; JC-3 conflict; holds behave

- Owner answered Q34-11 (task-level blocked-by, auto-released) and Q34-12 (authored commits
  only) — QUESTIONS.md.
- JC-3: after the spec writer's requested commit, the operator's base refresh CONFLICTED on
  docs/specs/README.md (JC-8's merged CONTRIBUTING index line vs JC-3's boards line) and it
  opened the right packet ("`jc-3` conflicts with `main`" · have the delivering agent resolve
  [rec] / resolve yourself / archive) — "a conflict is explicitly not mine to settle". Resolved
  with the recommended option. The stale accept card stayed up throughout (F34-15, screens
  64–65).
- JC-5: second request-changes from JC Reviewer (pinned 0acd607; it noted "the main merge
  changed nothing in the deliverable" — the reviewer computes authored drift correctly by
  hand, which is what F34-14 asks Viberr to do). Operator moved JC-5 Review → Implementation
  (manual boundary, by operator) and re-prompted JC Developer (the original deliverer of the
  test strategy) for the docs rework.
- JC-7 and JC-9 holds: each "hold" resolution re-ran the operator once; both re-verified
  origin/main, posted one comment, set `waiting: human`, and stopped. JC-9 got a second
  operator run right after the first (5 total on a task that has never run an agent) —
  watching for a nudge loop.

## 11:25–11:29Z · JC-3's decision cannot execute (F34-16); JC-9 makes its packet a standing token

- JC-3: see F34-16. The operator itself flagged the stale accept card in an observation
  ("Stale card - please don't click it … Maya's sentence lives in 1215ab4, which is unpushed
  and covered by no verdict") — an agent compensating for F34-15 in prose.
- JC-9: after the hold confirmation the operator ran twice more (5 operator runs, $4.27, no
  agent ever dispatched) and then opened "JC-9 still held at Backlog — foundation not on
  main; this packet is the standing token … This was the final automatic nudge for this
  stage — nothing will re-check main for JC-9 again … resolve it when the foundation lands".
  It stopped nudging on its own — the operator's no-progress cap works — and turned the
  packet into the dependency marker Viberr lacks (Q34-11). Left open deliberately.
- JC-7's hold ended with `waiting: human`, no packet, one comment; JC-9's with a packet.
  Two operators, two shapes for the same state.
- Routing JC-3's remedy through the controller dock (screenshot 66): add Review to the JC
  Spec Writer deployment, then confirm the packet's recommended option.
- 11:28Z controller run (5 turns, $0.69): `update_agent_deployment {profileId: jc-spec-writer,
  stages: [backlog, spec-design, review]}` then re-read the project and reported the three
  stages. Verified: project.md deployment block lists backlog/spec-design/review; audit
  `project.agent_profile.updated · arda@viberr.dev · via controller`; the global profile file
  (docker-data/agents/profiles/jc-spec-writer.md) unchanged — deployments are per project,
  consistent. The controller also pointed at the open JC-3 packet and offered to nudge the
  operator — it did not act on the task itself without being asked. Packet resolved with
  option 1 at 11:30Z.

## 11:30–11:33Z · JC-6 PR-closed packet; edit_goal draft is the option's prose

- JC-6's operator, after the no-CI rework: "PR #7 is closed unmerged — how should the JC-6
  scaffold reach review?" with three honest options (re-deliver as a fresh PR [rec] / #7 was
  a rejection / correct the Done signal first). It also flagged goal drift: the goal still
  demanded CI. Good packet. Screenshot 67.
- I picked "Correct the Done signal first" (edit_goal) in one page session. The goal editor
  opened prefilled with the OPTION'S OWN TITLE + DETAIL ("Correct the Done signal first, then
  deliver / Confirming opens the goal editor: replace …") — not a drafted goal (screenshot
  68). My driver saved that text blindly, so for ~2 minutes JC-6's goal was an instruction to
  edit the goal; I restored it by hand from goal-1.md's link text minus the CI lines (my
  mistake, recorded). Product side: `goalDraft` is the option's title+detail whatever the
  operator wrote; on JC-9 the operator had written a real goal, on JC-6 an instruction. The
  operator prompt never says "your edit_goal detail becomes the draft" → U34-10 (low).
- Agents page → JC Spec Writer: "Eligible stages · 3 of 6 stages" with Review lit (screenshot 69) — UI, project.md and audit agree.

## 11:33–11:38Z · Six standalone spec tasks via the controller; JC-15 owner race

- Dock trap (mine): on the board the dock was already open from session storage, my click on
  the launcher CLOSED it and the fill timed out. Check `.dock[data-open]` before clicking.
- Controller run (10 turns, $0.69): six `create_task` calls, then `update_task {dueDate}` for
  JC-13 and `set_task_owner {owner: omar@viberr.dev}` for JC-15 — "Due date and owner aren't
  part of task creation, so … applied as follow-up calls". Verified on disk: priorities
  high/normal/low/normal/urgent/normal, labels spec/docs, JC-13 due 2026-09-05, JC-15 owner
  u_Ik_dYE9TXsZI (Omar). JC-14 got BOTH `urgent: true` and `priority: urgent` (the priority
  enum includes "urgent" — see PRIORITY_VALUES). Board (70–72) shows every field.
- JC-15 credential race (ruling 127): the task was created with Arda as owner, the operator
  run started 1.2 s later on Arda's credential (`credentialUserId u_GM6HRspkfhMA`), and the
  ownership handoff to Omar landed 3.6 s after that. The first triage run of an
  Omar-owned task is billed to Arda; the next run should use Omar's (absent) credential.
  Controller `create_task` cannot take owner/due/urgent → G34-3.
- JC-3: JC Spec Writer (33 turns) resolved the README index conflict at Review (now eligible
  there); operator handed the new revision to JC Reviewer for a re-verdict.
- JC-5: same README index conflict after the developer's rework; packet resolved (developer
  is Implementation-eligible, so this one executes).
- JC-6: developer resolving the same conflict on jc-6. Every task that appends to
  docs/specs/README.md's index conflicts with every other merged task — the project's
  convention, not Viberr's fault, but it makes the conflict packet the most-used packet of
  the pass (4 so far).

## 11:38–11:41Z · Ruling 127 live on JC-15; four scoping packets; ownership dialog

- **JC-15 (owner Omar, no Claude credential):** first triage ran on Arda (G34-3 race); the
  task auto-moved Backlog → Design; the next operator run was refused in 20 ms —
  `runtime.run.started {credentialUserId: u_Ik_dYE9TXsZI, failedUnavailable: true}`, log
  `run·unavailable "Claude isn't connected for Omar Reyes (omar@viberr.dev), the task owner.
  Runs on this task use the owner's accounts; they can connect Claude on Profile → Agent
  accounts. No agent process was started."` The blocked packet carries that text verbatim,
  Omar's inbox shows it under "Waiting on you · 1 decision" (screenshot 74), the options are
  the generic defaults (here the recommended "I've updated the policy / credential" fits).
  Omar got NO notification for the handoff itself (U34-11).
- As Arda (admin) on JC-15: the "Release owner" × opens "Release ownership?" with OWNER /
  OPEN NOW "Blocked decision · waiting on the owner" / AFTER "Unowned: review & acceptance
  stall until another member takes the seat" / HAND OFF INSTEAD (Arda · you, Maya) — an
  honest consequence dialog (screenshot 75). Handed off to Arda: audit
  `task.ownership.taken`, packet resolved, operator re-ran on Arda's credential.
- **Scoping packets** on JC-10 (roles are a v1 non-goal → "v1 authorization reference, no
  roles"), JC-11 (notifications are a decided v1 non-goal → "post-v1 design spec"), JC-12
  (shortcuts → "registry only"), JC-13 (audit log vs IssueActivity → "cross-entity audit
  log"). Each operator read product.md/architecture.md, found the real conflict with the
  thin goal text, and offered 3 scoped options + "rewrite the goal yourself" (edit_goal).
  All answered with the recommended option. JC-14 (urgent) needed no question and the spec
  writer is already running on jc-14.
- Counts: 15 tasks, 4 done; runs in flight: JC-3 reviewer, JC-5 developer (rework), JC-6
  developer (conflict), JC-14 spec writer, operators on JC-10/11/12/13/15.

## 11:42–11:47Z · JC-3: reviewed, "clean", unmergeable — the unpushed revision (F34-11 live)

- JC Reviewer approved 385047c (the conflict-resolved revision) at 11:42:35; operator posted a
  fresh accept card. Maya's accept dialog: REVISION 385047c · VERDICT validation healthy ·
  BLOCKED "JC-3's review PR #10 conflicts with the base branch. GitHub can't merge it …
  Rebase the branch and re-review, or archive the task." GitHub: PR #10 head 60049586,
  CONFLICTING/DIRTY. Workspace HEAD 385047c, origin/jc-3 60049586 — never pushed.
  The operator's own log: `deliver_for_review → nothing to deliver, PR #10 open for review`;
  `update_branch_from_base → already_current` ×2. The spec writer had said "over to you to
  push 385047c". F34-11 upgraded to high with the full chain. Screenshot 76.
- Manual unblock (same class as #7/#9, owner-approved pattern): `gh pr close 10` so the
  operator's next delivery opens a fresh PR from the resolved head. Viberr still does the
  push. Recorded as a rejection-shaped event for the reconciler (expect a "PR closed
  unmerged" packet).
- 11:47Z JC-3's operator (before seeing the close) opened "PR #10 conflicts with main on
  GitHub — acceptance blocked" and diagnosed it wrongly: "the one branch tool I hold can't see
  it, because it runs git inside the delivering agent's workspace, which has no fetch
  credentials … I cannot rebase, force-push or merge" — the workspace was already merged and
  resolved; what it lacked was a PUSH (F34-11). Its recommended option was
  `resolve_remote_collision`; the dialog again called the task's own remote branch "the
  unrelated one squatting on this task's branch name" (U34-8, screenshot 78).
- **JC-5 is in the same state** (F34-11, second live instance): workspace HEAD a34a596
  (rework + conflict resolution), origin/jc-5 = PR #4 head 2511f1c, CONFLICTING on GitHub;
  moved to QA on an unpushed revision. JC-7's PR #12 head matches its workspace but is
  CONFLICTING (README index) — held anyway.
- 11:47:48Z "Clear collision & redeliver" on JC-3 was REFUSED by the server: "The branch
  collision was not cleared: PR #10 is still open on jc-3 … Close or merge the PR first.
  Nothing was re-delivered." — Viberr's cached pr.state was still `review` although GitHub
  had had #10 closed for ~70 s; the reconciler learned of the close 3 s later, withdrew the
  accept card ("now-moot") and posted the divergence note; an operator run started. The
  ruling-110 order (close PR → delete branch → push) works from the cache, not from GitHub,
  so a human who just closed the PR is refused for up to one reconcile interval (F34-11's
  cache blindness, third symptom; F34-10's refuse arm without stranding this time because
  the divergence trigger queued an operator).

## 11:52–11:58Z · The push nobody can perform (F34-11 ×3, F34-10 live), JC-3 fresh PR #17

- Maya's "@Operator … push the current jc-5 head to PR #4 first" started an operator run
  (mention → run, 80 ms). It called `update_branch_from_base` → "[noop] jc-5 is already up
  to date with main" and `deliver_for_review` → "[noop] PR #4 is already open for review;
  there is nothing to deliver", verified the refs by reading .git/refs by hand, apologised
  to Maya for its earlier note, and opened "PR #4 head is stale — jc-5 needs a push I cannot
  perform … pushing by hand is human-only under my policy, so this push needs a person".
  Recommended option: a HUMAN pushes a34a596 by hand (screenshot 80). Second option:
  `resolve_remote_collision`; I took it → refused by the server ("PR #4 is still open …
  Close or merge the PR first. Nothing was re-delivered") → JC-5 left `blocked ·
  waiting: human`, no packet, no run, a stale "Move to Review" card: F34-10's stranding,
  live. The only exit is closing PR #4 on GitHub by hand so the reconciler's divergence
  note queues an operator. Doing that now (same owner-approved pattern as #7/#9/#10).
- JC-3: the operator re-delivered from the approved head → PR #17 (385047c, MERGEABLE);
  review queue: "1 waiting on your acceptance · JC-3 · PR #17 is open for review · validation
  healthy · waiting on you". Accepting from the queue.
- JC-10 (reporter mutability contradiction between product.md and issues.md) and JC-14 (four
  cross-spec divergences) each raised a product-decision packet on the spec writer's behalf
  without blocking their PRs (#16, #15). Answered with the recommended options.
- PRs open now: #13 (JC-6), #14 (JC-12), #15 (JC-14), #16 (JC-10), #17 (JC-3), #18 (JC-13),
  #19 (JC-11); JC-15's spec is written, not yet delivered.

## 11:57–11:59Z · Second quota wave (F34-1 again); observer paused until 16:01Z

Ten runs died within 75 s on the same five-hour limit (`rate_limit_event · five_hour at ?`
again): operators on JC-5/10/11/12/13/14/15, JC Reviewer on JC-12 (1 turn) and JC-14 (21
turns), and the **JC-6 QA Tester at 116 turns / $4.82** — the first browser-era run on the
real scaffold, lost mid-flight. Seven generic packets (five "Operator run failed", two "Work
stalled"), the same misleading options as at 10:47Z. The observer's own session hit the same
account limit; both resumed at 16:01Z. Resolved all seven with the recommended/retry
options; JC-11's packet was a real question (README index omits three specs → add them in
PR #19).
- 16:03Z **JC-3 accepted by Maya from the task page's "Accept completion → Done" control**
  (no card needed; the queue had listed it under "waiting on your acceptance"). Dialog:
  MERGES PR #17 · REVISION 385047c · VERDICT validation healthy — no drift line this time
  (fresh PR from the exact reviewed head). PR #17 MERGED 16:03:35Z, branch deleted, task
  done, chain created **JC-16 "Board view with drag & drop"** (goal-3 link 2). Fifth merged
  cycle. Screenshot 82.

## 16:04–16:08Z · The index-conflict cascade meets F34-11: the pipeline's wall

- After #17 merged, JC-5 and JC-6 immediately hit "`jc-x` conflicts with `main`" again
  (docs/specs/README.md index). Six of the seven open PRs (#13 #14 #15 #16 #18 #20) touch that
  index; JC-11's #19 does not. Every conflict resolution lands in a workspace that F34-11
  cannot push while its PR is open, and every close-by-hand costs a cycle. JC-6's deliverer
  (JC Developer, Implementation-only) will also be refused at QA (F34-16, second instance)
  unless its stages are widened.
- Resolved both conflict packets with the recommended option to watch the refusal shape once
  more; not unblocking by hand any further. Observation targets at this point: 16 tasks,
  5 merged cycles (JC-1, JC-2, JC-4, JC-8, JC-3), 8 open PRs, 5 goal chains (3 held on the
  foundation), 4 human roles + non-member probed, every packet kind except `discard_branch`
  exercised, schedules, mentions, attachments/evidence, browser cap (JC-8 QA docs-only pass;
  JC-6's real-app QA run killed by the quota wave at 116 turns), archive not yet exercised.

## 16:08–16:35Z · Observation wound down; the real-app QA run lands

- Owner ruling (16:08Z): move to plan + fixes now; the same jira-clone project resumes on the
  fixed Viberr as the live validation. No more by-hand unblocks from here.
- **JC-6 QA Tester, second attempt (92 turns, $1.79, 6.5 min):** "Send back for another
  attempt" resumed it; it ran the scaffold for real — `pnpm install --frozen-lockfile`,
  `pnpm dev`, then the browser capability: `viberr_browser` navigate → snapshot → resize
  1280×800 → evaluate (computed Tailwind styles) → console_messages (0 errors) → two
  screenshots saved to the task's attachments (jc6-home.png + page-*.png; the first attempt
  had already saved three), plus lint/typecheck/test 7/7/build/e2e 3/3. Docker is absent in
  the agent container ("docker: command not found") and it said so instead of faking the DB
  check. Verdict PASS via `report_outcome`; operator posted the QA→Review card. The browser
  capability works end to end on real code. Screenshot 83 is its own attachment.
- It also wrote "committed one additive spec commit … HEAD 70284d6 on jc-6, not pushed" —
  checked below whether that landed in the deliverer's workspace or its own support checkout.
- State at hand-off to the fix phase: JC-6 QA→Review card pending; JC-13 and JC-11 approved
  by JC Reviewer (cards pending); JC-10 and JC-12 blocked packets; JC-15 input packet; JC-16
  chain-created and holding; JC-5/JC-7/JC-9 held or stranded on F34-11. 16 tasks, 5 merged
  cycles, 8 open PRs, 224 runs.
- The QA tester's commit 70284d6 (`e2e/home.spec.ts`, author jc-qa-tester) is in the
  DELIVERER'S workspace: the retry ran as `primary` with `delivers: true` — the operator
  chose that posture ("may codify Playwright specs on jc-6"), which ruling 98 permits
  because the controller granted the QA profile full delivery capabilities. Before that, at
  16:11Z, the operator had substituted the STOCK `developer` (opus[1m], not fable) to resolve
  the README conflict on jc-6 because JC Developer is not eligible at QA — F34-16's second
  instance, and the first time a non-fable agent touched the clone (added to F34-16).
--- baseline lint warnings (pre-existing): 2 require-yield in claude-runtime.server.test.ts
- Code check for F34-1's second form: `classifyClaudeError` (claude-runtime.server.ts:579)
  matches quota only on `/usage limit|quota|rate limit|too many requests|\b429\b/i`; the
  provider text was "You've hit your session limit · resets 11am (UTC)" — no match — while
  wire-format.server.ts:283 already parses the SDK's `rate_limit_event` with
  `rate_limit_info` (utilization, window, resets_at) two lines earlier in the same stream.

## 16:41–16:55Z · Fix-phase baselines on `pass34/implementation` (from main 2a098e89)

- typecheck clean; lint: 2 pre-existing `require-yield` warnings (claude-runtime test).
- `npm test`: 324 files / 5317 tests; ONE deterministic failure on main —
  `app/routes/resources.backend-login.test.ts:130` "reports the caller's own live sign-in"
  expects the Codex device-login URL and receives null (2/2 in isolation; environment: the
  fake codex login yields no URL on this host) — pre-existing, not pass-34; and one flake,
  `controller-dock.test.tsx` "animates only a reply that arrives while the panel is open"
  (1087 ms; passes in isolation). Both recorded as the baseline delta.
- Live project settled: 0 runs; 11 non-done tasks all waiting on humans.
