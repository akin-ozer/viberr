# Fresh 20-task suite — run in the Docker Compose production container (2026-07-18)

Owner directive: *"Run a fresh 20-task suite"* → *"continue working but do the test in docker
compose environment."* This is the pass-8 validation re-executed against the **standalone
production image** (`compose up --build`, `NODE_ENV=production`, `/data` volume), not the dev
server — the environment where the skill-leak and Codex-availability facts are authoritative.

## Environment
- `docker compose up -d --build` → `viberr-app-1` healthy on `:5173`; `docker compose exec app npm run seed`.
- Seed = 3 demo projects (`viberr-core`, `billing-service`, `deploy-pipeline`) + 5 users
  (arda/elif/murat/selin/deniz @viberr.dev, pw `viberr-dev-2828`). Tests target **`viberr-core`**
  (repo `akin-ozer/viberr`, prefix `VIB`, stages triage→ready→impl→review→done).
- Migrations already applied (baseline incl. `recommendation_kinds`).

## Harness design (docker-specific)
Two production-container realities forced the harness design; both are findings in their own right:
1. **Bind-mount + SQLite-WAL invisibility.** A *separate* better-sqlite3 connection (even inside
   the container) cannot see the app's un-checkpointed WAL frames on the Docker Desktop bind mount
   (`wal_checkpoint` reports `log:0` from the second connection; the `session` table reads empty
   right after a 200 sign-in). → The harness resolves the session id from the app's own
   `/api/auth/get-session` (not a DB read), and **verifies every assertion against the canonical
   markdown files** (`/data/projects/<slug>/{project.md, tasks/<KEY>/task.md}`), which every action
   writes synchronously. This is *more* faithful than the projection anyway ("files are canonical").
2. **better-auth rate-limits sign-in** (429) → the harness backs off/retries and spaces the 5 sign-ins.

Cookie in prod is `__Secure-viberr.session_token` (secure prefix); CSRF = `HMAC(secret,
"viberr-csrf:"+session.id)`. Files run in-container from `/data/scratch` (the `/app` tree isn't
writable by the `node` user); `better-sqlite3` is imported by absolute path.

