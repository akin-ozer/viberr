# Viberr — Current Code-Map & RBAC Guard-Map (main @ 8041134, 2026-07-17)

Code-grounded map of `main` **after PRs #32 (pass-7 implementation) and #34 (agent-loop
hardening)**. Verified by reading the current source, not older docs. The two prior discovery
docs (`discovery-2026-07-16/architecture.md`, `discovery-2026-07-16-pass7/*`) were written
**before PR #32 merged**, so their headline claims — most importantly "D2 org-admin override
definitively NOT implemented" and the 12 open RBAC seams — are now STALE. This doc supersedes
them where they conflict. Citations are `file:line` at this HEAD.

---

## 1. Boot sequence — `app/server/boot.server.ts` (`bootServer()`, :71)

HMR-safe via `Symbol.for("viberr.booted")` (:24,72). Ordered steps:

1. `getEnv()` — zod-validated env, fail-fast (:75).
2. `ensureDataRootDirs()` — creates `DATA_ROOT_SUBDIRS` (:76). `runtimes/codex-home` **is now
   in the list** (file-store-root.server.ts — the old asymmetry is fixed).
3. `seedDefaultAgentAssets()` — ships built-in agent definitions/skills/profile templates into
   the store when missing; idempotent, never clobbers edits (:81).
4. `getDb()` — opens SQLite, auto-applies pending migrations (:82). Migrations are now a single
   squashed `db/migrations/0001_baseline.sql`.
5. `seedInitialAdmin()` — seeds admin when `users` empty (:84).
6. `startEventPublisher()` — projection emitter → SSE broker, wired first (:91).
7. `rescanProjections(db)` — hash-short-circuit boot reconcile of offline file drift; failures
   never block boot (:98).
8. `ensureBaseAgentsDeployed(db)` — operator ensured on every project; Developer/Reviewer added
   only where the roster was never deliberately edited (:115).
9. `startFileWatcher()` — chokidar on `${dataRoot}/projects` (:124).
10. **`finalizeOrphanedRuns(db)` (:134 → run-recovery.server.ts:43)** — replaces the old
    `registerSeededLiveFromData`. Any run left `running`/`queued` has no live process on a fresh
    boot: REAL orphans (`simulated=0`) → `error` (interrupted-by-restart) **and the operator is
    re-invoked** (`runOperator … trigger:"manual"`, run-recovery:148) per affected task; SEED
    runs (`simulated=1`) → `finished`, **no** re-invoke. **FIRES OPERATOR RUNS ON BOOT.**
    Crash-loop backstop (F7-BOOT1): `RECOVERY_REINVOKE_CAP = 3` re-invokes per task within a
    30-min window (run-recovery:19-20), counted off `run.recovery.reinvoked` audit rows; over
    the cap the orphan is still finalized but the re-invoke is skipped (:118-127).
11. `recoverUnreactedAgentRuns(db)` — fire-and-forget (:146 → run-recovery:191). For each real
    `finished` primary/reviewer run whose task is still `waiting=agent` with no
    `task.agent.replied` audit row, replays `applyAgentCompletionEffects` (post reply → workspace
    reconcile → reviewer verdict → operator react). Idempotent; **also re-invokes the operator.**
12. `logBootIntegrity(db)` (:152).

---

## 2. Route inventory — `app/routes.ts` (unchanged vs pass-6; verified accurate)

All mutations are CSRF-checked POST intents (`_csrf`); toast copy computed server-side.

