# Pass 4 — live test results (2026-07-12)

Environment notes:
- Dev server on Node 26. **Real Claude/Codex SDK subprocess spawning is impossible in this
  sandbox** — the Agent SDK's `spawnLocalProcess` throws `spawn EBADF` at
  claude-runtime.server.ts:267 under every launch method (preview harness, nohup, sandbox
  disabled). This is an environment constraint (closed/redirected FDs for child processes),
  not a product bug. Prior passes ran real agents from a normal terminal outside this harness.
- Consequence: the lifecycle sweep runs on the **simulated backend** (creds commented out of
  `.env` → both backends "simulated"; the deterministic engine the seed + e2e use). This
  exercises every viberr-side decision path (operator logic, assignment, transitions, packets,
  reconcile, verdict, react loop, notifications, RBAC). Runtime ISOLATION facts (disallowedTools,
  skills, mcpServers, systemPrompt) are verified by direct spec-builder inspection (below),
  which is more precise than reading an envelope.
- RBAC harness: per-user cookie jars (arda=admin, elif=maintainer, murat=contributor,
  selin=viewer, deniz=non-member), CSRF derived via session-row HMAC (`.csrf-derive.mjs`).

## Results

### Setup
- **T1 · Create selftest-5** (Standard/Balanced, repo akin-ozer/viberr) — PASS. project.md
  written with 5 stages, correct boundaries (triage→ready auto, ready→impl auto, impl→review
  approval, review→done human+locked), base agents auto-deployed (operator/developer/reviewer)
  with the Balanced capability policy (operator: assign/summon/packets/events direct,
  stage-transitions + completion-for-acceptance recommend, execute/transition-to-done/policy
  human). Members seeded with arda=admin. Roles then set elif=maintainer, murat=contributor,
  selin=viewer via invite + set-role.

### Lifecycle (simulated backend)
- **T5 · Underspecified triage goal** — PASS. VS-1 "make it better" created in triage →
  readiness=`input_required`, waiting=human (triage quality gate flagged it). No operator
  auto-run for an in-triage task (correct).
- **T6 · Operator auto-invoke + supervised policy** — PASS. VS-2 created in `ready` →
  operator auto-invoked → **directly** deployed Developer (assign-primary-specialist: direct),
  auto-advanced ready→impl (auto boundary on specialist assignment), ran the Codex specialist
  (simulated), specialist replied "@operator done…", operator reacted and posted a
  **Recommendation: Move to Review** (stage-transitions: recommend + impl→review approval
  boundary) — never self-transitioned. Exactly per policy.
- **T23 · Apply/deny recommendation RBAC** — PASS. Transition rec applied by murat
  (contributor) → 403 (needs approve-transition = maintainer+); by elif (maintainer) → 200 →
  moved to Review, validation reset to `changed` (entering review), operator auto-engaged +
  ran the Reviewer.
- **T15 · Reviewer verdict** — PASS. Reviewer (simulated) → verdict classified **healthy** →
  typed `quality` event "Review passed" → validation=healthy.
- **T16 · Operator react loop** — PASS. Every agent reply re-invoked the operator, which
  advanced the task by one governed step each turn and ended waiting=human (recommendation),
  never looping or duplicating. Supervised operator recommended acceptance
  (completion-for-acceptance: recommend), never self-accepted.
- **T9/T25 · Human acceptance → Done** — PASS. accept_completion rec: selin (viewer) 403,
  murat (contributor) 403, elif (maintainer) 200 → stage=done, honest completion event
  "Human acceptance recorded. VS-2 transitioned to Done (no linked pull request)." No fake
  merge claim (NFR15). waiting=none.

### RBAC battery (curl)
- **T27 · Members-only vs app-wide** — PASS. deniz (non-member): board 200, task detail 200
  (FR4 app-wide reads); review/agents/policy/github/activity/settings all 403.
- **T28 · set-role RBAC + last-admin guard** — PASS. selin (viewer) set-role 403; elif
  (maintainer) set-role 403 (admin-only manage-members); arda demote-self-as-sole-admin → 409
  (last-admin guard). arda set elif→maintainer, murat→contributor: 200.
- **T11 · Ownership tiering (Q5)** — PASS. selin (viewer) owner-take 403; murat (contributor)
  take 200 + release-own 200; elif (maintainer) release-someone-else 403 (release-any=admin);
  arda (admin) force-release 200.