## PART A — role-binding governance (`set-role`, `/projects/viberr-core/policy`) — 5/5
The seed's role spread is sparse, so the suite **shapes** a clean matrix via the app's own governed
role-binding action — which doubles as the role-bindings test the owner flagged ("we will need to
touch role bindings"). Verified against `project.md` `members`.

| # | Actor | Action | Expect | Result |
|---|-------|--------|--------|--------|
| RB1 | arda (admin) | demote co-admin elif→maintainer (2 admins present) | allow | ✅ elif=maintainer |
| RB2 | arda | murat→contributor | allow | ✅ |
| RB3 | arda | selin→viewer | allow | ✅ |
| RB4 | murat (contributor) | promote selin→admin | **deny** (admin-gated) | ✅ unchanged |
| RB5 | arda (sole admin) | self-demote admin→maintainer | **deny** (last-admin guard) | ✅ arda=admin |

Resulting matrix: arda=admin, elif=maintainer, murat=contributor, selin=viewer, deniz=non-member.

## PART B — RBAC action matrix (15 discrete tasks, VIB-169…183) — 15/15
Verified against `task.md` frontmatter/timeline.

| Task | Actor(role) | Intent | Expect | Result |
|------|-------------|--------|--------|--------|
| T02 | arda(admin) | owner-assign murat | allow | ✅ owner=murat |
| T03 | selin(viewer) | owner-take | deny | ✅ owner=null |
| T04 | murat(contributor) | owner-take | allow | ✅ owner=murat |
| T05 | elif(maintainer) | transition ready→impl | allow | ✅ stage=impl |
| T06 | murat(contributor) | transition | deny | ✅ stage=ready |
| T07 | selin(viewer) | transition | deny | ✅ stage=ready |
| T08 | elif(maintainer) | assign-reviewer | allow | ✅ reviewers=1 |
| T09 | murat(contributor) | assign-reviewer | deny | ✅ reviewers=0 |
| T10 | selin(viewer) | comment | allow (FR4) | ✅ landed |
| T11 | murat(contributor) | @operator comment | allow (comment lands) | ✅ landed |
| T12 | elif(maintainer) | update-goal | allow | ✅ |
| T13 | selin(viewer) | update-goal | deny | ✅ unchanged |
| T14 | elif(maintainer) | specialist(impl)→transition→reviewer(review) | allow | ✅ specialist+stage=review+reviewer |
| T15 | deniz(non-member) | owner-take | **deny (403)** | ✅ owner=null |
| T16 | deniz(non-member) | comment | **allow (FR4 app-wide)** | ✅ landed, 200 |

**Result: 20/20** (5 role-binding + 15 action-matrix).

### Two assertions the first run corrected (test bugs, not product bugs)
- **T14** first failed because the task was created in `review`, where the `developer` primary
  specialist is **stage-ineligible** (`assertStageEligible`; empirically 200 at impl/ready, 400 at
  review). Fixed to the realistic lifecycle: assign specialist in impl → transition to review →
  engage reviewer; task ends with **both**. Correct product behavior.
- **T16** first asserted a non-member *couldn't* comment — but `view`/`comment` are **app-wide by
  FR4** (`app/shared/rbac.ts`: "any authenticated user, member or not"). The route uses
  `requireUser` (auth), and the per-intent RBAC lives in the mutation: `owner-take`→`setOwner`
  requires a project role (deniz→403), while `comment`→`commentToAgent` is app-wide (deniz→200).
  The boundary is drawn exactly where FR4 says. Flipped T16 to confirm this positively; T15 remains
  the non-member DENY on a role-gated action.

## Live-delivery validation — 75+ REAL runs (`simulated:0`), all in the production container
Creating a task auto-triggers a real operator run, so the 20 suite tasks organically exercised the
full runtime. `agent_runs`: **claude 57 finished / 1 running**, **codex now 2 finished / 26 error**.

### Operator correctness (VIB-169 walkthrough, Claude)
The operator ran the whole governed loop correctly: **scoped** the task ("documentation-only, at
Ready, no blockers") → **selected the right specialist** ("Deployed Developer (Implementation,
Codex) as the primary") → **prompted it** with a task-specific instruction → **started the run** →
on Codex refusal **reported honestly** ("no usable credential … no agent process started") →
**opened a decision packet for the owner**. No auto-advance, no silent failure.

### Tool isolation + the SKILL LEAK (production-authoritative)
Operator init (`bypassPermissions`, so the denylist is the ONLY gate) shows the fix working:
denied builtins **absent** (no Skill/Task/Workflow/Cron*/Monitor/SendMessage), **ToolSearch kept**
and actually used to load the deferred `mcp__viberr__*` tools (12 of them), `viberr` MCP
`connected` for the operator and correctly **absent for reviewers**. The 16 SDK-bundled skills, 5
bundled subagent types, and 41 slash-commands are still **advertised** in the init (confirming
`skills:[]` cannot strip binary-bundled tools) — which is exactly why the denylist matters.

### DEFECT FOUND + FIXED in docker: the async subagent-task family leaked past `Task`
The init toolset still contained **`TaskCreate/TaskGet/TaskList/TaskOutput/TaskStop/TaskUpdate`** —
the async subagent-spawn family, past the singular `Task` deny. Under `bypassPermissions` a
denied-tools run could spawn an SDK subagent (`general-purpose`/`claude`) inheriting an
UNRESTRICTED toolset (Bash/Write/Edit) → bypass. **Fix:** added the whole family to
`BASE_DENIED_BUILTINS` (`app/server/runtimes/claude-runtime.server.ts`) + test. **Re-verified live**
after `up --build`: a fresh operator run's toolset dropped **25 → 19**, subagent-task family
**NONE**, ToolSearch + `mcp__viberr__*` intact.

### Codex ↔ Claude parity (definitive)
With the documented opt-in (`VIBERR_CODEX_USE_CLI_AUTH=1`, already in `.env`) **plus** placing
`~/.codex/auth.json` into `/data/runtimes/codex-home/` (the missing piece on a fresh volume), **Codex
now EXECUTES** the same run lifecycle as Claude (`thread.started` → `command_execution` →
`agent_message` → `turn.completed` with real token usage). It attempted the repo clone, and with no
GitHub credential seeded it **reported "Blocked … Branch: not created, Commits: none, PR URL: none"
to @operator** — a clean honest-degraded path; **no GitHub writes occurred** (no `vib-20x` remote
branches). viberr threads the identical run lifecycle + governance to both backends.

**Refines the memory:** Codex does not "fail at exec." The 25 earlier errors were the **honest
availability-gate refusal** (`F-DOCKER1`: "no usable credential … no agent process started") because
the fresh volume's `codex-home` had no `auth.json`. Placing it (compose-documented) makes Codex run.

## Codebase change shipped this session
- `BASE_DENIED_BUILTINS` += `TaskCreate/TaskGet/TaskList/TaskOutput/TaskStop/TaskUpdate` (close the
  subagent-spawn bypass; parity-consistent — no Codex analog). Test updated. Typecheck + full unit
  suite green.

## UI verification pass (browser against the live docker container, signed in as arda/admin)
Screenshotted the key surfaces to confirm the API-level results actually render — the pass-8
changes are all wired, no mocks on any inspected surface:
- **Home** — "**35 decisions** waiting on you" = the member-scoped per-project badges 1 (Deploy) + 33
  (Viberr Core) + 1 (Billing). W1 renders. Honest "GitHub/Google — not configured" on login.
- **Board** — header "42 tasks · **37 waiting on a human decision**" (project-wide) vs the "**Waiting
  on me · 33**" filter chip (member-scoped); finding-C labels distinct per card ("waiting on you"
  vs "waiting on a human" vs "agent working"); Codex/Claude backend glyphs per specialist.
- **Task VIB-169 [T02]** — the operator's **decision packet** ("Work stalled — pick a recovery
  path") with the honest Codex-unavailable signal and a recommended **"Retry on Claude Code
  (operator pick)"**; Current-state Owner = **Murat** (from the T02 owner-assign test); Permissions
  panel shows W2 honesty "**Comments: Every registered user**"; canonical `task.md` path surfaced.
- **Policy** — the role-binding suite's changes are **live**: Elif=Maintainer, Murat=Contributor,
  Selin=Viewer, Arda=Admin, "last change · Arda Kaya · Today"; capability table shows View/Comment
  as "**Any signed-in user · membership not required**" (FR4); human-vs-agent two-surface split;
  **ALWAYS RESERVED FOR HUMANS** = merge PR / transition to Done / change policy (all profiles).
- **Review queue** — "7 at the review boundary · **6 waiting on your acceptance**" (member-scoped);
  "Review → Done · human only"; per-task validation states; Claude reviewer runs produced real
  "Accept completion" recommendations on VIB-175/176.
- **Agents** — Operator described "never writes code and never closes a task itself" (matches the
  tool-isolation fix); 3-mode capability policy (acts-directly / recommends-only / reserved-for-
  humans); operator spans all stages.

**Minor copy nuance noted (not a bug):** VIB-181 (T14) review row reads "Reviewer found nothing to
review — no specialist was ever assigned." A specialist *was* assigned (Codex `developer`) but the
backend was down so it produced no diff. Wording conflates "assigned but never ran" with "never
assigned." Low priority; arose from an artificial test sequence (reviewer engaged before the
specialist ever ran, Codex-down). Open product question: should the copy distinguish the two?