| Route | File | Loader / Action responsibility |
|---|---|---|
| `/` | `_index.tsx` | Home multi-project cards + pins; action = create-project, pins, rescan. |
| `/login` | `login.tsx` | better-auth sign-in (providers + local creds, forced pw-reset); rate-limited. |
| `/logout` | `logout.tsx` | POST; revoke session, audit `auth.logout`. |
| `/api/auth/*` | `api.auth.$.ts` | Splat → better-auth handler (OAuth callbacks, getSession). No app CSRF. |
| `/org/users` | `org.users.tsx` | Redirect → `/org/settings?tab=users`. |
| `/org/settings` | `org.settings.tsx` | Org-admin surface. Loader = all org slices; actions = every org mutation. **Gated org-only via `requireRole("admin")`/`requireRoleAuth` (:69,:102).** |
| `/profile` | `profile.tsx` | Identity, notification routing prefs, appearance, password change. |
| `/notifications` | `notifications.tsx` | "Waiting on you" + day-grouped stream. |
| `/notifications/read` | `notifications.read.tsx` | POST fetcher; `read`/`read-all`; emits `notification.read` SSE. |
| `/prefs/theme` | `prefs.theme.tsx` | Persist `users.theme` + cookie. |
| `/resources/events` | `resources.events.ts` | SSE stream; `?scope=` filters; Last-Event-ID replay. Org admins may subscribe any scope. |
| `/resources/run-log` | `resources.run-log.ts` | Run-log tail since `?since=<seq>`. Any signed-in user. |
| `/resources/health` | `resources.health.ts` | Unauthenticated probe `{ ok, projections, watcher, backends:{claude,codex:"real"\|"unavailable"} }` (env-presence only). |
| `/resources/model-catalog` | `resources.model-catalog.ts` | Per-backend model+effort catalog for the agent modal. |
| `/resources/session-export` | `resources.session-export.ts` | Self-contained bash installer carrying a run's provider transcript for local resume. |
| `/projects` | `projects.tsx` | Redirect → `/`. |
| `/projects/:slug` | `project.tsx` | Workspace shell layout; loader = project + live rail counts. Route gate = `requireProjectMember` (any-member; org-admin override passes). |
| `…/` (index) | `project._index.tsx` | Redirect → `board`. |
| `…/board` | `project.board.tsx` | Board columns; actions `create-task`, reorder (board_rank), **`rescan` now gated by the canonical `rescan-project` action (:80)** — the old hardcoded `["admin","maintainer"]` seam is CLOSED. |
| `…/review` | `project.review.tsx` | Read-only workflow-resolved review queue. |
| `…/agents` | `project.agents.tsx` | Agent roster + deployments; profile CRUD (`manage-agents`). |
| `…/policy` | `project.policy.tsx` | Members+roles, workflow boundaries, RBAC table; actions `set-role`, `set-boundary`. |
| `…/github` | `project.github.tsx` | Repo panel + PR/branch rows; `reconcile`→reconcile-github, `grant-scope`→grant-github-scope (:52-83). |
| `…/activity` | `project.activity.tsx` | Cross-task activity stream + audit log panel. |
| `…/settings` | `project.settings.tsx` | Identity, stage editor, membership CRUD, repo override, danger-zone delete/archive. |
| `…/tasks/:key` | `project.task.tsx` | Full task workspace. Loader = task + bounded timeline + runs + recs. Intents: comment (+@mention resume), resolve-packet, owner take/assign/release, transition, run-interrupt, assign/run specialist+reviewer, remove-reviewer, goal update, recommendation apply/dismiss, merge, **run-operator (`run-agents`, :428)**. |

---

## 3. RBAC model (CURRENT)

Three INDEPENDENT authorization surfaces (do not conflate):

### 3a. Roles & ranks
- **Org roles**: `admin | member` (`users.role`; better-auth `member.role` in default org
  `org_viberr` is authoritative, `users.role` is derived cache — `resolveOrgRole`,
  identity.server.ts). Gated by `requireRole` on `/org/*` only.
- **Project roles**: `viewer ⊂ contributor ⊂ maintainer ⊂ admin`, strict monotonic
  `ROLE_RANK = {viewer:0, contributor:1, maintainer:2, admin:3}` (rbac.ts:27). Legacy
  `reviewer` coerces → `contributor` at parse. **The second (1-4) rank scale that pass-7
  flagged as seam #2 is GONE** — no rank map remains in `agents-query.server.ts`.
- **Agent capability grants**: `direct | recommend | human | off` — separate surface (§5).

### 3b. `ACTION_ROLES` single-source matrix — `app/shared/rbac.ts:76` (verbatim, current)