### Stage eligibility, transitions, comments, reviewers (simulated + curl)
- **T3/T4 · Custom agent profiles** — PASS. Created "Docs Writer" (Claude, stages=[impl],
  skill=conventional-commits) and "Test Engineer" (Codex, stages=[review]) via the product
  create-profile action → both written to project.md as `docs-writer`/`test-engineer`
  deployments with the modal capability defaults.
- **T12 · Stage eligibility (R2/F1)** — PASS at BOTH boundaries (trap #15). Docs Writer
  (impl-only) assigned to VS-5 (ready) → 400 reject; to VS-3 (impl) → 200. Test Engineer
  (review-only) as reviewer on VS-3 (impl) → 400 reject. Then VS-3 run Docs Writer in impl →
  200; transition VS-3 impl→review; run Docs Writer again (now review) → 400 reject at the
  RUN boundary. Both assign and run gates enforce.
- **T7 · Manual transition RBAC** — PASS. VS-5 ready→impl: selin (viewer) 403, murat
  (contributor) 403, elif (maintainer) 200.
- **T10 · Human→Done routes through acceptance (trap #14)** — PASS. elif manual transition
  VS-5 impl→done produced a `completion` event "Human acceptance recorded … (no linked pull
  request)", not a bare stage write; operator can never bare-transition to Done.
- **T17 · Comment @mention routing** — PASS. selin (viewer) plain comment 200 (app-wide);
  murat (contributor) @operator → comment recorded, run NOT triggered (runtimeDenied); elif
  (maintainer) @operator → operator run triggered and drove the board. (Note: the SIMULATED
  operator is a deterministic board-advancer and does not re-apply the triage quality gate —
  it advanced VS-1's underspecified goal; a real operator would flag it. Not a product bug,
  a property of the sim engine.)
- **T13 · Reviewers idempotent + remove** — PASS. VS-11: assign Reviewer 200, re-assign 200
  (idempotent), add Test Engineer as 2nd reviewer (review-eligible) 200, remove Reviewer 200
  → left with test-engineer.
- **T31 · Board reorder RBAC** — PASS. selin 403, murat 403, elif 200.
- **Goal-edit RBAC** — PASS. selin 403, murat 403 (update-goal = maintainer+), elif 200.
- **C2 · Acceptance refused while validation failing** — PASS. VS-16 with validation=failing
  → transition-to-done returns 409, task stays in Review (anti-laundering invariant holds).
- **WI-1 (HIGH) CONFIRMED LIVE · Review-queue stage-role drift.** Created Lightweight
  "lite-probe" (todo/doing/done). LP-1 placed in `doing`. Rail badge uses
  `resolveStageRoles().reviewId` = `doing` → counts LP-1 (Review=1), but
  `review-queue.server.ts:47` filters the literal `stage === "review"` → 0. Rail says 1,
  `/review` is empty. Exactly as the code sweep found.

### Real-container run (Docker Compose, backends actually real)
The user asked to verify on the real thing. Built the production image and ran `docker compose
up` (NODE_ENV=production, data root ./docker-data, Claude via OAuth token, Codex via mounted
~/.codex). Health: backends "real". Inside a container the Agent SDK has a real process env, so
`spawn EBADF` does NOT occur — real runs are possible here. This immediately surfaced F-MIG1.

- **F-MIG1 (CRITICAL, NEW) · `archived` column added to an already-shipped migration → total
  app breakage on any pre-existing DB.** `db/migrations/0003_projections.sql:15` declares
  `archived INTEGER NOT NULL DEFAULT 0`, but that column was ADDED to 0003 in commit `1daaf9f`
  ("Make RBAC real … add archive") AFTER 0003 had already shipped in `723741d`. There is NO
  `ALTER TABLE projects ADD COLUMN archived` migration. Because 0003 is already recorded in
  `schema_migrations`, the edit never re-runs on any database created before `1daaf9f`. The
  container's `docker-data` DB is exactly that case: its `projects` table has no `archived`
  column, so `rebuildProjectFile` throws `table projects has no column named archived` for
  EVERY project. Effect on the real deploy: projection rebuild fails, `projects: 0`, home shows
  no projects, and every `/projects/:slug/*` route 404s — the app is unusable. `seed --reset`
  does NOT fix it (it wipes rows and runs migrations, but the already-applied 0003 is skipped, so
  the table schema stays old). The fresh dev `data/` store was created after the edit so it HAS
  the column — which is why the sandbox never showed this. This is the highest-severity finding
  of the pass and is invisible without a real/upgraded database. → implementation: a proper
  additive migration (or, aligned with the "projections are rebuildable" architecture, a
  schema-version guard that drops+rebuilds the projection DB when the projections schema changes).

### Real agent runs verified in the container
- **Real Claude operator spawns & executes** — PASS. VLS-1 (viberr-live-six): real Claude
  operator (claude-sonnet-5) ran, wrote a genuine "Observed / Plan" comment, deployed +
  prompted the Developer with a well-formed instruction. No EBADF (real process env).
- **disallowedTools enforcement is real** — PASS. The operator's init envelope tools(37) list
  contains the viberr MCP tools but NONE of Bash/Edit/Write/MultiEdit/NotebookEdit/Task —
  confirmed empty. `permissionMode: bypassPermissions`, `mcp_servers: [{viberr, connected}]`
  with exactly the 11 operator tools. cwd = the task dir.
- **F8/D4 failure path is real** — PASS. The operator's Codex specialist run hit the real
  quota limit → typed `blocked` event "Codex is over its usage quota. …Retry on the other
  backend", operator opened a "Work stalled — pick a recovery path" recovery packet,
  waiting→human. Exactly the designed degraded path, on real infra.
- **Single-flight operator lease is real** — PASS. Container log: "operator run queued — one
  already in flight (process lease)" when a second trigger arrived (coalesced, not dropped).
- **F-ISO1 (MED, NEW) · Account-managed skills/agents leak into real runs even in a clean
  container.** The app sets `settingSources:[], skills:[], plugins:[]`
  (claude-runtime.server.ts:217-219) and prior passes dismissed leaked tools as "dev-only
  parent-session inheritance" (trap #8). But in a Docker container with NO parent Claude
  session — authenticated only by `CLAUDE_CODE_OAUTH_TOKEN` — the operator's init envelope
  still shows `skills: [deep-research, design-sync, dataviz, update-config, verify, debug,
  code-review, simplify, batch, fewer-permission-prompts, doctor, loop, schedule, claude-api,
  run, run-skill-generator]` and `agents: [claude, Explore, general-purpose, Plan,
  statusline-setup]` — Anthropic ACCOUNT-managed skills/subagents, none declared by viberr.
  `plugins: []` held. So the "inject ONLY declared skills" isolation claim is incomplete: the
  SDK's `skills:[]` does not suppress account-tier skills under OAuth-token auth. Directly
  answers the owner's "check skills are correctly loaded (not unrelated skills)" ask — unrelated
  account skills ARE loaded. Extra harness tools (CronCreate/Workflow/WebFetch/Skill/ToolSearch
  etc.) also appear. Needs investigation in implementation: is there an SDK option (or an
  env/allowlist) to fully close account-tier skills, or is this an accepted boundary to
  document honestly like S3? (Not a security ask; a correctness/honesty one.)

### Real PR flow on akin-ozer/viberr (host gh)
- Created 3 marker PRs following viberr conventions (branch `vls-N-<slug>`, `[VLS-N]` commit,
  PR body links to the task): **#17 merged (squash), #18 closed (reject), #19 left open**.
  All three outcomes are live on the repo. Tiny marker files under test-support/livesix/ only.
- **In-app reflection of these PR states is BLOCKED on a stored GitHub PAT** (honest slate = no
  PAT; `findPrForBranch`/reconcile need GitHub read auth; the container's agent clone also
  failed with "could not read Username" — no ambient git auth in the container). The GitHub
  reconcile/link/merge logic is covered by the fake-github unit transport; the live degraded
  "No credential configured" card is itself the correct seeded behavior. Attaching a PAT via
  org settings → GitHub connections would enable live reflection (owner action — tokens are not
  something I enter).

### Findings surfaced live
- **F-OP1 (HIGH, NEW) · Failed real Claude operator run is silent.** When the real Claude
  operator run errored (EBADF crash here, but any error — quota/auth/mid-run — is the same
  path), viberr recorded NOTHING: empty timeline, zero notifications, task left waiting=human
  with no explanation. The Codex operator has a no-plan escalation packet
  (operator-run.server.ts:472-497) and specialists have the F8 blocked path
  (task-actions.server.ts:1554-1608), but the real Claude operator's ONLY completion hook is
  `chainRunCompletion(runId, () => releaseOperatorLease(...))` (operator-run.server.ts:674) —
  no error escalation. A human never learns their operator run died. → add to implementation.