## PR lifecycle + W4 divergence — driven live in docker (owner: "wire credential + run it")
Wired a real GitHub credential through the app (org `connection-add` with the host token → project
`set-credential` → `reconcile`, all governed, org-admin), then drove two controlled tiny-file
deliveries on `akin-ozer/viberr` (goal constrained to ONE 1-line marker file each):

1. **Agent delivery (real):** operator (Claude, full autonomy) assigned the Developer (Codex); Codex
   cloned, created the single file `planning/live-test/viberr-live-{A,B}.md`, validated the diff
   (exact content, single-file, clean worktree), committed locally. **viberr's governed delivery**
   then pushed the branch server-side (project PAT) and opened the PR on the Review transition
   (`openReviewPrBestEffort`→`pushWorkspaceBranch`→`openTaskPr`) — PR **#59** (VIB-204) and **#60**
   (VIB-205), each **+1/−0, single file**, no bloat.
2. **W4 divergence, both directions (via `gh`, out-of-band):**
   - `gh pr merge 59` → reconcile → viberr: `pr.state: merged`, typed **Divergence** event ("merged
     on GitHub, but VIB-204 hasn't been accepted through Viberr — its stage is unchanged"), **no
     auto-advance**. UI GitHub panel shows the `merged` badge + diff.
   - `gh pr close 60` → reconcile → viberr: `pr.state: closed`, **Divergence** event ("closed
     without merging, but VIB-205 is still active — rework and reopen, or archive"), no auto-advance.
   Confirms R8-6 (surface, never auto-advance) end-to-end against the real repo.

### FINDING → FIXED — Codex agent-side `git push` (Claude/Codex parity) → server-side delivery for both
Root cause (confirmed, not the sandbox): Codex's `shell_environment_policy: { inherit: "core" }`
(`codex-runtime.server.ts`) **intentionally strips `GIT_ASKPASS` + the token from Codex tool shells**
(only `GIT_CEILING_DIRECTORIES` is passed through) — a token-safety boundary (the same reason secrets
must not ride Codex `--config` argv, visible in `ps auxww`). So Codex's `git push` failed with *"could
not read Username for 'https://github.com': No such device or address"* even after a sandbox-mode
experiment (verified: the mode wasn't the blocker). Claude passes the token via the child env, so its
push works — but handing a coding agent the token is exactly what's unsafe on Codex.

**Owner ruling: "server-side for both, but the agent still writes the commit message." → IMPLEMENTED.**
Agents now AUTHOR their commits locally (own `[TASK]`-prefixed messages) and are told NOT to push or
open a PR; **viberr delivers server-side** (`pushWorkspaceBranch` → `openTaskPr`) on the Review
transition — one token-safe, backend-identical path. Removed `resolveRunPushAuth` + `pushCredentialed`
(no run gets a push credential); rewrote the delivery-contract prompt; +2 `buildAnalyzePrompt` tests.
Live-verified (VIB-207/PR #61): Codex committed `b4bccce [VIB-207] …`, reported *"I did not push or
open a PR; Viberr handles both when entering Review"* (NO more "push blocked" packet — the operator
instead cleanly recommended "Move to Review"), and on transition viberr opened the PR carrying
**Codex's own commit message**. Full suite 1320 green + typecheck.

### Repo hygiene
PR #59 merged one 1-line marker (`planning/live-test/viberr-live-A.md`, "safe to delete") to `main`;
PR #60's branch was deleted on close. Both are within the "small test files only" rule; the marker is
trivially revertible on request.

## Verdict
The whole app was re-exercised in the **production Docker Compose container**: 20/20 governance +
role-binding matrix, 75+ real agent runs, operator correctness, skill-leak (+ a newly-found
subagent-task leak fixed and re-verified live), MCP wiring, tool isolation, and **Claude↔Codex
parity now shown with Codex actually executing**. One real defect found and fixed; two test
assumptions corrected against FR4 / stage-eligibility. PR #36 remains implementation-ready.