| RbacAction | admin | maintainer | contributor | viewer |
|---|:-:|:-:|:-:|:-:|
| `view` | ✓ | ✓ | ✓ | ✓ |
| `comment` | ✓ | ✓ | ✓ | ✓ |
| `create-task` | ✓ | ✓ | ✓ | — |
| `own-task` | ✓ | ✓ | ✓ | — |
| `reconcile-github` | ✓ | ✓ | ✓ | — |
| `approve-transition` | ✓ | ✓ | — | — |
| `resolve-packet` | ✓ | ✓ | — | — |
| `accept-completion` | ✓ | ✓ | — | — |
| `run-agents` | ✓ | ✓ | — | — |
| `reorder-board` | ✓ | ✓ | — | — |
| `update-goal` | ✓ | ✓ | — | — |
| `grant-github-scope` | ✓ | ✓ | — | — |
| **`rescan-project`** (NEW) | ✓ | ✓ | — | — |
| `release-any-ownership` | ✓ | — | — | — |
| `manage-members` | ✓ | — | — | — |
| `manage-agents` | ✓ | — | — | — |
| `edit-policy` | ✓ | — | — | — |

- `view`/`comment` are app-wide (FR4): any authenticated user, enforced as "authenticated" not
  "member" — in the map only for Policy-table rendering (rbac.ts:18-22). `RBAC_TABLE` (:115) is
  derived from `ACTION_ROLES` so display can't drift. Helpers: `roleCan` (:100), `rolesForAction`
  (:106). `edit-settings` is folded into `edit-policy` (:64).

### 3c. The consolidated guard path (R7-1) — `app/server/auth/project-authority.server.ts`
**R7-1 DID collapse the seams into one resolution path.** Everything funnels through:
- `resolveProjectAuthority(db, project, actor, allowed, audit)` (:114) — non-throwing core; the
  single place membership role is checked against `ACTION_ROLES` **and** the D2 override applied.
- `requireProjectAuthority` (:160) — throwing wrapper with task-guard 403 copy.
- `assertProjectAction` (:185) — slug-only callers (config surfaces, route gates); reads
  project.md fresh, applies the archived gate, resolves authority.
- `requireProjectMutable` (:77) — the SINGLE archived read-only 409 gate (409 message defined
  once here; the old duplicated implementations/strings are gone).

`requireAction` (task-actions.server.ts:314) = `requireProjectMutable` + `requireProjectAuthority`.
`requireAnyMember` (:293) wraps it with `"any-member"`. **All 10 non-test importers** of
project-authority: `task-actions`, `run-service`, `specialist-run` (runtime), `agent-profile-actions`,
`policy-actions`, `settings-actions` (config), `project.board/.github/.settings/.task` (routes).
The `run-agents` inline re-checks that pass-7 called "re-implemented in 5+ places"
(`hasRuntimeRole` task-actions:1110, `requireRuntimeRole` specialist-run:1570, interruptRun
run-service:585, run-operator project.task:428) now ALL call `resolveProjectAuthority`/
`requireProjectAuthority` with `rolesForAction("run-agents")`. **Seams #1, #2, #3 CLOSED.**

### 3d. D2 org-admin emergency override — **IMPLEMENTED** (reverses the pre-#32 doc)
- `isOrgAdmin(db, userId)` (:94): org-admin role, disabled users excluded.
- In `resolveProjectAuthority` (:122-152): a member whose role satisfies `allowed` is granted
  under their OWN role (`isOrgAdminOverride:false`, no audit). Otherwise an org admin (non-member
  OR member below tier) is granted **project-admin-equivalent** authority
  (`role:"admin", isOrgAdminOverride:true`).
- **Audited**: every override on a governed MUTATION writes a `project.org_admin.override` audit
  row naming the action + project (:135-149). **NOT audited** for `audit.action === "any-member"`
  — i.e. route READ gates (Policy/Settings/Agents/GitHub loaders) + idempotent no-ops — to avoid
  a row per page load (:129-135).
- **Surfaces that honor it**: all mutation guards (`requireAction`→`requireProjectAuthority`),
  all config surfaces (`assertProjectAction`), route membership gate
  (`requireProjectMember`→`assertProjectAction "any-member"`, require-project.server.ts:30), and
  every `run-agents` inline check. The shell shows an **"org-admin override" pill**
  (topbar.tsx:126-128). So the old read-vs-act asymmetry (org-admin sees but can't act) is
  RESOLVED — an org-admin can now act on non-member projects, audited.
- **Where the override does NOT reach**: the task-owner exception path is membership-based
  (`ownerException`), but that only ever *widens* authority; an org-admin already passes via the
  override. Operator/agent capability grants (§5) are a different surface entirely — no org-role
  bearing.

---

## 4. Task lifecycle & transitions — `task-actions.server.ts`

- **Stages/workflow**: stages + workflow edges come from project.md; boundary types
  `auto | approval | human` (project-file schema). Review→Done is hard-locked `human` in V1.
- **`transitionStage` (:2267)** dispatch by actor/boundary:
  - Operator-authorized (`ctx.operatorAuthorized`): skips human RBAC (gated upstream by capability
    policy); **cannot reach the last stage via a bare transition** — forbidden (:2355), operator
    reaches Done only through `operatorAcceptCompletion`.
  - `manual:true` (board/task dropdown, forward/backward/off-graph): `approve-transition` (:2363).
  - `auto` boundary crossed by a human: `requireAnyMember` (:2367) — unreachable from UI (always
    sends manual).
  - `approval` boundary: `approve-transition` (:2369).
  - `human` boundary (review→Done): `requireAcceptCompletion` with owner exception (:2373).
  - A HUMAN manual move INTO the last stage is re-routed through `acceptCompletion` (:2341) — full
    acceptance contract (real merge attempt, `completion` event), never a bare transition.
- **Operator backward rework (R7-4)**: `isReworkMove` = `rework:true` + `operatorAuthorized` +
  target index < from index + `validation === "failing"` (:2316). Off-graph but operator-scoped
  and rework-gated so it can't be abused for a forward jump or on a healthy task.
- **Review entry side-effects** (:2431-2493): validation reset to `changed` (but a standing
  `failing` is NOT laundered unless `hasReworkSinceLastRejection` — adversarial #9);
  `openReviewPrBestEffort` (:2509) → `pushWorkspaceBranch` (PAT/askpass push of the workspace's
  local commits) → `openTaskPr`; empty diff → timeline event + supervisor notification. Non-Done
  transition by a non-operator fires `autoInvokeOperator` (:2481).
- **Acceptance / owner exception (R6-2)**: `requireAcceptCompletion` (:362) allows the maintainer+
  tier OR the task's human OWNER holding live `own-task` (contributor+) via `ownerException`
  (:338). 4 sites: transition human boundary (:2373), resolvePacket accept option (:2796),
  `acceptCompletion` (:3086), `completeTaskMerge` (:3209). Acceptance REFUSES a standing `failing`
  validation (:2806, and in acceptCompletion/operator paths) — a stale packet can't merge rejected
  work. `mergeTaskPrIfPossible` attempts the REAL merge and only records "merged" when it truly
  happened, else "accepted (merge pending)".

---

## 5. Runtime / agent execution — `app/server/runtimes/*`, `tasks/*`

### 5a. Backend availability & the R7-2 no-simulation rule — `runtime-registry.server.ts`
- `hasCredential` (:115), env-presence only: claude = `ANTHROPIC_API_KEY | CLAUDE_CODE_OAUTH_TOKEN
  | VIBERR_CLAUDE_USE_CLI_AUTH`; codex = `CODEX_ACCESS_TOKEN | CODEX_API_KEY | OPENAI_API_KEY`, OR
  `VIBERR_CODEX_USE_CLI_AUTH` **AND** `$CODEX_HOME/auth.json` exists (`codexCliAuthUsable`:79 —
  F-DOCKER1 fix; stricter than the pre-#28 presence-only check).
- `selectAdapter` (:322): available → `{kind:"real"}`; else simulated ONLY inside the R7-2 gate
  `simulatedRuntimePermitted` (:101) = `NODE_ENV==="test"` OR (`VIBERR_FORCE_SIMULATED_RUNTIME` AND
  `VIBERR_TEST_RUNTIME_OK`) — **fail-closed, no effect in dev/prod**; else `{kind:"unavailable"}`.
- **Unavailable ⇒ `failRunUnavailable`** (run-service.server.ts:370): writes a terminal `err` log
  line + `error` state, NO backend process, no fake stream. `backendUnavailableMessage` (:391)
  names the missing credential. This is the R7-2 "don't simulate at all" behavior.
- The e2e/simulated engine is reachable exclusively through the R7-2 gate (Playwright golden
  paths). `VIBERR_FORCE_SIMULATED_RUNTIME` alone is inert outside the gate.

### 5b. How a specialist run starts — `specialist-run.server.ts:startSpecialistRun` (:487)
- **Single-flight guard (F7-OP1, :525-536)**: refuses a second PRIMARY run (409) while one is
  `running`/`queued` — two operator turns racing no longer spawn two agents fighting one workspace
  git index. (Operator lease covers operator runs only; this covers specialist dispatch.)
- Resolves the CURRENT deployment (not the assign-time snapshot) so a profile backend switch takes
  effect on the next run; backend precedence = D4 `backendOverride` → live deployment → snapshot
  (:549). Then `startRun` → `selectAdapter`. Confinement (denylist/env/MCP/persona) applied.
- Reviewer runs: `startReviewerRun` (:787), analogous.

### 5c. How operator runs start — `operator-run.server.ts:runOperator` (:278)
- **Single-flight lease per task** (NFR16): process-level lease `leaseKeyFor` (:297) + DB-row
  backstop `inFlightOperatorRun` (:319, cross-boot). Concurrent triggers QUEUED newest-wins,
  fired on release (:301,:321). Idempotent-per-token release (:340) prevents double-fire.
- Mode selection (:379-399): claude available → `startRealOperatorRun` (real tool-driven, in-proc
  `viberr` MCP toolkit); codex available → `startCodexOperatorRun` (structured-output
  `OPERATOR_PLAN_SCHEMA` :432 → zod-revalidated → `executeCodexPlan` :591 through the SAME gated
  operator-actions); `runScriptedOperatorDrive` ONLY inside R7-2 gate; else **fail-fast** through
  the real path (honest error run, completion hook escalates a blocked packet — no fabricated
  coordination).
- Operator MCP toolkit (`operator-toolkit.server.ts`): 12 tools built only for granted
  capabilities — `get_task, post_comment, open_decision_packet, resolve_decision_packet,
  assign_specialist, run_specialist, prompt_specialist, assign_reviewer, run_reviewer,
  prompt_reviewer, transition_stage, accept_completion`. `allowedTools` confines the run to
  exactly the built set.

### 5d. Adapters
- **claude-runtime.server.ts**: SDK `query()` streaming-input mode. SDK isolation
  `settingSources:[], skills:[], plugins:[]` (:316-318). `permissionMode:"bypassPermissions"`
  when autonomous (:291). **`maxTurns` DEFAULT is now `2000`** (`DEFAULT_CLAUDE_MAX_TURNS` :185,
  env `VIBERR_CLAUDE_MAX_TURNS`) — DRIFT from the old doc's `50`. Operator persona REPLACES the
  default; specialist persona APPENDS (:336). Operator denylist = built-ins (Bash/Edit/Write/…)
  + capability denies, holds under bypassPermissions (:107-110,:350).
- **codex-runtime.server.ts**: SDK `startThread/runStreamed`, `approvalPolicy:"never"` (:390).
  Sandbox matrix (:375-380): operator → `read-only` (+ `networkAccessEnabled:false`); autonomous
  specialist → `danger-full-access`; else `workspace-write`. Idle timeout 15 min
  (`VIBERR_CODEX_IDLE_TIMEOUT_MS` :171). stderr redaction retained (only classified in-memory).
- **simulated-runtime.server.ts**: scripted `LogLine` engine — reachable only via the R7-2 gate.

### 5e. Capability enforcement — `capabilities.ts`, `specialist-tool-policy.ts`
- `ALWAYS_HUMAN_CAPABILITY_IDS` (:72): `merge-pull-request, transition-to-done,
  change-project-policy` — coerced to `human` at grant-persist.
- `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` (:128): `create-task-branch, commit-push-branch,
  open-review-pr, execute-code-or-write-repo` — bind via Claude `disallowedTools` only; ADVISORY
  on codex (no tool deny-list). **NOTE: `merge-pull-request` was deliberately moved OUT of
  claude-only and classified `"both"`** (comment :56-58) — it's enforced server-side (PAT merge
  path), not by an agent tool, so it holds on both backends.
- Operator gate `gate()` (operator-actions.server.ts:190): `direct`→act; `recommend`→card,
  promoted to `direct` under FULL autonomy EXCEPT `completion-for-acceptance` (must be explicitly
  `direct` — Q1); `human`/`off`→deny. `operatorAcceptCompletion` additionally requires
  `autonomy==="full"` AND the cap explicitly `direct` (:1338).

---

## 6. Reviewer verdict path — `task-actions.server.ts`

- **`classifyReviewerVerdict` (:1373)** → `"request_changes" | "approve" | null`. Priority:
  (1) explicit verdict line `verdict: pass/approve` vs `fail/reject/changes` wins (:1383);
  (2) strong request-changes phrases (`request changes`, `nothing implemented`, `not implemented`,
  `reject`); (3) weak negatives (`fail`, `blocker`) count ONLY when not locally negated —
  negation-aware scan (:1406-1417, the fix for "no blockers"/"tests don't fail" false rejects);
  (4) approve phrases (`approve`, `lgtm`, `ready to merge`, `no blocking issues`).
- **`recordReviewerVerdict` (:1480)**: `request_changes` → `validation=failing`. An `approve`
  clears a standing `failing` ONLY when `hasReworkSinceLastRejection` (:1458) sees a primary-
  specialist reply or a transition newer than the last failing quality event — otherwise the
  verdict is titled **"Approval noted — rework still needed"** and validation stays `failing`
  (:1521-1526, F7-REV3 honesty). This blocks same-round masking AND ends "failing forever".
- **Reaching timeline/PR**: writes a typed `quality` timeline event (`**Validation:** …`) via
  `updateTaskFile` → `reprojectTask` (:1532-1542), audits `task.quality.flagged`, and
  **`notifyTaskWatchers`** fans a `quality` notification to owner + supervisors (:1555, F7-REV1/
  REV2 — previously the quality inbox card only existed in seed data). The reviewer's actual
  branch/PR is folded back into task.md by `reconcileWorkspaceDelivery` inside
  `applyAgentCompletionEffects` before the verdict is recorded (registerAgentCompletion, :1598).

---

## 7. Key invariants & smells in the CURRENT code

1. **Boot fires costed operator runs** — `finalizeOrphanedRuns` re-invokes the operator for every
   real orphaned task on boot; now bounded by `RECOVERY_REINVOKE_CAP=3`/30-min (run-recovery:19),
   so the crash-loop amplification the pass-7 drift doc flagged is MITIGATED, not unbounded. Plus
   `recoverUnreactedAgentRuns` can also re-invoke. A cold boot with N stalled tasks kicks off up
   to N operator drives.
2. **Codex capability enforcement stays advisory** — `CLAUDE_ONLY_ENFORCED` binds via Claude
   `disallowedTools` only; a codex specialist with a withheld `commit-push-branch` can still push
   (danger-full-access + own gh auth). `merge-pull-request` is the exception (server-PAT enforced,
   "both"). Honestly labeled via `capabilityEnforcement` (:138).
3. **In-process leases/callbacks** — operator leases, run-completion callbacks, and the SSE ring
   buffer live in process-global maps. Boot recovers dropped agent replies (recoverUnreacted…) and
   orphaned runs (finalizeOrphaned…), but a restart mid-codex-plan-execution (run row already
   `finished`, plan half-applied) still has no recovery analog.
4. **Workspace isolation is Git-discovery-only** — `GIT_CEILING_DIRECTORIES` + prompt contract;
   an autonomous agent can still read/write anywhere the node user can. Codex sandbox modes add an
   OS boundary on macOS (Seatbelt) but Landlock/seccomp availability inside Docker is untested (the
   §12 sandbox concern from the older doc remains open).
5. **Codex failure opacity** — deliberate stderr redaction means codex failures classify as
   `unknown`/generic. `runFailureReason` is regex-on-log-text; the A3 classified terminal `err`
   line was added to the Claude adapter only, so codex still yields generic escalation copy.
6. **Two parallel archived gates are now ONE** — `requireProjectMutable` lives solely in
   project-authority.server.ts; the duplicate implementation + duplicated 409 string that pass-7
   flagged (seam #6) is gone.
7. **`view`/`comment` display-vs-enforcement asymmetry persists (by design)** — the Policy table
   shows them role-gated, but the comment path enforces "authenticated", not membership
   (appendComment guards only `requireProjectMutable`, task-actions:688). Documented in rbac.ts:18.
8. **Hand-maintained codex model list** — `model-catalog.server.ts` codex ids are a best-effort
   snapshot (no list endpoint); claude side is live-enhanced. Will silently go stale.
9. **Member-management action split remains** — role change → `manage-members`; invite/remove →
   `edit-policy` (settings-actions). Cosmetic inconsistency, not a hole.
10. **better-auth org tables still largely dormant** for app RBAC beyond `resolveOrgRole` reading
    `member.role` — project authority is project.md `members[]` + the org-admin override; the
    organization/invitation plugin data has no deeper consumer.

---

## Executive summary (15 lines)

1. Docs at `discovery-2026-07-16*` predate PR #32; their "D2 override NOT implemented" and "12
   open RBAC seams" claims are STALE — this doc supersedes them.
2. **D2 org-admin override IS implemented** in `app/server/auth/project-authority.server.ts`
   (`resolveProjectAuthority` :114, `isOrgAdmin` :94): a denied org-admin gets project-admin
   authority, audited as `project.org_admin.override` on every mutation (route reads not audited).
3. **R7-1 consolidation is real**: one guard path (`resolveProjectAuthority`/
   `requireProjectAuthority`/`assertProjectAction`); all 10 non-test callers + every `run-agents`
   inline re-check funnel through it. Board-rescan hardcode and the second rank scale are GONE.
4. New RBAC action `rescan-project` (maintainer+, rbac.ts:91) gates board rescan (project.board:80).
5. `ACTION_ROLES` (rbac.ts:76) unchanged otherwise; ranks viewer0<contributor1<maintainer2<admin3.
6. Archived read-only gate is now a single `requireProjectMutable` in project-authority.server.ts.
7. **R7-2 no-simulation**: unavailable backend ⇒ `failRunUnavailable` honest error run (no fake
   stream); simulated engine reachable only via the fail-closed `simulatedRuntimePermitted` test
   gate (`NODE_ENV=test` or `VIBERR_FORCE_SIMULATED_RUNTIME`+`VIBERR_TEST_RUNTIME_OK`).
8. Specialist dispatch has a single-flight guard (409 on a 2nd primary run, specialist-run:525);
   operator has a process lease + DB backstop with newest-wins trigger queue (operator-run:297).
9. Operator modes: claude→real MCP-tool run; codex→structured `OPERATOR_PLAN_SCHEMA`→`executeCodexPlan`;
   scripted only in the R7-2 gate; else fail-fast real path that escalates a blocked packet.
10. Boot (`boot.server.ts`) fires operator runs: `finalizeOrphanedRuns` (:134) re-coordinates real
    orphans (capped 3/30min) and `recoverUnreactedAgentRuns` (:146) replays dropped replies.
11. Claude `maxTurns` default is now **2000** (`VIBERR_CLAUDE_MAX_TURNS`), not 50 — a drift.
12. Codex sandbox: operator read-only(+no net) / autonomous danger-full-access / else workspace-write;
    codex CLI-auth now requires `$CODEX_HOME/auth.json` to exist (F-DOCKER1).
13. Reviewer verdict: `classifyReviewerVerdict` is negation-aware; an approve can't clear a standing
    `failing` without rework evidence → honest "Approval noted — rework still needed"; verdict now
    notifies owner+supervisors (F7-REV1/REV2).
14. `merge-pull-request` moved to `"both"`-enforced (server-PAT), not claude-only; the other 4
    `CLAUDE_ONLY_ENFORCED` caps stay advisory on codex.
15. Operator reaches Done only via `operatorAcceptCompletion` (full autonomy + explicit `direct`
    on `completion-for-acceptance`), never a bare stage transition; owner exception (R6-2) lets a
    contributor-owner accept its own task at 4 call sites.
